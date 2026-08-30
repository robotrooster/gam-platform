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
 * Long-term unit count: distinct units on the property with an active
 * lease (leases.status='active') whose [start_date, end_date OR ∞] range
 * overlaps any day of the billing month.
 *
 * Short-stay nights: SUM of all nights from unit_bookings on the property
 * where lease_type IN ('nightly','weekly') and status NOT IN
 * ('cancelled','no_show'), clamped to the billing month via
 * LEAST(check_out, month_end+1d) - GREATEST(check_in, month_start).
 * EVERY night counts — no exclusion for units that also had a lease.
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

import { getClient, query } from '../db'
import { NIGHTS_AGGREGATION_UNIT_TYPES, PLATFORM_FEE_GRACE_CYCLES } from '@gam/shared'
import type { PoolClient } from 'pg'

interface AccrualResult {
  monthScanned: string
  propertiesProcessed: number
  feesAccrued: number
  skippedZero: number
  skippedAlreadyAccrued: number
  skippedPreBilling: number
  /** S630: payout groups that needed a top-up to reach the monthly floor. */
  connectMinimumsApplied: number
  errors: { property_id: string; error: string }[]
}

export async function processPlatformFeeAccrual(now: Date = new Date()): Promise<AccrualResult> {
  // Accrual month = first day of the calendar month (UTC).
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthIso   = monthStart.toISOString().slice(0, 10)

  const result: AccrualResult = {
    monthScanned: monthIso,
    propertiesProcessed: 0,
    feesAccrued: 0,
    skippedZero: 0,
    skippedAlreadyAccrued: 0,
    skippedPreBilling: 0,
    connectMinimumsApplied: 0,
    errors: [],
  }

  // Pull every active property + its landlord. Properties with no
  // owner_user_id (orphan rows) are skipped.
  const properties = await query<{ id: string; landlord_id: string }>(`
    SELECT id, landlord_id FROM properties
     WHERE landlord_id IS NOT NULL
  `)

  for (const prop of properties) {
    try {
      const outcome = await accrueOneProperty(prop.id, prop.landlord_id, monthIso)
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
  // Every payout group whose landlord is PAST GRACE, whether or not it earned
  // anything this month — a live account with no occupied units still owes the
  // floor, exactly as it did when the floor was per property. Landlords still in
  // onboarding grace (billing_starts_at NULL or in the future) are absent, so
  // this can never bill through the grace the accrual path just honoured.
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
    ),
    joined AS (
      SELECT live.*, a.id AS accrual_id, COALESCE(a.total_amount, 0) AS amount
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
     GROUP BY group_key`, [monthIso])

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
        // The whole group earned nothing this month. The floor still applies, so
        // it needs a row to hang off — created at zero, with the top-up carrying
        // the entire amount, so the row states plainly that no unit was billed.
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

      const anchor = await client.query<{ payer: string; property_id: string }>(
        `SELECT payer, property_id FROM platform_fee_accruals WHERE id = $1`,
        [accrualId])
      // Tenant-payer accruals are picked up by the next rent charge; only the
      // landlord-payer case posts revenue now, exactly as the per-property path.
      if (anchor.rows[0]?.payer === 'landlord') {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`)
        await client.query(
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
                  $4`,
          [shortfall, accrualId, anchor.rows[0].property_id,
           `Connect-account minimum top-up for ${monthIso} (group earned ${earned.toFixed(2)} of ${min.toFixed(2)})`])
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
 * billing_starts_at NULL. Once their grace cap month arrives, billing must begin
 * even if they never took a rent payment — they've had the free setup + preview
 * window (setup cycle + PLATFORM_FEE_GRACE_CYCLES full cycles). Cap =
 * billing_grace_until, falling back to first-of-month(created_at) +
 * PLATFORM_FEE_GRACE_CYCLES months when unset (covers any landlord created
 * before the app-code that stamps billing_grace_until at signup). Idempotent:
 * only NULL rows whose cap month has arrived flip. Activation via first settled
 * rent (webhooks.ts) always wins the race — it fills billing_starts_at earlier,
 * so this sweep never touches an already-live landlord.
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
       ) cap
      WHERE l.id = cap.id
        AND cap.cap_month <= date_trunc('month', $2::timestamptz)::date
      RETURNING l.id`,
    [PLATFORM_FEE_GRACE_CYCLES, now.toISOString()]
  )
  return flipped.length
}

type AccrualOutcome = 'accrued' | 'zero' | 'already_accrued' | 'pre_billing'

async function accrueOneProperty(
  propertyId: string,
  landlordId: string,
  monthIso: string
): Promise<AccrualOutcome> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Per-(property, month) advisory lock — same key shape as S111.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`platform_fee_accrual:${propertyId}:${monthIso}`]
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

    // ── Long-term unit count ─────────────────────────────────────────────
    // Distinct units with an active lease overlapping the billing month.
    const ltRes = await client.query<{ c: number }>(`
      SELECT COUNT(DISTINCT l.unit_id)::int AS c
        FROM leases l
        JOIN units u ON u.id = l.unit_id
       WHERE u.property_id = $1
         AND l.status = 'active'
         -- S576 Snowbird: a hibernating (seasonally-paused) lease doesn't accrue
         -- the per-occupied-unit fee — the tenant is gone and the spot earns
         -- off-season reservation revenue (zero platform fee) instead.
         AND l.is_hibernating = false
         AND l.start_date <= ($2::date + INTERVAL '1 month' - INTERVAL '1 day')
         AND (l.end_date IS NULL OR l.end_date >= $2::date)
    `, [propertyId, monthIso])
    const longTermUnitCount = ltRes.rows[0].c

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
         AND b.status NOT IN ('cancelled', 'no_show')
         AND b.check_in  <  $2::date + INTERVAL '1 month'
         AND b.check_out >  $2::date
    `, [propertyId, monthIso, [...NIGHTS_AGGREGATION_UNIT_TYPES]])
    const shortStayNights = ssRes.rows[0].nights ?? 0
    const shortStayEquivalent = Math.ceil(shortStayNights / 30)

    const totalBillable = longTermUnitCount + shortStayEquivalent + utilityServiceUnitCount

    // ── STR revenue (S538) ───────────────────────────────────────────────
    // Bookings on any NON-aggregation unit type (everything but rv_spot)
    // bill a percentage of revenue instead of nights/30. Revenue
    // attributes to the month pro-rata by nights:
    // total_amount × in-month / full-stay.
    const strRes = await client.query<{ revenue: string | null }>(`
      SELECT COALESCE(SUM(
          COALESCE(b.total_amount, 0)
            * GREATEST(
                LEAST(b.check_out, $2::date + INTERVAL '1 month')::date
                  - GREATEST(b.check_in, $2::date)::date,
                0
              )::numeric
            / GREATEST((b.check_out - b.check_in), 1)::numeric
        ), 0) AS revenue
        FROM unit_bookings b
        JOIN units u ON u.id = b.unit_id
       WHERE u.property_id = $1
         AND u.unit_type <> ALL($3::text[])
         AND b.lease_type IN ('nightly', 'weekly')
         AND b.status NOT IN ('cancelled', 'no_show')
         AND b.check_in  <  $2::date + INTERVAL '1 month'
         AND b.check_out >  $2::date
    `, [propertyId, monthIso, [...NIGHTS_AGGREGATION_UNIT_TYPES]])
    const strRevenue = round2(parseFloat(strRes.rows[0].revenue ?? '0'))

    // ── Rate + minimum (cascade through landlord override → platform default) ──
    const rateRes = await client.query<{
      rate_per_unit: string
      min_per_connect_account: string
      str_fee_pct: string
    }>(`
      SELECT
        COALESCE(o.rate_per_unit, pfc.rate_per_unit) AS rate_per_unit,
        COALESCE(o.min_per_connect_account, pfc.min_per_connect_account)
          AS min_per_connect_account,
        COALESCE(o.str_fee_pct, pfc.str_fee_pct) AS str_fee_pct
      FROM platform_fee_config pfc
      LEFT JOIN landlord_platform_fee_overrides o
             ON o.landlord_id = $1
            AND o.effective_until IS NULL
      WHERE pfc.effective_until IS NULL
      LIMIT 1
    `, [landlordId])
    if (rateRes.rowCount === 0) {
      await client.query('ROLLBACK')
      throw new Error(`No active platform_fee_config row found`)
    }
    const ratePerUnit  = parseFloat(rateRes.rows[0].rate_per_unit)
    const minPerGroup   = parseFloat(rateRes.rows[0].min_per_connect_account)
    const strFeePct    = parseFloat(rateRes.rows[0].str_fee_pct)
    const strFeeAmount = round2(strFeePct * strRevenue)

    // S630: no floor here. A property that earned nothing accrues nothing, and
    // the Connect-account group's minimum is settled once, later, across all of
    // them — so four properties on one payout setup no longer pay four floors.
    if (totalBillable === 0 && strFeeAmount === 0) {
      await client.query('ROLLBACK')
      return 'zero'
    }

    const totalAmount = round2(ratePerUnit * totalBillable + strFeeAmount)

    // ── Resolve platform_fee_payer at accrual time ──────────────────────
    const payerRes = await client.query<{ platform_fee_payer: 'landlord' | 'tenant' | null }>(`
      SELECT platform_fee_payer FROM property_allocation_rules WHERE property_id = $1
    `, [propertyId])
    const payer = (payerRes.rows[0]?.platform_fee_payer ?? 'landlord') as 'landlord' | 'tenant'

    // ── Insert accrual row ──────────────────────────────────────────────
    const accrualRes = await client.query<{ id: string }>(`
      INSERT INTO platform_fee_accruals
        (landlord_id, property_id, accrual_month,
         long_term_unit_count, short_stay_nights, short_stay_equivalent, total_billable,
         utility_service_unit_count,
         rate_per_unit, min_per_connect_account, total_amount,
         str_revenue, str_fee_amount,
         payer)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $14, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `, [
      landlordId, propertyId, monthIso,
      longTermUnitCount, shortStayNights, shortStayEquivalent, totalBillable,
      ratePerUnit, minPerGroup, totalAmount,
      strRevenue, strFeeAmount,
      payer,
      utilityServiceUnitCount,
    ])
    const accrualId = accrualRes.rows[0].id

    // ── Post platform_revenue_ledger entry when payer='landlord' ────────
    // When payer='tenant', the accrual row stands alone and the
    // tenant-rent-charge code (future session) picks it up to add to
    // application_fee_amount on the next rent payment.
    if (payer === 'landlord') {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`)
      const prev = await client.query<{ balance_after: string }>(
        `SELECT balance_after FROM platform_revenue_ledger
          ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      const prevBal = (prev.rowCount && prev.rowCount > 0)
        ? parseFloat(prev.rows[0].balance_after)
        : 0
      const newBal = round2(prevBal + totalAmount)

      const ledgerRes = await client.query<{ id: string }>(`
        INSERT INTO platform_revenue_ledger
          (type, amount, balance_after, reference_id, reference_type,
           property_id, notes)
        VALUES ('platform_fee_subscription', $1, $2, $3, 'platform_fee_accrual', $4,
                $5)
        RETURNING id
      `, [
        totalAmount, newBal, accrualId, propertyId,
        `Platform fee for ${monthIso} (${totalBillable} billable units` +
        (shortStayEquivalent > 0
          ? `, ${longTermUnitCount} long-term + CEIL(${shortStayNights}/30)=${shortStayEquivalent} short-stay`
          : '') +
        // S615: name them, so a landlord reading his fee line can see that the
        // extra $2 is the space next door he supplies and not a miscount.
        (utilityServiceUnitCount > 0
          ? `, ${utilityServiceUnitCount} utility-service`
          : '') +
        (strFeeAmount > 0
          ? `, +${(strFeePct * 100).toFixed(1)}% of ${strRevenue.toFixed(2)} STR revenue = ${strFeeAmount.toFixed(2)}`
          : '') + `)`,
      ])

      await client.query(
        `UPDATE platform_fee_accruals SET platform_revenue_ledger_id=$1, updated_at=NOW() WHERE id=$2`,
        [ledgerRes.rows[0].id, accrualId]
      )
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

function round2(n: number): number {
  return Math.round(n * 100) / 100
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
