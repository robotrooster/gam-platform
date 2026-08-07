// Resident-to-resident home sale (S594, Nic). A resident sells their OWN
// home/RV to another resident on payments. GAM records the deal + holds a copy
// of the contract, but processes NO money (that's strictly between the two
// residents — the absolute distinction from the landlord→tenant sale in
// routes/homeSale.ts, which GAM bills). Landlord-recorded, scoped to their unit.
import { Router } from 'express'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import multer from 'multer'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord, requirePerm } from '../middleware/auth'
import { canManageLandlordResource, canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { getActiveHomeOwner } from '../services/homeOwnership'
import { resolveOrCreateSignerUser } from '../services/signerAccounts'
import { streamStoredFile } from '../lib/fileServe'
import { createResidentHomeSale, setResidentInstallmentPaid, cancelResidentHomeSale } from '../services/residentHomeSale'

export const residentHomeSaleRouter = Router()
residentHomeSaleRouter.use(requireAuth)

const contractDir = path.join(process.cwd(), 'uploads', 'docs')
if (!fs.existsSync(contractDir)) fs.mkdirSync(contractDir, { recursive: true })
const contractUpload = multer({
  storage: multer.diskStorage({
    destination: contractDir,
    filename: (_req: any, file: any, cb: any) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname)),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    if (ok.includes(file.mimetype)) cb(null, true)
    else cb(new Error('PDF, image, or Word document only'))
  },
})

async function unitManagedByCaller(req: any, unitId: string) {
  const unit = await queryOne<any>(
    `SELECT id, landlord_id, property_id, dwelling_ownership FROM units WHERE id=$1`, [unitId])
  if (!unit) throw new AppError(404, 'Unit not found')
  if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
  return unit
}

const createSchema = z.object({
  unitId:           z.string().uuid(),
  // buyer: an existing account, OR a name + email (mints a 'contact' account).
  buyerUserId:      z.string().uuid().nullable().optional(),
  buyerName:        z.string().trim().min(1).nullable().optional(),
  buyerEmail:       z.string().email().nullable().optional(),
  startMonth:       z.string().regex(/^\d{4}-\d{2}-01$/),
  planType:         z.enum(['amortized', 'flat']).default('flat'),
  notes:            z.string().max(2000).nullable().optional(),
  // amortized inputs
  salePrice:        z.number().positive().optional(),
  downPayment:      z.number().min(0).default(0),
  annualInterestRate: z.number().min(0).max(60).default(0),
  termMonths:       z.number().int().positive().max(600).optional(),
  // flat inputs
  monthlyAmount:    z.number().positive().optional(),
  numberOfPayments: z.number().int().positive().max(600).optional(),
})

// POST /api/resident-home-sales — record a resident→resident financed sale.
residentHomeSaleRouter.post('/', requireLandlord, requirePerm('units.edit'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const b = createSchema.parse(req.body)
    const unit = await unitManagedByCaller(req, b.unitId)
    if (unit.dwelling_ownership !== 'tenant') {
      throw new AppError(409, 'This is a park-owned home — use the landlord financed sale, not a resident-to-resident sale.')
    }
    // Seller = the home's recorded current owner.
    const owner = await getActiveHomeOwner(b.unitId)
    if (!owner) throw new AppError(400, "Record the home's current owner first, then set up the sale.")
    const sellerUserId = owner.owner_user_id

    // Resolve the plan into amortization inputs (flat = 0% each installment).
    let salePrice: number, downPayment: number, annualInterestRate: number, termMonths: number
    if (b.planType === 'flat') {
      if (b.monthlyAmount == null || b.numberOfPayments == null)
        throw new AppError(400, 'A flat plan needs a monthly amount and a number of payments.')
      salePrice = Math.round(b.monthlyAmount * b.numberOfPayments * 100) / 100
      downPayment = 0; annualInterestRate = 0; termMonths = b.numberOfPayments
    } else {
      if (b.salePrice == null || b.termMonths == null)
        throw new AppError(400, 'An amortized plan needs a sale price and a term.')
      salePrice = b.salePrice; downPayment = b.downPayment
      annualInterestRate = b.annualInterestRate; termMonths = b.termMonths
    }

    await client.query('BEGIN')
    // Resolve the buyer (existing account or mint a contact).
    let buyerUserId = b.buyerUserId ?? null
    if (!buyerUserId) {
      if (!b.buyerEmail || !b.buyerName) throw new AppError(400, 'Provide a buyer account, or a name + email to create one.')
      const r = await resolveOrCreateSignerUser(client as any, { email: b.buyerEmail, name: b.buyerName })
      buyerUserId = r.userId
    }
    if (buyerUserId === sellerUserId) throw new AppError(400, 'The buyer and the current owner (seller) must be different people.')

    const sale = await createResidentHomeSale(client as any, {
      unitId: b.unitId, propertyId: unit.property_id, landlordId: unit.landlord_id,
      sellerUserId, buyerUserId, planType: b.planType,
      salePrice, downPayment, annualInterestRate, termMonths, startMonth: b.startMonth,
      notes: b.notes ?? null, createdByUserId: req.user.userId,
    })
    await client.query('COMMIT')

    const schedule = await query<any>(
      `SELECT installment_number, due_month, amount, principal_portion, interest_portion, remaining_balance, paid, paid_at
         FROM resident_home_sale_installments WHERE sale_id=$1 ORDER BY installment_number`, [sale.id])
    res.status(201).json({ success: true, data: { sale, schedule } })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally { client.release() }
})

// GET /api/resident-home-sales/unit/:unitId — active (or latest) sale + schedule,
// plus setup context (dwelling ownership + the recorded owner as the seller).
residentHomeSaleRouter.get('/unit/:unitId', async (req: any, res, next) => {
  try {
    const unit = await queryOne<any>(
      `SELECT id, landlord_id, dwelling_ownership FROM units WHERE id=$1`, [req.params.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const sale = await queryOne<any>(
      `SELECT rhs.*,
              su.first_name AS seller_first, su.last_name AS seller_last, su.email AS seller_email,
              bu.first_name AS buyer_first,  bu.last_name AS buyer_last,  bu.email AS buyer_email,
              d.name AS contract_name, d.url AS contract_url
         FROM resident_home_sales rhs
         JOIN users su ON su.id = rhs.seller_user_id
         JOIN users bu ON bu.id = rhs.buyer_user_id
         LEFT JOIN documents d ON d.id = rhs.contract_document_id
        WHERE rhs.unit_id=$1 ORDER BY (rhs.status='active') DESC, rhs.created_at DESC LIMIT 1`,
      [req.params.unitId])
    const schedule = sale
      ? await query<any>(
          `SELECT installment_number, due_month, amount, principal_portion, interest_portion, remaining_balance, paid, paid_at
             FROM resident_home_sale_installments WHERE sale_id=$1 ORDER BY installment_number`, [sale.id])
      : []
    const owner = await getActiveHomeOwner(req.params.unitId)
    res.json({ success: true, data: {
      sale: sale ?? null, schedule,
      dwellingOwnership: unit.dwelling_ownership,
      currentOwner: owner ?? null,
    } })
  } catch (e) { next(e) }
})

// POST /api/resident-home-sales/:id/installments/:n/mark-paid — record (or undo)
// that the buyer paid the seller off-platform. On the final one, flips ownership.
residentHomeSaleRouter.post('/:id/installments/:n/mark-paid', requireLandlord, requirePerm('units.edit'), async (req: any, res, next) => {
  try {
    const b = z.object({ paid: z.boolean().default(true) }).parse(req.body ?? {})
    const sale = await queryOne<any>(`SELECT id, landlord_id FROM resident_home_sales WHERE id=$1`, [req.params.id])
    if (!sale) throw new AppError(404, 'Sale not found')
    if (!canManageLandlordResource(req.user, sale.landlord_id)) throw new AppError(403, 'Forbidden')
    const n = parseInt(req.params.n, 10)
    if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'Bad installment number')
    const result = await setResidentInstallmentPaid(sale.id, n, req.user.userId, b.paid)
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// POST /api/resident-home-sales/:id/cancel — stop tracking (soft; record kept).
residentHomeSaleRouter.post('/:id/cancel', requireLandlord, requirePerm('units.edit'), async (req: any, res, next) => {
  try {
    const sale = await queryOne<any>(`SELECT id, landlord_id FROM resident_home_sales WHERE id=$1`, [req.params.id])
    if (!sale) throw new AppError(404, 'Sale not found')
    if (!canManageLandlordResource(req.user, sale.landlord_id)) throw new AppError(403, 'Forbidden')
    await cancelResidentHomeSale(sale.id)
    res.json({ success: true, data: { id: sale.id, status: 'cancelled' } })
  } catch (e) { next(e) }
})

// POST /api/resident-home-sales/:id/contract — upload/replace the signed
// agreement (a copy on file). Stored as a documents row + linked to the sale.
residentHomeSaleRouter.post('/:id/contract', requireLandlord, requirePerm('units.edit'), contractUpload.single('file'), async (req: any, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const sale = await queryOne<any>(
      `SELECT id, landlord_id, unit_id FROM resident_home_sales WHERE id=$1`, [req.params.id])
    if (!sale) throw new AppError(404, 'Sale not found')
    if (!canManageLandlordResource(req.user, sale.landlord_id)) throw new AppError(403, 'Forbidden')
    const doc = await queryOne<any>(
      `INSERT INTO documents (unit_id, landlord_id, type, name, url, file_size, mime_type)
       VALUES ($1,$2,'other',$3,$4,$5,$6) RETURNING id, name, url`,
      [sale.unit_id, sale.landlord_id, req.body?.name || req.file.originalname,
       `/uploads/docs/${req.file.filename}`, req.file.size, req.file.mimetype])
    await query(`UPDATE resident_home_sales SET contract_document_id=$2, updated_at=now() WHERE id=$1`, [sale.id, doc.id])
    res.status(201).json({ success: true, data: doc })
  } catch (e) { next(e) }
})

// GET /api/resident-home-sales/:id/contract — stream the contract on file.
// Per-row scoped to the sale's landlord; authorize by the row, never the
// filename; stay inside uploads/ even if a url row is malformed.
residentHomeSaleRouter.get('/:id/contract', async (req: any, res, next) => {
  try {
    const row = await queryOne<any>(
      `SELECT rhs.landlord_id, d.url, d.mime_type
         FROM resident_home_sales rhs
         JOIN documents d ON d.id = rhs.contract_document_id
        WHERE rhs.id=$1`, [req.params.id])
    if (!row) throw new AppError(404, 'No contract on file')
    if (!canAccessLandlordResource(req.user, row.landlord_id)) throw new AppError(403, 'Forbidden')
    // Authorized above; the helper owns path-safety + streaming.
    streamStoredFile(res, row.url, row.mime_type)
  } catch (e) { next(e) }
})
