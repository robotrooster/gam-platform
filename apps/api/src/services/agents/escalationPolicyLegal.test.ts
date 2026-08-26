/**
 * S624 — a legal dispute must reach a person.
 *
 * The eval caught this: a tenant saying "my landlord is illegally withholding my
 * deposit and I want to take legal action" did NOT escalate. The agent tried;
 * the anti-over-escalation guard in agentRunner cancelled it, because it asks
 * needsARealPerson() whether a message needs a human and legal intent was not on
 * that list. It saw "deposit", concluded a tool could answer, and looked the
 * balance up instead.
 *
 * The distinction these tests hold is the one that makes the guard safe: INTENT
 * to act against the other party is a hard stop, while merely mentioning the law
 * is a question the agent should answer.
 */
import { describe, it, expect } from 'vitest'
import { needsARealPerson, mentionsLegalAction } from './escalationPolicy'

describe('announcing legal action', () => {
  it('is a hard stop — this is the exact message the eval failed on', () => {
    expect(needsARealPerson(
      'I think my landlord is illegally withholding my deposit and I want to take legal action.'
    )).toBe(true)
  })

  it('covers the ways people actually say it', () => {
    for (const m of [
      'I am going to sue my landlord',
      "I'm suing over this",
      'taking them to court',
      'I want to take legal action against the property manager',
      'I already spoke to a lawyer about this',
      "I'm getting an attorney",
      'my attorney says this is illegal',
      'I will file in small claims',
      'I want to press charges',
    ]) {
      expect(needsARealPerson(m), `should escalate: ${m}`).toBe(true)
    }
  })
})

describe('merely mentioning the law is not a dispute', () => {
  // The guard has to stay narrow or the agent becomes useless to the people who
  // use it most — a landlord serving notices is doing routine work.
  it('lets routine landlord questions be answered', () => {
    for (const m of [
      'how do I serve an eviction notice?',
      'what does the law say about entry notice in Arizona?',
      'how many days notice does a court require for a rent increase?',
      'what is the legal maximum for a security deposit here?',
      'my tenant got a court summons for something unrelated, does that affect the lease?',
    ]) {
      expect(needsARealPerson(m), `should NOT force a handoff: ${m}`).toBe(false)
    }
  })

  // The broader pattern still fires for the support-contact line, which is
  // harmless to add and useful when the law comes up at all.
  it('still appends the support line on the broader legal topics', () => {
    expect(mentionsLegalAction('how do I serve an eviction notice?')).toBe(true)
    expect(mentionsLegalAction('what does the law say about entry notice?')).toBe(false)
  })
})

describe('the other hard stops still hold', () => {
  it('money disputes and account security are unchanged', () => {
    expect(needsARealPerson('I was double-charged and I want a refund')).toBe(true)
    expect(needsARealPerson('someone else logged into my account')).toBe(true)
  })

  it('an ordinary lookup is still not a hard stop', () => {
    expect(needsARealPerson('what do I owe right now?')).toBe(false)
    expect(needsARealPerson('when does my lease end?')).toBe(false)
  })
})
