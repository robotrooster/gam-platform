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
 *   4. On 'retry': payment.next_retry_at = NOW() + 3 days, retry_count
 *      stays where it is (incremented by the cron when it fires)
 *   5. On 'permanent': payment.next_retry_at = NULL, status stays
 *      'failed' for the audit trail
 *
 * Daily cron (processAchRetries) walks payments where:
 *   status='failed' AND next_retry_at <= NOW() AND retry_count < 2
 * For each, calls stripe.paymentIntents.confirm to fire the retry,
 * increments retry_count, clears next_retry_at (the next failure will
 * either schedule another retry or terminate).
 */

import type Stripe from 'stripe'
import { ACH_RETURN_CONFIG } from '@gam/shared'
import { query } from '../db'
import { getStripe } from '../lib/stripe'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

/**
 * Extract the NACHA return code from a failed ACH PaymentIntent. Stripe
 * surfaces this on `last_payment_error.payment_method_details.us_bank_account`
 * (deep path — the SDK type is loose around it). Returns null if the
 * code can't be resolved (non-ACH failure, missing details, etc.).
 */
export function extractReturnCode(pi: Stripe.PaymentIntent): string | null {
  const lpe: any = pi.last_payment_error
  if (!lpe) return null
  // Stripe's nested return-details payload — actual key varies by API version
  const details =
    lpe.payment_method_details?.us_bank_account?.return_details ??
    lpe.payment_method?.us_bank_account?.return_details
  if (!details) return null
  return typeof details.code === 'string' ? details.code.toUpperCase() : null
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
  scanned: number
  fired: number
  succeeded: number
  failed: number
  errors: { payment_id: string; error: string }[]
}

/**
 * Daily cron: walk due retries, fire each via stripe.paymentIntents.confirm.
 * Caps at 200 retries per run (defensive — sustained retry storms
 * indicate a deeper issue worth alerting on, not blasting through
 * silently).
 */
export async function processAchRetries(): Promise<RetryResult> {
  const result: RetryResult = {
    scanned: 0, fired: 0, succeeded: 0, failed: 0, errors: [],
  }

  const due = await query<{ id: string; stripe_payment_intent_id: string; retry_count: number }>(
    `SELECT id, stripe_payment_intent_id, retry_count
       FROM payments
      WHERE status = 'failed'
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= NOW()
        AND retry_count < 2
        AND stripe_payment_intent_id IS NOT NULL
      ORDER BY next_retry_at ASC
      LIMIT 200`
  )

  const stripe = getStripe()
  for (const pmt of due) {
    result.scanned++

    // Optimistic claim: bump retry_count + clear next_retry_at + stamp
    // last_retry_at BEFORE firing the Stripe call. Prevents two concurrent
    // cron runs (rare but possible) from double-firing.
    const claimed = await query<{ id: string }>(
      `UPDATE payments
          SET retry_count = retry_count + 1,
              last_retry_at = NOW(),
              next_retry_at = NULL
        WHERE id = $1 AND retry_count < 2 AND next_retry_at <= NOW()
        RETURNING id`,
      [pmt.id]
    )
    if (claimed.length === 0) continue  // Lost the race; skip
    result.fired++

    try {
      await stripe.paymentIntents.confirm(pmt.stripe_payment_intent_id)
      // The actual settlement comes via webhook (payment_intent.succeeded
      // or another payment_intent.payment_failed). Don't mutate status here.
      result.succeeded++
    } catch (e: any) {
      result.failed++
      const errMsg = e?.message ?? String(e)
      result.errors.push({ payment_id: pmt.id, error: errMsg })
      logger.error({ err: errMsg }, `[ach-retry] confirm failed for payment ${pmt.id}`)
      // S132: surface to admin. Stripe API errors during retry are rare
      // and signal something operational (auth, rate-limit, bad PI id).
      // The webhook will still land payment_intent.payment_failed if the
      // confirm itself rejected at Stripe; this alert is for the case
      // where the API call itself didn't reach Stripe successfully.
      await createAdminNotification({
        severity: 'warn',
        category: 'ach_retry_confirm_failure',
        title:    `ACH retry confirm failed for payment ${pmt.id}`,
        body:     errMsg,
        context:  { payment_id: pmt.id, stripe_payment_intent_id: pmt.stripe_payment_intent_id },
      })
    }
  }

  return result
}
