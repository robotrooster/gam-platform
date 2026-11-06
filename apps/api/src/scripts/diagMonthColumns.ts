/**
 * 11/4 — READ-ONLY diagnostic: does a month's Charged / Received / Owed tie?
 *
 * Nic, 11/4: "the math is not deriving right... rent is showing $15,000
 * received, almost $16,000, but over $18,500 charged, and owed is only $955.
 * And that's almost a $3,000 discrepancy."
 *
 * The columns are NOT built to subtract into each other (incomeBasis MoneyTie:
 * charged = collected + clearing + owed + other, received = forPeriodBills +
 * forEarlierBills + paidAhead + noBill). This prints BOTH ties per month and
 * per line so we can see whether each column adds up to its own parts — which
 * is the actual invariant — or whether something is genuinely wrong.
 *
 * Writes nothing. Run: DB_NAME=gam npx ts-node src/scripts/diagMonthColumns.ts
 */
import { query } from '../db'
import { incomeBoth, moneyViewFrom } from '../services/incomeBasis'

const r2 = (n: number) => Math.round(n * 100) / 100
const d = (n: number) => (n < 0 ? '-' : ' ') + '$' + Math.abs(r2(n)).toFixed(2).padStart(10)

async function main() {
  const cos = await query<{ id: string; name: string }>(
    `SELECT l.id, COALESCE(l.business_name, u.first_name || ' ' || u.last_name, 'Unnamed') AS name
       FROM landlords l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.is_demo IS NOT TRUE AND l.is_system IS NOT TRUE
      ORDER BY name`)
  const months = (process.argv[2] ? [process.argv[2]] : ['2026-08', '2026-09', '2026-10', '2026-11'])

  for (const co of cos) {
    for (const ym of months) {
      const [y, m] = ym.split('-').map(Number)
      const start = `${ym}-01`
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
      const both = await incomeBoth({ landlordIds: [co.id], start, end, propertyIds: null, cutoffs: [] })
      const v = moneyViewFrom(both.billed, both.received, { start, end, label: ym }, both.paidAheadUnused)
      if (!v.charged && !v.received) continue
      console.log('\n' + '='.repeat(96))
      console.log(`${co.name}  ${ym}   source=${v.source ?? 'legacy'}`)
      console.log(`  CHARGED ${d(v.charged)}   = collected ${d(v.tie.charged.collected)} + clearing ${d(v.tie.charged.clearing)} + owed ${d(v.tie.charged.owed)} + other ${d(v.tie.charged.other)}`)
      const cSum = r2(v.tie.charged.collected + v.tie.charged.clearing + v.tie.charged.owed + v.tie.charged.other)
      console.log(`          parts add to ${d(cSum)}  ${Math.abs(cSum - r2(v.charged)) < 0.01 ? 'TIES' : '*** OFF BY ' + d(cSum - v.charged) + ' ***'}`)
      console.log(`  RECEIVED${d(v.received)}  = thisMonthBills ${d(v.tie.received.forPeriodBills)} + earlierBills ${d(v.tie.received.forEarlierBills)} + paidAhead ${d(v.tie.received.paidAhead)} + noBill ${d(v.tie.received.noBill)}`)
      const rSum = r2(v.tie.received.forPeriodBills + v.tie.received.forEarlierBills + v.tie.received.paidAhead + v.tie.received.noBill)
      console.log(`          parts add to ${d(rSum)}  ${Math.abs(rSum - r2(v.received)) < 0.01 ? 'TIES' : '*** OFF BY ' + d(rSum - v.received) + ' ***'}`)
      console.log(`  OWED    ${d(v.owed)}   (charged - received would be ${d(v.charged - v.received)} — NOT the same question)`)
      console.log(`  lines:`)
      let lc = 0, lr = 0, lo = 0
      for (const L of v.lines) {
        console.log(`    ${L.label.padEnd(30)} charged ${d(L.charged)}  received ${d(L.received)}  owed ${d(L.owed)}   c-r=${d(L.charged - L.received)}`)
        if (L.parts) {
          const s = r2(L.parts.collected + L.parts.clearing + L.parts.owed + L.parts.other)
          console.log(`    ${''.padEnd(30)}   of charged: collected ${d(L.parts.collected)} + clearing ${d(L.parts.clearing)} + owed@end ${d(L.parts.owed)} + other ${d(L.parts.other)} = ${d(s)} ${Math.abs(s - r2(L.charged)) < 0.005 ? 'TIES' : '*** OFF ***'}`)
        } else console.log(`    ${''.padEnd(30)}   of charged: NO PARTS`)
        lc = r2(lc + L.charged); lr = r2(lr + L.received); lo = r2(lo + L.owed)
      }
      console.log(`    ${'LINES ADD TO'.padEnd(30)} charged ${d(lc)}  received ${d(lr)}  owed ${d(lo)}`)
      console.log(`    ${'vs totals'.padEnd(30)} charged ${d(v.charged)}  received ${d(v.received)}  owed ${d(v.owed)}  ${Math.abs(lc - v.charged) < 0.01 && Math.abs(lr - v.received) < 0.01 && Math.abs(lo - v.owed) < 0.01 ? 'LINES TIE' : '*** LINES DO NOT TIE ***'}`)
      if (v.beside.length) console.log(`  beside: ` + v.beside.map(b => `${b.label} ${d(b.amount).trim()}`).join(' | '))
      for (const t of v.tieText) console.log(`  » ${t}`)
    }
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
