/**
 * S617 — the guards that stop an agent inventing account data.
 *
 * Every example below is REAL output captured from the production path
 * (runAgentSession, real actor, real tools) and checked against the database.
 * They are here because the prompt asked for none of it and got all of it.
 */
import { describe, it, expect } from 'vitest'
import {
  assertsStoredFacts, namesNotInToolResults, demandsAToolCall,
  saysItWillCheck, countsNotInToolResults, claimsAnActionItNeverTook,
} from './agentRunner'

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

// ── S618: the promise that never lands ─────────────────────────────────────
//
// Found by the battery on the real path. A landlord asked "what's bob chen's
// balance" and got exactly "I'll look up Bob Chen's balance for you." — no
// tool, nothing after it. The same intent answered correctly in four other
// wordings, which is the whole reason phrasings are grouped.
//
// It states no fact, so assertsStoredFacts calls it safe. It is not safe: the
// landlord is left waiting for an answer that never comes, and an honest "I
// can't see that, which tenant did you mean?" is strictly better.
describe('saysItWillCheck — the agent said it would go and check', () => {
  it('catches the exact reply the battery caught', () => {
    expect(saysItWillCheck("I'll look up Bob Chen's balance for you.")).toBe(true)
  })

  it('catches the other ways it stalls', () => {
    for (const reply of [
      'Let me pull that up for you.',
      "I'm checking your balance now.",
      'One moment while I look into that.',
      "I'm going to pull up those records.",
      'Give me a second and I will look up his account.',
      // The one that actually shipped: "look AT", which the earlier
      // phrase-by-phrase version missed entirely.
      'Let me look at your late payment history.',
      'I will search for that record.',
      "I'm reviewing your account now.",
      'Let me find out for you.',
    ]) {
      expect(saysItWillCheck(reply), reply).toBe(true)
    }
  })

  // The narrowness is the point — these are correct replies and must survive.
  it('leaves ordinary replies alone', () => {
    for (const reply of [
      'Let me know if you want me to check that.',
      "I'll need to know which unit you mean before I can answer.",
      'You can look that up under Payments in your portal.',
      "I don't want to give you a figure I haven't actually checked. Which property do you mean?",
      'Bob Chen in Apt 101 is $2,330 behind.',
    ]) {
      expect(saysItWillCheck(reply), reply).toBe(false)
    }
  })

  // A promised handoff is a real commitment that synthesizeHandoff turns into a
  // real escalation. Rewriting it here would break that.
  it('does not touch a REAL promised handoff', () => {
    // promisesHandoff recognises these, synthesizeHandoff turns them into an
    // actual escalation, and rewriting them here would break that.
    for (const reply of [
      "I'll connect you with a human support agent.",
      "I'm transferring you to a GAM Strategist now.",
      "I've escalated this to our support team.",
    ]) expect(saysItWillCheck(reply), reply).toBe(false)
  })

  it('DOES catch a vague promise of follow-up that escalates nothing', () => {
    // "I'll check with the team and someone will get back to you" is not a
    // handoff — promisesHandoff does not recognise it, so nothing is escalated
    // and nothing was looked up. The customer is left waiting on a promise no
    // part of the system has recorded. That is the "someone will email you
    // within 24 hours" dead end, and it should fail safe like any other.
    expect(saysItWillCheck(
      "I'll check with the team and have someone get back to you within 24 hours."
    )).toBe(true)
  })
})

// ── S618: "a tool ran" is not "the answer came from the tool" ─────────────
//
// The real reply that exposed this: "You have 26 units across 4 properties,
// with 22 occupied and 4 vacant" — with get_landlord_portfolio in the
// invocation list, and 21 units across 3 properties in its result. Every
// existing guard keys off no-tool-ran, so all of them passed it.
describe('countsNotInToolResults — numbers the lookup never returned', () => {
  const portfolio = [{ total_units: 21, total_properties: 3, occupied_units: 8, vacant_units: 13 }]

  it('catches the invented occupancy answer', () => {
    const bad = countsNotInToolResults(
      'You have 26 units across 4 properties, with 22 occupied and 4 vacant.',
      portfolio,
    )
    expect(bad).toContain('26 units')
    expect(bad).toContain('4 properties')
    expect(bad).toContain('22 occupied')
  })

  it('passes an answer built from the real rows', () => {
    expect(countsNotInToolResults(
      'You have 21 units across 3 properties — 8 occupied and 13 vacant.',
      portfolio,
    )).toEqual([])
  })

  it('leaves money and percentages alone — a correct total is computed, not returned', () => {
    // 2,330 is the sum of rows the tool DID return; it need not appear itself.
    expect(countsNotInToolResults(
      'That comes to $2,330 in total, which is about 38% of the month.',
      [{ items: [750, 15, 50] }],
    )).toEqual([])
  })

  it('does not fuss over 0 or 1', () => {
    expect(countsNotInToolResults('You have 1 unit and 0 properties pending.', portfolio)).toEqual([])
  })
})

// ── S618: the inverted default ───────────────────────────────────────────
//
// Nic: "a tool should always be called for things that have to be searched for
// because they're gonna be different per my next door neighbor versus me... the
// only time a tool doesn't get called is for the platform side of things that
// never change."
describe('demandsAToolCall — everything is a lookup except a platform constant', () => {
  it('demands a lookup for per-user statements that carry no question verb', () => {
    // Every one of these returned FALSE before the inversion, which also
    // switched OFF the anti-fabrication guards for them.
    for (const m of [
      'my balance looks off',
      'i need my lease end date',
      'i think my late fee was wrong',
      'my rent seems too high',
      'my landlord charged me for parking',
      'remind me of my rent amount',
      'my lease says something different',
    ]) expect(demandsAToolCall(m), m).toBe(true)
  })

  it('still demands a lookup for the ordinary question forms', () => {
    for (const m of [
      'how much do I owe?',
      "what's my balance",
      'when does my lease end?',
      'is bob behind on rent?',
      'what is the late fee',
    ]) expect(demandsAToolCall(m), m).toBe(true)
  })

  // The exemption is narrow and specific: identical for every user, every
  // property, every state.
  it('exempts platform constants and how-to', () => {
    for (const m of [
      'how do I pay my rent?',
      'how do I report a repair',
      'can I set up autopay',
      'what is the platform fee?',
      'what does GAM cost me',
      // S618: GAM's own rate is platform-wide. This was demanding a lookup and
      // the model answered from the portfolio tool without the fee.
      'what am I paying for this',
      'what am I paying you',
      'what is FlexPay?',
      'can I pay part of my rent',
    ]) expect(demandsAToolCall(m), m).toBe(false)
  })

  it('exempts messages that ask nothing', () => {
    for (const m of ['hi', 'hello!', 'thanks', 'thank you', 'ok', 'got it', 'perfect', 'bye'])
      expect(demandsAToolCall(m), m).toBe(false)
  })

  // Nic's example of the thing that MUST be looked up even though it sounds
  // general: late fees vary per property, per state, per landlord.
  it('does NOT exempt a general-sounding question whose answer varies per user', () => {
    for (const m of [
      'how do late fees work?',
      "what's my grace period",
      'what happens if I pay rent late',
      'when is my rent due',
      // The near-miss of the exemption above: a LEASE fee, not GAM's rate.
      'what am I paying for parking',
    ]) expect(demandsAToolCall(m), m).toBe(true)
  })
})

// ── S618: the agent closing a ticket by lying about it ───────────────────
//
// The worst thing measured this session. A tenant said "tell my neighbor to
// turn their music down" and got "I've logged your complaint. Your landlord has
// been notified and will follow up." Nothing was logged; the table had zero
// rows. Three of four complaint phrasings did this.
//
// Worse than an unfulfilled promise: "I'll look into it" leaves someone
// waiting, "I've filed it" makes them STOP. They do not follow up, and the
// landlord never hears about it.
describe('claimsAnActionItNeverTook — a completed action with nothing behind it', () => {
  it('catches the replies that actually shipped', () => {
    for (const reply of [
      "I've logged your complaint about the noise from your neighbor. Your landlord has been notified and will follow up.",
      "I've logged this as a complaint so your landlord can address it.",
      'Your complaint has been recorded and sent to your landlord.',
      "I've filed a maintenance request for you.",
      "I've cancelled that for you.",
      "I've updated your payment method.",
    ]) expect(claimsAnActionItNeverTook(reply), reply).toBe(true)
  })

  // Information ABOUT actions is not a claim to have taken one.
  it('leaves ordinary replies alone', () => {
    for (const reply of [
      'Your landlord can see complaints in their portal.',
      'You can file a maintenance request from the Repairs tab.',
      'Would you like me to pass this to your landlord?',
      'That gets logged automatically when rent is late.',
      'Bob Chen in Apt 101 is $2,330 behind.',
      "I don't want to give you a figure I haven't actually checked.",
    ]) expect(claimsAnActionItNeverTook(reply), reply).toBe(false)
  })
})

// ── S618: the rule is not the same for every audience ────────────────────
//
// The inversion was written for tenants and landlords and applied to everyone,
// which broke the sales agent: "what's the price per unit" demanded a lookup,
// the sales profile holds NO data tools, and a correct "$2 per occupied unit"
// was suppressed as an unbacked figure — the commercial front door answering a
// pricing question with "which part were you after, your balance or your
// lease?" to someone who has neither.
describe('demandsAToolCall — per audience', () => {
  it('exempts a PROSPECT: they have no account, so nothing varies per user', () => {
    for (const m of [
      "what's the price per unit", 'what is GAM', 'do you support RV parks?',
      'is there a setup fee', 'how much is it per unit',
    ]) expect(demandsAToolCall(m, 'prospect'), m).toBe(false)
  })

  it('still guards a TENANT asking the same shape of question', () => {
    expect(demandsAToolCall("what's the price per unit", 'tenant')).toBe(true)
    expect(demandsAToolCall('how much is my rent?', 'tenant')).toBe(true)
  })

  // For a guest or a site visitor, "how much does it cost" is the nightly price
  // of THIS spot — per property, set by that landlord — not GAM's rate card.
  it('makes a GUEST or VISITOR look up even a price question', () => {
    for (const m of ['what does this site cost per night', 'how much is it a night', 'what is my booking total']) {
      expect(demandsAToolCall(m, 'guest'), m).toBe(true)
      expect(demandsAToolCall(m, 'visitor'), m).toBe(true)
    }
  })

  it('still lets a greeting through for every audience', () => {
    for (const a of ['tenant', 'landlord', 'prospect', 'guest', 'visitor']) {
      expect(demandsAToolCall('hi', a), a).toBe(false)
      expect(demandsAToolCall('thanks', a), a).toBe(false)
    }
  })
})
