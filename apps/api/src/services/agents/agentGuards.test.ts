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

  it('leaves the never-changing things to memory', () => {
    // S617 (Nic): "memory should only be the things that don't change." A
    // how-to is the same procedure for everyone, and the platform fee is the
    // same number for every landlord.
    for (const m of [
      'how do I add a unit?', 'how do I report a repair', 'where do I pay my rent',
      'can I pay with a card', 'what is the platform fee?',
      'how much do you charge per unit', 'how much does a background check cost',
      'can tenants pay part of the rent', 'can I pay half now and half later',
    ]) expect(nudges(m), m).toBe(false)
  })

  it('looks up anything that differs between two users', () => {
    // Including the general-sounding ones. Nic: late fees are "per property and
    // per state and landlord", so there is no universal answer to give.
    for (const m of [
      'how do late fees work', 'is there a grace period on my rent',
      'what happens if I pay rent late', 'how do payouts work?',
      'when do I get paid', 'what happens if rent is late',
    ]) expect(nudges(m), m).toBe(true)
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

describe('namesNotInToolResults — field labels are not invented records (S617)', () => {
  // Real false positive: the agent answered "whats my occupancy" correctly from
  // get_landlord_portfolio and was suppressed, because it wrote the breakdown as
  // "Total Units / Occupied Units / Vacant Units" while the tool returns
  // totalUnits / occupiedUnits / vacantUnits.
  const portfolio = [{ totalUnits: 21, occupiedUnits: 6, vacantUnits: 15 }]

  it('matches a prose label against its camelCase key', () => {
    expect(namesNotInToolResults(
      '• Total Units: 21\n• Occupied Units: 6\n• Vacant Units: 15', portfolio)).toEqual([])
  })

  it('matches through snake_case too', () => {
    expect(namesNotInToolResults('• Vacant Units: 15', [{ vacant_units: 15 }])).toEqual([])
  })

  it('still catches a genuinely invented property alongside real labels', () => {
    const bad = namesNotInToolResults(
      '• Total Units: 21\n• Maple Court: 4 units', portfolio)
    expect(bad).toEqual(['Maple Court'])
  })
})

// ============================================================
// S617 — an OFFER to escalate is not an escalation.
//
// The prose-handoff net exists because this model class sometimes narrates a
// handoff instead of calling the tool, stranding the customer. It was also
// firing on ordinary good service, and when it fires it REPLACES the reply with
// escalation boilerplate — so a correct answer was being deleted.
// ============================================================
import { promisesHandoff } from './agentRunner'

describe('promisesHandoff — offers vs actual handoffs (S617)', () => {
  it('does NOT fire on the real reply that was being thrown away', () => {
    // Verbatim from the production path. The $2,330 matches the database.
    expect(promisesHandoff(
      'You currently owe $2,330. This includes several pending payments and a failed rent ' +
      'payment from June. If you need help with the failed payment or have questions about ' +
      'the late fees, I can connect you with a human support agent. Would you like me to do that?'
    )).toBe(false)
  })

  it('does NOT fire on a conditional offer at the end of a good answer', () => {
    expect(promisesHandoff(
      'Late fees are set by your landlord and outlined in your lease. If something still seems ' +
      'off, we can connect you with a human GAM Strategist to help.'
    )).toBe(false)
    expect(promisesHandoff('I can escalate this to a specialist if you would like.')).toBe(false)
    expect(promisesHandoff('Want me to bring in someone who can help?')).toBe(false)
  })

  it('DOES fire when the agent says it has already handed off', () => {
    // The original failure this net was built for — narrate, then stop.
    expect(promisesHandoff("I'm connecting you with a senior agent now — please hold.")).toBe(true)
    expect(promisesHandoff("I've escalated this to our support team.")).toBe(true)
    expect(promisesHandoff('Transferring you to a human specialist.')).toBe(true)
  })

  it('still ignores routing to the LANDLORD, which is not a support escalation', () => {
    expect(promisesHandoff("I'll pass this on to your landlord.")).toBe(false)
  })

  it('ignores an empty reply', () => {
    expect(promisesHandoff('')).toBe(false)
  })
})

describe('assertsStoredFacts — a written-out tool call is not an answer (S617)', () => {
  it('catches markup the model typed instead of calling anything', () => {
    // Real: asked "what is the late fee", the agent replied "I'll look up your
    // lease..." and then printed this into the chat.
    expect(assertsStoredFacts('I\'ll look up your lease.\n<call name="get_my_lease"></call>')).toBe(true)
    expect(assertsStoredFacts('<tool_call>{"name":"get_my_deposit"}</tool_call>')).toBe(true)
  })

  it('does not flag ordinary prose containing an angle bracket', () => {
    expect(assertsStoredFacts('Rent is due before the 5th <- that is the grace period.')).toBe(false)
  })
})

// ============================================================
// S617 (Nic) — "what would a GAM customer service representative know off the
// top of their head versus what would they have to search for? ... Anything
// that's property specific, landlord specific, state specific — that's what the
// agent should be searching for. That gets it to be the most realistic."
//
// The clearest statement of the rule, and the one worth pinning: a rep explains
// how e-signing works from memory and looks up a late fee, because one is the
// same for everyone and the other is set per property under local law.
// ============================================================
describe('the customer-rep test (S617)', () => {
  it('answers from memory what a rep would know cold', () => {
    for (const q of [
      'how do I add a unit', 'how do I report a repair', 'how do I pay my rent',
      'can I pay with a card', 'what is the platform fee',
      'how much do you charge per unit', 'can tenants pay part of the rent',
      'how much does a background check cost', 'what is FlexPay',
      'how does e-sign work', 'how do invites work', 'how does autopay work',
      'how do I invite a tenant',
    ]) expect(demandsAToolCall(q), q).toBe(false)
  })

  it('looks up anything a rep would have to search — property, landlord, tenant or state', () => {
    for (const q of [
      'what is my late fee', 'how much do I owe', 'when does my lease end',
      'how much notice does my landlord have to give before entering',
      'how long does my landlord have to return my deposit',
      'is there a limit on late fees in Arizona',
      'how many units do I have vacant', 'who is behind on rent',
      'what are the utilities set up as on my property',
      'when is my next payout', 'does my state require deposit interest',
      'how do late fees work', 'how does my deposit work', 'how do payouts work',
    ]) expect(demandsAToolCall(q), q).toBe(true)
  })

  it('splits "how does X work" on whether X varies between two customers', () => {
    // Same sentence shape, opposite answers — the noun decides, not the verb.
    expect(demandsAToolCall('how does e-sign work')).toBe(false)   // same for everyone
    expect(demandsAToolCall('how do late fees work')).toBe(true)   // per property, per state
  })
})

describe('assertsStoredFacts — an address is a stored fact (S617)', () => {
  it('catches invented street addresses', () => {
    // Real: asked to narrow "spot number one" to the RV resort, the agent
    // offered "the one at 123 Main Street, and the one at 456 Oak Avenue".
    // Neither exists in the portfolio and no lookup had run.
    expect(assertsStoredFacts('the one at 123 Main Street, and the one at 456 Oak Avenue')).toBe(true)
    expect(assertsStoredFacts('It is at 4820 Cedar Lane.')).toBe(true)
  })

  it('does not flag prose that merely contains a number and a word', () => {
    expect(assertsStoredFacts('There are 3 ways to pay.')).toBe(false)
    expect(assertsStoredFacts('I can help with that.')).toBe(false)
  })
})
