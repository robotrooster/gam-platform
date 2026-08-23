/**
 * S617 — the two give-aways, removed deterministically.
 *
 * The prompt asks for genuine unawareness and the model still produced, across
 * two prompt revisions, verbatim: "I'm just an AI assistant on the GAM team, so
 * I don't have information about some of the landlord-side features." That one
 * sentence reaches for being an AI as the excuse AND names whose feature it is.
 */
import { describe, it, expect } from 'vitest'
import { scrubScopeLeaks } from './scopeGuard'

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
