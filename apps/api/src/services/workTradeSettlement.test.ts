import { describe, it, expect } from 'vitest'
import {
  settleMonth, settleOnEnd, hourRateFor, proratedTarget,
  type SettlementPeriod,
} from './workTradeSettlement'

/**
 * Nic's worked example, S624: an 80-hour agreement against a $500 bill. Each
 * hour is 1/80 of the bill — $6.25.
 */
const period = (o: Partial<SettlementPeriod> & { periodMonth: string }): SettlementPeriod => ({
  targetHours: 80, hoursApplied: 0, basisAmount: 500,
  hourRate: hourRateFor(500, 80), agedCloses: 0, ...o,
})

describe('what an hour is worth', () => {
  // Nic: "if we had a hundred hours in the month needed to be worked, that means
  // each hour is worth one percent of the bill. At eighty hours, it's 1.25%."
  it('is the whole covered bill divided by the hours the month asks for', () => {
    expect(hourRateFor(500, 100)).toBe(5)      // 1% of $500
    expect(hourRateFor(500, 80)).toBe(6.25)    // 1.25% of $500
  })

  it('cannot be computed for a month that asks for no work', () => {
    expect(hourRateFor(500, 0)).toBe(0)
  })
})

describe('a prorated move-in month', () => {
  // A tenant moving in on the 20th is billed 11/31 of the rent. Asking them for
  // a full month of hours would open every work-trade tenancy in deficit.
  it('moves the target with the bill', () => {
    const t = proratedTarget(80, 500 * 11 / 31, 500)
    expect(t).toBeCloseTo(28.5, 1)
  })

  it('leaves a full month alone', () => {
    expect(proratedTarget(80, 500, 500)).toBe(80)
  })

  it('never asks for zero hours on a month that billed something', () => {
    expect(proratedTarget(80, 1, 500)).toBeGreaterThan(0)
  })
})

describe('settling a month from its own hours', () => {
  it('a full target month covers the whole bill', () => {
    const r = settleMonth({
      periods: [period({ periodMonth: '2026-09-01' })],
      hoursWorked: 80, bankedHours: 0, carryForwardMonths: 1,
    })
    expect(r.periods[0].status).toBe('settled')
    expect(r.periods[0].creditTotal).toBe(500)
    expect(r.periods[0].uncoveredAmount).toBe(0)
    expect(r.bankedHours).toBe(0)
    expect(r.endsAgreement).toBe(false)
  })

  // Nic's example verbatim: 80-hour agreement, 60 worked, 20 carry forward.
  it('leaves a deficit in HOURS when the month falls short', () => {
    const r = settleMonth({
      periods: [period({ periodMonth: '2026-09-01' })],
      hoursWorked: 60, bankedHours: 0, carryForwardMonths: 1,
    })
    expect(r.periods[0].hoursOutstanding).toBe(20)
    expect(r.periods[0].status).toBe('open')
    expect(r.periods[0].creditTotal).toBe(375)      // 60 × $6.25
    expect(r.periods[0].uncoveredAmount).toBe(125)  // 20 × $6.25
    expect(r.billedAmount).toBe(0)                  // still inside the window
  })

  // "Next month, they would have to work one hundred hours to be caught up."
  it('a caught-up month clears the carried deficit as well', () => {
    const r = settleMonth({
      periods: [
        period({ periodMonth: '2026-09-01', hoursApplied: 60 }),
        period({ periodMonth: '2026-10-01' }),
      ],
      hoursWorked: 100, bankedHours: 0, carryForwardMonths: 1,
    })
    const [sep, oct] = r.periods
    expect(oct.status).toBe('settled')
    expect(sep.status).toBe('settled')
    expect(sep.hoursAppliedNow).toBe(20)
    expect(sep.creditTotal).toBe(500)
    expect(r.billedAmount).toBe(0)
  })
})

describe('surplus banks without limit', () => {
  // Nic chose uncapped banking: deficits follow a tenant, so credits must too.
  it('carries hours beyond the target forward', () => {
    const r = settleMonth({
      periods: [period({ periodMonth: '2026-09-01' })],
      hoursWorked: 100, bankedHours: 0, carryForwardMonths: 1,
    })
    expect(r.periods[0].status).toBe('settled')
    expect(r.bankedHours).toBe(20)
  })

  it('accumulates across months rather than resetting', () => {
    const r = settleMonth({
      periods: [period({ periodMonth: '2026-10-01' })],
      hoursWorked: 95, bankedHours: 20, carryForwardMonths: 1,
    })
    expect(r.bankedHours).toBe(35)
  })

  it('spends the bank to rescue a month the tenant could not work', () => {
    const r = settleMonth({
      periods: [period({ periodMonth: '2026-10-01' })],
      hoursWorked: 30, bankedHours: 60, carryForwardMonths: 1,
    })
    expect(r.periods[0].status).toBe('settled')
    expect(r.periods[0].creditTotal).toBe(500)
    expect(r.bankedHours).toBe(10)  // 60 banked − 50 needed
  })

  // A month can never be credited past its own bill; the excess is not a windfall.
  it('never credits a month more than its bill', () => {
    const r = settleMonth({
      periods: [period({ periodMonth: '2026-09-01' })],
      hoursWorked: 500, bankedHours: 0, carryForwardMonths: 1,
    })
    expect(r.periods[0].creditTotal).toBe(500)
    expect(r.bankedHours).toBe(420)
  })
})

describe('the leniency window', () => {
  // The landlord sets it. Nic: "my two month rule was just an example. If a
  // landlord wants to give leniency for six months, they may choose to do so."
  it('bills a deficit out once it survives more closes than allowed', () => {
    const r = settleMonth({
      periods: [
        period({ periodMonth: '2026-09-01', hoursApplied: 60, agedCloses: 1 }),
        period({ periodMonth: '2026-11-01' }),
      ],
      hoursWorked: 80, bankedHours: 0, carryForwardMonths: 1,
    })
    const sep = r.periods[0]
    expect(sep.status).toBe('billed')
    expect(r.billedAmount).toBe(125)          // the 20 unworked hours, at Sept's rate
    expect(r.billedPeriods).toEqual(['2026-09-01'])
    expect(r.endsAgreement).toBe(true)
  })

  it('a generous landlord keeps the agreement alive', () => {
    const r = settleMonth({
      periods: [
        period({ periodMonth: '2026-09-01', hoursApplied: 60, agedCloses: 1 }),
        period({ periodMonth: '2026-11-01' }),
      ],
      hoursWorked: 80, bankedHours: 0, carryForwardMonths: 6,
    })
    expect(r.periods[0].status).toBe('open')
    expect(r.endsAgreement).toBe(false)
    expect(r.billedAmount).toBe(0)
  })

  it('zero leniency bills at the period’s own close', () => {
    const r = settleMonth({
      periods: [
        period({ periodMonth: '2026-09-01', hoursApplied: 60, agedCloses: 0 }),
        period({ periodMonth: '2026-10-01' }),
      ],
      hoursWorked: 80, bankedHours: 0, carryForwardMonths: 0,
    })
    expect(r.periods[0].status).toBe('billed')
    expect(r.billedAmount).toBe(125)
  })

  // THE ORDERING RULE THIS DESIGN TURNS ON. Hours pay their OWN month first, so
  // an old deficit actually ages. Under oldest-first the old debt would clear
  // every month and the fresh shortfall would never grow old enough to bill —
  // an agreement that can never be caught up would run forever.
  it('ages an old deficit instead of refreshing it', () => {
    // 60 hours a month against an 80-hour target: permanently 20 short.
    let periods: SettlementPeriod[] = [period({ periodMonth: '2026-09-01' })]
    let r = settleMonth({ periods, hoursWorked: 60, bankedHours: 0, carryForwardMonths: 1 })
    expect(r.periods[0].hoursOutstanding).toBe(20)

    periods = [
      period({ periodMonth: '2026-09-01', hoursApplied: 60, agedCloses: 0 }),
      period({ periodMonth: '2026-10-01' }),
    ]
    r = settleMonth({ periods, hoursWorked: 60, bankedHours: 0, carryForwardMonths: 1 })
    // September aged; October is short in its own right. Nothing bills yet.
    expect(r.periods[0].agedCloses).toBe(1)
    expect(r.periods[0].hoursOutstanding).toBe(20)
    expect(r.billedAmount).toBe(0)

    periods = [
      period({ periodMonth: '2026-09-01', hoursApplied: 60, agedCloses: 1 }),
      period({ periodMonth: '2026-10-01', hoursApplied: 60, agedCloses: 0 }),
      period({ periodMonth: '2026-11-01' }),
    ]
    r = settleMonth({ periods, hoursWorked: 60, bankedHours: 0, carryForwardMonths: 1 })
    // September has now outlived the window and is billed. The landlord finds
    // out this arrangement is not working, which is the point.
    expect(r.periods[0].status).toBe('billed')
    expect(r.endsAgreement).toBe(true)
  })
})

describe('a carried hour keeps its own month’s value', () => {
  // Nic's answer, S624: a rent increase must not retroactively reprice labour
  // somebody already failed to do.
  it('prices a caught-up hour at the rate of the month it was owed for', () => {
    const r = settleMonth({
      periods: [
        // September: $500 bill, 80 hours → $6.25/hr. 20 hours still owed.
        period({ periodMonth: '2026-09-01', hoursApplied: 60 }),
        // October: rent rose to $600 → $7.50/hr.
        period({ periodMonth: '2026-10-01', basisAmount: 600, hourRate: hourRateFor(600, 80) }),
      ],
      hoursWorked: 100, bankedHours: 0, carryForwardMonths: 1,
    })
    const [sep, oct] = r.periods
    expect(oct.creditTotal).toBe(600)
    // The 20 catch-up hours bought September at SEPTEMBER's price.
    expect(sep.creditTotal).toBe(500)
    expect(sep.hoursAppliedNow).toBe(20)
  })

  it('bills an aged deficit at its frozen rate, not at today’s rent', () => {
    const r = settleMonth({
      periods: [
        period({ periodMonth: '2026-09-01', hoursApplied: 60, agedCloses: 1 }),
        period({ periodMonth: '2026-11-01', basisAmount: 900, hourRate: hourRateFor(900, 80) }),
      ],
      hoursWorked: 80, bankedHours: 0, carryForwardMonths: 1,
    })
    // 20 hours at September's $6.25 = $125, NOT at November's $11.25 = $225.
    expect(r.billedAmount).toBe(125)
  })
})

describe('the landlord ends the agreement by hand', () => {
  // Nic: "when the landlord marks the work trade agreement as over, any
  // percentage of hours unpaid or uncompleted is billed immediately."
  it('bills every open period at once, whatever the leniency was', () => {
    const r = settleOnEnd([
      period({ periodMonth: '2026-09-01', hoursApplied: 60, agedCloses: 0 }),
      period({ periodMonth: '2026-10-01', hoursApplied: 40, agedCloses: 0 }),
    ], 0)
    expect(r.billedAmount).toBe(125 + 250)   // 20h + 40h, both at $6.25
    expect(r.billedPeriods).toHaveLength(2)
    expect(r.endsAgreement).toBe(true)
  })

  // Banked hours were earned. Refusing to let them cover the debt at the one
  // moment it matters would throw away work somebody actually did.
  it('spends the bank before billing anything', () => {
    const r = settleOnEnd([
      period({ periodMonth: '2026-09-01', hoursApplied: 60 }),
    ], 20)
    expect(r.billedAmount).toBe(0)
    expect(r.periods[0].status).toBe('settled')
  })

  it('spends the bank oldest first, because the rates differ', () => {
    const r = settleOnEnd([
      period({ periodMonth: '2026-09-01', hoursApplied: 60 }),                                  // 20 owed @ $6.25
      period({ periodMonth: '2026-10-01', hoursApplied: 60, basisAmount: 900,
               hourRate: hourRateFor(900, 80) }),                                               // 20 owed @ $11.25
    ], 20)
    // The 20 banked hours clear SEPTEMBER; October's dearer deficit is billed.
    expect(r.periods[0].status).toBe('settled')
    expect(r.periods[1].status).toBe('billed')
    expect(r.billedAmount).toBe(225)
  })

  it('does not pay out leftover banked hours — a trade is not wages', () => {
    const r = settleOnEnd([period({ periodMonth: '2026-09-01', hoursApplied: 80 })], 40)
    expect(r.billedAmount).toBe(0)
    expect(r.bankedHours).toBe(0)
  })
})
