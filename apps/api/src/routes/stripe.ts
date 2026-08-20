import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { createTenantAchSetup, getStripe } from '../lib/stripe'
import {
  ensureConnectAccount,
  createOnboardingSession,
  fetchAccountStatus,
  type ConnectEntity,
} from '../services/stripeConnect'
import { assertLiveLandlordMember } from '../services/landlordMembership'
import { microdepositInstruction, type MicrodepositType } from '@gam/shared'
import { logger } from '../lib/logger'

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
// Self-service: onboards the CALLER's own Connect account (entity resolves to
// req.user or their PM company via the inner owner check) — NOT gated on a
// landlord-staff catalog key, which would break property_manager / PM-company
// direct-deposit self-onboarding for no security gain.
stripeRouter.post('/connect/onboarding-session', async (req: any, res, next) => {
  try {
    const body = z.object({
      entity:   z.enum(['user', 'pm_company', 'landlord']),
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
    } else if (entity === 'landlord') {
      // S554 Connect re-anchor: onboard the landlord ENTITY's own account.
      // entityId is the landlords.id. LIVE membership re-check (not JWT) — a
      // removed co-owner must not be able to onboard/re-point the entity's
      // money account with a stale token.
      const landlordId = body.entityId
      if (!landlordId) throw new AppError(400, 'entityId required for landlord entity')
      await assertLiveLandlordMember(req.user!.userId, landlordId)
      entityId = landlordId
      const la = await queryOne<{ business_name: string | null; user_id: string }>(
        `SELECT business_name, user_id FROM landlords WHERE id=$1`, [landlordId])
      if (!la) throw new AppError(404, 'Landlord entity not found')
      businessName = la.business_name
      const callerEmail = (await queryOne<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [req.user!.userId]))?.email
      if (!callerEmail) throw new AppError(400, 'No email available for KYC contact')
      email = callerEmail
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
    const entity = (
      req.query.entity === 'pm_company' ? 'pm_company'
      : req.query.entity === 'landlord' ? 'landlord'
      : 'user'
    ) as ConnectEntity
    let connectAccountId: string | null = null

    if (entity === 'user') {
      const r = await queryOne<{ stripe_connect_account_id: string | null }>(
        `SELECT stripe_connect_account_id FROM users WHERE id=$1`, [req.user!.userId]
      )
      connectAccountId = r?.stripe_connect_account_id ?? null
    } else if (entity === 'landlord') {
      // S554 Connect re-anchor: the entity's own account (COALESCE fallback to
      // the founding owner's user account during the transition). LIVE
      // membership re-check on this money-status surface.
      const landlordId = typeof req.query.entityId === 'string' ? req.query.entityId : null
      if (!landlordId) throw new AppError(400, 'entityId required for landlord entity')
      await assertLiveLandlordMember(req.user!.userId, landlordId)
      const r = await queryOne<{ stripe_connect_account_id: string | null }>(
        `SELECT COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS stripe_connect_account_id
           FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id=$1`, [landlordId]
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

    // S603 (Nic): a tenant may NOT store a card when nothing is due.
    //
    // Stripe bills per AUTHORIZATION, not per successful payment. Saving a card
    // is its own bank ask ($0.26 auth + $0.02 Radar) that collects nothing, so a
    // tenant who stores a card today and pays rent next week costs GAM $0.28 for
    // no reason — the exact waste this rule exists to kill. Card entry belongs at
    // the moment of payment, where ONE authorization can both charge and store.
    //
    // Tenants are also the least mobile users on the platform; card-on-file is a
    // GUEST feature (someone touring between RV parks), not a tenant one.
    // See memory gam-card-on-file-guests-not-tenants + gam-card-auth-cost-model.
    //
    // ACH is unaffected — a bank mandate is not a card authorization, costs
    // nothing to store, and is the rail GAM actively steers rent toward.
    if (method === 'card') {
      const outstanding = await queryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM payments
          WHERE tenant_id = $1
            AND ((status = 'pending' AND stripe_payment_intent_id IS NULL)
                 OR status = 'failed')`,
        [req.user!.profileId]
      )
      if (!outstanding || parseInt(outstanding.n, 10) === 0) {
        throw new AppError(409,
          'You can add a card when a payment is due. Nothing is outstanding right now — ' +
          'to set up automatic payments before then, add a bank account instead.')
      }
    }

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
            // S605 (Nic, DIRECTIVE): "We are not doing the dollar fifty instant
            // verification at all... Remove all reference and options to even
            // show a hint of the instant verification process."
            //
            // So this stays 'microdeposits' — the free path, permanently. That
            // is INCOMPATIBLE with Stripe's PaymentElement, which is why the
            // tenant portal collects routing + account numbers on its own form
            // and calls confirmUsBankAccountSetup directly (apps/tenant
            // payShared.tsx). Do NOT "fix" a PaymentElement error here by
            // switching this to 'automatic' or 'instant' — that re-exposes
            // Financial Connections instant verification at ~$1.50 a pop, which
            // is exactly what this directive rules out. Fix the form instead.
            //
            // S570 (Nic), original: microdeposits, NOT Financial Connections
            // instant — instant bills $1.50/verification.
            payment_method_options: {
              us_bank_account: {
                verification_method: 'microdeposits',
              },
            },
            metadata: { tenantId: req.user!.profileId },
          }
        : {
            customer:             customerId!,
            payment_method_types: ['card'],
            usage:                'off_session',
            // S571: tag the card SetupIntent so the setup_intent.succeeded
            // webhook can identify the tenant and turn on mandatory email 2FA
            // (card = a saved payment method). ACH tags tenantId already.
            metadata: { tenantId: req.user!.profileId, gam_purpose: 'tenant_card_setup' },
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
    // S570: with microdeposit verification the account is NOT verified at
    // confirm time — the SetupIntent sits in requires_action/processing for
    // 1–3 days until the deposits are confirmed, then setup_intent.succeeded
    // (webhooks.ts) flips ach_verified. Only mark verified here if it already
    // succeeded (e.g. a card, or an already-verified reuse).
    const si = await stripe.setupIntents.retrieve(setupIntentId)
    const verified = si.status === 'succeeded'

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
    // S605 (Nic hit this live — "payment method does not belong to this tenant"
    // on a perfectly good bank account): this USED to be
    // `pm.customer !== tenant.stripe_customer_id`. That holds for cards, which
    // attach to the customer the moment setup confirms. It is WRONG for
    // microdeposit ACH: the PaymentMethod stays UNATTACHED (`pm.customer` is
    // null) until the tenant confirms the deposits days later, so the first
    // bank any tenant ever added always 403'd. The bank was accepted by Stripe;
    // GAM simply refused to record it.
    //
    // The SetupIntent is the correct ownership proof and is timing-independent:
    // it is created server-side against THIS tenant's customer, so if it names
    // their customer AND carries the submitted payment method, the PM is
    // theirs. The S406 property is preserved — passing someone else's payment
    // method id still fails, because that PM won't be on this SetupIntent.
    //
    // Scope note: this checks which GAM ACCOUNT the payment method belongs to,
    // NOT whose NAME is on the bank account. A tenant whose rent is paid by a
    // parent, partner, or friend enters that account here and it works — the
    // account holder name is a separate field and is never compared to anything.
    const siCustomerId = typeof si.customer === 'string' ? si.customer : si.customer?.id
    const siPmId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id
    if (siCustomerId !== tenant.stripe_customer_id || siPmId !== paymentMethodId) {
      throw new AppError(403, 'Payment method does not belong to this tenant')
    }
    const bank = pm.us_bank_account

    // Stamp the bank metadata regardless (available on the PM once attached),
    // but only flip ach_verified when the SetupIntent actually succeeded.
    await query(
      `UPDATE tenants SET ach_verified = $1, bank_last4 = $2, bank_routing_last4 = $3 WHERE id = $4`,
      [verified, bank?.last4 || null, bank?.routing_number?.slice(-4) || null, req.user!.profileId]
    )

    // S571: email 2FA is mandatory for every tenant from signup (enforced at
    // login), so no payment-method-triggered flip is needed here.

    // S571: exactly ONE bank on file — a new bank supersedes the old one (swap
    // within type; card is untouched). And ACH becomes the DEFAULT method (Nic:
    // ACH defaults when set up; the tenant can later switch to card).
    try {
      const banks = await stripe.paymentMethods.list({ customer: tenant.stripe_customer_id!, type: 'us_bank_account', limit: 20 })
      for (const opm of banks.data) {
        if (opm.id !== paymentMethodId) await stripe.paymentMethods.detach(opm.id)
      }
      await stripe.customers.update(tenant.stripe_customer_id!, {
        invoice_settings: { default_payment_method: paymentMethodId },
      })
    } catch (e) {
      logger.error({ err: e }, '[stripe] one-bank swap / default set failed')
    }

    if (verified) {
      // Log first-sender detection for NACHA monitoring (only once verified;
      // the microdeposit path logs this from the setup_intent.succeeded webhook).
      await query(`
        INSERT INTO ach_monitoring_log (event_type, tenant_id, bank_fingerprint, notes)
        VALUES ('first_sender', $1, $2, 'New bank account added — first-time sender tracking initiated')`,
        [req.user!.profileId, `${bank?.routing_number}_${bank?.last4}`]
      )
      return res.json({ success: true, verified: true, message: 'Bank account verified. ACH collections active.' })
    }

    const mdType = ((si.next_action as any)?.verify_with_microdeposits?.microdeposit_type
      ?? null) as MicrodepositType | null

    // S605 (Nic): return the bank NAME Stripe resolved from the routing number.
    // The tenant never picks an institution — the routing number identifies it —
    // so echoing "PNC Bank ••1234" back is how they confirm they typed the right
    // account. Without it the only feedback is four digits, which proves nothing
    // about the bank.
    res.json({
      success: true,
      verified: false,
      status: si.status,
      bankName: bank?.bank_name ?? null,
      bankLast4: bank?.last4 ?? null,
      // S605 (Nic): Stripe picks 'amounts' vs 'descriptor_code' per bank, so the
      // instructions must follow what it actually sent — a promise of two
      // deposits followed by a screen asking for a six-digit code reads as a
      // broken account, not a variation.
      microdepositType: mdType,
      arrivalDate: (si.next_action as any)?.verify_with_microdeposits?.arrival_date ?? null,
      message: microdepositInstruction(mdType),
    })
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
    const tenant = await queryOne<{ stripe_customer_id: string | null; ach_verified: boolean }>(
      `SELECT stripe_customer_id, ach_verified FROM tenants WHERE id = $1`,
      [req.user!.profileId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')
    if (!tenant.stripe_customer_id) {
      return res.json({ success: true, data: [] })
    }
    const stripe = getStripe()
    const [achList, cardList, customer] = await Promise.all([
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
      stripe.customers.retrieve(tenant.stripe_customer_id),
    ])
    // S571: which method is the tenant's default (ACH by default; overridable).
    const defaultPmId = (customer && !('deleted' in customer && customer.deleted))
      ? ((customer as any).invoice_settings?.default_payment_method as string | null) ?? null
      : null
    // S570: `verified` gates whether a bank can actually be charged. With
    // microdeposit verification a just-linked bank is attached but NOT yet
    // verified — Stripe rejects a charge against it until the tenant confirms
    // the two deposits (setup_intent.succeeded webhook flips ach_verified).
    // Launch reality is one bank per tenant, so the tenant-level flag is the
    // per-method signal; a multi-bank tenant is a post-launch refinement.
    const ach = achList.data.map((pm) => ({
      id:        pm.id,
      type:      'ach' as const,
      bankName:  pm.us_bank_account?.bank_name ?? null,
      last4:     pm.us_bank_account?.last4 ?? null,
      verified:  !!tenant.ach_verified,
      isDefault: pm.id === defaultPmId,
    }))
    const card = cardList.data.map((pm) => ({
      id:        pm.id,
      type:      'card' as const,
      brand:     pm.card?.brand ?? null,
      last4:     pm.card?.last4 ?? null,
      expMonth:  pm.card?.exp_month ?? null,
      expYear:   pm.card?.exp_year ?? null,
      country:   pm.card?.country ?? null,
      verified:  true,   // cards are chargeable immediately
      isDefault: pm.id === defaultPmId,
    }))
    res.json({ success: true, data: [...ach, ...card] })
  } catch (e) { next(e) }
})

// POST /api/stripe/tenant/confirm-card — after a card SetupIntent succeeds the
// frontend calls this so we enforce exactly ONE card on file (a new card
// supersedes the old; the bank is untouched). Card becomes default only if the
// tenant has no default yet — a saved ACH keeps priority (Nic).
stripeRouter.post('/tenant/confirm-card', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const { paymentMethodId } = z.object({ paymentMethodId: z.string() }).parse(req.body)
    const tenant = await queryOne<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [req.user!.profileId])
    if (!tenant?.stripe_customer_id) throw new AppError(409, 'Stripe customer not initialized')

    const stripe = getStripe()
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
    if (pm.customer !== tenant.stripe_customer_id || pm.type !== 'card') {
      throw new AppError(403, 'Card does not belong to this tenant')
    }
    // Swap: detach any other card on file.
    const cards = await stripe.paymentMethods.list({ customer: tenant.stripe_customer_id, type: 'card', limit: 20 })
    for (const opm of cards.data) {
      if (opm.id !== paymentMethodId) await stripe.paymentMethods.detach(opm.id)
    }
    // Default only if nothing is set yet (don't steal from ACH).
    const customer = await stripe.customers.retrieve(tenant.stripe_customer_id)
    const hasDefault = !('deleted' in customer && customer.deleted)
      && !!(customer as any).invoice_settings?.default_payment_method
    if (!hasDefault) {
      await stripe.customers.update(tenant.stripe_customer_id, {
        invoice_settings: { default_payment_method: paymentMethodId },
      })
    }
    res.json({ success: true, data: { id: paymentMethodId } })
  } catch (e) { next(e) }
})

// PATCH /api/stripe/tenant/default-payment-method — tenant chooses which saved
// method is the default (e.g. switch from ACH to card, accepting card fees).
stripeRouter.patch('/tenant/default-payment-method', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const { paymentMethodId } = z.object({ paymentMethodId: z.string() }).parse(req.body)
    const tenant = await queryOne<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [req.user!.profileId])
    if (!tenant?.stripe_customer_id) throw new AppError(409, 'Stripe customer not initialized')

    const stripe = getStripe()
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
    // Unlike the confirm-setup check above, `pm.customer` is right here: a
    // payment method can only be made the default once it is ATTACHED. But an
    // unattached bank is the ordinary mid-microdeposit state, not a stranger's
    // card, so say which one it is instead of implying the tenant is using
    // someone else's account.
    if (!pm.customer) {
      throw new AppError(409,
        'That bank account isn’t verified yet. Finish the verification Stripe sent you first, ' +
        'then you can make it your default.')
    }
    if (pm.customer !== tenant.stripe_customer_id) {
      throw new AppError(403, 'Payment method does not belong to this tenant')
    }
    await stripe.customers.update(tenant.stripe_customer_id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    })
    res.json({ success: true, data: { defaultPaymentMethodId: paymentMethodId } })
  } catch (e) { next(e) }
})

// ══════════════════════════════════════════════════════════════
// S603 (Nic) — IN-HOUSE MICRODEPOSIT VERIFICATION
//
// Before this, a tenant setting up ACH left GAM entirely: Stripe emailed them a
// link and they confirmed the two deposit amounts on a Stripe-hosted page. Nic:
// keep people in house. They still have to look in their own bank to READ the
// amounts — nothing can change that — but confirming them now happens in GAM.
//
// Flow:
//   1. POST /tenant/setup {method:'ach'} → SetupIntent, microdeposits sent
//   2. GET  /tenant/microdeposits         → is one pending, and which KIND
//   3. POST /tenant/microdeposits/verify  → submit amounts (or descriptor code)
//   4. Stripe fires setup_intent.succeeded → webhook flips tenants.ach_verified
//
// Step 4 is why this could not have worked before today: that event was not
// subscribed on the live endpoint, so verification could never complete no
// matter where it was performed.
//
// Stripe uses one of TWO microdeposit styles depending on the bank:
//   'amounts'         — two deposits under $1; tenant enters both, in cents
//   'descriptor_code' — one $0.01 deposit whose STATEMENT DESCRIPTOR carries a
//                       6-digit code; tenant enters the code
// Both are supported; the GET tells the UI which one to ask for.
// ══════════════════════════════════════════════════════════════

/** The tenant's most recent bank SetupIntent still awaiting microdeposits. */
async function pendingMicrodepositIntent(customerId: string) {
  const stripe = getStripe()
  const list = await stripe.setupIntents.list({ customer: customerId, limit: 10 })
  return list.data.find(si =>
    si.status === 'requires_action' &&
    (si.next_action as any)?.type === 'verify_with_microdeposits') ?? null
}

// GET /api/stripe/tenant/microdeposits — is a verification waiting, and what
// should we ask the tenant for?
stripeRouter.get('/tenant/microdeposits', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const tenant = await queryOne<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [req.user!.profileId])
    if (!tenant?.stripe_customer_id) return res.json({ success: true, data: { pending: false } })

    const si = await pendingMicrodepositIntent(tenant.stripe_customer_id)
    if (!si) return res.json({ success: true, data: { pending: false } })

    const na = (si.next_action as any)?.verify_with_microdeposits ?? {}
    res.json({
      success: true,
      data: {
        pending: true,
        setupIntentId: si.id,
        // 'amounts' | 'descriptor_code' — drives which field the UI shows.
        //
        // S605 (Nic): this used to fall back to 'amounts' when Stripe didn't say.
        // A guess here is worse than an admission — a descriptor-code tenant
        // would be shown two amount boxes for a deposit that has no amounts to
        // read, with no way to enter what they actually received. NULL means
        // "unknown", and the UI offers BOTH inputs rather than picking wrong.
        microdepositType: na.microdeposit_type ?? null,
        arrivalDate: na.arrival_date ?? null,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/stripe/tenant/microdeposits/verify
// Body: { amounts: [number, number] }  (cents)  OR  { descriptorCode: string }
stripeRouter.post('/tenant/microdeposits/verify', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const body = z.object({
      amounts:        z.array(z.number().int().min(1).max(99)).length(2).optional(),
      // S607 (Nic): UPPERCASE server-side, not just in the field. Stripe issues
      // the descriptor code uppercase (SM + 4 characters) and a bank statement
      // may render it either way; a tenant retyping what they see in lowercase
      // must not fail a verification that Stripe counts as a wrong guess and
      // locks after a few. Normalising here covers every client, including any
      // future one that forgets to.
      descriptorCode: z.string().trim().toUpperCase().min(4).max(12).optional(),
    }).parse(req.body ?? {})
    if (!body.amounts && !body.descriptorCode) {
      throw new AppError(400, 'Enter the deposit amounts or the code from your statement')
    }

    const tenant = await queryOne<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [req.user!.profileId])
    if (!tenant?.stripe_customer_id) throw new AppError(404, 'No payment profile on file')

    // Ownership: resolve the SetupIntent from the TENANT'S OWN customer rather
    // than trusting an id from the request body — otherwise a tenant could
    // submit guesses against someone else's pending verification.
    const si = await pendingMicrodepositIntent(tenant.stripe_customer_id)
    if (!si) throw new AppError(409, 'No bank verification is waiting on your account')

    const stripe = getStripe()
    try {
      await stripe.setupIntents.verifyMicrodeposits(
        si.id,
        body.amounts ? { amounts: body.amounts } : { descriptor_code: body.descriptorCode! },
      )
    } catch (err: any) {
      // Stripe counts wrong guesses and locks the SetupIntent after too many.
      // Pass its own wording through — it distinguishes "that's not right, try
      // again" from "this is locked, start over" — rather than flattening both
      // into one message that leaves the tenant stuck.
      const msg: string = err?.raw?.message || err?.message || 'Those amounts did not match'
      throw new AppError(400, msg)
    }

    // Do NOT flip ach_verified here. setup_intent.succeeded is the single place
    // that happens (webhooks.ts), so the microdeposit path and every other path
    // agree, and a Stripe-side confirmation still lands correctly.
    res.json({ success: true, data: { verified: true } })
  } catch (e) { next(e) }
})
