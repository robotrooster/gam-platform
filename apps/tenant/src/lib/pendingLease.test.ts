/**
 * S655 review — a lease waiting on someone who already lives under a lease.
 *
 * The nav's extra "Sign …" item was added for ANY unsigned document in their
 * pending list, which has no document type: a sitting tenant's purchase
 * agreement or add-a-roommate addendum read "Sign new lease", and so did a
 * brand-new tenant's own first lease. It also showed before the new landlord
 * had signed. On Home, another company's resident read "Your lease is waiting
 * on someone else" before anything had been sent to them, under a header
 * naming the home they live in now.
 */
import { describe, it, expect } from 'vitest'
import {
  leaseReachedMe, pendingDocHome, showsSigningNotice, signingNoticeHeading, waitingLeaseNavItem,
} from './pendingLease'

const NEW_LEASE = {
  documentId: 'doc-b', title: 'Lease — Mountain View RV Ranch RV 47',
  propertyName: 'Mountain View RV Ranch', unitNumber: 'RV 47', renewsLeaseId: null,
}
const PURCHASE = {
  documentId: 'doc-pa', title: 'Mattoon Installment Contract — MH 11',
  propertyName: 'Country Acres - Mattoon', unitNumber: 'MH 11', renewsLeaseId: null,
}

const myTurn = (docId: string, extra: any = {}) => ({
  pendingLeaseDocumentId: docId, pendingLeaseWaitingOnIsMe: true,
  pendingLeaseWaitingOnRole: 'primary', pendingLeaseWaitingOnName: 'Pat Doe',
  pendingLeaseSigners: [
    { name: 'Owner', role: 'landlord', signed: true, isMe: false },
    { name: 'Pat Doe', role: 'primary', signed: false, isMe: true },
  ],
  ...extra,
})
const landlordNotSignedYet = (docId: string, extra: any = {}) => ({
  pendingLeaseDocumentId: docId, pendingLeaseWaitingOnIsMe: false,
  pendingLeaseWaitingOnRole: 'landlord', pendingLeaseWaitingOnName: 'Owner',
  pendingLeaseSigners: [
    { name: 'Owner', role: 'landlord', signed: false, isMe: false },
    { name: 'Pat Doe', role: 'primary', signed: false, isMe: true },
  ],
  ...extra,
})
const iSignedWaitingOnRoommate = (docId: string, extra: any = {}) => ({
  pendingLeaseDocumentId: docId, pendingLeaseWaitingOnIsMe: false,
  pendingLeaseWaitingOnRole: 'co_tenant_1', pendingLeaseWaitingOnName: 'Sam Roe',
  pendingLeaseSigners: [
    { name: 'Owner', role: 'landlord', signed: true, isMe: false },
    { name: 'Pat Doe', role: 'primary', signed: true, isMe: true },
    { name: 'Sam Roe', role: 'co_tenant_1', signed: false, isMe: false },
  ],
  ...extra,
})

describe('the extra "Sign" nav item for someone who already lives under a lease', () => {
  it('appears for the lease waiting on their signature, labeled with its title', () => {
    expect(waitingLeaseNavItem([NEW_LEASE], myTurn('doc-b')))
      .toEqual({ documentId: 'doc-b', label: 'Sign: Lease — Mountain View RV Ranch RV 47' })
  })

  it('does not appear before the new landlord has signed', () => {
    expect(waitingLeaseNavItem([NEW_LEASE], landlordNotSignedYet('doc-b'))).toBeNull()
  })

  it('does not point at a purchase agreement or addendum that is not the waiting lease', () => {
    // A sitting tenant with a pending purchase agreement and no new lease.
    expect(waitingLeaseNavItem([PURCHASE], myTurn('doc-b'))).toBeNull()
    expect(waitingLeaseNavItem([PURCHASE], { pendingLeaseDocumentId: null })).toBeNull()
    // Both pending: the item is the waiting lease, never the other document.
    expect(waitingLeaseNavItem([PURCHASE, NEW_LEASE], myTurn('doc-b'))?.documentId).toBe('doc-b')
  })

  it('names the document for what it is when that is what is waiting', () => {
    expect(waitingLeaseNavItem([PURCHASE], myTurn('doc-pa'))?.label)
      .toBe('Sign: Mattoon Installment Contract — MH 11')
  })

  it("does not offer a brand-new tenant's own first lease as a new lease before it is their turn", () => {
    // The landlord's signature issued it (they have a unit now); a co-tenant signs first.
    const firstLease = { ...NEW_LEASE, documentId: 'doc-first' }
    const coTenantFirst = {
      pendingLeaseDocumentId: 'doc-first', pendingLeaseWaitingOnIsMe: false,
      pendingLeaseWaitingOnRole: 'primary', pendingLeaseWaitingOnName: 'Sam Roe',
      pendingLeaseSigners: [
        { name: 'Owner', role: 'landlord', signed: true, isMe: false },
        { name: 'Sam Roe', role: 'primary', signed: false, isMe: false },
        { name: 'Pat Doe', role: 'co_tenant_1', signed: false, isMe: true },
      ],
    }
    expect(waitingLeaseNavItem([firstLease], coTenantFirst)).toBeNull()
  })

  it('falls back to the home when the row has no title', () => {
    expect(waitingLeaseNavItem([{ ...NEW_LEASE, title: '' }], myTurn('doc-b'))?.label)
      .toBe('Sign new lease (Mountain View RV Ranch, Unit RV 47)')
  })

  it('has nothing to show while the pending list is loading', () => {
    expect(waitingLeaseNavItem(undefined, myTurn('doc-b'))).toBeNull()
  })
})

describe("the Home page's signing notice", () => {
  it("waits for another company's lease to reach them", () => {
    expect(showsSigningNotice(landlordNotSignedYet('doc-b', { pendingLeaseLocks: false }))).toBe(false)
    expect(showsSigningNotice(myTurn('doc-b', { pendingLeaseLocks: false }))).toBe(true)
    expect(showsSigningNotice(iSignedWaitingOnRoommate('doc-b', { pendingLeaseLocks: false }))).toBe(true)
  })

  it('still shows a new tenant where their own lease stands, as before', () => {
    // A brand-new tenant (the lease locks their portal) is told the landlord signs first.
    expect(showsSigningNotice(landlordNotSignedYet('doc-b', { pendingLeaseLocks: true }))).toBe(true)
    expect(showsSigningNotice(landlordNotSignedYet('doc-b', { pendingLeaseLocks: null }))).toBe(true)
  })

  it('shows nothing when no lease is waiting', () => {
    expect(showsSigningNotice({ pendingLeaseDocumentId: null })).toBe(false)
    expect(showsSigningNotice(undefined)).toBe(false)
  })

  it('names the home the new lease is for in its heading', () => {
    expect(signingNoticeHeading(true, pendingDocHome(NEW_LEASE)))
      .toBe('Your lease for Mountain View RV Ranch, Unit RV 47 is ready for your signature')
    expect(signingNoticeHeading(false, 'Mountain View RV Ranch, Unit RV 47'))
      .toBe('Your lease for Mountain View RV Ranch, Unit RV 47 is waiting on someone else')
    expect(signingNoticeHeading(true, null)).toBe('Your lease is ready for your signature')
  })
})

describe('whether the lease has reached them', () => {
  it('is their turn, or they signed and it waits on someone after them', () => {
    expect(leaseReachedMe(myTurn('doc-b'))).toBe(true)
    expect(leaseReachedMe(iSignedWaitingOnRoommate('doc-b'))).toBe(true)
    expect(leaseReachedMe(landlordNotSignedYet('doc-b'))).toBe(false)
    expect(leaseReachedMe({})).toBe(false)
  })
})
