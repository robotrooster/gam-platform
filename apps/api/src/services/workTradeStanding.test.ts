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

// S643 (Nic, DIRECTIVE): "Leave the hours for tracking. Don't show the tenant
// any sort of hourly rate — that's when they decide it's not worth it. They're
// bad at calculation, some people think they're getting three dollars an hour in
// rent but they forget all the conveniences they get along the way."
//
// A dollar figure printed beside an hour count IS an hourly rate: $125 next to
// 20 hours is one division away from $6.25/hr. So the tenant's copy carries the
// hours and no money at all.
describe('what the tenant is allowed to see', () => {
  const twenty = () => ({
    currentMonth: '2026-11-01', currentMonthTarget: 80, currentMonthApplied: 0,
    carried: [carried({ periodMonth: '2026-10-01', hoursOutstanding: 20, hourRate: 6.25 })],
    bankedHours: 0,
  })

  it('never prices a tenant\'s carried hours', () => {
    const t = workTradeStanding({ ...twenty(), audience: 'tenant' })
    expect(t.carriedValue).toBeNull()
    expect(t.summary).not.toMatch(/\$/)
    // The hours themselves are the whole point of the agreement — they stay.
    expect(t.summary).toContain('20 hours')
    expect(t.currentMonthHours).toBe(80)
    expect(t.carriedHours).toBe(20)
    expect(t.catchUpHours).toBe(100)
  })

  it('still prices them for the landlord', () => {
    const l = workTradeStanding({ ...twenty(), audience: 'landlord' })
    expect(l.carriedValue).toBe(125)
    expect(l.summary).toContain('$125.00')
  })

  it('defaults to the landlord view when nobody says', () => {
    expect(workTradeStanding(twenty()).carriedValue).toBe(125)
  })

  it('gives both audiences the same hours', () => {
    const t = workTradeStanding({ ...twenty(), audience: 'tenant' })
    const l = workTradeStanding({ ...twenty(), audience: 'landlord' })
    expect(t.catchUpHours).toBe(l.catchUpHours)
    expect(t.carriedHours).toBe(l.carriedHours)
    expect(t.nextBillingMonth).toBe(l.nextBillingMonth)
  })

  it('says nothing about money to a tenant who is straight', () => {
    const t = workTradeStanding({
      currentMonth: '2026-11-01', currentMonthTarget: 80, currentMonthApplied: 80,
      carried: [], bankedHours: 10, audience: 'tenant',
    })
    expect(t.summary).not.toMatch(/\$/)
    expect(t.carriedValue).toBeNull()
  })
})

// 10/19 (Nic): "if people take their camper home for the summer with them and
// it's not occupying the spot, then there would be no reason for it to continue
// to track hours." The figures all go to zero when that happens, which is
// correct and also completely silent about why — so the sentence has to carry it.
describe('when no hours are being counted because the space is empty', () => {
  const dormant = (audience?: 'tenant' | 'landlord') => workTradeStanding({
    currentMonth: '2026-07-01', currentMonthTarget: 0, currentMonthApplied: 0,
    carried: [], bankedHours: 0, hoursNotCounted: true, audience,
  })

  it('says hours have stopped, and why, instead of "fully covered"', () => {
    const s = dormant('tenant')
    expect(s.hoursNotCounted).toBe(true)
    expect(s.summary).toContain('paused and the space is empty')
    expect(s.summary).toContain('no hours are being counted')
    // The standing rule: work-trade coverage is never turned into a debt — the
    // months already billed under the trade settle rather than being owed.
    expect(s.summary).toContain('covered at the next month close')
    // 10/19 (review): and NOT a promise about a bill dated during the pause.
    // The billing run only covers a running agreement
    // (services/workTradeCredit loadWorkTradeCreditContext), so a month billed
    // while this is paused goes out in full — the earlier wording ("the charges
    // it covers are not billed while it is paused") promised the opposite, to a
    // tenant who was about to get that bill.
    expect(s.summary).toContain('not covered by the trade')
    expect(s.summary).not.toContain('not billed while it is paused')
    // A tenant away for the season must not read a clean "you're fully covered"
    // they cannot tell apart from a month they actually worked.
    expect(s.summary).not.toContain('fully covered')
  })

  it('tells the landlord the same sentence, with no price on a trade hour', () => {
    expect(dormant('landlord').summary).toBe(dormant('tenant').summary)
    expect(dormant('landlord').summary).not.toMatch(/\$/)
  })

  it('leaves a trade that IS counting hours saying exactly what it said before', () => {
    const s = workTradeStanding({
      currentMonth: '2026-10-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [carried()], bankedHours: 0,
    })
    expect(s.hoursNotCounted).toBe(false)
    expect(s.summary).toContain('80 hours covers this month')
    expect(s.summary).toContain('20 hours is still owed from earlier')
  })
})

// 10/19 (Nic) — "SHOW IT WHILE PAUSED."
//
// Asked whether a tenant should see their work trade while it is paused, Nic
// chose to show it: the tab stays up and says plainly which situation they are
// in. The figures for a paused trade that is STILL COUNTING are word-for-word a
// running agreement's, so without a sentence saying it is paused a snowbird
// reads a target they think nobody is holding them to — and then gets a bill on
// that month's own invoice, which is exactly what the close does
// (jobs/workTradeSettlement, CLOSE_STATUSES).
describe('a paused work trade says which situation it is', () => {
  const paused = (o: Record<string, any> = {}) =>
    workTradeStanding({
      currentMonth: '2026-07-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [], bankedHours: 0, paused: true, ...o,
    })

  it('still counting, space in use: says the hours keep counting, and still states them', () => {
    const s = paused({ spaceOccupied: true })
    expect(s.paused).toBe(true)
    expect(s.hoursCounted).toBe(true)
    expect(s.summary).toContain('paused, but the space is still being used')
    expect(s.summary).toContain('your hours keep counting')
    // The hours themselves are unchanged — the pause did not waive them.
    expect(s.currentMonthHours).toBe(80)
    expect(s.summary).toContain('80 hours covers this month')
  })

  it('still counting, nobody asked yet: says hours keep counting until the landlord answers', () => {
    const s = paused()
    expect(s.hoursCounted).toBe(true)
    expect(s.summary).toContain('your hours keep counting')
    expect(s.summary).toContain('says whether the space is still being used')
    // Never a claim about the space that nobody has made.
    expect(s.summary).not.toContain('the space is empty')
    expect(s.summary).not.toContain('still being used, so')
  })

  it('still counting with nothing owed: the pause is said even when they are straight', () => {
    const s = paused({ currentMonthApplied: 80, spaceOccupied: true })
    expect(s.summary).toContain('your hours keep counting')
    expect(s.summary).toContain("You're fully covered for this month.")
  })

  it('space empty: the other sentence, and no target', () => {
    const s = paused({ currentMonthTarget: 0, hoursNotCounted: true, spaceOccupied: false })
    expect(s.hoursCounted).toBe(false)
    expect(s.summary).toContain('no hours are being counted')
    expect(s.summary).toContain('covered at the next month close')
    expect(s.summary).toContain('not covered by the trade')
    expect(s.summary).not.toContain('keep counting')
  })

  it('a trade nobody clocks at all gets its own reason, not a claim about the space', () => {
    const s = paused({ currentMonthTarget: 0, hoursCounted: false })
    expect(s.hoursCounted).toBe(false)
    expect(s.summary).toContain('no hours are counted on it either way')
    expect(s.summary).toContain('covered at the next month close')
    expect(s.summary).toContain('not covered by the trade')
    // The space sentence would be a statement nobody made about an agreement
    // that never counted an hour either way.
    expect(s.summary).not.toContain('the space is empty')
    expect(s.summary).not.toContain('fully covered')
  })

  it('both audiences read the same paused sentence, and no price lands on a trade hour', () => {
    const t = paused({ spaceOccupied: true, audience: 'tenant' })
    const l = paused({ spaceOccupied: true, audience: 'landlord' })
    expect(l.summary.startsWith('This work trade is paused, but the space is still being used')).toBe(true)
    expect(t.summary.startsWith('This work trade is paused, but the space is still being used')).toBe(true)
    expect(t.summary).not.toMatch(/\$/)
  })

  // 10/19 (review) — THE MONTH THE BILLING RUN SKIPPED.
  //
  // Invoice generation asks for an ACTIVE agreement
  // (services/workTradeCredit loadWorkTradeCreditContext), so while a trade is
  // paused the new month opens no settlement period: nothing is suspended, the
  // bill goes out at its full amount and late-fee eligible, and no hour worked
  // that month can credit it. Every figure in the standing then reads zero for
  // want of a period — which used to come out as "You're fully covered for this
  // month" to somebody holding a full invoice. That state is reachable on the
  // first click of the landlord's new Pause button, with the lease left running.
  describe('a month billed while the trade was paused', () => {
    const noPeriod = (o: Record<string, any> = {}) => workTradeStanding({
      currentMonth: '2026-11-01', currentMonthTarget: 0, currentMonthApplied: 0,
      carried: [], bankedHours: 0, paused: true, currentMonthOpen: false, ...o,
    })

    it('never says "fully covered" about a bill the trade did not cover', () => {
      const s = noPeriod({ spaceOccupied: true })
      expect(s.summary).not.toContain('fully covered')
      expect(s.summary).toContain('not covered by the trade')
    })

    it('says it even when hours were banked ahead', () => {
      const s = noPeriod({ spaceOccupied: true, bankedHours: 12 })
      expect(s.summary).not.toContain('worked ahead')
      expect(s.summary).toContain('not covered by the trade')
    })

    it('states what is still owed from the months that DID have periods', () => {
      const s = noPeriod({ spaceOccupied: true, carried: [carried()] })
      expect(s.summary).toContain('not covered by the trade')
      expect(s.summary).toContain('20 hours is still owed from earlier')
      // No phantom "0 hours covers this month" for a month nobody opened.
      expect(s.summary).not.toContain('covers this month')
    })

    it('claims nothing about months already billed when there are none', () => {
      const s = noPeriod({ hoursNotCounted: true, spaceOccupied: false })
      expect(s.summary).not.toContain('already billed')
      expect(s.summary).toContain('not covered by the trade')
    })

    it('leaves a RUNNING agreement alone — this is a pause rule', () => {
      const s = workTradeStanding({
        currentMonth: '2026-11-01', currentMonthTarget: 0, currentMonthApplied: 0,
        carried: [], bankedHours: 0, currentMonthOpen: false,
      })
      expect(s.summary).toContain('fully covered')
      expect(s.summary).not.toContain('not covered by the trade')
    })
  })

  it('a running agreement says nothing about a pause', () => {
    const s = workTradeStanding({
      currentMonth: '2026-10-01', currentMonthTarget: 80, currentMonthApplied: 0,
      carried: [carried()], bankedHours: 0,
    })
    expect(s.paused).toBe(false)
    expect(s.hoursCounted).toBe(true)
    expect(s.summary).not.toContain('paused')
    expect(s.summary.startsWith('80 hours covers this month')).toBe(true)
  })
})
