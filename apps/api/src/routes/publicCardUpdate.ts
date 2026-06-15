/**
 * S510 — public card-update flow (NO AUTH, token-protected).
 *
 *   GET  /api/public/update-payment/:token       — load customer + create SetupIntent
 *   POST /api/public/update-payment/:token/confirm — set new PM as default, retire old
 *
 * Token must be unused + not expired. On GET we create (or reuse) a
 * Stripe SetupIntent attached to the customer's existing Stripe
 * Customer (creating one if needed). Returns the client_secret for
 * the marketing-site Elements to confirm.
 *
 * On POST /confirm: verify the SetupIntent succeeded, persist the new
 * default payment method to business_customers, detach the previous
 * default (best-effort — Stripe's idempotent), and mark the token
 * used.
 */

import { Router } from 'express'
import Stripe from 'stripe'
import { z } from 'zod'
import { db, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

export const publicCardUpdateRouter = Router()

function stripe(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' })
}

interface TokenRow {
  id: string
  business_id: string
  customer_id: string
  triggered_by_invoice_id: string | null
  expires_at: string
  used_at: string | null
}

async function resolveToken(token: string): Promise<TokenRow> {
  const row = await queryOne<TokenRow>(
    `SELECT id, business_id, customer_id, triggered_by_invoice_id,
            expires_at, used_at
       FROM business_customer_payment_update_tokens
      WHERE token = $1`, [token])
  if (!row) throw new AppError(404, 'This update link is invalid or has been removed.')
  if (row.used_at) throw new AppError(410, 'This link has already been used. Ask the business to send you a new one.')
  if (new Date(row.expires_at) < new Date()) {
    throw new AppError(410, 'This link has expired. Ask the business to send you a new one.')
  }
  return row
}

// ═══════════════════════════════════════════════════════════════
//  GET /update-payment/:token — load + SetupIntent
// ═══════════════════════════════════════════════════════════════

publicCardUpdateRouter.get('/update-payment/:token', async (req, res, next) => {
  try {
    const tok = await resolveToken(req.params.token)

    const biz = await queryOne<{ name: string; email: string | null }>(
      `SELECT name, email FROM businesses WHERE id = $1`, [tok.business_id])

    const customer = await queryOne<{
      first_name: string | null; last_name: string | null;
      company_name: string | null;
      email: string | null;
      stripe_customer_id: string | null;
      payment_method_brand: string | null;
      payment_method_last4:  string | null;
    }>(
      `SELECT first_name, last_name, company_name, email,
              stripe_customer_id,
              payment_method_brand, payment_method_last4
         FROM business_customers WHERE id = $1`, [tok.customer_id])

    if (!biz || !customer) throw new AppError(404, 'Not found')

    let invoice: { invoice_number: string; total_amount: string } | null = null
    if (tok.triggered_by_invoice_id) {
      invoice = await queryOne<{ invoice_number: string; total_amount: string }>(
        `SELECT invoice_number, total_amount
           FROM business_invoices WHERE id = $1`, [tok.triggered_by_invoice_id])
    }

    // Create (or reuse) a Stripe Customer + SetupIntent. SetupIntent
    // returns a client_secret the browser uses with Elements to
    // collect + confirm the new card without sending the raw card
    // through GAM.
    let stripeCustomerId = customer.stripe_customer_id
    if (!stripeCustomerId) {
      const created = await stripe().customers.create({
        email: customer.email ?? undefined,
        name: customer.company_name
              ?? `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim()
              ?? undefined,
        metadata: { gam_business_customer_id: tok.customer_id },
      })
      stripeCustomerId = created.id
      await db.query(
        `UPDATE business_customers SET stripe_customer_id = $1 WHERE id = $2`,
        [stripeCustomerId, tok.customer_id])
    }

    const setupIntent = await stripe().setupIntents.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: {
        gam_purpose: 'card_update',
        gam_business_customer_id: tok.customer_id,
        gam_business_id: tok.business_id,
      },
    })

    res.json({
      success: true,
      data: {
        business_name: biz.name,
        customer_name: customer.company_name
          ?? `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim()
          ?? null,
        existing_card: customer.payment_method_brand && customer.payment_method_last4
          ? {
              brand: customer.payment_method_brand,
              last4: customer.payment_method_last4,
            } : null,
        invoice: invoice
          ? { invoice_number: invoice.invoice_number, total_amount: invoice.total_amount }
          : null,
        client_secret: setupIntent.client_secret,
        // Publishable key the browser needs to load Stripe.js.
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
      },
    })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /update-payment/:token/confirm — finalize PM swap
// ═══════════════════════════════════════════════════════════════

const confirmSchema = z.object({
  setupIntentId: z.string().min(1),
})

publicCardUpdateRouter.post('/update-payment/:token/confirm', async (req, res, next) => {
  try {
    const tok = await resolveToken(req.params.token)
    const body = confirmSchema.parse(req.body)

    const si = await stripe().setupIntents.retrieve(body.setupIntentId)
    if (si.status !== 'succeeded') {
      throw new AppError(400, `SetupIntent status is ${si.status}; expected 'succeeded'`)
    }
    if (si.metadata?.gam_business_customer_id !== tok.customer_id) {
      throw new AppError(403, 'SetupIntent customer mismatch')
    }
    const newPmId = typeof si.payment_method === 'string'
      ? si.payment_method
      : si.payment_method?.id
    if (!newPmId) throw new AppError(400, 'SetupIntent has no payment method attached')

    // Pull the PM's card details for the UI indicator.
    const pm = await stripe().paymentMethods.retrieve(newPmId)
    const card = pm.card

    // Grab the previous default so we can detach it after the swap.
    const existing = await queryOne<{ default_payment_method_id: string | null }>(
      `SELECT default_payment_method_id FROM business_customers WHERE id = $1`,
      [tok.customer_id])
    const previousPmId = existing?.default_payment_method_id ?? null

    // Set as the customer's default PM in Stripe so future off-session
    // PaymentIntents pick it up.
    if (pm.customer) {
      const customerId = typeof pm.customer === 'string' ? pm.customer : pm.customer.id
      await stripe().customers.update(customerId, {
        invoice_settings: { default_payment_method: newPmId },
      })
    }

    // Persist on the business_customers row.
    await db.query(
      `UPDATE business_customers
          SET default_payment_method_id = $1,
              payment_method_brand      = $2,
              payment_method_last4      = $3,
              payment_method_exp_month  = $4,
              payment_method_exp_year   = $5
        WHERE id = $6`,
      [newPmId, card?.brand ?? null, card?.last4 ?? null,
       card?.exp_month ?? null, card?.exp_year ?? null,
       tok.customer_id])

    // Mark token used.
    await db.query(
      `UPDATE business_customer_payment_update_tokens
          SET used_at = NOW() WHERE id = $1`, [tok.id])

    // Best-effort: detach the old PM so it doesn't linger on the
    // Stripe Customer. Failure is silent — leaving the old PM
    // attached isn't dangerous (it's just not the default).
    if (previousPmId && previousPmId !== newPmId) {
      try {
        await stripe().paymentMethods.detach(previousPmId)
      } catch (e) {
        logger.warn({ err: e, previousPmId }, '[card-update] old PM detach failed')
      }
    }

    res.json({
      success: true,
      data: {
        confirmation: 'Your new card is saved. You\'re all set.',
        card_brand: card?.brand ?? null,
        card_last4: card?.last4 ?? null,
      },
    })
  } catch (e) { next(e) }
})
