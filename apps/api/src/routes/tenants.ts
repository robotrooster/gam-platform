import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
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

    const now = new Date()
    const qualifies = row?.deposit_fully_funded === true

    await query(`
      UPDATE tenants
      SET ach_verified = TRUE,
          bank_last4 = $1,
          otp_qualified_at = CASE WHEN $2 THEN $3 ELSE otp_qualified_at END
      WHERE id = $4`,
      [last4, qualifies, now, req.user!.profileId])

    res.json({
      success: true,
      data: {
        ach_verified: true,
        otp_qualified_at: qualifies ? now : null,
        deposit_fully_funded: qualifies,
        message: qualifies
          ? 'Bank verified and OTP qualified!'
          : 'Bank verified. OTP will activate once your deposit is fully funded.'
      }
    })
  } catch (e) { next(e) }
})



// ── FLEXCHARGE ROUTES ─────────────────────────────────────────────────────

// GET /api/tenants/flexcharge — get my charge account
tenantsRouter.get('/flexcharge', async (req, res, next) => {
  try {
    const account = await queryOne<any>(`
      SELECT fca.*,
        COALESCE(json_agg(fct ORDER BY fct.created_at DESC) FILTER (WHERE fct.id IS NOT NULL), '[]') AS transactions
      FROM flex_charge_accounts fca
      LEFT JOIN flex_charge_transactions fct ON fct.account_id = fca.id
      WHERE fca.tenant_id = $1
      GROUP BY fca.id`, [req.user!.profileId])
    res.json({ success: true, data: account || null })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexcharge/dispute/:txId — dispute a charge
tenantsRouter.post('/flexcharge/dispute/:txId', async (req, res, next) => {
  try {
    const tx = await queryOne<any>(
      'SELECT fct.*, fca.tenant_id FROM flex_charge_transactions fct JOIN flex_charge_accounts fca ON fca.id = fct.account_id WHERE fct.id=$1',
      [req.params.txId]
    )
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction not found' })
    if (tx.tenant_id !== req.user!.profileId) return res.status(403).json({ success: false, error: 'Forbidden' })
    if (tx.status === 'pulled') return res.status(400).json({ success: false, error: 'Cannot dispute already-pulled charge' })

    await query('UPDATE flex_charge_transactions SET status=$1, disputed_at=NOW() WHERE id=$2', ['disputed', tx.id])
    await query(`
      UPDATE flex_charge_accounts SET status='disqualified', disqualified_at=NOW(), disqualified_reason='Tenant dispute'
      WHERE tenant_id=$1`, [req.user!.profileId])

    res.json({ success: true, message: 'Dispute recorded. Account closes after next scheduled pull.' })
  } catch (e) { next(e) }
})

// ── FLEXPAY TIER CALCULATOR ────────────────────────────────────────────────
function getFlexPayTier(pullDay: number | null, pattern: string | null): { tier: string; fee: number; label: string } {
  if (pattern) return { tier: 'variable', fee: 10, label: 'Variable (SSI/SSDI)' }
  if (!pullDay) return { tier: 'none', fee: 0, label: 'Not enrolled' }
  if (pullDay <= 5)  return { tier: 'early',    fee: 3,  label: 'Early (1st–5th)' }
  if (pullDay <= 15) return { tier: 'standard', fee: 7,  label: 'Standard (6th–15th)' }
  return             { tier: 'extended',  fee: 12, label: 'Extended (16th–25th)' }
}

// ── GET /api/tenants/flexpay ───────────────────────────────────────────────
tenantsRouter.get('/flexpay', async (req, res, next) => {
  try {
    const tenant = await queryOne<any>(`
      SELECT t.flexpay_enrolled, t.flexpay_tier, t.flexpay_pull_day,
             t.flexpay_pull_pattern, t.flexpay_fee, t.flexpay_enrolled_at,
             t.ach_verified, t.otp_qualified_at,
             CASE
               WHEN sd.id IS NULL THEN false
               WHEN sd.flex_deposit_enabled = true AND sd.installments_remaining > 0 THEN false
               WHEN sd.collected_amount >= sd.total_amount THEN true
               ELSE false
             END AS deposit_fully_funded
      FROM tenants t
      LEFT JOIN security_deposits sd ON sd.tenant_id = t.id
      WHERE t.id = $1`, [req.user!.profileId])

    const tierInfo = getFlexPayTier(tenant?.flexpay_pull_day, tenant?.flexpay_pull_pattern)

    res.json({ success: true, data: { ...tenant, tierInfo } })
  } catch (e) { next(e) }
})

// ── POST /api/tenants/flexpay/enroll ──────────────────────────────────────
tenantsRouter.post('/flexpay/enroll', async (req, res, next) => {
  try {
    const { pullDay, pullPattern } = req.body

    // Gate: must have deposit funded + ACH verified
    const tenant = await queryOne<any>(`
      SELECT t.ach_verified,
        CASE
          WHEN sd.id IS NULL THEN false
          WHEN sd.flex_deposit_enabled = true AND sd.installments_remaining > 0 THEN false
          WHEN sd.collected_amount >= sd.total_amount THEN true
          ELSE false
        END AS deposit_fully_funded
      FROM tenants t
      LEFT JOIN security_deposits sd ON sd.tenant_id = t.id
      WHERE t.id = $1`, [req.user!.profileId])

    if (!tenant?.deposit_fully_funded)
      return res.status(400).json({ success: false, error: 'Deposit must be fully funded to enroll in FlexPay' })
    if (!tenant?.ach_verified)
      return res.status(400).json({ success: false, error: 'Bank account must be verified to enroll in FlexPay' })

    if (!pullDay && !pullPattern)
      return res.status(400).json({ success: false, error: 'Pull day or pattern required' })
    if (pullDay && (pullDay < 1 || pullDay > 25))
      return res.status(400).json({ success: false, error: 'Pull day must be between 1 and 25' })

    const tierInfo = getFlexPayTier(pullDay || null, pullPattern || null)

    await query(`
      UPDATE tenants SET
        flexpay_enrolled = TRUE,
        flexpay_tier = $1,
        flexpay_pull_day = $2,
        flexpay_pull_pattern = $3,
        flexpay_fee = $4,
        flexpay_enrolled_at = NOW()
      WHERE id = $5`,
      [tierInfo.tier, pullDay || null, pullPattern || null, tierInfo.fee, req.user!.profileId])

    // Stamp otp_qualified_at if not already set (ACH + deposit both satisfied)
    await query(`
      UPDATE tenants SET otp_qualified_at = NOW()
      WHERE id = $1 AND otp_qualified_at IS NULL AND ach_verified = TRUE`,
      [req.user!.profileId])

    res.json({ success: true, data: { tier: tierInfo.tier, fee: tierInfo.fee, label: tierInfo.label, pullDay, pullPattern } })
  } catch (e) { next(e) }
})

// ── DELETE /api/tenants/flexpay ───────────────────────────────────────────
tenantsRouter.delete('/flexpay', async (req, res, next) => {
  try {
    await query(`
      UPDATE tenants SET
        flexpay_enrolled = FALSE, flexpay_tier = NULL,
        flexpay_pull_day = NULL, flexpay_pull_pattern = NULL,
        flexpay_fee = NULL, flexpay_enrolled_at = NULL
      WHERE id = $1`, [req.user!.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/tenants/enroll-on-time-pay — opt-in to float service
tenantsRouter.post('/enroll-on-time-pay', async (req, res, next) => {
  try {
    const { incomeArrivalDay } = z.object({
      incomeArrivalDay: z.number().int().min(1).max(28)
    }).parse(req.body)

    // Gate: must have deposit fully funded AND ach verified
    const tenant = await queryOne<any>(`
      SELECT t.ach_verified, t.otp_qualified_at,
        CASE
          WHEN sd.id IS NULL THEN false
          WHEN sd.flex_deposit_enabled = true AND sd.installments_remaining > 0 THEN false
          WHEN sd.collected_amount >= sd.total_amount THEN true
          ELSE false
        END AS deposit_fully_funded
      FROM tenants t
      LEFT JOIN security_deposits sd ON sd.tenant_id = t.id
      WHERE t.id = $1`, [req.user!.profileId])

    if (!tenant?.deposit_fully_funded) {
      return res.status(400).json({ success: false, error: 'Security deposit must be fully funded before enrolling in On-Time Pay' })
    }
    if (!tenant?.ach_verified) {
      return res.status(400).json({ success: false, error: 'Bank account must be verified before enrolling in On-Time Pay' })
    }

    await query(`
      UPDATE tenants SET on_time_pay_enrolled=TRUE, float_fee_active=TRUE,
        income_arrival_day=$1 WHERE id=$2`,
      [incomeArrivalDay, req.user!.profileId])
    res.json({ success: true, message: 'On-Time Pay float service activated' })
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
    if (unit.landlord_user_id !== req.user!.userId && req.user!.role !== 'admin' && req.user!.role !== 'super_admin') {
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

    // Store invite token on user
    await query('UPDATE users SET email_verify_token=$1 WHERE id=$2', [inviteToken, user!.id])

    console.log(`[INVITE] Tenant invite: ${email} — token: ${inviteToken}`)
    console.log(`[INVITE] Accept URL: ${process.env.TENANT_APP_URL}/accept-invite?token=${inviteToken}`)

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

tenantsRouter.get('/:id/available-units', requireAuth, requireLandlord, async (req, res, next) => {
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
tenantsRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const { phone, email, bio, themeAccent, fontStyle } = req.body
    await query('UPDATE users SET phone=$1, email=$2 WHERE id=$3',
      [phone||null, email, req.user!.userId])
    if (req.user!.profileId) {
      await query('UPDATE tenants SET bio=$1, theme_accent=$2, font_style=$3 WHERE id=$4',
        [bio||null, themeAccent||null, fontStyle||null, req.user!.profileId])
    }
    res.json({ success: true })
  } catch (e) { next(e) }
})


// Avatar upload
const avatarDir = path.join(process.cwd(), 'uploads', 'avatars')
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true })
const avatarStorage = multer.diskStorage({
  destination: avatarDir,
  filename: (req: any, file: any, cb: any) => cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname))
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

tenantsRouter.get('/avatar-files/:filename', async (req: any, res: any, next: any) => {
  try {
    const fp = path.join(avatarDir, req.params.filename)
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.sendFile(fp)
  } catch(e) { next(e) }
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
    const unit = await queryOne<any>(`
      SELECT u.* FROM units u
      JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
      JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.tenant_id = $1 AND lt.status = 'active'
      LIMIT 1`, [tenant.id])
    if (!unit) throw new AppError(404, 'No active unit')
    const lease = await queryOne<any>(`
      SELECT l.*, p.name as property_name, u.unit_number,
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
    res.json({ success: true, data: lease })
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
