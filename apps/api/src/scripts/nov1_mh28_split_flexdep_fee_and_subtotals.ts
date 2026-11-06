/**
 * 11/1 — SEPARATE GAM'S FLEXDEPOSIT FEE FROM HER DEPOSIT, AND MAKE THE BILL ADD UP.
 *
 * Two defects on MH 28's November bill, both from the enrollment-after-invoicing
 * path (services/flexDeposit, fixed in the same pass as this script):
 *
 * 1. THE FEE WAS FOLDED INTO THE DEPOSIT LINE. Her deposit row was rewritten to
 *    $179.50 — installment 1 ($112.50) plus GAM's whole service fee ($67.00) —
 *    as one row typed 'deposit' with revenue_owner 'landlord'. The move-in path
 *    has never done that, on purpose (jobs/moveInBundle, 10/26): installment 1
 *    is the resident's own money and comes back at move-out, while the fee is
 *    GAM's revenue and must never enter the custody balance. Folded, the trust
 *    liability counts $67 that is not her deposit, the SAME $67 is booked again
 *    as GAM revenue, and the landlord's "Tenant owes GAM" reads $0 instead of
 *    $67 because openBills derives it from revenue_owner = 'gam'.
 *
 * 2. THE SUBTOTALS WERE NEVER REBUILT. The adopt path re-summed total_amount
 *    alone, so subtotal_deposits stayed at the full $450 while the line became
 *    $179.50 — her breakdown adds to $1,000 against a stated $729.50.
 *
 * HER MONEY DOES NOT MOVE. The ACH is still clearing ($635.50 gross, $629.50
 * applied, intent pi_3UWK1SDNEru9AEpK22Vj0SiU), so the split has to leave every
 * total identical: the deposit row drops to $112.50, a $67.00 GAM fee row joins
 * the SAME intent in the same 'processing' state, and the receipt's two
 * applications become three summing to the same $629.50. Stripe is collecting
 * one figure and it is unchanged. Doing this BEFORE settlement is the point —
 * settlement is when the wrong liability would post.
 *
 * MH 07 at Oak Park has the subtotal shape too (total_amount 468.00,
 * subtotal_deposits 350.00) from a different path, so its breakdown is rebuilt
 * as well. No amount changes there either.
 */
import { getClient } from '../db'

const RENT_BILL = '41b9dbb3-9ecf-40d2-a584-169742ca7f31'   // INV-2026-00028, MH 28
const DEPOSIT_ROW = '8953014e-2a85-4abf-9b9e-ee715d4c87d6'
const REMITTANCE = '00a8047a-fec9-4923-bf70-25388d9d016c'
const DEPOSIT_ID = '783fe082-3754-44f7-8871-8db23a58c032'
const INTENT = 'pi_3UWK1SDNEru9AEpK22Vj0SiU'
const INSTALLMENT = 112.50
const FEE = 67.00

/** Rebuild all five subtotals and the total from the live lines. */
const RETOTAL = `
  UPDATE invoices i SET
    subtotal_rent          = t.rent,
    subtotal_fees          = t.fees,
    subtotal_utilities     = t.utilities,
    subtotal_deposits      = t.deposits,
    subtotal_home_payments = t.home,
    total_amount           = t.total,
    updated_at             = NOW()
  FROM (
    SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'rent'), 0)         AS rent,
           COALESCE(SUM(amount) FILTER (WHERE type = 'fee'), 0)          AS fees,
           COALESCE(SUM(amount) FILTER (WHERE type = 'utility'), 0)      AS utilities,
           COALESCE(SUM(amount) FILTER (WHERE type = 'deposit'), 0)      AS deposits,
           COALESCE(SUM(amount) FILTER (WHERE type = 'home_payment'), 0) AS home,
           COALESCE(SUM(amount) FILTER (WHERE type <> 'late_fee'), 0)    AS total
      FROM payments WHERE invoice_id = $1 AND status <> 'voided'
  ) t
  WHERE i.id = $1`

async function main() {
  const dry = process.argv.includes('--dry-run')
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const before = await client.query(
      `SELECT type, amount::float AS amount, status, revenue_owner, entry_description
         FROM payments WHERE invoice_id = $1 OR id = $2
        ORDER BY type`, [RENT_BILL, DEPOSIT_ROW])
    console.log('HER LINES BEFORE'); before.rows.forEach(r => console.log('   ', r))

    const dep = await client.query<{ amount: string; status: string; lease_id: string;
      unit_id: string; tenant_id: string; landlord_id: string; due_date: string }>(
      `SELECT amount::text, status, lease_id, unit_id, tenant_id, landlord_id,
              due_date::text AS due_date
         FROM payments WHERE id = $1 FOR UPDATE`, [DEPOSIT_ROW])
    if (dep.rowCount !== 1) throw new Error('deposit row not found')
    const d = dep.rows[0]
    if (Math.round(Number(d.amount) * 100) !== Math.round((INSTALLMENT + FEE) * 100)) {
      throw new Error(`deposit row is $${d.amount}, expected $${(INSTALLMENT + FEE).toFixed(2)} — already split?`)
    }
    if (d.status !== 'processing') throw new Error(`deposit row is '${d.status}', not processing — stop and look`)

    const already = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments
        WHERE flex_deposit_security_deposit_id = $1 AND type = 'fee'
          AND entry_description = 'FLEXDEP' AND status <> 'voided'`, [DEPOSIT_ID])
    if (already.rows[0].n !== '0') throw new Error('a FLEXDEP fee row already exists — nothing to split')

    // 1. the deposit line becomes her installment alone
    await client.query(
      `UPDATE payments
          SET amount = $2,
              notes = 'Security deposit — installment 1 of 4. Deposit line adopted into the'
                   || ' plan at enrollment, which came after this invoice was written.'
        WHERE id = $1`, [DEPOSIT_ROW, INSTALLMENT.toFixed(2)])

    // 2. GAM's fee, its own row, on the SAME charge and off the landlord's bill
    const fee = await client.query<{ id: string }>(
      `INSERT INTO payments (
         unit_id, lease_id, tenant_id, landlord_id,
         type, amount, status, due_date, entry_description, revenue_owner, notes,
         flex_deposit_security_deposit_id, stripe_payment_intent_id, platform_held,
         payment_channel
       ) VALUES ($1, $2, $3, $4, 'fee', $5, 'processing', $6::date, 'FLEXDEP', 'gam', $7, $8, $9, TRUE, 'online')
       RETURNING id`,
      [d.unit_id, d.lease_id, d.tenant_id, d.landlord_id, FEE.toFixed(2), d.due_date,
       `FlexDeposit service fee (deposit ${DEPOSIT_ID})`, DEPOSIT_ID, INTENT])
    const feeId = fee.rows[0].id

    // 3. the receipt still accounts for exactly what the bank is collecting
    await client.query(
      `UPDATE remittance_applications SET amount_applied = $3
        WHERE remittance_id = $1 AND payment_id = $2`,
      [REMITTANCE, DEPOSIT_ROW, INSTALLMENT.toFixed(2)])
    await client.query(
      `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied)
       VALUES ($1, $2, $3)`, [REMITTANCE, feeId, FEE.toFixed(2)])

    const check = await client.query<{ applied: string; amount: string; gross: string }>(
      `SELECT (SELECT COALESCE(SUM(amount_applied),0)::text FROM remittance_applications
                WHERE remittance_id = $1) AS applied,
              r.amount::text, r.gross_amount::text AS gross
         FROM tenant_remittances r WHERE r.id = $1`, [REMITTANCE])
    const c = check.rows[0]
    if (Math.round(Number(c.applied) * 100) !== Math.round(Number(c.amount) * 100)) {
      throw new Error(`applications now sum to $${c.applied} against a receipt of $${c.amount} — refusing`)
    }
    console.log(`\nreceipt still balances: applied $${c.applied} = receipt $${c.amount} (bank pulls $${c.gross})`)

    // 4. the bill's own figures
    await client.query(RETOTAL, [RENT_BILL])

    // 5. and MH 07 at Oak Park, same shape, no amounts touched
    const other = await client.query<{ id: string; invoice_number: string }>(
      `SELECT i.id, i.invoice_number FROM invoices i
        WHERE i.status <> 'void'
          AND (i.subtotal_rent + i.subtotal_fees + i.subtotal_utilities
               + i.subtotal_deposits + i.subtotal_home_payments) <> i.total_amount
          AND i.subtotal_deposits > 0
          AND i.id <> $1`, [RENT_BILL])
    for (const o of other.rows) {
      await client.query(RETOTAL, [o.id])
      console.log(`   re-totalled ${o.invoice_number}`)
    }

    const after = await client.query(
      `SELECT invoice_number, total_amount::float AS total,
              (subtotal_rent + subtotal_fees + subtotal_utilities
               + subtotal_deposits + subtotal_home_payments)::float AS parts,
              subtotal_deposits::float AS deposits, subtotal_fees::float AS fees
         FROM invoices WHERE id = $1`, [RENT_BILL])
    console.log('\nHER BILL AFTER'); after.rows.forEach(r => console.log('   ', r))

    const lines = await client.query(
      `SELECT type, amount::float AS amount, status, revenue_owner, entry_description,
              invoice_id IS NULL AS off_the_bill
         FROM payments
        WHERE flex_deposit_security_deposit_id = $1 OR invoice_id = $2
        ORDER BY type, amount`, [DEPOSIT_ID, RENT_BILL])
    console.log('LINES AFTER'); lines.rows.forEach(r => console.log('   ', r))

    await client.query(dry ? 'ROLLBACK' : 'COMMIT')
    console.log(dry ? '\n(dry run — nothing kept)' : '\napplied')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message || e); process.exit(1) })
