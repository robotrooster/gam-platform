/**
 * S630: "I'm just the AI assistant" is never a reason something cannot be done.
 *
 * profiles.ts has forbidden this in so many words since S629, quoting the exact
 * sentence, and the model still produced it in the two-turn run — to a landlord
 * who was entitled to decide, about a tool the agent holds. More prompt is not
 * the fix; this model degrades past ~8KB of system prompt and stops calling
 * tools at all. Caught here, like every other invention net.
 */
import { describe, it, expect } from 'vitest'
import { disclaimsAbilityAsAnAI } from './agentRunner'

describe('disclaimsAbilityAsAnAI', () => {
  it('catches the measured failure, across sentences', () => {
    expect(disclaimsAbilityAsAnAI(
      "The late fee on Apt 204 is $50.00. I can't waive it for you. I'm just the AI assistant on the GAM team."
    )).toBe(true)
  })

  it('catches it within one sentence', () => {
    for (const r of [
      "I can't do that as an AI assistant.",
      "As an AI, I'm unable to change your lease.",
      "I'm an AI so I cannot issue a credit.",
    ]) expect(disclaimsAbilityAsAnAI(r), r).toBe(true)
  })

  // Answering "are you a bot?" honestly is a DIFFERENT thing and must keep
  // working — that is the S598 directive, and this net must not touch it.
  it('leaves an honest answer about what it is alone', () => {
    for (const r of [
      "Honestly, I'm GAM's AI assistant — but I can get you on a call with someone on the team.",
      "Yes, I'm an AI assistant on the GAM team. What can I help with?",
    ]) expect(disclaimsAbilityAsAnAI(r), r).toBe(false)
  })

  // A refusal with a REAL reason is exactly what we want and must pass through.
  it('leaves a refusal with an actual reason alone', () => {
    for (const r of [
      "I can't waive that — only the landlord can, and this is their tenant's charge.",
      "I'm not able to change a signed lease without both parties agreeing to an addendum.",
      "I can't do that until you tell me which unit you mean.",
    ]) expect(disclaimsAbilityAsAnAI(r), r).toBe(false)
  })

  it('is not tripped by an ordinary reply', () => {
    expect(disclaimsAbilityAsAnAI('Your balance is $2,330.00.')).toBe(false)
    expect(disclaimsAbilityAsAnAI('')).toBe(false)
  })
})
