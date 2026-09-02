// Bank reconciliation (S568, Nic). Landlords reconcile their statement vs what
// GAM disbursed, and categorize bank charges (logged via /api/expenses as
// 'bank_fees' expenses that flow into the P&L).
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordTarget } from '../lib/landlordScope'
import { getReconciliationContext, createReconciliation, listReconciliations } from '../services/bankReconciliation'

export const bankReconciliationRouter = Router()
bankReconciliationRouter.use(requireAuth)

function scope(req: any): string {
  // S633: an account is not an entity. `?entityId=` names one; otherwise the
  // account's only company is used, and an account that owns several is asked
  // which rather than being silently put on whichever one the session sat on.
  // resolveLandlordTarget does the ownership check either way.
  return resolveLandlordTarget(req.user, req.query?.entityId ?? req.body?.landlordId, 'record')
}

// GET /api/bank-reconciliations/context?from=&to=
bankReconciliationRouter.get('/context', requireLandlord, async (req: any, res, next) => {
  try {
    const { from, to } = req.query
    if (!from || !to) throw new AppError(400, 'from and to (YYYY-MM-DD) are required')
    res.json({ success: true, data: await getReconciliationContext(scope(req), from, to) })
  } catch (e) { next(e) }
})

// GET /api/bank-reconciliations — past reconciliations
bankReconciliationRouter.get('/', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await listReconciliations(scope(req)) })
  } catch (e) { next(e) }
})

// POST /api/bank-reconciliations — save one
bankReconciliationRouter.post('/', requireLandlord, async (req: any, res, next) => {
  try {
    const body = z.object({
      periodStart:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      statementBalance: z.number(),
      accountId:        z.string().uuid().nullable().optional(),
    }).parse(req.body)
    res.json({ success: true, data: await createReconciliation(scope(req), {
      periodStart: body.periodStart, periodEnd: body.periodEnd,
      statementBalance: body.statementBalance, accountId: body.accountId ?? null,
    }) })
  } catch (e) { next(e) }
})
