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
import { SUPPORTED_CARD_READER, installmentSplit } from '@gam/shared'

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
 * The morning chase: ONE email while anything is waiting on GAM.
 *
 *   requested            → nobody has ordered it yet (every day until they do)
 *   ordered, no reader   → after 3 days: has Stripe shipped it?
 *   shipped, never online→ after 10 days: did it arrive, is it plugged in?
 *
 * One digest, not one email per order (S652: one email per thing). Silent when
 * nothing waits.
 */
export async function chaseReaderOrders(now: Date = new Date()): Promise<{ waiting: number; sent: boolean }> {
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
  for (const o of rows) {
    const name = `${o.business_name ?? 'Landlord'} · ${o.property_name}`
    if (o.status === 'requested') {
      lines.push(`NOT ORDERED — ${name}: asked ${days(o.created_at)} day(s) ago`)
    } else if (o.status === 'ordered' && days(o.ordered_at ?? o.created_at) >= 3) {
      lines.push(`CHECK STRIPE — ${name}: ordered ${days(o.ordered_at ?? o.created_at)} day(s) ago and no reader has shown up at the property yet — has it shipped?`)
    } else if ((o.status === 'shipped' || o.status === 'delivered') && days(o.shipped_at ?? o.created_at) >= 10) {
      lines.push(`NOT IN USE — ${name}: shipped ${days(o.shipped_at ?? o.created_at)} day(s) ago and Stripe has never seen it switched on — did it arrive, is it plugged in?`)
    }
  }
  if (!lines.length) return { waiting: 0, sent: false }
  await createAdminNotification({
    severity: 'warn', category: 'reader_orders_waiting', emailSuperAdmins: true,
    title: `${lines.length} card reader order${lines.length === 1 ? '' : 's'} waiting on GAM`,
    body: lines.join('\n'),
    context: { count: lines.length },
    action: { label: 'Open Reader Orders', url: `${portalUrl('admin')}/reader-orders` },
  })
  return { waiting: lines.length, sent: true }
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

/** GAM's desk: every order, newest first, with the location Stripe's shop needs. */
export function adminListReaderOrders() {
  return query<any>(
    `SELECT o.*, p.name AS property_name, p.stripe_terminal_location_id, l.business_name,
            u.email AS landlord_email
       FROM pos_reader_orders o
       JOIN properties p ON p.id = o.property_id
       JOIN landlords l ON l.id = o.landlord_id
       JOIN users u ON u.id = l.user_id
      ORDER BY (o.status IN ('requested','ordered','shipped','delivered')) DESC, o.created_at DESC`)
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
          notes: `Card reader (${SUPPORTED_CARD_READER.label}) — payment ${n} of ${o.installments}`,
        })
        await client.query(`UPDATE pos_reader_orders SET installments_raised = $2, updated_at = NOW() WHERE id = $1`, [o.id, n])
        raised++
      }
    }
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
