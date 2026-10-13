/**
 * 10/12 (Nic) — GAM Books ledger, phase P5 test fixtures: register sales,
 * stays and the payout chain, written the way the money code writes them
 * (committed: the engine posts on its own connections — see ledgerFixtures).
 *
 *   registerP5 / unregisterAll   the P5 projector set on and off
 *   sale                         a register sale (+ its lines, its held payout
 *                                line, a background check, a stay it paid)
 *   booking, siteDeposit         a stay and its booking-site deposit
 *   active, roleLines, netBy     what is posted now, read back
 */
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  registerLedgerProjector, unregisterLedgerProjector, registeredLedgerSourceTypes,
} from '../services/ledgerEngine'
import { P5_LEDGER_PROJECTORS } from '../services/ledgerProjectors/registerBookingPayoutAll'
import type { LedgerCompany } from './ledgerFixtures'

export function registerP5(): void {
  for (const p of P5_LEDGER_PROJECTORS) registerLedgerProjector(p)
}
export function unregisterAll(): void {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
}

export interface SaleInput {
  method?: 'cash' | 'card' | 'card_on_file' | 'charge'
  subtotal: number
  discount?: number
  tax?: number
  taxBreakdown?: { name: string; rate: number; amount: number }[] | null
  surcharge?: number
  platformFee?: number
  /** The held payout line GAM writes for a card sale (omit: none). */
  held?: number
  /** A background check recorded with the sale. */
  screening?: number
  /** A stay this sale paid toward: what it paid (tax inside). */
  stay?: { bookingId: string; toward: number }
  at?: string
  propertyId?: string | null
  payLink?: boolean
  items?: { name: string; qty: number; price: number; cost?: number }[]
}

/** A committed register sale; returns its id. total = subtotal − discount + tax + surcharge. */
export async function sale(co: LedgerCompany, s: SaleInput): Promise<string> {
  const method = s.method ?? 'cash'
  const tax = s.tax ?? 0
  const total = Math.round((s.subtotal - (s.discount ?? 0) + tax + (s.surcharge ?? 0)) * 100) / 100
  const card = method === 'card' || method === 'card_on_file'
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    let payLinkId: string | null = null
    if (s.payLink) {
      payLinkId = (await c.query<{ id: string }>(
        `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total)
         VALUES ($1, $2, $3, $4, 'standing', 'Link', '[]'::jsonb, $5, $6) RETURNING id`,
        [randomUUID(), co.landlordId, co.propertyId, co.ownerUserId, s.subtotal, total])).rows[0].id
    }
    const id = (await c.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total,
                                     platform_fee, stripe_payment_intent_id, property_id, discount_amount, tax_breakdown,
                                     pay_link_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, COALESCE($14::timestamptz, now())) RETURNING id`,
      [co.landlordId, co.ownerUserId, method, s.subtotal, tax, s.surcharge ?? 0, total, s.platformFee ?? 0,
       card ? `pi_${randomUUID()}` : null, s.propertyId === undefined ? co.propertyId : s.propertyId, s.discount ?? 0,
       s.taxBreakdown ? JSON.stringify(s.taxBreakdown) : null, payLinkId, s.at ?? null])).rows[0].id
    for (const it of s.items ?? [{ name: 'Item', qty: 1, price: s.subtotal }]) {
      await c.query(
        `INSERT INTO pos_transaction_items (transaction_id, item_name, qty, unit_price, cost_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`, [id, it.name, it.qty, it.price, it.cost ?? 0, it.qty * it.price])
    }
    if (s.held != null) {
      await c.query(
        `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, property_id)
         VALUES ($1, 'pos_sale', $2, $3, $4)`, [co.landlordId, id, s.held, co.propertyId])
    }
    if (s.screening) {
      await c.query(
        `INSERT INTO screening_prepayments (landlord_id, property_id, amount, source, source_id)
         VALUES ($1, $2, $3, 'register', $4)`, [co.landlordId, co.propertyId, s.screening, id])
    }
    if (s.stay) {
      await c.query(
        `INSERT INTO stay_payments (booking_id, landlord_id, kind, pos_transaction_id, stripe_payment_intent_id, method, toward_stay, paid_at)
         VALUES ($1, $2, 'pos_sale', $3, $4, $5, $6, COALESCE($7::timestamptz, now()))`,
        [s.stay.bookingId, co.landlordId, id, card ? `pi_${randomUUID()}` : null, method, s.stay.toward, s.at ?? null])
    }
    await c.query('COMMIT')
    return id
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

export async function booking(co: LedgerCompany, b: {
  checkIn: string; checkOut: string; bookedCheckOut?: string | null; status?: string; total?: number
  stayTerms?: 'lease' | 'stay' | null; pi?: string | null
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status,
                                total_amount, stay_terms, stripe_payment_intent_id)
     VALUES ($1, $2, $3, $4, $5, 'nightly', $6, $7, $8, $9) RETURNING id`,
    [co.unitId, co.landlordId, b.checkIn, b.checkOut, b.bookedCheckOut ?? b.checkOut, b.status ?? 'confirmed',
     b.total ?? null, b.stayTerms ?? null, b.pi ?? null])
  return r.rows[0].id
}

/** A booking-site deposit: its stay payment row and GAM's held payout line (as confirmBookingDeposit writes them). */
export async function siteDeposit(co: LedgerCompany, bookingId: string, d: {
  toward: number; lodgingTax: number | null; held: number; at: string; pi?: string
}): Promise<void> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    await c.query(
      `INSERT INTO stay_payments (booking_id, landlord_id, kind, stripe_payment_intent_id, method, toward_stay, lodging_tax_amount, paid_at)
       VALUES ($1, $2, 'site_deposit', $3, 'card', $4, $5, $6::timestamptz)`,
      [bookingId, co.landlordId, d.pi ?? `pi_${randomUUID()}`, d.toward, d.lodgingTax, d.at])
    if (d.held > 0) {
      await c.query(
        `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, property_id, created_at)
         VALUES ($1, 'booking_deposit', $2, $3, $4, $5::timestamptz)`, [co.landlordId, bookingId, d.held, co.propertyId, d.at])
    }
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

export interface ActiveLine {
  kind: string; day: string; role: string | null; dr: number; cr: number; property: string | null
  cash: string | null; cat: string | null
}

/** The active postings' lines of one source (any posting kind), in posting / line order. */
export async function active(sourceType: string, sourceId: string): Promise<ActiveLine[]> {
  const r = await db.query<{ kind: string; day: string; role: string | null; dr: string; cr: string; property: string | null; cash: string | null; cat: string | null }>(
    `SELECT p.posting_kind AS kind, p.intended_date::text AS day, l.account_role AS role, l.debit::text AS dr,
            l.credit::text AS cr, l.property_id AS property, l.cash_effect AS cash, l.report_category AS cat
       FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.source_type = $1 AND p.source_id = $2 AND p.role = 'post' AND p.superseded_at IS NULL
      ORDER BY p.posting_kind, l.line_no`, [sourceType, sourceId])
  return r.rows.map(x => ({ ...x, dr: Number(x.dr), cr: Number(x.cr) }))
}

/** Σ(debit − credit) of a role over a company's active and reversal lines (the account balance). */
export async function balance(landlordId: string, role: string, opts: { through?: string; property?: string | null } = {}): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COALESCE(SUM(debit - credit), 0)::text AS n FROM ledger_posting_lines
      WHERE landlord_id = $1 AND account_role = $2
        AND ($3::date IS NULL OR accounting_date <= $3::date)
        AND ($4::boolean IS FALSE OR property_id IS NOT DISTINCT FROM $5::uuid)`,
    [landlordId, role, opts.through ?? null, opts.property !== undefined, opts.property ?? null])
  return Math.round(Number(r.rows[0].n) * 100) / 100
}

/** Received on a company's books between two days: Σ(credit − debit) over cash_effect 'in' lines. */
export async function received(landlordId: string, from: string, to: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COALESCE(SUM(credit - debit), 0)::text AS n FROM ledger_posting_lines
      WHERE landlord_id = $1 AND cash_effect = 'in' AND accounting_date BETWEEN $2::date AND $3::date`, [landlordId, from, to])
  return Math.round(Number(r.rows[0].n) * 100) / 100
}

/** The reason a source is waiting, if it is. */
export async function waiting(sourceType: string, sourceId: string): Promise<{ reason_code: string; last_error: string } | null> {
  const r = await db.query<{ reason_code: string; last_error: string }>(
    `SELECT reason_code, last_error FROM ledger_source_errors WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId])
  return r.rows[0] ?? null
}
