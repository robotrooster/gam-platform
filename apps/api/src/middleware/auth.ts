import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { UserRole, LandlordAssignableRole } from '@gam/shared'
import { query } from '../db'
import { AppError } from './errorHandler'

export interface AuthPayload {
  userId:      string
  role:        UserRole
  email:       string
  profileId:   string
  landlordId?: string | null
  // S453: business-side scope. Set for business_owner (resolved at
  // login from businesses.owner_user_id) and for business_staff
  // (resolved from business_users at login via getScopeForUser).
  // Null for any non-business role. staffRole carries the per-business
  // position so the business portal can gate driver-only vs
  // dispatcher-only screens without a DB hit on every request.
  businessId?: string | null
  staffRole?:  string | null
  // S81: heterogeneous shape — sub-permission keys are boolean,
  // bookkeeper's access_level is 'read_only' | 'read_write'. Widened
  // from Record<string, boolean> so requireBooksRead/Write can read
  // the string-valued access_level without a cast.
  permissions?: Record<string, boolean | string> | null
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' })
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' })
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' })
    }
    next()
  }
}

export const requireAdmin    = requireRole('admin', 'super_admin')
export const requireLandlord = requireRole('admin', 'super_admin', 'landlord')
export const requireTenant   = requireRole('admin', 'super_admin', 'tenant')

// super_admin is stricter than admin — only super_admin passes, not admin.
// Used for platform-staff-only operations like the bulletin board moderation.
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: 'super_admin required' })
  }
  next()
}

// Landlord-assignable role wrappers. Also allow admin/super_admin/landlord
// for oversight — landlords need to be able to hit these endpoints to
// manage their scoped users.
export function requireLandlordAssignableRole(...roles: LandlordAssignableRole[]) {
  return requireRole('admin', 'super_admin', 'landlord', ...roles)
}

export const requirePropertyManager = requireLandlordAssignableRole('property_manager')
export const requireOnsiteManager   = requireLandlordAssignableRole('onsite_manager')
export const requireMaintenance     = requireLandlordAssignableRole('maintenance')
export const requireBookkeeper      = requireLandlordAssignableRole('bookkeeper')

// Owner roles bypass every sub-permission check. They represent the
// landlord (and platform staff acting on the landlord's behalf), so by
// definition they hold every permission within their scope.
const OWNER_ROLES: UserRole[] = ['admin', 'super_admin', 'landlord']

// Worker roles that carry a property scope (property_ids + all_properties).
// Fixed whitelist — the value is interpolated into SQL below, so it must
// never come from user input.
const WORKER_SCOPE_TABLE: Record<string, string> = {
  property_manager: 'property_manager_scopes',
  onsite_manager:   'onsite_manager_scopes',
  maintenance:      'maintenance_worker_scopes',
}

// Property-scope guard. Owners (admin/super_admin/landlord) bypass. A scoped
// worker may only act on a property in their scope: all_properties=true grants
// every property; otherwise the target propertyId must be in property_ids.
// Read fresh from the scope table (not the JWT) so an owner's scope change
// takes effect on the next request — same posture as /me re-fetching perms,
// and it avoids threading property scope through the login/TOTP/refresh chain.
export async function assertPropertyInScope(
  user: AuthPayload | undefined,
  propertyId: string | null | undefined,
): Promise<void> {
  if (!user) throw new AppError(401, 'Unauthenticated')
  if (OWNER_ROLES.includes(user.role)) return
  const table = WORKER_SCOPE_TABLE[user.role]
  if (!table) throw new AppError(403, 'Not authorized for property-scoped actions')
  const rows = await query<{ property_ids: string[]; all_properties: boolean }>(
    `SELECT property_ids, all_properties FROM ${table} WHERE user_id = $1 LIMIT 1`,
    [user.userId],
  )
  const row = rows[0]
  if (!row) throw new AppError(403, 'No property scope assigned')
  if (row.all_properties) return
  if (!propertyId) throw new AppError(400, 'A property must be selected for this action')
  if (!row.property_ids.includes(propertyId)) throw new AppError(403, 'You are not assigned to this property')
}

// Read-side companion to assertPropertyInScope: which properties may this
// caller SEE? Returns null when unrestricted (owners, all_properties, or a
// role with no property scope table — e.g. bookkeeper, whose reads are gated
// elsewhere); otherwise the property_ids array from the caller's scope row
// (empty array = sees nothing, same lockdown posture as the POS guard).
// List endpoints splice it in as: AND ($n::uuid[] IS NULL OR x.property_id = ANY($n)).
export async function getScopedPropertyIds(
  user: AuthPayload | undefined,
): Promise<string[] | null> {
  if (!user) throw new AppError(401, 'Unauthenticated')
  if (OWNER_ROLES.includes(user.role)) return null
  const table = WORKER_SCOPE_TABLE[user.role]
  if (!table) return null
  const rows = await query<{ property_ids: string[] | null; all_properties: boolean }>(
    `SELECT property_ids, all_properties FROM ${table} WHERE user_id = $1 LIMIT 1`,
    [user.userId],
  )
  const row = rows[0]
  if (!row) return []
  if (row.all_properties) return null
  return row.property_ids || []
}

// requirePerm — gate a worker route by sub-permission key. Owner roles
// always pass. Worker roles pass if JWT.permissions[key] === true for
// any of the listed keys (OR semantics — useful when a single endpoint
// can be reached by either of two perms, e.g. read endpoints).
//
// Sub-permission keys come from packages/shared SUB_PERMISSIONS_BY_ROLE.
// Absent / false / non-true value = denied.
export function requirePerm(...keys: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
    if (OWNER_ROLES.includes(req.user.role)) return next()
    const perms = req.user.permissions || {}
    for (const k of keys) if (perms[k] === true) return next()
    return res.status(403).json({ success: false, error: 'Insufficient permissions' })
  }
}

// Bookkeeper-specific gates. Bookkeepers don't have sub-permissions —
// they have access_level (read_only | read_write) packed into the
// permissions claim by getScopeForUser. Owner roles always pass.
// Property managers with books.view / books.edit also pass — books
// access overlaps both roles.
export function requireBooksRead(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (OWNER_ROLES.includes(req.user.role)) return next()
  // S459: a business_owner has full authority over their own company's
  // books (the GAM Books engine is reused by business customers, scoped
  // by business_id). Must carry a businessId to be scoped.
  if (req.user.role === 'business_owner' && req.user.businessId) return next()
  const perms = req.user.permissions || {}
  if (req.user.role === 'bookkeeper') {
    if (perms.access_level === 'read_only' || perms.access_level === 'read_write') return next()
  }
  if (req.user.role === 'property_manager' && perms['books.view'] === true) return next()
  return res.status(403).json({ success: false, error: 'Insufficient permissions' })
}

export function requireBooksWrite(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (OWNER_ROLES.includes(req.user.role)) return next()
  if (req.user.role === 'business_owner' && req.user.businessId) return next()
  const perms = req.user.permissions || {}
  if (req.user.role === 'bookkeeper' && perms.access_level === 'read_write') return next()
  if (req.user.role === 'property_manager' && perms['books.edit'] === true) return next()
  return res.status(403).json({ success: false, error: 'Insufficient permissions' })
}
