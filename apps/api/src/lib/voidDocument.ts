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
import { lockLeaseHousehold, unwindIssuedLease } from './unwindIssuedLease'

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[] }>

async function refuseUnvoidable(q: Q, doc: any): Promise<void> {
  if (doc.status === 'completed') throw new AppError(400, 'Cannot void a completed document')
  if (doc.status === 'voided') throw new AppError(400, 'Document is already voided')

  const tenantSigned = await q(
    "SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND signed_at IS NOT NULL AND role NOT IN ('landlord','witness') LIMIT 1",
    [doc.id]).then(r => r.rows[0])
  if (tenantSigned) throw new AppError(409, 'Cannot void after a tenant has signed — create a superseding document instead')
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
  const live = (await q(`SELECT * FROM lease_documents WHERE id = $1 FOR UPDATE`, [doc.id])).rows[0]
  if (live) {
    await refuseUnvoidable(q, live)
    doc = { ...doc, ...live }
  }

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
  //    three skip. See the migration for the Lot 1 case that found it.
}
