/**
 * S258: pos_customer ACH onboarding — public token-gated flow.
 *
 * Mirrors the sublease-invitations public-accept pattern. Token in
 * URL is the only credential — the recipient hasn't signed up for a
 * GAM account (and won't; pos_customers are merchant-owned non-tenant
 * customers). Flow:
 *
 *   1. GET  /:token                — token validity + preview info
 *   2. POST /:token/start          — server creates Stripe customer
 *                                    + SetupIntent (us_bank_account
 *                                    + Financial Connections),
 *                                    returns client_secret
 *   3. Frontend confirms the SetupIntent in-browser via the Stripe
 *      element — Financial Connections takes the user through
 *      OAuth-style bank login
 *   4. POST /:token/complete       — server retrieves the
 *                                    SetupIntent, validates status,
 *                                    extracts bank last4, stamps
 *                                    pos_customers.stripe_customer_id
 *                                    + ach_verified + bank_last4,
 *                                    flips invitation 'accepted'
 *
 * Idempotent — re-running /start on an in-progress invitation
 * returns the original SetupIntent (the invitation row stores the
 * setup_intent_id after first start).
 */

import { Router } from 'express'
import { queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'

export const posCustomerOnboardingRouter = Router()

interface InvitationRow {
  id:              string
  token:           string
  pos_customer_id: string
  landlord_id:     string
  status:          'sent' | 'in_progress' | 'accepted' | 'expired' | 'cancelled'
  setup_intent_id: string | null
  expires_at:      string
}

async function loadInvitation(token: string): Promise<InvitationRow | null> {
  return queryOne<InvitationRow>(
    `SELECT id, token, pos_customer_id, landlord_id, status,
            setup_intent_id, expires_at::text
       FROM pos_customer_invitations
      WHERE token = $1
      LIMIT 1`,
    [token],
  )
}

function isExpired(inv: InvitationRow): boolean {
  return new Date(inv.expires_at).getTime() < Date.now()
}

posCustomerOnboardingRouter.get('/:token', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.token)
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status === 'cancelled') throw new AppError(409, 'Invitation cancelled')
    if (inv.status === 'accepted') throw new AppError(409, 'Already completed')
    if (isExpired(inv)) throw new AppError(410, 'Invitation expired')

    const preview = await queryOne<{
      customer_first_name: string
      customer_last_name:  string
      customer_email:      string
      merchant_name:       string
    }>(
      `SELECT pc.first_name AS customer_first_name,
              pc.last_name  AS customer_last_name,
              pc.email      AS customer_email,
              COALESCE(l.business_name, u.first_name || ' ' || u.last_name) AS merchant_name
         FROM pos_customers pc
         JOIN landlords l ON l.id = pc.landlord_id
         JOIN users u     ON u.id = l.user_id
        WHERE pc.id = $1`,
      [inv.pos_customer_id],
    )
    if (!preview) throw new AppError(404, 'Customer record missing')

    res.json({
      success: true,
      data: {
        ...preview,
        expires_at: inv.expires_at,
        status:     inv.status,
      },
    })
  } catch (e) { next(e) }
})

posCustomerOnboardingRouter.post('/:token/start', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.token)
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status === 'cancelled') throw new AppError(409, 'Invitation cancelled')
    if (inv.status === 'accepted') throw new AppError(409, 'Already completed')
    if (isExpired(inv)) throw new AppError(410, 'Invitation expired')

    const customer = await queryOne<{ id: string; first_name: string; last_name: string; email: string; stripe_customer_id: string | null }>(
      `SELECT id, first_name, last_name, email, stripe_customer_id
         FROM pos_customers WHERE id = $1`,
      [inv.pos_customer_id],
    )
    if (!customer) throw new AppError(404, 'Customer record missing')

    const stripe = getStripe()

    // Create or reuse Stripe customer. If a stripe_customer_id was
    // stamped earlier (admin or prior onboarding attempt), reuse it.
    let stripeCustomerId = customer.stripe_customer_id
    if (!stripeCustomerId) {
      const cust = await stripe.customers.create({
        email:    customer.email,
        name:     customer.first_name + ' ' + customer.last_name,
        metadata: {
          gam_purpose:        'pos_customer_ach_onboarding',
          gam_pos_customer_id: customer.id,
        },
      })
      stripeCustomerId = cust.id
      await queryOne(
        `UPDATE pos_customers SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2`,
        [stripeCustomerId, customer.id],
      )
    }

    // Reuse the SetupIntent if /start was already called on this
    // invitation (rare — typically frontend would complete or
    // restart cleanly).
    let setupIntentId = inv.setup_intent_id
    let clientSecret: string | null = null
    if (setupIntentId) {
      const existing = await stripe.setupIntents.retrieve(setupIntentId)
      if (existing.status === 'succeeded') {
        // Customer already verified — return early; caller hits /complete.
        clientSecret = existing.client_secret ?? null
      } else if (existing.status === 'canceled') {
        // Stale — create a new one
        setupIntentId = null
      } else {
        clientSecret = existing.client_secret ?? null
      }
    }

    if (!setupIntentId) {
      const si = await stripe.setupIntents.create({
        customer:             stripeCustomerId,
        payment_method_types: ['us_bank_account'],
        payment_method_options: {
          us_bank_account: {
            financial_connections: { permissions: ['payment_method', 'balances'] },
            verification_method:   'instant',
          },
        },
        metadata: {
          gam_purpose:         'pos_customer_ach_onboarding',
          gam_pos_customer_id: customer.id,
          gam_invitation_id:   inv.id,
        },
      })
      setupIntentId = si.id
      clientSecret = si.client_secret ?? null

      await queryOne(
        `UPDATE pos_customer_invitations
            SET setup_intent_id = $1,
                status          = 'in_progress',
                updated_at      = NOW()
          WHERE id = $2`,
        [setupIntentId, inv.id],
      )
    }

    res.json({
      success: true,
      data: {
        stripe_customer_id: stripeCustomerId,
        client_secret:      clientSecret,
        setup_intent_id:    setupIntentId,
      },
    })
  } catch (e) { next(e) }
})

posCustomerOnboardingRouter.post('/:token/complete', async (req, res, next) => {
  try {
    const inv = await loadInvitation(req.params.token)
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.status === 'accepted') {
      // Idempotent re-completion — return success
      return res.json({ success: true, data: { status: 'accepted' } })
    }
    if (!inv.setup_intent_id) {
      throw new AppError(400, 'Onboarding not started — call /start first')
    }
    // S418 (S405 finding): /complete now enforces expiry, matching
    // the gate already present on GET /:token and POST /:token/start.
    // Pre-fix an in-flight flow could complete after expiry — the
    // customer's Stripe SetupIntent was still valid (Stripe doesn't
    // know about our invitation expires_at), so they could finish
    // bank verification past our window. Now consistent: expired
    // invitations can't complete, even mid-flow.
    if (isExpired(inv)) throw new AppError(410, 'Invitation expired')

    const stripe = getStripe()
    const si = await stripe.setupIntents.retrieve(inv.setup_intent_id, {
      expand: ['payment_method'],
    })
    if (si.status !== 'succeeded') {
      throw new AppError(409, `SetupIntent status is ${si.status}, expected 'succeeded'`)
    }

    // Extract bank last4 from the attached payment method
    const pm = si.payment_method as any
    const bankLast4 = pm?.us_bank_account?.last4 ?? null

    // S418 (S405 finding): refuse to stamp ach_verified=TRUE when we
    // couldn't extract the bank identifier. Pre-fix the verification
    // flag flipped regardless, leaving rows with verified=TRUE +
    // bank_last4=NULL. Downstream NACHA monitoring + UI
    // disambiguation expect the pair to be present together.
    // SetupIntents are created with payment_method_types:
    // ['us_bank_account'] only, so a missing us_bank_account block
    // on a succeeded SetupIntent is a defensive case (Stripe API
    // contract change, malformed expand, etc.) — refuse and 422.
    if (!bankLast4) {
      throw new AppError(422, 'Bank verification incomplete: bank identifier missing on the verified SetupIntent. Re-run /start to retry.')
    }

    await queryOne(
      `UPDATE pos_customers
          SET ach_verified = TRUE,
              bank_last4   = $1,
              updated_at   = NOW()
        WHERE id = $2`,
      [bankLast4, inv.pos_customer_id],
    )

    // Make the verified payment method the customer's default so
    // statement-billing cron picks it up via
    // invoice_settings.default_payment_method.
    if (pm?.id && si.customer) {
      try {
        await stripe.customers.update(String(si.customer), {
          invoice_settings: { default_payment_method: pm.id },
        })
      } catch (e) {
        logger.error({ err: e }, '[POS-CUSTOMER-ONBOARDING] default PM set failed:')
      }
    }

    await queryOne(
      `UPDATE pos_customer_invitations
          SET status      = 'accepted',
              accepted_at = NOW(),
              updated_at  = NOW()
        WHERE id = $1`,
      [inv.id],
    )

    res.json({
      success: true,
      data: { status: 'accepted', bank_last4: bankLast4 },
    })
  } catch (e) { next(e) }
})
