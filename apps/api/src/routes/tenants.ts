import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { emailLandlordBankingNudge } from '../services/email'
import { isDisposableEmail } from '../lib/email'
import { logger } from '../lib/logger'
import { checkLeaseAgainstStateLaw, type LawFlag } from '../services/stateLaw'

export const tenantsRouter = Router()

// ── PRE-AUTH PUBLIC ROUTES ────────────────────────────────────
// Declared BEFORE tenantsRouter.use(requireAuth) below so the
// router-level middleware doesn't gate them. Two flavors:
//   1. Invite onboarding routes — the invite token IS the auth.
//      An invited tenant has no JWT yet when they click the
//      invite link, so requireAuth would 401 them and break
//      onboarding.
//   2. Avatar file serve — used by <img src> elements that don't
//      send the Authorization header. Gating these returned 401
//      to every avatar load (S380 fix). Filename param is sanitized
//      via path.basename to block ../ traversal.

// POST /api/tenants/accept-invite — tenant sets password and activates account
tenantsRouter.post('/accept-invite', async (req, res, next) => {
  try {
    const { token, password, phone, ssiSsdi, acceptedTerms } = req.body
    if (!token || !password) return res.status(400).json({ success: false, error: 'Token and password required' })
    if (password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' })
    if (acceptedTerms !== true) return res.status(400).json({ success: false, error: 'You must accept the Terms of Service and Privacy Policy to activate your account' })

    // S410 (S377): read the purpose-scoped column with 7-day expiry
    // gate. Pre-S410 this query joined to email_verify_token (overloaded
    // across email verification + invites). Expiry-NULL rows (pre-S410
    // legacy) are accepted to keep dev seed data usable; new tokens
    // always carry expires_at.
    const user = await queryOne<any>(
      `SELECT * FROM users
        WHERE tenant_invite_token = $1
          AND (tenant_invite_expires_at IS NULL OR tenant_invite_expires_at > NOW())`,
      [token])
    if (!user) return res.status(404).json({ success: false, error: 'Invalid or expired invite link' })

    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash(password, 10)

    // S29X: stamp terms acceptance on activation. Landlord-created users
    // are inserted with NULL acceptance timestamps; the tenant accepts
    // here when they take over their account for the first time.
    // S410: clear tenant_invite_token AND expiry on accept (single-use).
    await query(`UPDATE users SET password_hash=$1,
                                  tenant_invite_token=NULL,
                                  tenant_invite_expires_at=NULL,
                                  email_verified=TRUE,
                                  phone=COALESCE($2,phone),
                                  accepted_tos_at=NOW(), accepted_privacy_at=NOW()
                 WHERE id=$3`,
      [hash, phone || null, user.id])

    if (ssiSsdi !== undefined) {
      await query('UPDATE tenants SET ssi_ssdi=$1 WHERE user_id=$2', [!!ssiSsdi, user.id])
    }

    // Generate JWT
    const jwt = require('jsonwebtoken')
    const tenant = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [user.id])
    const jwtToken = jwt.sign(
      { userId: user.id, role: 'tenant', email: user.email, profileId: tenant?.id },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    )

    // S174: notify the landlord that their invited tenant accepted. Best-
    // effort — failure here doesn't roll back the activation. Resolves the
    // landlord via the tenant's most-recent active lease; if no lease is
    // attached yet (rare — invitations usually fire from a lease build),
    // skip the notify.
    try {
      // S186: routed through responsible-party resolver. Tenant
      // onboarding is a day-to-day manager event, not owner-financial.
      const ctx = await queryOne<{
        landlord_id_pk: string
        property_id:    string
        unit_number:    string
        property_name:  string
      }>(`
        SELECT l.id  AS landlord_id_pk,
               pr.id AS property_id,
               un.unit_number,
               pr.name AS property_name
          FROM v_lease_active_tenants vlat
          JOIN tenants    t  ON t.id = vlat.tenant_id
          JOIN leases     ls ON ls.id = vlat.lease_id AND ls.status = 'active'
          JOIN units      un ON un.id = ls.unit_id
          JOIN properties pr ON pr.id = un.property_id
          JOIN landlords  l  ON l.id = pr.landlord_id
         WHERE t.user_id = $1
         ORDER BY (vlat.role = 'primary') DESC
         LIMIT 1
      `, [user.id])
      if (ctx) {
        const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
        const targets = await getPropertyResponsibleParty(ctx.property_id)
        if (targets) {
          const { notifyTenantInviteAccepted } = await import('../services/notifications')
          for (const recipient of targets.primaries) {
            await notifyTenantInviteAccepted({
              landlordUserId: recipient.user_id,
              landlordId:     ctx.landlord_id_pk,
              landlordEmail:  recipient.email,
              tenantName:     `${user.first_name} ${user.last_name}`,
              tenantEmail:    user.email,
              unitNumber:     ctx.unit_number,
              propertyName:   ctx.property_name,
            })
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, '[tenant-invite-accepted-notify] failed:')
    }

    res.json({
      success: true,
      data: {
        token: jwtToken,
        user: { id: user.id, email: user.email, role: 'tenant', firstName: user.first_name, lastName: user.last_name }
      }
    })
  } catch (e) { next(e) }
})

// GET /api/tenants/invite-info?token= — get invite details without auth
tenantsRouter.get('/invite-info', async (req, res, next) => {
  try {
    const { token } = req.query
    if (!token) return res.status(400).json({ success: false, error: 'Token required' })

    // S410 (S377): read tenant_invite_token + enforce expiry.
    const user = await queryOne<any>(
      `SELECT id, email, first_name, last_name FROM users
        WHERE tenant_invite_token = $1
          AND (tenant_invite_expires_at IS NULL OR tenant_invite_expires_at > NOW())`,
      [token as string])
    if (!user) return res.status(404).json({ success: false, error: 'Invalid or expired invite' })

    const unit = await queryOne<any>(`
      SELECT u.unit_number, u.rent_amount, p.name as property_name, p.street1, p.city, p.state
      FROM v_lease_active_tenants vlat
      JOIN tenants t ON t.id = vlat.tenant_id
      JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE t.user_id = $1
      ORDER BY (vlat.role = 'primary') DESC
      LIMIT 1`, [user.id])

    res.json({ success: true, data: { user, unit } })
  } catch (e) { next(e) }
})

// GET /api/tenants/avatar-files/:filename — public static serve.
// avatarDir is defined further down (after requireAuth) for the
// POST /avatar route; compute path inline here to avoid hoisting
// the constant above the rest of the module state.
tenantsRouter.get('/avatar-files/:filename', async (req: any, res: any, next: any) => {
  try {
    // path.basename strips any directory components from the param —
    // blocks ../../etc/passwd traversal attempts. Multer writes
    // filenames as Date.now()-randomHex+ext, so a legit filename
    // is always already a basename.
    const safe = path.basename(req.params.filename)
    const fp = path.join(process.cwd(), 'uploads', 'avatars', safe)
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    // S409 (S398 Nic-locked decision): "strong fix" — always serve
    // avatars with image/* Content-Type regardless of on-disk extension.
    // Belt-and-suspenders defense against the XSS extension-mismatch
    // class: even if a legacy file on disk has a .html extension from
    // pre-upload-normalization (or some future upload bug),
    // res.sendFile would normally derive Content-Type from extname →
    // text/html → browser executes as HTML. Pinning the header upfront
    // means the on-disk extension can never drive Content-Type.
    const extLower = path.extname(safe).toLowerCase()
    const contentType =
      extLower === '.png'  ? 'image/png'  :
      extLower === '.webp' ? 'image/webp' :
      extLower === '.gif'  ? 'image/gif'  :
      'image/jpeg'  // .jpg/.jpeg/anything else
    res.setHeader('Content-Type', contentType)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.sendFile(fp)
  } catch(e) { next(e) }
})

// ──────────────────────────────────────────────────────────────
tenantsRouter.use(requireAuth)

// S162: tenant-scoped read of the landlord's Connect-readiness state.
// Tenants need this to know whether paying rent online will succeed
// (the destination charge requires the landlord's Connect account to
// be payout-eligible). Response is intentionally minimal — just a
// boolean — so no other landlord PII leaks across the trust boundary.
tenantsRouter.get('/me/landlord-banking-status', async (req: any, res, next) => {
  try {
    const row = await queryOne<{
      connect_payouts_enabled: boolean
      connect_details_submitted: boolean
    }>(`
      SELECT u.connect_payouts_enabled, u.connect_details_submitted
        FROM tenants t
        JOIN v_lease_active_tenants vlat ON vlat.tenant_id = t.id
        JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        JOIN units un ON un.id = l.unit_id
        JOIN properties pr ON pr.id = un.property_id
        JOIN landlords ll ON ll.id = pr.landlord_id
        JOIN users u ON u.id = ll.user_id
       WHERE t.id = $1
       ORDER BY (vlat.role = 'primary') DESC
       LIMIT 1
    `, [req.user!.profileId])

    // No active lease → unable to pay anyway, but report ready=false so
    // the UI shows the same blocked state.
    const ready = !!row?.connect_payouts_enabled && !!row?.connect_details_submitted
    res.json({ success: true, data: { ready } })
  } catch (e) { next(e) }
})

// S163: tenant nudges landlord to finish Connect onboarding. Rate-limited
// to one nudge per 24 hours per tenant via email_send_log lookup. We don't
// add a dedicated table for this; the audit trail naturally lives in the
// existing log table that captures every send (success and failure).
tenantsRouter.post('/me/nudge-landlord-banking', async (req: any, res, next) => {
  try {
    const tenantId = req.user!.profileId

    const recent = await queryOne<{ id: string }>(`
      SELECT id FROM email_send_log
       WHERE related_entity_type = 'tenant_landlord_nudge'
         AND related_entity_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1
    `, [tenantId])
    if (recent) {
      throw new AppError(429, 'You can send another nudge in 24 hours.')
    }

    const ctx = await queryOne<{
      landlord_id: string
      landlord_email: string
      landlord_first_name: string | null
      landlord_last_name: string | null
      tenant_first_name: string
      tenant_last_name: string
      property_name: string
      unit_number: string
      connect_payouts_enabled: boolean
      connect_details_submitted: boolean
    }>(`
      SELECT
        ll.id          AS landlord_id,
        u_landlord.email      AS landlord_email,
        u_landlord.first_name AS landlord_first_name,
        u_landlord.last_name  AS landlord_last_name,
        u_tenant.first_name   AS tenant_first_name,
        u_tenant.last_name    AS tenant_last_name,
        pr.name        AS property_name,
        un.unit_number AS unit_number,
        u_landlord.connect_payouts_enabled,
        u_landlord.connect_details_submitted
      FROM tenants t
      JOIN users u_tenant ON u_tenant.id = t.user_id
      JOIN v_lease_active_tenants vlat ON vlat.tenant_id = t.id
      JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
      JOIN units un ON un.id = l.unit_id
      JOIN properties pr ON pr.id = un.property_id
      JOIN landlords ll ON ll.id = pr.landlord_id
      JOIN users u_landlord ON u_landlord.id = ll.user_id
      WHERE t.id = $1
      ORDER BY (vlat.role = 'primary') DESC
      LIMIT 1
    `, [tenantId])

    if (!ctx) throw new AppError(404, 'No active lease found')
    if (ctx.connect_payouts_enabled && ctx.connect_details_submitted) {
      throw new AppError(409, 'Landlord banking is already complete; no nudge needed.')
    }

    const landlordName = [ctx.landlord_first_name, ctx.landlord_last_name].filter(Boolean).join(' ') || 'there'
    const tenantName   = [ctx.tenant_first_name,   ctx.tenant_last_name].filter(Boolean).join(' ').trim()

    const bankingUrl = `${process.env.LANDLORD_APP_URL || 'http://localhost:3001'}/banking`

    await emailLandlordBankingNudge({
      to: ctx.landlord_email,
      landlordName,
      tenantName,
      propertyName: ctx.property_name,
      unitNumber: ctx.unit_number,
      bankingUrl,
      ctx: { landlordId: ctx.landlord_id, tenantId },
    })

    res.json({ success: true })
  } catch (e) { next(e) }
})

tenantsRouter.get('/me', async (req, res, next) => {
  try {
    const tenant = await queryOne<any>(`
      SELECT t.*, u.first_name, u.last_name, u.email, u.phone,
        u.stripe_connect_account_id,
        un.id AS unit_id, un.unit_number, un.rent_amount, un.status AS unit_status,
        pr.name AS property_name, pr.street1, pr.city, pr.state,
        sd.total_amount AS deposit_total, sd.collected_amount AS deposit_collected,
        sd.flex_deposit_enabled, sd.installments_remaining,
        CASE
          WHEN sd.id IS NULL THEN false
          WHEN sd.flex_deposit_enabled = true AND sd.installments_remaining > 0 THEN false
          WHEN sd.collected_amount >= sd.total_amount THEN true
          ELSE false
        END AS deposit_fully_funded
      FROM tenants t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN LATERAL (
        SELECT un2.*
        FROM v_lease_active_tenants vlat
        JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        JOIN units un2 ON un2.id = l.unit_id
        WHERE vlat.tenant_id = t.id
        ORDER BY (vlat.role = 'primary') DESC
        LIMIT 1
      ) un ON TRUE
      LEFT JOIN properties pr ON pr.id = un.property_id
      LEFT JOIN security_deposits sd ON sd.tenant_id = t.id
      WHERE t.id = $1`, [req.user!.profileId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    res.json({ success: true, data: tenant })
  } catch (e) { next(e) }
})


// ── GET /api/tenants/me/deposit-interest ─────────────────────────────────
// S189: tenant-facing view of statutory deposit interest. Surfaces the
// principal + collected_amount + cumulative interest_accrued + per-month
// accrual log + the state rate the deposit accrues at. Tenants see what
// they're owed in real-time, not only at move-out.
//
// Returns null deposit when tenant has no security deposit row.
// Returns empty rate / accruals when the deposit's state has no
// hardcoded statutory rate (tenant in NV, AZ, etc.) — UI shows the
// principal but no interest line.
tenantsRouter.get('/me/deposit-interest', async (req, res, next) => {
  try {
    const tenantId = req.user!.profileId

    const deposit = await queryOne<{
      id:                 string
      lease_id:           string
      total_amount:       string
      collected_amount:   string
      interest_accrued:   string
      status:             string
      held_by:            string
      state:              string | null
      property_name:      string | null
      created_at:         string
    }>(
      `SELECT sd.id, sd.lease_id,
              sd.total_amount::text     AS total_amount,
              sd.collected_amount::text AS collected_amount,
              sd.interest_accrued::text AS interest_accrued,
              sd.status, sd.held_by,
              p.state, p.name AS property_name,
              sd.created_at::text AS created_at
         FROM security_deposits sd
         JOIN leases    l ON l.id = sd.lease_id
         JOIN units     u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE sd.tenant_id = $1
        ORDER BY sd.created_at DESC
        LIMIT 1`,
      [tenantId],
    )

    if (!deposit) {
      return res.json({ success: true, data: { deposit: null, rate: null, accruals: [] } })
    }

    // Look up the effective rate for the deposit's state and the
    // current accrual year. Statutory catalog wins; falls back to the
    // landlord's S190 override for variable-rate states. Returns null
    // if neither has a rate — tenant sees principal-only.
    const currentYear = new Date().getUTCFullYear()
    let rate: {
      source:           'statutory' | 'landlord_override'
      state_code:       string
      effective_year:   number
      annual_rate_pct:  string
      statute_citation: string | null
      notes:            string | null
    } | null = null

    if (deposit.state) {
      const statutory = await queryOne<{
        state_code:       string
        effective_year:   number
        annual_rate_pct:  string
        statute_citation: string
        notes:            string | null
      }>(
        `SELECT state_code, effective_year,
                annual_rate_pct::text AS annual_rate_pct,
                statute_citation, notes
           FROM state_deposit_interest_rates
          WHERE state_code = $1 AND effective_year = $2
          LIMIT 1`,
        [deposit.state, currentYear],
      )

      if (statutory) {
        rate = { ...statutory, source: 'statutory' }
      } else {
        // Fall back to landlord override. Need landlord_id from the
        // deposit's lease.
        const landlordRow = await queryOne<{ landlord_id: string }>(
          `SELECT l.landlord_id FROM leases l WHERE l.id = $1`,
          [deposit.lease_id],
        )
        if (landlordRow) {
          const override = await queryOne<{
            state_code:      string
            effective_year:  number
            annual_rate_pct: string
            source_notes:    string | null
          }>(
            `SELECT state_code, effective_year,
                    annual_rate_pct::text AS annual_rate_pct,
                    source_notes
               FROM landlord_deposit_interest_rate_overrides
              WHERE landlord_id = $1 AND state_code = $2 AND effective_year = $3
              LIMIT 1`,
            [landlordRow.landlord_id, deposit.state, currentYear],
          )
          if (override) {
            rate = {
              source:           'landlord_override',
              state_code:       override.state_code,
              effective_year:   override.effective_year,
              annual_rate_pct:  override.annual_rate_pct,
              statute_citation: null,  // overrides don't carry statute text
              notes:            override.source_notes,
            }
          }
        }
      }
    }

    const { getAccrualHistory } = await import('../services/depositInterest')
    const accruals = await getAccrualHistory(deposit.id)

    res.json({
      success: true,
      data: {
        deposit,
        rate,
        accruals,
      },
    })
  } catch (e) { next(e) }
})

// ── POST /api/tenants/verify-ach ──────────────────────────────────────────
// Simulates ACH verification (real impl would use Plaid/Stripe).
// Sets ach_verified=true and stamps otp_qualified_at if deposit is also funded.
tenantsRouter.post('/verify-ach', async (req, res, next) => {
  try {
    const { bankName, last4 } = req.body
    if (!last4 || last4.length !== 4) {
      return res.status(400).json({ success: false, error: 'Valid bank last 4 digits required' })
    }

    // Check deposit status
    const row = await queryOne<any>(`
      SELECT
        CASE
          WHEN sd.id IS NULL THEN false
          WHEN sd.flex_deposit_enabled = true AND sd.installments_remaining > 0 THEN false
          WHEN sd.collected_amount >= sd.total_amount THEN true
          ELSE false
        END AS deposit_fully_funded
      FROM tenants t
      LEFT JOIN security_deposits sd ON sd.tenant_id = t.id
      WHERE t.id = $1`, [req.user!.profileId])

    const qualifies = row?.deposit_fully_funded === true

    // S374 fix: pre-S374 the UPDATE referenced `otp_qualified_at`
    // which doesn't exist on tenants — the column was replaced by
    // dynamic qualification via services/otp.getQualificationStatus
    // (per S365's landlords-otp.ts wire-up). Every verify-ach call
    // crashed 500 with "column 'otp_qualified_at' does not exist."
    // Drop the broken write; OTP qualification is now a runtime
    // check, not a persisted timestamp.
    await query(`
      UPDATE tenants
         SET ach_verified = TRUE,
             bank_last4   = $1
       WHERE id = $2`,
      [last4, req.user!.profileId])

    res.json({
      success: true,
      data: {
        ach_verified: true,
        deposit_fully_funded: qualifies,
        message: qualifies
          ? 'Bank verified and OTP qualified!'
          : 'Bank verified. OTP will activate once your deposit is fully funded.'
      }
    })
  } catch (e) { next(e) }
})



// ── FLEXCHARGE (S252) ─────────────────────────────────────────────────────
// Tenant-side view of FlexCharge accounts the tenant holds (potentially
// one per property where they're enrolled). Pre-S252 routes targeted
// a one-account-per-tenant model that no longer matches the schema —
// rewritten to use the service layer.

// GET /api/tenants/flexcharge — list all accounts for this tenant
tenantsRouter.get('/flexcharge', async (req, res, next) => {
  try {
    const { isFlexChargeVisible, getFlexChargeAccountsForTenant } = await import('../services/flexCharge')
    if (!await isFlexChargeVisible()) return res.json({ success: true, data: { visible: false } })
    const accounts = await getFlexChargeAccountsForTenant(req.user!.profileId)
    res.json({ success: true, data: { visible: true, accounts } })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexcharge/dispute/:txId
// S253: real dispute engine. Tenant disputes their own FlexCharge
// transaction → tx marked 'disputed', account 'disqualified'
// (permanent — admin manually unblocks). 3 distinct disputers
// against the same landlord in a trailing 90-day window flips the
// landlord's FlexCharge eligibility off platform-wide.
tenantsRouter.post('/flexcharge/dispute/:txId', async (req, res, next) => {
  try {
    const { reason } = req.body
    if (!reason || String(reason).trim().length < 3) {
      throw new AppError(400, 'Dispute reason required (min 3 chars)')
    }
    const { disputeFlexChargeTransaction } = await import('../services/flexCharge')
    const out = await disputeFlexChargeTransaction({
      transactionId:    req.params.txId,
      disputerTenantId: req.user!.profileId,
      reason:           String(reason),
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// ── FLEXPAY (S245) ────────────────────────────────────────────────────────
// FlexPay is a tenant-paid payment-scheduling service. The tenant picks
// a rent pull day (1-28) and pays a $5 + day-of-month fee each cycle.
// GAM fronts the rent to the landlord on the lease's grace-period-end
// day; the tenant's ACH pull on their chosen day reimburses GAM and
// collects the scheduling fee. See services/flexpay.ts for engine.
//
// Pre-S245 this route block targeted phantom columns (flexpay_tier,
// flexpay_pull_pattern, otp_qualified_at) and gated on deposit-funded
// (an OTP concern, not a FlexPay one). All replaced.

// GET /api/tenants/flexpay — current enrollment + eligibility
tenantsRouter.get('/flexpay', async (req, res, next) => {
  try {
    const { isFlexPayVisible, getFlexPayEligibility, calculateFlexPayFee } = await import('../services/flexpay')
    const visible = await isFlexPayVisible()
    if (!visible) return res.json({ success: true, data: { visible: false } })

    const row = await queryOne<any>(
      `SELECT flexpay_enrolled, flexpay_pull_day, flexpay_monthly_fee,
              flexpay_enrolled_at, flexpay_disqualified_until,
              flexpay_disqualified_reason
         FROM tenants WHERE id = $1`,
      [req.user!.profileId],
    )
    const eligibility = await getFlexPayEligibility(req.user!.profileId)

    res.json({
      success: true,
      data: {
        visible: true,
        ...row,
        eligibility,
        previewFee: row?.flexpay_pull_day ? calculateFlexPayFee(row.flexpay_pull_day) : null,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexpay/enroll
// body: { pullDay: 1..28, acceptedTerms: true }
// S314: explicit acceptance gate. The Subscription Terms snapshot is
// persisted to flexsuite_enrollment_acceptances inside the same tx.
tenantsRouter.post('/flexpay/enroll', async (req, res, next) => {
  try {
    const { enrollFlexPay } = await import('../services/flexpay')
    const pullDay = Number(req.body?.pullDay)
    const acceptedTerms = req.body?.acceptedTerms === true
    const out = await enrollFlexPay({
      tenantId:      req.user!.profileId,
      userId:        req.user!.userId,
      pullDay,
      acceptedTerms,
      ip:            req.ip ?? null,
      userAgent:     req.headers['user-agent'] ?? null,
    })
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: { pullDay, fee: out.fee, acceptanceId: out.acceptanceId } })
  } catch (e) { next(e) }
})

// GET /api/tenants/flexpay/terms?pullDay=15
// S314: server-rendered populated Subscription Terms preview for the
// "Read full terms" link in the enrollment modal. No persistence —
// same render fn that runs at acceptance, returned for display.
tenantsRouter.get('/flexpay/terms', async (req, res, next) => {
  try {
    const { calculateFlexPayFee } = await import('../services/flexpay')
    const { renderFlexPayAcceptanceText, FLEXPAY_TEMPLATE_VERSION } =
      await import('../services/flexsuiteAcceptance')
    const pullDay = Number(req.query.pullDay)
    if (!Number.isInteger(pullDay) || pullDay < 1 || pullDay > 28) {
      throw new AppError(400, 'pullDay must be an integer 1..28')
    }
    const fee = calculateFlexPayFee(pullDay)
    const { renderedText } = await renderFlexPayAcceptanceText({
      tenantId:  req.user!.profileId,
      userId:    req.user!.userId,
      pullDay,
      fee,
      ip:        null,
      userAgent: null,
    })
    res.json({
      success: true,
      data: { version: FLEXPAY_TEMPLATE_VERSION, pullDay, fee, renderedText },
    })
  } catch (e) { next(e) }
})

// ── FlexSuite re-acceptance (S323) ────────────────────────────────────────
// When a template version bumps, currently-enrolled tenants are prompted
// to re-accept the new populated terms. The prior acceptance row stays
// in place as historical evidence; the new row carries the current
// version forward.

// GET /api/tenants/flexsuite/re-acceptance-status
// Returns the list of products with a pending re-acceptance. Empty
// array = nothing to prompt. The tenant portal calls this once on
// auth-resolved mount.
tenantsRouter.get('/flexsuite/re-acceptance-status', async (req, res, next) => {
  try {
    const { getPendingReAcceptances } =
      await import('../services/flexsuiteAcceptance')
    const pending = await getPendingReAcceptances(req.user!.profileId)
    res.json({ success: true, data: { pending } })
  } catch (e) { next(e) }
})

// GET /api/tenants/flexsuite/re-acceptance-preview?product=flexpay|flexdeposit
// Renders the current-version populated terms for a tenant who's
// already enrolled. The pull day / installment count comes from the
// tenant's existing enrollment state, not the request.
tenantsRouter.get('/flexsuite/re-acceptance-preview', async (req, res, next) => {
  try {
    const { renderReAcceptanceTerms, FLEXPAY_TEMPLATE_VERSION, FLEXDEPOSIT_TEMPLATE_VERSION } =
      await import('../services/flexsuiteAcceptance')
    const product = String(req.query.product || '')
    if (product !== 'flexpay' && product !== 'flexdeposit') {
      throw new AppError(400, 'product must be flexpay or flexdeposit')
    }
    const { renderedText } = await renderReAcceptanceTerms({
      tenantId:  req.user!.profileId,
      userId:    req.user!.userId,
      product,
      ip:        null,
      userAgent: null,
    })
    res.json({
      success: true,
      data: {
        product,
        version:      product === 'flexpay' ? FLEXPAY_TEMPLATE_VERSION : FLEXDEPOSIT_TEMPLATE_VERSION,
        renderedText,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexsuite/re-accept
// Body: { product: 'flexpay' | 'flexdeposit', acceptedTerms: true }
// Persists a new acceptance row at the current template version.
tenantsRouter.post('/flexsuite/re-accept', async (req, res, next) => {
  try {
    const product = String(req.body?.product || '')
    if (product !== 'flexpay' && product !== 'flexdeposit') {
      throw new AppError(400, 'product must be flexpay or flexdeposit')
    }
    if (req.body?.acceptedTerms !== true) {
      throw new AppError(400, 'acceptedTerms must be true')
    }
    const { commitReAcceptance } =
      await import('../services/flexsuiteAcceptance')
    const acceptanceId = await commitReAcceptance({
      tenantId:  req.user!.profileId,
      userId:    req.user!.userId,
      product,
      ip:        req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    })
    res.json({ success: true, data: { acceptanceId, product } })
  } catch (e) { next(e) }
})

// DELETE /api/tenants/flexpay — cancel enrollment
tenantsRouter.delete('/flexpay', async (req, res, next) => {
  try {
    const { cancelFlexPay } = await import('../services/flexpay')
    await cancelFlexPay(req.user!.profileId)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── FLEXDEPOSIT (S246) ────────────────────────────────────────────────────
// FlexDeposit splits the security deposit into 2-4 installments based on
// deposit amount × Checkr BG risk_level. Installment 1 paid at move-in;
// remaining N-1 spread monthly. GAM fronts the gap to landlord on
// move-in so the landlord sees deposit funded in full from day 1.
// $3/month custody fee continues for as long as the tenant has a
// deposit on the GAM platform.

// GET /api/tenants/flexdeposit — eligibility + active plan + schedule
tenantsRouter.get('/flexdeposit', async (req, res, next) => {
  try {
    const { isFlexDepositVisible, getFlexDepositEligibility } = await import('../services/flexDeposit')
    const visible = await isFlexDepositVisible()
    if (!visible) return res.json({ success: true, data: { visible: false } })

    const eligibility = await getFlexDepositEligibility(req.user!.profileId)

    // Active plan view: any installments rows belonging to this tenant.
    const plan = await query<any>(
      `SELECT i.installment_number, i.installment_count, i.amount::text,
              i.due_date::text, i.status, i.settled_at::text,
              i.security_deposit_id
         FROM flex_deposit_installments i
        WHERE i.tenant_id = $1
        ORDER BY i.installment_number ASC`,
      [req.user!.profileId],
    )

    // S262: deposit-row context for the LeasePage accelerated /
    // in_default banner. Returns the most recently created deposit
    // belonging to this tenant whose plan_status is one of the
    // banner-relevant states. Null when no banner needed.
    const deposit = await queryOne<{
      id:                        string
      flex_deposit_plan_status:  string | null
      balance_due_full_at:       string | null
      balance_due_total:         string | null
      total_amount:              string
      collected_amount:          string
    }>(
      `SELECT id, flex_deposit_plan_status,
              balance_due_full_at::text AS balance_due_full_at,
              balance_due_total::text   AS balance_due_total,
              total_amount::text        AS total_amount,
              collected_amount::text    AS collected_amount
         FROM security_deposits
        WHERE tenant_id = $1
          AND flex_deposit_enabled = TRUE
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.user!.profileId],
    )

    res.json({ success: true, data: { visible: true, eligibility, plan, deposit } })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexdeposit/retry-acceleration — manual retry from
// the LeasePage banner when plan_status='in_default'. Re-fires the
// full-balance ACH pull; success flips plan to 'completed', failure
// returns it to 'in_default'.
tenantsRouter.post('/flexdeposit/retry-acceleration', async (req, res, next) => {
  try {
    const { retryFlexDepositAcceleration } = await import('../services/flexDeposit')
    const out = await retryFlexDepositAcceleration({ tenantId: req.user!.profileId })
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexdeposit/enroll
// body: { installmentCount: 2..4, acceptedTerms: true }
// S260 (acknowledgedTos) → S314 (acceptedTerms): the gate now also
// persists the populated SLA snapshot to
// flexsuite_enrollment_acceptances inside the same tx as the
// installment-row inserts. Legacy `acknowledgedTos: true` accepted
// for backward compat.
tenantsRouter.post('/flexdeposit/enroll', async (req, res, next) => {
  try {
    const { enrollFlexDeposit } = await import('../services/flexDeposit')
    const installmentCount = Number(req.body?.installmentCount)
    const acceptedTerms =
      req.body?.acceptedTerms === true || req.body?.acknowledgedTos === true
    const out = await enrollFlexDeposit({
      tenantId:         req.user!.profileId,
      userId:           req.user!.userId,
      installmentCount,
      acceptedTerms,
      ip:               req.ip ?? null,
      userAgent:        req.headers['user-agent'] ?? null,
    })
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: { ...out.plan, acceptanceId: out.acceptanceId } })
  } catch (e) { next(e) }
})

// GET /api/tenants/flexdeposit/terms?installmentCount=3
// S314: server-rendered populated SLA preview for the "Read full
// agreement" link. Computes the same schedule enrollment would
// produce, renders the SLA with placeholders filled, returns the
// text. No persistence.
tenantsRouter.get('/flexdeposit/terms', async (req, res, next) => {
  try {
    const { previewFlexDepositSchedule } = await import('../services/flexDeposit')
    const { renderFlexDepositAcceptanceText, FLEXDEPOSIT_TEMPLATE_VERSION } =
      await import('../services/flexsuiteAcceptance')
    const installmentCount = Number(req.query.installmentCount)
    if (!Number.isInteger(installmentCount) || installmentCount < 2 || installmentCount > 4) {
      throw new AppError(400, 'installmentCount must be an integer 2..4')
    }
    const preview = await previewFlexDepositSchedule({
      tenantId: req.user!.profileId,
      installmentCount,
    })
    if (!preview.ok) throw new AppError(400, preview.reason)
    const { renderedText } = await renderFlexDepositAcceptanceText({
      tenantId:               req.user!.profileId,
      userId:                 req.user!.userId,
      depositId:              preview.depositId,
      installmentCount,
      installments:           preview.schedule.installments,
      gamAdvanceAmount:       preview.schedule.gamAdvanceAmount,
      totalInstallmentAmount: preview.schedule.totalInstallmentAmount,
      moveInDate:             preview.schedule.startDate,
      ip:                     null,
      userAgent:              null,
    })
    res.json({
      success: true,
      data: {
        version:          FLEXDEPOSIT_TEMPLATE_VERSION,
        installmentCount,
        installments:     preview.schedule.installments,
        gamAdvanceAmount: preview.schedule.gamAdvanceAmount,
        renderedText,
      },
    })
  } catch (e) { next(e) }
})

// S255: deposit portability — when a tenant's current lease enters
// termination and they have another GAM lease pending/active, they
// can authorize carry-forward of the deposit instead of receiving
// a refund. Backend gates on detection eligibility; UI prompts at
// the termination flow.

// GET /api/tenants/me/deposit/portability/eligibility?leaseId=...
tenantsRouter.get('/me/deposit/portability/eligibility', async (req, res, next) => {
  try {
    const leaseId = String(req.query.leaseId || '')
    if (!leaseId) throw new AppError(400, 'leaseId required')
    const { detectPortabilityEligible } = await import('../services/depositPortability')
    const result = await detectPortabilityEligible({
      leaseId,
      tenantId: req.user!.profileId,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// POST /api/tenants/me/deposit/portability/authorize
//   body: { depositId, targetLeaseId, signature }
tenantsRouter.post('/me/deposit/portability/authorize', async (req, res, next) => {
  try {
    const { depositId, targetLeaseId, signature } = req.body || {}
    if (!depositId || !targetLeaseId || !signature) {
      throw new AppError(400, 'depositId, targetLeaseId, signature required')
    }
    const { authorizeDepositPortability } = await import('../services/depositPortability')
    const out = await authorizeDepositPortability({
      tenantId:      req.user!.profileId,
      depositId,
      targetLeaseId,
      signature,
      ip:            req.ip ?? null,
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// POST /api/tenants/me/deposit/portability/decline { depositId }
tenantsRouter.post('/me/deposit/portability/decline', async (req, res, next) => {
  try {
    const { depositId } = req.body || {}
    if (!depositId) throw new AppError(400, 'depositId required')
    const { declineDepositPortability } = await import('../services/depositPortability')
    await declineDepositPortability({
      tenantId:  req.user!.profileId,
      depositId,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// DELETE /api/tenants/flexdeposit — cancel BEFORE move-in only
tenantsRouter.delete('/flexdeposit', async (req, res, next) => {
  try {
    const { cancelFlexDeposit } = await import('../services/flexDeposit')
    const out = await cancelFlexDeposit(req.user!.profileId)
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// DEPRECATED (S155): OTP is now a landlord-side product. Tenants
// have no enrollment surface — landlord enrolls qualified tenants
// via /api/landlords/me/otp/tenants/:tenantId/enable. This endpoint
// returns 410 Gone to prevent any straggler client calls from
// flipping the flag.
tenantsRouter.post('/enroll-on-time-pay', async (_req, res) => {
  res.status(410).json({
    success: false,
    error: 'Tenant-side OTP enrollment is deprecated. OTP is a landlord product as of S155.',
  })
})

// POST /api/tenants/enroll-credit-reporting
tenantsRouter.post('/enroll-credit-reporting', async (req, res, next) => {
  try {
    await query(`UPDATE tenants SET credit_reporting_enrolled=TRUE WHERE id=$1`, [req.user!.profileId])
    res.json({ success: true, message: 'Credit reporting enrolled — $5/month reported to all 3 bureaus' })
  } catch (e) { next(e) }
})

tenantsRouter.get('/payments', async (req, res, next) => {
  try {
    const payments = await query<any>(`
      SELECT p.*, u.unit_number, pr.name AS property_name
      FROM payments p
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE p.tenant_id = $1
      ORDER BY p.due_date DESC LIMIT 24`, [req.user!.profileId])
    res.json({ success: true, data: payments })
  } catch (e) { next(e) }
})

// POST /api/tenants/invite — landlord invites a tenant.
// S81: gated by tenants.create. Pre-S81 the route had bare requireAuth
// (router-level), so any authenticated user including the tenant being
// invited could call it. canAccessLandlordResource still enforces unit
// scope after admission.
tenantsRouter.post('/invite', requirePerm('tenants.create'), async (req, res, next) => {
  try {
    const { email, firstName, lastName, unitId, phone } = req.body
    if (!email || !firstName || !unitId) {
      return res.status(400).json({ success: false, error: 'Email, name and unit required' })
    }
    // S417: block disposable email domains so invites can't be sent to
    // throwaway addresses. Defeats the verification gate downstream.
    if (typeof email === 'string' && isDisposableEmail(email)) {
      return res.status(400).json({ success: false,
        error: 'Disposable / temporary email addresses are not allowed' })
    }

    // Verify caller can manage tenants on this unit's landlord. Inviting
    // a tenant ties them to a unit's landlord — admin override + team-role
    // scope are both valid here.
    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [unitId])
    if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' })
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }
    const crypto = require('crypto')
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const tempHash = '$2b$10$placeholder_invite_pending'

    // Create or find user
    let user = await queryOne<any>('SELECT id FROM users WHERE email=$1', [email])
    if (!user) {
      user = await queryOne<any>(`
        INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
        VALUES ($1,$2,'tenant',$3,$4,$5) RETURNING id`,
        [email, tempHash, firstName, lastName || '', phone || null])
    }

    // Create tenant record
    const tenant = await queryOne<any>(`
      INSERT INTO tenants (user_id) VALUES ($1)
      ON CONFLICT DO NOTHING RETURNING id`, [user!.id])

    const tenantId = tenant?.id || (await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [user!.id]))?.id

    // Unit assignment happens via e-sign, not invite. Landlord sends lease
    // through /api/esign once the tenant account exists.

    // S410 (S377): store on the purpose-scoped column with a 7-day
    // expiry. Pre-S410 this wrote to email_verify_token (which was
    // overloaded across email-verification + tenant invites + landlord
    // invites). The accept route below now reads tenant_invite_token
    // and enforces tenant_invite_expires_at > NOW().
    await query(
      `UPDATE users
          SET tenant_invite_token = $1,
              tenant_invite_expires_at = NOW() + INTERVAL '7 days'
        WHERE id = $2`,
      [inviteToken, user!.id])

    logger.info(`[INVITE] Tenant invite: ${email} — token: ${inviteToken}`)
    logger.info(`[INVITE] Accept URL: ${process.env.TENANT_APP_URL}/accept-invite?token=${inviteToken}`)

    res.json({
      success: true,
      data: {
        userId: user!.id,
        tenantId,
        email,
        inviteToken,
        acceptUrl: `${process.env.TENANT_APP_URL || 'http://localhost:3002'}/accept-invite?token=${inviteToken}`
      }
    })
  } catch (e) { next(e) }
})

// /accept-invite and /invite-info are declared at the top of
// this file, BEFORE tenantsRouter.use(requireAuth). See header
// comment on the pre-auth public routes section.

// GET /api/tenants/:id/profile — full lifetime tenant profile.
// Authorization: tenant viewing themselves; admin/super_admin; or landlord
// (or scoped team role) on any property where the tenant has a lease_tenants
// row. Cross-tenant data (payments, maintenance, work-trade) is gated on this
// check — pre-S71 the endpoint had no auth at all.
tenantsRouter.get('/:id/profile', async (req, res, next) => {
  try {
    // Basic tenant info
    const tenant = await queryOne<any>(`
      SELECT t.*, u.first_name, u.last_name, u.email, u.phone,
        u.created_at as account_created
      FROM tenants t
      JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`, [req.params.id])
    if (!tenant) throw new AppError(404, 'Tenant not found')

    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const isSelf = role === 'tenant' && req.user!.profileId === req.params.id
    if (!isAdmin && !isSelf) {
      // Find any landlord this tenant has a lease relationship with, then
      // check if the calling user has access to that landlord's resources.
      const relatedLandlords = await query<{ landlord_id: string }>(`
        SELECT DISTINCT l.landlord_id
          FROM lease_tenants lt
          JOIN leases l ON l.id = lt.lease_id
         WHERE lt.tenant_id = $1
      `, [req.params.id])
      const allowed = relatedLandlords.some(r =>
        canAccessLandlordResource(req.user, r.landlord_id))
      if (!allowed) throw new AppError(403, 'Forbidden')
    }

    // All units ever occupied (current + historical via lease_tenants)
    const units = await query<any>(`
      SELECT DISTINCT u.id, u.unit_number, u.rent_amount, u.status,
        p.name as property_name, p.street1, p.city, p.state,
        l.start_date, l.end_date,
        (lt.status = 'active' AND l.status = 'active') as is_current
      FROM lease_tenants lt
      JOIN leases l ON l.id = lt.lease_id
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE lt.tenant_id = $1
      ORDER BY is_current DESC, start_date DESC`, [req.params.id])

    // Full payment history across all units
    const payments = await query<any>(`
      SELECT p.*, u.unit_number, pr.name as property_name
      FROM payments p
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE p.tenant_id = $1
      ORDER BY p.due_date DESC
      LIMIT 36`, [req.params.id])

    // Lifetime payment stats. lateCount sources from
    // tenants.late_payment_count (maintained by the daily late-fee
    // job in scheduler.ts) — payments.status has no 'late' value
    // so a FILTER on it always returns 0.
    const paymentStats = await queryOne<any>(`
      SELECT
        COUNT(*) as total_payments,
        COUNT(*) FILTER (WHERE status = 'settled') as settled,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) as total_paid,
        COALESCE(AVG(amount) FILTER (WHERE status = 'settled'), 0) as avg_payment,
        MIN(due_date) as first_payment,
        MAX(due_date) as last_payment
      FROM payments WHERE tenant_id = $1`, [req.params.id])

    // Maintenance requests
    const maintenance = await query<any>(`
      SELECT mr.*, u.unit_number, p.name as property_name
      FROM maintenance_requests mr
      LEFT JOIN units u ON u.id = mr.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE mr.tenant_id = $1
      ORDER BY mr.created_at DESC
      LIMIT 20`, [req.params.id])

    // Work trade agreements
    const workTrade = await query<any>(`
      SELECT wta.*, u.unit_number, p.name as property_name
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE wta.tenant_id = $1
      ORDER BY wta.created_at DESC`, [req.params.id])

    // Lifetime metrics
    const firstPayment = paymentStats?.first_payment ? new Date(paymentStats.first_payment) : null
    const tenantMonths = firstPayment
      ? Math.floor((Date.now() - firstPayment.getTime()) / (1000 * 60 * 60 * 24 * 30))
      : 0
    const settled = parseInt(paymentStats?.settled || 0)
    const total = parseInt(paymentStats?.total_payments || 0)
    const onTimeRate = total > 0 ? Math.round((settled / total) * 100) : 0

    res.json({
      success: true,
      data: {
        tenant,
        units,
        payments,
        maintenance,
        workTrade,
        stats: {
          tenantMonths,
          totalPaid:    parseFloat(paymentStats?.total_paid || 0),
          avgPayment:   parseFloat(paymentStats?.avg_payment || 0),
          settledCount: settled,
          failedCount:  parseInt(paymentStats?.failed || 0),
          lateCount:    tenant.late_payment_count ?? 0,
          totalPayments: total,
          onTimeRate,
          firstPayment: paymentStats?.first_payment,
          lastPayment:  paymentStats?.last_payment,
          unitsOccupied: units.length,
          maintenanceCount: maintenance.length,
        }
      }
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/:id/transfer — move tenant to a new unit
tenantsRouter.post('/:id/transfer', requirePerm('tenants.archive'), async (req, res, next) => {
  // Removed S20. Unit transfers are not a distinct operation under the
  // multi-tenant lease model. The equivalent workflow is:
  //   1. Terminate the existing lease (PATCH /leases/:id status=terminated)
  //   2. Create a new e-sign document for the new unit with the same tenant(s)
  //   3. All parties sign → new lease row created on the new unit
  // This endpoint intentionally returns 501 until a purpose-built flow exists.
  res.status(501).json({
    success: false,
    error: 'Unit transfer endpoint retired. Terminate the current lease and create a new lease via e-sign on the new unit.'
  })
})

tenantsRouter.get('/:id/available-units', requirePerm('tenants.archive'), async (req, res, next) => {
  try {
    const units = await query<any>(`
      SELECT u.id, u.unit_number, u.rent_amount, u.bedrooms, u.bathrooms, u.sqft,
        p.name as property_name, p.street1, p.city
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = $1 AND u.status = 'vacant'
        AND NOT EXISTS (
          SELECT 1 FROM leases l
          WHERE l.unit_id = u.id AND l.status IN ('active', 'pending')
        )
      ORDER BY p.name, u.unit_number`,
      [req.user!.profileId])
    res.json({ success: true, data: units })
  } catch (e) { next(e) }
})

// ── TENANT PROFILE UPDATE ─────────────────────────────────────
//
// S411 (S398/S380 Nic-locked decision): "fix all 3" email validations
// plus a 4th defensive check. S417 extracted the disposable-domain
// helper to lib/email so the same block list applies to all
// email-accepting routes.

const profileSchema = z.object({
  phone:       z.string().nullish(),
  // .trim() runs before .email() so surrounding whitespace doesn't
  // make the input fail format validation.
  email:       z.string().trim().email('Invalid email format').nullish(),
  bio:         z.string().nullish(),
  themeAccent: z.string().nullish(),
  fontStyle:   z.string().nullish(),
})

tenantsRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const body = profileSchema.parse(req.body)
    const { phone, email, bio, themeAccent, fontStyle } = body

    if (email) {
      const normalized = email.trim().toLowerCase()
      if (isDisposableEmail(normalized)) {
        throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
      }
      // S380 (b): pre-check uniqueness. Returns clean 409 instead of
      // the 500 from the DB unique-constraint violation.
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2 LIMIT 1`,
        [normalized, req.user!.userId])
      if (existing) {
        throw new AppError(409, 'This email is already in use by another account')
      }
      // Only update email when it was supplied. COALESCE-style: omitted
      // body field preserves current value (fixes the 4th defensive
      // case — null-clobber from missing email).
      await query('UPDATE users SET phone=$1, email=$2 WHERE id=$3',
        [phone||null, normalized, req.user!.userId])
    } else {
      await query('UPDATE users SET phone=COALESCE($1,phone) WHERE id=$2',
        [phone||null, req.user!.userId])
    }
    if (req.user!.profileId) {
      await query('UPDATE tenants SET bio=$1, theme_accent=$2, font_style=$3 WHERE id=$4',
        [bio||null, themeAccent||null, fontStyle||null, req.user!.profileId])
    }
    res.json({ success: true })
  } catch (e) { next(e) }
})


// Avatar upload
// S409 (S398 Nic-locked decision): "strong fix" XSS defense layer 2 —
// normalize the on-disk extension based on validated MIME, not on the
// client-supplied originalname extension. Mirrors the S399 properties.ts
// + S394 esign + S395 pending-tenants fixes. The serve route also pins
// Content-Type so even legacy files survive, but defending at both
// layers is the right posture for a public-served file class.
const AVATAR_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
}
const avatarDir = path.join(process.cwd(), 'uploads', 'avatars')
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true })
const avatarStorage = multer.diskStorage({
  destination: avatarDir,
  filename: (_req: any, file: any, cb: any) => {
    const ext = AVATAR_MIME_TO_EXT[file.mimetype] ?? '.jpg'
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext)
  }
})
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req: any, file: any, cb: any) => {
  if (['image/jpeg','image/png','image/webp'].includes(file.mimetype)) cb(null, true)
  else cb(new Error('JPEG PNG WEBP only'))
}})

tenantsRouter.post('/avatar', requireAuth, avatarUpload.single('file'), async (req: any, res: any, next: any) => {
  try {
    if (!req.file) throw new AppError(400, 'No file')
    const url = '/api/tenants/avatar-files/' + req.file.filename
    if (req.user!.profileId) await query('UPDATE tenants SET avatar_url=$1 WHERE id=$2', [url, req.user!.profileId])
    res.json({ success: true, data: { url } })
  } catch(e) { next(e) }
})

// /avatar-files/:filename is declared at the top of this file,
// BEFORE tenantsRouter.use(requireAuth). See pre-auth header.

tenantsRouter.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) throw new AppError(400, 'Current and new password required')
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new AppError(400, 'New password must be at least 8 characters')
    }
    const bcrypt = require('bcryptjs')
    const user = await queryOne<any>('SELECT * FROM users WHERE id=$1', [req.user!.userId])
    if (!user) throw new AppError(404, 'User not found')
    const valid = await bcrypt.compare(currentPassword, user.password_hash)
    if (!valid) throw new AppError(401, 'Incorrect current password')
    const hash = await bcrypt.hash(newPassword, 10)
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user!.userId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── TENANT LEASE SIGNING ──────────────────────────────────────
tenantsRouter.get('/lease', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT t.id FROM tenants t WHERE t.user_id=$1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    const unit = await queryOne<any>(`
      SELECT u.* FROM units u
      JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
      JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.tenant_id = $1 AND lt.status = 'active'
      LIMIT 1`, [tenant.id])
    if (!unit) throw new AppError(404, 'No active unit')
    // S483: extended SELECT pulls property state + security_deposit
    // (from lease_fees post-S196) so the state-law compute below has
    // all the inputs it needs without a second round-trip.
    const lease = await queryOne<any>(`
      SELECT l.*, p.name as property_name, p.state as property_state,
        u.unit_number,
        (SELECT amount FROM lease_fees lf
          WHERE lf.lease_id = l.id
            AND lf.fee_type = 'security_deposit'
            AND lf.due_timing = 'move_in'
          LIMIT 1) AS security_deposit,
        lu.first_name || ' ' || lu.last_name as landlord_name,
        COALESCE(vuo.primary_first_name || ' ' || vuo.primary_last_name, '') as tenant_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu ON lu.id = la.user_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE l.unit_id = $1 AND l.status IN ('pending','active')
      ORDER BY l.created_at DESC LIMIT 1`, [unit.id])

    // S483: state-law warnings recomputed against the persisted lease.
    // The tenant sees the same hedged factual notice the landlord saw
    // at PATCH time — completes the both-party transparency loop for
    // lease terms (S478 closed it for entry requests). Best-effort.
    let stateLawWarnings: LawFlag[] = []
    if (lease) {
      try {
        stateLawWarnings = await checkLeaseAgainstStateLaw({
          stateCode:             lease.property_state,
          rentAmount:            Number(lease.rent_amount),
          securityDepositAmount: lease.security_deposit != null ? Number(lease.security_deposit) : null,
          lateFeeInitialAmount:  lease.late_fee_initial_amount != null ? Number(lease.late_fee_initial_amount) : null,
          lateFeeInitialType:    lease.late_fee_initial_type,
          lateFeeGraceDays:      lease.late_fee_grace_days != null ? Number(lease.late_fee_grace_days) : null,
        })
      } catch (e) {
        logger.error({ err: e, lease_id: lease.id }, '[stateLaw] tenant lease GET checks failed')
      }
    }

    res.json({
      success: true,
      data: lease ? { ...lease, state_law_warnings: stateLawWarnings } : lease,
    })
  } catch (e) { next(e) }
})

tenantsRouter.post('/lease/sign', requireAuth, async (req, res, next) => {
  // Removed S20. Tenant signing is handled exclusively by the e-sign flow.
  // Tenants sign documents at POST /api/esign/sign/:documentId after a
  // landlord creates a lease_documents record and sends it.
  res.status(410).json({
    success: false,
    error: 'Direct lease signing is no longer supported. Signatures are handled through e-sign at /api/esign/sign/:documentId.'
  })
})

// S210 (S202 carry): addendum history for the tenant's active lease.
// Returns lease_addendum_recorded credit-ledger events scoped to the
// requesting tenant + their current lease. Includes event_data.changes
// (the diff) so the LeasePage UI can render what actually changed in
// each addendum — the /credit page shows the events but redacts the
// per-event payload, which leaves the tenant unable to see WHAT the
// addendum modified.
tenantsRouter.get('/lease/addendums', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<{ id: string }>(
      'SELECT id FROM tenants WHERE user_id=$1', [req.user!.userId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')

    const lease = await queryOne<{ id: string; landlord_id: string }>(`
      SELECT l.id, l.landlord_id
        FROM leases l
        JOIN lease_tenants lt ON lt.lease_id = l.id
       WHERE lt.tenant_id = $1
         AND lt.status = 'active'
         AND l.status IN ('active', 'pending')
       ORDER BY l.created_at DESC
       LIMIT 1`,
      [tenant.id]
    )
    if (!lease) return res.json({ success: true, data: [] })

    const events = await query<{
      id: string
      occurred_at: string
      changes: Array<{ field: string; from: string; to: string }>
      pdf_filename: string | null
      recorded_by_user_id: string | null
    }>(`
      SELECT ev.id,
             ev.occurred_at,
             ev.event_data->'changes'              AS changes,
             ev.event_data->>'pdf_filename'        AS pdf_filename,
             ev.event_data->>'recorded_by_user_id' AS recorded_by_user_id
        FROM credit_events ev
        JOIN credit_subjects cs ON cs.id = ev.subject_id
       WHERE cs.subject_type = 'tenant'
         AND cs.subject_ref_id = $1
         AND ev.event_type = 'lease_addendum_recorded'
         AND ev.event_data->>'lease_id' = $2
         AND ev.superseded_by IS NULL
       ORDER BY ev.occurred_at DESC`,
      [tenant.id, lease.id]
    )

    // S214: resolve recorded_by_user_id to display name. Tenants get
    // name only; role attribution doesn't help them. Resolution is
    // per-event because dev volume is low; if catalog grows large,
    // batch by deduping the user IDs first.
    const { resolveAddendumActor } = await import('../services/addendumActor')
    const resolved = await Promise.all(
      events.map(async (e) => {
        const actor = await resolveAddendumActor(e.recorded_by_user_id, lease.landlord_id)
        return {
          id:               e.id,
          occurred_at:      e.occurred_at,
          changes:          e.changes,
          pdf_filename:     e.pdf_filename,
          recorded_by_name: actor.name,
        }
      })
    )

    res.json({ success: true, data: resolved })
  } catch (e) { next(e) }
})

tenantsRouter.get('/work-trade', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT t.id FROM tenants t WHERE t.user_id=$1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    const agreement = await queryOne<any>(`
      SELECT wta.*, u.unit_number, p.name as property_name
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE wta.tenant_id=$1 AND wta.status='active'
      ORDER BY wta.created_at DESC LIMIT 1`, [tenant.id])
    res.json({ success: true, data: agreement || null })
  } catch (e) { next(e) }
})

// DEPRECATED (S381): predates the FlexCharge subsystem (S109+).
// The legacy SQL referenced pos_transactions.settled which doesn't
// exist in the schema — any call would have 500'd. The canonical
// tenant-side charge-account surface is GET /api/tenants/flexcharge
// (delegates to services/flexCharge), which returns the accounts
// (with credit_limit + outstanding balance derived from
// flex_charge_statements) and transactions for the tenant.
// Returns 410 to prevent any straggler client from re-attempting
// the broken endpoint.
tenantsRouter.get('/charge-account', requireAuth, async (_req, res) => {
  res.status(410).json({
    success: false,
    error: 'Tenant-side /charge-account is deprecated. Use /api/tenants/flexcharge for FlexCharge account + transaction data.',
  })
})
