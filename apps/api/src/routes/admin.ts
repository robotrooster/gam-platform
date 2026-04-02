import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireAdmin } from '../middleware/auth'

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
        (SELECT COUNT(*)::int FROM users WHERE role='landlord') AS total_landlords,
        (SELECT COUNT(*)::int FROM users WHERE role='tenant')   AS total_tenants,
        (SELECT COUNT(*)::int FROM units WHERE status='active') AS active_units,
        (SELECT COUNT(*)::int FROM units WHERE status='vacant') AS vacant_units,
        (SELECT COUNT(*)::int FROM units WHERE payment_block=TRUE) AS eviction_mode_units,
        (SELECT COALESCE(SUM(rent_amount),0) FROM units WHERE status='active') AS monthly_rent_volume,
        (SELECT COALESCE(balance,0) FROM reserve_fund_state LIMIT 1) AS reserve_balance,
        (SELECT COALESCE(balance,0) FROM float_account_state LIMIT 1) AS float_balance,
        (SELECT COUNT(*)::int FROM payments WHERE status='pending') AS pending_payments,
        (SELECT COUNT(*)::int FROM disbursements WHERE status='pending') AS pending_disbursements,
        (SELECT COUNT(*)::int FROM maintenance_requests WHERE status='open') AS open_maintenance
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
    const posts = await query<any>(`
      SELECT b.*,
        p.name as property_name,
        b.upvote_count as vote_count
      FROM bulletin_posts b
      LEFT JOIN properties p ON p.id = b.property_id
      WHERE (b.is_removed IS NULL OR b.is_removed = FALSE)
      ORDER BY b.pinned DESC, b.created_at DESC
      LIMIT 200`, [])
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
      LEFT JOIN leases l ON l.tenant_id = t.id AND l.status = 'active'
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
