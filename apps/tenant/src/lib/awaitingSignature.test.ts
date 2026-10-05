/**
 * Final sweep (10/3) — the Lease page's "awaiting your signature" row.
 *
 * It showed the first row of GET /esign/pending, which also lists documents
 * that have not reached the person yet: a lease the new landlord had not
 * signed ("Sign Now", then "Not your turn"), or a purchase agreement ahead of
 * the lease the portal is waiting on.
 */
import { describe, it, expect } from 'vitest'
import { awaitingSignatureRow, isMyTurn, leaseOnItsWay } from './awaitingSignature'

const row = (documentId: string, status: string, extra: Record<string, unknown> = {}) => ({
  documentId, status, title: `Doc ${documentId}`, propertyName: 'Mountain View RV Ranch', unitNumber: 'RV 47',
  renewsLeaseId: null, ...extra,
})

describe('isMyTurn', () => {
  it('only a document sent to them, or one they opened', () => {
    expect(isMyTurn(row('a', 'sent'))).toBe(true)
    expect(isMyTurn(row('a', 'viewed'))).toBe(true)
    expect(isMyTurn(row('a', 'pending'))).toBe(false)
    expect(isMyTurn(row('a', 'signed'))).toBe(false)
    expect(isMyTurn(null)).toBe(false)
  })
})

describe('awaitingSignatureRow', () => {
  it('never shows a lease the landlord has not signed yet', () => {
    expect(awaitingSignatureRow([row('lease', 'pending')], { pendingLeaseDocumentId: 'lease' })).toBeNull()
  })

  it("prefers the portal's waiting lease over a document listed ahead of it", () => {
    const rows = [row('purchase', 'sent'), row('lease', 'viewed')]
    expect(awaitingSignatureRow(rows, { pendingLeaseDocumentId: 'lease' })?.documentId).toBe('lease')
  })

  it("skips the portal's waiting lease while it is not their turn, and shows what is", () => {
    const rows = [row('lease', 'pending'), row('addendum', 'sent')]
    expect(awaitingSignatureRow(rows, { pendingLeaseDocumentId: 'lease' })?.documentId).toBe('addendum')
  })

  it('with no waiting lease named, shows the newest document that reached them', () => {
    const rows = [row('new-unsent', 'pending'), row('older-sent', 'sent'), row('oldest-sent', 'sent')]
    expect(awaitingSignatureRow(rows, {})?.documentId).toBe('older-sent')
    expect(awaitingSignatureRow(rows, undefined)?.documentId).toBe('older-sent')
  })

  it('leaves out a new lease for the home they already live in (it has its own card)', () => {
    expect(awaitingSignatureRow([row('renewal', 'sent', { renewsLeaseId: 'old-lease' })], {})).toBeNull()
  })

  it('copes with a list that is not a list', () => {
    expect(awaitingSignatureRow(undefined, {})).toBeNull()
    expect(awaitingSignatureRow({ error: 'x' } as any, {})).toBeNull()
  })
})

describe('leaseOnItsWay', () => {
  it('a document that has not reached them yet is on its way', () => {
    expect(leaseOnItsWay([row('lease', 'pending')])).toBe(true)
  })
  it('a renewal does not count, and nothing listed is nothing on its way', () => {
    expect(leaseOnItsWay([row('renewal', 'pending', { renewsLeaseId: 'old' })])).toBe(false)
    expect(leaseOnItsWay([])).toBe(false)
    expect(leaseOnItsWay(null)).toBe(false)
  })
})
