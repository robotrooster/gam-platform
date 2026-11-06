/**
 * 11/4 — RECORD THE $90.00 BANK DEPOSIT ON MH 30 (Country Acres).
 *
 * Nic, 11/4: "90 dollars is bowman in place of the 100 dollars I argued with
 * you about."
 *
 * TruBlu's bank feed (linked 11/4) shows a $90.00 deposit posted 2026-10-16
 * that GAM never had. It is the payment that was meant to cover October's
 * water and late fee, and because it was missing, $89.60 of the later $1,175.00
 * deposit was used on October's trailer payment instead — which is why their
 * credit reads $510.65 when it should read $600.65.
 *
 * The household owes nothing now, so there is no charge to anchor a desk
 * payment on and nothing for the bank-match route to settle (it requires at
 * least one charge, and this row is already categorized rather than awaiting
 * review). The deposit is therefore recorded as money received that lands
 * entirely as paid-ahead credit, through createPaidAhead — the same writer the
 * desk's own surplus uses — with a remittance behind it so the money is on the
 * books and not a credit from nowhere.
 *
 * The attribution of WHICH deposit paid October is left as it stands; no figure
 * depends on it, and re-cutting settled applications would churn the ledger for
 * nothing. What changes is the total credit, which ends at $600.65 either way.
 *
 * Scoped to ONE lease and ONE bank row. Dry run unless --apply.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_bowman_90_deposit.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_bowman_90_deposit.ts --apply
 */
import { getClient } from '../db'
import { createPaidAhead } from '../services/creditUse'

const LEASE_ID = '925c4847-9434-40b5-a6cf-94637ed7bea5'   // MH 30
const UNIT_NUMBER = 'MH 30'
const BANK_TXN_ID = 'a3fd4cb7-0596-49cb-ab82-6126227e1642' // $90.00, posted 2026-10-16
const TAKEN_BY = 'aaeddccf-3778-4ca1-8772-ecc775f42554'    // Blu Haws
const APPLY = process.argv.includes('--apply')

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

    const lease = (await client.query<any>(
      `SELECT l.id, l.landlord_id, u.unit_number,
              (SELECT lt.tenant_id FROM lease_tenants lt
                WHERE lt.lease_id = l.id AND lt.status = 'active'
                ORDER BY (lt.role = 'primary') DESC LIMIT 1) AS tenant_id
         FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`, [LEASE_ID])).rows[0]
    if (!lease) throw new Error('that lease does not exist here')
    if (lease.unit_number !== UNIT_NUMBER) throw new Error(`refusing: expected ${UNIT_NUMBER}`)
    if (lease.landlord_id !== txn.landlord_id) throw new Error('that bank row belongs to a different landlord')
    if (!lease.tenant_id) throw new Error('no resident on that lease')

    const owed = (await client.query<any>(
      `SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                                                 WHERE cu.payment_id = p.id AND cu.status = 'applied'), 0)), 0)::text AS owed
         FROM payments p
        WHERE p.lease_id = $1 AND p.status IN ('pending','failed') AND p.voided_at IS NULL`, [LEASE_ID])).rows[0].owed
    console.log(`\nbank row  ${txn.posted_date}  $${txn.amount}`)
    console.log(`${lease.unit_number} owes $${owed} — this deposit lands as credit`)
    if (Number(owed) > 0) {
      throw new Error('this household now owes something; record it through the desk path instead so it pays the bill first')
    }

    const rem = (await client.query<{ id: string }>(
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
          payment_method, settled_at, reference, notes, received_by, processing_fee_amount)
       VALUES ($1, $2, $3, $4::numeric, 0, $4::numeric, 'settled', 'bank_deposit', $5::date, $6, $7, $8, 0)
       RETURNING id`,
      [lease.tenant_id, LEASE_ID, lease.landlord_id, Number(txn.amount).toFixed(2),
       txn.posted_date, txn.external_id,
       `Deposited at the bank. Confirmed against the bank feed: posted ${txn.posted_date}, `
         + `$${Number(txn.amount).toFixed(2)}. Nothing was owed, so it is held for the next bill.`,
       TAKEN_BY])).rows[0]

    const creditId = await createPaidAhead(client, {
      leaseId: LEASE_ID,
      tenantId: lease.tenant_id,
      amount: Number(txn.amount),
      fundedBy: 'landlord',
      receivedAt: `${txn.posted_date}T12:00:00Z`,
      sourceRemittanceId: rem.id,
      note: `Paid ahead at the desk (bank deposit ${txn.posted_date}, $${Number(txn.amount).toFixed(2)})`,
    })
    console.log(`remittance ${rem.id}\ncredit     ${creditId}`)

    const after = (await client.query<any>(
      `SELECT COALESCE(SUM(amount_remaining), 0)::text AS credit FROM lease_prepaid_credits
        WHERE lease_id = $1 AND voided_at IS NULL`, [LEASE_ID])).rows[0].credit
    const paid = (await client.query<any>(
      `SELECT COALESCE(SUM(amount), 0)::text AS paid FROM tenant_remittances
        WHERE lease_id = $1 AND status = 'settled' AND undone_at IS NULL`, [LEASE_ID])).rows[0].paid
    console.log(`\npaid in total  $${paid}`)
    console.log(`credit on hand $${after}`)

    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? '\nCOMMITTED' : '\nrolled back (dry run)')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })
