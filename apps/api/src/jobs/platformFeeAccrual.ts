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
 * Per-property fee = MAX(rate × total_billable, min_per_property)
 * where rate + min come from landlord_platform_fee_overrides if active,
 * else platform_fee_config (S114).
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
import type { PoolClient } from 'pg'

interface AccrualResult {
  monthScanned: string
  propertiesProcessed: number
  feesAccrued: number
  skippedZero: number
  skippedAlreadyAccrued: number
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
      result.propertiesProcessed++
    } catch (e: any) {
      result.errors.push({ property_id: prop.id, error: e?.message ?? String(e) })
    }
  }

  return result
}

type AccrualOutcome = 'accrued' | 'zero' | 'already_accrued'

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

    // ── Long-term unit count ─────────────────────────────────────────────
    // Distinct units with an active lease overlapping the billing month.
    const ltRes = await client.query<{ c: number }>(`
      SELECT COUNT(DISTINCT l.unit_id)::int AS c
        FROM leases l
        JOIN units u ON u.id = l.unit_id
       WHERE u.property_id = $1
         AND l.status = 'active'
         AND l.start_date <= ($2::date + INTERVAL '1 month' - INTERVAL '1 day')
         AND (l.end_date IS NULL OR l.end_date >= $2::date)
    `, [propertyId, monthIso])
    const longTermUnitCount = ltRes.rows[0].c

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
         AND b.lease_type IN ('nightly', 'weekly')
         AND b.status NOT IN ('cancelled', 'no_show')
         AND b.check_in  <  $2::date + INTERVAL '1 month'
         AND b.check_out >  $2::date
    `, [propertyId, monthIso])
    const shortStayNights = ssRes.rows[0].nights ?? 0
    const shortStayEquivalent = Math.ceil(shortStayNights / 30)

    const totalBillable = longTermUnitCount + shortStayEquivalent

    // ── Rate + minimum (cascade through landlord override → platform default) ──
    const rateRes = await client.query<{
      rate_per_unit: string
      min_per_property: string
    }>(`
      SELECT
        COALESCE(o.rate_per_unit,    pfc.rate_per_unit)    AS rate_per_unit,
        COALESCE(o.min_per_property, pfc.min_per_property) AS min_per_property
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
    const ratePerUnit    = parseFloat(rateRes.rows[0].rate_per_unit)
    const minPerProperty = parseFloat(rateRes.rows[0].min_per_property)

    // If totalBillable is 0 AND minimum is 0, nothing to bill.
    if (totalBillable === 0 && minPerProperty === 0) {
      await client.query('ROLLBACK')
      return 'zero'
    }

    const totalAmount = round2(Math.max(ratePerUnit * totalBillable, minPerProperty))

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
         rate_per_unit, min_per_property, total_amount,
         payer)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `, [
      landlordId, propertyId, monthIso,
      longTermUnitCount, shortStayNights, shortStayEquivalent, totalBillable,
      ratePerUnit, minPerProperty, totalAmount,
      payer,
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
          ? `, ${longTermUnitCount} long-term + CEIL(${shortStayNights}/30)=${shortStayEquivalent} STR`
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
