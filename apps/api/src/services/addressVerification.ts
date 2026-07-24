/**
 * S550 (Nic) — real-world address verification at property creation.
 *
 * "Are we verifying real addresses?" Two graded signals, strongest wins:
 *
 *   'parcel'    — street number + a distinctive street token corroborate
 *                 against county parcel records (gam_properties — AZ
 *                 statewide, 3.4M parcels). This is the anti-typo check:
 *                 "22658 Highway 89" matches the county's "22658 S STATE
 *                 ROUTE 89"; the typo "22656" matches nothing. County situs
 *                 CITY/ZIP fields are unreliable (the real Oak Park's situs
 *                 city is wrong in the county feed), so matching is street
 *                 number + street token only, and a parcel MISS never
 *                 downgrades — it just can't upgrade.
 *   'geocoded'  — the address resolves to coordinates (services/geocoder,
 *                 Nominatim). Catches fake cities/states and nonsense
 *                 addresses; can't catch a plausible street-number typo
 *                 (geocoders interpolate).
 *   'unverified'— neither signal. The property still creates — rural
 *                 addresses legitimately fail both — but an admin alert
 *                 fires so nothing unverifiable enters silently.
 *
 * Best-effort by contract: NEVER throws, never blocks creation. Callers
 * fire it post-commit.
 */
import { query } from '../db'
import { queryProperties } from '../db/propertiesDb'
import { geocode, type Address, type GeocodeResult } from './geocoder'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

export type AddressVerification = 'unverified' | 'geocoded' | 'parcel'

export interface VerifyDeps {
  geocodeFn?: (addr: Address) => Promise<GeocodeResult | null>
  parcelMatchFn?: (addr: Address) => Promise<boolean>
}

/** Leading street number ("22658 Highway 89" → "22658"). */
function streetNumber(street1: string): string | null {
  return street1.match(/^\s*(\d{1,6})\b/)?.[1] ?? null
}

/**
 * Distinctive street tokens for corroboration — everything except the
 * number and generic suffixes/directionals. "22658 Highway 89" →
 * ['89']; "101 Desert Rose Ln" → ['desert', 'rose'].
 */
const GENERIC_TOKENS = new Set([
  'n', 's', 'e', 'w', 'north', 'south', 'east', 'west',
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane',
  'blvd', 'boulevard', 'ct', 'court', 'cir', 'circle', 'way', 'pl', 'place',
  'hwy', 'highway', 'route', 'state', 'us', 'az', 'sr', 'trl', 'trail', 'loop',
])
function streetTokens(street1: string): string[] {
  return street1
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !GENERIC_TOKENS.has(t))
    .filter((t, i) => !(i === 0 && /^\d+$/.test(t))) // drop the leading street number
}

/** AZ parcel corroboration: a parcel whose situs starts with the same
 *  street number AND contains a distinctive street token. */
async function parcelMatch(addr: Address): Promise<boolean> {
  if ((addr.state || '').trim().toUpperCase() !== 'AZ') return false
  const num = streetNumber(addr.street1)
  if (!num) return false
  const tokens = streetTokens(addr.street1)
  const rows = await queryProperties<{ situs_address: string }>(
    `SELECT situs_address FROM parcels WHERE situs_address LIKE $1 LIMIT 50`,
    [`${num} %`],
  )
  if (rows.length === 0) return false
  if (tokens.length === 0) return true // number-only street ("22658") — number hit suffices
  return rows.some(r => {
    const situs = (r.situs_address || '').toLowerCase()
    return tokens.some(t => situs.includes(t))
  })
}

/**
 * Verify one property's address and persist the outcome onto the row.
 * Returns the verification level it landed on. Never throws.
 */
export async function verifyPropertyAddress(
  propertyId: string,
  addr: Address,
  deps: VerifyDeps = {},
): Promise<AddressVerification> {
  const geocodeFn = deps.geocodeFn ?? geocode
  const parcelFn = deps.parcelMatchFn ?? parcelMatch
  // Test isolation: under vitest with no injected deps, do nothing — route
  // suites create properties constantly and must never hit the live
  // geocoder or the parcels DB. Service tests inject stubs.
  if (process.env.VITEST && !deps.geocodeFn && !deps.parcelMatchFn) return 'unverified'
  try {
    let level: AddressVerification = 'unverified'
    let coords: GeocodeResult | null = null

    try { coords = await geocodeFn(addr) } catch { coords = null }
    if (coords) level = 'geocoded'

    try { if (await parcelFn(addr)) level = 'parcel' } catch { /* corroborator only */ }

    await query(
      `UPDATE properties
          SET address_verification = $1,
              latitude  = COALESCE($2, latitude),
              longitude = COALESCE($3, longitude),
              address_verified_at = NOW()
        WHERE id = $4`,
      [level, coords?.lat ?? null, coords?.lon ?? null, propertyId],
    )

    if (level === 'unverified') {
      await createAdminNotification({
        severity: 'warn',
        category: 'unverified_property_address',
        title: `Unverifiable property address: ${addr.street1}, ${addr.city}`,
        body: `Property ${propertyId} was created at "${addr.street1}, ${addr.city}, ` +
              `${addr.state} ${addr.zip}" but the address neither geocoded nor matched ` +
              `county parcel records. Rural addresses can legitimately fail both — ` +
              `review that this is a real location.`,
        context: { propertyId, ...addr },
      }).catch(() => {})
    }
    return level
  } catch (e) {
    logger.error({ err: e, propertyId }, '[address-verify] failed')
    return 'unverified'
  }
}

/**
 * S550 (Nic): EVERY property must end up with coordinates — the future
 * heat map (landlord/unit concentration by geography) is only as good as
 * coverage, so verification isn't fire-and-forget-once, it's guaranteed
 * eventually. Nightly sweep:
 *   - never-attempted rows (address_verified_at IS NULL) — e.g. created
 *     while the geocoder was down, or rows predating this feature;
 *   - 'unverified' rows, retried weekly (geocoder data improves, parcels
 *     for new states get ingested).
 * Sequential with a polite delay (public Nominatim allows ~1 req/s);
 * capped per run so a large backlog spreads over nights.
 */
export async function sweepUnverifiedAddresses(opts: {
  limit?: number
  delayMs?: number
  deps?: VerifyDeps
} = {}): Promise<{ attempted: number; parcel: number; geocoded: number; unverified: number }> {
  const limit = opts.limit ?? 300
  const delayMs = opts.delayMs ?? 1100
  const rows = await query<{ id: string; street1: string; street2: string | null; city: string; state: string; zip: string }>(
    `SELECT id, street1, street2, city, state, zip
       FROM properties
      WHERE address_verified_at IS NULL
         OR (address_verification = 'unverified'
             AND address_verified_at < NOW() - INTERVAL '7 days')
      ORDER BY address_verified_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  )
  const out = { attempted: 0, parcel: 0, geocoded: 0, unverified: 0 }
  for (const r of rows) {
    const level = await verifyPropertyAddress(r.id, {
      street1: r.street1, street2: r.street2, city: r.city, state: r.state, zip: r.zip,
    }, opts.deps ?? {})
    out.attempted++
    out[level]++
    if (delayMs > 0) await new Promise(res => setTimeout(res, delayMs))
  }
  return out
}
