/**
 * 10/12 (Nic) — one lateness boundary for the late fees and every screen:
 *
 *   "First LATE day = due/lateness-start + grace days (rent due the 1st, 5-day
 *    grace → the 6th is late, the day late fees start)."
 *
 * The late-fee engine (jobs/lateFees, through @gam/shared lateFeeStartDate)
 * and the lateness rule (services/lateness firstLateDay) must name the same
 * day — grace 0 included: 10/12 (Nic) "zero grace: the NEXT day is late
 * (paying on the due date is on time)", so both take GREATEST(grace, 1) and
 * the first late day with no grace is the day after the due date.
 *
 * The credit history reads the same day: one mark per bill (10/12, Nic: "the
 * payment history should be a health percentage. one mark per invoice."),
 * judged by the payment-health rule on this boundary (services/creditBillMarks).
 *
 * And work trade: a line work trade held is written — so late — from the day
 * it was released, never from before its due date (writtenAtSql).
 */
import { describe, it, expect } from 'vitest'
import { lateFeeStartDate } from '@gam/shared'
import { firstLateDay, lastGraceDay, WORK_TRADE_HELD_NOTE_PARTS, writtenAtSql } from './lateness'
import { WT_SUSPENDED_NOTE } from './workTradeCoverage'

describe('the late fee starts on the first late day', () => {
  for (const grace of [1, 3, 5, 10]) {
    it(`grace ${grace}: the late fee's first day is the first late day`, () => {
      expect(lateFeeStartDate('2026-10-01', grace)).toBe(firstLateDay('2026-10-01', grace))
      expect(lateFeeStartDate('2026-12-29', grace)).toBe(firstLateDay('2026-12-29', grace))
    })
  }
  it('rent due the 1st with 5 days: the 6th is late, the 5th the last grace day', () => {
    expect(firstLateDay('2026-10-01', 5)).toBe('2026-10-06')
    expect(lastGraceDay('2026-10-01', 5)).toBe('2026-10-05')
  })
})

describe('a line work trade held counts from its release', () => {
  it('every note a held line is written with is one the rule recognizes', () => {
    expect(WORK_TRADE_HELD_NOTE_PARTS.some(n => WT_SUSPENDED_NOTE.includes(n))).toBe(true)
    // jobs/serviceAgreementInvoices, jobs/moveInBundle, services/utilityBilling
    expect(WORK_TRADE_HELD_NOTE_PARTS.some(n => 'Electric — work trade, suspended until month close'.includes(n))).toBe(true)
    // services/workTradeCoverage PUT_BACK_NOTE
    expect(WORK_TRADE_HELD_NOTE_PARTS.some(n => 'No longer covered by the work trade — owed'.includes(n))).toBe(true)
  })
  it('reads the release from the change journal, only for a line that is no longer held', () => {
    const sql = writtenAtSql('p')
    expect(sql).toContain('audit_row_changes')
    expect(sql).toContain('p.work_trade_suspended_at IS NULL')
  })
})
