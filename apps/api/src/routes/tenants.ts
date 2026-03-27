import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const tenantsRouter = Router()
tenantsRouter.use(requireAuth)

tenantsRouter.get('/me', async (req, res, next) => {
  try {
    const tenant = await queryOne<any>(`
      SELECT t.*, u.first_name, u.last_name, u.email, u.phone,
        un.id AS unit_id, un.unit_number, un.rent_amount, un.status AS unit_status,
        pr.name AS property_name, pr.street1, pr.city, pr.state
      FROM tenants t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN units un ON un.tenant_id = t.id
      LEFT JOIN properties pr ON pr.id = un.property_id
      WHERE t.id = $1`, [req.user!.profileId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    res.json({ success: true, data: tenant })
  } catch (e) { next(e) }
})

// POST /api/tenants/enroll-on-time-pay — opt-in to float service
tenantsRouter.post('/enroll-on-time-pay', async (req, res, next) => {
  try {
    const { incomeArrivalDay } = z.object({
      incomeArrivalDay: z.number().int().min(1).max(28)
    }).parse(req.body)
    await query(`
      UPDATE tenants SET on_time_pay_enrolled=TRUE, float_fee_active=TRUE,
        income_arrival_day=$1 WHERE id=$2`,
      [incomeArrivalDay, req.user!.profileId])
    res.json({ success: true, message: 'On-Time Pay float service activated — $20/month service fee' })
  } catch (e) { next(e) }
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

// POST /api/tenants/invite — landlord invites a tenant
tenantsRouter.post('/invite', async (req, res, next) => {
  try {
    const { email, firstName, lastName, unitId, phone } = req.body
    if (!email || !firstName || !unitId) {
      return res.status(400).json({ success: false, error: 'Email, name and unit required' })
    }

    // Verify unit belongs to this landlord
    const unit = await queryOne<any>(`
      SELECT u.*, l.user_id as landlord_user_id FROM units u
      JOIN landlords l ON l.id = u.landlord_id
      WHERE u.id = $1`, [unitId])
    if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' })
    if (unit.landlord_user_id !== req.user!.userId && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }
    if (unit.tenant_id) {
      return res.status(409).json({ success: false, error: 'Unit already has a tenant' })
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

    // Assign tenant to unit
    await query('UPDATE units SET tenant_id=$1, status=$2 WHERE id=$3',
      [tenantId, 'active', unitId])

    // Store invite token on user
    await query('UPDATE users SET email_verify_token=$1 WHERE id=$2', [inviteToken, user!.id])

    console.log(`[INVITE] Tenant invite: ${email} — token: ${inviteToken}`)
    console.log(`[INVITE] Accept URL: ${process.env.TENANT_APP_URL}/accept-invite?token=${inviteToken}`)

    res.json({
      success: true,
      data: {
        tenantId,
        email,
        inviteToken,
        acceptUrl: `${process.env.TENANT_APP_URL || 'http://localhost:3002'}/accept-invite?token=${inviteToken}`
      }
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/accept-invite — tenant sets password and activates account
tenantsRouter.post('/accept-invite', async (req, res, next) => {
  try {
    const { token, password, phone, ssiSsdi } = req.body
    if (!token || !password) return res.status(400).json({ success: false, error: 'Token and password required' })
    if (password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' })

    const user = await queryOne<any>('SELECT * FROM users WHERE email_verify_token=$1', [token])
    if (!user) return res.status(404).json({ success: false, error: 'Invalid or expired invite link' })

    const bcrypt = require('bcrypt')
    const hash = await bcrypt.hash(password, 10)

    await query(`UPDATE users SET password_hash=$1, email_verify_token=NULL, email_verified=TRUE, phone=COALESCE($2,phone) WHERE id=$3`,
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

    const user = await queryOne<any>('SELECT id, email, first_name, last_name FROM users WHERE email_verify_token=$1', [token as string])
    if (!user) return res.status(404).json({ success: false, error: 'Invalid or expired invite' })

    const unit = await queryOne<any>(`
      SELECT u.unit_number, u.rent_amount, p.name as property_name, p.street1, p.city, p.state
      FROM units u JOIN properties p ON p.id=u.property_id
      JOIN tenants t ON t.id=u.tenant_id
      WHERE t.user_id=$1`, [user.id])

    res.json({ success: true, data: { user, unit } })
  } catch (e) { next(e) }
})

// GET /api/tenants/:id/profile — full lifetime tenant profile
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

    // All units ever occupied (current + historical via leases)
    const units = await query<any>(`
      SELECT DISTINCT u.id, u.unit_number, u.rent_amount, u.status,
        p.name as property_name, p.street1, p.city, p.state,
        l.start_date, l.end_date,
        CASE WHEN u.tenant_id = $1 THEN true ELSE false END as is_current
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE l.tenant_id = $1
      UNION
      SELECT u.id, u.unit_number, u.rent_amount, u.status,
        p.name as property_name, p.street1, p.city, p.state,
        NULL as start_date, NULL as end_date, true as is_current
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.tenant_id = $1
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

    // Lifetime payment stats
    const paymentStats = await queryOne<any>(`
      SELECT
        COUNT(*) as total_payments,
        COUNT(*) FILTER (WHERE status = 'settled') as settled,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'late') as late,
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
          lateCount:    parseInt(paymentStats?.late || 0),
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
tenantsRouter.post('/:id/transfer', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { newUnitId, newRentAmount, effectiveDate, notes } = req.body
    if (!newUnitId || !newRentAmount || !effectiveDate) {
      return res.status(400).json({ success: false, error: 'newUnitId, newRentAmount, and effectiveDate required' })
    }

    // Get tenant
    const tenant = await queryOne<any>('SELECT * FROM tenants WHERE id=$1', [req.params.id])
    if (!tenant) throw new AppError(404, 'Tenant not found')

    // Get current unit
    const currentUnit = await queryOne<any>(`
      SELECT u.*, l.id as lease_id FROM units u
      LEFT JOIN leases l ON l.unit_id = u.id AND l.tenant_id = $1 AND l.status = 'active'
      WHERE u.tenant_id = $1`, [req.params.id])
    if (!currentUnit) throw new AppError(400, 'Tenant has no current unit')

    // Get new unit — verify it belongs to same landlord and is vacant
    const newUnit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [newUnitId, req.user!.profileId])
    if (!newUnit) throw new AppError(404, 'New unit not found or access denied')
    if (newUnit.tenant_id) throw new AppError(400, 'New unit is already occupied')

    // Calculate proration if rent changed and mid-month transfer
    const transferDate = new Date(effectiveDate)
    const oldRent = parseFloat(currentUnit.rent_amount)
    const newRent = parseFloat(newRentAmount)
    const rentChanged = Math.abs(oldRent - newRent) > 0.01
    let proratedAmount = null

    if (rentChanged) {
      const daysInMonth = new Date(transferDate.getFullYear(), transferDate.getMonth() + 1, 0).getDate()
      const daysRemaining = daysInMonth - transferDate.getDate() + 1
      proratedAmount = (newRent / daysInMonth) * daysRemaining
    }

    const isImmediate = new Date(effectiveDate) <= new Date()

    if (isImmediate) {
      // Execute transfer now
      // 1. End current lease
      if (currentUnit.lease_id) {
        await query('UPDATE leases SET status=$1, end_date=$2 WHERE id=$3', ['ended', effectiveDate, currentUnit.lease_id])
      }

      // 2. Vacate old unit
      await query('UPDATE units SET tenant_id=NULL, status=$1 WHERE id=$2', ['vacant', currentUnit.id])

      // 3. Create new lease
      await query(`
        INSERT INTO leases (unit_id, tenant_id, start_date, status, rent_amount)
        VALUES ($1, $2, $3, 'active', $4)`,
        [newUnitId, req.params.id, effectiveDate, newRent])

      // 4. Assign tenant to new unit with new rent
      await query('UPDATE units SET tenant_id=$1, rent_amount=$2, status=$3 WHERE id=$4',
        [req.params.id, newRent, 'active', newUnitId])

      // 5. Copy maintenance history reference (not actual requests)
      await query(`
        INSERT INTO maintenance_requests
          (unit_id, tenant_id, title, description, priority, status, actual_cost, created_at, notes)
        SELECT $1, tenant_id, title, '[Transferred from Unit '||$2||'] '||title,
          priority, status, actual_cost, created_at,
          'Read-only copy — original request on Unit '||$3
        FROM maintenance_requests
        WHERE unit_id = $4 AND tenant_id = $5
        ON CONFLICT DO NOTHING`,
        [newUnitId, currentUnit.unit_number, currentUnit.unit_number, currentUnit.id, req.params.id])
    } else {
      // Schedule for future — store in a transfers table
      await query(`
        INSERT INTO scheduled_transfers
          (tenant_id, from_unit_id, to_unit_id, new_rent_amount, effective_date, status, notes, prorated_amount)
        VALUES ($1,$2,$3,$4,$5,'scheduled',$6,$7)`,
        [req.params.id, currentUnit.id, newUnitId, newRent, effectiveDate, notes || null, proratedAmount])
    }

    res.json({
      success: true,
      data: {
        transferred: isImmediate,
        scheduled: !isImmediate,
        effectiveDate,
        fromUnit: currentUnit.unit_number,
        toUnit: newUnit.unit_number,
        oldRent,
        newRent,
        proratedAmount,
        rentChanged,
      }
    })
  } catch (e) { next(e) }
})

// GET /api/tenants/:id/available-units — vacant units for transfer
tenantsRouter.get('/:id/available-units', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const units = await query<any>(`
      SELECT u.id, u.unit_number, u.rent_amount, u.bedrooms, u.bathrooms, u.sqft,
        p.name as property_name, p.street1, p.city
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = $1 AND u.tenant_id IS NULL AND u.status = 'vacant'
      ORDER BY p.name, u.unit_number`,
      [req.user!.profileId])
    res.json({ success: true, data: units })
  } catch (e) { next(e) }
})

// ── TENANT PROFILE UPDATE ─────────────────────────────────────
tenantsRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const { phone, email } = req.body
    await query('UPDATE users SET phone=$1, email=$2 WHERE id=$3',
      [phone||null, email, req.user!.userId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

tenantsRouter.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
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
    const unit = await queryOne<any>('SELECT * FROM units WHERE tenant_id=$1', [tenant.id])
    if (!unit) throw new AppError(404, 'No active unit')
    const lease = await queryOne<any>(`
      SELECT l.*, p.name as property_name, u.unit_number,
        lu.first_name || ' ' || lu.last_name as landlord_name,
        tu.first_name || ' ' || tu.last_name as tenant_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu ON lu.id = la.user_id
      LEFT JOIN tenants te ON te.id = u.tenant_id
      LEFT JOIN users tu ON tu.id = te.user_id
      WHERE l.unit_id = $1 AND l.status IN ('pending','active','active')
      ORDER BY l.created_at DESC LIMIT 1`, [unit.id])
    res.json({ success: true, data: lease })
  } catch (e) { next(e) }
})

tenantsRouter.post('/lease/sign', requireAuth, async (req, res, next) => {
  try {
    const { signature, signatureType } = req.body
    if (!signature) throw new AppError(400, 'Signature required')
    const tenant = await queryOne<any>('SELECT t.id FROM tenants t WHERE t.user_id=$1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    const unit = await queryOne<any>('SELECT * FROM units WHERE tenant_id=$1', [tenant.id])
    if (!unit) throw new AppError(404, 'No active unit')
    const lease = await queryOne<any>("SELECT * FROM leases WHERE unit_id=$1 AND status IN ('pending','active') ORDER BY created_at DESC LIMIT 1", [unit.id])
    if (!lease) throw new AppError(404, 'No lease found')
    if (lease.signed_by_tenant || lease.tenant_signed_at) throw new AppError(400, 'Already signed')
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
    const ua = req.headers['user-agent']
    await query("UPDATE leases SET signed_by_tenant=TRUE, tenant_signature=$1, tenant_signed_at=NOW(), tenant_signed_ip=$2, status='active' WHERE id=$3", [signature, ip, lease.id])
    await query(`INSERT INTO lease_signature_audit (lease_id, signer_role, signer_name, signer_email, signature, ip_address, user_agent, signed_at)
      SELECT $1, 'tenant', u.first_name || ' ' || u.last_name, u.email, $2, $3, $4, NOW()
      FROM users u WHERE u.id=$5`, [lease.id, signature, ip, ua, req.user!.userId])
    if (lease.signed_by_landlord) {
      await query("UPDATE units SET on_time_pay_active=TRUE, status='active' WHERE id=$1", [unit.id])
    }
    res.json({ success: true })
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

tenantsRouter.get('/charge-account', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT t.id FROM tenants t WHERE t.user_id=$1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    const transactions = await query<any>(`
      SELECT pt.*, u.unit_number, p.name as property_name
      FROM pos_transactions pt
      LEFT JOIN units u ON u.id = pt.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE pt.tenant_id = $1
      ORDER BY pt.created_at DESC LIMIT 50`, [tenant.id])
    const balance = await queryOne<any>(`
      SELECT COALESCE(SUM(total) FILTER (WHERE payment_method='charge' AND settled=FALSE), 0) as outstanding,
        COALESCE(SUM(total) FILTER (WHERE payment_method='charge'), 0) as total_charged
      FROM pos_transactions WHERE tenant_id=$1`, [tenant.id])
    res.json({ success: true, data: { transactions, balance } })
  } catch (e) { next(e) }
})
