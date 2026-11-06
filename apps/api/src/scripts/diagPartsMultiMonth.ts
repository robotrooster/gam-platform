/**
 * 11/4 — READ-ONLY: the case a one-month check CANNOT see.
 *
 * /reports/summary reads TWELVE months in one go and slices the facts back
 * into months (routes/reports monthView, incomeBasis byMonth); the landlord
 * dashboard reads six. A fact that carries a whole group's amount on one day
 * lands entirely in that month, so a figure that ties for every single-month
 * read can still be wrong on every month of the long read. That is exactly
 * what happened: pooled register sales, stays and other income moved
 * $1,100.96 into September 2026.
 *
 * Writes nothing. DB_NAME=gam npx ts-node src/scripts/diagPartsMultiMonth.ts
 */
import { query } from '../db'
import { incomeBoth, moneyViewFrom, byMonth } from '../services/incomeBasis'

const r2 = (n: number) => Math.round(n * 100) / 100
const d = (n: number) => (n < 0 ? '-' : ' ') + '$' + Math.abs(r2(n)).toFixed(2).padStart(10)

async function main() {
  const cos = await query<{ id: string; name: string }>(
    `SELECT id, business_name AS name FROM landlords
      WHERE books_start_date IS NOT NULL AND is_demo IS NOT TRUE ORDER BY business_name`)
  let bad = 0, checked = 0
  // The two windows production actually reads: twelve months and six.
  for (const [label, start, end] of [
    ['12-month read', '2025-12-01', '2026-11-30'],
    ['6-month read', '2026-06-01', '2026-11-30'],
  ] as const) {
    for (const co of cos) {
      const both = await incomeBoth({ landlordIds: [co.id], start, end, propertyIds: null, cutoffs: [] })
      const bx = byMonth(both.billed), rx = byMonth(both.received)
      for (const ym of [...new Set([...bx.keys(), ...rx.keys()])].sort()) {
        const first = `${ym}-01`
        const [y, m] = ym.split('-').map(Number)
        const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
        const v = moneyViewFrom(bx.get(ym) ?? [], rx.get(ym) ?? [], { start: first, end: last, label: ym })
        if (!v.charged && !v.received) continue
        checked++
        const t = v.tie.charged
        const sum = r2(t.collected + t.clearing + t.owed + t.other)
        if (Math.abs(sum - r2(v.charged)) >= 0.005) {
          bad++
          console.log(`OFF  ${label}  ${co.name} ${ym}: charged ${d(v.charged)} vs parts ${d(sum)}  (${d(sum - v.charged)})`)
        }
        for (const row of [...v.lines, ...v.categories, ...v.uncategorized]) {
          if (!row.parts) continue
          const p = row.parts
          const s = r2(p.collected + p.clearing + p.owed + p.other)
          if (Math.abs(s - r2(row.charged)) >= 0.005) {
            bad++
            console.log(`OFF  ${label}  ${co.name} ${ym} / ${row.label}: charged ${d(row.charged)} vs parts ${d(s)}`)
          }
        }
      }
    }
  }
  console.log(`\n${checked} month slices out of long reads checked, ${bad} that do not tie.`)
  process.exit(bad ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
