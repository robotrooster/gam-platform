// S624 — what a confirmed bank deposit does to late fees that already accrued.
//
// THE DATE THAT GOVERNS
//
// A tenant deposits at a branch on Friday afternoon; the bank posts it Monday.
// Under a naive rule — "the payment date is when the bank says the money
// landed" — that tenant takes three days of late fees for a deposit they made
// before the deadline. That is precisely the injustice the landlord is fixing by
// hand today (Nic: "checking when a tenant deposited money into the bank account
// and then going in, waiving whatever applicable late fees based on the time
// that the person made the deposit at the bank").
//
// So: WHEN A DECLARATION IS CONFIRMED BY A BANK ROW, THE TENANT'S DECLARED DATE
// IS THE PAYMENT DATE. The bank posting is the EVIDENCE that the deposit
// happened; the declared date is WHEN it happened. Without a declaration there
// is nothing to corroborate, and the bank's posted date is the only fact
// available, so it governs.
//
// This is also the honest incentive for a tenant to use the button at all: it
// buys them the earlier date. It cannot be gamed, because a claim with no
// matching deposit is never confirmed and never earns anything — and the window
// on the match is narrow enough that a declared date cannot wander far from the
// posting that proves it.

import { round2 } from './workTradeCredit'

/** One late-fee row already on the ledger. `tickDate` is `payments.due_date`. */
export interface LateFeeTick {
  paymentId: string
  tickDate: string
  amount: number
  /** Already paid by the tenant. Refund it as a credit rather than unbilling it. */
  settled: boolean
}

export interface BackdateOutcome {
  /** The date the rent is treated as satisfied. */
  effectivePaidDate: string
  /** Ticks that should never have accrued — to be reversed. */
  reversedTicks: LateFeeTick[]
  /** Ticks the tenant genuinely owed; these stand. */
  standingTicks: LateFeeTick[]
  /** Total to unbill (ticks still unpaid). */
  unbillAmount: number
  /** Total to refund as a tenant credit (ticks the tenant already paid). */
  refundAmount: number
}

/**
 * Which of these late fees survive a payment that turns out to have been made
 * on `effectivePaidDate`?
 *
 * A tick dated ON or BEFORE the payment date stands: the rent really was late
 * up to that moment, and the fee was earned. A tick dated AFTER it was never
 * owed — the money was already in the bank when the engine charged for its
 * absence.
 *
 * The two totals are kept apart because they are different acts. An unpaid tick
 * is simply removed from what the tenant owes. A tick they ALREADY PAID cannot
 * be un-charged, so it comes back as a `late_fee_refund` credit — GAM does not
 * erase money that moved, it corrects it in the open.
 */
export function backdateLateFees(
  ticks: LateFeeTick[], effectivePaidDate: string,
): BackdateOutcome {
  const reversedTicks: LateFeeTick[] = []
  const standingTicks: LateFeeTick[] = []
  for (const t of ticks) {
    if (t.tickDate > effectivePaidDate) reversedTicks.push(t)
    else standingTicks.push(t)
  }
  return {
    effectivePaidDate,
    reversedTicks,
    standingTicks,
    unbillAmount: round2(reversedTicks.filter(t => !t.settled).reduce((s, t) => s + t.amount, 0)),
    refundAmount: round2(reversedTicks.filter(t =>  t.settled).reduce((s, t) => s + t.amount, 0)),
  }
}

/**
 * The date a confirmed deposit is treated as paid on.
 *
 * A corroborated declaration wins — see the header. Everything else falls back
 * to the bank, which is the only fact on offer.
 *
 * GUARD: a declared date AFTER the bank posted the money is not evidence of
 * anything, it is a data-entry error or a probe. The posted date is used
 * instead, so a tenant can never claim a date the bank contradicts.
 */
export function effectivePaidDateFor(
  declaredDate: string | null | undefined, bankPostedDate: string,
): string {
  if (!declaredDate) return bankPostedDate
  return declaredDate <= bankPostedDate ? declaredDate : bankPostedDate
}
