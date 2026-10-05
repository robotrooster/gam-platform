/**
 * S609 — the ONE way a lease balance gets charged to a card or a bank.
 *
 * This is the body of POST /payments/pay-balance, lifted out of the Express
 * handler so the AUTOPAY RUNNER and the COUNTER CARD READER charge through
 * exactly the same code. Two implementations of "how rent is charged" is how a
 * tenant ends up paying a different fee, or a landlord receiving a different
 * owner share, depending on whether a human pressed the button or a cron did.
 *
 * S655 (money plan §3, Step 8) rebuilt it on the credit ledger:
 *
 *   - ONE LOCK, READS INSIDE IT. The household lock (lockHousehold) is taken
 *     first and every row is read and locked inside the transaction. Before,
 *     the rows were read outside it, so two charges at once on one lease (or a
 *     co-tenant paying the same lease) could both stamp the same row.
 *   - NOTHING IS SPLIT except a carried-forward balance (S622). Credit may pay
 *     PART of a row (the card pays the rest of the SAME row); a row is never
 *     cut in two.
 *   - THE PAYER CHOOSES what to do with credit (Nic, 10/2): "Use all $X — pay
 *     $Y" or "Save it for later — pay $Z", and when the credit covers the whole
 *     bill, "Pay with credit — nothing charged". The request carries the choice
 *     and the credit figure the payer was shown; the server re-quotes under the
 *     lock and, for "Use all", answers 409 "Your credit changed — it's now $N"
 *     if it moved (CreditChangedError). "Save it for later" charges the whole
 *     bill whatever the figure, so a moved figure refuses nothing.
 *     With credit used, the money must be exactly what is left of the bill.
 *     Credit a card or bank charge spends is HELD on the remittance while the
 *     money clears (applied on payment_intent.succeeded, given back on a
 *     failure) — never spent before the money arrives.
 *   - Paying now over a scheduled bank retry supersedes it: the retry's held
 *     credit is given back, its schedule cleared, and its intent canceled after
 *     commit (creditUse.supersedeScheduledRetry).
 *   - CREDIT ANOTHER PAYMENT STILL HOLDS IS LEFT ALONE (10/4). Part of a credit
 *     can be set aside by a bank retry on ANOTHER bill — the renewal hand-off
 *     moves a credit to the new lease while the old lease's retry still holds
 *     part of it. A charge on this bill does not replace that retry, so that
 *     part is not free: the plan uses only the credit that is free right now
 *     (what is left on it, plus what this bill's own retry holds, which paying
 *     now gives back), the rest of the bill is charged, and the held part waits
 *     for its payment to finish: when it clears, that credit pays the earlier
 *     bill; only if it finally fails does it come back to the account. The
 *     quote says so in plain words (creditWaitingNote), and the quote and the
 *     charge are the same plan (chargeCreditLines). It used to be a 409, which
 *     autopay counted as a failed month — no rent pulled and a late fee could
 *     follow. On one bill the rest of the credit on file is said too (fix pass
 *     3, creditRestNote): what another bank payment holds beyond this bill's
 *     part, what is kept for a bill on another lease, what stays for a later
 *     bill — every dollar of "You have $X credit" is explained.
 *   - A BILL WHOSE PAYMENT IS ALREADY ON ITS WAY GETS NO CREDIT SET ASIDE
 *     (decisions.md #46 1b). A scheduled bank retry pulls a fixed amount and
 *     never uses credit, so free credit goes to the bill being charged now —
 *     never left waiting for an older retrying bill while autopay pulls money.
 *     Among the other bills a general credit still goes oldest bill first.
 *     "Pay all" plays each lease through in charge order (planLeaseCharge
 *     `after`), so every lease is sent the figure its charge will find.
 *   - The processing fee is on the money part only: credit is not processed.
 *   - Bank payments are refused while the tenant is suspended under NACHA
 *     zero tolerance (tenants.ach_suspended_at).
 *
 * Unchanged rules this keeps:
 *
 * 1. PAY-AHEAD IS ALLOWED (Nic, S609 §8). Over-payment (without credit used)
 *    reaches the carried-forward balance first, then is banked as paid-ahead
 *    money GAM holds (the webhook banks remittance.unapplied_amount).
 *    UNDER-payment stays blocked and that IS a standing directive: a partial can
 *    reset a landlord's eviction clock.
 *
 * 2. THE SURPLUS IS NOT CAPPED (Nic, DIRECTIVE): "It shouldn't be the rest of
 *    their lease term specifically because a tenant that's getting billed
 *    utilities and stuff — they never know what it's gonna be until the meters
 *    are read... So let's just not put any cap on it, to eliminate those pinch
 *    points." Unused credit comes back at move-out through the deposit return.
 */

import type { PoolClient } from 'pg'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { sortForAllocation, paymentMethodCosts, formatCurrency, type PaymentMethodCost } from '@gam/shared'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'
import { computePlatformCut, createRentPlatformCharge } from './stripeConnect'
import { createAdminNotification } from './adminNotifications'
import { computeTenantGamOutstandingTotal } from './supersedence'
import { payableRowSql, lockHousehold } from './moneyPredicates'
import {
  householdQuote, holdCredit, settleFromCredit, supersedeScheduledRetry,
  cancelSupersededIntents, buildCreditPlan, paidAheadDrawnByMonth,
  HOUSEHOLD_MEMBER_STATUSES,
  type CreditPlanLine, type QuoteRow, type QuoteCredit, type ScheduledRetry, type HouseholdQuote, type LeaseQuote,
} from './creditUse'

export const CHARGE_SOURCES = ['portal', 'autopay', 'front_desk_reader'] as const
export type ChargeSource = typeof CHARGE_SOURCES[number]

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100
// The same figure format as the pay screen (formatCurrency: "$1,234.00"), so a
// sentence the server writes reads like the page around it.
const money = (c: number): string => formatCurrency(toDollars(c))

/**
 * 409: the payer answered "Use all $X" for a credit figure that is no longer
 * the one under the lock. Nothing was written or charged; the payer is asked
 * again with the figure it is now (`usableCredit`). Its own class so a caller
 * that quoted the figure itself a moment earlier (autopay) can re-quote once
 * instead of treating it as a failure.
 */
export class CreditChangedError extends AppError {
  readonly usableCredit: number
  constructor(usableCents: number) {
    super(409, `Your credit changed — it's now ${money(usableCents)}. Look at the bill again and choose how to pay.`)
    this.usableCredit = toDollars(usableCents)
  }
}

/** What the payer chose to do with the credit on the account. */
export interface CreditChoiceInput {
  /** true: "Use all $X"; false: "Save it for later". */
  use: boolean
  /** The usable credit the payer was shown. A different figure under the lock is a 409. */
  expected?: number | null
}

export interface ChargeLeaseBalanceInput {
  tenantId:          string
  /** The ONE lease this charge settles. Resolve it before calling.
   *  S616: omit it and pass serviceAgreementId instead for a payer who has no
   *  lease — the neighbor buying trash and electric. */
  leaseId?:          string
  serviceAgreementId?: string
  /** The money the payer chose to send (before any fee). Ignored with chargeEverything. */
  amount?:           number
  /** S654: absent for a card tapped on the counter reader — the reader is the method.
   *  Also absent for "Pay with credit — nothing charged": nothing is charged, so
   *  no method is read (fix pass 2). Required whenever money is charged. */
  paymentMethodId?:  string
  /** Absent only for "Pay with credit — nothing charged" (refused otherwise). */
  paymentMethodType?: 'ach' | 'card' | 'card_present'
  /** 'portal' = a human pressed Pay. 'autopay' = the scheduled runner. */
  source:            ChargeSource
  /**
   * S655: the payer's answer to "Use all $X / Save it for later". REQUIRED when
   * credit could pay part of this bill (422 otherwise); ignored when none can.
   */
  credit?:           CreditChoiceInput | null
  /**
   * S655 (counter reader): "also pay $X toward the old balance" — carried
   * arrears, paid last. Anything beyond the old balance becomes paid-ahead
   * money GAM holds. Only with chargeEverything.
   */
  towardOldBalance?: number | null
  /** S654: charge exactly what is owed now (less credit used, plus towardOldBalance). `amount` is ignored. */
  chargeEverything?: boolean
  /** S654: compute the quote (what the payer is charged, fee included) and write nothing. */
  dryRun?:           boolean
  /** S654: the reader already holds an authorization for exactly `amountCents`;
   *  book against it instead of creating a charge. 409 if the balance moved. */
  existingIntent?: { id: string; amountCents: number; capture?: boolean }
  /**
   * Fix pass (Step 8): one key per press of Pay, sent again only when the same
   * press is re-sent (a lost answer). Passed to Stripe scoped to this tenant
   * and this lease (or agreement), so Pay all may send one key for every
   * lease. A key Stripe has already seen is refused (409) — never a second
   * charge for one press. Ignored for the counter reader (its authorization
   * already exists).
   */
  idempotencyKey?:   string | null
  /**
   * decisions.md #48.4 (3-D Secure): the payer is on the tenant pay screen,
   * which can finish a card's confirmation on the spot. When the card's bank
   * asks the cardholder to confirm (Stripe 'requires_action'), the charge is
   * kept: its rows wait on it (the bill is held) and the result carries the
   * intent's clientSecret for the screen to confirm. Unconfirmed, it is
   * canceled and the bill released after CARD_CONFIRM_HOLD_MINUTES
   * (jobs/paymentReconcile releaseUnconfirmedCardCharges), or at once when the
   * screen reports the confirmation did not happen (POST
   * /payments/pay-balance/release). Only with source 'portal' and a card;
   * every other caller (the tenant assistant, which cannot show the bank's
   * window) gets the charge canceled and is told to pay on the Payments page.
   */
  confirmOnScreen?:  boolean
}

/** How long a card payment waiting on the cardholder's 3-D Secure confirmation holds the bill (decisions.md #48.4). */
export const CARD_CONFIRM_HOLD_MINUTES = 30

/**
 * A charge Stripe did not take or start — the card's bank wants the
 * cardholder to confirm it (3-D Secure, 'requires_action') where nobody can
 * (autopay, the assistant), or a bank account still needs verifying. The
 * charge is canceled, nothing is written, and the bill stays open to pay
 * another way. (On the pay screen a 3-D Secure charge is confirmed on the
 * spot instead — confirmOnScreen.)
 *
 * rawType/code mark it as the payment method's side for the autopay runner's
 * failure notice (classifyAutopayFailure reads Stripe's card-error shape), so
 * an autopay tenant is told to check their card, not that GAM broke.
 */
export class PaymentNotTakenError extends AppError {
  readonly rawType = 'card_error'
  readonly code = 'authentication_required'
  readonly intentStatus: string
  constructor(message: string, intentStatus: string) {
    super(402, message)
    this.intentStatus = intentStatus
  }
}

/** Statuses a new charge may be left in: taken, or on its way. Anything else is canceled. */
const CHARGE_STATUSES_KEPT = new Set(['succeeded', 'processing'])

function notTakenMessage(status: string, method: 'ach' | 'card' | 'card_present', source: ChargeSource): string {
  if (method === 'ach') {
    return 'This bank account still needs to be verified before it can be charged. Nothing was charged and the bill is still open — ' +
      'confirm the small deposit sent to the bank, or pay by card.'
  }
  if (status === 'requires_action') {
    return source === 'autopay'
      ? 'The card’s bank asked the cardholder to confirm this payment, which autopay cannot do. Nothing was charged and the bill is still open — ' +
        'pay it on the Payments page, where the bank can ask you to confirm it.'
      : 'Your card’s bank wants you to confirm this payment. Nothing was charged and your bill is still open — ' +
        'pay it on the Payments page, where you can confirm it, or pay with your bank account.'
  }
  return 'The card did not go through. Nothing was charged and the bill is still open — try another card or your bank account.'
}

/** Stripe refused an off-session card charge because the card's bank wants the cardholder to confirm it. */
function isAuthenticationRequired(e: any): boolean {
  const code = e?.code ?? e?.raw?.code
  return code === 'authentication_required'
    && (e?.type === 'StripeCardError' || e?.rawType === 'card_error' || e?.raw?.type === 'card_error')
}

/**
 * Cancel a charge Stripe did not take, for which nothing was written. A
 * cancel that fails puts it on the admin list to cancel by hand (no money
 * moved; it must never be completed).
 */
async function cancelNotTaken(paymentIntentId: string, status: string, tenantId: string, leaseId: string | null): Promise<void> {
  try {
    await getStripe().paymentIntents.cancel(paymentIntentId)
  } catch (cancelErr) {
    logger.error({ err: cancelErr, paymentIntentId, status },
      '[rent-charge] could not cancel a charge Stripe did not take')
    await createAdminNotification({
      severity: 'warn',
      category: 'rent_charge_not_canceled',
      title:    `Cancel Stripe charge ${paymentIntentId} by hand`,
      body:     `A balance charge came back '${status}' and nothing was recorded for it, but canceling it in Stripe failed. ` +
                'No money moved; cancel it in the Stripe dashboard so it can never be completed.',
      context:  { stripe_payment_intent_id: paymentIntentId, status, tenant_id: tenantId, lease_id: leaseId },
    }).catch(() => {})
  }
}

export interface ChargeLeaseBalanceResult {
  remittanceId:        string
  paymentIntentId:     string
  /** Stripe's status; 'quote' for a dry run; 'settled' when credit paid it all. */
  status:              string
  /** Dollars of MONEY that landed on open charges. */
  appliedTotal:        number
  /** Dollars banked as paid-ahead money for future months. */
  payAhead:            number
  platformCutAmount:   number
  /** S654: what the payer is actually charged — the money plus the fee they bear. */
  chargeAmount:        number
  /** S654: the processing fee on top (0 when the landlord covers it). */
  processingFee:       number
  /** Money per charge (rows credit paid whole carry no line). */
  lines:               { payment_id: string; amount_applied: number }[]
  /** S655: the lease's whole bill now (required + old balance), before credit. */
  outstanding:         number
  /** The pay-in-full set: everything owed now except the old balance. */
  requiredTotal:       number
  /** The old (carried-forward) balance: paid last, in any amount. */
  carriedTotal:        number
  /** Credit that may pay part of this bill (the "Use all $X" figure). */
  usableCredit:        number
  /** Credit this charge spends (0 when the payer saved it). */
  creditUsed:          number
  /** Back-compat name for creditUsed (the reader screen). */
  creditNetted:        number
  /** Money that goes to the old balance. */
  towardOldBalance:    number
  /** The usable credit covers the whole bill: "Pay with credit — nothing charged". */
  coversWholeBill:     boolean
  /** Nothing was charged: credit paid the whole bill. */
  paidWithCredit:      boolean
  /** GAM's own charges on this bill (paid online, never by credit). */
  gamTotal:            number
  /** Credit this bill could use that another bank payment still holds (left alone). */
  creditStillHeldElsewhere: number
  /** That, in plain words for the payer; null when nothing is waiting. */
  creditWaitingNote:   string | null
  /**
   * decisions.md #48.4: status 'requires_action' — the card's bank wants the
   * cardholder to confirm. The pay screen confirms with this (Stripe.js
   * handleNextAction). Absent otherwise.
   */
  clientSecret?:       string | null
  /** With clientSecret: when the held bill is released if nobody confirms (ISO). */
  confirmBy?:          string | null
}

/** The rows a lease balance is made of. */
export type BalanceScope =
  | { kind: 'lease'; leaseId: string }
  /** S616 (Nic): a payer with no lease at all — the neighbor buying trash and
   *  electric. "Their trash and electric needs to be on one bill if they have
   *  more than one utility through this subsystem." One agreement is one bill. */
  | { kind: 'service'; serviceAgreementId: string }

/**
 * The tenant's payable rows on a scope (their own rows only), oldest first.
 * Kept for the tests and tools that read it; the charge itself builds its rows
 * from the household quote (creditUse.householdQuote), which also takes a
 * co-tenant's rows on a shared lease (one household balance).
 */
export async function fetchOutstandingRows(tenantId: string, scope: BalanceScope | string) {
  const sc: BalanceScope = typeof scope === 'string' ? { kind: 'lease', leaseId: scope } : scope
  const scopeSql = sc.kind === 'lease'
    ? `(p.lease_id = $2 OR p.invoice_id IN (SELECT id FROM invoices WHERE lease_id = $2))`
    : `p.invoice_id IN (SELECT id FROM invoices WHERE service_agreement_id = $2)`
  const scopeId = sc.kind === 'lease' ? sc.leaseId : sc.serviceAgreementId
  return query<any>(
    `SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type,
            p.entry_description, p.invoice_id, p.lease_id, p.unit_id, p.landlord_id,
            u.property_id, u.payment_block
       FROM payments p
       JOIN units u ON u.id = p.unit_id
      WHERE p.tenant_id = $1
        -- S616: the balance is what is on the DOCUMENT — a converged invoice
        -- carries a neighbor landlord's utility rows that are not on the lease.
        AND ${scopeSql}
        -- S637 work-trade rows, a FlexPay pull and a retry in flight are not owed.
        AND ${payableRowSql('p')}
      ORDER BY p.due_date ASC, p.created_at ASC`,
    [tenantId, scopeId])
}

/**
 * A SUGGESTION for the pay screen — roughly what the rest of the lease term's
 * rent comes to. NOT a limit (Nic): nothing here is enforced, and a tenant may
 * pay any amount above their balance. Rent and recurring fees only — utilities
 * are unknowable until a meter is read. A month-to-month lease gets a
 * twelve-month horizon.
 */
export async function suggestedPayAheadFor(leaseId: string): Promise<number> {
  const row = await queryOne<{ rent: string; end_date: string | null; fees: string }>(
    `SELECT l.rent_amount::text AS rent,
            l.end_date::text    AS end_date,
            COALESCE((SELECT SUM(lf.amount) FROM lease_fees lf
                       WHERE lf.lease_id = l.id AND lf.due_timing = 'monthly_ongoing'), 0)::text AS fees
       FROM leases l WHERE l.id = $1`,
    [leaseId])
  if (!row) return 0
  const perMonth = Number(row.rent) + Number(row.fees)
  if (!(perMonth > 0)) return 0
  const MONTH_TO_MONTH_HORIZON = 12
  let months = MONTH_TO_MONTH_HORIZON
  if (row.end_date) {
    const now = new Date()
    const end = new Date(`${row.end_date}T00:00:00Z`)
    months = (end.getUTCFullYear() - now.getUTCFullYear()) * 12 + (end.getUTCMonth() - now.getUTCMonth())
    months = Math.max(0, Math.min(months, MONTH_TO_MONTH_HORIZON))
  }
  return Math.round(perMonth * months * 100) / 100
}

/**
 * Resolve the ONE lease a charge settles when the caller didn't name one.
 * Falls back to the tenant's single lease with something payable (the launch
 * norm) and refuses when they span several — each lease is its own charge and
 * its own receipt (S581), so the client must pick. A lease the tenant is on
 * counts when anything on it is payable (one household balance).
 */
export async function resolveTargetLease(tenantId: string, explicitLeaseId: string | null): Promise<string> {
  const outstanding = await query<{ lease_id: string }>(
    `SELECT DISTINCT p.lease_id
       FROM payments p
      WHERE p.lease_id IS NOT NULL
        AND (p.tenant_id = $1
             OR EXISTS (SELECT 1 FROM lease_tenants lt
                         WHERE lt.lease_id = p.lease_id AND lt.tenant_id = $1
                           AND lt.status IN ('active','pending_add','pending_remove')))
        AND ${payableRowSql('p')}`,
    [tenantId])
  if (outstanding.length === 0) throw new AppError(409, 'Nothing outstanding to pay')
  if (explicitLeaseId) {
    if (!outstanding.some(l => l.lease_id === explicitLeaseId)) {
      throw new AppError(409, 'That lease has nothing outstanding to pay')
    }
    return explicitLeaseId
  }
  if (outstanding.length === 1) return outstanding[0].lease_id
  throw new AppError(400, 'You have balances on more than one lease — pay each one separately.')
}

export const chargeLeaseBalanceSchema = z.object({
  amount:            z.number().nonnegative(),
  // Fix pass 2: optional so "Pay with credit — nothing charged" needs no bank
  // or card on file (it never reads them). chargeLeaseBalance refuses a money
  // charge without both, plainly, before anything is written.
  paymentMethodId:   z.string().min(1).optional(),
  paymentMethodType: z.enum(['ach', 'card']).optional(),
  serviceAgreementId: z.string().uuid().optional(),
  // S581 (Nic): ONE lease per charge. A tenant with two leases pays each as
  // its OWN charge with its OWN receipt: a bank shortfall fails only that
  // lease, the capped fee is charged per lease, and an eviction hold on one
  // landlord's lease never blocks paying another's. Omitted for the
  // single-lease case — the one outstanding lease is resolved automatically.
  leaseId:           z.string().uuid().optional(),
  // S655 (Nic, 10/2): the payer's answer to "Use all $X / Save it for later",
  // and the credit figure they were shown. Required whenever credit could pay
  // part of the bill; a moved figure is a 409 and the screen asks again.
  useCredit:         z.boolean().optional(),
  expectedCredit:    z.number().nonnegative().optional(),
  // Fix pass (Step 8): one key per press of Pay (see ChargeLeaseBalanceInput).
  idempotencyKey:    z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/,
    'idempotencyKey: letters, digits, - and _ only').optional(),
  // decisions.md #48.4: the pay screen can finish a card's 3-D Secure
  // confirmation on the spot (see ChargeLeaseBalanceInput.confirmOnScreen).
  confirmOnScreen:   z.boolean().optional(),
})

// ─── The plan: what this bill is, before anything is written ────────────────

/** One open charge as the charge path sees it. */
export interface ChargeRow {
  id: string
  amount: number
  type: string
  entryDescription: string
  dueDate: string
  createdAt: string
  invoiceId: string | null
  leaseId: string | null
  landlordId: string
  revenueOwner: string
  /** Credit already spent on this row (money owes only the rest). */
  appliedCredit: number
  carried: boolean
  retryScheduled: boolean
}

export interface LeaseChargePlan {
  scope: BalanceScope
  tenantId: string
  landlordId: string
  leaseId: string | null
  /** The pay-in-full set, in the one allocation order. */
  required: ChargeRow[]
  /** The old balance (carried forward), in allocation order. */
  carried: ChargeRow[]
  requiredTotal: number
  carriedTotal: number
  creditAlreadyApplied: number
  /** Credit that may pay part of this bill now (this lease's share of the household plan). */
  usableCredit: number
  /** Every dollar of credit the household has with this landlord. */
  creditOnFile: number
  /** The usable credit pays every required row in full. */
  coversWholeBill: boolean
  /** This lease's share of the household credit plan. */
  creditPlan: CreditPlanLine[]
  gamTotal: number
  neighborTotal: number
  inFlightTotal: number
  scheduledRetries: ScheduledRetry[]
  /** Rows of this bill with a scheduled bank retry (paying now supersedes them). */
  retryRowIds: string[]
  /**
   * Credit this bill would use but that a bank payment on ANOTHER bill still
   * holds (a scheduled retry, 10/4). Left out of usableCredit and creditPlan:
   * this charge does not replace that retry, so the part stays where it is
   * until that payment finishes, and the rest of the bill is charged.
   */
  creditStillHeldElsewhere: number
  /** creditStillHeldElsewhere in plain words for the payer; null when 0. */
  creditWaitingNote: string | null
  /**
   * The leases whose scheduled bank retry holds that waiting credit. Paying
   * one of them first replaces its retry and frees what it holds (so a "Pay
   * all" that pays those leases first may count it). Credit held by a payment
   * already on its way is not freed by paying anything and is not listed.
   */
  creditWaitingHeldBy: string[]
  /**
   * The rest of the credit on file — not usable on this bill and not waiting
   * on another bank payment — and where it goes (fix pass 3): kept for another
   * lease's bill (credit tied to another lease, or general credit that goes
   * first to an older bill there), or left on the account for a later bill
   * (more than this bill can take, the month's paid-ahead draw limit, a line
   * credit cannot pay). One bill only: 0 with `after` (a "Pay all" run).
   */
  creditKeptElsewhere: number
  creditKeptForLater: number
  /**
   * Credit another bill's bank payment holds beyond what this bill would use
   * (creditStillHeldElsewhere names only that part): set aside for that
   * payment all the same.
   */
  creditAlsoHeld: number
  /** Those three in plain words for the payer (creditRestSentence); null when all are 0. */
  creditRestNote: string | null
  /** Context for fees and guards. */
  ctx: ChargeContext
}

export interface ChargeContext {
  unitId: string | null
  propertyId: string | null
  paymentBlock: boolean
  stripeCustomerId: string | null
  achSuspended: boolean
  landlordUserId: string | null
  connectReady: boolean
  achFeePayer: string | null
  cardFeePayer: string | null
}

function fromQuoteRow(r: QuoteRow): ChargeRow {
  return {
    id: r.id, amount: r.amount, type: r.type, entryDescription: r.entryDescription,
    dueDate: r.dueDate, createdAt: r.createdAt, invoiceId: r.invoiceId, leaseId: r.leaseId,
    landlordId: r.landlordId, revenueOwner: r.revenueOwner, appliedCredit: r.appliedOnRow,
    carried: r.carried, retryScheduled: r.retryScheduled,
  }
}

function sortRows(rows: ChargeRow[]): ChargeRow[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  return sortForAllocation(rows.map(r => ({
    id: r.id, amount: r.amount, due_date: r.dueDate, type: r.type,
    entry_description: r.entryDescription, created_at: r.createdAt,
  }))).map(x => byId.get(x.id)!)
}

async function loadContext(client: PoolClient, a: { tenantId: string; landlordId: string; unitId: string | null }): Promise<ChargeContext> {
  const r = (await client.query<any>(
    `SELECT u.id AS unit_id, u.property_id, COALESCE(u.payment_block, FALSE) AS payment_block,
            t.stripe_customer_id, (t.ach_suspended_at IS NOT NULL) AS ach_suspended,
            l.user_id AS landlord_user_id,
            COALESCE(l.stripe_connect_account_id, lu.stripe_connect_account_id) AS connect_id,
            CASE WHEN l.stripe_connect_account_id IS NOT NULL THEN l.connect_charges_enabled   ELSE lu.connect_charges_enabled   END AS charges_enabled,
            CASE WHEN l.stripe_connect_account_id IS NOT NULL THEN l.connect_details_submitted ELSE lu.connect_details_submitted END AS details_submitted,
            par.ach_fee_payer, par.card_fee_payer
       FROM tenants t
       JOIN landlords l ON l.id = $2
       JOIN users lu ON lu.id = l.user_id
       LEFT JOIN units u ON u.id = $3
       LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
      WHERE t.id = $1`,
    [a.tenantId, a.landlordId, a.unitId])).rows[0]
  return {
    unitId: r?.unit_id ?? null,
    propertyId: r?.property_id ?? null,
    paymentBlock: r?.payment_block === true,
    stripeCustomerId: r?.stripe_customer_id ?? null,
    achSuspended: r?.ach_suspended === true,
    landlordUserId: r?.landlord_user_id ?? null,
    connectReady: !!r?.connect_id && r?.charges_enabled === true && r?.details_submitted === true,
    achFeePayer: r?.ach_fee_payer ?? null,
    cardFeePayer: r?.card_fee_payer ?? null,
  }
}

/**
 * What this bill is and what credit may pay part of it — the same figures the
 * pay screen shows (GET /payments/balance-context, POST /payments/quote), the
 * agent quotes and autopay charges. Read-only; with `lock` (inside a write,
 * after lockHousehold) the rows are locked FOR UPDATE.
 *
 * `after` (the pay screen's "Pay all" with "Use all", read-only quotes only):
 * the household leases charged EARLIER in the same run, in that order. The
 * plan is then this lease's charge as it will be when its turn comes — those
 * leases' rows claimed, their own retries replaced (what they held given
 * back) and the credit their charges use spent — so every lease in the run is
 * sent the credit figure its charge will find, and none is refused with "Your
 * credit changed". Never passed by a charge: a charge reads the bill as it is.
 */
export async function planLeaseCharge(
  client: PoolClient,
  opts: { tenantId: string; scope: BalanceScope; lock?: boolean; after?: readonly string[] },
): Promise<LeaseChargePlan> {
  const { tenantId, scope } = opts
  if (scope.kind === 'lease') {
    const lease = (await client.query<{ landlord_id: string; unit_id: string | null }>(
      `SELECT landlord_id, unit_id FROM leases WHERE id = $1`, [scope.leaseId])).rows[0]
    if (!lease) throw new AppError(404, 'Lease not found')
    const quote = await householdQuote(client, { tenantId, landlordId: lease.landlord_id, lock: opts.lock })
    const lq = quote.leases.find(l => l.leaseId === scope.leaseId)
    const rows = lq?.rows ?? []
    const required = sortRows(rows.filter(r => r.required).map(fromQuoteRow))
    const carried = sortRows(rows.filter(r => r.payable && r.carried).map(fromQuoteRow))

    // The credit this charge may use: the household's credit as THIS charge
    // finds it (chargeCreditLines). Leases charged earlier in a "Pay all" run
    // are played through first, in order.
    const st = await loadChargeCreditState(client, quote, tenantId)
    for (const id of opts.after ?? []) {
      if (id === scope.leaseId || !quote.leaseIds.includes(id) || st.charged.has(id)) continue
      markCharged(st, id, chargeCreditLines(st, id))
    }
    const creditPlan = lq ? chargeCreditLines(st, scope.leaseId) : []
    const usableCents = creditPlan.reduce((s, l) => s + toCents(l.amount), 0)
    const coversWholeBill = lq ? coversLeaseBill(lq, creditPlan) : false
    // Credit another bill's bank payment still holds: what this bill would
    // also use if every such hold were given back. The payer is told it in
    // plain words (creditWaitingSentence) — it is why only part of the credit
    // on file can pay this bill.
    const ifReleased = lq ? chargeCreditLines(st, scope.leaseId, { releaseAllHolds: true }) : []
    const waitingCents = Math.max(0, ifReleased.reduce((s, l) => s + toCents(l.amount), 0) - usableCents)
    const heldBy = waitingCents > 0 ? leasesHoldingCredit(st, scope.leaseId) : []
    // The rest of the credit on file, and where it goes — so every dollar the
    // payer is told they have is accounted for in plain words. One bill only:
    // in a "Pay all" run the rest includes what the earlier charges spend.
    const rest = lq && (opts.after ?? []).length === 0
      ? creditRest(st, scope.leaseId, { onFileCents: toCents(quote.totals.creditOnFile), usableCents, waitingCents })
      : { heldMoreCents: 0, elsewhereCents: 0, laterCents: 0 }
    const ctx = await loadContext(client, { tenantId, landlordId: lease.landlord_id, unitId: lease.unit_id })
    return {
      scope, tenantId, landlordId: lease.landlord_id, leaseId: scope.leaseId,
      required, carried,
      requiredTotal: lq?.requiredTotal ?? 0,
      carriedTotal: lq?.carriedTotal ?? 0,
      creditAlreadyApplied: lq?.creditAlreadyApplied ?? 0,
      usableCredit: toDollars(usableCents),
      creditOnFile: quote.totals.creditOnFile,
      coversWholeBill,
      creditPlan,
      gamTotal: lq?.gamTotal ?? 0,
      neighborTotal: lq?.neighborTotal ?? 0,
      inFlightTotal: lq?.inFlightTotal ?? 0,
      scheduledRetries: lq?.scheduledRetries ?? [],
      retryRowIds: rows.filter(r => r.payable && (r.retryScheduled || r.heldOnRow > 0)).map(r => r.id),
      creditStillHeldElsewhere: toDollars(waitingCents),
      creditWaitingNote: creditWaitingSentence(waitingCents),
      creditWaitingHeldBy: heldBy,
      creditKeptElsewhere: toDollars(rest.elsewhereCents),
      creditKeptForLater: toDollars(rest.laterCents),
      creditAlsoHeld: toDollars(rest.heldMoreCents),
      creditRestNote: creditRestSentence({ ...rest, waitingCents }),
      ctx,
    }
  }

  // A service agreement (no lease): its invoices' payable rows billed to this
  // payer. No credit pays them (credit pays only a lease's charges).
  const res = await client.query<any>(
    `SELECT p.id, p.amount::text AS amount, p.type, p.entry_description, p.due_date::text AS due_date,
            p.created_at, p.invoice_id, p.lease_id, p.landlord_id, p.revenue_owner, p.unit_id,
            (p.status = 'failed' AND p.next_retry_at IS NOT NULL) AS retry_scheduled
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
      WHERE i.service_agreement_id = $2 AND p.tenant_id = $1
        AND ${payableRowSql('p')}
      ORDER BY p.id
      ${opts.lock ? 'FOR UPDATE OF p' : ''}`,
    [tenantId, scope.serviceAgreementId])
  const agreement = (await client.query<{ landlord_id: string; unit_id: string }>(
    `SELECT landlord_id, unit_id FROM utility_service_agreements WHERE id = $1`, [scope.serviceAgreementId])).rows[0]
  const landlordId = agreement?.landlord_id ?? res.rows[0]?.landlord_id
  if (!landlordId) throw new AppError(404, 'Service agreement not found')
  const all: ChargeRow[] = res.rows.map((r: any) => ({
    id: r.id, amount: Number(r.amount), type: r.type, entryDescription: r.entry_description,
    dueDate: String(r.due_date).slice(0, 10), createdAt: new Date(r.created_at).toISOString(),
    invoiceId: r.invoice_id, leaseId: r.lease_id, landlordId: r.landlord_id, revenueOwner: r.revenue_owner,
    appliedCredit: 0, carried: r.type === 'carried_balance', retryScheduled: r.retry_scheduled === true,
  }))
  const required = sortRows(all.filter(r => !r.carried))
  const carried = sortRows(all.filter(r => r.carried))
  const sum = (xs: ChargeRow[]) => toDollars(xs.reduce((s, r) => s + toCents(r.amount), 0))
  const ctx = await loadContext(client, { tenantId, landlordId, unitId: agreement?.unit_id ?? res.rows[0]?.unit_id ?? null })
  return {
    scope, tenantId, landlordId, leaseId: null,
    required, carried,
    requiredTotal: sum(required), carriedTotal: sum(carried),
    creditAlreadyApplied: 0, usableCredit: 0, creditOnFile: 0, coversWholeBill: false,
    creditPlan: [], gamTotal: sum(required.filter(r => r.revenueOwner === 'gam')), neighborTotal: 0,
    inFlightTotal: 0, scheduledRetries: [],
    retryRowIds: all.filter(r => r.retryScheduled).map(r => r.id),
    creditStillHeldElsewhere: 0,
    creditWaitingNote: null,
    creditWaitingHeldBy: [],
    creditKeptElsewhere: 0,
    creditKeptForLater: 0,
    creditAlsoHeld: 0,
    creditRestNote: null,
    ctx,
  }
}

/**
 * The sentence the payer is shown when part of their credit is held by
 * another bank payment that has not finished. One wording, read by every
 * screen that quotes this plan and by the autopay notice. It must be true
 * whichever way that payment ends: when it clears, the held credit is SPENT on
 * that earlier bill (applyHeldForRemittance), so it never "becomes ready" for
 * this one; only when it finally fails does the credit come back to the
 * account (releaseHeldForRemittance). Never promise the payer that money.
 */
export function creditWaitingSentence(cents: number): string | null {
  if (!(cents > 0)) return null
  return `${money(cents)} of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.`
}

/**
 * Where the rest of the credit on file is, beside the waiting sentence (fix
 * pass 3): the payer is told "You have $100.00 credit. $30.00 of it can pay
 * this bill." and every other dollar is explained. One wording, read by the
 * pay screen and the agent's quote. Wording proposed for Nic's review.
 *
 *   heldMore — held by another bill's bank payment beyond what this bill would
 *              use. When the waiting sentence is said too (waiting > 0) it is
 *              "Another $X …"; else the waiting sentence's own words.
 *   elsewhere — kept for a bill on another lease.
 *   later — stays on the account for a later bill.
 */
export function creditRestSentence(a: {
  heldMoreCents?: number; elsewhereCents?: number; laterCents?: number; waitingCents?: number
}): string | null {
  const h = Math.max(0, Math.round(a.heldMoreCents ?? 0))
  const e = Math.max(0, Math.round(a.elsewhereCents ?? 0))
  const l = Math.max(0, Math.round(a.laterCents ?? 0))
  const parts: string[] = []
  if (h > 0) {
    parts.push((a.waitingCents ?? 0) > 0
      ? `Another ${money(h)} is set aside for an earlier bank payment the same way.`
      : creditWaitingSentence(h)!)
  }
  if (e > 0 && l > 0) {
    parts.push(`${money(e)} of your credit is kept for a bill on another lease, and ${money(l)} stays on your account for a later bill.`)
  } else if (e > 0) {
    parts.push(`${money(e)} of your credit is kept for a bill on another lease.`)
  } else if (l > 0) {
    parts.push(`${money(l)} of your credit stays on your account for a later bill.`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

// ─── The credit a charge finds ────────────────────────────────────────────────

/**
 * The household's credit as one charge sees it. Built from the household
 * quote (creditUse.householdQuote) plus, per credit, what each bill's bank
 * payment holds on it — so a "Pay all" run can be played through one lease at
 * a time (markCharged) exactly as the charges will find it.
 */
interface ChargeCreditState {
  tenantId: string
  /** Every row of the household quote (its leases' and the no-lease rows). */
  rows: QuoteRow[]
  caps: Map<string, number | null>
  tenantOnLease: Set<string>
  /** Paid-ahead drawn per lease and month as it stands, and as if that lease's own held credit were given back. */
  drawnStands: Map<string, number>
  drawnPaidNow: Map<string, number>
  credits: Map<string, {
    credit: QuoteCredit
    /** Free on the credit now (the quote's amountRemaining: any dispute's claim already off it). */
    freeCents: number
    /** Held on payable rows, per bill (scope lease; '' = a row outside this household's bills). */
    heldCents: Map<string, number>
    /**
     * The part of a dispute's claim that falls on held credit (readCredits
     * takes a claim from the free money first, then from the held part).
     */
    withheldFromHeldCents: number
  }>
  /** Leases already charged in this run (their rows are claimed). */
  charged: Set<string>
}

async function loadChargeCreditState(client: PoolClient, quote: HouseholdQuote, tenantId: string): Promise<ChargeCreditState> {
  const rows: QuoteRow[] = [...quote.leases.flatMap(l => l.rows), ...quote.noLeaseRows]
  const scopeOf = new Map(rows.map(r => [r.id, r.scopeLeaseId ?? '']))
  const ids = quote.credits.map(c => c.id)
  // The same held uses readCredits counts as releasable (on payable rows), by row.
  const held = ids.length === 0 ? [] : (await client.query<{ credit_id: string; payment_id: string; amount: string }>(
    `SELECT COALESCE(u.tenant_credit_id, u.prepaid_credit_id) AS credit_id, u.payment_id, SUM(u.amount)::text AS amount
       FROM credit_uses u
       JOIN payments p ON p.id = u.payment_id
      WHERE u.status = 'held'
        AND (u.tenant_credit_id = ANY($1::uuid[]) OR u.prepaid_credit_id = ANY($1::uuid[]))
        AND ${payableRowSql('p')}
      GROUP BY 1, 2`, [ids])).rows
  const credits: ChargeCreditState['credits'] = new Map()
  for (const c of quote.credits) {
    const heldCents = new Map<string, number>()
    let rawHeld = 0
    for (const h of held) {
      if (h.credit_id !== c.id) continue
      const k = scopeOf.get(h.payment_id) ?? ''
      heldCents.set(k, (heldCents.get(k) ?? 0) + toCents(h.amount))
      rawHeld += toCents(h.amount)
    }
    credits.set(c.id, {
      credit: c,
      freeCents: toCents(c.amountRemaining),
      heldCents,
      withheldFromHeldCents: Math.max(0, rawHeld - toCents(c.releasable)),
    })
  }
  const members = await client.query<{ lease_id: string }>(
    `SELECT DISTINCT lease_id FROM lease_tenants
      WHERE tenant_id = $1 AND lease_id = ANY($2::uuid[]) AND status = ANY($3::text[])`,
    [tenantId, quote.leaseIds, [...HOUSEHOLD_MEMBER_STATUSES]])
  return {
    tenantId,
    rows,
    caps: new Map(quote.leases.map(l => [l.leaseId, l.monthlyCap])),
    tenantOnLease: new Set(members.rows.map(m => m.lease_id)),
    drawnStands: await paidAheadDrawnByMonth(client, quote.leaseIds, false),
    drawnPaidNow: await paidAheadDrawnByMonth(client, quote.leaseIds, true),
    credits,
    charged: new Set(),
  }
}

/**
 * The credit lines a charge on ONE lease carries: the household plan's own
 * order (paid ahead, then lease-tied, then general credit; each oldest bill
 * first — creditUse.buildCreditPlan), with two rules for a charge:
 *
 *   - What is free for THIS charge: what is left on each credit, plus what
 *     this bill's own retry holds (paying now replaces that retry and gives it
 *     back first), less any dispute's claim on the credit — the claim comes off
 *     the free money first, exactly as the quote takes it. Credit another
 *     bill's bank payment holds stays where it is (creditStillHeldElsewhere).
 *     `releaseAllHolds` counts every hold as given back: only to say how much
 *     of the bill that held credit would have paid.
 *   - A bill whose payment is already on its way — a scheduled bank retry for
 *     a fixed amount — gets no credit set aside (decisions.md #46 1b). That
 *     retry never uses credit, so free credit goes to the bill being charged
 *     now. Bills of leases charged earlier in this run are claimed.
 *
 * Pure. Returns this lease's lines.
 */
function chargeCreditLines(st: ChargeCreditState, leaseId: string, o: { releaseAllHolds?: boolean } = {}): CreditPlanLine[] {
  return chargeCreditPlan(st, leaseId, o).filter(l => l.leaseId === leaseId)
}

/** chargeCreditLines before it keeps only this lease's lines: every lease's, as this charge sees the household. */
function chargeCreditPlan(st: ChargeCreditState, leaseId: string, o: { releaseAllHolds?: boolean } = {}): CreditPlanLine[] {
  const rows = st.rows.filter(r => {
    if (r.scopeLeaseId === leaseId) return true
    if (r.scopeLeaseId !== null && st.charged.has(r.scopeLeaseId)) return false
    return !(r.retryScheduled || toCents(r.heldOnRow) > 0)
  })
  const credits: QuoteCredit[] = [...st.credits.values()].map(s => {
    const heldNow = o.releaseAllHolds
      ? [...s.heldCents.values()].reduce((a, b) => a + b, 0)
      : (s.heldCents.get(leaseId) ?? 0)
    const free = Math.max(0, s.freeCents + Math.max(0, heldNow - s.withheldFromHeldCents))
    return { ...s.credit, amountRemaining: toDollars(free), releasable: 0 }
  })
  // Paid-ahead already drawn per month: this lease as paying now sees it (its
  // own retry's hold given back), every other lease as it stands.
  const own = (k: string) => k.startsWith(`${leaseId}|`)
  const drawn = new Map<string, number>()
  for (const [k, v] of st.drawnStands) if (!own(k)) drawn.set(k, v)
  for (const [k, v] of st.drawnPaidNow) if (own(k)) drawn.set(k, v)
  return buildCreditPlan({
    rows, credits, caps: st.caps, drawn,
    tenantId: st.tenantId, tenantOnLease: st.tenantOnLease,
    includeReleasable: true,
  })
}

/**
 * The rest of the credit on file — what this bill may not use and the
 * waiting figure does not already name — split by where it is, so the parts
 * add up to the credit on file:
 *
 *   - heldMore: held by another bill's bank payment beyond what this bill
 *     would use (the waiting figure names only that part);
 *   - elsewhere: free credit the household plan sends to another lease's bill
 *     (a general credit goes oldest bill first), plus what is left on a credit
 *     tied to another lease (it can pay only that lease's bills);
 *   - later: the rest of the free credit — more than this bill can take, the
 *     month's paid-ahead draw limit, a line credit cannot pay.
 *
 * Free is measured as this charge measures it (chargeCreditLines).
 */
function creditRest(
  st: ChargeCreditState, leaseId: string, a: { onFileCents: number; usableCents: number; waitingCents: number },
): { heldMoreCents: number; elsewhereCents: number; laterCents: number } {
  const lines = chargeCreditPlan(st, leaseId)
  const used = new Map<string, number>()
  let otherBills = 0
  for (const l of lines) {
    used.set(l.creditId, (used.get(l.creditId) ?? 0) + toCents(l.amount))
    if (l.leaseId !== leaseId) otherBills += toCents(l.amount)
  }
  let freeTotal = 0
  let tiedLeft = 0
  for (const s of st.credits.values()) {
    const free = Math.max(0, s.freeCents + Math.max(0, (s.heldCents.get(leaseId) ?? 0) - s.withheldFromHeldCents))
    freeTotal += free
    if (s.credit.leaseId !== null && s.credit.leaseId !== leaseId) tiedLeft += Math.max(0, free - (used.get(s.credit.id) ?? 0))
  }
  const heldOther = Math.max(0, a.onFileCents - freeTotal)
  const heldMoreCents = Math.max(0, heldOther - a.waitingCents)
  const freeRest = Math.max(0, Math.min(freeTotal, a.onFileCents - heldOther) - a.usableCents)
  const elsewhereCents = Math.min(freeRest, otherBills + tiedLeft)
  return { heldMoreCents, elsewhereCents, laterCents: freeRest - elsewhereCents }
}

/**
 * Play one lease's charge through the state ("Pay all"): its own retries are
 * replaced (what they held comes back to the credit, a dispute's claim
 * taken from it first), the credit its lines use is spent, and its rows are
 * claimed. Mirrors what chargeLeaseBalance writes, so the next lease's plan is
 * the one its charge will find.
 */
function markCharged(st: ChargeCreditState, leaseId: string, lines: readonly CreditPlanLine[]): void {
  for (const s of st.credits.values()) {
    const ownHeld = s.heldCents.get(leaseId) ?? 0
    if (ownHeld <= 0) continue
    s.freeCents += Math.max(0, ownHeld - s.withheldFromHeldCents)
    s.withheldFromHeldCents = Math.max(0, s.withheldFromHeldCents - ownHeld)
    s.heldCents.delete(leaseId)
  }
  for (const l of lines) {
    const s = st.credits.get(l.creditId)
    if (s) s.freeCents = Math.max(0, s.freeCents - toCents(l.amount))
  }
  st.charged.add(leaseId)
}

/**
 * The state as it would be if every bank payment's hold were given back: what
 * each credit holds becomes free (less any dispute's claim on it). Only to say
 * how much of a run that held credit would have paid. A copy; `st` is untouched.
 */
function releasedState(st: ChargeCreditState): ChargeCreditState {
  const credits: ChargeCreditState['credits'] = new Map()
  for (const [id, s] of st.credits) {
    const held = [...s.heldCents.values()].reduce((a, b) => a + b, 0)
    credits.set(id, {
      credit: s.credit,
      freeCents: s.freeCents + Math.max(0, held - s.withheldFromHeldCents),
      heldCents: new Map(),
      withheldFromHeldCents: 0,
    })
  }
  return { ...st, credits, charged: new Set(st.charged) }
}

/**
 * Play a run through the state (as planLeaseCharge `after` does); the credit
 * the run uses, in cents. A lease in `noCredit` is charged with its credit
 * saved: it replaces its own retry and claims its rows, and spends nothing.
 */
function playRun(st: ChargeCreditState, leaseIds: readonly string[], noCredit: ReadonlySet<string> = new Set()): number {
  let used = 0
  for (const id of leaseIds) {
    if (st.charged.has(id)) continue
    const lines = noCredit.has(id) ? [] : chargeCreditLines(st, id)
    used += lines.reduce((s, l) => s + toCents(l.amount), 0)
    markCharged(st, id, lines)
  }
  return used
}

/**
 * "Pay all" with "Use all": the credit ANOTHER bank payment still holds that
 * the whole run would have used — ONE figure for the run (fix pass 2).
 *
 * Each bill's own creditStillHeldElsewhere is right for that bill alone, but a
 * hold that belongs to a lease outside the run (a paused lease whose bank
 * retry still holds the credit) is the same dollars on every bill of the run,
 * so adding the bills' figures up said "$100 set aside" with $50 on file. The
 * run is played through twice — as it is, and with every hold given back — and
 * the difference in the credit the run uses is the figure. A hold the run's
 * own earlier charge replaces is freed in both plays, so it is never said.
 * Per landlord (credit pays only that landlord's bills); `order` is the run's
 * charge order (balance-context payAll.order). Read-only.
 */
export async function payAllRunCreditWaiting(
  client: PoolClient,
  /** `noCredit`: leases of the run charged with the credit saved (autopay with "use my credit first" off). */
  opts: { tenantId: string; order: readonly string[]; noCredit?: readonly string[] },
): Promise<number> {
  if (opts.order.length === 0) return 0
  const owners = (await client.query<{ id: string; landlord_id: string }>(
    `SELECT id, landlord_id FROM leases WHERE id = ANY($1::uuid[])`, [[...opts.order]])).rows
  const landlordOf = new Map(owners.map(o => [o.id, o.landlord_id]))
  const landlords = [...new Set(opts.order.map(id => landlordOf.get(id)).filter((x): x is string => !!x))]
  let waitingCents = 0
  for (const landlordId of landlords) {
    const quote = await householdQuote(client, { tenantId: opts.tenantId, landlordId })
    const run = opts.order.filter(id => landlordOf.get(id) === landlordId && quote.leaseIds.includes(id))
    if (run.length === 0) continue
    const st = await loadChargeCreditState(client, quote, opts.tenantId)
    const released = releasedState(st)
    const noCredit = new Set(opts.noCredit ?? [])
    waitingCents += Math.max(0, playRun(released, run, noCredit) - playRun(st, run, noCredit))
  }
  return toDollars(waitingCents)
}

/**
 * "Pay all" (fix for the autopaycredit2 review, problem 3): the credit on file
 * for the run's landlords and where every dollar of it goes, as ONE set of
 * figures for the whole run — so the Pay all box can say "You have $X credit.
 * $Y of it can pay these bills." and explain the rest, the same way one bill's
 * box does (creditRest), and agree with the Account credit card above it.
 *
 *   usable    — what the run's charges use, played through in `order`;
 *   waiting   — held by another bank payment that the run would have used
 *               (payAllRunCreditWaiting's figure);
 *   heldMore  — held by another bank payment beyond that;
 *   elsewhere — free credit the household plan sends to a lease outside the
 *               run, plus what is left on a credit tied to such a lease;
 *   later     — the rest of the free credit (more than these bills can take,
 *               the month's paid-ahead draw limit, a line credit cannot pay).
 *
 * The parts add up to onFile. Per landlord (credit pays only that landlord's
 * bills), then added up. Read-only.
 */
export async function payAllRunCreditRest(
  client: PoolClient, opts: { tenantId: string; order: readonly string[] },
): Promise<{
  onFile: number; usable: number; waiting: number
  heldMore: number; elsewhere: number; later: number; note: string | null
}> {
  const zero = { onFile: 0, usable: 0, waiting: 0, heldMore: 0, elsewhere: 0, later: 0, note: null }
  if (opts.order.length === 0) return zero
  const owners = (await client.query<{ id: string; landlord_id: string }>(
    `SELECT id, landlord_id FROM leases WHERE id = ANY($1::uuid[])`, [[...opts.order]])).rows
  const landlordOf = new Map(owners.map(o => [o.id, o.landlord_id]))
  const landlords = [...new Set(opts.order.map(id => landlordOf.get(id)).filter((x): x is string => !!x))]
  const c = { onFile: 0, usable: 0, waiting: 0, heldMore: 0, elsewhere: 0, later: 0 }
  for (const landlordId of landlords) {
    const quote = await householdQuote(client, { tenantId: opts.tenantId, landlordId })
    const run = opts.order.filter(id => landlordOf.get(id) === landlordId && quote.leaseIds.includes(id))
    if (run.length === 0) continue
    const onFile = toCents(quote.totals.creditOnFile)
    const st = await loadChargeCreditState(client, quote, opts.tenantId)
    const usedIfReleased = playRun(releasedState(st), run)
    const usable = playRun(st, run)
    const waiting = Math.max(0, usedIfReleased - usable)
    // After the run: what is free on each credit (the run's own retries given
    // back, what its charges use spent).
    let freeLeft = 0
    for (const x of st.credits.values()) freeLeft += Math.max(0, x.freeCents)
    const heldOther = Math.max(0, onFile - (usable + freeLeft))
    const heldMore = Math.max(0, heldOther - waiting)
    const freeRest = Math.max(0, Math.min(freeLeft, onFile - heldOther - usable))
    // Where the household plan sends the free credit now: the bills of the
    // leases outside the run, and credits tied to those leases.
    const runSet = new Set(run)
    const lines = chargeCreditPlan(st, '').filter(l => !runSet.has(l.leaseId))
    const used = new Map<string, number>()
    let otherBills = 0
    for (const l of lines) {
      used.set(l.creditId, (used.get(l.creditId) ?? 0) + toCents(l.amount))
      otherBills += toCents(l.amount)
    }
    let tiedLeft = 0
    for (const x of st.credits.values()) {
      if (x.credit.leaseId !== null && !runSet.has(x.credit.leaseId)) {
        tiedLeft += Math.max(0, Math.max(0, x.freeCents) - (used.get(x.credit.id) ?? 0))
      }
    }
    const elsewhere = Math.min(freeRest, otherBills + tiedLeft)
    c.onFile += onFile; c.usable += usable; c.waiting += waiting
    c.heldMore += heldMore; c.elsewhere += elsewhere; c.later += freeRest - elsewhere
  }
  return {
    onFile: toDollars(c.onFile), usable: toDollars(c.usable), waiting: toDollars(c.waiting),
    heldMore: toDollars(c.heldMore), elsewhere: toDollars(c.elsewhere), later: toDollars(c.later),
    note: creditRestSentence({ heldMoreCents: c.heldMore, elsewhereCents: c.elsewhere, laterCents: c.later, waitingCents: c.waiting }),
  }
}

/** The other leases whose bank payments hold part of the household's credit. */
function leasesHoldingCredit(st: ChargeCreditState, leaseId: string): string[] {
  const out = new Set<string>()
  for (const s of st.credits.values()) {
    for (const [k, v] of s.heldCents) if (v > 0 && k !== '' && k !== leaseId) out.add(k)
  }
  return [...out].sort()
}

/** The lines pay every required row of the lease in full (with credit already on them). */
function coversLeaseBill(lq: LeaseQuote, lines: readonly CreditPlanLine[]): boolean {
  const covered = new Map<string, number>()
  for (const l of lines) covered.set(l.paymentId, (covered.get(l.paymentId) ?? 0) + toCents(l.amount))
  const required = lq.rows.filter(r => r.required)
  return required.length > 0
    && required.every(r => r.creditEligible && (covered.get(r.id) ?? 0) + toCents(r.appliedOnRow) === toCents(r.amount))
}

/** How money and credit land on a plan's rows. Pure. */
export interface MoneyLanding {
  creditUsedCents: number
  /** What must be paid now in money: the required rows less credit (already spent and chosen). */
  dueCents: number
  /** Money that reaches the old balance. */
  toCarriedCents: number
  /** Money beyond the bill and the old balance (banked as paid-ahead money). */
  surplusCents: number
  /** Money per row (> 0 only). */
  lines: { paymentId: string; cents: number }[]
  /** Every row this payment covers (stamped with the charge). */
  coveredIds: string[]
  /** A carried row paid in part: it is cut into the paid slice and an open remainder (S622). */
  partialCarried: { id: string; appliedCents: number; remainderCents: number } | null
}

export function landMoney(plan: LeaseChargePlan, a: { useCredit: boolean; moneyCents: number }): MoneyLanding {
  const planned = new Map<string, number>()
  if (a.useCredit) for (const l of plan.creditPlan) planned.set(l.paymentId, (planned.get(l.paymentId) ?? 0) + toCents(l.amount))
  const creditUsedCents = a.useCredit ? plan.creditPlan.reduce((s, l) => s + toCents(l.amount), 0) : 0
  const lines: MoneyLanding['lines'] = []
  let dueCents = 0
  for (const r of plan.required) {
    const m = Math.max(0, toCents(r.amount) - toCents(r.appliedCredit) - (planned.get(r.id) ?? 0))
    dueCents += m
    if (m > 0) lines.push({ paymentId: r.id, cents: m })
  }
  const coveredIds = plan.required.map(r => r.id)
  let over = Math.max(0, a.moneyCents - dueCents)
  let toCarriedCents = 0
  let partialCarried: MoneyLanding['partialCarried'] = null
  for (const r of plan.carried) {
    if (over <= 0) break
    const owed = toCents(r.amount) - toCents(r.appliedCredit)
    if (owed <= 0) continue
    const take = Math.min(over, owed)
    lines.push({ paymentId: r.id, cents: take })
    coveredIds.push(r.id)
    toCarriedCents += take
    over -= take
    if (take < owed) partialCarried = { id: r.id, appliedCents: take, remainderCents: owed - take }
  }
  return { creditUsedCents, dueCents, toCarriedCents, surplusCents: over, lines, coveredIds, partialCarried }
}

/**
 * The read-only quote every screen and the autopay runner use.
 * `afterLeaseIds`: "Pay all" with "Use all" — the leases charged earlier in
 * the same run, in order (planLeaseCharge `after`). Leave it out for one bill.
 */
export async function quoteLeaseCharge(opts: {
  tenantId: string; leaseId?: string; serviceAgreementId?: string
  useCredit?: boolean; paymentMethodType: 'ach' | 'card' | 'card_present'
  towardOldBalance?: number | null
  afterLeaseIds?: readonly string[]
}): Promise<LeaseChargePlan & { landing: MoneyLanding; fee: number; passthrough: number; total: number }> {
  const scope: BalanceScope = opts.leaseId ? { kind: 'lease', leaseId: opts.leaseId }
    : { kind: 'service', serviceAgreementId: opts.serviceAgreementId! }
  const client = await getClient()
  try {
    const plan = await planLeaseCharge(client, { tenantId: opts.tenantId, scope, after: opts.afterLeaseIds })
    const useCredit = opts.useCredit === true && plan.usableCredit > 0
    const base = landMoney(plan, { useCredit, moneyCents: 0 })
    const moneyCents = base.dueCents + Math.max(0, toCents(opts.towardOldBalance ?? 0))
    const landing = landMoney(plan, { useCredit, moneyCents })
    // The charge adds the tenant-payer platform fee on top of any payment with
    // money in it (never one the credit pays whole), so the quote does too —
    // the figure read back is the figure charged.
    const passthrough = moneyCents > 0
      ? (await unpaidTenantPassthrough(client, plan.ctx.propertyId, { lock: false })).amount : 0
    const fee = Math.round(
      (feeFor(plan.ctx, opts.paymentMethodType, toDollars(moneyCents), null).tenantBorne + passthrough) * 100) / 100
    return { ...plan, landing, fee, passthrough, total: toDollars(moneyCents + toCents(fee)) }
  } finally {
    client.release()
  }
}

/**
 * S562: the tenant-payer platform fee the next charge at this property adds on
 * top (platform_fee_accruals not yet charged to a tenant). One reader for the
 * charge (locked, inside its transaction: two tenants paying at once at the
 * same property must not both be charged the same accrual) and for every quote
 * of it (unlocked), so the two cannot differ.
 */
async function unpaidTenantPassthrough(
  client: PoolClient, propertyId: string | null, opts: { lock: boolean },
): Promise<{ ids: string[]; amount: number }> {
  if (!propertyId) return { ids: [], amount: 0 }
  const rows = (await client.query<{ id: string; total_amount: string }>(
    `SELECT id, total_amount FROM platform_fee_accruals
      WHERE property_id = $1 AND payer = 'tenant'
        AND tenant_charge_id IS NULL AND total_amount > 0
      ORDER BY id
      ${opts.lock ? 'FOR UPDATE' : ''}`,
    [propertyId])).rows
  const cents = rows.reduce((sum, r) => sum + toCents(r.total_amount), 0)
  return { ids: rows.map(r => r.id), amount: toDollars(cents) }
}

/**
 * Every way to pay `amount` of a lease's bill, priced exactly as the charge
 * prices it: the processing fee only when this property's tenant pays it (the
 * same rule feeFor applies at the charge), the tenant-payer platform fee on top
 * of any payment with money in it, and cash, check or money order free.
 */
export function billMethodCosts(
  ctx: Pick<ChargeContext, 'achFeePayer' | 'cardFeePayer'>, amount: number, passthrough: number,
): PaymentMethodCost[] {
  return paymentMethodCosts(amount).map((c) => {
    if (c.method === 'manual') return c
    const fee = amount > 0
      ? Math.round((feeFor(ctx, c.method, amount, null).tenantBorne + passthrough) * 100) / 100
      : 0
    return { ...c, fee, total: Math.round((amount + fee) * 100) / 100 }
  })
}

/** The tenant-payer platform fee a charge at this property would add now. */
export async function tenantPassthroughFor(propertyId: string | null, client?: PoolClient): Promise<number> {
  if (!propertyId) return 0
  if (client) return (await unpaidTenantPassthrough(client, propertyId, { lock: false })).amount
  const own = await getClient()
  try {
    return (await unpaidTenantPassthrough(own, propertyId, { lock: false })).amount
  } finally {
    own.release()
  }
}

function feeFor(
  ctx: Pick<ChargeContext, 'achFeePayer' | 'cardFeePayer'>, method: 'ach' | 'card' | 'card_present',
  amount: number, cardCountry: string | null,
) {
  // S654: a card is a card — the counter reader prices like the portal.
  const base = amount > 0 ? computePlatformCut({ amount, paymentMethod: method === 'ach' ? 'ach' : 'card', cardCountry }) : 0
  const payer = method === 'ach' ? ctx.achFeePayer : ctx.cardFeePayer
  // Mirror allocation.ts exactly: only 'landlord' moves the fee off the tenant.
  const tenantPays = payer !== 'landlord'
  return { base, tenantBorne: Math.round((tenantPays ? base : 0) * 100) / 100 }
}

// ─── The charge ──────────────────────────────────────────────────────────────

export async function chargeLeaseBalance(input: ChargeLeaseBalanceInput): Promise<ChargeLeaseBalanceResult> {
  const { tenantId, leaseId, serviceAgreementId, paymentMethodId, paymentMethodType } = input
  if (!leaseId && !serviceAgreementId) {
    throw new AppError(400, 'A balance needs either a lease or a service agreement to settle.')
  }
  const scope: BalanceScope = leaseId ? { kind: 'lease', leaseId } : { kind: 'service', serviceAgreementId: serviceAgreementId! }
  const client = await getClient()
  let began = false
  try {
    let cancelAfterCommit: string[] = []
    if (!input.dryRun) {
      await client.query('BEGIN')
      began = true
      // The household first, then every row by id (§1.5). A co-tenant, the
      // desk, a webhook or a second tab paying the same bill waits here.
      const landlordId = scope.kind === 'lease'
        ? (await client.query<{ landlord_id: string }>(`SELECT landlord_id FROM leases WHERE id = $1`, [scope.leaseId])).rows[0]?.landlord_id
        : (await client.query<{ landlord_id: string }>(`SELECT landlord_id FROM utility_service_agreements WHERE id = $1`, [scope.serviceAgreementId])).rows[0]?.landlord_id
      if (!landlordId) throw new AppError(404, scope.kind === 'lease' ? 'Lease not found' : 'Service agreement not found')
      await lockHousehold(client, tenantId, landlordId)
      // The counter reader: a capture that waited here behind a first click
      // on the same card finds that click's receipt — never a second booking
      // against one authorization.
      if (input.existingIntent) {
        const booked = await client.query(
          `SELECT 1 FROM tenant_remittances WHERE stripe_payment_intent_id = $1 LIMIT 1`, [input.existingIntent.id])
        if (booked.rows.length > 0) throw new AppError(409, 'This card payment is already recorded.')
      }
      // Paying now over a scheduled bank retry replaces it: its held credit
      // comes back first, so the payer may spend it (and is quoted as if so).
      const pre = await planLeaseCharge(client, { tenantId, scope, lock: true })
      if (pre.retryRowIds.length > 0) {
        cancelAfterCommit = (await supersedeScheduledRetry(client, pre.retryRowIds)).cancelAfterCommit
      }
    }
    const plan = await planLeaseCharge(client, { tenantId, scope, lock: !input.dryRun })
    const ctx = plan.ctx
    if (plan.required.length === 0 && plan.carried.length === 0) throw new AppError(409, 'Nothing outstanding to pay')
    if (ctx.paymentBlock) {
      throw new AppError(409, 'This unit is in eviction mode — payments to the landlord are paused. Accepting one could reset the eviction timeline. Contact the landlord.')
    }

    // ── The credit choice (Nic, 10/2) ───────────────────────────────────────
    const usableCents = toCents(plan.usableCredit)
    let useCredit = false
    if (usableCents > 0) {
      // A quote may be asked before the payer has chosen (it shows both
      // figures); a payment may not.
      if (!input.credit && !input.dryRun) {
        throw new AppError(422,
          `You have ${money(usableCents)} of account credit. Choose "Use all ${money(usableCents)}" or "Save it for later" before paying.`)
      }
      // A payment carries the credit figure the payer was shown, so a credit
      // that moved since their screen loaded is caught (shelved 8).
      if (input.credit && input.credit.expected == null && !input.dryRun) {
        throw new AppError(422,
          `Send the credit figure the payer was shown with their answer — it is ${money(usableCents)} now.`)
      }
      useCredit = input.credit?.use === true
      // Only an answer to USE the credit depends on the figure: "Save it for
      // later" charges the whole bill whatever the credit is, so a figure that
      // moved since (Pay all: once one lease's rows are claimed, a general
      // credit's share of the next lease grows) refuses nothing.
      if (useCredit && input.credit?.expected != null && toCents(input.credit.expected) !== usableCents) {
        throw new CreditChangedError(usableCents)
      }
      // Credit another bank payment still holds is not in usableCredit or the
      // plan (planLeaseCharge): it is left alone and the rest is charged.
    } else if (input.credit?.use && input.credit.expected != null && toCents(input.credit.expected) > 0) {
      throw new CreditChangedError(0)
    }

    const base = landMoney(plan, { useCredit, moneyCents: 0 })
    const towardOld = Math.max(0, toCents(input.towardOldBalance ?? 0))
    if (towardOld > 0 && !input.chargeEverything) {
      throw new AppError(400, 'towardOldBalance goes with chargeEverything (the counter reader).')
    }
    const moneyCents = input.chargeEverything
      ? base.dueCents + towardOld
      : toCents(input.amount ?? 0)
    const land = landMoney(plan, { useCredit, moneyCents })
    const requiredGross = plan.required.reduce((s, r) => s + toCents(r.amount), 0)

    // ── "Pay with credit — nothing charged" ─────────────────────────────────
    // Before the payment-method checks: nothing is charged, so a payer with no
    // card or bank on file, or whose bank payments are paused, may still pay
    // a bill their credit covers in full.
    if (useCredit && land.dueCents === 0 && moneyCents === 0 && plan.required.length > 0) {
      if (input.dryRun) {
        return quoteResult(plan, land, { moneyCents: 0, fee: 0, base: 0, status: 'quote', paidWithCredit: false })
      }
      // The counter reader holds a card authorization for an amount the bill
      // no longer needs (a late fee waived while the card was on the reader).
      // Settling from credit here would leave that hold on the card and tell
      // the desk the card was captured: refuse, so the hold is released and
      // the desk looks at the bill again.
      if (input.existingIntent) {
        throw new AppError(409, 'The credit now covers this whole bill, so nothing goes on the card.')
      }
      // Credit pays only a lease's own charges (a service agreement has no
      // usable credit, so this cannot be reached for one — refused, never
      // reported as paid).
      if (scope.kind !== 'lease') throw new AppError(409, 'There is no credit on this account that can pay this bill.')
      // Exactly the lines this charge quoted (chargeCreditLines), under the
      // same lock, recorded as the payer's own source (portal, autopay).
      const settled = await settleFromCredit(client, {
        leaseId: scope.leaseId, tenantId, source: input.source,
        expectedCredit: input.credit?.expected ?? undefined,
        lines: plan.creditPlan,
      })
      await client.query('COMMIT')
      began = false
      await settled.afterCommit()
      await cancelSupersededIntents(cancelAfterCommit)
      return {
        ...quoteResult(plan, land, { moneyCents: 0, fee: 0, base: 0, status: 'settled', paidWithCredit: true }),
        creditUsed: settled.creditUsed, creditNetted: settled.creditUsed,
      }
    }

    // ── The payment method (money is charged from here on) ──────────────────
    // A charge with money in it names how it is paid. Only "Pay with credit —
    // nothing charged" (above) may leave it out.
    if (!paymentMethodType || (paymentMethodType !== 'card_present' && !paymentMethodId && !input.dryRun && !input.existingIntent)) {
      throw new AppError(422, 'Choose a saved bank account or card to pay with.')
    }
    if (!ctx.stripeCustomerId && paymentMethodType !== 'card_present') {
      throw new AppError(409, 'Tenant has no Stripe customer — complete ACH setup first')
    }
    if (paymentMethodType === 'ach' && ctx.achSuspended) {
      throw new AppError(409, 'Bank payments are paused on this account after a bank return. Pay by card, or contact your landlord.')
    }

    // ── Pay in full (Nic, standing directive) ───────────────────────────────
    if (moneyCents < land.dueCents) {
      const extra = plan.carriedTotal > 0
        ? ` Your carried balance of ${money(toCents(plan.carriedTotal))} can be paid down separately, in any amount.`
        : ''
      throw new AppError(422, `Rent must be paid in full — the outstanding balance is ${money(land.dueCents)}.${extra}`)
    }
    if (moneyCents <= 0 && !input.dryRun) throw new AppError(422, 'There is nothing to charge.')
    // S655: with credit used, the money is exactly what is left of the bill —
    // credit is never spent while new money is banked as credit beside it.
    // Autopay is always exact: it pays the bill, never ahead and never the old
    // balance. The reader may add the old balance on purpose (towardOldBalance).
    const exact = (useCredit && input.source !== 'front_desk_reader') || input.source === 'autopay'
    if (exact && moneyCents !== land.dueCents) {
      throw new AppError(422, useCredit
        ? `With your credit used, the payment is exactly ${money(land.dueCents)}.`
        : `Autopay pays exactly the bill: ${money(land.dueCents)}.`)
    }
    if (useCredit && land.surplusCents > 0) {
      throw new AppError(422, `With credit used, ${money(land.surplusCents)} more than the bill and the old balance cannot be taken. Lower the old-balance amount.`)
    }

    // S622 (Nic): CURRENT CHARGES COME FIRST, ACROSS THE LANDLORD'S LEASES —
    // "they couldn't just pay eight hundred dollars on space b while leaving
    // the five hundred dollar lease open." Same landlord only; leases in
    // eviction hold are skipped (a floor must always be clearable). Reads
    // across leases; the money still lands only on THIS bill.
    if (land.toCarriedCents > 0 && plan.leaseId) {
      const blockers = await client.query<{ unit_number: string; owed: string }>(
        `SELECT u.unit_number, SUM(p.amount)::text AS owed
           FROM payments p
           JOIN units u ON u.id = p.unit_id
          WHERE p.tenant_id = $1 AND p.lease_id <> $2 AND p.landlord_id = $3
            AND p.type <> 'carried_balance'
            AND u.payment_block IS NOT TRUE
            AND ${payableRowSql('p')}
          GROUP BY u.unit_number
          ORDER BY u.unit_number`,
        [tenantId, plan.leaseId, plan.landlordId])
      if (blockers.rows.length > 0) {
        const list = blockers.rows.map(b => `${b.unit_number} (${money(toCents(b.owed))})`).join(', ')
        throw new AppError(422,
          `Bring your other rent current first — ${list} still owes for this period. ` +
          `You can pay ${money(land.dueCents)} here now; once every space is current you can put ` +
          `whatever you like toward your earlier balance.`)
      }
    }

    // Only a card needs the SDK here (issuing country for the non-US surcharge).
    let cardCountry: string | null = null
    if (paymentMethodType === 'card' && paymentMethodId && !input.dryRun) {
      const pm = await getStripe().paymentMethods.retrieve(paymentMethodId)
      cardCountry = pm.card?.country ?? null
    }
    // The fee is on the MONEY — every dollar Stripe processes, surplus
    // included, and nothing credit paid (credit is not processed).
    const amount = toDollars(moneyCents)
    const fees = feeFor(ctx, paymentMethodType, amount, cardCountry)

    // Tenant-payer platform fee passthrough. Read and locked inside the charge's
    // transaction: two tenants paying at once at the same property must not
    // both be charged the same accrual (the second waits, then finds it taken).
    const unpaidAccruals = await unpaidTenantPassthrough(client, ctx.propertyId, { lock: !input.dryRun })
    const passthroughAmount = unpaidAccruals.amount
    const tenantBorneOnTop = Math.round((fees.tenantBorne + passthroughAmount) * 100) / 100
    const chargeAmount = Math.round((amount + tenantBorneOnTop) * 100) / 100

    // S581: sublease markup per covered rent month (credit-paid rent included:
    // the month is covered either way), stamped so allocation nets it out.
    const coveredRentIds = plan.required.filter(r => r.type === 'rent').map(r => r.id)
    let subleasePerMonth = 0
    if (ctx.unitId && coveredRentIds.length > 0) {
      const sub = await queryOne<{ sub: string; master: string }>(
        `SELECT s.sub_monthly_amount::text AS sub, s.master_share_amount::text AS master
           FROM subleases s JOIN leases l ON l.id = s.master_lease_id
          WHERE l.unit_id = $1 AND s.sublessee_tenant_id = $2 AND s.status = 'active'
          LIMIT 1`,
        [ctx.unitId, tenantId])
      if (sub) subleasePerMonth = Math.max(0, parseFloat(sub.sub) - parseFloat(sub.master))
    }
    const appliedTotal = toDollars(land.dueCents + land.toCarriedCents)
    // GAM supersedence claims only what lands on obligations.
    const gamSupersedenceAmount = Math.min(appliedTotal, await computeTenantGamOutstandingTotal(tenantId))
    const platformCutAmount = Math.round(
      (fees.base + passthroughAmount + subleasePerMonth * coveredRentIds.length + gamSupersedenceAmount) * 100) / 100

    if (input.dryRun) {
      return {
        ...quoteResult(plan, land, { moneyCents, fee: tenantBorneOnTop, base: fees.base, status: 'quote', paidWithCredit: false }),
        platformCutAmount, chargeAmount,
      }
    }

    // ── Write ───────────────────────────────────────────────────────────────
    // The receipt first, so the intent's metadata can carry its id.
    // created_at comes back too: a card held for its bank's confirmation is
    // released CARD_CONFIRM_HOLD_MINUTES after it (the sweep, /resume and the
    // bill read all count from it), so the screen's confirmBy uses that clock.
    const rem = await client.query<{ id: string; created_at: Date }>(
      // S616: gross_amount and processing_fee_amount let GAM tie out to Stripe.
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
          payment_method, gross_amount, processing_fee_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
      [tenantId, plan.leaseId, plan.landlordId, amount.toFixed(2),
       appliedTotal.toFixed(2), toDollars(land.surplusCents).toFixed(2),
       paymentMethodType === 'ach' ? 'ach' : 'card',
       chargeAmount.toFixed(2), tenantBorneOnTop.toFixed(2)])
    const remittanceId = rem.rows[0].id
    const remittanceCreatedAt = new Date(rem.rows[0].created_at)

    // S622: the old balance is the one charge paid in part. The paid slice
    // keeps the row; the rest stays open on its own row.
    if (land.partialCarried) {
      const pc = land.partialCarried
      await client.query(
        `UPDATE payments SET amount = $2::numeric,
                notes = COALESCE(notes || ' — ', '') || 'partly paid toward the old balance; $' || $3 || ' remains on a separate row'
          WHERE id = $1`,
        [pc.id, toDollars(pc.appliedCents).toFixed(2), toDollars(pc.remainderCents).toFixed(2)])
      await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                               type, amount, status, due_date, entry_description, notes, is_remainder, revenue_owner)
         SELECT unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                type, $2::numeric, 'pending', due_date, entry_description,
                'What is left of the old balance after a part payment', TRUE, revenue_owner
           FROM payments WHERE id = $1`,
        [pc.id, toDollars(pc.remainderCents).toFixed(2)])
    }

    // The credit this payment spends is set aside on the receipt until the
    // money clears (applied on success, given back on a failure). Written while
    // the rows are still open: once a row carries an intent, the ledger only
    // takes credit set aside by THAT intent's receipt (M4 trigger).
    if (useCredit && plan.creditPlan.length > 0) {
      await holdCredit(client, plan.creditPlan, { remittanceId, source: input.source })
    }

    // Claim every covered row, guarded: only rows still payable are taken, and
    // the count must match — nothing is charged if anything moved.
    const claimed = await client.query<{ id: string }>(
      `UPDATE payments p
          SET status = 'processing', platform_held = TRUE, next_retry_at = NULL,
              -- S654: how the card was presented, for the history.
              payment_channel = $2
        WHERE p.id = ANY($1::uuid[]) AND ${payableRowSql('p')}
       RETURNING p.id`,
      [land.coveredIds, paymentMethodType === 'card_present' ? 'in_person' : 'online'])
    if (claimed.rows.length !== land.coveredIds.length) {
      throw new AppError(409, 'Part of this bill changed while it was being paid. Nothing was charged — look at the bill again.')
    }

    for (const ln of land.lines) {
      await client.query(
        `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`,
        [remittanceId, ln.paymentId, toDollars(ln.cents).toFixed(2)])
    }

    // S560: ALWAYS a platform charge — money held by GAM, batched to the
    // landlord on the weekly run.
    let intent: { id: string; status: string; client_secret?: string | null }
    const metadata: Record<string, string> = {
      gam_remittance_id: remittanceId,
      tenant_id: tenantId,
      landlord_id: plan.landlordId,
      gam_charge_source: input.source,
    }
    if (plan.leaseId) metadata.gam_lease_id = plan.leaseId
    // decisions.md #48.4: a card the pay screen will confirm on the spot. If
    // its bank's confirmation then fails (or the card is refused once
    // confirmed), Stripe's payment_failed is not a declined payment: the
    // webhook hands it to the release (jobs/paymentReconcile
    // releaseFailedOnScreenConfirmation) — the bill opens again, with no
    // decline fee, no failed-payment mark and no notice, exactly as a card
    // refused on this screen at once.
    if (input.source === 'portal' && input.confirmOnScreen === true && paymentMethodType === 'card' && !input.existingIntent) {
      metadata.gam_confirm_on_screen = 'true'
    }
    if (input.existingIntent) {
      // S654: the counter reader already holds an authorization, created for
      // the quote this same arithmetic produced. A moved balance books nothing.
      const want = Math.round(chargeAmount * 100)
      if (want !== input.existingIntent.amountCents) {
        throw new AppError(409,
          `The balance changed since the reader was sent ${money(input.existingIntent.amountCents)} — it is now ${money(toCents(chargeAmount))}.`)
      }
      await getStripe().paymentIntents.update(input.existingIntent.id, {
        description: 'BALANCE - Gold Asset Management',
        metadata: {
          gam_purpose: 'rent_terminal',
          entry_description: 'BALANCE',
          platform_held: 'true',
          ...metadata,
        },
      })
      intent = { id: input.existingIntent.id, status: 'requires_capture' }
    } else {
      if (!paymentMethodId) throw new AppError(400, 'A saved payment method is required')
      try {
        intent = await createRentPlatformCharge({
          amount: chargeAmount,
          stripeCustomerId: ctx.stripeCustomerId!,
          paymentMethodId,
          paymentMethodTypes: paymentMethodType === 'ach' ? ['us_bank_account'] : ['card'],
          entryDescription: 'BALANCE',
          metadata,
          // decisions.md #48.4: an autopay card pull is sent off-session — the
          // cardholder is not here to confirm anything.
          offSession: input.source === 'autopay' && paymentMethodType === 'card',
          // Scoped to this payer and this bill: Pay all may send one key for
          // every lease, and one tenant's key never touches another's charge.
          ...(input.idempotencyKey
            ? { idempotencyKey: `gam_balance_${tenantId}_${plan.leaseId ?? `sa_${serviceAgreementId}`}_${input.idempotencyKey}` }
            : {}),
        })
      } catch (e: any) {
        // The same press sent again: Stripe already has a charge (or an answer)
        // for it. Its parameters differ (a new receipt id), so Stripe refuses
        // rather than charge twice; nothing here is written either.
        if (e?.type === 'StripeIdempotencyError' || e?.rawType === 'idempotency_error') {
          throw new AppError(409,
            'This payment was already sent once. Nothing more was charged — look at your bill again to see where it stands.')
        }
        // An off-session card pull (autopay) the card's bank still wants the
        // cardholder to confirm: Stripe refuses it and leaves the intent
        // waiting for a payment method. Nothing is written; the intent is
        // canceled so it can never be finished, and the pull fails through the
        // normal failure path with a plain next step (decisions.md #48.4).
        if (isAuthenticationRequired(e)) {
          await client.query('ROLLBACK')
          began = false
          const piId: string | null = e?.raw?.payment_intent?.id ?? e?.payment_intent?.id ?? null
          if (piId) await cancelNotTaken(piId, 'requires_payment_method', tenantId, plan.leaseId)
          throw new PaymentNotTakenError(notTakenMessage('requires_action', paymentMethodType, input.source), 'requires_action')
        }
        throw e
      }
      // decisions.md #48.4: the payer is on the pay screen and the card's bank
      // wants them to confirm. The charge is kept and the bill held while they
      // do (see confirmOnScreen); the screen is handed what it needs.
      const confirmHere = intent.status === 'requires_action' && paymentMethodType === 'card'
        && input.source === 'portal' && input.confirmOnScreen === true && !!intent.client_secret
      // Not taken and not on its way (a card's bank wants the cardholder to
      // confirm it where nobody can, a bank still verifying): cancel it and
      // write nothing, so the bill is never held by a charge nobody can finish.
      if (!CHARGE_STATUSES_KEPT.has(intent.status) && !confirmHere) {
        const notTaken = intent
        await client.query('ROLLBACK')
        began = false
        await cancelNotTaken(notTaken.id, notTaken.status, tenantId, plan.leaseId)
        throw new PaymentNotTakenError(notTakenMessage(notTaken.status, paymentMethodType, input.source), notTaken.status)
      }
    }

    // The intent on every covered row — the webhook settles them all by it.
    await client.query(
      `UPDATE payments SET stripe_payment_intent_id = $1 WHERE id = ANY($2::uuid[])`,
      [intent.id, land.coveredIds])
    if (subleasePerMonth > 0 && coveredRentIds.length > 0) {
      await client.query(
        `UPDATE payments SET sublease_markup_amount = $1 WHERE id = ANY($2::uuid[])`,
        [subleasePerMonth.toFixed(2), coveredRentIds])
    }
    await client.query(
      `UPDATE tenant_remittances SET stripe_payment_intent_id = $1, updated_at = NOW() WHERE id = $2`,
      [intent.id, remittanceId])
    if (unpaidAccruals.ids.length > 0) {
      await client.query(
        `UPDATE platform_fee_accruals SET tenant_charge_id = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[]) AND tenant_charge_id IS NULL`,
        [land.coveredIds[0], unpaidAccruals.ids])
    }

    if (input.existingIntent?.capture) {
      // S654: the counter reader. Capture BEFORE the commit, so a capture that
      // fails rolls every row back with it — nothing half-booked.
      const piId = input.existingIntent.id
      try {
        await getStripe().paymentIntents.capture(piId)
        intent = { id: piId, status: 'succeeded' }
      } catch (captureErr) {
        const live = await getStripe().paymentIntents.retrieve(piId).catch(() => null)
        if (live && live.status === 'succeeded') {
          intent = { id: piId, status: 'succeeded' }
        } else {
          await getStripe().paymentIntents.update(piId, {
            metadata: { gam_purpose: 'rent_terminal_pending', gam_remittance_id: '', entry_description: '', platform_held: '', gam_charge_source: '', gam_lease_id: '' },
          }).catch(() => {})
          if (live && live.status === 'requires_capture') {
            await getStripe().paymentIntents.cancel(piId).catch(() => {})
          }
          logger.error({ err: captureErr, paymentIntentId: piId }, '[reader] capture failed — booking rolled back, hold released')
          throw new AppError(502, 'The card could not be captured — nothing was recorded. Send it to the reader again.')
        }
      }
    }

    await client.query('COMMIT')
    began = false
    await cancelSupersededIntents(cancelAfterCommit)

    if (!ctx.connectReady) {
      await createAdminNotification({
        severity: 'warn',
        category: 'platform_held_rent_charge',
        title: `Held balance payment can't batch out — landlord ${ctx.landlordUserId} not Connect-ready`,
        body: `Remittance ${remittanceId} for ${money(toCents(amount))} is held on the GAM platform balance. It batches to the landlord once they finish Connect onboarding.`,
        context: { remittance_id: remittanceId, landlord_id: plan.landlordId, amount },
      })
    }

    const awaitingConfirmation = intent.status === 'requires_action'
    return {
      ...quoteResult(plan, land, { moneyCents, fee: tenantBorneOnTop, base: fees.base, status: intent.status, paidWithCredit: false }),
      remittanceId,
      paymentIntentId: intent.id,
      platformCutAmount,
      chargeAmount,
      ...(awaitingConfirmation
        ? {
            clientSecret: intent.client_secret ?? null,
            // The same clock the release counts from: the receipt's created_at.
            confirmBy: new Date(remittanceCreatedAt.getTime() + CARD_CONFIRM_HOLD_MINUTES * 60_000).toISOString(),
          }
        : {}),
    }
  } catch (e) {
    if (began) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

function quoteResult(
  plan: LeaseChargePlan,
  land: MoneyLanding,
  a: { moneyCents: number; fee: number; base: number; status: string; paidWithCredit: boolean },
): ChargeLeaseBalanceResult {
  const creditUsed = toDollars(land.creditUsedCents)
  return {
    remittanceId: '',
    paymentIntentId: '',
    status: a.status,
    appliedTotal: toDollars(land.dueCents + land.toCarriedCents),
    payAhead: toDollars(land.surplusCents),
    platformCutAmount: Math.round((a.base) * 100) / 100,
    chargeAmount: toDollars(a.moneyCents + toCents(a.fee)),
    processingFee: Math.round(a.fee * 100) / 100,
    lines: land.lines.map(l => ({ payment_id: l.paymentId, amount_applied: toDollars(l.cents) })),
    outstanding: toDollars(toCents(plan.requiredTotal) + toCents(plan.carriedTotal)),
    requiredTotal: plan.requiredTotal,
    carriedTotal: plan.carriedTotal,
    usableCredit: plan.usableCredit,
    creditUsed,
    creditNetted: creditUsed,
    towardOldBalance: toDollars(land.toCarriedCents),
    coversWholeBill: plan.coversWholeBill,
    paidWithCredit: a.paidWithCredit,
    gamTotal: plan.gamTotal,
    creditStillHeldElsewhere: plan.creditStillHeldElsewhere,
    creditWaitingNote: plan.creditWaitingNote,
  }
}
