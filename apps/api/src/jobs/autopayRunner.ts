/**
 * S609 — the job that actually charges a tenant's scheduled rent.
 *
 * Runs once a day per property timezone, in the morning local time, so a bank
 * pull happens during a business day the tenant would expect rather than at
 * whatever hour the server thinks it is.
 *
 * WHAT IT CHARGES: the live outstanding balance, read at the moment it runs.
 * Nothing is forecast (Nic) — between the tenant choosing a day and the charge
 * landing, the balance moves for entirely ordinary reasons, so a figure captured
 * in advance is a promise the system cannot keep. It charges the bill in full,
 * exactly like the Pay button, through exactly the same code
 * (services/rentCharge) — a scheduled payment and a pressed button must never
 * produce a different fee or a different owner share. S655: the amount is the
 * server's own Pay Now quote of the bill (quoteLeaseCharge), a neighbor
 * landlord's utility on the same invoice included, the old balance never.
 *
 * CREDIT (Nic, 10/2): "use my account credit first" is the tenant's setting,
 * off by default. Off: the whole bill is charged and the credit waits for the
 * tenant. On: the usable credit pays its part and the rest is charged; when it
 * covers everything, the bill is paid with credit and nothing is charged.
 * Credit another bank payment still holds (the old lease's retry after a
 * renewal moved the credit) is not free: the free part is used, the rest of
 * the bill is pulled that cycle, and the tenant is told the held part is set
 * aside for that earlier payment — spent on the earlier bill if that payment
 * clears, back on the account only if it finally fails (rentCharge
 * creditWaitingSentence, 10/4). It is never a failed month. An older bill
 * whose bank retry is already scheduled gets no credit set aside (decisions.md
 * #46 1b): that retry pulls a fixed amount and never uses credit, so free
 * credit goes to the bill autopay is charging now.
 * A tenant with several bills pulled in one run is told about held credit
 * ONCE (fix pass 3): the same held dollars are what every one of those bills
 * could have used, so the sentence rides the first notice only, with the
 * run's one figure (payAllRunCreditWaiting, read before the first charge).
 *
 * WHICH METHOD (item L): the method the tenant chose, which must still be on
 * their account; else their default; else a verified bank; a card only when
 * no verified bank is on file. A bank still waiting on its microdeposits is
 * never charged — the old bank keeps paying meanwhile. Bank payments are
 * skipped while the tenant is suspended after a bank return, and no card is
 * moved in: a paused bank is still a verified bank on file (the one switch is
 * AUTOPAY_CARD_WHEN_BANK_PAUSED). A bill the
 * tenant's credit pays in full (use-my-credit on) needs no method at all.
 *
 * FLEXPAY tenants are skipped: FlexPay pays their bill (enrolling turns
 * autopay off; this is the belt to that braces).
 *
 * WHEN IT RUNS FOR A LEASE: on the day the tenant picked, or on the rent due
 * date if they picked nothing. A day EARLIER in the month than the due day means
 * next month's occurrence — choosing the 1st when rent is due the 5th cannot
 * mean "four days before it is owed".
 *
 * NEVER TWICE: `last_run_cycle` is claimed in its own committed statement BEFORE
 * the charge is attempted, and only a row that has not already claimed the cycle
 * can claim it. A restarted job, an overlapping run, or a second server can only
 * lose that race — none of them can charge a tenant a second time.
 *
 * ON FAILURE (Nic): the schedule stays on, both sides are told, and it disarms
 * itself after two failures in a row. See the migration for the reasoning.
 *
 * CARDS ARE PULLED OFF-SESSION (decisions.md #48.4): the cardholder is not
 * here, and Stripe tells the card's bank so (rentCharge passes offSession for
 * an autopay card). A bank that still demands the cardholder confirm the
 * payment (3-D Secure) makes the pull fail through this same failure path —
 * nothing is charged or written, the intent is canceled — and the tenant is
 * told to pay from the Payments page, where the bank can ask them to confirm.
 *
 * A BILL HELD BY A CARD THE PAYER IS CONFIRMING is not a paid bill (fix pass
 * 3). A tenant (or a co-tenant) who pressed Pay by card on the portal and is
 * answering their bank's confirmation holds the bill for up to
 * CARD_CONFIRM_HOLD_MINUTES; its rows wait on that charge, so the quote shows
 * nothing owed. Before quoting, holds past their window are released
 * (paymentReconcile.releaseUnconfirmedCardCharges). A hold still open is
 * waited on: the month is neither charged nor counted as paid, nobody is told
 * anything, and the lease is marked held over (heldOverMarker). The autopay
 * engine looks again every 15 minutes through the morning (and the next
 * morning's run, within the same month): confirmed means the bill is paid and
 * the month is recorded as such; abandoned means the hold is released and the
 * bill is pulled as it would have been.
 */

import { query, queryOne, getClient } from '../db'
import { getStripe } from '../lib/stripe'
import { chargeLeaseBalance, quoteLeaseCharge, CreditChangedError, payAllRunCreditWaiting, creditWaitingSentence } from '../services/rentCharge'
import { createNotification, notifyAutopayFailed, type AutopayFailureKind } from '../services/notifications'
import { createAdminNotification } from '../services/adminNotifications'
import { logger } from '../lib/logger'
import { registerEngine } from './timezoneCronManager'
import { formatCurrency } from '@gam/shared'
import { releaseUnconfirmedCardCharges, heldForCardholder } from './paymentReconcile'

/** Failures in a row before autopay switches itself off (Nic). */
export const AUTOPAY_DISARM_AFTER_FAILURES = 2

export interface AutopayRunResult {
  considered: number
  charged:    number
  failed:     number
  skipped:    number
}

/**
 * Is today the day this lease's autopay should run?
 *
 * `pullDay` null → the rent due day. Otherwise the chosen day, except that a
 * chosen day before the due day belongs to the NEXT cycle — which, from the
 * runner's point of view, still just means "fire on that date".
 */
export function isPullDayToday(
  todayDayOfMonth: number,
  pullDay: number | null,
  rentDueDay: number | null,
): boolean {
  const target = pullDay ?? rentDueDay ?? 1
  return todayDayOfMonth === target
}

/**
 * Today's date in a timezone, as {ymd, day}.
 *
 * S629: `now` is injectable, defaulting to the real clock. It was hard-wired to
 * `new Date()`, which left the autopay tests unable to state what day the run
 * happens on — they armed a tenant for "today" and, on the 29th, 30th or 31st,
 * could not: tenant_autopay_pull_day_check caps pull_day at 28, because a pull
 * day of 29 does not exist in every month. So the suite went red on three days
 * of every month, at month end, on the runner that moves rent.
 *
 * Only the DAY varies with this; ymd feeds the billing cycle, which is the
 * month, so a run pinned within the same month bills the same cycle.
 */
export function localToday(tz: string, now: Date = new Date()): { ymd: string; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const ymd = fmt.format(now)
  return { ymd, day: Number(ymd.slice(8, 10)) }
}

/**
 * Charge every scheduled autopay falling due today for properties in `tz`.
 */
export async function runAutopayForTimezone(
  tz: string, now: Date = new Date(),
  /**
   * pullDays false: only leases held over by a card the payer was confirming
   * (the engine's later ticks). Default: the morning run — today's pull days
   * and any held-over lease.
   */
  opts: { pullDays?: boolean } = {},
): Promise<AutopayRunResult> {
  const { ymd, day } = localToday(tz, now)
  // The cycle key: one attempt per lease per calendar month.
  const cycle = `${ymd.slice(0, 7)}-01`
  const heldOver = heldOverMarker(cycle)
  const pullDays = opts.pullDays !== false

  const candidates = await query<{
    autopay_id: string; tenant_id: string; lease_id: string
    pull_day: number | null; rent_due_day: number | null
    payment_method_id: string | null; stripe_customer_id: string | null
    use_credit: boolean; ach_suspended: boolean; last_run_cycle: string | null
  }>(
    `SELECT a.id AS autopay_id, a.tenant_id, a.lease_id, a.pull_day,
            l.rent_due_day, a.payment_method_id, t.stripe_customer_id,
            a.use_credit, (t.ach_suspended_at IS NOT NULL) AS ach_suspended,
            a.last_run_cycle::text AS last_run_cycle
       FROM tenant_autopay a
       JOIN leases l   ON l.id = a.lease_id
       JOIN units u    ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN tenants t  ON t.id = a.tenant_id
      WHERE a.enabled
        AND l.status = 'active'
        AND p.timezone = $1
        -- S655: FlexPay pays an enrolled tenant's bill; never pull it twice.
        AND NOT t.flexpay_enrolled
        AND (a.last_run_cycle IS NULL OR a.last_run_cycle < $2::date)`,
    [tz, cycle])

  const result: AutopayRunResult = { considered: 0, charged: 0, failed: 0, skipped: 0 }
  const due = candidates.filter(c =>
    c.last_run_cycle === heldOver || (pullDays && isPullDayToday(day, c.pull_day, c.rent_due_day)))
  // Held credit is said once per tenant per run, with the run's figure.
  const runWaiting = await runCreditWaitingByTenant(due)
  const waitingTold = new Set<string>()

  for (const c of due) {
    result.considered++

    // Claim the cycle FIRST, in its own committed statement. Whatever happens
    // next — success, decline, a crash mid-charge — this tenant cannot be
    // charged again this month by another run.
    const claimed = await queryOne<{ id: string }>(
      `UPDATE tenant_autopay
          SET last_run_cycle = $2::date, updated_at = NOW()
        WHERE id = $1 AND (last_run_cycle IS NULL OR last_run_cycle < $2::date)
        RETURNING id`,
      [c.autopay_id, cycle])
    if (!claimed) { result.skipped++; continue }

    try {
      // The quote is read a moment before the charge takes its lock. With
      // "use my credit first" on, a credit that moved in between (a desk
      // payment, the bill run's whole-bill check, a credit that appeared from
      // $0) is refused before anything is written or charged — re-quoted
      // once, never counted as a failure. With it off the charge does not
      // depend on the credit figure at all: the whole bill is charged.
      let attempt: AutopayAttempt
      try {
        attempt = await attemptAutopayCharge(c)
      } catch (e) {
        if (!(e instanceof CreditChangedError)) throw e
        attempt = await attemptAutopayCharge(c)
      }
      if (attempt.kind === 'held') {
        // A card the payer is confirming holds the bill: not paid, not
        // failed. The cycle is handed back, marked held over, so a later
        // look charges it if that card payment is abandoned.
        result.skipped++
        await query(
          `UPDATE tenant_autopay SET last_run_cycle = $3::date, updated_at = NOW()
            WHERE id = $1 AND last_run_cycle = $2::date`,
          [c.autopay_id, cycle, heldOver])
        logger.info({ leaseId: c.lease_id }, '[autopay] bill held by a card payment being confirmed; looking again later')
        continue
      }
      if (attempt.kind === 'nothing_owed') {
        // Nothing owed — paid ahead, or already paid by hand this month.
        // Not a failure and not worth a notification.
        result.skipped++
        await query(
          `UPDATE tenant_autopay SET last_success_cycle = $2::date, consecutive_failures = 0,
                  last_error = NULL, updated_at = NOW() WHERE id = $1`,
          [c.autopay_id, cycle])
        continue
      }
      const { charged, method, due } = attempt

      await query(
        `UPDATE tenant_autopay
            SET last_success_cycle = $2::date, consecutive_failures = 0,
                last_error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [c.autopay_id, cycle])
      result.charged++

      const paidWithCredit = (charged as any)?.paidWithCredit === true
      const total = Number((charged as any)?.chargeAmount ?? 0) || due
      // Credit held by another bank payment was left alone: say so, in the
      // same words the pay screen uses — once per tenant this run.
      const waiting = waitingSentenceOnce(c.tenant_id, (charged as any)?.creditStillHeldElsewhere,
        (charged as any)?.creditWaitingNote ?? null, runWaiting, waitingTold)
      const body = paidWithCredit
        ? 'Your account credit covered this bill, so nothing was charged.'
        : method?.type === 'ach'
          ? `We've started your scheduled rent payment of ${formatCurrency(total)}. Bank payments usually take 3–5 business days to clear.`
          : `Your card was charged ${formatCurrency(total)} for rent. A receipt is on its way.`
      await notifyTenant(c.tenant_id, 'autopay',
        paidWithCredit ? 'Paid with your account credit' : 'Autopay submitted',
        waiting ? `${body} ${waiting}` : body)
    } catch (e) {
      result.failed++
      await handleFailure(c, e)
    }
  }

  if (result.considered > 0) logger.info({ tz, ...result }, '[autopay]')
  return result
}

/**
 * Tenants with two or more bills pulled in this run: the credit another bank
 * payment still holds that their run would have used — one figure, read
 * before the first charge (the run's charges are played through, those with
 * "use my credit first" off spending nothing). A read that fails says nothing
 * here; each notice then falls back to its own bill's figure.
 */
async function runCreditWaitingByTenant(
  due: readonly { tenant_id: string; lease_id: string; use_credit: boolean }[],
): Promise<Map<string, number>> {
  const byTenant = new Map<string, { order: string[]; noCredit: string[] }>()
  for (const c of due) {
    const t = byTenant.get(c.tenant_id) ?? { order: [], noCredit: [] }
    if (!t.order.includes(c.lease_id)) t.order.push(c.lease_id)
    if (c.use_credit !== true) t.noCredit.push(c.lease_id)
    byTenant.set(c.tenant_id, t)
  }
  const out = new Map<string, number>()
  const many = [...byTenant].filter(([, t]) => t.order.length >= 2)
  if (many.length === 0) return out
  const client = await getClient()
  try {
    for (const [tenantId, t] of many) {
      try {
        out.set(tenantId, await payAllRunCreditWaiting(client, { tenantId, order: t.order, noCredit: t.noCredit }))
      } catch (e) {
        logger.warn({ err: e, tenantId }, '[autopay] run credit-waiting figure not read; each notice says its own')
      }
    }
  } finally { client.release() }
  return out
}

/**
 * The held-credit sentence for this notice, or null: said on the tenant's
 * first notice that has held credit in this run, never again. The figure is
 * the run's (never below this bill's own), so one hold is told once and two
 * holds are both counted.
 */
export function waitingSentenceOnce(
  tenantId: string, ownWaiting: number | null | undefined, ownNote: string | null,
  runWaiting: ReadonlyMap<string, number>, told: Set<string>,
): string | null {
  const ownCents = Math.round(Number(ownWaiting ?? 0) * 100)
  if (!ownNote && !(ownCents > 0)) return null
  if (told.has(tenantId)) return null
  told.add(tenantId)
  const runCents = Math.round((runWaiting.get(tenantId) ?? 0) * 100)
  if (runCents > ownCents) return creditWaitingSentence(runCents)
  return ownNote ?? creditWaitingSentence(ownCents)
}

interface AutopayCandidate {
  tenant_id: string; lease_id: string
  payment_method_id: string | null; stripe_customer_id: string | null
  use_credit: boolean; ach_suspended: boolean
}

type AutopayAttempt =
  | { kind: 'nothing_owed' }
  /** The bill is held by a card payment its payer is still confirming with their bank. */
  | { kind: 'held' }
  | { kind: 'charged'; charged: Awaited<ReturnType<typeof chargeLeaseBalance>>; method: { id: string; type: 'ach' | 'card' } | null; due: number }

/** One quote-then-charge of a lease's bill. Throws what the charge throws. */
async function attemptAutopayCharge(c: AutopayCandidate): Promise<AutopayAttempt> {
  // A card payment nobody confirmed in time no longer holds the bill.
  try {
    await releaseUnconfirmedCardCharges(getStripe, { tenantId: c.tenant_id })
  } catch (err) {
    logger.error({ err, leaseId: c.lease_id }, '[autopay] unconfirmed card release failed; looking at the holds directly')
  }
  // One still in its window is waited on — never read as a paid bill.
  if (await heldByUnconfirmedCard(c.lease_id)) return { kind: 'held' }
  // The live bill, right now, by the same arithmetic as Pay Now. S622:
  // never the carried-forward balance — arrears imported from a previous
  // system are paid down by the tenant, in an amount they choose; sweeping
  // them into an automatic pull takes money that was never authorized.
  // S654: a work-trade line is labor's to pay, never the bank's. What is
  // owed does not depend on the method (the fee is added at the charge).
  const quote = await quoteLeaseCharge({
    tenantId: c.tenant_id, leaseId: c.lease_id,
    useCredit: c.use_credit === true, paymentMethodType: 'ach',
  })
  if (quote.required.length === 0) return { kind: 'nothing_owed' }
  const due = quote.landing.dueCents / 100
  const useCredit = c.use_credit === true && quote.usableCredit > 0

  // "Use my credit first" and the credit pays the whole bill: nothing is
  // charged, so no card or bank is needed — not even one that is paused.
  const creditPaysAll = useCredit && quote.landing.dueCents === 0
  const method = creditPaysAll ? null
    : await resolvePaymentMethod(c.payment_method_id, c.stripe_customer_id, { achSuspended: c.ach_suspended })
  if (!creditPaysAll && !method) {
    throw new NoPaymentMethodError('No usable payment method on file')
  }

  const charged = await chargeLeaseBalance({
    tenantId:          c.tenant_id,
    leaseId:           c.lease_id,
    amount:            due,
    // No method when the credit pays the whole bill: nothing is charged.
    paymentMethodId:   method?.id,
    paymentMethodType: method?.type,
    source:            'autopay',
    // The answer always goes with the figure it was given for, $0 included:
    // a credit that lands between this quote and the charge's lock (desk cash
    // kept as credit, a webhook surplus, an issued credit) must not turn the
    // pull into a "choose Use or Save" refusal. Off: save it — the whole bill
    // is charged whatever the credit is now. On: a figure that moved is
    // refused (CreditChangedError) and the runner re-quotes once.
    credit:            { use: c.use_credit === true, expected: quote.usableCredit },
  })
  return { kind: 'charged', charged, method, due }
}

/**
 * The last_run_cycle a lease is given when its bill was held by a card being
 * confirmed: the day before the cycle. Real claims are always the 1st of a
 * month, so this is never mistaken for one, and it is below the cycle, so the
 * lease is still unclaimed this month. A month later it is just an old date.
 */
export function heldOverMarker(cycle: string): string {
  const d = new Date(`${cycle}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Is any of this lease's bill waiting on a card payment whose payer is still
 * confirming it with their bank (3-D Secure, decisions.md #48.4)? Rows held
 * by a card receipt still 'processing' are asked about in Stripe; a charge
 * that went through (or is on its way) is not a hold — that bill is paid —
 * and neither is a card charge the pay screen did not make.
 * A charge Stripe cannot be asked about is treated as a hold: waiting a
 * little is safe, a lost month is not.
 */
async function heldByUnconfirmedCard(leaseId: string): Promise<boolean> {
  const held = await query<{ pi: string }>(
    `SELECT DISTINCT p.stripe_payment_intent_id AS pi
       FROM payments p
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
       JOIN tenant_remittances r ON r.stripe_payment_intent_id = p.stripe_payment_intent_id
      WHERE COALESCE(p.lease_id, inv.lease_id) = $1
        AND p.status = 'processing'
        AND r.status = 'processing' AND r.payment_method = 'card'`,
    [leaseId])
  if (held.length === 0) return false
  const stripe = getStripe()
  for (const { pi } of held) {
    try {
      const live = await stripe.paymentIntents.retrieve(pi)
      // Only the pay screen's own card charge holds the bill for its payer
      // (paymentReconcile.heldForCardholder); a move-out balance charge GAM
      // is finishing never stops autopay pulling the rest of the bill.
      if (heldForCardholder(live)) return true
    } catch (err) {
      logger.warn({ err, paymentIntentId: pi, leaseId }, '[autopay] could not read a card payment holding the bill; waiting on it')
      return true
    }
  }
  return false
}

/**
 * Whether a card on file stands in when a tenant's bank payments are paused
 * after a bank return. The money plan's method rule decides it: "a verified
 * bank before any card — a card only when no verified bank is on file" (item
 * L). A paused bank is still a verified bank on file, so no card is moved in:
 * the pull is skipped and the tenant is told to pay (by card if they like).
 * A card the tenant pinned for autopay, or made their default, is charged
 * either way. This is the one place the rule lives, should Nic want a card
 * on file to stand in instead (it carries the card fee).
 */
export const AUTOPAY_CARD_WHEN_BANK_PAUSED = false

/**
 * Which method to charge (S655, item L).
 *
 *   1. The method the tenant chose for autopay — it must still be on their
 *      account. One that is gone is a failure the tenant fixes, never a quiet
 *      switch to another method they did not choose.
 *   2. Their default, when it can be charged (a bank still waiting on its
 *      microdeposits is not on the account yet, so it is passed over).
 *   3. A verified bank — the old bank keeps paying while a new one verifies.
 *   4. A card, only when no verified bank is on file.
 *
 * Bank payments are skipped while the tenant is suspended after a bank return;
 * whether a card on file stands in is AUTOPAY_CARD_WHEN_BANK_PAUSED.
 * Returns null when nothing can be charged; the failure path tells the tenant.
 */
export async function resolvePaymentMethod(
  chosenId: string | null,
  stripeCustomerId: string | null,
  opts: { achSuspended?: boolean; cardWhenBankPaused?: boolean } = {},
): Promise<{ id: string; type: 'ach' | 'card' } | null> {
  const achSuspended = opts.achSuspended === true
  const cardWhenBankPaused = opts.cardWhenBankPaused ?? AUTOPAY_CARD_WHEN_BANK_PAUSED
  if (!stripeCustomerId) return null
  const stripe = getStripe()
  const usable = (pm: any): { id: string; type: 'ach' | 'card' } | null => {
    if (!pm || pm.customer !== stripeCustomerId) return null
    const type: 'ach' | 'card' = pm.type === 'card' ? 'card' : 'ach'
    if (type === 'ach' && achSuspended) return null
    return { id: pm.id, type }
  }

  if (chosenId) {
    const pm = await stripe.paymentMethods.retrieve(chosenId).catch(() => null)
    const ok = usable(pm)
    if (ok) return ok
    const pausedBank = !!pm && (pm as any).customer === stripeCustomerId && achSuspended
    if (!(pausedBank && cardWhenBankPaused)) {
      throw new NoPaymentMethodError(pausedBank
        ? 'Bank payments are paused on this account after a bank return'
        : 'The payment method chosen for autopay is no longer on the account')
    }
    // The pinned bank is paused and a card on file may stand in: look on.
  }

  const customer = await stripe.customers.retrieve(stripeCustomerId)
  const defaultId = (customer && !('deleted' in customer && customer.deleted))
    ? ((customer as any).invoice_settings?.default_payment_method as string | null) ?? null
    : null
  if (defaultId) {
    const pm = await stripe.paymentMethods.retrieve(defaultId).catch(() => null)
    const ok = usable(pm)
    if (ok) return ok
  }

  // No usable default: a verified bank (an attached bank is a verified one),
  // else a card — but never a card while a verified bank is on file. A tenant
  // whose bank payments are paused after a return is moved onto a card only
  // when AUTOPAY_CARD_WHEN_BANK_PAUSED says so (off: the plan's rule); otherwise the
  // pull fails and they are told to pay, by card if they like. Their own
  // pinned or default card is still charged above.
  const [banks, cards] = await Promise.all([
    stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'us_bank_account', limit: 10 }),
    stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card', limit: 1 }),
  ])
  const bank = banks.data.find(b => usable(b))
  if (bank) return { id: bank.id, type: 'ach' }
  if (banks.data.length > 0 && !(achSuspended && cardWhenBankPaused && cards.data[0])) {
    throw new NoPaymentMethodError(achSuspended
      ? 'Bank payments are paused on this account after a bank return'
      : 'No usable payment method on file')
  }
  if (cards.data[0]) return { id: cards.data[0].id, type: 'card' }
  return null
}

/** Our own "nothing to charge with" failure — the tenant's side to fix. */
class NoPaymentMethodError extends Error {}

/**
 * Stripe error codes that mean the tenant's payment method cannot be used as it
 * stands (a card error is always one, whatever its code). Anything else Stripe
 * or GAM throws is not something the tenant's account caused.
 */
const PAYMENT_METHOD_ERROR_CODES = new Set([
  'card_declined', 'expired_card', 'incorrect_cvc', 'insufficient_funds', 'authentication_required',
  'payment_intent_authentication_failure', 'payment_intent_payment_attempt_failed',
  'payment_method_unactivated', 'payment_method_unexpected_state', 'payment_method_not_available',
  'payment_method_provider_decline', 'payment_method_customer_decline', 'payment_method_bank_account_blocked',
  'bank_account_unusable', 'bank_account_declined', 'bank_account_unverified',
  'bank_account_verification_failed', 'bank_account_restricted',
  'account_closed', 'no_account', 'invalid_account_number', 'debit_not_authorized',
])

/**
 * S654: why an autopay pull failed, as the tenant is told it. A space in
 * eviction mode is read from the unit itself (chargeLeaseBalance refuses it
 * with a 409), so it never depends on an error's wording.
 */
export async function classifyAutopayFailure(e: unknown, leaseId: string): Promise<AutopayFailureKind> {
  const paused = await queryOne<{ payment_block: boolean | null }>(
    `SELECT u.payment_block FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`, [leaseId])
  if (paused?.payment_block) return 'payments_paused'
  if (e instanceof NoPaymentMethodError) return 'payment_method'
  const err = e as any
  if (err?.type === 'StripeCardError' || err?.rawType === 'card_error') return 'payment_method'
  if (err?.type === 'StripeInvalidRequestError' || err?.rawType === 'invalid_request_error') {
    if (err?.param === 'payment_method' || PAYMENT_METHOD_ERROR_CODES.has(String(err?.code ?? ''))) {
      return 'payment_method'
    }
  }
  return 'our_side'
}

/**
 * A pull failed. Count it, tell both sides, and switch autopay off if this is
 * the second failure in a row.
 */
async function handleFailure(
  c: { autopay_id: string; tenant_id: string; lease_id: string },
  e: unknown,
): Promise<void> {
  const message = e instanceof Error ? e.message : String(e)
  const row = await queryOne<{ consecutive_failures: number }>(
    `UPDATE tenant_autopay
        SET consecutive_failures = consecutive_failures + 1,
            last_error = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING consecutive_failures`,
    [c.autopay_id, message.slice(0, 500)])
  const failures = row?.consecutive_failures ?? 1
  const disarming = failures >= AUTOPAY_DISARM_AFTER_FAILURES

  if (disarming) {
    await query(
      `UPDATE tenant_autopay
          SET enabled = FALSE, disarmed_at = NOW(),
              disarmed_reason = 'Two scheduled payments in a row could not be completed.',
              updated_at = NOW()
        WHERE id = $1`,
      [c.autopay_id])
  }

  logger.warn({ leaseId: c.lease_id, failures, disarming, err: message }, '[autopay] pull failed')

  // The tenant believes the money moved. Tell them plainly that it did not, and
  // that rent is still owed — never a bank error code.
  //
  // S654: by email too, with a Pay now button. This was an in-app notice only,
  // and a tenant who thinks rent paid itself has no reason to open the app.
  // The button is the same signed sign-in link the bill email uses (lands on
  // Payments); without a portal account it is the plain Payments link.
  //
  // S654 (review): what they are told depends on WHY. "Check the account you
  // pay from, then pay" was going out for an eviction hold (whose Payments page
  // refuses the payment) and for GAM's own errors. notifyAutopayFailed words
  // each kind truthfully and only emails the ones a payment can fix.
  let kind: AutopayFailureKind = 'our_side'
  try {
    kind = await classifyAutopayFailure(e, c.lease_id)
  } catch (err) {
    logger.error({ err, leaseId: c.lease_id }, '[autopay] failure classification failed')
  }
  if (kind === 'our_side') {
    // Nothing about the tenant's account caused this, so someone at GAM has to
    // look — the tenant is told it was our side.
    await createAdminNotification({
      severity: 'warn',
      category: 'autopay_charge_error',
      title:    `Autopay could not start a rent payment (lease ${c.lease_id})`,
      body:     message.slice(0, 1000),
      context:  { autopay_id: c.autopay_id, lease_id: c.lease_id, tenant_id: c.tenant_id, failures, disarming },
    })
  }
  try {
    const t = await queryOne<{ user_id: string | null; email: string | null }>(
      `SELECT t.user_id, u.email FROM tenants t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [c.tenant_id])
    if (t?.user_id) {
      const { payNowLink } = await import('../services/invoiceNotice')
      let payUrl: string | null = null
      try {
        payUrl = payNowLink({ tenant_user_id: t.user_id, tenant_email: t.email })
      } catch (err) {
        logger.error({ err, leaseId: c.lease_id }, '[autopay] pay link failed')
      }
      await notifyAutopayFailed({ tenantUserId: t.user_id, tenantEmail: t.email, disarming, kind, payUrl })
    }
  } catch (err) {
    logger.error({ err, leaseId: c.lease_id }, '[autopay] tenant failure notice failed')
  }

  // The landlord is watching a lease that says a payment is scheduled. Without
  // this they read the silence as a tenant who stopped paying.
  const landlord = await queryOne<{ user_id: string; unit_number: string; property_name: string }>(
    `SELECT lu.id AS user_id, u.unit_number, pr.name AS property_name
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties pr ON pr.id = u.property_id
       JOIN landlords ld ON ld.id = l.landlord_id
       JOIN users lu ON lu.id = ld.user_id
      WHERE l.id = $1`,
    [c.lease_id])
  if (landlord) {
    await createNotification({
      userId: landlord.user_id,
      type: 'autopay_failed',
      title: `Scheduled rent payment didn’t go through — ${landlord.property_name} · Unit ${landlord.unit_number}`,
      body: disarming
        ? 'The tenant’s scheduled payment failed twice, so it has been switched off. Their rent is still owed and they have been told.'
        : 'The tenant’s scheduled payment failed. Their rent is still owed and they have been told. The schedule is still on for next month.',
      actionUrl: '/leases',
    }).catch(() => {})
  }
}

/** The engine's first tick of the day (09:00–09:14 local) is the pull-day run. */
export function isMorningRunTick(tz: string, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === 'hour')?.value)
  const minute = Number(parts.find(p => p.type === 'minute')?.value)
  return hour === 9 && minute < 15
}

async function notifyTenant(
  tenantId: string, type: 'autopay', title: string, body: string,
): Promise<void> {
  const u = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
  if (!u?.user_id) return
  await createNotification({
    userId: u.user_id, type, title, body, actionUrl: '/payments',
  }).catch(() => {})
}

/**
 * Register autopay with the timezone cron manager.
 *
 * 09:00 in the PROPERTY's local time — the pull happens during a business day
 * the tenant would recognize, not at whatever hour the server happens to be in.
 * Late fees run at local midnight and invoices at local 07:00, so by 09:00 the
 * balance this job reads already includes today's charges and today's accrual.
 */
export function registerAutopayEngine(): void {
  registerEngine('autopay', {
    // 09:00 is the run. The ticks after it, through 11:45, look only at bills
    // a card payment was holding at 09:00 (heldOverMarker) — a hold lasts at
    // most CARD_CONFIRM_HOLD_MINUTES, so the pull is late by under an hour,
    // never a month.
    cronExpr: '*/15 9-11 * * *',
    handler: async (tz: string) => {
      try {
        await runAutopayForTimezone(tz, new Date(), { pullDays: isMorningRunTick(tz, new Date()) })
      } catch (e) {
        logger.error({ err: e, tz }, '[autopay] error')
      }
    },
    label: 'Tenant autopay',
  })
}
