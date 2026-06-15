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

export const businessInvoicesRouter = Router()

// ── helpers ────────────────────────────────────────────────────
// S502: thin wrappers around requireBusinessAccess so each endpoint
// declares the exact permission it needs while keeping call sites
// terse. Read endpoints take 'invoices.read'; write CRUD takes
// 'invoices.write'; send / mark-paid / void take 'invoices.send'.
import { requireBusinessAccess } from '../middleware/businessAccess'

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
})

const createSchema = z.object({
  customerId:    z.string().uuid(),
  issueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  taxAmount:     z.number().min(0).optional(),
  notes:         z.string().max(2000).nullable().optional(),
  internalNotes: z.string().max(2000).nullable().optional(),
  lines:         z.array(lineSchema).min(1).max(200),
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

    const subtotal = body.lines.reduce(
      (acc, l) => acc + (l.quantity * l.unitPrice), 0,
    )
    // S506: auto-tax if owner didn't override AND customer not exempt.
    // Rate comes from businesses.default_tax_rate; 0 → no tax even if
    // not exempt. Owner can always force a value via body.taxAmount.
    let tax: number
    if (body.taxAmount !== undefined) {
      tax = body.taxAmount
    } else if (c.tax_exempt) {
      tax = 0
    } else {
      const biz = await queryOne<{ default_tax_rate: string }>(
        `SELECT default_tax_rate FROM businesses WHERE id = $1`, [businessId])
      const rate = Number(biz?.default_tax_rate ?? 0)
      tax = Math.round(subtotal * rate * 100) / 100
    }
    const total = subtotal + tax

    const client = await db.connect()
    try {
      await client.query('BEGIN')

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
            notes, internal_notes)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [businessId, body.customerId, invoiceNumber,
         body.issueDate, body.dueDate,
         subtotal, tax, total,
         body.notes ?? null, body.internalNotes ?? null])

      // Insert lines in order.
      for (let i = 0; i < body.lines.length; i++) {
        const l = body.lines[i]
        const lineTotal = l.quantity * l.unitPrice
        await client.query(
          `INSERT INTO business_invoice_lines
             (invoice_id, sort_order, description,
              quantity, unit_price, line_total, service_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [inv.id, i, l.description, l.quantity, l.unitPrice, lineTotal, l.serviceKey ?? null])
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
      `SELECT description, quantity, unit_price, line_total
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
      })),
      subtotal:     Number(inv.subtotal),
      taxAmount:    Number(inv.tax_amount),
      totalAmount:  Number(inv.total_amount),
      amountPaid:   Number(inv.amount_paid),
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
    }>(
      `SELECT id, status, total_amount, invoice_number, customer_id, due_date
         FROM business_invoices
        WHERE id = $1 AND business_id = $2 AND status = 'draft'`,
      [req.params.id, businessId])
    if (!inv) throw new AppError(404, 'Invoice not found or not in draft')

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
          amountCents:              Math.round(Number(inv.total_amount) * 100),
          businessConnectAccountId: biz.stripe_connect_account_id,
          invoiceNumber:            inv.invoice_number,
          customerEmail:            customer?.email ?? null,
          successUrl:               `${appBase}/invoice-paid?invoice=${inv.invoice_number}`,
          cancelUrl:                `${appBase}/invoice-cancelled?invoice=${inv.invoice_number}`,
          metadata: {
            business_invoice_id: inv.id,
            business_id:         businessId,
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
