/**
 * S493 — business-portal invoicing CRUD.
 *
 * Owner / staff manage invoices issued by their business to its
 * customers. Distinct from real-estate `invoices` (which are
 * lease-coupled). Status lifecycle:
 *
 *   draft → sent → paid     (happy path)
 *   draft → void            (cancelled before sending)
 *   sent  → void            (cancelled after; admin action)
 *
 * Endpoints:
 *   POST   /api/business-invoices               — create (with lines)
 *   GET    /api/business-invoices               — list (status / customer filters)
 *   GET    /api/business-invoices/:id           — full detail with lines
 *   POST   /api/business-invoices/:id/send      — draft → sent
 *   POST   /api/business-invoices/:id/mark-paid — sent → paid (manual: cash/check/ACH/external)
 *   POST   /api/business-invoices/:id/void      — any non-paid → void
 *
 * Owner-only for now. Staff access (manager / dispatcher edit;
 * driver read-only) is a future expansion under the staff
 * permission framework.
 *
 * Stripe Connect wiring (destination charges via the business's
 * connect account) lands next session — the schema carries
 * stripe_payment_intent_id already.
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { refundBusinessInvoicePayment } from '../services/stripeConnect'
import { logger } from '../lib/logger'

export const businessInvoicesRouter = Router()

// ── helpers ────────────────────────────────────────────────────
// S502: thin wrappers around requireBusinessAccess so each endpoint
// declares the exact permission it needs while keeping call sites
// terse. Read endpoints take 'invoices.read'; write CRUD takes
// 'invoices.write'; send / mark-paid / void take 'invoices.send'.
import { requireBusinessAccess } from '../middleware/businessAccess'
import { applyDiscount, computeDiscountAmount } from '../services/businessDiscounts'
import { BUSINESS_DEPOSIT_TYPES, computeInvoiceDue } from '@gam/shared'

const requireRead  = async (req: any) => (await requireBusinessAccess(req, { permission: 'invoices.read',  feature: 'invoicing' })).businessId
const requireWrite = async (req: any) => (await requireBusinessAccess(req, { permission: 'invoices.write', feature: 'invoicing' })).businessId
const requireSend  = async (req: any) => (await requireBusinessAccess(req, { permission: 'invoices.send',  feature: 'invoicing' })).businessId

// ═══════════════════════════════════════════════════════════════
//  POST / — create invoice (with lines, in one transaction)
// ═══════════════════════════════════════════════════════════════

const lineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity:    z.number().positive(),
  unitPrice:   z.number().min(0),
  serviceKey:  z.string().max(120).optional(),
  // S504: optional per-line discount. percent → value is % off this line;
  // fixed → value is $ off this line. Resolved against the line's gross.
  discountType:  z.enum(['percent', 'fixed']).optional(),
  discountValue: z.number().min(0).optional(),
}).superRefine((l, ctx) => {
  if (l.discountType && (l.discountValue === undefined || l.discountValue <= 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'discountValue required when discountType is set', path: ['discountValue'] })
  }
  if (l.discountType === 'percent' && (l.discountValue ?? 0) > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'percent discount cannot exceed 100', path: ['discountValue'] })
  }
})

const createSchema = z.object({
  customerId:    z.string().uuid(),
  issueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  taxAmount:     z.number().min(0).optional(),
  // S513: optional discount code, applied pre-tax to the subtotal.
  discountCode:  z.string().min(1).max(40).optional(),
  notes:         z.string().max(2000).nullable().optional(),
  internalNotes: z.string().max(2000).nullable().optional(),
  // S511: optional upfront deposit (Business #9). Tagged service|materials.
  // Must be paired (amount>0 ⇔ type set) and ≤ total (total checked post-calc).
  depositAmount: z.number().min(0).optional(),
  depositType:   z.enum(BUSINESS_DEPOSIT_TYPES).optional(),
  lines:         z.array(lineSchema).min(1).max(200),
}).superRefine((b, ctx) => {
  const amt = b.depositAmount ?? 0
  if (amt > 0 && !b.depositType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'depositType is required when a deposit is set', path: ['depositType'] })
  }
  if (b.depositType && amt <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'depositAmount must be > 0 when depositType is set', path: ['depositAmount'] })
  }
})

businessInvoicesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = createSchema.parse(req.body)

    // Verify customer belongs to this business + grab their exemption.
    const c = await queryOne<{ id: string; tax_exempt: boolean }>(
      `SELECT id, tax_exempt FROM business_customers
        WHERE id = $1 AND business_id = $2 AND status = 'active'`,
      [body.customerId, businessId])
    if (!c) throw new AppError(404, 'Customer not found')

    if (new Date(body.dueDate) < new Date(body.issueDate)) {
      throw new AppError(400, 'due_date must be >= issue_date')
    }

    const round2 = (n: number) => Math.round(n * 100) / 100
    // S504: resolve each line's per-line discount up front. line net =
    // gross - line discount; the order subtotal is the sum of net line
    // amounts (post-line-discount), so a whole-order code stacks line-first.
    const lineCalcs = body.lines.map(l => {
      const gross = round2(l.quantity * l.unitPrice)
      const discountAmount = l.discountType
        ? computeDiscountAmount(l.discountType, l.discountValue ?? 0, gross)
        : 0
      return { ...l, gross, discountAmount, net: round2(gross - discountAmount) }
    })
    const subtotal = round2(lineCalcs.reduce((acc, l) => acc + l.net, 0))
    // S506: auto-tax basis decided up front; the actual tax is computed
    // inside the txn against the POST-discount subtotal (S513). Rate comes
    // from businesses.default_tax_rate; 0 → no tax even if not exempt.
    // Owner can always force a value via body.taxAmount.
    let rate = 0
    if (body.taxAmount === undefined && !c.tax_exempt) {
      const biz = await queryOne<{ default_tax_rate: string }>(
        `SELECT default_tax_rate FROM businesses WHERE id = $1`, [businessId])
      rate = Number(biz?.default_tax_rate ?? 0)
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // S513: apply a discount code (pre-tax) inside the txn — consumes a
      // redemption under a row lock. Discount reduces the taxable base.
      let discountAmount = 0
      let discountCodeId: string | null = null
      if (body.discountCode) {
        const applied = await applyDiscount(client, businessId, body.discountCode, subtotal)
        discountCodeId = applied.discountCodeId
        discountAmount = applied.discountAmount
      }
      const discountedSubtotal = round2(subtotal - discountAmount)
      const tax = body.taxAmount !== undefined
        ? body.taxAmount
        : round2(discountedSubtotal * rate)
      const total = round2(discountedSubtotal + tax)

      // S511: deposit must fit inside the (now-known) total.
      const depositAmount = round2(body.depositAmount ?? 0)
      if (depositAmount > total + 0.005) {
        await client.query('ROLLBACK')
        throw new AppError(400, 'Deposit cannot exceed the invoice total')
      }
      const depositType = depositAmount > 0 ? (body.depositType ?? null) : null

      // Reserve next invoice number for this business. INSERT...ON
      // CONFLICT lets us seed the sequence row on first use.
      const { rows: [seq] } = await client.query<{ next_number: number }>(
        `INSERT INTO business_invoice_sequences (business_id, next_number)
         VALUES ($1, 2)
         ON CONFLICT (business_id) DO UPDATE
           SET next_number = business_invoice_sequences.next_number + 1,
               updated_at  = NOW()
         RETURNING next_number`,
        [businessId])
      // After the UPSERT, next_number is what the NEXT invoice will
      // use; the one we're inserting takes (next_number - 1).
      const thisNumber = seq.next_number - 1
      const invoiceNumber = `INV-${String(thisNumber).padStart(4, '0')}`

      const { rows: [inv] } = await client.query<{ id: string }>(
        `INSERT INTO business_invoices
           (business_id, customer_id, invoice_number,
            status, issue_date, due_date,
            subtotal, tax_amount, total_amount,
            discount_code_id, discount_amount,
            deposit_amount, deposit_type,
            notes, internal_notes)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [businessId, body.customerId, invoiceNumber,
         body.issueDate, body.dueDate,
         subtotal, tax, total,
         discountCodeId, discountAmount,
         depositAmount, depositType,
         body.notes ?? null, body.internalNotes ?? null])

      // Insert lines in order.
      for (let i = 0; i < lineCalcs.length; i++) {
        const l = lineCalcs[i]
        await client.query(
          `INSERT INTO business_invoice_lines
             (invoice_id, sort_order, description,
              quantity, unit_price, line_total, service_key,
              discount_type, discount_value, discount_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [inv.id, i, l.description, l.quantity, l.unitPrice, l.net, l.serviceKey ?? null,
           l.discountType ?? null, l.discountValue ?? 0, l.discountAmount])
      }

      await client.query('COMMIT')

      const full = await queryOne<any>(
        `SELECT * FROM business_invoices WHERE id = $1`, [inv.id])
      const lines = await query<any>(
        `SELECT * FROM business_invoice_lines WHERE invoice_id = $1 ORDER BY sort_order ASC`,
        [inv.id])
      res.status(201).json({ success: true, data: { ...full, lines } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET / — list with filters
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  status:     z.enum(['draft', 'sent', 'paid', 'void']).optional(),
  customerId: z.string().uuid().optional(),
  limit:      z.coerce.number().int().positive().max(500).optional(),
})

businessInvoicesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const q = listSchema.parse(req.query)

    const params: any[] = [businessId]
    let whereSql = 'WHERE i.business_id = $1'
    if (q.status)     { params.push(q.status);     whereSql += ` AND i.status = $${params.length}` }
    if (q.customerId) { params.push(q.customerId); whereSql += ` AND i.customer_id = $${params.length}` }
    params.push(q.limit ?? 100)

    const rows = await query<any>(
      `SELECT i.id, i.invoice_number, i.status,
              i.issue_date, i.due_date,
              i.subtotal, i.tax_amount, i.total_amount, i.amount_paid,
              i.sent_at, i.paid_at, i.voided_at,
              i.created_at,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name
         FROM business_invoices i
         JOIN business_customers c ON c.id = i.customer_id
         ${whereSql}
        ORDER BY i.created_at DESC
        LIMIT $${params.length}`,
      params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id — full detail with lines
// ═══════════════════════════════════════════════════════════════

businessInvoicesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const inv = await queryOne<any>(
      `SELECT i.*,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name,
              c.email      AS customer_email
         FROM business_invoices i
         JOIN business_customers c ON c.id = i.customer_id
        WHERE i.id = $1 AND i.business_id = $2`,
      [req.params.id, businessId])
    // i.* already pulls stripe_checkout_session_id + hosted_pay_url.
    if (!inv) throw new AppError(404, 'Invoice not found')
    const lines = await query<any>(
      `SELECT * FROM business_invoice_lines WHERE invoice_id = $1 ORDER BY sort_order ASC`,
      [inv.id])
    res.json({ success: true, data: { ...inv, lines } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id/pdf — printable PDF (S504)
// ═══════════════════════════════════════════════════════════════

businessInvoicesRouter.get('/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const inv = await queryOne<any>(
      `SELECT i.*,
              b.name      AS biz_name,
              b.email     AS biz_email, b.phone AS biz_phone,
              b.street1   AS biz_street1, b.street2 AS biz_street2,
              b.city      AS biz_city, b.state AS biz_state, b.zip AS biz_zip,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name,
              c.email AS customer_email, c.phone AS customer_phone,
              c.street1 AS customer_street1, c.city AS customer_city,
              c.state AS customer_state, c.zip AS customer_zip
         FROM business_invoices i
         JOIN business_customers c ON c.id = i.customer_id
         JOIN businesses b ON b.id = i.business_id
        WHERE i.id = $1 AND i.business_id = $2`,
      [req.params.id, businessId])
    if (!inv) throw new AppError(404, 'Invoice not found')
    const lines = await query<any>(
      `SELECT description, quantity, unit_price, line_total, discount_amount
         FROM business_invoice_lines WHERE invoice_id = $1 ORDER BY sort_order ASC`,
      [inv.id])

    const { renderInvoicePdf } = await import('../services/businessPdf')
    const buffer = await renderInvoicePdf({
      business: {
        name: inv.biz_name, email: inv.biz_email, phone: inv.biz_phone,
        street1: inv.biz_street1, street2: inv.biz_street2,
        city: inv.biz_city, state: inv.biz_state, zip: inv.biz_zip,
      },
      customer: {
        firstName: inv.customer_first_name, lastName: inv.customer_last_name,
        companyName: inv.customer_company_name,
        email: inv.customer_email, phone: inv.customer_phone,
        street1: inv.customer_street1, city: inv.customer_city,
        state: inv.customer_state, zip: inv.customer_zip,
      },
      invoiceNumber: inv.invoice_number,
      status: inv.status,
      issueDate: inv.issue_date,
      dueDate:   inv.due_date,
      lines: lines.map(l => ({
        description: l.description,
        quantity:    Number(l.quantity),
        unitPrice:   Number(l.unit_price),
        lineTotal:   Number(l.line_total),
        discountAmount: Number(l.discount_amount),
      })),
      subtotal:       Number(inv.subtotal),
      discountAmount: Number(inv.discount_amount),
      taxAmount:      Number(inv.tax_amount),
      totalAmount:    Number(inv.total_amount),
      amountPaid:     Number(inv.amount_paid),
      notes:        inv.notes,
      hostedPayUrl: inv.hosted_pay_url,
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition',
      `inline; filename="${inv.invoice_number}.pdf"`)
    res.send(buffer)
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/send — flip draft → sent
// ═══════════════════════════════════════════════════════════════

businessInvoicesRouter.post('/:id/send', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)

    // Pull the invoice + the business's Connect status so we know
    // whether to create a Checkout Session.
    const inv = await queryOne<{
      id: string; status: string; total_amount: string;
      invoice_number: string;
      customer_id: string;
      due_date: string;
      deposit_amount: string;
    }>(
      `SELECT id, status, total_amount, invoice_number, customer_id, due_date, deposit_amount
         FROM business_invoices
        WHERE id = $1 AND business_id = $2 AND status = 'draft'`,
      [req.params.id, businessId])
    if (!inv) throw new AppError(404, 'Invoice not found or not in draft')

    // S511: the first pay link covers the amount due now — the deposit when
    // one is set (balance link is minted later by the portal), else the total.
    const due = computeInvoiceDue({
      totalAmount:   Number(inv.total_amount),
      amountPaid:    0,
      depositAmount: Number(inv.deposit_amount),
    })

    const biz = await queryOne<{
      name: string;
      stripe_connect_account_id: string | null;
      connect_payouts_enabled: boolean;
    }>(
      `SELECT name, stripe_connect_account_id, connect_payouts_enabled
         FROM businesses WHERE id = $1`,
      [businessId])

    const customer = await queryOne<{ email: string | null }>(
      `SELECT email FROM business_customers WHERE id = $1`,
      [inv.customer_id])

    // S494: create Checkout Session when the business has a Connect
    // account configured and payouts are enabled (KYC done). Otherwise
    // the send still succeeds — owner records cash/check via mark-paid
    // later. The UI shows the hosted URL when present.
    let sessionId: string | null = null
    let hostedUrl: string | null = null
    if (biz?.stripe_connect_account_id && biz.connect_payouts_enabled) {
      try {
        const { createInvoiceCheckoutSession } = await import('../services/stripeConnect')
        const appBase = process.env.MARKETING_URL || 'http://localhost:3004'
        const session = await createInvoiceCheckoutSession({
          amountCents:              Math.round(due.amountDueNow * 100),
          businessConnectAccountId: biz.stripe_connect_account_id,
          invoiceNumber:            inv.invoice_number,
          customerEmail:            customer?.email ?? null,
          successUrl:               `${appBase}/invoice-paid?invoice=${inv.invoice_number}`,
          cancelUrl:                `${appBase}/invoice-cancelled?invoice=${inv.invoice_number}`,
          metadata: {
            business_invoice_id: inv.id,
            business_id:         businessId,
            payment_kind:        due.nextPaymentKind, // 'deposit' | 'balance'
          },
        })
        sessionId = session.sessionId
        hostedUrl = session.hostedUrl
      } catch (e) {
        // Don't break send if checkout creation fails — owner can
        // mark-paid manually. Logged at the service level.
      }
    }

    const r = await query<{ id: string; status: string; sent_at: string }>(
      `UPDATE business_invoices
          SET status                       = 'sent',
              sent_at                      = NOW(),
              stripe_checkout_session_id   = COALESCE($1, stripe_checkout_session_id),
              hosted_pay_url               = COALESCE($2, hosted_pay_url)
        WHERE id = $3 AND business_id = $4 AND status = 'draft'
        RETURNING id, status, sent_at`,
      [sessionId, hostedUrl, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Invoice not found or not in draft')

    // S500: best-effort email to the customer with the hosted pay link.
    // Skipped silently if customer has no email; never throws — email
    // failures shouldn't block the send transition.
    if (customer?.email && biz?.name) {
      try {
        const { emailBusinessInvoiceSent } = await import('../services/email')
        // pg returns DATE columns as Date objects by default; coerce
        // to YYYY-MM-DD either way.
        const due: any = inv.due_date
        const dueIso = (due instanceof Date ? due.toISOString() : String(due)).slice(0, 10)
        await emailBusinessInvoiceSent({
          to:            customer.email,
          businessName:  biz.name,
          invoiceNumber: inv.invoice_number,
          totalAmount:   Number(inv.total_amount),
          dueDate:       dueIso,
          payUrl:        hostedUrl,
          ctx: { businessId, invoiceId: inv.id },
        })
      } catch {/* logged at email-service layer */}
    }

    res.json({
      success: true,
      data: { ...r[0], hosted_pay_url: hostedUrl },
    })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/mark-paid — manual payment record (cash / check / etc.)
//  Stripe-initiated payments land via webhook + a separate endpoint.
// ═══════════════════════════════════════════════════════════════

const markPaidSchema = z.object({
  paymentMethod: z.enum(['cash', 'check', 'ach', 'card', 'other']),
  amount:        z.number().positive().optional(),  // omit = full total
})

businessInvoicesRouter.post('/:id/mark-paid', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)
    const body = markPaidSchema.parse(req.body)

    // Pull the invoice to default amount = total_amount.
    const inv = await queryOne<{ id: string; total_amount: string; status: string }>(
      `SELECT id, total_amount, status
         FROM business_invoices
        WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!inv) throw new AppError(404, 'Invoice not found')
    if (inv.status !== 'sent' && inv.status !== 'draft') {
      throw new AppError(409, `Cannot mark a ${inv.status} invoice as paid`)
    }
    const amount = body.amount ?? Number(inv.total_amount)

    const r = await query<{ id: string; status: string; paid_at: string }>(
      `UPDATE business_invoices
          SET status         = 'paid',
              paid_at        = NOW(),
              sent_at        = COALESCE(sent_at, NOW()),
              amount_paid    = $1,
              payment_method = $2
        WHERE id = $3 AND business_id = $4
          AND status IN ('draft', 'sent')
        RETURNING id, status, paid_at`,
      [amount, body.paymentMethod, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Invoice not found or already finalized')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/void — cancel any non-paid invoice
// ═══════════════════════════════════════════════════════════════

const voidSchema = z.object({
  reason: z.string().min(1).max(500),
})

businessInvoicesRouter.post('/:id/void', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)
    const body = voidSchema.parse(req.body)
    const r = await query<{ id: string; status: string; voided_at: string }>(
      `UPDATE business_invoices
          SET status      = 'void',
              voided_at   = NOW(),
              void_reason = $1
        WHERE id = $2 AND business_id = $3
          AND status IN ('draft', 'sent')
        RETURNING id, status, voided_at`,
      [body.reason, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Invoice not found or already paid/voided')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  S519 / S502 — POST /:id/refund : refund a paid invoice
// ═══════════════════════════════════════════════════════════════
//
// When the invoice was paid through Stripe (stripe_payment_intent_id
// present), this fires the REAL Stripe refund — a reverse_transfer refund
// on the Connect destination charge, so the money comes back out of the
// business's Connect balance (GAM keeps its platform fee, per S502). When
// there's no payment_intent (manual / terminal / cash), it stays
// bookkeeping-only — the operator runs the money refund themselves.
//
// Full or partial; the invoice flips to 'partially_refunded' until the whole
// paid amount is returned, then 'refunded'. The Stripe refund fires BEFORE
// the bookkeeping write — if Stripe rejects it, nothing is recorded.

const refundInvoiceSchema = z.object({
  reason: z.string().min(1).max(500),
  amount: z.number().positive().optional(),  // omit = refund the full remaining
})

businessInvoicesRouter.post('/:id/refund', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)
    const body = refundInvoiceSchema.parse(req.body)

    const inv = await queryOne<{
      id: string; status: string; amount_paid: string; refunded_amount: string;
      stripe_payment_intent_id: string | null;
    }>(
      `SELECT id, status, amount_paid, refunded_amount, stripe_payment_intent_id
         FROM business_invoices
        WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!inv) throw new AppError(404, 'Invoice not found')
    if (inv.status !== 'paid' && inv.status !== 'partially_refunded') {
      throw new AppError(409, `Only a paid invoice can be refunded (this one is ${inv.status})`)
    }

    const round2 = (n: number) => Math.round(n * 100) / 100
    const paid = Number(inv.amount_paid)
    const alreadyRefunded = Number(inv.refunded_amount)
    const refundable = round2(paid - alreadyRefunded)
    if (refundable <= 0) throw new AppError(409, 'This invoice is already fully refunded')

    const amount = body.amount ?? refundable
    if (amount > refundable + 0.005) {
      throw new AppError(400, `Refund $${amount.toFixed(2)} exceeds the refundable $${refundable.toFixed(2)}`)
    }

    const newRefunded = round2(alreadyRefunded + amount)
    const newStatus = newRefunded >= paid - 0.005 ? 'refunded' : 'partially_refunded'
    const isFullRemaining = round2(amount) >= refundable - 0.005

    // Stripe-paid → fire the real refund first. The idempotency key is keyed
    // on the cumulative refunded total, so a retry of THIS refund is a no-op
    // while a later partial refund (different cumulative) is allowed through.
    let stripeRefundId: string | null = null
    if (inv.stripe_payment_intent_id) {
      try {
        const refund = await refundBusinessInvoicePayment({
          paymentIntentId: inv.stripe_payment_intent_id,
          // Full remaining → omit amount so Stripe refunds the exact remainder
          // (avoids cent drift); otherwise refund this partial amount.
          amountCents: isFullRemaining ? undefined : Math.round(amount * 100),
          reason: body.reason.trim(),
          idempotencyKey: `biz-inv-refund:${inv.id}:${newRefunded.toFixed(2)}`,
          metadata: { business_invoice_id: inv.id, business_id: businessId },
        })
        stripeRefundId = refund.refundId
      } catch (e: any) {
        logger.error({ err: e, invoiceId: inv.id }, '[business-invoice] Stripe refund failed')
        throw new AppError(502, `Stripe could not process the refund: ${e?.message ?? 'unknown error'}. Nothing was changed.`)
      }
    }

    const r = await query<any>(
      `UPDATE business_invoices
          SET status          = $1,
              refunded_amount = $2,
              refunded_at     = COALESCE(refunded_at, NOW()),
              refund_reason   = $3,
              stripe_refund_id = COALESCE($4, stripe_refund_id)
        WHERE id = $5 AND business_id = $6
          AND status IN ('paid', 'partially_refunded')
        RETURNING id, status, refunded_amount, refunded_at, stripe_refund_id`,
      [newStatus, newRefunded, body.reason.trim(), stripeRefundId, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Invoice not found or not refundable')
    res.json({ success: true, data: { ...r[0], stripeRefunded: stripeRefundId != null } })
  } catch (e) { next(e) }
})
