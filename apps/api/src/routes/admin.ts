import { Router } from 'express'
import { query } from '../db'
import { requireAuth, requireAdmin } from '../middleware/auth'

export const adminRouter = Router()
adminRouter.use(requireAuth)
adminRouter.use(requireAdmin)

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
