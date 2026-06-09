/**
 * S214: addendum-event actor resolution. Resolves user IDs stored
 * on `lease_addendum_recorded` event_data to display strings used
 * by the S210 (tenant) and S211 (landlord) addendum-history
 * surfaces.
 *
 * Two flavors, because the tenant and landlord views need different
 * fidelity:
 *   - Tenant side: just a display name. Internal role distinction
 *     between owner / PM / GAM admin doesn't help them.
 *   - Landlord side: name + role context. Owners want to know
 *     whether they recorded it themselves or someone on their team
 *     did, and which team role.
 *
 * Role determination, ordered:
 *   - 'owner'      — user_id matches landlords.user_id for the
 *                    lease's landlord_id (the operator themselves)
 *   - 'gam_admin'  — users.role in ('admin', 'super_admin')
 *   - 'pm'         — has a property_manager_scopes row for this
 *                    landlord_id
 *   - 'team'       — fallback for other scoped roles (maintenance,
 *                    onsite manager) that may evolve later
 *   - 'unknown'    — user_id doesn't resolve (deleted user / null)
 */

import { query, queryOne } from '../db'

export type AddendumActorRole = 'owner' | 'gam_admin' | 'pm' | 'team' | 'unknown'

export interface AddendumActor {
  user_id: string | null
  name:    string
  role:    AddendumActorRole
}

const ROLE_LABEL: Record<AddendumActorRole, string> = {
  owner:     'Owner',
  gam_admin: 'GAM Admin',
  pm:        'Property Manager',
  team:      'Team',
  unknown:   '—',
}

export function addendumActorRoleLabel(role: AddendumActorRole): string {
  return ROLE_LABEL[role] ?? '—'
}

/**
 * Resolve a single user_id to a display string + role context.
 * Returns { name: '(unknown)', role: 'unknown' } if user_id is null
 * or doesn't resolve to a users row.
 */
export async function resolveAddendumActor(
  userId:     string | null | undefined,
  landlordId: string,
): Promise<AddendumActor> {
  if (!userId) {
    return { user_id: null, name: '(unknown)', role: 'unknown' }
  }
  const u = await queryOne<{
    id:         string
    first_name: string
    last_name:  string
    role:       string
  }>(
    'SELECT id, first_name, last_name, role FROM users WHERE id = $1',
    [userId],
  )
  if (!u) {
    return { user_id: userId, name: '(unknown user)', role: 'unknown' }
  }
  const name = `${u.first_name} ${u.last_name}`.trim()

  // 1. Owner check
  const owner = await queryOne<{ user_id: string }>(
    'SELECT user_id FROM landlords WHERE id = $1',
    [landlordId],
  )
  if (owner && owner.user_id === u.id) {
    return { user_id: u.id, name, role: 'owner' }
  }

  // 2. GAM admin check
  if (u.role === 'admin' || u.role === 'super_admin') {
    return { user_id: u.id, name, role: 'gam_admin' }
  }

  // 3. PM scope check
  const pm = await queryOne<{ id: string }>(
    'SELECT id FROM property_manager_scopes WHERE user_id = $1 AND landlord_id = $2 LIMIT 1',
    [u.id, landlordId],
  )
  if (pm) {
    return { user_id: u.id, name, role: 'pm' }
  }

  // 4. Fallback (other scoped roles or unscoped — should be rare)
  return { user_id: u.id, name, role: 'team' }
}

/**
 * Resolve an array of tenant_id → display name. Used by the
 * landlord-side addendums endpoint to surface "who's on this row"
 * attribution. Returns names in the same order as the input array;
 * unresolvable IDs become '(unknown)'.
 */
export async function resolveTenantNames(tenantIds: string[]): Promise<string[]> {
  if (tenantIds.length === 0) return []
  const rows = await query<{ id: string; name: string }>(`
    SELECT t.id,
           u.first_name || ' ' || u.last_name AS name
      FROM tenants t
      JOIN users   u ON u.id = t.user_id
     WHERE t.id = ANY($1::uuid[])`,
    [tenantIds],
  )
  const byId = new Map<string, string>()
  for (const r of rows) byId.set(r.id, r.name)
  return tenantIds.map(id => byId.get(id) ?? '(unknown)')
}
