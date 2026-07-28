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
import { BY_ROOM_LEASES_PER_BEDROOM } from '@gam/shared'
import { resolveDefaultTemplateForUnit } from './templateResolve'
import { createNotification } from './notifications'

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
    `SELECT COUNT(*)::int AS n FROM pending_tenant_intents WHERE unit_id=$1 AND resolved_at IS NULL`, [unitId])
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

/** Term-date prefill from the template's default_term_months. start = today. */
function termPrefill(defaultTermMonths: number | null): Record<string, string> {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const out: Record<string, string> = { start_date: iso(start) }
  if (defaultTermMonths && defaultTermMonths > 0) {
    const end = new Date(start); end.setMonth(end.getMonth() + defaultTermMonths)
    out.end_date = iso(end)
    out.lease_type = 'fixed_term'
  } else {
    out.lease_type = 'month_to_month'
  }
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
      WHERE pti.unit_id = $1 AND pti.resolved_at IS NULL
      ORDER BY pti.created_at ASC`, [unitId]).then(r => r.rows as IntentRow[])
}

async function landlordSigner(client: Client, landlordId: string) {
  const l = await client.query(
    `SELECT u.id AS user_id, u.first_name, u.last_name, u.email
       FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId]).then(r => r.rows[0])
  if (!l) throw new AppError(500, 'Landlord owner user not found')
  return { userId: l.user_id, role: 'landlord', name: `${l.first_name} ${l.last_name}`.trim(), email: l.email }
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
    `SELECT u.id, u.occupancy_mode, u.unit_number, p.landlord_id, p.name AS property_name
       FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id=$1`, [unitId]).then(r => r.rows[0])
  if (!unit) throw new AppError(404, 'Unit not found')

  const tmpl = await resolveDefaultTemplateForUnit(unitId, client)
  const landlord = await landlordSigner(client, unit.landlord_id)

  const notifyNeedsTemplate = async () => {
    await createNotification({
      userId: landlord.userId, type: 'lease_draft_blocked',
      title: 'Set a default lease template',
      body: `A tenant accepted their invite for Unit ${unit.unit_number} — ${unit.property_name}, but no default lease template is set for this unit type. Set one to auto-draft the lease.`,
      data: { unitId }, sendEmail: false,
    }).catch(() => {})
  }
  if (!tmpl) { await notifyNeedsTemplate(); return { draftedDocumentIds: [] } }

  const term = termPrefill(tmpl.default_term_months)
  const roster = await loadRoster(client, unitId)
  const drafted: string[] = []

  const draftFor = async (members: IntentRow[], title: string) => {
    const tenantSigners = members.slice(0, 4).map((m, i) => ({
      userId: m.user_id,
      role: i === 0 ? 'primary' : CO_TENANT_ROLES[i - 1],
      name: `${m.first_name} ${m.last_name}`.trim(),
      email: m.email,
    }))
    const doc = await createDocumentRecord(client, {
      landlordId: unit.landlord_id, templateId: tmpl.id, unitId, leaseId: null,
      title, basePdfUrl: null, documentType: 'original_lease',
      targetLeaseTenantId: null, promoteLeaseTenantId: null,
      signers: [landlord, ...tenantSigners],
      prefillValues: { ...term },
    })
    await client.query(
      `UPDATE pending_tenant_intents SET draft_document_id=$1, updated_at=NOW() WHERE id = ANY($2)`,
      [doc.id, members.map(m => m.id)])
    await createNotification({
      userId: landlord.userId, type: 'lease_ready_to_sign',
      title: 'Lease drafted — ready for your signature',
      body: `The lease for Unit ${unit.unit_number} — ${unit.property_name} is drafted and ready. Review and sign, then it goes to the tenant(s).`,
      data: { documentId: doc.id, unitId }, sendEmail: false,
    }).catch(() => {})
    drafted.push(doc.id)
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
          data: { unitId }, sendEmail: false,
        }).catch(() => {})
        return { draftedDocumentIds: [] }
      }
      await draftFor(roster, `Lease — Unit ${unit.unit_number} — ${unit.property_name}`)
    }
  }
  return { draftedDocumentIds: drafted }
}
