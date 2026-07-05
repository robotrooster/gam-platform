import { Router } from 'express'
import { query } from '../db'
import { requireAuth, requirePerm, getScopedPropertyIds } from '../middleware/auth'

// Front-desk "who owes" surface. A read-only list of tenants with an unpaid
// balance + their contact info, so a front-counter person knows who to call.
// Outstanding = unpaid invoice balance (invoice total − settled payments),
// matching the platform definition in reports.ts (pending|partial invoices).
export const balancesRouter = Router()
balancesRouter.use(requireAuth)

// GET /api/balances — grouped per tenant + unit. Owners bypass requirePerm;
// staff need the balances.view grant (part of the Front Desk preset).
// Property-scoped: a worker with a property-locked scope row only sees
// balances at their assigned properties (invoices with no unit have no
// property, so scoped workers don't see them either).
balancesRouter.get('/', requirePerm('balances.view'), async (req, res, next) => {
  try {
    const landlordId = req.user!.role === 'landlord' ? req.user!.profileId : req.user!.landlordId ?? req.user!.profileId
    const scopedIds = await getScopedPropertyIds(req.user)
    const rows = await query<any>(`
      SELECT
        t.id                                        AS tenant_id,
        tu.first_name, tu.last_name, tu.phone, tu.email,
        u.unit_number,
        pr.id                                       AS property_id,
        pr.name                                     AS property_name,
        SUM(i.total_amount - COALESCE(pd.paid, 0))::numeric AS balance,
        COUNT(*)::int                               AS open_invoices,
        MIN(i.due_date)                             AS oldest_due_date
      FROM invoices i
      JOIN tenants t          ON t.id  = i.tenant_id
      LEFT JOIN users tu      ON tu.id = t.user_id
      LEFT JOIN units u       ON u.id  = i.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS paid
          FROM payments
         WHERE status = 'settled' AND invoice_id IS NOT NULL
         GROUP BY invoice_id
      ) pd ON pd.invoice_id = i.id
      WHERE i.landlord_id = $1
        AND i.status IN ('pending', 'partial')
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
      GROUP BY t.id, tu.first_name, tu.last_name, tu.phone, tu.email,
               u.unit_number, pr.id, pr.name
      HAVING SUM(i.total_amount - COALESCE(pd.paid, 0)) > 0
      ORDER BY balance DESC
    `, [landlordId, scopedIds])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
