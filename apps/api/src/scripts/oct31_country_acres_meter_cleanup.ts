/**
 * 10/31 (Nic) — CLOSING OUT COUNTRY ACRES' OCTOBER.
 *
 * Four data actions, each one of his decisions this session. Deliberately does
 * NOT settle Lot 21's flag: that is the last one on the run, and settling it
 * finishes the reading phase, which emails Blue that his bills are ready to
 * approve. That email is Nic's to trigger, not mine.
 *
 *   1. Lot 17 — marked a known heavy user. She billed 19,800 gallons in
 *      September (paid and settled) and was held in October for 12,700, which
 *      is 7,100 gallons LESS. A flat 10,000-gallon threshold will hold her
 *      every month forever; the mark stops that. Then her October flag is
 *      settled as confirmed, so the 12,700 bills.
 *
 *   2. Lot 22 — back in service on its own reads. Nic: "mark it working again
 *      and make that bill use the used water reading." It read 2072 twice (so
 *      it was marked broken on 9/30 and estimated 1,000 gallons for September),
 *      then moved to 2082 on 10/28 — ten turns, 1,000 real gallons. Neither
 *      "Repaired" nor "Works, nobody using it" could bill that; the new third
 *      choice can (services/meterRepair markMeterReadsStand).
 *
 *   3. The three August flags on Lots 21, 22 and 24 — stood down. Their reason
 *      is 'billed_off_platform': cycles the landlord billed himself before the
 *      park came onto GAM. There has never been anything for GAM to settle on
 *      them, so they could never clear, and they were padding the double-check
 *      card to six while the banner said three.
 *
 *   4. Lot 28's left-owing — recomputed. Frozen at $739.60 on 10/28 when the
 *      replacement signed; October's water ($24.75) was written on 10/29 and
 *      never reached it.
 *
 * Run once:  npx ts-node src/scripts/oct31_country_acres_meter_cleanup.ts
 */
import { query, queryOne, getClient, db } from '../db'
import { markMeterReadsStand } from '../services/meterRepair'
import { whatIsStillOwedOnLease } from '../services/spotSuccession'
import { settleFlaggedOnRun } from '../services/utilityReadingRuns'

const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'   // Country Acres - Mattoon
const CYCLE = '2026-10-01'
const LOT28_LEASE = '55a9fb98-7f39-4deb-afc0-c73322d8bcbc' // the lease that ended 10/31

async function main() {
  const dbname = await queryOne<{ name: string }>(`SELECT current_database() AS name`)
  if (dbname?.name !== 'gam') throw new Error(`refusing to run against ${dbname?.name}`)

  const owner = (await queryOne<{ id: string }>(
    `SELECT u.id FROM landlords l JOIN users u ON u.id = l.user_id
      JOIN properties p ON p.landlord_id = l.id WHERE p.id = $1`, [PROPERTY]))!.id

  // ── 1. Lot 17: known heavy user, then settle October ──────────────────────
  const l17 = await queryOne<{ id: string }>(
    `SELECT id FROM utility_meters WHERE property_id = $1 AND label = 'Water — Lot 17'`, [PROPERTY])
  if (l17) {
    await query(
      `UPDATE utility_meters
          SET high_use_confirmed_at = NOW(), high_use_confirmed_by_user_id = $2,
              high_use_note = $3, updated_at = NOW()
        WHERE id = $1 AND high_use_confirmed_at IS NULL`,
      [l17.id, owner,
       'Genuinely heavy household: 19,800 gal billed and paid for September, 12,700 for October. '
       + 'The flat 10,000-gallon alert would hold this meter every month.'])
    const flagged = await queryOne<{ id: string; value: string }>(
      `SELECT id, reading_value::text AS value FROM utility_meter_readings
        WHERE meter_id = $1 AND billing_cycle_month = $2::date
          AND reason = 'monthly_cycle' AND needs_review`, [l17.id, CYCLE])
    if (flagged) {
      await query(
        `UPDATE utility_meter_readings
            SET needs_review = FALSE, is_rollover = FALSE,
                review_note = 'Confirmed correct after double-check — known heavy user'
          WHERE id = $1`, [flagged.id])
      console.log(`Lot 17: marked a heavy user; October read ${flagged.value} confirmed — 12,700 gal will bill.`)
    } else {
      console.log('Lot 17: marked a heavy user; no October flag outstanding.')
    }
  }

  // ── 2. Lot 22: back in service on its own reads ───────────────────────────
  const l22 = await queryOne<{ id: string; out_of_service: boolean }>(
    `SELECT id, out_of_service FROM utility_meters WHERE property_id = $1 AND label = 'Water — Lot 22'`, [PROPERTY])
  if (l22?.out_of_service) {
    const tx = await getClient()
    try {
      await tx.query('BEGIN')
      await markMeterReadsStand(tx, { meterId: l22.id, userId: owner })
      await tx.query('COMMIT')
    } catch (e) { await tx.query('ROLLBACK').catch(() => {}); throw e } finally { tx.release() }
    console.log('Lot 22: back in service on its own reads — 2072 → 2082 = 1,000 gal, $16.50.')
  } else {
    console.log('Lot 22: already in service.')
  }

  // ── 3. The three stale August flags ───────────────────────────────────────
  const stale = await query<{ label: string }>(
    `UPDATE utility_meter_readings r
        SET needs_review = FALSE,
            review_note = COALESCE(r.review_note || ' | ', '')
              || 'Stood down 10/31: this cycle was billed off-platform, so there was never anything here to settle.'
       FROM utility_meters m
      WHERE m.id = r.meter_id AND m.property_id = $1
        AND r.needs_review AND r.reason = 'billed_off_platform'
      RETURNING m.label`, [PROPERTY])
  console.log(`Stale off-platform flags stood down: ${stale.length}${stale.length ? ' (' + stale.map(r => r.label).join(', ') + ')' : ''}`)

  // ── 4. Lot 28's left-owing, recomputed ────────────────────────────────────
  const tx28 = await getClient()
  let owed: { amount: number; rows: number }
  try { owed = await whatIsStillOwedOnLease(tx28, LOT28_LEASE) } finally { tx28.release() }
  const before = await queryOne<{ amount: string }>(
    `SELECT amount::text FROM tenant_left_owing
      WHERE source_kind = 'lease' AND source_key = $1`, [LOT28_LEASE])
  if (before && Number(before.amount) !== owed.amount) {
    await query(
      `UPDATE tenant_left_owing SET amount = $2, updated_at = NOW()
        WHERE source_kind = 'lease' AND source_key = $1
          AND settled_at IS NULL AND COALESCE(collected_amount, 0) = 0`,
      [LOT28_LEASE, owed.amount.toFixed(2)])
    console.log(`Lot 28 left-owing: $${before.amount} → $${owed.amount.toFixed(2)} (${owed.rows} lines)`)
  } else {
    console.log(`Lot 28 left-owing: $${before?.amount ?? '—'} — already correct.`)
  }

  // Offer the run the chance to finish. It will not: Lot 21 is still flagged
  // on purpose, so no "bills are ready" email goes to Blue from this script.
  const run = await settleFlaggedOnRun(PROPERTY, CYCLE, owner)
  const left = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM utility_meter_readings r JOIN utility_meters m ON m.id = r.meter_id
      WHERE m.property_id = $1 AND r.billing_cycle_month = $2::date
        AND r.reason = 'monthly_cycle' AND r.needs_review`, [PROPERTY, CYCLE])
  console.log(`\nStill flagged on October: ${left?.n}. Run: ${run ? run.status : 'left waiting'}.`)
}

main().then(() => db.end()).catch(e => { console.error(e); db.end(); process.exit(1) })
