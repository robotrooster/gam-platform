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

const payerOf = (link: { card_fee_on_top: boolean }): CardFeePayer => link.card_fee_on_top ? 'customer' : 'landlord'

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
  // S652 (Nic): a stay sold down this route takes the site off the board.
  // "Think of the stays like almost inventory where I've only got so many sites
  // on January 12th... when I send a pay link, it should use up inventory
  // according to what spot was booked and for how long."
  stay: z.object({
    unitId:     z.string().uuid(),
    checkIn:    z.string(),
    guestName:  z.string().max(120),
    guestPhone: z.string().max(40).nullish(),
    guestEmail: z.string().email().nullish(),
  }).optional(),
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
  // S652 — A STAY SOLD DOWN THIS ROUTE USES UP INVENTORY.
  //
  // Nic: "Think of the stays like almost inventory where I've only got so many
  // sites on January 12th. The inventory replenishes January 13th because it's
  // a new day and new nights can be paid for. So when I send a pay link, it
  // should use up inventory according to what spot was booked and for how long."
  //
  // The failure this replaces was narrow and real: a cashier could tap a stay
  // item into the cart and press "Email a pay link" instead of taking payment.
  // That path accepted any list of items, totalled them and emailed a link —
  // it had no notion of a site or a date to ask for. Paid, it wrote a sale and
  // the Master Schedule never heard about it, which is the same failure
  // register stays were built to end, through a different door. (The booking
  // site and the counter's reservation flow were always fine; both write a
  // unit_bookings row.)
  //
  // So the link now carries the stay, and the site comes off the board when the
  // link is SENT, not when it is paid. An unpaid hold has no clock on it and
  // yields to somebody who pays — the same rank every other hold obeys
  // (services/holdDisplacement).
  const itemIds = (body.items as any[]).map((i) => i.id).filter(Boolean)
  let stayLine: { itemId: string; name: string; stayUnit: 'night' | 'week' | 'month'; qty: number } | null = null
  if (itemIds.length) {
    const stayItems = await query<{ id: string; name: string; stay_unit: string }>(
      `SELECT id, name, stay_unit FROM pos_items
        WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`,
      [itemIds, prop.landlord_id])
    if (stayItems.length > 1) {
      throw new AppError(400, 'One stay to a link — a second site needs its own.')
    }
    if (stayItems.length === 1) {
      const cartLine = (body.items as any[]).find((i) => i.id === stayItems[0].id)!
      stayLine = {
        itemId: stayItems[0].id, name: stayItems[0].name,
        stayUnit: stayItems[0].stay_unit as 'night' | 'week' | 'month',
        qty: Number(cartLine.qty) || 0,
      }
      if (!body.stay) {
        throw new AppError(400,
          `"${stayLine.name}" needs a site and an arrival date before a link can go out — `
          + 'the site is held for them from the moment it is sent.')
      }
    }
  }
  if (body.stay && !stayLine) throw new AppError(400, 'Nothing on this link is a stay.')

  // The site's own rate, exactly as the counter and the booking site quote it.
  // (memory: gam-register-price-is-its-own-thing)
  let payItems = body.items as any[]
  if (stayLine && body.stay) {
    const { priceStayFromUnit } = await import('../services/registerStay')
    const priced = await priceStayFromUnit(query, body.stay.unitId, prop.landlord_id,
      stayLine.stayUnit, stayLine.qty)
    payItems = payItems.map((i) => i.id === stayLine!.itemId ? { ...i, price: priced.rate } : i)
  }

  const totals = await computeCartTotals(prop.landlord_id, payItems, {
    surcharge: 0, discountAmount: body.discountAmount ?? 0,
  })
  if (!(Number(totals.total) > 0)) throw new AppError(400, 'Nothing to charge — the total is $0.')
  if (body.bookingId) {
    const b = await queryOne<{ id: string }>(
      `SELECT b.id FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE b.id = $1 AND u.property_id = $2`, [body.bookingId, prop.id])
    if (!b) throw new AppError(404, 'That stay is not at this property.')
  }
  // The site comes off the board NOW. A link sitting unpaid in somebody's inbox
  // while the counter sells the same site to a walk-in is the double-booking
  // this whole mechanism exists to prevent — so the booking is written when the
  // link is sent, tentative and unpaid, and it is displaceable exactly like any
  // other unpaid hold. Both writes share one transaction: a held site with no
  // link, or a link with no site, are each worse than neither.
  let stayBookingId: string | null = body.bookingId ?? null
  const bookingClient = stayLine && body.stay ? await getClient() : null
  if (bookingClient && body.stay && stayLine) {
    try {
      await bookingClient.query('BEGIN')
      const { checkOutFor, siteIsFree, createStayBooking } = await import('../services/registerStay')
      const checkOut = checkOutFor(body.stay.checkIn, stayLine.stayUnit, stayLine.qty)
      await bookingClient.query(
        `SELECT id FROM units WHERE id = $1 AND landlord_id = $2 FOR UPDATE`,
        [body.stay.unitId, prop.landlord_id])
      // A LINK IS NOT PAYMENT, so it displaces nobody. It may only take a site
      // nothing else is holding — the rank is money, not intent. createStayBooking
      // re-checks this under an advisory lock, which is what actually settles a
      // race; the check here is so the refusal reads like a sentence.
      if (!(await siteIsFree(bookingClient, body.stay.unitId, body.stay.checkIn, checkOut))) {
        throw new AppError(409, 'That site is not free for those dates any more.')
      }
      const booking = await createStayBooking(bookingClient, {
        landlordId: prop.landlord_id,
        propertyId: prop.id,
        posTransactionId: null,
        status: 'tentative',
        lines: [{ itemId: stayLine.itemId, qty: stayLine.qty, stayUnit: stayLine.stayUnit,
                  name: stayLine.name, lineTotal: Number(totals.subtotal) }],
        details: {
          unitId: body.stay.unitId, checkIn: body.stay.checkIn,
          guestName: body.stay.guestName,
          guestPhone: body.stay.guestPhone ?? body.customer?.phone ?? null,
          guestEmail: body.stay.guestEmail ?? body.customer?.email ?? null,
        },
      })
      stayBookingId = booking.bookingId
      await bookingClient.query('COMMIT')
    } catch (e) {
      await bookingClient.query('ROLLBACK').catch(() => {})
      throw e
    } finally { bookingClient.release() }
  }

  const token = crypto.randomBytes(24).toString('hex')
  const label = body.label?.trim()
    || (body.items.length === 1 ? body.items[0].name : `${body.items.length} items`)
  const link = await queryOne<any>(
    `INSERT INTO pos_pay_links
       (token, landlord_id, property_id, created_by, kind, label, items,
        subtotal, tax_amount, discount_amount, total,
        customer_name, customer_email, customer_phone, tenant_id, pos_customer_id, booking_id,
        card_fee_on_top, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             CASE WHEN $5 = 'one_time' THEN NOW() + INTERVAL '14 days' ELSE NULL END)
     RETURNING *`,
    [token, prop.landlord_id, prop.id, req.user.userId, body.kind, label.slice(0, 120),
     JSON.stringify(payItems), totals.subtotal, totals.taxAmount, totals.discount, totals.total,
     body.customer?.name ?? null, body.customer?.email?.toLowerCase() ?? null, body.customer?.phone ?? null,
     body.tenantId ?? null, body.posCustomerId ?? null, stayBookingId,
     prop.register_card_fee_payer === 'customer'])

  const { customerFee, charged } = payLinkCharge(Number(link.total), payerOf(link))
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

/**
 * S652 — the deposit on a reservation taken at the counter.
 *
 * Nic's counter script ends here: dates, then what is available, then the space,
 * then a name and an email, "→ emailed a deposit pay link". The guest is not
 * standing at a card reader — they rang, or they walked off — so the deposit is
 * a link rather than a charge, and the site is held unpaid until it is paid.
 *
 * Deliberately the SAME deposit the booking site would have quoted for the same
 * stay (services/propertyBooking quoteStay), because a guest who phones and a
 * guest who books online are buying the identical nights on the identical site.
 *
 * Idempotent per booking: the row is claimed on `deposit_amount IS NULL`, so a
 * double-click never sends two links or bills two deposits.
 */
export async function createBookingDepositLink(opts: {
  bookingId: string; landlordId: string; propertyId: string
  amount: number; guestName: string | null; guestEmail: string
}): Promise<{ id: string; url: string } | null> {
  if (!(opts.amount > 0)) return null
  if (!(await connectIdFor(opts.landlordId))) throw new AppError(409, 'No payout account to pay the landlord')
  const client = await getClient()
  let link: any
  let propName = ''
  try {
    await client.query('BEGIN')
    const claimed = await client.query(
      `UPDATE unit_bookings SET deposit_amount = $2, updated_at = NOW()
        WHERE id = $1 AND deposit_amount IS NULL RETURNING id`, [opts.bookingId, opts.amount])
    if (!claimed.rows.length) { await client.query('ROLLBACK'); return null }
    const prop = (await client.query<{ name: string; booking_card_fee_payer: CardFeePayer }>(
      `SELECT name, booking_card_fee_payer FROM properties WHERE id = $1`, [opts.propertyId])).rows[0]
    propName = prop.name
    const owner = (await client.query<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [opts.landlordId])).rows[0]
    const items = [{ id: null, name: 'Reservation deposit', qty: 1, price: opts.amount, tax: 0 }]
    const token = crypto.randomBytes(24).toString('hex')
    link = (await client.query(
      `INSERT INTO pos_pay_links
         (token, landlord_id, property_id, created_by, kind, label, items,
          subtotal, tax_amount, discount_amount, total,
          customer_name, customer_email, booking_id, card_fee_on_top)
       VALUES ($1,$2,$3,$4,'one_time',$5,$6::jsonb,$7,0,0,$7,$8,$9,$10,$11)
       RETURNING *`,
      [token, opts.landlordId, opts.propertyId, owner.user_id,
       'Reservation deposit', JSON.stringify(items), opts.amount, opts.guestName,
       opts.guestEmail.toLowerCase(), opts.bookingId, prop.booking_card_fee_payer === 'customer'])).rows[0]
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }

  // No expiry on the LINK either. A deposit link that dies on its own leaves a
  // held site and a guest holding a dead URL, and somebody has to notice.
  const { customerFee } = payLinkCharge(Number(link.total), payerOf(link))
  const { emailPayLink } = await import('../services/email')
  await emailPayLink({
    to: link.customer_email, name: link.customer_name, propertyName: propName,
    label: link.label, amount: Number(link.total), cardFee: customerFee, url: payLinkUrl(link.token),
    ctx: { landlordId: opts.landlordId, payLinkId: link.id },
  }).catch((e: unknown) => logger.error({ err: e, payLinkId: link.id }, '[deposit-link] email failed'))
  return { id: link.id, url: payLinkUrl(link.token) }
}

/**
 * S649 — the balance of a short stay, billed on arrival day (services/stayBalance).
 * A one-time link tied to the booking; the card fee follows the property's
 * booking-site setting. Idempotent per booking: the booking row is claimed
 * first, so a second run never sends a second link.
 */
export async function createStayBalanceLink(opts: {
  bookingId: string; landlordId: string; propertyId: string; label: string
  amount: number; guestName: string | null; guestEmail: string
}): Promise<{ id: string } | null> {
  if (!(opts.amount > 0)) return null
  if (!(await connectIdFor(opts.landlordId))) throw new AppError(409, 'No payout account to pay the landlord')
  const client = await getClient()
  let link: any
  let propName = ''
  try {
    await client.query('BEGIN')
    const claimed = await client.query(
      `UPDATE unit_bookings SET balance_billed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND balance_billed_at IS NULL RETURNING id`, [opts.bookingId])
    if (!claimed.rows.length) { await client.query('ROLLBACK'); return null }
    const prop = (await client.query<{ name: string; booking_card_fee_payer: CardFeePayer }>(
      `SELECT name, booking_card_fee_payer FROM properties WHERE id = $1`, [opts.propertyId])).rows[0]
    propName = prop.name
    const owner = (await client.query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [opts.landlordId])).rows[0]
    const items = [{ id: null, name: opts.label.slice(0, 120), qty: 1, price: opts.amount, tax: 0 }]
    link = (await client.query(
      `INSERT INTO pos_pay_links
         (token, landlord_id, property_id, created_by, kind, label, items,
          subtotal, tax_amount, discount_amount, total,
          customer_name, customer_email, booking_id, card_fee_on_top, expires_at)
       VALUES ($1,$2,$3,$4,'one_time',$5,$6::jsonb,$7,0,0,$7,$8,$9,$10,$11, NOW() + INTERVAL '14 days')
       RETURNING *`,
      [crypto.randomBytes(24).toString('hex'), opts.landlordId, opts.propertyId, owner.user_id,
       'Stay balance', JSON.stringify(items), opts.amount, opts.guestName, opts.guestEmail.toLowerCase(),
       opts.bookingId, prop.booking_card_fee_payer === 'customer'])).rows[0]
    await client.query(`UPDATE unit_bookings SET balance_pay_link_id = $2 WHERE id = $1`, [opts.bookingId, link.id])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
  const { customerFee } = payLinkCharge(Number(link.total), payerOf(link))
  const { emailPayLink } = await import('../services/email')
  await emailPayLink({
    to: link.customer_email, name: link.customer_name, propertyName: propName,
    label: opts.label, amount: Number(link.total), cardFee: customerFee, url: payLinkUrl(link.token),
    ctx: { landlordId: opts.landlordId, payLinkId: link.id },
  }).catch((e: unknown) => logger.error({ err: e, payLinkId: link.id }, '[stay-balance] email failed'))
  return { id: link.id }
}

// GET /api/pos/pay-links/people?q= — S649 (Nic): who to send a bill to.
//
// Nic wanted "anybody that's in the database a searchable customer even cross
// landlord". Browsing every landlord's tenants would hand any landlord another's
// names, emails and phones (the audience-isolation rule), so, as agreed:
//   • YOUR people — tenants (leased or invited) and register customers of any
//     company the account owns — match on part of a name, email or phone.
//   • ANYONE ELSE on GAM — only on their FULL email or phone number, returning
//     just that one person, so there is nothing to browse.
posPayLinksRouter.get('/people', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) return res.json({ success: true, data: [] })
    const { landlordScopeIds } = await import('../lib/landlordScope')
    const mine = landlordScopeIds(req.user)
    const like = `%${q.replace(/[%_\\]/g, '')}%`
    const digits = q.replace(/\D/g, '')
    const own = await query<any>(`
      WITH my_tenants AS (
        SELECT DISTINCT t.user_id FROM tenants t
          JOIN lease_tenants lt ON lt.tenant_id = t.id
          JOIN leases l ON l.id = lt.lease_id
         WHERE l.landlord_id = ANY($1::uuid[])
        UNION
        SELECT DISTINCT t.user_id FROM tenants t
          JOIN pending_tenant_intents i ON i.tenant_id = t.id
         WHERE i.landlord_id = ANY($1::uuid[]) AND i.cancelled_at IS NULL
      )
      SELECT u.first_name, u.last_name, u.email, u.phone, 'tenant' AS kind
        FROM users u JOIN my_tenants m ON m.user_id = u.id
       WHERE (u.first_name || ' ' || u.last_name) ILIKE $2 OR u.email ILIKE $2
          OR ($3 <> '' AND regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g') LIKE '%' || $3 || '%')
      UNION
      SELECT c.first_name, c.last_name, c.email, c.phone, 'customer' AS kind
        FROM pos_customers c
       WHERE c.landlord_id = ANY($1::uuid[]) AND c.archived_at IS NULL
         AND ((c.first_name || ' ' || c.last_name) ILIKE $2 OR c.email ILIKE $2
              OR ($3 <> '' AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE '%' || $3 || '%'))
      LIMIT 10`, [mine, like, digits.length >= 3 ? digits : ''])
    // Anyone else: exact email, or a full phone number, only.
    const exact = (q.includes('@') || digits.length >= 10) ? await query<any>(`
      SELECT first_name, last_name, email, phone, 'gam' AS kind FROM users
       WHERE role IN ('tenant', 'guest')
         AND (lower(email) = lower($1)
              OR ($2 <> '' AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = right($2, 10)))
       LIMIT 1`, [q, digits.length >= 10 ? digits : '']) : []
    const seen = new Set(own.map((r: any) => (r.email || '').toLowerCase()))
    res.json({ success: true, data: [...own, ...exact.filter((r: any) => !seen.has((r.email || '').toLowerCase()))]
      .map((r: any) => ({ name: [r.first_name, r.last_name].filter(Boolean).join(' '), email: r.email, phone: r.phone, kind: r.kind })) })
  } catch (e) { next(e) }
})

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
      ...r, url: payLinkUrl(r.token), ...payLinkCharge(Number(r.total), payerOf(r)) })) })
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
    const { customerFee } = payLinkCharge(Number(link.total), payerOf(link))
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
    const { customerFee } = payLinkCharge(Number(link.total), payerOf(link))
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
    const { fee, charged, held, customerFee } = payLinkCharge(Number(link.total), payerOf(link))
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
    // S649: the arrival-day balance of a stay.
    await client.query(
      `UPDATE unit_bookings SET balance_paid_at = COALESCE(balance_paid_at, NOW()), updated_at = NOW()
        WHERE balance_pay_link_id = $1`, [link.id])
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
