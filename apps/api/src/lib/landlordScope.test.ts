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

  it('handles a session minted before co-ownership existed', () => {
    // landlordIds is absent on older tokens; they must not lose their own book.
    expect(landlordScopeIds(user({ landlordIds: null }))).toEqual(['own'])
    expect(landlordScopeIds(user({ landlordIds: undefined }))).toEqual(['own'])
  })

  it('de-duplicates when profileId also appears in the list', () => {
    expect(landlordScopeIds(user({ landlordIds: ['own', 'own'] }))).toEqual(['own'])
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
