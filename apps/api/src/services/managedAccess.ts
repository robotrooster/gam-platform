/**
 * 10/22–23 (Nic) — A MANAGEMENT COMPANY'S PEOPLE, IN THE OWNER'S PORTAL.
 *
 * The third-party PM portal folded into the landlord portal, so "Blu manages
 * Oak Park for its owner" has to be something his ONE login can see:
 *
 *   "Blue's going to be property managing for some other people. And he doesn't
 *    necessarily want to toggle between portals with a different login. He
 *    wants to just adjust a view in the same screen."
 *
 * When an owner engages a management company (pm_property_invitations, accepted
 * either way round), that company's people get access to THAT PROPERTY and
 * nothing else of the owner's:
 *
 *   • a landlord_members row with role 'manager', carrying via_pm_company_id so
 *     the access belongs to the COMPANY the owner engaged — take somebody off
 *     the company's staff and their access to the owner's park goes with them,
 *     as one fact rather than two;
 *   • a property_manager_scopes row for that owner's company, holding the
 *     properties the owner actually engaged them for and the permissions each
 *     person has.
 *
 * HOW PERMISSIONS ARE DECIDED, which is Nic's own answer:
 *
 *   "If I own the property management company and I have somebody working for
 *    me that does maintenance, they are scoped to maintenance. I add them as a
 *    team member for maintenance. It's the same kind of breakdown as the people
 *    that do it on site... The property management owner or operator would
 *    assign those roles to people that are allowed to have those permissions...
 *    The goal is flexibility to allow them to run the business where they want
 *    to run it."
 *
 * So the PM owner decides, per person, out of the same catalog an owner uses for
 * their own staff (pm_staff.permissions).
 *
 * AND IT IS CAPPED BY WHAT THE OWNER GRANTED THE COMPANY. The PM owner cannot
 * hand their staff something the property's owner never gave:
 *
 *   'manage' — the engagement GAM routes money under. The staff member's own
 *              permissions stand.
 *   'view'   — the PM was hired off-platform and GAM is only showing them the
 *              property (services/pm acceptPropertyInvitation). Nothing that
 *              writes: READ_ONLY below is the whole of it.
 *
 * Nothing here ever grants the owner's OTHER properties, and nothing grants a
 * company's own staff anything about the owner's other companies.
 */
import type { PoolClient } from 'pg'

type Q = Pick<PoolClient, 'query'>

/**
 * What a 'view' engagement is allowed to carry. Reading, and nothing that
 * changes a record or moves a dollar.
 */
export const READ_ONLY_MANAGED_PERMISSIONS = [
  'properties.view', 'units.view', 'leases.view', 'tenants.view',
  'maintenance.view', 'schedule.view', 'reports.view', 'documents.view',
] as const

export interface ManagedGrant {
  /** How many of the company's people were given this property. */
  people: number
  /** The scope rows written or widened. */
  scopes: number
}

/** The permissions this person may actually hold on this engagement. */
function capped(staffPermissions: Record<string, unknown> | null, scope: 'manage' | 'view'): Record<string, true> {
  const out: Record<string, true> = {}
  if (scope === 'view') {
    // The owner never agreed to anything being changed, so nothing can be.
    for (const k of READ_ONLY_MANAGED_PERMISSIONS) out[k] = true
    return out
  }
  const walk = (prefix: string, v: unknown): void => {
    if (v === true) { if (prefix) out[prefix] = true; return }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        walk(prefix ? `${prefix}.${k}` : k, x)
      }
    }
  }
  walk('', staffPermissions ?? {})
  return out
}

/**
 * Give everyone the management company employs access to one property of one
 * owner. Idempotent: run it again after a staff change and it catches up.
 */
export async function grantManagedAccess(q: Q, args: {
  pmCompanyId: string
  landlordId: string
  propertyId: string
  scope: 'manage' | 'view'
  grantedByUserId: string | null
}): Promise<ManagedGrant> {
  const staff = (await q.query<{ user_id: string; permissions: Record<string, unknown> | null; role: string }>(
    `SELECT user_id, permissions, role
       FROM pm_staff
      WHERE pm_company_id = $1 AND status = 'active' AND removed_at IS NULL`,
    [args.pmCompanyId])).rows
  let scopes = 0
  for (const person of staff) {
    // The company's own owner runs the engagement, so they hold what the owner
    // granted the company; everybody else holds what their own boss gave them.
    const perms = capped(person.role === 'owner' ? null : person.permissions, args.scope)
    if (person.role === 'owner' && args.scope === 'manage') {
      // The PM's owner needs the engagement's own authority, not a staff list.
      for (const k of MANAGING_OWNER_PERMISSIONS) perms[k] = true
    }
    // Access to the company, marked as coming through the management company.
    await q.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role, via_pm_company_id, added_by_user_id)
       VALUES ($1, $2, 'manager', $3, $4)
       ON CONFLICT (landlord_id, user_id) DO NOTHING`,
      [args.landlordId, person.user_id, args.pmCompanyId, args.grantedByUserId])
    // The property, added to whatever this person already manages for this
    // owner. array_append on a deduplicated set, so running twice is the same
    // as running once.
    const r = await q.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
       VALUES ($1, $2, ARRAY[$3]::uuid[], FALSE, $4::jsonb)
       ON CONFLICT (user_id, landlord_id) DO UPDATE
          SET property_ids = (SELECT ARRAY(SELECT DISTINCT unnest(
                                property_manager_scopes.property_ids || ARRAY[$3]::uuid[]))),
              permissions  = property_manager_scopes.permissions || $4::jsonb,
              updated_at   = NOW()`,
      [person.user_id, args.landlordId, args.propertyId, JSON.stringify(perms)])
    scopes += r.rowCount ?? 0
  }
  return { people: staff.length, scopes }
}

/** What the management company's own owner must be able to do on an engagement GAM routes money under. */
const MANAGING_OWNER_PERMISSIONS = [
  'properties.view', 'units.view', 'leases.view', 'leases.edit', 'tenants.view',
  'maintenance.view', 'maintenance.edit', 'schedule.view', 'schedule.edit_reservation',
  'schedule.create_reservation', 'reports.view', 'documents.view',
] as const

/**
 * Take one property back off a management company's people — the engagement
 * ended, or the owner moved the property to somebody else. Their access to any
 * OTHER property of this owner is untouched, and the membership row goes only
 * when nothing of this owner's is left to them.
 */
export async function revokeManagedAccess(q: Q, args: {
  pmCompanyId: string
  landlordId: string
  propertyId: string
}): Promise<{ people: number }> {
  const staff = (await q.query<{ user_id: string }>(
    `SELECT user_id FROM pm_staff WHERE pm_company_id = $1`, [args.pmCompanyId])).rows
  for (const person of staff) {
    await q.query(
      `UPDATE property_manager_scopes
          SET property_ids = array_remove(property_ids, $3::uuid), updated_at = NOW()
        WHERE user_id = $1 AND landlord_id = $2`,
      [person.user_id, args.landlordId, args.propertyId])
    // Nothing of this owner's left, and the access came through this company:
    // the grant is finished, so it goes rather than lingering as an empty row
    // somebody later reads as "a manager with no properties".
    await q.query(
      `DELETE FROM property_manager_scopes
        WHERE user_id = $1 AND landlord_id = $2
          AND all_properties = FALSE AND cardinality(property_ids) = 0`,
      [person.user_id, args.landlordId])
    await q.query(
      `DELETE FROM landlord_members
        WHERE landlord_id = $1 AND user_id = $2 AND role = 'manager' AND via_pm_company_id = $3
          AND NOT EXISTS (SELECT 1 FROM property_manager_scopes s
                           WHERE s.user_id = $2 AND s.landlord_id = $1)`,
      [args.landlordId, person.user_id, args.pmCompanyId])
  }
  return { people: staff.length }
}

/**
 * Everything one account can act for, and HOW — what the folded portal's
 * company picker is built from. Owned companies and managed ones, each named,
 * because "what did I earn" and "what did I earn managing" are different
 * questions.
 */
export async function companiesForAccount(q: Q, userId: string): Promise<Array<{
  landlordId: string; name: string | null; role: 'owner' | 'manager'; viaPmCompanyId: string | null
}>> {
  // Owned companies come from BOTH places on purpose: landlord_members is the
  // membership record, and landlords.user_id is the founding owner — a company
  // created before memberships existed has only the second, and leaving it out
  // would hide somebody's own park from their own picker.
  const rows = (await q.query<any>(
    `SELECT l.id AS landlord_id, l.business_name,
            CASE WHEN l.user_id = $1 OR bool_or(m.role = 'owner') THEN 'owner' ELSE 'manager' END AS role,
            MAX(m.via_pm_company_id::text) FILTER (WHERE m.role = 'manager') AS via_pm_company_id
       FROM landlords l
       LEFT JOIN landlord_members m ON m.landlord_id = l.id AND m.user_id = $1
      WHERE l.user_id = $1 OR m.user_id = $1
      GROUP BY l.id, l.business_name, l.user_id
      ORDER BY (l.user_id = $1 OR bool_or(m.role = 'owner')) DESC, l.business_name NULLS LAST, l.id`,
    [userId])).rows
  return rows.map(r => ({
    landlordId: r.landlord_id,
    name: r.business_name ?? null,
    role: r.role,
    viaPmCompanyId: r.via_pm_company_id ?? null,
  }))
}
