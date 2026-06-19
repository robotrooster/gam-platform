/**
 * S502 — customer self-service portal (NO AUTH, token-protected).
 *
 *   GET  /api/public/customer/:token                      — account: invoice history + balance
 *   POST /api/public/customer/:token/invoices/:id/pay     — get/create the hosted pay link
 *
 * The token (business_customer_portal_tokens) scopes everything to ONE
 * customer of ONE business — the customer can only ever see and pay their own
 * invoices. Mounted under the CORS-permissive public router so the marketing
 * site can call it. Privacy: only this customer's data is exposed; draft and
 * void invoices are never shown.
 */

import { Router } from 'express'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { resolveCustomerPortalToken } from '../services/customerPortalTokens'

export const publicCustomerPortalRouter = Router()

const round2 = (n: number) => Math.round(n * 100) / 100

interface InvoiceRow {
  id: string
  invoice_number: string
  status: string
  due_date: string
  total_amount: string
  amount_paid: string
  refunded_amount: string | null
  created_at: string
  hosted_pay_url: string | null
}

// GET /api/public/customer/:token — the customer's account view.
publicCustomerPortalRouter.get('/customer/:token', async (req, res, next) => {
  try {
    const resolved = await resolveCustomerPortalToken(req.params.token)
    if (!resolved) throw new AppError(404, 'This account link is invalid or has expired. Ask the business for a new one.')

    const biz = await queryOne<{ name: string }>(
      `SELECT name FROM businesses WHERE id = $1`, [resolved.businessId])
    const cust = await queryOne<{ first_name: string | null; last_name: string | null; company_name: string | null }>(
      `SELECT first_name, last_name, company_name FROM business_customers WHERE id = $1`, [resolved.customerId])
    if (!biz || !cust) throw new AppError(404, 'Account not found.')

    const rows = await query<InvoiceRow>(
      `SELECT id, invoice_number, status, due_date, total_amount, amount_paid,
              refunded_amount, created_at, hosted_pay_url
         FROM business_invoices
        WHERE customer_id = $1 AND business_id = $2
          AND status NOT IN ('draft', 'void')
        ORDER BY created_at DESC`,
      [resolved.customerId, resolved.businessId])

    let outstanding = 0
    const invoices = rows.map((r) => {
      const amountDue = round2(Number(r.total_amount) - Number(r.amount_paid))
      const payable = r.status === 'sent' && amountDue > 0.005
      if (payable) outstanding = round2(outstanding + amountDue)
      return {
        id: r.id,
        number: r.invoice_number,
        status: r.status,
        dueDate: r.due_date,
        total: Number(r.total_amount),
        amountPaid: Number(r.amount_paid),
        amountDue,
        refunded: r.refunded_amount != null ? Number(r.refunded_amount) : 0,
        payable,
      }
    })

    const customerName = cust.company_name
      || `${cust.first_name ?? ''} ${cust.last_name ?? ''}`.trim()
      || 'there'

    res.json({
      success: true,
      data: { business: { name: biz.name }, customer: { name: customerName }, outstanding, invoices },
    })
  } catch (e) { next(e) }
})

// POST /api/public/customer/:token/invoices/:invoiceId/pay — hosted pay link.
publicCustomerPortalRouter.post('/customer/:token/invoices/:invoiceId/pay', async (req, res, next) => {
  try {
    const resolved = await resolveCustomerPortalToken(req.params.token)
    if (!resolved) throw new AppError(404, 'This account link is invalid or has expired.')

    const inv = await queryOne<{
      id: string; invoice_number: string; status: string; total_amount: string;
      amount_paid: string; hosted_pay_url: string | null;
    }>(
      `SELECT id, invoice_number, status, total_amount, amount_paid, hosted_pay_url
         FROM business_invoices
        WHERE id = $1 AND customer_id = $2 AND business_id = $3`,
      [req.params.invoiceId, resolved.customerId, resolved.businessId])
    if (!inv) throw new AppError(404, 'Invoice not found.')
    if (inv.status !== 'sent' || round2(Number(inv.total_amount) - Number(inv.amount_paid)) <= 0.005) {
      throw new AppError(409, 'This invoice is not open for payment.')
    }

    // Reuse the link created at send time when present; otherwise mint one now.
    if (inv.hosted_pay_url) {
      res.json({ success: true, data: { hostedUrl: inv.hosted_pay_url } })
      return
    }

    const biz = await queryOne<{ stripe_connect_account_id: string | null; connect_payouts_enabled: boolean }>(
      `SELECT stripe_connect_account_id, connect_payouts_enabled FROM businesses WHERE id = $1`,
      [resolved.businessId])
    if (!biz?.stripe_connect_account_id || !biz.connect_payouts_enabled) {
      throw new AppError(409, 'Online payment isn’t set up for this business yet. Please contact them to pay.')
    }
    const cust = await queryOne<{ email: string | null }>(
      `SELECT email FROM business_customers WHERE id = $1`, [resolved.customerId])

    const { createInvoiceCheckoutSession } = await import('../services/stripeConnect')
    const appBase = process.env.MARKETING_URL || 'http://localhost:3004'
    const session = await createInvoiceCheckoutSession({
      amountCents:              Math.round(Number(inv.total_amount) * 100),
      businessConnectAccountId: biz.stripe_connect_account_id,
      invoiceNumber:            inv.invoice_number,
      customerEmail:            cust?.email ?? null,
      successUrl:               `${appBase}/invoice-paid?invoice=${inv.invoice_number}`,
      cancelUrl:                `${appBase}/account/${req.params.token}`,
      metadata: { business_invoice_id: inv.id, business_id: resolved.businessId },
    })
    await query(
      `UPDATE business_invoices
          SET stripe_checkout_session_id = COALESCE($1, stripe_checkout_session_id),
              hosted_pay_url             = COALESCE($2, hosted_pay_url)
        WHERE id = $3`,
      [session.sessionId, session.hostedUrl, inv.id])
    res.json({ success: true, data: { hostedUrl: session.hostedUrl } })
  } catch (e) { next(e) }
})
