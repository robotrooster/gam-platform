/**
 * S616 — when a chosen autopay day actually lands, and whether that is late.
 *
 * Nic: "does the autopay scheduler read the grace period and tell them
 * correctly whether or not they will be charged late fees or not?"
 *
 * It did not, and the first fix only covered half of it. S616 taught the card
 * the lease's grace period so a tenant paid on the 3rd with a five-day grace
 * stopped being warned about fees they would never owe. But the card decided
 * "is this after the due day" with a bare `pullDay > dueDay`, and that is wrong
 * whenever the chosen day is EARLIER in the month than the due day — because
 * such a day cannot mean "before it is owed", so it rolls to the NEXT month.
 *
 * Rent due the 5th, autopay set to the 1st, is not four days early. It is the
 * 1st of the following month: twenty-six days late, every single cycle. The
 * card said nothing at all, because 1 is not greater than 5.
 *
 * This is the arithmetic, in ONE place, so the screen that promises and the
 * runner that charges can never disagree about which day is safe.
 */

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The pay date for a chosen day-of-month against a cycle's due date.
 *
 * A pull day EARLIER in the month than the due day means the NEXT month's
 * occurrence — choosing the 5th when rent is due the 1st is the 5th of the same
 * month, but choosing the 1st when rent is due the 5th cannot mean "four days
 * before it is owed", so it rolls forward.
 */
export function autopayPayDate(dueDate: string, pullDay: number | null): string {
  if (pullDay == null) return dueDate;
  const [y, m, d] = dueDate.split('-').map(Number);
  if (pullDay >= d) return iso(y, m, pullDay);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return iso(ny, nm, pullDay);
}

/** Whole days between two ISO dates (b − a). */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export interface AutopayLateness {
  /** The calendar date the charge would actually run. */
  payDate: string;
  /** How many days after the due date that is. Never negative — a pull day
   *  before the due day rolls forward rather than paying early. */
  daysAfterDue: number;
  /** True when a late fee would apply under this lease. */
  isLate: boolean;
  /** The first date a fee applies: dueDate + grace. */
  lateFrom: string;
}

/**
 * Would autopay on `pullDay` be charged a late fee?
 *
 * Mirrors the late-fee engine's own gate exactly — a fee applies when the date
 * is ON OR AFTER dueDate + graceDays — so the last free day is the day before
 * that. Initiating inside the window is genuinely safe rather than merely
 * untested: the engine skips an invoice with an in-flight payment, so an ACH
 * that starts on the last free day never accrues a fee while it clears.
 */
export function autopayLateness(
  dueDate: string,
  pullDay: number | null,
  graceDays: number,
  lateFeeEnabled = true,
): AutopayLateness {
  const payDate = autopayPayDate(dueDate, pullDay);
  const daysAfterDue = Math.max(0, daysBetween(dueDate, payDate));
  const [y, m, d] = dueDate.split('-').map(Number);
  const lateFromMs = Date.UTC(y, m - 1, d + graceDays);
  const lf = new Date(lateFromMs);
  const lateFrom = iso(lf.getUTCFullYear(), lf.getUTCMonth() + 1, lf.getUTCDate());
  return {
    payDate,
    daysAfterDue,
    lateFrom,
    isLate: lateFeeEnabled && daysAfterDue >= graceDays,
  };
}
