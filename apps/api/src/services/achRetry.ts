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
 *   status='failed' AND next_retry_at <= NOW() AND retry_count < 2
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
 */

import type Stripe from 'stripe'
import { ACH_RETURN_CONFIG, STRIPE_ACH_FAILURE_CODE_TO_RETURN_CODE } from '@gam/shared'
import { query } from '../db'
import { getStripe } from '../lib/stripe'
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
        AND retry_count < 2
        AND stripe_payment_intent_id IS NOT NULL
      GROUP BY stripe_payment_intent_id
      ORDER BY MIN(next_retry_at) ASC, stripe_payment_intent_id
      LIMIT 200`
  )

  const stripe = getStripe()
  for (const { stripe_payment_intent_id: piId } of due) {
    result.scanned++

    // Optimistic claim: bump retry_count + clear next_retry_at + stamp
    // last_retry_at on EVERY row of this pull BEFORE firing the Stripe call.
    // Prevents two concurrent cron runs (rare but possible) from double-firing.
    // S654: and mark them 'processing' — the money is being pulled, so nothing
    // else may take it a second time (see the header).
    const claimed = await query<{
      id: string; entry_description: string | null; type: string; amount: string
      retry_count: number; return_code: string | null
    }>(
      `UPDATE payments
          SET retry_count = retry_count + 1,
              last_retry_at = NOW(),
              next_retry_at = NULL,
              status = 'processing'
        WHERE stripe_payment_intent_id = $1
          AND status = 'failed'
          AND retry_count < 2
          AND next_retry_at <= NOW()
        RETURNING id, entry_description, type, amount::text AS amount, retry_count, return_code`,
      [piId]
    )
    if (claimed.length === 0) continue  // Lost the race; skip
    claimed.sort((a, b) => a.id.localeCompare(b.id))
    const claimedIds = claimed.map((r) => r.id)
    const anchorId = claimed[0].id
    // Put the claimed rows back to owed — nothing is being pulled for them.
    const releaseClaim = () => query(
      `UPDATE payments SET status = 'failed' WHERE id = ANY($1::uuid[]) AND status = 'processing'`,
      [claimedIds])

    // S654: the retry pulls the intent's WHOLE original amount. If any line it
    // covered has since been paid another way — cash recorded at the desk or
    // by the assistant (which settles one charge), a bank deposit matched to
    // one line — that line no longer carries this intent's failed status and
    // was not claimed. Pulling anyway would take that line's money a second
    // time and leave it with no row to land on. So the bank is not retried:
    // the rest stays owed, the tenant is told with a Pay now button, and an
    // admin is alerted.
    const stray = await query<{ id: string; status: string }>(
      `SELECT id, status FROM payments
        WHERE stripe_payment_intent_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [piId, claimedIds])
    if (stray.length > 0) {
      await releaseClaim()
      result.skipped++
      const owed = Math.round(claimed.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100
      logger.warn({ piId, stray: stray.map((r) => r.id) }, '[ach-retry] part of the pull was paid another way; not retried')
      await createAdminNotification({
        severity: 'warn',
        category: 'ach_retry_skipped_partly_paid',
        title:    `ACH retry not fired — part of the payment was paid another way (payment ${anchorId})`,
        body:     `Bank pull ${piId} was due a retry, but ${stray.length} of its lines were not part of it ` +
                  `(now ${stray.map((r) => r.status).join(', ')}). Re-pulling would take the full original ` +
                  `amount, so it was not retried. The other ${claimed.length} line(s), $${owed.toFixed(2)}, ` +
                  `are owed again and the tenant has been asked to pay.`,
        context:  { payment_ids: claimedIds, other_payment_ids: stray.map((r) => r.id), stripe_payment_intent_id: piId },
      })
      await notifyRetrySkipped(claimed, owed)
      continue
    }
    result.fired++

    // FlexPay re-prices the cycle on retry (Consumer ToS § 4.1/4.2): the fee
    // recalculates to the retry day and the bounced attempt's ACH-return fee
    // passes through. This updates the PI amount BEFORE we confirm it. If the
    // reprice fails, skip the confirm (don't pull a stale amount) and alert.
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
      await releaseClaim()  // S654: nothing was pulled — owed again
      continue  // skip the confirm — don't re-pull the original (wrong) amount
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
      // Only a pull Stripe says is under way keeps the rows 'processing'.
      // Nothing sent, or Stripe says nothing is moving → owed again. If Stripe
      // cannot be asked, the rows stay 'processing' — a stuck row is safer
      // than a second pull of the same money — and the alert says so.
      let liveStatus: string | null = null
      if (confirmSent) {
        try { liveStatus = (await stripe.paymentIntents.retrieve(piId)).status } catch { liveStatus = null }
      }
      const pulling = liveStatus === 'processing' || liveStatus === 'succeeded'
      const unknown = confirmSent && liveStatus === null
      if (!pulling && !unknown) await releaseClaim()

      // S132: surface to admin. Stripe API errors during retry are rare
      // and signal something operational (auth, rate-limit, bad PI id).
      // The webhook will still land payment_intent.payment_failed if the
      // confirm itself rejected at Stripe; this alert is for the case
      // where the API call itself didn't reach Stripe successfully.
      await createAdminNotification({
        severity: 'warn',
        category: 'ach_retry_confirm_failure',
        title:    `ACH retry confirm failed for payment ${anchorId}`,
        body:     unknown
          ? `${errMsg} — Stripe could not be asked whether the pull started, so its lines are held as in progress. Check ${piId} in Stripe.`
          : errMsg,
        context:  { payment_id: anchorId, payment_ids: claimedIds, stripe_payment_intent_id: piId, intent_status: liveStatus },
      })
    }
  }

  return result
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
