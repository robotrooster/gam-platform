/**
 * S609 (Nic): how many photos a unit needs before it can be listed.
 *
 * "RV spots to be published for rent on the booking site or anywhere else we're
 * planning on listing it — make the required photos one, because people are
 * bringing their own unit. When we are booking something like an Airbnb style
 * situation where there's interior pictures to be had, make it five, like for
 * apartments."
 *
 * The rule lives in packages/shared and is consumed in TWO places that must
 * agree: the SQL that decides what the public listing query returns, and the
 * landlord's "N more photos needed" badge. A badge promising a different number
 * than the query enforces is how a landlord uploads what they were asked for and
 * still sees nothing published.
 */
import { describe, it, expect } from 'vitest'
import {
  listingMinPhotos,
  LISTING_MIN_PHOTOS_DEFAULT,
  LISTING_MIN_PHOTOS_BY_UNIT_TYPE,
  UNIT_TYPES,
} from '@gam/shared'
import { db } from '../db'

describe('S609 listing photo minimum', () => {
  it('a bare site needs ONE photo — the renter brings the dwelling', () => {
    expect(listingMinPhotos('rv_spot')).toBe(1)
    expect(listingMinPhotos('campsite')).toBe(1)
    expect(listingMinPhotos('parking')).toBe(1)
    expect(listingMinPhotos('storage')).toBe(1)
  })

  it('somewhere people live inside needs five', () => {
    expect(listingMinPhotos('apartment')).toBe(5)
    expect(listingMinPhotos('single_family')).toBe(5)
    expect(listingMinPhotos('mobile_home')).toBe(5)
    expect(listingMinPhotos('hotel_room')).toBe(5)
  })

  it('an unknown type falls back to the dwelling standard, not the bare-site one', () => {
    // The safe direction: a new interior type must not quietly inherit "1".
    expect(listingMinPhotos('something_new_entirely')).toBe(LISTING_MIN_PHOTOS_DEFAULT)
    expect(LISTING_MIN_PHOTOS_DEFAULT).toBe(5)
  })

  it('every type named in the override map is a real unit type', () => {
    // A typo here would silently give that type the 5-photo default forever.
    for (const t of Object.keys(LISTING_MIN_PHOTOS_BY_UNIT_TYPE)) {
      expect(UNIT_TYPES as readonly string[]).toContain(t)
    }
  })

  it('the generated SQL CASE is valid and matches the TypeScript rule', async () => {
    // routes/properties builds this CASE from the same map. If the two ever
    // disagree — or the SQL stops parsing — a landlord is told one thing and the
    // listing query does another.
    const caseSql = `CASE u.unit_type ${
      Object.entries(LISTING_MIN_PHOTOS_BY_UNIT_TYPE)
        .map(([t, n]) => `WHEN '${t}' THEN ${n}`)
        .join(' ')
    } ELSE ${LISTING_MIN_PHOTOS_DEFAULT} END`

    const types = ['rv_spot', 'apartment', 'storage', 'mobile_home', 'commercial']
    const res = await db.query<{ unit_type: string; min_photos: number }>(
      `SELECT t AS unit_type, (${caseSql.replace(/u\.unit_type/g, 't')})::int AS min_photos
         FROM unnest($1::text[]) AS t`,
      [types])
    for (const row of res.rows) {
      expect(row.min_photos).toBe(listingMinPhotos(row.unit_type))
    }
  })
})
