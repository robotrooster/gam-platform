/**
 * 11/4 — GIVE NATHAN'S SEPTEMBER $500 THE $100 OF MONEY IT WAS MISSING.
 *
 * THE SYMPTOM: the books say MH 29 owes $269.80 of carried balance; the money
 * records say $169.80. Every other figure on him ties to the cent — space rent
 * $278.05, water $41.25, trailer $200, late fees $0.
 *
 * THE CAUSE: the 11/1 arrears script (nov1_country_acres_september_collected)
 * marked a $500.00 carried-balance row SETTLED, but only $400.00 of receipts
 * were ever recorded behind it — the Oct 5 bank deposit. He had also paid $100
 * on Sept 3, and that one was never written down as money at all, because
 * TruBlu had no bank feed then and nobody keyed it. So the ledger saw $400 of
 * money against a $669.80 opening balance and carried $269.80 forward, while
 * the records, reading the settled row, say $169.80. The $100 gap is exactly
 * that deposit.
 *
 * TruBlu's bank feed was linked on 11/4 and shows it: $100.00 posted
 * 2026-09-03. This records it as the receipt it always was, against the row it
 * always paid.
 *
 * WHAT THIS DOES NOT DO: it does not change what he owes. The row is already
 * settled and stays settled; his balance is $689.10 before and after. All this
 * adds is the money behind a settlement that was asserted without it — which is
 * what closes the books against the records.
 *
 * Scoped to ONE row and ONE bank transaction. Dry run unless --apply.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_nathan_sept_100_receipt.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_nathan_sept_100_receipt.ts --apply
 */
import { getClient } from '../db'

const LEASE_ID = 'a781dc3b-3c9e-4249-8a00-6fbdc21e0d76'    // MH 29
const CHARGE_ID = '76505f83-d577-432d-89c3-948735712604'   // the $500 settled carried_balance row
const BANK_TXN_ID = 'a98b424f-f0fd-4f9f-96dd-ee6cb3dec35f' // $100.00, posted 2026-09-03
const TAKEN_BY = 'aaeddccf-3778-4ca1-8772-ecc775f42554'    // Blu Haws
const APPLY = process.argv.includes('--apply')

const booksCarried = async (c: any) => (await c.query(
  `SELECT COALESCE(ROUND(SUM(pl.debit - pl.credit), 2), 0)::text AS n
     FROM ledger_posting_lines pl
    WHERE pl.lease_id = $1 AND pl.account_role = 'ar_tenants'
      AND pl.report_category = 'balances_collected'`, [LEASE_ID])).rows[0].n

const recordsCarried = async (c: any) => (await c.query(
  `SELECT COALESCE(SUM(amount), 0)::text AS n FROM payments
    WHERE lease_id = $1 AND type = 'carried_balance'
      AND status IN ('pending','failed') AND voided_at IS NULL`, [LEASE_ID])).rows[0].n

async function main() {
  const client = await getClient()
  try {
    const dbName = (await client.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n
    console.log(`database: ${dbName}`)
    console.log(APPLY ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)')

    await client.query('BEGIN')

    const txn = (await client.query<any>(
      `SELECT id, external_id, amount::text AS amount, posted_date::text AS posted_date, landlord_id
         FROM bank_transactions WHERE id = $1 FOR UPDATE`, [BANK_TXN_ID])).rows[0]
    if (!txn) throw new Error('no such bank transaction')

    const chg = (await client.query<any>(
      `SELECT p.id, p.lease_id, p.tenant_id, p.landlord_id, p.type, p.status, p.amount::text AS amount,
              COALESCE((SELECT SUM(ra.amount_applied) FROM remittance_applications ra
                         WHERE ra.payment_id = p.id), 0)::text AS backed
         FROM payments p WHERE p.id = $1 FOR UPDATE`, [CHARGE_ID])).rows[0]
    if (!chg) throw new Error('that charge does not exist here')
    if (chg.lease_id !== LEASE_ID) throw new Error('refusing: that charge is not on MH 29')
    if (chg.type !== 'carried_balance' || chg.status !== 'settled') {
      throw new Error(`refusing: expected a settled carried_balance, found ${chg.status} ${chg.type}`)
    }
    const short = Number(chg.amount) - Number(chg.backed)
    console.log(`\ncharge ${chg.type} $${chg.amount} ${chg.status} — $${chg.backed} of money behind it, short $${short.toFixed(2)}`)
    if (Math.abs(short - Number(txn.amount)) > 0.005) {
      throw new Error(`refusing: the shortfall ($${short.toFixed(2)}) is not this deposit ($${txn.amount})`)
    }

    console.log(`\nbefore   books $${await booksCarried(client)}   records $${await recordsCarried(client)}`)

    const rem = (await client.query<{ id: string }>(
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
          payment_method, settled_at, reference, notes, received_by, processing_fee_amount)
       VALUES ($1, $2, $3, $4::numeric, $4::numeric, 0, 'settled', 'bank_deposit', $5::date, $6, $7, $8, 0)
       RETURNING id`,
      [chg.tenant_id, LEASE_ID, chg.landlord_id, Number(txn.amount).toFixed(2), txn.posted_date,
       txn.external_id,
       `Deposited at the bank ${txn.posted_date}. Recorded 11/4 from the bank feed: this money was always `
         + 'behind September’s settled balance, but was never written down as a receipt.',
       TAKEN_BY])).rows[0]

    await client.query(
      `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied)
       VALUES ($1, $2, $3::numeric)`, [rem.id, CHARGE_ID, Number(txn.amount).toFixed(2)])

    const backedNow = (await client.query<any>(
      `SELECT COALESCE(SUM(amount_applied), 0)::text AS n FROM remittance_applications WHERE payment_id = $1`,
      [CHARGE_ID])).rows[0].n
    console.log(`\nreceipt ${rem.id}`)
    console.log(`charge now has $${backedNow} of money behind $${chg.amount}`)
    console.log(`after    books $${await booksCarried(client)}   records $${await recordsCarried(client)}`)

    const owes = (await client.query<any>(
      `SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                                                 WHERE cu.payment_id = p.id AND cu.status = 'applied'), 0)), 0)::text AS n
         FROM payments p WHERE p.lease_id = $1 AND p.status IN ('pending','failed') AND p.voided_at IS NULL`,
      [LEASE_ID])).rows[0].n
    console.log(`he owes $${owes} (unchanged by this)`)

    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? '\nCOMMITTED' : '\nrolled back (dry run)')

    // The books do not move inside the transaction: the capture triggers only
    // queue the source into ledger_outbox, and the engine posts it afterwards.
    // Drain it here so the result is verified rather than assumed.
    if (APPLY) {
      const { drainLedgerOutbox } = await import('../services/ledgerEngine')
      const d = await drainLedgerOutbox({ ownerId: chg.landlord_id, ignoreBackoff: true })
      console.log(`\nledger drained: ${JSON.stringify(d)}`)
      console.log(`books  $${await booksCarried(client)}   records  $${await recordsCarried(client)}`)
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })
