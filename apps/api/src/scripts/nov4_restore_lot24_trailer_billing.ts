/**
 * 11/4 — RESTORE ONE TRAILER CONTRACT THAT A CLEANUP JOB SWITCHED OFF.
 *
 * Country Acres MH 24. The buyer's installment contract (36 of 72 billed, 35
 * paid, $150/month) was CANCELLED at 2026-10-26 23:45:01 — not by anybody's
 * decision. Her purchase agreement was drafted 2026-09-22 and nobody signed
 * it, so the nightly 30-day unsigned-draft job (jobs/scheduler
 * endDocumentOnItsOwn) came for it. The erase refused to delete it because
 * money had already run through it, and the fallback VOIDED it instead —
 * and voiding a purchase agreement runs unwindHomeSaleOnVoid, which cancels
 * the contract behind it (lib/voidDocument). Her November installment was
 * therefore never written, and every month after it would have been skipped
 * too.
 *
 * Nic, 11/4: "If it's somebody else that's still living there, don't stop it.
 * Put the schedule back intact." Her lease is active to 2029, she has no
 * move-out notice, and she paid $670 at the bank on 10/16. The two residents
 * who DID move out are MH 18 and MH 28; their contracts ended correctly and
 * this script does not touch them.
 *
 * The 72-installment schedule was never damaged — only the contract's status
 * and the missing November charge. So this does exactly two things:
 *   1. puts the contract back to 'active' and clears cancelled_at;
 *   2. calls the ordinary biller, attachDueInstallmentsToOpenInvoices, which
 *      finds her still-open November bill and adds the $150 line the monthly
 *      run would have added. Nothing bespoke is written: same writer, same
 *      idempotency (the partial-unique index on payments.home_sale_installment_id).
 *
 * The void that caused this is fixed separately so it cannot recur: a cleanup
 * never voids paperwork money has run through.
 *
 * Scoped to ONE contract id, and it refuses to touch anything else. Dry run by
 * default; pass --apply to write.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_restore_lot24_trailer_billing.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_restore_lot24_trailer_billing.ts --apply
 */
import { db } from '../db'
import { attachDueInstallmentsToOpenInvoices } from '../services/homeSale'

const CONTRACT_ID = 'fdef0e04-98a4-4b0a-b03c-47dd174eeb12'
const UNIT_NUMBER = 'MH 24'
const PROPERTY_ID = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const APPLY = process.argv.includes('--apply')

async function main() {
  const dbName = (await db.query<{ n: string }>('SELECT current_database() AS n')).rows[0].n
  console.log(`database: ${dbName}`)
  console.log(APPLY ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)')

  // A sale contract normally carries no lease_id (most here are NULL): the
  // buyer's tenancy is found through the UNIT and the buyer, the way the
  // biller finds it.
  const c = (await db.query<any>(
    `SELECT c.id, c.status, c.monthly_payment::text AS monthly, c.installments_total,
            c.installments_billed, c.installments_paid, c.tracked_not_billed,
            c.cancelled_at::text AS cancelled_at, c.unit_id, c.tenant_id,
            u.unit_number, u.property_id,
            d.status AS doc_status,
            l.id AS lease_id, l.status AS lease_status,
            l.move_out_notice_at::text AS move_out_notice,
            l.terminated_at::text AS terminated
       FROM home_sale_contracts c
       JOIN units u ON u.id = c.unit_id
       LEFT JOIN lease_documents d ON d.id = c.purchase_document_id
       LEFT JOIN leases l
         ON l.unit_id = c.unit_id AND l.status = 'active'
        AND EXISTS (SELECT 1 FROM lease_tenants lt
                     WHERE lt.lease_id = l.id AND lt.tenant_id = c.tenant_id)
      WHERE c.id = $1`, [CONTRACT_ID])).rows[0]

  if (!c) throw new Error('that contract does not exist here')
  if (c.unit_number !== UNIT_NUMBER || c.property_id !== PROPERTY_ID) {
    throw new Error(`refusing: expected ${UNIT_NUMBER} at Country Acres, found ${c.unit_number}`)
  }
  if (c.tracked_not_billed) throw new Error('refusing: this contract is tracked, not billed')
  if (c.terminated || c.move_out_notice) {
    throw new Error('refusing: this household has moved out or given notice — a stopped contract is correct there')
  }
  if (c.lease_status !== 'active') throw new Error(`refusing: lease is ${c.lease_status}, not active`)

  console.log(`\ncontract ${c.id}`)
  console.log(`  unit            ${c.unit_number}`)
  console.log(`  status          ${c.status}  (cancelled_at ${c.cancelled_at ?? '-'})`)
  console.log(`  monthly         $${c.monthly}`)
  console.log(`  installments    ${c.installments_billed} billed / ${c.installments_paid} paid of ${c.installments_total}`)
  console.log(`  purchase doc    ${c.doc_status ?? '(none)'}`)
  console.log(`  lease           ${c.lease_status}, no move-out notice`)

  const unbilled = (await db.query<any>(
    `SELECT i.installment_number, i.billing_month::text AS billing_month, i.amount::text AS amount
       FROM home_sale_installments i
      WHERE i.contract_id = $1 AND i.payment_id IS NULL AND i.settled_off_platform_at IS NULL
        AND i.billing_month <= date_trunc('month', now())::date
      ORDER BY i.installment_number`, [CONTRACT_ID])).rows
  console.log(`\nunbilled installments already due: ${unbilled.length}`)
  for (const i of unbilled) console.log(`  #${i.installment_number}  ${i.billing_month}  $${i.amount}`)

  if (c.status === 'cancelled') {
    if (APPLY) {
      const r = await db.query(
        `UPDATE home_sale_contracts
            SET status = 'active', cancelled_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'cancelled'`, [CONTRACT_ID])
      console.log(`\nput back to active: ${r.rowCount} row(s)`)
    } else {
      console.log('\nwould put the contract back to active and clear cancelled_at')
    }
  } else {
    console.log(`\ncontract is already ${c.status} — leaving it alone`)
  }

  // The ordinary biller. Dry run does the whole thing and rolls it back.
  const out = await attachDueInstallmentsToOpenInvoices(CONTRACT_ID, { dryRun: !APPLY })
  console.log(`\n${APPLY ? 'billed' : 'would bill'} ${out.attached.length} installment(s):`)
  for (const a of out.attached) console.log(`  ${JSON.stringify(a)}`)

  const after = (await db.query<any>(
    `SELECT i.status, i.total_amount::text AS total
       FROM invoices i
      WHERE i.lease_id = $1 AND i.due_date = '2026-11-01'`, [c.lease_id])).rows[0]
  console.log(`\nNovember bill now: ${after ? `${after.status} $${after.total}` : '(none)'}`)
  if (!APPLY) console.log('(dry run — the biller rolled back; the status change above was not written either)')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
