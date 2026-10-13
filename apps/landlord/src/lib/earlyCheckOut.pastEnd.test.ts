/**
 * 10/13 (Nic): "void the cancelled nights: owner + managers with booking
 * permission." The schedule's shorter-stay question and the Check out window
 * offer exactly the answers the server sent for rent a payment was tried on
 * past the day they left: "Take those charges off" only when it was offered,
 * "Keep them owed" always — never a chooser with nothing to press.
 */
import { describe, it, expect } from 'vitest'
import { pastEndChoices, pastEndQuestion, KEEP_THEM_OWED } from './earlyCheckOut'

describe('pastEndChoices — the answers offered, as the server sent them', () => {
  it('the owner (or a booking manager): both answers, "Take those charges off" first, in the server\'s words', () => {
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
    expect(pastEndQuestion('Rent was tried on Oct 9.', 'Only the owner or a manager with booking permission can take them off.'))
      .toBe('Rent was tried on Oct 9.\n\nOnly the owner or a manager with booking permission can take them off.')
  })

  it('the question alone when there is no reason', () => {
    expect(pastEndQuestion('Rent was tried on Oct 9.', null)).toBe('Rent was tried on Oct 9.')
    expect(pastEndQuestion('Rent was tried on Oct 9.')).toBe('Rent was tried on Oct 9.')
  })
})
