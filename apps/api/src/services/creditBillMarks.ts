/**
 * ONE MARK PER BILL (10/12, Nic):
 *
 *   "the payment history should be a health percentage. one mark per invoice."
 *
 * A tenant's payment history on the credit ledger is ONE mark per invoice — the
 * household's bill — never one per line. Before this every rent and utility
 * row carried its own mark (rent on time, electric late, water within grace):
 * three marks a month on a bill the Rent Roll judged once, so the credit
 * screens' "on-time %" and the household's payment health never agreed.
 *
 * WHAT A BILL IS: an invoice and every charge on it. A charge written on no
 * invoice (a longer stay's extra rent, services/bookingLeaseBilling) belongs to
 * its lease's invoice due the same day when there is one; otherwise it is a
 * bill of its own. The bill key is the invoice's id, or "row:<payment id>".
 *
 * THE RATING IS THE PAYMENT-HEALTH RULE (services/householdMonths: one stamp
 * per household per bill, judgeMonth), applied to the bill's lines:
 *   paid on time  every base charge (rent, utilities, fees, home payment) paid
 *                 in full by its last grace day; a bill work trade covers in
 *                 full is on time                       → payment_received_on_time
 *   paid late     paid in full, some of it after its grace period, by the most
 *                 days past grace of any line           → late_minor (1–3 days)
 *                                                          late_major (4–15)
 *                                                          late_severe (16+)
 *   partial       money or credit came in, something still owed, past grace
 *                                                        → payment_partial
 *   outstanding   nothing came in and a charge is past its grace period
 *                                                        → payment_skipped
 *   due / partial inside grace: not judged yet — no mark.
 * Late = the one lateness rule (services/lateness): lateness starts on the due
 * date or the day GAM wrote the line when later, the first late day is start +
 * grace (the 6th for the 1st with 5 days; with 0 days the day after), grace =
 * the lease's, else the property's, else 5. A bank deposit matched to a line
 * decides its day. Late fees and $0 lines are never their own mark and never
 * decide the bill. Voided lines and voided bills are left out (a voided bill
 * loses its mark). History imported from another platform is never on a bill
 * (10/12, Nic: "health starts with the first bill GAM wrote"). A line the desk
 * logged by hand after a late fee was charged on its bill, with no bank line
 * matched to it, counts from the day GAM recorded it (10/6, Nic: "no
 * exceptions"; see billsJudgeSql). The ONBOARDING
 * month (the first rent month of an existing tenancy moved onto GAM; voided
 * rent excluded) is good news only: on time earns its mark, anything else
 * earns none — unless a late fee was charged on the bill (10/6).
 *
 * THE LEDGER'S RULES HOLD (Credit Ledger v1): marks are appended, never edited
 * or deleted. When a bill's outcome changes (outstanding → paid late, a payment
 * reversed, a bank match moving the day) a new mark is appended naming the one
 * it corrects (corrects_event_id) and the old one is superseded
 * ('bill_status_changed'). The per-line marks written before 10/12 are
 * replaced the same way ('replaced_by_bill_mark', listed in replaces_event_ids).
 * A mark the bill no longer earns is withdrawn: it points at itself,
 * 'attestation_invalidated'. A bill whose mark an admin corrected after a
 * dispute is left alone, and so is a bill while a dispute of one of its marks
 * is open (10/12). While money on a base line is still clearing the bill
 * is left as it is (a mark is never written on money that may bounce); it is
 * judged again when the money settles.
 *
 * WHO RUNS IT: every settle (services/settleHooks → creditLedgerEmitters, in
 * the settle's own transaction — the mark moves with the money), a bank-date
 * match and its undo, a late fee deleted in the onboarding month, a failed
 * payment; the nightly credit run (jobs/creditNightly) for every bill whose
 * state can still change (a bill going past grace changes nothing in the
 * database); and scripts/oct12_rerate_late_marks, the rebuild of every history.
 */
import type { PoolClient } from 'pg'
import type { CreditEventType, CreditNetworkVisibility, PaymentStamp } from '@gam/shared'
import { db } from '../db'
import { appendEvent, supersedeEvent, getOrCreateSubject } from './creditLedger'
import { judgeMonth, householdOfRowSql, BASE_CHARGE_TYPES } from './householdMonths'
import { openBalanceSql, inFlightRowSql, workTradeOpenRowSql } from './openBalances'
import { payableRowSql } from './moneyPredicates'
import {
  graceDaysSql, propertyDaySql, writtenAtSql, lateCountsFromSql, firstLateDaySql, daysPastGraceSql, pastGraceSql,
} from './lateness'
import { logger } from '../lib/logger'

type Q = Pick<PoolClient, 'query'>

/** event_data.mark_basis of a bill mark (the per-line marks before 10/12 carry none). */
export const BILL_MARK_BASIS = 'invoice'
/** event_data.rule: the rule a bill mark was rated by. */
export const BILL_MARK_RULE = 'payment_health_2026_10_12'
/** The bill key of a charge on no invoice that is a bill of its own. */
export const ROW_BILL_PREFIX = 'row:'

/** The payment-history event types (the marks a bill or, before 10/12, a line could carry). */
export const PAYMENT_MARK_TYPES: readonly CreditEventType[] = [
  'payment_received_on_time', 'payment_received_late_grace', 'payment_received_late_minor',
  'payment_received_late_major', 'payment_received_late_severe', 'payment_partial', 'payment_skipped',
  'payment_failed_nsf',
]

const BASE_TYPES_SQL = `'{${BASE_CHARGE_TYPES.join(',')}}'::text[]`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Bill keys → the invoice ids and the charge rows that are bills of their own. */
function splitKeys(keys: readonly string[]): { invoiceIds: string[]; rowIds: string[] } {
  const invoiceIds: string[] = []
  const rowIds: string[] = []
  for (const k of new Set(keys)) {
    if (k.startsWith(ROW_BILL_PREFIX)) {
      const id = k.slice(ROW_BILL_PREFIX.length)
      if (UUID.test(id)) rowIds.push(id)
    } else if (UUID.test(k)) invoiceIds.push(k)
  }
  return { invoiceIds: invoiceIds.sort(), rowIds: rowIds.sort() }
}

/** The mark a judged bill earns. Days are days past the grace period (paid on the first late day = 1). */
export function billMarkEventType(stamp: PaymentStamp | null, days: number): CreditEventType | null {
  switch (stamp) {
    case 'paid_on_time': return 'payment_received_on_time'
    case 'paid_late':    return days <= 3 ? 'payment_received_late_minor' : days <= 15 ? 'payment_received_late_major' : 'payment_received_late_severe'
    case 'partial':      return 'payment_partial'
    case 'outstanding':  return 'payment_skipped'
    default:             return null
  }
}

/** A good mark the current landlord sees; anything adverse the GAM network sees (as every payment mark always has). */
export function billMarkVisibility(t: CreditEventType): CreditNetworkVisibility {
  return t === 'payment_received_on_time' || t === 'payment_received_late_grace' ? 'visible_to_current_landlord' : 'visible_to_gam_network'
}

export interface BillJudgeOptions {
  /** 'YYYY-MM-DD': the day to judge on (tests). Default: each property's today. */
  asOf?: string | null
  /**
   * payment id → 'YYYY-MM-DD': the bank's day for a line a bank deposit is
   * being matched to in this transaction, before its allocation row is written
   * (creditLedgerEmitters.reRateMarksFromBankDate).
   */
  bankDays?: Readonly<Record<string, string>>
  /** Lines whose bank match is being undone in this transaction: their bank allocations are not read. */
  ignoreBankFor?: readonly string[]
  /**
   * Lines a matched bank line is paying in this transaction, before its
   * allocation rows are written (services/bankDepositConfirm settles each line
   * first): their settled day is the bank's day, so the 10/6 hand-logged rule
   * (counted from the day GAM recorded it) does not apply to them.
   */
  bankValidatedIds?: readonly string[]
}

/** One bill judged by the payment-health rule. Money in dollars. */
export interface BillJudgement {
  /** The invoice's id, or "row:<payment id>" for a charge on no invoice that is a bill of its own. */
  billKey: string
  /** null: a charge on no invoice. */
  invoiceId: string | null
  invoiceNumber: string | null
  landlordId: string | null
  leaseId: string | null
  /** The household: the lease's primary resident, else the person billed (the mark's subject). */
  householdId: string | null
  dueDate: string
  /** YYYY-MM: the bill's month. */
  month: string
  voided: boolean
  stamp: PaymentStamp | null
  days: number
  counted: boolean
  onTime: boolean
  workTradeOnly: boolean
  onboarding: boolean
  lateFeeOnBill: boolean
  graceDays: number
  firstLateDay: string | null
  paidInFullOn: string | null
  chargedBase: number
  workTrade: number
  owedBase: number
  /** Money on a base line is still clearing: the bill is left as it is. */
  clearing: boolean
  /** 10/6: a line logged by hand after a late fee was charged counted from the day GAM recorded it. */
  loggedAfterLateFee: boolean
  /** 10/6: a bank line matched to a line decided its day. */
  bankValidated: boolean
  /** The base lines judged. */
  paymentIds: string[]
  /** How the money on it was vouched for: methods the desk recorded (no bank line), receipt references, card/bank payments. */
  manualMethods: string[]
  references: string[]
  stripeIntents: string[]
  /** The mark the bill earns now (null: none). */
  mark: CreditEventType | null
}

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number) => Math.round(c) / 100

/** The value a line a past work trade covered at $0 carries in its note (householdMonths' WT_NOTE_VALUE). */
const WT_NOTE_VALUE = `COALESCE(substring(p.notes from 'Covered by work trade \\(\\$([0-9]+(\\.[0-9]+)?)\\)')::numeric, 0)`

/**
 * The invoice a charge belongs to (alias `p`): its own, else its lease's
 * invoice due the same day (a longer stay's extra rent is written on no
 * invoice). NULL: a bill of its own.
 */
function billInvoiceSql(p = 'p'): string {
  return `COALESCE(${p}.invoice_id,
            (SELECT ai.id FROM invoices ai
              WHERE ${p}.invoice_id IS NULL AND ${p}.lease_id IS NOT NULL
                AND ai.lease_id = ${p}.lease_id AND ai.due_date = ${p}.due_date AND ai.status <> 'void'
              ORDER BY ai.created_at, ai.id LIMIT 1))`
}

/**
 * The bills asked for, judged — householdMonths' rows CTE (rowsCteSql) for
 * their lines, run on the caller's client so a settle's own uncommitted rows
 * are read. Kept line for line with it; the tests compare the two on the same
 * bills (creditBillMarks.test.ts, "the same stamp as the Rent Roll") — with
 * ONE difference householdMonths has not taken yet (10/12 review): the 10/6
 * hand-logged rule (recorded_day below: logged by hand after a late fee, no
 * bank match, counts from the day GAM recorded it). Such a bill reads on time
 * on the Rent Roll and late here until rowsCteSql applies it too. Every
 * line on the bill counts, whichever company billed it (a neighbor company's
 * utility on the household's bill is on the bill).
 * $1 invoice ids, $2 the day to judge on (null: each property's today), $3
 * bank-day overrides (jsonb, payment id → day), $4 lines whose bank
 * allocations are not read, $5 lines a bank line is paying now
 * (bank-validated), $6 charge rows on no invoice that are bills of their own.
 */
function billsJudgeSql(): string {
  const today = `COALESCE($2::date, ${propertyDaySql('NOW()', 'pr')})`
  return `
  WITH scope AS (
    SELECT p.id AS pid, p.invoice_id AS bill_inv FROM payments p WHERE p.invoice_id = ANY($1::uuid[])
    UNION
    SELECT p.id, ai.id FROM invoices ai
      JOIN payments p ON p.invoice_id IS NULL AND p.lease_id = ai.lease_id AND p.due_date = ai.due_date
     WHERE ai.id = ANY($1::uuid[]) AND ai.status <> 'void'
       AND ai.id = ${billInvoiceSql('p')}
    UNION
    SELECT p.id, NULL::uuid FROM payments p WHERE p.id = ANY($6::uuid[]) AND p.invoice_id IS NULL
  ),
  base AS (
    SELECT p.id, COALESCE(s.bill_inv::text, '${ROW_BILL_PREFIX}' || p.id::text) AS bill_key,
           p.type, p.status, p.amount, p.notes, p.created_at,
           COALESCE(inv.due_date, p.due_date) AS bill_due,
           ${householdOfRowSql('p', 'inv')} AS household_id,
           ${graceDaysSql('l', 'pr')}::int AS grace,
           ${propertyDaySql(writtenAtSql('p'), 'pr')} AS written_day,
           ${today} AS today,
           ${openBalanceSql('p')} AS is_open,
           ${inFlightRowSql('p')} AS in_flight,
           ${workTradeOpenRowSql('p')} AS wt_open,
           (${payableRowSql('p')} AND NOT ${openBalanceSql('p')}) AS not_owed_any_more,
           CASE WHEN p.amount = 0 AND p.status = 'settled' THEN ${WT_NOTE_VALUE} ELSE 0 END AS wt_note_value,
           COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status = 'applied'), 0) AS credit_applied,
           COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('held','applied')), 0) AS credit_set,
           (SELECT MAX(cu.applied_at) FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status = 'applied') AS credit_at,
           (SELECT MAX(CASE WHEN tr.stripe_payment_intent_id IS NOT NULL THEN tr.created_at
                            ELSE COALESCE(tr.settled_at, tr.created_at) END)
              FROM remittance_applications ra JOIN tenant_remittances tr ON tr.id = ra.remittance_id
             WHERE ra.payment_id = p.id AND tr.status <> 'failed') AS receipt_at,
           COALESCE(($3::jsonb ->> p.id::text)::date,
                    CASE WHEN p.id = ANY($4::uuid[]) THEN NULL
                         ELSE (SELECT MIN(bda.effective_paid_date) FROM bank_deposit_allocations bda
                                WHERE bda.payment_id = p.id AND bda.reversed_at IS NULL) END) AS bank_day,
           ${propertyDaySql('p.settled_at', 'pr')} AS settled_day,
           pr.timezone,
           p.manual_method,
           -- Who vouches for the money (the mark's attestation): the receipt's
           -- reference (a check number) and its card or bank payment, if any.
           (SELECT tr.reference FROM remittance_applications ra JOIN tenant_remittances tr ON tr.id = ra.remittance_id
             WHERE ra.payment_id = p.id AND tr.status <> 'failed' AND tr.reference IS NOT NULL
             ORDER BY tr.created_at DESC, tr.id LIMIT 1) AS receipt_reference,
           (SELECT tr.stripe_payment_intent_id FROM remittance_applications ra JOIN tenant_remittances tr ON tr.id = ra.remittance_id
             WHERE ra.payment_id = p.id AND tr.status <> 'failed' AND tr.stripe_payment_intent_id IS NOT NULL
             ORDER BY tr.created_at DESC, tr.id LIMIT 1) AS receipt_intent,
           (p.id = ANY($5::uuid[])) AS bank_validated,
           -- 10/6 (Nic): when GAM recorded the line as paid (the change journal:
           -- the change that settled it — the latest one: a payment undone and
           -- recorded again counts from the second time), and when the bill's
           -- first late fee still standing was charged. See paid_day below.
           (SELECT MAX(ar.changed_at) FROM audit_row_changes ar
             WHERE ar.table_name = 'payments' AND ar.row_id = p.id
               AND ar.new_row->>'status' IN ('settled', 'paid_via_deposit')
               AND COALESCE(ar.old_row->>'status', '') NOT IN ('settled', 'paid_via_deposit')) AS recorded_at,
           (SELECT MIN(f.created_at) FROM payments f
             WHERE f.type = 'late_fee' AND f.amount > 0 AND f.status <> 'voided'
               AND (f.invoice_id = s.bill_inv OR f.id = p.id)) AS first_fee_at,
           -- 10/12: voided rent never decides which month was the onboarding
           -- month, and neither does history imported from another platform
           -- (10/12 (Nic): "health starts with the first bill GAM wrote" —
           -- householdMonths reads the onboarding month the same way).
           (COALESCE(l.is_existing_tenancy, FALSE)
            AND date_trunc('month', COALESCE(inv.due_date, p.due_date)) = (
                  SELECT date_trunc('month', MIN(p2.due_date)) FROM payments p2
                   WHERE p2.lease_id = l.id AND p2.type = 'rent' AND p2.status <> 'voided'
                     AND p2.import_source IS NULL)) AS onboarding
      FROM scope s
      JOIN payments p          ON p.id = s.pid
      LEFT JOIN invoices inv   ON inv.id = s.bill_inv
      LEFT JOIN units u        ON u.id  = p.unit_id
      LEFT JOIN properties pr  ON pr.id = u.property_id
      LEFT JOIN leases l       ON l.id  = COALESCE(p.lease_id, inv.lease_id)
     WHERE COALESCE(p.revenue_owner, 'landlord') NOT IN ('gam', 'held')
       AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
       AND p.type NOT IN ('platform_fee', 'float_fee')
       AND p.status NOT IN ('voided', 'returned')
       AND (inv.id IS NULL OR inv.status <> 'void')
       -- 10/12 (Nic): "CSV-imported old payment history does NOT count toward
       -- payment health — health starts with the first bill GAM wrote." A row
       -- brought in from another platform (import_source) is never on a bill
       -- here — never a bill of its own, never a line of one — exactly as
       -- householdMonths leaves it out of every month and health figure.
       AND p.import_source IS NULL
  ),
  rows AS (
    SELECT b.*,
           (b.type = ANY(${BASE_TYPES_SQL})) AS is_base,
           (b.type = 'late_fee') AS is_late_fee,
           (b.amount + b.wt_note_value) AS charged,
           (CASE WHEN b.wt_open THEN b.amount ELSE 0 END + b.wt_note_value) AS wt,
           CASE WHEN b.in_flight THEN b.credit_set ELSE b.credit_applied END AS credit,
           GREATEST(0, CASE WHEN b.status IN ('settled','paid_via_deposit') AND b.wt_note_value = 0 THEN b.amount - b.credit_applied
                            WHEN b.in_flight THEN b.amount - b.credit_set ELSE 0 END) AS paid,
           CASE WHEN b.is_open THEN GREATEST(0, b.amount - b.credit_applied) ELSE 0 END AS owed,
           CASE WHEN b.wt_open OR b.wt_note_value > 0 OR COALESCE(b.notes, '') ILIKE '%covered by work%trade%' THEN b.bill_due
                WHEN b.status IN ('settled','paid_via_deposit') OR b.in_flight THEN
                  COALESCE(b.bank_day,
                           GREATEST(${propertyDaySql('b.receipt_at', 'b')},
                                    CASE WHEN b.credit_at IS NOT NULL THEN GREATEST(${propertyDaySql('b.credit_at', 'b')}, b.bill_due) END),
                           b.settled_day, b.today)
           END AS money_day,
           -- ── 10/6 (Nic), CONFIRMED TABLE: "Landlord logs by hand, no bank
           -- match → late fee: credit against the bill; history: LATE." A line
           -- the desk logged by hand (cash, check, money order, a deposit it
           -- typed in) after a late fee was charged on its bill, with no bank
           -- line matched to it, counts from the day GAM recorded it — never
           -- from an earlier day typed on it ("the late payment still shows on
           -- their payment history" — no exceptions). A bank match decides by
           -- the bank's day instead; a late fee the landlord deleted (voided)
           -- or the bank took off ($0) is not on the bill. The Rent Roll's
           -- payment health (householdMonths) does not apply this yet: a bill
           -- like this reads on time there and late here.
           CASE WHEN b.manual_method IS NOT NULL AND b.status IN ('settled','paid_via_deposit') AND NOT b.in_flight
                     AND NOT (b.wt_open OR b.wt_note_value > 0)
                     AND b.bank_day IS NULL AND NOT b.bank_validated
                     AND b.first_fee_at IS NOT NULL AND b.recorded_at IS NOT NULL
                     AND b.first_fee_at <= b.recorded_at
                THEN ${propertyDaySql('b.recorded_at', 'b')} END AS recorded_day
      FROM base b
     WHERE NOT b.not_owed_any_more
       AND (b.amount > 0 OR b.wt_note_value > 0)
  ),
  dated AS (
    SELECT r.*,
           CASE WHEN r.recorded_day IS NOT NULL AND r.money_day IS NOT NULL THEN GREATEST(r.money_day, r.recorded_day)
                ELSE r.money_day END AS paid_day,
           (r.recorded_day IS NOT NULL AND r.money_day IS NOT NULL AND r.recorded_day > r.money_day) AS logged_after_fee,
           (r.status IN ('settled','paid_via_deposit') AND (r.bank_day IS NOT NULL OR r.bank_validated)) AS bank_dated
      FROM rows r
  ),
  timed AS (
    SELECT r.*,
           ${lateCountsFromSql('r.bill_due', 'r.written_day', 'COALESCE(r.paid_day, r.today)')} AS late_start
      FROM dated r
  ),
  judged AS (
    SELECT t.*,
           ${firstLateDaySql('t.late_start', 't.grace')} AS first_late_day,
           CASE WHEN t.wt > 0 AND t.owed = 0 THEN 0
                WHEN t.owed > 0 THEN ${daysPastGraceSql('t.today', 't.late_start', 't.grace')}
                WHEN t.paid_day IS NOT NULL THEN ${daysPastGraceSql('t.paid_day', 't.late_start', 't.grace')}
                ELSE 0 END AS days_past_grace,
           ${pastGraceSql('t.today', 't.late_start', 't.grace')} AS past_grace_now
      FROM timed t
  ),
  parts AS (
    SELECT j.bill_key, j.id AS payment_id, j.household_id, j.created_at, j.is_base, j.is_late_fee,
           j.charged, j.paid, j.credit, j.wt, j.owed, j.days_past_grace, j.past_grace_now, j.paid_day,
           j.first_late_day, j.onboarding, j.grace, j.in_flight, j.logged_after_fee, j.bank_dated,
           j.manual_method, j.receipt_reference, j.receipt_intent
      FROM judged j
    UNION ALL
    -- What a month close settled (jobs/workTradeSettlement): the hours' value
    -- lives on the invoice (householdMonths' wt_closed).
    SELECT inv.id::text, NULL::uuid, NULL::uuid, inv.created_at, TRUE, FALSE,
           inv.work_trade_credit_amount, 0, 0, inv.work_trade_credit_amount, 0, 0, FALSE, inv.due_date,
           NULL::date, FALSE, NULL::int, FALSE, FALSE, FALSE, NULL::text, NULL::text, NULL::text
      FROM invoices inv
     WHERE inv.id = ANY($1::uuid[]) AND inv.work_trade_credit_amount > 0 AND inv.status <> 'void'
  )
  SELECT x.bill_key,
         COALESCE(SUM(x.charged) FILTER (WHERE x.is_base), 0)::text        AS charged_base,
         COALESCE(SUM(x.wt) FILTER (WHERE x.is_base), 0)::text             AS wt_base,
         COALESCE(SUM(x.owed) FILTER (WHERE x.is_base), 0)::text           AS owed_base,
         COALESCE(SUM(x.paid + x.credit) FILTER (WHERE x.is_base), 0)::text AS base_in,
         COALESCE(bool_or(x.is_base AND x.owed > 0 AND x.past_grace_now), FALSE) AS open_past_grace,
         MAX(x.days_past_grace) FILTER (WHERE x.is_base AND x.owed > 0)::int     AS dpg_open,
         MAX(x.days_past_grace) FILTER (WHERE x.is_base AND x.owed = 0)::int     AS dpg_paid,
         to_char(MAX(x.paid_day) FILTER (WHERE x.is_base AND x.owed = 0), 'YYYY-MM-DD') AS last_paid_on,
         to_char(MIN(x.first_late_day) FILTER (WHERE x.is_base), 'YYYY-MM-DD') AS first_late_day,
         COALESCE(bool_or(x.onboarding) FILTER (WHERE x.is_base), FALSE)        AS onboarding,
         COALESCE(bool_or(x.is_late_fee AND x.charged > 0), FALSE)              AS late_fee_on_bill,
         MAX(x.grace) FILTER (WHERE x.is_base)::int                             AS grace,
         COALESCE(bool_or(x.is_base AND x.in_flight), FALSE)                    AS clearing,
         COALESCE(bool_or(x.is_base AND x.logged_after_fee), FALSE)             AS logged_after_fee,
         COALESCE(bool_or(x.is_base AND x.bank_dated), FALSE)                   AS bank_dated,
         (array_agg(x.household_id::text ORDER BY x.is_base DESC, x.created_at, x.payment_id)
            FILTER (WHERE x.household_id IS NOT NULL))[1]                       AS household_id,
         COALESCE(array_agg(DISTINCT x.manual_method)
            FILTER (WHERE x.is_base AND x.paid > 0 AND x.manual_method IS NOT NULL AND NOT x.bank_dated), '{}') AS manual_methods,
         COALESCE(array_agg(DISTINCT x.receipt_reference)
            FILTER (WHERE x.is_base AND x.paid > 0 AND x.receipt_reference IS NOT NULL), '{}') AS refs,
         COALESCE(array_agg(DISTINCT x.receipt_intent)
            FILTER (WHERE x.is_base AND x.paid > 0 AND x.receipt_intent IS NOT NULL), '{}') AS intents,
         COALESCE(array_agg(x.payment_id::text ORDER BY x.created_at, x.payment_id)
            FILTER (WHERE x.is_base AND x.payment_id IS NOT NULL), '{}')        AS payment_ids
    FROM parts x
   GROUP BY x.bill_key`
}

interface AggRow {
  bill_key: string
  charged_base: string; wt_base: string; owed_base: string; base_in: string
  open_past_grace: boolean; dpg_open: number | null; dpg_paid: number | null; last_paid_on: string | null
  first_late_day: string | null; onboarding: boolean; late_fee_on_bill: boolean; grace: number | null
  clearing: boolean; logged_after_fee: boolean; bank_dated: boolean; household_id: string | null; payment_ids: string[]
  manual_methods: string[]; refs: string[]; intents: string[]
}

interface BillMeta {
  bill_key: string; invoice_id: string | null; invoice_number: string | null; landlord_id: string | null
  lease_id: string | null; due_date: string; voided: boolean; household_id: string | null
}

/** What each bill is: its invoice (number, company, lease, due date, voided?) or its lone charge, and its household. */
async function billMeta(q: Q, invoiceIds: readonly string[], rowIds: readonly string[]): Promise<BillMeta[]> {
  const { rows } = await q.query<BillMeta>(
    `SELECT inv.id::text AS bill_key, inv.id::text AS invoice_id, inv.invoice_number, inv.landlord_id::text AS landlord_id,
            inv.lease_id::text AS lease_id, to_char(inv.due_date, 'YYYY-MM-DD') AS due_date, (inv.status = 'void') AS voided,
            COALESCE((SELECT hh_lt.tenant_id FROM lease_tenants hh_lt
                       WHERE hh_lt.lease_id = inv.lease_id AND hh_lt.role = 'primary' AND hh_lt.status <> 'void'
                       ORDER BY (hh_lt.status = 'active') DESC, hh_lt.created_at, hh_lt.id LIMIT 1),
                     inv.tenant_id)::text AS household_id
       FROM invoices inv WHERE inv.id = ANY($1::uuid[])
     UNION ALL
     SELECT '${ROW_BILL_PREFIX}' || p.id::text, NULL, NULL, p.landlord_id::text, p.lease_id::text,
            to_char(p.due_date, 'YYYY-MM-DD'), (p.status = 'voided'),
            ${householdOfRowSql('p', 'inv')}::text
       FROM payments p LEFT JOIN invoices inv ON FALSE
      WHERE p.id = ANY($2::uuid[]) AND p.invoice_id IS NULL AND p.due_date IS NOT NULL`,
    [[...invoiceIds], [...rowIds]])
  return rows
}

/** Judge these bills by the payment-health rule, on the caller's client (or the pool). Oldest bill first. */
export async function judgeBills(q: Q, billKeys: readonly string[], opts: BillJudgeOptions = {}): Promise<BillJudgement[]> {
  const { invoiceIds, rowIds } = splitKeys(billKeys)
  if (invoiceIds.length === 0 && rowIds.length === 0) return []
  const [metas, aggs] = await Promise.all([
    billMeta(q, invoiceIds, rowIds),
    q.query<AggRow>(billsJudgeSql(),
      [invoiceIds, opts.asOf ?? null, JSON.stringify(opts.bankDays ?? {}), [...(opts.ignoreBankFor ?? [])],
       [...(opts.bankValidatedIds ?? [])], rowIds]).then(r => r.rows),
  ])
  const byKey = new Map(aggs.map(a => [a.bill_key, a]))
  return metas.map(m => {
    const r = byKey.get(m.bill_key)
    const j = judgeMonth({
      chargedBaseC: cents(r?.charged_base), workTradeBaseC: cents(r?.wt_base), owedBaseC: cents(r?.owed_base),
      baseInC: cents(r?.base_in), openPastGrace: r?.open_past_grace === true,
      daysPastGraceOpen: Number(r?.dpg_open ?? 0), daysPastGracePaid: Number(r?.dpg_paid ?? 0),
      onboarding: r?.onboarding === true, lateFeeOnBill: r?.late_fee_on_bill === true,
    })
    const paidInFull = cents(r?.charged_base) > 0 && cents(r?.owed_base) <= 0
    const voided = m.voided === true
    return {
      billKey: m.bill_key,
      invoiceId: m.invoice_id,
      invoiceNumber: m.invoice_number,
      landlordId: m.landlord_id,
      leaseId: m.lease_id,
      householdId: r?.household_id ?? m.household_id,
      dueDate: m.due_date,
      month: m.due_date.slice(0, 7),
      voided,
      stamp: j.stamp,
      days: j.days,
      counted: j.counted,
      onTime: j.onTime,
      workTradeOnly: j.workTradeOnly,
      onboarding: r?.onboarding === true,
      lateFeeOnBill: r?.late_fee_on_bill === true,
      graceDays: Number(r?.grace ?? 5),
      firstLateDay: r?.first_late_day ?? null,
      paidInFullOn: paidInFull ? (j.workTradeOnly ? null : (r?.last_paid_on ?? null)) : null,
      chargedBase: dollars(cents(r?.charged_base)),
      workTrade: dollars(cents(r?.wt_base)),
      owedBase: dollars(cents(r?.owed_base)),
      clearing: r?.clearing === true,
      loggedAfterLateFee: r?.logged_after_fee === true,
      bankValidated: r?.bank_dated === true,
      paymentIds: [...(r?.payment_ids ?? [])],
      manualMethods: [...(r?.manual_methods ?? [])].sort(),
      references: [...(r?.refs ?? [])].sort(),
      stripeIntents: [...(r?.intents ?? [])].sort(),
      mark: voided || !j.counted ? null : billMarkEventType(j.stamp, j.days),
    }
  }).sort((a, z) => a.dueDate.localeCompare(z.dueDate) || a.billKey.localeCompare(z.billKey))
}

// ─── The marks a bill carries now ────────────────────────────────────────────

/** A live payment mark on the ledger (a bill mark, or a per-line mark written before 10/12). */
export interface LiveMark {
  id: string
  eventType: CreditEventType
  subjectId: string
  /** The tenant the mark is on. */
  tenantId: string
  occurredAt: Date
  eventData: Record<string, unknown>
}

interface MarkRow {
  id: string; event_type: CreditEventType; subject_id: string; tenant_id: string; occurred_at: Date
  event_data: Record<string, unknown>; bill_key: string; per_line: boolean | null
}

/**
 * For each bill: its live bill marks, the live per-line marks on its rows
 * (any row of the bill, voided and $0 lines included), and whether a mark of
 * it is in dispute or an admin corrected one after a dispute.
 */
async function marksOfBills(q: Q, billKeys: readonly string[]): Promise<Map<string, {
  bill: LiveMark[]; lines: LiveMark[]; rekeyed: LiveMark[]; disputed: boolean
}>> {
  const out = new Map<string, { bill: LiveMark[]; lines: LiveMark[]; rekeyed: LiveMark[]; disputed: boolean }>()
  for (const k of billKeys) out.set(k, { bill: [], lines: [], rekeyed: [], disputed: false })
  if (billKeys.length === 0) return out
  const { invoiceIds, rowIds } = splitKeys(billKeys)
  // Every row of these bills, with its bill key.
  const lines = `
    SELECT p.id::text AS payment_id, p.invoice_id::text AS bill_key FROM payments p WHERE p.invoice_id = ANY($1::uuid[])
    UNION
    SELECT p.id::text, ai.id::text FROM invoices ai
      JOIN payments p ON p.invoice_id IS NULL AND p.lease_id = ai.lease_id AND p.due_date = ai.due_date
     WHERE ai.id = ANY($1::uuid[]) AND ai.id = ${billInvoiceSql('p')}
    UNION
    SELECT p.id::text, '${ROW_BILL_PREFIX}' || p.id::text FROM payments p WHERE p.id = ANY($2::uuid[]) AND p.invoice_id IS NULL`
  const { rows } = await q.query<MarkRow>(
    `WITH lines AS (${lines})
     SELECT e.id, e.event_type, e.subject_id, s.subject_ref_id::text AS tenant_id, e.occurred_at, e.event_data,
            e.event_data->>'bill_key' AS bill_key, FALSE AS per_line
       FROM credit_events e JOIN credit_subjects s ON s.id = e.subject_id
      WHERE e.superseded_by IS NULL
        AND e.event_data->>'mark_basis' = '${BILL_MARK_BASIS}'
        AND e.event_data->>'bill_key' = ANY($3::text[])
     UNION ALL
     SELECT e.id, e.event_type, e.subject_id, s.subject_ref_id::text, e.occurred_at, e.event_data,
            ln.bill_key, TRUE
       FROM credit_events e JOIN credit_subjects s ON s.id = e.subject_id
       JOIN lines ln ON ln.payment_id = e.event_data->>'payment_id'
      WHERE e.superseded_by IS NULL
        AND e.event_type = ANY($4::text[])
        AND NOT (e.event_data ? 'mark_basis')
     UNION ALL
     -- A charge on no invoice that was a bill of its own and is now part of
     -- its lease's invoice (the invoice was written after it): its own mark
     -- (per_line NULL) is replaced by the invoice's.
     SELECT e.id, e.event_type, e.subject_id, s.subject_ref_id::text, e.occurred_at, e.event_data,
            ln.bill_key, NULL
       FROM credit_events e JOIN credit_subjects s ON s.id = e.subject_id
       JOIN lines ln ON e.event_data->>'bill_key' = '${ROW_BILL_PREFIX}' || ln.payment_id
                    AND ln.bill_key <> '${ROW_BILL_PREFIX}' || ln.payment_id
      WHERE e.superseded_by IS NULL
        AND e.event_data->>'mark_basis' = '${BILL_MARK_BASIS}'
      ORDER BY 1`,
    [invoiceIds, rowIds, [...billKeys], PAYMENT_MARK_TYPES])
  for (const r of rows) {
    const slot = out.get(r.bill_key)
    if (!slot) continue
    const m: LiveMark = {
      id: r.id, eventType: r.event_type, subjectId: r.subject_id, tenantId: r.tenant_id,
      occurredAt: new Date(r.occurred_at), eventData: r.event_data ?? {},
    }
    if (r.per_line === null) slot.rekeyed.push(m)
    else if (r.per_line) slot.lines.push(m)
    else slot.bill.push(m)
  }
  for (const slot of out.values()) {
    slot.bill.sort((a, z) => a.occurredAt.getTime() - z.occurredAt.getTime() || a.id.localeCompare(z.id))
    slot.lines.sort((a, z) => a.occurredAt.getTime() - z.occurredAt.getTime() || a.id.localeCompare(z.id))
  }
  // A mark an admin corrected after a dispute stays corrected (as the settle
  // guard always treated a corrected line mark): the bill is left alone.
  // 10/12 (Nic, review): so is a bill while a dispute of one of its marks is
  // still open — re-judging it mid-dispute superseded the very mark in dispute,
  // and the admin's later correction then wrote over that link and left the
  // bill with two live marks. Once the dispute is upheld or closed with no
  // change the bill is judged again as usual.
  // The marks are found the two ways the ledger indexes them (bill_key on a
  // bill mark, payment_id on a line mark — idx_credit_events_bill_mark /
  // idx_credit_events_line_mark), never by a scan of every event.
  const disputed = await q.query<{ bill_key: string }>(
    `WITH lines AS (${lines}),
     marks AS (
       SELECT e.id, e.event_data->>'bill_key' AS bill_key, e.superseded_reason
         FROM credit_events e
        WHERE e.event_data->>'mark_basis' = '${BILL_MARK_BASIS}'
          AND e.event_data->>'bill_key' = ANY($3::text[])
       UNION ALL
       SELECT e.id, ln.bill_key, e.superseded_reason
         FROM lines ln JOIN credit_events e ON e.event_data->>'payment_id' = ln.payment_id
        WHERE e.event_type = ANY($4::text[])
     )
     SELECT DISTINCT m.bill_key FROM marks m
      WHERE m.superseded_reason = 'correction_after_dispute'
         OR EXISTS (SELECT 1 FROM credit_disputes d
                     WHERE d.disputed_event_id = m.id
                       AND d.status IN ('open', 'evidence_pending', 'resolved_corrected'))`,
    [invoiceIds, rowIds, [...billKeys], PAYMENT_MARK_TYPES])
  for (const r of disputed.rows) {
    const slot = out.get(r.bill_key)
    if (slot) slot.disputed = true
  }
  return out
}

// ─── Plan, then apply ────────────────────────────────────────────────────────

export const BILL_MARK_ACTIONS = ['none', 'write', 'correct', 'withdraw', 'clearing', 'disputed'] as const
export type BillMarkAction = typeof BILL_MARK_ACTIONS[number]

/** What one bill's payment history needs. */
export interface BillMarkPlan {
  bill: BillJudgement
  /** The live bill mark (the newest, when a race left two). */
  current: LiveMark | null
  /** Other live bill marks of the same bill (superseded with it). */
  extra: LiveMark[]
  /** Live per-line marks on the bill's rows, written before 10/12. */
  lines: LiveMark[]
  disputed: boolean
  action: BillMarkAction
}

/** What a sync did to one bill (a plan applied). */
export interface BillMarkChange {
  billKey: string
  /** null: a charge on no invoice. */
  invoiceId: string | null
  invoiceNumber: string | null
  /** The household (the mark's tenant). */
  tenantId: string | null
  month: string
  action: BillMarkAction
  /** The bill's live mark before (null: none). */
  was: CreditEventType | null
  /** The per-line marks it had before (written before 10/12). */
  wasLines: CreditEventType[]
  /** The mark it carries now (null: none). */
  now: CreditEventType | null
  stamp: PaymentStamp | null
  days: number
  /** The mark written (null: none written). */
  eventId: string | null
  /** Every mark superseded (corrected, replaced or withdrawn). */
  supersededIds: string[]
  /** Credit subjects whose chain changed (scores and stats to refresh after the commit). */
  subjectIds: string[]
}

/** The plan for these bills: pure reads. */
export async function planBillMarks(q: Q, billKeys: readonly string[], opts: BillJudgeOptions = {}): Promise<BillMarkPlan[]> {
  const bills = await judgeBills(q, billKeys, opts)
  const marks = await marksOfBills(q, bills.map(b => b.billKey))
  return bills.map(bill => {
    const m = marks.get(bill.billKey) ?? { bill: [], lines: [], rekeyed: [], disputed: false }
    const current = m.bill.length ? m.bill[m.bill.length - 1] : null
    const extra = [...m.bill.slice(0, -1), ...m.rekeyed]
    let action: BillMarkAction
    if (m.disputed) action = 'disputed'
    else if (!bill.voided && bill.clearing) action = 'clearing'
    else if (!bill.mark || !bill.householdId) action = current || extra.length || m.lines.length ? 'withdraw' : 'none'
    else if (current && !extra.length && !m.lines.length
             && current.eventType === bill.mark && current.tenantId === bill.householdId) action = 'none'
    else action = current || extra.length || m.lines.length ? 'correct' : 'write'
    return { bill, current, extra, lines: m.lines, disputed: m.disputed, action }
  })
}

/**
 * Who vouches for a bill's mark (S652: "a check recorded at the desk is
 * landlord-attested with the check number as evidence"): money the desk
 * recorded with no bank line behind it → the landlord's word, with the
 * methods and references; else a card or bank payment through Stripe → Stripe,
 * with its payments; else (work trade, account credit, a matched bank line, or
 * nothing paid yet) GAM's own records. Every source weighs the same in the
 * score (formula v1.0.0); this says who vouched.
 */
export function billAttestation(bill: Pick<BillJudgement, 'billKey' | 'invoiceId' | 'paymentIds' | 'manualMethods' | 'references' | 'stripeIntents'>): {
  attestationSource: 'landlord_self_reported_with_evidence' | 'stripe_attested' | 'system_derived'
  attestationEvidence: Record<string, unknown>
} {
  const one = (xs: string[]) => (xs.length === 1 ? xs[0] : xs)
  const evidence: Record<string, unknown> = {
    bill_key: bill.billKey, invoice_id: bill.invoiceId, payment_ids: bill.paymentIds,
    ...(bill.manualMethods.length ? { manual_method: one(bill.manualMethods) } : {}),
    ...(bill.references.length ? { reference: one(bill.references) } : {}),
    ...(bill.stripeIntents.length ? { stripe_payment_intent_ids: bill.stripeIntents } : {}),
  }
  const source = bill.manualMethods.length ? 'landlord_self_reported_with_evidence'
    : bill.stripeIntents.length ? 'stripe_attested' : 'system_derived'
  return { attestationSource: source, attestationEvidence: evidence }
}

/** Noon UTC on a calendar day: the same day on every US property's calendar. */
const noonOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`)

/** Apply one plan inside the caller's transaction (the caller holds the subject's lock: syncBillMarks). */
export async function applyBillMarkPlan(client: PoolClient, plan: BillMarkPlan): Promise<BillMarkChange> {
  const { bill } = plan
  const out: BillMarkChange = {
    billKey: bill.billKey, invoiceId: bill.invoiceId, invoiceNumber: bill.invoiceNumber, tenantId: bill.householdId,
    month: bill.month, action: plan.action, was: plan.current?.eventType ?? null, wasLines: plan.lines.map(l => l.eventType),
    now: plan.action === 'write' || plan.action === 'correct' ? bill.mark
      : plan.action === 'withdraw' ? null : (plan.current?.eventType ?? null),
    stamp: bill.stamp, days: bill.days, eventId: null, supersededIds: [], subjectIds: [],
  }
  const subjects = new Set<string>()
  if (plan.action === 'withdraw') {
    // The ledger's withdrawal: the mark points at itself — never an edit or delete.
    // 10/12: supersedeEvent never rewrites a mark already superseded (one the
    // plan named twice, or another writer got to first) — only marks actually
    // withdrawn now are reported.
    for (const m of [...(plan.current ? [plan.current] : []), ...plan.extra, ...plan.lines]) {
      if (!(await supersedeEvent(client, m.id, m.id, 'attestation_invalidated'))) continue
      out.supersededIds.push(m.id)
      subjects.add(m.subjectId)
    }
  } else if ((plan.action === 'write' || plan.action === 'correct') && bill.mark && bill.householdId) {
    const occurred = bill.stamp === 'paid_on_time' || bill.stamp === 'paid_late'
      ? (bill.paidInFullOn ?? bill.dueDate) : (bill.firstLateDay ?? bill.dueDate)
    const replaced = [...plan.extra, ...plan.lines]
    const written = await appendEvent({
      subjectType: 'tenant',
      subjectRefId: bill.householdId,
      eventType: bill.mark,
      eventData: {
        mark_basis: BILL_MARK_BASIS,
        rule: BILL_MARK_RULE,
        bill_key: bill.billKey,
        invoice_id: bill.invoiceId,
        ...(bill.invoiceNumber ? { invoice_number: bill.invoiceNumber } : {}),
        bill_month: bill.month,
        due_date: bill.dueDate,
        stamp: bill.stamp,
        days_past_grace: bill.days,
        grace_days: bill.graceDays,
        ...(bill.firstLateDay ? { first_late_day: bill.firstLateDay } : {}),
        ...(bill.paidInFullOn ? { paid_in_full_on: bill.paidInFullOn } : {}),
        charged: bill.chargedBase.toFixed(2),
        owed: bill.owedBase.toFixed(2),
        ...(bill.workTrade > 0 ? { work_trade: bill.workTrade.toFixed(2) } : {}),
        ...(bill.onboarding ? { onboarding_month: true } : {}),
        ...(bill.lateFeeOnBill ? { late_fee_on_bill: true } : {}),
        // 10/6: logged by hand after a late fee was charged — counted from the day GAM recorded it.
        ...(bill.loggedAfterLateFee ? { logged_after_late_fee: true } : {}),
        // 10/6: a bank line matched to a line decided its day.
        ...(bill.bankValidated ? { bank_validated: true } : {}),
        payment_ids: bill.paymentIds,
        // The bill's first line, for readers that name a mark by one payment
        // (routes/tenants.ts: a company-scoped viewer's late count). The mark
        // is the whole bill's; payment_ids lists every line.
        ...(bill.paymentIds.length ? { payment_id: bill.paymentIds[0] } : {}),
        ...(plan.current ? { corrects_event_id: plan.current.id } : {}),
        ...(replaced.length ? { replaces_event_ids: replaced.map(m => m.id) } : {}),
      },
      occurredAt: noonOf(occurred),
      ...billAttestation(bill),
      dimensionTags: ['payment_reliability'],
      networkVisibility: billMarkVisibility(bill.mark),
    }, client)
    out.eventId = written.eventId
    subjects.add(written.subjectId)
    for (const m of [...(plan.current ? [plan.current] : []), ...plan.extra]) {
      if (!(await supersedeEvent(client, m.id, written.eventId, 'bill_status_changed'))) continue
      out.supersededIds.push(m.id)
      subjects.add(m.subjectId)
    }
    for (const m of plan.lines) {
      if (!(await supersedeEvent(client, m.id, written.eventId, 'replaced_by_bill_mark'))) continue
      out.supersededIds.push(m.id)
      subjects.add(m.subjectId)
    }
  }
  out.subjectIds = [...subjects]
  return out
}

/**
 * Bring these bills' marks to what the rule gives them, inside the caller's
 * transaction (a settle's own: the mark moves with the money). Each bill's
 * household subject is locked first (the lock appendEvent takes), so two
 * settles of one household cannot both write a bill's first mark. Returns what
 * changed (a bill already right changes nothing — run twice, the second run
 * writes nothing). The caller refreshes scores and stats after its commit, or
 * leaves them to the nightly run.
 */
export async function syncBillMarks(client: PoolClient, billKeys: readonly string[], opts: BillJudgeOptions = {}): Promise<BillMarkChange[]> {
  const { invoiceIds, rowIds } = splitKeys(billKeys)
  if (invoiceIds.length === 0 && rowIds.length === 0) return []
  const households = [...new Set((await billMeta(client, invoiceIds, rowIds))
    .map(m => m.household_id).filter((x): x is string => !!x))].sort()
  for (const householdId of households) {
    const subjectId = await getOrCreateSubject(client, 'tenant', householdId)
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`credit_subject:${subjectId}`])
  }
  const changes: BillMarkChange[] = []
  for (const plan of await planBillMarks(client, [...invoiceIds, ...rowIds.map(r => ROW_BILL_PREFIX + r)], opts)) {
    if (plan.action === 'none' || plan.action === 'clearing' || plan.action === 'disputed') continue
    changes.push(await applyBillMarkPlan(client, plan))
  }
  return changes
}

/** The bills these charge rows are on (their invoice; a charge on no invoice, its lease's invoice due that day, else itself). */
export async function billsOfPayments(q: Q, paymentIds: readonly string[]): Promise<string[]> {
  if (!paymentIds.length) return []
  const { rows } = await q.query<{ bill_key: string }>(
    `SELECT DISTINCT COALESCE(${billInvoiceSql('p')}::text, '${ROW_BILL_PREFIX}' || p.id::text) AS bill_key
       FROM payments p WHERE p.id = ANY($1::uuid[]) AND p.due_date IS NOT NULL`,
    [[...new Set(paymentIds)]])
  return rows.map(r => r.bill_key).sort()
}

/** Each charge row → the bill it is on (billsOfPayments, row by row). */
export async function billKeyOfPayments(q: Q, paymentIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!paymentIds.length) return out
  const { rows } = await q.query<{ id: string; bill_key: string }>(
    `SELECT p.id::text AS id, COALESCE(${billInvoiceSql('p')}::text, '${ROW_BILL_PREFIX}' || p.id::text) AS bill_key
       FROM payments p WHERE p.id = ANY($1::uuid[]) AND p.due_date IS NOT NULL`,
    [[...new Set(paymentIds)]])
  for (const r of rows) out.set(r.id, r.bill_key)
  return out
}

/** syncBillMarks for the bills these charge rows are on. */
export async function syncBillMarksForPayments(client: PoolClient, paymentIds: readonly string[], opts: BillJudgeOptions = {}): Promise<BillMarkChange[]> {
  return syncBillMarks(client, await billsOfPayments(client, paymentIds), opts)
}

// ─── The nightly run ─────────────────────────────────────────────────────────

/**
 * The charges on no invoice that are bills of their own (no invoice of their
 * lease is due that day) — base charges only: a late fee or a deposit alone is
 * never a bill's mark. 10/12 (Nic): never a row imported from another platform
 * ("health starts with the first bill GAM wrote"), and never a row of $0 or
 * less (a deposit refund written as a negative fee, services/depositReturn):
 * nothing is charged on it, so it can never earn a mark.
 */
const LONE_BILL_ROWS_SQL = `
  SELECT p.id FROM payments p
   WHERE p.invoice_id IS NULL AND p.due_date IS NOT NULL
     AND p.type = ANY(${BASE_TYPES_SQL})
     AND p.import_source IS NULL
     AND p.amount > 0
     AND ${billInvoiceSql('p')} IS NULL`

/**
 * The bills whose payment history can still change: every bill without a
 * final mark yet that still has a base charge open (owed, failed or clearing —
 * a bill going past its grace period changes nothing in the database, so it
 * has to be looked at) or still carries a mark, a voided bill that still
 * carries a mark, and every bill something touched in the last `sinceHours`
 * (a line written, settled, voided or changed — the change journal — a bank
 * match or its undo, credit used, a receipt). A bill paid and marked long ago
 * is not read again.
 *
 * 10/12 (Nic, review): nor, every night forever, is a bill with no mark and
 * nothing open on it — a bill with nothing charged (a deposit, a late fee or
 * $0 alone), an onboarding month paid late with no late fee (good news only:
 * it never counts), a bill with no household. Once nothing on a bill is open
 * its judgement no longer moves with the calendar (only an open line's days
 * past grace do); what can still change it — a line added, a payment undone,
 * a late fee charged — touches it, and a touched bill is read.
 */
export async function billsToReview(q: Q, sinceHours = 72): Promise<string[]> {
  const final = (key: string) => `EXISTS (SELECT 1 FROM credit_events e
                           WHERE e.superseded_by IS NULL
                             AND e.event_data->>'mark_basis' = '${BILL_MARK_BASIS}'
                             AND e.event_data->>'bill_key' = ${key}
                             AND e.event_data->>'stamp' IN ('paid_on_time', 'paid_late'))`
  const anyMark = (key: string) => `EXISTS (SELECT 1 FROM credit_events e
                           WHERE e.superseded_by IS NULL
                             AND e.event_data->>'mark_basis' = '${BILL_MARK_BASIS}'
                             AND e.event_data->>'bill_key' = ${key})`
  // A base charge still open on the row (owed, failed, or money clearing on it).
  const openBase = (a: string) => `(${a}.type = ANY(${BASE_TYPES_SQL}) AND ${a}.amount > 0
                           AND ${a}.status IN ('pending', 'failed', 'processing')
                           AND ${a}.import_source IS NULL)`
  // ... on the invoice, or on no invoice but its lease's and due that day (billInvoiceSql).
  const invoiceOpen = `(EXISTS (SELECT 1 FROM payments ob WHERE ob.invoice_id = inv.id AND ${openBase('ob')})
                     OR EXISTS (SELECT 1 FROM payments ob
                                 WHERE ob.invoice_id IS NULL AND ob.lease_id = inv.lease_id
                                   AND ob.due_date = inv.due_date AND ${openBase('ob')}))`
  const { rows } = await q.query<{ key: string }>(
    `WITH since AS (SELECT NOW() - make_interval(hours => $1::int) AS t),
     touched AS (
       SELECT inv.id AS pid, inv.id AS inv FROM invoices inv, since WHERE inv.updated_at >= since.t OR inv.created_at >= since.t
       UNION
       SELECT p.id, p.invoice_id FROM payments p, since
        WHERE p.created_at >= since.t OR p.settled_at >= since.t OR p.voided_at >= since.t
       UNION
       SELECT a.row_id, (COALESCE(a.new_row, a.old_row)->>'invoice_id')::uuid FROM audit_row_changes a, since
        WHERE a.table_name = 'payments' AND a.changed_at >= since.t AND a.row_id IS NOT NULL
       UNION
       SELECT p.id, p.invoice_id FROM bank_deposit_allocations b JOIN payments p ON p.id = b.payment_id, since
        WHERE b.created_at >= since.t OR b.reversed_at >= since.t
       UNION
       SELECT p.id, p.invoice_id FROM credit_uses cu JOIN payments p ON p.id = cu.payment_id, since
        WHERE cu.held_at >= since.t OR cu.applied_at >= since.t OR cu.released_at >= since.t
       UNION
       SELECT p.id, p.invoice_id FROM remittance_applications ra
         JOIN payments p ON p.id = ra.payment_id
         JOIN tenant_remittances tr ON tr.id = ra.remittance_id, since
        WHERE ra.created_at >= since.t OR tr.updated_at >= since.t
     )
     SELECT DISTINCT k.key FROM (
       SELECT inv.id::text AS key FROM invoices inv
        WHERE inv.status <> 'void' AND NOT ${final('inv.id::text')}
          AND (${invoiceOpen} OR ${anyMark('inv.id::text')})
       UNION
       SELECT '${ROW_BILL_PREFIX}' || lone.id::text FROM (${LONE_BILL_ROWS_SQL}) lone
         JOIN payments lp ON lp.id = lone.id
        WHERE NOT ${final(`'${ROW_BILL_PREFIX}' || lone.id::text`)}
          AND (${openBase('lp')} OR ${anyMark(`'${ROW_BILL_PREFIX}' || lone.id::text`)})
       UNION
       SELECT e.event_data->>'bill_key' FROM credit_events e
        WHERE e.superseded_by IS NULL AND e.event_data->>'mark_basis' = '${BILL_MARK_BASIS}'
          AND (EXISTS (SELECT 1 FROM invoices vi WHERE vi.id::text = e.event_data->>'bill_key' AND vi.status = 'void')
               OR EXISTS (SELECT 1 FROM payments vp WHERE '${ROW_BILL_PREFIX}' || vp.id::text = e.event_data->>'bill_key'
                                                      AND vp.status = 'voided'))
       UNION
       SELECT COALESCE(t.inv::text, (SELECT ${billInvoiceSql('tp')}::text FROM payments tp WHERE tp.id = t.pid),
                       '${ROW_BILL_PREFIX}' || t.pid::text)
         FROM touched t
     ) k WHERE k.key IS NOT NULL
     ORDER BY 1`, [sinceHours])
  // A touched row that is neither on a bill nor a bill of its own (a late fee
  // on no invoice, a deposit) is judged and earns no mark: harmless.
  return rows.map(r => r.key)
}

export interface NightlyBillMarkResult {
  reviewed: number
  changed: number
  errors: number
  /** Credit subjects whose chain changed. */
  subjects: string[]
}

/**
 * The nightly pass (jobs/creditNightly, before scores and stats): every bill
 * whose history can still change is judged in one read; each one whose marks
 * are not what the rule gives is brought there in its own transaction (judged
 * again under its household's lock). A bill that fails is logged and left for
 * the next night; the rest go on.
 */
export async function syncBillMarksNightly(opts: { sinceHours?: number; asOf?: string | null } = {}): Promise<NightlyBillMarkResult> {
  const keys = await billsToReview(db, opts.sinceHours ?? 72)
  const plans = await planBillMarks(db, keys, { asOf: opts.asOf ?? null })
  const todo = plans.filter(p => p.action === 'write' || p.action === 'correct' || p.action === 'withdraw')
  const subjects = new Set<string>()
  let changed = 0
  let errors = 0
  for (const p of todo) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const done = await syncBillMarks(client, [p.bill.billKey], { asOf: opts.asOf ?? null })
      await client.query('COMMIT')
      for (const c of done) { changed++; c.subjectIds.forEach(s => subjects.add(s)) }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      errors++
      logger.error({ err, billKey: p.bill.billKey }, '[credit-bill-marks] nightly sync of a bill failed; the next run tries again')
    } finally {
      client.release()
    }
  }
  return { reviewed: keys.length, changed, errors, subjects: [...subjects] }
}

// ─── Per-line marks with no bill (the rebuild) ───────────────────────────────

/** A live per-line mark (before 10/12) no bill stands behind: its row is gone. */
export interface OrphanLineMark extends LiveMark {
  paymentId: string | null
  /** Why no bill: the row no longer exists. */
  reason: 'no_row'
}

/** Every live per-line payment mark that cannot be tied to a bill (pure read). */
export async function orphanLineMarks(q: Q): Promise<OrphanLineMark[]> {
  const { rows } = await q.query<MarkRow & { payment_id: string | null }>(
    `SELECT e.id, e.event_type, e.subject_id, s.subject_ref_id::text AS tenant_id, e.occurred_at, e.event_data,
            e.event_data->>'payment_id' AS payment_id
       FROM credit_events e
       JOIN credit_subjects s ON s.id = e.subject_id AND s.subject_type = 'tenant'
       LEFT JOIN payments p ON p.id::text = e.event_data->>'payment_id'
      WHERE e.superseded_by IS NULL
        AND e.event_type = ANY($1::text[])
        AND NOT (e.event_data ? 'mark_basis')
        AND (p.id IS NULL OR p.due_date IS NULL)
      ORDER BY e.recorded_at, e.id`, [PAYMENT_MARK_TYPES])
  return rows.map(r => ({
    id: r.id, eventType: r.event_type, subjectId: r.subject_id, tenantId: r.tenant_id,
    occurredAt: new Date(r.occurred_at), eventData: r.event_data ?? {}, paymentId: r.payment_id, reason: 'no_row' as const,
  }))
}

/**
 * Every bill a rebuild judges: each invoice on GAM, each charge on no invoice
 * that is a bill of its own, a voided bill that still carries a mark, and
 * the bill of every row a per-line mark is on.
 */
export async function everyBill(q: Q): Promise<string[]> {
  const { rows } = await q.query<{ key: string }>(
    `SELECT DISTINCT k.key FROM (
       SELECT inv.id::text AS key FROM invoices inv
        WHERE inv.status <> 'void'
           OR EXISTS (SELECT 1 FROM credit_events e
                       WHERE e.superseded_by IS NULL AND e.event_data->>'mark_basis' = '${BILL_MARK_BASIS}'
                         AND e.event_data->>'bill_key' = inv.id::text)
       UNION
       SELECT '${ROW_BILL_PREFIX}' || lone.id::text FROM (${LONE_BILL_ROWS_SQL}) lone
       UNION
       SELECT COALESCE(${billInvoiceSql('p')}::text, '${ROW_BILL_PREFIX}' || p.id::text)
         FROM credit_events e JOIN payments p ON p.id::text = e.event_data->>'payment_id'
        WHERE e.superseded_by IS NULL AND NOT (e.event_data ? 'mark_basis') AND p.due_date IS NOT NULL
          AND e.event_type = ANY($1::text[])
     ) k
     ORDER BY 1`, [PAYMENT_MARK_TYPES])
  return rows.map(r => r.key)
}
