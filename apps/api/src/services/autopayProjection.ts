/**
 * S607 — autopay scheduling helpers.
 *
 * REDUCED from a late-fee projection engine (Nic): "it doesn't seem like autopay
 * needs to be that big of a deal. They choose the date, and it pays in full
 * whatever the balance is on the account. If late fees are accruing daily, it
 * just reads the outstanding amount at the time payment is set to go through. We
 * don't need to make it all complicated and show somebody what their bill will be
 * exactly."
 *
 * He is right, and the projection was the wrong shape twice over:
 *
 *   1. It was a SNAPSHOT of a moving number. Between the tenant choosing a day
 *      and the charge landing, the balance can change for a dozen legitimate
 *      reasons — another accrual tick, a utility bill joining the invoice, a
 *      partial credit, the landlord waiving a fee. Any figure shown in advance is
 *      a promise we cannot keep.
 *   2. Reading the live balance at charge time is both simpler AND always
 *      correct, which is the rare case where the cheap option is the right one.
 *
 * What the tenant gets instead is the honest statement rather than a fake
 * precise one: choosing a day after the due date means late fees per their lease,
 * and the charge will be the full outstanding balance at the moment it runs.
 *
 * All that survives is the date arithmetic — which day of the month maps to which
 * calendar date for a given cycle. (File name is now a misnomer; renaming it is a
 * one-line change whenever the runner lands.)
 */

/** The pay date for a chosen day-of-month against a cycle's due date. A pull day
 *  EARLIER in the month than the due day means the NEXT month's occurrence —
 *  choosing the 5th when rent is due the 1st is the 5th of the same month, but
 *  choosing the 1st when rent is due the 5th cannot mean "four days before it is
 *  owed", so it rolls forward. */
export function payDateForPullDay(dueDate: string, pullDay: number | null): string {
  if (pullDay == null) return dueDate
  const [y, m, d] = dueDate.split('-').map(Number)
  if (pullDay >= d) return iso(y, m, pullDay)
  const nm = m === 12 ? 1 : m + 1
  const ny = m === 12 ? y + 1 : y
  return iso(ny, nm, pullDay)
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
