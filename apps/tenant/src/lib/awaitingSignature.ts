/**
 * Final sweep (10/3): the Lease page's "awaiting your signature" row.
 *
 * GET /esign/pending deliberately lists documents that have not reached the
 * person yet (signer status 'pending', S636), so the landlord can see a draft
 * nobody sent. The Lease page showed the FIRST row of that list as "Document
 * Awaiting Your Signature — Sign Now", which could be a lease the new landlord
 * had not signed yet (the server then answers "Not your turn"), or a purchase
 * agreement listed ahead of the lease the portal is actually waiting on. With
 * no lease on file it also said "Your landlord has already signed" when they
 * had not.
 *
 * Rows are GET /esign/pending entries (camelized): documentId, status (the
 * signer's own status), title, propertyName, unitNumber, renewsLeaseId, …
 * `me` is GET /tenants/me (camelized).
 */

/** It is this person's turn on the document: it has been sent to them. */
export function isMyTurn(row: any): boolean {
  return row?.status === 'sent' || row?.status === 'viewed'
}

/**
 * The document to show as waiting on their signature, or null for none.
 *
 * Only documents that have reached them (their signer row is 'sent' or
 * 'viewed'). Among those, the one the portal says is waiting on them
 * (me.pendingLeaseDocumentId) comes first; otherwise the newest (the list is
 * newest first). A new lease for the home they already live in is left out:
 * the page shows it as their next lease, with its own button.
 */
export function awaitingSignatureRow(rows: any[] | null | undefined, me: any): any | null {
  const mine = (Array.isArray(rows) ? rows : [])
    .filter((d: any) => d?.documentId && !d.renewsLeaseId && isMyTurn(d))
  if (!mine.length) return null
  const waiting = me?.pendingLeaseDocumentId
    ? mine.find((d: any) => d.documentId === me.pendingLeaseDocumentId)
    : undefined
  return waiting ?? mine[0]
}

/**
 * A document (not a renewal) that names them as a signer but has not reached
 * them yet: someone before them signs first. Used only to say "on its way"
 * instead of "No lease on file yet" when they have no lease.
 */
export function leaseOnItsWay(rows: any[] | null | undefined): boolean {
  return (Array.isArray(rows) ? rows : [])
    .some((d: any) => d?.documentId && !d.renewsLeaseId && d.status === 'pending')
}
