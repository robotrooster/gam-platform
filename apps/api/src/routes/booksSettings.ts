/**
 * 10/12 (Nic) — GAM BOOKS: BOOKS SETTINGS AND OPENING BALANCES
 *
 *   "history start = landlord's choice (since joining GAM, or a start date +
 *    opening balances)"; home sales, work trade, register stock, company-level
 *   costs, who may close and reopen a month, where an open month's fixes show,
 *   who may write off — each the LANDLORD'S CHOICE (Nic's 10/12 answers).
 *
 * The door to services/booksSettings.ts (what each setting means and how it is
 * saved is there). Mounted at /api/books/setup, AHEAD of the Books router in
 * index.ts, so it answers for itself:
 *
 *   GET   /settings                      the company's books settings
 *   PATCH /settings                      the owner changes them
 *   GET   /opening-balances              what the books start with
 *   POST  /opening-balances              the owner enters one
 *   POST  /opening-balances/:id/void     the owner voids one (kept, with why)
 *   POST  /opening-balances/chart        the owner sets up the chart the
 *                                        automatic postings use, so an "other"
 *                                        opening balance has accounts to name
 *
 * WHICH COMPANY: the same rule as every Books request. The X-Client-Id header
 * names the company whose books are open; an owner's must be the account's
 * own (with no header, the account's only company, or a 400 asking which); a
 * bookkeeper's is checked against their assignments by requireAuth.
 *
 * WHO: the owner (founding user or co-owner) reads and changes everything. A
 * bookkeeper reads, with "May use the whole-company ledger" or the company-wide
 * box (lib/bookkeeperScope), and sees bank balances only with the company-wide
 * box; never changes anything here. An admin reads a named company. Nobody
 * else. Every write is the owner's own press with the effect on screen — no
 * assistant makes these choices (services/agents/actionGap DELIBERATE).
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import {
  BOOKS_HISTORY_STARTS, BOOKS_HOME_SALE_METHODS, BOOKS_WORK_TRADE_METHODS, LEDGER_REGISTER_STOCK_METHODS,
  BOOKS_COMPANY_COST_METHODS, LEDGER_WRITE_OFF_PERMISSIONS, LEDGER_CLOSE_PERMISSIONS, LEDGER_OPEN_MONTH_FIX_MODES,
  LEDGER_OPENING_ITEM_KINDS_ENTERED, BOOKS_REPAIR_BILL_MODES,
} from '@gam/shared'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds, ownsLandlord } from '../lib/landlordScope'
import { KEEPS_NOTHING, LEDGER_REFUSAL } from '../lib/bookkeeperScope'
import { db } from '../db'
import { BOOKS_CHOOSE_COMPANY } from './books'
import {
  isCompanyOwnerUser, getBooksSettings, updateBooksSettings, getOpeningBalances, addOpeningItem, voidOpeningItem,
  setupOpeningChart, type BooksViewer,
} from '../services/booksSettings'

export const booksSettingsRouter = Router()
booksSettingsRouter.use(requireAuth)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function headerCompany(req: Request): string | null {
  const v = req.headers['x-client-id']
  const id = Array.isArray(v) ? v[0] : v
  return id ? String(id) : null
}

/** Who is asking, for which company, and what they may do (see the header). */
async function viewerOf(req: Request): Promise<BooksViewer> {
  const user = req.user!
  if (user.role === 'landlord') {
    const named = headerCompany(req)
    let landlordId: string
    if (named) {
      if (!UUID.test(named)) throw new AppError(403, 'That company is not yours. Choose one of your own companies in Books.')
      // The token first, then the database: a company created after sign-in is still the account's.
      if (!ownsLandlord(user, named) && !(await isCompanyOwnerUser(db, user.userId, named))) {
        throw new AppError(403, 'That company is not yours. Choose one of your own companies in Books.')
      }
      landlordId = named
    } else {
      const owned = landlordScopeIds(user)
      if (owned.length === 0) throw new AppError(403, 'There are no company books on this account.')
      if (owned.length > 1) throw new AppError(400, BOOKS_CHOOSE_COMPANY)
      landlordId = owned[0]
    }
    return { landlordId, userId: user.userId, kind: 'owner', canEdit: true, seesBank: true }
  }
  if (user.role === 'bookkeeper') {
    // requireAuth already holds the company to one they keep (X-Client-Id, or
    // their pass's company) and put what the owner ticked on the request.
    const scope = user.bookkeeperScope
    if (!user.landlordId || !scope || scope.keepsNothing) throw new AppError(403, KEEPS_NOTHING)
    if (!scope.ledger) throw new AppError(403, LEDGER_REFUSAL)
    return { landlordId: user.landlordId, userId: user.userId, kind: 'bookkeeper', canEdit: false, seesBank: !!scope.companyWide }
  }
  if (user.role === 'admin' || user.role === 'super_admin') {
    const named = headerCompany(req)
    if (!named || !UUID.test(named)) throw new AppError(400, 'Name the company (X-Client-Id) whose books to read.')
    const found = await db.query(`SELECT 1 FROM landlords WHERE id = $1`, [named])
    if (!found.rowCount) throw new AppError(404, 'No such company.')
    return { landlordId: named, userId: user.userId, kind: 'admin', canEdit: false, seesBank: true }
  }
  throw new AppError(403, "The books settings are for the company's owner and its bookkeeper.")
}

/** A request body checked by zod, refused with the schema's own plain sentence. */
function parse<T>(schema: z.ZodType<T, any, any>, body: unknown): T {
  const r = schema.safeParse(body ?? {})
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message || 'Check the form and try again.')
  return r.data
}

const choice = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.enum(values, { errorMap: () => ({ message }) }).optional()

const settingsPatchSchema = z.object({
  historyStart:        choice(BOOKS_HISTORY_STARTS, 'Choose when your books start: since joining GAM, or a date you pick.'),
  startDate:           z.string({ invalid_type_error: 'Enter the date your books start.' }).optional(),
  closeBy:             choice(LEDGER_CLOSE_PERMISSIONS, 'Choose who may close a month.'),
  reopenBy:            choice(LEDGER_CLOSE_PERMISSIONS, 'Choose who may reopen a month.'),
  openMonthFixes:      choice(LEDGER_OPEN_MONTH_FIX_MODES, 'Choose where fixes to an open month show.'),
  homeSaleMethod:      choice(BOOKS_HOME_SALE_METHODS, 'Choose how home sales count.'),
  workTradeMethod:     choice(BOOKS_WORK_TRADE_METHODS, 'Choose how work trade that covers rent counts.'),
  registerStockMethod: choice(LEDGER_REGISTER_STOCK_METHODS, 'Choose how register stock counts.'),
  companyCostsMethod:  choice(BOOKS_COMPANY_COST_METHODS, 'Choose where company-level costs go.'),
  writeOffBy:          choice(LEDGER_WRITE_OFF_PERMISSIONS, 'Choose who may write off a balance.'),
  // 10/12 (Nic, L6): a repair closed with a cost — an unpaid bill by itself, or "Record as bill".
  repairBills:         choice(BOOKS_REPAIR_BILL_MODES, 'Choose what a repair closed with a cost does.'),
})

const openingItemSchema = z.object({
  kind: z.enum(LEDGER_OPENING_ITEM_KINDS_ENTERED, {
    errorMap: () => ({ message: 'Choose a bank balance, a deposit you hold, or another opening balance.' }),
  }),
  amount: z.union([z.number(), z.string()], { errorMap: () => ({ message: 'Enter the amount in dollars and cents.' }) }),
  bankConnectionId: z.string().optional(),
  leaseId: z.string().optional(),
  accountId: z.string().optional(),
  paidOn: z.string().optional(),
  memo: z.string().max(500, 'A note is 500 characters at most.').optional(),
})

const voidSchema = z.object({
  reason: z.string({ required_error: 'Say why this opening balance is being voided.' })
    .trim().min(1, 'Say why this opening balance is being voided.').max(500, 'A reason is 500 characters at most.'),
})

// GET /api/books/setup/settings
booksSettingsRouter.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await getBooksSettings(await viewerOf(req)) })
  } catch (e) { next(e) }
})

// PATCH /api/books/setup/settings — the owner only.
booksSettingsRouter.patch('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewer = await viewerOf(req)
    if (!viewer.canEdit) throw new AppError(403, 'Only the owner changes the books settings.')
    const patch = parse(settingsPatchSchema, req.body)
    res.json({ success: true, data: await updateBooksSettings({ viewer, patch }) })
  } catch (e) { next(e) }
})

// GET /api/books/setup/opening-balances
booksSettingsRouter.get('/opening-balances', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await getOpeningBalances(await viewerOf(req)) })
  } catch (e) { next(e) }
})

// POST /api/books/setup/opening-balances — the owner enters one opening balance.
booksSettingsRouter.post('/opening-balances', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewer = await viewerOf(req)
    if (!viewer.canEdit) throw new AppError(403, 'Only the owner enters opening balances.')
    const input = parse(openingItemSchema, req.body)
    const id = await addOpeningItem({ viewer, input })
    res.status(201).json({ success: true, data: { id, ...(await getOpeningBalances(viewer)) } })
  } catch (e) { next(e) }
})

// POST /api/books/setup/opening-balances/chart — the owner sets up the chart for the automatic postings.
booksSettingsRouter.post('/opening-balances/chart', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewer = await viewerOf(req)
    if (!viewer.canEdit) throw new AppError(403, 'Only the owner sets up the chart of accounts here.')
    await setupOpeningChart(viewer)
    res.json({ success: true, data: await getOpeningBalances(viewer) })
  } catch (e) { next(e) }
})

// POST /api/books/setup/opening-balances/:id/void — the owner voids one, saying why.
booksSettingsRouter.post('/opening-balances/:id/void', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewer = await viewerOf(req)
    if (!viewer.canEdit) throw new AppError(403, 'Only the owner changes opening balances.')
    const { reason } = parse(voidSchema, req.body)
    await voidOpeningItem({ viewer, id: String(req.params.id), reason })
    res.json({ success: true, data: await getOpeningBalances(viewer) })
  } catch (e) { next(e) }
})
