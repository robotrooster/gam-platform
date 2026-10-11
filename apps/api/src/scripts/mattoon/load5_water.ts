/**
 * S651 — Mattoon load, stage 5: the water submeters and Blu's two reads.
 *
 * Blu's sheet bills water as (current − prior) × $16.50, exactly, on every row
 * that has usage — $572.55 across the park for the 7/28→8/26 cycle. Verified
 * to the cent on all ten rows that moved.
 *
 * WHAT ONE UNIT IS. Nic's photo of a meter face shows seven digits counting
 * gallons; the sheet records 1044.9 where that face reads 1,044,900. So a
 * recorded unit is a THOUSAND GALLONS and the rate is $0.0165 per gallon.
 * The plausibility check settles it: Sheptock at 3,500 gallons a month is a
 * normal two-adult household, where 350 gallons would be twelve gallons a day
 * for a whole home. Stored as reading_multiplier = 1000 so GAM does the
 * arithmetic rather than the person walking the route — the same thing S613
 * did for Mountain View's hundreds-of-gallons face.
 *
 * THE THREE DEAD METERS. Lots 21, 22 and 24 read identically on both dates —
 * 580.1→580.1, 207.2→207.2, 857.6→857.6. Three occupied homes using no water
 * for a month is not credible; those meters were not read, or are stuck. They
 * load flagged for review rather than estimated: estimating a stuck meter is a
 * per-property opt-in and Mattoon has not opted in.
 * (memory: gam-stuck-meter-estimate-mountain-view-only)
 *
 * NOTHING BILLS FROM THIS. First billing is October rent and SEPTEMBER usage,
 * and the September read does not exist yet. These two reads are here so the
 * first real bill has a prior to measure from.
 */
import { query, getClient } from '../../db'
import fs from 'fs'

const DRY = process.env.DRY === '1'
const SRC = __dirname + '/lots.json'
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
/** $16.50 per 1,000 gallons, held per gallon so it can be checked against the city bill. */
const RATE_PER_GALLON = 0.0165
const GALLONS_PER_UNIT = 1000
const PRIOR_DATE = '2026-07-28'
const CYCLE_DATE = '2026-08-26'

async function main() {
  const rows: any[] = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  const seen = new Set<string>()
  const metered = rows.filter((r) => {
    const ok = /^\d+$/.test(r.lot) && r.tenant && r.tenant.toLowerCase() !== 'vacant'
      && r.read_prior != null && r.read_current != null && !seen.has(r.lot)
    if (ok) seen.add(r.lot)
    return ok
  })

  console.log(`${metered.length} occupied lots carry a meter read\n`)
  let total = 0
  for (const r of metered) {
    const usageGal = (r.read_current - r.read_prior) * GALLONS_PER_UNIT
    const charge = Math.round(usageGal * RATE_PER_GALLON * 100) / 100
    const stuck = r.read_current === r.read_prior
    total += charge
    console.log(`  Lot ${String(r.lot).padEnd(3)} ${String(r.read_prior).padStart(7)} → ${String(r.read_current).padStart(7)}` +
                `  ${String(usageGal).padStart(6)} gal  $${charge.toFixed(2).padStart(7)}` +
                `  sheet $${(r.water ?? 0).toFixed(2)}` +
                `${charge === r.water ? '' : '   <-- MISMATCH'}${stuck ? '   FLAGGED: no movement' : ''}`)
  }
  console.log(`\n  total $${total.toFixed(2)}`)

  if (DRY) { console.log('\nDRY RUN — nothing written.'); process.exit(0) }

  const c = await getClient()
  let meters = 0, reads = 0
  try {
    await c.query('BEGIN')
    const owner = await query<any>(`SELECT user_id FROM landlords WHERE id=(SELECT landlord_id FROM properties WHERE id=$1)`, [PROPERTY])
    const byUser = owner[0]?.user_id ?? null

    for (const r of metered) {
      const unitNumber = `Lot ${r.lot}`
      const unit = await c.query<any>(
        `SELECT id FROM units WHERE property_id=$1 AND unit_number=$2 AND retired_at IS NULL`,
        [PROPERTY, unitNumber])
      if (!unit.rows.length) continue
      const unitId = unit.rows[0].id

      const exists = await c.query<any>(
        `SELECT m.id FROM utility_meters m JOIN utility_meter_units mu ON mu.meter_id=m.id
          WHERE m.property_id=$1 AND m.utility_type='water' AND mu.unit_id=$2`, [PROPERTY, unitId])
      if (exists.rows.length) continue

      const m = await c.query<any>(
        `INSERT INTO utility_meters
           (property_id, utility_type, label, billing_method, rate_per_unit, digits, reading_multiplier)
         VALUES ($1,'water',$2,'submeter',$3,7,$4) RETURNING id`,
        [PROPERTY, `Water — ${unitNumber}`, RATE_PER_GALLON, GALLONS_PER_UNIT])
      const meterId = m.rows[0].id
      await c.query(
        `INSERT INTO utility_meter_units (meter_id, unit_id, quantity) VALUES ($1,$2,1)`,
        [meterId, unitId])
      meters++

      const stuck = r.read_current === r.read_prior
      for (const [date, value, cycle] of [
        [PRIOR_DATE, r.read_prior, '2026-07-01'],
        [CYCLE_DATE, r.read_current, '2026-08-01'],
      ] as any[]) {
        await c.query(
          `INSERT INTO utility_meter_readings
             (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id,
              needs_review, review_note, reason_note)
           VALUES ($1,$2::date,$3,$4::date,$5,$6,$7,$8)`,
          [meterId, date, value, cycle, byUser,
           stuck && date === CYCLE_DATE,
           stuck && date === CYCLE_DATE
             ? 'No movement between 7/28 and 8/26 on an occupied home — meter not read, or stuck. Needs a walk-out read before this bills.'
             : null,
           'Loaded from Blu Haws’ lot inspection sheet, 2026-09-20'])
        reads++
      }
    }
    await c.query('COMMIT')
    console.log(`\ncreated ${meters} meter(s), ${reads} reading(s)`)
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
