/**
 * 11/1 (Nic) — THE TRAILER PAYMENT RIDES THE INVOICE.
 *
 *   "The trailer payments ride the invoices not a separate bill. We established
 *    this today. She should have had the trailer payment in the original
 *    invoice 450 rent 100 trailer payment"
 *
 * Country Acres bills as one invoice a month (properties.home_payments_own_bill
 * = FALSE). MH 28's November installment missed that bill for a timing reason,
 * not a design one: nothing was due on 10/28 when she signed, so the first run
 * that could bill it was 04:20 on 11/1 — and at that moment the park was still
 * set to separate bills. The setting was flipped later the same evening.
 *
 * So the $100 goes where it belongs: onto INV-2026-00028, beside her rent. Her
 * bill reads rent $450 + deposit installment $112.50 + trailer $100 = $662.50.
 * She has $562.50 clearing against it, so $100 stands open — which is the true
 * position, because GAM never billed her for it. The separate bill is voided.
 *
 * services/homeSale now bundles onto any OPEN bill, a clearing one included, so
 * nothing re-splits this next month.
 */
import { getClient } from '../db'

const RENT_BILL = '41b9dbb3-9ecf-40d2-a584-169742ca7f31'   // INV-2026-00028
const OWN_BILL  = 'd4d7a76f-5399-48ae-80da-09e1cc7a2d57'   // INV-2026-00033

/** The canonical re-total (services/utilityPayLink retotalInvoice). */
const RETOTAL = `
  WITH lines AS (
    SELECT p.type, p.amount, p.lease_fee_id, p.work_trade_suspended_at
      FROM payments p
     WHERE p.invoice_id = $1
       AND p.status IN ('pending', 'processing', 'settled', 'paid_via_deposit')),
  t AS (
    SELECT COALESCE(SUM(amount) FILTER (WHERE work_trade_suspended_at IS NULL AND type <> 'late_fee'), 0) AS total,
           COALESCE(SUM(amount) FILTER (WHERE type = 'rent'), 0) AS rent,
           COALESCE(SUM(amount) FILTER (WHERE type = 'fee'
                                        OR (type = 'deposit' AND lease_fee_id IS NOT NULL)), 0) AS fees,
           COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND lease_fee_id IS NULL), 0) AS deposits,
           COALESCE(SUM(amount) FILTER (WHERE type = 'utility'), 0) AS utilities,
           COALESCE(SUM(amount) FILTER (WHERE type = 'home_payment'), 0) AS home
      FROM lines)
  UPDATE invoices i
     SET total_amount = t.total, subtotal_rent = t.rent, subtotal_fees = t.fees,
         subtotal_deposits = t.deposits, subtotal_utilities = t.utilities,
         subtotal_home_payments = t.home, updated_at = NOW()
    FROM t
   WHERE i.id = $1 AND i.status <> 'void'`

async function main() {
  const dry = process.argv.includes('--dry-run')
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const line = await client.query<{ id: string; amount: string; status: string }>(
      `SELECT id, amount::text, status FROM payments
        WHERE invoice_id = $1 AND type = 'home_payment' FOR UPDATE`, [OWN_BILL])
    if (line.rowCount !== 1) throw new Error(`expected 1 installment line on the own bill, found ${line.rowCount}`)
    if (line.rows[0].status !== 'pending') throw new Error(`line is '${line.rows[0].status}' — stop and look`)

    const dest = await client.query<{ status: string }>(
      `SELECT status FROM invoices WHERE id = $1 FOR UPDATE`, [RENT_BILL])
    if (dest.rows[0].status === 'settled' || dest.rows[0].status === 'void') {
      throw new Error(`the rent bill is '${dest.rows[0].status}' — a closed bill takes no new line`)
    }

    await client.query(`UPDATE payments SET invoice_id = $2 WHERE id = $1`, [line.rows[0].id, RENT_BILL])
    await client.query(
      `UPDATE invoices
          SET status = 'void', total_amount = 0, subtotal_home_payments = 0,
              notes = 'Voided — Country Acres bills as one invoice a month, so this'
                   || ' installment rides INV-2026-00028.', updated_at = NOW()
        WHERE id = $1`, [OWN_BILL])
    await client.query(RETOTAL, [RENT_BILL])
    await client.query(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [RENT_BILL])

    const after = await client.query(
      `SELECT i.invoice_number, i.total_amount::float AS bill,
              (i.subtotal_rent + i.subtotal_fees + i.subtotal_utilities
               + i.subtotal_deposits + i.subtotal_home_payments)::float AS parts,
              i.subtotal_rent::float AS rent, i.subtotal_deposits::float AS deposit,
              i.subtotal_home_payments::float AS trailer, i.status
         FROM invoices i WHERE i.id = $1`, [RENT_BILL])
    console.log('HER BILL'); after.rows.forEach(r => console.log('   ', r))

    const money = await client.query<{ clearing: string; open: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('settled','processing')),0)::text AS clearing,
              COALESCE(SUM(amount) FILTER (WHERE status = 'pending'),0)::text AS open
         FROM payments WHERE invoice_id = $1 AND status <> 'voided'`, [RENT_BILL])
    console.log(`\nclearing against it: $${money.rows[0].clearing}   still open: $${money.rows[0].open}`)

    await client.query(dry ? 'ROLLBACK' : 'COMMIT')
    console.log(dry ? '\n(dry run — nothing kept)' : '\napplied')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message || e); process.exit(1) })
