/**
 * S607 — the per-method price breakdown shown on a tenant's invoice.
 *
 * Nic: "maybe on the invoice, it can show a breakdown of what each bill would be
 * by payment method... that way they see all the avenues and the price at the
 * point the invoice comes out."
 *
 * The load-bearing test is the last one: the figure QUOTED to the tenant and the
 * figure the platform CHARGES must come from the same formula. A tenant choosing
 * a method on a number we then do not honor is the failure this guards.
 */
import { describe, it, expect } from 'vitest'
import { paymentMethodCosts, processingFeeFor, PROCESSING_FEES } from '@gam/shared'
import { computePlatformCut } from './stripeConnect'

describe('paymentMethodCosts', () => {
  // Oak Park's actual rent, the number Nic used.
  const rent = 450

  it('prices every avenue the tenant has', () => {
    const rows = paymentMethodCosts(rent)
    expect(rows.map(r => r.method)).toEqual(['ach', 'card', 'manual'])
  })

  it('bank is the flat fee on top', () => {
    const [ach] = paymentMethodCosts(rent)
    expect(ach.fee).toBeCloseTo(PROCESSING_FEES.ACH_FLAT, 2)
    expect(ach.total).toBeCloseTo(rent + PROCESSING_FEES.ACH_FLAT, 2)
  })

  it('card is percentage plus flat', () => {
    const card = paymentMethodCosts(rent)[1]
    expect(card.fee).toBeCloseTo(450 * 0.035 + 0.55, 2)   // 16.30
    expect(card.total).toBeCloseTo(466.30, 2)
  })

  it('a non-US card carries the international add-on', () => {
    const card = paymentMethodCosts(rent, { cardCountry: 'CA' })[1]
    expect(card.fee).toBeCloseTo(450 * 0.05 + 0.55, 2)    // 3.5% + 1.5%
  })

  // S654 (Nic): "Paying cash or check is free." Always — no option can price it.
  it('cash, check or money order is free, and says so', () => {
    for (const amount of [450, 12.34, 7500]) {
      const manual = paymentMethodCosts(amount, { cardCountry: 'CA' })[2]
      expect(manual.method).toBe('manual')
      expect(manual.fee).toBe(0)
      expect(manual.total).toBeCloseTo(amount, 2)
      expect(manual.label).toMatch(/free/i)
    }
  })

  it('rounds to the cent so the quote is payable as shown', () => {
    const card = paymentMethodCosts(333.33)[1]
    expect(card.total).toBe(Math.round(card.total * 100) / 100)
  })

  // ── The anti-drift guard ──────────────────────────────────────────────────
  it('quotes exactly what the platform charges', () => {
    for (const amount of [450, 440, 1000, 12.34, 0.01, 7500]) {
      const rows = paymentMethodCosts(amount)
      expect(rows[0].fee).toBeCloseTo(
        computePlatformCut({ amount, paymentMethod: 'ach' }), 2)
      expect(rows[1].fee).toBeCloseTo(
        computePlatformCut({ amount, paymentMethod: 'card' }), 2)
      expect(rows[1].fee).toBeCloseTo(
        processingFeeFor({ amount, paymentMethod: 'card' }), 2)
    }
  })

  it('still matches for a non-US card, where the add-on could diverge', () => {
    const amount = 450
    expect(paymentMethodCosts(amount, { cardCountry: 'CA' })[1].fee).toBeCloseTo(
      computePlatformCut({ amount, paymentMethod: 'card', cardCountry: 'CA' }), 2)
  })
})
