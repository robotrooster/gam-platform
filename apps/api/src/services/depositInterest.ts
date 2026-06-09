/**
 * S188: deposit interest accrual engine.
 *
 * Encodes the S177 carve-out: per-state hardcoded rates with annual-
 * refresh migration cadence, accrued monthly per-deposit, summed
 * back into security_deposits.interest_accrued for the deposit-return
 * service to read at finalize.
 *
 * S241 policy lock — interest ownership:
 *   GAM-held deposit + state requires statutory interest → tenant
 *   GAM-held deposit + state silent on interest             → GAM
 *   Landlord-held deposit (held_by='landlord')              → landlord
 *
 * The first case is exactly what this engine implements: only states
 * listed in state_deposit_interest_rates accrue, and the accrued amount
 * flows to the tenant pool in depositReturn.calculateDepositReturn.
 * The second case is the implicit DEFAULT — when a state has no row,
 * this engine doesn't run, no accrual happens, and the yield GAM earns
 * on the held principal (via its bank / platform balance) is GAM
 * revenue with no GAM-side ledger entry needed. The third case is
 * filtered upstream — held_by='landlord' rows never reach this engine.
 *
 * Per-month accrual model:
 *   interest = principal * (annual_rate_pct / 100) * (days_held / 365)
 *
 * principal_amount: security_deposits.collected_amount (the actual
 *   amount held, not total_amount which is the contracted amount —
 *   matters when a deposit is partially funded).
 *
 * days_held: full days during the accrual_month that the deposit was
 *   held in escrow. Partial first month (deposit funded mid-month) and
 *   partial last month (deposit disbursed mid-month) compute days from
 *   the actual transition dates.
 *
 * State coverage: only states listed in state_deposit_interest_rates
 * for the relevant effective_year accrue. Unlisted states have no
 * statutory requirement under GAM's framing — the job skips them and
 * the interest yield stays with GAM (S241 lock above).
 *
 * Scheduling: monthly cron, fires day 1 at ~3am to accrue for the
 * previous month. Idempotent via UNIQUE(security_deposit_id,
 * accrual_month) — re-running for the same month is a no-op.
 */

import { getClient, query, queryOne } from '../db'
import { logger } from '../lib/logger'

export interface MonthlyAccrualResult {
  accrued_count:   number
  skipped_count:   number  // deposits whose state has no statutory rate
  error_count:     number
  total_interest:  number
  month:           string  // YYYY-MM-01
}

interface DepositForAccrual {
  id:               string
  lease_id:         string
  landlord_id:      string  // S190: needed for override lookup
  collected_amount: string
  state:            string
  funded_at:        string | null    // earliest installment payment date
  disbursed_at:     string | null
}

/**
 * S190: Resolve the effective rate for (state, year) for a given
 * landlord. Statutory hardcoded catalog wins if present; falls back
 * to the per-landlord override table for variable-rate states.
 * Returns null if neither source has a rate.
 */
export interface ResolvedRate {
  source:           'statutory' | 'landlord_override'
  state_code:       string
  effective_year:   number
  annual_rate_pct:  number
}

export async function resolveRateForLandlord(
  landlordId: string,
  stateCode:  string,
  year:       number,
): Promise<ResolvedRate | null> {
  const statutory = await queryOne<{
    annual_rate_pct: string
    effective_year:  number
  }>(
    `SELECT annual_rate_pct, effective_year
       FROM state_deposit_interest_rates
      WHERE state_code = $1 AND effective_year = $2
      LIMIT 1`,
    [stateCode, year],
  )
  if (statutory) {
    return {
      source:          'statutory',
      state_code:      stateCode,
      effective_year:  statutory.effective_year,
      annual_rate_pct: parseFloat(statutory.annual_rate_pct),
    }
  }

  const override = await queryOne<{
    annual_rate_pct: string
    effective_year:  number
  }>(
    `SELECT annual_rate_pct, effective_year
       FROM landlord_deposit_interest_rate_overrides
      WHERE landlord_id = $1 AND state_code = $2 AND effective_year = $3
      LIMIT 1`,
    [landlordId, stateCode, year],
  )
  if (override) {
    return {
      source:          'landlord_override',
      state_code:      stateCode,
      effective_year:  override.effective_year,
      annual_rate_pct: parseFloat(override.annual_rate_pct),
    }
  }

  return null
}

const isoMonthStart = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`

const daysInMonth = (year: number, monthZeroIdx: number): number =>
  new Date(Date.UTC(year, monthZeroIdx + 1, 0)).getUTCDate()

/**
 * Compute the interest for a single deposit for a single accrual month.
 * Returns null if the state has no rate (skip), or if the deposit
 * wasn't held during any part of this month (skip).
 */
export interface AccrualComputation {
  interest_amount:  number
  days_held:        number
  days_in_month:    number
  state_code:       string
  effective_year:   number
  annual_rate_pct:  number
  principal_amount: number
}

export async function computeMonthlyAccrual(
  deposit:      DepositForAccrual,
  monthStartIso: string,  // YYYY-MM-01
): Promise<AccrualComputation | null> {
  const monthStart = new Date(`${monthStartIso}T00:00:00Z`)
  const year = monthStart.getUTCFullYear()
  const monthZero = monthStart.getUTCMonth()
  const dim = daysInMonth(year, monthZero)
  const monthEnd = new Date(Date.UTC(year, monthZero + 1, 0))

  // Determine "held" date range within this month.
  // funded_at is the earliest moment the deposit was held in escrow;
  // disbursed_at is when it left. Both are timestamps; we floor to
  // dates for the accrual math.
  const fundedDate = deposit.funded_at ? new Date(deposit.funded_at) : null
  const disbursedDate = deposit.disbursed_at ? new Date(deposit.disbursed_at) : null

  if (!fundedDate) return null  // not yet funded; nothing to accrue
  if (fundedDate > monthEnd) return null  // funded after this month
  if (disbursedDate && disbursedDate < monthStart) return null  // already disbursed before this month

  const heldFrom = fundedDate > monthStart ? fundedDate : monthStart
  const heldUntil = disbursedDate && disbursedDate < monthEnd ? disbursedDate : monthEnd
  const daysHeld = Math.max(
    0,
    Math.floor((heldUntil.getTime() - heldFrom.getTime()) / (1000 * 60 * 60 * 24)) + 1,
  )
  if (daysHeld === 0) return null

  // S190: Look up the effective rate for this state and year.
  // Statutory catalog wins; falls back to per-landlord override for
  // variable-rate states (NY/NJ/CT/IL/PA/NH).
  const rate = await resolveRateForLandlord(deposit.landlord_id, deposit.state, year)
  if (!rate) return null  // no rate registered for this state/year

  const principal = parseFloat(deposit.collected_amount)
  if (principal <= 0) return null

  const interest = principal * (rate.annual_rate_pct / 100) * (daysHeld / 365)

  return {
    interest_amount:  Math.round(interest * 10000) / 10000,  // 4 decimals
    days_held:        daysHeld,
    days_in_month:    dim,
    state_code:       rate.state_code,
    effective_year:   rate.effective_year,
    annual_rate_pct:  rate.annual_rate_pct,
    principal_amount: principal,
  }
}

/**
 * Run accrual for every active deposit for the given month. Idempotent
 * via the UNIQUE(security_deposit_id, accrual_month) constraint.
 *
 * "Active" = security_deposits.status IN ('funded','partial','claimed')
 *   AND collected_amount > 0
 *   AND held_by = 'gam_escrow'  (statutory interest only flows when GAM
 *     holds the funds; if the landlord is holding the deposit directly,
 *     that's their compliance responsibility — GAM doesn't accrue on
 *     funds it doesn't custody)
 *
 * For each eligible deposit + state pair, compute the month's interest,
 * INSERT the accrual row, and UPDATE security_deposits.interest_accrued
 * to the new cumulative sum. All-or-nothing per deposit (one tx per).
 */
export async function runMonthlyAccrual(monthStartIso: string): Promise<MonthlyAccrualResult> {
  const result: MonthlyAccrualResult = {
    accrued_count: 0,
    skipped_count: 0,
    error_count:   0,
    total_interest: 0,
    month: monthStartIso,
  }

  // Pull every active deposit + property state. funded_at is derived
  // from the earliest payment row tagged as a deposit collection; if
  // no funding events exist (collected_amount > 0 but no rows), we
  // fall back to security_deposits.created_at (deposit row creation
  // = collection event in legacy data).
  const candidates = await query<DepositForAccrual>(
    `SELECT
        sd.id,
        sd.lease_id,
        l.landlord_id,
        sd.collected_amount::text AS collected_amount,
        p.state,
        COALESCE(
          (SELECT MIN(pmt.due_date::timestamp)
             FROM payments pmt
            WHERE pmt.entry_description = 'DEPOSIT'
              AND pmt.lease_id = sd.lease_id
              AND pmt.status = 'settled'),
          sd.created_at
        )::text AS funded_at,
        sd.disbursed_at::text AS disbursed_at
       FROM security_deposits sd
       JOIN leases l     ON l.id = sd.lease_id
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE sd.status IN ('funded', 'partial', 'claimed')
        AND sd.collected_amount > 0
        AND sd.held_by = 'gam_escrow'`,
  )

  for (const deposit of candidates) {
    try {
      const calc = await computeMonthlyAccrual(deposit, monthStartIso)
      if (!calc) {
        result.skipped_count += 1
        continue
      }
      const client = await getClient()
      try {
        await client.query('BEGIN')

        // Idempotent: ON CONFLICT DO NOTHING means re-running this
        // job for the same month is a no-op. Need to check if we
        // actually inserted to know whether to advance the running
        // total.
        const insert = await client.query<{ id: string }>(
          `INSERT INTO security_deposit_interest_accruals
             (security_deposit_id, lease_id, accrual_month,
              state_code, effective_year, annual_rate_pct,
              principal_amount, days_held, days_in_month, interest_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (security_deposit_id, accrual_month) DO NOTHING
           RETURNING id`,
          [
            deposit.id, deposit.lease_id, monthStartIso,
            calc.state_code, calc.effective_year, calc.annual_rate_pct,
            calc.principal_amount, calc.days_held, calc.days_in_month,
            calc.interest_amount,
          ],
        )

        if (insert.rows.length > 0) {
          // Advance the running total. Sum from the accrual log so
          // we get the canonical figure even if security_deposits.
          // interest_accrued was hand-corrected at some point.
          await client.query(
            `UPDATE security_deposits sd
                SET interest_accrued = (
                      SELECT COALESCE(SUM(interest_amount), 0)
                        FROM security_deposit_interest_accruals
                       WHERE security_deposit_id = sd.id
                    ),
                    updated_at = NOW()
              WHERE sd.id = $1`,
            [deposit.id],
          )
          result.accrued_count += 1
          result.total_interest += calc.interest_amount
        } else {
          result.skipped_count += 1  // already accrued for this month
        }

        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      result.error_count += 1
      logger.error({ err: e, ctx: deposit.id }, '[deposit-interest] accrual failed for')
    }
  }

  return result
}

/**
 * Convenience: run accrual for the previous month relative to "now".
 * The cron uses this so the job runs on day 1 and accrues the just-
 * completed month.
 */
export async function runPreviousMonthAccrual(): Promise<MonthlyAccrualResult> {
  const now = new Date()
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return runMonthlyAccrual(isoMonthStart(prevMonth))
}

/**
 * Read accrual history for a single deposit. Used by tenant + landlord
 * dashboard surfaces.
 */
export async function getAccrualHistory(securityDepositId: string) {
  return query<{
    accrual_month:     string
    state_code:        string
    annual_rate_pct:   string
    principal_amount:  string
    days_held:         number
    interest_amount:   string
    created_at:        string
  }>(
    `SELECT accrual_month::text, state_code, annual_rate_pct::text,
            principal_amount::text, days_held, interest_amount::text,
            created_at::text
       FROM security_deposit_interest_accruals
      WHERE security_deposit_id = $1
      ORDER BY accrual_month ASC`,
    [securityDepositId],
  )
}
