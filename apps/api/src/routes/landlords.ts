import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireAdmin, requireLandlord, requirePerm } from '../middleware/auth'
import { resolveLandlordIdForUser } from '../lib/scope'
import { canAccessLandlordResource, canViewLandlordFinances } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { emailTenantOnboarded } from '../services/email'
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
import { AUTO_RENEW_MODES, PM_LINK_SCOPES, formatInvoiceNumber } from '@gam/shared'
import { emailPmPropertyInvitation } from '../services/email'
import {
  sendPropertyInvitation, acceptPropertyInvitation,
  rejectPropertyInvitation, revokePropertyInvitation,
} from '../services/pm'
import { logger } from '../lib/logger'
import {
  recordValidateAttempt,
  recordCommitAttempt,
  getPlatformReviewStatus,
  extractAttemptShape,
  notifyCsvReviewPendingIfNeeded,
} from '../services/csvImportAttempts'

export const landlordsRouter = Router()
landlordsRouter.use(requireAuth)

landlordsRouter.get('/', requireAdmin, async (_req, res, next) => {
  try {
    const landlords = await query<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, u.phone,
        COUNT(DISTINCT p.id)::int AS property_count,
        COUNT(DISTINCT u2.id)::int AS unit_count,
        COUNT(DISTINCT u2.id) FILTER (WHERE u2.status='active')::int AS occupied_count,
        EXISTS (
          SELECT 1 FROM user_bank_accounts ba
           WHERE ba.user_id = l.user_id AND ba.status = 'active'
        ) AS bank_account_ready
      FROM landlords l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN properties p ON p.landlord_id = l.id
      LEFT JOIN units u2 ON u2.landlord_id = l.id
      GROUP BY l.id, l.user_id, u.first_name, u.last_name, u.email, u.phone
      ORDER BY u.last_name`)
    res.json({ success: true, data: landlords })
  } catch (e) { next(e) }
})



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
    // Dashboard surfaces revenue + disbursement totals — financial view.
    // Landlord/admin only; team roles don't get the financial rollup.
    if (!canViewLandlordFinances(req.user, id)) {
      throw new AppError(403, 'Forbidden')
    }
    const [stats] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE u.status='active')::int AS active_units,
        COUNT(*) FILTER (WHERE u.status='direct_pay')::int AS direct_pay_units,
        COUNT(*) FILTER (WHERE u.status='vacant')::int AS vacant_units,
        COUNT(*) FILTER (WHERE u.status='delinquent')::int AS delinquent_units,
        COUNT(*) FILTER (WHERE u.status='suspended')::int AS suspended_units,
        COUNT(*) FILTER (WHERE u.payment_block=TRUE)::int AS eviction_mode_units,
        COALESCE(SUM(CASE WHEN u.status='active' THEN u.rent_amount ELSE 0 END),0) AS monthly_rent_volume,
        COUNT(DISTINCT p.id)::int AS property_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = $1`, [id])
    const [upcoming] = await query<any>(`
      SELECT COUNT(*)::int AS count,
        COALESCE(SUM(d.amount),0) AS amount
      FROM disbursements d
      WHERE d.landlord_id = $1 AND d.status='pending'`, [id])
    // Real monthly revenue trend (last 6 months)
    const trend = await query<any>(`
      SELECT 
        TO_CHAR(DATE_TRUNC('month', p.created_at), 'Mon') as month,
        COALESCE(SUM(p.amount),0)::float as revenue
      FROM payments p
      WHERE p.landlord_id = $1
        AND p.status IN ('completed','settled')
        AND p.created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', p.created_at)
      ORDER BY DATE_TRUNC('month', p.created_at) ASC`, [id])

    // Real maintenance stats
    const [maintenance] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status='open')::int as open_requests,
        COUNT(*) FILTER (WHERE status='in_progress')::int as in_progress,
        COUNT(*) FILTER (WHERE status='completed' AND created_at > NOW()-INTERVAL '30 days')::int as completed_30d
      FROM maintenance_requests
      WHERE landlord_id = $1`, [id])

    // Recent background checks pending review
    const [bgPending] = await query<any>(`
      SELECT COUNT(*)::int as count
      FROM background_checks
      WHERE landlord_id = $1 AND status = 'submitted'`, [id])

    const [otpStats] = await query<any>(`
      SELECT
        COUNT(*)::int AS otp_units,
        COALESCE(SUM(u.rent_amount),0)::float AS projected_otp_disbursement
      FROM tenants t
      JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
      JOIN leases l ON l.id = lt.lease_id AND l.status = 'active'
      JOIN units u ON u.id = l.unit_id
      WHERE u.landlord_id = $1
        AND t.on_time_pay_enrolled = TRUE
        AND u.status = 'active'`, [id])

    res.json({ success: true, data: { ...stats, upcoming_disbursement: upcoming, trend, maintenance, bg_pending: bgPending?.count||0, otp_units: otpStats?.otp_units||0, projected_otp_disbursement: otpStats?.projected_otp_disbursement||0 } })
  } catch (e) { next(e) }
})

// POST /api/landlords/complete-onboarding
// S131: stays requireLandlord — only the landlord themselves finishes
// their own onboarding (legal agreement signature). Not delegable.
landlordsRouter.post('/complete-onboarding', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { signature, agreedAt } = req.body
    if (!signature) return res.status(400).json({ success: false, error: 'Signature required' })

    await query(`
      UPDATE landlords SET
        onboarding_complete = TRUE,
        agreement_signed_at = NOW(),
        agreement_signature = $1
      WHERE id = $2`,
      [signature, req.user!.profileId]
    )

    // Also update user profile phone/business if provided
    const landlord = await queryOne<any>('SELECT * FROM landlords WHERE id=$1', [req.user!.profileId])

    res.json({ success: true, data: { onboardingComplete: true } })
  } catch (e) { next(e) }
})

// PATCH /api/landlords/me — update landlord settings
// S131: stays requireLandlord — owner business profile (business_name,
// EIN, approval threshold). Not a team-worker surface.
landlordsRouter.patch('/me', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { businessName, ein, maintApprovalThreshold, defaultEarlyTerminationMonthsRent } = req.body
    // Sentinel value 'CLEAR' on the months-rent field nulls it out
    // (no policy on file). Otherwise COALESCE preserves prior value
    // when the field is absent.
    const clearMonths = defaultEarlyTerminationMonthsRent === null
    await query(`
      UPDATE landlords SET
        business_name = COALESCE($1, business_name),
        ein = COALESCE($2, ein),
        maint_approval_threshold = COALESCE($3, maint_approval_threshold),
        default_early_termination_months_rent = ${clearMonths ? 'NULL' : 'COALESCE($5, default_early_termination_months_rent)'},
        updated_at = NOW()
      WHERE id = $4`,
      clearMonths
        ? [businessName||null, ein||null, maintApprovalThreshold||null, req.user!.profileId]
        : [businessName||null, ein||null, maintApprovalThreshold||null, req.user!.profileId, defaultEarlyTerminationMonthsRent||null]
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
    const landlordId = req.user!.profileId
    const userId = req.user!.userId

    // S67: bank readiness derives from active user_bank_accounts. The
    // landlord's user_id is the catalog owner under the 16a per-property
    // routing model. Owner-financial concern — always shown to the
    // calling owner regardless of property delegation.
    const bankReady = await queryOne<{ ready: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM user_bank_accounts ba
         WHERE ba.user_id = (SELECT user_id FROM landlords WHERE id=$1)
           AND ba.status = 'active'
      ) AS ready
    `, [landlordId])

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
        EXTRACT(DAY FROM l.end_date::timestamp - NOW())::int AS days_remaining
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary' AND lt.status = 'active'
      LEFT JOIN tenants t ON t.id = lt.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      WHERE l.landlord_id = $1
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
    `, [landlordId, userId])

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
        title: 'Lease expiring: ' + unitLabel,
        subtitle: (l.days_remaining != null ? l.days_remaining + ' days' : 'Soon')
          + ' remaining — ' + tenantName,
        href: '/leases?open=' + l.id,
      }
    })

    // ── ACH ISSUES ────────────────────────────────────────
    const ach: any[] = []

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
      WHERE u.landlord_id = $1
        AND u.status = 'active'
        AND p.pm_company_id IS NULL
        AND p.managed_by_user_id = $2
        AND (t.ach_verified = false OR t.ach_verified IS NULL)
      ORDER BY u.unit_number
    `, [landlordId, userId])

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
      WHERE p.landlord_id = $1
        AND pr.pm_company_id IS NULL
        AND pr.managed_by_user_id = $2
        AND p.type = 'rent'
        AND p.status IN ('failed', 'returned')
        AND p.due_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY p.unit_id, p.due_date DESC
    `, [landlordId, userId])

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
      WHERE mr.landlord_id = $1
        AND mr.status = 'awaiting_approval'
      ORDER BY mr.created_at DESC
    `, [landlordId])

    const maintenance = maintRows.map((m: any) => ({
      id: m.id,
      type: 'awaiting_approval',
      title: m.title + ' — Unit ' + m.unit_number,
      subtitle: 'Awaiting approval'
        + (m.estimated_cost != null ? ' · Estimated $' + Number(m.estimated_cost).toLocaleString() : ''),
      href: '/maintenance?open=' + m.id,
    }))

    res.json({
      success: true,
      data: {
        leases,
        ach,
        maintenance,
        counts: {
          leases: leases.length,
          ach: ach.length,
          maintenance: maintenance.length,
          total: leases.length + ach.length + maintenance.length,
        },
      },
    })
  } catch (e) { next(e) }
})


// ── ONBOARDING (S29c) — existing-tenant migration ───────────────────────
// Single-tenant manual onboarding. Creates tenant + imported lease + activation
// email in one transaction. No background check, no application gate.
landlordsRouter.post('/me/onboard-tenant', requirePerm('tenants.create'), async (req, res, next) => {
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

    // --- Verify unit is not already occupied ---
    const occ = await queryOne<any>(
      `SELECT is_occupied FROM v_unit_occupancy WHERE unit_id = $1`,
      [unitId]
    )
    if (occ?.is_occupied) {
      throw new AppError(409, 'Unit is already occupied. Co-tenant additions to occupied units require consent and are not yet supported in this flow.')
    }

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

    // 2. Invite token on user
    // S410 (S377): store on tenant_invite_token with 7-day expiry. Pre-S410
    // wrote to email_verify_token (overloaded column).
    const inviteToken = require('crypto').randomBytes(32).toString('hex')
    await client.query(
      `UPDATE users SET tenant_invite_token=$1,
                        tenant_invite_expires_at=NOW() + INTERVAL '7 days'
        WHERE id=$2`,
      [inviteToken, userId])

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
        lateFeeAmount ?? 15.00,
        lateFeeGraceDays ?? 5,
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
    const activationUrl = `${tenantAppUrl}/accept-invite?token=${inviteToken}`

    const landlord = await queryOne<any>(
      `SELECT u.first_name, u.last_name FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
      [landlordId]
    )
    const landlordName = landlord ? `${landlord.first_name} ${landlord.last_name}`.trim() : 'Your landlord'
    const propertyAddress = [unit.street1, unit.city, unit.state, unit.zip].filter(Boolean).join(', ')
    const unitLabel = `${unit.property_name} — Unit ${unit.unit_number}`

    try {
      await emailTenantOnboarded(
        emailNorm, firstName, landlordName, propertyAddress, unitLabel, activationUrl,
        { landlordId, tenantId }
      )
    } catch (emailErr) {
      // Failure also lands in email_send_log via send()'s internal logging;
      // landlord can surface it via GET /api/landlords/me/email-failures.
      logger.error({ err: emailErr, ctx: emailNorm }, '[ONBOARD] Email send failed for')
      logger.info(`[ONBOARD] Manual activation URL: ${activationUrl}`)
    }

    res.json({
      success: true,
      data: {
        userId,
        tenantId,
        leaseId,
        email: emailNorm,
        activationUrl,
      },
    })
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
// Body: { firstName, lastName, email, phone }
landlordsRouter.post('/me/onboard-tenant-pending', requirePerm('tenants.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { firstName, lastName, email, phone } = req.body

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
      // should resume the existing one or delete it first.
      const existingIntent = await queryOne<any>(
        `SELECT id FROM pending_tenant_intents WHERE tenant_id = $1 AND resolved_at IS NULL LIMIT 1`,
        [existingUser.tenant_id]
      )
      if (existingIntent) {
        throw new AppError(409, 'This person is already in your pending pool. Open the pending list to continue or remove them.')
      }
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
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status)
       VALUES ($1, $2, 'not_uploaded')
       RETURNING id, parser_status, created_at`,
      [landlordId, tenantId]
    )

    await client.query('COMMIT')

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
          const existingIntent = await queryOne<any>(
            `SELECT id FROM pending_tenant_intents WHERE tenant_id = $1 AND resolved_at IS NULL LIMIT 1`,
            [existingUser.tenant_id]
          )
          if (existingIntent) {
            throw new Error('This person is already in your pending pool.')
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
         u.phone
       FROM pending_tenant_intents pti
       JOIN tenants t  ON t.id = pti.tenant_id
       JOIN users   u  ON u.id = t.user_id
       WHERE pti.landlord_id = $1
         AND pti.resolved_at IS NULL
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
// Cleanup is full-cascade: drop the intent, the tenant row, the user row,
// and the stored PDF. Safe because a pending intent has no lease, no
// lease_tenants link, no payments, no anything downstream.
//
// Edge case: if a user/tenant somehow has OTHER active records (the
// existing-user reuse path on /onboard-tenant-pending wires this up — that
// person was already a tenant elsewhere), we keep them. Detected by checking
// for any active lease_tenants row before deleting user/tenant.
landlordsRouter.delete('/me/pending-tenants/:intentId', requirePerm('tenants.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { intentId } = req.params
    const landlordId = req.user!.profileId

    // Verify ownership and get tenant_id + user_id + pdf_url before delete.
    const intent = await queryOne<any>(
      `SELECT pti.id, pti.tenant_id, pti.imported_pdf_url, t.user_id
       FROM pending_tenant_intents pti
       JOIN tenants t ON t.id = pti.tenant_id
       WHERE pti.id = $1 AND pti.landlord_id = $2 AND pti.resolved_at IS NULL`,
      [intentId, landlordId]
    )
    if (!intent) {
      throw new AppError(404, 'Pending tenant not found, already resolved, or not owned by you')
    }

    // Decide whether the user/tenant rows are safe to delete. They are safe
    // ONLY IF this intent is the only thing referencing them — i.e. they have
    // no other active lease_tenants links and no other pending intents.
    const otherLeases = await queryOne<any>(
      `SELECT 1 FROM lease_tenants WHERE tenant_id = $1 LIMIT 1`,
      [intent.tenant_id]
    )
    const otherIntents = await queryOne<any>(
      `SELECT 1 FROM pending_tenant_intents WHERE tenant_id = $1 AND id != $2 LIMIT 1`,
      [intent.tenant_id, intentId]
    )
    const safeToDeleteTenant = !otherLeases && !otherIntents

    await client.query('BEGIN')

    // Always delete the intent row first (cascades aren't needed — no children).
    await client.query('DELETE FROM pending_tenant_intents WHERE id=$1', [intentId])

    // If safe, drop tenant + user. tenants.user_id has ON DELETE CASCADE on
    // the user FK so deleting the user kills the tenant; we delete tenant
    // first explicitly to keep the order honest.
    if (safeToDeleteTenant) {
      await client.query('DELETE FROM tenants WHERE id=$1', [intent.tenant_id])
      await client.query('DELETE FROM users WHERE id=$1', [intent.user_id])
    }

    await client.query('COMMIT')

    // PDF cleanup is best-effort, post-commit. Failure here doesn't roll back
    // the deletion — the row is gone, the file is just orphaned. TODO when
    // storage backend is finalized: surface orphans to admin cleanup job.
    if (intent.imported_pdf_url) {
      const filename = extractUploadFilename(intent.imported_pdf_url)
      if (filename) {
        const filePath = path.join(pendingPdfDir, filename)
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) }
        catch (e) { logger.error({ err: e, ctx: filePath }, '[PENDING DELETE] Failed to remove PDF') }
      }
    }

    res.json({
      success: true,
      data: {
        intentId,
        tenantDeleted: safeToDeleteTenant,
        userDeleted: safeToDeleteTenant,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
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
  requirePerm('tenants.create'),
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
         WHERE id = $1 AND landlord_id = $2 AND resolved_at IS NULL`,
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
  requirePerm('tenants.create'),
  async (req, res, next) => {
    try {
      const { intentId } = req.params
      const landlordId = req.user!.profileId
      const overrides = (req.body?.landlordOverrides ?? {}) as any
      if (typeof overrides !== 'object' || Array.isArray(overrides) || overrides === null) {
        throw new AppError(400, 'landlordOverrides must be an object')
      }
      const result = await resolveIntent(intentId, landlordId, overrides)
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
landlordsRouter.post('/me/onboard-properties-csv/validate', requirePerm('properties.create'), async (req, res, next) => {
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
      if (row.unitType && !UNIT_TYPES.includes(row.unitType)) {
        issues.push({ severity: 'block', field: 'unit_type', message: `Must be one of: ${UNIT_TYPES.join(', ')}` })
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

    const blockers = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'block').length, 0)
    const warnings = rows.reduce((n, r) => n + r.issues.filter(i => i.severity === 'warn').length, 0)
    const ready = rows.filter(r => !r.issues.some(i => i.severity === 'block')).length
    const newProperties = seenPropertyKeys.size
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
landlordsRouter.post('/me/onboard-properties-csv/commit', requirePerm('properties.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { rows, source, claimedPlatformName } = req.body
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(400, 'rows array required')
    }
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
    const createdProperties: { id: string; name: string }[] = []
    const createdUnits: { id: string; unitNumber: string; propertyId: string }[] = []
    let skippedUnits = 0

    for (const row of rows as PropertyCsvRow[]) {
      const propKey = `${row.propertyName.toLowerCase()}|${row.street1.toLowerCase()}`

      // Resolve / create property
      let propertyId: string | undefined = row.resolvedPropertyId
      if (!propertyId) propertyId = propertyIdByKey.get(propKey)

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
        createdProperties.push({ id: propertyId, name: propRes.rows[0].name })

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

      const unitType = ['apartment', 'single_family', 'rv_spot', 'mobile_home', 'storage', 'commercial'].includes(row.unitType)
        ? row.unitType
        : 'apartment'
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
          primary.lateFeeAmount ? parseFloat(primary.lateFeeAmount) : 15.00,
          primary.lateFeeGraceDays ? parseInt(primary.lateFeeGraceDays) : 5,
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
landlordsRouter.post('/me/onboard-payment-history-csv/commit', requirePerm('tenants.create'), async (req, res, next) => {
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
landlordsRouter.patch('/me/default-pm-company', requireLandlord, async (req: any, res, next) => {
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
landlordsRouter.post('/me/pm-property-invitations', requireLandlord, async (req: any, res, next) => {
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
landlordsRouter.post('/me/pm-property-invitations/:invId/accept', requireLandlord, async (req: any, res, next) => {
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
landlordsRouter.post('/me/pm-property-invitations/:invId/reject', requireLandlord, async (req: any, res, next) => {
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
landlordsRouter.delete('/me/pm-property-invitations/:invId', requireLandlord, async (req: any, res, next) => {
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
