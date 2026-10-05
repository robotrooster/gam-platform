/**
 * S655 — ONE WAY A HOUSEHOLD IS INVITED TO A NEW LEASE.
 *
 * Every door that puts people onto a unit for a lease they will SIGN comes
 * through inviteHouseholdToNewLease:
 *
 *   - Tenant Onboarding → "Invite to sign a new lease" (POST /landlords/me/onboard-new-lease-tenant)
 *   - Tenants → "Invite Tenant" for a unit (POST /tenants/invite)
 *   - the tenant CSV's draft roster, when the landlord confirms a property
 *   - a paper or PDF import for someone who already has a GAM account with
 *     another company (Nic, 10/2: "imports are NEVER blocked" — the import
 *     becomes a lease sent to them to sign)
 *
 * The S647 shape, the same at every door: the people get an account and an
 * invite row bound to the unit; the household's lease drafts at once from the
 * landlord's own setup (the unit's rent, its unit type's default lease and
 * packet); the draft waits in Front Desk → "Waiting on you to sign" with nobody
 * emailed; the landlord's signature issues it and each person gets ONE email
 * (the relay in routes/esign.ts, through services/tenantLeaseLink).
 *
 * The whole household is invited in one call, so a household of three drafts
 * one lease once — not three drafts, two of them voided seconds later.
 *
 * NOBODY IS ATTACHED TO A COMPANY WITHOUT THEIR OWN SIGNATURE (Nic, 10/2). A
 * person who already has a GAM account with another company is still invited —
 * nothing is ever refused for it — but the landlord's signature does not make
 * them this company's tenant. Their own signature does: see
 * tenantsNeedingOwnSignature, which the e-sign issuance step asks.
 *
 * This file also holds the tenant CSV's DRAFT ROSTER (tenant_roster_drafts):
 * the file fills a roster, nothing is emailed and no account is made; the
 * landlord reviews it per property and confirms, and confirming invites each
 * household through the same function above.
 */
import type { PoolClient } from 'pg'
import { randomBytes } from 'crypto'
import { parse as parseCsv } from 'csv-parse/sync'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import type { AuthPayload } from '../middleware/auth'
import { landlordScopeIds } from '../lib/landlordScope'
import { logger } from '../lib/logger'
import { portalLink } from '../lib/portalUrls'
import { todayIn } from '../lib/timezone'
import { applyMapping, type CsvImportPlatform } from '../lib/csvImportMappings'
import { ROSTER_MAX_HOUSEHOLD } from '@gam/shared'
import { assertLateFeeDecisionForUnit } from './lateFeePolicy'
import { assertUnitCanAcceptNewLease, reasonSentence, tooManyForOneLease } from './leaseOnboarding'
import { applyScreeningWaive, isExistingTenancyInvite, getOnboardingWindow } from './onboardingWindow'
import { allocateInvoiceNumber } from './invoiceNumbers'
import { emailTenantOnboarded, emailTenantInvite } from './email'
import { createNotification } from './notifications'
import { replyToProperty } from './replyRouting'
import { resolveDefaultTemplateForUnit } from './templateResolve'
import { NOT_A_RESIDENT_ACCOUNT, accountTiedElsewhere } from '../jobs/leaseParser/resolveIntent'

const PLACEHOLDER_PASSWORD = '$2b$10$placeholder_invite_pending'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Who a resident is ───────────────────────────────────────────────────────

/**
 * S654: the one account on this address, in any letter case, for the resident
 * doors. An exact match missed a mixed-case account and made a second login on
 * the same address. A login that isn't a resident's (landlord, staff, admin,
 * e-sign contact) is refused, not reused.
 */
export async function findResidentAccount(emailNorm: string): Promise<{ id: string; email: string; tenant_id: string | null } | null> {
  const found = await query<{ id: string; email: string; role: string; tenant_id: string | null }>(
    `SELECT u.id, u.email, u.role, t.id AS tenant_id
       FROM users u
       LEFT JOIN tenants t ON t.user_id = u.id
      WHERE LOWER(u.email) = $1
      ORDER BY (u.email = LOWER(u.email)) DESC, u.created_at, t.created_at`,
    [emailNorm])
  if (found.some(f => f.role !== 'tenant')) throw new AppError(409, NOT_A_RESIDENT_ACCOUNT)
  return found[0] ? { id: found[0].id, email: found[0].email, tenant_id: found[0].tenant_id } : null
}

/**
 * S652 (Nic): "they let their due date be whenever they come in." The day this
 * household's rent is due, stated on the invite. Absent or blank = follow the
 * property's rule; anything else must be a real day a lease can carry (1–28).
 */
export function inviteRentDueDay(body: any): number | null {
  const v = body?.rentDueDay
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 28) {
    throw new AppError(400, 'The rent due day has to be between the 1st and the 28th.')
  }
  return n
}

/** The packet as the landlord left it ticked: template ids only. */
export function packetIds(v: any): string[] | null {
  return Array.isArray(v) ? v.filter((t: any) => typeof t === 'string' && UUID_RE.test(t)) : null
}

// ── The invite ──────────────────────────────────────────────────────────────

export interface InvitePerson { firstName: string; lastName: string; email: string; phone?: string | null }

export interface InviteHouseholdOpts {
  unitId: string
  people: InvitePerson[]
  /** Throws when the caller may not invite into the company that owns this unit. */
  authorize: (unitLandlordId: string) => void
  /** Every company of the caller's account — "own" for the tied-elsewhere test. */
  ownCompanies: string[]
  byUserId: string
  /** The landlord attests these people already live there (onboarding). */
  existingResident: boolean
  /**
   * S652: the landlord attests these people lived at this property before —
   * no background check, recorded against the property's yearly allowance.
   */
  returningResident?: boolean
  /** The Tenants-page invite lets a last name be left blank. */
  requireLastName?: boolean
  rentDueDay?: number | null
  homeSale?: Record<string, unknown> | null
  packageTemplateIds?: string[] | null
  source: 'invite' | 'roster' | 'import'
  /**
   * Refuse a unit with no rent or no late-fee decision. The onboarding doors
   * always do; the Tenants-page invite never has (a person invited there may
   * still be screening when the landlord sets the unit up).
   */
  requireUnitSetup?: boolean
  /** Which email the fallback invite uses when no lease could be drafted. */
  fallbackEmail?: 'onboarded' | 'invite'
  /**
   * A paper or PDF import's own invite row (the one person in `people`). It is
   * put on this unit INSIDE the invite's transaction — or closed, when it
   * repeats the person's live invite to the unit or was made for somebody
   * else — so an invite that fails (the unit is full, no rent) leaves it
   * exactly as it was. Bound first and checked after, a failed build left a
   * unit-bound invite that the hourly sweep then drafted on its own.
   */
  rebindIntentId?: string | null
}

export interface InvitedPerson {
  userId: string; tenantId: string; intentId: string; email: string
  firstName: string; lastName: string
  /** Had a GAM login already (or another company's account): no setup link from us. */
  alreadyOnPlatform: boolean
  /** This call made the account. */
  createdHere: boolean
  screeningWaived: boolean
  /** Another company's resident — the lease starts on their own signature. */
  needsOwnSignature: boolean
  /** What reached them from this invite: nothing (the S647 norm), an email, or an in-app notice. */
  notified: 'email' | 'notice' | null
}

export interface InviteHouseholdResult {
  landlordId: string; propertyId: string; unitId: string; unitNumber: string
  people: InvitedPerson[]
  draftedDocumentIds: string[]
  /** Why no lease drafted, in plain words, for the screen. Empty when one did. */
  draftBlocked: string[]
  /** True when the people were told by email or notice that they were invited (drafting failed). */
  fallbackSent: boolean
}

function cleanPerson(p: InvitePerson, i: number, requireLastName = true): Required<InvitePerson> {
  const firstName = String(p?.firstName ?? '').trim()
  const lastName = String(p?.lastName ?? '').trim()
  const email = String(p?.email ?? '').trim().toLowerCase()
  // S629: an empty string is not a phone number.
  const phone = String(p?.phone ?? '').trim()
  const who = i === 0 ? 'The first person' : `Person ${i + 1}`
  if (!firstName || (requireLastName && !lastName) || !email) {
    throw new AppError(400, `${who} needs a first name, ${requireLastName ? 'last name ' : ''}and email.`)
  }
  if (!EMAIL_RE.test(email)) throw new AppError(400, `${who}'s email isn't a valid address.`)
  return { firstName, lastName, email, phone }
}

/**
 * Invite a household to a unit for a NEW lease they will sign. See the file
 * header. Throws before anything is written when the household or the unit
 * can't take it; once the people are written, a lease that can't draft is
 * reported (draftBlocked), never thrown.
 */
export async function inviteHouseholdToNewLease(o: InviteHouseholdOpts): Promise<InviteHouseholdResult> {
  if (!Array.isArray(o.people) || o.people.length === 0) throw new AppError(400, 'Add at least one person.')
  const people = o.people.map((p, i) => cleanPerson(p, i, o.requireLastName !== false))
  const seen = new Set<string>()
  for (const p of people) {
    if (seen.has(p.email)) throw new AppError(400, `${p.email} is in this household twice.`)
    seen.add(p.email)
  }

  const unit = await queryOne<any>(
    `SELECT u.id, u.unit_number, u.property_id, u.landlord_id, u.rent_amount, u.occupancy_mode,
            p.name AS property_name, p.street1, p.city, p.state, p.zip
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [o.unitId])
  if (!unit) throw new AppError(404, 'Unit not found')
  o.authorize(unit.landlord_id)
  const landlordId: string = unit.landlord_id
  if (o.requireUnitSetup !== false) {
    // Gate: unit metrics (rent) must be set before inviting anyone to the unit.
    if (unit.rent_amount == null || Number(unit.rent_amount) <= 0) {
      throw new AppError(400, `Set the rent for Unit ${unit.unit_number} before inviting a tenant to it.`)
    }
    // S537: late-fee decision required for the unit's class before onboarding.
    await assertLateFeeDecisionForUnit(unit.id)
  }

  // Who each person already is on GAM. S654: only a resident's login is used.
  // Nic (10/2): another company's resident is NOT refused — they are invited,
  // and their own signature is what starts the lease (esign issuance).
  const own = Array.from(new Set([landlordId, ...o.ownCompanies]))
  const accounts: Array<{ existing: { id: string; email: string; tenant_id: string | null } | null; tied: boolean }> = []
  for (const p of people) {
    const existing = await findResidentAccount(p.email)
    accounts.push({ existing, tied: existing ? await accountTiedElsewhere(existing.id, own) : false })
  }
  // S631/S655: papering a sitting resident is an EXISTING tenancy (no
  // deposit prefill, no first-month move-in math) — when the landlord attests
  // it AND the property's onboarding window (or the landlord's own 28 days)
  // is open. Only the trigger's 28-day rule used to set this, so a property
  // onboarded later billed its sitting residents as new move-ins.
  const existingTenancy = o.existingResident
    ? await isExistingTenancyInvite(landlordId, unit.property_id)
    : false

  const homeSale = o.homeSale ? JSON.stringify(o.homeSale) : null
  const packet = o.packageTemplateIds ?? null
  const rentDueDay = o.rentDueDay ?? null

  const invited: InvitedPerson[] = []
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Two people inviting into the same unit at once must not both pass the
    // occupancy check and both draft.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`unit_invite:${unit.id}`])

    if (unit.occupancy_mode !== 'by_room') {
      // Occupancy-mode cap (whole_unit → 1 lease).
      await assertUnitCanAcceptNewLease(client as any, unit.id)
      // whole_unit repair: new people invalidate any UNSIGNED draft for the
      // unit (it's missing them). Void it so the household re-drafts complete.
      const draft = await client.query(
        `SELECT draft_document_id FROM pending_tenant_intents
          WHERE unit_id=$1 AND resolved_at IS NULL AND cancelled_at IS NULL AND draft_document_id IS NOT NULL LIMIT 1`,
        [unit.id]).then(r => r.rows[0])
      if (draft?.draft_document_id) await voidUnsignedDraft(client, unit.id, draft.draft_document_id)
    }

    for (let i = 0; i < people.length; i++) {
      const p = people[i]
      const acct = accounts[i]

      // User (create or reuse).
      let userId: string
      let createdHere = false
      if (acct.existing) {
        userId = acct.existing.id
      } else {
        const u = await client.query(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
           VALUES ($1, $2, 'tenant', $3, $4, $5) RETURNING id`,
          [p.email, PLACEHOLDER_PASSWORD, p.firstName, p.lastName, p.phone || null])
        userId = u.rows[0].id
        createdHere = true
      }
      const activated = await client.query<{ activated: boolean }>(
        `SELECT password_hash <> $2 AS activated FROM users WHERE id = $1`, [userId, PLACEHOLDER_PASSWORD])
      // S616/S654: someone with a working login — or another company's
      // account — is already on GAM: never a "set a password" link from us.
      const alreadyOnPlatform = activated.rows[0]?.activated === true || acct.tied

      // Tenant (create or reuse).
      let tenantId: string
      const t = await client.query('SELECT id FROM tenants WHERE user_id=$1 ORDER BY created_at LIMIT 1', [userId])
      if (t.rows.length) {
        tenantId = t.rows[0].id
        await client.query(`UPDATE tenants SET onboarding_source='onboarded' WHERE id=$1 AND onboarding_source != 'onboarded'`, [tenantId])
      } else {
        tenantId = (await client.query(`INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded') RETURNING id`, [userId])).rows[0].id
      }

      if (unit.occupancy_mode === 'by_room') {
        // by_room: each person is their own lease. Re-inviting the same person
        // replaces their own unsigned draft; a new person must fit the cap.
        const mine = await client.query(
          `SELECT draft_document_id FROM pending_tenant_intents
            WHERE tenant_id=$1 AND unit_id=$2 AND resolved_at IS NULL AND cancelled_at IS NULL LIMIT 1`,
          [tenantId, unit.id]).then(r => r.rows[0])
        if (mine) {
          if (mine.draft_document_id) await voidUnsignedDraft(client, unit.id, mine.draft_document_id)
        } else {
          await assertUnitCanAcceptNewLease(client as any, unit.id)
        }
      }

      if (i === 0 && o.rebindIntentId) {
        const imp = await client.query<{ tenant_id: string; unit_id: string | null }>(
          `SELECT tenant_id, unit_id FROM pending_tenant_intents
            WHERE id = $1 AND resolved_at IS NULL AND cancelled_at IS NULL FOR UPDATE`,
          [o.rebindIntentId]).then(r => r.rows[0])
        if (imp && imp.tenant_id !== tenantId) {
          // Made for somebody else (the landlord corrected the email). This
          // person's own invite below replaces it; left open or on the unit it
          // would draft a stranger into the household.
          await client.query(
            `UPDATE pending_tenant_intents SET cancelled_at = NOW(), updated_at = NOW() WHERE id = $1`, [o.rebindIntentId])
        } else if (imp && imp.unit_id !== unit.id) {
          const dup = await client.query(
            `SELECT 1 FROM pending_tenant_intents
              WHERE tenant_id = $1 AND unit_id = $2 AND cancelled_at IS NULL AND resolved_at IS NULL AND id <> $3
              LIMIT 1`, [tenantId, unit.id, o.rebindIntentId]).then(r => r.rows[0])
          if (dup) {
            await client.query(
              `UPDATE pending_tenant_intents SET cancelled_at = NOW(), updated_at = NOW() WHERE id = $1`, [o.rebindIntentId])
          } else {
            await client.query(
              `UPDATE pending_tenant_intents
                  SET unit_id = $2, property_id = COALESCE(property_id, $3), updated_at = NOW()
                WHERE id = $1`, [o.rebindIntentId, unit.id, unit.property_id])
          }
        }
      }

      // The unit-bound invite row (the roster slot). S629: conflicts on
      // (tenant, UNIT) — inviting somebody to a second spot never moves their
      // first invite. Re-inviting to the SAME unit reopens it.
      const intent = await client.query<{ id: string }>(
        // created_at from the clock, not the transaction: the household is
        // written in one transaction, and the lease drafts its signers in
        // created_at order — with NOW() every person ties and the second
        // person could come out holding the lease.
        `INSERT INTO pending_tenant_intents
           (landlord_id, tenant_id, parser_status, unit_id, property_id,
            home_sale_terms, package_template_ids, rent_due_day, is_existing_tenancy, created_at)
         VALUES ($1, $2, 'not_uploaded', $3, $4, $5, $6, $7, $8, clock_timestamp())
         ON CONFLICT (tenant_id, unit_id) WHERE cancelled_at IS NULL AND unit_id IS NOT NULL
         DO UPDATE SET resolved_at = NULL, accepted_at = NULL, draft_document_id = NULL,
                       property_id = COALESCE(public.pending_tenant_intents.property_id, EXCLUDED.property_id),
                       home_sale_terms = EXCLUDED.home_sale_terms,
                       package_template_ids = EXCLUDED.package_template_ids,
                       rent_due_day = COALESCE(EXCLUDED.rent_due_day, public.pending_tenant_intents.rent_due_day),
                       is_existing_tenancy = (public.pending_tenant_intents.is_existing_tenancy OR EXCLUDED.is_existing_tenancy),
                       updated_at = NOW()
         RETURNING id`,
        [landlordId, tenantId, unit.id, unit.property_id, homeSale, packet, rentDueDay, existingTenancy])

      invited.push({
        userId, tenantId, intentId: intent.rows[0].id, email: acct.existing?.email ?? p.email,
        firstName: p.firstName, lastName: p.lastName,
        alreadyOnPlatform, createdHere, screeningWaived: false, needsOwnSignature: acct.tied, notified: null,
      })
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // S579: an attested sitting resident skips the background check while the
  // property's onboarding window is open. Post-commit, best-effort — a waive
  // hiccup never rolls back the invite; they screen like anyone else.
  if (o.existingResident) {
    for (const p of invited) {
      try {
        const wr = await applyScreeningWaive({
          tenantId: p.tenantId, landlordId, propertyId: unit.property_id, unitId: unit.id, byUserId: o.byUserId,
        })
        p.screeningWaived = wr.waived
      } catch (err) {
        logger.error({ err, tenantId: p.tenantId }, '[new-lease-invite] grandfather waive failed')
      }
    }
  } else if (o.returningResident) {
    // The caller checked the allowance before anything was written; a race
    // that used the last of it leaves this person to screen, nothing worse.
    const { applyReturningResidentWaive } = await import('./onboardingWindow')
    for (const p of invited) {
      try {
        await applyReturningResidentWaive({
          tenantId: p.tenantId, landlordId, propertyId: unit.property_id, unitId: unit.id, byUserId: o.byUserId,
        })
        p.screeningWaived = true
      } catch (err) {
        logger.error({ err, tenantId: p.tenantId }, '[new-lease-invite] returning-resident waive failed')
      }
    }
  }

  // S647: draft NOW, after the waive (the send path's screening gate reads
  // it), QUIETLY — the landlord is on the screen and the reasons come back to
  // it. The lease joins "Waiting on you to sign"; nobody is emailed.
  let draftedDocumentIds: string[] = []
  let draftBlocked: string[] = []
  const draftClient = await getClient()
  try {
    await draftClient.query('BEGIN')
    const { autoDraftLeasesForUnit } = await import('./leaseOnboarding')
    const { createDocumentRecord, autoSendDraftedDocument } = await import('../routes/esign')
    const out = await autoDraftLeasesForUnit(draftClient as any, unit.id, createDocumentRecord, undefined, { quiet: true })
    await draftClient.query('COMMIT')
    draftedDocumentIds = out.draftedDocumentIds
    draftBlocked = out.blocked
    // After commit — the sender reads through the pool (S636). The landlord
    // is not emailed a link to sign what he is looking at.
    for (const docId of draftedDocumentIds) {
      await autoSendDraftedDocument(docId, { emailFirstSigner: false }).catch(err =>
        logger.error({ err, docId }, '[new-lease-invite] send after draft failed'))
    }
  } catch (err: any) {
    await draftClient.query('ROLLBACK').catch(() => {})
    logger.error({ err, unitId: unit.id }, '[new-lease-invite] draft failed')
    // Every reason ends with what happens next, like autoDraftLeasesForUnit's:
    // the hourly retry (householdLeaseDraft) drafts it once the cause is gone.
    // The refusal's own text keeps its one period (reasonSentence), never "..".
    draftBlocked = [`The lease for Unit ${unit.unit_number} could not be drafted: ${reasonSentence(err?.message)} GAM tries again every hour, so it drafts on its own once that is fixed.`]
  } finally {
    draftClient.release()
  }

  // S647: when a lease drafted, the people hear NOTHING yet — their one email
  // goes out when the landlord signs. Only when no lease could be drafted does
  // the old invite still go, so nobody is left with nothing (accepting it
  // retries the draft). Never for a roster: its people are emailed only by the
  // landlord's signature.
  let fallbackSent = false
  if (draftedDocumentIds.length === 0 && o.source !== 'roster') {
    await sendFallbackInvites(unit, landlordId, invited, o.fallbackEmail ?? 'onboarded')
    fallbackSent = invited.some(p => p.notified)
  }

  return {
    landlordId, propertyId: unit.property_id, unitId: unit.id, unitNumber: unit.unit_number,
    people: invited, draftedDocumentIds, draftBlocked, fallbackSent,
  }
}

/**
 * Void the unsigned draft a new invite makes stale. A tenant's signature or
 * the landlord's (S647: his signature issued it — it is live and billing) means
 * the people must be added by addendum instead.
 */
async function voidUnsignedDraft(client: PoolClient, unitId: string, documentId: string): Promise<void> {
  const tenantSigned = await client.query(
    `SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND signed_at IS NOT NULL AND role NOT IN ('landlord','witness') LIMIT 1`,
    [documentId]).then(r => r.rows[0])
  if (tenantSigned) throw new AppError(409, 'A tenant has already signed the lease for this unit. Void or replace it before adding another person.')
  const issued = await client.query(
    `SELECT 1 FROM lease_documents WHERE id=$1 AND issued_at IS NOT NULL`, [documentId]).then(r => r.rows[0])
  if (issued) throw new AppError(409, 'You have already signed the lease for this unit, so it is live and billing. Add this person with an addendum instead.')
  await client.query(`UPDATE lease_documents SET status='voided', updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','voided')`, [documentId])
  await client.query(`UPDATE pending_tenant_intents SET draft_document_id=NULL, updated_at=NOW() WHERE unit_id=$1 AND draft_document_id=$2`, [unitId, documentId])
}

/**
 * The pre-S647 invite, kept only for a household whose lease could not draft.
 * S654: a setup link is minted only for an account that still needs one and
 * belongs to no other company, and goes only to the address on the account.
 */
async function sendFallbackInvites(unit: any, landlordId: string, invited: InvitedPerson[], kind: 'onboarded' | 'invite'): Promise<void> {
  const ll = await queryOne<{ person: string; business: string | null }>(
    `SELECT TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS person,
            NULLIF(l.business_name, '') AS business
       FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])
  const landlordName = (kind === 'invite' ? (ll?.business || ll?.person) : ll?.person) || 'Your landlord'
  const propertyAddress = [unit.street1, unit.city, unit.state, unit.zip].filter(Boolean).join(', ')
  const unitLabel = `${unit.property_name} — Unit ${unit.unit_number}`
  for (const p of invited) {
    try {
      if (p.alreadyOnPlatform) {
        // S616: they have a login. Tell them in the account they already use.
        await createNotification({
          userId: p.userId, landlordId, type: 'lease_drafted',
          title: `${landlordName} added you to ${unitLabel}`,
          body: 'Your lease will be ready for you here. Sign in to your GAM account as usual.',
          data: { unitId: unit.id, tenantId: p.tenantId }, actionUrl: '/lease',
        })
        p.notified = 'notice'
        continue
      }
      const token = randomBytes(32).toString('hex')
      const set = await queryOne<{ id: string }>(
        `UPDATE users SET tenant_invite_token = $1, tenant_invite_expires_at = NOW() + INTERVAL '7 days',
                          tenant_invite_sent_at = COALESCE(tenant_invite_sent_at, NOW()), updated_at = NOW()
          WHERE id = $2 AND password_hash = $3 AND tenant_invite_accepted_at IS NULL
          RETURNING id`, [token, p.userId, PLACEHOLDER_PASSWORD])
      if (!set) continue
      const url = portalLink('tenant', `accept-invite?token=${token}`)
      // 10/5: replies reach the people who run this property (services/replyRouting).
      const replyTo = replyToProperty(unit.property_id)
      if (kind === 'invite') {
        await emailTenantInvite(p.email, p.firstName, landlordName, unit.property_name, `Unit ${unit.unit_number}`, url, false,
          { landlordId, tenantId: p.tenantId, replyTo })
      } else {
        await emailTenantOnboarded(p.email, p.firstName, landlordName, propertyAddress, unitLabel, url,
          { landlordId, tenantId: p.tenantId, replyTo })
      }
      p.notified = 'email'
    } catch (err) {
      // S654: never the link — it sets the account's password.
      logger.error({ err, tenantId: p.tenantId }, '[new-lease-invite] fallback invite failed')
    }
  }
}

// ── Their own signature ─────────────────────────────────────────────────────

/**
 * Nic (10/2): "Nobody is attached to a company without their OWN signature."
 *
 * The tenant signers on this document who have not signed yet and who already
 * have a GAM account with a company outside the document's account. The
 * landlord's signature does not issue the lease while this is non-empty; the
 * last signature does (the all-signed path in routes/esign.ts).
 *
 * Not counted:
 *   - a renewal (the household is this account's already);
 *   - anyone who already BECAME a tenant of this account — an active, ending
 *     or ended spot on one of its leases. Their earlier signature (or the paper
 *     lease the landlord moved over) made them its tenant. A spot that is only
 *     PROPOSED does not count: an add-a-roommate addendum writes a 'pending_add'
 *     row the moment it is drafted, before anyone signs, and counting that let
 *     the landlord's signature alone attach the person (to the addendum's lease,
 *     and to any other lease he drafted for them). Nor does that row once its
 *     lease ends: it is 'void' then (final sweep, 10/3; before that a lease
 *     ending marked it 'removed', and added_at still NULL tells the two apart),
 *     so the person never signed onto anything;
 *   - a tie to GAM's own renter pool (landlords.is_system): a marketplace
 *     applicant who screened through the pool has no other company.
 */
export async function tenantsNeedingOwnSignature(
  documentId: string,
  /**
   * Count this signer too although they have just signed — the e-sign route
   * asks "was the signature that just landed the last one this lease was
   * waiting for?" (it issues the lease then, when the landlord has signed).
   */
  opts: { alsoSignedUserId?: string | null } = {},
): Promise<Array<{ userId: string; name: string }>> {
  const doc = await queryOne<{ landlord_id: string; renews_lease_id: string | null }>(
    `SELECT landlord_id, renews_lease_id FROM lease_documents WHERE id = $1`, [documentId])
  if (!doc || doc.renews_lease_id) return []
  const signers = await query<{ user_id: string; name: string }>(
    `SELECT DISTINCT ON (s.user_id) s.user_id, s.name
       FROM lease_document_signers s
      WHERE s.document_id = $1 AND s.user_id IS NOT NULL
        AND s.role NOT IN ('landlord', 'witness')
        AND (s.status <> 'signed' OR s.user_id = $2::uuid)`, [documentId, opts.alsoSignedUserId ?? null])
  if (!signers.length) return []
  const ownRows = await query<{ id: string }>(
    `SELECT public.account_companies($1::uuid) AS id
      UNION SELECT id FROM landlords WHERE is_system = true`, [doc.landlord_id])
  const own = ownRows.map(r => r.id)
  const out: Array<{ userId: string; name: string }> = []
  for (const s of signers) {
    const attached = await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
         JOIN tenants t ON t.id = lt.tenant_id
        WHERE t.user_id = $1 AND l.landlord_id = ANY($2::uuid[])
          AND lt.status IN ('active', 'pending_remove', 'removed')
          AND lt.add_document_id IS DISTINCT FROM $3
          -- A spot that never activated. An add-a-roommate addendum writes
          -- its row with added_at NULL, and only the addendum's own execution
          -- (executeAddendumAdd) stamps it. A lease ending (PATCH /leases,
          -- leaseTermination, the nightly lease-end job) makes that unsigned
          -- 'pending_add' row 'void' since 10/3; before that it became
          -- 'removed', which this still excludes. Ended is not attached.
          AND NOT (lt.add_document_id IS NOT NULL AND lt.added_at IS NULL)
        LIMIT 1`, [s.user_id, own, documentId])
    if (attached) continue
    if (await accountTiedElsewhere(s.user_id, own)) out.push({ userId: s.user_id, name: s.name })
  }
  return out
}

// ── The old system's balance ────────────────────────────────────────────────

/**
 * Decisions (10/2): an old-system balance from the tenant CSV posts as ONE
 * charge on the household's lease when that lease issues. Called from inside
 * the lease build (routes/esign.ts executeOriginalLease), on its client, after
 * the household's invites are closed against the new lease.
 *
 * The household's balance is its first person's that has one (by household
 * order) — a file that repeats the lease's balance on every co-tenant row
 * posts it once. Shaped exactly like a landlord-entered carried balance
 * (POST /leases/:id/carried-balance): an opening-balance invoice that accrues
 * no late fees, and one carried_balance charge.
 *
 * ONCE PER HOUSEHOLD, EVER. Posting stamps every roster row of the household
 * (opening_balance_posted_at), under a row lock. A one-per-LEASE guard was not
 * enough: re-inviting a confirmed roster person to the same unit reopens their
 * invite, the next lease closes it again, and that lease would have billed the
 * same old balance a second time.
 */
export async function postRosterOpeningBalance(client: PoolClient, a: {
  leaseId: string; unitId: string; landlordId: string; tenantId: string; timezone: string | null
}): Promise<{ invoiceId: string; amount: number } | null> {
  const household = await client.query<{ id: string; opening_balance: string | null; posted: boolean }>(
    `SELECT r.id, r.opening_balance, (r.opening_balance_posted_at IS NOT NULL) AS posted
       FROM tenant_roster_drafts r
       JOIN pending_tenant_intents i ON i.id = r.intent_id
      WHERE i.resolved_lease_id = $1 AND r.discarded_at IS NULL
      ORDER BY r.household_order, r.created_at
      FOR UPDATE OF r`, [a.leaseId]).then(r => r.rows)
  if (household.length === 0) return null
  // Already posted for one of them on an earlier lease: never again.
  if (household.some(r => r.posted)) return null
  const holder = household.find(r => r.opening_balance != null)
  const amount = holder ? Math.round(Number(holder.opening_balance) * 100) / 100 : 0
  if (!(amount > 0)) return null
  const stamp = (invoiceId: string) => client.query(
    `UPDATE tenant_roster_drafts
        SET opening_balance_posted_at = NOW(), opening_balance_invoice_id = $2, updated_at = NOW()
      WHERE id = ANY($1::uuid[]) AND opening_balance_posted_at IS NULL`,
    [household.map(r => r.id), invoiceId])
  const today = todayIn(a.timezone)
  const invoiceNumber = await allocateInvoiceNumber(client, a.landlordId, Number(today.slice(0, 4)))
  const inv = await client.query<{ id: string }>(
    `INSERT INTO invoices (
       landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
       subtotal_rent, subtotal_fees, subtotal_utilities, total_amount,
       is_opening_balance, late_fee_exempt
     ) VALUES ($1,$2,$3,$4,$5,$6, 0, 0, 0, $7, TRUE, TRUE)
     ON CONFLICT (lease_id) WHERE is_opening_balance DO NOTHING
     RETURNING id`,
    [a.landlordId, a.tenantId, a.leaseId, a.unitId, invoiceNumber, today, amount.toFixed(2)])
  const invoiceId = inv.rows[0]?.id
  if (!invoiceId) {
    // This lease already carries an opening balance: that one is the
    // household's. Record it so no later lease posts the old balance either.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM invoices WHERE lease_id = $1 AND is_opening_balance LIMIT 1`, [a.leaseId])
    if (existing.rows[0]) await stamp(existing.rows[0].id)
    return null
  }
  await client.query(
    `INSERT INTO payments (
       invoice_id, unit_id, lease_id, tenant_id, landlord_id,
       type, amount, status, due_date, entry_description, notes
     ) VALUES ($1,$2,$3,$4,$5,'carried_balance',$6,'pending',$7,'BALANCE',$8)`,
    [invoiceId, a.unitId, a.leaseId, a.tenantId, a.landlordId, amount.toFixed(2), today,
     'Balance carried over from your previous landlord system'])
  await stamp(invoiceId)
  return { invoiceId, amount }
}

// ── The tenant CSV → draft roster ───────────────────────────────────────────

export type RosterIssue = { severity: 'block' | 'warn'; field?: string; message: string }
export type RosterCsvRow = {
  rowIndex: number
  firstName: string; lastName: string; email: string; phone: string
  propertyName: string; unitNumber: string
  leaseStart: string; leaseEnd: string; monthlyRent: string; securityDeposit: string
  lateFeeAmount: string; lateFeeGraceDays: string
  autoRenew: string; autoRenewMode: string; noticeDaysRequired: string
  outstandingBalance: string
  resolvedPropertyId?: string
  resolvedUnitId?: string
  /** The unit's rent in GAM — what the lease drafts at. */
  unitRent?: number | null
  /** The positive old-system balance this row carries, if any. */
  openingBalance?: number | null
  /** True when this row will not be saved (already with you, a repeat of an earlier row). */
  skip?: boolean
  extra?: Record<string, any>
  issues: RosterIssue[]
}

type ImportAccount = {
  userId: string; email: string; role: string; tenantId: string | null
  activeHere: boolean
  /** A live invite to a unit with this account already exists (Front Desk). */
  invitedHere: string | null
}

/**
 * Who each tenant-CSV email already is on GAM. The ids stay on the server;
 * nothing the browser sends back about an account is trusted (S654).
 */
async function lookupImportAccounts(emails: string[], landlordId: string, own: string[]): Promise<Map<string, ImportAccount>> {
  const out = new Map<string, ImportAccount>()
  if (emails.length === 0) return out
  const found = await query<any>(
    `SELECT DISTINCT ON (LOWER(u.email))
            LOWER(u.email) AS email_key, u.id AS user_id, u.email, u.role, t.id AS tenant_id,
            MAX(CASE WHEN u.role <> 'tenant' THEN u.role END)
              OVER (PARTITION BY LOWER(u.email)) AS other_role
       FROM users u
       LEFT JOIN tenants t ON t.user_id = u.id
      WHERE LOWER(u.email) = ANY($1::text[])
      ORDER BY LOWER(u.email), (u.email = LOWER(u.email)) DESC, u.created_at, t.created_at`,
    [emails])
  if (found.length === 0) return out
  const scope = Array.from(new Set([landlordId, ...own]))
  const leases = await query<{ user_id: string }>(
    `SELECT DISTINCT t.user_id
       FROM tenants t
       JOIN lease_tenants lt ON lt.tenant_id = t.id
       JOIN leases l ON l.id = lt.lease_id
      WHERE t.user_id = ANY($1::uuid[]) AND lt.status = 'active' AND l.status = 'active'
        AND l.landlord_id = ANY($2::uuid[])`,
    [found.map(f => f.user_id), scope])
  const invites = await query<{ user_id: string; unit_number: string }>(
    `SELECT DISTINCT ON (t.user_id) t.user_id, un.unit_number
       FROM pending_tenant_intents i
       JOIN tenants t ON t.id = i.tenant_id
       JOIN units un ON un.id = i.unit_id
      WHERE t.user_id = ANY($1::uuid[]) AND i.unit_id IS NOT NULL
        AND i.resolved_at IS NULL AND i.cancelled_at IS NULL
        AND i.landlord_id = ANY($2::uuid[])
      ORDER BY t.user_id, i.created_at DESC`,
    [found.map(f => f.user_id), scope])
  for (const f of found) {
    const role = f.other_role ?? f.role
    out.set(f.email_key, {
      userId: f.user_id, email: f.email, role, tenantId: f.tenant_id ?? null,
      activeHere: leases.some(l => l.user_id === f.user_id),
      invitedHere: invites.find(i => i.user_id === f.user_id)?.unit_number ?? null,
    })
  }
  return out
}

const money = (v: string): number | null => {
  if (!v) return null
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : NaN
}
const usd = (n: number) => `$${n.toFixed(2).replace(/\.00$/, '')}`

/**
 * Read a tenant CSV and say what would happen to each row, without writing
 * anything. Shared by "Check the file" (validate) and "Save as draft roster"
 * (draft), so the server always re-checks the file it saves.
 *
 * Nothing about a lease is required: the roster is who lives where. Rent,
 * dates, deposit and late fee are reference only — the lease drafts from the
 * landlord's setup — and a rent that differs from the unit's is flagged.
 * Blocks are only what makes a row unsavable: no name or email, a bad email,
 * a login that isn't a resident's, an unreadable balance, or no property.
 */
export async function reviewTenantCsv(a: {
  csv: string; source: CsvImportPlatform; landlordId: string; ownCompanies: string[]
}): Promise<{ rows: RosterCsvRow[]; records: any[]; summary: { total: number; blockers: number; warnings: number; ready: number } }> {
  let records: any[]
  try {
    records = parseCsv(a.csv, { columns: true, skip_empty_lines: true, trim: true }) as any[]
  } catch (e: any) {
    throw new AppError(400, `The file couldn't be read as a CSV: ${e.message}`)
  }
  if (records.length === 0) throw new AppError(400, 'The file has no rows of people in it.')
  const rawRecords = records
  records = applyMapping(records, a.source)

  const units = await query<any>(
    `SELECT u.id, u.unit_number, u.property_id, u.rent_amount, u.occupancy_mode,
            p.name AS property_name,
            (SELECT COUNT(*)::int FROM leases l WHERE l.unit_id = u.id AND l.status IN ('active','pending')) AS lease_count
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = $1 AND u.retired_at IS NULL`, [a.landlordId])
  const properties = await query<{ id: string; name: string }>(
    `SELECT id, name FROM properties WHERE landlord_id = $1`, [a.landlordId])

  const rows: RosterCsvRow[] = []
  const firstRowForEmail = new Map<string, number>()
  const perUnit = new Map<string, number>()
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    const s = (k: string) => String(r[k] ?? '').trim()
    const row: RosterCsvRow = {
      rowIndex: i,
      firstName: s('first_name'), lastName: s('last_name'), email: s('email').toLowerCase(), phone: s('phone'),
      propertyName: s('property_name'), unitNumber: s('unit_number'),
      leaseStart: s('lease_start'), leaseEnd: s('lease_end'), monthlyRent: s('monthly_rent'),
      securityDeposit: s('security_deposit'), lateFeeAmount: s('late_fee_amount'), lateFeeGraceDays: s('late_fee_grace_days'),
      autoRenew: s('auto_renew'), autoRenewMode: s('auto_renew_mode'), noticeDaysRequired: s('notice_days_required'),
      outstandingBalance: s('outstanding_balance'),
      extra: r._extra,
      issues: [],
    }
    const issues = row.issues
    if (!row.firstName) issues.push({ severity: 'block', field: 'first_name', message: 'First name is missing.' })
    if (!row.lastName) issues.push({ severity: 'block', field: 'last_name', message: 'Last name is missing.' })
    if (!row.email) issues.push({ severity: 'block', field: 'email', message: 'Email is missing. Their lease and sign-up travel by email.' })
    else if (!EMAIL_RE.test(row.email)) issues.push({ severity: 'block', field: 'email', message: 'This email isn\'t a valid address.' })

    // The old system's balance — real money, so it has to be readable.
    const bal = money(row.outstandingBalance)
    if (bal != null && Number.isNaN(bal)) {
      issues.push({ severity: 'block', field: 'outstanding_balance', message: 'The balance has to be a number (for example 125.50).' })
    } else if (bal != null && bal > 0) {
      row.openingBalance = Math.round(bal * 100) / 100
    } else if (bal != null && bal < 0) {
      issues.push({ severity: 'warn', field: 'outstanding_balance',
        message: `The old system shows a credit of ${usd(-bal)}. Credits don't carry over; add it after their lease is signed if you owe it to them.` })
    }

    // Where they live. The property must be found; a unit that isn't is
    // placed on the review screen.
    let props = properties.filter(p => p.name.trim().toLowerCase() === row.propertyName.toLowerCase())
    // A company with one property may leave the column blank. A NAME that
    // doesn't match is never read as "the only property": unit numbers repeat
    // from park to park, so a file from a park not yet in GAM would land its
    // people on this park's units.
    if (props.length === 0 && properties.length === 1 && !row.propertyName) props = properties
    if (props.length > 1 && row.unitNumber) {
      const withUnit = props.filter(p => units.some(u => u.property_id === p.id && String(u.unit_number).trim().toLowerCase() === row.unitNumber.toLowerCase()))
      if (withUnit.length === 1) props = withUnit
    }
    if (props.length === 0) {
      issues.push({ severity: 'block', field: 'property_name',
        message: row.propertyName
          ? `No property named "${row.propertyName}" in this company. The name has to match the property's name in GAM`
            + (properties.length === 1
              ? ` (yours is "${properties[0].name}"). If these people live there, fix the name in the file; if they live at a park you haven't added yet, add it first.`
              : '.')
          : 'The property name is missing.' })
    } else if (props.length > 1) {
      issues.push({ severity: 'block', field: 'property_name',
        message: `More than one property is named "${row.propertyName}". Rename one in GAM so the file can tell them apart.` })
    } else {
      row.resolvedPropertyId = props[0].id
      const unit = row.unitNumber
        ? units.find(u => u.property_id === props[0].id && String(u.unit_number).trim().toLowerCase() === row.unitNumber.toLowerCase())
        : null
      if (!unit) {
        issues.push({ severity: 'warn', field: 'unit_number',
          message: row.unitNumber
            ? `No unit "${row.unitNumber}" at ${props[0].name}. They'll be saved as not placed; pick their unit on the review screen.`
            : `No unit given. They'll be saved as not placed; pick their unit on the review screen.` })
      } else if (unit.occupancy_mode !== 'by_room' && unit.lease_count > 0) {
        issues.push({ severity: 'warn', field: 'unit_number',
          message: `Unit ${unit.unit_number} already has an active lease on GAM. They'll be saved as not placed; pick their unit on the review screen.` })
      } else {
        row.resolvedUnitId = unit.id
        row.unitRent = unit.rent_amount == null ? null : Number(unit.rent_amount)
        const n = (perUnit.get(unit.id) ?? 0) + 1
        perUnit.set(unit.id, n)
        if (row.unitRent == null || row.unitRent <= 0) {
          issues.push({ severity: 'warn', field: 'monthly_rent',
            message: `Unit ${unit.unit_number} has no rent set in GAM yet. Set it before you confirm the roster.` })
        } else {
          const fileRent = money(row.monthlyRent)
          if (fileRent != null && !Number.isNaN(fileRent) && Math.abs(fileRent - row.unitRent) >= 0.005) {
            issues.push({ severity: 'warn', field: 'monthly_rent',
              message: `The file says rent ${usd(fileRent)}; Unit ${unit.unit_number}'s rent in GAM is ${usd(row.unitRent)}. The lease drafts at ${usd(row.unitRent)}. Change the unit's rent first if ${usd(fileRent)} is right.` })
          }
        }
        // Final sweep (10/3): the same words as the roster and the invite, and
        // never "draft that lease by hand" — no lease GAM drafts holds more.
        if (unit.occupancy_mode !== 'by_room' && n === ROSTER_MAX_HOUSEHOLD + 1) {
          issues.push({ severity: 'warn', field: 'unit_number',
            message: `${tooManyForOneLease(unit.unit_number, null)} Pick their new unit on the review screen.` })
        }
      }
    }

    if (row.email) {
      const prev = firstRowForEmail.get(row.email)
      if (prev !== undefined) {
        issues.push({ severity: 'warn', field: 'email', message: `Same email as row ${prev + 1}. Only row ${prev + 1} is saved.` })
        row.skip = true
      } else {
        firstRowForEmail.set(row.email, i)
      }
    }
    rows.push(row)
  }

  // S654: an existing account must be a resident's. Nic (10/2): another
  // company's resident is never refused — they sign their own lease.
  const accounts = await lookupImportAccounts(
    Array.from(new Set(rows.map(r => r.email).filter(e => EMAIL_RE.test(e)))), a.landlordId, a.ownCompanies)
  for (const row of rows) {
    const found = accounts.get(row.email)
    if (!found) continue
    if (found.role !== 'tenant') {
      row.issues.push({ severity: 'block', field: 'email', message: NOT_A_RESIDENT_ACCOUNT })
    } else if (found.activeHere) {
      row.issues.push({ severity: 'warn', field: 'email', message: 'Already on an active lease with you. Not saved.' })
      row.skip = true
    } else if (found.invitedHere) {
      row.issues.push({ severity: 'warn', field: 'email', message: `Already invited to Unit ${found.invitedHere} with you (see Front Desk). Not saved.` })
      row.skip = true
    }
    // Another company's resident is saved like anyone else, with no note.
    // Saying so here would let any landlord upload a list of addresses and
    // learn which belong to other companies' people. Once the landlord has
    // drafted that person's lease, the screen says they sign it themselves.
  }

  const blockers = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'block').length, 0)
  const warnings = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'warn').length, 0)
  const ready = rows.filter(r => !r.skip && !r.issues.some(i => i.severity === 'block')).length
  return { rows, records: rawRecords, summary: { total: rows.length, blockers, warnings, ready } }
}

/**
 * Save the rows a review says can be saved. Nothing else is written: no user,
 * tenant, intent, lease or invoice, and nothing is sent. A re-upload updates
 * the live row for the same address.
 */
export async function saveRosterRows(a: {
  landlordId: string; rows: RosterCsvRow[]; byUserId: string; sourcePlatform: string; importAttemptId: string | null
}): Promise<{ saved: number; updated: number; byProperty: Array<{ propertyId: string; count: number }> }> {
  const savable = a.rows.filter(r => !r.skip && !r.issues.some(i => i.severity === 'block') && r.resolvedPropertyId)
  // Household order: the file's own order within each unit.
  const order = new Map<string, number>()
  let saved = 0, updated = 0
  const byProperty = new Map<string, number>()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    for (const r of savable) {
      const key = r.resolvedUnitId ?? `none:${r.resolvedPropertyId}`
      const householdOrder = r.resolvedUnitId ? (order.get(key) ?? 0) : 0
      order.set(key, householdOrder + 1)
      const fileValues = {
        propertyName: r.propertyName, unitNumber: r.unitNumber,
        leaseStart: r.leaseStart || null, leaseEnd: r.leaseEnd || null,
        monthlyRent: r.monthlyRent || null, securityDeposit: r.securityDeposit || null,
        lateFeeAmount: r.lateFeeAmount || null, lateFeeGraceDays: r.lateFeeGraceDays || null,
        autoRenew: r.autoRenew || null, noticeDaysRequired: r.noticeDaysRequired || null,
        outstandingBalance: r.outstandingBalance || null,
        ...(r.extra && Object.keys(r.extra).length ? { extra: r.extra } : {}),
      }
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO tenant_roster_drafts
           (landlord_id, property_id, unit_id, household_order, first_name, last_name, email, phone,
            opening_balance, file_values, source_platform, import_attempt_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
         ON CONFLICT (landlord_id, lower(email)) WHERE confirmed_at IS NULL AND discarded_at IS NULL
         DO UPDATE SET
           first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
           phone = COALESCE(EXCLUDED.phone, public.tenant_roster_drafts.phone),
           unit_id = CASE WHEN EXCLUDED.property_id IS DISTINCT FROM public.tenant_roster_drafts.property_id
                          THEN EXCLUDED.unit_id
                          ELSE COALESCE(EXCLUDED.unit_id, public.tenant_roster_drafts.unit_id) END,
           property_id = EXCLUDED.property_id,
           household_order = EXCLUDED.household_order,
           opening_balance = EXCLUDED.opening_balance,
           file_values = EXCLUDED.file_values,
           source_platform = EXCLUDED.source_platform,
           import_attempt_id = EXCLUDED.import_attempt_id,
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [a.landlordId, r.resolvedPropertyId, r.resolvedUnitId ?? null, householdOrder,
         r.firstName, r.lastName, r.email, r.phone || null,
         r.openingBalance ?? null, JSON.stringify(fileValues), a.sourcePlatform, a.importAttemptId, a.byUserId])
      if (res.rows[0]?.inserted) saved++; else updated++
      byProperty.set(r.resolvedPropertyId!, (byProperty.get(r.resolvedPropertyId!) ?? 0) + 1)
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  return { saved, updated, byProperty: Array.from(byProperty.entries()).map(([propertyId, count]) => ({ propertyId, count })) }
}

// ── The roster review ───────────────────────────────────────────────────────

const ROSTER_COLUMNS = `r.id, r.landlord_id, r.property_id, r.unit_id, r.household_order,
  r.first_name, r.last_name, r.email, r.phone, r.rent_due_day, r.existing_resident,
  r.package_template_ids, r.home_sale, r.opening_balance, r.file_values, r.updated_at`

function rosterRowOut(r: any) {
  return {
    id: r.id, propertyId: r.property_id, unitId: r.unit_id, householdOrder: r.household_order,
    firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
    rentDueDay: r.rent_due_day, existingResident: r.existing_resident,
    packageTemplateIds: r.package_template_ids, homeSale: r.home_sale,
    openingBalance: r.opening_balance == null ? null : Number(r.opening_balance),
    file: r.file_values ?? {}, updatedAt: r.updated_at,
  }
}

async function propertyForActor(actor: AuthPayload, propertyId: string): Promise<{ id: string; name: string; landlord_id: string }> {
  if (!UUID_RE.test(propertyId)) throw new AppError(400, 'Pick a property.')
  const p = await queryOne<{ id: string; name: string; landlord_id: string }>(
    `SELECT id, name, landlord_id FROM properties WHERE id = $1`, [propertyId])
  if (!p) throw new AppError(404, 'Property not found')
  if (!canManageLandlordResource(actor, p.landlord_id)) throw new AppError(403, 'That property is not yours to onboard into.')
  return p
}

/** Live roster counts per property, for the chooser badge. */
export async function rosterSummary(landlordIds: string[]): Promise<Array<{ propertyId: string; propertyName: string; count: number }>> {
  if (!landlordIds.length) return []
  const rows = await query<{ property_id: string; name: string; n: number }>(
    `SELECT r.property_id, p.name, COUNT(*)::int AS n
       FROM tenant_roster_drafts r JOIN properties p ON p.id = r.property_id
      WHERE r.landlord_id = ANY($1::uuid[]) AND r.confirmed_at IS NULL AND r.discarded_at IS NULL
      GROUP BY r.property_id, p.name ORDER BY p.name`, [landlordIds])
  return rows.map(r => ({ propertyId: r.property_id, propertyName: r.name, count: r.n }))
}

export async function liveRosterCount(propertyId: string): Promise<number> {
  const r = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM tenant_roster_drafts
      WHERE property_id = $1 AND confirmed_at IS NULL AND discarded_at IS NULL`, [propertyId])
  return r?.n ?? 0
}

/**
 * One property's roster, grouped by unit, with every reason a unit can't be
 * confirmed yet named in plain words. Read fresh every time — the screen
 * never works from a stale copy.
 */
export async function loadRoster(actor: AuthPayload, propertyId: string) {
  const property = await propertyForActor(actor, propertyId)
  const rows = await query<any>(
    `SELECT ${ROSTER_COLUMNS} FROM tenant_roster_drafts r
      WHERE r.property_id = $1 AND r.confirmed_at IS NULL AND r.discarded_at IS NULL
      ORDER BY r.household_order, r.created_at`, [propertyId])
  const window = await getOnboardingWindow(propertyId)
  const unitIds = Array.from(new Set(rows.map(r => r.unit_id).filter(Boolean)))
  const units = unitIds.length === 0 ? [] : await query<any>(
    `SELECT u.id, u.unit_number, u.unit_type, u.rent_amount, u.occupancy_mode, u.bedrooms,
            u.dwelling_ownership,
            (SELECT COUNT(*)::int FROM leases l WHERE l.unit_id = u.id AND l.status IN ('active','pending')) AS lease_count,
            (SELECT COALESCE(json_agg(TRIM(COALESCE(iu.first_name,'') || ' ' || COALESCE(iu.last_name,''))), '[]'::json)
               FROM pending_tenant_intents pti JOIN tenants it ON it.id = pti.tenant_id JOIN users iu ON iu.id = it.user_id
              WHERE pti.unit_id = u.id AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL) AS invited
       FROM units u WHERE u.id = ANY($1::uuid[]) ORDER BY u.unit_number`, [unitIds])
  const out = []
  for (const u of units) {
    const people = rows.filter(r => r.unit_id === u.id).map(rosterRowOut)
    out.push({
      unitId: u.id, unitNumber: u.unit_number, unitType: u.unit_type,
      rent: u.rent_amount == null ? null : Number(u.rent_amount),
      occupancyMode: u.occupancy_mode, dwellingOwnership: u.dwelling_ownership,
      hasDefaultLease: !!(await resolveDefaultTemplateForUnit(u.id)),
      blockers: await unitBlockers(u, people.length),
      // A whole unit's household has ONE old balance. A by-room unit's people
      // are each their own lease and household, so each keeps their own (on
      // their row; the unit has none).
      openingBalance: u.occupancy_mode === 'by_room'
        ? null : (people.find(p => p.openingBalance != null)?.openingBalance ?? null),
      people,
    })
  }
  return {
    property: { id: property.id, name: property.name },
    window: { open: window.open, daysRemaining: window.daysRemaining },
    units: out,
    notPlaced: rows.filter(r => !r.unit_id).map(rosterRowOut),
    count: rows.length,
  }
}

/** Every reason this unit's household can't be confirmed yet, each with the next step. */
async function unitBlockers(u: any, peopleCount: number): Promise<string[]> {
  const out: string[] = []
  if (u.rent_amount == null || Number(u.rent_amount) <= 0) out.push(`Unit ${u.unit_number} has no rent set. Set its rent on the unit's page, then come back.`)
  if (!(await resolveDefaultTemplateForUnit(u.id))) out.push(`No default lease is set for this kind of unit. Set one in GoldSign (Templates), then come back.`)
  try { await assertLateFeeDecisionForUnit(u.id) } catch (e: any) { out.push(e?.message || 'Decide the late fee for this kind of unit first.') }
  if (u.occupancy_mode === 'by_room') {
    const cap = Math.max(1, Number(u.bedrooms || 1) * 2)
    const invited = Array.isArray(u.invited) ? u.invited.length : 0
    if (u.lease_count + invited + peopleCount > cap) out.push(`Unit ${u.unit_number} holds ${cap} leases and this would be ${u.lease_count + invited + peopleCount}. Move someone to another unit.`)
  } else {
    if (u.lease_count > 0) out.push(`Unit ${u.unit_number} already has an active lease. Move these people to another unit or remove them.`)
    const invited: string[] = Array.isArray(u.invited) ? u.invited : []
    // Final sweep (10/3): invites are cancelled in the Pending Pool; Front
    // Desk is a call list with no cancel button.
    if (invited.length > 0) out.push(`Unit ${u.unit_number} already has ${invited.join(', ')} invited. Cancel that invite in Tenant Onboarding (Pending Pool), or move these people.`)
    if (peopleCount > ROSTER_MAX_HOUSEHOLD) out.push(tooManyForOneLease(u.unit_number, peopleCount))
  }
  return out
}

const rosterPatch = (body: any) => {
  const out: Record<string, any> = {}
  const str = (k: string, max = 120) => {
    if (body[k] === undefined) return
    const v = String(body[k] ?? '').trim()
    if (v.length > max) throw new AppError(400, 'That is too long.')
    out[k] = v
  }
  str('firstName'); str('lastName'); str('email', 254); str('phone', 40)
  if (out.firstName === '' ) throw new AppError(400, 'First name can\'t be blank.')
  if (out.lastName === '') throw new AppError(400, 'Last name can\'t be blank.')
  if (out.email !== undefined) {
    out.email = out.email.toLowerCase()
    if (!EMAIL_RE.test(out.email)) throw new AppError(400, 'That email isn\'t a valid address.')
  }
  if (body.unitId !== undefined) {
    if (body.unitId !== null && (typeof body.unitId !== 'string' || !UUID_RE.test(body.unitId))) throw new AppError(400, 'Pick a unit.')
    out.unitId = body.unitId
  }
  if (body.householdOrder !== undefined) {
    const n = Number(body.householdOrder)
    if (!Number.isInteger(n) || n < 0 || n > 99) throw new AppError(400, 'That order isn\'t valid.')
    out.householdOrder = n
  }
  if (body.rentDueDay !== undefined) out.rentDueDay = inviteRentDueDay(body)
  if (body.existingResident !== undefined) out.existingResident = body.existingResident === true
  if (body.homeSale !== undefined) out.homeSale = body.homeSale === true
  if (body.packageTemplateIds !== undefined) out.packageTemplateIds = body.packageTemplateIds === null ? null : packetIds(body.packageTemplateIds)
  if (body.openingBalance !== undefined) {
    if (body.openingBalance === null || body.openingBalance === '') out.openingBalance = null
    else {
      const n = money(String(body.openingBalance))
      if (n == null || Number.isNaN(n) || n < 0) throw new AppError(400, 'The old balance has to be a number of 0 or more.')
      out.openingBalance = n > 0 ? Math.round(n * 100) / 100 : null
    }
  }
  return out
}

/** Fix one roster row. Edits save one field at a time from the review screen. */
export async function updateRosterRow(actor: AuthPayload, id: string, body: any) {
  if (!UUID_RE.test(id)) throw new AppError(404, 'That person is no longer on the roster.')
  const row = await queryOne<any>(`SELECT ${ROSTER_COLUMNS} FROM tenant_roster_drafts r WHERE r.id = $1`, [id])
  if (!row) throw new AppError(404, 'That person is no longer on the roster.')
  if (!canManageLandlordResource(actor, row.landlord_id)) throw new AppError(403, 'That roster is not yours.')
  const p = rosterPatch(body ?? {})
  if (p.unitId) {
    const unit = await queryOne<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1 AND retired_at IS NULL`, [p.unitId])
    if (!unit || unit.property_id !== row.property_id) throw new AppError(400, 'Pick a unit at this property.')
  }
  if (p.homeSale === true) {
    const unitId = p.unitId !== undefined ? p.unitId : row.unit_id
    const u = unitId ? await queryOne<{ unit_type: string; dwelling_ownership: string | null }>(
      `SELECT unit_type, dwelling_ownership FROM units WHERE id = $1`, [unitId]) : null
    if (!u || u.unit_type !== 'mobile_home' || u.dwelling_ownership !== 'landlord') {
      throw new AppError(400, 'Only a park-owned mobile home can be sold on installments.')
    }
  }
  const cols: Record<string, string> = {
    firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', unitId: 'unit_id',
    householdOrder: 'household_order', rentDueDay: 'rent_due_day', existingResident: 'existing_resident',
    homeSale: 'home_sale', packageTemplateIds: 'package_template_ids', openingBalance: 'opening_balance',
  }
  const sets: string[] = []
  const vals: any[] = []
  for (const [k, v] of Object.entries(p)) {
    vals.push(k === 'phone' && v === '' ? null : v)
    sets.push(`${cols[k]} = $${vals.length}`)
  }
  // A person moved to another unit (or out of one) loses that unit's packet
  // ticks and home sale: they were decided for the old unit.
  if (p.unitId !== undefined && p.unitId !== row.unit_id) {
    if (p.packageTemplateIds === undefined) sets.push('package_template_ids = NULL')
    if (p.homeSale === undefined) sets.push('home_sale = false')
  }
  if (sets.length === 0) return rosterRowOut(row)
  vals.push(id)
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const updated = (await client.query<any>(
      `UPDATE tenant_roster_drafts r SET ${sets.join(', ')}, updated_at = NOW()
        WHERE r.id = $${vals.length} AND r.confirmed_at IS NULL AND r.discarded_at IS NULL
        RETURNING ${ROSTER_COLUMNS}`, vals)).rows[0]
    if (!updated) throw new AppError(409, 'That person was already confirmed or removed. The list has been refreshed.')
    // The old balance is the HOUSEHOLD's (one balance, posted once). A file
    // often repeats it on every co-tenant's row; the number the landlord types
    // on the unit card replaces all of them, so clearing it clears it and the
    // next person's copy never comes back. Not in a by-room unit: there each
    // person is their own lease and their own household, so each roommate's
    // old balance is theirs and editing one never touches another's.
    if (p.openingBalance !== undefined && updated.unit_id) {
      await client.query(
        `UPDATE tenant_roster_drafts SET opening_balance = NULL, updated_at = NOW()
          WHERE unit_id = $1 AND landlord_id = $2 AND id <> $3
            AND confirmed_at IS NULL AND discarded_at IS NULL AND opening_balance IS NOT NULL
            AND EXISTS (SELECT 1 FROM units u WHERE u.id = $1 AND u.occupancy_mode IS DISTINCT FROM 'by_room')`,
        [updated.unit_id, updated.landlord_id, id])
    }
    await client.query('COMMIT')
    return rosterRowOut(updated)
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {})
    if (e?.code === '23505') throw new AppError(409, 'Someone else on this company\'s roster already has that email.')
    throw e
  } finally {
    client.release()
  }
}

/** Remove one person from the roster. Soft: the row is kept, just hidden. */
export async function discardRosterRow(actor: AuthPayload, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new AppError(404, 'That person is no longer on the roster.')
  const row = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM tenant_roster_drafts WHERE id = $1`, [id])
  if (!row) throw new AppError(404, 'That person is no longer on the roster.')
  if (!canManageLandlordResource(actor, row.landlord_id)) throw new AppError(403, 'That roster is not yours.')
  await query(
    `UPDATE tenant_roster_drafts SET discarded_at = NOW(), discarded_by = $2, updated_at = NOW()
      WHERE id = $1 AND confirmed_at IS NULL AND discarded_at IS NULL`, [id, actor.userId])
}

/** Confirm refused: every problem, each with its next step, for the screen to list. */
export class RosterNotReady extends AppError {
  constructor(public problems: string[]) {
    super(409, problems.length === 1 ? problems[0] : `${problems.length} things need fixing before this roster can be confirmed.`)
  }
}

export type RosterConfirmUnit = {
  unitId: string; unitNumber: string
  status: 'drafted' | 'not_drafted' | 'error'
  message: string | null
  people: string[]
  /**
   * The people on this unit whose lease starts on their OWN signature (they
   * already have a GAM account with another company): the landlord's
   * signature issues and bills nothing for them until they sign. Named after
   * the lease is drafted, never in the file check.
   */
  ownSignature: string[]
}

/**
 * Confirm one property's roster. Refuses — listing every problem, each with
 * its next step — unless everyone is placed and every unit can take its
 * household. Then, unit by unit and each in its own transaction (one bad unit
 * never sinks the rest), every household is invited through
 * inviteHouseholdToNewLease: accounts made, leases drafted from the landlord's
 * setup and waiting for his signature. Nobody is emailed. One in-app notice.
 */
export async function confirmRoster(actor: AuthPayload, propertyId: string): Promise<{ units: RosterConfirmUnit[]; drafted: number }> {
  const property = await propertyForActor(actor, propertyId)
  const roster = await loadRoster(actor, propertyId)
  if (roster.count === 0) throw new AppError(409, 'There is nobody on this property\'s roster to confirm.')
  const problems: string[] = []
  if (roster.notPlaced.length > 0) {
    const names = roster.notPlaced.map(p => `${p.firstName} ${p.lastName}`.trim())
    problems.push(`${names.join(', ')} ${names.length === 1 ? 'isn\'t' : 'aren\'t'} placed in a unit yet. Pick a unit for each, or remove them.`)
  }
  for (const u of roster.units) problems.push(...u.blockers)
  // Accounts can change between review and confirm: re-check every address.
  for (const u of roster.units) {
    for (const p of u.people) {
      try { await findResidentAccount(p.email) } catch (e: any) {
        problems.push(`${p.firstName} ${p.lastName} (${p.email}): ${e?.message}`)
      }
    }
  }
  if (problems.length) throw new RosterNotReady(problems)

  const own = Array.from(new Set([property.landlord_id, ...landlordScopeIds(actor)]))
  const results: RosterConfirmUnit[] = []
  let drafted = 0
  for (const u of roster.units) {
    const people = [...u.people].sort((a, b) => a.householdOrder - b.householdOrder)
    const first = people[0]
    try {
      const res = await inviteHouseholdToNewLease({
        unitId: u.unitId,
        people: people.map(p => ({ firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone })),
        authorize: (lid) => { if (!canManageLandlordResource(actor, lid)) throw new AppError(403, 'That unit is not yours to onboard into.') },
        ownCompanies: own,
        byUserId: actor.userId,
        existingResident: people.every(p => p.existingResident !== false),
        // A household's own due day is asked of sitting residents only (S652).
        rentDueDay: people.every(p => p.existingResident !== false)
          ? (people.find(p => p.rentDueDay != null)?.rentDueDay ?? null) : null,
        homeSale: people.some(p => p.homeSale) ? { selling: true } : null,
        packageTemplateIds: first.packageTemplateIds ?? null,
        source: 'roster',
      })
      // Stamp each row with the invite it became (by email: the service made
      // or found the account for exactly these addresses).
      for (const p of people) {
        const made = res.people.find(x => x.email.toLowerCase() === p.email.toLowerCase())
          ?? res.people[people.indexOf(p)]
        await query(
          `UPDATE tenant_roster_drafts SET confirmed_at = NOW(), confirmed_by = $2, intent_id = $3, updated_at = NOW()
            WHERE id = $1 AND confirmed_at IS NULL AND discarded_at IS NULL`,
          [p.id, actor.userId, made?.intentId ?? null])
      }
      const ok = res.draftedDocumentIds.length > 0
      if (ok) drafted += res.draftedDocumentIds.length
      results.push({
        unitId: u.unitId, unitNumber: u.unitNumber,
        status: ok ? 'drafted' : 'not_drafted',
        message: ok ? null : (res.draftBlocked[0] ?? 'The lease could not be drafted. It drafts on its own once the unit\'s default lease is fixed.'),
        people: people.map(p => `${p.firstName} ${p.lastName}`.trim()),
        ownSignature: ok ? await namesSigningFirst(res) : [],
      })
    } catch (e: any) {
      logger.error({ err: e, unitId: u.unitId }, '[roster] confirming a unit failed')
      results.push({
        unitId: u.unitId, unitNumber: u.unitNumber, status: 'error',
        message: e instanceof AppError ? e.message : 'Something went wrong confirming this unit. Nothing was saved for it; press Confirm again.',
        people: people.map(p => `${p.firstName} ${p.lastName}`.trim()),
        ownSignature: [],
      })
    }
  }

  if (drafted > 0) {
    await createNotification({
      userId: actor.userId, type: 'lease_ready_to_sign',
      title: `${drafted} lease${drafted === 1 ? ' is' : 's are'} waiting for your signature`,
      body: `The ${property.name} roster is confirmed. Sign each lease in Front Desk → Waiting on you to sign; each household gets one email when you sign theirs.`,
      data: { propertyId }, actionUrl: '/front-desk',
    }).catch(() => {})
  }
  return { units: results, drafted }
}

/**
 * Who on a just-drafted household's lease signs it first — the e-sign
 * issuance step's own answer (tenantsNeedingOwnSignature), so the screen says
 * exactly what the landlord's signature will and won't do. If that check
 * can't run, the invite's own reading of who already has another company's
 * account stands in.
 */
async function namesSigningFirst(res: InviteHouseholdResult): Promise<string[]> {
  const names = new Set<string>()
  try {
    for (const docId of res.draftedDocumentIds) {
      for (const p of await tenantsNeedingOwnSignature(docId)) names.add(p.name)
    }
  } catch (err) {
    logger.error({ err, unitId: res.unitId }, '[roster] own-signature check failed; using the invite\'s reading')
    for (const x of res.people) if (x.needsOwnSignature) names.add(`${x.firstName} ${x.lastName}`.trim() || x.email)
  }
  return Array.from(names)
}

/**
 * S537 (Nic): a roster confirms only onto a decided late-fee class. Report
 * the (property, unit type) pairs in this file with no decision yet, each with
 * a SUGGESTED prefill — the file's most frequent (fee, grace) for that pair. A
 * landlord who kept fees consistent on the old platform was expressing a
 * de-facto policy; it is offered as the default they confirm, never applied.
 */
export async function missingLateFeeDecisions(rows: RosterCsvRow[]): Promise<Array<{
  propertyId: string; propertyName: string; unitType: string
  suggested: { initialAmount: number; graceDays: number; initialType: 'flat'; leaseCount: number; leaseTotal: number } | null
}>> {
  const unitIdsAll = Array.from(new Set(rows.map(r => r.resolvedUnitId).filter(Boolean))) as string[]
  if (unitIdsAll.length === 0) return []
  const pairRows = await query<any>(
    `SELECT u.id AS unit_id, u.property_id, u.unit_type, p.name AS property_name
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = ANY($1::uuid[]) AND u.unit_type IS NOT NULL`, [unitIdsAll])
  const unitPair = new Map(pairRows.map((r: any) => [r.unit_id, r]))
  const decided = await query<any>(
    `SELECT property_id, unit_type FROM property_unit_type_late_fees WHERE property_id = ANY($1::uuid[])`,
    [Array.from(new Set(pairRows.map((r: any) => r.property_id)))])
  const decidedSet = new Set(decided.map((d: any) => `${d.property_id}|${d.unit_type}`))
  const tally = new Map<string, { info: any; counts: Map<string, { n: number; amount: number; graceDays: number }> }>()
  for (const r of rows) {
    const pr: any = r.resolvedUnitId ? unitPair.get(r.resolvedUnitId) : null
    if (!pr) continue
    const pairKey = `${pr.property_id}|${pr.unit_type}`
    if (decidedSet.has(pairKey)) continue
    if (!tally.has(pairKey)) tally.set(pairKey, { info: pr, counts: new Map() })
    const amt = r.lateFeeAmount ? parseFloat(r.lateFeeAmount) : NaN
    if (isNaN(amt) || amt <= 0) continue
    const g = r.lateFeeGraceDays ? parseInt(r.lateFeeGraceDays, 10) : 5
    const grace = isNaN(g) ? 5 : g
    const vKey = `${amt}|${grace}`
    const cur = tally.get(pairKey)!.counts.get(vKey) || { n: 0, amount: amt, graceDays: grace }
    cur.n++
    tally.get(pairKey)!.counts.set(vKey, cur)
  }
  const out: any[] = []
  for (const { info, counts } of tally.values()) {
    let suggested: any = null
    let best = 0
    let total = 0
    for (const c of counts.values()) {
      total += c.n
      if (c.n > best) { best = c.n; suggested = { initialAmount: c.amount, graceDays: c.graceDays, initialType: 'flat', leaseCount: c.n } }
    }
    if (suggested) suggested.leaseTotal = total
    out.push({ propertyId: info.property_id, propertyName: info.property_name, unitType: info.unit_type, suggested })
  }
  return out
}
