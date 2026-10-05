// S655 money plan §3 / Step 12 (K-B, Nic 10/2): "Make a bank deposit".
//
// WHAT THIS IS FOR. Staff take cash, checks and money orders at the desk (and
// cash at the register), write each one down, and days later carry a bag to
// the bank. The bank then shows ONE number. Nothing tied that number back to
// the receipts inside it, so a landlord could not tell "the office banked
// Tuesday's $1,240" from "a tenant paid $1,240 at the branch" — and a bag that
// never arrived was invisible.
//
// A deposit slip is what staff put in the bag: the receipts they tick (each one
// a recorded payment, so it is already in the books) plus anything GAM never
// recorded ("other money", with a note — the form asks "Is any of this rent?
// Record it first."). When the bank row for exactly that total shows up within
// 5 business days, the slip is matched to it: the receipts are banked, and the
// "other money" is filed as other income, once.
//
// THE RULES, each in one place below:
//   * A receipt sits on ONE live slip at a time (ux_slip_items_*_live, M8).
//   * A bank row equal to an open slip's total, posted on the slip's day or
//     within SLIP_MATCH_BUSINESS_DAYS business days after it, matches it —
//     unless a tenant reported a deposit of the same amount, a tenant's whole
//     bill equals it, or more than one slip fits; then it waits for a person.
//     (Those checks live in services/bankFeed.reconcileDeposits, which runs
//     every automatic step in the plan's order.)
//   * No slip, but the bank row equals EVERYTHING collected and not yet
//     banked: it matches without a slip (GAM writes an 'inferred' slip so the
//     record looks the same). Otherwise exactly ONE combination of what was
//     collected in the INFERRED_WINDOW_DAYS before it matches; anything else
//     waits, with the closest combination proposed for a person to accept.
//   * A slip the bank has not shown after SLIP_MATCH_BUSINESS_DAYS business
//     days is flagged ("not seen at the bank").
//
// Money is in CENTS inside this file. Receipts here are tenant_remittances
// (what was handed over, so a $500 bill paid $460 + $40 kept as credit is $500
// in the bag) and register cash sales (pos_transactions, net of refunds).

import type { PoolClient } from 'pg'
import { addBusinessDays } from '@gam/shared'
import { db, getClient, query } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

type Runner = Pick<PoolClient, 'query'>

/** A bank row may post on the slip's day or up to this many business days after it. */
export const SLIP_MATCH_BUSINESS_DAYS = 5
/** Without a slip, a combination is looked for among what was collected this many days before the bank row. */
export const INFERRED_WINDOW_DAYS = 10
/** How far back "collected and not banked" reaches (older is a books problem, not a banking one). */
export const CASH_LOOKBACK_DAYS = 365
/** The search for a combination stops after this many steps; past it, the answer is "not sure" (wait). */
export const COMBINATION_SEARCH_BUDGET = 200_000

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100
const money = (c: number): string =>
  `$${toDollars(c).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** What sits in the bag: a recorded receipt or a register cash sale. */
export const CASH_ITEM_KINDS = ['receipt', 'register_sale'] as const
export type CashItemKind = typeof CASH_ITEM_KINDS[number]

export interface CashItem {
  kind: CashItemKind
  id: string
  amountCents: number
  amount: number
  /** The day it was taken, on the property's calendar. */
  collectedOn: string
  /** cash, check or money_order (a register sale is always cash). */
  method: string
  payerName: string | null
  unitNumber: string | null
  propertyId: string | null
  propertyName: string | null
  /** The open slip it is on, if any (an item on a MATCHED slip is banked and never listed). */
  slipId: string | null
  slipDepositDate: string | null
  /** The bill lines a receipt paid, oldest first (none for a register sale or money all paid ahead). */
  paymentIds: string[]
}

/**
 * SQL: receipt `r` is the receipt a BANK MATCH wrote (or a receipt whose rows a
 * bank deposit already paid), so it never went into anyone's bag — the money
 * went straight into the bank. Those are never "collected and not banked".
 */
export function bankMatchReceiptSql(r: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(r)) throw new Error('depositSlips: bad alias')
  return `(EXISTS (SELECT 1 FROM bank_transactions bmr
                    WHERE bmr.landlord_id = ${r}.landlord_id AND bmr.status = 'matched'
                      AND bmr.auto_settle_undo->>'receiptId' = ${r}.id::text)
           OR EXISTS (SELECT 1 FROM remittance_applications bra
                        JOIN bank_deposit_allocations bda
                          ON bda.payment_id = bra.payment_id AND bda.reversed_at IS NULL
                       WHERE bra.remittance_id = ${r}.id))`
}

/**
 * Everything a company collected by hand that no bank row has accounted for:
 * settled cash / check / money-order receipts (never a bank-match receipt,
 * never a Stripe one; a prior arrangement has no receipt at all) and register
 * cash sales (net of refunds; voided and fully refunded sales out), each NOT on
 * a matched slip. Items on an OPEN slip are included with their slip.
 *
 * propertyIds narrows to a staffer's properties (null = every property; an
 * item with no property is shown only when unrestricted). ids narrows to named
 * items (for building a slip).
 */
export async function cashNotBanked(
  runner: Runner,
  landlordId: string,
  opts: {
    propertyIds?: string[] | null
    includeOnSlip?: boolean
    receiptIds?: string[]
    saleIds?: string[]
  } = {},
): Promise<CashItem[]> {
  const scoped = opts.propertyIds ?? null
  const named = !!(opts.receiptIds || opts.saleIds)
  const receiptIds = opts.receiptIds ?? []
  const saleIds = opts.saleIds ?? []
  const rows = (await runner.query<{
    kind: CashItemKind; id: string; amount: string; collected_on: string; method: string
    payer_name: string | null; unit_number: string | null; property_id: string | null
    property_name: string | null; slip_id: string | null; slip_deposit_date: string | null
    payment_ids: string[] | null
  }>(
    `WITH live_slip AS (
       SELECT i.remittance_id, i.pos_transaction_id, s.id AS slip_id, s.status,
              to_char(s.deposit_date, 'YYYY-MM-DD') AS deposit_date
         FROM bank_deposit_slip_items i
         JOIN bank_deposit_slips s ON s.id = i.slip_id
        WHERE i.voided_at IS NULL AND s.status IN ('open', 'matched') AND s.landlord_id = $1)
     SELECT 'receipt'::text AS kind, r.id, r.amount::text AS amount,
            to_char((r.settled_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS collected_on,
            r.payment_method AS method,
            NULLIF(TRIM(COALESCE(usr.first_name, '') || ' ' || COALESCE(usr.last_name, '')), '') AS payer_name,
            u.unit_number, u.property_id, pr.name AS property_name,
            ls.slip_id, ls.deposit_date AS slip_deposit_date,
            ARRAY(SELECT ra.payment_id::text FROM remittance_applications ra JOIN payments pp ON pp.id = ra.payment_id
                   WHERE ra.remittance_id = r.id ORDER BY pp.due_date, pp.created_at, pp.id) AS payment_ids
       FROM tenant_remittances r
       LEFT JOIN leases l      ON l.id = r.lease_id
       LEFT JOIN units u       ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       LEFT JOIN tenants tn    ON tn.id = r.tenant_id
       LEFT JOIN users usr     ON usr.id = tn.user_id
       LEFT JOIN live_slip ls  ON ls.remittance_id = r.id
      WHERE r.landlord_id = $1
        AND r.status = 'settled'
        AND r.payment_method IN ('cash', 'check', 'money_order')
        AND r.stripe_payment_intent_id IS NULL
        AND r.settled_at >= now() - ($2::int || ' days')::interval
        AND NOT ${bankMatchReceiptSql('r')}
        AND (ls.slip_id IS NULL OR (ls.status = 'open' AND $3::boolean))
        AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
        AND (NOT $5::boolean OR r.id = ANY($6::uuid[]))
     UNION ALL
     SELECT 'register_sale'::text, p.id, (p.total - p.refund_amount)::text,
            to_char((p.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD'),
            'cash',
            COALESCE(NULLIF(TRIM(COALESCE(pc.first_name, '') || ' ' || COALESCE(pc.last_name, '')), ''),
                     NULLIF(TRIM(COALESCE(usr.first_name, '') || ' ' || COALESCE(usr.last_name, '')), '')),
            NULL::text, p.property_id, pr.name,
            ls.slip_id, ls.deposit_date, ARRAY[]::text[]
       FROM pos_transactions p
       LEFT JOIN properties pr   ON pr.id = p.property_id
       LEFT JOIN pos_customers pc ON pc.id = p.pos_customer_id
       LEFT JOIN tenants tn      ON tn.id = p.tenant_id
       LEFT JOIN users usr       ON usr.id = tn.user_id
       LEFT JOIN live_slip ls    ON ls.pos_transaction_id = p.id
      WHERE p.landlord_id = $1
        AND p.payment_method = 'cash'
        AND p.status IN ('completed', 'partial_refund')
        AND p.total - p.refund_amount > 0
        AND p.created_at >= now() - ($2::int || ' days')::interval
        AND (ls.slip_id IS NULL OR (ls.status = 'open' AND $3::boolean))
        AND ($4::uuid[] IS NULL OR p.property_id = ANY($4::uuid[]))
        AND (NOT $5::boolean OR p.id = ANY($7::uuid[]))
      ORDER BY 4, 2`,
    [landlordId, CASH_LOOKBACK_DAYS, opts.includeOnSlip !== false, scoped, named, receiptIds, saleIds])).rows
  return rows.map(r => ({
    kind: r.kind, id: r.id, amountCents: toCents(r.amount), amount: toDollars(toCents(r.amount)),
    collectedOn: r.collected_on, method: r.method, payerName: r.payer_name, unitNumber: r.unit_number,
    propertyId: r.property_id, propertyName: r.property_name, slipId: r.slip_id, slipDepositDate: r.slip_deposit_date,
    paymentIds: r.payment_ids ?? [],
  }))
}

// ─── Finding the combination a bank row is ──────────────────────────────────

export interface CombinationResult {
  /** 0, 1, or 2 meaning "two or more". */
  exactCount: 0 | 1 | 2
  /** The first exact combination found (oldest items first), as positions. */
  exact: number[] | null
  /** The combination nearest the target without going over, as positions. */
  closest: number[]
  closestCents: number
  /** The search ran out of steps: treat "one" as "not sure". */
  exhausted: boolean
}

/**
 * Which items add up to the target, to the cent. Items are taken in the order
 * given (oldest first), each whole. Stops counting at two. Bounded: past the
 * budget the result says so and nobody acts on it alone.
 */
export function findCashCombination(
  amountsCents: readonly number[], targetCents: number, budget = COMBINATION_SEARCH_BUDGET,
): CombinationResult {
  const n = amountsCents.length
  const suffix = new Array<number>(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + Math.max(0, amountsCents[i])
  let count = 0
  let exact: number[] | null = null
  let closest: number[] = []
  let closestCents = 0
  let steps = 0
  let exhausted = false
  const pick: number[] = []
  const walk = (i: number, sum: number): void => {
    if (count >= 2 || exhausted) return
    if (++steps > budget) { exhausted = true; return }
    if (sum > closestCents && sum <= targetCents) { closestCents = sum; closest = [...pick] }
    if (sum === targetCents && pick.length > 0) {
      count++
      if (!exact) exact = [...pick]
      return
    }
    if (i >= n) return
    if (sum + suffix[i] < targetCents) {
      // Can no longer reach the target: the nearest this branch gets is taking
      // everything left.
      const all = sum + suffix[i]
      if (all > closestCents) {
        closestCents = all
        closest = [...pick]
        for (let k = i; k < n; k++) if (amountsCents[k] > 0) closest.push(k)
      }
      return
    }
    const a = amountsCents[i]
    if (a > 0 && sum + a <= targetCents) {
      pick.push(i)
      walk(i + 1, sum + a)
      pick.pop()
    }
    walk(i + 1, sum)
  }
  if (targetCents > 0) walk(0, 0)
  return { exactCount: Math.min(count, 2) as 0 | 1 | 2, exact, closest, closestCents, exhausted }
}

export interface CashProposal {
  /** everything: it is all that was collected; one: the only combination; several: more than one adds up; closest: nothing adds up. */
  kind: 'everything' | 'one' | 'several' | 'closest' | 'none'
  items: CashItem[]
  totalCents: number
  /** Plain sentence for the screen. */
  note: string
}

/**
 * What a money-in bank row could be, from the cash nobody has banked yet and
 * that is on no slip: everything collected up to its day; else exactly one
 * combination of what was collected in the window before it; else the closest.
 */
export async function cashProposalFor(
  runner: Runner, landlordId: string, txn: { amount: number | string; posted_date: string },
): Promise<CashProposal> {
  const target = toCents(txn.amount)
  const items = (await cashNotBanked(runner, landlordId, { includeOnSlip: false }))
    .filter(i => i.collectedOn <= txn.posted_date)
  if (items.length === 0 || target <= 0) {
    return { kind: 'none', items: [], totalCents: 0, note: 'No cash or checks are waiting to be banked.' }
  }
  const all = items.reduce((s, i) => s + i.amountCents, 0)
  if (all === target) {
    return {
      kind: 'everything', items, totalCents: all,
      note: `This is everything collected and not yet banked: ${items.length} ${items.length === 1 ? 'payment' : 'payments'}, ${money(all)}.`,
    }
  }
  const from = addCalendarDays(txn.posted_date, -INFERRED_WINDOW_DAYS)
  const recent = items.filter(i => i.collectedOn >= from)
  const found = findCashCombination(recent.map(i => i.amountCents), target)
  if (found.exactCount === 1 && !found.exhausted && found.exact) {
    const pick = found.exact.map(k => recent[k])
    return {
      kind: 'one', items: pick, totalCents: target,
      note: `Only one set of what was collected in the ${INFERRED_WINDOW_DAYS} days before it adds up to ${money(target)}: ${pick.length} ${pick.length === 1 ? 'payment' : 'payments'}.`,
    }
  }
  if (found.exactCount >= 1 && found.exact) {
    const pick = found.exact.map(k => recent[k])
    return {
      kind: 'several', items: pick, totalCents: target,
      note: `More than one set of what was collected adds up to ${money(target)}. This is the one with the oldest payments — check it against the deposit slip from the bank.`,
    }
  }
  const pick = found.closest.map(k => recent[k])
  return {
    kind: pick.length ? 'closest' : 'none', items: pick, totalCents: found.closestCents,
    note: pick.length
      ? `Nothing collected adds up to ${money(target)}. The closest is ${money(found.closestCents)} — ${money(target - found.closestCents)} short.`
      : `Nothing collected in the ${INFERRED_WINDOW_DAYS} days before it fits ${money(target)}.`,
  }
}

function addCalendarDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The last day the bank may show a slip made on `depositDate`. */
export function slipLastBankDay(depositDate: string): string {
  return addBusinessDays(depositDate, SLIP_MATCH_BUSINESS_DAYS)
}

/** Open slips this bank row could be: the same total, posted in the slip's window. */
export async function openSlipsFitting(
  runner: Runner, landlordId: string, txn: { amount: number | string; posted_date: string },
): Promise<Array<{ id: string; deposit_date: string }>> {
  const slips = (await runner.query<{ id: string; deposit_date: string }>(
    `SELECT id, to_char(deposit_date, 'YYYY-MM-DD') AS deposit_date
       FROM bank_deposit_slips
      WHERE landlord_id = $1 AND status = 'open' AND total = $2::numeric
        AND deposit_date <= $3::date
      ORDER BY deposit_date, id`,
    [landlordId, toDollars(toCents(txn.amount)).toFixed(2), txn.posted_date])).rows
  return slips.filter(s => txn.posted_date <= slipLastBankDay(s.deposit_date))
}

// ─── Slips ───────────────────────────────────────────────────────────────────

export interface SlipItemView {
  id: string
  kind: CashItemKind
  sourceId: string
  amount: number
  payerName: string | null
  unitNumber: string | null
  collectedOn: string | null
  method: string | null
}

export interface SlipView {
  id: string
  status: string
  source: string
  depositDate: string
  total: number
  otherAmount: number
  otherNote: string | null
  propertyId: string | null
  propertyName: string | null
  createdByName: string | null
  createdAt: string
  matchedAt: string | null
  bankTransactionId: string | null
  bankPostedDate: string | null
  /** The bank's last day to show it (open slips). */
  lastBankDay: string | null
  /** Open, and the bank has not shown it by its last day. */
  overdue: boolean
  /** Plain sentence when overdue. */
  flag: string | null
  items: SlipItemView[]
}

/** Today on a company's calendar (its first property's time zone; Phoenix if none). */
async function todayFor(runner: Runner, landlordId: string): Promise<string> {
  return (await runner.query<{ d: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE(
              (SELECT timezone FROM properties WHERE landlord_id = $1 AND timezone IS NOT NULL ORDER BY created_at LIMIT 1),
              'America/Phoenix'))::date, 'YYYY-MM-DD') AS d`, [landlordId])).rows[0].d
}

/** Is an open slip past the bank's last day? */
export function slipOverdue(depositDate: string, today: string): boolean {
  return today > slipLastBankDay(depositDate)
}

/** Slips for the screen: every open one (flagged when overdue) and the last 45 days of the rest. */
export async function listSlips(
  landlordId: string, opts: { propertyIds?: string[] | null; slipIds?: string[]; runner?: Runner } = {},
): Promise<SlipView[]> {
  const runner: Runner = opts.runner ?? db
  const scoped = opts.propertyIds ?? null
  const slips = (await runner.query<any>(
    `SELECT s.id, s.status, s.source, to_char(s.deposit_date, 'YYYY-MM-DD') AS deposit_date,
            s.total::text AS total, s.other_amount::text AS other_amount, s.other_note,
            s.property_id, pr.name AS property_name, s.created_at, s.matched_at, s.bank_transaction_id,
            to_char(bt.posted_date, 'YYYY-MM-DD') AS bank_posted_date,
            NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS created_by_name
       FROM bank_deposit_slips s
       LEFT JOIN properties pr ON pr.id = s.property_id
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN bank_transactions bt ON bt.id = s.bank_transaction_id
      WHERE s.landlord_id = $1
        AND ($3::uuid[] IS NULL OR s.id = ANY($3::uuid[]))
        AND (s.status = 'open' OR s.created_at >= now() - interval '45 days')
        -- A staffer sees a slip only when every item on it is at one of their
        -- properties (a slip with nothing but "other money" follows its property).
        AND ($2::uuid[] IS NULL OR (
              (s.property_id IS NULL OR s.property_id = ANY($2::uuid[]))
              AND NOT EXISTS (
                SELECT 1 FROM bank_deposit_slip_items i
                  LEFT JOIN tenant_remittances r ON r.id = i.remittance_id
                  LEFT JOIN leases l ON l.id = r.lease_id
                  LEFT JOIN units un ON un.id = l.unit_id
                  LEFT JOIN pos_transactions p ON p.id = i.pos_transaction_id
                 WHERE i.slip_id = s.id
                   AND (COALESCE(un.property_id, p.property_id) IS NULL
                        OR NOT (COALESCE(un.property_id, p.property_id) = ANY($2::uuid[]))))))
      ORDER BY (s.status = 'open') DESC, s.deposit_date DESC, s.created_at DESC`,
    [landlordId, scoped, opts.slipIds ?? null])).rows
  if (slips.length === 0) return []
  const items = (await runner.query<any>(
    `SELECT i.id, i.slip_id, i.amount::text AS amount,
            CASE WHEN i.remittance_id IS NOT NULL THEN 'receipt' ELSE 'register_sale' END AS kind,
            COALESCE(i.remittance_id, i.pos_transaction_id) AS source_id,
            COALESCE(
              NULLIF(TRIM(COALESCE(ru.first_name, '') || ' ' || COALESCE(ru.last_name, '')), ''),
              NULLIF(TRIM(COALESCE(pc.first_name, '') || ' ' || COALESCE(pc.last_name, '')), '')) AS payer_name,
            un.unit_number,
            to_char((COALESCE(r.settled_at, p.created_at) AT TIME ZONE COALESCE(rp.timezone, pp.timezone, 'America/Phoenix'))::date,
                    'YYYY-MM-DD') AS collected_on,
            COALESCE(r.payment_method, CASE WHEN p.id IS NOT NULL THEN 'cash' END) AS method
       FROM bank_deposit_slip_items i
       LEFT JOIN tenant_remittances r ON r.id = i.remittance_id
       LEFT JOIN tenants tn ON tn.id = r.tenant_id
       LEFT JOIN users ru ON ru.id = tn.user_id
       LEFT JOIN leases l ON l.id = r.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties rp ON rp.id = un.property_id
       LEFT JOIN pos_transactions p ON p.id = i.pos_transaction_id
       LEFT JOIN properties pp ON pp.id = p.property_id
       LEFT JOIN pos_customers pc ON pc.id = p.pos_customer_id
      WHERE i.slip_id = ANY($1::uuid[])
        AND (i.voided_at IS NULL OR EXISTS (SELECT 1 FROM bank_deposit_slips s WHERE s.id = i.slip_id AND s.status = 'void'))
      ORDER BY collected_on, i.id`,
    [slips.map((s: any) => s.id)])).rows
  const today = await todayFor(runner, landlordId)
  return slips.map((s: any): SlipView => {
    const overdue = s.status === 'open' && slipOverdue(s.deposit_date, today)
    const last = s.status === 'open' ? slipLastBankDay(s.deposit_date) : null
    return {
      id: s.id, status: s.status, source: s.source, depositDate: s.deposit_date,
      total: toDollars(toCents(s.total)), otherAmount: toDollars(toCents(s.other_amount)), otherNote: s.other_note,
      propertyId: s.property_id, propertyName: s.property_name, createdByName: s.created_by_name,
      createdAt: new Date(s.created_at).toISOString(), matchedAt: s.matched_at ? new Date(s.matched_at).toISOString() : null,
      bankTransactionId: s.bank_transaction_id, bankPostedDate: s.bank_posted_date,
      lastBankDay: last, overdue,
      flag: overdue
        ? `Not seen at the bank by ${last} (${SLIP_MATCH_BUSINESS_DAYS} business days after ${s.deposit_date}). Check the bank's deposit receipt — if the bag never made it, find out where it is.`
        : null,
      items: items.filter((i: any) => i.slip_id === s.id).map((i: any) => ({
        id: i.id, kind: i.kind, sourceId: i.source_id, amount: toDollars(toCents(i.amount)),
        payerName: i.payer_name, unitNumber: i.unit_number, collectedOn: i.collected_on, method: i.method,
      })),
    }
  })
}

export interface CreateSlipInput {
  landlordId: string
  depositDate: string
  receiptIds?: string[]
  registerSaleIds?: string[]
  otherAmount?: number
  otherNote?: string | null
  /**
   * The person answered "Is any of this rent?" with no (rent is recorded first,
   * then ticked). Required whenever there is other money.
   */
  otherIsNotRent?: boolean
  /** What the screen showed as the total; a different total refuses (409) so the screen refetches. */
  expectedTotal?: number | null
  /** Match this bank row now (a person accepting a proposal). Must be the same total. */
  bankTransactionId?: string | null
  createdBy: string
  /** A staffer's properties (null = every property). */
  propertyIds?: string[] | null
}

/**
 * Make a deposit slip: what went into the bag. Every item must be cash this
 * company took and has not banked, on no other live slip, at a property the
 * person may see. Other money needs a note and a "this is not rent" answer.
 * With a bank row named, the slip is matched to it at once (the totals must
 * agree); otherwise the bank feed matches it when the bank row arrives.
 */
export async function createSlip(input: CreateSlipInput): Promise<SlipView> {
  const receiptIds = [...new Set(input.receiptIds ?? [])]
  const saleIds = [...new Set(input.registerSaleIds ?? [])]
  const otherCents = toCents(input.otherAmount ?? 0)
  const note = (input.otherNote ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.depositDate) || Number.isNaN(Date.parse(`${input.depositDate}T00:00:00Z`))) {
    throw new AppError(400, 'Pick the day the deposit goes to the bank.')
  }
  if (otherCents < 0) throw new AppError(400, 'Other money cannot be below zero.')
  if (otherCents > 0 && !note) throw new AppError(400, 'Say what the other money is (for example "laundry quarters").')
  if (otherCents > 0 && input.otherIsNotRent !== true) {
    throw new AppError(409, 'Is any of the other money rent? Record each rent payment first, then tick it on this slip. Answer "No, none of it is rent" to go on.')
  }
  if (receiptIds.length === 0 && saleIds.length === 0 && otherCents === 0) {
    throw new AppError(400, 'Tick what went into the bag.')
  }

  const client = await getClient()
  let slipId: string
  let matched = false
  try {
    await client.query('BEGIN')
    // One slip at a time per company, so two people ticking the same receipt
    // cannot both put it in a bag.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`deposit_slips:${input.landlordId}`])
    const today = await todayFor(client, input.landlordId)
    if (input.depositDate > addCalendarDays(today, 1)) {
      throw new AppError(400, 'The deposit day cannot be later than tomorrow.')
    }

    const items = await cashNotBanked(client, input.landlordId, {
      receiptIds, saleIds, includeOnSlip: true, propertyIds: null,
    })
    const byId = new Map(items.map(i => [`${i.kind}:${i.id}`, i]))
    const wanted = [...receiptIds.map(id => `receipt:${id}`), ...saleIds.map(id => `register_sale:${id}`)]
    for (const key of wanted) {
      const it = byId.get(key)
      if (!it) {
        throw new AppError(409, 'One of the payments you ticked is no longer waiting to be banked — it was banked, undone, or is not this company’s. The list has been refreshed; tick again.')
      }
      if (it.slipId) {
        throw new AppError(409,
          `${it.payerName ?? 'A payment'}’s ${money(it.amountCents)} is already on the ${it.slipDepositDate} deposit slip. Take it off that slip (void it) or leave it out of this one.`)
      }
      const scope = input.propertyIds ?? null
      if (scope && (!it.propertyId || !scope.includes(it.propertyId))) {
        throw new AppError(403, `${it.payerName ?? 'A payment'}’s ${money(it.amountCents)} was taken at a property you are not assigned to.`)
      }
    }
    const picked = wanted.map(k => byId.get(k)!)
    const totalCents = picked.reduce((s, i) => s + i.amountCents, 0) + otherCents
    if (totalCents <= 0) throw new AppError(400, 'Tick what went into the bag.')
    if (input.expectedTotal != null && toCents(input.expectedTotal) !== totalCents) {
      throw new AppError(409, `The amounts changed while you were working — this slip now comes to ${money(totalCents)}. Look at it again.`)
    }
    const props = [...new Set(picked.map(i => i.propertyId).filter((x): x is string => !!x))]
    const propertyId = props.length === 1 ? props[0] : null
    if (input.propertyIds && picked.length === 0) {
      // Other money only: a staffer files it at their one property.
      if (input.propertyIds.length !== 1) {
        throw new AppError(400, 'Tick at least one payment so GAM knows which property this deposit is for.')
      }
    }
    const slipProperty = propertyId ?? (input.propertyIds && input.propertyIds.length === 1 ? input.propertyIds[0] : null)

    slipId = (await client.query<{ id: string }>(
      `INSERT INTO bank_deposit_slips
         (landlord_id, property_id, deposit_date, total, other_amount, other_note, source, status, created_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, 'staff', 'open', $7) RETURNING id`,
      [input.landlordId, slipProperty, input.depositDate, toDollars(totalCents).toFixed(2),
       toDollars(otherCents).toFixed(2), otherCents > 0 ? note : null, input.createdBy])).rows[0].id
    for (const it of picked) {
      await client.query(
        `INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, pos_transaction_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [slipId, it.kind === 'receipt' ? it.id : null, it.kind === 'register_sale' ? it.id : null,
         toDollars(it.amountCents).toFixed(2)])
    }

    if (input.bankTransactionId) {
      await matchSlipToDeposit(client, {
        slipId, transactionId: input.bankTransactionId, landlordId: input.landlordId,
        matchedBy: input.createdBy, inferred: false,
      })
      matched = true
    }
    await client.query('COMMIT')
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {})
    if (e?.code === '23505') {
      throw new AppError(409, 'One of those payments was just put on another deposit slip. The list has been refreshed; tick again.')
    }
    throw e
  } finally {
    client.release()
  }

  // A bank row for exactly this slip may already be waiting: the bank feed's
  // own rules decide (nothing is matched while something competes with it).
  if (!matched) {
    try {
      const { reconcileDeposits } = await import('./bankFeed')
      await reconcileDeposits(input.landlordId)
    } catch (e) {
      logger.warn({ err: e, slipId }, '[deposit-slips] checking the bank for a new slip failed; the next sync will')
    }
  }
  return (await listSlips(input.landlordId, { slipIds: [slipId] }))[0]
}

/**
 * Take a slip back: it is open (the bank has not shown it) and the bag did not
 * go, or went with something else. Its receipts are free to go on another slip.
 * A matched slip is undone from the bank row instead.
 */
export async function voidSlip(
  landlordId: string, slipId: string, by: string, propertyIds: string[] | null = null,
): Promise<SlipView> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`deposit_slips:${landlordId}`])
    const s = (await client.query<{ status: string; posted: string | null; amount: string | null }>(
      `SELECT s.status, to_char(bt.posted_date, 'YYYY-MM-DD') AS posted, bt.amount::text AS amount
         FROM bank_deposit_slips s LEFT JOIN bank_transactions bt ON bt.id = s.bank_transaction_id
        WHERE s.id = $1 AND s.landlord_id = $2 FOR UPDATE OF s`, [slipId, landlordId])).rows[0]
    if (!s) throw new AppError(404, 'That deposit slip was not found.')
    if (propertyIds) {
      const visible = await listSlips(landlordId, { slipIds: [slipId], propertyIds, runner: client })
      if (visible.length === 0) throw new AppError(404, 'That deposit slip was not found.')
    }
    if (s.status === 'void') throw new AppError(409, 'This deposit slip is already voided.')
    if (s.status === 'matched') {
      throw new AppError(409,
        `This slip is already matched to the ${s.amount ? money(toCents(s.amount)) + ' ' : ''}bank deposit of ${s.posted ?? 'its bank day'}. ` +
        'Ask the owner to undo that match on the Bank page first.')
    }
    await client.query(
      `UPDATE bank_deposit_slips SET status = 'void', voided_at = now() WHERE id = $1 AND status = 'open'`, [slipId])
    await client.query(
      `UPDATE bank_deposit_slip_items SET voided_at = now() WHERE slip_id = $1 AND voided_at IS NULL`, [slipId])
    await client.query('COMMIT')
    logger.info({ slipId, by }, '[deposit-slips] slip voided')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  return (await listSlips(landlordId, { slipIds: [slipId] }))[0]
}

/** The record a slip match writes on the bank row, so it can be undone exactly. */
export interface SlipMatchUndo {
  version: 1
  kind: 'deposit_slip'
  slipId: string
  /** The "other money" filed as other income (null when there was none). */
  otherIncomeId: string | null
  /** GAM worked the slip out by itself (no person made it). */
  inferred: boolean
  matchedBy: string | null
}

/**
 * Match an open slip to a money-in bank row: same total to the cent, the row
 * untouched. The receipts are banked; the slip's "other money" is filed once as
 * other income, dated the bank day. Runs inside the caller's transaction.
 */
export async function matchSlipToDeposit(
  client: PoolClient,
  o: { slipId: string; transactionId: string; landlordId: string; matchedBy: string | null; inferred: boolean },
): Promise<{ otherIncomeId: string | null }> {
  // Step 12 review: the bank row is locked BEFORE the slip, in every path. The
  // automatic match (bankFeed.actOnDeposit) already holds the bank row when it
  // gets here; a person's "Match it to this slip" used to lock the slip first,
  // so the two at once could deadlock (the owner got a 500, not a plain 409).
  // Undo (bankDepositConfirm.undoDepositMatch → undoSlipMatch) is bank row
  // first too.
  const txn = (await client.query<any>(
    `SELECT id, amount::text AS amount, to_char(posted_date, 'YYYY-MM-DD') AS posted_date, status,
            expense_id, landlord_other_income_id, matched_payment_id, matched_disbursement_id, bank_status
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [o.transactionId, o.landlordId])).rows[0]
  const slip = (await client.query<{ status: string; total: string; other_amount: string; other_note: string | null; property_id: string | null; created_by: string | null }>(
    `SELECT status, total::text AS total, other_amount::text AS other_amount, other_note, property_id, created_by
       FROM bank_deposit_slips WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [o.slipId, o.landlordId])).rows[0]
  if (!slip) throw new AppError(404, 'That deposit slip was not found.')
  if (slip.status !== 'open') throw new AppError(409, 'That deposit slip is no longer open.')
  if (!txn) throw new AppError(404, 'That bank deposit was not found.')
  if (txn.status !== 'needs_review' || txn.expense_id || txn.landlord_other_income_id
      || txn.matched_payment_id || txn.matched_disbursement_id || toCents(txn.amount) <= 0) {
    throw new AppError(409, 'That bank deposit is already filed or matched.')
  }
  if (txn.bank_status === 'void') throw new AppError(409, 'Your bank voided that deposit — no money came in.')
  // A deposit the bank still shows as pending follows the same one switch as
  // a landlord's confirm of a tenant's deposit (Nic's open item 5, Step 9).
  const { pendingDepositRefusal } = await import('./bankDepositConfirm')
  const pendingWhy = txn.bank_status === 'pending' ? pendingDepositRefusal(txn.bank_status) : null
  if (pendingWhy) throw new AppError(409, pendingWhy)
  if (toCents(txn.amount) !== toCents(slip.total)) {
    throw new AppError(409, `The slip comes to ${money(toCents(slip.total))} but the bank deposit is ${money(toCents(txn.amount))}. They have to be the same.`)
  }

  let otherIncomeId: string | null = null
  if (toCents(slip.other_amount) > 0) {
    otherIncomeId = (await client.query<{ id: string }>(
      `INSERT INTO landlord_other_income
         (landlord_id, property_id, unit_id, category, amount, description, payer, income_date, is_common, created_by)
       VALUES ($1, $2, NULL, 'other', $3, $4, 'Bank deposit slip', $5::date, $6, $7) RETURNING id`,
      [o.landlordId, slip.property_id, slip.other_amount, slip.other_note ?? 'Other money on a bank deposit slip',
       txn.posted_date, slip.property_id != null, slip.created_by])).rows[0].id
  }
  const undo: SlipMatchUndo = {
    version: 1, kind: 'deposit_slip', slipId: o.slipId, otherIncomeId, inferred: o.inferred, matchedBy: o.matchedBy,
  }
  await client.query(
    `UPDATE bank_deposit_slips SET status = 'matched', bank_transaction_id = $2, matched_at = now() WHERE id = $1`,
    [o.slipId, o.transactionId])
  await client.query(
    `UPDATE bank_transactions
        SET status = 'matched', landlord_other_income_id = $2, auto_settle_undo = $3::jsonb, updated_at = now()
      WHERE id = $1`,
    [o.transactionId, otherIncomeId, JSON.stringify(undo)])
  return { otherIncomeId }
}

/**
 * A person says this open slip IS this bank deposit (two slips fit, a tenant
 * reported the same amount, or the match was undone and is being redone).
 * Same checks as the automatic match: same total, the row untouched.
 */
export async function matchSlipByHand(
  landlordId: string, slipId: string, transactionId: string, by: string,
): Promise<SlipView> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`deposit_slips:${landlordId}`])
    await matchSlipToDeposit(client, { slipId, transactionId, landlordId, matchedBy: by, inferred: false })
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  return (await listSlips(landlordId, { slipIds: [slipId] }))[0]
}

/**
 * GAM worked out what a bank row was (everything not yet banked, or the only
 * combination that adds up): write it down as an 'inferred' slip and match it.
 */
export async function matchInferredBatch(
  client: PoolClient,
  o: { landlordId: string; transactionId: string; postedDate: string; items: CashItem[] },
): Promise<string> {
  const props = [...new Set(o.items.map(i => i.propertyId).filter((x): x is string => !!x))]
  const totalCents = o.items.reduce((s, i) => s + i.amountCents, 0)
  const slipId = (await client.query<{ id: string }>(
    `INSERT INTO bank_deposit_slips (landlord_id, property_id, deposit_date, total, source, status)
     VALUES ($1, $2, $3::date, $4, 'inferred', 'open') RETURNING id`,
    [o.landlordId, props.length === 1 ? props[0] : null, o.postedDate, toDollars(totalCents).toFixed(2)])).rows[0].id
  for (const it of o.items) {
    await client.query(
      `INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, pos_transaction_id, amount) VALUES ($1, $2, $3, $4)`,
      [slipId, it.kind === 'receipt' ? it.id : null, it.kind === 'register_sale' ? it.id : null,
       toDollars(it.amountCents).toFixed(2)])
  }
  await matchSlipToDeposit(client, {
    slipId, transactionId: o.transactionId, landlordId: o.landlordId, matchedBy: null, inferred: true,
  })
  return slipId
}

/**
 * Undo a slip match, inside the caller's transaction (the bank row is locked):
 * the bank row goes back to review, the "other money" income is voided, a slip
 * staff made is open again, and a slip GAM worked out by itself is voided (its
 * receipts are free again). Refused when the income was changed since.
 */
export async function undoSlipMatch(
  client: PoolClient,
  o: { transactionId: string; landlordId: string; undo: SlipMatchUndo; undoneBy: string | null },
): Promise<{ slipId: string; reopened: boolean }> {
  const slip = (await client.query<{ status: string; source: string; bank_transaction_id: string | null }>(
    `SELECT status, source, bank_transaction_id FROM bank_deposit_slips WHERE id = $1 AND landlord_id = $2 FOR UPDATE`,
    [o.undo.slipId, o.landlordId])).rows[0]
  if (!slip || slip.status !== 'matched' || slip.bank_transaction_id !== o.transactionId) {
    throw new AppError(409, 'This deposit slip changed since it was matched, so the match can’t be undone here. Contact GAM support.')
  }
  if (o.undo.otherIncomeId) {
    const r = await client.query(
      `UPDATE landlord_other_income SET status = 'voided', voided_at = now(), updated_at = now()
        WHERE id = $1 AND landlord_id = $2 AND status = 'active'`, [o.undo.otherIncomeId, o.landlordId])
    if ((r.rowCount ?? 0) !== 1) {
      throw new AppError(409, 'The other money on this slip was changed in your income since, so the match can’t be undone here.')
    }
  }
  const reopened = slip.source === 'staff'
  if (reopened) {
    await client.query(
      `UPDATE bank_deposit_slips SET status = 'open', bank_transaction_id = NULL, matched_at = NULL WHERE id = $1`,
      [o.undo.slipId])
  } else {
    await client.query(
      `UPDATE bank_deposit_slips SET status = 'void', voided_at = now(), bank_transaction_id = NULL, matched_at = NULL
        WHERE id = $1`, [o.undo.slipId])
    await client.query(
      `UPDATE bank_deposit_slip_items SET voided_at = now() WHERE slip_id = $1 AND voided_at IS NULL`, [o.undo.slipId])
  }
  return { slipId: o.undo.slipId, reopened }
}

/**
 * Step 12 review: the bank voided a deposit that was matched to a deposit slip
 * (one staff made, or one GAM worked out from the office's cash). The money did
 * not come in, but the slip still reads "matched", so its receipts stay out of
 * the cash control — the bag that never arrived would be invisible again. The
 * owner is told, worded for the office's deposit (not a tenant's rent), with
 * the next step: find the bag, then Undo the match so those payments show as
 * not banked. Never throws (a sync must not fail over a notice).
 */
export async function alertSlipDepositVoided(transactionId: string): Promise<boolean> {
  try {
    const t = (await query<{
      landlord_id: string; amount: string; posted_date: string; owner_user_id: string | null
      slip_date: string | null; items: string; source: string | null
    }>(
      `SELECT bt.landlord_id, bt.amount::text AS amount, to_char(bt.posted_date, 'YYYY-MM-DD') AS posted_date,
              l.user_id AS owner_user_id,
              to_char(s.deposit_date, 'YYYY-MM-DD') AS slip_date, s.source,
              (SELECT COUNT(*)::text FROM bank_deposit_slip_items i WHERE i.slip_id = s.id AND i.voided_at IS NULL) AS items
         FROM bank_transactions bt
         JOIN landlords l ON l.id = bt.landlord_id
         LEFT JOIN bank_deposit_slips s ON s.id = (bt.auto_settle_undo->>'slipId')::uuid AND s.landlord_id = bt.landlord_id
        WHERE bt.id = $1 AND bt.status = 'matched' AND bt.auto_settle_undo->>'kind' = 'deposit_slip'`,
      [transactionId]))[0]
    if (!t || !t.owner_user_id) return false
    const n = Number(t.items)
    const what = t.source === 'inferred'
      ? `the office’s cash${n > 0 ? ` (${n} payment${n === 1 ? '' : 's'})` : ''}`
      : `your deposit slip${t.slip_date ? ` of ${t.slip_date}` : ''}${n > 0 ? ` (${n} payment${n === 1 ? '' : 's'})` : ''}`
    await (await import('./notifications')).createNotification({
      userId: t.owner_user_id,
      landlordId: t.landlord_id,
      type: 'bank_deposit_voided',
      title: 'Your bank voided an office deposit',
      body: `Your bank voided the ${money(toCents(t.amount))} deposit of ${t.posted_date} that was matched to ${what} — the money did not come in. ` +
        'Find out what happened to that bag. Then open the deposit on the Bank page and press Undo, so those payments show as not banked again.',
      actionUrl: '/bank',
    })
    return true
  } catch (e) {
    logger.error({ err: e, transactionId }, '[deposit-slips] could not tell the owner a slip deposit was voided')
    return false
  }
}

/** Open slips the bank has not shown by their last day (for the cash control and the agent). */
export async function overdueSlipCount(landlordId: string): Promise<number> {
  const rows = await query<{ deposit_date: string }>(
    `SELECT to_char(deposit_date, 'YYYY-MM-DD') AS deposit_date FROM bank_deposit_slips
      WHERE landlord_id = $1 AND status = 'open'`, [landlordId])
  if (rows.length === 0) return 0
  const today = (await query<{ d: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE(
              (SELECT timezone FROM properties WHERE landlord_id = $1 AND timezone IS NOT NULL ORDER BY created_at LIMIT 1),
              'America/Phoenix'))::date, 'YYYY-MM-DD') AS d`, [landlordId]))[0].d
  return rows.filter(r => slipOverdue(r.deposit_date, today)).length
}
