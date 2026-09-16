import { describe, it, expect } from 'vitest'
import { moveInDefaults, prorateMoveInRent, moveInTotalDue, moveInDepositMirror,
  leaseDueDay, parseDueDay, dueDayLabel, nextDueDateAfter } from './moveInCharges'

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

describe('S648 due days', () => {
  it('fixed day and move-in day', () => {
    expect(leaseDueDay({ mode: 'fixed_day', propertyDay: 15, startIso: '2026-09-20' })).toBe(15)
    expect(leaseDueDay({ mode: 'move_in_day', propertyDay: 1, startIso: '2026-09-20' })).toBe(20)
    expect(leaseDueDay({ mode: 'move_in_day', propertyDay: 1, startIso: '2026-09-30' })).toBe(1)
  })
  it('reads and prints a due day', () => {
    expect(parseDueDay('the 15th')).toBe(15)
    expect(parseDueDay('31st')).toBeNull()
    expect(dueDayLabel(1)).toBe('1st')
    expect(dueDayLabel(22)).toBe('22nd')
    expect(dueDayLabel(13)).toBe('13th')
  })
  it('prorates to the next due date, not the 1st', () => {
    expect(nextDueDateAfter('2026-09-05', 15)).toBe('2026-09-15')
    expect(nextDueDateAfter('2026-09-20', 15)).toBe('2026-10-15')
    // Sept 5 → Sept 15 is 10 of the 31 days between Aug 15 and Sept 15
    expect(prorateMoveInRent(620, '2026-09-05', 15)).toBe(200)
    // Dec 20 → Jan 15 crosses the year
    expect(nextDueDateAfter('2026-12-20', 15)).toBe('2027-01-15')
  })
  it('anniversary billing never prorates', () => {
    expect(moveInDefaults({ rent: 500, startIso: '2026-09-20', existingTenancy: false,
      collectsNextPeriod: true, dueDay: 20, mode: 'move_in_day' })).toEqual({ firstMonthRent: 500, proration: 0 })
  })
})
