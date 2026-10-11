/**
 * S558 (Nic): smooth manual lease onboarding (Flow B — new leases, e-sign).
 *
 * Two pieces:
 *  - assertUnitCanAcceptNewLease: the occupancy-mode safeguard. whole_unit caps
 *    at ONE lease (co-tenants share it); by_room caps at 2×bedrooms independent
 *    leases. Called when inviting someone to a unit.
 *  - autoDraftLeasesForUnit: fired when someone is invited (S647) and again on
 *    acceptance (a no-op once drafted). It auto-drafts the lease(s) off the unit's default
 *    template (rent/deposit/unit/property fill via createDocumentRecord's own
 *    unit prefill; this adds the term dates), landlord signs first, tenants sign.
 *      whole_unit → ONE shared lease for the household.
 *      by_room    → one INDEPENDENT single-tenant lease per person.
 */
import { AppError } from '../middleware/errorHandler'
import { landlordSigningContact } from './landlordSigningContact'
import { BY_ROOM_LEASES_PER_BEDROOM, ROSTER_MAX_HOUSEHOLD } from '@gam/shared'
import { resolveDefaultTemplateForUnit } from './templateResolve'
import { createNotification } from './notifications'
import { computeLeaseStart, computeLeaseEnd } from './leaseDates'
import { queryOne } from '../db'

type Client = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> }

const CO_TENANT_ROLES = ['co_tenant_1', 'co_tenant_2', 'co_tenant_3']

/**
 * Final sweep (10/3): a whole-unit household bigger than one lease holds, said
 * the same way everywhere it shows (the invite screen, the emailed notice, the
 * CSV check and the roster), with the one next step that works.
 *
 * GAM cannot put more than ROSTER_MAX_HOUSEHOLD people on one lease: the
 * templates carry primary and co_tenant_1..3, and createDocumentRecord refuses
 * any other signer role. The old advice, "draft this one by hand", was a dead
 * end: Send Document's "A Unit" mode needs an active lease, and its "Specific
 * Emails" mode hands the fifth person co_tenant_4, which createDocumentRecord
 * refuses. Moving someone to another unit is the step that works.
 *
 * `people` null = the count is not final yet (the CSV check flags the row that
 * goes over, before the rest of the file is read).
 */
export function tooManyForOneLease(unitLabel: string, people: number | null): string {
  const who = people == null ? `more than ${ROSTER_MAX_HOUSEHOLD} people` : `${people} people`
  return `Unit ${unitLabel} has ${who} on one lease; a lease holds up to ${ROSTER_MAX_HOUSEHOLD}. Move someone to another unit.`
}

/** The invite path's how-to after tooManyForOneLease (screen and email alike). */
const MOVE_AN_INVITED_PERSON =
  'To move someone, cancel their invite in Tenant Onboarding (Pending Pool), then invite them to the other unit. '
  + 'The lease for the rest then drafts on its own within the hour.'

/**
 * Final sweep (10/3): ONE "could not draft" notice per unit and cause.
 *
 * The hourly retry (scheduler → draftAllPendingLeases → autoDraftLeasesForUnit)
 * re-runs every unit still waiting, and every run sent its notice again, emailed
 * each time. createNotification has no dedupe, so a cause nobody fixed meant one
 * email to the landlord every hour, and a household too big for one lease is
 * never fixed by the sweep, so those never stopped. Production holds four
 * identical "Lease could not be drafted automatically" notices for one unit on
 * 2026-09-02. One email per thing (S652).
 *
 * A notice is skipped while the same one stands: same landlord user, same
 * title, the same `key` inside its data, and (when `body` is given) the same
 * words, so a refusal with a NEW reason is a new cause and is sent. "Stands"
 * means still unread, or sent within the last LEASE_DRAFT_BLOCKED_REMIND_DAYS;
 * a read notice for a cause still not fixed after that is sent once more.
 *
 * Read on the pool, not the caller's client: createNotification writes on the
 * pool, and a failed read here must never abort the caller's transaction (the
 * tenant's accept). A failed read sends the notice: a repeat beats a stuck lease
 * nobody hears about.
 */
export const LEASE_DRAFT_BLOCKED_REMIND_DAYS = 7
async function blockedNoticeStands(n: {
  userId: string; title: string; key: Record<string, string | null>; body?: string
}): Promise<boolean> {
  try {
    const hit = await queryOne<{ x: number }>(
      `SELECT 1 AS x FROM notifications
        WHERE user_id = $1 AND type = 'lease_draft_blocked' AND title = $2
          AND data @> $3::jsonb
          AND ($4::text IS NULL OR body = $4::text)
          AND (read IS NOT TRUE OR created_at > NOW() - ($5::int * INTERVAL '1 day'))
        LIMIT 1`,
      [n.userId, n.title, JSON.stringify(n.key), n.body ?? null, LEASE_DRAFT_BLOCKED_REMIND_DAYS])
    return !!hit
  } catch { return false }
}

/**
 * Final sweep (10/3): a refusal's own words, ready for one more sentence after
 * them. GAM's refusals already end with a period ("…Add one to the package
 * first."), so adding ". Once that…" after one printed "first.. Once that…".
 * Trailing periods, commas, colons, semicolons and spaces come off and exactly
 * one period goes back; a question or exclamation keeps its own mark. Running
 * it twice changes nothing, so a reason that already went through it is safe.
 */
export function reasonSentence(message: unknown, fallback = 'an unexpected error'): string {
  const text = (typeof message === 'string' ? message : '').replace(/[\s.,;:]+$/, '').trim()
  if (!text) return `${fallback}.`
  return /[!?]$/.test(text) ? text : `${text}.`
}

/** Count active/pending leases on a unit. */
async function activeLeaseCount(client: Client, unitId: string): Promise<number> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM leases WHERE unit_id=$1 AND status IN ('active','pending')`, [unitId])
  return r.rows[0]?.n ?? 0
}

/** Count unresolved (in-flight) pending intents on a unit. */
async function openIntentCount(client: Client, unitId: string): Promise<number> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM pending_tenant_intents WHERE unit_id=$1 AND resolved_at IS NULL AND cancelled_at IS NULL`, [unitId])
  return r.rows[0]?.n ?? 0
}

/**
 * Occupancy-mode gate for inviting someone to a unit on a NEW lease.
 * whole_unit: blocked once an active/pending lease exists (co-tenant additions
 *   to an in-flight roster don't hit this — no lease yet). by_room: blocked once
 *   active leases + in-flight intents reach the 2×bedrooms cap.
 */
export async function assertUnitCanAcceptNewLease(client: Client, unitId: string): Promise<void> {
  const u = await client.query(
    `SELECT occupancy_mode, bedrooms FROM units WHERE id=$1`, [unitId]).then(r => r.rows[0])
  if (!u) throw new AppError(404, 'Unit not found')

  const leases = await activeLeaseCount(client, unitId)
  if (u.occupancy_mode === 'by_room') {
    const cap = Math.max(1, Number(u.bedrooms || 1) * BY_ROOM_LEASES_PER_BEDROOM)
    const inFlight = await openIntentCount(client, unitId)
    if (leases + inFlight >= cap) {
      throw new AppError(409, `This unit is at capacity — ${cap} leases (by-room, ${BY_ROOM_LEASES_PER_BEDROOM} per bedroom).`)
    }
    return
  }
  // whole_unit (default safeguard)
  if (leases >= 1) {
    throw new AppError(409, 'This unit already has an active lease (whole-unit mode). Switch the unit to by-room to stack independent leases, or add this person to the existing lease.')
  }
}

/**
 * S582: term-date prefill. start = the unit's available_date (if future) else
 * today; end = month-end snap of the template's default_term_months (null → M2M).
 * Rules live in services/leaseDates.ts.
 */
function termPrefill(
  defaultTermMonths: number | null, availableDate: string | Date | null, tz: string | null,
): Record<string, string> {
  // S654: "today" is the park's day, not the server's (a UTC server rolls over at 5 pm Phoenix).
  const start = computeLeaseStart(availableDate, new Date(), tz)
  const out: Record<string, string> = { start_date: start }
  const end = computeLeaseEnd(start, defaultTermMonths)
  if (end) { out.end_date = end; out.lease_type = 'fixed_term' }
  // S653: say "no end date" OUT LOUD. createDocumentRecord fills any blank
  // end_date from the template's default term (suggestUnitPrefill), so a
  // month-to-month draft that merely omitted the key came out with a 12-month
  // end date under a "Month-to-month" label. "-" is the document's own no-end
  // entry; execution maps it to end_date NULL.
  else { out.lease_type = 'month_to_month'; out.end_date = '-' }
  return out
}

type IntentRow = {
  id: string; tenant_id: string; user_id: string; first_name: string; last_name: string;
  email: string; created_at: string; accepted_at: string | null; draft_document_id: string | null
}

async function loadRoster(client: Client, unitId: string): Promise<IntentRow[]> {
  return client.query(
    `SELECT pti.id, pti.tenant_id, pti.accepted_at, pti.draft_document_id, pti.home_sale_terms, pti.package_template_ids,
            u.id AS user_id, u.first_name, u.last_name, u.email, pti.created_at
       FROM pending_tenant_intents pti
       JOIN tenants t ON t.id = pti.tenant_id
       JOIN users u ON u.id = t.user_id
      WHERE pti.unit_id = $1 AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL
      ORDER BY pti.created_at ASC`, [unitId]).then(r => r.rows as IntentRow[])
}

/**
 * S630 (Nic): the signing request goes to the address that PROPERTY routes to,
 * so an on-site manager can sign for their own property without the portfolio
 * login or the other properties' mail. Falls back to the account email.
 */
async function landlordSigner(client: Client, landlordId: string, unitId: string) {
  const c = await landlordSigningContact(landlordId, { unitId }, client)
  if (!c) throw new AppError(500, 'Landlord owner user not found')
  return { userId: c.userId, role: 'landlord', name: c.name, email: c.email }
}

/**
 * Fire after a roster member accepts. Drafts whatever is now ready.
 * createDocumentRecord (passed in to avoid a circular import) fills
 * rent/deposit/unit/property from the unit+template; we supply the term dates.
 * Best-effort per group: a missing default template notifies the landlord
 * instead of drafting.
 */
export interface DraftTermOverride {
  /** YYYY-MM-DD the household said they are moving in; falls back to the unit's available date. */
  startDate?: string | null
  /** Months they asked for; null with monthToMonth = true means month to month. */
  termMonths?: number | null
  monthToMonth?: boolean
}

export async function autoDraftLeasesForUnit(
  client: Client,
  unitId: string,
  createDocumentRecord: (client: any, opts: any) => Promise<any>,
  // S653 (Nic): an approved screening already says when they want in and for
  // how long — the draft carries THAT, not the template's default term.
  terms?: DraftTermOverride,
  // S655: QUIET — the landlord is the one on the screen doing this (an invite
  // or a roster confirm), so no "Lease drafted" or "could not draft" email
  // goes to them; the reasons come back in `blocked` for the screen to show.
  // A 75-unit roster confirm used to mean 75 emails to the person who had
  // just pressed the button. The accept path, the hourly sweep and approvals
  // keep the emails: nobody is watching a screen when those draft.
  opts: { quiet?: boolean } = {},
): Promise<{ draftedDocumentIds: string[]; blocked: string[] }> {
  const quiet = opts.quiet === true
  const blocked: string[] = []
  const unit = await client.query(
    // S654: available_date as text — a pg DATE arrives as local midnight, not a calendar day.
    `SELECT u.id, u.occupancy_mode, u.unit_number, u.unit_type, u.property_id,
            u.available_date::text AS available_date,
            p.landlord_id, p.name AS property_name, p.timezone
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id=$1`, [unitId]).then(r => r.rows[0])
  if (!unit) throw new AppError(404, 'Unit not found')

  const tmpl = await resolveDefaultTemplateForUnit(unitId, client)
  const landlord = await landlordSigner(client, unit.landlord_id, unitId)

  // Every "could not draft" notice goes through here, once per unit and cause
  // (blockedNoticeStands). S620: emailed for the same reason as the success
  // case, and with more cause — a BLOCKED draft is silent progress that never
  // happens. The tenant is waiting on a lease nobody knows is stuck.
  const notifyBlocked = async (n: {
    title: string; body: string; actionUrl: string
    key: Record<string, string | null>; sameWords: boolean
  }) => {
    if (await blockedNoticeStands({
      userId: landlord.userId, title: n.title, key: n.key, body: n.sameWords ? n.body : undefined,
    })) return
    await createNotification({
      userId: landlord.userId, type: 'lease_draft_blocked',
      title: n.title, body: n.body,
      data: { unitId, propertyId: unit.property_id, unitType: unit.unit_type ?? null },
      actionUrl: n.actionUrl,
      sendEmail: true, emailTo: landlord.email,
    }).catch(() => {})
  }

  const notifyNeedsTemplate = async () => {
    if (quiet) {
      blocked.push(`No default lease is set for this kind of unit, so the lease for Unit ${unit.unit_number} could not be drafted. Set one in GoldSign (Templates), then it drafts on its own.`)
      return
    }
    await notifyBlocked({
      title: 'Set a default lease template',
      body: `The lease for Unit ${unit.unit_number} — ${unit.property_name} could not be drafted: no default lease is set for this kind of unit. Set one in GoldSign (Templates), then it drafts on its own.`,
      // The Templates tab, not Documents (ESignPage opens Documents by default).
      actionUrl: '/esign?tab=templates',
      // One default lease fixes every unit of this kind at the property, so it
      // is one notice for all of them, not one per unit waiting on it.
      key: unit.unit_type
        ? { propertyId: unit.property_id, unitType: unit.unit_type }
        : { unitId },
      sameWords: false,
    })
  }
  if (!tmpl) { await notifyNeedsTemplate(); return { draftedDocumentIds: [], blocked } }

  const term = terms
    ? termPrefill(terms.monthToMonth ? null : (terms.termMonths ?? tmpl.default_term_months), terms.startDate ?? unit.available_date, unit.timezone)
    : termPrefill(tmpl.default_term_months, unit.available_date, unit.timezone)
  const roster = await loadRoster(client, unitId)
  const drafted: string[] = []

  const draftFor = async (members: IntentRow[], title: string) => {
    // S629 (Nic): ORDER INDEX, explicitly.
    //
    // These were left to default, and createDocumentRecord defaults to 1, so
    // every auto-drafted lease came out with the landlord AND every tenant at
    // order_index 1. That is the exact tie esign.ts warns about — "a tied
    // order_index would let a tenant sign in parallel with the landlord" — and
    // the send-time rule then REFUSES the document: "Landlord must be the first
    // signer." So the first lease drafted this way could not be sent at all.
    //
    // Landlord 1, primary 2, co-tenants 3 upward: the order the document is
    // actually meant to travel in.
    const tenantSigners = members.slice(0, 4).map((m, i) => ({
      userId: m.user_id,
      role: i === 0 ? 'primary' : CO_TENANT_ROLES[i - 1],
      name: `${m.first_name} ${m.last_name}`.trim(),
      email: m.email,
      orderIndex: i + 2,
    }))
    // S582: contain a per-group draft failure inside a SAVEPOINT. This is
    // called on the tenant's accept transaction — if createDocumentRecord
    // THROWS (e.g. the unit's default template is missing the property's
    // late-fee fields, so drafting is correctly refused), letting it propagate
    // would abort the WHOLE accept transaction and silently roll back the
    // tenant's `accepted_at` (their acceptance is lost, with no signal and no
    // re-draft trigger). Instead: roll back just this draft, keep the accept
    // transaction healthy, and NOTIFY the landlord with the reason so it's
    // visible and fixable (draft manually / fix the template).
    await client.query('SAVEPOINT draft_one', [])
    try {
      const doc = await createDocumentRecord(client, {
        landlordId: unit.landlord_id, templateId: tmpl.id, unitId, leaseId: null,
        title, basePdfUrl: null, documentType: 'original_lease',
        targetLeaseTenantId: null, promoteLeaseTenantId: null,
        signers: [{ ...landlord, orderIndex: 1 }, ...tenantSigners],
        prefillValues: { ...term },
      })
      // S652: the rest of the packet — the package's documents, and the home
      // sale if the invite said so (terms travel on the primary's intent).
      const { draftPacketSiblings } = await import('./packetDraft')
      await draftPacketSiblings(client as any, {
        landlordId: unit.landlord_id, unitId, leaseDocId: doc.id, leaseTemplateId: tmpl.id,
        signers: [{ ...landlord, orderIndex: 1 }, ...tenantSigners],
        homeSale: (members as any[]).find(m => m.home_sale_terms)?.home_sale_terms ?? null,
        templateIds: (members as any[]).find(m => m.package_template_ids)?.package_template_ids ?? null,
        prefill: { ...term },
      }, createDocumentRecord)
      await client.query(
        `UPDATE pending_tenant_intents SET draft_document_id=$1, updated_at=NOW() WHERE id = ANY($2)`,
        [doc.id, members.map(m => m.id)])
      await client.query('RELEASE SAVEPOINT draft_one', [])

      // S629 (Nic): "why the hell would I log in, open the lease and press
      // send? It needs to be auto sent." The decision was made when the
      // household was invited — the lease goes out on its own, and the landlord
      // gets the signing link in their email like every other signer.
      //
      // Deliberately AFTER the savepoint is released: a send failure must not
      // roll back the draft. If the email cannot go, the lease still exists,
      // still says pending, and can be sent by hand.
      // S636: THE SEND CANNOT HAPPEN HERE, and never could.
      //
      // autoSendDraftedDocument reads through the POOL, and this runs inside the
      // caller's still-open accept transaction — so it looked for a document
      // that had not been committed yet, found nothing, and returned false every
      // single time. Every lease drafted on acceptance stayed `pending` and the
      // landlord was never emailed. It only ever appeared to work when something
      // called it separately, after the commit.
      //
      // The id goes back to the caller instead, which sends once the
      // transaction is committed. Same reason the S634 move-in bundle had to
      // take its reads on the caller's client: a pool connection cannot see
      // another connection's uncommitted rows.
      const sent = false

      if (!quiet) await createNotification({
        userId: landlord.userId, type: 'lease_ready_to_sign',
        title: 'Lease drafted — ready for your signature',
        body: sent
          ? `The lease for Unit ${unit.unit_number} — ${unit.property_name} is drafted and sent — check your email for the signing link. It goes to the tenant(s) as soon as you sign.`
          : `The lease for Unit ${unit.unit_number} — ${unit.property_name} is drafted and ready. Sign in to GoldSign to review and send it.`,
        data: { documentId: doc.id, unitId },
        actionUrl: '/esign',
        // S620 (Nic): "landlords may want email notification when a lease is
        // drafted. That way they know to log in and complete the workflow...
        // in case they're out and about." The whole chain STOPS here until the
        // landlord signs — the tenant has already accepted and can do nothing
        // until the countersign lands — so a bell nobody is looking at is the
        // wrong channel for it. createNotification falls back to the standard
        // email template from title + body.
        sendEmail: true, emailTo: landlord.email,
      }).catch(() => {})
      drafted.push(doc.id)
    } catch (err: any) {
      await client.query('ROLLBACK TO SAVEPOINT draft_one', []).catch(() => {})
      if (quiet) {
        // S655: a by-room unit drafts one lease per person, so one person's
        // can draft while another's is refused. Name whose it is, so the
        // screen and the agent can say which drafted and which did not.
        const whose = unit.occupancy_mode === 'by_room'
          ? ` (${members.map(m => `${m.first_name} ${m.last_name}`.trim()).join(', ')})` : ''
        // Final sweep (10/3): the refusal already names its own cause (and
        // often the step: "…Add one to the package first."), so it is said as
        // it reads, with no guessed cause stuck on after it, and only what
        // happens next is added: the hourly retry (draftAllPendingLeases).
        blocked.push(`The lease for Unit ${unit.unit_number}${whose} could not be drafted: ${reasonSentence(err?.message)} Once that is fixed, it drafts on its own.`)
        return
      }
      await notifyBlocked({
        title: 'Lease could not be drafted automatically',
        body: `The lease for Unit ${unit.unit_number} — ${unit.property_name} could not be drafted: ${reasonSentence(err?.message)} Once that is fixed, it drafts on its own within the hour.`,
        actionUrl: '/esign',
        // Same words = same cause. A different refusal on the same unit is
        // news (the landlord fixed the first one) and is sent.
        key: { unitId }, sameWords: true,
      })
    }
  }

  // S647 (Nic, DIRECTIVE): "I want to sign my side of the lease for everybody
  // even before they accept the portal invite."
  //
  // Drafting used to wait for acceptance — per person for by-room, and for the
  // WHOLE household for whole-unit. That made the landlord's signature wait on
  // the slowest member of every household, and it is why sixteen people were
  // parked behind "waiting on them to accept" with no lease anyone could sign.
  // Since S647 the landlord's signature is what issues and bills a lease, so
  // making it wait on the tenant's first step inverted the whole order.
  //
  // Acceptance still matters — it activates their login — it just no longer
  // gates the paperwork. A tenant who has not accepted can sign straight from
  // the emailed token link (S629), and accepting later still works: the portal
  // invite authenticates by the token on their account, not by this row.
  if (unit.occupancy_mode === 'by_room') {
    // Each not-yet-drafted person → their own single-tenant lease.
    for (const m of roster) {
      if (m.draft_document_id) continue
      await draftFor([m], `Lease — Unit ${unit.unit_number}, ${m.first_name} ${m.last_name}`.trim())
    }
  } else {
    // whole_unit: one shared lease for the household as it stands, if none is
    // drafted yet. Adding a co-tenant voids an UNSIGNED draft upstream, so
    // draft_document_id being null here is still the re-draft signal.
    if (roster.length === 0) return { draftedDocumentIds: [], blocked }
    const alreadyDrafted = roster.some(m => m.draft_document_id)
    if (!alreadyDrafted) {
      if (roster.length > ROSTER_MAX_HOUSEHOLD) {
        // Final sweep (10/3): never "draft it by hand" — no lease GAM can draft
        // holds more than ROSTER_MAX_HOUSEHOLD people (see tooManyForOneLease).
        if (quiet) {
          blocked.push(`${tooManyForOneLease(unit.unit_number, roster.length)} ${MOVE_AN_INVITED_PERSON}`)
          return { draftedDocumentIds: [], blocked }
        }
        await notifyBlocked({
          title: 'Too many people for one lease',
          body: `${tooManyForOneLease(`${unit.unit_number} — ${unit.property_name}`, roster.length)} ${MOVE_AN_INVITED_PERSON}`,
          // Where the invites are cancelled.
          actionUrl: '/tenant-onboarding/pending',
          // The count is in the words: a different count is a new notice.
          key: { unitId }, sameWords: true,
        })
        return { draftedDocumentIds: [], blocked }
      }
      await draftFor(roster, `Lease — Unit ${unit.unit_number} — ${unit.property_name}`)
    }
  }
  return { draftedDocumentIds: drafted, blocked }
}
