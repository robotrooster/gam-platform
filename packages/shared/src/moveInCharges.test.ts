import { describe, it, expect } from 'vitest'
import { moveInDefaults, prorateMoveInRent, moveInTotalDue, moveInDepositMirror,
  leaseDueDay, parseDueDay, dueDayLabel, nextDueDateAfter, renewalSchedule, dayBefore,
  renewalBillingSummary } from './moveInCharges'

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
    expect(parseDueDay('0')).toBeNull()
    expect(parseDueDay('45th')).toBeNull()
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

/**
 * 10/18 (Nic): "the only way it is different is for longer term people for rent
 * pro ration. MOVING IN OR OUT at the middle of a month and also only if the
 * landlord allows the pro rate. these should all be property level settings."
 *
 * The move-IN half (properties.prorates_mid_month_rent). Answering No on the
 * property card used to change nothing at all for a move-in, while the card's
 * own words promised "a whole month is a whole month, moving in and moving out
 * alike" (10/19 review).
 */
describe("a park where a whole month is a whole month bills the month they moved into", () => {
  it('No: the whole month, on the same line the proration was on', () => {
    // Rent $1,000 due the 1st, moving in October 15. A park that prorates
    // bills $548.39 for Oct 15–31; a park that does not bills all of October.
    expect(moveInDefaults({ rent: 1000, startIso: '2026-10-15', existingTenancy: false,
      collectsNextPeriod: false })).toEqual({ firstMonthRent: 0, proration: 548.39 })
    expect(moveInDefaults({ rent: 1000, startIso: '2026-10-15', existingTenancy: false,
      collectsNextPeriod: false, proratesMidMonth: false })).toEqual({ firstMonthRent: 0, proration: 1000 })
  })

  it('No, where the property also collects the next month up front: two whole months', () => {
    expect(moveInDefaults({ rent: 1000, startIso: '2026-10-15', existingTenancy: false,
      collectsNextPeriod: true, proratesMidMonth: false })).toEqual({ firstMonthRent: 1000, proration: 1000 })
  })

  it('left out, or Yes, is the proration every property has always had', () => {
    const prorated = { firstMonthRent: 0, proration: 548.39 }
    expect(moveInDefaults({ rent: 1000, startIso: '2026-10-15', existingTenancy: false,
      collectsNextPeriod: false, proratesMidMonth: true })).toEqual(prorated)
    expect(moveInDefaults({ rent: 1000, startIso: '2026-10-15', existingTenancy: false,
      collectsNextPeriod: false })).toEqual(prorated)
  })

  it('the answer changes nothing where there was never a part month to cut', () => {
    for (const proratesMidMonth of [true, false]) {
      // Moving in ON the due day: the first full period starts that day.
      expect(moveInDefaults({ rent: 1000, startIso: '2026-10-01', existingTenancy: false,
        collectsNextPeriod: false, proratesMidMonth }), `on the due day, ${proratesMidMonth}`)
        .toEqual({ firstMonthRent: 1000, proration: 0 })
      // Anniversary billing.
      expect(moveInDefaults({ rent: 1000, startIso: '2026-10-15', existingTenancy: false,
        collectsNextPeriod: false, dueDay: 15, mode: 'move_in_day', proratesMidMonth }))
        .toEqual({ firstMonthRent: 1000, proration: 0 })
      // An onboarding resident: their move-in charges were paid years ago and
      // page 8 is locked to the month's rent either way.
      expect(moveInDefaults({ rent: 1000, startIso: '2026-10-15', existingTenancy: true,
        collectsNextPeriod: true, proratesMidMonth })).toEqual({ firstMonthRent: 1000, proration: 0 })
    }
  })

  it('page 8 adds up to the same total it shows, either answer', () => {
    const whole = moveInDefaults({ rent: 1000, startIso: '2026-10-15', existingTenancy: false,
      collectsNextPeriod: false, proratesMidMonth: false })
    expect(moveInTotalDue({ firstMonthRent: whole.firstMonthRent, proration: whole.proration,
      depositMirror: 500, moveInFees: ['250.00'] })).toBe(1750)
  })
})

describe('a typed 29th, 30th or 31st is due on the 1st (Nic: "we don\'t want any skips")', () => {
  it('reads the 29th through the 31st as the 1st', () => {
    expect(parseDueDay('29th')).toBe(1)
    expect(parseDueDay('the 30th')).toBe(1)
    expect(parseDueDay('31st')).toBe(1)
    expect(parseDueDay('28th')).toBe(28)
  })
})

describe('a renewal continues the schedule — one tenancy, one billing schedule', () => {
  // $1,000 now, $1,050 on the new lease, due the 1st unless stated.
  const r = (oldEnd: string | null, oldDueDay: number, newStart: string, newDueDay: number, rent = 1050) =>
    renewalSchedule({ oldEnd, oldDueDay, newStart, newDueDay, rent })

  it('old lease ends 6/14, new starts 6/15: nothing on 6/15, the new rent starts 7/1', () => {
    expect(r('2026-06-14', 1, '2026-06-15', 1)).toEqual({
      paidThrough: '2026-07-01', firstBill: '2026-07-01', bridge: null, firstFullDue: '2026-07-01', dueDayChanged: false })
  })
  it('old lease ends 6/30, new starts 7/1: the new rent on 7/1', () => {
    expect(r('2026-06-30', 1, '2026-07-01', 1).firstBill).toBe('2026-07-01')
    expect(r('2026-06-30', 1, '2026-07-01', 1).bridge).toBeNull()
  })
  it('old lease ends ON a due date (10/1): it bills 10/1, the new lease starts with 11/1', () => {
    expect(r('2026-10-01', 1, '2026-10-02', 1)).toEqual({
      paidThrough: '2026-11-01', firstBill: '2026-11-01', bridge: null, firstFullDue: '2026-11-01', dueDayChanged: false })
  })
  it('due on the move-in day (the 15th), new lease 6/20: the 6/15 bill covers to 7/15', () => {
    expect(r('2026-06-19', 15, '2026-06-20', 15)).toEqual({
      paidThrough: '2026-07-15', firstBill: '2026-07-15', bridge: null, firstFullDue: '2026-07-15', dueDayChanged: false })
  })
  it('due day changed on the new form from the 1st to the 15th: a $490 bridge on 7/1, then $1,050 on 7/15', () => {
    expect(r('2026-06-30', 1, '2026-07-01', 15)).toEqual({
      paidThrough: '2026-07-01', firstBill: '2026-07-01', bridge: 490, firstFullDue: '2026-07-15', dueDayChanged: true })
  })
  it('month-to-month with no end written, new lease 1/1: old bills 12/1, new bills 1/1', () => {
    expect(r(null, 1, '2027-01-01', 1)).toEqual({
      paidThrough: '2027-01-01', firstBill: '2027-01-01', bridge: null, firstFullDue: '2027-01-01', dueDayChanged: false })
  })
  it('a renewal that starts before the old paper end stops the old lease the day before', () => {
    // Old lease printed to 6/30; the new one starts 6/15. Old bills 6/1 only.
    expect(r('2026-06-30', 1, '2026-06-15', 1).firstBill).toBe('2026-07-01')
  })
  it('a gap between the leases: the new lease starts on its own start date, prorated to the due day', () => {
    // Old ended 5/31 (paid through 6/1); new starts 6/10 → 6/10 to 7/1 at $1,050 = 21/30.
    const s = r('2026-05-31', 1, '2026-06-10', 1)
    expect(s.firstBill).toBe('2026-06-10')
    expect(s.bridge).toBe(735)
    expect(s.firstFullDue).toBe('2026-07-01')
  })
  it('counts the day before across a year', () => {
    expect(dayBefore('2027-01-01')).toBe('2026-12-31')
    expect(dayBefore('2028-03-01')).toBe('2028-02-29')
  })
})

describe('the signing pages say what the renewal\'s first bill will be', () => {
  it('on schedule: the first rent bill and its amount', () => {
    const s = renewalSchedule({ oldEnd: '2026-06-14', oldDueDay: 1, newStart: '2026-06-15', newDueDay: 1, rent: 1050 })
    expect(renewalBillingSummary(s, 1050, 1)).toBe(
      'Rent stays on its schedule, due on the 1st. The first rent bill under this lease is July 1, 2026: $1,050.00.')
  })
  it('a due day changed on the form: the bridge, then the full rent', () => {
    const s = renewalSchedule({ oldEnd: '2026-06-30', oldDueDay: 1, newStart: '2026-07-01', newDueDay: 15, rent: 1050 })
    expect(renewalBillingSummary(s, 1050, 15)).toBe(
      'Rent moves to the 15th. The first bill under this lease is July 1, 2026: $490.00 for July 1, 2026 to '
      + 'July 14, 2026, then $1,050.00 on July 15, 2026 and every 15th after.')
  })
  it('a gap between the leases with the due day unchanged: the bridge, and no word of the day moving', () => {
    // Old lease ended 5/31; the new one starts 6/10, still due the 1st.
    const s = renewalSchedule({ oldEnd: '2026-05-31', oldDueDay: 1, newStart: '2026-06-10', newDueDay: 1, rent: 1050 })
    expect(s.dueDayChanged).toBe(false)
    expect(renewalBillingSummary(s, 1050, 1)).toBe(
      'The first bill under this lease is June 10, 2026: $735.00 for June 10, 2026 to June 30, 2026, '
      + 'then $1,050.00 on July 1, 2026 and every 1st after.')
  })
})
