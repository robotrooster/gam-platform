/**
 * 11/1 — UNDO MY OWN MERGE ON ONE BILL THAT WAS ALREADY PAID.
 *
 * Tonight's Country Acres merge (nov1_merge_country_acres_bills.ts, applied
 * 17:07) folded each November trailer installment onto the resident's rent
 * bill, because Blue bills the park as one invoice a month
 * (properties.home_payments_own_bill = FALSE — services/homeSale, 10/25:
 * "Leave current properties set up as is. Let landlords choose how it gets
 * bundled"). That policy is right and is not what went wrong.
 *
 * What went wrong is that the merge did not ask whether the bill had already
 * been paid. Bundling belongs at the moment a bill is WRITTEN, before anyone
 * pays it. Applied afterwards it reopens a settled bill.
 *
 * MH 28 was the one bill with money already against it. The resident paid
 * $629.50 on 10/30 at 10:55 — her November bill in full as it then stood
 * (tenant_remittances 00a8047a, ACH, still clearing). At 17:07 the merge
 * added $100 to that same bill, so a bill she had paid in full went to
 * $729.50 and showed her owing $100 she had never been billed for.
 *
 * MH 22's resident paid at 17:16, nine minutes AFTER the merge, so they paid
 * the bundled total and are untouched. Every other unit the merge touched had
 * not paid November yet, so for them the single bill is exactly what Blue
 * asked for. This script therefore reverses the merge for MH 28 only.
 *
 * Her installment goes back to its own bill — which is where the 04:20 run
 * had put it, and what the 10/25 decision says it is: "a trailer payment is
 * its own bill ... I've had some people literally try to say, oh, I paid my
 * rent, and then it's like, no, that was the trailer payment." She still owes
 * the $100; it is simply not a line on a bill she already settled.
 */
import { getClient } from '../db'

const RENT_BILL = '41b9dbb3-9ecf-40d2-a584-169742ca7f31'   // INV-2026-00028
const OWN_BILL  = 'd4d7a76f-5399-48ae-80da-09e1cc7a2d57'   // INV-2026-00033
const MERGE_NOTE = 'Merged into INV-2026-00028 — Country Acres bills as one invoice a month.'

async function main() {
  const dry = process.argv.includes('--dry-run')
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const before = await client.query(
      `SELECT invoice_number, total_amount::float AS total, subtotal_home_payments::float AS home, status
         FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY invoice_number`, [[RENT_BILL, OWN_BILL]])
    console.log('BEFORE'); before.rows.forEach(r => console.log('   ', r))

    // The installment line, as the merge left it: pointed at the rent bill.
    const line = await client.query<{ id: string; amount: string; status: string }>(
      `SELECT id, amount::text, status FROM payments
        WHERE invoice_id = $1 AND type = 'home_payment' FOR UPDATE`, [RENT_BILL])
    if (line.rowCount !== 1) throw new Error(`expected 1 home_payment line on the rent bill, found ${line.rowCount}`)
    if (line.rows[0].status !== 'pending') throw new Error(`line is '${line.rows[0].status}', not pending — stop and look`)
    const cents = Math.round(Number(line.rows[0].amount) * 100)
    if (cents !== 10000) throw new Error(`line is $${line.rows[0].amount}, expected $100.00`)

    // Nothing may be voided back if money has since landed on it.
    const paid = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payments
        WHERE invoice_id = $1 AND type = 'home_payment' AND status <> 'pending'`, [RENT_BILL])
    if (paid.rows[0].n !== '0') throw new Error('the installment has money against it now — do not move it')

    // 1. the line goes home
    await client.query(`UPDATE payments SET invoice_id = $2 WHERE id = $1`, [line.rows[0].id, OWN_BILL])

    // 2. its own bill stands again (subtotal_home_payments was never cleared)
    await client.query(
      `UPDATE invoices
          SET status = 'pending', total_amount = 100.00, subtotal_home_payments = 100.00,
              notes = CASE WHEN notes = $2 THEN NULL ELSE notes END, updated_at = NOW()
        WHERE id = $1`, [OWN_BILL, MERGE_NOTE])

    // 3. her rent bill returns to the figure she paid in full on 10/30
    await client.query(
      `UPDATE invoices
          SET total_amount = 629.50, subtotal_home_payments = 0.00, updated_at = NOW()
        WHERE id = $1`, [RENT_BILL])

    const after = await client.query(
      `SELECT invoice_number, total_amount::float AS total, subtotal_home_payments::float AS home, status
         FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY invoice_number`, [[RENT_BILL, OWN_BILL]])
    console.log(dry ? 'AFTER (rolled back)' : 'AFTER'); after.rows.forEach(r => console.log('   ', r))

    const owed = await client.query(
      `SELECT i.invoice_number, p.type, p.amount::float AS amount, p.status
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.invoice_id = ANY($1::uuid[]) ORDER BY i.invoice_number, p.type`, [[RENT_BILL, OWN_BILL]])
    console.log('LINES'); owed.rows.forEach(r => console.log('   ', r))

    await client.query(dry ? 'ROLLBACK' : 'COMMIT')
    console.log(dry ? '\n(dry run — nothing kept)' : '\napplied')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message || e); process.exit(1) })
