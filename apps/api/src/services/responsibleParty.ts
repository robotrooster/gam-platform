/**
 * S183: Property responsibility resolver.
 *
 * Single source of truth for "who gets pinged about this property?"
 * Canonical answer for notification routing + dashboard todos filtering.
 *
 * Resolution priority per property:
 *   1. If properties.pm_company_id IS NOT NULL (or landlord default
 *      via getPmCompanyForProperty) → primaries are all active pm_staff
 *      for that company (multi-user fan-out). Owner is escalation only.
 *   2. Else if properties.managed_by_user_id !== owner_user_id → primary
 *      is the delegated individual user. Owner is escalation only.
 *   3. Else → primary is the owner. Self-managed; escalation == primary.
 *
 * Why this exists: pre-S183 the four landlord-facing notification call
 * sites (notifyLeaseExpiring, notifyRentCollected, notifyLowStock,
 * routeMaintenanceNotification) all resolved their recipient as the
 * landlord owner via `landlords.user_id`, ignoring the per-property
 * delegation pointers. Owners who delegated property management still
 * got every routine ping. This resolver unifies the routing decision so
 * all consumers honor the same rules; the call sites loop over the
 * primaries returned and fire one notification per recipient.
 *
 * Note: routeMaintenanceNotification (services/notifications.ts:642)
 * pre-dates this resolver and implements the responsible-party fan-out
 * directly via property_manager_scopes + pm_staff. That existing pattern
 * is the reference shape; this resolver formalizes it for the other
 * call sites without re-plumbing the maintenance one. A future refactor
 * could route maintenance through this resolver too, but the existing
 * code is correct as-is.
 */

import { query, queryOne } from '../db'
import { getPmCompanyForProperty } from './pm'

export interface ResponsiblePartyContact {
  user_id: string
  email:   string
  phone:   string | null
}

export interface PropertyResponsibleParty {
  /**
   * Day-to-day responsible recipients. Loop and fire one notification
   * per user. For self-managed properties this is just the owner;
   * for individual-delegated it's the manager; for PM-company-managed
   * it's every active staff member of the company.
   */
  primaries: ResponsiblePartyContact[]

  /**
   * The owner. Always returned (never null) — used for escalation
   * (over-threshold approvals, financial-control decisions, etc.)
   * and as a fallback when primaries comes back empty (e.g. PM
   * company assigned but every staff member inactive).
   */
  owner: ResponsiblePartyContact

  /**
   * True when day-to-day responsibility is delegated away from the
   * owner. Useful for call sites that want to suppress informational
   * pings to owner when delegated, but still escalate over-threshold
   * decisions to owner.
   */
  is_delegated: boolean

  /**
   * One of:
   *   'self_managed'     — owner == manager, no PM company
   *   'individual'       — managed_by_user_id is a delegated individual
   *   'pm_company'       — pm_company_id is set (property-level or
   *                        landlord default)
   */
  kind: 'self_managed' | 'individual' | 'pm_company'
}

/**
 * Resolve who gets notified about events at a property.
 *
 * Returns null when the property doesn't exist.
 */
export async function getPropertyResponsibleParty(
  propertyId: string,
): Promise<PropertyResponsibleParty | null> {
  const prop = await queryOne<{
    owner_user_id:      string
    managed_by_user_id: string
    pm_company_id:      string | null
  }>(
    `SELECT owner_user_id, managed_by_user_id, pm_company_id
       FROM properties
      WHERE id = $1`,
    [propertyId],
  )
  if (!prop) return null

  const ownerRow = await queryOne<ResponsiblePartyContact>(
    `SELECT id AS user_id, email, phone FROM users WHERE id = $1`,
    [prop.owner_user_id],
  )
  if (!ownerRow) return null  // FK violation; should not happen

  // 1. PM company path — fan out to all active staff of the resolved
  //    company (property-level override OR landlord default per
  //    services/pm.ts).
  const pmRes = await getPmCompanyForProperty(propertyId)
  if (pmRes.pm_company_id) {
    const staff = await query<ResponsiblePartyContact>(
      `SELECT u.id AS user_id, u.email, u.phone
         FROM pm_staff ps
         JOIN users u ON u.id = ps.user_id
        WHERE ps.pm_company_id = $1
          AND ps.status = 'active'
        ORDER BY ps.role  -- owner > manager > staff (alpha sort matches priority)`,
      [pmRes.pm_company_id],
    )
    return {
      primaries:    staff,
      owner:        ownerRow,
      is_delegated: true,
      kind:         'pm_company',
    }
  }

  // 2. Individual delegation — managed_by_user_id ≠ owner_user_id.
  if (prop.managed_by_user_id !== prop.owner_user_id) {
    const managerRow = await queryOne<ResponsiblePartyContact>(
      `SELECT id AS user_id, email, phone FROM users WHERE id = $1`,
      [prop.managed_by_user_id],
    )
    return {
      primaries:    managerRow ? [managerRow] : [],
      owner:        ownerRow,
      is_delegated: true,
      kind:         'individual',
    }
  }

  // 3. Self-managed.
  return {
    primaries:    [ownerRow],
    owner:        ownerRow,
    is_delegated: false,
    kind:         'self_managed',
  }
}
