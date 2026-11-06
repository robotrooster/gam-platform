/**
 * The paid top spot — the price, and where it lands.
 *
 * Nic's sentence is the test, in his words (10/31):
 *
 *   "Paid spot per trade per area code should be based on cost of living in the
 *    area. LA/NY prices don't touch Wyoming or Oklahoma."
 *
 * So the cases below are mostly about REAL PLACES, read out of the live table
 * of published figures rather than fixtures: if a re-price ever puts Tulsa and
 * Los Angeles within shouting distance of each other, that sentence is broken
 * and this file says so.
 */
import fs from 'fs'
import path from 'path'
import { describe, it, expect, beforeAll } from 'vitest'
import { db, query } from '../db'
import {
  requirePlacementRate, areaByKey, areaById, quotePlacement, areaForPlace,
  searchAreas, placementSchedule, currentIndexYear,
} from './marketplacePlacement'
import { placementMonthlyFromIndex, PLACEMENT_BASE_MONTHLY } from '@gam/shared'

/**
 * The REAL published areas, loaded by running their own migration.
 *
 * Not a fixture, on purpose: a fixture would prove the arithmetic and nothing
 * about whether Oklahoma actually costs less than California, which is the only
 * thing Nic asked for. `gam_test` carries the schema but not data a migration
 * seeded, so the file is run here — it is written to be replay-safe (a DELETE
 * scoped to its own source and year ahead of the INSERT), so running it again
 * lands on the same 439 rows and this doubles as proof of that.
 *
 * No cleanup: both tables are price cards, FK-free and in CLEANUP_KEEPS for the
 * same reason the Flex grids are.
 */
beforeAll(async () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations')
  for (const f of ['20261101030000_marketplace_areas.sql',
                   '20261101031000_marketplace_placement_rates.sql']) {
    await db.query(fs.readFileSync(path.join(dir, f), 'utf8'))
  }
})

/** The area whose name contains this, at the current index year. */
async function area(nameLike: string) {
  const year = await currentIndexYear()
  const rows = await query<{ id: string; name: string; cost_index: number }>(
    `SELECT id, name, cost_index::float8 AS cost_index FROM marketplace_areas
      WHERE index_year = $1 AND name LIKE '%' || $2 || '%' ORDER BY length(name) LIMIT 1`,
    [year, nameLike])
  if (!rows[0]) throw new Error(`no area matching ${nameLike}`)
  return rows[0]
}

const priceAt = async (nameLike: string) => {
  const a = await area(nameLike)
  return requirePlacementRate(a.cost_index)
}

describe('the schedule says what Nic said it should', () => {
  it('LA and New York do not touch Oklahoma', async () => {
    const la = await priceAt('Los Angeles-Long Beach')
    const ny = await priceAt('New York-Newark')
    const okc = await priceAt('Oklahoma City')
    const tulsa = await priceAt('Tulsa')
    const ruralOk = await priceAt('Oklahoma, outside')
    // Not "a bit more" — the spread he asked for is multiples. Los Angeles and
    // New York are $120; Tulsa and rural Oklahoma are $25.
    expect(la).toBeGreaterThan(okc * 3)
    expect(ny).toBeGreaterThan(okc * 3)
    expect(la).toBeGreaterThan(tulsa * 4)
    expect(ny).toBeGreaterThan(ruralOk * 4)
  })

  it('and they do not touch Wyoming', async () => {
    const la = await priceAt('Los Angeles-Long Beach')
    for (const wy of ['Casper', 'Cheyenne', 'Wyoming, outside']) {
      expect(la, wy).toBeGreaterThan((await priceAt(wy)) * 2.5)
    }
  })

  it('Phoenix — where GAM actually operates — sits above the national average', async () => {
    const phx = await priceAt('Phoenix-Mesa')
    expect(phx).toBeGreaterThan(PLACEMENT_BASE_MONTHLY)
    // $70 against the $55 of an average-cost area: Phoenix is dearer, and not
    // by so much that a park operator's own contractors are priced out.
    // And below the coastal top, which is the shape of the curve.
    expect(phx).toBeLessThan(await priceAt('San Francisco-Oakland'))
  })

  it('the dearest spot in the country lands where he put it, $100-120', async () => {
    const rows = await query<{ hi: string; lo: string }>(
      `SELECT MAX(monthly_price)::text AS hi, MIN(monthly_price)::text AS lo
         FROM marketplace_placement_rates`)
    // 10/31 (Nic): "Make it cheaper in the cheap area so the curve lands at
    // 100-120." Both ends are asserted, because the cheap end is the half he
    // came back to twice: a one-truck operator in rural Oklahoma pays less than
    // a single Angi lead, and the competition's monthly package starts at $300.
    expect(Number(rows[0].hi)).toBeGreaterThanOrEqual(100)
    expect(Number(rows[0].hi)).toBeLessThanOrEqual(120)
    expect(Number(rows[0].lo)).toBeLessThanOrEqual(20)
  })
})

describe('the bands and the base formula agree', () => {
  it('every band matches $55 x (index/100)^6 within the rounding of a band', async () => {
    const year = await currentIndexYear()
    const rows = await query<{ cost_index: number; monthly_price: string; name: string }>(
      `SELECT a.name, a.cost_index::float8 AS cost_index, r.monthly_price::text AS monthly_price
         FROM marketplace_areas a
         JOIN marketplace_placement_rates r
           ON a.cost_index >= r.index_min AND a.cost_index < r.index_max
        WHERE a.index_year = $1`, [year])
    expect(rows.length).toBeGreaterThan(400)
    for (const r of rows) {
      const formula = placementMonthlyFromIndex(r.cost_index)
      // A band is a step and the formula is a curve, so they differ by at most
      // half a step. $10 is the worst case across all 439 areas (Albany, OR at
      // 102.1, which sits just inside the 102-106 band and is priced off its
      // middle).
      expect(Math.abs(Number(r.monthly_price) - formula), r.name).toBeLessThanOrEqual(10)
    }
  })

  it('a dearer area never costs less', async () => {
    const bands = await placementSchedule()
    expect(bands.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].monthlyPrice, `band ${i}`).toBeGreaterThan(bands[i - 1].monthlyPrice)
      // And no gap between the bands, or an area would fall through one.
      expect(bands[i].indexMin).toBe(bands[i - 1].indexMax)
    }
    expect(bands[0].indexMin).toBe(0)
  })

  it('every published area has a price — the schedule has no holes', async () => {
    const rows = await query<{ n: string; name: string | null }>(
      `SELECT COUNT(*)::text AS n, MIN(a.name) AS name FROM marketplace_areas a
        WHERE NOT EXISTS (
          SELECT 1 FROM marketplace_placement_rates r
           WHERE a.cost_index >= r.index_min AND a.cost_index < r.index_max)`)
    expect(Number(rows[0].n), `first uncovered: ${rows[0].name}`).toBe(0)
  })
})

describe('a missing price is a refusal, never a free spot', () => {
  it('an index above every band refuses', async () => {
    await expect(requirePlacementRate(100000)).rejects.toThrow(/not for sale/i)
  })

  it('an area with no cost of living refuses rather than falling to the bottom band', async () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      await expect(requirePlacementRate(bad as number)).rejects.toThrow(/cannot be priced/i)
    }
  })

  it('a schedule that is not in effect yet is not quoted', async () => {
    // The whole card is dated 2020-01-01, so a day before it has no price at
    // all — which is the behaviour that stops an evening quote reading
    // tomorrow's schedule.
    await expect(requirePlacementRate(100, '2019-12-31')).rejects.toThrow(/not for sale/i)
  })
})

describe('finding the area a contractor is in', () => {
  it('a city inside a metro lands on that metro', async () => {
    const a = await areaForPlace({ city: 'Mesa', state: 'AZ' })
    expect(a?.area_kind).toBe('metro')
    expect(a?.name).toMatch(/Phoenix/)
  })

  it('a town in no metro lands on the rest of the state, never on another state', async () => {
    const a = await areaForPlace({ city: 'Nowhere Gulch', state: 'WY' })
    expect(a?.area_kind).toBe('state_rural')
    expect(a?.states).toEqual(['WY'])
  })

  it('a city name that exists in another state does not drag them across the line', async () => {
    // There is a Portland in both Oregon and Maine.
    const or = await areaForPlace({ city: 'Portland', state: 'OR' })
    const me = await areaForPlace({ city: 'Portland', state: 'ME' })
    expect(or?.states).toContain('OR')
    expect(me?.states).toContain('ME')
    expect(or?.id).not.toBe(me?.id)
  })

  it('no state means no guess', async () => {
    expect(await areaForPlace({ city: 'Mesa', state: null })).toBeNull()
    expect(await areaForPlace({ city: null, state: '  ' })).toBeNull()
  })

  it('a metro that crosses a state line is reachable from either side', async () => {
    const ny = await areaForPlace({ city: 'New York', state: 'NY' })
    expect(ny?.states).toEqual(expect.arrayContaining(['NY', 'NJ']))
  })
})

describe('the quote a screen shows', () => {
  it('carries the price and where the figure came from', async () => {
    const a = await area('Phoenix-Mesa')
    const q = await quotePlacement(a.id)
    expect(q.monthlyPrice).toBeGreaterThan(0)
    expect(q.indexSource).toMatch(/Regional Price Parities/)
    expect(q.indexYear).toBeGreaterThanOrEqual(2024)
    expect(q.area.name).toMatch(/Phoenix/)
  })

  it('an area nobody has a cost of living for is a 404, not a default price', async () => {
    await expect(quotePlacement('00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/not one GAM has a cost of living for/i)
  })
})

describe('the picker', () => {
  it('finds metros by name and whole states by their letters', async () => {
    const byName = await searchAreas('Tulsa')
    expect(byName.map(a => a.name).join('|')).toMatch(/Tulsa/)
    const byState = await searchAreas('WY')
    expect(byState.length).toBeGreaterThan(0)
    // Two letters means the state, so Wyoming's areas come first — but
    // Grand Rapids-WYOMING-Kentwood, MI is a real place somebody might be
    // looking for, so it is ranked below rather than thrown away.
    expect(byState[0].states).toContain('WY')
    const wyFirst = byState.findIndex(a => !a.states.includes('WY'))
    if (wyFirst !== -1) {
      for (const a of byState.slice(wyFirst)) expect(a.states).not.toContain('WY')
    }
  })

  it('reads one index year, so a refresh cannot list a place twice', async () => {
    const year = await currentIndexYear()
    const all = await searchAreas('', 500)
    for (const a of all) expect(a.index_year).toBe(year)
    const keys = all.map(a => `${a.area_kind}:${a.area_key}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('an area read by key is the same one read by id', async () => {
    const byKey = await areaByKey('state_rural', 'WY')
    expect(byKey).not.toBeNull()
    const byId = await areaById(byKey!.id)
    expect(byId!.area_key).toBe('WY')
  })
})
