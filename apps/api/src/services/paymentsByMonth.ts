/**
 * THE PAYMENTS LEDGER: A MONTHLY RENT ROLL OF PAYMENTS (decisions #29, #26,
 * #35.1 and #36.A, Nic 10/3).
 *
 * #29: "PAYMENTS tab = a ledger of payments that have already happened, STAMPED
 * BY MONTH: one section per month, newest first, with a month picker to jump
 * back (not one endless list) ... One line per payment per #26 — who, space,
 * date paid, amount, method, what it paid for (e.g. 'September rent'), and 'on
 * time' or 'N days late' (measured from the due date of the oldest bill it
 * paid, honoring the grace period); 'Show line items' toggle ... Work-trade
 * households get one line per month 'Work trade — covered' (no amount) so the
 * month reads complete. Bank payments still clearing are listed and marked
 * 'clearing'; a returned one is marked 'returned'. A month total shows only to
 * owners / property managers (#25) ... the current month shows one plain
 * pointer line 'N households still owe — see Outstanding Balances' (a count,
 * no dollars)."
 *
 * WHICH MONTH — #35.1 replaced #29's "the month its money arrived": "the
 * Payments ledger/rent roll is filed by the BILL's month — each payment sits
 * under the month of the invoice it paid (its due month) and shows the day it
 * was paid (a late payer who paid September's bill in October appears under
 * SEPTEMBER, 'paid Oct 3, 2 days late'). Each month's roll is that month's
 * bills' history." #36.A: "a payment that paid several bills shows under each
 * bill's month with the part that went to it (CONFIRMED). Paid-ahead money: the
 * rent roll shows each month's bill as paid FROM the paid-ahead credit on the
 * day it was applied ... The arrival of the $5,000 itself is not a rent-roll
 * line (it lives in the household's credit history)." ledgerMonthSql is the one
 * place that rule lives.
 *
 * What one "payment" is (one act that paid bills):
 *   - a RECEIPT (tenant_remittances): a card or bank payment through GAM, or a
 *     desk receipt (cash, check, money order), a posted payment or a bank
 *     deposit match. Its parts are the charges it paid (remittance_applications)
 *     plus any account credit spent in the same act (credit_uses on its
 *     remittance, or — the desk — spent in the same transaction, so
 *     applied_at = the receipt's created_at). Money it kept on the account
 *     ("paid ahead") is not a line (#36.A); the bills that money pays later
 *     are, on the day it pays them.
 *   - a bill PAID FROM CREDIT and nothing else (a credit-only settle, the
 *     whole-bill rule): "Paid from credit", dated by creditPaidOnDay (the bill's
 *     due date, or the day the credit settled it when that is later), with $0
 *     of money (Todd Niemeyer's October rent, paid by the second month of his
 *     September check). Statutory deposit interest is the exception: GAM
 *     funds it, so it is new money to the landlord the day it pays a bill
 *     (money plan §0.0) and is counted as money, "Deposit interest".
 *   - a charge settled with NO receipt (history from before receipts existed,
 *     a bill GAM covered, a prior arrangement): grouped by the one act that
 *     settled it.
 * GAM's own charges (a returned-payment fee, the FlexPay pull, platform fees)
 * are GAM's money, never a line on a landlord's ledger, and nothing in the
 * reply names a FlexPay cover or a Stripe intent (CLAUDE.md: FlexPay never
 * surfaces in the landlord portal). A charge taken from a deposit at move-out
 * is not a payment.
 */
import { createHash } from 'crypto'
import { paidByLabel } from '@gam/shared'
import { query } from '../db'
import { todayIn } from '../lib/timezone'
import { chargeLabel, chargeDetail, chargeLabelColumnsSql } from './invoiceNotice'
import {
  daysLate, graceDaysSql, propertyDaySql, listOpenTenantBalances, WORK_TRADE_MARKER_LABEL,
} from './openBalances'

// ─── Which month (the one rule) ──────────────────────────────────────────────

/** The two ways a payment can be filed: under the month its bill was due, or the month it was paid. */
export const LEDGER_FILED_BY_VALUES = ['bill_month', 'paid_month'] as const
export type LedgerFiledBy = typeof LEDGER_FILED_BY_VALUES[number]
/** decisions #35.1 (Nic, 10/3): the bill's month. */
export const LEDGER_FILED_BY: LedgerFiledBy = 'bill_month'

/**
 * THE ONE PLACE the ledger decides which month a part of a payment is filed
 * under (decisions #35.1 / #36.A): the month its bill was due (the invoice's
 * due date; a charge on no invoice, its own). A payment that paid several
 * months' bills is filed under each of them with the part that went to each.
 * `paidAt`/`tz` are the act's own instant and its property (the zone's alias),
 * used only when LEDGER_FILED_BY says 'paid_month'.
 */
export function ledgerMonthSql(part: { billDue: string; paidAt?: string; tz?: string }): string {
  const by = LEDGER_FILED_BY as LedgerFiledBy
  if (by === 'paid_month' && part.paidAt && part.tz) {
    return `to_char(${propertyDaySql(part.paidAt, part.tz)}, 'YYYY-MM')`
  }
  return `to_char(${part.billDue}, 'YYYY-MM')`
}

/**
 * Does the owners' month total count a security deposit held in trust that was
 * paid on the month's bill? Not decided by Nic (decisions.md is silent). Until
 * he answers it does NOT, so the Payments month total agrees with the reports,
 * which never count a held deposit as income (incomeBasis.landlordIncomeSql
 * leaves type 'deposit' out). The deposit is still listed on its payment's line
 * (the tenant paid it on that bill); only the month total leaves it out. One
 * switch; isTrustHeldDeposit says which rows it covers.
 */
export const LEDGER_TOTAL_COUNTS_HELD_DEPOSITS = false

/**
 * A deposit held in trust: every charge of type 'deposit' — the security
 * deposit (jobs/moveInBundle writes it with the default revenue_owner
 * 'landlord'), a FlexDeposit installment, a refundable deposit box on the
 * lease. NOT the move-out shortfall (type 'fee', entry 'DEPOSIT', no lease
 * fee): what the tenant still owed past the deposit is income in the reports.
 */
export function isTrustHeldDeposit(row: { type: string }): boolean {
  return row.type === 'deposit'
}

/**
 * Money paid ahead on a move-in box (revenue_owner 'held'): it becomes
 * paid-ahead credit, and each bill it pays later is counted then, "Paid from
 * credit" (#36.A). Never in the month's money total, or it would count twice.
 */
export function isPaidAheadRow(row: { revenue_owner: string }): boolean {
  return row.revenue_owner === 'held'
}

/** Does this charge's part of a payment count in the owners' month total? */
export function countsInLedgerTotal(row: { type: string; revenue_owner: string }): boolean {
  if (isPaidAheadRow(row)) return false
  return LEDGER_TOTAL_COUNTS_HELD_DEPOSITS || !isTrustHeldDeposit(row)
}

/**
 * THE ONE PLACE the day a bill paid from account credit is shown on is decided
 * (decisions #36.A: "the rent roll shows each month's bill as paid FROM the
 * paid-ahead credit on the day it was applied (the bill's due date, or when
 * the credit settled it) — e.g. $5,000 paid ahead shows as October rent 'paid
 * from credit · Oct 1', November 'paid from credit · Nov 1'"). Credit that was
 * already on the account when the bill was made pays it before it is due, so
 * the line reads the bill's due date; credit that arrived (or was freed) after
 * the due date reads the day it settled the bill. That is the later of the
 * two, and on-time or late is measured on that day. 'YYYY-MM-DD' days.
 */
export function creditPaidOnDay(appliedDay: string, billDueDate: string): string {
  return appliedDay > billDueDate ? appliedDay : billDueDate
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const LEDGER_PAYMENT_STATUSES = ['settled', 'clearing', 'returned'] as const
export type LedgerPaymentStatus = typeof LEDGER_PAYMENT_STATUSES[number]
export const LEDGER_PAYMENT_STATUS_LABEL: Record<LedgerPaymentStatus, string> = {
  settled: 'Paid',
  clearing: 'Clearing',
  returned: 'Returned',
}
/**
 * A payment whose own money stayed, but whose paid-ahead credit was taken back
 * since (the card or bank payment that FUNDED that credit was disputed or
 * returned: the line's credit_returned > 0 and its returned is 0), reads
 * 'Returned' while this is true; false makes it read from its own money
 * (Paid, or Clearing). decisions.md does not settle which wording a landlord
 * sees for it, so the choice is this one switch. Either way the figures say
 * what came back: credit_returned on the line and the payment, and
 * credit_returned_since in the month totals.
 */
export const CREDIT_TAKEN_BACK_MARKS_RETURNED = true

/**
 * What a payment's status reads: the one place the rule lives. Its own money
 * decides first: a receipt reads Paid once its money arrived, Clearing while a
 * bank payment clears (or a bounced one is retrying), Returned once it bounced
 * (#29: "a returned one is marked 'returned'"); a payment with no receipt was
 * settled. Money a card dispute or bank return later took back from it marks
 * it Returned. Credit taken back since follows CREDIT_TAKEN_BACK_MARKS_RETURNED,
 * except that a payment nothing of which still stands (a bill paid from credit
 * alone whose credit was all taken back) is Returned either way.
 */
export function ledgerPaymentStatus(a: {
  receipt: { status: string; retrying: boolean } | null
  /** A dispute or bank return took back some of this payment's own money. */
  moneyReturned: boolean
  /** Paid-ahead credit this payment used was taken back since (credit_returned > 0). */
  creditTakenBack: boolean
  /** It paid no money of its own, and all the credit it used was taken back. */
  nothingStands?: boolean
}): LedgerPaymentStatus {
  const own: LedgerPaymentStatus = !a.receipt || a.receipt.status === 'settled' ? 'settled'
    : (a.receipt.status === 'processing' || a.receipt.retrying) ? 'clearing'
    : 'returned'
  if (own === 'returned' || a.moneyReturned) return 'returned'
  if (a.creditTakenBack && (CREDIT_TAKEN_BACK_MARKS_RETURNED || a.nothingStands)) return 'returned'
  return own
}

export const LEDGER_PAYMENT_KINDS = ['receipt', 'credit', 'settled'] as const
export type LedgerPaymentKind = typeof LEDGER_PAYMENT_KINDS[number]

/** How a payment was made, beyond the ways a person hands money over (paidByLabel). */
export const LEDGER_OTHER_METHODS = ['credit', 'deposit_interest', 'online'] as const
export type LedgerOtherMethod = typeof LEDGER_OTHER_METHODS[number]
export const LEDGER_OTHER_METHOD_LABEL: Record<LedgerOtherMethod, string> = {
  // decisions #36.A: "paid from credit · Oct 1"
  credit: 'Paid from credit',
  deposit_interest: 'Deposit interest',
  online: 'Online payment',
}

/** The words a work-trade household's month line reads (no amount, ever). */
export const WORK_TRADE_COVERED_LABEL = `${WORK_TRADE_MARKER_LABEL} — covered`

export interface LedgerLine {
  payment_id: string
  /** What the charge is ("Rent", "Water", "Late fee"), never "Utilities". */
  label: string
  detail: string | null
  /** YYYY-MM-DD: the bill's due date. */
  due_date: string
  /** The charge's full amount. */
  amount: number
  /** Money from this payment that landed on it (deposit interest included: GAM-funded money). */
  paid: number
  /** Account credit spent on it in this payment. */
  credit: number
  /**
   * Of `paid`, money a card dispute or bank return took back from this charge
   * (its reversal record's amount, returnedByPart). A disputed water line reads
   * its water here, and the rent paid with it reads 0.
   */
  returned: number
  /**
   * Of `credit`, paid-ahead credit whose own money a card dispute or bank
   * return took back after it paid this charge (the use went 'reversed' and the
   * charge is owed again for it: creditUse.clawBackDisputedCharge). This
   * payment's own money is untouched: that is `returned`.
   */
  credit_returned: number
  unit_number: string | null
  property_name: string | null
}

export interface LedgerPayment {
  /** The receipt id, or an opaque key for a payment with no receipt (never a Stripe or FlexPay id). */
  id: string
  kind: LedgerPaymentKind
  tenant_id: string | null
  name: string
  unit_number: string | null
  property_id: string | null
  property_name: string | null
  /** YYYY-MM-DD, property calendar: the day they paid (a card or bank payment the day it was made; a bill paid from credit, creditPaidOnDay). */
  paid_on: string
  /**
   * YYYY-MM-DD: the day the money arrived (a bank payment clears days after it
   * is made). Null while clearing, for a bank payment that bounced (its money
   * never arrived), and for a bill paid from account credit alone (no money
   * arrived that day: the credit's money arrived when it was paid ahead).
   * Deposit interest is money GAM funds: it arrived the day it paid the bill,
   * which can be before the bill's due date that `paid_on` reads.
   */
  arrived_on: string | null
  /** What this month's bills it paid came to (money plus account credit). */
  owed: number
  /** The money that went to this month's bills. $0 for a bill paid from account credit. */
  amount: number
  /** Account credit that went to this month's bills. */
  credit_applied: number
  /**
   * Of `amount`, money a card dispute or bank return took back (the lines'
   * `returned`, summed: which part came back is on each line). A bank payment
   * that bounced before it cleared came back whole (its money never arrived:
   * `arrived_on` is null).
   */
  returned: number
  /** Of `credit_applied`, credit whose money a dispute or bank return took back since (the lines' `credit_returned`, summed). */
  credit_returned: number
  method: string | null
  method_label: string
  /**
   * 10/5 (Nic): the receipt this payment is (null when it has none: paid from
   * credit, or settled with no receipt), its reference — a check or
   * money-order number, a bank deposit's reference — and, for a bank deposit,
   * the photo of the bank's receipt (an authed URL; the landlord's own people
   * only — this ledger is never the tenant's).
   */
  receipt_id: string | null
  reference: string | null
  deposit_photo_url: string | null
  /**
   * 10/5 (Nic): a payment made from a bank deposit the tenant reported — the
   * date they gave and the bank's, when the bank showed it on a later day than
   * the next business day after theirs (the bank's date was used; the screen
   * says "Said they deposited Oct 1 — the bank shows Oct 6."). Null otherwise.
   */
  deposit_date_flag: { said: string; bank: string } | null
  /** 10/5 (Nic): the tenant's own photo of the bank's receipt on that report (an authed URL). */
  tenant_receipt_photo_url: string | null
  status: LedgerPaymentStatus
  status_label: string
  /** "September rent, September water". */
  paid_for: string
  /** 0 = on time. Days since the oldest bill it paid was due, once past its grace period, on the day they paid. */
  days_late: number
  timing_label: string
  lines: LedgerLine[]
}

export interface WorkTradeMonthLine {
  tenant_id: string
  name: string
  unit_number: string | null
  property_name: string | null
  label: string
}

export interface LedgerTotals {
  /** Money paid on this month's bills that arrived (including any a bank or card dispute has since taken back). */
  paid: number
  /**
   * Account credit that paid this month's bills and still stands. Credit whose
   * own money a dispute or bank return took back is not in it (the bill is
   * owed again for that part, and what pays it again is counted then): every
   * dollar counted once. That credit is `credit_returned_since`.
   */
  paid_from_credit: number
  /**
   * Of `paid`, money a bank return or card dispute has since taken back: what
   * each charge's reversal record says it lost (the reports' "Returned or
   * disputed"), never the whole payment for a part of it.
   */
  returned_since: number
  /**
   * Paid-ahead credit that paid this month's bills and whose own money a
   * dispute or bank return has since taken back. Beside `paid_from_credit`,
   * never inside it.
   */
  credit_returned_since: number
  /** Money on this month's bills still clearing. */
  clearing: number
  /** Payment lines this month. */
  payments: number
}

export interface PaymentsMonth {
  /** YYYY-MM: the bills' month. */
  month: string
  /** Months with any payment or work-trade line, newest first (the picker). Always includes the current month. */
  months: string[]
  payments: LedgerPayment[]
  work_trade: WorkTradeMonthLine[]
  /** The current month only: how many households still owe (a count, never dollars). Null for a past month. */
  still_owe_households: number | null
  /** Owners and property managers only (decisions #25); absent otherwise. */
  totals?: LedgerTotals
}

export interface PaymentsMonthOptions {
  landlordIds: string[]
  /** A property-locked viewer's properties; null = every property. */
  propertyIds: string[] | null
  /** YYYY-MM; default the current month. */
  month?: string | null
  /** decisions #25: include the month's totals (the caller decides by who is asking: seesGrandTotals). */
  withTotals: boolean
}

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number) => Math.round(c) / 100
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Is this a month the ledger can show (YYYY-MM)? */
export function isLedgerMonth(m: unknown): m is string {
  return typeof m === 'string' && MONTH_RE.test(m)
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

/**
 * A charge row (alias `p`) belongs on this landlord's ledger: one of these
 * companies' charges, the landlord's (or held for the tenant), never GAM's own
 * money or the FlexPay pull, and — for a property-locked viewer — at one of
 * their properties. $1 = company ids, $2 = property ids (NULL = all).
 */
function ledgerRowSql(p: string): string {
  return `(${p}.landlord_id = ANY($1::uuid[])
      AND ${p}.revenue_owner <> 'gam'
      AND ${p}.entry_description IS DISTINCT FROM 'FLEXPAY'
      AND ${p}.type NOT IN ('platform_fee','float_fee')
      AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM units lr_u
                                          WHERE lr_u.id = ${p}.unit_id AND lr_u.property_id = ANY($2::uuid[]))))`
}

/**
 * The receipts that may touch these companies ($1 only). Per receipt: the
 * property zone its days are told in, the moment they paid (the postmark: a
 * card or bank payment the moment it was made; money taken at the desk or
 * matched to a bank deposit, its own date), and whether a bounced bank payment
 * is being pulled again right now (`retrying`).
 */
function remCteSql(): string {
  return `rem AS (
     SELECT r.id, r.tenant_id, r.lease_id, r.status, r.payment_method, r.created_at, r.settled_at,
            r.stripe_payment_intent_id AS intent,
            COALESCE(lp.timezone,
                     (SELECT apr.timezone FROM remittance_applications ra
                        JOIN payments ap ON ap.id = ra.payment_id
                        JOIN units au ON au.id = ap.unit_id
                        JOIN properties apr ON apr.id = au.property_id
                       WHERE ra.remittance_id = r.id ORDER BY ap.id LIMIT 1)) AS timezone,
            CASE WHEN r.stripe_payment_intent_id IS NOT NULL THEN r.created_at
                 ELSE COALESCE(r.settled_at, r.created_at) END AS paid_at,
            -- A bounced bank payment the retry is pulling again: the failure
            -- marked the receipt 'failed', and achRetry re-confirms the SAME
            -- intent and puts its rows back to 'processing' (nothing returns
            -- the receipt to 'processing'). Clearing, exactly as Outstanding
            -- reads those rows (openBalances.inFlightRowSql).
            (r.status = 'failed' AND r.stripe_payment_intent_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM remittance_applications rra
                           JOIN payments rp ON rp.id = rra.payment_id
                          WHERE rra.remittance_id = r.id
                            AND rp.stripe_payment_intent_id = r.stripe_payment_intent_id
                            AND rp.status IN ('processing','pending'))) AS retrying
       FROM tenant_remittances r
       LEFT JOIN leases rl     ON rl.id = r.lease_id
       LEFT JOIN units lu      ON lu.id = rl.unit_id
       LEFT JOIN properties lp ON lp.id = lu.property_id
      -- a card that was declined never moved money; a bank payment that
      -- bounced did, and is listed as returned
      WHERE NOT (r.status = 'failed' AND r.payment_method = 'card')
        AND (r.landlord_id = ANY($1::uuid[])
             OR EXISTS (SELECT 1 FROM remittance_applications sra JOIN payments sp ON sp.id = sra.payment_id
                         WHERE sra.remittance_id = r.id AND sp.landlord_id = ANY($1::uuid[]))))`
}

/**
 * Account credit (alias `cu`, on charge `p`) spent for the same household as
 * receipt `r`: the receipt's payer's own charge, a charge on the receipt's
 * lease, or a charge on a lease the payer is on. Lease charges carry the
 * primary resident's id, so a co-resident who pays at the desk and spends the
 * household's credit is still ONE payment (decisions #26).
 */
function sameHouseholdSql(p: string, cu: string, r: string): string {
  return `(${p}.tenant_id = ${r}.tenant_id
        OR ${cu}.lease_id = ${r}.lease_id
        OR EXISTS (SELECT 1 FROM lease_tenants hh_lt
                    WHERE hh_lt.lease_id = ${cu}.lease_id AND hh_lt.tenant_id = ${r}.tenant_id))`
}

/**
 * A receipt (alias `r`, from rem) whose money could have paid a charge: not a
 * bounced bank payment (its money never arrived), unless its retry is pulling
 * the same intent again. rem already leaves out a declined card. A charge such
 * a receipt touched and something else later settled (a covered bill) is
 * still listed, by the act that settled it.
 */
function receiptMayHavePaidSql(r: string): string {
  return `(${r}.status <> 'failed' OR ${r}.retrying)`
}

/**
 * Every part of every payment on this ledger ($1 companies, $2 properties):
 * one row per (act, charge), with the money and the credit that act put on that
 * charge, and the month it is filed under (ledgerMonthSql). `act` is an
 * internal grouping key only — it may carry a Stripe intent or a cover's id, so
 * it never leaves this file (publicId). `intent` is the Stripe intent whose
 * money the act moved (a card or bank payment; NULL at the desk and for credit
 * alone): internal too, used only to say which act a dispute took money back
 * from (returnedByPart).
 */
function filedPartsCteSql(): string {
  return `${remCteSql()},
   parts AS (
     -- the money a receipt put on a charge
     SELECT 'r:' || rem.id::text AS act, 'receipt'::text AS src, rem.id AS remittance_id, ra.payment_id,
            ra.amount_applied AS money, 0::numeric AS credit, NULL::text AS credit_kind, NULL::text AS use_status,
            rem.tenant_id, rem.paid_at, rem.timezone, rem.intent
       FROM rem
       JOIN remittance_applications ra ON ra.remittance_id = rem.id
       JOIN payments p ON p.id = ra.payment_id
      WHERE ${ledgerRowSql('p')}
     UNION ALL
     -- account credit a card or bank payment set aside or spent
     SELECT 'r:' || rem.id::text, 'receipt', rem.id, cu.payment_id,
            0, cu.amount, cu.kind, cu.status, rem.tenant_id, rem.paid_at, rem.timezone, rem.intent
       FROM rem
       JOIN v_credit_uses cu ON cu.remittance_id = rem.id
       JOIN payments p ON p.id = cu.payment_id
      WHERE cu.status IN ('held','applied','reversed') AND ${ledgerRowSql('p')}
     UNION ALL
     -- account credit the desk spent in the same transaction as its receipt
     -- (one moment), for the payer's household (sameHouseholdSql); counted
     -- once, on one receipt, if that moment wrote two
     SELECT 'r:' || rem.id::text, 'receipt', rem.id, cu.payment_id,
            0, cu.amount, cu.kind, cu.status, rem.tenant_id, rem.paid_at, rem.timezone, rem.intent
       FROM rem
       JOIN v_credit_uses cu ON cu.remittance_id IS NULL AND cu.applied_at = rem.created_at
                            AND cu.status IN ('applied','reversed')
       JOIN payments p ON p.id = cu.payment_id
      WHERE ${ledgerRowSql('p')}
        AND ${receiptMayHavePaidSql('rem')}
        AND ${sameHouseholdSql('p', 'cu', 'rem')}
        AND NOT EXISTS (SELECT 1 FROM rem r2
                         WHERE r2.created_at = rem.created_at AND r2.id::text < rem.id::text
                           AND ${receiptMayHavePaidSql('r2')}
                           AND ${sameHouseholdSql('p', 'cu', 'r2')})
     UNION ALL
     -- a bill paid from account credit and nothing else (no receipt of the
     -- household at that moment)
     SELECT 'act:' || COALESCE(p.tenant_id::text, '') || ':' || extract(epoch FROM cu.applied_at)::text,
            'credit', NULL::uuid, cu.payment_id,
            0, cu.amount, cu.kind, cu.status, p.tenant_id, cu.applied_at, pr.timezone, NULL::text
       FROM v_credit_uses cu
       JOIN payments p ON p.id = cu.payment_id
       LEFT JOIN units u ON u.id = p.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE cu.remittance_id IS NULL AND cu.status IN ('applied','reversed')
        AND ${ledgerRowSql('p')}
        AND NOT EXISTS (SELECT 1 FROM rem
                         WHERE rem.created_at = cu.applied_at
                           AND ${receiptMayHavePaidSql('rem')}
                           AND ${sameHouseholdSql('p', 'cu', 'rem')})
     UNION ALL
     -- a charge settled with no receipt that paid it (history, a covered bill,
     -- a prior arrangement, a bill covered after a declined card or a bounced
     -- bank payment): one act settles its rows in one transaction (one
     -- settled_at); a card or bank payment is its intent; a covered bill is its cover
     SELECT CASE WHEN p.stripe_payment_intent_id IS NOT NULL THEN 'pi:' || p.stripe_payment_intent_id
                 WHEN p.flexpay_advance_id IS NOT NULL THEN 'cover:' || p.flexpay_advance_id::text
                 ELSE 'act:' || COALESCE(p.tenant_id::text, '') || ':' || extract(epoch FROM p.settled_at)::text END,
            'settled', NULL::uuid, p.id,
            s.money, 0, NULL, NULL, p.tenant_id, p.settled_at, pr.timezone, p.stripe_payment_intent_id
       FROM payments p
       LEFT JOIN units u ON u.id = p.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL (
         SELECT p.amount - COALESCE((SELECT SUM(scu.amount) FROM credit_uses scu
                                      WHERE scu.payment_id = p.id AND scu.status IN ('applied','reversed')), 0) AS money) s
      WHERE p.status IN ('settled','returned') AND p.settled_at IS NOT NULL AND p.amount > 0
        AND p.work_trade_suspended_at IS NULL
        AND ${ledgerRowSql('p')}
        AND NOT EXISTS (SELECT 1 FROM remittance_applications nra
                          JOIN rem nr ON nr.id = nra.remittance_id
                         WHERE nra.payment_id = p.id AND ${receiptMayHavePaidSql('nr')})
        AND s.money > 0
   ),
   filed AS (
     SELECT parts.*,
            ${ledgerMonthSql({ billDue: 'COALESCE(finv.due_date, fp.due_date)', paidAt: 'parts.paid_at', tz: 'parts' })} AS filed_month,
            to_char(${propertyDaySql('parts.paid_at', 'parts')}, 'YYYY-MM-DD') AS paid_day
       FROM parts
       JOIN payments fp ON fp.id = parts.payment_id
       LEFT JOIN invoices finv ON finv.id = fp.invoice_id
   )`
}

/**
 * The bills of each household that work trade covered ($1 companies, $2
 * properties), with the month each was due. Two shapes: a charge still
 * suspended (the month is being worked), and a bill the month-close already
 * settled (jobs/workTradeSettlement settles the covered rows at $0, CLEARS
 * work_trade_suspended_at and adds the hours' value to the invoice's
 * work_trade_credit_amount) — so a closed month keeps its line.
 */
function workTradeBillsCteSql(): string {
  return `wt AS (
     SELECT COALESCE(p.tenant_id, inv.tenant_id) AS tenant_id, p.unit_id,
            COALESCE(inv.due_date, p.due_date) AS due
       FROM payments p
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
      WHERE p.work_trade_suspended_at IS NOT NULL AND ${ledgerRowSql('p')}
     UNION ALL
     SELECT inv.tenant_id, inv.unit_id, inv.due_date
       FROM invoices inv
      WHERE inv.work_trade_credit_amount > 0
        AND inv.status <> 'void'
        AND inv.landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM units wu
                                            WHERE wu.id = inv.unit_id AND wu.property_id = ANY($2::uuid[])))
   )`
}

interface RowFacts {
  id: string; tenant_id: string | null; type: string; amount: string; status: string; notes: string | null
  entry_description: string | null; utility_type: string | null; fee_type: string | null; fee_description: string | null
  due_date: string; grace_days: number; unit_number: string | null; property_id: string | null; property_name: string | null
  revenue_owner: string; manual_method: string | null; payment_channel: string | null
  /** Paid by a card or bank payment, or covered by GAM: "Online payment" when nothing names the method. */
  online: boolean
  /** The Stripe intent that settled it (internal: which act a dispute took money back from; never in the reply). */
  intent: string | null
}

/** The facts a ledger line needs, for these charge ids (only the ones on this ledger). */
async function rowFacts(ids: string[], landlordIds: string[], propertyIds: string[] | null): Promise<Map<string, RowFacts>> {
  if (!ids.length) return new Map()
  const rows = await query<RowFacts>(
    `SELECT p.id, p.tenant_id, p.type, p.amount::text AS amount, p.status, p.notes, p.entry_description,
            ${chargeLabelColumnsSql('p')},
            to_char(COALESCE(inv.due_date, p.due_date), 'YYYY-MM-DD') AS due_date,
            ${graceDaysSql('l', 'pr')}::int AS grace_days,
            u.unit_number, pr.id AS property_id, pr.name AS property_name,
            p.revenue_owner, p.manual_method, p.payment_channel,
            (p.stripe_payment_intent_id IS NOT NULL OR p.flexpay_advance_id IS NOT NULL) AS online,
            p.stripe_payment_intent_id AS intent
       FROM payments p
       LEFT JOIN invoices inv  ON inv.id = p.invoice_id
       LEFT JOIN units u       ON u.id = p.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       LEFT JOIN leases l      ON l.id = p.lease_id
      WHERE p.id = ANY($3::uuid[]) AND ${ledgerRowSql('p')}`,
    [landlordIds, propertyIds, [...new Set(ids)]])
  return new Map(rows.map(r => [r.id, r]))
}

interface FiledPart {
  act: string
  src: LedgerPaymentKind
  remittance_id: string | null
  payment_id: string
  money: string
  credit: string
  credit_kind: string | null
  use_status: string | null
  tenant_id: string | null
  paid_day: string
  intent: string | null
}

interface ReceiptFacts {
  id: string; tenant_id: string; status: string; payment_method: string | null
  retrying: boolean; paid_on: string; arrived_on: string | null; channel: string | null
  reference: string | null; deposit_photo_url: string | null
  flag_said: string | null; flag_bank: string | null; tenant_receipt_photo_url: string | null
}

interface Draft {
  act: string
  remittance_id: string | null
  srcs: Set<LedgerPaymentKind>
  tenant_id: string | null
  paid_day: string
  /** The Stripe intent whose money this act moved (internal; null at the desk and for credit alone). */
  intent: string | null
  /**
   * payment id → [money cents (deposit interest included), credit cents, of the
   * money: deposit interest cents, of the credit: cents whose funding was
   * reversed (the use is 'reversed')]
   */
  parts: Map<string, [number, number, number, number]>
  depositInterest: boolean
  otherCredit: boolean
}

function addPart(d: Draft, paymentId: string, moneyC: number, creditC: number, interestC: number, creditReversedC: number): void {
  const e = d.parts.get(paymentId) ?? [0, 0, 0, 0]
  e[0] += moneyC
  e[1] += creditC
  e[2] += interestC
  e[3] += creditReversedC
  d.parts.set(paymentId, e)
}

/** One act's money on one charge a dispute or bank return took money back from (returnedByPart). */
export interface ReturnablePart {
  /** The act (an internal key). */
  act: string
  /** The Stripe intent whose money the act moved; null at the desk and for account credit alone. */
  intent: string | null
  /** Cents of money the act put on the charge (never deposit interest: GAM funds it, no one disputes it). */
  moneyC: number
}

/**
 * THE ONE PLACE the ledger decides how much of each act's money on a charge a
 * dispute or bank return took back. `reversedC` is the MONEY the charge's
 * reversal records say it lost (payment_reversals.reversed_amount, summed: the
 * figure the reports count as "Returned or disputed", money plan §2, less any
 * paid-ahead credit on the charge whose own funding was reversed — that credit
 * is the line's credit_returned, not this payment's money), so a $100 dispute of
 * a $460 rent payment takes back $100, not $460, and a dispute of a payment's
 * water line takes back the water only. With a record, the money comes off the
 * act whose Stripe intent is the charge's own first, then any other card or
 * bank act; money paid at the desk was not disputed, and comes back only when no
 * card or bank money was on the charge at all. `reversedC` null: the charge was
 * marked returned with no record (a return recorded by hand, history from
 * before the records existed) — all of its money came back, as before.
 * Returns act → cents taken back.
 */
export function returnedByPart(charge: { intent: string | null }, parts: readonly ReturnablePart[], reversedC: number | null): Map<string, number> {
  const out = new Map<string, number>()
  const withMoney = [...parts].filter(pt => pt.moneyC > 0).sort((a, b) => a.act.localeCompare(b.act))
  if (reversedC === null) {
    for (const pt of withMoney) out.set(pt.act, (out.get(pt.act) ?? 0) + pt.moneyC)
    return out
  }
  const own = withMoney.filter(pt => charge.intent !== null && pt.intent === charge.intent)
  const otherOnline = withMoney.filter(pt => pt.intent !== null && pt.intent !== charge.intent)
  const desk = own.length || otherOnline.length ? [] : withMoney.filter(pt => pt.intent === null)
  let left = Math.max(0, Math.round(reversedC))
  for (const pt of [...own, ...otherOnline, ...desk]) {
    if (left <= 0) break
    const take = Math.min(pt.moneyC, left)
    out.set(pt.act, (out.get(pt.act) ?? 0) + take)
    left -= take
  }
  return out
}

/** The id a payment is known by: its receipt, else an opaque hash of the act (which may name a Stripe intent or a cover). */
function publicId(d: Draft, kind: LedgerPaymentKind): string {
  if (d.remittance_id) return d.remittance_id
  return `${kind}:${createHash('sha256').update(d.act).digest('hex').slice(0, 24)}`
}

function monthLabel(ymd: string): string {
  return MONTH_NAMES[Number(ymd.slice(5, 7)) - 1] ?? ymd.slice(0, 7)
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

function methodLabel(method: string | null, channel: string | null): string {
  if (method && (LEDGER_OTHER_METHODS as readonly string[]).includes(method)) {
    return LEDGER_OTHER_METHOD_LABEL[method as LedgerOtherMethod]
  }
  return paidByLabel(method, channel) ?? 'Recorded payment'
}

/**
 * One month of the ledger: the payments on that month's bills. Read-only.
 * Scoped by the caller: the account's companies, and a property-locked
 * viewer's properties.
 */
export async function listPaymentsByMonth(opts: PaymentsMonthOptions): Promise<PaymentsMonth> {
  const { landlordIds } = opts
  const propertyIds = opts.propertyIds ?? null
  const currentMonth = todayIn(null).slice(0, 7)
  const month = isLedgerMonth(opts.month) ? opts.month : currentMonth
  if (!landlordIds.length) {
    return { month, months: [currentMonth], payments: [], work_trade: [], still_owe_households: month === currentMonth ? 0 : null }
  }
  const base = [landlordIds, propertyIds]

  // ── Every part of a payment filed under this month ──
  const parts = await query<FiledPart>(
    `WITH ${filedPartsCteSql()}
     SELECT act, src, remittance_id, payment_id, money::text AS money, credit::text AS credit,
            credit_kind, use_status, tenant_id, paid_day, intent
       FROM filed
      WHERE filed_month = $3`,
    [...base, month])

  const drafts = new Map<string, Draft>()
  for (const pt of parts) {
    let d = drafts.get(pt.act)
    if (!d) {
      d = {
        act: pt.act, remittance_id: pt.remittance_id, srcs: new Set(), tenant_id: pt.tenant_id,
        paid_day: pt.paid_day, intent: pt.intent ?? null, parts: new Map(),
        depositInterest: false, otherCredit: false,
      }
      drafts.set(pt.act, d)
    }
    if (!d.intent && pt.intent) d.intent = pt.intent
    d.srcs.add(pt.src)
    const moneyC = cents(pt.money)
    const creditC = cents(pt.credit)
    // Statutory deposit interest is GAM-funded: new money to the landlord the
    // day it pays a bill (money plan §0.0), not credit the landlord gave. Only
    // paid-ahead money is ever funding-reversed (creditUse.clawBackDisputedCharge
    // reverses spends of the disputed charge's own paid-ahead credit), so a
    // reversed use is always credit, never interest.
    const interest = pt.credit_kind === 'deposit_interest'
    const reversedC = !interest && pt.use_status === 'reversed' ? creditC : 0
    addPart(d, pt.payment_id, moneyC + (interest ? creditC : 0), interest ? 0 : creditC, interest ? creditC : 0, reversedC)
    if (creditC > 0 && interest) d.depositInterest = true
    if (creditC > 0 && !interest) d.otherCredit = true
  }

  // ── The receipts' own facts ──
  const receiptIds = [...new Set([...drafts.values()].map(d => d.remittance_id).filter((x): x is string => !!x))]
  const receipts = new Map((receiptIds.length ? await query<ReceiptFacts>(
    `WITH ${remCteSql()}
     SELECT rem.id, rem.tenant_id, rem.status, rem.payment_method, rem.retrying,
            to_char(${propertyDaySql('rem.paid_at', 'rem')}, 'YYYY-MM-DD') AS paid_on,
            CASE WHEN rem.status = 'settled'
                 THEN to_char(${propertyDaySql('COALESCE(rem.settled_at, rem.created_at)', 'rem')}, 'YYYY-MM-DD') END AS arrived_on,
            (SELECT ap.payment_channel FROM remittance_applications ra JOIN payments ap ON ap.id = ra.payment_id
              WHERE ra.remittance_id = rem.id AND ap.payment_channel IS NOT NULL ORDER BY ap.id LIMIT 1) AS channel,
            tr.reference, tr.deposit_photo_url,
            -- 10/5 (Nic): the tenant's report this bank deposit confirmed
            -- (the match's receipt), its flag and its photo.
            CASE WHEN dd.false_date_flagged_at IS NOT NULL THEN to_char(dd.declared_date, 'YYYY-MM-DD') END AS flag_said,
            CASE WHEN dd.false_date_flagged_at IS NOT NULL THEN to_char(dd.bank_posted_date, 'YYYY-MM-DD') END AS flag_bank,
            dd.receipt_photo_url AS tenant_receipt_photo_url
       FROM rem
       JOIN tenant_remittances tr ON tr.id = rem.id
       LEFT JOIN LATERAL (
         SELECT d.declared_date, d.bank_posted_date, d.false_date_flagged_at, d.receipt_photo_url
           FROM tenant_declared_deposits d
           JOIN bank_transactions bt ON bt.id = d.bank_transaction_id
          WHERE d.status = 'confirmed' AND bt.auto_settle_undo->>'receiptId' = tr.id::text
          LIMIT 1) dd ON TRUE
      WHERE rem.id = ANY($2::uuid[])`,
    [landlordIds, receiptIds]) : []).map(r => [r.id, r]))

  // ── Lines, names and figures ──
  const allIds = [...new Set([...drafts.values()].flatMap(d => [...d.parts.keys()]))]
  const facts = await rowFacts(allIds, landlordIds, propertyIds)
  const tenantIds = [...new Set([...drafts.values()].map(d => d.tenant_id).filter((x): x is string => !!x))]
  const names = new Map((tenantIds.length ? await query<{ id: string; name: string }>(
    `SELECT t.id, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name
       FROM tenants t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ANY($1::uuid[])`, [tenantIds]) : [])
    .map(r => [r.id, r.name]))

  // ── What a dispute or bank return took back, charge by charge ──
  // A charge marked 'returned' lost what its reversal records say
  // (returnedByPart), from the act whose card or bank payment was disputed.
  // Under LEDGER_FILED_BY 'bill_month' every part of one charge is filed under
  // the same month (its bill's), so the acts read here are all of them.
  const bounced = (d: Draft) => {
    const r = d.remittance_id ? receipts.get(d.remittance_id) : undefined
    return !!r && r.status === 'failed' && !r.retrying
  }
  const returnedIds = allIds.filter(id => facts.get(id)?.status === 'returned')
  // The MONEY each charge lost: its reversal records, less the paid-ahead
  // credit whose funding was reversed (paymentReversal step 4 / the success
  // webhook write a record for a later bill's credit spend at the use amount,
  // and move that use to 'reversed'). Credit uses on a disputed charge itself
  // stay 'applied' (money plan §3, Dispute), so a 'reversed' use on a charge is
  // exactly its funding-reversal part. That credit is the line's
  // credit_returned, never money taken from the payment's own money.
  const reversedOn = new Map((returnedIds.length ? await query<{ payment_id: string; reversed: string }>(
    `SELECT pr.payment_id,
            GREATEST(0, SUM(pr.reversed_amount)
                        - COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                                     WHERE cu.payment_id = pr.payment_id AND cu.status = 'reversed'), 0))::text AS reversed
       FROM payment_reversals pr WHERE pr.payment_id = ANY($1::uuid[]) GROUP BY pr.payment_id`, [returnedIds]) : [])
    .map(r => [r.payment_id, cents(r.reversed)]))
  /** `${act}|${charge id}` → cents a dispute or return took back from that act's money on that charge. */
  const returnedOn = new Map<string, number>()
  for (const pid of returnedIds) {
    const rp: ReturnablePart[] = []
    for (const d of drafts.values()) {
      const e = d.parts.get(pid)
      // A bank payment that bounced before it cleared never brought money to take back.
      if (e && !bounced(d)) rp.push({ act: d.act, intent: d.intent, moneyC: e[0] - e[2] })
    }
    for (const [act, c] of returnedByPart({ intent: facts.get(pid)!.intent }, rp, reversedOn.get(pid) ?? null)) {
      returnedOn.set(`${act}|${pid}`, c)
    }
  }

  const payments: LedgerPayment[] = []
  /**
   * Cents of each listed payment that count in the month total (decisions #25;
   * held deposits per the switch): [money, credit that still stands, money
   * taken back, credit whose funding was taken back].
   */
  const totalMoney = new Map<string, [number, number, number, number]>()
  /** Whether each listed payment's money arrived (a receipt that bounced never did). */
  const arrived = new Map<string, boolean>()
  for (const d of drafts.values()) {
    const receipt = d.remittance_id ? receipts.get(d.remittance_id) : undefined
    if (d.remittance_id && !receipt) continue
    const kind: LedgerPaymentKind = receipt ? 'receipt' : d.srcs.has('settled') ? 'settled' : 'credit'

    const lines: LedgerLine[] = []
    const didArrive = receipt ? receipt.status === 'settled' : true
    let moneyReturned = false, creditTakenBack = false
    const wholeBounce = bounced(d)
    let countedMoney = 0, countedCredit = 0, countedReturned = 0, countedCreditReturned = 0
    let settledRow: RowFacts | undefined
    for (const [pid, [moneyC, creditC, interestC, creditReversedC]] of d.parts) {
      const f = facts.get(pid)
      if (!f || (moneyC <= 0 && creditC <= 0)) continue
      // Money a dispute or bank return later took back from this charge: only
      // what its record says it lost (returnedByPart). A bounced bank payment
      // came back whole.
      const returnedC = wholeBounce ? moneyC - interestC : (returnedOn.get(`${d.act}|${pid}`) ?? 0)
      // Paid-ahead credit on it whose own money was taken back since: the
      // charge is owed again for that part (a reopened row), so this payment
      // no longer pays all it did. Its own money stays (returnedC says so).
      if (returnedC > 0) moneyReturned = true
      if (creditReversedC > 0) creditTakenBack = true
      if (!settledRow && kind === 'settled' && moneyC > 0) settledRow = f
      if (countsInLedgerTotal(f)) {
        countedMoney += moneyC
        countedCredit += creditC - creditReversedC
        countedReturned += returnedC
        countedCreditReturned += creditReversedC
      }
      lines.push({
        payment_id: pid,
        label: chargeLabel(f),
        detail: chargeDetail(f),
        due_date: f.due_date,
        amount: Number(f.amount),
        paid: dollars(moneyC),
        credit: dollars(creditC),
        returned: dollars(returnedC),
        credit_returned: dollars(creditReversedC),
        unit_number: f.unit_number,
        property_name: f.property_name,
      })
    }
    if (!lines.length) continue
    lines.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.label.localeCompare(b.label))

    const method: string | null = receipt ? receipt.payment_method
      : kind === 'settled' ? (settledRow?.manual_method ?? (settledRow?.online ? 'online' : null))
      : (d.depositInterest && !d.otherCredit) ? 'deposit_interest' : 'credit'
    const channel = receipt ? receipt.channel : (settledRow?.payment_channel ?? null)
    // A receipt: the day they paid (the postmark). A bill paid from credit and
    // nothing else: decisions #36.A (creditPaidOnDay). Anything else settled:
    // the day it settled.
    const paidOn = receipt ? receipt.paid_on
      : kind === 'credit' ? creditPaidOnDay(d.paid_day, lines[0].due_date)
      : d.paid_day
    const paidC = lines.reduce((s, l) => s + cents(l.paid), 0)
    const creditC = lines.reduce((s, l) => s + cents(l.credit), 0)
    const returnedC = lines.reduce((s, l) => s + cents(l.returned), 0)
    const creditReturnedC = lines.reduce((s, l) => s + cents(l.credit_returned), 0)
    const status = ledgerPaymentStatus({
      receipt: receipt ?? null, moneyReturned, creditTakenBack,
      nothingStands: paidC === 0 && creditC > 0 && creditReturnedC >= creditC,
    })
    // On time or late: from the oldest bill it paid, honoring that bill's
    // grace, on the day they paid (the postmark).
    const oldest = lines[0]
    const late = daysLate(oldest.due_date, paidOn, Number(facts.get(oldest.payment_id)!.grace_days))
    const where = lines.map(l => facts.get(l.payment_id)!)
    const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))]
    const id = publicId(d, kind)
    totalMoney.set(id, [countedMoney, countedCredit, countedReturned, countedCreditReturned])
    arrived.set(id, didArrive)
    payments.push({
      id,
      kind,
      tenant_id: d.tenant_id,
      name: (d.tenant_id && names.get(d.tenant_id)) || 'Resident',
      unit_number: uniq(where.map(w => w.unit_number)).join(', ') || null,
      property_id: where[0]?.property_id ?? null,
      property_name: uniq(where.map(w => w.property_name)).join(', ') || null,
      paid_on: paidOn,
      // A bill paid from credit alone: no money arrived. Deposit interest is
      // money (§0.0) that arrived the day it paid the bill (the act's own day),
      // even when the line reads the bill's later due date.
      arrived_on: receipt ? receipt.arrived_on
        : status === 'clearing' ? null
        : kind === 'credit' ? (paidC > 0 ? d.paid_day : null)
        : paidOn,
      owed: dollars(paidC + creditC),
      amount: dollars(paidC),
      credit_applied: dollars(creditC),
      returned: dollars(returnedC),
      credit_returned: dollars(creditReturnedC),
      method,
      method_label: methodLabel(method, channel),
      receipt_id: receipt ? receipt.id : null,
      reference: receipt?.reference ?? null,
      deposit_photo_url: receipt?.deposit_photo_url ?? null,
      deposit_date_flag: receipt?.flag_said && receipt?.flag_bank ? { said: receipt.flag_said, bank: receipt.flag_bank } : null,
      tenant_receipt_photo_url: receipt?.tenant_receipt_photo_url ?? null,
      status,
      status_label: LEDGER_PAYMENT_STATUS_LABEL[status],
      paid_for: uniq(lines.map(l => `${monthLabel(l.due_date)} ${lowerFirst(l.label)}`)).join(', '),
      days_late: late,
      timing_label: late > 0 ? `${late} ${late === 1 ? 'day' : 'days'} late` : 'On time',
      lines,
    })
  }
  payments.sort((a, b) => b.paid_on.localeCompare(a.paid_on) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

  // ── Work-trade households: one line for the month, no amount ──
  const workTrade = await query<{ tenant_id: string; name: string | null; unit_number: string | null; property_name: string | null }>(
    `WITH ${workTradeBillsCteSql()}
     SELECT DISTINCT ON (t.id) t.id AS tenant_id,
            NULLIF(TRIM(CONCAT_WS(' ', tu.first_name, tu.last_name)), '') AS name,
            u.unit_number, pr.name AS property_name
       FROM wt
       JOIN tenants t          ON t.id = wt.tenant_id
       LEFT JOIN users tu      ON tu.id = t.user_id
       LEFT JOIN units u       ON u.id = wt.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE ${ledgerMonthSql({ billDue: 'wt.due' })} = $3
      ORDER BY t.id, wt.due`,
    [...base, month])

  // ── The picker: every month with a payment or a work-trade line, newest first ──
  const monthRows = await query<{ m: string }>(
    `WITH ${filedPartsCteSql()}, ${workTradeBillsCteSql()}
     SELECT DISTINCT m FROM (
       SELECT filed_month AS m FROM filed
       UNION
       SELECT ${ledgerMonthSql({ billDue: 'wt.due' })} FROM wt
     ) x WHERE m IS NOT NULL ORDER BY m DESC LIMIT 60`,
    base)
  const months = [...new Set([currentMonth, month, ...monthRows.map(r => r.m)])].sort().reverse()

  const out: PaymentsMonth = {
    month,
    months,
    payments,
    work_trade: workTrade.map(w => ({
      tenant_id: w.tenant_id, name: w.name || 'Resident', unit_number: w.unit_number,
      property_name: w.property_name, label: WORK_TRADE_COVERED_LABEL,
    })),
    // "N households still owe — see Outstanding Balances": a count, never dollars.
    still_owe_households: month === currentMonth
      ? (await listOpenTenantBalances({ landlordIds, propertyIds })).length
      : null,
  }
  if (opts.withTotals) {
    // Money that arrived on this month's bills (a dispute since does not move
    // it out of the month), money still clearing, and the credit that paid them.
    // Of the money that arrived, what a dispute or bank return has taken back
    // since: each charge's own loss (its reversal record), so a $100 dispute of
    // a $460 rent payment leaves $360 of it with the landlord. Credit counts
    // only while it stands: paid-ahead credit whose own money was taken back
    // is beside it (credit_returned_since), so once the reopened part is paid
    // again the month adds up to the bill, every dollar once.
    const sum = (pick: (p: LedgerPayment) => boolean, i: 0 | 1 | 2 | 3) =>
      dollars(payments.filter(pick).reduce((s, p) => s + (totalMoney.get(p.id)?.[i] ?? 0), 0))
    const came = (p: LedgerPayment) => p.status !== 'clearing' && arrived.get(p.id) === true
    out.totals = {
      paid: sum(came, 0),
      paid_from_credit: sum(came, 1),
      returned_since: sum(came, 2),
      credit_returned_since: sum(came, 3),
      clearing: sum(p => p.status === 'clearing', 0),
      payments: payments.length,
    }
  }
  return out
}
