import { describe, it, expect } from 'vitest'
import { isScreeningFeeText } from './screeningFee'

describe('isScreeningFeeText', () => {
  it('catches the clause on Oak Park’s lease', () => {
    expect(isScreeningFeeText(
      'Tenant shall fill out an Application form and pay a $35.00 non-refundable fee for a background check.'
    )).toBe(true)
  })

  it('catches the ways leases say it', () => {
    for (const t of [
      'a credit check fee of $40',
      'Applicant shall pay for a criminal background screening',
      'a $50 tenant screening fee',
      'the cost of a consumer report',
      'an eviction history search fee of $25',
      'a screening fee of $30',
    ]) expect(isScreeningFeeText(t), t).toBe(true)
  })

  it('leaves ordinary move-in charges alone', () => {
    for (const t of [
      'a non-refundable pet fee of $250',
      'a cleaning fee of $150 at move out',
      'an administrative fee of $75',
      'a key deposit of $50',
      'first month rent is due at signing',
      'a $200 move-in fee',
    ]) expect(isScreeningFeeText(t), t).toBe(false)
  })

  it('does not treat a bare application fee as screening', () => {
    // It can be a real administrative charge; only screening language converts it.
    expect(isScreeningFeeText('a $50 application fee is due with the application')).toBe(false)
    expect(isScreeningFeeText('a $50 application fee covering the background check')).toBe(true)
  })

  it('never claims pet screening', () => {
    expect(isScreeningFeeText('a $25 pet screening fee')).toBe(false)
  })

  it('is safe on empty input', () => {
    for (const v of ['', '   ', null, undefined]) expect(isScreeningFeeText(v as any)).toBe(false)
  })
})
