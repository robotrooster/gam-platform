/**
 * S113-Phase3: Stripe Payouts engine.
 *
 * Under destination charges (S113 architecture), tenant rent settles to the
 * landlord's Connect balance directly. Outbound payouts to the landlord's
 * external bank fire from THERE, not from GAM's platform balance.
 *
 * `payouts.schedule.interval = 'manual'` is set at Connect-account creation
 * (services/stripeConnect.ts ensureConnectAccount), so Stripe never auto-
 * payouts on its own — GAM is the sole trigger for every connected-account
 * payout.
 *
 * Replaced (S199 confirms):
 *   - The pre-S113 "GAM-rail outbound to landlord bank account" concept
 *   - The S78 disbursementFiring.ts (`stub` / `bank_ach` rail switch) —
 *     file no longer exists; both consumer paths now use this service.
 *
 * Live consumers:
 *   - jobs/autoPayouts.ts → calls firePayoutForConnectAccount for the
 *     Friday batched standard payout cron (Phase 4 — shipped).
 *   - routes/withdrawals.ts → calls firePayoutForConnectAccount for
 *     on-demand manual + instant withdrawals (Phase 5 — shipped).
 *
 * Webhook recording wired from S117 — payout.created / .paid / .failed /
 * .canceled flows through routes/webhooks.ts → recordPayoutEvent and
 * upserts into the connect_payouts table (idempotent on stripe_payout_id).
 */

import Stripe from 'stripe'
import { getStripe } from '../lib/stripe'
import { AppError } from '../middleware/errorHandler'

export type PayoutMethod = 'standard' | 'instant'

interface FirePayoutOpts {
  /** Stripe Connect account id (acct_*). The payout fires against this
   *  account's Stripe balance to its attached external bank. */
  connectAccountId: string
  /** Amount in dollars. Must be > 0. */
  amount: number
  /** 'standard' (free, T+1–T+2 ACH) or 'instant' (1.5% Stripe fee, min
   *  $0.50, lands in minutes). The user-facing surcharge for 'instant'
   *  is the caller's concern (allocation/fee math, not this helper). */
  method?: PayoutMethod
  /** Idempotency key. REQUIRED — protects against duplicate payouts on
   *  retry. Caller derives a deterministic key (e.g. `disp_${row.id}`,
   *  `auto_friday_${connectAccountId}_${yyyy_mm_dd}`). */
  idempotencyKey: string
  /** Stripe metadata stamped on the payout for cross-reference. Values
   *  must be strings ≤ 500 chars per Stripe limits. */
  metadata?: Record<string, string>
  /** Optional description (shows in Stripe Dashboard + bank statements). */
  description?: string
}

/**
 * Fire a Stripe Payout from a connected account's balance to its attached
 * external bank. Returns the Payout object.
 *
 * Throws AppError on validation problems; lets Stripe API errors propagate
 * unchanged so callers can decide how to surface them (queue row 'failed'
 * with the Stripe message, admin notification, etc.).
 */
export async function firePayoutForConnectAccount(opts: FirePayoutOpts): Promise<Stripe.Payout> {
  if (!(opts.amount > 0)) {
    throw new AppError(400, `Payout amount must be positive (got ${opts.amount})`)
  }
  if (!opts.idempotencyKey) {
    throw new AppError(400, 'idempotencyKey is required for connect-account payouts')
  }
  const stripe = getStripe()
  return await stripe.payouts.create(
    {
      amount: Math.round(opts.amount * 100),
      currency: 'usd',
      method: opts.method ?? 'standard',
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    },
    {
      stripeAccount: opts.connectAccountId,
      idempotencyKey: opts.idempotencyKey,
    }
  )
}

interface ConnectBalance {
  /** Available now (cleared funds), in dollars, per currency. */
  available: { currency: string; amount: number }[]
  /** Pending / still settling, in dollars, per currency. */
  pending:   { currency: string; amount: number }[]
  /** Available right now for instant payout, in dollars, per currency.
   *  Subset of `available` — Stripe gates instant eligibility separately
   *  (only certain card-funded balance + some ACH-backed sources). */
  instant_available: { currency: string; amount: number }[]
}

/**
 * Read a connected account's Stripe balance. Phase 4 reads `available[usd]`
 * to size the auto-Friday payout; Phase 5 reads `available` and
 * `instant_available` separately to gate the standard-vs-instant choice.
 */
export async function getConnectBalance(connectAccountId: string): Promise<ConnectBalance> {
  const stripe = getStripe()
  const bal = await stripe.balance.retrieve({ stripeAccount: connectAccountId })
  return {
    available:         bal.available.map((b) => ({ currency: b.currency, amount: b.amount / 100 })),
    pending:           bal.pending.map((b)   => ({ currency: b.currency, amount: b.amount / 100 })),
    instant_available: (bal.instant_available ?? []).map((b) => ({ currency: b.currency, amount: b.amount / 100 })),
  }
}

/**
 * Convenience: read available USD balance in dollars. Returns 0 if the
 * account has no USD bucket (e.g. brand-new Connect account with no
 * settled charges yet).
 */
export async function getAvailableUsdBalance(connectAccountId: string): Promise<number> {
  const bal = await getConnectBalance(connectAccountId)
  const usd = bal.available.find((b) => b.currency === 'usd')
  return usd?.amount ?? 0
}

/**
 * Convenience: read instant-payout-eligible USD balance in dollars.
 */
export async function getInstantAvailableUsdBalance(connectAccountId: string): Promise<number> {
  const bal = await getConnectBalance(connectAccountId)
  const usd = bal.instant_available.find((b) => b.currency === 'usd')
  return usd?.amount ?? 0
}
