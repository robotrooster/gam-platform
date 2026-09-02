/**
 * S636 — storefront links must never be localhost in production.
 *
 * Nic: "the QR code link is generated from localhost three thousand and
 * fifteen. That means that's not gonna work at all."
 *
 * STOREFRONT_URL_TEMPLATE was unset on the live API and the fallback was
 * the DEV template, so guest stay links, Stripe booking returns and
 * waitlist claim links all shipped pointing at http://localhost:3015.
 * The env var is set now; this holds the DEFAULT, which is what stops it
 * silently regressing if that variable ever goes missing again.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { storefrontUrl } from './propertyBooking'

const ENV = { ...process.env }
afterEach(() => { process.env = { ...ENV } })

describe('storefrontUrl', () => {
  it('uses the explicit template when one is set', () => {
    process.env.STOREFRONT_URL_TEMPLATE = 'https://{slug}.example.test'
    expect(storefrontUrl('sunset-palms', '/apply')).toBe('https://sunset-palms.example.test/apply')
  })

  it('falls back to the PUBLIC subdomain in production, never localhost', () => {
    delete process.env.STOREFRONT_URL_TEMPLATE
    process.env.NODE_ENV = 'production'
    const url = storefrontUrl('sunset-palms', '/apply')
    expect(url).toBe('https://sunset-palms.gam.biz/apply')
    expect(url).not.toContain('localhost')
  })

  it('keeps the path-slug dev form outside production', () => {
    delete process.env.STOREFRONT_URL_TEMPLATE
    process.env.NODE_ENV = 'development'
    expect(storefrontUrl('sunset-palms')).toBe('http://localhost:3015/sunset-palms')
  })
})
