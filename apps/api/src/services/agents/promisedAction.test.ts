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

/**
 * S628 — the nudge must offer the third option: ask for what is missing.
 *
 * "Call the tool" and "no tool can do it" do not cover the commonest stall,
 * which is holding the right tool and being short a REQUIRED argument. A
 * prospect picked a call time and got "Great, I can book that. I'll send over
 * a calendar invite" — twice, through the forced retry — because the model had
 * no name or email, could not call book_sales_call, and had been told only not
 * to promise.
 *
 * Asserted on the prompt text rather than on model behaviour: the branch either
 * is offered to the model or it is not, and that is the part we control.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('the promised-action nudge', () => {
  const runner = readFileSync(join(__dirname, 'agentRunner.ts'), 'utf8')
  const nudge = runner.slice(
    runner.indexOf('STOP — you just told them you would do something'),
    runner.indexOf('promise it in the hope it resolves itself'))

  it('tells the model to ask for a missing REQUIRED value', () => {
    expect(nudge).toMatch(/missing something it REQUIRES/)
    expect(nudge).toMatch(/Ask for exactly the missing pieces/)
  })

  it('forbids inventing a required value, and names the dangerous ones', () => {
    // Defaulting an email on a booking tool sends a real confirmation to a
    // real stranger. This must never be collateral damage of the
    // "use a sensible default for the rest" line that sits just above it.
    expect(nudge).toMatch(/Never invent, assume or default a required value/)
    for (const field of ['name', 'email', 'phone number']) {
      expect(nudge, `should name ${field} as never-invented`).toContain(field)
    }
  })

  it('keeps the default-the-rest permission scoped to OPTIONAL details', () => {
    expect(nudge).toMatch(/Do not wait on OPTIONAL details first/)
  })
})

/**
 * S628 — THE MONEY VERBS, AND THE READ THAT DISARMED THE GUARD.
 *
 * Two defects, found on one landlord turn. Asked to waive a late fee the
 * landlord had already promised their tenant by phone, the agent replied
 * "The $100 late fee on Apt 204 is still pending. I'll waive it." and called
 * only lookup_tenant_payment_status. Nothing was waived.
 *
 *  1. ACTION_VERB covered filing, booking and sending but not one MONEY verb —
 *     waive, refund, credit, issue, apply, process — nor the lease decisions
 *     (approve, renew, extend, terminate). Those are the highest-consequence
 *     promises on the platform: a landlord who hears "I'll waive it" tells
 *     their tenant it is done.
 *
 *  2. The guard was gated on "no tool ran at all". A READ is how the agent
 *     finds out whether to act; it is never the acting. One lookup was enough
 *     to disarm it.
 *
 * The negatives matter as much as the positives here: several of these verbs
 * are also nouns ("there is an issue", "a refund takes three days"), and a
 * guard that fires on those burns a generation on every ordinary explanation.
 */
import { promisesAnAction } from './agentRunner'

describe('promisesAnAction — money and lease verbs', () => {
  it.each([
    ["The $100 late fee on Apt 204 is still pending. I'll waive it.", 'the measured failure'],
    ["I'll issue a credit for that.", 'credit'],
    ["I'll refund the difference.", 'refund'],
    ["I'll apply that to their balance.", 'apply'],
    ["I'll approve the application.", 'approve'],
    ["I'll process the payment.", 'process'],
    ["I'll extend their lease.", 'extend'],
    ["I'll renew it for another year.", 'renew'],
  ])('catches %j (%s)', (text) => {
    expect(promisesAnAction(text as string)).toBe(true)
  })

  it.each([
    ["I'll check that for you.", 'a lookup, not an action — a different net owns this'],
    ["I'll look into it.", 'same'],
    ['There is an issue with the payment.', 'issue as a NOUN'],
    ['Late fees apply after the grace period.', 'apply, not first person'],
    ['Your landlord can approve that in their portal.', 'describing who can act'],
    ['A refund usually takes three business days.', 'refund as a NOUN'],
    ['I can see the credit on your account.', 'credit as a NOUN, and a true statement'],
  ])('stays quiet on %j (%s)', (text) => {
    expect(promisesAnAction(text as string)).toBe(false)
  })
})
