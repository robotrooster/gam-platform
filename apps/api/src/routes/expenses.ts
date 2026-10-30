// Landlord-entered expenses (S568, Nic). Unit-linked or common; feeds the P&L.
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAuth, requireRole } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { storage, sendStoredFile, uploadKeyFromStored, newStoredFilename } from '../lib/storage'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordTarget, landlordScopeIds, landlordForRequest, ownsLandlord } from '../lib/landlordScope'
import { query, queryOne } from '../db'
import { LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED, BOOKS_CATEGORY_DIRECTIONS, BOOKS_COST_PLACES } from '@gam/shared'
import {
  createLandlordExpense, listLandlordExpenses, voidLandlordExpense, attachExpenseReceipt, updateLandlordExpense, EXPENSE_NO_PLACE,
  recordExpensePayment, voidExpensePayment,
} from '../services/landlordExpenses'
import { listCategories, createCategory, updateCategory, categoryAccountChoices } from '../services/booksCategories'
import { recordRepairBill, repairCompany } from '../services/repairBills'
import { financialsScope, propertyInScope, type FinancialsScope } from '../lib/financialsScope'
import { pastCutoff, HIDDEN_HISTORY, LEDGER_REFUSAL, bookkeeperMayWrite, READ_ONLY_REFUSAL } from '../lib/bookkeeperScope'

export const expensesRouter = Router()
expensesRouter.use(requireAuth)

// 10/11 (Nic): "any receipts that I upload as expenses whether they're tacked
// on to a unit or to a whole property... miscellaneous purchases like fuel for
// equipment... They need to see all of that stuff." A bookkeeper keeps the
// expenses of the properties they keep. 10/12 (Nic, ledger decision 2): "Full
// bookkeeping … never tenant-account actions … One level, no per-bookkeeper
// switch" — they add, correct, remove and pay any expense filed on a property
// they keep (not only the ones they entered; the 10/11 "Look + add expenses"
// is superseded), never on a property that left the company, and never a
// tenant's account. requireAuth has already kept them to these routes
// (lib/bookkeeperAccess) and put their company and properties on the request.
const requireExpenseViewer = requireRole('admin', 'super_admin', 'landlord', 'bookkeeper')
const isBookkeeper = (req: any) => req.user?.role === 'bookkeeper'
/**
 * 10/12 (Nic) review, SECURITY: the money-out writes P6 added to the Expenses
 * record — a payment recorded or taken back, a category made, renamed,
 * archived or pointed, a repair's bill — are the owner's (or a GAM admin's),
 * and a bookkeeper's on THIS company (the live scope row, lib/bookkeeperScope
 * bookkeeperMayWrite). 10/12 (Nic, ledger decision 2): one level — every
 * bookkeeper the company keeps does them; the read-only box is gone.
 */
function requireExpenseWriter(req: any, res: any, next: any) {
  const role = req.user?.role
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (role === 'admin' || role === 'super_admin' || role === 'landlord') return next()
  if (role === 'bookkeeper') {
    if (bookkeeperMayWrite(req.user.bookkeeperScope)) return next()
    return res.status(403).json({ success: false, error: READ_ONLY_REFUSAL })
  }
  return res.status(403).json({ success: false, error: 'Insufficient permissions' })
}
const mayWrite = (req: any) => !isBookkeeper(req) || bookkeeperMayWrite(req.user?.bookkeeperScope)

/**
 * 10/11: a bookkeeper's write on an EXISTING expense — of their company, filed
 * on a property they keep (a company-level one only when they keep the whole
 * company). Anything else reads as missing (404), the same as another
 * account's row reads to an owner. 10/12 (Nic, ledger decision 2): full
 * bookkeeping — any such expense, not only one they entered.
 */
async function bookkeepersExpense(req: any): Promise<{ landlordId: string; scope: FinancialsScope }> {
  const id = String(req.params.id || '')
  const row = /^[0-9a-f-]{36}$/i.test(id)
    ? await queryOne<{ landlord_id: string; property_id: string | null; created_by: string | null }>(
        `SELECT landlord_id, property_id, created_by FROM landlord_expenses WHERE id = $1 AND status = 'active'`, [id])
    : null
  const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
  const inScope = !!row && scope.landlordIds.includes(row.landlord_id)
    && (scope.propertyIds === null || (!!row.property_id && scope.propertyIds.includes(row.property_id)))
  if (!row || !inScope) throw new AppError(404, 'Expense not found')
  // 10/12 (Nic, BK3): a whole-company bookkeeper reads by company, so a row on
  // a property that left the company without being theirs is hidden whole
  // (lib/bookkeeperScope HIDDEN_HISTORY) — it does not exist for them, even
  // one they filed before that property was unticked.
  if (row.property_id && scope.cutoffs.some(c => c.propertyId === row.property_id && c.lastDay === HIDDEN_HISTORY)) {
    throw new AppError(404, 'Expense not found')
  }
  // 10/12 (Nic): a property that left the company is read only — its history
  // is theirs to look at, never to change.
  if (row.property_id && scope.former.some(f => f.propertyId === row.property_id)) {
    throw new AppError(403, 'That property has left the company. Its books are read only.')
  }
  return { landlordId: row.landlord_id, scope }
}

/** 10/13 (Nic): a split reaches every property of the company — a bookkeeper kept to some of them files on those. */
const SPLIT_NEEDS_WHOLE_COMPANY = 'Splitting a cost across all of the company\'s properties takes the whole company\'s books. Choose a property or unit you keep.'

/**
 * 10/11: where a bookkeeper's new or moved expense is filed must be inside
 * what they keep — a unit or a property of theirs. A company-wide expense
 * (no property) only when they keep the whole company. Ids from the body are
 * checked here, never trusted.
 */
async function assertBookkeeperPlacement(scope: FinancialsScope, unitId: string | null | undefined, propertyId: string | null | undefined): Promise<void> {
  if (unitId) {
    const u = await queryOne<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [unitId])
    if (!u || !(await propertyInScope(scope, u.property_id))) throw new AppError(403, 'That unit is not in your books.')
    return
  }
  if (propertyId) {
    if (!(await propertyInScope(scope, propertyId))) throw new AppError(403, 'That property is not in your books.')
    return
  }
  if (scope.narrowed) throw new AppError(400, 'Choose the property or unit this expense is for.')
}

// S575: receipt uploads. One dir + one authed serve route; unguessable
// filenames + the router-level requireAuth are the guard (same posture as the
// maintenance/inspection media routes — gam-nothing-public-rule, no static
// /uploads). PDF or image only.
// A1: memory-staged (≤25MB) then storage.save — no direct uploads/ access.
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(file.mimetype)) cb(null, true)
    else cb(new Error('PDF or image only'))
  },
})

/**
 * S654: a write on an EXISTING expense acts for the company that row is filed
 * under — the row says, so nothing is asked. A row another account holds reads
 * as missing (404), never as "choose a company".
 */
async function companyOfExpense(req: any): Promise<string> {
  const id = String(req.params.id || '')
  const row = /^[0-9a-f-]{36}$/i.test(id)
    ? await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM landlord_expenses WHERE id = $1`, [id])
    : null
  // S654 (review): a GAM admin acting from the landlord screens keeps the access it had.
  const admin = req.user?.role === 'admin' || req.user?.role === 'super_admin'
  if (!row || !(ownsLandlord(req.user, row.landlord_id) || admin)) throw new AppError(404, 'Expense not found')
  return row.landlord_id
}

/**
 * S637 (Nic, on a two-company account): GET /expenses answered
 * "You own more than one company. Choose which one this record belongs to."
 * — on a LIST. The Expenses tab could not be opened at all by the only kind of
 * account the S633 refactor existed to support.
 *
 * The write resolver was doing double duty here. A read spans every entity the
 * account owns, narrowing only when `?entityId=` names one (and then only to an
 * entity they actually own — the same authorization, via the same resolver).
 */
function readScope(req: any): string[] {
  const explicit = req.query?.entityId
  if (explicit) return [resolveLandlordTarget(req.user, explicit, 'record')]
  return landlordScopeIds(req.user)
}

// GET /api/expenses?from=&to=&propertyId=&unitId=
// 10/11: the owner and their bookkeeper read it through the one financial
// scope (lib/financialsScope): GAM Books' open company, the bookkeeper's
// properties, and ?propertyId= only inside them. Each row says whether this
// viewer may edit it.
expensesRouter.get('/', requireExpenseViewer, async (req: any, res, next) => {
  try {
    const q = req.query
    const role = req.user?.role
    let ids: string[]
    let propertyIds: string[] | null = null
    let cutoffs: FinancialsScope['cutoffs'] = []
    let formerIds = new Set<string>()
    if ((role === 'landlord' && !q.entityId) || role === 'bookkeeper') {
      const scope = await financialsScope(req)
      ids = scope.landlordIds
      propertyIds = scope.propertyIds
      // 10/12 (Nic): a former property's expenses up to the day it left, read only.
      cutoffs = scope.cutoffs
      formerIds = new Set(scope.former.map(f => f.propertyId))
    } else {
      ids = readScope(req)
    }
    // 10/12 (Nic, L5): ?state=open lists the bills still owed (unpaid or
    // partly paid), ?state=paid the ones paid in full.
    const state = q.state === 'open' || q.state === 'paid' ? q.state : null
    const rows = await listLandlordExpenses(ids, {
      from: q.from, to: q.to, unitId: q.unitId, propertyIds, cutoffs, state,
      propertyId: propertyIds ? undefined : q.propertyId,
    })
    // 10/12 (Nic, ledger decision 2): one level — every bookkeeper the company
    // keeps edits, removes and pays the expenses on the properties they keep
    // (never one on a property that left the company: its history is read only).
    const writes = mayWrite(req)
    const keeps = (r: any) => role !== 'bookkeeper' || (writes && !formerIds.has(r.property_id))
    res.json({ success: true, data: rows.map((r: any) => ({
      ...r,
      can_edit: keeps(r),
      // 10/12 review: never offer Remove on one part of a split bank line —
      // the server refuses it (the parts must add up to the bank's amount).
      // 10/12 (Nic): nor on any expense the bank feed filed — it is changed or
      // undone on the Bank page (bank_line_id says which line), never here.
      // 10/12 (Nic, L5): nor on one a bank line paid (matched there).
      // 10/12 review: nor on a bill GAM keeps for something else — a payroll
      // run's take-home or tax bill (void the run), the manager's cut a payout
      // split owes (L18), an expense that became a fixed asset (void the asset).
      // 10/12 (Nic, ledger decision 2): a bookkeeper removes one too (design §11).
      can_remove: keeps(r) && !r.from_bank && !r.bank_paid && !r.system_linked,
      // 10/12 (Nic, L5): recording what was paid is money going out — the
      // owner's, and a bookkeeper's (with write access) on the properties they keep.
      can_pay: writes && !formerIds.has(r.property_id) && r.unpaid > 0,
    })) })
  } catch (e) { next(e) }
})

// POST /api/expenses
expensesRouter.post('/', requireExpenseViewer, async (req: any, res, next) => {
  try {
    const body = z.object({
      propertyId:      z.string().uuid().nullable().optional(),
      unitId:          z.string().uuid().nullable().optional(),
      // 10/12 (Nic, L5): one of the company's own categories (categoryId), or
      // GAM's starting key (category: 'repairs', 'utilities'…).
      category:        z.string().max(60).optional(),
      categoryId:      z.string().uuid().nullable().optional(),
      amount:          z.number().positive(),
      description:     z.string().max(500).nullable().optional(),
      vendor:          z.string().max(160).nullable().optional(),
      vendorId:        z.string().uuid().nullable().optional(),
      billNumber:      z.string().max(100).nullable().optional(),
      dueDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      expenseDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      isCommon:        z.boolean().optional(),
      // 10/13 (Nic): "each expense is chosen on the split or specific unit or
      // property at the time of logging" — required (a unit or a property
      // named says it; 'split_by_units' names neither).
      costPlace:       z.enum(BOOKS_COST_PLACES, { errorMap: () => ({ message: EXPENSE_NO_PLACE }) }).nullable().optional(),
      // S613: which utility this bill was for. Drives the recovery report —
      // what came in for water vs what was billed back out for water.
      utilityType:     z.enum(['water','gas','electric','sewer','trash','propane']).nullable().optional(),
      // 10/12 (Nic, L5): paid now (and how — cash that never touched the bank
      // is logged by hand and never has to match a bank line), or a bill: owed,
      // with a due date. Omitted: paid, how not recorded (as before 10/12).
      paid:            z.object({
        method:           z.enum(LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED),
        paidOn:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        bankConnectionId: z.string().uuid().nullable().optional(),
      }).nullable().optional(),
      unpaid:          z.boolean().optional(),
    }).refine(b => !!b.category || !!b.categoryId, { message: 'Choose a category.' }).parse(req.body)
    // 10/11: a bookkeeper files on their own company, on a unit or property
    // they keep — checked here, never taken from the body on trust.
    let landlordId: string
    if (isBookkeeper(req)) {
      const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
      if (body.costPlace === 'split_by_units' && scope.narrowed) throw new AppError(403, SPLIT_NEEDS_WHOLE_COMPANY)
      await assertBookkeeperPlacement(scope, body.unitId, body.propertyId)
      landlordId = scope.landlordIds[0]
    } else {
      // S654: the company comes from what the request names — a company, else
      // the property, else the unit — all ownership-checked. Naming nothing on a
      // several-company account is asked (400), never defaulted.
      landlordId = await landlordForRequest(req, 'expense')
    }
    const row = await createLandlordExpense({
      landlordId, createdBy: req.user.userId,
      propertyId: body.propertyId ?? null, unitId: body.unitId ?? null,
      category: body.category ?? null, categoryId: body.categoryId ?? null,
      amount: body.amount, description: body.description ?? null,
      vendor: body.vendor ?? null, vendorId: body.vendorId ?? null,
      billNumber: body.billNumber ?? null, dueDate: body.dueDate ?? null,
      expenseDate: body.expenseDate,
      isCommon: body.isCommon, utilityType: body.utilityType ?? null,
      costPlace: body.costPlace ?? null,
      payment: body.unpaid ? null
        : body.paid ? { method: body.paid.method, paidOn: body.paid.paidOn ?? null, bankConnectionId: body.paid.bankConnectionId ?? null }
        : undefined,
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// POST /api/expenses/:id/receipt — attach a receipt file to an expense (S575).
// Called right after create when the landlord picked a file. Immutable-ish:
// re-uploading just repoints the row to the newer file.
// 10/11: who may touch this expense is decided BEFORE the file is written, so
// a refused caller never leaves an orphan upload on disk; a file written for a
// request that then fails is removed.
async function authorizeReceiptUpload(req: any, _res: any, next: any) {
  try {
    req.expenseCompany = isBookkeeper(req) ? (await bookkeepersExpense(req)).landlordId : await companyOfExpense(req)
    next()
  } catch (e) { next(e) }
}
expensesRouter.post('/:id/receipt', requireExpenseViewer, authorizeReceiptUpload, receiptUpload.single('receipt'), async (req: any, res, next) => {
  let storedKey: string | null = null
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const storedName = newStoredFilename(req.file.originalname, req.file.mimetype)
    await storage.save(`expense-receipts/${storedName}`, req.file.buffer)
    storedKey = `expense-receipts/${storedName}`
    const row = await attachExpenseReceipt(req.params.id, req.expenseCompany, {
      url: '/api/expenses/receipt-files/' + storedName,
      name: (req.file.originalname || 'receipt').slice(0, 200),
      mime: req.file.mimetype,
      size: req.file.size,
    })
    res.json({ success: true, data: row })
  } catch (e) {
    if (storedKey) storage.remove(storedKey).catch(() => { /* already gone */ })
    next(e)
  }
})

// GET /api/expenses/receipt-files/:filename — stream a receipt.
expensesRouter.get('/receipt-files/:filename', async (req, res, next) => {
  try {
    // S587: per-row authorization. This previously served ANY receipt file by
    // filename behind only the router-level requireAuth — a cross-landlord leak
    // of financial receipts (vendor invoices/amounts), the same class as the
    // S586 inspection photo gap. Look up the expense the receipt belongs to and
    // confirm the caller's landlord owns it (admins pass).
    const receiptUrl = '/api/expenses/receipt-files/' + req.params.filename
    // 10/12 (Nic) review: one receipt can sit on several expenses — a split's
    // parts share it, and filing a bank line again after an undo carries the
    // undone expense's receipt onto the new one (the old one kept, voided). So
    // every row holding it is read, the live ones first, and access is decided
    // by the expenses as they stand: a viewer opens it when an ACTIVE expense
    // holding it is theirs to see. A voided one (taken back, kept on file)
    // opens it only to someone with the whole company's records (never a
    // bookkeeper), so a receipt that moved to another property's books is
    // never read through the property it left.
    const held = await query<{ landlord_id: string; property_id: string | null; expense_day: string; active: boolean }>(
      `SELECT landlord_id, property_id, to_char(expense_date, 'YYYY-MM-DD') AS expense_day, (status = 'active') AS active
         FROM landlord_expenses WHERE receipt_url = $1
        ORDER BY (status = 'active') DESC, created_at DESC, id`, [receiptUrl])
    if (!held.length) throw new AppError(404, 'Not found')
    // 10/11: a bookkeeper opens a receipt of their company, filed on a property
    // they keep (a company-wide one only when they keep the whole company).
    if (isBookkeeper(req)) {
      const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
      const ok = held.some(exp => exp.active
        && scope.landlordIds.includes(exp.landlord_id)
        && (scope.propertyIds === null || (!!exp.property_id && scope.propertyIds.includes(exp.property_id)))
        // 10/12: a former property's receipts up to the day it left.
        && !pastCutoff(scope.cutoffs, exp.property_id, exp.expense_day))
      if (!ok) throw new AppError(403, 'Forbidden')
    } else if (!held.some(exp => canAccessLandlordResource(req.user, exp.landlord_id))) throw new AppError(403, 'Forbidden')
    const key = uploadKeyFromStored('expense-receipts', req.params.filename)
    if (!key) throw new AppError(400, 'Invalid filename')
    await sendStoredFile(res, key)
  } catch (e) { next(e) }
})

// PATCH /api/expenses/:id — 10/11: correct an expense. The owner edits any of
// their company's; a bookkeeper the ones they entered, kept on their properties.
expensesRouter.patch('/:id', requireExpenseViewer, async (req: any, res, next) => {
  try {
    const body = z.object({
      category:    z.string().max(60).optional(),
      categoryId:  z.string().uuid().optional(),
      vendorId:    z.string().uuid().nullable().optional(),
      billNumber:  z.string().max(100).nullable().optional(),
      dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      amount:      z.number().positive().optional(),
      description: z.string().max(500).nullable().optional(),
      vendor:      z.string().max(160).nullable().optional(),
      expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      utilityType: z.enum(['water','gas','electric','sewer','trash','propane']).nullable().optional(),
      unitId:      z.string().uuid().nullable().optional(),
      propertyId:  z.string().uuid().nullable().optional(),
      // 10/13 (Nic): where the cost goes, when it is re-filed.
      costPlace:   z.enum(BOOKS_COST_PLACES, { errorMap: () => ({ message: EXPENSE_NO_PLACE }) }).nullable().optional(),
    }).parse(req.body)
    let company: string
    if (isBookkeeper(req)) {
      const own = await bookkeepersExpense(req)
      if (body.costPlace === 'split_by_units' && own.scope.narrowed) throw new AppError(403, SPLIT_NEEDS_WHOLE_COMPANY)
      if (body.unitId !== undefined || body.propertyId !== undefined || body.costPlace !== undefined) {
        await assertBookkeeperPlacement(own.scope, body.unitId, body.propertyId)
      }
      company = own.landlordId
    } else {
      company = await companyOfExpense(req)
    }
    res.json({ success: true, data: await updateLandlordExpense(req.params.id, company, body) })
  } catch (e) { next(e) }
})

// POST /api/expenses/:id/void — the owner's, and (10/12, Nic, ledger decision
// 2: full bookkeeping, design §11 "Voiding expenses") a bookkeeper's on a
// property they keep (expenseForMoneyOut: never one on a property that left
// the company). Kept on record, voided.
// 10/12 (Nic): refused (409) for an expense the bank feed filed; that is
// changed or undone on the Bank page (services/landlordExpenses voidLandlordExpense).
expensesRouter.post('/:id/void', requireExpenseWriter, async (req: any, res, next) => {
  try {
    await voidLandlordExpense(req.params.id, await expenseForMoneyOut(req))
    res.json({ success: true, data: { id: req.params.id, status: 'voided' } })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════════════════════════════════════════
// 10/12 (Nic, GAM Books P6, L5): MONEY OUT IS ONE RECORD
//
//   "those all sound like real expenses. just let bookkeeper/landlord create
//    custom labels or categories to charge things off to."
//
// The company's own categories (money out and money in, each pointed at an
// account of its chart), what was paid on a bill and how, and a completed
// repair's bill (Nic L6). The owner, and a bookkeeper on the properties they
// keep — money going out is open to them (Nic L19); pointing a category at an
// account changes the company's chart, so a bookkeeper needs the ledger.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The company a category write (or the form's choices) is for: GAM Books'
 * open company (X-Client-Id), the account's only company, or the one the
 * request names (landlordId / entityId) — a bookkeeper's own.
 */
async function categoryCompany(req: any): Promise<{ landlordId: string; scope: FinancialsScope }> {
  const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
  if (isBookkeeper(req) || scope.landlordIds.length === 1) return { landlordId: scope.landlordIds[0], scope }
  const landlordId = await landlordForRequest(req, 'category')
  if (!scope.landlordIds.includes(landlordId)) throw new AppError(403, 'That company is not yours.')
  return { landlordId, scope }
}

/**
 * 10/12 (Nic, review): a category is the company's — a bookkeeper writes one
 * only while they keep a property the company still owns (or the company-wide
 * box). One who keeps only a sold property's history reads it, read only
 * (BK3), like every other money-out write.
 */
function keepsNoCurrentProperty(req: any, scope: FinancialsScope): boolean {
  if (!isBookkeeper(req) || scope.companyWide) return false
  const former = new Set(scope.former.map(f => f.propertyId))
  return scope.propertyIds !== null && scope.propertyIds.filter(id => !former.has(id)).length === 0
}
function assertMayWriteCategories(req: any, scope: FinancialsScope): void {
  if (keepsNoCurrentProperty(req, scope)) throw new AppError(403, 'That property has left the company. Its books are read only.')
}

/**
 * The company of an existing expense a payment is recorded on or taken back
 * from: the owner's own (companyOfExpense); a bookkeeper's when it is of their
 * company and on a property they keep (a company-level one only with the
 * whole company), never a property that left the company.
 */
async function expenseForMoneyOut(req: any): Promise<string> {
  if (!isBookkeeper(req)) return companyOfExpense(req)
  const id = String(req.params.id || '')
  const row = /^[0-9a-f-]{36}$/i.test(id)
    ? await queryOne<{ landlord_id: string; property_id: string | null }>(
        `SELECT landlord_id, property_id FROM landlord_expenses WHERE id = $1 AND status = 'active'`, [id])
    : null
  const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
  const inScope = !!row && scope.landlordIds.includes(row.landlord_id)
    && (scope.propertyIds === null || (!!row.property_id && scope.propertyIds.includes(row.property_id)))
  if (!row || !inScope) throw new AppError(404, 'Expense not found')
  if (row.property_id && scope.cutoffs.some(c => c.propertyId === row.property_id && c.lastDay === HIDDEN_HISTORY)) {
    throw new AppError(404, 'Expense not found')
  }
  if (row.property_id && scope.former.some(f => f.propertyId === row.property_id)) {
    throw new AppError(403, 'That property has left the company. Its books are read only.')
  }
  return row.landlord_id
}

// GET /api/expenses/options — what the Expenses form offers: the company's
// categories (money out and money in, each with the account it charges to),
// its vendors, and (with the bank) its linked banks.
expensesRouter.get('/options', requireExpenseViewer, async (req: any, res, next) => {
  try {
    const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
    const ids = scope.landlordIds
    const categories = await listCategories(ids, { includeArchived: req.query.archived === 'true' })
    const vendors = await query<{ id: string; name: string; landlord_id: string }>(
      `SELECT id, name, landlord_id FROM books_vendors
        WHERE landlord_id = ANY($1::uuid[]) AND COALESCE(status, 'active') = 'active'
        ORDER BY lower(name), id`, [ids])
    const banks = scope.companyWide
      ? await query<{ id: string; name: string; landlord_id: string }>(
          `SELECT id, COALESCE(NULLIF(display_name, ''), institution_name, 'Bank account')
                    || CASE WHEN account_last4 IS NOT NULL THEN ' ••' || account_last4 ELSE '' END AS name, landlord_id
             FROM bank_connections WHERE landlord_id = ANY($1::uuid[]) AND status = 'active'
            ORDER BY created_at, id`, [ids])
      : []
    // 10/12 review: canWrite — the money-out writes (payments, categories, a
    // repair's bill). 10/12 (Nic, ledger decision 2): one level, so every
    // bookkeeper the company keeps is offered them.
    // 10/13 review: canSplit — "split across your properties by units"
    // reaches every property, so a bookkeeper kept to some of them is not
    // offered it (POST/PATCH refuse it: SPLIT_NEEDS_WHOLE_COMPANY).
    res.json({ success: true, data: { categories, vendors, banks, canPointAccounts: scope.ledger && mayWrite(req), canWrite: mayWrite(req),
      canSplit: !scope.narrowed } })
  } catch (e) { next(e) }
})

// GET /api/expenses/categories?direction=&archived=true — the company's categories.
expensesRouter.get('/categories', requireExpenseViewer, async (req: any, res, next) => {
  try {
    const { landlordId, scope } = await categoryCompany(req)
    const direction = (BOOKS_CATEGORY_DIRECTIONS as readonly string[]).includes(req.query.direction) ? req.query.direction : undefined
    res.json({ success: true, data: {
      landlordId,
      categories: await listCategories([landlordId], { direction, includeArchived: req.query.archived === 'true' }),
      // The accounts a category may point at (the chart, less what GAM keeps).
      accounts: scope.ledger ? await categoryAccountChoices(landlordId) : [],
      // 10/12 (Nic, review): never offered to a bookkeeper who keeps only a sold property's history.
      canPointAccounts: scope.ledger && mayWrite(req) && !keepsNoCurrentProperty(req, scope),
      canWrite: mayWrite(req) && !keepsNoCurrentProperty(req, scope),
    } })
  } catch (e) { next(e) }
})

const categoryBody = z.object({
  direction: z.enum(BOOKS_CATEGORY_DIRECTIONS).optional(),
  name:      z.string().max(200).optional(),
  accountId: z.string().uuid().nullable().optional(),
  archived:  z.boolean().optional(),
})

// POST /api/expenses/categories — make a category { direction, name, accountId? }.
expensesRouter.post('/categories', requireExpenseWriter, async (req: any, res, next) => {
  try {
    const body = categoryBody.parse(req.body ?? {})
    const { landlordId, scope } = await categoryCompany(req)
    assertMayWriteCategories(req, scope)
    if (body.accountId && !scope.ledger) throw new AppError(403, LEDGER_REFUSAL)
    const id = await createCategory({
      landlordId, direction: body.direction, name: body.name, accountId: body.accountId ?? null, actorUserId: req.user.userId,
    })
    res.status(201).json({ success: true, data: { id } })
  } catch (e) { next(e) }
})

// PATCH /api/expenses/categories/:id — rename, archive or bring back, or point at another account.
expensesRouter.patch('/categories/:id', requireExpenseWriter, async (req: any, res, next) => {
  try {
    const body = categoryBody.parse(req.body ?? {})
    const { landlordId, scope } = await categoryCompany(req)
    assertMayWriteCategories(req, scope)
    if (body.accountId && !scope.ledger) throw new AppError(403, LEDGER_REFUSAL)
    await updateCategory({
      landlordId, id: String(req.params.id), name: body.name, archived: body.archived,
      accountId: body.accountId ?? null, actorUserId: req.user.userId,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/expenses/:id/payments — record a payment toward an expense (a bill
// paid, or part of it): { method, amount?, paidOn?, bankConnectionId?, memo? }.
expensesRouter.post('/:id/payments', requireExpenseWriter, async (req: any, res, next) => {
  try {
    const body = z.object({
      method:           z.enum(LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED),
      amount:           z.number().positive().nullable().optional(),
      paidOn:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      bankConnectionId: z.string().uuid().nullable().optional(),
      memo:             z.string().max(500).nullable().optional(),
    }).parse(req.body ?? {})
    const landlordId = await expenseForMoneyOut(req)
    const id = await recordExpensePayment({
      landlordId, expenseId: String(req.params.id), method: body.method, amount: body.amount ?? null,
      paidOn: body.paidOn ?? null, bankConnectionId: body.bankConnectionId ?? null, memo: body.memo ?? null,
      createdBy: req.user.userId,
    })
    res.status(201).json({ success: true, data: { id } })
  } catch (e) { next(e) }
})

// POST /api/expenses/:id/payments/:paymentId/void — take back a payment recorded
// by hand (kept on record). A bank line's payment is undone on the Bank page.
expensesRouter.post('/:id/payments/:paymentId/void', requireExpenseWriter, async (req: any, res, next) => {
  try {
    const body = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body ?? {})
    const landlordId = await expenseForMoneyOut(req)
    await voidExpensePayment({
      landlordId, expenseId: String(req.params.id), paymentId: String(req.params.paymentId),
      reason: body.reason ?? null, by: req.user.userId,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/expenses/repairs/:requestId/bill — 10/12 (Nic, L6): "Record as
// bill": an unpaid expense for a completed repair's cost (the Maintenance costs
// page). The owner's, and a bookkeeper's on a property they keep.
expensesRouter.post('/repairs/:requestId/bill', requireExpenseWriter, async (req: any, res, next) => {
  try {
    const requestId = String(req.params.requestId || '')
    const repair = /^[0-9a-f-]{36}$/i.test(requestId) ? await repairCompany(requestId) : null
    if (!repair) throw new AppError(404, 'Repair not found')
    const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
    const mine = scope.landlordIds.includes(repair.landlordId)
      && (scope.propertyIds === null || (!!repair.propertyId && scope.propertyIds.includes(repair.propertyId)))
    if (!mine) throw new AppError(404, 'Repair not found')
    if (repair.propertyId && scope.former.some(f => f.propertyId === repair.propertyId)) {
      throw new AppError(403, 'That property has left the company. Its books are read only.')
    }
    res.status(201).json({ success: true, data: await recordRepairBill(repair.landlordId, requestId, req.user.userId) })
  } catch (e) { next(e) }
})
