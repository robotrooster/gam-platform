import { Router } from 'express'
import type Stripe from 'stripe'
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
import {
  loadTenantPaymentMethods,
  removeTenantPaymentMethod,
  setTenantDefaultPaymentMethod,
  recordVerifiedTenantBank,
  recordWaitingTenantBank,
  bankSetupState,
  listWaitingBankSetups,
  BANK_CHECK_RECEIVED,
} from '../services/tenantBankMethods'
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
//   - 'ach':  SetupIntent with MICRODEPOSIT verification (S570/S605 — never
//             Financial Connections instant); the frontend must POST
//             /tenant/confirm-setup afterwards so the server records the bank
//             (verifying, or verified) beside any bank already on file (S655).
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
    let si: Stripe.SetupIntent = await stripe.setupIntents.retrieve(setupIntentId)

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
      throw new AppError(409, 'We could not find the account you were adding. Start again on the Payments page.')
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
    // This step records a BANK ACCOUNT, and nothing else. A card is saved
    // through /tenant/confirm-card; recording a card — or any other kind of
    // payment method Stripe holds — here would mark the tenant as having a
    // verified bank with no bank behind it (the same mistake S571 closed in the
    // webhook). The service checks the same thing again under the lock.
    if (pm.type !== 'us_bank_account') {
      throw new AppError(400, pm.type === 'card'
        ? 'This step is for bank accounts. A card is saved on its own when you add it.'
        : 'This step is for bank accounts. Add your bank account on the Payments page.')
    }
    const bank = pm.us_bank_account

    // ── S655 (Nic, item L): KEEP THE OLD BANK ─────────────────────────────
    //
    // "Adding never removes; new verified bank becomes default; old stays
    // until the tenant deletes it." This used to detach every other bank and
    // write ach_verified = FALSE while the new one waited 1–3 days on its
    // deposits, so a tenant switching banks the week rent was due lost the
    // only account that could pay it, and autopay had nothing to charge.
    //
    // Now nothing is detached here (the tenant removes a bank themselves:
    // DELETE /tenant/payment-methods/:id). A bank waiting on microdeposits only
    // sets bank_pending_since; ach_verified keeps meaning "has a verified
    // bank", and bank_last4 keeps naming the verified bank on file — it takes
    // the new one only when there is no verified bank yet. A bank verified
    // already (or later, setup_intent.succeeded) goes through
    // recordVerifiedTenantBank, which makes it the default.
    //
    // A succeeded SetupIntent leaves its bank ATTACHED to the customer. One
    // that is not (pm.customer is empty) was removed by the tenant — replaying
    // its old, succeeded SetupIntent must not mark them bank-verified with no
    // bank on file (ach_verified gates FlexPay and FlexDeposit). The service
    // checks the same thing again under the tenant's bank lock, which also
    // covers a removal that lands between this read and the write.
    //
    // Only a setup Stripe is really waiting on is recorded as "a bank waiting
    // on deposits" (services/tenantBankMethods.bankSetupState). A bank the
    // tenant removed while it was still verifying has a CANCELED setup;
    // replaying it here used to answer "We sent a small verification
    // deposit…", restart the reminders and, with no verified bank, put the
    // removed bank's last 4 on file. A setup whose bank failed
    // (requires_payment_method) is not waiting on anything either.
    const removed = new AppError(409,
      'That bank was removed from your account, so it can no longer be used. ' +
      'To use it again, add it as a new bank on the Payments page.')
    const notSetUp = new AppError(409, 'That bank could not be set up. Add it again on the Payments page.')
    const firstState = bankSetupState(si)
    if (firstState === 'removed') throw removed
    if (firstState === 'not_set_up') throw notSetUp
    let state = firstState
    if (state === 'waiting') {
      // Read again and written under the tenant's bank lock (a removal takes it
      // too and cancels the setup before it commits).
      const waiting = await recordWaitingTenantBank({
        tenantId: req.user!.profileId,
        setupIntentId,
        paymentMethodId,
        bank,
      })
      if (waiting.state === 'removed') throw removed
      if (waiting.state === 'not_set_up') throw notSetUp
      if (waiting.setupIntent) si = waiting.setupIntent
      // 'verified' when the deposits were confirmed in between.
      state = waiting.state
    }
    const verified = state === 'verified'
    if (verified) {
      // The payment method read above is current only when the setup had
      // already succeeded then; one verified in between was read unattached,
      // so its owner is left to the service's own check under the lock.
      const pmCustomer = typeof pm.customer === 'string' ? pm.customer : pm.customer?.id ?? null
      if (firstState === 'verified' && pmCustomer !== tenant.stripe_customer_id) throw removed
      const recorded = await recordVerifiedTenantBank({
        tenantId: req.user!.profileId,
        customerId: tenant.stripe_customer_id,
        paymentMethodId,
        bank,
        makeDefault: 'always',
        note: 'New bank account added — first-time sender tracking initiated',
      })
      if (recorded.refused) throw removed
    }

    // ── S641: TELL THEM THE DEPOSIT IS COMING, NOW ──────────────────────────
    //
    // Nic: "do we have it set up where as soon as Stripe sends the microdeposits
    // or the verification code, it will email the tenant as well?"
    //
    // We did not, and the cost was visible: Dominic Gonzalez started a setup on
    // September 2 and sat in `requires_action` for nine days. Nothing told him
    // anything was coming, so there was nothing to act on.
    //
    // Done HERE rather than from a webhook on purpose. This response is the
    // first moment the fact exists, and it already carries everything the email
    // needs — the arrival date Stripe computed and Stripe's own hosted
    // verification page. A webhook would say the same thing later, or not at all.
    //
    // Fire-and-forget: a mail hiccup must never fail a bank setup that
    // succeeded. The nudge job is the backstop if this never lands.
    if (!verified) {
      const na: any = (si as any).next_action
      const md = na?.type === 'verify_with_microdeposits' ? na.verify_with_microdeposits : null
      if (md) {
        void (async () => {
          try {
            const who = await queryOne<any>(
              `SELECT u.email, u.first_name FROM tenants t JOIN users u ON u.id = t.user_id
                WHERE t.id = $1`, [req.user!.profileId])
            if (!who?.email) return
            const { emailVerifyBankReminder } = await import('../services/email')
            await emailVerifyBankReminder(who.email, {
              tenantName: who.first_name || 'there',
              bankLast4: bank?.last4 || null,
              arrivedOn: new Date((md.arrival_date ?? Math.floor(Date.now() / 1000)) * 1000)
                .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Phoenix' }),
              verificationKind: md.microdeposit_type === 'amounts' ? 'amounts' : 'descriptor_code',
              verifyUrl: md.hosted_verification_url || '',
              kind: 'sent',
            }, { tenantId: req.user!.profileId ?? undefined })
          } catch (e) {
            logger.error({ err: e }, '[bank-verify] first notice failed')
          }
        })()
      }
    }

    // S571: email 2FA is mandatory for every tenant from signup (enforced at
    // login), so no payment-method-triggered flip is needed here.
    //
    // S654: a bank still waiting on its deposits is never made the default
    // here — it stays unattached until its code is confirmed and Stripe
    // refuses it ("The customer does not have a payment method with the ID
    // ..."). The verified path above (recordVerifiedTenantBank) sets the
    // default and logs the NACHA first-time sender once per bank.
    if (verified) {
      return res.json({ success: true, verified: true, message: 'Bank account verified. ACH collections active.' })
    }

    // Stripe is checking deposits the tenant already entered (a confirm-setup
    // replayed after they verified, or a reload): there is no deposit coming
    // and no form to fill in — GET /tenant/microdeposits asks for nothing — so
    // say it was received and is being checked, never "we sent a deposit".
    if (si.status === 'processing') {
      return res.json({
        success: true,
        verified: false,
        status: si.status,
        verificationStep: 'checking',
        bankName: bank?.bank_name ?? null,
        bankLast4: bank?.last4 ?? null,
        microdepositType: null,
        arrivalDate: null,
        message: BANK_CHECK_RECEIVED,
      })
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
      verificationStep: 'deposits',
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

// GET /api/stripe/tenant/payment-methods — the calling tenant's saved
// payment methods (S169), each with ITS OWN state (S655, item L):
//   verified   Stripe confirmed the account (microdeposits done)
//   verifying  waiting on that step — never pre-select or charge it
//   verificationStep  'deposits' (Stripe waits on the tenant to confirm the
//              microdeposits) or 'checking' (Stripe is checking what they
//              entered — nothing left for them to do); null once verified
//   chargeable verified, and bank payments are not suspended for this tenant
//   isDefault, autopayPinned
//   canRemove / removeBlockedReason — the same sentence the DELETE would refuse
//     with, so the screen can say it before the tap.
// Before S655 every bank's `verified` was the tenant-level flag, which was
// fine for one bank per tenant and wrong the moment the old bank is kept.
//
// S637 still holds: a bank mid-verification is not attached to the customer in
// the descriptor-code flow, so it is read off its waiting SetupIntent and
// listed as verifying (services/tenantBankMethods.readStripeMethodFacts).
stripeRouter.get('/tenant/payment-methods', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Tenants only')
    }
    const state = await loadTenantPaymentMethods(req.user!.profileId)
    if (!state) throw new AppError(404, 'Tenant not found')
    res.json({ success: true, data: state.methods })
  } catch (e) { next(e) }
})

// DELETE /api/stripe/tenant/payment-methods/:id — the tenant removes one of
// their own saved methods (S655, item L). Nic: "old stays until the tenant
// deletes it; delete blocked while it is their only verified bank, EXCEPT when
// nothing is owed and autopay is off (moved out); cards not affected."
// A verified bank is also kept, even beside another verified one, while a
// payment made from it is still clearing or set to be tried again — the retry
// runs on that same bank (services/tenantBankMethods.pullBlockFor).
// Refusals are 409 with the reason and the next step; the id is matched only
// against the caller's own Stripe customer, so a guessed id is a 404 and never
// reaches Stripe. Returns the saved methods as they are after the removal.
stripeRouter.delete('/tenant/payment-methods/:id', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const { id } = z.object({ id: z.string().trim().min(1).max(255) }).parse(req.params)
    const result = await removeTenantPaymentMethod(req.user!.profileId, id)
    res.json({ success: true, data: result })
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
    if (!tenant?.stripe_customer_id) {
      throw new AppError(409, 'We could not find the card you were adding. Add it again on the Payments page.')
    }

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
// S655: decided on each bank's own state, under the tenant's bank lock
// (services/tenantBankMethods.setTenantDefaultPaymentMethod). The old check was
// "attached to this customer", which let a bank still verifying become the
// default whenever it was already attached, and autopay then charged a bank
// that could not be charged yet. A card or a verified bank can be chosen; a
// bank still verifying gets 409 with the next step; a method not on the
// tenant's own customer is 403 and never reaches Stripe.
stripeRouter.patch('/tenant/default-payment-method', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const { paymentMethodId } = z.object({ paymentMethodId: z.string().trim().min(1).max(255) }).parse(req.body)
    const data = await setTenantDefaultPaymentMethod(req.user!.profileId, paymentMethodId)
    res.json({ success: true, data })
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

/**
 * The tenant's most recent bank setup still waiting on THEM to confirm the
 * microdeposits. Read from the same list the saved-methods screen, the agent
 * and the nudge use (services/tenantBankMethods.listWaitingBankSetups), so the
 * verify form shows exactly when the screen says a bank is waiting on its
 * deposits. A bank whose deposits Stripe is already checking asks for nothing.
 */
async function pendingMicrodepositIntent(customerId: string) {
  const waiting = await listWaitingBankSetups(getStripe(), customerId)
  return waiting.find((w) => w.awaitingTenant) ?? null
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

    res.json({
      success: true,
      data: {
        pending: true,
        setupIntentId: si.setupIntentId,
        // 'amounts' | 'descriptor_code' — drives which field the UI shows.
        //
        // S605 (Nic): this used to fall back to 'amounts' when Stripe didn't say.
        // A guess here is worse than an admission — a descriptor-code tenant
        // would be shown two amount boxes for a deposit that has no amounts to
        // read, with no way to enter what they actually received. NULL means
        // "unknown", and the UI offers BOTH inputs rather than picking wrong.
        microdepositType: si.microdeposits?.type ?? null,
        arrivalDate: si.microdeposits?.arrivalDate ?? null,
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
      // locks after a few. Normalizing here covers every client, including any
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
    let after: { status?: string } | null = null
    try {
      after = await stripe.setupIntents.verifyMicrodeposits(
        si.setupIntentId,
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
    //
    // S655: say what Stripe says. Accepted entries can leave the setup
    // 'processing' while Stripe checks them — that bank is not verified yet,
    // and there is nothing more for the tenant to do (the saved-methods list
    // calls it 'checking'). It used to answer verified: true either way.
    const verified = after?.status === 'succeeded'
    const checking = after?.status === 'processing'
    res.json({
      success: true,
      data: {
        verified,
        verificationStep: checking ? 'checking' : null,
        message: verified
          ? 'Bank account verified.'
          : checking
            ? BANK_CHECK_RECEIVED
            : 'We received what you entered. Your saved payment methods below show where this bank stands.',
      },
    })
  } catch (e) { next(e) }
})
