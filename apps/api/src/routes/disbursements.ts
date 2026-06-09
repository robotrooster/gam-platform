/**
 * S68: disbursements list — modernized to 16a per-user shape.
 *
 * Pre-16a, this route filtered by `landlord_id` and joined `landlords`. Under
 * the 16a model disbursements key on `user_id` + `bank_account_id` (the
 * landlord_id column survives only for legacy rows; we no longer write it).
 *
 * Calling user sees their own disbursements (auto_friday + manual_on_demand),
 * each row carrying the destination bank's nickname and last4. Admin /
 * super_admin see all rows.
 *
 * The legacy "On-Time Pay SLA" disbursement set went away with the
 * `/payments/initiate-disbursements` route in S68. Any rows from that era
 * have NULL user_id and won't show up in scoped queries.
 */

import { Router } from 'express'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'

export const disbursementsRouter = Router()
disbursementsRouter.use(requireAuth)

disbursementsRouter.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    const params: any[] = []
    const filter = isAdmin ? '' : `WHERE d.user_id = $${params.push(req.user!.userId)}`
    const rows = await query<any>(`
      SELECT d.id, d.user_id, d.bank_account_id, d.trigger_type,
             d.amount, d.fee_charged, d.status,
             d.stripe_payout_id, d.initiated_at, d.settled_at,
             d.created_at, d.notes,
             u.first_name, u.last_name, u.email,
             ba.nickname AS bank_nickname, ba.account_number_last4 AS bank_last4
        FROM disbursements d
        LEFT JOIN users u ON u.id = d.user_id
        LEFT JOIN user_bank_accounts ba ON ba.id = d.bank_account_id
        ${filter}
       ORDER BY d.created_at DESC
       LIMIT 50
    `, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
