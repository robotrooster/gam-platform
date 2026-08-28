/**
 * S626 — the cross-turn repetition guard.
 *
 * Four of the six tenant conversations and five of the nineteen in Nic's
 * two-turn review failed on one behaviour: turn two reissuing turn one. These
 * pin the detector, since the net that uses it costs a whole extra generation
 * when it fires and must not fire on ordinary conversation.
 */
import { describe, it, expect } from 'vitest'
import { repeatsPreviousReply } from './agentRunner'

const h = (assistant: string) => [
  { role: 'user', content: 'what do I owe right now?' },
  { role: 'assistant', content: assistant },
]

const BALANCE =
  'You currently owe $2,330. This includes $750 in failed rent from June 1st, $15 in pending ' +
  'late fees from June 6th, $50 in pending late fees from June 14th, and $750 in pending rent.'

describe('repeatsPreviousReply', () => {
  it('catches a verbatim reissue — the exact shape that reached tenants', () => {
    expect(repeatsPreviousReply(h(BALANCE), BALANCE)).toBe(true)
  })

  it('catches a reply that recycles the MIDDLE of the last one (S628)', () => {
    // VERBATIM from the S628 conversation run. A tenant asked what their late
    // fee was, then asked for it to be taken off. The second reply reissued the
    // mechanics and never answered the question — and the prefix test scored
    // ZERO on it, because one reply opens "Your lease" and the other "The $15".
    const turn1 =
      'Your lease at Oak Street Apartments, Apt 101, charges a $15 flat late fee. ' +
      'This fee is charged once when rent goes late — it is not per day and does not accrue. ' +
      'You have a grace period of 5 days.'
    const turn2 =
      'The $15 late fee is charged once when rent goes late — it is not per day and does not accrue. ' +
      'You have a grace period of 5 days.'
    expect(repeatsPreviousReply(h(turn1), turn2)).toBe(true)
  })

  it('does NOT fire when a figure is restated inside a real answer', () => {
    // The bar has to leave room for the correct behaviour. Repeating the number
    // while actually answering is what a person does; repeating the paragraph
    // is not. This must stay false or the guard costs a generation on every
    // good reply.
    const turn1 =
      'Your lease at Oak Street Apartments, Apt 101, charges a $15 flat late fee. ' +
      'This fee is charged once when rent goes late — it is not per day and does not accrue. ' +
      'You have a grace period of 5 days.'
    const answer =
      'Counting from the end of your five-day grace, that payment was seven days past due, ' +
      'so the $15 stands. It is your landlord who decides on waiving it, not me — ' +
      'want me to pass the request on to them?'
    expect(repeatsPreviousReply(h(turn1), answer)).toBe(false)
  })

  it('catches a repeat that trails off differently', () => {
    // The real ones were not byte-identical; they appended or dropped a clause.
    expect(repeatsPreviousReply(h(BALANCE), BALANCE.slice(0, 140) + ' until the balance is settled.')).toBe(true)
  })

  it('does NOT fire on a genuine follow-up answer', () => {
    expect(repeatsPreviousReply(
      h(BALANCE),
      'No problem — I will leave it with you. Whenever you come back to it, it has to go in one payment.',
    )).toBe(false)
  })

  it('does NOT fire on a short acknowledgement', () => {
    expect(repeatsPreviousReply(h(BALANCE), 'Understood — I will leave it there.')).toBe(false)
  })

  it('does NOT fire when a figure is legitimately restated inside a new answer', () => {
    // Mentioning the number again is normal; leading with the same paragraph is not.
    expect(repeatsPreviousReply(
      h(BALANCE),
      'Rent has to be paid in full — the whole $2,330 in one payment. GAM has no split option at all.',
    )).toBe(false)
  })

  it('compares against the LAST assistant turn, not an older one', () => {
    const hist = [
      { role: 'user', content: 'what do I owe?' },
      { role: 'assistant', content: BALANCE },
      { role: 'user', content: 'can I pay half?' },
      { role: 'assistant', content: 'Rent is all-or-nothing on GAM — one payment, platform-wide.' },
    ]
    // Restating the OLD balance is not the failure this guards.
    expect(repeatsPreviousReply(hist, BALANCE)).toBe(false)
    expect(repeatsPreviousReply(hist, 'Rent is all-or-nothing on GAM — one payment, platform-wide.')).toBe(true)
  })

  it('is inert with no history and with an empty reply', () => {
    expect(repeatsPreviousReply([], BALANCE)).toBe(false)
    expect(repeatsPreviousReply(h(BALANCE), '')).toBe(false)
    expect(repeatsPreviousReply(h(BALANCE), '   ')).toBe(false)
  })

  it('ignores whitespace and line-break differences', () => {
    expect(repeatsPreviousReply(h(BALANCE), BALANCE.replace(/\. /g, '.\n\n'))).toBe(true)
  })
})
