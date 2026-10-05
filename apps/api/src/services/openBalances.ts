/**
 * WHO OWES WHAT, ONE DEFINITION (S654, rebuilt for the S655 money plan, Step 11).
 *
 * Every screen and agent that says what someone owes reads it from here: the
 * front-desk Outstanding list (GET /api/balances), the 7am overdue digest, the
 * landlord's balance reminder email, the tenant page, and the agents'
 * get_my_payment_status / get_my_balance_breakdown / lookup_tenant_payment_status
 * / get_delinquent_tenants / query_portfolio. Before this each had its own WHERE
 * clause, and they disagreed: the Outstanding list read invoices.total_amount
 * (which never carries a late fee and misses a charge with no invoice), the
 * tenant agent counted 'returned' rows a dispute had already reopened and a
 * FlexPay pull, query_portfolio counted a payment still clearing as owed.
 *
 * THE RULE (openBalanceSql): a charge is owed now when nothing is moving on it
 * and a payer may settle it (moneyPredicates.payableRowSql: pending with no
 * payment started, or failed; not work-trade suspended; not GAM's FlexPay pull;
 * more than $0), and it is not rent the lease no longer owes (rent past a
 * shortened stay's end, creditUse.rentPastStayEndSql). What it owes in money is
 * its amount less any credit already spent on it (openAmountSql). Owed means
 * payable: the same row rule the portal and autopay pay by. A bounce is owed
 * ONCE, on the row the reversal reopened (money plan §1.1 / §3: the two-row
 * model) — the 'returned' original never is.
 *
 * THE BALANCE IS THE FULL BALANCE (Nic, 10/2): "landlord screens show the full
 * balance with 'credit available $X' beside it". Credit is never netted off the
 * figure any more. It applies by itself only when it covers a whole bill (that
 * bill is then settled and drops off this list); otherwise the payer chooses
 * "Use all $X" or "Save it for later" when they pay. So beside the balance:
 *   credit_available  what their credit would pay of these bills right now
 *                     (creditUse.householdQuote's plan: eligible rows only,
 *                     oldest bill first, within a monthly draw cap)
 *   credit_on_account the credit on file shown on that line
 * Across a list of people (Outstanding), credit is shown once per HOUSEHOLD
 * (decisions #48.8: everyone on a shared lease together): a one-person
 * household's own credit is beside them; a household of several lines has
 * all its credit — the lease's and each person's own general credit — on ONE
 * of its lines as household credit, available capped at what the household
 * owes (showCreditOncePerHousehold). Every credit dollar is on exactly one line.
 *
 * decisions #29 (Nic, 10/3) adds to each Outstanding row: every unpaid month
 * ("$X from August"), how late it is (the grace period honored — the credit
 * history's rule, daysLate), a payment still clearing ("Payment clearing": not
 * owed, not late, owed again if it bounces), the "Work trade" mark (never an
 * amount, never late) and the charge Record payment opens on. decisions #25:
 * a sum across people (outstandingTotals) goes only to a viewer
 * seesGrandTotals admits — account owners and property managers.
 */
import type { PoolClient } from 'pg'
import { FALLBACK_TIMEZONE } from '@gam/shared'
import { getClient, query } from '../db'
import type { AuthPayload } from '../middleware/auth'
import { addDaysTo, todayIn } from '../lib/timezone'
import { payableRowSql, bankPayableRowSql, allocationOrderSql } from './moneyPredicates'
import { householdQuote, planCredit, rentPastStayEndSql, HOUSEHOLD_MEMBER_STATUSES, type HouseholdQuote } from './creditUse'

// ─── The rule, as SQL ────────────────────────────────────────────────────────

const IDENT = /^[a-z_][a-z0-9_]*$/i
function alias(a: string): string {
  if (!IDENT.test(a)) throw new Error(`openBalances: "${a}" is not a table alias`)
  return a
}

/**
 * The charge row (alias `a`) is owed now. Built on the shared payable rule, so
 * a row whose payment is in flight ('processing', or pending with an intent),
 * a 'returned' original, a settled or paid-from-deposit row, a work-trade line
 * and the FlexPay pull are never owed.
 *
 * A bounce (decisions #29: "if it bounces the amount is owed again") is owed on
 * the row the reversal reopened (paymentReversal.handlePaymentReversal marks the
 * original 'returned' and writes a reopened row, payments.reversal_id, at the
 * original's money part), never on the original as well. That is the money
 * plan's two-row model (§1.1, §3), and it keeps "owed" and "payable" the same
 * thing: payableRowSql never accepts a 'returned' row, so a 'returned' row
 * counted here could be chased by the digest, the reminder and the agents while
 * no screen could take it. A return written WITHOUT a reopened row exists only
 * on legacy rows: ones marked 'returned' by the pre-release POST
 * /payments/:id/handle-return, which wrote the status and the code and no
 * reversal record. That route now reopens a settled bank debit through
 * paymentReversal; the rule here does not paper over the legacy rows.
 */
export function openBalanceSql(a = 'p'): string {
  const x = alias(a)
  return `(${payableRowSql(x)}
      AND NOT EXISTS (SELECT 1 FROM leases ob_pl
                       WHERE ob_pl.id = ${x}.lease_id AND ${rentPastStayEndSql(x, 'ob_pl')}))`
}

/**
 * The charge row (alias `a`) is the caller's household's (S652: one household
 * balance): billed to them, or on a lease they are on now — active, joining or
 * leaving — whoever it is billed to. Lease charges carry the primary
 * resident's tenant_id, so a co-tenant asking what they owe must count the
 * lease's rows too. The lease is the row's own, else its bill's (a neighbor
 * company's utility on the household's invoice, S616). The same population the
 * tenant's Pay Now reads (GET /payments/balance-context, creditUse.householdQuote),
 * so the agent's "you owe $X" is the figure Pay Now quotes. `tenantParam` is the
 * placeholder holding the caller's tenant id.
 */
export function householdRowSql(a = 'p', tenantParam = '$1'): string {
  const x = alias(a)
  if (!/^\$\d+$/.test(tenantParam)) throw new Error(`openBalances: "${tenantParam}" is not a placeholder`)
  const member = HOUSEHOLD_MEMBER_STATUSES.map(s => `'${s}'`).join(',')
  return `(${x}.tenant_id = ${tenantParam}
      OR EXISTS (SELECT 1 FROM lease_tenants ob_lt
                  WHERE ob_lt.tenant_id = ${tenantParam}
                    AND ob_lt.status IN (${member})
                    AND ob_lt.lease_id = COALESCE(${x}.lease_id,
                          (SELECT ob_i.lease_id FROM invoices ob_i WHERE ob_i.id = ${x}.invoice_id))))`
}

/** What the row still owes in money: its amount less credit already spent on it. */
export function openAmountSql(a = 'p'): string {
  const x = alias(a)
  return `(${x}.amount - COALESCE((SELECT SUM(ob_u.amount) FROM credit_uses ob_u
                                    WHERE ob_u.payment_id = ${x}.id AND ob_u.status = 'applied'), 0))`
}

/**
 * Money on the row (alias `a`) is on its way: a card or bank payment was made
 * and is still clearing ('processing', or pending with a payment already
 * started). Already paid — never owed and never late (decisions #29: "Payment
 * clearing"); if the bank sends it back the row is owed again. GAM's FlexPay
 * pull is never a landlord's or a tenant's bill, so it is never "clearing" here.
 */
export function inFlightRowSql(a = 'p'): string {
  const x = alias(a)
  return `((${x}.status = 'processing' OR (${x}.status = 'pending' AND ${x}.stripe_payment_intent_id IS NOT NULL))
      AND ${x}.entry_description IS DISTINCT FROM 'FLEXPAY')`
}

/** The money part of an in-flight row: its amount less credit set aside or spent on it. */
export function inFlightMoneySql(a = 'p'): string {
  const x = alias(a)
  return `(${x}.amount - COALESCE((SELECT SUM(ob_f.amount) FROM credit_uses ob_f
                                    WHERE ob_f.payment_id = ${x}.id AND ob_f.status IN ('held','applied')), 0))`
}

/**
 * A charge work trade covers that has not closed yet: suspended, still open.
 * Never owed and never shown as an amount (decisions #29; S643: a tenant never
 * sees a dollar figure for work trade); the month-close run settles it against
 * the hours, and anything the hours do not cover is billed as its own charge.
 */
export function workTradeOpenRowSql(a = 'p'): string {
  const x = alias(a)
  return `(${x}.work_trade_suspended_at IS NOT NULL AND ${x}.status IN ('pending','failed'))`
}

// ─── Late, one rule ───────────────────────────────────────────────────────────
//
// decisions #29: Outstanding shows how late a household is, and the Payments
// ledger says "on time" or "N days late" for each payment, both "measured from
// the due date of the oldest bill, honoring the grace period". The same rule
// the credit history uses (creditLedgerEmitters.classifyPaymentTier): a bill
// paid on or before its last grace day is on time; after it, it is late by the
// days since the DUE date. Days are the property's calendar days.

/** The grace period when neither the lease nor the property names one (lateFees, creditLedgerEmitters). */
export const DEFAULT_LATE_GRACE_DAYS = 5

/** The grace days of a charge: its lease's, else its property's, else the default. */
export function graceDaysSql(l: string, pr: string): string {
  return `COALESCE(${alias(l)}.late_fee_grace_days, ${alias(pr)}.late_fee_grace_days, ${DEFAULT_LATE_GRACE_DAYS})`
}

/** The property's calendar day of an instant (the property alias may be NULL: GAM's fallback zone). */
export function propertyDaySql(instant: string, pr: string): string {
  return `((${instant}) AT TIME ZONE COALESCE(${alias(pr)}.timezone, '${FALLBACK_TIMEZONE}'))::date`
}

/** Days late on `day` for a bill due `due` with `grace` days: 0 through the last grace day. */
export function daysLateSql(day: string, due: string, grace: string): string {
  return `(CASE WHEN (${day}) > (${due}) + (${grace}) THEN (${day}) - (${due}) ELSE 0 END)`
}

/** The same rule in code, on 'YYYY-MM-DD' calendar days. */
export function daysLate(dueDate: string, day: string, graceDays: number): number {
  const d = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)))
  const after = Math.round((d(day) - d(dueDate)) / 86_400_000)
  return after > graceDays ? after : 0
}

// ─── Who sees a grand total ───────────────────────────────────────────────────

/**
 * decisions #25 (Nic, 10/3): "front desk / on-site staff never see a GRAND
 * TOTAL of what everyone owes. Only account owners and property managers see
 * grand totals (omitted server-side for everyone else, not just hidden)."
 * Per-person balances stay visible to staff who have balances.view. The ONE
 * place this is decided: every response that carries a sum across people (the
 * Outstanding list's totals, a property's total, the Payments ledger's month
 * total) asks this, and leaves the figure out of the reply when it says no.
 */
export const GRAND_TOTAL_ROLES = ['admin', 'super_admin', 'landlord', 'property_manager'] as const
export function seesGrandTotals(user: Pick<AuthPayload, 'role'> | undefined | null): boolean {
  return !!user && (GRAND_TOTAL_ROLES as readonly string[]).includes(user.role)
}

// ─── Credit beside the balance ────────────────────────────────────────────────

export interface CreditBeside {
  /** What their credit would pay of their open bills right now (the plan). */
  usable: number
  /** usable, per lease (a general credit is split oldest bill first). */
  usableByLease: Map<string, number>
  /**
   * usableByLease split by whose credit it is. A credit tied to a lease is the
   * lease's: everyone on that lease sees the same money in their own quote, so
   * a list across people shows it once (keyed by the lease). A general credit
   * (no lease) is this person's own: it is shown beside them only (keyed by
   * the lease of the bill it would pay).
   */
  sharedUsableByLease: Map<string, number>
  ownUsableByLease: Map<string, number>
  /** onFile split the same way: credit tied to a lease, by that lease; this person's own general credit. */
  sharedOnFileByLease: Map<string, number>
  ownOnFile: number
  /** Every dollar on file: remaining, plus what a payment now would give back from a scheduled retry. */
  onFile: number
  /** onFile by kind. */
  paidAhead: number
  fromLandlord: number
  depositInterest: number
  /**
   * Paid-ahead money on the account that is the tenant's to use: what is left
   * on their paid-ahead credits, less anything a dispute or bank return of the
   * credit's own funding still claims (creditUse.householdQuote withholds it),
   * not counting money a scheduled retry is holding against a bill. The
   * tenant page's "Paid ahead" figure.
   */
  paidAheadRemaining: number
}

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number) => Math.round(c) / 100

function emptyCredit(): CreditBeside {
  return {
    usable: 0, usableByLease: new Map(), sharedUsableByLease: new Map(), ownUsableByLease: new Map(),
    sharedOnFileByLease: new Map(), ownOnFile: 0,
    onFile: 0, paidAhead: 0, fromLandlord: 0, depositInterest: 0, paidAheadRemaining: 0,
  }
}

/** Fold one household quote into a running summary (only the given leases, when a scope is set). */
function addQuote(into: CreditBeside, q: HouseholdQuote, leaseScope: Set<string> | null): void {
  const bump = (m: Map<string, number>, k: string, amt: number) => m.set(k, dollars(cents(m.get(k)) + amt))
  const creditLease = new Map(q.credits.map(c => [c.id, c.leaseId] as const))
  for (const line of planCredit(q)) {
    if (leaseScope && !leaseScope.has(line.leaseId)) continue
    bump(into.usableByLease, line.leaseId, cents(line.amount))
    into.usable = dollars(cents(into.usable) + cents(line.amount))
    // A lease-tied credit pays only its own lease's bills (line.leaseId is that lease).
    if (creditLease.get(line.creditId) === null) bump(into.ownUsableByLease, line.leaseId, cents(line.amount))
    else bump(into.sharedUsableByLease, creditLease.get(line.creditId) ?? line.leaseId, cents(line.amount))
  }
  for (const c of q.credits) {
    // A credit tied to a lease outside the viewer's scope is not theirs to see.
    if (leaseScope && c.leaseId !== null && !leaseScope.has(c.leaseId)) continue
    const amt = cents(c.amountRemaining) + cents(c.releasable)
    into.onFile = dollars(cents(into.onFile) + amt)
    if (c.leaseId === null) into.ownOnFile = dollars(cents(into.ownOnFile) + amt)
    else bump(into.sharedOnFileByLease, c.leaseId, amt)
    if (c.kind === 'paid_ahead') {
      into.paidAhead = dollars(cents(into.paidAhead) + amt)
      into.paidAheadRemaining = dollars(cents(into.paidAheadRemaining) + cents(c.amountRemaining))
    }
    else if (c.kind === 'deposit_interest') into.depositInterest = dollars(cents(into.depositInterest) + amt)
    else into.fromLandlord = dollars(cents(into.fromLandlord) + amt)
  }
}

/**
 * The credit beside one person's balance with these companies: what it would
 * pay now and what is on file. Read-only. `leaseIds` limits it to the leases a
 * property-scoped viewer may see (null: every lease).
 */
export async function creditBeside(opts: {
  tenantId: string
  landlordIds: readonly string[]
  leaseIds?: readonly string[] | null
  client?: PoolClient
}): Promise<CreditBeside> {
  const out = emptyCredit()
  if (!opts.landlordIds.length) return out
  const scope = opts.leaseIds ? new Set(opts.leaseIds) : null
  const client = opts.client ?? await getClient()
  try {
    for (const landlordId of [...new Set(opts.landlordIds)].sort()) {
      addQuote(out, await householdQuote(client, { tenantId: opts.tenantId, landlordId }), scope)
    }
  } finally {
    if (!opts.client) client.release()
  }
  return out
}

/**
 * Of these (tenant, company) pairs, the ones with any credit to speak of: a
 * credit with money left on it, or one a scheduled retry is holding. Lets a list
 * run the full household quote only where it can say something (most people
 * have no credit at all).
 */
export async function pairsWithCredit(tenantIds: readonly string[], landlordIds: readonly string[]): Promise<Set<string>> {
  if (!tenantIds.length || !landlordIds.length) return new Set()
  const rows = await query<{ tenant_id: string; landlord_id: string }>(
    `WITH live_tc AS (
       SELECT tc.tenant_id, tc.landlord_id, tc.lease_id FROM tenant_credits tc
        WHERE tc.status = 'active' AND tc.landlord_id = ANY($2::uuid[])
          AND (tc.amount_remaining > 0
               OR EXISTS (SELECT 1 FROM credit_uses u WHERE u.tenant_credit_id = tc.id AND u.status = 'held'))),
     live_pc AS (
       SELECT c.tenant_id, l.landlord_id, c.lease_id FROM lease_prepaid_credits c
         JOIN leases l ON l.id = c.lease_id
        WHERE c.voided_at IS NULL AND l.landlord_id = ANY($2::uuid[])
          AND (c.amount_remaining > 0
               OR EXISTS (SELECT 1 FROM credit_uses u WHERE u.prepaid_credit_id = c.id AND u.status = 'held'))),
     live AS (SELECT * FROM live_tc UNION ALL SELECT * FROM live_pc)
     SELECT DISTINCT x.tenant_id, x.landlord_id FROM (
       SELECT tenant_id, landlord_id FROM live
       UNION ALL
       -- a credit on a lease belongs to everyone on it
       SELECT lt.tenant_id, live.landlord_id FROM live JOIN lease_tenants lt ON lt.lease_id = live.lease_id
     ) x
     WHERE x.tenant_id = ANY($1::uuid[])`,
    [[...new Set(tenantIds)], [...new Set(landlordIds)]])
  return new Set(rows.map(r => `${r.tenant_id}|${r.landlord_id}`))
}

// ─── The Outstanding list ─────────────────────────────────────────────────────
//
// decisions #29 (Nic, 10/3): "Outstanding Balances = the who-owes-what list
// across ALL months. A household stays on it, with every unpaid month shown
// ('$X from August'), until it is paid ... A bank payment still clearing shows
// 'Payment clearing' on the row, not owed and not late; if it bounces the
// amount is owed again. Work trade: charges covered by work trade are never
// owed and never shown as an amount — the household shows 'Work trade' for
// them and is never late; anything they owe beyond the coverage shows
// normally." And Record payment opens from the row, already filled with that
// household and what it owes (record_with: the charge the desk window opens on).

/** One month of a balance: what is still owed on the bills due that month. */
export interface OpenMonth {
  /** YYYY-MM: the month the bill was due (its invoice's due date; a charge on no bill, its own). */
  month: string
  amount: number
}

/**
 * Why a household is on the list: it owes money, or a bank payment of theirs is
 * clearing and they owe nothing else (decisions #29). Labels are the words the
 * screen shows.
 */
export const OUTSTANDING_ROW_STATUSES = ['owes', 'clearing'] as const
export type OutstandingRowStatus = typeof OUTSTANDING_ROW_STATUSES[number]
export const OUTSTANDING_ROW_STATUS_LABEL: Record<OutstandingRowStatus, string> = {
  owes: 'Owes',
  clearing: 'Payment clearing',
}
/** How a household's work-trade charges are shown: these words, never an amount. */
export const WORK_TRADE_MARKER_LABEL = 'Work trade'

export interface OpenSpace {
  /** The company the space's charges are with. */
  landlord_id: string
  lease_id: string | null
  unit_number: string | null
  property_id: string | null
  property_name: string | null
  /** The full balance of this space (no credit taken off). */
  balance: number
  /** What their credit would pay of this space's bills now. */
  credit_available: number
  /** Open bills: each invoice, and each charge that is on no invoice. */
  open_invoices: number
  open_charges: number
  oldest_due_date: string
  /** What is owed here, by the month each bill was due, oldest first. */
  months: OpenMonth[]
  /** 0 when every bill here is inside its grace period; else days since the oldest late bill was due. */
  days_late: number
  /** A card or bank payment made and still clearing: already paid, never owed, never late. */
  clearing: number
}

/** Where Record payment opens for a household: the oldest open charge the desk may take, per company. */
export interface RecordAnchor { landlord_id: string; payment_id: string }

export interface OpenTenantBalance {
  tenant_id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  email: string | null
  unit_number: string | null
  property_id: string | null
  property_ids: string[]
  property_name: string | null
  /** The full balance, every space. Credit is beside it, never taken off it. */
  balance: string
  /** What their credit would pay of these bills now ("credit available $X"). */
  credit_available: number
  /**
   * Credit on file shown on this line: their own general credit, plus credit
   * tied to a lease when this is the line that lease's credit is shown on (a
   * shared lease's credit is on one line of the list, never on two).
   */
  credit_on_account: number
  open_invoices: number
  open_charges: number
  /** The oldest bill still owed (for a household whose payment is clearing: the oldest bill it is paying). */
  oldest_due_date: string
  /** Every unpaid month ("$X from August"), oldest first. */
  months: OpenMonth[]
  /** 0 = not late. Work-trade charges and money clearing never make a household late. */
  days_late: number
  /** Money clearing (beside the balance, never in it). */
  clearing: number
  /** Work trade covers some of their charges (shown as "Work trade", never an amount). Only for viewers who may see work trade. */
  work_trade: boolean
  status: OutstandingRowStatus
  status_label: string
  /** The charge Record payment opens on, one per company they owe (empty: nothing the desk can take — e.g. only GAM's own charges, or the space is paused for an eviction). */
  record_with: RecordAnchor[]
  spaces: OpenSpace[]
  /**
   * decisions #48.8: this line carries its household's credit — everyone on a
   * shared lease together, shown once ("household credit"). False on a
   * one-person household's line (its credit is simply theirs).
   */
  household_credit?: boolean
  /** decisions #48.8: on another line of the same household, the tenant_id of the line that carries the household's credit; null otherwise. */
  household_credit_on?: string | null
}

export interface OpenBalanceFilter {
  /** The account's companies. Required — there is no default company. */
  landlordIds: string[]
  /** A property-locked worker's scope; null = every property. */
  propertyIds?: string[] | null
  /** Only charges on bills due this many days ago or earlier (GAM's Phoenix calendar). */
  overdueDays?: number | null
  /** Leave out units in eviction mode — no one should be chased for those. */
  excludePaymentBlocked?: boolean
  /** Only these people. */
  tenantIds?: string[] | null
  /**
   * decisions #29: also list a household whose only money is a payment still
   * clearing ("Payment clearing"). Off for the overdue digest and the agents,
   * which ask who OWES.
   */
  includeClearing?: boolean
  /**
   * Mark households work trade covers charges for (work_trade: true). Off
   * unless the viewer may see work trade (S641: payments.view_all / books.view).
   */
  includeWorkTrade?: boolean
}

interface OwedGroup {
  tenant_id: string
  first_name: string | null; last_name: string | null; phone: string | null; email: string | null
  landlord_id: string
  lease_id: string | null
  unit_number: string | null
  property_id: string | null
  property_name: string | null
  month: string
  open_amount: string
  open_invoices: number
  open_charges: number
  oldest_due_date: string
  days_late: number
}

interface ClearingGroup {
  tenant_id: string
  first_name: string | null; last_name: string | null; phone: string | null; email: string | null
  landlord_id: string
  lease_id: string | null
  unit_number: string | null
  property_id: string | null
  property_name: string | null
  clearing: string
  oldest_due_date: string
}

/** The joins every Outstanding read shares: the charge's bill, its person, its space and its lease. */
const OUTSTANDING_FROM = `
      FROM payments p
      LEFT JOIN invoices inv  ON inv.id = p.invoice_id
      JOIN tenants t          ON t.id  = COALESCE(p.tenant_id, inv.tenant_id)
      LEFT JOIN users tu      ON tu.id = t.user_id
      LEFT JOIN units u       ON u.id  = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN leases l      ON l.id  = p.lease_id`

const SPACE_GROUP = `t.id, tu.first_name, tu.last_name, tu.phone, tu.email,
               p.landlord_id, p.lease_id, u.unit_number, pr.id, pr.name`
const SPACE_SELECT = `t.id AS tenant_id, tu.first_name, tu.last_name, tu.phone, tu.email,
        p.landlord_id, p.lease_id, u.unit_number, pr.id AS property_id, pr.name AS property_name`

/** The due date a charge counts by: its bill's, or its own when it is on no bill. */
const BILL_DUE = `COALESCE(inv.due_date, p.due_date)`

/**
 * One line per person (S648: "every dollar counted once"), each space they owe
 * on broken out, each unpaid month shown. A charge counts on the day its bill
 * was due (the invoice's due date; a charge on no invoice, its own).
 */
export async function listOpenTenantBalances(opts: OpenBalanceFilter): Promise<OpenTenantBalance[]> {
  const { landlordIds } = opts
  if (!landlordIds.length) return []
  const propertyIds = opts.propertyIds ?? null

  // The person / space filters every read shares ($1 companies, $2 properties).
  const shared = (params: unknown[]): string => {
    let f = ''
    if (opts.excludePaymentBlocked === true) f += `\n        AND u.payment_block IS NOT TRUE`
    if (opts.tenantIds) {
      params.push(opts.tenantIds)
      f += `\n        AND COALESCE(p.tenant_id, inv.tenant_id) = ANY($${params.length}::uuid[])`
    }
    return f
  }

  const owedParams: unknown[] = [landlordIds, propertyIds]
  let owedFilters = shared(owedParams)
  if (opts.overdueDays != null) {
    // A plain calendar date, so it never depends on the host clock.
    owedParams.push(addDaysTo(todayIn(null), -opts.overdueDays))
    owedFilters += `\n        AND ${BILL_DUE} <= $${owedParams.length}::date`
  }
  const lateSql = daysLateSql(propertyDaySql('NOW()', 'pr'), BILL_DUE, graceDaysSql('l', 'pr'))

  // What is owed, per space and per month; a person is one line below.
  const owed = await query<OwedGroup>(`
      SELECT
        ${SPACE_SELECT},
        to_char(${BILL_DUE}, 'YYYY-MM')               AS month,
        SUM(${openAmountSql('p')})::text              AS open_amount,
        (COUNT(DISTINCT p.invoice_id) + COUNT(*) FILTER (WHERE p.invoice_id IS NULL))::int AS open_invoices,
        COUNT(*)::int                                 AS open_charges,
        to_char(MIN(${BILL_DUE}), 'YYYY-MM-DD')       AS oldest_due_date,
        MAX(${lateSql})::int                          AS days_late
      ${OUTSTANDING_FROM}
      WHERE p.landlord_id = ANY($1::uuid[])
        AND ${openBalanceSql('p')}
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))${owedFilters}
      GROUP BY ${SPACE_GROUP}, to_char(${BILL_DUE}, 'YYYY-MM')
      HAVING SUM(${openAmountSql('p')}) > 0
    `, owedParams)

  // Money clearing: already paid, not owed, not late.
  let clearing: ClearingGroup[] = []
  if (opts.includeClearing) {
    const clearingParams: unknown[] = [landlordIds, propertyIds]
    const clearingFilters = shared(clearingParams)
    clearing = await query<ClearingGroup>(`
      SELECT
        ${SPACE_SELECT},
        SUM(${inFlightMoneySql('p')})::text           AS clearing,
        to_char(MIN(${BILL_DUE}), 'YYYY-MM-DD')       AS oldest_due_date
      ${OUTSTANDING_FROM}
      WHERE p.landlord_id = ANY($1::uuid[])
        AND ${inFlightRowSql('p')}
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))${clearingFilters}
      GROUP BY ${SPACE_GROUP}
      HAVING SUM(${inFlightMoneySql('p')}) > 0
    `, clearingParams)
  }

  // Work trade covers some of their charges: a mark, never an amount.
  const workTrade = new Set<string>()
  if (opts.includeWorkTrade) {
    const wtParams: unknown[] = [landlordIds, propertyIds]
    const wtFilters = shared(wtParams)
    for (const r of await query<{ tenant_id: string }>(`
      SELECT DISTINCT t.id AS tenant_id
      ${OUTSTANDING_FROM}
      WHERE p.landlord_id = ANY($1::uuid[])
        AND ${workTradeOpenRowSql('p')}
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))${wtFilters}`, wtParams)) {
      workTrade.add(r.tenant_id)
    }
  }

  // ── Assemble: spaces, then one line per person ──
  const spaceKey = (r: { landlord_id: string; lease_id: string | null; unit_number: string | null; property_id: string | null }) =>
    `${r.landlord_id}|${r.lease_id ?? ''}|${r.unit_number ?? ''}|${r.property_id ?? ''}`
  interface Building { space: OpenSpace; months: Map<string, number> }
  const byTenant = new Map<string, { contact: OwedGroup | ClearingGroup; spaces: Map<string, Building> }>()
  const slot = (r: OwedGroup | ClearingGroup): Building => {
    const t = byTenant.get(r.tenant_id) ?? { contact: r, spaces: new Map<string, Building>() }
    byTenant.set(r.tenant_id, t)
    const k = spaceKey(r)
    let b = t.spaces.get(k)
    if (!b) {
      b = {
        space: {
          landlord_id: r.landlord_id, lease_id: r.lease_id, unit_number: r.unit_number,
          property_id: r.property_id, property_name: r.property_name,
          balance: 0, credit_available: 0, open_invoices: 0, open_charges: 0,
          oldest_due_date: r.oldest_due_date, months: [], days_late: 0, clearing: 0,
        },
        months: new Map(),
      }
      t.spaces.set(k, b)
    }
    return b
  }
  for (const g of owed) {
    const b = slot(g)
    const s = b.space
    // The oldest due date of what is OWED (a clearing payment never sets it when anything is owed).
    s.oldest_due_date = s.balance > 0 ? (g.oldest_due_date < s.oldest_due_date ? g.oldest_due_date : s.oldest_due_date) : g.oldest_due_date
    s.balance = dollars(cents(s.balance) + cents(g.open_amount))
    s.open_invoices += g.open_invoices
    s.open_charges += g.open_charges
    s.days_late = Math.max(s.days_late, Number(g.days_late) || 0)
    b.months.set(g.month, (b.months.get(g.month) ?? 0) + cents(g.open_amount))
  }
  for (const g of clearing) {
    const b = slot(g)
    const s = b.space
    if (s.balance === 0 && g.oldest_due_date < s.oldest_due_date) s.oldest_due_date = g.oldest_due_date
    s.clearing = dollars(cents(s.clearing) + cents(g.clearing))
  }

  const tenantIds = [...byTenant.keys()]

  // Record payment: the oldest charge of theirs the desk may take, per company
  // (the desk window settles the household's whole bill from it).
  const anchors = new Map<string, RecordAnchor[]>()
  const owing = tenantIds.filter(id => [...byTenant.get(id)!.spaces.values()].some(b => b.space.balance > 0))
  if (owing.length) {
    const rows = await query<{ tenant_id: string; landlord_id: string; payment_id: string }>(`
      SELECT DISTINCT ON (p.tenant_id, p.landlord_id) p.tenant_id, p.landlord_id, p.id AS payment_id
        FROM payments p
        LEFT JOIN units u ON u.id = p.unit_id
       WHERE p.landlord_id = ANY($1::uuid[])
         AND p.tenant_id = ANY($2::uuid[])
         AND ${openBalanceSql('p')}
         AND ${bankPayableRowSql('p')}
         AND u.payment_block IS NOT TRUE
         AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
       ORDER BY p.tenant_id, p.landlord_id, ${allocationOrderSql('p')}`,
      [landlordIds, owing, propertyIds])
    for (const r of rows) {
      anchors.set(r.tenant_id, [...(anchors.get(r.tenant_id) ?? []), { landlord_id: r.landlord_id, payment_id: r.payment_id }])
    }
  }

  // Credit beside the balance: only where there is any to speak of.
  const withCredit = await pairsWithCredit(tenantIds, landlordIds)
  const credit = new Map<string, CreditBeside>()
  if (withCredit.size) {
    const client = await getClient()
    try {
      for (const tenantId of tenantIds) {
        const lls = landlordIds.filter(l => withCredit.has(`${tenantId}|${l}`))
        if (!lls.length) continue
        // A property-scoped worker sees only the credit on the spaces they see.
        const leaseScope = propertyIds
          ? [...byTenant.get(tenantId)!.spaces.values()].map(b => b.space.lease_id).filter((x): x is string => !!x)
          : null
        credit.set(tenantId, await creditBeside({ tenantId, landlordIds: lls, leaseIds: leaseScope, client }))
      }
    } finally {
      client.release()
    }
  }

  // Each person's spaces, oldest bill first; only people who will be a line.
  const listed: Array<{ tenantId: string; built: Building[]; balanceCents: number; clearingCents: number }> = []
  for (const tenantId of tenantIds) {
    const built = [...byTenant.get(tenantId)!.spaces.values()]
      .filter(b => b.space.balance > 0 || b.space.clearing > 0)
      .sort((a, b) => String(a.space.oldest_due_date).localeCompare(String(b.space.oldest_due_date)))
    const balanceCents = built.reduce((s, x) => s + cents(x.space.balance), 0)
    const clearingCents = built.reduce((s, x) => s + cents(x.space.clearing), 0)
    if (balanceCents <= 0 && !(opts.includeClearing && clearingCents > 0)) continue
    listed.push({ tenantId, built, balanceCents, clearingCents })
  }

  // A lease's usable credit sits beside ONE space on the whole list (S648:
  // every dollar counted once). A lease whose charges carry two spaces (a move
  // mid-lease) is two spaces with one lease; a shared lease whose charges are
  // billed to two of its people (rent to the primary, a fee to a co-tenant) is
  // two lines with one lease — either way its credit is shown once. Only credit
  // TIED TO the lease is placed this way (everyone on the lease sees the same
  // money); it goes beside the person whose quote has it paying the most, then
  // the space owing the oldest bill, then a fixed order. A person's own general
  // credit sits beside their own line (below) — and then a household of
  // several lines gathers all of it onto one line as household credit
  // (showCreditOncePerHousehold, decisions #48.8).
  const creditSpot = new Map<string, { tenantId: string; spaceIdx: number; amount: number; owes: boolean; due: string }>()
  for (const { tenantId, built } of listed) {
    const c = credit.get(tenantId)
    if (!c) continue
    built.forEach((b, spaceIdx) => {
      const leaseId = b.space.lease_id
      if (!leaseId) return
      const cand = {
        tenantId, spaceIdx, amount: c.sharedUsableByLease.get(leaseId) ?? 0,
        owes: b.space.balance > 0, due: String(b.space.oldest_due_date),
      }
      const cur = creditSpot.get(leaseId)
      const better = !cur
        || cents(cand.amount) > cents(cur.amount)
        || (cents(cand.amount) === cents(cur.amount) && (
          (cand.owes && !cur.owes)
          || (cand.owes === cur.owes && (cand.due < cur.due
            || (cand.due === cur.due && (cand.tenantId < cur.tenantId
              || (cand.tenantId === cur.tenantId && cand.spaceIdx < cur.spaceIdx)))))))
      if (better) creditSpot.set(leaseId, cand)
    })
  }

  // Lease-tied credit ON FILE is counted on one line too: the line its usable
  // credit sits on, else (nothing on the list it can pay) the first person, in
  // a fixed order, whose quote has it. So a line never reads "$X on file" for
  // money shown on someone else's line.
  const onFileHome = new Map<string, string>()
  for (const [leaseId, spot] of creditSpot) {
    if (credit.get(spot.tenantId)?.sharedOnFileByLease.has(leaseId)) onFileHome.set(leaseId, spot.tenantId)
  }
  for (const { tenantId } of [...listed].sort((a, z) => a.tenantId.localeCompare(z.tenantId))) {
    for (const leaseId of credit.get(tenantId)?.sharedOnFileByLease.keys() ?? []) {
      if (!onFileHome.has(leaseId)) onFileHome.set(leaseId, tenantId)
    }
  }

  const out: OpenTenantBalance[] = []
  for (const { tenantId, built, balanceCents, clearingCents } of listed) {
    const t = byTenant.get(tenantId)!
    const c = credit.get(tenantId) ?? emptyCredit()
    // Their own general credit, beside the first of their spaces on the lease
    // of the bill it would pay; a bill on a lease with no space of theirs here
    // (a co-tenant's charge it would pay) lands on their first space.
    const ownBySpace = new Map<number, number>()
    for (const [leaseId, amt] of c.ownUsableByLease) {
      const idx = Math.max(0, built.findIndex(b => b.space.lease_id === leaseId))
      if (built.length) ownBySpace.set(idx, (ownBySpace.get(idx) ?? 0) + cents(amt))
    }
    const sharedOnFileHere = [...c.sharedOnFileByLease]
      .filter(([leaseId]) => onFileHome.get(leaseId) === tenantId)
      .reduce((sum, [, amt]) => sum + cents(amt), 0)
    const mine = built.map((b, spaceIdx) => {
      const leaseId = b.space.lease_id
      const spot = leaseId ? creditSpot.get(leaseId) : undefined
      const here = !!spot && spot.tenantId === tenantId && spot.spaceIdx === spaceIdx
      return {
        ...b.space,
        credit_available: dollars((here ? cents(spot!.amount) : 0) + (ownBySpace.get(spaceIdx) ?? 0)),
        months: [...b.months.entries()].sort(([a], [z]) => a.localeCompare(z))
          .map(([month, amt]) => ({ month, amount: dollars(amt) })),
      }
    })
    const owingSpaces = mine.filter(x => x.balance > 0)
    const months = new Map<string, number>()
    for (const s of owingSpaces) for (const m of s.months) months.set(m.month, (months.get(m.month) ?? 0) + cents(m.amount))
    const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))]
    const status: OutstandingRowStatus = balanceCents > 0 ? 'owes' : 'clearing'
    const oldest = (owingSpaces.length ? owingSpaces : mine)
      .map(x => x.oldest_due_date).sort()[0]
    out.push({
      tenant_id: tenantId,
      first_name: t.contact.first_name, last_name: t.contact.last_name,
      phone: t.contact.phone, email: t.contact.email,
      // Joined for the screens that print one line ("RV 34, RV 35").
      unit_number: uniq(mine.map(r => r.unit_number)).join(', ') || null,
      property_id: mine[0].property_id,
      property_ids: uniq(mine.map(r => r.property_id)),
      property_name: uniq(mine.map(r => r.property_name)).join(', ') || null,
      balance: (balanceCents / 100).toFixed(2),
      credit_available: dollars(mine.reduce((s, x) => s + cents(x.credit_available), 0)),
      credit_on_account: dollars(cents(c.ownOnFile) + sharedOnFileHere),
      open_invoices: mine.reduce((s, r) => s + r.open_invoices, 0),
      open_charges: mine.reduce((s, r) => s + r.open_charges, 0),
      oldest_due_date: oldest,
      months: [...months.entries()].sort(([a], [z]) => a.localeCompare(z))
        .map(([month, amt]) => ({ month, amount: dollars(amt) })),
      days_late: Math.max(0, ...owingSpaces.map(x => x.days_late)),
      clearing: dollars(clearingCents),
      work_trade: workTrade.has(tenantId),
      status,
      status_label: OUTSTANDING_ROW_STATUS_LABEL[status],
      record_with: balanceCents > 0 ? (anchors.get(tenantId) ?? []) : [],
      spaces: mine,
      household_credit: false,
      household_credit_on: null,
    })
  }
  return showCreditOncePerHousehold(out)
}

/**
 * decisions #48.8: co-tenants' credit shows ONCE per household, as household
 * credit (one household = one balance). Each person's figure comes from their
 * own quote (the lease's credit plus their own general credit), so two
 * co-tenants who each hold general credit used to show, together, more than
 * the household owes — $100 paid ahead on the lease plus Pat's $50 and Cory's
 * $50 against $140 owed read 140 and 40, $180 "available". Now the household's
 * lines (people joined through the leases on their lines) put it all on ONE
 * line: credit available = everyone's, capped at what the household owes;
 * credit on the account = everyone's, each dollar once. The line chosen is the
 * one already carrying the most credit (the lease's shared credit sits there),
 * then the one owing, the oldest bill, a fixed order. Its other lines read $0
 * and name that line (household_credit_on). A one-line household is left as
 * it is. Display only: what any one person's payment can use is their own
 * quote's business (the desk window, the portal).
 */
export function showCreditOncePerHousehold<T extends OpenTenantBalance>(rows: T[]): T[] {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(k, r)
    return r
  }
  const node = (k: string) => { if (!parent.has(k)) parent.set(k, k); return k }
  const join = (a: string, b: string) => {
    const ra = find(node(a)), rb = find(node(b))
    if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra)
  }
  for (const r of rows) {
    node(`t:${r.tenant_id}`)
    for (const s of r.spaces) if (s.lease_id) join(`t:${r.tenant_id}`, `l:${s.lease_id}`)
  }
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const k = find(`t:${r.tenant_id}`)
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  for (const lines of groups.values()) {
    if (lines.length < 2) continue
    const availCents = Math.min(
      lines.reduce((s, r) => s + cents(r.balance), 0),
      lines.reduce((s, r) => s + cents(r.credit_available), 0))
    const fileCents = lines.reduce((s, r) => s + cents(r.credit_on_account), 0)
    if (availCents <= 0 && fileCents <= 0) continue
    const home = [...lines].sort((a, z) =>
      cents(z.credit_available) - cents(a.credit_available)
      || Number(cents(z.balance) > 0) - Number(cents(a.balance) > 0)
      || String(a.oldest_due_date).localeCompare(String(z.oldest_due_date))
      || a.tenant_id.localeCompare(z.tenant_id))[0]
    // The home line's spaces carry the whole figure: its own space amounts,
    // then the others' — first onto its spaces up to what each still owes
    // (so a space reads no more credit than its bills while one has room),
    // any rest on its first owing space — trimmed from the last space back so
    // the spaces add up to the line.
    const spaceCents = home.spaces.map(sp => cents(sp.credit_available))
    let moved = lines.filter(r => r !== home).reduce((s, r) => s + cents(r.credit_available), 0)
    home.spaces.forEach((sp, i) => {
      const room = Math.max(0, cents(sp.balance) - spaceCents[i])
      const put = Math.min(room, moved)
      spaceCents[i] += put
      moved -= put
    })
    const firstOwing = Math.max(0, home.spaces.findIndex(sp => sp.balance > 0))
    if (spaceCents.length) spaceCents[firstOwing] += moved
    let over = spaceCents.reduce((s, c) => s + c, 0) - availCents
    for (let i = spaceCents.length - 1; i >= 0 && over > 0; i--) {
      const cut = Math.min(over, spaceCents[i])
      spaceCents[i] -= cut
      over -= cut
    }
    home.spaces.forEach((sp, i) => { sp.credit_available = dollars(spaceCents[i]) })
    home.credit_available = dollars(availCents)
    home.credit_on_account = dollars(fileCents)
    home.household_credit = true
    home.household_credit_on = null
    for (const r of lines) {
      if (r === home) continue
      r.credit_available = 0
      r.credit_on_account = 0
      for (const sp of r.spaces) sp.credit_available = 0
      r.household_credit = false
      r.household_credit_on = home.tenant_id
    }
  }
  return rows
}

/**
 * decisions #25: the sums across people the Outstanding list may carry — only
 * ever sent to a viewer seesGrandTotals() admits.
 */
export interface OutstandingTotals {
  /** Everyone's balance together (residents, open pay links, open register tickets). */
  owed: number
  /** Households that owe something: each person once, and the people on one lease once together (a register ticket naming a resident on the list is not a second household). */
  households: number
  /** Money clearing across everyone. */
  clearing: number
  /** The same, per property (a person at two properties counts at each for what they owe there). */
  by_property: Array<{ property_id: string | null; property_name: string | null; owed: number; clearing: number }>
}

/** Sum the list. Rows from listOpenTenantBalances, plus pay links and tickets shaped like them. */
export function outstandingTotals(rows: Array<{
  tenant_id?: string | null; balance: string | number; clearing?: number
  property_id?: string | null; property_name?: string | null
  spaces?: Array<{ lease_id?: string | null; property_id: string | null; property_name: string | null; balance: number; clearing: number }>
}>): OutstandingTotals {
  const byProp = new Map<string, { property_id: string | null; property_name: string | null; owed: number; clearing: number }>()
  const add = (pid: string | null | undefined, name: string | null | undefined, owedC: number, clearC: number) => {
    const k = pid ?? ''
    const e = byProp.get(k) ?? { property_id: pid ?? null, property_name: name ?? null, owed: 0, clearing: 0 }
    e.owed += owedC
    e.clearing += clearC
    byProp.set(k, e)
  }
  let owedC = 0, clearC = 0
  // One household is everyone on one lease (S652: one household balance): a
  // shared lease whose charges are billed to two of its people is two lines
  // but one household. People are joined through the leases they owe on.
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(k, r)
    return r
  }
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra) }
  for (const r of rows) {
    const b = cents(r.balance)
    owedC += b
    clearC += cents(r.clearing ?? 0)
    if (r.tenant_id && b > 0) {
      const who = `t:${r.tenant_id}`
      if (!parent.has(who)) parent.set(who, who)
      for (const s of r.spaces ?? []) {
        if (!s.lease_id || !(cents(s.balance) > 0)) continue
        const lease = `l:${s.lease_id}`
        if (!parent.has(lease)) parent.set(lease, lease)
        join(who, lease)
      }
    }
    if (r.spaces?.length) for (const s of r.spaces) add(s.property_id, s.property_name, cents(s.balance), cents(s.clearing))
    else add(r.property_id, r.property_name, b, cents(r.clearing ?? 0))
  }
  const households = new Set([...parent.keys()].filter(k => k.startsWith('t:')).map(find))
  return {
    owed: dollars(owedC),
    households: households.size,
    clearing: dollars(clearC),
    by_property: [...byProp.values()]
      .map(e => ({ ...e, owed: dollars(e.owed), clearing: dollars(e.clearing) }))
      .sort((a, b) => String(a.property_name ?? '').localeCompare(String(b.property_name ?? ''))),
  }
}

/**
 * The companies a tenant has money with: a lease they are on, a charge billed
 * to them, or a credit of theirs. The tenant agents read the person's whole
 * account (a resident's own balance spans every landlord they rent from).
 */
export async function tenantCompanies(tenantId: string): Promise<string[]> {
  const rows = await query<{ landlord_id: string }>(
    `SELECT l.landlord_id FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
      WHERE lt.tenant_id = $1 AND lt.status IN ('active','pending_add','pending_remove')
     UNION
     SELECT p.landlord_id FROM payments p WHERE p.tenant_id = $1 AND ${openBalanceSql('p')}
     UNION
     SELECT tc.landlord_id FROM tenant_credits tc WHERE tc.tenant_id = $1 AND tc.status = 'active'
     UNION
     SELECT l.landlord_id FROM lease_prepaid_credits c JOIN leases l ON l.id = c.lease_id
      WHERE c.tenant_id = $1 AND c.voided_at IS NULL`,
    [tenantId])
  return rows.map(r => r.landlord_id).filter(Boolean).sort()
}
