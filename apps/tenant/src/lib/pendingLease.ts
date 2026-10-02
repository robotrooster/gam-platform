/**
 * S655: what the tenant portal shows about a lease waiting on someone's
 * signature, decided in one place so the nav, the Home page and the
 * utility-service Home page agree.
 *
 * `me` is GET /tenants/me (camelized). A pending-document row is one entry of
 * GET /esign/pending (camelized): documentId, title, propertyName, unitNumber,
 * renewsLeaseId, …
 */

/**
 * The lease has reached them: it is their turn, or they have signed and it is
 * waiting on someone after them. Before the landlord signs, nothing has been
 * sent to them (S647), so there is nothing to tell them yet.
 */
export function leaseReachedMe(me: any): boolean {
  if (!me?.pendingLeaseDocumentId) return false
  if (me.pendingLeaseWaitingOnIsMe) return true
  return (Array.isArray(me.pendingLeaseSigners) ? me.pendingLeaseSigners : [])
    .some((r: any) => r?.isMe && r?.signed)
}

/** "Mountain View RV Ranch, Unit RV 47" from a pending-document row. */
export function pendingDocHome(row: any): string | null {
  if (!row) return null
  const parts = [row.propertyName, row.unitNumber ? `Unit ${row.unitNumber}` : null].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/**
 * The extra nav item for somebody who already lives under a lease (their own,
 * or another company's), or null for none.
 *
 * Only the document the portal itself says is waiting on them
 * (pendingLeaseDocumentId), and only once it has reached them. Any other
 * unsigned document (a purchase agreement, an add-a-roommate addendum, a packet
 * disclosure) is not that, and neither is a lease still waiting on the landlord.
 * Their own first lease, already issued by the landlord's signature, is the
 * "Lease" item itself; it never reaches them here, because when it is their
 * turn the portal takes them straight to signing (the S648 lock-in).
 *
 * Labeled with the document's own title, so they can tell what it is and
 * which home it is for.
 */
export function waitingLeaseNavItem(rows: any[] | null | undefined, me: any): { documentId: string; label: string } | null {
  if (!leaseReachedMe(me)) return null
  const row = (Array.isArray(rows) ? rows : [])
    .find((d: any) => d?.documentId && d.documentId === me?.pendingLeaseDocumentId)
  if (!row) return null
  const home = pendingDocHome(row)
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const label = title ? `Sign: ${title}` : `Sign new lease${home ? ` (${home})` : ''}`
  return { documentId: row.documentId, label }
}

/**
 * Whether the Home page shows the signing notice. A lease from ANOTHER company
 * (pendingLeaseLocks false: they already live somewhere on GAM, so it does not
 * take their portal over) shows only once it has reached them, the same as on
 * the utility-service Home page. Everyone else keeps the notice as before.
 */
export function showsSigningNotice(me: any): boolean {
  if (!me?.pendingLeaseDocumentId) return false
  return me.pendingLeaseLocks !== false || leaseReachedMe(me)
}

/** The notice's heading; names the home when it is known. */
export function signingNoticeHeading(mine: boolean, home: string | null): string {
  const whichLease = home ? `Your lease for ${home}` : 'Your lease'
  return mine ? `${whichLease} is ready for your signature` : `${whichLease} is waiting on someone else`
}
