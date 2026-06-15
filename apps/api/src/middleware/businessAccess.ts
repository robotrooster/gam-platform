/**
 * S502 — unified business-access helper for the GAM-for-Business portal.
 *
 * Replaces the per-file `requireOwnerBusinessId` helpers scattered
 * across the business routes. Single entry point for:
 *
 *   1. Resolving the active businessId from the requester
 *      (owner: lookup by owner_user_id; staff: from JWT.businessId)
 *   2. Checking that the requested feature is enabled on the business
 *      (e.g. 'invoicing' — surfaces a "feature not enabled" 403)
 *   3. Checking that staff has the required permission
 *      (e.g. 'invoices.write' — surfaces a "missing permission" 403)
 *
 * Owners always pass (full access). The staff token must carry
 * `businessId` (set at login by the staff auth path); the helper does a
 * fresh DB read each call to pick up live permission changes without
 * waiting for the next login.
 *
 * Usage:
 *
 *   const { businessId } = await requireBusinessAccess(req, {
 *     permission: 'invoices.write',
 *     feature:    'invoicing',
 *   })
 *
 * Owner-only operations (settings, banking, staff management) should
 * NOT use this helper — they should keep their existing
 * `if (req.user!.role !== 'business_owner')` check.
 */

import { queryOne } from '../db'
import { AppError } from './errorHandler'
import { BusinessStaffPermission, BUSINESS_STAFF_PERMISSIONS } from '@gam/shared'

interface BusinessAccessOptions {
  permission?: BusinessStaffPermission
  feature?: string
  // When true, owner-only path: staff with any permission still gets 403.
  // Useful for endpoints that touch settings / billing / banking.
  ownerOnly?: boolean
}

export interface BusinessAccessResult {
  businessId: string
  role: 'business_owner' | 'business_staff'
  permissions: BusinessStaffPermission[]
  enabledFeatures: string[]
  // The staff_users row id (NULL for owners) — useful for "who did this"
  // audit on writes.
  staffUserRowId: string | null
}

export async function requireBusinessAccess(
  req: any,
  opts: BusinessAccessOptions = {}
): Promise<BusinessAccessResult> {
  const role = req.user!.role

  // Owner path: full access modulo feature gating.
  if (role === 'business_owner') {
    if (opts.ownerOnly === undefined && opts.permission === undefined && opts.feature === undefined) {
      // No constraints supplied — just resolve the businessId.
    }
    const biz = await queryOne<{ id: string; enabled_features: string[] }>(
      `SELECT id, enabled_features FROM businesses
        WHERE owner_user_id = $1 AND status IN ('active', 'suspended')
        ORDER BY created_at DESC LIMIT 1`,
      [req.user!.userId])
    if (!biz) throw new AppError(404, 'No active business for this owner')
    if (opts.feature && !biz.enabled_features.includes(opts.feature)) {
      throw new AppError(403, `${prettyFeature(opts.feature)} is not enabled for this business. Enable in Settings → Features.`)
    }
    return {
      businessId: biz.id,
      role: 'business_owner',
      permissions: [...BUSINESS_STAFF_PERMISSIONS], // owner = full set
      enabledFeatures: biz.enabled_features,
      staffUserRowId: null,
    }
  }

  // Staff path.
  if (role !== 'business_staff') {
    throw new AppError(403, 'Not authorized for the business portal')
  }
  if (opts.ownerOnly) {
    throw new AppError(403, 'Owner-only operation')
  }

  // JWT carries businessId for staff (set during business-staff login).
  const businessId = req.user!.businessId
  if (!businessId) {
    throw new AppError(403, 'Staff token missing business context')
  }

  const staff = await queryOne<{
    row_id: string;
    permissions: unknown;
    status: string;
    enabled_features: string[];
  }>(
    `SELECT bu.id AS row_id,
            bu.permissions,
            bu.status,
            b.enabled_features
       FROM business_users bu
       JOIN businesses b ON b.id = bu.business_id
      WHERE bu.user_id = $1 AND bu.business_id = $2`,
    [req.user!.userId, businessId])
  if (!staff) throw new AppError(403, 'Not a member of this business')
  if (staff.status !== 'active') throw new AppError(403, 'Staff account is not active')

  // permissions column is jsonb — normalize to string[] tolerating the
  // legacy `{}` shape (pre-S502 backfill) → treat as empty list.
  let perms: BusinessStaffPermission[] = []
  if (Array.isArray(staff.permissions)) {
    perms = (staff.permissions as string[]).filter(
      (p): p is BusinessStaffPermission => (BUSINESS_STAFF_PERMISSIONS as readonly string[]).includes(p))
  }

  if (opts.feature && !staff.enabled_features.includes(opts.feature)) {
    throw new AppError(403, `${prettyFeature(opts.feature)} is not enabled for this business.`)
  }
  if (opts.permission && !perms.includes(opts.permission)) {
    throw new AppError(403, `Missing permission: ${opts.permission}. Ask your owner to grant access on the Staff page.`)
  }

  return {
    businessId,
    role: 'business_staff',
    permissions: perms,
    enabledFeatures: staff.enabled_features,
    staffUserRowId: staff.row_id,
  }
}

function prettyFeature(f: string): string {
  // Map a few common features to their UI labels; falls back to the raw
  // key so a new feature shows up readably even without an entry.
  const map: Record<string, string> = {
    customers:           'Customers',
    staff:               'Staff',
    recurring_schedules: 'Recurring Schedules',
    appointments:        'Appointments',
    routing:             'Routes & Fleet',
    pos:                 'POS',
    inventory:           'Inventory',
    work_orders:         'Work Orders',
    customer_vehicles:   'Vehicle tracking',
    invoicing:           'Invoicing',
    payments:            'Payments',
    quotes:              'Quotes',
  }
  return map[f] ?? f
}
