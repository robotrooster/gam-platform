/**
 * 11/4 — TAKE THE TRAILER PAYMENT OUT OF SEPTEMBER'S LOT TOTALS, SO IT IS
 * COUNTED ONCE.
 *
 * Nic: "Money needs to be counted once only."
 *
 * WHAT WENT WRONG. On 11/1 I recorded September at Country Acres from Blue's
 * sheet, which carries ONE figure per lot. My own header said so: "the amounts
 * are the lot TOTAL for the month — rent, water, and any trailer payment
 * together... typed 'rent'". What I missed is that GAM had ALREADY recognized
 * each lot's September trailer installment as income — its nightly home-sale
 * job stamped them settled-off-platform on 9/25–10/12, because September is
 * before this park's first billing cycle. So the trailer money is inside the
 * lot total booked to SPACE RENT, and again in HOME SALES.
 *
 * The arithmetic, which is how it was found — every lot total is $450 of lot
 * rent plus the trailer plus water, and two match October's water to the cent:
 *
 *     MH 22   541.50 = 450 + 75  + 16.50     (October's water: 16.50)
 *     MH 24   616.50 = 450 + 150 + 16.50     (October's water: 16.50)
 *     MH 01   707.25 = 450 + 200 + 57.25
 *     MH 21   666.50 = 450 + 200 + 16.50
 *     MH 30   583.00 = 450 + 100 + 33.00
 *                            ──────
 *                             725.00 counted twice
 *
 * WHAT THIS DOES, per lot: the trailer amount comes OFF the settled lot-total
 * row and becomes its own settled home payment, linked to the installment it
 * pays. Linking is the point — the off-platform projector stands down the
 * moment an installment has a charge row (tenantCharges: `if (!r.off ||
 * r.payment_id) return []`), so the income then comes from the real row, once.
 *
 * Nothing about what anybody OWES changes: both rows are settled, and the two
 * amounts still add to the lot total Blue collected. Space rent falls $725,
 * home sales stays $725 with real rows behind it, and September's income goes
 * from $6,295.00 to $5,570.00. The remaining $500 — trailer money the three who
 * did not pay September were credited with — is the projector change in
 * services/ledgerProjectors/tenantCharges.ts, not this script.
 *
 * Water stays inside the rent figure. Splitting that needs Blue's September
 * water reads, and inventing them would be the same mistake again.
 *
 * Scoped to this property, this month, and only lots whose numbers prove the
 * trailer is inside the total. Dry run unless --apply.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_country_acres_september_split_trailer.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_country_acres_september_split_trailer.ts --apply
 */
import { getClient } from '../db'

const PROPERTY_ID = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const PROPERTY_NAME = 'Country Acres - Mattoon'
const SEPT = '2026-09-01'
const LOT_RENT = 450.00
const APPLY = process.argv.includes('--apply')

interface Row {
  unit_id: string; unit_number: string; lease_id: string | null; tenant_id: string | null
  landlord_id: string; rent_id: string; lot_total: string
  installment_id: string; trailer: string; contract_id: string
  settled_at: string | null; invoice_id: string | null
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

    // The lots where September's settled lot total and a September installment
    // both exist — the ones where the same dollars are in two income accounts.
    const rows = (await client.query<Row>(
      `SELECT u.id AS unit_id, u.unit_number, p.lease_id, p.tenant_id, p.landlord_id,
              p.id AS rent_id, p.amount::text AS lot_total, p.settled_at::text AS settled_at,
              p.invoice_id,
              i.id AS installment_id, i.amount::text AS trailer, c.id AS contract_id
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         JOIN home_sale_contracts c ON c.unit_id = u.id AND c.status = 'active'
         JOIN home_sale_installments i ON i.contract_id = c.id AND i.billing_month = $2::date
        WHERE u.property_id = $1
          AND p.type = 'rent' AND p.due_date = $2::date AND p.status = 'settled'
          AND p.voided_at IS NULL
          AND i.payment_id IS NULL
        ORDER BY u.unit_number
        FOR UPDATE OF p, i`, [PROPERTY_ID, SEPT])).rows

    if (rows.length === 0) { console.log('\nNothing to split — already done, or no such lots.'); await client.query('ROLLBACK'); return }

    let moved = 0
    for (const r of rows) {
      const total = Number(r.lot_total)
      const trailer = Number(r.trailer)
      const rest = Math.round((total - trailer) * 100) / 100
      const water = Math.round((rest - LOT_RENT) * 100) / 100

      // The guard that matters: the trailer must actually FIT inside the total
      // with the lot rent, leaving a water figure that is not negative. A lot
      // whose numbers do not work that way is not one of these and is skipped
      // loudly rather than cut.
      if (rest <= 0 || water < 0) {
        console.log(`  ${r.unit_number.padEnd(6)} SKIPPED — $${total.toFixed(2)} does not hold $${LOT_RENT.toFixed(2)} rent + $${trailer.toFixed(2)} trailer`)
        continue
      }

      console.log(`  ${r.unit_number.padEnd(6)} $${total.toFixed(2)} → rent+water $${rest.toFixed(2)} (water $${water.toFixed(2)}) + trailer $${trailer.toFixed(2)}`)

      await client.query(
        `UPDATE payments
            SET amount = $2::numeric,
                notes = COALESCE(notes, '') || ' — 11/4: the trailer payment of $' || $3 ||
                        ' was taken out of this lot total onto its own row, so it is counted once.'
          WHERE id = $1`,
        [r.rent_id, rest.toFixed(2), trailer.toFixed(2)])

      const pay = (await client.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
            settled_at, processed_at, entry_description, notes, manual_method,
            import_source, imported_at, home_sale_installment_id, revenue_owner, invoice_id)
         VALUES ($1, $2, $3, $4, 'home_payment', $5::numeric, 'settled', $6::date,
                 $7::timestamptz, $7::timestamptz, 'HOMEPMT', $8, 'prior_arrangement',
                 'manual', NOW(), $9, 'landlord', $10)
         RETURNING id`,
        [r.unit_id, r.lease_id, r.tenant_id, r.landlord_id, trailer.toFixed(2), SEPT,
         r.settled_at ?? `${SEPT}T12:00:00Z`,
         'September 2026 trailer payment — collected off-platform before this park was on GAM, '
           + 'inside the lot total Blue\'s sheet carries. Split onto its own row 11/4 so it is counted once.',
         r.installment_id, r.invoice_id])).rows[0]

      // The link is what makes the off-platform projector stand down.
      await client.query(
        `UPDATE home_sale_installments SET payment_id = $2 WHERE id = $1 AND payment_id IS NULL`,
        [r.installment_id, pay.id])
      moved++
    }

    const after = (await client.query<{ rent: string; home: string }>(
      `SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.type = 'rent'), 0)::text AS rent,
              COALESCE(SUM(p.amount) FILTER (WHERE p.type = 'home_payment'), 0)::text AS home
         FROM payments p JOIN units u ON u.id = p.unit_id
        WHERE u.property_id = $1 AND p.due_date = $2::date AND p.status = 'settled' AND p.voided_at IS NULL`,
      [PROPERTY_ID, SEPT])).rows[0]
    console.log(`\nSeptember settled rows now: rent $${after.rent}, trailer $${after.home}  (moved ${moved} lot(s))`)

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
