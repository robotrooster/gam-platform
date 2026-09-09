/**
 * S639 — a test run must never reach live Stripe.
 *
 * Nic found 51 transactions on his LIVE Stripe account, 43 of them incomplete
 * $44.99 screening intents created in bursts on the evening of 2026-09-02. A
 * card was never entered on any of them, and 41 carried a metadata userId that
 * does not exist in the production database: they were minted by the TEST SUITE
 * against the live key, on seeded users that were dropped with the test database
 * seconds later.
 *
 * apps/api/.env holds the live secret and globalSetup loads it, vitest runs
 * singleFork so one process imports every route module, and five of the six test
 * files that exercise the screening intake had no vi.mock('stripe'). Per-file
 * mocking was the only thing between the suite and Nic's real account.
 *
 * This is the safeguard that replaces the coincidence.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { stripeSecretKeyOrNull, getStripe } from './stripe'

const original = process.env.STRIPE_SECRET_KEY
afterEach(() => {
  if (original === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = original
})

describe('S639 live Stripe key is unreachable from a test run', () => {
  it('refuses a live key while running under vitest', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_thisIsNotARealKey'
    expect(stripeSecretKeyOrNull()).toBeUndefined()
    expect(() => getStripe()).toThrow(/LIVE Stripe key/i)
  })

  it('still allows a test-mode key — nothing real moves on one', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_thisIsNotARealKey'
    expect(stripeSecretKeyOrNull()).toBe('sk_test_thisIsNotARealKey')
  })

  it('an absent key is absent, not a live-key refusal', () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(stripeSecretKeyOrNull()).toBeUndefined()
    expect(() => getStripe()).toThrow(/not set/i)
  })

  it('the real environment this suite runs in hands out no live key', () => {
    // Whatever apps/api/.env holds, the suite must not be able to reach it.
    const k = stripeSecretKeyOrNull()
    expect(k === undefined || !k.startsWith('sk_live')).toBe(true)
  })
})
