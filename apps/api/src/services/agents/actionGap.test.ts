/**
 * S628 — THE GAP IS ZERO, AND THIS IS WHAT KEEPS IT THERE.
 *
 * Nic: "anything I could get on and do as a landlord, I should be able to tell
 * the agent to do. It cannot do anything that is not relevant to our software."
 *
 * Both halves are now measurable and both are asserted here. Every mutating
 * endpoint a landlord or tenant agent could reach either HAS an agent action or
 * is NAMED in DELIBERATE with the reason it does not — a signature, a file, a
 * credential, a permission change, another product's surface.
 *
 * The point of the test rather than the script is what happens NEXT session. A
 * number nothing asserts drifts back the moment somebody adds a route, and the
 * drift is invisible: the agent simply cannot do a thing nobody noticed it
 * could not do. This makes "I did not think about it" fail at CPU speed, and
 * forces the decision to be written down either way.
 */
import { describe, it, expect } from 'vitest'
import { computeActionGap, mounts } from './actionGap'

describe('action parity — the gap stays closed', () => {
  const gap = computeActionGap()

  it('the surface is roughly the size we think it is', () => {
    // A large move either way means routes were added in bulk, or the silo list
    // rotted and is now hiding a whole product's endpoints.
    expect(gap.all.length).toBeGreaterThan(250)
    expect(gap.all.length).toBeLessThan(450)
  })

  it('every endpoint is either reachable or deliberately not — nothing is merely forgotten', () => {
    const forgotten = gap.open.map((e) => `${e.area} ${e.declared}`)
    // Printed rather than summarized: the failure message IS the work list.
    expect(forgotten, forgotten.length
      ? `\nThese have no agent action and no stated reason:\n  ${forgotten.join('\n  ')}\n` +
        'Either add an action to portalActions.ts, or name it in DELIBERATE in ' +
        'actionGap.ts with why it is not one.\n'
      : '').toEqual([])
  })

  it('a router that shares its mount path with another router is still counted', () => {
    // 10/4 gate: mounts were keyed by path, so the LAST router on '/api/leases'
    // (leasesRouter) hid paidAheadChoiceRouter, and unitsRouter hid
    // stayCheckOutRouter on '/api/units' — both read as "not mounted" and their
    // money endpoints left the count without anyone deciding anything.
    const shared = new Map<string, string[]>()
    for (const [base, r] of mounts()) shared.set(base, [...(shared.get(base) ?? []), r])
    expect(shared.get('/api/leases')).toEqual(expect.arrayContaining(['paidAheadChoiceRouter', 'leasesRouter']))
    expect(shared.get('/api/units')).toEqual(expect.arrayContaining(['stayCheckOutRouter', 'unitsRouter']))
    const counted = new Set(gap.all.map((e) => `${e.area} ${e.declared}`))
    for (const k of [
      'paidAheadChoice POST /:leaseId/paid-ahead-choice',
      'paidAheadChoice POST /:leaseId/paid-ahead-choice/parts/:partId/retry',
      'paidAheadChoice POST /:leaseId/paid-ahead-choice/parts/:partId/cash',
      'stayCheckOut POST /:unitId/bookings/:bookingId/check-out',
      'leases POST /:id/never-moved-in',
    ]) expect(counted.has(k), k).toBe(true)
    // Each endpoint is keyed by its own router's mount, not a neighbour's.
    const choice = gap.all.find((e) => e.declared === 'POST /:leaseId/paid-ahead-choice')!
    expect(choice.key).toBe('POST /api/leases/:x/paid-ahead-choice')
  })

  it('the move-out money presses are deliberately left to the screen, each with its reason', () => {
    // decisions #46/#47/#48.4 and #44: every one of these moves money or says
    // where it went, pressed on a screen read fresh at that moment.
    const named = new Set(gap.deliberate.map((e) => `${e.area} ${e.declared}`))
    for (const k of [
      'leases POST /:id/deposit-return/send-back',
      'leases POST /:id/deposit-return/refund-parts/:partId/try-again',
      'leases POST /:id/deposit-return/refund-parts/:partId/cash',
      'leases POST /:id/deposit-return/landlord-part/handed-back',
      'leases POST /:id/deposit-return/landlord-part/undo',
      'leases POST /:id/never-moved-in',
      'bankFeed POST /deposits/:id/not-rent/undo',
      'payments POST /pay-balance/release',
      'payments POST /pay-balance/resume',
      'paidAheadChoice POST /:leaseId/paid-ahead-choice',
      'paidAheadChoice POST /:leaseId/paid-ahead-choice/parts/:partId/retry',
      'paidAheadChoice POST /:leaseId/paid-ahead-choice/parts/:partId/cash',
      'stayCheckOut POST /:unitId/bookings/:bookingId/check-out',
      'stayCheckOut POST /:unitId/bookings/:bookingId/check-out/parts/:partId/retry',
      'stayCheckOut POST /:unitId/bookings/:bookingId/check-out/parts/:partId/cash-instead',
    ]) expect(named.has(k), k).toBe(true)
  })

  it('the never-moved-in reason says it zeroes only the move-in bill, as #53 decided', () => {
    // 10/4 gate review: the reason read "zeroes what they never paid", which
    // tells the next reader every unpaid bill goes. #53: only the move-in bill;
    // later bills stay owed; refused if the guest was ever checked in.
    const why = gap.deliberate.find((e) => `${e.area} ${e.declared}` === 'leases POST /:id/never-moved-in')!.why
    expect(why).toMatch(/ONLY the unpaid move-in bill/)
    expect(why).toMatch(/later unpaid bills stay owed/)
    expect(why).toMatch(/ever checked in/)
    expect(why).toMatch(/#53/)
  })

  it('no deliberate exclusion outlives its route — every named key is still declared by a route file', () => {
    // A removed or renamed route left its reason behind and nothing noticed:
    // siloed areas (pos, admin) are never counted, so matching against the
    // counted endpoints could not tell a stale entry from a siloed one.
    expect(gap.staleDeliberate, gap.staleDeliberate.length
      ? `\nThese DELIBERATE entries name a route no route file declares:\n  ${gap.staleDeliberate.join('\n  ')}\n` +
        'Remove the entry, or fix its key to the route\'s new path.\n'
      : '').toEqual([])
  })

  it('every deliberate exclusion carries a reason somebody can read', () => {
    for (const e of gap.deliberate) {
      expect(e.why, `${e.area} ${e.declared}`).toBeTruthy()
      // "no" or "n/a" is not a reason. A later session has to be able to tell
      // a decision from an oversight without re-deriving it.
      expect(e.why.length, `${e.area} ${e.declared}: "${e.why}"`).toBeGreaterThan(12)
    }
  })

  it('the hand-built map has not rotted — every tool it names still exists', () => {
    // These endpoints are covered by tools that write SQL directly, so the
    // mapping has to be stated. A renamed or deleted tool would silently widen
    // "covered" and hide a real gap.
    expect(gap.missingTools).toEqual([])
  })

  it('does not shrink — coverage may rise, never fall', () => {
    // S626 ended at 98 of 341 by the old area-level count. S628 ends at 228 of
    // 328 counted per endpoint, with the remaining 100 named.
    // S637: 228 → 227. The covered endpoint POST /tenants/me/nudge-landlord-banking
    // was DELETED (Nic, DIRECTIVE: nothing forward-facing tells a tenant about the
    // landlord's bank account), taking its agent tool with it. Coverage fell
    // because the surface shrank, not because a gap opened.
    // 10/4 (gate review): 236 → 234. finalize_deposit_return and
    // confirm_deposit_match moved to DELIBERATE under decisions #38 Q6 (the
    // assistant makes no money decision). Still above the floor; the floor is
    // not raised because a money action leaving is not a gap opening.
    expect(gap.covered.length).toBeGreaterThanOrEqual(227)
  })
})
