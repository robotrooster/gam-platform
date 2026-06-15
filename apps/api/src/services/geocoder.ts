/**
 * S465 / Phase 1a.3 — geocoder service.
 *
 * Converts a postal address into { lat, lon } via a Nominatim HTTP
 * endpoint. In-house compliant (open-source + GAM-hosted in prod —
 * dev team installs the Nominatim instance + the 50GB OSM data
 * download; that's deploy infra, not application code).
 *
 * For dev: defaults to `https://nominatim.openstreetmap.org/search`
 * (the public instance), which has a usage policy limiting heavy use.
 * Production points GEOCODER_URL at the self-hosted instance.
 *
 * Failure-tolerant: timeouts, network errors, no-results, malformed
 * responses all return null. Callers persist lat/lon as null and the
 * dispatcher can backfill via the route layer later. NEVER throws.
 *
 * Per Nominatim usage policy, sets a User-Agent identifying GAM.
 */

import { logger } from '../lib/logger'

export interface Address {
  street1: string
  street2?: string | null
  city:    string
  state:   string
  zip:     string
}

export interface GeocodeResult {
  lat: number
  lon: number
}

const NOMINATIM_DEFAULT = 'https://nominatim.openstreetmap.org/search'
const REQUEST_TIMEOUT_MS = 5000
const USER_AGENT = 'GoldAssetManagement/1.0 (operations@goldassetmanagement.com)'

/** Format an Address into a single-line query string. street2 is
 *  intentionally omitted — Nominatim parses unit/apt numbers poorly
 *  and prefers a cleaner street1 + city + state + zip. */
function formatAddress(addr: Address): string {
  return [addr.street1, addr.city, addr.state, addr.zip]
    .filter(Boolean)
    .join(', ')
}

/**
 * Call the geocoder. Returns null on any failure (timeout, network,
 * no results, parse errors). Logged for ops visibility.
 *
 * Pass `fetchFn` to inject a stub in tests; defaults to the global
 * fetch (Node 18+).
 */
export async function geocode(
  addr: Address,
  fetchFn: typeof fetch = fetch,
): Promise<GeocodeResult | null> {
  const baseUrl = process.env.GEOCODER_URL ?? NOMINATIM_DEFAULT
  const q = formatAddress(addr)
  const url = `${baseUrl}?q=${encodeURIComponent(q)}&format=json&limit=1`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      logger.warn({ status: res.status, q }, '[geocoder] non-200 response')
      return null
    }
    const body = await res.json() as Array<{ lat: string; lon: string }>
    if (!Array.isArray(body) || body.length === 0) {
      logger.info({ q }, '[geocoder] no results')
      return null
    }
    const first = body[0]
    const lat = Number(first.lat)
    const lon = Number(first.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      logger.warn({ q, first }, '[geocoder] malformed coords in response')
      return null
    }
    return { lat, lon }
  } catch (e) {
    logger.error({ err: e, q }, '[geocoder] request failed')
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}
