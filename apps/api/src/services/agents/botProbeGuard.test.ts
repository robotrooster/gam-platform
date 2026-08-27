/**
 * S624 — "are you a real person?" must not be treated as an account question.
 *
 * Skye answered this honestly and the account-data safety net threw her reply
 * away, substituting "Which booking do you mean — the dates, the total, or the
 * site you're on?" The customer had asked whether she was human.
 *
 * It failed for tenant, landlord and guest but never for the prospect agent —
 * because a prospect is already exempt from lookups, so the net never fired for
 * Lucy. That asymmetry is what gave it away: the disclosure rule was working the
 * whole time, and the guard was eating it.
 */
import { describe, it, expect } from 'vitest'
import { demandsAToolCall } from './agentRunner'

describe('questions about the agent', () => {
  it('never demand a tool — no tool can answer them', () => {
    for (const m of [
      'are you a real person?',
      'are you a real person or a bot?',
      'wait, am I talking to a real person or a bot?',
      'before we go on, am I chatting with a human or a bot?',
      'are you human?',
      'are you a bot',
      'are you an AI?',
      'is this a robot',
      'who am I speaking with',
      "you're a bot aren't you",
      'r u human',
    ]) {
      expect(demandsAToolCall(m, 'tenant'), m).toBe(false)
      expect(demandsAToolCall(m, 'guest'), m).toBe(false)
      expect(demandsAToolCall(m, 'landlord'), m).toBe(false)
    }
  })

  // The exemption has to stay narrow — it must not become a hole that lets a
  // real account question skip its lookup.
  it('still demands a tool for the customer’s own data', () => {
    for (const m of [
      'what do I owe right now?',
      'when does my lease end?',
      'are you able to tell me my balance?',
      'how much is my deposit?',
      'who is behind on rent?',
      'is my payment real or did it fail?',
      'are you charging me a real late fee?',
    ]) {
      expect(demandsAToolCall(m, 'tenant') || demandsAToolCall(m, 'landlord'), m).toBe(true)
    }
  })

  it('greetings are still exempt, as before', () => {
    expect(demandsAToolCall('hey', 'tenant')).toBe(false)
    expect(demandsAToolCall('thanks!', 'tenant')).toBe(false)
  })
})
