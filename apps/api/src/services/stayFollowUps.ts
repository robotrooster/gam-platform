/**
 * ── 10/24 (Nic) — ASK THEM, BUT ONLY WHEN THE PARK IS NEARLY FULL ────────────
 *
 *   "Maybe it should keep those notes and only ask at peak busyness times where
 *    we're at 90% capacity or something like that, where there's not really a
 *    lot of room for new reservations. We always want to try to have at least
 *    room for one or two long-term people to just show up at any given moment...
 *    We don't want somebody to be like, hey, I want a long-term spot. And then,
 *    sorry, I can't get you in for 3 more months because I don't really know
 *    what everybody's doing. And then by the time they figure it out and then
 *    you call that person back, they found a different spot to go."
 *
 * An applicant's stated length is a NOTE, never a lease term
 * (routes/background, services/applicationLeaseDraft). This is what that note
 * is FOR: when a park runs out of room, the people whose stated stay is nearly
 * up are the ones worth a phone call, because their answer is the only thing
 * that turns an unknown into a space somebody can be promised.
 *
 * THE GATE IS A COUNT, NOT A PERCENTAGE. Nic settled on "fewer than 4, meaning
 * ask when only 3 are available." A percentage means different things at
 * different sizes — 90% leaves 3 free sites at Oak Park (20 short-stay) and 10
 * at Mountain View (74), so one threshold would nag at one park while staying
 * silent at the other at the moment it mattered most.
 *
 * WHAT COUNTS AS A SITE. Only what is built for people coming and going:
 * SHORT_STAY_BY_NATURE_UNIT_TYPES. Nic: "RV sites are not the same thing as a
 * new lease in an apartment... General leases where people are actually living
 * in an apartment or mobile home, whether or not the tenant owns the mobile
 * home, or single-family house, it shouldn't apply to any of those." Taking the
 * mobile homes out moved Mountain View from 101 to 74 and Oak Park from 29 to 20.
 *
 * OUT OF ORDER IS NOT CAPACITY. Nic: "we need to have the system check sites
 * that are out of order and possibly note that those might not be back in order
 * in time." 22 of Mountain View's 46 apparently-free sites are out of order with
 * NO return date (RV 54-73 dug up for a 50-amp upgrade, plus RV 01, 29, 32). A
 * site with no return date can never be "back in time" for anything, so it is
 * not available. One WITH a return date counts for stays starting after it.
 *
 * WHAT AN ANSWER DOES: nothing. Nic: "just a note, nothing scheduled." Saying
 * "they're leaving on the 9th" writes no lease end date — that is the exact
 * mechanism that put a hard end on James Fenton's RV 15 lease. He ends the
 * tenancy by hand when they actually go.
 */
import { query } from '../db'
import { SHORT_STAY_BY_NATURE_UNIT_TYPES } from '@gam/shared'

/** Nic, 10/24: ask when 3 or fewer are actually usable ("fewer than 4"). */
export const FOLLOW_UP_WHEN_USABLE_AT_OR_BELOW = 3
/** Nic, 10/24: "ask all stays inside the 30 day window no matter how close it is." */
export const FOLLOW_UP_WINDOW_DAYS = 30

export interface StayFollowUp {
  propertyId: string
  propertyName: string
  /** How many short-stay sites are actually usable there right now. */
  usableSites: number
  tenantId: string | null
  name: string
  email: string | null
  phone: string | null
  unitNumber: string | null
  /** What they said when they applied: "about 3 months". */
  statedMonths: number
  /** The day that works out to — what the desk is ringing about. */
  statedEndsOn: string
  /** Negative when it has already gone by: they said 3 months and that was 5 weeks ago. */
  daysAway: number
}

export async function stayFollowUps(opts: {
  landlordIds: string[]
  scopedPropertyIds: string[] | null
}): Promise<StayFollowUp[]> {
  if (!opts.landlordIds.length) return []
  return query<any>(
    `WITH short_stay AS (
       SELECT u.id, u.property_id
         FROM units u
        WHERE u.landlord_id = ANY($1::uuid[])
          AND u.retired_at IS NULL
          AND u.is_bookable
          AND u.unit_type = ANY($2::text[])
          AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
     ),
     -- A site somebody is on, or is about to be on. "About to" is the next
     -- week: a space that frees next month is no use to somebody at the counter.
     busy AS (
       SELECT s.id FROM short_stay s
        WHERE EXISTS (SELECT 1 FROM leases l
                       WHERE l.unit_id = s.id AND l.status IN ('active','pending'))
          OR EXISTS (SELECT 1 FROM unit_bookings b
                      WHERE b.unit_id = s.id
                        AND b.status NOT IN ('cancelled','no_show','checked_out')
                        AND b.check_out > CURRENT_DATE
                        AND b.check_in <= CURRENT_DATE + 7)
     ),
     -- Out of order and not coming back inside the week — or not coming back at
     -- all, which is the state all 22 of Mountain View's are in.
     dark AS (
       SELECT s.id FROM short_stay s
         JOIN unit_out_of_order o ON o.unit_id = s.id AND o.cleared_at IS NULL
        WHERE o.starts_on <= CURRENT_DATE + 7
          AND (o.ends_on IS NULL OR o.ends_on > CURRENT_DATE + 7)
     ),
     capacity AS (
       SELECT s.property_id,
              count(*) FILTER (
                WHERE s.id NOT IN (SELECT id FROM busy)
                  AND s.id NOT IN (SELECT id FROM dark)) AS usable
         FROM short_stay s GROUP BY s.property_id
     ),
     -- What people SAID when they applied, from either door, as a date.
     said AS (
       SELECT bc.user_id, bc.unit_id,
              bc.desired_term_months::int AS months,
              (bc.desired_move_in + (bc.desired_term_months || ' months')::interval)::date AS ends_on
         FROM background_checks bc
        WHERE bc.desired_term_months IS NOT NULL AND bc.desired_move_in IS NOT NULL
          AND COALESCE(bc.desired_month_to_month, FALSE) = FALSE
       UNION ALL
       SELECT ua.applicant_user_id AS user_id, ua.unit_id,
              ua.desired_term_months::int AS months,
              (ua.move_in_date + (ua.desired_term_months || ' months')::interval)::date AS ends_on
         FROM unit_applications ua
        WHERE ua.desired_term_months IS NOT NULL AND ua.move_in_date IS NOT NULL
     )
     SELECT DISTINCT ON (said.user_id, said.unit_id)
            p.id AS property_id, p.name AS property_name,
            c.usable::int AS usable_sites,
            t.id AS tenant_id,
            NULLIF(TRIM(CONCAT_WS(' ', us.first_name, us.last_name)), '') AS name,
            us.email, us.phone, un.unit_number,
            said.months AS stated_months,
            to_char(said.ends_on, 'YYYY-MM-DD') AS stated_ends_on,
            (said.ends_on - CURRENT_DATE)::int AS days_away
       FROM said
       JOIN units un ON un.id = said.unit_id
       JOIN properties p ON p.id = un.property_id
       JOIN capacity c ON c.property_id = p.id
       JOIN users us ON us.id = said.user_id
       JOIN tenants t ON t.user_id = us.id
      WHERE c.usable <= $4
        AND said.ends_on <= CURRENT_DATE + ($5 || ' days')::interval
        -- Still here: there is nothing to ask somebody who has already gone.
        AND EXISTS (
          SELECT 1 FROM lease_tenants lt
            JOIN leases l ON l.id = lt.lease_id
           WHERE lt.tenant_id = t.id AND l.unit_id = un.id
             AND lt.status IN ('active','pending_remove')
             AND l.status IN ('active','pending'))
      ORDER BY said.user_id, said.unit_id, said.ends_on
     `,
    [opts.landlordIds, SHORT_STAY_BY_NATURE_UNIT_TYPES as unknown as string[],
     opts.scopedPropertyIds, FOLLOW_UP_WHEN_USABLE_AT_OR_BELOW, String(FOLLOW_UP_WINDOW_DAYS)],
  ).then(rows => rows.map((r: any) => ({
    propertyId: r.property_id, propertyName: r.property_name,
    usableSites: Number(r.usable_sites),
    tenantId: r.tenant_id ?? null,
    name: r.name || 'Resident',
    email: r.email ?? null, phone: r.phone ?? null,
    unitNumber: r.unit_number ?? null,
    statedMonths: Number(r.stated_months),
    statedEndsOn: r.stated_ends_on,
    daysAway: Number(r.days_away),
  })))
}

/** The one sentence the desk says, in Nic's framing of the call. */
export function followUpSentence(f: StayFollowUp): string {
  const when = f.daysAway < 0
    ? `was up ${Math.abs(f.daysAway)} day${Math.abs(f.daysAway) === 1 ? '' : 's'} ago`
    : f.daysAway === 0 ? 'is up today'
    : `is up in ${f.daysAway} day${f.daysAway === 1 ? '' : 's'}`
  return `${f.name} said about ${f.statedMonths} month${f.statedMonths === 1 ? '' : 's'} when they applied, which ${when}. `
    + `Ask whether they are staying on — ${f.propertyName} is down to ${f.usableSites} `
    + `open site${f.usableSites === 1 ? '' : 's'}.`
}
