import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord, requireAdmin } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { createConnectOnboardingLink, createTenantAchSetup, getStripe } from '../lib/stripe'

export const stripeRouter = Router()
stripeRouter.use(requireAuth)

// POST /api/stripe/connect/onboard — landlord starts Stripe Connect flow
stripeRouter.post('/connect/onboard', requireLandlord, async (req, res, next) => {
  try {
    const landlord = await queryOne<any>(
      `SELECT l.*, u.email FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
      [req.user!.profileId]
    )
    if (!landlord) throw new AppError(404, 'Landlord not found')

    // If they already have a Stripe account, create a new link
    if (landlord.stripe_account_id) {
      const stripe = getStripe()
      const link = await stripe.accountLinks.create({
        account: landlord.stripe_account_id,
        refresh_url: `${process.env.LANDLORD_APP_URL}/onboarding?stripe=refresh`,
        return_url:  `${process.env.LANDLORD_APP_URL}/onboarding?stripe=success`,
        type: 'account_onboarding',
      })
      return res.json({ success: true, data: { url: link.url } })
    }

    const { accountId, url } = await createConnectOnboardingLink({
      landlordId: req.user!.profileId,
      email: landlord.email,
      returnUrl:  `${process.env.LANDLORD_APP_URL || 'http://localhost:3001'}/onboarding?stripe=success`,
      refreshUrl: `${process.env.LANDLORD_APP_URL || 'http://localhost:3001'}/onboarding?stripe=refresh`,
    })

    // Save account ID
    await query(
      `UPDATE landlords SET stripe_account_id = $1 WHERE id = $2`,
      [accountId, req.user!.profileId]
    )

    res.json({ success: true, data: { url } })
  } catch (e) { next(e) }
})

// GET /api/stripe/connect/status — check if landlord account is fully onboarded
stripeRouter.get('/connect/status', requireLandlord, async (req, res, next) => {
  try {
    const landlord = await queryOne<any>(
      `SELECT stripe_account_id, stripe_bank_verified FROM landlords WHERE id = $1`,
      [req.user!.profileId]
    )
    if (!landlord?.stripe_account_id) {
      return res.json({ success: true, data: { connected: false, verified: false } })
    }
    const stripe = getStripe()
    const account = await stripe.accounts.retrieve(landlord.stripe_account_id)
    const verified = account.charges_enabled && account.payouts_enabled

    if (verified && !landlord.stripe_bank_verified) {
      await query(
        `UPDATE landlords SET stripe_bank_verified = TRUE WHERE id = $1`,
        [req.user!.profileId]
      )
    }
    res.json({ success: true, data: {
      connected: true,
      verified,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
    }})
  } catch (e) { next(e) }
})

// POST /api/stripe/tenant/setup — tenant starts ACH bank account setup
stripeRouter.post('/tenant/setup', async (req, res, next) => {
  try {
    const tenant = await queryOne<any>(
      `SELECT t.*, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [req.user!.profileId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')

    // If already has Stripe customer, create new setup intent
    if (tenant.stripe_customer_id) {
      const stripe = getStripe()
      const si = await stripe.setupIntents.create({
        customer: tenant.stripe_customer_id,
        payment_method_types: ['us_bank_account'],
        payment_method_options: {
          us_bank_account: {
            financial_connections: { permissions: ['payment_method'] },
            verification_method: 'instant',
          },
        },
      })
      return res.json({ success: true, data: { clientSecret: si.client_secret, customerId: tenant.stripe_customer_id } })
    }

    const { customerId, clientSecret } = await createTenantAchSetup({
      tenantId: req.user!.profileId,
      email: tenant.email,
    })
    await query(
      `UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`,
      [customerId, req.user!.profileId]
    )
    res.json({ success: true, data: { clientSecret, customerId } })
  } catch (e) { next(e) }
})

// POST /api/stripe/tenant/confirm-setup — after Stripe Elements flow completes
stripeRouter.post('/tenant/confirm-setup', async (req, res, next) => {
  try {
    const { setupIntentId, paymentMethodId } = z.object({
      setupIntentId: z.string(),
      paymentMethodId: z.string(),
    }).parse(req.body)

    const stripe = getStripe()
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
    const bank = pm.us_bank_account

    await query(
      `UPDATE tenants SET ach_verified = TRUE, bank_last4 = $1, bank_routing_last4 = $2 WHERE id = $3`,
      [bank?.last4 || null, bank?.routing_number?.slice(-4) || null, req.user!.profileId]
    )

    // Log first-sender detection for NACHA monitoring
    await query(`
      INSERT INTO ach_monitoring_log (event_type, tenant_id, bank_fingerprint, notes)
      VALUES ('first_sender', $1, $2, 'New bank account added — first-time sender tracking initiated')`,
      [req.user!.profileId, `${bank?.routing_number}_${bank?.last4}`]
    )

    res.json({ success: true, message: 'Bank account verified. ACH collections active.' })
  } catch (e) { next(e) }
})
