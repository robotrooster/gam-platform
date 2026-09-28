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
 *   4. The price is paid in monthly pieces netted from disbursements: the first
 *      when it ships, one each month after, each its own charge line.
 */
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { getStripe } from '../lib/stripe'
import { chargeLandlord } from './landlordGamAccount'
import { getOrCreatePropertyLocation } from './posTerminal'
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
  return row
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
  // The first piece is owed the day it ships.
  if (patch.status === 'shipped' || patch.status === 'delivered' || patch.status === 'registered') await raiseDueInstallments()
  return row
}

/**
 * Raise the pieces that are due: the first when the reader ships, then one on
 * each following month (counted by calendar month, so a reader shipped on the
 * 28th owes its second piece on the 1st, not 30 days later). Idempotent — the
 * count on the order is the ledger of what has been raised.
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
      const due = Math.min(o.installments, 1 + Math.max(0, monthsSince))
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
  if (!p?.stripe_terminal_location_id) return 0
  let added = 0
  try {
    const readers = await getStripe().terminal.readers.list({ location: p.stripe_terminal_location_id, limit: 100 })
    for (const r of readers.data) {
      if (r.status === 'offline' && (r as any).deleted) continue
      const nickname = r.label || `${SUPPORTED_CARD_READER.label} ${r.serial_number?.slice(-4) ?? ''}`.trim()
      const known = await queryOne<{ id: string }>(
        `SELECT id FROM pos_terminal_readers WHERE stripe_reader_id = $1`, [r.id])
      if (!known) {
        await query(
          `INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname) VALUES ($1, $2, $3, $4)`,
          [landlordId, propertyId, r.id, nickname])
        added++
      }
      if (r.serial_number) {
        await query(
          `UPDATE pos_reader_orders SET status = 'registered', registered_at = COALESCE(registered_at, NOW()),
                  stripe_reader_id = $2, updated_at = NOW()
            WHERE property_id = $1 AND serial = $3 AND status <> 'cancelled' AND status <> 'registered'`,
          [propertyId, r.id, r.serial_number])
      }
    }
  } catch (e) { logger.warn({ err: e, propertyId }, '[reader-sync] could not list readers at Stripe') }
  return added
}
