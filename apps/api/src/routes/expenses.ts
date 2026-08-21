// Landlord-entered expenses (S568, Nic). Unit-linked or common; feeds the P&L.
import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import multer from 'multer'
import { z } from 'zod'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { resolveUploadPath } from '../lib/uploadPaths'
import { queryOne } from '../db'
import { EXPENSE_CATEGORIES } from '@gam/shared'
import { createLandlordExpense, listLandlordExpenses, voidLandlordExpense, attachExpenseReceipt } from '../services/landlordExpenses'

export const expensesRouter = Router()
expensesRouter.use(requireAuth)

// S575: receipt uploads. One dir + one authed serve route; unguessable
// filenames + the router-level requireAuth are the guard (same posture as the
// maintenance/inspection media routes — gam-nothing-public-rule, no static
// /uploads). PDF or image only.
const receiptDir = path.join(process.cwd(), 'uploads', 'expense-receipts')
if (!fs.existsSync(receiptDir)) fs.mkdirSync(receiptDir, { recursive: true })
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: receiptDir,
    filename: (_req: any, file: any, cb: any) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname)),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(file.mimetype)) cb(null, true)
    else cb(new Error('PDF or image only'))
  },
})

function scope(req: any): string {
  const id = req.user.role === 'landlord' ? req.user.profileId : req.user.landlordId
  if (!id) throw new AppError(403, 'A landlord context is required.')
  return id
}

// GET /api/expenses?from=&to=&propertyId=&unitId=
expensesRouter.get('/', requireLandlord, async (req: any, res, next) => {
  try {
    const q = req.query
    res.json({ success: true, data: await listLandlordExpenses(scope(req), {
      from: q.from, to: q.to, propertyId: q.propertyId, unitId: q.unitId,
    }) })
  } catch (e) { next(e) }
})

// POST /api/expenses
expensesRouter.post('/', requireLandlord, async (req: any, res, next) => {
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
    const row = await createLandlordExpense({
      landlordId: scope(req), createdBy: req.user.userId,
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
expensesRouter.post('/:id/receipt', requireLandlord, receiptUpload.single('receipt'), async (req: any, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const row = await attachExpenseReceipt(req.params.id, scope(req), {
      url: '/api/expenses/receipt-files/' + req.file.filename,
      name: (req.file.originalname || 'receipt').slice(0, 200),
      mime: req.file.mimetype,
      size: req.file.size,
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
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
    const exp = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM landlord_expenses WHERE receipt_url = $1`, [receiptUrl])
    if (!exp) throw new AppError(404, 'Not found')
    if (!canAccessLandlordResource(req.user, exp.landlord_id)) throw new AppError(403, 'Forbidden')
    const fp = resolveUploadPath(receiptDir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.sendFile(fp)
  } catch (e) { next(e) }
})

// POST /api/expenses/:id/void
expensesRouter.post('/:id/void', requireLandlord, async (req: any, res, next) => {
  try {
    await voidLandlordExpense(req.params.id, scope(req))
    res.json({ success: true, data: { id: req.params.id, status: 'voided' } })
  } catch (e) { next(e) }
})
