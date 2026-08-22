/**
 * S617 (Nic) — "threshold trigger plus four business days. That's the simpler
 * way to do it."
 *
 * The payout scheduler added four CALENDAR days to the day a rent-roll
 * threshold tripped. Stripe releases an ACH debit four BUSINESS days out. In a
 * week containing a weekend those differ, so the payout fired before the money
 * existed, found an empty balance, and the trigger was retired anyway — one of
 * the landlord's three monthly payouts spent on nothing.
 */
import { describe, it, expect } from 'vitest';
import { addBusinessDays, isUsFederalHoliday, usFederalHolidays } from './businessDay';

/** What the scheduler used to do. */
const addCalendarDays = (from: string, n: number): string => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('addBusinessDays', () => {
  it('matches the available_on Stripe actually returned on a live ACH', () => {
    // Real charge: pi_3U6GFiDNEru9AEpK1f6pGlDP, created Wed 2026-08-19,
    // balance transaction available_on Tue 2026-08-25.
    expect(addBusinessDays('2026-08-19', 4)).toBe('2026-08-25');
    // The calendar count landed two days early — this is the bug, pinned.
    expect(addCalendarDays('2026-08-19', 4)).toBe('2026-08-23');
  });

  it('steps over a weekend', () => {
    // Thu -> Fri, Mon, Tue, Wed.
    expect(addBusinessDays('2026-08-20', 4)).toBe('2026-08-26');
  });

  it('steps over a federal holiday as well as the weekend', () => {
    // Rent paid Wed Sep 2. Labor Day is Mon Sep 7, so four business days is
    // Thu 3, Fri 4, Tue 8, Wed 9 — not the 6th, which is a Sunday.
    expect(isUsFederalHoliday('2026-09-07')).toBe(true);
    expect(addBusinessDays('2026-09-02', 4)).toBe('2026-09-09');
    expect(addCalendarDays('2026-09-02', 4)).toBe('2026-09-06');
  });

  it('never lands on a weekend or a holiday, whatever the start day', () => {
    for (let d = 1; d <= 28; d++) {
      const start = `2026-09-${String(d).padStart(2, '0')}`;
      const out = addBusinessDays(start, 4);
      const dow = new Date(`${out}T00:00:00Z`).getUTCDay();
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
      expect(isUsFederalHoliday(out)).toBe(false);
      expect(out > start).toBe(true);
    }
  });

  it('crosses a year boundary using both years’ holidays', () => {
    // Wed Dec 30 2026 -> Thu 31, (Fri Jan 1 = New Year, skip), Mon 4, Tue 5, Wed 6.
    expect(isUsFederalHoliday('2027-01-01')).toBe(true);
    expect(addBusinessDays('2026-12-30', 4)).toBe('2027-01-06');
  });

  it('a zero step stays put', () => {
    expect(addBusinessDays('2026-08-19', 0)).toBe('2026-08-19');
  });

  it('computes the same holidays the hand-written list used to name', () => {
    // The set this replaced in autoPayouts, verified before the swap.
    expect(usFederalHolidays(2026)).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
      '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26',
      '2026-12-25',
    ]);
    expect(usFederalHolidays(2027)).toEqual([
      '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18',
      '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25',
      '2027-12-24',
    ]);
  });

  it('keeps working in a year the hand-written list never covered', () => {
    // The old list stopped at 2027 and said "refresh annually". This is the
    // whole reason it is computed now.
    expect(isUsFederalHoliday('2031-07-04')).toBe(true);   // Friday
    expect(addBusinessDays('2031-07-03', 1)).toBe('2031-07-07');
  });
});
