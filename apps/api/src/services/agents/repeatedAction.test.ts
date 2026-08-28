/**
 * S628 — the same action must not be carried out twice in one conversation.
 *
 * The failure this pins, verbatim from the validation run:
 *
 *   ▸ my kitchen sink has been leaking since yesterday
 *     "I've filed a maintenance request for the leaking kitchen sink."
 *   ▸ ok great, thanks — so that is definitely logged?
 *     "The maintenance request is already logged."   ← the reply is CORRECT
 *     tools: file_maintenance_request                ← and it filed a second one
 *
 * Right reply, wrong side effect, nothing in the transcript showing it. On a
 * money action the same shape bills somebody twice for one thing while telling
 * them once that it was handled.
 */
import { describe, it, expect } from 'vitest'
import { alreadyDone, argsFingerprint } from './repeatedAction'

const prior = [
  { name: 'file_maintenance_request', args: { title: 'Leaking kitchen sink', priority: 'high' } },
  { name: 'get_my_balance_breakdown', args: {} },
]

describe('refusing an action already taken', () => {
  it('catches the exact repeat that reached a tenant', () => {
    const r = alreadyDone('file_maintenance_request',
      { title: 'Leaking kitchen sink', priority: 'high' }, prior)
    expect(r?.repeated).toBe(true)
    expect(r?.tellThem).toMatch(/ALREADY DONE/)
    // And it must tell the model to say so WITHOUT reissuing its last reply —
    // otherwise the repeat guard fires on the very correction.
    expect(r?.tellThem).toMatch(/not by repeating/i)
  })

  it('does not care what order the keys were in', () => {
    expect(alreadyDone('file_maintenance_request',
      { priority: 'high', title: 'Leaking kitchen sink' }, prior)?.repeated).toBe(true)
    expect(argsFingerprint({ a: 1, b: 2 })).toBe(argsFingerprint({ b: 2, a: 1 }))
  })

  it('ALLOWS the same action with different arguments', () => {
    // A landlord may legitimately bill two different fees, add two units, or
    // credit two tenants in one conversation. Blocking on the tool NAME alone
    // would break every one of those and be far worse than the bug it fixes.
    expect(alreadyDone('file_maintenance_request',
      { title: 'Broken porch light', priority: 'normal' }, prior)).toBeNull()
  })

  it('NEVER blocks a lookup, however many times it runs', () => {
    // Asking twice what somebody owes is free and often right — the balance may
    // have changed. Refusing it would push the agent back toward answering from
    // memory, which is the failure the whole system exists to prevent.
    expect(alreadyDone('get_my_balance_breakdown', {}, prior)).toBeNull()
    expect(alreadyDone('get_my_lease', {}, [{ name: 'get_my_lease', args: {} }])).toBeNull()
    expect(alreadyDone('lookup_tenant_payment_status', { name: 'chen' },
      [{ name: 'lookup_tenant_payment_status', args: { name: 'chen' } }])).toBeNull()
  })

  it('a fresh conversation blocks nothing', () => {
    expect(alreadyDone('file_maintenance_request', { title: 'x' }, [])).toBeNull()
  })

  it('treats a money action the same way', () => {
    const money = [{ name: 'issue_tenant_credit', args: { leaseId: 'L1', amount: 35 } }]
    expect(alreadyDone('issue_tenant_credit', { leaseId: 'L1', amount: 35 }, money)?.repeated).toBe(true)
    // A second, different credit on the same lease is a real thing to do.
    expect(alreadyDone('issue_tenant_credit', { leaseId: 'L1', amount: 50 }, money)).toBeNull()
  })
})
