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
import { computeActionGap } from './actionGap'

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
    // Printed rather than summarised: the failure message IS the work list.
    expect(forgotten, forgotten.length
      ? `\nThese have no agent action and no stated reason:\n  ${forgotten.join('\n  ')}\n` +
        'Either add an action to portalActions.ts, or name it in DELIBERATE in ' +
        'actionGap.ts with why it is not one.\n'
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
    expect(gap.covered.length).toBeGreaterThanOrEqual(227)
  })
})
