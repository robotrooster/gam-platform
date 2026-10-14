/**
 * 10/13 (Nic) — "If it never completed, it doesn't exist." The button that
 * ends a document says what the server will do (end_action), and when it
 * can't delete, why (end_reason).
 */
import { describe, it, expect } from 'vitest'
import { documentEndButton, newLeaseCancelButton } from './documentEnd'

describe('documentEndButton (GoldSign row)', () => {
  it('Delete for a document the server erases', () => {
    const b = documentEndButton({ endAction: 'delete', documentType: 'addendum_terms' })
    expect(b).toMatchObject({ action: 'delete', label: 'Delete', confirmLabel: 'Delete' })
    expect(b.confirm).toBe('Delete this document? It never completed, so it is erased for good — nothing is kept.')
  })

  it('a packet lease says its unfinished forms go too — and that a form everyone signed stays', () => {
    const b = documentEndButton({ endAction: 'delete', documentType: 'original_lease', packageGroupId: 'p1' })
    expect(b.confirm).toBe('Delete this lease and the unfinished forms in its packet? None of them completed, so they are erased for good. A form everyone already signed stays. An invite waiting on it is canceled, and a lease it issued with nothing billed is erased with it.')
    expect(b.confirm).not.toMatch(/nothing is kept/)
  })

  it('10/14 (Nic, #1/#8): a lease on its own says the invite waiting on it is canceled and an unbilled issued lease goes too', () => {
    const b = documentEndButton({ endAction: 'delete', documentType: 'original_lease' })
    expect(b.confirm).toBe('Delete this document? It never completed, so it is erased for good — nothing is kept. An invite waiting on it is canceled, and a lease it issued with nothing billed is erased with it.')
  })

  it('Void says why it cannot be deleted, in the server\'s words', () => {
    const b = documentEndButton({ endAction: 'void', endReason: 'The invite for this household is still open and waiting on this lease.' })
    expect(b).toMatchObject({ action: 'void', label: 'Void', confirmLabel: 'Void' })
    expect(b.confirm).toBe(
      'Void this document? The invite for this household is still open and waiting on this lease. ' +
      'So it can\'t be deleted — it stays on record as voided.')
    expect(b.title).toBe('The invite for this household is still open and waiting on this lease. So it stays on record as voided.')
  })

  it('Void with no reason from the server (an older answer) never claims a delete', () => {
    for (const d of [{ endAction: 'void' as const }, {}]) {
      const b = documentEndButton(d)
      expect(b.action).toBe('void')
      expect(b.confirm).toBe('Void this document? It stays on record as voided.')
    }
  })
})

describe('newLeaseCancelButton (the new-lease window)', () => {
  it('before the landlord signs: Throw away draft, erased when the server erases it', () => {
    expect(newLeaseCancelButton({ endAction: 'delete', landlordSigned: false, currentLeaseEnd: 'January 31, 2027' })).toEqual({
      label: 'Throw away draft', working: 'Deleting…',
      confirm: 'Throw away this draft? Anything typed into it is discarded and the draft is erased for good. The current lease carries on as it is.',
    })
    expect(newLeaseCancelButton({ endAction: 'void', landlordSigned: false, currentLeaseEnd: null }).confirm)
      .toBe('Throw away this draft? Anything typed into it is discarded. The current lease carries on as it is.')
  })

  it('landlord signed but it never issued: Delete the new lease — no deposit change to take back', () => {
    const b = newLeaseCancelButton({ endAction: 'delete', landlordSigned: true, currentLeaseEnd: 'January 31, 2027' })
    expect(b.label).toBe('Delete the new lease')
    expect(b.confirm).toBe(
      'Delete the new lease? Nothing was billed from it, so it is erased for good. The current lease carries on as it is ' +
      'through January 31, 2027 and ends then — unless you send them another new lease before that day, it is treated as a move-out.')
    expect(b.confirm).not.toMatch(/deposit change/)
    expect(newLeaseCancelButton({ endAction: 'delete', landlordSigned: true, currentLeaseEnd: null }).confirm)
      .toBe('Delete the new lease? Nothing was billed from it, so it is erased for good. The current lease carries on exactly as it is.')
  })

  it('landlord signed and it issued: Cancel the new lease, as before', () => {
    expect(newLeaseCancelButton({ endAction: 'void', landlordSigned: true, currentLeaseEnd: 'January 31, 2027' })).toEqual({
      label: 'Cancel the new lease', working: 'Canceling…',
      confirm: 'Cancel the new lease? The current lease carries on as it is through January 31, 2027 and ends then — ' +
        'unless you send them another new lease before that day, it is treated as a move-out. Any deposit change on the new one is taken back.',
    })
    expect(newLeaseCancelButton({ endAction: 'void', landlordSigned: true, currentLeaseEnd: null }).confirm)
      .toBe('Cancel the new lease? The current lease carries on exactly as it is, and any deposit change on the new one is taken back.')
  })
})
