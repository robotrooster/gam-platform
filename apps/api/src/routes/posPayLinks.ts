/**
 * S648 (Nic) — register pay links: charges for people who are not on a lease.
 *
 *   "We need a way to generate an item, a charge and send it to a link so they
 *    can pay by email... people that stay by the night or by the week... we sell
 *    propane. A lot of people want to pay with card. People that want to use the
 *    dump station, having the QR code for the dump station so people can scan
 *    it, pay their bill."
 *
 * The desk rings up a cart as usual and, instead of taking money, sends it as a
 * link. The link opens Stripe's own card page — GAM hosts no public payment form.
 * The customer pays the usual card fee on top (as with rent). When Stripe says it
 * is paid, the sale is recorded exactly like a counter card sale
 * (services/posSale) and any stay attached to it is confirmed on the schedule.
 *
 * one_time — emailed to one person; closes when paid.
 * standing — one item for anyone, behind a printed QR code (the dump station).
 *            Stays open; every payment is its own sale.
 */
import { Router } from 'express'
import crypto from 'crypto'
import QRCode from 'qrcode'
import { z } from 'zod'
import { cardFeeSplit, type CardFeePayer } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm, assertPropertyInScope } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { computeCartTotals } from '../services/posTax'
import { insertPosSale } from '../services/posSale'
import { logger } from '../lib/logger'

export const posPayLinksRouter = Router()
posPayLinksRouter.use(requireAuth)

const apiBase = () => (process.env.API_PUBLIC_URL || 'http://localhost:4000').replace(/\/$/, '')
export const payLinkUrl = (token: string) => `${apiBase()}/api/public/pay/${token}`

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * What a link charges by card. GAM's fee is always taken; the property's
 * setting when the link was made decides whether it's added on top (S648).
 */
export function payLinkCharge(total: number, payer: CardFeePayer = 'customer'): { fee: number; charged: number; held: number; customerFee: number } {
  const split = cardFeeSplit(total, payer)
  return { ...split, customerFee: payer === 'customer' ? split.fee : 0 }
}

async function connectIdFor(landlordId: string): Promise<string | null> {
  // The payout account the landlord's share is sent to in the weekly batch
  // (S554: the entity's, else the founding owner's during the transition).
  // The charge itself is GAM's (S648) — no link goes out without somewhere
  // to pay the landlord.
  const row = await queryOne<{ id: string | null }>(
    `SELECT COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS id
       FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])
  return row?.id ?? null
}

const itemSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  cat: z.string().max(60).optional(),
  qty: z.number().positive(),
  price: z.number().nonnegative(),
  tax: z.number().nonnegative().optional(),
})

const createSchema = z.object({
  propertyId: z.string().uuid(),
  kind: z.enum(['one_time', 'standing']).default('one_time'),
  label: z.string().max(120).optional(),
  items: z.array(itemSchema).min(1),
  discountAmount: z.number().nonnegative().optional(),
  customer: z.object({
    name: z.string().max(120).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(40).optional(),
  }).optional(),
  tenantId: z.string().uuid().optional(),
  posCustomerId: z.string().uuid().optional(),
  bookingId: z.string().uuid().optional(),
})

async function propertyFor(req: any, propertyId: string) {
  const prop = await queryOne<{ id: string; name: string; landlord_id: string; register_card_fee_payer: CardFeePayer }>(
    `SELECT id, name, landlord_id, register_card_fee_payer FROM properties WHERE id = $1`, [propertyId])
  if (!prop) throw new AppError(404, 'Property not found')
  if (!canManageLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'Forbidden')
  await assertPropertyInScope(req.user, propertyId)
  return prop
}

/**
 * Create a link (and email it, for a one-time link). Everything that decides the
 * amount is computed here, from the landlord's own catalog — nothing the
 * customer's page could change.
 */
export async function createPayLink(req: any, body: z.infer<typeof createSchema>) {
  const prop = await propertyFor(req, body.propertyId)
  if (!(await connectIdFor(prop.landlord_id))) {
    throw new AppError(409, 'Card payments are not set up for this property yet — finish payout setup under Banking first.')
  }
  if (body.kind === 'one_time' && !body.customer?.email) {
    throw new AppError(400, 'An email address is needed to send the link.')
  }
  const totals = await computeCartTotals(prop.landlord_id, body.items as any[], {
    surcharge: 0, discountAmount: body.discountAmount ?? 0,
  })
  if (!(Number(totals.total) > 0)) throw new AppError(400, 'Nothing to charge — the total is $0.')
  if (body.bookingId) {
    const b = await queryOne<{ id: string }>(
      `SELECT b.id FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE b.id = $1 AND u.property_id = $2`, [body.bookingId, prop.id])
    if (!b) throw new AppError(404, 'That stay is not at this property.')
  }
  const token = crypto.randomBytes(24).toString('hex')
  const label = body.label?.trim()
    || (body.items.length === 1 ? body.items[0].name : `${body.items.length} items`)
  const link = await queryOne<any>(
    `INSERT INTO pos_pay_links
       (token, landlord_id, property_id, created_by, kind, label, items,
        subtotal, tax_amount, discount_amount, total,
        customer_name, customer_email, customer_phone, tenant_id, pos_customer_id, booking_id,
        card_fee_payer, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             CASE WHEN $5 = 'one_time' THEN NOW() + INTERVAL '14 days' ELSE NULL END)
     RETURNING *`,
    [token, prop.landlord_id, prop.id, req.user.userId, body.kind, label.slice(0, 120),
     JSON.stringify(body.items), totals.subtotal, totals.taxAmount, totals.discount, totals.total,
     body.customer?.name ?? null, body.customer?.email?.toLowerCase() ?? null, body.customer?.phone ?? null,
     body.tenantId ?? null, body.posCustomerId ?? null, body.bookingId ?? null,
     prop.register_card_fee_payer])

  const { customerFee, charged } = payLinkCharge(Number(link.total), link.card_fee_payer)
  if (link.kind === 'one_time') {
    const { emailPayLink } = await import('../services/email')
    await emailPayLink({
      to: link.customer_email, name: link.customer_name, propertyName: prop.name,
      label: link.label, amount: Number(link.total), cardFee: customerFee, url: payLinkUrl(token),
      ctx: { landlordId: prop.landlord_id, payLinkId: link.id },
    }).catch((e: unknown) => logger.error({ err: e, payLinkId: link.id }, '[pay-link] email failed'))
  }
  return { ...link, url: payLinkUrl(token), card_fee: customerFee, charged }
}

posPayLinksRouter.post('/', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    res.status(201).json({ success: true, data: await createPayLink(req, body) })
  } catch (e) { next(e) }
})

// GET /api/pos/pay-links?propertyId= — open links and standing QR codes.
posPayLinksRouter.get('/', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const propertyId = z.string().uuid().parse(req.query.propertyId)
    await propertyFor(req, propertyId)
    const rows = await query<any>(
      `SELECT l.*,
              (SELECT COUNT(*)::int FROM pos_transactions t WHERE t.pay_link_id = l.id) AS times_paid
         FROM pos_pay_links l
        WHERE l.property_id = $1
          AND (l.status = 'open' OR l.paid_at > NOW() - INTERVAL '7 days')
        ORDER BY (l.kind = 'standing') DESC, l.created_at DESC
        LIMIT 100`, [propertyId])
    res.json({ success: true, data: rows.map(r => ({
      ...r, url: payLinkUrl(r.token), ...payLinkCharge(Number(r.total), r.card_fee_payer) })) })
  } catch (e) { next(e) }
})

// POST /api/pos/pay-links/:id/cancel
posPayLinksRouter.post('/:id/cancel', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const link = await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [req.params.id])
    if (!link) throw new AppError(404, 'Pay link not found')
    await propertyFor(req, link.property_id)
    if (link.status !== 'open') throw new AppError(409, 'That link is already closed.')
    await query(`UPDATE pos_pay_links SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [link.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/pos/pay-links/:id/resend — a one-time link, to the same address.
posPayLinksRouter.post('/:id/resend', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const link = await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [req.params.id])
    if (!link) throw new AppError(404, 'Pay link not found')
    const prop = await propertyFor(req, link.property_id)
    if (link.kind !== 'one_time' || link.status !== 'open') throw new AppError(409, 'Only an open emailed link can be re-sent.')
    const { emailPayLink } = await import('../services/email')
    const { customerFee } = payLinkCharge(Number(link.total), link.card_fee_payer)
    await emailPayLink({
      to: link.customer_email, name: link.customer_name, propertyName: prop.name,
      label: link.label, amount: Number(link.total), cardFee: customerFee, url: payLinkUrl(link.token),
      ctx: { landlordId: link.landlord_id, payLinkId: link.id },
    })
    await query(`UPDATE pos_pay_links SET expires_at = NOW() + INTERVAL '14 days', updated_at = NOW() WHERE id = $1`, [link.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/pos/pay-links/:id/qr.png — the printable QR for a standing link.
posPayLinksRouter.get('/:id/qr.png', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const link = await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [req.params.id])
    if (!link) throw new AppError(404, 'Pay link not found')
    await propertyFor(req, link.property_id)
    const png = await QRCode.toBuffer(payLinkUrl(link.token), { width: 600, margin: 2 })
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.send(png)
  } catch (e) { next(e) }
})

// ── PUBLIC: the link itself ──────────────────────────────────────────────
//
// No login — the booking site already takes deposits without one, and after
// hours at the dump station is exactly when nobody is at the desk (Nic). The
// token is the only key; it opens Stripe's card page for a server-fixed amount
// and reveals nothing else.
export const publicPayRouter = Router()

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{margin:0;background:#0a0b0e;color:#c4ccde;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
.c{max-width:420px;background:#141720;border:1px solid #252d42;border-radius:14px;padding:28px}
h1{color:#f0f2f7;font-size:1.3rem;margin:0 0 8px}.g{color:#c9a227;font-weight:700;letter-spacing:.04em;font-size:.8rem;text-transform:uppercase}</style>
</head><body><div class="c"><div class="g">Gold Asset Management</div>${body}</div></body></html>`

const escapeHtml = (s: string) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

publicPayRouter.get('/pay/:token', async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{48}$/.test(req.params.token)) {
      return res.status(404).send(page('Link not found', '<h1>This link isn’t valid</h1><p>Check the link, or ask the office for a new one.</p>'))
    }
    const link = await queryOne<any>(
      `SELECT l.*, p.name AS property_name FROM pos_pay_links l
         JOIN properties p ON p.id = l.property_id WHERE l.token = $1`, [req.params.token])
    if (!link) {
      return res.status(404).send(page('Link not found', '<h1>This link isn’t valid</h1><p>Check the link, or ask the office for a new one.</p>'))
    }
    if (link.status === 'paid') {
      return res.send(page('Already paid', `<h1>Already paid — thank you</h1><p>${escapeHtml(link.label)} at ${escapeHtml(link.property_name)} is paid.</p>`))
    }
    if (link.status !== 'open' || (link.expires_at && new Date(link.expires_at) < new Date())) {
      return res.status(410).send(page('Link closed', `<h1>This link has closed</h1><p>Ask ${escapeHtml(link.property_name)} for a new one.</p>`))
    }
    const connectId = await connectIdFor(link.landlord_id)
    if (!connectId) {
      return res.status(503).send(page('Not available', `<h1>Card payment isn’t available right now</h1><p>Please pay ${escapeHtml(link.property_name)} directly.</p>`))
    }
    const { customerFee } = payLinkCharge(Number(link.total), link.card_fee_payer)
    const { createPayLinkCheckoutSession } = await import('../services/stripeConnect')
    // S648 (Nic): the money lands with GAM; the landlord's share (the link
    // total) is paid in the weekly batch and the card fee is GAM's.
    const session = await createPayLinkCheckoutSession({
      lineItems: [
        { name: `${link.label} — ${link.property_name}`, amountCents: Math.round(Number(link.total) * 100) },
        { name: 'Card processing fee', amountCents: Math.round(customerFee * 100) },
      ],
      customerEmail: link.customer_email,
      askName: link.kind === 'standing',
      successUrl: `${apiBase()}/api/public/pay/${link.token}/done`,
      cancelUrl: `${apiBase()}/api/public/pay/${link.token}`,
      metadata: { gam_pay_link_id: link.id, gam_landlord_id: link.landlord_id },
    })
    await query(`UPDATE pos_pay_links SET last_checkout_session_id = $2, updated_at = NOW() WHERE id = $1`,
      [link.id, session.sessionId])
    res.redirect(303, session.hostedUrl)
  } catch (e) { next(e) }
})

publicPayRouter.get('/pay/:token/done', async (req, res, next) => {
  try {
    const link = /^[a-f0-9]{48}$/.test(req.params.token) ? await queryOne<any>(
      `SELECT l.label, p.name AS property_name FROM pos_pay_links l
         JOIN properties p ON p.id = l.property_id WHERE l.token = $1`, [req.params.token]) : null
    res.send(page('Payment received',
      `<h1>Payment received — thank you</h1><p>${link ? `${escapeHtml(link.label)} at ${escapeHtml(link.property_name)}.` : ''} A receipt is on its way to your email.</p>`))
  } catch (e) { next(e) }
})

// ── PAID ─────────────────────────────────────────────────────────────────

/**
 * Stripe says a pay-link checkout finished. Records the sale (once per
 * PaymentIntent), closes a one-time link, confirms an attached stay. Refuses to
 * record an amount that is not the link's own — a changed catalog price after
 * the link went out is the landlord's to sort out, not something to guess at.
 */
export async function finalizePayLink(session: {
  id: string; amount_total: number | null; payment_intent: string | null
  metadata: Record<string, string> | null
  customer_details?: { email?: string | null; name?: string | null; phone?: string | null } | null
  custom_fields?: Array<{ key: string; text?: { value?: string | null } | null }> | null
}): Promise<{ recorded: boolean; reason?: string }> {
  const linkId = session.metadata?.gam_pay_link_id
  if (!linkId || !session.payment_intent) return { recorded: false, reason: 'not a pay link' }
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const link = (await client.query(`SELECT * FROM pos_pay_links WHERE id = $1 FOR UPDATE`, [linkId])).rows[0]
    if (!link) { await client.query('ROLLBACK'); return { recorded: false, reason: 'link gone' } }
    const dup = await client.query(`SELECT 1 FROM pos_transactions WHERE stripe_payment_intent_id = $1`, [session.payment_intent])
    if (dup.rows.length) { await client.query('ROLLBACK'); return { recorded: false, reason: 'already recorded' } }
    const { fee, charged, held, customerFee } = payLinkCharge(Number(link.total), link.card_fee_payer)
    if (Math.round(charged * 100) !== Number(session.amount_total)) {
      await client.query('ROLLBACK')
      logger.error({ linkId, expected: charged, got: session.amount_total }, '[pay-link] amount mismatch — not recorded')
      return { recorded: false, reason: 'amount mismatch' }
    }
    const { tx } = await insertPosSale(client, {
      landlordId: link.landlord_id, propertyId: link.property_id, cashierId: link.created_by,
      paymentMethod: 'card', tenantId: link.tenant_id, posCustomerId: link.pos_customer_id,
      subtotal: Number(link.subtotal), taxAmount: Number(link.tax_amount), surcharge: customerFee,
      total: charged, platformFee: fee, stripePaymentIntentId: session.payment_intent,
      payoutOwed: held,
      discountAmount: Number(link.discount_amount), discountReason: null,
      items: link.items,
    })
    await client.query(`UPDATE pos_transactions SET pay_link_id = $2 WHERE id = $1`, [tx.id, link.id])
    if (link.kind === 'one_time') {
      await client.query(
        `UPDATE pos_pay_links SET status = 'paid', paid_at = NOW(), pos_transaction_id = $2, updated_at = NOW()
          WHERE id = $1`, [link.id, tx.id])
    }
    if (link.booking_id) {
      const name = session.custom_fields?.find(f => f.key === 'name')?.text?.value
        ?? session.customer_details?.name ?? null
      await client.query(
        `UPDATE unit_bookings
            SET status = CASE WHEN status = 'tentative' THEN 'confirmed' ELSE status END,
                deposit_paid_at = COALESCE(deposit_paid_at, NOW()), hold_expires_at = NULL,
                guest_name = COALESCE(guest_name, $2), updated_at = NOW()
          WHERE id = $1`, [link.booking_id, name])
    }
    await client.query('COMMIT')
    return { recorded: true }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}
