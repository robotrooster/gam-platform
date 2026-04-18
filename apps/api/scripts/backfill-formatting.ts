// Backfill cleanup: apply formatters to existing properties & units.
// Usage:
//   ts-node scripts/backfill-formatting.ts            # dry run
//   ts-node scripts/backfill-formatting.ts --commit   # write changes
import { db } from '../src/db'
import {
  formatName, formatStreet, formatStreet2, formatCity, formatState, formatZip, formatUnitNumber,
} from '../src/lib/format'

const COMMIT = process.argv.includes('--commit')

async function main() {
  console.log(COMMIT ? '✎ COMMIT MODE — writing changes' : '👁  DRY RUN — no changes will be written')
  console.log('')

  // ── Properties ───────────────────────────────────────
  const props = (await db.query(`SELECT id, name, street1, street2, city, state, zip FROM properties ORDER BY created_at`)).rows
  let propChanges = 0
  for (const p of props) {
    const next = {
      name:    formatName(p.name || ''),
      street1: formatStreet(p.street1 || ''),
      street2: p.street2 ? formatStreet2(p.street2) : p.street2,
      city:    formatCity(p.city || ''),
      state:   formatState(p.state || ''),
      zip:     formatZip(p.zip || ''),
    }
    const diffs: string[] = []
    for (const k of ['name','street1','street2','city','state','zip'] as const) {
      if ((p[k] ?? null) !== (next[k] ?? null) && !(p[k] == null && next[k] == null)) {
        diffs.push(`${k}: ${JSON.stringify(p[k])} → ${JSON.stringify(next[k])}`)
      }
    }
    if (diffs.length === 0) continue
    propChanges++
    console.log(`PROPERTY ${p.id}`)
    for (const d of diffs) console.log(`  ${d}`)
    if (COMMIT) {
      await db.query(
        `UPDATE properties SET name=$1, street1=$2, street2=$3, city=$4, state=$5, zip=$6, updated_at=NOW() WHERE id=$7`,
        [next.name, next.street1, next.street2 ?? null, next.city, next.state, next.zip, p.id]
      )
    }
  }

  // ── Units ───────────────────────────────────────────
  const units = (await db.query(`SELECT id, property_id, unit_number FROM units ORDER BY property_id, unit_number`)).rows
  let unitChanges = 0
  const seenPerProp: Record<string, Set<string>> = {}
  for (const u of units) {
    const next = formatUnitNumber(u.unit_number || '')
    if (next === u.unit_number) continue
    if (!seenPerProp[u.property_id]) {
      const existing = (await db.query(`SELECT unit_number FROM units WHERE property_id=$1`, [u.property_id])).rows
      seenPerProp[u.property_id] = new Set(existing.map((r: any) => r.unit_number))
    }
    const otherRowsAfter = [...seenPerProp[u.property_id]].filter(n => n !== u.unit_number).map(n => formatUnitNumber(n))
    const wouldCollide = otherRowsAfter.includes(next)
    unitChanges++
    console.log(`UNIT ${u.id} (prop ${u.property_id})`)
    console.log(`  unit_number: ${JSON.stringify(u.unit_number)} → ${JSON.stringify(next)}${wouldCollide ? ' ⚠ COLLISION — skipping' : ''}`)
    if (COMMIT && !wouldCollide) {
      await db.query(`UPDATE units SET unit_number=$1, updated_at=NOW() WHERE id=$2`, [next, u.id])
    }
  }

  console.log('')
  console.log(`Summary: ${propChanges} properties, ${unitChanges} units ${COMMIT ? 'updated' : 'would change'}`)
  await db.end()
}

main().catch(e => { console.error(e); process.exit(1) })
