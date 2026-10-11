/**
 * 10/6 (Nic): the hour a tenant reports, and the date and time a bank writes
 * on its own line — read when it is there, never guessed when it is not.
 */
import { describe, it, expect } from 'vitest'
import {
  bankLineDateTime, depositHourLabel, reportedTimeText, reportedTimeGapMinutes, minutesLabel,
  isDepositHourChoice, DEPOSIT_HOURS, reportConflictText, reportedTimeFits,
} from './bankDepositTime'

describe('the time on a bank line', () => {
  it('reads Mountain View’s branch line to the minute, and its own date', () => {
    const w = bankLineDateTime('eDeposit in Branch 09/30/26 04:39:28 PM 360 W CONTINENTAL RD GREEN VALLEY AZ', '2026-10-01')
    expect(w).toEqual({ date: '2026-09-30', minutes: 16 * 60 + 39 })
    expect(minutesLabel(w.minutes!)).toBe('4:39 PM')
  })

  it('reads the common forms', () => {
    expect(bankLineDateTime('DEPOSIT 10/01/2026 2:32PM', '2026-10-01')).toEqual({ date: '2026-10-01', minutes: 14 * 60 + 32 })
    expect(bankLineDateTime('BRANCH DEP 10-01 14:32', '2026-10-02')).toEqual({ date: '2026-10-01', minutes: 14 * 60 + 32 })
    expect(bankLineDateTime('TELLER DEPOSIT 9:05 A.M.', '2026-10-01')).toEqual({ date: null, minutes: 9 * 60 + 5 })
    expect(bankLineDateTime('ATM DEPOSIT 12:15 AM', '2026-10-01').minutes).toBe(15)
    expect(bankLineDateTime('ATM DEPOSIT 12:15 PM', '2026-10-01').minutes).toBe(12 * 60 + 15)
  })

  it('no time on the line is no time — never a reference number read as one', () => {
    expect(bankLineDateTime('DEPOSIT *4662', '2026-10-01')).toEqual({ date: null, minutes: null })
    expect(bankLineDateTime('MOBILE DEPOSIT REF NUMBER 1639', '2026-10-01')).toEqual({ date: null, minutes: null })
    expect(bankLineDateTime(null, '2026-10-01')).toEqual({ date: null, minutes: null })
    expect(bankLineDateTime('DEPOSIT 25:61', '2026-10-01').minutes).toBeNull()
  })

  it('10/6 review: a time with no AM/PM that a 12-hour clock could write is no time', () => {
    expect(bankLineDateTime('DEPOSIT 4:39 BRANCH', '2026-10-01').minutes).toBeNull()
    expect(bankLineDateTime('DEPOSIT 12:30 BRANCH', '2026-10-01').minutes).toBeNull()
    // "PMT" is not "PM": no marker, so no time.
    expect(bankLineDateTime('DEPOSIT 4:39 PMT 4662', '2026-10-01').minutes).toBeNull()
    // Unambiguous 24-hour stamps still read.
    expect(bankLineDateTime('DEPOSIT 16:39', '2026-10-01').minutes).toBe(16 * 60 + 39)
    expect(bankLineDateTime('DEPOSIT 00:15', '2026-10-01').minutes).toBe(15)
    expect(bankLineDateTime('DEPOSIT 04:39:28 BRANCH', '2026-10-01').minutes).toBe(4 * 60 + 39)
  })

  it('a date that cannot be this deposit’s day is ignored', () => {
    // After the posting by more than a day, or long before it.
    expect(bankLineDateTime('DEPOSIT 10/09/26', '2026-10-01').date).toBeNull()
    expect(bankLineDateTime('DEPOSIT 08/01/26', '2026-10-01').date).toBeNull()
    expect(bankLineDateTime('DEPOSIT 02/30/26', '2026-03-01').date).toBeNull()
    // A December deposit posted in January, with no year on the line.
    expect(bankLineDateTime('BRANCH DEP 12/31 3:00 PM', '2027-01-02').date).toBe('2026-12-31')
  })
})

describe('the hour the tenant picks', () => {
  it('8 AM through 6 PM by the hour, and after hours / ATM', () => {
    expect(DEPOSIT_HOURS.map(depositHourLabel)).toEqual(
      ['8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM'])
    expect(isDepositHourChoice(15)).toBe(true)
    expect(isDepositHourChoice('after_hours')).toBe(true)
    expect(isDepositHourChoice(7)).toBe(false)
    expect(isDepositHourChoice(19)).toBe(false)
    expect(isDepositHourChoice(null)).toBe(false)
  })

  it('said plainly on either side', () => {
    expect(reportedTimeText({ hour: 15 })).toBe('about 3 PM')
    expect(reportedTimeText({ afterHours: true })).toBe('after hours or at an ATM')
    expect(reportedTimeText({ hour: null })).toBeNull()
  })

  it('how far the bank’s time is from the hour picked', () => {
    // 10/6 review: the pick is the whole hour — 3 PM fits 3:00 through 3:59.
    expect(reportedTimeGapMinutes({ hour: 15 }, 15 * 60 + 10)).toBe(0)
    expect(reportedTimeGapMinutes({ hour: 15 }, 15 * 60 + 45)).toBe(0)
    expect(reportedTimeGapMinutes({ hour: 16 }, 15 * 60 + 45)).toBe(15)
    expect(reportedTimeGapMinutes({ hour: 15 }, 16 * 60 + 9)).toBe(10)
    expect(reportedTimeGapMinutes({ hour: 15 }, 14 * 60 + 40)).toBe(20)
    expect(reportedTimeGapMinutes({ afterHours: true }, 21 * 60)).toBe(0)
    expect(reportedTimeGapMinutes({ afterHours: true }, 7 * 60)).toBe(0)
    expect(reportedTimeGapMinutes({ afterHours: true }, 12 * 60)).toBe(270)
    expect(reportedTimeGapMinutes({ hour: 15 }, null)).toBeNull()
    expect(reportedTimeGapMinutes({ hour: null }, 600)).toBeNull()
  })
})

describe('the landlord’s conflict card', () => {
  it('says why GAM did not pick, in plain words', () => {
    const reports = [{ amount: 450, declaredDate: '2026-10-02' }, { amount: 450, declaredDate: '2026-10-02' }]
    expect(reportConflictText({ kind: 'no_difference', reports, deposits: [] }))
      .toMatch(/^Two residents reported \$450\.00 on Oct 2 — pick which deposit is whose\./)
    expect(reportConflictText({ kind: 'fewer_deposits', reports, deposits: [{ amount: 450, postedDate: '2026-10-02' }] }))
      .toContain('Only one $450.00 deposit has shown up at the bank so far')
  })

  it('one resident is worded as one resident, never "One residents"', () => {
    expect(reportConflictText({
      kind: 'who_is_late', reports: [{ amount: 450, declaredDate: '2026-10-07', tenantId: 't1' }],
      deposits: [{ amount: 450, postedDate: '2026-10-05' }, { amount: 450, postedDate: '2026-10-09' }],
    })).toBe('A resident reported $450.00 on Oct 7, and two $450.00 deposits could be theirs — '
      + 'the one you pick decides whether it counts on time.')
    // Two reports from one household: one resident.
    expect(reportConflictText({
      kind: 'no_difference',
      reports: [{ amount: 450, declaredDate: '2026-10-02', tenantId: 't1' }, { amount: 450, declaredDate: '2026-10-02', tenantId: 't1' }],
      deposits: [{ amount: 450, postedDate: '2026-10-02' }, { amount: 450, postedDate: '2026-10-02' }],
    })).not.toMatch(/residents/)
  })

  it('a combined deposit says the step that works', () => {
    expect(reportConflictText({
      kind: 'combined',
      reports: [{ amount: 450, declaredDate: '2026-10-02', tenantId: 't1' }, { amount: 300, declaredDate: '2026-10-02', tenantId: 't2' }],
      deposits: [{ amount: 750, postedDate: '2026-10-02' }],
    })).toBe('This $750.00 deposit equals what two residents reported together ($450.00 and $300.00, on Oct 2). '
      + 'GAM can\'t split one deposit between residents — record each resident\'s part from the payments screen.')
  })
})

describe('does the bank’s time fit the hour picked', () => {
  it('within an hour of the picked hour fits; further off does not; no time never fits', () => {
    expect(reportedTimeFits(0)).toBe(true)
    expect(reportedTimeFits(60)).toBe(true)
    expect(reportedTimeFits(61)).toBe(false)
    expect(reportedTimeFits(null)).toBe(false)
  })
})
