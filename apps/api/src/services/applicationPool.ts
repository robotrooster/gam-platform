/**
 * S640 — pool eligibility + entry creation, lifted out of routes/background.ts.
 *
 * Both the webhook and the new status poller finish a screening, and both have
 * to hand an eligible one to the renter pool. Leaving these inside the route
 * meant the poller would either import the route (circular) or grow its own
 * copy. A second copy of "who belongs in the pool" is the kind of thing that
 * agrees for a year and then quietly does not.
 */
import { query, queryOne } from '../db'

/**
 * Best-effort lat/lon for pool proximity matching. A copy of the route's helper
 * rather than an import, because the route is about to stop having one: the
 * pool is the only caller that needs it. Failure is silent and expected —
 * Nominatim times out, and a pool entry without coordinates still matches on
 * city/ZIP (see background-pool-proximity).
 */
async function geocodeAddress(street1: string, city: string, state: string, zip: string): Promise<{ lat: string | null, lon: string | null }> {
  try {
    const addr = encodeURIComponent(`${street1} ${city} ${state} ${zip} USA`)
    const url = `https://nominatim.openstreetmap.org/search?q=${addr}&format=json&limit=1`
    const r = await fetch(url, {
      headers: { 'User-Agent': 'GAM-Platform/1.0' },
      signal: AbortSignal.timeout(3000),
    })
    const data: any = await r.json()
    if (data?.[0]) return { lat: data[0].lat, lon: data[0].lon }
  } catch (_) { /* timeout or network — fall through */ }
  return { lat: null, lon: null }
}

// Pool eligibility: tenant consented + risk gate. Approved tenants are housed
// and don't need leads; only denials and speculative completes route here.
export function isPoolEligible(check: any): boolean {
  if (!check.consent_pool) return false
  if (check.risk_level === 'very_high') return false
  return true
}

/** Idempotent pool-entry create. Backfills the pool_entry_id pointer. */
export async function upsertPoolEntry(check: any) {
  const existing = await queryOne<any>(
    'SELECT id FROM application_pool WHERE background_check_id=$1',
    [check.id]
  )
  if (existing) return existing
  const geo = check.street1 && check.city
    ? await geocodeAddress(check.street1, check.city, check.state, check.zip)
    : { lat: null, lon: null }
  const entry = await queryOne<any>(`
    INSERT INTO application_pool
      (background_check_id, user_id, status, consent_pool, employment_status, monthly_income, city, state, zip, lat, lon, risk_level, risk_score)
    VALUES ($1, $2, 'available', TRUE, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [
    check.id, check.user_id,
    check.employment_status, check.monthly_income,
    check.city, check.state, check.zip,
    geo.lat, geo.lon,
    check.risk_level, check.risk_score,
  ])
  await query('UPDATE background_checks SET pool_entry_id=$1 WHERE id=$2', [entry!.id, check.id])
  return entry
}
