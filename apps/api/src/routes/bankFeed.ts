// Bank feed (S570, Nic) — landlord links their operating bank (Stripe Financial
// Connections, transactions scope), GAM syncs + auto-matches GAM-known money, and
// the landlord categorizes the rest into the P&L. See services/bankFeed.ts.
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { MERCHANT_RULE_SCOPES, EXPENSE_CATEGORIES, OTHER_INCOME_CATEGORIES } from '@gam/shared'
import {
  createLinkSession, finalizeConnection, syncConnection, listConnections,
  listTransactions, categorizeTransaction, ignoreTransaction, disconnectConnection,
} from '../services/bankFeed'

export const bankFeedRouter = Router()
bankFeedRouter.use(requireAuth)

// A landlord acts as themselves; landlord-scoped staff act on their landlord.
function scope(req: any): string {
  const id = req.user.role === 'landlord' ? req.user.profileId : req.user.landlordId
  if (!id) throw new AppError(403, 'A landlord context is required.')
  return id
}

// POST /api/bank-feed/link-session — start FC link; returns client secret.
bankFeedRouter.post('/link-session', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await createLinkSession(scope(req)) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/finalize — after the FC modal, persist the linked accounts.
// S605: books start date — keep pre-onboarding history out of the review queue.
bankFeedRouter.put('/books-start-date', requireLandlord, async (req: any, res, next) => {
  try {
    const b = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    }).parse(req.body)
    const { setBooksStartDate } = await import('../services/bankFeed')
    res.json({ success: true, data: await setBooksStartDate(scope(req), b.date) })
  } catch (e) { next(e) }
})

bankFeedRouter.post('/finalize', requireLandlord, async (req: any, res, next) => {
  try {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(req.body)
    res.json({ success: true, data: await finalizeConnection(scope(req), sessionId) })
  } catch (e) { next(e) }
})

// GET /api/bank-feed/connections
bankFeedRouter.get('/connections', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await listConnections(scope(req)) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/connections/:id/sync
bankFeedRouter.post('/connections/:id/sync', requireLandlord, async (req: any, res, next) => {
  try {
    const landlordId = scope(req)
    // Ownership check inside the service via landlord_id on the row is not present
    // on sync; guard here.
    const conns = await listConnections(landlordId)
    if (!conns.some((c: any) => c.id === req.params.id)) throw new AppError(404, 'Connection not found')
    res.json({ success: true, data: await syncConnection(req.params.id) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/connections/:id/disconnect
bankFeedRouter.post('/connections/:id/disconnect', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await disconnectConnection(scope(req), req.params.id) })
  } catch (e) { next(e) }
})

// GET /api/bank-feed/transactions?status=needs_review&connectionId=&limit=
bankFeedRouter.get('/transactions', requireLandlord, async (req: any, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['needs_review', 'matched', 'categorized', 'ignored']).optional(),
      connectionId: z.string().uuid().optional(),
      limit: z.coerce.number().int().positive().max(500).optional(),
    }).parse(req.query)
    res.json({ success: true, data: await listTransactions(scope(req), q) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/categorize
bankFeedRouter.post('/transactions/:id/categorize', requireLandlord, async (req: any, res, next) => {
  try {
    const body = z.object({
      // S605: accepts BOTH sides — the service picks by the transaction's sign
      // (expense categories for money out, income for money in) and rejects a
      // mismatch, so widening here can't file a deposit as 'repairs'.
      category: z.enum([...EXPENSE_CATEGORIES, ...OTHER_INCOME_CATEGORIES] as unknown as [string, ...string[]]),
      scopeKind: z.enum(MERCHANT_RULE_SCOPES as unknown as [string, ...string[]]),
      unitId: z.string().uuid().nullable().optional(),
      propertyId: z.string().uuid().nullable().optional(),
      vendor: z.string().max(200).nullable().optional(),
      description: z.string().max(500).nullable().optional(),
    }).parse(req.body)
    res.json({ success: true, data: await categorizeTransaction(scope(req), req.params.id, body as any) })
  } catch (e) { next(e) }
})

// POST /api/bank-feed/transactions/:id/ignore
bankFeedRouter.post('/transactions/:id/ignore', requireLandlord, async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await ignoreTransaction(scope(req), req.params.id) })
  } catch (e) { next(e) }
})
