/**
 * 10/4 (decisions #37.B, #38) — EARLY CHECK-OUT: WHAT HAPPENS TO THE MONEY.
 *
 * A guest who leaves before the booked day is checked out on the schedule
 * (routes/stayCheckOut, the schedule's Check out window). Whoever checks them
 * out answers ONE money question, at the landlord's discretion per stay:
 *
 *   - they still owe for the stay → "Keep the price as booked" or "Charge only
 *     the nights stayed". The nights stayed are priced the way the stay was
 *     (scheduleStayPrice) and never cost more than the booked price (#38 Q7).
 *   - they paid more than the nights stayed are worth (even when that is less
 *     than the booked price, #38 Q1) → "No refund (keep the price as booked)",
 *     "Refund the unused nights ($X)" or "Refund a different amount" (up to
 *     what they paid; that is also how a full refund is done).
 *
 * A refund re-prices NOTHING — no new total, no recalculated lodging tax, no
 * fee of any kind (GAM has no per-stay fee) — and the stay closes with nothing
 * owed (#38 Q2). It goes back ONLY the way it was paid, each payment back to
 * itself, most recent first (#38 Q3, Q10): a card to that same card, a bank
 * payment to the bank, cash/check/money order handed back at the desk, a charge
 * account back onto the account, credit back to credit. The guest gets back
 * everything they paid for the refunded part, the card fee included (#38 Q4);
 * Stripe keeps its processing fee and that is the landlord's cost — their
 * payout drops by what the guest got back, the same treatment as a chargeback
 * (services/heldPayouts recordChargeback). GAM absorbs nothing and keeps the
 * card fee it already earned. The landlord sees the exact cost before
 * confirming (cardRefundTerms is the one place this is decided).
 *
 * Permissions (#38 Q5, plan Q7/Q8): "Check guests out" (guests.check_out) is
 * enough to check a guest out and to choose "Keep the price" / "Charge only the
 * nights stayed" — and is NEEDED for those two: "Issue refunds" alone never
 * re-prices a stay (they are left out of its quote). The refund choices need
 * "Issue refunds" (pos.refund) and are left out of the quote for anyone
 * without it. Staff without it can still
 * check an overpaid guest out: the question then WAITS on the stay
 * (stay_checkout_decisions 'pending') for someone who can refund, and the owner
 * gets a to-do. Nothing else ever decides later (#38 Q12), and the AI
 * assistant never checks a guest out or decides money (#38 Q6).
 *
 * A long stay on a lease (#38 Q8) is NEVER billed past the day the guest
 * leaves: the check-out ends the lease that day (the stay's booked length
 * becomes the day they left, and services/bookingLeaseBilling
 * syncLeaseWithBookingDates moves the lease end, drops rent past it, reprices
 * the last month and banks rent already paid past it as money paid ahead —
 * the existing move-out machinery then makes the final bill). That paid-ahead
 * money then gets the refund choices; a refund of it is a recorded spend of the
 * credit (credit_uses.refund_part_id) and goes back the way the rent was paid,
 * newest rent first.
 *
 * Once a refund has gone out, the check-out cannot be undone (#38 Q11,
 * checkOutChangeRefusal).
 *
 * Nothing is ever left silently undone (fix round 1): a card or bank refund
 * that does not go out tells the owner, shows "Try the refund again" on the
 * schedule and in the owner's to-dos (refundNeedsRetrySql) until someone with
 * "Issue refunds" sends it; a lease that could not be ended on the day they
 * left tells GAM and the owner and is tried again whenever the stay or the
 * schedule is opened (healLeaseEnd).
 *
 * Never paid twice, never a closed day rewritten (fix round 2): a card refund
 * that did not go out can be given back in cash instead (givePartBackInCash),
 * recorded so Try again never sends it too; the register refunds nothing on a
 * sale while one waits, and a card refund is never sent past what its sale
 * still has to give back. What the guest paid (P) is what is still with the
 * landlord, after any register refund on the stay's sale. A refund Stripe
 * sends back keeps its own day and is reversed on the day it came back
 * (reversed_at), with a new part for what is still owed to the guest.
 */
import type { PoolClient } from 'pg'
import crypto from 'crypto'
import {
  EARLY_CHECKOUT_CHOICES, EARLY_CHECKOUT_CHOICE_LABEL, EARLY_CHECKOUT_REFUND_CHOICES,
  type EarlyCheckoutChoice, type StayRefundPartKind,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { todayIn, addDaysTo } from '../lib/timezone'
import { scheduleStayPrice, nightsBetween, stayTaxRate, taxInside, reservationDue, untaxedMonthStaySql } from './registerStay'
import { recordHeldItem } from './heldPayouts'
import { recordBookingEvent } from './bookingEvents'

type Q = Pick<PoolClient, 'query'>
/** The pool, in the shape a quote reads with (outside any transaction). */
export const poolQ: Q = { query: (async (sql: string, p?: any[]) => ({ rows: await query(sql, p) })) as any }

const round2 = (n: number) => Math.round(n * 100) / 100
const toCents = (n: number) => Math.round(n * 100)

/** "$1,234.56". */
export const money = (n: number): string =>
  `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** 'YYYY-MM-DD' → "October 5, 2026". */
export const longDay = (ymd: string): string =>
  new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
/** An instant or a day → "Oct 5". */
const shortDay = (d: Date | string): string =>
  new Date(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const nightsWord = (n: number) => `${n} night${n === 1 ? '' : 's'}`

/** The note bookingLeaseBilling writes on rent paid past a shortened stay's end (kept in step with STAY_SHORTENED_CREDIT_NOTE). */
const SHORTENED_NOTE_SQL = `'Stay shortened — rent already paid past the new end'`

export const isEarlyCheckoutChoice = (c: unknown): c is EarlyCheckoutChoice =>
  typeof c === 'string' && (EARLY_CHECKOUT_CHOICES as readonly string[]).includes(c)

// ─── The stay ────────────────────────────────────────────────────────────────

export interface StayRow {
  id: string; landlord_id: string; unit_id: string; property_id: string; unit_number: string
  status: string; guest_name: string | null; timezone: string | null
  check_in: string; check_out: string; sold_check_out: string
  total: number; balance_paid: boolean; deposit_paid: boolean; deposit_amount: number | null
  tax_pct: number; nightly: number | null; weekly: number | null; monthly: number | null
  /** 10/6: the first month of a 30+ night stay booked online — untaxed. */
  month_stay?: boolean
  lease_id: string | null; lease_status: string | null; lease_end: string | null
}

export async function loadStay(q: Q, bookingId: string, opts: { lock?: boolean } = {}): Promise<StayRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(bookingId ?? ''))) return null
  return (await q.query<StayRow>(
    `SELECT b.id, b.landlord_id, b.unit_id, u.property_id, u.unit_number, b.status, b.guest_name, p.timezone,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            to_char(GREATEST(COALESCE(b.booked_check_out, b.check_out), b.check_out), 'YYYY-MM-DD') AS sold_check_out,
            COALESCE(b.total_amount, 0)::float AS total,
            (b.balance_paid_at IS NOT NULL) AS balance_paid, (b.deposit_paid_at IS NOT NULL) AS deposit_paid,
            b.deposit_amount::float AS deposit_amount,
            COALESCE(p.short_term_tax_rate, 0)::float AS tax_pct, ${untaxedMonthStaySql('b')} AS month_stay,
            COALESCE(u.nightly_rate, p.nightly_rate)::float AS nightly,
            COALESCE(u.weekly_rate, p.weekly_rate)::float AS weekly,
            COALESCE(u.monthly_rate, p.monthly_rate)::float AS monthly,
            l.id AS lease_id, l.status AS lease_status, to_char(l.end_date, 'YYYY-MM-DD') AS lease_end
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
       LEFT JOIN LATERAL (
         SELECT l.id, l.status, l.end_date FROM leases l
          WHERE l.source_booking_id = b.id AND l.status IN ('active', 'pending')
          ORDER BY l.created_at DESC LIMIT 1) l ON TRUE
      WHERE b.id = $1${opts.lock ? ' FOR UPDATE OF b' : ''}`, [bookingId])).rows[0] ?? null
}

/**
 * S655 (moved here 10/4 from routes/units): the check-out day an EARLY
 * CHECK-OUT replaced — read from the schedule's own history, the
 * 'dates_changed' event the check-out wrote (marked early_check_out, with the
 * booked day in booked_check_out) — but only while the stored dates are still
 * that event's. A later date edit that changes the check-out, or an undo
 * already done, writes a newer event without the mark and this returns null,
 * so an undo can only ever put back the day the guest had booked, and only
 * once. An arrival-day correction made after the early check-out carries the
 * mark forward; a site move writes no 'dates_changed' event, so the mark stays.
 */
export async function bookedDayBeforeEarlyCheckOut(
  b: { id: string; check_in_day: string; check_out_day: string }, q?: Q,
): Promise<{ booked: string; leftOn: string | null } | null> {
  const sql = `SELECT detail FROM unit_booking_events
                WHERE booking_id = $1 AND event_type = 'dates_changed'
                ORDER BY created_at DESC, id DESC
                LIMIT 1`
  const ev = q ? (await q.query<{ detail: any }>(sql, [b.id])).rows[0] : await queryOne<{ detail: any }>(sql, [b.id])
  const d = ev?.detail
  if (!d || d.early_check_out !== true) return null
  if (d.to?.check_in !== b.check_in_day || d.to?.check_out !== b.check_out_day) return null
  const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) ? v.slice(0, 10) : null)
  const booked = day(d.booked_check_out ?? d.from?.check_out)
  if (!booked || booked <= b.check_out_day) return null
  return { booked, leftOn: day(d.left_on) }
}

/** The stored check-out for a guest who left on `leftOn`: the day after the arrival when they left on it (no stay is ever zero nights). */
export const checkOutForLeftDay = (checkIn: string, leftOn: string): string =>
  leftOn > checkIn ? leftOn : addDaysTo(checkIn, 1)

// ─── The decision ────────────────────────────────────────────────────────────

export interface DecisionRow {
  id: string; booking_id: string; landlord_id: string; lease_id: string | null
  left_on: string; question: 'owes' | 'overpaid'; choice: EarlyCheckoutChoice | null; status: 'pending' | 'decided' | 'undone'
  booked_price: number; stayed_worth: number; paid: number; price_after: number | null; refund_total: number
  stamped_paid: boolean; idempotency_key: string | null
  decided_by: string | null; decided_by_name: string | null; decided_at: Date | null; created_at: Date
}

const DECISION_COLS = `d.id, d.booking_id, d.landlord_id, d.lease_id, to_char(d.left_on, 'YYYY-MM-DD') AS left_on,
  d.question, d.choice, d.status, d.booked_price::float AS booked_price, d.stayed_worth::float AS stayed_worth,
  d.paid::float AS paid, d.price_after::float AS price_after, d.refund_total::float AS refund_total,
  d.stamped_paid, d.idempotency_key, d.decided_by, d.decided_at, d.created_at,
  NULLIF(TRIM(CONCAT(du.first_name, ' ', du.last_name)), '') AS decided_by_name`

/** The money question live on a stay (pending or decided), if any. */
export async function liveDecision(q: Q, bookingId: string, opts: { lock?: boolean } = {}): Promise<DecisionRow | null> {
  return (await q.query<DecisionRow>(
    `SELECT ${DECISION_COLS}
       FROM stay_checkout_decisions d LEFT JOIN users du ON du.id = d.decided_by
      WHERE d.booking_id = $1 AND d.status IN ('pending', 'decided')
      ${opts.lock ? 'FOR UPDATE OF d' : ''}`, [bookingId])).rows[0] ?? null
}

// ─── Where the money came from ───────────────────────────────────────────────

/**
 * One payment the stay's money came from, and how much of it can still go back
 * to it. `feeRate` is the card fee the guest paid on top per dollar of it;
 * `landlordFeeRate` the card fee the landlord covered per dollar.
 */
export interface MoneySource {
  key: string
  kind: StayRefundPartKind | 'unrecorded'
  label: string
  /** Everything this payment ever put toward the stay (or the rent), before anything went back. */
  toward: number
  /** What of it is still with the landlord: less what was refunded from it, at the register or by an early check-out. */
  paid: number
  refundable: number
  paidAt: string
  feeRate: number
  landlordFeeRate: number
  taxRate: number
  stayPaymentId: string | null
  posTransactionId: string | null
  remittanceId: string | null
  paymentIntentId: string | null
  method: string
}

const methodKind = (m: string): StayRefundPartKind => (
  m === 'card' || m === 'card_on_file' ? 'card'
    : m === 'ach' ? 'bank'
    // 10/5: a bank deposit was the resident's cash put into the landlord's
    // bank — it is given back like cash.
    : m === 'cash' || m === 'bank_deposit' ? 'cash'
    : m === 'money_order' ? 'money_order'
    : m === 'charge' ? 'charge'
    : 'check')

/**
 * SQL, on a stay_refund_parts alias: a part that counts as money given back
 * (or still to go back) — never one Stripe sent back (reversed_at: its
 * replacement part carries it) nor a failed card part given back in cash
 * instead ('replaced': the cash part carries it).
 */
export const livePartSql = (p: string) => `(${p}.reversed_at IS NULL AND ${p}.status <> 'replaced')`

/** The stay's own payments (stay_payments), newest first, with what is left to give back on each. */
async function staySources(q: Q, s: StayRow): Promise<MoneySource[]> {
  const taxRate = stayTaxRate({ nightly: s.nightly, weekly: s.weekly, monthly: s.monthly }, s.tax_pct,
    nightsBetween(s.check_in, s.sold_check_out), { checkIn: s.check_in, total: s.total, monthStay: s.month_stay === true })
  const rows = (await q.query<any>(
    `SELECT sp.id, sp.kind, sp.method, sp.pos_transaction_id, sp.stripe_payment_intent_id,
            sp.toward_stay::float AS toward, sp.card_fee::float AS card_fee, sp.landlord_card_fee::float AS landlord_card_fee,
            sp.paid_at, t.pay_link_id,
            (t.total - COALESCE(t.surcharge, 0))::float AS sale_base,
            COALESCE((SELECT SUM(r.amount - r.card_fee_refunded) FROM pos_refunds r
                       WHERE r.transaction_id = t.id AND r.stay_refund_part_id IS NULL AND r.reversed_at IS NULL), 0)::float AS other_refunds,
            COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                       WHERE rp.stay_payment_id = sp.id AND ${livePartSql('rp')}), 0)::float AS parts_toward,
            COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                       WHERE rp.pos_transaction_id = t.id AND rp.stay_payment_id IS DISTINCT FROM sp.id AND ${livePartSql('rp')}), 0)::float AS sale_parts_elsewhere
       FROM stay_payments sp
       LEFT JOIN pos_transactions t ON t.id = sp.pos_transaction_id
      WHERE sp.booking_id = $1 AND (t.id IS NULL OR t.status <> 'voided')
      ORDER BY sp.paid_at DESC, sp.created_at DESC, sp.id DESC`, [s.id])).rows
  return rows.map((r): MoneySource => {
    const kind = methodKind(r.method)
    const where = r.kind === 'site_deposit' ? 'booking site deposit' : r.pay_link_id ? 'pay link' : 'register'
    const how = r.method === 'card_on_file' ? 'Card on file'
      : kind === 'card' ? 'Card' : kind === 'cash' ? 'Cash' : kind === 'charge' ? 'Charge account' : 'Check'
    // What is still with the landlord of this payment (fix round 2): what it
    // put toward the stay less what went back from it — by an early check-out,
    // and by a refund at the register on the same sale (which comes off the
    // sale's other items first: only what the sale has left can be the stay's).
    // That is both what the guest has paid (P) and what can still go back.
    const own = round2(r.toward - r.parts_toward)
    const saleLeft = r.pos_transaction_id ? round2(r.sale_base - r.other_refunds - r.parts_toward - r.sale_parts_elsewhere) : own
    const left = round2(Math.max(0, Math.min(own, saleLeft)))
    return {
      key: r.id, kind, label: `${how} · ${where} ${shortDay(r.paid_at)}`,
      toward: round2(r.toward), paid: left, refundable: left,
      paidAt: new Date(r.paid_at).toISOString(),
      feeRate: r.toward > 0 ? r.card_fee / r.toward : 0,
      landlordFeeRate: r.toward > 0 ? r.landlord_card_fee / r.toward : 0,
      taxRate,
      stayPaymentId: r.id, posTransactionId: r.pos_transaction_id ?? null, remittanceId: null,
      paymentIntentId: r.stripe_payment_intent_id ?? null, method: r.method,
    }
  })
}

/**
 * A long stay's rent payments (#38 Q8), newest first: each settled payment that
 * paid rent on the lease, with how it was paid, and the stay's own payments
 * toward its reservation (its deposit share counts as paid toward the lease).
 * Rent paid from credit goes back to credit.
 */
async function leaseSources(q: Q, s: StayRow): Promise<MoneySource[]> {
  if (!s.lease_id) return []
  // GAM's processing fee on each rent payment, read the one way the margin card
  // and the true-up read it (stripeCosts.gamFeeOnRemittance): the part the
  // tenant paid on top (given back with a refund, #38 Q4) and the part the
  // landlord covered (out of their share when it settled) — never a platform
  // fee the property passes to its tenants, which rides in the same column.
  const { remittanceFeeColumnsSql, remittanceFeeOf, gamFeeOnRemittance } = await import('./stripeCosts')
  const { TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL } = await import('./platformRevenue')
  const rent = (await q.query<any>(
    `SELECT r.id, r.payment_method, r.stripe_payment_intent_id, COALESCE(r.settled_at, r.created_at) AS paid_at,
            r.amount::float AS amount, ${remittanceFeeColumnsSql('r', 'tpf')},
            SUM(ra.amount_applied)::float AS toward,
            COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                       WHERE rp.remittance_id = r.id AND ${livePartSql('rp')}), 0)::float AS parts_toward
       FROM remittance_applications ra
       JOIN tenant_remittances r ON r.id = ra.remittance_id
       JOIN payments p ON p.id = ra.payment_id
       LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
      WHERE p.lease_id = $1 AND p.type = 'rent' AND p.status IN ('settled', 'paid_via_deposit')
        AND r.status = 'settled'
      GROUP BY r.id, tpf.amt
      ORDER BY COALESCE(r.settled_at, r.created_at) DESC, r.id DESC`, [s.lease_id])).rows
  const out: MoneySource[] = rent.map((r): MoneySource => {
    const kind = methodKind(r.payment_method ?? 'cash')
    const how = kind === 'card' ? 'Card' : kind === 'bank' ? 'Bank payment'
      : r.payment_method === 'bank_deposit' ? 'Bank deposit' : kind === 'cash' ? 'Cash'
      : kind === 'money_order' ? 'Money order' : 'Check'
    const paid = round2(r.toward - r.parts_toward)
    const stripe = kind === 'card' || kind === 'bank'
    const fee = stripe ? gamFeeOnRemittance(remittanceFeeOf(r)) : { tenantBorne: 0, landlordBorne: 0 }
    return {
      key: `rem:${r.id}`, kind, label: `${how} · rent ${shortDay(r.paid_at)}`,
      toward: round2(r.toward), paid, refundable: round2(Math.max(0, paid)),
      paidAt: new Date(r.paid_at).toISOString(),
      // Per dollar of the rent payment: the fee the tenant paid on top, and the fee the landlord covered.
      feeRate: stripe && r.amount > 0 ? fee.tenantBorne / r.amount : 0,
      landlordFeeRate: stripe && r.amount > 0 ? fee.landlordBorne / r.amount : 0,
      taxRate: 0,
      stayPaymentId: null, posTransactionId: null, remittanceId: r.id,
      paymentIntentId: r.stripe_payment_intent_id ?? null, method: r.payment_method ?? 'cash',
    }
  })
  // Rent paid from credit: back to credit.
  const credit = (await q.query<{ amount: number; at: Date | null }>(
    `SELECT COALESCE(SUM(u.amount), 0)::float AS amount, MAX(u.applied_at) AS at
       FROM credit_uses u JOIN payments p ON p.id = u.payment_id
      WHERE p.lease_id = $1 AND p.type = 'rent' AND u.status = 'applied'`, [s.lease_id])).rows[0]
  if (credit && credit.amount > 0.005) {
    out.push({
      key: `credit:${s.lease_id}`, kind: 'credit', label: 'Credit · used on rent',
      toward: round2(credit.amount), paid: round2(credit.amount), refundable: round2(credit.amount),
      paidAt: new Date(credit.at ?? 0).toISOString(), feeRate: 0, landlordFeeRate: 0, taxRate: 0,
      stayPaymentId: null, posTransactionId: null, remittanceId: null, paymentIntentId: null, method: 'credit',
    })
  }
  return [...out, ...await staySources(q, s)]
    .sort((a, b) => (a.paidAt < b.paidAt ? 1 : a.paidAt > b.paidAt ? -1 : 0))
}

/** The paid-ahead money a long stay's check-out banked (rent paid past the day they left), still unspent. */
async function leasePaidAhead(q: Q, leaseId: string): Promise<{ total: number; credits: Array<{ id: string; remaining: number }> }> {
  const rows = (await q.query<{ id: string; remaining: number }>(
    `SELECT c.id, c.amount_remaining::float AS remaining
       FROM lease_prepaid_credits c
      WHERE c.lease_id = $1 AND c.funded_by = 'reclassified' AND c.note = ${SHORTENED_NOTE_SQL}
        AND c.voided_at IS NULL AND c.amount_remaining > 0
      ORDER BY c.created_at DESC, c.id DESC`, [leaseId])).rows
  return { total: round2(rows.reduce((a, r) => a + r.remaining, 0)), credits: rows }
}

// ─── #38 Q4: what a card refund costs, in ONE place ──────────────────────────

/**
 * #38 Q4 (Nic, final): on a refund of `toward` paid by card (or by bank), the
 * guest gets back everything they paid for it, INCLUDING the card fee they
 * paid on it — what their bank would return in a dispute. Stripe keeps its
 * processing fee, and that is the LANDLORD's cost: their payout drops by
 * everything the guest gets back, exactly as for a chargeback; GAM absorbs
 * nothing and keeps the card fee it already earned. So the landlord's cost
 * beyond what they were paid for that part is the card fee on it — the part
 * the guest paid on top (given back) plus the part the landlord had covered.
 * Cash, a check, a charge account and credit move no card money.
 */
export function cardRefundTerms(src: Pick<MoneySource, 'kind' | 'feeRate' | 'landlordFeeRate'>, toward: number): {
  cardFeeBack: number; amount: number; payoutDrop: number; landlordCost: number
} {
  const t = round2(toward)
  if (src.kind !== 'card' && src.kind !== 'bank') return { cardFeeBack: 0, amount: t, payoutDrop: 0, landlordCost: 0 }
  const cardFeeBack = round2(t * src.feeRate)
  const amount = round2(t + cardFeeBack)
  return { cardFeeBack, amount, payoutDrop: amount, landlordCost: round2(cardFeeBack + t * src.landlordFeeRate) }
}

export interface PlannedPart {
  source: MoneySource
  kind: StayRefundPartKind
  toward: number
  cardFeeBack: number
  amount: number
  payoutDrop: number
  landlordCost: number
  lodgingTax: number
  words: string
}

/** What one part of a refund means, in the words the desk reads. */
export function partWords(p: { kind: StayRefundPartKind; amount: number; label: string }): string {
  switch (p.kind) {
    case 'card': return `${money(p.amount)} back to the card they paid with (${p.label})`
    case 'bank': return `${money(p.amount)} back to their bank (${p.label})`
    case 'cash': return `Hand back ${money(p.amount)} in cash now`
    case 'check': return `Give back ${money(p.amount)} — they paid by check (${p.label})`
    case 'money_order': return `Give back ${money(p.amount)} — they paid by money order (${p.label})`
    case 'charge': return `${money(p.amount)} back onto their charge account`
    case 'credit': return `${money(p.amount)} stays on their account as credit`
  }
}

/**
 * A refund of `amount` split across the payments it goes back to: each payment
 * back to itself, most recent first (#38 Q3 — no mixed-source choices), each
 * no more than what is left to give back on it. Pure.
 */
export function planRefund(sources: readonly MoneySource[], amount: number): PlannedPart[] {
  let left = toCents(amount)
  const out: PlannedPart[] = []
  for (const s of sources) {
    if (left <= 0) break
    if (s.kind === 'unrecorded') continue
    const take = Math.min(left, toCents(s.refundable))
    if (take <= 0) continue
    const toward = take / 100
    const kind = s.kind as StayRefundPartKind
    const t = cardRefundTerms(s, toward)
    out.push({
      source: s, kind, toward, ...t,
      lodgingTax: taxInside(toward, s.taxRate),
      words: partWords({ kind, amount: t.amount, label: s.label }),
    })
    left -= take
  }
  return out
}

/**
 * The landlord's line for the card parts of a refund: the exact cost before
 * they confirm (#38 Q4, #22). `noun` names what the money was paid for — 'stay'
 * for an early check-out, 'lease' for money paid ahead on an ended lease
 * (services/paidAheadChoice) — so the words never say "stay" for a lease.
 */
export function landlordCostWords(parts: readonly Pick<PlannedPart, 'kind' | 'payoutDrop' | 'landlordCost'>[], noun: 'stay' | 'lease' = 'stay'): string | null {
  const card = parts.filter((p) => p.kind === 'card' || p.kind === 'bank')
  if (!card.length) return null
  const drop = round2(card.reduce((a, p) => a + p.payoutDrop, 0))
  const cost = round2(card.reduce((a, p) => a + p.landlordCost, 0))
  return `Stripe keeps its processing fee on a refund, and that is your cost: your next payout drops by ${money(drop)}`
    + (cost > 0.005 ? ` — ${money(cost)} more than you were paid for this part of the ${noun}.` : '.')
}

// ─── The quote ───────────────────────────────────────────────────────────────

export interface ChoiceView {
  choice: EarlyCheckoutChoice
  label: string
  /** What this choice leaves, in one line: "They will owe $280.00", "$190.00 cash back now + …". */
  result: string
  refund?: { amount: number; parts: Array<{ kind: StayRefundPartKind; label: string; amount: number; words: string }>; cost: string | null }
}

export interface PartView {
  id: string; kind: StayRefundPartKind; label: string; amount: number; status: string; words: string; failure: string | null
}

export interface DecisionView {
  id: string; status: 'pending' | 'decided'; choice: EarlyCheckoutChoice | null; choiceLabel: string | null
  leftOn: string; decidedBy: string | null; decidedAt: string | null; refundTotal: number; priceAfter: number | null
  parts: PartView[]
}

export interface Quote {
  bookingId: string; unitId: string; unitNumber: string; guest: string; status: string; today: string
  checkIn: string; leftOn: string; checkedOut: boolean; early: boolean
  booked: { checkOut: string; nights: number; price: number }
  stayed: { checkOut: string; nights: number; worth: number }
  paid: number
  /** What they would still owe with the booked price kept. */
  owedAsBooked: number
  lease: { id: string; endsOn: string; words: string } | null
  sources: Array<{ key: string; kind: string; label: string; paid: number; refundable: number }>
  question: 'none' | 'owes' | 'overpaid'
  /** "Refund the unused nights": what they paid beyond the nights stayed. */
  unused: number
  /** The most a refund can be. */
  maxRefund: number
  choices: ChoiceView[]
  canRefund: boolean
  canCheckOut: boolean
  /** For staff without "Issue refunds" on an overpaid guest: the money waits on the stay. */
  waitsForRefund: string | null
  /** For staff without "Check guests out" on a guest who still owes: someone who can check guests out decides. */
  waitsForCheckOut: string | null
  decision: DecisionView | null
  quoteToken: string
}

async function partViews(q: Q, decisionId: string): Promise<PartView[]> {
  const rows = (await q.query<any>(
    // The parts as they stand: a refund Stripe sent back, or a failed one given
    // back in cash instead, is history — its replacement is shown in its place.
    `SELECT p.id, p.kind, p.label, p.amount::float AS amount, p.status, p.failure
       FROM stay_refund_parts p WHERE p.decision_id = $1 AND ${livePartSql('p')}
      ORDER BY p.seq, p.created_at`, [decisionId])).rows
  return rows.map((r) => ({
    id: r.id, kind: r.kind, label: r.label, amount: r.amount, status: r.status, failure: r.failure ?? null,
    words: r.status === 'failed'
      ? `${money(r.amount)} could not be refunded to ${r.kind === 'bank' ? 'their bank' : 'the card'} yet — press Try again`
      : r.status === 'pending' ? `${money(r.amount)} to ${r.kind === 'bank' ? 'their bank' : 'the card'} — sending now`
      // Handed back at the desk already: said as done, never as something to do again.
      : r.status === 'handed_back' ? (r.kind === 'cash' ? `${money(r.amount)} handed back in cash`
        : `${money(r.amount)} given back — they paid by ${r.kind === 'money_order' ? 'money order' : 'check'} (${r.label})`)
      : partWords({ kind: r.kind, amount: r.amount, label: r.label }) + (r.kind === 'card' || r.kind === 'bank' ? ' — sent' : ''),
  }))
}

async function decisionView(q: Q, d: DecisionRow | null): Promise<DecisionView | null> {
  if (!d || d.status === 'undone') return null
  return {
    id: d.id, status: d.status, choice: d.choice, choiceLabel: d.choice ? EARLY_CHECKOUT_CHOICE_LABEL[d.choice] : null,
    leftOn: d.left_on, decidedBy: d.decided_by_name ?? null,
    decidedAt: d.decided_at ? new Date(d.decided_at).toISOString() : null,
    refundTotal: d.refund_total, priceAfter: d.price_after, parts: await partViews(q, d.id),
  }
}

const REFUND_PERM_WORDS = 'Refunding needs the "Issue refunds" permission'
/** #38: "Check guests out" is the permission for keeping the price or charging only the nights stayed. */
const PRICE_PERM_WORDS = 'Choosing whether to keep the price as booked or charge only the nights stayed needs the "Check guests out" permission'
export const waitsForCheckOutWords = (guest: string) =>
  `${guest} left early and still owes for the stay. Only someone with "Check guests out" can choose whether to keep the price as booked or charge only the nights stayed.`
export const notOutWaitWords = (guest: string) =>
  `${guest} is not checked out yet. Only someone with "Check guests out" can check them out.`
export const waitsForRefundWords = (guest: string, extra: number) =>
  `${guest} paid ${money(extra)} more than the nights they stayed are worth. You can check them out now; `
  + 'what to do with that money waits on the stay for someone who can issue refunds, and the owner gets a to-do.'

/**
 * The money question for checking this stay out on `leftOn` (default: the
 * property's today) — or, for a stay already checked out whose question is
 * still open or decided, that question. `canRefund` decides whether the refund
 * choices are in it at all (left out on the server, #38 Q5).
 */
export async function quoteEarlyCheckOut(q: Q, bookingId: string, opts: {
  leftOn?: string | null; canRefund: boolean; canCheckOut?: boolean; lockedStay?: StayRow
}): Promise<Quote> {
  const canCheckOut = opts.canCheckOut !== false
  const s = opts.lockedStay ?? await loadStay(q, bookingId)
  if (!s) throw new AppError(404, 'That reservation is not on the schedule any more — close this window and look it up again.')
  const guest = s.guest_name || 'This guest'
  const today = todayIn(s.timezone)
  const d = await liveDecision(q, s.id)
  const checkedOut = s.status === 'checked_out'
  const mark = checkedOut ? await bookedDayBeforeEarlyCheckOut({ id: s.id, check_in_day: s.check_in, check_out_day: s.check_out }, q) : null

  // The day they left, and the day the stay had been booked to.
  let leftOn: string
  let booked: string
  if (checkedOut) {
    leftOn = d?.left_on ?? mark?.leftOn ?? s.check_out
    booked = mark?.booked ?? s.sold_check_out
  } else {
    leftOn = opts.leftOn || today
    booked = s.sold_check_out
  }
  const stayedOut = checkedOut ? s.check_out : checkOutForLeftDay(s.check_in, leftOn)
  const early = stayedOut < booked
  const B = round2(s.total)
  const bookedNights = nightsBetween(s.check_in, booked)
  const stayedNights = nightsBetween(s.check_in, stayedOut)

  // What the nights stayed are worth: priced the way the stay was, never more
  // than the booked price (#38 Q7). A site with no rate to price them leaves
  // the booked price.
  const priced = early ? scheduleStayPrice({ nightly: s.nightly, weekly: s.weekly, monthly: s.monthly }, s.tax_pct, s.check_in, stayedOut).total : B
  let S = early && priced > 0 ? round2(Math.min(priced, B)) : B

  const isLease = !!s.lease_id
  let sources: MoneySource[]
  let P: number
  let lease: Quote['lease'] = null
  let question: Quote['question'] = 'none'
  let unused = 0
  let maxRefund = 0

  if (isLease) {
    // #38 Q8: the check-out ends the lease that day; rent paid past it becomes
    // money paid ahead, and THAT gets the refund choices.
    sources = await leaseSources(q, s)
    if (!checkedOut) {
      lease = {
        id: s.lease_id!, endsOn: stayedOut,
        words: `Checking ${guest === 'This guest' ? 'them' : guest} out ends their lease on ${longDay(stayedOut)}, the day they left, `
          + 'and their final bill is made. Rent already paid past that day can be refunded next.',
      }
      P = round2(sources.reduce((a, x) => a + x.paid, 0))
      S = P
    } else {
      const ahead = await leasePaidAhead(q, s.lease_id!)
      const fromDecision = d && d.status === 'decided'
      P = fromDecision ? d!.paid : ahead.total
      S = 0
      if (!fromDecision && ahead.total > 0.005) {
        question = 'overpaid'
        unused = ahead.total
        // Never more than the rent payments it came from can take back.
        maxRefund = round2(Math.min(ahead.total, sources.reduce((a, x) => a + x.refundable, 0)))
      }
    }
  } else {
    sources = await staySources(q, s)
    const ledger = round2(sources.reduce((a, x) => a + x.paid, 0))
    // Everything the itemized payments ever put toward the stay — what the
    // paid flags are compared with (they never move when money goes back).
    const ledgerGross = round2(sources.reduce((a, x) => a + x.toward, 0))
    // Paid before payments were itemized (the flags say more was paid than the
    // ledger holds): counted as paid, never refundable here.
    const flagsPaid = s.balance_paid ? B : s.deposit_paid ? Math.min(B, s.deposit_amount == null ? B : round2(s.deposit_amount)) : 0
    const unrecorded = d?.status === 'decided' ? 0 : round2(flagsPaid - ledgerGross)
    if (unrecorded > 0.005) {
      sources.push({
        key: 'unrecorded', kind: 'unrecorded', label: 'Paid before payments were itemized — not refundable here',
        toward: unrecorded, paid: unrecorded, refundable: 0, paidAt: new Date(0).toISOString(), feeRate: 0, landlordFeeRate: 0, taxRate: 0,
        stayPaymentId: null, posTransactionId: null, remittanceId: null, paymentIntentId: null, method: 'unrecorded',
      })
    }
    P = d?.status === 'decided' ? d.paid : round2(ledger + Math.max(0, unrecorded))
    if (d?.status === 'decided') { S = d.stayed_worth }
    if (early && B > 0 && !(d?.status === 'decided')) {
      if (P > S + 0.005) {
        question = 'overpaid'
        unused = round2(P - S)
        maxRefund = round2(sources.reduce((a, x) => a + (x.kind === 'unrecorded' ? 0 : x.refundable), 0))
      } else if (S < B - 0.005) {
        question = 'owes'
      }
    }
    // A question the PATCH (or a check-out without "Issue refunds") left
    // pending keeps the figures it was asked on.
    if (d?.status === 'pending' && question === 'none') question = d.question
  }

  const owedAsBooked = isLease ? 0 : round2(Math.max(0, B - P))
  const choices: ChoiceView[] = []
  let waitsForRefund: string | null = null
  let waitsForCheckOut: string | null = null
  if (!checkedOut && !canCheckOut) {
    // Only someone with "Check guests out" checks a guest out — no choices
    // here for anyone else (fix round 2: "Issue refunds" alone reached them by a link).
    waitsForCheckOut = notOutWaitWords(guest)
  } else if (question === 'owes' && !canCheckOut) {
    waitsForCheckOut = waitsForCheckOutWords(guest)
  } else if (question === 'owes') {
    choices.push({ choice: 'keep_price', label: EARLY_CHECKOUT_CHOICE_LABEL.keep_price,
      result: owedAsBooked > 0.005 ? `They will owe ${money(owedAsBooked)}` : 'Nothing more is owed' })
    const owesNights = round2(Math.max(0, S - P))
    choices.push({ choice: 'nights_only', label: `${EARLY_CHECKOUT_CHOICE_LABEL.nights_only} (${nightsWord(stayedNights)}, ${money(S)})`,
      result: owesNights > 0.005 ? `They will owe ${money(owesNights)}` : 'Nothing more is owed' })
  } else if (question === 'overpaid') {
    if (opts.canRefund) {
      choices.push({ choice: 'no_refund', label: EARLY_CHECKOUT_CHOICE_LABEL.no_refund,
        result: isLease ? `The ${money(unused)} stays on their account as money paid ahead — it pays their final bill first`
          : owedAsBooked > 0.005 ? `Nothing goes back, and they still owe ${money(owedAsBooked)}` : 'Nothing goes back' })
      const refundable = Math.min(unused, maxRefund)
      if (refundable > 0.005) {
        const parts = planRefund(sources, refundable)
        choices.push({
          choice: 'refund_unused', label: `${EARLY_CHECKOUT_CHOICE_LABEL.refund_unused} (${money(refundable)})`,
          result: parts.map((p) => p.words).join(' + '),
          refund: { amount: refundable, cost: landlordCostWords(parts),
            parts: parts.map((p) => ({ kind: p.kind, label: p.source.label, amount: p.amount, words: p.words })) },
        })
      }
      if (maxRefund > 0.005) {
        choices.push({ choice: 'refund_other', label: EARLY_CHECKOUT_CHOICE_LABEL.refund_other,
          result: `Type any amount up to ${money(maxRefund)}` })
      }
    } else {
      waitsForRefund = waitsForRefundWords(guest, unused)
    }
  }

  const view = await decisionView(q, d)
  const token = crypto.createHash('sha256').update(JSON.stringify([
    s.status, s.check_in, s.check_out, s.sold_check_out, B, S, P, leftOn, question, unused, maxRefund,
    sources.map((x) => [x.key, x.refundable]), d ? [d.id, d.status] : null,
  ])).digest('hex').slice(0, 32)

  return {
    bookingId: s.id, unitId: s.unit_id, unitNumber: s.unit_number, guest, status: s.status, today,
    checkIn: s.check_in, leftOn, checkedOut, early,
    booked: { checkOut: booked, nights: bookedNights, price: B },
    stayed: { checkOut: stayedOut, nights: stayedNights, worth: S },
    paid: P, owedAsBooked, lease,
    sources: sources.map((x) => ({ key: x.key, kind: x.kind, label: x.label, paid: x.paid, refundable: x.refundable })),
    question, unused, maxRefund, choices, canRefund: opts.canRefund, canCheckOut, waitsForRefund, waitsForCheckOut,
    decision: view, quoteToken: token,
  }
}

/** A sentence for the refund preview of "Refund a different amount" — the screen updates it as the amount is typed. */
export async function previewRefund(q: Q, bookingId: string, amount: number): Promise<{ parts: ChoiceView['refund'] }> {
  const s = await loadStay(q, bookingId)
  if (!s) throw new AppError(404, 'That reservation is not on the schedule any more.')
  const sources = s.lease_id ? await leaseSources(q, s) : await staySources(q, s)
  const parts = planRefund(sources, amount)
  return { parts: { amount: round2(amount), cost: landlordCostWords(parts),
    parts: parts.map((p) => ({ kind: p.kind, label: p.source.label, amount: p.amount, words: p.words })) } }
}

// ─── Writing the check-out ───────────────────────────────────────────────────

/**
 * The check-out itself, inside the caller's transaction (the stay row locked):
 * the status, and for an early one the stored check-out moved to the day they
 * left with the schedule's history event that records the booked day — the
 * same record the booking PATCH writes, so an undo there still puts the booked
 * day back. `endsLease` (#38 Q8): the stay's booked length becomes the day they
 * left, so the lease follows it (the caller runs the lease sync after commit).
 */
export async function writeCheckOut(client: PoolClient, s: StayRow, leftOn: string, actorUserId: string,
                                    opts: { endsLease: boolean; key?: string | null }): Promise<{ newOut: string; early: boolean }> {
  const booked = s.sold_check_out
  const newOut = checkOutForLeftDay(s.check_in, leftOn)
  const early = newOut < booked
  const who = s.guest_name || 'Guest'
  await client.query(
    `UPDATE unit_bookings
        SET status = 'checked_out',
            check_out = CASE WHEN $2::boolean THEN $3::date ELSE check_out END,
            nights = CASE WHEN $2::boolean THEN ($3::date - check_in) ELSE nights END,
            booked_check_out = CASE WHEN $2::boolean AND $4::boolean THEN $3::date
                                    WHEN $2::boolean THEN GREATEST(booked_check_out, check_out, $5::date)
                                    ELSE booked_check_out END,
            cancelled_at = NULL, updated_at = NOW()
      WHERE id = $1`, [s.id, early, newOut, opts.endsLease, booked])
  const base = { client, bookingId: s.id, unitId: s.unit_id, landlordId: s.landlord_id, actorUserId }
  if (early) {
    const n = nightsBetween(newOut, booked)
    const days = `${n} day${n === 1 ? '' : 's'}`
    await recordBookingEvent({
      ...base, eventType: 'dates_changed',
      summary: `${who} checked out early — check-out moved from ${longDay(booked)} to ${longDay(newOut)} (${days} removed)`,
      detail: { from: { check_in: s.check_in, check_out: s.check_out }, to: { check_in: s.check_in, check_out: newOut },
                delta: `${days} removed`, early_check_out: true, booked_check_out: booked, left_on: leftOn },
    })
  }
  if (s.status !== 'checked_out') {
    await recordBookingEvent({
      ...base, eventType: 'status_changed',
      summary: `${who} status: ${s.status === 'checked_in' ? 'Checked in' : s.status === 'confirmed' ? 'Confirmed' : 'Tentative'} → Checked out`,
      // checkout_key: the press that did it (a repeat of it returns what it did);
      // ends_lease: a long stay whose lease ends that day (#38 Q8) — healLeaseEnd
      // finds it if the lease sync after commit fails.
      detail: { from_status: s.status, to_status: 'checked_out',
                ...(opts.key ? { checkout_key: opts.key } : {}), ...(opts.endsLease ? { ends_lease: true } : {}) },
    })
  }
  return { newOut, early }
}

// ─── Register refund rows (one shape for every way a sale's money goes back) ─

/**
 * A register refund row on a sale, with the sale's refunded total and status
 * moved — locked so two refunds never pass the sale's total.
 */
export async function recordSaleRefund(client: PoolClient, o: {
  saleId: string; landlordId: string; amount: number; method: 'cash' | 'check' | 'charge' | 'card'; reason: string
  stripeRefundId?: string | null; cardFeeRefunded?: number; stayRefundPartId?: string | null
}): Promise<string> {
  const t = (await client.query<{ total: number; status: string }>(
    `SELECT total::float AS total, status FROM pos_transactions WHERE id = $1 FOR UPDATE`, [o.saleId])).rows[0]
  if (!t) throw new AppError(404, 'That sale is not on this account any more.')
  const prior = (await client.query<{ s: number }>(
    `SELECT COALESCE(SUM(amount), 0)::float AS s FROM pos_refunds WHERE transaction_id = $1 AND reversed_at IS NULL`, [o.saleId])).rows[0].s
  const cumulative = round2(prior + o.amount)
  if (cumulative > t.total + 0.005) {
    throw new AppError(409, `That is more than is left to refund on the sale (${money(round2(t.total - prior))} at most) — nothing was changed.`)
  }
  const r = await client.query<{ id: string }>(
    `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, reason, refund_method, stripe_refund_id,
                              card_fee_refunded, stay_refund_part_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [o.saleId, o.landlordId, round2(o.amount).toFixed(2), o.reason, o.method, o.stripeRefundId ?? null,
     round2(o.cardFeeRefunded ?? 0).toFixed(2), o.stayRefundPartId ?? null])
  await client.query(
    `UPDATE pos_transactions SET status = $2, refund_amount = $3, refunded_at = NOW() WHERE id = $1`,
    [o.saleId, cumulative >= t.total - 0.005 ? 'refunded' : 'partial_refund', cumulative])
  return r.rows[0].id
}

// ─── Deciding ────────────────────────────────────────────────────────────────

/** Internal: the same press was already recorded (see decideEarlyCheckOut). */
class SameKeyDone extends Error {
  constructor(public decisionId: string | null) { super('same key') }
}
/** Internal: nothing to write — the answer is ready (a repeat of a check-out that already went through). */
class AlreadyDone extends Error {
  constructor(public result: DecideResult) { super('already done') }
}

export class CheckoutChanged extends AppError {
  constructor(public quote: Quote, words: string) { super(409, words) }
}

export interface DecideInput {
  bookingId: string
  actor: { userId: string; canCheckOut: boolean; canRefund: boolean }
  leftOn?: string | null
  choice: EarlyCheckoutChoice | null
  refundAmount?: number | null
  quoteToken: string
  idempotencyKey: string
}

export interface DecideResult {
  bookingId: string
  checkedOut: boolean
  decision: DecisionView | null
  /** done: nothing left to do · decide: the refund question is next (a lease's paid-ahead money) · waits: the question waits on the stay · try_again: a card refund failed */
  next: 'done' | 'decide' | 'waits' | 'try_again'
  /** The lines to show, cash to hand back first. */
  words: string[]
  quote?: Quote
}

const PLAIN_CHANGED = 'Something about this stay changed a moment ago, so nothing was saved. The latest is shown now — look it over and confirm again.'

/** The press (idempotency key) that checked this stay out, when the check-out wrote no decision row (the status_changed event carries it). */
async function checkedOutByKey(q: Q, bookingId: string, key: string): Promise<boolean> {
  return (await q.query(
    `SELECT 1 FROM unit_booking_events
      WHERE booking_id = $1 AND event_type = 'status_changed' AND detail->>'checkout_key' = $2 LIMIT 1`,
    [bookingId, key])).rows.length > 0
}

/**
 * What a check-out that wrote no decision says now — for its own press (after
 * the lease sync) and for a repeat of that press (same key): the paid-ahead
 * question of a long stay (to decide here, or waiting for the owner), the
 * decision someone made since, or simply checked out.
 */
async function checkedOutResult(bookingId: string, actor: DecideInput['actor'], leading: string[] = []): Promise<DecideResult> {
  const quote = await quoteEarlyCheckOut(poolQ, bookingId, { canRefund: actor.canRefund, canCheckOut: actor.canCheckOut })
  if (quote.decision?.status === 'decided') {
    const out = await finishDecision(quote.decision.id, bookingId)
    return { ...out, words: [...leading, ...out.words] }
  }
  const lease = await queryOne<{ id: string; runs_past: boolean }>(
    `SELECT l.id, (l.status = 'active' AND (l.end_date IS NULL OR l.end_date > b.check_out)) AS runs_past
       FROM leases l JOIN unit_bookings b ON b.id = l.source_booking_id
      WHERE l.source_booking_id = $1 ORDER BY l.created_at DESC LIMIT 1`, [bookingId])
  if (lease?.runs_past) {
    // The lease sync has not ended it yet: say so, never "the lease ends".
    return { bookingId, checkedOut: true, decision: quote.decision, next: 'done',
      words: [...leading.filter((w) => w !== LEASE_NOT_ENDED_WORDS), LEASE_NOT_ENDED_WORDS] }
  }
  if (quote.question === 'overpaid') {
    const decideWords = lease
      ? `${quote.guest} is checked out and their lease ends ${longDay(quote.stayed.checkOut)}. They had paid ${money(quote.unused)} past that day — choose what to do with it.`
      : `${quote.guest} is checked out. They paid ${money(quote.unused)} more than the nights they stayed are worth — choose what to do with it.`
    return actor.canRefund
      ? { bookingId, checkedOut: true, decision: quote.decision, next: 'decide', words: [...leading, decideWords], quote }
      : { bookingId, checkedOut: true, decision: quote.decision, next: 'waits', words: [...leading, waitsForRefundWords(quote.guest, quote.unused)] }
  }
  if (quote.question === 'owes') {
    return { bookingId, checkedOut: true, decision: quote.decision, next: actor.canCheckOut ? 'decide' : 'waits',
      words: [...leading, actor.canCheckOut ? `${quote.guest} is checked out. They still owe for the stay — choose what they should pay.` : waitsForCheckOutWords(quote.guest)],
      ...(actor.canCheckOut ? { quote } : {}) }
  }
  return { bookingId, checkedOut: true, decision: null, next: 'done',
    words: [...leading, lease
      ? `${quote.guest} is checked out. Their lease ends ${longDay(quote.stayed.checkOut)}, the day they left, and their final bill is made.`
      : `${quote.guest} is checked out.`] }
}

/**
 * Check the guest out (when they are not out yet) and record the money
 * decision, in one transaction; then send any card or bank refunds. A repeat
 * of the same idempotency key returns what the first one did (and finishes any
 * refund still waiting on Stripe) — also for a press that checked the guest out
 * without a money decision (the key rides on the check-out's history event).
 */
export async function decideEarlyCheckOut(input: DecideInput): Promise<DecideResult> {
  const key = String(input.idempotencyKey ?? '').trim()
  if (!key || key.length > 120) throw new AppError(400, 'This window is out of date — close it and press Check out again.')
  const again = await queryOne<{ id: string; booking_id: string }>(
    `SELECT id, booking_id FROM stay_checkout_decisions WHERE idempotency_key = $1`, [key])
  if (again) {
    if (again.booking_id !== input.bookingId) throw new AppError(409, 'This window is out of date — close it and press Check out again.')
    return finishDecision(again.id, input.bookingId)
  }
  if (/^[0-9a-f-]{36}$/i.test(input.bookingId) && await checkedOutByKey(poolQ, input.bookingId, key)) {
    await healLeaseEnd(input.bookingId, input.actor.userId)
    return checkedOutResult(input.bookingId, input.actor)
  }
  if (input.choice !== null && !isEarlyCheckoutChoice(input.choice)) {
    throw new AppError(400, 'Pick one of the choices shown, then confirm again.')
  }
  if (input.choice && (EARLY_CHECKOUT_REFUND_CHOICES as readonly string[]).includes(input.choice) && !input.actor.canRefund) {
    throw new AppError(403, `${REFUND_PERM_WORDS}, and nothing was changed. Ask the account owner to turn on "Issue refunds" for you in My Team, or check the guest out and leave the money for them.`)
  }

  const client = await getClient()
  let released = false
  let decisionId: string | null = null
  let leaseToEnd: { leaseId: string } | null = null
  let closedLinks: any[] = []
  let pendingCreated = false
  let checkedOutNow = false
  let stay: StayRow | null = null
  let handBack: string[] = []
  try {
    await client.query('BEGIN')
    stay = await loadStay(client, input.bookingId, { lock: true })
    if (!stay) throw new AppError(404, 'That reservation is not on the schedule any more — close this window and look it up again.')
    // A double click waited on the first press's lock just now: it gets what
    // the first one did, never a second decision.
    const sameKey = (await client.query<{ id: string }>(
      `SELECT id FROM stay_checkout_decisions WHERE idempotency_key = $1 AND booking_id = $2`, [key, input.bookingId])).rows[0]?.id ?? null
    if (sameKey) throw new SameKeyDone(sameKey)
    if (await checkedOutByKey(client, input.bookingId, key)) throw new SameKeyDone(null)
    const s = stay
    const guest = s.guest_name || 'This guest'
    if (s.lease_id) {
      const hh = (await client.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM v_lease_active_tenants WHERE lease_id = $1 ORDER BY (role = 'primary') DESC, tenant_id LIMIT 1`,
        [s.lease_id])).rows[0]
      if (hh?.tenant_id) {
        const { lockHousehold } = await import('./moneyPredicates')
        await lockHousehold(client, hh.tenant_id, s.landlord_id)
      }
    }
    // Fix pass (review r3): the stay's register sales, locked BEFORE the quote
    // is read — the lock the register's refund takes (routes/pos). A register
    // refund that is committing right now is waited for and then seen by the
    // quote (what was paid changes, so the press is refused with the fresh
    // numbers); one that starts after waits for this decision and then sees
    // its card refund waiting (saleRefundsWaiting) and refunds nothing. So a
    // card refund decided here always has its sale's room when it is sent —
    // never the stuck "the register already refunded this sale" part, which
    // neither Try again nor cash instead could ever finish.
    await client.query(
      `SELECT 1 FROM pos_transactions
        WHERE id IN (SELECT sp.pos_transaction_id FROM stay_payments sp
                      WHERE sp.booking_id = $1 AND sp.pos_transaction_id IS NOT NULL)
        ORDER BY id FOR UPDATE`, [s.id])
    const today = todayIn(s.timezone)
    const notOutYet = s.status !== 'checked_out'
    if (notOutYet) {
      if (!input.actor.canCheckOut) {
        throw new AppError(403, 'Checking a guest out needs the "Check guests out" permission, and nothing was changed. Ask the account owner to turn it on for you in My Team.')
      }
      if (s.status === 'cancelled' || s.status === 'no_show') {
        throw new AppError(409, `${guest}'s reservation is ${s.status === 'cancelled' ? 'canceled' : 'a no-show'}, so there is no stay to check out.`)
      }
      if (s.check_in > today) {
        throw new AppError(409, `${guest} has not arrived yet — check-in is ${longDay(s.check_in)}. To take the reservation off the schedule, cancel it instead.`)
      }
      const leftOn = input.leftOn || today
      if (!/^\d{4}-\d{2}-\d{2}$/.test(leftOn)) throw new AppError(400, 'Pick the day they left, then confirm again.')
      if (leftOn > today) throw new AppError(400, `They can't have left after today (${longDay(today)}). Pick the day they left.`)
      if (leftOn < s.check_in) throw new AppError(400, `${guest} arrived ${longDay(s.check_in)}, so they can't have left ${longDay(leftOn)}. Pick the day they left.`)
    }
    // #38: keeping the price or charging only the nights stayed is the check-out
    // person's call ("Check guests out"); "Issue refunds" alone never re-prices a stay.
    if ((input.choice === 'keep_price' || input.choice === 'nights_only') && !input.actor.canCheckOut) {
      throw new AppError(403, `${PRICE_PERM_WORDS}, and nothing was changed. Ask the account owner to turn it on for you in My Team.`)
    }

    const quote = await quoteEarlyCheckOut(client, s.id, {
      leftOn: input.leftOn ?? null, canRefund: input.actor.canRefund, canCheckOut: input.actor.canCheckOut, lockedStay: s })
    const live = await liveDecision(client, s.id, { lock: true })
    if (live?.status === 'decided') {
      const who = live.decided_by_name ? `${live.decided_by_name} already` : 'Someone already'
      const e: any = new AppError(409, `${who} decided this check-out: ${EARLY_CHECKOUT_CHOICE_LABEL[live.choice!]}`
        + (live.decided_at ? ` (${shortDay(live.decided_at)})` : '') + '. Nothing else was changed.')
      e.code = 'already_decided'
      throw e
    }
    // Already checked out and nothing about the money is open: there is nothing
    // to save, so the answer is simply that — never a "something changed" error.
    if (!notOutYet && !input.choice && quote.question === 'none' && !live) {
      throw new AlreadyDone({ bookingId: s.id, checkedOut: true, decision: null, next: 'done', words: [`${guest} is checked out.`] })
    }
    if (quote.quoteToken !== input.quoteToken) throw new CheckoutChanged(quote, PLAIN_CHANGED)

    // Which answers fit the question asked.
    const q = quote.question
    if (input.choice) {
      const fits = q === 'owes' ? ['keep_price', 'nights_only'] : q === 'overpaid' ? ['no_refund', 'refund_unused', 'refund_other'] : []
      if (!fits.includes(input.choice)) throw new CheckoutChanged(quote, PLAIN_CHANGED)
    } else if ((q === 'owes' && input.actor.canCheckOut) || (q === 'overpaid' && input.actor.canRefund && !(s.lease_id && notOutYet))) {
      throw new AppError(400, 'Pick one of the choices shown, then confirm again.')
    }

    // The check-out.
    if (notOutYet) {
      await writeCheckOut(client, s, quote.leftOn, input.actor.userId, { endsLease: !!s.lease_id, key })
      checkedOutNow = true
      if (s.lease_id) leaseToEnd = { leaseId: s.lease_id }
    }

    if (q !== 'none' && !input.choice) {
      // #38 Q5: the money waits on the stay for someone who can decide it.
      decisionId = await upsertPending(client, s, quote, input.actor.userId, key)
      pendingCreated = !live
    } else if (input.choice) {
      const r = await applyDecision(client, s, quote, live, input, key)
      decisionId = r.decisionId
      closedLinks = r.closedLinks
      handBack = r.handBack
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    if (e instanceof SameKeyDone) {
      client.release(); released = true
      if (e.decisionId) return finishDecision(e.decisionId, input.bookingId)
      await healLeaseEnd(input.bookingId, input.actor.userId)
      return checkedOutResult(input.bookingId, input.actor)
    }
    if (e instanceof AlreadyDone) return e.result
    if ((e as any)?.code === '23505' && (e as any)?.constraint === 'stay_checkout_decisions_idem_uniq') {
      const first = await queryOne<{ id: string }>(`SELECT id FROM stay_checkout_decisions WHERE idempotency_key = $1`, [key])
      if (first) { client.release(); released = true; return finishDecision(first.id, input.bookingId) }
    }
    if ((e as any)?.code === '23505' && String((e as any)?.constraint ?? '').startsWith('stay_checkout_decisions')) {
      // Two staff on the same check-out at the same moment: the other one won.
      const fresh = await quoteEarlyCheckOut(poolQ, input.bookingId,
        { canRefund: input.actor.canRefund, canCheckOut: input.actor.canCheckOut }).catch(() => null)
      if (fresh) throw new CheckoutChanged(fresh, 'Someone else saved this check-out a moment ago, so yours was not saved. What they did is shown now.')
    }
    throw e
  } finally {
    if (!released) client.release()
  }

  if (closedLinks.length) {
    const { expireClosedLinks } = await import('../routes/posPayLinks')
    await expireClosedLinks(closedLinks).catch((err) => logger.warn({ err, bookingId: input.bookingId }, '[early-checkout] could not close a pay page'))
  }
  // 10/5 (Nic, R11 — M8): a no-lease stay of 30+ nights pays its site's
  // utilities through an agreement tied to the stay. It ends on the day they
  // left, early or on time, so it stops billing a guest who has gone (and its
  // last stretch is billed by the check-out read).
  await syncStayUtilities(input.bookingId)

  // #38 Q8: the lease ends on the day they left — moved by the schedule's own
  // lease sync (rent past it dropped, the last month repriced, rent already
  // paid past it banked as money paid ahead). Then that money gets the refund
  // question. When the sync fails, GAM and the owner are told and it is tried
  // again (healLeaseEnd) the next time the stay or the schedule is opened.
  if (leaseToEnd) {
    const ended = await endLeaseOnLeftDay(input.bookingId)
    const leading = ended ? [] : [LEASE_NOT_ENDED_WORDS]
    if (ended) await askPaidAheadQuestion(input.bookingId, input.actor.userId, { tellOwner: !input.actor.canRefund })
    return checkedOutResult(input.bookingId, input.actor, leading)
  }

  if (pendingCreated) await tellOwnerMoneyWaits(input.bookingId).catch((err) => logger.error({ err }, '[early-checkout] owner to-do failed'))
  if (!decisionId) {
    return { bookingId: input.bookingId, checkedOut: checkedOutNow, decision: null, next: 'done',
      words: [`${stay?.guest_name || 'The guest'} is checked out.`] }
  }
  const out = await finishDecision(decisionId, input.bookingId)
  if (handBack.length) out.words = [...handBack, ...out.words.filter((w) => !handBack.includes(w))]
  return out
}

/**
 * R11 (M8): keep a stay's utility agreement in step after a check-out or an
 * early departure (services/stayTerms syncStayUtilityAgreement). Best-effort
 * after the commit — the check-out stands either way; a failure is logged.
 */
async function syncStayUtilities(bookingId: string): Promise<void> {
  try {
    const { syncStayUtilityAgreement } = await import('./stayTerms')
    await syncStayUtilityAgreement(bookingId)
  } catch (err) {
    logger.error({ err, bookingId }, '[early-checkout] could not end the stay\'s utility agreement on the day they left')
  }
}

/** What the desk reads when the lease could not be ended on the day they left. */
export const LEASE_NOT_ENDED_WORDS = 'The guest is checked out, but their lease could not be ended on the day they left just now. '
  + 'GAM and the owner have been told, and it is tried again the next time this stay or the schedule is opened.'

/**
 * #38 Q8: end a long stay's lease on the day the guest left (the schedule's own
 * lease sync). True when it is done. A failure is never silent: GAM gets an
 * admin notice and the owner a to-do (each once per stay), and healLeaseEnd
 * tries it again whenever the stay or the schedule is opened.
 */
export async function endLeaseOnLeftDay(bookingId: string): Promise<boolean> {
  try {
    const { syncLeaseWithBookingDates } = await import('./bookingLeaseBilling')
    await syncLeaseWithBookingDates(bookingId)
    return true
  } catch (err) {
    logger.error({ err, bookingId }, '[early-checkout] the lease could not be ended on the day they left')
    await reportLeaseNotEnded(bookingId, err).catch((e2) => logger.error({ err: e2, bookingId }, '[early-checkout] could not report the lease that did not end'))
    return false
  }
}

/** The SQL for a long stay checked out (by the Check out window or the booking PATCH) whose lease still runs past the day they left. */
const LEASE_RUNS_PAST_SQL = `
  b.status = 'checked_out' AND l.status = 'active'
  AND (l.end_date IS NULL OR l.end_date > b.check_out)
  AND (EXISTS (SELECT 1 FROM unit_booking_events e
                WHERE e.booking_id = b.id AND e.event_type = 'status_changed' AND e.detail->>'ends_lease' = 'true')
       OR EXISTS (SELECT 1 FROM admin_notifications an
                   WHERE an.category = 'stay_checkout_lease_not_ended' AND an.context->>'booking_id' = b.id::text))`

async function reportLeaseNotEnded(bookingId: string, err: unknown): Promise<void> {
  const r = await queryOne<{ landlord_id: string; unit_id: string; guest_name: string | null; unit_number: string; lease_id: string | null; check_out: string }>(
    `SELECT b.landlord_id, b.unit_id, b.guest_name, u.unit_number, l.id AS lease_id, to_char(b.check_out, 'YYYY-MM-DD') AS check_out
       FROM unit_bookings b JOIN units u ON u.id = b.unit_id
       LEFT JOIN LATERAL (SELECT id FROM leases WHERE source_booking_id = b.id ORDER BY created_at DESC LIMIT 1) l ON TRUE
      WHERE b.id = $1`, [bookingId])
  if (!r) return
  const guest = r.guest_name || 'A guest'
  const told = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM admin_notifications WHERE category = 'stay_checkout_lease_not_ended' AND context->>'booking_id' = $1`, [bookingId])
  if (!told?.n) {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn', category: 'stay_checkout_lease_not_ended',
      title: `A long stay was checked out but its lease did not end — ${guest} on ${r.unit_number}`,
      body: `${guest} left on ${longDay(r.check_out)}, but the lease could not be ended that day (${err instanceof Error ? err.message : String(err)}). `
        + 'Until it is, the lease keeps billing past the day they left. GAM tries again each time the stay or the schedule is opened; fix the cause if it keeps failing.',
      context: { booking_id: bookingId, lease_id: r.lease_id, landlord_id: r.landlord_id, left_on: r.check_out },
    })
  }
  const owner = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE landlord_id = $1 AND type = 'stay_lease_not_ended' AND data->>'bookingId' = $2`,
    [r.landlord_id, bookingId])
  if (!owner?.n) {
    await tellOwner(r.landlord_id, {
      type: 'stay_lease_not_ended',
      title: `${guest}'s lease did not end on the day they left — ${r.unit_number}`,
      body: `${guest} was checked out early, but their lease could not be ended on ${longDay(r.check_out)} just now. GAM has been told. `
        + 'Open the stay on the schedule to try again; until then it keeps billing past that day.',
      bookingId, unitId: r.unit_id,
    })
  }
}

/**
 * The lease end, tried again: a long stay checked out whose lease still runs
 * past the day they left (the sync failed before). Once it ends, the money
 * paid past that day gets its refund question (waiting, with an owner to-do).
 */
export async function healLeaseEnd(bookingId: string, actorUserId: string): Promise<void> {
  const due = await queryOne<{ id: string }>(
    `SELECT b.id FROM unit_bookings b JOIN leases l ON l.source_booking_id = b.id
      WHERE b.id = $1 AND ${LEASE_RUNS_PAST_SQL} LIMIT 1`, [bookingId])
  if (!due) return
  if (await endLeaseOnLeftDay(bookingId)) await askPaidAheadQuestion(bookingId, actorUserId, { tellOwner: true })
}

/** healLeaseEnd for a few of an account's stays at once (the schedule's open). */
export async function healLeaseEnds(landlordIds: readonly string[], actorUserId: string): Promise<void> {
  if (!landlordIds.length) return
  const rows = await query<{ id: string }>(
    `SELECT b.id FROM unit_bookings b JOIN leases l ON l.source_booking_id = b.id
      WHERE b.landlord_id = ANY($1::uuid[]) AND ${LEASE_RUNS_PAST_SQL}
      ORDER BY b.updated_at LIMIT 5`, [[...landlordIds]])
  for (const r of rows) await healLeaseEnd(r.id, actorUserId).catch((err) => logger.error({ err, bookingId: r.id }, '[early-checkout] lease end retry failed'))
}

/** After the lease ended: the money paid past the day they left waits on the stay as its refund question. */
async function askPaidAheadQuestion(bookingId: string, actorUserId: string, opts: { tellOwner: boolean }): Promise<void> {
  const quote = await quoteEarlyCheckOut(poolQ, bookingId, { canRefund: true })
  if (quote.question !== 'overpaid' || quote.decision) return
  const c = await getClient()
  let created = false
  try {
    await c.query('BEGIN')
    const s = await loadStay(c, bookingId, { lock: true })
    if (s && !(await liveDecision(c, s.id))) {
      await upsertPending(c, s, quote, actorUserId, null)
      created = true
    }
    await c.query('COMMIT')
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    logger.error({ err, bookingId }, '[early-checkout] could not record the paid-ahead money question')
  } finally { c.release() }
  // A to-do for the owner only when the person here cannot decide it.
  if (created && opts.tellOwner) await tellOwnerMoneyWaits(bookingId).catch(() => {})
}

async function upsertPending(client: PoolClient, s: StayRow, quote: Quote, userId: string, key: string | null): Promise<string> {
  const live = await liveDecision(client, s.id, { lock: true })
  if (live) return live.id
  const r = await client.query<{ id: string }>(
    `INSERT INTO stay_checkout_decisions
       (booking_id, landlord_id, lease_id, left_on, question, status, booked_price, stayed_worth, paid, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4::date, $5, 'pending', $6, $7, $8, $9, $10) RETURNING id`,
    [s.id, s.landlord_id, s.lease_id, quote.leftOn, quote.question === 'none' ? 'overpaid' : quote.question,
     quote.booked.price.toFixed(2), quote.stayed.worth.toFixed(2), quote.paid.toFixed(2), key, userId])
  return r.rows[0].id
}

/** Record the choice and do what it says, inside the caller's transaction. */
async function applyDecision(client: PoolClient, s: StayRow, quote: Quote, live: DecisionRow | null,
                             input: DecideInput, key: string): Promise<{ decisionId: string; closedLinks: any[]; handBack: string[] }> {
  const choice = input.choice!
  const B = quote.booked.price
  const S = quote.stayed.worth
  const P = quote.paid
  const isLease = !!s.lease_id
  let refundTotal = 0
  let priceAfter = isLease ? null : B
  let stampedPaid = false
  let closedLinks: any[] = []
  const handBack: string[] = []

  let decisionId: string
  if (live) {
    decisionId = live.id
    await client.query(
      // This press's key from now on: a double click of the decision finds it.
      `UPDATE stay_checkout_decisions SET idempotency_key = $2 WHERE id = $1`, [live.id, key])
  } else {
    decisionId = (await client.query<{ id: string }>(
      `INSERT INTO stay_checkout_decisions
         (booking_id, landlord_id, lease_id, left_on, question, status, booked_price, stayed_worth, paid, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4::date, $5, 'pending', $6, $7, $8, $9, $10) RETURNING id`,
      [s.id, s.landlord_id, s.lease_id, quote.leftOn, quote.question, B.toFixed(2), S.toFixed(2), P.toFixed(2), key, input.actor.userId])).rows[0].id
  }

  let summary = ''
  const who = s.guest_name || 'Guest'
  if (choice === 'nights_only') {
    // A deliberate new length (decisions #35.4): the price, its tax and the
    // revenue split follow the nights stayed.
    priceAfter = S
    await client.query(
      `UPDATE unit_bookings SET total_amount = $2, platform_fee = 0,
              booked_check_out = check_out, updated_at = NOW() WHERE id = $1`, [s.id, S.toFixed(2)])
    if (S - P <= 0.005) {
      stampedPaid = await stampPaid(client, s.id)
      const { closeIfPaidInFull } = await import('../routes/posPayLinks')
      closedLinks = await closeIfPaidInFull(client, s.id, {})
    } else if (!isLease) {
      await syncPaidFlags(client, s.id, quote)
    }
    summary = `${who} left early — charged only the ${nightsWord(quote.stayed.nights)} stayed (${money(S)})`
  } else if (choice === 'keep_price' || choice === 'no_refund') {
    if (!isLease) await syncPaidFlags(client, s.id, quote)
    summary = isLease
      ? `${who} left early — no refund; the ${money(P)} paid past the day they left stays as money paid ahead`
      : `${who} left early — ${choice === 'keep_price' ? 'kept the price as booked' : 'no refund'} (${money(B)})`
  } else {
    // A refund. Re-prices nothing (#38 Q2).
    const max = quote.maxRefund
    const R = choice === 'refund_unused' ? Math.min(quote.unused, max) : round2(Number(input.refundAmount))
    if (!(R > 0)) throw new AppError(400, 'Type how much to refund (more than $0.00), then confirm again.')
    if (R > max + 0.005) throw new AppError(400, `That is more than can be refunded — ${money(max)} at most. Change the amount, then confirm again.`)
    const sources = isLease ? await leaseSources(client, s) : await staySources(client, s)
    const plan = planRefund(sources, R)
    const planned = round2(plan.reduce((a, p) => a + p.toward, 0))
    if (Math.abs(planned - R) > 0.005) throw new AppError(409, 'Part of what was paid can no longer be refunded here — close this window and open it again.')
    const credits = isLease ? (await leasePaidAhead(client, s.lease_id!)).credits : []
    let seq = 0
    const sentParts: string[] = []
    for (const p of plan) {
      seq++
      const immediate = p.kind === 'cash' || p.kind === 'check' || p.kind === 'money_order' ? 'handed_back'
        : p.kind === 'credit' ? 'credited' : p.kind === 'charge' ? 'refunded' : 'pending'
      const partId = (await client.query<{ id: string }>(
        `INSERT INTO stay_refund_parts
           (decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, remittance_id, prepaid_credit_id,
            pos_transaction_id, stripe_payment_intent_id, toward_amount, card_fee_back, amount, payout_drop,
            lodging_tax_share, label, status, refunded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 CASE WHEN $17 IN ('handed_back', 'credited', 'refunded') THEN NOW() END)
         RETURNING id`,
        [decisionId, s.id, s.landlord_id, seq, p.kind, p.source.stayPaymentId, p.source.remittanceId,
         // A long stay's refund comes out of its paid-ahead money (the credit it is recorded against).
         isLease ? (credits[0]?.id ?? null) : null,
         p.source.posTransactionId, p.source.paymentIntentId,
         p.toward.toFixed(2), p.cardFeeBack.toFixed(2), p.amount.toFixed(2), p.payoutDrop.toFixed(2),
         p.lodgingTax.toFixed(2), p.source.label, immediate])).rows[0].id
      sentParts.push(p.kind === 'card' ? `${money(p.amount)} to the card` : p.kind === 'bank' ? `${money(p.amount)} to their bank`
        : p.kind === 'cash' ? `${money(p.amount)} cash handed back` : p.kind === 'charge' ? `${money(p.amount)} back onto their charge account`
        : p.kind === 'credit' ? `${money(p.amount)} back to credit` : `${money(p.amount)} handed back`)
      if (p.kind === 'cash') handBack.push(`Hand back ${money(p.amount)} in cash now.`)
      if (p.kind === 'check' || p.kind === 'money_order') handBack.push(p.words + '.')
      // A sale's money that does not go through Stripe is recorded on the sale now.
      if (p.source.posTransactionId && (p.kind === 'cash' || p.kind === 'check' || p.kind === 'charge')) {
        if (p.kind === 'charge') {
          const acct = (await client.query<{ account_id: string }>(
            `SELECT account_id FROM flex_charge_transactions WHERE pos_transaction_id = $1 AND amount > 0 ORDER BY created_at LIMIT 1`,
            [p.source.posTransactionId])).rows[0]
          if (!acct) throw new AppError(409, 'This stay was put on a charge account that can no longer be found, so it cannot be refunded here — nothing was changed. Ask the owner to check the account.')
          const { postFlexChargeRefund } = await import('./flexCharge')
          await postFlexChargeRefund({ accountId: acct.account_id, posTransactionId: p.source.posTransactionId,
            amount: p.amount, notes: `Refund: ${who} left early` }, client)
        }
        const refundId = await recordSaleRefund(client, {
          saleId: p.source.posTransactionId, landlordId: s.landlord_id, amount: p.amount,
          method: p.kind === 'charge' ? 'charge' : p.kind === 'cash' ? 'cash' : 'check',
          reason: `${who} left early`, stayRefundPartId: partId,
        })
        await client.query(`UPDATE stay_refund_parts SET pos_refund_id = $2 WHERE id = $1`, [partId, refundId])
      }
      // A long stay's paid-ahead money that goes back as money comes off the
      // credit, recorded as a spend of it (credit back to credit stays as it is).
      if (isLease && p.kind !== 'credit') await drawPaidAhead(client, credits, p.toward, partId, s.lease_id!, quote.leftOn, input.actor.userId)
      refundTotal = round2(refundTotal + p.toward)
    }
    if (!isLease) {
      // The stay closes with nothing owed (#38 Q2).
      stampedPaid = await stampPaid(client, s.id)
      const { closeIfPaidInFull } = await import('../routes/posPayLinks')
      closedLinks = await closeIfPaidInFull(client, s.id, {})
    }
    summary = `${who} left early — ${sentParts.join(', ')}`
  }

  await client.query(
    `UPDATE stay_checkout_decisions
        SET status = 'decided', choice = $2, price_after = $3, refund_total = $4, stamped_paid = stamped_paid OR $5,
            decided_by = $6, decided_at = NOW(),
            stayed_worth = $7, paid = GREATEST(paid, $4)
      WHERE id = $1`,
    [decisionId, choice, priceAfter == null ? null : priceAfter.toFixed(2), refundTotal.toFixed(2), stampedPaid, input.actor.userId,
     S.toFixed(2)])
  await recordBookingEvent({
    client, bookingId: s.id, unitId: s.unit_id, landlordId: s.landlord_id, actorUserId: input.actor.userId,
    eventType: 'money_settled', summary,
    detail: { decision_id: decisionId, choice, booked_price: B, stayed_worth: S, paid: P, refund_total: refundTotal, price_after: priceAfter },
  })
  return { decisionId, closedLinks, handBack }
}

/**
 * Fix round 2: a refund at the register on the stay's own sale never moves the
 * stay's paid flags (decisions #23 — a register refund never touches a
 * reservation), so after one the flags count money the guest got back, and
 * "They will owe $X" would never be asked for at the register or on a pay
 * link. When the guest is left owing, the flags are put in step with what is
 * still with the landlord (the quote's P) — only when every dollar the flags
 * count is itemized (no unrecorded part) and the register bills the whole stay
 * (a long stay's lease bills it, and its deposit_amount is the deposit due).
 */
async function syncPaidFlags(client: PoolClient, bookingId: string, quote: Quote): Promise<void> {
  if (quote.sources.some((x) => x.kind === 'unrecorded')) return
  const due = await reservationDue(client, bookingId)
  if (!due || due.leaseBillsRest || due.paid <= quote.paid + 0.005) return
  await client.query(
    `UPDATE unit_bookings
        SET deposit_amount = $2::numeric, deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
            balance_paid_at = CASE WHEN $2::numeric >= COALESCE(total_amount, 0) - 0.005 THEN balance_paid_at ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1`, [bookingId, quote.paid.toFixed(2)])
}

/** Stamp the stay billed and paid in full (nothing left for the register or the arrival-day bill). True when this stamped it. */
async function stampPaid(client: PoolClient, bookingId: string): Promise<boolean> {
  const r = await client.query(
    `UPDATE unit_bookings
        SET balance_billed_at = COALESCE(balance_billed_at, NOW()), balance_paid_at = NOW(),
            deposit_paid_at = COALESCE(deposit_paid_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND balance_paid_at IS NULL`, [bookingId])
  return (r.rowCount ?? 0) > 0
}

/** Take `amount` of a long stay's paid-ahead money off its credits, recorded as a refund spend (credit_uses.refund_part_id). */
async function drawPaidAhead(client: PoolClient, credits: Array<{ id: string; remaining: number }>, amount: number,
                             partId: string, leaseId: string, leftOn: string, userId: string): Promise<void> {
  let left = toCents(amount)
  for (const c of credits) {
    if (left <= 0) break
    const take = Math.min(left, toCents(c.remaining))
    if (take <= 0) continue
    await client.query(
      `INSERT INTO credit_uses (prepaid_credit_id, refund_part_id, lease_id, amount, billing_month, source, status, applied_at, created_by)
       VALUES ($1, $2, $3, $4, date_trunc('month', $5::date)::date, 'refund', 'applied', NOW(), $6)`,
      [c.id, partId, leaseId, (take / 100).toFixed(2), leftOn, userId])
    c.remaining = round2(c.remaining - take / 100)
    left -= take
  }
  if (left > 0) throw new AppError(409, 'The money paid ahead changed a moment ago — close this window and open it again.')
}

/**
 * The decision's result after commit: card and bank parts sent (or retried
 * when still waiting). `handBackAll` (the press that decided it, or a repeat
 * of that same press): the money handed back at the desk is said again, in the
 * words to act on. A later Try again leaves it out — it was handed back then,
 * and saying "Hand back" again would have it handed back twice.
 */
async function finishDecision(decisionId: string, bookingId: string, opts: { handBackAll?: boolean } = {}): Promise<DecideResult> {
  const handBackAll = opts.handBackAll !== false
  const waiting = await query<{ id: string }>(
    `SELECT id FROM stay_refund_parts WHERE decision_id = $1 AND status = 'pending' ORDER BY seq`, [decisionId])
  for (const p of waiting) await runCardPart(p.id)
  const d = (await query<DecisionRow>(
    `SELECT ${DECISION_COLS} FROM stay_checkout_decisions d LEFT JOIN users du ON du.id = d.decided_by WHERE d.id = $1`,
    [decisionId]))[0]
  const view = await decisionView(poolQ, d)
  const parts = view?.parts ?? []
  const failed = parts.some((p) => p.status === 'failed')
  const guest = (await queryOne<{ guest_name: string | null }>(`SELECT guest_name FROM unit_bookings WHERE id = $1`, [bookingId]))?.guest_name || 'The guest'
  const words: string[] = []
  // Cash first and plain: the desk must not miss it.
  const atDesk = (p: PartView) => p.status === 'handed_back'
  if (handBackAll) {
    for (const p of parts) if (atDesk(p) && p.kind === 'cash') words.push(`Hand back ${money(p.amount)} in cash now.`)
    for (const p of parts) if (atDesk(p) && p.kind !== 'cash') words.push(partWords({ kind: p.kind, amount: p.amount, label: p.label }) + '.')
  }
  for (const p of parts) if (!atDesk(p)) words.push(p.words + '.')
  if (d?.status === 'pending') {
    words.push(d.question === 'owes' ? waitsForCheckOutWords(guest) : waitsForRefundWords(guest, round2(Math.max(0, d.paid - d.stayed_worth))))
  }
  if (d?.status === 'decided' && !parts.length) {
    words.push(d.choice === 'nights_only' ? `${guest} is checked out. The stay now costs ${money(d.price_after ?? 0)} — the nights they stayed.`
      : `${guest} is checked out. The price stays as booked.`)
  }
  return {
    bookingId, checkedOut: true, decision: view,
    next: failed ? 'try_again' : d?.status === 'pending' ? 'waits' : 'done',
    words,
  }
}

// ─── Card and bank refunds (Stripe) ──────────────────────────────────────────

type PartWhy = 'not_sent' | 'not_recorded' | 'turned_down' | 'no_room' | 'too_old' | 'disputed'

/**
 * The two ways out of a card or bank refund that did not go out, named as the
 * buttons say them (fix round 2: "give it back another way" named nothing the
 * screen could do, so the to-do and Try again never went away).
 */
const WAYS_OUT = 'press Try again, or hand it back in cash and press "Give it back in cash instead"'
/**
 * Fix pass 3 (#47a): a move-out deposit part says the press comes FIRST —
 * "Give it back in cash instead" checks the part fresh and only then says
 * "Hand back $X in cash now.", so no cash leaves the drawer for a refund that
 * later turns out to have reached the card. The early check-out's and the
 * paid-ahead screen's parts keep WAYS_OUT exactly as before.
 */
const DEPOSIT_WAYS_OUT = 'press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash'
const waysOut = (p: { deposit_return_id?: string | null }) => p.deposit_return_id ? DEPOSIT_WAYS_OUT : WAYS_OUT
/**
 * 10/4 (decisions #51): a move-out deposit part not sent yet whose payment the
 * tenant disputed, or their bank returned, since — the share the dispute or
 * return took (services/depositRefundSend.noteDepositRefundOfReturnedPayment).
 * Defined here so the runner can refuse to send one (fix pass 3); re-exported
 * by depositRefundSend.
 */
export const DEPOSIT_PART_TAKEN_BACK = 'Nothing more goes back: the tenant disputed or returned the payment this came from, ' +
  'so their card company or bank already gave that money back to them.'
const BEING_SENT = 'This refund is being sent to the card right now — wait a moment, then open the stay again.'

/**
 * Send one card or bank part through Stripe, then record it: the part
 * refunded, the landlord's payout netted by what the guest got back (#38 Q4),
 * and — for a register sale — the sale's refund row. A failure is recorded in
 * plain words for Try again. A part that was tried before first looks for a
 * refund Stripe already made for it (so a try whose answer was lost never
 * sends the money twice); a new try uses a new key, because Stripe replays a
 * failed answer for a key it has seen.
 */
export async function runCardPart(partId: string, opts: { waitMs?: number } = {}): Promise<boolean> {
  const lock = await getClient()
  const key = `stay-refund-part:${partId}`
  try {
    // Fix pass 2: someone else can hold the part's lock for a moment — a
    // late Stripe answer for an earlier try checks it (stripeRefundFailed),
    // or another press is sending it. A press that asked to (Try again)
    // waits a short while for it; false = this call sent nothing, so the
    // caller can say so instead of answering as if it had tried.
    let tries = Math.ceil(Math.max(0, opts.waitMs ?? 0) / 100)
    let got = false
    for (;;) {
      got = !!(await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key])).rows[0]?.ok
      if (got || tries-- <= 0) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!got) return false   // another request is on this part right now
    try { await sendCardPart(partId) } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]).catch(() => {})
    }
    return true
  } finally { lock.release() }
}

/** How long a press waits for a part another request holds for a moment (fix pass 2). */
const PRESS_WAIT_MS = 3000
const BUSY_TRY_AGAIN = 'This refund was being worked on by another request at that same moment, so it was not sent again. Wait a moment, then press Try again.'

/** A refund Stripe already made for this part on an earlier try (its answer lost), null for none, 'unreachable' when Stripe could not be asked. */
export async function findSentRefund(stripe: any, part: { id: string; stripe_payment_intent_id: string }): Promise<any | null | 'unreachable'> {
  try {
    const list = await stripe.refunds.list({ payment_intent: part.stripe_payment_intent_id, limit: 100 })
    return (list?.data ?? []).find((r: any) => r?.metadata?.gam_stay_refund_part_id === part.id
      && r.status !== 'failed' && r.status !== 'canceled') ?? null
  } catch (err) {
    logger.warn({ err, partId: part.id }, '[early-checkout] could not look up an earlier refund try')
    return 'unreachable'
  }
}

/**
 * Fix round 2: what a register sale still has to give back for this part —
 * the sale total less every refund recorded on it (one Stripe sent back no
 * longer counts) and less every OTHER part still waiting to go out on it.
 * Read with the sale locked: the register's refund takes the same lock and
 * keeps waiting parts off what it can refund (routes/pos), so once this says
 * there is room, nothing else can spend it before the part goes out.
 */
async function saleRoomFor(client: PoolClient, part: { id: string; pos_transaction_id: string }): Promise<number> {
  const t = (await client.query<{ total: number; status: string }>(
    `SELECT total::float AS total, status FROM pos_transactions WHERE id = $1 FOR UPDATE`, [part.pos_transaction_id])).rows[0]
  if (!t || t.status === 'voided') return 0
  const used = (await client.query<{ n: number }>(
    `SELECT (COALESCE((SELECT SUM(r.amount) FROM pos_refunds r
                        WHERE r.transaction_id = $1 AND r.reversed_at IS NULL AND r.stay_refund_part_id IS DISTINCT FROM $2::uuid), 0)
           + COALESCE((SELECT SUM(rp.amount) FROM stay_refund_parts rp
                        WHERE rp.pos_transaction_id = $1 AND rp.id <> $2::uuid AND rp.status IN ('pending', 'failed')
                          AND ${livePartSql('rp')}), 0))::float AS n`, [part.pos_transaction_id, part.id])).rows[0].n
  return round2(t.total - used)
}

/** What a register sale has open in early check-out card refunds still to go out (the register keeps it off what it can refund). */
export async function saleRefundsWaiting(client: Pick<PoolClient, 'query'>, saleId: string): Promise<number> {
  return round2((await client.query<{ n: number }>(
    `SELECT COALESCE(SUM(rp.amount), 0)::float AS n FROM stay_refund_parts rp
      WHERE rp.pos_transaction_id = $1 AND rp.kind IN ('card', 'bank') AND rp.status IN ('pending', 'failed')
        AND ${livePartSql('rp')}`, [saleId])).rows[0].n)
}

/**
 * Review fix (choice46b): where a refund part is read from. A part of the
 * paid-ahead money screen (paid_ahead_choice_id, services/paidAheadChoice) on
 * an ordinary lease has no stay (booking_id NULL), so every read of a part
 * LEFT JOINs the stay, takes the unit from the stay or else from the choice's
 * lease, and skips the stay-only steps (its booking event, finishDecision).
 * The early check-out's own parts always have their stay, so nothing changes
 * for them.
 */
const PART_FROM_SQL = `stay_refund_parts p
       LEFT JOIN unit_bookings b ON b.id = p.booking_id
       LEFT JOIN paid_ahead_choices pc ON pc.id = p.paid_ahead_choice_id
       LEFT JOIN leases pcl ON pcl.id = pc.lease_id
       LEFT JOIN units pcu ON pcu.id = pcl.unit_id
       LEFT JOIN deposit_returns dpr ON dpr.id = p.deposit_return_id
       LEFT JOIN leases dpl ON dpl.id = dpr.lease_id`
/**
 * 10/4 (decisions #47a): a part of a finalized move-out's deposit refund
 * (deposit_return_id, services/depositRefundSend) has no stay and no choice:
 * its unit is its lease's, and it is told and offered on the move-out page.
 */
const PART_CTX_COLS = `b.guest_name, COALESCE(b.unit_id, pcl.unit_id, dpl.unit_id) AS unit_id,
            pc.lease_id AS choice_lease_id, pcu.unit_number AS choice_unit, dpr.lease_id AS deposit_lease_id`
/** The paid-ahead money screen of a lease (services/paidAheadChoice.paidAheadChoicePath; not imported: that file imports this one). */
const choiceScreen = (leaseId: string) => `/leases/${leaseId}/paid-ahead-choice`
/** "money paid ahead on MH 08" — a paid-ahead screen part, named for the landlord (never "left early"). */
const paidAheadWords = (unit: string | null) => `money paid ahead${unit ? ` on ${unit}` : ''}`
/**
 * Where a refund part goes, in words (review fix pass 3): a paid-ahead screen
 * part to a bank says "their bank" — never "the card". The early check-out's
 * own parts keep "the card" as they always said it.
 */
const partTo = (p: { paid_ahead_choice_id?: string | null; deposit_return_id?: string | null; kind?: string | null }) =>
  (p.paid_ahead_choice_id || p.deposit_return_id) && p.kind === 'bank' ? 'their bank' : 'the card'

/**
 * 10/4 (decisions #47a): a move-out deposit refund the original payment can
 * no longer take because it is too old for the card company or bank (Stripe's
 * charge_expired_for_refund). Trying again cannot help, so the only way out
 * offered is the cash one.
 */
export const DEPOSIT_PART_TOO_OLD = 'This payment is too old for the card company or bank to take a refund, so nothing was sent. ' +
  'Press "Give it back in cash instead" — it tells you when to hand over the cash.'
const tooOldForRefund = (err: any): boolean =>
  err?.code === 'charge_expired_for_refund' || err?.raw?.code === 'charge_expired_for_refund'
/**
 * Fix pass 2 (#47a): a move-out deposit refund on a payment the tenant has
 * disputed (Stripe's charge_disputed) — the card company or bank takes no
 * refund on it, so trying again cannot help; the cash way out is offered.
 */
export const DEPOSIT_PART_DISPUTED = 'The tenant disputed the payment this came from, so the card company or bank will not take a refund on it. ' +
  'Nothing was sent. Press "Give it back in cash instead" — it tells you when to hand over the cash.'
const disputedForRefund = (err: any): boolean => err?.code === 'charge_disputed' || err?.raw?.code === 'charge_disputed'

async function sendCardPart(partId: string): Promise<void> {
  const part = await queryOne<any>(
    `SELECT p.*, p.amount::float AS amt, p.payout_drop::float AS drop, p.card_fee_back::float AS fee_back,
            ${PART_CTX_COLS}
       FROM ${PART_FROM_SQL} WHERE p.id = $1`, [partId])
  if (!part || !['pending', 'failed'].includes(part.status) || !['card', 'bank'].includes(part.kind) || part.reversed_at) return
  // Fix pass 3: a share a dispute or bank return already gave back is never
  // sent too. Read under the part's lock (runCardPart), which the dispute
  // pass also takes, so a send queued before the dispute sees it stopped.
  if (part.failure === DEPOSIT_PART_TAKEN_BACK) return
  const { getStripe } = await import('../lib/stripe')
  const stripe: any = getStripe()
  let refund: any = null
  if (part.attempts > 0) {
    const found = await findSentRefund(stripe, part)
    if (found === 'unreachable') {
      await markFailed(partId, `Stripe could not be reached just now — ${waysOut(part)}.`, 'not_sent')
      return
    }
    refund = found
  }
  // A legacy destination charge: the refund takes the money back from the
  // landlord's Connect balance at Stripe (reverse_transfer), so no payout line too.
  let reverse = !!refund && (refund?.metadata?.gam_reverse_transfer === '1' || !!refund?.transfer_reversal)
  if (!refund) {
    // Fix round 2: never more than the sale still has to give back — money
    // already refunded at the register is never sent to the card as well.
    if (part.pos_transaction_id) {
      let room: number | null = null
      const c = await getClient()
      try {
        await c.query('BEGIN')
        room = await saleRoomFor(c, part)
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {})
        logger.error({ err, partId }, '[early-checkout] could not check the sale before a card refund')
      } finally { c.release() }
      if (room == null) {
        await markFailed(partId, 'GAM could not check the sale just now, so nothing was sent — press Try again.', 'not_sent')
        return
      }
      if (room < part.amt - 0.005) {
        logger.error({ partId, room, amount: part.amt }, '[early-checkout] a card refund was not sent: the register already gave that money back')
        await markFailed(partId, part.paid_ahead_choice_id
          ? `Nothing was sent to ${partTo(part)}: this sale was already refunded at the register, so only ${money(Math.max(0, room))} is left on it. Ask the owner to check what the tenant got back before giving anything more.`
          : `Nothing was sent to the card: this sale was already refunded at the register, so only ${money(Math.max(0, room))} is left on it. Ask the owner to check what the guest got back before giving anything more.`, 'no_room')
        return
      }
    }
    const attempt = (await queryOne<{ attempts: number }>(
      `UPDATE stay_refund_parts SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`, [partId]))!.attempts
    try {
      reverse = false
      try {
        const pi = await stripe.paymentIntents.retrieve(part.stripe_payment_intent_id)
        reverse = !!pi?.transfer_data
      } catch { /* a platform charge needs nothing more */ }
      refund = await stripe.refunds.create({
        payment_intent: part.stripe_payment_intent_id,
        amount: toCents(part.amt),
        ...(reverse ? { reverse_transfer: true } : {}),
        // The webhook (refund.updated) finds every refund part by this
        // purpose and the part's own tag, whichever screen made it.
        metadata: { gam_purpose: 'stay_early_checkout_refund', gam_stay_refund_part_id: part.id,
                    gam_landlord_id: part.landlord_id,
                    ...(part.booking_id ? { gam_booking_id: part.booking_id } : {}),
                    ...(part.paid_ahead_choice_id ? { gam_paid_ahead_choice_id: part.paid_ahead_choice_id } : {}),
                    ...(part.deposit_return_id ? { gam_deposit_return_id: part.deposit_return_id } : {}),
                    ...(reverse ? { gam_reverse_transfer: '1' } : {}) },
      }, { idempotencyKey: `gam-stay-refund-${part.id}-${attempt}` })
    } catch (err: any) {
      logger.error({ err, partId }, '[early-checkout] a card refund could not be sent')
      // A move-out deposit part (#47a): a payment too old to refund is said
      // so — Try again cannot help. The early check-out's and the paid-ahead
      // screen's parts keep their words exactly as before.
      if (part.deposit_return_id && tooOldForRefund(err)) {
        await markFailed(partId, DEPOSIT_PART_TOO_OLD, 'too_old')
        return
      }
      if (part.deposit_return_id && disputedForRefund(err)) {
        await markFailed(partId, DEPOSIT_PART_DISPUTED, 'disputed')
        return
      }
      await markFailed(partId, `Stripe could not send this refund just now — ${waysOut(part)}.`, 'not_sent')
      return
    }
  }
  if (refund?.status === 'failed' || refund?.status === 'canceled') {
    // A paid-ahead screen part to a bank says the bank (review fix, choice46b pass 2).
    const turnedDownBy = (part.paid_ahead_choice_id || part.deposit_return_id) && part.kind === 'bank' ? 'Their bank' : 'The card company'
    await markFailed(partId, `${turnedDownBy} turned this refund down — ${waysOut(part)}.`, 'turned_down')
    return
  }
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const locked = (await client.query<{ status: string }>(
      `SELECT status FROM stay_refund_parts WHERE id = $1 FOR UPDATE`, [partId])).rows[0]
    if (!locked || locked.status === 'refunded') { await client.query('ROLLBACK'); return }
    await client.query(
      `UPDATE stay_refund_parts SET status = 'refunded', stripe_refund_id = $2, refunded_at = NOW(), failure = NULL WHERE id = $1`,
      [partId, refund.id])
    // The refund left GAM's balance: the landlord's next payout carries it,
    // the card fee given back included (#38 Q4) — one line per refund. A
    // reverse_transfer already took it from the landlord at Stripe: taken once.
    if (part.drop > 0 && !reverse) {
      await recordHeldItem({
        landlordId: part.landlord_id, sourceType: 'refund', sourceId: refund.id, amount: -part.drop,
        description: part.paid_ahead_choice_id
          ? `Refund of ${paidAheadWords(part.choice_unit)} (card fee included)`
          : `Refund to ${part.guest_name || 'a guest'} who left early (card fee included)`,
      }, client)
    }
    if (part.pos_transaction_id) {
      const had = (await client.query<{ id: string }>(
        `SELECT id FROM pos_refunds WHERE stay_refund_part_id = $1`, [partId])).rows[0]
      if (had) {
        await client.query(`UPDATE pos_refunds SET stripe_refund_id = $2 WHERE id = $1`, [had.id, refund.id])
      } else {
        const refundRow = await recordSaleRefund(client, {
          saleId: part.pos_transaction_id, landlordId: part.landlord_id, amount: part.amt, method: 'card',
          // A paid-ahead screen part is named as money paid ahead, never "left early" (choice46b pass 2).
          reason: part.paid_ahead_choice_id ? `Refund of ${paidAheadWords(part.choice_unit)}` : `${part.guest_name || 'Guest'} left early`,
          stripeRefundId: refund.id,
          cardFeeRefunded: part.fee_back, stayRefundPartId: partId,
        })
        await client.query(`UPDATE stay_refund_parts SET pos_refund_id = $2 WHERE id = $1`, [partId, refundRow])
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    // The money went back at Stripe; only the record failed. Said loudly — the
    // next open of the stay (or Try again) finds Stripe's refund and records it.
    logger.error({ err, partId, refundId: refund?.id }, '[early-checkout] a card refund went out but could not be recorded — it will be recorded on the next try')
    await markFailed(partId, `The refund went to ${partTo(part)}, but GAM could not finish recording it — press Try again.`, 'not_recorded')
  } finally {
    // Fix pass (review r3): the recording connection was never given back —
    // every card or bank refund kept one, until the pool ran dry (20 refunds).
    client.release()
  }
}

/**
 * A card or bank part that did not go out (or went out and could not be
 * recorded) is marked failed in plain words for Try again. The first time a
 * part fails, the owner is told (a webhook failure of a sent refund tells them
 * from stripeRefundFailed): it shows on the schedule and in their to-dos until
 * someone who can issue refunds sends it, or gives it back in cash instead.
 */
async function markFailed(partId: string, words: string, why: PartWhy): Promise<void> {
  const r = await queryOne<{ was: string }>(
    `WITH old AS (SELECT id, status FROM stay_refund_parts WHERE id = $1 FOR UPDATE)
     UPDATE stay_refund_parts p SET status = 'failed', failure = $2, refunded_at = NULL
       FROM old WHERE p.id = old.id AND old.status IN ('pending', 'failed')
        AND p.failure IS DISTINCT FROM $3
     RETURNING old.status AS was`, [partId, words, DEPOSIT_PART_TAKEN_BACK])
  if (r?.was === 'pending') {
    await tellOwnerRefundFailed(partId, why).catch((err) => logger.error({ err, partId }, '[early-checkout] could not tell the owner a refund failed'))
  }
}

async function tellOwnerRefundFailed(partId: string, why: PartWhy | 'sent_back'): Promise<void> {
  const p = await queryOne<{ landlord_id: string; booking_id: string | null; unit_id: string; guest_name: string | null; amt: number; kind: string
                             paid_ahead_choice_id: string | null; choice_lease_id: string | null; choice_unit: string | null
                             deposit_return_id: string | null }>(
    `SELECT p.landlord_id, p.booking_id, p.amount::float AS amt, p.kind, p.paid_ahead_choice_id, p.deposit_return_id, ${PART_CTX_COLS}
       FROM ${PART_FROM_SQL} WHERE p.id = $1`, [partId])
  if (!p) return
  // A move-out deposit refund part (#47a): told by the move-out's own words —
  // the owner's notice opens the move-out page, and GAM is told too.
  if (p.deposit_return_id) {
    const { tellDepositPartFailed } = await import('./depositRefundSend')
    await tellDepositPartFailed(partId, why)
    return
  }
  const where = p.kind === 'bank' ? 'their bank' : 'their card'
  // A part of the paid-ahead money screen: named as money paid ahead on the
  // lease, and the notice opens that screen — never "left early" or "open the
  // stay" (the lease may have simply ended, and may have no stay at all).
  if (p.paid_ahead_choice_id && p.choice_lease_id) {
    const what = paidAheadWords(p.choice_unit)
    const said = why === 'not_recorded'
      ? `The ${money(p.amt)} refund of ${what} went to ${where}, but GAM could not finish recording it.`
      : why === 'no_room'
        ? `The ${money(p.amt)} refund of ${what} was not sent to ${where}: the register had already refunded that sale.`
      : why === 'turned_down'
        ? `The ${money(p.amt)} refund of ${what} was turned down by ${p.kind === 'bank' ? 'their bank' : 'the card company'}.`
        : why === 'sent_back'
          ? `The ${money(p.amt)} refund of ${what} could not reach ${where}.`
          : `The ${money(p.amt)} refund of ${what} could not be sent to ${where}.`
    await tellOwner(p.landlord_id, {
      type: 'stay_refund_failed',
      title: why === 'sent_back' ? `A refund of ${what} came back` : `A refund of ${what} did not go out`,
      body: why === 'not_recorded'
        ? `${said} Open the lease's money paid ahead and press Try again.`
        : why === 'no_room'
          ? `${said} Check what the tenant got back at the register before giving anything more.`
          : `${said} Open the lease's money paid ahead and press Try again, or hand it back in cash and press "Give it back in cash instead".`,
      bookingId: p.booking_id, unitId: p.unit_id,
      actionUrl: choiceScreen(p.choice_lease_id), data: { leaseId: p.choice_lease_id, paidAheadChoiceId: p.paid_ahead_choice_id },
    })
    return
  }
  const guest = p.guest_name || 'the guest'
  const what = why === 'not_recorded'
    ? `The ${money(p.amt)} refund to ${guest} who left early went to ${where}, but GAM could not finish recording it.`
    : why === 'turned_down'
      ? `The ${money(p.amt)} refund to ${guest} who left early was turned down by the card company.`
      : why === 'sent_back'
        ? `The ${money(p.amt)} refund to ${guest} who left early could not reach ${where}.`
        : why === 'no_room'
          ? `The ${money(p.amt)} refund to ${guest} who left early was not sent to ${where}: the register had already refunded that sale.`
          : `The ${money(p.amt)} refund to ${guest} who left early could not be sent to ${where}.`
  await tellOwner(p.landlord_id, {
    type: 'stay_refund_failed',
    title: why === 'sent_back' ? `A refund to ${p.guest_name || 'a guest'} came back` : `A refund to ${p.guest_name || 'a guest'} did not go out`,
    body: why === 'no_room'
      ? `${what} Check what the guest got back at the register before giving anything more.`
      : why === 'not_recorded'
        ? `${what} Open the stay on the schedule and press Try again.`
        : `${what} Open the stay on the schedule and press Try again, or hand it back in cash and press "Give it back in cash instead".`,
    bookingId: p.booking_id, unitId: p.unit_id,
  })
}

/**
 * SQL, on a unit_bookings alias: a decided early check-out with a card or bank
 * refund that still has to go out — failed, or still "sending" after 10
 * minutes (a crash between the decision and Stripe). The schedule shows Try
 * again on it and the owner's to-dos list it.
 */
export const refundNeedsRetrySql = (b: string) => `EXISTS (
  SELECT 1 FROM stay_refund_parts rp JOIN stay_checkout_decisions sd ON sd.id = rp.decision_id
   WHERE rp.booking_id = ${b}.id AND sd.status = 'decided' AND rp.kind IN ('card', 'bank')
     AND (rp.status = 'failed' OR (rp.status = 'pending' AND rp.created_at < NOW() - INTERVAL '10 minutes')))`

/** Try again on a card or bank part that failed (or is still waiting after a crash). Same safety as the first try. */
export async function retryRefundPart(partId: string, bookingId: string): Promise<DecideResult> {
  const part = await queryOne<{ decision_id: string; booking_id: string; status: string }>(
    `SELECT decision_id, booking_id, status FROM stay_refund_parts WHERE id = $1`, [partId])
  if (!part || part.booking_id !== bookingId) throw new AppError(404, 'That refund is not on this stay — close this window and open the stay again.')
  const ran = part.status === 'failed' || part.status === 'pending' ? await runCardPart(partId, { waitMs: PRESS_WAIT_MS }) : true
  const out = await finishDecision(part.decision_id, bookingId, { handBackAll: false })
  // Fix pass 2: the lock was held the whole wait — say so once, with the next
  // step, rather than show the same failure again as if it had been tried.
  if (!ran && out.decision?.parts.some((p) => p.id === partId && (p.status === 'failed' || p.status === 'pending'))) {
    out.words = [BUSY_TRY_AGAIN, ...out.words]
  }
  return out
}

/**
 * Card parts left waiting (a crash between the decision and Stripe) are sent
 * again when someone opens the stay — at most once per 10 minutes of quiet.
 */
export async function resumeStaleParts(bookingId: string): Promise<void> {
  const stale = await query<{ id: string }>(
    `SELECT id FROM stay_refund_parts
      WHERE booking_id = $1 AND status = 'pending' AND kind IN ('card', 'bank')
        AND created_at < NOW() - INTERVAL '10 minutes'`, [bookingId])
  for (const p of stale) await runCardPart(p.id).catch((err) => logger.error({ err, partId: p.id }, '[early-checkout] resume failed'))
}

/**
 * Fix round 2: "Give it back in cash instead" — someone with "Issue refunds"
 * hands the guest the money at the desk for a card or bank part that did not
 * go out. Recorded, so it is never sent to the card as well: the failed part
 * becomes 'replaced' (it never went out) and a new cash part, handed back now,
 * takes its place (replaces_part_id) — on a register sale with its own cash
 * refund row (the card fee given back with it, #38 Q4, as the card refund
 * would have). The to-do and Try again go away with it. Nothing on the
 * landlord's payout changes: the card refund never left GAM's balance (or,
 * when Stripe sent it back, its payout line was already put back), and the
 * cash comes out of their drawer. Before anything is recorded, Stripe is
 * asked whether an earlier try reached the card after all — then that is
 * recorded instead and no cash is handed back.
 */
export async function givePartBackInCash(partId: string, bookingId: string | null, actorUserId: string): Promise<DecideResult> {
  const part = await queryOne<any>(
    `SELECT p.*, p.amount::float AS amt, p.card_fee_back::float AS fee_back, b.landlord_id AS stay_landlord, ${PART_CTX_COLS}
       FROM ${PART_FROM_SQL} WHERE p.id = $1`, [partId])
  // Review fix (choice46b): a part of the paid-ahead money screen is given back
  // here too (bookingId null — its caller checked the lease); its stay, when it
  // has one, is not what it is for, so the stay-only steps are skipped below.
  // 10/4 (decisions #47a): so is a part of a finalized move-out's deposit
  // refund (bookingId null — services/depositRefundSend checked the lease).
  const ofDeposit = !!part?.deposit_return_id
  const ofChoice = !!part?.paid_ahead_choice_id || ofDeposit
  if (!part || (bookingId === null ? !ofChoice : part.booking_id !== bookingId)) {
    throw new AppError(404, 'That refund is not on this stay — close this window and open the stay again.')
  }
  const beingSent = ofChoice
    ? `This refund is being sent to ${part?.kind === 'bank' ? 'their bank' : 'the card'} right now, so nothing was handed back. Wait a moment, then press it again.`
    : BEING_SENT
  if (part.status === 'pending' && ['card', 'bank'].includes(part.kind)) throw new AppError(409, beingSent)
  /** What stands now (a paid-ahead screen part has no check-out decision: its own screen says the rest). */
  const standing = (): Promise<DecideResult> => ofChoice
    ? Promise.resolve({ bookingId: bookingId ?? part.booking_id ?? '', checkedOut: true, decision: null, next: 'done', words: [] })
    : finishDecision(part.decision_id, bookingId!, { handBackAll: false })
  // Nothing is waiting on this part any more (it went out, or was already
  // given back): what stands now, nothing handed back. Fix pass 4 (deposit
  // refund): nor a move-out part a dispute or bank return already stopped
  // (DEPOSIT_PART_TAKEN_BACK) — the dispute gave that money back, so handing
  // it over in cash too would pay the tenant twice and pay the landlord money
  // GAM no longer holds. (Early check-out and paid-ahead parts never carry it.)
  if (part.status !== 'failed' || !['card', 'bank'].includes(part.kind) || part.reversed_at
      || part.failure === DEPOSIT_PART_TAKEN_BACK) {
    return standing()
  }
  const who = part.guest_name || 'Guest'
  const lock = await getClient()
  const key = `stay-refund-part:${partId}`
  let sentAfterAll = false
  let handed = 0
  try {
    const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key])).rows[0]?.ok
    if (!got) throw new AppError(409, beingSent)
    try {
      if (part.attempts > 0) {
        const { getStripe } = await import('../lib/stripe')
        const found = await findSentRefund(getStripe(), part)
        if (found === 'unreachable') {
          throw new AppError(503, `GAM could not reach Stripe to check whether this refund already went to ${ofChoice ? partTo(part) : 'the card'}, so nothing was changed. Wait a minute, then press it again.`)
        }
        sentAfterAll = !!found
      }
      if (!sentAfterAll) {
        await lock.query('BEGIN')
        try {
          // Read again under the part's lock: a dispute applied between the
          // first read and this lock (noteDepositRefundOfReturnedPayment) may
          // have stopped it — then nothing is handed back (fix pass 4).
          const cur = (await lock.query<{ status: string; reversed_at: Date | null; failure: string | null }>(
            `SELECT status, reversed_at, failure FROM stay_refund_parts WHERE id = $1 FOR UPDATE`, [partId])).rows[0]
          if (cur?.status === 'failed' && !cur.reversed_at && cur.failure !== DEPOSIT_PART_TAKEN_BACK) {
            const cashId = (await lock.query<{ id: string }>(
              `INSERT INTO stay_refund_parts
                 (decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, remittance_id, prepaid_credit_id,
                  pos_transaction_id, toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label,
                  status, refunded_at, replaces_part_id)
               SELECT decision_id, booking_id, landlord_id, seq, 'cash', stay_payment_id, remittance_id, prepaid_credit_id,
                      pos_transaction_id, toward_amount, card_fee_back, amount, 0, lodging_tax_share, label,
                      'handed_back', NOW(), id
                 FROM stay_refund_parts WHERE id = $1
               RETURNING id`, [partId])).rows[0].id
            await lock.query(`UPDATE stay_refund_parts SET status = 'replaced', failure = NULL WHERE id = $1`, [partId])
            // 10/4 (decisions #47a): a move-out deposit refund is money GAM
            // holds. Handed back from the office's cash instead, GAM pays the
            // landlord what it held for it, once, on their next payout — in
            // this same transaction, so it is never lost nor paid twice.
            if (ofDeposit) {
              const { releaseDepositCashPart } = await import('./depositRefundSend')
              await releaseDepositCashPart(lock, cashId)
            }
            if (part.pos_transaction_id) {
              const refundId = await recordSaleRefund(lock as PoolClient, {
                saleId: part.pos_transaction_id, landlordId: part.landlord_id, amount: part.amt, method: 'cash',
                reason: ofChoice
                  ? `Refund of ${paidAheadWords(part.choice_unit)} (given back in cash instead of to the ${part.kind === 'bank' ? 'bank' : 'card'})`
                  : `${who} left early (given back in cash instead of to the card)`,
                cardFeeRefunded: part.fee_back, stayRefundPartId: cashId,
              })
              await lock.query(`UPDATE stay_refund_parts SET pos_refund_id = $2 WHERE id = $1`, [cashId, refundId])
            }
            // The stay's own history — only for an early check-out's part (a
            // paid-ahead screen part is not a stay event, and may have no stay;
            // nor is a move-out deposit part).
            if (!ofChoice) {
              await recordBookingEvent({
                client: lock, bookingId: bookingId!, unitId: part.unit_id, landlordId: part.landlord_id, actorUserId,
                eventType: 'money_settled',
                summary: `${who} left early — the ${money(part.amt)} refund that did not go to the ${part.kind === 'bank' ? 'bank' : 'card'} was handed back in cash`,
                detail: { decision_id: part.decision_id, replaced_part_id: partId, cash_part_id: cashId, amount: part.amt, given_in_cash: true },
              })
            }
            handed = part.amt
          }
          await lock.query('COMMIT')
        } catch (e) {
          await lock.query('ROLLBACK').catch(() => {})
          throw e
        }
      }
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]).catch(() => {})
    }
  } finally { lock.release() }
  if (sentAfterAll) {
    const ran = await runCardPart(partId, { waitMs: PRESS_WAIT_MS })
    const out = await standing()
    const said = [`This refund had already gone to ${ofChoice && part.kind === 'bank' ? 'their bank' : 'the card'} after all, so nothing is handed back in cash.`]
    if (!ran) said.push('It is being recorded right now — wait a moment, then press Try again to finish recording it.')
    return { ...out, words: [...said, ...out.words] }
  }
  const out = await standing()
  if (handed > 0) out.words = [`Hand back ${money(handed)} in cash now.`, ...out.words]
  return out
}

/**
 * Stripe said a refund failed after it was sent (a card closed since, a bank
 * that sent it back). Fix round 2: the day it went out is never rewritten — a
 * reversing entry is dated on the day it came back. Inside one transaction:
 * the part keeps its record (still 'refunded' on its own day) and is marked
 * reversed now; a NEW part (replaces_part_id) carries what is still owed to
 * the guest, failed in plain words for Try again or "Give it back in cash
 * instead"; the money taken from the landlord's payout for it is put back
 * (+held item keyed "<refund>:failed" — only when a payout line took it); and
 * for a register sale, the sale's card refund row stays and is marked
 * reversed, so it no longer counts toward what the sale has refunded, and
 * income and the end-of-day close add it back on this day. The owner is told.
 * Returns false when the refund is not one of these. The stay keeps its
 * "nothing owed" stamp: the guest owes nothing; the refund is what is still
 * owed to them, and it is on the schedule and in the owner's to-dos until it
 * is sent or given back in cash.
 *
 * Fix pass (review r3): Stripe can say a refund failed BEFORE the send that
 * made it has recorded it (a bank refund, or a card refund that fails at
 * once): the part is then found by the refund's own tag
 * (metadata.gam_stay_refund_part_id). While that send is still running (it
 * holds the part's lock, runCardPart) the answer is 'retry' — the webhook
 * answers 500 and Stripe sends it again, by when the part carries the refund
 * and is reversed above. Once no send is running and the part never recorded
 * this refund, nothing went out on it: the send saw the failure and left the
 * part failed for Try again (or a later try sent another refund), so there is
 * nothing to put back. Never answered as "not ours" — that lost the failure.
 */
export async function stripeRefundFailed(refund: { id: string; status?: string | null; metadata?: Record<string, string> | null }): Promise<boolean | 'retry'> {
  if (refund.status !== 'failed' && refund.status !== 'canceled') return false
  const byRefund = () => queryOne<any>(
    `SELECT p.id, p.landlord_id, p.booking_id, p.payout_drop::float AS drop, p.amount::float AS amt,
            p.pos_transaction_id, p.paid_ahead_choice_id, p.deposit_return_id, p.kind, ${PART_CTX_COLS}
       FROM ${PART_FROM_SQL}
      WHERE p.stripe_refund_id = $1`, [refund.id])
  let part = await byRefund()
  if (!part) {
    const tagged = String(refund.metadata?.gam_stay_refund_part_id ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(tagged)) return false
    const lock = await getClient()
    try {
      const key = `stay-refund-part:${tagged}`
      const got = (await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key])).rows[0]?.ok
      if (!got) return 'retry'   // the send is recording it right now
      try {
        part = await byRefund()
        if (!part) {
          const known = await queryOne<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE id = $1`, [tagged])
          return !!known
        }
      } finally {
        await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]).catch(() => {})
      }
    } finally { lock.release() }
  }
  const client = await getClient()
  let replacement: string | null = null
  try {
    await client.query('BEGIN')
    // The part first, then the sale — the order sendCardPart takes them in.
    const r = await client.query(
      `UPDATE stay_refund_parts SET reversed_at = GREATEST(NOW(), refunded_at)
        WHERE id = $1 AND status = 'refunded' AND reversed_at IS NULL`, [part.id])
    if ((r.rowCount ?? 0) > 0) {
      replacement = (await client.query<{ id: string }>(
        `INSERT INTO stay_refund_parts
           (decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, remittance_id, prepaid_credit_id,
            pos_transaction_id, stripe_payment_intent_id, toward_amount, card_fee_back, amount, payout_drop,
            lodging_tax_share, label, status, failure, replaces_part_id)
         SELECT decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, remittance_id, prepaid_credit_id,
                pos_transaction_id, stripe_payment_intent_id, toward_amount, card_fee_back, amount, payout_drop,
                lodging_tax_share, label, 'failed', $2, id
           FROM stay_refund_parts WHERE id = $1
         RETURNING id`, [part.id, `${(part.paid_ahead_choice_id || part.deposit_return_id) && part.kind === 'bank' ? 'Their bank' : 'The card company'} sent this refund back — ${waysOut(part)}.`])).rows[0].id
      // Put back only what a payout line took (a reverse_transfer took it at Stripe instead).
      const took = (await client.query(
        `SELECT 1 FROM held_payout_items WHERE source_type = 'refund' AND source_id = $1`, [refund.id])).rows.length > 0
      if (took && part.drop > 0) {
        await recordHeldItem({
          landlordId: part.landlord_id, sourceType: 'refund', sourceId: `${refund.id}:failed`, amount: part.drop,
          description: part.paid_ahead_choice_id
            ? `A refund of ${paidAheadWords(part.choice_unit)} came back — put back on your payout until it is sent again`
            : `A refund to ${part.guest_name || 'a guest'} came back — the money is yours again until it is sent`,
        }, client)
      }
      if (part.pos_transaction_id) {
        await client.query(`SELECT 1 FROM pos_transactions WHERE id = $1 FOR UPDATE`, [part.pos_transaction_id])
        await client.query(
          `UPDATE pos_refunds SET reversed_at = GREATEST(NOW(), created_at)
            WHERE stay_refund_part_id = $1 AND reversed_at IS NULL`, [part.id])
        await client.query(
          `UPDATE pos_transactions t
              SET refund_amount = s.total,
                  refunded_at = s.last,
                  status = CASE WHEN s.total <= 0 THEN 'completed'
                                WHEN s.total >= t.total - 0.005 THEN 'refunded' ELSE 'partial_refund' END
             FROM (SELECT COALESCE(SUM(amount), 0) AS total, MAX(created_at) AS last
                     FROM pos_refunds WHERE transaction_id = $1 AND reversed_at IS NULL) s
            WHERE t.id = $1 AND t.status <> 'voided'`, [part.pos_transaction_id])
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
  if (replacement) await tellOwnerRefundFailed(replacement, 'sent_back').catch(() => {})
  return true
}

// ─── The owner's to-do ───────────────────────────────────────────────────────

async function tellOwner(landlordId: string, n: {
  type: string; title: string; body: string; bookingId: string | null; unitId: string | null
  /** Where the notice opens, when it is not the stay on the schedule (a paid-ahead screen part). */
  actionUrl?: string; data?: Record<string, unknown>
}): Promise<void> {
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [landlordId])
  if (!owner) return
  const { createNotification } = await import('./notifications')
  await createNotification({
    userId: owner.user_id, landlordId, type: n.type, title: n.title, body: n.body,
    data: { bookingId: n.bookingId, unitId: n.unitId, ...(n.data ?? {}) },
    actionUrl: n.actionUrl ?? `/schedule?checkout=${n.bookingId}&unit=${n.unitId}`,
  })
}

/** #38 Q5: an overpaid guest was checked out by someone who cannot refund — the owner gets a to-do. */
export async function tellOwnerMoneyWaits(bookingId: string): Promise<void> {
  const r = await queryOne<{ landlord_id: string; unit_id: string; guest_name: string | null; unit_number: string; paid: number; worth: number; question: string }>(
    `SELECT d.landlord_id, b.unit_id, b.guest_name, u.unit_number, d.paid::float AS paid, d.stayed_worth::float AS worth, d.question
       FROM stay_checkout_decisions d JOIN unit_bookings b ON b.id = d.booking_id JOIN units u ON u.id = b.unit_id
      WHERE d.booking_id = $1 AND d.status = 'pending'`, [bookingId])
  if (!r) return
  const guest = r.guest_name || 'A guest'
  await tellOwner(r.landlord_id, {
    type: 'stay_money_decision',
    title: `Decide the money for ${guest}'s early check-out — ${r.unit_number}`,
    body: r.question === 'overpaid'
      ? `${guest} left early and paid ${money(round2(Math.max(0, r.paid - r.worth)))} more than the nights they stayed are worth. Open the stay and choose: no refund, refund the unused nights, or a different amount.`
      : `${guest} left early and still owes for the stay. Open the stay and choose: keep the price as booked, or charge only the nights stayed.`,
    bookingId, unitId: r.unit_id,
  })
}

/**
 * The owner's dashboard to-do rows: every early check-out still waiting on
 * someone — a money question not decided yet, a card or bank refund that did
 * not go out (refundNeedsRetrySql), and a long stay whose lease did not end on
 * the day they left. Each opens the stay's Check out window.
 */
export async function pendingMoneyTodos(landlordIds: readonly string[]): Promise<Array<{ id: string; type: string; title: string; subtitle: string; href: string }>> {
  if (!landlordIds.length) return []
  const retry = await query<any>(
    `SELECT b.id AS booking_id, b.unit_id, b.guest_name, u.unit_number, p.name AS property_name,
            (SELECT SUM(rp.amount) FROM stay_refund_parts rp JOIN stay_checkout_decisions sd ON sd.id = rp.decision_id
              WHERE rp.booking_id = b.id AND sd.status = 'decided' AND rp.kind IN ('card', 'bank')
                AND (rp.status = 'failed' OR (rp.status = 'pending' AND rp.created_at < NOW() - INTERVAL '10 minutes')))::float AS amount
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id JOIN properties p ON p.id = u.property_id
      WHERE b.landlord_id = ANY($1::uuid[]) AND ${refundNeedsRetrySql('b')}
      ORDER BY b.updated_at`, [[...landlordIds]])
  const leaseRuns = await query<any>(
    `SELECT b.id AS booking_id, b.unit_id, b.guest_name, u.unit_number, p.name AS property_name,
            to_char(b.check_out, 'YYYY-MM-DD') AS left_on
       FROM unit_bookings b JOIN leases l ON l.source_booking_id = b.id
       JOIN units u ON u.id = b.unit_id JOIN properties p ON p.id = u.property_id
      WHERE b.landlord_id = ANY($1::uuid[]) AND ${LEASE_RUNS_PAST_SQL}
      ORDER BY b.updated_at`, [[...landlordIds]])
  const extra = [
    ...retry.map((r) => ({
      id: `stay-refund-${r.booking_id}`,
      type: 'stay_refund_retry',
      title: `Send the refund again: ${r.guest_name || 'a guest'} left early (${r.unit_number})`,
      subtitle: `${r.property_name} · ${money(Number(r.amount) || 0)} has not gone back to them yet`,
      href: `/schedule?checkout=${r.booking_id}&unit=${r.unit_id}`,
    })),
    ...leaseRuns.map((r) => ({
      id: `stay-lease-${r.booking_id}`,
      type: 'stay_lease_not_ended',
      title: `End the lease: ${r.guest_name || 'a guest'} left early (${r.unit_number})`,
      subtitle: `${r.property_name} · left ${shortDay(r.left_on)} · the lease did not end that day yet — open the stay to try again`,
      href: `/schedule?checkout=${r.booking_id}&unit=${r.unit_id}`,
    })),
  ]
  const rows = await query<any>(
    `SELECT d.booking_id, b.unit_id, b.guest_name, u.unit_number, p.name AS property_name, d.question,
            d.paid::float AS paid, d.stayed_worth::float AS worth, to_char(d.left_on, 'YYYY-MM-DD') AS left_on
       FROM stay_checkout_decisions d
       JOIN unit_bookings b ON b.id = d.booking_id
       JOIN units u ON u.id = b.unit_id JOIN properties p ON p.id = u.property_id
      WHERE d.landlord_id = ANY($1::uuid[]) AND d.status = 'pending'
      ORDER BY d.created_at`, [[...landlordIds]])
  return rows.map((r) => ({
    id: `stay-money-${r.booking_id}`,
    type: 'stay_money_decision',
    title: `Decide the money: ${r.guest_name || 'a guest'} left early (${r.unit_number})`,
    subtitle: r.question === 'overpaid'
      ? `${r.property_name} · left ${shortDay(r.left_on)} · paid ${money(round2(Math.max(0, r.paid - r.worth)))} more than the nights stayed`
      : `${r.property_name} · left ${shortDay(r.left_on)} · still owes for the stay`,
    href: `/schedule?checkout=${r.booking_id}&unit=${r.unit_id}`,
  })).concat(extra)
}

// ─── Undoing or correcting a check-out (the booking PATCH) ───────────────────

/**
 * #38 Q11: once a refund has gone out the check-out cannot be undone — nor the
 * day they left corrected, nor the stay's dates changed (it would change what
 * the refund was for). A stay already charged only the nights stayed keeps its
 * day too: correcting it would leave the price for the wrong nights. Null when
 * the change may go ahead.
 *
 * Fix pass (review r3): read with `q` = the booking PATCH's own transaction too
 * (onCheckOutUndone, with the stay's row and its decision locked) — the read
 * the PATCH makes before its transaction can be beaten by a refund decided at
 * that same moment on a stay already checked out.
 */
export type CheckOutChange = 'undo' | 'correct' | 'redate'
export async function checkOutChangeRefusal(bookingId: string, change: CheckOutChange, guest: string,
                                            q: Q = poolQ): Promise<string | null> {
  const d = (await q.query<{ status: string; choice: string | null; refund_total: number }>(
    `SELECT status, choice, refund_total::float AS refund_total FROM stay_checkout_decisions
      WHERE booking_id = $1 AND status IN ('pending', 'decided')`, [bookingId])).rows[0]
  if (!d || d.status !== 'decided') return null
  const parts = (await q.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM stay_refund_parts p JOIN stay_checkout_decisions d ON d.id = p.decision_id
      WHERE d.booking_id = $1 AND d.status = 'decided'`, [bookingId])).rows[0]
  if ((parts?.n ?? 0) > 0 || d.refund_total > 0) {
    return change === 'undo'
      ? `A refund already went to ${guest} for this early check-out, so the check-out can't be undone. Nothing was changed.`
      : change === 'redate'
        ? `A refund already went to ${guest} for this early check-out, so the stay's dates can't be changed. Nothing was changed.`
        : `A refund already went to ${guest} for this early check-out, so the day they left can't be changed. Nothing was changed.`
  }
  if (change === 'correct' && d.choice === 'nights_only') {
    return `${guest}'s stay was already charged only the nights they stayed, so the day they left can't be changed here. `
      + 'Put the check-out back first (set the status back), then check them out again on the right day.'
  }
  return null
}

/**
 * A check-out was put back (or its day corrected): its money question goes
 * with it, inside the caller's transaction. A stay that had been charged only
 * the nights stayed goes back to its booked price (and the paid stamp that
 * decision put on it comes off), so the guest is asked for the stay as booked.
 *
 * Fix pass (review r3, #38 Q11): the refusal is asked again here, with the
 * decision locked — a refund decided after the PATCH's first look (staff A
 * refunding while staff B saves the status back) refuses the change (409) and
 * the whole save rolls back, so a refund that went out is never left on an
 * undone check-out (where its Try again and owner to-do would vanish).
 */
export async function onCheckOutUndone(client: PoolClient, bookingId: string,
                                       ask?: { change: CheckOutChange; guest: string }): Promise<void> {
  const d = (await client.query<{ id: string; status: string; choice: string | null; booked_price: string; stamped_paid: boolean }>(
    `SELECT id, status, choice, booked_price::text, stamped_paid FROM stay_checkout_decisions
      WHERE booking_id = $1 AND status IN ('pending', 'decided') FOR UPDATE`, [bookingId])).rows[0]
  if (!d) return
  if (ask) {
    const refusal = await checkOutChangeRefusal(bookingId, ask.change, ask.guest, client)
    if (refusal) throw new AppError(409, refusal)
  }
  if (d.status === 'decided' && d.choice === 'nights_only') {
    await client.query(
      `UPDATE unit_bookings
          SET total_amount = $2::numeric,
              balance_paid_at = CASE WHEN $3::boolean THEN NULL ELSE balance_paid_at END,
              balance_billed_at = CASE WHEN $3::boolean THEN NULL ELSE balance_billed_at END,
              updated_at = NOW()
        WHERE id = $1`, [bookingId, d.booked_price, d.stamped_paid])
  }
  await client.query(
    `UPDATE stay_checkout_decisions SET status = 'undone', undone_at = NOW() WHERE id = $1`, [d.id])
}

/**
 * After the booking PATCH checked a guest out early (an API caller other than
 * the schedule's Check out window): a long stay's lease ends that day (#38 Q8)
 * and its paid-ahead money, or a short stay's money question, waits on the
 * stay as a pending decision with an owner to-do — nothing about the money is
 * decided there. Returns the words for the response, or null.
 */
export async function afterPatchEarlyCheckOut(bookingId: string, actorUserId: string): Promise<string | null> {
  const s = await loadStay(poolQ, bookingId)
  if (!s || s.status !== 'checked_out') return null
  // R11 (M8): the stay's utility agreement ends on the day they left.
  await syncStayUtilities(bookingId)
  // #38 Q8: the lease ends on the day they left. A failure is reported (GAM
  // and the owner) and tried again by healLeaseEnd; the response says so.
  if (s.lease_id && !(await endLeaseOnLeftDay(bookingId))) return LEASE_NOT_ENDED_WORDS
  const quote = await quoteEarlyCheckOut(poolQ, bookingId, { canRefund: true })
  if (quote.question === 'none' || quote.decision) return null
  const c = await getClient()
  let created = false
  try {
    await c.query('BEGIN')
    const locked = await loadStay(c, bookingId, { lock: true })
    if (locked && !(await liveDecision(c, bookingId))) {
      await upsertPending(c, locked, quote, actorUserId, null)
      created = true
    }
    await c.query('COMMIT')
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    logger.error({ err, bookingId }, '[early-checkout] PATCH check-out: could not record the money question')
    return null
  } finally { c.release() }
  if (created) await tellOwnerMoneyWaits(bookingId).catch(() => {})
  return quote.question === 'overpaid'
    ? `${quote.guest} paid ${money(quote.unused)} more than the nights they stayed are worth. What to do with it waits on the stay: open it on the schedule and press Decide the money.`
    : `${quote.guest} left early and still owes for the stay. Whether to keep the price as booked or charge only the nights stayed waits on the stay: open it on the schedule and press Decide the money.`
}
