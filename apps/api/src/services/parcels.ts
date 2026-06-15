/**
 * Parcel / property-intelligence lookups over the read-only gam_properties DB
 * (county assessor parcel records — PUBLIC data). Used by the agents' parcel
 * tool. Two access paths, both index-backed:
 *   - APN-shaped query  → exact / prefix match (btree + trigram on apn)
 *   - free text         → GIN full-text search on search_vector (address /
 *                         owner / city), ranked
 * Read-only; never mutates parcel data.
 */
import { queryProperties } from '../db/propertiesDb'

export interface ParcelSummary {
  apn: string
  county: string | null
  state: string | null
  situs_address: string | null
  situs_city: string | null
  situs_zip: string | null
  owner_name: string | null
  owner_type: string | null
  property_type: string | null
  assessed_value: number | null
  last_sale_price: number | null
  last_sale_date: string | null
  unit_count: number | null
  year_built: number | null
  lot_size_sqft: number | null
  lat: number | null
  lon: number | null
  rank?: number
}

const SUMMARY_COLS = `
  p.apn, p.county, p.state, p.situs_address, p.situs_city, p.situs_zip,
  COALESCE(p.owner_name_parsed, p.owner_name_raw) AS owner_name, p.owner_type,
  p.property_type_std AS property_type, p.assessed_value, p.last_sale_price,
  p.last_sale_date, p.unit_count, p.year_built, p.lot_size_sqft, p.lat, p.lon`

// Looks like an APN: digits with dashes/dots/spaces, no letters (e.g. 123-45-678).
const APN_RE = /^[0-9][0-9.\- ]{2,}$/

/**
 * Search parcels by free text (address / owner / city via FTS) or by APN
 * (exact + prefix). Optional 2-letter state filter. Capped at `limit` (≤25).
 */
export async function searchParcels(
  queryText: string,
  opts: { state?: string; limit?: number } = {}
): Promise<ParcelSummary[]> {
  const q = String(queryText || '').trim()
  if (q.length < 2) return []
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10) || 10, 1), 25)
  const state = String(opts.state || '').trim().toUpperCase()
  const stateOk = state.length === 2

  if (APN_RE.test(q)) {
    const apn = q.replace(/\s+/g, '')
    return queryProperties<ParcelSummary>(
      `SELECT ${SUMMARY_COLS}
         FROM parcels p
        WHERE (p.apn = $1 OR p.apn ILIKE $1 || '%')
          ${stateOk ? 'AND p.state = $3' : ''}
        ORDER BY p.assessed_value DESC NULLS LAST
        LIMIT $2`,
      stateOk ? [apn, limit, state] : [apn, limit]
    )
  }

  return queryProperties<ParcelSummary>(
    `SELECT ${SUMMARY_COLS},
            ts_rank(p.search_vector, websearch_to_tsquery('english', $1)) AS rank
       FROM parcels p
      WHERE p.search_vector @@ websearch_to_tsquery('english', $1)
        ${stateOk ? 'AND p.state = $3' : ''}
      ORDER BY rank DESC, p.assessed_value DESC NULLS LAST
      LIMIT $2`,
    stateOk ? [q, limit, state] : [q, limit]
  )
}

export interface ParcelDetail extends ParcelSummary {
  owner_mailing_address: string | null
  improvement_value: number | null
  land_value: number | null
  building_sqft: number | null
  flood_zone: string | null
  portfolio_sale_flag: boolean | null
  owner_parcel_count: number | null
  owner_states_present: string[] | null
  owner_counties_present: string[] | null
}

/** Full detail for one APN, including the owner's portfolio footprint. */
export async function getParcelByApn(apn: string): Promise<ParcelDetail | null> {
  const a = String(apn || '').trim()
  if (!a) return null
  const rows = await queryProperties<ParcelDetail>(
    `SELECT ${SUMMARY_COLS},
            p.owner_mailing_address, p.improvement_value, p.land_value, p.building_sqft,
            p.flood_zone, p.portfolio_sale_flag,
            o.parcel_count AS owner_parcel_count,
            o.states_present AS owner_states_present,
            o.counties_present AS owner_counties_present
       FROM parcels p
       LEFT JOIN owners o ON o.id = p.owner_id
      WHERE p.apn = $1
      ORDER BY p.assessed_value DESC NULLS LAST
      LIMIT 1`,
    [a]
  )
  return rows[0] ?? null
}
