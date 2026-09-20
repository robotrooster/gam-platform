/**
 * S651 — a property nobody can place on a map is a property nobody can find.
 *
 * Properties geocode once, at creation, fire-and-forget (routes/properties.ts).
 * That is right for creation — a landlord should not wait on Nominatim to save
 * a park — but it means a single timeout leaves latitude/longitude NULL
 * forever, with nothing retrying and nobody told.
 *
 * It did not matter while coordinates were decorative. It matters now: the
 * renter pool shows people what is near them by distance, so a park with no
 * coordinates is invisible to every renter in the country and neither the
 * landlord nor GAM would ever see a symptom. Country Acres in Mattoon is in
 * exactly that state — created 2026-08-28, never placed.
 *
 * So: retry the ones that are missing, nightly, and say so loudly when a
 * property keeps refusing to resolve. A geocode that fails twelve nights
 * running is an address problem somebody has to look at, not a network blip.
 * (Country Acres has its entire address stuffed into street1 — "10055 US-45,
 * Mattoon, Il 61938" — which is the kind of thing that fails silently forever.)
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { geocode } from '../services/geocoder'

export interface GeocodeBackfillResult {
  missing: number
  placed: number
  stillMissing: { id: string; name: string; street1: string | null }[]
}

export async function backfillPropertyCoordinates(): Promise<GeocodeBackfillResult> {
  const rows = await query<{
    id: string; name: string; street1: string | null
    city: string | null; state: string | null; zip: string | null
  }>(
    `SELECT p.id, p.name, p.street1, p.city, p.state, p.zip
       FROM properties p
       JOIN landlords l ON l.id = p.landlord_id
      WHERE (p.latitude IS NULL OR p.longitude IS NULL)
        AND p.review_status = 'active'
        AND l.is_system = FALSE
        AND l.is_demo = FALSE`)

  const stillMissing: GeocodeBackfillResult['stillMissing'] = []
  let placed = 0

  for (const p of rows) {
    if (!p.street1 || !p.city || !p.state || !p.zip) {
      stillMissing.push({ id: p.id, name: p.name, street1: p.street1 })
      continue
    }
    const found = await placeProperty(p)
    if (!found) { stillMissing.push({ id: p.id, name: p.name, street1: p.street1 }); continue }

    await query(
      `UPDATE properties SET latitude = $2, longitude = $3, updated_at = NOW()
        WHERE id = $1 AND (latitude IS NULL OR longitude IS NULL)`,
      [p.id, found.lat, found.lon])
    placed++
    logger.info({ propertyId: p.id, name: p.name, lat: found.lat, lon: found.lon, how: found.how },
      '[geocode-backfill] placed a property that had no coordinates')
  }

  if (stillMissing.length) {
    // Loud on purpose. The alternative is a park that silently never appears
    // to anybody looking for somewhere to live.
    logger.error({ stillMissing },
      '[geocode-backfill] properties cannot be placed on a map — invisible to renters searching nearby')
  }
  return { missing: rows.length, placed, stillMissing }
}

/**
 * Try progressively less exact ways of placing a property, and say which one
 * worked.
 *
 * Creation asks the geocoder once, in one shape, and gives up. That is how
 * Country Acres ended up unplaced: its entire address was typed into street1
 * — "10055 US-45, Mattoon, Il 61938" — so the query became
 * "10055 US-45, Mattoon, Il 61938, Mattoon, IL, 61938", with the town and ZIP
 * in it twice, and Nominatim returned nothing. Strip the duplicated tail and
 * the very same park resolves on the first try.
 *
 * The last resort is the town itself. That is a ZIP centroid rather than a
 * rooftop, and for the only thing these coordinates are read for — how far a
 * park is from somebody looking for a home, at radii from 25 to 500 miles — a
 * few hundred yards is not a distinction that exists. `how` is returned and
 * logged so an approximate placement is a visible fact rather than a silent
 * assumption; nothing here is used for navigation.
 */
async function placeProperty(p: {
  street1: string | null; city: string | null; state: string | null; zip: string | null
}): Promise<{ lat: number; lon: number; how: 'address' | 'address_deduped' | 'town' } | null> {
  const city = p.city!, state = p.state!, zip = p.zip!

  const asGiven = await geocode({ street1: p.street1!, city, state, zip })
  if (asGiven) return { ...asGiven, how: 'address' }

  // Drop a trailing ", City, ST 12345" (any part of it) off street1 so the
  // town and ZIP appear once rather than twice.
  const deduped = p.street1!
    .replace(new RegExp(`[,\\s]+${escapeRe(city)}\\b.*$`, 'i'), '')
    .replace(new RegExp(`[,\\s]+${escapeRe(state)}\\b[\\s,]*\\d{0,5}\\s*$`, 'i'), '')
    .replace(/[,\s]+$/, '')
    .trim()
  if (deduped && deduped.toLowerCase() !== p.street1!.toLowerCase()) {
    const second = await geocode({ street1: deduped, city, state, zip })
    if (second) return { ...second, how: 'address_deduped' }
  }

  const town = await geocode({ street1: '', city, state, zip })
  if (town) return { ...town, how: 'town' }
  return null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
