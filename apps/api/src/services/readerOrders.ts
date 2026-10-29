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
  SUPPORTED_CARD_READER, installmentSplit, readerCostTotal, readerOrderMoney,
  READER_BOOK_REFERENCE, readerBookRows, readerBookTotals, readerEntryInForce,
  type ReaderCostParts, type ReaderPieceBilled, type ReaderBookRowKind,
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
 * 10/13 (review): the moment GAM bought an order from Stripe's shop — marked
 * Ordered, or (when the desk skipped Ordered) the first step after it.
 */
const READER_BOUGHT_AT_SQL = (o: string) => `COALESCE(${o}.ordered_at, ${o}.shipped_at, ${o}.delivered_at, ${o}.registered_at)`

/**
 * 10/13 (review): an order GAM has bought from Stripe's shop — ordered or
 * further along, or cancelled after it was ordered or shipped. Not a request
 * nobody ordered, nor one cancelled before anyone did. (An order moved back
 * to Requested loses its dates, so it is not bought — adminUpdateReaderOrder.)
 */
const READER_BOUGHT_SQL = (o: string) => `(${o}.status IN ('ordered','shipped','delivered','registered')
  OR (${o}.status = 'cancelled' AND ${READER_BOUGHT_AT_SQL(o)} IS NOT NULL))`

/** The one 8:05 morning admin email's category (10/13 evening: card readers and the credit chain check). */
export const MORNING_ADMIN_EMAIL_CATEGORY = 'morning_admin_email'

/**
 * The 8:05 morning admin email (the scheduler's '5 8 * * *'): ONE email while
 * anything is waiting on GAM.
 *
 *   requested            → nobody has ordered it yet (every day until they do)
 *   ordered, no reader   → after 3 days: has Stripe shipped it?
 *   shipped, never online→ after 10 days: did it arrive, is it plugged in?
 *   bought, no cost      → (10/13) every day until GAM's cost is on the desk
 *   credit chains        → (10/13 evening, Nic: "Broken credit chain: fold into
 *                          the 8:05 MORNING admin email (not its own 3 am
 *                          email)") each chain last night's check found broken,
 *                          or that the check did not run
 *                          (creditChainCheck.creditChainMorningSection)
 *
 * One digest, not one email per order (S652: one email per thing), counting
 * orders — one order can be on two lines (not in use yet, and no cost). Silent
 * when nothing waits and every chain was checked whole. `waiting` counts the
 * reader orders; `sent` says whether the email went out.
 *
 * 10/13 (review): the two parts never wait on each other. Last night's chain
 * check is read first (it never throws), and the card reader part is guarded:
 * a reader query, Stripe or a reader's order that cannot be checked no longer
 * stops the email — the chains still go out, and the email says the card
 * reader check could not run (with why). One property Stripe cannot be asked
 * about never hides the others.
 */
export async function chaseReaderOrders(now: Date = new Date()): Promise<{ waiting: number; sent: boolean }> {
  // 10/13 evening (Nic): "Broken credit chain: fold into the 8:05 MORNING admin
  // email (not its own 3 am email)." What last night's check found, first: a
  // broken chain is the more serious news, and it is read before anything of
  // the readers can go wrong.
  const { creditChainMorningSection } = await import('./creditChainCheck')
  const chains = await creditChainMorningSection()
  let readers: { lines: string[]; waitingOrders: Set<string>; failed: string | null }
  try {
    readers = { ...(await readerMorningLines(now)), failed: null }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    logger.error({ err: e }, '[reader-order] the card reader part of the morning admin email could not run')
    readers = {
      lines: [`CARD READERS NOT CHECKED — this morning's card reader check stopped before it finished: ${why}. `
        + 'Open Reader Orders to see what is waiting. The check runs again tomorrow morning.'],
      waitingOrders: new Set(), failed: why,
    }
  }
  const { lines, waitingOrders } = readers
  if (!lines.length && !chains.lines.length) return { waiting: 0, sent: false }
  const n = waitingOrders.size
  await createAdminNotification({
    severity: chains.outcome === 'broken' ? 'critical' : 'warn', category: MORNING_ADMIN_EMAIL_CATEGORY, emailSuperAdmins: true,
    title: [
      chains.title,
      n ? `${n} card reader order${n === 1 ? '' : 's'} waiting on GAM` : null,
      readers.failed ? 'The card reader check did not run this morning' : null,
    ].filter(Boolean).join(' · '),
    body: [...chains.lines, ...lines].join('\n'),
    context: {
      ...(n ? { count: n } : {}),
      ...(chains.context ? { creditChains: chains.context } : {}),
      ...(readers.failed ? { readerCheck: { failed: readers.failed } } : {}),
    },
    ...(n || readers.failed ? { action: { label: 'Open Reader Orders', url: `${portalUrl('admin')}/reader-orders` } } : {}),
  })
  return { waiting: n, sent: true }
}

/**
 * The card reader part of the 8:05 morning admin email (chaseReaderOrders):
 * one line per thing waiting on GAM, and the orders they are about. Throws when
 * it cannot finish (the caller says so in the email).
 */
async function readerMorningLines(now: Date): Promise<{ lines: string[]; waitingOrders: Set<string> }> {
  // 10/12 (review): every morning, not only on the 1st, a piece the code before
  // 10/12 raised with no order named is tied to its order (linkUnlinkedReaderPieces),
  // so the desk and the GAM-money bridge never miss it for a month.
  // 10/13 (Nic, full purchase): and every reader is put into GAM's book
  // (bookReaderBook) — a reader marked bought, a row the ledger missed — so
  // nothing waits for the 1st.
  try {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await linkUnlinkedReaderPieces(c)
      await bookReaderBook(c)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  } catch (e) { logger.warn({ err: e }, "[reader-order] could not link pieces raised before 10/12 or book readers in GAM's book — the next run tries again") }
  // 10/5 (Nic): "the card reader arrived on Friday and it's been set up and
  // used for several days... the system should be detecting that it's already
  // active and in use." Ask the readers before asking a person: every property
  // with an order GAM has placed is checked at Stripe first (and against the
  // readers already on file if Stripe can't be reached), so an order whose
  // reader is plugged in and working never makes this list. (10/13 review) A
  // property that cannot be checked is skipped, not the whole email: its order
  // may be asked about a day early.
  const placed = await query<{ landlord_id: string; property_id: string }>(
    `SELECT DISTINCT landlord_id, property_id FROM pos_reader_orders WHERE status IN ('ordered','shipped','delivered')`)
  for (const o of placed) {
    try { await syncReadersFromStripe(o.landlord_id, o.property_id) } catch (e) {
      logger.warn({ err: e, propertyId: o.property_id }, "[reader-order] could not check a property's readers for the morning email — its orders are listed as they stand")
    }
  }
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
  // billing and none of the reader (its purchase, its pieces) goes into GAM's
  // book until the cost is known (bookReaderBook).
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
  return { lines, waitingOrders }
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
// markup is GAM's earnings ('device_markup'), booked piece by piece when the
// piece carrying it is billed — the way a platform fee is booked when it is
// billed.
//
// 10/13 (Nic): "record each reader as a GAM expense (loss if cost > charge);
// allow dated cost corrections; flag missing cost in the morning admin email."
// Every cost entry is dated (effective_on): the first, the day GAM bought the
// reader; a later one is a correction (a refund, extra shipping) that applies
// from its own date, the figure before it kept on record.
//
// 10/13 (Nic, afternoon): FULL PURCHASE — "Book the $331.73 as an expense the
// day we buy it, and each $87.50 payment as paying it back (lowers 'earned all
// time' until repaid)." bookReaderBook puts every reader GAM bought into GAM's
// own book (platform_revenue_ledger, @gam/shared readerBookRows):
//   - the purchase, an expense (below zero), the day GAM bought it — typed
//     'adjustment', referenced to its cost entry ('reader_purchase'); a dated
//     correction books the difference on its own date, every earlier row kept;
//   - each piece, as it is billed, cost first: the part paying the cost back
//     ('adjustment', 'reader_cost_repaid', referenced to the piece), then the
//     markup beyond it ('device_markup', as since 10/12) — split under the
//     cost in force the day the piece was billed.
// A reader that cost GAM more than it charges stays below zero by the loss
// once its last piece is billed. Nothing booked is ever rewritten. The
// GAM-money bridge adds the purchase back on its own line — GAM paid Stripe's
// shop for it, not from the Stripe balance (services/stripeCosts,
// readerBookFacts).

/** The order's current cost: its latest entry. Use as `LEFT JOIN LATERAL (${LATEST_READER_COST_SQL('o')}) c ON TRUE`. */
const LATEST_READER_COST_SQL = (order: string) => `
  SELECT x.id, x.base_price, x.tax_amount, x.shipping_amount, x.tax_and_shipping_amount, x.total_cost,
         x.created_at, x.source, to_char(x.effective_on, 'YYYY-MM-DD') AS effective_on
    FROM pos_reader_order_costs x WHERE x.reader_order_id = ${order}.id ORDER BY x.seq DESC LIMIT 1`

const centsOf = (n: unknown) => Math.round(Number(n ?? 0) * 100)
const num = (n: unknown) => (n == null ? null : Number(n))

/**
 * 10/13: every row GAM's own book holds for one reader order — (afternoon,
 * Nic: full purchase) the purchase and each correction of it, and each piece's
 * cost repaid and markup. `kind` is a READER_BOOK_ROW_KINDS value. `voided`
 * names a row whose piece was voided after it was booked: the row is still in
 * the book. `resplit` (10/13 evening, Nic: "Redo the split"): the difference
 * booked when the piece was split again under a corrected cost.
 */
const ORDER_BOOK_ROWS_SQL = (orderRef: string) => `
  SELECT r.id, r.amount, r.created_at, r.notes, g.installment_number AS n, (g.voided_at IS NOT NULL) AS voided,
         CASE WHEN r.type = 'device_markup' THEN 'markup' ELSE 'cost_repaid' END AS kind, FALSE AS resplit
    FROM platform_revenue_ledger r
    JOIN landlord_gam_charges g ON g.id = r.reference_id
   WHERE ((r.type = 'device_markup' AND r.reference_type = 'reader_order_installment')
       OR (r.type = 'adjustment' AND r.reference_type = '${READER_BOOK_REFERENCE.costRepaid}'))
     AND g.reader_order_id = ${orderRef}
  UNION ALL
  -- 10/13 evening (Nic: "Redo the split"): a piece split again under a later cost.
  SELECT r.id, r.amount, r.created_at, r.notes, g.installment_number AS n, (g.voided_at IS NOT NULL) AS voided,
         CASE WHEN r.type = 'device_markup' THEN 'markup' ELSE 'cost_repaid' END AS kind, TRUE AS resplit
    FROM platform_revenue_ledger r
    JOIN pos_reader_order_resplits s ON s.id = r.reference_id
    JOIN landlord_gam_charges g ON g.id = s.charge_id
   WHERE ((r.type = 'device_markup' AND r.reference_type = '${READER_BOOK_REFERENCE.resplit}')
       OR (r.type = 'adjustment' AND r.reference_type = '${READER_BOOK_REFERENCE.costRepaid}'))
     AND s.reader_order_id = ${orderRef}
  UNION ALL
  SELECT r.id, r.amount, r.created_at, r.notes, NULL::smallint AS n, FALSE AS voided, 'purchase' AS kind, FALSE AS resplit
    FROM platform_revenue_ledger r
    JOIN pos_reader_order_costs c ON c.id = r.reference_id
   WHERE r.type = 'adjustment' AND r.reference_type = '${READER_BOOK_REFERENCE.purchase}'
     AND c.reader_order_id = ${orderRef}`

/**
 * 10/13 (Nic, full purchase): the moment a cost entry is booked at — on its
 * own day (effective_on, GAM's calendar). The first entry: the moment GAM
 * bought the reader (READER_BOUGHT_AT_SQL) when that is the day; any entry:
 * the moment it was typed when that is the day; else noon on the day. A first
 * entry is never typed before the order is bought (recordReaderOrderCost), and
 * its date is the day GAM bought it unless the desk typed another. Migration
 * 20261015160000 dates its backfill the same way.
 */
const READER_COST_BOOKED_AT_SQL = (c: string, o: string, firstSeq: string) => `
  CASE WHEN ${c}.seq = ${firstSeq} AND ${READER_BOUGHT_AT_SQL(o)} IS NOT NULL
             AND (${READER_BOUGHT_AT_SQL(o)} AT TIME ZONE '${GAM_TZ}')::date = ${c}.effective_on THEN ${READER_BOUGHT_AT_SQL(o)}
       WHEN (${c}.created_at AT TIME ZONE '${GAM_TZ}')::date = ${c}.effective_on THEN ${c}.created_at
       ELSE (${c}.effective_on + time '12:00') AT TIME ZONE '${GAM_TZ}' END`

/** "$331.73 (base $299.00, tax and shipping $32.73)" — a cost entry in words, for its book row. */
function costInWords(e: { total_cost: unknown; base_price: unknown; tax_amount: unknown; shipping_amount: unknown; tax_and_shipping_amount: unknown }): string {
  const d = (n: unknown) => `$${Number(n).toFixed(2)}`
  const parts = [`base ${d(e.base_price)}`]
  if (e.tax_and_shipping_amount != null) parts.push(`tax and shipping ${d(e.tax_and_shipping_amount)}`)
  if (e.tax_amount != null) parts.push(`tax ${d(e.tax_amount)}`)
  if (e.shipping_amount != null) parts.push(`shipping ${d(e.shipping_amount)}`)
  return `${d(e.total_cost)} (${parts.join(', ')})`
}

/**
 * GAM's desk: every order, newest first, with the location Stripe's shop needs
 * — and (10/12) GAM's cost, the price charged, the markup, every cost entry
 * made, and each piece of the plan split cost first. (10/13) The cost's date
 * (the day GAM bought it, or the day a correction applies from), the loss when
 * the reader cost GAM more than it charges, and every row GAM's own book holds
 * for the reader — (afternoon, Nic: full purchase) the purchase as GAM's
 * expense, each piece's cost repaid and markup, what the reader still owes
 * GAM's book, and anything GAM's records say should be in the book and is not
 * (a row the ledger missed, until the next run writes it). `orderId` reads one.
 */
export async function adminListReaderOrders(orderId?: string) {
  const rows = await query<any>(
    `SELECT o.*, p.name AS property_name, p.stripe_terminal_location_id, l.business_name,
            u.email AS landlord_email,
            c.base_price AS cost_base_price, c.tax_amount AS cost_tax, c.shipping_amount AS cost_shipping,
            c.tax_and_shipping_amount AS cost_tax_and_shipping, c.total_cost AS cost_total,
            c.created_at AS cost_entered_at, c.effective_on AS cost_effective_on,
            ${READER_BOUGHT_SQL('o')} AS bought,
            -- The moment GAM bought it: the desk's date for its first cost entry.
            ${READER_BOUGHT_AT_SQL('o')} AS bought_at,
            -- A demo or GAM-internal account's reader is never in GAM's book (the ledger's own rule).
            ${realLandlordSql('p.landlord_id')} AS in_gams_book,
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
                        'id', g.id, 'n', g.installment_number, 'amount', g.amount, 'collected', g.collected_amount,
                        'voided', g.voided_at IS NOT NULL, 'billed_at', g.created_at,
                        'billed_on', to_char(g.created_at AT TIME ZONE '${GAM_TZ}', 'YYYY-MM-DD'))
                        ORDER BY g.installment_number)
                        FROM landlord_gam_charges g WHERE g.reader_order_id = o.id), '[]'::json) AS pieces_billed,
            COALESCE((SELECT json_agg(json_build_object(
                        'id', b.id, 'kind', b.kind, 'amount', b.amount, 'at', b.created_at, 'notes', b.notes,
                        'n', b.n, 'voided', b.voided, 'resplit', b.resplit)
                        -- Pieces billed together in their order; a piece's cost repaid
                        -- before its markup (they share a moment).
                        ORDER BY b.created_at, b.n NULLS FIRST, CASE b.kind WHEN 'purchase' THEN 0 WHEN 'cost_repaid' THEN 1 ELSE 2 END, b.id)
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
    const billed: Array<ReaderPieceBilled & { id: string; billed_at: string; billed_on: string }> =
      (r.pieces_billed ?? []).map((g: any) => ({
        id: g.id, n: Number(g.n), amount: Number(g.amount), collected: Number(g.collected), voided: !!g.voided,
        billed_at: g.billed_at, billed_on: g.billed_on,
      }))
    const money = readerOrderMoney({
      price: Number(r.price), installments: Number(r.installments), totalCost: num(r.cost_total), pieces: billed,
    })
    const book: Array<{ id: string; kind: ReaderBookRowKind; at: string; amount: number; notes: string | null; n: number | null; voided: boolean; resplit: boolean }> =
      (r.book_rows ?? []).map((b: any) => ({
        id: b.id, kind: b.kind, at: b.at, amount: Number(b.amount), notes: b.notes ?? null,
        n: b.n == null ? null : Number(b.n), voided: !!b.voided, resplit: !!b.resplit,
      }))
    const all = readerBookTotals(book)
    const live = readerBookTotals(book.filter(b => !b.voided))
    // 10/13 (Nic, full purchase): what GAM's records say the book should hold
    // for this reader (@gam/shared readerBookRows, the rule bookReaderBook
    // books by) — set against the rows it holds for pieces not voided.
    const expected = r.in_gams_book && money.totalCost != null
      ? readerBookTotals(readerBookRows({
          price: Number(r.price), installments: Number(r.installments), bought: !!r.bought,
          entries: [...(r.cost_history ?? [])].reverse().map((h: any) => ({ total: Number(h.total), effectiveOn: h.effective_on })),
          pieces: billed.map(g => ({ n: g.n, amount: g.amount, billedOn: g.billed_on, voided: g.voided })),
        }))
      : null
    const rowsFor = (n: number, kind: ReaderBookRowKind) =>
      book.filter(b => b.n === n && b.kind === kind).reduce((a, b) => a + centsOf(b.amount), 0) / 100
    const notBookedCents = expected ? centsOf(expected.net) - centsOf(live.net) : 0
    // What of GAM's cost the pieces billed have not repaid yet (a reader GAM bought).
    const unrepaid = r.bought && money.totalCost != null
      ? Math.max(0, centsOf(money.totalCost) - centsOf(live.costRepaid)) / 100 : null
    // 10/13 (review): a plan cancelled after GAM bought the reader bills
    // nothing more (raiseDueInstallments) — what its pieces did not repay is
    // never repaid. It is the reader's loss (10/13, Nic: "loss if cost >
    // charge" — the charge being what was billed before the cancel), not
    // "still to be repaid". A refund typed as a dated correction gives some back.
    const cancelled = r.status === 'cancelled'
    const { pieces_billed: _omit, book_rows: _omitBook, ...row } = r
    return {
      ...row,
      cost_base_price: num(r.cost_base_price), cost_tax: num(r.cost_tax), cost_shipping: num(r.cost_shipping),
      cost_tax_and_shipping: num(r.cost_tax_and_shipping), cost_total: num(r.cost_total),
      // 10/13: the reader is in GAM's book — a new entry is a dated correction
      // from here (it applies from its own date; the booked rows stay).
      cost_booked: book.length > 0,
      charged: money.charged,
      markup: money.markup,
      loss: cancelled && unrepaid != null ? unrepaid : money.loss,
      markup_billed: money.markupBilled,
      markup_collected: money.markupCollected,
      markup_not_collected: money.markupNotCollected,
      cost_recovered: money.costRecovered,
      billed: money.billed,
      collected: money.collected,
      // 10/13 (Nic, full purchase): what GAM's own book holds for the reader,
      // kind by kind — every row, a voided piece's too (it stays in the book;
      // voids are the ledger's P0 work), so the desk says what the book says.
      purchase_booked: all.purchase,
      cost_repaid_booked: all.costRepaid,
      markup_booked: all.markup,
      booked_total: all.net,
      // What the purchase still waits on: GAM's cost less the cost repaid so far
      // (billed). After the last piece, a loss is what stays — and on a
      // cancelled plan, nothing more is coming (`loss` holds it).
      still_to_repay: unrepaid == null ? null : cancelled ? 0 : unrepaid,
      // GAM's records against the book: $0.00 unless a row is missing (the
      // ledger writes best-effort; the next run of bookReaderBook writes it).
      not_booked: notBookedCents / 100,
      // 10/13 (review): the book's split against GAM's records — what of the
      // cost repaid the book holds as markup (below zero: the other way) while
      // nothing is missing. A split again under a figure it was already split
      // under is never booked twice (bookReaderResplits), so the morning run
      // leaves this for a person; it nets to $0.00, so `not_booked` never shows it.
      split_not_booked: expected && notBookedCents === 0
        ? (centsOf(expected.costRepaid) - centsOf(live.costRepaid)) / 100 : 0,
      book,
      // Every piece of the plan, cost first under the current cost, and where
      // each stands — with what GAM's book holds for it.
      pieces: money.split.map(s => {
        const b = billed.find(g => g.n === s.n)
        return {
          n: s.n, amount: s.amount, cost: s.cost, markup: s.markup,
          billed: !!b && !b.voided, voided: !!b?.voided, billed_at: b?.billed_at ?? null,
          collected: b?.collected ?? 0,
          cost_repaid_booked: rowsFor(s.n, 'cost_repaid'), markup_booked: rowsFor(s.n, 'markup'),
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
 * reader. A piece billed on or after its date is split under it.
 *
 * 10/13 (Nic, full purchase): the entry goes into GAM's own book at once
 * (bookReaderBook) — the first as the purchase, GAM's expense, on its date; a
 * correction as the difference, on its own date (a refund gives some back,
 * extra shipping takes more). Nothing already booked is rewritten.
 *
 * 10/13 (review): only for a reader GAM has bought (READER_BOUGHT_SQL). The
 * cost is the shop receipt — "the day we buy it" (Nic) is the purchase's date —
 * so a cost typed on a request nobody has ordered would date the purchase
 * before GAM bought anything (typed 9/30, ordered 10/2: an expense in
 * September). Refused (409): mark it Ordered first.
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
    const o = (await client.query<{ id: string; status: string; created_at: Date; bought_at: Date | null; bought: boolean }>(
      `SELECT o.id, o.status, o.created_at, ${READER_BOUGHT_AT_SQL('o')} AS bought_at, ${READER_BOUGHT_SQL('o')} AS bought
         FROM pos_reader_orders o WHERE o.id = $1 FOR UPDATE OF o`, [orderId])).rows[0]
    if (!o) throw new AppError(404, 'Reader order not found')
    if (!o.bought) {
      throw new AppError(409, o.status === 'cancelled'
        ? 'This request was cancelled before anyone ordered it from Stripe — GAM paid nothing for it, so there is no cost to enter.'
        : "This reader has not been ordered from Stripe yet. Mark it Ordered first, then type the shop receipt — it goes into GAM's book the day GAM bought the reader.")
    }
    const cur = (await client.query<{ effective_on: string }>(
      `SELECT to_char(effective_on, 'YYYY-MM-DD') AS effective_on FROM pos_reader_order_costs
        WHERE reader_order_id = $1 ORDER BY seq DESC LIMIT 1`, [orderId])).rows[0]
    effectiveOn ??= cur ? today : (o.bought_at ? dateIn(GAM_TZ, new Date(o.bought_at)) : today)
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
    // The entry into GAM's book; and a reader that shipped (and billed
    // pieces) before its cost was typed: its pieces now.
    await bookReaderBook(client, orderId)
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
 * 10/13 (Nic, afternoon): FULL PURCHASE — "Book the $331.73 as an expense the
 * day we buy it, and each $87.50 payment as paying it back (lowers 'earned all
 * time' until repaid)." Put every reader into GAM's own book
 * (platform_revenue_ledger) as @gam/shared readerBookRows says it should be,
 * writing only what is not there yet:
 *
 *   - the purchase (an order GAM bought — READER_BOUGHT_SQL): each cost entry,
 *     once — the first as minus its total, a correction as minus the change —
 *     'adjustment' referenced to the entry ('reader_purchase'), dated on the
 *     entry's day (READER_COST_BOOKED_AT_SQL);
 *   - each billed piece, once, under the cost in force the day it was billed,
 *     cost first (10/12, Q-g): the cost repaid ('adjustment' referenced to the
 *     piece, 'reader_cost_repaid') and the markup beyond the cost
 *     ('device_markup', 'reader_order_installment'), dated the day it was
 *     billed. A piece is booked as a whole: once it has one of its rows, the
 *     other is only what is left of the piece — so a piece whose markup the
 *     10/12 code booked gets its cost repaid as the rest of it, and a
 *     correction dated back over a piece already booked never books it twice.
 *
 * An order with no cost entered books nothing (until GAM's cost is known no
 * dollar of it can be split; the morning email chases the cost). A demo or
 * GAM-internal account's reader is never in GAM's book (the ledger's own rule),
 * so it is left out here too. Voided pieces are not booked. A row once booked is
 * never rewritten. Idempotent (the ledger refuses a second row of a kind for
 * one reference). Runs inside the caller's transaction. Each order row is
 * locked before its cost is read (10/12 review): a cost entry locks it too
 * (recordReaderOrderCost, pos_reader_order_costs_lock), so nothing is booked
 * from a cost a concurrent entry is replacing.
 *
 * Returns how many rows it wrote.
 */
export async function bookReaderBook(client: PoolClient, orderId?: string): Promise<number> {
  const orders = await client.query<any>(
    `SELECT o.id, o.price, o.installments, o.property_id, p.name AS property_name, ${READER_BOUGHT_SQL('o')} AS bought
       FROM pos_reader_orders o
       JOIN properties p ON p.id = o.property_id
      WHERE ($1::uuid IS NULL OR o.id = $1::uuid)
        AND ${realLandlordSql('p.landlord_id')}
        AND EXISTS (SELECT 1 FROM pos_reader_order_costs x WHERE x.reader_order_id = o.id)
        AND (${READER_BOUGHT_SQL('o')} OR EXISTS (SELECT 1 FROM landlord_gam_charges g WHERE g.reader_order_id = o.id))
      ORDER BY o.id
      FOR UPDATE OF o`,
    [orderId ?? null])
  let booked = 0
  for (const o of orders.rows) {
    const price = Number(o.price), installments = Number(o.installments)
    const entries = (await client.query<any>(
      `SELECT c.id, c.total_cost, c.base_price, c.tax_amount, c.shipping_amount, c.tax_and_shipping_amount, c.note,
              to_char(c.effective_on, 'YYYY-MM-DD') AS effective_on,
              ${READER_COST_BOOKED_AT_SQL('c', 'o', 'f.seq')} AS booked_at,
              EXISTS (SELECT 1 FROM platform_revenue_ledger r
                       WHERE r.type = 'adjustment' AND r.reference_type = '${READER_BOOK_REFERENCE.purchase}'
                         AND r.reference_id = c.id) AS in_book
         FROM pos_reader_order_costs c
         JOIN pos_reader_orders o ON o.id = c.reader_order_id
         CROSS JOIN LATERAL (SELECT MIN(seq) AS seq FROM pos_reader_order_costs WHERE reader_order_id = c.reader_order_id) f
        WHERE c.reader_order_id = $1
        ORDER BY c.seq`, [o.id])).rows
    const pieces = (await client.query<any>(
      `SELECT g.id, g.installment_number AS n, g.amount, g.created_at AS billed_at,
              to_char(g.created_at AT TIME ZONE '${GAM_TZ}', 'YYYY-MM-DD') AS billed_on,
              (SELECT SUM(r.amount) FROM platform_revenue_ledger r
                WHERE r.type = 'adjustment' AND r.reference_type = '${READER_BOOK_REFERENCE.costRepaid}'
                  AND r.reference_id = g.id) AS cost_repaid_booked,
              (SELECT SUM(r.amount) FROM platform_revenue_ledger r
                WHERE r.type = 'device_markup' AND r.reference_type = 'reader_order_installment'
                  AND r.reference_id = g.id) AS markup_booked
         FROM landlord_gam_charges g
        WHERE g.reader_order_id = $1 AND g.voided_at IS NULL AND g.installment_number IS NOT NULL
        ORDER BY g.installment_number`, [o.id])).rows
    const rows = readerBookRows({
      price, installments, bought: !!o.bought,
      entries: entries.map((e: any) => ({ id: e.id, total: Number(e.total_cost), effectiveOn: e.effective_on })),
      pieces: pieces.map((g: any) => ({ id: g.id, n: Number(g.n), amount: Number(g.amount), billedOn: g.billed_on })),
    })
    const dollars = (n: number) => `$${n.toFixed(2)}`
    // The purchase, entry by entry.
    for (const row of rows.filter(x => x.kind === 'purchase')) {
      const e = entries.find((x: any) => x.id === row.ref)
      if (!e || e.in_book) continue
      await recordPlatformRevenue({
        type: 'adjustment', amount: row.amount,
        referenceId: e.id, referenceType: READER_BOOK_REFERENCE.purchase, propertyId: o.property_id,
        notes: row.previousCost == null
          ? `Card reader bought — ${o.property_name}: GAM's cost ${costInWords(e)}`
          : `Card reader cost corrected — ${o.property_name}: ${dollars(row.previousCost)} → ${costInWords(e)} from ${e.effective_on}`
            + `${e.note ? ` (${e.note})` : ''} — ${row.amount > 0 ? `${dollars(row.amount)} back to GAM` : `${dollars(-row.amount)} more`}`,
        at: e.booked_at,
      }, client)
      booked++
    }
    // Each piece, as a whole (see above), under the cost in force the day it was billed.
    for (const g of pieces) {
      const split = rows.filter(x => x.ref === g.id && !x.resplit)
      const amountC = centsOf(g.amount)
      const repaidC = g.cost_repaid_booked == null ? null : centsOf(g.cost_repaid_booked)
      const markupC = g.markup_booked == null ? null : centsOf(g.markup_booked)
      const n = Number(g.n)
      const cost = split[0]?.cost ?? null
      const want = (kind: ReaderBookRowKind) => centsOf(split.find(x => x.kind === kind)?.amount ?? 0)
      const repaid = repaidC != null ? 0 : markupC != null ? amountC - markupC : want('cost_repaid')
      const markup = markupC != null ? 0 : repaidC != null ? amountC - repaidC : want('markup')
      if (repaid > 0) {
        await recordPlatformRevenue({
          type: 'adjustment', amount: repaid / 100,
          referenceId: g.id, referenceType: READER_BOOK_REFERENCE.costRepaid, propertyId: o.property_id,
          notes: `Card reader cost repaid — ${o.property_name}, payment ${n} of ${installments}`
            + ` (${dollars(repaid / 100)}${cost != null ? ` of GAM's ${dollars(cost)} cost` : ''})`,
          at: g.billed_at,
        }, client)
        booked++
      }
      if (markup > 0) {
        await recordPlatformRevenue({
          type: 'device_markup', amount: markup / 100,
          referenceId: g.id, referenceType: 'reader_order_installment', propertyId: o.property_id,
          notes: `Card reader markup — ${o.property_name}, payment ${n} of ${installments} `
            + `(charged ${dollars(price)}${cost != null ? `, GAM's cost ${dollars(cost)}` : ''})`,
          at: g.billed_at,
        }, client)
        booked++
      }
    }
    // 10/13 evening (Nic: "Redo the split"): each piece split again under every
    // correction dated after it was billed — and, for a correction dated back
    // over a piece already booked under the figure before it, under the figure
    // it should have been booked under.
    if (pieces.length) booked += await bookReaderResplits(client, { o, entries, pieces, rows, installments })
  }
  if (booked) logger.info({ booked, orderId: orderId ?? null }, "[reader-order] booked in GAM's book")
  return booked
}

/**
 * 10/13 evening (Nic): "Redo the split" — a cost correction after pieces are
 * booked REDOES the split, as a dated correction. For one order (inside
 * bookReaderBook, its row locked), after its pieces' own rows are booked:
 *
 *   - each re-split readerBookRows lists (`resplitUnder`: a correction dated
 *     after the piece was billed) is booked once, ON THE CORRECTION'S DAY (the
 *     moment its purchase row is booked at, READER_COST_BOOKED_AT_SQL): the
 *     cost-repaid difference ('adjustment', 'reader_cost_repaid') and the
 *     markup difference ('device_markup', 'reader_resplit'), both referenced to
 *     the re-split (pos_reader_order_resplits: the piece and the correction);
 *   - then whatever still differs between what the book holds for the piece
 *     and its split under the order's latest cost — a piece booked under the
 *     figure before a correction dated back over the day it was billed (one
 *     typed later, with an earlier date) — is booked as the re-split under the
 *     figure in force the day it was billed, dated that correction's day, or
 *     the day the piece was billed when that is later (never before the piece).
 *
 * The rows booked before stay as they were, and a piece's own rows stay dated
 * the day it was billed. Each kind of each re-split is booked once (the ledger
 * refuses a second); a row a run could not write is written by the next.
 * Returns how many rows it wrote.
 */
async function bookReaderResplits(client: PoolClient, a: {
  o: { id: string; property_id: string; property_name: string }
  entries: Array<{ id: string; effective_on: string; booked_at: Date; total_cost: unknown }>
  pieces: Array<{ id: string; n: unknown; billed_on: string; billed_at: Date }>
  rows: ReturnType<typeof readerBookRows>
  installments: number
}): Promise<number> {
  const { o, entries, pieces, rows, installments } = a
  const dollars = (n: number) => `$${n.toFixed(2)}`
  // What the book holds for each piece now: its own rows, and each re-split's (by the entry it is under).
  const held = new Map((await client.query<{ id: string; own_repaid: string | null; own_markup: string | null }>(
    `SELECT g.id,
            (SELECT SUM(r.amount) FROM platform_revenue_ledger r
              WHERE r.type = 'adjustment' AND r.reference_type = '${READER_BOOK_REFERENCE.costRepaid}' AND r.reference_id = g.id) AS own_repaid,
            (SELECT SUM(r.amount) FROM platform_revenue_ledger r
              WHERE r.type = 'device_markup' AND r.reference_type = 'reader_order_installment' AND r.reference_id = g.id) AS own_markup
       FROM landlord_gam_charges g WHERE g.id = ANY($1::uuid[])`, [pieces.map(g => g.id)])).rows.map(r => [r.id, r]))
  const resplits = (await client.query<{ id: string; charge_id: string; cost_id: string; repaid: string | null; markup: string | null }>(
    `SELECT s.id, s.charge_id, s.cost_id,
            (SELECT SUM(r.amount) FROM platform_revenue_ledger r
              WHERE r.type = 'adjustment' AND r.reference_type = '${READER_BOOK_REFERENCE.costRepaid}' AND r.reference_id = s.id) AS repaid,
            (SELECT SUM(r.amount) FROM platform_revenue_ledger r
              WHERE r.type = 'device_markup' AND r.reference_type = '${READER_BOOK_REFERENCE.resplit}' AND r.reference_id = s.id) AS markup
       FROM pos_reader_order_resplits s WHERE s.reader_order_id = $1`, [o.id])).rows
  let wrote = 0

  /** The re-split row for this piece and entry (made the first time it is needed). */
  const resplitId = async (chargeId: string, costId: string): Promise<string> => {
    const have = resplits.find(s => s.charge_id === chargeId && s.cost_id === costId)
    if (have) return have.id
    const id = (await client.query<{ id: string }>(
      `WITH ins AS (
         INSERT INTO pos_reader_order_resplits (reader_order_id, charge_id, cost_id) VALUES ($1, $2, $3)
         ON CONFLICT (charge_id, cost_id) DO NOTHING RETURNING id)
       SELECT id FROM ins UNION ALL SELECT id FROM pos_reader_order_resplits WHERE charge_id = $2 AND cost_id = $3 LIMIT 1`,
      [o.id, chargeId, costId])).rows[0].id
    resplits.push({ id, charge_id: chargeId, cost_id: costId, repaid: null, markup: null })
    return id
  }

  /** Book one re-split's two differences (cents, signed), each only if that kind is not booked for it yet. */
  const book = async (g: typeof pieces[number], e: typeof entries[number], d: { repaid: number; markup: number },
    words: { cost: number; previousCost: number | null }, at: Date) => {
    if (d.repaid === 0 && d.markup === 0) return
    const id = await resplitId(g.id, e.id)
    const s = resplits.find(x => x.id === id)!
    const n = Number(g.n)
    const head = `Card reader cost corrected — ${o.property_name}: payment ${n} of ${installments} split again under GAM's `
      + `${dollars(words.cost)} cost${words.previousCost != null ? ` (was ${dollars(words.previousCost)})` : ''} from ${e.effective_on}`
    if (d.repaid !== 0 && s.repaid == null) {
      await recordPlatformRevenue({
        type: 'adjustment', amount: d.repaid / 100,
        referenceId: id, referenceType: READER_BOOK_REFERENCE.costRepaid, propertyId: o.property_id,
        notes: `${head} — ${dollars(Math.abs(d.repaid) / 100)} ${d.repaid > 0 ? 'more' : 'less'} cost repaid`,
        at,
      }, client)
      s.repaid = (d.repaid / 100).toFixed(2)
      wrote++
    }
    if (d.markup !== 0 && s.markup == null) {
      await recordPlatformRevenue({
        type: 'device_markup', amount: d.markup / 100,
        referenceId: id, referenceType: READER_BOOK_REFERENCE.resplit, propertyId: o.property_id,
        notes: `${head} — ${dollars(Math.abs(d.markup) / 100)} ${d.markup > 0 ? 'more' : 'less'} markup`,
        at,
      }, client)
      s.markup = (d.markup / 100).toFixed(2)
      wrote++
    }
  }

  for (const g of pieces) {
    const mine = rows.filter(x => x.ref === g.id)
    // Every correction dated after the piece was billed, on its own day.
    for (const e of entries) {
      const redo = mine.filter(x => x.resplitUnder === e.id)
      if (!redo.length) continue
      const of = (kind: ReaderBookRowKind) => centsOf(redo.find(x => x.kind === kind)?.amount ?? 0)
      await book(g, e, { repaid: of('cost_repaid'), markup: of('markup') },
        { cost: redo[0].cost, previousCost: redo[0].previousCost ?? null }, e.booked_at)
    }
    // What still differs from the split under the order's latest cost: the
    // piece's own rows were booked under a figure a correction dated back over
    // its day replaced. Booked as the re-split under the figure in force that
    // day — never one already booked under it.
    const want = (kind: ReaderBookRowKind) => mine.filter(x => x.kind === kind).reduce((t, x) => t + centsOf(x.amount), 0)
    const h = held.get(g.id)
    const has = (kind: 'repaid' | 'markup') =>
      centsOf(kind === 'repaid' ? h?.own_repaid : h?.own_markup)
      + resplits.filter(s => s.charge_id === g.id).reduce((t, s) => t + centsOf(kind === 'repaid' ? s.repaid : s.markup), 0)
    const d = { repaid: want('cost_repaid') - has('repaid'), markup: want('markup') - has('markup') }
    if (d.repaid === 0 && d.markup === 0) continue
    // Nothing of the piece's own in the book (a write that failed): the next run books it whole.
    if (h?.own_repaid == null && h?.own_markup == null) continue
    const e = entries[readerEntryInForce(entries.map(x => ({ effectiveOn: x.effective_on })), g.billed_on)]
    // A kind already booked under that figure is never booked twice (book()
    // skips it): what is left of it is for a person. It nets to $0.00, so the
    // desk shows it as the split not in GAM's book (adminListReaderOrders
    // split_not_booked), not as a row missing (not_booked).
    const taken = resplits.find(s => s.charge_id === g.id && s.cost_id === e.id)
    if (taken && ((d.repaid !== 0 && taken.repaid != null) || (d.markup !== 0 && taken.markup != null))) {
      logger.warn({ orderId: o.id, pieceId: g.id, costId: e.id, d }, "[reader-order] a piece's split differs from its cost and the re-split under it is booked already — left for a person")
    }
    const at = new Date(Math.max(new Date(e.booked_at).getTime(), new Date(g.billed_at).getTime()))
    await book(g, e, d, { cost: Number(e.total_cost), previousCost: null }, at)
  }
  return wrote
}

/** What the GAM-money bridge needs about readers (readerBookFacts). */
export interface ReaderBookFacts {
  /** What GAM paid for the readers it bought — each one's current cost. The book holds it as an expense. */
  bought: number
  /** The pieces billed on them (not voided): the cost repaid and markup the book holds. */
  billed: number
  /** Of those pieces, collected. */
  collected: number
  /** Of what was collected, cost first: the cost coming back, and the markup. */
  costRepaidCollected: number
  markupCollected: number
}

/**
 * 10/13 (Nic, full purchase): what the GAM-money bridge needs about readers,
 * as GAM's records count them — the same orders and the same rule the book is
 * written by (bookReaderBook: readers with a cost entered, no demo or
 * GAM-internal account). Collected money is split cost first across each order:
 * the cost repaid before any of it is markup. A piece collected on a reader
 * outside these (no cost entered yet, a voided piece, a demo account's reader)
 * is not here; the bridge names it on its own line.
 */
export async function readerBookFacts(): Promise<ReaderBookFacts> {
  const orders = await query<any>(
    `SELECT o.price, o.installments, ${READER_BOUGHT_SQL('o')} AS bought,
            (SELECT json_agg(json_build_object('total', x.total_cost, 'effectiveOn', to_char(x.effective_on, 'YYYY-MM-DD'))
                             ORDER BY x.seq)
               FROM pos_reader_order_costs x WHERE x.reader_order_id = o.id) AS entries,
            COALESCE((SELECT json_agg(json_build_object('n', g.installment_number, 'amount', g.amount, 'collected', g.collected_amount,
                                                        'billedOn', to_char(g.created_at AT TIME ZONE '${GAM_TZ}', 'YYYY-MM-DD')))
                        FROM landlord_gam_charges g
                       WHERE g.reader_order_id = o.id AND g.voided_at IS NULL AND g.installment_number IS NOT NULL), '[]'::json) AS pieces
       FROM pos_reader_orders o
       JOIN properties p ON p.id = o.property_id
      WHERE ${realLandlordSql('p.landlord_id')}
        AND EXISTS (SELECT 1 FROM pos_reader_order_costs x WHERE x.reader_order_id = o.id)`)
  let boughtC = 0, billedC = 0, collectedC = 0, markupCollectedC = 0
  for (const o of orders) {
    const pieces = (o.pieces ?? []).map((g: any) => ({ n: Number(g.n), amount: Number(g.amount), billedOn: g.billedOn, collected: Number(g.collected) }))
    const t = readerBookTotals(readerBookRows({
      price: Number(o.price), installments: Number(o.installments), bought: !!o.bought,
      entries: (o.entries ?? []).map((e: any) => ({ total: Number(e.total), effectiveOn: e.effectiveOn })), pieces,
    }))
    const coll = pieces.reduce((a: number, g: any) => a + centsOf(g.collected), 0)
    boughtC -= centsOf(t.purchase)
    billedC += centsOf(t.costRepaid) + centsOf(t.markup)
    collectedC += coll
    markupCollectedC += Math.min(centsOf(t.markup), Math.max(0, coll - centsOf(t.costRepaid)))
  }
  return {
    bought: boughtC / 100, billed: billedC / 100, collected: collectedC / 100,
    costRepaidCollected: (collectedC - markupCollectedC) / 100, markupCollected: markupCollectedC / 100,
  }
}

const STATUS_STAMP: Record<string, string> = {
  ordered: 'ordered_at', shipped: 'shipped_at', delivered: 'delivered_at', registered: 'registered_at', cancelled: 'cancelled_at',
}

/**
 * GAM's desk moves an order along and records what Stripe said.
 *
 * 10/13 (review): back to Requested means nobody has ordered it — so it goes
 * back only while nothing of it is recorded: no cost typed (GAM's cost is in
 * GAM's book from the day GAM bought it, and a booked row is never rewritten)
 * and no payment billed. Refused (409) otherwise. Going back clears the dates
 * it was ordered, shipped, delivered, registered or cancelled, so the order is
 * not counted as bought (READER_BOUGHT_SQL), raises no payment, and the day it
 * is really ordered is the day stamped then.
 */
export async function adminUpdateReaderOrder(id: string, patch: {
  status?: string; stripeHardwareOrderId?: string | null; serial?: string | null; trackingUrl?: string | null; note?: string | null
}) {
  let cur: any, row: any
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Locked: a cost being typed (recordReaderOrderCost) waits for this, and this for it.
    cur = (await client.query(`SELECT * FROM pos_reader_orders WHERE id = $1 FOR UPDATE`, [id])).rows[0]
    if (!cur) throw new AppError(404, 'Reader order not found')
    const sets: string[] = ['updated_at = NOW()']; const vals: any[] = [id]
    const add = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
    if (patch.stripeHardwareOrderId !== undefined) add('stripe_hardware_order_id', patch.stripeHardwareOrderId)
    if (patch.serial !== undefined) add('serial', patch.serial)
    if (patch.trackingUrl !== undefined) add('tracking_url', patch.trackingUrl)
    if (patch.note !== undefined) add('note', patch.note)
    if (patch.status && patch.status !== cur.status) {
      if (patch.status === 'requested') {
        const held = (await client.query<{ cost: boolean; billed: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pos_reader_order_costs WHERE reader_order_id = $1) AS cost,
                  EXISTS (SELECT 1 FROM landlord_gam_charges WHERE reader_order_id = $1) AS billed`, [id])).rows[0]
        if (held.cost) {
          throw new AppError(409, "GAM's cost is entered on this order, so it cannot go back to a request — GAM bought it. "
            + 'If it was marked Ordered by mistake and GAM paid nothing, enter a $0.00 correction dated the day of the figure it fixes '
            + "(the purchase comes back to GAM on that day), then mark it Cancelled.")
        }
        if (held.billed || Number(cur.installments_raised) > 0) {
          throw new AppError(409, 'Payments have been billed on this order, so it cannot go back to a request.')
        }
        sets.push('ordered_at = NULL', 'shipped_at = NULL', 'delivered_at = NULL', 'registered_at = NULL', 'cancelled_at = NULL')
      }
      add('status', patch.status)
      const stamp = STATUS_STAMP[patch.status]
      if (stamp) sets.push(`${stamp} = COALESCE(${stamp}, NOW())`)
    }
    row = (await client.query(`UPDATE pos_reader_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)).rows[0]
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
  // 10/13 (Nic, full purchase): whatever the change makes due goes into GAM's
  // book now (the cost itself is typed only once GAM bought the reader, and is
  // booked then — recordReaderOrderCost).
  // The status is saved either way; a booking that fails here is written by
  // the next morning's run (chaseReaderOrders).
  if (patch.status && patch.status !== cur.status) {
    try {
      const c = await getClient()
      try {
        await c.query('BEGIN')
        await bookReaderBook(c, id)
        await c.query('COMMIT')
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
    } catch (e) { logger.warn({ err: e, orderId: id }, "[reader-order] could not book the reader in GAM's book — the next morning's run tries again") }
  }
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
    // 10/12 (Nic, Q-g) + 10/13 (full purchase): each piece goes into GAM's
    // book as it is billed — the cost it repays, then any markup. Over every
    // order, not only the ones raised now, so a row the ledger missed (it is
    // written best-effort) is written on the next run.
    await bookReaderBook(client)
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
