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
 *   bookkeeper  their one company, and its properties they were given
 *               (bookkeeper_scopes.property_ids; NULL = all of them) — put on
 *               the request by requireAuth, fresh from the scope table
 *
 * `?propertyId=` narrows further, and only ever inside the scope: a property
 * that is not theirs is refused, never quietly widened or emptied.
 */
import { query } from '../db'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds, isEntityMember } from './landlordScope'
import { bookkeeperPropertyIdsOf } from '../middleware/auth'

export interface FinancialsScope {
  viewer: 'owner' | 'bookkeeper'
  /** The companies whose money this request reads. Never empty. */
  landlordIds: string[]
  /** null = every property of those companies; else only these (never empty). */
  propertyIds: string[] | null
  /** True when the viewer keeps only SOME of a company's properties. */
  narrowed: boolean
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
    scope = { viewer: 'owner', landlordIds: ids, propertyIds: null, narrowed: false }
  } else if (user.role === 'bookkeeper') {
    if (!user.landlordId) throw new AppError(403, "You have not been given any company's books yet.")
    // requireAuth puts their properties on the request. A pass without them (a
    // job, a test helper, a route mounted some other way) reads the scope row:
    // never "the whole company" by default, which would hand a bookkeeper kept
    // to some properties every one of them.
    const props = await bookkeeperPropertyIdsOf(user)
    if (Array.isArray(props) && props.length === 0) {
      throw new AppError(403, "You have not been given any company's books yet.")
    }
    scope = { viewer: 'bookkeeper', landlordIds: [user.landlordId], propertyIds: props, narrowed: props !== null }
  } else {
    throw new AppError(403, 'The financial pages are for owners and their bookkeepers.')
  }
  return narrowToProperty(scope, req.query?.propertyId)
}

/** `?propertyId=`: one property, which must be inside the scope. */
export async function narrowToProperty(scope: FinancialsScope, raw: unknown): Promise<FinancialsScope> {
  const propertyId = typeof raw === 'string' ? raw.trim() : ''
  if (!propertyId) return scope
  if (!UUID.test(propertyId)) throw new AppError(400, 'That is not a property.')
  if (!(await propertyInScope(scope, propertyId))) {
    throw new AppError(403, 'That property is not in your books.')
  }
  return { ...scope, propertyIds: [propertyId] }
}

/** Is this property one of the scope's? (Company AND, when narrowed, the list.) */
export async function propertyInScope(scope: FinancialsScope, propertyId: string | null | undefined): Promise<boolean> {
  if (!propertyId || !UUID.test(propertyId)) return false
  if (scope.propertyIds !== null && !scope.propertyIds.includes(propertyId)) return false
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one FROM properties WHERE id = $1 AND landlord_id = ANY($2::uuid[])`,
    [propertyId, scope.landlordIds])
  return rows.length > 0
}

/** The properties a scope reads, for the page's property picker. */
export async function scopeProperties(scope: FinancialsScope): Promise<Array<{ id: string; name: string; landlordId: string }>> {
  const rows = await query<{ id: string; name: string; landlord_id: string }>(
    `SELECT id, name, landlord_id FROM properties
      WHERE landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY name, id`,
    [scope.landlordIds, scope.propertyIds])
  return rows.map(r => ({ id: r.id, name: r.name, landlordId: r.landlord_id }))
}

/**
 * A company-wide figure (the bank account, payouts) cannot be cut by property:
 * a bookkeeper who keeps some of a company's properties is told so, in words,
 * rather than handed every property's money. Same rule as the company
 * documents (routes/reports refuseScopedStaff).
 */
export function refuseNarrowed(scope: FinancialsScope, what: string): void {
  if (scope.narrowed) {
    throw new AppError(403,
      `${what} covers the whole company, and you keep the books for some of its properties. Ask the owner for it.`)
  }
}
