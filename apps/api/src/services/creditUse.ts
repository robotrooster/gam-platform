// S655 money plan §1.6 (Step 2): THE one credit service every money path calls.
//
// Three kinds of credit sit on a tenant's account, and before this each path
// spent them its own way:
//   - credit the landlord ISSUED (a move-in special, goodwill, a refunded late
//     fee, an overcharge) — tenant_credits;
//   - statutory DEPOSIT INTEREST, which GAM funds — tenant_credits with
//     category deposit_interest;
//   - money the tenant PAID AHEAD — lease_prepaid_credits, held by the landlord
//     (cash, check, money order, a bank deposit), by GAM (it came through
//     Stripe), or rent already paid on a stay that was shortened.
// The desk netted credit off the bill, the portal netted it differently, the
// bill run spent it a third way, and the landlord's payout read none of them,
// so a check the landlord already had was paid out to them a second time.
//
// Now every spend is one row in credit_uses, written here and nowhere else,
// and the database (trg_credit_uses_apply, M4) keeps the credit balances and
// payments.issued_credit_amount in step with it. Every path asks this service
// the same three questions:
//   1. What does this household owe, and how much credit could pay it?
//      householdQuote (+ planCredit): the full balance, the credit that may pay
//      part of it ("credit available $X"), split oldest bill first.
//   2. Spend it: holdCredit while a card or bank charge clears, applyCredit when
//      the money is already here (desk, credit-only, whole bill).
//   3. Settle a bill credit covers in full: settleFromCredit (the payer chose
//      "Pay with credit"), settleWholeBillIfCovered (automatic — the ONE spend
//      without a click, Nic 10/2: "credit auto-applies only when it covers the
//      WHOLE bill").
//
// THE RULES THIS FILE KEEPS (Nic, 10/2 decisions and standing directives):
//   - Credit applies by itself only when it covers the whole bill. Otherwise
//     the payer chooses "Use all $X" or "Save it for later".
//   - No path splits a charge. Credit may pay PART of a charge (the card pays
//     the rest of the same row); a row is never cut in two.
//   - Order: money paid ahead first (oldest credit first, within the month's
//     draw cap), then credit tied to the lease and deposit interest, then the
//     tenant's general credit. Each pays the oldest eligible bills in the one
//     allocation order (compareForAllocation).
//   - Credit pays only the landlord's own rent, utilities, late fees and fees on
//     the credit's lease: never a GAM fee, a FlexPay pull, a home payment, a
//     deposit or move-out row, a neighbor landlord's utility, a work-trade row
//     or a row reopened after a dispute (creditEligibleRowSql = the trigger),
//     and never rent the lease no longer owes (rent past a shortened stay's
//     end: rentPastStayEndSql).
//   - Every writer holds lockHousehold first (moneyPredicates).
//   - Paid-ahead money is released to the landlord only when GAM holds it
//     (allocation pays out gam_held_part, never landlord-held or issued credit).
//
// Nothing here sends email inside a transaction: settles return afterCommit().

import type { PoolClient } from 'pg'
import {
  compareForAllocation,
  CREDIT_USE_HOLDING_SOURCES,
  TENANT_CREDIT_ALL_CATEGORIES,
  PREPAID_FUNDED_BY,
  LEASE_TENANT_STATUSES,
  PAYMENT_REVERSAL_TYPE_VALUES,
  type CreditKind,
  type CreditUseSource,
  type CreditUseHeldReleaseReason,
  type PrepaidFundedBy,
} from '@gam/shared'
import { getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import {
  payableRowSql, bankPayableRowSql, creditEligibleRowSql, creditEligibleRowForCreditSql, lockHousehold,
} from './moneyPredicates'
import { executeRentAllocation, ALLOCATABLE_PAYMENT_TYPES } from './allocation'
import { afterRowsSettled } from './settleHooks'
import { createAdminNotification } from './adminNotifications'
// Type only (erased): bookingLeaseBilling imports this file, so its hook is
// loaded on use (bankShortenedStaysAfter).
import type { StayShortenedBanked } from './bookingLeaseBilling'

// ─── Money in cents ───────────────────────────────────────────────────────────

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100

// ─── Types ────────────────────────────────────────────────────────────────────

/** What the payer chose on screen. `expected` is the usable credit they were shown. */
export interface CreditChoice { use: boolean; expected: number }

/** One charge row as the quote sees it. Every flag is the shared predicate's answer. */
export interface QuoteRow {
  id: string
  /** The row's own lease (a neighbor landlord's utility carries that landlord's lease). */
  leaseId: string | null
  /** The household lease whose bill this row is on: its own lease, else the lease whose invoice carries it. NULL: a charge with no lease. */
  scopeLeaseId: string | null
  invoiceId: string | null
  landlordId: string
  tenantId: string | null
  type: string
  entryDescription: string
  revenueOwner: string
  status: string
  amount: number
  /** YYYY-MM-DD */
  dueDate: string
  /** ISO time, the comparator's tie-break. */
  createdAt: string
  /** YYYY-MM-01: the invoice's due month, else the row's. Paid-ahead uses count against this month's cap. */
  billingMonth: string
  stripePaymentIntentId: string | null
  nextRetryAt: string | null
  /** pending/failed, nothing moving, money owed now (payableRowSql). */
  payable: boolean
  /** Money in flight on it (processing). Never payable. */
  inFlight: boolean
  /** In the portal/autopay pay-in-full set of its scope lease (requiredRowSql). */
  required: boolean
  /** The desk, a bank deposit or a posted payment may take it (bankPayableRowSql, this landlord only). */
  bankPayable: boolean
  /**
   * Credit may pay it (creditEligibleRowSql, on its own lease). Charges5 fix
   * (decisions #48.7): also true for a bill a dispute reopened that the credit
   * the same dispute gave back may pay (disputeCredits) — then ONLY that
   * credit pays it (buildCreditPlan), up to what the dispute gave back.
   */
  creditEligible: boolean
  /**
   * decisions #48.7: on a bill a dispute reopened (reversal_id), the paid-ahead
   * credits that same dispute gave back, each with what of it may still pay
   * this bill (what the dispute gave back of it, less what of it already pays
   * the bill) — the credit_uses_apply trigger's per-credit rule and cap.
   * Empty on every other row.
   */
  disputeCredits?: Array<{ creditId: string; cap: number }>
  /** A carried-forward balance: paid last, optional, may be partial (S622). */
  carried: boolean
  /** GAM's own charge: paid online, never by credit, never at the desk. */
  gamOwned: boolean
  /** Another landlord's charge on this household's bill (S616). */
  neighbor: boolean
  /** Failed with a retry scheduled: paying now supersedes the retry. */
  retryScheduled: boolean
  /** Credit a scheduled retry set aside on this row; paying now gives it back first. */
  heldOnRow: number
  /** Credit already spent on this row (applied); money owes only the rest. */
  appliedOnRow: number
  /**
   * Rent due on or after the end of a stay billed on the booking schedule
   * (rentPastStayEndSql): the lease no longer owes it (the lease is law). It is
   * a shortened stay's kept row — one a payment was tried on, so GAM keeps it
   * as a record until it is taken off in a recorded way. Nobody is asked to pay
   * it: it is not required (portal, autopay), not bank-payable (desk, bank
   * deposit), never credit-eligible, and while it is there its lease's bill
   * never settles itself from credit (GAM is told instead).
   */
  pastStayEnd: boolean
}

/** One credit on the household's account. */
export interface QuoteCredit {
  kind: CreditKind
  id: string
  /** NULL: a general credit the landlord gave the tenant (any of their leases with that landlord). */
  leaseId: string | null
  tenantId: string
  amountRemaining: number
  /**
   * Set aside by a scheduled retry on a row still payable in this household;
   * back on the credit if the payer pays that row now. It counts wherever the
   * hold sits — a credit the renewal hand-off moved to the new lease while the
   * old lease's retry still holds part of it included — so the figure is the
   * same before and after paying replaces the retry: the desk window and the
   * desk settle (which replaces every retry it takes) agree, the household's
   * credit on file still shows the moved money, and "Pay all" (the retrying
   * bill first) spends it in one pass. A charge on ONE lease that does not
   * replace the other lease's retry cannot free that part; rentCharge reports
   * it (creditStillHeldElsewhere) instead of spending it.
   */
  releasable: number
  /**
   * Paid-ahead money a dispute or return of its own Stripe funding still
   * claims (disputeClaimOnCredit): already left out of amountRemaining and
   * releasable — never spent, never paid out, not the tenant's.
   */
  disputed: number
  createdAt: string
  /** Paid-ahead only. */
  fundedBy: PrepaidFundedBy | null
  /** GAM holds the money behind it (deposit interest; paid-ahead money that came through Stripe). */
  gamHeld: boolean
  /** Issued credit only: tenant_credits.category. */
  category: string | null
}

/** One planned spend: this much of this credit pays this charge. */
export interface CreditPlanLine {
  creditKind: CreditKind
  creditId: string
  paymentId: string
  leaseId: string
  amount: number
  billingMonth: string
}

export interface ScheduledRetry {
  paymentIntentId: string
  paymentIds: string[]
  nextRetryAt: string
}

export interface LeaseQuote {
  leaseId: string
  /** Every payable or in-flight row on this lease's bill. */
  rows: QuoteRow[]
  /** The pay-in-full set (portal, autopay), in allocation order. */
  requiredIds: string[]
  requiredTotal: number
  /** Required rows credit may pay. */
  creditEligibleTotal: number
  /** Credit already spent on required rows still open (money owes requiredTotal less this). */
  creditAlreadyApplied: number
  /** Required GAM charges ("pay online"). */
  gamTotal: number
  /** Required rows of another landlord (S616). */
  neighborTotal: number
  /** The desk's set on this lease (this landlord's money, carried included). */
  bankPayableTotal: number
  carriedTotal: number
  inFlightTotal: number
  /** Credit that would pay this lease's bill now (Σ plan lines). */
  usableCredit: number
  /** Credit scheduled retries hold on this lease's payable rows. */
  heldReleasable: number
  scheduledRetries: ScheduledRetry[]
  /** leases.prepaid_monthly_draw (S653). NULL: no cap. */
  monthlyCap: number | null
  /** Every required row is credit-eligible and the plan covers each in full. */
  coversWholeBill: boolean
  /**
   * Payable rent rows the lease no longer owes (QuoteRow.pastStayEnd), in
   * allocation order: on the account as a record, outside every total above.
   */
  pastStayEndRentIds: string[]
  pastStayEndRentTotal: number
  /**
   * The whole-bill rule would have settled this lease from credit but for rent
   * past the stay's end on it (the credit covers the rest of the bill, or would
   * cover all of it if that rent counted). The bill waits and GAM is told
   * (settleWholeBillIfCovered).
   */
  heldBackByPastStayEnd: boolean
}

export interface HouseholdQuote {
  tenantId: string
  landlordId: string
  leaseIds: string[]
  leases: LeaseQuote[]
  /** This tenant's charges with this landlord that sit on no lease (counter charges, S648). */
  noLeaseRows: QuoteRow[]
  credits: QuoteCredit[]
  /** Household-wide plan: each credit split oldest bill first. planCredit() reads from it. */
  plan: CreditPlanLine[]
  totals: {
    required: number
    bankPayable: number
    carried: number
    gam: number
    inFlight: number
    usableCredit: number
    /** Every dollar of credit on the account (remaining, plus what paying now would release). */
    creditOnFile: number
    heldReleasable: number
  }
}

export interface HouseholdQuoteOptions {
  tenantId: string
  landlordId: string
  /** Inside a write: lock the rows (FOR UPDATE, id order). The caller holds lockHousehold. */
  lock?: boolean
  /**
   * Count credit a scheduled retry holds as available, the way paying now
   * would see it (the payer's screen; a write that calls
   * supersedeScheduledRetry first). Default true. The whole-bill rule passes
   * false: it never supersedes a retry, so held credit is not its to spend,
   * and a row with a scheduled retry gets no credit set aside (#46 1b).
   */
  includeReleasable?: boolean
}

// ─── The quote ────────────────────────────────────────────────────────────────

/**
 * lease_tenants statuses that make a person part of a lease's household: on
 * it now, being added, or being taken off but not gone yet. A roommate who
 * left ('removed') or a row that never took effect ('void') is not: her quote
 * and her general credit never take the remaining tenant's bills (S655 review;
 * the old creditApplication read v_lease_active_tenants for the same reason).
 */
export const HOUSEHOLD_MEMBER_STATUSES: readonly (typeof LEASE_TENANT_STATUSES)[number][] = ['active', 'pending_add', 'pending_remove']
const MEMBER_STATUS_SQL = HOUSEHOLD_MEMBER_STATUSES.map(s => `'${s}'`).join(',')

/**
 * The household's leases with this landlord: every lease the tenant is a
 * member of (HOUSEHOLD_MEMBER_STATUSES), whole, plus every other lease they
 * have a charge on — a lease they left, or one they were billed on without
 * being on it — for the rows billed to THEM only (tenantOnLease tells the two
 * apart). lockHousehold locks at least this set.
 */
async function householdLeases(client: PoolClient, tenantId: string, landlordId: string): Promise<{ ids: string[]; tenantOnLease: Set<string>; caps: Map<string, number | null> }> {
  const r = await client.query<{ id: string; on_lease: boolean; cap: string | null }>(
    `SELECT l.id,
            EXISTS (SELECT 1 FROM lease_tenants lt WHERE lt.lease_id = l.id AND lt.tenant_id = $1
                       AND lt.status IN (${MEMBER_STATUS_SQL})) AS on_lease,
            l.prepaid_monthly_draw::text AS cap
       FROM leases l
      WHERE l.landlord_id = $2
        AND (EXISTS (SELECT 1 FROM lease_tenants lt WHERE lt.lease_id = l.id AND lt.tenant_id = $1
                        AND lt.status IN (${MEMBER_STATUS_SQL}))
             OR EXISTS (SELECT 1 FROM payments p WHERE p.lease_id = l.id AND p.tenant_id = $1))
      ORDER BY l.id`,
    [tenantId, landlordId])
  return {
    ids: r.rows.map(x => x.id),
    tenantOnLease: new Set(r.rows.filter(x => x.on_lease).map(x => x.id)),
    caps: new Map(r.rows.map(x => [x.id, x.cap == null ? null : Number(x.cap)])),
  }
}

/**
 * Rent the lease no longer owes: a rent row (alias `p`) due on or after the
 * end of its own lease (alias `l`, joined on p.lease_id) when that lease bills
 * on the booking schedule (services/bookingLeaseBilling isBookingScheduleLease:
 * drafted from a reservation, with an end date — the stay's exclusive
 * check-out). A shortened stay deletes such rent when nothing points at it;
 * one a payment was tried on is kept (GAM never erases a record) until it is
 * taken off in a recorded way. The ONE definition: the shortening picks the
 * rows with it, and credit never pays one (S655 review: a guest's banked
 * stay-shortened credit paid December's rent for a month they were not staying).
 */
export function rentPastStayEndSql(p: string, l: string): string {
  return `(${p}.type = 'rent' AND ${l}.lease_source = 'booking_draft' AND ${l}.end_date IS NOT NULL
           AND ${p}.due_date >= ${l}.end_date)`
}

interface RawRow {
  id: string; lease_id: string | null; invoice_id: string | null; landlord_id: string; tenant_id: string | null
  type: string; entry_description: string; revenue_owner: string; status: string; amount: string
  due_date: string; created_at: Date; billing_month: string; stripe_payment_intent_id: string | null
  next_retry_at: Date | null; scope_lease_id: string | null
  payable: boolean; bank_payable: boolean; credit_eligible: boolean; held_on_row: string; applied_on_row: string
  past_stay_end: boolean
  dispute_credits: Array<{ creditId: string; cap: string }> | null
}

/**
 * What one household (a person with one company) owes, and the credit that
 * may pay it. Read-only; pass `lock: true` inside a write (after lockHousehold)
 * to lock the rows it read.
 */
export async function householdQuote(client: PoolClient, opts: HouseholdQuoteOptions): Promise<HouseholdQuote> {
  const { tenantId, landlordId } = opts
  const includeReleasable = opts.includeReleasable !== false
  const hl = await householdLeases(client, tenantId, landlordId)

  // A lease the tenant is a member of: every row on its bill. Any other
  // household lease (one they left, one they were only billed on): only the
  // rows billed to them.
  const rowsRes = await client.query<RawRow>(
    `WITH hi AS (SELECT i.id, i.lease_id FROM invoices i WHERE i.lease_id = ANY($3::uuid[]))
     SELECT p.id, p.lease_id, p.invoice_id, p.landlord_id, p.tenant_id, p.type, p.entry_description,
            p.revenue_owner, p.status, p.amount::text AS amount, p.due_date::text AS due_date, p.created_at,
            to_char(date_trunc('month', COALESCE(inv.due_date, p.due_date)), 'YYYY-MM-DD') AS billing_month,
            p.stripe_payment_intent_id, p.next_retry_at,
            CASE WHEN p.lease_id = ANY($3::uuid[]) THEN p.lease_id
                 ELSE (SELECT hi.lease_id FROM hi WHERE hi.id = p.invoice_id) END AS scope_lease_id,
            ${payableRowSql('p')} AS payable,
            (${bankPayableRowSql('p')} AND p.landlord_id = $2) AS bank_payable,
            ${creditEligibleRowSql('p')} AS credit_eligible,
            (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u
              WHERE u.payment_id = p.id AND u.status = 'held')::text AS held_on_row,
            (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u
              WHERE u.payment_id = p.id AND u.status = 'applied')::text AS applied_on_row,
            COALESCE(${rentPastStayEndSql('p', 'pl')}, false) AS past_stay_end,
            -- decisions #48.7 (charges5 fix): a bill a dispute reopened may be
            -- paid with the paid-ahead credit that same dispute gave back (its
            -- spend on the disputed original, undone), up to what it gave back
            -- of it — exactly credit_uses_apply's rule (creditEligibleRowForCreditSql).
            CASE WHEN p.reversal_id IS NULL THEN NULL ELSE (
              SELECT COALESCE(json_agg(json_build_object(
                       'creditId', dg.cid,
                       'cap', GREATEST(0, dg.gave - COALESCE((SELECT SUM(u2.amount) FROM credit_uses u2
                                                               WHERE u2.payment_id = p.id AND u2.prepaid_credit_id = dg.cid
                                                                 AND u2.status IN ('held','applied')), 0))::text)
                       ORDER BY dg.cid), '[]'::json)
                FROM (SELECT dg_u.prepaid_credit_id AS cid, SUM(dg_u.amount) AS gave
                        FROM payment_reversals dg_r JOIN credit_uses dg_u ON dg_u.payment_id = dg_r.payment_id
                       WHERE dg_r.id = p.reversal_id AND dg_u.status = 'reversed' AND dg_u.prepaid_credit_id IS NOT NULL
                       GROUP BY dg_u.prepaid_credit_id) dg
               WHERE ${creditEligibleRowForCreditSql('p', 'dg.cid')}) END AS dispute_credits
       FROM payments p
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
       LEFT JOIN leases pl ON pl.id = p.lease_id
      WHERE (((p.lease_id = ANY($3::uuid[]) OR p.invoice_id IN (SELECT hi.id FROM hi))
              AND (p.tenant_id = $1
                   OR (CASE WHEN p.lease_id = ANY($3::uuid[]) THEN p.lease_id
                            ELSE (SELECT hi.lease_id FROM hi WHERE hi.id = p.invoice_id) END) = ANY($4::uuid[])))
             OR (p.lease_id IS NULL AND p.tenant_id = $1 AND p.landlord_id = $2))
        AND (${payableRowSql('p')} OR p.status = 'processing')
      ORDER BY p.id
      ${opts.lock ? 'FOR UPDATE OF p' : ''}`,
    [tenantId, landlordId, hl.ids, [...hl.tenantOnLease]])

  // Rent past a stay's end: the trigger would let credit pay it (it is the
  // landlord's rent on its own lease), so the quote is what refuses it. Kept
  // aside for the "would credit have covered it" check below.
  const pastEndEligible = new Set(rowsRes.rows.filter(r => r.past_stay_end && r.credit_eligible).map(r => r.id))
  const rows: QuoteRow[] = rowsRes.rows.map(r => {
    const scope = r.scope_lease_id
    const carried = r.type === 'carried_balance'
    // The trigger also requires the use to be on the row's own lease, and rent
    // the lease no longer owes is never credit's: the same for a reopened bill.
    const ownLease = scope !== null && r.lease_id === scope && !r.past_stay_end
    const disputeCredits = ownLease
      ? (r.dispute_credits ?? []).map(d => ({ creditId: d.creditId, cap: Number(d.cap) })).filter(d => toCents(d.cap) > 0)
      : []
    return {
      id: r.id,
      leaseId: r.lease_id,
      scopeLeaseId: scope,
      invoiceId: r.invoice_id,
      landlordId: r.landlord_id,
      tenantId: r.tenant_id,
      type: r.type,
      entryDescription: r.entry_description,
      revenueOwner: r.revenue_owner,
      status: r.status,
      amount: Number(r.amount),
      dueDate: r.due_date.slice(0, 10),
      createdAt: new Date(r.created_at).toISOString(),
      billingMonth: r.billing_month,
      stripePaymentIntentId: r.stripe_payment_intent_id,
      nextRetryAt: r.next_retry_at ? new Date(r.next_retry_at).toISOString() : null,
      payable: r.payable,
      inFlight: r.status === 'processing',
      // Rent the lease no longer owes is never asked for — not by the portal,
      // autopay, the desk or a bank deposit (the lease is law).
      required: r.payable && scope !== null && !carried && !r.past_stay_end,
      bankPayable: r.bank_payable && !r.past_stay_end,
      // The trigger also requires the use to be on the row's own lease: a
      // neighbor's utility on this household's invoice is never this credit's.
      // Rent the lease no longer owes is never credit's either.
      creditEligible: (r.credit_eligible && ownLease) || disputeCredits.length > 0,
      disputeCredits,
      carried,
      gamOwned: r.revenue_owner === 'gam',
      neighbor: r.landlord_id !== landlordId,
      retryScheduled: r.status === 'failed' && r.next_retry_at !== null,
      heldOnRow: Number(r.held_on_row),
      appliedOnRow: Number(r.applied_on_row),
      pastStayEnd: r.past_stay_end === true,
    }
  })

  const credits = await readCredits(client, { tenantId, landlordId, leaseIds: hl.ids, memberLeaseIds: [...hl.tenantOnLease], includeReleasable })
  const drawn = await paidAheadDrawnByMonth(client, hl.ids, includeReleasable)

  const plan = buildCreditPlan({
    rows, credits, caps: hl.caps, drawn, tenantId, tenantOnLease: hl.tenantOnLease, includeReleasable,
  })
  // Only to tell GAM a bill is waiting on rent the lease no longer owes: the
  // plan as it would be if credit could pay that rent. Never spent.
  const asIfOwed = (r: QuoteRow): QuoteRow =>
    pastEndEligible.has(r.id) && r.scopeLeaseId !== null && r.leaseId === r.scopeLeaseId
      ? { ...r, required: true, creditEligible: true } : r
  const planIfPastEndPayable = pastEndEligible.size === 0 ? plan : buildCreditPlan({
    rows: rows.map(asIfOwed),
    credits, caps: hl.caps, drawn, tenantId, tenantOnLease: hl.tenantOnLease, includeReleasable,
  })
  const covers = (required: QuoteRow[], lines: CreditPlanLine[], eligible: (r: QuoteRow) => boolean): boolean => {
    const covered = new Map<string, number>()
    for (const l of lines) covered.set(l.paymentId, (covered.get(l.paymentId) ?? 0) + toCents(l.amount))
    return required.length > 0
      && required.every(r => eligible(r) && (covered.get(r.id) ?? 0) + toCents(r.appliedOnRow) === toCents(r.amount))
  }

  const leases: LeaseQuote[] = hl.ids.map(leaseId => {
    const lr = rows.filter(r => r.scopeLeaseId === leaseId)
    const required = sortRows(lr.filter(r => r.required))
    const lines = plan.filter(l => l.leaseId === leaseId)
    const pastEnd = sortRows(lr.filter(r => r.pastStayEnd && r.payable))
    const retries = new Map<string, ScheduledRetry>()
    for (const r of lr) {
      if (!r.retryScheduled || !r.stripePaymentIntentId) continue
      const e = retries.get(r.stripePaymentIntentId)
        ?? { paymentIntentId: r.stripePaymentIntentId, paymentIds: [], nextRetryAt: r.nextRetryAt! }
      e.paymentIds.push(r.id)
      if (r.nextRetryAt! < e.nextRetryAt) e.nextRetryAt = r.nextRetryAt!
      retries.set(r.stripePaymentIntentId, e)
    }
    const sum = (xs: QuoteRow[]) => toDollars(xs.reduce((s, r) => s + toCents(r.amount), 0))
    const coversWholeBill = covers(required, lines, r => r.creditEligible)
    // The whole-bill rule would have settled this lease (the rest of its bill,
    // or all of it if the past-end rent counted) but for the rent it no longer owes.
    const heldBackByPastStayEnd = pastEnd.length > 0
      && (coversWholeBill
        || covers(sortRows(lr.map(asIfOwed).filter(r => r.required)),
          planIfPastEndPayable.filter(l => l.leaseId === leaseId), r => r.creditEligible))
    return {
      leaseId,
      rows: lr,
      requiredIds: required.map(r => r.id),
      requiredTotal: sum(required),
      creditEligibleTotal: sum(required.filter(r => r.creditEligible)),
      creditAlreadyApplied: toDollars(required.reduce((s, r) => s + toCents(r.appliedOnRow), 0)),
      gamTotal: sum(required.filter(r => r.gamOwned)),
      neighborTotal: sum(required.filter(r => r.neighbor)),
      bankPayableTotal: sum(lr.filter(r => r.bankPayable)),
      carriedTotal: sum(lr.filter(r => r.payable && r.carried)),
      inFlightTotal: sum(lr.filter(r => r.inFlight)),
      usableCredit: toDollars(lines.reduce((s, l) => s + toCents(l.amount), 0)),
      heldReleasable: toDollars(lr.filter(r => r.payable).reduce((s, r) => s + toCents(r.heldOnRow), 0)),
      scheduledRetries: [...retries.values()],
      monthlyCap: hl.caps.get(leaseId) ?? null,
      coversWholeBill,
      pastStayEndRentIds: pastEnd.map(r => r.id),
      pastStayEndRentTotal: sum(pastEnd),
      heldBackByPastStayEnd,
    }
  })

  const noLeaseRows = rows.filter(r => r.scopeLeaseId === null)
  const total = (f: (l: LeaseQuote) => number) => toDollars(leases.reduce((s, l) => s + toCents(f(l)), 0))
  return {
    tenantId, landlordId,
    leaseIds: hl.ids,
    leases,
    noLeaseRows,
    credits,
    plan,
    totals: {
      required: total(l => l.requiredTotal),
      bankPayable: toDollars(leases.reduce((s, l) => s + toCents(l.bankPayableTotal), 0)
        + noLeaseRows.filter(r => r.bankPayable).reduce((s, r) => s + toCents(r.amount), 0)),
      carried: total(l => l.carriedTotal),
      gam: total(l => l.gamTotal),
      inFlight: total(l => l.inFlightTotal),
      usableCredit: toDollars(plan.reduce((s, l) => s + toCents(l.amount), 0)),
      creditOnFile: toDollars(credits.reduce((s, c) => s + toCents(c.amountRemaining) + toCents(c.releasable), 0)),
      heldReleasable: total(l => l.heldReleasable),
    },
  }
}

/** The household plan for one lease (what that lease's charge carries), or the whole household. */
export function planCredit(quote: HouseholdQuote, leaseId?: string): CreditPlanLine[] {
  return leaseId ? quote.plan.filter(l => l.leaseId === leaseId) : [...quote.plan]
}

async function readCredits(
  client: PoolClient,
  a: { tenantId: string; landlordId: string; leaseIds: string[]; memberLeaseIds: string[]; includeReleasable: boolean },
): Promise<QuoteCredit[]> {
  const res = await client.query<{
    kind: CreditKind; id: string; lease_id: string | null; tenant_id: string; amount_remaining: string
    releasable: string; created_at: string; funded_by: PrepaidFundedBy | null; category: string | null; gam_held: boolean
    dispute_claim: string
  }>(
    `SELECT 'paid_ahead' AS kind, c.id, c.lease_id, c.tenant_id, c.amount_remaining::text AS amount_remaining,
            (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u JOIN payments p ON p.id = u.payment_id
              WHERE u.prepaid_credit_id = c.id AND u.status = 'held' AND ${payableRowSql('p')})::text AS releasable,
            to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            c.funded_by, NULL::text AS category,
            COALESCE(c.funded_by = 'gam',
                     EXISTS (SELECT 1 FROM tenant_remittances r
                              WHERE r.id = c.source_remittance_id
                                AND r.payment_method IN ('ach','card')
                                AND r.stripe_payment_intent_id IS NOT NULL)
                     OR EXISTS (SELECT 1 FROM payments sp WHERE sp.id = c.source_payment_id AND sp.platform_held)) AS gam_held,
            CASE WHEN dc.pi IS NULL THEN '0' WHEN dc.full_claim THEN 'full' ELSE dc.claim_left::text END AS dispute_claim
       FROM lease_prepaid_credits c
       ${disputeClaimJoinSql('c')}
      WHERE c.voided_at IS NULL
        -- a lease they are a member of: its money; any other: only their own
        AND (c.lease_id = ANY($4::uuid[]) OR (c.lease_id = ANY($3::uuid[]) AND c.tenant_id = $1))
     UNION ALL
     SELECT CASE WHEN tc.category = 'deposit_interest' THEN 'deposit_interest' ELSE 'issued' END,
            tc.id, tc.lease_id, tc.tenant_id, tc.amount_remaining::text,
            (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u JOIN payments p ON p.id = u.payment_id
              WHERE u.tenant_credit_id = tc.id AND u.status = 'held' AND ${payableRowSql('p')})::text,
            to_char(tc.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            NULL, tc.category, tc.category = 'deposit_interest', '0'
       FROM tenant_credits tc
      WHERE tc.status = 'active' AND tc.landlord_id = $2
        AND (tc.lease_id = ANY($4::uuid[])
             OR (tc.lease_id = ANY($3::uuid[]) AND tc.tenant_id = $1)
             OR (tc.lease_id IS NULL AND tc.tenant_id = $1))`,
    [a.tenantId, a.landlordId, a.leaseIds, a.memberLeaseIds])
  return res.rows
    .map(c => {
      // Paid-ahead money a dispute or return of its own funding still claims
      // (disputeClaimJoinSql) is not the tenant's: it is kept out of every
      // figure, so it is never spent and never paid out — before the dispute
      // handler has taken it back, and where it has no record to take it back
      // against. Taken from the money on the credit first, then from what
      // paying now would release (the release takes it back first too).
      const remaining = toCents(c.amount_remaining)
      const releasable = a.includeReleasable ? toCents(c.releasable) : 0
      const withheld = c.dispute_claim === 'full' ? remaining + releasable
        : Math.min(Math.max(0, toCents(c.dispute_claim)), remaining + releasable)
      const offRemaining = Math.min(withheld, remaining)
      return {
        kind: c.kind,
        id: c.id,
        leaseId: c.lease_id,
        tenantId: c.tenant_id,
        amountRemaining: toDollars(remaining - offRemaining),
        releasable: toDollars(releasable - (withheld - offRemaining)),
        disputed: toDollars(withheld),
        // Microseconds, so two credits made in the same millisecond still keep their order.
        createdAt: c.created_at,
        fundedBy: c.funded_by,
        gamHeld: c.gam_held === true,
        category: c.category,
      }
    })
    .filter(c => toCents(c.amountRemaining) + toCents(c.releasable) > 0)
}

/**
 * Paid-ahead money already drawn per lease and billing month (held + applied
 * uses on charges; a move-out pool or a dispute clawback is not a month's
 * draw). Keyed `${leaseId}|${YYYY-MM-01}`. With includeReleasable, credit a
 * scheduled retry holds on a payable row is not counted: paying now gives it back.
 */
export async function paidAheadDrawnByMonth(client: PoolClient, leaseIds: readonly string[], includeReleasable = false): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (leaseIds.length === 0) return out
  const r = await client.query<{ lease_id: string; m: string; drawn: string; releasable: string }>(
    `SELECT u.lease_id, to_char(u.billing_month, 'YYYY-MM-DD') AS m,
            SUM(u.amount)::text AS drawn,
            COALESCE(SUM(u.amount) FILTER (WHERE u.status = 'held' AND ${payableRowSql('p')}), 0)::text AS releasable
       FROM credit_uses u
       LEFT JOIN payments p ON p.id = u.payment_id
      WHERE u.lease_id = ANY($1::uuid[])
        AND u.prepaid_credit_id IS NOT NULL
        AND u.status IN ('held','applied')
        AND u.deposit_return_id IS NULL AND u.payment_reversal_id IS NULL
        -- 10/4: a refund at an early check-out is not a month's draw either.
        AND u.refund_part_id IS NULL
      GROUP BY u.lease_id, u.billing_month`,
    [[...leaseIds]])
  for (const x of r.rows) {
    const drawn = toCents(x.drawn) - (includeReleasable ? toCents(x.releasable) : 0)
    out.set(`${x.lease_id}|${x.m}`, toDollars(Math.max(0, drawn)))
  }
  return out
}

function sortRows<T extends QuoteRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => compareForAllocation(
    { id: a.id, amount: a.amount, due_date: a.dueDate, type: a.type, entry_description: a.entryDescription, created_at: a.createdAt },
    { id: b.id, amount: b.amount, due_date: b.dueDate, type: b.type, entry_description: b.entryDescription, created_at: b.createdAt }))
}

/** Spend order: paid ahead, then lease-tied credit and deposit interest, then general credit. */
function creditTier(c: QuoteCredit): number {
  if (c.kind === 'paid_ahead') return 0
  if (c.leaseId !== null || c.kind === 'deposit_interest') return 1
  return 2
}

export interface BuildPlanInput {
  rows: QuoteRow[]
  credits: QuoteCredit[]
  /** leases.prepaid_monthly_draw per lease (NULL = no cap). */
  caps: Map<string, number | null>
  /** Paid-ahead drawn per `${leaseId}|${month}`. */
  drawn: Map<string, number>
  /** The household's tenant: a general credit pays a row of theirs, or any row on a lease they are on. */
  tenantId: string
  tenantOnLease: Set<string>
  includeReleasable: boolean
}

/**
 * The household-wide plan (pure). Each credit, in spend order, pays the oldest
 * eligible required rows in the one allocation order: a lease-bound credit
 * (paid ahead, lease-tied) only its own lease's rows; a general credit the
 * household's rows across leases, oldest bill first. Paid-ahead money stops at
 * the month's draw cap (S653). A row is covered at most once in total; credit
 * may cover part of a row (money pays the rest), never more than the row.
 */
export function buildCreditPlan(input: BuildPlanInput): CreditPlanLine[] {
  const eligible = sortRows(input.rows.filter(r =>
    r.required && r.creditEligible && r.leaseId !== null
    // A row a scheduled retry still holds credit on takes no other use until
    // that retry is superseded (the trigger refuses it); only a payer paying
    // now may count it open.
    // Free credit only (includeReleasable false — the whole-bill rule, which
    // never replaces a retry): a row whose bank retry is scheduled gets no
    // credit set aside at all, held or not (decisions.md #46 1b). That retry
    // pulls a fixed amount and never uses credit, so the credit goes to the
    // bills that can be paid with it — a newer bill the free credit covers in
    // full settles itself instead of waiting behind the retrying one.
    && (input.includeReleasable || (toCents(r.heldOnRow) === 0 && !r.retryScheduled))))
  // What credit may still cover: the row less credit already spent on it.
  const open = new Map<string, number>(eligible.map(r => [r.id, Math.max(0, toCents(r.amount) - toCents(r.appliedOnRow))]))
  const capLeft = new Map<string, number>()
  const capFor = (leaseId: string, month: string): number => {
    const key = `${leaseId}|${month}`
    if (!capLeft.has(key)) {
      const cap = input.caps.get(leaseId)
      capLeft.set(key, cap == null ? Number.POSITIVE_INFINITY
        : Math.max(0, toCents(cap) - toCents(input.drawn.get(key) ?? 0)))
    }
    return capLeft.get(key)!
  }
  const credits = [...input.credits].sort((a, b) =>
    creditTier(a) - creditTier(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  const lines: CreditPlanLine[] = []
  const disputeCapLeft = new Map<string, number>()
  for (const c of credits) {
    let left = toCents(c.amountRemaining) + toCents(c.releasable)
    if (left <= 0) continue
    // decisions #48.7: a bill a dispute reopened takes only the paid-ahead
    // credit that same dispute gave back, up to what it gave back of it.
    const mayPay = (r: QuoteRow) => (r.disputeCredits?.length ?? 0) === 0
      || (c.kind === 'paid_ahead' && (r.disputeCredits ?? []).some(d => d.creditId === c.id))
    const candidates = (c.leaseId !== null
      ? eligible.filter(r => r.leaseId === c.leaseId)
      : eligible.filter(r => r.tenantId === c.tenantId || input.tenantOnLease.has(r.leaseId!))).filter(mayPay)
    for (const r of candidates) {
      if (left <= 0) break
      const need = open.get(r.id) ?? 0
      if (need <= 0) continue
      let take = Math.min(left, need)
      const dispute = r.disputeCredits?.find(d => d.creditId === c.id)
      const disputeKey = `${r.id}|${c.id}`
      const disputeRoom = !dispute ? Number.POSITIVE_INFINITY
        : disputeCapLeft.has(disputeKey) ? disputeCapLeft.get(disputeKey)! : toCents(dispute.cap)
      take = Math.min(take, disputeRoom)
      if (take <= 0) continue
      if (c.kind === 'paid_ahead') {
        const room = capFor(r.leaseId!, r.billingMonth)
        take = Math.min(take, room)
        if (take <= 0) continue
        capLeft.set(`${r.leaseId}|${r.billingMonth}`, room - take)
      }
      if (dispute) disputeCapLeft.set(disputeKey, disputeRoom - take)
      lines.push({
        creditKind: c.kind, creditId: c.id, paymentId: r.id, leaseId: r.leaseId!,
        amount: toDollars(take), billingMonth: r.billingMonth,
      })
      open.set(r.id, need - take)
      left -= take
    }
  }
  return lines
}

// ─── Spending ─────────────────────────────────────────────────────────────────

export interface UseContext {
  source: CreditUseSource
  remittanceId?: string | null
  createdBy?: string | null
}

async function insertUses(client: PoolClient, plan: readonly CreditPlanLine[], status: 'held' | 'applied', ctx: UseContext): Promise<string[]> {
  // Charge first, then credit, in id order: the trigger locks in that order too.
  const lines = [...plan]
    .filter(l => toCents(l.amount) > 0)
    .sort((a, b) => a.paymentId.localeCompare(b.paymentId) || a.creditId.localeCompare(b.creditId))
  if (lines.length === 0) return []
  // The trigger lets credit pay any landlord rent on its lease; rent the lease
  // no longer owes is refused here, for a plan any caller built by hand too.
  const pastEnd = await client.query<{ id: string }>(
    `SELECT p.id FROM payments p JOIN leases l ON l.id = p.lease_id
      WHERE p.id = ANY($1::uuid[]) AND ${rentPastStayEndSql('p', 'l')}`,
    [[...new Set(lines.map(l => l.paymentId))]])
  if ((pastEnd.rowCount ?? 0) > 0) {
    throw new AppError(409, 'Part of this bill is rent for after the stay ended, which the lease no longer owes, so credit cannot pay it. Look at the bill again.')
  }
  const ids: string[] = []
  for (const l of lines) {
    const r = await client.query<{ id: string }>(
      `INSERT INTO credit_uses
         (tenant_credit_id, prepaid_credit_id, payment_id, remittance_id, lease_id,
          amount, billing_month, source, status, applied_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9,
               CASE WHEN $9 = 'applied' THEN now() END, $10)
       RETURNING id`,
      [l.creditKind === 'paid_ahead' ? null : l.creditId,
       l.creditKind === 'paid_ahead' ? l.creditId : null,
       l.paymentId, ctx.remittanceId ?? null, l.leaseId,
       toDollars(toCents(l.amount)).toFixed(2), l.billingMonth, ctx.source, status, ctx.createdBy ?? null])
    ids.push(r.rows[0].id)
  }
  return ids
}

/**
 * Set credit aside on a card or bank charge that is still clearing. Applied on
 * payment_intent.succeeded (applyHeldForRemittance), given back on a final
 * failure or cancel (releaseHeldForRemittance). Only a Stripe charge holds.
 */
export async function holdCredit(
  client: PoolClient,
  plan: readonly CreditPlanLine[],
  ctx: { remittanceId: string; source: CreditUseSource; createdBy?: string | null },
): Promise<string[]> {
  if (!(CREDIT_USE_HOLDING_SOURCES as readonly string[]).includes(ctx.source)) {
    throw new Error(`holdCredit: only a card or bank charge sets credit aside (got source ${ctx.source})`)
  }
  if (!ctx.remittanceId) throw new Error('holdCredit: a held use rides a remittance')
  return insertUses(client, plan, 'held', ctx)
}

/** Spend credit now (desk, credit-only settle, whole bill). */
export async function applyCredit(client: PoolClient, plan: readonly CreditPlanLine[], ctx: UseContext): Promise<string[]> {
  return insertUses(client, plan, 'applied', ctx)
}

/**
 * The charge cleared: everything it set aside becomes spent. Idempotent (a
 * replayed webhook finds nothing held). Returns the dollars applied. Run BEFORE
 * allocation, so the owner share reads the row's final split.
 */
export async function applyHeldForRemittance(client: PoolClient, remittanceId: string): Promise<number> {
  const r = await client.query<{ amount: string }>(
    `UPDATE credit_uses SET status = 'applied', applied_at = now()
      WHERE id IN (SELECT id FROM credit_uses
                    WHERE remittance_id = $1 AND status = 'held'
                    ORDER BY payment_id, id FOR UPDATE)
     RETURNING amount::text`,
    [remittanceId])
  return toDollars(r.rows.reduce((s, x) => s + toCents(x.amount), 0))
}

/**
 * The charge failed for good, was canceled, or was replaced: give back what it
 * set aside. Returns the dollars released. Paid-ahead money a dispute or
 * return of its own funding still claims comes back to nobody: that part is
 * taken back at once (drainReleasedOnDisputedFunding); the rest is the tenant's.
 */
export async function releaseHeldForRemittance(
  client: PoolClient,
  remittanceId: string,
  reason: CreditUseHeldReleaseReason,
  opts: { exceptPaymentIds?: readonly string[] } = {},
): Promise<number> {
  // exceptPaymentIds (Step 10, the success webhook): credit set aside on a row
  // the charge DOES settle stays held (applyHeldForRemittance spends it next);
  // only credit riding a row the charge no longer pays is given back.
  const r = await client.query<ReleasedUse>(
    `UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = $2
      WHERE id IN (SELECT id FROM credit_uses
                    WHERE remittance_id = $1 AND status = 'held'
                      AND NOT (payment_id = ANY($3::uuid[]))
                    ORDER BY payment_id, id FOR UPDATE)
     RETURNING amount::text, prepaid_credit_id, lease_id`,
    [remittanceId, reason, [...(opts.exceptPaymentIds ?? [])]])
  await drainReleasedOnDisputedFunding(client, r.rows)
  return toDollars(r.rows.reduce((s, x) => s + toCents(x.amount), 0))
}

interface ReleasedUse { amount: string; prepaid_credit_id: string | null; lease_id: string }

// ─── What a dispute or return still claims on paid-ahead money ────────────────

/**
 * connect_disputes statuses under which Stripe holds the disputed money:
 * an inquiry (warning_*) moves none, a won dispute gave it back, and a
 * charge_refunded close went back by refund, not by the dispute. A subset of
 * connect_disputes_status_check.
 */
export const DISPUTE_STATUSES_MONEY_TAKEN = ['needs_response', 'under_review', 'lost'] as const
const DISPUTE_TAKEN_SQL = DISPUTE_STATUSES_MONEY_TAKEN.map(s => `'${s}'`).join(',')
/** A bank return always takes the whole payment. */
const ACH_RETURN_TYPES_SQL = PAYMENT_REVERSAL_TYPE_VALUES.filter(t => t !== 'card_dispute').map(t => `'${t}'`).join(',')

/** connect_disputes.status of a dispute GAM won: Stripe put the disputed money back (decisions #55). */
export const DISPUTE_STATUS_WON = 'won' as const

const sqlAlias = (fn: string, a: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`${fn}: "${a}" is not a table alias`)
  return a
}

/**
 * Step 10 final fix — decisions #55 ("a dispute GAM WINS undoes exactly what
 * that dispute did … and later disputes count it consistently"). SQL, on a
 * payment_reversals alias: the record belongs to a dispute GAM won. Stripe put
 * that money back, and what the record did is undone by hand from the
 * won-dispute notice (paymentReversal.raiseWonDisputeNotice, decisions
 * #55-AMENDED; the automatic undoWonDispute is a follow-up, not called), so
 * from the win on it takes nothing from a row in the dispute counts: every reader that counts what
 * a charge's rows already lost (the next dispute's split, the paid-ahead claim,
 * the kept-share asks) leaves it out. The record itself is kept (history).
 * A bank return is never "won" (its stripe_object_id is never a dispute id).
 */
export function reversalOfWonDisputeSql(pr: string): string {
  const a = sqlAlias('reversalOfWonDisputeSql', pr)
  return `EXISTS (SELECT 1 FROM connect_disputes wd
                   WHERE wd.status = '${DISPUTE_STATUS_WON}'
                     AND (wd.id = ${a}.connect_dispute_id OR wd.stripe_dispute_id = ${a}.stripe_object_id))`
}

/** SQL, on a payment_reversals alias: a record still standing (not of a dispute GAM won). */
export function liveReversalSql(pr: string): string {
  return `NOT ${reversalOfWonDisputeSql(pr)}`
}

/**
 * SQL, on a credit_uses alias: a spend a dispute GAM later won undid
 * ('reversed', funding_reversed). The dispute that undid it wrote its record on
 * the same row in the same transaction (released_at = the record's
 * created_at, both the transaction's now()). Once won, the row is paid by that
 * spend again (v_payment_money counts a reversed use on the row), so it is no
 * longer "money a dispute took off the row".
 */
export function reversedUseOfWonDisputeSql(cu: string): string {
  const a = sqlAlias('reversedUseOfWonDisputeSql', cu)
  return `(${a}.status = 'reversed' AND EXISTS (
            SELECT 1 FROM payment_reversals wr
             WHERE wr.payment_id = ${a}.payment_id AND wr.created_at = ${a}.released_at
               AND ${reversalOfWonDisputeSql('wr')}))`
}

/**
 * What a dispute or return of the Stripe charge behind paid-ahead credit `c`
 * (its source remittance's intent) still claims on that credit, as LATERAL `dc`:
 *   dc.pi          the funding intent (NULL: not Stripe money, nothing to claim);
 *   dc.full_claim  the whole charge was taken back — a bank return, or a card
 *                  dispute for at least what was charged — so none of the
 *                  credit is the tenant's;
 *   dc.claim_left  otherwise: the disputed dollars not yet accounted for, i.e.
 *                  the dispute's amount less what came off the charge's own
 *                  rows (their reversal records, less the paid-ahead spends
 *                  on those rows the records undid — those dollars are the
 *                  credit's and its 'reversal' use counts them) and less what
 *                  was already taken off this credit ('reversal' uses).
 * §3: a partial dispute takes the surplus first (unspent, then set aside, then
 * spent), then rows; so once the dispute handler has run, claim_left is exactly
 * the set-aside money the dispute took, and money it did not take stays the
 * tenant's. A row of the charge is one carrying its intent that was not settled
 * at a desk.
 */
export function disputeClaimJoinSql(c: string, dc = 'dc'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(c) || !/^[a-z_][a-z0-9_]*$/i.test(dc)) {
    throw new Error(`disputeClaimJoinSql: "${c}" / "${dc}" is not a table alias`)
  }
  return `LEFT JOIN LATERAL (
       SELECT x.pi,
              (x.ach_returned OR (x.disputed > 0 AND x.disputed >= x.charge_total)) AS full_claim,
              GREATEST(0, x.disputed - x.rows_reversed - x.drained) AS claim_left
         FROM (SELECT rr.stripe_payment_intent_id AS pi,
                      COALESCE(rr.gross_amount, rr.amount) AS charge_total,
                      (SELECT COALESCE(SUM(d.amount), 0) FROM connect_disputes d
                        WHERE d.stripe_payment_intent_id = rr.stripe_payment_intent_id
                          AND d.status IN (${DISPUTE_TAKEN_SQL})) AS disputed,
                      EXISTS (SELECT 1 FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
                               WHERE p.stripe_payment_intent_id = rr.stripe_payment_intent_id
                                 AND p.manual_method IS NULL
                                 AND pr.reversal_type IN (${ACH_RETURN_TYPES_SQL})) AS ach_returned,
                      -- What came off the charge's rows: their reversal records,
                      -- less the paid-ahead spends those records undid (a
                      -- 'reversed' use on a row of the charge — its record
                      -- carries the use amount, and the credit's own take-back
                      -- ('reversal' use, below) counts the same dollars again).
                      -- Step 10 final fix (decisions #55): a dispute GAM won
                      -- took nothing in the end — its records, the spends it
                      -- undid and its take-backs of this credit are left out
                      -- (the credit it drained was given back as new money
                      -- paid ahead by hand from the won-dispute notice,
                      -- decisions #55-AMENDED).
                      GREATEST(0,
                        (SELECT COALESCE(SUM(pr.reversed_amount), 0) FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
                          WHERE p.stripe_payment_intent_id = rr.stripe_payment_intent_id
                            AND p.manual_method IS NULL AND ${liveReversalSql('pr')})
                        - (SELECT COALESCE(SUM(cu.amount), 0) FROM credit_uses cu JOIN payments p ON p.id = cu.payment_id
                            WHERE p.stripe_payment_intent_id = rr.stripe_payment_intent_id
                              AND p.manual_method IS NULL AND cu.status = 'reversed'
                              AND NOT ${reversedUseOfWonDisputeSql('cu')})) AS rows_reversed,
                      (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u
                        LEFT JOIN payment_reversals ur ON ur.id = u.payment_reversal_id
                        WHERE u.prepaid_credit_id = ${c}.id AND u.source = 'reversal' AND u.status = 'applied'
                          AND (ur.id IS NULL OR ${liveReversalSql('ur')})) AS drained
                 FROM tenant_remittances rr
                WHERE rr.id = ${c}.source_remittance_id AND rr.stripe_payment_intent_id IS NOT NULL) x
     ) ${dc} ON TRUE`
}

/**
 * Step 10: THE usable remaining of paid-ahead credit `c` (lease_prepaid_credits
 * alias), in dollars: its remaining amount less what a dispute or return of its
 * own Stripe funding still claims on it (disputeClaimJoinSql — that part is
 * never spent and never paid out), and nothing for a withdrawn credit. Join
 * disputeClaimJoinSql(c, dc) in the same FROM clause. The one SQL every reader
 * of "paid-ahead money the tenant can use" shares, so the portal, the desk,
 * Outstanding Balances and the monthly draw never show money a dispute took.
 *
 *   SELECT SUM(${usablePaidAheadSql('c', 'dc')})
 *     FROM lease_prepaid_credits c ${disputeClaimJoinSql('c', 'dc')}
 *    WHERE c.lease_id = $1
 */
export function usablePaidAheadSql(c: string, dc = 'dc'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(c) || !/^[a-z_][a-z0-9_]*$/i.test(dc)) {
    throw new Error(`usablePaidAheadSql: "${c}" / "${dc}" is not a table alias`)
  }
  return `(CASE WHEN ${c}.voided_at IS NOT NULL THEN 0
               WHEN ${dc}.pi IS NULL THEN ${c}.amount_remaining
               WHEN ${dc}.full_claim THEN 0
               ELSE GREATEST(0, ${c}.amount_remaining - ${dc}.claim_left) END)`
}

/**
 * Choice46c: SQL, on a Stripe payment intent column (`alias.column`): the
 * card payment behind it is disputed (a dispute under which Stripe holds the
 * money) or the bank payment was returned. Such a payment can never take a
 * refund — the card company or the bank already gave the money back — so a
 * refund of it that has not gone out can never be sent (the paid-ahead money
 * screen offers no Try again for it).
 */
export function fundingTakenBackSql(pi: string): string {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(pi)) {
    throw new Error(`fundingTakenBackSql: "${pi}" is not a column`)
  }
  return `(${pi} IS NOT NULL AND (
     EXISTS (SELECT 1 FROM connect_disputes ftd
              WHERE ftd.stripe_payment_intent_id = ${pi} AND ftd.status IN (${DISPUTE_TAKEN_SQL}))
     OR EXISTS (SELECT 1 FROM payment_reversals ftr JOIN payments ftp ON ftp.id = ftr.payment_id
                 WHERE ftp.stripe_payment_intent_id = ${pi} AND ftp.manual_method IS NULL
                   AND ftr.reversal_type IN (${ACH_RETURN_TYPES_SQL}))))`
}

/**
 * Choice46c: the failure a refund part of the paid-ahead money screen carries
 * once a dispute or bank return of the payment it came from took that money
 * back before the refund went out (recoverChoiceMoney). The card company or
 * the bank already gave it back to the tenant, so it is never sent, never
 * handed back in cash, and the owner has nothing to do for it. Matched
 * exactly (it is the mark), and plain enough to show as it is.
 */
export const PAID_AHEAD_PART_TAKEN_BACK =
  'Not sent: the payment this money came from was disputed or returned by the bank, so that money already went back to them. Nothing more goes back.'

/**
 * Choice46c: the failure a card or bank refund of the paid-ahead money screen
 * carries when the payment it came from was disputed or returned by the bank
 * and that money is still owed to the tenant (the card company or the bank
 * takes no refund of it): it is offered "Give it back in cash instead". Set
 * when a refund waiting to go out is stopped (paidAheadChoice), and on the
 * rest of a refund a partial dispute covered only part of (recoverChoiceMoney).
 */
export const PAID_AHEAD_PART_CANNOT_GO =
  'Not sent: the payment this money came from was disputed or returned by the bank, so it takes no refund. Give it back in cash instead.'

/**
 * Choice46c (review): the failure earlyCheckOut writes on a card or bank part
 * whose refund DID go out at Stripe but could not be recorded ("The refund
 * went to the card, but GAM could not finish recording it — press Try
 * again."). Such a refund reached the tenant: it is never handed back in cash
 * as well, Try again only records it (it finds the refund and sends nothing),
 * and a dispute treats it as a refund that went out. A pattern (SQL `~` and
 * JS) because earlyCheckOut keeps the words; the one place that knows them here.
 */
export const REFUND_NOT_RECORDED_PATTERN = '^The refund went to .+, but GAM could not finish recording it'
const REFUND_NOT_RECORDED_RE = new RegExp(REFUND_NOT_RECORDED_PATTERN)
export const refundWentOutUnrecorded = (failure: string | null | undefined): boolean =>
  !!failure && REFUND_NOT_RECORDED_RE.test(failure)

/** The payout line GAM writes when it releases what it held for a refund handed back in cash instead ('prepaid_draw', 'cash-part:<id>'). */
export const cashPartReleaseWords = (unitNumber: string | null): string =>
  `${unitNumber ? `${unitNumber}: ` : ''}money paid ahead GAM held, for the refund you handed back in cash`

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * Choice46d (review): SQL, on a cash stay_refund_parts alias that replaced a
 * card or bank refund of the paid-ahead money screen — TRUE when the part it
 * replaced had already been counted by a dispute or bank return as never sent
 * (marked PAID_AHEAD_PART_TAKEN_BACK, or named in that event's
 * 'paid_ahead_choice_taken_back' notice, or in the owed-again undo's
 * 'paid_ahead_refund_owed_again_undone' notice: the cash press clears the mark
 * when it replaces the part). The dispute already gave that money back to the
 * tenant, so GAM holds none of it and releases nothing for the cash.
 */
export function cashAfterTakenBackSql(rp: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(rp)) throw new Error(`cashAfterTakenBackSql: "${rp}" is not a table alias`)
  const notSent = (t: string) => `EXISTS (SELECT 1 FROM ${t} tbn
              WHERE tbn.category = 'paid_ahead_choice_taken_back'
                AND COALESCE(tbn.context->'not_sent', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('partId', ${rp}.replaces_part_id::text)))`
  // Choice46d fix pass 3: a part the owed-again undo marked (it names the part
  // it marked in its own notice) — the mark itself is cleared by the cash press.
  const undone = (t: string) => `EXISTS (SELECT 1 FROM ${t} tbu
              WHERE tbu.category = 'paid_ahead_refund_owed_again_undone'
                AND tbu.context->>'part_id' = ${rp}.replaces_part_id::text)`
  return `(${rp}.replaces_part_id IS NOT NULL AND (
     EXISTS (SELECT 1 FROM stay_refund_parts tbq WHERE tbq.id = ${rp}.replaces_part_id AND tbq.failure = ${sqlLit(PAID_AHEAD_PART_TAKEN_BACK)})
     OR ${notSent('admin_notifications')} OR ${notSent('admin_notifications_archive')}
     OR ${undone('admin_notifications')} OR ${undone('admin_notifications_archive')}))`
}

/**
 * Choice46d (review): SQL, on a cash stay_refund_parts alias that replaced a
 * card or bank refund of money GAM held — what GAM still holds of that refund
 * for the cash handed back instead, so what it may release to the landlord
 * ('prepaid_draw' 'cash-part:<id>'), in dollars: the refund spend's amount
 * (its credit_uses row, at the start of the part's chain) less what a dispute
 * or return already took of it (the chain's PAID_AHEAD_PART_TAKEN_BACK parts:
 * refund first, then the card fee given back with it) and less what GAM
 * already released for another cash part of the same refund — never more than
 * the cash part's own toward_amount, never below $0, and $0 when the part it
 * replaced had been counted as never sent (cashAfterTakenBackSql). So GAM never
 * pays the landlord money a dispute took, nor the same money twice.
 */
export function cashPartReleaseSql(rp: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(rp)) throw new Error(`cashPartReleaseSql: "${rp}" is not a table alias`)
  return `(WITH RECURSIVE crup AS (
       SELECT q.id, q.replaces_part_id FROM stay_refund_parts q WHERE q.id = ${rp}.id
       UNION ALL
       SELECT q.id, q.replaces_part_id FROM crup JOIN stay_refund_parts q ON q.id = crup.replaces_part_id
     ), crdown AS (
       SELECT q.id, q.status, q.failure, q.amount, q.kind FROM stay_refund_parts q
        WHERE q.id = (SELECT crup.id FROM crup WHERE crup.replaces_part_id IS NULL LIMIT 1)
       UNION ALL
       SELECT q.id, q.status, q.failure, q.amount, q.kind FROM crdown JOIN stay_refund_parts q ON q.replaces_part_id = crdown.id
     ), crspend AS (
       SELECT COALESCE((SELECT u.amount FROM credit_uses u JOIN crup ON u.refund_part_id = crup.id
                         WHERE crup.replaces_part_id IS NULL AND u.status = 'applied' LIMIT 1), ${rp}.toward_amount) AS amt
     )
     SELECT CASE WHEN ${cashAfterTakenBackSql(rp)} THEN 0::numeric
            ELSE GREATEST(0, LEAST(${rp}.toward_amount,
                   crspend.amt
                   - LEAST(crspend.amt, COALESCE((SELECT SUM(d.amount) FROM crdown d
                                                  WHERE d.status = 'failed' AND d.failure = ${sqlLit(PAID_AHEAD_PART_TAKEN_BACK)}), 0))
                   - COALESCE((SELECT SUM(h.amount) FROM crdown d
                                 JOIN held_payout_items h ON h.source_type = 'prepaid_draw' AND h.source_id = 'cash-part:' || d.id::text
                                WHERE d.id <> ${rp}.id AND d.kind = 'cash'), 0))) END
       FROM crspend)`
}

/**
 * Choice46d (review): mark `take` cents of a card or bank refund part that did
 * not go out as already given back by a dispute or bank return
 * (PAID_AHEAD_PART_TAKEN_BACK: never sent, never handed back). A dispute
 * covers the refund itself first, then the card fee given back with it (#38
 * Q4: both were the tenant's to get back). What it did not cover is still the
 * tenant's: it is split onto a new part in its place (replaces_part_id),
 * failed with `restFailure` — the payment takes no refund, so it is offered
 * "Give it back in cash instead". A part's toward_amount must stay above $0
 * (stay_refund_parts_amount_check), so a rest that is only card fee is carried
 * as the new part's toward_amount (card_fee_back 0) and the marked part keeps
 * the fee: the two still add up to the refund, and cashPartReleaseSql never
 * pays the landlord for that rest (GAM holds none of it). The caller holds the
 * part's lock. Returns the cents still the tenant's (0: wholly marked), or
 * null when the part is not waiting any more.
 */
async function markTakenBack(client: PoolClient, partId: string, take: number, restFailure: string): Promise<{ rest: number } | null> {
  const p = (await client.query<{ toward: string; fee: string; amount: string }>(
    `SELECT toward_amount::text AS toward, card_fee_back::text AS fee, amount::text AS amount
       FROM stay_refund_parts WHERE id = $1 AND status IN ('pending', 'failed') AND reversed_at IS NULL FOR UPDATE`, [partId])).rows[0]
  if (!p) return null
  const toward = toCents(p.toward)
  const amount = toCents(p.amount)
  const rest = amount - take
  // The rest as the new part carries it: the refund first, then its card fee.
  const restToward = take < toward ? toward - take : rest
  const restFee = rest - restToward
  const takenToward = toward - restToward
  const takenFee = take - takenToward
  // Wholly covered — or a rest the CHECK cannot carry (a card fee left larger than the refund itself: never in practice).
  if (rest <= 0 || takenToward <= 0) {
    if (rest > 0) logger.error({ partId, take, toward, amount }, '[credit-use] a dispute covered a refund\'s money but not all of its card fee, and the rest could not be split off')
    await client.query(`UPDATE stay_refund_parts SET status = 'failed', failure = $2, refunded_at = NULL WHERE id = $1`,
      [partId, PAID_AHEAD_PART_TAKEN_BACK])
    return { rest: 0 }
  }
  await client.query(
    `INSERT INTO stay_refund_parts
       (decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, remittance_id, prepaid_credit_id, pos_transaction_id,
        stripe_payment_intent_id, toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label,
        status, failure, replaces_part_id, paid_ahead_choice_id, deposit_return_id, deposit_payment_id)
     SELECT decision_id, booking_id, landlord_id, seq, kind, stay_payment_id, remittance_id, prepaid_credit_id, pos_transaction_id,
            stripe_payment_intent_id, $2::numeric, $3::numeric, $2::numeric + $3::numeric,
            LEAST(payout_drop, $2::numeric + $3::numeric), lodging_tax_share, label,
            'failed', $4, id, paid_ahead_choice_id, deposit_return_id, deposit_payment_id
       FROM stay_refund_parts WHERE id = $1`,
    [partId, toDollars(restToward).toFixed(2), toDollars(restFee).toFixed(2), restFailure])
  await client.query(
    `UPDATE stay_refund_parts
        SET toward_amount = $2::numeric, card_fee_back = $3::numeric, amount = $2::numeric + $3::numeric,
            payout_drop = 0, lodging_tax_share = 0, status = 'failed', failure = $4, refunded_at = NULL
      WHERE id = $1`, [partId, toDollars(takenToward).toFixed(2), toDollars(takenFee).toFixed(2), PAID_AHEAD_PART_TAKEN_BACK])
  return { rest }
}

export interface DisputeClaim {
  creditId: string
  /** The funding charge's intent; null when the credit is not Stripe money (nothing to claim). */
  paymentIntentId: string | null
  /** The funding remittance (the credit's source_remittance_id). */
  remittanceId: string | null
  /** The whole charge was taken back: nothing of the credit is the tenant's. */
  full: boolean
  /** Dollars still claimed (Infinity when full; 0: the dispute is settled against rows and credit). */
  claim: number
  /** A payment reversal a 'reversal' use may name, or null (no record yet: a charge that paid no rows). */
  reversalId: string | null
  /** Rows the funding charge paid (its intent, not settled at a desk). */
  chargeRows: number
  amountOriginal: number
  voided: boolean
  /** 'card' or 'ach' (the funding remittance's method). */
  method: string | null
}

/**
 * What a dispute or return of a paid-ahead credit's funding still claims on it
 * (disputeClaimJoinSql), and the record a take-back may name: a reversal this
 * credit was already drained against, else one on a row of the funding charge,
 * else one this dispute wrote on a row whose spend of this credit it undid.
 */
export async function disputeClaimOnCredit(client: PoolClient, creditId: string): Promise<DisputeClaim> {
  const r = (await client.query<{
    pi: string | null; remittance_id: string | null; method: string | null; full_claim: boolean | null; claim_left: string | null
    reversal_id: string | null; charge_rows: number; amount_original: string; voided: boolean
  }>(
    `SELECT dc.pi, c.source_remittance_id AS remittance_id, rm.payment_method AS method,
            dc.full_claim, dc.claim_left::text AS claim_left,
            c.amount_original::text AS amount_original, (c.voided_at IS NOT NULL) AS voided,
            (SELECT COUNT(*)::int FROM payments p
              WHERE p.stripe_payment_intent_id = dc.pi AND p.manual_method IS NULL
                AND p.status IN ('settled','returned','paid_via_deposit')) AS charge_rows,
            -- Step 10 final fix (decisions #55): never a record of a dispute
            -- GAM won — a take-back named on it would be left out of every
            -- count (liveReversalSql), as if it never happened.
            COALESCE(
              (SELECT u.payment_reversal_id FROM credit_uses u JOIN payment_reversals ur ON ur.id = u.payment_reversal_id
                WHERE u.prepaid_credit_id = c.id AND ${liveReversalSql('ur')}
                ORDER BY u.held_at DESC, u.id DESC LIMIT 1),
              (SELECT pr.id FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
                WHERE p.stripe_payment_intent_id = dc.pi AND p.manual_method IS NULL AND ${liveReversalSql('pr')}
                ORDER BY pr.created_at, pr.id LIMIT 1),
              (SELECT pr.id FROM credit_uses u
                 JOIN payment_reversals pr ON pr.payment_id = u.payment_id
                 JOIN connect_disputes d ON d.id = pr.connect_dispute_id
                WHERE u.prepaid_credit_id = c.id AND u.status = 'reversed' AND d.stripe_payment_intent_id = dc.pi
                  AND ${liveReversalSql('pr')}
                ORDER BY pr.created_at, pr.id LIMIT 1)) AS reversal_id
       FROM lease_prepaid_credits c
       LEFT JOIN tenant_remittances rm ON rm.id = c.source_remittance_id
       ${disputeClaimJoinSql('c')}
      WHERE c.id = $1`,
    [creditId])).rows[0]
  if (!r) throw new AppError(404, 'That paid-ahead credit was not found.')
  const full = r.pi != null && r.full_claim === true
  return {
    creditId,
    paymentIntentId: r.pi,
    remittanceId: r.remittance_id,
    full,
    claim: r.pi == null ? 0 : full ? Number.POSITIVE_INFINITY : Number(r.claim_left ?? 0),
    reversalId: r.pi == null ? null : r.reversal_id,
    chargeRows: Number(r.charge_rows ?? 0),
    amountOriginal: Number(r.amount_original),
    voided: r.voided === true,
    method: r.method,
  }
}

/** The claim covers every dollar the credit ever held: none of it is the tenant's. */
const claimCoversCredit = (k: DisputeClaim): boolean =>
  k.full || toCents(k.claim) >= toCents(k.amountOriginal)

/**
 * THE one writer of a take-back (choice46c triage): `cents` of a paid-ahead
 * credit taken off it against a dispute's or return's record — a 'reversal'
 * use, never more than the credit holds, nothing off a withdrawn credit (out
 * of every balance already). Returns the cents taken and the use written.
 */
async function writeTakeBack(
  client: PoolClient, creditId: string, reversalId: string, cents: number, why: string,
): Promise<{ cents: number; useId: string | null }> {
  if (cents <= 0) return { cents: 0, useId: null }
  const c = (await client.query<{ lease_id: string; amount_remaining: string; voided_at: Date | null }>(
    `SELECT lease_id, amount_remaining::text AS amount_remaining, voided_at FROM lease_prepaid_credits WHERE id = $1 FOR UPDATE`,
    [creditId])).rows[0]
  if (!c || c.voided_at) return { cents: 0, useId: null }
  const take = Math.min(cents, toCents(c.amount_remaining))
  if (take <= 0) return { cents: 0, useId: null }
  const r = await client.query<{ id: string }>(
    `INSERT INTO credit_uses
       (prepaid_credit_id, payment_reversal_id, lease_id, amount, billing_month, source, status, applied_at)
     VALUES ($1, $2, $3, $4, date_trunc('month', now())::date, 'reversal', 'applied', now())
     RETURNING id`,
    [creditId, reversalId, c.lease_id, toDollars(take).toFixed(2)])
  logger.warn({ creditId, reversalId, drained: toDollars(take), why }, '[credit-use] disputed paid-ahead money taken back, not given back')
  return { cents: take, useId: r.rows[0].id }
}

/**
 * Take `cents` of a disputed charge's paid-ahead credit off it, against this
 * event's record `reversalId` (choice46c triage: the dispute handler's own
 * copy of this writer, paymentReversal.drainCreditForRecord, should call this
 * instead). Never more than the credit holds; nothing off a withdrawn credit.
 * Returns the cents taken.
 */
export async function takeBackCreditAgainstRecord(
  client: PoolClient, creditId: string, reversalId: string, cents: number,
): Promise<number> {
  return (await writeTakeBack(client, creditId, reversalId, cents, 'taken back against the event\'s record')).cents
}

/**
 * Take `cents` of a credit back for the dispute that claims it: a 'reversal'
 * use against the dispute's record. With no record to name — the funding
 * charge paid no rows, so the dispute handler had none to write — and a
 * dispute that took every dollar of the credit, the credit is withdrawn
 * instead (voided: never usable, out of every balance, kept as a record). A
 * partial dispute on such a charge cannot be taken off in part without a
 * record: GAM is told, and the quote keeps the claimed part from being spent
 * (readCredits). A withdrawn credit is out of every balance already.
 */
async function takeBackForDispute(
  client: PoolClient,
  k: DisputeClaim,
  a: { cents: number; leaseId: string; why: string },
): Promise<{ drained: number; withdrawn: boolean; unrecorded: number }> {
  if (a.cents <= 0 || k.voided) return { drained: 0, withdrawn: false, unrecorded: 0 }
  if (k.reversalId) {
    const took = await writeTakeBack(client, k.creditId, k.reversalId, a.cents, a.why)
    return { drained: took.cents, withdrawn: false, unrecorded: 0 }
  }
  if (k.chargeRows === 0 && claimCoversCredit(k)) {
    await withdrawDisputedCredit(client, k)
    return { drained: 0, withdrawn: true, unrecorded: 0 }
  }
  if (k.chargeRows === 0) await alertDisputeUnrecorded(client, k, a.cents)
  // A charge with rows and no record yet: its dispute handler is on the way
  // and takes this as unspent money (clawBackRemittanceCredit).
  return { drained: 0, withdrawn: false, unrecorded: a.cents }
}

/**
 * The void_reason a credit carries when a dispute or bank return took every
 * dollar of it back (withdrawDisputedCredit). A dispute GAM later wins gets
 * that money given back by hand (paymentReversal.wonDisputeHandList and the follow-up
 * undoWonDispute read these words).
 */
export const WITHDRAWN_BY_BANK_RETURN = 'The bank payment that brought this money in was returned, so it is no longer here.'
export const WITHDRAWN_BY_CARD_DISPUTE = 'The card payment that brought this money in was disputed, and Stripe took all of it back.'

/** Withdraw a credit every dollar of which the dispute or return took back. Idempotent. */
async function withdrawDisputedCredit(client: PoolClient, k: DisputeClaim): Promise<void> {
  const why = k.method === 'ach' ? WITHDRAWN_BY_BANK_RETURN : WITHDRAWN_BY_CARD_DISPUTE
  const r = await client.query(
    `UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = $2, updated_at = now()
      WHERE id = $1 AND voided_at IS NULL`,
    [k.creditId, why])
  if ((r.rowCount ?? 0) > 0) {
    k.voided = true
    logger.warn({ creditId: k.creditId, paymentIntentId: k.paymentIntentId }, '[credit-use] paid-ahead money withdrawn: the charge that brought it in was taken back in full')
  }
}

/**
 * A partial dispute of a charge that paid no rows: there is no record a
 * take-back could name, so the claimed dollars stay on the credit — kept out
 * of every quote (readCredits), never spent, never paid out — and GAM is told
 * once per credit to settle it by hand.
 */
async function alertDisputeUnrecorded(client: PoolClient, k: DisputeClaim, cents: number): Promise<void> {
  const seen = await client.query(
    `SELECT 1 FROM admin_notifications WHERE category = 'disputed_credit_unrecorded' AND context->>'credit_id' = $1 LIMIT 1`,
    [k.creditId])
  if ((seen.rowCount ?? 0) > 0) return
  await createAdminNotification({
    severity: 'warn',
    category: 'disputed_credit_unrecorded',
    title: `Part of a disputed payment is still on a tenant's paid-ahead credit (credit ${k.creditId})`,
    body: `A card payment that paid no bill was disputed in part (${k.paymentIntentId}). $${toDollars(cents).toFixed(2)} of the money paid ahead from it is the dispute's, ` +
      `but with no bill on that payment there is no record to take it back against. That part is kept out of the tenant's usable credit, so it is never spent or paid out; ` +
      `the rest stays the tenant's. Settle the disputed part with the landlord by hand.`,
    context: { credit_id: k.creditId, stripe_payment_intent_id: k.paymentIntentId, remittance_id: k.remittanceId, disputed_unrecorded: toDollars(cents) },
  })
}

/**
 * Step 10: a partial dispute of a charge that paid no rows claims more than
 * the paid-ahead money it banked still holds (spent and undone, set aside, or
 * left): the rest of the disputed money is on no record. GAM is told the
 * amount, to settle with the landlord by hand.
 */
async function alertDisputeShort(k: DisputeClaim, cents: number, full = false): Promise<void> {
  // Choice46c: a whole dispute or a bank return of such a payment says so — never "disputed in part".
  const what = full
    ? (k.method === 'ach' ? 'A bank payment that paid no bill was returned' : 'A card payment that paid no bill was disputed in full')
    : 'A card payment that paid no bill was disputed in part'
  await createAdminNotification({
    severity: 'warn',
    category: 'disputed_credit_short',
    title: `A ${full && k.method === 'ach' ? 'returned' : 'disputed'} payment took $${toDollars(cents).toFixed(2)} more than its paid-ahead money could cover (credit ${k.creditId})`,
    body: `${what} (${k.paymentIntentId}). Everything left of the money paid ahead from it was taken back, and $${toDollars(cents).toFixed(2)} of it is still on no record. Settle it with the landlord by hand.`,
    context: { credit_id: k.creditId, stripe_payment_intent_id: k.paymentIntentId, remittance_id: k.remittanceId, short: toDollars(cents) },
  }).catch(() => {})
}

/**
 * S655 review: paid-ahead money that a charge in flight had set aside, when
 * that charge fails, is canceled or is replaced. Releasing a held use puts its
 * amount back on the credit (the ledger trigger). Whatever of it a dispute or
 * return of the credit's own funding still claims (disputeClaimOnCredit) is
 * taken back at once — never spent, never paid out — and only that: money the
 * dispute did not take is the tenant's again. Returns the dollars taken back.
 */
async function drainReleasedOnDisputedFunding(client: PoolClient, released: readonly ReleasedUse[]): Promise<number> {
  const byCredit = new Map<string, { cents: number; leaseId: string }>()
  for (const u of released) {
    if (!u.prepaid_credit_id) continue
    const e = byCredit.get(u.prepaid_credit_id) ?? { cents: 0, leaseId: u.lease_id }
    e.cents += toCents(u.amount)
    byCredit.set(u.prepaid_credit_id, e)
  }
  let drained = 0
  for (const [creditId, e] of [...byCredit.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const c = (await client.query<{ lease_id: string; voided_at: Date | null }>(
      `SELECT lease_id, voided_at FROM lease_prepaid_credits WHERE id = $1 FOR UPDATE`, [creditId])).rows[0]
    if (!c || c.voided_at) continue   // a withdrawn credit is never usable anyway
    const k = await disputeClaimOnCredit(client, creditId)
    if (!k.paymentIntentId || !(k.full || toCents(k.claim) > 0)) continue
    const take = k.full ? e.cents : Math.min(e.cents, toCents(k.claim))
    drained += (await takeBackForDispute(client, k, { cents: take, leaseId: c.lease_id, why: 'released' })).drained
  }
  return toDollars(drained)
}

/**
 * Step 10, the success webhook, right after applyHeldForRemittance: credit the
 * charge had set aside is now spent. Where a dispute or return of that credit's
 * own funding still claims money on it (the dispute handler counted the
 * set-aside money as the dispute's), those spends used money Stripe took back:
 * each goes applied → reversed (funding_reversed), newest bill first (as the
 * clawback undoes spends), whole uses, until the claim is met, and the claimed
 * dollars are taken back (takeBackForDispute).
 * The caller reopens each returned row for the use amount, exactly as the
 * dispute handler does; a reversed use's dollars beyond the claim are the
 * tenant's credit again. Idempotent: a use already reversed is not applied.
 * Order in the webhook: the rows settle and are allocated first (the owner's
 * share booked, afterRowsSettled run), THEN this runs and the reopen records
 * the landlord recovery for the use amount, so a reopened row is never
 * skipped by the settle hooks and its owner share is never paid twice.
 */
export async function reverseHeldSpendsOfDisputedMoney(
  client: PoolClient,
  remittanceId: string,
  opts: { drain?: boolean } = {},
): Promise<{
  reversed: Array<{ useId: string; paymentId: string; leaseId: string; amount: number; creditId: string }>
  drained: number
  /** With drain false: credits whose claimed dollars wait for takeBackDisputedCredit once the caller wrote its records. */
  pendingCredits: string[]
}> {
  // drain false (Step 10, the success webhook): the caller first reopens each
  // row and writes its record, then takes the claimed dollars back against
  // that record (takeBackDisputedCredit) — a take-back with no record to name
  // could only be withdrawn or reported, never drained.
  const drainNow = opts.drain !== false
  const used = (await client.query<{ id: string; payment_id: string; lease_id: string; amount: string; prepaid_credit_id: string }>(
    `SELECT u.id, u.payment_id, u.lease_id, u.amount::text, u.prepaid_credit_id FROM credit_uses u
       JOIN payments p ON p.id = u.payment_id
      WHERE u.remittance_id = $1 AND u.status = 'applied' AND u.prepaid_credit_id IS NOT NULL
      ORDER BY u.prepaid_credit_id, p.due_date DESC, p.created_at DESC, u.id DESC`,
    [remittanceId])).rows
  const reversed: Array<{ useId: string; paymentId: string; leaseId: string; amount: number; creditId: string }> = []
  const pendingCredits: string[] = []
  let drained = 0
  for (const creditId of [...new Set(used.map(u => u.prepaid_credit_id))].sort()) {
    const c = (await client.query<{ lease_id: string }>(
      `SELECT lease_id FROM lease_prepaid_credits WHERE id = $1 FOR UPDATE`, [creditId])).rows[0]
    if (!c) continue
    const k = await disputeClaimOnCredit(client, creditId)
    // A credit withdrawn because the charge behind it was taken back in full
    // (a no-row charge: no record to drain against) is all the claim's: every
    // spend of it is undone, nothing is drained (it is out of every balance).
    const withdrawn = k.voided && !!k.paymentIntentId
    if (!k.paymentIntentId || !(withdrawn || k.full || toCents(k.claim) > 0)) continue
    let left = withdrawn || k.full ? Number.POSITIVE_INFINITY : toCents(k.claim)
    let take = 0
    for (const u of used.filter(x => x.prepaid_credit_id === creditId)) {
      if (left <= 0) break
      await client.query(
        `UPDATE credit_uses SET status = 'reversed', released_at = now(), release_reason = 'funding_reversed'
          WHERE id = $1 AND status = 'applied'`, [u.id])
      reversed.push({ useId: u.id, paymentId: u.payment_id, leaseId: u.lease_id, amount: toDollars(toCents(u.amount)), creditId })
      const t = Math.min(toCents(u.amount), left)
      take += t
      left -= t
    }
    if (!drainNow) { if (take > 0) pendingCredits.push(creditId); continue }
    drained += (await takeBackForDispute(client, k, { cents: take, leaseId: c.lease_id, why: 'spent while disputed' })).drained
  }
  return { reversed, drained: toDollars(drained), pendingCredits }
}

/**
 * Paying now over a scheduled retry (§3). For each retry these rows ride:
 * the retry's held credit is given back ('superseded'), the schedule is
 * cleared on every row of that bank pull (so the cron never re-pulls it), and
 * the intent is returned for the caller to cancel AFTER commit
 * (cancelSupersededIntents). A row whose retry is already in flight is
 * 'processing' and not payable, so it is never here.
 */
export async function supersedeScheduledRetry(client: PoolClient, rowIds: readonly string[]): Promise<{ cancelAfterCommit: string[]; released: number }> {
  if (rowIds.length === 0) return { cancelAfterCommit: [], released: 0 }
  const intents = (await client.query<{ pi: string }>(
    `SELECT DISTINCT p.stripe_payment_intent_id AS pi
       FROM payments p
      WHERE p.id = ANY($1::uuid[]) AND p.status = 'failed' AND p.stripe_payment_intent_id IS NOT NULL
        AND (p.next_retry_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = p.id AND u.status = 'held'))
      ORDER BY 1`,
    [[...rowIds]])).rows.map(r => r.pi)

  let released = 0
  for (const pi of intents) {
    // Every row of the pull, in id order (the lock order), loses its schedule.
    await client.query(
      `UPDATE payments SET next_retry_at = NULL
        WHERE id IN (SELECT id FROM payments
                      WHERE stripe_payment_intent_id = $1 AND status = 'failed' AND next_retry_at IS NOT NULL
                      ORDER BY id FOR UPDATE)`,
      [pi])
    const rems = (await client.query<{ id: string }>(
      `SELECT id FROM tenant_remittances WHERE stripe_payment_intent_id = $1 ORDER BY id`, [pi])).rows
    for (const rem of rems) released += toCents(await releaseHeldForRemittance(client, rem.id, 'superseded'))
  }
  // Defensive: held credit on these rows whose remittance names another intent.
  const stray = await client.query<ReleasedUse>(
    `UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'superseded'
      WHERE id IN (SELECT u.id FROM credit_uses u JOIN payments p ON p.id = u.payment_id
                    WHERE u.payment_id = ANY($1::uuid[]) AND u.status = 'held' AND p.status IN ('pending','failed')
                    ORDER BY u.payment_id, u.id FOR UPDATE OF u)
     RETURNING amount::text, prepaid_credit_id, lease_id`,
    [[...rowIds]])
  await drainReleasedOnDisputedFunding(client, stray.rows)
  released += stray.rows.reduce((s, x) => s + toCents(x.amount), 0)
  return { cancelAfterCommit: intents, released: toDollars(released) }
}

/**
 * Cancel the bank pulls a payer superseded. After COMMIT only; never throws.
 * A pull that cannot be canceled cannot be re-pulled either (its schedule is
 * cleared), so a failure is logged and an admin told, nothing more.
 */
export async function cancelSupersededIntents(intentIds: readonly string[]): Promise<void> {
  if (intentIds.length === 0) return
  const { getStripe } = await import('../lib/stripe')
  for (const id of intentIds) {
    try {
      await getStripe().paymentIntents.cancel(id)
    } catch (e) {
      logger.warn({ err: e, paymentIntentId: id }, '[credit-use] superseded retry could not be canceled')
      await createAdminNotification({
        severity: 'warn',
        category: 'superseded_retry_cancel_failed',
        title: `A replaced bank retry could not be canceled (${id})`,
        body: `The tenant paid now, so the scheduled retry on ${id} was replaced and its schedule cleared — it will not be pulled again. Stripe refused the cancel (${e instanceof Error ? e.message : String(e)}); cancel it in Stripe so it does not sit open.`,
        context: { stripe_payment_intent_id: id },
      }).catch(() => {})
    }
  }
}

// ─── Settling a bill credit covers in full ───────────────────────────────────

export interface SettleResult {
  leaseId: string
  settledIds: string[]
  /** Dollars of credit spent. */
  creditUsed: number
  /** Dollars booked to owners (GAM-held credit only: paid-ahead through GAM, deposit interest). */
  ownerShareBooked: number
  /** Bank pulls this settle superseded; cancel them after commit (afterCommit does). */
  cancelAfterCommit: string[]
  /** Call once after COMMIT: the receipt, and canceling superseded pulls. Never throws. */
  afterCommit: () => Promise<void>
}

/**
 * Settle every required row of one lease from credit the plan lines spend.
 * The caller has checked the lines cover each row in full and holds the lock.
 */
async function settleRowsFromCredit(
  client: PoolClient,
  a: { leaseId: string; requiredIds: string[]; lines: CreditPlanLine[]; source: CreditUseSource; createdBy?: string | null; receipt: boolean },
): Promise<Omit<SettleResult, 'cancelAfterCommit' | 'afterCommit'> & { afterReceipt: () => Promise<void> }> {
  await applyCredit(client, a.lines, { source: a.source, createdBy: a.createdBy ?? null })
  // One UPDATE stamps every row, and only rows still owed. platform_held
  // follows the row's payout figure (I8): GAM-funded credit means GAM holds the
  // landlord's money for this row and the Tuesday batch pays it; landlord-held
  // and issued credit pay the landlord nothing (they already have it, or gave it).
  const settled = await client.query<{ id: string }>(
    `UPDATE payments p
        SET status = 'settled', settled_at = now(),
            platform_held = CASE WHEN p.revenue_owner = 'landlord'
                                 THEN COALESCE((SELECT vm.gam_held_part > 0 FROM v_payment_money vm
                                                 WHERE vm.payment_id = p.id), false)
                                 ELSE p.platform_held END,
            notes = COALESCE(p.notes || ' — ', '') || 'Paid with account credit'
      WHERE p.id = ANY($1::uuid[]) AND p.status IN ('pending','failed')
     RETURNING p.id`,
    [a.requiredIds])
  if (settled.rows.length !== a.requiredIds.length) {
    throw new AppError(409, 'Part of this bill changed while it was being paid. Nothing was charged — please look at the bill again.')
  }
  const settledIds = settled.rows.map(r => r.id).sort()

  // Charges5 fix (decisions #48.7): a bill a dispute reopened, paid now with
  // the credit that same dispute gave back, resolves its reversal exactly as a
  // card or bank re-payment does (webhooks' success path): the landlord gets
  // the re-payment only if they were already charged back for the original
  // (reDisburse); otherwise GAM keeps it and gives back what it withheld from
  // them — so the landlord is paid for the bill exactly once.
  const reDisburse = new Map<string, boolean>()
  const reopened = (await client.query<{ id: string; reversal_id: string }>(
    `SELECT id, reversal_id FROM payments WHERE id = ANY($1::uuid[]) AND reversal_id IS NOT NULL ORDER BY id`,
    [settledIds])).rows
  if (reopened.length > 0) {
    // Dynamic: paymentReversal imports this file.
    const { resolveReversalOnTenantPayment } = await import('./paymentReversal')
    for (const r of reopened) reDisburse.set(r.id, await resolveReversalOnTenantPayment(client, r.reversal_id))
  }

  let ownerShareBooked = 0
  const held = await client.query<{ payment_id: string; type: string; revenue_owner: string; unit_id: string | null }>(
    `SELECT vm.payment_id, p.type, p.revenue_owner, p.unit_id
       FROM v_payment_money vm JOIN payments p ON p.id = vm.payment_id
      WHERE vm.payment_id = ANY($1::uuid[]) AND vm.gam_held_part > 0
      ORDER BY vm.payment_id`,
    [settledIds])
  for (const h of held.rows) {
    if (!(ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(h.type) || h.revenue_owner !== 'landlord' || !h.unit_id) continue
    // A reopened bill whose landlord still has the original payment: GAM keeps this one.
    if (reDisburse.get(h.payment_id) === false) continue
    // No second processing fee: GAM-held paid-ahead money paid its fee when it
    // arrived; deposit interest never had one.
    await executeRentAllocation(client, h.payment_id, 'ach', { feeAlreadyCollected: true })
    const own = await client.query<{ amount: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS amount FROM user_balance_ledger
        WHERE reference_id = $1 AND reference_type = 'payment' AND type = 'allocation_owner_share'`,
      [h.payment_id])
    ownerShareBooked += toCents(own.rows[0]?.amount)
  }

  const after = await afterRowsSettled(client, settledIds, {
    attestationSource: 'gam_workflow_auto',
    attestationEvidence: { paid_with: 'account_credit', source: a.source },
    receipt: a.receipt ? { method: 'your account credit', reference: null } : null,
  })
  const banked = await bankShortenedStaysAfter(client, settledIds)
  return {
    leaseId: a.leaseId,
    settledIds,
    creditUsed: toDollars(a.lines.reduce((s, l) => s + toCents(l.amount), 0)),
    ownerShareBooked: toDollars(ownerShareBooked),
    afterReceipt: async () => {
      await after.afterCommit()
      await wholeBillChecksForBanked(banked)
    },
  }
}

/**
 * The settle-path hook for shortened stays (bookingLeaseBilling
 * .bankShortenedStaysAfterSettle), run by the credit-only and whole-bill
 * settles: rent that was unpaid when a stay was shortened and is paid now is
 * banked as stay-shortened money paid ahead, if any of it is over what the
 * stay owes. In its own savepoint: a failure is logged and never undoes the
 * settle (the next settle of that lease's rent banks it). The caller runs
 * wholeBillChecksForBanked after its commit.
 */
async function bankShortenedStaysAfter(client: PoolClient, settledIds: readonly string[]): Promise<StayShortenedBanked[]> {
  if (settledIds.length === 0) return []
  // Dynamic: bookingLeaseBilling imports this file.
  const { bankShortenedStaysAfterSettle } = await import('./bookingLeaseBilling')
  await client.query('SAVEPOINT stay_shortened_hook')
  try {
    const banked = await bankShortenedStaysAfterSettle(client, settledIds)
    await client.query('RELEASE SAVEPOINT stay_shortened_hook')
    return banked
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT stay_shortened_hook')
    logger.error({ err: e, settledIds }, '[credit-use] could not bank rent paid past a shortened stay after a credit settle')
    return []
  }
}

/** After COMMIT: a final bill the newly banked stay-shortened money covers settles now. Never throws. */
async function wholeBillChecksForBanked(banked: readonly StayShortenedBanked[]): Promise<void> {
  for (const b of banked) {
    await runWholeBillCheckAfterCommit({ tenantId: b.tenantId, landlordId: b.landlordId, onlyLeaseIds: [b.leaseId] })
  }
}

async function landlordOfLease(client: PoolClient, leaseId: string): Promise<string> {
  const r = await client.query<{ landlord_id: string }>(`SELECT landlord_id FROM leases WHERE id = $1`, [leaseId])
  if (!r.rows[0]) throw new AppError(404, 'That lease was not found.')
  return r.rows[0].landlord_id
}

/**
 * "Pay with credit — nothing charged": the payer's credit covers the lease's
 * whole bill. Takes the household lock (re-entrant if the caller holds it),
 * gives back any scheduled retry's credit first, re-quotes under the lock and
 * settles every required row from credit. Refused with 409 if the credit no
 * longer covers the whole bill, or (with `expectedCredit`) moved since the
 * payer's screen loaded. Uses are 'applied' at once; nothing is charged.
 *
 * `lines` (the charge path, rentCharge): the credit plan the caller made for
 * this one charge under the same lock — only the credit free for it, and none
 * set aside for a bill whose bank retry is already on its way (decisions.md
 * #46 1b) — which can differ from the household plan. They are spent instead
 * of the household plan, with the caller's own source on every use and on the
 * receipt; `expectedCredit` is checked against them. They must be this lease's
 * and pay every required row in full, or nothing is settled (409).
 */
export async function settleFromCredit(
  client: PoolClient,
  opts: {
    leaseId: string; tenantId: string; source: CreditUseSource; createdBy?: string | null; expectedCredit?: number; receipt?: boolean
    lines?: readonly CreditPlanLine[]
  },
): Promise<SettleResult> {
  const landlordId = await landlordOfLease(client, opts.leaseId)
  await lockHousehold(client, opts.tenantId, landlordId)
  // The bill this payer may settle: the whole lease when they are a member of
  // it, else only their own rows on it (the same scope as householdQuote), so
  // a roommate who left never supersedes the remaining tenant's retry.
  const owed = await client.query<{ id: string }>(
    `SELECT p.id FROM payments p
      WHERE (p.lease_id = $1 OR p.invoice_id IN (SELECT i.id FROM invoices i WHERE i.lease_id = $1))
        AND p.status IN ('pending','failed')
        AND (p.tenant_id = $2
             OR EXISTS (SELECT 1 FROM lease_tenants lt WHERE lt.lease_id = $1 AND lt.tenant_id = $2
                           AND lt.status IN (${MEMBER_STATUS_SQL})))
      ORDER BY p.id FOR UPDATE OF p`,
    [opts.leaseId, opts.tenantId])
  const superseded = await supersedeScheduledRetry(client, owed.rows.map(r => r.id))

  const quote = await householdQuote(client, { tenantId: opts.tenantId, landlordId, lock: true })
  const lq = quote.leases.find(l => l.leaseId === opts.leaseId)
  if (!lq || lq.requiredIds.length === 0) {
    throw new AppError(409, 'There is nothing to pay on this bill right now.')
  }
  const lines = opts.lines ? [...opts.lines] : planCredit(quote, opts.leaseId)
  const usable = opts.lines ? toDollars(lines.reduce((s, l) => s + toCents(l.amount), 0)) : lq.usableCredit
  if (opts.expectedCredit != null && toCents(opts.expectedCredit) !== toCents(usable)) {
    throw new AppError(409, `Your credit changed — it's now $${usable.toFixed(2)}. Look at the bill again and choose how to pay.`)
  }
  const covered = new Map<string, number>()
  for (const l of lines) covered.set(l.paymentId, (covered.get(l.paymentId) ?? 0) + toCents(l.amount))
  const required = lq.rows.filter(r => r.required)
  const coversWholeBill = opts.lines
    ? lines.every(l => l.leaseId === opts.leaseId && required.some(r => r.id === l.paymentId))
      && required.every(r => r.creditEligible && (covered.get(r.id) ?? 0) + toCents(r.appliedOnRow) === toCents(r.amount))
    : lq.coversWholeBill
  if (!coversWholeBill) {
    throw new AppError(409, usable > 0
      ? `Your credit of $${usable.toFixed(2)} does not cover this whole bill of $${lq.requiredTotal.toFixed(2)}. Pay the rest with your card or bank.`
      : 'There is no credit on this account that can pay this bill.')
  }
  const r = await settleRowsFromCredit(client, {
    leaseId: opts.leaseId, requiredIds: lq.requiredIds, lines,
    source: opts.source, createdBy: opts.createdBy, receipt: opts.receipt !== false,
  })
  const cancelAfterCommit = superseded.cancelAfterCommit
  let done = false
  return {
    leaseId: r.leaseId, settledIds: r.settledIds, creditUsed: r.creditUsed, ownerShareBooked: r.ownerShareBooked,
    cancelAfterCommit,
    afterCommit: async () => {
      if (done) return
      done = true
      await r.afterReceipt()
      await cancelSupersededIntents(cancelAfterCommit)
    },
  }
}

export interface WholeBillResult {
  /** Every row settled, all leases. */
  settledIds: string[]
  leases: Array<{ leaseId: string; settledIds: string[]; creditUsed: number; ownerShareBooked: number }>
  /** Call once after COMMIT: the "paid with your account credit" receipts. Never throws. */
  afterCommit: () => Promise<void>
}

/** Admin categories that already tell GAM a lease carries rent past the stay's end. */
export const PAST_STAY_END_ALERT_CATEGORIES = ['stay_shortened_rent_kept', 'whole_bill_past_stay_end_rent'] as const

/**
 * The credit would have paid this lease's bill, but the account carries rent
 * the lease no longer owes (rent past a shortened stay's end that had to be
 * kept). Nothing was spent; GAM is told once per lease — not again at every
 * bill run and late-fee check, and not at all when the shortening already said
 * so (stay_shortened_rent_kept). Read on the caller's client; written through
 * the alert service.
 */
async function alertPastStayEndRentHeldBack(
  client: PoolClient,
  a: { lease: LeaseQuote; tenantId: string; landlordId: string },
): Promise<void> {
  const open = await client.query(
    `SELECT 1 FROM admin_notifications
      WHERE category = ANY($1::text[]) AND context->>'lease_id' = $2
      LIMIT 1`,
    [[...PAST_STAY_END_ALERT_CATEGORIES], a.lease.leaseId])
  if ((open.rowCount ?? 0) > 0) return
  const kept = a.lease.rows.filter(r => a.lease.pastStayEndRentIds.includes(r.id))
  const month = (ymd: string) =>
    new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  await createAdminNotification({
    severity: 'warn',
    category: 'whole_bill_past_stay_end_rent',
    title: `Credit was not used: the account carries rent after the stay ended (lease ${a.lease.leaseId})`,
    body: `The tenant's credit would pay this lease's bill, but the account still carries $${a.lease.pastStayEndRentTotal.toFixed(2)} of rent due after the stay ended ` +
      `(${kept.map(r => `${month(r.dueDate)} $${r.amount.toFixed(2)}`).join('; ')}), which the lease no longer owes. ` +
      `No credit was spent, nothing was paid on that rent, and the bill was left open. Decide with the landlord and take that rent off in a recorded way; ` +
      `once it is off, the next bill run uses the credit if it covers the bill.`,
    context: {
      lease_id: a.lease.leaseId, tenant_id: a.tenantId, landlord_id: a.landlordId,
      past_stay_end_rent_ids: a.lease.pastStayEndRentIds,
    },
  })
}

/**
 * THE WHOLE-BILL RULE (Nic, 10/2): credit applies by itself only when it
 * covers the whole bill. For each of the household's leases: when every
 * required row is credit-eligible and the lease's share of the household's
 * usable credit pays every one of them in full, the bill is settled from
 * credit, with no click. Anything less settles nothing and the credit waits
 * for the payer's choice (MH 25's $10 against $460). A bill carrying a GAM fee
 * or a neighbor landlord's utility therefore never settles itself, and a lease
 * with a scheduled bank retry is skipped (that pull is the payer's). Neither
 * does a bill carrying rent the lease no longer owes (rent past a shortened
 * stay's end that had to be kept): credit never pays rent for a month the guest
 * is not staying, so that bill waits and GAM is told once
 * (alertPastStayEndRentHeldBack).
 *
 * Takes the household lock (re-entrant). Each lease settles inside its own
 * savepoint: one lease's failure (a property with no payout setup) rolls back
 * only that lease, the bill stands, and an admin is told. Runs at the bill run,
 * right before each late fee, and after commit whenever a credit is created
 * (runWholeBillCheckAfterCommit).
 */
export async function settleWholeBillIfCovered(
  client: PoolClient,
  opts: { tenantId: string; landlordId: string; source?: 'whole_bill'; onlyLeaseIds?: readonly string[]; receipt?: boolean },
): Promise<WholeBillResult> {
  await lockHousehold(client, opts.tenantId, opts.landlordId)
  const done: WholeBillResult['leases'] = []
  const receipts: Array<() => Promise<void>> = []
  const tried = new Set<string>()
  let n = 0
  let quote: HouseholdQuote
  for (;;) {
    quote = await householdQuote(client, {
      tenantId: opts.tenantId, landlordId: opts.landlordId, lock: true, includeReleasable: false,
    })
    const lq = quote.leases.find(l =>
      !tried.has(l.leaseId)
      && (!opts.onlyLeaseIds || opts.onlyLeaseIds.includes(l.leaseId))
      && l.coversWholeBill
      // Rent the lease no longer owes is on this bill: credit never pays rent
      // for a month the guest is not staying, so the bill waits for GAM.
      && l.pastStayEndRentIds.length === 0
      && l.scheduledRetries.length === 0
      && l.rows.every(r => !r.payable || toCents(r.heldOnRow) === 0))
    if (!lq) break
    tried.add(lq.leaseId)
    const sp = `whole_bill_${++n}`
    await client.query(`SAVEPOINT ${sp}`)
    try {
      const r = await settleRowsFromCredit(client, {
        leaseId: lq.leaseId, requiredIds: lq.requiredIds, lines: planCredit(quote, lq.leaseId),
        source: 'whole_bill', receipt: opts.receipt !== false,
      })
      await client.query(`RELEASE SAVEPOINT ${sp}`)
      done.push({ leaseId: r.leaseId, settledIds: r.settledIds, creditUsed: r.creditUsed, ownerShareBooked: r.ownerShareBooked })
      receipts.push(r.afterReceipt)
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      logger.error({ err: e, leaseId: lq.leaseId, tenantId: opts.tenantId }, '[whole-bill] credit covers the bill but it could not be settled — bill left open')
      await createAdminNotification({
        severity: 'warn',
        category: 'whole_bill_credit_failed',
        title: `A bill the tenant's credit covers could not be paid from it (lease ${lq.leaseId})`,
        body: `The tenant's account credit covers the whole bill, but settling it failed (${e instanceof Error ? e.message : String(e)}). The bill stays open and the credit is untouched. Usually a property missing its payout setup; once fixed, the next bill run or credit applies it.`,
        context: { lease_id: lq.leaseId, tenant_id: opts.tenantId, landlord_id: opts.landlordId },
      }).catch(() => {})
    }
  }
  for (const l of quote.leases) {
    if (!l.heldBackByPastStayEnd || (opts.onlyLeaseIds && !opts.onlyLeaseIds.includes(l.leaseId))) continue
    if (l.scheduledRetries.length > 0) continue
    await alertPastStayEndRentHeldBack(client, { lease: l, tenantId: opts.tenantId, landlordId: opts.landlordId })
  }
  let sent = false
  return {
    settledIds: done.flatMap(d => d.settledIds),
    leases: done,
    afterCommit: async () => {
      if (sent) return
      sent = true
      for (const send of receipts) await send()
    },
  }
}

/**
 * The whole-bill check a path runs AFTER its own commit (a credit was issued,
 * interest credited, a late fee refunded, a payment posted, a webhook banked a
 * surplus): its own transaction, committed, receipts sent. Never throws — the
 * caller's money already moved; a failure here only leaves the bill open.
 */
export async function runWholeBillCheckAfterCommit(opts: { tenantId: string; landlordId: string; onlyLeaseIds?: readonly string[] }): Promise<WholeBillResult | null> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const r = await settleWholeBillIfCovered(client, { ...opts, source: 'whole_bill' })
    await client.query('COMMIT')
    await r.afterCommit()
    return r
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error({ err: e, ...opts }, '[whole-bill] after-commit check failed — bill left open')
    return null
  } finally {
    client.release()
  }
}

// ─── Creating and withdrawing credit ──────────────────────────────────────────

/**
 * Money paid ahead. Settles nothing: the caller runs the whole-bill check after
 * its own commit. funded_by says who holds the money (landlord: cash, check,
 * money order, a bank deposit, a typed-in carry-forward; gam: it came through
 * Stripe; reclassified: rent already paid on a stay that was shortened).
 * received_at is the day the money arrived.
 */
export async function createPaidAhead(
  client: PoolClient,
  c: {
    leaseId: string; tenantId: string; amount: number; fundedBy: PrepaidFundedBy; receivedAt: Date | string
    sourceRemittanceId?: string | null; sourcePaymentId?: string | null; note?: string | null
  },
): Promise<string> {
  const cents = toCents(c.amount)
  if (!(cents > 0)) throw new Error('createPaidAhead: the amount has to be more than zero')
  if (!(PREPAID_FUNDED_BY as readonly string[]).includes(c.fundedBy)) {
    throw new Error(`createPaidAhead: unknown funding ${c.fundedBy}`)
  }
  const r = await client.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits
       (lease_id, tenant_id, amount_original, amount_remaining, source_remittance_id, source_payment_id,
        note, funded_by, received_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [c.leaseId, c.tenantId, toDollars(cents).toFixed(2), c.sourceRemittanceId ?? null, c.sourcePaymentId ?? null,
     c.note ?? null, c.fundedBy, c.receivedAt])
  return r.rows[0].id
}

/**
 * A credit the landlord gives (or deposit interest GAM credits). Settles
 * nothing: the caller runs the whole-bill check after its own commit.
 */
export async function createIssuedCredit(
  client: PoolClient,
  c: { landlordId: string; tenantId: string; leaseId?: string | null; amount: number; category: string; reason?: string | null; createdBy?: string | null },
): Promise<string> {
  const cents = toCents(c.amount)
  if (!(cents > 0)) throw new AppError(400, 'A credit has to be more than zero.')
  if (!(TENANT_CREDIT_ALL_CATEGORIES as readonly string[]).includes(c.category)) {
    throw new AppError(400, `Unknown credit category ${c.category}.`)
  }
  if (c.leaseId) {
    const own = await landlordOfLease(client, c.leaseId)
    if (own !== c.landlordId) throw new AppError(409, 'That lease belongs to another landlord.')
  }
  const r = await client.query<{ id: string }>(
    `INSERT INTO tenant_credits
       (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, created_by)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7)
     RETURNING id`,
    [c.landlordId, c.tenantId, c.leaseId ?? null, toDollars(cents).toFixed(2), c.category, c.reason ?? null, c.createdBy ?? null])
  return r.rows[0].id
}

/**
 * Withdraw paid-ahead money that turned out not to be there (an undone
 * bank-deposit settle's excess). The remaining amount is left as it was; a
 * withdrawn credit can never be used and is out of every balance. Refused when
 * any of it was used or is set aside; a credit already withdrawn is left alone.
 */
export async function voidPaidAhead(client: PoolClient, creditId: string, reason: string): Promise<void> {
  if (!reason || !reason.trim()) throw new Error('voidPaidAhead: say why the credit is withdrawn')
  const c = await client.query<{ voided_at: Date | null }>(
    `SELECT voided_at FROM lease_prepaid_credits WHERE id = $1 FOR UPDATE`, [creditId])
  if (!c.rows[0]) throw new AppError(404, 'That paid-ahead credit was not found.')
  if (c.rows[0].voided_at) return
  const used = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM credit_uses WHERE prepaid_credit_id = $1 AND status <> 'released'`, [creditId])
  if (Number(used.rows[0].n) > 0) {
    throw new AppError(409, 'This paid-ahead money has already been used, so it cannot be withdrawn.')
  }
  await client.query(
    `UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1`,
    [creditId, reason.trim()])
}

// ─── Disputes and returns ─────────────────────────────────────────────────────

export interface ClawbackResult {
  /** The paid-ahead credit the disputed money created, if any. */
  creditId: string | null
  /** Spends of that credit undone: each row reopens for the use amount (the dispute handler reopens them). */
  reversed: Array<{ useId: string; paymentId: string; leaseId: string; amount: number }>
  /** Dollars taken off the credit now ('reversal' uses): unspent money, plus every reversed spend. */
  drained: number
  drainUseId: string | null
  /**
   * Dollars to take off the credit that had no record to name yet (no
   * reversalId passed and none written): the caller writes the event's records
   * (one per event and row of the charge — a row that lost nothing, because
   * the surplus covered the whole dispute, gets a $0 record that only names
   * the event), then calls takeBackDisputedCredit with one.
   */
  drainPending: number
  /**
   * Still set aside by a charge in flight: not undone here. The dispute claims
   * `heldClaimed` of it (disputeClaimOnCredit then reads that claim): if the
   * charge fails, is canceled or is replaced, releasing it takes that much back
   * at once and gives the rest to the tenant (releaseHeldForRemittance,
   * supersedeScheduledRetry); if the charge succeeds, the success webhook calls
   * reverseHeldSpendsOfDisputedMoney and reopens those rows (Step 10).
   */
  stillHeld: Array<{ useId: string; paymentId: string | null; amount: number }>
  /** Dollars of the set-aside money the dispute claims (§3: the surplus first — unspent, then set aside, then spent). */
  heldClaimed: number
  /**
   * Dollars of the dispute the credit covers in all — and only what was
   * really covered (choice46c, decisions #51: reported truthfully): taken now
   * (unspent and reversed spends), heldClaimed, and what the landlord's
   * paid-ahead money screen had already done with the money (charged back to
   * the landlord, owed again by the tenant, or a refund that never went out).
   * With maxAmount, the rest — maxAmount less this — comes off the charge's
   * rows, newest first (Step 10).
   */
  clawed: number
  /**
   * Review fix (choice46b, choice46c): money the landlord's paid-ahead money
   * screen paid out to the landlord that the dispute took back — a "Keep it"
   * spend (useId), or what GAM released to them for cash the desk handed back
   * instead of a card or bank refund (useId: the refund's spend, cashPartId:
   * that cash) — charged to the landlord as a negative payout line each (never
   * absorbed by GAM). Part of `clawed`.
   */
  nettedFromLandlord?: Array<{ useId: string; amount: number; cashPartId?: string }>
  /**
   * Choice46c (decisions #51): a refund the screen sent back — to the card or
   * bank, or in cash at the desk — of money the dispute or return then took
   * back again: the tenant got it twice, so it is a balance they owe again, a
   * pending charge owed to whoever paid the refund out (GAM for a card or bank
   * refund of money GAM held; the landlord for cash they handed back, and for
   * the card fee their payout gave back with a refund). The refund's own
   * dollars ('refund') are part of `clawed`; the card fee row is beyond it.
   */
  refundsOwed?: Array<{ useId: string; partId: string; owedTo: 'gam' | 'landlord'; what: 'refund' | 'card_fee'; amount: number; paymentId: string }>
  /**
   * Choice46c: a refund the screen decided that had not gone out (failed, or
   * still sending) when the dispute or return took the money GAM still held
   * for it: it already went back to the tenant that way, so the part is marked
   * (PAID_AHEAD_PART_TAKEN_BACK) and never sent or handed back — only the
   * amount the event covered (`amount`); the rest of a refund it covered in
   * part is split onto a new part offered as cash. Part of `clawed`.
   */
  refundsNotSent?: Array<{ useId: string; partId: string; amount: number }>
  /**
   * Choice46c fix pass 3 + choice46d: a stay's early check-out refund (not
   * this screen's) of this money that had not gone out when the dispute or
   * return took the money back. The stay's screen does not know a dispute's
   * mark yet, so the part is left exactly as it was (not marked "done"); but
   * what the event really took of it is covered like any refund not sent —
   * in budget order, counted in `clawed` (so the rows and spends do not take
   * it as well) — and GAM is told exactly how much of the refund went back
   * through the dispute and how much is still the tenant's. `amount`: what
   * this event covered; `refund`: the part's whole refund; `stillTheirs`:
   * what of it is still owed to the tenant after every event so far. A part
   * the event covered nothing of is not listed (and nobody is told).
   */
  stayRefundsLeft?: Array<{ useId: string; partId: string; amount: number; refund: number; stillTheirs: number }>
}

/** The payout line that charges a landlord back for paid-ahead money the screen paid out to them (a Keep it spend, or a cash part's release) that a dispute or return took (one per charge and item). */
export const choiceNetSourceId = (chargeKey: string, useId: string) =>
  `owner_share_returned:paid-ahead-choice:${chargeKey}:${useId}`

/**
 * Choice46c: the machine key on a charge the tenant owes again for a refund a
 * dispute or return took back (payments.import_extra_data — import_source
 * stays NULL, so it is a native GAM charge): which refund spend it is for, and
 * whether it is the refund itself or the card fee given back with it.
 */
const OWED_USE_KEY = 'paid_ahead_refund_use_id'

/** One thing the paid-ahead money screen did with a credit's money, as a dispute or return of its funding meets it. */
interface ChoiceItem {
  kind: 'keep' | 'not_sent' | 'refund_out' | 'cash_instead'
  useId: string
  /** The money of it (the spend's amount), in cents. */
  cents: number
  /** Cents of it an earlier event already covered. */
  recovered: number
  gamHeld: boolean
  /** GAM paid it out to the landlord (a Keep it spend's, or a cash part's, prepaid_draw). */
  released: boolean
  partId: string | null
  /** The live part's own toward_amount, in cents (what of the tenant's money it stands for now). */
  partToward: number
  /** The live part is on the paid-ahead money screen (paid_ahead_choice_id), not a stay's check-out. */
  onChoice: boolean
  /** Choice46d: a stay's own refund not sent — its whole refund (cents, the card fee given back included) and what earlier events already covered of it. */
  refundAmount: number
  stayBefore: number
  /** The card fee given back with the refund, in cents; and how much of it the tenant already owes again (cents). */
  feeBack: number
  feeOwed: number
  /** A cash part's release ('cash-part:'): what GAM paid the landlord for it (cents), and what it may pay at most (cashPartReleaseSql). */
  releasedCents: number
  releaseCap: number
  partKind: string | null
  refundedAt: Date | null
  at: Date
  landlordId: string; leaseId: string; unitId: string | null; unitNumber: string | null; tz: string | null
}

/**
 * Review fix (choice46b) / choice46c: what of a paid-ahead credit's money the
 * paid-ahead money screen had done with that a dispute or return already
 * covered, in cents — Keep it spends and cash releases charged back to the
 * landlord (choiceNetSourceId lines), refunds the tenant owes again (their
 * 'refund' charges), and refunds that never went out (marked).
 */
/**
 * Choice46d: a stay's own early check-out refund of paid-ahead money is never
 * marked when a dispute or return covers it (the stay's screen does not know
 * the mark), so what each event covered of it is read back from the record
 * that event wrote in its own transaction — the 'paid_ahead_choice_taken_back'
 * admin notice's context.stay_left (amount = what that event covered). Kept or
 * archived, the notice is never deleted. Cents per refund part.
 */
const STAY_COVERED_SQL = `
  SELECT e->>'partId' AS part_id, SUM((e->>'amount')::numeric)::text AS covered
    FROM (SELECT n.context FROM admin_notifications n
           WHERE n.category = 'paid_ahead_choice_taken_back' AND n.context->>'credit_id' = $1::text
          UNION ALL
          SELECT a.context FROM admin_notifications_archive a
           WHERE a.category = 'paid_ahead_choice_taken_back' AND a.context->>'credit_id' = $1::text) x
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(x.context->'stay_left', '[]'::jsonb)) e
   GROUP BY 1`

async function stayRefundCoveredCents(client: PoolClient, creditId: string): Promise<Map<string, number>> {
  const rows = (await client.query<{ part_id: string; covered: string }>(STAY_COVERED_SQL, [creditId])).rows
  return new Map(rows.map(r => [r.part_id, toCents(r.covered)]))
}

async function choiceRecoveredCents(client: PoolClient, creditId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT (COALESCE((SELECT SUM(-h.amount)
                         FROM credit_uses u
                         JOIN held_payout_items h ON h.source_type = 'dispute'
                          AND h.source_id LIKE 'owner\\_share\\_returned:paid-ahead-choice:%:' || u.id::text
                        WHERE u.prepaid_credit_id = $1 AND u.paid_ahead_choice_id IS NOT NULL), 0)
           -- Choice46d (review): the card fee given back with a refund
           -- counts too (a dispute covers the refund first, then its fee).
           + COALESCE((SELECT SUM(x.amount)
                         FROM credit_uses u
                         JOIN payments x ON x.import_extra_data->>'${OWED_USE_KEY}' = u.id::text
                                        AND x.import_extra_data->>'owed' IN ('refund', 'card_fee') AND x.status <> 'voided'
                        WHERE u.prepaid_credit_id = $1 AND u.refund_part_id IS NOT NULL), 0)
           -- A marked part's whole amount: the refund and the card fee the event covered (markTakenBack).
           + COALESCE((SELECT SUM(p.amount)
                         FROM stay_refund_parts p
                        WHERE p.prepaid_credit_id = $1 AND p.status = 'failed' AND p.failure = $2), 0))::text AS n`,
    [creditId, PAID_AHEAD_PART_TAKEN_BACK])
  // Choice46d: and what earlier events covered of a stay's own refund not sent.
  const stay = [...(await stayRefundCoveredCents(client, creditId)).values()].reduce((a, n) => a + n, 0)
  return toCents(r.rows[0]?.n ?? 0) + stay
}

/**
 * Choice46c fix pass 3: a dispute or bank return of paid-ahead money that
 * cannot be recorded yet for an expected, passing reason — a refund of that
 * money was being sent at that moment (lockRefundParts waited 10 seconds), or
 * Stripe could not be asked whether an earlier try of a refund went out
 * (recoverChoiceMoney). Nothing was recorded: the caller's transaction rolls
 * back and the event has to be handled again — a Stripe webhook answers with
 * an error, so Stripe sends it again; anything else (an admin's "handle
 * return" press) must be pressed again: nothing re-runs it on its own. Its
 * words say only that ("Nothing was recorded yet — try again in a moment."),
 * never that it is handled again by itself. `code` and isDisputeRetryLater let
 * a caller tell this passing case from a real failure. Today paymentReversal's
 * catch still raises its critical "Payment reversal handling failed" notice
 * for it, and the admin return route still shows its words as a 503 —
 * reported to those files' owners (choice46e).
 */
export const DISPUTE_RETRY_LATER_CODES = ['refund_part_busy', 'stripe_unreachable'] as const
export type DisputeRetryLaterCode = typeof DISPUTE_RETRY_LATER_CODES[number]
export class DisputeRetryLater extends AppError {
  constructor(public readonly code: DisputeRetryLaterCode, message: string) { super(503, message) }
}
export const isDisputeRetryLater = (e: unknown): e is DisputeRetryLater => e instanceof DisputeRetryLater

/**
 * Choice46c fix pass 3: the failure words of a card or bank refund that could
 * never have gone out (its last try did not reach Stripe's refund at all, or
 * Stripe turned it down): a dispute needs no look at Stripe for these.
 * earlyCheckOut writes them ("…turned this refund down…", the register sale
 * "…already refunded at the register…"); a part a dispute already marked was
 * looked up before it was marked.
 */
const DEFINITE_NO_SEND_RE = /turned this refund down|already refunded at the register/
const definitelyNotSent = (failure: string | null): boolean =>
  failure === PAID_AHEAD_PART_TAKEN_BACK || (!!failure && DEFINITE_NO_SEND_RE.test(failure))

/**
 * Choice46c fix pass 3: did an earlier try of this refund part go out at
 * Stripe after all (its answer lost — a timeout, or a crash after
 * refunds.create)? The same rule as earlyCheckOut.findSentRefund: a refund of
 * the part's payment intent tagged with the part's id
 * (metadata.gam_stay_refund_part_id) that Stripe has not failed or canceled.
 * 'unreachable' when Stripe could not be asked.
 */
async function refundWentOutAtStripe(partId: string, paymentIntentId: string): Promise<boolean | 'unreachable'> {
  try {
    const { getStripe } = await import('../lib/stripe')
    const list = await (getStripe() as any).refunds.list({ payment_intent: paymentIntentId, limit: 100 })
    return (list?.data ?? []).some((r: any) => r?.metadata?.gam_stay_refund_part_id === partId
      && r.status !== 'failed' && r.status !== 'canceled')
  } catch (err) {
    logger.warn({ err, partId }, '[credit-use] could not ask Stripe whether an earlier refund try went out')
    return 'unreachable'
  }
}

/**
 * Choice46d fix pass 3: the advisory key the paid-ahead money screen's "Give it
 * back in cash instead" press holds (a session lock, paidAheadChoice
 * givePaidAheadPartBackInCash) from its undo and checks through the moment the
 * part is replaced by cash. lockRefundParts takes it too, so a dispute, a bank
 * return or the owed-again undo can never mark a part as given back between a
 * press's checks and its hand-back — one waits for the other.
 */
export const paidAheadCashPressKey = (partId: string): string => `paid-ahead-cash-press:${partId}`

/**
 * Choice46c (review): take each refund part's own lock ('stay-refund-part:<id>',
 * the key earlyCheckOut.runCardPart and givePartBackInCash hold while they
 * send it or hand it back) for the rest of the caller's transaction, in id
 * order. A send in flight holds its lock across a Stripe call, so this waits
 * a few seconds at most; past 10 seconds it gives up and throws
 * (DisputeRetryLater: nothing recorded — a webhook's event comes again on
 * Stripe's retry, a manual press is pressed again), never waiting on a lock forever and
 * never marking a part under a send.
 */
async function lockRefundParts(client: PoolClient, partIds: readonly string[], wait = '10s'): Promise<void> {
  if (!partIds.length) return
  const prev = (await client.query<{ t: string }>(`SELECT current_setting('lock_timeout') AS t`)).rows[0]?.t ?? '0'
  await client.query('SAVEPOINT refund_part_locks')
  try {
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [wait])
    for (const id of [...partIds].sort()) {
      // Choice46d fix pass 3: the cash press's own key first (it holds it from
      // its checks through the hand-back), so no dispute or undo can mark a
      // part between a press's look and its replacement — then the part's own.
      // Never waited on: the caller may already hold the credit's row lock,
      // which the press's hand-back needs (its new part names the credit), so
      // a press in flight sends this event round again instead (Stripe
      // delivers it again; the undo runs again on the next look or sweep).
      const free = (await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok`, [paidAheadCashPressKey(id)])).rows[0]?.ok
      if (!free) throw new Error('a cash hand-back of this refund is being recorded right now')
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`stay-refund-part:${id}`])
    }
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [prev])
    await client.query('RELEASE SAVEPOINT refund_part_locks')
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT refund_part_locks').catch(() => {})
    await client.query('RELEASE SAVEPOINT refund_part_locks').catch(() => {})
    logger.warn({ err, partIds }, '[credit-use] a refund of disputed money was being sent at that moment; nothing was recorded — the event must be handled again')
    throw new DisputeRetryLater('refund_part_busy', 'A refund of this money was being sent at that same moment, so nothing was recorded yet — try again in a moment.')
  }
}

/**
 * Review fix (choice46b) + choice46c (decisions #51; S512: GAM bears no charge
 * burden, every dollar is recovered from whoever it went to) — what the
 * landlord's paid-ahead money screen (services/paidAheadChoice) did with money
 * paid ahead whose funding charge is now disputed or returned. None of it can
 * be undone like a bill's spend (there is no bill to reopen, and the choice
 * stands), so each is recovered from whoever the money reached, up to
 * `budgetCents`, in this order:
 *   1. a refund that had not gone out yet (failed, or still sending): GAM
 *      still held that money, and the dispute took it — it already went back
 *      to the tenant that way. The part is marked PAID_AHEAD_PART_TAKEN_BACK:
 *      never sent, never handed back in cash, nothing left to do. When the
 *      dispute covers only some of it, only that much is marked: the rest is
 *      split onto a new part (PAID_AHEAD_PART_CANNOT_GO) offered as cash.
 *      Each part is read under its own lock (lockRefundParts), so a send or
 *      a cash press in flight finishes first. A refund that went out but
 *      could not be recorded (refundWentOutUnrecorded) is one that went out.
 *   2. a refund that went out — to the card or bank, or in cash at the desk
 *      instead — newest first: the tenant got that money twice, so it is a
 *      balance they owe again (a pending OTHERFEE charge on the lease, keyed in
 *      import_extra_data so it is written once): owed to GAM for a card or
 *      bank refund of money GAM held (GAM paid it out), to the landlord for
 *      cash they handed back; the card fee given back with it is owed to the
 *      landlord (their payout gave it back), once the refund itself is
 *      covered. Cash handed back instead of a card or bank refund of money GAM
 *      held also had what GAM held released to the landlord ('cash-part:'):
 *      that is charged back to them exactly like a Keep it release, once
 *      (choiceNetSourceId keyed by the cash part). A release not written yet
 *      (it is written after the press commits) is written here first, so the
 *      two lines always meet and a later release never pays twice.
 *   3. "Keep it" spends, newest first: the landlord is charged it back, a
 *      negative 'dispute' payout line per spend, once (choiceNetSourceId).
 *      Money GAM had not paid out yet is simply never paid out.
 * Choice46d (review): the card fee given back with a refund is the tenant's
 * to get back too (#38 Q4), so a dispute covers a refund's money first, then
 * its fee — but only as much of the fee as disputes of the charge took beyond
 * its money (a bank return, or a whole take-back with no dispute on file,
 * took all of it). So a dispute between the refund and the refund plus its
 * fee owes (or marks) only that part of the fee; the rest is still theirs.
 * GAM releases for cash handed back only what it still holds
 * (cashPartReleaseSql), and charges back no more than it released.
 * GAM is told once per event that touched any of it (an admin notice written
 * in this transaction, so a rolled-back event tells nobody). "Leave it as their
 * credit" spends nothing — the money stays on the credit, so the unspent
 * take-back drains it. Returns the cents covered.
 */
async function recoverChoiceMoney(
  client: PoolClient, creditId: string, budgetCents: number, remittanceId: string, opts: { noFeeGuess?: boolean } = {},
): Promise<{
  cents: number
  netted: Array<{ useId: string; amount: number; cashPartId?: string }>
  owed: NonNullable<ClawbackResult['refundsOwed']>
  notSent: NonNullable<ClawbackResult['refundsNotSent']>
  stayLeft: NonNullable<ClawbackResult['stayRefundsLeft']>
}> {
  const out = { cents: 0, netted: [] as Array<{ useId: string; amount: number; cashPartId?: string }>,
                owed: [] as NonNullable<ClawbackResult['refundsOwed']>, notSent: [] as NonNullable<ClawbackResult['refundsNotSent']>,
                stayLeft: [] as NonNullable<ClawbackResult['stayRefundsLeft']> }
  if (!(budgetCents > 0)) return out
  const head = (await client.query<{ tenant_id: string; pi: string | null; method: string | null; money: string | null; disputed: string; fee_used: string }>(
    `SELECT c.tenant_id, rm.stripe_payment_intent_id AS pi, rm.payment_method AS method, rm.amount::text AS money,
            -- Choice46d (review): what disputes of this charge took beyond its
            -- money is its card fee (paymentReversal's feeTaken) …
            COALESCE((SELECT SUM(d.amount) FROM connect_disputes d
                       WHERE d.stripe_payment_intent_id = rm.stripe_payment_intent_id AND d.status IN (${DISPUTE_TAKEN_SQL})), 0)::text AS disputed,
            -- … less what of it the card fees given back with this screen's
            -- refunds already stand for: owed again, or marked as covered.
            (COALESCE((SELECT SUM(x.amount) FROM payments x
                        WHERE x.import_extra_data->>'charge' = COALESCE(rm.stripe_payment_intent_id, $2::text)
                          AND x.import_extra_data->>'owed' = 'card_fee' AND x.status <> 'voided'), 0)
             -- (a refund's marked parts carry its money first, then its fee:
             -- what they add up to beyond the refund spend is fee — markTakenBack)
             + COALESCE((SELECT SUM(GREATEST(0, t.taken - t.use_amt)) FROM (
                  SELECT u.amount AS use_amt,
                         (WITH RECURSIVE fch AS (
                            SELECT q.id FROM stay_refund_parts q WHERE q.id = u.refund_part_id
                            UNION ALL
                            SELECT n.id FROM fch JOIN stay_refund_parts n ON n.replaces_part_id = fch.id)
                          SELECT COALESCE(SUM(q.amount), 0) FROM fch JOIN stay_refund_parts q ON q.id = fch.id
                           WHERE q.status = 'failed' AND q.failure = $3) AS taken
                    FROM credit_uses u JOIN stay_refund_parts rp0 ON rp0.id = u.refund_part_id
                   WHERE rp0.stripe_payment_intent_id = rm.stripe_payment_intent_id AND rp0.paid_ahead_choice_id IS NOT NULL
                     AND u.status = 'applied') t), 0))::text AS fee_used
       FROM lease_prepaid_credits c LEFT JOIN tenant_remittances rm ON rm.id = $2
      WHERE c.id = $1`, [creditId, remittanceId, PAID_AHEAD_PART_TAKEN_BACK])).rows[0]
  if (!head) return out
  const chargeKey = head.pi ?? remittanceId
  const byBank = head.method === 'ach'
  // Choice46d (review): the card fee given back with a refund is the tenant's
  // too (#38 Q4), so what a dispute covered of it is owed again (or, for a
  // refund not sent, marked as given back) — but only what the dispute
  // really took of the fee. `budgetCents` is the charge's MONEY the event
  // took (paymentReversal's moneyTaken); what card disputes on file took
  // beyond the charge's money is its fee (paymentReversal's feeTaken). A
  // bank return takes all of it, and so does a whole take-back with no
  // dispute on file. (A dispute that covers the credit's money is handled as
  // a whole take-back — budgetCents is then unlimited — so the fee is read
  // from the dispute itself, never from the budget.)
  const disputedCents = toCents(head.disputed)
  // Choice46d fix pass 3: a later dispute of an already-disputed charge
  // (followUpDisputeOf) bills no card fee by guessing — GAM is told instead.
  let feeBudget = opts.noFeeGuess ? 0
    : byBank ? Number.POSITIVE_INFINITY
    : disputedCents > 0 ? Math.max(0, disputedCents - toCents(head.money) - toCents(head.fee_used))
    : Number.isFinite(budgetCents) ? 0 : Number.POSITIVE_INFINITY

  // Choice46c (review): every card or bank refund of this credit's money
  // that has not gone out is taken under its own lock — the one a send
  // (earlyCheckOut.runCardPart) and a cash press (givePartBackInCash) hold —
  // BEFORE its state is read, so a send or a cash press in flight finishes
  // first and is then seen as what it became (sent, or handed back in cash),
  // never marked "not sent" under it.
  const unsent = (await client.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT p.id FROM credit_uses u JOIN stay_refund_parts p ON p.id = u.refund_part_id
        WHERE u.prepaid_credit_id = $1 AND u.status = 'applied' AND u.refund_part_id IS NOT NULL
       UNION
       SELECT n.id FROM chain ch JOIN stay_refund_parts n ON n.replaces_part_id = ch.id
     )
     SELECT p.id FROM chain ch JOIN stay_refund_parts p ON p.id = ch.id
      WHERE p.kind IN ('card', 'bank') AND p.status IN ('pending', 'failed') AND p.reversed_at IS NULL
      ORDER BY p.id`, [creditId])).rows.map((r) => r.id)
  await lockRefundParts(client, unsent)

  const items: ChoiceItem[] = []
  // "Keep it" spends.
  for (const u of (await client.query<{
    id: string; amount: string; applied_at: Date; landlord_id: string; lease_id: string; unit_id: string | null
    unit_number: string | null; timezone: string | null; gam_held: boolean; released: boolean; netted: string
  }>(
    `SELECT u.id, u.amount::text AS amount, u.applied_at, pc.landlord_id, pc.lease_id, l.unit_id, un.unit_number, pr.timezone,
            v.gam_held,
            EXISTS (SELECT 1 FROM held_payout_items h WHERE h.source_type = 'prepaid_draw' AND h.source_id = u.id::text) AS released,
            COALESCE((SELECT SUM(-h.amount) FROM held_payout_items h
                       WHERE h.source_type = 'dispute'
                         AND h.source_id LIKE 'owner\\_share\\_returned:paid-ahead-choice:%:' || u.id::text), 0)::text AS netted
       FROM credit_uses u
       JOIN v_credit_uses v ON v.id = u.id
       JOIN paid_ahead_choices pc ON pc.id = u.paid_ahead_choice_id
       JOIN leases l ON l.id = pc.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
      WHERE u.prepaid_credit_id = $1 AND u.status = 'applied' AND u.paid_ahead_choice_id IS NOT NULL`, [creditId])).rows) {
    items.push({
      kind: 'keep', useId: u.id, cents: toCents(u.amount), recovered: toCents(u.netted), gamHeld: u.gam_held, released: u.released,
      partId: null, partToward: 0, onChoice: true, refundAmount: 0, stayBefore: 0, feeBack: 0, feeOwed: 0, releasedCents: 0, releaseCap: 0,
      partKind: null, refundedAt: null, at: u.applied_at,
      landlordId: u.landlord_id, leaseId: u.lease_id, unitId: u.unit_id, unitNumber: u.unit_number, tz: u.timezone,
    })
  }
  // Choice46d: what earlier events already covered of each stay refund (never marked on the part).
  const stayCovered = await stayRefundCoveredCents(client, creditId)
  // Refund spends, each with the part that stands for it now (a card refund
  // Stripe sent back, or one handed back in cash instead, is replaced by a
  // new part on the same spend: the live end of that chain).
  for (const r of (await client.query<{
    use_id: string; amount: string; applied_at: Date; gam_held: boolean; part_id: string; kind: string; status: string
    failure: string | null; toward: string; fee_back: string; part_amount: string; refunded_at: Date | null; replaces_part_id: string | null
    landlord_id: string; lease_id: string; unit_id: string | null; unit_number: string | null; timezone: string | null
    released: boolean; owed_refund: string; fee_owed: string; taken_back: string; on_choice: boolean
    attempts: number; part_pi: string | null; released_amt: string | null; release_cap: string | null
  }>(
    `WITH RECURSIVE chain AS (
       SELECT u.id AS use_id, p.id AS part_id, 0 AS depth
         FROM credit_uses u JOIN stay_refund_parts p ON p.id = u.refund_part_id
        WHERE u.prepaid_credit_id = $1 AND u.status = 'applied' AND u.refund_part_id IS NOT NULL
       UNION ALL
       SELECT ch.use_id, n.id, ch.depth + 1
         FROM chain ch JOIN stay_refund_parts n ON n.replaces_part_id = ch.part_id
     ),
     live AS (
       SELECT DISTINCT ON (ch.use_id) ch.use_id, ch.part_id
         FROM chain ch JOIN stay_refund_parts p ON p.id = ch.part_id
        WHERE p.reversed_at IS NULL AND p.status <> 'replaced'
        ORDER BY ch.use_id, ch.depth DESC
     )
     SELECT u.id AS use_id, u.amount::text AS amount, u.applied_at, v.gam_held,
            p.id AS part_id, p.kind, p.status, p.failure, p.toward_amount::text AS toward, p.card_fee_back::text AS fee_back,
            p.amount::text AS part_amount, p.refunded_at, p.replaces_part_id,
            l.landlord_id, l.id AS lease_id, l.unit_id, un.unit_number, pr.timezone,
            EXISTS (SELECT 1 FROM held_payout_items h WHERE h.source_type = 'prepaid_draw' AND h.source_id = 'cash-part:' || p.id::text) AS released,
            (SELECT h.amount::text FROM held_payout_items h WHERE h.source_type = 'prepaid_draw' AND h.source_id = 'cash-part:' || p.id::text) AS released_amt,
            CASE WHEN p.kind = 'cash' AND p.replaces_part_id IS NOT NULL THEN ${cashPartReleaseSql('p')}::text END AS release_cap,
            COALESCE((SELECT SUM(x.amount) FROM payments x
                       WHERE x.import_extra_data->>'${OWED_USE_KEY}' = u.id::text AND x.import_extra_data->>'owed' = 'refund'
                         AND x.status <> 'voided'), 0)::text AS owed_refund,
            COALESCE((SELECT SUM(x.amount) FROM payments x
                       WHERE x.import_extra_data->>'${OWED_USE_KEY}' = u.id::text AND x.import_extra_data->>'owed' = 'card_fee'
                         AND x.status <> 'voided'), 0)::text AS fee_owed,
            -- What an earlier dispute or return already took back of this
            -- spend's refund before it went out (the parts it marked: a part
            -- it split keeps only what it covered).
            -- Choice46d: the marked parts' whole amount (money first, then
            -- card fee: markTakenBack) — its money is read off it below.
            (SELECT COALESCE(SUM(tp.amount), 0) FROM chain tc JOIN stay_refund_parts tp ON tp.id = tc.part_id
              WHERE tc.use_id = lv.use_id AND tp.status = 'failed' AND tp.failure = $2)::text AS taken_back,
            (p.paid_ahead_choice_id IS NOT NULL) AS on_choice, p.attempts, p.stripe_payment_intent_id AS part_pi
       FROM live lv
       JOIN credit_uses u ON u.id = lv.use_id
       JOIN v_credit_uses v ON v.id = u.id
       JOIN stay_refund_parts p ON p.id = lv.part_id
       JOIN lease_prepaid_credits c ON c.id = u.prepaid_credit_id
       LEFT JOIN paid_ahead_choices pc ON pc.id = p.paid_ahead_choice_id
       LEFT JOIN stay_checkout_decisions sd ON sd.id = p.decision_id
       JOIN leases l ON l.id = COALESCE(pc.lease_id, sd.lease_id, c.lease_id)
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id`, [creditId, PAID_AHEAD_PART_TAKEN_BACK])).rows) {
    const stripe = r.kind === 'card' || r.kind === 'bank'
    // A refund that went out at Stripe but could not be recorded reached the
    // tenant: it is a refund that went out, never one "not sent".
    const wentOut = stripe && r.status === 'failed' && refundWentOutUnrecorded(r.failure)
    let kind: ChoiceItem['kind'] | null =
      wentOut ? 'refund_out'
      : stripe && (r.status === 'failed' || r.status === 'pending') ? 'not_sent'
      : stripe && r.status === 'refunded' ? 'refund_out'
      : r.kind === 'cash' && r.status === 'handed_back' && r.replaces_part_id ? 'cash_instead'
      : r.status === 'handed_back' || (r.kind === 'charge' && r.status === 'refunded') ? 'refund_out'
      : null    // credit back to credit moved no money out
    if (!kind) continue
    // Review fix (choice46c pass 3): a refund that was tried before (attempts
    // > 0) may have gone out at Stripe with its answer lost — a timeout, or a
    // crash after the refund was made. Under its lock (taken above), Stripe is
    // asked first, the same way "Give it back in cash instead" asks: a refund
    // Stripe made is one that went out (the tenant owes it again, #51), and
    // the part says so, so Try again only records it. Stripe out of reach:
    // nothing is decided now — Stripe delivers the event again.
    if (kind === 'not_sent' && r.attempts > 0 && r.part_pi && !definitelyNotSent(r.failure)) {
      const sentAtStripe = await refundWentOutAtStripe(r.part_id, r.part_pi)
      if (sentAtStripe === 'unreachable') {
        throw new DisputeRetryLater('stripe_unreachable',
          'GAM could not reach Stripe to check whether a refund of this money already went out, so nothing was recorded yet — try again in a moment.')
      }
      if (sentAtStripe) {
        const to = r.on_choice && r.kind === 'bank' ? 'their bank' : 'the card'
        await client.query(
          `UPDATE stay_refund_parts SET status = 'failed', failure = $2, refunded_at = NULL
            WHERE id = $1 AND status IN ('pending', 'failed')`,
          [r.part_id, `The refund went to ${to}, but GAM could not finish recording it — press Try again.`])
        kind = 'refund_out'
      }
    }
    // Review fix (choice46c pass 3): a stay's own early check-out refund (not
    // this screen's) that did not go out is NOT marked: the stay's screen
    // does not know the mark yet and would still offer Try again and cash for
    // it. It is left as it was, not counted as covered, and GAM is told
    // plainly (below) — never quietly called done.
    // Choice46d (review): it still goes through the budget below — only what
    // the event really took of it is covered (a partial dispute may cover
    // none or part of it), never all of it on sight.
    // What earlier events took of this refund's MONEY (the marked parts carry the refund first, then its card fee).
    const takenMoney = Math.min(toCents(r.amount), toCents(r.taken_back))
    if (kind === 'not_sent' && !r.on_choice) {
      const before = stayCovered.get(r.part_id) ?? 0
      const left = Math.max(0, toCents(r.toward) - takenMoney - before)
      if (left > 0) {
        items.push({
          kind, useId: r.use_id, cents: left, recovered: 0, gamHeld: r.gam_held, released: false, partId: r.part_id,
          partToward: left, onChoice: false, refundAmount: toCents(r.part_amount), stayBefore: before,
          feeBack: toCents(r.fee_back), feeOwed: 0, releasedCents: 0, releaseCap: 0, partKind: r.kind, refundedAt: null, at: r.applied_at,
          landlordId: r.landlord_id, leaseId: r.lease_id, unitId: r.unit_id, unitNumber: r.unit_number, tz: r.timezone,
        })
      }
      continue
    }
    items.push({
      kind, useId: r.use_id, cents: toCents(r.amount),
      // What an earlier event covered: refunds it marked or split off before
      // they went out, and (a refund that went out) what the tenant owes again.
      recovered: takenMoney + (kind === 'not_sent' ? 0 : toCents(r.owed_refund)),
      gamHeld: r.gam_held, released: r.released, partId: r.part_id, partToward: toCents(r.toward), onChoice: r.on_choice,
      refundAmount: toCents(r.part_amount), stayBefore: 0, feeBack: toCents(r.fee_back), feeOwed: toCents(r.fee_owed),
      releasedCents: toCents(r.released_amt), releaseCap: toCents(r.release_cap),
      partKind: r.kind, refundedAt: r.refunded_at, at: r.refunded_at ?? r.applied_at,
      landlordId: r.landlord_id, leaseId: r.lease_id, unitId: r.unit_id, unitNumber: r.unit_number, tz: r.timezone,
    })
  }
  if (!items.length) return out

  const newest = (a: ChoiceItem, b: ChoiceItem) => b.at.getTime() - a.at.getTime() || b.useId.localeCompare(a.useId)
  const order = [
    ...items.filter(i => i.kind === 'not_sent').sort(newest),
    ...items.filter(i => i.kind === 'refund_out' || i.kind === 'cash_instead').sort(newest),
    ...items.filter(i => i.kind === 'keep').sort(newest),
  ]
  const by = byBank ? 'returned by their bank' : 'disputed with their card company'
  const dayOf = (d: Date | null, tz: string | null) => (d ?? new Date()).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', timeZone: tz || 'America/Phoenix' })
  const told: string[] = []
  const { recordHeldItem } = await import('./heldPayouts')

  /** A balance the tenant owes again for this refund (written once per refund spend and kind). */
  const owe = async (i: ChoiceItem, what: 'refund' | 'card_fee', cents: number, owedTo: 'gam' | 'landlord'): Promise<void> => {
    if (cents <= 0 || !i.partId) return
    const where = i.unitNumber ?? 'their space'
    const day = dayOf(i.refundedAt, i.tz)
    const notes = what === 'refund'
      ? `Refund of money paid ahead on ${where} (${day}) — owed again: the payment it came from was ${by}`
      : `Card fee given back with the ${day} refund on ${where} — owed again: the payment it came from was ${by}`
    const row = (await client.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             notes, revenue_owner, import_extra_data)
       VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'OTHERFEE', (NOW() AT TIME ZONE COALESCE($6::text, 'America/Phoenix'))::date,
               $7, $8, $9::jsonb)
       RETURNING id`,
      [i.unitId, i.leaseId, head.tenant_id, i.landlordId, toDollars(cents).toFixed(2), i.tz, notes, owedTo,
       JSON.stringify({ [OWED_USE_KEY]: i.useId, owed: what, refund_part_id: i.partId, charge: chargeKey })])).rows[0]
    out.owed.push({ useId: i.useId, partId: i.partId, owedTo, what, amount: toDollars(cents), paymentId: row.id })
    told.push(what === 'refund'
      ? `$${toDollars(cents).toFixed(2)} of the ${day} refund on ${where} is owed again by the tenant, to ${owedTo === 'gam' ? 'GAM' : 'the landlord'}.`
      : cents < i.feeBack
        ? `$${toDollars(cents).toFixed(2)} of the $${toDollars(i.feeBack).toFixed(2)} card fee given back with that refund is owed again by the tenant, to the landlord (the ${byBank ? 'return' : 'dispute'} covered no more of it).`
        : `The $${toDollars(cents).toFixed(2)} card fee given back with that refund is owed again by the tenant, to the landlord.`)
  }

  for (const i of order) {
    if (budgetCents - out.cents <= 0) break
    const where = i.unitNumber ?? 'their space'
    const event = byBank ? 'return' : 'dispute'
    if (i.kind === 'not_sent' && i.onChoice) {
      // Review fix (choice46c): only the part the dispute covers is marked.
      // When it covers less than the whole refund, the refund is split: what
      // the dispute took back is marked (PAID_AHEAD_PART_TAKEN_BACK, never
      // sent), and the rest — still the tenant's money — goes on a new part in
      // its place (replaces_part_id), failed in plain words: the payment takes
      // no refund, so it is offered "Give it back in cash instead", is on the
      // owner's to-do, and GAM releases only what it still holds of it when it
      // is handed back (cashPartReleaseSql). Choice46d: its money first, then
      // the card fee given back with it — only what the event took of the fee.
      const moneyLeft = Math.max(0, Math.min(i.cents - i.recovered, i.partToward))
      const moneyTake = Math.min(budgetCents - out.cents, moneyLeft)
      const fee = moneyTake >= moneyLeft ? Math.max(0, Math.min(i.refundAmount - moneyLeft, feeBudget)) : 0
      if (moneyTake + fee <= 0) continue
      const marked = await markTakenBack(client, i.partId!, moneyTake + fee, PAID_AHEAD_PART_CANNOT_GO)
      if (!marked) continue
      feeBudget -= fee
      out.cents += moneyTake
      out.notSent.push({ useId: i.useId, partId: i.partId!, amount: toDollars(moneyTake) })
      told.push(marked.rest > 0
        ? `A refund on ${where} had not gone out: the ${event} took $${toDollars(moneyTake + fee).toFixed(2)} of that money back to the tenant, so that part will never be sent. ` +
          `The other $${toDollars(marked.rest).toFixed(2)} of the refund is still theirs and cannot go back ${byBank ? 'to the bank' : 'to the card'} either — the landlord's screen offers to give it back in cash.`
        : `A $${toDollars(moneyTake + fee).toFixed(2)} refund on ${where} had not gone out: the ${event} took that money back to the tenant, so it will never be sent.`)
      continue
    }
    // A stay's refund not sent yet is covered only up to what its live part
    // still stands for (an earlier event may have covered part of it).
    const take = Math.min(budgetCents - out.cents, i.cents - i.recovered, i.kind === 'not_sent' ? i.partToward : Number.POSITIVE_INFINITY)
    // Choice46d: a later event that takes only more of the card fee (its
    // refund was already owed again in full) still owes that much of the fee.
    const feeOnly = (i.kind === 'refund_out' || i.kind === 'cash_instead') && take <= 0
      && i.recovered >= i.cents && i.feeBack > i.feeOwed && feeBudget > 0
    if (take <= 0 && !feeOnly) continue
    if (i.kind === 'not_sent' && !i.onChoice) {
      // Choice46d: a stay's own refund is never marked (its screen does not
      // know the mark); what the event took of it is covered and said exactly.
      out.cents += take
      const covered = i.stayBefore + take
      out.stayLeft.push({ useId: i.useId, partId: i.partId!, amount: toDollars(take), refund: toDollars(i.refundAmount),
                          stillTheirs: toDollars(Math.max(0, i.refundAmount - covered)) })
      continue
    }
    out.cents += take
    if (i.kind === 'refund_out' || i.kind === 'cash_instead') {
      // Review fix (choice46c): what GAM held for cash handed back instead is
      // released to the landlord after the press commits (paidAheadChoice
      // releaseCashInsteadHeld) — a crash, or this event landing first, can
      // leave it unwritten. It is written HERE first (idempotent, same key),
      // so the charge-back below always nets a release that exists, and a
      // later release can never pay the landlord money the dispute took.
      // Choice46d (review): never more than GAM still holds of that refund
      // (cashPartReleaseSql) — nothing for cash handed back for money a
      // dispute had already given back.
      if (take > 0 && i.kind === 'cash_instead' && i.gamHeld && !i.released && i.onChoice && i.releaseCap > 0) {
        await recordHeldItem({
          landlordId: i.landlordId, sourceType: 'prepaid_draw', sourceId: `cash-part:${i.partId}`, amount: toDollars(i.releaseCap),
          description: cashPartReleaseWords(i.unitNumber),
        }, client)
        i.released = true
        i.releasedCents = i.releaseCap
      }
      // Charged back no more than GAM paid them for it.
      const back = Math.min(take, i.releasedCents)
      if (i.kind === 'cash_instead' && i.gamHeld && i.released && back > 0) {
        const wrote = await recordHeldItem({
          landlordId: i.landlordId, sourceType: 'dispute', sourceId: choiceNetSourceId(chargeKey, i.partId!), amount: -toDollars(back),
          description: `${i.unitNumber ? `${i.unitNumber}: ` : ''}money GAM paid you for a refund you handed back in cash was taken back by ${byBank ? 'their bank (a returned payment)' : 'the card company (a dispute)'} — it comes off your next payout; the tenant owes you the refund again`,
        }, client)
        if (wrote) {
          out.netted.push({ useId: i.useId, amount: toDollars(back), cashPartId: i.partId! })
          told.push(`The $${toDollars(back).toFixed(2)} GAM paid the landlord for cash handed back on ${where} comes off their next payout.`)
        }
      }
      const owedTo: 'gam' | 'landlord' = i.kind === 'refund_out' && (i.partKind === 'card' || i.partKind === 'bank') && i.gamHeld ? 'gam' : 'landlord'
      if (take > 0) await owe(i, 'refund', take, owedTo)
      // The card fee given back with it: the landlord's payout (or drawer)
      // paid it, once the refund itself is covered — choice46d (review): only
      // as much of it as the event took of the fee (a dispute between the
      // refund and the refund plus its fee owes only part of the fee). Beyond
      // `clawed`, which counts the charge's money.
      if (i.recovered + take >= i.cents && i.feeBack > i.feeOwed) {
        const fee = Math.min(i.feeBack - i.feeOwed, feeBudget)
        if (fee > 0) {
          feeBudget -= fee
          await owe(i, 'card_fee', fee, 'landlord')
        }
      }
      continue
    }
    // Keep it.
    if (i.gamHeld && !i.released) continue
    const wrote = await recordHeldItem({
      landlordId: i.landlordId, sourceType: 'dispute', sourceId: choiceNetSourceId(chargeKey, i.useId), amount: -toDollars(take),
      description: `${i.unitNumber ? `${i.unitNumber}: ` : ''}money paid ahead that you kept was taken back by ${byBank ? 'their bank (a returned payment)' : 'the card company (a dispute)'} — it comes off your next payout`,
    }, client)
    if (wrote) {
      out.netted.push({ useId: i.useId, amount: toDollars(take) })
      told.push(`The $${toDollars(take).toFixed(2)} the landlord kept on ${where} comes off their next payout.`)
    }
  }
  for (const s2 of out.stayLeft) {
    const it2 = (await client.query<{ unit_number: string | null; guest_name: string | null }>(
      `SELECT un.unit_number, b.guest_name FROM stay_refund_parts p
         LEFT JOIN unit_bookings b ON b.id = p.booking_id LEFT JOIN units un ON un.id = b.unit_id
        WHERE p.id = $1`, [s2.partId])).rows[0]
    const whose = `${it2?.guest_name ? `${it2.guest_name}'s` : 'a'} early check-out${it2?.unit_number ? ` on ${it2.unit_number}` : ''}`
    const event = byBank ? 'return' : 'dispute'
    if (s2.stillTheirs <= 0.005) {
      told.push(`A $${s2.refund.toFixed(2)} refund from ${whose} had not gone out: ` +
        `the ${event} already gave that money back to the tenant. It was left as it was, so the stay still shows Try again and "Give it back in cash instead" for it — ` +
        `do NOT press either (the tenant would get it twice, and GAM would pay it). Stop it by hand (refund part ${s2.partId}).`)
    } else {
      // Choice46d (review): a partial dispute is exact about what is still owed.
      const wentBack = toDollars(toCents(s2.refund) - toCents(s2.stillTheirs))
      told.push(`A $${s2.refund.toFixed(2)} refund from ${whose} had not gone out: ` +
        `$${wentBack.toFixed(2)} of it went back to the tenant through the ${event}, so only the other $${s2.stillTheirs.toFixed(2)} is still theirs. ` +
        `The stay still shows Try again and "Give it back in cash instead" for the whole $${s2.refund.toFixed(2)} — do NOT press either for the full amount ` +
        `(the tenant would get $${wentBack.toFixed(2)} twice, and GAM would pay it). Send or hand back only the $${s2.stillTheirs.toFixed(2)}, by hand (refund part ${s2.partId}).`)
    }
  }
  if (out.netted.length || out.owed.length || out.notSent.length || out.stayLeft.length) {
    logger.warn({ creditId, remittanceId, netted: out.netted, owed: out.owed, notSent: out.notSent, stayLeft: out.stayLeft },
      '[credit-use] money the paid-ahead money screen had decided was taken back by a dispute or return')
  }
  if (told.length) {
    // In this transaction: a rolled-back event tells nobody.
    await client.query(
      `INSERT INTO admin_notifications (severity, category, title, body, context) VALUES ('warn', $1, $2, $3, $4)`,
      ['paid_ahead_choice_taken_back',
       `A ${byBank ? 'bank return' : 'card dispute'} took back money paid ahead that the landlord had already decided on (credit ${creditId})`,
       `The payment that brought this money in was ${by} (${chargeKey}) after ${out.stayLeft.length && !items.length ? 'a refund of it was decided' : 'the landlord\'s paid-ahead money screen decided it'}. ${told.join(' ')} ` +
       (out.stayLeft.length ? 'Nothing of it is absorbed by GAM, as long as that stay refund is fixed by hand as said.' : 'Nothing of it is absorbed by GAM.'),
       JSON.stringify({ credit_id: creditId, charge: chargeKey, netted: out.netted, owed: out.owed, not_sent: out.notSent, stay_left: out.stayLeft })])
  }
  return out
}

/**
 * Choice46d (review, decisions #51): a refund from the paid-ahead money screen
 * that went out, was then counted by a dispute or bank return of the payment it
 * came from as money the tenant got twice (an "owed again" charge — the refund,
 * and the card fee given back with it), and only THEN came back failed at
 * Stripe (earlyCheckOut.stripeRefundFailed: the part is reversed and a new
 * failed part takes its place). The tenant never got that refund, so:
 *   - every "owed again" charge for that spend still owed (pending or failed,
 *     nothing moving, no credit on it) is voided as a record (decisions #48.5)
 *     — the tenant no longer owes it;
 *   - what those refund charges stood for is what the dispute already gave
 *     back of the new part: that much of it is marked PAID_AHEAD_PART_TAKEN_BACK
 *     (never sent, never handed back in cash); any rest of it is still the
 *     tenant's and is split onto its own part, offered as cash (the payment
 *     takes no refund).
 * An "owed again" charge the tenant already paid is left alone: then the
 * whole new part is still theirs. Each part is taken under its own lock (a
 * part being sent at that moment is skipped and handled on the next look).
 * Idempotent: once voided nothing is left to undo. `where`: one lease's
 * choices (the screen), one company's (its to-do), or one part that just
 * failed (none: all). earlyCheckOut.stripeRefundFailed should call it with
 * the new part once it commits; the screen and the to-do also run it, so a
 * missed call is caught the next time either is opened.
 * Choice46d fix pass 3: `opts.strict` rethrows a part it could not lock
 * (DisputeRetryLater) instead of skipping it, and `opts.lockWait` shortens the
 * wait — for the cash press, which runs this for its own part under its own
 * key (paidAheadCashPressKey) before it checks anything.
 * Returns how many spends were undone.
 */
export async function undoOwedAgainForFailedRefunds(
  client: PoolClient, where: { leaseId?: string | null; landlordIds?: readonly string[] | null; partId?: string | null } = {},
  opts: { strict?: boolean; lockWait?: string } = {},
): Promise<number> {
  const found = (await client.query<{ use_id: string; live_id: string; kind: string; status: string; failure: string | null; came_back: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT u.id AS use_id, p.id AS part_id, 0 AS depth
         FROM credit_uses u
         JOIN stay_refund_parts p ON p.id = u.refund_part_id
         JOIN paid_ahead_choices pc ON pc.id = p.paid_ahead_choice_id
        WHERE u.status = 'applied'
          AND ($1::uuid IS NULL OR pc.lease_id = $1::uuid)
          AND ($2::uuid[] IS NULL OR pc.landlord_id = ANY($2::uuid[]))
          AND EXISTS (SELECT 1 FROM payments x
                       WHERE x.import_extra_data->>'${OWED_USE_KEY}' = u.id::text
                         AND x.import_extra_data->>'owed' = 'refund' AND x.status IN ('pending','failed'))
       UNION ALL
       SELECT ch.use_id, n.id, ch.depth + 1 FROM chain ch JOIN stay_refund_parts n ON n.replaces_part_id = ch.part_id
     )
     SELECT DISTINCT ON (ch.use_id) ch.use_id, p.id AS live_id, p.kind, p.status, p.failure,
            EXISTS (SELECT 1 FROM chain c2 JOIN stay_refund_parts q ON q.id = c2.part_id
                     WHERE c2.use_id = ch.use_id AND q.reversed_at IS NOT NULL) AS came_back
       FROM chain ch JOIN stay_refund_parts p ON p.id = ch.part_id
      WHERE p.reversed_at IS NULL AND p.status <> 'replaced'
      ORDER BY ch.use_id, ch.depth DESC`, [where.leaseId ?? null, where.landlordIds ? [...where.landlordIds] : null])).rows
    .filter(r => r.came_back && (r.kind === 'card' || r.kind === 'bank') && r.status === 'failed'
      && r.failure !== PAID_AHEAD_PART_TAKEN_BACK && !refundWentOutUnrecorded(r.failure)
      && (!where.partId || r.live_id === where.partId))
  let undone = 0
  for (const f of found) {
    await client.query('SAVEPOINT undo_owed_again')
    try {
      await lockRefundParts(client, [f.live_id], opts.lockWait)
      const part = (await client.query<{ status: string; failure: string | null; toward: string; fee_back: string; reversed_at: Date | null }>(
        `SELECT status, failure, toward_amount::text AS toward, card_fee_back::text AS fee_back, reversed_at
           FROM stay_refund_parts WHERE id = $1 FOR UPDATE`, [f.live_id])).rows[0]
      if (!part || part.status !== 'failed' || part.reversed_at || part.failure === PAID_AHEAD_PART_TAKEN_BACK
          || refundWentOutUnrecorded(part.failure)) {
        await client.query('RELEASE SAVEPOINT undo_owed_again')
        continue
      }
      const voided = (await client.query<{ what: string; amount: string }>(
        `UPDATE payments x
            SET status = 'voided', voided_at = NOW(),
                void_reason = 'The refund this stood for came back to GAM and never reached them, so they do not owe it again'
          WHERE x.import_extra_data->>'${OWED_USE_KEY}' = $1
            AND x.status IN ('pending','failed') AND (x.status = 'pending' OR x.next_retry_at IS NULL)
            AND (x.status = 'failed' OR x.stripe_payment_intent_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM credit_uses k WHERE k.payment_id = x.id AND k.status IN ('held','applied'))
          RETURNING x.import_extra_data->>'owed' AS what, x.amount::text AS amount`, [f.use_id])).rows
      // Choice46d (review): what the dispute gave back of this refund is what
      // those charges stood for — the refund AND the card fee given back with
      // it (a dispute between the two owed only part of the fee) — so that
      // much of the new part is marked as given back, and the rest of it,
      // card fee included, is still the tenant's (markTakenBack).
      const take = voided.filter(v => v.what === 'refund' || v.what === 'card_fee').reduce((a, v) => a + toCents(v.amount), 0)
      if (!voided.some(v => v.what === 'refund') || take <= 0) { await client.query('RELEASE SAVEPOINT undo_owed_again'); continue }
      const marked = await markTakenBack(client, f.live_id, take, PAID_AHEAD_PART_CANNOT_GO)
      if (!marked) { await client.query('RELEASE SAVEPOINT undo_owed_again'); continue }
      await client.query(
        `INSERT INTO admin_notifications (severity, category, title, body, context) VALUES ('info', $1, $2, $3, $4)`,
        ['paid_ahead_refund_owed_again_undone',
         'A refund counted as owed again came back failed — no longer owed',
         `A refund from the landlord's paid-ahead money screen went out, a dispute or bank return of the payment it came from then counted it as money the tenant got twice, ` +
         `and the refund has since come back failed at Stripe. The tenant never got it, so the ${voided.map(v => `$${Number(v.amount).toFixed(2)} ${v.what === 'refund' ? 'refund' : 'card fee'}`).join(' and ')} owed again ${voided.length > 1 ? 'were' : 'was'} voided, ` +
         `and $${toDollars(Math.min(take, toCents(part.toward) + toCents(part.fee_back))).toFixed(2)} of the new refund is marked as already given back by the dispute` +
         (marked.rest > 0 ? `; the other $${toDollars(marked.rest).toFixed(2)} is still theirs and is offered as cash on the landlord's screen.` : '.'),
         JSON.stringify({ use_id: f.use_id, part_id: f.live_id, voided, taken_back: toDollars(take) })])
      await client.query('RELEASE SAVEPOINT undo_owed_again')
      undone++
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT undo_owed_again').catch(() => {})
      await client.query('RELEASE SAVEPOINT undo_owed_again').catch(() => {})
      // Choice46d fix pass 3: `strict` (a cash press about to check this part)
      // never goes on past a part it could not lock — the press says to wait.
      if (isDisputeRetryLater(err) && !opts.strict) continue
      throw err
    }
  }
  return undone
}

/**
 * Choice46d fix pass 3: a later card dispute of a charge that already has one
 * on file, which takes the charge past its money (so part or all of it is
 * card fee). The dispute handler (paymentReversal) splits money from fee per
 * event, while this ledger reads every dispute of the charge together — the
 * two would disagree about which dollars are fee. Rather than guess, the
 * ledger takes no more than the charge's money not yet disputed, bills no card
 * fee to anyone for this event, and tells GAM once (per dispute) exactly what
 * it left to settle by hand. null: not such a dispute.
 */
interface FollowUpDispute {
  pi: string; disputeId: string; amount: number; moneyLeft: number; money: number; earlier: number
  /** Rows the charge paid itself (disputeClaimOnCredit's chargeRows): its bill-by-bill side tells GAM of the same fee part. */
  chargeRows: number
}
async function followUpDisputeOf(client: PoolClient, remittanceId: string): Promise<FollowUpDispute | null> {
  const r = (await client.query<{ pi: string | null; money: string; n: number; total: string; newest_id: string | null; newest_amt: string | null; newest_sid: string | null; charge_rows: number }>(
    `SELECT rm.stripe_payment_intent_id AS pi, rm.amount::text AS money,
            (SELECT COUNT(*)::int FROM connect_disputes d WHERE d.stripe_payment_intent_id = rm.stripe_payment_intent_id AND d.status IN (${DISPUTE_TAKEN_SQL})) AS n,
            (SELECT COALESCE(SUM(d.amount), 0)::text FROM connect_disputes d WHERE d.stripe_payment_intent_id = rm.stripe_payment_intent_id AND d.status IN (${DISPUTE_TAKEN_SQL})) AS total,
            nd.id AS newest_id, nd.amount::text AS newest_amt, nd.stripe_dispute_id AS newest_sid,
            (SELECT COUNT(*)::int FROM payments p
              WHERE p.stripe_payment_intent_id = rm.stripe_payment_intent_id AND p.manual_method IS NULL
                AND p.status IN ('settled','returned','paid_via_deposit')) AS charge_rows
       FROM tenant_remittances rm
       LEFT JOIN LATERAL (SELECT d.id, d.amount, d.stripe_dispute_id FROM connect_disputes d
                           WHERE d.stripe_payment_intent_id = rm.stripe_payment_intent_id AND d.status IN (${DISPUTE_TAKEN_SQL})
                           ORDER BY d.created_at DESC, d.id DESC LIMIT 1) nd ON TRUE
      WHERE rm.id = $1 AND rm.stripe_payment_intent_id IS NOT NULL AND rm.payment_method = 'card'`, [remittanceId])).rows[0]
  if (!r?.pi || r.n < 2 || !r.newest_id) return null
  const money = toCents(r.money)
  const total = toCents(r.total)
  if (total <= money) return null
  const amount = toCents(r.newest_amt)
  const earlier = total - amount
  return { pi: r.pi, disputeId: r.newest_sid ?? r.newest_id, amount, money, earlier, moneyLeft: Math.max(0, money - earlier), chargeRows: Number(r.charge_rows ?? 0) }
}

/**
 * GAM's notice for a follow-up dispute (followUpDisputeOf), in this
 * transaction, once per dispute. It always names the card-fee part as money to
 * settle by hand (choice46e fix pass 2): this ledger cannot see whether the
 * dispute handler's bill-by-bill side raises its own alert for the same
 * dollars ('payment_reversal_short', "… was not reopened on any bill" — it is
 * written after commit, and often not at all, e.g. when the charge's bills
 * were already all reopened by the first dispute), so deferring to it could
 * leave the money on nobody. When the charge also paid bills, the notice also
 * names the dispute's money this ledger did not take back as the bills' to
 * carry — to check they were reopened for it and settle by hand what was not
 * — and adds one line: if that alert names any of the same dollars for this
 * same dispute, it is the same money — settle it once.
 */
async function alertFollowUpDispute(client: PoolClient, f: FollowUpDispute, creditId: string, tookCents: number): Promise<void> {
  const seen = await client.query(
    `SELECT 1 FROM admin_notifications WHERE category = 'dispute_second_on_charge' AND context->>'dispute_id' = $1
     UNION ALL
     SELECT 1 FROM admin_notifications_archive WHERE category = 'dispute_second_on_charge' AND context->>'dispute_id' = $1
     LIMIT 1`, [f.disputeId])
  if ((seen.rowCount ?? 0) > 0) return
  const d = (c: number) => `$${toDollars(c).toFixed(2)}`
  const feePart = Math.max(0, f.amount - f.moneyLeft)
  const withBills = f.chargeRows > 0
  // This dispute's money this ledger did not take back: the bills' to carry
  // (paymentReversal reopens them after this call, out of this file's sight).
  const forBills = Math.max(0, Math.min(f.amount, f.moneyLeft) - tookCents)
  // Every follow-up dispute told here runs past the charge's money, so it has
  // a card-fee part (fix pass 2: within-money disputes are no longer told
  // here); the plain wording is only a fallback.
  const title = feePart > 0
    ? `A second card dispute on the same payment (${f.pi}) — settle ${d(feePart)} of card fee by hand`
    : `A second card dispute on the same payment (${f.pi}) — check that ${d(forBills)} was reopened on its bills`
  const split = feePart > 0
    ? (f.moneyLeft > 0 ? `so only ${d(f.moneyLeft)} of this dispute can be its money` : 'so none of this dispute can be its money') +
      ` and the other ${d(feePart)} is card fee. GAM does not guess how a second dispute splits between the tenant's money and the card fee: ` +
      `the paid-ahead money ledger took back ${d(tookCents)} of money for it and billed no card fee to the tenant or the landlord for it. ` +
      `Settle the ${d(feePart)} with the landlord and the tenant by hand — GAM does not absorb it.`
    : `so all of this dispute is its money. The paid-ahead money ledger took back ${d(tookCents)} of it.`
  await client.query(
    `INSERT INTO admin_notifications (severity, category, title, body, context) VALUES ('warn', $1, $2, $3, $4)`,
    ['dispute_second_on_charge',
     title,
     `A card dispute of ${d(f.amount)} (${f.disputeId}) came on a payment that already had ${d(f.earlier)} disputed. The payment's money was ${d(f.money)}, ` +
     split +
     (withBills && forBills > 0
       ? ` The other ${d(forBills)} of this dispute's money is for the bills this payment paid to carry: open them and check that ` +
         `${d(forBills)} was reopened on them — bill whatever of it was not to the tenant, or settle it with the landlord, by hand.`
       : '') +
     (withBills
       ? ` If an alert "… was not reopened on any bill (${f.pi})" for this same dispute (${f.disputeId}) names any of these same dollars, ` +
         'it is the same money — settle it once.'
       : ''),
     JSON.stringify({ dispute_id: f.disputeId, stripe_payment_intent_id: f.pi, credit_id: creditId, amount: toDollars(f.amount),
                      earlier: toDollars(f.earlier), money: toDollars(f.money), money_left: toDollars(f.moneyLeft), card_fee_part: toDollars(feePart),
                      taken: toDollars(tookCents), for_bills: toDollars(withBills ? forBills : 0), charge_rows: f.chargeRows,
                      may_match_bill_alert: withBills })])
}

/**
 * §3 Dispute: the money behind a remittance was disputed or returned, and that
 * remittance created paid-ahead money (source_remittance_id). Credit is never
 * given back, so nothing can be spent or paid out twice:
 *   1. every spend of that credit on a charge goes applied → reversed
 *      (funding_reversed); the charge reopens for that amount (caller);
 *   2. a 'reversal' use against the dispute's reversal record drains the rest.
 * `reversalId`: a record of this event (any row it reopened). A partial
 * dispute's handler cannot know the rows' share before this call, so it may
 * pass null: the record already written is used if there is one, else the
 * drain waits (drainPending) for takeBackDisputedCredit once the rows'
 * records exist.
 * With `maxAmount` (a partial dispute — pass the dispute's amount): the
 * surplus goes first, in this order — the unspent part; then money a charge in
 * flight set aside (claimed, not drained: heldClaimed); then what the
 * landlord's paid-ahead money screen did with it (recoverChoiceMoney); then
 * spends, newest first, whole uses only, until the next would pass the
 * amount. Only what is left of maxAmount after `clawed` comes off rows.
 * One level deep (risk 7): paid-ahead money funded by other paid-ahead money
 * does not exist. A credit already withdrawn (its charge, which paid no rows,
 * was taken back in full) still has its spends reversed; nothing is drained.
 * Writes nothing outside the caller's transaction (paymentReversal may roll
 * it back to a savepoint and run it again).
 */
export async function clawBackRemittanceCredit(
  client: PoolClient,
  remittanceId: string,
  reversalId: string | null,
  opts: { maxAmount?: number; wholeUsesUntilMet?: boolean } = {},
): Promise<ClawbackResult> {
  const empty: ClawbackResult = { creditId: null, reversed: [], drained: 0, drainUseId: null, drainPending: 0, stillHeld: [], heldClaimed: 0, clawed: 0 }
  const c = (await client.query<{ id: string; lease_id: string; amount_remaining: string; voided_at: Date | null }>(
    `SELECT id, lease_id, amount_remaining::text, voided_at FROM lease_prepaid_credits
      WHERE source_remittance_id = $1 FOR UPDATE`, [remittanceId])).rows[0]
  if (!c) return empty

  let budget = opts.maxAmount == null ? Number.POSITIVE_INFINITY : Math.max(0, toCents(opts.maxAmount))
  // Step 10: a partial claim is never taken twice. With the dispute on file
  // (connect_disputes), what it still claims on this credit — the disputed
  // amount less what already came off the charge's rows and this credit — caps
  // the budget, so a second call for the same dispute takes only what is left.
  if (opts.maxAmount != null) {
    const onFile = await client.query(
      `SELECT 1 FROM connect_disputes d JOIN tenant_remittances r ON r.stripe_payment_intent_id = d.stripe_payment_intent_id
        WHERE r.id = $1 AND d.status IN (${DISPUTE_TAKEN_SQL}) LIMIT 1`, [remittanceId])
    if ((onFile.rowCount ?? 0) > 0) {
      const k = await disputeClaimOnCredit(client, c.id)
      // What the paid-ahead money screen's money already covered (charged
      // back to the landlord, owed again by the tenant, never sent: review
      // fix choice46b, choice46c) is part of what the dispute already took.
      if (!k.full) budget = Math.min(budget, Math.max(0, toCents(k.claim) - await choiceRecoveredCents(client, c.id)))
    }
  }
  // Choice46d fix pass 3: a later dispute of a charge already disputed takes
  // no more than the charge's money not yet disputed, and no card fee is
  // guessed for it (followUpDisputeOf) — GAM is told the rest.
  const followUp = opts.maxAmount != null ? await followUpDisputeOf(client, remittanceId) : null
  if (followUp) budget = Math.min(budget, followUp.moneyLeft)
  // A withdrawn credit's money is already out of every balance: it counts as
  // taken, but no use can be written against it.
  const unspentTaken = Math.min(toCents(c.amount_remaining), budget)
  budget -= unspentTaken

  const stillHeld = (await client.query<{ id: string; payment_id: string | null; amount: string }>(
    `SELECT id, payment_id, amount::text FROM credit_uses WHERE prepaid_credit_id = $1 AND status = 'held' ORDER BY id`,
    [c.id])).rows.map(u => ({ useId: u.id, paymentId: u.payment_id, amount: Number(u.amount) }))
  const heldClaimed = Math.min(stillHeld.reduce((s, u) => s + toCents(u.amount), 0), budget)
  budget -= heldClaimed

  // Review fix (choice46b, choice46c): what the landlord's paid-ahead money
  // screen did with the money when the lease ended (the newest spends of all)
  // is recovered before any bill's spend is undone — from the landlord for
  // what GAM paid out to them, from the tenant for a refund they got — never
  // absorbed by GAM.
  const choice = await recoverChoiceMoney(client, c.id, budget, remittanceId, { noFeeGuess: !!followUp })
  budget -= choice.cents

  const applied = (await client.query<{ id: string; payment_id: string; lease_id: string; amount: string }>(
    `SELECT u.id, u.payment_id, u.lease_id, u.amount::text FROM credit_uses u
       JOIN payments p ON p.id = u.payment_id
      WHERE u.prepaid_credit_id = $1 AND u.status = 'applied'
      ORDER BY u.applied_at DESC, p.due_date DESC, p.created_at DESC, u.id DESC`, [c.id])).rows
  // Spends, newest first, whole uses. Normally the next use that would pass
  // the amount stops it (the charge's rows take the rest). With
  // wholeUsesUntilMet (a charge that paid no rows: nothing else can take the
  // rest) spends are undone until the amount is met, the last one whole; only
  // the claimed dollars are drained and the rest of it is the tenant's again.
  const spendBudget = budget
  const toReverse: typeof applied = []
  for (const u of applied) {
    const amt = toCents(u.amount)
    if (budget <= 0) break
    if (amt > budget && !opts.wholeUsesUntilMet) break
    toReverse.push(u)
    budget -= amt
  }
  const reversed: ClawbackResult['reversed'] = []
  for (const u of [...toReverse].sort((a, b) => a.payment_id.localeCompare(b.payment_id) || a.id.localeCompare(b.id))) {
    await client.query(
      `UPDATE credit_uses SET status = 'reversed', released_at = now(), release_reason = 'funding_reversed'
        WHERE id = $1 AND status = 'applied'`, [u.id])
    reversed.push({ useId: u.id, paymentId: u.payment_id, leaseId: u.lease_id, amount: toDollars(toCents(u.amount)) })
  }
  const reversedCents = toReverse.reduce((s, u) => s + toCents(u.amount), 0)
  const reversedClaimed = Math.min(reversedCents, spendBudget)

  const toDrain = c.voided_at ? 0 : unspentTaken + reversedClaimed
  const record = toDrain > 0 ? reversalId ?? (await disputeClaimOnCredit(client, c.id)).reversalId : null
  const took = record ? await writeTakeBack(client, c.id, record, toDrain, 'taken back for the dispute') : { cents: 0, useId: null }
  const tookForDispute = unspentTaken + heldClaimed + choice.cents + reversedClaimed
  // Fix pass 2 (review): only a follow-up dispute that runs past the charge's
  // money (its card-fee part) is told here. A later dispute that stays within
  // the money is not: the bills carry what this ledger did not take, and when
  // they cannot, the dispute handler tells GAM the exact dollars left on
  // nobody ('payment_reversal_short') — a notice here as well only repeated
  // a check that was already done.
  if (followUp) await alertFollowUpDispute(client, followUp, c.id, tookForDispute)
  if (stillHeld.length > 0) {
    logger.warn({ creditId: c.id, remittanceId, stillHeld, heldClaimed: toDollars(heldClaimed) },
      '[credit-use] disputed paid-ahead money is still set aside by a charge in flight')
  }
  return {
    creditId: c.id, reversed, drained: toDollars(took.cents), drainUseId: took.useId,
    drainPending: toDollars(record ? 0 : toDrain), stillHeld,
    heldClaimed: toDollars(heldClaimed),
    clawed: toDollars(unspentTaken + heldClaimed + choice.cents + reversedClaimed),
    nettedFromLandlord: choice.netted, refundsOwed: choice.owed, refundsNotSent: choice.notSent, stayRefundsLeft: choice.stayLeft,
  }
}

/**
 * Take off a paid-ahead credit what a dispute or return of its own funding
 * still claims of the money on it (disputeClaimOnCredit: the dispute less what
 * came off the charge's rows and the credit already), against `reversalId` —
 * the record of a row the event reopened — or one already written. Step 10
 * calls it after writing the rows' records when clawBackRemittanceCredit left
 * a drainPending. With no record to name, a charge that paid no rows and was
 * taken back in full has its credit withdrawn; a partial one is kept out of
 * every quote and GAM is told (takeBackForDispute). Idempotent: a second call
 * finds nothing left to claim.
 */
export async function takeBackDisputedCredit(
  client: PoolClient,
  creditId: string,
  reversalId: string | null = null,
): Promise<{ drained: number; withdrawn: boolean; unrecorded: number }> {
  const c = (await client.query<{ lease_id: string; amount_remaining: string; voided_at: Date | null }>(
    `SELECT lease_id, amount_remaining::text, voided_at FROM lease_prepaid_credits WHERE id = $1 FOR UPDATE`,
    [creditId])).rows[0]
  if (!c) throw new AppError(404, 'That paid-ahead credit was not found.')
  if (c.voided_at) return { drained: 0, withdrawn: false, unrecorded: 0 }
  const k = await disputeClaimOnCredit(client, creditId)
  if (!k.paymentIntentId || !(k.full || toCents(k.claim) > 0)) return { drained: 0, withdrawn: false, unrecorded: 0 }
  if (reversalId) k.reversalId = reversalId
  const cents = k.full ? toCents(c.amount_remaining) : Math.min(toCents(c.amount_remaining), toCents(k.claim))
  const r = await takeBackForDispute(client, k, { cents, leaseId: c.lease_id, why: 'taken back for the dispute' })
  return { drained: toDollars(r.drained), withdrawn: r.withdrawn, unrecorded: toDollars(r.unrecorded) }
}

/**
 * The dispute handler's entry point by charge (Step 10 calls it for every
 * card dispute and bank return, once per event, after recordDisputeEvent), so
 * a charge that paid no rows — money paid ahead with nothing owed, a payment
 * whose rows were settled elsewhere, an orphan — is handled too.
 * `reversalId`: a record of this event on a row it reopened, or null (none
 * written yet, or the charge paid no rows). `maxAmount`: a partial dispute's
 * amount; leave it out for a full dispute or a bank return.
 *   - A charge with rows, or a record to name: clawBackRemittanceCredit (with
 *     no record yet, the drain waits: drainPending → takeBackDisputedCredit).
 *   - No rows, and the dispute took every dollar of the credit: every spend of
 *     it is reversed (the caller reopens those rows, writing their records)
 *     and the credit is withdrawn — never usable, out of every balance — since
 *     no record exists that a 'reversal' use could name.
 *   - No rows, partial: clawBackRemittanceCredit with no record. Spends it
 *     undoes reopen rows, whose records the caller then names in
 *     takeBackDisputedCredit. When it undoes none, no record will ever exist:
 *     the claimed dollars stay on the credit, kept out of every quote
 *     (readCredits) so they are never spent or paid out, and GAM is told;
 *     `unrecorded` says how much.
 */
export async function clawBackDisputedCharge(
  client: PoolClient,
  a: { paymentIntentId: string; reversalId: string | null; maxAmount?: number },
): Promise<ClawbackResult & { withdrawn: boolean; unrecorded: number }> {
  const none = { creditId: null, reversed: [], drained: 0, drainUseId: null, drainPending: 0, stillHeld: [], heldClaimed: 0, clawed: 0, withdrawn: false, unrecorded: 0 }
  const credit = (await client.query<{ id: string; remittance_id: string }>(
    `SELECT c.id, c.source_remittance_id AS remittance_id
       FROM tenant_remittances r JOIN lease_prepaid_credits c ON c.source_remittance_id = r.id
      WHERE r.stripe_payment_intent_id = $1
      FOR UPDATE OF c`, [a.paymentIntentId])).rows[0]
  if (!credit) return none
  const k = await disputeClaimOnCredit(client, credit.id)
  const reversalId = a.reversalId ?? k.reversalId
  // Choice46d fix pass 3: a later dispute of a charge already disputed past its
  // money (followUpDisputeOf) — clawBackRemittanceCredit caps it and tells GAM;
  // with nothing of the charge's money left to take, nothing is taken here.
  const followUp = a.maxAmount != null ? await followUpDisputeOf(client, credit.remittance_id) : null
  if (followUp && followUp.moneyLeft <= 0) {
    await alertFollowUpDispute(client, followUp, credit.id, 0)
    return { ...none, creditId: credit.id }
  }
  const maxAmount = followUp ? Math.min(a.maxAmount!, toDollars(followUp.moneyLeft)) : a.maxAmount
  if (reversalId || k.chargeRows > 0) {
    return { ...(await clawBackRemittanceCredit(client, credit.remittance_id, reversalId, { maxAmount })), withdrawn: false, unrecorded: 0 }
  }
  // No rows: the claim is the amount the caller passes. With none, the whole
  // charge was taken back (a bank return, or a dispute of all of it): every
  // dollar of the credit is the claim's (Step 10 — a bank return of a no-row
  // charge used to read a claim of 0 off the dispute table, which a bank
  // return never writes to, and took nothing back).
  const claim: DisputeClaim = maxAmount == null
    ? { ...k, full: true, claim: Number.POSITIVE_INFINITY }
    : { ...k, full: false, claim: maxAmount }
  if (!claimCoversCredit(claim)) {
    // Partial: nothing else can carry the rest, so spends are undone whole,
    // newest first, until the claim is met (the caller reopens their rows);
    // only the claimed dollars are taken back.
    const r = await clawBackRemittanceCredit(client, credit.remittance_id, null,
      { maxAmount: claim.claim, wholeUsesUntilMet: true })
    let unrecorded = 0
    if (r.reversed.length === 0) {
      unrecorded = toDollars(toCents(r.drainPending) + toCents(r.heldClaimed))
      if (!k.voided && unrecorded > 0) await alertDisputeUnrecorded(client, k, toCents(unrecorded))
    }
    const short = toCents(claim.claim) - toCents(r.clawed)
    if (short > 0) await alertDisputeShort(k, short)
    return { ...r, withdrawn: false, unrecorded }
  }
  const applied = (await client.query<{ id: string; payment_id: string; lease_id: string; amount: string }>(
    `SELECT id, payment_id, lease_id, amount::text FROM credit_uses
      WHERE prepaid_credit_id = $1 AND status = 'applied' AND payment_id IS NOT NULL
      ORDER BY payment_id, id`, [credit.id])).rows
  const reversed: ClawbackResult['reversed'] = []
  for (const u of applied) {
    await client.query(
      `UPDATE credit_uses SET status = 'reversed', released_at = now(), release_reason = 'funding_reversed'
        WHERE id = $1 AND status = 'applied'`, [u.id])
    reversed.push({ useId: u.id, paymentId: u.payment_id, leaseId: u.lease_id, amount: toDollars(toCents(u.amount)) })
  }
  // Review fix (choice46b, choice46c): what the landlord's paid-ahead money
  // screen did with it when the lease ended is recovered from whoever it
  // reached (recoverChoiceMoney) — never absorbed by GAM.
  const choice = await recoverChoiceMoney(client, credit.id, Number.POSITIVE_INFINITY, credit.remittance_id)
  await withdrawDisputedCredit(client, k)
  const stillHeld = (await client.query<{ id: string; payment_id: string | null; amount: string }>(
    `SELECT id, payment_id, amount::text FROM credit_uses WHERE prepaid_credit_id = $1 AND status = 'held' ORDER BY id`,
    [credit.id])).rows.map(u => ({ useId: u.id, paymentId: u.payment_id, amount: Number(u.amount) }))
  const heldCents = stillHeld.reduce((s, u) => s + toCents(u.amount), 0)
  // Choice46c (decisions #51): clawed is what was really covered — what is
  // left on the withdrawn credit (its unspent money and every spend undone
  // above), what charges in flight set aside, and what the screen's money was
  // recovered as — never the credit's whole original amount when some of it
  // went somewhere nothing here recovers (a move-out's pool, say). The rest
  // is told to GAM, never left on nobody in silence.
  const leftOn = toCents((await client.query<{ r: string }>(
    `SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE id = $1`, [credit.id])).rows[0]?.r ?? 0)
  const covered = leftOn + heldCents + choice.cents
  const short = toCents(k.amountOriginal) - covered
  if (short > 0) await alertDisputeShort(k, short, true)
  return {
    creditId: credit.id, reversed, drained: 0, drainUseId: null, drainPending: 0, stillHeld,
    heldClaimed: toDollars(heldCents),
    clawed: toDollars(covered),
    nettedFromLandlord: choice.netted, refundsOwed: choice.owed, refundsNotSent: choice.notSent, stayRefundsLeft: choice.stayLeft,
    withdrawn: true, unrecorded: 0,
  }
}

// ─── Small readers other services share ──────────────────────────────────────

/**
 * The tenant whose household a lease's bill belongs to: the invoice's tenant,
 * else the lease's primary resident, else whoever its charges name.
 */
export async function billHouseholdTenant(client: PoolClient, leaseId: string, invoiceId?: string | null): Promise<{ tenantId: string; landlordId: string } | null> {
  const r = await client.query<{ tenant_id: string | null; landlord_id: string }>(
    `SELECT COALESCE(
              (SELECT i.tenant_id FROM invoices i WHERE i.id = $2::uuid),
              (SELECT t.tenant_id FROM v_lease_active_tenants t WHERE t.lease_id = l.id
                ORDER BY (t.role = 'primary') DESC, t.added_at, t.tenant_id LIMIT 1),
              (SELECT p.tenant_id FROM payments p WHERE p.lease_id = l.id AND p.tenant_id IS NOT NULL
                ORDER BY p.created_at, p.id LIMIT 1)) AS tenant_id,
            l.landlord_id
       FROM leases l WHERE l.id = $1`,
    [leaseId, invoiceId ?? null])
  const row = r.rows[0]
  return row?.tenant_id ? { tenantId: row.tenant_id, landlordId: row.landlord_id } : null
}

