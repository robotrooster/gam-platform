import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireAdmin, requireSuperAdmin } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { logAdminAction } from '../lib/adminAudit'
import { backfillInvoices } from '../jobs/invoiceGeneration'
import { PropertyReviewStatus } from '@gam/shared'
import { fetchAccountStatus } from '../services/stripeConnect'

export const adminRouter = Router()
adminRouter.use(requireAuth)
adminRouter.use((req: any, res: any, next: any) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: 'Insufficient permissions' })
  }
  next()
})

adminRouter.get('/overview', async (_req, res, next) => {
  try {
    const [platform] = await query<any>(`
      SELECT
        (SELECT COUNT(*)::int FROM landlords) AS total_landlords,
        (SELECT COUNT(*)::int FROM users WHERE role='tenant')   AS total_tenants,
        (SELECT COUNT(*)::int FROM units WHERE status='active') AS active_units,
        (SELECT COUNT(*)::int FROM units WHERE status='vacant') AS vacant_units,
        (SELECT COUNT(*)::int FROM units WHERE payment_block=TRUE) AS eviction_mode_units,
        (SELECT COALESCE(SUM(rent_amount),0) FROM units WHERE status='active') AS monthly_rent_volume,
        (SELECT COALESCE(balance,0) FROM reserve_fund_state LIMIT 1) AS reserve_balance,
        (SELECT COALESCE(balance,0) FROM float_account_state LIMIT 1) AS float_balance,
        (SELECT COUNT(*)::int FROM payments WHERE status='pending') AS pending_payments,
        (SELECT COUNT(*)::int FROM disbursements WHERE status='pending') AS pending_disbursements,
        (SELECT COUNT(*)::int FROM maintenance_requests WHERE status='open') AS open_maintenance,
        (SELECT COUNT(*)::int FROM tenants WHERE on_time_pay_enrolled=TRUE) AS flex_otp,
        (SELECT COUNT(*)::int FROM tenants WHERE credit_reporting_enrolled=TRUE) AS flex_credit,
        (SELECT COUNT(*)::int FROM tenants WHERE flex_deposit_enrolled=TRUE) AS flex_deposit,
        (SELECT COUNT(*)::int FROM tenants WHERE float_fee_active=TRUE) AS flex_pay,
        (SELECT COUNT(*)::int FROM ach_monitoring_log WHERE flagged=TRUE AND resolved=FALSE) AS zero_tolerance_events,
        -- S316: pending CSV imports awaiting review where the
        -- platform/import-type slot is unverified. Matches the
        -- email-notification gate so the tile count equals the
        -- super_admin's actionable backlog.
        (
          SELECT COUNT(*)::int
            FROM csv_import_attempts a
            LEFT JOIN platform_review_status p
              ON p.platform_key = a.platform_key
             AND p.import_type  = a.import_type
           WHERE a.status IN ('validated', 'committed')
             AND COALESCE(p.mapping_status, 'unverified') = 'unverified'
        ) AS csv_imports_pending_review
    `)
    res.json({ success: true, data: platform })
  } catch (e) { next(e) }
})

adminRouter.get('/nacha/monitoring', async (_req, res, next) => {
  try {
    const logs = await query<any>(`
      SELECT aml.*, tu.first_name, tu.last_name
      FROM ach_monitoring_log aml
      LEFT JOIN tenants t ON t.id = aml.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      ORDER BY aml.created_at DESC LIMIT 100`)
    // S370 fix: pre-S370 the second FILTER referenced `zero_tolerance_flag`
    // which doesn't exist on ach_monitoring_log (the boolean indicator
    // column is `flagged`). Every nacha/monitoring call crashed 500 with
    // "column zero_tolerance_flag does not exist" — admin NACHA page
    // dead. Use event_type='zero_tolerance_block' for the semantic
    // (matches the CHECK constraint values) and `flagged` for the
    // /overview convention; here we want the specific event type, not
    // the broader flagged-any signal.
    const [stats] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE return_code IS NOT NULL) AS total_returns,
        COUNT(*) FILTER (WHERE event_type='zero_tolerance_block') AS zero_tolerance_events,
        COUNT(*) FILTER (WHERE event_type='first_sender') AS first_senders_30d,
        COUNT(*) FILTER (WHERE event_type='velocity_flag') AS velocity_flags_30d
      FROM ach_monitoring_log WHERE created_at > NOW() - INTERVAL '30 days'`)
    res.json({ success: true, data: { logs, stats } })
  } catch (e) { next(e) }
})

// ── BULLETIN BOARD (super_admin) ──────────────────────────────

adminRouter.get('/bulletin', requireSuperAdmin, async (req, res, next) => {
  try {
    const { date } = req.query
    const params: any[] = []
    const dateFilter = date
      ? `AND DATE(b.created_at) = $${params.push(date)}`
      : ''
    const posts = await query<any>(`
      SELECT b.*,
        p.name as property_name,
        b.upvote_count as vote_count
      FROM bulletin_posts b
      LEFT JOIN properties p ON p.id = b.property_id
      WHERE (b.is_removed IS NULL OR b.is_removed = FALSE)
      ${dateFilter}
      ORDER BY b.pinned DESC, b.created_at DESC
      LIMIT 500`, params)
    res.json({ success: true, data: posts })
  } catch (e) { next(e) }
})

adminRouter.get('/bulletin/:id/reveal', requireSuperAdmin, async (req, res, next) => {
  try {

    const post = await queryOne<any>('SELECT * FROM bulletin_posts WHERE id=$1', [req.params.id])
    if (!post) throw new AppError(404, 'Post not found')

    const tenant = await queryOne<any>(`
      SELECT u.first_name, u.last_name, u.email, un.unit_number
      FROM tenants t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
      LEFT JOIN leases l ON l.id = lt.lease_id AND l.status = 'active'
      LEFT JOIN units un ON un.id = l.unit_id
      WHERE t.id = $1`, [post.tenant_id])

    if (!tenant) throw new AppError(404, 'Tenant not found')

    // Log the reveal
    await query(`INSERT INTO bulletin_reveal_log (post_id, revealed_by, admin_id)
      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [post.id, post.tenant_id, req.user!.userId])

    res.json({ success: true, data: { ...tenant, alias: post.alias } })
  } catch (e) { next(e) }
})

adminRouter.post('/bulletin/:id/pin', requireSuperAdmin, async (req, res, next) => {
  try {
    const { pin } = req.body
    await query('UPDATE bulletin_posts SET pinned=$1 WHERE id=$2', [pin, req.params.id])
    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: pin ? 'bulletin_pin' : 'bulletin_unpin',
      targetId: req.params.id,
      targetType: 'bulletin_post',
      ipAddress: req.ip ?? null,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

adminRouter.post('/bulletin/:id/remove', requireSuperAdmin, async (req, res, next) => {
  try {
    await query('UPDATE bulletin_posts SET is_removed=TRUE, removed_at=NOW(), removed_by=$1 WHERE id=$2', [req.user!.userId, req.params.id])
    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: 'bulletin_remove',
      targetId: req.params.id,
      targetType: 'bulletin_post',
      ipAddress: req.ip ?? null,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── ONBOARDING OVERVIEW (regular admin) ──────────────────────
adminRouter.get('/onboarding/overview', async (_req, res, next) => {
  try {
    const [stats] = await query<any>(`
      SELECT
        (SELECT COUNT(*)::int FROM landlords WHERE onboarding_complete=FALSE) AS landlords_incomplete,
        (SELECT COUNT(*)::int FROM landlords l
          WHERE NOT EXISTS (
            SELECT 1 FROM user_bank_accounts ba
             WHERE ba.user_id = l.user_id AND ba.status = 'active'
          )
        )::int AS landlords_no_bank,
        (SELECT COUNT(*)::int FROM tenants WHERE ach_verified=FALSE) AS tenants_no_ach,
        (SELECT COUNT(*)::int FROM tenants WHERE on_time_pay_enrolled=FALSE AND credit_reporting_enrolled=FALSE AND flex_deposit_enrolled=FALSE AND float_fee_active=FALSE) AS tenants_no_flex,
        (SELECT COUNT(*)::int FROM units WHERE status='vacant') AS vacant_units,
        (SELECT COUNT(*)::int FROM v_unit_occupancy WHERE NOT is_occupied) AS units_no_tenant
    `)
    res.json({ success: true, data: stats })
  } catch (e) { next(e) }
})

// ── LANDLORD ONBOARDING DETAIL ────────────────────────────────
adminRouter.get('/onboarding/landlord/:id', async (req, res, next) => {
  try {
    const landlord = await queryOne<any>(
      `SELECT l.*, u.first_name, u.last_name, u.email, u.phone,
        EXISTS (
          SELECT 1 FROM user_bank_accounts ba
           WHERE ba.user_id = l.user_id AND ba.status = 'active'
        ) AS bank_account_ready
       FROM landlords l JOIN users u ON u.id = l.user_id
       WHERE l.id = $1`, [req.params.id]
    )
    if (!landlord) throw new Error('Landlord not found')

    const [counts] = await query<any>(
      `SELECT
         COUNT(DISTINCT p.id)::int AS property_count,
         COUNT(DISTINCT u.id)::int AS unit_count,
         COUNT(DISTINCT u.id) FILTER (WHERE vuo.is_occupied)::int AS units_with_tenants,
         COUNT(DISTINCT l.id) FILTER (WHERE l.status='active')::int AS active_leases,
         (
           SELECT COUNT(*)::int FROM user_bank_accounts ba
            WHERE ba.user_id = ld.user_id AND ba.status = 'active'
         ) AS active_bank_accounts
       FROM landlords ld
       LEFT JOIN properties p ON p.landlord_id = ld.id
       LEFT JOIN units u ON u.landlord_id = ld.id
       LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
       LEFT JOIN leases l ON l.landlord_id = ld.id
       WHERE ld.id = $1
       GROUP BY ld.id, ld.user_id`, [req.params.id]
    )

    const checklist = [
      { key: 'account_created',   label: 'Account created',         done: true },
      { key: 'bank_account_added', label: 'Bank account added',     done: counts.active_bank_accounts > 0 },
      { key: 'property_added',    label: 'Property added',           done: counts.property_count > 0 },
      { key: 'unit_added',        label: 'Units added',              done: counts.unit_count > 0 },
      { key: 'tenant_invited',    label: 'Tenant invited',           done: counts.units_with_tenants > 0 },
      { key: 'onboarding_complete', label: 'Onboarding complete',    done: landlord.onboarding_complete },
    ]

    res.json({ success: true, data: { landlord, counts, checklist } })
  } catch (e) { next(e) }
})

// ── TENANT ONBOARDING DETAIL ──────────────────────────────────
adminRouter.get('/onboarding/tenant/:id', async (req, res, next) => {
  try {
    const tenant = await queryOne<any>(
      `SELECT t.*, u.first_name, u.last_name, u.email, u.phone,
              un.unit_number, p.name AS property_name,
              l.first_name AS landlord_first, l.last_name AS landlord_last
       FROM tenants t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN LATERAL (
         SELECT un2.id, un2.unit_number, un2.property_id, un2.landlord_id
         FROM v_lease_active_tenants vlat
         JOIN leases le ON le.id = vlat.lease_id AND le.status = 'active'
         JOIN units un2 ON un2.id = le.unit_id
         WHERE vlat.tenant_id = t.id
         ORDER BY (vlat.role = 'primary') DESC
         LIMIT 1
       ) un ON TRUE
       LEFT JOIN properties p ON p.id = un.property_id
       LEFT JOIN landlords ld ON ld.id = un.landlord_id
       LEFT JOIN users l ON l.id = ld.user_id
       WHERE t.id = $1`, [req.params.id]
    )
    if (!tenant) throw new Error('Tenant not found')

    const checklist = [
      { key: 'account_created',   label: 'Account created',         done: true },
      { key: 'ach_enrolled',      label: 'ACH enrolled',            done: !!tenant.bank_last4 },
      { key: 'ach_verified',      label: 'ACH verified',            done: tenant.ach_verified },
      { key: 'flex_deposit',      label: 'FlexDeposit enrolled',    done: tenant.flex_deposit_enrolled },
      // S409 (S376 decision): the column `credit_reporting_enrolled` is
      // the rent-reporting product (tenant pays to have rent payments
      // reported to Equifax/Experian/TransUnion). It is NOT FlexCredit
      // (which is a separate third-party-lender referral product per
      // CLAUDE.md). The "FlexCredit enrolled" label was a mislabel.
      // Key kept as `flex_credit` to avoid breaking the admin frontend
      // checklist key map; label is the user-visible string.
      { key: 'flex_credit',       label: 'Rent reporting enrolled', done: tenant.credit_reporting_enrolled },
      { key: 'flex_pay',          label: 'FlexPay enrolled',        done: tenant.float_fee_active },
    ]

    res.json({ success: true, data: { tenant, checklist } })
  } catch (e) { next(e) }
})

// ── FLEXSUITE ENROLLMENT ACCEPTANCES (S315) ──────────────────
// List the click-accept audit rows for a tenant. Used by the admin
// Tenants detail panel to render the per-enrollment evidence + open
// the full populated terms text on click. Records are immutable
// (insert-only at enrollment via services/flexsuiteAcceptance.ts).
adminRouter.get('/tenants/:tenantId/flexsuite-acceptances', async (req, res, next) => {
  try {
    const rows = await query<{
      id:                  string
      product_type:        'flexpay' | 'flexdeposit'
      template_version:    string
      populated_content:   any
      rendered_text:       string
      content_hash:        string
      accepted_at:         string
      accepted_ip:         string | null
      accepted_user_agent: string | null
      accepter_email:      string | null
    }>(
      `SELECT a.id, a.product_type, a.template_version, a.populated_content,
              a.rendered_text, a.content_hash,
              a.accepted_at, a.accepted_ip, a.accepted_user_agent,
              u.email AS accepter_email
         FROM flexsuite_enrollment_acceptances a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.tenant_id = $1
        ORDER BY a.accepted_at DESC`,
      [req.params.tenantId],
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── RESEND ACTIONS ────────────────────────────────────────────
adminRouter.post('/onboarding/resend', async (req, res, next) => {
  try {
    const { type, targetId } = req.body
    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: `resend_${type}`,
      targetId: targetId ?? null,
      targetType: 'tenant',
      notes: `Resend triggered by admin`,
      ipAddress: req.ip ?? null,
    })
    res.json({ success: true, data: { message: `${type} notification queued` } })
  } catch (e) { next(e) }
})

// ── TENANTS LIST (with flex status) ──────────────────────────
adminRouter.get('/tenants', async (_req, res, next) => {
  try {
    const tenants = await query<any>(`
      SELECT t.id, t.ach_verified, t.bank_last4, t.on_time_pay_enrolled,
             t.credit_reporting_enrolled, t.flex_deposit_enrolled, t.float_fee_active,
             t.ssi_ssdi, t.late_payment_count, t.created_at,
             u.first_name, u.last_name, u.email, u.phone,
             un.unit_number, p.name AS property_name,
             lu.first_name AS landlord_first, lu.last_name AS landlord_last
       FROM tenants t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN LATERAL (
         SELECT un2.id, un2.unit_number, un2.property_id, un2.landlord_id
         FROM v_lease_active_tenants vlat
         JOIN leases le ON le.id = vlat.lease_id AND le.status = 'active'
         JOIN units un2 ON un2.id = le.unit_id
         WHERE vlat.tenant_id = t.id
         ORDER BY (vlat.role = 'primary') DESC
         LIMIT 1
       ) un ON TRUE
       LEFT JOIN properties p ON p.id = un.property_id
       LEFT JOIN landlords ld ON ld.id = un.landlord_id
       LEFT JOIN users lu ON lu.id = ld.user_id
       ORDER BY u.last_name, u.first_name
    `)
    res.json({ success: true, data: tenants })
  } catch (e) { next(e) }
})

// ── PROJECTED PLATFORM INCOME ─────────────────────────────────
adminRouter.get('/income/projection', async (_req, res, next) => {
  try {
    // Unit counts
    const [units] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE u.status='active' AND t.on_time_pay_enrolled=TRUE)::int  AS otp_units,
        COUNT(*) FILTER (WHERE u.status='active' AND (t.on_time_pay_enrolled=FALSE OR t.id IS NULL))::int AS direct_units,
        COUNT(*) FILTER (WHERE u.status='active')::int AS active_units,
        COUNT(*) FILTER (WHERE u.status='vacant')::int AS vacant_units,
        COALESCE(SUM(u.rent_amount) FILTER (WHERE u.status='active'),0) AS total_rent
      FROM units u
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      LEFT JOIN tenants t ON t.id = vuo.primary_tenant_id
    `)

    // Flex product counts
    const [flex] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE float_fee_active=TRUE)::int   AS flex_pay,
        COUNT(*) FILTER (WHERE ssi_ssdi=TRUE)::int           AS ssi_ssdi,
        COUNT(*) FILTER (WHERE flex_deposit_enrolled=TRUE)::int AS flex_deposit,
        COUNT(*) FILTER (WHERE credit_reporting_enrolled=TRUE)::int AS flex_credit
      FROM tenants
    `)

    // Background checks this month
    const [bgChecks] = await query<any>(`
      SELECT COUNT(*)::int AS count FROM background_checks
      WHERE created_at >= date_trunc('month', CURRENT_DATE)
    `).catch(() => [{ count: 0 }])

    // Fee constants
    const ACTIVE_UNIT     = 15.00
    const DIRECT_PAY_UNIT = 5.00
    const FLOAT_FEE_MO    = 20.00
    const BG_CHECK_NET    = 15.00

    // Monthly projections
    const otpFees        = +units.otp_units    * ACTIVE_UNIT
    const directFees     = +units.direct_units * DIRECT_PAY_UNIT
    const flexPayFees    = +flex.flex_pay       * FLOAT_FEE_MO
    const bgCheckFees    = +bgChecks.count      * BG_CHECK_NET

    const totalMonthly   = otpFees + directFees + flexPayFees + bgCheckFees
    const totalAnnual    = totalMonthly * 12

    res.json({
      success: true,
      data: {
        monthly: {
          otp_unit_fees:    +otpFees.toFixed(2),
          direct_unit_fees: +directFees.toFixed(2),
          flex_pay_fees:    +flexPayFees.toFixed(2),
          bg_check_fees:    +bgCheckFees.toFixed(2),
          total:            +totalMonthly.toFixed(2),
        },
        annual: +totalAnnual.toFixed(2),
        counts: {
          otp_units:    +units.otp_units,
          direct_units: +units.direct_units,
          active_units: +units.active_units,
          flex_pay:     +flex.flex_pay,
          bg_checks:    +bgChecks.count,
        }
      }
    })
  } catch (e) { next(e) }
})


// ─── PROPERTY DUPLICATE FLAGS ─────────────────────────────────
adminRouter.get('/property-flags', async (req, res, next) => {
  try {
    const status = (req.query.status as string) || 'pending'
    let where = ''
    if (status === 'pending')  where = 'WHERE f.resolved_at IS NULL'
    if (status === 'resolved') where = 'WHERE f.resolved_at IS NOT NULL'
    const rows = await query<any>(`
      SELECT
        f.id, f.reason, f.detected_at, f.resolved_at, f.resolution, f.notes,
        f.property_id, f.conflicting_property_id,
        p1.name AS new_name, p1.street1 AS new_street1, p1.street2 AS new_street2,
          p1.city AS new_city, p1.state AS new_state, p1.zip AS new_zip,
          p1.review_status AS new_status, p1.created_at AS new_created_at,
        u1.first_name AS new_landlord_first, u1.last_name AS new_landlord_last,
          u1.email AS new_landlord_email, l1.business_name AS new_landlord_business,
        p2.name AS orig_name, p2.street1 AS orig_street1, p2.street2 AS orig_street2,
          p2.city AS orig_city, p2.state AS orig_state, p2.zip AS orig_zip,
          p2.created_at AS orig_created_at,
        u2.first_name AS orig_landlord_first, u2.last_name AS orig_landlord_last,
          u2.email AS orig_landlord_email, l2.business_name AS orig_landlord_business
      FROM property_duplicate_flags f
      JOIN properties p1 ON p1.id = f.property_id
      JOIN landlords  l1 ON l1.id = p1.landlord_id
      JOIN users      u1 ON u1.id = l1.user_id
      JOIN properties p2 ON p2.id = f.conflicting_property_id
      JOIN landlords  l2 ON l2.id = p2.landlord_id
      JOIN users      u2 ON u2.id = l2.user_id
      ${where}
      ORDER BY f.detected_at DESC
      LIMIT 500`)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.post('/property-flags/:id/resolve', async (req: any, res, next) => {
  try {
    const { resolution, notes } = req.body as { resolution: 'approved_separate'|'merged'|'rejected'; notes?: string }
    if (!['approved_separate','merged','rejected'].includes(resolution)) {
      return res.status(400).json({ success: false, error: 'Invalid resolution' })
    }
    const flag = await queryOne<any>('SELECT * FROM property_duplicate_flags WHERE id=$1 AND resolved_at IS NULL', [req.params.id])
    if (!flag) return res.status(404).json({ success: false, error: 'Flag not found or already resolved' })

    await query(`
      UPDATE property_duplicate_flags
      SET resolved_at=now(), resolved_by=$1, resolution=$2, notes=$3
      WHERE id=$4`,
      [req.user.userId, resolution, notes || null, flag.id])

    // Update the flagged property's status based on resolution.
    // S73: typed via PropertyReviewStatus from @gam/shared.
    const newStatus: PropertyReviewStatus =
      resolution === 'approved_separate' ? 'active' :
      resolution === 'merged'            ? 'active' :
      /* rejected */                       'rejected'
    await query(`UPDATE properties SET review_status=$1 WHERE id=$2`, [newStatus, flag.property_id])

    await logAdminAction({
      adminUserId: req.user.userId,
      actionType: `property_flag_${resolution}`,
      targetId: flag.property_id,
      targetType: 'property',
      notes: notes || null,
      metadata: { flag_id: flag.id, resolution },
      ipAddress: req.ip ?? null,
    })

    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── AUDIT LOG VIEWER (super_admin) ────────────────────────────
// S77: read-side for admin_action_log. Writers landed S67; this is the UI
// surface so super_admin can actually see the audit trail.

adminRouter.get('/audit-log', requireSuperAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 200)
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0)
    const actionType = typeof req.query.action_type === 'string' && req.query.action_type ? req.query.action_type : null
    const adminUserId = typeof req.query.admin_user_id === 'string' && req.query.admin_user_id ? req.query.admin_user_id : null
    const targetId = typeof req.query.target_id === 'string' && req.query.target_id ? req.query.target_id : null
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : null
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : null

    const where: string[] = []
    const params: any[] = []
    if (actionType)   { params.push(actionType);   where.push(`l.action_type = $${params.length}`) }
    if (adminUserId)  { params.push(adminUserId);  where.push(`l.admin_user_id = $${params.length}`) }
    if (targetId)     { params.push(targetId);     where.push(`l.target_id = $${params.length}`) }
    if (from)         { params.push(from);         where.push(`l.created_at >= $${params.length}`) }
    if (to)           { params.push(to);           where.push(`l.created_at < ($${params.length}::date + INTERVAL '1 day')`) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const rowsParams = [...params, limit, offset]
    const rows = await query<any>(`
      SELECT l.id, l.admin_user_id, l.action_type, l.target_id, l.target_type,
             l.notes, l.metadata, l.ip_address, l.created_at,
             u.email AS admin_email, u.first_name AS admin_first_name,
             u.last_name AS admin_last_name, u.role AS admin_role
      FROM admin_action_log l
      LEFT JOIN users u ON u.id = l.admin_user_id
      ${whereSql}
      ORDER BY l.created_at DESC
      LIMIT $${rowsParams.length - 1} OFFSET $${rowsParams.length}
    `, rowsParams)

    const totalRow = await queryOne<any>(`SELECT COUNT(*)::int AS total FROM admin_action_log l ${whereSql}`, params)

    const actionTypes = await query<any>(`SELECT DISTINCT action_type FROM admin_action_log ORDER BY action_type ASC`)
    const admins = await query<any>(`
      SELECT DISTINCT u.id, u.email, u.first_name, u.last_name, u.role
      FROM admin_action_log l
      JOIN users u ON u.id = l.admin_user_id
      ORDER BY u.email ASC
    `)

    res.json({
      success: true,
      data: {
        rows,
        total: totalRow?.total ?? 0,
        limit,
        offset,
        actionTypes: actionTypes.map(r => r.action_type),
        admins,
      },
    })
  } catch (e) { next(e) }
})

// ── INVOICE BACKFILL (super_admin) ────────────────────────────
// S100: explicit-window catch-up for invoice generation. The daily cron
// already runs a 30-day rolling catch-up; this endpoint exists for ops
// scenarios where a longer window is needed (cron outage, lease imported
// mid-cycle, etc.). dry_run=true returns the would-insert counts without
// writing — always run that first to confirm the blast radius before
// committing.

adminRouter.post('/invoices/backfill', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      from?: unknown
      to?: unknown
      landlord_id?: unknown
      lease_id?: unknown
      dry_run?: unknown
    }

    const isISODate = (v: unknown): v is string =>
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    const isUuid = (v: unknown): v is string =>
      typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)

    if (!isISODate(body.from)) throw new AppError(400, 'from is required as YYYY-MM-DD')
    if (!isISODate(body.to))   throw new AppError(400, 'to is required as YYYY-MM-DD')
    if (body.landlord_id != null && !isUuid(body.landlord_id)) throw new AppError(400, 'landlord_id must be a uuid')
    if (body.lease_id    != null && !isUuid(body.lease_id))    throw new AppError(400, 'lease_id must be a uuid')

    const dryRun = body.dry_run === true
    const result = await backfillInvoices({
      from: body.from,
      to: body.to,
      landlordId: isUuid(body.landlord_id) ? body.landlord_id : undefined,
      leaseId:    isUuid(body.lease_id)    ? body.lease_id    : undefined,
      dryRun,
    })

    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: dryRun ? 'invoices_backfill_dry_run' : 'invoices_backfill',
      targetId: null,
      targetType: 'invoice',
      notes: `from=${body.from} to=${body.to} invoices=${result.invoicesInserted} leases=${result.leasesProcessed}`,
      metadata: {
        from: body.from,
        to: body.to,
        landlord_id: isUuid(body.landlord_id) ? body.landlord_id : null,
        lease_id:    isUuid(body.lease_id)    ? body.lease_id    : null,
        dry_run: dryRun,
        ...result,
      },
      ipAddress: req.ip ?? null,
    })

    res.json({ success: true, data: { dryRun, ...result } })
  } catch (e) { next(e) }
})

// ── EMAIL FAILURES (super_admin) ──────────────────────────────────────────
// S101: global ops view of recent failed email sends. Per-landlord lookup
// lives at GET /api/landlords/me/email-failures. status filter defaults to
// 'failed' (the operational use case); pass status=sent for delivery audit.

adminRouter.get('/email-failures', requireSuperAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500)
    const sinceDays = Math.min(Math.max(parseInt(String(req.query.since_days ?? '7'), 10) || 7, 1), 365)
    const statusFilter = req.query.status === 'sent' ? 'sent' : 'failed'
    const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : null

    const where: string[] = [
      `status = $1`,
      `created_at >= NOW() - ($2::int * INTERVAL '1 day')`,
    ]
    const params: any[] = [statusFilter, sinceDays]
    if (category) { params.push(category); where.push(`category = $${params.length}`) }

    params.push(limit)
    const rows = await query<any>(`
      SELECT id, to_email, subject, category, status, error_message,
             landlord_id, related_entity_type, related_entity_id, metadata, created_at
        FROM email_send_log
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}
    `, params)

    res.json({ success: true, data: { rows, status: statusFilter, sinceDays, limit } })
  } catch (e) { next(e) }
})

// ── ADMIN NOTIFICATIONS (S132) ────────────────────────────────────────────
// In-app + email surface for admin-relevant alerts (ACH retry confirm
// failures, allocation engine breaks, post-commit pm_transfer failures,
// e-sign lease build failures). Replaces console.error sites that were
// previously invisible.

adminRouter.get('/notifications', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500)
    const severity = typeof req.query.severity === 'string' ? req.query.severity : null
    const category = typeof req.query.category === 'string' ? req.query.category : null
    const includeAcked = req.query.include_acknowledged === 'true'

    const where: string[] = []
    const params: any[] = []
    if (!includeAcked) where.push('acknowledged_at IS NULL')
    if (severity) { params.push(severity); where.push(`severity = $${params.length}`) }
    if (category) { params.push(category); where.push(`category = $${params.length}`) }
    params.push(limit)

    const rows = await query<any>(`
      SELECT n.id, n.severity, n.category, n.title, n.body, n.context,
             n.acknowledged_at, n.acknowledged_by,
             u.email AS acknowledged_by_email,
             n.created_at
        FROM admin_notifications n
        LEFT JOIN users u ON u.id = n.acknowledged_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY n.created_at DESC
       LIMIT $${params.length}
    `, params)

    const counts = await queryOne<any>(`
      SELECT
        COUNT(*) FILTER (WHERE acknowledged_at IS NULL)                          AS unacked,
        COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'critical') AS unacked_critical,
        COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'warn')     AS unacked_warn,
        COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'info')     AS unacked_info
        FROM admin_notifications
    `)

    res.json({ success: true, data: { rows, counts, limit, includeAcked } })
  } catch (e) { next(e) }
})

adminRouter.post('/notifications/:id/acknowledge', async (req: any, res, next) => {
  try {
    const updated = await queryOne<any>(`
      UPDATE admin_notifications
         SET acknowledged_at = NOW(),
             acknowledged_by = $1
       WHERE id = $2
         AND acknowledged_at IS NULL
       RETURNING id, acknowledged_at, acknowledged_by
    `, [req.user!.userId, req.params.id])
    if (!updated) throw new AppError(404, 'Notification not found or already acknowledged')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// SYSTEM FEATURES (S155)
// Platform-level feature flags. List is admin-readable; toggle
// is super_admin-only.
// ─────────────────────────────────────────────────────────────
adminRouter.get('/system-features', requireAdmin, async (_req, res, next) => {
  try {
    const { listFeatures } = await import('../services/systemFeatures')
    const rows = await listFeatures()
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.patch('/system-features/:key', requireSuperAdmin, async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled
    const { setFeatureEnabled } = await import('../services/systemFeatures')
    await setFeatureEnabled(req.params.key, enabled, req.user!.userId)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// PATCH /api/admin/landlords/:id/otp-rollout — toggle per-landlord beta
adminRouter.patch('/landlords/:id/otp-rollout', requireSuperAdmin, async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled
    await query('UPDATE landlords SET otp_rollout_enabled = $1 WHERE id = $2', [enabled, req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// S244: Retry a failed OTP advance Transfer. An advance row whose
// stripe.transfers.create errored on the original cron pass sits with
// status='pending' + transfer_error set. The admin alert points here.
// Idempotent — fireOtpAdvanceTransfer uses the same Idempotency-Key
// as the cron pass (otp_advance_<id>), so re-firing returns the
// original Transfer if it actually succeeded behind a reported error
// (e.g. network blip mid-response). Allowed for both admin and
// super_admin since this is recovery / loss-mitigation work.
adminRouter.post('/otp/advances/:id/retry-transfer', requireAdmin, async (req, res, next) => {
  try {
    const adv = await queryOne<{
      id: string
      landlord_id: string
      tenant_id: string
      cycle_month: string
      advance_amount: string
      status: string
      stripe_transfer_id: string | null
      connect_account_id: string | null
    }>(
      `SELECT a.id, a.landlord_id, a.tenant_id, a.cycle_month, a.advance_amount,
              a.status, a.stripe_transfer_id,
              u.stripe_connect_account_id AS connect_account_id
         FROM otp_advances a
         JOIN landlords l ON l.id = a.landlord_id
         JOIN users u     ON u.id = l.user_id
        WHERE a.id = $1`,
      [req.params.id],
    )
    if (!adv) throw new AppError(404, 'OTP advance not found')
    if (adv.stripe_transfer_id) {
      throw new AppError(409, `Already funded — transfer ${adv.stripe_transfer_id}`)
    }
    if (!adv.connect_account_id) {
      throw new AppError(409, 'Landlord has no Stripe Connect account — onboarding must complete before retry')
    }

    const { fireOtpAdvanceTransfer } = await import('../services/otp')
    const out = await fireOtpAdvanceTransfer({
      advanceId:       adv.id,
      landlordConnect: adv.connect_account_id,
      amount:          Number(adv.advance_amount),
      cycle:           adv.cycle_month,
      tenantId:        adv.tenant_id,
      landlordId:      adv.landlord_id,
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// S253: FlexCharge statement billing retry. A statement billing
// attempt that failed (e.g., customer payment method temporarily
// unavailable) lands in status='failed' with failed_reason set.
// Admin reviews + re-fires via this route. Resets status to 'open'
// and runs the standard processFlexChargeStatementBilling cron pass
// inline so the operator sees the result immediately.
adminRouter.post('/flexcharge/statements/:id/retry-billing', requireAdmin, async (req, res, next) => {
  try {
    const { retryFlexChargeStatement } = await import('../services/flexCharge')
    const out = await retryFlexChargeStatement(req.params.id)
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// S257: FlexDeposit portability — admin reverse-Transfer ops surface.
// When a tenant carries forward a landlord-held deposit (S255), the
// security_deposits row re-points to the new lease and flips
// held_by='gam_escrow' immediately, but the physical funds still sit
// in the previous landlord's Connect balance. Status goes to
// 'pending_transfer' and an admin alert fires. Admin moves the funds
// out-of-band (Stripe Dashboard reverse-Transfer, ACH, or another
// channel) and confirms via the mark-transferred route here.

adminRouter.get('/deposit-portability/pending', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT sd.id, sd.tenant_id, sd.unit_id, sd.lease_id,
              sd.total_amount::text AS total_amount,
              sd.portability_authorized_at::text AS portability_authorized_at,
              sd.portability_target_lease_id,
              sd.carried_from_deposit_id,
              sd.notes,
              -- Tenant
              tu.first_name || ' ' || tu.last_name AS tenant_name,
              tu.email AS tenant_email,
              -- New lease + landlord (after re-point)
              new_p.name AS new_property_name,
              new_u.unit_number AS new_unit_number,
              new_lu.first_name || ' ' || new_lu.last_name AS new_landlord_name,
              new_lu.email AS new_landlord_email,
              -- Old landlord — derive from the source security_deposits row
              -- via carried_from_deposit_id if set, else fall back to a
              -- best-effort lookup via the previous landlord's units.
              prev_lu.first_name || ' ' || prev_lu.last_name AS prev_landlord_name,
              prev_lu.email AS prev_landlord_email,
              prev_lu.stripe_connect_account_id AS prev_landlord_connect_id
         FROM security_deposits sd
         JOIN tenants t       ON t.id = sd.tenant_id
         JOIN users   tu      ON tu.id = t.user_id
         JOIN units   new_u   ON new_u.id = sd.unit_id
         JOIN properties new_p ON new_p.id = new_u.property_id
         JOIN landlords new_l  ON new_l.id = new_p.landlord_id
         JOIN users   new_lu   ON new_lu.id = new_l.user_id
         LEFT JOIN security_deposits prev_sd ON prev_sd.id = sd.carried_from_deposit_id
         LEFT JOIN leases    prev_l  ON prev_l.id = prev_sd.lease_id
         LEFT JOIN landlords prev_la ON prev_la.id = prev_l.landlord_id
         LEFT JOIN users     prev_lu ON prev_lu.id = prev_la.user_id
        WHERE sd.portability_status = 'pending_transfer'
        ORDER BY sd.portability_authorized_at DESC NULLS LAST`,
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.post('/deposit-portability/:depositId/mark-transferred', requireAdmin, async (req: any, res, next) => {
  try {
    const { notes } = req.body || {}
    const dep = await queryOne<{ id: string; portability_status: string }>(
      `SELECT id, portability_status FROM security_deposits WHERE id = $1`,
      [req.params.depositId],
    )
    if (!dep) throw new AppError(404, 'Deposit not found')
    if (dep.portability_status !== 'pending_transfer') {
      throw new AppError(409, `Deposit is in '${dep.portability_status}' state; can only mark-transferred from 'pending_transfer'`)
    }

    const stamp = '[Admin transfer confirmed by user ' + req.user!.userId + ' at ' + new Date().toISOString() + ']'
    const noteAppend = notes ? stamp + ' ' + String(notes).slice(0, 500) : stamp

    await query(
      `UPDATE security_deposits
          SET portability_status = 'carried_forward',
              notes              = LEFT(COALESCE(notes || E'\\n', '') || $1, 2000),
              updated_at         = NOW()
        WHERE id = $2`,
      [noteAppend, req.params.depositId],
    )

    res.json({ success: true, data: { id: req.params.depositId, status: 'carried_forward' } })
  } catch (e) { next(e) }
})

// ── S163: Connect readiness backfill ──────────────────────────────────────
//
// Pre-S160 landlord Connect accounts (and pre-S159 PM Connect accounts)
// have connect_payouts_enabled=false even though they may have completed
// KYC at Stripe long ago. Stripe re-fires account.updated periodically
// but not on a known schedule, so the booleans can stay stale indefinitely.
//
// This endpoint walks every users / pm_companies row that has a
// stripe_connect_account_id but isn't yet flagged ready, calls
// fetchAccountStatus live for each, and writes the cached flags. Synchronous
// so the admin sees the result counts inline; rate-limited Stripe API calls
// happen in series (Stripe's default rate limit is ~100/sec for accounts.retrieve
// in test mode, well above expected backfill volume).
adminRouter.post('/connect-readiness/backfill', async (req: any, res, next) => {
  try {
    const result = {
      users: { scanned: 0, updated: 0, errors: 0 },
      pm_companies: { scanned: 0, updated: 0, errors: 0 },
      errors: [] as Array<{ entity: 'user' | 'pm_company'; id: string; message: string }>,
    }

    const userRows = await query<{ id: string; stripe_connect_account_id: string }>(
      `SELECT id, stripe_connect_account_id
         FROM users
        WHERE stripe_connect_account_id IS NOT NULL
          AND (connect_payouts_enabled = false OR connect_details_submitted = false)`
    )
    for (const row of userRows) {
      result.users.scanned++
      try {
        const status = await fetchAccountStatus(row.stripe_connect_account_id)
        await query(
          `UPDATE users
              SET stripe_connect_status_synced_at = NOW(),
                  connect_charges_enabled    = $2,
                  connect_payouts_enabled    = $3,
                  connect_details_submitted  = $4
            WHERE id = $1`,
          [row.id, status.charges_enabled, status.payouts_enabled, status.details_submitted]
        )
        result.users.updated++
      } catch (e: any) {
        result.users.errors++
        result.errors.push({ entity: 'user', id: row.id, message: e?.message ?? String(e) })
      }
    }

    const pmRows = await query<{ id: string; stripe_connect_account_id: string }>(
      `SELECT id, stripe_connect_account_id
         FROM pm_companies
        WHERE stripe_connect_account_id IS NOT NULL
          AND (connect_payouts_enabled = false OR connect_details_submitted = false)`
    )
    for (const row of pmRows) {
      result.pm_companies.scanned++
      try {
        const status = await fetchAccountStatus(row.stripe_connect_account_id)
        await query(
          `UPDATE pm_companies
              SET stripe_connect_status_synced_at = NOW(),
                  connect_charges_enabled    = $2,
                  connect_payouts_enabled    = $3,
                  connect_details_submitted  = $4
            WHERE id = $1`,
          [row.id, status.charges_enabled, status.payouts_enabled, status.details_submitted]
        )
        result.pm_companies.updated++
      } catch (e: any) {
        result.pm_companies.errors++
        result.errors.push({ entity: 'pm_company', id: row.id, message: e?.message ?? String(e) })
      }
    }

    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: 'connect_readiness_backfill',
      metadata: {
        users_scanned: result.users.scanned,
        users_updated: result.users.updated,
        pm_companies_scanned: result.pm_companies.scanned,
        pm_companies_updated: result.pm_companies.updated,
      },
    })

    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// GET /api/admin/connect-readiness/accounts — list every Connect-bearing
// account (user or pm_company), with cached readiness flags + last
// synced_at. Drives the admin ConnectAccountsPage.
adminRouter.get('/connect-readiness/accounts', async (_req, res, next) => {
  try {
    const userRows = await query<any>(`
      SELECT 'user' AS entity_type,
             u.id AS entity_id,
             COALESCE(u.first_name || ' ' || u.last_name, u.email) AS display_name,
             u.email,
             u.role,
             u.stripe_connect_account_id,
             u.connect_charges_enabled,
             u.connect_payouts_enabled,
             u.connect_details_submitted,
             u.stripe_connect_status_synced_at
        FROM users u
       WHERE u.stripe_connect_account_id IS NOT NULL
       ORDER BY u.connect_payouts_enabled ASC, u.email ASC
    `)
    const pmRows = await query<any>(`
      SELECT 'pm_company' AS entity_type,
             c.id AS entity_id,
             c.name AS display_name,
             c.business_email AS email,
             c.status AS role,
             c.stripe_connect_account_id,
             c.connect_charges_enabled,
             c.connect_payouts_enabled,
             c.connect_details_submitted,
             c.stripe_connect_status_synced_at
        FROM pm_companies c
       WHERE c.stripe_connect_account_id IS NOT NULL
       ORDER BY c.connect_payouts_enabled ASC, c.name ASC
    `)
    res.json({ success: true, data: [...userRows, ...pmRows] })
  } catch (e) { next(e) }
})

// GET /api/admin/landlord-banking-nudges — list of tenant→landlord nudge
// emails sent (S163). Drives the admin Connect Accounts page sub-section
// for support visibility into who's been blocked on which landlord's
// onboarding completion. Pulls from email_send_log; no new table.
adminRouter.get('/landlord-banking-nudges', async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT esl.id,
             esl.created_at,
             esl.to_email     AS landlord_email,
             esl.status,
             esl.error_message,
             esl.related_entity_id AS tenant_id,
             esl.metadata,
             esl.landlord_id,
             COALESCE(u_tenant.first_name || ' ' || u_tenant.last_name, u_tenant.email) AS tenant_name,
             COALESCE(u_landlord.first_name || ' ' || u_landlord.last_name, u_landlord.email) AS landlord_name,
             u_landlord.connect_payouts_enabled AS landlord_payouts_enabled,
             u_landlord.connect_details_submitted AS landlord_details_submitted
        FROM email_send_log esl
   LEFT JOIN tenants t          ON t.id = esl.related_entity_id
   LEFT JOIN users u_tenant     ON u_tenant.id = t.user_id
   LEFT JOIN landlords ll       ON ll.id = esl.landlord_id
   LEFT JOIN users u_landlord   ON u_landlord.id = ll.user_id
       WHERE esl.category = 'landlord_banking_nudge'
       ORDER BY esl.created_at DESC
       LIMIT 200
    `)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/admin/connect-readiness/refresh/:entity/:id — refresh one
// row's cached flags from Stripe live state. Single-row complement to
// the bulk backfill above; useful when a support call lands and admin
// wants a fresh read for one specific account.
adminRouter.post('/connect-readiness/refresh/:entity/:id', async (req: any, res, next) => {
  try {
    const entity = req.params.entity
    if (entity !== 'user' && entity !== 'pm_company') {
      throw new AppError(400, "entity must be 'user' or 'pm_company'")
    }
    const table = entity === 'user' ? 'users' : 'pm_companies'

    const row = await queryOne<{ stripe_connect_account_id: string | null }>(
      `SELECT stripe_connect_account_id FROM ${table} WHERE id = $1`,
      [req.params.id]
    )
    if (!row) throw new AppError(404, `${entity} not found`)
    if (!row.stripe_connect_account_id) {
      throw new AppError(400, 'No Connect account on this row')
    }

    const status = await fetchAccountStatus(row.stripe_connect_account_id)
    await query(
      `UPDATE ${table}
          SET stripe_connect_status_synced_at = NOW(),
              connect_charges_enabled    = $2,
              connect_payouts_enabled    = $3,
              connect_details_submitted  = $4
        WHERE id = $1`,
      [req.params.id, status.charges_enabled, status.payouts_enabled, status.details_submitted]
    )

    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: 'connect_readiness_refresh',
      targetId: req.params.id,
      targetType: entity,
      metadata: { stripe_account_id: row.stripe_connect_account_id, ...status },
    })

    res.json({ success: true, data: { ...status } })
  } catch (e) { next(e) }
})


// ── CSV-import review queue (S295 + S296) ─────────────────────────────
// Admin surface for reviewing landlord CSV migrations against real
// source-platform exports. Lists every validate + commit captured by
// the csvImportAttempts service (apps/api/src/services/
// csvImportAttempts.ts).
//
// Access tiers:
//   - List (this endpoint) — admin OR super_admin. Surfaces landlord
//     email + counts + status. No tenant PII at the list level.
//   - Detail (GET :id) — super_admin only. Sample rows carry tenant
//     PII (names, emails) so this is gated tighter.
//   - Mark-reviewed (POST :id/mark-reviewed) — super_admin only.
//   - Verification flip (POST platform-review-statuses) — super_admin
//     only. Reshapes the verification lifecycle.

// GET /api/admin/csv-import-attempts
// Query params:
//   ?status=pending  — only validated|committed (not yet reviewed)
//   ?status=all      — every attempt
//   ?platform=<key>  — filter by platform key
//   ?import_type=tenant|property|payment
//   ?limit=N         — default 50, max 200
adminRouter.get('/csv-import-attempts', async (req, res, next) => {
  try {
    const statusFilter   = String(req.query.status || 'pending').toLowerCase()
    const platformFilter = req.query.platform ? String(req.query.platform).toLowerCase() : null
    const typeFilter     = req.query.import_type ? String(req.query.import_type).toLowerCase() : null
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)

    const where: string[] = []
    const params: any[] = []
    if (statusFilter === 'pending') {
      where.push(`status IN ('validated', 'committed')`)
    } else if (statusFilter === 'reviewed') {
      where.push(`status = 'reviewed'`)
    }
    if (platformFilter) {
      params.push(platformFilter)
      where.push(`platform_key = $${params.length}`)
    }
    if (typeFilter) {
      params.push(typeFilter)
      where.push(`import_type = $${params.length}`)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    params.push(limit)

    const rows = await query<any>(`
      SELECT
        a.id,
        a.landlord_id,
        u.first_name AS landlord_first_name,
        u.last_name  AS landlord_last_name,
        u.email      AS landlord_email,
        a.import_type,
        a.platform_key,
        a.claimed_platform_name,
        a.row_count,
        a.blockers,
        a.warnings,
        a.status,
        a.reviewed_by,
        a.reviewed_at,
        a.created_at,
        jsonb_array_length(a.column_headers) AS column_count
        FROM csv_import_attempts a
        JOIN landlords l ON l.id = a.landlord_id
        JOIN users u     ON u.id = l.user_id
        ${whereSql}
       ORDER BY a.created_at DESC
       LIMIT $${params.length}
    `, params)

    res.json({ success: true, data: { rows, limit, filters: { status: statusFilter, platform: platformFilter, import_type: typeFilter } } })
  } catch (e) { next(e) }
})

// GET /api/admin/csv-import-attempts/:id
// Returns one attempt with full column_headers + sample_rows.
// S298: also returns related_validate_attempt_id — the most-recent
// validate row from the same (landlord, platform, type) that
// preceded this attempt. Lets the admin UI cross-link from a
// commit row (which has empty column_headers / sample_rows) to
// the validate row that captured the actual upload shape.
adminRouter.get('/csv-import-attempts/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const row = await queryOne<any>(`
      SELECT
        a.*,
        u.first_name AS landlord_first_name,
        u.last_name  AS landlord_last_name,
        u.email      AS landlord_email,
        ru.first_name AS reviewer_first_name,
        ru.last_name  AS reviewer_last_name
        FROM csv_import_attempts a
        JOIN landlords l ON l.id = a.landlord_id
        JOIN users u     ON u.id = l.user_id
        LEFT JOIN users ru ON ru.id = a.reviewed_by
       WHERE a.id = $1
    `, [req.params.id])
    if (!row) throw new AppError(404, 'Attempt not found')

    // For commit-status rows, find the most recent preceding validate
    // attempt from the same landlord+platform+type. That row carries
    // the column_headers + sample_rows shape (commit rows store empty
    // arrays — see services/csvImportAttempts.ts).
    let related_validate_attempt_id: string | null = null
    if (row.status === 'committed' || row.status === 'reviewed') {
      const related = await queryOne<{ id: string }>(`
        SELECT id FROM csv_import_attempts
         WHERE landlord_id  = $1
           AND platform_key = $2
           AND import_type  = $3
           AND status = 'validated'
           AND created_at <= $4
         ORDER BY created_at DESC
         LIMIT 1
      `, [row.landlord_id, row.platform_key, row.import_type, row.created_at])
      related_validate_attempt_id = related?.id ?? null
    }

    res.json({ success: true, data: { ...row, related_validate_attempt_id } })
  } catch (e) { next(e) }
})

// POST /api/admin/csv-import-attempts/:id/mark-reviewed
// Marks the attempt as reviewed. Idempotent — re-marking by the same
// admin is a no-op; re-marking by a different admin updates the
// reviewed_by + reviewed_at to the latest.
adminRouter.post('/csv-import-attempts/:id/mark-reviewed', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const reviewerId = req.user!.userId
    const row = await queryOne<any>(`
      UPDATE csv_import_attempts
         SET status      = 'reviewed',
             reviewed_by = $2,
             reviewed_at = NOW()
       WHERE id = $1
       RETURNING id, status, reviewed_by, reviewed_at
    `, [req.params.id, reviewerId])
    if (!row) throw new AppError(404, 'Attempt not found')
    await logAdminAction({
      adminUserId: reviewerId,
      actionType:  'csv_import_attempt.mark_reviewed',
      targetId:    req.params.id,
      targetType:  'csv_import_attempt',
      metadata:    {},
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/admin/csv-import-attempts/_stats/platforms
// Per-platform commit counts — powers the S295 dashboard tile + S296
// verification lifecycle gate. One row per (platform_key, import_type)
// with committed_count; platforms with ≤ 5 commits are still in
// "first 5 review" territory.
adminRouter.get('/csv-import-attempts/_stats/platforms', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT platform_key,
             import_type,
             COUNT(*)::int AS committed_count,
             COUNT(*) FILTER (WHERE status = 'reviewed')::int AS reviewed_count,
             MAX(created_at) AS most_recent
        FROM csv_import_attempts
       WHERE status IN ('committed', 'reviewed')
       GROUP BY platform_key, import_type
       ORDER BY platform_key, import_type
    `)
    res.json({ success: true, data: { rows } })
  } catch (e) { next(e) }
})

// ── S296: Platform verification lifecycle ─────────────────────────────
// Per-(platform_key, import_type) slot. Default 'unverified'. Super
// admin marks 'verified' once they've reviewed enough imports to
// trust the mapping. Verified slots stop generating banner + queue
// noise for landlord uploads.

// GET /api/admin/platform-review-statuses
// Returns every slot — verified rows from platform_review_status,
// merged with commit-count stats from csv_import_attempts. Slots
// with no row in platform_review_status default to 'unverified'.
adminRouter.get('/platform-review-statuses', async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      WITH stats AS (
        SELECT platform_key, import_type,
               COUNT(*)::int AS committed_count,
               COUNT(DISTINCT landlord_id)::int AS distinct_landlords,
               MAX(created_at) AS most_recent_commit
          FROM csv_import_attempts
         WHERE status IN ('committed', 'reviewed')
         GROUP BY platform_key, import_type
      ),
      slots AS (
        -- All slots that have either a verification row OR a commit
        SELECT platform_key, import_type FROM platform_review_status
        UNION
        SELECT platform_key, import_type FROM stats
      )
      SELECT s.platform_key,
             s.import_type,
             COALESCE(p.mapping_status, 'unverified') AS mapping_status,
             p.verified_at,
             p.verified_by,
             p.notes,
             vu.first_name AS verifier_first_name,
             vu.last_name  AS verifier_last_name,
             COALESCE(st.committed_count, 0)     AS committed_count,
             COALESCE(st.distinct_landlords, 0)  AS distinct_landlords,
             st.most_recent_commit
        FROM slots s
        LEFT JOIN platform_review_status p
          ON p.platform_key = s.platform_key
         AND p.import_type  = s.import_type
        LEFT JOIN users vu ON vu.id = p.verified_by
        LEFT JOIN stats st
          ON st.platform_key = s.platform_key
         AND st.import_type  = s.import_type
       ORDER BY s.platform_key, s.import_type
    `)
    res.json({ success: true, data: { rows } })
  } catch (e) { next(e) }
})

// POST /api/admin/platform-review-statuses/:platform_key/:import_type/verify
// Upserts a row to mapping_status='verified', stamping verifier + timestamp.
// Super_admin only — flipping a slot to verified means we've vouched for
// the mapping accuracy, which suppresses the review banner for all future
// landlord uploads from that slot.
adminRouter.post('/platform-review-statuses/:platform_key/:import_type/verify', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const verifierId = req.user!.userId
    const { platform_key, import_type } = req.params
    if (!['tenant','property','payment'].includes(import_type)) {
      throw new AppError(400, `import_type must be tenant/property/payment, got ${import_type}`)
    }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null
    const row = await queryOne<any>(`
      INSERT INTO platform_review_status (
        platform_key, import_type, mapping_status,
        verified_at, verified_by, notes
      ) VALUES ($1, $2, 'verified', NOW(), $3, $4)
      ON CONFLICT (platform_key, import_type) DO UPDATE
        SET mapping_status = 'verified',
            verified_at    = NOW(),
            verified_by    = EXCLUDED.verified_by,
            notes          = COALESCE(EXCLUDED.notes, platform_review_status.notes),
            updated_at     = NOW()
      RETURNING *
    `, [platform_key, import_type, verifierId, notes])
    // S368 fix: targetId omitted — admin_action_log.target_id is uuid
    // typed and the composite slot key "platform:type" isn't a uuid.
    // Pre-S368 every call here silently failed the audit log INSERT
    // (logAdminAction swallows errors via try/catch). Composite key
    // now travels in metadata where it can be queried via jsonb.
    await logAdminAction({
      adminUserId: verifierId,
      actionType:  'platform_review_status.verify',
      targetType:  'platform_review_status',
      metadata:    { platform_key, import_type, notes },
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// POST /api/admin/platform-review-statuses/:platform_key/:import_type/notes
// S316: dedicated notes upsert — independent of verify/unverify so
// editing operational context doesn't restamp verified_at. Upserts a
// row at the slot (creating an 'unverified' row if none exists) and
// overwrites the notes column with whatever the super_admin submitted
// (including empty string to clear). Returns the resulting row.
adminRouter.post('/platform-review-statuses/:platform_key/:import_type/notes', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const adminId = req.user!.userId
    const { platform_key, import_type } = req.params
    if (!['tenant','property','payment'].includes(import_type)) {
      throw new AppError(400, `import_type must be tenant/property/payment, got ${import_type}`)
    }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : ''
    const row = await queryOne<any>(`
      INSERT INTO platform_review_status (
        platform_key, import_type, mapping_status, notes
      ) VALUES ($1, $2, 'unverified', $3)
      ON CONFLICT (platform_key, import_type) DO UPDATE
        SET notes      = EXCLUDED.notes,
            updated_at = NOW()
      RETURNING *
    `, [platform_key, import_type, notes])
    // S368 fix: targetId omitted — see verify route for full rationale.
    await logAdminAction({
      adminUserId: adminId,
      actionType:  'platform_review_status.notes',
      targetType:  'platform_review_status',
      metadata:    { platform_key, import_type, notesLength: notes.length },
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// POST /api/admin/platform-review-statuses/:platform_key/:import_type/unverify
// Reverts a previously-verified slot back to 'unverified'. Used when we
// ship a mapping change that materially alters column handling and want
// to force re-review of the next imports.
adminRouter.post('/platform-review-statuses/:platform_key/:import_type/unverify', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const adminId = req.user!.userId
    const { platform_key, import_type } = req.params
    if (!['tenant','property','payment'].includes(import_type)) {
      throw new AppError(400, `import_type must be tenant/property/payment, got ${import_type}`)
    }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null
    const row = await queryOne<any>(`
      INSERT INTO platform_review_status (
        platform_key, import_type, mapping_status, notes
      ) VALUES ($1, $2, 'unverified', $3)
      ON CONFLICT (platform_key, import_type) DO UPDATE
        SET mapping_status = 'unverified',
            verified_at    = NULL,
            verified_by    = NULL,
            notes          = COALESCE(EXCLUDED.notes, platform_review_status.notes),
            updated_at     = NOW()
      RETURNING *
    `, [platform_key, import_type, notes])
    // S368 fix: targetId omitted — see verify route for full rationale.
    await logAdminAction({
      adminUserId: adminId,
      actionType:  'platform_review_status.unverify',
      targetType:  'platform_review_status',
      metadata:    { platform_key, import_type, notes },
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})


// ── S297: Generic-upload platform claims + promotion candidates ───────
// Generic uploads carry a free-text claimed_platform_name. The
// candidates endpoint groups raw claims by normalized name; once
// ≥ 5 distinct landlords share a normalized name, the group becomes
// a promotion candidate. Promotion logs intent — the actual mapping
// work (adding the platform to PLATFORMS, building the alias arrays)
// happens in a follow-on code-change session.

// GET /api/admin/platform-claims/candidates
// Admin OK. Returns normalized-name groups with claim counts +
// per-import-type breakdown + sample raw spellings. Excludes
// already-promoted names.
adminRouter.get('/platform-claims/candidates', async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      WITH normalized AS (
        SELECT a.landlord_id,
               a.import_type,
               a.claimed_platform_name AS raw_name,
               lower(regexp_replace(a.claimed_platform_name, '[^a-zA-Z0-9]+', '', 'g')) AS normalized_name,
               a.created_at
          FROM csv_import_attempts a
         WHERE a.claimed_platform_name IS NOT NULL
           AND a.claimed_platform_name <> ''
      )
      SELECT n.normalized_name,
             COUNT(DISTINCT n.landlord_id)::int AS distinct_landlords,
             COUNT(*)::int AS total_mentions,
             MAX(n.created_at) AS most_recent_mention,
             jsonb_agg(DISTINCT n.raw_name) AS raw_name_variants,
             jsonb_agg(DISTINCT n.import_type) AS import_types
        FROM normalized n
        LEFT JOIN platform_claim_promotions p
          ON p.normalized_name = n.normalized_name
       WHERE p.normalized_name IS NULL
         AND n.normalized_name <> ''
       GROUP BY n.normalized_name
       ORDER BY distinct_landlords DESC, total_mentions DESC, n.normalized_name
    `)
    res.json({ success: true, data: { rows } })
  } catch (e) { next(e) }
})

// GET /api/admin/platform-claims/promoted
// Admin OK. Audit-trail view of previously-promoted claim names.
adminRouter.get('/platform-claims/promoted', async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT p.normalized_name,
             p.example_raw_name,
             p.promoted_at,
             p.promoted_by,
             u.first_name AS promoter_first_name,
             u.last_name  AS promoter_last_name,
             p.notes
        FROM platform_claim_promotions p
        LEFT JOIN users u ON u.id = p.promoted_by
       ORDER BY p.promoted_at DESC
    `)
    res.json({ success: true, data: { rows } })
  } catch (e) { next(e) }
})

// POST /api/admin/platform-claims/:normalized/promote
// Super_admin only. Marks a normalized claim name as promoted —
// drops it from the candidates list. The actual mapping work
// happens in a follow-on code change.
adminRouter.post('/platform-claims/:normalized/promote', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const promoterId = req.user!.userId
    const normalized = String(req.params.normalized || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (!normalized) throw new AppError(400, 'normalized name required')

    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null

    // Pick the most-common raw spelling as the example, for the
    // audit-trail view to display something human-friendly.
    const exampleRow = await queryOne<{ raw: string }>(`
      SELECT claimed_platform_name AS raw
        FROM csv_import_attempts
       WHERE claimed_platform_name IS NOT NULL
         AND lower(regexp_replace(claimed_platform_name, '[^a-zA-Z0-9]+', '', 'g')) = $1
       GROUP BY claimed_platform_name
       ORDER BY COUNT(*) DESC
       LIMIT 1
    `, [normalized])

    const row = await queryOne<any>(`
      INSERT INTO platform_claim_promotions (
        normalized_name, promoted_by, notes, example_raw_name
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (normalized_name) DO UPDATE
        SET promoted_at      = NOW(),
            promoted_by      = EXCLUDED.promoted_by,
            notes            = COALESCE(EXCLUDED.notes, platform_claim_promotions.notes),
            example_raw_name = COALESCE(EXCLUDED.example_raw_name, platform_claim_promotions.example_raw_name)
      RETURNING *
    `, [normalized, promoterId, notes, exampleRow?.raw ?? null])

    // S368 fix: targetId omitted — `normalized` is a slug like
    // "rentmanager", not a uuid; admin_action_log.target_id is uuid
    // typed. Pre-S368 every promotion's audit log INSERT was
    // silently rejected. Normalized name lives in metadata.
    await logAdminAction({
      adminUserId: promoterId,
      actionType:  'platform_claim.promote',
      targetType:  'platform_claim',
      metadata:    { normalized_name: normalized, example_raw_name: exampleRow?.raw, notes },
    })

    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

