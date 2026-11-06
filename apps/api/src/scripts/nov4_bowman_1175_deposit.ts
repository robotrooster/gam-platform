/**
 * 11/4 — RECORD THE BOWMANS' $1,175 BANK DEPOSIT (MH 30, Country Acres).
 *
 * Nic, 11/4: "Mark that as a payment of $1,175." The money was deposited
 * straight into Mattoon's bank account, which GAM cannot see — TruBlu has no
 * bank feed connected (only Mountain View and Oak Park do), so nothing matched
 * it automatically and it was never recorded.
 *
 * It goes in through the ordinary desk path (settleManualRentPayment), exactly
 * as Blu's $550 deposit on 10/05 did: household scope, oldest bill first,
 * anything over the balance kept as credit for the next bill.
 *
 * THE DATE is the one Nic gave for this deposit (10/16). He said he does not
 * remember it exactly; a bank deposit is normally told apart by the reference
 * on the bank's receipt and we do not have one. Both are correctable — the
 * receipt can be undone and re-recorded once Blu has the bank slip.
 *
 * Scoped to ONE household, and it refuses to touch anything else. Dry run by
 * default; pass --apply to write.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_bowman_1175_deposit.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_bowman_1175_deposit.ts --apply
 */
import { getClient } from '../db'
import { settleManualRentPayment } from '../services/manualPaymentSettle'

const LEASE_ID = '925c4847-9434-40b5-a6cf-94637ed7bea5'   // MH 30, Jeff + Kim Bowman
const UNIT_NUMBER = 'MH 30'
const AMOUNT = 1175
const DEPOSITED_ON = '2026-10-16'
const TAKEN_BY = 'aaeddccf-3778-4ca1-8772-ecc775f42554'   // Blu Haws, who records this park's deposits
const APPLY = process.argv.includes('--apply')

async function main() {
  const client = await getClient()
  try {
    const dbName = (await client.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n
    console.log(`database: ${dbName}`)
    console.log(APPLY ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)')

    await client.query('BEGIN')

    // Anchor on the household's oldest open charge, the way the desk does when
    // it opens the payment window on a bill.
    const pmt = (await client.query<any>(
      `SELECT p.id, p.landlord_id, p.tenant_id, p.unit_id, p.lease_id, p.due_date::text AS due_date,
              p.type, p.amount::text AS amount, p.status, u.unit_number
         FROM payments p JOIN units u ON u.id = p.unit_id
        WHERE p.lease_id = $1 AND p.status IN ('pending','failed')
          AND p.work_trade_suspended_at IS NULL AND p.voided_at IS NULL
        ORDER BY p.due_date, p.created_at
        LIMIT 1`, [LEASE_ID])).rows[0]

    if (!pmt) throw new Error('this household has no open charge to record against')
    if (pmt.unit_number !== UNIT_NUMBER) {
      throw new Error(`refusing: expected ${UNIT_NUMBER}, found ${pmt.unit_number}`)
    }

    const before = (await client.query<any>(
      `SELECT p.type, p.amount::text AS amount, p.status, p.due_date::text AS due_date,
              (p.amount - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                                     WHERE cu.payment_id = p.id AND cu.status = 'applied'), 0))::text AS owed
         FROM payments p
        WHERE p.lease_id = $1 AND p.status IN ('pending','failed') AND p.voided_at IS NULL
        ORDER BY p.due_date, p.type`, [LEASE_ID])).rows
    console.log('\nopen before:')
    let total = 0
    for (const r of before) { total += Number(r.owed); console.log(`  ${r.due_date}  ${r.type.padEnd(13)} $${r.owed}`) }
    console.log(`  ${''.padEnd(25)}———— $${total.toFixed(2)} owed`)
    console.log(`\nrecording $${AMOUNT.toFixed(2)} bank deposit, deposited ${DEPOSITED_ON}`)

    const result = await settleManualRentPayment(client, {
      payment: pmt,
      method: 'bank_deposit',
      settledAt: new Date(`${DEPOSITED_ON}T12:00:00Z`),
      // A bank deposit is told apart by the reference on the bank's receipt and
      // we do not have the slip yet, so this one is marked plainly as provisional
      // rather than given a number that could be mistaken for the bank's own.
      reference: 'TO-CONFIRM-20261104',
      settleHousehold: true,
      billIds: null,
      amountTendered: AMOUNT,
      // Over the balance goes on the account for the next bill, not handed back.
      surplusHandling: 'credit',
      creditToUse: null,
      towardOldBalance: null,
      // The deposit is over the balance on purpose: the owner confirmed the
      // figure, and the rest rides ahead to December.
      confirmWrittenAmount: true,
      takenBy: TAKEN_BY,
      source: 'desk',
      depositedOn: DEPOSITED_ON,
      lateFeeDeleteVia: 'record_payment',
      notes: 'Deposited directly at the bank. Recorded 11/4 on the owner\'s instruction; '
           + 'the bank reference and exact date are to be confirmed from the deposit slip.',
      sendReceipt: false,
    })

    console.log(`\nsettled rows      ${result.settledPaymentIds.length}`)
    console.log(`money on charges  $${result.amountSettled.toFixed(2)}`)
    console.log(`credit spent      $${result.creditUsed.toFixed(2)}`)
    console.log(`toward old bal    $${result.towardOldBalance.toFixed(2)}`)
    console.log(`surplus to credit $${result.surplus.toFixed(2)}`)

    const after = (await client.query<any>(
      `SELECT p.type, p.amount::text AS amount, p.status, p.due_date::text AS due_date
         FROM payments p
        WHERE p.lease_id = $1 AND p.status IN ('pending','failed') AND p.voided_at IS NULL
        ORDER BY p.due_date, p.type`, [LEASE_ID])).rows
    console.log('\nstill open after:')
    if (!after.length) console.log('  (nothing)')
    for (const r of after) console.log(`  ${r.due_date}  ${r.type.padEnd(13)} $${r.amount}  ${r.status}`)

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

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
