// Landlord-entered expenses (S568, Nic). Unit-linked or common; feeds the P&L.
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAuth, requireLandlord, requireRole } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { storage, sendStoredFile, uploadKeyFromStored, newStoredFilename } from '../lib/storage'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordTarget, landlordScopeIds, landlordForRequest, ownsLandlord } from '../lib/landlordScope'
import { queryOne } from '../db'
import { EXPENSE_CATEGORIES } from '@gam/shared'
import { createLandlordExpense, listLandlordExpenses, voidLandlordExpense, attachExpenseReceipt, updateLandlordExpense } from '../services/landlordExpenses'
import { financialsScope, propertyInScope, type FinancialsScope } from '../lib/financialsScope'

export const expensesRouter = Router()
expensesRouter.use(requireAuth)

// 10/11 (Nic): "any receipts that I upload as expenses whether they're tacked
// on to a unit or to a whole property... miscellaneous purchases like fuel for
// equipment... They need to see all of that stuff." A bookkeeper looks at the
// expenses of the properties they keep and adds their own — "Look + add
// expenses" (Nic's choice). They edit and attach receipts to the ones they
// entered; removing an expense stays the owner's. requireAuth has already
// kept them to these routes (lib/bookkeeperAccess) and put their company and
// properties on the request.
const requireExpenseViewer = requireRole('admin', 'super_admin', 'landlord', 'bookkeeper')
const isBookkeeper = (req: any) => req.user?.role === 'bookkeeper'

/**
 * 10/11: a bookkeeper's write on an EXISTING expense — one they entered, of
 * their company, filed on a property they keep. Anything else reads as missing
 * (404), the same as another account's row reads to an owner.
 */
async function bookkeepersOwnExpense(req: any): Promise<{ landlordId: string; scope: FinancialsScope }> {
  const id = String(req.params.id || '')
  const row = /^[0-9a-f-]{36}$/i.test(id)
    ? await queryOne<{ landlord_id: string; property_id: string | null; created_by: string | null }>(
        `SELECT landlord_id, property_id, created_by FROM landlord_expenses WHERE id = $1 AND status = 'active'`, [id])
    : null
  const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
  const inScope = !!row && scope.landlordIds.includes(row.landlord_id)
    && (scope.propertyIds === null || (!!row.property_id && scope.propertyIds.includes(row.property_id)))
  if (!row || !inScope || row.created_by !== req.user.userId) throw new AppError(404, 'Expense not found')
  return { landlordId: row.landlord_id, scope }
}

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
    if ((role === 'landlord' && !q.entityId) || role === 'bookkeeper') {
      const scope = await financialsScope(req)
      ids = scope.landlordIds
      propertyIds = scope.propertyIds
    } else {
      ids = readScope(req)
    }
    const rows = await listLandlordExpenses(ids, {
      from: q.from, to: q.to, unitId: q.unitId, propertyIds,
      propertyId: propertyIds ? undefined : q.propertyId,
    })
    const me = req.user.userId
    res.json({ success: true, data: rows.map((r: any) => ({
      ...r,
      can_edit: role !== 'bookkeeper' || r.created_by === me,
      can_remove: role !== 'bookkeeper',
    })) })
  } catch (e) { next(e) }
})

// POST /api/expenses
expensesRouter.post('/', requireExpenseViewer, async (req: any, res, next) => {
  try {
    const body = z.object({
      propertyId:      z.string().uuid().nullable().optional(),
      unitId:          z.string().uuid().nullable().optional(),
      category:        z.enum(EXPENSE_CATEGORIES as unknown as [string, ...string[]]),
      amount:          z.number().positive(),
      description:     z.string().max(500).nullable().optional(),
      vendor:          z.string().max(160).nullable().optional(),
      expenseDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      isCommon:        z.boolean().optional(),
      // S613: which utility this bill was for. Drives the recovery report —
      // what came in for water vs what was billed back out for water.
      utilityType:     z.enum(['water','gas','electric','sewer','trash','propane']).nullable().optional(),
    }).parse(req.body)
    // 10/11: a bookkeeper files on their own company, on a unit or property
    // they keep — checked here, never taken from the body on trust.
    let landlordId: string
    if (isBookkeeper(req)) {
      const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
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
      category: body.category, amount: body.amount, description: body.description ?? null,
      vendor: body.vendor ?? null, expenseDate: body.expenseDate,
      isCommon: body.isCommon, utilityType: body.utilityType ?? null,
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
    req.expenseCompany = isBookkeeper(req) ? (await bookkeepersOwnExpense(req)).landlordId : await companyOfExpense(req)
    next()
  } catch (e) { next(e) }
}
expensesRouter.post('/:id/receipt', requireExpenseViewer, authorizeReceiptUpload, receiptUpload.single('receipt'), async (req: any, res, next) => {
  let storedKey: string | null = null
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const storedName = newStoredFilename(req.file.originalname)
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
    const exp = await queryOne<{ landlord_id: string; property_id: string | null }>(
      `SELECT landlord_id, property_id FROM landlord_expenses WHERE receipt_url = $1`, [receiptUrl])
    if (!exp) throw new AppError(404, 'Not found')
    // 10/11: a bookkeeper opens a receipt of their company, filed on a property
    // they keep (a company-wide one only when they keep the whole company).
    if (isBookkeeper(req)) {
      const scope = await financialsScope({ user: req.user, headers: req.headers, query: {} })
      const ok = scope.landlordIds.includes(exp.landlord_id)
        && (scope.propertyIds === null || (!!exp.property_id && scope.propertyIds.includes(exp.property_id)))
      if (!ok) throw new AppError(403, 'Forbidden')
    } else if (!canAccessLandlordResource(req.user, exp.landlord_id)) throw new AppError(403, 'Forbidden')
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
      category:    z.enum(EXPENSE_CATEGORIES as unknown as [string, ...string[]]).optional(),
      amount:      z.number().positive().optional(),
      description: z.string().max(500).nullable().optional(),
      vendor:      z.string().max(160).nullable().optional(),
      expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      utilityType: z.enum(['water','gas','electric','sewer','trash','propane']).nullable().optional(),
      unitId:      z.string().uuid().nullable().optional(),
      propertyId:  z.string().uuid().nullable().optional(),
    }).parse(req.body)
    let company: string
    if (isBookkeeper(req)) {
      const own = await bookkeepersOwnExpense(req)
      if (body.unitId !== undefined || body.propertyId !== undefined) {
        await assertBookkeeperPlacement(own.scope, body.unitId, body.propertyId)
      }
      company = own.landlordId
    } else {
      company = await companyOfExpense(req)
    }
    res.json({ success: true, data: await updateLandlordExpense(req.params.id, company, body) })
  } catch (e) { next(e) }
})

// POST /api/expenses/:id/void — the owner's alone (a bookkeeper looks and adds).
expensesRouter.post('/:id/void', requireLandlord, async (req: any, res, next) => {
  try {
    await voidLandlordExpense(req.params.id, await companyOfExpense(req))
    res.json({ success: true, data: { id: req.params.id, status: 'voided' } })
  } catch (e) { next(e) }
})
