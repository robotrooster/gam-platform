import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireAdmin, requireLandlord, requirePerm } from '../middleware/auth'
import { resolveLandlordIdForUser } from '../lib/scope'
import { canAccessLandlordResource, canViewLandlordFinances, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { emailTenantOnboarded } from '../services/email'
import { createNotification } from '../services/notifications'
import { applyScreeningWaive, listOnboardingWindowsForLandlord } from '../services/onboardingWindow'
import { scheduleParserJob } from '../jobs/leaseParser/runParserJob'
import { resolveIntent } from '../jobs/leaseParser/resolveIntent'
import { parse as parseCsv } from 'csv-parse/sync'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { extractUploadFilename } from '../lib/uploadPaths'
import {
  applyMapping, buildTemplateCsv, isCsvImportPlatform, isPlatformEnabled,
  applyPropertyMapping, buildPropertyTemplateCsv, getPropertyPlatformConfig,
  applyPaymentMapping, buildPaymentTemplateCsv, getPaymentPlatformConfig,
  type CsvImportPlatform,
} from '../lib/csvImportMappings'
import { AUTO_RENEW_MODES, PM_LINK_SCOPES, formatInvoiceNumber, UNIT_TYPES, FLEX_CHARGE_MAX_FINANCE_PCT, occupancyRateFrom } from '@gam/shared'
import { emailPmPropertyInvitation, emailLandlordCoOwnerInvitation } from '../services/email'
import { platformFeesByProperty, periodMonths } from '../services/platformFee'
import {
  sendPropertyInvitation, acceptPropertyInvitation,
  rejectPropertyInvitation, revokePropertyInvitation,
} from '../services/pm'
import { logger } from '../lib/logger'
import { randomUUID } from 'crypto'
import { unitNumberNeedsPrefix } from '@gam/shared'
import { checkAgainstStatute } from '../services/stateLaw'
import { assertLateFeeDecisionForUnit, assertLateFeeDecision } from '../services/lateFeePolicy'
import { assertUnitCanAcceptNewLease } from '../services/leaseOnboarding'
import {
  recordValidateAttempt,
  recordCommitAttempt,
  getPlatformReviewStatus,
  extractAttemptShape,
  notifyCsvReviewPendingIfNeeded,
} from '../services/csvImportAttempts'

export const landlordsRouter = Router()
// S605: the invite PREVIEW is deliberately public and sits above requireAuth.
// The person being invited has no account yet — that is the entire point of
// the flow — so they must be able to see who invited them and to what before
// being asked to register. Express matches in order, so anything registered
// after this line is authenticated.
// GET /api/landlords/member-invite/:token — unauthenticated preview so the
// accept page can say WHO invited them and to WHAT before asking them to sign up.
landlordsRouter.get('/member-invite/:token', async (req, res, next) => {
  try {
    const inv = await queryOne<any>(
      `SELECT i.id, i.email, i.expires_at, i.status, l.business_name,
              u.first_name, u.last_name
         FROM landlord_member_invitations i
         JOIN landlords l ON l.id = i.landlord_id
         JOIN users u ON u.id = i.invited_by_user_id
        WHERE i.token = $1`, [req.params.token])
    if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) {
      throw new AppError(404, 'That invitation has expired or already been used. Ask your partner to send a new one.')
    }
    res.json({ success: true, data: {
      email: inv.email,
      entityName: inv.business_name,
      invitedBy: [inv.first_name, inv.last_name].filter(Boolean).join(' ').trim(),
    } })
  } catch (e) { next(e) }
})

landlordsRouter.use(requireAuth)

// S592: exported so the scoped /api/portfolio router shares this EXACT handler
// (already portfolio-scoped by req.user.userId — a portfolio_manager sees ONLY
// their book; super_admin sees all). Registered below on /api/landlords for the
// admin app, and on /api/portfolio/landlords for the PM portal.
export const adminLandlordsListHandler = async (req: any, res: any, next: any) => {
  try {
    // Portfolio scoping (S567): super_admin sees every landlord; a regular
    // admin (portfolio manager) sees ONLY their own book — landlords they close
    // or service. Unassigned/self-closed leads are routed by super_admin, not
    // browsed from a pool.
    const scopeId = req.user?.role === 'super_admin' ? null : req.user?.userId
    const landlords = await query<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, u.phone,
        pmu.first_name AS pm_first_name, pmu.last_name AS pm_last_name,
        smu.first_name AS sm_first_name, smu.last_name AS sm_last_name,
        rbu.first_name AS referrer_first_name, rbu.last_name AS referrer_last_name,
        COUNT(DISTINCT p.id)::int AS property_count,
        -- S616 (Nic): a neighbour's serviced space is NEITHER. "It doesn't
        -- count as a vacancy. It doesn't count as an occupied unit. It doesn't
        -- count as anything in terms of that — just utilities coming in."
        --
        -- It is somebody else's building that this landlord happens to supply
        -- power or trash to. Counting it as a unit inflates the portfolio;
        -- counting it as occupied inflates the occupancy rate with a space that
        -- was never rentable. It was landing in BOTH, because the occupancy
        -- filter only asked "is it vacant" and a serviced space is not.
        --
        -- Its utility income still reaches the books — that is separate, and
        -- correct: the money is real, the $2 fee is charged on it, and it shows
        -- as collected. What it is not is rent, occupancy, or inventory.
        COUNT(DISTINCT u2.id) FILTER (WHERE u2.status <> 'utility_service')::int AS unit_count,
        COUNT(DISTINCT u2.id) FILTER (
          WHERE u2.status <> 'vacant' AND u2.status <> 'utility_service')::int AS occupied_count,
        EXISTS (
          SELECT 1 FROM user_bank_accounts ba
           WHERE ba.user_id = l.user_id AND ba.status = 'active'
        ) AS bank_account_ready
      FROM landlords l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN users pmu ON pmu.id = l.portfolio_manager_id
      LEFT JOIN users smu ON smu.id = l.service_manager_id
      LEFT JOIN users rbu ON rbu.id = l.referred_by_user_id
      LEFT JOIN properties p ON p.landlord_id = l.id
      LEFT JOIN units u2 ON u2.landlord_id = l.id
      WHERE $1::uuid IS NULL
         OR l.portfolio_manager_id = $1::uuid
         OR l.service_manager_id = $1::uuid
      GROUP BY l.id, l.user_id, u.first_name, u.last_name, u.email, u.phone,
               pmu.first_name, pmu.last_name, smu.first_name, smu.last_name,
               rbu.first_name, rbu.last_name
      ORDER BY u.last_name`, [scopeId])
    res.json({ success: true, data: landlords })
  } catch (e) { next(e) }
}
landlordsRouter.get('/', requireAdmin, adminLandlordsListHandler)



// ── FLEXCHARGE LANDLORD ROUTES ────────────────────────────────────────────
// S131: all four flexcharge routes intentionally stay requireLandlord.
// FlexCharge is a tenant credit-line product; setting limits, suspending,
// and revoking is owner financial authority — same posture as
// PATCH /:id/allocation-rule on properties.

// S252: FlexCharge — consolidated POS charge-account product.
// Replaces the pre-S252 phantom-column routes that targeted
// nonexistent flex_charge_accounts schema. The new shape supports
// both tenant-customers and non-tenant pos_customers, with per-
// (customer, property) account semantics. Engine + statement math
// live in services/flexCharge.ts.

// ── landlord referral (S567) ──────────────────────────────────────
// A landlord's own referral code + shareable signup link. Referring another
// landlord makes the referrer the CLOSER on that landlord — a 25¢/occupied
// unit/month residual, identical to a PM closer (customer service still routes
// to a PM). Lazily generates the code on first request.
landlordsRouter.get('/my-referral', requireAuth, requireLandlord, async (req: any, res, next) => {
  try {
    const uid = req.user.userId
    let row = await queryOne<any>(`SELECT referral_code FROM users WHERE id=$1`, [uid])
    if (!row?.referral_code) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = ('L' + uid.replace(/-/g, '') + attempt).slice(0, 8).toUpperCase()
        try { await query(`UPDATE users SET referral_code=$1 WHERE id=$2`, [code, uid]); row = { referral_code: code }; break }
        catch { /* unique collision — try next */ }
      }
    }
    const base = process.env.LANDLORD_SIGNUP_URL || 'https://app.goldassetmanagement.com/signup'
    res.json({ success: true, data: {
      referralCode: row?.referral_code ?? null,
      referralLink: row?.referral_code ? `${base}?ref=${row.referral_code}` : null,
    }})
  } catch (e) { next(e) }
})

// The landlord's referral earnings — closing commission on landlords they
// referred (they are the closing manager on those accruals).
landlordsRouter.get('/referral-earnings', requireAuth, requireLandlord, async (req: any, res, next) => {
  try {
    const uid = req.user.userId
    const [tot] = await query<any>(
      `SELECT COALESCE(SUM(amount),0) AS all_time,
              COALESCE(SUM(amount) FILTER (WHERE accrual_month = date_trunc('month', now())::date),0) AS this_month
         FROM commission_accruals WHERE manager_id=$1 AND role='closing' AND NOT to_pot`, [uid])
    const byLandlord = await query<any>(
      `SELECT ca.landlord_id, lu.first_name, lu.last_name, l.business_name,
              MAX(ca.occupied_units) AS occupied_units,
              COALESCE(SUM(ca.amount),0) AS all_time,
              COALESCE(SUM(ca.amount) FILTER (WHERE ca.accrual_month = date_trunc('month', now())::date),0) AS this_month
         FROM commission_accruals ca
         JOIN landlords l ON l.id = ca.landlord_id
         JOIN users lu ON lu.id = l.user_id
        WHERE ca.manager_id=$1 AND ca.role='closing' AND NOT ca.to_pot
        GROUP BY ca.landlord_id, lu.first_name, lu.last_name, l.business_name
        ORDER BY all_time DESC`, [uid])
    const [ref] = await query<any>(`SELECT COUNT(*)::int AS n FROM landlords WHERE referred_by_user_id=$1`, [uid])
    res.json({ success: true, data: { thisMonth: +tot.this_month, allTime: +tot.all_time, referredCount: ref.n, byLandlord } })
  } catch (e) { next(e) }
})

// ── pos_customers — merchant-owned non-tenant roster ──────────────
landlordsRouter.get('/pos-customers', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { listPosCustomers } = await import('../services/flexCharge')
    const rows = await listPosCustomers(req.user!.profileId)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

landlordsRouter.post('/pos-customers', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { createPosCustomer } = await import('../services/flexCharge')
    const { firstName, lastName, email, phone, notes } = req.body
    if (!firstName || !lastName || !email) {
      throw new AppError(400, 'firstName, lastName, email required')
    }
    const row = await createPosCustomer({
      landlordId: req.user!.profileId,
      firstName, lastName, email, phone, notes,
    })
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

landlordsRouter.delete('/pos-customers/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { archivePosCustomer } = await import('../services/flexCharge')
    await archivePosCustomer({ landlordId: req.user!.profileId, customerId: req.params.id })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// S258: POST /api/landlords/pos-customers/:id/send-onboarding —
// generates a 14-day onboarding token + fires email to the customer's
// email on file. Customer follows the link to verify ACH via Stripe
// Financial Connections (public flow, no GAM auth required). Returns
// the new invitation id; merchant can poll customer status via the
// regular pos_customers listing.
landlordsRouter.post('/pos-customers/:id/send-onboarding', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const customer = await queryOne<{
      id: string; landlord_id: string;
      first_name: string; last_name: string; email: string;
      archived_at: string | null;
      ach_verified: boolean;
      // Landlord context for the email
      landlord_name: string;
    }>(
      `SELECT pc.id, pc.landlord_id, pc.first_name, pc.last_name, pc.email,
              pc.archived_at, pc.ach_verified,
              COALESCE(l.business_name, u.first_name || ' ' || u.last_name) AS landlord_name
         FROM pos_customers pc
         JOIN landlords l ON l.id = pc.landlord_id
         JOIN users u     ON u.id = l.user_id
        WHERE pc.id = $1`,
      [req.params.id],
    )
    if (!customer) throw new AppError(404, 'POS customer not found')
    if (customer.landlord_id !== req.user!.profileId) throw new AppError(403, 'Forbidden')
    if (customer.archived_at) throw new AppError(409, 'Customer is archived')
    if (customer.ach_verified) throw new AppError(409, 'Customer is already ACH-verified — onboarding not needed')

    const token = (await import('node:crypto')).randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000)
    const inv = await queryOne<{ id: string; token: string }>(
      `INSERT INTO pos_customer_invitations
         (token, pos_customer_id, landlord_id, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, token`,
      [token, customer.id, customer.landlord_id, expiresAt.toISOString()],
    )

    try {
      const { sendPosCustomerOnboarding } = await import('../services/email')
      await sendPosCustomerOnboarding({
        customerEmail: customer.email,
        customerName:  customer.first_name + ' ' + customer.last_name,
        merchantName:  customer.landlord_name,
        token:         inv!.token,
        ctx:           { landlordId: customer.landlord_id, posCustomerId: customer.id },
      })
    } catch (e) {
      logger.error({ err: e }, '[POS-CUSTOMER-ONBOARDING] email send failed:')
    }

    res.json({ success: true, data: { invitationId: inv!.id, expiresAt: expiresAt.toISOString() } })
  } catch (e) { next(e) }
})

// ── flex_charge_accounts — per (customer, property) tab ───────────
landlordsRouter.get('/flex-charge/accounts', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { listFlexChargeAccounts } = await import('../services/flexCharge')
    const propertyId = req.query.propertyId ? String(req.query.propertyId) : undefined
    const status     = req.query.status ? String(req.query.status) as any : undefined
    const rows = await listFlexChargeAccounts({
      landlordId: req.user!.profileId,
      propertyId, status,
    })
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

landlordsRouter.post('/flex-charge/accounts', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { createFlexChargeAccount } = await import('../services/flexCharge')
    const { tenantId, posCustomerId, propertyId, creditLimit, notes } = req.body
    if (!propertyId) throw new AppError(400, 'propertyId required')
    const row = await createFlexChargeAccount({
      landlordId:     req.user!.profileId,
      propertyId,
      tenantId:       tenantId ?? null,
      posCustomerId:  posCustomerId ?? null,
      creditLimit,
      notes,
    })
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

landlordsRouter.patch('/flex-charge/accounts/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { updateFlexChargeAccount } = await import('../services/flexCharge')
    const { creditLimit, status, notes } = req.body
    const row = await updateFlexChargeAccount({
      landlordId: req.user!.profileId,
      accountId:  req.params.id,
      creditLimit,
      status,
      notes,
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

landlordsRouter.get('/flex-charge/accounts/:id/statements', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { listAccountStatements } = await import('../services/flexCharge')
    const out = await listAccountStatements({
      landlordId: req.user!.profileId,
      accountId:  req.params.id,
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// S583: per-property FlexCharge merchant finance rate. The MERCHANT is the
// lender — they set the finance charge (flat % of each monthly statement
// balance) their customers pay, capped at FLEX_CHARGE_MAX_FINANCE_PCT. GAM's
// separate 1.5% is a merchant subscription, not the borrower's cost. One rate
// per property (Location), applied to every FlexCharge account there.
landlordsRouter.get('/flex-charge/finance-rates', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT id AS property_id, name, flex_charge_finance_pct::float AS finance_pct
         FROM properties
        WHERE landlord_id = $1 AND flexcharge_enabled = TRUE
        ORDER BY name`,
      [req.user!.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

landlordsRouter.patch('/flex-charge/finance-rate', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { propertyId, financePct } = z.object({
      propertyId: z.string().uuid(),
      // Flat % of the statement balance (e.g. 0.05 = 5%). Server-enforced cap;
      // the DB CHECK is the backstop. Merchant is responsible for a rate that
      // is compliant with their local usury / retail-installment law.
      financePct: z.number().min(0).max(FLEX_CHARGE_MAX_FINANCE_PCT),
    }).parse(req.body)
    const prop = await queryOne(
      `UPDATE properties
          SET flex_charge_finance_pct = $1, updated_at = NOW()
        WHERE id = $2 AND landlord_id = $3
        RETURNING id AS property_id, flex_charge_finance_pct::float AS finance_pct`,
      [financePct, propertyId, req.user!.profileId])
    if (!prop) throw new AppError(404, 'Property not found')
    res.json({ success: true, data: prop })
  } catch (e) { next(e) }
})

// ── GET /api/landlords/theme ───────────────────────────────────────────────
landlordsRouter.get('/theme', requireAuth, async (req, res, next) => {
  try {
    const row = await queryOne(
      'SELECT theme_accent, font_style FROM landlords WHERE id=$1',
      [req.user!.profileId]
    )
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ── PATCH /api/landlords/theme ─────────────────────────────────────────────
// S236: gated to requireLandlord. Pre-S236 was bare requireAuth scoped
// by req.user.profileId — a property_manager's profileId is their
// landlord's id, so a manager could rewrite their landlord's portal
// theme/font branding. Theme is owner-controlled.
landlordsRouter.patch('/theme', requireLandlord, async (req, res, next) => {
  try {
    const { themeAccent, fontStyle } = req.body
    await query(
      'UPDATE landlords SET theme_accent=$1, font_style=$2 WHERE id=$3',
      [themeAccent || null, fontStyle || null, req.user!.profileId]
    )
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── S553: entity owner-members (multi-owner landlord entities) ───────
// A landlord entity (person or LLC) can have multiple owner-members, each
// seeing it in their aggregated portfolio. Membership resolves into the
// JWT at login — changes take effect on the member's next sign-in.
landlordsRouter.get('/members', async (req, res, next) => {
  try {
    const u = req.user!
    const landlordId = (req.query.landlordId as string) || u.profileId
    if (!canManageLandlordResource(u, landlordId, [])) throw new AppError(403, 'Forbidden')
    const rows = await query(
      `SELECT lm.id, lm.user_id, lm.role, lm.created_at,
              us.email, us.first_name, us.last_name,
              (lm.user_id = l.user_id) AS is_founding
         FROM landlord_members lm
         JOIN users us ON us.id = lm.user_id
         JOIN landlords l ON l.id = lm.landlord_id
        WHERE lm.landlord_id = $1
        ORDER BY lm.created_at ASC`, [landlordId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// Add an owner-member by email. v1: the person must already have a GAM
// landlord account (register first, then be added) — invite-token flow is
// a later polish. Any current owner-member can add.
landlordsRouter.post('/members', async (req, res, next) => {
  try {
    const u = req.user!
    const b = z.object({
      email: z.string().trim().email(),
      landlordId: z.string().uuid().optional(),
    }).parse(req.body)
    const landlordId = b.landlordId || u.profileId
    if (!canManageLandlordResource(u, landlordId, [])) throw new AppError(403, 'Forbidden')

    const target = await queryOne<any>(
      `SELECT id, role, first_name FROM users WHERE lower(email) = lower($1)`, [b.email])

    // S605 (Nic): "it seems like kind of a backwards flow. I should be able to
    // invite him through a link." Demanding the invitee register FIRST — with no
    // prompt, no context, and nothing yet to look at — is where a partner
    // invitation dies. An unknown email now gets an invite instead of a 404.
    if (!target) {
      const invite = await createCoOwnerInvitation(landlordId, b.email, u.userId)
      return res.status(202).json({ success: true, data: { invited: true, invitationId: invite.id } })
    }
    if (target.role !== 'landlord') throw new AppError(400, 'That account is not a landlord account. Co-owners need their own landlord login.')

    const row = await queryOne<any>(
      `INSERT INTO landlord_members (landlord_id, user_id, role, added_by_user_id)
       VALUES ($1, $2, 'owner', $3)
       ON CONFLICT (landlord_id, user_id) DO NOTHING RETURNING id`,
      [landlordId, target.id, u.userId])
    if (!row) throw new AppError(409, 'They are already an owner of this entity.')

    // S592: a co-owner added with no upline of their own becomes the downline of
    // this account's founding owner (the "primary" who signed up). Dormant — no
    // money moves — until they later open their OWN account. First-touch wins: an
    // existing upline is left untouched, and a self-add is a no-op.
    const founding = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [landlordId])
    if (founding && founding.user_id !== target.id) {
      await query(
        `UPDATE users SET referred_by_user_id = $1
          WHERE id = $2 AND referred_by_user_id IS NULL`,
        [founding.user_id, target.id])
    }

    const entity = await queryOne<{ business_name: string | null }>(
      `SELECT business_name FROM landlords WHERE id = $1`, [landlordId])
    await createNotification({
      userId: target.id, landlordId,
      type: 'landlord_member_added',
      title: `You've been added as an owner${entity?.business_name ? ` of ${entity.business_name}` : ''}`,
      body: 'The entity now appears in your portfolio. Sign out and back in to see it.',
    }).catch(() => {})
    res.status(201).json({ success: true, data: { id: row.id } })
  } catch (e) { next(e) }
})

// Remove an owner-member. Dissolution-proofing (S553, Nic):
//  - the FOUNDING member (landlords.user_id) can never be removed — it
//    anchors the entity; ownership transfer is a future flow.
//  - ONLY the founding owner may remove OTHER owners — co-owners cannot
//    retaliate against each other.
//  - any non-founding owner may remove THEMSELVES (walk away).
//  - every removal notifies the removed owner and all remaining owners,
//    and lands in the audit journal (trigger).
// Known limit (documented): the removed owner's JWT keeps its memberships
// until expiry (≤7d); money-critical routes get live re-checks in the
// Connect re-anchor.
landlordsRouter.delete('/members/:id', async (req, res, next) => {
  try {
    const u = req.user!
    const m = await queryOne<any>(
      `SELECT lm.id, lm.landlord_id, lm.user_id, (lm.user_id = l.user_id) AS is_founding,
              l.user_id AS founding_user_id, l.business_name
         FROM landlord_members lm JOIN landlords l ON l.id = lm.landlord_id
        WHERE lm.id = $1`, [req.params.id])
    if (!m) throw new AppError(404, 'Member not found')
    if (!canManageLandlordResource(u, m.landlord_id, [])) throw new AppError(403, 'Forbidden')
    if (m.is_founding) throw new AppError(400, 'The founding owner cannot be removed from the entity.')
    const isSelf = m.user_id === u.userId
    const callerIsFounding = m.founding_user_id === u.userId || u.role === 'admin' || u.role === 'super_admin'
    if (!isSelf && !callerIsFounding) {
      throw new AppError(403, 'Only the founding owner can remove other owners. You can remove yourself.')
    }
    await query(`DELETE FROM landlord_members WHERE id = $1`, [m.id])

    // Notify the removed owner + every remaining owner (best-effort).
    try {
      const entityName = m.business_name || 'the shared entity'
      const remaining = await query<{ user_id: string }>(
        `SELECT user_id FROM landlord_members WHERE landlord_id = $1`, [m.landlord_id])
      const actor = await queryOne<{ first_name: string; last_name: string }>(
        `SELECT first_name, last_name FROM users WHERE id = $1`, [u.userId])
      const who = [actor?.first_name, actor?.last_name].filter(Boolean).join(' ') || 'An owner'
      await createNotification({
        userId: m.user_id, landlordId: m.landlord_id,
        type: 'landlord_member_removed',
        title: `Your ownership access to ${entityName} was removed`,
        body: isSelf ? 'You left the entity.' : `${who} removed your access. If this is unexpected, contact GAM support.`,
      }).catch(() => {})
      for (const r of remaining) {
        if (r.user_id === u.userId) continue
        await createNotification({
          userId: r.user_id, landlordId: m.landlord_id,
          type: 'landlord_member_removed',
          title: `Ownership change on ${entityName}`,
          body: isSelf ? `${who} left the entity.` : `${who} removed an owner from the entity.`,
        }).catch(() => {})
      }
    } catch { /* best-effort */ }
    res.json({ success: true })
  } catch (e) { next(e) }
})

landlordsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id === 'me' ? req.user!.profileId : req.params.id
    // S70: replaced inline check with canAccessLandlordResource. Pre-S70
    // excluded team-role users (PM/onsite/maintenance) from viewing the
    // landlord they're scoped to.
    if (!canAccessLandlordResource(req.user, id)) {
      throw new AppError(403, 'Forbidden')
    }
    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, u.phone
      FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [id])
    if (!landlord) throw new AppError(404, 'Landlord not found')
    res.json({ success: true, data: landlord })
  } catch (e) { next(e) }
})

landlordsRouter.get('/:id/dashboard', async (req, res, next) => {
  try {
    const id = req.params.id === 'me' ? req.user!.profileId : req.params.id
    // S605 (Nic): a landlord who co-owns another entity was seeing a dashboard
    // for ONE of them while their Properties list showed all of them — Oak Park
    // appeared in the list but its income was missing from the rollup, so the
    // two screens disagreed about the same portfolio.
    //
    // 'me' now aggregates every entity the caller is an owner-member of, exactly
    // as the properties list does. Nic: "he sees everything combined for his,
    // and I see everything combined for mine, without the two mixing." That
    // separation is automatic — the aggregate is over the caller's OWN
    // memberships, so a partner's unrelated property never enters this user's
    // numbers unless they co-own it.
    //
    // An EXPLICIT id (admin inspecting one landlord) still scopes to that entity.
    const scopeIds = req.params.id === 'me' && req.user!.role === 'landlord'
      ? Array.from(new Set([req.user!.profileId, ...(req.user!.landlordIds ?? [])]))
      : [id]
    // Dashboard surfaces revenue + disbursement totals — financial view.
    // Landlord/admin only; team roles don't get the financial rollup.
    if (!canViewLandlordFinances(req.user, id)) {
      throw new AppError(403, 'Forbidden')
    }
    const [stats] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE u.status='active')::int AS active_units,
        COUNT(*) FILTER (WHERE u.status='vacant')::int AS vacant_units,
        COUNT(*) FILTER (WHERE u.status='delinquent')::int AS delinquent_units,
        COUNT(*) FILTER (WHERE u.status='suspended')::int AS suspended_units,
        COUNT(*) FILTER (WHERE u.payment_block=TRUE)::int AS eviction_mode_units,
        -- S616 (Nic): a neighbour's serviced space is not inventory. Every
        -- status count above already excludes it by naming a status explicitly;
        -- this one counted everything, so the portfolio total was the one place
        -- it still inflated.
        COUNT(u.id) FILTER (WHERE u.status <> 'utility_service')::int AS total_units,
        -- Expected Monthly Rent = full rent roll across ALL occupied units
        -- (active + delinquent + suspended), NOT active-only.
        -- Delinquent/suspended units are occupied and still owe rent, and their
        -- payments appear in income — counting only 'active' made Expected read
        -- LOWER than the income reports. 'vacant'/'available' are empty → excluded.
        -- (direct_pay retired W-15/S531.)
        COALESCE(SUM(CASE WHEN u.status IN ('active','delinquent','suspended') THEN u.rent_amount ELSE 0 END),0) AS monthly_rent_volume,
        COUNT(DISTINCT p.id)::int AS property_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = ANY($1)`, [scopeIds])
    // S605 (Nic): the dashboard never said that payouts were unverified, so a
    // landlord could add units and tenants for days without learning that NO
    // RENT CAN MOVE until Stripe Connect verification is done. It was only
    // discoverable by wandering into Financials → Banking. "If I don't know how
    // to do what I need to do, that's where the friction lives."
    const [connect] = await query<{ payouts_enabled: boolean; details_submitted: boolean }>(
      `SELECT connect_payouts_enabled AS payouts_enabled,
              connect_details_submitted AS details_submitted
         FROM landlords WHERE id = $1`, [id])
    const [upcoming] = await query<any>(`
      SELECT COUNT(*)::int AS count,
        COALESCE(SUM(d.amount),0) AS amount
      FROM disbursements d
      WHERE d.landlord_id = ANY($1) AND d.status='pending'`, [scopeIds])
    // Real monthly revenue trend (last 6 months)
    const trend = await query<any>(`
      SELECT 
        TO_CHAR(DATE_TRUNC('month', p.created_at), 'Mon') as month,
        COALESCE(SUM(p.amount),0)::float as revenue
      FROM payments p
      WHERE p.landlord_id = ANY($1)
        AND p.status IN ('completed','settled')
        AND p.created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', p.created_at)
      ORDER BY DATE_TRUNC('month', p.created_at) ASC`, [scopeIds])

    // Real maintenance stats
    const [maintenance] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status='open')::int as open_requests,
        COUNT(*) FILTER (WHERE status='in_progress')::int as in_progress,
        COUNT(*) FILTER (WHERE status='completed' AND created_at > NOW()-INTERVAL '30 days')::int as completed_30d
      FROM maintenance_requests
      WHERE landlord_id = ANY($1)`, [scopeIds])

    // Recent background checks pending review
    const [bgPending] = await query<any>(`
      SELECT COUNT(*)::int as count
      FROM background_checks
      WHERE landlord_id = ANY($1) AND status = 'submitted'`, [scopeIds])

    // S536 (Nic): needs-review leases belong on the main dashboard, not
    // just the Leases page banner. Current leases only (active+pending) —
    // the Leases page's default view — so the two counts always agree.
    const [leaseReview] = await query<any>(`
      SELECT COUNT(*)::int AS count
      FROM leases
      WHERE landlord_id = ANY($1) AND needs_review = TRUE AND status IN ('active','pending')`, [scopeIds])

    const [otpStats] = await query<any>(`
      SELECT
        COUNT(*)::int AS otp_units,
        COALESCE(SUM(u.rent_amount),0)::float AS projected_otp_disbursement
      FROM tenants t
      JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
      JOIN leases l ON l.id = lt.lease_id AND l.status = 'active'
      JOIN units u ON u.id = l.unit_id
      WHERE u.landlord_id = ANY($1)
        AND t.on_time_pay_enrolled = TRUE
        AND u.status = 'active'`, [scopeIds])

    // Authoritative platform fee for the current month — per property, $2/billable
    // unit floored at the $10 property minimum (full stop), summed. This is the
    // SAME calc the billing cron + Reports use, so the Dashboard agrees with the
    // bill. Replaces the old portfolio max(occupied×2, propertyCount×10) estimate.
    const feeMonth = periodMonths(new Date().getFullYear(), new Date().getMonth() + 1)
    const feeMap = await platformFeesByProperty(id, feeMonth)
    const feeProps = await query<any>(
      `SELECT id, name FROM properties WHERE landlord_id = ANY($1) ORDER BY name`, [scopeIds])
    const platformFeeByProperty = feeProps.map((p: any) => ({
      propertyId: p.id, name: p.name, fee: Math.round((feeMap.get(p.id) ?? 0) * 100) / 100,
    }))
    const platformFee = Math.round(platformFeeByProperty.reduce((s, p) => s + p.fee, 0) * 100) / 100

    // Rent KPIs that reconcile with the Reports page (/reports/summary) — same
    // SQL definitions, so the Dashboard's Collected/Outstanding cards agree with
    // Reports. Distinct from monthly_rent_volume above, which is CONTRACTED rent
    // on active units (the "Expected" capacity number), not collected cash.
    //   collected_mtd — settled rent payments this calendar month
    //   outstanding   — unpaid (pending+partial) invoice balances
    const [collectedRow] = await query<any>(`
      SELECT COALESCE(SUM(amount), 0)::float AS collected_mtd
        FROM payments
       WHERE landlord_id = ANY($1) AND status='settled' AND type='rent'
         AND settled_at >= date_trunc('month', NOW())`, [scopeIds])
    const [outstandingRow] = await query<any>(`
      SELECT COALESCE(SUM(i.total_amount - COALESCE(p.paid, 0)), 0)::float AS outstanding
        FROM invoices i
        LEFT JOIN (
          SELECT invoice_id, SUM(amount) AS paid
            FROM payments WHERE status='settled' AND invoice_id IS NOT NULL
           GROUP BY invoice_id
        ) p ON p.invoice_id = i.id
       WHERE i.landlord_id = ANY($1) AND i.status IN ('pending', 'partial')`, [scopeIds])

    // Leases expiring soon — active leases whose end_date falls inside the next
    // 30 / 60 days. Drives the renewal-action KPI. Scoped by leases.landlord_id.
    const [expiring] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days')::int AS leases_expiring_30d,
        COUNT(*) FILTER (WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days')::int AS leases_expiring_60d
      FROM leases
      WHERE landlord_id = ANY($1) AND status = 'active' AND end_date IS NOT NULL`, [scopeIds])

    // S616 (Nic): occupancy counts SHORT STAYS too — "aggregate thirty nights
    // of bookings as well." Before this, a park running on nightly bookings
    // read as nearly empty while it was full: a booking is not a lease, so
    // every booked spot still carries status 'vacant'.
    //
    // One shared formula with the Reports page, so the Dashboard's Occupancy
    // card and /reports/summary cannot drift.
    const nightsRow = await queryOne<{ nights: number }>(`
      SELECT COALESCE(SUM(
               GREATEST(
                 LEAST(b.check_out, date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
                   - GREATEST(b.check_in, date_trunc('month', CURRENT_DATE))::date, 0)), 0)::int AS nights
        FROM unit_bookings b
        JOIN units u ON u.id = b.unit_id
       WHERE u.landlord_id = ANY($1)
         AND u.status <> 'utility_service'
         AND b.lease_type IN ('nightly','weekly')
         AND b.status NOT IN ('cancelled','no_show')
         AND b.check_in  < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
         AND b.check_out > date_trunc('month', CURRENT_DATE)`, [scopeIds])
    const totalUnits = stats?.total_units || 0
    const occupancyRate = occupancyRateFrom(
      stats?.active_units || 0, nightsRow?.nights || 0, totalUnits)

    res.json({ success: true, data: { ...stats, upcoming_disbursement: upcoming, trend, maintenance, bg_pending: bgPending?.count||0, leases_need_review: leaseReview?.count||0, otp_units: otpStats?.otp_units||0, projected_otp_disbursement: otpStats?.projected_otp_disbursement||0, platformFee, platformFeeByProperty, collected_mtd: collectedRow?.collected_mtd||0, outstanding: outstandingRow?.outstanding||0, leases_expiring_30d: expiring?.leases_expiring_30d||0, leases_expiring_60d: expiring?.leases_expiring_60d||0, occupancy_rate: occupancyRate,
      // S605: surfaced so the dashboard can say "no rent can move yet" instead
      // of leaving the landlord to discover it in Financials → Banking.
      connect_payouts_enabled: connect?.payouts_enabled ?? false,
      connect_details_submitted: connect?.details_submitted ?? false } })
  } catch (e) { next(e) }
})

// GET /api/landlords/:id/rent-roll — W-2 (S531). The Expected Monthly Rent
// KPI's click-through page. One row per OCCUPIED unit (active + delinquent +
// suspended — rent-obligation principle: rent owed is per lease, so
// non-paying and evicting units stay on the roll). The total is the SAME
// formula as monthly_rent_volume in /:id/dashboard (SUM of u.rent_amount
// over occupied statuses), so the KPI and this page can never disagree.
// Financial view — same gate as the dashboard rollup.
landlordsRouter.get('/:id/rent-roll', async (req, res, next) => {
  try {
    const id = req.params.id === 'me' ? req.user!.profileId : req.params.id
    if (!canViewLandlordFinances(req.user, id)) {
      throw new AppError(403, 'Forbidden')
    }
    const rows = await query<any>(`
      SELECT u.id AS unit_id, u.unit_number, u.status, u.rent_amount,
        p.id AS property_id, p.name AS property_name,
        l.id AS lease_id, l.start_date, l.end_date, l.lease_type,
        vuo.primary_first_name AS tenant_first,
        vuo.primary_last_name AS tenant_last,
        vuo.tenant_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      -- LATERAL + LIMIT 1: nothing enforces one active lease per unit at the
      -- schema layer, and a stray duplicate would double-count the roll.
      LEFT JOIN LATERAL (
        SELECT id, start_date, end_date, lease_type FROM leases
        WHERE unit_id = u.id AND status = 'active'
        ORDER BY start_date DESC LIMIT 1
      ) l ON TRUE
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE u.landlord_id = $1
        AND u.status IN ('active','delinquent','suspended')
      ORDER BY p.name, u.unit_number`, [id])
    const total = rows.reduce((s: number, r: any) => s + Number(r.rent_amount || 0), 0)
    res.json({ success: true, data: { rows, total: Math.round(total * 100) / 100 } })
  } catch (e) { next(e) }
})

// POST /api/landlords/complete-onboarding
// S131: stays requireLandlord — only the landlord themselves finishes
// their own onboarding (legal agreement signature). Not delegable.
landlordsRouter.post('/complete-onboarding', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { signature, agreedAt, coverTenantAch } = req.body
    if (!signature) return res.status(400).json({ success: false, error: 'Signature required' })

    // S513 fee-payer election (walkthrough #2). The landlord may elect to
    // cover its tenants' ACH fees; card is ALWAYS the tenant's. Default tenant.
    const achPayer: 'landlord' | 'tenant' = coverTenantAch === true ? 'landlord' : 'tenant'

    await query(`
      UPDATE landlords SET
        onboarding_complete = TRUE,
        agreement_signed_at = NOW(),
        agreement_signature = $1,
        default_ach_fee_payer = $3
      WHERE id = $2`,
      [signature, req.user!.profileId, achPayer]
    )

    // Apply the election across the landlord's existing properties so it takes
    // effect on the portfolio they just onboarded (the first property is created
    // before this step). card_fee_payer is force-healed to 'tenant' — the
    // landlord never covers card (S512 lock); this also repairs any legacy
    // 'landlord' card rows.
    await query(`
      UPDATE property_allocation_rules SET
        ach_fee_payer = $1,
        card_fee_payer = 'tenant'
      WHERE property_id IN (SELECT id FROM properties WHERE landlord_id = $2)`,
      [achPayer, req.user!.profileId]
    )

    // Also update user profile phone/business if provided
    const landlord = await queryOne<any>('SELECT * FROM landlords WHERE id=$1', [req.user!.profileId])

    res.json({ success: true, data: { onboardingComplete: true } })
  } catch (e) { next(e) }
})

// PATCH /api/landlords/me — update landlord settings
// S131: stays requireLandlord — owner business profile (business_name,
// EIN, approval threshold). Not a team-worker surface.
landlordsRouter.patch('/me', requireAuth, requirePerm('settings.maintenance_approval'), async (req, res, next) => {
  try {
    const { businessName, ein, maintApprovalThreshold, depositReturnApprovalThreshold, defaultEarlyTerminationMonthsRent } = req.body
    // Sentinel value 'CLEAR' on the months-rent field nulls it out
    // (no policy on file). Otherwise COALESCE preserves prior value
    // when the field is absent.
    const clearMonths = defaultEarlyTerminationMonthsRent === null
    await query(`
      UPDATE landlords SET
        business_name = COALESCE($1, business_name),
        ein = COALESCE($2, ein),
        maint_approval_threshold = COALESCE($3, maint_approval_threshold),
        deposit_return_approval_threshold = COALESCE($5, deposit_return_approval_threshold),
        default_early_termination_months_rent = ${clearMonths ? 'NULL' : 'COALESCE($6, default_early_termination_months_rent)'},
        updated_at = NOW()
      WHERE id = $4`,
      clearMonths
        ? [businessName||null, ein||null, maintApprovalThreshold||null, req.user!.profileId, depositReturnApprovalThreshold ?? null]
        : [businessName||null, ein||null, maintApprovalThreshold||null, req.user!.profileId, depositReturnApprovalThreshold ?? null, defaultEarlyTerminationMonthsRent||null]
    )
    const updated = await queryOne<any>('SELECT * FROM landlords WHERE id=$1', [req.user!.profileId])
    res.json({ success: true, data: updated })
  } catch(e) { next(e) }
})


// ── Deposit interest rate overrides (S190) ────────────────────────────────
//
// Variable-rate states (NY/NJ/CT/IL/PA/NH and others) require the
// landlord to enter their bank's current passbook rate (or the
// state-published annual rate). The S188 hardcoded catalog wins when
// present; this is the per-landlord fallback.
//
// Endpoints (owner-only):
//   GET    /me/deposit-interest-overrides           — list all
//   PUT    /me/deposit-interest-overrides           — upsert one
//   DELETE /me/deposit-interest-overrides/:state/:year — remove one

landlordsRouter.get('/me/deposit-interest-overrides', requireLandlord, async (req, res, next) => {
  try {
    const rows = await query<{
      state_code:      string
      effective_year:  number
      annual_rate_pct: string
      source_notes:    string | null
      updated_at:      string
    }>(
      `SELECT state_code, effective_year,
              annual_rate_pct::text AS annual_rate_pct,
              source_notes, updated_at::text AS updated_at
         FROM landlord_deposit_interest_rate_overrides
        WHERE landlord_id = $1
        ORDER BY effective_year DESC, state_code ASC`,
      [req.user!.profileId],
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

const overrideUpsertSchema = z.object({
  stateCode:     z.string().length(2).transform((s) => s.toUpperCase()),
  effectiveYear: z.number().int().min(2020).max(2100),
  annualRatePct: z.number().min(0).max(100),
  sourceNotes:   z.string().max(2000).nullable().optional(),
})

landlordsRouter.put('/me/deposit-interest-overrides', requireLandlord, async (req, res, next) => {
  try {
    const body = overrideUpsertSchema.parse(req.body)

    // Refuse if a statutory rate exists for (state, year) — landlord
    // can't override the hardcoded catalog. The accrual engine would
    // ignore the override anyway (statutory wins), but we 409 here so
    // the UI doesn't suggest the override is doing anything.
    const statutory = await queryOne<{ annual_rate_pct: string }>(
      `SELECT annual_rate_pct FROM state_deposit_interest_rates
        WHERE state_code = $1 AND effective_year = $2 LIMIT 1`,
      [body.stateCode, body.effectiveYear],
    )
    if (statutory) {
      throw new AppError(
        409,
        `${body.stateCode} has a hardcoded statutory rate of ${statutory.annual_rate_pct}% for ${body.effectiveYear}. Per-landlord overrides cannot replace the statutory catalog.`
      )
    }

    const upserted = await queryOne<any>(
      `INSERT INTO landlord_deposit_interest_rate_overrides
         (landlord_id, state_code, effective_year, annual_rate_pct, source_notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (landlord_id, state_code, effective_year)
       DO UPDATE SET annual_rate_pct = EXCLUDED.annual_rate_pct,
                     source_notes    = EXCLUDED.source_notes,
                     updated_at      = NOW()
       RETURNING state_code, effective_year,
                 annual_rate_pct::text AS annual_rate_pct,
                 source_notes`,
      [
        req.user!.profileId,
        body.stateCode,
        body.effectiveYear,
        body.annualRatePct,
        body.sourceNotes ?? null,
      ],
    )
    res.json({ success: true, data: upserted })
  } catch (e) { next(e) }
})

landlordsRouter.delete('/me/deposit-interest-overrides/:state/:year',
  requireLandlord,
  async (req, res, next) => {
    try {
      const stateCode = req.params.state.toUpperCase()
      const year = parseInt(req.params.year, 10)
      if (isNaN(year) || stateCode.length !== 2) {
        throw new AppError(400, 'Invalid state or year')
      }
      await query(
        `DELETE FROM landlord_deposit_interest_rate_overrides
          WHERE landlord_id = $1 AND state_code = $2 AND effective_year = $3`,
        [req.user!.profileId, stateCode, year],
      )
      res.json({ success: true })
    } catch (e) { next(e) }
  }
)

// ── GET /api/landlords/me/todos ───────────────────────────────────────────
// Returns actionable signals for the dashboard to-do card.
// Three categories: lease issues, ACH issues, high-$ maintenance.
//
// S131: stays requireLandlord — this is the OWNER's personalized
// dashboard. Team workers have their own dashboards under their
// portal.
//
// S183: refined the query filters to honor per-property delegation.
// Day-to-day items (lease, ACH, rent failures) only show for
// self-managed properties (pm_company_id IS NULL AND
// managed_by_user_id = calling user). Owner-financial items (bank
// account, maintenance awaiting_approval) always show — those are
// owner concerns regardless of who manages day-to-day. Pre-S183 the
// dashboard spammed owners with day-to-day items for properties
// they'd delegated to a PM.
landlordsRouter.get('/me/todos', requireLandlord, async (req, res, next) => {
  try {
    // S620 (Nic): "nobody's seeing a notification for setting up a bank account
    // and Stripe KYC, and it won't let him delete it."
    //
    // This scoped to req.user.profileId — the entity where the caller is the
    // OWNER — while the dashboard a few hundred lines up deliberately spans
    // every entity they own OR co-own. A co-owner therefore saw Oak Park's
    // numbers on the dashboard and Oak Park's to-do list nowhere, because the
    // to-dos were being computed against their OWN entity: the empty one that
    // registering created so they could accept the invite in the first place.
    //
    // The task could not be dismissed because it was not stale. It was a true
    // statement about an entity with no properties, no tenants and no money —
    // and therefore useless. Every co-owner would hit this, not just the first
    // one, since accepting an invite always requires registering first.
    //
    // Same scope as the dashboard now: own entity + co-owned entities.
    const scopeIds = Array.from(
      new Set([req.user!.profileId, ...(req.user!.landlordIds ?? [])].filter(Boolean)))
    const userId = req.user!.userId

    // S67: bank readiness derives from active user_bank_accounts. The
    // landlord's user_id is the catalog owner under the 16a per-property
    // routing model. Owner-financial concern — always shown to the
    // calling owner regardless of property delegation.
    // S605 (Nic): this asked "have you added a row to the legacy bank catalog?"
    // — but rent pays out through STRIPE CONNECT (autoPayouts.ts fires
    // stripe.payouts.create against the Connect account and never reads that
    // table). So a landlord who completed Stripe onboarding, bank account and
    // all, was still told to "Add a bank account", which read as though the
    // whole Stripe process hadn't saved. Ready now means what it actually
    // means: Stripe can pay you. The legacy catalog still counts, for the
    // multi-owner allocation-split case that does use it.
    // READY IF ANY ENTITY IN SCOPE CAN BE PAID. A co-owner of a fully set-up
    // entity must not be nagged about the empty one registration gave them —
    // there is no money in it to route anywhere. If they later add a property
    // of their own, the entity stops being empty and the gate correctly
    // returns, which is when it actually matters.
    const bankReady = await queryOne<{ ready: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM landlords l
         WHERE l.id = ANY($1)
           AND (
             l.connect_payouts_enabled
             OR EXISTS (
               SELECT 1 FROM user_bank_accounts ba
                WHERE ba.user_id = l.user_id AND ba.status = 'active'
             )
           )
      ) AS ready
    `, [scopeIds])

    // ── LEASE ISSUES ──────────────────────────────────────
    // needs_review OR expiring within that lease's own expiration_notice_days window
    //
    // S183: filter to properties where the calling user is the day-to-day
    // responsible party. Pre-S183 this showed every lease under the
    // landlord profile, including properties delegated to a PM company
    // or to an individual manager. Owners shouldn't see lease-expiring
    // todos for properties they've handed off — the manager / PM company
    // sees those on their own dashboard.
    //
    // Self-managed condition: pm_company_id IS NULL (no third-party PM)
    // AND managed_by_user_id = calling user's user_id (owner == manager).
    // When the owner has delegated, this filter excludes those properties.
    const leaseRows = await query<any>(`
      SELECT
        l.id,
        l.end_date,
        l.needs_review,
        l.expiration_notice_days,
        u.unit_number,
        p.name AS property_name,
        tu.first_name AS tenant_first,
        tu.last_name AS tenant_last,
        CASE
          WHEN l.needs_review = true THEN 'needs_review'
          WHEN l.end_date IS NOT NULL
            AND l.end_date <= CURRENT_DATE + (l.expiration_notice_days || ' days')::interval
            AND l.end_date >= CURRENT_DATE
          THEN 'expiring_soon'
          ELSE NULL
        END AS issue_type,
        EXTRACT(DAY FROM l.end_date::timestamp - NOW())::int AS days_remaining,
        EXISTS (
          SELECT 1 FROM lease_documents d
           WHERE d.renews_lease_id = l.id
             AND d.status NOT IN ('completed','voided')
        ) AS renewal_in_progress
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary' AND lt.status = 'active'
      LEFT JOIN tenants t ON t.id = lt.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      WHERE l.landlord_id = ANY($1)
        AND l.status = 'active'
        AND p.pm_company_id IS NULL
        AND p.managed_by_user_id = $2
        AND (
          l.needs_review = true
          OR (
            l.end_date IS NOT NULL
            AND l.end_date <= CURRENT_DATE + (l.expiration_notice_days || ' days')::interval
            AND l.end_date >= CURRENT_DATE
          )
        )
      ORDER BY
        CASE WHEN l.needs_review = true THEN 0 ELSE 1 END,
        l.end_date NULLS LAST
    `, [scopeIds, userId])

    const leases = leaseRows.map((l: any) => {
      const tenantName = [l.tenant_first, l.tenant_last].filter(Boolean).join(' ') || 'Unassigned'
      const unitLabel = 'Unit ' + l.unit_number + (l.property_name ? ' — ' + l.property_name : '')
      if (l.issue_type === 'needs_review') {
        return {
          id: l.id,
          type: 'needs_review',
          title: 'Lease needs review: ' + unitLabel,
          subtitle: 'Imported with default values. Confirm terms with ' + tenantName + '.',
          href: '/leases?open=' + l.id,
        }
      }
      return {
        id: l.id,
        type: 'expiring_soon',
        title: (l.renewal_in_progress ? 'Renewal in progress: ' : 'Lease expiring: ') + unitLabel,
        subtitle: (l.days_remaining != null ? l.days_remaining + ' days' : 'Soon')
          + ' remaining — ' + tenantName + '. '
          + (l.renewal_in_progress
              ? 'Renewal lease drafted — open it to finish signing.'
              : 'Decide: renew or not.'),
        // W-7 (S531): opens the renewal decision form, not the lease editor.
        // S534: the same form opens the in-flight draft directly when one exists.
        href: '/leases?renew=' + l.id,
      }
    })

    // ── ACH ISSUES ────────────────────────────────────────
    const ach: any[] = []

    // S605 (Nic, DIRECTIVE): the bank feed is NOT optional. "No landlord is
    // gonna be able to get their PNLs accurate if they can't reconcile the bank
    // transactions." It was treated as a nice-to-have buried in Financials; it
    // is a required part of getting set up, so it surfaces as a standing task
    // until a bank is linked.
    //
    // NOTE it is not yet a BLOCKING onboarding step, and deliberately so:
    // reading transactions needs a one-time Stripe Financial Connections
    // approval for the platform that is still pending, so a required step would
    // strand every new landlord on a button that 503s. This keeps it visible and
    // tracked meanwhile; make it blocking once the approval lands.
    const [feed] = await query<{ linked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM bank_connections
          WHERE landlord_id = ANY($1) AND status = 'active'
       ) AS linked`, [scopeIds])
    if (!feed?.linked) {
      ach.push({
        id: 'landlord-bank-feed',
        type: 'bank_feed',
        title: 'Connect your operating bank',
        subtitle: 'Needed for accurate P&L — GAM matches your rent payouts and turns the rest of your spending into expenses.',
        href: '/bank',
      })
    }

    // 1. Landlord has no active bank account in their catalog yet
    if (!bankReady?.ready) {
      ach.push({
        id: 'landlord-bank',
        type: 'landlord_bank',
        title: 'Add a bank account',
        subtitle: 'Required to receive disbursements. Add via the Banking page.',
        href: '/banking',
      })
    }

    // 2. Active units with unverified tenant ACH.
    // S183: same self-managed filter as lease issues — tenant onboarding
    // / ACH verification is a day-to-day manager concern, not an
    // owner-financial-control concern.
    const unverifiedTenants = await query<any>(`
      SELECT
        u.id AS unit_id,
        u.unit_number,
        p.name AS property_name,
        tu.first_name AS tenant_first,
        tu.last_name AS tenant_last
      FROM units u
      JOIN properties p ON p.id = u.property_id
      JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      JOIN tenants t ON t.id = vuo.primary_tenant_id
      JOIN users tu ON tu.id = t.user_id
      WHERE u.landlord_id = ANY($1)
        AND u.status = 'active'
        AND p.pm_company_id IS NULL
        AND p.managed_by_user_id = $2
        AND (t.ach_verified = false OR t.ach_verified IS NULL)
      ORDER BY u.unit_number
    `, [scopeIds, userId])

    for (const t of unverifiedTenants) {
      const tenantName = [t.tenant_first, t.tenant_last].filter(Boolean).join(' ') || 'Tenant'
      ach.push({
        id: 'tenant-ach-' + t.unit_id,
        type: 'tenant_ach',
        title: tenantName + ' — ACH not verified (Unit ' + t.unit_number + ')',
        subtitle: 'Tenant has not completed bank verification. Rent pulls will fail.',
        href: '/units/' + t.unit_id,
      })
    }

    // 3. Recent failed rent pulls (last 30 days).
    // S183: same self-managed filter — rent collection / NSF chases are
    // day-to-day manager work. JOIN through properties to apply the
    // delegation filter.
    const failed = await query<any>(`
      SELECT DISTINCT ON (p.unit_id)
        p.id AS payment_id,
        p.unit_id,
        p.status,
        p.return_reason,
        p.due_date,
        u.unit_number,
        tu.first_name AS tenant_first,
        tu.last_name AS tenant_last
      FROM payments p
      JOIN units u ON u.id = p.unit_id
      JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN tenants t ON t.id = p.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      WHERE p.landlord_id = ANY($1)
        AND pr.pm_company_id IS NULL
        AND pr.managed_by_user_id = $2
        AND p.type = 'rent'
        AND p.status IN ('failed', 'returned')
        AND p.due_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY p.unit_id, p.due_date DESC
    `, [scopeIds, userId])

    for (const f of failed) {
      const tenantName = [f.tenant_first, f.tenant_last].filter(Boolean).join(' ') || 'Tenant'
      const statusLabel = f.status === 'returned' ? 'Returned' : 'Failed'
      ach.push({
        id: 'payment-' + f.payment_id,
        type: 'recent_failure',
        title: statusLabel + ' rent pull — Unit ' + f.unit_number,
        subtitle: tenantName + (f.return_reason ? ' · ' + f.return_reason : '')
          + ' · Due ' + new Date(f.due_date).toLocaleDateString(),
        href: '/units/' + f.unit_id,
      })
    }

    // ── MAINTENANCE (awaiting approval) ───────────────────
    const maintRows = await query<any>(`
      SELECT
        mr.id,
        mr.title,
        mr.estimated_cost,
        u.unit_number,
        p.name AS property_name
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE mr.landlord_id = ANY($1)
        AND mr.status = 'awaiting_approval'
      ORDER BY mr.created_at DESC
    `, [scopeIds])

    const maintenance = maintRows.map((m: any) => ({
      id: m.id,
      type: 'awaiting_approval',
      title: m.title + ' — Unit ' + m.unit_number,
      subtitle: 'Awaiting approval'
        + (m.estimated_cost != null ? ' · Estimated $' + Number(m.estimated_cost).toLocaleString() : ''),
      href: '/maintenance?open=' + m.id,
    }))

    // S576 (B-8): work-trade agreements the 2am processor PAUSED because their
    // lease expired (rent-for-labor can't outlive the tenancy). We surface only
    // paused agreements whose tenant now has NO active lease on that unit — that
    // distinguishes a lease-ended pause (needs a renewal) from a landlord's
    // deliberate seasonal/manual pause (tenant still has an active lease → left
    // alone). The action is to renew the lease, even month-to-month, with a
    // work-trade addendum, which reactivates the arrangement.
    const wtRows = await query<any>(`
      SELECT wta.id, un.unit_number, p.name AS property_name,
             u.first_name, u.last_name
      FROM work_trade_agreements wta
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users u ON u.id = t.user_id
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      WHERE wta.landlord_id = ANY($1)
        AND wta.status = 'paused'
        AND NOT EXISTS (
          SELECT 1 FROM leases l
          JOIN lease_tenants lt ON lt.lease_id = l.id
          WHERE l.unit_id = wta.unit_id AND lt.tenant_id = wta.tenant_id
            AND l.status = 'active' AND lt.status = 'active')
      ORDER BY wta.updated_at DESC
    `, [scopeIds])

    const workTrade = wtRows.map((w: any) => ({
      id: w.id,
      type: 'work_trade_paused',
      title: 'Work trade paused — Unit ' + w.unit_number,
      subtitle: [w.first_name, w.last_name].filter(Boolean).join(' ')
        + '’s lease ended. Renew (even month-to-month) with a work-trade addendum to resume.',
      href: '/work-trade',
    }))

    // S576 (B-8): work-trade addendums the renewal auto-carry DRAFTED but the
    // landlord hasn't sent yet (Nic: auto-draft, eyeball, then it goes out).
    // Unsent = status 'pending'; only those linked to a work-trade agreement.
    const wtAddendumRows = await query<any>(`
      SELECT d.id, un.unit_number
      FROM lease_documents d
      JOIN work_trade_agreements wta ON wta.id = d.work_trade_agreement_id
      JOIN units un ON un.id = d.unit_id
      WHERE d.landlord_id = ANY($1) AND d.status = 'pending'
        AND d.work_trade_agreement_id IS NOT NULL
      ORDER BY d.created_at DESC
    `, [scopeIds])
    for (const a of wtAddendumRows as any[]) {
      workTrade.push({
        id: a.id,
        type: 'work_trade_addendum_draft',
        title: 'Work-trade addendum ready — Unit ' + a.unit_number,
        subtitle: 'Drafted on the renewed lease. Review and send it for signature.',
        href: '/work-trade',
      })
    }

    // ── ONBOARDING CONTROL TOWER (S582, Nic) ──────────────────
    // Surface every in-progress onboarding that's STUCK on the landlord, so a
    // multi-unit onboard (e.g. Oak Park's 32 units) never has tenants silently
    // falling through the cracks. Each row is one action with a destination.
    // Scoped by landlord_id (the pending pool is landlord-owned, like the
    // pending-tenants list). Covers the pipeline's landlord-blocked states:
    //   - parser upload needs review (parsed/mismatch/error)
    //   - tenant accepted but the lease never drafted (auto-draft blocked)
    //   - invite expired unaccepted (→ resend)
    //   - lease drafted, awaiting the LANDLORD's signature (landlord signs first)
    const onboarding: any[] = []

    const intentRows = await query<any>(`
      SELECT pti.id, pti.accepted_at, pti.draft_document_id, pti.parser_status,
             pti.unit_id, usr.tenant_invite_expires_at,
             un.unit_number, p.name AS property_name,
             usr.first_name, usr.last_name
        FROM pending_tenant_intents pti
        JOIN tenants t ON t.id = pti.tenant_id
        JOIN users usr ON usr.id = t.user_id
        LEFT JOIN units un ON un.id = pti.unit_id
        LEFT JOIN properties p ON p.id = un.property_id
       WHERE pti.landlord_id = ANY($1)
         AND pti.resolved_at IS NULL
         AND pti.cancelled_at IS NULL
       ORDER BY pti.created_at ASC
    `, [scopeIds])

    for (const it of intentRows as any[]) {
      const who = [it.first_name, it.last_name].filter(Boolean).join(' ') || 'Tenant'
      const where = it.unit_number ? ' — Unit ' + it.unit_number + (it.property_name ? ' (' + it.property_name + ')' : '') : ''
      // Uploaded-lease parser flow: needs the landlord's review before it builds.
      if (['parsed', 'mismatch', 'error'].includes(it.parser_status)) {
        onboarding.push({
          id: 'intent-parse-' + it.id,
          type: it.parser_status === 'error' ? 'parser_error' : 'parser_review',
          title: 'Review imported lease' + where,
          subtitle: it.parser_status === 'error'
            ? 'The uploaded lease couldn’t be read — review and enter the terms for ' + who + '.'
            : 'The uploaded lease is parsed and ready — review the terms and build ' + who + '’s lease.',
          href: '/tenant-onboarding/pending',
        })
        continue
      }
      // Invite flow (no PDF). Only surface states the LANDLORD must act on.
      if (it.unit_id && it.accepted_at && !it.draft_document_id) {
        onboarding.push({
          id: 'intent-draft-' + it.id,
          type: 'lease_not_drafted',
          title: who + ' accepted — lease not drafted yet' + where,
          subtitle: 'They’re ready. If it didn’t auto-draft (often a missing template field), draft the lease.',
          href: '/tenant-onboarding/pending',
        })
      } else if (it.unit_id && !it.accepted_at && it.tenant_invite_expires_at && new Date(it.tenant_invite_expires_at) < new Date()) {
        onboarding.push({
          id: 'intent-expired-' + it.id,
          type: 'invite_expired',
          title: 'Invite expired' + where,
          subtitle: who + ' never accepted before the invite lapsed. Resend it.',
          href: '/tenant-onboarding/pending',
        })
      }
    }

    // Leases drafted + sent but stalled on the LANDLORD's signature (landlord
    // signs first, so an unsigned landlord row means it's the landlord's turn).
    const awaitingSig = await query<any>(`
      SELECT d.id, un.unit_number, p.name AS property_name
        FROM lease_documents d
        JOIN lease_document_signers s ON s.document_id = d.id AND s.role = 'landlord'
        LEFT JOIN units un ON un.id = d.unit_id
        LEFT JOIN properties p ON p.id = un.property_id
       WHERE d.landlord_id = ANY($1)
         AND d.status IN ('sent', 'in_progress')
         AND s.status <> 'signed'
       ORDER BY d.created_at ASC
    `, [scopeIds])
    for (const d of awaitingSig as any[]) {
      const where = d.unit_number ? ' — Unit ' + d.unit_number + (d.property_name ? ' (' + d.property_name + ')' : '') : ''
      onboarding.push({
        id: 'doc-sign-' + d.id,
        type: 'awaiting_landlord_signature',
        title: 'Sign the lease' + where,
        subtitle: 'The lease is drafted and waiting on your signature before it goes to the tenant.',
        href: '/sign/' + d.id,
      })
    }

    // S593: listings-marketplace applicants (real accounts) with no lease drafted
    // yet — the long-term acquisition channel joining the SAME onboarding funnel
    // as invites + imports, so both public surfaces converge on one to-do list.
    const applicantRows = await query<any>(`
      SELECT a.id, a.first_name, a.last_name,
             un.unit_number, p.name AS property_name,
             t.background_check_status
        FROM unit_applications a
        JOIN units un ON un.id = a.unit_id
        JOIN properties p ON p.id = un.property_id
        LEFT JOIN tenants t ON t.user_id = a.applicant_user_id
       WHERE a.landlord_id = ANY($1)
         AND a.unit_id IS NOT NULL
         AND a.applicant_user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.source_application_id = a.id)
       ORDER BY a.created_at ASC
    `, [scopeIds])
    for (const a of applicantRows as any[]) {
      const who = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Applicant'
      const where = a.unit_number ? ' — Unit ' + a.unit_number + (a.property_name ? ' (' + a.property_name + ')' : '') : ''
      const screened = ['approved', 'waived'].includes(a.background_check_status)
      onboarding.push({
        id: 'application-' + a.id,
        type: 'new_applicant',
        title: 'New applicant — start onboarding' + where,
        subtitle: who + (screened
          ? ' passed screening and applied. Draft their lease to begin.'
          : ' applied. Screen them, then draft the lease.'),
        href: '/applications',
      })
    }

    res.json({
      success: true,
      data: {
        leases,
        ach,
        maintenance,
        workTrade,
        onboarding,
        counts: {
          leases: leases.length,
          ach: ach.length,
          maintenance: maintenance.length,
          workTrade: workTrade.length,
          onboarding: onboarding.length,
          total: leases.length + ach.length + maintenance.length + workTrade.length + onboarding.length,
        },
      },
    })
  } catch (e) { next(e) }
})


// ── ONBOARDING (S29c) — existing-tenant migration ───────────────────────
// Single-tenant manual onboarding. Creates tenant + imported lease + activation
// email in one transaction. No background check, no application gate.
landlordsRouter.post('/me/onboard-tenant', requirePerm('tenants.onboard'), async (req, res, next) => {
  const client = await getClient()
  try {
    const {
      firstName, lastName, email, phone,
      unitId,
      leaseStart, leaseEnd, monthlyRent,
      securityDeposit, lateFeeAmount, lateFeeGraceDays,
      autoRenew, autoRenewMode, noticeDaysRequired,
    } = req.body

    // --- Required fields ---
    if (!firstName || !lastName || !email || !phone) {
      throw new AppError(400, 'firstName, lastName, email, phone required')
    }
    if (!unitId) throw new AppError(400, 'unitId required')
    if (!leaseStart) throw new AppError(400, 'leaseStart required')
    if (monthlyRent === undefined || monthlyRent === null || monthlyRent === '') {
      throw new AppError(400, 'monthlyRent required')
    }
    const rentNum = parseFloat(monthlyRent)
    if (isNaN(rentNum) || rentNum < 0) throw new AppError(400, 'monthlyRent must be a non-negative number')

    const emailNorm = String(email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      throw new AppError(400, 'Invalid email format')
    }

    // --- Auto-renew CHECK constraint guard ---
    const ar = !!autoRenew
    const arMode = ar ? autoRenewMode : null
    if (ar && !(AUTO_RENEW_MODES as readonly string[]).includes(arMode)) {
      throw new AppError(400, 'autoRenewMode must be extend_same_term or convert_to_month_to_month when autoRenew=true')
    }

    // --- Verify unit belongs to this landlord ---
    const landlordId = req.user!.profileId
    const unit = await queryOne<any>(
      `SELECT u.id, u.unit_number, u.property_id, u.landlord_id,
              p.name AS property_name, p.street1, p.city, p.state, p.zip
       FROM units u JOIN properties p ON p.id = u.property_id
       WHERE u.id = $1`,
      [unitId]
    )
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.landlord_id !== landlordId) throw new AppError(403, 'Unit not owned by this landlord')

    // S537 gate: no onboarding onto an UNDECIDED late-fee class.
    await assertLateFeeDecisionForUnit(unit.id)

    // --- Occupancy-mode gate (S582) ---
    // Was a flat "already occupied" block, which wrongly stopped by-room paper
    // imports: a landlord onboarding a dorm / sober-living / rooming house often
    // has a SEPARATE existing paper lease per ROOM that all attach to the same
    // unit. assertUnitCanAcceptNewLease enforces the right cap per occupancy_mode
    // — whole_unit still blocks a 2nd lease (co-tenants share one; add them to the
    // existing lease instead), by_room allows independent leases up to 2×bedrooms.
    await assertUnitCanAcceptNewLease(client, unitId)

    // --- Cross-landlord conflict check ---
    const existingUser = await queryOne<any>(
      `SELECT u.id, t.id AS tenant_id
       FROM users u
       LEFT JOIN tenants t ON t.user_id = u.id
       WHERE u.email = $1`,
      [emailNorm]
    )
    if (existingUser?.tenant_id) {
      // Check if this tenant has an active lease with a DIFFERENT landlord.
      const otherLease = await queryOne<any>(
        `SELECT l.landlord_id FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
         WHERE lt.tenant_id = $1 AND lt.status='active' AND l.status='active' AND l.landlord_id != $2
         LIMIT 1`,
        [existingUser.tenant_id, landlordId]
      )
      if (otherLease) {
        throw new AppError(409, 'This email is already a tenant of another landlord. Cross-landlord onboarding requires a separate flow.')
      }
    }

    // --- Lease type inference ---
    const leaseType = leaseEnd ? 'fixed_term' : 'month_to_month'

    // --- Begin transaction ---
    await client.query('BEGIN')

    // 1. User row (create or reuse)
    let userId: string
    if (existingUser) {
      userId = existingUser.id
    } else {
      const tempHash = '$2b$10$placeholder_invite_pending'
      const u = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1, $2, 'tenant', $3, $4, $5)
         RETURNING id`,
        [emailNorm, tempHash, firstName, lastName, phone]
      )
      userId = u.rows[0].id
    }

    // 2. Invite token on user — ONLY for someone who needs one.
    //
    // S616 (Nic): "it needs to be intercepted in the server that that person
    // already is on the platform. And instead of giving them the tenant portal
    // invite, it just drafts up the lease." Same interception as
    // /me/onboard-new-lease-tenant; this is the second door onto the same
    // problem, and leaving it would still mail "set a password" to a neighbour
    // who has been signing in for months to pay their trash bill.
    //
    // S410 (S377): store on tenant_invite_token with 7-day expiry. Pre-S410
    // wrote to email_verify_token (overloaded column).
    const activatedRow2 = await client.query<{ activated: boolean }>(
      `SELECT password_hash <> '$2b$10$placeholder_invite_pending' AS activated
         FROM users WHERE id = $1`, [userId])
    const alreadyOnPlatform = activatedRow2.rows[0]?.activated === true

    let inviteToken: string | null = null
    if (!alreadyOnPlatform) {
      inviteToken = require('crypto').randomBytes(32).toString('hex')
      await client.query(
        `UPDATE users SET tenant_invite_token=$1,
                          tenant_invite_expires_at=NOW() + INTERVAL '7 days'
          WHERE id=$2`,
        [inviteToken, userId])
    }

    // 3. Tenant row (create or reuse, stamp onboarding_source)
    let tenantId: string
    const existingTenant = await client.query('SELECT id FROM tenants WHERE user_id=$1', [userId])
    if (existingTenant.rows.length) {
      tenantId = existingTenant.rows[0].id
      await client.query(
        `UPDATE tenants SET onboarding_source='onboarded' WHERE id=$1 AND onboarding_source != 'onboarded'`,
        [tenantId]
      )
    } else {
      const t = await client.query(
        `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded') RETURNING id`,
        [userId]
      )
      tenantId = t.rows[0].id
    }

    // 4. Lease row (imported, active, needs_review).
    // S196: security_deposit removed from leases columns; written to
    // lease_fees via syncSecurityDepositLeaseFee below.
    const lease = await client.query(
      `INSERT INTO leases (
         unit_id, landlord_id, status, start_date, end_date, rent_amount,
         late_fee_initial_amount, late_fee_grace_days,
         lease_type, auto_renew, auto_renew_mode,
         notice_days_required, needs_review, lease_source
       ) VALUES (
         $1, $2, 'active', $3, $4, $5,
         $6, $7,
         $8, $9, $10,
         $11, TRUE, 'imported'
       ) RETURNING id`,
      [
        unitId, landlordId, leaseStart, leaseEnd || null, rentNum,
        // S537: NEVER invent a late fee — absent input means the signed
        // paper had none; class policy applies at renewal (lease-is-law).
        lateFeeAmount ?? null,
        lateFeeAmount != null ? (lateFeeGraceDays ?? 5) : null,
        leaseType, ar, arMode,
        noticeDaysRequired ?? 30,
      ]
    )
    const leaseId = lease.rows[0].id

    // 5. Lease-tenant link (primary, active, original)
    await client.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'primary', 'active', NOW(), 'original', 'joint_several')`,
      [leaseId, tenantId]
    )

    // S195 dual-write: mirror security_deposit into lease_fees.
    {
      const { syncSecurityDepositLeaseFee } = await import('../services/leaseFeesSync')
      await syncSecurityDepositLeaseFee(leaseId, Number(securityDeposit ?? 0), client)
    }

    await client.query('COMMIT')

    // --- Send activation email (post-commit; failure here doesn't roll back tenant) ---
    const tenantAppUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'
    const activationUrl = inviteToken ? `${tenantAppUrl}/accept-invite?token=${inviteToken}` : null

    const landlord = await queryOne<any>(
      `SELECT u.first_name, u.last_name FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
      [landlordId]
    )
    const landlordName = landlord ? `${landlord.first_name} ${landlord.last_name}`.trim() : 'Your landlord'
    const propertyAddress = [unit.street1, unit.city, unit.state, unit.zip].filter(Boolean).join(', ')
    const unitLabel = `${unit.property_name} — Unit ${unit.unit_number}`

    try {
      if (alreadyOnPlatform) {
        // S616: they already sign in here. Point them at the lease, in the
        // account they have — never at "set a password".
        const { createNotification } = await import('../services/notifications')
        await createNotification({
          userId,
          landlordId,
          type: 'lease_drafted',
          title: `${landlordName} added a lease for ${unitLabel}`,
          body: `A lease for ${propertyAddress} is ready for you to review. Sign in as usual — you already have an account.`,
          data: { unitId, tenantId, leaseId },
          actionUrl: '/lease',
        })
      } else {
        await emailTenantOnboarded(
          emailNorm, firstName, landlordName, propertyAddress, unitLabel, activationUrl!,
          { landlordId, tenantId }
        )
      }
    } catch (emailErr) {
      // Failure also lands in email_send_log via send()'s internal logging;
      // landlord can surface it via GET /api/landlords/me/email-failures.
      logger.error({ err: emailErr, ctx: emailNorm }, '[ONBOARD] notify failed for')
      if (activationUrl) logger.info(`[ONBOARD] Manual activation URL: ${activationUrl}`)
    }

    res.json({
      success: true,
      data: {
        userId,
        tenantId,
        leaseId,
        email: emailNorm,
        activationUrl,
        // S616: so the screen never says "invite sent" when what happened was
        // a lease drafted for someone who already has a login.
        alreadyOnPlatform,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})


// GET /api/landlords/me/onboarding-windows — S579. Every property's onboarding-
// window state, for the banner that lets the landlord see how long sitting
// tenants can still be grandfathered and mark a property's onboarding complete.
landlordsRouter.get('/me/onboarding-windows', requireLandlord, async (req, res, next) => {
  try {
    res.json({ success: true, data: await listOnboardingWindowsForLandlord(req.user!.profileId) })
  } catch (e) { next(e) }
})

// POST /api/landlords/me/onboard-new-lease-tenant (S558, Flow B — new lease)
// Invite a person to a UNIT for a lease they will SIGN (vs onboard-tenant, which
// migrates an already-signed paper lease). Unit-linked invite: the unit rides on
// pending_tenant_intents.unit_id, so on accept the lease auto-drafts pre-filled
// from the unit + its default template. NO lease row is created here — the
// SIGNED e-sign document becomes the lease (lease-is-law). Co-tenants: call
// again for the same unit before anyone signs (whole_unit) or per person up to
// the 2×bedrooms cap (by_room). Adding a co-tenant voids any unsigned draft so
// the roster re-drafts complete.
landlordsRouter.post('/me/onboard-new-lease-tenant', requirePerm('tenants.onboard'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { firstName, lastName, email, phone, unitId } = req.body
    if (!firstName || !lastName || !email || !phone) throw new AppError(400, 'firstName, lastName, email, phone required')
    if (!unitId) throw new AppError(400, 'unitId required')
    const emailNorm = String(email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) throw new AppError(400, 'Invalid email format')

    const landlordId = req.user!.profileId
    const unit = await queryOne<any>(
      `SELECT u.id, u.unit_number, u.property_id, u.landlord_id, u.rent_amount, u.occupancy_mode,
              p.name AS property_name, p.street1, p.city, p.state, p.zip
         FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.landlord_id !== landlordId) throw new AppError(403, 'Unit not owned by this landlord')
    // Gate: unit metrics (rent) must be set before inviting anyone to the unit.
    if (unit.rent_amount == null || Number(unit.rent_amount) <= 0) {
      throw new AppError(400, 'Set the unit’s rent before inviting a tenant to it.')
    }
    // S537: late-fee decision required for the unit's class before onboarding.
    await assertLateFeeDecisionForUnit(unit.id)

    // Cross-landlord conflict — refuse if this email is an active tenant elsewhere.
    const existingUser = await queryOne<any>(
      `SELECT u.id, t.id AS tenant_id FROM users u LEFT JOIN tenants t ON t.user_id = u.id WHERE u.email = $1`,
      [emailNorm])
    if (existingUser?.tenant_id) {
      const otherLease = await queryOne<any>(
        `SELECT l.landlord_id FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
          WHERE lt.tenant_id = $1 AND lt.status='active' AND l.status='active' AND l.landlord_id != $2 LIMIT 1`,
        [existingUser.tenant_id, landlordId])
      if (otherLease) throw new AppError(409, 'This email is already a tenant of another landlord. Cross-landlord onboarding requires a separate flow.')
    }

    await client.query('BEGIN')

    // Occupancy-mode cap (whole_unit → 1 lease; by_room → 2×bedrooms leases).
    await assertUnitCanAcceptNewLease(client, unitId)

    // whole_unit repair: a new co-tenant invalidates any UNSIGNED draft for the
    // unit (it's missing this person). Void it so the roster re-drafts complete
    // on accept; block if a TENANT already signed (legally must supersede).
    if (unit.occupancy_mode !== 'by_room') {
      const draft = await client.query(
        `SELECT draft_document_id FROM pending_tenant_intents
          WHERE unit_id=$1 AND resolved_at IS NULL AND cancelled_at IS NULL AND draft_document_id IS NOT NULL LIMIT 1`,
        [unitId]).then((r: any) => r.rows[0])
      if (draft?.draft_document_id) {
        const tenantSigned = await client.query(
          `SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND signed_at IS NOT NULL AND role NOT IN ('landlord','witness') LIMIT 1`,
          [draft.draft_document_id]).then((r: any) => r.rows[0])
        if (tenantSigned) throw new AppError(409, 'A tenant has already signed the lease for this unit — void or supersede it before adding another person.')
        await client.query(`UPDATE lease_documents SET status='voided', updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','voided')`, [draft.draft_document_id])
        await client.query(`UPDATE pending_tenant_intents SET draft_document_id=NULL, updated_at=NOW() WHERE unit_id=$1 AND draft_document_id=$2`, [unitId, draft.draft_document_id])
      }
    }

    // User (create or reuse).
    let userId: string
    if (existingUser) {
      userId = existingUser.id
    } else {
      const u = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', $2, $3, $4) RETURNING id`,
        [emailNorm, firstName, lastName, phone])
      userId = u.rows[0].id
    }

    // S616 (Nic): ALREADY ON THE PLATFORM — skip the invite entirely.
    //
    //   "When a landlord is onboarding a property and goes to send an invite and
    //    lease to that person, it needs to be intercepted in the server that
    //    that person already is on the platform. And instead of giving them the
    //    tenant portal invite, it just drafts up the lease."
    //
    // The neighbour who has been paying for trash and electric for months
    // already has a GAM login. This route reused their user row and then
    // unconditionally issued a fresh invite token and mailed them "activate
    // your account and set a password" — for an account they already use. If
    // they followed it they would overwrite their working password, and the
    // landlord would be told an invite was sent when what was needed was a
    // lease.
    //
    // "Already on the platform" means they have finished setting up: a real
    // password rather than the placeholder this route writes for a brand-new
    // row. An invite that was sent but never accepted still needs re-sending.
    const activatedRow = await client.query<{ activated: boolean }>(
      `SELECT password_hash <> '$2b$10$placeholder_invite_pending' AS activated
         FROM users WHERE id = $1`, [userId])
    const alreadyOnPlatform = activatedRow.rows[0]?.activated === true

    // Only mint an invite for someone who actually needs one. Issuing a token
    // to an established account is what makes the "set a password" mail
    // possible in the first place.
    let inviteToken: string | null = null
    if (!alreadyOnPlatform) {
      inviteToken = require('crypto').randomBytes(32).toString('hex')
      await client.query(
        `UPDATE users SET tenant_invite_token=$1, tenant_invite_expires_at=NOW()+INTERVAL '7 days', updated_at=NOW() WHERE id=$2`,
        [inviteToken, userId])
    }

    // Tenant (create or reuse).
    let tenantId: string
    const existingTenant = await client.query('SELECT id FROM tenants WHERE user_id=$1', [userId])
    if (existingTenant.rows.length) {
      tenantId = existingTenant.rows[0].id
      await client.query(`UPDATE tenants SET onboarding_source='onboarded' WHERE id=$1 AND onboarding_source != 'onboarded'`, [tenantId])
    } else {
      const t = await client.query(`INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded') RETURNING id`, [userId])
      tenantId = t.rows[0].id
    }

    // Unit-bound intent (the roster slot). At most one LIVE intent per tenant
    // (partial unique on tenant_id WHERE cancelled_at IS NULL). Re-inviting a
    // tenant whose only prior intent was cancelled inserts a FRESH row — the
    // cancelled one is retained as history and falls outside the arbiter; a
    // tenant with an existing live intent updates it back to open on this unit.
    await client.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
       VALUES ($1, $2, 'not_uploaded', $3)
       ON CONFLICT (tenant_id) WHERE cancelled_at IS NULL DO UPDATE SET unit_id=EXCLUDED.unit_id, resolved_at=NULL,
             accepted_at=NULL, draft_document_id=NULL, updated_at=NOW()`,
      [landlordId, tenantId, unitId])

    await client.query('COMMIT')

    // Post-commit; a mail failure never rolls back the onboarding.
    const tenantAppUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'
    const activationUrl = inviteToken ? `${tenantAppUrl}/accept-invite?token=${inviteToken}` : null
    const landlord = await queryOne<any>(
      `SELECT u.first_name, u.last_name FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])
    const landlordName = landlord ? `${landlord.first_name} ${landlord.last_name}`.trim() : 'Your landlord'
    const propertyAddress = [unit.street1, unit.city, unit.state, unit.zip].filter(Boolean).join(', ')
    const unitLabel = `${unit.property_name} — Unit ${unit.unit_number}`
    try {
      if (alreadyOnPlatform) {
        // S616: they have a login. Tell them a lease is waiting, in the account
        // they already use — never "set a password".
        const { createNotification } = await import('../services/notifications')
        await createNotification({
          userId,
          landlordId,
          type: 'lease_drafted',
          title: `${landlordName} added a lease for ${unitLabel}`,
          body: `A lease for ${propertyAddress} is ready for you to review and sign. Sign in as usual — you already have an account.`,
          data: { unitId, tenantId },
          actionUrl: '/lease',
        })
      } else {
        await emailTenantOnboarded(emailNorm, firstName, landlordName, propertyAddress, unitLabel, activationUrl!, { landlordId, tenantId })
      }
    } catch (emailErr) {
      logger.error({ err: emailErr, ctx: emailNorm }, '[ONBOARD-NEW-LEASE] notify failed for')
      if (activationUrl) logger.info(`[ONBOARD-NEW-LEASE] Manual activation URL: ${activationUrl}`)
    }

    // S579: this flow onboards a SITTING tenant (the page is explicitly "tenants
    // who already live in your units"). If the landlord attests they're an
    // existing resident AND the property's onboarding window is open, grandfather
    // them past the background check (per-occupied-unit, audited); otherwise they
    // screen like any new applicant. Post-commit, best-effort — a waive hiccup
    // never rolls back the onboarding; the landlord can re-attest from the roster.
    let screeningWaived = false
    if (req.body?.existingResident === true) {
      try {
        const wr = await applyScreeningWaive({
          tenantId, landlordId, propertyId: unit.property_id, unitId, byUserId: req.user!.userId,
        })
        screeningWaived = wr.waived
      } catch (waiveErr) {
        logger.error({ err: waiveErr, ctx: tenantId }, '[ONBOARD-NEW-LEASE] grandfather waive failed')
      }
    }

    // S616: the landlord is told which of the two actually happened, so the
    // screen never claims an invite was sent when a lease was drafted instead.
    res.json({ success: true, data: {
      userId, tenantId, email: emailNorm, unitId, activationUrl, screeningWaived,
      alreadyOnPlatform,
    } })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})


// ── ONBOARDING CSV (S29c) ────────────────────────────────────────────────
// Two-endpoint pattern: /validate parses + reports issues without committing.
// /commit takes the (potentially landlord-corrected) row set and inserts.

type CsvIssue = { severity: 'block' | 'warn'; field?: string; message: string }
type CsvRow = {
  rowIndex: number
  firstName: string
  lastName: string
  email: string
  phone: string
  propertyName: string
  unitNumber: string
  leaseStart: string
  leaseEnd: string
  monthlyRent: string
  securityDeposit: string
  lateFeeAmount: string
  lateFeeGraceDays: string
  autoRenew: string
  autoRenewMode: string
  noticeDaysRequired: string
  outstandingBalance: string
  resolvedUnitId?: string
  resolvedExistingUserId?: string
  resolvedExistingTenantId?: string
  // S294: source-platform columns that aren't canonical-mapped and
  // aren't on the platform's noise list. Stored on the lease's
  // import_extra_data JSONB at commit time. Original-case keys
  // preserved for review-queue clarity.
  extra?: Record<string, any>
  issues: CsvIssue[]
}


// ── PENDING TENANT INTENTS (S29c-2-A: limbo-state onboarding) ──────────
// Landlord types name + email + phone, no lease info. Creates user (no
// activation token, no email send) + tenant + intent row. The tenant sits
// in the pending pool until the landlord uploads a lease PDF and the parser
// builds a real lease from it. Activation email fires only at lease creation.

// POST /api/landlords/me/onboard-tenant-pending
// Body: { firstName, lastName, email, phone, unitId? }
// W-27 (S531): unitId optionally binds the spot the incoming tenant already
// occupies — that unit is excluded from guest booking until the intent
// resolves (migration protection for permanent RV tenants).
landlordsRouter.post('/me/onboard-tenant-pending', requirePerm('tenants.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { firstName, lastName, email, phone, unitId } = req.body

    if (!firstName || !lastName || !email || !phone) {
      throw new AppError(400, 'firstName, lastName, email, phone required')
    }

    const emailNorm = String(email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      throw new AppError(400, 'Invalid email format')
    }

    const landlordId = req.user!.profileId

    // Cross-landlord conflict — same rule as /onboard-tenant. If this email is
    // already an active tenant of a DIFFERENT landlord, refuse.
    const existingUser = await queryOne<any>(
      `SELECT u.id, t.id AS tenant_id
       FROM users u
       LEFT JOIN tenants t ON t.user_id = u.id
       WHERE u.email = $1`,
      [emailNorm]
    )
    if (existingUser?.tenant_id) {
      const otherLease = await queryOne<any>(
        `SELECT l.landlord_id FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
         WHERE lt.tenant_id = $1 AND lt.status='active' AND l.status='active' AND l.landlord_id != $2
         LIMIT 1`,
        [existingUser.tenant_id, landlordId]
      )
      if (otherLease) {
        throw new AppError(409, 'This email is already a tenant of another landlord. Cross-landlord onboarding requires a separate flow.')
      }

      // Same-landlord active lease check — they're already onboarded with us.
      const sameLandlordLease = await queryOne<any>(
        `SELECT l.id FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
         WHERE lt.tenant_id = $1 AND lt.status='active' AND l.status='active' AND l.landlord_id = $2
         LIMIT 1`,
        [existingUser.tenant_id, landlordId]
      )
      if (sameLandlordLease) {
        throw new AppError(409, 'This person is already onboarded with you on an active lease.')
      }

      // Existing pending intent for this tenant — refuse a duplicate. Landlord
      // should resume the existing one or cancel it first. A cancelled invite
      // (cancelled_at set) is retained but not blocking — re-invite is allowed.
      const existingIntent = await queryOne<any>(
        `SELECT id FROM pending_tenant_intents WHERE tenant_id = $1 AND resolved_at IS NULL AND cancelled_at IS NULL LIMIT 1`,
        [existingUser.tenant_id]
      )
      if (existingIntent) {
        throw new AppError(409, 'This person is already in your pending pool. Open the pending list to continue or remove them.')
      }
    }

    // W-27: validate the bound unit belongs to this landlord and isn't
    // already held by another open intent.
    if (unitId) {
      const owned = await queryOne<any>(
        'SELECT id FROM units WHERE id=$1 AND landlord_id=$2', [unitId, landlordId])
      if (!owned) throw new AppError(400, 'unitId does not belong to this landlord')
      // S537 gate: pending intents bound to a unit require a late-fee
      // decision for that unit's class (unbound intents gate at resolve).
      await assertLateFeeDecisionForUnit(unitId)
      const held = await queryOne<any>(
        'SELECT id FROM pending_tenant_intents WHERE unit_id=$1 AND resolved_at IS NULL AND cancelled_at IS NULL', [unitId])
      if (held) throw new AppError(409, 'That unit is already held by another pending tenant')
    }

    await client.query('BEGIN')

    // 1. User row (create or reuse). NO email_verify_token — that's set when the
    // lease is created from the parsed PDF, not now.
    let userId: string
    if (existingUser) {
      userId = existingUser.id
    } else {
      const tempHash = '$2b$10$placeholder_invite_pending'
      const u = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1, $2, 'tenant', $3, $4, $5) RETURNING id`,
        [emailNorm, tempHash, firstName, lastName, phone]
      )
      userId = u.rows[0].id
    }

    // 2. Tenant row (create or reuse). Stamp onboarding_source='onboarded'.
    let tenantId: string
    const existingTenantRow = await client.query('SELECT id FROM tenants WHERE user_id=$1', [userId])
    if (existingTenantRow.rows.length) {
      tenantId = existingTenantRow.rows[0].id
      await client.query(
        `UPDATE tenants SET onboarding_source='onboarded' WHERE id=$1 AND onboarding_source != 'onboarded'`,
        [tenantId]
      )
    } else {
      const t = await client.query(
        `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded') RETURNING id`,
        [userId]
      )
      tenantId = t.rows[0].id
    }

    // 3. Intent row. UNIQUE(tenant_id) protects against races; on conflict we
    // already returned 409 above, so this insert should always succeed here.
    const intent = await client.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
       VALUES ($1, $2, 'not_uploaded', $3)
       RETURNING id, parser_status, created_at`,
      [landlordId, tenantId, unitId || null]
    )

    await client.query('COMMIT')

    // S579: grandfather a sitting tenant past the background check when the
    // landlord attests they're an existing resident of the bound unit AND the
    // property's onboarding window is open. Needs the unit (grandfather is
    // per-occupied-unit). Post-commit, best-effort.
    let screeningWaived = false
    if (req.body?.existingResident === true && unitId) {
      try {
        const propRow = await queryOne<{ property_id: string }>(`SELECT property_id FROM units WHERE id=$1`, [unitId])
        if (propRow) {
          const wr = await applyScreeningWaive({
            tenantId, landlordId, propertyId: propRow.property_id, unitId, byUserId: req.user!.userId,
          })
          screeningWaived = wr.waived
        }
      } catch (waiveErr) {
        logger.error({ err: waiveErr, ctx: tenantId }, '[ONBOARD-PENDING] grandfather waive failed')
      }
    }

    res.json({
      success: true,
      data: {
        intentId: intent.rows[0].id,
        tenantId,
        userId,
        email: emailNorm,
        firstName,
        lastName,
        phone,
        parserStatus: intent.rows[0].parser_status,
        createdAt: intent.rows[0].created_at,
        screeningWaived,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})


// POST /api/landlords/me/onboard-tenants-csv/commit-pending
// Limbo route for CSV onboarding. Frontend classifies rows post-validate:
// rows with only lease-only blockers (rent, dates, unit) but valid identity
// fields (name/email/phone) are sent here instead of /commit. Each row
// becomes a user + tenant + pending_tenant_intent — no lease, no email send.
//
// Per-row processing with per-row transaction (NOT all-or-nothing). If row 47
// fails, rows 1-46 are committed and visible in the pool. Result list mirrors
// input order so frontend can map errors back to specific rows.
//
// Re-validates identity server-side regardless of frontend classification —
// trust nothing from the client. Same conflict checks as /onboard-tenant-pending.
landlordsRouter.post('/me/onboard-tenants-csv/commit-pending', requirePerm('tenants.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { rows } = req.body
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(400, 'rows array required')
    }

    const landlordId = req.user!.profileId

    type RowResult = {
      rowIndex: number
      email: string
      status: 'created' | 'error'
      intentId?: string
      message?: string
    }
    const results: RowResult[] = []

    for (const row of rows) {
      const rowIndex = typeof row.rowIndex === 'number' ? row.rowIndex : -1
      const firstName = String(row.firstName || '').trim()
      const lastName  = String(row.lastName  || '').trim()
      const email     = String(row.email     || '').trim().toLowerCase()
      const phone     = String(row.phone     || '').trim()

      try {
        // Identity validation — backend re-checks. Frontend classification
        // is a hint, not a contract.
        if (!firstName || !lastName || !email || !phone) {
          throw new Error('firstName, lastName, email, phone required')
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new Error('Invalid email format')
        }

        // Conflict checks — read-side via pool, before opening row transaction.
        const existingUser = await queryOne<any>(
          `SELECT u.id, t.id AS tenant_id
             FROM users u
             LEFT JOIN tenants t ON t.user_id = u.id
            WHERE u.email = $1`,
          [email]
        )

        if (existingUser?.tenant_id) {
          // Cross-landlord active lease — refuse, same as /onboard-tenant-pending.
          const otherLease = await queryOne<any>(
            `SELECT l.landlord_id FROM lease_tenants lt
               JOIN leases l ON l.id = lt.lease_id
              WHERE lt.tenant_id = $1 AND lt.status='active'
                AND l.status='active' AND l.landlord_id != $2
              LIMIT 1`,
            [existingUser.tenant_id, landlordId]
          )
          if (otherLease) {
            throw new Error('Tenant has an active lease with another landlord. Cannot onboard to your portfolio.')
          }

          // Same-landlord active lease — already onboarded, refuse.
          const sameLandlordLease = await queryOne<any>(
            `SELECT l.id FROM lease_tenants lt
               JOIN leases l ON l.id = lt.lease_id
              WHERE lt.tenant_id = $1 AND lt.status='active'
                AND l.status='active' AND l.landlord_id = $2
              LIMIT 1`,
            [existingUser.tenant_id, landlordId]
          )
          if (sameLandlordLease) {
            throw new Error('This person is already onboarded with you on an active lease.')
          }

          // Pending intent already exists. This is also the catch for
          // duplicate emails WITHIN a single CSV — row N+1 sees the intent
          // that row N just inserted and rejects.
          // S582: match the partial unique index (tenant_id WHERE cancelled_at
          // IS NULL) so a RESOLVED-but-not-cancelled intent is caught with a
          // friendly message instead of surfacing the raw unique-constraint
          // violation the INSERT below would throw.
          const existingIntent = await queryOne<any>(
            `SELECT id, resolved_at FROM pending_tenant_intents WHERE tenant_id = $1 AND cancelled_at IS NULL LIMIT 1`,
            [existingUser.tenant_id]
          )
          if (existingIntent) {
            throw new Error(existingIntent.resolved_at
              ? 'This person has already been onboarded with you.'
              : 'This person is already in your pending pool.')
          }
        }

        // Per-row transaction. ROLLBACK on failure isolates this row from
        // siblings — row 47's failure does not undo rows 1-46.
        await client.query('BEGIN')

        // 1. User row (create or reuse). No email_verify_token — that fires
        //    at lease creation, not at limbo entry.
        let userId: string
        if (existingUser) {
          userId = existingUser.id
        } else {
          const tempHash = '$2b$10$placeholder_invite_pending'
          const u = await client.query(
            `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
             VALUES ($1, $2, 'tenant', $3, $4, $5) RETURNING id`,
            [email, tempHash, firstName, lastName, phone]
          )
          userId = u.rows[0].id
        }

        // 2. Tenant row (create or reuse). Stamp onboarding_source.
        let tenantId: string
        const existingTenantRow = await client.query('SELECT id FROM tenants WHERE user_id=$1', [userId])
        if (existingTenantRow.rows.length) {
          tenantId = existingTenantRow.rows[0].id
          await client.query(
            `UPDATE tenants SET onboarding_source='onboarded'
              WHERE id=$1 AND onboarding_source != 'onboarded'`,
            [tenantId]
          )
        } else {
          const t = await client.query(
            `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded') RETURNING id`,
            [userId]
          )
          tenantId = t.rows[0].id
        }

        // 3. Intent. UNIQUE(tenant_id) is the race-condition backstop.
        const intent = await client.query(
          `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status)
           VALUES ($1, $2, 'not_uploaded')
           RETURNING id`,
          [landlordId, tenantId]
        )

        await client.query('COMMIT')

        results.push({
          rowIndex,
          email,
          status: 'created',
          intentId: intent.rows[0].id,
        })
      } catch (rowErr: any) {
        await client.query('ROLLBACK').catch(() => {})
        results.push({
          rowIndex,
          email: email || '(no email)',
          status: 'error',
          message: rowErr?.message || 'Row failed',
        })
      }
    }

    const created = results.filter(r => r.status === 'created').length
    const skipped = results.filter(r => r.status === 'error').length

    res.json({
      success: true,
      data: { created, skipped, results },
    })
  } catch (e) {
    next(e)
  } finally {
    client.release()
  }
})


// GET /api/landlords/me/pending-tenants
// Returns this landlord's unresolved pending intents, joined to user info.
// The pending list page reads from this. Resolved intents are excluded —
// once a lease is built, the intent disappears from the active queue.
landlordsRouter.get('/me/pending-tenants', requirePerm('tenants.create'), async (req, res, next) => {
  try {
    const landlordId = req.user!.profileId

    const intents = await query<any>(
      `SELECT
         pti.id                  AS intent_id,
         pti.tenant_id,
         pti.parser_status,
         pti.imported_pdf_url,
         pti.parser_output,
         pti.parser_flags,
         pti.parser_error,
         pti.parser_started_at,
         pti.parser_finished_at,
         pti.created_at,
         pti.updated_at,
         u.id                    AS user_id,
         u.email,
         u.first_name,
         u.last_name,
         u.phone,
         un.id                   AS held_unit_id,
         un.unit_number          AS held_unit_number,
         pr.name                 AS held_property_name
       FROM pending_tenant_intents pti
       JOIN tenants t  ON t.id = pti.tenant_id
       JOIN users   u  ON u.id = t.user_id
       LEFT JOIN units un ON un.id = pti.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
       WHERE pti.landlord_id = $1
         AND pti.resolved_at IS NULL
         AND pti.cancelled_at IS NULL
       ORDER BY pti.created_at DESC`,
      [landlordId]
    )

    res.json({
      success: true,
      data: intents.map(r => ({
        intentId: r.intent_id,
        tenantId: r.tenant_id,
        userId: r.user_id,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        phone: r.phone,
        parserStatus: r.parser_status,
        importedPdfUrl: r.imported_pdf_url,
        parserOutput: r.parser_output,         // JSONB ParserOutput, may be null (S534: review-modal highlights)
        parserFlags: r.parser_flags,           // JSONB array, may be null
        parserError: r.parser_error,
        parserStartedAt: r.parser_started_at,
        parserFinishedAt: r.parser_finished_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    })
  } catch (e) { next(e) }
})


// DELETE /api/landlords/me/pending-tenants/:intentId
// SOFT-HIDE, not erase (data-retention rule — "keep everything; a delete only
// hides a record from the owner, it never leaves our server"). Canceling a
// pending invite stamps cancelled_at: the intent drops out of the landlord's
// pending list and the held unit is released for a new invite, but the intent
// row, the tenant + user rows (their contact info), and any uploaded lease PDF
// are ALL retained on the server. This is the invite-level counterpart to the
// lease-template soft-delete (is_active=FALSE) and status-change move-outs.
//
// NOTE: this used to hard-delete tenant + user + PDF for no-history invites.
// That was the ONE runtime path that erased a person from the platform; it is
// deliberately gone. Retention is the whole point.
landlordsRouter.delete('/me/pending-tenants/:intentId', requirePerm('tenant_onboarding.pending_manage'), async (req, res, next) => {
  try {
    const { intentId } = req.params
    const landlordId = req.user!.profileId

    // Only an open (not-yet-resolved, not-already-cancelled) invite owned by
    // this landlord can be canceled. Nothing is deleted — we just stamp it.
    const updated = await queryOne<any>(
      `UPDATE pending_tenant_intents
          SET cancelled_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND landlord_id = $2
          AND resolved_at IS NULL AND cancelled_at IS NULL
        RETURNING id`,
      [intentId, landlordId]
    )
    if (!updated) {
      throw new AppError(404, 'Pending tenant not found, already resolved/cancelled, or not owned by you')
    }

    res.json({
      success: true,
      data: {
        intentId,
        cancelled: true,
        // Retained on purpose — the person and their PDF stay on our server.
        tenantDeleted: false,
        userDeleted: false,
      },
    })
  } catch (e) {
    next(e)
  }
})


// ── PENDING TENANT PDF UPLOAD ──────────────────────────────────────────
// Storage matches the e-sign convention but in a sibling directory so unparsed
// candidate PDFs are clearly separate from first-class lease documents. When
// the parser resolves an intent into a real lease (S29c-2-C), the PDF is
// promoted to uploads/leases/ and leases.imported_pdf_url is set.

const pendingPdfDir = path.join(process.cwd(), 'uploads', 'lease-pdfs-pending')
if (!fs.existsSync(pendingPdfDir)) fs.mkdirSync(pendingPdfDir, { recursive: true })

const pendingPdfStorage = multer.diskStorage({
  destination: pendingPdfDir,
  filename: (_req: any, file: any, cb: any) => {
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2)
    cb(null, unique + path.extname(file.originalname))
  },
})

const pendingPdfUpload = multer({
  storage: pendingPdfStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype === 'application/pdf') cb(null, true)
    else cb(new Error('PDF only'))
  },
})

// POST /api/landlords/me/pending-tenants/:intentId/document
// multipart/form-data with field name 'file'. Stores PDF, updates intent,
// returns immediately. Parser runs async; landlord polls /me/pending-tenants
// to see status transition from 'parsing' to 'parsed'/'mismatch'/'error'.
landlordsRouter.post(
  '/me/pending-tenants/:intentId/document',
  requirePerm('tenant_onboarding.pending_manage'),
  pendingPdfUpload.single('file'),
  async (req: any, res: any, next: any) => {
    try {
      if (!req.file) throw new AppError(400, 'No file uploaded')

      const { intentId } = req.params
      const landlordId = req.user!.profileId

      // Verify ownership and that the intent is in a state that accepts uploads.
      // Allowed states: 'not_uploaded' (first upload), 'error' / 'mismatch' (re-upload
      // after a bad attempt). 'parsing' / 'parsed' / 'resolved' reject — landlord
      // must wait or use a different action.
      const intent = await queryOne<any>(
        `SELECT id, parser_status, imported_pdf_url
         FROM pending_tenant_intents
         WHERE id = $1 AND landlord_id = $2 AND resolved_at IS NULL AND cancelled_at IS NULL`,
        [intentId, landlordId]
      )
      if (!intent) {
        // Clean up the uploaded file before rejecting.
        try { fs.unlinkSync(req.file.path) } catch { /* best effort */ }
        throw new AppError(404, 'Pending tenant not found, already resolved, or not owned by you')
      }
      if (!['not_uploaded', 'error', 'mismatch'].includes(intent.parser_status)) {
        try { fs.unlinkSync(req.file.path) } catch { /* best effort */ }
        throw new AppError(409, `Cannot upload while parser_status='${intent.parser_status}'. Wait for the current parse to finish.`)
      }

      // If there was a previous PDF (re-upload case), delete the old file.
      // Best effort — orphaning is annoying but not a correctness problem.
      if (intent.imported_pdf_url) {
        const oldFilename = extractUploadFilename(intent.imported_pdf_url)
        if (oldFilename) {
          const oldPath = path.join(pendingPdfDir, oldFilename)
          try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath) } catch { /* best effort */ }
        }
      }

      // S395 fix: store the actual multer filename (e.g.
      // `1234567890-abc.pdf`) in imported_pdf_url so the GET route
      // can resolve the file on disk. Pre-fix, this column stored
      // the API endpoint URL (`/api/landlords/me/pending-tenants/
      // <id>/document`), which `extractUploadFilename` would
      // truncate to `'document'` — the GET would then look for a
      // literal `document` file on disk and 404 on every call.
      // The response still surfaces fileUrl as the endpoint URL
      // for frontend consumption.
      const fileUrl = '/api/landlords/me/pending-tenants/' + intentId + '/document'

      await query(
        `UPDATE pending_tenant_intents
         SET parser_status='parsing',
             imported_pdf_url=$1,
             parser_output=NULL,
             parser_flags=NULL,
             parser_error=NULL,
             parser_started_at=NOW(),
             parser_finished_at=NULL,
             updated_at=NOW()
         WHERE id=$2`,
        [req.file.filename, intentId]
      )

      scheduleParserJob(intentId)

      res.json({
        success: true,
        data: {
          intentId,
          parserStatus: 'parsing',
          fileUrl,
          filename: req.file.originalname,
          size: req.file.size,
        },
      })
    } catch (e) { next(e) }
  }
)

// GET /api/landlords/me/pending-tenants/:intentId/document
// Streams the stored PDF back to the owning landlord. Authorized to the
// landlord on the intent only — unlike e-sign's /files/:filename which serves
// any filename to anyone (separate concern, flagged for handoff).
landlordsRouter.get(
  '/me/pending-tenants/:intentId/document',
  requirePerm('tenants.create'),
  async (req, res, next) => {
    try {
      const { intentId } = req.params
      const landlordId = req.user!.profileId

      const intent = await queryOne<any>(
        `SELECT imported_pdf_url FROM pending_tenant_intents
         WHERE id = $1 AND landlord_id = $2`,
        [intentId, landlordId]
      )
      if (!intent || !intent.imported_pdf_url) {
        throw new AppError(404, 'Document not found for this pending tenant')
      }

      const filename = extractUploadFilename(intent.imported_pdf_url)
      if (!filename) throw new AppError(500, 'Stored document path is malformed')

      const filePath = path.join(pendingPdfDir, filename)
      if (!fs.existsSync(filePath)) throw new AppError(404, 'File missing on disk')

      res.setHeader('Content-Type', 'application/pdf')
      res.sendFile(filePath)
    } catch (e) { next(e) }
  }
)

// GET /api/landlords/me/pending-tenants/:intentId
// Returns one intent including full parser_output blob.
// GET one pending intent — list endpoint omits parser_output to keep
// the payload small. Confirm modal calls this when opened.
landlordsRouter.get(
  '/me/pending-tenants/:intentId',
  requirePerm('tenants.create'),
  async (req, res, next) => {
    try {
      const { intentId } = req.params
      const landlordId = req.user!.profileId

      const rows = await query<any>(
        `SELECT
           pti.id                  AS intent_id,
           pti.tenant_id,
           pti.parser_status,
           pti.parser_output,
           pti.parser_flags,
           pti.parser_error,
           pti.parser_started_at,
           pti.parser_finished_at,
           pti.imported_pdf_url,
           pti.created_at,
           pti.updated_at,
           u.id                    AS user_id,
           u.email,
           u.first_name,
           u.last_name,
           u.phone
         FROM pending_tenant_intents pti
         JOIN tenants t ON t.id = pti.tenant_id
         JOIN users   u ON u.id = t.user_id
         WHERE pti.id = $1
           AND pti.landlord_id = $2
           AND pti.resolved_at IS NULL
         LIMIT 1`,
        [intentId, landlordId]
      )

      if (rows.length === 0) {
        throw new AppError(404, 'Pending intent not found')
      }
      const r = rows[0]

      res.json({
        success: true,
        data: {
          intentId: r.intent_id,
          tenantId: r.tenant_id,
          userId: r.user_id,
          email: r.email,
          firstName: r.first_name,
          lastName: r.last_name,
          phone: r.phone,
          parserStatus: r.parser_status,
          parserOutput: r.parser_output,    // JSONB ParserOutput, may be null
          parserFlags: r.parser_flags,
          parserError: r.parser_error,
          parserStartedAt: r.parser_started_at,
          parserFinishedAt: r.parser_finished_at,
          importedPdfUrl: r.imported_pdf_url,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        },
      })
    } catch (e) { next(e) }
  }
)


// POST /api/landlords/me/pending-tenants/:intentId/resolve
// Body: { landlordOverrides?: Partial<ParserOutput> }
// landlordOverrides is layered on top of the stored parser_output. Per-field
// override semantics -- whatever the landlord touched in the confirm UI wins,
// the rest of the parser's extraction is preserved.
//
// The landlord-click guard. resolveIntent is never invoked from anywhere
// else; auto-resolve is gone.
landlordsRouter.post(
  '/me/pending-tenants/:intentId/resolve',
  requirePerm('tenant_onboarding.pending_manage'),
  async (req, res, next) => {
    try {
      const { intentId } = req.params
      const landlordId = req.user!.profileId
      const overrides = (req.body?.landlordOverrides ?? {}) as any
      if (typeof overrides !== 'object' || Array.isArray(overrides) || overrides === null) {
        throw new AppError(400, 'landlordOverrides must be an object')
      }
      // S582: confirmSupersede lets the landlord acknowledge that resolving into
      // an already-leased unit will END the sitting lease (parser migration case).
      const confirmSupersede = req.body?.confirmSupersede === true
      const result = await resolveIntent(intentId, landlordId, overrides, { confirmSupersede })
      res.json({ success: true, data: result })
    } catch (e) { next(e) }
  }
)


function parseBool(v: string | undefined | null): boolean | null {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim().toLowerCase()
  if (['yes', 'y', 'true', '1'].includes(s)) return true
  if (['no', 'n', 'false', '0'].includes(s)) return false
  return null
}

// ── PROPERTY + UNIT CSV IMPORT ─────────────────────────────────────────
// Lets a landlord drop a property/unit export from a prior PM software
// directly into PropertyOnboardingPage. One CSV row = one unit; the
// property is found-or-created on (name, street1) per row. Mirrors the
// shape of the tenant CSV import below.

type PropertyCsvRow = {
  rowIndex:        number
  propertyName:    string
  street1:         string
  street2:         string
  city:            string
  state:           string
  zip:             string
  timezone:        string
  propertyType:    string
  unitNumber:      string
  bedrooms:        string
  bathrooms:       string
  sqft:            string
  unitType:        string
  rentAmount:      string
  securityDeposit: string
  resolvedPropertyId?: string  // existing property if matched on (name, street1)
  resolvedUnitId?:     string  // existing unit if matched on (property, unit_number)
  // S294: source-platform columns that aren't canonical-mapped and
  // aren't on the platform's noise list. Stored on the unit's
  // import_extra_data JSONB at commit time. Property-level extras
  // (Year Built, etc.) duplicate across units on multi-unit
  // properties — accepted; this is review-queue data, not query-
  // path data.
  extra?: Record<string, any>
  issues: CsvIssue[]
}

// GET /api/landlords/me/onboard-properties-csv/template?source=generic
landlordsRouter.get('/me/onboard-properties-csv/template', requirePerm('properties.create'), async (req, res, next) => {
  try {
    const source = String(req.query.source || 'generic').toLowerCase()
    if (!isCsvImportPlatform(source)) {
      throw new AppError(400, `Unknown source: ${source}`)
    }
    const cfg = getPropertyPlatformConfig(source as CsvImportPlatform)
    if (!cfg?.enabled) {
      throw new AppError(400, `${source} is not yet supported. Pick Generic and map your columns manually for now.`)
    }

    const csv = buildPropertyTemplateCsv(source as CsvImportPlatform)
    const filename = source === 'generic'
      ? 'gam-property-template.csv'
      : `gam-property-template-${source}.csv`
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  } catch (e) { next(e) }
})

// POST /api/landlords/me/onboard-properties-csv/validate
// Body: { csv: string, source: CsvImportPlatform }
// Returns: { rows: PropertyCsvRow[], summary: { total, blockers, warnings, ready,
//   newProperties, newUnits } }
landlordsRouter.post('/me/onboard-properties-csv/validate', requirePerm('properties.bulk_import'), async (req, res, next) => {
  try {
    const { csv, source, claimedPlatformName } = req.body
    if (!csv) throw new AppError(400, 'csv body required')
    const sourceNorm = String(source || 'generic').toLowerCase()
    if (!isCsvImportPlatform(sourceNorm)) {
      throw new AppError(400, `Unknown source: ${sourceNorm}`)
    }
    // S297: claim free-text is only meaningful on generic uploads.
    const claimName = sourceNorm === 'generic' && typeof claimedPlatformName === 'string'
      ? claimedPlatformName.trim() : null
    const cfg = getPropertyPlatformConfig(sourceNorm as CsvImportPlatform)
    if (!cfg?.enabled) {
      throw new AppError(400, `${sourceNorm} is not yet supported.`)
    }

    let records: any[]
    try {
      records = parseCsv(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as any[]
    } catch (e: any) {
      throw new AppError(400, `CSV parse failed: ${e.message}`)
    }
    if (records.length === 0) throw new AppError(400, 'CSV has no data rows')

    // S295: capture raw shape BEFORE applyPropertyMapping rewrites
    // column names — the review queue needs the landlord's exact
    // uploaded column headers + first-5 rows.
    const propAttemptShape = extractAttemptShape(records)

    records = applyPropertyMapping(records, sourceNorm as CsvImportPlatform)

    const landlordId = req.user!.profileId

    // Pre-load existing properties + units for this landlord so we can
    // find-or-create idempotently. Property match is on lower(name) +
    // lower(street1); same property name at different addresses counts
    // as distinct properties.
    const existingProps = await query<any>(
      `SELECT id, name, street1 FROM properties WHERE landlord_id = $1`,
      [landlordId]
    )
    const propByKey = new Map(
      existingProps.map(p => [
        `${p.name.trim().toLowerCase()}|${(p.street1 || '').trim().toLowerCase()}`,
        p.id,
      ])
    )

    const existingUnits = await query<any>(
      `SELECT u.id, u.unit_number, u.property_id
         FROM units u
        WHERE u.landlord_id = $1`,
      [landlordId]
    )
    const unitByKey = new Map(
      existingUnits.map(u => [
        `${u.property_id}|${String(u.unit_number).trim().toLowerCase()}`,
        u.id,
      ])
    )

    const rows: PropertyCsvRow[] = []
    // Track new (name, street1) keys + (propertyKey, unit) keys we've
    // already seen WITHIN THIS BATCH so we can flag in-batch duplicates
    // and count properly.
    const seenPropertyKeys = new Set<string>()
    const seenUnitKeys = new Set<string>()

    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      const issues: CsvIssue[] = []

      const row: PropertyCsvRow = {
        rowIndex: i,
        propertyName:    String(r.property_name    || '').trim(),
        street1:         String(r.street1          || '').trim(),
        street2:         String(r.street2          || '').trim(),
        city:            String(r.city             || '').trim(),
        state:           String(r.state            || '').trim().toUpperCase(),
        zip:             String(r.zip              || '').trim(),
        timezone:        String(r.timezone         || '').trim(),
        propertyType:    String(r.property_type    || '').trim().toLowerCase(),
        unitNumber:      String(r.unit_number      || '').trim(),
        bedrooms:        String(r.bedrooms         || '').trim(),
        bathrooms:       String(r.bathrooms        || '').trim(),
        sqft:            String(r.sqft             || '').trim(),
        unitType:        String(r.unit_type        || '').trim().toLowerCase(),
        rentAmount:      String(r.rent_amount      || '').trim(),
        securityDeposit: String(r.security_deposit || '').trim(),
        extra: r._extra,
        issues,
      }

      // Required fields
      if (!row.propertyName) issues.push({ severity: 'block', field: 'property_name', message: 'Required' })
      if (!row.unitNumber)   issues.push({ severity: 'block', field: 'unit_number',   message: 'Required' })
      // S605 (Nic, DIRECTIVE): units created in GAM must carry a prefix — a bare
      // "37" is the accident that rule exists to stop, and it collides when two
      // unit types share a number.
      //
      // WARN here rather than BLOCK, deliberately. This is the MIGRATION path:
      // the rent roll being imported already exists in the real world, and a
      // landlord whose apartments have genuinely been called "101" for twenty
      // years should not be refused entry to the platform over naming. They are
      // told, and can rename on the way in or afterwards.
      else if (unitNumberNeedsPrefix(row.unitNumber)) {
        issues.push({ severity: 'warn', field: 'unit_number',
          message: `"${row.unitNumber}" has no prefix. New units in GAM require one (e.g. "Apt ${row.unitNumber}") — ` +
                   `imported numbers are kept as-is, but a bare number can collide if another unit type reuses it.` })
      }

      if (!row.rentAmount) {
        issues.push({ severity: 'block', field: 'rent_amount', message: 'Required' })
      } else {
        const rent = parseFloat(row.rentAmount)
        if (isNaN(rent) || rent < 0) issues.push({ severity: 'block', field: 'rent_amount', message: 'Must be a non-negative number' })
      }

      if (row.securityDeposit) {
        const dep = parseFloat(row.securityDeposit)
        if (isNaN(dep) || dep < 0) issues.push({ severity: 'block', field: 'security_deposit', message: 'Must be a non-negative number' })
      }
      if (row.bedrooms) {
        const b = parseInt(row.bedrooms, 10)
        if (isNaN(b) || b < 0) issues.push({ severity: 'block', field: 'bedrooms', message: 'Must be a non-negative integer' })
      }
      if (row.bathrooms) {
        const b = parseFloat(row.bathrooms)
        if (isNaN(b) || b < 0) issues.push({ severity: 'block', field: 'bathrooms', message: 'Must be a non-negative number' })
      }
      if (row.sqft) {
        const s = parseInt(row.sqft, 10)
        if (isNaN(s) || s < 0) issues.push({ severity: 'block', field: 'sqft', message: 'Must be a non-negative integer' })
      }

      // Property-create requirements: when this is a NEW property (no
      // existing match) all address fields are required.
      const propKey = `${row.propertyName.toLowerCase()}|${row.street1.toLowerCase()}`
      const existingPropId = row.propertyName && row.street1
        ? propByKey.get(propKey)
        : undefined

      if (existingPropId) {
        row.resolvedPropertyId = existingPropId
      } else {
        if (!row.street1) issues.push({ severity: 'block', field: 'street1', message: 'Required when creating a new property' })
        if (!row.city)    issues.push({ severity: 'block', field: 'city',    message: 'Required when creating a new property' })
        if (!row.state)   issues.push({ severity: 'block', field: 'state',   message: 'Required when creating a new property' })
        else if (row.state.length !== 2) issues.push({ severity: 'warn', field: 'state', message: 'Should be 2-letter abbreviation (e.g. AZ)' })
        if (!row.zip)     issues.push({ severity: 'block', field: 'zip',     message: 'Required when creating a new property' })
      }

      // Property-type CHECK is informational only on properties (no DB
      // CHECK constraint on type column today — accepts any text). We
      // validate against the known options for UX hygiene.
      const PROP_TYPES = ['residential', 'rv_longterm', 'rv_weekly', 'rv_nightly', 'mixed']
      if (row.propertyType && !PROP_TYPES.includes(row.propertyType)) {
        issues.push({ severity: 'warn', field: 'property_type', message: `Unknown type "${row.propertyType}" — will default to "mixed"` })
      }

      const UNIT_TYPES = ['apartment', 'single_family', 'rv_spot', 'mobile_home', 'storage', 'commercial']
      // S537 (Nic): NO silent apartment default. Source platforms don't
      // know GAM's unit classes (an RV site exports as generic
      // "residential") — the landlord maps every unit to a real class in
      // the review step before commit.
      if (!row.unitType) {
        issues.push({ severity: 'block', field: 'unit_type', message: `Required — the export didn't say. Pick one of: ${UNIT_TYPES.join(', ')}` })
      } else if (!UNIT_TYPES.includes(row.unitType)) {
        issues.push({ severity: 'block', field: 'unit_type', message: `Unrecognized type "${row.unitType}" — pick one of: ${UNIT_TYPES.join(', ')}` })
      }

      // In-batch duplicate property — same name+street appearing in
      // multiple rows is fine (it's how multi-unit properties are
      // represented), just don't double-count.
      if (row.propertyName && row.street1) {
        if (existingPropId) {
          // already exists in DB — not a new-property batch entry
        } else if (!seenPropertyKeys.has(propKey)) {
          seenPropertyKeys.add(propKey)
        }
      }

      // Unit collision check — within a given property (existing or
      // new), each unit_number must appear at most once. Compare against
      // existing units in the DB AND units already seen in this batch.
      if (row.unitNumber && (existingPropId || (row.propertyName && row.street1))) {
        // For existing properties, check the DB unit map directly.
        if (existingPropId) {
          const existingUnit = unitByKey.get(`${existingPropId}|${row.unitNumber.toLowerCase()}`)
          if (existingUnit) {
            row.resolvedUnitId = existingUnit
            issues.push({ severity: 'warn', field: 'unit_number', message: `Unit "${row.unitNumber}" already exists at this property — row will be skipped on commit` })
          }
        }
        // For both new and existing properties, check in-batch duplicates.
        const batchUnitKey = `${propKey}|${row.unitNumber.toLowerCase()}`
        if (seenUnitKeys.has(batchUnitKey)) {
          issues.push({ severity: 'block', field: 'unit_number', message: 'Duplicate unit_number within the same property in this CSV' })
        } else {
          seenUnitKeys.add(batchUnitKey)
        }
      }

      rows.push(row)
    }

    // S491: state-law mismatch check. Run after the per-row validation
    // so blocker issues stay leading. Fires only on rows that already
    // have both a parseable rent + deposit + state — uncatalogued or
    // missing-data rows return no flag. Best-effort: one failed
    // checkAgainstStatute call doesn't suppress the others.
    for (const row of rows) {
      const rent = parseFloat(row.rentAmount)
      const dep  = parseFloat(row.securityDeposit)
      if (!row.state || !Number.isFinite(rent) || rent <= 0 || !Number.isFinite(dep) || dep < 0) continue
      try {
        const months = dep / rent
        const flag = await checkAgainstStatute(row.state, 'deposit_max_months', months)
        if (flag) {
          row.issues.push({
            severity: 'warn',
            field:    'security_deposit',
            message:  flag.message,
          })
        }
      } catch (e) {
        logger.error({ err: e, state: row.state, row_index: row.rowIndex },
          '[stateLaw] property CSV deposit check failed')
      }
    }

    const blockers = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'block').length, 0)
    const warnings = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'warn').length, 0)
    const ready = rows.filter(r => !r.issues.some(i => i.severity === 'block')).length
    const newProperties = seenPropertyKeys.size

    // S537 (Nic): CSV-first onboarding — the wizard collects the late-fee
    // DECISION for every (property, unit_type) the file touches before
    // commit. Report each pair + whether a decision already exists (only
    // possible for existing properties).
    const decisionPairs = new Map<string, { propertyName: string; street1: string; propertyId: string | null; unitType: string; decided: boolean }>()
    for (const r of rows) {
      if (!r.propertyName || !r.unitType) continue
      const key = `${r.propertyName.toLowerCase()}|${r.street1.toLowerCase()}|${r.unitType}`
      if (!decisionPairs.has(key)) {
        decisionPairs.set(key, {
          propertyName: r.propertyName, street1: r.street1,
          propertyId: r.resolvedPropertyId || null, unitType: r.unitType, decided: false,
        })
      }
    }
    {
      const existingIds = Array.from(new Set(Array.from(decisionPairs.values()).map(d => d.propertyId).filter(Boolean))) as string[]
      if (existingIds.length > 0) {
        const decidedRows = await query<any>(
          `SELECT property_id, unit_type FROM property_unit_type_late_fees WHERE property_id = ANY($1::uuid[])`,
          [existingIds])
        const decidedSet = new Set(decidedRows.map(d => `${d.property_id}|${d.unit_type}`))
        for (const d of decisionPairs.values()) {
          if (d.propertyId && decidedSet.has(`${d.propertyId}|${d.unitType}`)) d.decided = true
        }
      }
    }
    const lateFeeDecisions = Array.from(decisionPairs.values())
    const newUnits = rows.filter(r =>
      !r.resolvedUnitId && !r.issues.some(i => i.severity === 'block')
    ).length

    // S295: persist the validate attempt to the review queue. Best-
    // effort; failure doesn't block the response.
    await recordValidateAttempt({
      landlordId,
      importType:    'property',
      platformKey:   sourceNorm,
      columnHeaders: propAttemptShape.columnHeaders,
      sampleRows:    propAttemptShape.sampleRows,
      rowCount:      rows.length,
      blockers,
      warnings,
      claimedPlatformName: claimName,
    })
    // S298: super_admin push notification for unverified platforms.
    await notifyCsvReviewPendingIfNeeded({
      landlordId, importType: 'property', platformKey: sourceNorm,
      source: 'validate', claimedPlatformName: claimName,
    })

    res.json({
      success: true,
      data: {
        rows,
        summary: { total: rows.length, blockers, warnings, ready, newProperties, newUnits },
        lateFeeDecisions,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/landlords/me/onboard-properties-csv/commit
// Body: { rows: PropertyCsvRow[], source?: CsvImportPlatform } —
// landlord-corrected rows from validate. source is optional for
// backwards compatibility; when present, the commit attempt is
// recorded with the correct platform key in the S295 review queue.
// Atomic: creates properties (find-or-create on name+street1) + units
// (skip if already resolved) within one transaction.
landlordsRouter.post('/me/onboard-properties-csv/commit', requirePerm('properties.bulk_import'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { rows, source, claimedPlatformName, lateFeeDecisions } = req.body
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(400, 'rows array required')
    }
    // S537 (Nic): CSV-first onboarding — the wizard sends the late-fee
    // DECISION for each (property, unit_type) in the file. Validate the
    // shapes up front; they upsert right after each property resolves.
    const decisionSchema = z.array(z.object({
      propertyName:  z.string().min(1),
      street1:       z.string(),
      unitType:      z.enum(UNIT_TYPES as unknown as [string, ...string[]]),
      noLateFee:     z.boolean().default(false),
      graceDays:     z.number().int().min(0).max(60).optional(),
      initialAmount: z.number().min(0).optional(),
      initialType:   z.enum(['flat', 'percent_of_rent']).optional(),
    }).refine(d => d.noLateFee || (d.graceDays !== undefined && d.initialAmount !== undefined && d.initialType !== undefined),
      { message: 'Fee decisions need graceDays, initialAmount and initialType' }))
    const decisions = decisionSchema.parse(lateFeeDecisions ?? [])
    const decisionByKey = new Map(decisions.map(d =>
      [`${d.propertyName.toLowerCase()}|${d.street1.toLowerCase()}|${d.unitType}`, d]))
    const propSourceNorm = source && isCsvImportPlatform(String(source).toLowerCase())
      ? String(source).toLowerCase()
      : 'generic'
    // S297: generic uploads must declare what platform the CSV came
    // from. Powers the claim-aggregation surface; if multiple
    // landlords claim the same platform, super admin sees a
    // promotion candidate.
    const claimName = propSourceNorm === 'generic' && typeof claimedPlatformName === 'string'
      ? claimedPlatformName.trim() : ''
    if (propSourceNorm === 'generic' && !claimName) {
      throw new AppError(400, 'claimedPlatformName is required for generic uploads')
    }

    const landlordId = req.user!.profileId

    for (const row of rows as PropertyCsvRow[]) {
      const blockers = (row.issues || []).filter(i => i.severity === 'block')
      if (blockers.length > 0) {
        throw new AppError(400, `Row ${row.rowIndex + 1} still has blockers: ${blockers.map(b => b.message).join(', ')}`)
      }
    }

    await client.query('BEGIN')

    // Track property creates within this commit so multiple rows for the
    // same new property share one INSERT.
    const propertyIdByKey = new Map<string, string>()
    const createdProperties: { id: string; name: string; street1?: string; street2?: string | null; city?: string; state?: string; zip?: string }[] = []
    const createdUnits: { id: string; unitNumber: string; propertyId: string }[] = []
    let skippedUnits = 0

    for (const row of rows as PropertyCsvRow[]) {
      const propKey = `${row.propertyName.toLowerCase()}|${row.street1.toLowerCase()}`

      // Resolve / create property
      let propertyId: string | undefined = row.resolvedPropertyId
      if (!propertyId) propertyId = propertyIdByKey.get(propKey)

      if (!propertyId) {
        // S550 (Nic, final form): the ADDRESS is the property — one address,
        // one record, one account. Same landlord + same name+address ->
        // attach rows to the existing property. ANY other account at this
        // address (any name) -> blocked claim (mirrors POST /api/properties;
        // reveal nothing about that account). Co-owners get added as users
        // on the primary account, never a rival property record.
        const existing = (await client.query<{ id: string; landlord_id: string; name: string }>(
          `SELECT id, landlord_id, name FROM properties
            WHERE LOWER(TRIM(street1)) = LOWER(TRIM($1))
              AND LOWER(TRIM(city)) = LOWER(TRIM($2))
              AND COALESCE(LOWER(TRIM(street2)), '') = COALESCE(LOWER(TRIM($3)), '')
              AND (landlord_id <> $4 OR LOWER(TRIM(name)) = LOWER(TRIM($5)))
            ORDER BY (landlord_id = $4) DESC
            LIMIT 1`,
          [row.street1, row.city, row.street2 ?? '', landlordId, row.propertyName])).rows[0]
        if (existing && existing.landlord_id === landlordId) {
          propertyId = existing.id
          propertyIdByKey.set(propKey, existing.id)
        } else if (existing) {
          const { createAdminNotification } = await import('../services/adminNotifications')
          await createAdminNotification({
            severity: 'warn',
            category: 'duplicate_property_claim',
            title: `Blocked duplicate property claim (CSV): ${row.propertyName}`,
            body: `Landlord ${landlordId} CSV-imported "${row.propertyName}" at ` +
                  `${row.street1}, ${row.city} — already registered under landlord ` +
                  `${existing.landlord_id} (property ${existing.id}).`,
            context: { attemptingLandlordId: landlordId, existingPropertyId: existing.id },
          }).catch(() => {})
          throw new AppError(409,
            `Row ${row.rowIndex + 1}: the address ${row.street1}, ${row.city} is already ` +
            `registered on GAM. If you own a different suite or building at this address, ` +
            `include its suite/unit line in the address. If you co-own this property, ask ` +
            `the primary account holder to add you as a user — or contact support.`)
        }
      }

      if (!propertyId) {
        const propType = ['residential', 'rv_longterm', 'rv_weekly', 'rv_nightly', 'mixed'].includes(row.propertyType)
          ? row.propertyType
          : 'mixed'
        const propRes = await client.query<any>(
          `INSERT INTO properties
             (landlord_id, name, street1, street2, city, state, zip, type,
              timezone,
              owner_user_id, managed_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
              COALESCE(NULLIF($9, ''), 'America/Phoenix'),
              (SELECT user_id FROM landlords WHERE id=$1),
              (SELECT user_id FROM landlords WHERE id=$1))
           RETURNING id, name`,
          [
            landlordId, row.propertyName, row.street1, row.street2 || null,
            row.city, row.state, row.zip, propType,
            row.timezone || '',
          ]
        )
        propertyId = propRes.rows[0].id as string
        propertyIdByKey.set(propKey, propertyId)
        createdProperties.push({
          id: propertyId, name: propRes.rows[0].name,
          street1: row.street1, street2: row.street2 || null,
          city: row.city, state: row.state, zip: row.zip,
        })

        // Imported properties get a sensible-default allocation rule —
        // tenant pays banking + processing fees (per GAM pricing model),
        // landlord pays platform fee, no PM cut. Landlord can override on
        // the property detail page after import.
        await client.query(
          `INSERT INTO property_allocation_rules
             (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer)
           VALUES ($1, 'tenant', 'tenant', 'landlord')`,
          [propertyId]
        )
      }

      // Skip unit creation if validate matched it to an existing unit.
      if (row.resolvedUnitId) {
        skippedUnits++
        continue
      }

      // S537 (Nic): NO silent apartment default — validate blocks blank/
      // unrecognized types, and commit refuses them outright.
      if (!['apartment', 'single_family', 'rv_spot', 'mobile_home', 'storage', 'commercial'].includes(row.unitType)) {
        throw new AppError(400, `Row ${row.rowIndex + 1}: unit type "${row.unitType || '(blank)'}" is not a GAM unit type — set it in the review step`)
      }
      const unitType = row.unitType

      // Upsert this (property, unit_type)'s late-fee decision from the
      // wizard payload before the unit exists, so the S537 gate holds.
      const decisionKey = `${row.propertyName.toLowerCase()}|${row.street1.toLowerCase()}|${unitType}`
      const decision = decisionByKey.get(decisionKey)
      if (decision) {
        await client.query(
          `INSERT INTO property_unit_type_late_fees
             (property_id, unit_type, no_late_fee, late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (property_id, unit_type) DO UPDATE SET
             no_late_fee = EXCLUDED.no_late_fee,
             late_fee_grace_days = EXCLUDED.late_fee_grace_days,
             late_fee_initial_amount = EXCLUDED.late_fee_initial_amount,
             late_fee_initial_type = EXCLUDED.late_fee_initial_type,
             updated_at = NOW()`,
          [propertyId, unitType, decision.noLateFee,
           decision.noLateFee ? null : decision.graceDays,
           decision.noLateFee ? null : decision.initialAmount!.toFixed(2),
           decision.noLateFee ? null : decision.initialType])
        decisionByKey.delete(decisionKey) // upsert once per pair
      }
      // Final gate — decision must exist (wizard-sent or pre-existing).
      await assertLateFeeDecision(propertyId!, unitType, client)
      const unitRes = await client.query<any>(
        `INSERT INTO units
           (property_id, landlord_id, unit_number, bedrooms, bathrooms, sqft,
            unit_type, rent_amount, security_deposit, status,
            import_extra_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'vacant', $10)
         RETURNING id, unit_number`,
        [
          propertyId, landlordId, row.unitNumber,
          row.bedrooms ? parseInt(row.bedrooms, 10) : 1,
          row.bathrooms ? parseFloat(row.bathrooms) : 1.0,
          row.sqft ? parseInt(row.sqft, 10) : null,
          unitType,
          parseFloat(row.rentAmount),
          row.securityDeposit ? parseFloat(row.securityDeposit) : 0,
          row.extra && Object.keys(row.extra).length > 0
            ? JSON.stringify(row.extra) : null,
        ]
      )
      createdUnits.push({
        id: unitRes.rows[0].id,
        unitNumber: unitRes.rows[0].unit_number,
        propertyId: propertyId!,
      })
    }

    await client.query('COMMIT')

    // S550: real-world address verification for each newly created property —
    // sequential (public geocoder is rate-limited), detached, never blocks
    // the import response.
    if (createdProperties.length > 0) {
      const { verifyPropertyAddress } = await import('../services/addressVerification')
      void (async () => {
        for (const cp of createdProperties as any[]) {
          if (!cp.street1) continue
          await verifyPropertyAddress(cp.id, {
            street1: cp.street1, street2: cp.street2,
            city: cp.city, state: cp.state, zip: cp.zip,
          }).catch(() => {})
        }
      })()
    }

    // S295: record the commit + compute first-5 position for the
    // banner. Best-effort — failure here doesn't roll back the
    // import (it's already committed).
    await recordCommitAttempt({
      landlordId,
      importType:  'property',
      platformKey: propSourceNorm,
      columnHeaders: [],
      sampleRows:    [],
      rowCount:      createdUnits.length + skippedUnits,
      claimedPlatformName: claimName || null,
    })
    await notifyCsvReviewPendingIfNeeded({
      landlordId, importType: 'property', platformKey: propSourceNorm,
      source: 'commit', claimedPlatformName: claimName || null,
    })
    const propertyStatus = await getPlatformReviewStatus(propSourceNorm, 'property')

    res.json({
      success: true,
      data: {
        propertiesCreated: createdProperties.length,
        unitsCreated:      createdUnits.length,
        unitsSkipped:      skippedUnits,
        properties:        createdProperties,
        units:             createdUnits,
        escalateToSuperAdmin: propertyStatus.escalateToSuperAdmin,
        mappingStatus:        propertyStatus.mappingStatus,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})


// GET /api/landlords/me/onboard-tenants-csv/template?source=generic
// S231: per-platform templates via csvImportMappings registry. Generic
// returns canonical headers + example row; enabled platforms return the
// platform's preferred header names (first alias of each canonical field).
landlordsRouter.get('/me/onboard-tenants-csv/template', requirePerm('tenants.create'), async (req, res, next) => {
  try {
    const source = String(req.query.source || 'generic').toLowerCase()
    if (!isCsvImportPlatform(source)) {
      throw new AppError(400, `Unknown source: ${source}`)
    }
    if (!isPlatformEnabled(source)) {
      throw new AppError(400, `${source} is not yet supported. Pick Generic and map your columns manually for now.`)
    }

    const csv = buildTemplateCsv(source as CsvImportPlatform)
    const filename = source === 'generic'
      ? 'gam-onboarding-template.csv'
      : `gam-onboarding-template-${source}.csv`
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  } catch (e) { next(e) }
})


// POST /api/landlords/me/onboard-tenants-csv/validate
// Body: { csv: string, source: 'generic' }
// Returns: { rows: CsvRow[], summary: { total, blockers, warnings, ready } }
landlordsRouter.post('/me/onboard-tenants-csv/validate', requirePerm('tenants.create'), async (req, res, next) => {
  try {
    const { csv, source, claimedPlatformName } = req.body
    if (!csv) throw new AppError(400, 'csv body required')
    const sourceNorm = String(source || 'generic').toLowerCase()
    if (!isCsvImportPlatform(sourceNorm)) {
      throw new AppError(400, `Unknown source: ${sourceNorm}`)
    }
    if (!isPlatformEnabled(sourceNorm)) {
      throw new AppError(400, `${sourceNorm} is not yet supported. Pick Generic and map your columns manually for now.`)
    }
    // S297: claim meaningful only on generic. Validate doesn't
    // require it — landlord may want to preview without typing.
    const claimName = sourceNorm === 'generic' && typeof claimedPlatformName === 'string'
      ? claimedPlatformName.trim() : null

    let records: any[]
    try {
      records = parseCsv(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as any[]
    } catch (e: any) {
      throw new AppError(400, `CSV parse failed: ${e.message}`)
    }

    if (records.length === 0) throw new AppError(400, 'CSV has no data rows')

    // S295: capture raw shape before applyMapping rewrites column names.
    const tenantAttemptShape = extractAttemptShape(records)

    // S231: rewrite the source platform's column headers to GAM's canonical
    // names. Generic is identity — non-generic platforms map e.g. 'First
    // Name' → 'first_name' before the validator runs against canonical keys.
    records = applyMapping(records, sourceNorm as CsvImportPlatform)

    const landlordId = req.user!.profileId

    const units = await query<any>(
      `SELECT u.id, u.unit_number, u.property_id, p.name AS property_name
       FROM units u JOIN properties p ON p.id = u.property_id
       WHERE u.landlord_id = $1`,
      [landlordId]
    )

    const occupiedUnitIds = new Set(
      (await query<any>(
        `SELECT unit_id FROM v_unit_occupancy WHERE is_occupied = TRUE AND unit_id = ANY($1::uuid[])`,
        [units.map(u => u.id)]
      )).map(r => r.unit_id)
    )

    const rows: CsvRow[] = []
    const emailSeenInBatch = new Map<string, number>()
    const unitToFirstRowIndex = new Map<string, number>()

    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      const issues: CsvIssue[] = []

      const row: CsvRow = {
        rowIndex: i,
        firstName: String(r.first_name || '').trim(),
        lastName: String(r.last_name || '').trim(),
        email: String(r.email || '').trim().toLowerCase(),
        phone: String(r.phone || '').trim(),
        propertyName: String(r.property_name || '').trim(),
        unitNumber: String(r.unit_number || '').trim(),
        leaseStart: String(r.lease_start || '').trim(),
        leaseEnd: String(r.lease_end || '').trim(),
        monthlyRent: String(r.monthly_rent || '').trim(),
        securityDeposit: String(r.security_deposit || '').trim(),
        lateFeeAmount: String(r.late_fee_amount || '').trim(),
        lateFeeGraceDays: String(r.late_fee_grace_days || '').trim(),
        autoRenew: String(r.auto_renew || '').trim(),
        autoRenewMode: String(r.auto_renew_mode || '').trim(),
        noticeDaysRequired: String(r.notice_days_required || '').trim(),
        outstandingBalance: String(r.outstanding_balance || '').trim(),
        extra: r._extra,
        issues,
      }

      if (!row.firstName) issues.push({ severity: 'block', field: 'first_name', message: 'Required' })
      if (!row.lastName)  issues.push({ severity: 'block', field: 'last_name',  message: 'Required' })
      if (!row.email)     issues.push({ severity: 'block', field: 'email',      message: 'Required' })
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
        issues.push({ severity: 'block', field: 'email', message: 'Invalid email format' })
      }
      if (!row.phone) issues.push({ severity: 'block', field: 'phone', message: 'Required' })

      if (!row.leaseStart) issues.push({ severity: 'block', field: 'lease_start', message: 'Required' })
      else if (isNaN(Date.parse(row.leaseStart))) issues.push({ severity: 'block', field: 'lease_start', message: 'Invalid date' })

      if (!row.monthlyRent) issues.push({ severity: 'block', field: 'monthly_rent', message: 'Required' })
      else {
        const rent = parseFloat(row.monthlyRent)
        if (isNaN(rent) || rent < 0) issues.push({ severity: 'block', field: 'monthly_rent', message: 'Must be a non-negative number' })
      }

      if (row.outstandingBalance) {
        // Source platforms occasionally export balances as negative
        // (credit on account) or with currency formatting. Strip the
        // common decorations and accept negative; we'll skip writing an
        // invoice for non-positive values on commit.
        const bal = parseFloat(row.outstandingBalance.replace(/[$,\s]/g, ''))
        if (isNaN(bal)) {
          issues.push({ severity: 'block', field: 'outstanding_balance', message: 'Must be a number' })
        }
      }

      if (row.leaseEnd && isNaN(Date.parse(row.leaseEnd))) {
        issues.push({ severity: 'block', field: 'lease_end', message: 'Invalid date' })
      }
      if (row.leaseEnd && row.leaseStart && Date.parse(row.leaseEnd) < Date.parse(row.leaseStart)) {
        issues.push({ severity: 'block', field: 'lease_end', message: 'Must be after lease_start' })
      }
      if (row.leaseEnd && Date.parse(row.leaseEnd) < Date.now()) {
        issues.push({ severity: 'warn', field: 'lease_end', message: 'Lease end date is in the past' })
      }

      const arBool = parseBool(row.autoRenew)
      if (row.autoRenew && arBool === null) {
        issues.push({ severity: 'block', field: 'auto_renew', message: 'Must be yes/no' })
      }
      if (arBool === true && !(AUTO_RENEW_MODES as readonly string[]).includes(row.autoRenewMode)) {
        issues.push({ severity: 'block', field: 'auto_renew_mode', message: 'Required when auto_renew=yes (extend_same_term or convert_to_month_to_month)' })
      }

      if (!row.propertyName) issues.push({ severity: 'block', field: 'property_name', message: 'Required' })
      if (!row.unitNumber)   issues.push({ severity: 'block', field: 'unit_number',   message: 'Required' })
      // S605 (Nic, DIRECTIVE): units created in GAM must carry a prefix — a bare
      // "37" is the accident that rule exists to stop, and it collides when two
      // unit types share a number.
      //
      // WARN here rather than BLOCK, deliberately. This is the MIGRATION path:
      // the rent roll being imported already exists in the real world, and a
      // landlord whose apartments have genuinely been called "101" for twenty
      // years should not be refused entry to the platform over naming. They are
      // told, and can rename on the way in or afterwards.
      else if (unitNumberNeedsPrefix(row.unitNumber)) {
        issues.push({ severity: 'warn', field: 'unit_number',
          message: `"${row.unitNumber}" has no prefix. New units in GAM require one (e.g. "Apt ${row.unitNumber}") — ` +
                   `imported numbers are kept as-is, but a bare number can collide if another unit type reuses it.` })
      }

      if (row.propertyName && row.unitNumber) {
        const match = units.find(u =>
          u.property_name.trim().toLowerCase() === row.propertyName.toLowerCase() &&
          String(u.unit_number).trim().toLowerCase() === row.unitNumber.toLowerCase()
        )
        if (!match) {
          issues.push({ severity: 'block', field: 'unit_number', message: `No unit "${row.unitNumber}" found at property "${row.propertyName}" in your portfolio` })
        } else {
          row.resolvedUnitId = match.id
          const firstRowForUnit = unitToFirstRowIndex.get(match.id)
          if (firstRowForUnit === undefined) {
            unitToFirstRowIndex.set(match.id, i)
            if (occupiedUnitIds.has(match.id)) {
              issues.push({ severity: 'block', field: 'unit_number', message: 'Unit is already occupied. Co-tenant additions to occupied units require consent and are not yet supported in this flow.' })
            }
          } else {
            const primary = rows[firstRowForUnit]
            if (row.leaseStart && primary.leaseStart && row.leaseStart !== primary.leaseStart) {
              issues.push({ severity: 'warn', field: 'lease_start', message: `Differs from primary tenant row (${primary.leaseStart}). Primary will be used.` })
            }
            if (row.leaseEnd && primary.leaseEnd && row.leaseEnd !== primary.leaseEnd) {
              issues.push({ severity: 'warn', field: 'lease_end', message: `Differs from primary (${primary.leaseEnd}). Primary will be used.` })
            }
            if (row.monthlyRent && primary.monthlyRent && row.monthlyRent !== primary.monthlyRent) {
              issues.push({ severity: 'warn', field: 'monthly_rent', message: `Differs from primary (${primary.monthlyRent}). Primary will be used.` })
            }
          }
        }
      }

      if (row.email) {
        const prev = emailSeenInBatch.get(row.email)
        if (prev !== undefined) {
          issues.push({ severity: 'warn', field: 'email', message: `Duplicate of row ${prev + 1} — will be skipped` })
        } else {
          emailSeenInBatch.set(row.email, i)
        }
      }

      rows.push(row)
    }

    const allEmails = Array.from(new Set(rows.map(r => r.email).filter(Boolean)))
    if (allEmails.length > 0) {
      const existing = await query<any>(
        `SELECT u.id AS user_id, u.email, t.id AS tenant_id
         FROM users u
         LEFT JOIN tenants t ON t.user_id = u.id
         WHERE u.email = ANY($1::text[])`,
        [allEmails]
      )
      const byEmail = new Map(existing.map(e => [e.email, e]))

      const tenantIds = existing.filter(e => e.tenant_id).map(e => e.tenant_id)
      if (tenantIds.length > 0) {
        const otherLeases = await query<any>(
          `SELECT lt.tenant_id FROM lease_tenants lt
           JOIN leases l ON l.id = lt.lease_id
           WHERE lt.tenant_id = ANY($1::uuid[])
             AND lt.status='active' AND l.status='active'
             AND l.landlord_id != $2`,
          [tenantIds, landlordId]
        )
        const otherSet = new Set(otherLeases.map(r => r.tenant_id))

        const sameLandlord = await query<any>(
          `SELECT lt.tenant_id FROM lease_tenants lt
           JOIN leases l ON l.id = lt.lease_id
           WHERE lt.tenant_id = ANY($1::uuid[])
             AND lt.status='active' AND l.status='active'
             AND l.landlord_id = $2`,
          [tenantIds, landlordId]
        )
        const sameSet = new Set(sameLandlord.map(r => r.tenant_id))

        for (const row of rows) {
          const found = byEmail.get(row.email)
          if (!found) continue
          row.resolvedExistingUserId = found.user_id
          row.resolvedExistingTenantId = found.tenant_id || undefined

          if (found.tenant_id && otherSet.has(found.tenant_id)) {
            row.issues.push({ severity: 'block', field: 'email', message: 'This email is a tenant of another landlord. Cross-landlord onboarding requires a separate flow.' })
          } else if (found.tenant_id && sameSet.has(found.tenant_id)) {
            row.issues.push({ severity: 'warn', field: 'email', message: 'Already onboarded with you on an active lease. Row will be skipped on commit.' })
          }
        }
      }
    }

    const blockers = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'block').length, 0)
    const warnings = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'warn').length, 0)
    const ready = rows.filter(r => !r.issues.some(i => i.severity === 'block')).length

    // S537 (Nic): the tenant-CSV commit gates on a late-fee decision for
    // every (property, unit_type) it touches. Report the UNDECIDED pairs
    // here, each with a SUGGESTED prefill = the most frequent
    // (late_fee_amount, grace_days) among this file's leases for that
    // pair — a landlord who kept per-lease fees consistent on their old
    // platform was expressing a de-facto property policy; surface it as
    // the default they confirm (never auto-applied).
    const missingLateFeeDecisions: any[] = []
    {
      const unitIdsAll = Array.from(new Set(rows.map(r => r.resolvedUnitId).filter(Boolean))) as string[]
      if (unitIdsAll.length > 0) {
        const pairRows = await query<any>(
          `SELECT u.id AS unit_id, u.property_id, u.unit_type, p.name AS property_name
             FROM units u JOIN properties p ON p.id = u.property_id
            WHERE u.id = ANY($1::uuid[]) AND u.unit_type IS NOT NULL`, [unitIdsAll])
        const unitPair = new Map(pairRows.map((r: any) => [r.unit_id, r]))
        const decided = await query<any>(
          `SELECT property_id, unit_type FROM property_unit_type_late_fees
            WHERE property_id = ANY($1::uuid[])`,
          [Array.from(new Set(pairRows.map((r: any) => r.property_id)))])
        const decidedSet = new Set(decided.map((d: any) => `${d.property_id}|${d.unit_type}`))
        // Tally (amount, grace) frequencies per undecided pair.
        const tally = new Map<string, { info: any; counts: Map<string, { n: number; amount: number; graceDays: number }> }>()
        for (const r of rows) {
          const pr: any = r.resolvedUnitId ? unitPair.get(r.resolvedUnitId) : null
          if (!pr) continue
          const pairKey = `${pr.property_id}|${pr.unit_type}`
          if (decidedSet.has(pairKey)) continue
          if (!tally.has(pairKey)) tally.set(pairKey, { info: pr, counts: new Map() })
          const amt = r.lateFeeAmount ? parseFloat(r.lateFeeAmount) : NaN
          if (isNaN(amt) || amt <= 0) continue
          const grace = r.lateFeeGraceDays ? parseInt(r.lateFeeGraceDays, 10) : 5
          const vKey = `${amt}|${isNaN(grace) ? 5 : grace}`
          const cur = tally.get(pairKey)!.counts.get(vKey) || { n: 0, amount: amt, graceDays: isNaN(grace) ? 5 : grace }
          cur.n++
          tally.get(pairKey)!.counts.set(vKey, cur)
        }
        for (const { info, counts } of tally.values()) {
          let suggested: any = null
          let best = 0
          let total = 0
          for (const c of counts.values()) {
            total += c.n
            if (c.n > best) { best = c.n; suggested = { initialAmount: c.amount, graceDays: c.graceDays, initialType: 'flat', leaseCount: c.n } }
          }
          if (suggested) suggested.leaseTotal = total
          missingLateFeeDecisions.push({
            propertyId: info.property_id, propertyName: info.property_name,
            unitType: info.unit_type, suggested,
          })
        }
      }
    }

    // S295: persist the validate attempt to the review queue.
    await recordValidateAttempt({
      landlordId,
      importType:    'tenant',
      platformKey:   sourceNorm,
      columnHeaders: tenantAttemptShape.columnHeaders,
      sampleRows:    tenantAttemptShape.sampleRows,
      rowCount:      rows.length,
      blockers,
      warnings,
      claimedPlatformName: claimName,
    })
    await notifyCsvReviewPendingIfNeeded({
      landlordId, importType: 'tenant', platformKey: sourceNorm,
      source: 'validate', claimedPlatformName: claimName,
    })

    res.json({
      success: true,
      data: {
        rows,
        summary: { total: rows.length, blockers, warnings, ready },
        missingLateFeeDecisions,
      },
    })
  } catch (e) { next(e) }
})


// POST /api/landlords/me/onboard-tenants-csv/commit
// Body: { rows: CsvRow[], source?: CsvImportPlatform } — landlord-
// corrected rows from /validate. source is optional for backwards
// compatibility; when present, the commit attempt is recorded with
// the correct platform key in the S295 review queue.
landlordsRouter.post('/me/onboard-tenants-csv/commit', requirePerm('tenants.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { rows, source, claimedPlatformName } = req.body
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(400, 'rows array required')
    }
    const tenantSourceNorm = source && isCsvImportPlatform(String(source).toLowerCase())
      ? String(source).toLowerCase()
      : 'generic'
    // S297: generic commit requires the claim. See property-commit
    // for full rationale.
    const tenantClaimName = tenantSourceNorm === 'generic' && typeof claimedPlatformName === 'string'
      ? claimedPlatformName.trim() : ''
    if (tenantSourceNorm === 'generic' && !tenantClaimName) {
      throw new AppError(400, 'claimedPlatformName is required for generic uploads')
    }

    const landlordId = req.user!.profileId

    // Defense in depth: re-resolve unit ownership and check no blockers remain.
    const unitIds = Array.from(new Set((rows as CsvRow[]).map(r => r.resolvedUnitId).filter(Boolean) as string[]))
    const ownedUnits = await query<any>(
      `SELECT id FROM units WHERE id = ANY($1::uuid[]) AND landlord_id = $2`,
      [unitIds, landlordId]
    )
    const ownedSet = new Set(ownedUnits.map(u => u.id))
    for (const row of rows as CsvRow[]) {
      if (!row.resolvedUnitId || !ownedSet.has(row.resolvedUnitId)) {
        throw new AppError(403, `Row ${row.rowIndex + 1} references a unit not owned by this landlord`)
      }
      const blockers = (row.issues || []).filter(i => i.severity === 'block')
      if (blockers.length > 0) {
        throw new AppError(400, `Row ${row.rowIndex + 1} still has blockers: ${blockers.map(b => b.message).join(', ')}`)
      }
    }

    // Group by unit. Skip already-onboarded duplicate rows.
    const groups = new Map<string, CsvRow[]>()
    for (const row of rows as CsvRow[]) {
      const isDupSkip = (row.issues || []).some(i =>
        i.severity === 'warn' && i.field === 'email' && i.message.startsWith('Already onboarded')
      )
      if (isDupSkip) continue
      if (!row.resolvedUnitId) continue
      if (!groups.has(row.resolvedUnitId)) groups.set(row.resolvedUnitId, [])
      groups.get(row.resolvedUnitId)!.push(row)
    }

    const unitDetails = await query<any>(
      `SELECT u.id, u.unit_number, p.name AS property_name, p.street1, p.city, p.state, p.zip
       FROM units u JOIN properties p ON p.id = u.property_id
       WHERE u.id = ANY($1::uuid[])`,
      [Array.from(groups.keys())]
    )
    const unitDetailMap = new Map(unitDetails.map(u => [u.id, u]))

    // S537 gate: every distinct (property, unit_type) in the commit needs
    // an explicit late-fee decision — bulk migration is exactly where
    // unvetted classes would otherwise slip in.
    {
      const typePairs = await query<any>(
        `SELECT DISTINCT property_id, unit_type FROM units
         WHERE id = ANY($1::uuid[]) AND unit_type IS NOT NULL`,
        [Array.from(groups.keys())]
      )
      for (const tp of typePairs) await assertLateFeeDecision(tp.property_id, tp.unit_type)
    }

    const landlord = await queryOne<any>(
      `SELECT u.first_name, u.last_name FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
      [landlordId]
    )
    const landlordName = landlord ? `${landlord.first_name} ${landlord.last_name}`.trim() : 'Your landlord'

    await client.query('BEGIN')

    const created: { tenantId: string; leaseId: string; email: string; activationUrl: string; firstName: string; unitId: string }[] = []
    const tenantAppUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'

    for (const [unitId, groupRows] of groups.entries()) {
      const primary = groupRows[0]
      // S582: server-side occupancy backstop. /validate blocks occupied units,
      // but the commit must NOT trust the client ran it (same "trust nothing"
      // principle as commit-pending). Without this, a direct call or a re-run
      // that bypasses re-validation would create a SECOND active lease on a unit
      // (whole_unit) — double-booking a 32-unit import. Mode-aware; throws +
      // rolls back the whole import (all-or-nothing, like the late-fee gate above).
      await assertUnitCanAcceptNewLease(client, unitId)
      const leaseType = primary.leaseEnd ? 'fixed_term' : 'month_to_month'
      const arBool = parseBool(primary.autoRenew) === true
      const arMode = arBool ? primary.autoRenewMode : null

      // S196: security_deposit removed from leases columns; written to
      // lease_fees via syncSecurityDepositLeaseFee below.
      // S294: extras from primary row land on the lease. Co-tenant rows'
      // extras are dropped — they describe the same lease relationship,
      // and reconciling per-tenant extras into one JSONB blob would risk
      // collision. Acceptable: if both co-tenants share an extra column,
      // it's the same value; if they differ, primary wins (same pattern
      // as the lease itself, which uses primary.* for all fields).
      const lease = await client.query(
        `INSERT INTO leases (
           unit_id, landlord_id, status, start_date, end_date, rent_amount,
           late_fee_initial_amount, late_fee_grace_days,
           lease_type, auto_renew, auto_renew_mode,
           notice_days_required, needs_review, lease_source,
           import_extra_data
         ) VALUES (
           $1, $2, 'active', $3, $4, $5,
           $6, $7,
           $8, $9, $10,
           $11, TRUE, 'imported',
           $12
         ) RETURNING id`,
        [
          unitId, landlordId,
          primary.leaseStart, primary.leaseEnd || null, parseFloat(primary.monthlyRent),
          // S537: NEVER invent a late fee (see onboard-tenant note).
          primary.lateFeeAmount ? parseFloat(primary.lateFeeAmount) : null,
          primary.lateFeeAmount ? (primary.lateFeeGraceDays ? parseInt(primary.lateFeeGraceDays) : 5) : null,
          leaseType, arBool, arMode,
          primary.noticeDaysRequired ? parseInt(primary.noticeDaysRequired) : 30,
          primary.extra && Object.keys(primary.extra).length > 0
            ? JSON.stringify(primary.extra) : null,
        ]
      )
      const leaseId = lease.rows[0].id

      // S195 dual-write: mirror security_deposit into lease_fees.
      {
        const { syncSecurityDepositLeaseFee } = await import('../services/leaseFeesSync')
        await syncSecurityDepositLeaseFee(
          leaseId,
          primary.securityDeposit ? parseFloat(primary.securityDeposit) : 0,
          client,
        )
      }

      // Opening balance — carry AR from prior platform as a single pending
      // invoice on the imported lease. Skip if zero / unset / negative
      // (credit balances aren't representable as an invoice; landlord can
      // record them as adjustments post-import).
      if (primary.outstandingBalance) {
        const rawBal = parseFloat(primary.outstandingBalance.replace(/[$,\s]/g, ''))
        if (!isNaN(rawBal) && rawBal > 0) {
          const balance = Math.round(rawBal * 100) / 100
          const today = new Date()
          const year = today.getUTCFullYear()
          const seqRes = await client.query(
            `INSERT INTO invoice_sequences (landlord_id, year, next_number)
             VALUES ($1, $2, 2)
             ON CONFLICT (landlord_id, year)
             DO UPDATE SET next_number = invoice_sequences.next_number + 1
             RETURNING next_number`,
            [landlordId, year]
          )
          const invoiceNumber = formatInvoiceNumber(year, (seqRes.rows[0].next_number as number) - 1)
          await client.query(
            `INSERT INTO invoices (
               landlord_id, lease_id, unit_id,
               invoice_number, due_date,
               subtotal_rent, total_amount, status, notes
             ) VALUES (
               $1, $2, $3, $4, CURRENT_DATE,
               $5, $5, 'pending', $6
             ) ON CONFLICT (lease_id, due_date) DO NOTHING`,
            [
              landlordId, leaseId, unitId,
              invoiceNumber,
              balance.toFixed(2),
              'Imported opening balance from prior platform.',
            ]
          )
        }
      }

      for (let idx = 0; idx < groupRows.length; idx++) {
        const row = groupRows[idx]
        const role = idx === 0 ? 'primary' : 'co_tenant'

        let userId: string
        if (row.resolvedExistingUserId) {
          userId = row.resolvedExistingUserId
        } else {
          const tempHash = '$2b$10$placeholder_invite_pending'
          const u = await client.query(
            `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
             VALUES ($1, $2, 'tenant', $3, $4, $5) RETURNING id`,
            [row.email, tempHash, row.firstName, row.lastName, row.phone]
          )
          userId = u.rows[0].id
        }

        // S410 (S377): tenant_invite_token + 7-day expiry. See note at
        // line ~836 in this file for the rationale.
        const inviteToken = require('crypto').randomBytes(32).toString('hex')
        await client.query(
          `UPDATE users SET tenant_invite_token=$1,
                            tenant_invite_expires_at=NOW() + INTERVAL '7 days'
            WHERE id=$2`,
          [inviteToken, userId])

        let tenantId: string
        if (row.resolvedExistingTenantId) {
          tenantId = row.resolvedExistingTenantId
          await client.query(
            `UPDATE tenants SET onboarding_source='onboarded' WHERE id=$1 AND onboarding_source != 'onboarded'`,
            [tenantId]
          )
        } else {
          const t = await client.query(
            `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded') RETURNING id`,
            [userId]
          )
          tenantId = t.rows[0].id
        }

        await client.query(
          `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
           VALUES ($1, $2, $3, 'active', NOW(), 'original', 'joint_several')`,
          [leaseId, tenantId, role]
        )

        const activationUrl = `${tenantAppUrl}/accept-invite?token=${inviteToken}`
        created.push({ tenantId, leaseId, email: row.email, activationUrl, firstName: row.firstName, unitId })
      }
    }

    await client.query('COMMIT')

    // Send activation emails post-commit. One failure shouldn't block others.
    for (const c of created) {
      const unit = unitDetailMap.get(c.unitId)
      const propertyAddress = [unit?.street1, unit?.city, unit?.state, unit?.zip].filter(Boolean).join(', ')
      const unitLabel = `${unit?.property_name} — Unit ${unit?.unit_number}`
      try {
        await emailTenantOnboarded(
          c.email, c.firstName, landlordName, propertyAddress, unitLabel, c.activationUrl,
          { landlordId, tenantId: c.tenantId }
        )
      } catch (emailErr) {
        logger.error({ err: emailErr, ctx: c.email }, '[ONBOARD CSV] Email send failed for')
        logger.info(`[ONBOARD CSV] Manual activation URL for ${c.email}: ${c.activationUrl}`)
      }
    }

    // S295: record commit + compute first-5 position for banner.
    await recordCommitAttempt({
      landlordId,
      importType:  'tenant',
      platformKey: tenantSourceNorm,
      columnHeaders: [],
      sampleRows:    [],
      rowCount:      created.length,
      claimedPlatformName: tenantClaimName || null,
    })
    await notifyCsvReviewPendingIfNeeded({
      landlordId, importType: 'tenant', platformKey: tenantSourceNorm,
      source: 'commit', claimedPlatformName: tenantClaimName || null,
    })
    const tenantStatus = await getPlatformReviewStatus(tenantSourceNorm, 'tenant')

    res.json({
      success: true,
      data: {
        committed: created.length,
        leases: groups.size,
        tenants: created.map(c => ({ email: c.email, tenantId: c.tenantId, leaseId: c.leaseId })),
        escalateToSuperAdmin: tenantStatus.escalateToSuperAdmin,
        mappingStatus:        tenantStatus.mappingStatus,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})


// ── PAYMENT HISTORY CSV IMPORT (Phase B) ──────────────────────────────
// Lets a landlord migrate historical rent collections from a prior PM
// software. One CSV row = one historical payment; resolved to an active
// tenant + lease in the landlord's portfolio via email. On commit
// each row writes a `payments` row with status='settled',
// import_source=<platform>, settled_at=payment_date.

type PaymentCsvRow = {
  rowIndex:      number
  tenantEmail:   string
  tenantName:    string
  paymentDate:   string
  amount:        string
  paymentType:   string
  paymentMethod: string
  propertyName:  string
  unitNumber:    string
  reference:     string
  resolvedTenantId?: string
  resolvedLeaseId?:  string
  resolvedUnitId?:   string
  resolvedVia?:      'email' | 'name'
  // S294: source-platform columns that aren't canonical-mapped and
  // aren't on the platform's noise list. Stored on the payment's
  // import_extra_data JSONB at commit time.
  extra?: Record<string, any>
  issues: CsvIssue[]
}

// S29X-round-3: name-matching helpers for the fallback resolution path
// when a CSV row has no tenant_email (DoorLoop transactions, Square
// transactions). Splits combined-name strings on " & ", " and ", "/"
// (DoorLoop bundles co-tenants this way), and handles "Last, First"
// inversions (AppFolio-style). Each normalized variant is checked
// against the landlord's active-tenant roster.

function normalizeTenantNameForMatch(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
}

function tenantNameVariants(raw: string): string[] {
  const variants = new Set<string>()
  const parts = raw.split(/\s*[&/]\s*|\s+and\s+/i).map(p => p.trim()).filter(Boolean)
  for (const p of parts) {
    variants.add(normalizeTenantNameForMatch(p))
    if (p.includes(',')) {
      const [last, first] = p.split(',').map(s => s.trim())
      if (first && last) variants.add(normalizeTenantNameForMatch(`${first} ${last}`))
    }
    // Strip middle names / initials: "Josh R. Roby" → "Josh Roby".
    const words = p.split(/\s+/).filter(Boolean)
    if (words.length > 2) {
      variants.add(normalizeTenantNameForMatch(`${words[0]} ${words[words.length - 1]}`))
    }
  }
  return Array.from(variants)
}

// Allowed payment types from the source CSV — we normalize aggressive
// platform vocabulary ("Rent Payment", "Receipt — Rent") down to one of
// the four buckets the GAM payments.type CHECK accepts in this import
// path. Refunds / credit memos are out-of-scope for Phase B (Nic can
// adjust manually post-import).
const PAYMENT_TYPE_MAP: Record<string, 'rent' | 'fee' | 'deposit' | 'utility' | 'late_fee'> = {
  rent: 'rent',
  'rent payment': 'rent',
  'monthly rent': 'rent',
  'recurring rent': 'rent',
  // S29X-round-3: DoorLoop transactions use a bare `Payment` Type value;
  // default to rent since that's overwhelmingly the case for inbound
  // tenant payments, and the landlord can correct on preview.
  payment: 'rent',
  monthly: 'rent',
  fee: 'fee',
  fees: 'fee',
  'admin fee': 'fee',
  'application fee': 'fee',
  'pet fee': 'fee',
  'cleaning fee': 'fee',
  deposit: 'deposit',
  'security deposit': 'deposit',
  utility: 'utility',
  utilities: 'utility',
  water: 'utility',
  electric: 'utility',
  gas: 'utility',
  trash: 'utility',
  'late fee': 'late_fee',
  late: 'late_fee',
  latefee: 'late_fee',
}

function normalizePaymentType(raw: string): 'rent' | 'fee' | 'deposit' | 'utility' | 'late_fee' | null {
  const s = raw.trim().toLowerCase()
  if (!s) return 'rent'  // default — the common case
  return PAYMENT_TYPE_MAP[s] ?? null
}

const ENTRY_DESC_BY_TYPE: Record<'rent' | 'fee' | 'deposit' | 'utility' | 'late_fee', string> = {
  rent:     'RENT',
  fee:      'SUBSCRIP',
  deposit:  'DEPOSIT',
  utility:  'UTILITY',
  late_fee: 'LATEFEE',
}

// GET /api/landlords/me/onboard-payment-history-csv/template?source=generic
landlordsRouter.get('/me/onboard-payment-history-csv/template', requirePerm('tenants.create'), async (req, res, next) => {
  try {
    const source = String(req.query.source || 'generic').toLowerCase()
    if (!isCsvImportPlatform(source)) {
      throw new AppError(400, `Unknown source: ${source}`)
    }
    const cfg = getPaymentPlatformConfig(source as CsvImportPlatform)
    if (!cfg?.enabled) {
      throw new AppError(400, `${source} is not yet supported. Pick Generic and map your columns manually for now.`)
    }
    const csv = buildPaymentTemplateCsv(source as CsvImportPlatform)
    const filename = source === 'generic'
      ? 'gam-payment-history-template.csv'
      : `gam-payment-history-template-${source}.csv`
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  } catch (e) { next(e) }
})

// POST /api/landlords/me/onboard-payment-history-csv/validate
landlordsRouter.post('/me/onboard-payment-history-csv/validate', requirePerm('tenants.create'), async (req, res, next) => {
  try {
    const { csv, source, claimedPlatformName } = req.body
    if (!csv) throw new AppError(400, 'csv body required')
    const sourceNorm = String(source || 'generic').toLowerCase()
    if (!isCsvImportPlatform(sourceNorm)) {
      throw new AppError(400, `Unknown source: ${sourceNorm}`)
    }
    const cfg = getPaymentPlatformConfig(sourceNorm as CsvImportPlatform)
    if (!cfg?.enabled) {
      throw new AppError(400, `${sourceNorm} is not yet supported.`)
    }
    // S297: claim meaningful only on generic.
    const claimName = sourceNorm === 'generic' && typeof claimedPlatformName === 'string'
      ? claimedPlatformName.trim() : null

    let records: any[]
    try {
      records = parseCsv(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as any[]
    } catch (e: any) {
      throw new AppError(400, `CSV parse failed: ${e.message}`)
    }
    if (records.length === 0) throw new AppError(400, 'CSV has no data rows')

    // S295: capture raw shape before applyPaymentMapping rewrites
    // column names AND before the Square preprocess hook adds
    // synthesized columns — these don't belong in the review queue.
    const paymentAttemptShape = extractAttemptShape(records)

    records = applyPaymentMapping(records, sourceNorm as CsvImportPlatform)

    const landlordId = req.user!.profileId

    // Pre-load every active-lease tenant in the landlord's portfolio.
    // S29X-round-3: this used to load only the emails referenced in
    // the CSV; expanded to the full roster so the tenant_name fallback
    // path can match without a second round-trip. Volume is small
    // (typically dozens to low-hundreds per landlord).
    type LeaseLookup = {
      email: string
      first_name: string
      last_name: string
      tenant_id: string
      lease_id: string
      unit_id: string
      unit_number: string
      property_name: string
    }
    const leaseLookups: LeaseLookup[] = await query<LeaseLookup>(
      `SELECT lower(u.email)  AS email,
              u.first_name,
              u.last_name,
              t.id            AS tenant_id,
              l.id            AS lease_id,
              l.unit_id       AS unit_id,
              un.unit_number,
              p.name          AS property_name
         FROM users u
         JOIN tenants t        ON t.user_id = u.id
         JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
         JOIN leases l         ON l.id = lt.lease_id AND l.status = 'active'
         JOIN units un         ON un.id = l.unit_id
         JOIN properties p     ON p.id = un.property_id
        WHERE l.landlord_id = $1`,
      [landlordId]
    )

    // Group lookups by email — a tenant may have multiple active
    // leases under this landlord across different units (rare but
    // possible). We'll resolve to the property/unit-matching one if
    // disambiguation columns are present.
    const lookupsByEmail = new Map<string, LeaseLookup[]>()
    for (const row of leaseLookups) {
      if (!row.email) continue
      const arr = lookupsByEmail.get(row.email) || []
      arr.push(row)
      lookupsByEmail.set(row.email, arr)
    }

    // Parallel name index for the tenant_name fallback path. Build
    // every reasonable normalized variant per tenant: "first last",
    // "last first" — match against any variant the CSV produces.
    const lookupsByName = new Map<string, LeaseLookup[]>()
    for (const row of leaseLookups) {
      const first = (row.first_name || '').trim()
      const last  = (row.last_name  || '').trim()
      if (!first && !last) continue
      const variants = new Set<string>()
      if (first && last) {
        variants.add(normalizeTenantNameForMatch(`${first} ${last}`))
        variants.add(normalizeTenantNameForMatch(`${last} ${first}`))
      }
      if (first) variants.add(normalizeTenantNameForMatch(first))
      if (last)  variants.add(normalizeTenantNameForMatch(last))
      for (const v of variants) {
        const arr = lookupsByName.get(v) || []
        arr.push(row)
        lookupsByName.set(v, arr)
      }
    }

    const rows: PaymentCsvRow[] = []

    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      const issues: CsvIssue[] = []

      const row: PaymentCsvRow = {
        rowIndex: i,
        tenantEmail:   String(r.tenant_email   || '').trim().toLowerCase(),
        tenantName:    String(r.tenant_name    || '').trim(),
        paymentDate:   String(r.payment_date   || '').trim(),
        amount:        String(r.amount         || '').trim(),
        paymentType:   String(r.payment_type   || '').trim(),
        paymentMethod: String(r.payment_method || '').trim(),
        propertyName:  String(r.property_name  || '').trim(),
        unitNumber:    String(r.unit_number    || '').trim(),
        reference:     String(r.reference      || '').trim(),
        extra: r._extra,
        issues,
      }

      // Required fields: either email or tenant_name must be present.
      // Email format validated only when supplied (some platforms —
      // DoorLoop transactions, Square — don't export it).
      if (!row.tenantEmail && !row.tenantName) {
        issues.push({ severity: 'block', field: 'tenant_email', message: 'Either tenant_email or tenant_name is required' })
      } else if (row.tenantEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.tenantEmail)) {
        issues.push({ severity: 'block', field: 'tenant_email', message: 'Invalid email format' })
      }

      if (!row.paymentDate) {
        issues.push({ severity: 'block', field: 'payment_date', message: 'Required' })
      } else if (isNaN(Date.parse(row.paymentDate))) {
        issues.push({ severity: 'block', field: 'payment_date', message: 'Invalid date' })
      } else if (Date.parse(row.paymentDate) > Date.now() + 24 * 3600 * 1000) {
        issues.push({ severity: 'warn', field: 'payment_date', message: 'Payment date is in the future' })
      }

      if (!row.amount) {
        issues.push({ severity: 'block', field: 'amount', message: 'Required' })
      } else {
        const amt = parseFloat(row.amount.replace(/[$,\s]/g, ''))
        if (isNaN(amt)) {
          issues.push({ severity: 'block', field: 'amount', message: 'Must be a number' })
        } else if (amt <= 0) {
          // Negative amounts (refunds, credit memos) are out of scope
          // for Phase B — flag as block so landlord can decide manually.
          issues.push({ severity: 'block', field: 'amount', message: 'Must be greater than zero. Refunds/credits are not imported automatically.' })
        }
      }

      // payment_type normalization. Unknown values block — landlord
      // can either fix the source CSV or correct on the preview.
      if (row.paymentType) {
        const normalized = normalizePaymentType(row.paymentType)
        if (normalized === null) {
          issues.push({ severity: 'block', field: 'payment_type', message: `Unknown type "${row.paymentType}". Allowed: rent, fee, deposit, utility, late_fee` })
        }
      }

      // Resolve tenant → lease. Try email first (highest confidence),
      // fall back to tenant_name when email is missing or unmatched.
      // Helper applies the same property/unit disambiguation logic to
      // either candidate set.
      const resolveAgainst = (candidates: LeaseLookup[], via: 'email' | 'name', fieldForBlocker: 'tenant_email' | 'tenant_name'): boolean => {
        if (candidates.length === 1) {
          const m = candidates[0]
          row.resolvedTenantId = m.tenant_id
          row.resolvedLeaseId  = m.lease_id
          row.resolvedUnitId   = m.unit_id
          row.resolvedVia      = via
          if (row.propertyName && m.property_name.trim().toLowerCase() !== row.propertyName.toLowerCase()) {
            issues.push({ severity: 'warn', field: 'property_name', message: `Source CSV says "${row.propertyName}" but the resolved lease is at "${m.property_name}". Using the resolved lease.` })
          }
          if (row.unitNumber && String(m.unit_number).trim().toLowerCase() !== row.unitNumber.toLowerCase()) {
            issues.push({ severity: 'warn', field: 'unit_number', message: `Source CSV says unit "${row.unitNumber}" but the resolved lease is at unit "${m.unit_number}". Using the resolved lease.` })
          }
          return true
        }
        let narrowed = candidates
        if (row.propertyName) {
          narrowed = narrowed.filter(c => c.property_name.trim().toLowerCase() === row.propertyName.toLowerCase())
        }
        if (narrowed.length > 1 && row.unitNumber) {
          narrowed = narrowed.filter(c => String(c.unit_number).trim().toLowerCase() === row.unitNumber.toLowerCase())
        }
        if (narrowed.length === 1) {
          const m = narrowed[0]
          row.resolvedTenantId = m.tenant_id
          row.resolvedLeaseId  = m.lease_id
          row.resolvedUnitId   = m.unit_id
          row.resolvedVia      = via
          return true
        }
        issues.push({ severity: 'block', field: fieldForBlocker, message: `Tenant resolved to ${candidates.length} active leases. Add property_name + unit_number columns to disambiguate.` })
        return false
      }

      let resolved = false
      if (row.tenantEmail) {
        const candidates = lookupsByEmail.get(row.tenantEmail) || []
        if (candidates.length > 0) {
          resolved = resolveAgainst(candidates, 'email', 'tenant_email')
        }
      }

      // Name fallback when email path didn't resolve. Try every variant
      // the CSV's name string yields (combined-name split, comma-flip).
      // First variant that produces a candidate set wins.
      if (!resolved && row.tenantName) {
        const variants = tenantNameVariants(row.tenantName)
        let nameCandidates: LeaseLookup[] = []
        for (const v of variants) {
          const hits = lookupsByName.get(v) || []
          if (hits.length > 0) {
            nameCandidates = hits
            break
          }
        }
        if (nameCandidates.length > 0) {
          resolved = resolveAgainst(nameCandidates, 'name', 'tenant_name')
        }
      }

      if (!resolved && (row.tenantEmail || row.tenantName) && issues.every(it => it.field !== 'tenant_email' && it.field !== 'tenant_name')) {
        // Neither path resolved and no disambiguation blocker was added.
        // The tenant simply isn't in the portfolio.
        const identifier = row.tenantEmail || row.tenantName
        issues.push({ severity: 'block', field: row.tenantEmail ? 'tenant_email' : 'tenant_name', message: `No active lease found for "${identifier}" in your portfolio. Onboard the tenant first.` })
      }

      rows.push(row)
    }

    const blockers = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'block').length, 0)
    const warnings = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'warn').length, 0)
    const ready = rows.filter(r => !r.issues.some(i => i.severity === 'block')).length

    // S295: persist the validate attempt to the review queue.
    await recordValidateAttempt({
      landlordId,
      importType:    'payment',
      platformKey:   sourceNorm,
      columnHeaders: paymentAttemptShape.columnHeaders,
      sampleRows:    paymentAttemptShape.sampleRows,
      rowCount:      rows.length,
      blockers,
      warnings,
      claimedPlatformName: claimName,
    })
    await notifyCsvReviewPendingIfNeeded({
      landlordId, importType: 'payment', platformKey: sourceNorm,
      source: 'validate', claimedPlatformName: claimName,
    })

    res.json({
      success: true,
      data: {
        rows,
        summary: { total: rows.length, blockers, warnings, ready },
      },
    })
  } catch (e) { next(e) }
})

// POST /api/landlords/me/onboard-payment-history-csv/commit
// Body: { rows: PaymentCsvRow[], source: CsvImportPlatform }
landlordsRouter.post('/me/onboard-payment-history-csv/commit', requirePerm('payments.import_history'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { rows, source, claimedPlatformName } = req.body
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(400, 'rows array required')
    }
    const sourceNorm = String(source || 'generic').toLowerCase()
    if (!isCsvImportPlatform(sourceNorm)) {
      throw new AppError(400, `Unknown source: ${sourceNorm}`)
    }
    // S297: generic commit requires the claim.
    const paymentClaimName = sourceNorm === 'generic' && typeof claimedPlatformName === 'string'
      ? claimedPlatformName.trim() : ''
    if (sourceNorm === 'generic' && !paymentClaimName) {
      throw new AppError(400, 'claimedPlatformName is required for generic uploads')
    }

    const landlordId = req.user!.profileId

    // Defense in depth: every row must have resolved IDs and zero blockers.
    for (const row of rows as PaymentCsvRow[]) {
      const blockers = (row.issues || []).filter(i => i.severity === 'block')
      if (blockers.length > 0) {
        throw new AppError(400, `Row ${row.rowIndex + 1} still has blockers: ${blockers.map(b => b.message).join(', ')}`)
      }
      if (!row.resolvedTenantId || !row.resolvedLeaseId || !row.resolvedUnitId) {
        throw new AppError(400, `Row ${row.rowIndex + 1} is missing resolved lease info`)
      }
    }

    // Re-verify all referenced leases belong to this landlord.
    const leaseIds = Array.from(new Set((rows as PaymentCsvRow[]).map(r => r.resolvedLeaseId!) ))
    const ownedLeases = await query<any>(
      `SELECT id FROM leases WHERE id = ANY($1::uuid[]) AND landlord_id = $2`,
      [leaseIds, landlordId]
    )
    const ownedSet = new Set(ownedLeases.map(l => l.id))
    for (const row of rows as PaymentCsvRow[]) {
      if (!ownedSet.has(row.resolvedLeaseId!)) {
        throw new AppError(403, `Row ${row.rowIndex + 1} references a lease not owned by this landlord`)
      }
    }

    await client.query('BEGIN')

    let committed = 0
    for (const row of rows as PaymentCsvRow[]) {
      const amt = parseFloat(row.amount.replace(/[$,\s]/g, ''))
      const paymentType = (normalizePaymentType(row.paymentType) || 'rent') as 'rent' | 'fee' | 'deposit' | 'utility' | 'late_fee'
      const entryDesc = ENTRY_DESC_BY_TYPE[paymentType]

      // Build a notes blob carrying source-platform breadcrumbs that
      // don't fit elsewhere on the row.
      const notesParts: string[] = []
      if (row.paymentMethod) notesParts.push(`method: ${row.paymentMethod}`)
      if (row.reference)     notesParts.push(`ref: ${row.reference}`)
      const notes = notesParts.length > 0
        ? `Imported from ${sourceNorm}. ${notesParts.join(' | ')}`
        : `Imported from ${sourceNorm}.`

      await client.query(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, entry_description, amount, status,
           due_date, settled_at, processed_at,
           notes,
           import_source, imported_at,
           import_extra_data
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, 'settled',
           $8::date, $8::date, $8::date,
           $9,
           $10, NOW(),
           $11
         )`,
        [
          landlordId, row.resolvedTenantId, row.resolvedLeaseId, row.resolvedUnitId,
          paymentType, entryDesc, amt.toFixed(2),
          row.paymentDate,
          notes,
          sourceNorm,
          row.extra && Object.keys(row.extra).length > 0
            ? JSON.stringify(row.extra) : null,
        ]
      )
      committed++
    }

    await client.query('COMMIT')

    // S295: record commit + compute first-5 position for banner.
    await recordCommitAttempt({
      landlordId,
      importType:  'payment',
      platformKey: sourceNorm,
      columnHeaders: [],
      sampleRows:    [],
      rowCount:      committed,
      claimedPlatformName: paymentClaimName || null,
    })
    await notifyCsvReviewPendingIfNeeded({
      landlordId, importType: 'payment', platformKey: sourceNorm,
      source: 'commit', claimedPlatformName: paymentClaimName || null,
    })
    const paymentStatus = await getPlatformReviewStatus(sourceNorm, 'payment')

    res.json({
      success: true,
      data: {
        committed,
        escalateToSuperAdmin: paymentStatus.escalateToSuperAdmin,
        mappingStatus:        paymentStatus.mappingStatus,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})


// ── GET /api/landlords/me/email-failures ──────────────────────────────────
// S101: list recent failed email sends attributed to this landlord. Backed by
// email_send_log; populated by services/email.ts:send() on every attempt.
// S168: per-landlord coverage is now broad — every active sender threads
// ctx.landlordId (audit confirmed in S168 bonus 2). The S101 "currently:
// emailTenantOnboarded" caveat is no longer accurate; left a one-liner
// instead of a stale narrowing claim.
// S131: stays requireLandlord. Email-failure visibility is admin-ops
// territory; opening to PMs would need a new perm and a clearer product
// call about who handles bounce remediation. Defer.
landlordsRouter.get('/me/email-failures', requireLandlord, async (req: any, res, next) => {
  try {
    const landlordId = req.user!.profileId
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)
    const sinceDays = Math.min(Math.max(parseInt(String(req.query.since_days ?? '30'), 10) || 30, 1), 365)

    const rows = await query<any>(`
      SELECT id, to_email, subject, category, error_message,
             related_entity_type, related_entity_id, metadata, created_at
        FROM email_send_log
       WHERE landlord_id = $1
         AND status = 'failed'
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
       ORDER BY created_at DESC
       LIMIT $3
    `, [landlordId, sinceDays, limit])

    res.json({ success: true, data: { rows, limit, sinceDays } })
  } catch (e) { next(e) }
})

// ── GET /api/landlords/me/pm-impact ───────────────────────────────────────
// S110: per-property breakdown of "rent collected / PM cut / your net" for
// the calling landlord, for a given date window. Window defaults to the
// current calendar month. Drives the landlord-portal "your properties
// under PM" dashboard card.
// S131: stays requireLandlord — this is the OWNER's view of what their
// PM company is taking from them. Showing "what your manager costs you"
// to the manager themselves would be the opposite of the intended
// audience.
landlordsRouter.get('/me/pm-impact', requireLandlord, async (req: any, res, next) => {
  try {
    const landlordId = req.user!.profileId
    const isISODate = (v: unknown): v is string =>
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    const fromQ = req.query.from
    const toQ   = req.query.to
    if (fromQ !== undefined && !isISODate(fromQ)) throw new AppError(400, 'from must be YYYY-MM-DD')
    if (toQ   !== undefined && !isISODate(toQ))   throw new AppError(400, 'to must be YYYY-MM-DD')
    const from = isISODate(fromQ) ? fromQ : null
    const to   = isISODate(toQ)   ? toQ   : null

    // Aggregate ledger entries per property in the window.
    // owner_share + manager_fee + pm_company_fee come from rent payments
    // referenced via reference_id; sum the absolute amounts per property.
    const params: any[] = [landlordId]
    let dateClause = ''
    if (from) { params.push(from); dateClause += ` AND ubl.created_at >= $${params.length}::date` }
    if (to)   { params.push(to);   dateClause += ` AND ubl.created_at <  ($${params.length}::date + INTERVAL '1 day')` }

    const rows = await query<any>(`
      SELECT
        p.id              AS property_id,
        p.name            AS property_name,
        p.pm_company_id,
        c.name            AS pm_company_name,
        p.pm_fee_plan_id,
        fp.name           AS pm_fee_plan_name,
        fp.fee_type       AS pm_fee_type,
        COALESCE(SUM(CASE WHEN ubl.type = 'allocation_owner_share'     THEN ubl.amount END), 0) AS owner_net,
        COALESCE(SUM(CASE WHEN ubl.type = 'allocation_pm_company_fee'  THEN ubl.amount END), 0) AS pm_company_cut,
        COALESCE(SUM(CASE WHEN ubl.type = 'allocation_manager_fee'     THEN ubl.amount END), 0) AS in_house_manager_fee,
        COALESCE(SUM(CASE WHEN ubl.type IN ('allocation_owner_share', 'allocation_pm_company_fee', 'allocation_manager_fee') THEN ubl.amount END), 0) AS total_split,
        COUNT(DISTINCT ubl.reference_id) FILTER (WHERE ubl.type = 'allocation_owner_share') AS payment_count
      FROM properties p
 LEFT JOIN pm_companies  c  ON c.id  = p.pm_company_id
 LEFT JOIN pm_fee_plans  fp ON fp.id = p.pm_fee_plan_id
 LEFT JOIN user_balance_ledger ubl
        ON ubl.property_id = p.id
       AND ubl.reference_type = 'payment'
       AND ubl.type IN ('allocation_owner_share', 'allocation_pm_company_fee', 'allocation_manager_fee')
       ${dateClause}
     WHERE p.landlord_id = $1
     GROUP BY p.id, p.name, p.pm_company_id, c.name, p.pm_fee_plan_id, fp.name, fp.fee_type
     ORDER BY p.name ASC
    `, params)

    res.json({ success: true, data: { rows, from, to } })
  } catch (e) { next(e) }
})

// ── S118: GAM-native dashboard endpoints (no embedded Stripe components) ──
//
// Per the locked S113 architecture: GAM hosts its own dashboard for
// payouts / disputes / payment history rather than embedding Stripe's
// `<ConnectPayouts />` / `<ConnectAccountManagement />`. These routes
// serve the data the landlord portal renders. The only Stripe-branded
// surface a landlord ever sees is the one-time `<ConnectAccountOnboarding />`
// component (S115).

// GET /api/landlords/me/payouts — paginated list of Stripe Payouts that
// fired against the calling landlord's Connect account, with
// arrival_date / status / failure context for the UI.
// S126: swapped requireLandlord → requirePerm('payments.view_all') so
// property managers + onsite managers with the perm can also view.
// Owners (landlord/admin/super_admin) auto-pass via requirePerm's
// OWNER_ROLES short-circuit. Landlord-id resolution handles both
// owner profileId and team-worker landlordId claim.
landlordsRouter.get('/me/payouts', requirePerm('payments.view_all'), async (req: any, res, next) => {
  try {
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

    const u = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id=$1`, [landlordId]
    )
    if (!u) throw new AppError(404, 'Landlord not found')

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)
    const status = typeof req.query.status === 'string' ? req.query.status : null

    const params: any[] = [u.user_id]
    let statusClause = ''
    if (status) { params.push(status); statusClause = `AND status = $${params.length}` }
    params.push(limit)

    const rows = await query<any>(`
      SELECT id, stripe_payout_id, amount, currency, status,
             destination_bank_last4, arrival_date, failure_code, failure_message,
             created_at, updated_at
        FROM connect_payouts
       WHERE user_id = $1 ${statusClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}
    `, params)

    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/landlords/me/disputes — pending + recent disputes attributed
// to the calling landlord. Sorted with response-needed first by due date.
// S126: read-only view opens to team workers with `payments.view_all`.
// Submitting evidence (POST /respond below) stays landlord-only — that's
// a legal/financial action.
landlordsRouter.get('/me/disputes', requirePerm('payments.view_all'), async (req: any, res, next) => {
  try {
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)
    const onlyPending = req.query.pending === 'true'

    const params: any[] = [landlordId]
    let pendingClause = ''
    if (onlyPending) {
      // S358 fix: alias `d.status` explicitly — the JOIN to payments p
      // also exposes a `status` column, and the bare `status` reference
      // crashed with "column reference 'status' is ambiguous" on every
      // pending=true call.
      pendingClause = `AND d.status IN ('warning_needs_response', 'needs_response')`
    }
    params.push(limit)

    const rows = await query<any>(`
      SELECT d.id, d.stripe_dispute_id, d.stripe_charge_id, d.payment_id,
             d.amount, d.currency, d.reason, d.status,
             d.evidence_due_by, d.evidence_submitted_at, d.outcome, d.outcome_at,
             d.created_at, d.updated_at,
             p.entry_description, p.due_date,
             u.unit_number, pr.name AS property_name
        FROM connect_disputes d
        LEFT JOIN payments p ON p.id = d.payment_id
        LEFT JOIN units u ON u.id = p.unit_id
        LEFT JOIN properties pr ON pr.id = u.property_id
       WHERE d.landlord_id = $1 ${pendingClause}
       ORDER BY
         CASE d.status WHEN 'needs_response' THEN 1
                       WHEN 'warning_needs_response' THEN 2
                       ELSE 3 END,
         d.evidence_due_by ASC NULLS LAST,
         d.created_at DESC
       LIMIT $${params.length}
    `, params)

    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/landlords/me/disputes/:id/respond — submit response evidence
// to Stripe. Body is a free-form record matching Stripe's dispute.evidence
// shape (uncategorized_text, customer_communication, receipt, etc.).
// We accept any string-keyed record and pass through to stripe.disputes.update.
// On success: stamp evidence_submitted_at + response_notes locally.
// S126/S131: stays requireLandlord. Read endpoints (/me/disputes,
// /me/payouts) opened to payments.view_all in S126; submitting evidence
// to Stripe is a legal/financial action that stays owner-only.
landlordsRouter.post('/me/disputes/:id/respond', requireLandlord, async (req: any, res, next) => {
  try {
    const body = z.object({
      evidence:        z.record(z.string()).default({}),
      response_notes:  z.string().max(2000).optional(),
    }).parse(req.body)

    const dispute = await queryOne<{ stripe_dispute_id: string; status: string }>(
      `SELECT stripe_dispute_id, status FROM connect_disputes WHERE id=$1 AND landlord_id=$2`,
      [req.params.id, req.user!.profileId]
    )
    if (!dispute) throw new AppError(404, 'Dispute not found')
    if (dispute.status !== 'needs_response' && dispute.status !== 'warning_needs_response') {
      throw new AppError(409, `Cannot submit evidence on a ${dispute.status} dispute`)
    }

    const stripe = (await import('../lib/stripe')).getStripe()
    await stripe.disputes.update(dispute.stripe_dispute_id, {
      evidence: body.evidence,
    })

    await query(
      `UPDATE connect_disputes
          SET evidence_submitted_at = NOW(),
              response_notes        = $1,
              updated_at            = NOW()
        WHERE id = $2`,
      [body.response_notes ?? null, req.params.id]
    )

    res.json({ success: true, data: { id: req.params.id, evidenceSubmittedAt: new Date().toISOString() } })
  } catch (e) { next(e) }
})

// GET /api/landlords/me/payments-history — joined view of rent payments
// (stripe_payment_intent_id) and the Stripe payouts that arrived for them.
// Drives the landlord-portal "rent collected → arrived in your bank" timeline.
// Two queries unioned: settled rent payments (with PI id), and Connect
// payouts (with arrival_date). Frontend stitches them visually.
// S126: payments-history opens to team workers with `payments.view_all`.
// Same posture as /me/payouts and /me/disputes (read).
landlordsRouter.get('/me/payments-history', requirePerm('payments.view_all'), async (req: any, res, next) => {
  try {
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

    const u = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id=$1`, [landlordId]
    )
    if (!u) throw new AppError(404, 'Landlord not found')

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)

    const charges = await query<any>(`
      SELECT 'charge' AS kind, p.id, p.amount, p.status, p.entry_description,
             p.stripe_payment_intent_id, p.due_date, p.settled_at, p.created_at,
             un.unit_number, pr.name AS property_name,
             tu.first_name AS tenant_first, tu.last_name AS tenant_last
        FROM payments p
        LEFT JOIN units un ON un.id = p.unit_id
        LEFT JOIN properties pr ON pr.id = un.property_id
        LEFT JOIN tenants t ON t.id = p.tenant_id
        LEFT JOIN users tu ON tu.id = t.user_id
       WHERE p.landlord_id = $1
         AND p.stripe_payment_intent_id IS NOT NULL
       ORDER BY p.created_at DESC
       LIMIT $2
    `, [landlordId, limit])

    const payouts = await query<any>(`
      SELECT 'payout' AS kind, id, amount, status,
             stripe_payout_id, destination_bank_last4,
             arrival_date, failure_code, failure_message,
             created_at, updated_at
        FROM connect_payouts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2
    `, [u.user_id, limit])

    res.json({ success: true, data: { charges, payouts } })
  } catch (e) { next(e) }
})


// ─────────────────────────────────────────────────────────────
// OTP (On-Time Pay) — landlord rent advance product (S155)
// Hidden until rollout via system_features.otp_rollout_visible +
// landlords.otp_rollout_enabled.
// ─────────────────────────────────────────────────────────────

// GET /api/landlords/me/otp/visibility — UI gates on this
landlordsRouter.get('/me/otp/visibility', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { isOtpVisibleForLandlord } = await import('../services/otp')
    const visible = await isOtpVisibleForLandlord(req.user!.profileId)
    res.json({ success: true, data: { visible } })
  } catch (e) { next(e) }
})

// GET /api/landlords/me/otp/eligible-tenants — landlord's tenants + qualification
landlordsRouter.get('/me/otp/eligible-tenants', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { isOtpVisibleForLandlord, getQualificationStatus } = await import('../services/otp')
    const visible = await isOtpVisibleForLandlord(req.user!.profileId)
    if (!visible) throw new AppError(403, 'OTP not enabled')

    const tenants = await query<any>(`
      SELECT DISTINCT t.id, u.first_name, u.last_name, u.email,
             un.unit_number, p.name AS property_name,
             t.on_time_pay_enrolled, t.otp_disqualified_until
        FROM tenants t
        JOIN users u ON u.id = t.user_id
        JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status='active'
        JOIN leases l ON l.id = lt.lease_id AND l.status IN ('active','pending')
        JOIN units un ON un.id = l.unit_id
        JOIN properties p ON p.id = un.property_id
       WHERE l.landlord_id = $1
       ORDER BY u.last_name, u.first_name`,
      [req.user!.profileId])

    const enriched = await Promise.all(tenants.map(async (t: any) => {
      const status = await getQualificationStatus(t.id)
      return { ...t, qualification: status }
    }))
    res.json({ success: true, data: enriched })
  } catch (e) { next(e) }
})

// POST /api/landlords/me/otp/tenants/:tenantId/enable
landlordsRouter.post('/me/otp/tenants/:tenantId/enable', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { enableOtpForTenant } = await import('../services/otp')
    const result = await enableOtpForTenant({
      tenantId: req.params.tenantId,
      landlordId: req.user!.profileId,
      enabledByUserId: req.user!.userId,
    })
    if (!result.ok) throw new AppError(400, result.reason)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/landlords/me/otp/tenants/:tenantId/disable
landlordsRouter.post('/me/otp/tenants/:tenantId/disable', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const reason = (req.body?.reason as string | undefined) || 'landlord_initiated'
    const { disableOtpForTenant, isOtpVisibleForLandlord } = await import('../services/otp')
    const visible = await isOtpVisibleForLandlord(req.user!.profileId)
    if (!visible) throw new AppError(403, 'OTP not enabled')
    await disableOtpForTenant({
      tenantId: req.params.tenantId,
      landlordId: req.user!.profileId,
      reason,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/landlords/me/otp/advances — recent advance history
landlordsRouter.get('/me/otp/advances', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { isOtpVisibleForLandlord } = await import('../services/otp')
    const visible = await isOtpVisibleForLandlord(req.user!.profileId)
    if (!visible) throw new AppError(403, 'OTP not enabled')

    const rows = await query<any>(`
      SELECT a.id, a.cycle_month, a.tenant_id, a.unit_id,
             a.rent_amount, a.fee_amount, a.advance_amount,
             a.status, a.advanced_at, a.reconciled_at, a.defaulted_at,
             a.default_reason,
             u.first_name, u.last_name,
             un.unit_number, p.name AS property_name
        FROM otp_advances a
        JOIN tenants t ON t.id = a.tenant_id
        JOIN users u ON u.id = t.user_id
        JOIN units un ON un.id = a.unit_id
        JOIN properties p ON p.id = un.property_id
       WHERE a.landlord_id = $1
       ORDER BY a.cycle_month DESC, a.created_at DESC
       LIMIT 100`,
      [req.user!.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── S157: pm_property_invitations — owner-side endpoints ──────────────────
//
// PM-side endpoints live in routes/pm.ts. Same business logic in services/pm.ts.

const PM_PROPERTY_INVITE_ACCEPT_URL_BASE_LL = process.env.PM_PROPERTY_INVITE_ACCEPT_URL_BASE
  || `${process.env.LANDLORD_APP_URL || 'http://localhost:3001'}/pm-property-invitations/accept`

function buildPropertyInviteAcceptUrlLL(token: string): string {
  return `${PM_PROPERTY_INVITE_ACCEPT_URL_BASE_LL}?token=${encodeURIComponent(token)}`
}

// PATCH /api/landlords/me/default-pm-company — set/clear landlord-level default
landlordsRouter.patch('/me/default-pm-company', requirePerm('settings.default_pm_company'), async (req: any, res, next) => {
  try {
    const body = z.object({
      pmCompanyId: z.string().uuid().nullable(),
    }).parse(req.body)

    if (body.pmCompanyId) {
      const c = await queryOne<{ status: string }>(
        `SELECT status FROM pm_companies WHERE id=$1`, [body.pmCompanyId]
      )
      if (!c) throw new AppError(404, 'PM company not found')
      if (c.status !== 'active') throw new AppError(400, 'PM company is not active')
    }

    const updated = await queryOne(
      `UPDATE landlords SET default_pm_company_id=$1 WHERE id=$2
       RETURNING id, default_pm_company_id`,
      [body.pmCompanyId, req.user!.profileId]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/landlords/me/linked-pm-companies — distinct pm_companies currently
// set as pm_company_id on any of this landlord's properties. Drives the
// default-PM picker (you can only default to a PM you've already linked).
landlordsRouter.get('/me/linked-pm-companies', requireLandlord, async (req: any, res, next) => {
  try {
    const rows = await query(`
      SELECT c.id, c.name, c.business_email, c.status,
             COUNT(p.id)::int AS property_count
        FROM pm_companies c
        JOIN properties p ON p.pm_company_id = c.id
       WHERE p.landlord_id = $1
       GROUP BY c.id, c.name, c.business_email, c.status
       ORDER BY c.name ASC
    `, [req.user!.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/landlords/me/pm-property-invitations — owner sends owner_to_pm invite
landlordsRouter.post('/me/pm-property-invitations', requirePerm('pm_invitations.send'), async (req: any, res, next) => {
  try {
    const body = z.object({
      pmCompanyId:       z.string().uuid(),
      propertyId:        z.string().uuid(),
      invitedEmail:      z.string().email().max(255),
      proposedScope:     z.enum(PM_LINK_SCOPES).default('manage'),
      proposedFeePlanId: z.string().uuid().nullish(),
    }).parse(req.body)

    const feePlanId = body.proposedScope === 'manage' ? (body.proposedFeePlanId ?? null) : null

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { invitationId, token } = await sendPropertyInvitation({
        client,
        direction: 'owner_to_pm',
        pmCompanyId: body.pmCompanyId,
        propertyId: body.propertyId,
        landlordId: req.user!.profileId,
        invitedEmail: body.invitedEmail,
        invitedByUserId: req.user!.userId,
        proposedScope: body.proposedScope,
        proposedFeePlanId: feePlanId,
      })
      await client.query('COMMIT')

      const ctxRow = await queryOne<{ pm_company_name: string; property_name: string; inviter_name: string }>(
        `SELECT c.name AS pm_company_name,
                p.name AS property_name,
                COALESCE(u.first_name || ' ' || u.last_name, u.email) AS inviter_name
           FROM pm_companies c, properties p, users u
          WHERE c.id=$1 AND p.id=$2 AND u.id=$3`,
        [body.pmCompanyId, body.propertyId, req.user!.userId]
      )
      if (ctxRow) {
        try {
          await emailPmPropertyInvitation({
            to: body.invitedEmail,
            direction: 'owner_to_pm',
            inviterName: ctxRow.inviter_name,
            pmCompanyName: ctxRow.pm_company_name,
            propertyName: ctxRow.property_name,
            proposedScope: body.proposedScope,
            acceptUrl: buildPropertyInviteAcceptUrlLL(token),
            ctx: {
              pmCompanyId: body.pmCompanyId,
              invitationId,
              landlordId: req.user!.profileId,
            },
          })
        } catch (mailErr) {
          logger.error({ err: mailErr }, '[PM PROPERTY INVITE EMAIL FAILED]')
        }
      }

      res.status(201).json({ success: true, data: { invitation_id: invitationId } })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// GET /api/landlords/me/pm-property-invitations — list invitations for this landlord
landlordsRouter.get('/me/pm-property-invitations', requireLandlord, async (req: any, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : null
    const params: any[] = [req.user!.profileId]
    let statusClause = ''
    if (status) { params.push(status); statusClause = `AND i.status = $${params.length}` }

    const rows = await query(`
      SELECT i.id, i.direction, i.pm_company_id, i.property_id, i.invited_email,
             i.proposed_scope, i.proposed_fee_plan_id, i.status,
             i.expires_at, i.accepted_at, i.rejected_at, i.rejected_reason,
             i.revoked_at, i.replaced_pm_company_id, i.created_at,
             c.name AS pm_company_name,
             p.name AS property_name,
             fp.name AS fee_plan_name, fp.fee_type AS fee_plan_type
        FROM pm_property_invitations i
        JOIN pm_companies c  ON c.id = i.pm_company_id
        JOIN properties   p  ON p.id = i.property_id
   LEFT JOIN pm_fee_plans fp ON fp.id = i.proposed_fee_plan_id
       WHERE i.landlord_id = $1 ${statusClause}
       ORDER BY i.created_at DESC
    `, params)

    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/landlords/me/pm-property-invitations/:invId/accept — owner accepts pm_to_owner
landlordsRouter.post('/me/pm-property-invitations/:invId/accept', requirePerm('pm_invitations.respond'), async (req: any, res, next) => {
  try {
    const body = z.object({ replace: z.boolean().default(false) }).parse(req.body ?? {})

    const inv = await queryOne<{ direction: string; token: string; landlord_id: string }>(
      `SELECT direction, token, landlord_id
         FROM pm_property_invitations
        WHERE id = $1`,
      [req.params.invId]
    )
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'Invitation does not belong to this landlord')
    }
    if (inv.direction !== 'pm_to_owner') {
      throw new AppError(400, 'Only pm_to_owner invitations can be accepted by owner')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const result = await acceptPropertyInvitation({
        client, token: inv.token, acceptingUserId: req.user!.userId, replace: body.replace,
      })
      await client.query('COMMIT')
      res.json({ success: true, data: result })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// POST /api/landlords/me/pm-property-invitations/:invId/reject — owner rejects pm_to_owner
landlordsRouter.post('/me/pm-property-invitations/:invId/reject', requirePerm('pm_invitations.respond'), async (req: any, res, next) => {
  try {
    const body = z.object({ reason: z.string().max(500).nullish() }).parse(req.body ?? {})

    const inv = await queryOne<{ direction: string; token: string; landlord_id: string }>(
      `SELECT direction, token, landlord_id
         FROM pm_property_invitations
        WHERE id = $1`,
      [req.params.invId]
    )
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'Invitation does not belong to this landlord')
    }
    if (inv.direction !== 'pm_to_owner') {
      throw new AppError(400, 'Only pm_to_owner invitations can be rejected by owner')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const result = await rejectPropertyInvitation(client, inv.token, body.reason ?? null)
      await client.query('COMMIT')
      res.json({ success: true, data: result })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// DELETE /api/landlords/me/pm-property-invitations/:invId — owner revokes own owner_to_pm invite
landlordsRouter.delete('/me/pm-property-invitations/:invId', requirePerm('pm_invitations.send'), async (req: any, res, next) => {
  try {
    const inv = await queryOne<{ direction: string; landlord_id: string }>(
      `SELECT direction, landlord_id
         FROM pm_property_invitations
        WHERE id = $1`,
      [req.params.invId]
    )
    if (!inv) throw new AppError(404, 'Invitation not found')
    if (inv.landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'Invitation does not belong to this landlord')
    }
    if (inv.direction !== 'owner_to_pm') {
      throw new AppError(400, 'Only owner-sent invitations can be revoked here')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await revokePropertyInvitation(client, req.params.invId, req.user!.userId)
      await client.query('COMMIT')
      res.json({ success: true })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ── S605 (Nic): CO-OWNER INVITATIONS ────────────────────────────────────────
//
// Invite a partner by email. They accept, register if they need to, and land as
// an owner-member of this entity — WITHOUT their own business being folded into
// it. That separation is the whole reason this is an invite rather than a
// shared login: "I don't necessarily need to be part of his other operation."
const CO_OWNER_INVITE_TTL_DAYS = 7

async function createCoOwnerInvitation(landlordId: string, email: string, invitedByUserId: string) {
  const entity = await queryOne<{ business_name: string | null; user_id: string }>(
    `SELECT business_name, user_id FROM landlords WHERE id = $1`, [landlordId])
  if (!entity) throw new AppError(404, 'Entity not found')
  const inviter = await queryOne<{ first_name: string | null; last_name: string | null }>(
    `SELECT first_name, last_name FROM users WHERE id = $1`, [invitedByUserId])

  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const expiresAt = new Date(Date.now() + CO_OWNER_INVITE_TTL_DAYS * 86400_000).toISOString()

  // Re-inviting refreshes the live invite rather than leaving two valid tokens
  // out for the same person (the partial unique index enforces one pending).
  const row = await queryOne<{ id: string }>(
    `INSERT INTO landlord_member_invitations
       (landlord_id, email, invited_by_user_id, token, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (landlord_id, lower(email)) WHERE status = 'pending'
     DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at,
                   invited_by_user_id = EXCLUDED.invited_by_user_id, updated_at = now()
     RETURNING id`,
    [landlordId, email.trim(), invitedByUserId, token, expiresAt])

  const inviterName = [inviter?.first_name, inviter?.last_name].filter(Boolean).join(' ').trim() || 'A GAM landlord'
  const base = (process.env.LANDLORD_APP_URL || 'https://landlord.goldassetmanagement.com').replace(/\/$/, '')
  await emailLandlordCoOwnerInvitation(
    // S620: the fallback used to be 'a property on GAM', and the subject line
    // already ends in "on GAM" — so an entity with no business name produced
    // "added you as an owner of a property on GAM on GAM".
    email.trim(), inviterName, entity.business_name || 'a property',
    `${base}/accept-owner-invite/${token}`,
    { landlordId, invitationId: row!.id },
  ).catch(() => { /* the invite row stands; it can be resent */ })
  return row!
}


// POST /api/landlords/member-invite/:token/accept — requires the invitee to be
// signed in as a landlord (registering through the invite link gets them there).
landlordsRouter.post('/member-invite/:token/accept', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'landlord') throw new AppError(403, 'Co-owners need a landlord account')
    const inv = await queryOne<any>(
      `SELECT id, landlord_id, email, expires_at, status
         FROM landlord_member_invitations WHERE token = $1`, [req.params.token])
    if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) {
      throw new AppError(404, 'That invitation has expired or already been used.')
    }
    // The invite is addressed to a person, not a link-holder: accepting from a
    // different account would silently attach the wrong business.
    const me = await queryOne<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [u.userId])
    if ((me?.email ?? '').toLowerCase() !== String(inv.email).toLowerCase()) {
      throw new AppError(403, 'This invitation was sent to a different email address. Sign in with that address to accept it.')
    }

    await query(
      `INSERT INTO landlord_members (landlord_id, user_id, role, added_by_user_id)
       VALUES ($1, $2, 'owner', $3) ON CONFLICT (landlord_id, user_id) DO NOTHING`,
      [inv.landlord_id, u.userId, inv.invited_by_user_id ?? null])
    await query(
      `UPDATE landlord_member_invitations
          SET status='accepted', accepted_at=now(), accepted_user_id=$2, updated_at=now()
        WHERE id=$1`, [inv.id, u.userId])

    // S605 (Nic): "for him to just register, it would have tried to get him to
    // onboard his property, which is already onboarded because I've completed
    // Oak Park." The portal sends any landlord with onboarding_complete = false
    // to the wizard — so an invited co-owner would land in a five-step flow
    // asking for a first property, a payout account and a signed agreement for
    // an entity that owns nothing, to reach a property somebody else already
    // set up.
    //
    // Clearing the flag on their OWN entity lets them straight in. Guarded on
    // having no properties of their own, so this can never skip a real
    // onboarding: a landlord who already has property keeps whatever state they
    // were in. If they add their first property later, the dashboard's standing
    // tasks (Connect KYC, connect your operating bank) surface what's needed —
    // those are the gates that matter before money can move.
    await query(
      `UPDATE landlords SET onboarding_complete = TRUE
        WHERE id = $1
          AND onboarding_complete = FALSE
          AND NOT EXISTS (SELECT 1 FROM properties WHERE landlord_id = $1)`,
      [u.profileId])

    // landlordIds is stamped into the JWT at login, so the new entity appears
    // once they re-authenticate. Say so rather than letting them wonder why the
    // property isn't there yet.
    res.json({ success: true, data: { landlordId: inv.landlord_id, reloginRequired: true } })
  } catch (e) { next(e) }
})
