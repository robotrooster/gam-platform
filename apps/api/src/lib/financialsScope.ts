/**
 * 10/11 (Nic) — WHOSE MONEY THE FINANCIAL PAGES SHOW.
 *
 *   "a bookkeeper in the bookkeeper portal scoped to certain properties should
 *    see those properties in the bookkeeper portal as well. We're treating them
 *    as two different things and it's not."
 *
 * One set of financial pages serves the owner and their bookkeeper, in the
 * landlord portal and in GAM Books (apps/{landlord,books}/src/financials). One
 * answer to "which companies and properties does this viewer's money come
 * from", read by every route those pages call, so a page can never show an
 * owner one thing and a bookkeeper another by accident:
 *
 *   owner       every company the account owns (GAM Books narrows to the one
 *               it has open, by X-Client-Id); every property of them
 *   bookkeeper  their one company, and the properties they keep there — put
 *               on the request by requireAuth, worked out fresh on every
 *               request (lib/bookkeeperScope). 10/12 (Nic): null only with
 *               the company-wide box AND every property the company owns
 *               today ticked (BK3: a property that left the company without
 *               being theirs is hidden whole by `cutoffs` — lib/bookkeeperScope
 *               requestScopeOf); else the
 *               ticked ones still the company's plus the former ones (sold or
 *               moved out while they kept them), whose rows after the day
 *               they left are cut (`cutoffs`). The bank account and payouts
 *               follow the company-wide box alone (refuseWithoutCompanyWide).
 *               BK1: `ledger` (the Books ledger) and the monthly report box
 *               ride along for the menus (GET /financials/scope).
 *
 * `?propertyId=` narrows further, and only ever inside the scope: a property
 * that is not theirs is refused, never quietly widened or emptied.
 */
import { query } from '../db'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds, isEntityMember } from './landlordScope'
import { bookkeeperRequestScopeOf } from '../middleware/auth'
import { companyWideRefusal, KEEPS_NOTHING, type PropertyCutoff, type FormerProperty } from './bookkeeperScope'

export interface FinancialsScope {
  viewer: 'owner' | 'bookkeeper'
  /** The companies whose money this request reads. Never empty. */
  landlordIds: string[]
  /** null = every property of those companies and their money on no property
   *  (an owner, or a bookkeeper with the company-wide box and every property
   *  ticked); else only these — the kept properties and the former ones. 10/12:
   *  may be empty (a company-wide-only bookkeeper reads no property's money). */
  propertyIds: string[] | null
  /** True when the viewer keeps only SOME of a company's money. */
  narrowed: boolean
  /** 10/12 (Nic): the company-wide box — the bank account, payouts, payroll and
   *  the company's Books reports. Always true for an owner. */
  companyWide: boolean
  /** 10/12: lease start and end dates on the rent roll. Always true for an owner. */
  showLeaseDates: boolean
  /** 10/12 (Nic, BK1): the whole-company Books ledger — the company-wide box or
   *  the ledger box. Always true for an owner. */
  ledger: boolean
  /** 10/12 (Nic): the monthly property report on screen. Always true for an owner. */
  seesMonthlyReport: boolean
  /** 10/12 (Nic): the clean cut at a sale — a former property's rows after its
   *  last day are left out by every reader. [] for an owner. */
  cutoffs: PropertyCutoff[]
  /** 10/12: the properties that left the company while the bookkeeper kept them
   *  (read only, up to the day they left). [] for an owner. */
  former: FormerProperty[]
}

const UUID = /^[0-9a-f-]{36}$/i

export async function financialsScope(req: any): Promise<FinancialsScope> {
  const user = req.user
  if (!user) throw new AppError(401, 'Unauthenticated')
  let scope: FinancialsScope
  if (user.role === 'landlord') {
    let ids = landlordScopeIds(user)
    // GAM Books names the company it has open; the landlord portal names none
    // and reads every company the account owns.
    const header = req.headers?.['x-client-id']
    const named = Array.isArray(header) ? header[0] : header
    if (named) {
      if (!UUID.test(String(named)) || !(await isEntityMember(user, String(named), query))) {
        throw new AppError(403, 'That company is not yours.')
      }
      ids = [String(named)]
    }
    if (!ids.length) throw new AppError(400, 'No company on this account yet.')
    scope = { viewer: 'owner', landlordIds: ids, propertyIds: null, narrowed: false,
              companyWide: true, showLeaseDates: true, ledger: true, seesMonthlyReport: true, cutoffs: [], former: [] }
  } else if (user.role === 'bookkeeper') {
    if (!user.landlordId) throw new AppError(403, "You have not been given any company's books yet.")
    // requireAuth puts their properties on the request. A pass without them (a
    // job, a test helper, a route mounted some other way) reads the scope row:
    // never "the whole company" by default, which would hand a bookkeeper kept
    // to some properties every one of them.
    const bk = await bookkeeperRequestScopeOf(user)
    // 10/12: refused only when they keep nothing at all — no company-wide box,
    // no property, no former property. A company-wide-only bookkeeper passes
    // (the bank account, payouts) and reads no property's money ([]).
    if (bk.keepsNothing) throw new AppError(403, KEEPS_NOTHING)
    scope = {
      viewer: 'bookkeeper', landlordIds: [user.landlordId], propertyIds: bk.propertyIds,
      narrowed: bk.propertyIds !== null, companyWide: bk.companyWide, showLeaseDates: bk.showLeaseDates,
      ledger: bk.ledger, seesMonthlyReport: bk.seesMonthlyReport,
      cutoffs: bk.cutoffs, former: bk.former,
    }
  } else {
    throw new AppError(403, 'The financial pages are for owners and their bookkeepers.')
  }
  return narrowToProperty(scope, req.query?.propertyId)
}

/**
 * `?propertyId=`: one property, which must be inside the scope. 10/12: a
 * former property may be picked too — its history up to the day it left
 * (the scope's cutoffs still apply), never after.
 */
export async function narrowToProperty(scope: FinancialsScope, raw: unknown): Promise<FinancialsScope> {
  const propertyId = typeof raw === 'string' ? raw.trim() : ''
  if (!propertyId) return scope
  if (!UUID.test(propertyId)) throw new AppError(400, 'That is not a property.')
  const former = scope.former.some(f => f.propertyId === propertyId)
  if (!former && !(await propertyInScope(scope, propertyId))) {
    throw new AppError(403, 'That property is not in your books.')
  }
  return { ...scope, propertyIds: [propertyId] }
}

/**
 * Is this property one of the scope's, owned by its company TODAY? (Company
 * AND, when narrowed, the list.) 10/12: a former property is not — it left
 * the company, so nothing is filed on it; narrowToProperty reads its history.
 */
export async function propertyInScope(scope: FinancialsScope, propertyId: string | null | undefined): Promise<boolean> {
  if (!propertyId || !UUID.test(propertyId)) return false
  if (scope.propertyIds !== null && !scope.propertyIds.includes(propertyId)) return false
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one FROM properties WHERE id = $1 AND landlord_id = ANY($2::uuid[])`,
    [propertyId, scope.landlordIds])
  return rows.length > 0
}

/**
 * The properties a scope reads, for the page's property picker. 10/12: a
 * bookkeeper's former properties follow the company's own, each with
 * `leftOn` — the last day its history is theirs (null on a current property).
 */
export async function scopeProperties(scope: FinancialsScope): Promise<Array<{ id: string; name: string; landlordId: string; leftOn: string | null }>> {
  const rows = await query<{ id: string; name: string; landlord_id: string }>(
    `SELECT id, name, landlord_id FROM properties
      WHERE landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY name, id`,
    [scope.landlordIds, scope.propertyIds])
  const current = rows.map(r => ({ id: r.id, name: r.name, landlordId: r.landlord_id, leftOn: null as string | null }))
  const former = scope.former
    .filter(f => !current.some(c => c.id === f.propertyId))
    .filter(f => scope.propertyIds === null || scope.propertyIds.includes(f.propertyId))
    .map(f => ({ id: f.propertyId, name: f.name, landlordId: scope.landlordIds[0], leftOn: f.lastDay }))
  return [...current, ...former]
}

/**
 * 10/12 (Nic): the bank account and payouts are in the company-wide box — the
 * owner's own choice per bookkeeper, never inferred from the property boxes.
 * A bookkeeper without it is told so, in words, rather than handed the
 * company's bank. Owners always pass. (Books' company ledger and reports use
 * the same box: routes/books, routes/reports refuseScopedStaff.)
 */
export function refuseWithoutCompanyWide(scope: FinancialsScope, what: string): void {
  if (!scope.companyWide) throw new AppError(403, companyWideRefusal(what))
}
