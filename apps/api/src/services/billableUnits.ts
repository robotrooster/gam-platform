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
 *   - SHORT STAYS, as nights ÷ 30. A reservation sitting in a spot is that spot
 *     being occupied, and the aggregate is how a nightly park is billed without
 *     charging $2 for a one-night stay.
 */
import type { PoolClient } from 'pg'

export interface BillableUnits {
  longTerm: number
  ownerOccupied: number
  utilityService: number
  shortStayNights: number
  shortStayEquivalent: number
  /** What the fee is charged on. */
  total: number
}

export async function billableUnitsForProperty(
  client: PoolClient,
  propertyId: string,
  /** The month being billed — leases bill the month STARTING. */
  monthIso: string,
  /**
   * The month just ended. Nights bill in ARREARS (S650) because you cannot
   * count them before the month is over, so the two halves of this function
   * deliberately read different months.
   */
  arrearsIso: string,
  nightsAggregationUnitTypes: readonly string[],
): Promise<BillableUnits> {
  // ── Long-term unit count ─────────────────────────────────────────────
  // Distinct units with an active lease overlapping the billing month.
  const ltRes = await client.query<{ c: number }>(`
    SELECT COUNT(DISTINCT l.unit_id)::int AS c
      FROM leases l
      JOIN units u ON u.id = l.unit_id
     WHERE u.property_id = $1
       AND l.status = 'active'
       -- ── S650 (Nic), REPLACING S576 ────────────────────────────────────
       -- A hibernating lease DOES carry the platform fee. Nic: "The
       -- hibernating leases don't get billed anything from the landlord to
       -- the tenant, but we bill from the platform to the landlord. Those
       -- are still an active spot... I cannot put another lease in that spot
       -- while there's the hibernated spot."
       --
       -- Hibernation suspends the landlord's billing of the TENANT (no rent,
       -- no utilities). It does not free the space, so GAM still charges the
       -- landlord for it. The old rule dropped two Mountain View spots that
       -- are occupied and unavailable.
       AND l.start_date <= ($2::date + INTERVAL '1 month' - INTERVAL '1 day')
       AND (l.end_date IS NULL OR l.end_date >= $2::date)
  `, [propertyId, monthIso])

  // ── S652: OWNER-OCCUPIED SPACES ARE OCCUPIED ─────────────────────────
  //
  // Nic: "we absolutely charge the landlords for owner occupied units. We
  // don't charge for vacant units. We charge for anything occupied, no matter
  // the status."
  //
  // This count is lease-driven, and an owner_use space deliberately has no
  // lease — that is the anti-cheat, so a landlord cannot park a relative in a
  // space and call it rented. But "no lease" was quietly doing a second job it
  // was never meant to do: making the space free to run. The space is full,
  // the landlord cannot rent it to anybody else, and GAM is carrying it in
  // every report and every screen exactly like a tenanted one.
  //
  // Counted separately and added, rather than folded into the lease query: an
  // owner_use unit has nothing to join to, and a LEFT JOIN that tried would
  // put the anti-cheat and the billing rule in one expression where the next
  // person to touch either would break the other.
  const ownerRes = await client.query<{ c: number }>(`
    SELECT COUNT(*)::int AS c FROM units
     WHERE property_id = $1 AND status = 'owner_use' AND retired_at IS NULL`,
    [propertyId])
  const ownerOccupiedCount = ownerRes.rows[0].c

  const longTermUnitCount = ltRes.rows[0].c + ownerOccupiedCount

  // ── Utility-service spaces (S615) ────────────────────────────────────
  // Nic: "It is technically a unit, so it needs to be billed at two dollars."
  // A space next door that this landlord supplies power or trash to is
  // OCCUPIED BY HIM, because of the utilities — it holds meter assignments
  // and a payer exactly like a leased unit does.
  //
  // The live estimate has counted these since S614; this job did not, so the
  // number GAM showed the landlord was one higher than the bill GAM then
  // sent, and GAM under-collected its own revenue every month.
  //
  // S616 (Nic): "$2 per occupied unit next door THAT IS ON SOME SORT OF
  // UTILITY CHARGE — trash or electric or whatever."
  //
  // Counted per SPACE, never per utility: a neighbour on both trash and
  // electric is $2, not $4. That is what COUNT(DISTINCT sa.unit_id) buys.
  //
  // Two conditions decide whether GAM has earned it, and neither is an event
  // test — deliberately. This job runs 1:30am on the 1st and invoices
  // generate at 7am, so any "was something billed this month" check would
  // find nothing and silently zero the fee forever. Both of these are STATE:
  //
  //   · the payer has agreed — accepted their invite, or the landlord
  //     attested to an arrangement that predates GAM. Without that no invoice
  //     is issued at all (see serviceAgreementInvoices), so GAM would be
  //     charging for a bill it never delivered.
  //
  // NOT gated on a meter assignment, which an earlier version tried. Nic:
  // "we're not assigning the spaces to a meter. Trash is a flat rate. Water
  // is a RUBS system. There is not always going to be a meter, and there
  // probably won't ever be a meter when we're in this particular type of
  // situation." The agreement existing IS the statement that this space is on
  // a utility charge; requiring a meter row would have silently zeroed the
  // fee for the exact arrangement it exists to bill.
  //
  // superseded_by_lease_id drops it the moment the space's real owner
  // onboards: the $2 follows the unit to them and is never charged twice for
  // one space. No mid-month conflict — the incoming landlord sits inside the
  // no-double-bill grace until their second cycle, and that cycle is wholly
  // theirs.
  const usRes = await client.query<{ c: number }>(`
    SELECT COUNT(DISTINCT sa.unit_id)::int AS c
      FROM utility_service_agreements sa
      JOIN units u ON u.id = sa.unit_id
     WHERE u.property_id = $1
       AND sa.status = 'active'
       AND sa.superseded_by_lease_id IS NULL
       AND sa.start_date <= ($2::date + INTERVAL '1 month' - INTERVAL '1 day')
       AND (sa.end_date IS NULL OR sa.end_date >= $2::date)
       AND (sa.payer_accepted_at IS NOT NULL OR sa.payer_attested_at IS NOT NULL)
  `, [propertyId, monthIso])
  const utilityServiceUnitCount = usRes.rows[0].c

  // ── Short-stay nights ────────────────────────────────────────────────
  // SUM of nights in the billing month across all short-stay bookings
  // on this property. Every night counts; bookings on units that ALSO
  // had a lease this month still contribute their nights (no exclusion).
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
       AND b.lease_type IN ('nightly', 'weekly')
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
       AND NOT (b.status = 'cancelled'
                AND (b.cancelled_at IS NULL OR b.cancelled_at::date < b.check_in))
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
    utilityService: utilityServiceUnitCount,
    shortStayNights,
    shortStayEquivalent,
    total: longTermUnitCount + shortStayEquivalent + utilityServiceUnitCount,
  }
}
