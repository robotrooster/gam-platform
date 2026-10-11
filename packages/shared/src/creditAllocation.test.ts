import { describe, it, expect } from 'vitest'
import { allocateCredits } from './creditAllocation'

describe('allocateCredits — every dollar once', () => {
  it('spends a general credit once across two leases, oldest first', () => {
    const r = allocateCredits([{ leaseId: null, amount: 100 }], [
      { key: 'b', leaseId: 'b', total: 470.22, earliestDue: '2026-09-01' },
      { key: 'a', leaseId: 'a', total: 60, earliestDue: '2026-08-01' },
    ])
    expect(r.applied).toEqual({ a: 60, b: 40 })
    expect(r.remaining).toBe(0)
  })

  it('keeps a lease-tied credit on its own lease', () => {
    const r = allocateCredits([{ leaseId: 'a', amount: 500 }], [
      { key: 'a', leaseId: 'a', total: 220 },
      { key: 'b', leaseId: 'b', total: 440 },
    ])
    expect(r.applied).toEqual({ a: 220, b: 0 })
    expect(r.remaining).toBe(280)
  })

  it('never goes below zero and leaves the rest on the account', () => {
    const r = allocateCredits([{ leaseId: null, amount: 1000 }, { leaseId: 'a', amount: 5 }], [
      { key: 'a', leaseId: 'a', total: 100 },
    ])
    expect(r.applied).toEqual({ a: 100 })
    expect(r.remaining).toBe(905)
  })
})
