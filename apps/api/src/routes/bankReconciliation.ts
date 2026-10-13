// Bank reconciliation (S568, Nic) — the landlord portal's own door.
//
// 10/12 (Nic, ledger P9): re-based on the ledger. A landlord reconciles a bank
// account of their books against its statement (services/bankReconciliation):
// the statement's last day and ending balance start it; the lines are ticked
// off and it is finished on the Bank Reconciliation page — the same page in
// the landlord portal (Bank → Reconciliation, and Bookkeeping) and in GAM
// Books, which works through /api/books/reconcile (routes/booksClose.ts).
//
// This door stays for the landlord's assistant (record_bank_reconciliation):
// it STARTS a statement at the figure printed on it, and lists the history.
// The S568 statement-total check (a statement against what GAM paid out) and
// its "log a bank charge" are gone: a bank charge is an expense paid from that
// bank (Expenses, or filed from the bank feed), and it is ticked like any line.
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordTarget } from '../lib/landlordScope'
import { listReconciliations, startReconciliation } from '../services/bankReconciliation'

export const bankReconciliationRouter = Router()
bankReconciliationRouter.use(requireAuth)

function scope(req: any): string {
  // S633: an account is not an entity. `?entityId=` names one; otherwise the
  // account's only company is used, and an account that owns several is asked
  // which rather than being silently put on whichever one the session sat on.
  // resolveLandlordTarget does the ownership check either way.
  return resolveLandlordTarget(req.user, req.query?.entityId ?? req.body?.landlordId, 'record')
}

// GET /api/bank-reconciliations — every statement reconciled (or being worked), newest first
bankReconciliationRouter.get('/', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await listReconciliations({ landlordId: scope(req) }) })
  } catch (e) { next(e) }
})

// POST /api/bank-reconciliations — start reconciling a bank account to a statement.
// periodEnd is the statement's last day; periodStart is accepted and not used
// (a statement starts where the last reconciled one ended). accountId names the
// bank account (a chart account or a linked bank — its id, number, name or last
// four); with one linked bank it may be left out.
bankReconciliationRouter.post('/', requireLandlord, async (req: any, res, next) => {
  try {
    const parsed = z.object({
      periodStart:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      periodEnd:        z.string({ required_error: 'Enter the statement\'s last day.' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the statement\'s last day.'),
      statementBalance: z.number({ required_error: 'Enter the statement\'s ending balance.', invalid_type_error: 'Enter the statement\'s ending balance.' }),
      // 10/12 (Nic, review): the account's id, or the way people say it — its
      // number, its name or its last four (services/bankReconciliation
      // pickReconcileAccount), so the assistant can pass what was said.
      accountId:        z.string().trim().max(200, 'Choose one of the company\'s bank accounts.').nullable().optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message || 'Check the form and try again.')
    const body = parsed.data
    res.json({ success: true, data: await startReconciliation({
      owner: { landlordId: scope(req) }, accountId: body.accountId ?? null, statementDate: body.periodEnd,
      statementBalance: body.statementBalance, actorUserId: req.user.userId,
    }) })
  } catch (e) { next(e) }
})
