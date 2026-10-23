import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { UserRole, LandlordAssignableRole } from '@gam/shared'
import { query, queryOne } from '../db'
import { AppError } from './errorHandler'
import { isPosLimitedRequestAllowed } from '../lib/posLock'
import {
  isBookkeeperRequestAllowed, bookkeeperResponseIsScrubbed, scrubPersonFields,
  BOOKKEEPER_REFUSAL, bookkeeperHasPerm,
} from '../lib/bookkeeperAccess'
import {
  bookkeeperScopesOf, requestScopeOf, NO_BOOKKEEPER_SCOPE, bookkeeperMayWrite,
  type BookkeeperScopeRow, type BookkeeperRequestScope, type PropertyCutoff,
} from '../lib/bookkeeperScope'

export interface AuthPayload {
  userId:      string
  role:        UserRole
  email:       string
  // S633: NULL for role=landlord. An account is not an entity, so a landlord
  // session names no `landlords` row — see routes/auth.ts. For every other role
  // this is still the one profile row that genuinely is one-to-one with the
  // user (tenant, business). Typed nullable ON PURPOSE: it is what makes the
  // compiler point at any landlord-scoping site still reading it, instead of
  // that site quietly filtering on undefined and returning nothing.
  profileId:   string | null
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
  // 10/11 (Nic): a bookkeeper's properties within their company, worked out
  // fresh by requireAuth on every request (lib/bookkeeperScope). 10/12: with
  // the company-wide box, the lease-dates box and the former properties (read
  // up to the day they left, never after). Absent on every other role.
  bookkeeperScope?: BookkeeperRequestScope
  // S655: 'fixed' — ends SESSION_TTL_SECONDS after sign-in, never extended;
  // 'rolling' — renewed while in use. Absent on a pass minted before S655 (read
  // through policyOfPass in lib/sessionToken.ts). Type only: requireAuth does
  // not enforce it; jwt.verify already enforces exp, and /auth/refresh refuses
  // to extend a fixed pass.
  sp?: 'fixed' | 'rolling'
  // Standard JWT times, present on every verified pass.
  iat?: number
  exp?: number
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
    // 10/5 — a pass minted before the account's sessions_valid_from is dead on
    // EVERY route, not only at /auth/me and /auth/refresh. A password reset, a
    // retired account and a reset applicant all stamp that column; before this,
    // the old pass kept working on every other endpoint until it expired or the
    // portal happened to reload. Whole-second compare: iat is whole seconds and
    // the invite activation stamps the column and mints the new pass in the
    // same request (see assertPassPostdatesPasswordChange in routes/auth.ts).
    if (payload.userId && typeof payload.iat === 'number') {
      const cutoffMs = await sessionCutoffMs(payload.userId)
      if (cutoffMs !== null && payload.iat < Math.floor(cutoffMs / 1000)) {
        return res.status(401).json({ success: false, error: 'Your session has ended. Please sign in again.' })
      }
    }
    req.user = payload
    // 10/11 (Nic): a bookkeeper sees money in and who paid it (tenant names
    // included), money out, receipts, maintenance costs and (10/12, with the
    // company-wide box) the bank account, payouts and payroll — never
    // contact details, leases, documents, screening or messages. Deny by
    // default, the cashier's rule
    // (lib/bookkeeperAccess.ts), then pin the request to their company and
    // properties as the scope table says NOW (a revoke or a narrowed scope
    // takes effect on the next request, not at the next sign-in).
    if (payload.role === 'bookkeeper') {
      if (!isBookkeeperRequestAllowed(req.method, req.originalUrl)) {
        return res.status(403).json({ success: false, error: BOOKKEEPER_REFUSAL })
      }
      const scoped = await bookkeeperScopeFor(payload, req.headers['x-client-id'])
      // Their own sign-in, and the list of clients they keep, answer even when
      // Books remembers a company they no longer keep: the client list is how
      // they pick again, so refusing it would strand them with no switcher.
      const path = (req.originalUrl || '').split('?')[0]
      const pickAgain = /^\/api\/auth(\/|$)/.test(path) || /^\/api\/books\/bookkeeper\/clients\/?$/.test(path)
      if (scoped === 'not_theirs' && !pickAgain) {
        return res.status(403).json({ success: false, error: 'You are not assigned to that company\'s books.' })
      }
      const row = scoped === 'not_theirs' ? null : scoped
      req.user = {
        ...payload,
        landlordId: row?.landlord_id ?? null,
        bookkeeperScope: row ? requestScopeOf(row) : NO_BOOKKEEPER_SCOPE,
        // 10/12 (Nic) review, SECURITY: the read-only / read-write box is the
        // one on THIS company's scope row, read now. The pass carries the
        // access level of their oldest assignment from sign-in, so read-write
        // on one company opened another's bank and expenses to writes, and a
        // downgrade waited for the next sign-in. Every gate that reads
        // permissions.access_level (requireBooksWrite, the bank feed, the
        // Expenses writes) now reads the live value.
        ...(row ? { permissions: { ...(payload.permissions || {}), access_level: row.access_level } } : {}),
      }
      if (bookkeeperResponseIsScrubbed(req.originalUrl)) {
        const send = res.json.bind(res)
        res.json = (body: any) => send(scrubPersonFields(body))
      }
      return next()
    }
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
      // S652: a landlord GAM cannot collect from loses the portal until they
      // sort it out. Checked here so it covers every endpoint at once rather
      // than being remembered at a few hundred call sites.
      const locked = await lockedLandlordFor(req.user!)
      if (locked && !isLockEscapeRoute(req.method, req.originalUrl)) {
        return res.status(402).json({
          success: false,
          error: 'Your account is on hold. Please contact GAM support to restore access.',
          code: 'ACCOUNT_LOCKED',
          lockedReason: locked.reason,
        })
      }
    }
    next()
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' })
  }
}

/**
 * 10/11: the bookkeeper_scopes row a bookkeeper's request acts under.
 *
 * GAM Books names the company with X-Client-Id (a bookkeeper may keep more
 * than one client's books there); a header naming a company they do not keep
 * is 'not_theirs'. With no header: the company on their pass, else their
 * oldest assignment. null = no assignment at all (they see nothing).
 */
async function bookkeeperScopeFor(
  payload: AuthPayload,
  header: string | string[] | undefined,
): Promise<BookkeeperScopeRow | null | 'not_theirs'> {
  const named = Array.isArray(header) ? header[0] : header
  // 10/11: their ticked properties, worked out against what the company owns
  // right now (lib/bookkeeperScope), never read raw off the row.
  const rows = await bookkeeperScopesOf(payload.userId)
  if (named) return rows.find(r => r.landlord_id === named) ?? 'not_theirs'
  return rows.find(r => r.landlord_id === payload.landlordId) ?? rows[0] ?? null
}

/**
 * S652 — the handful of things a locked-out landlord may still do.
 *
 * A lock whose only remedy sits BEHIND the lock is a deadlock, and the fastest
 * way to turn a collections problem into a support ticket. So the routes that
 * FIX it stay open: linking a bank, reading who you are, and signing out. Their
 * own data — tenants, rent, reports, settings, the register — does not.
 *
 * Deliberately a short, explicit list rather than a pattern. Every addition to
 * it is somebody deciding that a locked account may do one more thing.
 */
const LOCK_ESCAPE_ROUTES: Array<{ method: string; test: RegExp }> = [
  // Who am I, and am I locked — the portal needs this to draw the lock screen.
  { method: 'GET',  test: /^\/api\/auth\/me\b/ },
  { method: 'POST', test: /^\/api\/auth\/logout\b/ },
  { method: 'POST', test: /^\/api\/auth\/refresh\b/ },
  // The remedy: connect a bank GAM can actually collect from.
  { method: 'GET',  test: /^\/api\/bank-feed\b/ },
  { method: 'POST', test: /^\/api\/bank-feed\b/ },
  // What they owe, so the number on the lock screen is not a mystery.
  { method: 'GET',  test: /^\/api\/landlords\/me\/gam-charges\b/ },
]

export function isLockEscapeRoute(method: string, url: string): boolean {
  const path = (url || '').split('?')[0]
  return LOCK_ESCAPE_ROUTES.some((r) => r.method === method.toUpperCase() && r.test.test(path))
}

/**
 * Is every company this session can act for locked?
 *
 * ALL, not any: an account with two parks, one of them settled, is not locked
 * out of the settled one. The scope checks downstream already keep them out of
 * the locked company's data.
 */
export async function lockedLandlordFor(
  user: AuthPayload,
): Promise<{ reason: string | null } | null> {
  const ids = (user.landlordIds ?? []).filter(Boolean)
  if (!ids.length) return null
  const rows = await query<{ platform_locked_at: string | null; platform_locked_reason: string | null }>(
    `SELECT platform_locked_at, platform_locked_reason FROM landlords WHERE id = ANY($1::uuid[])`,
    [ids])
  if (!rows.length) return null
  if (!rows.every((r) => r.platform_locked_at)) return null
  return { reason: rows[0].platform_locked_reason ?? null }
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

/**
 * S631: is this user THE platform owner — the one account that cannot be
 * deleted or downgraded, and the only one that may create super admins.
 *
 * Matched on user id via the platform_owner table, NOT on an email string. The
 * old check compared req.user.email to OWNER_EMAIL, which was a live bug rather
 * than a theoretical one: GAM has an email-change flow, and Nic moved his own
 * login off the Oak Park address the same day this was written. Under the string
 * match, changing his email would have silently stripped his own owner powers —
 * and granted them to whoever next registered the old address.
 *
 * Fails CLOSED. A database error answers "not the owner", so a blip denies a
 * privileged action rather than handing it out.
 */
export async function isPlatformOwner(
  userId: string | undefined,
  email?: string | null,
): Promise<boolean> {
  if (!userId) return false
  try {
    const row = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM platform_owner WHERE user_id = $1`, [userId])
    if (row) return true
    // BOOTSTRAP ONLY. A platform_owner row cannot be deleted (the table's own
    // trigger refuses it), so an EMPTY table means one was never established —
    // a fresh deployment or a test database, not a tampered production one.
    // There, and only there, the OWNER_EMAIL constant still names the owner, so
    // a new environment is never ownerless. The moment a row exists this branch
    // is unreachable and identity is the account id alone.
    const anyOwner = await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM platform_owner`)
    if (Number(anyOwner?.n ?? 0) === 0) return !!email && email === OWNER_EMAIL
    return false
  } catch { return false }
}

export async function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (!(await isPlatformOwner(req.user.userId, req.user.email))) {
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
  /**
   * 10/22 — A PERMISSION IS GRANTED BY A COMPANY, NOT HELD BY A PERSON.
   *
   * Name the permission this action needs and it is checked against the set
   * THIS PROPERTY'S COMPANY granted, read from that company's own scope row.
   *
   * It matters as soon as one person works for two owners, which is the whole
   * point of folding the management portal in (PM_FOLD_PLAN.md). A worker's
   * token carries one flat permission set, so "issue refunds" granted at park A
   * would otherwise pass the check at park B, which granted nothing of the
   * kind — property access would refuse the data while the permission sailed
   * through. Read fresh here rather than baked into the pass, so an owner
   * taking a permission away takes effect on the next request and not the next
   * login.
   *
   * requirePerm still admits the route on what the pass carries. This is the
   * narrower question asked where the property is already known.
   */
  opts: { perm?: string | string[] } = {},
): Promise<void> {
  if (!user) throw new AppError(401, 'Unauthenticated')
  // 10/23 — AN OWNER OF THEIR OWN COMPANY IS A MANAGER OF SOMEBODY ELSE'S.
  //
  // Folding the management portal in means Blu signs in to ONE account that
  // owns Country Acres and manages Oak Park for its owner. His users.role is
  // 'landlord' either way, and 'landlord' used to bypass every property check
  // outright — so a grant of one park would have shown him the whole of
  // somebody else's company. The bypass is right for a company they OWN and
  // wrong for one they manage, so it now asks which this property's company is.
  //
  // Not a member at all falls through to the bypass, exactly as before: the
  // company-level gates (canAccessLandlordResource, resolveLandlordTarget) are
  // what refuse a stranger, and this function has never been the thing that
  // did it.
  if (OWNER_ROLES.includes(user.role)) {
    if (user.role !== 'landlord' || !propertyId) return
    const how = await query<{ role: string }>(
      `SELECT m.role
         FROM properties p
         JOIN landlord_members m ON m.landlord_id = p.landlord_id AND m.user_id = $1
        WHERE p.id = $2::uuid`,
      [user.userId, propertyId])
    if (!how.length || how.some(r => r.role === 'owner')) return
    // Managed, not owned: the owner's grant decides, read below out of the
    // property-manager scope for this company.
    return await assertManagedPropertyInScope(user, propertyId, opts)
  }
  if (user.role === 'bookkeeper') {
    // 10/12: an action is on a property the company owns today and they keep.
    // A former property is read only (lib/bookkeeperScope).
    const ids = (await bookkeeperRequestScopeOf(user)).currentIds
    if (ids === null) return
    if (!propertyId) throw new AppError(400, 'A property must be selected for this action')
    if (!ids.includes(propertyId)) throw new AppError(403, 'You are not assigned to this property')
    return
  }
  const table = WORKER_SCOPE_TABLE[user.role]
  if (!table) throw new AppError(403, 'Not authorized for property-scoped actions')
  if (!propertyId) throw new AppError(400, 'A property must be selected for this action')
  // 10/22 — THE PROPERTY NAMES THE COMPANY, AND THE COMPANY NAMES THE SCOPE.
  //
  // This read was `WHERE user_id = $1 LIMIT 1`, which could only ever be right
  // while a person worked for exactly one company. The scope tables are keyed
  // (user_id, landlord_id) and always were, so a manager working for two owners
  // had two rows and got whichever one came back first: one owner's properties
  // answered and the other silently did not — or, if the first row happened to
  // say all_properties, it answered for a company that had granted nothing.
  //
  // It is the same rule the rest of the platform follows since S654 ("the
  // property or the row names the company; none is the default"): find the
  // scope row belonging to the company that owns THIS property. No row for that
  // company means no access to it, whatever they hold elsewhere.
  const rows = await query<{ property_ids: string[]; all_properties: boolean; permissions: Record<string, unknown> | null }>(
    `SELECT s.property_ids, s.all_properties, s.permissions
       FROM ${table} s
       JOIN properties p ON p.landlord_id = s.landlord_id
      WHERE s.user_id = $1 AND p.id = $2::uuid`,
    [user.userId, propertyId],
  )
  if (!rows.length) {
    // Told apart so the words are true: somebody with no scope at all is a
    // setup problem, somebody scoped elsewhere is a permission answer.
    const any = await query<{ one: number }>(
      `SELECT 1 AS one FROM ${table} WHERE user_id = $1 LIMIT 1`, [user.userId])
    throw new AppError(403, any.length
      ? 'You are not assigned to this property'
      : 'No property scope assigned')
  }
  // Several rows can only mean several companies own the same property, which
  // cannot happen — but if it ever did, any grant that reaches it is enough.
  const reaching = rows.filter(r => r.all_properties || r.property_ids.includes(propertyId))
  if (!reaching.length) throw new AppError(403, 'You are not assigned to this property')

  const needs = opts.perm == null ? [] : (Array.isArray(opts.perm) ? opts.perm : [opts.perm])
  if (!needs.length) return
  // Granted by THIS property's company, or not granted here at all.
  const granted = reaching.some(r => needs.some(k => (r.permissions ?? {})[k] === true))
  if (!granted) throw new AppError(403, 'Insufficient permissions for this property')
}

/**
 * The same question for somebody whose access to this company came from MANAGING
 * it rather than owning it: their grant lives in property_manager_scopes for
 * that company, whatever their own account's role says. Kept beside the worker
 * path rather than folded into it, because the two arrive by different doors and
 * a reader should see that.
 */
async function assertManagedPropertyInScope(
  user: AuthPayload, propertyId: string, opts: { perm?: string | string[] } = {},
): Promise<void> {
  const rows = await query<{ property_ids: string[]; all_properties: boolean; permissions: Record<string, unknown> | null }>(
    `SELECT s.property_ids, s.all_properties, s.permissions
       FROM property_manager_scopes s
       JOIN properties p ON p.landlord_id = s.landlord_id
      WHERE s.user_id = $1 AND p.id = $2::uuid`,
    [user.userId, propertyId])
  const reaching = rows.filter(r => r.all_properties || r.property_ids.includes(propertyId))
  if (!reaching.length) {
    throw new AppError(403, 'You manage this company, but not this property')
  }
  const needs = opts.perm == null ? [] : (Array.isArray(opts.perm) ? opts.perm : [opts.perm])
  if (!needs.length) return
  if (reaching.some(r => needs.some(k => (r.permissions ?? {})[k] === true))) return
  throw new AppError(403, 'The owner of this property has not given you that')
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
  // 10/11: a bookkeeper narrowed to some of the company's properties reads
  // those properties' money only — every report that already honors this
  // (S655 audience isolation) narrows for them with no change of its own.
  if (user.role === 'bookkeeper') return bookkeeperPropertyIdsOf(user)
  const table = WORKER_SCOPE_TABLE[user.role]
  if (!table) return null
  // 10/22 — EVERY COMPANY THEY WORK FOR, NOT THE FIRST ONE.
  //
  // `LIMIT 1` here was the read-side half of the same fault: a manager working
  // for two owners listed one owner's properties and the other's were invisible
  // to every list in the portal.
  //
  // `null` KEEPS ITS MEANING, which is not "no filter" but "NOT NARROWED" —
  // this person holds whole companies, so every page that distinguishes a
  // company-wide document from a per-property one (the Books P&L, the cash
  // flow, the owner statements) still hands them the company's own. Returning a
  // list instead refused a manager with every property of the only company they
  // work for, which the Books audience-isolation suite caught at once.
  //
  // Narrowed anywhere, and the answer is the explicit union: a person who
  // manages every property for one owner and fixes two sites for another is
  // narrowed, and must never see past either grant. An all_properties row
  // expands to ITS OWN company's properties — never to every property on the
  // platform, which is what a bare `null` would have meant for them.
  const rows = await query<{ property_ids: string[] | null; all_properties: boolean }>(
    `SELECT property_ids, all_properties FROM ${table} WHERE user_id = $1`,
    [user.userId],
  )
  if (!rows.length) return []
  if (rows.every(r => r.all_properties)) return null
  const spread = await query<{ pid: string }>(
    `SELECT DISTINCT pid FROM (
       SELECT unnest(s.property_ids) AS pid FROM ${table} s WHERE s.user_id = $1
       UNION
       SELECT p.id FROM ${table} s
         JOIN properties p ON p.landlord_id = s.landlord_id
        WHERE s.user_id = $1 AND s.all_properties
     ) q WHERE pid IS NOT NULL`,
    [user.userId],
  )
  return spread.map(r => r.pid)
}

/**
 * 10/11: a bookkeeper's properties. requireAuth puts them on the request; a
 * caller holding a bare pass (a job, a test) works them out from the scope row
 * the same way (lib/bookkeeperScope). null = the whole company (10/12: the
 * company-wide box and every property the company owns today ticked; BK3: a
 * sold property never theirs is hidden by the cutoffs — lib/bookkeeperScope
 * requestScopeOf); else the kept properties and
 * the former ones; [] = no property's money (a company-wide-only bookkeeper,
 * or no assignment at all).
 */
export async function bookkeeperPropertyIdsOf(user: AuthPayload): Promise<string[] | null> {
  return (await bookkeeperRequestScopeOf(user)).propertyIds
}

/** 10/12: everything one bookkeeper request reads (lib/bookkeeperScope BookkeeperRequestScope). */
export async function bookkeeperRequestScopeOf(user: AuthPayload): Promise<BookkeeperRequestScope> {
  if (user.bookkeeperScope !== undefined) return user.bookkeeperScope
  const [row] = await bookkeeperScopesOf(user.userId, user.landlordId ?? null)
  return row ? requestScopeOf(row) : NO_BOOKKEEPER_SCOPE
}

/**
 * 10/12 (Nic): the clean cut at a sale. The former properties' last days a
 * reader leaves later rows of out — a bookkeeper's; [] for everyone else
 * (owners and staff read what the landlord_id on each row says, as before).
 */
export async function propertyCutoffsOf(user: AuthPayload | undefined): Promise<PropertyCutoff[]> {
  if (!user || user.role !== 'bookkeeper') return []
  return (await bookkeeperRequestScopeOf(user)).cutoffs
}

// requirePerm — gate a worker route by sub-permission key. Owner roles
// always pass. Worker roles pass if JWT.permissions[key] === true for
// any of the listed keys (OR semantics — useful when a single endpoint
// can be reached by either of two perms, e.g. read endpoints).
//
// Sub-permission keys come from packages/shared SUB_PERMISSIONS_BY_ROLE.
// Absent / false / non-true value = denied.
/**
 * S641 — does this caller hold any of these permissions? Same rule requirePerm
 * uses, exposed for shaping a RESPONSE rather than gating a route.
 *
 * Nic, on his on-site manager: "I don't want her to see the covered by work
 * trade or the payment histories from people." The balances list is a screen she
 * legitimately needs, carrying one figure she should not — which is a response
 * to shape, not a door to lock. Doing it here rather than in the frontend is the
 * point: data the viewer should not have never leaves the building.
 */
export function userHasPerm(user: Request['user'], ...keys: string[]): boolean {
  if (!user) return false
  if (OWNER_ROLES.includes(user.role)) return true
  // 10/12 (Nic): and the keys an owner's box gives them (the monthly report).
  if (user.role === 'bookkeeper') return keys.some(k => bookkeeperHasPerm(user.bookkeeperScope, k))
  const perms = user.permissions || {}
  return keys.some(k => perms[k] === true)
}

export function requirePerm(...keys: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
    if (OWNER_ROLES.includes(req.user.role)) return next()
    // 10/11: a bookkeeper holds a fixed set (lib/bookkeeperAccess); requireAuth
    // has already kept them to the routes those keys may open. 10/12 (Nic):
    // plus the keys their owner's boxes give them (the monthly report).
    if (req.user.role === 'bookkeeper' && keys.some(k => bookkeeperHasPerm(req.user!.bookkeeperScope, k))) return next()
    const perms = req.user.permissions || {}
    for (const k of keys) if (perms[k] === true) return next()
    return res.status(403).json({ success: false, error: 'Insufficient permissions' })
  }
}

// Bookkeeper-specific gates. Bookkeepers don't have sub-permissions —
// they have access_level (read_only | read_write) packed into the
// permissions claim by getScopeForUser. 10/12 (Nic): one level — a
// bookkeeper with a scope row on the company reads and writes its books
// (requireBooksWrite). Owner roles always pass.
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
  // 10/12 (Nic, ledger decision 2): "Full bookkeeping … One level, no
  // per-bookkeeper switch." Every bookkeeper this company keeps (its live
  // scope row, put on the request by requireAuth) writes its books; the old
  // read-only box decides nothing. Which books (the ledger, the company-wide
  // pages) is still the owner's boxes, checked by routes/books' own gate.
  if (req.user.role === 'bookkeeper' && bookkeeperMayWrite(req.user.bookkeeperScope)) return next()
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
// S654 (Nic): there is NO home company. The S652 "company the account founded"
// was a default by another name; it is gone from the session, so nothing can
// read it. See resolveLandlordTarget / landlordForRequest.
export function _clearMembershipCache(): void { membershipCache.clear() }
/**
 * S655: drop one account's cached company list. Called right after something
 * GIVES an account a company (accepting a co-owner invitation, the claim when
 * an address is proven). The 15s TTL is the right bound for a removal, but a
 * person who just accepted is told the company is in their account and clicks
 * straight through to it — the page load before the accept filled this cache,
 * so without this their next request would still be missing the company.
 * Call it only AFTER the commit, or a concurrent request can refill it from
 * the pre-commit rows.
 */
export function forgetMembership(userId: string): void { membershipCache.delete(userId) }

/**
 * 10/5: users.sessions_valid_from, read fresh and cached briefly (same bound as
 * company membership). Every place that stamps the column calls
 * forgetSessionCutoff after its commit, so the cache never hides a reset; the
 * TTL only covers a write that forgets to. A failed read lets the request
 * through — the route behind it needs the same database and fails on its own;
 * a 401 here would sign every user out on a database blip.
 */
const CUTOFF_TTL_MS = 15_000
const cutoffCache = new Map<string, { ms: number | null; at: number }>()
export function forgetSessionCutoff(userId: string): void { cutoffCache.delete(userId) }
export function _clearSessionCutoffCache(): void { cutoffCache.clear() }

async function sessionCutoffMs(userId: string): Promise<number | null> {
  const now = Date.now()
  const hit = cutoffCache.get(userId)
  if (hit && now - hit.at < CUTOFF_TTL_MS) return hit.ms
  try {
    const row = await queryOne<{ sessions_valid_from: Date | null }>(
      `SELECT sessions_valid_from FROM users WHERE id = $1`, [userId])
    const ms = row?.sessions_valid_from ? new Date(row.sessions_valid_from).getTime() : null
    cutoffCache.set(userId, { ms, at: now })
    if (cutoffCache.size > 5000) cutoffCache.clear()
    return ms
  } catch {
    return null
  }
}

async function currentLandlordIds(payload: AuthPayload): Promise<string[]> {
  const key = payload.userId
  const hit = membershipCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < MEMBERSHIP_TTL_MS) return hit.ids
  // S633: membership OR founding ownership. This used to fall back on the
  // token's profileId to cover accounts predating landlord_members — but
  // profileId no longer names an entity for a landlord, so the fallback has to
  // be the fact it was standing in for: `landlords.user_id`. Without this union
  // an older account loses the company it founded the moment the session stops
  // carrying an entity id.
  const rows = await query<{ landlord_id: string }>(
    `SELECT landlord_id FROM landlord_members WHERE user_id = $1
     UNION
     SELECT id           FROM landlords        WHERE user_id = $1`, [payload.userId])
  const ids = Array.from(new Set([
    ...(payload.landlordIds ?? []),
    ...rows.map((r) => r.landlord_id),
  ].filter(Boolean))) as string[]
  membershipCache.set(key, { ids, at: now })
  if (membershipCache.size > 5000) membershipCache.clear()
  return ids
}
