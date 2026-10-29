/**
 * 10/13 (Nic) — "If it never completed, it doesn't exist."
 *
 * The one button that ends a document says what it will do. The SERVER decides
 * (lib/voidDocument.endDocument on the API): a document that never completed
 * and that no money touched is DELETED for good; anything else stays on record
 * as VOIDED. The GoldSign list and the new-lease window both get the answer
 * before the press (end_action, and end_reason when it can't be deleted), so
 * the words here never promise a delete the server turns into a void. This
 * file only turns that answer into the label and the confirm. Pure; tested in
 * documentEnd.test.ts.
 */

export type EndAction = 'delete' | 'void'

/** A GoldSign row, as the list sends it. */
export interface EndableDocument {
  endAction?: EndAction | null
  /** Why it can't be deleted, in words (with 'void' only). */
  endReason?: string | null
  documentType?: string | null
  packageGroupId?: string | null
}

export interface EndButton {
  action: EndAction
  label: string
  /** Hover text. */
  title: string
  confirm: string
  confirmLabel: string
}

/** The GoldSign row's Delete / Void button. */
export function documentEndButton(d: EndableDocument): EndButton {
  if (d.endAction === 'delete') {
    // A packet's lease takes its packet's unfinished forms with it; a form
    // everyone already signed stays (the server erases only what never
    // completed).
    const packetLease = d.documentType === 'original_lease' && !!d.packageGroupId
    // 10/14 (Nic, #1 and #8): a lease takes the invite waiting on it (canceled)
    // and a lease its signature issued with only $0.00 bills (erased).
    const lease = d.documentType === 'original_lease'
      ? ' An invite waiting on it is canceled, and a lease it issued with nothing billed is erased with it.'
      : ''
    return {
      action: 'delete', label: 'Delete', confirmLabel: 'Delete',
      title: 'It never completed and no money touched it, so it is erased',
      confirm: packetLease
        ? 'Delete this lease and the unfinished forms in its packet? None of them completed, so they are erased for good. A form everyone already signed stays.' + lease
        : 'Delete this document? It never completed, so it is erased for good — nothing is kept.' + lease,
    }
  }
  // Why it can't be deleted — so the landlord can act on it (money that
  // touched the lease it issued, say).
  const why = d.endReason?.trim() || null
  return {
    action: 'void', label: 'Void', confirmLabel: 'Void',
    title: why ? `${why} So it stays on record as voided.` : 'It stays on record as voided',
    confirm: why
      ? `Void this document? ${why} So it can't be deleted — it stays on record as voided.`
      : 'Void this document? It stays on record as voided.',
  }
}

/**
 * The new-lease window's cancel: "Throw away draft" before the landlord signs,
 * "Delete the new lease" / "Cancel the new lease" after, by what the server
 * will do. `currentLeaseEnd` is the current lease's end date already in words
 * (null for a month-to-month).
 */
export function newLeaseCancelButton(o: {
  endAction?: EndAction | null; landlordSigned: boolean; currentLeaseEnd: string | null
}): { label: string; working: string; confirm: string } {
  const erased = o.endAction === 'delete'
  if (!o.landlordSigned) {
    return {
      label: 'Throw away draft', working: erased ? 'Deleting…' : 'Canceling…',
      confirm: erased
        ? 'Throw away this draft? Anything typed into it is discarded and the draft is erased for good. The current lease carries on as it is.'
        : 'Throw away this draft? Anything typed into it is discarded. The current lease carries on as it is.',
    }
  }
  const current = o.currentLeaseEnd
    ? `The current lease carries on as it is through ${o.currentLeaseEnd} and ends then — ` +
      'unless you send them another new lease before that day, it is treated as a move-out.'
    : null
  if (erased) {
    // Signed by the landlord but it never issued (nothing was billed from it).
    return {
      label: 'Delete the new lease', working: 'Deleting…',
      confirm: 'Delete the new lease? Nothing was billed from it, so it is erased for good. ' +
        (current ?? 'The current lease carries on exactly as it is.'),
    }
  }
  return {
    label: 'Cancel the new lease', working: 'Canceling…',
    confirm: current
      ? `Cancel the new lease? ${current} Any deposit change on the new one is taken back.`
      : 'Cancel the new lease? The current lease carries on exactly as it is, and any deposit change on the new one is taken back.',
  }
}
