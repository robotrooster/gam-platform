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
    const isSuper = req.user!.role === 'super_admin'
    const isAdmin = req.user!.role === 'admin' || isSuper
    const params: any[] = []
    // S567: super sees all disbursements; a regular admin (portfolio manager)
    // sees only payouts to landlords they close or service; others see own.
    let filter = ''
    if (!isAdmin) {
      filter = `WHERE d.user_id = $${params.push(req.user!.userId)}`
    } else if (!isSuper) {
      const i = params.push(req.user!.userId)
      filter = `WHERE d.user_id IN (SELECT user_id FROM landlords WHERE portfolio_manager_id = $${i} OR service_manager_id = $${i})`
    }
    const rows = await query<any>(`
      SELECT d.id, d.user_id, d.bank_account_id, d.trigger_type,
             d.amount, d.fee_charged, d.status,
             d.stripe_payout_id, d.initiated_at, d.settled_at,
             d.created_at, d.notes,
             u.first_name, u.last_name, u.email,
             ba.nickname AS bank_nickname, ba.account_number_last4 AS bank_last4,
             -- S637 (Nic): "disbursements page needs to show first to who and
             -- where." The recipient was already selected and never rendered;
             -- the paying COMPANY was not selected at all. A payout has no
             -- property (see \d disbursements — landlord_id + bank_account_id,
             -- no property_id): it is per ENTITY, aggregating whatever rent came
             -- in across that company's parks. So the company IS the grain to
             -- name and to filter on, and inventing a property link here would
             -- be inventing data.
             d.landlord_id,
             ll.business_name AS company_name
        FROM disbursements d
        LEFT JOIN users u ON u.id = d.user_id
        LEFT JOIN landlords ll ON ll.id = d.landlord_id
        LEFT JOIN user_bank_accounts ba ON ba.id = d.bank_account_id
        ${filter}
       ORDER BY d.created_at DESC
       LIMIT 50
    `, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
