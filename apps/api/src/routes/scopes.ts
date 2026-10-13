import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { emailInvitation } from '../services/email'
import { createNotification } from '../services/notifications'
import { fetchAccountStatus } from '../services/stripeConnect'
import {
  LANDLORD_ASSIGNABLE_ROLES,
  LandlordAssignableRole,
  MAINTENANCE_JOB_CATEGORIES,
  BOOKKEEPER_ACCESS_LEVELS,
  BOOKKEEPER_ONE_LEVEL,
  BOOKKEEPER_MONEY_IN_FILING,
  DEFAULT_BOOKKEEPER_MONEY_IN_FILING,
  type BookkeeperAccessChoice,
} from '@gam/shared'
import { logger } from '../lib/logger'
// S641: one resolver for portal URLs — never a localhost link in production.
import { portalUrl, portalLink } from '../lib/portalUrls'
import { resolveLandlordTarget, landlordIdForProperty, landlordScopeIds } from '../lib/landlordScope'
import { keptIdsSql, coversAllSql, companyWideSql, formerSql, bookkeeperScopesOf } from '../lib/bookkeeperScope'

// ── Shared helpers ────────────────────────────────────────────────

const INVITATION_TTL_HOURS = 24

/**
 * S654: every column of an invitation except its token.
 *
 * The invite, resend and revoke routes returned the row whole (RETURNING *) and
 * the role listing read SELECT * FROM invitations, so the caller got the very
 * secret that lets someone accept. Landlord B invited landlord A's property
 * manager, read the token off the 201, and accepted it himself. The token goes
 * only to the invitee's address, by email (buildAcceptUrl). No landlord screen
 * reads it from a response.
 */
const INVITATION_COLUMNS = `id, email, landlord_id, role, scope_payload, invited_by_user_id,
  status, expires_at, accepted_at, accepted_user_id, revoked_at, revoked_by_user_id,
  created_at, first_name, last_name, phone`

const SCOPE_TABLES: Record<LandlordAssignableRole, string> = {
  property_manager: 'property_manager_scopes',
  onsite_manager:   'onsite_manager_scopes',
  maintenance:      'maintenance_worker_scopes',
  bookkeeper:       'bookkeeper_scopes',
}

// Per-role scope payload validation
const pmScopeSchema = z.object({
  propertyIds:               z.array(z.string().uuid()).default([]),
  unitIds:                   z.array(z.string().uuid()).default([]),
  allProperties:             z.boolean().default(false),
  maintApprovalCeilingCents: z.number().int().nullable().default(null),
})

const osScopeSchema = z.object({
  propertyIds:   z.array(z.string().uuid()).default([]),
  unitIds:       z.array(z.string().uuid()).default([]),
  allProperties: z.boolean().default(false),  // S187
  // W-52 (S529): invite-time permission grants (a preset's keys). Applied to
  // the scope row on accept so the person lands with the right access.
  permissions:   z.record(z.boolean()).default({}),
})

const mwScopeSchema = z.object({
  propertyIds:   z.array(z.string().uuid()).default([]),
  unitIds:       z.array(z.string().uuid()).default([]),
  jobCategories: z.array(z.enum(MAINTENANCE_JOB_CATEGORIES)).default([]),
  allProperties: z.boolean().default(false),
})

// 10/11 (Nic): a bookkeeper keeps one company's books, and inside it exactly
// the properties the owner ticks ("a bookkeeper for the Mountain View
// property... They don't need to see anything with Oak Park"). Every property
// is its own box, and a property the company adds later arrives unticked,
// because the stored list never grows on its own. 10/12 (Nic, ledger decision
// 2): "Full bookkeeping … never tenant-account actions … One level, no
// per-bookkeeper switch" — there is no access level to ask: every bookkeeper
// is written BOOKKEEPER_ONE_LEVEL and does the bookkeeping on what is ticked.
//
// 10/12 (Nic): two more boxes, the owner's choice per bookkeeper:
//   companyWide     "Company-wide: bank account, payouts and payroll" — the
//                   bank account, payouts, payroll and the company's Books
//                   ledger and reports. Its own box, never inferred from the
//                   property boxes.
//   showLeaseDates  "Show lease start and end dates" on their rent roll (off
//                   unless ticked; never the lease text or documents).
// A bookkeeper may keep NO property when companyWide is ticked (a company with
// no property yet included). Only nothing at all is refused.
//
// 10/12 (Nic): three more boxes, the owner's choice per bookkeeper, all off
// unless ticked (lib/bookkeeperScope):
//   companyLedger        BK1 "May use the whole-company ledger" — the GAM
//                        Books ledger without the company-wide box
//   wholeCompanyReports  BK2 "Company reports show the whole company" — else
//                        only their properties' money in them
//   seesMonthlyReport    "Sees the monthly property report on screen"
// None of them alone is something to keep: a bookkeeper still needs a
// property or Company-wide (the ledger box is for a property bookkeeper).
const NOTHING_TICKED = 'Tick at least one property or Company-wide.'
const bkPropertyIdsSchema = z.array(
  z.string().uuid('That is not one of your properties.'),
  { required_error: NOTHING_TICKED, invalid_type_error: NOTHING_TICKED },
)
// 10/12 (Nic, ledger decision 2): "One level, no per-bookkeeper switch" —
// accessLevel is still accepted from an older screen and ignored; every
// bookkeeper is written BOOKKEEPER_ONE_LEVEL (full bookkeeping, never a
// tenant's account).
const bkScopeSchema = z.object({
  accessLevel: z.enum(BOOKKEEPER_ACCESS_LEVELS).optional(),
  propertyIds: bkPropertyIdsSchema.default([]),
  companyWide: z.boolean().default(false),
  showLeaseDates: z.boolean().default(false),
  companyLedger: z.boolean().default(false),
  wholeCompanyReports: z.boolean().default(false),
  seesMonthlyReport: z.boolean().default(false),
  // 10/12 (Nic, L19): what they may file of the money coming in on the bank
  // feed — the owner's choice per bookkeeper (money going out is open to them).
  moneyInFiling: z.enum(BOOKKEEPER_MONEY_IN_FILING).default(DEFAULT_BOOKKEEPER_MONEY_IN_FILING),
})
// PATCH: whatever is sent is changed; a field left out stays as it is. A
// change that leaves nothing ticked at all is refused like the invite.
const bkScopePatchSchema = z.object({
  accessLevel: z.enum(BOOKKEEPER_ACCESS_LEVELS).optional(),
  propertyIds: bkPropertyIdsSchema.optional(),
  companyWide: z.boolean().optional(),
  showLeaseDates: z.boolean().optional(),
  companyLedger: z.boolean().optional(),
  wholeCompanyReports: z.boolean().optional(),
  seesMonthlyReport: z.boolean().optional(),
  moneyInFiling: z.enum(BOOKKEEPER_MONEY_IN_FILING).optional(),
})

/**
 * 10/12 (Nic, L19): "bookkeepers filing money coming in → LANDLORD'S CHOICE
 * per bookkeeper". A deposit a bookkeeper files leaves the rent queue, so only
 * the owner (or a GAM admin) changes it from the default.
 */
const OWNER_CHOOSES_MONEY_IN = 'Only the owner chooses what a bookkeeper may file of the money coming in.'

/** 10/11: zod's own words for a bookkeeper's boxes, without the field path. */
function parseBookkeeperScope<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw ?? {})
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message || NOTHING_TICKED)
  return r.data
}

/**
 * 10/11 (SECURITY): the properties this caller may hand a bookkeeper in this
 * company. null = any of them (an owner, or staff who cover every property);
 * else only the properties in the caller's own scope there.
 *
 * Without it a property manager kept to Mountain View, holding the team
 * permissions, could give a bookkeeper Oak Park's books, every property, or
 * remove a bookkeeper the owner set up for Oak Park: their own reach stops at
 * Mountain View, and so does what they can give away.
 */
const STAFF_SCOPE_TABLES: Record<string, string> = {
  property_manager: 'property_manager_scopes',
  onsite_manager:   'onsite_manager_scopes',
  maintenance:      'maintenance_worker_scopes',
}
async function callerPropertyLimit(req: any, landlordId: string): Promise<string[] | null> {
  const role = req.user?.role
  if (role === 'admin' || role === 'super_admin' || role === 'landlord') return null
  const table = STAFF_SCOPE_TABLES[role]
  if (!table) return []
  const row = await queryOne<{ property_ids: string[] | null; all_properties: boolean }>(
    `SELECT property_ids, all_properties FROM ${table} WHERE user_id = $1 AND landlord_id = $2 LIMIT 1`,
    [req.user.userId, landlordId])
  if (!row) return []
  if (row.all_properties) return null
  return row.property_ids ?? []
}

const NOT_YOURS_TO_GIVE = 'You can only give a bookkeeper properties you manage yourself.'
const NOT_YOURS_TO_CHANGE = 'This bookkeeper keeps properties you do not manage. Ask the owner to change or remove them.'
// 10/12: refused for a box the bookkeeper holds (company-wide, the ledger,
// whole-company reports, the monthly report) — not for their properties,
// which NOT_YOURS_TO_CHANGE said even when every one was the caller's.
const NOT_YOURS_BOXES_TO_CHANGE = 'This bookkeeper has access you cannot give yourself. Ask the owner, or someone who has that access, to change or remove them.'

/**
 * 10/11: the properties ticked must be the company's own and — for staff
 * acting on the team — inside the caller's own scope. 10/12: the list may be
 * empty (a company-wide-only bookkeeper); "nothing at all" is the caller's to
 * refuse, since only it sees the company-wide box. Ticking every property no
 * longer opens the company-wide pages (that is the company-wide box alone),
 * so staff whose own list covers every property may tick every box.
 */
async function bookkeeperPropertyIds(
  landlordId: string, ids: string[], limit: string[] | null,
): Promise<string[]> {
  const uniq = Array.from(new Set(ids ?? []))
  if (!uniq.length) return []
  const rows = await query<{ id: string }>(
    `SELECT id FROM properties WHERE id = ANY($1::uuid[]) AND landlord_id = $2`, [uniq, landlordId])
  if (rows.length !== uniq.length) {
    throw new AppError(400, "Pick properties that belong to the company whose books they keep.")
  }
  if (limit !== null && uniq.some(id => !limit.includes(id))) throw new AppError(403, NOT_YOURS_TO_GIVE)
  return uniq
}

/**
 * 10/12 (Nic, SECURITY): who may give (or take back) a bookkeeper's
 * company-wide box — the company's bank account, payouts and payroll. The
 * owner (and GAM staff acting for them); or a team member who holds the team
 * permission (the route's own gate) AND company-wide access themselves: set
 * to every property of the company with "View books" on (the company's Books,
 * payroll included). A manager kept to Mountain View cannot hand anyone the
 * company's bank.
 */
// 10/12: the refusals said "Only the owner can give…", which was not true — a
// team member with company-wide access of their own gives these too
// (callerHasCompanyWide). Said to the person refused, as NOT_YOURS_MONTHLY is.
const HAS_COMPANY_WIDE_WORDS = 'only if you have company-wide access yourself: every property, with "View books" on'
const NOT_YOURS_COMPANY_WIDE = `You can give a bookkeeper the company-wide books (the bank account, payouts and payroll) ${HAS_COMPANY_WIDE_WORDS}.`
async function callerHasCompanyWide(req: any, landlordId: string): Promise<boolean> {
  const role = req.user?.role
  if (role === 'admin' || role === 'super_admin' || role === 'landlord') return true
  const table = STAFF_SCOPE_TABLES[role]
  if (!table) return false
  const row = await queryOne<{ all_properties: boolean; permissions: Record<string, unknown> | null }>(
    `SELECT all_properties, permissions FROM ${table} WHERE user_id = $1 AND landlord_id = $2 LIMIT 1`,
    [req.user.userId, landlordId])
  return !!row?.all_properties && row?.permissions?.['books.view'] === true
}

/**
 * 10/12 (Nic, SECURITY): staff may only give a bookkeeper what they hold
 * themselves. The whole-company ledger (BK1) and the whole company's reports
 * (BK2) are whole-company access — given, like the company-wide box, only by
 * the owner or staff with company-wide access of their own
 * (callerHasCompanyWide). The monthly report only by someone who sees it
 * themselves: the owner, or staff holding the Monthly report tab
 * ("reports.tab.monthly") on their own row, read fresh.
 */
const NOT_YOURS_LEDGER = `You can give a bookkeeper the whole-company ledger ${HAS_COMPANY_WIDE_WORDS}.`
const NOT_YOURS_WHOLE_REPORTS = `You can give a bookkeeper the whole company's reports ${HAS_COMPANY_WIDE_WORDS}.`
const NOT_YOURS_MONTHLY = 'You can give a bookkeeper the monthly property report only if you see it yourself.'
async function callerSeesMonthlyReport(req: any, landlordId: string): Promise<boolean> {
  const role = req.user?.role
  if (role === 'admin' || role === 'super_admin' || role === 'landlord') return true
  const table = STAFF_SCOPE_TABLES[role]
  if (!table) return false
  const row = await queryOne<{ permissions: Record<string, unknown> | null }>(
    `SELECT permissions FROM ${table} WHERE user_id = $1 AND landlord_id = $2 LIMIT 1`,
    [req.user.userId, landlordId])
  return row?.permissions?.['reports.tab.monthly'] === true
}

/**
 * 10/12: the boxes this caller turns ON (off before, on after) must be theirs
 * to give. Turning one off is a change to the bookkeeper, which
 * assertBookkeeperWithinCaller already allows only to staff who could give it.
 */
async function assertBoxesTheirsToGive(
  req: any, landlordId: string,
  before: { companyWide?: boolean; companyLedger?: boolean; wholeCompanyReports?: boolean; seesMonthlyReport?: boolean },
  after: { companyWide?: boolean; companyLedger?: boolean; wholeCompanyReports?: boolean; seesMonthlyReport?: boolean },
): Promise<void> {
  const on = (k: keyof typeof after) => after[k] === true && before[k] !== true
  if (on('companyWide') && !(await callerHasCompanyWide(req, landlordId))) throw new AppError(403, NOT_YOURS_COMPANY_WIDE)
  if (on('companyLedger') && !(await callerHasCompanyWide(req, landlordId))) throw new AppError(403, NOT_YOURS_LEDGER)
  if (on('wholeCompanyReports') && !(await callerHasCompanyWide(req, landlordId))) throw new AppError(403, NOT_YOURS_WHOLE_REPORTS)
  if (on('seesMonthlyReport') && !(await callerSeesMonthlyReport(req, landlordId))) throw new AppError(403, NOT_YOURS_MONTHLY)
}

/**
 * 10/11: staff may change or remove a bookkeeper only when every property the
 * bookkeeper keeps today is inside the staff member's own scope. 10/12: and,
 * when the bookkeeper holds the company-wide box, only staff who could give
 * it (callerHasCompanyWide) — changing or removing such a bookkeeper decides
 * who sees the company's bank.
 *
 * 10/12 review (SECURITY): and every FORMER property they keep (a sold
 * property's history, read only) inside it too. Removing a bookkeeper takes
 * their former properties with it (ON DELETE CASCADE), so a manager kept to
 * Alder could otherwise wipe a bookkeeper's access to Birch's history — a
 * property that manager never had.
 */
async function assertBookkeeperWithinCaller(
  req: any, limit: string[] | null, userId: string, landlordId: string,
): Promise<void> {
  const [row] = await bookkeeperScopesOf(userId, landlordId)
  if (!row) return
  if (limit !== null && row.kept_ids.some(id => !limit.includes(id))) throw new AppError(403, NOT_YOURS_TO_CHANGE)
  if (limit !== null && (row.former ?? []).some(f => !limit.includes(f.propertyId))) throw new AppError(403, NOT_YOURS_TO_CHANGE)
  if (row.company_wide && !(await callerHasCompanyWide(req, landlordId))) throw new AppError(403, NOT_YOURS_BOXES_TO_CHANGE)
  // 10/12 (Nic): and the ledger, whole-company reports and monthly report
  // boxes — changing or removing a bookkeeper who holds one decides who sees
  // it, so only staff who could give it.
  if ((row.company_ledger || row.whole_company_reports) && !(await callerHasCompanyWide(req, landlordId))) {
    throw new AppError(403, NOT_YOURS_BOXES_TO_CHANGE)
  }
  if (row.sees_monthly_report && !(await callerSeesMonthlyReport(req, landlordId))) throw new AppError(403, NOT_YOURS_BOXES_TO_CHANGE)
}

function validateScopePayload(role: LandlordAssignableRole, raw: unknown): any {
  switch (role) {
    case 'property_manager': return pmScopeSchema.parse(raw)
    case 'onsite_manager':   return osScopeSchema.parse(raw)
    case 'maintenance':      return mwScopeSchema.parse(raw)
    case 'bookkeeper':       return parseBookkeeperScope(bkScopeSchema, raw)
  }
}

function isAssignableRole(s: string): s is LandlordAssignableRole {
  return (LANDLORD_ASSIGNABLE_ROLES as readonly string[]).includes(s)
}

// Resolve the landlord_id whose team the caller is acting on.
// - landlord: their own profileId
// - admin/super_admin: explicit ?landlordId= or body.landlordId
// - property_manager (S81, with team.invite or team.manage_permissions perm):
//   their scope's landlordId. They cannot act on any other landlord.
/**
 * Which company this team action belongs to.
 *
 * ── S640: NO LANDLORD COULD INVITE ANYBODY ─────────────────────────────────
 *
 * This returned `req.user.profileId` for a landlord, and since S633 a
 * landlord's profileId is NULL — an account is not an entity. So every invite,
 * every permission change and every scope listing on the Team page inserted a
 * NULL landlord_id and died on the not-null constraint, surfacing as a raw
 * Postgres string rather than anything a person could act on. Found trying to
 * add Lisa Scheeler to the front desk: the whole Team page was dead.
 *
 * Same fix as the eleven sites in background.ts, plus the S633 preference for
 * DERIVING over asking: a team member is scoped to a property, and the property
 * already names its company, so an account with two companies has nothing to
 * choose. 10/11: a bookkeeper who ticks a property is derived the same way.
 * 10/12: a company-wide-only bookkeeper names no property, so an account with
 * several companies names the company (the Team page always sends it); a
 * request that names neither is asked.
 */
async function getLandlordIdFromReq(req: any): Promise<string> {
  const explicit = req.body?.landlordId ?? req.query?.landlordId ?? null
  if (explicit) {
    // 10/11: the Team page names the bookkeeper's company on every edit and
    // remove. resolveLandlordTarget refuses every team role, so a property
    // manager holding the team permissions got "That company is not yours to
    // act on" for their OWN company. Naming the company they already work for
    // is the same as naming none; any other company still goes through the
    // resolver and is refused.
    const u = req.user
    if (u && u.role !== 'landlord' && u.role !== 'admin' && u.role !== 'super_admin'
        && u.landlordId && String(explicit) === u.landlordId) {
      return u.landlordId
    }
    return resolveLandlordTarget(req.user, String(explicit), 'team member')
  }

  const propertyId = req.body?.scope?.propertyIds?.[0]
  if (propertyId) {
    // 10/11: a bookkeeper invite that names properties reached a manager's
    // invite to landlordIdForProperty, which refuses every team role —
    // even for a property of their own company. (Before, "every property" sent
    // none and fell through to the manager branch below.) A manager naming a
    // property of their own company gets that company; what they may give
    // inside it is checked by callerPropertyLimit. Other roles are unchanged.
    const u = req.user
    if (req.params?.roleType === 'bookkeeper' && u && u.role !== 'landlord'
        && u.role !== 'admin' && u.role !== 'super_admin' && u.landlordId) {
      const own = await queryOne<{ landlord_id: string }>(
        `SELECT landlord_id FROM properties WHERE id = $1`, [String(propertyId)])
      if (own?.landlord_id === u.landlordId) return u.landlordId
    }
    return landlordIdForProperty(req.user, String(propertyId), query)
  }

  if (req.user?.role === 'property_manager' && req.user?.landlordId) {
    return req.user.landlordId
  }
  return resolveLandlordTarget(req.user, null, 'team member')
}

/**
 * S652 — every company whose team this caller may see or edit.
 *
 * Nic: "I don't see anywhere that shows my existing team." His account owns
 * Oak Park AND Mountain View; the roll-up resolved ONE company (the one the
 * account founded) and Lisa, on Mountain View's front desk, was under the
 * other. A team member belongs to a property, the property to a company, and
 * the account to all of its companies — so the roster spans them all, and a
 * member is looked up by user id across them rather than under a guess.
 */
function teamLandlordIds(req: any): Promise<string[]> {
  if (req.user?.role === 'landlord') {
    const owned = landlordScopeIds(req.user)
    if (owned.length) return Promise.resolve(owned)
  }
  return getLandlordIdFromReq(req).then((id) => [id])
}

async function insertScopeRow(
  client: any,
  role: LandlordAssignableRole,
  userId: string,
  landlordId: string,
  payload: any,
) {
  switch (role) {
    case 'property_manager': {
      const { rows } = await client.query(
        `INSERT INTO property_manager_scopes
           (user_id, landlord_id, property_ids, unit_ids, all_properties, maint_approval_ceiling_cents)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, landlordId, payload.propertyIds, payload.unitIds,
         payload.allProperties, payload.maintApprovalCeilingCents])
      return rows[0]
    }
    case 'onsite_manager': {
      const { rows } = await client.query(
        `INSERT INTO onsite_manager_scopes
           (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, landlordId, payload.propertyIds, payload.unitIds,
         payload.allProperties, JSON.stringify(payload.permissions || {})])
      return rows[0]
    }
    case 'maintenance': {
      const { rows } = await client.query(
        `INSERT INTO maintenance_worker_scopes
           (user_id, landlord_id, property_ids, unit_ids, job_categories, all_properties)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, landlordId, payload.propertyIds, payload.unitIds,
         payload.jobCategories, payload.allProperties])
      return rows[0]
    }
    case 'bookkeeper': {
      // 10/11: every box is ticked by hand, so an invitation that names no
      // property (one sent before boxes existed) grants nothing: it never
      // writes a row that a reader could take for "every property". 10/12
      // (Nic): unless it carries the company-wide box — a bookkeeper may keep
      // the company-wide books with no property ticked.
      const companyWide = payload.companyWide === true
      const named: string[] = Array.isArray(payload.propertyIds) ? payload.propertyIds : []
      if (!named.length && !companyWide) throw new AppError(409, 'This invitation names no properties. Ask for a new one.')
      // The properties were checked against the company at invite time; one
      // sold or moved since is no longer the company's, so re-check: keep the
      // ones it still owns, and refuse when nothing is left to keep.
      const { rows: ok } = named.length
        ? await client.query(
            `SELECT id FROM properties WHERE id = ANY($1::uuid[]) AND landlord_id = $2`, [named, landlordId])
        : { rows: [] as any[] }
      const propertyIds: string[] = ok.map((r: any) => r.id)
      if (!propertyIds.length && !companyWide) {
        throw new AppError(409, 'The properties on this invitation no longer belong to that company. Ask for a new invitation.')
      }
      // 10/12 (Nic): the ledger, whole-company reports and monthly report
      // boxes ride the invitation like the others (checked when it was sent);
      // an invitation sent before they existed carries none of them.
      const { rows } = await client.query(
        `INSERT INTO bookkeeper_scopes
           (user_id, landlord_id, access_level, property_ids, company_wide, show_lease_dates,
            company_ledger, whole_company_reports, sees_monthly_report, money_in_filing)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        // 10/12 (Nic): one level, whatever an older invitation's payload says.
        [userId, landlordId, BOOKKEEPER_ONE_LEVEL, propertyIds, companyWide,
         payload.showLeaseDates === true, payload.companyLedger === true,
         payload.wholeCompanyReports === true, payload.seesMonthlyReport === true,
         // 10/12 (Nic, L19): the owner's choice on the invitation, else the default.
         (BOOKKEEPER_MONEY_IN_FILING as readonly string[]).includes(payload.moneyInFiling)
           ? payload.moneyInFiling : DEFAULT_BOOKKEEPER_MONEY_IN_FILING])
      return rows[0]
    }
  }
}

async function getInviterName(landlordId: string): Promise<string> {
  const landlord = await queryOne<any>(
    `SELECT u.first_name, u.last_name, l.business_name
     FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
    [landlordId])
  return landlord?.business_name
    || [landlord?.first_name, landlord?.last_name].filter(Boolean).join(' ')
    || 'Your landlord'
}

/**
 * S641: the invitation link.
 *
 * This read LANDLORD_PORTAL_URL, which has never existed in any environment —
 * the variable is LANDLORD_APP_URL — so every team invitation ever sent pointed
 * at http://localhost:3001. Lisa Scheeler's did. Nic: "you keep sending links to
 * localhost when that's not what we're doing."
 *
 * Resolved centrally now (lib/portalUrls), where a production boot with the
 * variable missing logs loudly and still emits the real host.
 */
function buildAcceptUrl(token: string): string {
  return portalLink('landlord', `invite/${token}`)
}

// ── Authenticated router: landlord manages scoped users ───────────

export const scopesRouter = Router()
scopesRouter.use(requireAuth)

// GET /api/scopes/team — unified roll-up across all 4 scope tables + invitations.
// S80 / Item 8b. Single endpoint feeds the landlord TeamPage view so the
// frontend doesn't have to query four endpoints and merge client-side.
// Registered BEFORE /:roleType so Express doesn't match 'team' as a roleType.
scopesRouter.get('/team', requirePerm('team.invite', 'team.manage_permissions'), async (req, res, next) => {
  try {
    const landlordIds = await teamLandlordIds(req)

    // S168: surface direct_deposit_enabled (per-manager opt-in toggle) and
    // the cached Connect-readiness flags from users so TeamPage can render
    // both the toggle state and the manager's onboarding progress without
    // a second round-trip.
    const pmRows = await query<any>(
      `SELECT 'property_manager' AS role, s.user_id, s.landlord_id, la.business_name AS company_name, s.permissions,
              jsonb_build_object(
                'propertyIds', s.property_ids,
                'unitIds', s.unit_ids,
                'allProperties', s.all_properties,
                'maintApprovalCeilingCents', s.maint_approval_ceiling_cents
              ) AS scope,
              s.direct_deposit_enabled,
              u.connect_charges_enabled,
              u.connect_payouts_enabled,
              u.connect_details_submitted,
              s.created_at, s.updated_at,
              u.email, u.first_name, u.last_name, u.phone
         FROM property_manager_scopes s JOIN users u ON u.id = s.user_id JOIN landlords la ON la.id = s.landlord_id
        WHERE s.landlord_id = ANY($1::uuid[])`, [landlordIds])

    const omRows = await query<any>(
      `SELECT 'onsite_manager' AS role, s.user_id, s.landlord_id, la.business_name AS company_name, s.permissions,
              jsonb_build_object(
                'propertyIds', s.property_ids,
                'unitIds', s.unit_ids,
                'allProperties', s.all_properties
              ) AS scope,
              s.created_at, s.updated_at,
              u.email, u.first_name, u.last_name, u.phone
         FROM onsite_manager_scopes s JOIN users u ON u.id = s.user_id JOIN landlords la ON la.id = s.landlord_id
        WHERE s.landlord_id = ANY($1::uuid[])`, [landlordIds])

    const mwRows = await query<any>(
      `SELECT 'maintenance' AS role, s.user_id, s.landlord_id, la.business_name AS company_name, s.permissions,
              jsonb_build_object(
                'propertyIds', s.property_ids,
                'unitIds', s.unit_ids,
                'jobCategories', s.job_categories,
                'allProperties', s.all_properties
              ) AS scope,
              s.created_at, s.updated_at,
              u.email, u.first_name, u.last_name, u.phone
         FROM maintenance_worker_scopes s JOIN users u ON u.id = s.user_id JOIN landlords la ON la.id = s.landlord_id
        WHERE s.landlord_id = ANY($1::uuid[])`, [landlordIds])

    // 10/11: a bookkeeper's boxes as they stand today (lib/bookkeeperScope):
    // propertyIds = the ticked properties still the company's, coversCompany =
    // every property it owns today is ticked. A property bought since shows on
    // the row as not ticked, rather than quietly counted in. 10/12: the
    // company-wide box, the lease-dates box, and the former properties (sold
    // or moved out while they kept them: read only, up to the day they left).
    const bkRows = await query<any>(
      `SELECT 'bookkeeper' AS role, s.user_id, s.landlord_id, la.business_name AS company_name,
              jsonb_build_object('access_level', s.access_level) AS permissions,
              jsonb_build_object('accessLevel', s.access_level,
                                 'propertyIds', to_jsonb(${keptIdsSql('s')}),
                                 'coversCompany', ${coversAllSql('s')},
                                 'companyWide', ${companyWideSql('s')},
                                 'showLeaseDates', s.show_lease_dates,
                                 'companyLedger', s.company_ledger,
                                 'wholeCompanyReports', s.whole_company_reports,
                                 'seesMonthlyReport', s.sees_monthly_report,
                                 'moneyInFiling', s.money_in_filing,
                                 'formerProperties', ${formerSql('s')}) AS scope,
              s.created_at, s.updated_at,
              u.email, u.first_name, u.last_name, u.phone
         FROM bookkeeper_scopes s JOIN users u ON u.id = s.user_id JOIN landlords la ON la.id = s.landlord_id
        WHERE s.landlord_id = ANY($1::uuid[])`, [landlordIds])

    const members = [...pmRows, ...omRows, ...mwRows, ...bkRows]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    // 10/11: a pending bookkeeper invitation says which properties it carries.
    // 10/12: and whether it carries the company-wide and lease-dates boxes.
    const invitations = await query<any>(
      `SELECT id, email, role, status, expires_at, created_at, accepted_at, revoked_at, landlord_id,
              CASE WHEN role = 'bookkeeper' AND jsonb_typeof(scope_payload->'propertyIds') = 'array'
                   THEN scope_payload->'propertyIds' END AS property_ids,
              CASE WHEN role = 'bookkeeper' THEN COALESCE((scope_payload->>'companyWide')::boolean, FALSE) END AS company_wide,
              CASE WHEN role = 'bookkeeper' THEN COALESCE((scope_payload->>'showLeaseDates')::boolean, FALSE) END AS show_lease_dates,
              CASE WHEN role = 'bookkeeper' THEN COALESCE((scope_payload->>'companyLedger')::boolean, FALSE) END AS company_ledger,
              CASE WHEN role = 'bookkeeper' THEN COALESCE((scope_payload->>'wholeCompanyReports')::boolean, FALSE) END AS whole_company_reports,
              CASE WHEN role = 'bookkeeper' THEN COALESCE((scope_payload->>'seesMonthlyReport')::boolean, FALSE) END AS sees_monthly_report
         FROM invitations
        WHERE landlord_id = ANY($1::uuid[]) AND status = 'pending'
        ORDER BY created_at DESC`, [landlordIds])

    // 10/12 review (deploy order): the Team page sends a company-wide-only
    // bookkeeper as propertyIds [] + companyWide, and an untick-everything edit
    // as propertyIds []. The API before 10/12 dropped companyWide and read []
    // as "every property, the whole company". This flag tells the page it is
    // talking to an API that reads the boxes as boxes; without it the page
    // saves no bookkeeper (apps/landlord TeamPage), so a frontend that reaches
    // production ahead of this API can never widen anyone.
    // 10/12 (Nic): bookkeeperMoreBoxes says the same of the ledger, whole-company
    // reports and monthly report boxes: an API from before them would drop
    // them, so the page shows them only when this API reads them.
    res.json({ success: true, data: { members, invitations, bookkeeperBoxes: true, bookkeeperMoreBoxes: true } })
  } catch (e) { next(e) }
})

// PATCH /api/scopes/property_manager/:userId/direct-deposit — landlord
// flips the per-manager Connect opt-in toggle. Only valid for the
// property_manager role; other worker roles have no rent-share allocation
// path so they don't need a Connect account. On false→true, an in-app
// notification fires to the manager telling them to onboard.
//
// S168: locks the CLAUDE.md spec — manager Connect is opt-in by the
// landlord, default off. Allocation_manager_fee Stripe Transfers
// silent-skip until the manager completes Connect onboarding.
scopesRouter.patch(
  '/property_manager/:userId/direct-deposit',
  requirePerm('team.manage_permissions'),
  async (req, res, next) => {
    try {
      const landlordIds = await teamLandlordIds(req)
      const body = z.object({ enabled: z.boolean() }).parse(req.body)

      // S236: self-target guard. CLAUDE.md spec: manager Connect is
      // opt-in by the LANDLORD, default off. A manager with
      // team.manage_permissions managing another manager is delegated
      // team work; a manager flipping their own toggle is privilege
      // escalation around the landlord's financial-routing decision.
      if (req.user!.role === 'property_manager' && req.params.userId === req.user!.userId) {
        throw new AppError(403, 'Managers cannot flip their own direct-deposit toggle. Ask your landlord to enable it.')
      }

      // Snapshot the prior state so we only fire the notification on a
      // genuine false→true transition, not on idempotent re-enables.
      const before = await queryOne<{ direct_deposit_enabled: boolean }>(
        `SELECT direct_deposit_enabled
           FROM property_manager_scopes
          WHERE user_id = $1 AND landlord_id = ANY($2::uuid[])`,
        [req.params.userId, landlordIds])
      if (!before) throw new AppError(404, 'Scope row not found')

      const updated = await queryOne<any>(
        `UPDATE property_manager_scopes
            SET direct_deposit_enabled = $1, updated_at = NOW()
          WHERE user_id = $2 AND landlord_id = ANY($3::uuid[])
          RETURNING *`,
        [body.enabled, req.params.userId, landlordIds])
      const landlordId: string = updated.landlord_id

      if (body.enabled && !before.direct_deposit_enabled) {
        const manager = await queryOne<{ email: string; first_name: string }>(
          `SELECT email, first_name FROM users WHERE id = $1`,
          [req.params.userId])
        if (manager) {
          const inviterName = await getInviterName(landlordId)
          const portalBase = portalUrl('landlord')
          createNotification({
            userId:    req.params.userId,
            landlordId,
            type:      'manager_direct_deposit_enabled',
            title:     'Direct Deposit Enabled — Set Up Stripe Connect',
            body:      `${inviterName} enabled direct deposit on your account. ` +
                       `Visit Banking in the portal to complete Stripe Connect onboarding ` +
                       `before your manager fees can be paid out.`,
            data:      { landlordId, portalUrl: `${portalBase}/banking` },
            sendEmail: true,
            emailTo:   manager.email,
            emailSubject: 'Direct Deposit Enabled — Action Required',
          }).catch(e => logger.error({ err: e }, '[NOTIFY] manager direct-deposit enable'))
        }
      }

      res.json({ success: true, data: updated })
    } catch (e) { next(e) }
  }
)

// GET /api/scopes/property_manager/:userId/connect-status — returns the
// manager's live Stripe Connect account state so the landlord can see
// exactly which KYC items the manager hasn't filled in. Verifies the
// caller actually employs this manager (scope row exists under their
// landlord_id) before proxying to Stripe. Stripe errors propagate.
//
// S168 follow-on: complement to the direct-deposit toggle. When a
// manager sits on "Awaiting onboarding" or "Verifying" for too long,
// the landlord can drill into requirements_currently_due to nudge them
// with specifics ("you need to upload an ID document" beats "finish
// stripe onboarding").
scopesRouter.get(
  '/property_manager/:userId/connect-status',
  requirePerm('team.manage_permissions'),
  async (req, res, next) => {
    try {
      const landlordIds = await teamLandlordIds(req)

      // Authorize: caller must employ this manager.
      const scope = await queryOne<{ id: string }>(
        `SELECT id FROM property_manager_scopes
          WHERE user_id = $1 AND landlord_id = ANY($2::uuid[])`,
        [req.params.userId, landlordIds])
      if (!scope) throw new AppError(404, 'Manager not found in your team')

      const userRow = await queryOne<{ stripe_connect_account_id: string | null }>(
        `SELECT stripe_connect_account_id FROM users WHERE id = $1`,
        [req.params.userId])
      const connectAccountId = userRow?.stripe_connect_account_id ?? null
      if (!connectAccountId) {
        return res.json({ success: true, data: { exists: false } })
      }

      const status = await fetchAccountStatus(connectAccountId)
      res.json({ success: true, data: { exists: true, connectAccountId, ...status } })
    } catch (e) { next(e) }
  }
)

// GET /api/scopes/:roleType — scoped users + invitations for this role
scopesRouter.get('/:roleType', requirePerm('team.invite', 'team.manage_permissions'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordIds = await teamLandlordIds(req)
    const table = SCOPE_TABLES[role]

    const users = await query<any>(
      `SELECT s.*, u.email, u.first_name, u.last_name, u.phone
       FROM ${table} s
       JOIN users u ON u.id = s.user_id
       WHERE s.landlord_id = ANY($1::uuid[])
       ORDER BY s.created_at DESC`,
      [landlordIds])

    // S654: by name, never the token.
    const invitations = await query<any>(
      `SELECT ${INVITATION_COLUMNS} FROM invitations
       WHERE landlord_id = ANY($1::uuid[]) AND role = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [landlordIds, role])

    res.json({ success: true, data: { users, invitations } })
  } catch (e) { next(e) }
})

// POST /api/scopes/:roleType/invite
scopesRouter.post('/:roleType/invite', requirePerm('team.invite'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordId = await getLandlordIdFromReq(req)

    const body = z.object({
      email: z.string().email(),
      scope: z.any(),
      // Pre-fill fields — the landlord enters the staff member's identity on
      // the Team form; they ride the invitation so the accept page can
      // populate them. All optional (the invitee can still type their own).
      firstName: z.string().trim().min(1).optional(),
      lastName:  z.string().trim().min(1).optional(),
      phone:     z.string().trim().optional(),
    }).parse(req.body)
    const scope = validateScopePayload(role, body.scope)
    if (role === 'bookkeeper') {
      // 10/12 (Nic): any property boxes and/or the company-wide box; a company
      // with no property yet may have a company-wide bookkeeper. Nothing at
      // all is refused. Staff give only properties they manage, and the
      // company-wide box only with company-wide access of their own.
      scope.propertyIds = await bookkeeperPropertyIds(
        landlordId, scope.propertyIds, await callerPropertyLimit(req, landlordId))
      if (!scope.propertyIds.length && !scope.companyWide) throw new AppError(400, NOTHING_TICKED)
      // 10/12 (Nic): every box ticked must be the inviter's to give.
      await assertBoxesTheirsToGive(req, landlordId, {}, scope)
      // 10/12 (Nic, L19): money coming in beyond the default is the owner's to give.
      if (scope.moneyInFiling !== DEFAULT_BOOKKEEPER_MONEY_IN_FILING && !['landlord', 'admin', 'super_admin'].includes(String(req.user?.role ?? ''))) {
        throw new AppError(403, OWNER_CHOOSES_MONEY_IN)
      }
    }

    // W-10 (S529): staff are PERMANENTLY locked to the property they are
    // added to — so the property must be chosen at invite time.
    if (role === 'onsite_manager' && !scope.propertyIds.length && !scope.allProperties) {
      throw new AppError(400, 'Pick the property this staff member belongs to — it is fixed once they are added')
    }

    // Onsite manager uniqueness: one landlord per user, platform-wide
    if (role === 'onsite_manager') {
      const existing = await queryOne<any>(
        `SELECT 1 FROM onsite_manager_scopes s
         JOIN users u ON u.id = s.user_id
         WHERE lower(u.email) = lower($1) LIMIT 1`, [body.email])
      if (existing) throw new AppError(409, 'This user is already an on-site manager for another landlord')
    }

    // Block duplicate pending invite (same landlord + role + email)
    const dup = await queryOne<any>(
      `SELECT id FROM invitations
       WHERE landlord_id=$1 AND role=$2 AND lower(email)=lower($3) AND status='pending'
       LIMIT 1`,
      [landlordId, role, body.email])
    if (dup) throw new AppError(409, 'A pending invitation already exists for this email')

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const invRes = await client.query(
        `INSERT INTO invitations
           (email, landlord_id, role, scope_payload, invited_by_user_id, token, expires_at,
            first_name, last_name, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${INVITATION_COLUMNS}`,
        [body.email, landlordId, role, JSON.stringify(scope),
         req.user!.userId, token, expiresAt,
         body.firstName || null, body.lastName || null, body.phone || null])
      const invitation = invRes.rows[0]

      await client.query(
        `INSERT INTO platform_events
           (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.created', $2, $3)`,
        [invitation.id, req.user!.userId, JSON.stringify({ role, email: body.email })])

      await client.query('COMMIT')

      const inviterName = await getInviterName(landlordId)
      // 10/5: replies reach the person who sent this invite (services/replyRouting).
      emailInvitation(body.email, inviterName, role, buildAcceptUrl(token),
        { landlordId, invitationId: invitation.id, replyTo: { kind: 'person', userId: req.user!.userId } })
        .catch(e => logger.error({ err: e }, '[EMAIL] invite failed'))

      res.status(201).json({ success: true, data: invitation })
    } catch (e: any) {
      await client.query('ROLLBACK')
      if (e?.code === '23505' && e?.constraint === 'invitations_unique_pending') {
        throw new AppError(409, 'A pending invitation already exists for this email')
      }
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// PATCH /api/scopes/:roleType/:userId/permissions — sub-permission toggle update.
// S80 / Item 8a. Replaces full-scope PATCH for the permissions field only.
// Bookkeeper rejected — use PATCH /scopes/bookkeeper/:userId for their boxes.
// 10/12 (Nic): a bookkeeper has no permission toggles and no access level (one level).
scopesRouter.patch('/:roleType/:userId/permissions', requirePerm('team.manage_permissions'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    if (role === 'bookkeeper') throw new AppError(400, 'A bookkeeper has no permission toggles. Change what they keep with their boxes on the Team page.')
    const landlordIds = await teamLandlordIds(req)
    const body = z.object({ permissions: z.record(z.boolean()) }).parse(req.body)
    const table = SCOPE_TABLES[role]

    // S236: self-edit guard. Without this, a property_manager who has
    // `team.manage_permissions` could grant themselves every other
    // sub-permission in the catalog — a permanent privilege escalation
    // around the landlord's intended scope. Owner roles (admin /
    // super_admin / landlord) bypass since they hold all perms by
    // definition.
    if (req.user!.role === 'property_manager' && req.params.userId === req.user!.userId) {
      throw new AppError(403, 'Managers cannot edit their own permissions. Ask your landlord to update them.')
    }

    const updated = await queryOne<any>(
      `UPDATE ${table} SET permissions = $1, updated_at = NOW()
        WHERE user_id = $2 AND landlord_id = ANY($3::uuid[]) RETURNING *`,
      [JSON.stringify(body.permissions), req.params.userId, landlordIds])
    if (!updated) throw new AppError(404, 'Scope row not found')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/scopes/:roleType/:userId — update scope row
scopesRouter.patch('/:roleType/:userId', requirePerm('team.manage_permissions'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordIds = await teamLandlordIds(req)
    const scope = role === 'bookkeeper'
      ? parseBookkeeperScope(bkScopePatchSchema, req.body)
      : validateScopePayload(role, req.body)

    // S236: self-edit guard. Same reasoning as the /permissions
    // sibling — a manager could grant themselves access to additional
    // properties/units (or for PM, set their own approval ceiling)
    // without the landlord's knowledge.
    if (req.user!.role === 'property_manager' && req.params.userId === req.user!.userId) {
      throw new AppError(403, 'Managers cannot edit their own scope. Ask your landlord to update it.')
    }

    let updated: any = null
    switch (role) {
      case 'property_manager':
        updated = await queryOne<any>(
          `UPDATE property_manager_scopes SET
             property_ids = $1, unit_ids = $2, all_properties = $3,
             maint_approval_ceiling_cents = $4, updated_at = NOW()
           WHERE user_id = $5 AND landlord_id = ANY($6::uuid[]) RETURNING *`,
          [scope.propertyIds, scope.unitIds, scope.allProperties,
           scope.maintApprovalCeilingCents, req.params.userId, landlordIds])
        break
      case 'onsite_manager': {
        // W-10 (S529, Nic decision): the property binding is PERMANENT —
        // fixed when the person is added, never edited after. Moving someone
        // means removing them and re-inviting at the new property. Legacy
        // rows with no property yet get one first-set.
        const existing = await queryOne<any>(
          `SELECT property_ids FROM onsite_manager_scopes
            WHERE user_id = $1 AND landlord_id = ANY($2::uuid[])`,
          [req.params.userId, landlordIds])
        if (!existing) throw new AppError(404, 'Scope row not found')
        const cur: string[] = existing.property_ids || []
        const changed = cur.length &&
          (cur.length !== scope.propertyIds.length || cur.some((id: string) => !scope.propertyIds.includes(id)))
        if (changed) {
          throw new AppError(409, 'Property assignment is permanent. To move this person to another property, remove them and re-invite them there.')
        }
        updated = await queryOne<any>(
          `UPDATE onsite_manager_scopes SET
             property_ids = $1, unit_ids = $2, updated_at = NOW()
           WHERE user_id = $3 AND landlord_id = ANY($4::uuid[]) RETURNING *`,
          [cur.length ? cur : scope.propertyIds, scope.unitIds, req.params.userId, landlordIds])
        break
      }
      case 'maintenance':
        updated = await queryOne<any>(
          `UPDATE maintenance_worker_scopes SET
             property_ids = $1, unit_ids = $2, job_categories = $3,
             all_properties = $4, updated_at = NOW()
           WHERE user_id = $5 AND landlord_id = ANY($6::uuid[]) RETURNING *`,
          [scope.propertyIds, scope.unitIds, scope.jobCategories,
           scope.allProperties, req.params.userId, landlordIds])
        break
      case 'bookkeeper': {
        // 10/11: change which properties they keep (10/12: and their boxes;
        // one level, so no access level). A field left out stays as it is; ticking nothing
        // was refused by the schema above. Their company cannot change: a
        // bookkeeper for another company is a new invitation.
        const raw = (req.body ?? {}) as { landlordId?: string }
        // The row the Team page names (one per company they keep), else their oldest.
        const target = typeof raw.landlordId === 'string' && landlordIds.includes(raw.landlordId)
          ? [raw.landlordId] : landlordIds
        const existing = await queryOne<{
          landlord_id: string; access_level: string; property_ids: string[] | null
          company_wide: boolean; show_lease_dates: boolean; kept_count: number
          company_ledger: boolean; whole_company_reports: boolean; sees_monthly_report: boolean
          money_in_filing: string
        }>(
          `SELECT landlord_id, access_level, property_ids, ${companyWideSql('bs')} AS company_wide, show_lease_dates,
                  company_ledger, whole_company_reports, sees_monthly_report, money_in_filing,
                  cardinality(${keptIdsSql('bs')}) AS kept_count
             FROM bookkeeper_scopes bs
            WHERE user_id = $1 AND landlord_id = ANY($2::uuid[])
            ORDER BY created_at LIMIT 1`, [req.params.userId, target])
        if (!existing) throw new AppError(404, 'Scope row not found')
        // Staff change a bookkeeper only inside their own properties, and give
        // only properties inside them (10/12: and the company-wide box only
        // with company-wide access of their own).
        const limit = await callerPropertyLimit(req, existing.landlord_id)
        await assertBookkeeperWithinCaller(req, limit, req.params.userId, existing.landlord_id)
        const propertyIds = scope.propertyIds !== undefined
          ? await bookkeeperPropertyIds(existing.landlord_id, scope.propertyIds, limit)
          : existing.property_ids
        const companyWide = scope.companyWide ?? existing.company_wide
        // 10/12 (Nic): the ledger, whole-company reports and monthly report boxes.
        const companyLedger = scope.companyLedger ?? existing.company_ledger
        const wholeCompanyReports = scope.wholeCompanyReports ?? existing.whole_company_reports
        const seesMonthlyReport = scope.seesMonthlyReport ?? existing.sees_monthly_report
        // A box turned on must be the caller's to give (staff: only what they hold).
        await assertBoxesTheirsToGive(req, existing.landlord_id,
          { companyWide: existing.company_wide, companyLedger: existing.company_ledger,
            wholeCompanyReports: existing.whole_company_reports, seesMonthlyReport: existing.sees_monthly_report },
          { companyWide, companyLedger, wholeCompanyReports, seesMonthlyReport })
        // 10/12: a change to what is ticked may not leave nothing at all. (A
        // change to the lease-dates box alone stands: a
        // bookkeeper whose only property was sold keeps its history, ticked or not.)
        if (scope.propertyIds !== undefined || scope.companyWide !== undefined) {
          const keptAfter = scope.propertyIds !== undefined ? (propertyIds ?? []).length : existing.kept_count
          if (!keptAfter && !companyWide) throw new AppError(400, NOTHING_TICKED)
        }
        // 10/12 (Nic, L19): money coming in — the owner's choice alone.
        const moneyInFiling = scope.moneyInFiling ?? existing.money_in_filing
        if (moneyInFiling !== existing.money_in_filing && !['landlord', 'admin', 'super_admin'].includes(String(req.user?.role ?? ''))) {
          throw new AppError(403, OWNER_CHOOSES_MONEY_IN)
        }
        updated = await queryOne<any>(
          `UPDATE bookkeeper_scopes SET
             access_level = $1, property_ids = $2, company_wide = $3, show_lease_dates = $4,
             company_ledger = $7, whole_company_reports = $8, sees_monthly_report = $9, money_in_filing = $10,
             updated_at = NOW()
           WHERE user_id = $5 AND landlord_id = $6 RETURNING *`,
          // 10/12 (Nic): one level — an access level sent by an older screen changes nothing.
          [BOOKKEEPER_ONE_LEVEL, propertyIds, companyWide,
           scope.showLeaseDates ?? existing.show_lease_dates,
           req.params.userId, existing.landlord_id,
           companyLedger, wholeCompanyReports, seesMonthlyReport, moneyInFiling])
        break
      }
    }
    if (!updated) throw new AppError(404, 'Scope row not found')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// DELETE /api/scopes/:roleType/:userId — remove scope row (revoke access)
//
// 10/11: ?landlordId= names the company they stop working for. A person can
// keep the books (or work) for two companies of one account; this removed them
// from every one of the account's companies when the owner meant one. With no
// company named, a person on more than one of them is asked about, not removed
// from all of them.
scopesRouter.delete('/:roleType/:userId', requirePerm('team.manage_permissions'), async (req, res, next) => {
  try {
    const role = req.params.roleType
    if (!isAssignableRole(role)) throw new AppError(400, 'Invalid roleType')
    const landlordIds = await teamLandlordIds(req)
    const table = SCOPE_TABLES[role]

    const named = typeof req.query.landlordId === 'string' ? req.query.landlordId : null
    if (named && !landlordIds.includes(named)) throw new AppError(404, 'Scope row not found')
    const rows = await query<{ landlord_id: string }>(
      `SELECT landlord_id FROM ${table} WHERE user_id = $1 AND landlord_id = ANY($2::uuid[])`,
      [req.params.userId, named ? [named] : landlordIds])
    if (!rows.length) throw new AppError(404, 'Scope row not found')
    if (rows.length > 1) {
      throw new AppError(400, 'They work for more than one of your companies. Say which company to remove them from.')
    }
    const landlordId = rows[0].landlord_id
    if (role === 'bookkeeper') {
      await assertBookkeeperWithinCaller(req, await callerPropertyLimit(req, landlordId), req.params.userId, landlordId)
    }

    const deleted = await queryOne<any>(
      `DELETE FROM ${table} WHERE user_id = $1 AND landlord_id = $2 RETURNING *`,
      [req.params.userId, landlordId])
    if (!deleted) throw new AppError(404, 'Scope row not found')
    res.json({ success: true, data: deleted })
  } catch (e) { next(e) }
})

// POST /api/scopes/invitations/:id/resend — new token, reset expiry
scopesRouter.post('/invitations/:id/resend', requirePerm('team.invite'), async (req, res, next) => {
  try {
    const landlordId = await getLandlordIdFromReq(req)
    const inv = await queryOne<any>(
      `SELECT * FROM invitations WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, landlordId])
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'pending') throw new AppError(400, 'Only pending invitations can be resent')

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const upd = await client.query(
        `UPDATE invitations SET token = $1, expires_at = $2 WHERE id = $3 RETURNING ${INVITATION_COLUMNS}`,
        [token, expiresAt, inv.id])
      await client.query(
        `INSERT INTO platform_events (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.resent', $2, '{}'::jsonb)`,
        [inv.id, req.user!.userId])
      await client.query('COMMIT')

      const inviterName = await getInviterName(landlordId)
      // 10/5: replies reach the person who re-sent this invite (services/replyRouting).
      emailInvitation(inv.email, inviterName, inv.role, buildAcceptUrl(token),
        { landlordId, invitationId: inv.id, resend: true, replyTo: { kind: 'person', userId: req.user!.userId } })
        .catch(e => logger.error({ err: e }, '[EMAIL] resend failed'))

      res.json({ success: true, data: upd.rows[0] })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// POST /api/scopes/invitations/:id/revoke
scopesRouter.post('/invitations/:id/revoke', requirePerm('team.invite'), async (req, res, next) => {
  try {
    const landlordId = await getLandlordIdFromReq(req)
    const inv = await queryOne<any>(
      `SELECT * FROM invitations WHERE id = $1 AND landlord_id = $2`,
      [req.params.id, landlordId])
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status !== 'pending') throw new AppError(400, 'Only pending invitations can be revoked')

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const upd = await client.query(
        `UPDATE invitations SET status='revoked', revoked_at=NOW(), revoked_by_user_id=$1
         WHERE id=$2 RETURNING ${INVITATION_COLUMNS}`,
        [req.user!.userId, inv.id])
      await client.query(
        `INSERT INTO platform_events (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.revoked', $2, '{}'::jsonb)`,
        [inv.id, req.user!.userId])
      await client.query('COMMIT')
      res.json({ success: true, data: upd.rows[0] })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ── Public invitation router (no auth) ────────────────────────────

export const invitationsRouter = Router()

/**
 * 10/12 (Nic): a bookkeeper invitation's boxes, for the accept page's summary
 * (packages/shared bookkeeperAccessSummary). Counts and flags only.
 */
function bookkeeperAccessOf(raw: unknown): BookkeeperAccessChoice {
  let p: any = raw ?? {}
  if (typeof p === 'string') { try { p = JSON.parse(p) } catch { p = {} } }
  return {
    companyWide: p?.companyWide === true,
    showLeaseDates: p?.showLeaseDates === true,
    propertyCount: Array.isArray(p?.propertyIds) ? p.propertyIds.length : 0,
    // 10/12 (Nic): the ledger, whole-company reports and monthly report boxes.
    companyLedger: p?.companyLedger === true,
    wholeCompanyReports: p?.wholeCompanyReports === true,
    seesMonthlyReport: p?.seesMonthlyReport === true,
  }
}

// GET /api/invitations/:token — accept-screen payload
invitationsRouter.get('/:token', async (req, res, next) => {
  try {
    const inv = await queryOne<any>(
      `SELECT i.*, u.first_name as inviter_first, u.last_name as inviter_last,
              l.business_name as inviter_business
       FROM invitations i
       LEFT JOIN users u ON u.id = i.invited_by_user_id
       LEFT JOIN landlords l ON l.id = i.landlord_id
       WHERE i.token = $1`,
      [req.params.token])
    if (!inv) throw new AppError(404, 'Invitation not found')

    if (inv.status === 'pending' && new Date(inv.expires_at) > new Date()) {
      await query(
        `INSERT INTO platform_events (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.viewed', NULL, '{}'::jsonb)`,
        [inv.id])
    }

    const existingUser = await queryOne<any>(
      `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [inv.email])

    res.json({
      success: true,
      data: {
        id:          inv.id,
        email:       inv.email,
        role:        inv.role,
        status:      inv.status,
        expiresAt:   inv.expires_at,
        inviterName: inv.inviter_business
          || [inv.inviter_first, inv.inviter_last].filter(Boolean).join(' ')
          || 'Your landlord',
        userExists:  !!existingUser,
        // Landlord-provided pre-fill so the accept page can populate these.
        firstName:   inv.first_name || null,
        lastName:    inv.last_name || null,
        phone:       inv.phone || null,
        // 10/12 (Nic): what a bookkeeper invitation gives, so the accept page
        // says it (bookkeeperAccessSummary, packages/shared) — the bank account
        // and payroll only when the company-wide box is ticked. Boxes only:
        // no property is named to whoever holds the link.
        ...(inv.role === 'bookkeeper' ? { bookkeeperAccess: bookkeeperAccessOf(inv.scope_payload) } : {}),
      }
    })
  } catch (e) { next(e) }
})

/**
 * S654: read the caller's session when they sent one, without demanding it.
 * A new invitee has no account yet and accepts with the emailed link alone; an
 * existing account accepts only from its own session (see the accept route).
 * A malformed or expired token still gets requireAuth's 401.
 */
function sessionIfSent(req: any, res: any, next: any) {
  if (!String(req.headers?.authorization ?? '').startsWith('Bearer ')) return next()
  return requireAuth(req, res, next)
}

const ACCEPT_FROM_OWN_ACCOUNT =
  'This email already has a GAM account. Sign in to that account, then open this link again to accept.'

// POST /api/invitations/:token/accept
invitationsRouter.post('/:token/accept', sessionIfSent, async (req, res, next) => {
  try {
    const body = z.object({
      password:  z.string().min(8).optional(),
      firstName: z.string().min(1).optional(),
      lastName:  z.string().min(1).optional(),
      phone:     z.string().optional(),
    }).parse(req.body)

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Lock the invitation row to prevent double-accept races
      const invRes = await client.query(
        `SELECT * FROM invitations WHERE token = $1 FOR UPDATE`,
        [req.params.token])
      const inv = invRes.rows[0]
      if (!inv) throw new AppError(404, 'Invitation not found')
      if (inv.status !== 'pending') throw new AppError(400, `Invitation is ${inv.status}`)
      if (new Date(inv.expires_at) <= new Date()) throw new AppError(400, 'Invitation has expired')

      const role = inv.role as LandlordAssignableRole
      if (!isAssignableRole(role)) throw new AppError(500, 'Invitation has invalid role')

      // Find or create the user
      const userRes = await client.query(
        `SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1`,
        [inv.email])
      let user = userRes.rows[0]

      if (!user) {
        if (!body.password) throw new AppError(400, 'Password required for new account')
        if (!body.firstName || !body.lastName) throw new AppError(400, 'First and last name required')
        const hash = await bcrypt.hash(body.password, 12)
        const newUser = await client.query(
          // email_verified=TRUE: clicking the invite link (delivered to this
          // exact address) proves email ownership, so the staff member is
          // verified on accept — no separate verification step to block login.
          `INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
                              email_verified, email_verified_at)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW()) RETURNING *`,
          [inv.email, hash, role, body.firstName, body.lastName, body.phone || null])
        user = newUser.rows[0]
      } else {
        // S654: an account that already exists says yes from its OWN session.
        // This asked for no login at all, so whoever held the link attached the
        // person: landlord B invited landlord A's property manager, accepted
        // with an empty body, and A's manager was on B's team (and could then be
        // put in B's landlord signing seat) without ever being asked. The link
        // proves who can read a mailbox, not who agreed. Same check as the
        // co-owner accept (landlords.ts member-invite): the signed-in login must
        // be the account on the invitation's address, and one login per address
        // in any letter case means that is the same id. Checked before anything
        // about the account is said back.
        if (!req.user || req.user.userId !== user.id) {
          throw new AppError(403, ACCEPT_FROM_OWN_ACCOUNT)
        }
        // Existing account: only allow accept if existing role matches the invite role.
        // A landlord/tenant/admin cannot be rewritten into a worker role by accepting.
        // A worker role user can take additional scope with another landlord only if
        // the invite is for the same worker role they already have.
        if (user.role !== role) {
          throw new AppError(409, `This email is already registered as ${user.role}`)
        }
      }

      // Scope-row uniqueness per landlord + user
      const table = SCOPE_TABLES[role]
      const existingScope = await client.query(
        `SELECT 1 FROM ${table} WHERE user_id = $1 AND landlord_id = $2 LIMIT 1`,
        [user.id, inv.landlord_id])
      if (existingScope.rows.length) throw new AppError(409, 'Scope already exists for this user and landlord')

      const scopePayload = typeof inv.scope_payload === 'string'
        ? JSON.parse(inv.scope_payload)
        : inv.scope_payload
      const scopeRow = await insertScopeRow(client, role, user.id, inv.landlord_id, scopePayload)

      await client.query(
        `UPDATE invitations
         SET status = 'accepted', accepted_at = NOW(), accepted_user_id = $1
         WHERE id = $2`,
        [user.id, inv.id])

      await client.query(
        `INSERT INTO platform_events (subject_type, subject_id, event_type, actor_user_id, payload)
         VALUES ('invitation', $1, 'invitation.accepted', $2, '{}'::jsonb)`,
        [inv.id, user.id])

      await client.query('COMMIT')
      res.json({ success: true, data: { userId: user.id, role, scope: scopeRow } })
    } catch (e: any) {
      await client.query('ROLLBACK')
      // S349: the invite-time onsite-manager uniqueness guard (scopes.ts:378)
      // is racy — two landlords can each create pending invites for the
      // same email before either is accepted. The schema enforces
      // platform-wide one-landlord-per-onsite-manager via
      // UNIQUE(user_id) on onsite_manager_scopes; pre-S349 the
      // accept-time race produced a 500 with the raw postgres
      // constraint-violation message. Translate to a clean 409.
      if (e?.code === '23505' && e?.constraint === 'onsite_manager_scopes_user_id_key') {
        return next(new AppError(409, 'This user is already an on-site manager for another landlord'))
      }
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})
