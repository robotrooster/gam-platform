/**
 * Aggregated, ANONYMIZED market-rent stats from GAM's own lease data — the
 * source for the landlord "where do my rents sit vs the market?" agent tool.
 *
 * Nic 2026-06-15 EVOLVED the S442 rule: cross-landlord PEER benchmarks stay
 * banned (never "what does landlord X charge"), but anonymized AGGREGATES are
 * allowed. The anonymization here is load-bearing:
 *   - aggregate by (unit_type, city, state) → median + p25/p75, never raw rows;
 *   - require ≥ MIN_DISTINCT_LANDLORDS distinct landlords behind any figure
 *     (k-anonymity — no single landlord's rent can be inferred);
 *   - EXCLUDE the requesting landlord from the aggregate (market vs them, and
 *     prevents self-leakage).
 * Below threshold → null ("not enough market data"), never a thin/identifiable
 * number. See the project_market_rent_transparency memory.
 */
import { query } from '../db'

const MIN_DISTINCT_LANDLORDS = Number(process.env.MARKET_RENT_MIN_LANDLORDS) || 5

export interface MarketRentStat {
  unit_type: string
  city: string
  state: string
  n_leases: number
  n_landlords: number
  median_rent: number
  p25_rent: number
  p75_rent: number
}

/**
 * Anonymized market-rent aggregate for a (unit_type, city, state), excluding the
 * requesting landlord. Returns null when fewer than MIN_DISTINCT_LANDLORDS other
 * landlords have active leases there (k-anonymity gate).
 */
export async function getMarketRent(
  unitType: string,
  city: string,
  state: string,
  excludeLandlordId?: string | null
): Promise<MarketRentStat | null> {
  const ut = String(unitType || '').trim()
  const c = String(city || '').trim()
  const st = String(state || '').trim()
  if (!ut || !c || st.length !== 2) return null

  const rows = await query<MarketRentStat & { n_leases: string; n_landlords: string }>(
    `SELECT u.unit_type,
            btrim(p.city)  AS city,
            upper(btrim(p.state)) AS state,
            COUNT(*)                                  AS n_leases,
            COUNT(DISTINCT p.landlord_id)             AS n_landlords,
            round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY l.rent_amount)) AS median_rent,
            round(percentile_cont(0.25) WITHIN GROUP (ORDER BY l.rent_amount)) AS p25_rent,
            round(percentile_cont(0.75) WITHIN GROUP (ORDER BY l.rent_amount)) AS p75_rent
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE l.status = 'active'
        AND l.rent_amount > 0
        AND u.unit_type = $1
        AND lower(btrim(p.city)) = lower($2)
        AND upper(btrim(p.state)) = upper($3)
        AND ($4::uuid IS NULL OR p.landlord_id <> $4::uuid)
      GROUP BY u.unit_type, btrim(p.city), upper(btrim(p.state))
     HAVING COUNT(DISTINCT p.landlord_id) >= $5`,
    [ut, c, st, excludeLandlordId ?? null, MIN_DISTINCT_LANDLORDS]
  )
  const r = rows[0]
  if (!r) return null
  return {
    unit_type: r.unit_type,
    city: r.city,
    state: r.state,
    n_leases: Number(r.n_leases),
    n_landlords: Number(r.n_landlords),
    median_rent: Number(r.median_rent),
    p25_rent: Number(r.p25_rent),
    p75_rent: Number(r.p75_rent),
  }
}

/** Where a given rent sits vs the market band (for the agent's plain-language answer). */
export function positionVsMarket(rent: number, stat: MarketRentStat): 'below' | 'low' | 'typical' | 'above' {
  if (rent < stat.p25_rent) return 'below' // under the bottom quartile
  if (rent < stat.median_rent) return 'low' // 25th–50th
  if (rent <= stat.p75_rent) return 'typical' // 50th–75th
  return 'above' // over the top quartile
}
