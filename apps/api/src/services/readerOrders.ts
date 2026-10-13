/**
 * S652 — card readers for landlords, from a request in the register to a
 * device that works the day it arrives.
 *
 * Nic: "they get their card reader, they plug it in, they're good to go…
 * make it where they can only get one specific reader… we're gonna do the
 * kind of Affirm situation: $350, four payments."
 *
 * The shape of it:
 *   1. The landlord asks from the register (one model, the price, the plan,
 *      the ship-to address).
 *   2. GAM orders it in Stripe's shop, pre-registered to the property's
 *      Terminal location, shipped straight to the landlord (GAM-side desk
 *      records the Stripe order, serial and tracking).
 *   3. Stripe registers the reader to the location when the serial is
 *      assigned; the register picks it up on its own (syncReadersFromStripe) —
 *      no pairing code.
 *   4. The price is paid in monthly pieces netted from the landlord's payouts:
 *      one on the 1st of each month AFTER the month it ships, each its own
 *      charge line (Nic 10/5: shipped in September → October, November,
 *      December, January).
 */
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { getStripe } from '../lib/stripe'
import { chargeLandlord } from './landlordGamAccount'
import { getOrCreatePropertyLocation } from './posTerminal'
import { createAdminNotification } from './adminNotifications'
import { portalUrl } from '../lib/portalUrls'
import { recordPlatformRevenue, realLandlordSql } from './platformRevenue'
import { dateIn, todayIn } from '../lib/timezone'
import {
  SUPPORTED_CARD_READER, installmentSplit, readerCostTotal, readerOrderMoney, readerPieceSplit,
  type ReaderCostParts, type ReaderPieceBilled,
} from '@gam/shared'

/**
 * 10/13: GAM's own calendar — the day GAM bought a reader, the day a cost
 * correction applies from. GAM runs on Arizona time (the morning jobs do too).
 */
const GAM_TZ = 'America/Phoenix'

export interface ShipTo {
  name: string; company?: string | null; line1: string; line2?: string | null
  city: string; state: string; zip: string; phone?: string | null; email?: string | null
}

export async function requestReader(opts: {
  landlordId: string; propertyId: string; shipTo: ShipTo; note?: string | null; requestedByUserId: string | null
}) {
  const open = await queryOne<{ id: string }>(
    `SELECT id FROM pos_reader_orders WHERE property_id = $1 AND status NOT IN ('registered','cancelled') LIMIT 1`,
    [opts.propertyId])
  if (open) throw new AppError(409, 'A reader is already on its way to this property. Cancel that request first if it was a mistake.')
  // The Terminal location is what the shop order pre-registers to — make sure
  // it exists before anyone opens the shop.
  await getOrCreatePropertyLocation(opts.propertyId)
  const pieces = installmentSplit(SUPPORTED_CARD_READER.price, SUPPORTED_CARD_READER.installments)
  const row = await queryOne<any>(
    `INSERT INTO pos_reader_orders
       (landlord_id, property_id, model, price, installments, installment_amount,
        ship_name, ship_company, ship_line1, ship_line2, ship_city, ship_state, ship_zip, ship_phone, ship_email,
        note, requested_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [opts.landlordId, opts.propertyId, SUPPORTED_CARD_READER.model, SUPPORTED_CARD_READER.price,
     SUPPORTED_CARD_READER.installments, pieces[0],
     opts.shipTo.name, opts.shipTo.company ?? null, opts.shipTo.line1, opts.shipTo.line2 ?? null,
     opts.shipTo.city, opts.shipTo.state, opts.shipTo.zip, opts.shipTo.phone ?? null, opts.shipTo.email ?? null,
     opts.note ?? null, opts.requestedByUserId])
  logger.info({ orderId: row.id, landlordId: opts.landlordId, propertyId: opts.propertyId }, '[reader-order] requested')

  // S652 (Nic): "I don't want to have to manually look somewhere and say, oh,
  // I missed this… this person wanted a reader two weeks ago and I forgot."
  // Stripe will not let software place the order (its ordering interface is a
  // private preview our account is refused), so a person still presses buy —
  // but the request comes to them, the moment it is made, with everything the
  // shop asks for; and chaseReaderOrders() keeps coming back every morning
  // until the row says Ordered.
  const who = await queryOne<{ business_name: string | null; property_name: string; loc: string | null }>(
    `SELECT l.business_name, p.name AS property_name, p.stripe_terminal_location_id AS loc
       FROM properties p JOIN landlords l ON l.id = p.landlord_id WHERE p.id = $1`, [opts.propertyId])
  await createAdminNotification({
    severity: 'warn', category: 'reader_order_requested', emailSuperAdmins: true,
    title: `Card reader requested — ${who?.business_name ?? 'a landlord'} · ${who?.property_name ?? ''}`.trim(),
    body: [
      `Order ONE ${SUPPORTED_CARD_READER.label}, standard shipping, in the Stripe shop.`,
      `Pre-register it to the location "${who?.property_name ?? ''}"${who?.loc ? ` (${who.loc})` : ''}.`,
      `Ship to: ${opts.shipTo.name}${opts.shipTo.company ? `, ${opts.shipTo.company}` : ''}, ${opts.shipTo.line1}${opts.shipTo.line2 ? `, ${opts.shipTo.line2}` : ''}, ${opts.shipTo.city}, ${opts.shipTo.state} ${opts.shipTo.zip}${opts.shipTo.phone ? ` · ${opts.shipTo.phone}` : ''}.`,
      `Shop: https://dashboard.stripe.com/terminal/shop`,
      `Then mark the row Ordered (with Stripe's order id) on the Reader Orders desk.`,
    ].join('\n'),
    context: { order_id: row.id, property_id: opts.propertyId },
    action: { label: 'Open Reader Orders', url: `${portalUrl('admin')}/reader-orders` },
  })
  return row
}

/**
 * 10/13 (review): an order GAM has bought from Stripe's shop — ordered or
 * further along, or cancelled after it was ordered or shipped. Not a request
 * nobody ordered, nor one cancelled before anyone did.
 */
const READER_BOUGHT_SQL = (o: string) => `(${o}.status IN ('ordered','shipped','delivered','registered')
  OR (${o}.status = 'cancelled' AND COALESCE(${o}.ordered_at, ${o}.shipped_at, ${o}.delivered_at, ${o}.registered_at) IS NOT NULL))`

/**
 * The morning chase: ONE email while anything is waiting on GAM.
 *
 *   requested            → nobody has ordered it yet (every day until they do)
 *   ordered, no reader   → after 3 days: has Stripe shipped it?
 *   shipped, never online→ after 10 days: did it arrive, is it plugged in?
 *   bought, no cost      → (10/13) every day until GAM's cost is on the desk
 *
 * One digest, not one email per order (S652: one email per thing), counting
 * orders — one order can be on two lines (not in use yet, and no cost). Silent
 * when nothing waits.
 */
export async function chaseReaderOrders(now: Date = new Date()): Promise<{ waiting: number; sent: boolean }> {
  // 10/12 (review): every morning, not only on the 1st, a piece the code before
  // 10/12 raised with no order named is tied to its order (linkUnlinkedReaderPieces),
  // so the desk and the GAM-money bridge never miss it for a month.
  try {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await linkUnlinkedReaderPieces(c)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  } catch (e) { logger.warn({ err: e }, '[reader-order] could not link pieces raised before 10/12 — the next run tries again') }
  // 10/5 (Nic): "the card reader arrived on Friday and it's been set up and
  // used for several days... the system should be detecting that it's already
  // active and in use." Ask the readers before asking a person: every property
  // with an order GAM has placed is checked at Stripe first (and against the
  // readers already on file if Stripe can't be reached), so an order whose
  // reader is plugged in and working never makes this list.
  const placed = await query<{ landlord_id: string; property_id: string }>(
    `SELECT DISTINCT landlord_id, property_id FROM pos_reader_orders WHERE status IN ('ordered','shipped','delivered')`)
  for (const o of placed) await syncReadersFromStripe(o.landlord_id, o.property_id)
  const rows = await query<any>(
    `SELECT o.id, o.status, o.created_at, o.ordered_at, o.shipped_at, o.serial,
            p.name AS property_name, l.business_name
       FROM pos_reader_orders o JOIN properties p ON p.id = o.property_id JOIN landlords l ON l.id = o.landlord_id
      WHERE o.status IN ('requested','ordered','shipped','delivered')
      ORDER BY o.created_at`)
  const days = (d: any) => Math.floor((now.getTime() - new Date(d).getTime()) / 86400000)
  const lines: string[] = []
  // 10/13 (review): the title counts orders, not lines.
  const waitingOrders = new Set<string>()
  for (const o of rows) {
    const name = `${o.business_name ?? 'Landlord'} · ${o.property_name}`
    const before = lines.length
    if (o.status === 'requested') {
      lines.push(`NOT ORDERED — ${name}: asked ${days(o.created_at)} day(s) ago`)
    } else if (o.status === 'ordered' && days(o.ordered_at ?? o.created_at) >= 3) {
      lines.push(`CHECK STRIPE — ${name}: ordered ${days(o.ordered_at ?? o.created_at)} day(s) ago and no reader has shown up at the property yet — has it shipped?`)
    } else if ((o.status === 'shipped' || o.status === 'delivered') && days(o.shipped_at ?? o.created_at) >= 10) {
      lines.push(`NOT IN USE — ${name}: shipped ${days(o.shipped_at ?? o.created_at)} day(s) ago and Stripe has never seen it switched on — did it arrive, is it plugged in?`)
    }
    if (lines.length > before) waitingOrders.add(o.id)
  }
  // 10/13 (Nic): "flag missing cost in the morning admin email." Every reader
  // GAM has bought with no cost on the desk — ordered, or further along; and
  // one cancelled after GAM ordered it (GAM paid the shop; the receipt, or its
  // refund, is still to be typed). Not a request nobody ordered. Every morning
  // until it is entered — a registered reader too, since its pieces keep
  // billing and the markup they carry is only booked once the cost is known.
  const noCost = await query<any>(
    `SELECT o.id, o.status, COALESCE(o.ordered_at, o.shipped_at, o.created_at) AS bought_at,
            p.name AS property_name, l.business_name
       FROM pos_reader_orders o JOIN properties p ON p.id = o.property_id JOIN landlords l ON l.id = o.landlord_id
      WHERE ${READER_BOUGHT_SQL('o')}
        AND NOT EXISTS (SELECT 1 FROM pos_reader_order_costs c WHERE c.reader_order_id = o.id)
      ORDER BY COALESCE(o.ordered_at, o.shipped_at, o.created_at)`)
  for (const o of noCost) {
    lines.push(`NO COST ENTERED — ${o.business_name ?? 'Landlord'} · ${o.property_name}: ordered ${days(o.bought_at)} day(s) ago`
      + `${o.status === 'cancelled' ? ' (cancelled since)' : ''} and what the reader cost GAM is not on the desk — `
      + `type the Stripe shop receipt (base price, tax, shipping) on Reader Orders`)
    waitingOrders.add(o.id)
  }
  if (!lines.length) return { waiting: 0, sent: false }
  const n = waitingOrders.size
  await createAdminNotification({
    severity: 'warn', category: 'reader_orders_waiting', emailSuperAdmins: true,
    title: `${n} card reader order${n === 1 ? '' : 's'} waiting on GAM`,
    body: lines.join('\n'),
    context: { count: n },
    action: { label: 'Open Reader Orders', url: `${portalUrl('admin')}/reader-orders` },
  })
  return { waiting: n, sent: true }
}

export function listReaderOrders(landlordId: string, propertyId?: string) {
  return query<any>(
    `SELECT o.*, p.name AS property_name FROM pos_reader_orders o JOIN properties p ON p.id = o.property_id
      WHERE o.landlord_id = $1 ${propertyId ? 'AND o.property_id = $2' : ''}
      ORDER BY o.created_at DESC`, propertyId ? [landlordId, propertyId] : [landlordId])
}

export async function cancelReaderRequest(landlordId: string, id: string) {
  const row = await queryOne<any>(
    `UPDATE pos_reader_orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND landlord_id = $2 AND status = 'requested' RETURNING *`, [id, landlordId])
  if (!row) throw new AppError(409, 'Only a request that has not been ordered yet can be cancelled — call us if it has.')
  return row
}

// ── 10/12 (Nic): what each reader cost GAM, and its markup ─────────────────
//
// "331.73 after tax and shipping. 299 base. those orders are going to need to
// be tracked because shipping will vary." Every order carries GAM's actual cost
// (pos_reader_order_costs: one row per entry, never edited or deleted, the
// latest wins — since 10/13 each dated, below).
// The desk shows, per order, what the landlord is charged, what GAM paid, and
// the markup between them.
//
// "COST FIRST" (Nic 10/12, Q-g): the payments repay GAM's cost first, and the
// markup lands in the last piece(s) (@gam/shared readerPieceSplit). Only the
// markup is GAM's earnings: bookReaderMarkup books it into the earnings ledger
// ('device_markup') piece by piece when the piece carrying it is billed — the
// way a platform fee is booked when it is billed. The cost part is GAM's own
// money coming back, never earnings; the GAM-money bridge shows it on its own
// line (services/stripeCosts, readerMarkupFacts).
//
// 10/13 (Nic): "record each reader as a GAM expense (loss if cost > charge);
// allow dated cost corrections; flag missing cost in the morning admin email."
// Every cost entry is dated (effective_on): the first, the day GAM bought the
// reader — GAM's expense, on the desk with its date; a later one is a
// correction (a refund, extra shipping) that applies from its own date, the
// figure before it kept on record. The total is no longer fixed once markup is
// booked (10/12): the dated correction replaces that. A piece of the plan
// books the markup it carries under the figure in force the day it was billed
// (bookReaderMarkup); nothing booked is ever rewritten. The desk shows a loss
// (a reader that cost GAM more than the landlord is charged) and anything a
// correction changes in pieces already billed as NOT IN GAM'S BOOK: how a
// reader's expense, a loss and a correction's difference go into GAM's own
// book (platform_revenue_ledger) is an open question to Nic — the purchase as
// an expense row with the repayments as recovery, or only the net result —
// and nothing of it is booked until he answers.

/** The order's current cost: its latest entry. Use as `LEFT JOIN LATERAL (${LATEST_READER_COST_SQL('o')}) c ON TRUE`. */
const LATEST_READER_COST_SQL = (order: string) => `
  SELECT x.id, x.base_price, x.tax_amount, x.shipping_amount, x.tax_and_shipping_amount, x.total_cost,
         x.created_at, x.source, to_char(x.effective_on, 'YYYY-MM-DD') AS effective_on
    FROM pos_reader_order_costs x WHERE x.reader_order_id = ${order}.id ORDER BY x.seq DESC LIMIT 1`

const centsOf = (n: unknown) => Math.round(Number(n ?? 0) * 100)
const num = (n: unknown) => (n == null ? null : Number(n))

/**
 * 10/13: every row GAM's own book holds for one reader order — the markup its
 * pieces carry ('device_markup', one per piece). `voided` names a row whose
 * piece was voided after its markup was booked: the row is still in the book.
 */
const ORDER_BOOK_ROWS_SQL = (orderRef: string) => `
  SELECT r.id, r.amount, r.created_at, r.notes, g.installment_number AS n, (g.voided_at IS NOT NULL) AS voided
    FROM platform_revenue_ledger r
    JOIN landlord_gam_charges g ON g.id = r.reference_id
   WHERE r.type = 'device_markup' AND r.reference_type = 'reader_order_installment'
     AND g.reader_order_id = ${orderRef}`

/**
 * GAM's desk: every order, newest first, with the location Stripe's shop needs
 * — and (10/12) GAM's cost, the price charged, the markup, every cost entry
 * made, and each piece of the plan split cost first. (10/13) The cost's date
 * (the day GAM bought it, or the day a correction applies from), the loss when
 * the reader cost GAM more than it charges, every row GAM's own book holds for
 * the reader, and what is not in GAM's book (a loss; what a correction changed
 * in pieces already billed). `orderId` reads one.
 */
export async function adminListReaderOrders(orderId?: string) {
  const rows = await query<any>(
    `SELECT o.*, p.name AS property_name, p.stripe_terminal_location_id, l.business_name,
            u.email AS landlord_email,
            c.base_price AS cost_base_price, c.tax_amount AS cost_tax, c.shipping_amount AS cost_shipping,
            c.tax_and_shipping_amount AS cost_tax_and_shipping, c.total_cost AS cost_total,
            c.created_at AS cost_entered_at, c.effective_on AS cost_effective_on,
            COALESCE((SELECT json_agg(json_build_object(
                        'id', h.id, 'base_price', h.base_price, 'tax', h.tax_amount, 'shipping', h.shipping_amount,
                        'tax_and_shipping', h.tax_and_shipping_amount, 'total', h.total_cost, 'note', h.note,
                        'source', h.source, 'entered_at', h.created_at,
                        'effective_on', to_char(h.effective_on, 'YYYY-MM-DD'),
                        'entered_by', NULLIF(TRIM(COALESCE(eu.first_name, '') || ' ' || COALESCE(eu.last_name, '')), ''),
                        'entered_by_email', eu.email) ORDER BY h.seq DESC)
                        FROM pos_reader_order_costs h LEFT JOIN users eu ON eu.id = h.entered_by_user_id
                       WHERE h.reader_order_id = o.id), '[]'::json) AS cost_history,
            COALESCE((SELECT json_agg(json_build_object(
                        'n', g.installment_number, 'amount', g.amount, 'collected', g.collected_amount,
                        'voided', g.voided_at IS NOT NULL, 'billed_at', g.created_at,
                        'markup_booked', (SELECT COALESCE(SUM(r.amount), 0) FROM platform_revenue_ledger r
                                           WHERE r.type = 'device_markup' AND r.reference_id = g.id
                                             AND r.reference_type = 'reader_order_installment'))
                        ORDER BY g.installment_number)
                        FROM landlord_gam_charges g WHERE g.reader_order_id = o.id), '[]'::json) AS pieces_billed,
            COALESCE((SELECT json_agg(json_build_object(
                        'id', b.id, 'amount', b.amount, 'at', b.created_at, 'notes', b.notes, 'n', b.n, 'voided', b.voided)
                        ORDER BY b.created_at, b.id)
                        FROM (${ORDER_BOOK_ROWS_SQL('o.id')}) b), '[]'::json) AS book_rows
       FROM pos_reader_orders o
       JOIN properties p ON p.id = o.property_id
       JOIN landlords l ON l.id = o.landlord_id
       JOIN users u ON u.id = l.user_id
       LEFT JOIN LATERAL (${LATEST_READER_COST_SQL('o')}) c ON TRUE
      ${orderId ? 'WHERE o.id = $1' : ''}
      ORDER BY (o.status IN ('requested','ordered','shipped','delivered')) DESC, o.created_at DESC`,
    orderId ? [orderId] : [])
  return rows.map(r => {
    const billed: Array<ReaderPieceBilled & { billed_at: string; markup_booked: number }> =
      (r.pieces_billed ?? []).map((g: any) => ({
        n: Number(g.n), amount: Number(g.amount), collected: Number(g.collected), voided: !!g.voided,
        billed_at: g.billed_at, markup_booked: Number(g.markup_booked),
      }))
    const money = readerOrderMoney({
      price: Number(r.price), installments: Number(r.installments), totalCost: num(r.cost_total), pieces: billed,
    })
    const book = (r.book_rows ?? []).map((b: any) => ({
      id: b.id, at: b.at, amount: Number(b.amount), notes: b.notes ?? null,
      n: b.n == null ? null : Number(b.n), voided: !!b.voided,
    }))
    const bookedLiveC = book.filter((b: any) => !b.voided).reduce((a: number, b: any) => a + centsOf(b.amount), 0)
    const { pieces_billed: _omit, book_rows: _omitBook, ...row } = r
    return {
      ...row,
      cost_base_price: num(r.cost_base_price), cost_tax: num(r.cost_tax), cost_shipping: num(r.cost_shipping),
      cost_tax_and_shipping: num(r.cost_tax_and_shipping), cost_total: num(r.cost_total),
      // 10/13: markup from the cost is in GAM's book — a new entry is a dated
      // correction from here (it applies from its own date; the booked rows stay).
      cost_booked: book.length > 0,
      charged: money.charged,
      markup: money.markup,
      loss: money.loss,
      markup_billed: money.markupBilled,
      markup_collected: money.markupCollected,
      markup_not_collected: money.markupNotCollected,
      cost_recovered: money.costRecovered,
      billed: money.billed,
      collected: money.collected,
      markup_booked: Math.round(billed.reduce((a, g) => a + centsOf(g.markup_booked), 0)) / 100,
      // 10/13 (review): what GAM's own book holds for the reader — every row,
      // a voided piece's markup too (it stays in the book; voids are the
      // ledger's P0 work), so the desk says what the book says.
      booked_total: book.reduce((a: number, b: any) => a + centsOf(b.amount), 0) / 100,
      // 10/13: what the reader comes to under its current cost and is not in
      // GAM's book — the markup in the pieces billed so far, less a loss,
      // against the rows booked for those pieces. A loss, or what a dated
      // correction changed in a piece already billed: neither is booked until
      // Nic says how a reader's expense goes into GAM's book. (A markup row the
      // ledger missed shows here too, until the next run writes it.)
      not_booked: money.totalCost == null ? 0
        : (centsOf(money.markupBilled) - centsOf(money.loss) - bookedLiveC) / 100,
      book,
      // Every piece of the plan, cost first, and where each stands.
      pieces: money.split.map(s => {
        const b = billed.find(g => g.n === s.n)
        return {
          n: s.n, amount: s.amount, cost: s.cost, markup: s.markup,
          billed: !!b && !b.voided, voided: !!b?.voided, billed_at: b?.billed_at ?? null,
          collected: b?.collected ?? 0, markup_booked: b?.markup_booked ?? 0,
        }
      }),
    }
  })
}

const YMD = /^\d{4}-\d{2}-\d{2}$/
const isRealDay = (s: string) => YMD.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

/**
 * 10/12 (Nic): GAM's desk records what a reader actually cost GAM — base
 * price, tax and shipping (or tax and shipping as one figure when the receipt
 * does not split them). Each save is a new entry; the old ones are kept.
 *
 * 10/13 (Nic): "allow dated cost corrections" — every entry carries the day it
 * applies from (`effectiveOn`, 'YYYY-MM-DD', GAM's calendar). The first is the
 * day GAM bought the reader (left out: the day it was ordered from Stripe, or
 * today); a correction — a refund, extra shipping, after shipping or not — is
 * dated the day it applies from (left out: today), never before the entry it
 * corrects, never a day still to come, never before the landlord asked for the
 * reader. A piece billed on or after its date carries the markup under it
 * (bookReaderMarkup); nothing already booked is rewritten, and what it changes
 * in a piece already billed is shown on the desk, not booked (open question).
 */
export async function recordReaderOrderCost(orderId: string,
  parts: ReaderCostParts & { note?: string | null; effectiveOn?: string | null },
  enteredByUserId: string | null) {
  const vals = [parts.basePrice, parts.tax, parts.shipping, parts.taxAndShipping]
  if (!Number.isFinite(parts.basePrice) || vals.some(v => v != null && !(Number.isFinite(v) && v >= 0))) {
    throw new AppError(400, 'Every amount must be a number of dollars, zero or more.')
  }
  if (parts.taxAndShipping != null && (parts.tax != null || parts.shipping != null)) {
    throw new AppError(400, 'Enter tax and shipping separately, or as one combined amount — not both.')
  }
  if (parts.effectiveOn != null && !isRealDay(parts.effectiveOn)) {
    throw new AppError(400, 'Give the date as YYYY-MM-DD.')
  }
  const today = todayIn(GAM_TZ)
  if (parts.effectiveOn != null && parts.effectiveOn > today) {
    throw new AppError(400, 'A cost applies from today or a day already past — not a day still to come.')
  }
  const total = readerCostTotal(parts)
  let effectiveOn = parts.effectiveOn ?? null
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const o = (await client.query<{ id: string; created_at: Date; ordered_at: Date | null }>(
      `SELECT o.id, o.created_at, o.ordered_at FROM pos_reader_orders o WHERE o.id = $1 FOR UPDATE OF o`, [orderId])).rows[0]
    if (!o) throw new AppError(404, 'Reader order not found')
    const cur = (await client.query<{ effective_on: string }>(
      `SELECT to_char(effective_on, 'YYYY-MM-DD') AS effective_on FROM pos_reader_order_costs
        WHERE reader_order_id = $1 ORDER BY seq DESC LIMIT 1`, [orderId])).rows[0]
    effectiveOn ??= cur ? today : (o.ordered_at ? dateIn(GAM_TZ, new Date(o.ordered_at)) : today)
    const asked = dateIn(GAM_TZ, new Date(o.created_at))
    if (effectiveOn < asked) {
      throw new AppError(400, `GAM could not have paid for this reader before the landlord asked for it (${asked}).`)
    }
    if (cur && effectiveOn < cur.effective_on) {
      throw new AppError(409, `A correction applies from its own date — on or after ${cur.effective_on}, the date of the figure it corrects. `
        + `The figure before it stays on record for the days before.`)
    }
    const ins = await client.query<{ id: string }>(
      `INSERT INTO pos_reader_order_costs
         (reader_order_id, base_price, tax_amount, shipping_amount, tax_and_shipping_amount, note, source, entered_by_user_id, effective_on)
       VALUES ($1, $2, $3, $4, $5, $6, 'desk', $7, $8) RETURNING id`,
      [orderId, parts.basePrice.toFixed(2), parts.tax?.toFixed(2) ?? null, parts.shipping?.toFixed(2) ?? null,
       parts.taxAndShipping?.toFixed(2) ?? null, parts.note?.trim() || null, enteredByUserId, effectiveOn])
    // A reader that shipped (and billed pieces) before its cost was typed:
    // book the markup those pieces carry now.
    await bookReaderMarkup(client, orderId)
    await client.query('COMMIT')
    logger.info({ orderId, total, effectiveOn, entryId: ins.rows[0]?.id }, '[reader-order] cost recorded')
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {})
    // The database's own rule (pos_reader_order_costs_lock) said no.
    if (e?.code === '23514' && !e?.constraint && /applies from its own date/.test(String(e?.message))) {
      throw new AppError(409, 'A correction applies from its own date — on or after the date of the figure it corrects. The figure before it stays on record for the days before.')
    }
    throw e
  } finally { client.release() }
  return (await adminListReaderOrders(orderId))[0]
}

/**
 * Book the markup in every billed piece that carries some and is not on GAM's
 * earnings ledger yet — one 'device_markup' row per piece, referenced to the
 * piece (landlord_gam_charges), dated the day the piece was billed (10/12,
 * Q-g — cost first). Idempotent (the ledger refuses a second row for the same
 * piece). An order with no cost entered books nothing: until GAM's cost is
 * known every dollar counts as cost. A demo or GAM-internal account's reader
 * is never earnings (the ledger's own rule), so it is left out here too. Runs
 * inside the caller's transaction. Each order row is locked before its cost is
 * read (10/12 review): a cost entry locks it too (recordReaderOrderCost,
 * pos_reader_order_costs_lock), so markup is never booked from a cost a
 * concurrent entry is replacing.
 *
 * 10/13 (Nic): "allow dated cost corrections" — a piece carries the markup
 * under the cost entry in force the day it was billed: the latest dated on or
 * before that day (an order's first entry covers every day before it, so a
 * cost typed late still books what its pieces carried). A row once booked is
 * never rewritten. Nothing else is booked here: a loss, and what a correction
 * changes in a piece already billed, wait on Nic's answer on how a reader's
 * expense goes into GAM's book (the desk shows them, adminListReaderOrders
 * not_booked).
 *
 * Returns how many rows it booked.
 */
export async function bookReaderMarkup(client: PoolClient, orderId?: string): Promise<number> {
  const orders = await client.query<any>(
    `SELECT o.id, o.price, o.installments, o.property_id, p.name AS property_name
       FROM pos_reader_orders o
       JOIN properties p ON p.id = o.property_id
      WHERE ($1::uuid IS NULL OR o.id = $1::uuid)
        AND ${realLandlordSql('p.landlord_id')}
        AND EXISTS (SELECT 1 FROM pos_reader_order_costs x WHERE x.reader_order_id = o.id)
        AND EXISTS (SELECT 1 FROM landlord_gam_charges g WHERE g.reader_order_id = o.id)
      ORDER BY o.id
      FOR UPDATE OF o`,
    [orderId ?? null])
  let booked = 0
  for (const o of orders.rows) {
    const price = Number(o.price), installments = Number(o.installments)
    const entries = (await client.query<{ total_cost: string; effective_on: string }>(
      `SELECT total_cost, to_char(effective_on, 'YYYY-MM-DD') AS effective_on
         FROM pos_reader_order_costs WHERE reader_order_id = $1 ORDER BY seq`, [o.id])).rows
    const pieces = (await client.query<{ id: string; n: number; billed_at: Date; billed_on: string }>(
      `SELECT g.id, g.installment_number AS n, g.created_at AS billed_at,
              to_char(g.created_at AT TIME ZONE '${GAM_TZ}', 'YYYY-MM-DD') AS billed_on
         FROM landlord_gam_charges g
        WHERE g.reader_order_id = $1 AND g.voided_at IS NULL AND g.installment_number IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM platform_revenue_ledger r
                           WHERE r.type = 'device_markup' AND r.reference_id = g.id
                             AND r.reference_type = 'reader_order_installment')
        ORDER BY g.installment_number`, [o.id])).rows
    for (const g of pieces) {
      const inForce = [...entries].reverse().find(e => e.effective_on <= g.billed_on) ?? entries[0]
      const s = readerPieceSplit(price, installments, Number(inForce.total_cost))[g.n - 1]
      if (!s || s.markup <= 0) continue
      await recordPlatformRevenue({
        type: 'device_markup', amount: s.markup,
        referenceId: g.id, referenceType: 'reader_order_installment', propertyId: o.property_id,
        notes: `Card reader markup — ${o.property_name}, payment ${s.n} of ${installments} `
          + `(charged $${price.toFixed(2)}, GAM's cost $${Number(inForce.total_cost).toFixed(2)})`,
        at: g.billed_at,
      }, client)
      booked++
    }
  }
  if (booked) logger.info({ booked, orderId: orderId ?? null }, '[reader-order] markup booked')
  return booked
}

/**
 * 10/12 (Nic, A3 + Q-g): what the GAM-money bridge needs about readers — of the
 * markup billed so far (what the earnings ledger should hold), how much has
 * been collected. Of everything collected on reader pieces the rest is GAM's
 * cost coming back. Cost first across each order; the same orders the ledger
 * books (no demo or GAM-internal account).
 */
export async function readerMarkupFacts(): Promise<{ markupBilled: number; markupCollected: number }> {
  const orders = await query<any>(
    `SELECT o.price, o.installments, c.total_cost,
            COALESCE((SELECT json_agg(json_build_object('n', g.installment_number, 'amount', g.amount,
                                                        'collected', g.collected_amount, 'voided', g.voided_at IS NOT NULL))
                        FROM landlord_gam_charges g WHERE g.reader_order_id = o.id), '[]'::json) AS pieces
       FROM pos_reader_orders o
       JOIN properties p ON p.id = o.property_id
       JOIN LATERAL (${LATEST_READER_COST_SQL('o')}) c ON TRUE
      WHERE ${realLandlordSql('p.landlord_id')}`)
  let billedC = 0, collectedC = 0
  for (const o of orders) {
    const m = readerOrderMoney({
      price: Number(o.price), installments: Number(o.installments), totalCost: Number(o.total_cost),
      pieces: (o.pieces ?? []).map((g: any) => ({ n: Number(g.n), amount: Number(g.amount), collected: Number(g.collected), voided: !!g.voided })),
    })
    billedC += centsOf(m.markupBilled); collectedC += centsOf(m.markupCollected)
  }
  return { markupBilled: billedC / 100, markupCollected: collectedC / 100 }
}

const STATUS_STAMP: Record<string, string> = {
  ordered: 'ordered_at', shipped: 'shipped_at', delivered: 'delivered_at', registered: 'registered_at', cancelled: 'cancelled_at',
}

/** GAM's desk moves an order along and records what Stripe said. */
export async function adminUpdateReaderOrder(id: string, patch: {
  status?: string; stripeHardwareOrderId?: string | null; serial?: string | null; trackingUrl?: string | null; note?: string | null
}) {
  const cur = await queryOne<any>(`SELECT * FROM pos_reader_orders WHERE id = $1`, [id])
  if (!cur) throw new AppError(404, 'Reader order not found')
  const sets: string[] = ['updated_at = NOW()']; const vals: any[] = [id]
  const add = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
  if (patch.stripeHardwareOrderId !== undefined) add('stripe_hardware_order_id', patch.stripeHardwareOrderId)
  if (patch.serial !== undefined) add('serial', patch.serial)
  if (patch.trackingUrl !== undefined) add('tracking_url', patch.trackingUrl)
  if (patch.note !== undefined) add('note', patch.note)
  if (patch.status && patch.status !== cur.status) {
    add('status', patch.status)
    const stamp = STATUS_STAMP[patch.status]
    if (stamp) sets.push(`${stamp} = COALESCE(${stamp}, NOW())`)
  }
  const row = await queryOne<any>(`UPDATE pos_reader_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)
  // Raise anything already due (a ship date set late can be months back).
  if (patch.status === 'shipped' || patch.status === 'delivered' || patch.status === 'registered') await raiseDueInstallments()
  return row
}

/**
 * 10/12 (review): a reader piece written with no order named (by the code
 * before 10/12 — source_type 'reader_order_installment', reader_order_id NULL)
 * is tied to its order the way migration 20261013090200 tied the ones that
 * existed then: the one order of that company at that property, numbered by
 * the "payment N of" its notes carry. A property with more than one order, a
 * piece with no number, or a number already taken is left alone. Idempotent.
 * Inside the caller's transaction. Returns how many were linked.
 */
export async function linkUnlinkedReaderPieces(client: PoolClient): Promise<number> {
  const r = await client.query(
    `WITH pieces AS (
       SELECT c.id, o.order_id, o.orders_here,
              substring(c.notes FROM 'payment ([0-9]+) of')::smallint AS n
         FROM landlord_gam_charges c
         CROSS JOIN LATERAL (
           SELECT (array_agg(r.id))[1] AS order_id, COUNT(*) AS orders_here
             FROM pos_reader_orders r
            WHERE r.landlord_id = c.landlord_id AND r.property_id = c.property_id) o
        WHERE c.source_type = 'reader_order_installment' AND c.reader_order_id IS NULL
     )
     UPDATE landlord_gam_charges c
        SET reader_order_id = p.order_id, installment_number = p.n
       FROM pieces p
      WHERE p.id = c.id AND p.orders_here = 1 AND p.n IS NOT NULL AND p.n > 0
        AND NOT EXISTS (SELECT 1 FROM landlord_gam_charges x
                         WHERE x.reader_order_id = p.order_id AND x.installment_number = p.n)
      RETURNING c.id`)
  if (r.rowCount) logger.info({ linked: r.rowCount }, '[reader-order] pieces raised before 10/12 linked to their order')
  return r.rowCount ?? 0
}

/**
 * Raise the pieces that are due: one on the 1st of each month after the month
 * the reader shipped (10/5, Nic: "It's the first of each month following
 * shipment" — a reader shipped September 29th is paid October, November,
 * December and January; nothing is owed in the month it ships). Counted by
 * calendar month. Idempotent — the count on the order is the ledger of what
 * has been raised.
 */
export async function raiseDueInstallments(now: Date = new Date()): Promise<number> {
  const client: PoolClient = await getClient()
  let raised = 0
  try {
    await client.query('BEGIN')
    const orders = await client.query<any>(
      `SELECT * FROM pos_reader_orders
        WHERE shipped_at IS NOT NULL AND status <> 'cancelled' AND installments_raised < installments
        ORDER BY id
        FOR UPDATE`)
    for (const o of orders.rows) {
      const shipped = new Date(o.shipped_at)
      const monthsSince = (now.getUTCFullYear() - shipped.getUTCFullYear()) * 12 + (now.getUTCMonth() - shipped.getUTCMonth())
      const due = Math.min(o.installments, Math.max(0, monthsSince))
      const pieces = installmentSplit(Number(o.price), o.installments)
      for (let n = o.installments_raised + 1; n <= due; n++) {
        await chargeLandlord(client, {
          landlordId: o.landlord_id, propertyId: o.property_id, kind: 'device_installment',
          amount: pieces[n - 1], sourceType: 'reader_order_installment', sourceId: null,
          // 10/12 (Nic, ledger P0): the piece names its order and its number,
          // so the books clear the reader piece by piece (and a piece can never
          // be raised twice — the pair is unique).
          readerOrderId: o.id, installmentNumber: n,
          notes: `Card reader (${SUPPORTED_CARD_READER.label}) — payment ${n} of ${o.installments}`,
        })
        await client.query(`UPDATE pos_reader_orders SET installments_raised = $2, updated_at = NOW() WHERE id = $1`, [o.id, n])
        raised++
      }
    }
    // 10/12 (review): a piece raised by the code before 10/12 (migrations reach
    // production before the code — expand then contract) names no order; the
    // one-time link in migration 20261013090200 ran before it existed. Linked
    // here, on every run, the same way, so the desk, the markup and the bridge
    // see it.
    await linkUnlinkedReaderPieces(client)
    // 10/12 (Nic, Q-g): a piece that carries markup (cost first: the last
    // piece(s)) puts that markup on GAM's earnings ledger as it is billed. Over
    // every order, not only the ones raised now, so a row the ledger missed
    // (it is written best-effort) is written on the next run.
    await bookReaderMarkup(client)
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
  if (raised) logger.info({ raised }, '[reader-order] installments raised')
  return raised
}

/**
 * The readers Stripe knows at this property's location — including the ones
 * Stripe registered itself from a pre-registered shop order — pulled into the
 * register's list so nobody types a pairing code. Best-effort: Stripe being
 * down must not hide the readers already on file.
 */
export async function syncReadersFromStripe(landlordId: string, propertyId: string): Promise<number> {
  const p = await queryOne<{ stripe_terminal_location_id: string | null }>(
    `SELECT stripe_terminal_location_id FROM properties WHERE id = $1 AND landlord_id = $2`, [propertyId, landlordId])
  let added = 0
  const seen = new Map<string, SeenReader>()
  if (p?.stripe_terminal_location_id) try {
    const readers = await getStripe().terminal.readers.list({ location: p.stripe_terminal_location_id, limit: 100 })
    for (const r of readers.data) {
      if (r.status === 'offline' && (r as any).deleted) continue
      seen.set(r.id, { serial: r.serial_number ?? null, lastSeenAt: (r as any).last_seen_at ?? null })
      const nickname = r.label || `${SUPPORTED_CARD_READER.label} ${r.serial_number?.slice(-4) ?? ''}`.trim()
      const known = await queryOne<{ id: string }>(
        `SELECT id FROM pos_terminal_readers WHERE stripe_reader_id = $1`, [r.id])
      if (!known) {
        await query(
          `INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname) VALUES ($1, $2, $3, $4)`,
          [landlordId, propertyId, r.id, nickname])
        added++
      }
    }
  } catch (e) { logger.warn({ err: e, propertyId }, '[reader-sync] could not list readers at Stripe') }
  // Runs even when Stripe could not be reached: the readers already on file
  // still say whether the order's reader has turned up. Only for this
  // landlord's property (the caller's scope).
  if (p) await reconcileReaderOrders(propertyId, seen)
  return added
}

/** What Stripe said about one reader on this pass. */
export interface SeenReader { serial: string | null; lastSeenAt: number | null }

/**
 * 10/5 — the order finds its reader; nobody types a serial.
 *
 * The only link from an order to its reader used to be a serial typed on the
 * desk. Nobody typed it, so Mountain View's order sat at Ordered for a week
 * while its reader took card sales, and the morning email kept asking for it.
 * The reader carries the answer:
 *
 *   - Stripe puts a pre-registered reader at the property's location when the
 *     order ships, so a reader that turns up there after the order was placed
 *     IS that order's reader (a property has one open order at a time —
 *     requestReader refuses a second). The order is shipped, from the moment
 *     GAM first saw the reader, and takes Stripe's serial.
 *   - A reader Stripe has seen online has been unpacked and switched on: the
 *     order is done (registered).
 *
 * A typed serial or an already-linked reader still wins. A reader linked to one
 * order is never claimed by another. Requests GAM has not ordered are left alone.
 * The payment plan starts from shipped_at through the daily installment job.
 */
export async function reconcileReaderOrders(propertyId: string, seen: Map<string, SeenReader> = new Map()): Promise<number> {
  const orders = await query<any>(
    `SELECT * FROM pos_reader_orders WHERE property_id = $1 AND status IN ('ordered','shipped','delivered') ORDER BY created_at`,
    [propertyId])
  let moved = 0
  for (const o of orders) {
    const bySerial = o.serial ? [...seen.entries()].find(([, s]) => s.serial === o.serial)?.[0] ?? null : null
    const reader = await queryOne<{ stripe_reader_id: string; created_at: string }>(
      o.stripe_reader_id || bySerial
        ? `SELECT stripe_reader_id, created_at FROM pos_terminal_readers WHERE property_id = $1 AND stripe_reader_id = $2`
        : `SELECT r.stripe_reader_id, r.created_at
             FROM pos_terminal_readers r
            WHERE r.property_id = $1
              AND r.created_at >= $2::timestamptz
              AND NOT EXISTS (SELECT 1 FROM pos_reader_orders x WHERE x.stripe_reader_id = r.stripe_reader_id AND x.id <> $3)
            ORDER BY r.created_at LIMIT 1`,
      o.stripe_reader_id || bySerial
        ? [propertyId, o.stripe_reader_id || bySerial]
        : [propertyId, o.ordered_at ?? o.created_at, o.id])
    if (!reader) continue
    const s = seen.get(reader.stripe_reader_id)
    const inUse = s?.lastSeenAt != null
    const r = await query(
      `UPDATE pos_reader_orders
          SET stripe_reader_id = $2,
              serial        = COALESCE(serial, $3),
              shipped_at    = COALESCE(shipped_at, $4::timestamptz),
              status        = CASE WHEN $5 THEN 'registered' WHEN status = 'ordered' THEN 'shipped' ELSE status END,
              delivered_at  = CASE WHEN $5 THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
              registered_at = CASE WHEN $5 THEN COALESCE(registered_at, NOW()) ELSE registered_at END,
              updated_at    = NOW()
        WHERE id = $1
          AND (stripe_reader_id IS DISTINCT FROM $2 OR serial IS NULL AND $3::text IS NOT NULL
               OR shipped_at IS NULL OR status = 'ordered' OR $5)
        RETURNING id`,
      [o.id, reader.stripe_reader_id, s?.serial ?? null, reader.created_at, inUse])
    if (r.length) {
      moved++
      logger.info({ orderId: o.id, readerId: reader.stripe_reader_id, inUse }, '[reader-order] matched to its reader')
    }
  }
  // 10/5: an order matched after a month has turned owes that month's piece now
  // ("the first of each month following shipment", Nic) — the monthly job only
  // runs on the 1st, so without this a reader that shipped in September and was
  // matched in October waited until November and was charged two pieces at once.
  if (moved) await raiseDueInstallments()
  return moved
}
