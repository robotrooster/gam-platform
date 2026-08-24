/**
 * S617 — the two give-aways, removed deterministically.
 *
 * The prompt asks for genuine unawareness and the model still produced, across
 * two prompt revisions, verbatim: "I'm just an AI assistant on the GAM team, so
 * I don't have information about some of the landlord-side features." That one
 * sentence reaches for being an AI as the excuse AND names whose feature it is.
 */
import { describe, it, expect } from 'vitest'
import { scrubScopeLeaks, stripChatMarkdown, collapseRepetition, stripToolMachinery, stripCitationMarkers, scrubOffAudienceTopics } from './scopeGuard'

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

describe('stripToolMachinery — a tool call is never a reply (S617)', () => {
  it('removes every wrapper seen in one afternoon', () => {
    for (const s of [
      'I\'ll check.\n<call name="get_my_lease"></call>',
      '<tool_call>{"name":"get_my_deposit","arguments":{}}</tool_call>',
      'Let me pull that up.\n<10> {"name": "get_late_payment_history", "arguments": {}} </10>',
      '{"name":"get_my_payment_status","arguments":{}}',
    ]) {
      const out = stripToolMachinery(s)
      expect(out, s).not.toMatch(/\{[\s\S]*"name"\s*:/)
      expect(out, s).not.toMatch(/<\s*\/?\s*(call|tool_call|invoke|\d+)\s*>/i)
    }
  })

  it('keeps the human sentence that came with it', () => {
    expect(stripToolMachinery('Let me pull that up.\n<10> {"name": "get_late_payment_history"} </10>'))
      .toBe('Let me pull that up.')
  })

  it('leaves ordinary prose alone, even naming a tool', () => {
    const ok = "Your balance is $2,330.\n\nWant me to help you pay it?"
    expect(stripToolMachinery(ok)).toBe(ok)
    expect(stripToolMachinery('I checked your lease and the grace period is 5 days.'))
      .toBe('I checked your lease and the grace period is 5 days.')
  })

  it('runs as part of the reply tail', () => {
    expect(scrubScopeLeaks('Checking.\n<call name="get_my_lease"></call>').reply).toBe('Checking.')
  })
})

// ── S619: citation spam ──────────────────────────────────────────────────
// The one battery failure across 145 phrasings: asked what they were paying,
// the model emitted footnote markers and no answer. assertsStoredFacts caught
// bracketed WORDS and not bracketed NUMBERS, so it shipped.
describe('stripCitationMarkers', () => {
  it('removes a run of numeric markers', () => {
    expect(stripCitationMarkers('[1], [2], [3], [4]')).toBe('')
  })

  it('keeps the prose and drops only the markers', () => {
    expect(stripCitationMarkers('Your rent is $1,200 [1] and it is due on the 3rd [2].'))
      .toBe('Your rent is $1,200 and it is due on the 3rd.')
  })

  it('handles grouped and footnote forms', () => {
    expect(stripCitationMarkers('Late fees kick in after 5 days [1, 2] [^3].'))
      .toBe('Late fees kick in after 5 days.')
  })

  it('leaves bracketed WORDS alone — those are not citations', () => {
    // A real reply may legitimately bracket a qualifier; only all-digit
    // groups are citation machinery.
    expect(stripCitationMarkers('That is Bob Chen [Apt 101] — different Chen?'))
      .toBe('That is Bob Chen [Apt 101] — different Chen?')
  })

  it('leaves an ordinary reply untouched', () => {
    const plain = "You're all paid up through August. Want the receipt?"
    expect(stripCitationMarkers(plain)).toBe(plain)
  })
})

describe('scrubScopeLeaks — a reply that is only machinery', () => {
  it('replaces citation-only output rather than sending it', () => {
    const res = scrubScopeLeaks('[1], [2], [3], [4], [5]')
    expect(res.removed).toContain('machinery-only-reply')
    expect(res.reply).toMatch(/ask me once more/i)
    expect(res.reply).not.toMatch(/\[\d/)
  })

  it('replaces a reply that was nothing but a written-out tool call', () => {
    const res = scrubScopeLeaks('<call name="get_my_lease"></call>')
    expect(res.removed).toContain('machinery-only-reply')
    expect(res.reply).toMatch(/ask me once more/i)
  })

  it('does NOT fire when real prose survives alongside the markers', () => {
    const res = scrubScopeLeaks('Your balance is $340 [1].')
    expect(res.removed).not.toContain('machinery-only-reply')
    expect(res.reply).toBe('Your balance is $340.')
  })

  it('does not fire on an empty reply (nothing was there to lose)', () => {
    const res = scrubScopeLeaks('')
    expect(res.removed).toHaveLength(0)
  })
})

// ── S620: another audience's product ─────────────────────────────────────
// Separating the knowledge bases fixed what an agent RETRIEVES; it cannot fix
// what the model already knows. A visitor on a public booking site was walked
// through resetting a GAM password — no figure, no date, no list, so none of
// the fact guards saw it.
describe('scrubOffAudienceTopics', () => {
  it('removes password mechanics from a booking-site reply', () => {
    const r = scrubOffAudienceTopics(
      "I'm Skye, the booking assistant here. To reset your password, go to the login page and click Forgot Password.",
      'visitor')
    expect(r.removed).toContain('password-mechanics')
    expect(r.reply).not.toMatch(/password/i)
    expect(r.reply).toContain('Skye')
  })

  it('substitutes a line when the stray topic WAS the whole reply', () => {
    const r = scrubOffAudienceTopics('To reset your password, visit the sign-in page.', 'guest')
    expect(r.reply).toMatch(/here for your stay/i)
    expect(r.reply).not.toMatch(/password/i)
  })

  it("removes GAM's landlord rate card from a booking site", () => {
    const r = scrubOffAudienceTopics(
      'Our platform fee is $2 per occupied unit per month.', 'visitor')
    expect(r.removed).toContain('platform-fee')
    expect(r.reply).not.toMatch(/\$2/)
  })

  it('removes tenancy talk from a guest reply', () => {
    const r = scrubOffAudienceTopics(
      "Your stay runs through the 10th. Your rent is due on the 1st and there's a late fee after that.",
      'guest')
    expect(r.reply).toContain('10th')
    expect(r.reply).not.toMatch(/late fee/i)
  })

  it('leaves a legitimate guest reply completely alone', () => {
    const ok = "You're in RV 01 through July 10th — 5 nights, $364 total. Want me to ask about a late checkout?"
    expect(scrubOffAudienceTopics(ok, 'guest')).toEqual({ reply: ok, removed: [] })
  })

  it('does NOT touch tenant or landlord replies — those topics are theirs', () => {
    // A tenant discussing their lease and a landlord discussing the platform
    // fee are doing exactly their job. This guard is only for the two
    // audiences with no account at all.
    const tenantReply = 'Your rent is due on the 1st, and your lease runs to January.'
    expect(scrubOffAudienceTopics(tenantReply, 'tenant').removed).toEqual([])
    const landlordReply = 'The platform fee is $2 per occupied unit per month.'
    expect(scrubOffAudienceTopics(landlordReply, 'landlord').removed).toEqual([])
    expect(scrubOffAudienceTopics(tenantReply, undefined).removed).toEqual([])
  })
})

// ── S620: a list that lost its line breaks ───────────────────────────────
describe('stripChatMarkdown — run-on bullet lists', () => {
  it('restores line breaks on a list the model ran together', () => {
    // The real reply, measured: 13 correct vacant units as one unreadable line.
    const out = stripChatMarkdown(
      "Here's what's vacant right now:Copper Canyon Homes- House 02- House 03Oak Street Apartments- Apt 202")
    expect(out).toContain('\n• House 02')
    expect(out).toContain('\n• House 03')
    expect(out).toContain('\n• Apt 202')
  })

  it('leaves an ISO date alone — no space after the dash', () => {
    const d = 'Your lease ends 2027-01-04 and rent is due on the 1st.'
    expect(stripChatMarkdown(d)).toBe(d)
  })

  it('leaves hyphenated words alone', () => {
    const h = 'A pull-through 50 amp site with back-in access and month-to-month terms.'
    expect(stripChatMarkdown(h)).toBe(h)
  })

  it('leaves a spaced dash used as punctuation alone', () => {
    // " - " has a space BEFORE the dash, which the lookbehind rejects.
    const p = 'The total is $364 - that covers 5 nights.'
    expect(stripChatMarkdown(p)).toBe(p)
  })

  it('still normalises a properly formatted list', () => {
    expect(stripChatMarkdown('Vacant:\n- House 02\n- House 03'))
      .toBe('Vacant:\n• House 02\n• House 03')
  })

  it('leaves a negative number alone', () => {
    const n = 'Your balance changed by -25 this month.'
    expect(stripChatMarkdown(n)).toBe(n)
  })
})

describe('stripChatMarkdown — run-on list that is ALSO bolded', () => {
  it('handles the exact live reply: bold labels with no line breaks', () => {
    // The real production text. The first version of the run-on rule ran
    // BEFORE the bold strip, so the lookahead saw "*" and matched nothing —
    // while a unit test written without the asterisks passed happily.
    const out = stripChatMarkdown(
      'The rates are as follows:- **Pull-through 50 amp**: $65 per night- **Back-in 30 amp**: $48 per night')
    expect(out).toContain('\n• Pull-through 50 amp: $65 per night')
    expect(out).toContain('\n• Back-in 30 amp: $48 per night')
    expect(out).not.toContain('**')
  })
})
