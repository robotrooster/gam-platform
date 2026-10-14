/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: A STAY IS EARNED WHEN THE GUEST ARRIVES
 * (gam-ledger-design-2026-10-12 §6 F6; Nic's 10/12 answer L10)
 *
 *   Nic (L10): stays and booking deposits are income WHEN THE GUEST ARRIVES —
 *   short stays on arrival, 30+ nights month by month — held as a guest
 *   deposit until then.
 *
 * Money in for a stay is held in Guest deposits (2060) the day it is paid:
 *   - the booking-site deposit, here (this source's 'main' posting, below);
 *   - a register sale or pay link toward the stay, by the sale's own posting
 *     (registerSale: its stay share credits 2060).
 * This source earns it: Dr Guest deposits (2060) / Cr Stay income (4400), on
 * the stay's schedule. ONE posting a day per source, so the stay is split into
 * sources (migration 20261014150200 marks every one of them whenever the
 * booking or a payment toward it changes):
 *
 *   'booking' <id>         'main':   the booking-site deposit, on the day paid
 *                          'charge': the first stay-month, earned on arrival
 *   'booking' <id>|<k>     'charge': stay-month k (k ≥ 1), earned the day it
 *                                    starts — arrival + k calendar months — for
 *                                    a stay of 30+ nights sold (month by month,
 *                                    like a lease's rent on its due date)
 *   'booking' <id>|end     'charge': the money for stay-months the guest never
 *                                    reached, earned the day the stay ended:
 *                                    the early check-out day, the day it was
 *                                    cancelled, or the arrival day of a no-show
 *                                    (money kept is earned when there is no
 *                                    stay left to earn it)
 *
 * What is earned is the stay money PAID, before tax: the site deposit less its
 * stored lodging tax, plus each sale's stay share less its lodging tax
 * (registerBookingPayoutKit.saleMakeUp). It is spread over the stay-months of
 * the nights SOLD (the later of check_out and booked_check_out — an early
 * check-out changes occupancy, not what was sold) by nights, to the cent. A
 * stay under 30 nights sold, or one whose lease bills the rest (stay_terms
 * 'lease' — the reservation money is the lease's arrival bill paid ahead), is
 * one piece earned on arrival.
 *
 * Refunds and chargebacks are their own events on their own day: they take the
 * money off stay income then (an early check-out's refund part, design D4; a
 * register refund, registerRefund; a chargeback, payoutHeldItem). So a stay's
 * Guest deposits nets to zero once it has ended, and a refund never rewrites
 * a month already earned. Money paid after a stay-month started is earned in
 * that month (it was charged then): the month's posting is restated, or the
 * fix lands on its own day, as the company chose (L4, the engine).
 *
 * The site deposit ('main'): what GAM holds for the landlord is the stay's held
 * payout line (held_payout_items 'booking_deposit', written with it; it posts
 * nothing of its own, design G4); the difference is GAM's card fee the property
 * covered (design F6: 5115 = deposit − held item, which carries a background
 * check's share when the property absorbs the fee):
 *
 *   Dr Due from GAM (1050)         the held line
 *   Dr Processing fees (5115)      deposit − held line (0 when the guest paid the fee on top)
 *   Cr Lodging tax payable (2042)  the deposit's stored lodging tax   } Received,
 *   Cr Guest deposits (2060)       the rest of the deposit            } that day
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import {
  cr, dr, toCents, splitCents, loadSale, saleMakeUp, missingFact, localDaySql, propertyTzSql, LODGING_TAX_NAME,
} from './registerBookingPayoutKit'
import { loadStay, stayParts, type StayFacts } from './incomeLines'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The stay-months of 30+ nights sold are earned one by one; shorter stays on arrival. */
export const STAY_MONTH_BY_MONTH_NIGHTS = 30

export type BookingPart = { kind: 'base' } | { kind: 'month'; k: number } | { kind: 'end' }

/** 'booking' source ids: '<booking>', '<booking>|<k>' (k ≥ 1), '<booking>|end'. */
export function parseBookingSourceId(sourceId: string): { bookingId: string; part: BookingPart } | null {
  const [id, suffix, extra] = sourceId.split('|')
  if (!UUID.test(id ?? '') || extra !== undefined) return null
  if (suffix === undefined) return { bookingId: id, part: { kind: 'base' } }
  if (suffix === 'end') return { bookingId: id, part: { kind: 'end' } }
  if (/^[1-9][0-9]{0,3}$/.test(suffix)) return { bookingId: id, part: { kind: 'month', k: Number(suffix) } }
  return null
}

/** Whole days from `a` to `b` ('YYYY-MM-DD'). */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

interface BookingFacts {
  id: string
  landlord_id: string
  unit_id: string | null
  property_id: string | null
  tenant_id: string | null
  status: string
  check_in: string
  check_out: string
  booked_check_out: string | null
  stay_terms: string | null
  cancel_day: string | null
  /** Arrival + k months, k = 0 … (the stay-month starts inside the nights sold), as the capture counts them. */
  month_starts: string[]
}

async function loadBooking(client: PoolClient, bookingId: string): Promise<BookingFacts | null> {
  const r = await client.query<BookingFacts>(
    `SELECT b.id, b.landlord_id, b.unit_id, u.property_id, b.tenant_id, b.status,
            b.check_in::text AS check_in, b.check_out::text AS check_out, b.booked_check_out::text AS booked_check_out,
            b.stay_terms,
            CASE WHEN b.cancelled_at IS NULL THEN NULL
                 ELSE ${localDaySql('b.cancelled_at', propertyTzSql('u.property_id', 'b.landlord_id'))} END AS cancel_day,
            ARRAY(SELECT (b.check_in + make_interval(months => m.k))::date::text
                    FROM generate_series(0, ledger_booking_stay_month_count(b.check_in, b.check_out, b.booked_check_out)) AS m(k)
                   ORDER BY m.k) AS month_starts
       FROM unit_bookings b LEFT JOIN units u ON u.id = b.unit_id
      WHERE b.id::text = $1`, [bookingId])
  return r.rows[0] ?? null
}

export interface StayPiece { k: number; start: string; nights: number; cents: number; reached: boolean }

/**
 * The stay's schedule: each piece's day, its nights, the stay money it earns
 * and whether the stay reached it; plus the day the stay ended and what the
 * pieces it never reached hold (earned that day).
 */
export function staySchedule(b: Pick<BookingFacts, 'status' | 'check_in' | 'check_out' | 'booked_check_out' | 'stay_terms' | 'cancel_day' | 'month_starts'>,
  earnedCents: number): { pieces: StayPiece[]; endDay: string; unreachedCents: number } {
  const soldOut = [b.check_out, b.booked_check_out ?? b.check_out].sort()[1]
  const nightsSold = daysBetween(b.check_in, soldOut)
  let raw: { k: number; start: string; nights: number }[]
  if (nightsSold < STAY_MONTH_BY_MONTH_NIGHTS || b.stay_terms === 'lease' || b.month_starts.length <= 1) {
    raw = [{ k: 0, start: b.check_in, nights: Math.max(1, nightsSold) }]
  } else {
    raw = b.month_starts.map((start, k) => {
      const next = b.month_starts[k + 1] ?? soldOut
      return { k, start, nights: Math.max(0, daysBetween(start, next < soldOut ? next : soldOut)) }
    })
  }
  const endDay = b.status === 'cancelled' ? (b.cancel_day ?? b.check_in)
    : b.status === 'no_show' ? b.check_in
    : b.check_out
  const cents = splitCents(earnedCents, raw.map(p => p.nights))
  const pieces = raw.map((p, i) => ({ ...p, cents: cents[i] ?? 0, reached: p.start < endDay }))
  const unreachedCents = pieces.filter(p => !p.reached).reduce((a, p) => a + p.cents, 0)
  return { pieces, endDay, unreachedCents }
}

interface SiteDeposit { towardCents: number; taxCents: number | null; day: string }

/** The stay money paid toward a booking, before tax, and its booking-site deposit. */
async function stayMoney(client: PoolClient, b: BookingFacts): Promise<{ earnedCents: number; site: SiteDeposit | null }> {
  const siteRow = (await client.query<{ toward: string; tax: string | null; day: string }>(
    `SELECT sp.toward_stay::text AS toward, sp.lodging_tax_amount::text AS tax,
            ${localDaySql('sp.paid_at', propertyTzSql('$2::uuid', 'sp.landlord_id'))} AS day
       FROM stay_payments sp WHERE sp.booking_id::text = $1 AND sp.kind = 'site_deposit'`,
    [b.id, b.property_id])).rows[0]
  const site: SiteDeposit | null = siteRow
    ? { towardCents: toCents(siteRow.toward), taxCents: siteRow.tax == null ? null : toCents(siteRow.tax), day: siteRow.day }
    : null
  let earned = 0
  if (site) {
    if (site.taxCents == null) throw missingFact('The booking-site deposit does not say how much lodging tax it carried (stay_payments.lodging_tax_amount).')
    earned += site.towardCents - site.taxCents
  }
  const sales = (await client.query<{ id: string }>(
    `SELECT DISTINCT sp.pos_transaction_id::text AS id FROM stay_payments sp
      WHERE sp.booking_id::text = $1 AND sp.kind = 'pos_sale' AND sp.pos_transaction_id IS NOT NULL
      ORDER BY 1`, [b.id])).rows
  for (const s of sales) {
    const sale = await loadSale(client, s.id)
    if (!sale || sale.status === 'voided' || sale.voided_at) continue
    const mk = await saleMakeUp(client, sale)
    earned += mk.stays.find(x => x.bookingId === b.id)?.preTaxCents ?? 0
  }
  return { earnedCents: earned, site }
}

/**
 * 10/14 (Nic I1, I2): the stay earns on its line — a stay under 30 nights on
 * its space type's short-term stay line (the taxed ones), 30+ nights or one a
 * lease bills on its space's rent line (RV long-term rent, mobile home lot
 * rent, …). The role stays stay_income.
 */
function earnPosting(b: BookingFacts, stay: StayFacts | null, day: string, cents: number, memo: string): DesiredPosting | null {
  if (!cents) return null
  const at = { propertyId: b.property_id, unitId: b.unit_id, tenantId: b.tenant_id }
  return {
    owner: { landlordId: b.landlord_id },
    postingKind: 'charge',
    intendedDate: day,
    memo,
    lines: [
      ...dr('guest_deposits', cents, { ...at, memo }),
      ...stayParts(stay, cents).flatMap(p => cr(p.role, p.cents, { ...at, reportCategory: 'stays_and_pay_links', sub: p.sub, memo })),
    ],
  }
}

export const bookingStayProjector: LedgerProjector = {
  sourceType: 'booking',
  // 2 — 10/14 (Nic I1, I2): earned on the stay's own line (incomeLines).
  ruleVersion: 2,

  async project(client: PoolClient, sourceId: string): Promise<DesiredPosting[]> {
    const id = parseBookingSourceId(sourceId)
    if (!id) return []
    const b = await loadBooking(client, id.bookingId)
    if (!b) return []
    const money = await stayMoney(client, b)
    const sched = staySchedule(b, money.earnedCents)
    const stay = await loadStay(client, b.id)
    const out: DesiredPosting[] = []

    if (id.part.kind === 'base') {
      if (money.site && money.site.towardCents > 0) {
        const held = await client.query<{ amount: string }>(
          `SELECT amount::text AS amount FROM held_payout_items WHERE source_type = 'booking_deposit' AND source_id = $1`, [b.id])
        // 10/12 (Nic, ledger review): confirming the deposit writes its held
        // line in the same transaction (propertyBooking.confirmBookingDeposit).
        // A paid deposit with no line is a missing fact: it waits, named,
        // instead of booking the whole deposit as a card fee.
        if (!held.rows[0]) {
          throw missingFact('A booking-site deposit with no held payout line: GAM cannot tell what of it it holds for you and what was its card fee.')
        }
        const heldCents = toCents(held.rows[0]?.amount)
        const at = { propertyId: b.property_id, unitId: b.unit_id, tenantId: b.tenant_id }
        const tax = money.site.taxCents ?? 0
        const lines: DesiredLine[] = [
          ...dr('due_from_gam', heldCents, { ...at, memo: 'Stay deposit money GAM holds for you until your payout' }),
          ...dr('processing_fees', money.site.towardCents - heldCents, { ...at, memo: 'Card fee on a stay deposit' }),
          ...cr('lodging_tax_payable', tax, { ...at, cashEffect: 'in', reportCategory: 'tax_collected', taxName: LODGING_TAX_NAME }),
          ...cr('guest_deposits', money.site.towardCents - tax, {
            ...at, cashEffect: 'in', reportCategory: 'stays_and_pay_links', memo: 'Stay deposit (held until the guest arrives)',
          }),
        ]
        out.push({ owner: { landlordId: b.landlord_id }, postingKind: 'main', intendedDate: money.site.day, memo: 'Stay deposit paid on the booking site', lines })
      }
      const first = sched.pieces[0]
      if (first?.reached) {
        const p = earnPosting(b, stay, first.start, first.cents, 'Stay earned: the guest arrived')
        if (p) out.push(p)
      }
    } else if (id.part.kind === 'month') {
      const piece = sched.pieces.find(p => p.k === (id.part as { k: number }).k)
      if (piece?.reached) {
        const p = earnPosting(b, stay, piece.start, piece.cents, 'Stay month earned')
        if (p) out.push(p)
      }
    } else {
      const p = earnPosting(b, stay, sched.endDay, sched.unreachedCents,
        b.status === 'cancelled' ? 'Stay money kept: the stay was cancelled'
          : b.status === 'no_show' ? 'Stay money kept: the guest did not arrive'
          : 'Stay money kept for nights not stayed')
      if (p) out.push(p)
    }
    return out
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string }>(
      `SELECT x.id FROM unit_bookings b
        CROSS JOIN LATERAL (
          SELECT b.id::text AS id
          UNION ALL SELECT b.id::text || '|end'
          UNION ALL SELECT b.id::text || '|' || m.k::text
            FROM generate_series(1, ledger_booking_stay_month_count(b.check_in, b.check_out, b.booked_check_out)) AS m(k)) x
        WHERE b.landlord_id = $1
          AND EXISTS (SELECT 1 FROM stay_payments sp WHERE sp.booking_id = b.id)
          AND ($2::date IS NULL
               OR GREATEST(b.check_out, COALESCE(b.booked_check_out, b.check_out)) >= $2::date
               OR EXISTS (SELECT 1 FROM stay_payments sp WHERE sp.booking_id = b.id AND sp.paid_at >= $2::date - INTERVAL '1 day'))`,
      [owner.landlordId, opts.since ?? null])
    // A stay's pieces are dated on its schedule (no one day): each is re-projected whenever asked.
    return r.rows.map(x => ({ id: x.id }))
  },
}
