/**
 * 10/31 (Nic) — RV 39's METER IS DEAD; BILL WHAT THE SPACE ACTUALLY USES.
 *
 *   "I have some previous reads for RV space 39, going back quite some time...
 *    50170, then 50971, then 51699, then 52536, then 52885, and then 54100, and
 *    then it's basically been hovering and fluctuating right around that."
 *
 * Those six reads are five months of real usage: 801, 728, 837, 349 and 1,215
 * kWh — mean 786, median 801, which is the "between 700 and 800" he bills her
 * at by hand. The dial died at 54100 and every read GAM holds is jitter around
 * it (54199, 54099, 54000, 54099 — movements of -100, -99 and +99).
 *
 * Left alone she would bill 1,901 kWh for October, because GAM compares against
 * the 56000 he keyed in last month (54000 + 2,000) to force the series upward.
 * Estimated off the park she would bill 115-166 kWh, the median of a park whose
 * other spaces use a fifth of what she does. Neither is her usage.
 *
 * So: her figure goes on the meter, the meter is marked not-reading, and the
 * October flag is settled. The estimate path then bills 786 kWh = $165.06.
 *
 * DELIBERATELY LEAVES RV 25 AND RV 37 FLAGGED. Mountain View has no bill-review
 * step (landlords.review_utility_bills is FALSE), so settling the LAST flagged
 * read completes the run and sends every resident's bill immediately. That is
 * Nic's to trigger, not a script's.
 *
 * The padded history (54876, 56000) is left exactly as it stands. Those two
 * cycles are billed and paid; rewriting them would rewrite money that moved.
 *
 * Run once:  npx ts-node src/scripts/oct31_rv39_expected_usage.ts
 */
import { query, queryOne, db } from '../db'

const PROPERTY_NAME = 'Mountain View RV Ranch'
const METER_LABEL = 'RV 39 electric'
const CYCLE = '2026-10-01'
const EXPECTED = 786          // mean of 801, 728, 837, 349, 1215
const NOTE = "Landlord's own earlier reads 50170 → 50971 → 51699 → 52536 → 52885 → 54100: "
  + '801, 728, 837, 349 and 1,215 kWh, mean 786 and median 801. The dial died at 54100.'

async function main() {
  const dbname = await queryOne<{ name: string }>(`SELECT current_database() AS name`)
  if (dbname?.name !== 'gam') throw new Error(`refusing to run against ${dbname?.name}`)

  const m = await queryOne<{ id: string; property_id: string; out_of_service: boolean; owner: string }>(`
    SELECT m.id, m.property_id, m.out_of_service, u.id AS owner
      FROM utility_meters m
      JOIN properties p ON p.id = m.property_id
      JOIN landlords l ON l.id = p.landlord_id
      JOIN users u ON u.id = l.user_id
     WHERE p.name = $1 AND m.label = $2`, [PROPERTY_NAME, METER_LABEL])
  if (!m) throw new Error(`${METER_LABEL} not found at ${PROPERTY_NAME}`)

  await query(
    `UPDATE utility_meters
        SET expected_monthly_usage = $2, expected_usage_set_at = NOW(),
            expected_usage_set_by_user_id = $3, expected_usage_note = $4,
            out_of_service = TRUE,
            out_of_service_since = COALESCE(out_of_service_since, CURRENT_DATE),
            updated_at = NOW()
      WHERE id = $1`, [m.id, EXPECTED, m.owner, NOTE])

  const flagged = await queryOne<{ id: string }>(
    `SELECT id FROM utility_meter_readings
      WHERE meter_id = $1 AND billing_cycle_month = $2::date
        AND reason = 'monthly_cycle' AND needs_review`, [m.id, CYCLE])
  if (flagged) {
    await query(
      `UPDATE utility_meter_readings
          SET needs_review = FALSE, is_rollover = FALSE,
              review_note = 'Settled 10/31: the meter is dead (dial stuck at ~54100). '
                         || 'Billing the usage the landlord states this space runs.'
        WHERE id = $1`, [flagged.id])
  }

  const left = await queryOne<{ n: number; which: string }>(`
    SELECT COUNT(*)::int AS n, string_agg(m.label, ', ' ORDER BY m.label) AS which
      FROM utility_meter_readings r JOIN utility_meters m ON m.id = r.meter_id
     WHERE m.property_id = $1 AND r.needs_review`, [m.property_id])
  const run = await queryOne<{ status: string }>(
    `SELECT status FROM utility_reading_runs
      WHERE property_id = $1 AND billing_cycle_month = $2::date
      ORDER BY created_at DESC LIMIT 1`, [m.property_id, CYCLE])

  console.log(`${METER_LABEL}: expected usage ${EXPECTED} kWh, meter marked not-reading, October flag settled.`)
  console.log(`  October will bill ${EXPECTED} kWh — $${(EXPECTED * 0.21).toFixed(2)} at $0.21.`)
  console.log(`  Still flagged at ${PROPERTY_NAME}: ${left?.n} (${left?.which ?? 'none'})`)
  console.log(`  Run status: ${run?.status} — no bills sent.`)
}

main().then(() => db.end()).catch(e => { console.error(e); db.end(); process.exit(1) })
