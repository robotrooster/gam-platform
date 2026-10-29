/**
 * 10/13 evening (Nic): "anyone who can schedule reservations and take payments
 * can cancel. refund is separate permission." The
 * schedule's shorter-stay question and the Check out window
 * offer exactly the answers the server sent for rent a payment was tried on
 * past the day they left: "Take those charges off" only when it was offered,
 * "Keep them owed" always — never a chooser with nothing to press.
 */
import { describe, it, expect } from 'vitest'
import { pastEndChoices, pastEndQuestion, KEEP_THEM_OWED } from './earlyCheckOut'

describe('pastEndChoices — the answers offered, as the server sent them', () => {
  it('the owner (or anybody who can schedule reservations and take payments): both answers, "Take those charges off" first, in the server\'s words', () => {
    expect(pastEndChoices({ void: 'Take those charges off', keep: 'Keep them owed' })).toEqual([
      { value: 'void', label: 'Take those charges off' },
      { value: 'keep', label: 'Keep them owed' },
    ])
  })

  it('anybody else: "Keep them owed" only', () => {
    expect(pastEndChoices({ keep: 'Keep them owed' })).toEqual([{ value: 'keep', label: 'Keep them owed' }])
  })

  it('a reply that names neither (or nothing at all) still leaves "Keep them owed", never "Take those charges off"', () => {
    for (const offered of [undefined, null, {}, { void: '' }, { keep: '  ' }, { void: 42 as unknown, keep: null as unknown }]) {
      expect(pastEndChoices(offered as any)).toEqual([{ value: 'keep', label: KEEP_THEM_OWED }])
    }
  })

  it('"Take those charges off" with no keep words: keep is still offered, in GAM\'s words', () => {
    expect(pastEndChoices({ void: 'Take those charges off' })).toEqual([
      { value: 'void', label: 'Take those charges off' },
      { value: 'keep', label: KEEP_THEM_OWED },
    ])
  })
})

describe('pastEndQuestion — why "Take those charges off" is not offered, when the server says', () => {
  it('adds the reason under the question', () => {
    expect(pastEndQuestion('Rent was tried on Oct 9.', 'Taking those charges off needs a reservation permission and "Record a cash / check payment".'))
      .toBe('Rent was tried on Oct 9.\n\nTaking those charges off needs a reservation permission and "Record a cash / check payment".')
  })

  it('the question alone when there is no reason', () => {
    expect(pastEndQuestion('Rent was tried on Oct 9.', null)).toBe('Rent was tried on Oct 9.')
    expect(pastEndQuestion('Rent was tried on Oct 9.')).toBe('Rent was tried on Oct 9.')
  })
})
