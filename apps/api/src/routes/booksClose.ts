/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P9: CLOSE A MONTH, RECONCILE THE BANK
 *
 *   L3 "close/reopen month: landlord's choice (owner decides who can close and
 *       reopen)"; decision 2 "Full bookkeeping (bank lines, reconciling,
 *       journal entries, bills, payroll, vendors) … One level".
 *
 * The doors to services/ledgerClose.ts (closing and reopening a month, and the
 * checklist before one closes) and services/bankReconciliation.ts (a bank
 * account against its statement, on the ledger). Mounted AHEAD of the Books
 * router in index.ts, so each answers for itself:
 *
 *   /api/books/close
 *     GET  /?through=YYYY-MM-DD   the checklist for a month (default: the next
 *                                 one to close), what blocks and what only
 *                                 warns, who may close and reopen, the history
 *     POST /check                 post what is still waiting, then the checklist
 *     POST /                      close through a month's last day
 *     POST /reopen                reopen a month (and every later one), saying why
 *   /api/books/reconcile
 *     GET  /accounts              the company's bank accounts on the chart
 *     GET  /accounts/:accountId   its statement in progress, lines and history
 *     POST /accounts/:accountId/start   start a statement (last day, ending balance)
 *     PATCH /:id                  change the statement's last day or balance
 *     POST /:id/tick              tick lines off the statement, or take ticks off
 *     POST /:id/finish            finish at a $0.00 difference (freezes the lines)
 *     POST /:id/undo              set aside / undo, saying why
 *
 * WHICH COMPANY: the same rule as every Books request. The X-Client-Id header
 * names the company whose books are open; an owner's must be the account's
 * own (with no header, the account's only company, or a 400 asking which); a
 * bookkeeper's is checked against their assignments by requireAuth.
 *
 * WHO: the owner (founding user or co-owner), or a bookkeeper the company
 * keeps. Closing a month is the company-wide box's (design §9); whether that
 * bookkeeper may close or reopen is the company's Books Settings choice
 * (services/ledgerClose decides). Reconciling is the ledger's: the
 * company-wide box, or "May use the whole-company ledger" (Nic, 10/12, BK1).
 * Every bookkeeper does full bookkeeping at one level (Nic, 10/12). Every write
 * is a person's press with the figures on screen — no assistant closes a month
 * or reconciles a statement (services/agents/actionGap DELIBERATE); the
 * landlord's own /api/bank-reconciliations start is the one an assistant may
 * open for them.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds, ownsLandlord } from '../lib/landlordScope'
import { KEEPS_NOTHING, LEDGER_REFUSAL, companyWideRefusal } from '../lib/bookkeeperScope'
import { db } from '../db'
import { BOOKS_CHOOSE_COMPANY } from './books'
import { isCompanyOwnerUser } from '../services/booksSettings'
import type { LedgerOwner } from '../services/ledgerOwner'
import { closeMonth, reopenMonth, getCloseStatus, runCloseCheck } from '../services/ledgerClose'
import {
  listReconcileAccounts, getWorksheet, startReconciliation, updateReconciliation, tickLines,
  completeReconciliation, undoReconciliation,
} from '../services/bankReconciliation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/

function headerCompany(req: Request): string | null {
  const v = req.headers['x-client-id']
  const id = Array.isArray(v) ? v[0] : v
  return id ? String(id) : null
}

/**
 * Whose books, and may this person work them here? `what` names the screen in
 * a bookkeeper's refusal; `needs` is the box a bookkeeper must have — the
 * company-wide box (closing a month) or the company's ledger (reconciling).
 */
async function companyOf(req: Request, what: string, needs: 'companyWide' | 'ledger'): Promise<{ owner: LedgerOwner; userId: string }> {
  const user = req.user!
  if (user.role === 'landlord') {
    const named = headerCompany(req)
    if (named) {
      if (!UUID.test(named)) throw new AppError(403, 'That company is not yours. Choose one of your own companies in Books.')
      // The token first, then the database: a company created after sign-in is still the account's.
      if (!ownsLandlord(user, named) && !(await isCompanyOwnerUser(db, user.userId, named))) {
        throw new AppError(403, 'That company is not yours. Choose one of your own companies in Books.')
      }
      return { owner: { landlordId: named }, userId: user.userId }
    }
    const owned = landlordScopeIds(user)
    if (owned.length === 0) throw new AppError(403, 'There are no company books on this account.')
    if (owned.length > 1) throw new AppError(400, BOOKS_CHOOSE_COMPANY)
    return { owner: { landlordId: owned[0] }, userId: user.userId }
  }
  if (user.role === 'bookkeeper') {
    // requireAuth already holds the company to one they keep (X-Client-Id, or
    // their pass's company) and put what the owner ticked on the request.
    const scope = user.bookkeeperScope
    if (!user.landlordId || !scope || scope.keepsNothing) throw new AppError(403, KEEPS_NOTHING)
    if (needs === 'companyWide' && !scope.companyWide) throw new AppError(403, companyWideRefusal(what))
    if (needs === 'ledger' && !scope.ledger) throw new AppError(403, LEDGER_REFUSAL)
    return { owner: { landlordId: user.landlordId }, userId: user.userId }
  }
  if (user.role === 'business_owner' && user.businessId) {
    return { owner: { businessId: user.businessId }, userId: user.userId }
  }
  throw new AppError(403, `${what} is for the company's owner and its bookkeeper.`)
}

/** A request body checked by zod, refused with the schema's own plain sentence. */
function parse<T>(schema: z.ZodType<T, any, any>, body: unknown): T {
  const r = schema.safeParse(body ?? {})
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message || 'Check the form and try again.')
  return r.data
}

function idParam(v: string, what: string): string {
  if (!UUID.test(v)) throw new AppError(404, `No such ${what}.`)
  return v
}

function throughQuery(v: unknown): string | null {
  if (v == null || v === '') return null
  const s = String(v)
  if (!DAY.test(s)) throw new AppError(400, 'Choose a month to close.')
  return s
}

const day = (message: string) => z.string({ required_error: message, invalid_type_error: message }).regex(DAY, message)
const amount = z.union([z.number(), z.string()], {
  errorMap: () => ({ message: 'Enter the statement\'s ending balance in dollars and cents.' }),
})

// ─── Close a month ───────────────────────────────────────────────────────────

export const booksCloseRouter = Router()
booksCloseRouter.use(requireAuth)

booksCloseRouter.get('/', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Closing a month', 'companyWide')
    res.json({ success: true, data: await getCloseStatus({ owner, viewerUserId: userId, through: throughQuery(req.query.through) }) })
  } catch (e) { next(e) }
})

const checkSchema = z.object({ through: day('Choose a month to close.').optional().nullable() })
booksCloseRouter.post('/check', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Closing a month', 'companyWide')
    const body = parse(checkSchema, req.body)
    res.json({ success: true, data: await runCloseCheck({ owner, viewerUserId: userId, through: body.through ?? null }) })
  } catch (e) { next(e) }
})

const closeSchema = z.object({
  through: day('Choose the month to close.'),
  note: z.string().max(500, 'A note is 500 characters at most.').optional().nullable(),
})
booksCloseRouter.post('/', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Closing a month', 'companyWide')
    const body = parse(closeSchema, req.body)
    const done = await closeMonth({ owner, through: body.through, actorUserId: userId, reason: body.note ?? null })
    res.json({ success: true, data: { ...done, status: await getCloseStatus({ owner, viewerUserId: userId }) } })
  } catch (e) { next(e) }
})

const reopenSchema = z.object({
  month: day('Choose the month to reopen.'),
  reason: z.string({ required_error: 'Say why the month is being reopened.' })
    .trim().min(1, 'Say why the month is being reopened.').max(500, 'A reason is 500 characters at most.'),
})
booksCloseRouter.post('/reopen', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Reopening a month', 'companyWide')
    const body = parse(reopenSchema, req.body)
    const done = await reopenMonth({ owner, month: body.month, actorUserId: userId, reason: body.reason })
    res.json({ success: true, data: { ...done, status: await getCloseStatus({ owner, viewerUserId: userId }) } })
  } catch (e) { next(e) }
})

// ─── Reconcile a bank account ────────────────────────────────────────────────

export const booksReconcileRouter = Router()
booksReconcileRouter.use(requireAuth)

booksReconcileRouter.get('/accounts', async (req, res, next) => {
  try {
    const { owner } = await companyOf(req, 'Bank reconciliation', 'ledger')
    res.json({ success: true, data: await listReconcileAccounts(owner) })
  } catch (e) { next(e) }
})

booksReconcileRouter.get('/accounts/:accountId', async (req, res, next) => {
  try {
    const { owner } = await companyOf(req, 'Bank reconciliation', 'ledger')
    res.json({ success: true, data: await getWorksheet(owner, idParam(req.params.accountId, 'bank account')) })
  } catch (e) { next(e) }
})

const startSchema = z.object({
  statementDate: day('Enter the statement\'s last day.'),
  statementBalance: amount,
})
booksReconcileRouter.post('/accounts/:accountId/start', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Bank reconciliation', 'ledger')
    const body = parse(startSchema, req.body)
    res.json({ success: true, data: await startReconciliation({
      owner, accountId: idParam(req.params.accountId, 'bank account'), statementDate: body.statementDate,
      statementBalance: body.statementBalance, actorUserId: userId,
    }) })
  } catch (e) { next(e) }
})

const updateSchema = z.object({
  statementDate: day('Enter the statement\'s last day.').optional(),
  statementBalance: amount.optional(),
})
booksReconcileRouter.patch('/:id', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Bank reconciliation', 'ledger')
    const body = parse(updateSchema, req.body)
    res.json({ success: true, data: await updateReconciliation({
      owner, reconciliationId: idParam(req.params.id, 'reconciliation'), statementDate: body.statementDate,
      statementBalance: body.statementBalance, actorUserId: userId,
    }) })
  } catch (e) { next(e) }
})

const tickSchema = z.object({
  lineIds: z.array(z.string().regex(UUID, 'Choose the lines to tick.'), { required_error: 'Choose the lines to tick.' })
    .min(1, 'Choose the lines to tick.').max(2000, 'Tick at most 2,000 lines at once.'),
  cleared: z.boolean({ required_error: 'Say whether the lines are on the statement.' }),
})
booksReconcileRouter.post('/:id/tick', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Bank reconciliation', 'ledger')
    const body = parse(tickSchema, req.body)
    res.json({ success: true, data: await tickLines({
      owner, reconciliationId: idParam(req.params.id, 'reconciliation'), lineIds: body.lineIds, cleared: body.cleared, actorUserId: userId,
    }) })
  } catch (e) { next(e) }
})

booksReconcileRouter.post('/:id/finish', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Bank reconciliation', 'ledger')
    res.json({ success: true, data: await completeReconciliation({
      owner, reconciliationId: idParam(req.params.id, 'reconciliation'), actorUserId: userId,
    }) })
  } catch (e) { next(e) }
})

const undoSchema = z.object({
  reason: z.string({ required_error: 'Say why this reconciliation is being undone.' })
    .trim().min(1, 'Say why this reconciliation is being undone.').max(500, 'A reason is 500 characters at most.'),
})
booksReconcileRouter.post('/:id/undo', async (req, res, next) => {
  try {
    const { owner, userId } = await companyOf(req, 'Bank reconciliation', 'ledger')
    const body = parse(undoSchema, req.body)
    res.json({ success: true, data: await undoReconciliation({
      owner, reconciliationId: idParam(req.params.id, 'reconciliation'), reason: body.reason, actorUserId: userId,
    }) })
  } catch (e) { next(e) }
})
