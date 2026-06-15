// Stripe Connect Express helpers — S115. The rebuild started at S114 with
// schema only; this module provides the service layer that creates Connect
// accounts and Account Session tokens for the embedded onboarding component.
//
// Architecture (locked S113):
//   - Connect Express, controller-based config:
//       stripe_dashboard.type      = 'express'
//       fees.payer                 = 'application' (GAM)
//       losses.payments            = 'application' (GAM eats chargebacks)
//   - Per-user Connect account (one per `users.id` for landlords + opt-in
//     managers). PM companies always get one (`pm_companies.id`).
//   - Embedded onboarding ONLY (`<ConnectAccountOnboarding />` rendered
//     inside GAM's URL via Account Session client_secret). All
//     post-onboarding surfaces are GAM-native.
//   - Capabilities requested at creation time: card_payments, transfers
//     (us_bank_account inferred). Stripe activates them after KYC clears.
//
// Idempotency: the create flow checks the calling entity's existing
// stripe_connect_account_id before creating. Re-onboarding (account already
// exists, KYC incomplete) reuses the existing account and just regenerates
// the session token.

import Stripe from 'stripe'
import { getStripe } from '../lib/stripe'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

export type ConnectEntity = 'user' | 'pm_company' | 'business'

interface CreateConnectAccountOpts {
  entity: ConnectEntity
  entityId: string                      // users.id or pm_companies.id
  email: string                         // KYC contact
  businessName?: string | null          // pm_companies.name when entity='pm_company'
  country?: string                      // default 'US'
  metadata?: Record<string, string>
}

/**
 * Create a Stripe Connect Express account for a user or pm_company.
 * Persists the resulting account id on the corresponding GAM row.
 * Idempotent — if the entity already has a Connect account id, returns that.
 */
export async function ensureConnectAccount(opts: CreateConnectAccountOpts): Promise<string> {
  const existing = await fetchExistingConnectId(opts.entity, opts.entityId)
  if (existing) return existing

  const stripe = getStripe()
  const account = await stripe.accounts.create({
    // Controller-based config per Stripe's modern API (email confirmed
    // "Dashboard: express, Fee collection: application, Loss
    // responsibility: application").
    controller: {
      stripe_dashboard: { type: 'express' },
      fees:             { payer: 'application' },
      losses:           { payments: 'application' },
    },
    country: opts.country ?? 'US',
    email:   opts.email,
    business_profile: opts.businessName ? { name: opts.businessName } : undefined,
    capabilities: {
      card_payments: { requested: true },
      transfers:     { requested: true },
    },
    // S117: manual payout schedule. GAM controls the auto-Friday cadence
    // by triggering Payouts via the API; without this Stripe defaults to
    // its own daily schedule and we lose batching control.
    settings: {
      payouts: {
        schedule: { interval: 'manual' },
      },
    },
    metadata: {
      gam_entity:    opts.entity,
      gam_entity_id: opts.entityId,
      ...(opts.metadata ?? {}),
    },
  })

  await persistConnectId(opts.entity, opts.entityId, account.id)
  return account.id
}

/**
 * Create an Account Session for the embedded `<ConnectAccountOnboarding />`
 * component. Returns the client_secret the frontend hands to Stripe's
 * embedded SDK to render the onboarding flow inside GAM's URL.
 *
 * Account Sessions are short-lived (a few minutes). The frontend should
 * fetch a fresh one each time the onboarding component mounts.
 */
export async function createOnboardingSession(connectAccountId: string): Promise<string> {
  const stripe = getStripe()
  const session = await stripe.accountSessions.create({
    account: connectAccountId,
    components: {
      account_onboarding: { enabled: true },
    },
  })
  if (!session.client_secret) {
    throw new AppError(500, 'Stripe returned an Account Session with no client_secret')
  }
  return session.client_secret
}

/**
 * Read the live Connect account state from Stripe. Used to surface
 * onboarding progress + payout-eligibility state in GAM's UI.
 */
export async function fetchAccountStatus(connectAccountId: string): Promise<{
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
  requirements_currently_due: string[]
  requirements_past_due: string[]
  requirements_disabled_reason: string | null
}> {
  const stripe = getStripe()
  const acct = await stripe.accounts.retrieve(connectAccountId)
  return {
    charges_enabled:               !!acct.charges_enabled,
    payouts_enabled:               !!acct.payouts_enabled,
    details_submitted:             !!acct.details_submitted,
    requirements_currently_due:    acct.requirements?.currently_due ?? [],
    requirements_past_due:         acct.requirements?.past_due ?? [],
    requirements_disabled_reason:  acct.requirements?.disabled_reason ?? null,
  }
}

// ── DESTINATION CHARGES (S116) ────────────────────────────────────────────
//
// Under Connect Express, tenant rent payments are PaymentIntents with
// `transfer_data.destination` set to the landlord's Connect account and
// `application_fee_amount` set to GAM's platform cut. Stripe handles the
// money split at charge time:
//   gross → landlord's Connect balance (settled per their payout schedule)
//   application_fee_amount → GAM's platform balance
// GAM still writes a `user_balance_ledger` entry on settlement (via
// allocation.ts) for audit / dashboard purposes; the actual money has
// already moved.
//
// PM company cut math (split between landlord + PM company): handled
// post-settlement via `Transfer` from landlord's Connect to PM's Connect.
// See S116/S119 PM Companies refactor.

interface CreateRentDestinationChargeOpts {
  amount: number                          // gross in dollars
  stripeCustomerId: string                // tenant's Stripe customer
  paymentMethodId: string                 // tenant's saved ACH or card pm
  paymentMethodTypes: ('us_bank_account' | 'card')[]
  destinationConnectAccountId: string     // landlord's stripe_connect_account_id
  applicationFeeAmount: number            // GAM's cut in dollars (will be cents-rounded)
  entryDescription: string                // NACHA-shaped (RENT/SUBSCRIP/etc)
  metadata?: Record<string, string>
}

/**
 * Create a destination-charge PaymentIntent for a rent payment.
 * Returns the created intent. The webhook handler picks up settlement
 * via `payment_intent.succeeded` and runs allocation for ledger audit.
 */
export async function createRentDestinationCharge(opts: CreateRentDestinationChargeOpts) {
  const stripe = getStripe()
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(opts.amount * 100),
    currency: 'usd',
    customer: opts.stripeCustomerId,
    payment_method: opts.paymentMethodId,
    payment_method_types: opts.paymentMethodTypes,
    confirm: true,
    transfer_data: {
      destination: opts.destinationConnectAccountId,
    },
    application_fee_amount: Math.round(opts.applicationFeeAmount * 100),
    description: `${opts.entryDescription} - Gold Asset Management`,
    metadata: { entry_description: opts.entryDescription, ...(opts.metadata ?? {}) },
    // Required for ACH per S64 (mandate-data + financial_connections)
    ...(opts.paymentMethodTypes.includes('us_bank_account')
      ? {
          mandate_data: {
            customer_acceptance: {
              type: 'online' as const,
              online: { ip_address: '0.0.0.0', user_agent: 'GAM-Platform/1.0' },
            },
          },
          payment_method_options: {
            us_bank_account: {
              financial_connections: { permissions: ['payment_method'] as ('payment_method'|'balances')[] },
            },
          },
        }
      : {}),
  })
  return intent
}

// ── PLATFORM CHARGE (S113-PhaseA safety valve) ────────────────────────────
//
// Used when the destination landlord's Connect isn't charges_enabled at
// rent-pay time. Fires a non-destination charge — gross to GAM's platform
// balance. payments.platform_held is flipped true for reconciliation
// later via services/landlordPassthrough.ts.

interface CreateRentPlatformChargeOpts {
  amount: number
  stripeCustomerId: string
  paymentMethodId: string
  paymentMethodTypes: ('us_bank_account' | 'card')[]
  entryDescription: string
  metadata?: Record<string, string>
}

/**
 * Create a standard PaymentIntent — no transfer_data, no
 * application_fee_amount. Gross goes entirely to the platform balance.
 * Caller flips payments.platform_held=true post-confirm.
 */
export async function createRentPlatformCharge(opts: CreateRentPlatformChargeOpts) {
  const stripe = getStripe()
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(opts.amount * 100),
    currency: 'usd',
    customer: opts.stripeCustomerId,
    payment_method: opts.paymentMethodId,
    payment_method_types: opts.paymentMethodTypes,
    confirm: true,
    description: `${opts.entryDescription} - Gold Asset Management`,
    metadata: { entry_description: opts.entryDescription, platform_held: 'true', ...(opts.metadata ?? {}) },
    ...(opts.paymentMethodTypes.includes('us_bank_account')
      ? {
          mandate_data: {
            customer_acceptance: {
              type: 'online' as const,
              online: { ip_address: '0.0.0.0', user_agent: 'GAM-Platform/1.0' },
            },
          },
          payment_method_options: {
            us_bank_account: {
              financial_connections: { permissions: ['payment_method'] as ('payment_method'|'balances')[] },
            },
          },
        }
      : {}),
  })
  return intent
}

/**
 * Compute GAM's `application_fee_amount` for a rent payment.
 * Reads the per-property fee toggle: when 'tenant', the tenant pays the
 * processing fee on top of rent (so GAM's cut = the full processing fee
 * GAM charges). When 'landlord', the landlord absorbs the fee (so the
 * application_fee_amount equals what GAM charges them, deducted from gross).
 *
 * Rates (S113 locked, platform-wide):
 *   ACH:  1.0% capped at $6.00
 *   Card: 3.25% flat
 *   Canadian card USD: +1.5% surcharge passed through to tenant
 *
 * @returns dollar amount (not cents) GAM keeps as application fee
 */
export function computeApplicationFee(opts: {
  amount: number
  paymentMethod: 'ach' | 'card'
  cardCountry?: string | null  // Stripe payment_method.card.country
}): number {
  if (opts.paymentMethod === 'ach') {
    return Math.min(opts.amount * 0.01, 6.00)
  }
  // card: 3.25% + Canadian USD surcharge if applicable
  let pct = 0.0325
  if (opts.cardCountry && opts.cardCountry !== 'US') {
    pct += 0.015
  }
  return Math.round(opts.amount * pct * 100) / 100
}

// ── PM COMPANY TRANSFERS (S119) ───────────────────────────────────────────
//
// Under Connect Express + destination charges, a tenant rent payment lands
// the gross (minus GAM's `application_fee_amount`) on the landlord's
// Connect account. When the property is contracted to a third-party PM
// company, the PM cut needs to physically reach the PM's Connect account
// — not just sit as a "ghost" ledger entry on GAM's books.
//
// Pattern: after the destination charge settles, the platform fires a
// `stripe.transfers.create` from the platform balance to the PM
// company's Connect account. The funds source via `source_transaction`
// referencing the original charge so Stripe routes correctly even
// when platform balance is thin.
//
// Idempotency: each ledger entry that triggers a transfer carries the
// resulting Stripe Transfer id (S119 `stripe_transfer_id` column).
// Re-running the allocation skips rows that already have a transfer id.

interface CreatePmCompanyTransferOpts {
  amount: number                              // dollars
  destinationConnectAccountId: string         // PM company's Connect (acct_*)
  /** Optional Stripe charge id to fund the transfer via source_transaction.
   *  Required when the platform balance might not cover the transfer
   *  (which is most of the time under destination charges — the gross
   *  has already moved to the landlord's Connect). */
  sourceTransactionId?: string
  metadata: Record<string, string>
  description?: string
}

/**
 * Create a Stripe Transfer to a PM company's Connect account.
 * Returns the Transfer object. Caller stamps `transfer.id` onto the
 * triggering ledger row.
 */
export async function createPmCompanyTransfer(opts: CreatePmCompanyTransferOpts) {
  const stripe = getStripe()
  return await stripe.transfers.create({
    amount: Math.round(opts.amount * 100),
    currency: 'usd',
    destination: opts.destinationConnectAccountId,
    ...(opts.sourceTransactionId ? { source_transaction: opts.sourceTransactionId } : {}),
    description: opts.description ?? 'PM company fee',
    metadata: opts.metadata,
  })
}

/**
 * S119 generic post-commit firing helper. Finds any
 * `allocation_pm_company_fee` rows on `user_balance_ledger` linked to the
 * given reference (payment / monthly accrual / lease) that don't yet have
 * a `stripe_transfer_id`, fires a Stripe Transfer for each, and stamps
 * the resulting transfer id on the row. Idempotent: a successfully-fired
 * row gets skipped on subsequent calls. Stripe API errors are logged
 * but don't throw — the ledger row sits without a transfer id and a
 * future reconciliation retries.
 *
 * Call this AFTER your DB transaction commits — it makes Stripe API
 * calls and shouldn't hold transaction locks across network round-trips.
 */
export async function firePmTransfersForReference(
  referenceType: 'payment' | 'pm_monthly_fee_accrual' | 'lease',
  referenceId: string
): Promise<{ fired: number; failed: number }> {
  const rows = await query<{
    id: string
    user_id: string
    amount: string
    bank_account_id: string | null
    notes: string | null
  }>(
    `SELECT id, user_id, amount, bank_account_id, notes
       FROM user_balance_ledger
      WHERE type = 'allocation_pm_company_fee'
        AND reference_type = $1
        AND reference_id   = $2
        AND stripe_transfer_id IS NULL`,
    [referenceType, referenceId]
  )

  // S113-Phase2.5: when reference_type='payment', source the transfer from
  // the original charge so funds pull from the destination Connect's
  // settlement (where destination charges deposited the gross) instead of
  // GAM's platform balance (where only application_fee_amount lands).
  // For accruals + lease references there is no source charge — those
  // legitimately fund from platform balance (accumulated app fees).
  let sourceTransactionId: string | undefined
  if (referenceType === 'payment') {
    const pmtRow = await queryOne<{ stripe_charge_id: string | null }>(
      `SELECT stripe_charge_id FROM payments WHERE id=$1`, [referenceId]
    )
    sourceTransactionId = pmtRow?.stripe_charge_id ?? undefined
  }

  let fired = 0
  let failed = 0
  for (const row of rows) {
    try {
      // Resolve the destination Connect account for this user. The PM
      // company's payout user owns a bank account (snapshotted at allocation
      // time); their stripe_connect_account_id is what we transfer to.
      const destRow = await queryOne<{ stripe_connect_account_id: string | null }>(
        `SELECT stripe_connect_account_id FROM users WHERE id=$1`, [row.user_id]
      )
      if (!destRow?.stripe_connect_account_id) {
        logger.warn(`[pm_transfer] user ${row.user_id} has no Connect account; ledger ${row.id} skipped`)
        failed++
        continue
      }

      const transfer = await createPmCompanyTransfer({
        amount: parseFloat(row.amount),
        destinationConnectAccountId: destRow.stripe_connect_account_id,
        sourceTransactionId,
        metadata: {
          gam_ledger_id:    row.id,
          gam_reference_id: referenceId,
          gam_reference_type: referenceType,
        },
        description: row.notes ?? 'PM company fee',
      })

      await query(
        `UPDATE user_balance_ledger SET stripe_transfer_id=$1 WHERE id=$2`,
        [transfer.id, row.id]
      )
      fired++
    } catch (e) {
      logger.error({ err: e }, `[pm_transfer] failed for ledger ${row.id}`)
      failed++
      // S132: warn — PM cut didn't transfer; ghost row stays on the
      // ledger pending re-fire. Reconciliation will retry, but admin
      // sees the failure rate so they know if Stripe is having a bad day.
      await createAdminNotification({
        severity: 'warn',
        category: 'pm_transfer_failed',
        title:    `PM company transfer failed for ledger row ${row.id}`,
        body:     e instanceof Error ? e.message : String(e),
        context:  { ledger_id: row.id, recipient_user_id: row.user_id, amount_cents: Number(row.amount) * 100 },
      })
    }
  }
  return { fired, failed }
}

// ── IN-HOUSE MANAGER FEE TRANSFERS (S113-Phase1) ──────────────────────────
//
// Mirror of firePmTransfersForReference for type='allocation_manager_fee'.
// Manager-fee ledger rows get written by allocation.ts (per rent payment,
// reference_type='payment') and monthlyFeeAccrual.ts (month-end,
// reference_type='monthly_fee_accrual'). Both paths leave stripe_transfer_id
// NULL until this firing helper picks them up post-commit (or the daily
// reconciliation cron retries failures).
//
// Manager users may not have stripe_connect_account_id yet — Connect
// onboarding is opt-in for managers per CLAUDE.md (default off). Rows for
// managers without Connect are skipped silently. The reconciliation cron
// retries daily; surfaces persistent-stuck rows via the same audit reports
// landlords see for unrouted balances.

/**
 * Fire Stripe Transfers for any unfired manager-fee ledger rows linked to
 * the given reference. Parallels firePmTransfersForReference exactly, just
 * targeting type='allocation_manager_fee' instead. Idempotent: a successfully-
 * fired row gets skipped on subsequent calls.
 *
 * Call AFTER your DB transaction commits — Stripe API calls must not hold
 * transaction locks.
 */
export async function fireManagerTransfersForReference(
  referenceType: 'payment' | 'monthly_fee_accrual',
  referenceId: string
): Promise<{ fired: number; failed: number }> {
  const rows = await query<{
    id: string
    user_id: string
    amount: string
    bank_account_id: string | null
    notes: string | null
  }>(
    `SELECT id, user_id, amount, bank_account_id, notes
       FROM user_balance_ledger
      WHERE type = 'allocation_manager_fee'
        AND reference_type = $1
        AND reference_id   = $2
        AND stripe_transfer_id IS NULL`,
    [referenceType, referenceId]
  )

  // S113-Phase2.5: same source_transaction handling as PM transfers above —
  // per-payment manager fees pull from the original charge; monthly accrual
  // fees fund from platform balance.
  let sourceTransactionId: string | undefined
  if (referenceType === 'payment') {
    const pmtRow = await queryOne<{ stripe_charge_id: string | null }>(
      `SELECT stripe_charge_id FROM payments WHERE id=$1`, [referenceId]
    )
    sourceTransactionId = pmtRow?.stripe_charge_id ?? undefined
  }

  let fired = 0
  let failed = 0
  for (const row of rows) {
    try {
      const destRow = await queryOne<{ stripe_connect_account_id: string | null }>(
        `SELECT stripe_connect_account_id FROM users WHERE id=$1`, [row.user_id]
      )
      if (!destRow?.stripe_connect_account_id) {
        // Manager hasn't opted into Connect yet — leave the ledger row
        // unfired. Reconciliation cron will retry; if the manager never
        // onboards, the row sits as visible balance the same way an
        // unrouted bank_account_id behaves under the GAM-book era.
        logger.warn(`[manager_transfer] user ${row.user_id} has no Connect account; ledger ${row.id} skipped`)
        continue
      }

      // createPmCompanyTransfer is a generic Stripe transfer wrapper despite
      // the name (kept to avoid a refactor outside Phase 1 scope). Override
      // description + metadata to make the manager origin clear in Stripe.
      const transfer = await createPmCompanyTransfer({
        amount: parseFloat(row.amount),
        destinationConnectAccountId: destRow.stripe_connect_account_id,
        sourceTransactionId,
        metadata: {
          gam_ledger_id:      row.id,
          gam_reference_id:   referenceId,
          gam_reference_type: referenceType,
          gam_fee_kind:       'in_house_manager_fee',
        },
        description: row.notes ?? 'In-house manager fee',
      })

      await query(
        `UPDATE user_balance_ledger SET stripe_transfer_id=$1 WHERE id=$2`,
        [transfer.id, row.id]
      )
      fired++
    } catch (e) {
      logger.error({ err: e }, `[manager_transfer] failed for ledger ${row.id}`)
      failed++
      await createAdminNotification({
        severity: 'warn',
        category: 'manager_transfer_failed',
        title:    `In-house manager transfer failed for ledger row ${row.id}`,
        body:     e instanceof Error ? e.message : String(e),
        context:  { ledger_id: row.id, recipient_user_id: row.user_id, amount_cents: Number(row.amount) * 100 },
      })
    }
  }
  return { fired, failed }
}

// ── PAYOUT + DISPUTE WEBHOOK HOOKS (S117) ──────────────────────────────

/**
 * Upsert a `connect_payouts` row from a Stripe Payout webhook event.
 * Cross-platform-safe (skips when stripe_account_id doesn't match a
 * known GAM Connect entity). Idempotent on stripe_payout_id.
 */
export async function recordPayoutEvent(payout: Stripe.Payout, accountId: string): Promise<void> {
  // Resolve which GAM entity owns the Connect account
  const userRow = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE stripe_connect_account_id = $1`, [accountId]
  )
  const pmRow = userRow ? null : await queryOne<{ id: string }>(
    `SELECT id FROM pm_companies WHERE stripe_connect_account_id = $1`, [accountId]
  )
  if (!userRow && !pmRow) return  // Unknown Connect account — silent no-op

  const status = payout.status as string  // pending | paid | failed | canceled | in_transit
  const amountDollars = (payout.amount ?? 0) / 100
  const arrivalDate = payout.arrival_date
    ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
    : null

  await query(
    `INSERT INTO connect_payouts
       (stripe_payout_id, stripe_account_id, user_id, pm_company_id,
        amount, currency, status, destination_bank_id,
        arrival_date, failure_code, failure_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (stripe_payout_id) DO UPDATE
       SET status         = EXCLUDED.status,
           arrival_date   = EXCLUDED.arrival_date,
           failure_code   = EXCLUDED.failure_code,
           failure_message= EXCLUDED.failure_message,
           updated_at     = NOW()`,
    [
      payout.id, accountId,
      userRow?.id ?? null, pmRow?.id ?? null,
      amountDollars, payout.currency ?? 'usd', status,
      typeof payout.destination === 'string' ? payout.destination : null,
      arrivalDate,
      payout.failure_code ?? null,
      payout.failure_message ?? null,
    ]
  )

  // S113-Phase4: propagate the Stripe payout status back to the GAM-side
  // `disbursements` audit row (when one exists for this stripe_payout_id).
  // Maps Stripe status → disbursements status. UPDATE is idempotent and
  // matches at most one row by the unique stripe_payout_id stamp.
  // No-op for pm_companies payouts (no disbursements row written for them
  // in Phase 4 — connect_payouts is the audit source there).
  const dispStatus =
    status === 'paid'                                   ? 'settled'  :
    status === 'failed' || status === 'canceled'        ? 'failed'   :
    status === 'pending' || status === 'in_transit'     ? 'processing':
    null
  if (dispStatus) {
    await query(
      `UPDATE disbursements
          SET status     = $2,
              settled_at = CASE WHEN $2 = 'settled' AND settled_at IS NULL THEN NOW() ELSE settled_at END,
              notes      = CASE
                              WHEN $2 = 'failed' THEN
                                LEFT(COALESCE(notes || E'\n', '') ||
                                     '[' || NOW()::text || '] stripe payout ' || $3 || ': ' || COALESCE($4, '(no message)'),
                                     2000)
                              ELSE notes
                            END
        WHERE stripe_payout_id = $1`,
      [payout.id, dispStatus, payout.failure_code ?? '', payout.failure_message ?? null]
    )
  }

  // S175 / S176: notify the recipient when a Connect payout reaches a
  // terminal status. Two routing paths:
  //   - userRow match (landlord / opt-in manager): single recipient via
  //     users.email/phone.
  //   - pmRow match (PM company): fan-out to active pm_staff with role
  //     IN ('owner','manager'). PM companies have no inherent contact;
  //     the staff list is the addressable audience.
  // Failures swallowed + logged: a bad notification call must not fail
  // the webhook, since Stripe would retry the whole event and re-write
  // the connect_payouts row.
  if ((userRow || pmRow) && (status === 'paid' || status === 'failed')) {
    try {
      if (userRow) {
        const u = await queryOne<{ email: string; phone: string | null }>(
          `SELECT email, phone FROM users WHERE id = $1`, [userRow.id]
        )
        if (u) {
          if (status === 'paid') {
            const { notifyConnectPayoutPaid } = await import('./notifications')
            await notifyConnectPayoutPaid({
              userId:         userRow.id,
              userEmail:      u.email,
              userPhone:      u.phone ?? undefined,
              amount:         amountDollars,
              arrivalDate:    arrivalDate,
              stripePayoutId: payout.id,
            })
          } else {
            const { notifyConnectPayoutFailed } = await import('./notifications')
            await notifyConnectPayoutFailed({
              userId:         userRow.id,
              userEmail:      u.email,
              userPhone:      u.phone ?? undefined,
              amount:         amountDollars,
              reason:         payout.failure_message ?? 'Stripe did not provide a reason',
              failureCode:    payout.failure_code ?? undefined,
              stripePayoutId: payout.id,
            })
          }
        }
      } else if (pmRow) {
        const co = await queryOne<{ name: string }>(
          `SELECT name FROM pm_companies WHERE id = $1`, [pmRow.id]
        )
        if (co) {
          if (status === 'paid') {
            const { notifyPmCompanyPayoutPaid } = await import('./notifications')
            await notifyPmCompanyPayoutPaid({
              pmCompanyId:    pmRow.id,
              pmCompanyName:  co.name,
              amount:         amountDollars,
              arrivalDate:    arrivalDate,
              stripePayoutId: payout.id,
            })
          } else {
            const { notifyPmCompanyPayoutFailed } = await import('./notifications')
            await notifyPmCompanyPayoutFailed({
              pmCompanyId:    pmRow.id,
              pmCompanyName:  co.name,
              amount:         amountDollars,
              reason:         payout.failure_message ?? 'Stripe did not provide a reason',
              failureCode:    payout.failure_code ?? undefined,
              stripePayoutId: payout.id,
            })
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, '[connect-payout-notify] failed:')
    }
  }
}

/**
 * Insert / update a `connect_disputes` row from a Stripe Dispute event.
 * Idempotent on stripe_dispute_id.
 */
export async function recordDisputeEvent(dispute: Stripe.Dispute): Promise<void> {
  // Resolve linked GAM payment via the disputed charge / PaymentIntent
  const piId = typeof dispute.payment_intent === 'string'
    ? dispute.payment_intent
    : dispute.payment_intent?.id ?? null
  const paymentRow = piId ? await queryOne<{ id: string; landlord_id: string }>(
    `SELECT id, landlord_id FROM payments WHERE stripe_payment_intent_id = $1`, [piId]
  ) : null

  const amountDollars = (dispute.amount ?? 0) / 100
  const evidenceDueBy = dispute.evidence_details?.due_by
    ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
    : null

  await query(
    `INSERT INTO connect_disputes
       (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id,
        payment_id, landlord_id,
        amount, currency, reason, status, evidence_due_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (stripe_dispute_id) DO UPDATE
       SET status            = EXCLUDED.status,
           evidence_due_by   = EXCLUDED.evidence_due_by,
           updated_at        = NOW()`,
    [
      dispute.id,
      typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id ?? '',
      piId,
      paymentRow?.id ?? null,
      paymentRow?.landlord_id ?? null,
      amountDollars, dispute.currency ?? 'usd',
      dispute.reason ?? null, dispute.status, evidenceDueBy,
    ]
  )
}

/**
 * Webhook handler hook for `account.updated` events. Stripe pings GAM when
 * a connected account's KYC state changes (verification clears, capabilities
 * activate, requirements get added, etc.). For now we just snapshot the
 * timestamp so we can tell at-a-glance when GAM last saw the account.
 * S118+ will surface state details in the dashboard UI.
 */
export async function recordAccountUpdated(account: Stripe.Account): Promise<void> {
  const charges  = account.charges_enabled  ?? false
  const payouts  = account.payouts_enabled  ?? false
  const details  = account.details_submitted ?? false

  // S160: same readiness flags on users as pm_companies. Either UPDATE
  // matches at most one row (the unique-by-account-id index makes that
  // an invariant); only one of the two will fire per webhook event.
  await query(
    `UPDATE users
        SET stripe_connect_status_synced_at = NOW(),
            connect_charges_enabled    = $2,
            connect_payouts_enabled    = $3,
            connect_details_submitted  = $4
      WHERE stripe_connect_account_id = $1`,
    [account.id, charges, payouts, details]
  )
  // S159: cache the capability flags on pm_companies so
  // acceptPropertyInvitation can gate without a live Stripe round-trip.
  await query(
    `UPDATE pm_companies
        SET stripe_connect_status_synced_at = NOW(),
            connect_charges_enabled    = $2,
            connect_payouts_enabled    = $3,
            connect_details_submitted  = $4
      WHERE stripe_connect_account_id = $1`,
    [account.id, charges, payouts, details]
  )

  // S113-PhaseA: when a Connect account becomes ready (charges + details),
  // try to reconcile any platform_held rent payments that were collected
  // while the landlord's Connect was incomplete. Best-effort — errors get
  // logged + admin-notified inside the helper but don't propagate.
  if (charges && details) {
    const landlordRow = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE stripe_connect_account_id = $1`, [account.id]
    )
    if (landlordRow) {
      const { tryReconcileForLandlordUserId } = await import('./landlordPassthrough')
      await tryReconcileForLandlordUserId(landlordRow.id)
    }
  }
}

// ── BUSINESS INVOICE CHECKOUT (S494) ──────────────────────────────────────
//
// Customers paying a business invoice don't have GAM accounts (per the
// S491 product call — customer-side portal deferred). We use Stripe
// Checkout Sessions hosted on Stripe's domain. The customer follows a
// link in their email, lands on Stripe's checkout page, pays card/ACH,
// and Stripe routes the gross to the business's Connect account.
//
// Application fee (GAM platform cut) is set to 0 for now; the business
// pays Stripe's processing fee (Stripe deducts before transfer). Per-
// invoice fee tuning can dial this in later via a settings field.

interface CreateInvoiceCheckoutOpts {
  amountCents:                 number
  businessConnectAccountId:    string
  invoiceNumber:                string
  customerEmail?:               string | null
  successUrl:                   string
  cancelUrl:                    string
  applicationFeeCents?:         number
  metadata?:                    Record<string, string>
  // S508: when set, ask Stripe to create a Customer + save the card
  // for off-session charges (recurring cycles). The webhook persists
  // the resulting customer + payment method to business_customers.
  saveForFutureUse?:            boolean
  // Reuse an existing platform-side Stripe Customer so the same card
  // can serve multiple businesses paid by the same end-user.
  existingStripeCustomerId?:    string | null
}

export interface InvoiceCheckoutResult {
  sessionId:   string
  hostedUrl:   string
}

/**
 * Create a Stripe Checkout Session for a business invoice. Returns the
 * hosted URL the customer follows. Webhook handler matches on
 * session.id at `checkout.session.completed` to mark the invoice paid.
 */
export async function createInvoiceCheckoutSession(
  opts: CreateInvoiceCheckoutOpts,
): Promise<InvoiceCheckoutResult> {
  const stripe = getStripe()

  // S508: when saveForFutureUse, ask Stripe to create a Customer (or
  // reuse an existing one) and stamp setup_future_usage='off_session'
  // on the PaymentIntent so the resulting PM can be charged later by
  // the recurring cycle without re-prompting the customer.
  const sessionParams: any = {
    mode: 'payment',
    payment_method_types: ['card', 'us_bank_account'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: opts.amountCents,
        product_data: {
          name: `Invoice ${opts.invoiceNumber}`,
        },
      },
    }],
    payment_intent_data: {
      transfer_data: {
        destination: opts.businessConnectAccountId,
      },
      application_fee_amount: opts.applicationFeeCents ?? 0,
      metadata: {
        gam_purpose: 'business_invoice',
        ...(opts.metadata ?? {}),
      },
    },
    metadata: {
      gam_purpose: 'business_invoice',
      ...(opts.metadata ?? {}),
    },
    success_url: opts.successUrl,
    cancel_url:  opts.cancelUrl,
  }

  if (opts.saveForFutureUse) {
    sessionParams.payment_intent_data.setup_future_usage = 'off_session'
    if (opts.existingStripeCustomerId) {
      sessionParams.customer = opts.existingStripeCustomerId
    } else {
      sessionParams.customer_creation = 'always'
      sessionParams.customer_email = opts.customerEmail ?? undefined
    }
  } else {
    sessionParams.customer_email = opts.customerEmail ?? undefined
  }

  const session = await stripe.checkout.sessions.create(sessionParams)
  if (!session.url) {
    throw new AppError(500, 'Stripe returned a Checkout Session with no URL')
  }
  return { sessionId: session.id, hostedUrl: session.url }
}

// ── Internal helpers ──────────────────────────────────────────────────────

async function fetchExistingConnectId(entity: ConnectEntity, entityId: string): Promise<string | null> {
  if (entity === 'user') {
    const row = await queryOne<{ stripe_connect_account_id: string | null }>(
      `SELECT stripe_connect_account_id FROM users WHERE id = $1`, [entityId]
    )
    if (!row) throw new AppError(404, 'User not found')
    return row.stripe_connect_account_id
  }
  if (entity === 'business') {
    // S494: businesses table has its own connect_account_id column.
    const row = await queryOne<{ stripe_connect_account_id: string | null }>(
      `SELECT stripe_connect_account_id FROM businesses WHERE id = $1`, [entityId]
    )
    if (!row) throw new AppError(404, 'Business not found')
    return row.stripe_connect_account_id
  }
  // pm_company
  const row = await queryOne<{ stripe_connect_account_id: string | null }>(
    `SELECT stripe_connect_account_id FROM pm_companies WHERE id = $1`, [entityId]
  )
  if (!row) throw new AppError(404, 'PM company not found')
  return row.stripe_connect_account_id
}

async function persistConnectId(entity: ConnectEntity, entityId: string, connectId: string): Promise<void> {
  if (entity === 'user') {
    await query(
      `UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2 AND stripe_connect_account_id IS NULL`,
      [connectId, entityId]
    )
    return
  }
  if (entity === 'business') {
    // S494
    await query(
      `UPDATE businesses SET stripe_connect_account_id = $1 WHERE id = $2 AND stripe_connect_account_id IS NULL`,
      [connectId, entityId]
    )
    return
  }
  await query(
    `UPDATE pm_companies SET stripe_connect_account_id = $1 WHERE id = $2 AND stripe_connect_account_id IS NULL`,
    [connectId, entityId]
  )
}
