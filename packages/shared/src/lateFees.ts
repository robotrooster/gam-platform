// packages/shared/src/lateFees.ts
// S26b: Pure helpers for the late fee engine.
// All dates are ISO 'YYYY-MM-DD' strings (date-only, no time/tz).
// Monetary values are dollars as numbers (matches payments.amount).
// Half-even rounding to cents on monetary outputs.

export const LATE_FEE_KINDS = ['flat', 'percent_of_rent'] as const;
export type LateFeeKind = (typeof LATE_FEE_KINDS)[number];

export const LATE_FEE_ACCRUAL_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export type LateFeeAccrualPeriod = (typeof LATE_FEE_ACCRUAL_PERIODS)[number];

// --- date primitives (no Date object math; pure string slicing where possible) ---

function parseISODate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

function formatISODate(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function daysInMonth(y: number, m: number): number {
  // m is 1-indexed
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDaysISO(iso: string, days: number): string {
  const { y, m, d } = parseISODate(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatISODate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// half-even cents rounding
function roundHalfEvenCents(amount: number): number {
  const cents = amount * 100;
  const floor = Math.floor(cents);
  const diff = cents - floor;
  if (diff < 0.5) return floor / 100;
  if (diff > 0.5) return (floor + 1) / 100;
  // exactly .5 — round to even
  return (floor % 2 === 0 ? floor : floor + 1) / 100;
}

/**
 * Date the initial late fee should fire (exclusive grace).
 * Late fee fires when CURRENT_DATE >= dueDate + graceDays.
 * Example: dueDate '2026-05-01', graceDays 5 → '2026-05-06'.
 */
export function lateFeeStartDate(dueDate: string, graceDays: number): string {
  return addDaysISO(dueDate, graceDays);
}

/**
 * Compute the Nth accrual boundary after the initial late fee fired.
 * Anchor day = day-of-month of (dueDate + graceDays).
 * occurrenceIndex is 1-based: 1 = first accrual after initial.
 *
 * - daily: anchor + occurrenceIndex days
 * - weekly: anchor + (occurrenceIndex * 7) days
 * - monthly: same day-of-month occurrenceIndex months after anchor,
 *   clamped to last-of-month. (Jan 31 anchor → Feb 28/29, Mar 31, Apr 30, ...)
 */
export function nextAccrualDate(
  dueDate: string,
  graceDays: number,
  period: LateFeeAccrualPeriod,
  occurrenceIndex: number
): string {
  const anchor = lateFeeStartDate(dueDate, graceDays);
  if (period === 'daily') {
    return addDaysISO(anchor, occurrenceIndex);
  }
  if (period === 'weekly') {
    return addDaysISO(anchor, occurrenceIndex * 7);
  }
  // monthly — calendar-exact with last-day clamp on anchor day
  const { y, m, d } = parseISODate(anchor);
  const totalMonths = (m - 1) + occurrenceIndex;
  const targetY = y + Math.floor(totalMonths / 12);
  const targetM = (totalMonths % 12) + 1;
  const targetD = Math.min(d, daysInMonth(targetY, targetM));
  return formatISODate(targetY, targetM, targetD);
}

/**
 * Compute a late fee amount (initial or single accrual tick).
 * Returns dollars, rounded half-even to cents.
 * Percent-of-rent with rentAmount = 0 returns 0.
 */
export function computeLateFeeAmount(
  kind: LateFeeKind,
  amount: number,
  rentAmount: number
): number {
  if (kind === 'flat') {
    return roundHalfEvenCents(amount);
  }
  // percent_of_rent — amount is the percent (e.g. 5 means 5%)
  if (rentAmount <= 0) return 0;
  return roundHalfEvenCents((amount / 100) * rentAmount);
}

/**
 * Dollars remaining under the cap given existing late fees on this invoice.
 * Returns Infinity when no cap configured.
 * Cap is total-inclusive: existing + new must not exceed cap.
 * Percent-of-rent cap with rentAmount = 0 returns 0.
 */
export function capRemaining(
  capKind: LateFeeKind | null,
  capAmount: number | null,
  rentAmount: number,
  existingSum: number
): number {
  if (capKind === null || capAmount === null) return Infinity;
  let capDollars: number;
  if (capKind === 'flat') {
    capDollars = capAmount;
  } else {
    if (rentAmount <= 0) return 0;
    capDollars = roundHalfEvenCents((capAmount / 100) * rentAmount);
  }
  const remaining = capDollars - existingSum;
  return remaining > 0 ? remaining : 0;
}
