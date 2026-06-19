/**
 * S501 — business-portal quotes / estimates.
 *
 * Endpoints:
 *   POST   /api/business-quotes                            (create header — draft)
 *   GET    /api/business-quotes                            (list, status filter)
 *   GET    /api/business-quotes/:id                        (detail with lines)
 *   PATCH  /api/business-quotes/:id                        (header fields, draft only)
 *   POST   /api/business-quotes/:id/lines                  (add a line; draft only)
 *   DELETE /api/business-quotes/:id/lines/:lineId          (remove a line; draft only)
 *   POST   /api/business-quotes/:id/send                   (draft → sent + emails customer)
 *   POST   /api/business-quotes/:id/accept                 (sent → accepted)
 *   POST   /api/business-quotes/:id/decline                (sent → declined w/ reason)
 *   POST   /api/business-quotes/:id/convert-to-invoice     (accepted → creates draft invoice)
 *   POST   /api/business-quotes/:id/convert-to-work-order  (accepted → creates open WO)
 *
 * Lines mirror work-order lines: labor / part / fee / generic. Part lines
 * snapshot the inventory item name + price but do NOT decrement stock at
 * quote time — stock decrement only happens when the quote converts to a
 * work order (or when the line is added directly to a WO).
 *
 * Owner-only. Customer-side acceptance page is deferred (v1 model: owner
 * gets verbal/email approval and marks accepted in the portal).
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import {
  applyDiscount,
  resolveDiscountCode,
  computeDiscountAmount,
} from '../services/businessDiscounts'

export const businessQuotesRouter = Router()

// ── helpers ────────────────────────────────────────────────────
// S502: quotes.read for list/detail; quotes.write for create + edit +
// add/remove lines; quotes.send for send / accept / decline / convert
// (the customer-facing flow + creating downstream artifacts).
import { requireBusinessAccess } from '../middleware/businessAccess'

const requireRead  = async (req: any) => (await requireBusinessAccess(req, { permission: 'quotes.read',  feature: 'quotes' })).businessId
const requireWrite = async (req: any) => (await requireBusinessAccess(req, { permission: 'quotes.write', feature: 'quotes' })).businessId
const requireSend  = async (req: any) => (await requireBusinessAccess(req, { permission: 'quotes.send',  feature: 'quotes' })).businessId

function fmtQuoteNumber(n: number): string {
  return `Q-${String(n).padStart(6, '0')}`
}

function dec(n: string | number | null | undefined): number {
  return Math.round(Number(n ?? 0) * 100) / 100
}

// S503: discount-aware totals. subtotal stays GROSS (sum of line
// subtotals); any attached discount code is re-derived against the fresh
// gross subtotal — so a percent code stays correct as lines change and a
// fixed code clamps to the new subtotal. The discount is a PREVIEW: no
// redemption is consumed here (that happens at convert-to-invoice). Tax is
// per-line, so we scale it by (subtotal - discount)/subtotal to keep the
// taxable base consistent with the post-discount amount. A code that was
// deleted out from under the quote drops to a 0 discount + null link.
async function recomputeTotals(client: any, quoteId: string): Promise<void> {
  const { rows: lines } = (await client.query(
    `SELECT line_subtotal, line_tax FROM business_quote_lines WHERE quote_id = $1`,
    [quoteId])) as { rows: Array<{ line_subtotal: string; line_tax: string }> }
  let grossSubtotal = 0, grossTax = 0
  for (const l of lines) {
    grossSubtotal += Number(l.line_subtotal)
    grossTax += Number(l.line_tax)
  }
  grossSubtotal = dec(grossSubtotal); grossTax = dec(grossTax)

  const { rows: [q] } = await client.query(
    `SELECT discount_code_id FROM business_quotes WHERE id = $1`, [quoteId])
  let discount = 0
  let discountCodeId: string | null = q?.discount_code_id ?? null
  if (discountCodeId) {
    const { rows: [dc] } = await client.query(
      `SELECT discount_type, discount_value
         FROM business_discount_codes WHERE id = $1`, [discountCodeId])
    if (dc) {
      discount = computeDiscountAmount(
        dc.discount_type, Number(dc.discount_value), grossSubtotal)
    } else {
      discountCodeId = null
    }
  }

  const taxableFactor = grossSubtotal > 0
    ? (grossSubtotal - discount) / grossSubtotal
    : 0
  const tax = dec(grossTax * taxableFactor)
  const total = dec(grossSubtotal - discount + tax)
  await client.query(
    `UPDATE business_quotes
        SET subtotal = $1, tax_amount = $2, total_amount = $3,
            discount_amount = $4, discount_code_id = $5
      WHERE id = $6`,
    [grossSubtotal, tax, total, discount, discountCodeId, quoteId])
}

// ═══════════════════════════════════════════════════════════════
//  POST / — create header
// ═══════════════════════════════════════════════════════════════

const createSchema = z.object({
  customerId:        z.string().uuid(),
  vehicleId:         z.string().uuid().nullable().optional(),
  intakeDescription: z.string().max(2000).nullable().optional(),
  notes:             z.string().max(2000).nullable().optional(),
  internalNotes:     z.string().max(2000).nullable().optional(),
  // Defaults to 30 days from now if omitted at send time.
  expiresAt:         z.string().datetime().nullable().optional(),
})

businessQuotesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = createSchema.parse(req.body)

    const customer = await queryOne<{ id: string }>(
      `SELECT id FROM business_customers
        WHERE id = $1 AND business_id = $2`,
      [body.customerId, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    if (body.vehicleId) {
      const v = await queryOne<{ id: string; customer_id: string }>(
        `SELECT id, customer_id FROM business_customer_vehicles
          WHERE id = $1 AND business_id = $2`,
        [body.vehicleId, businessId])
      if (!v) throw new AppError(404, 'Vehicle not found')
      if (v.customer_id !== body.customerId) {
        throw new AppError(400, 'Vehicle does not belong to this customer')
      }
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [seq] } = await client.query<{ next_number: number }>(
        `INSERT INTO business_quote_sequences (business_id, next_number)
         VALUES ($1, 2)
         ON CONFLICT (business_id)
           DO UPDATE SET next_number = business_quote_sequences.next_number + 1
         RETURNING next_number`,
        [businessId])
      const isFirst = seq.next_number === 2
      const thisNumber = isFirst ? 1 : seq.next_number - 1
      const qNumber = fmtQuoteNumber(thisNumber)

      const { rows: [q] } = await client.query<any>(
        `INSERT INTO business_quotes
           (business_id, quote_number, customer_id, vehicle_id,
            intake_description, notes, internal_notes, expires_at,
            created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [businessId, qNumber, body.customerId, body.vehicleId ?? null,
         body.intakeDescription?.trim() ?? null,
         body.notes?.trim() ?? null,
         body.internalNotes?.trim() ?? null,
         body.expiresAt ?? null,
         req.user!.userId])

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { ...q, lines: [] } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET / — list
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  status:     z.enum(['draft', 'sent', 'accepted', 'declined', 'expired']).optional(),
  customerId: z.string().uuid().optional(),
  limit:      z.coerce.number().int().positive().max(500).optional(),
})

businessQuotesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let where = 'WHERE q.business_id = $1'
    if (q.status)     { params.push(q.status);     where += ` AND q.status = $${params.length}` }
    if (q.customerId) { params.push(q.customerId); where += ` AND q.customer_id = $${params.length}` }
    params.push(q.limit ?? 100)
    const rows = await query<any>(
      `SELECT q.id, q.quote_number, q.status,
              q.subtotal, q.discount_amount, q.tax_amount, q.total_amount,
              q.expires_at, q.sent_at, q.accepted_at, q.declined_at,
              q.invoice_id, q.work_order_id,
              q.customer_id, q.vehicle_id,
              q.created_at, q.updated_at,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name
         FROM business_quotes q
         JOIN business_customers c ON c.id = q.customer_id
         ${where}
        ORDER BY q.created_at DESC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id — detail with lines
// ═══════════════════════════════════════════════════════════════

businessQuotesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const q = await queryOne<any>(
      `SELECT q.*,
              dc.code AS discount_code,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name,
              c.email AS customer_email,
              c.phone AS customer_phone,
              v.year   AS vehicle_year,
              v.make   AS vehicle_make,
              v.model  AS vehicle_model,
              v.vin    AS vehicle_vin
         FROM business_quotes q
         JOIN business_customers c ON c.id = q.customer_id
         LEFT JOIN business_discount_codes dc ON dc.id = q.discount_code_id
         LEFT JOIN business_customer_vehicles v ON v.id = q.vehicle_id
        WHERE q.id = $1 AND q.business_id = $2`,
      [req.params.id, businessId])
    if (!q) throw new AppError(404, 'Quote not found')
    const lines = await query<any>(
      `SELECT * FROM business_quote_lines
        WHERE quote_id = $1
        ORDER BY sort_order ASC, created_at ASC`, [q.id])
    res.json({ success: true, data: { ...q, lines } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id/pdf — printable estimate PDF (S504)
// ═══════════════════════════════════════════════════════════════

businessQuotesRouter.get('/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const q = await queryOne<any>(
      `SELECT q.*,
              b.name AS biz_name, b.email AS biz_email, b.phone AS biz_phone,
              b.street1 AS biz_street1, b.street2 AS biz_street2,
              b.city AS biz_city, b.state AS biz_state, b.zip AS biz_zip,
              c.first_name AS customer_first_name,
              c.last_name AS customer_last_name,
              c.company_name AS customer_company_name,
              c.email AS customer_email, c.phone AS customer_phone,
              c.street1 AS customer_street1, c.city AS customer_city,
              c.state AS customer_state, c.zip AS customer_zip
         FROM business_quotes q
         JOIN business_customers c ON c.id = q.customer_id
         JOIN businesses b ON b.id = q.business_id
        WHERE q.id = $1 AND q.business_id = $2`,
      [req.params.id, businessId])
    if (!q) throw new AppError(404, 'Quote not found')
    const lines = await query<any>(
      `SELECT description, quantity, unit_price, line_total, discount_amount
         FROM business_quote_lines WHERE quote_id = $1 ORDER BY sort_order ASC`, [q.id])

    const { renderQuotePdf } = await import('../services/businessPdf')
    const buffer = await renderQuotePdf({
      business: {
        name: q.biz_name, email: q.biz_email, phone: q.biz_phone,
        street1: q.biz_street1, street2: q.biz_street2,
        city: q.biz_city, state: q.biz_state, zip: q.biz_zip,
      },
      customer: {
        firstName: q.customer_first_name, lastName: q.customer_last_name,
        companyName: q.customer_company_name,
        email: q.customer_email, phone: q.customer_phone,
        street1: q.customer_street1, city: q.customer_city,
        state: q.customer_state, zip: q.customer_zip,
      },
      quoteNumber: q.quote_number,
      status: q.status,
      createdAt: q.created_at,
      expiresAt: q.expires_at,
      intakeDescription: q.intake_description,
      notes: q.notes,
      lines: lines.map(l => ({
        description: l.description,
        quantity:    Number(l.quantity),
        unitPrice:   Number(l.unit_price),
        lineTotal:   Number(l.line_total),
        discountAmount: Number(l.discount_amount),
      })),
      subtotal:    Number(q.subtotal),
      discountAmount: Number(q.discount_amount),
      taxAmount:   Number(q.tax_amount),
      totalAmount: Number(q.total_amount),
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${q.quote_number}.pdf"`)
    res.send(buffer)
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id — header fields (draft only)
// ═══════════════════════════════════════════════════════════════

const patchSchema = z.object({
  vehicleId:         z.string().uuid().nullable().optional(),
  intakeDescription: z.string().max(2000).nullable().optional(),
  notes:             z.string().max(2000).nullable().optional(),
  internalNotes:     z.string().max(2000).nullable().optional(),
  expiresAt:         z.string().datetime().nullable().optional(),
}).strict()

businessQuotesRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = patchSchema.parse(req.body)
    if (Object.keys(body).length === 0) throw new AppError(400, 'Nothing to update')

    const qExisting = await queryOne<{ id: string; status: string; customer_id: string }>(
      `SELECT id, status, customer_id FROM business_quotes
        WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!qExisting) throw new AppError(404, 'Quote not found')
    if (qExisting.status !== 'draft') {
      throw new AppError(409, 'Header edits only allowed while quote is a draft')
    }

    if (body.vehicleId) {
      const v = await queryOne<{ customer_id: string }>(
        `SELECT customer_id FROM business_customer_vehicles
          WHERE id = $1 AND business_id = $2`,
        [body.vehicleId, businessId])
      if (!v) throw new AppError(404, 'Vehicle not found')
      if (v.customer_id !== qExisting.customer_id) {
        throw new AppError(400, 'Vehicle does not belong to this quote\'s customer')
      }
    }

    const r = await query<any>(
      `UPDATE business_quotes
          SET vehicle_id         = COALESCE($1, vehicle_id),
              intake_description = COALESCE($2, intake_description),
              notes              = COALESCE($3, notes),
              internal_notes     = COALESCE($4, internal_notes),
              expires_at         = COALESCE($5, expires_at)
        WHERE id = $6 AND business_id = $7
        RETURNING *`,
      [body.vehicleId ?? null,
       body.intakeDescription === undefined ? null : (body.intakeDescription?.trim() ?? null),
       body.notes === undefined ? null : (body.notes?.trim() ?? null),
       body.internalNotes === undefined ? null : (body.internalNotes?.trim() ?? null),
       body.expiresAt ?? null,
       req.params.id, businessId])
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id/discount — attach / clear a discount code (draft only)
// ═══════════════════════════════════════════════════════════════
//
// S503: applying a code here is a PREVIEW — it's validated (exists, active,
// in-window, under its redemption cap) and recorded on the quote, but no
// redemption is consumed. The dollar amount is recomputed in
// recomputeTotals so it tracks line changes. The redemption is consumed
// only at convert-to-invoice. Pass { code: null } to clear.

const discountSchema = z.object({
  code: z.string().min(1).max(40).nullable(),
}).strict()

businessQuotesRouter.patch('/:id/discount', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = discountSchema.parse(req.body)

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [q] } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM business_quotes
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!q) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Quote not found')
      }
      if (q.status !== 'draft') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Cannot change the discount on a ${q.status} quote`)
      }

      let codeId: string | null = null
      if (body.code !== null) {
        // Validate without consuming a redemption (preview).
        const dc = await resolveDiscountCode(client, businessId, body.code)
        codeId = dc.id
      }
      await client.query(
        `UPDATE business_quotes SET discount_code_id = $1 WHERE id = $2`,
        [codeId, q.id])
      await recomputeTotals(client, q.id)

      const { rows: [updated] } = await client.query<any>(
        `SELECT * FROM business_quotes WHERE id = $1`, [q.id])
      await client.query('COMMIT')
      res.json({ success: true, data: updated })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/lines — add a line (draft only)
// ═══════════════════════════════════════════════════════════════

// S504: every line variant can carry an optional per-line discount
// (percent | fixed), resolved against the line's gross.
const lineDiscountFields = {
  discountType:  z.enum(['percent', 'fixed']).optional(),
  discountValue: z.number().min(0).max(1_000_000).optional(),
}
const addLineSchema = z.discriminatedUnion('lineType', [
  z.object({
    lineType:    z.literal('labor'),
    description: z.string().min(1).max(500),
    hours:       z.number().positive().max(10000),
    hourlyRate:  z.number().min(0).max(10000),
    taxRate:     z.number().min(0).max(0.9999).optional(),
    ...lineDiscountFields,
  }),
  z.object({
    lineType:    z.literal('part'),
    itemId:      z.string().uuid(),
    quantity:    z.number().positive().max(10000),
    unitPrice:   z.number().min(0).optional(),
    ...lineDiscountFields,
  }),
  z.object({
    lineType:    z.literal('fee'),
    description: z.string().min(1).max(500),
    amount:      z.number().min(0).max(1_000_000),
    taxRate:     z.number().min(0).max(0.9999).optional(),
    ...lineDiscountFields,
  }),
  z.object({
    lineType:    z.literal('generic'),
    description: z.string().min(1).max(500),
    quantity:    z.number().positive().max(10000),
    unitPrice:   z.number().min(0).max(1_000_000),
    taxRate:     z.number().min(0).max(0.9999).optional(),
    ...lineDiscountFields,
  }),
]).superRefine((l, ctx) => {
  if (l.discountType && (l.discountValue === undefined || l.discountValue <= 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'discountValue required when discountType is set', path: ['discountValue'] })
  }
  if (l.discountType === 'percent' && (l.discountValue ?? 0) > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'percent discount cannot exceed 100', path: ['discountValue'] })
  }
})

businessQuotesRouter.post('/:id/lines', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = addLineSchema.parse(req.body)

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [q] } = await client.query<{
        id: string; status: string; customer_id: string;
      }>(
        `SELECT id, status, customer_id FROM business_quotes
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!q) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Quote not found')
      }
      if (q.status !== 'draft') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Cannot add lines to a ${q.status} quote`)
      }

      // S506: resolve the default tax rate to apply when the body
      // doesn't specify one. Customer exemption beats the business
      // default; explicit per-line taxRate (in the body) beats both.
      const { rows: [biz] } = await client.query<{ default_tax_rate: string }>(
        `SELECT default_tax_rate FROM businesses WHERE id = $1`, [businessId])
      const { rows: [cust] } = await client.query<{ tax_exempt: boolean }>(
        `SELECT tax_exempt FROM business_customers WHERE id = $1`, [q.customer_id])
      // Don't apply dec() — that rounds to 2 decimals (correct for money,
      // wrong for the rate itself, which is numeric(5,4) precision).
      const defaultTaxRate = cust?.tax_exempt
        ? 0
        : Number(biz?.default_tax_rate ?? 0)

      const { rows: [maxRow] } = await client.query<{ max: number | null }>(
        `SELECT MAX(sort_order) AS max FROM business_quote_lines WHERE quote_id = $1`,
        [q.id])
      const sortOrder = (maxRow?.max ?? -1) + 1

      // S504: resolve the per-line discount against the line's gross, then
      // derive line_subtotal/line_tax/line_total NET of it. recomputeTotals
      // sums line_subtotal (now post-line-discount) so a whole-order code
      // stacks line-first.
      const resolveLine = (gross: number, taxRate: number) => {
        const g = dec(gross)
        const discountAmount = body.discountType
          ? computeDiscountAmount(body.discountType, body.discountValue ?? 0, g)
          : 0
        const net = dec(g - discountAmount)
        const lineTax = dec(net * taxRate)
        const lineTotal = dec(net + lineTax)
        return {
          net, lineTax, lineTotal,
          discountType: body.discountType ?? null,
          discountValue: body.discountValue ?? 0,
          discountAmount,
        }
      }

      let line: any
      if (body.lineType === 'labor') {
        const taxRate = body.taxRate ?? defaultTaxRate
        const r = resolveLine(body.hours * body.hourlyRate, taxRate)
        const { rows: [created] } = await client.query<any>(
          `INSERT INTO business_quote_lines
             (quote_id, line_type, description, quantity, unit_price,
              tax_rate, line_subtotal, line_tax, line_total, sort_order,
              discount_type, discount_value, discount_amount)
           VALUES ($1, 'labor', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [q.id, body.description.trim(), body.hours, body.hourlyRate,
           taxRate, r.net, r.lineTax, r.lineTotal, sortOrder,
           r.discountType, r.discountValue, r.discountAmount])
        line = created

      } else if (body.lineType === 'fee') {
        const taxRate = body.taxRate ?? defaultTaxRate
        const r = resolveLine(body.amount, taxRate)
        const { rows: [created] } = await client.query<any>(
          `INSERT INTO business_quote_lines
             (quote_id, line_type, description, quantity, unit_price,
              tax_rate, line_subtotal, line_tax, line_total, sort_order,
              discount_type, discount_value, discount_amount)
           VALUES ($1, 'fee', $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [q.id, body.description.trim(), dec(body.amount),
           taxRate, r.net, r.lineTax, r.lineTotal, sortOrder,
           r.discountType, r.discountValue, r.discountAmount])
        line = created

      } else if (body.lineType === 'generic') {
        const taxRate = body.taxRate ?? defaultTaxRate
        const r = resolveLine(body.quantity * body.unitPrice, taxRate)
        const { rows: [created] } = await client.query<any>(
          `INSERT INTO business_quote_lines
             (quote_id, line_type, description, quantity, unit_price,
              tax_rate, line_subtotal, line_tax, line_total, sort_order,
              discount_type, discount_value, discount_amount)
           VALUES ($1, 'generic', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [q.id, body.description.trim(), body.quantity, body.unitPrice,
           taxRate, r.net, r.lineTax, r.lineTotal, sortOrder,
           r.discountType, r.discountValue, r.discountAmount])
        line = created

      } else {
        // part — snapshot price + name, NO stock change at quote time.
        const { rows: [item] } = await client.query<{
          id: string; name: string; sell_price: string; tax_rate: string; is_active: boolean;
        }>(
          `SELECT id, name, sell_price, tax_rate, is_active
             FROM business_inventory_items
            WHERE id = $1 AND business_id = $2`,
          [body.itemId, businessId])
        if (!item) {
          await client.query('ROLLBACK')
          throw new AppError(404, 'Inventory item not found')
        }
        if (!item.is_active) {
          await client.query('ROLLBACK')
          throw new AppError(400, `Item "${item.name}" is archived`)
        }
        const unitPrice = body.unitPrice !== undefined ? dec(body.unitPrice) : dec(item.sell_price)
        // S506: exempt customer zeros out the item's snapshot tax rate.
        const taxRate = cust?.tax_exempt ? 0 : dec(item.tax_rate)
        const r = resolveLine(unitPrice * body.quantity, taxRate)
        const { rows: [created] } = await client.query<any>(
          `INSERT INTO business_quote_lines
             (quote_id, line_type, item_id, description, quantity, unit_price,
              tax_rate, line_subtotal, line_tax, line_total, sort_order,
              discount_type, discount_value, discount_amount)
           VALUES ($1, 'part', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [q.id, item.id, item.name, body.quantity, unitPrice,
           taxRate, r.net, r.lineTax, r.lineTotal, sortOrder,
           r.discountType, r.discountValue, r.discountAmount])
        line = created
      }

      await recomputeTotals(client, q.id)
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: line })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  DELETE /:id/lines/:lineId
// ═══════════════════════════════════════════════════════════════

businessQuotesRouter.delete('/:id/lines/:lineId', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [q] } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM business_quotes
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!q) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Quote not found')
      }
      if (q.status !== 'draft') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Cannot edit lines on a ${q.status} quote`)
      }
      const { rows: [ln] } = await client.query<{ id: string }>(
        `DELETE FROM business_quote_lines
          WHERE id = $1 AND quote_id = $2
          RETURNING id`,
        [req.params.lineId, q.id])
      if (!ln) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Line not found')
      }
      await recomputeTotals(client, q.id)
      await client.query('COMMIT')
      res.json({ success: true, data: { id: ln.id } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/send — draft → sent + email
// ═══════════════════════════════════════════════════════════════

const sendSchema = z.object({
  expiresInDays: z.number().int().positive().max(365).optional(),
})

businessQuotesRouter.post('/:id/send', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)
    const body = sendSchema.parse(req.body ?? {})

    const q = await queryOne<{
      id: string; status: string; quote_number: string;
      subtotal: string; discount_amount: string;
      tax_amount: string; total_amount: string;
      notes: string | null; expires_at: string | null;
      customer_id: string;
    }>(
      `SELECT id, status, quote_number,
              subtotal, discount_amount, tax_amount, total_amount,
              notes, expires_at, customer_id
         FROM business_quotes
        WHERE id = $1 AND business_id = $2 AND status = 'draft'`,
      [req.params.id, businessId])
    if (!q) throw new AppError(404, 'Quote not found or not in draft')

    const lines = await query<{
      description: string; quantity: string; unit_price: string; line_total: string;
    }>(
      `SELECT description, quantity, unit_price, line_total
         FROM business_quote_lines
        WHERE quote_id = $1
        ORDER BY sort_order ASC`, [q.id])
    if (lines.length === 0) throw new AppError(400, 'Add at least one line before sending')

    // Resolve expires_at: prefer body.expiresInDays > existing > 30 days.
    let expiresAtIso: string
    if (body.expiresInDays !== undefined) {
      expiresAtIso = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    } else if (q.expires_at) {
      expiresAtIso = new Date(q.expires_at).toISOString()
    } else {
      expiresAtIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }

    const r = await query<any>(
      `UPDATE business_quotes
          SET status = 'sent',
              sent_at = NOW(),
              expires_at = $1
        WHERE id = $2 AND business_id = $3 AND status = 'draft'
        RETURNING *`,
      [expiresAtIso, q.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Quote not found or not in draft')

    // Best-effort email.
    const customer = await queryOne<{
      email: string | null;
      first_name: string | null; last_name: string | null; company_name: string | null;
    }>(
      `SELECT email, first_name, last_name, company_name
         FROM business_customers WHERE id = $1`, [q.customer_id])
    const biz = await queryOne<{ name: string }>(
      `SELECT name FROM businesses WHERE id = $1`, [businessId])

    if (customer?.email && biz?.name) {
      try {
        const { emailBusinessQuoteSent } = await import('../services/email')
        const fullName = `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim()
        const customerName = customer.company_name || fullName || null
        await emailBusinessQuoteSent({
          to: customer.email,
          customerName,
          businessName: biz.name,
          quoteNumber: q.quote_number,
          lines: lines.map(l => ({
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unit_price),
            lineTotal: Number(l.line_total),
          })),
          subtotal: Number(q.subtotal),
          discountAmount: Number(q.discount_amount),
          taxAmount: Number(q.tax_amount),
          totalAmount: Number(q.total_amount),
          expiresAt: new Date(expiresAtIso),
          notes: q.notes,
          ctx: { businessId, quoteId: q.id },
        })
      } catch {/* logged at email-service layer */}
    }

    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/accept — sent → accepted
// ═══════════════════════════════════════════════════════════════

businessQuotesRouter.post('/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)
    const r = await query<any>(
      `UPDATE business_quotes
          SET status = 'accepted', accepted_at = NOW()
        WHERE id = $1 AND business_id = $2 AND status = 'sent'
        RETURNING *`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Quote not found or not in sent state')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/decline — sent → declined
// ═══════════════════════════════════════════════════════════════

const declineSchema = z.object({
  reason: z.string().min(1).max(500),
})

businessQuotesRouter.post('/:id/decline', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)
    const body = declineSchema.parse(req.body)
    const r = await query<any>(
      `UPDATE business_quotes
          SET status = 'declined', declined_at = NOW(), decline_reason = $1
        WHERE id = $2 AND business_id = $3 AND status = 'sent'
        RETURNING *`,
      [body.reason.trim(), req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Quote not found or not in sent state')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/convert-to-invoice — accepted → draft invoice
// ═══════════════════════════════════════════════════════════════

const convertInvoiceSchema = z.object({
  issueDate: z.string(),
  dueDate:   z.string(),
})

businessQuotesRouter.post('/:id/convert-to-invoice', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)
    const body = convertInvoiceSchema.parse(req.body)
    if (body.dueDate < body.issueDate) {
      throw new AppError(400, 'Due date must be on or after issue date')
    }

    const biz = await queryOne<{ enabled_features: string[] }>(
      `SELECT enabled_features FROM businesses WHERE id = $1`, [businessId])
    if (!biz?.enabled_features.includes('invoicing')) {
      throw new AppError(400, 'Enable the Invoicing feature first (Settings → Features).')
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [q] } = await client.query<any>(
        `SELECT * FROM business_quotes
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!q) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Quote not found')
      }
      if (q.invoice_id) {
        await client.query('ROLLBACK')
        throw new AppError(409, 'This quote has already been invoiced')
      }
      if (q.status !== 'accepted') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Cannot invoice a ${q.status} quote (must be accepted)`)
      }

      const { rows: lines } = await client.query<{
        description: string; quantity: string;
        unit_price: string; line_subtotal: string; line_tax: string;
        sort_order: number;
        discount_type: string | null; discount_value: string; discount_amount: string;
      }>(
        `SELECT description, quantity, unit_price, line_subtotal, line_tax, sort_order,
                discount_type, discount_value, discount_amount
           FROM business_quote_lines
          WHERE quote_id = $1
          ORDER BY sort_order ASC`, [q.id])

      // S503: recompute totals authoritatively from the lines and consume the
      // discount redemption now (not at quote time). If the quote carried a
      // code preview, re-run applyDiscount exactly as a fresh invoice would —
      // it locks the code, re-checks the cap, bumps the count, and returns the
      // dollar amount against the gross subtotal. If the code has since lapsed
      // (expired / exhausted / inactive / deleted), the convert proceeds with
      // no discount rather than blocking the conversion.
      let grossSubtotal = 0, grossTax = 0
      for (const ln of lines) {
        grossSubtotal += Number(ln.line_subtotal)
        grossTax += Number(ln.line_tax)
      }
      grossSubtotal = dec(grossSubtotal); grossTax = dec(grossTax)

      let discountCodeId: string | null = null
      let discountAmount = 0
      if (q.discount_code_id) {
        const { rows: [dc] } = await client.query<{ code: string }>(
          `SELECT code FROM business_discount_codes WHERE id = $1 AND business_id = $2`,
          [q.discount_code_id, businessId])
        if (dc) {
          try {
            const applied = await applyDiscount(client, businessId, dc.code, grossSubtotal)
            discountCodeId = applied.discountCodeId
            discountAmount = applied.discountAmount
          } catch { /* code lapsed — convert without a discount */ }
        }
      }
      const taxableFactor = grossSubtotal > 0
        ? (grossSubtotal - discountAmount) / grossSubtotal
        : 0
      const invSubtotal = grossSubtotal
      const invTax = dec(grossTax * taxableFactor)
      const invTotal = dec(invSubtotal - discountAmount + invTax)

      const { rows: [seq] } = await client.query<{ next_number: number }>(
        `INSERT INTO business_invoice_sequences (business_id, next_number)
         VALUES ($1, 2)
         ON CONFLICT (business_id)
           DO UPDATE SET next_number = business_invoice_sequences.next_number + 1
         RETURNING next_number`,
        [businessId])
      const thisNumber = seq.next_number === 2 ? 1 : seq.next_number - 1
      const invoiceNumber = `INV-${String(thisNumber).padStart(4, '0')}`

      const { rows: [inv] } = await client.query<any>(
        `INSERT INTO business_invoices
           (business_id, invoice_number, customer_id,
            issue_date, due_date, status,
            subtotal, discount_code_id, discount_amount, tax_amount, total_amount,
            notes, source_quote_id)
         VALUES ($1, $2, $3, $4, $5, 'draft',
                 $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [businessId, invoiceNumber, q.customer_id,
         body.issueDate, body.dueDate,
         invSubtotal, discountCodeId, discountAmount, invTax, invTotal,
         q.notes, q.id])

      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]!
        // S504: line_subtotal is already NET of any per-line discount; carry
        // the per-line discount fields so the invoice shows the same breakdown.
        await client.query(
          `INSERT INTO business_invoice_lines
             (invoice_id, description, quantity, unit_price, line_total, sort_order,
              discount_type, discount_value, discount_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [inv.id, ln.description,
           Number(ln.quantity), Number(ln.unit_price),
           Number(ln.line_subtotal), i,
           ln.discount_type, Number(ln.discount_value), Number(ln.discount_amount)])
      }

      await client.query(
        `UPDATE business_quotes SET invoice_id = $1 WHERE id = $2`,
        [inv.id, q.id])

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: inv })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/convert-to-work-order — accepted → open WO
// ═══════════════════════════════════════════════════════════════

businessQuotesRouter.post('/:id/convert-to-work-order', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)

    const biz = await queryOne<{ enabled_features: string[] }>(
      `SELECT enabled_features FROM businesses WHERE id = $1`, [businessId])
    if (!biz?.enabled_features.includes('work_orders')) {
      throw new AppError(400, 'Enable the Work Orders feature first (Settings → Features).')
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [q] } = await client.query<any>(
        `SELECT * FROM business_quotes
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [req.params.id, businessId])
      if (!q) {
        await client.query('ROLLBACK')
        throw new AppError(404, 'Quote not found')
      }
      if (q.work_order_id) {
        await client.query('ROLLBACK')
        throw new AppError(409, 'This quote has already been converted to a work order')
      }
      if (q.status !== 'accepted') {
        await client.query('ROLLBACK')
        throw new AppError(409, `Cannot convert a ${q.status} quote (must be accepted)`)
      }

      const { rows: [seq] } = await client.query<{ next_number: number }>(
        `INSERT INTO business_work_order_sequences (business_id, next_number)
         VALUES ($1, 2)
         ON CONFLICT (business_id)
           DO UPDATE SET next_number = business_work_order_sequences.next_number + 1
         RETURNING next_number`,
        [businessId])
      const thisNumber = seq.next_number === 2 ? 1 : seq.next_number - 1
      const woNumber = `WO-${String(thisNumber).padStart(6, '0')}`

      const { rows: [wo] } = await client.query<any>(
        `INSERT INTO business_work_orders
           (business_id, wo_number, customer_id, vehicle_id,
            complaint, source_quote_id, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [businessId, woNumber, q.customer_id, q.vehicle_id,
         q.intake_description, q.id, req.user!.userId])

      // Copy lines into the WO. Part lines DO decrement stock here
      // (this is the first "real commit" of inventory). Labor / fee /
      // generic carry over with their snapshotted price + tax.
      const { rows: qLines } = await client.query<{
        line_type: string; item_id: string | null;
        description: string; quantity: string; unit_price: string;
        tax_rate: string; line_subtotal: string; line_tax: string;
        line_total: string; sort_order: number;
      }>(
        `SELECT line_type, item_id, description, quantity, unit_price,
                tax_rate, line_subtotal, line_tax, line_total, sort_order
           FROM business_quote_lines
          WHERE quote_id = $1
          ORDER BY sort_order ASC`, [q.id])

      let laborSubtotal = 0, partsSubtotal = 0, taxAmount = 0

      for (const ln of qLines) {
        // Map quote line types to WO line types: 'generic' falls to 'fee'
        // since the WO schema only knows labor/part/fee.
        const woLineType = ln.line_type === 'generic' ? 'fee' : ln.line_type
        if (woLineType === 'labor') laborSubtotal += Number(ln.line_subtotal)
        else                        partsSubtotal += Number(ln.line_subtotal)
        taxAmount += Number(ln.line_tax)

        await client.query(
          `INSERT INTO business_work_order_lines
             (work_order_id, line_type, item_id, description, quantity, unit_price,
              tax_rate, line_subtotal, line_tax, line_total, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [wo.id, woLineType, ln.line_type === 'part' ? ln.item_id : null,
           ln.description, Number(ln.quantity), Number(ln.unit_price),
           Number(ln.tax_rate), Number(ln.line_subtotal),
           Number(ln.line_tax), Number(ln.line_total), ln.sort_order])

        // Part line: lock + decrement stock + write audit.
        if (ln.line_type === 'part' && ln.item_id) {
          const qty = Number(ln.quantity)
          const { rows: [item] } = await client.query<{ stock_qty: number; name: string }>(
            `SELECT stock_qty, name FROM business_inventory_items
              WHERE id = $1 FOR UPDATE`, [ln.item_id])
          if (!item) {
            await client.query('ROLLBACK')
            throw new AppError(404, 'Inventory item referenced on quote no longer exists')
          }
          if (item.stock_qty < qty) {
            await client.query('ROLLBACK')
            throw new AppError(400,
              `Not enough stock for "${item.name}" (need ${qty}, have ${item.stock_qty})`)
          }
          const newStock = item.stock_qty - qty
          await client.query(
            `UPDATE business_inventory_items SET stock_qty = $1 WHERE id = $2`,
            [newStock, ln.item_id])
          await client.query(
            `INSERT INTO business_inventory_adjustments
               (business_id, item_id, adjustment_type, quantity_delta,
                stock_qty_after, notes, actor_user_id,
                reference_type, reference_id)
             VALUES ($1, $2, 'used', $3, $4, $5, $6, 'work_order', $7)`,
            [businessId, ln.item_id, -qty, newStock,
             `Used on ${woNumber} (converted from ${q.quote_number})`,
             req.user!.userId, wo.id])
        }
      }

      // Stamp WO totals (recomputeTotals shape mirrored inline).
      const total = dec(laborSubtotal + partsSubtotal + taxAmount)
      await client.query(
        `UPDATE business_work_orders
            SET labor_subtotal = $1, parts_subtotal = $2,
                tax_amount = $3, total_amount = $4
          WHERE id = $5`,
        [dec(laborSubtotal), dec(partsSubtotal), dec(taxAmount), total, wo.id])

      // Link both directions.
      await client.query(
        `UPDATE business_quotes SET work_order_id = $1 WHERE id = $2`,
        [wo.id, q.id])

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { ...wo, total_amount: total } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})
