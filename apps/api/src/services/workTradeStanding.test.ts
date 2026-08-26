import { describe, it, expect } from 'vitest'
import { workTradeStanding, type CarriedPeriod } from './workTradeStanding'

const carried = (o: Partial<CarriedPeriod> = {}): CarriedPeriod => ({
  periodMonth: '2026-09-01', hoursOutstanding: 20, hourRate: 6.25, closesRemaining: 0, ...o,
})

describe('what the tenant is told', () => {
  it('states BOTH figures and the total — the point of the whole change', () => {
    const s = workTradeStanding({
      currentMonth: '2026-10-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [carried()], bankedHours: 0,
    })
    expect(s.currentMonthHours).toBe(80)
    expect(s.carriedHours).toBe(20)
    expect(s.catchUpHours).toBe(100)     // Nic's own example
    expect(s.summary).toContain('80 hours covers this month')
    expect(s.summary).toContain('20 hours is still owed from earlier')
    expect(s.summary).toContain('100 hours in total')
    expect(s.summary).toContain('$125.00')
  })

  it('does not invent a carried balance when there isn’t one', () => {
    const s = workTradeStanding({
      currentMonth: '2026-10-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [], bankedHours: 0,
    })
    expect(s.catchUpHours).toBe(80)
    expect(s.summary).toBe('80 hours covers this month.')
  })

  it('counts banked hours against what is owed', () => {
    const s = workTradeStanding({
      currentMonth: '2026-10-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [], bankedHours: 30,
    })
    expect(s.catchUpHours).toBe(50)
    expect(s.summary).toContain('30 hours banked')
  })

  it('says so plainly when nothing is owed', () => {
    const s = workTradeStanding({
      currentMonth: '2026-10-01', currentMonthTarget: 80, currentMonthApplied: 80,
      carried: [], bankedHours: 0,
    })
    expect(s.summary).toBe("You're fully covered for this month.")
  })
})

describe('telling the landlord when it cannot be caught up', () => {
  // Nic: "at some point, a landlord's gonna know that somebody's never gonna be
  // able to physically catch up. There's just not that many hours in a month."
  it('flags a debt no human could work off', () => {
    const s = workTradeStanding({
      currentMonth: '2026-10-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [carried({ hoursOutstanding: 400 })], bankedHours: 0,
    })
    expect(s.catchUpHours).toBe(480)
    expect(s.catchUpPlausible).toBe(false)   // 31 days × 12h = 372
  })

  it('leaves a hard but possible month alone', () => {
    const s = workTradeStanding({
      currentMonth: '2026-10-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [carried({ hoursOutstanding: 60 })], bankedHours: 0,
    })
    expect(s.catchUpHours).toBe(140)
    expect(s.catchUpPlausible).toBe(true)
  })

  it('names the period that bills first', () => {
    const s = workTradeStanding({
      currentMonth: '2026-11-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [
        carried({ periodMonth: '2026-10-01', closesRemaining: 1 }),
        carried({ periodMonth: '2026-09-01', closesRemaining: 0 }),
      ],
      bankedHours: 0,
    })
    expect(s.nextBillingMonth).toBe('2026-09-01')
  })

  it('prices each carried month at its own rate', () => {
    const s = workTradeStanding({
      currentMonth: '2026-11-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [
        carried({ periodMonth: '2026-09-01', hoursOutstanding: 20, hourRate: 6.25 }),
        carried({ periodMonth: '2026-10-01', hoursOutstanding: 20, hourRate: 11.25 }),
      ],
      bankedHours: 0,
    })
    expect(s.carriedValue).toBe(125 + 225)
  })
})
