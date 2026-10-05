import { meterReadingModulus } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { createNotification } from './notifications'
import { UTILITY_TYPE_LABEL, UTILITY_UNIT_LABEL, type UtilityType } from '@gam/shared'
import { PAUSED_CYCLE_NOTE, PAUSED_CYCLE_MARKER_SQL } from './utilityPausedCycle'

// S90: utility bill generation engine.
//
// Three billing methods, all driven by utility_meters.billing_method:
//
//   submeter — meter serves a single unit. Usage = (current cycle reading
//     − prior cycle reading). Charge = usage × rate_per_unit + base_fee.
//     Requires two readings to compute usage; the first reading produces
//     no bill (no baseline).
//
//   rubs — Ratio Utility Billing System. One master meter serves multiple
//     units. The master cycle reading is allocated across units by the
//     configured rubs_allocation_method:
//       occupant_count — number of active lease tenants per unit
//       sqft           — units.sqft
//       bedrooms       — units.bedrooms
//       rented_spaces  — 1/N across the units actually LEASED
//       fixture_count  — units.water_fixture_count
//       unit_type_weight / hybrid — see rubs_weights
//     Each unit's share of the base_fee is allocated by the same ratio.
//     S558: metered exclusion (UNIT-DRIVEN) — a served unit that has its own
//     same-utility submeter is billed on that submeter and its cycle usage is
//     SUBTRACTED from the master pool before the split; only the un-submetered
//     units share the remainder. Derived from shared unit membership (no manual
//     meter link). Utility-neutral (water/gas/electric).
//
//   master_bill_to_landlord — landlord absorbs. No tenant bills generated.
//
// Per-unit, the lease_utility_responsibilities row gates whether the
// tenant or the landlord pays for that utility type at all. Bill is
// generated only when tenant_responsible = TRUE.
//
// Idempotency: utility_bills_one_per_meter_unit_cycle UNIQUE catches
// double-generates. The engine catches 23505 and skips silently — re-
// running a cycle is safe.

export interface GenerateBillsResult {
  meterId: string
  cycleMonth: string
  billsCreated: number
  unitsSkipped: number
  reason?: string
}

/** Pure usage math shared by the submeter branch and the S558 RUBS exclusion:
 *  cycle − prior, with odometer-rollover handling when the wrap was stamped.
 *
 *  S613 (Nic): the difference is in FACE TURNS; the multiplier converts it to
 *  billing units. A water face that counts per hundred gallons reads 413 → 415
 *  for 200 gallons, and billing at a penny a gallon has to see 200, not 2.
 *  Rollover uses the FACE modulus, so the wrap is computed before the multiply —
 *  a 7-digit face wraps at 10^7 turns whatever each turn is worth. */
function cycleUsageFromReadings(
  cycleVal: number, priorVal: number, isRollover: boolean, digits: number,
  multiplier = 1,
): number {
  let usage = cycleVal - priorVal
  if (usage < 0 && isRollover) usage = (meterReadingModulus(digits) - priorVal) + cycleVal
  return usage * (multiplier > 0 ? multiplier : 1)
}


/** S559: lowest comparable submeter usage for a BROKEN meter's cycle.
 *  A meter marked out of service has no valid read, so it bills the LOWEST
 *  usage among comparable units — same property, same unit_type (+ RV amp
 *  service) — for the same utility that cycle, rounded DOWN. Billed as a
 *  normal charge (NEVER labeled "estimated"): the tenant provably pays at or
 *  below every comparable neighbor, so there's nothing to dispute. Fallback:
 *  same property, any unit type. null when no comparable has real usage — we
 *  never invent a number with no basis. Rollover-negative comparables are
 *  excluded (usage > 0 filter), as are vacant spots — see the WHERE clause. */
export async function lowestComparableUsage(args: {
  brokenMeterId: string; propertyId: string; utilityType: string;
  unitType: string | null; rvAmpService: string | null; cycleIso: string;
}): Promise<number | null> {
  const run = (matchType: boolean) => query<{ usage: string }>(`
    -- S613: comparable usage is in BILLING UNITS, not face turns. Each meter
    -- carries its own multiplier, so a park mixing per-gallon and per-hundred
    -- faces still compares like with like — without this, a broken meter on a
    -- per-hundred face would be estimated at a hundredth of the real usage.
    SELECT (cyc.reading_value - pri.reading_value) * cm.reading_multiplier AS usage
      FROM utility_meters cm
      JOIN utility_meter_units cmu ON cmu.meter_id = cm.id
      JOIN units cu ON cu.id = cmu.unit_id
      JOIN LATERAL (
        SELECT reading_value, reading_date, created_at
          FROM utility_meter_readings
         WHERE meter_id = cm.id AND billing_cycle_month = $2
           AND reason = 'monthly_cycle' AND needs_review = false
         ORDER BY reading_date DESC LIMIT 1) cyc ON TRUE
      LEFT JOIN LATERAL (
        SELECT reading_value FROM utility_meter_readings
         WHERE meter_id = cm.id
           AND (reading_date, created_at) < (cyc.reading_date, cyc.created_at)
         ORDER BY reading_date DESC, created_at DESC LIMIT 1) pri ON TRUE
     WHERE cm.property_id = $1 AND cm.utility_type = $3
       AND cm.billing_method = 'submeter' AND cm.out_of_service = false
       AND cm.id <> $4
       AND pri.reading_value IS NOT NULL
       -- S637 (Nic, DIRECTIVE): "match the lowest of any other OCCUPIED spot."
       --
       -- A vacant spot reads zero because nobody is there, and averaging that
       -- in would estimate an occupied home at nothing — which is exactly the
       -- bill Chris Ast got. Only a lived-in spot tells you what living there
       -- costs. Zero-usage comparables are excluded for the same reason: a
       -- stuck meter must not become the yardstick for the next stuck meter.
       -- OCCUPIED MEANS SOMEBODY LIVES THERE — an active LEASE, not the unit's
       -- status flag. A spot can be marked occupied while it waits for a signed
       -- lease (RV 09 was, to hold it off the booking calendar), and such a spot
       -- draws almost nothing: 2 kWh against a real household's 120. Taking the
       -- unit flag at face value made that empty spot the yardstick and would
       -- have billed Julie Kenyon 42 cents for a month of electricity — the
       -- same near-zero bill this whole rule exists to prevent.
       AND EXISTS (SELECT 1 FROM leases cl
                    WHERE cl.unit_id = cu.id AND cl.status = 'active')
       AND (cyc.reading_value - pri.reading_value) > 0
       ${matchType
         ? `AND cu.unit_type IS NOT DISTINCT FROM $5
            AND cu.rv_amp_service IS NOT DISTINCT FROM $6`
         : ''}
  `, matchType
       ? [args.propertyId, args.cycleIso, args.utilityType, args.brokenMeterId, args.unitType, args.rvAmpService]
       : [args.propertyId, args.cycleIso, args.utilityType, args.brokenMeterId])

  let rows = await run(true)                       // same unit_type + amp
  if (rows.length === 0) rows = await run(false)   // fallback: same property
  const usages = rows.map(r => Number(r.usage)).filter(u => u > 0).sort((a, b) => a - b)
  if (usages.length === 0) return null

  // ── S637 (Nic): "Exclude suspiciously low or negative amounts." ──────────
  //
  // Negatives are already gone (a rolled-back meter is its own problem). What
  // remains is the near-zero comparable: a spot that is occupied on paper but
  // barely drawing — someone away for the month, or a space held for a tenant
  // who has not moved in. RV 09 read 2 kWh against a real household's 120, and
  // taking the plain minimum would have estimated a month of electricity at 42
  // cents. That is the same near-free bill this rule exists to prevent, arrived
  // at from the other direction.
  //
  // The floor is RELATIVE to the property's own cycle rather than a fixed
  // number, because "suspiciously low" for electricity in July is not the same
  // as for water in a park half full — and a hardcoded threshold would be wrong
  // somewhere the day it shipped. A quarter of the median is low enough to keep
  // a genuinely frugal household in the pool and high enough to drop a spot
  // that is effectively empty.
  //
  // A TENTH, not a quarter. At Mountain View the occupied spots ran 120, 461,
  // 592, 891 and 1259 kWh — a quarter of the median would have discarded the
  // 120 and estimated Julie Kenyon at $96.81 off the next one up. But 120 is
  // Randall Cox, a real household that simply uses little. The empty spot read
  // 2. A tenth separates those two cleanly; a quarter punishes frugality.
  const median = usages[Math.floor(usages.length / 2)]
  const floor = median * 0.10
  const credible = usages.filter(u => u >= floor)

  // ── S647 (Nic, DIRECTIVE): THE LOW END OF THE CLUSTER, NOT THE MINIMUM ──
  //
  //   "Let's do kind of the low end of the cluster of people. Blanca and Little
  //    Joe use more, but still less than a majority of people. That weeds out
  //    the two outliers — we want to be at the low end of where people are
  //    starting to cluster."
  //
  // The plain minimum was always going to be whoever used least, and at
  // Mountain View in August that was Randall Cox (120) and David Shultz (197):
  // real households, but two outliers below where everyone else sits. Martin
  // Alvarado's household of three was estimated off them. The 25th percentile of
  // the credible occupied usage is the low edge of the main group — 387 on that
  // cycle, which is the number Nic picked by eye — and it stays conservative:
  // three quarters of the neighbors used more.
  //
  // Nearest-rank, so the answer is always a usage somebody actually had.
  // S637's reasoning still stands for what it covered: a genuinely frugal
  // household stays IN the pool; it just no longer sets the price alone.

  // ── NOT BUILT YET (Nic, S637) — a meter that dies MID-month ──────────────
  //
  //   "Randall Cox may also have a meter that stopped working mid month... It's
  //    tough to tell until the next month when we know if his turns at all.
  //    Eventually I'd like it to flag somewhat consistent usage versus... takes
  //    the history of that spot and sees that, hey, it was a lot higher — that
  //    it would flag that one as broken mid month and charge the right amount."
  //
  // Everything above compares a spot against its NEIGHBORS this cycle. It
  // cannot see a meter that ran for two weeks and then stopped: the reading
  // moved, so nothing here calls it stuck, and a half-month of usage bills as a
  // full month. Catching that needs the spot's OWN history — several cycles of
  // its usage, and a flag when this cycle falls well outside its own range.
  //
  // Deliberately deferred: one cycle of history is not a baseline, and guessing
  // at a threshold now would produce false flags on every seasonal swing. Nic's
  // words: "That's something for later on."

  // If everything looked suspicious, the median is the honest answer — better a
  // typical bill than one drawn from the emptiest spot on the property.
  if (credible.length === 0) return Math.floor(median)
  return Math.floor(clusterLow(credible))
}

/** S647: the 25th percentile, nearest-rank, of an ascending list. */
/**
 * S648 (Nic, DIRECTIVE): unless the landlord chose estimates for the property,
 * a meter that did not move on an occupied space is BROKEN — flag it and bill
 * nothing.
 *
 *   "Flag if there's no change in the meter and flag that it's broken. That
 *    will encourage landlords to actually replace the meter... Other landlords
 *    can just do it the right way or not bill the person for electricity."
 *
 * Marks it out of service (the same mark the meters screen already shows, with
 * its "Mark repaired" button) and tells the landlord once. Nothing bills from
 * it until somebody marks it repaired.
 */
export async function flagBrokenMeter(
  meterId: string,
  opts: {
    exec?: (sql: string, params: any[]) => Promise<any[]>
    /**
     * 10/3 (final sweep): the property ESTIMATES a meter that is not reading
     * (properties.estimates_stuck_meters). The meter is still marked broken and
     * the landlord still told — Mountain View's RV 07, 08, 40 and 48 were
     * estimated month after month and nobody was ever asked to fix them. The
     * words say what is billed instead: the estimate, or nothing when no
     * similar occupied space gave a number to estimate from.
     */
    estimate?: { usage: number | null; unitLabel: string }
  } = {},
): Promise<void> {
  const run = opts.exec ?? ((sql: string, params: any[]) => query<any>(sql, params))
  const flipped = await run(
    `UPDATE utility_meters
        SET out_of_service = TRUE,
            out_of_service_since = COALESCE(out_of_service_since, CURRENT_DATE),
            updated_at = NOW()
      WHERE id = $1 AND out_of_service = FALSE
      RETURNING property_id, utility_type, label`, [meterId])
  if (!flipped.length) return
  const m = flipped[0]
  const who = await run(
    `SELECT l.user_id, l.id AS landlord_id, p.name AS property_name,
            (SELECT string_agg(u.unit_number, ', ') FROM utility_meter_units mu
               JOIN units u ON u.id = mu.unit_id WHERE mu.meter_id = $2) AS units
       FROM properties p JOIN landlords l ON l.id = p.landlord_id
      WHERE p.id = $1`, [m.property_id, meterId])
  if (!who.length) return
  const w = who[0]
  const what = UTILITY_TYPE_LABEL[m.utility_type as UtilityType] ?? m.utility_type
  const where = w.units ? `${w.units} at ${w.property_name}` : (m.label || w.property_name)
  const est = opts.estimate
  const billedInstead = !est
    ? `so it has been marked broken and no ${what.toLowerCase()} is being billed for it. `
      + `Replace or repair it, then mark it repaired on the Utilities page to resume billing.`
    : est.usage != null
    ? `so it has been marked broken. This property bills an estimate while a meter is broken: `
      + `${est.usage.toLocaleString('en-US')}${est.unitLabel ? ` ${est.unitLabel}` : ''}, the low end of what similar occupied spaces used, `
      + `and it keeps doing that every month until the meter is fixed. `
      + `Replace or repair it, then mark it repaired on the Utilities page with its new reading so the real usage bills again.`
    : `so it has been marked broken. This property bills an estimate while a meter is broken, but no similar occupied `
      + `space had a reading to estimate from, so nothing is billed for it this month. `
      + `Replace or repair it, then mark it repaired on the Utilities page with its new reading so it bills again.`
  const notice = {
    userId: w.user_id as string, landlordId: w.landlord_id as string, type: 'utility_meter_broken',
    title: `${what} meter not reading — ${where}`,
    body: `The ${what.toLowerCase()} meter for ${where} read the same number twice while the space was occupied, `
      + billedInstead,
    data: { meterId, propertyId: m.property_id },
    actionUrl: '/utilities',
  }
  // 10/3 (final sweep): inside a caller's transaction (a lease being signed,
  // releaseSuspendedChargesForLease) the notice is written on the SAME client
  // as the mark. createNotification writes through the pool, outside that
  // transaction: a signing that rolled back kept a "marked broken" notice for a
  // meter that was not marked, and the retry sent a second one. On the client,
  // the notice and the mark commit or roll back together. In-app only, like
  // createNotification for this type (it sends no email), and an error here is
  // the caller's to roll back — it owns the transaction and its savepoint.
  if (opts.exec) {
    const pref = await run(
      `SELECT in_app_enabled FROM notification_preferences WHERE user_id = $1 AND type = $2`,
      [notice.userId, notice.type])
    if (!pref.length || pref[0].in_app_enabled) {
      await run(
        `INSERT INTO notifications (user_id, landlord_id, type, title, body, data, action_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [notice.userId, notice.landlordId, notice.type, notice.title, notice.body,
         JSON.stringify(notice.data), notice.actionUrl])
    }
    return
  }
  try {
    await createNotification(notice)
  } catch (e) {
    logger.error({ err: e, meterId }, '[utility] could not notify the landlord about a broken meter')
  }
}

/**
 * 10/3 (final sweep, third pass): the note on a $0.00 bill of a household that
 * has left, closed out (void) because nothing on it was owed and so no final
 * bill was sent (invoiceEndedLeaseBills).
 */
const NOTHING_OWED_AFTER_MOVE_OUT_NOTE =
  'Closed: nothing was owed on it after the household left, so no final bill was sent.'

/**
 * 10/3 (final sweep): a lease that never took effect, as a condition on a
 * leases row aliased `l`: an unsigned draft thrown away (terminated with no
 * terminated_at — the booking cancel, the hold expiring, "discard draft"), or a
 * lease terminated before its start date (Mountain View RV 09: an onboarding
 * lease voided 9/18, before its 10/1 start). Nobody ever lived on a space under
 * it, so it is never the household a utility bill goes to, never a rented
 * space in a split, and never proof the space was occupied.
 */
function leaseNeverInForceSql(alias: string): string {
  return `(${alias}.status = 'terminated' AND (${alias}.terminated_at IS NULL
     OR ${alias}.terminated_at < (${alias}.start_date::timestamp AT TIME ZONE
          (SELECT tp.timezone FROM units tu JOIN properties tp ON tp.id = tu.property_id
            WHERE tu.id = ${alias}.unit_id))))`
}
const LEASE_NEVER_IN_FORCE_SQL = leaseNeverInForceSql('l')

/**
 * 10/3 (final sweep): a lease still in force on a date, as a condition on a
 * leases row aliased `l` (dateSql is a SQL date expression). Active is in force.
 * An ended or terminated lease is in force through its last day — the earlier
 * of its end date and the day it was terminated (on the property's calendar).
 *
 * The space-history row a lease opens is closed only when the lease MOVES
 * spaces, never when it ends, so without this a lease that ended in August
 * still "covered" October 1 — and the household that left was billed for what
 * the space used after they were gone, with a final utility invoice sent to
 * them for it (S548: the cycle belongs to the lease that covered its START).
 */
function leaseInForceOn(dateSql: string): string {
  return `(l.status = 'active' OR LEAST(COALESCE(l.end_date, 'infinity'::date),
      COALESCE((l.terminated_at AT TIME ZONE
          (SELECT tp.timezone FROM units tu JOIN properties tp ON tp.id = tu.property_id
            WHERE tu.id = l.unit_id))::date, 'infinity'::date)) >= ${dateSql})`
}

/**
 * 10/3 (final sweep, fifth pass): a household's last day on a space, as a SQL
 * date over a lease_unit_history row aliased `h`, its lease `l` and the
 * space's property `p`: the earliest of the lease's end date, the day it was
 * terminated (on the property's calendar) and the day before it moved to
 * another space (effective_to is the first day there). 'infinity' when none
 * applies — a lease still running on the space.
 */
const LEASE_LAST_DAY_ON_SPACE_SQL =
  `LEAST(COALESCE(l.end_date, 'infinity'::date),
         COALESCE(timezone(p.timezone, l.terminated_at)::date, 'infinity'::date),
         COALESCE(h.effective_to - 1, 'infinity'::date))`

/**
 * ── 10/3 (final sweep): WHO LIVED THERE ACROSS THE READ SPAN ──────────────────
 *
 * The stuck-meter test asks whether a meter that read the same number twice did
 * so while somebody lived on the space — between the read before and the cycle
 * read. Counting any lease that touched the cycle by even a day (or the space's
 * status at the instant the bills run) read a WORKING meter on an empty space as
 * broken: a tenant who moved out 9/5 with a move-out read, a lease that ended
 * 9/2, a lease terminated before it ever started (Mountain View RV 09), an
 * unsigned draft thrown away (RV 01), a new household that arrived after the
 * cycle. Each was marked broken, the landlord told it "read the same number
 * twice while the space was occupied", and an estimate billed — to the
 * departed tenant, or to the next one in place of the real reading.
 *
 * Somebody lived there across the span when, on THIS space (lease_unit_history,
 * as tryInsertBill reads it):
 *   - a lease was in force at the cycle read: active; an existing tenancy still
 *     being signed (pending — they already live there); an ended lease whose
 *     last day is on or after the cycle read; a terminated one likewise, if it
 *     ever took effect (terminated on or after its start — an unsigned draft
 *     thrown away carries no terminated_at and never did); and
 *   - it was there at the read before: it started on or before that read, or it
 *     is an existing tenancy (they lived there before their GAM lease began), or
 *     it continues a lease (a renewal) that was.
 * A lease's last day is the earlier of its end date, the day it was terminated,
 * and the day it moved to another space (effective_to is the first day there).
 *
 * The status still speaks for the two arrangements no lease records: the
 * owner's own household (owner_use) and a serviced space (utility_service).
 *
 * ── 10/3 (final sweep, third pass) ──────────────────────────────────────────
 *
 * A READ THAT CLOSED A HOUSEHOLD OUT. When the read before is a move-out read
 * (or a stay's turnover read), the household it read out is gone from that
 * read on: their time on the space ended with it. A lease ending 9/30 is
 * expired at 2am that day; the front desk reads it out on 9/30 (or 9/29), and
 * the September read later that day shows the same number — a month-end
 * move-out is usually read twice in the same cycle (S639). Counting that lease
 * "in force at the cycle read" marked a WORKING meter broken, told the landlord
 * the space was occupied, and left the next tenant billing nothing (or an
 * estimate) until somebody marked it repaired. After such a read a lease counts
 * only if its last day is AFTER the cycle read.
 *
 * AN INVITED EXISTING RESIDENT. Somebody invited as an existing resident
 * (pending_tenant_intents.is_existing_tenancy) lives there already, before any
 * lease row exists. An open invite made on or before the cycle read counts —
 * the same "count it as existing tenants here" (S642) the existing-tenancy
 * lease gets. Without it their flat meter was not flagged, a $0.00 share was
 * held for them, and that hold kept the signing-time check from flagging it
 * either (S647: "the stuck meters are not getting billed... the sixth time").
 *
 * ── 10/3 (final sweep, fourth pass) ─────────────────────────────────────────
 *
 * ...BUT ONLY WHILE THE ONBOARDING WINDOW IS OPEN — the same rule a share is
 * held for an invite by (S650, holdChargeForPendingUnit). Nobody closes an
 * invite when the window closes, so an invite left open after the resident
 * moved out kept the space "lived in" for good: a WORKING meter on an empty
 * space was marked broken, the landlord told it "read the same number twice
 * while the space was occupied", and the next tenant billed nothing (or an
 * estimate) until somebody marked it repaired. Once the window has closed an
 * invite is no evidence anybody lives there — and no share is held for it
 * either, so the two agree.
 */
const CLOSING_READ_REASONS = new Set(['move_out_final', 'stay_turnover'])

async function occupiedAcrossReadSpan(
  units: Array<{ unit_id: string; status: string }>,
  priorReadDate: string, cycleReadDate: string,
  /** The read before closed a household out (move_out_final / stay_turnover). */
  priorReadClosedOut = false,
): Promise<boolean> {
  if (units.some(u => u.status === 'owner_use' || u.status === 'utility_service')) return true
  const windowOpen = await onboardingWindowOpenSql('p')
  const hit = await queryOne<{ occupied: boolean }>(`
    SELECT (
      EXISTS (
        SELECT 1
          FROM lease_unit_history h
          JOIN leases l ON l.id = h.lease_id
          JOIN units u ON u.id = h.unit_id
          JOIN properties p ON p.id = u.property_id
         WHERE h.unit_id = ANY($1::uuid[])
           AND (h.effective_to IS NULL OR h.effective_to > $3::date)
           AND (
             l.status = 'active'
             OR (l.status = 'pending' AND COALESCE(l.is_existing_tenancy, FALSE))
             OR (l.status = 'expired' AND l.end_date >= $3::date)
             OR (l.status = 'terminated' AND NOT ${LEASE_NEVER_IN_FORCE_SQL}
                 AND LEAST(timezone(p.timezone, l.terminated_at)::date,
                           COALESCE(l.end_date, 'infinity'::date)) >= $3::date)
           )
           -- The read before closed a household out: their time there ended
           -- with it, so only a lease that runs PAST the cycle read counts.
           AND (NOT $4::boolean OR ${LEASE_LAST_DAY_ON_SPACE_SQL} > $3::date)
           AND (
             h.effective_from <= $2::date
             OR COALESCE(l.is_existing_tenancy, FALSE)
             OR EXISTS (
               SELECT 1 FROM lease_unit_history ph
                WHERE ph.lease_id = l.supersedes_lease_id AND ph.unit_id = h.unit_id
                  AND ph.effective_from <= $2::date)
           ))
      -- An existing resident invited on or before the cycle read, no lease
      -- yet — while the property's onboarding window is open (S650).
      OR EXISTS (
        SELECT 1
          FROM pending_tenant_intents pti
          JOIN units u ON u.id = pti.unit_id
          JOIN properties p ON p.id = u.property_id
         WHERE pti.unit_id = ANY($1::uuid[])
           AND pti.is_existing_tenancy
           AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL
           AND timezone(p.timezone, pti.created_at)::date <= $3::date
           AND ${windowOpen})
    ) AS occupied`,
    [units.map(u => u.unit_id), priorReadDate, cycleReadDate, priorReadClosedOut])
  return !!hit?.occupied
}

/**
 * ── 10/3 (final sweep): A LEASE PAUSED AT THE CYCLE READ ─────────────────────
 *
 * A meter that did not move on a lease that was paused (hibernating) is not a
 * broken meter — the household was away. The pause that explains a flat read
 * is one still on when the meter was read for the cycle: the lease went to
 * sleep on or before the cycle read's day (property calendar) and had not woken
 * before that day. Two ways to know it:
 *
 *   - ASLEEP NOW: the lease is still hibernating when the bills run,
 *     and went to sleep on or before the cycle read.
 *   - ASLEEP THEN, AWAKE NOW (third pass): resuming clears hibernated_at, so a
 *     household back before any run priced the cycle — the reading run held
 *     open for the landlord's review, or a below-previous typo flagged and
 *     corrected to the flat number after they were back — left no trace on the
 *     lease, and the flat meter was read as broken. The pause is still on
 *     record: every change to a lease is journaled (audit_row_changes, the
 *     audit_leases trigger), so a resume is a row whose old values were asleep
 *     (with the day it went to sleep) and whose new ones are awake, changed on
 *     the day it woke.
 *
 * (Fourth pass) NOT a pause of any length anywhere in the span. A lease asleep
 * 9/3 to 9/5 lived on the space for most of a 8/31-to-9/30 span; its meter
 * reading the same number twice is a broken meter, and September is billed
 * (or estimated) like any other month — never written off as "nothing was
 * used". Likewise a lease that went to sleep the day AFTER the cycle read: the
 * household lived through the whole span it measured.
 *
 * cycleReadDate is the cycle read's day, or the cycle's last day when it has
 * not been read yet. Returns the lease (the newest pause first), or null.
 */
async function leasePausedAtCycleRead(
  units: Array<{ unit_id: string }>, cycleReadDate: string,
): Promise<{ lease_id: string; tenant_id: string } | null> {
  const unitIds = units.map(u => u.unit_id)
  const now = await queryOne<{ lease_id: string; tenant_id: string }>(`
    SELECT l.id AS lease_id, lt.tenant_id
      FROM leases l
      JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary'
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
     WHERE l.unit_id = ANY($1::uuid[])
       AND COALESCE(l.is_hibernating, FALSE)
       AND l.status IN ('active', 'delinquent', 'suspended')
       AND l.hibernated_at < (($2::date + 1)::timestamp AT TIME ZONE p.timezone)
     ORDER BY l.hibernated_at DESC
     LIMIT 1`, [unitIds, cycleReadDate])
  if (now) return now
  const then = await queryOne<{ lease_id: string; tenant_id: string }>(`
    SELECT l.id AS lease_id, lt.tenant_id
      FROM leases l
      JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary'
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN audit_row_changes a
        ON a.table_name = 'leases' AND a.row_id = l.id AND a.op = 'UPDATE'
     WHERE l.unit_id = ANY($1::uuid[])
       AND COALESCE((a.old_row->>'is_hibernating')::boolean, FALSE)
       AND NOT COALESCE((a.new_row->>'is_hibernating')::boolean, FALSE)
       -- asleep by the end of the cycle read's day...
       AND COALESCE((a.old_row->>'hibernated_at')::timestamptz, '-infinity'::timestamptz)
             < (($2::date + 1)::timestamp AT TIME ZONE p.timezone)
       -- ...and still asleep when that day began: woke on it or later.
       AND a.changed_at >= ($2::date::timestamp AT TIME ZONE p.timezone)
     ORDER BY a.changed_at DESC
     LIMIT 1`, [unitIds, cycleReadDate])
  return then ?? null
}

export function clusterLow(ascending: number[]): number {
  if (ascending.length === 0) throw new Error('clusterLow: empty list')
  const rank = Math.ceil(0.25 * ascending.length)
  return ascending[Math.max(0, rank - 1)]
}


/** S607: the blended per-unit rate a `bill_amount` master prices its whole line
 *  at for one cycle — the provider's actual dollar charge divided by the total
 *  usage that charge covered.
 *
 *  Returned for a UNIT, because the submeter branch needs it too: a submetered
 *  unit sitting under a bill_amount master bills its MEASURED usage at this
 *  same rate, which is what makes the line recover exactly the bill and no more.
 *  Everyone on the line pays the park's true cost per gallon.
 *
 *  The provider's service charge and taxes are already inside the dollar figure,
 *  so they ride within the rate — Nic: "if they see it nickel and dimed as
 *  separate charges, here's the water rate, here's the fee for the water,
 *  they're not gonna like it... that just needs to have a blended rate on the
 *  back end to include any fee." One line item on the tenant's bill.
 *
 *  S634: RESOLVED BY PROPERTY, NOT BY SHARED MASTER MEMBERSHIP. This used to
 *  find the master by joining utility_meter_units on the submetered unit — the
 *  unit sat on both meters, which is exactly the shape S634 forbids ("the same
 *  unit cannot have two meter types for the same utility"). With that link gone
 *  the lookup returned nothing and every blended submeter silently fell back to
 *  the property rate, or to zero where none was set.
 *
 *  The blended figure is a PROPERTY-level fact anyway — what this park actually
 *  paid per gallon this cycle — so it is now computed from every blended-mode
 *  master of that utility on the property: total dollars ÷ total usage. On the
 *  single-master property (the common case, and Oak Park's mobile-home line)
 *  that is the identical number it always was. On a two-master property it is
 *  the honest combined cost rather than whichever master a join happened to
 *  reach first.
 *
 *  null whenever the property has no such master, the dollar bill has not been
 *  entered, or the cycle recorded no usage to divide by — every one of which
 *  falls back to the ordinary rate path rather than blocking. */
async function blendedRateForUnit(
  unitId: string, utilityType: string, cycleIso: string,
): Promise<{ rate: number; masterLabel: string } | null> {
  const row = await queryOne<{ label: string; bill_amount: string; reading_value: string }>(`
    SELECT string_agg(DISTINCT m.label, ', ') AS label,
           SUM(rd.bill_amount)   AS bill_amount,
           SUM(rd.reading_value) AS reading_value
      FROM units tu
      JOIN utility_meters m ON m.property_id = tu.property_id
                           AND m.billing_method = 'rubs'
                           AND m.rubs_basis = 'bill_amount'
                           AND m.rubs_submeter_rate = 'blended'
                           AND m.utility_type = $2
      JOIN utility_meter_readings rd ON rd.meter_id = m.id
                                    AND rd.billing_cycle_month = $3
                                    AND rd.reason = 'monthly_cycle'
                                    AND rd.bill_amount IS NOT NULL
                                    AND rd.needs_review = FALSE
                                    AND rd.reading_value > 0
     WHERE tu.id = $1`, [unitId, utilityType, cycleIso])
  if (!row || row.bill_amount == null || !(Number(row.reading_value) > 0)) return null
  return { rate: Number(row.bill_amount) / Number(row.reading_value), masterLabel: row.label }
}


/** S607: the statutory ceiling on what a SUBMETERED tenant may be charged per
 *  unit of usage — A.R.S. § 33-1413.01(B) for mobile home parks and
 *  § 33-2107(B)(3) for RV spaces both cap the landlord at "the prevailing basic
 *  service single family residential rate charged by the serving utility".
 *
 *  It bites specifically in blended mode: a park master usually sits on a bigger
 *  meter with a bigger service charge than a house, so dollars ÷ gallons can
 *  land above what a single-family customer pays for the same water.
 *
 *  NULL (not looked up yet) means no cap — this must never block a bill. Where
 *  it does apply the LANDLORD absorbs the difference. Under S634 that is
 *  automatic: the RUBS pool is the whole master bill and no submeter's charge is
 *  subtracted from it, so a capped submetered tenant's shortfall cannot reach
 *  the neighboring spaces by construction. */
async function prevailingRateCap(propertyId: string, utilityType: string): Promise<number | null> {
  const r = await queryOne<{ prevailing_residential_rate: string | null }>(
    `SELECT prevailing_residential_rate FROM property_utility_rates
      WHERE property_id = $1 AND utility_type = $2`, [propertyId, utilityType])
  const v = r?.prevailing_residential_rate
  return v == null ? null : Number(v)
}

/** S605: overlay the property's utility pricing onto a meter row, in place.
 *
 *  Mutates the row the billing math reads rather than threading a second rate
 *  through every branch — submeter, RUBS, flat-rate and the exclusion path all
 *  read `meter.rate_per_unit` / `base_fee` / `sewer_rate_per_unit`, and a policy
 *  that only reached some of them would be worse than none.
 *
 *  A property row with a NULL rate is treated as "not set for this utility" and
 *  leaves the meter's own value alone — configuring water must not silently zero
 *  out electric. */
async function applyPropertyRates(meter: any): Promise<void> {
  const pr = await queryOne<any>(
    `SELECT rate_per_unit, base_fee, sewer_rate_per_unit
       FROM property_utility_rates
      WHERE property_id = $1 AND utility_type = $2`,
    [meter.property_id, meter.utility_type])
  if (!pr) return
  if (pr.rate_per_unit != null) meter.rate_per_unit = pr.rate_per_unit
  if (pr.base_fee != null) meter.base_fee = pr.base_fee
  if (pr.sewer_rate_per_unit != null) meter.sewer_rate_per_unit = pr.sewer_rate_per_unit
}

/** S607: per-unit allocation basis for every supported RUBS split.
 *
 *  Returns one basis per unit; the caller divides each by their sum. A unit
 *  whose basis is 0 never bills and is counted as skipped, which is what keeps
 *  a vacancy (or a unit missing the data a basis needs) from silently absorbing
 *  someone else's share.
 *
 *  The menu is deliberately wider than any one state requires — Nic: "we need a
 *  wider window scope for available options, and we narrow it on our property
 *  setup." Nothing here decides what a landlord may use; it decides what they
 *  CAN use.
 *
 *  Config for the bases that need it lives on utility_meters.rubs_weights. */
async function allocationBases(
  method: string, weights: any, rubsUnits: any[], cycleIso: string,
): Promise<Array<{ unitId: string; basis: number }>> {
  const w = weights || {}

  /**
   * Headcount on a unit: active-lease tenants, or — when there is no lease yet
   * — the people INVITED to it.
   *
   * S629 (Nic): mid-onboarding a resident has been invited and has not signed,
   * so there is no lease, so an occupant_count split scored the unit zero and
   * dropped it from the pool. With 6 of 30 signed, those 6 split the water for
   * all 30. The people are living there and using the water; the paperwork is
   * what is outstanding, and the divisor should reflect the former.
   *
   * The invite roster gives the real number — this is not an assumed occupancy.
   * Their share is HELD rather than billed (see suspended_utility_charges) and
   * released onto their first invoice when they sign.
   */
  const occupants = async (unitId: string): Promise<number> => {
    const c = await queryOne<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM v_lease_active_tenants
       WHERE EXISTS (
         SELECT 1 FROM leases l
          WHERE l.id = v_lease_active_tenants.lease_id
            AND l.unit_id = $1 AND l.status = 'active'
            -- S650: asleep for the whole cycle → nobody there to count.
            AND NOT (COALESCE(l.is_hibernating, FALSE) AND l.hibernated_at <= $2::date))`, [unitId, cycleIso])
    const signed = Number(c?.count || 0)
    if (signed > 0) return signed
    const pending = await queryOne<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM pending_tenant_intents pti
       WHERE pti.unit_id = $1
         AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL`, [unitId])
    return Number(pending?.count || 0)
  }

  /** Is this space rented for the cycle? Measured the same way tryInsertBill
   *  attributes a bill — the lease covering the START of the cycle month — so a
   *  space that turned over mid-month counts once, not twice. */
  const isRented = async (unitId: string): Promise<boolean> => {
    const r = await queryOne<{ n: string }>(`
      SELECT COUNT(*)::text AS n FROM leases l
       WHERE l.unit_id = $1
         AND l.status IN ('active', 'expired', 'terminated')
         AND NOT ${LEASE_NEVER_IN_FORCE_SQL}
         AND l.start_date <= $2::date
         AND COALESCE(l.end_date, '9999-12-31'::date) > $2::date
         AND ${leaseInForceOn('$2::date')}
         -- S650: a lease asleep for the whole cycle takes no share.
         AND NOT (COALESCE(l.is_hibernating, FALSE) AND l.hibernated_at <= $2::date)`, [unitId, cycleIso])
    return Number(r?.n || 0) > 0
  }

  const out: Array<{ unitId: string; basis: number }> = []
  for (const u of rubsUnits) {
    let basis = 0
    switch (method) {
      // An equal share per RENTED space — the only equal-split the platform
      // offers, because the naive version (every unit on the meter) hands a
      // VACANT space a full share that then finds no tenant and is never
      // billed, leaving the landlord to eat it. Also the basis the Arizona RV
      // statute names, which is why it exists in this shape.
      case 'rented_spaces':
        // S609: an owner-occupied space has no lease, so isRented() is false —
        // but unlike a VACANT space it is lived in and drawing water. It takes
        // a full share, which the landlord then absorbs rather than bills.
        //
        // S615: a UTILITY-SERVICE space is the same shape and was missed. It
        // has no lease either, so it scored 0 — and its consumption was then
        // divided among the paying tenants, who would have quietly covered the
        // neighbor's water. Unlike an owner-occupied space this one BILLS:
        // there is a payer on the agreement, so it takes its share and is
        // charged for it rather than absorbed.
        basis = (u.status === 'owner_use' || u.status === 'utility_service'
          || await isRented(u.unit_id)) ? 1 : 0
        break
      case 'sqft':
        basis = Number(u.sqft || 0)
        break
      case 'bedrooms':
        basis = Number(u.bedrooms || 0)
        break
      // S609: an owner-occupied unit has NO LEASE, so there are no tenants to
      // count — it would score 0 and its usage would land on the paying
      // tenants instead. The landlord states the household size; it is a real
      // occupied home and never counts as nobody.
      // S615: a serviced space has no lease tenants to count either, for the
      // same structural reason. Both read the landlord-stated household size —
      // the column is named for the case that introduced it, but what it holds
      // is "how many people live in a space with no lease to count from",
      // which is exactly as true next door as it is for an owner.
      case 'occupant_count':
        basis = (u.status === 'owner_use' || u.status === 'utility_service')
          ? Math.max(1, Number(u.owner_household_size || 1))
          : await occupants(u.unit_id)
        break
      // Per plumbing fixture — an old and still widespread water basis, on the
      // theory that fixtures proxy draw better than floor area. A unit with no
      // count recorded contributes 0 and is reported as skipped rather than
      // quietly taking a share it has no basis for.
      case 'fixture_count':
        basis = Number(u.water_fixture_count || 0)
        break
      // Landlord-set weight per unit type, so a park can say a mobile home draws
      // 1.5× an RV spot without inventing square footage for either.
      case 'unit_type_weight':
        // S615: same omission as rented_spaces above — a lease-less but
        // occupied space scored 0 and pushed its draw onto the tenants.
        basis = (u.status === 'owner_use' || u.status === 'utility_service'
          || await isRented(u.unit_id)) ? Number(w[u.unit_type] || 0) : 0
        break
      default:
        basis = 0
    }
    out.push({ unitId: u.unit_id, basis })
  }

  // A percentage blend of two other bases (50% sq ft + 50% occupancy is the
  // common third-party RUBS split). Each side is normalized to shares FIRST, so
  // the blend is of proportions rather than of raw numbers — otherwise square
  // footage, being in the hundreds, would swamp a headcount in the ones.
  // The result already sums to 1, which the caller's divide handles unchanged.
  if (method === 'hybrid') {
    const primary   = String(w.primary || 'sqft')
    const secondary = String(w.secondary || 'occupant_count')
    const pct = Math.min(100, Math.max(0, w.primaryPct != null ? Number(w.primaryPct) : 50)) / 100
    // Guard against a config that points at itself — that would recurse forever.
    if (primary === 'hybrid' || secondary === 'hybrid') return out
    const a = await allocationBases(primary, w, rubsUnits, cycleIso)
    const b = await allocationBases(secondary, w, rubsUnits, cycleIso)
    const sumA = a.reduce((s, x) => s + x.basis, 0)
    const sumB = b.reduce((s, x) => s + x.basis, 0)
    return a.map((x, i) => ({
      unitId: x.unitId,
      basis: (sumA > 0 ? pct * (x.basis / sumA) : 0)
           + (sumB > 0 ? (1 - pct) * (b[i].basis / sumB) : 0),
    }))
  }

  return out
}

export async function generateBillsForMeter(
  meterId: string,
  cycleMonth: Date,  // 1st of month
): Promise<GenerateBillsResult> {
  const cycleIso = isoMonthStart(cycleMonth)

  const meter = await queryOne<any>(
    `SELECT * FROM utility_meters WHERE id = $1`, [meterId])
  if (!meter) throw new AppError(404, 'Meter not found')

  // S605 (Nic, DIRECTIVE): "make utility rates set at the property level. adding
  // each unit is redundant and possible discrimination."
  //
  // Pricing is PROPERTY POLICY. Where the property sets a rate for this utility
  // it overrides whatever the meter carries, so every tenant at the property is
  // billed the same price for the same utility no matter who typed their unit
  // in. Same choke point as the S535 property-level late fees, for the same
  // reason.
  //
  // The meter columns remain the fallback for properties not yet configured, and
  // each utility_bills row still snapshots the rate it was charged at — so an
  // issued bill never changes because policy changed later.
  await applyPropertyRates(meter)

  // Get the property's landlord — utility_meters carry property_id, not
  // landlord_id directly. Snapshot at generation time.
  const property = await queryOne<{ landlord_id: string }>(
    `SELECT landlord_id FROM properties WHERE id = $1`, [meter.property_id])
  if (!property) throw new AppError(404, 'Property not found for meter')
  const landlordId = property.landlord_id

  if (meter.billing_method === 'master_bill_to_landlord') {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: 0,
      reason: 'master_bill_to_landlord — landlord absorbs, no tenant bills' }
  }

  // S533: landlord-configured tax rate for this utility at this property
  // (no row = 0). Snapshotted per bill; shown as a separate amount.
  const taxRow = await queryOne<{ tax_rate_pct: string }>(`
    SELECT tax_rate_pct FROM property_utility_tax_rates
     WHERE property_id = $1 AND utility_type = $2
  `, [meter.property_id, meter.utility_type])
  const taxRatePct = Number(taxRow?.tax_rate_pct || 0)

  // Resolve which units this meter serves.
  // submeter: utility_meter_units row(s) — usually one. RUBS: many.
  const units = await query<any>(`
    SELECT u.id AS unit_id, u.unit_number, u.sqft, u.bedrooms,
           u.unit_type, u.rv_amp_service, u.water_fixture_count,
           -- S613: how many of this service the unit takes (2 trash cans).
           -- Multiplies a FLAT charge only; usage already carries it elsewhere.
           mu.quantity,
           -- S609: an owner-occupied unit takes a real share of the pool that
           -- the LANDLORD absorbs, so the basis needs to know which units those
           -- are and how many people live in them.
           u.status, u.owner_household_size
      FROM utility_meter_units mu
      JOIN units u ON u.id = mu.unit_id
     WHERE mu.meter_id = $1
  `, [meterId])

  if (units.length === 0) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: 0,
      reason: 'meter not assigned to any units' }
  }

  /** S613 (Nic): "Say owner occupied has a trash can. Are we logging that?"
   *
   *  The owner-use absorption ledger existed only inside the RUBS split, so an
   *  owner-occupied unit on a FLAT charge or with its own SUBMETER produced
   *  nothing at all: tryInsertBill needs a tenant and a lease, an owner-occupied
   *  unit has neither, so the charge was dropped and counted as skipped. The
   *  landlord is still paying for that service — the can is still emptied, the
   *  meter still turns — and the audit answer ("billed out plus kept back equals
   *  what the property consumed") only reconciles if every method records it. */
  const recordOwnerUseAbsorption = async (args: {
    unitId: string; utilityType: string; chargeAmount: number
    allocationMethod: string; allocationBasis: number | null; baseFeeShare?: number; notes: string
  }) => {
    await query(`
      INSERT INTO utility_owner_use_absorptions
        (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
         allocation_method, allocation_basis, charge_amount, base_fee_share, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (meter_id, unit_id, billing_cycle_month) DO UPDATE
        SET charge_amount = EXCLUDED.charge_amount,
            allocation_basis = EXCLUDED.allocation_basis,
            base_fee_share = EXCLUDED.base_fee_share,
            updated_at = NOW()
    `, [meterId, args.unitId, landlordId, args.utilityType, cycleIso,
        args.allocationMethod, args.allocationBasis,
        args.chargeAmount.toFixed(2), (args.baseFeeShare ?? 0).toFixed(2), args.notes])
  }

  if (meter.billing_method === 'flat_rate') {
    // S558 (Nic): fixed per-unit charge with NO meter reading (e.g. a flat trash
    // buildback). Each served unit bills the flat amount as its own line item so
    // the tenant sees exactly what they pay for, instead of it being folded into
    // rent. Utility-neutral. tryInsertBill still gates on the per-unit
    // tenant_responsible flag.
    //
    // S609 (Nic, DIRECTIVE): THE AMOUNT COMES FROM THE PROPERTY, NOT THE METER.
    //
    //   "It's a discrimination thing. If you're billing a flat rate per unit, it
    //    needs to not be editable. It needs to be set at the property level the
    //    same way late fees are... anybody that's opted into it automatically
    //    gets the flat twenty five dollars."
    //
    // He is right, and this is the same rule that already governs processing
    // fees: a per-PROPERTY setting, never a per-unit one. A flat charge that
    // could be edited per meter is a mechanism for billing two identical units
    // two different amounts for the same service, which is exactly the shape of
    // a discrimination claim. Reading it from property_utility_rates makes
    // "everyone on this pays the same" structural rather than a matter of care.
    //
    // What stays per-unit is WHETHER the unit is on the meter at all — a
    // resident hauling their own trash is simply not assigned.
    const propertyRate = await queryOne<{ rate_per_unit: string }>(
      `SELECT rate_per_unit FROM property_utility_rates
        WHERE property_id = $1 AND utility_type = $2`,
      [meter.property_id, meter.utility_type])
    const flatAmount = Number(propertyRate?.rate_per_unit || 0)
    if (flatAmount <= 0) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: `no ${meter.utility_type} rate set for this property — set it on the Utilities page (Rates) and every unit on this meter bills that amount` }
    }
    let created = 0, skipped = 0
    for (const unit of units) {
      // S613: an owner-occupied unit on a flat charge — the landlord's own
      // household still has the trash can, and the service is still paid for.
      // Recorded, billed to nobody.
      // S613: everyone pays the same price per can; a unit with two cans pays
      // for two. The quantity rides the bill as its allocation basis so the
      // invoice line, and anyone auditing it later, can see WHY the amount is a
      // multiple of the property rate.
      const qty = Math.max(1, Number(unit.quantity ?? 1))
      const unitCharge = round2(flatAmount * qty)
      if (unit.status === 'owner_use') {
        await recordOwnerUseAbsorption({
          unitId: unit.unit_id, utilityType: meter.utility_type,
          chargeAmount: unitCharge, allocationMethod: 'flat_rate', allocationBasis: qty,
          baseFeeShare: unitCharge,
          notes: 'Owner-occupied unit — the flat charge for this service, absorbed by the landlord and billed to nobody.',
        })
        skipped++
        continue
      }
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: null,
        allocationMethod: 'flat_rate',
        allocationBasis: qty,
        ratePerUnit: flatAmount,
        baseFeeShare: unitCharge,
        chargeAmount: unitCharge,
        taxRatePct,
      })
      if (inserted) created++; else skipped++
    }
    if (created > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
    return { meterId, cycleMonth: cycleIso, billsCreated: created, unitsSkipped: skipped }
  }

  // Broken meter (S559): out of service → bill the LOWEST comparable usage
  // (same property + unit_type/amp) that cycle, rounded down, as a NORMAL
  // charge. No read needed, never labeled "estimated", never blocks the
  // end-of-month flow. Only individual submeters bill this way — RUBS pools
  // / flat / master have no per-unit odometer to substitute. Placed BEFORE
  // the cycle-reading fetch so a stuck/absent read never holds billing.
  // ── S637 (Nic, DIRECTIVE): A STUCK METER ON AN OCCUPIED SPOT IS OUT OF SERVICE ──
  //
  //   "A meter with identical values and flagged as occupied needs to... those
  //    two need to correlate that it's out of service."
  //
  // The estimation below has always worked — but only for a meter somebody had
  // marked out_of_service BY HAND, and in practice nobody ever has: not one
  // meter in the system carries the flag. So a submeter reading the identical
  // number two cycles running billed ZERO instead of estimating, and Chris Ast
  // paid a month's rent at RV 07 with no electricity on it at all.
  //
  // Occupied plus no movement is the correlation. A vacant spot reading zero is
  // simply a vacant spot — 33 of them read zero this cycle and every one of
  // those is correct. An OCCUPIED one cannot use nothing.
  // ── S640 (Nic): "Jared Coil in RV twenty three was not billed for
  // electricity. So I wanna double check that that's not a broken meter. And if
  // it is, it should be matching the lowest real use case." ─────────────────
  //
  // It is a broken meter — RV 23 read 44999 in August and 44999 in September —
  // and the rule above was written for exactly that. It did not fire because
  // this line asked whether the unit was 'active', and Jared is DELINQUENT.
  //
  // Delinquent and suspended spots are occupied. That is what those statuses
  // MEAN: somebody lives there and owes for it. Reading occupancy as 'active'
  // only is the same mistake that made Expected Monthly Rent read low, and here
  // it is worse — a resident behind on rent is precisely who must not silently
  // get a free month of electricity, and the person least able to absorb the
  // catch-up bill when somebody notices. Nic found this one by eye.
  //
  // Everything downstream is unchanged: a stuck meter still bills the LOWEST
  // real usage among occupied neighbors, so the estimate can only ever be
  // conservative.
  //
  // S640 (Nic, DIRECTIVE, second pass): "Any occupied spot of any status gets
  // that treatment — delinquent or active or whatever. Anything that's not
  // vacant is fine."
  //
  // So the test was stated as the EMPTY states rather than a list of occupied
  // ones. Naming the occupied statuses is how this broke: the set was written
  // when three of them existed, 'owner_use' was added later, and nothing went
  // back to add it. (10/3: occupancy is now read from who lived there across
  // the read span — below — which reaches every occupied status through the
  // lease behind it, and owner_use / utility_service, which have none, by name.)
  //
  // S642 (Nic, via Calvin Curtis on RV 40): "it's not showing any electricity —
  // we're supposed to be matching broken reads that are active spots."
  //
  // The test was the unit's status AT THIS INSTANT, and the instant is wrong.
  // A lease finalizing bills its utilities BEFORE the unit is marked occupied,
  // so a space somebody had lived in all cycle still read 'vacant' while its
  // bill was being written — the stuck check was skipped and the charge came
  // out $0. Four spaces at Mountain View were billed nothing that way: MH 04,
  // RV 07, RV 40, RV 41, every one within days of its lease starting.
  //
  // Reordering the finalize path would fix that one caller and leave every
  // other one exposed. The real question is not what the status says right now,
  // it is whether anybody was in the space DURING THE CYCLE.
  //
  // ── 10/3 (final sweep): DURING THE READ SPAN, AND BY WHO WAS THERE ─────────
  //
  // "During the cycle" was a lease touching the month by even one day, OR the
  // status right now. Both read a WORKING meter on an empty space as broken:
  // a tenant gone 9/5 with a move-out read (the space empty and the meter flat
  // after it), a lease ended 9/2, a lease terminated before it started
  // (Mountain View RV 09 — every month), an unsigned draft thrown away (RV 01),
  // a household that arrived after the September read when September ran
  // again. Each was marked broken, the landlord told the space was occupied,
  // and an estimate billed to the departed tenant — or, the meter now marked
  // broken, to the next one in place of their real reading.
  //
  // The meter is broken only if it did not move while somebody lived there
  // ACROSS the span it measured — from the read before to the cycle read
  // (occupiedAcrossReadSpan). Every status that means somebody lives there
  // (active, delinquent, suspended — S640: "anything that's not vacant") comes
  // from a lease, and the lease says WHEN; the status only says now. The owner's
  // own household and a serviced space have no lease, so for those two the
  // status still speaks. An onboarding resident (existing tenancy) counts from
  // before their GAM lease began (S642: "count it as existing tenants here").

  // The span the cycle read measures: from the read before it (and why that
  // read was taken) to the cycle read. With no read before it, only the cycle
  // read's day is known (the prior fields are null).
  const move = meter.billing_method === 'submeter'
    ? await queryOne<{ usage: string | null; prior_date: string | null; cycle_date: string; prior_reason: string | null }>(`
      SELECT (cyc.reading_value - pri.reading_value)::text AS usage,
             to_char(pri.reading_date, 'YYYY-MM-DD') AS prior_date,
             to_char(cyc.reading_date, 'YYYY-MM-DD') AS cycle_date,
             pri.reason AS prior_reason
        FROM (SELECT reading_value, reading_date, created_at
                FROM utility_meter_readings
               WHERE meter_id = $1 AND billing_cycle_month = $2
                 AND reason = 'monthly_cycle'
               ORDER BY reading_date DESC LIMIT 1) cyc
        LEFT JOIN LATERAL (
             SELECT reading_value, reading_date, reason FROM utility_meter_readings
              WHERE meter_id = $1
                AND (reading_date, created_at) < (cyc.reading_date, cyc.created_at)
              ORDER BY reading_date DESC, created_at DESC LIMIT 1) pri ON TRUE
    `, [meterId, cycleIso])
    : null

  // ── 10/3 (final sweep): A METER THAT DID NOT MOVE ON A PAUSED LEASE IS NOT BROKEN ──
  //
  // Mountain View RV 50 and RV 51 went to sleep on 9/19 (hibernation: the
  // households were away), and their meters had not moved since 8/1. The stuck
  // test below read that as a dead meter and billed each a $22.47 estimate for
  // September: power the meter shows nobody used. A household that is away is
  // the reason the meter did not move. So when the lease on the space was
  // paused at the cycle read — asleep when the meter was read for the cycle,
  // whether it is still asleep now or has woken since (leasePausedAtCycleRead)
  // — the reading is taken at its word: no estimate, no broken flag. With no
  // cycle read yet, the cycle's last day stands in for it.
  //
  // (Fourth pass) A pause that was over before the cycle read is not one: the
  // household lived on the space after it, so a meter that did not move is
  // still a broken meter (lease asleep 9/3 to 9/5, the meter flat 8/31 to 9/30).
  const paused = meter.billing_method === 'submeter'
    ? await leasePausedAtCycleRead(units, move?.cycle_date ?? lastDayOfCycle(cycleIso))
    : null
  // 10/3 (final sweep): ...and stays that way once the household is back. The
  // paused cycle is written down as a $0.00 void bill (below). Resuming clears
  // hibernated_at, so a later run of the same cycle — the review page while the
  // reading run is open, the run completing, "Generate bills", a resolved
  // double-check — no longer sees a sleeping lease, and read the same flat meter
  // as broken: marked it, told the landlord the space was occupied, and billed
  // the next month an estimate instead of its real reading. The record of the
  // paused cycle answers it (and the lease's change journal answers it before
  // any run wrote the record — leasePausedAtCycleRead).
  const pausedMarker = meter.billing_method === 'submeter'
    ? await queryOne<{ id: string }>(`
        SELECT ub.id FROM utility_bills ub
         WHERE ub.meter_id = $1 AND ub.billing_cycle_month = $2
           AND ${PAUSED_CYCLE_MARKER_SQL}
         LIMIT 1`, [meterId, cycleIso])
    : null
  const pausedCycle = !!paused || !!pausedMarker

  let stuckOnOccupied = false
  if (meter.billing_method === 'submeter' && !meter.out_of_service && !pausedCycle) {
    // IDENTICAL, not merely non-positive. A NEGATIVE delta is a meter that
    // rolled back — a misread or a replaced head — and has its own handling
    // below. Swallowing it here would bill an estimate for what is really a
    // data-entry problem somebody needs to look at.
    //
    // 10/3 (final sweep, third pass): and over at least a day. Two reads on the
    // same day — an opening (baseline) or replaced-meter read and the cycle
    // read, or a move-out read and the cycle read — measure no time at all, so
    // the same number twice is no evidence the meter is dead. Oak Park RV 24's
    // new water meter opened at 21800 on 9/30, September's read day; a
    // brand-new meter was marked broken the moment it was read.
    stuckOnOccupied = move?.usage != null && move.prior_date != null && Number(move.usage) === 0
      && move.prior_date < move.cycle_date
      && await occupiedAcrossReadSpan(units, move.prior_date, move.cycle_date,
           CLOSING_READ_REASONS.has(move.prior_reason ?? ''))
  }

  // S648 (Nic, DIRECTIVE): estimating is the LANDLORD's per-property choice
  // (properties.estimates_stuck_meters, off by default). Off: a broken meter
  // bills NOTHING and is flagged.
  const broken = meter.billing_method === 'submeter' && (meter.out_of_service || stuckOnOccupied)
  const propertyEstimates = broken
    && (await queryOne<{ on: boolean }>(
         `SELECT estimates_stuck_meters AS on FROM properties WHERE id = $1`, [meter.property_id]))?.on === true
  if (broken && !propertyEstimates) {
    if (stuckOnOccupied) await flagBrokenMeter(meterId)
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: 'meter not reading — marked broken, nothing billed until it is repaired' }
  }

  // 10/3: a meter already marked broken is never estimated for a paused lease
  // either — the household is away, and the reads it has are billed as they
  // stand (below), so a meter that did not move bills nothing. Nor for a cycle
  // already written down as paused, after the household is back.
  if (broken && propertyEstimates && !pausedCycle) {
    const brokenUnit = units[0]
    const compUsage = await lowestComparableUsage({
      brokenMeterId: meterId, propertyId: meter.property_id,
      utilityType: meter.utility_type,
      unitType: brokenUnit?.unit_type ?? null,
      rvAmpService: brokenUnit?.rv_amp_service ?? null,
      cycleIso,
    })
    // ── 10/3 (final sweep): AN ESTIMATED METER IS STILL A BROKEN METER ──────
    //
    // Estimating used to be the whole answer at a property that chose it, so a
    // dead meter was estimated every month forever and nobody was ever asked to
    // fix it (Mountain View RV 07, 08, 40 and 48). The meter is now marked
    // broken here too — the same mark, and the same "Mark repaired" button on
    // the Utilities page — and the landlord is told once, with what is being
    // billed in its place. An estimate stops when the meter is repaired.
    if (stuckOnOccupied) {
      await flagBrokenMeter(meterId, { estimate: {
        usage: compUsage,
        unitLabel: UTILITY_UNIT_LABEL[meter.utility_type as UtilityType] ?? '',
      } })
    }
    if (compUsage == null) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'broken meter — no comparable unit usage to bill from (flag for landlord)' }
    }
    const sewerRate = meter.utility_type === 'water' ? Number(meter.sewer_rate_per_unit || 0) : 0
    const sewerTaxRatePct = sewerRate > 0
      ? Number((await queryOne<{ tax_rate_pct: string }>(`
          SELECT tax_rate_pct FROM property_utility_tax_rates
           WHERE property_id = $1 AND utility_type = 'sewer'
        `, [meter.property_id]))?.tax_rate_pct || 0)
      : 0
    // S640: a zero-dollar bill this same meter+cycle already wrote is not a
    // record of anything — it is the absence of a reading, filed as though the
    // resident used nothing. It also BLOCKS the estimate: tryInsertBill is
    // idempotent per (meter, unit, cycle), so a re-run after the occupancy fix
    // above would find RV 23's $0.00 row and skip. Clear the empty rows so the
    // real number can land. Only $0 and only not-yet-billed — anything a
    // resident has actually been invoiced for stays exactly where it is.
    await query(`
      DELETE FROM utility_bills
       WHERE meter_id = $1 AND billing_cycle_month = $2
         AND charge_amount = 0 AND tax_amount = 0
         AND status = 'unbilled' AND payment_id IS NULL`,
      [meterId, cycleIso])

    let created = 0, skipped = 0
    for (const unit of units) {
      const baseCharge = compUsage * Number(meter.rate_per_unit || 0) + Number(meter.base_fee || 0)
      const sewerCharge = compUsage * sewerRate
      const taxAmount = Math.round(baseCharge * taxRatePct + sewerCharge * sewerTaxRatePct) / 100
      // ── S640 (Nic): AN OWNER-OCCUPIED SPOT'S USAGE IS THE LANDLORD'S MONEY ──
      //
      //   "If an owner-occupied spot has a submeter that's broken, we still want
      //    to flag that usage so the owner's keeping track of the real money.
      //    Giving somebody a free spot to live is just money that's not coming
      //    in, they're not losing anything. But when they're paying the
      //    utilities on behalf of somebody, that's actual real money going out."
      //
      // The distinction is exact. Free rent costs the landlord nothing they had;
      // the power bill is a check they write. A broken meter on such a spot
      // meant the usage was never even estimated, so the one number that IS a
      // real loss was the one nobody had.
      if (unit.status === 'owner_use') {
        await recordOwnerUseAbsorption({
          unitId: unit.unit_id, utilityType: meter.utility_type,
          chargeAmount: round2(baseCharge + sewerCharge),
          allocationMethod: 'comparable_low', allocationBasis: compUsage,
          baseFeeShare: Number(meter.base_fee || 0),
          notes: `Owner-occupied unit, meter not reading — estimated at ${compUsage} `
            + `from the lowest real occupied usage on the property. Paid by the landlord, billed to nobody.`,
        })
        skipped++
        continue
      }
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: compUsage,
        allocationMethod: 'comparable_low',
        allocationBasis: null,
        ratePerUnit: Number(meter.rate_per_unit || 0),
        baseFeeShare: Number(meter.base_fee || 0),
        chargeAmount: baseCharge + sewerCharge,
        taxRatePct,
        taxAmount,
        sewerRatePerUnit: sewerRate > 0 ? sewerRate : null,
        readingStart: null,
        readingEnd: null,
      })
      if (inserted) created++; else skipped++
    }
    if (created > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
    return { meterId, cycleMonth: cycleIso, billsCreated: created, unitsSkipped: skipped }
  }

  // Get the cycle reading. Both submeter and RUBS need this.
  const cycleReading = await queryOne<any>(`
    SELECT reading_value, is_rollover, needs_review, reading_date, created_at, bill_amount
      FROM utility_meter_readings
     WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'
     ORDER BY reading_date DESC LIMIT 1
  `, [meterId, cycleIso])

  if (!cycleReading) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: 'no reading recorded for this cycle' }
  }

  let billsCreated = 0
  let unitsSkipped = 0

  if (meter.billing_method === 'submeter') {
    // A reading flagged for the landlord double-check (below-previous
    // outlier or suspicious-high usage, S533) never bills until the
    // review resolves it — resolve-review re-runs this meter's cycle.
    if (cycleReading.needs_review) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'reading awaiting double-check — no bill until resolved' }
    }
    // Single unit per submeter (by convention). Usage = cycle - prior cycle.
    // Point-in-time baseline (S559): usage is measured from the read
    // IMMEDIATELY BEFORE this cycle read by time — which may be a mid-month
    // turnover/reference read that reset the baseline, not last month's
    // cycle read. That's what keeps a departed short-term guest's usage off
    // the next occupant's bill.
    const priorReading = await queryOne<any>(`
      SELECT reading_value, reading_date
        FROM utility_meter_readings
       WHERE meter_id = $1
         AND (reading_date, created_at) < ($2, $3)
       ORDER BY reading_date DESC, created_at DESC LIMIT 1
    `, [meterId, cycleReading.reading_date, cycleReading.created_at])
    if (!priorReading) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'no prior reading — first cycle baseline, no bill produced' }
    }
    // Odometer rollover (S533, automatic): usage wraps past the meter's digit
    // capacity = (10^digits − prior) + current, e.g. a 6-digit 999822 → 000138
    // = 316. is_rollover is stamped at entry when the wrap is plausible (< half
    // the meter's range) or by the landlord's double-check confirmation.
    const usage = cycleUsageFromReadings(
      Number(cycleReading.reading_value), Number(priorReading.reading_value),
      !!cycleReading.is_rollover, meter.digits, Number(meter.reading_multiplier ?? 1))
    if (usage < 0) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: `negative usage (${usage}) — awaiting reading double-check` }
    }
    // 10/3 (final sweep): the lease on the space is paused and the meter did
    // not move — nothing was used and nothing is owed. It is written down as a
    // $0.00 bill marked void, with the reason (PAUSED_CYCLE_NOTE), so the cycle
    // reads as done: without it, a run after the household is back (the lease
    // awake again, ensureBillsForUnit looking back two cycles) would find no
    // bill, read the same flat meter as broken, and estimate a month the
    // household was away. A run after they are back finds the record and stops
    // here too.
    if (pausedCycle && usage === 0) {
      // The lease asleep at the cycle read — still asleep, or awake again
      // before this run (10/3 third pass) — the record names it either way.
      const pauser = paused
      if (pauser) {
        for (const unit of units) {
          if (unit.status === 'owner_use') continue
          await query(`
            INSERT INTO utility_bills
              (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
               usage_amount, allocation_method, rate_per_unit, base_fee_share, charge_amount,
               tax_rate_pct, tax_amount, utility_type, reading_start, reading_end,
               reading_start_date, reading_end_date, status, notes)
            VALUES ($1,$2,$3,$4,$5,$6,0,'submeter',$7,0,0,$8,0,$9,$10,$11,$12,$13,'void',$14)
            ON CONFLICT DO NOTHING`,
            [meterId, unit.unit_id, pauser.tenant_id, pauser.lease_id, landlordId, cycleIso,
             Number(meter.rate_per_unit || 0), taxRatePct, meter.utility_type,
             Number(priorReading.reading_value), Number(cycleReading.reading_value),
             priorReading.reading_date ?? null, cycleReading.reading_date ?? null,
             PAUSED_CYCLE_NOTE])
        }
      }
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'lease paused (hibernating) and the meter did not move — nothing to bill' }
    }
    // 10/3 (final sweep): a cycle written down as paused whose read now shows
    // the meter moving was corrected after the fact (the landlord fixed the
    // read). "Nothing was used" no longer holds, so the record goes and the
    // cycle is priced from the corrected read like any other — billed to the
    // household, or reported if the lease slept through the whole cycle.
    if (pausedMarker) {
      await query(
        `DELETE FROM utility_bills ub
          WHERE ub.meter_id = $1 AND ub.billing_cycle_month = $2 AND ${PAUSED_CYCLE_MARKER_SQL}`,
        [meterId, cycleIso])
    }
    // S533: sewer rides the water meter — there is no sewer meter in
    // the field, and the tenant sees ONE line item. A water submeter
    // with sewer_rate_per_unit bills usage × (water rate + sewer rate)
    // + base fee on a single bill; the tax amount sums each portion ×
    // its own per-type landlord tax rate. Both rates snapshot on the
    // bill for the audit trail.
    const sewerRate = meter.utility_type === 'water' ? Number(meter.sewer_rate_per_unit || 0) : 0
    const sewerTaxRatePct = sewerRate > 0
      ? Number((await queryOne<{ tax_rate_pct: string }>(`
          SELECT tax_rate_pct FROM property_utility_tax_rates
           WHERE property_id = $1 AND utility_type = 'sewer'
        `, [meter.property_id]))?.tax_rate_pct || 0)
      : 0
    for (const unit of units) {
      // S607: a submetered unit sitting under a `bill_amount` master bills its
      // MEASURED usage at that master's blended rate — the same cost per gallon
      // the pooled spaces on the same line pay. That is what makes the line
      // recover exactly the provider's bill: measured units take their true
      // share, the pool takes the rest.
      //
      // Blended mode substitutes the RATE and nothing else. Everything the
      // landlord layered on — base fee, sewer rate, tax rate — still applies on
      // top, because in this mode the provider's own charges are already inside
      // the dollar figure, so anything configured here is by definition the
      // LANDLORD'S OWN addition (the admin/margin lever every RUBS biller
      // charges). Zeroing them out, as this first did, silently removed that
      // lever from every landlord on the platform. GAM does not decide what a
      // landlord may charge — it bills what they configure. Nic: "we are not
      // enforcing legality... we offer the flexibility for all the different
      // options to be billed in all the ways that are common use."
      //
      // With those fields left at 0/unset — the common case, and Oak Park's —
      // the line recovers exactly the provider's bill and no more.
      //
      // The prevailing-residential cap applies only when the landlord has
      // recorded one. Unset = uncapped: an opt-in tool, never a gate.
      const blended = await blendedRateForUnit(unit.unit_id, meter.utility_type, cycleIso)
      const cap = blended ? await prevailingRateCap(meter.property_id, meter.utility_type) : null
      const effRate = blended
        ? (cap != null ? Math.min(blended.rate, cap) : blended.rate)
        : Number(meter.rate_per_unit || 0)
      const baseCharge = usage * effRate + Number(meter.base_fee || 0)
      const sewerCharge = usage * sewerRate
      const taxAmount = Math.round(baseCharge * taxRatePct + sewerCharge * sewerTaxRatePct) / 100
      // S640 (Nic): the same money the broken-meter branch above now records —
      // and this is the branch that runs when the meter WORKS. An owner-occupied
      // unit has no tenant and no lease, so tryInsertBill had nothing to bill
      // and quietly dropped the charge. The landlord was paying it either way;
      // the absorption ledger is where that shows up, and it is what makes the
      // property audit ("billed out plus kept back equals what we consumed")
      // reconcile for a submetered owner household.
      if (unit.status === 'owner_use') {
        await recordOwnerUseAbsorption({
          unitId: unit.unit_id, utilityType: meter.utility_type,
          chargeAmount: round2(baseCharge + sewerCharge),
          allocationMethod: 'submeter', allocationBasis: usage,
          baseFeeShare: Number(meter.base_fee || 0),
          notes: `Owner-occupied unit — ${usage} metered, paid by the landlord and billed to nobody.`,
        })
        unitsSkipped++
        continue
      }
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: usage,
        allocationMethod: 'submeter',
        allocationBasis: null,
        ratePerUnit: effRate,
        baseFeeShare: Number(meter.base_fee || 0),
        chargeAmount: baseCharge + sewerCharge,
        taxRatePct,
        taxAmount,
        sewerRatePerUnit: sewerRate > 0 ? sewerRate : null,
        readingStart: Number(priorReading.reading_value),
        readingEnd: Number(cycleReading.reading_value),
        readingStartDate: priorReading.reading_date ?? null,
        readingEndDate: cycleReading.reading_date ?? null,
      })
      if (inserted) billsCreated++
      else unitsSkipped++
    }
    if (billsCreated > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
    return { meterId, cycleMonth: cycleIso, billsCreated, unitsSkipped }
  }

  // RUBS: split the master reading across the units it serves — but a served
  // unit that has its OWN submeter of this utility is billed on that submeter
  // and its usage is SUBTRACTED from the pool; only the un-submetered units
  // split the remainder. S558 (Nic): the exclusion is derived from UNIT
  // MEMBERSHIP — assign every unit the master feeds, and the ones with a
  // same-utility submeter fall out automatically (no manual linking). If any
  // such submeter can't be resolved this cycle, the pool is unknowable — do NOT
  // bill (would over-charge the RUBS units the submetered units' usage).
  // S607: a master total the entry guard doubts (an implausible jump against
  // the master's own history) must not price the pool. A submeter is held by
  // the same rule, but this one number bills EVERY unit the master feeds, and
  // the flagged-readings card is the only second look it ever gets — masters
  // are not in the blind verification walk. Holding here is also what keeps
  // the correction path working: bills generated off a suspect total would
  // survive the landlord's correction, because the per-cycle UNIQUE turns the
  // regenerate into a no-op. Resolving the flag re-runs this meter.
  if (cycleReading.needs_review) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: 'master usage total awaiting double-check — no bills until resolved' }
  }

  // S613: everything below is the RUBS path, and it used to be reached by
  // FALLING OFF the end of the submeter branch — "not master, not flat, not
  // submeter" was treated as RUBS. That is fine for the four methods that exist
  // and a trap for the fifth: any method added to the enum without its own
  // branch would silently start splitting a pool across units. Say it out loud
  // instead, so an unhandled method reports itself rather than billing.
  if (meter.billing_method !== 'rubs') {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: `unsupported billing method "${meter.billing_method}" — nothing billed` }
  }

  const masterUsage = Number(cycleReading.reading_value)
  // S607 (Nic, DIRECTIVE): `bill_amount` masters divide the provider's ACTUAL
  // dollar charge instead of pricing usage at a rate we chose. Nic: "you're
  // allowed to take the total dollar value of the bill and divide it out, not
  // just the gallons usage — that way you're recouping the full cost of the
  // bill. On a bill with low gallon usage and then your base fee, you're not
  // recouping that." Resolved before the exclusion loop because the loop needs
  // the blended rate to price a submeter set to follow it.
  //
  // usage_rate masters (the default, and every existing master) fall through
  // completely unchanged.
  const billAmount = meter.rubs_basis === 'bill_amount' && cycleReading.bill_amount != null
    ? Number(cycleReading.bill_amount) : null
  const blendedRate = billAmount != null && masterUsage > 0 ? billAmount / masterUsage : null
  const subOnUnit = await query<{ unit_id: string; submeter_id: string }>(
    `SELECT smu.unit_id, sm.id AS submeter_id
       FROM utility_meter_units smu
       JOIN utility_meters sm ON sm.id = smu.meter_id
      WHERE sm.billing_method = 'submeter'
        AND sm.utility_type = $2
        AND smu.unit_id = ANY($1::uuid[])`,
    [units.map((u: any) => u.unit_id), meter.utility_type])
  const excludedUnitIds = new Set(subOnUnit.map(r => r.unit_id))
  const estimatedNotes: string[] = []
  // S634 (Nic, DIRECTIVE) — THE RUBS PORTION COMES OFF THE WHOLE BILL, FIRST.
  //
  // Nic, verbatim: "The RUBS system needs to bill off of the total dollar amount
  // divided by occupancy off the master bill. Submeters bill off of the gallons
  // usage after. RUBS portion is divided out first. The RUBS people eat the full
  // bill. Submeter is extra."
  //
  // WHAT THIS REPLACES. Every version of this code up to S607 treated the
  // submetered units as a CARVE-OUT: price their measured gallons, subtract that
  // from the master, and split what was left across the RUBS units. Two settings
  // (`rubs_exclusion_mode` = 'usage' | 'dollars') existed only to argue about how
  // to measure the carve-out. All of it is gone.
  //
  // WHY THE CARVE-OUT WAS WRONG, AND NOT JUST IMPRECISE. It made the RUBS units'
  // bill a function of somebody else's meter. At Oak Park in August a single
  // mis-keyed submeter read (22100 typed as 227700 on MH 09) priced that unit's
  // "share" at $2,056 against a $94.01 water bill. The carve-out consumed the
  // entire pool, the clamp floored it at zero, and every RUBS unit on the
  // property was billed $0.00 for water — the landlord ate the whole bill and
  // nothing in the product said so. A model where one unit's typo silently zeroes
  // eight other units' bills is not a rounding problem.
  //
  // THE MODEL NOW. The master bill divides across the RUBS units by occupancy,
  // whole. Submetered units are not part of that split and do not reduce it —
  // they bill their own measured gallons, on top, as separate revenue. The
  // landlord recovers the provider's bill from the RUBS side no matter what any
  // submeter reads, and the submeters are the extra. That is what "the RUBS
  // people eat the full bill, submeter is extra" means, and it is the shape that
  // cannot be broken by a bad read on a meter that belongs to someone else.
  //
  // Under S634's one-meter-type-per-utility rule a unit can no longer be on both
  // this master and a same-utility submeter, so `subOnUnit` is empty on any
  // correctly-configured property. It is still honored for legacy rows — such a
  // unit bills its submeter, not a RUBS share — and reported, because a landlord
  // whose data predates the constraint should be told which unit to fix.
  if (excludedUnitIds.size > 0) {
    estimatedNotes.push(
      `${excludedUnitIds.size} unit${excludedUnitIds.size === 1 ? ' is' : 's are'} on both this master `
      + `and a ${meter.utility_type} submeter — they were billed on the submeter and left out of the `
      + `RUBS split. A unit should be on one or the other for a given utility.`)
  }
  // Only the units WITHOUT their own submeter split the pool.
  const rubsUnits = units.filter((u: any) => !excludedUnitIds.has(u.unit_id))
  const totalUsage = masterUsage
  if (meter.rubs_basis === 'bill_amount' && billAmount == null) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: 'this master bills from the utility bill total, which has not been entered for this cycle' }
  }
  // S607 (Nic): "we need the entire bill to be able to input as a total dollar
  // amount." Usage is NOT required to divide a bill — an electric bill with peak
  // and off-peak tiers, demand charges and riders has no single usage×rate to
  // reconstruct, and forcing a usage figure to make the arithmetic work would be
  // asking the landlord to invent one.
  //
  // S634 (Nic, DIRECTIVE) — THERE IS NO CARVE-OUT. See the pool note below: the
  // RUBS units divide the WHOLE bill, so a master with no usage figure still
  // divides cleanly whether or not submetered units sit on the line.
  // Blended mode substitutes the RATE only. A base fee configured here is the
  // LANDLORD'S own addition on top of the provider's bill — the admin/margin
  // lever RUBS billers normally charge — so it still applies. Left at 0 (the
  // common case, and Oak Park's) the pool recovers exactly the bill.
  const totalBaseFee = Number(meter.base_fee || 0)
  const ratePerUnit = blendedRate ?? Number(meter.rate_per_unit || 0)
  // S607: sewer rides the water MASTER exactly as it rides a water submeter
  // (S533) — there is no sewer meter in the field and the tenant sees one line
  // item. Without this, a park that submeters its mobile homes and RUBS-splits
  // its spots billed sewer on the mobile homes and silently dropped it on the
  // spots, off the same property water policy. Inert until a sewer rate is set.
  //
  // Both stay live in blended mode too. Anything configured here is the
  // landlord's own layer on top of the provider's bill, and GAM does not decide
  // which layers a landlord is allowed — it bills what they set up. Unset, as at
  // Oak Park, they contribute nothing and the pool is exactly the bill.
  //
  // Either way the tenant sees ONE line: every component collapses into a single
  // charge_amount. Nic: "that just needs to have a blended rate on the back end
  // to include any fee... that way it's not a separate line item."
  const sewerRate = meter.utility_type === 'water' ? Number(meter.sewer_rate_per_unit || 0) : 0
  const effTaxRatePct = taxRatePct
  const sewerTaxRatePct = sewerRate > 0
    ? Number((await queryOne<{ tax_rate_pct: string }>(`
        SELECT tax_rate_pct FROM property_utility_tax_rates
         WHERE property_id = $1 AND utility_type = 'sewer'
      `, [meter.property_id]))?.tax_rate_pct || 0)
    : 0
  // S634: the pool is the WHOLE bill (or the whole master usage priced at the
  // rate), plus whatever the landlord layers on. Nothing is subtracted — see the
  // directive above. `rubs_exclusion_mode` no longer has anything to select
  // between and is dead config; it is left on the table so no existing master
  // fails to load, and the S607 migration comment marks it superseded.
  const totalWaterCharge = (billAmount != null ? billAmount : totalUsage * ratePerUnit) + totalBaseFee
  const totalSewerCharge = totalUsage * sewerRate
  const totalCharge = totalWaterCharge + totalSewerCharge

  // Compute per-unit basis, then divide.
  const unitBases = await allocationBases(
    meter.rubs_allocation_method, meter.rubs_weights, rubsUnits, cycleIso)

  const totalBasis = unitBases.reduce((s, u) => s + u.basis, 0)
  if (totalBasis === 0) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: `RUBS basis sums to zero (allocation_method=${meter.rubs_allocation_method}) — no bills generated` }
  }

  // S587 (Nic): reconcile rounding so the per-unit bills sum EXACTLY to the pool
  // charge. Rounding each share to the cent otherwise drops a penny or two per
  // cycle (e.g. $100 across 3 units = $33.33×3 = $99.99). The leftover (±) is
  // placed on the LOWEST bill. Fully deterministic — a re-run recomputes the
  // identical split — so it stays safe with the engine's re-runnable design.
  // basis-0 units (e.g. a vacant occupant_count unit) never bill; counted as
  // skipped and excluded from the split.
  const billable = unitBases.filter(ub => ub.basis > 0)
  unitsSkipped += unitBases.length - billable.length
  const alloc = billable.map(ub => {
    const share = ub.basis / totalBasis
    const waterShare = round2(totalWaterCharge * share)
    const sewerShare = round2(totalSewerCharge * share)
    return {
      unitId:       ub.unitId,
      basis:        ub.basis,
      baseFeeShare: round2(totalBaseFee * share),
      chargeAmount: round2(waterShare + sewerShare),
      waterShare,
      sewerShare,
    }
  })
  let ownerUseWithheld = 0
  const residual = round2(totalCharge - alloc.reduce((s, a) => s + a.chargeAmount, 0))
  if (residual !== 0 && alloc.length > 0) {
    let lo = alloc[0]
    for (const a of alloc) if (a.chargeAmount < lo.chargeAmount) lo = a
    lo.chargeAmount = round2(lo.chargeAmount + residual)
  }
  // S609 (Nic, DIRECTIVE): the OWNER'S OWN SHARE IS WITHHELD, NOT BILLED.
  //
  // An owner-occupied unit now scores a real basis above, so it takes a genuine
  // slice of the pool — which is the point: the tenants' shares no longer add up
  // to the whole bill, so they stop paying for the owner's water. That slice is
  // simply not charged to anyone. The landlord already paid the utility company;
  // this is the part they don't get back.
  //
  // It is RECORDED rather than quietly dropped. Nic: "We need that as a line
  // item on a specific utility cost that's owner use that is not passed through.
  // That way, if there's ever an audit, the landlord can provide, hey, these
  // utilities were not factored into being billed back to people."
  //
  // A bill row with status 'owner_use' and no tenant or lease is exactly that
  // record: it sits in the same ledger as every other bill for the cycle, so
  // "the master's pool, less what was billed out" reconciles to it. It carries
  // no payment and is never invoiced — nothing collects a bill that has no
  // tenant on it.
  const ownerUnitIds = new Set(
    rubsUnits.filter((u: any) => u.status === 'owner_use').map((u: any) => u.unit_id))
  for (const a of alloc) {
    if (ownerUnitIds.has(a.unitId)) {
      // Recorded in its own ledger rather than as a bill: utility_bills requires
      // a tenant and a lease (every bill has a payer, which is an invariant
      // worth keeping), and an owner-occupied unit has neither. Re-runnable —
      // the unique index makes a repeated cycle a no-op, same as tryInsertBill.
      await query(`
        INSERT INTO utility_owner_use_absorptions
          (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
           allocation_method, allocation_basis, charge_amount, base_fee_share, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (meter_id, unit_id, billing_cycle_month) DO UPDATE
          SET charge_amount   = EXCLUDED.charge_amount,
              allocation_basis = EXCLUDED.allocation_basis,
              base_fee_share  = EXCLUDED.base_fee_share,
              updated_at      = NOW()
      `, [
        meterId, a.unitId, landlordId, meter.utility_type, cycleIso,
        meter.rubs_allocation_method, a.basis,
        a.chargeAmount.toFixed(2), a.baseFeeShare.toFixed(2),
        'Owner-occupied unit — its share of the pool, absorbed by the landlord and billed to nobody.',
      ])
      ownerUseWithheld = round2(ownerUseWithheld + a.chargeAmount)
      continue
    }
    const inserted = await tryInsertBill({
      meterId, unitId: a.unitId, landlordId,
      utilityType: meter.utility_type,
      cycleMonth: cycleIso,
      usageAmount: null,
      allocationMethod: meter.rubs_allocation_method,
      allocationBasis: a.basis,
      ratePerUnit,
      baseFeeShare: a.baseFeeShare,
      chargeAmount: a.chargeAmount,
      taxRatePct: effTaxRatePct,
      // Each portion taxed at its own type's landlord rate, as on a submeter
      // bill. With no sewer rate configured this is left undefined so
      // tryInsertBill keeps computing tax off the final (post-residual)
      // charge exactly as before — no sewer, no behavior change.
      ...(sewerRate > 0
        ? { taxAmount: Math.round(a.waterShare * effTaxRatePct + a.sewerShare * sewerTaxRatePct) / 100,
            sewerRatePerUnit: sewerRate }
        : {}),
      // The dates both statutes require alongside the readings. A pooled space
      // has no meter of its own; the master's cycle read dates the period.
      readingEndDate: cycleReading.reading_date ?? null,
    })
    if (inserted) billsCreated++
    else unitsSkipped++
  }

  if (billsCreated > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
  // S605: the bill went out either way — say plainly what had to be inferred so
  // the landlord can read those meters and correct next cycle. Silence here was
  // the old failure in a new costume.
  return {
    meterId, cycleMonth: cycleIso, billsCreated, unitsSkipped,
    ...(estimatedNotes.length
      ? { reason: `Billed with estimated submeter usage — ${estimatedNotes.join('; ')}. Read these meters and correct next cycle.` }
      : {}),
  }
}

/** S559: bill a MOVE-OUT final read on a submeter — the departing responsible
 *  tenant's usage from the previous read up to this read, for the read's cycle
 *  month. Reuses the responsibility-gated insert + immediate ended-lease
 *  invoicing. Reference reads (turnover/replaced/other) never call this —
 *  except a space move's closing read (unitMove, S652), recorded as 'other'
 *  and billed here as the move-out read for the space the resident left.
 *  Known limitation: the per-(meter,unit,cycle,utility) bill uniqueness lets
 *  only ONE billed tenant per unit per cycle — fine when the arrival is a
 *  utilities-included short-term stay (the common RV turnover), a follow-up
 *  otherwise.
 *
 *  10/3 (final sweep, sixth pass): `leaseId` — the household this read closes
 *  out, when the caller knows it. A resident moving to another space
 *  (unitMove) has the old space read BEFORE their space history closes, so on
 *  the data alone they look like a household still living there, and a
 *  household that left earlier without a read of its own ranked ahead of
 *  them: A's lease ended 9/5 with no read, D (there since 9/6) moved to
 *  another space on 9/20 — the 100 kWh went to A, with a final utility
 *  invoice, and D was billed nothing. The move knows whose read it is, so it
 *  says. The lease still has to be one the read could bill (on the space
 *  after the read before, arrived before the read's day); it is ranked first,
 *  never forced. Without it the read bills by the move-out rule in
 *  tryInsertBill, as before. */
export async function billMoveOutRead(
  meterId: string, readingId: string,
  // spaceMove (10/3): the closing read of a resident moving to another space.
  // They are staying, so their old-space usage rides their next regular bill
  // (labeled with the old space, S641) — no "final" invoice, no "your last
  // days" email, no deposit talk. Anyone else the read bills (a household that
  // already left) still gets the final bill.
  opts: { leaseId?: string | null; spaceMove?: boolean } = {},
): Promise<{ billed: boolean; reason?: string }> {
  const meter = await queryOne<any>(`SELECT * FROM utility_meters WHERE id = $1`, [meterId])
  if (!meter || meter.billing_method !== 'submeter') return { billed: false, reason: 'not a submeter' }
  // S605: a move-out bill is priced by the same property policy as every other
  // bill — a departing tenant must not be charged a different rate than the one
  // moving in behind them.
  await applyPropertyRates(meter)
  const property = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM properties WHERE id = $1`, [meter.property_id])
  if (!property) return { billed: false, reason: 'property not found' }
  // S560: format billing_cycle_month to 'YYYY-MM-DD' in SQL — pg returns a
  // `date` column as a JS Date, and String(date).slice(0,10) yields "Wed Jul 01"
  // (invalid), which crashed tryInsertBill's insert. to_char keeps it a string.
  const read = await queryOne<any>(`SELECT reading_value, reading_date, created_at, to_char(reading_date, 'YYYY-MM-DD') AS reading_day, to_char(billing_cycle_month, 'YYYY-MM-DD') AS billing_cycle_month FROM utility_meter_readings WHERE id = $1`, [readingId])
  if (!read) return { billed: false, reason: 'reading not found' }
  const prior = await queryOne<any>(`
    SELECT reading_value, to_char(reading_date, 'YYYY-MM-DD') AS reading_day FROM utility_meter_readings
     WHERE meter_id = $1 AND (reading_date, created_at) < ($2, $3)
     ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
    [meterId, read.reading_date, read.created_at])
  if (!prior) return { billed: false, reason: 'no prior read — baseline only, nothing to bill' }
  // S560 (Nic): a below-previous move-out read is an odometer ROLLOVER — bill the
  // wrapped usage automatically. A physical meter swap is recorded separately as
  // its own 'meter_replaced' read (fresh baseline, no charge), so it never
  // arrives here as an ambiguous wrap — no landlord flag needed. (Short-term
  // stays don't bill at all; that path never calls billMoveOutRead.)
  const cur = Number(read.reading_value)
  const priorVal = Number(prior.reading_value)
  // S561 (Nic): auto-detect an odometer rollover (cur < prior) and bill the wrap
  // — but only when it's PHYSICALLY plausible. A meter can only wrap if the prior
  // read was near its ceiling; if prior is well below the top, a below-prior read
  // is almost certainly a mis-entered (typo) reading, not a real wrap. Billing the
  // "wrap" there would over-charge the departing tenant a huge phantom amount, so
  // we refuse and surface it (the person entering the move-out read sees the
  // reason immediately and re-checks the number) rather than auto-bill a monster.
  const digits = Number(meter.digits)
  const isRollover = cur < priorVal
  if (isRollover && priorVal < meterReadingModulus(digits) * 0.9) {
    return { billed: false, reason: 'move-out read is below the previous read but the meter was not near its ceiling — likely a mis-entered reading, not a rollover; please re-check the number' }
  }
  const usage = cycleUsageFromReadings(cur, priorVal, isRollover, digits,
    Number(meter.reading_multiplier ?? 1))

  const units = await query<any>(`SELECT u.id AS unit_id FROM utility_meter_units mu JOIN units u ON u.id = mu.unit_id WHERE mu.meter_id = $1`, [meterId])
  const cycleIso = String(read.billing_cycle_month).slice(0, 10)
  const taxRatePct = Number((await queryOne<{ tax_rate_pct: string }>(`SELECT tax_rate_pct FROM property_utility_tax_rates WHERE property_id = $1 AND utility_type = $2`, [meter.property_id, meter.utility_type]))?.tax_rate_pct || 0)
  const sewerRate = meter.utility_type === 'water' ? Number(meter.sewer_rate_per_unit || 0) : 0
  const sewerTaxRatePct = sewerRate > 0
    ? Number((await queryOne<{ tax_rate_pct: string }>(`SELECT tax_rate_pct FROM property_utility_tax_rates WHERE property_id = $1 AND utility_type = 'sewer'`, [meter.property_id]))?.tax_rate_pct || 0)
    : 0
  let billed = false
  for (const unit of units) {
    const baseCharge = usage * Number(meter.rate_per_unit || 0) + Number(meter.base_fee || 0)
    const sewerCharge = usage * sewerRate
    const taxAmount = Math.round(baseCharge * taxRatePct + sewerCharge * sewerTaxRatePct) / 100
    const inserted = await tryInsertBill({
      meterId, unitId: unit.unit_id, landlordId: property.landlord_id,
      utilityType: meter.utility_type, cycleMonth: cycleIso,
      usageAmount: usage, allocationMethod: 'submeter', allocationBasis: null,
      ratePerUnit: Number(meter.rate_per_unit || 0), baseFeeShare: Number(meter.base_fee || 0),
      chargeAmount: baseCharge + sewerCharge, taxRatePct, taxAmount,
      sewerRatePerUnit: sewerRate > 0 ? sewerRate : null,
      readingStart: Number(prior.reading_value), readingEnd: Number(read.reading_value),
      // 10/3 (third pass): the dates the bill must show (S607), and the read
      // before is where the span starts — the household billed was still there.
      readingStartDate: prior.reading_day, readingEndDate: read.reading_day,
      moveOut: true, moveOutLeaseId: opts.leaseId ?? null,
    })
    if (inserted) billed = true
  }
  if (billed) await invoiceEndedLeaseBills(meterId, cycleIso, {
    moveOut: true, stayingLeaseId: opts.spaceMove ? (opts.leaseId ?? null) : null,
  })
  // S639: a silent `billed: false` left the person at the meter with nothing to
  // act on. The common cause is that this cycle was ALREADY billed off the
  // monthly run — the run opens on the last business day, so a tenant who pulls
  // out on the 31st is usually read twice in the same cycle. That is not an
  // error (they were billed through the run's read; the last days fall to the
  // landlord), but the reader has to be told, not left guessing. Still blind:
  // a reason names the situation, never a reading value.
  if (!billed) {
    return { billed, reason: units.length === 0
      ? 'this meter is not attached to a unit — nothing to bill'
      : 'no new charge — this cycle was already billed for the unit (the monthly run read it), or the tenant does not owe this utility' }
  }
  return { billed }
}

// S548 (Nic — immediate move-out settlement): a bill that just landed on an
// ENDED lease has no next cycle to ride — invoice it NOW so the landlord's
// receivable and the departing tenant's deposit surplus square up the day
// of pull-out. Best-effort: a failure here never unwinds bill generation
// (the deposit-return sweep remains the backstop). Dynamic import because
// invoiceGeneration imports this module (ensureBillsForUnit).
//
// S639 (Nic, verbatim): "Read is taken the last fucking business day of the
// month. Or if they happen to move out on the thirty first, it's when they
// unplug and drive away. It's immediately so they can be billed. It's not the
// next day or the day after that."
//
// The lease-ended test below is what keeps the FOUR ordinary billing paths that
// call this (monthly submeter, RUBS, dollar-master, ensureBillsForUnit) from
// cutting a separate same-day invoice for every tenant the moment their meter is
// read — their charge belongs on the normal monthly invoice. So it stays.
//
// But it was wrong for the move-out path, which is the one case where "the lease
// has already ended on paper" is the wrong question. A tenant who pulls out on
// the 28th while the lease runs to the 31st failed that test, so the charge was
// created and then sat `unbilled` until the next monthly run — past the deposit
// return, and exactly the wait Nic says must not happen. Somebody standing at the
// meter recording a FINAL read IS the move-out; the paper end date has no say.
// `moveOut` is passed only from billMoveOutRead, which runs off a
// `move_out_final` read or a space move's closing read on the old space
// (unitMove, S652).
export async function invoiceEndedLeaseBills(
  meterId: string, cycleIso: string, opts: { moveOut?: boolean; stayingLeaseId?: string | null } = {},
): Promise<void> {
  try {
    const ended = await query<{ lease_id: string; renewal_id: string | null; still_active: boolean; owes: boolean }>(`
      SELECT DISTINCT ub.lease_id,
             -- RENEWAL: a lease that ended because the household renewed is
             -- not a move-out. Its renewal (landlord-signed, e-signed, linked).
             (SELECT s.id FROM leases s
               WHERE s.supersedes_lease_id = l.id AND s.lease_source = 'esigned'
                 AND s.status IN ('pending', 'active') AND s.signed_by_landlord
               ORDER BY s.start_date LIMIT 1) AS renewal_id,
             (l.status = 'active') AS still_active,
             -- 10/3 (final sweep): anything on the final bill to pay. A meter
             -- that did not move after the household left writes a $0.00 bill;
             -- on its own that is not a final bill — no $0.00 invoice, and no
             -- "your final utility bill is ready: $0.00" to the person who left.
             EXISTS (SELECT 1 FROM utility_bills ob
                      WHERE ob.lease_id = l.id AND ob.payment_id IS NULL
                        AND ob.status IN ('unbilled', 'billed')
                        AND ob.charge_amount + ob.tax_amount > 0) AS owes
        FROM utility_bills ub
        JOIN leases l ON l.id = ub.lease_id
       WHERE ub.meter_id = $1 AND ub.billing_cycle_month = $2
         AND ub.payment_id IS NULL AND ub.status IN ('unbilled', 'billed')
         AND ub.lease_id IS NOT NULL
         AND ($3::boolean
              OR l.status IN ('expired', 'terminated')
              OR (l.end_date IS NOT NULL AND l.end_date <= CURRENT_DATE))
    `, [meterId, cycleIso, opts.moveOut === true])
    if (ended.length === 0) return
    const { generateFinalUtilityInvoice } = await import('../jobs/invoiceGeneration')
    for (const r of ended) {
      // SPACE MOVE: this household moved to another space and is staying.
      if (opts.stayingLeaseId && r.lease_id === opts.stayingLeaseId) continue
      // RENEWAL HAND-OFF: the household is staying, so there is no "final"
      // bill — the charge rides the renewal's next regular bill. While the old
      // lease is still in force (its last day) it stays put and the lease-end
      // job carries it over at the hand-off; once handed off, a late read goes
      // straight to the renewal. A real move-out read (moveOut) is still final.
      if (r.renewal_id && !opts.moveOut) {
        if (!r.still_active) {
          await query(
            `UPDATE utility_bills SET lease_id = $2, updated_at = NOW()
              WHERE lease_id = $1 AND meter_id = $3 AND billing_cycle_month = $4
                AND payment_id IS NULL AND status IN ('unbilled', 'billed')`,
            [r.lease_id, r.renewal_id, meterId, cycleIso])
        }
        continue
      }
      if (!r.owes) {
        // 10/3 (final sweep, third pass): nothing to put on a final bill, so
        // none is sent — and the $0.00 bills are closed out here, as nothing
        // owed, rather than left 'unbilled'. Left open, nothing ever invoiced or
        // closed them, and the deposit return lists every open utility bill as
        // a final utility deduction: the household that left saw a "$0.00
        // electric" line on its itemization. (Before, the $0.00 bill rode the
        // final invoice and so stayed off the deposit return.)
        await query(
          `UPDATE utility_bills
              SET status = 'void', updated_at = NOW(),
                  notes = CASE WHEN COALESCE(notes, '') = '' THEN $2 ELSE notes || ' — ' || $2 END
            WHERE lease_id = $1 AND status = 'unbilled' AND payment_id IS NULL AND billed_at IS NULL
              AND charge_amount = 0 AND tax_amount = 0`,
          [r.lease_id, NOTHING_OWED_AFTER_MOVE_OUT_NOTE])
        continue
      }
      await generateFinalUtilityInvoice(r.lease_id)
    }
  } catch (err) {
    // Bills stay swept-able via the deposit-return backstop.
    logger.error({ err, meterId, cycleIso }, '[utility-billing] immediate move-out invoicing failed')
  }
}

/**
 * Does the tenant owe this utility?
 *
 * S629 DIRECTIVE (Nic): "the lease can't be the only source of charges in the
 * system... bill it off of the fact that we set our different submeters and
 * utilities per unit. And when there's an active lease on that unit, you bill
 * at the rate from that unit or from that property."
 *
 * The unit's utility configuration governs, because the printed lease goes
 * stale and the physical arrangement does not. Oak Park's apartment lease §10
 * still reads "Landlord shall pay for water and sewer and for trash pickup",
 * written when trash was a shared RUBS dumpster; people from around town began
 * dumping furniture in it, so the park moved to per-can billing and the
 * apartment now pays for water and trash. The meter setup is current, the
 * clause is not.
 *
 * A tagged utility field on a lease still wins where one exists, because that
 * is somebody deliberately saying otherwise about that specific lease. No Oak
 * Park template tags one, so configuration decides there — which is the point.
 * Before this, the absent row was read as "landlord pays" and silently zeroed
 * out utility billing for the entire property.
 */
async function tenantOwesUtility(
  leaseId: string | null, utilityType: string, meterId: string,
  q1: OneFn = queryOne,
): Promise<boolean> {
  if (leaseId) {
    const resp = await q1<{ tenant_responsible: boolean }>(`
      SELECT tenant_responsible FROM lease_utility_responsibilities
       WHERE lease_id = $1 AND utility_type = $2`, [leaseId, utilityType])
    if (resp) return !!resp.tenant_responsible   // the lease spoke
  }
  const m = await q1<{ billing_method: string }>(
    `SELECT billing_method FROM utility_meters WHERE id = $1`, [meterId])
  return !!m && m.billing_method !== 'master_bill_to_landlord'
}

// S636: these let the release run either on the pool or inside a caller's
// open transaction. A pool connection cannot see rows a caller has not
// committed yet, so a release that must happen BEFORE that caller's
// invoice is built has to borrow the caller's client.
type ManyFn = <T>(text: string, params?: any[]) => Promise<T[]>
type OneFn  = <T>(text: string, params?: any[]) => Promise<T | null>

interface InsertBillArgs {
  meterId: string
  unitId: string
  landlordId: string
  utilityType: string
  cycleMonth: string
  usageAmount: number | null
  allocationMethod: string
  allocationBasis: number | null
  ratePerUnit: number
  baseFeeShare: number
  chargeAmount: number
  taxRatePct: number
  /** Pre-computed tax (e.g. water+sewer portions at their own rates).
      Falls back to chargeAmount × taxRatePct when omitted. */
  taxAmount?: number
  /** Snapshot of the water meter's sewer rate folded into the charge. */
  sewerRatePerUnit?: number | null
  /** Begin/end odometer reads for tenant-invoice transparency (submeter only). */
  readingStart?: number | null
  readingEnd?: number | null
  /** S607: the DATES of those reads. Not decoration — A.R.S. § 33-1413.01(A)
   *  and § 33-1314.01(E)(1) both require each utility bill to show the opening
   *  and closing readings *and the dates they were taken*. We snapshotted the
   *  readings and dropped the dates, so no bill we produced was compliant on
   *  its face. A pooled RUBS space has no reads of its own but still carries the
   *  master's closing date, which is what dates its billing period. */
  readingStartDate?: string | Date | null
  readingEndDate?: string | Date | null
  /** 10/3 (final sweep): this is a move-out read (billMoveOutRead). It bills
   *  the household it closes out, even when the read lands after that
   *  household's last day — a late final read folds the gap days into the
   *  departing tenant's bill (S548). Which household (fifth pass): one that
   *  arrived on the space before the read's own day (readingEndDate) and was
   *  still on it AFTER the read before (its last day there is later than
   *  readingStartDate's day). Among those, a household that has left by the
   *  read's day and was not renewed comes first, then the newest. When none
   *  fits, the cycle rule decides. Every other read bills a lease only while it
   *  was in force on the cycle's first day. */
  moveOut?: boolean
  /** 10/3 (sixth pass): with moveOut, the household the caller knows this read
   *  closes out (a resident moving spaces — unitMove). Ranked ahead of the
   *  rule above when it is one of the households that rule considers; never
   *  bills a lease the rule would not. */
  moveOutLeaseId?: string | null
}

/**
 * S650: the property's onboarding window is open right now, as a condition on
 * a properties row aliased `alias`. Same rule as
 * services/onboardingWindow.getOnboardingWindow — started, not completed, and
 * inside 14 days + 1 per 10 units (capped at 30). The one statement of it in
 * this file: holding a share for an invite (holdChargeForPendingUnit),
 * counting an invite as somebody living there (occupiedAcrossReadSpan) and
 * expiring the shares nobody claimed (expireHeldChargesAfterOnboarding) must
 * never disagree about whether the window is open.
 */
async function onboardingWindowOpenSql(alias: string): Promise<string> {
  const { ONBOARDING_WINDOW_BASE_DAYS, ONBOARDING_WINDOW_DAYS_PER_UNITS, ONBOARDING_WINDOW_CAP_DAYS } =
    await import('./onboardingWindow')
  // Whole-number constants, written into the SQL as numbers (never text).
  const base = Math.trunc(Number(ONBOARDING_WINDOW_BASE_DAYS))
  const per = Math.max(1, Math.trunc(Number(ONBOARDING_WINDOW_DAYS_PER_UNITS)))
  const cap = Math.trunc(Number(ONBOARDING_WINDOW_CAP_DAYS))
  return `(${alias}.onboarding_started_at IS NOT NULL AND ${alias}.onboarding_completed_at IS NULL
           AND now() < ${alias}.onboarding_started_at + make_interval(days => LEAST(${cap}::int,
                 ${base}::int + (SELECT COUNT(*)::int FROM units x WHERE x.property_id = ${alias}.id) / ${per}::int)))`
}

/** S650: is the onboarding window open for this unit's property? */
async function onboardingWindowOpenForUnit(unitId: string): Promise<boolean> {
  const row = await queryOne<{ open: boolean }>(`
    SELECT ${await onboardingWindowOpenSql('p')} AS open
      FROM units u JOIN properties p ON p.id = u.property_id
     WHERE u.id = $1`, [unitId])
  return !!row?.open
}

/**
 * S650 (Nic): held utilities expire with the onboarding window.
 *
 * "When it closes, electric that's held that nobody claims, or any other
 * utilities held that nobody claims, we'll just anticipate those to be settled
 * off platform because somebody moved out just before or in the middle of the
 * onboarding window ... we will not bill that to anybody else." Mountain View
 * RV 16 (Harold Cunningham, billed off-platform) and RV 30 were the first two.
 *
 * Closed out, never deleted — the row keeps its amount, dates and the reason.
 * Runs nightly; idempotent.
 */
export async function expireHeldChargesAfterOnboarding(): Promise<{ closed: number; amount: number }> {
  // Closed = the property's onboarding was started (or marked complete) and
  // its window is not open now — the same rule a share is held by.
  const rows = await query<{ id: string; charge_amount: string }>(`
    UPDATE suspended_utility_charges sc
       SET cancelled_at = now(), updated_at = now(),
           cancelled_reason = 'Onboarding window closed with nobody claiming it — presumed settled off-platform (resident left before signing)'
      FROM units u JOIN properties p ON p.id = u.property_id
     WHERE sc.unit_id = u.id
       AND sc.released_at IS NULL AND sc.cancelled_at IS NULL
       AND (p.onboarding_started_at IS NOT NULL OR p.onboarding_completed_at IS NOT NULL)
       AND NOT ${await onboardingWindowOpenSql('p')}
    RETURNING sc.id, sc.charge_amount`)
  const amount = round2(rows.reduce((sum, r) => sum + Number(r.charge_amount || 0), 0))
  if (rows.length) logger.info({ closed: rows.length, amount }, 'utility billing: unclaimed holds expired with the onboarding window')
  return { closed: rows.length, amount }
}

/**
 * S629: hold a utility share for a unit whose residents are invited but have
 * not signed. Returns true when the share was held, false when the unit is
 * genuinely unoccupied and the landlord absorbs it as before.
 *
 * Idempotent through the partial unique index — the billing engine is
 * re-runnable by design, so a second run for the same cycle must not hold the
 * same share twice.
 */
async function holdChargeForPendingUnit(args: InsertBillArgs): Promise<boolean> {
  const pending = await queryOne<{ n: string; landlord_id: string }>(`
    SELECT COUNT(pti.id)::text AS n, u.landlord_id
      FROM units u
      LEFT JOIN pending_tenant_intents pti
        ON pti.unit_id = u.id AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL
     WHERE u.id = $1
     GROUP BY u.landlord_id`, [args.unitId])
  if (!pending || Number(pending.n) === 0) return false
  // S650 (Nic): a share is held only DURING the property's onboarding window.
  // Holding exists so a resident being onboarded is billed their pre-lease
  // usage; once the window has closed there is nobody that could belong to.
  if (!await onboardingWindowOpenForUnit(args.unitId)) return false

  try {
    await query(`
      INSERT INTO suspended_utility_charges
        (meter_id, unit_id, landlord_id, billing_cycle_month, utility_type,
         usage_amount, allocation_method, allocation_basis, rate_per_unit,
         base_fee_share, charge_amount, tax_rate_pct, tax_amount,
         sewer_rate_per_unit, reading_start, reading_end,
         reading_start_date, reading_end_date, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT DO NOTHING`,
      [args.meterId, args.unitId, pending.landlord_id, args.cycleMonth, args.utilityType,
       args.usageAmount ?? null, args.allocationMethod ?? null, args.allocationBasis ?? null,
       args.ratePerUnit ?? null, args.baseFeeShare ?? 0, args.chargeAmount,
       args.taxRatePct ?? null, args.taxAmount ?? null, args.sewerRatePerUnit ?? null,
       args.readingStart ?? null, args.readingEnd ?? null,
       args.readingStartDate ?? null, args.readingEndDate ?? null,
       'Held: invited, lease not signed yet. Bills with their first invoice.'])
    logger.info({ unitId: args.unitId, meterId: args.meterId, cycle: args.cycleMonth,
                  amount: args.chargeAmount },
      'utility billing: share held for a unit whose residents have not signed yet')
    return true
  } catch (e) {
    logger.error({ err: e, unitId: args.unitId }, 'utility billing: could not hold pending share')
    return false
  }
}

/**
 * 10/3 (final sweep) — A METER THAT MOVED WITH NOBODY TO BILL IS REPORTED.
 *
 * tryInsertBill finds the payer for a cycle: the lease that covered the space,
 * else a utility service agreement, else (during the onboarding window) the
 * residents invited to it. With none of those the charge was dropped and only
 * counted as "skipped" — no notice to anyone. Mountain View RV 05, 27, 30 and
 * 16 used about $183 of power in September that way, and Oak Park RV 22 $23.10
 * in August, on spaces GAM thinks are empty. Somebody is usually living there.
 *
 * Only a space's OWN meter that measured real usage is reported: a pooled
 * share or a flat charge on an empty space is the landlord's by design, and an
 * estimate is not a reading. Told once per meter and cycle. A cycle the landlord
 * already closed out with a "Billed outside GAM" read is not reported, nor one
 * a reservation explains: a nightly or weekly stay has no lease by design, so
 * an RV site used by guests would otherwise be reported every month with a
 * next step ("set them up as an existing resident") that is wrong for guests.
 *
 * The deadline is the bill it has to ride. ensureBillsForUnit — which the
 * invoice run calls before it pulls utility bills — reaches back two cycles
 * from the bill's due date, so September's usage goes on a bill due by
 * November 30 and on no bill after that.
 */
async function reportUsageNobodyToBill(args: InsertBillArgs, why: 'nobody' | 'paused'): Promise<void> {
  try {
    const usage = Number(args.usageAmount ?? 0)
    if (args.allocationMethod !== 'submeter' || !(usage > 0) || !(Number(args.chargeAmount) > 0)) return
    const settledOutside = await queryOne<{ n: number }>(`
      SELECT 1 AS n FROM utility_meter_readings
       WHERE meter_id = $1 AND reason = 'billed_off_platform'
         AND reading_date >= COALESCE($2::date, ($3::date + interval '1 month')::date)
         AND reading_date <  COALESCE($2::date, ($3::date + interval '1 month')::date) + 31
       LIMIT 1`, [args.meterId, args.readingEndDate ?? null, args.cycleMonth])
    if (settledOutside) return
    // A reservation on the space during the read span (not cancelled, not a
    // no-show): the guests used it, and a stay has no lease to bill by design.
    const stayed = await queryOne<{ n: number }>(`
      SELECT 1 AS n FROM unit_bookings b
       WHERE b.unit_id = $1
         AND b.status NOT IN ('cancelled', 'no_show') AND b.cancelled_at IS NULL
         AND b.check_in  < COALESCE($3::date, ($2::date + interval '1 month')::date)
         AND b.check_out > COALESCE($4::date, $2::date)
       LIMIT 1`,
      [args.unitId, args.cycleMonth, args.readingEndDate ?? null, args.readingStartDate ?? null])
    if (stayed) return
    const told = await queryOne<{ n: number }>(`
      SELECT 1 AS n FROM notifications
       WHERE landlord_id = $1 AND type = 'utility_usage_unbilled'
         AND data->>'meterId' = $2 AND data->>'cycle' = $3
       LIMIT 1`, [args.landlordId, args.meterId, args.cycleMonth])
    if (told) return
    const w = await queryOne<{ user_id: string; unit_number: string; property_name: string }>(`
      SELECT l.user_id, u.unit_number, p.name AS property_name
        FROM units u
        JOIN properties p ON p.id = u.property_id
        JOIN landlords l ON l.id = $2
       WHERE u.id = $1`, [args.unitId, args.landlordId])
    if (!w) return
    const what = UTILITY_TYPE_LABEL[args.utilityType as UtilityType] ?? args.utilityType
    const unitLabel = UTILITY_UNIT_LABEL[args.utilityType as UtilityType] ?? ''
    const amount = Number(args.chargeAmount) + Number(args.taxAmount ?? 0)
    const used = `${usage.toLocaleString('en-US')}${unitLabel ? ` ${unitLabel}` : ''}`
    const dollars = `$${amount.toFixed(2)}`
    const space = `${w.unit_number} at ${w.property_name}`
    const deadline = lastBillDateForCycle(args.cycleMonth)
    const body = why === 'paused'
      ? `The ${what.toLowerCase()} meter on ${space} moved ${used} (${dollars}) for ${cycleLabel(args.cycleMonth)} `
        + `while the lease there was paused (hibernating), so it was not billed to anyone. `
        + `If someone is staying there, resume the lease on the Leases page in time for a bill due by ${deadline}; this usage goes on that bill. `
        + `If you collected it yourself, record a reading on that meter marked "Billed outside GAM — start fresh here".`
      : `The ${what.toLowerCase()} meter on ${space} moved ${used} (${dollars}) for ${cycleLabel(args.cycleMonth)}, `
        + `but nobody is set up on that space (no lease, reservation, invite or service agreement), so it was not billed to anyone. `
        + `If someone has been living there, set them up as an existing resident of ${w.unit_number} in time for a bill due by ${deadline}; this usage goes on that bill. `
        + `If you collected it yourself, record a reading on that meter marked "Billed outside GAM — start fresh here".`
    await createNotification({
      userId: w.user_id, landlordId: args.landlordId, type: 'utility_usage_unbilled',
      title: `${what} used on ${w.unit_number} — nobody to bill`,
      body,
      data: { meterId: args.meterId, unitId: args.unitId, cycle: args.cycleMonth, usage, amount: Math.round(amount * 100) / 100, why },
      actionUrl: '/utilities',
    })
  } catch (e) {
    logger.error({ err: e, meterId: args.meterId, unitId: args.unitId }, '[utility] could not tell the landlord about usage with nobody to bill')
  }
}

// Returns true if a bill was inserted, false if skipped (unit not occupied,
// tenant not responsible for this utility type, or bill already exists).
export async function tryInsertBill(args: InsertBillArgs): Promise<boolean> {
  // S548 (Nic — fast turnover): the cycle's usage belongs to the lease that
  // covered the START of the cycle month, NOT whoever is active when the
  // read gets entered. RV spots turn over same-day — the departing guest's
  // Jan 1–10 electric must never land on the arrival whose lease went
  // active on the 10th. Works for ended leases too (the final read usually
  // lands after the lease-end processor expired the lease). Read the meter
  // AT turnover — a late final read folds the gap days into the departing
  // tenant's bill.
  // S641: WHO WAS IN THIS SPACE — not who is in it now.
  //
  // This matched on `leases.unit_id`, the lease's CURRENT space. That is right
  // until somebody moves. Nic: "moving sites at an RV park is very common… I
  // want to just be able to move them in the system and say, as of this date,
  // they moved from this spot to this spot, have it coordinate utilities for
  // both."
  //
  // After a move the old space's meter would have found no lease at all — the
  // tenancy had walked away from it — so the first half of the month's usage
  // stranded, and the resident was billed only for where they ended up.
  // `lease_unit_history` answers the question the bill is actually asking.
  //
  // 10/3 (final sweep): never a lease that never took effect, and an ended one
  // only while it was still in force on the 1st. A move-out read is the
  // exception (S548: a late final read folds the gap days into the departing
  // tenant's bill) — but only for a household that was still there when the
  // span it measures began: in force on the day of the read before it.
  // (10/3, third pass) Waiving the check for every lease on the space billed a
  // household gone since August for a later household's move-out read: lease A
  // ended 8/20 (its space history never closed), lease B ran 9/10–9/25, and B's
  // 9/25 read went to A — who was then sent a final utility invoice for it.
  const inForceOn = args.moveOut
    ? (isoDay(args.readingStartDate) ?? args.cycleMonth)
    : args.cycleMonth
  // (10/3, fourth pass) A MOVE-OUT READ BILLS THE HOUSEHOLD IT CLOSES OUT.
  // "Who covered the 1st" is the wrong first question for it. A lease whose
  // last day is the read before's own day — A ended 8/31, the day August was
  // read, the usual month-end pattern — is still in force on that day and, its
  // space history never closing, still "covers" 9/1, so it won the next
  // household's move-out read (B, 9/10 to 9/25) and a final utility invoice
  // went to the household that left in August. The household a move-out read
  // closes out is the newest one on the space BEFORE the read's day that was
  // still there at the read before it. Strictly before: a household arriving
  // the day of the read (same-day turnover) is never billed the departing
  // one's read. Only when none fits does the cycle rule below decide.
  //
  // (10/3, fifth pass) ...and "newest" alone billed the ARRIVAL whenever the
  // read was entered a day or more late — the S548 case itself. A left 9/10,
  // B arrived 9/10, A's meter was read out 9/11: B, the newer of the two, was
  // billed A's 100 kWh and sent a final utility invoice, and A nothing ("in
  // force on the read before's day" is always true of an active lease). Two
  // rules now:
  //   - a household counts only if it was on the space AFTER the read before:
  //     its last day there (end date, termination day, or the day before it
  //     moved spaces) is later than that read's day — on it is not enough;
  //   - among those, one that has LEFT by the move-out read's day (its last day
  //     there on or before it) comes ahead of one still running past it; then
  //     the newest. A household whose lease was renewed (a lease that follows
  //     it took effect on this space by the read's day) has not left — the
  //     renewal is the same household, still there.
  //
  // (10/3, sixth pass) ...and a caller that KNOWS whose read it is says so
  // (moveOutLeaseId), ranked ahead of both. A resident moving to another
  // space is read out before their space history closes, so on the data they
  // are a household still running — and A, gone 9/5 with no read, ranked
  // ahead of D, who moved off the space on 9/20: A was billed D's 100 kWh and
  // sent a final utility invoice. Every filter still applies to the lease
  // named; it is only put first.
  const moveOutDay = args.moveOut ? isoDay(args.readingEndDate) : null
  let lt = moveOutDay
    ? await queryOne<{ lease_id: string; tenant_id: string }>(`
        SELECT h.lease_id, lt2.tenant_id
          FROM lease_unit_history h
          JOIN leases l ON l.id = h.lease_id
          JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.role = 'primary'
          JOIN units u ON u.id = h.unit_id
          JOIN properties p ON p.id = u.property_id
         WHERE h.unit_id = $1
           AND l.status IN ('active', 'expired', 'terminated')
           AND NOT ${LEASE_NEVER_IN_FORCE_SQL}
           AND ${LEASE_LAST_DAY_ON_SPACE_SQL} > $2::date
           AND h.effective_from < $3::date
         ORDER BY COALESCE(h.lease_id = $4::uuid, FALSE) DESC,
                  (${LEASE_LAST_DAY_ON_SPACE_SQL} <= $3::date
                   AND NOT EXISTS (
                     SELECT 1 FROM leases s
                       JOIN lease_unit_history sh ON sh.lease_id = s.id AND sh.unit_id = h.unit_id
                      WHERE s.supersedes_lease_id = l.id
                        AND s.status IN ('active', 'expired', 'terminated')
                        AND NOT ${leaseNeverInForceSql('s')}
                        AND sh.effective_from <= $3::date)) DESC,
                  h.effective_from DESC
         LIMIT 1`, [args.unitId, inForceOn, moveOutDay, args.moveOutLeaseId ?? null])
    : null
  if (!lt) lt = await queryOne<{ lease_id: string; tenant_id: string }>(`
    SELECT h.lease_id, lt2.tenant_id
      FROM lease_unit_history h
      JOIN leases l ON l.id = h.lease_id
      JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.role = 'primary'
     WHERE h.unit_id = $1
       AND l.status IN ('active', 'expired', 'terminated')
       AND NOT ${LEASE_NEVER_IN_FORCE_SQL}
       AND ${leaseInForceOn('$3::date')}
       AND (h.effective_to IS NULL OR h.effective_to > $2::date)
       AND (
         h.effective_from <= $2::date
         -- S642 (Nic): an ONBOARDING lease's start date is the day they signed
         -- onto GAM, not the day they moved in. They were already living there,
         -- so they are the right person to bill for a cycle that precedes it.
         -- Without this the occupancy check above says "somebody lived here"
         -- and this one says "nobody to bill", and the charge is held forever.
         OR COALESCE(l.is_existing_tenancy, FALSE)
       )
     ORDER BY h.effective_from DESC
     LIMIT 1
  `, [args.unitId, args.cycleMonth, inForceOn])
  if (!lt) {
    // Nobody covered the 1st (mid-month first arrival): the cycle falls to
    // the newest lease overlapping the month — same outcome as the old
    // active-lease rule for that case.
    lt = await queryOne<{ lease_id: string; tenant_id: string }>(`
      SELECT h.lease_id, lt2.tenant_id
        FROM lease_unit_history h
        JOIN leases l ON l.id = h.lease_id
        JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.role = 'primary'
       WHERE h.unit_id = $1
         AND l.status IN ('active', 'expired', 'terminated')
         AND NOT ${LEASE_NEVER_IN_FORCE_SQL}
         AND ${leaseInForceOn('$3::date')}
         AND h.effective_from < ($2::date + interval '1 month')::date
         AND (h.effective_to IS NULL OR h.effective_to >= $2::date)
       ORDER BY h.effective_from DESC
       LIMIT 1
    `, [args.unitId, args.cycleMonth, inForceOn])
  }
  // S629 ORDER HAZARD (Nic, launch): the residents signed BEFORE this cycle was
  // billed. Their lease starts next month, so nothing above covers the cycle,
  // and their invite is resolved, so there is no longer an invite to hold
  // against — the share would be silently absorbed by the landlord.
  //
  // They were living there and using it. `occupants` already counted them into
  // the divisor on the strength of the invite, so their neighbors were split
  // correctly against a share that has to land somewhere; this is where it
  // lands. The invite is the evidence of residence, which is why the same
  // "invited before the cycle ended" test used by `occupants` gates it here —
  // it will not reach back and bill a genuinely new arrival for a month they
  // had nothing to do with.
  if (!lt) {
    lt = await queryOne<{ lease_id: string; tenant_id: string }>(`
      SELECT l.id AS lease_id, lt2.tenant_id
        FROM leases l
        JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.role = 'primary'
       WHERE l.unit_id = $1
         AND l.status IN ('active', 'expired', 'terminated')
         AND NOT ${LEASE_NEVER_IN_FORCE_SQL}
         AND l.start_date >= ($2::date + interval '1 month')::date
         AND EXISTS (
           SELECT 1 FROM pending_tenant_intents pti
            WHERE pti.unit_id = l.unit_id
              AND pti.cancelled_at IS NULL
              AND pti.created_at < ($2::date + interval '1 month')::date)
       ORDER BY l.start_date ASC
       LIMIT 1
    `, [args.unitId, args.cycleMonth])
  }

  // S614 (Nic, LAUNCH): a space this landlord SERVICES but does not lease — the
  // apartment and the three trash cans next door. No lease will ever exist for
  // it, so the payer comes from a utility service agreement instead.
  //
  // There is no lease-responsibility gate here, and there cannot be: that gate
  // asks "does the signed lease pass this utility through", and the whole point
  // of a service agreement is that utilities are the ONLY thing owed. Agreeing
  // to the service IS the responsibility.
  let serviceAgreementId: string | null = null
  if (!lt) {
    const sa = await queryOne<{ id: string; tenant_id: string }>(`
      SELECT id, tenant_id FROM utility_service_agreements
       WHERE unit_id = $1 AND status = 'active'
         AND start_date <= ($2::date + interval '1 month' - interval '1 day')
         AND (end_date IS NULL OR end_date >= $2::date)
       LIMIT 1`, [args.unitId, args.cycleMonth])
    if (!sa) {
      // S629: no lease and no service agreement. If the unit has people INVITED
      // to it, this is onboarding rather than a vacancy — they are living there
      // and using the utility, and their share was counted into the split by
      // `occupants`. Hold it; the release runs when their lease is signed.
      //
      // Held rather than billed because there is no invoice to carry it: no due
      // date, no late fee, and no debt recorded against somebody who has not
      // signed anything. Anything genuinely vacant still falls through to the
      // landlord absorbing it, exactly as before.
      // Held, then reported as NOT billed: the caller counts a `true` as a bill
      // created, and a held share is precisely the absence of one. It shows up
      // in unitsSkipped, which is accurate — the unit was skipped for billing
      // and its share is waiting on a signature.
      // 10/3 (final sweep): and when it is NOT held — nobody invited, or the
      // onboarding window closed — the landlord is told rather than the usage
      // quietly vanishing (Mountain View RV 05, 27, 30, 16; Oak Park RV 22).
      if (!await holdChargeForPendingUnit(args)) await reportUsageNobodyToBill(args, 'nobody')
      return false
    }
    serviceAgreementId = sa.id
    lt = { lease_id: null as any, tenant_id: sa.tenant_id }
  } else {
    // S650 (Nic): a HIBERNATING lease is asleep — "nothing bills". Asleep for
    // the whole cycle means no utility bill either; the landlord absorbs any
    // draw, as for an empty space.
    const asleep = await queryOne<{ asleep: boolean }>(`
      SELECT (COALESCE(is_hibernating, FALSE) AND hibernated_at <= $2::date) AS asleep
        FROM leases WHERE id = $1`, [lt.lease_id, args.cycleMonth])
    if (asleep?.asleep) {
      logger.info({ leaseId: lt.lease_id, unitId: args.unitId, cycle: args.cycleMonth },
        'utility billing: lease hibernating for the cycle — not billed')
      // 10/3: a meter that MOVED while the lease slept is somebody using the
      // space — not billed (S650), but never dropped without a word.
      await reportUsageNobodyToBill(args, 'paused')
      return false
    }
    // Tenant responsibility gate — leases only. See the S610 handoff §1a.
    if (!await tenantOwesUtility(lt.lease_id, args.utilityType, args.meterId)) return false
  }

  try {
    await query(`
      INSERT INTO utility_bills
        (meter_id, unit_id, tenant_id, lease_id, landlord_id,
         billing_cycle_month, usage_amount, allocation_method,
         allocation_basis, rate_per_unit, base_fee_share, charge_amount,
         tax_rate_pct, tax_amount, utility_type, sewer_rate_per_unit,
         reading_start, reading_end, reading_start_date, reading_end_date,
         service_agreement_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    `, [
      args.meterId, args.unitId, lt.tenant_id, lt.lease_id, args.landlordId,
      args.cycleMonth, args.usageAmount, args.allocationMethod,
      args.allocationBasis, args.ratePerUnit, args.baseFeeShare, args.chargeAmount,
      args.taxRatePct,
      (args.taxAmount ?? Math.round(args.chargeAmount * args.taxRatePct) / 100).toFixed(2),
      args.utilityType,
      args.sewerRatePerUnit ?? null,
      args.readingStart ?? null,
      args.readingEnd ?? null,
      args.readingStartDate ?? null,
      args.readingEndDate ?? null,
      serviceAgreementId,
    ])
    return true
  } catch (e: any) {
    if (e?.code === '23505') return false  // already generated
    throw e
  }
}

function isoMonthStart(d: Date): string {
  // W-36 fix-it-right (S531): the route builds this Date from
  // 'YYYY-MM-01T00:00:00Z' — reading it with LOCAL getters in any
  // negative-UTC-offset timezone rolls back to the last day of the PRIOR
  // month, so every generate call silently billed the wrong cycle
  // ("generate July" billed June). UTC getters match the UTC construction.
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

/** 'YYYY-MM-DD' — the last day of the cycle that starts on `cycleIso` ('YYYY-MM-01'). */
function lastDayOfCycle(cycleIso: string): string {
  const [y, m] = cycleIso.slice(0, 10).split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0))
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`
}

/**
 * 'YYYY-MM-DD' for a reading date as it arrives: a string, or the Date node-pg
 * makes of a `date` column (local midnight — read with LOCAL getters, as
 * cycleLabel does). null when there is none.
 */
function isoDay(d: string | Date | null | undefined): string | null {
  if (d == null) return null
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const s = String(d).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Helper: generate bills for every METERED meter on a property for a given
// cycle. Used by the landlord-triggered POST /utility/generate-bills route.
//
// ── S637: A FLAT RATE IS BILLED AHEAD, AND ONLY ONCE ──────────────────────
//
// Nic (DIRECTIVE, verbatim): "Trash is billed ahead because it's a flat rate.
// It doesn't matter how much shit they put in the can. It's there available for
// them to use. It's not a metered thing... It's like paying rent for the unit.
// They're paying for the month that they're about to be there. On trash,
// they're paying for the can they are about to use."
//
// That is the whole model, and the flat path in ensureBillsForUnit already
// implements it: cycle = the INVOICE's own month, billed with the invoice, in
// advance. Correct, and untouched.
//
// This sweep is the OTHER cadence, and it had no business touching a flat rate.
// It bills whatever cycle the caller names — which for the reading-run path is
// a month in the PAST, because a metered cycle cannot be billed until somebody
// reads the meter. It selected EVERY meter on the property with no
// billing_method filter, so completing August's water/electric reads on Sep 1
// also minted an August TRASH cycle. The invoice run produced September's the
// next day, and one tenant's first invoice carried two cans.
//
// Measured: 16 held August trash cycles and 17 September ones, generated
// 2026-09-01 and 2026-09-02 — one day apart, one month apart on paper. Three
// tenants (Covey, Fuller, Rhoades) were billed $50 of trash on a single
// invoice; the rest were queued to be as they signed.
//
// A flat rate has no reading, so it has no arrears cycle to catch up on. There
// is exactly one place it may be billed, and this is not it.
export async function generateBillsForProperty(
  propertyId: string,
  cycleMonth: Date,
): Promise<GenerateBillsResult[]> {
  const meters = await query<{ id: string }>(
    `SELECT id FROM utility_meters
      WHERE property_id = $1
        AND billing_method <> 'flat_rate'`, [propertyId])
  const results: GenerateBillsResult[] = []
  for (const m of meters) {
    results.push(await generateBillsForMeter(m.id, cycleMonth))
  }
  return results
}

// S534 (Nic): billing is per-UNIT, not batched to run completion. As
// soon as a unit's meters have their cycle readings, the unit is clear
// to bill on its lease's invoice date — the invoice cron calls this
// right before pulling utility bills, so one unread meter elsewhere on
// the property (or an unfinished verification walk) never holds a
// unit's charges. Generates any missing bills for every (meter, cycle)
// pair serving the unit with a recorded reading on/before the invoice
// cycle, looking back two cycles for late readings. Idempotent — the
// UNIQUE bill constraint and generateBillsForMeter's own gates
// (needs_review, first-cycle baseline, tenant responsibility) all
// still apply; a flagged reading's bill simply rides the next invoice
// once verification/resolution clears it.
export async function ensureBillsForUnit(
  unitId: string,
  throughDate: string,  // ISO date; cycles ≤ its month are considered
): Promise<number> {
  const pending = await query<{ meter_id: string; cycle: string }>(`
    SELECT DISTINCT rd.meter_id, to_char(rd.billing_cycle_month, 'YYYY-MM-DD') AS cycle
      FROM utility_meter_units mu
      JOIN utility_meters m ON m.id = mu.meter_id
                           AND m.billing_method IN ('submeter','rubs')
      JOIN utility_meter_readings rd ON rd.meter_id = mu.meter_id
     WHERE mu.unit_id = $1
       AND rd.billing_cycle_month <= date_trunc('month', $2::date)::date
       AND rd.billing_cycle_month >= (date_trunc('month', $2::date) - interval '2 months')::date
       AND NOT rd.needs_review
       AND NOT EXISTS (
         SELECT 1 FROM utility_bills ub
          WHERE ub.meter_id = rd.meter_id
            AND ub.unit_id = mu.unit_id
            AND ub.billing_cycle_month = rd.billing_cycle_month)
  `, [unitId, throughDate])

  // S607 (Nic): FLAT-RATE meters bill here too, and did not before.
  //
  // Nic: "did we ever add trash as an item? We just do that at a flat rate per
  // household because they have individual cans."
  //
  // Trash exists as a utility type and flat_rate is exactly that fixed
  // per-household charge — but this function, which is the PRIMARY billing path
  // since S534, selected only submeter/rubs meters AND required a
  // utility_meter_readings row. A flat-rate meter has neither: no reading, by
  // design. So trash only billed when a reading RUN completed
  // (generateBillsForProperty sweeps every meter), which produced two failures:
  //
  //   1. A property with ONLY a flat-rate meter never opens a reading run at all
  //      (openReadingRun requires a readable meter), so its trash NEVER billed.
  //   2. At a property like Oak Park, one unread water meter left the run open
  //      and took the trash charge down with it — even though trash needs no
  //      reading whatsoever. That is precisely the coupling S534 exists to
  //      prevent: "one unread meter elsewhere never holds a unit's charges."
  //
  // Cycle is the invoice's own month; there is no reading to date it from.
  const flat = await query<{ meter_id: string; cycle: string }>(`
    SELECT m.id AS meter_id, to_char(date_trunc('month', $2::date), 'YYYY-MM-DD') AS cycle
      FROM utility_meter_units mu
      JOIN utility_meters m ON m.id = mu.meter_id AND m.billing_method = 'flat_rate'
     WHERE mu.unit_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM utility_bills ub
          WHERE ub.meter_id = m.id
            AND ub.unit_id = mu.unit_id
            AND ub.billing_cycle_month = date_trunc('month', $2::date)::date)
  `, [unitId, throughDate])

  let created = 0
  for (const p of [...pending, ...flat]) {
    const r = await generateBillsForMeter(p.meter_id, new Date(p.cycle + 'T00:00:00Z'))
    created += r.billsCreated
  }
  return created
}

// Helper: every METERED meter for every property under a landlord. Used by an
// eventual monthly cron once payment integration lands.
//
// S637: same flat-rate exclusion as generateBillsForProperty above, and for the
// same reason — a flat rate bills ahead with the invoice, never on a
// catch-up cycle. Left unfiltered this would have reintroduced the duplicate
// the moment the cron landed.
export async function generateBillsForLandlord(
  landlordId: string,
  cycleMonth: Date,
): Promise<GenerateBillsResult[]> {
  const meters = await query<{ id: string }>(`
    SELECT m.id FROM utility_meters m
      JOIN properties p ON p.id = m.property_id
     WHERE p.landlord_id = $1
       AND m.billing_method <> 'flat_rate'
  `, [landlordId])
  const results: GenerateBillsResult[] = []
  for (const m of meters) {
    results.push(await generateBillsForMeter(m.id, cycleMonth))
  }
  return results
}


/** YYYY-MM for a cycle, whether it arrives as a Date or a string. */
/**
 * The billing cycle, as a landlord reads it.
 *
 * S637 (Nic, on his Payments page): "you have Jonathan Covey for rent,
 * Jonathan Covey for trash... Jonathan Covey for another trash can. They're
 * only supposed to have one trash can."
 *
 * They have one can. The two rows were Aug and Sep — but this returned the raw
 * ISO prefix ("2026-09") while the move-in bundle, writing the SAME sentence
 * for the SAME kind of charge, used `to_char(..., 'Mon YYYY')` ("Aug 2026").
 * One tenant's charges therefore carried both formats, which reads as two
 * unrelated systems billing the same thing rather than two months of one.
 *
 * "Sep 2026" here, matching jobs/moveInBundle.ts:465. Display only — nothing
 * keys, sorts, or compares on this string.
 */
const CYCLE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function cycleLabel(cycle: unknown): string {
  // billing_cycle_month is a DATE; node-pg hands it back as a local-midnight
  // Date, so read the LOCAL parts. toISOString() would shift a 1st-of-month
  // west of UTC back into the previous month and mislabel every cycle.
  if (cycle instanceof Date) return `${CYCLE_MONTHS[cycle.getMonth()]} ${cycle.getFullYear()}`
  const iso = String(cycle).slice(0, 7)          // 'YYYY-MM'
  const m = /^(\d{4})-(\d{2})$/.exec(iso)
  if (!m) return iso                              // unparseable — say what we have
  return `${CYCLE_MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`
}

/**
 * 10/3 (final sweep): the last due date a bill can have and still carry this
 * cycle's usage — the end of the second month after it ("Nov 30, 2026" for
 * September). ensureBillsForUnit, which the invoice run calls before pulling
 * utility bills, reaches back two cycles from the bill's due date.
 */
function lastBillDateForCycle(cycle: unknown): string {
  const iso = cycle instanceof Date
    ? `${cycle.getFullYear()}-${String(cycle.getMonth() + 1).padStart(2, '0')}`
    : String(cycle).slice(0, 7)
  const m = /^(\d{4})-(\d{2})$/.exec(iso)
  if (!m) return 'the end of the second month after it'
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + 3, 0))
  return `${CYCLE_MONTHS[last.getUTCMonth()]} ${last.getUTCDate()}, ${last.getUTCFullYear()}`
}

/**
 * S629: release every held utility share for a unit onto the tenant who has
 * just signed.
 *
 * The counterpart to holdChargeForPendingUnit. Their share was counted into the
 * RUBS split at the time — so the other residents were charged correctly — and
 * parked with no invoice behind it. Signing is what gives it somewhere to go.
 *
 * Called after a lease is created from a signed document. Best-effort and
 * idempotent: a held row becomes exactly one bill, and a row that fails stays
 * held rather than vanishing, so nothing is silently written off.
 */
export async function releaseSuspendedChargesForLease(args: {
  unitId: string; leaseId: string; tenantId: string; landlordId: string
  /**
   * S636 (Nic), on RV 28 the day the Coveys signed: "the suspended
   * utilities are not showing on their invoice."
   *
   * S634 had already taught the move-in invoice to pick these up — but
   * this release ran POST-COMMIT, after that invoice was built, so it
   * queried for utility_bills on a lease that had none yet. Both
   * happened in the same second and the invoice still read $0 utilities.
   * Passing the signing transaction's client lets the release land
   * first, inside the same transaction, so the invoice sees the rows.
   */
  client?: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }
}): Promise<{ released: number; amount: number }> {
  const c = args.client
  const q: ManyFn = c ? (async (t, p) => (await c.query(t, p)).rows) as ManyFn : query
  const q1: OneFn = c ? (async (t, p) => (await c.query(t, p)).rows[0] ?? null) as OneFn : queryOne
  // ── S638 (Nic, DIRECTIVE): ONBOARDING BILLS THE CYCLE AS EACH LEASE LANDS ──
  //
  //   "The onboarding phase needs to run the utilities as each lease is
  //    generated and the initial charge is generated. After that, it's just a
  //    monthly cycle."
  //
  // Releasing HELD charges only helps a unit that had a hold. A unit with
  // nobody invited to it at billing time gets no hold at all — the run passes
  // over it — so a resident invited afterwards is invisible to that cycle
  // forever. Blanca Avalos was invited to RV 36 three hours after the Sept 2
  // run and had no electric on her bill at all; so did Jeremy Parker at RV 49
  // and Julie Kenyon at RV 04.
  //
  // Now the lease itself triggers the billing for its own unit: any cycle that
  // has reads but produced no bill for this unit is generated here, with the
  // lease in place so the charge attributes to the person who just signed.
  // Idempotent — a cycle already billed is left alone by tryInsertBill.
  try {
    // Create the hold this unit never got, then fall straight through to the
    // release below — so there is ONE mechanism that attaches a pre-lease
    // utility charge to a new tenancy, not two that can drift.
    //
    // Deliberately does not go through generateBillsForMeter: that refuses a
    // cycle no lease covers, which is exactly this case — the reads span a
    // period before the resident signed. A released hold has always carried
    // that convention ("used before the lease was signed").
    await q(`
      INSERT INTO suspended_utility_charges
        (meter_id, unit_id, landlord_id, billing_cycle_month, utility_type,
         usage_amount, charge_amount)
      SELECT m.id, mu.unit_id, $2, r.billing_cycle_month, m.utility_type,
             (cyc.reading_value - base.reading_value) * m.reading_multiplier,
             ROUND((cyc.reading_value - base.reading_value) * m.reading_multiplier
                   * COALESCE(m.rate_per_unit, pur.rate_per_unit, 0), 2)
        FROM utility_meters m
        JOIN utility_meter_units mu ON mu.meter_id = m.id AND mu.unit_id = $1
        JOIN LATERAL (
          SELECT DISTINCT billing_cycle_month FROM utility_meter_readings
           WHERE meter_id = m.id) r ON TRUE
        LEFT JOIN property_utility_rates pur
               ON pur.property_id = m.property_id AND pur.utility_type = m.utility_type
        JOIN LATERAL (
          SELECT reading_value FROM utility_meter_readings
           WHERE meter_id = m.id AND billing_cycle_month = r.billing_cycle_month
             AND reason = 'monthly_cycle'
           ORDER BY reading_date DESC LIMIT 1) cyc ON TRUE
        JOIN LATERAL (
          SELECT reading_value FROM utility_meter_readings
           WHERE meter_id = m.id AND billing_cycle_month = r.billing_cycle_month
             AND reason <> 'monthly_cycle'
           ORDER BY reading_date ASC LIMIT 1) base ON TRUE
       WHERE m.billing_method = 'submeter'
         AND (cyc.reading_value - base.reading_value) > 0
         AND NOT EXISTS (SELECT 1 FROM utility_bills b
                          WHERE b.meter_id = m.id
                            AND b.billing_cycle_month = r.billing_cycle_month)
         AND NOT EXISTS (SELECT 1 FROM suspended_utility_charges sc
                          WHERE sc.meter_id = m.id
                            AND sc.billing_cycle_month = r.billing_cycle_month)`,
      [args.unitId, args.landlordId])
  } catch (e) {
    // Never block a signing on this — the lease and its rent matter more, and
    // the monthly run is still there behind it.
    logger.error({ err: e, unitId: args.unitId },
      '[utility] could not raise the open cycle at lease signing')
  }

  // ── S647 (Nic): "Why do we keep having this problem where the stuck meters
  // are not getting billed? This is like the sixth time." ───────────────────
  //
  // Because there are TWO roads to a first utility bill and every earlier fix
  // went down one of them. The monthly run goes through generateBillsForMeter,
  // which has known since S637 that an occupied space whose meter did not move
  // is a broken meter, not a free month. A lease being SIGNED goes through here
  // instead — and the insert above requires `(cyc - base) > 0`, so a stuck
  // meter simply produced nothing. During onboarding nearly every lease takes
  // this road: Chris Ast (RV 07), Jared Coil (RV 23), Calvin Curtis (RV 40),
  // MH 04, RV 41, and Martin Alvarado (RV 34) all fell through it.
  //
  // So the same rule applies here, with the same estimate the monthly run uses.
  // Only for an EXISTING tenancy: those residents lived there during the cycle.
  // A new move-in's pre-lease cycle was a vacant space, and a vacant space
  // reading zero is correct.
  //
  // Contained in a savepoint when this runs inside the signing transaction —
  // a failed statement there would otherwise abort the signature itself.
  const sp = !!c
  try {
    if (sp) await q(`SAVEPOINT stuck_meter_estimate`)
    const existing = await q1<{ existing: boolean }>(
      `SELECT COALESCE(is_existing_tenancy, FALSE) AS existing FROM leases WHERE id = $1`,
      [args.leaseId])
    if (existing?.existing) {
      const stuck = await q<any>(`
        SELECT m.id AS meter_id, m.property_id, m.utility_type,
               COALESCE(m.rate_per_unit, pur.rate_per_unit, 0) AS rate,
               to_char(r.billing_cycle_month, 'YYYY-MM-DD') AS cycle,
               cyc.reading_value AS end_val, cyc.reading_date AS end_date,
               base.reading_value AS start_val, base.reading_date AS start_date,
               un.unit_type, un.rv_amp_service, pp.estimates_stuck_meters AS estimates
          FROM utility_meters m
          JOIN utility_meter_units mu ON mu.meter_id = m.id AND mu.unit_id = $1
          JOIN units un ON un.id = mu.unit_id
          JOIN LATERAL (
            SELECT DISTINCT billing_cycle_month FROM utility_meter_readings
             WHERE meter_id = m.id) r ON TRUE
          LEFT JOIN property_utility_rates pur
                 ON pur.property_id = m.property_id AND pur.utility_type = m.utility_type
          JOIN LATERAL (
            SELECT reading_value, reading_date FROM utility_meter_readings
             WHERE meter_id = m.id AND billing_cycle_month = r.billing_cycle_month
               AND reason = 'monthly_cycle'
             ORDER BY reading_date DESC LIMIT 1) cyc ON TRUE
          JOIN LATERAL (
            SELECT reading_value, reading_date FROM utility_meter_readings
             WHERE meter_id = m.id AND billing_cycle_month = r.billing_cycle_month
               AND reason <> 'monthly_cycle'
             ORDER BY reading_date ASC LIMIT 1) base ON TRUE
          JOIN properties pp ON pp.id = m.property_id
         WHERE m.billing_method = 'submeter'
           AND m.out_of_service = FALSE
           AND cyc.reading_value = base.reading_value
           -- 10/3 (third pass): over at least a day. An opening read and the
           -- cycle read on the same day measure no time, so the same number
           -- twice says nothing about the meter (Oak Park RV 24, 9/30).
           AND cyc.reading_date > base.reading_date
           AND NOT EXISTS (SELECT 1 FROM utility_bills b
                            WHERE b.meter_id = m.id AND b.billing_cycle_month = r.billing_cycle_month)
           -- 10/3 (third pass): a $0.00 share held off this same flat read is
           -- not a record of anything — the run held it because nobody was
           -- known to live there yet (invited after the read). It must not stop
           -- the check it never made; it is closed out below.
           AND NOT EXISTS (SELECT 1 FROM suspended_utility_charges sc
                            WHERE sc.meter_id = m.id AND sc.billing_cycle_month = r.billing_cycle_month
                              AND sc.cancelled_at IS NULL
                              AND NOT (sc.released_at IS NULL AND sc.charge_amount = 0
                                       AND COALESCE(sc.usage_amount, 0) = 0))`,
        [args.unitId])
      for (const st of stuck) {
        await q(`
          UPDATE suspended_utility_charges
             SET cancelled_at = now(), updated_at = now(),
                 cancelled_reason = 'Meter did not move while the resident lived there — marked broken at signing; this $0.00 share was not a reading of anything'
           WHERE meter_id = $1 AND unit_id = $2 AND billing_cycle_month = $3::date
             AND released_at IS NULL AND cancelled_at IS NULL
             AND charge_amount = 0 AND COALESCE(usage_amount, 0) = 0`,
          [st.meter_id, args.unitId, st.cycle])
        // S648: only a property whose landlord chose estimates estimates;
        // otherwise the meter is flagged broken and bills nothing.
        const exec = (sql: string, p: any[]) => q<any>(sql, p)
        if (!st.estimates) { await flagBrokenMeter(st.meter_id, { exec }); continue }
        const est = await lowestComparableUsage({
          brokenMeterId: st.meter_id, propertyId: st.property_id,
          utilityType: st.utility_type, unitType: st.unit_type,
          rvAmpService: st.rv_amp_service, cycleIso: st.cycle,
        })
        // 10/3 (final sweep): estimated here too means broken — marked for
        // repair and the landlord told, as on the monthly run.
        await flagBrokenMeter(st.meter_id, { exec, estimate: {
          usage: est, unitLabel: UTILITY_UNIT_LABEL[st.utility_type as UtilityType] ?? '' } })
        if (est == null) continue   // nothing real to estimate from — never invent one
        await q(`
          INSERT INTO suspended_utility_charges
            (meter_id, unit_id, landlord_id, billing_cycle_month, utility_type,
             usage_amount, allocation_method, rate_per_unit, charge_amount,
             reading_start, reading_end, reading_start_date, reading_end_date, notes)
          VALUES ($1,$2,$3,$4::date,$5,$6,'comparable_low',$7,$8,$9,$10,$11,$12,
                  'Meter did not move this cycle; billed at the low end of what occupied neighbors used.')
          ON CONFLICT DO NOTHING`,
          [st.meter_id, args.unitId, args.landlordId, st.cycle, st.utility_type,
           est, st.rate, round2(est * Number(st.rate)),
           st.start_val, st.end_val, st.start_date, st.end_date])
      }
    }
    if (sp) await q(`RELEASE SAVEPOINT stuck_meter_estimate`)
  } catch (e) {
    if (sp) await q(`ROLLBACK TO SAVEPOINT stuck_meter_estimate`).catch(() => {})
    logger.error({ err: e, unitId: args.unitId },
      '[utility] could not estimate a stuck meter at lease signing — the monthly run still will')
  }

  const held = await q<any>(`
    SELECT * FROM suspended_utility_charges
     WHERE unit_id = $1 AND released_at IS NULL AND cancelled_at IS NULL
     ORDER BY billing_cycle_month`, [args.unitId])
  // S649 (Nic): "We're not charging somebody that wasn't here for stuff they
  // didn't use." A share is held because nobody on the site had a lease yet.
  // For a resident being ONBOARDED, that usage is theirs — they lived there
  // before they signed — so it releases onto their lease. For a NEW tenant it
  // is somebody else's: once their lease exists their own usage bills to them
  // directly, so anything held from before belongs to whoever was there. It is
  // closed out (kept, with the reason — never on the newcomer's bill, never
  // waiting for a later one) and the landlord is told the amount and dates, so
  // they can bill the person who actually used it.
  const leaseRow = await q1<{ is_existing_tenancy: boolean; start_date: string }>(
    `SELECT is_existing_tenancy, to_char(start_date, 'YYYY-MM-DD') AS start_date FROM leases WHERE id = $1`, [args.leaseId])
  if (held.length && leaseRow && !leaseRow.is_existing_tenancy) {
    const total = round2(held.reduce((sum: number, h: any) => sum + Number(h.charge_amount || 0), 0))
    await q(`
      UPDATE suspended_utility_charges
         SET cancelled_at = now(), updated_at = now(),
             cancelled_reason = 'Used before the new tenant moved in — bill the prior occupant directly'
       WHERE id = ANY($1::uuid[])`, [held.map((h: any) => h.id)])
    const periods = held.map((h: any) =>
      `${h.utility_type} ${h.reading_start_date ? String(h.reading_start_date).slice(0, 10) : cycleLabel(h.billing_cycle_month)}` +
      `${h.reading_end_date ? ' to ' + String(h.reading_end_date).slice(0, 10) : ''} $${Number(h.charge_amount).toFixed(2)}`).join('; ')
    try {
      const owner = await q1<{ user_id: string; unit_number: string }>(
        `SELECT l.user_id, u.unit_number FROM landlords l JOIN units u ON u.id = $2 WHERE l.id = $1`,
        [args.landlordId, args.unitId])
      if (owner) {
        const { createNotification } = await import('./notifications')
        await createNotification({
          userId: owner.user_id, landlordId: args.landlordId, type: 'held_utility_prior_occupant',
          title: `Unit ${owner.unit_number}: $${total.toFixed(2)} of utilities from before the new tenant moved in`,
          body: `${periods}. That usage happened while nobody had a lease on the unit, so it is NOT on the new ` +
            `tenant's bill and won't be put on anyone's automatically. Bill the person who was there — a pay link ` +
            `from the register works.`,
          data: { unitId: args.unitId, leaseId: args.leaseId, heldIds: held.map((h: any) => h.id) },
        })
      }
    } catch (e) {
      logger.error({ err: e, unitId: args.unitId }, '[utility] could not tell the landlord about prior-occupant usage')
    }
    logger.info({ unitId: args.unitId, leaseId: args.leaseId, count: held.length, total },
      'utility billing: held shares closed out — a new tenant is not billed for usage before they moved in')
    return { released: 0, amount: 0 }
  }
  let released = 0
  let amount = 0
  for (const h of held) {
    try {
      // Lease is law. The share was held before there was a lease to consult,
      // so this is the first moment the terms can be applied — and if the
      // signed lease does not pass this utility through, the tenant never owed
      // it. Cancel the hold (kept, with a reason) instead of billing it.
      if (!await tenantOwesUtility(args.leaseId, h.utility_type, h.meter_id, q1)) {
        await q(`
          UPDATE suspended_utility_charges
             SET cancelled_at = now(), updated_at = now(),
                 notes = COALESCE(notes,'') ||
                   ' — not billed: neither the lease nor the meter makes the tenant responsible for '
                   || $2
           WHERE id = $1`, [h.id, h.utility_type])
        logger.info({ suspendedId: h.id, unitId: args.unitId, utility: h.utility_type },
          'utility billing: held share dropped — this utility is not passed through to the tenant')
        continue
      }
      const bill = await q1<{ id: string }>(`
        INSERT INTO utility_bills
          (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
           usage_amount, allocation_method, allocation_basis, rate_per_unit,
           base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type,
           sewer_rate_per_unit, reading_start, reading_end,
           reading_start_date, reading_end_date, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [h.meter_id, h.unit_id, args.tenantId, args.leaseId, args.landlordId,
         h.billing_cycle_month, h.usage_amount, h.allocation_method, h.allocation_basis,
         h.rate_per_unit, h.base_fee_share, h.charge_amount,
         // utility_bills requires both tax columns; a held row may carry
         // neither (an untaxed utility), and 0 is the honest value for "no tax
         // was charged" — NULL would fail the constraint and strand the share.
         h.tax_rate_pct ?? 0, h.tax_amount ?? 0,
         h.utility_type, h.sewer_rate_per_unit, h.reading_start, h.reading_end,
         h.reading_start_date, h.reading_end_date,
         `Utility used before the lease was signed (${cycleLabel(h.billing_cycle_month)}).`])
      // A conflict means the cycle already has a bill for this unit — the share
      // is accounted for, so stop holding it rather than leaving it to re-run.
      await q(
        `UPDATE suspended_utility_charges
            SET released_at = now(), released_bill_id = $2, updated_at = now()
          WHERE id = $1`, [h.id, bill?.id ?? null])
      // ── S636: ATTACH TO AN INVOICE THAT ALREADY EXISTS ────────────────
      //
      // Nic: "Can you just order the utilities to be released two minutes
      // after signature... we're just waiting for millisecond ordering to
      // guess about getting it right."
      //
      // He is right that this should not depend on ordering — though a
      // DELAY would have made it permanent, since the invoice is built
      // FROM these rows. The fix is to stop caring which came first.
      //
      // A bill released before its invoice is picked up by
      // generateMoveInInvoice (S634). A bill released AFTER one already
      // exists had nowhere to go and sat 'unbilled' until the next
      // month's run — which is what stranded the Coveys, and what would
      // strand anyone whose meter read is corrected, or whose bill-back
      // is switched on, after their invoice was cut. This lands it on
      // the open invoice instead, so the tenant sees it when they log in.
      if (bill?.id) await attachBillToOpenInvoice(bill.id, h, args, q, q1)
      if (bill?.id) { released++; amount += Number(h.charge_amount) }
    } catch (e) {
      logger.error({ err: e, suspendedId: h.id, unitId: args.unitId },
        'utility billing: could not release a held share — left held')
    }
  }
  if (released > 0) {
    logger.info({ unitId: args.unitId, leaseId: args.leaseId, released, amount },
      'utility billing: held shares released onto the new lease')
  }
  return { released, amount }
}


/**
 * Put a just-released utility bill onto the tenant's open invoice, if one is
 * already sitting there for that cycle or later (S636).
 *
 * Mirrors the move-in bundle's utility rows exactly — a payments row of
 * type 'utility' linked to the invoice, the bill stamped 'billed' so no
 * later run double-bills it, and the invoice's own subtotals moved. Work
 * trade is honored the same way: a covered utility rides as a suspended
 * $0-owed line rather than money due, so hours worked cover it.
 *
 * Silent no-op when there is no open invoice — the bill stays 'unbilled'
 * and the next run picks it up, which is the pre-existing behavior.
 */
async function attachBillToOpenInvoice(
  billId: string,
  held: any,
  args: { unitId: string; leaseId: string; tenantId: string; landlordId: string },
  q: ManyFn,
  q1: OneFn,
): Promise<void> {
  const amount = Number(held.charge_amount)
  if (!(amount > 0)) return
  try {
    // The earliest still-open invoice on this lease whose period already
    // covers this cycle. 'settled' and 'void' are left alone — a paid
    // invoice must never grow a new line after the fact.
    const inv = await q1<{ id: string; due_date: string }>(
      `SELECT id, due_date FROM invoices
        WHERE lease_id = $1
          AND status IN ('pending','partial')
          AND date_trunc('month', due_date)::date >= date_trunc('month', $2::date)::date
        ORDER BY due_date ASC LIMIT 1`,
      [args.leaseId, held.billing_cycle_month])
    if (!inv) return

    const wt = await q1<{ covered_charges: string[] | null }>(
      `SELECT covered_charges FROM work_trade_agreements
        WHERE unit_id = $1 AND tenant_id = $2 AND status = 'active'
          AND start_date <= $3::date AND (end_date IS NULL OR end_date >= $3::date)
        LIMIT 1`,
      [args.unitId, args.tenantId, inv.due_date])
    // An empty/absent list means everything is covered — same reading the
    // move-in bundle and the monthly run both use.
    const covered = !!wt && (!wt.covered_charges || wt.covered_charges.length === 0
      || wt.covered_charges.includes(String(held.utility_type)))

    const kind = String(held.utility_type)
    // S654 (Nic): an onboarding resident already lived there — "nobody moves in
    // during onboarding" — so the before-signing note is for new tenancies only.
    const existing = await q1<{ is_existing_tenancy: boolean }>(
      `SELECT COALESCE(is_existing_tenancy, false) AS is_existing_tenancy FROM leases WHERE id = $1`,
      [args.leaseId])
    const label = `${kind[0].toUpperCase()}${kind.slice(1)} — ${cycleLabel(held.billing_cycle_month)}`
      + (existing?.is_existing_tenancy ? '' : ' (used before the lease was signed)')
    const pay = await q1<{ id: string }>(
      `INSERT INTO payments (
         invoice_id, unit_id, lease_id, tenant_id, landlord_id,
         type, amount, status, due_date, entry_description, notes,
         work_trade_suspended_at
       ) VALUES ($1,$2,$3,$4,$5,'utility',$6,'pending',$7,'UTILITY',$8,$9)
       RETURNING id`,
      [inv.id, args.unitId, args.leaseId, args.tenantId, args.landlordId,
       amount.toFixed(2), inv.due_date,
       covered ? `${label} — work trade, suspended until month close` : label,
       covered ? new Date().toISOString() : null])
    if (!pay) return

    await q(`UPDATE utility_bills
                SET payment_id = $1, status = 'billed', billed_at = NOW(), updated_at = NOW()
              WHERE id = $2`, [pay.id, billId])

    // A suspended line was never money owed, so it moves the utilities
    // subtotal but not the total — the same split the move-in bundle uses.
    await q(`UPDATE invoices
                SET subtotal_utilities = subtotal_utilities + $2,
                    total_amount = total_amount + $3,
                    updated_at = NOW()
              WHERE id = $1`,
      [inv.id, amount.toFixed(2), covered ? '0.00' : amount.toFixed(2)])

    logger.info({ billId, invoiceId: inv.id, amount, covered },
      'utility billing: released share attached to the open invoice')
  } catch (e) {
    // The bill exists and is correct; it just did not get onto this
    // invoice. Leaving it 'unbilled' means the next run bills it — never
    // silently dropped.
    logger.error({ err: e, billId },
      'utility billing: could not attach a released share to the open invoice — left unbilled')
  }
}


/**
 * Attach an already-created utility bill that never made it onto an invoice
 * (S636).
 *
 * The release path calls attachBillToOpenInvoice inline. This is the same
 * operation for a bill that was created some OTHER way and stranded —
 * chiefly the monthly run producing a cycle's bill after that period's
 * invoice was already cut, which leaves real money sitting 'unbilled'
 * until the following month's straggler sweep picks it up.
 *
 * Idempotent: a bill already linked to a payment is left alone, and a
 * settled invoice is never grown.
 */
export async function attachStrandedUtilityBill(billId: string): Promise<boolean> {
  const bill = await queryOne<any>(
    `SELECT ub.*, l.unit_id AS lease_unit_id
       FROM utility_bills ub
       LEFT JOIN leases l ON l.id = ub.lease_id
      WHERE ub.id = $1`, [billId])
  if (!bill) return false
  if (bill.payment_id) return false          // already on an invoice
  if (!bill.lease_id || !bill.tenant_id) return false
  const before = await queryOne<{ payment_id: string | null }>(
    `SELECT payment_id FROM utility_bills WHERE id = $1`, [billId])
  await attachBillToOpenInvoice(billId, bill, {
    unitId: bill.unit_id, leaseId: bill.lease_id,
    tenantId: bill.tenant_id, landlordId: bill.landlord_id,
  }, query, queryOne)
  const after = await queryOne<{ payment_id: string | null }>(
    `SELECT payment_id FROM utility_bills WHERE id = $1`, [billId])
  return !before?.payment_id && !!after?.payment_id
}
