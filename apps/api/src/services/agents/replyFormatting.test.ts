/**
 * S624 — stripping a promise of a person must not flatten the reply.
 *
 * From the two-turn review, filed as a formatting quirk on one booking answer:
 *   "• Back-in 30 amp: $48 per nightRemember, the weekly rate is..."
 *
 * The cause was not the booking agent. stripPromiseOfAPerson split replies with
 * a pattern that excluded \n from every match and rejoined with '', so it
 * destroyed every newline in any reply it touched — and it touches every reply
 * that promises a handoff it is not entitled to make.
 */
import { describe, it, expect } from 'vitest'
import { stripPromiseOfAPerson } from './escalationPolicy'

describe('reply formatting survives the strip', () => {
  it('keeps a rate list off the sentence that follows it', () => {
    const reply = [
      'Our rates at Sunset Palms are:',
      '• Pull-through 50 amp: $65 per night',
      '• Back-in 30 amp: $48 per night',
      'Remember, the weekly rate is a discounted 7-night price.',
    ].join('\n')
    const out = stripPromiseOfAPerson(reply)
    expect(out).not.toContain('per nightRemember')
    expect(out).toContain('$48 per night\nRemember')
  })

  it('leaves a reply with nothing to strip completely untouched', () => {
    const reply = 'Line one.\n\nLine two.\n- a\n- b'
    expect(stripPromiseOfAPerson(reply)).toBe(reply)
  })

  it('still removes the promise it exists to remove', () => {
    const reply = 'Your balance is $850. I will escalate this to a human agent. Let me know if that helps.'
    const out = stripPromiseOfAPerson(reply)
    expect(out).not.toMatch(/escalate/i)
    // and keeps the useful sentences — dropping those is the S617 mistake
    expect(out).toContain('$850')
    expect(out).toContain('Let me know')
  })

  it('does not leave a double space where a sentence was removed', () => {
    const reply = 'First. I will escalate this to a human. Third.'
    expect(stripPromiseOfAPerson(reply)).not.toMatch(/ {2,}/)
  })

  it('handles an empty or unmatched reply without throwing', () => {
    expect(stripPromiseOfAPerson('')).toBe('')
    expect(stripPromiseOfAPerson('   ')).toBe('   ')
  })
})
