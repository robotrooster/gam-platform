/**
 * 10/19 (Nic): "go ahead and close out September's work trade now. That has
 * nothing to do with anything at this point."
 *
 * September's close ran on 10/01 and settled only one of the nine periods,
 * because the job was reading the hour target frozen onto each September bill
 * instead of asking the agreement — and Nic had turned hour tracking off on
 * 10/01 ("auto complete work trade until I change it back"). So eight months
 * sat open, their rent rows parked, and the $7,998.87 a landlord saw was two
 * months stacked: September's $4,383.11 under October's $3,615.76.
 *
 * The job is fixed. This calls exactly what the 1st-of-the-month cron calls —
 * runWorkTradeSettlement for September — so the month closes the way it should
 * have, rather than waiting for the November 1 close to clear it.
 *
 *   npx ts-node -T src/scripts/oct19_close_september_work_trade.ts           (dry run)
 *   npx ts-node -T src/scripts/oct19_close_september_work_trade.ts --apply
 */
import { query } from '../db'
import { runWorkTradeSettlement } from '../jobs/workTradeSettlement'

const APPLY = process.argv.includes('--apply')
const PERIOD = '2026-09-01'

async function picture(label: string) {
  const periods = await query<any>(`
    SELECT p.name AS property, u.unit_number AS space, ws.status,
           ws.target_hours::float AS target, ws.hours_worked::float AS worked,
           ws.credit_applied::float AS credited, ws.basis_amount::float AS basis
      FROM work_trade_settlements ws
      JOIN work_trade_agreements wta ON wta.id = ws.agreement_id
      LEFT JOIN units u ON u.id = wta.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
     WHERE ws.period_month = $1 AND ws.voided_at IS NULL
     ORDER BY p.name, u.unit_number`, [PERIOD])
  const parked = await query<{ property: string; amt: string; n: string }>(`
    SELECT p.name AS property, SUM(pay.amount)::text AS amt, COUNT(*)::text AS n
      FROM payments pay JOIN units u ON u.id = pay.unit_id JOIN properties p ON p.id = u.property_id
     WHERE pay.work_trade_suspended_at IS NOT NULL AND pay.status IN ('pending', 'failed')
       AND pay.due_date >= $1::date AND pay.due_date < ($1::date + INTERVAL '1 month')
     GROUP BY p.name ORDER BY p.name`, [PERIOD])
  console.log(`\n── ${label} ──`)
  for (const r of periods) {
    console.log(`  ${r.property} ${r.space}: ${r.status}, target ${r.target}h, worked ${r.worked}h, credited $${r.credited.toFixed(2)} of $${r.basis.toFixed(2)}`)
  }
  console.log(`  September rent+utilities still parked on work trade:`)
  if (!parked.length) console.log('    none — September is clear')
  for (const r of parked) console.log(`    ${r.property}: $${Number(r.amt).toFixed(2)} across ${r.n} charges`)
}

async function main() {
  await picture('BEFORE')
  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Pass --apply to close September.')
    process.exit(0)
  }
  console.log(`\nclosing ${PERIOD} …`)
  const result = await runWorkTradeSettlement(PERIOD)
  console.log(`  agreements processed ${result.agreementsProcessed}, periods settled ${result.periodsSettled}, ` +
    `periods billed ${result.periodsBilled}, agreements ended ${result.agreementsEnded}`)
  if (result.errors.length) console.log('  errors:', JSON.stringify(result.errors, null, 2))
  await picture('AFTER')
  console.log('\nAPPLIED')
  process.exit(0)
}

main().catch(e => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
