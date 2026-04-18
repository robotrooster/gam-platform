import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

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
        (SELECT COUNT(*)::int FROM ach_monitoring_log WHERE flagged=TRUE AND resolved=FALSE) AS zero_tolerance_events
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
    const [stats] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE return_code IS NOT NULL) AS total_returns,
        COUNT(*) FILTER (WHERE zero_tolerance_flag=TRUE) AS zero_tolerance_events,
        COUNT(*) FILTER (WHERE event_type='first_sender') AS first_senders_30d,
        COUNT(*) FILTER (WHERE event_type='velocity_flag') AS velocity_flags_30d
      FROM ach_monitoring_log WHERE created_at > NOW() - INTERVAL '30 days'`)
    res.json({ success: true, data: { logs, stats } })
  } catch (e) { next(e) }
})

// ── BULLETIN BOARD (super_admin) ──────────────────────────────

const requireSuperAdmin = (req: any, res: any, next: any) => {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ success: false, error: 'super_admin required' })
  next()
}

adminRouter.get('/bulletin', requireSuperAdmin, async (req, res, next) => {
  try {
    const { date } = req.query
    const dateFilter = date
      ? `AND DATE(b.created_at) = '${date}'`
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
      LIMIT 500`, [])
    res.json({ success: true, data: posts })
  } catch (e) { next(e) }
})

adminRouter.get('/bulletin/:id/reveal', requireSuperAdmin, async (req, res, next) => {
  try {
    const isSuperAdmin = req.user!.role === 'super_admin'
    if (!isSuperAdmin) throw new AppError(403, 'super_admin required')

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
    res.json({ success: true })
  } catch (e) { next(e) }
})

adminRouter.post('/bulletin/:id/remove', requireSuperAdmin, async (req, res, next) => {
  try {
    await query('UPDATE bulletin_posts SET is_removed=TRUE, removed_at=NOW(), removed_by=$1 WHERE id=$2', [req.user!.userId, req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── ONBOARDING OVERVIEW (regular admin) ──────────────────────
adminRouter.get('/onboarding/overview', async (_req, res, next) => {
  try {
    const [stats] = await query<any>(`
      SELECT
        (SELECT COUNT(*)::int FROM landlords WHERE onboarding_complete=FALSE) AS landlords_incomplete,
        (SELECT COUNT(*)::int FROM landlords WHERE stripe_bank_verified=FALSE) AS landlords_no_bank,
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
      `SELECT l.*, u.first_name, u.last_name, u.email, u.phone
       FROM landlords l JOIN users u ON u.id = l.user_id
       WHERE l.id = $1`, [req.params.id]
    )
    if (!landlord) throw new Error('Landlord not found')

    const [counts] = await query<any>(
      `SELECT
         COUNT(DISTINCT p.id)::int AS property_count,
         COUNT(DISTINCT u.id)::int AS unit_count,
         COUNT(DISTINCT u.id) FILTER (WHERE vuo.is_occupied)::int AS units_with_tenants,
         COUNT(DISTINCT l.id) FILTER (WHERE l.status='active')::int AS active_leases
       FROM landlords ld
       LEFT JOIN properties p ON p.landlord_id = ld.id
       LEFT JOIN units u ON u.landlord_id = ld.id
       LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
       LEFT JOIN leases l ON l.landlord_id = ld.id
       WHERE ld.id = $1`, [req.params.id]
    )

    const checklist = [
      { key: 'account_created',   label: 'Account created',         done: true },
      { key: 'bank_verified',     label: 'Bank account verified',    done: landlord.stripe_bank_verified },
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
      { key: 'flex_credit',       label: 'FlexCredit enrolled',     done: tenant.credit_reporting_enrolled },
      { key: 'flex_pay',          label: 'FlexPay enrolled',        done: tenant.float_fee_active },
    ]

    res.json({ success: true, data: { tenant, checklist } })
  } catch (e) { next(e) }
})

// ── RESEND ACTIONS ────────────────────────────────────────────
adminRouter.post('/onboarding/resend', async (req, res, next) => {
  try {
    const { type, targetId } = req.body
    // Log the resend action — real email wired when Resend is connected
    await query(
      `INSERT INTO admin_action_log (admin_user_id, action_type, target_id, notes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [req.user!.userId, `resend_${type}`, targetId, `Resend triggered by admin at ${new Date().toISOString()}`]
    ).catch(() => null) // table may not exist yet, non-blocking
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
      [req.user.id, resolution, notes || null, flag.id])

    // Update the flagged property's status based on resolution
    const newStatus =
      resolution === 'approved_separate' ? 'active' :
      resolution === 'merged'            ? 'active' :
      /* rejected */                       'rejected'
    await query(`UPDATE properties SET review_status=$1 WHERE id=$2`, [newStatus, flag.property_id])

    res.json({ success: true })
  } catch (e) { next(e) }
})
