/**
 * S69: Monthly manager-fee accrual.
 *
 * Posts manager_fee ledger entries on the 1st of each month for properties
 * configured with `flat_monthly_fee` and/or `per_unit_fee` on their
 * allocation rule. The percent-of-rent variant (`rent_percent`) is handled
 * synchronously in the allocation engine (S64) — that's per-payment, not
 * time-based.
 *
 * Per-property fee = flat_monthly_fee + (per_unit_fee × occupied_unit_count).
 * Occupied = unit.status='active'. Skipped properties:
 *   - owner-self-managed (owner_user_id === managed_by_user_id)
 *   - both flat and per-unit fees NULL or 0
 *   - resulting fee = 0
 *
 * Idempotent via unique index on (property_id, accrual_month) in
 * monthly_fee_accruals. Running the job twice for the same month is a
 * no-op on the second run.
 *
 * Bank account routing: snapshots the manager's
 * `users.default_management_payout_bank_account_id` at accrual time —
 * same pattern allocation.ts uses for manager_fee. NULL is fine; the
 * row still posts, autoPayouts skips it until routing is configured.
 *
 * Lock: per-(property, month) advisory lock to serialize against any
 * concurrent retry. The cron only fires from one process, but cheap insurance.
 */

import { getClient } from '../db'
import type { PoolClient } from 'pg'
import { logger } from '../lib/logger'

interface AccrualResult {
  monthScanned: string
  propertiesProcessed: number
  feesAccrued: number
  skippedZero: number
  skippedAlreadyAccrued: number
  pmPropertiesProcessed: number
  pmFeesAccrued: number
  pmSkippedZero: number
  pmSkippedAlreadyAccrued: number
  errors: { property_id: string; error: string }[]
}

export async function processMonthlyFeeAccrual(now: Date = new Date()): Promise<AccrualResult> {
  // Accrual month = first day of the current calendar month (UTC). The cron
  // fires on the 1st so this is just today, pinned to day=01.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthIso = monthStart.toISOString().slice(0, 10)

  const result: AccrualResult = {
    monthScanned: monthIso,
    propertiesProcessed: 0,
    feesAccrued: 0,
    skippedZero: 0,
    skippedAlreadyAccrued: 0,
    pmPropertiesProcessed: 0,
    pmFeesAccrued: 0,
    pmSkippedZero: 0,
    pmSkippedAlreadyAccrued: 0,
    errors: [],
  }

  const client = await getClient()
  let propertyIds: string[] = []
  let pmCandidates: { property_id: string; pm_company_id: string; pm_fee_plan_id: string }[] = []
  try {
    // S111: in-house manager fee path now also excludes properties contracted
    // to a PM company — the PM company's monthly fee fires on the parallel
    // path below.
    const candidates = await client.query<{ id: string }>(`
      SELECT p.id
        FROM properties p
        JOIN property_allocation_rules r ON r.property_id = p.id
       WHERE p.owner_user_id <> p.managed_by_user_id
         AND p.pm_company_id IS NULL
         AND (
           COALESCE(r.flat_monthly_fee, 0) > 0
           OR COALESCE(r.per_unit_fee, 0) > 0
         )
    `)
    propertyIds = candidates.rows.map(r => r.id)

    // PM-managed properties on a flat_monthly or per_unit fee plan.
    const pmRes = await client.query<{ property_id: string; pm_company_id: string; pm_fee_plan_id: string }>(`
      SELECT p.id AS property_id, p.pm_company_id, p.pm_fee_plan_id
        FROM properties p
        JOIN pm_fee_plans fp ON fp.id = p.pm_fee_plan_id
       WHERE p.pm_company_id IS NOT NULL
         AND p.pm_fee_plan_id IS NOT NULL
         AND fp.status = 'active'
         AND fp.fee_type IN ('flat_monthly', 'per_unit')
    `)
    pmCandidates = pmRes.rows
  } finally {
    client.release()
  }

  for (const propertyId of propertyIds) {
    try {
      const outcome = await accrueOneProperty(propertyId, monthIso)
      if (outcome === 'accrued') result.feesAccrued++
      else if (outcome === 'zero') result.skippedZero++
      else if (outcome === 'already_accrued') result.skippedAlreadyAccrued++
      result.propertiesProcessed++
    } catch (e: any) {
      result.errors.push({ property_id: propertyId, error: e?.message ?? String(e) })
    }
  }

  for (const c of pmCandidates) {
    try {
      const outcome = await accruePmCompanyFee(c.property_id, c.pm_company_id, c.pm_fee_plan_id, monthIso)
      if (outcome === 'accrued') result.pmFeesAccrued++
      else if (outcome === 'zero') result.pmSkippedZero++
      else if (outcome === 'already_accrued') result.pmSkippedAlreadyAccrued++
      result.pmPropertiesProcessed++
    } catch (e: any) {
      result.errors.push({ property_id: c.property_id, error: `[PM] ${e?.message ?? String(e)}` })
    }
  }

  return result
}

type AccrualOutcome = 'accrued' | 'zero' | 'already_accrued'

async function accrueOneProperty(propertyId: string, monthIso: string): Promise<AccrualOutcome> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Per-(property, month) lock — protects against concurrent retries.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`monthly_fee_accrual:${propertyId}:${monthIso}`]
    )

    // Idempotency: did we already accrue this property for this month?
    const existing = await client.query(
      `SELECT 1 FROM monthly_fee_accruals
        WHERE property_id = $1 AND accrual_month = $2`,
      [propertyId, monthIso]
    )
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query('ROLLBACK')
      return 'already_accrued'
    }

    // Fetch property + rule + manager bank under the lock.
    const propRes = await client.query<{
      managed_by_user_id: string
      flat_monthly_fee: string | null
      per_unit_fee: string | null
      manager_bank_account_id: string | null
    }>(`
      SELECT p.managed_by_user_id,
             r.flat_monthly_fee,
             r.per_unit_fee,
             u.default_management_payout_bank_account_id AS manager_bank_account_id
        FROM properties p
        JOIN property_allocation_rules r ON r.property_id = p.id
        JOIN users u ON u.id = p.managed_by_user_id
       WHERE p.id = $1
    `, [propertyId])
    if (propRes.rowCount === 0) {
      await client.query('ROLLBACK')
      return 'zero'
    }
    const prop = propRes.rows[0]

    // Count occupied units (status='active' is the leased/occupied marker
    // per units_status_check).
    const occRes = await client.query<{ occupied: string }>(
      `SELECT COUNT(*)::int AS occupied
         FROM units WHERE property_id=$1 AND status='active'`,
      [propertyId]
    )
    const occupied = parseInt(occRes.rows[0].occupied, 10)
    const flat = parseFloat(prop.flat_monthly_fee ?? '0')
    const perUnit = parseFloat(prop.per_unit_fee ?? '0')
    const total = round2(flat + perUnit * occupied)

    if (total <= 0) {
      await client.query('ROLLBACK')
      return 'zero'
    }

    // 1. Create the accrual row first — the resulting UUID is what we
    // stamp on the ledger entry as reference_id.
    const accrualRes = await client.query<{ id: string }>(`
      INSERT INTO monthly_fee_accruals
        (property_id, accrual_month, flat_monthly_fee, per_unit_fee,
         occupied_unit_count, total_amount, manager_user_id, bank_account_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [propertyId, monthIso, flat, perUnit, occupied, total,
        prop.managed_by_user_id, prop.manager_bank_account_id])
    const accrualId = accrualRes.rows[0].id

    // 2. Post the manager_fee ledger entry under the user-wide lock
    // (same key allocation.ts and autoPayouts.ts use).
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`user_balance:${prop.managed_by_user_id}`]
    )
    const prevBal = await readLatestUserBalance(client, prop.managed_by_user_id)
    const newBal = round2(prevBal + total)

    const ledgerRes = await client.query<{ id: string }>(`
      INSERT INTO user_balance_ledger
        (user_id, type, amount, balance_after, reference_id, reference_type,
         property_id, bank_account_id, notes)
      VALUES ($1, 'allocation_manager_fee', $2, $3, $4, 'monthly_fee_accrual',
              $5, $6, $7)
      RETURNING id
    `, [
      prop.managed_by_user_id, total, newBal, accrualId, propertyId,
      prop.manager_bank_account_id,
      `Monthly manager fee for ${monthIso} (flat=${flat}, per_unit=${perUnit}×${occupied})`,
    ])

    // 3. Backfill the accrual row with the ledger entry id for traceability.
    await client.query(
      `UPDATE monthly_fee_accruals SET ledger_entry_id=$1 WHERE id=$2`,
      [ledgerRes.rows[0].id, accrualId]
    )

    await client.query('COMMIT')

    // S113-Phase1 post-commit: fire Stripe Transfer for the freshly-accrued
    // in-house manager fee. Mirrors the PM accrual post-commit fire below.
    try {
      const { fireManagerTransfersForReference } = await import('../services/stripeConnect')
      await fireManagerTransfersForReference('monthly_fee_accrual', accrualId)
    } catch (e) {
      logger.error({ err: e, accrual_id: accrualId }, '[manager_transfer] post-commit firing failed for accrual')
    }

    return 'accrued'
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

// S111: monthly accrual for third-party PM company plans.
// Mirrors accrueOneProperty's shape but writes to pm_monthly_fee_accruals
// and posts a 'allocation_pm_company_fee' ledger entry instead of
// 'allocation_manager_fee'. fee_type is one of {flat_monthly, per_unit}.
async function accruePmCompanyFee(
  propertyId: string,
  pmCompanyId: string,
  pmFeePlanId: string,
  monthIso: string,
): Promise<AccrualOutcome> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Per-(property, month, pm_company) lock — distinct key from the
    // in-house lock above so the two paths don't collide.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`pm_monthly_fee_accrual:${propertyId}:${monthIso}:${pmCompanyId}`]
    )

    const existing = await client.query(
      `SELECT 1 FROM pm_monthly_fee_accruals
        WHERE property_id = $1 AND accrual_month = $2 AND pm_company_id = $3`,
      [propertyId, monthIso, pmCompanyId]
    )
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query('ROLLBACK')
      return 'already_accrued'
    }

    // Pull plan + bank routing under the lock.
    const planRes = await client.query<{
      fee_type: string
      flat_amount: string | null
      per_unit_amount: string | null
      pm_bank_account_id: string | null
      pm_payout_user_id: string | null
    }>(`
      SELECT fp.fee_type,
             fp.flat_amount,
             fp.flat_amount AS per_unit_amount, -- per_unit also stored in flat_amount per S109 route
             c.bank_account_id AS pm_bank_account_id,
             ba.user_id        AS pm_payout_user_id
        FROM pm_fee_plans fp
        JOIN pm_companies c ON c.id = fp.pm_company_id
   LEFT JOIN user_bank_accounts ba ON ba.id = c.bank_account_id
       WHERE fp.id = $1 AND fp.pm_company_id = $2 AND fp.status = 'active'
    `, [pmFeePlanId, pmCompanyId])
    if (planRes.rowCount === 0) {
      await client.query('ROLLBACK')
      return 'zero'
    }
    const plan = planRes.rows[0]
    if (plan.pm_payout_user_id === null) {
      // PM company has no bank routing — accrual cannot post (no user_id
      // for the ledger entry). Same defense as allocation.ts.
      await client.query('ROLLBACK')
      throw new Error(
        `PM company ${pmCompanyId} has no bank routing — set bank_account_id before accrual can run.`
      )
    }

    // Occupied unit count (status='active' is the leased/occupied marker)
    const occRes = await client.query<{ occupied: string }>(
      `SELECT COUNT(*)::int AS occupied
         FROM units WHERE property_id=$1 AND status='active'`,
      [propertyId]
    )
    const occupied = parseInt(occRes.rows[0].occupied, 10)

    let total = 0
    if (plan.fee_type === 'flat_monthly') {
      if (plan.flat_amount === null) {
        await client.query('ROLLBACK')
        return 'zero'
      }
      total = round2(parseFloat(plan.flat_amount))
    } else if (plan.fee_type === 'per_unit') {
      if (plan.flat_amount === null) {
        await client.query('ROLLBACK')
        return 'zero'
      }
      total = round2(parseFloat(plan.flat_amount) * occupied)
    }

    if (total <= 0) {
      await client.query('ROLLBACK')
      return 'zero'
    }

    // 1. Insert accrual row first
    const accrualRes = await client.query<{ id: string }>(`
      INSERT INTO pm_monthly_fee_accruals
        (property_id, pm_company_id, pm_fee_plan_id, accrual_month, fee_type,
         flat_amount, per_unit_amount, occupied_unit_count, total_amount,
         pm_payout_user_id, bank_account_id)
      VALUES ($1, $2, $3, $4, $5,
              $6, $7, $8, $9,
              $10, $11)
      RETURNING id
    `, [
      propertyId, pmCompanyId, pmFeePlanId, monthIso, plan.fee_type,
      plan.fee_type === 'flat_monthly' ? plan.flat_amount : null,
      plan.fee_type === 'per_unit'     ? plan.flat_amount : null,
      occupied, total,
      plan.pm_payout_user_id, plan.pm_bank_account_id,
    ])
    const accrualId = accrualRes.rows[0].id

    // 2. Post pm_company_fee ledger entry under the user lock
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`user_balance:${plan.pm_payout_user_id}`]
    )
    const prevBal = await readLatestUserBalance(client, plan.pm_payout_user_id)
    const newBal = round2(prevBal + total)

    const ledgerRes = await client.query<{ id: string }>(`
      INSERT INTO user_balance_ledger
        (user_id, type, amount, balance_after, reference_id, reference_type,
         property_id, bank_account_id, notes)
      VALUES ($1, 'allocation_pm_company_fee', $2, $3, $4, 'pm_monthly_fee_accrual',
              $5, $6, $7)
      RETURNING id
    `, [
      plan.pm_payout_user_id, total, newBal, accrualId, propertyId,
      plan.pm_bank_account_id,
      `PM company monthly fee for ${monthIso} (plan ${pmFeePlanId}, ${plan.fee_type}` +
      (plan.fee_type === 'per_unit' ? ` × ${occupied} units` : '') + `)`,
    ])

    // 3. Backfill ledger_entry_id on the accrual
    await client.query(
      `UPDATE pm_monthly_fee_accruals SET ledger_entry_id=$1, updated_at=NOW() WHERE id=$2`,
      [ledgerRes.rows[0].id, accrualId]
    )

    await client.query('COMMIT')

    // S119 post-commit: fire Stripe Transfer for the freshly-accrued PM cut
    try {
      const { firePmTransfersForReference } = await import('../services/stripeConnect')
      await firePmTransfersForReference('pm_monthly_fee_accrual', accrualId)
    } catch (e) {
      logger.error({ err: e, accrual_id: accrualId }, '[pm_transfer] post-commit firing failed for accrual')
    }

    return 'accrued'
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

async function readLatestUserBalance(client: PoolClient, userId: string): Promise<number> {
  const res = await client.query<{ balance_after: string }>(`
    SELECT balance_after FROM user_balance_ledger
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 1
  `, [userId])
  return res.rowCount && res.rowCount > 0 ? parseFloat(res.rows[0].balance_after) : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
