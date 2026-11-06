/**
 * The paid top spot — where it can be bought and what it costs there.
 *
 * 10/31 (Nic): "Paid spot per trade per area code should be based on cost of
 * living in the area. LA/NY prices don't touch Wyoming or Oklahoma. Let's
 * figure a base formula and a monthly rate schedule."
 *
 * Joining the marketplace is free and stays free. What is for sale is POSITION:
 * one contractor at the top of one trade in one area, with the free board open
 * to everybody underneath. That is the whole difference from the lead-selling
 * model — "they don't have to worry about paying for leads that might not be
 * there."
 *
 * TWO TABLES, each doing one job:
 *
 *   marketplace_areas            where, and how expensive it is to live there
 *   marketplace_placement_rates  what a month costs in that band
 *
 * The index is BEA Regional Price Parity, published per metro area and per
 * state. It is NOT published per telephone area code, which is why the
 * territory is a metro (or the rest of a state) rather than an area code: every
 * price has to trace to a number somebody else published.
 *
 * A BAND WITH NO ROW IS AN ERROR AND NEVER A FREE SPOT. Same discipline as the
 * FlexPay, FlexDeposit and job-financing grids — a missing price must not be
 * able to degrade into zero.
 */
import type { MarketplaceAreaKind } from '@gam/shared'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'

export interface MarketplaceArea {
  id: string
  area_kind: MarketplaceAreaKind
  area_key: string
  name: string
  states: string[]
  cost_index: number
  index_source: string
  index_year: number
}

const AREA_SELECT = `
  id, area_kind, area_key, name, states, cost_index::float8 AS cost_index,
  index_source, index_year`

/**
 * The newest index year on file.
 *
 * BEA publishes a new year each December and a refresh ADDS rows rather than
 * updating them, so "which year do we price off" is a question with an answer
 * in the data and not a constant anybody has to remember to bump.
 */
export async function currentIndexYear(): Promise<number> {
  const row = await queryOne<{ y: number | null }>(
    `SELECT MAX(index_year)::int AS y FROM marketplace_areas`)
  if (!row?.y) {
    throw new AppError(500,
      'No cost-of-living figures are on file, so a top spot cannot be priced.')
  }
  return row.y
}

/**
 * What a month at the top of one trade in one area costs.
 *
 * `on` is a day on GAM's own calendar, never a UTC date: a schedule that comes
 * into effect tomorrow must not be quoted this evening.
 */
export async function requirePlacementRate(costIndex: number, on?: string): Promise<number> {
  if (!Number.isFinite(costIndex) || costIndex <= 0) {
    throw new AppError(500,
      'That area has no cost-of-living figure, so a top spot there cannot be priced.')
  }
  const day = on ?? todayIn(null)
  const row = await queryOne<{ monthly_price: string }>(
    `SELECT monthly_price::text AS monthly_price
       FROM marketplace_placement_rates
      WHERE $1::numeric >= index_min AND $1::numeric < index_max
        AND effective_from <= $2::date
      ORDER BY effective_from DESC
      LIMIT 1`,
    [costIndex, day])
  if (!row) {
    // Never a zero. A gap in the schedule means nobody decided a price for this
    // band, which is a refusal to sell rather than a gift.
    throw new AppError(409,
      'There is no price on file for how expensive this area is, so the top spot is not for sale here yet.')
  }
  return Number(row.monthly_price)
}

/** One area by its id. */
export async function areaById(id: string): Promise<MarketplaceArea | null> {
  return queryOne<MarketplaceArea>(
    `SELECT ${AREA_SELECT} FROM marketplace_areas WHERE id = $1`, [id])
}

/** One area by what it is rather than by its id. */
export async function areaByKey(
  kind: MarketplaceAreaKind, key: string, year?: number,
): Promise<MarketplaceArea | null> {
  const y = year ?? await currentIndexYear()
  return queryOne<MarketplaceArea>(
    `SELECT ${AREA_SELECT} FROM marketplace_areas
      WHERE area_kind = $1 AND area_key = $2 AND index_year = $3`, [kind, key, y])
}

export interface PlacementQuote {
  area: MarketplaceArea
  monthlyPrice: number
  /** So a screen can say WHY it costs that, which is the whole pitch. */
  indexSource: string
  indexYear: number
}

/** An area and its price, as a screen needs to show them together. */
export async function quotePlacement(areaId: string, on?: string): Promise<PlacementQuote> {
  const area = await areaById(areaId)
  if (!area) throw new AppError(404, 'That area is not one GAM has a cost of living for.')
  return {
    area,
    monthlyPrice: await requirePlacementRate(area.cost_index, on),
    indexSource: area.index_source,
    indexYear: area.index_year,
  }
}

/**
 * Where a contractor in this town would buy a spot.
 *
 * Their metro if they are in one, otherwise the rest of their state — which is
 * the fallback that makes the country gapless. The city match is deliberately
 * loose because a metro is named after its biggest towns and a contractor lives
 * in whichever one they live in: "Mesa" finds Phoenix-Mesa-Chandler, and
 * "Tolleson" finds nothing and lands on rural Arizona, which is wrong by one
 * step and never wrong by a state.
 */
export async function areaForPlace(opts: { city?: string | null; state?: string | null })
: Promise<MarketplaceArea | null> {
  const state = (opts.state ?? '').trim().toUpperCase()
  if (!state) return null
  const year = await currentIndexYear()
  const city = (opts.city ?? '').trim()
  if (city) {
    const hit = await queryOne<MarketplaceArea>(
      `SELECT ${AREA_SELECT} FROM marketplace_areas
        WHERE area_kind = 'metro' AND index_year = $1
          AND $2 = ANY(states)
          AND name ILIKE '%' || $3 || '%'
        ORDER BY length(name)
        LIMIT 1`,
      [year, state, city])
    if (hit) return hit
  }
  return areaByKey('state_rural', state, year)
}

/** Areas matching what somebody typed into a picker. */
export async function searchAreas(q: string, limit = 20): Promise<MarketplaceArea[]> {
  const year = await currentIndexYear()
  const term = (q ?? '').trim()
  if (!term) {
    return query<MarketplaceArea>(
      `SELECT ${AREA_SELECT} FROM marketplace_areas
        WHERE index_year = $1 ORDER BY name LIMIT $2`, [year, limit])
  }
  // A STATE MATCH COMES FIRST. "WY" is also a substring of
  // Grand Rapids-Wyoming-Kentwood, MI, and somebody typing two letters means
  // the state — so the state's own areas are ordered ahead of a town that
  // happens to be spelled that way, rather than the name match being thrown
  // out, since "Wyoming" the town is a real answer for somebody looking for it.
  return query<MarketplaceArea>(
    `SELECT ${AREA_SELECT} FROM marketplace_areas
      WHERE index_year = $1
        AND (name ILIKE '%' || $2 || '%' OR UPPER($2) = ANY(states))
      ORDER BY (UPPER($2) = ANY(states)) DESC, area_kind, name
      LIMIT $3`,
    [year, term, limit])
}

export interface PlacementBand {
  indexMin: number
  indexMax: number
  monthlyPrice: number
}

/**
 * The whole schedule, for the one screen that shows it.
 *
 * GAM shows the contractor THEIR price, not the grid — the same posture as
 * every other price card. This is for the admin screen and for the test that
 * asserts the bands against the formula in packages/shared.
 */
export async function placementSchedule(on?: string): Promise<PlacementBand[]> {
  const day = on ?? todayIn(null)
  // The text casts are ALIASED AWAY FROM THE COLUMN NAMES, which is the whole
  // reason this reads the way it does. Had they kept their own names, the
  // ORDER BY would have sorted the OUTPUT columns — the text — and the bands
  // would come back 0, 102, 108, 112, 86, 90, 94, 98: a screen rendering the
  // schedule out of order while every row in it is correct. A test caught it.
  // (Spelling the SQL out here would trip test/orderByNamesTheColumn, which
  // reads backticked SQL in a comment as a statement and is right to.)
  const rows = await query<{ lo: string; hi: string; price: string }>(
    `SELECT DISTINCT ON (index_min, index_max)
            index_min::text AS lo, index_max::text AS hi, monthly_price::text AS price
       FROM marketplace_placement_rates
      WHERE effective_from <= $1::date
      ORDER BY index_min, index_max, effective_from DESC`,
    [day])
  return rows.map(r => ({
    indexMin: Number(r.lo),
    indexMax: Number(r.hi),
    monthlyPrice: Number(r.price),
  }))
}
