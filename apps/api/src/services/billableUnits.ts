/**
 * S652 — HOW MANY SPACES THIS PROPERTY IS BILLED FOR. One answer, one place.
 *
 * Nic, after the admin page quoted $120 while the bill said $130, and my "fix"
 * then invented $10 for a property with nobody in it: "The Springville property
 * is not being billed $10 right now. It has nobody in it."
 *
 * He was right twice over. Springville's single unit is marked `status='active'`
 * and has ZERO leases — the status column was lying, the accrual (which counts
 * leases) correctly billed nothing, and my status-based estimate invented a
 * property's worth of revenue out of a stale flag.
 *
 * That is the same disease as the pies disagreeing with the card: two places
 * computing one number. So the estimate no longer computes anything. It calls
 * THIS, which is what the accrual itself runs, and a discrepancy between what
 * GAM shows and what GAM bills becomes impossible rather than merely unlikely.
 *
 * WHAT COUNTS, in Nic's words: "Spaces that are delinquent, spaces that are
 * owner occupied, spaces that are booked or reserved... The only thing that
 * doesn't get billed is a vacant spot that's either available, or vacant and
 * unavailable because it needs remodel."
 *
 * Which is what the four terms below add up to — and note that none of them is
 * a unit status except owner-use, because a status is a label somebody typed
 * and a lease is a thing that happened:
 *
 *   - a unit with an ACTIVE LEASE. Delinquent is included for free: a tenant
 *     behind on rent still has a lease. So is a hibernating one (S650).
 *   - an OWNER-OCCUPIED unit, which has no lease by design (the anti-cheat)
 *     and would otherwise be free to run.
 *   - a UTILITY-SERVICE space next door (S615/S616) — occupied by him, because
 *     of the utilities.
 *   - a MONTH STAY with no lease (10/5, Nic) — a space, up front, like a lease,
 *     whether or not its guest has paid yet: on the schedule is what counts.
 *   - NIGHTLY AND WEEKLY STAYS, as nights ÷ 30. A reservation sitting in a spot
 *     is that spot being occupied, and the aggregate is how a nightly park is
 *     billed without charging $2 for a one-night stay.
 *
 * 10/5 (Nic): "rv 10 and 11 and 15 and 47 are active stays in october. they
 * get billed for october. arrears is only for short term stays where we dont
 * know the aggregate total nights. we know all 4 stays will be here the entire
 * month". So everything known up front — a lease, a month stay, owner use, a
 * utility-service space — is ONE space for the month, counted once per unit
 * however many of those it had (occupiedSpacesSql). Only nightly and weekly
 * stays, whose total nobody knows until the month is over, wait for arrears.
 */
import type { PoolClient } from 'pg'

/**
 * 10/5 (Nic) — THE LAST NIGHTLY TOP-UP THAT BILLS A MONTH, as a SQL timestamptz.
 *
 * The top-up (jobs/platformFeeAccrual processPlatformFeeTopUp) runs on the
 * payout cron, '0 1 * * 1-5' UTC (jobs/scheduler) — 6 pm Phoenix, Sunday
 * through Thursday. Phoenix keeps no daylight time, so that is 18:00 local all
 * year. The last of those evenings inside the month is the last moment a space
 * filled that month is billed FOR that month; anything later starts on the next
 * month's bill. `month` is a SQL expression for the month's first day.
 *
 * If the payout cron's schedule ever changes, this must change with it.
 */
export function lastTopUpOfMonthSql(month: string): string {
  return `(((SELECT MAX(lt.d) FROM (
              SELECT ((${month})::date + INTERVAL '1 month')::date - lt_k AS d
                FROM generate_series(1, 7) lt_k) lt
             WHERE EXTRACT(DOW FROM lt.d) <= 4) + TIME '18:00') AT TIME ZONE 'America/Phoenix')`
}

/**
 * 10/5 (Nic) — A LEASE THAT HELD ITS SPACE AT SOME POINT IN THE MONTH, as a
 * condition on a leases row aliased `l`. `month` and `monthEnd` are SQL date
 * expressions; `tz` the property's timezone.
 *
 * Not only a lease active TODAY. The nightly top-up recounts the month's spaces
 * and raises the bill by how many more there are than the 1st counted; if a
 * lease that ended mid-month dropped out of that recount, it would hide a new
 * arrival ("someone leaving mid-month does not refund the month" — so neither
 * may it cancel out somebody who came). So an expired lease counts through its
 * last day, and a terminated one through the day it was terminated — the rule
 * services/utilityBilling applies for "a lease in force on a date". A
 * terminated lease that never took effect (an unsigned draft thrown away, with
 * no terminated_at, or one ended before its start date) never held a space.
 */
export function leaseHeldSpaceInMonthSql(l: string, month: string, monthEnd: string, tz: string): string {
  const endedOn = `timezone(${tz}, ${l}.terminated_at)::date`
  return `(${l}.start_date <= ${monthEnd}
       AND (
         (${l}.status = 'active' AND (${l}.end_date IS NULL OR ${l}.end_date >= ${month}))
         OR (${l}.status = 'expired'
             AND LEAST(COALESCE(${endedOn}, ${l}.end_date), COALESCE(${l}.end_date, 'infinity'::date)) >= ${month})
         OR (${l}.status = 'terminated'
             AND ${l}.terminated_at IS NOT NULL
             AND timezone(${tz}, ${l}.terminated_at) >= ${l}.start_date::timestamp
             AND LEAST(${endedOn}, COALESCE(${l}.end_date, 'infinity'::date)) >= ${month})))`
}

/**
 * WHICH STAYS THE FEE COUNTS BY THEIR NIGHTS (or, off the space-only types, by
 * their revenue), as SQL. One rule for the accrual (nights here, STR revenue in
 * jobs/platformFeeAccrual) and the landlord's estimate (services/platformFee),
 * so the two cannot drift.
 *
 * 10/5 (Nic): only NIGHTLY and WEEKLY stays. "arrears is only for short term
 * stays where we dont know the aggregate total nights." A month stay is known
 * up front and is billed as a space for the month instead
 * (feeCountedMonthStaySql) — never also by its nights or its revenue.
 *
 * A stay that chose a LEASE is never also counted as stay nights (M6): for a
 * month the lease drafted from it (leases.source_booking_id) was billed for —
 * the lease counts the space ($2 for the month) and every dollar is counted
 * once. The register writes a 30+ night stay rung up by the night or week as a
 * nightly or weekly booking, so this holds whatever the booking's type. A
 * lease still pending counts nothing, so until it is in force the stay's
 * nights carry the space. Nightly and weekly stays keep S652's rule otherwise:
 * their nights count even on a unit that also had someone else's lease that
 * month.
 *
 * `b` is the unit_bookings alias.
 */
export function feeCountedStaySql(b: string, month: string): string {
  const m = `(${month})::date`
  const monthEnd = `(${m} + INTERVAL '1 month' - INTERVAL '1 day')`
  const tz = `COALESCE(fs_p.timezone, 'America/Phoenix')`
  const startsAt = `(fs.start_date::timestamp AT TIME ZONE ${tz})`
  // Which months the lease was billed for. The 1st bills every lease in force
  // then; 10/5 (Nic), the nightly top-up bills a lease that comes into force
  // later in the month for THAT month — up to the month's last top-up
  // (lastTopUpOfMonthSql). So a stay's nights for `month` drop out when its
  // lease held the space that month and was in force (signed, and its start
  // date reached) before that last top-up. A lease signed on Sept 20 is billed
  // for September by the Sept 20 top-up, so September's stay nights are not
  // billed again on Oct 1. One signed after the month's last top-up (a Friday
  // or Saturday that ends the month) was billed for nobody's month yet, so
  // that month's nights still carry the space — otherwise it is billed by
  // nobody. `month` is the month whose nights are being counted.
  return `(${b}.lease_type IN ('nightly', 'weekly')
       AND NOT EXISTS (
             SELECT 1 FROM leases fs
               JOIN units fs_u ON fs_u.id = fs.unit_id
               JOIN properties fs_p ON fs_p.id = fs_u.property_id
              WHERE fs.source_booking_id = ${b}.id
                AND ${leaseHeldSpaceInMonthSql('fs', m, monthEnd, tz)}
                AND GREATEST(COALESCE(fs.signed_at, ${startsAt}), ${startsAt}) < ${lastTopUpOfMonthSql(m)}))`
}

/**
 * 10/5 (Nic) — A MONTH STAY IS A SPACE, BILLED UP FRONT LIKE A LEASE.
 *
 * "rv 10 and 11 ... are active stays in october. they get billed for october."
 * A month stay is a unit_bookings row sold by the month ('month_to_month' —
 * what the register, a pay link, the booking site and the schedule write for a
 * stay sold by the month; services/registerStay bookingLeaseTypeFor). It counts
 * as one occupied space for every calendar month it overlaps, exactly as a
 * lease does.
 *
 *   - It is ON THE SCHEDULE, paid or not. 10/5 (Nic), on RV 10 and RV 11 —
 *     month stays sold by pay link whose guests had not paid the link yet, so
 *     still 'tentative': "We've invoiced for that spot and it's on the
 *     schedule. So we are billing Mountain View for it either way." A
 *     tentative (held, invoiced, unpaid) month stay counts exactly like a
 *     confirmed one. (This reverses the first 10/5 cut, which skipped
 *     tentative stays as unpaid holds.) The one hold that is NOT on the
 *     schedule is a booking-site checkout hold (hold_expires_at set): a guest
 *     partway through paying on the booking page, held for a few minutes and
 *     never invoiced. Paying clears the timer (services/propertyBooking
 *     confirmBookingDeposit, routes/posPayLinks), so the stay counts from the
 *     moment it is paid; an abandoned checkout is cancelled by the sweep
 *     before it ever arrives. Counting it would bill the month for a guest
 *     who was only looking at the card page during the 1st's run or a
 *     nightly top-up, and the bill is never lowered after. Pay-link, counter
 *     and schedule holds never set the timer (routes/units), so Nic's
 *     invoiced-but-unpaid stays all still count.
 *   - Not cancelled before arrival. A stay cancelled ON or after arrival
 *     still held the site, the same S652 rule the nights follow
 *     (feeCountedNightsStatusSql) — otherwise a month stay cancelled the day
 *     after it arrived would be a free month for the asking, and would drop out
 *     of the nightly top-up's recount and hide somebody else's arrival.
 *   - A stay whose guest chose a lease is counted through that lease only, for
 *     each month the lease drafted from it (leases.source_booking_id) held a
 *     space. Until the lease is in force — drafted and waiting on signatures —
 *     the guest is on the site and the STAY carries the space; otherwise
 *     nobody would pay for it. (On the same site the two could never both be
 *     counted anyway: occupiedSpacesSql counts each unit once.)
 *
 * `b` is the unit_bookings alias; `month` a SQL expression for the month.
 */
export function feeCountedMonthStaySql(b: string, month: string): string {
  const m = `(${month})::date`
  const monthEnd = `(${m} + INTERVAL '1 month' - INTERVAL '1 day')`
  return `(${b}.lease_type = 'month_to_month'
       -- 10/5 (Nic): tentative counts — "it's on the schedule" — unless it is
       -- a booking-site checkout hold (a timer: nothing invoiced yet).
       AND NOT (${b}.status = 'tentative' AND ${b}.hold_expires_at IS NOT NULL)
       AND ${feeCountedNightsStatusSql(b)}
       AND NOT EXISTS (
             SELECT 1 FROM leases ms_l
               JOIN units ms_u ON ms_u.id = ms_l.unit_id
               JOIN properties ms_p ON ms_p.id = ms_u.property_id
              WHERE ms_l.source_booking_id = ${b}.id
                AND ${leaseHeldSpaceInMonthSql('ms_l', m, monthEnd, `COALESCE(ms_p.timezone, 'America/Phoenix')`)}))`
}

/**
 * 10/5 (Nic) — EVERY SPACE OCCUPIED IN A MONTH, ONCE, as SQL.
 *
 * A subquery yielding one row per unit (unit_id, kind) for the property
 * `propertyId` (a SQL expression) in the month starting `month` (a SQL date
 * expression). A unit that had a lease AND a month stay, or owner use AND a
 * utility arrangement, in the same month is ONE space: "a space counts once
 * per month". `kind` names the first that applies, in this order — lease,
 * month_stay, owner_use, utility_service — so the bill can say what it counted.
 *
 * Every space OCCUPIED AT ANY POINT in the month, not only today: a lease or
 * utility arrangement that ended mid-month, or a month stay cancelled after it
 * arrived, still counts for that month. On the 1st that is the same set as
 * "occupied now"; mid-month it is what lets the nightly top-up compare its
 * recount with the 1st's count and bill only the spaces that are new — a
 * departure never hides an arrival (10/5).
 *
 * `ownerUseWhen` limits owner use (a unit STATUS, so only true of the present)
 * — the landlord's estimate passes "this month or later" so it never backdates
 * today's status onto a past month. Being a status, owner use cleared mid-month
 * is the one thing this cannot see in the past.
 *
 * Inner aliases are prefixed so a caller's correlated `p` / `m` are never
 * shadowed.
 */
export function occupiedSpacesSql(
  propertyId: string, month: string, opts: { ownerUseWhen?: string } = {},
): string {
  const m = `(${month})::date`
  const monthEnd = `(${m} + INTERVAL '1 month' - INTERVAL '1 day')`
  return `
    SELECT DISTINCT ON (occ.unit_id) occ.unit_id, occ.kind
      FROM (
        -- Distinct units with a lease that held the space at some point in
        -- the month — active, or ended or terminated during it (10/5:
        -- leaseHeldSpaceInMonthSql — leaving never lowers the month).
        SELECT os_l.unit_id, 1 AS prio, 'lease' AS kind
          FROM leases os_l
          JOIN units os_lu ON os_lu.id = os_l.unit_id
          JOIN properties os_lp ON os_lp.id = os_lu.property_id
         WHERE os_lu.property_id = ${propertyId}
           AND ${leaseHeldSpaceInMonthSql('os_l', m, monthEnd, `COALESCE(os_lp.timezone, 'America/Phoenix')`)}
        UNION ALL
        -- 10/5 (Nic): a month stay with no lease, overlapping the month.
        SELECT os_b.unit_id, 2, 'month_stay'
          FROM unit_bookings os_b JOIN units os_bu ON os_bu.id = os_b.unit_id
         WHERE os_bu.property_id = ${propertyId}
           AND ${feeCountedMonthStaySql('os_b', m)}
           AND os_b.check_in  < ${m} + INTERVAL '1 month'
           AND os_b.check_out > ${m}
        UNION ALL
        -- S652: owner-occupied (see billableUnitsForProperty for why).
        SELECT os_o.id, 3, 'owner_use'
          FROM units os_o
         WHERE os_o.property_id = ${propertyId}
           AND os_o.status = 'owner_use' AND os_o.retired_at IS NULL
           AND (${opts.ownerUseWhen ?? 'TRUE'})
        UNION ALL
        -- S615/S616: a space next door on a utility charge (see below).
        SELECT os_sa.unit_id, 4, 'utility_service'
          FROM utility_service_agreements os_sa JOIN units os_su ON os_su.id = os_sa.unit_id
         WHERE os_su.property_id = ${propertyId}
           -- 10/5: an arrangement that ended during the month still held the
           -- space that month (the rule services/utilityBilling bills by).
           AND (os_sa.status = 'active' OR (os_sa.status = 'ended' AND os_sa.end_date IS NOT NULL))
           AND os_sa.superseded_by_lease_id IS NULL
           AND os_sa.start_date <= ${monthEnd}
           AND (os_sa.end_date IS NULL OR os_sa.end_date >= ${m})
           AND (os_sa.payer_accepted_at IS NOT NULL OR os_sa.payer_attested_at IS NOT NULL)
           -- 10/5 (Nic, R11/R12): a 30+ night stay with no lease pays its
           -- site's utilities through an agreement tied to the stay
           -- (booking_id). That space is the STAY's — counted as a month stay
           -- above, or by its nights — never a second time here.
           AND os_sa.booking_id IS NULL
      ) occ
     ORDER BY occ.unit_id, occ.prio`
}

/**
 * S652 (Nic) — which stays' NIGHTS count, by status: a stay cancelled before
 * arrival never happened; one cancelled on or after arrival held the site (see
 * the nights query below for his words). The landlord's estimate reads the
 * same rule so it quotes what the bill charges.
 */
export function feeCountedNightsStatusSql(b: string): string {
  return `NOT (${b}.status = 'cancelled'
                AND (${b}.cancelled_at IS NULL OR ${b}.cancelled_at::date < ${b}.check_in))`
}

export interface BillableUnits {
  /**
   * Spaces billed for the month up front other than utility-service ones:
   * leases, month stays (10/5) and owner use, each unit once.
   */
  longTerm: number
  ownerOccupied: number
  /** 10/5 (Nic): month stays with no lease, each a space for the month. */
  monthStays: number
  utilityService: number
  shortStayNights: number
  shortStayEquivalent: number
  /** What the fee is charged on. */
  total: number
}

export async function billableUnitsForProperty(
  client: PoolClient,
  propertyId: string,
  /** The month being billed — leases and month stays bill the month STARTING. */
  monthIso: string,
  /**
   * The month just ended. Nightly and weekly nights bill in ARREARS (S650)
   * because you cannot count them before the month is over, so the two halves
   * of this function deliberately read different months.
   */
  arrearsIso: string,
  nightsAggregationUnitTypes: readonly string[],
): Promise<BillableUnits> {
  // ── Spaces occupied this month, each unit ONCE (occupiedSpacesSql) ──────
  //
  // 10/5 (Nic): a space counts once per month however many leases, month
  // stays, owner use or utility arrangements it had. These used to be four
  // separate counts added together, so a site with a lease and a stay, or
  // owner use and a utility agreement, was billed twice.
  //
  // LEASES. ── S650 (Nic), REPLACING S576 ── A hibernating lease DOES carry
  // the platform fee. Nic: "The hibernating leases don't get billed anything
  // from the landlord to the tenant, but we bill from the platform to the
  // landlord. Those are still an active spot... I cannot put another lease in
  // that spot while there's the hibernated spot." Hibernation suspends the
  // landlord's billing of the TENANT (no rent, no utilities). It does not free
  // the space, so GAM still charges the landlord for it.
  //
  // MONTH STAYS (10/5, Nic): "rv 10 and 11 ... are active stays in october.
  // they get billed for october." Known up front, so billed up front, like a
  // lease (feeCountedMonthStaySql).
  //
  // ── S652: OWNER-OCCUPIED SPACES ARE OCCUPIED ─────────────────────────
  //
  // Nic: "we absolutely charge the landlords for owner occupied units. We
  // don't charge for vacant units. We charge for anything occupied, no matter
  // the status."
  //
  // An owner_use space deliberately has no lease — that is the anti-cheat, so
  // a landlord cannot park a relative in a space and call it rented. But "no
  // lease" was quietly doing a second job it was never meant to do: making the
  // space free to run. The space is full, the landlord cannot rent it to
  // anybody else, and GAM is carrying it in every report and every screen
  // exactly like a tenanted one.
  //
  // ── Utility-service spaces (S615) ────────────────────────────────────
  // Nic: "It is technically a unit, so it needs to be billed at two dollars."
  // A space next door that this landlord supplies power or trash to is
  // OCCUPIED BY HIM, because of the utilities — it holds meter assignments
  // and a payer exactly like a leased unit does.
  //
  // S616 (Nic): "$2 per occupied unit next door THAT IS ON SOME SORT OF
  // UTILITY CHARGE — trash or electric or whatever." Counted per SPACE, never
  // per utility: a neighbor on both trash and electric is $2, not $4.
  //
  // Two conditions decide whether GAM has earned it, and neither is an event
  // test — deliberately. This job runs 1:30am on the 1st and invoices
  // generate at 7am, so any "was something billed this month" check would
  // find nothing and silently zero the fee forever. Both of these are STATE:
  // the payer has agreed — accepted their invite, or the landlord attested to
  // an arrangement that predates GAM. Without that no invoice is issued at all
  // (see serviceAgreementInvoices), so GAM would be charging for a bill it
  // never delivered.
  //
  // NOT gated on a meter assignment, which an earlier version tried. Nic:
  // "we're not assigning the spaces to a meter. Trash is a flat rate. Water
  // is a RUBS system. There is not always going to be a meter, and there
  // probably won't ever be a meter when we're in this particular type of
  // situation."
  //
  // superseded_by_lease_id drops it the moment the space's real owner
  // onboards: the $2 follows the unit to them and is never charged twice for
  // one space.
  const spaceRes = await client.query<{
    lease: number; month_stay: number; owner_use: number; utility_service: number
  }>(`
    SELECT COUNT(*) FILTER (WHERE kind = 'lease')::int           AS lease,
           COUNT(*) FILTER (WHERE kind = 'month_stay')::int      AS month_stay,
           COUNT(*) FILTER (WHERE kind = 'owner_use')::int       AS owner_use,
           COUNT(*) FILTER (WHERE kind = 'utility_service')::int AS utility_service
      FROM (${occupiedSpacesSql('$1::uuid', '$2::date')}) spaces
  `, [propertyId, monthIso])
  const sp = spaceRes.rows[0]
  const ownerOccupiedCount = sp.owner_use
  const monthStayCount = sp.month_stay
  const longTermUnitCount = sp.lease + sp.month_stay + sp.owner_use
  const utilityServiceUnitCount = sp.utility_service

  // ── Short-stay nights ────────────────────────────────────────────────
  // SUM of nights in the billing month across all nightly and weekly
  // bookings on this property. Every night counts; nightly/weekly bookings on
  // units that ALSO had a lease this month still contribute their nights (no
  // exclusion). 10/5 (Nic): month stays are NOT here — they are spaces, up
  // front, above (feeCountedStaySql).
  const ssRes = await client.query<{ nights: number | null }>(`
    SELECT COALESCE(SUM(
        GREATEST(
          LEAST(b.check_out, $2::date + INTERVAL '1 month')::date
            - GREATEST(b.check_in, $2::date)::date,
          0
        )
      ), 0)::int AS nights
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
     WHERE u.property_id = $1
       AND u.unit_type = ANY($3::text[])
       AND ${feeCountedStaySql('b', '$2::date')}
       -- S652 (Nic): "If somebody cancels that stay prior to the date of the
       -- reservation, then those nights don't get counted for the aggregate...
       -- if the reservation was never cancelled, we have no way to know" — so
       -- a stay cancelled ON or AFTER arrival is a stay. The site was held, it
       -- could not be sold to anybody else, and the schedule carried it the
       -- whole way, which is the thing GAM is paid for. Nights billed in
       -- arrears against a status anybody could flip on the 30th was a free
       -- month for the asking.
       --
       -- NO-SHOW IS NOT A BILLING STATE. Nic: "I don't want to have a no-show
       -- thing. If they just don't show up, that's not really GAM's problem."
       -- A NULL cancelled_at is read GENEROUSLY — as cancelled in time. It
       -- cannot occur (a trigger stamps every cancellation, and the existing
       -- rows were backfilled), and if it somehow did, billing a landlord for a
       -- stay that never happened is a worse failure than missing $2.
       AND ${feeCountedNightsStatusSql('b')}
       AND b.check_in  <  $2::date + INTERVAL '1 month'
       AND b.check_out >  $2::date
    -- S650: nights are billed IN ARREARS — you cannot count them before the
    -- month is over — so this query reads the month just ended while the
    -- lease side above bills the month starting.
  `, [propertyId, arrearsIso, [...nightsAggregationUnitTypes]])
  const shortStayNights = ssRes.rows[0].nights ?? 0
  const shortStayEquivalent = Math.ceil(shortStayNights / 30)


  return {
    longTerm: longTermUnitCount,
    ownerOccupied: ownerOccupiedCount,
    monthStays: monthStayCount,
    utilityService: utilityServiceUnitCount,
    shortStayNights,
    shortStayEquivalent,
    total: longTermUnitCount + shortStayEquivalent + utilityServiceUnitCount,
  }
}
