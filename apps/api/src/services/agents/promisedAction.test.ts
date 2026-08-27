/**
 * S626 — "I'll file that" strands the customer, and nothing caught it.
 *
 * QUESTING_VERB covers going and LOOKING. It never covered ACTING, so
 * "I'll file a maintenance request for the leaking kitchen sink. How urgent is
 * this issue?" passed every guard: not past tense (claimsAnActionItNeverTook
 * missed it), promises no lookup (saysItWillCheck missed it). Nothing was
 * filed. profiles.ts has forbidden exactly this since S552 and it was never
 * enforced.
 */
import { describe, it, expect } from 'vitest'
import { promisesAnAction } from './agentRunner'

describe('a promise to act with nothing behind it', () => {
  it.each([
    // The measured one, verbatim.
    "I can help with that. I'll file a maintenance request for the leaking kitchen sink. How urgent is this issue?",
    "I'll submit that request for you.",
    "I'll open a ticket about the broken lock.",
    "Let me put that in for you.",
    "I'll log that complaint with your landlord.",
    "I'll cancel that for you.",
    "I'm setting that up now.",
  ])('flags %j', (t) => expect(promisesAnAction(t)).toBe(true))
})

describe('what must NOT be flagged', () => {
  it('a promise of a PERSON — escalation has its own net and its own rules', () => {
    expect(promisesAnAction("I'll get someone from the team to look at this for you.")).toBe(false)
  })

  it.each([
    // Reporting something already done is claimsAnActionItNeverTook's job.
    'Your maintenance request has been filed and routed to your landlord.',
    // Plain answers.
    'You currently owe $2,330, and rent is paid in full — one payment.',
    'Your lease ends on January 4, 2027.',
    // Describing what THEY can do is not a promise by the agent.
    'You can file that from the Maintenance tab in your portal.',
    // An offer is not a promise — it is asking permission.
    'Want me to file that for you?',
  ])('leaves %j alone', (t) => expect(promisesAnAction(t)).toBe(false))

  it('is inert on empty input', () => {
    expect(promisesAnAction('')).toBe(false)
  })
})
