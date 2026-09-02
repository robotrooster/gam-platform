/**
 * S620: which entities a request may read from.
 *
 * Nic's co-owner opened Oak Park and saw "0 units, 0 of 0 occupied". The
 * property listed — that query scopes differently — while its units were
 * filtered to his OWN entity: the empty one registering created so he could
 * accept the invite. Oak Park is his entity too; that is what co-ownership
 * means.
 *
 * The failure mode worth remembering is that NOTHING ERRORED. Occupancy,
 * amenities and the unit grid are all unit-derived, so one empty query blanked
 * half the page and it looked like the park had no units.
 */
import { describe, it, expect } from 'vitest'
import { landlordScopeIds } from './landlordScope'
import type { AuthPayload } from '../middleware/auth'

const user = (o: Partial<AuthPayload>): AuthPayload => ({
  userId: 'u1', role: 'landlord', email: 'x@y.z', profileId: 'own', ...o,
} as AuthPayload)

describe('landlordScopeIds', () => {
  it('includes the entities a landlord co-owns, not just their own', () => {
    expect(landlordScopeIds(user({ landlordIds: ['own', 'oakpark'] })).sort())
      .toEqual(['oakpark', 'own'])
  })

  it('still works for a landlord with only their own entity', () => {
    expect(landlordScopeIds(user({ landlordIds: ['own'] }))).toEqual(['own'])
  })

  it('S633: a landlord session with no landlordIds scopes to NOTHING, not to profileId', () => {
    // The old behaviour fell back to profileId so a pre-S553 token kept its own
    // book. S633 removes that on purpose: profileId no longer names an entity
    // for a landlord (routes/auth.ts mints it null), so falling back to it would
    // scope queries to a value that is either null or, worse, some other role's
    // profile row — that exact fallback let a TENANT's profileId read as a
    // company.
    //
    // Nothing is lost by removing it, because the token is no longer the source:
    // requireAuth refreshes landlordIds from `landlord_members` UNION
    // `landlords.user_id` on every landlord request (see middleware/auth.ts
    // currentLandlordIds), so an older token gets a correct, current set before
    // any scope check runs. An empty array here means "genuinely no companies",
    // and callers refuse on it rather than running an unfiltered query.
    expect(landlordScopeIds(user({ landlordIds: null }))).toEqual([])
    expect(landlordScopeIds(user({ landlordIds: undefined }))).toEqual([])
  })

  it('de-duplicates a repeated entity', () => {
    expect(landlordScopeIds(user({ landlordIds: ['own', 'own'] }))).toEqual(['own'])
  })

  it('S633: a TENANT never resolves a landlord scope from their profileId', () => {
    // profileId for a tenant is their `tenants.id`. The pre-S633 fallback
    // returned [that tenant id], which read downstream as "this account owns
    // exactly one company" and would have handed a tenant id back as the company
    // to write against. Caught by the terminal suite when its "no landlord scope
    // → 400" case started returning 200.
    expect(landlordScopeIds(user({ role: 'tenant' as any, profileId: 'tenant-row-id' }))).toEqual([])
  })

  it('leaves team roles exactly as they were — landlordId, not profileId', () => {
    // For a team member profileId is their USER id, which never matches
    // units.landlord_id. Widening that would have been a security change, not
    // a fix; this keeps the pre-existing resolution.
    expect(landlordScopeIds(user({
      role: 'onsite_manager' as any, profileId: 'user-id', landlordId: 'the-landlord',
    }))).toEqual(['the-landlord'])
  })

  it('returns nothing when there is nothing to scope to', () => {
    // An empty scope must produce an empty filter the caller can refuse on,
    // never an unfiltered query.
    expect(landlordScopeIds(user({
      role: 'onsite_manager' as any, profileId: '', landlordId: null,
    }))).toEqual([])
  })
})
