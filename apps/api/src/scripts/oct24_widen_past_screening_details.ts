/**
 * 10/24 (Nic) — THE SCREENINGS ALREADY TAKEN GET THE FULL DETAIL TOO.
 *
 *   "Are you going to make this retroactive to the past screenings so that the
 *    ones at Mountain View, I can view in my browser to see the rendering?
 *    Because I cannot see the Mattoon property."
 *
 * The widened summary (services/backgroundProvider) is written when a report is
 * FETCHED, so on its own it would only ever reach screenings taken from today
 * forward — and the only one of those is at a property Nic has no access to.
 * Every report GAM has ever pulled is archived whole (S639
 * background_check_reports), so the detail is already on disk and this rebuilds
 * the summary from it.
 *
 * NOTHING IS RE-FETCHED. Checkr is not called, no order is placed, and nobody
 * is charged — this only re-reads what was already stored. That matters: a
 * re-screen would cost $34.99 a head to answer a rendering question.
 *
 * ONLY `details` IS REWRITTEN. The verdict, the per-product statuses, the
 * report id and the fetch time in each stored summary were already right; the
 * narrowing only ever applied to the detail under each product. Anything else
 * in the summary is left exactly as it was.
 *
 * The same `landlordVisibleDetail` the live path uses, so the identity document
 * is held back here too and the two cannot drift.
 */
import { query, queryOne } from '../db'
import { landlordVisibleDetail } from '../services/backgroundProvider'

const PRODUCTS = [
  'criminal_history', 'credit_report', 'eviction_history',
  'identity_verification', 'income_verification',
  'sex_offender_registry', 'global_watchlist',
] as const

;(async () => {
  const apply = process.argv.includes('--apply')
  const checks = await query<any>(`
    SELECT b.id, b.first_name, b.last_name, b.report_summary,
           COALESCE(p.name, '(no property)') AS property
      FROM background_checks b LEFT JOIN properties p ON p.id = b.property_id
     WHERE b.report_summary IS NOT NULL
     ORDER BY b.created_at`)

  console.log(`\n  ${apply ? 'REBUILDING' : 'DRY RUN'} — ${checks.length} screening(s) with a stored summary\n`)
  let changed = 0
  for (const c of checks) {
    const archived = await queryOne<{ payload: any }>(
      `SELECT payload FROM background_check_reports
        WHERE background_check_id = $1 AND source = 'fetch'
        ORDER BY received_at DESC LIMIT 1`, [c.id])
    const who = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.id
    if (!archived?.payload) {
      console.log(`  —  ${who} (${c.property}): no archived report to rebuild from, left alone`)
      continue
    }
    const details: Record<string, unknown> = {}
    for (const p of PRODUCTS) {
      const item = archived.payload[p]
      if (item && typeof item === 'object') details[p] = landlordVisibleDetail(item)
    }
    const before = Object.keys(c.report_summary?.details ?? {})
      .reduce((n, k) => n + Object.keys(c.report_summary.details[k] ?? {}).length, 0)
    const after = Object.keys(details).reduce((n, k) => n + Object.keys((details as any)[k] ?? {}).length, 0)
    const credit: any = (details as any).credit_report ?? {}
    const summary = credit.credit_summary ?? {}
    console.log(`  ${after > before ? '+' : ' '}  ${who} (${c.property}): ${before} → ${after} fields`
      + (summary.on_time_payment_rate != null
          ? `  [on-time ${summary.on_time_payment_rate}%`
            + (summary.credit_utilization?.rate != null ? `, utilization ${summary.credit_utilization.rate}%` : '')
            + (credit.credit_score != null ? `, score ${credit.credit_score}` : '') + ']'
          : ''))
    if (after > before) changed++
    if (apply) {
      await query(
        `UPDATE background_checks
            SET report_summary = jsonb_set(report_summary, '{details}', $2::jsonb), updated_at = NOW()
          WHERE id = $1`, [c.id, JSON.stringify(details)])
    }
  }
  console.log(`\n  ${changed} would gain detail.${apply ? ' Written.' : ' Re-run with --apply to write.'}\n`)
  process.exit(0)
})().catch(e => { console.error(`\n  ${e?.message || e}\n`); process.exit(1) })
