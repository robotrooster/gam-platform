/**
 * S609 — the ONE way a lease balance gets charged.
 *
 * This is the body of POST /payments/pay-balance, lifted out of the Express
 * handler so the AUTOPAY RUNNER charges through exactly the same code. Two
 * implementations of "how rent is charged" is how a tenant ends up paying a
 * different fee, or a landlord receiving a different owner share, depending on
 * whether a human pressed the button or a cron did — the same failure mode
 * services/creditApplication.ts exists to prevent for credits.
 *
 * Everything the route did, this does: one lease per charge, eviction hold,
 * FIFO oldest-first application with the standard remainder split, tenant-payer
 * platform-fee passthrough, sublease markup, GAM supersedence, the platform
 * charge (money lands on GAM's balance and batches to the landlord), and the
 * not-Connect-ready admin notification.
 *
 * TWO behaviors changed here versus the route it came from, both S609:
 *
 * 1. PAY-AHEAD IS ALLOWED (Nic, §8). The old guard rejected any amount that
 *    wasn't exactly the balance — over AND under. The comment beside it said
 *    "no pay-ahead — the UI has no amount field", which records a MISSING INPUT
 *    BOX, not a policy; Nic confirmed he never decided against it. Over-payment
 *    now flows into lease_prepaid_credits (webhooks.ts banks the remainder) and
 *    is released to the landlord month by month as it is earned.
 *
 *    UNDER-payment stays blocked and that IS a standing directive: a partial can
 *    reset a landlord's eviction clock. Do not soften the `amount < outstanding`
 *    branch below.
 *
 * 2. THE SURPLUS IS NOT CAPPED (Nic, DIRECTIVE — reversed the lease-term ceiling
 *    the same session it was written):
 *
 *      "It shouldn't be the rest of their lease term specifically because a
 *       tenant that's getting billed utilities and stuff — they never know what
 *       it's gonna be until the meters are read. The last month or so they're
 *       not gonna have enough credit for the utilities, or they're gonna have
 *       paid too much based on utility use and have to get credit back. So let's
 *       just not put any cap on it, to eliminate those pinch points."
 *
 *    He is right, and the ceiling was the wrong instinct. A lease term is
 *    knowable; a lease term's COST is not — utilities land after a meter is
 *    read, which is exactly the charge a tenant paying ahead cannot anticipate.
 *    Any ceiling therefore lands slightly wrong at the end of every lease and
 *    creates the refund churn it was meant to avoid.
 *
 *    Unused credit already comes back to the tenant at move-out through the
 *    deposit-return path, so an over-estimate was never stuck anyway.
 */

import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { applyCreditsToOpenCharges } from './creditApplication'
import { prepaidDrawAvailable, consumePrepaidCreditForInvoice } from './prepaidRelease'
import { allocateOldestFirst, allocateCredits } from '@gam/shared'
import { ALLOCATABLE_PAYMENT_TYPES } from './allocation'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'
import { computePlatformCut, createRentPlatformCharge } from './stripeConnect'
import { createAdminNotification } from './adminNotifications'
import { computeTenantGamOutstandingTotal } from './supersedence'

// S654: 'system' — a job settling a bill from credit; it never charges anyone.
export const CHARGE_SOURCES = ['portal', 'autopay', 'front_desk_reader', 'system'] as const
export type ChargeSource = typeof CHARGE_SOURCES[number]

export interface ChargeLeaseBalanceInput {
  tenantId:          string
  /** The ONE lease this charge settles. Resolve it before calling.
   *  S616: omit it and pass serviceAgreementId instead for a payer who has no
   *  lease — the neighbor buying trash and electric. */
  leaseId?:          string
  /** S616 (Nic): "their trash and electric needs to be on one bill if they have
   *  more than one utility through this subsystem." One agreement is one bill
   *  and one charge, however many utilities are on it. */
  serviceAgreementId?: string
  /** What the tenant chose to pay. >= the outstanding balance; the excess is banked. */
  amount:            number
  /** S654: absent for a card tapped on the counter reader — the reader is the method. */
  paymentMethodId?:  string
  paymentMethodType: 'ach' | 'card' | 'card_present'
  /** 'portal' = a human pressed Pay. 'autopay' = the scheduled runner. */
  source:            ChargeSource
  /** S654: charge everything owed on the scope — the counter never part-pays. `amount` is ignored. */
  chargeEverything?: boolean
  /** S654: compute the quote (what the payer is charged, fee included) and write nothing. */
  dryRun?:           boolean
  /** S654: charge exactly the server's pay-in-full figure (the lease's own
   *  charges less paid-ahead and landlord credit). `amount` is ignored. Autopay
   *  uses it so a scheduled pull never takes dollars a credit already covers. */
  chargeRequiredOnly?: boolean
  /** S654: the reader already holds an authorization for exactly `amountCents`;
   *  book against it instead of creating a charge. 409 if the balance moved. */
  existingIntent?: { id: string; amountCents: number; capture?: boolean }
  /** S654: settle from credit ONLY — when the credits cover everything due now.
   *  Never charges: 409 CREDIT_DOES_NOT_COVER when anything would be owed. */
  creditOnly?: boolean
}

export interface ChargeLeaseBalanceResult {
  remittanceId:        string
  paymentIntentId:     string
  /** The intent's status, 'quote' for a dry run, or S654 'settled_by_credit' —
   *  the credits covered everything and nothing was charged. */
  status:              string
  /** Dollars of cash that landed on open charges. */
  appliedTotal:        number
  /** Dollars banked as prepaid credit for future months. */
  payAhead:            number
  platformCutAmount: number
  /** S654: what the payer is actually charged — the balance plus the fees they bear. */
  chargeAmount:        number
  /** S654: the bank or card processing fee on top (0 when the landlord covers it). */
  processingFee:       number
  /** S654: the platform fee a landlord passes to the tenant, on top — not a processing fee. */
  platformFeePassthrough: number
  lines:               { payment_id: string; amount_applied: number }[]
  // S654: a quote or a credit settle — the gross balance and the credit netted.
  outstanding?:  number
  creditNetted?: number
}

/** The rows a lease balance is made of, oldest first, with the context every
 *  charge decision needs. Shared by the charge path and the balance preview so
 *  the number the tenant is shown is the number the server enforces. */
export type BalanceScope =
  | { kind: 'lease'; leaseId: string }
  /** S616 (Nic): a payer with no lease at all — the neighbor buying trash and
   *  electric. "Their trash and electric needs to be on one bill if they have
   *  more than one utility through this subsystem." One agreement is one bill,
   *  however many utilities are on it. */
  | { kind: 'service'; serviceAgreementId: string }

/** S654: the open-charge fields the credit plan reads. */
export interface OpenChargeRow {
  id: string
  amount: number
  due_date: string
  type: string
  entry_description?: string | null
  invoice_id?: string | null
  lease_id?: string | null
  status?: string | null
}

/** S654: one bill's share of the paid-ahead credit, and what that bill's month
 *  could draw before it. */
export interface PrepaidTake { invoiceId: string; month: string; take: number; availBefore: number }

const cents = (n: number) => Math.round(n * 100) / 100
const NO_PREPAID: { total: number; takes: PrepaidTake[] } = { total: 0, takes: [] }

/** S654: a charge paid-ahead credit can clear — this lease's own, on a bill, not
 *  a failed attempt (cash retries that row), and a type the release pays the
 *  landlord for (rent, utilities, late fees, fees). Arrears, a home payment and a
 *  deposit are not: settled from GAM-held money, the landlord was never paid
 *  them. prepaidRelease's row query applies the same rule. */
function prepaidCanSettle(r: OpenChargeRow, leaseId: string | null): boolean {
  return !!leaseId && r.lease_id === leaseId && !!r.invoice_id
    && r.status !== 'failed' && Number(r.amount) > 0
    && (ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(r.type)
}

/** S654: a late fee is never cut in two — ux_payments_late_fee_idempotent allows
 *  one open-or-settled late fee per bill and due date, so a piece of one cannot
 *  be written. A credit takes it whole or leaves it to the cash. */
const wholeOnly = (r: { type: string }) => r.type === 'late_fee'

/** S654: how much of `want` one credit can lay on these rows: late fees whole
 *  (largest first) while they fit, the rest on rows that can be cut. The plan,
 *  the netting and the placement all use this, so they agree to the cent. */
function fitWhole(want: number, rows: { id: string; room: number; whole: boolean }[]): { total: number; whole: Set<string> } {
  let left = cents(want)
  const whole = new Set<string>()
  for (const r of rows.filter(x => x.whole && x.room > 0.005)
                      .sort((a, b) => b.room - a.room || a.id.localeCompare(b.id))) {
    if (r.room <= left + 0.005) { whole.add(r.id); left = cents(left - r.room) }
  }
  const cuttable = rows.filter(x => !x.whole).reduce((s, x) => s + Math.max(0, x.room), 0)
  return { total: cents(want - left + Math.min(left, cents(cuttable))), whole }
}

/**
 * S654: how much paid-ahead credit each open bill on a lease takes, OLDEST BILL
 * FIRST — each bill's month capped by the resident's monthly draw, the whole lot
 * by what is held. The charge settles exactly these amounts, bill by bill, and
 * the portal, the Balances list, the bill email and the tenant agent net this
 * same total, so the figure shown, the pay floor and what settles are one number.
 *
 * Reading only the oldest bill's month (round 2) let a later bill's dollars be
 * netted and never spent: Sept $460 + Oct $460 with $470 held asked $450, and
 * October stayed open with $460 of paid-ahead unspent.
 */
export async function prepaidPlan(
  client: PoolClient | Pool,
  leaseId: string,
  rows: OpenChargeRow[],
): Promise<{ total: number; takes: PrepaidTake[] }> {
  // Both only call .query(); a Pool serves a read just as well as a client.
  const c = client as PoolClient
  const onBill = new Map<string, OpenChargeRow[]>()
  for (const r of rows) {
    if (prepaidCanSettle(r, leaseId)) onBill.set(r.invoice_id!, [...(onBill.get(r.invoice_id!) ?? []), r])
  }
  if (onBill.size === 0) return { total: 0, takes: [] }
  const seen = [...onBill.keys()]
  const bills = (await c.query<{ id: string; due: string; month: string }>(
    `SELECT id, due_date::text AS due, to_char(date_trunc('month', due_date), 'YYYY-MM-01') AS month
       FROM invoices WHERE id = ANY($1::uuid[])`, [seen])).rows
    .sort((a, b) => a.due.localeCompare(b.due) || seen.indexOf(a.id) - seen.indexOf(b.id))

  // The same arithmetic prepaidDrawAvailable does, carried forward bill by bill
  // as consumePrepaidCreditForInvoice will draw them.
  const takes: PrepaidTake[] = []
  let remaining = 0
  let cap: number | null = null
  const drawn = new Map<string, number>()
  for (const b of bills) {
    if (!drawn.has(b.month)) {
      const d = await prepaidDrawAvailable(c, leaseId, b.month)
      if (drawn.size === 0) { remaining = d.remaining; cap = d.cap }
      drawn.set(b.month, d.drawnThisMonth)
    }
    if (remaining <= 0.005) break
    const avail = cap == null ? remaining : Math.max(0, Math.min(remaining, cents(cap - drawn.get(b.month)!)))
    const billRows = onBill.get(b.id) ?? []
    const take = fitWhole(avail, billRows.map(r => ({ id: r.id, room: Number(r.amount), whole: wholeOnly(r) }))).total
    if (take <= 0.005) continue
    takes.push({ invoiceId: b.id, month: b.month, take, availBefore: cents(avail) })
    remaining = cents(remaining - take)
    drawn.set(b.month, cents(drawn.get(b.month)! + take))
  }
  return { total: cents(takes.reduce((s, t) => s + t.take, 0)), takes }
}

/**
 * S654: the paid-ahead credit that comes off a lease's balance right now. One
 * rule (prepaidPlan) for the charge, the tenant's balance screen and the
 * landlord's outstanding list, so they never disagree (MH 25: the bill said
 * $450, the portal asked $460 because only the charge knew about this credit).
 * Pass the open rows you already hold, or the tenant to read them for.
 */
export async function prepaidNettable(
  client: PoolClient | Pool,
  leaseId: string,
  src: { rows: OpenChargeRow[] } | { tenantId: string },
): Promise<number> {
  const rows = 'rows' in src ? src.rows : await fetchOutstandingRows(src.tenantId, leaseId)
  return (await prepaidPlan(client, leaseId, rows)).total
}

/** S654: one row of a payment, divided between this payment's cash and each credit. */
export interface CreditSplit { id: string; amount: number; cash: number; prepaid: number; landlord: number }

/**
 * S654: where the credit sits on the rows of one payment, before any money moves.
 *
 * Each credit settles WHOLE rows only (S637), so a $460 bill with $10 paid ahead
 * and a $50 landlord credit, paid $400, used to split into $400 + a $60 remainder
 * that neither credit could clear: the bill stayed open with both credits
 * unspent. Instead each row is divided up front into what this payment's cash
 * covers, what paid-ahead credit covers (each bill's take, its oldest rows
 * first) and what the landlord's credit covers (this lease's own rows, newest
 * first, a failed attempt last). The cash part keeps the original row; each
 * credit part is its own row, and each credit's walk is then held to exactly the
 * rows cut for it. A late fee is laid whole or not at all (fitWhole).
 */
export function placeCredits(
  rows: OpenChargeRow[],
  opts: { leaseId: string | null; takes: PrepaidTake[]; landlordUse: number; includeCarried: boolean },
): { splits: CreditSplit[]; prepaidShort: number; landlordShort: number } {
  const positive = rows.filter(r => Number(r.amount) > 0)
  const total = positive.reduce((s, r) => s + Number(r.amount), 0)
  // The FIFO order every payment uses (propane, then arrears, sort last).
  const order = allocateOldestFirst(
    positive.map(r => ({ id: r.id, amount: Number(r.amount), due_date: r.due_date,
                         type: r.type, entry_description: r.entry_description ?? null })),
    total + 1).lines.map(l => l.payment_id)
  const byId = new Map(positive.map(r => [r.id, r]))
  const split = new Map<string, CreditSplit>()
  for (const id of order) {
    const r = byId.get(id)!
    if (r.type === 'carried_balance' && !opts.includeCarried) continue
    split.set(id, { id, amount: cents(Number(r.amount)), cash: cents(Number(r.amount)), prepaid: 0, landlord: 0 })
  }

  // Lay `want` of one credit on these rows: the late fees fitWhole picked, whole,
  // then the rest on cuttable rows in the order given.
  const lay = (want: number, ids: string[], bucket: 'prepaid' | 'landlord'): number => {
    const cands = ids.map(id => split.get(id)!).filter(x => x.cash > 0.005)
    const fit = fitWhole(want, cands.map(x => ({ id: x.id, room: x.cash, whole: wholeOnly(byId.get(x.id)!) })))
    const move = (x: CreditSplit, amt: number) => {
      x.cash = cents(x.cash - amt)
      x[bucket] = cents(x[bucket] + amt)
    }
    let left = cents(want)
    for (const x of cands) if (fit.whole.has(x.id)) { left = cents(left - x.cash); move(x, x.cash) }
    for (const x of cands) {
      if (left <= 0.005) break
      if (wholeOnly(byId.get(x.id)!)) continue
      const amt = cents(Math.min(left, x.cash))
      move(x, amt); left = cents(left - amt)
    }
    return Math.max(0, left)
  }

  let prepaidShort = 0
  for (const t of opts.takes) {
    const ids = order.filter(id => split.has(id) && byId.get(id)!.invoice_id === t.invoiceId
                                   && prepaidCanSettle(byId.get(id)!, opts.leaseId))
    prepaidShort = cents(prepaidShort + lay(t.take, ids, 'prepaid'))
  }
  const own = [...order].reverse().filter(id => split.has(id) && (byId.get(id)!.lease_id ?? null) === (opts.leaseId ?? null))
  const landlordShort = opts.landlordUse > 0.005
    ? lay(opts.landlordUse, [...own.filter(id => byId.get(id)!.status !== 'failed'),
                             ...own.filter(id => byId.get(id)!.status === 'failed')], 'landlord')
    : 0
  return { splits: order.map(id => split.get(id)).filter((x): x is CreditSplit => !!x), prepaidShort, landlordShort }
}

/**
 * S654: what the credit takes off one lease's open rows — the ONE netting rule.
 * The portal, the tenant agent and the charge all call it, so the figure shown,
 * the pay floor and what settles are one number.
 *
 * Paid-ahead first (prepaidPlan). Then the landlord's credit — `share`, this
 * lease's part of it as the portal assigns it — and only on this lease's own
 * rows: a neighbor's utility on a converged bill is another landlord's, so this
 * credit is never taken off it, and the charge collects it in cash. What the
 * credit can actually be laid on (fitWhole) is what comes off.
 */
export interface LeaseNet {
  total: number
  carried: number
  /** Everything but the carried balance — the pay-in-full part. */
  requiredBefore: number
  prepaid: { total: number; takes: PrepaidTake[] }
  /** This lease's share of the landlord's credit (S648: spent once, oldest bill first). */
  landlordShare: number
  /** What that share clears of the charges due now. */
  landlordRequired: number
  /** What it clears of everything, the carried balance included (the counter). */
  landlordAll: number
  /** The pay floor: due now, net of both credits. */
  requiredNow: number
  /** Everything owed, net of both credits. */
  outstanding: number
}

function ownRoom(rows: OpenChargeRow[], leaseId: string | null, prepaidTotal: number, withCarried: boolean): number {
  const own = rows.filter(r => (r.lease_id ?? null) === (leaseId ?? null) && Number(r.amount) > 0
                               && (withCarried || r.type !== 'carried_balance'))
  return Math.max(0, cents(own.reduce((s, r) => s + Number(r.amount), 0) - prepaidTotal))
}

export function netLease(
  rows: OpenChargeRow[], leaseId: string | null,
  prepaid: { total: number; takes: PrepaidTake[] }, share: number,
): LeaseNet {
  const total = cents(rows.reduce((s, r) => s + Number(r.amount), 0))
  const carried = cents(rows.filter(r => r.type === 'carried_balance').reduce((s, r) => s + Number(r.amount), 0))
  const requiredBefore = cents(total - carried)
  const laid = (use: number, includeCarried: boolean) => use <= 0.005 ? 0
    : cents(use - placeCredits(rows, { leaseId, takes: prepaid.takes, landlordUse: use, includeCarried }).landlordShort)
  const landlordRequired = laid(Math.min(share, ownRoom(rows, leaseId, prepaid.total, false)), false)
  const landlordAll = laid(share, true)
  return {
    total, carried, requiredBefore, prepaid, landlordShare: cents(share), landlordRequired, landlordAll,
    requiredNow: Math.max(0, cents(requiredBefore - prepaid.total - landlordRequired)),
    outstanding: Math.max(0, cents(total - prepaid.total - landlordAll)),
  }
}

/** S654: a tenant's open charges, one group per lease — the lease whose charge
 *  collects them. A neighbor's utility on a converged bill has no lease of its
 *  own and rides with the bill's lease (S616: "the whole thing has to be paid at
 *  once"), exactly as fetchOutstandingRows scopes the charge. Service-agreement
 *  bills are paid apart and are not here. */
export interface LeaseGroup {
  leaseId: string | null
  landlordId: string
  outstanding: number
  rows: OpenChargeRow[]
}

export async function openLeaseGroups(tenantId: string, client?: PoolClient): Promise<LeaseGroup[]> {
  const sql = `
    SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type, p.entry_description,
           p.invoice_id, p.status, p.lease_id, p.landlord_id,
           COALESCE(p.lease_id, inv.lease_id) AS group_lease_id,
           COALESCE(gl.landlord_id, p.landlord_id) AS group_landlord_id
      FROM payments p
      JOIN units u ON u.id = p.unit_id
      LEFT JOIN invoices inv ON inv.id = p.invoice_id
      LEFT JOIN leases gl ON gl.id = COALESCE(p.lease_id, inv.lease_id)
     WHERE p.tenant_id = $1
       AND p.work_trade_suspended_at IS NULL
       AND inv.service_agreement_id IS NULL
       AND ((p.status = 'pending' AND p.stripe_payment_intent_id IS NULL) OR p.status = 'failed')
     ORDER BY p.due_date ASC, p.created_at ASC`
  const rows: any[] = client ? (await client.query(sql, [tenantId])).rows : await query<any>(sql, [tenantId])
  const groups = new Map<string | null, LeaseGroup>()
  for (const r of rows) {
    let g = groups.get(r.group_lease_id)
    if (!g) { g = { leaseId: r.group_lease_id, landlordId: r.group_landlord_id, outstanding: 0, rows: [] }; groups.set(r.group_lease_id, g) }
    g.outstanding = cents(g.outstanding + Number(r.amount))
    g.rows.push(r)
  }
  return [...groups.values()]
}

/** S654: each group's paid-ahead plan and its share of its landlord's credit,
 *  allocated once across that landlord's groups, oldest bill first (S648). */
async function planGroups(client: PoolClient | Pool, tenantId: string, groups: LeaseGroup[]) {
  const c = client as PoolClient
  const credits = (await c.query<{ lease_id: string | null; landlord_id: string; amount: string }>(
    `SELECT lease_id, landlord_id, SUM(amount_remaining)::text AS amount
       FROM tenant_credits
      WHERE tenant_id = $1 AND status = 'active' AND amount_remaining > 0
      GROUP BY lease_id, landlord_id`, [tenantId])).rows
  const prepaid: { total: number; takes: PrepaidTake[] }[] = []
  for (const g of groups) prepaid.push(g.leaseId && g.rows.length ? await prepaidPlan(c, g.leaseId, g.rows) : NO_PREPAID)
  const keyOf = (i: number) => groups[i].leaseId ?? `no-lease:${i}`
  const share = groups.map(() => 0)
  const remaining = new Map<string, number>()
  for (const landlordId of new Set(groups.map(g => g.landlordId))) {
    const idx = groups.map((g, i) => (g.landlordId === landlordId ? i : -1)).filter(i => i >= 0)
    const alloc = allocateCredits(
      credits.filter(x => x.landlord_id === landlordId).map(x => ({ leaseId: x.lease_id, amount: Number(x.amount) })),
      idx.map(i => ({ key: keyOf(i), leaseId: groups[i].leaseId,
                      total: ownRoom(groups[i].rows, groups[i].leaseId, prepaid[i].total, true),
                      earliestDue: groups[i].rows[0]?.due_date ?? null })))
    for (const i of idx) share[i] = alloc.applied[keyOf(i)] ?? 0
    remaining.set(landlordId, alloc.remaining)
  }
  return { prepaid, share, remaining }
}

/** S654: every group netted (netLease), with the landlord credit still on the
 *  account after these bills shown once, on the first of that landlord's groups. */
export async function netLeaseGroups(
  client: PoolClient | Pool, tenantId: string, groups: LeaseGroup[],
): Promise<(LeaseNet & { creditRemaining: number })[]> {
  const { prepaid, share, remaining } = await planGroups(client, tenantId, groups)
  const out = groups.map((g, i) => ({ ...netLease(g.rows, g.leaseId, prepaid[i], share[i]), creditRemaining: 0 }))
  for (const [landlordId, left] of remaining) {
    const idx = groups.map((g, i) => (g.landlordId === landlordId ? i : -1)).filter(i => i >= 0)
    // A share the bill could not take (a late fee it would have to cut) stays on the account.
    const unlaid = idx.reduce((s, i) => s + out[i].landlordShare - out[i].landlordAll, 0)
    out[idx[0]].creditRemaining = cents(left + unlaid)
  }
  return out
}

/** S654: this lease's share of its landlord's credit, as the portal assigns it.
 *  A general credit nets on the lease the portal shows it on, not on whichever
 *  lease is charged. */
async function landlordShareFor(client: PoolClient, tenantId: string, leaseId: string): Promise<number> {
  const all = await openLeaseGroups(tenantId, client)
  const mine = all.find(g => g.leaseId === leaseId)
  if (!mine) return 0
  const groups = all.filter(g => g.landlordId === mine.landlordId)
  const { share } = await planGroups(client, tenantId, groups)
  return share[groups.indexOf(mine)] ?? 0
}

/** S654: the 409 a charge throws when credit already covers everything owed. */
export const CREDIT_COVERS_BALANCE = 'The credit on the account covers this balance'

/** S654: the 409 when the credit netted from the ask cannot be laid on the bill.
 *  Nothing is charged. It is the office's to settle, never a bank failure. */
export const CREDIT_NOT_PLACEABLE = 'The credit on this account can’t be applied to this bill automatically'

/** S654: the 409 a credit-only settle throws when something would still be owed. */
export const CREDIT_DOES_NOT_COVER = 'The credit on the account does not cover what is due'

/**
 * S654: close a lease's bill from its credits when they cover everything due now
 * — paid-ahead and landlord credit, exactly as the charge would lay them, with
 * nothing charged. Returns the credit applied, or 0 when there is nothing to
 * settle or the credit does not cover it (that bill waits for a payment). For
 * the jobs that leave a covered bill open behind a $0 portal: the invoice run
 * after its two walks, the late-fee run before it fees a bill, and the routes
 * that issue a credit or bank a paid-ahead surplus.
 */
export async function settleLeaseFromCredit(tenantId: string, leaseId: string): Promise<number> {
  try {
    const r = await chargeLeaseBalance({
      tenantId, leaseId, amount: 0, creditOnly: true, paymentMethodType: 'ach', source: 'system',
    })
    return r.creditNetted ?? 0
  } catch (e) {
    if (e instanceof AppError && e.statusCode === 409) {
      if (e.message.startsWith(CREDIT_NOT_PLACEABLE)) {
        logger.warn({ tenantId, leaseId }, '[settle-from-credit] credit covers the bill but could not be laid on it')
      }
      return 0
    }
    throw e
  }
}

export async function fetchOutstandingRows(tenantId: string, scope: BalanceScope | string, client?: PoolClient) {
  // Back-compat: every existing caller passes a lease id string.
  const sc: BalanceScope = typeof scope === 'string'
    ? { kind: 'lease', leaseId: scope } : scope
  const scopeSql = sc.kind === 'lease'
    ? `(p.lease_id = $2
        OR p.invoice_id IN (SELECT id FROM invoices WHERE lease_id = $2))`
    : `p.invoice_id IN (SELECT id FROM invoices WHERE service_agreement_id = $2)`
  const scopeId = sc.kind === 'lease' ? sc.leaseId : sc.serviceAgreementId
  // S654: a charge reads its rows inside its own transaction, under its lock.
  const run = (sql: string, params: unknown[]): Promise<any[]> =>
    client ? client.query(sql, params).then(r => r.rows) : query<any>(sql, params)
  return run(
    `SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type,
            -- S609: the allocator pays PROPANE last whatever its date, so a fill
            -- can't absorb money ahead of the rent it happens to predate.
            p.entry_description, p.invoice_id, p.status,
            p.lease_id, p.unit_id, p.landlord_id,
            u.property_id, u.payment_block,
            t.stripe_customer_id,
            l.user_id AS landlord_user_id,
            COALESCE(l.stripe_connect_account_id, lu.stripe_connect_account_id) AS stripe_connect_account_id,
            CASE WHEN l.stripe_connect_account_id IS NOT NULL THEN l.connect_charges_enabled   ELSE lu.connect_charges_enabled   END AS connect_charges_enabled,
            CASE WHEN l.stripe_connect_account_id IS NOT NULL THEN l.connect_details_submitted ELSE lu.connect_details_submitted END AS connect_details_submitted,
            par.ach_fee_payer, par.card_fee_payer
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN tenants t ON t.id = p.tenant_id
       JOIN landlords l ON l.id = p.landlord_id
       JOIN users lu ON lu.id = l.user_id
       LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
      WHERE p.tenant_id = $1
        -- S616 (Nic): the balance is what is on the DOCUMENT, not what the
        -- lease says. "When they get their rent bill, they get the utilities
        -- and the rent on the invoice and the whole thing has to be paid at
        -- once, not just pay in full locked to what the lease says."
        --
        -- A converged invoice carries rent owed to this landlord and utilities
        -- owed to the neighboring landlord. Those utility rows are deliberately
        -- NOT tied to this lease — they are not part of it — so scoping by
        -- lease_id alone made them invisible here: the pay-in-full guard would
        -- not have covered them and FIFO would never have allocated to them,
        -- leaving the tenant paying rent in full and the other landlord unpaid.
        -- That is the two-operator partial Nic ruled out as unallocatable.
        AND ${scopeSql}
        -- ── S637 (Nic): WORK-TRADE SUSPENDED ROWS ARE NOT OWED ──────────────
        --
        --   "Work trade is still showing people they owe a full balance."
        --
        -- A suspended row is a charge somebody's labor is paying — it settles
        -- at month close against approved hours, not in cash. Four other places
        -- already know this (the settlement job, the move-in bundle, the manual
        -- settle, utility billing) and skip them. This one did not, so a
        -- work-trade tenant was shown the gross bill and asked to pay it: Tyler
        -- Rhoades' whole $687.57 at Oak Park RV 03, every dollar of it covered.
        AND p.work_trade_suspended_at IS NULL
        AND ((p.status = 'pending' AND p.stripe_payment_intent_id IS NULL)
             OR p.status = 'failed')
      ORDER BY p.due_date ASC, p.created_at ASC`,
    [tenantId, scopeId])
}

/**
 * A SUGGESTION for the pay screen — roughly what the rest of the lease term's
 * rent comes to. NOT a limit (Nic): nothing here is enforced, and a tenant may
 * pay any amount above their balance.
 *
 * It exists only so the screen can say "about $6,000 covers the rest of your
 * lease" instead of leaving a tenant guessing at a blank box. Deliberately rent
 * and recurring fees only — utilities are unknowable until a meter is read,
 * which is the whole reason there is no cap.
 *
 * A month-to-month lease (no end date) gets a twelve-month horizon, since there
 * is no term to measure.
 */
export async function suggestedPayAheadFor(leaseId: string): Promise<number> {
  const row = await queryOne<{
    rent: string; end_date: string | null; fees: string
  }>(
    `SELECT l.rent_amount::text AS rent,
            l.end_date::text    AS end_date,
            COALESCE((SELECT SUM(lf.amount) FROM lease_fees lf
                       WHERE lf.lease_id = l.id AND lf.due_timing = 'monthly_ongoing'), 0)::text AS fees
       FROM leases l WHERE l.id = $1`,
    [leaseId])
  if (!row) return 0
  const perMonth = Number(row.rent) + Number(row.fees)
  if (!(perMonth > 0)) return 0

  const MONTH_TO_MONTH_HORIZON = 12
  let months = MONTH_TO_MONTH_HORIZON
  if (row.end_date) {
    const now = new Date()
    const end = new Date(`${row.end_date}T00:00:00Z`)
    months = (end.getUTCFullYear() - now.getUTCFullYear()) * 12
          + (end.getUTCMonth() - now.getUTCMonth())
    months = Math.max(0, Math.min(months, MONTH_TO_MONTH_HORIZON))
  }
  return Math.round(perMonth * months * 100) / 100
}

/**
 * Resolve the ONE lease a charge settles when the caller didn't name one.
 * Falls back to the tenant's single outstanding lease (the launch norm) and
 * refuses when they span several — each lease is its own charge and its own
 * receipt (S581), so the client must pick.
 */
export async function resolveTargetLease(
  tenantId: string, explicitLeaseId: string | null,
): Promise<string> {
  const outstanding = await query<{ lease_id: string }>(
    `SELECT DISTINCT p.lease_id
       FROM payments p
      WHERE p.tenant_id = $1
        AND ((p.status = 'pending' AND p.stripe_payment_intent_id IS NULL)
             OR p.status = 'failed')`,
    [tenantId])
  if (outstanding.length === 0) throw new AppError(409, 'Nothing outstanding to pay')
  if (explicitLeaseId) {
    if (!outstanding.some(l => l.lease_id === explicitLeaseId)) {
      throw new AppError(409, 'That lease has nothing outstanding to pay')
    }
    return explicitLeaseId
  }
  if (outstanding.length === 1) return outstanding[0].lease_id
  throw new AppError(400, 'You have balances on more than one lease — pay each one separately.')
}

export const chargeLeaseBalanceSchema = z.object({
  amount:            z.number().positive(),
  paymentMethodId:   z.string().min(1),
  paymentMethodType: z.enum(['ach', 'card']),
  /** S616: a payer with no lease settles their service agreement's bill —
   *  every utility on it, in one charge. */
  serviceAgreementId: z.string().uuid().optional(),
  // S581 (Nic): ONE lease per charge. A tenant with two leases (an overlap
  // while moving to a bigger place, or two different landlords) pays each
  // lease as its OWN ACH/card charge with its OWN receipt. Separate charges
  // mean: (a) a bank shortfall fails only that lease, not both — the other
  // still has a chance to clear; (b) the capped processing fee is charged
  // per lease (one combined charge would let two people sharing a bank
  // account share a single capped fee — a revenue leak AND a scam vector);
  // (c) an eviction hold on one landlord's lease never blocks paying an
  // unrelated landlord's lease. Omitted for the single-lease case (launch
  // norm) — the one outstanding lease is resolved automatically.
  leaseId:           z.string().uuid().optional(),
})

export async function chargeLeaseBalance(
  input: ChargeLeaseBalanceInput,
): Promise<ChargeLeaseBalanceResult> {
  const { tenantId, leaseId, serviceAgreementId, paymentMethodId, paymentMethodType } = input
  let amount = input.amount
  if (!leaseId && !serviceAgreementId) {
    throw new AppError(400, 'A balance needs either a lease or a service agreement to settle.')
  }
  const scope: BalanceScope = leaseId
    ? { kind: 'lease', leaseId }
    : { kind: 'service', serviceAgreementId: serviceAgreementId! }
  const client = await getClient()
  try {
    // S654: one charge per lease at a time. Autopay, the portal and the desk can
    // land together, and each one reads the open rows and then writes to them —
    // so the read happens inside the transaction, under the lock.
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [leaseId ? `lease_charge:${leaseId}` : `service_charge:${serviceAgreementId}`])

    // The tenant's outstanding ledger FOR THIS LEASE, oldest first. Every row
    // shares one lease → one unit → one landlord → one property, so ctx (row 0)
    // is representative of the whole charge (incl. the eviction-hold check).
    const rows = await fetchOutstandingRows(tenantId, scope, client)
    if (rows.length === 0) throw new AppError(409, 'Nothing outstanding to pay')
    // S654: this lease's own row — on a converged bill the oldest row can be the
    // neighbor's utility, which would put the remittance on the wrong landlord
    // and no lease (a surplus could not then bank as this lease's paid-ahead).
    const ctx = (leaseId && rows.find((r: any) => r.lease_id === leaseId)) || rows[0]
    if (ctx.payment_block) {
      throw new AppError(409, 'This unit is in eviction mode — payments to the landlord are paused. Accepting one could reset the eviction timeline. Contact the landlord.')
    }

    const totalOutstanding = Math.round(rows.reduce((sum: number, r: any) => sum + r.amount, 0) * 100) / 100

    // S622 (Nic): the CARRIED-FORWARD balance is the one charge a tenant may pay
    // partially. Everything the new lease itself invoiced stays pay-in-full.
    //
    //   "Outstanding balance that is carried forward should be exempt from first
    //    in, first out, and that balance should allow partial payments. The
    //    invoiced portion of the lease shouldn't allow partial payments."
    //
    // Without this the two rules collide and the tenant is trapped: arrears are
    // the oldest charge, so pay-in-full demands rent PLUS the entire old debt
    // before it will accept a cent. A tenant a thousand dollars behind could
    // never pay their rent at all — and would take a late fee every month for it.
    //
    // The debt does not shrink. It is still on the ledger, still owed, still
    // collected by anything paid above the required figure (it sorts last, so
    // the surplus reaches it only after current charges are whole).
    const carriedOutstanding = Math.round(
      rows.filter((r: any) => r.type === 'carried_balance')
          .reduce((sum: number, r: any) => sum + r.amount, 0) * 100) / 100

    // ── S637: A CREDIT IS MONEY THE LANDLORD OWES BACK, SO IT REDUCES THE ASK ──
    //
    // Nic (DIRECTIVE): "It's a credit against the overall ledger, not fucking
    // settling partial payments." Credits no longer pre-settle or split charges,
    // so a $1,000 rent charge stays a whole $1,000 row while a $300 credit sits
    // on the account. Netted here, the tenant is asked for $700 — which is what
    // they owe.
    //
    // THIS IS LOAD-BEARING, not cosmetic. Rent is pay-in-full, and the check
    // below rejects anything under `requiredInFull`. Without this subtraction a
    // tenant holding a credit would be told to pay the gross, refused when they
    // paid the net, and take a late fee for a debt the landlord owed THEM.
    // Netting must therefore happen before the pay-in-full gate, not after.
    // BOTH kinds of credit count. A landlord-issued credit and money the tenant
    // paid ahead are the same thing from the tenant's side — a balance the
    // landlord owes back — and they live in two tables only because they were
    // built months apart.
    //
    // S653/S654: paid-ahead first, every open bill oldest first, each by its own
    // month's draw (prepaidPlan). Then the landlord's credit — only this lease's
    // share of it as the portal assigns it (a general credit is spent once,
    // oldest bill first across that landlord's leases, S648), and only on this
    // lease's own rows (never a neighbor's utility on a converged bill). netLease
    // is the one rule the portal, the Balances list and the tenant agent use.
    const prepaid = leaseId ? await prepaidPlan(client, leaseId, rows) : NO_PREPAID
    const prepaidPart = prepaid.total
    const landlordShare = leaseId ? await landlordShareFor(client, tenantId, leaseId) : 0
    const net = leaseId ? netLease(rows, leaseId, prepaid, landlordShare) : null

    // S654: the counter takes what is OWED — the balance less the credit on the
    // account, the same figure the portal and the desk show — whatever the
    // caller typed. The credit then clears the rest in the same transaction.
    const creditNetted = input.chargeEverything && net ? cents(prepaidPart + net.landlordAll) : 0
    if (input.chargeEverything) amount = cents(totalOutstanding - creditNetted)

    // The credit covers the lease's own charges first — those are what the
    // pay-in-full rule and the eviction clock run on. Never below zero: a credit
    // bigger than the bill leaves the rest on the account, it does not hand out
    // change.
    const requiredBeforeCredit = Math.round((totalOutstanding - carriedOutstanding) * 100) / 100
    const creditToRequired = net ? cents(prepaidPart + net.landlordRequired) : 0
    const requiredInFull = Math.round((requiredBeforeCredit - creditToRequired) * 100) / 100
    // S654: autopay takes the server's own figure, never a gross sum it added
    // up itself — otherwise a covered dollar is pulled and banked as paid-ahead.
    if (input.chargeRequiredOnly || input.creditOnly) amount = requiredInFull
    if (input.creditOnly && amount >= 0.005) throw new AppError(409, CREDIT_DOES_NOT_COVER)

    // ── S654: THE CREDIT COVERS EVERYTHING THIS CHARGE WOULD TAKE ─────────────
    // Before, this threw 409 and the bill stayed open behind a $0 portal: $10
    // paid ahead and a $450 credit on a $460 bill — neither clears a whole row
    // alone, so neither was spent, and the late-fee run fed the bill. Now the
    // credits settle it here, with no money moving and no Stripe call.
    const creditOnly = (!!input.chargeRequiredOnly || !!input.chargeEverything || !!input.creditOnly) && amount < 0.005
    if (creditOnly) {
      // Only arrears open: nothing is due now, so there is nothing to settle.
      if ((input.chargeEverything ? creditNetted : creditToRequired) < 0.005) {
        throw new AppError(409, CREDIT_COVERS_BALANCE)
      }
      // The reader cannot take a $0 card; the desk settles it from the credit.
      if (input.existingIntent || (input.dryRun && paymentMethodType === 'card_present')) {
        throw new AppError(409, `${CREDIT_COVERS_BALANCE} — there is nothing to take on a card.`)
      }
    } else if (!ctx.stripe_customer_id && paymentMethodType !== 'card_present') {
      throw new AppError(409, 'Tenant has no Stripe customer — complete ACH setup first')
    }

    // UNDER-PAYMENT IS BLOCKED (Nic, standing directive). Rent is pay-in-full:
    // a partial can reset a landlord's eviction clock. This branch is the
    // server-side guarantee and must not be softened — note the figure it guards
    // is now the lease's OWN charges, which is exactly what the eviction clock
    // runs on. Arrears from a previous system never started that clock.
    if (!creditOnly && amount < requiredInFull - 0.005) {
      const extra = carriedOutstanding > 0
        ? ` Your carried balance of $${carriedOutstanding.toFixed(2)} can be paid down separately, in any amount.`
        : ''
      throw new AppError(422,
        `Rent must be paid in full — the outstanding balance is $${requiredInFull.toFixed(2)}.${extra}`)
    }

    // S622 (Nic): CURRENT CHARGES COME FIRST, ACROSS THE LANDLORD'S LEASES.
    //
    //   "I think all active charges should be brought current before... they
    //    couldn't just pay eight hundred dollars on space b while leaving the
    //    five hundred dollar lease open."
    //
    // Three of Oak Park's tenants rent two spaces each. Paying down old arrears
    // on one space while current rent sits open on the other is backwards for
    // everyone: the tenant takes a late fee and starts an eviction clock on the
    // unpaid space, having just voluntarily handed over money.
    //
    // SCOPE, and the reasons — a portfolio-wide version of this rule is a trap:
    //
    //  * SAME LANDLORD ONLY. A tenant may hold leases with two different
    //    landlords (the overlap guard only blocks conflicts inside one bucket,
    //    so residential with one and storage with another is permitted).
    //    Refusing landlord B's money because landlord A is unpaid would be GAM
    //    withholding one landlord's rent over another's ledger.
    //
    //  * LEASES IN EVICTION HOLD ARE SKIPPED. payment_block PAUSES payments on
    //    a unit. Requiring such a lease to be brought current is unsatisfiable —
    //    the tenant is forbidden from paying it — and would permanently bar them
    //    from paying arrears anywhere. A floor must always be clearable.
    //
    // This reads across leases; it must NEVER leak into allocation. The money
    // still lands only on THIS lease's charges — see allocateOldestFirst below,
    // which only ever sees `rows`, scoped to this lease.
    if (carriedOutstanding > 0 && amount > requiredInFull + 0.005) {
      const blockers = await client.query<{ unit_number: string; owed: string }>(
        `SELECT u.unit_number, SUM(p.amount)::text AS owed
           FROM payments p
           JOIN units u ON u.id = p.unit_id
          WHERE p.tenant_id = $1
            AND p.lease_id <> $2
            AND p.landlord_id = $3
            AND p.type <> 'carried_balance'
            AND u.payment_block IS NOT TRUE
            AND ((p.status = 'pending' AND p.stripe_payment_intent_id IS NULL)
                 OR p.status = 'failed')
          GROUP BY u.unit_number
          ORDER BY u.unit_number`,
        [tenantId, leaseId, ctx.landlord_id])
      if (blockers.rows.length > 0) {
        const list = blockers.rows
          .map(b => `${b.unit_number} ($${Number(b.owed).toFixed(2)})`)
          .join(', ')
        throw new AppError(422,
          `Bring your other rent current first — ${list} still owes for this period. ` +
          `You can pay $${requiredInFull.toFixed(2)} here now; once every space is current you can put ` +
          `whatever you like toward your earlier balance.`)
      }
    }

    // OVER-payment is pay-ahead (S609, Nic). NO CEILING — see the header note.
    // GAM holds the surplus and releases it month by month as it is earned.

    // ── S654: THE CREDIT THIS PAYMENT LEANS ON ───────────────────────────────
    // What the cash leaves of the lease's own charges is what the credit covers
    // (all of what is owed at the counter). Paid-ahead first, then the
    // landlord's credit. Placed on the rows BEFORE anything is written, so each
    // credit gets rows it clears whole — and so nothing is charged when the
    // credit cannot be placed.
    const creditUse = !leaseId ? 0
      : input.chargeEverything ? creditNetted
      : Math.max(0, Math.min(creditToRequired, cents(requiredBeforeCredit - amount)))
    let splits: CreditSplit[] | null = null
    let prepaidTakes: PrepaidTake[] = []
    let landlordUse = 0
    // Cash above what the rows need — banked as paid-ahead (see the fallback below).
    let surplus = 0
    const notPlaceable = () => new AppError(409,
      `${CREDIT_NOT_PLACEABLE}. Nothing was charged — please ask the office to apply it.`)
    // Lay `use` of credit: paid-ahead first, oldest bill first (a smaller take
    // than planned still has to lie whole on its bill's rows — a late fee is not
    // cut), then the landlord's credit on what is left.
    const place = (use: number) => {
      const takes: PrepaidTake[] = []
      let prepaidLeft = Math.min(prepaidPart, use)
      for (const t of prepaid.takes) {
        if (prepaidLeft <= 0.005) break
        const want = cents(Math.min(t.take, prepaidLeft))
        const take = want >= t.take - 0.005 ? t.take
          : fitWhole(want, rows.filter((r: any) => r.invoice_id === t.invoiceId && prepaidCanSettle(r, leaseId!))
              .map((r: any) => ({ id: r.id, room: Number(r.amount), whole: wholeOnly(r) }))).total
        if (take <= 0.005) continue
        takes.push({ ...t, take })
        prepaidLeft = cents(prepaidLeft - take)
      }
      const landlord = cents(use - takes.reduce((x, t) => x + t.take, 0))
      const placed = placeCredits(rows, { leaseId: leaseId!, takes, landlordUse: landlord, includeCarried: !!input.chargeEverything })
      const cash = cents(placed.splits.reduce((x, sp) => x + sp.cash, 0))
      const cap = input.chargeEverything ? net!.landlordAll : net!.landlordRequired
      const ok = placed.prepaidShort <= 0.005 && placed.landlordShort <= 0.005 && landlord <= cap + 0.005
      return { takes, landlord, placed, cash, cap, ok }
    }
    if (leaseId && creditUse > 0.005) {
      let p = place(creditUse)
      // Paying above the floor uses that much less credit — unless the smaller
      // amount cannot lie on the bill (only late fees, which are never cut).
      // Then the whole netted credit is used and the extra cash is banked as
      // paid-ahead, exactly as any payment above the bill is.
      if (!p.ok && !input.chargeEverything && creditUse < creditToRequired - 0.005) {
        const whole = place(creditToRequired)
        if (whole.ok && whole.cash <= amount + 0.005) { p = whole; surplus = cents(amount - whole.cash) }
      }
      if (!p.ok || Math.abs(p.cash + surplus - amount) > 0.005) {
        logger.error({ leaseId, creditUse, landlordUse: p.landlord, landlordCap: p.cap, prepaidShort: p.placed.prepaidShort,
                       landlordShort: p.placed.landlordShort, cashTotal: p.cash, amount },
          '[pay-balance] credit could not be placed on the bill — nothing charged')
        throw notPlaceable()
      }
      splits = p.placed.splits
      prepaidTakes = p.takes
      landlordUse = p.landlord
    }

    const plan = splits
      ? { lines: splits.filter(sp => sp.cash > 0.005).map(sp => ({ payment_id: sp.id, amount_applied: sp.cash })), unapplied: surplus }
      : allocateOldestFirst(
        rows.map((r: any) => ({
          id: r.id, amount: r.amount, due_date: r.due_date,
          type: r.type, entry_description: r.entry_description,
        })),
        amount
      )
    const appliedTotal = Math.round((amount - plan.unapplied) * 100) / 100
    const rowById = new Map(rows.map((r: any) => [r.id, r]))

    // A pending piece of a split row, carrying the charge it came from. S654:
    // revenue_owner rides along, so a GAM charge's piece is never paid out as
    // the landlord's.
    const insertPiece = async (parentId: string, amt: number, note: string): Promise<string> => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                               type, amount, status, due_date, entry_description, notes, is_remainder, revenue_owner)
         SELECT unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                type, $2::numeric, 'pending', due_date, entry_description, $3, TRUE, revenue_owner
           FROM payments WHERE id = $1
         RETURNING id`,
        [parentId, amt.toFixed(2), note])
      return r.rows[0].id
    }

    // ── S637/S654: SPEND THE CREDIT AS PART OF THIS PAYMENT ─────────────────
    //
    // Netting the credit at the pay-in-full gate is only half the job: left
    // there, the tenant would pay exactly what they owe and STILL show a
    // balance, with the credit sitting unspent beside it. Cash and credit are
    // one payment event, inside one transaction.
    //
    // The rows were cut so each credit clears its own whole. Each walk is held
    // to exactly the rows cut for it — paid-ahead first, bill by bill, oldest
    // first, then the landlord's credit — and both run BEFORE any money moves:
    // if a row the ask was netted by is not settled, everything is rolled back
    // and nothing is charged (S654: it used to charge and leave the bill open).
    const fullyCoveredIds: string[] = []
    const writeSplitsAndSpendCredit = async (remittanceId: string | null): Promise<void> => {
      const prepaidIds = new Map<string, string[]>()
      const addPrepaid = (invoiceId: string, id: string) => prepaidIds.set(invoiceId, [...(prepaidIds.get(invoiceId) ?? []), id])
      const landlordIds: string[] = []
      const landlordPieces: { parentId: string; amount: number }[] = []
      const reopen: string[] = []
      for (const sp of splits!) {
        const row = rowById.get(sp.id)!
        if (sp.cash > 0.005) {
          if (sp.cash < row.amount - 0.005) {
            await client.query(
              `UPDATE payments SET amount = $2::numeric,
                      notes = COALESCE(notes || ' — ', '') || 'paid in part by this payment; credit on the account covers the other $' || $3
                WHERE id = $1`,
              [row.id, sp.cash.toFixed(2), cents(sp.prepaid + sp.landlord).toFixed(2)])
          }
          fullyCoveredIds.push(row.id)
          await client.query(
            `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied)
             VALUES ($1, $2, $3)`,
            [remittanceId, row.id, sp.cash.toFixed(2)])
          if (sp.prepaid > 0.005) {
            addPrepaid(row.invoice_id, await insertPiece(row.id, sp.prepaid, 'Covered by paid-ahead credit, with the payment that paid the rest'))
          }
        } else if (sp.prepaid > 0.005) {
          if (sp.landlord > 0.005) {
            await client.query(`UPDATE payments SET amount = $2::numeric WHERE id = $1`, [row.id, sp.prepaid.toFixed(2)])
          }
          addPrepaid(row.invoice_id, row.id)
        } else if (sp.landlord > 0.005) {
          landlordIds.push(row.id)
          if (row.status === 'failed') reopen.push(row.id)
        }
        if (sp.landlord > 0.005 && (sp.cash > 0.005 || sp.prepaid > 0.005)) {
          landlordPieces.push({ parentId: row.id, amount: sp.landlord })
        }
      }
      // S654: a failed attempt the landlord's credit covers whole is reopened for
      // the credit to settle — its retry is no longer owed. (A failed row with
      // any cash on it keeps that cash and is retried by this payment.)
      if (reopen.length) {
        await client.query(
          `UPDATE payments SET status = 'pending', stripe_payment_intent_id = NULL, next_retry_at = NULL,
                  notes = COALESCE(notes || ' — ', '') || 'failed payment covered by account credit'
            WHERE id = ANY($1::uuid[]) AND status = 'failed'`, [reopen])
      }
      const creditRowIds: string[] = []
      for (const t of prepaidTakes) {
        const ids = prepaidIds.get(t.invoiceId) ?? []
        if (!ids.length) continue
        creditRowIds.push(...ids)
        await consumePrepaidCreditForInvoice(client, { leaseId: leaseId!, invoiceId: t.invoiceId, rowIds: ids })
      }
      for (const p of landlordPieces) {
        landlordIds.push(await insertPiece(p.parentId, p.amount, 'Covered by account credit, with the payment that paid the rest'))
      }
      creditRowIds.push(...landlordIds)
      if (landlordIds.length) {
        await applyCreditsToOpenCharges(client, { leaseId: leaseId!, scope: 'rows', rowIds: landlordIds, tenantId })
      }
      const open = await client.query<{ open: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS open FROM payments
          WHERE id = ANY($1::uuid[]) AND status <> 'settled'`, [creditRowIds])
      const stillOpen = cents(Number(open.rows[0]?.open ?? 0))
      if (stillOpen > 0.005) {
        // A paid-ahead release that could not book the landlord's share has
        // already raised its own alert; the caller is told it is the office's.
        logger.error({ leaseId, remittanceId, stillOpen }, '[pay-balance] credit netted from the ask could not be spent — nothing charged')
        throw notPlaceable()
      }
    }

    // S654: what the landlord's credit may still clear on this lease — its share
    // less what this payment laid — against whole arrears rows (the old
    // lease-wide pass, now capped so it never spends another lease's share).
    const sweepLandlordCredit = async (): Promise<void> => {
      const cap = leaseId ? cents(landlordShare - landlordUse) : 0
      if (cap > 0.005) {
        await applyCreditsToOpenCharges(client, { leaseId: leaseId!, scope: 'lease', tenantId, maxApply: cap })
      }
    }

    if (creditOnly) {
      if (input.dryRun) {
        await client.query('ROLLBACK')
        return {
          remittanceId: '', paymentIntentId: '', status: 'quote',
          appliedTotal: 0, payAhead: 0, platformCutAmount: 0, chargeAmount: 0,
          processingFee: 0, platformFeePassthrough: 0, lines: [],
          outstanding: totalOutstanding, creditNetted: creditUse,
        }
      }
      await writeSplitsAndSpendCredit(null)
      await sweepLandlordCredit()
      await client.query('COMMIT')
      logger.info({ leaseId, tenantId, creditUse, source: input.source }, '[pay-balance] settled from credit — nothing charged')
      return {
        remittanceId: '', paymentIntentId: '', status: 'settled_by_credit',
        appliedTotal: 0, payAhead: 0, platformCutAmount: 0, chargeAmount: 0,
        processingFee: 0, platformFeePassthrough: 0, lines: [],
        outstanding: totalOutstanding, creditNetted: creditUse,
      }
    }

    const landlordConnectReady =
      !!ctx.stripe_connect_account_id &&
      ctx.connect_charges_enabled === true &&
      ctx.connect_details_submitted === true

    // Only a card needs the SDK here (issuing country for the non-US surcharge).
    // Building the client on the ACH path made every bank payment depend on it.
    let cardCountry: string | null = null
    if (paymentMethodType === 'card' && paymentMethodId) {
      const pm = await getStripe().paymentMethods.retrieve(paymentMethodId)
      cardCountry = pm.card?.country ?? null
    }

    // The fee is computed on the WHOLE amount the tenant chose to pay,
    // pay-ahead surplus included — Stripe charges us on every dollar it
    // processes and GAM never absorbs a banking fee. allocation.ts reads the
    // same total back off the remittance so its books match this exactly.
    // S654: a card is a card — the counter reader prices like the portal (Nic:
    // "cards anywhere are the same").
    const basePlatformCut = computePlatformCut({
      amount,
      paymentMethod: paymentMethodType === 'ach' ? 'ach' : 'card',
      cardCountry,
    })

    // Tenant-payer platform fee passthrough — same as /:id/pay.
    const unpaidAccruals = await query<{ id: string; total_amount: string }>(
      `SELECT id, total_amount FROM platform_fee_accruals
        WHERE property_id = $1 AND payer = 'tenant'
          AND tenant_charge_id IS NULL AND total_amount > 0`,
      [ctx.property_id]
    )
    const passthroughAmount = unpaidAccruals.reduce((sum, r) => sum + parseFloat(r.total_amount), 0)

    // Sublease markup — applies per covered RENT month (rare; sublessee pays
    // marked-up rent, the markup goes to the sublessor at settle). S581: the
    // per-month markup is STAMPED on each covered rent row below
    // (sublease_markup_amount) so allocation subtracts it from the landlord's
    // owner_share and the sublessor is credited that same amount.
    let subleaseMarkup = 0
    let subleasePerMonth = 0
    const coveredRentIds: string[] = plan.lines
      .filter(ln => rowById.get(ln.payment_id)?.type === 'rent'
        && Math.abs(ln.amount_applied - rowById.get(ln.payment_id)!.amount) < 0.005)
      .map(ln => ln.payment_id)
    {
      const sub = await queryOne<{ sub: string; master: string }>(
        `SELECT s.sub_monthly_amount::text AS sub, s.master_share_amount::text AS master
           FROM subleases s JOIN leases l ON l.id = s.master_lease_id
          WHERE l.unit_id = $1 AND s.sublessee_tenant_id = $2 AND s.status = 'active'
          LIMIT 1`,
        [ctx.unit_id, tenantId],
      )
      if (sub) {
        subleasePerMonth = Math.max(0, parseFloat(sub.sub) - parseFloat(sub.master))
        subleaseMarkup = subleasePerMonth * coveredRentIds.length
      }
    }

    // GAM supersedence claims only what actually lands on obligations — a
    // pay-ahead surplus is the tenant's money held for future rent, not
    // available cash to sweep.
    const gamSupersedenceAmount = Math.min(appliedTotal, await computeTenantGamOutstandingTotal(tenantId))
    const platformCutAmount = Math.round(
      (basePlatformCut + passthroughAmount + subleaseMarkup + gamSupersedenceAmount) * 100) / 100

    // S562: tenant-borne processing fee rides on top of the lump charge.
    // Fee-payer resolved from the first row's property (ctx) — a single
    // ACH/card transaction means one capped customer-facing fee on the whole
    // lump, matching Stripe's single-transaction cost.
    // S654: the processing fee and a passed-on platform fee are two things and
    // are returned apart, so nothing calls the platform fee a processing fee.
    const feePayer = paymentMethodType === 'ach' ? ctx.ach_fee_payer : ctx.card_fee_payer
    const tenantPaysProcessingFee = feePayer !== 'landlord'
    const processingFee = cents(tenantPaysProcessingFee ? basePlatformCut : 0)
    const platformFeePassthrough = cents(passthroughAmount)
    const tenantBorneOnTop = cents(processingFee + platformFeePassthrough)
    const chargeAmount = Math.round((amount + tenantBorneOnTop) * 100) / 100

    if (input.dryRun) {
      // S654: the quote the reader screen shows. Nothing written.
      await client.query('ROLLBACK')
      return {
        remittanceId: '', paymentIntentId: '', status: 'quote',
        appliedTotal, payAhead: plan.unapplied, platformCutAmount,
        chargeAmount, processingFee, platformFeePassthrough, lines: plan.lines,
        outstanding: totalOutstanding, creditNetted,
      }
    }

    // Create the remittance BEFORE the Stripe call so the PI metadata can
    // carry its id; stamp the PI after.
    const rem = await client.query<{ id: string }>(
      // S616: gross_amount and processing_fee_amount are the two figures that
      // let GAM tie out to Stripe. They were computed a few lines above, sent
      // to Stripe, and then thrown away — so nothing on our side could tell a
      // missing payment from a fee difference. chargeAmount IS what Stripe is
      // asked for; tenantBorneOnTop is the part of it that is not the
      // obligation.
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
          payment_method, gross_amount, processing_fee_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [tenantId, ctx.lease_id, ctx.landlord_id, amount.toFixed(2),
       appliedTotal.toFixed(2), plan.unapplied.toFixed(2), paymentMethodType === 'ach' ? 'ach' : 'card',
       chargeAmount.toFixed(2), tenantBorneOnTop.toFixed(2)])
    const remittanceId = rem.rows[0].id

    // Apply the plan: split the partial row, record every line.
    if (splits) {
      await writeSplitsAndSpendCredit(remittanceId)
    } else {
      for (const line of plan.lines) {
        const row = rowById.get(line.payment_id)!
        const isFull = Math.abs(line.amount_applied - row.amount) < 0.005
        const coveredPaymentId = line.payment_id
        if (!isFull) {
          // Split (propaneRedistribution pattern): the applied slice takes
          // the charge; a remainder row stays pending — late fees remain
          // truthful about the unpaid portion ("short is short").
          const remainder = Math.round((row.amount - line.amount_applied) * 100) / 100
          await client.query(
            `UPDATE payments SET amount = $2::numeric,
                    notes = COALESCE(notes || ' — ', '') || 'partially covered by Pay Now (FIFO application); $' || $3 || ' remains on a separate row'
              WHERE id = $1`,
            [row.id, line.amount_applied.toFixed(2), remainder.toFixed(2)])
          await insertPiece(row.id, remainder, 'Remainder after FIFO application of a partial payment')
        }
        fullyCoveredIds.push(coveredPaymentId)
        await client.query(
          `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied)
           VALUES ($1, $2, $3)`,
          [remittanceId, coveredPaymentId, line.amount_applied.toFixed(2)])
      }
    }

    // S560 money-flow rebuild (Phase 1): ALWAYS platform charge — money held by
    // GAM, batched to the landlord on the weekly run.
    let intent: { id: string; status: string }
    if (input.existingIntent) {
      // S654: the counter reader already holds an authorization. It was created
      // for the quote this same arithmetic produced moments ago; if the balance
      // moved in between, nothing is booked and the desk starts over.
      const want = Math.round(chargeAmount * 100)
      if (want !== input.existingIntent.amountCents) {
        throw new AppError(409,
          `The balance changed since the reader was sent $${(input.existingIntent.amountCents / 100).toFixed(2)} — it is now $${chargeAmount.toFixed(2)}. Cancel on the reader and start again.`)
      }
      // Same metadata shape as a portal card charge, so payment_intent.succeeded
      // settles these rows down the one path every card payment takes.
      await getStripe().paymentIntents.update(input.existingIntent.id, {
        description: 'BALANCE - Gold Asset Management',
        metadata: {
          gam_purpose: 'rent_terminal',
          entry_description: 'BALANCE',
          platform_held: 'true',
          gam_remittance_id: remittanceId,
          tenant_id: tenantId,
          landlord_id: ctx.landlord_id,
          gam_charge_source: input.source,
        },
      })
      intent = { id: input.existingIntent.id, status: 'requires_capture' }
    } else {
      if (!paymentMethodId) throw new AppError(400, 'A saved payment method is required')
      intent = await createRentPlatformCharge({
        amount: chargeAmount,
        stripeCustomerId: ctx.stripe_customer_id,
        paymentMethodId,
        paymentMethodTypes: paymentMethodType === 'ach' ? ['us_bank_account'] : ['card'],
        entryDescription: 'BALANCE',
        metadata: {
          gam_remittance_id: remittanceId,
          tenant_id: tenantId,
          landlord_id: ctx.landlord_id,
          gam_charge_source: input.source,
        },
      })
    }

    // Stamp the PI on every covered row — the standard webhook settle
    // path (allocation engine, credit ledger, propane, supersedence)
    // picks them ALL up by PI id, unchanged.
    await client.query(
      `UPDATE payments SET status = 'processing', stripe_payment_intent_id = $1,
              platform_held = TRUE,
              -- S654: how the card was presented, for the history.
              payment_channel = $3
        WHERE id = ANY($2::uuid[])`,
      [intent.id, fullyCoveredIds, paymentMethodType === 'card_present' ? 'in_person' : 'online'])
    // S581: stamp the per-month sublease markup on each covered rent row so
    // allocation nets it out of the landlord's owner_share.
    if (subleasePerMonth > 0 && coveredRentIds.length > 0) {
      await client.query(
        `UPDATE payments SET sublease_markup_amount = $1 WHERE id = ANY($2::uuid[])`,
        [subleasePerMonth.toFixed(2), coveredRentIds])
    }
    await client.query(
      `UPDATE tenant_remittances SET stripe_payment_intent_id = $1, updated_at = NOW() WHERE id = $2`,
      [intent.id, remittanceId])
    if (unpaidAccruals.length > 0) {
      // Claim passthrough accruals against the oldest covered row (the
      // reconciliation anchor) — same one-winner semantics as /:id/pay.
      await client.query(
        `UPDATE platform_fee_accruals SET tenant_charge_id = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[]) AND tenant_charge_id IS NULL`,
        [fullyCoveredIds[0], unpaidAccruals.map(r => r.id)])
    }
    // After the stamp, so the cash rows are out of its reach.
    await sweepLandlordCredit()

    if (input.existingIntent?.capture) {
      // S654: the counter reader. Capture BEFORE the commit, so a capture that
      // fails rolls every row back with it — nothing half-booked, no hold left
      // hanging under a "booked" label. The intent is put back in its pending
      // shape and released, and the desk simply starts again.
      const piId = input.existingIntent.id
      try {
        await getStripe().paymentIntents.capture(piId)
        intent = { id: piId, status: 'succeeded' }
      } catch (captureErr) {
        const live = await getStripe().paymentIntents.retrieve(piId).catch(() => null)
        if (live && live.status === 'succeeded') {
          // The capture landed and only the reply was lost. Keep the booking.
          intent = { id: piId, status: 'succeeded' }
        } else {
          await getStripe().paymentIntents.update(piId, {
            metadata: { gam_purpose: 'rent_terminal_pending', gam_remittance_id: '', entry_description: '', platform_held: '', gam_charge_source: '' },
          }).catch(() => {})
          if (live && live.status === 'requires_capture') {
            await getStripe().paymentIntents.cancel(piId).catch(() => {})
          }
          logger.error({ err: captureErr, paymentIntentId: piId }, '[reader] capture failed — booking rolled back, hold released')
          throw new AppError(502, 'The card could not be captured — nothing was recorded. Send it to the reader again.')
        }
      }
    }

    await client.query('COMMIT')

    if (!landlordConnectReady) {
      // Held fine; can't batch out until this landlord finishes Connect onboarding.
      await createAdminNotification({
        severity: 'warn',
        category: 'platform_held_rent_charge',
        title: `Held balance payment can't batch out — landlord ${ctx.landlord_user_id} not Connect-ready`,
        body: `Remittance ${remittanceId} for $${amount.toFixed(2)} is held on the GAM platform balance. It batches to the landlord once they finish Connect onboarding.`,
        context: { remittance_id: remittanceId, landlord_id: ctx.landlord_id, amount },
      })
    }

    return {
      remittanceId,
      paymentIntentId: intent.id,
      status: intent.status,
      appliedTotal,
      payAhead: plan.unapplied,
      platformCutAmount,
      chargeAmount,
      processingFee,
      platformFeePassthrough,
      lines: plan.lines,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
