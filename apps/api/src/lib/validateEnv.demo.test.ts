/**
 * S630 (Nic): the demo environment "can never take real payments... it needs to
 * be fully separated." A demo instance is identified by its DATABASE — pointing
 * at gam_demo IS the declaration — and booting one with live Stripe credentials
 * is refused, not warned about. The failure mode is charging a real card during
 * a sales call.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { assertDemoIsolation, DemoSafetyError } from './validateEnv'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

describe('assertDemoIsolation', () => {
  it('refuses a demo database holding a LIVE Stripe key', () => {
    process.env.DB_NAME = 'gam_demo'
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123'
    expect(() => assertDemoIsolation()).toThrow(DemoSafetyError)
    expect(() => assertDemoIsolation()).toThrow(/never be able to move real money/)
  })

  it('allows a demo database with a test key', () => {
    process.env.DB_NAME = 'gam_demo'
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    expect(() => assertDemoIsolation()).not.toThrow()
  })

  it('allows a demo database with no Stripe key at all', () => {
    process.env.DB_NAME = 'gam_demo'
    delete process.env.STRIPE_SECRET_KEY
    expect(() => assertDemoIsolation()).not.toThrow()
  })

  it('leaves production with a live key alone', () => {
    process.env.DB_NAME = 'gam'
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123'
    delete process.env.GAM_DEMO_MODE
    expect(() => assertDemoIsolation()).not.toThrow()
  })

  // The reverse mistake is worse: real tenants reading seeded data.
  it('refuses demo MODE pointed at the real database', () => {
    process.env.DB_NAME = 'gam'
    process.env.GAM_DEMO_MODE = 'true'
    expect(() => assertDemoIsolation()).toThrow(/not run against real customer data/)
  })

  it('matches any demo-named database, not just the exact name', () => {
    process.env.DB_NAME = 'gam_demo_sales'
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc'
    expect(() => assertDemoIsolation()).toThrow(DemoSafetyError)
  })
})
