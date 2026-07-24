// S552 (Nic): find every staff member holding a given permission for a
// property — so operational notifications (e.g. a booking change the agent
// auto-approved) reach the people actually RUNNING the front counter, not
// just the owner who'd have to relay it. Unions the three staff scope
// tables (property managers, on-site managers, maintenance workers); a row
// qualifies when its permissions jsonb has ANY of the keys true and its
// property scope covers the property (all_properties or listed).
//
// keys come from CODE (shared permission catalog), never user input — they
// are interpolated as jsonb path literals after a strict format check.

import { query } from '../db'

export interface StaffContact {
  user_id: string
  email: string
}

export async function findStaffWithPermission(
  landlordId: string,
  propertyId: string | null,
  keys: string[]
): Promise<StaffContact[]> {
  const safeKeys = keys.filter((k) => /^[a-z0-9_.]+$/i.test(k))
  if (safeKeys.length === 0) return []
  const permCond = safeKeys.map((k) => `s.permissions->>'${k}' = 'true'`).join(' OR ')
  const scopes = ['property_manager_scopes', 'onsite_manager_scopes', 'maintenance_worker_scopes']
  const union = scopes
    .map(
      (t) => `SELECT s.user_id FROM ${t} s
               WHERE s.landlord_id = $1
                 AND (s.all_properties = TRUE OR $2::uuid IS NULL OR $2 = ANY(s.property_ids))
                 AND (${permCond})`
    )
    .join(' UNION ')
  return query<StaffContact>(
    `SELECT DISTINCT u.id AS user_id, u.email
       FROM (${union}) hits
       JOIN users u ON u.id = hits.user_id`,
    [landlordId, propertyId]
  )
}
