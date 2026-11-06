/**
 * 11/4 — READ-ONLY: do the Charged buckets tie on EVERY slice a report can be
 * cut into? The monthly property report builds one moneyViewFrom per property
 * (and per income group inside it), so a figure that only ties company-wide
 * would still reach a landlord's emailed PDF wrong.
 *
 * Writes nothing. DB_NAME=gam npx ts-node src/scripts/diagPartsEveryProperty.ts
 */
import { query } from '../db'
import { incomeBoth, moneyViewFrom } from '../services/incomeBasis'

const r2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const cos = await query<{ id: string; name: string }>(
    `SELECT id, business_name AS name FROM landlords
      WHERE books_start_date IS NOT NULL AND is_demo IS NOT TRUE ORDER BY business_name`)
  let checked = 0, bad = 0
  for (const co of cos) {
    const props = await query<{ id: string; name: string }>(
      `SELECT id, name FROM properties WHERE landlord_id = $1 ORDER BY name`, [co.id])
    for (const ym of ['2026-08', '2026-09', '2026-10', '2026-11']) {
      const [y, m] = ym.split('-').map(Number)
      const start = `${ym}-01`
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
      for (const scope of [{ id: null as string | null, name: 'WHOLE COMPANY' }, ...props]) {
        const both = await incomeBoth({
          landlordIds: [co.id], start, end, propertyIds: scope.id ? [scope.id] : null, cutoffs: [],
        })
        const v = moneyViewFrom(both.billed, both.received, { start, end, label: ym }, both.paidAheadUnused)
        if (!v.charged && !v.received) continue
        checked++
        const t = v.tie.charged
        const sum = r2(t.collected + t.clearing + t.owed + t.other)
        if (Math.abs(sum - r2(v.charged)) >= 0.005) {
          bad++
          console.log(`OFF  ${co.name} / ${scope.name} / ${ym}: parts ${sum} vs charged ${r2(v.charged)}`)
        }
        for (const row of [...v.lines, ...v.categories, ...v.uncategorized]) {
          if (!row.parts) continue
          const p = row.parts
          const s = r2(p.collected + p.clearing + p.owed + p.other)
          if (Math.abs(s - r2(row.charged)) >= 0.005) {
            bad++
            console.log(`OFF  ${co.name} / ${scope.name} / ${ym} / ${row.label}: parts ${s} vs charged ${r2(row.charged)}`)
          }
        }
      }
    }
  }
  console.log(`\n${checked} slices checked (company-wide and per property, four months), ${bad} that do not tie.`)
  process.exit(bad ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
