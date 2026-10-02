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
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { payoutComposition } from '../services/payoutComposition'

export const disbursementsRouter = Router()
disbursementsRouter.use(requireAuth)

/**
 * Who may see which payouts. ONE rule for the list and for a single payout's
 * contents, so the detail can never show a payout the list would not:
 * super sees all; a regular admin (portfolio manager) sees payouts to landlords
 * they close or service (S567); everyone else sees their own.
 */
function visibilityFilter(req: any, params: any[]): string {
  const isSuper = req.user!.role === 'super_admin'
  const isAdmin = req.user!.role === 'admin' || isSuper
  if (!isAdmin) return `d.user_id = $${params.push(req.user!.userId)}`
  if (!isSuper) {
    const i = params.push(req.user!.userId)
    return `d.user_id IN (SELECT user_id FROM landlords WHERE portfolio_manager_id = $${i} OR service_manager_id = $${i})`
  }
  return 'TRUE'
}

disbursementsRouter.get('/', async (req, res, next) => {
  try {
    const params: any[] = []
    const filter = `WHERE ${visibilityFilter(req, params)}`
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
             ll.business_name AS company_name,
             -- S652: the bank it went to, from Stripe's own payout record; and
             -- when no one company is stamped, every company on that account.
             d.bank_name, d.bank_last4,
             (SELECT string_agg(l2.business_name, ' + ' ORDER BY l2.business_name)
                FROM landlords l2 WHERE l2.user_id = d.user_id) AS companies_on_account
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

// GET /api/disbursements/:id/composition — S655 (Nic): what this payout
// carried. Every payment inside it (unit, tenant, what for, amount), register
// and booking items, GAM charges taken out, and any part GAM cannot trace —
// which is shown, never hidden. See services/payoutComposition.ts.
disbursementsRouter.get('/:id/composition', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new AppError(404, 'Payout not found')
    const params: any[] = [req.params.id]
    const visible = await queryOne<{ id: string }>(
      `SELECT d.id FROM disbursements d WHERE d.id = $1 AND ${visibilityFilter(req, params)}`, params)
    if (!visible) throw new AppError(404, 'Payout not found')
    res.json({ success: true, data: await payoutComposition(visible.id) })
  } catch (e) { next(e) }
})
