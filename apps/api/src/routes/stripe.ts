import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { createTenantAchSetup, getStripe } from '../lib/stripe'
import {
  ensureConnectAccount,
  createOnboardingSession,
  fetchAccountStatus,
  type ConnectEntity,
} from '../services/stripeConnect'

export const stripeRouter = Router()
stripeRouter.use(requireAuth)

// S115: Connect Express landlord/PM onboarding routes (rebuild).
// The S67 deletion comment is obsolete — Stripe Connect Express IS the
// rail under S113. The new routes here host Account Sessions for the
// embedded `<ConnectAccountOnboarding />` component (Stripe-hosted KYC
// rendered inside GAM's URL). All post-onboarding surfaces (payouts,
// account management, dashboard) are GAM-native — see S118+.

// POST /api/stripe/connect/onboarding-session
// Body: { entity: 'user' | 'pm_company', entityId?: string }
// For entity='user': creates / reuses the caller's own Connect account.
// For entity='pm_company': caller must be role='owner' on the company;
//   entityId is the pm_company.id to onboard.
// Returns the Account Session client_secret the frontend uses to render
// the embedded onboarding component.
stripeRouter.post('/connect/onboarding-session', async (req: any, res, next) => {
  try {
    const body = z.object({
      entity:   z.enum(['user', 'pm_company']),
      entityId: z.string().uuid().optional(),
    }).parse(req.body)

    let entity: ConnectEntity = body.entity
    let entityId: string
    let email: string
    let businessName: string | null = null

    if (entity === 'user') {
      // Caller onboards their own Connect account
      entityId = req.user!.userId
      const u = await queryOne<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [entityId])
      if (!u) throw new AppError(404, 'User not found')
      email = u.email
    } else {
      // pm_company: must own it
      const pmCompanyId = body.entityId
      if (!pmCompanyId) throw new AppError(400, 'entityId required for pm_company')
      const staff = await queryOne<{ role: string; status: string }>(
        `SELECT role, status FROM pm_staff WHERE pm_company_id=$1 AND user_id=$2`,
        [pmCompanyId, req.user!.userId]
      )
      if (!staff || staff.status !== 'active' || staff.role !== 'owner') {
        throw new AppError(403, 'Only an active owner of the PM company can onboard its Connect account')
      }
      entityId = pmCompanyId
      const co = await queryOne<{ name: string; business_email: string | null }>(
        `SELECT name, business_email FROM pm_companies WHERE id=$1`,
        [pmCompanyId]
      )
      if (!co) throw new AppError(404, 'PM company not found')
      businessName = co.name
      // Fall back to caller's email if pm_company has no business email
      const callerEmail = co.business_email
        ?? (await queryOne<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [req.user!.userId]))?.email
      if (!callerEmail) throw new AppError(400, 'No email available for KYC contact')
      email = callerEmail
    }

    const connectAccountId = await ensureConnectAccount({
      entity, entityId, email, businessName,
    })
    const clientSecret = await createOnboardingSession(connectAccountId)
    res.json({ success: true, data: { connectAccountId, clientSecret } })
  } catch (e) { next(e) }
})

// GET /api/stripe/connect/status?entity=user|pm_company&entityId=<uuid?>
// Returns the live Connect account state (KYC progress, capability flags).
// Auth: same scoping as the onboarding-session route.
stripeRouter.get('/connect/status', async (req: any, res, next) => {
  try {
    const entity = (req.query.entity === 'pm_company' ? 'pm_company' : 'user') as ConnectEntity
    let connectAccountId: string | null = null

    if (entity === 'user') {
      const r = await queryOne<{ stripe_connect_account_id: string | null }>(
        `SELECT stripe_connect_account_id FROM users WHERE id=$1`, [req.user!.userId]
      )
      connectAccountId = r?.stripe_connect_account_id ?? null
    } else {
      const pmCompanyId = typeof req.query.entityId === 'string' ? req.query.entityId : null
      if (!pmCompanyId) throw new AppError(400, 'entityId required for pm_company')
      const staff = await queryOne<{ status: string }>(
        `SELECT status FROM pm_staff WHERE pm_company_id=$1 AND user_id=$2`,
        [pmCompanyId, req.user!.userId]
      )
      if (!staff || staff.status !== 'active') {
        throw new AppError(403, 'Not an active staff member of this PM company')
      }
      const r = await queryOne<{ stripe_connect_account_id: string | null }>(
        `SELECT stripe_connect_account_id FROM pm_companies WHERE id=$1`, [pmCompanyId]
      )
      connectAccountId = r?.stripe_connect_account_id ?? null
    }

    if (!connectAccountId) {
      return res.json({ success: true, data: { connectAccountId: null, exists: false } })
    }
    const status = await fetchAccountStatus(connectAccountId)
    res.json({ success: true, data: { connectAccountId, exists: true, ...status } })
  } catch (e) { next(e) }
})

// POST /api/stripe/tenant/setup — tenant starts payment-method setup.
// Body: { method?: 'ach' | 'card' }. Default 'ach' (back-compat).
//   - 'ach':  SetupIntent w/ Financial Connections (instant verification);
//             frontend must POST /tenant/confirm-setup on success so we can
//             stamp ach_verified + bank_last4 server-side.
//   - 'card': SetupIntent w/ payment_method_types:['card']; Stripe attaches
//             the resulting payment_method to the customer automatically
//             on confirmSetup success — no /confirm-setup roundtrip
//             required (the next /payment-methods GET picks it up).
stripeRouter.post('/tenant/setup', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Tenants only')
    }
    const body = z.object({
      method: z.enum(['ach', 'card']).optional(),
    }).parse(req.body ?? {})
    const method = body.method ?? 'ach'

    const tenant = await queryOne<any>(
      `SELECT t.*, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [req.user!.profileId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')

    const stripe = getStripe()

    // Ensure a Stripe customer exists. ACH first-setup uses
    // createTenantAchSetup which both creates the customer and returns the
    // first SetupIntent in one shot; for the card path we just create a
    // bare customer here and then make the SetupIntent below.
    let customerId = tenant.stripe_customer_id as string | null
    if (!customerId) {
      if (method === 'ach') {
        const seed = await createTenantAchSetup({
          tenantId: req.user!.profileId,
          email:    tenant.email,
        })
        await query(
          `UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`,
          [seed.customerId, req.user!.profileId]
        )
        return res.json({
          success: true,
          data: { clientSecret: seed.clientSecret, customerId: seed.customerId, method },
        })
      }
      const customer = await stripe.customers.create({
        email:    tenant.email,
        metadata: { tenantId: req.user!.profileId },
      })
      customerId = customer.id
      await query(
        `UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`,
        [customerId, req.user!.profileId]
      )
    }

    const si = await stripe.setupIntents.create(
      method === 'ach'
        ? {
            customer:             customerId!,
            payment_method_types: ['us_bank_account'],
            payment_method_options: {
              us_bank_account: {
                financial_connections: { permissions: ['payment_method'] },
                verification_method:   'instant',
              },
            },
          }
        : {
            customer:             customerId!,
            payment_method_types: ['card'],
            usage:                'off_session',
          }
    )

    res.json({
      success: true,
      data: { clientSecret: si.client_secret, customerId, method },
    })
  } catch (e) { next(e) }
})

// POST /api/stripe/tenant/confirm-setup — after Stripe Elements flow completes
stripeRouter.post('/tenant/confirm-setup', async (req: any, res, next) => {
  try {
    // S406 fix #1: route was missing the tenant-only check that sibling
    // routes /tenant/setup and /tenant/payment-methods enforce. A non-
    // tenant caller would reach the ach_monitoring_log INSERT and 500
    // on the tenant_id FK violation (FK references tenants(id); the
    // caller's profileId is a landlord_id or other and never matches).
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Tenants only')
    }
    const { setupIntentId, paymentMethodId } = z.object({
      setupIntentId: z.string(),
      paymentMethodId: z.string(),
    }).parse(req.body)

    const stripe = getStripe()
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)

    // S406 fix #2: pre-fix took paymentMethodId from request body without
    // verifying ownership. A tenant could supply another tenant's PM id
    // and stamp THEIR OWN tenants row with foreign bank_last4 — silent
    // data corruption on the caller's verification record. Verify the
    // PM is attached to the caller's Stripe customer before stamping.
    const tenant = await queryOne<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [req.user!.profileId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')
    if (!tenant.stripe_customer_id) {
      throw new AppError(409, 'Stripe customer not initialized — call /tenant/setup first')
    }
    if (pm.customer !== tenant.stripe_customer_id) {
      throw new AppError(403, 'Payment method does not belong to this tenant')
    }
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

// GET /api/stripe/tenant/payment-methods — list saved payment methods on
// the calling tenant's Stripe customer. Used by the Pay Now picker on the
// tenant /payments page (S169). Returns ACH (us_bank_account) entries
// today; `card` slots are included for the follow-on card path so the
// UI shape is stable.
stripeRouter.get('/tenant/payment-methods', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Tenants only')
    }
    const tenant = await queryOne<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [req.user!.profileId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')
    if (!tenant.stripe_customer_id) {
      return res.json({ success: true, data: [] })
    }
    const stripe = getStripe()
    const [achList, cardList] = await Promise.all([
      stripe.paymentMethods.list({
        customer: tenant.stripe_customer_id,
        type: 'us_bank_account',
        limit: 20,
      }),
      stripe.paymentMethods.list({
        customer: tenant.stripe_customer_id,
        type: 'card',
        limit: 20,
      }),
    ])
    const ach = achList.data.map((pm) => ({
      id:       pm.id,
      type:     'ach' as const,
      bankName: pm.us_bank_account?.bank_name ?? null,
      last4:    pm.us_bank_account?.last4 ?? null,
    }))
    const card = cardList.data.map((pm) => ({
      id:        pm.id,
      type:      'card' as const,
      brand:     pm.card?.brand ?? null,
      last4:     pm.card?.last4 ?? null,
      expMonth:  pm.card?.exp_month ?? null,
      expYear:   pm.card?.exp_year ?? null,
      country:   pm.card?.country ?? null,
    }))
    res.json({ success: true, data: [...ach, ...card] })
  } catch (e) { next(e) }
})
