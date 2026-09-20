/**
 * S651 — Mattoon load, stage 1: the lots.
 *
 * Source: "Illinois Trip.xlsx", sheet "Mattoon Lot Inspection Log" — Blu Haws'
 * own walk of Country Acres (Howard's MHP) at 10055 US-45, Mattoon IL.
 *
 * Nic: create every lot and MARK the dead ones, so the numbering matches the
 * paper Blu works from. Lots 12–14 and 25–26 were removed by the city and can
 * never be rented; they exist here retired so a gap in the numbers never reads
 * as a missing record.
 *
 * DRY=1 prints the plan and writes nothing.
 */
import { query, getClient } from '../../db'
import fs from 'fs'

const DRY = process.env.DRY === '1'
const SRC = __dirname + '/lots.json'
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'   // Country Acres - Mattoon
const LANDLORD = 'e8904104-ab16-4d02-b6f8-cac88d738aae'   // TruBlu Management LLC (Blu Haws)

/** The city removed these pads. They exist in the numbering and nowhere else. */
const REMOVED = new Set(['12', '13', '14', '25', '26'])
/** Blocked until the neighbouring trailer is rotated off them. */
const BLOCKED: Record<string, string> = {
  '5':  'Needs the lot 6 trailer rotated to free the spot',
  '27': 'Needs the lot 28 trailer rotated to free the spot',
}

function homeOwnership(r: any): 'landlord' | 'tenant' {
  // A tenant-owned home is the tenant's. Everything else — rent-to-own until
  // it is paid off, park-owned, and the tax-sale homes — is not theirs yet.
  return r.toh === 'x' ? 'tenant' : 'landlord'
}

async function main() {
  const rows: any[] = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  // Numeric lots plus the office. The sheet repeats 18 and 21 with a second
  // row of home description; keep the first (the one with the tenant on it).
  const seen = new Set<string>()
  const lots = rows.filter((r) => {
    const ok = (/^\d+$/.test(r.lot) || r.lot === 'Office') && !seen.has(r.lot)
    if (ok) seen.add(r.lot)
    return ok
  })

  const existing = await query<any>(
    `SELECT id, unit_number FROM units WHERE property_id = $1`, [PROPERTY])
  const byNumber = new Map(existing.map((u: any) => [u.unit_number, u.id]))

  console.log(`sheet lots: ${lots.length}   existing units: ${existing.length}`)
  console.log(`placeholders to retire: ${existing.filter((u: any) => /^MH \d+$/.test(u.unit_number)).length}\n`)

  const plan: any[] = []
  for (const r of lots) {
    const number = r.lot === 'Office' ? 'Office' : `Lot ${r.lot}`
    const occupied = !!(r.tenant && r.tenant.toLowerCase() !== 'vacant')
    plan.push({
      number,
      lot: r.lot,
      unitType: r.lot === 'Office' ? 'commercial' : 'mobile_home',
      // Occupied pads go active when their lease is written in stage 3; they
      // start vacant so nothing claims a tenancy that does not exist yet.
      status: 'vacant',
      rent: r.lot === 'Office' ? 0 : 450,
      ownership: homeOwnership(r),
      removed: REMOVED.has(r.lot),
      blocked: BLOCKED[r.lot] ?? null,
      occupied,
      tenant: occupied ? r.tenant.replace(/\n/g, ' / ') : null,
      home: [r.year, r.make, r.model].filter(Boolean).join(' ') || null,
      vin: r.vin, title: r.title,
      notes: [r.issues, r.notes].filter(Boolean).join(' — ') || null,
      exists: byNumber.has(number),
    })
  }

  for (const p of plan) {
    const tag = p.removed ? 'REMOVED BY CITY' : p.blocked ? 'BLOCKED' : p.occupied ? `OCCUPIED ${p.tenant}` : 'vacant'
    console.log(`  ${p.number.padEnd(8)} ${p.unitType.padEnd(12)} $${String(p.rent).padEnd(4)} ${p.ownership.padEnd(9)} ${tag}`)
  }
  console.log(`\ntotals: ${plan.length} lots · ${plan.filter(p=>p.occupied).length} occupied · ` +
              `${plan.filter(p=>p.removed).length} removed · ${plan.filter(p=>p.blocked).length} blocked`)

  if (DRY) { console.log('\nDRY RUN — nothing written.'); process.exit(0) }

  const c = await getClient()
  try {
    await c.query('BEGIN')
    // The 11 MH 01–11 placeholders came with the property and match no real
    // lot. Retired, not deleted (GAM never erases), and retiring them stops
    // eleven pads that do not exist from carrying a platform fee.
    const retired = await c.query(
      `UPDATE units SET retired_at = now(), listed_vacant = FALSE, is_bookable = FALSE,
                        updated_at = now()
        WHERE property_id = $1 AND unit_number ~ '^MH [0-9]+$' AND retired_at IS NULL
        RETURNING unit_number`, [PROPERTY])
    console.log(`retired ${retired.rowCount} placeholder unit(s)`)

    let made = 0
    for (const p of plan) {
      if (p.exists) continue
      const ins = await c.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount,
                            unit_type, dwelling_ownership, occupancy_mode, listing_description,
                            unit_description)
         VALUES ($1,$2,$3,'vacant',$4,$5,$6,'whole_unit',NULL,$7)
         RETURNING id`,
        [PROPERTY, LANDLORD, p.number, p.rent, p.unitType, p.ownership,
         [p.home ? `Home: ${p.home}` : null, p.vin ? `VIN ${p.vin}` : null,
          p.title ? `Title ${p.title}` : null, p.notes].filter(Boolean).join(' · ') || null])
      made++
      if (p.removed) {
        await c.query(
          `UPDATE units SET retired_at = now(), listed_vacant = FALSE, is_bookable = FALSE
            WHERE id = $1`, [ins.rows[0].id])
      } else if (p.blocked) {
        await c.query(
          `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason, created_by)
           VALUES ($1,$2,CURRENT_DATE,NULL,$3,
                   (SELECT user_id FROM landlords WHERE id = $2))`,
          [ins.rows[0].id, LANDLORD, p.blocked])
      }
    }
    await c.query('COMMIT')
    console.log(`created ${made} unit(s)`)
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
