/**
 * S642 — Nic: "Instead of showing $199 fees from Stripe I want to see our
 * margin on that too."
 *
 * GAM recorded what it charged the tenant and nothing about what Stripe charged
 * GAM, so the platform could show fee revenue and not profit. These pin the two
 * things that made the first cut of it wrong.
 */
import { describe, it, expect } from 'vitest'
import { categorise, parsePeriod, COST_LABELS, COST_CATEGORIES } from './stripeCosts'

describe('S642 categorising what Stripe charged us', () => {
  it('reads Stripe’s own prose into our categories', () => {
    expect(categorise('Card payments (2026-09-06): Transaction network costs')).toBe('card_interchange')
    expect(categorise('Card payments (2026-09-06): Stripe volume fee')).toBe('stripe_volume_fee')
    expect(categorise('Card payments (2026-09-12): Stripe per-authorization fee')).toBe('per_authorization')
    expect(categorise('Authorization Boost (2026-09-06)')).toBe('authorization_boost')
    expect(categorise('Radar (2026-09-04): Standard')).toBe('radar')
    expect(categorise('Connections Balance Refresh (2026-08-01 - 2026-08-31)')).toBe('bank_linking')
    expect(categorise('Something Stripe has not invented yet')).toBe('other')
  })

  it('every category has a label a human would read', () => {
    for (const c of COST_CATEGORIES) {
      expect(COST_LABELS[c]).toBeTruthy()
      expect(COST_LABELS[c]).not.toBe(c)
    }
  })

  it('attributes a charge to the period it COVERS, not the day it posted', () => {
    // August's bank-linking bill posts on September 1. Billing it to September
    // would overstate that month's cost and understate August's — and at 00:00
    // UTC it is still August in Phoenix, so the posting date was wrong in a way
    // that depended on the server's timezone.
    expect(parsePeriod('Connections Balance Refresh (2026-08-01 - 2026-08-31)'))
      .toEqual({ start: '2026-08-01', end: '2026-08-31' })
  })

  it('a single-day charge is its own period', () => {
    expect(parsePeriod('Card payments (2026-09-06): Transaction network costs'))
      .toEqual({ start: '2026-09-06', end: '2026-09-06' })
  })

  it('no period named → attributed where it posted', () => {
    expect(parsePeriod('Bank debit fee on txn_123')).toEqual({ start: null, end: null })
  })
})
