import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { UserRole, LandlordAssignableRole } from '@gam/shared'
import { query } from '../db'
import { AppError } from './errorHandler'
import { isPosLimitedRequestAllowed } from '../lib/posLock'

export interface AuthPayload {
  userId:      string
  role:        UserRole
  email:       string
  profileId:   string
  landlordId?: string | null
  // S553: multi-owner entities — ALL landlord entities this user is an
  // owner-member of (landlord_members), resolved at login. profileId stays
  // the founding/primary entity; scope checks accept any id in this list.
  // Membership changes take effect at next login/refresh.
  landlordIds?: string[] | null
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
  // S574: true on a POS cashier session minted by the terminal lock screen.
  // requireAuth constrains such sessions to the register surface (see
  // isPosLimitedRequestAllowed). Absent/false on every normal session.
  posLimited?: boolean
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' })
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload
    // S560 (CRITICAL): reject any purpose-scoped token (e.g. the
    // `totp_pending` session minted by /login before the 2nd factor). Such
    // tokens carry the real role/permissions but must NEVER be accepted as a
    // full session — only the specific endpoint that expects them (e.g.
    // /totp/verify) checks the positive `purpose`. Without this guard the
    // pending token is a full session everywhere and /refresh would upgrade
    // it to a 7-day token — a complete 2FA bypass.
    if ((payload as any).purpose) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' })
    }
    // S574: a posLimited cashier session (minted by the POS terminal lock
    // screen) is a real session but capability-locked to the register surface.
    // Deny-by-default everywhere else so a cashier can never reach reports,
    // settings, banking, or any sensitive endpoint with a passcode-only session.
    if ((payload as any).posLimited && !isPosLimitedRequestAllowed(req.method, req.originalUrl)) {
      return res.status(403).json({ success: false, error: 'This action requires a full sign-in, not a register passcode.' })
    }
    req.user = payload
    // S629 (CRITICAL) — ENTITY MEMBERSHIP IS REFRESHED FROM THE DATABASE.
    //
    // `landlordIds` is minted at login and then frozen for the life of the
    // token. Create an entity after logging in and every one of the ~241
    // synchronous scope checks denies it, because they all read the token.
    //
    // What that looked like in production: a landlord signed up on the 24th,
    // created "TruBlu Management LLC" on the 28th, and could not save a
    // property under it. When the create path was fixed, the property saved —
    // and the very next request, the redirect to view it, came back 403. He
    // retried, hit 409 duplicate, and reported that it "still would not save".
    // From his side the product created something invisible and then told him
    // it already existed.
    //
    // Fixing individual call sites cannot work: there are 241 of them and the
    // next one is a bug waiting. The token is refreshed HERE instead, so every
    // check downstream sees current membership without becoming async.
    //
    // Cached briefly per user — one indexed lookup per user per TTL, not per
    // request. This can only ADD entities the user genuinely belongs to; the
    // token's own claims are never widened by it.
    if (payload.role === 'landlord' && payload.userId) {
      try {
        req.user = { ...payload, landlordIds: await currentLandlordIds(payload) }
      } catch { /* the token's own list still stands */ }
    }
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
// Used for platform-staff-only operations like NACHA monitoring.
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: 'super_admin required' })
  }
  next()
}

// S567: the platform OWNER only. System Features (feature-flag toggles) is
// locked to this single account so no other admin can flip a flag by accident.
export const OWNER_EMAIL = process.env.OWNER_EMAIL || 'nic@golddoor.io'
export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (req.user.email !== OWNER_EMAIL) {
    return res.status(403).json({ success: false, error: 'Owner only' })
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

/**
 * S629: entity membership, read fresh and cached briefly.
 *
 * TTL is deliberately short. The failure it prevents is a person unable to use
 * something they just made; the cost of being a few seconds stale is that they
 * wait a few seconds. Removing an owner is the direction that matters for
 * safety, and that is bounded by the same TTL.
 */
const MEMBERSHIP_TTL_MS = 15_000
const membershipCache = new Map<string, { ids: string[]; at: number }>()

export function _clearMembershipCache(): void { membershipCache.clear() }

async function currentLandlordIds(payload: AuthPayload): Promise<string[]> {
  const key = payload.userId
  const hit = membershipCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < MEMBERSHIP_TTL_MS) return hit.ids
  const rows = await query<{ landlord_id: string }>(
    `SELECT landlord_id FROM landlord_members WHERE user_id = $1`, [payload.userId])
  // The token's own profileId still counts — a landlord with no membership row
  // (older accounts predating S553) must not lose their own book.
  const ids = Array.from(new Set([
    ...(payload.landlordIds ?? []),
    ...(payload.profileId ? [payload.profileId] : []),
    ...rows.map((r) => r.landlord_id),
  ].filter(Boolean))) as string[]
  membershipCache.set(key, { ids, at: now })
  if (membershipCache.size > 5000) membershipCache.clear()
  return ids
}
