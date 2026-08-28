import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { emailLandlordBankingNudge, emailTenantInvite } from '../services/email'
import { isDisposableEmail } from '../lib/email'
import { logger } from '../lib/logger'
import { checkLeaseAgainstStateLaw, type LawFlag } from '../services/stateLaw'
import { signEmailOtpSessionToken, issueEmailOtp } from './emailOtp'
import { applyScreeningWaive } from '../services/onboardingWindow'

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
// S537: landlord-scoped tenant list — the picker feed for the landlord
// portal (lease form, screening, entry requests, FlexCharge, POS tab).
// This root GET was missing since the beginning: five pages called it
// and silently rendered empty pickers off the 404. Returns every tenant
// with any lease under the calling landlord (newest lease's unit for
// display), deduped.
tenantsRouter.get('/', requireAuth, async (req: any, res, next) => {
  try {
    const landlordId = req.user!.role === 'landlord' ? req.user!.profileId : req.user!.landlordId
    if (!landlordId) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(
      `SELECT DISTINCT ON (t.id)
              t.id, uu.first_name, uu.last_name, uu.email, uu.phone,
              un.unit_number, p.name AS property_name, l.status AS lease_status
         FROM tenants t
         JOIN users uu ON uu.id = t.user_id
         JOIN lease_tenants lt ON lt.tenant_id = t.id
         JOIN leases l ON l.id = lt.lease_id
         JOIN units un ON un.id = l.unit_id
         JOIN properties p ON p.id = un.property_id
        WHERE l.landlord_id = $1
        ORDER BY t.id, l.created_at DESC`,
      [landlordId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

tenantsRouter.post('/accept-invite', async (req, res, next) => {
  try {
    const { token, password, phone, ssiSsdi, acceptedTerms } = req.body
    if (!token || !password) return res.status(400).json({ success: false, error: 'Token and password required' })
    if (password.length < 12) return res.status(400).json({ success: false, error: 'Password must be at least 12 characters' })
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

    // S616 (Nic): a UTILITY-SERVICE payer agreeing to be billed.
    //
    // A serviced space's payer has no lease, no application and no prior
    // relationship with GAM — accepting this invite is the only moment they
    // ever consent to anything. Until it happens (or the landlord attests they
    // agreed off-platform) their charges accrue but no invoice is issued, so
    // this stamp is what actually releases the billing.
    await query(
      `UPDATE utility_service_agreements sa
          SET payer_accepted_at = NOW(), updated_at = NOW()
         FROM tenants t
        WHERE t.user_id = $1
          AND sa.tenant_id = t.id
          AND sa.status = 'active'
          AND sa.payer_accepted_at IS NULL`,
      [user.id])

    // S568: role-aware — activate the account under the user's ACTUAL role.
    // Real tenants keep role='tenant' (unchanged); an e-sign 'contact' (customer
    // pool, no tenant profile) activates as 'contact' with a null profileId so
    // they're never mis-issued a tenant identity.
    const tenant = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [user.id])

    // S558 (Flow B): stamp this person's unit-bound intent as accepted, then
    // auto-draft the lease(s) if the unit's roster is now ready. Best-effort in
    // its own transaction — a draft failure never blocks the tenant's login.
    try {
      const intent = await queryOne<{ id: string; unit_id: string | null }>(
        `SELECT pti.id, pti.unit_id
           FROM pending_tenant_intents pti JOIN tenants t ON t.id = pti.tenant_id
          WHERE t.user_id = $1 AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL AND pti.unit_id IS NOT NULL
          ORDER BY pti.created_at DESC LIMIT 1`, [user.id])
      if (intent?.unit_id) {
        const draftClient = await getClient()
        try {
          await draftClient.query('BEGIN')
          await draftClient.query(`UPDATE pending_tenant_intents SET accepted_at=NOW(), updated_at=NOW() WHERE id=$1 AND accepted_at IS NULL`, [intent.id])
          const { autoDraftLeasesForUnit } = await import('../services/leaseOnboarding')
          const { createDocumentRecord } = await import('./esign')
          await autoDraftLeasesForUnit(draftClient as any, intent.unit_id, createDocumentRecord)
          await draftClient.query('COMMIT')
        } catch (draftErr) {
          await draftClient.query('ROLLBACK').catch(() => {})
          logger.error({ err: draftErr, ctx: user.id }, '[ONBOARD-NEW-LEASE] auto-draft on accept failed')
        } finally {
          draftClient.release()
        }
      }
    } catch (e) {
      logger.error({ err: e, ctx: user.id }, '[ONBOARD-NEW-LEASE] accept-intent lookup failed')
    }

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

    // S578 (Nic): mandatory email-2FA at activation — same posture as the
    // landlord /register + prospect signup paths. The landlord created this user
    // with email_2fa_enabled defaulting off; flip it on and issue a PENDING
    // session (not a full token). The client trades the emailed 6-digit code at
    // /api/auth/email-otp/verify for the real token; that verify step also marks
    // the email verified. The lease auto-draft + landlord notify above still run
    // at accept time (activation), independent of the 2FA gate.
    await query(`UPDATE users SET email_2fa_enabled = TRUE WHERE id = $1`, [user.id])
    const emailOtpSession = signEmailOtpSessionToken({
      userId: user.id, role: user.role, email: user.email, profileId: tenant?.id ?? null,
      landlordId: null, landlordIds: null, businessId: null, staffRole: null, permissions: null,
    })
    await issueEmailOtp(user.id, user.email)

    res.json({
      success: true,
      data: {
        requiresEmailOtp: true, emailOtpSession,
        user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name }
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
        END AS deposit_fully_funded,
        -- S581: FlexPay is single-lease only. Flag it PAUSED for an ENROLLED
        -- tenant who now holds more than one active lease, so the home dashboard
        -- row and the Flex Advantage card both read from ONE server-computed
        -- signal (mirrors getFlexPayEligibility's 'multiple_leases' blocker + the
        -- advance-cron guard — the tenant isn't fronted while this is true).
        (t.flexpay_enrolled = true AND (
          SELECT COUNT(*)
            FROM lease_tenants lt2
            JOIN leases l2 ON l2.id = lt2.lease_id
           WHERE lt2.tenant_id = t.id
             AND lt2.status = 'active'
             AND l2.status IN ('active', 'pending')
        ) > 1) AS flexpay_paused_multi_lease,
        -- S579: the live invite/onboarding binding, so an APPLICANT (no lease yet)
        -- has a landlord + property to attribute their background check to. Falls
        -- back to the active lease's landlord/property for a housed tenant.
        COALESCE(pti.landlord_id, pr.landlord_id) AS landlord_id,
        COALESCE(pti.property_id, pr.id)          AS property_id,
        -- S615: this person may have NO LEASE and still belong here — a space
        -- next door on the landlord's trash or power, billed under a utility
        -- service agreement. Nic: "That person should really have access to the
        -- tenant portal to get on and pay their bill."
        --
        -- Everything above resolves through an ACTIVE LEASE, so for them it is
        -- all NULL and the portal would greet them with "undefined · Unit
        -- undefined" over a rent card that can never have a number in it. This
        -- is the signal that says which kind of person is logged in, so the home
        -- page can show what is actually true of them.
        sa.id                AS utility_service_agreement_id,
        sa.service_address   AS utility_service_address,
        sa.billing_due_day   AS utility_service_due_day,
        -- S616: so the portal shows "final bill requested" instead of offering
        -- the button again to somebody who already pressed it.
        sa.moveout_notice_at,
        to_char(sa.moveout_expected_on, 'YYYY-MM-DD') AS moveout_expected_on,
        sau.unit_number      AS utility_service_space,
        sap.name             AS utility_service_property_name
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
      LEFT JOIN LATERAL (
        SELECT landlord_id, property_id
        FROM pending_tenant_intents
        WHERE tenant_id = t.id AND cancelled_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      ) pti ON TRUE
      LEFT JOIN LATERAL (
        SELECT sa2.id, sa2.service_address, sa2.billing_due_day, sa2.unit_id,
               sa2.moveout_notice_at, sa2.moveout_expected_on
          FROM utility_service_agreements sa2
         WHERE sa2.tenant_id = t.id AND sa2.status = 'active'
         ORDER BY sa2.start_date DESC
         LIMIT 1
      ) sa ON TRUE
      LEFT JOIN units sau      ON sau.id = sa.unit_id
      LEFT JOIN properties sap ON sap.id = sau.property_id
      WHERE t.id = $1`, [req.user!.profileId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    res.json({ success: true, data: tenant })
  } catch (e) { next(e) }
})


// ── S581: landlord NOTICES (blocking portal pop-up) ──────────────────────
// A NOTICE addendum (e.g. a rent-increase the tenant can't refuse) is not signed
// by the tenant — instead they get a blocking pop-up on login to view + acknowledge.

// GET /api/tenants/lease-notices — pending notices for the pop-up. Stamps
// viewed_at on first surface (proof the tenant saw it), before they acknowledge.
tenantsRouter.get('/lease-notices', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const tenantId = req.user!.profileId
    const rows = await query<any>(
      `SELECT ln.id, ln.title, ln.body,
              to_char(ln.effective_date, 'YYYY-MM-DD') AS effective_date,
              ln.created_at, ln.viewed_at,
              u.unit_number, p.name AS property_name
         FROM lease_notices ln
         JOIN leases l     ON l.id = ln.lease_id
         JOIN units u      ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE ln.tenant_id = $1 AND ln.status = 'pending'
        ORDER BY ln.created_at ASC`,
      [tenantId])
    const unviewed = rows.filter((r: any) => !r.viewed_at).map((r: any) => r.id)
    if (unviewed.length > 0) {
      await query(
        `UPDATE lease_notices SET viewed_at = NOW(), updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND viewed_at IS NULL`, [unviewed])
    }
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/tenants/lease-notices/:id/acknowledge — tenant clicks Acknowledge to
// dismiss the pop-up. Records acknowledged_at (+ viewed_at). Idempotent, own-notice.
tenantsRouter.post('/lease-notices/:id/acknowledge', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const tenantId = req.user!.profileId
    const r = await query<{ id: string }>(
      `UPDATE lease_notices
          SET status = 'acknowledged',
              acknowledged_at = COALESCE(acknowledged_at, NOW()),
              viewed_at = COALESCE(viewed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2
        RETURNING id`,
      [req.params.id, tenantId])
    if (r.length === 0) throw new AppError(404, 'Notice not found')
    res.json({ success: true, data: { id: r[0].id, acknowledged: true } })
  } catch (e) { next(e) }
})

// ── GET /api/tenants/me/payment-health ───────────────────────────────────
// #12: the tenant's own view of the Payment Health card the landlord sees on
// TenantDetailPage — same metric (settled / total payments → on-time rate)
// computed from the authenticated tenant's own payments. Gives the resident
// a positive, at-a-glance read on their standing.
tenantsRouter.get('/me/payment-health', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const tenantId = req.user!.profileId
    const s = await queryOne<any>(`
      SELECT
        COUNT(*) AS total_payments,
        COUNT(*) FILTER (WHERE status = 'settled') AS settled,
        COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
        COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) AS total_paid,
        MIN(due_date) AS first_payment
      FROM payments WHERE tenant_id = $1`, [req.user!.profileId])
    const total = parseInt(s?.total_payments || 0)
    const settled = parseInt(s?.settled || 0)
    const firstPayment = s?.first_payment ? new Date(s.first_payment) : null
    const tenantMonths = firstPayment
      ? Math.floor((Date.now() - firstPayment.getTime()) / (1000 * 60 * 60 * 24 * 30))
      : 0

    // S595 (Nic): TRUE on-time payment health for the heartbeat monitor — of the
    // tenant's billed obligations (rent/utility/fee/home_payment) that have
    // RESOLVED (settled, or already past due_date + the lease grace window), how
    // many settled ON TIME (by due_date + grace). Per-month for the last 6 months
    // (the beats) + the window rate (the color). This is on-time-ness, NOT total
    // paid — a tenant who always pays but always late reads unhealthy here.
    // Excludes late_fees (the penalty) and deposits (one-time move-in).
    const otRows = await query<any>(`
      WITH obl AS (
        SELECT date_trunc('month', p.due_date) AS m,
               (p.status = 'settled'
                 AND p.settled_at::date <= p.due_date + COALESCE(l.late_fee_grace_days, 0)) AS on_time,
               (p.status = 'settled'
                 OR (p.due_date + COALESCE(l.late_fee_grace_days, 0)) < CURRENT_DATE) AS counted
          FROM payments p
          LEFT JOIN leases l ON l.id = p.lease_id
         WHERE p.tenant_id = $1
           AND p.type IN ('rent','utility','fee','home_payment')
           AND p.due_date >= (date_trunc('month', CURRENT_DATE) - interval '5 months')::date
      )
      SELECT to_char(m, 'Mon') AS month, to_char(m, 'YYYY-MM') AS ym,
             COUNT(*) FILTER (WHERE counted)             AS total,
             COUNT(*) FILTER (WHERE counted AND on_time) AS on_time
        FROM obl
       GROUP BY m
       ORDER BY m`, [tenantId])
    const winTotal  = otRows.reduce((n: number, r: any) => n + parseInt(r.total || 0), 0)
    const winOnTime = otRows.reduce((n: number, r: any) => n + parseInt(r.on_time || 0), 0)

    res.json({
      success: true,
      data: {
        onTimeRate: total > 0 ? Math.round((settled / total) * 100) : 0,
        settledCount: settled,
        failedCount: parseInt(s?.failed || 0),
        totalPayments: total,
        totalPaid: parseFloat(s?.total_paid || 0),
        tenantMonths,
        // S595: real on-time health (drives the tenant heartbeat monitor).
        onTime: {
          pct: winTotal > 0 ? Math.round((winOnTime / winTotal) * 100) : null,
          resolved: winTotal,
          onTimeCount: winOnTime,
          months: otRows.map((r: any) => {
            const t = parseInt(r.total || 0), ot = parseInt(r.on_time || 0)
            return { month: r.month, ym: r.ym, total: t, onTime: ot, rate: t > 0 ? ot / t : null }
          }),
        },
      },
    })
  } catch (e) { next(e) }
})


// ── GET /api/tenants/me/move-in-gate ─────────────────────────────────────
// Tenant #6 (Nic 2026-06-26): the move-in inspection must be COMPLETED within
// 48 hours of the lease start date. Past that, an incomplete (still-draft)
// move-in inspection LOCKS the tenant out of the rest of the portal until they
// finish it, and they assume liability for any undocumented conditions. The
// first time the window lapses we stamp move_in_deadline_missed_at as the audit
// record of when that liability shifted.
//
// Scope choice: the gate only fires when a move-in inspection actually EXISTS
// and is still 'draft' past the deadline — a tenant is never locked out for the
// landlord never having started one. The inspection routes stay reachable so
// the locked-out tenant can still go complete it (the one allowed action).
tenantsRouter.get('/me/move-in-gate', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const row = await queryOne<any>(`
      SELECT i.id, i.status, i.move_in_deadline_missed_at,
             l.start_date,
             (l.start_date::timestamptz + interval '48 hours') AS deadline
        FROM v_lease_active_tenants vlat
        JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        JOIN unit_inspections i
          ON i.tenant_id = vlat.tenant_id
         AND i.inspection_type = 'move_in'
         AND (i.lease_id = l.id OR i.unit_id = l.unit_id)
       WHERE vlat.tenant_id = $1
         AND i.status <> 'cancelled'
       ORDER BY i.created_at DESC
       LIMIT 1`, [req.user!.profileId])

    if (!row) { res.json({ success: true, data: { gated: false, hasMoveIn: false } }); return }

    const completed = row.status !== 'draft'   // tenant_signed/landlord_signed/finalized/disputed
    const overdue = !completed && new Date() > new Date(row.deadline)

    // Stamp the moment liability first shifts (idempotent).
    if (overdue && !row.move_in_deadline_missed_at) {
      await query(`UPDATE unit_inspections SET move_in_deadline_missed_at = now() WHERE id = $1 AND move_in_deadline_missed_at IS NULL`, [row.id])
    }

    res.json({
      success: true,
      data: {
        hasMoveIn: true,
        inspectionId: row.id,
        completed,
        deadline: row.deadline,
        overdue,
        gated: overdue,            // locked out of the rest of the portal
        liabilityAssumedAt: row.move_in_deadline_missed_at ?? (overdue ? new Date().toISOString() : null),
      },
    })
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
      unit_type:          string | null
      property_name:      string | null
      created_at:         string
    }>(
      `SELECT sd.id, sd.lease_id,
              sd.total_amount::text     AS total_amount,
              sd.collected_amount::text AS collected_amount,
              sd.interest_accrued::text AS interest_accrued,
              sd.status, sd.held_by,
              p.state, u.unit_type, p.name AS property_name,
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

    // Look up the effective rate for the deposit's state, UNIT TYPE, and the
    // current accrual year. Statutory catalog wins; falls back to the
    // landlord's S190 override for variable-rate states. Returns null
    // if neither has a rate — tenant sees principal-only.
    //
    // S604: this used to run its OWN state-only `LIMIT 1` lookup. Once the
    // S603 catalog became unit-type specific that read the wrong row: an
    // Arizona APARTMENT tenant was shown 5.0000% citing A.R.S. § 33-1431(B),
    // the MOBILE HOME statute, for interest they are owed none of — and it
    // disagreed with what the accrual engine actually booked. There is one
    // resolver now; the tenant is quoted the same rule that accrues.
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
      const landlordRow = await queryOne<{ landlord_id: string }>(
        `SELECT l.landlord_id FROM leases l WHERE l.id = $1`,
        [deposit.lease_id],
      )
      if (landlordRow) {
        const { resolveRateForLandlord } = await import('../services/depositInterest')
        const resolved = await resolveRateForLandlord(
          landlordRow.landlord_id, deposit.state, currentYear, deposit.unit_type,
        )
        if (resolved) {
          rate = {
            source:           resolved.source,
            state_code:       resolved.state_code,
            effective_year:   resolved.effective_year,
            annual_rate_pct:  resolved.annual_rate_pct.toFixed(4),
            statute_citation: resolved.statute_citation ?? null,
            notes:            resolved.notes ?? null,
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
// Sets ach_verified=true and reports whether the security deposit is fully funded.
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
          ? 'Bank verified!'
          : 'Bank verified. Your security deposit is not yet fully funded.'
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

// POST /api/tenants/flexcharge/:accountId/pay — S583 revolving: pay DOWN the
// balance (more than the auto-pulled minimum, up to paying in full → no interest
// next cycle). Charges the tenant's default method; the balance credit + merchant
// transfer settle on the webhook.
tenantsRouter.post('/flexcharge/:accountId/pay', async (req, res, next) => {
  try {
    const { amount } = z.object({ amount: z.number().positive() }).parse(req.body)
    const { payDownFlexCharge } = await import('../services/flexCharge')
    const out = await payDownFlexCharge({
      accountId: req.params.accountId,
      tenantId:  req.user!.profileId,
      amount,
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

// ── S542: platform-originated questionnaires (LANDLORD-INVISIBLE) ──
// Tenant-only surfaces. No landlord route may ever expose this table.
tenantsRouter.get('/questionnaires', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const rows = await query<any>(
      `SELECT id, trigger_type, created_at
         FROM tenant_questionnaires
        WHERE tenant_id = $1 AND status = 'pending'
        ORDER BY created_at ASC`,
      [req.user!.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

tenantsRouter.post('/questionnaires/:id/answer', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const body = z.object({
      incomeSource: z.enum(['ssi', 'ssdi', 'other_fixed', 'none']),
      interested:   z.boolean(),
      benefitDay:   z.number().int().min(1).max(28).optional(),
      benefitSchedule: z.enum(['ssi_day_1', 'ssdi_day_3', 'ssdi_wed_2', 'ssdi_wed_3', 'ssdi_wed_4', 'fixed_day']).optional(),
    }).parse(req.body)
    const { answerQuestionnaire } = await import('../services/tenantQuestionnaires')
    const out = await answerQuestionnaire({
      tenantId: req.user!.profileId,
      questionnaireId: req.params.id,
      answers: body,
    })
    if (!out.ok) throw new AppError(409, out.reason)
    res.json({ success: true, data: { inquiryFiled: out.inquiryFiled } })
  } catch (e) { next(e) }
})

tenantsRouter.post('/questionnaires/:id/dismiss', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const { dismissQuestionnaire } = await import('../services/tenantQuestionnaires')
    const ok = await dismissQuestionnaire(req.user!.profileId, req.params.id)
    if (!ok) throw new AppError(404, 'Questionnaire not found or already completed')
    res.json({ success: true, data: { dismissed: true } })
  } catch (e) { next(e) }
})

// ── S542b: FlexPay proof-of-income upload ───────────────────────────
// Imported tenants have no income data on file (they never ran the
// new-tenant flow), and FlexPay is hard-gated to PROVEN SSI/SSDI —
// so the tenant shows proof directly TO THE PLATFORM here (award
// letter / benefit verification letter), attached to their inquiry.
// Landlord never sees it: served only via the tenant's own GET below
// and the admin queue's GET (routes/admin.ts). S409 posture: on-disk
// extension normalized from validated MIME, Content-Type pinned at
// serve time.
const FLEXPAY_PROOF_MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
}
const flexpayProofDir = path.join(process.cwd(), 'uploads', 'flexpay-proofs')
if (!fs.existsSync(flexpayProofDir)) fs.mkdirSync(flexpayProofDir, { recursive: true })
const flexpayProofUpload = multer({
  storage: multer.diskStorage({
    destination: flexpayProofDir,
    filename: (_req: any, file: any, cb: any) => {
      const ext = FLEXPAY_PROOF_MIME_TO_EXT[file.mimetype] ?? '.pdf'
      cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext)
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (FLEXPAY_PROOF_MIME_TO_EXT[file.mimetype]) cb(null, true)
    else cb(new Error('PDF, JPEG, PNG or WEBP only'))
  },
})

tenantsRouter.post('/flexpay/inquiry/proof', flexpayProofUpload.single('file'), async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    if (!req.file) throw new AppError(400, 'No file')
    const inq = await queryOne<{ id: string; status: string; proof_file_path: string | null }>(
      `SELECT id, status, proof_file_path FROM flexpay_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId])
    if (!inq) throw new AppError(409, 'No FlexPay request on file — tap "I’m interested" first')
    if (inq.status !== 'pending') throw new AppError(409, 'Your request has already been reviewed')
    // Replace semantics: one active document; unlink the old one.
    if (inq.proof_file_path) {
      fs.unlink(path.join(flexpayProofDir, path.basename(inq.proof_file_path)), () => {})
    }
    await query(
      `UPDATE flexpay_inquiries
          SET proof_file_path = $2, proof_original_name = $3,
              proof_uploaded_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [inq.id, req.file.filename, String(req.file.originalname || 'proof').slice(0, 200)])

    // S546: automated verification — reads the PDF, matches lease-
    // holder names, scans for benefit language. Mismatch/unreadable →
    // SILENT hold; the response never reveals the outcome.
    const { verifyProofDocument } = await import('../services/flexpayAutoVerify')
    await verifyProofDocument(inq.id)

    res.json({ success: true, data: { uploaded: true, originalName: req.file.originalname } })
  } catch (e) { next(e) }
})

// Tenant's own proof view. Content-Type pinned from the stored
// (MIME-normalized) extension — never from client input.
export function flexpayProofContentType(filename: string): string {
  if (filename.endsWith('.pdf')) return 'application/pdf'
  if (filename.endsWith('.png')) return 'image/png'
  if (filename.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}
tenantsRouter.get('/flexpay/inquiry/proof-file', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const inq = await queryOne<{ proof_file_path: string | null }>(
      `SELECT proof_file_path FROM flexpay_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId])
    if (!inq?.proof_file_path) throw new AppError(404, 'No proof on file')
    const fp = path.join(flexpayProofDir, path.basename(inq.proof_file_path))
    if (!fs.existsSync(fp)) throw new AppError(404, 'File missing')
    res.setHeader('Content-Type', flexpayProofContentType(fp))
    fs.createReadStream(fp).pipe(res)
  } catch (e) { next(e) }
})

// GET /api/tenants/flex-visibility — S541: which Flex products the
// tenant portal may surface. Per-product rollout flags drive the UI
// (the old client-side LAUNCH_HIDDEN gate showed all-or-nothing);
// flipping one product on shows exactly that product.
tenantsRouter.get('/flex-visibility', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    const [flexpay, flexdeposit, flexcredit] = await Promise.all([
      isFeatureEnabled('flexpay_rollout_visible'),
      isFeatureEnabled('flexdeposit_rollout_visible'),
      isFeatureEnabled('flexcredit_rollout_visible'),
    ])
    res.json({ success: true, data: { flexpay, flexdeposit, flexcredit } })
  } catch (e) { next(e) }
})

// GET /api/tenants/flexpay — current enrollment + eligibility
tenantsRouter.get('/flexpay', async (req, res, next) => {
  try {
    const { isFlexPayVisible, isFlexPayEnrollmentOpen, getFlexPayEligibility, calculateFlexPayFee } = await import('../services/flexpay')
    const visible = await isFlexPayVisible()
    if (!visible) return res.json({ success: true, data: { visible: false } })
    // S544: survey mode — visible but not launched. Drives the
    // "coming soon" tenant framing; enrollment refuses server-side too.
    const enrollmentOpen = await isFlexPayEnrollmentOpen()

    const row = await queryOne<any>(
      `SELECT flexpay_enrolled, flexpay_pull_day, flexpay_monthly_fee,
              flexpay_enrolled_at, flexpay_disqualified_until,
              flexpay_disqualified_reason
         FROM tenants WHERE id = $1`,
      [req.user!.profileId],
    )
    const eligibility = await getFlexPayEligibility(req.user!.profileId)

    // S541: demand-test gate — the tenant's inquiry disposition drives
    // the card state (inquire → pending → approved-can-enroll / declined).
    const inquiry = await queryOne<any>(
      `SELECT id, status, claimed_income_source, created_at, reviewed_at,
              proof_original_name, proof_uploaded_at
         FROM flexpay_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId],
    )

    // S542c (Nic): tenants NEVER see a queue number — no promises.
    // Ordering (float-need first, then FIFO) lives admin-side only;
    // the tenant just knows they're in line, plus a state hold when
    // their state is legally blocked (place preserved either way).
    let stateHold = false
    if (inquiry?.status === 'pending') {
      const hold = await queryOne(
        `SELECT 1
           FROM lease_tenants lt
           JOIN leases l ON l.id = lt.lease_id
           JOIN units u ON u.id = l.unit_id
           JOIN properties pr ON pr.id = u.property_id
           JOIN flexpay_blocked_states bs ON bs.state = pr.state
          WHERE lt.tenant_id = $1 AND lt.status = 'active'
            AND l.status IN ('active', 'pending')
          LIMIT 1`,
        [req.user!.profileId])
      stateHold = !!hold
    }

    res.json({
      success: true,
      data: {
        visible: true,
        enrollmentOpen,
        ...row,
        eligibility,
        inquiry,
        stateHold,
        previewFee: row?.flexpay_pull_day ? calculateFlexPayFee(row.flexpay_pull_day) : null,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexpay/inquiry — S541 demand-test entry point.
// The tenant raises a hand ("I'm interested"); GAM reviews the lease,
// verifies SSI/SSDI income, and approves from the admin portal. Low
// friction by design: no ACH / eligibility precheck here — that all
// gates ENROLLMENT, not interest. One inquiry row per tenant.
tenantsRouter.post('/flexpay/inquiry', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const { isFlexPayVisible } = await import('../services/flexpay')
    if (!(await isFlexPayVisible())) throw new AppError(409, 'FlexPay is not available')

    const body = z.object({
      // S545: all income types accepted — non-SSI/SSDI files a TIER-2
      // request (same queue, behind SSI/SSDI, income-hold on approval).
      incomeSource: z.enum(['ssi', 'ssdi', 'other_fixed', 'none']),
      // S545b: the PATTERN the program pays on (SSI 1st, SSDI 3rd or
      // Nth Wednesday, fixed day). Preferred over a raw day.
      benefitSchedule: z.enum(['ssi_day_1', 'ssdi_day_3', 'ssdi_wed_2', 'ssdi_wed_3', 'ssdi_wed_4', 'fixed_day']).optional(),
      // S542c: raw day — used with fixed_day schedules / legacy calls.
      benefitDay:   z.number().int().min(1).max(28).optional(),
      note:         z.string().max(1000).optional(),
    }).parse(req.body)

    // Derive the conservative arrival day from the schedule (latest
    // day the pattern can land) — float math runs on days.
    const { benefitScheduleToDay } = await import('@gam/shared')
    const derivedDay = body.benefitSchedule
      ? benefitScheduleToDay(body.benefitSchedule, body.benefitDay ?? null)
      : body.benefitDay ?? null

    const existing = await queryOne<{ status: string }>(
      `SELECT status FROM flexpay_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId],
    )
    if (existing) throw new AppError(409, 'You already have a FlexPay request on file')

    const row = await queryOne<any>(
      `INSERT INTO flexpay_inquiries (tenant_id, claimed_income_source, desired_pull_day, benefit_schedule, tenant_note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status, claimed_income_source, created_at`,
      [req.user!.profileId, body.incomeSource, derivedDay, body.benefitSchedule ?? null, body.note ?? null],
    )

    // S545c: silent birthdate-consistency check — may place a
    // verification hold. NO tenant-facing signal either way.
    const { runBirthdateCheck } = await import('../services/flexpayVerification')
    await runBirthdateCheck(row!.id)

    const { createAdminNotification } = await import('../services/adminNotifications')
    await createAdminNotification({
      severity: 'info',
      category: 'flexpay_inquiry',
      title: 'New FlexPay interest request',
      body: `Tenant ${req.user!.profileId} requested FlexPay (claims ${body.incomeSource.toUpperCase()}). Review in Admin → FlexPay Requests.`,
      context: { tenant_id: req.user!.profileId, inquiry_id: row.id },
    })

    res.json({ success: true, data: row })
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

// PATCH /api/tenants/flexpay/pull-day — change the scheduled pull day.
// Takes effect NEXT cycle (the current cycle's advance is already locked);
// the fee recomputes to $5 + the new day for future cycles.
tenantsRouter.patch('/flexpay/pull-day', async (req, res, next) => {
  try {
    const { changeFlexPayPullDay } = await import('../services/flexpay')
    const out = await changeFlexPayPullDay(req.user!.profileId, Number(req.body?.pullDay))
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: { pullDay: out.pullDay, fee: out.fee, effective: out.effective } })
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

// ── FLEXDEPOSIT (S246; custody model S514) ─────────────────────────────────
// FlexDeposit splits the security deposit into 2-6 installments based on
// deposit amount × Checkr BG risk_level. The tenant funds their OWN deposit
// into GAM custody: installment 1 at move-in, the rest monthly. GAM advances
// nothing — the deposit is held in custody (gam_escrow) and the deposit-return
// flow settles against what was actually collected. A missed installment only
// leaves the deposit under-funded (no acceleration/recourse — ToS § 9.1.5).
// $3/month custody fee applies while GAM holds the deposit.

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

    // S514: deposit-row context for the LeasePage. Returns the most recently
    // created FlexDeposit deposit for this tenant + how much is still
    // unfunded into custody, so the page can offer the voluntary pay-ahead.
    // No acceleration/in_default banner exists under the custody model.
    const deposit = await queryOne<{
      id:                        string
      flex_deposit_plan_status:  string | null
      total_amount:              string
      collected_amount:          string
      unfunded_amount:           string
    }>(
      `SELECT sd.id, sd.flex_deposit_plan_status,
              sd.total_amount::text     AS total_amount,
              sd.collected_amount::text AS collected_amount,
              COALESCE((
                SELECT SUM(amount)
                  FROM flex_deposit_installments
                 WHERE security_deposit_id = sd.id
                   AND status IN ('pending', 'missed')
              ), 0)::text               AS unfunded_amount
         FROM security_deposits sd
        WHERE sd.tenant_id = $1
          AND sd.flex_deposit_enabled = TRUE
        ORDER BY sd.created_at DESC
        LIMIT 1`,
      [req.user!.profileId],
    )

    res.json({ success: true, data: { visible: true, eligibility, plan, deposit } })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexdeposit/pay-ahead — tenant-initiated voluntary
// pay-ahead from the LeasePage. Fires one ACH pull for the unfunded
// (pending + missed) installments; success flips the plan to 'completed'.
// A failure is benign — the plan stays 'active' and scheduled pulls
// continue (custody model: no acceleration, no balance-due-in-full).
tenantsRouter.post('/flexdeposit/pay-ahead', async (req, res, next) => {
  try {
    const { payAheadFlexDeposit } = await import('../services/flexDeposit')
    const out = await payAheadFlexDeposit({ tenantId: req.user!.profileId })
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexdeposit/enroll
// body: { installmentCount: 2..6, acceptedTerms: true }
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
    if (!Number.isInteger(installmentCount) || installmentCount < 2 || installmentCount > 6) {
      throw new AppError(400, 'installmentCount must be an integer 2..6')
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
        uncollectedAtMoveIn: preview.schedule.uncollectedAtMoveIn,
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

// POST /api/tenants/enroll-credit-reporting
// FlexCredit (rent-payment reporting via Esusu). Gated on the
// flexcredit_rollout_visible flag — OFF at launch. The product is NOT built
// (no Esusu integration / billing yet), so until the flag is on we must NOT
// flip the column or promise reporting that doesn't happen.
tenantsRouter.post('/enroll-credit-reporting', async (req, res, next) => {
  try {
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    if (!await isFeatureEnabled('flexcredit_rollout_visible')) {
      return res.json({ success: true, data: { visible: false } })
    }
    await query(`UPDATE tenants SET credit_reporting_enrolled=TRUE WHERE id=$1`, [req.user!.profileId])
    res.json({ success: true, message: 'Credit reporting enrolled — $5/month reported to all 3 bureaus' })
  } catch (e) { next(e) }
})

// ── S565: FlexCredit DEMAND-CAPTURE (interest survey) ────────────────
// Separate from FlexPay (no income verification — credit reporting needs none).
// Captures interest only; NO billing/Esusu enrollment happens here (that's the
// later launch phase, gated on breakeven). Gated on flexcredit_rollout_visible
// so it stays hidden until the demand test opens.

// GET the tenant's own FlexCredit interest state (for the portal card).
tenantsRouter.get('/flexcredit/inquiry', async (req, res, next) => {
  try {
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    const visible = await isFeatureEnabled('flexcredit_rollout_visible')
    const inq = await queryOne<{ status: string; created_at: string }>(
      `SELECT status, created_at FROM flexcredit_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId]
    )
    res.json({ success: true, data: { visible, interested: !!inq, status: inq?.status ?? null } })
  } catch (e) { next(e) }
})

// POST — file (or re-affirm) interest. Idempotent per tenant.
tenantsRouter.post('/flexcredit/inquiry', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    if (!await isFeatureEnabled('flexcredit_rollout_visible')) {
      return res.json({ success: true, data: { visible: false, inquiryFiled: false } })
    }
    await query(
      `INSERT INTO flexcredit_inquiries (tenant_id, status)
       VALUES ($1, 'interested')
       ON CONFLICT (tenant_id) DO UPDATE SET updated_at = NOW()`,
      [req.user!.profileId]
    )
    res.json({ success: true, data: { visible: true, inquiryFiled: true } })
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
tenantsRouter.post('/invite', requirePerm('tenants.invite'), async (req, res, next) => {
  try {
    // S579: invites are now PROPERTY-level as well as unit-level. A prospective
    // applicant is invited to a property (`propertyId`, no unit yet — the unit is
    // chosen later at lease); the legacy unit-bound invite still works and is
    // left behaviourally untouched (no intent, no auto-draft change).
    const { email, firstName, lastName, unitId, phone, propertyId } = req.body
    if (!email || !firstName || (!unitId && !propertyId)) {
      return res.status(400).json({ success: false, error: 'Email, name and a unit or property are required' })
    }
    // S417: block disposable email domains so invites can't be sent to
    // throwaway addresses. Defeats the verification gate downstream.
    if (typeof email === 'string' && isDisposableEmail(email)) {
      return res.status(400).json({ success: false,
        error: 'Disposable / temporary email addresses are not allowed' })
    }

    // Resolve the landlord + property the invite binds to. Inviting a tenant
    // ties them to the property's landlord — admin override + team-role scope
    // are both valid here.
    let inviteLandlordId: string
    let inviterPropertyId: string | null = null
    if (unitId) {
      const unit = await queryOne<any>(`SELECT id, landlord_id, property_id FROM units WHERE id = $1`, [unitId])
      if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' })
      inviteLandlordId = unit.landlord_id
      inviterPropertyId = unit.property_id
    } else {
      const property = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
      if (!property) return res.status(404).json({ success: false, error: 'Property not found' })
      inviteLandlordId = property.landlord_id
      inviterPropertyId = property.id
    }
    if (!canAccessLandlordResource(req.user, inviteLandlordId)) {
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

    // Create the tenant record — but only if there is not one already.
    //
    // S628: this was `INSERT ... ON CONFLICT DO NOTHING`, and tenants.user_id
    // carries a PLAIN index (idx_tenants_user_id), not a unique one. With no
    // constraint to violate there was no conflict to do nothing about, so a
    // second invite to the same address minted a SECOND tenants row for the
    // same user. Everything downstream resolves a tenant by
    // `SELECT id FROM tenants WHERE user_id = ...` and would then get whichever
    // row came back first — the lease could attach to one and the payments to
    // the other. A characterisation test caught it (tenantInvite.test.ts,
    // "re-inviting the same address reuses the account"); nothing had
    // re-invited the same address in the dev data, which is why it was quiet.
    //
    // Look up first, then insert. Every sibling onboarding route in
    // routes/landlords.ts already does exactly this.
    let tenantId: string | undefined =
      (await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1 ORDER BY created_at ASC LIMIT 1',
        [user!.id]))?.id
    if (!tenantId) {
      tenantId = (await queryOne<any>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [user!.id]))?.id
    }

    // S579: for a PROPERTY-level screening invite (no unit yet), record a
    // property-bound intent so the background check the applicant completes
    // links to this property. unit_id stays NULL — this is a prospective
    // applicant, so there is NO unit assignment and NO lease auto-draft (that
    // fires only for unit-bound intents on accept). The legacy unit-bound invite
    // path is deliberately left as-is (no intent) to avoid double-drafting a
    // lease alongside the e-sign onboarding flow. Upsert the tenant's single
    // LIVE intent (partial-unique on tenant_id WHERE cancelled_at IS NULL).
    if (propertyId && !unitId && tenantId) {
      await query(
        `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, property_id, unit_id)
         VALUES ($1, $2, 'not_uploaded', $3, NULL)
         ON CONFLICT (tenant_id) WHERE cancelled_at IS NULL
         DO UPDATE SET property_id = EXCLUDED.property_id, resolved_at = NULL, updated_at = NOW()`,
        [inviteLandlordId, tenantId, inviterPropertyId])
    }

    // S605 (Nic): remember the unit this invite was for. The lease itself is
    // still created through e-sign — but without this row nothing knew WHO was
    // waiting on WHICH unit, so a landlord who invited before setting a lease
    // template could never have the draft catch up. Setting the default template
    // for a unit type now refires drafting for every unit still waiting.
    //
    // household_order preserves who was invited first: the primary resident
    // holds the lease, co-tenants follow.
    if (unitId && tenantId) {
      const seq = await queryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pending_lease_drafts WHERE unit_id = $1`, [unitId])
      await query(
        `INSERT INTO pending_lease_drafts (landlord_id, unit_id, tenant_user_id, household_order)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (unit_id, tenant_user_id) DO NOTHING`,
        [inviteLandlordId, unitId, user!.id, Number(seq?.n ?? 0)])
    }

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

    const acceptUrl = `${process.env.TENANT_APP_URL || 'http://localhost:3002'}/accept-invite?token=${inviteToken}`
    logger.info(`[INVITE] Tenant invite: ${email}`)

    // S628: SEND IT. The landlord's screen says "Invite Sent" and "they will
    // receive an email to set up their account", and until now nothing was
    // sent — the token was logged and the URL handed back for the landlord to
    // copy. The reminder job (jobs/inviteNudge.ts) did not cover it either: it
    // only walks unit-bound pending_tenant_intents, and this route creates a
    // pending_lease_draft for those instead. So an invited resident heard
    // nothing at all, and the invite lapsed after seven days in silence.
    //
    // Best-effort, exactly like the sibling onboarding route: the account and
    // the token already exist, so failing the request would leave a half-made
    // invite behind and tell the landlord to try again on something that had
    // already worked. A property-level invite means a background check is
    // still ahead of them; a unit-bound one does not.
    try {
      const ctxRow = await queryOne<any>(
        `SELECT p.name AS property_name,
                un.unit_number,
                COALESCE(NULLIF(la.business_name, ''),
                         NULLIF(TRIM(lu.first_name || ' ' || lu.last_name), ''),
                         'Your landlord') AS landlord_name
           FROM landlords la
           JOIN users lu ON lu.id = la.user_id
           LEFT JOIN units un ON un.id = $2::uuid
           LEFT JOIN properties p ON p.id = COALESCE(un.property_id, $3::uuid)
          WHERE la.id = $1`,
        [inviteLandlordId, unitId ?? null, inviterPropertyId])
      await emailTenantInvite(
        email,
        firstName,
        ctxRow?.landlord_name || 'Your landlord',
        ctxRow?.property_name || 'their property',
        ctxRow?.unit_number ? `Unit ${ctxRow.unit_number}` : null,
        acceptUrl,
        !unitId,
        { landlordId: inviteLandlordId, tenantId },
      )
    } catch (emailErr) {
      logger.error({ err: emailErr, ctx: email }, '[INVITE] invite email failed for')
    }

    res.json({
      success: true,
      data: {
        userId: user!.id,
        tenantId,
        email,
        inviteToken,
        acceptUrl,
      }
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/:tenantId/waive-screening — grandfather a SITTING tenant
// past the background check during a property's onboarding window.
//
// This is NOT a landlord "skip screening" toggle. It is only permitted while
// the property's onboarding window is OPEN, only for an occupied unit's sitting
// tenant, and only with the landlord's attestation that the person is an
// existing resident. Outside the window there is no waive — every new applicant
// screens. It sets background_check_status='waived' (the portal gate treats
// that as pass) and records an audit trail. It deliberately does NOT touch the
// tenant's intent unit_id (that would auto-draft a lease colliding with the
// e-sign onboarding) — the grandfathered unit is recorded in a dedicated column.
// See services/onboardingWindow.ts + memory gam-screening-grandfather-onboarding-window.
tenantsRouter.post('/:tenantId/waive-screening', requirePerm('tenants.invite'), async (req, res, next) => {
  try {
    const { tenantId } = req.params
    const { propertyId, unitId, attested } = req.body
    if (!propertyId || !unitId) {
      return res.status(400).json({ success: false, error: 'propertyId and unitId (the occupied unit) are required' })
    }
    if (attested !== true) {
      return res.status(400).json({ success: false, error: 'You must attest this person is an existing resident to waive screening' })
    }
    const property = await queryOne<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) return res.status(404).json({ success: false, error: 'Property not found' })
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }
    const unit = await queryOne<{ id: string; property_id: string }>(
      `SELECT id, property_id FROM units WHERE id = $1`, [unitId])
    if (!unit || unit.property_id !== propertyId) {
      return res.status(400).json({ success: false, error: 'Unit does not belong to that property' })
    }
    const tenant = await queryOne<{ id: string }>(`SELECT id FROM tenants WHERE id = $1`, [tenantId])
    if (!tenant) return res.status(404).json({ success: false, error: 'Tenant not found' })

    const result = await applyScreeningWaive({
      tenantId, landlordId: property.landlord_id, propertyId, unitId, byUserId: req.user!.userId,
    })
    if (!result.waived) {
      if (result.reason === 'window_closed') {
        return res.status(403).json({ success: false,
          error: "This property's onboarding window has closed — a background check is required." })
      }
      if (result.reason === 'unit_taken') {
        return res.status(409).json({ success: false, error: 'This unit already has a grandfathered resident.' })
      }
    }
    res.json({ success: true, data: { tenantId, status: 'waived' } })
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
tenantsRouter.post('/:id/transfer', requirePerm('tenants.transfer_unit'), async (req, res, next) => {
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
      // S508: document_url always points at the on-demand lease-PDF endpoint
      // so the in-browser viewer renders every lease (generated from terms when
      // there's no e-signed/imported PDF). camelized → lease.documentUrl.
      data: lease
        ? { ...lease, document_url: `/api/leases/${lease.id}/pdf`, state_law_warnings: stateLawWarnings }
        : lease,
    })
  } catch (e) { next(e) }
})

// S554 (Oak Park): a tenant can hold MORE THAN ONE active lease — e.g. space
// rent on two mobile homes under the same landlord (the same-landlord overlap
// exception in esign.ts allows this deliberately). GET /lease (above) returns
// only the first (LIMIT 1); this plural route returns EVERY active/pending
// lease so the portal can switch between them. Billing is already per-lease
// (payments/invoices carry lease_id), so this closes the display gap.
tenantsRouter.get('/leases', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    const leases = await query<any>(`
      SELECT l.*, p.name as property_name, p.state as property_state,
        u.unit_number,
        (SELECT amount FROM lease_fees lf
          WHERE lf.lease_id = l.id
            AND lf.fee_type = 'security_deposit'
            AND lf.due_timing = 'move_in'
          LIMIT 1) AS security_deposit,
        lu.first_name || ' ' || lu.last_name as landlord_name,
        COALESCE(vuo.primary_first_name || ' ' || vuo.primary_last_name, '') as tenant_name
      FROM lease_tenants lt
      JOIN leases l ON l.id = lt.lease_id
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu ON lu.id = la.user_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE lt.tenant_id = $1
        AND lt.status = 'active'
        AND l.status IN ('pending', 'active')
      ORDER BY l.created_at DESC`, [tenant.id])

    const enriched = []
    for (const lease of leases as any[]) {
      let stateLawWarnings: LawFlag[] = []
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
        logger.error({ err: e, lease_id: lease.id }, '[stateLaw] tenant leases GET checks failed')
      }
      enriched.push({ ...lease, document_url: `/api/leases/${lease.id}/pdf`, state_law_warnings: stateLawWarnings })
    }

    res.json({ success: true, data: enriched })
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
