/**
 * S652 — ONE WAY TO VOID A DOCUMENT.
 *
 * The body of POST /documents/:id/void, lifted out so anything that voids —
 * the button, or a cleanup script working through a whole packet — runs the
 * identical steps. A second copy of this list is how steps go missing, and one
 * already had: see step 4.
 *
 * Called inside an open transaction. Refuses a completed document, an already
 * voided one, and one a TENANT has signed (from there the clean path is a
 * superseding document; a landlord-only signature binds nobody — S558).
 * Sends nothing to anybody.
 */
import { AppError } from '../middleware/errorHandler'
import { cascadeLeaseTenantsOnVoid } from './leaseDocCascade'
import { lockLeaseHousehold, unwindIssuedLease, paymentTriedSql } from './unwindIssuedLease'
import { lockHousehold } from '../services/moneyPredicates'
import { voidUnowedChargesOrRefuse } from '../services/chargeVoids'
import { eraseUnfinishedDocument, type ErasedDocument } from './eraseUnfinishedDocument'

/** Why a home payment of a sale whose agreement was voided is not owed (payments.void_reason). */
export const HOME_SALE_VOIDED_CHARGE_REASON =
  'The installment contract it was billed under was voided, so the sale was cancelled and it is not owed.'

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[] }>

async function refuseUnvoidable(q: Q, doc: any): Promise<void> {
  if (doc.status === 'completed') throw new AppError(400, 'Cannot void a completed document')
  if (doc.status === 'voided') throw new AppError(400, 'Document is already voided')

  const tenantSigned = await q(
    "SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND signed_at IS NOT NULL AND role NOT IN ('landlord','witness') LIMIT 1",
    [doc.id]).then(r => r.rows[0])
  if (tenantSigned) throw new AppError(409, 'Cannot void after a tenant has signed — create a superseding document instead')
}

/** What ending a document did: erased (with what went with it), or voided. */
export type DocumentEndOutcome =
  | { deleted: true; documents: ErasedDocument[]; files: string[] }
  | { deleted: false }

/**
 * 10/13 (Nic): "If it never completed, it doesn't exist." THE ONE WAY TO END
 * A DOCUMENT that should not be signed: ERASED when it never completed and no
 * money touched it (lib/eraseUnfinishedDocument — with its packet's other
 * unfinished documents when it is the packet's lease), VOIDED below otherwise,
 * exactly as before. "Going forward, the app deletes such documents instead of
 * voiding them": anything that ends a document calls this, not voidDocument —
 * voidDocument is for a caller that must keep the record whatever it is.
 *
 * Inside the caller's open transaction. A completed or already voided document
 * is refused as the void always refused it, before anything is locked. Files
 * only the erased documents used are the caller's to remove after COMMIT
 * (removeOrphanedDocumentFiles). Sends nothing to anybody.
 */
export async function endDocument(q: Q, doc: any, reason: string | null): Promise<DocumentEndOutcome> {
  if (doc.status === 'completed') throw new AppError(400, 'Cannot void a completed document')
  if (doc.status === 'voided') throw new AppError(400, 'Document is already voided')
  const erased = await eraseUnfinishedDocument(q, doc)
  if (erased.erased) return { deleted: true, documents: erased.documents, files: erased.files }
  await voidDocument(q, doc, reason)
  return { deleted: false }
}

export async function voidDocument(q: Q, doc: any, reason: string | null) {
  await refuseUnvoidable(q, doc)

  // 0. Lock order (S655): household, then the document, then its rows — the
  //    order the scheduler's cancel and hold of a new lease take. The cascade
  //    below writes lease_tenants rows before the unwind locks the household,
  //    so without this a manual void racing the scheduler on the same document
  //    took the locks in the opposite order and Postgres aborted one as a
  //    deadlock. The advisory lock is re-entrant: the unwind's own call is
  //    free. The document is then read again under its row lock — a tenant
  //    who signed a moment ago, or a void that already happened, is refused
  //    on the live row, not the copy the caller read.
  if (doc.lease_id) await lockLeaseHousehold(q, doc.lease_id)
  // The buyer's household too, when the paper is a home sale that is billing
  // or may start to (step 0.5) — still before the document's row lock. 10/12:
  // a sale still waiting counts, because the landlord's signature can start it
  // billing while this void runs; and a paid-off one, so the void can refuse it.
  const sale = doc.document_type === 'purchase_agreement'
    ? (await q(`SELECT id, tenant_id, landlord_id FROM home_sale_contracts
                 WHERE purchase_document_id = $1 AND status IN ('pending_signature', 'active', 'paid_off')
                 ORDER BY created_at DESC LIMIT 1`, [doc.id])).rows[0]
    : null
  if (sale) await lockHousehold({ query: q } as any, sale.tenant_id, sale.landlord_id)
  const live = (await q(`SELECT * FROM lease_documents WHERE id = $1 FOR UPDATE`, [doc.id])).rows[0]
  if (live) {
    await refuseUnvoidable(q, live)
    doc = { ...doc, ...live }
  }

  // 0.5. 10/12: a home sale the landlord's signature started billing.
  if (sale) await unwindHomeSaleOnVoid(q, sale.id)

  // 1. lease_tenants state, by document type.
  await cascadeLeaseTenantsOnVoid(q as any, doc)

  // 2. S647: a landlord-signed document has already issued a lease, an invoice
  //    and possibly a work-trade agreement.
  await unwindIssuedLease(q as any, doc)

  // 3. The document itself.
  await q(
    "UPDATE lease_documents SET status='voided', voided_at=NOW(), void_reason=$1, updated_at=NOW() WHERE id=$2",
    [reason, doc.id])

  // S581: a voided addendum's pending money changes must never reach billing.
  await q(
    `UPDATE scheduled_lease_changes SET status='cancelled', updated_at=NOW()
      WHERE source_document_id=$1 AND status IN ('draft','scheduled')`,
    [doc.id])

  // 4. The sale the agreement was for is cancelled by a TRIGGER on this very
  //    update (trg_cancel_unsigned_sale_on_void), not here — documents are voided
  //    from four places, and a rule written into one of them is a rule the other
  //    three skip. See the migration for the Lot 1 case that found it. (A sale
  //    already BILLING was taken back at step 0.5, which needs words a trigger
  //    cannot say — see unwindHomeSaleOnVoid.)
}

/**
 * 10/12 (Nic): "We need people to be billed correctly regardless of signing
 * status." The landlord's signature now starts a home sale billing
 * (services/homeSale activateHomeSaleContract), so an installment contract
 * only he has signed can have an ACTIVE sale behind it, with home payments on
 * the buyer's bill — and it can still be voided (a landlord-only signature
 * binds nobody, S558). Before, an active sale meant everybody had signed, and
 * the void trigger rightly left it alone; left alone now, the sale would keep
 * billing every month on paper that no longer exists.
 *
 * So voiding the agreement takes the sale back, the way voiding a lease the
 * landlord signed takes the lease back (unwindIssuedLease):
 *   - REFUSED, before anything changes, when a home payment from the sale was
 *     paid, is on its way, or had a payment tried on it (a card or bank
 *     attempt, a receipt, account credit set aside on it). Unwinding that is a
 *     refund, not a void. The landlord cancels the financing on the unit
 *     instead, and what was paid stays on record.
 *   - Otherwise each home payment still owed comes off the bill it is on
 *     (nothing was ever tried on it, the precedent unwindIssuedLease follows;
 *     the bill's totals come down by the same amount and its status follows
 *     what is left on it), and the sale is cancelled. 10/12 (Nic): the home
 *     payment is VOIDED as a record (status 'voided' with when and why,
 *     decisions #48.5 — services/chargeVoids), never deleted, and in no
 *     balance or total. Its installment lets go of it, as the delete's
 *     ON DELETE SET NULL did, so every reader of the schedule sees what it
 *     saw before; the payment still names its installment.
 *   - REFUSED when the sale is already recorded as paid off: the home has
 *     passed to the buyer, and a void cannot hand it back.
 * A sale still waiting for a signature is left to the void trigger, which
 * cancels it. Runs inside the void's transaction, under the buyer's household
 * lock. The status is read under the contract's row lock: voidDocument found
 * the sale without one, and a start committing at that moment (the schedule
 * written, the sale made active) must be seen and taken back here, not left to
 * the trigger, which can only refuse.
 */
export async function unwindHomeSaleOnVoid(q: Q, contractId: string): Promise<void> {
  const sale = (await q(
    `SELECT id, status FROM home_sale_contracts WHERE id = $1 FOR UPDATE`, [contractId])).rows[0]
  if (sale?.status === 'paid_off') {
    throw new AppError(409,
      'This home sale is already recorded as paid off and the home has passed to the buyer, so the contract can\'t be voided.')
  }
  if (sale?.status !== 'active') return
  const lines = (await q(
    `SELECT p.id, p.invoice_id, p.amount::text AS amount, p.status, ${paymentTriedSql('p')} AS tried
       FROM payments p
       JOIN home_sale_installments i ON i.id = p.home_sale_installment_id
      WHERE i.contract_id = $1
      ORDER BY p.id
      FOR UPDATE OF p`, [contractId])).rows as Array<{ id: string; invoice_id: string | null; amount: string; status: string; tried: boolean }>
  const moved = lines.filter(l => l.status !== 'voided' && (!['pending', 'failed'].includes(l.status) || l.tried))
  if (moved.length > 0) {
    throw new AppError(409,
      'A home payment from this installment contract has already been paid, or a payment was tried on it, ' +
      'so the contract can\'t be voided. Cancel the financed sale on the unit instead — what was paid stays on record.')
  }
  const owed = lines.filter(l => l.status === 'pending' || l.status === 'failed')
  // The sale is cancelled below, so its installments never bill again: each
  // voided home payment keeps naming the installment it billed.
  const voided = await voidUnowedChargesOrRefuse(q, owed.map(l => l.id), HOME_SALE_VOIDED_CHARGE_REASON,
    'A record still points at a home payment from this installment contract, so the contract can\'t be voided. ' +
    'Cancel the financed sale on the unit instead — what was paid stays on record.',
    { keepInstallmentLink: true })
  for (const v of voided) {
    if (v.invoiceId) {
      await q(
        `UPDATE invoices
            SET subtotal_home_payments = GREATEST(COALESCE(subtotal_home_payments, 0) - $2, 0),
                total_amount = total_amount - $2,
                updated_at = NOW()
          WHERE id = $1`, [v.invoiceId, v.amount.toFixed(2)])
    }
    // The installment has let go of it already, as the delete's ON DELETE SET
    // NULL did (10/12 review: voidUnowedCharges releases every voided home
    // payment's installment, for every path); the bill's status follows what
    // is left on it (trg_payments_invoice_status_rollup, which leaves voided
    // lines out).
  }
  await q(
    `UPDATE home_sale_contracts SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'active'`, [contractId])
}
