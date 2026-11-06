/**
 * 11/1 — SEPTEMBER AT COUNTRY ACRES, FOR THE EIGHT WHO PAID.
 *
 * Nic: "September is already done. So put it where it needs to go."
 *
 * Blue's handwritten sheet has a September column; GAM's first billing at that
 * park was OCTOBER, so September exists nowhere on the platform. Nic confirmed
 * lot by lot who had paid: "John, Shane, Mike, Cameron, Myria, Troy, Jolynn,
 * Jeff and Kim Bowman all are paid for September." Those eight are here. The
 * three who did not pay went in as carried balances with their late fees
 * (nov1_country_acres_september_arrears.ts); lot 6 is work trade and is not
 * money, so it is in neither.
 *
 * WHY THIS SHAPE, AND WHY IT DIFFERS FROM THE ARREARS SCRIPT. Money already
 * received needs no bill behind it — GAM never billed September, and inventing
 * eight invoices that never existed would be writing history that did not
 * happen. A settled payment with no invoice is exactly what the payment-history
 * import writes (routes/landlords.ts, the commit loop), and these rows mirror
 * that INSERT column for column so the two paths cannot drift. The three who
 * owe needed the opposite: with no charge row there is nothing to owe, so they
 * got a carried balance.
 *
 * NOTHING IS BILLED AND GAM HOLDS NONE OF IT.
 *   · `platform_held` stays FALSE (its default, and this does not set it), so
 *     the Tuesday payout sweep — which only moves platform_held = TRUE money —
 *     can never try to pay Blue cash he already has in his pocket.
 *   · An invoice-less payment is matched to a bill by lease AND due date
 *     (services/creditBillMarks). There are no September bills, so these cannot
 *     touch October or November balances.
 *   · Credit comes from explicit `credits` rows, never from a loose payment, so
 *     none of this becomes a credit anybody spends against next month.
 * All three were checked against the eight lots' balances before and after.
 *
 * The amounts are the lot TOTAL for the month — rent, water, and any trailer
 * payment together — because that is the single figure Blue's sheet carries per
 * lot. They are typed 'rent' with the note saying so rather than split, since
 * splitting would mean inventing a breakdown he did not write down.
 *
 * Run with DRY=1 to print what it would do and change nothing.
 */
import { getClient } from '../db'

const DRY = process.env.DRY === '1'
const PARK = 'Country Acres - Mattoon'
const PAID_ON = '2026-09-01'
const NOTE = 'September 2026 — collected off-platform before this park was on GAM. '
  + 'Lot total: rent, water and any trailer payment together. Nobody was billed for it.'

/** Lot → what Blue's sheet says was collected for September. */
const COLLECTED: Array<[string, number]> = [
  ['MH 01', 707.25],
  ['MH 11', 623.10],
  ['MH 15', 466.50],
  ['MH 17', 715.65],
  ['MH 21', 666.50],
  ['MH 22', 541.50],
  ['MH 24', 616.50],
  ['MH 30', 583.00],
]

async function main() {
  const c = await getClient()
  const say = (s: string) => console.log(s)
  try {
    await c.query('BEGIN')
    let total = 0
    let written = 0

    for (const [lot, amount] of COLLECTED) {
      const l = (await c.query<{
        lease_id: string; tenant_id: string; landlord_id: string; unit_id: string; who: string
      }>(`
        SELECT l.id AS lease_id, lt.tenant_id, l.landlord_id, l.unit_id,
               COALESCE(usr.first_name || ' ' || usr.last_name, '(no name)') AS who
          FROM leases l
          JOIN units u ON u.id = l.unit_id
          JOIN properties p ON p.id = u.property_id
          JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary' AND lt.status = 'active'
          JOIN tenants t ON t.id = lt.tenant_id
          JOIN users usr ON usr.id = t.user_id
         WHERE p.name = $1 AND u.unit_number = $2 AND l.status = 'active'
         LIMIT 1`, [PARK, lot])).rows[0]

      if (!l) { say(`${lot}: no active lease with a primary resident — SKIPPED`); continue }

      // Never twice. The import's own guard is a per-file unique index, which
      // cannot see a row written by an earlier run, so this asks the database.
      const already = (await c.query(`
        SELECT 1 FROM payments
         WHERE lease_id = $1 AND due_date = $2::date AND status = 'settled'
           AND import_source = 'manual' AND amount = $3`,
        [l.lease_id, PAID_ON, amount.toFixed(2)])).rows[0]
      if (already) { say(`${lot}: already recorded — skipped (nothing counted twice)`); continue }

      say(`${lot}  ${l.who}  $${amount.toFixed(2)}`)
      total += amount
      if (DRY) continue

      await c.query(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, entry_description, amount, status,
           due_date, settled_at, processed_at,
           notes, manual_method, import_source, imported_at
         ) VALUES ($1,$2,$3,$4,'rent','RENT',$5,'settled',$6::date,$6::date,$6::date,
                   $7,'prior_arrangement','manual',NOW())`,
        [l.landlord_id, l.tenant_id, l.lease_id, l.unit_id, amount.toFixed(2), PAID_ON, NOTE])
      written++
    }

    say(`\n${DRY ? 'would record' : 'recorded'} ${DRY ? COLLECTED.length : written} payment(s), $${total.toFixed(2)}`)

    if (DRY) { await c.query('ROLLBACK'); say('DRY RUN — nothing written.') }
    else { await c.query('COMMIT'); say('Applied. Nobody was billed.') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
