/**
 * S616 — "does the autopay scheduler read the grace period and tell them
 * correctly whether or not they will be charged late fees or not?" (Nic)
 *
 * The answer was no twice. First the card called ANY day after the due day
 * late, so a Social Security payer choosing the 3rd with a five-day grace was
 * warned about fees they would never owe. Then, after that fix, it still said
 * nothing at all for a day EARLIER in the month than the due day — which rolls
 * to the NEXT month and is the worst case of the lot.
 */
import { describe, it, expect } from 'vitest';
import { autopayPayDate, autopayLateness } from './autopaySchedule';

describe('autopayPayDate', () => {
  it('a later day is the same month', () => {
    expect(autopayPayDate('2026-09-01', 9)).toBe('2026-09-09');
  });
  it('the due day itself is the due date', () => {
    expect(autopayPayDate('2026-09-05', 5)).toBe('2026-09-05');
  });
  it('an earlier day rolls to next month — it cannot mean "before it is owed"', () => {
    expect(autopayPayDate('2026-09-05', 1)).toBe('2026-10-01');
  });
  it('rolls the year at December', () => {
    expect(autopayPayDate('2026-12-05', 1)).toBe('2027-01-01');
  });
  it('null means the due date itself', () => {
    expect(autopayPayDate('2026-09-01', null)).toBe('2026-09-01');
  });
});

describe('autopayLateness', () => {
  // Nic's actual case: rent due the 1st, Social Security lands on the 3rd.
  it('the 3rd with a five-day grace costs nothing', () => {
    const r = autopayLateness('2026-09-01', 3, 5);
    expect(r.daysAfterDue).toBe(2);
    expect(r.isLate).toBe(false);
  });

  // The engine charges when the date is ON OR AFTER due + grace, so the 5th is
  // the last free day and the 6th is not.
  it('the last free day is free and the next one is not', () => {
    expect(autopayLateness('2026-09-01', 5, 5).isLate).toBe(false);
    expect(autopayLateness('2026-09-01', 6, 5).isLate).toBe(true);
  });

  // THE ONE THE FIRST FIX MISSED. `pullDay > dueDay` is false here, so the card
  // showed no warning whatsoever — while the charge ran nearly a month late,
  // every cycle.
  it('a day before the due day is very late, not early', () => {
    const r = autopayLateness('2026-09-05', 1, 5);
    expect(r.payDate).toBe('2026-10-01');
    expect(r.daysAfterDue).toBe(26);
    expect(r.isLate).toBe(true);
  });

  it('never reports paying early — the roll-forward means there is no such thing', () => {
    expect(autopayLateness('2026-09-15', 2, 5).daysAfterDue).toBeGreaterThan(0);
  });

  // Mirrors the engine rather than what feels fair. Its gate is
  // `today >= due_date + grace`, so a grace of ZERO makes the DUE DATE ITSELF
  // late. Whether a landlord should be able to set that is a product question;
  // what must not happen is this screen calling a day safe that the charge then
  // penalises, so it agrees with the engine and says so.
  it('a zero-day grace makes the due date itself late', () => {
    expect(autopayLateness('2026-09-01', 1, 0).isLate).toBe(true);
    expect(autopayLateness('2026-09-01', 5, 5).isLate).toBe(false);
  });

  it('no late fees on the lease means no day is unsafe', () => {
    expect(autopayLateness('2026-09-05', 1, 5, false).isLate).toBe(false);
  });

  it('reports the first date a fee applies', () => {
    expect(autopayLateness('2026-09-01', 3, 5).lateFrom).toBe('2026-09-06');
  });
});
