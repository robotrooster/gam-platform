/**
 * S124: ACH retry workflow.
 *
 * NACHA Operating Rules permit up to 2 retries per failed ACH transaction.
 * Retries are only valid on certain return codes (insufficient funds,
 * uncollected funds) — account-related failures (R02 closed, R03 missing,
 * R04 invalid) and zero-tolerance codes (R05/R07/R10/R29) are NOT
 * retry-eligible.
 *
 * Flow:
 *   1. Stripe fires payment_intent.payment_failed
 *   2. webhooks.ts extracts the NACHA return code via extractReturnCode
 *   3. decideRetry classifies as 'retry' or 'permanent'
 *   4. On 'retry': payment.next_retry_at = the start of the property's
 *      calendar day three days out (S654 — the day the tenant is told),
 *      retry_count stays where it is (incremented by the cron when it fires)
 *   5. On 'permanent': payment.next_retry_at = NULL, status stays
 *      'failed' for the audit trail
 *
 * Daily cron (processAchRetries) walks payments where:
 *   status='failed' AND next_retry_at <= NOW() AND retry_count < ACH_MAX_RETRIES
 * grouped by payment intent (S654: one bank pull, however many charge lines
 * it covered). For each, calls stripe.paymentIntents.confirm once to fire the
 * retry, increments retry_count on every row, clears next_retry_at (the next
 * failure will either schedule another retry or terminate).
 *
 * S654: while the retry is in flight its rows read 'processing', exactly like a
 * first pull. Left 'failed', every other way to pay (Pay Now, the counter
 * reader, autopay, a recorded cash payment, a matched bank deposit) still saw
 * them as owed for the 2-4 business days the bank takes — a tenant who paid by
 * card in that window re-stamped the rows, and when the retry then settled no
 * row matched it: the bank was debited twice and GAM held money with no record.
 * A later payment_failed puts them back to 'failed'; payment_intent.succeeded
 * settles them.
 *
 * S655 (money plan Step 10): the claim takes the household lock first (§1.5),
 * so a tenant paying the same bill at the same moment waits and the second
 * finds the rows taken. Credit a pull set aside stays held while it retries
 * (the webhook applies it on success). The three ways a due retry ends with
 * nothing pulled — part of the pull paid another way, a FlexPay reprice that
 * failed, a confirm Stripe says moved nothing — give that credit back, close
 * the pull's receipt as failed, cancel its intent at Stripe (it can never be
 * confirmed later), and leave the rows owed, so the tenant can pay now. A
 * FlexPay pull that ends that way is GAM's failure, never the tenant's.
 */

import type Stripe from 'stripe'
import { ACH_MAX_RETRIES, ACH_RETURN_CONFIG, STRIPE_ACH_FAILURE_CODE_TO_RETURN_CODE } from '@gam/shared'
import type { PoolClient } from 'pg'
import { query, getClient } from '../db'
import { getStripe } from '../lib/stripe'
import { allocationOrderSql, lockHousehold } from './moneyPredicates'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

/**
 * Extract the NACHA return code from a failed ACH PaymentIntent. Returns null if
 * the reason can't be resolved (a card failure, missing details, a name we do
 * not know).
 *
 * S654: two places, in order.
 *   1. An R-code on `return_details` — the deep path this was first written
 *      against (our test fixtures; never yet seen from live Stripe).
 *   2. The NAME Stripe gives a bank debit's failure: `last_payment_error.code`
 *      ('insufficient_funds', 'account_closed', ...), or the expanded charge's
 *      `failure_code`. Read by R-code alone, every real bounce looked
 *      unreadable, an unreadable reason is final, and "not enough money this
 *      week" never got its two retries. Names map through
 *      STRIPE_ACH_FAILURE_CODE_TO_RETURN_CODE.
 * Names are read only for a BANK debit. A declined card reports code
 * 'card_declined' with decline_code 'insufficient_funds'; a card is never
 * retried here, so a card failure must never read as R01.
 */
export function extractReturnCode(pi: Stripe.PaymentIntent): string | null {
  const lpe: any = pi.last_payment_error
  // Stripe's nested return-details payload — actual key varies by API version
  const details =
    lpe?.payment_method_details?.us_bank_account?.return_details ??
    lpe?.payment_method?.us_bank_account?.return_details
  if (details && typeof details.code === 'string') return details.code.toUpperCase()

  if (!isBankDebitFailure(pi)) return null
  const charge: any = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null
  for (const raw of [lpe?.code, charge?.failure_code]) {
    if (typeof raw !== 'string' || !raw) continue
    if (/^R\d{2}$/i.test(raw)) return raw.toUpperCase()
    const mapped = STRIPE_ACH_FAILURE_CODE_TO_RETURN_CODE[raw.toLowerCase()]
    if (mapped) return mapped
  }
  return null
}

/**
 * Stripe's error types that say GAM's OWN request was the problem (bad
 * parameters, a mandate GAM sent wrong, GAM's keys, Stripe's own outage) —
 * never the bank's answer to the debit.
 */
const REQUEST_SIDE_ERROR_TYPES: readonly string[] = [
  'invalid_request_error', 'api_error', 'api_connection_error', 'authentication_error',
  'idempotency_error', 'rate_limit_error',
]

/**
 * Step 10 (decisions #37.D, FlexPay terms §4.3): did the tenant's BANK refuse
 * or return this failed debit? A failed bank debit is the bank's answer —
 * whether or not GAM can read its reason (Stripe names several bank refusals,
 * such as a frozen or restricted account, that no R-code here maps) — unless
 * Stripe's error type says GAM's own request was the problem
 * (REQUEST_SIDE_ERROR_TYPES). A readable return code is always the bank's.
 * False for a card, and for a canceled intent (GAM called it off; the caller
 * reads the cancel). The one rule for "at the tenant's bank" on a failed pull.
 */
export function bankRefusedDebit(pi: Stripe.PaymentIntent): boolean {
  if (pi.status === 'canceled') return false
  if (extractReturnCode(pi)) return true
  if (!isBankDebitFailure(pi)) return false
  const type = String((pi.last_payment_error as any)?.type ?? '')
  return !REQUEST_SIDE_ERROR_TYPES.includes(type)
}

/** Was this a US bank debit (not a card)? The failing method's type wins; the
 *  intent's allowed types decide only when the error does not name one. */
function isBankDebitFailure(pi: Stripe.PaymentIntent): boolean {
  const pmType = (pi.last_payment_error as any)?.payment_method?.type
  if (typeof pmType === 'string') return pmType === 'us_bank_account'
  const types = pi.payment_method_types ?? []
  return types.includes('us_bank_account') && !types.includes('card')
}

/**
 * The confirm parameters for a retry of a bounced bank pull: the payment method
 * the intent last tried (still on the intent, or on last_payment_error once
 * Stripe has cleared it), plus — for a bank debit — the same online debit
 * authorization createRentPlatformCharge sends with every rent pull.
 *
 * Whether it is a bank debit is read from the method being confirmed (the
 * intent is retrieved with `payment_method` expanded; the error carries its
 * own type). Only when neither names a type does an intent that allows bank
 * debits and not cards count as one — a mandate sent with a card is refused.
 */
export function retryConfirmParams(pi: Stripe.PaymentIntent): Stripe.PaymentIntentConfirmParams {
  const pmOnIntent: any = pi.payment_method && typeof pi.payment_method === 'object' ? pi.payment_method : null
  const onIntent = typeof pi.payment_method === 'string' ? pi.payment_method : pmOnIntent?.id
  const pmOnError: any = (pi.last_payment_error as any)?.payment_method ?? null
  const paymentMethod: string | undefined = onIntent ?? pmOnError?.id
  const pmType: string | undefined = onIntent ? pmOnIntent?.type : pmOnError?.type
  const types = pi.payment_method_types ?? []
  const isBank = typeof pmType === 'string'
    ? pmType === 'us_bank_account'
    : types.includes('us_bank_account') && !types.includes('card')
  return {
    ...(paymentMethod ? { payment_method: paymentMethod } : {}),
    ...(isBank
      ? {
          mandate_data: {
            customer_acceptance: {
              type: 'online' as const,
              online: { ip_address: '0.0.0.0', user_agent: 'GAM-Platform/1.0' },
            },
          },
        }
      : {}),
  }
}

/**
 * The row that speaks for a bank pull (credit ledger, decline fee, the notice's
 * tenant/unit lookup): rent first, then utility, then anything else — never
 * whichever row an UPDATE happened to return first, which could be a fee row
 * and skip the rent bounce's ledger entry entirely. Shared by the webhook and
 * the retry cron.
 */
export function pickPullAnchor<T extends { id: string; type: string }>(rows: T[]): T | null {
  const rank = (t: string) => (t === 'rent' ? 0 : t === 'utility' ? 1 : 2)
  return [...rows].sort((a, b) => rank(a.type) - rank(b.type) || a.id.localeCompare(b.id))[0] ?? null
}

/** Who to tell about a failed bank pull, and where it was. */
export interface PullNoticeContext {
  id:              string
  tenant_user_id:  string
  tenant_email:    string
  tenant_name:     string
  landlord_id_pk:  string
  property_id:     string
  unit_number:     string
  property_name:   string
  property_tz:     string | null
  /** The property's landlord-side contacts (S186 responsible-party resolver). */
  landlordRecipients: Array<{ userId: string; email: string }>
}

/**
 * The tenant, unit, property and landlord-side contacts for a payment row —
 * one lookup for both the webhook's notices and the retry cron's. Null when the
 * row has no tenant account or no unit (nothing to send).
 */
export async function pullNoticeContext(paymentId: string): Promise<PullNoticeContext | null> {
  const ctx = await query<Omit<PullNoticeContext, 'landlordRecipients'>>(`
    SELECT p.id,
           t.user_id AS tenant_user_id,
           tu.email  AS tenant_email,
           tu.first_name || ' ' || tu.last_name AS tenant_name,
           l.id  AS landlord_id_pk,
           pr.id AS property_id,
           un.unit_number,
           pr.name AS property_name,
           pr.timezone AS property_tz
      FROM payments p
      JOIN tenants    t  ON t.id = p.tenant_id
      JOIN users      tu ON tu.id = t.user_id
      JOIN landlords  l  ON l.id = p.landlord_id
      JOIN units      un ON un.id = p.unit_id
      JOIN properties pr ON pr.id = un.property_id
     WHERE p.id = $1
  `, [paymentId])
  const pctx = ctx[0]
  if (!pctx) return null
  const { getPropertyResponsibleParty } = await import('./responsibleParty')
  const targets = await getPropertyResponsibleParty(pctx.property_id)
  const landlordRecipients = (targets?.primaries ?? []).map((r) => ({ userId: r.user_id, email: r.email }))
  return { ...pctx, landlordRecipients }
}

/**
 * ── 11/4 (Nic): WHAT THE BANK WILL ACTUALLY BE ASKED FOR ────────────────────
 *
 *   "Have the retry email state the correct amount that is actually going to be
 *    charged. Pull up line items at the time of, that the email is going out."
 *
 * Heather Miller was told a $100 payment would be retried. $106.00 was debited:
 * the $6 ACH fee rides every bank payment and the notice never named it. The
 * notice's figure was the sum of the CHARGE ROWS, which is what she owes, not
 * what her bank is asked for.
 *
 * A retry re-confirms the SAME PaymentIntent, so the debit is the intent's own
 * amount — the one number nothing can drift from — and the caller passes it
 * (`debitDollars`, from the live Stripe object it already holds).
 *
 * The lines come from the database at the moment the notice is written, named
 * the way every other bill, receipt and reminder names them (invoiceNotice
 * chargeLabel), plus one "Bank fee" line for the processing fee the pull
 * carries.
 *
 * IF THE LINES DO NOT ADD UP TO THE DEBIT, NO LINES ARE SHOWN. A total with
 * parts that do not sum to it is worse than a total alone: it reads as an
 * arithmetic error by the sender, and whoever reads it starts doing their own
 * sums. That happens when something about the charge is not a line of it — a
 * credit that covered part of a row, money paid ahead on top — so the figure
 * stands by itself and the resident is still told the truth about the debit.
 */
export interface PullDebitLine { label: string; amount: number }

export async function pullDebitLines(piId: string, debitDollars: number): Promise<PullDebitLine[]> {
  const { chargeLabel, chargeLabelColumnsSql } = await import('./invoiceNotice')
  const rem = (await query<{ id: string; fee: string }>(
    `SELECT id, COALESCE(processing_fee_amount, 0)::text AS fee FROM tenant_remittances
      WHERE stripe_payment_intent_id = $1 ORDER BY created_at LIMIT 1`, [piId]))[0]
  const rows = await query<any>(
    `SELECT p.id, p.type, p.entry_description, p.amount::text AS amount, p.notes,
            p.lease_fee_id, p.reversal_id,
            ${chargeLabelColumnsSql('p')},
            COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                       WHERE cu.payment_id = p.id
                         AND ($2::uuid IS NOT NULL AND cu.remittance_id = $2::uuid)
                         AND cu.status IN ('held', 'applied')), 0)::text AS credit
       FROM payments p
      WHERE p.stripe_payment_intent_id = $1
      ORDER BY ${allocationOrderSql('p')}`,
    [piId, rem?.id ?? null])
  if (rows.length === 0) return []

  const lines: PullDebitLine[] = []
  for (const r of rows) {
    // What the BANK is being asked for on this row: the charge, less anything
    // credit is paying of it (credit is not processed, so Stripe never sees it).
    const money = Math.round((Number(r.amount) - Number(r.credit)) * 100) / 100
    if (money <= 0) continue
    lines.push({ label: chargeLabel(r), amount: money })
  }
  const fee = Math.round(Number(rem?.fee ?? 0) * 100) / 100
  if (fee > 0) lines.push({ label: 'Bank fee', amount: fee })

  const sum = Math.round(lines.reduce((t, l) => t + l.amount, 0) * 100) / 100
  return Math.abs(sum - Math.round(debitDollars * 100) / 100) < 0.005 ? lines : []
}

/**
 * NACHA retry decision based on the return code.
 *   'retry'      — schedule a retry attempt
 *   'permanent'  — no retry; status stays 'failed'
 *
 * Unknown codes default to 'permanent' (conservative — don't retry
 * something we don't classify; Stripe may return non-NACHA failure
 * shapes for non-ACH payment methods or for first-attempt timeouts).
 */
export function decideRetry(returnCode: string | null): 'retry' | 'permanent' {
  if (!returnCode) return 'permanent'
  const cfg = ACH_RETURN_CONFIG[returnCode]
  if (!cfg) return 'permanent'
  return cfg.retryEligible ? 'retry' : 'permanent'
}

/**
 * The unpaid return fees that will ride this household's next bank pull.
 *
 * ONE definition, read by two places that must agree: the fold that raises the
 * pull (below) and the notice that tells the resident what their bank will be
 * asked for (routes/webhooks). They are written at different moments — the
 * notice when the bank refuses, the fold three days later as the retry goes out
 * — so a second copy of this rule would drift, and the resident would be
 * quoted one number and charged another. That is the exact defect 11/4 fixed
 * ("Heather Miller was told $100 and charged $106") and it must not come back
 * from the other side.
 */
export async function returnFeesRidingPull(
  piId: string,
): Promise<{ id: string; amount: number; returnedOn: string | null }[]> {
  const rows = await query<{ id: string; amount: string; returned_on: string | null }>(
    // 11/5 (Nic): "just separate the line items by putting the bounce date on
    // there." The day each refusal happened comes back with it, so a notice
    // quoting two $4s names two different days instead of the same words twice.
    `SELECT f.id, f.amount::text AS amount,
            to_char(f.returned_on, 'YYYY-MM-DD') AS returned_on
       FROM payments f
      WHERE f.entry_description = 'RETURNFEE'
        AND f.status = 'pending'
        AND f.voided_at IS NULL
        AND f.held_for_next_bill_at IS NULL
        AND f.stripe_payment_intent_id IS NULL
        AND f.lease_id = (SELECT p.lease_id FROM payments p
                           WHERE p.stripe_payment_intent_id = $1
                             AND p.lease_id IS NOT NULL LIMIT 1)
      ORDER BY f.created_at, f.id`, [piId])
  return rows.map(r => ({ id: r.id, amount: Number(r.amount), returnedOn: r.returned_on }))
}

/**
 * 11/5 (Nic) — THE RETURNED-PAYMENT FEE RIDES THE RETRY.
 *
 *   "Every time going forward, the fee needs to ride the retry amount."
 *
 * A refused bank debit costs GAM $4 that Stripe keeps. Until today that $4 was
 * written held and waited for the next bill (11/4), which meant GAM carried it
 * for up to a month. The retry three days later is already pulling from the
 * same account for the same bill, so the fee goes with it.
 *
 * ── WHY THIS RUNS AFTER claimPull AND NOT BEFORE ──────────────────────────
 *
 * claimPull treats any row on the intent it did NOT claim as a "stray" and
 * abandons the retry — that guard is what stops a re-pull taking money for a
 * line somebody already paid at the desk. A fee row stamped onto the intent
 * beforehand is exactly such a row ('pending', never 'failed'), so stamping it
 * early would make every bounced pull refuse its own retry. It joins the pull
 * only once the claim has succeeded.
 *
 * ── WHICH FEES RIDE: THIS HOUSEHOLD'S, NOT THIS INTENT'S ──────────────────
 *
 * Every unpaid return fee on the same LEASE rides, not only the ones whose note
 * names this payment intent. Scoping to the intent looks tighter and is wrong:
 * Heather in MH 28 bounced on 11/1 and again on 11/3, and Stripe gave the
 * second attempt a NEW intent, so one of her two $4 fees would never have been
 * collected by any pull. A second attempt usually is a new intent, so that was
 * not an edge case — it was the normal one.
 *
 * The lease is the right boundary: it is one household's money, and the pull is
 * being made from that household's bank. A fee on another lease is another
 * household's and never rides.
 *
 * A HELD fee is deliberately left behind. Heather in Space 28 has one from
 * 11/4, written under the old rule, and Nic kept it riding her next bill. The
 * `held_for_next_bill_at IS NULL` test is what honours that without a
 * one-off exception for her.
 *
 * ── THE ORDER IS THE SAFETY ───────────────────────────────────────────────
 *
 * Raise the amount at Stripe, then stamp the rows; if the stamp fails, put the
 * amount straight back. The intent has not been confirmed yet, so that really
 * is a rollback and not a repair. Getting this backwards gives one of two bad
 * ends: money pulled with no row to land on, or rows marked paid for money the
 * bank never sent.
 *
 * Returns what was added, 0 when there was nothing to add. It never throws:
 * the rent is the thing that must be collected, and a fee that misses this
 * pull is still ordinary owed money that rides whatever comes next.
 */
export async function foldReturnFeesIntoRetry(piId: string): Promise<number> {
  try {
    const fees = await returnFeesRidingPull(piId)
    if (fees.length === 0) return 0

    const added = Math.round(fees.reduce((s, f) => s + f.amount, 0) * 100) / 100
    if (added <= 0) return 0

    const stripe = getStripe()
    const live = await stripe.paymentIntents.retrieve(piId)
    const was = live.amount
    // ADDED TO WHAT THE PULL ALREADY ASKS FOR, never rebuilt from the charge
    // rows. The intent carries the payer's processing fee as well as the
    // charges — Heather's $106 is a $100 trailer payment plus the $6 flat ACH
    // fee, and there is no row for that $6 (it rides tenant_remittances). So
    // summing the rows and adding the fee would have pulled $108 and quietly
    // given the $6 away, on this retry and every other one.
    const want = was + Math.round(added * 100)

    await stripe.paymentIntents.update(piId, { amount: want })
    try {
      await query(
        `UPDATE payments
            SET stripe_payment_intent_id = $1, status = 'processing'
          WHERE id = ANY($2::uuid[]) AND status = 'pending'`,
        [piId, fees.map(f => f.id)])
    } catch (e) {
      await stripe.paymentIntents.update(piId, { amount: was }).catch(() => {})
      throw e
    }
    logger.info({ piId, added, fees: fees.length },
      '[ach-retry] returned-payment fee(s) folded into the retry')
    return added
  } catch (e) {
    logger.error({ err: e, piId },
      '[ach-retry] could not fold the returned-payment fee into the retry — it stays owed on its own')
    return 0
  }
}

interface RetryResult {
  /** Bank pulls (payment intents) due for a retry. */
  scanned: number
  fired: number
  succeeded: number
  failed: number
  /** S654: due pulls NOT re-pulled because part was paid another way meanwhile. */
  skipped: number
  errors: { payment_id: string; stripe_payment_intent_id?: string; error: string }[]
}

/**
 * Daily cron: walk due retries, fire each via stripe.paymentIntents.confirm.
 * Caps at 200 retries per run (defensive — sustained retry storms
 * indicate a deeper issue worth alerting on, not blasting through
 * silently).
 *
 * S654: one retry is one BANK PULL, not one charge line. A Pay Now that covered
 * rent + water + a fee is one payment intent stamped on three rows; this used to
 * confirm that same intent once per row, so Stripe refused the second and third
 * confirms and every multi-line retry raised false "retry failed" admin alerts.
 * Rows are grouped by intent, all claimed together, and the intent is
 * confirmed once.
 */
export async function processAchRetries(): Promise<RetryResult> {
  const result: RetryResult = {
    scanned: 0, fired: 0, succeeded: 0, failed: 0, skipped: 0, errors: [],
  }

  const due = await query<{ stripe_payment_intent_id: string }>(
    `SELECT stripe_payment_intent_id
       FROM payments
      WHERE status = 'failed'
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= NOW()
        AND retry_count < ${ACH_MAX_RETRIES}
        AND stripe_payment_intent_id IS NOT NULL
      GROUP BY stripe_payment_intent_id
      ORDER BY MIN(next_retry_at) ASC, stripe_payment_intent_id
      LIMIT 200`
  )

  const stripe = getStripe()
  for (const { stripe_payment_intent_id: piId } of due) {
    result.scanned++

    // Claim: bump retry_count + clear next_retry_at + stamp last_retry_at on
    // EVERY row of this pull BEFORE firing the Stripe call, and mark them
    // 'processing' — the money is being pulled, so nothing else may take it a
    // second time (see the header). S655 (§1.5): under the household lock, so
    // a tenant paying the same bill at this moment waits, and whichever goes
    // second finds the rows taken (a payment first: the retry finds them no
    // longer failed and is not fired).
    const claim = await claimPull(piId)
    if (!claim) continue  // Lost the race (or paid another way); skip
    const { claimed, stray } = claim
    const claimedIds = claimed.map((r) => r.id)
    const anchorId = claimed[0].id

    // S654: the retry pulls the intent's WHOLE original amount. If any line it
    // covered has since been paid another way — cash recorded at the desk or
    // by the assistant (which settles one charge), a bank deposit matched to
    // one line — that line no longer carries this intent's failed status and
    // was not claimed. Pulling anyway would take that line's money a second
    // time and leave it with no row to land on. So the bank is not retried:
    // the rest stays owed, the tenant is told with a Pay now button, and an
    // admin is alerted. S655: the credit the pull set aside is given back and
    // the intent is canceled, so it can never be confirmed later.
    if (stray.length > 0) {
      result.skipped++
      const owed = Math.round(claimed.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100
      logger.warn({ piId, stray: stray.map((r) => r.id) }, '[ach-retry] part of the pull was paid another way; not retried')
      await createAdminNotification({
        severity: 'warn',
        category: 'ach_retry_skipped_partly_paid',
        title:    `ACH retry not fired — part of the payment was paid another way (payment ${anchorId})`,
        body:     `Bank pull ${piId} was due a retry, but ${stray.length} of its lines were not part of it ` +
                  `(now ${stray.map((r) => r.status).join(', ')}). Re-pulling would take the full original ` +
                  `amount, so it was not retried and the pull was canceled. The other ${claimed.length} line(s), $${owed.toFixed(2)}, ` +
                  `are owed again and the tenant has been asked to pay.`,
        context:  { payment_ids: claimedIds, other_payment_ids: stray.map((r) => r.id), stripe_payment_intent_id: piId },
      })
      await cancelDeadPull(piId, 'part of the pull was paid another way')
      await endFlexPayRetries(claimed, 'part of the pull was paid another way, so the retry was not sent')
      await notifyRetrySkipped(claimed, owed)
      continue
    }
    result.fired++

    // FlexPay: the retry collects the amount the cover paid + the flat $25 +
    // the returned-pull fee for every bounce so far (repriceFlexPayRetryPayment)
    // — set on the intent BEFORE the confirm. If the reprice fails, the confirm
    // is skipped (never pull a stale amount): nothing was pulled, so the lines
    // are owed again, the pull's credit is given back, the intent is canceled,
    // and FlexPay handles the collection as a failure on GAM's side.
    let repriceFailed = false
    for (const row of claimed.filter((r) => r.entry_description === 'FLEXPAY')) {
      try {
        const { repriceFlexPayRetryPayment } = await import('./flexpay')
        await repriceFlexPayRetryPayment(row.id)
      } catch (e: any) {
        repriceFailed = true
        const errMsg = e?.message ?? String(e)
        result.errors.push({ payment_id: row.id, stripe_payment_intent_id: piId, error: errMsg })
        logger.error({ err: errMsg }, `[ach-retry] flexpay reprice failed for payment ${row.id}`)
        await createAdminNotification({
          severity: 'warn',
          category: 'flexpay_reprice_failure',
          title:    `FlexPay retry reprice failed for payment ${row.id}`,
          body:     errMsg,
          context:  { payment_id: row.id, stripe_payment_intent_id: piId },
        })
      }
    }
    if (repriceFailed) {
      result.failed++
      // S654: nothing was pulled — owed again (unless the failure webhook
      // already decided this pull: then its decision stands).
      if (await giveBackClaim(piId, claimedIds, 'payment_canceled')) {
        await cancelDeadPull(piId, 'the FlexPay retry could not be re-priced')
        await endFlexPayRetries(claimed, 'GAM could not re-price the retry')
      }
      continue  // skip the confirm — don't re-pull the original (wrong) amount
    }

    // 11/5: GAM's own $4 for the bounce goes out with this same pull. Only for
    // an ordinary pull — FlexPay already folds its returned-pull fees into the
    // reprice above, and doing it twice would charge the bounce twice.
    if (!claimed.some((r) => r.entry_description === 'FLEXPAY')) {
      await foldReturnFeesIntoRetry(piId)
    }

    let confirmSent = false
    try {
      // S654: confirm with the bank account the pull was made from. After a
      // failed attempt Stripe sends the intent back to "needs a payment
      // method" and the method rides on last_payment_error instead; a bare
      // confirm(id) then has nothing to pull from. Named explicitly, with the
      // same debit authorization every rent pull carries, the retry pulls the
      // same account the tenant chose.
      const live = await stripe.paymentIntents.retrieve(piId, { expand: ['payment_method'] })
      confirmSent = true
      await stripe.paymentIntents.confirm(piId, retryConfirmParams(live))
      // The actual settlement comes via webhook (payment_intent.succeeded
      // or another payment_intent.payment_failed). Don't mutate status here.
      result.succeeded++
    } catch (e: any) {
      result.failed++
      const errMsg = e?.message ?? String(e)
      result.errors.push({ payment_id: anchorId, stripe_payment_intent_id: piId, error: errMsg })
      logger.error({ err: errMsg }, `[ach-retry] confirm failed for payment intent ${piId}`)

      // S654: did a pull start anyway (the reply was lost, not the request)?
      // Only a pull Stripe says is under way keeps the rows 'processing' (and
      // its credit set aside). Nothing sent, or Stripe says nothing is moving →
      // owed again, the credit given back and the dead intent canceled (S655).
      // If Stripe cannot be asked, the rows stay 'processing' — a stuck row is
      // safer than a second pull of the same money — and the alert says so.
      let liveStatus: string | null = null
      if (confirmSent) {
        try { liveStatus = (await stripe.paymentIntents.retrieve(piId)).status } catch { liveStatus = null }
      }
      const pulling = liveStatus === 'processing' || liveStatus === 'succeeded'
      const unknown = confirmSent && liveStatus === null
      // A failure webhook that already moved the rows (the confirm reached the
      // bank and bounced) has decided this pull: nothing more here.
      const gaveBack = !pulling && !unknown && await giveBackClaim(piId, claimedIds, 'payment_canceled')
      if (gaveBack) {
        await cancelDeadPull(piId, 'the retry could not be sent to the bank')
        await endFlexPayRetries(claimed, 'GAM could not send the retry to the bank')
      }

      // S132: surface to admin. Stripe API errors during retry are rare
      // and signal something operational (auth, rate-limit, bad PI id).
      await createAdminNotification({
        severity: 'warn',
        category: 'ach_retry_confirm_failure',
        title:    `ACH retry confirm failed for payment ${anchorId}`,
        body:     unknown
          ? `${errMsg} — Stripe could not be asked whether the pull started, so its lines are held as in progress. Check ${piId} in Stripe.`
          : pulling
            ? `${errMsg} — but Stripe shows the pull under way (${liveStatus}), so its lines stay in progress and its own success or failure settles them.`
            : gaveBack
              ? `${errMsg} — nothing was pulled: the lines are owed again (the tenant can pay them now) and the pull was canceled.`
              : `${errMsg} — the bank's answer for this pull had already arrived and was handled (a retry scheduled, or the lines owed again); nothing more was changed.`,
        context:  { payment_id: anchorId, payment_ids: claimedIds, stripe_payment_intent_id: piId, intent_status: liveStatus },
      })
    }
  }

  return result
}

type ClaimedRow = {
  id: string; entry_description: string | null; type: string; amount: string
  retry_count: number; return_code: string | null
}

/**
 * The household a bank pull belongs to (its receipt's, else its rows'), for
 * the lock every money writer takes first (moneyPredicates.lockHousehold).
 */
async function pullHousehold(client: PoolClient, piId: string): Promise<{ tenantId: string; landlordId: string } | null> {
  const r = (await client.query<{ tenant_id: string; landlord_id: string }>(
    `SELECT tenant_id, landlord_id FROM tenant_remittances
      WHERE stripe_payment_intent_id = $1 ORDER BY created_at LIMIT 1`, [piId])).rows[0]
    ?? (await client.query<{ tenant_id: string; landlord_id: string }>(
      `SELECT p.tenant_id, COALESCE(l.landlord_id, p.landlord_id) AS landlord_id
         FROM payments p LEFT JOIN leases l ON l.id = p.lease_id
        WHERE p.stripe_payment_intent_id = $1 AND p.tenant_id IS NOT NULL
        ORDER BY (p.type = 'rent') DESC, p.id LIMIT 1`, [piId])).rows[0]
  return r ? { tenantId: r.tenant_id, landlordId: r.landlord_id } : null
}

/**
 * Claim a due pull under the household lock. A pull partly paid another way
 * (stray rows) is not fired: its claimed rows go straight back to owed and the
 * credit it set aside is given back, in the same transaction. Null when there
 * was nothing left to claim.
 */
async function claimPull(piId: string): Promise<{ claimed: ClaimedRow[]; stray: { id: string; status: string }[] } | null> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const who = await pullHousehold(client, piId)
    if (who) await lockHousehold(client, who.tenantId, who.landlordId)
    await client.query(
      `SELECT id FROM payments WHERE stripe_payment_intent_id = $1 ORDER BY id FOR UPDATE`, [piId])
    const claimed = (await client.query<ClaimedRow>(
      `UPDATE payments
          SET retry_count = retry_count + 1,
              last_retry_at = NOW(),
              next_retry_at = NULL,
              status = 'processing'
        WHERE stripe_payment_intent_id = $1
          AND status = 'failed'
          AND retry_count < ${ACH_MAX_RETRIES}
          AND next_retry_at <= NOW()
        RETURNING id, entry_description, type, amount::text AS amount, retry_count, return_code`,
      [piId])).rows.sort((a, b) => a.id.localeCompare(b.id))
    if (claimed.length === 0) { await client.query('COMMIT'); return null }
    const stray = (await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM payments
        WHERE stripe_payment_intent_id = $1 AND NOT (id = ANY($2::uuid[]))
        ORDER BY id`,
      [piId, claimed.map(r => r.id)])).rows
    if (stray.length > 0) {
      // Put the claimed rows back to owed — nothing is being pulled for them —
      // and give back what the pull set aside.
      await client.query(
        `UPDATE payments SET status = 'failed' WHERE id = ANY($1::uuid[]) AND status = 'processing'`,
        [claimed.map(r => r.id)])
      await releasePullCredit(client, piId, 'superseded')
    }
    await client.query('COMMIT')
    return { claimed, stray }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Give back the credit a pull set aside and close its receipt as failed (the rows are owed again). */
async function releasePullCredit(client: PoolClient, piId: string, reason: 'superseded' | 'payment_canceled'): Promise<void> {
  const { releaseHeldForRemittance } = await import('./creditUse')
  const rems = (await client.query<{ id: string }>(
    `SELECT id FROM tenant_remittances WHERE stripe_payment_intent_id = $1 ORDER BY id FOR UPDATE`, [piId])).rows
  for (const rem of rems) {
    await releaseHeldForRemittance(client, rem.id, reason)
    await client.query(
      `UPDATE tenant_remittances SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'processing'`, [rem.id])
  }
}

/**
 * Nothing was pulled for a claimed retry (a reprice that failed, a confirm
 * Stripe says moved nothing): the rows are owed again, with no retry pending,
 * and the credit the pull set aside is given back — the tenant may pay now.
 * Under the household lock.
 *
 * Only when THIS call moved the claimed rows: the failure webhook for the same
 * intent may have got there first (the confirm reached the bank after all and
 * bounced) and already decided — a retry scheduled with the credit kept set
 * aside, or a final failure with it given back. Then nothing is touched here
 * and false is returned: the caller leaves the intent and FlexPay to that
 * decision (a canceled intent would break the retry the tenant was told of).
 */
async function giveBackClaim(piId: string, claimedIds: string[], reason: 'superseded' | 'payment_canceled'): Promise<boolean> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const who = await pullHousehold(client, piId)
    if (who) await lockHousehold(client, who.tenantId, who.landlordId)
    const moved = await client.query(
      `UPDATE payments SET status = 'failed', next_retry_at = NULL
        WHERE id = ANY($1::uuid[]) AND status = 'processing'`, [claimedIds])
    const mine = (moved.rowCount ?? 0) > 0
    // 11/5: AND the return fees the fold put on this pull. They are not in
    // claimedIds — claimPull never saw them, foldReturnFeesIntoRetry stamped
    // them on afterwards — so a give-back left them 'processing' on an intent
    // that was then cancelled: invisible to every ask and resolved by nothing.
    // Heather's two $4 fees landed exactly there on the first real run.
    //
    // They go back to plainly owed, not 'failed': nothing was ever sent for
    // them, and they are off this intent so the next pull can pick them up.
    if (mine) {
      await client.query(
        `UPDATE payments
            SET status = 'pending', stripe_payment_intent_id = NULL
          WHERE stripe_payment_intent_id = $1 AND status = 'processing'
            AND NOT (id = ANY($2::uuid[]))`, [piId, claimedIds])
    }
    if (mine) await releasePullCredit(client, piId, reason)
    await client.query('COMMIT')
    return mine
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * A pull that will not be fired: its intent is canceled at Stripe so it can
 * never be confirmed later (the payment_intent.canceled webhook then changes
 * nothing: its rows are no longer waiting on it). Never throws; a cancel
 * Stripe refuses is told to an admin.
 */
async function cancelDeadPull(piId: string, why: string): Promise<void> {
  try {
    await getStripe().paymentIntents.cancel(piId)
  } catch (e: any) {
    logger.warn({ err: e?.message ?? String(e), piId }, '[ach-retry] a pull that will not be fired could not be canceled')
    await createAdminNotification({
      severity: 'warn',
      category: 'ach_retry_cancel_failed',
      title:    `A bank pull that will not be retried could not be canceled (${piId})`,
      body:     `The retry of ${piId} was not fired (${why}); its lines are owed again and nothing will pull it. ` +
                `Stripe refused the cancel (${e?.message ?? String(e)}): cancel it in Stripe so it does not sit open.`,
      context:  { stripe_payment_intent_id: piId },
    }).catch(() => {})
  }
}

/**
 * A FlexPay pull whose retry was not fired is GAM's failure, never the
 * tenant's bank's (decisions #37.D): FlexPay handles it as a GAM-side
 * collection problem (flexpay.handleFlexPayPaymentNsf with gamSide) — FlexPay
 * stays on, no wait starts, and the collection is made again by the next pull
 * run. Once per pull; never throws.
 */
async function endFlexPayRetries(claimed: ClaimedRow[], why: string): Promise<void> {
  for (const row of claimed.filter((r) => r.entry_description === 'FLEXPAY')) {
    try {
      const { handleFlexPayPaymentNsf } = await import('./flexpay')
      await handleFlexPayPaymentNsf(row.id, undefined, { gamSide: true, why })
    } catch (e) {
      logger.error({ err: e, payment_id: row.id }, '[ach-retry] FlexPay could not be told its retry was not fired')
    }
  }
}

/**
 * S654: tell the tenant (and the landlord side) that a retry they were promised
 * was not fired because part of the pull was paid another way, and what is
 * still owed. Never throws — the cron carries on.
 */
async function notifyRetrySkipped(
  claimed: Array<{ id: string; type: string; retry_count: number; return_code: string | null }>,
  owed: number,
): Promise<void> {
  try {
    const anchor = pickPullAnchor(claimed)
    if (!anchor) return
    const pctx = await pullNoticeContext(anchor.id)
    if (!pctx) return
    const { notifyAchRetriesExhausted } = await import('./notifications')
    const { payNowLink } = await import('./invoiceNotice')
    let payUrl: string | null = null
    try {
      payUrl = payNowLink({ tenant_user_id: pctx.tenant_user_id, tenant_email: pctx.tenant_email })
    } catch (e) {
      logger.error({ err: e, payment_id: anchor.id }, '[ach-retry] pay link failed')
    }
    await notifyAchRetriesExhausted({
      paymentId:          anchor.id,
      tenantUserId:       pctx.tenant_user_id,
      tenantEmail:        pctx.tenant_email,
      tenantName:         pctx.tenant_name,
      landlordId:         pctx.landlord_id_pk,
      landlordRecipients: pctx.landlordRecipients,
      unitNumber:         pctx.unit_number,
      propertyName:       pctx.property_name,
      amount:             owed,
      reason:             (anchor.return_code && ACH_RETURN_CONFIG[anchor.return_code]?.plain) || null,
      finalReason:        'partly_paid',
      attempts:           anchor.retry_count,
      payUrl,
    })
  } catch (e) {
    logger.error({ err: e }, '[ach-retry] retry-skipped notice failed')
  }
}
