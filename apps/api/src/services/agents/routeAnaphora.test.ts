/**
 * S626 — routing a follow-up that does not carry its own subject.
 *
 * Nic on the lease-end-then-renewal conversation: "Should infer 'renewal' from
 * the two messages together." The table only ever saw the current message, so
 * "and what happens if I want to stay on after that?" routed nothing and the
 * agent invented a renewal request it offered to submit.
 */
import { describe, it, expect } from 'vitest'
import { routePlan } from './toolRouting'

const TENANT_TOOLS = [
  'get_my_lease', 'get_my_landlord_renewal_tendency', 'get_my_balance_breakdown',
  'get_my_full_lease', 'get_my_deposit', 'file_maintenance_request',
]
const plan = (msg: string, prev?: string) => routePlan(msg, 'tenant' as any, TENANT_TOOLS, prev).tools

describe('renewal is asked for without the word "renew"', () => {
  it.each([
    'and what happens if I want to stay on after that?',
    'what if I want to stay longer?',
    'can I keep the place after that?',
    'I was hoping to stay past the end date',
    'can I extend my lease?',
    'would I sign a new lease?',
  ])('routes %j to the lease AND the landlord tendency', (msg) => {
    const tools = plan(msg)
    expect(tools).toContain('get_my_landlord_renewal_tendency')
    expect(tools).toContain('get_my_lease')
  })
})

describe('anaphoric follow-ups resolve against the previous turn', () => {
  it('the exact conversation from the review', () => {
    // Alone it is about nothing.
    expect(plan('and what happens after that?')).toEqual([])
    // With the turn that named the subject, it is about renewal.
    expect(plan('and what happens after that?', 'when does my lease end?'))
      .toContain('get_my_landlord_renewal_tendency')
  })

  it('is a FALLBACK — it never overrides what the current message says', () => {
    // The follow-up plainly changes the subject to the balance. The previous
    // turn about the lease must not drag it back.
    const tools = plan('actually how much do I owe right now?', 'when does my lease end?')
    expect(tools).toContain('get_my_balance_breakdown')
    expect(tools).not.toContain('get_my_landlord_renewal_tendency')
  })

  it('adds nothing when neither turn routes', () => {
    expect(plan('thanks, appreciate it', 'lovely weather')).toEqual([])
  })

  it('is inert without history, exactly as before', () => {
    expect(plan('when does my lease end?')).toContain('get_my_lease')
  })
})
