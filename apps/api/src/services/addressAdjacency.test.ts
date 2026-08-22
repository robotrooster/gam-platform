/**
 * S616 — deciding, from addresses alone, whether GAM may ask three people
 * about a link.
 *
 * Nic threw out the first version: "Don't use the Arizona parcel data... It
 * can't be gated on data that we don't have everywhere else yet. It needs to be
 * address matched." These cases are the shapes real addresses actually take —
 * Oak Park's own highway address, an ordinary numbered street, and the ways two
 * people write the same place differently.
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

  it('the far end of the same street is NOT next door', () => {
    const r = compareAddresses(
      '1442 W Second St',
      OAK_PARK,
      { street1: '2810 W Second St', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(false)
  })

  it('a different street is not a match, however close the numbers', () => {
    const r = compareAddresses(
      '1442 W Second St',
      OAK_PARK,
      { street1: '1444 W Third St', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(false)
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

  it('falls back to the two properties when no service address was typed', () => {
    const r = compareAddresses(
      null,
      { street1: '118 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43302' },
      { street1: '122 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43302' })
    expect(r.matched).toBe(true)
    expect(r.basis).toBe('same_street')
  })

  it('a different town is a different place', () => {
    const r = compareAddresses(
      null,
      { street1: '118 Bellefontaine Ave', city: 'Marion', state: 'OH', zip: '43302' },
      { street1: '122 Bellefontaine Ave', city: 'Toledo', state: 'OH', zip: '43606' })
    expect(r.matched).toBe(false)
  })

  // A miss costs a SUGGESTION, never the feature — a person can still propose.
  it('says plainly that it could not tell, and why that is not the end of it', () => {
    const r = compareAddresses(
      'the blue house behind the shop',
      OAK_PARK,
      { street1: '1442 W Second St', city: 'Yarnell', state: 'AZ', zip: '85362' })
    expect(r.matched).toBe(false)
    expect(r.evidence).toContain('can still propose it')
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
