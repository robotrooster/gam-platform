/**
 * S617 — the guards that stop an agent inventing account data.
 *
 * Every example below is REAL output captured from the production path
 * (runAgentSession, real actor, real tools) and checked against the database.
 * They are here because the prompt asked for none of it and got all of it.
 */
import { describe, it, expect } from 'vitest'
import { assertsStoredFacts, namesNotInToolResults, demandsAToolCall } from './agentRunner'

// The runner's own predicate — NOT a copy of it. A copy drifted within the
// hour: it still nudged "how much does a background check cost" after the
// runner had learned not to.
const nudges = demandsAToolCall

describe('which questions demand a tool (S617)', () => {
  it('catches every phrasing that was caught fabricating', () => {
    // Each of these produced invented data before the net was widened.
    for (const m of [
      'how much do I owe right now?',        // said $1,200; real balance $2,330
      'is bob behind on rent?',              // said "current"; $2,330 delinquent
      'when does my lease end?',             // emitted [get_my_lease.endsAt]
      'do I have any open maintenance requests', // listed 2; tenant has none
      'how many units do I have vacant',     // said 2; actually 15
      'whats my occupancy',                  // said 12/3; actually 6/15
      'any leases expiring soon',            // invented Maple Court, Pine Estates
      'how much rent am I owed this month',
      'how much does apt 101 owe',
    ]) expect(nudges(m), m).toBe(true)
  })

  it('leaves capability questions to the knowledge base', () => {
    // These must NOT be nudged — they answer from articles, often as bullets,
    // and suppressing a bulleted capability answer would be a regression.
    for (const m of [
      'how do payouts work?', 'what is the platform fee?', 'how do late fees work',
      'how do I add a unit?', 'can I bill my neighbor for trash?',
      'what happens if rent is late', 'how much does a background check cost',
    ]) expect(nudges(m), m).toBe(false)
  })
})

describe('assertsStoredFacts — would this reply state a fact nobody looked up?', () => {
  it('flags an unresolved tool placeholder', () => {
    expect(assertsStoredFacts('Your lease ends on [get_my_lease.endsAt].')).toBe(true)
  })

  it('flags a list of records — the case that slipped through first time', () => {
    expect(assertsStoredFacts(
      'Here is a list of leases ending within the next 60 days:\n' +
      '1. Unit 101 at Maple Court\n• Tenants: Jane Doe\n• End Date: October 15')).toBe(true)
  })

  it('flags counts, money, and dates', () => {
    expect(assertsStoredFacts('You have 2 vacant units.')).toBe(true)
    expect(assertsStoredFacts('The balance is $2,330.')).toBe(true)
    expect(assertsStoredFacts('It ends 2027-01-04.')).toBe(true)
    expect(assertsStoredFacts('Lease ends October 4.')).toBe(true)
  })

  it('does not flag an honest answer that states nothing', () => {
    expect(assertsStoredFacts("I can't see that from here — want me to get someone?")).toBe(false)
    expect(assertsStoredFacts('Rent is paid in full through the portal, oldest charges first.')).toBe(false)
    expect(assertsStoredFacts('')).toBe(false)
  })
})

describe('namesNotInToolResults — padding a real lookup with fake rows', () => {
  const results = [{ leases: [{ property: 'Oak Street Apartments', unit: 'Apt 204', endDate: '2026-10-04' }] }]

  it('catches the properties that do not exist in any database row', () => {
    const bad = namesNotInToolResults(
      '• Unit Apt 204 at Oak Street Apartments: ends October 4.\n' +
      '• Unit 202 at Maple Court: ends November 2.\n' +
      '• Unit 303 at Pine Estates: ends December 1.', results)
    expect(bad).toContain('Maple Court')
    expect(bad).toContain('Pine Estates')
  })

  it('passes a list that only reports what came back', () => {
    expect(namesNotInToolResults('• Apt 204 at Oak Street Apartments: ends October 4.', results)).toEqual([])
  })

  it('ignores prose — padding happens in lists, and prose should not be second-guessed', () => {
    expect(namesNotInToolResults('I checked with Maple Court about it.', results)).toEqual([])
  })

  it('does not flag month names as invented records', () => {
    expect(namesNotInToolResults('• Apt 204 at Oak Street Apartments\n• Due October 4', results)).toEqual([])
  })
})
