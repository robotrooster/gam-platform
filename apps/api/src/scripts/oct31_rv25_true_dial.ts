/**
 * 10/31 (Nic) — PUT RV 25's DIAL SERIES BACK TO WHAT THE DIAL SAYS.
 *
 *   "It's defensible to go by what's on the meter. If the meter turned
 *    backwards, that's the number we're going to go off of."
 *
 * RV 25's meter has counted DOWN since 2022 — through a six-month vacancy and
 * through a change of resident. Nic's own series: 19566, 19277, 19040, 18873,
 * 18466, (vacant), 18291, 18291 ... 14183, 14064, 13774, 13739, 13194, and
 * 13194 is exactly where GAM's baseline picks up. A dial that has descended for
 * three years straight is wired backwards, not creeping: the movement is real
 * usage, and the current resident's eight months run 35 to 545 kWh, mean 314.
 *
 * GAM's stored series is not the dial, though. Two reads were re-keyed upward to
 * force it to climb — +1,000 and +2,000 — so GAM would measure October against
 * 14336 and bill 2,187 kWh instead of the 187 the dial actually moved.
 *
 * This writes the two re-keyed reads back to the figures the journal says were
 * entered at the meter, so the series is the dial again and October computes
 * 187 kWh (|12149 - 12336|).
 *
 * THE TWO PAID BILLS ARE NOT TOUCHED. 467 kWh/$98.07 and 675 kWh/$141.75 were
 * billed and settled; that money moved and the record of it stands. What they
 * over-collected (284 kWh, $59.64 — see below) is a credit decision for Nic,
 * not something a script applies.
 *
 * DOES NOT settle RV 37, the last flagged read at the property. Mountain View
 * has no bill-review step, so settling the last one completes the run and sends
 * every resident's October bill on the spot.
 *
 * Run once:  npx ts-node src/scripts/oct31_rv25_true_dial.ts
 */
import { query, queryOne, db } from '../db'

const PROPERTY_NAME = 'Mountain View RV Ranch'
const METER_LABEL = 'RV 25 electric'
const CYCLE = '2026-10-01'
/** read date -> what the dial actually said, per audit_row_changes. */
const TRUE_DIAL: Record<string, number> = { '2026-09-02': 12661, '2026-09-30': 12336 }

async function main() {
  const dbname = await queryOne<{ name: string }>(`SELECT current_database() AS name`)
  if (dbname?.name !== 'gam') throw new Error(`refusing to run against ${dbname?.name}`)

  const m = await queryOne<{ id: string; property_id: string }>(`
    SELECT m.id, m.property_id FROM utility_meters m JOIN properties p ON p.id = m.property_id
     WHERE p.name = $1 AND m.label = $2`, [PROPERTY_NAME, METER_LABEL])
  if (!m) throw new Error(`${METER_LABEL} not found`)

  for (const [day, dial] of Object.entries(TRUE_DIAL)) {
    const r = await queryOne<{ id: string; reading_value: string }>(
      `SELECT id, reading_value::text AS reading_value FROM utility_meter_readings
        WHERE meter_id = $1 AND reading_date = $2::date AND reason = 'monthly_cycle'`, [m.id, day])
    if (!r) { console.log(`  ${day}: no monthly read found — skipped`); continue }
    if (Number(r.reading_value) === dial) { console.log(`  ${day}: already ${dial}`); continue }
    await query(
      `UPDATE utility_meter_readings
          SET reading_value = $2,
              review_note = 'Restored 10/31 to the figure entered at the meter. The dial runs backwards '
                         || '(descending since 2022); the earlier value was re-keyed upward by hand to force '
                         || 'the series to climb. The bill already issued for this cycle is unchanged.'
        WHERE id = $1`, [r.id, dial])
    console.log(`  ${day}: ${r.reading_value} -> ${dial} (restored)`)
  }

  const flagged = await queryOne<{ id: string }>(
    `SELECT id FROM utility_meter_readings
      WHERE meter_id = $1 AND billing_cycle_month = $2::date AND reason = 'monthly_cycle' AND needs_review`,
    [m.id, CYCLE])
  if (flagged) {
    await query(
      `UPDATE utility_meter_readings
          SET needs_review = FALSE, is_rollover = FALSE,
              review_note = 'Settled 10/31: the dial runs backwards and that movement is the usage. '
                         || '12336 -> 12149 = 187 kWh.'
        WHERE id = $1`, [flagged.id])
    console.log('  October flag settled — 187 kWh will bill.')
  }

  const left = await queryOne<{ n: number; which: string }>(`
    SELECT COUNT(*)::int AS n, string_agg(m.label, ', ' ORDER BY m.label) AS which
      FROM utility_meter_readings r JOIN utility_meters m ON m.id = r.meter_id
     WHERE m.property_id = $1 AND r.needs_review`, [m.property_id])
  const run = await queryOne<{ status: string }>(
    `SELECT status FROM utility_reading_runs WHERE property_id = $1 AND billing_cycle_month = $2::date
      ORDER BY created_at DESC LIMIT 1`, [m.property_id, CYCLE])
  console.log(`\nStill flagged: ${left?.n} (${left?.which ?? 'none'}).  Run: ${run?.status} — no bills sent.`)
}

main().then(() => db.end()).catch(e => { console.error(e); db.end(); process.exit(1) })
