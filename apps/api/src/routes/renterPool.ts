/**
 * S651 — what a renter in the pool can see: places to live near them.
 *
 * Nic: "The person signs up for a, looking for a place to live, and that's it.
 * Based on their address from their ID, it shows nearby properties in a radius
 * that are onboarded on the platform. If there's nothing in the area — if
 * somebody signs up in New York and the only properties are in Illinois and
 * Arizona — then it won't show them that there's anywhere close by to live.
 * They can expand their search if they're looking to move further away, but
 * that's it."
 *
 * WHAT COUNTS AS A PLACE TO LIVE. Any property with somewhere you could take
 * a month-to-month or long-term lease — read off units.lease_types_allowed,
 * which is where that fact actually lives. NOT scoped to RV or mobile-home
 * parks: an apartment building, a single-family house, a commercial space and a
 * motel with long-term rooms all belong here on the same footing. What drops
 * out is the operator renting nightly and weekly only — somebody running an
 * Airbnb-shaped business has nothing to offer a person looking for a home, and
 * their units say so by carrying no long-term lease type.
 *
 * Deliberately a capability of the UNITS rather than a property flag: Oak Park
 * is a motel that also houses long-term residents, and any rule based on the
 * property's type or its unit_types would have to guess about it.
 *
 * THE POOL SITS OUTSIDE ANY PROPERTY. It was originally scoped under a "GAM
 * Renter Pool" landlord and property purely because a tenant portal needed one
 * to attach to, and that shell is the reason the search was wrong: proximity
 * was measured from THAT property's address in Phoenix rather than from the
 * renter. A renter is not a customer of any company. They are a person with an
 * address, looking outward at everything GAM has.
 *
 * So this file knows nothing about landlords or companies. It takes one
 * renter's coordinates and asks which onboarded properties are near them, in
 * miles. The landlord-side search — a landlord looking INTO the pool for people
 * near their own properties — is the opposite direction and lives in
 * routes/background.
 *
 * RADIUS. Default 50 miles, not the 25 a city product would use: much of what
 * is on GAM today is rural (Amado, Yarnell, Mattoon) and 25 miles around
 * Yarnell contains almost nothing. The renter can widen it, which is the part Nic asked for —
 * somebody willing to move further should be able to look further.
 *
 * WHEN NOTHING IS IN RANGE, this says how far the nearest actually is rather
 * than returning a bare empty list. "Nothing within 50 miles; the nearest is
 * 1,430 miles away in Amado, AZ" is a fact somebody can act on. An empty
 * screen just looks broken, and the renter cannot tell whether GAM has no
 * parks or simply none near them.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const renterPoolRouter = Router()
renterPoolRouter.use(requireAuth)

/** Miles. 50 by default; the rest are what "expand my search" offers. */
export const DEFAULT_RADIUS_MILES = 50
export const RADIUS_CHOICES = [25, 50, 100, 250, 500] as const
/** "Anywhere" — larger than the country, so the ORDER BY does the work. */
const ANYWHERE_MILES = 20_000

const nearbySchema = z.object({
  radiusMiles: z.coerce.number().int().min(1).max(ANYWHERE_MILES).optional(),
})

/**
 * Great-circle distance in miles, computed in SQL.
 *
 * Postgres without PostGIS, which GAM does not run. At GAM's scale — tens of
 * properties — a haversine across every row costs nothing, and it is exact
 * rather than the ZIP-prefix tiering the landlord-side search still uses
 * because applicants there may have no coordinates at all. A renter always
 * does: the pool geocodes the address off their ID when the entry is created.
 */
/**
 * Somewhere you could take a lease, rather than book a stay.
 *
 * lease_types_allowed is the per-unit allow-list (see leaseTypesForUnitType in
 * shared). NULL means nobody has narrowed it, and the conservative reading of
 * an un-narrowed unit is the one the shared helper uses for an unknown type:
 * month-to-month and long-term, no short stays. So NULL counts as long-term
 * capable here, which is also the only answer that does not silently hide a
 * property because somebody never filled a column in.
 */
const LONG_TERM_UNIT = `(
  u.lease_types_allowed IS NULL
  OR u.lease_types_allowed && ARRAY['month_to_month','long_term']
)`

const DISTANCE_MILES = `
  3958.7613 * 2 * asin(sqrt(
      power(sin(radians(p.latitude - $1::numeric) / 2), 2)
    + cos(radians($1::numeric)) * cos(radians(p.latitude))
    * power(sin(radians(p.longitude - $2::numeric) / 2), 2)
  ))`

// GET /api/renter-pool/me/nearby?radiusMiles=50
renterPoolRouter.get('/me/nearby', async (req, res, next) => {
  try {
    const { radiusMiles } = nearbySchema.parse(req.query)
    const radius = radiusMiles ?? DEFAULT_RADIUS_MILES

    // The renter's own coordinates, from the address on their ID. No landlord
    // and no property is involved in finding them, which is the entire point.
    const me = await queryOne<{ lat: string | null; lon: string | null; city: string | null; state: string | null }>(
      `SELECT lat::text, lon::text, city, state
         FROM application_pool
        WHERE user_id = $1 AND status = 'available'
        ORDER BY created_at DESC LIMIT 1`,
      [req.user!.userId])
    if (!me) throw new AppError(404, 'You are not in the renter pool.')
    if (!me.lat || !me.lon) {
      // Geocoding failed when the entry was made. Say so plainly instead of
      // showing an empty list that reads as "GAM has nowhere to live".
      throw new AppError(409,
        'We could not place your address on a map, so we cannot show you what is nearby yet. ' +
        'Please check the address on your account.')
    }

    const rows = await query<any>(`
      SELECT p.id, p.name, p.city, p.state, p.type,
             round((${DISTANCE_MILES})::numeric, 1)::text AS distance_miles,
             -- 'vacant' is the real vacancy state (active / delinquent /
             -- vacant are the only three), and a site out of order today is
             -- not somewhere anyone can move into — every availability path
             -- has to go through unit_out_of_order_overlaps() rather than
             -- inventing its own idea of open. (memory: gam-out-of-order-sites)
             (SELECT COUNT(*) FROM units u
               WHERE u.property_id = p.id
                 AND u.status = 'vacant'
                 AND ${LONG_TERM_UNIT}
                 AND NOT unit_out_of_order_overlaps(u.id, CURRENT_DATE, CURRENT_DATE)
             ) AS open_units
        FROM properties p
        JOIN landlords l ON l.id = p.landlord_id
       WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
         AND p.review_status = 'active'
         -- the GAM Renter Pool shell is not a place anyone can live
         AND l.is_system = FALSE
         AND l.is_demo = FALSE
         -- somewhere a person could actually take a lease. A nightly/weekly-only
         -- operator has nothing for someone looking for a home.
         AND EXISTS (SELECT 1 FROM units u WHERE u.property_id = p.id
                       AND u.retired_at IS NULL AND ${LONG_TERM_UNIT})
       ORDER BY (${DISTANCE_MILES}) ASC
       LIMIT 200`, [me.lat, me.lon])

    const within = rows.filter((r: any) => parseFloat(r.distance_miles) <= radius)
    const nearest = rows[0] ?? null

    // A property GAM has not geocoded cannot be offered to anybody, and the
    // renter has no way to know it exists. Counted so it shows up as an ops
    // problem rather than as a quietly shorter list.
    const unplaceable = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM properties p JOIN landlords l ON l.id = p.landlord_id
        WHERE (p.latitude IS NULL OR p.longitude IS NULL)
          AND p.review_status = 'active' AND l.is_system = FALSE AND l.is_demo = FALSE`)

    res.json({
      success: true,
      data: {
        radiusMiles: radius,
        radiusChoices: RADIUS_CHOICES,
        from: { city: me.city, state: me.state },
        properties: within,
        // Only when the radius came up empty — otherwise it is noise.
        nearestOutsideRadius: within.length === 0 && nearest
          ? { name: nearest.name, city: nearest.city, state: nearest.state,
              distanceMiles: nearest.distance_miles }
          : null,
        notYetMapped: Number(unplaceable?.n ?? 0),
      },
    })
  } catch (e) { next(e) }
})
