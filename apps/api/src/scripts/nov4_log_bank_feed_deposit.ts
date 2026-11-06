/**
 * 11/4 — RECORD A TENANT DEPOSIT THAT THE BANK FEED SHOWS AND GAM DOES NOT.
 *
 * TruBlu's bank (First Mid Bank & Trust) was linked on 11/4 at 15:54, and the
 * feed immediately showed deposits GAM had never been told about — residents
 * at Country Acres walk cash and checks into the branch, and with no feed there
 * was nothing to match them against. This records one of them through the
 * ordinary desk path (settleManualRentPayment): household scope, oldest bill
 * first, anything over the balance kept as credit.
 *
 * The amount, the date and the reference all come from the bank row, so the
 * receipt says what the bank says.
 *
 * Takes the lease and the bank transaction id, refuses anything that does not
 * line up, and is a dry run unless --apply is passed.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_log_bank_feed_deposit.ts <leaseId> <bankTxnId>
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_log_bank_feed_deposit.ts <leaseId> <bankTxnId> --apply
 */
import { getClient, query } from '../db'
import { settleManualRentPayment } from '../services/manualPaymentSettle'

const [, , LEASE_ID, BANK_TXN_ID] = process.argv
const APPLY = process.argv.includes('--apply')
const TAKEN_BY = 'aaeddccf-3778-4ca1-8772-ecc775f42554'   // Blu Haws, who records this park's deposits

async function main() {
  if (!LEASE_ID || !BANK_TXN_ID) throw new Error('usage: <leaseId> <bankTxnId> [--apply]')

  // query() resolves to the ROWS, not a result object.
  const txn = (await query<any>(
    `SELECT id, external_id, posted_date::text AS posted_date, amount::text AS amount, landlord_id,
            matched_payment_id, COALESCE(description, '') AS description
       FROM bank_transactions WHERE id = $1`, [BANK_TXN_ID]))[0]
  if (!txn) throw new Error('no such bank transaction')
  if (Number(txn.amount) <= 0) throw new Error('that bank row is not a deposit')
  if (txn.matched_payment_id) throw new Error('that bank row is already matched to a payment')

  const client = await getClient()
  try {
    const dbName = (await client.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n
    console.log(`database: ${dbName}`)
    console.log(APPLY ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)')
    console.log(`\nbank row  ${txn.posted_date}  $${txn.amount}  ${txn.description}`)

    await client.query('BEGIN')

    const pmt = (await client.query<any>(
      `SELECT p.id, p.landlord_id, p.tenant_id, p.unit_id, p.lease_id, p.due_date::text AS due_date, u.unit_number
         FROM payments p JOIN units u ON u.id = p.unit_id
        WHERE p.lease_id = $1 AND p.status IN ('pending','failed')
          AND p.work_trade_suspended_at IS NULL AND p.voided_at IS NULL
        ORDER BY p.due_date, p.created_at
        LIMIT 1`, [LEASE_ID])).rows[0]
    if (!pmt) throw new Error('this household has no open charge to record against')
    if (pmt.landlord_id !== txn.landlord_id) throw new Error('that bank row belongs to a different landlord')

    const owedBefore = (await client.query<any>(
      `SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                                                 WHERE cu.payment_id = p.id AND cu.status = 'applied'), 0)), 0)::text AS owed
         FROM payments p
        WHERE p.lease_id = $1 AND p.status IN ('pending','failed') AND p.voided_at IS NULL`, [LEASE_ID])).rows[0].owed
    console.log(`unit ${pmt.unit_number} owes $${owedBefore} before this`)

    const result = await settleManualRentPayment(client, {
      payment: pmt,
      method: 'bank_deposit',
      settledAt: new Date(`${txn.posted_date}T12:00:00Z`),
      reference: txn.external_id,
      settleHousehold: true,
      billIds: null,
      amountTendered: Number(txn.amount),
      surplusHandling: 'credit',
      creditToUse: null,
      towardOldBalance: null,
      confirmWrittenAmount: true,
      takenBy: TAKEN_BY,
      source: 'desk',
      depositedOn: txn.posted_date,
      lateFeeDeleteVia: 'record_payment',
      notes: `Deposited at the bank. Confirmed against the bank feed: posted ${txn.posted_date}, $${txn.amount}.`,
      sendReceipt: false,
    })

    console.log(`\nmoney on charges  $${result.amountSettled.toFixed(2)}`)
    console.log(`toward old bal    $${result.towardOldBalance.toFixed(2)}`)
    console.log(`surplus to credit $${result.surplus.toFixed(2)}`)

    const owedAfter = (await client.query<any>(
      `SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                                                 WHERE cu.payment_id = p.id AND cu.status = 'applied'), 0)), 0)::text AS owed
         FROM payments p
        WHERE p.lease_id = $1 AND p.status IN ('pending','failed') AND p.voided_at IS NULL`, [LEASE_ID])).rows[0].owed
    console.log(`\nowes $${owedAfter} after this`)

    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? '\nCOMMITTED' : '\nrolled back (dry run)')
    if (APPLY) await result.afterCommit().catch((e: any) => console.error('after-commit:', e?.message ?? e))
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })
