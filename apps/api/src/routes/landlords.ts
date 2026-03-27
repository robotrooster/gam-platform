import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireAdmin, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

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

landlordsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id === 'me' ? req.user!.profileId : req.params.id
    if (req.user!.role !== 'admin' && id !== req.user!.profileId)
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
    if (req.user!.role !== 'admin' && id !== req.user!.profileId) throw new AppError(403,'Forbidden')
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
      JOIN units u ON u.id = p.unit_id
      WHERE u.landlord_id = $1
        AND p.status = 'completed'
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

    res.json({ success: true, data: { ...stats, upcoming_disbursement: upcoming, trend, maintenance, bg_pending: bgPending?.count||0 } })
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
