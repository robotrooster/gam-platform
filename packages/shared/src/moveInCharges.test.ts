import { describe, it, expect } from 'vitest'
import { moveInDefaults, prorateMoveInRent, moveInTotalDue, moveInDepositMirror } from './moveInCharges'

describe('page 8 move-in charges', () => {
  it('prorates from the move-in day through month end', () => {
    expect(prorateMoveInRent(500, '2026-09-16')).toBe(250)
    expect(prorateMoveInRent(500, '2026-09-01')).toBe(0)
  })
  it('onboarding: the month, no proration', () => {
    expect(moveInDefaults({ rent: 495, startIso: '2026-09-16', existingTenancy: true, collectsNextPeriod: true }))
      .toEqual({ firstMonthRent: 495, proration: 0 })
  })
  it('new mid-month move-in: proration only, unless the property collects the next month', () => {
    expect(moveInDefaults({ rent: 500, startIso: '2026-09-16', existingTenancy: false, collectsNextPeriod: false }))
      .toEqual({ firstMonthRent: 0, proration: 250 })
    expect(moveInDefaults({ rent: 500, startIso: '2026-09-16', existingTenancy: false, collectsNextPeriod: true }))
      .toEqual({ firstMonthRent: 500, proration: 250 })
  })
  it('totals every box and mirrors the deposit', () => {
    expect(moveInDepositMirror('350.00', false)).toBe(350)
    expect(moveInDepositMirror('350.00', true)).toBe(0)
    expect(moveInTotalDue({ firstMonthRent: '500', proration: '250', depositMirror: 350,
      moveInFees: ['$25', 'N/A', '0'] })).toBe(1125)
  })
})
