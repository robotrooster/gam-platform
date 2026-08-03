/**
 * S565: Economic-nexus monitor.
 *
 * Two responsibilities:
 *   1. recomputeNexusTally() — nightly job. Sums GAM's OWN revenue, attributed
 *      by CUSTOMER state, into nexus_revenue_tally (current + prior calendar
 *      year). Nic's S564 rule: count conservatively to register EARLY.
 *   2. getNexusDashboard() — read model for the admin dashboard: each state's
 *      measured revenue vs its economic-nexus threshold + registration status.
 *
 * ⚠️ MONITORING ONLY. Crossing a threshold PROMPTS Nic to register; it never
 * collects tax. Tax collection is separately gated on state_tax_registrations
 * (see services/... the screening fee path + the S565 tax migration).
 *
 * Revenue sources (each → a customer state). See the tally migration for the
 * full rationale on what is counted and what is excluded (rent, POS sales,
 * payouts, and the legacy monthly_fee_accruals table are all excluded).
 */
import { query } from '../db'
import { logger } from '../lib/logger'

export type NexusStatus =
  | 'registered'    // GAM has registered here — collection is live
  | 'crossed'       // measured revenue ≥ threshold, not yet registered → ACT
  | 'approaching'   // measured revenue ≥ warn line (default 80%) but < threshold
  | 'under'         // comfortably below
  | 'no_threshold'  // no sales tax / no economic-nexus regime (never register)

export interface NexusStateRow {
  stateCode: string
  revenueCurrentYtd: number
  revenuePriorYear: number
  measureUsd: number          // max(current YTD, prior full year) — conservative
  txnCurrentYtd: number
  txnPriorYear: number
  measureTxn: number
  thresholdUsd: number | null
  txnThreshold: number | null
  countRule: string
  taxable: boolean            // is a screening service taxable here (from tax catalog)?
  registered: boolean
  registeredDate: string | null
  pctOfThreshold: number | null   // measureUsd / thresholdUsd, 0..>1
  status: NexusStatus
}

// Default warn line: flag a state "approaching" once measured revenue reaches
// this fraction of the threshold. Configurable later if Nic wants a per-state knob.
export const NEXUS_WARN_FRACTION = 0.8

/**
 * Recompute the nexus revenue tally for the current + prior calendar year.
 * Full overwrite per (state, year). Idempotent — safe to run repeatedly.
 */
export async function recomputeNexusTally(nowYear?: number): Promise<{ years: number[]; rows: number }> {
  const currentYear = nowYear ?? new Date().getFullYear()
  const priorYear = currentYear - 1
  const years = [priorYear, currentYear]

  // One UNION ALL over every GAM-own-revenue source, each yielding
  // (state_code, period_year, amount). Grouped + summed below. LEFT JOINs +
  // the WHERE state filter drop any row whose customer state can't be resolved
  // (no silent mis-attribution to the wrong state).
  const sql = `
    WITH revenue AS (
      -- Platform fee (SaaS subscription) — by property state
      SELECT upper(p.state) AS state_code,
             EXTRACT(YEAR FROM pfa.accrual_month)::int AS period_year,
             pfa.total_amount AS amount
        FROM platform_fee_accruals pfa
        JOIN properties p ON p.id = pfa.property_id
       WHERE p.state IS NOT NULL AND length(trim(p.state)) = 2

      UNION ALL
      -- Screening sales — by applicant state (gross sale = standard_total)
      SELECT upper(sfa.state) AS state_code,
             EXTRACT(YEAR FROM sfa.accrual_month)::int AS period_year,
             sfa.standard_total AS amount
        FROM screening_fee_accruals sfa
       WHERE sfa.state IS NOT NULL AND length(trim(sfa.state)) = 2

      UNION ALL
      -- Business platform fee — by business state; month is 'YYYY-MM' text
      SELECT upper(b.state) AS state_code,
             left(bpfa.month, 4)::int AS period_year,
             bpfa.amount AS amount
        FROM business_platform_fee_accruals bpfa
        JOIN businesses b ON b.id = bpfa.business_id
       WHERE b.state IS NOT NULL AND length(trim(b.state)) = 2
         AND bpfa.month ~ '^[0-9]{4}-[0-9]{2}$'

      UNION ALL
      -- FlexPay subscription fees — by unit/property state
      SELECT upper(p.state) AS state_code,
             EXTRACT(YEAR FROM fa.created_at)::int AS period_year,
             fa.tenant_fee_amount AS amount
        FROM flexpay_advances fa
        JOIN units u ON u.id = fa.unit_id
        JOIN properties p ON p.id = u.property_id
       WHERE p.state IS NOT NULL AND length(trim(p.state)) = 2
    )
    SELECT state_code, period_year,
           COALESCE(SUM(amount), 0)::numeric(14,2) AS revenue_usd,
           COUNT(*)::int AS txn_count
      FROM revenue
     WHERE period_year = ANY($1)
     GROUP BY state_code, period_year
  `
  const agg = await query<{ state_code: string; period_year: number; revenue_usd: string; txn_count: number }>(sql, [years])

  // Overwrite the tally for these years. Delete-then-insert inside one statement
  // set keeps it simple; a state that dropped to $0 this run gets its row cleared.
  await query('DELETE FROM nexus_revenue_tally WHERE period_year = ANY($1)', [years])
  for (const r of agg) {
    await query(
      `INSERT INTO nexus_revenue_tally (state_code, period_year, revenue_usd, txn_count, computed_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [r.state_code, r.period_year, r.revenue_usd, r.txn_count]
    )
  }
  logger.info(`[nexusMonitor] tally recomputed for ${years.join(', ')} — ${agg.length} state-year rows`)
  return { years, rows: agg.length }
}

/**
 * Dashboard read model: every state with a threshold, plus any state that has
 * accrued revenue, joined against thresholds + tax catalog + registrations.
 */
export async function getNexusDashboard(nowYear?: number): Promise<{
  warnFraction: number
  computedAt: string | null
  states: NexusStateRow[]
  summary: { crossed: number; approaching: number; registered: number; under: number }
}> {
  const currentYear = nowYear ?? new Date().getFullYear()
  const priorYear = currentYear - 1

  const rows = await query<any>(
    `
    WITH cur AS (
      SELECT state_code, revenue_usd, txn_count FROM nexus_revenue_tally WHERE period_year = $1
    ),
    pri AS (
      SELECT state_code, revenue_usd, txn_count FROM nexus_revenue_tally WHERE period_year = $2
    )
    SELECT
      t.state_code,
      t.revenue_threshold_usd,
      t.txn_threshold,
      t.count_rule,
      COALESCE(tax.taxable, false) AS taxable,
      COALESCE(reg.registered, false) AS registered,
      reg.registered_date,
      COALESCE(cur.revenue_usd, 0)::numeric AS rev_current,
      COALESCE(pri.revenue_usd, 0)::numeric AS rev_prior,
      COALESCE(cur.txn_count, 0) AS txn_current,
      COALESCE(pri.txn_count, 0) AS txn_prior
    FROM state_nexus_thresholds t
    LEFT JOIN state_screening_tax_rates tax
      ON tax.state_code = t.state_code AND tax.effective_year = t.effective_year
    LEFT JOIN state_tax_registrations reg ON reg.state_code = t.state_code
    LEFT JOIN cur ON cur.state_code = t.state_code
    LEFT JOIN pri ON pri.state_code = t.state_code
    WHERE t.effective_year = $3
    ORDER BY t.state_code
    `,
    [currentYear, priorYear, currentYear]
  )

  let computedAt: string | null = null
  const ca = await query<{ max: string | null }>('SELECT MAX(computed_at) AS max FROM nexus_revenue_tally')
  if (ca[0]?.max) computedAt = ca[0].max

  const states: NexusStateRow[] = rows.map((r) => {
    const revenueCurrentYtd = parseFloat(r.rev_current)
    const revenuePriorYear = parseFloat(r.rev_prior)
    const measureUsd = Math.max(revenueCurrentYtd, revenuePriorYear)
    const measureTxn = Math.max(r.txn_current, r.txn_prior)
    const thresholdUsd = r.revenue_threshold_usd != null ? parseFloat(r.revenue_threshold_usd) : null
    const txnThreshold = r.txn_threshold != null ? Number(r.txn_threshold) : null
    const registered = !!r.registered
    const pctOfThreshold = thresholdUsd && thresholdUsd > 0 ? measureUsd / thresholdUsd : null

    // Crossing logic honors count_rule: 'and' needs both revenue AND txn over;
    // 'or' either; 'revenue_only' ignores txn.
    const revOver = thresholdUsd != null && measureUsd >= thresholdUsd
    const txnOver = txnThreshold != null && measureTxn >= txnThreshold
    let crossed = false
    if (thresholdUsd != null) {
      if (r.count_rule === 'and') crossed = revOver && txnOver
      else if (r.count_rule === 'revenue_only') crossed = revOver
      else crossed = revOver || txnOver // 'or'
    }

    let status: NexusStatus
    if (thresholdUsd == null) status = 'no_threshold'
    else if (registered) status = 'registered'
    else if (crossed) status = 'crossed'
    else if (pctOfThreshold != null && pctOfThreshold >= NEXUS_WARN_FRACTION) status = 'approaching'
    else status = 'under'

    return {
      stateCode: r.state_code,
      revenueCurrentYtd,
      revenuePriorYear,
      measureUsd,
      txnCurrentYtd: r.txn_current,
      txnPriorYear: r.txn_prior,
      measureTxn,
      thresholdUsd,
      txnThreshold,
      countRule: r.count_rule,
      taxable: !!r.taxable,
      registered,
      registeredDate: r.registered_date ? String(r.registered_date).slice(0, 10) : null,
      pctOfThreshold,
      status,
    }
  })

  const summary = {
    crossed: states.filter((s) => s.status === 'crossed').length,
    approaching: states.filter((s) => s.status === 'approaching').length,
    registered: states.filter((s) => s.status === 'registered').length,
    under: states.filter((s) => s.status === 'under').length,
  }

  return { warnFraction: NEXUS_WARN_FRACTION, computedAt, states, summary }
}

/**
 * Flip a state's registration status (admin action). source='manual'.
 * Registering here turns ON tax collection for that state (subject to the tax
 * catalog's taxable flag + rate). Upserts state_tax_registrations.
 */
export async function setStateRegistration(
  stateCode: string,
  registered: boolean,
  opts?: { registeredDate?: string | null; notes?: string | null; source?: 'manual' | 'nexus_auto' }
): Promise<void> {
  const st = stateCode.toUpperCase()
  if (st.length !== 2) throw new Error('Invalid state code')
  const source = opts?.source ?? 'manual'
  const regDate = registered ? (opts?.registeredDate ?? new Date().toISOString().slice(0, 10)) : null
  await query(
    `INSERT INTO state_tax_registrations (state_code, registered, registered_date, source, notes, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (state_code) DO UPDATE
       SET registered = EXCLUDED.registered,
           registered_date = EXCLUDED.registered_date,
           source = EXCLUDED.source,
           notes = COALESCE(EXCLUDED.notes, state_tax_registrations.notes),
           updated_at = NOW()`,
    [st, registered, regDate, source, opts?.notes ?? null]
  )
  logger.info(`[nexusMonitor] state ${st} registration set to ${registered} (source=${source})`)
}
