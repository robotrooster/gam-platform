/**
 * S616 (Nic) — "We need to add a thing that searches for the word grace in all
 * of those phrases, for any lease formats. It should only ignore the word grace
 * when it's the name of a person on the lease, which should be rare, but not
 * never."
 *
 * The old extractor matched exactly ONE phrasing — "by the 5th day" — and every
 * other way a lease says this fell through to a silent default of 5. That
 * default drives what a tenant is told about their autopay date, so a lease with
 * a ten-day grace could have had someone warned off a day that was actually
 * free.
 */
import { describe, it, expect } from 'vitest'
import { extractGraceDays, graceLooksLikeAName } from './extractors'

const val = (t: string) => extractGraceDays(t)?.value ?? null

describe('grace period, however the lease phrases it (S616)', () => {
  it('grace period of five (5) days', () => {
    expect(val('Tenant shall have a grace period of five (5) days.')).toBe(5)
  })
  it('grace period: 10 days', () => {
    expect(val('LATE CHARGES. Grace period: 10 days.')).toBe(10)
  })
  it('a 7-day grace period', () => {
    expect(val('Rent is late after a 7-day grace period.')).toBe(7)
  })
  it('five (5) day grace period', () => {
    expect(val('There shall be a five (5) day grace period for rent.')).toBe(5)
  })
  it('grace period shall be 3 calendar days', () => {
    expect(val('The grace period shall be 3 calendar days from the due date.')).toBe(3)
  })
  it('grace of 5 days', () => {
    expect(val('Landlord allows a grace of 5 days before assessing a late fee.')).toBe(5)
  })
  it('spelled-out numbers with no digits at all', () => {
    expect(val('A grace period of ten days is provided.')).toBe(10)
  })

  // The phrasings that never say the word.
  it('still reads the original "by the 5th day" form', () => {
    expect(val('If rent is not remitted by the 5th day of the month...')).toBe(5)
  })
  it('on or before the 3rd', () => {
    expect(val('Rent must be received on or before the 3rd of each month.')).toBe(3)
  })
  it('within five (5) days of the due date', () => {
    expect(val('A late fee applies if not paid within five (5) days of the due date.')).toBe(5)
  })

  // THE PERSON PROBLEM. A tenant named Grace must not set the billing engine's
  // grace period.
  it('ignores a tenant named Grace Whitfield', () => {
    expect(val('This Lease is between Landlord and Grace Whitfield, Tenant, for 12 months.')).toBeNull()
  })
  it('ignores a middle name', () => {
    expect(val('Tenant: Mary Grace Alvarez. Term: 12 months.')).toBeNull()
  })
  it('a named tenant does NOT block a real grace clause elsewhere', () => {
    const lease = 'Tenant Grace Whitfield agrees. LATE FEE: a grace period of 7 days applies.'
    expect(val(lease)).toBe(7)
  })

  it('refuses an absurd count rather than guessing', () => {
    expect(val('a grace period of 99 days')).toBeNull()
  })

  it('returns null when the lease is silent, so the caller can say so', () => {
    expect(extractGraceDays('Rent is due on the first of the month.')).toBeNull()
  })
})

describe('graceLooksLikeAName', () => {
  it('spots a surname after it', () => {
    const t = 'Grace Whitfield'
    expect(graceLooksLikeAName(t, t.indexOf('Grace'))).toBe(true)
  })
  it('does not mistake "Grace Period" for a person', () => {
    const t = 'Grace Period: 5 days'
    expect(graceLooksLikeAName(t, t.indexOf('Grace'))).toBe(false)
  })
  it('lowercase grace is never a name', () => {
    const t = 'a grace period of 5 days'
    expect(graceLooksLikeAName(t, t.indexOf('grace'))).toBe(false)
  })
})
