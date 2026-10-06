/**
 * S120: Per-occupied-unit platform fee accrual cron.
 *
 * Last session of the Stripe Connect rebuild. Closes the SaaS-side
 * billing path: every active landlord gets billed monthly for using GAM,
 * computed per the locked S113 RV/STR aggregation rule.
 *
 * Pricing model (locked, see project_gam_pricing_model memory):
 *   - $2/billable-unit/month (default; superadmin can override per landlord)
 *   - $10/property/month minimum (if rate × billable < min, bill min)
 *   - Vacant units never charged
 *   - "Billable units" = long_term_unit_count + CEIL(short_stay_nights/30)
 *   - S538 STR carve-out (Nic-locked): the /30 aggregation is ONLY for
 *     NIGHTS_AGGREGATION_UNIT_TYPES (rv_spot — space-only, landlord
 *     coordinates nothing). Short-stay bookings on ANY other unit type
 *     bill str_fee_pct (default 3% — S616, down from 5%) of booking revenue pro-rated to
 *     the month instead. total = MAX(rate × billable + str_fee, min).
 *
 * Occupied spaces (up front, for the month starting): every unit on the
 * property with an active lease, a month stay with no lease (10/5, Nic), owner
 * use, or a utility-service arrangement overlapping the month — each unit ONCE
 * (services/billableUnits occupiedSpacesSql).
 *
 * Short-stay nights (in arrears, for the month just ended): SUM of all nights
 * from NIGHTLY and WEEKLY unit_bookings on the property (feeCountedStaySql),
 * clamped to the month via LEAST(check_out, month_end+1d) -
 * GREATEST(check_in, month_start). EVERY nightly/weekly night counts — no
 * exclusion for units that also had a lease. 10/5 (Nic): "arrears is only for
 * short term stays where we dont know the aggregate total nights."
 *
 * 10/5 (Nic): a space occupied AFTER the 1st is billed for that month on the
 * next weeknight, by processPlatformFeeTopUp below, so that night's payout
 * nets it. Only ever the current month — "the extra nights in september
 * balance with the late arrivals for october."
 *
 * Per-property fee = rate × total_billable + STR fee. NO per-property floor.
 *
 * S630 DIRECTIVE (Nic): "It's ten dollars per Connect account. So if several
 * properties deposit to the same Stripe account, it's only ten dollar minimum
 * for that setup." The floor is on the PAYOUT SETUP, not on each address — a
 * landlord with four parks paying into one Connect account was billed four
 * minimums for one setup. It is applied once per group, after every property
 * in the month has been accrued, by applyConnectAccountMinimums().
 *
 * rate + min come from landlord_platform_fee_overrides if active, else
 * platform_fee_config (S114).
 *
 * Per-property platform_fee_payer toggle (S114) determines what happens
 * with the fee:
 *   - 'landlord': post a 'platform_fee_subscription' entry to
 *     platform_revenue_ledger (GAM keeps it; landlord's payouts net out
 *     this amount via Stripe Connect destination charge math)
 *   - 'tenant': do NOT post to platform_revenue_ledger this month;
 *     accrual row remains with payer='tenant' and tenant_charge_id
 *     NULL until the next rent charge picks it up as an add-on
 *     (future session — needs the rent-pay route to consult unpaid
 *     accruals and roll them into application_fee_amount)
 *
 * Idempotency: UNIQUE(landlord_id, property_id, accrual_month) on
 * platform_fee_accruals (S114). Re-running the job is safe.
 */

import { randomUUID } from 'crypto'
import { getClient, query } from '../db'
import { chargeLandlord } from '../services/landlordGamAccount'
import { activateBillingForOccupancy } from '../services/billingActivation'
import { billableUnitsForProperty, feeCountedStaySql, type BillableUnits } from '../services/billableUnits'
import { stayRevenueInMonthSql } from '../services/platformFee'
import { NIGHTS_AGGREGATION_UNIT_TYPES, PLATFORM_FEE_GRACE_CYCLES } from '@gam/shared'
import type { PoolClient } from 'pg'
import { addDaysTo, dateIn, monthStartOf } from '../lib/timezone'

interface AccrualResult {
  monthScanned: string
  propertiesProcessed: number
  feesAccrued: number
  skippedZero: number
  skippedAlreadyAccrued: number
  skippedPreBilling: number
  /** S637: landlords whose onboarding grace ended because they had occupancy. */
  graceEndedByOccupancy: number
  /** S630: payout groups that needed a top-up to reach the monthly floor. */
  connectMinimumsApplied: number
  errors: { property_id: string; error: string }[]
}

export async function processPlatformFeeAccrual(now: Date = new Date()): Promise<AccrualResult> {
  // ── S637 (SUPERSEDED IN PART BY S650) — SEE BELOW ───────────────────
  // S650 (Nic): only the short-stay side is arrears now. "We only bill in
  // arrears for things that have to be billed in arrears. Everything that can
  // be charged up front, we do charge up front." Leases are known on the 1st,
  // so they are billed for the month starting; nights ride along for the month
  // just ended. The S637 reasoning below still explains WHY nights cannot be
  // billed in advance.
  //
  // ── S637: THE PLATFORM FEE IS BILLED IN ARREARS ─────────────────────
  //
  // Nic (DIRECTIVE): "The platform needs to bill in arrears for occupied units
  // from the month before... Billing has always been designed to be in arrears
  // for the platform fee, because on short-term stays you don't know how many
  // aggregate nights in an RV park spots were filled up. There could be two
  // hundred nights between a bunch of spots divided by thirty... It was never
  // designed to be billed for the upcoming month."
  //
  // This job fires on the 1st and used to stamp accrual_month as the month it
  // was RUNNING IN — so the 1 October run billed for October, counting leases
  // active at 00:01 on the 1st. Two things are wrong with that.
  //
  // Short stays cannot be counted in advance at all. The nights/30 aggregation
  // needs a finished month; on day one there are no nights yet, so every
  // nightly and weekly space billed zero and the fee was permanently short.
  //
  // And a month billed on its first day cannot reflect what happened in it. A
  // lease ending mid-October reduced OCTOBER's fee, which had already been
  // charged. Billed in arrears it reduces November's, which is when the vacancy
  // actually cost the landlord nothing — Nic: "if a lease ends in October and
  // we bill in November, they would see a reduced platform fee unless they've
  // refilled the spot before the billing cycle."
  //
  // So the run bills the month that just ENDED. Money still moves once: the
  // fee comes out of rent that is being disbursed to the landlord anyway.
  // ── S650 (Nic): CHARGE UP FRONT WHAT CAN BE CHARGED UP FRONT ────────────
  //
  //   "We only bill in arrears for things that have to be billed in arrears.
  //    Everything that can be charged up front, we do charge up front... the
  //    leases are billed at that time. So October 1st we're going to bill
  //    arrears for aggregate for September, and October's platform
  //    subscription."
  //
  // A lease is known on the 1st: you know who is there and which spots are
  // taken, so that part is billed for the month STARTING. Short-stay nights
  // cannot be known in advance — a spot might turn over five times — so those
  // stay in arrears for the month just ended, and land on the same bill.
  //
  // S637's all-arrears behavior is why September's fee had to be run by hand:
  // the run on the 1st was still billing the month before it.
  //
  // S654: the month is read off GAM's Phoenix calendar, not UTC. The cron fires
  // at 1:30 am Phoenix on the 1st, which is the 1st in UTC too, but a run
  // started by hand after 5 pm Phoenix on the last day of a month was already
  // next month in UTC and would have billed the wrong cycle. Phoenix is also the
  // database's zone, so this agrees with CURRENT_DATE.
  const monthIso     = monthStartOf(dateIn(null, now))
  const arrearsIso   = monthStartOf(addDaysTo(monthIso, -1))

  const result: AccrualResult = {
    monthScanned: monthIso,
    propertiesProcessed: 0,
    feesAccrued: 0,
    skippedZero: 0,
    skippedAlreadyAccrued: 0,
    skippedPreBilling: 0,
    graceEndedByOccupancy: 0,
    connectMinimumsApplied: 0,
    errors: [],
  }

  // Pull every active property + its landlord. Properties with no
  // owner_user_id (orphan rows) are skipped.
  // S630: skip GAM's OWN landlords. `pool-intake@gam.internal` — the renter-pool
  // conduit — is flagged is_system precisely "so it stays out of" billing, but
  // this job never checked it, so GAM invoiced itself $10 a month and wrote it
  // into platform_revenue_ledger as revenue that does not exist.
  // S637: a landlord who had somebody in a spot last month is live, whatever
  // way they were paid. Runs BEFORE the per-property gate below, so the month
  // that proves occupancy is the month that gets billed.
  try {
    const c = await getClient()
    try {
      result.graceEndedByOccupancy = await activateBillingForOccupancy(c, monthIso)
    } finally { c.release() }
  } catch (e: any) {
    result.errors.push({ property_id: 'occupancy_activation', error: e?.message ?? String(e) })
  }

  const properties = await query<{ id: string; landlord_id: string }>(`
    SELECT p.id, p.landlord_id FROM properties p
      JOIN landlords l ON l.id = p.landlord_id
     WHERE p.landlord_id IS NOT NULL
       AND l.is_system = FALSE
  `)

  for (const prop of properties) {
    try {
      const outcome = await accrueOneProperty(prop.id, prop.landlord_id, monthIso, arrearsIso)
      if      (outcome === 'accrued')         result.feesAccrued++
      else if (outcome === 'zero')            result.skippedZero++
      else if (outcome === 'already_accrued') result.skippedAlreadyAccrued++
      else if (outcome === 'pre_billing')     result.skippedPreBilling++
      result.propertiesProcessed++
    } catch (e: any) {
      result.errors.push({ property_id: prop.id, error: e?.message ?? String(e) })
    }
  }

  // S630: every property for the month is in; settle each payout setup's floor.
  try {
    result.connectMinimumsApplied = await applyConnectAccountMinimums(monthIso)
  } catch (e: any) {
    result.errors.push({ property_id: 'connect_minimums', error: e?.message ?? String(e) })
  }

  return result
}

/**
 * S630 DIRECTIVE (Nic): the monthly floor belongs to the Stripe Connect payout
 * account, not to each property. "If several properties deposit to the same
 * Stripe account, it's only ten dollar minimum for that setup."
 *
 * Runs once after every property has accrued, because a floor on a GROUP cannot
 * be decided while looking at one member: two properties earning $6 and $2 owe
 * $10 between them, not $10 each and not $20.
 *
 * The shortfall lands on the group's largest earner as its own column and its
 * own ledger line, so the books read "fee $8, minimum top-up $2" instead of a
 * $10 that no unit count explains. Properties with no Connect account of their
 * own are grouped by entity, since without one they cannot share a payout.
 *
 * Only groups that ALREADY accrued something are topped up. A landlord still in
 * onboarding grace has no accrual at all, and inventing one here would bill
 * through the grace the accrual path just declined to bill through.
 */
export async function applyConnectAccountMinimums(monthIso: string): Promise<number> {
  // Every payout group whose landlord is PAST GRACE **and has something to bill
  // this month**.
  //
  // S631 (Nic, DIRECTIVE): "We do ten dollars a month minimum, but only when
  // money's moving through the system. Leaving it vacant forever as a ghost in
  // the system is okay."
  //
  // The floor used to apply to any past-grace account whether or not it earned
  // anything — it would create a zero row purely to hang a $10 top-up off. That
  // turned every abandoned signup into a $10/month invoice the moment the grace
  // cap stamped billing_starts_at: a landlord who kicked the tires, added one
  // space, never came back and never had a tenant would be billed forever. It
  // also contradicted the standing rule that a landlord goes non-charged when
  // every unit is vacant, since a fully-vacant portfolio earns zero and would
  // have been floored to $10 all the same.
  //
  // The floor is what a TRANSACTING account pays when $2/unit lands under $10 —
  // one occupied space is $2, and the floor lifts it to $10. It was never meant
  // to be a subscription for holding an empty record. So a group with nothing
  // billable this month is skipped entirely: no row, no top-up, no invoice.
  // Occupancy is the trigger, not settlement — a landlord whose tenant simply
  // hasn't paid yet still has a billable unit and still owes the floor.
  const groups = await query<{
    group_key: string; min_amount: string; earned: string
    anchor_accrual_id: string | null; anchor_property_id: string; anchor_landlord_id: string
  }>(`
    WITH live AS (
      SELECT p.id AS property_id, l.id AS landlord_id,
             COALESCE(l.stripe_connect_account_id, 'entity:' || l.id::text) AS group_key,
             COALESCE(o.min_per_connect_account, pfc.min_per_connect_account) AS min_amount
        FROM properties p
        JOIN landlords l ON l.id = p.landlord_id
        CROSS JOIN LATERAL (
          SELECT min_per_connect_account FROM platform_fee_config
           WHERE effective_until IS NULL LIMIT 1) pfc
        LEFT JOIN landlord_platform_fee_overrides o
               ON o.landlord_id = l.id AND o.effective_until IS NULL
       WHERE l.billing_starts_at IS NOT NULL
         AND l.billing_starts_at <= $1::date
         AND l.is_system = FALSE
    ),
    joined AS (
      SELECT live.*, a.id AS accrual_id, COALESCE(a.total_amount, 0) AS amount,
             COALESCE(a.total_billable, 0) AS billable
        FROM live
        LEFT JOIN platform_fee_accruals a
               ON a.property_id = live.property_id AND a.accrual_month = $1::date
    )
    SELECT group_key,
           MIN(min_amount)::text AS min_amount,
           -- total_amount ALREADY includes any top-up applied on a previous
           -- run, so summing every row makes a re-run compute a shortfall of
           -- zero and change nothing. Excluding topped-up rows here would let a
           -- second run charge a multi-property group its floor twice.
           SUM(amount)::text AS earned,
           -- largest earner carries the shortfall; property id breaks ties so a
           -- re-run lands it in the same place.
           (ARRAY_AGG(accrual_id  ORDER BY amount DESC, property_id))[1]::text AS anchor_accrual_id,
           (ARRAY_AGG(property_id ORDER BY amount DESC, property_id))[1]::text AS anchor_property_id,
           (ARRAY_AGG(landlord_id ORDER BY amount DESC, property_id))[1]::text AS anchor_landlord_id
      FROM joined
     GROUP BY group_key
     -- S631: something has to be moving. A group with no billable unit and no
     -- earnings this month is not floored — it is not billed at all.
    HAVING SUM(COALESCE(billable, 0)) > 0 OR SUM(amount) > 0`, [monthIso])

  let applied = 0
  for (const g of groups) {
    const min = parseFloat(g.min_amount)
    const earned = parseFloat(g.earned)
    const shortfall = round2(min - earned)
    // Stamp the group on every row for the month either way, so a past month can
    // still explain which payout setup it was pooled under.
    await query(
      `UPDATE platform_fee_accruals SET connect_group_key = $1
        WHERE accrual_month = $2::date AND landlord_id IN (
          SELECT id FROM landlords
           WHERE COALESCE(stripe_connect_account_id, 'entity:' || id::text) = $1)`,
      [g.group_key, monthIso]).catch(() => {})
    if (!(shortfall > 0)) continue

    const client = await getClient()
    try {
      await client.query('BEGIN')
      let accrualId = g.anchor_accrual_id
      if (!accrualId) {
        // The group has billable units (the HAVING above guarantees it) but no
        // accrual row landed — the property-level accrual errored or was skipped.
        // The floor still applies, so it needs a row to hang off, created at zero
        // with the top-up carrying the whole amount. An account with NOTHING
        // billable never reaches here: S631 skips it before the loop.
        const payerRes = await client.query<{ platform_fee_payer: string | null }>(
          `SELECT platform_fee_payer FROM property_allocation_rules WHERE property_id = $1`,
          [g.anchor_property_id])
        const created = await client.query<{ id: string }>(`
          INSERT INTO platform_fee_accruals
            (landlord_id, property_id, accrual_month,
             long_term_unit_count, short_stay_nights, short_stay_equivalent,
             total_billable, utility_service_unit_count,
             rate_per_unit, min_per_connect_account, total_amount,
             str_revenue, str_fee_amount, payer)
          SELECT $1, $2, $3::date, 0, 0, 0, 0, 0,
                 COALESCE(o.rate_per_unit, pfc.rate_per_unit), $4, 0, 0, 0, $5
            FROM platform_fee_config pfc
            LEFT JOIN landlord_platform_fee_overrides o
                   ON o.landlord_id = $1 AND o.effective_until IS NULL
           WHERE pfc.effective_until IS NULL
           LIMIT 1
          ON CONFLICT (landlord_id, property_id, accrual_month) DO NOTHING
          RETURNING id`,
          [g.anchor_landlord_id, g.anchor_property_id, monthIso, min,
           payerRes.rows[0]?.platform_fee_payer ?? 'landlord'])
        accrualId = created.rows[0]?.id ?? null
        if (!accrualId) { await client.query('ROLLBACK'); continue }
      }
      await client.query(
        `UPDATE platform_fee_accruals
            SET connect_min_topup = $2, total_amount = total_amount + $2, updated_at = now()
          WHERE id = $1`, [accrualId, shortfall])

      const anchor = await client.query<{ payer: string; property_id: string; landlord_id: string }>(
        `SELECT payer, property_id, landlord_id FROM platform_fee_accruals WHERE id = $1`,
        [accrualId])
      // Tenant-payer accruals are picked up by the next rent charge; only the
      // landlord-payer case posts revenue now, exactly as the per-property path.
      if (anchor.rows[0]?.payer === 'landlord') {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`)
        const floorLine = await client.query<{ id: string }>(
          `INSERT INTO platform_revenue_ledger
             (type, amount, balance_after, reference_id, reference_type, property_id, notes)
           SELECT 'platform_fee_subscription', $1,
                  COALESCE((SELECT balance_after FROM platform_revenue_ledger
                             ORDER BY created_at DESC, id DESC LIMIT 1), 0) + $1,
                  -- Its own reference_type: the ledger's idempotency index is
                  -- (reference_id, reference_type, type), so the top-up gets a
                  -- distinct line beside the earned fee instead of colliding
                  -- with it — and a re-run cannot double-post.
                  $2, 'platform_fee_min_topup', $3,
                  $4
           RETURNING id`,
          [shortfall, accrualId, anchor.rows[0].property_id,
           `Connect-account minimum top-up for ${monthIso} (group earned ${earned.toFixed(2)} of ${min.toFixed(2)})`])
        // 10/5 (Nic): the floor was booked as GAM's revenue here and never
        // charged to the landlord — the same disease S650 cured for the earned
        // fee: a payout nets only what landlord_gam_charges says is owed, so
        // the $8 that brings a $2 month to $10 was on the books and never
        // collected. Charge it, idempotent on the accrual (a re-run finds no
        // shortfall, and the source key stops a second charge regardless).
        if (floorLine.rows[0]) {
          await chargeLandlord(client, {
            landlordId: anchor.rows[0].landlord_id,
            propertyId: anchor.rows[0].property_id,
            kind: 'subscription',
            amount: shortfall,
            sourceType: 'platform_fee_min_topup',
            sourceId: accrualId,
            notes: `Monthly minimum for ${monthLabel(monthIso)} — brings this payout account to $${min.toFixed(2)}`,
          })
        }
      }
      await client.query('COMMIT')
      applied++
    } catch (e) {
      await client.query('ROLLBACK'); throw e
    } finally { client.release() }
  }
  return applied
}

/**
 * Daily grace-cap sweep (S600). A landlord in onboarding grace has
 * billing_starts_at NULL. Once their grace cap month arrives, billing begins
 * even if they never took a rent payment THROUGH GAM — they've had the free
 * setup + preview window (setup cycle + PLATFORM_FEE_GRACE_CYCLES full cycles).
 * Cap = billing_grace_until, falling back to first-of-month(created_at) +
 * PLATFORM_FEE_GRACE_CYCLES months when unset (covers any landlord created
 * before the app-code that stamps billing_grace_until at signup). Idempotent:
 * only NULL rows whose cap month has arrived flip. Activation via first settled
 * rent (webhooks.ts) always wins the race — it fills billing_starts_at earlier,
 * so this sweep never touches an already-live landlord.
 *
 * S631 (Nic): the cap now skips a landlord who never STARTED. It used to stamp
 * every account whose window ran out, including someone who signed up, typed a
 * property name, and never came back — and after the S631 floor change that
 * account is billed nothing anyway, so the stamp bought no revenue and cost the
 * truth: the row then claims "billing since October" about a landlord who never
 * had a tenant. Any signup-conversion or active-landlord count read off this
 * column would have counted abandoned signups as customers.
 *
 * "Started" is deliberately wider than "paid us": a landlord holding an ACTIVE
 * LEASE is operating on the platform whether or not the rent flows through it,
 * and the cap exists precisely so that landlord can't sit in free grace forever
 * by collecting off-platform. It is only the empty account — no lease, no
 * payment, ever — that stays NULL, and stays NULL indefinitely. If they come
 * back a year later and sign a tenant, the cap picks them up on the next sweep.
 */
export async function applyBillingGraceCaps(now: Date = new Date()): Promise<number> {
  const flipped = await query<{ id: string }>(
    `UPDATE landlords AS l
        SET billing_starts_at = cap.cap_month, updated_at = now()
       FROM (
         SELECT id,
                COALESCE(
                  billing_grace_until,
                  (date_trunc('month', created_at) + ($1::int * INTERVAL '1 month'))::date
                ) AS cap_month
           FROM landlords
          WHERE billing_starts_at IS NULL
            -- S631: never operated → never stamped. Either signal counts.
            AND (
              EXISTS (SELECT 1 FROM payments pay
                       WHERE pay.landlord_id = landlords.id
                         AND pay.type = 'rent' AND pay.status = 'settled')
              OR EXISTS (SELECT 1 FROM leases le
                           JOIN units u ON u.id = le.unit_id
                           JOIN properties pr ON pr.id = u.property_id
                          WHERE pr.landlord_id = landlords.id
                            AND le.status IN ('active', 'pending'))
            )
       ) cap
      WHERE l.id = cap.id
        AND cap.cap_month <= date_trunc('month', $2::timestamptz)::date
      RETURNING l.id`,
    [PLATFORM_FEE_GRACE_CYCLES, now.toISOString()]
  )
  return flipped.length
}

type AccrualOutcome = 'accrued' | 'zero' | 'already_accrued' | 'pre_billing'

/**
 * What one property's bill for a month comes to: its spaces, its arrears
 * nights, its stay-revenue share, its rate and who pays. One calculation for
 * the monthly accrual and for the nightly top-up when it creates a property's
 * first row of the month (10/5), so the two cannot bill a property differently.
 */
interface AccrualFigures {
  billable: BillableUnits
  totalBillable: number
  strRevenue: number
  strFeePct: number
  strFeeAmount: number
  ratePerUnit: number
  minPerGroup: number
  /** rate × spaces + the stay-revenue share. Never floored here (S630). */
  totalAmount: number
  payer: 'landlord' | 'tenant'
  pmCompanyId: string | null
}

async function figureAccrual(
  client: PoolClient,
  propertyId: string,
  landlordId: string,
  monthIso: string,
  arrearsIso: string,
  /**
   * Whether the month just ended is billed on this row — its nightly and
   * weekly nights and its stay-revenue share. False when that month was still
   * inside the landlord's onboarding grace (10/5 top-up: a landlord who went
   * live mid-month is billed for the spaces of the month he went live in,
   * never for the free month before it).
   */
  withArrears = true,
): Promise<AccrualFigures> {
  // S652: the count lives in services/billableUnits so the admin estimate and
  // this bill cannot disagree. See that file for what counts and why.
  const counted = await billableUnitsForProperty(
    client, propertyId, monthIso, arrearsIso, NIGHTS_AGGREGATION_UNIT_TYPES)
  const billable: BillableUnits = withArrears ? counted : {
    ...counted, shortStayNights: 0, shortStayEquivalent: 0,
    total: counted.longTerm + counted.utilityService,
  }
  const totalBillable = billable.longTerm + billable.shortStayEquivalent + billable.utilityService

  // ── STR revenue (S538) ───────────────────────────────────────────────
  // Bookings on any NON-aggregation unit type (everything but rv_spot)
  // bill a percentage of revenue instead of nights/30. Revenue
  // attributes to the month pro-rata by nights:
  // total_amount × in-month / full-stay.
  // 10/3 (decisions #33): "full-stay" is the length SOLD, and an early
  // check-out's unstayed nights count in the month the guest left
  // (services/platformFee stayRevenueInMonthSql — one formula for the bill
  // and the landlord's fee estimate).
  const strRes = await client.query<{ revenue: string | null }>(`
    SELECT COALESCE(SUM(${stayRevenueInMonthSql('b', '$2::date')}), 0) AS revenue
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
     WHERE u.property_id = $1
       AND u.unit_type <> ALL($3::text[])
       -- 10/5 (Nic): nightly and weekly stays only — a month stay is a space,
       -- billed up front (services/billableUnits), never a revenue share too.
       AND ${feeCountedStaySql('b', '$2::date')}
       AND b.status NOT IN ('cancelled', 'no_show')
       AND b.check_in  <  $2::date + INTERVAL '1 month'
       AND b.check_out >  $2::date
  `, [propertyId, arrearsIso  /* S650: arrears, like the nights above */, [...NIGHTS_AGGREGATION_UNIT_TYPES]])
  const strRevenue = withArrears ? round2(parseFloat(strRes.rows[0].revenue ?? '0')) : 0

  // ── S645: IS THIS PROPERTY RUN BY A MANAGER? ───────────────────
  //
  // Nic (S644, DIRECTIVE): GAM bills "the PM company - one bill" for every
  // occupied unit across all their owners. So for a managed property the
  // INVOICE goes to the manager. What the OWNER pays their manager is the
  // manager's own fee plan and has nothing to do with this - Nic (S646):
  // "the owner's statement would not see our contract between the property
  // manager and the platform."
  //
  // Read before the rate, because the manager's rate is the one that applies:
  // 11,000 units under one contract is not the list price, and that deal
  // follows the MANAGER across every owner they bring.
  const pmRes = await client.query<{ pm_company_id: string }>(`
    SELECT p.pm_company_id
      FROM properties p
     WHERE p.id = $1 AND p.pm_company_id IS NOT NULL
  `, [propertyId])
  const pmCompanyId = pmRes.rows[0]?.pm_company_id ?? null

  // ── Rate + minimum ────────────────────────────────────────────────────
  //
  // Cascade: the MANAGER's negotiated rate when one runs this property, else
  // the owner's own override, else the platform default. A managed property
  // is the manager's line of business and is priced on their contract.
  const rateRes = await client.query<{
    rate_per_unit: string
    min_per_connect_account: string
    str_fee_pct: string
  }>(`
    SELECT
      COALESCE(pmo.rate_per_unit, o.rate_per_unit, pfc.rate_per_unit) AS rate_per_unit,
      COALESCE(pmo.min_per_connect_account, o.min_per_connect_account,
               pfc.min_per_connect_account) AS min_per_connect_account,
      COALESCE(o.str_fee_pct, pfc.str_fee_pct) AS str_fee_pct
    FROM platform_fee_config pfc
    LEFT JOIN landlord_platform_fee_overrides o
           ON o.landlord_id = $1
          AND o.effective_until IS NULL
    LEFT JOIN pm_company_platform_fee_overrides pmo
           ON pmo.pm_company_id = $2::uuid
          AND pmo.effective_until IS NULL
    WHERE pfc.effective_until IS NULL
    LIMIT 1
  `, [landlordId, pmCompanyId])
  if (rateRes.rowCount === 0) throw new Error(`No active platform_fee_config row found`)
  const ratePerUnit  = parseFloat(rateRes.rows[0].rate_per_unit)
  const minPerGroup  = parseFloat(rateRes.rows[0].min_per_connect_account)
  const strFeePct    = parseFloat(rateRes.rows[0].str_fee_pct)
  const strFeeAmount = round2(strFeePct * strRevenue)

  // ── Resolve platform_fee_payer at accrual time ──────────────────────
  const payerRes = await client.query<{ platform_fee_payer: 'landlord' | 'tenant' | null }>(`
    SELECT platform_fee_payer FROM property_allocation_rules WHERE property_id = $1
  `, [propertyId])
  const payer = (payerRes.rows[0]?.platform_fee_payer ?? 'landlord') as 'landlord' | 'tenant'

  return {
    billable, totalBillable, strRevenue, strFeePct, strFeeAmount,
    ratePerUnit, minPerGroup,
    totalAmount: round2(ratePerUnit * totalBillable + strFeeAmount),
    payer, pmCompanyId,
  }
}

/** Insert a property's accrual row for the month; returns its id. */
async function insertAccrualRow(
  client: PoolClient,
  landlordId: string,
  propertyId: string,
  monthIso: string,
  f: AccrualFigures,
  /** What the row bills — the figures' total unless the floor already covered part of it (10/5 top-up). */
  totalAmount: number,
  connectMinTopup = 0,
  connectGroupKey: string | null = null,
): Promise<string> {
  const accrualRes = await client.query<{ id: string }>(`
    INSERT INTO platform_fee_accruals
      (landlord_id, property_id, accrual_month,
       long_term_unit_count, short_stay_nights, short_stay_equivalent, total_billable,
       utility_service_unit_count,
       rate_per_unit, min_per_connect_account, total_amount,
       str_revenue, str_fee_amount,
       payer,
       billed_pm_company_id,
       connect_min_topup, connect_group_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $14, $8, $9, $10, $11, $12, $13, $15, $16, $17)
    RETURNING id
  `, [
    landlordId, propertyId, monthIso,
    f.billable.longTerm, f.billable.shortStayNights, f.billable.shortStayEquivalent, f.totalBillable,
    f.ratePerUnit, f.minPerGroup, totalAmount,
    f.strRevenue, f.strFeeAmount,
    f.payer,
    f.billable.utilityService,
    f.pmCompanyId,
    connectMinTopup, connectGroupKey,
  ])
  return accrualRes.rows[0].id
}

/**
 * Post one line of GAM's platform-fee revenue. The caller is inside a
 * transaction; the ledger's one lock is taken here.
 */
async function postPlatformFeeRevenue(
  client: PoolClient,
  amount: number,
  referenceId: string,
  referenceType: string,
  propertyId: string,
  notes: string,
): Promise<string> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`)
  const prev = await client.query<{ balance_after: string }>(
    `SELECT balance_after FROM platform_revenue_ledger
      ORDER BY created_at DESC, id DESC LIMIT 1`
  )
  const prevBal = (prev.rowCount && prev.rowCount > 0)
    ? parseFloat(prev.rows[0].balance_after)
    : 0
  const ledgerRes = await client.query<{ id: string }>(`
    INSERT INTO platform_revenue_ledger
      (type, amount, balance_after, reference_id, reference_type,
       property_id, notes)
    VALUES ('platform_fee_subscription', $1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [amount, round2(prevBal + amount), referenceId, referenceType, propertyId, notes])
  return ledgerRes.rows[0].id
}

/**
 * The words on a monthly accrual's revenue line, which a landlord reading his
 * fee can check against his own count.
 */
function accrualLedgerNotes(monthIso: string, f: AccrualFigures): string {
  const b = f.billable
  return `Platform fee for ${monthIso} (${f.totalBillable} billable units` +
    (b.shortStayEquivalent > 0
      ? `, ${b.longTerm} long-term + CEIL(${b.shortStayNights}/30)=${b.shortStayEquivalent} short-stay`
      : '') +
    // 10/5: say so when month stays are among the spaces, so a park reading
    // its line sees why RV 10 is on it with no lease.
    (b.monthStays > 0 ? `, ${b.monthStays} month stay${b.monthStays === 1 ? '' : 's'}` : '') +
    // S615: name them, so a landlord reading his fee line can see that the
    // extra $2 is the space next door he supplies and not a miscount.
    (b.utilityService > 0 ? `, ${b.utilityService} utility-service` : '') +
    (f.strFeeAmount > 0
      ? `, +${(f.strFeePct * 100).toFixed(1)}% of ${f.strRevenue.toFixed(2)} STR revenue = ${f.strFeeAmount.toFixed(2)}`
      : '') + `)`
}

async function accrueOneProperty(
  propertyId: string,
  landlordId: string,
  monthIso: string,
  /** S650: the month whose short-stay nights ride along on this bill. */
  arrearsIso: string,
): Promise<AccrualOutcome> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Per-(property, month) advisory lock — same key shape as S111.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [accrualLockKey(propertyId, monthIso)]
    )

    // Idempotency: already accrued?
    const existing = await client.query(
      `SELECT 1 FROM platform_fee_accruals
        WHERE landlord_id = $1 AND property_id = $2 AND accrual_month = $3`,
      [landlordId, propertyId, monthIso]
    )
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query('ROLLBACK')
      return 'already_accrued'
    }

    // ── No-double-bill onboarding grace (S600) ───────────────────────────
    // A landlord isn't billed until they GO LIVE. billing_starts_at is NULL
    // during setup/preview (in grace), then set to the current cycle on their
    // first settled rent (activation), or to the grace cap by the daily
    // grace-cap cron — whichever fires first. Bill only cycles on/after it.
    const gate = await client.query<{ ok: boolean }>(
      `SELECT (billing_starts_at IS NOT NULL AND billing_starts_at <= $2::date) AS ok
         FROM landlords WHERE id = $1`,
      [landlordId, monthIso]
    )
    if (!gate.rows[0]?.ok) {
      await client.query('ROLLBACK')
      return 'pre_billing'
    }

    const f = await figureAccrual(client, propertyId, landlordId, monthIso, arrearsIso)

    // S630: no floor here. A property that earned nothing accrues nothing, and
    // the Connect-account group's minimum is settled once, later, across all of
    // them — so four properties on one payout setup no longer pay four floors.
    if (f.totalBillable === 0 && f.strFeeAmount === 0) {
      await client.query('ROLLBACK')
      return 'zero'
    }

    const accrualId = await insertAccrualRow(client, landlordId, propertyId, monthIso, f, f.totalAmount)

    // ── Post platform_revenue_ledger entry when payer='landlord' ────────
    // When payer='tenant', the accrual row stands alone and the
    // tenant-rent-charge code picks it up to add to the next rent payment.
    if (f.payer === 'landlord') {
      const ledgerId = await postPlatformFeeRevenue(
        client, f.totalAmount, accrualId, 'platform_fee_accrual', propertyId,
        accrualLedgerNotes(monthIso, f))

      await client.query(
        `UPDATE platform_fee_accruals SET platform_revenue_ledger_id=$1, updated_at=NOW() WHERE id=$2`,
        [ledgerId, accrualId]
      )

      // ── S650 (Nic): AND ACTUALLY CHARGE FOR IT ────────────────────────────
      //
      // This posted GAM's revenue and stopped. The header's "the landlord's
      // payouts net out this amount via Stripe Connect destination charge math"
      // described the PRE-S561 money model; under platform-holds a payout nets
      // what the landlord OWES (landlord_gam_charges) and nothing else. No
      // charge was ever written, so the platform fee has been recognized as
      // revenue and never collected from anybody — GAM has been running the
      // parks for free while the books said otherwise.
      //
      // Idempotent on (source_type, source_id): a re-run accrual cannot bill
      // the same month twice.
      await chargeLandlord(client, {
        landlordId,
        propertyId,
        kind: 'subscription',
        amount: f.totalAmount,
        sourceType: 'platform_fee_accrual',
        sourceId: accrualId,
        notes: `Platform fee for ${monthIso} (${f.totalBillable} billable units)`,
      })
    }

    await client.query('COMMIT')
    return 'accrued'
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

/** The per-(property, month) lock the monthly accrual and the top-up share. */
function accrualLockKey(propertyId: string, monthIso: string): string {
  return `platform_fee_accrual:${propertyId}:${monthIso}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** "2026-10-01" → "October 2026", for words a landlord reads. */
function monthLabel(monthIso: string): string {
  return new Date(`${monthIso.slice(0, 10)}T00:00:00Z`)
    .toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

// ── 10/5 (Nic): THE NIGHTLY TOP-UP ──────────────────────────────────────────
//
//   "rv 10 and 11 and 15 and 47 are active stays in october. they get billed
//    for october. arrears is only for short term stays where we dont know the
//    aggregate total nights. we know all 4 stays will be here the entire month"
//
// The monthly run on the 1st bills the spaces occupied THEN. A lease signed on
// the 5th, or a month stay that arrives on the 12th, was billed by nobody: the
// 1st had already passed and the next 1st bills the next month. Nic chose: a
// space occupied after the 1st is billed for THAT month on the next weeknight,
// just before the payout run, so the same night's payout nets it.
//
// Only the CURRENT month, ever. Nic, on a lease that started Sept 24 and was
// signed Oct 5: "bill for the month of october. the extra nights in september
// balance with the late arrivals for october." So nothing here back-bills an
// earlier month.
//
// It only ever RAISES a bill — someone leaving mid-month does not refund the
// month — and only by the spaces (leases, month stays, owner use, utility
// spaces). The nightly and weekly nights on the row are last month's, counted
// in arrears on the 1st, and are left as they were.

export interface PlatformFeeTopUpResult {
  monthScanned: string
  /** The month's monthly run has not happened yet, so nothing was touched. */
  monthNotYetBilled: boolean
  propertiesRaised: number
  propertiesCreated: number
  /** What was added to landlords' bills tonight, in dollars. */
  amountCharged: number
  /**
   * Properties whose fee their TENANTS pay, where the month's fee has already
   * been added to a rent charge — a raise could not reach anyone, so it is
   * left for a person to look at.
   */
  tenantPayerSkipped: string[]
  errors: { property_id: string; error: string }[]
}

export async function processPlatformFeeTopUp(now: Date = new Date()): Promise<PlatformFeeTopUpResult> {
  // Named exactly as the monthly run names it (Phoenix calendar, S654). The
  // payout cron fires at 01:00 UTC, which is 6 pm the evening BEFORE in
  // Phoenix — so the run at 01:00 UTC on Nov 1 is still Oct 31 and tops up
  // October, the month that is actually still running.
  const monthIso   = monthStartOf(dateIn(null, now))
  const arrearsIso = monthStartOf(addDaysTo(monthIso, -1))
  const result: PlatformFeeTopUpResult = {
    monthScanned: monthIso, monthNotYetBilled: false,
    propertiesRaised: 0, propertiesCreated: 0, amountCharged: 0,
    tenantPayerSkipped: [], errors: [],
  }

  // Never before the month's monthly run (1:30 am Phoenix on the 1st). The run
  // leaves a row for every property it billed, and nothing else writes a row
  // for a month (this function only writes once one exists), so a row for the
  // month is the proof it ran. By the clock alone it always has — 01:00 UTC is
  // 6 pm Phoenix, after 1:30 am — but a missed or failed monthly run must not
  // be stood in for by this one: the 1st's floor and grace sweeps never ran.
  const opened = await query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM platform_fee_accruals WHERE accrual_month = $1::date) AS ok`,
    [monthIso])
  if (!opened[0]?.ok) {
    result.monthNotYetBilled = true
    return result
  }

  // Every payout group, past onboarding grace for this month exactly as the
  // monthly run applies it (billing_starts_at set and on or before the month)
  // — the same groups and the same floor as applyConnectAccountMinimums. A
  // Connect account belongs to one landlord (landlords_stripe_connect_account_id
  // _uniq), so a group is always one landlord's properties, all keyed by his
  // account today: a change of account mid-month moves the whole group, and
  // what it already paid toward the floor moves with it.
  const groups = await query<{
    group_key: string; min_amount: string; property_ids: string[]; landlord_ids: string[]
    arrears_billable: boolean[]
  }>(`
    SELECT COALESCE(l.stripe_connect_account_id, 'entity:' || l.id::text) AS group_key,
           MIN(COALESCE(o.min_per_connect_account, pfc.min_per_connect_account))::text AS min_amount,
           ARRAY_AGG(p.id::text ORDER BY p.id) AS property_ids,
           ARRAY_AGG(l.id::text ORDER BY p.id) AS landlord_ids,
           -- Was the month just ended a billed month for this landlord? Only
           -- then may a row the top-up creates carry that month's nights.
           ARRAY_AGG(l.billing_starts_at <= $2::date ORDER BY p.id) AS arrears_billable
      FROM properties p
      JOIN landlords l ON l.id = p.landlord_id
      CROSS JOIN LATERAL (
        SELECT min_per_connect_account FROM platform_fee_config
         WHERE effective_until IS NULL LIMIT 1) pfc
      LEFT JOIN landlord_platform_fee_overrides o
             ON o.landlord_id = l.id AND o.effective_until IS NULL
     WHERE l.is_system = FALSE
       AND l.billing_starts_at IS NOT NULL
       AND l.billing_starts_at <= $1::date
     GROUP BY 1`, [monthIso, arrearsIso])

  for (const g of groups) {
    try {
      await topUpGroup(g, monthIso, arrearsIso, result)
    } catch (e: any) {
      result.errors.push({ property_id: g.property_ids.join(','), error: e?.message ?? String(e) })
    }
  }
  result.amountCharged = round2(result.amountCharged)
  return result
}

interface TopUpRaise {
  propertyId: string
  landlordId: string
  /** An existing row raised, or a property's first row of the month. */
  row: AccrualRowForTopUp | null
  figures: AccrualFigures | null
  newLongTerm: number
  newUtilityService: number
  /** Spaces added (raise) — or every space on a new row. */
  moreSpaces: number
  spacesInAll: number
  /** What those spaces earn at the row's rate (the figures' whole total for a new row). */
  value: number
  payer: 'landlord' | 'tenant'
  /** What tonight actually adds to this row, after the floor (set below). */
  share: number
}

interface AccrualRowForTopUp {
  id: string
  property_id: string
  landlord_id: string
  payer: 'landlord' | 'tenant'
  tenant_charge_id: string | null
  rate_per_unit: string
  long_term_unit_count: number
  utility_service_unit_count: number
  total_amount: string
  connect_min_topup: string
}

/**
 * One payout group, one transaction: every property's lock, the recount, the
 * group's floor, and the bookings land together or not at all.
 *
 * THE FLOOR (S630, per Connect account). After tonight the group's total must
 * be max(floor, earned) — what it would have been had the 1st seen these
 * spaces. Tonight's charge is that total less what the month already charged,
 * so a space added while the group is under the floor adds $0 (the floor
 * already paid for it), one that lifts it over adds only the excess, and the
 * floor is never charged twice. Nothing already charged is ever lowered: a
 * raise the floor absorbed is written on its row as a negative
 * connect_min_topup, so each row still reads total = earned + top-up and the
 * group's top-ups still add to exactly floor − earned.
 */
async function topUpGroup(
  g: {
    group_key: string; min_amount: string; property_ids: string[]; landlord_ids: string[]
    arrears_billable: boolean[]
  },
  monthIso: string,
  arrearsIso: string,
  result: PlatformFeeTopUpResult,
): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // The payout run waits on this one (jobs/scheduler). A group stuck behind
    // somebody else's lock is given up on and logged, never left to hold every
    // landlord's payout for the night.
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    await client.query(`SET LOCAL statement_timeout = '60s'`)
    // Same lock as the monthly run's, in a fixed order so two runs can never
    // deadlock on one group.
    for (const pid of g.property_ids) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [accrualLockKey(pid, monthIso)])
    }

    const rows = (await client.query<AccrualRowForTopUp>(
      `SELECT id, property_id, landlord_id, payer, tenant_charge_id,
              rate_per_unit::text, long_term_unit_count, utility_service_unit_count,
              total_amount::text, connect_min_topup::text
         FROM platform_fee_accruals
        WHERE property_id = ANY($1::uuid[]) AND accrual_month = $2::date
        ORDER BY property_id
        FOR UPDATE`,
      [g.property_ids, monthIso])).rows
    const rowByProperty = new Map(rows.map(r => [r.property_id, r]))
    const chargedBefore = round2(rows.reduce((n, r) => n + parseFloat(r.total_amount), 0))
    const earnedBefore = round2(rows.reduce(
      (n, r) => n + parseFloat(r.total_amount) - parseFloat(r.connect_min_topup), 0))

    const raises: TopUpRaise[] = []
    for (let i = 0; i < g.property_ids.length; i++) {
      const propertyId = g.property_ids[i]
      const landlordId = g.landlord_ids[i]
      const row = rowByProperty.get(propertyId)
      if (row) {
        const b = await billableUnitsForProperty(
          client, propertyId, monthIso, arrearsIso, NIGHTS_AGGREGATION_UNIT_TYPES)
        const before = row.long_term_unit_count + row.utility_service_unit_count
        const after = b.longTerm + b.utilityService
        if (after <= before) continue          // never lowers; nothing new
        if (row.payer === 'tenant' && row.tenant_charge_id) {
          // The tenant-paid fee rides on the next rent charge, which picks up
          // the row's whole total once (services/rentCharge). This month's has
          // already been picked up, so a raise would reach nobody.
          result.tenantPayerSkipped.push(propertyId)
          continue
        }
        const more = after - before
        raises.push({
          propertyId, landlordId: row.landlord_id, row, figures: null,
          newLongTerm: b.longTerm, newUtilityService: b.utilityService,
          moreSpaces: more, spacesInAll: after,
          value: round2(parseFloat(row.rate_per_unit) * more),
          payer: row.payer, share: 0,
        })
      } else {
        // Nothing was billable here on the 1st. Its first row is figured
        // exactly as the monthly run would have figured it — except the month
        // just ended, when that month was still the landlord's onboarding
        // grace (he went live this month): it was never a billed month.
        const f = await figureAccrual(
          client, propertyId, landlordId, monthIso, arrearsIso, g.arrears_billable[i] === true)
        if (f.totalBillable === 0 && f.strFeeAmount === 0) continue
        raises.push({
          propertyId, landlordId, row: null, figures: f,
          newLongTerm: f.billable.longTerm, newUtilityService: f.billable.utilityService,
          moreSpaces: f.billable.longTerm + f.billable.utilityService,
          spacesInAll: f.billable.longTerm + f.billable.utilityService,
          value: f.totalAmount, payer: f.payer, share: 0,
        })
      }
    }
    if (raises.length === 0) { await client.query('ROLLBACK'); return }

    const floor = parseFloat(g.min_amount)
    const earnedAfter = round2(earnedBefore + raises.reduce((n, r) => n + r.value, 0))
    const target = round2(Math.max(floor, earnedAfter))
    let remaining = Math.max(round2(target - chargedBefore), 0)
    for (const r of raises) {
      r.share = round2(Math.min(remaining, r.value))
      remaining = round2(remaining - r.share)
    }
    // Only when the group was under its floor before tonight with nothing
    // charged toward it (a group billed nothing on the 1st): the floor itself.
    const floorLeft = remaining

    const label = monthLabel(monthIso)
    const createdIds = new Map<string, string>()
    for (const r of raises) {
      const absorbed = round2(r.value - r.share)
      const covered = absorbed > 0
        ? `; $${absorbed.toFixed(2)} of it was already covered by the $${floor.toFixed(2)} monthly minimum`
        : ''
      const spaces = (n: number) => `${n} occupied space${n === 1 ? '' : 's'}`
      let accrualId: string
      let note: string
      if (r.row) {
        accrualId = r.row.id
        await client.query(
          `UPDATE platform_fee_accruals
              SET long_term_unit_count = $2,
                  utility_service_unit_count = $3,
                  total_billable = total_billable + $4,
                  total_amount = total_amount + $5,
                  connect_min_topup = connect_min_topup - $6,
                  connect_group_key = $7,
                  updated_at = NOW()
            WHERE id = $1`,
          [accrualId, r.newLongTerm, r.newUtilityService, r.moreSpaces,
           r.share, absorbed, g.group_key])
        note = `Platform fee for ${label} — ${r.moreSpaces} more occupied space${r.moreSpaces === 1 ? '' : 's'} (${r.spacesInAll} in all)${covered}`
        result.propertiesRaised++
      } else {
        const f = r.figures!
        accrualId = await insertAccrualRow(
          client, r.landlordId, r.propertyId, monthIso, f, r.share, round2(r.share - f.totalAmount), g.group_key)
        createdIds.set(r.propertyId, accrualId)
        const nights = f.billable.shortStayEquivalent > 0
          ? `, ${f.billable.shortStayEquivalent} more for ${f.billable.shortStayNights} nights stayed in ${monthLabel(arrearsIso)}`
          : ''
        const str = f.strFeeAmount > 0
          ? `, $${f.strFeeAmount.toFixed(2)} for ${(f.strFeePct * 100).toFixed(1)}% of stay revenue`
          : ''
        note = `Platform fee for ${label} — ${spaces(r.spacesInAll)}${nights}${str}${covered}`
        result.propertiesCreated++
      }

      // Booked exactly as the monthly fee is (accrueOneProperty): GAM's revenue
      // line and the landlord's 'subscription' charge, which the payout nets.
      // A tenant-paid fee is left on the row for the next rent charge instead.
      if (r.payer === 'landlord' && r.share > 0) {
        // A property's FIRST row of the month books its revenue like the
        // monthly fee — one 'platform_fee_accrual' line per accrual, the key
        // services/platformRevenue also books by. A raise is its own line with
        // its own key, so each night's raise is a separate, unrepeatable one.
        const ref = r.row ? randomUUID() : accrualId
        const ledgerType = r.row ? 'platform_fee_topup' : 'platform_fee_accrual'
        const ledgerId = await postPlatformFeeRevenue(client, r.share, ref, ledgerType, r.propertyId, note)
        if (!r.row) {
          await client.query(
            `UPDATE platform_fee_accruals SET platform_revenue_ledger_id = $1 WHERE id = $2`,
            [ledgerId, accrualId])
        }
        // The CHARGE is always a top-up, even a property's first of the month.
        // The portal-lock sweep (services/portalLockSweep) counts the 1st's
        // 'platform_fee_accrual' charges as billing cycles, one a month; a
        // first bill raised at 6 pm on the 31st would otherwise count as a
        // whole cycle hours before the next 1st's, and lock a landlord after
        // one day of patience instead of a month's.
        await chargeLandlord(client, {
          landlordId: r.landlordId, propertyId: r.propertyId, kind: 'subscription',
          amount: r.share, sourceType: 'platform_fee_topup', sourceId: ref, notes: note,
        })
        result.amountCharged += r.share
      }
    }

    if (floorLeft > 0) {
      // The largest earner carries the floor, as on the 1st — among the rows a
      // charge can still reach.
      const candidates = (await client.query<{ id: string; property_id: string; landlord_id: string; payer: string }>(
        `SELECT id, property_id, landlord_id, payer FROM platform_fee_accruals
          WHERE property_id = ANY($1::uuid[]) AND accrual_month = $2::date
            AND (payer = 'landlord' OR tenant_charge_id IS NULL)
          ORDER BY (total_amount - connect_min_topup) DESC, property_id
          LIMIT 1`,
        [g.property_ids, monthIso])).rows
      const anchor = candidates[0]
      if (!anchor) throw new Error(`No row can carry the $${floorLeft.toFixed(2)} monthly minimum for ${g.group_key}`)
      await client.query(
        `UPDATE platform_fee_accruals
            SET total_amount = total_amount + $2, connect_min_topup = connect_min_topup + $2,
                connect_group_key = $3, updated_at = NOW()
          WHERE id = $1`,
        [anchor.id, floorLeft, g.group_key])
      if (anchor.payer === 'landlord') {
        const note = `Monthly minimum for ${label} — brings this payout account to $${floor.toFixed(2)}`
        const ref = randomUUID()
        await postPlatformFeeRevenue(client, floorLeft, ref, 'platform_fee_topup', anchor.property_id, note)
        await chargeLandlord(client, {
          landlordId: anchor.landlord_id, propertyId: anchor.property_id, kind: 'subscription',
          amount: floorLeft, sourceType: 'platform_fee_topup', sourceId: ref, notes: note,
        })
        result.amountCharged += floorLeft
      }
    }

    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

// ── S552: SCREENING FEE SWEEP ────────────────────────────────────────────
//
// Sweeps every unbilled screening_fee_accruals row (billed_at IS NULL) into
// platform revenue: one ledger entry per landlord covering the batch sum of
// the landlord screening charge (S561: Checkr cost passed through + $5 margin).
// Runs with the monthly platform-fee cron; also safe to run ad hoc. (Moves to
// disbursement-netting under the money-flow rebuild — gam-money-flow-platform-holds.)
//
// Ledger type reuses 'platform_fee_subscription' (the CHECK-constrained
// enum predates the shared single-source rule; screening fees ARE platform
// service revenue) with reference_type='screening_fee_sweep' to keep the
// two streams distinguishable in reporting.
//
// Idempotency: rows are selected FOR UPDATE and stamped billed_at +
// platform_revenue_ledger_id in the same transaction as the ledger post —
// a re-run finds nothing unbilled and posts nothing.

export interface ScreeningSweepResult {
  landlordsSwept: number
  accrualsSwept: number
  totalSwept: number
  errors: { landlord_id: string; error: string }[]
}

export async function processScreeningFeeSweep(): Promise<ScreeningSweepResult> {
  const result: ScreeningSweepResult = { landlordsSwept: 0, accrualsSwept: 0, totalSwept: 0, errors: [] }

  const landlords = await query<{ landlord_id: string }>(`
    SELECT DISTINCT landlord_id FROM screening_fee_accruals WHERE billed_at IS NULL
  `)

  for (const { landlord_id } of landlords) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const rows = await client.query<{ id: string; standard_total: string; compliance_fee: string }>(
        `SELECT id, standard_total, compliance_fee FROM screening_fee_accruals
          WHERE landlord_id = $1 AND billed_at IS NULL
          FOR UPDATE`,
        [landlord_id]
      )
      if (rows.rowCount === 0) { await client.query('ROLLBACK'); client.release(); continue }
      // S561: landlord owes standard_total (Checkr cost passed through) +
      // compliance_fee (GAM's $5 margin). (shortfall retired — always 0.)
      const total = round2(rows.rows.reduce(
        (s, r) => s + parseFloat(r.standard_total) + parseFloat(r.compliance_fee), 0))

      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`)
      const prev = await client.query<{ balance_after: string }>(
        `SELECT balance_after FROM platform_revenue_ledger
          ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      const prevBal = (prev.rowCount && prev.rowCount > 0) ? parseFloat(prev.rows[0].balance_after) : 0

      const ledger = await client.query<{ id: string }>(`
        INSERT INTO platform_revenue_ledger
          (type, amount, balance_after, reference_id, reference_type, notes)
        VALUES ('platform_fee_subscription', $1, $2, $3, 'screening_fee_sweep', $4)
        RETURNING id
      `, [
        total, round2(prevBal + total), landlord_id,
        `Screening fees: ${rows.rowCount} check(s) — Checkr cost + $5 margin`,
      ])

      await client.query(
        `UPDATE screening_fee_accruals
            SET billed_at = NOW(), platform_revenue_ledger_id = $1
          WHERE landlord_id = $2 AND billed_at IS NULL`,
        [ledger.rows[0].id, landlord_id]
      )
      await client.query('COMMIT')
      result.landlordsSwept++
      result.accrualsSwept += rows.rowCount ?? 0
      result.totalSwept = round2(result.totalSwept + total)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      result.errors.push({ landlord_id, error: e instanceof Error ? e.message : String(e) })
    } finally {
      client.release()
    }
  }
  return result
}
