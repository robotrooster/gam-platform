/**
 * S558 (Nic): smooth manual lease onboarding (Flow B — new leases, e-sign).
 *
 * Two pieces:
 *  - assertUnitCanAcceptNewLease: the occupancy-mode safeguard. whole_unit caps
 *    at ONE lease (co-tenants share it); by_room caps at 2×bedrooms independent
 *    leases. Called when inviting someone to a unit.
 *  - autoDraftLeasesForUnit: fired after an invited person accepts. When the
 *    unit's roster is ready it auto-drafts the lease(s) off the unit's default
 *    template (rent/deposit/unit/property fill via createDocumentRecord's own
 *    unit prefill; this adds the term dates), landlord signs first, tenants sign.
 *      whole_unit → ONE shared lease once every roster member has accepted.
 *      by_room    → one INDEPENDENT single-tenant lease per accepted person.
 */
import { AppError } from '../middleware/errorHandler'
import { landlordSigningContact } from './landlordSigningContact'
import { BY_ROOM_LEASES_PER_BEDROOM } from '@gam/shared'
import { resolveDefaultTemplateForUnit } from './templateResolve'
import { createNotification } from './notifications'
import { computeLeaseStart, computeLeaseEnd } from './leaseDates'

type Client = { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> }

const CO_TENANT_ROLES = ['co_tenant_1', 'co_tenant_2', 'co_tenant_3']

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
function termPrefill(defaultTermMonths: number | null, availableDate: string | Date | null): Record<string, string> {
  const start = computeLeaseStart(availableDate)
  const out: Record<string, string> = { start_date: start }
  const end = computeLeaseEnd(start, defaultTermMonths)
  if (end) { out.end_date = end; out.lease_type = 'fixed_term' }
  else { out.lease_type = 'month_to_month' }
  return out
}

type IntentRow = {
  id: string; tenant_id: string; user_id: string; first_name: string; last_name: string;
  email: string; created_at: string; accepted_at: string | null; draft_document_id: string | null
}

async function loadRoster(client: Client, unitId: string): Promise<IntentRow[]> {
  return client.query(
    `SELECT pti.id, pti.tenant_id, pti.accepted_at, pti.draft_document_id,
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
export async function autoDraftLeasesForUnit(
  client: Client,
  unitId: string,
  createDocumentRecord: (client: any, opts: any) => Promise<any>,
): Promise<{ draftedDocumentIds: string[] }> {
  const unit = await client.query(
    `SELECT u.id, u.occupancy_mode, u.unit_number, u.available_date, p.landlord_id, p.name AS property_name
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id=$1`, [unitId]).then(r => r.rows[0])
  if (!unit) throw new AppError(404, 'Unit not found')

  const tmpl = await resolveDefaultTemplateForUnit(unitId, client)
  const landlord = await landlordSigner(client, unit.landlord_id, unitId)

  const notifyNeedsTemplate = async () => {
    await createNotification({
      userId: landlord.userId, type: 'lease_draft_blocked',
      title: 'Set a default lease template',
      body: `A tenant accepted their invite for Unit ${unit.unit_number} — ${unit.property_name}, but no default lease template is set for this unit type. Set one to auto-draft the lease.`,
      data: { unitId },
      actionUrl: '/esign',
      // S620: emailed for the same reason as the success case, and with more
      // cause — a BLOCKED draft is silent progress that never happens. The
      // tenant has accepted and is waiting on a lease nobody knows is stuck.
      sendEmail: true, emailTo: landlord.email,
    }).catch(() => {})
  }
  if (!tmpl) { await notifyNeedsTemplate(); return { draftedDocumentIds: [] } }

  const term = termPrefill(tmpl.default_term_months, unit.available_date)
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

      await createNotification({
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
      await createNotification({
        userId: landlord.userId, type: 'lease_draft_blocked',
        title: 'Lease could not be drafted automatically',
        body: `A tenant accepted their invite for Unit ${unit.unit_number} — ${unit.property_name}, but the lease couldn't be auto-drafted: ${err?.message || 'unexpected error'}. This is usually the unit's default lease template missing a required field. Fix it, then draft the lease.`,
        data: { unitId },
        actionUrl: '/esign',
        sendEmail: true, emailTo: landlord.email,
      }).catch(() => {})
    }
  }

  if (unit.occupancy_mode === 'by_room') {
    // Each accepted, not-yet-drafted person → their own single-tenant lease.
    for (const m of roster) {
      if (!m.accepted_at || m.draft_document_id) continue
      await draftFor([m], `Lease — Unit ${unit.unit_number}, ${m.first_name} ${m.last_name}`.trim())
    }
  } else {
    // whole_unit: one shared lease once the WHOLE roster has accepted and none
    // is drafted yet. (Adding a co-tenant voids the stale draft upstream, so
    // draft_document_id being null here is the re-draft signal.)
    if (roster.length === 0) return { draftedDocumentIds: [] }
    const allAccepted = roster.every(m => m.accepted_at)
    const alreadyDrafted = roster.some(m => m.draft_document_id)
    if (allAccepted && !alreadyDrafted) {
      if (roster.length > 4) {
        await createNotification({
          userId: landlord.userId, type: 'lease_draft_blocked',
          title: 'Too many co-tenants to auto-draft',
          body: `Unit ${unit.unit_number} — ${unit.property_name} has ${roster.length} people on one lease; auto-draft supports up to 4. Draft this lease manually.`,
          data: { unitId },
          actionUrl: '/esign',
          sendEmail: true, emailTo: landlord.email,
        }).catch(() => {})
        return { draftedDocumentIds: [] }
      }
      await draftFor(roster, `Lease — Unit ${unit.unit_number} — ${unit.property_name}`)
    }
  }
  return { draftedDocumentIds: drafted }
}
