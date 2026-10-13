/**
 * 10/12 (Nic, Curtis Clabough) — finish the coverage repair the hand script
 * started.
 *
 * scripts/oct12_curtis_full_utility_coverage.ts parked Curtis's open October
 * water ($110.55) under his work trade, but left October's work-trade month
 * priced over the rent alone (basis $450, 25 hours, $18.00 an hour). The month
 * close credits only the basis and then lifts every suspension on the bill, so
 * on November 1 his water would have come straight back as money owed.
 *
 * A change of coverage now widens the month's basis itself
 * (services/workTradeCoverage). This brings any month still waiting for its
 * close into line: an open period nothing has been credited against, whose
 * bill holds MORE parked lines than its basis prices, is re-priced over those
 * lines (basis = the parked lines, hour = basis ÷ the month's hours). It only
 * ever widens; the hours a month asks for are left alone.
 *
 * As of 10/12 the read-only check finds one: Curtis, October (INV-2026-00027),
 * $450.00 → $560.55, $18.00 → $22.42 an hour.
 *
 * Dry run by default (one transaction, rolled back). --apply commits.
 *   cd apps/api && node -r ts-node/register src/scripts/oct12_work_trade_basis_resync.ts [--apply]
 */
import { getClient } from '../db'
import { hourRateFor } from '../services/workTradeSettlement'

async function main() {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { rows } = await c.query<{
      id: string; agreement_id: string; month: string; target: number; basis: number; parked: number; invoice_number: string
    }>(
      `SELECT s.id, s.agreement_id, to_char(s.period_month,'YYYY-MM') AS month,
              s.target_hours::float AS target, s.basis_amount::float AS basis,
              x.parked::float AS parked, i.invoice_number
         FROM work_trade_settlements s
         JOIN invoices i ON i.id = s.invoice_id AND i.status <> 'void'
         CROSS JOIN LATERAL (
           SELECT COALESCE(SUM(p.amount), 0) AS parked FROM payments p
            WHERE p.invoice_id = s.invoice_id AND p.status = 'pending'
              AND p.work_trade_suspended_at IS NOT NULL) x
        WHERE s.status = 'open' AND s.hours_applied = 0 AND s.credit_applied = 0
          AND x.parked > s.basis_amount
        FOR UPDATE OF s`)
    for (const r of rows) {
      const rate = r.target > 0 ? hourRateFor(r.parked, r.target) : 0
      await c.query(
        `UPDATE work_trade_settlements SET basis_amount = $2, hour_rate = $3, updated_at = NOW() WHERE id = $1`,
        [r.id, r.parked.toFixed(2), rate.toFixed(4)])
      console.log(`${r.invoice_number} ${r.month} agreement ${r.agreement_id}: basis $${r.basis.toFixed(2)} → $${r.parked.toFixed(2)}, ` +
        `hour ${r.target > 0 ? `$${(r.basis / r.target).toFixed(2)} → $${rate.toFixed(2)}` : '— (no hours asked)'}`)
    }
    console.log(`${rows.length} work-trade month(s) re-priced.`)
    if (apply) { await c.query('COMMIT'); console.log('APPLIED') }
    else { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back. --apply to commit.') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
