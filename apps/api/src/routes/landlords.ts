import { Router } from 'express'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireAdmin, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { emailTenantOnboarded } from '../services/email'
import { parse as parseCsv } from 'csv-parse/sync'
import multer from 'multer'
import path from 'path'
import fs from 'fs'

export const landlordsRouter = Router()
landlordsRouter.use(requireAuth)

landlordsRouter.get('/', requireAdmin, async (_req, res, next) => {
  try {
    const landlords = await query<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, u.phone,
        COUNT(DISTINCT p.id)::int AS property_count,
        COUNT(DISTINCT u2.id)::int AS unit_count,
        COUNT(DISTINCT u2.id) FILTER (WHERE u2.status='active')::int AS occupied_count
      FROM landlords l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN properties p ON p.landlord_id = l.id
      LEFT JOIN units u2 ON u2.landlord_id = l.id
      GROUP BY l.id, u.first_name, u.last_name, u.email, u.phone
      ORDER BY u.last_name`)
    res.json({ success: true, data: landlords })
  } catch (e) { next(e) }
})



// ── FLEXCHARGE LANDLORD ROUTES ────────────────────────────────────────────

landlordsRouter.get('/flexcharge', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const accounts = await query<any>(`
      SELECT fca.*, u.first_name, u.last_name, u.email, un.unit_number
      FROM flex_charge_accounts fca
      JOIN tenants t ON t.id = fca.tenant_id
      JOIN users u ON u.id = t.user_id
      LEFT JOIN LATERAL (
        SELECT un2.unit_number
        FROM v_lease_active_tenants vlat
        JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        JOIN units un2 ON un2.id = l.unit_id
        WHERE vlat.tenant_id = t.id
        ORDER BY (vlat.role = 'primary') DESC
        LIMIT 1
      ) un ON TRUE
      WHERE fca.landlord_id = $1
      ORDER BY u.last_name`, [req.user!.profileId])
    res.json({ success: true, data: accounts })
  } catch (e) { next(e) }
})

landlordsRouter.post('/flexcharge', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { tenantId, creditLimit } = req.body
    if (!tenantId) return res.status(400).json({ success: false, error: 'tenantId required' })
    const tenant = await queryOne<any>(`
      SELECT DISTINCT t.id FROM tenants t
      JOIN v_lease_active_tenants vlat ON vlat.tenant_id = t.id
      JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
      JOIN units u ON u.id = l.unit_id
      WHERE t.id=$1 AND u.landlord_id=$2`, [tenantId, req.user!.profileId])
    if (!tenant) return res.status(403).json({ success: false, error: 'Tenant not found or not yours' })
    await query(`
      INSERT INTO flex_charge_accounts (tenant_id, landlord_id, credit_limit, status)
      VALUES ($1, $2, $3, 'active')
      ON CONFLICT (tenant_id) DO UPDATE SET credit_limit=$3, status='active', updated_at=NOW()`,
      [tenantId, req.user!.profileId, creditLimit || null])
    res.json({ success: true })
  } catch (e) { next(e) }
})

landlordsRouter.delete('/flexcharge/:tenantId', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    await query(`UPDATE flex_charge_accounts SET status='suspended', updated_at=NOW()
      WHERE tenant_id=$1 AND landlord_id=$2`, [req.params.tenantId, req.user!.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

landlordsRouter.patch('/flexcharge/:tenantId', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { creditLimit } = req.body
    await query(`UPDATE flex_charge_accounts SET credit_limit=$1, updated_at=NOW()
      WHERE tenant_id=$2 AND landlord_id=$3`, [creditLimit, req.params.tenantId, req.user!.profileId])
    res.json({ success: true })
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
landlordsRouter.patch('/theme', requireAuth, async (req, res, next) => {
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
    if (req.user!.role !== 'admin' && req.user!.role !== 'super_admin' && id !== req.user!.profileId)
      throw new AppError(403, 'Forbidden')
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
    if (req.user!.role !== 'admin' && req.user!.role !== 'super_admin' && id !== req.user!.profileId) throw new AppError(403,'Forbidden')
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
landlordsRouter.patch('/me', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { businessName, ein, bgCheckFee, bgCheckFeeMin, maintApprovalThreshold } = req.body
    await query(`
      UPDATE landlords SET
        business_name = COALESCE($1, business_name),
        ein = COALESCE($2, ein),
        bg_check_fee = COALESCE($3, bg_check_fee),
        bg_check_fee_min = COALESCE($4, bg_check_fee_min),
        maint_approval_threshold = COALESCE($5, maint_approval_threshold),
        updated_at = NOW()
      WHERE id = $6`,
      [businessName||null, ein||null, bgCheckFee||null, bgCheckFeeMin||null, maintApprovalThreshold||null, req.user!.profileId]
    )
    const updated = await queryOne<any>('SELECT * FROM landlords WHERE id=$1', [req.user!.profileId])
    res.json({ success: true, data: updated })
  } catch(e) { next(e) }
})


// ── GET /api/landlords/me/todos ───────────────────────────────────────────
// Returns actionable signals for the dashboard to-do card.
// Three categories: lease issues, ACH issues, high-$ maintenance.
landlordsRouter.get('/me/todos', requireLandlord, async (req, res, next) => {
  try {
    const landlordId = req.user!.profileId

    // Pull landlord record for stripe_bank_verified flag
    const landlord = await queryOne<any>(
      'SELECT stripe_bank_verified FROM landlords WHERE id=$1',
      [landlordId]
    )

    // ── LEASE ISSUES ──────────────────────────────────────
    // needs_review OR expiring within that lease's own expiration_notice_days window
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
    `, [landlordId])

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

    // 1. Landlord's own bank not verified
    if (!landlord?.stripe_bank_verified) {
      ach.push({
        id: 'landlord-bank',
        type: 'landlord_bank',
        title: 'Connect and verify your bank account',
        subtitle: 'Required to receive On-Time Pay disbursements.',
        href: '/settings',
      })
    }

    // 2. Active units with unverified tenant ACH
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
        AND (t.ach_verified = false OR t.ach_verified IS NULL)
      ORDER BY u.unit_number
    `, [landlordId])

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

    // 3. Recent failed rent pulls (last 30 days)
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
      LEFT JOIN tenants t ON t.id = p.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      WHERE p.landlord_id = $1
        AND p.type = 'rent'
        AND p.status IN ('failed', 'returned')
        AND p.due_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY p.unit_id, p.due_date DESC
    `, [landlordId])

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
landlordsRouter.post('/me/onboard-tenant', requireLandlord, async (req, res, next) => {
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
    if (ar && !['extend_same_term', 'convert_to_month_to_month'].includes(arMode)) {
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
    const inviteToken = require('crypto').randomBytes(32).toString('hex')
    await client.query('UPDATE users SET email_verify_token=$1 WHERE id=$2', [inviteToken, userId])

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

    // 4. Lease row (imported, active, needs_review)
    const lease = await client.query(
      `INSERT INTO leases (
         unit_id, landlord_id, status, start_date, end_date, rent_amount,
         security_deposit, late_fee_initial_amount, late_fee_grace_days,
         lease_type, auto_renew, auto_renew_mode,
         notice_days_required, needs_review, lease_source
       ) VALUES (
         $1, $2, 'active', $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11,
         $12, TRUE, 'imported'
       ) RETURNING id`,
      [
        unitId, landlordId, leaseStart, leaseEnd || null, rentNum,
        securityDeposit ?? 0,
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
      await emailTenantOnboarded(emailNorm, firstName, landlordName, propertyAddress, unitLabel, activationUrl)
    } catch (emailErr) {
      console.error('[ONBOARD] Email send failed for', emailNorm, emailErr)
      // TODO(deferred): surface email failure to landlord UI. For now, the tenant
      // is created and the activation URL is logged below for manual recovery.
      console.log(`[ONBOARD] Manual activation URL: ${activationUrl}`)
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
  resolvedUnitId?: string
  resolvedExistingUserId?: string
  resolvedExistingTenantId?: string
  issues: CsvIssue[]
}

const CSV_GENERIC_HEADERS = [
  'first_name', 'last_name', 'email', 'phone',
  'property_name', 'unit_number',
  'lease_start', 'lease_end', 'monthly_rent',
  'security_deposit', 'late_fee_amount', 'late_fee_grace_days',
  'auto_renew', 'auto_renew_mode', 'notice_days_required',
]

// ── PENDING TENANT INTENTS (S29c-2-A: limbo-state onboarding) ──────────
// Landlord types name + email + phone, no lease info. Creates user (no
// activation token, no email send) + tenant + intent row. The tenant sits
// in the pending pool until the landlord uploads a lease PDF and the parser
// builds a real lease from it. Activation email fires only at lease creation.

// POST /api/landlords/me/onboard-tenant-pending
// Body: { firstName, lastName, email, phone }
landlordsRouter.post('/me/onboard-tenant-pending', requireLandlord, async (req, res, next) => {
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


// GET /api/landlords/me/pending-tenants
// Returns this landlord's unresolved pending intents, joined to user info.
// The pending list page reads from this. Resolved intents are excluded —
// once a lease is built, the intent disappears from the active queue.
landlordsRouter.get('/me/pending-tenants', requireLandlord, async (req, res, next) => {
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
landlordsRouter.delete('/me/pending-tenants/:intentId', requireLandlord, async (req, res, next) => {
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
      const filename = intent.imported_pdf_url.split('/').pop()
      if (filename) {
        const filePath = path.join(pendingPdfDir, filename)
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) }
        catch (e) { console.error('[PENDING DELETE] Failed to remove PDF', filePath, e) }
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

// ── PARSER STUB ────────────────────────────────────────────────────────
// Real parser lands in S29c-2-C. Until then, every uploaded PDF flips to
// parser_status='error' after a 2s delay so the UI can demonstrate the
// async-parsing flow end-to-end. When the real parser arrives, this stub is
// ripped and replaced with the actual invocation (probably enqueueing onto
// the same job runner pattern as jobs/scheduler.ts).
function schedulePendingParserStub(intentId: string): void {
  setTimeout(async () => {
    try {
      await query(
        `UPDATE pending_tenant_intents
         SET parser_status='error',
             parser_error='Parser not yet implemented. PDF stored, ready for S29c-2-C parser session.',
             parser_finished_at=NOW(),
             updated_at=NOW()
         WHERE id=$1 AND parser_status='parsing'`,
        [intentId]
      )
    } catch (e) {
      console.error('[PARSER STUB] Failed to update intent', intentId, e)
    }
  }, 2000)
}

// POST /api/landlords/me/pending-tenants/:intentId/document
// multipart/form-data with field name 'file'. Stores PDF, updates intent,
// returns immediately. Parser runs async; landlord polls /me/pending-tenants
// to see status transition from 'parsing' to 'parsed'/'mismatch'/'error'.
landlordsRouter.post(
  '/me/pending-tenants/:intentId/document',
  requireLandlord,
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
        const oldFilename = intent.imported_pdf_url.split('/').pop()
        if (oldFilename) {
          const oldPath = path.join(pendingPdfDir, oldFilename)
          try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath) } catch { /* best effort */ }
        }
      }

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
        [fileUrl, intentId]
      )

      schedulePendingParserStub(intentId)

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
  requireLandlord,
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

      const filename = intent.imported_pdf_url.split('/').pop()
      if (!filename) throw new AppError(500, 'Stored document path is malformed')

      const filePath = path.join(pendingPdfDir, filename)
      if (!fs.existsSync(filePath)) throw new AppError(404, 'File missing on disk')

      res.setHeader('Content-Type', 'application/pdf')
      res.sendFile(filePath)
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

// GET /api/landlords/me/onboard-tenants-csv/template?source=generic
landlordsRouter.get('/me/onboard-tenants-csv/template', requireLandlord, async (req, res, next) => {
  try {
    const source = String(req.query.source || 'generic').toLowerCase()
    if (source !== 'generic') {
      throw new AppError(400, 'Only generic template is supported in this version. Platform-specific templates (Buildium, AppFolio, DoorLoop, etc) coming soon.')
    }

    const header = CSV_GENERIC_HEADERS.join(',')
    const exampleRow = [
      'Jane', 'Doe', 'jane@example.com', '555-123-4567',
      'Sunset Apartments', '4B',
      '2024-06-01', '2025-05-31', '1850',
      '1850', '50', '5',
      'no', '', '30',
    ].join(',')

    const csv = `${header}\n${exampleRow}\n`
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="gam-onboarding-template.csv"')
    res.send(csv)
  } catch (e) { next(e) }
})


// POST /api/landlords/me/onboard-tenants-csv/validate
// Body: { csv: string, source: 'generic' }
// Returns: { rows: CsvRow[], summary: { total, blockers, warnings, ready } }
landlordsRouter.post('/me/onboard-tenants-csv/validate', requireLandlord, async (req, res, next) => {
  try {
    const { csv, source } = req.body
    if (!csv) throw new AppError(400, 'csv body required')
    if (source && source !== 'generic') {
      throw new AppError(400, 'Only generic source is supported in this version')
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
      if (arBool === true && !['extend_same_term', 'convert_to_month_to_month'].includes(row.autoRenewMode)) {
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
// Body: { rows: CsvRow[] } — landlord-corrected rows from /validate.
landlordsRouter.post('/me/onboard-tenants-csv/commit', requireLandlord, async (req, res, next) => {
  const client = await getClient()
  try {
    const { rows } = req.body
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(400, 'rows array required')
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

      const lease = await client.query(
        `INSERT INTO leases (
           unit_id, landlord_id, status, start_date, end_date, rent_amount,
           security_deposit, late_fee_initial_amount, late_fee_grace_days,
           lease_type, auto_renew, auto_renew_mode,
           notice_days_required, needs_review, lease_source
         ) VALUES (
           $1, $2, 'active', $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11,
           $12, TRUE, 'imported'
         ) RETURNING id`,
        [
          unitId, landlordId,
          primary.leaseStart, primary.leaseEnd || null, parseFloat(primary.monthlyRent),
          primary.securityDeposit ? parseFloat(primary.securityDeposit) : 0,
          primary.lateFeeAmount ? parseFloat(primary.lateFeeAmount) : 15.00,
          primary.lateFeeGraceDays ? parseInt(primary.lateFeeGraceDays) : 5,
          leaseType, arBool, arMode,
          primary.noticeDaysRequired ? parseInt(primary.noticeDaysRequired) : 30,
        ]
      )
      const leaseId = lease.rows[0].id

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

        const inviteToken = require('crypto').randomBytes(32).toString('hex')
        await client.query('UPDATE users SET email_verify_token=$1 WHERE id=$2', [inviteToken, userId])

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
        await emailTenantOnboarded(c.email, c.firstName, landlordName, propertyAddress, unitLabel, c.activationUrl)
      } catch (emailErr) {
        console.error('[ONBOARD CSV] Email send failed for', c.email, emailErr)
        console.log(`[ONBOARD CSV] Manual activation URL for ${c.email}: ${c.activationUrl}`)
      }
    }

    res.json({
      success: true,
      data: {
        committed: created.length,
        leases: groups.size,
        tenants: created.map(c => ({ email: c.email, tenantId: c.tenantId, leaseId: c.leaseId })),
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

