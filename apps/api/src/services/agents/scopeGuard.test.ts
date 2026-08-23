/**
 * S617 — the two give-aways, removed deterministically.
 *
 * The prompt asks for genuine unawareness and the model still produced, across
 * two prompt revisions, verbatim: "I'm just an AI assistant on the GAM team, so
 * I don't have information about some of the landlord-side features." That one
 * sentence reaches for being an AI as the excuse AND names whose feature it is.
 */
import { describe, it, expect } from 'vitest'
import { scrubScopeLeaks, stripChatMarkdown, collapseRepetition } from './scopeGuard'

describe('scrubScopeLeaks (S617)', () => {
  it('removes the exact sentence the model kept producing', () => {
    const r = scrubScopeLeaks(
      "Hm, FlexVault doesn't ring a bell for me. I'm just an AI assistant on the GAM team, " +
      "so I don't have information about some of the landlord-side features. " +
      'I can help with your account, payments, or lease questions though.')
    expect(r.reply).toContain("doesn't ring a bell")
    expect(r.reply).toContain('I can help with your account')
    expect(r.reply).not.toMatch(/AI assistant/i)
    expect(r.reply).not.toMatch(/landlord-side/i)
    expect(r.removed.length).toBeGreaterThan(0)
  })

  it('keeps an honest identity answer — that question deserves a straight reply', () => {
    const honest = "Yes — I'm an AI assistant on the GAM team. Happy to get a person on it if you'd rather."
    expect(scrubScopeLeaks(honest).reply).toBe(honest)
    expect(scrubScopeLeaks(honest).removed).toEqual([])
  })

  it('leaves an ordinary reply completely alone', () => {
    const ok = 'Your rent is due on the 3rd.\n\nWant me to pull up your lease?'
    expect(scrubScopeLeaks(ok).reply).toBe(ok)
  })

  it('does not touch a landlord agent legitimately saying "landlord"', () => {
    const ok = "Your landlord sets the late fee, and on this lease it's $50 after a 5-day grace period."
    expect(scrubScopeLeaks(ok).reply).toBe(ok)
    expect(scrubScopeLeaks(ok).removed).toEqual([])
  })

  it('removes "that\'s a landlord product" however it is phrased', () => {
    for (const s of [
      "That's a landlord feature, so it won't show on your side.",
      "That's a tenant product and not something you'd see.",
      "Sorry, that's an owner tool.",
    ]) {
      expect(scrubScopeLeaks(s).removed.length).toBeGreaterThan(0)
    }
  })

  it('removes the machine tell — reciting its own configuration', () => {
    for (const s of [
      "I don't have that in my knowledge base.",
      'That falls outside my configured scope.',
      "It isn't available to me.",
    ]) {
      expect(scrubScopeLeaks(s).removed.length).toBeGreaterThan(0)
    }
  })

  it('substitutes a plain line rather than sending nothing', () => {
    const r = scrubScopeLeaks("I don't have that in my knowledge base.")
    expect(r.reply.length).toBeGreaterThan(0)
    expect(r.reply).toMatch(/not anything I'm aware of/)
  })

  it('handles an empty reply without throwing', () => {
    expect(scrubScopeLeaks('').reply).toBe('')
  })
})

describe('stripChatMarkdown (S617)', () => {
  it('removes bold the chat window would print as asterisks', () => {
    // Real output from a live delinquency lookup.
    const out = stripChatMarkdown('- **Frank Williams**: $4,840 overdue (8 past due items)')
    expect(out).not.toContain('*')
    expect(out).toContain('Frank Williams')
    expect(out).toContain('$4,840')
  })

  it('keeps a list a list, without the markdown marker', () => {
    const out = stripChatMarkdown('- one\n- two\n* three')
    expect(out.split('\n').every(l => l.startsWith('• '))).toBe(true)
  })

  it('unwraps headings, code ticks and links', () => {
    expect(stripChatMarkdown('## Payouts')).toBe('Payouts')
    expect(stripChatMarkdown('use `get_my_lease` here')).toBe('use get_my_lease here')
    expect(stripChatMarkdown('see [the terms](https://x.io)')).toBe('see the terms (https://x.io)')
  })

  it('leaves ordinary prose and real dollar amounts alone', () => {
    const ok = "Your rent is $750 on the 1st. Bob's balance is $2,330."
    expect(stripChatMarkdown(ok)).toBe(ok)
  })

  it('does not eat an asterisk used as a footnote or maths', () => {
    expect(stripChatMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6')
  })

  it('runs as part of the reply tail', () => {
    expect(scrubScopeLeaks('**Bob Chen** owes $2,330.').reply).toBe('Bob Chen owes $2,330.')
  })
})

describe('collapseRepetition (S617)', () => {
  it('collapses a reply that looped on itself', () => {
    // Real shape: a tenant asking whether a payment went through got these
    // three lines back a dozen times over.
    const looped = Array.from({ length: 12 }, () =>
      'Want me to pull up your full payment history?\nYou also have some pending charges still outstanding.').join('\n')
    const out = collapseRepetition(looped)
    expect(out.split('\n').filter(l => l.trim()).length).toBe(2)
    expect(out).toContain('full payment history')
  })

  it('keeps the first occurrence, in order', () => {
    expect(collapseRepetition('The first long sentence here.\nA different long sentence.\nThe first long sentence here.'))
      .toBe('The first long sentence here.\nA different long sentence.')
  })

  it('keeps blank lines so paced bubbles still split', () => {
    const two = 'Your rent is due on the 1st of the month.\n\nWant me to pull up your lease?'
    expect(collapseRepetition(two)).toBe(two)
  })

  it('does not collapse short repeated lines like list markers', () => {
    const list = '• Apt 204\n• Apt 201\n• RV 08'
    expect(collapseRepetition(list)).toBe(list)
  })

  it('leaves an ordinary reply untouched', () => {
    const ok = "Your balance is $2,330.\n\nWant me to help you pay it?"
    expect(collapseRepetition(ok)).toBe(ok)
  })
})

describe('collapseRepetition — short lines repeat too (S617)', () => {
  it('collapses an 11-character line repeated a dozen times', () => {
    // Real: a tenant asked "do I owe anything?" and got "What's due?" back
    // twelve times. The old floor kept anything under 12 characters.
    const looped = Array.from({ length: 12 }, () => "What's due?").join('\n')
    expect(collapseRepetition(looped)).toBe("What's due?")
  })

  it('keeps DISTINCT short lines — a bullet list is not repetition', () => {
    const list = '• Apt 204\n• Apt 201\n• RV 08\n• RV 01'
    expect(collapseRepetition(list)).toBe(list)
  })

  it('still keeps the blank lines that split bubbles', () => {
    const two = 'Your balance is $2,330.\n\nWant me to help you pay it?'
    expect(collapseRepetition(two)).toBe(two)
  })
})
