/**
 * 10/31 (Nic) — LOT 8's OCTOBER READ WAS A 0 THAT MEANT "NOBODY WAS HERE".
 *
 *   "just make October's reading show 10 to match it for number 8. It could
 *    have been somebody lazy that knows the unit is empty and just put 0
 *    because there's no... They're not thinking about it as a meter read.
 *    They're thinking, hey, there was no usage because nobody was here."
 *
 * Country Acres Lot 8 has never had a tenant. Its dial read 10 in August and 10
 * again on 9/30. On 10/28 somebody typed 0 — not the number on the face, but
 * their answer to a question nobody asked them: did anyone use any water. The
 * dial had not moved.
 *
 * GAM then did the only safe thing with it. A read below the one before it is
 * either a wrap past the end of the dial or a mistake, and (100,000 − 10) + 0 is
 * 99,990 turns — 9,999,000 gallons on a five-digit face — which is more than
 * half the dial's range, so it refused to call it usage, refused to bill it and
 * flagged it. Correct, and on a lot with no tenant there was never anybody to
 * bill. But the flag then held the other ten lots' water bills for the month.
 *
 * This restores the reading to what the dial actually said: 10, the same as
 * September, which is zero usage. Done the way the review window does it
 * (routes/utility POST /readings/:id/resolve-review), so the flag clears, the
 * cycle's stale unbilled rows for the meter are dropped, and the run is offered
 * the chance to finish — it will not, because Lots 17 and 21 are still flagged,
 * which is the point of running this through the same path instead of editing
 * the row behind it.
 *
 * Run once:  npx ts-node src/scripts/oct31_lot8_zero_read_correction.ts
 */
import { query, queryOne, db } from '../db'
import { settleFlaggedOnRun } from '../services/utilityReadingRuns'

const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'   // Country Acres - Mattoon
const METER_LABEL = 'Water — Lot 8'
const CYCLE = '2026-10-01'
const CORRECT_TO = 10

async function main() {
  const db = await queryOne<{ name: string }>(`SELECT current_database() AS name`)
  if (db?.name !== 'gam') throw new Error(`refusing to run against ${db?.name} — this correction is for the live database`)

  const reading = await queryOne<any>(
    `SELECT r.id, r.reading_value::text AS value, r.needs_review, r.reason, m.label, m.digits
       FROM utility_meter_readings r
       JOIN utility_meters m ON m.id = r.meter_id
      WHERE m.property_id = $1 AND m.label = $2
        AND r.billing_cycle_month = $3::date AND r.reason = 'monthly_cycle'`,
    [PROPERTY, METER_LABEL, CYCLE])
  if (!reading) throw new Error(`no October monthly read found for ${METER_LABEL}`)
  if (!reading.needs_review) {
    console.log(`${reading.label} is not flagged (reads ${reading.value}) — nothing to do.`)
    return
  }
  console.log(`${reading.label}: October read is ${reading.value}, flagged. Correcting to ${CORRECT_TO}.`)

  // Exactly what resolve-review does for a corrected monthly read.
  const updated = await queryOne<any>(
    `UPDATE utility_meter_readings
        SET reading_value = $2, needs_review = FALSE, is_rollover = FALSE,
            review_note = 'Corrected after double-check'
      WHERE id = $1 RETURNING reading_value::text AS value, needs_review`,
    [reading.id, CORRECT_TO])

  const dropped = await query(
    `DELETE FROM utility_bills
      WHERE meter_id = (SELECT meter_id FROM utility_meter_readings WHERE id = $1)
        AND billing_cycle_month = $2::date AND payment_id IS NULL
        AND voided_at IS NULL AND status <> 'void'`,
    [reading.id, CYCLE])

  const run = await settleFlaggedOnRun(PROPERTY, CYCLE, (await queryOne<{ id: string }>(
    `SELECT u.id FROM landlords l JOIN users u ON u.id = l.user_id
      JOIN properties p ON p.landlord_id = l.id WHERE p.id = $1`, [PROPERTY]))!.id)

  const stillFlagged = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM utility_meter_readings r JOIN utility_meters m ON m.id = r.meter_id
      WHERE m.property_id = $1 AND r.billing_cycle_month = $2::date
        AND r.reason = 'monthly_cycle' AND r.needs_review`, [PROPERTY, CYCLE])

  console.log(`  read now ${updated.value}, flagged ${updated.needs_review}`)
  console.log(`  stale unbilled rows dropped for this meter: ${dropped.length}`)
  console.log(`  still flagged on the October cycle: ${stillFlagged?.n}`)
  console.log(`  run status: ${run ? run.status : 'left waiting (flagged reads remain)'}`)
}

main().then(() => db.end()).catch(e => { console.error(e); db.end(); process.exit(1) })
