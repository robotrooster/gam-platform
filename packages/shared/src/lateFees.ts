// packages/shared/src/lateFees.ts
// S26b: Pure helpers for the late fee engine.
// All dates are ISO 'YYYY-MM-DD' strings (date-only, no time/tz).
// Monetary values are dollars as numbers (matches payments.amount).
// Half-even rounding to cents on monetary outputs.

export const LATE_FEE_KINDS = ['flat', 'percent_of_rent'] as const;
export type LateFeeKind = (typeof LATE_FEE_KINDS)[number];

export const LATE_FEE_ACCRUAL_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export type LateFeeAccrualPeriod = (typeof LATE_FEE_ACCRUAL_PERIODS)[number];

// S577: where the daily/period accrual starts COUNTING once grace is crossed.
// Grace always gates WHETHER a fee applies (today >= due + grace); this only
// moves the counting anchor. Landlord-configurable, neutral copy (some locales
// allow retroactive fees, some don't — "check your local laws"); never labeled
// by state.
//   - grace_end        : accrual starts after the grace period (least aggressive)
//   - due_date         : retroactive — one tick per day AFTER the due date
//   - due_date_inclusive: retroactive — counting includes the due date itself
export const LATE_FEE_ACCRUAL_FROMS = ['grace_end', 'due_date', 'due_date_inclusive'] as const;
export type LateFeeAccrualFrom = (typeof LATE_FEE_ACCRUAL_FROMS)[number];

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
 * Compute the Nth accrual boundary. occurrenceIndex is 1-based.
 *
 * The anchor depends on `accrualFrom` (S577):
 *   - grace_end (default): anchor = dueDate + graceDays; occ 1 = anchor + 1 unit
 *     (unchanged historical behavior — accrual starts AFTER the initial fee).
 *   - due_date: anchor = dueDate; occ 1 = dueDate + 1 unit (each day/period
 *     AFTER the due date is charged retroactively once grace is crossed).
 *   - due_date_inclusive: anchor = dueDate; occ 1 = dueDate itself (the due day
 *     counts as the first charged unit).
 *
 * Grace still gates whether ANY fee applies (caller's qualifying check); this
 * only decides the counting anchor.
 *
 * - daily: anchor + N days
 * - weekly: anchor + (N * 7) days
 * - monthly: same day-of-month N months after anchor, clamped to last-of-month.
 */
export function nextAccrualDate(
  dueDate: string,
  graceDays: number,
  period: LateFeeAccrualPeriod,
  occurrenceIndex: number,
  accrualFrom: LateFeeAccrualFrom = 'grace_end'
): string {
  const anchor = accrualFrom === 'grace_end' ? lateFeeStartDate(dueDate, graceDays) : dueDate;
  // due_date_inclusive counts the anchor day itself as occurrence 1.
  const n = accrualFrom === 'due_date_inclusive' ? occurrenceIndex - 1 : occurrenceIndex;
  if (period === 'daily') {
    return addDaysISO(anchor, n);
  }
  if (period === 'weekly') {
    return addDaysISO(anchor, n * 7);
  }
  // monthly — calendar-exact with last-day clamp on anchor day
  const { y, m, d } = parseISODate(anchor);
  const totalMonths = (m - 1) + n;
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
