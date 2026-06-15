/**
 * S505 — auto-send a generated invoice (mirror of POST /:id/send in
 * routes/businessInvoices.ts but callable from the cron / generation
 * path without an Express request).
 *
 * S508 update: when the customer has a saved Stripe Customer + default
 * payment method, attempt an off-session PaymentIntent first. On
 * success the invoice goes straight to 'paid'; on failure we log the
 * decline reason and fall through to the email Checkout path so the
 * customer can confirm/update their card.
 *
 * When falling through to the Checkout path (or for first-cycle
 * customers with no saved card yet), the Checkout Session is created
 * with `saveForFutureUse: true` so the resulting card lands on
 * business_customers via the webhook and next month's cycle goes
 * straight to auto-charge.
 *
 * Returns 'auto_paid' | 'email_sent' | 'no_email' so the caller knows
 * which path fired.
 */

import Stripe from 'stripe'
import { db, queryOne } from '../db'
import { logger } from '../lib/logger'

export type RecurringSendResult = 'auto_paid' | 'email_sent' | 'no_email'

export async function sendGeneratedInvoice(
  invoiceId: string,
  businessId: string,
  actorUserId: string | null
): Promise<RecurringSendResult> {
  void actorUserId  // reserved
  const inv = await queryOne<{
    id: string; invoice_number: string;
    total_amount: string; customer_id: string;
    due_date: string;
  }>(
    `SELECT id, invoice_number, total_amount, customer_id, due_date
       FROM business_invoices
      WHERE id = $1 AND business_id = $2 AND status = 'draft'`,
    [invoiceId, businessId])
  if (!inv) return 'no_email'

  const biz = await queryOne<{
    name: string;
    stripe_connect_account_id: string | null;
    connect_payouts_enabled: boolean;
  }>(
    `SELECT name, stripe_connect_account_id, connect_payouts_enabled
       FROM businesses WHERE id = $1`, [businessId])

  const customer = await queryOne<{
    email: string | null;
    stripe_customer_id: string | null;
    default_payment_method_id: string | null;
  }>(
    `SELECT email, stripe_customer_id, default_payment_method_id
       FROM business_customers WHERE id = $1`, [inv.customer_id])

  // S508: off-session auto-charge path.
  if (customer?.stripe_customer_id && customer.default_payment_method_id
      && biz?.stripe_connect_account_id && biz.connect_payouts_enabled) {
    const charged = await tryOffSessionCharge({
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      amountCents: Math.round(Number(inv.total_amount) * 100),
      stripeCustomerId: customer.stripe_customer_id,
      paymentMethodId: customer.default_payment_method_id,
      businessConnectAccountId: biz.stripe_connect_account_id,
      businessId,
    })
    if (charged) return 'auto_paid'
    // S510: auto-charge failed → send the card-update link instead of
    // a fresh Checkout link. Checkout would create a brand new PM
    // each time; the update flow replaces the existing one cleanly.
    try {
      const { sendCardUpdateEmail } = await import('./cardUpdateTokens')
      await sendCardUpdateEmail({
        businessId,
        customerId: inv.customer_id,
        triggeredByInvoiceId: inv.id,
        reasonHint: 'auto_charge_failed',
      })
      // Still flip the invoice to 'sent' so the operator sees it
      // surface in the AR aging report.
      await db.query(
        `UPDATE business_invoices
            SET status = 'sent', sent_at = NOW()
          WHERE id = $1 AND status = 'draft'`, [inv.id])
      return 'email_sent'
    } catch (e) {
      logger.error({ err: e, invoiceId: inv.id },
        '[recurring-send] card-update email failed; falling through to Checkout link')
      // Fall through to the Checkout-link path below.
    }
  }

  let sessionId: string | null = null
  let hostedUrl: string | null = null
  if (biz?.stripe_connect_account_id && biz.connect_payouts_enabled) {
    try {
      const { createInvoiceCheckoutSession } = await import('./stripeConnect')
      const appBase = process.env.MARKETING_URL || 'http://localhost:3004'
      const session = await createInvoiceCheckoutSession({
        amountCents:              Math.round(Number(inv.total_amount) * 100),
        businessConnectAccountId: biz.stripe_connect_account_id,
        invoiceNumber:            inv.invoice_number,
        customerEmail:            customer?.email ?? null,
        successUrl:               `${appBase}/invoice-paid?invoice=${inv.invoice_number}`,
        cancelUrl:                `${appBase}/invoice-cancelled?invoice=${inv.invoice_number}`,
        // S508: save card for future cycles. Reuse existing platform
        // Customer if we have one (the same person paying across many
        // GAM businesses lands on one Customer).
        saveForFutureUse:         true,
        existingStripeCustomerId: customer?.stripe_customer_id ?? null,
        metadata: {
          business_invoice_id: inv.id,
          business_id:         businessId,
        },
      })
      sessionId = session.sessionId
      hostedUrl = session.hostedUrl
    } catch (e) {
      logger.error({ err: e, invoiceId: inv.id }, '[recurring-send] Checkout Session create failed')
    }
  }

  // Flip status → sent + stamp pay URL.
  await db.query(
    `UPDATE business_invoices
        SET status = 'sent',
            sent_at = NOW(),
            stripe_checkout_session_id = COALESCE($1, stripe_checkout_session_id),
            hosted_pay_url             = COALESCE($2, hosted_pay_url)
      WHERE id = $3`,
    [sessionId, hostedUrl, inv.id])

  if (customer?.email && biz?.name) {
    try {
      const { emailBusinessInvoiceSent } = await import('./email')
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
      return 'email_sent'
    } catch (e) {
      logger.error({ err: e, invoiceId: inv.id }, '[recurring-send] email failed')
      return 'no_email'
    }
  }
  return 'no_email'
}

// ── S508: off-session auto-charge ──────────────────────────────

interface OffSessionArgs {
  invoiceId: string
  invoiceNumber: string
  amountCents: number
  stripeCustomerId: string
  paymentMethodId: string
  businessConnectAccountId: string
  businessId: string
}

async function tryOffSessionCharge(args: OffSessionArgs): Promise<boolean> {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' })
  try {
    const pi = await stripe.paymentIntents.create({
      amount:         args.amountCents,
      currency:       'usd',
      customer:       args.stripeCustomerId,
      payment_method: args.paymentMethodId,
      off_session:    true,
      confirm:        true,
      transfer_data: {
        destination: args.businessConnectAccountId,
      },
      metadata: {
        gam_purpose:         'business_invoice',
        business_invoice_id: args.invoiceId,
        business_id:         args.businessId,
        source:              'recurring_auto_charge',
      },
    })

    // Stripe returns 'succeeded' synchronously for off-session card charges
    // that don't need 3DS. If it returns 'requires_action' the card needs
    // customer confirmation — treat as failure and fall back to email.
    if (pi.status === 'succeeded') {
      await db.query(
        `UPDATE business_invoices
            SET status                   = 'paid',
                paid_at                  = NOW(),
                sent_at                  = COALESCE(sent_at, NOW()),
                amount_paid              = $1,
                payment_method           = 'card',
                stripe_payment_intent_id = $2,
                auto_charge_attempted_at = NOW(),
                auto_charge_last_error   = NULL
          WHERE id = $3`,
        [args.amountCents / 100, pi.id, args.invoiceId])
      logger.info({ invoiceId: args.invoiceId, pi: pi.id },
        '[S508] off-session auto-charge succeeded')
      return true
    }

    await db.query(
      `UPDATE business_invoices
          SET auto_charge_attempted_at = NOW(),
              auto_charge_last_error   = $1
        WHERE id = $2`,
      [`PaymentIntent status: ${pi.status}`, args.invoiceId])
    logger.warn({ invoiceId: args.invoiceId, status: pi.status },
      '[S508] off-session auto-charge non-succeeded status')
    return false
  } catch (e: any) {
    const code = e?.code || e?.type || 'unknown'
    const msg = e?.message || String(e)
    await db.query(
      `UPDATE business_invoices
          SET auto_charge_attempted_at = NOW(),
              auto_charge_last_error   = $1
        WHERE id = $2`,
      [`${code}: ${msg}`.slice(0, 500), args.invoiceId])
    logger.error({ err: e, invoiceId: args.invoiceId },
      '[S508] off-session auto-charge threw')
    return false
  }
}
