import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { UserRole, LandlordAssignableRole } from '@gam/shared'

export interface AuthPayload {
  userId:      string
  role:        UserRole
  email:       string
  profileId:   string
  landlordId?: string | null
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
  const perms = req.user.permissions || {}
  if (req.user.role === 'bookkeeper' && perms.access_level === 'read_write') return next()
  if (req.user.role === 'property_manager' && perms['books.edit'] === true) return next()
  return res.status(403).json({ success: false, error: 'Insufficient permissions' })
}
