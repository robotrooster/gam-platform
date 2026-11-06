/**
 * 11/5 — TAKE THE WATER OUT OF SEPTEMBER'S LOT TOTALS AT COUNTRY ACRES.
 *
 * Nic, 11/5: "September's water is a variable, but September's rent is also
 * contractual. So that should come out cleanly as well."
 *
 * He is right, and the reason I said otherwise on 11/4 was wrong. I wrote then
 * that splitting the water needed Blue's September reads and that inventing
 * them would repeat the mistake. But nothing here needs a read: the LOT RENT is
 * $450 on all twelve leases, every month, with no exceptions, so the water is
 * what is left after the rent and the trailer payment come off. The reads would
 * only tell us how many gallons it was — not how many dollars Blue collected,
 * which is what the books record.
 *
 * ── AND THE WATER INSIDE SEPTEMBER IS NOT SEPTEMBER'S WATER ────────────────
 *
 * Worth writing down, because it is the thing that makes this safe. This park
 * bills water A MONTH IN ARREARS, and GAM already holds those bills:
 *
 *   cycle 2026-09-01, reads 8/26–9/30  →  charged as the OCTOBER utility rows
 *   cycle 2026-10-01, reads 9/30–10/28 →  charged as the NOVEMBER utility rows
 *
 * MH 01 proves it to the cent: its 2026-09-01 bill is $107.25 and its October
 * utility charge is $107.25. So September's own usage is already on the books,
 * once, in October — and the water folded inside September's lot totals is
 * AUGUST's, which Blue collected in September. There is no double count either
 * way, and the only August bill GAM ever computed (MH 01, $57.75, voided) sits
 * within fifty cents of that lot's residual, which is the arithmetic agreeing
 * with itself.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 *
 * Per lot: the rent row drops to the contractual $450 and the remainder becomes
 * its own settled water row, dated the same day, collected the same way. Both
 * still add to the lot total Blue collected, so nothing anybody owes or paid
 * changes by a cent — only which income line it is on. The note begins with the
 * word "Water" because that is how a utility row with no meter bill behind it
 * is classified (ledgerProjectors/tenantShared UTILITY_NOTES), and there is no
 * meter bill behind it on purpose: GAM never read these meters.
 *
 *     September space rent   $4,195.00  →  $3,600.00   (8 lots x $450)
 *     September water             $0.00  →    $595.00
 *
 * A lot whose total is already $450 has no water inside it and is skipped. So
 * is any lot whose total is BELOW $450 — that is not a figure this script
 * understands, and it says so rather than writing a negative water line.
 *
 * NOT IN HERE, and it is the open question September still has: MH 06 has been
 * on that lot since 2016 and has no September row of any kind — no rent, no
 * balance, no water — while October and November are both billed. One lot's
 * rent is simply unaccounted for and no arithmetic here can invent it; it needs
 * Blue's sheet.
 *
 * Scoped to this property and this month. Dry run unless --apply.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov5_country_acres_september_split_water.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov5_country_acres_september_split_water.ts --apply
 */
import { getClient } from '../db'

const PROPERTY_ID = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const PROPERTY_NAME = 'Country Acres - Mattoon'
const SEPT = '2026-09-01'
const LOT_RENT = 450.00
const APPLY = process.argv.includes('--apply')

const WATER_NOTE =
  'Water — inside the lot total Blue collected off-platform for September 2026, before this '
  + 'park was on GAM. The lot rent is contractual at $450.00, so this is the remainder once '
  + 'the rent and any trailer payment come off it. Split onto its own row 11/5 so each line is '
  + 'the income it actually is. No meter was read by GAM for it: this is the money collected, '
  + 'not a computed bill. (The usage GAM did read for September bills in October, a month in '
  + 'arrears, so this water is August’s.)'

interface Row {
  unit_id: string; unit_number: string; lease_id: string | null; tenant_id: string | null
  landlord_id: string; rent_id: string; lot_total: string
  settled_at: string | null; processed_at: string | null; invoice_id: string | null
  manual_method: string | null
}

async function main() {
  const client = await getClient()
  try {
    const dbName = (await client.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n
    console.log(`database: ${dbName}`)
    console.log(APPLY ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)')

    const prop = (await client.query<{ name: string }>(
      `SELECT name FROM properties WHERE id = $1`, [PROPERTY_ID])).rows[0]
    if (!prop) throw new Error('that property does not exist here')
    if (prop.name !== PROPERTY_NAME) throw new Error(`refusing: expected ${PROPERTY_NAME}, found ${prop.name}`)

    await client.query('BEGIN')

    const rows = (await client.query<Row>(
      `SELECT u.id AS unit_id, u.unit_number, p.lease_id, p.tenant_id, p.landlord_id,
              p.id AS rent_id, p.amount::text AS lot_total,
              p.settled_at::text AS settled_at, p.processed_at::text AS processed_at,
              p.invoice_id, p.manual_method
         FROM payments p
         JOIN units u ON u.id = p.unit_id
        WHERE u.property_id = $1
          AND p.type = 'rent' AND p.due_date = $2::date AND p.status = 'settled'
          AND p.voided_at IS NULL
        ORDER BY u.unit_number
        FOR UPDATE OF p`, [PROPERTY_ID, SEPT])).rows

    if (rows.length === 0) { console.log('\nNo settled September rent rows here.'); await client.query('ROLLBACK'); return }

    let split = 0
    let water = 0
    for (const r of rows) {
      const total = Number(r.lot_total)
      const rest = Math.round((total - LOT_RENT) * 100) / 100

      if (rest === 0) {
        console.log(`  ${r.unit_number.padEnd(6)} $${total.toFixed(2)} — already just the lot rent, nothing to split`)
        continue
      }
      if (rest < 0) {
        console.log(`  ${r.unit_number.padEnd(6)} SKIPPED — $${total.toFixed(2)} is less than the $${LOT_RENT.toFixed(2)} lot rent, so there is no water inside it`)
        continue
      }

      console.log(`  ${r.unit_number.padEnd(6)} $${total.toFixed(2)} → rent $${LOT_RENT.toFixed(2)} + water $${rest.toFixed(2)}`)

      await client.query(
        `UPDATE payments
            SET amount = $2::numeric,
                notes = COALESCE(notes, '') || ' — 11/5: the water of $' || $3 ||
                        ' was taken out of this lot total onto its own row, so each line is the income it is.'
          WHERE id = $1`,
        [r.rent_id, LOT_RENT.toFixed(2), rest.toFixed(2)])

      await client.query(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
            settled_at, processed_at, entry_description, notes, manual_method,
            import_source, imported_at, revenue_owner, invoice_id)
         VALUES ($1, $2, $3, $4, 'utility', $5::numeric, 'settled', $6::date,
                 $7::timestamptz, $8::timestamptz, 'UTILITY', $9, $10,
                 'manual', NOW(), 'landlord', $11)`,
        [r.unit_id, r.lease_id, r.tenant_id, r.landlord_id, rest.toFixed(2), SEPT,
         r.settled_at ?? `${SEPT}T12:00:00Z`,
         r.processed_at ?? r.settled_at ?? `${SEPT}T12:00:00Z`,
         WATER_NOTE, r.manual_method ?? 'prior_arrangement', r.invoice_id])

      split++
      water = Math.round((water + rest) * 100) / 100
    }

    const after = (await client.query<{ rent: string; util: string; home: string; total: string }>(
      `SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.type = 'rent'), 0)::text AS rent,
              COALESCE(SUM(p.amount) FILTER (WHERE p.type = 'utility'), 0)::text AS util,
              COALESCE(SUM(p.amount) FILTER (WHERE p.type = 'home_payment'), 0)::text AS home,
              COALESCE(SUM(p.amount), 0)::text AS total
         FROM payments p JOIN units u ON u.id = p.unit_id
        WHERE u.property_id = $1 AND p.due_date = $2::date
          AND p.status = 'settled' AND p.voided_at IS NULL`,
      [PROPERTY_ID, SEPT])).rows[0]
    console.log(`\nSeptember settled rows now: rent $${after.rent}, water $${after.util}, trailer $${after.home}`)
    console.log(`                            collected in all $${after.total}  (${split} lot(s) split, $${water.toFixed(2)} of water)`)

    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? '\nCOMMITTED' : '\nrolled back (dry run)')
    if (APPLY) console.log('The ledger re-posts within the minute; re-run the income read to see it move.')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })
