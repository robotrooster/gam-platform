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
import { z } from 'zod'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import {
  resolveCustomerPortalToken,
  getOrCreateCustomerPortalToken,
} from '../services/customerPortalTokens'
import { emailCustomerPortalLink } from '../services/email'
import { saveSubscription, VAPID_PUBLIC_KEY } from '../services/customerPush'
import { computeInvoiceDue } from '@gam/shared'

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
  deposit_amount: string
  deposit_type: string | null
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
              refunded_amount, created_at, hosted_pay_url,
              deposit_amount, deposit_type
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
      // S511: two-stage deposit math — what the customer pays next (deposit
      // first, then balance) and how much.
      const due = computeInvoiceDue({
        totalAmount:   Number(r.total_amount),
        amountPaid:    Number(r.amount_paid),
        depositAmount: Number(r.deposit_amount),
      })
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
        depositAmount: Number(r.deposit_amount),
        depositType: r.deposit_type as 'service' | 'materials' | null,
        depositPaid: due.depositPaid,
        amountDueNow: due.amountDueNow,
        nextPaymentKind: due.nextPaymentKind,
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

// GET /api/public/customer/:token/service — the customer's service /
// route status: each recent/upcoming appointment with its completion
// or skip timestamp. This is the customer-facing read of the driver
// timeline; the route auto-advance timer (jobs/routeAutoAdvance.ts)
// flips appointments to completed, and a driver skip flips to no_show.
publicCustomerPortalRouter.get('/customer/:token/service', async (req, res, next) => {
  try {
    const resolved = await resolveCustomerPortalToken(req.params.token)
    if (!resolved) throw new AppError(404, 'This account link is invalid or has expired. Ask the business for a new one.')

    const rows = await query<{
      id: string; service_type: string; scheduled_for: string;
      status: string; completed_at: string | null;
      stop_status: string | null; actual_arrival: string | null;
      actual_departure: string | null; skip_reason: string | null;
      projected_eta: string | null; en_route: boolean | null;
    }>(
      `SELECT a.id, a.service_type, a.scheduled_for, a.status, a.completed_at,
              rs.status AS stop_status, rs.actual_arrival, rs.actual_departure,
              rs.projected_eta,
              CASE WHEN rs.status = 'skipped' THEN rs.driver_notes END AS skip_reason,
              (rs.status = 'planned' AND r.status = 'in_progress'
                 AND rs.sequence_order = (
                   SELECT MIN(rs2.sequence_order) FROM route_stops rs2
                    WHERE rs2.route_id = rs.route_id AND rs2.status = 'planned'
                 )) AS en_route
         FROM appointments a
         LEFT JOIN route_stops rs     ON rs.appointment_id = a.id
         LEFT JOIN generated_routes r ON r.id = rs.route_id
        WHERE a.business_id = $1 AND a.customer_id = $2
          AND a.scheduled_for >= now() - interval '60 days'
        ORDER BY a.scheduled_for DESC
        LIMIT 100`,
      [resolved.businessId, resolved.customerId])

    const appointments = rows.map((r) => {
      const state =
        r.status === 'completed' ? 'completed'
        : (r.status === 'no_show' || r.stop_status === 'skipped') ? 'skipped'
        : r.status === 'cancelled' ? 'cancelled'
        : r.en_route ? 'en_route'
        : 'scheduled'
      return {
        id: r.id,
        serviceType: r.service_type,
        scheduledFor: r.scheduled_for,
        state,
        completedAt: (r.status === 'completed') ? (r.completed_at ?? r.actual_departure) : null,
        skippedAt: (state === 'skipped') ? r.actual_departure : null,
        skipReason: (state === 'skipped') ? r.skip_reason : null,
        arrivedAt: r.actual_arrival,
        etaAt: (state === 'en_route' || state === 'scheduled') ? r.projected_eta : null,
      }
    })
    res.json({ success: true, data: { appointments } })
  } catch (e) { next(e) }
})

// POST /api/public/portal-login/:slug — magic-link "login". The
// customer enters their email on a business's portal login page; if it
// matches an active customer of that business, we email them their
// portal link (the token in the URL is the bearer credential — no
// password). Always responds the same regardless of whether the email
// matched, so the endpoint can't be used to enumerate customers.
const loginSchema = z.object({ email: z.string().email() })

publicCustomerPortalRouter.post('/portal-login/:slug', async (req, res, next) => {
  try {
    const { email } = loginSchema.parse(req.body ?? {})
    const biz = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM businesses
        WHERE public_booking_slug = $1 AND status = 'active'`, [req.params.slug])
    if (biz) {
      const cust = await queryOne<{ id: string; email: string | null }>(
        `SELECT id, email FROM business_customers
          WHERE business_id = $1 AND LOWER(email) = LOWER($2) AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`, [biz.id, email])
      if (cust?.email) {
        const { url } = await getOrCreateCustomerPortalToken({ businessId: biz.id, customerId: cust.id })
        await emailCustomerPortalLink(cust.email, biz.name, url).catch(() => { /* logged in email.send */ })
      }
    }
    res.json({ success: true, data: { sent: true } })
  } catch (e) { next(e) }
})

// GET /api/public/push-key — VAPID public key so the portal can subscribe.
publicCustomerPortalRouter.get('/push-key', (_req, res) => {
  res.json({ success: true, data: { key: VAPID_PUBLIC_KEY } })
})

// POST /api/public/customer/:token/push-subscribe — store a device's Web
// Push subscription so stop events ("you're next" / completed / skipped)
// reach this customer even with the portal closed. Token-scoped.
const pushSubSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})
publicCustomerPortalRouter.post('/customer/:token/push-subscribe', async (req, res, next) => {
  try {
    const resolved = await resolveCustomerPortalToken(req.params.token)
    if (!resolved) throw new AppError(404, 'This account link is invalid or has expired.')
    const sub = pushSubSchema.parse(req.body ?? {})
    await saveSubscription({ businessId: resolved.businessId, customerId: resolved.customerId, subscription: sub })
    res.json({ success: true, data: { subscribed: true } })
  } catch (e) { next(e) }
})

// POST /api/public/customer/:token/invoices/:invoiceId/pay — hosted pay link.
publicCustomerPortalRouter.post('/customer/:token/invoices/:invoiceId/pay', async (req, res, next) => {
  try {
    const resolved = await resolveCustomerPortalToken(req.params.token)
    if (!resolved) throw new AppError(404, 'This account link is invalid or has expired.')

    const inv = await queryOne<{
      id: string; invoice_number: string; status: string; total_amount: string;
      amount_paid: string; deposit_amount: string; hosted_pay_url: string | null;
    }>(
      `SELECT id, invoice_number, status, total_amount, amount_paid, deposit_amount, hosted_pay_url
         FROM business_invoices
        WHERE id = $1 AND customer_id = $2 AND business_id = $3`,
      [req.params.invoiceId, resolved.customerId, resolved.businessId])
    if (!inv) throw new AppError(404, 'Invoice not found.')

    // S511: two-stage payment. The amount due now is the unpaid deposit
    // portion first, then the balance. Each stage is its own Checkout Session.
    const due = computeInvoiceDue({
      totalAmount:   Number(inv.total_amount),
      amountPaid:    Number(inv.amount_paid),
      depositAmount: Number(inv.deposit_amount),
    })
    if (inv.status !== 'sent' || due.amountDueNow <= 0.005) {
      throw new AppError(409, 'This invoice is not open for payment.')
    }

    // Reuse the send-time link ONLY before any payment (its fixed amount still
    // matches what's due). Once the deposit is paid, the balance is a different
    // amount, so we always mint a fresh session for it.
    if (inv.hosted_pay_url && Number(inv.amount_paid) <= 0.005) {
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
    const appBase = process.env.CUSTOMER_PORTAL_URL || 'http://localhost:3014'
    const session = await createInvoiceCheckoutSession({
      amountCents:              Math.round(due.amountDueNow * 100),
      businessConnectAccountId: biz.stripe_connect_account_id,
      invoiceNumber:            inv.invoice_number,
      customerEmail:            cust?.email ?? null,
      successUrl:               `${appBase}/invoice-paid?invoice=${inv.invoice_number}&token=${req.params.token}`,
      cancelUrl:                `${appBase}/account/${req.params.token}`,
      metadata: {
        business_invoice_id: inv.id,
        business_id:         resolved.businessId,
        payment_kind:        due.nextPaymentKind, // 'deposit' | 'balance'
      },
    })
    await query(
      `UPDATE business_invoices
          SET stripe_checkout_session_id = $1,
              hosted_pay_url             = $2
        WHERE id = $3`,
      [session.sessionId, session.hostedUrl, inv.id])
    res.json({ success: true, data: { hostedUrl: session.hostedUrl } })
  } catch (e) { next(e) }
})
