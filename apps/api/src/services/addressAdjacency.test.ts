/**
 * S616 — are these two spaces near enough to be the same place?
 *
 * Nic threw out the street-level version for the right reason: it gated on the
 * ONE field nobody is sure of. "Whatever I'm gonna name my next door neighbor's
 * thing as should be irrelevant to the matchup... a landlord may not want to
 * put that in, or put it incorrectly. If it's a multiunit building they're not
 * gonna know which unit it is... It could be next door but the address could be
 * way different, because it could be a corner lot facing on the other street.
 *
 * So we just need to look at: one, match it to the name; two, match it to the
 * same town; three, match it to them already having a user profile."
 *
 * So the GATE here is the town. The person is enforced by the caller
 * (crossPropertyAutoLink). A street-level agreement still improves the recorded
 * evidence — it just cannot refuse anything.
 */
import { describe, it, expect } from 'vitest'
import { compareAddresses } from './addressAdjacency'

const OAK_PARK = { street1: '22658 Highway 89', city: 'Yarnell', state: 'AZ', zip: '85362' }

describe('address adjacency (S616)', () => {
  it('the typed service address IS the other landlord’s address', () => {
    const r = compareAddresses(
      '1442 W Second St',
      OAK_PARK,
      { street1: '1442 West Second Street', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(true)
    expect(r.basis).toBe('same_address')
  })

  // Two people writing one place differently is the normal case, not the edge.
  it('shrugs off abbreviation and directional differences', () => {
    const r = compareAddresses(
      '22660 Hwy 89',
      OAK_PARK,
      { street1: '22660 N State Route 89', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(true)
  })

  it('a few doors down is still next door', () => {
    const r = compareAddresses(
      '1450 W Second St',
      OAK_PARK,
      { street1: '1442 W Second St', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(true)
    expect(r.basis).toBe('same_street')
  })

  // THE CASE THAT DROVE THE CHANGE. A corner lot is literally next door and
  // carries an address on a different street; the old rule refused it.
  it('a different street in the same town still matches', () => {
    const r = compareAddresses(
      '1442 W Second St',
      OAK_PARK,
      { street1: '1444 W Third St', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(true)
    expect(r.basis).toBe('same_town')
  })

  it('and so does a landlord who typed nothing at all', () => {
    const r = compareAddresses(null, OAK_PARK,
      { street1: '1444 W Third St', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(true)
    expect(r.basis).toBe('same_town')
  })

  it('a wrong or vague description no longer blocks anything', () => {
    const r = compareAddresses(
      'the blue house behind the shop',
      OAK_PARK,
      { street1: '1442 W Second St', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(true)
  })

  // The whole point of Nic's objection: this must work where GAM holds no
  // parcel data and no coordinates.
  it('works in a state with no parcel corpus and no coordinates', () => {
    const ohioA = { street1: '118 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43302' }
    const r = compareAddresses(
      '122 Bellefontaine Ave',
      ohioA,
      { street1: '122 Bellefontaine Avenue', city: 'Marion', state: 'OH', zip: '43302' })
    expect(r.matched).toBe(true)
    expect(r.basis).toBe('same_address')
  })

  it('records the street when the two properties do line up', () => {
    const r = compareAddresses(
      null,
      { street1: '118 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43302' },
      { street1: '122 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43302' })
    expect(r.matched).toBe(true)
    expect(r.basis).toBe('same_street')
  })

  // The one thing that still refuses. Two properties in different towns cannot
  // be one physical place, whatever the streets say.
  it('a different town is a different place', () => {
    const r = compareAddresses(
      null,
      { street1: '118 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43302' },
      { street1: '122 Bellefontaine Ave', city: 'Toledo', state: 'OH', zip: '43606' })
    expect(r.matched).toBe(false)
  })

  // Numbered and named streets repeat in every town in the country. Without a
  // locality gate the typed service address — which rarely carries a postcode —
  // matches an identical street line a thousand miles away and calls it the
  // SAME ADDRESS.
  // A five-digit STREET NUMBER is not a postcode. Oak Park's own address is
  // "22658 Highway 89", and a bare five-digit scan read that as its zip —
  // which made the strongest branch decide the postcodes disagreed and quietly
  // downgrade a same-address match.
  it('does not mistake a five-digit street number for a postcode', () => {
    const r = compareAddresses(
      '22660 Highway 89',
      OAK_PARK,
      { street1: '22660 Highway 89', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.basis).toBe('same_address')
  })

  it('a same-numbered street in another state does not match', () => {
    const r = compareAddresses(
      '1442 W Second St',
      { street1: '900 Main St', city: 'Yarnell', state: 'AZ', zip: '85362' },
      { street1: '1442 W Second St', city: 'Akron', state: 'OH', zip: '44301' })
    expect(r.matched).toBe(false)
    expect(r.evidence).toContain('not in the same town')
  })

  // Postcode boundaries genuinely run down the middle of some streets, so two
  // neighbours on opposite sides of one must not be refused.
  it('tolerates a postcode boundary when the town agrees', () => {
    const r = compareAddresses(
      '122 Bellefontaine Ave',
      { street1: '118 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43302' },
      { street1: '122 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43306' })
    expect(r.matched).toBe(true)
  })
})
