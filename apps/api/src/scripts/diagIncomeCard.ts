/**
 * 11/4 — READ-ONLY: do the dashboard income card's three figures add back to
 * its own total, on real data? "Of $X charged: $Y collected, $Z still owed"
 * was built from three separate reads and did not (Nic's $14,391).
 *
 * Writes nothing. DB_NAME=gam npx ts-node src/scripts/diagIncomeCard.ts
 */
import { query } from '../db'
import { collectedRentMtd } from '../lib/rentCollected'

const r2 = (n: number) => Math.round(n * 100) / 100
const d = (n: number) => '$' + r2(n).toFixed(2).padStart(10)

async function main() {
  const cos = await query<{ id: string; name: string }>(
    `SELECT id, business_name AS name FROM landlords
      WHERE books_start_date IS NOT NULL AND is_demo IS NOT TRUE ORDER BY business_name`)
  let bad = 0, checked = 0
  for (const co of cos) {
    for (const month of ['2026-09-15', '2026-10-15', '2026-11-04']) {
      for (const scope of ['all', 'rent'] as const) {
        const c = await collectedRentMtd([co.id], null, { month, scope })
        const b = c.billed
        if (!b.amount && !b.collected && !b.stillOwed) continue
        checked++
        const sum = r2(b.collected + b.clearing + b.stillOwed + b.other)
        const ok = Math.abs(sum - r2(b.amount)) < 0.005
        if (!ok) bad++
        console.log(`${co.name.padEnd(32)} ${month} ${scope.padEnd(5)} charged ${d(b.amount)}`
          + ` = collected ${d(b.collected)} + clearing ${d(b.clearing)} + owed ${d(b.stillOwed)} + other ${d(b.other)}`
          + ` = ${d(sum)} ${ok ? 'TIES' : '*** OFF ***'}`)
      }
    }
  }
  console.log(`\n${checked} income cards checked, ${bad} that do not tie.`)
  process.exit(bad ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
