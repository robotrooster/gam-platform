import { describe, it, expect } from 'vitest'
import { collapseRepetition } from './collapseRepetition'

describe('a model that has started repeating itself', () => {
  // The real one, from the public marketing chat.
  it('collapses the Lucy lead-capture loop', () => {
    const line = "I'll send over the call details. I'll also send over a personalized call invitation with the time and link. "
    const reply = 'Great, ' + line.repeat(40)
    const out = collapseRepetition(reply)
    expect(out.degenerate).toBe(true)
    expect(out.removed).toBeGreaterThan(50)
    expect(out.reply).toContain('send over the call details')
    // One copy of each, not forty.
    expect((out.reply.match(/personalized call invitation/g) ?? []).length).toBe(1)
    expect(out.reply.length).toBeLessThan(300)
  })

  it('leaves a normal reply completely alone', () => {
    const reply = "You owe $865. That's $850 for rent due on July 1st, plus a $15 late fee due on July 6th. Rent is all-or-nothing — you can't split it into two payments."
    const out = collapseRepetition(reply)
    expect(out.removed).toBe(0)
    expect(out.reply).toBe(reply)
  })

  it('does not touch a list whose items merely look alike', () => {
    const reply = [
      'Here is who is behind on rent:',
      '• Frank Williams owes $4,840 (8 past-due items, oldest due May 1)',
      '• Alice Morgan owes $2,330 (4 past-due items, oldest due July 1)',
      '• Bob Chen owes $2,330 (6 past-due items, oldest due June 1)',
    ].join('\n')
    const out = collapseRepetition(reply)
    expect(out.removed).toBe(0)
    expect(out.reply).toBe(reply)
  })

  it('leaves short innocent repeats alone', () => {
    const reply = 'Yes. Yes, that is right. Your lease ends on January 4, 2027, and the rent is $850 a month as written.'
    expect(collapseRepetition(reply).removed).toBe(0)
  })

  it('collapses a doubled paragraph without calling it degenerate', () => {
    const s = 'Your maintenance request has been filed and routed to your landlord for review. '
    const out = collapseRepetition(s + s + 'They usually respond within 24 to 48 hours, so keep an eye on your notifications.')
    expect(out.removed).toBe(1)
    expect(out.degenerate).toBe(false)
    expect(out.reply).toContain('24 to 48 hours')
  })

  it('is safe on empty, short, and unpunctuated replies', () => {
    expect(collapseRepetition('').reply).toBe('')
    expect(collapseRepetition('ok').reply).toBe('ok')
    expect(collapseRepetition('a'.repeat(200)).removed).toBe(0)
  })
})
