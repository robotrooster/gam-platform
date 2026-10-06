// S624 — turning a matched bank deposit into a settled rent payment.
//
// This is where the two promises made to a cash-paying tenant are actually kept:
// that their payment gets found, dated and applied without them chasing anyone,
// and that they do not eat a late fee for the days the money sat in transit.
// Everything upstream (services/bankDepositMatch.ts, services/depositBackdate.ts)
// is inference and arithmetic; this is the only part that moves money.
//
// THE DATE IS THE WHOLE POINT. A landlord recording a payment by hand settles it
// at NOW(), because that is when they are doing it. A deposit happened in the
// past, so it settles on the date the money actually moved — the tenant's own
// declared date when a bank row corroborates it, otherwise the bank's posting.
// Late fees that accrued after that date were charged for an absence that was
// not real, and are undone.
//
// WHAT IS NOT ERASED. GAM does not delete money records (standing retention
// rule). A late fee the tenant has ALREADY PAID cannot be un-charged, so it
// comes back as a `late_fee_refund` credit — visible, attributable, reversible.
// Only an unpaid tick is zeroed, and even then the row survives with a note
// saying why. Nobody should ever have to guess where a charge went.
//
// S655 (money plan §3, the bank-deposit row; Step 9):
//   - ONE HOUSEHOLD. A deposit pays one person's bills with this company
//     (every lease they are on). The household lock is taken first
//     (moneyPredicates.lockHousehold), then the rows by id, so the desk, a
//     webhook or the bill run can never interleave with it.
//   - BANK-PAYABLE ROWS ONLY: the landlord's rent, utilities, fees, late fees,
//     home payments and the old carried balance. Never GAM's own charges, a
//     line work trade covers, GAM's FlexPay collection, or a line whose money
//     is already on its way.
//   - NEVER MORE THAN THE DEPOSIT. Lines adding up to more are refused. A
//     deposit short of what is owed settles what it covers and says "covers $X
//     of $Y owed"; a deposit over the lines it pays banks the rest as paid-ahead
//     money the landlord already holds (funded_by 'landlord', received the day
//     the money moved).
//   - $0 CREDIT, ALWAYS (bug 2). A deposit is new money; it never spends the
//     tenant's credit, which waits for them to choose.
//   - ONE RECEIPT: a tenant_remittances row for the deposit (method, the bank
//     day, who confirmed it, gross_amount NULL — no Stripe), with an
//     application for every line money paid, and every settled row marks how it
//     was paid (manual_method), so it is never read as GAM-held money.
//   - THE LATE-FEE REFUND IS A CREDIT THE LANDLORD GIVES (createIssuedCredit):
//     it settles nothing inside this transaction; the whole-bill check runs
//     for the household after the commit, in its own transaction.
//   - EVERYTHING CHANGED IS WRITTEN DOWN (bank_transactions.auto_settle_undo),
//     so the match can be undone exactly (Step 12).

import type { PoolClient } from 'pg'
import { getClient, query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { settleManualRentPayment } from './manualPaymentSettle'
import type { DepositRecordRaised } from './leaseFeesSync'
import { backdateLateFees, effectivePaidDateFor, type LateFeeTick } from './depositBackdate'
import {
  daysApart, methodContradicts, coversText, DECLARATION_DATE_WINDOW_DAYS,
} from './bankDepositMatch'
import {
  lockHousehold, lockPaymentRowsById, isBankPayableRow, bankPayableRowSql, allocationOrderSql,
  type MoneyRowFacts,
} from './moneyPredicates'
import { notFlexDepositRowSql, FLEX_DEPOSIT_NOT_BANK_PAYABLE } from './bankDepositCandidates'
import { createPaidAhead, createIssuedCredit, runWholeBillCheckAfterCommit, voidPaidAhead } from './creditUse'
import { supersedeEvent } from './creditLedger'
import { createNotification } from './notifications'
import { logger } from '../lib/logger'
import type { ManualPaymentMethod } from '@gam/shared'
import { activateBillingForMoneyMoved } from './billingActivation'

export interface ConfirmDepositInput {
  bankTransactionId: string
  /** The bank-payable `payments` rows this deposit settles (one household). */
  chargeIds: string[]
  method: ManualPaymentMethod
  /**
   * Set when a tenant declaration produced this match. When absent, a pending
   * report from the same household for this exact amount, within the window,
   * is found and confirmed (the landlord's screen does not send it), so the
   * tenant still gets their own date.
   */
  declarationId?: string | null
  /** Who confirmed it — null when the system settled it by itself. */
  confirmedByUserId?: string | null
  /**
   * S655 (Step 12): the bank feed settled this by itself, on amount (the
   * tenant's whole bill, to the cent — bankDepositMatch.isAutoSettleable).
   * Re-checked under the lock: the lines must still be the household's whole
   * bank-payable bill and the deposit exactly that. The row is stamped
   * auto_settled_at and both sides are told it can be undone.
   */
  auto?: boolean
}

/**
 * May a landlord's confirm settle rent from a deposit the bank still shows as
 * PENDING (not yet posted)? Automatic settling never does (bankFeed
 * autoSettleDeclaredDeposits: "settle rent from it only once the bank has
 * posted it"), "Money received" counts money on the day it arrived (money plan
 * §0.0), and a pending deposit can still be voided — leaving rent settled and
 * backdated with no money behind it. ASKED NIC (Step 9, needs-Nic item 5):
 * true keeps today's behavior (the landlord's confirm takes it); false refuses
 * until the bank posts it. One switch.
 */
export const LANDLORD_CONFIRM_ACCEPTS_PENDING_DEPOSITS = true

/**
 * Why a deposit the bank reports this way cannot pay rent (null: it can).
 * A voided deposit never can — the bank says no money came. NULL is a row
 * stored before the bank's status was kept, read as posted.
 */
export function pendingDepositRefusal(
  bankStatus: string | null | undefined,
  acceptsPending: boolean = LANDLORD_CONFIRM_ACCEPTS_PENDING_DEPOSITS,
): string | null {
  if (bankStatus === 'void') return 'Your bank voided this deposit — no money came in, so it can’t pay rent.'
  if (bankStatus === 'pending' && !acceptsPending) {
    return 'This deposit is still pending at your bank. Match it once it posts — usually within a day or two.'
  }
  return null
}

/** What a confirm changed, so it can be undone exactly (bank_transactions.auto_settle_undo). */
export interface DepositSettleUndo {
  version: 1
  /** Each settled row as it was before (status, retry schedule, intent). */
  rows: Array<{ paymentId: string; priorStatus: string; priorNextRetryAt: string | null; priorIntentId: string | null; money: number }>
  /** Late fees zeroed because the rent was paid before they accrued. */
  lateFeesZeroed: Array<{ paymentId: string; priorAmount: number; priorStatus: string; priorNotes: string | null }>
  /**
   * Every late-fee refund credit created for fees the tenant had already paid —
   * one per invoice the deposit paid lines on (Step 9 review: keeping only the
   * first left Undo unable to take back the others). No snapshot was ever
   * written with the old single-id field (the column is new with this batch).
   */
  lateFeeRefundCreditIds: string[]
  /** Paid-ahead money created from what the deposit paid beyond the lines. */
  paidAheadCreditId: string | null
  /** The deposit's receipt (tenant_remittances). */
  receiptId: string
  /** The tenant's report this deposit confirmed. */
  declarationId: string | null
  /** Payment-history marks the settle wrote (credit_events). */
  creditEventIds: string[]
  /** Whoever confirmed it (null: settled by itself). */
  confirmedBy: string | null
  /**
   * Step 9 review (fix pass 1): how much each security deposit record was
   * raised because this deposit paid a security-deposit charge, so Undo lowers
   * it by exactly that. Absent on matches made before this was kept (none
   * raised a record then).
   */
  securityDepositRaised?: Array<{
    depositId: string; amount: number
    /** 10/4 (decisions #46.3): who the record said held it, and its status, before (Undo puts them back). */
    priorHeldBy?: string; priorStatus?: string
  }>
}

export interface ConfirmDepositResult {
  settledChargeIds: string[]
  effectivePaidDate: string
  lateFeesUnbilled: number
  lateFeesRefunded: number
  /** Money that landed on bills. */
  amountApplied: number
  /** What the household owed (bank-payable, in money) just before this deposit. */
  owedBefore: number
  /** The deposit beyond the lines it paid, banked as paid-ahead money (0: none). */
  paidAhead: number
  paidAheadCreditId: string | null
  /** "covers $X of $Y owed" when bills stay open after this deposit; null when it paid everything. */
  coverage: string | null
  receiptId: string
  declarationId: string | null
  undo: DepositSettleUndo
}

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100
const money = (c: number): string => `$${toDollars(c).toFixed(2)}`

interface ChargeRow extends MoneyRowFacts {
  id: string
  landlord_id: string
  tenant_id: string | null
  invoice_id: string | null
  due_date: string
  created_at: string
  payment_block: boolean
  next_retry_at: string | null
  money_part: string
}

/** Why a row is not one a deposit may settle, said plainly. */
function notBankPayableReason(c: ChargeRow): string {
  if (c.revenue_owner === 'gam') return 'One of those charges is GAM’s own charge — it is paid online, not by a bank deposit.'
  if (c.entry_description === 'FLEXPAY') return 'One of those charges is not a bill a deposit can pay.'
  if (c.work_trade_suspended_at) return 'One of those charges is covered by work trade, so nothing is owed on it.'
  if (c.status === 'processing' || (c.status === 'pending' && c.stripe_payment_intent_id)) {
    return 'A payment for one of those charges is already on its way, so it is no longer open.'
  }
  return 'One of those charges is no longer open — it was paid, or it is no longer owed.'
}

/**
 * The day the whole invoice was paid, as the late-fee engine sees it, given
 * that this deposit paid its lines (`settlingIds`) on `effectivePaidDate`:
 * the latest of that day and the day each OTHER line on the invoice was paid —
 * settled or paid from the security deposit on its settled day, a payment
 * still clearing on the day it was made (the engine's postmark rule), each in
 * its property's calendar (the calendar late-fee ticks are dated in). Null
 * when another line is still unpaid: every tick so far was earned.
 *
 * Every line counts, whoever it is owed to (GAM's own fees and a neighbor
 * landlord's utility on a combined invoice included), because the engine
 * charges on every line (jobs/lateFees). Never counted: late fees themselves,
 * $0 lines, a line work trade covers (nothing is owed on it), and a
 * 'returned' line (the row its reversal reopened carries what is owed again).
 */
async function lateFeeCutoffDate(
  client: PoolClient, invoiceId: string, effectivePaidDate: string, settlingIds: readonly string[],
): Promise<string | null> {
  const r = (await client.query<{ open: number; last_paid: string | null }>(
    `SELECT COUNT(*) FILTER (WHERE x.paid_on IS NULL)::int AS open,
            to_char(MAX(x.paid_on), 'YYYY-MM-DD') AS last_paid
       FROM (SELECT CASE
                      WHEN p.status IN ('settled','paid_via_deposit')
                        THEN (COALESCE(p.settled_at, p.processed_at, now()) AT TIME ZONE tz.zone)::date
                      WHEN p.status = 'processing'
                        THEN (COALESCE((SELECT MIN(r.created_at) FROM tenant_remittances r
                                         WHERE r.stripe_payment_intent_id = p.stripe_payment_intent_id),
                                       p.processed_at, now()) AT TIME ZONE tz.zone)::date
                    END AS paid_on
               FROM payments p
               CROSS JOIN LATERAL (
                 SELECT COALESCE((SELECT pr.timezone FROM units u JOIN properties pr ON pr.id = u.property_id
                                   WHERE u.id = p.unit_id), 'America/Phoenix') AS zone) tz
              WHERE p.invoice_id = $1 AND p.type <> 'late_fee' AND p.amount > 0
                AND p.status <> 'returned'
                AND p.work_trade_suspended_at IS NULL
                AND NOT (p.id = ANY($2::uuid[]))) x`,
    [invoiceId, [...settlingIds]])).rows[0]
  if ((r?.open ?? 0) > 0) return null
  return r?.last_paid && r.last_paid > effectivePaidDate ? r.last_paid : effectivePaidDate
}

/**
 * Undo the late fees an invoice accrued after the rent was really paid.
 *
 * Returns what was unbilled and what was refunded — two different acts, kept
 * apart deliberately. See depositBackdate.ts.
 *
 * S655:
 *   - A tick was never owed only if, on its date, the WHOLE invoice was paid.
 *     The late-fee engine charges while any line on the invoice that is not a
 *     late fee is unpaid, whoever's line it is (jobs/lateFees; a line whose
 *     payment is clearing counts as paid from the day it was made), so the
 *     reversal follows the same rule: a tick stands unless it is dated after
 *     BOTH this deposit's day and the day every other line was paid
 *     (lateFeeCutoffDate). A line still unpaid now means every tick so far
 *     was earned — a short deposit that leaves, say, the home payment open has
 *     not shown the bill was paid on time. Before, the check was "is anything
 *     open NOW": a line the desk recorded LATE, before the match, made the
 *     match refund the fees that line's own lateness had earned, while the
 *     same facts recorded in the other order kept them.
 *   - A late fee whose money is on its way (a card or bank payment clearing) is
 *     never zeroed; nor one reopened after a dispute.
 *   - The refund for fees already paid is a credit the landlord gives
 *     (createIssuedCredit): it settles nothing here.
 */
async function reverseLateFees(
  client: PoolClient,
  invoiceId: string,
  effectivePaidDate: string,
  o: { settlingIds: readonly string[]; tenantId: string; landlordId: string; leaseId: string | null; createdBy: string | null },
): Promise<{ unbilled: number; refunded: number; zeroed: DepositSettleUndo['lateFeesZeroed']; refundCreditId: string | null }> {
  const none = { unbilled: 0, refunded: 0, zeroed: [], refundCreditId: null }
  const cutoff = await lateFeeCutoffDate(client, invoiceId, effectivePaidDate, o.settlingIds)
  if (cutoff === null) return none

  const { rows } = await client.query<{
    id: string; tick_date: string; amount: string; status: string; notes: string | null; in_flight: boolean
  }>(
    `SELECT p.id, to_char(p.due_date,'YYYY-MM-DD') AS tick_date,
            p.amount::text AS amount, p.status, p.notes,
            (p.status = 'pending' AND p.stripe_payment_intent_id IS NOT NULL) AS in_flight
       FROM payments p
      WHERE p.invoice_id = $1 AND p.type = 'late_fee'
        AND p.status IN ('pending','settled','paid_via_deposit')
        AND p.reversal_id IS NULL
        AND p.amount > 0
      ORDER BY p.id
        FOR UPDATE`,
    [invoiceId])
  const live = rows.filter(r => !r.in_flight)
  if (live.length === 0) return none

  const ticks: LateFeeTick[] = live.map(r => ({
    paymentId: r.id, tickDate: r.tick_date, amount: Number(r.amount),
    settled: r.status === 'settled' || r.status === 'paid_via_deposit',
  }))
  const out = backdateLateFees(ticks, cutoff)

  const zeroed: DepositSettleUndo['lateFeesZeroed'] = []
  for (const t of out.reversedTicks) {
    if (t.settled) continue   // already paid — refunded as a credit below
    const prior = live.find(r => r.id === t.paymentId)!
    // Zeroed, not deleted. The row and its history stay, with the reason on it.
    const z = await client.query(
      `UPDATE payments
          SET amount = 0, status = 'settled', settled_at = NOW(),
              notes = COALESCE(notes || ' — ', '') ||
                      'Reversed: rent was paid ' || $2::text || ', before this fee accrued'
        WHERE id = $1 AND status = 'pending' AND stripe_payment_intent_id IS NULL`,
      [t.paymentId, effectivePaidDate])
    if ((z.rowCount ?? 0) === 1) {
      zeroed.push({ paymentId: t.paymentId, priorAmount: Number(prior.amount), priorStatus: prior.status, priorNotes: prior.notes })
    }
  }

  let refundCreditId: string | null = null
  if (out.refundAmount > 0) {
    refundCreditId = await createIssuedCredit(client, {
      landlordId: o.landlordId, tenantId: o.tenantId, leaseId: o.leaseId,
      amount: out.refundAmount, category: 'late_fee_refund',
      reason: `Late fees refunded — the bank shows rent was paid on ${effectivePaidDate}`,
      createdBy: o.createdBy,
    })
  }

  return {
    unbilled: toDollars(zeroed.reduce((s, z) => s + toCents(z.priorAmount), 0)),
    refunded: out.refundAmount,
    zeroed,
    refundCreditId,
  }
}

/**
 * What a household owes this landlord in money right now: its bank-payable
 * rows on every lease of the household (the set a deposit may pay), less any
 * credit already spent on them. A space in eviction hold is left out — money
 * cannot be taken for it.
 */
async function householdBankOwedCents(
  runner: Pick<PoolClient, 'query'>, leaseIds: readonly string[], landlordId: string,
): Promise<number> {
  if (leaseIds.length === 0) return 0
  const r = await runner.query<{ owed: string }>(
    `SELECT COALESCE(SUM(vm.money_part), 0)::text AS owed
       FROM payments p
       JOIN v_payment_money vm ON vm.payment_id = p.id
       LEFT JOIN units u ON u.id = p.unit_id
      WHERE p.lease_id = ANY($1::uuid[]) AND p.landlord_id = $2
        AND ${bankPayableRowSql('p')}
        AND ${notFlexDepositRowSql('p')}
        AND vm.money_part > 0
        AND u.payment_block IS NOT TRUE`,
    [[...leaseIds], landlordId])
  return toCents(r.rows[0]?.owed)
}

/**
 * A pending report from this household for exactly this deposit, within the
 * window, the one whose stated instrument fits the bank memo first, then the
 * nearest date. The landlord's screen confirms by charges alone; without this
 * the tenant who reported their deposit would lose their own, earlier date.
 */
async function findMatchingDeclaration(
  client: PoolClient,
  a: { landlordId: string; leaseIds: readonly string[]; amount: number; postedDate: string; description: string | null },
): Promise<string | null> {
  if (a.leaseIds.length === 0) return null
  const r = await client.query<{ id: string; method: 'cash' | 'check' | 'money_order'; declared_date: string }>(
    `SELECT id, method, to_char(declared_date,'YYYY-MM-DD') AS declared_date
       FROM tenant_declared_deposits
      WHERE landlord_id = $1 AND lease_id = ANY($2::uuid[]) AND status = 'pending'
        AND amount = $3::numeric
        AND declared_date BETWEEN ($4::date - $5::int) AND ($4::date + $5::int)
      ORDER BY id
        FOR UPDATE`,
    [a.landlordId, [...a.leaseIds], toDollars(toCents(a.amount)).toFixed(2), a.postedDate, DECLARATION_DATE_WINDOW_DAYS])
  const ranked = r.rows
    .map(d => ({ ...d, contradicts: methodContradicts(d.method, a.description), gap: daysApart(d.declared_date, a.postedDate) }))
    .sort((x, y) => Number(x.contradicts) - Number(y.contradicts) || x.gap - y.gap || x.id.localeCompare(y.id))
  return ranked[0]?.id ?? null
}

/**
 * Confirm a deposit against the charges it paid.
 *
 * Runs in ONE transaction across every charge: a deposit that settles rent but
 * fails to reverse the late fee it made unnecessary would leave the tenant worse
 * off than before anyone helped them.
 */
export async function confirmDepositMatch(
  input: ConfirmDepositInput,
): Promise<ConfirmDepositResult> {
  const chargeIds = [...new Set(input.chargeIds)]
  if (chargeIds.length === 0) {
    throw new AppError(400, 'A deposit needs at least one charge to settle')
  }
  const client = await getClient()
  const afterCommit: Array<() => Promise<void>> = []
  try {
    await client.query('BEGIN')

    const txn = (await client.query(
      `SELECT id, landlord_id, amount::text AS amount, description,
              to_char(posted_date,'YYYY-MM-DD') AS posted_date, status, landlord_other_income_id, bank_status
         FROM bank_transactions WHERE id = $1 FOR UPDATE`,
      [input.bankTransactionId])).rows[0]
    if (!txn) throw new AppError(404, 'Bank transaction not found')
    // One deposit settles one set of charges, once. Without this a retried
    // confirm would settle the same rent twice off one deposit.
    if (txn.status === 'matched') {
      throw new AppError(409, 'This deposit has already been matched')
    }
    // S655: and ONLY a deposit still waiting for review. A deposit already
    // filed as income is already in the landlord's books — settling rent from
    // it too would count the same money twice. A hidden copy (a relink
    // duplicate), a pre-books row or a voided one is not a deposit to settle
    // anything with.
    if (txn.status !== 'needs_review' || txn.landlord_other_income_id) {
      throw new AppError(409, txn.status === 'categorized' || txn.landlord_other_income_id
        ? 'This deposit is already filed as income, so it can’t also pay rent — that would count it twice.'
        : 'This deposit is hidden from review, so it can’t be matched to rent.')
    }
    const depositCents = toCents(txn.amount)
    if (!(depositCents > 0)) {
      throw new AppError(400, 'Only a deposit can settle a charge')
    }
    // The bank's own word on it: a voided deposit is no money, and a pending
    // one only by the rule Nic is asked about (pendingDepositRefusal).
    const bankRefusal = pendingDepositRefusal(txn.bank_status)
    if (bankRefusal) throw new AppError(409, bankRefusal)

    // Who the deposit is for. Read once without locks to find the household;
    // everything is read again under the lock below.
    const pre = (await client.query<{ id: string; landlord_id: string; tenant_id: string | null; lease_id: string | null }>(
      `SELECT p.id, p.landlord_id, p.tenant_id, p.lease_id FROM payments p
        WHERE p.id = ANY($1::uuid[])
        ORDER BY ${allocationOrderSql('p')}`,
      [chargeIds])).rows
    if (pre.length !== chargeIds.length) {
      throw new AppError(404, 'One of those charges no longer exists')
    }
    if (pre.some(c => c.landlord_id !== txn.landlord_id)) {
      throw new AppError(403, 'That deposit belongs to a different landlord')
    }

    let declarationId: string | null = input.declarationId ?? null
    let householdTenant: string | null = null
    let declaredDate: string | null = null
    if (declarationId) {
      // Read without a lock: the report is locked after the household (below),
      // the lock order every writer of this household's money follows.
      const d = (await client.query(
        `SELECT tenant_id, landlord_id, amount::text AS amount,
                to_char(declared_date,'YYYY-MM-DD') AS declared_date, status
           FROM tenant_declared_deposits WHERE id = $1`,
        [declarationId])).rows[0]
      if (!d) throw new AppError(404, 'Declaration not found')
      if (d.status !== 'pending') {
        throw new AppError(409, `That report is already ${d.status}`)
      }
      if (d.landlord_id !== txn.landlord_id) {
        throw new AppError(403, 'That report is for a different landlord’s bills.')
      }
      // A report confers its date only on the deposit it describes.
      if (toCents(d.amount) !== depositCents) {
        throw new AppError(409, `That report is for ${money(toCents(d.amount))}, not this ${money(depositCents)} deposit.`)
      }
      if (daysApart(d.declared_date, txn.posted_date) > DECLARATION_DATE_WINDOW_DAYS) {
        throw new AppError(409, `That report is dated ${d.declared_date}, too far from when this deposit posted (${txn.posted_date}) to be the same money.`)
      }
      householdTenant = d.tenant_id
      declaredDate = d.declared_date
    }
    householdTenant = householdTenant ?? pre.find(c => c.tenant_id)?.tenant_id ?? null
    if (!householdTenant || pre.some(c => !c.lease_id)) {
      throw new AppError(409, 'One of those charges is not on a lease, so a bank deposit cannot pay it.')
    }

    // The household first, then the rows by id (§1.5).
    const leaseIds = await lockHousehold(client, householdTenant, txn.landlord_id)
    if (pre.some(c => !leaseIds.includes(c.lease_id!))) {
      throw new AppError(409,
        'Those charges belong to more than one household. A deposit pays one household’s bills — record each person’s part separately.')
    }
    await lockPaymentRowsById(client, chargeIds)

    if (declarationId) {
      const still = (await client.query<{ status: string }>(
        `SELECT status FROM tenant_declared_deposits WHERE id = $1 FOR UPDATE`, [declarationId])).rows[0]
      if (still?.status !== 'pending') {
        throw new AppError(409, `That report is already ${still?.status ?? 'gone'}`)
      }
    } else {
      declarationId = await findMatchingDeclaration(client, {
        landlordId: txn.landlord_id, leaseIds, amount: toDollars(depositCents),
        postedDate: txn.posted_date, description: txn.description,
      })
      if (declarationId) {
        declaredDate = (await client.query<{ declared_date: string }>(
          `SELECT to_char(declared_date,'YYYY-MM-DD') AS declared_date FROM tenant_declared_deposits WHERE id = $1`,
          [declarationId])).rows[0].declared_date
      }
    }

    const effectivePaidDate = effectivePaidDateFor(declaredDate, txn.posted_date)
    const settledAt = new Date(`${effectivePaidDate}T12:00:00Z`)

    const charges = (await client.query<ChargeRow>(
      `SELECT p.id, p.type, p.status, p.amount::text AS amount, p.landlord_id, p.tenant_id, p.unit_id,
              p.lease_id, p.invoice_id, to_char(p.due_date,'YYYY-MM-DD') AS due_date,
              to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              p.stripe_payment_intent_id, p.work_trade_suspended_at, p.entry_description,
              p.revenue_owner, p.lease_fee_id, p.reversal_id,
              p.next_retry_at::text AS next_retry_at,
              vm.money_part::text AS money_part,
              COALESCE(u.payment_block, FALSE) AS payment_block
         FROM payments p
         JOIN v_payment_money vm ON vm.payment_id = p.id
         JOIN units u ON u.id = p.unit_id
        WHERE p.id = ANY($1::uuid[])
        ORDER BY ${allocationOrderSql('p')}`,
      [chargeIds])).rows
    if (charges.length !== chargeIds.length) {
      throw new AppError(409, 'One of those charges is not on a space, so a bank deposit cannot pay it.')
    }
    for (const c of charges) {
      // Matches the manual-entry route: accepting landlord-bound money during an
      // eviction hold can reset the timeline.
      if (c.payment_block) {
        throw new AppError(409, 'This unit is in eviction mode — recording a payment is paused.')
      }
      if (!isBankPayableRow(c)) throw new AppError(409, notBankPayableReason(c))
    }
    // Step 9 review (fix pass 2): never a FlexDeposit payment (GAM's custody
    // collection, paid online to GAM — bankDepositCandidates.notFlexDepositRowSql).
    const flexRows = (await client.query<{ id: string }>(
      `SELECT p.id FROM payments p WHERE p.id = ANY($1::uuid[]) AND NOT ${notFlexDepositRowSql('p')}`,
      [chargeIds])).rows
    if (flexRows.length > 0) throw new AppError(409, FLEX_DEPOSIT_NOT_BANK_PAYABLE)

    // What the household owed in money just before this deposit (for "covers
    // $X of $Y owed"): every bank-payable row on its leases.
    const owedBeforeCents = await householdBankOwedCents(client, leaseIds, txn.landlord_id)
    if (input.auto) {
      const chosenCents = charges.reduce((s, c) => s + toCents(c.money_part), 0)
      if (chosenCents !== owedBeforeCents || chosenCents !== depositCents) {
        throw new AppError(409, 'This deposit is no longer this household’s whole bill, so it was not applied by itself.')
      }
    }

    // Late fees first: a fee that accrued after the money moved was never
    // owed, so it is zeroed before anything is settled (and drops out of what
    // this deposit pays — what it would have taken becomes paid-ahead money).
    const settlingIds = charges.map(c => c.id)
    let unbilled = 0
    let refunded = 0
    const zeroed: DepositSettleUndo['lateFeesZeroed'] = []
    const refundCredits: string[] = []
    const invoices = [...new Set(charges.map(c => c.invoice_id).filter((x): x is string => !!x))].sort()
    for (const invoiceId of invoices) {
      const head = charges.find(c => c.invoice_id === invoiceId)!
      const r = await reverseLateFees(client, invoiceId, effectivePaidDate, {
        settlingIds, tenantId: head.tenant_id ?? householdTenant, landlordId: txn.landlord_id,
        leaseId: head.lease_id, createdBy: input.confirmedByUserId ?? null,
      })
      unbilled += r.unbilled
      refunded += r.refunded
      zeroed.push(...r.zeroed)
      if (r.refundCreditId) refundCredits.push(r.refundCreditId)
    }
    const zeroedIds = new Set(zeroed.map(z => z.paymentId))
    const toSettle = charges.filter(c => !zeroedIds.has(c.id))

    // Never more than the deposit.
    const linesCents = toSettle.reduce((s, c) => s + toCents(c.money_part), 0)
    if (linesCents > depositCents) {
      throw new AppError(409,
        `Those charges come to ${money(linesCents)}, more than this ${money(depositCents)} deposit. ` +
        'A deposit settles whole charges only — leave out the newest ones.')
    }

    // Settle each line as money the landlord took (no credit, no fee). The
    // shared row settle replaces a scheduled bank retry first and marks how it
    // was paid; its afterCommit cancels a replaced pull once we commit.
    const undoRows: DepositSettleUndo['rows'] = []
    const settledIds: string[] = []
    const depositRecords: DepositRecordRaised[] = []
    for (const c of toSettle) {
      const r = await settleManualRentPayment(client, {
        payment: {
          id: c.id, landlord_id: c.landlord_id, tenant_id: c.tenant_id, unit_id: c.unit_id,
          lease_id: c.lease_id, due_date: c.due_date,
        },
        method: input.method,
        settledAt,
        provenance: `matched to a bank deposit posted ${txn.posted_date}`,
      })
      afterCommit.push(r.afterCommit)
      settledIds.push(...r.settledPaymentIds)
      depositRecords.push(...r.depositRecords)
      undoRows.push({
        paymentId: c.id, priorStatus: c.status, priorNextRetryAt: c.next_retry_at,
        priorIntentId: c.stripe_payment_intent_id, money: toDollars(toCents(c.money_part)),
      })
    }

    // A security-deposit charge this deposit paid raises the deposit record,
    // exactly as a portal payment's webhook does — the shared settle
    // (manualPaymentSettle → leaseFeesSync.reconcileSettledDepositPayment)
    // did it above, and how much each record rose is kept so Undo lowers it by
    // exactly that.
    //
    // 10/4 (decisions #46.3, Nic, FINAL — replaces fix pass 2's "leave a
    // GAM-escrow record as it is"): a deposit paid straight into the
    // landlord's bank is HELD BY THE LANDLORD, whatever was planned at
    // billing. The record says so (held_by 'landlord' when nothing on it was
    // held yet), so GAM accrues no interest on it and never counts it in
    // trust, and at move-out the landlord refunds it themselves. When GAM
    // already holds part of the record (paid through GAM earlier) the record
    // stays GAM's and this payment is the landlord's part, told apart at
    // move-out by how it was paid. A record planned as GAM's still gets the
    // information notice below.
    const securityDepositRaised: NonNullable<DepositSettleUndo['securityDepositRaised']> = depositRecords
      .filter(d => d.amount > 0)
      .map(d => ({ depositId: d.depositId, amount: d.amount, priorHeldBy: d.priorHeldBy, priorStatus: d.priorStatus }))
    const plannedEscrow = new Set(depositRecords.filter(d => d.priorHeldBy === 'gam_escrow').map(d => d.depositId))
    const escrowPaidToLandlord = plannedEscrow.size === 0 ? [] : (await client.query<{
      id: string; lease_id: string; amount: string; record_id: string | null; held_by: string | null
    }>(
      `SELECT p.id, p.lease_id, p.amount::text AS amount, sd.id AS record_id, sd.held_by
         FROM payments p
         JOIN LATERAL (
           SELECT id, held_by FROM security_deposits
            WHERE lease_id = p.lease_id ORDER BY created_at DESC LIMIT 1
         ) sd ON TRUE
        WHERE p.id = ANY($1::uuid[]) AND p.type = 'deposit' AND p.lease_fee_id IS NULL AND p.status = 'settled'
          AND sd.id = ANY($2::uuid[])
        ORDER BY p.id`,
      [settledIds, [...plannedEscrow]])).rows

    // The receipt: what went into the bank, what it paid, what was over.
    const excessCents = depositCents - linesCents
    const leaseOf = new Map(toSettle.map(c => [c.id, c.lease_id!]))
    const creditLease = toSettle.length > 0
      ? leaseOf.get(toSettle[toSettle.length - 1].id)!
      : charges[charges.length - 1].lease_id!
    const rem = await client.query<{ id: string }>(
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
          payment_method, gross_amount, processing_fee_amount, settled_at, reference, notes, received_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'settled', $7, NULL, 0, $8, NULL, $9, $10)
       RETURNING id`,
      [householdTenant, creditLease, txn.landlord_id, toDollars(depositCents).toFixed(2),
       toDollars(linesCents).toFixed(2), toDollars(excessCents).toFixed(2),
       input.method, settledAt,
       `Bank deposit posted ${txn.posted_date}${txn.description ? ` (${String(txn.description).slice(0, 120)})` : ''}`,
       input.confirmedByUserId ?? null])
    const receiptId = rem.rows[0].id
    // 10/5 (Nic): "money movement is the end of onboarding" — a bank deposit
    // matched to what tenants owe, including any part kept as credit.
    await activateBillingForMoneyMoved(client, [txn.landlord_id])
    for (const c of toSettle) {
      const m = toCents(c.money_part)
      if (m <= 0) continue
      await client.query(
        `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`,
        [receiptId, c.id, toDollars(m).toFixed(2)])
      // S624: record EVERY charge this deposit settled. matched_payment_id
      // stays populated with the head charge because the disbursement
      // auto-match still reads it; the allocation rows are the complete
      // record, and the basis for the on-site cash control (a rent marked
      // collected in person with NO allocation row is money not yet banked).
      // Re-matching the same pair after an Undo clears its reversal.
      await client.query(
        `INSERT INTO bank_deposit_allocations
           (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
         VALUES ($1, $2, $3, $4, $5::date)
         ON CONFLICT (bank_transaction_id, payment_id)
           DO UPDATE SET amount = EXCLUDED.amount, effective_paid_date = EXCLUDED.effective_paid_date,
                         reversed_at = NULL, reversed_by = NULL`,
        [txn.id, c.id, txn.landlord_id, toDollars(m).toFixed(2), effectivePaidDate])
    }

    // What is over the lines is the tenant's money paid ahead — the landlord
    // already holds it (it went into their bank).
    let paidAheadCreditId: string | null = null
    if (excessCents > 0) {
      paidAheadCreditId = await createPaidAhead(client, {
        leaseId: creditLease, tenantId: householdTenant, amount: toDollars(excessCents),
        fundedBy: 'landlord', receivedAt: settledAt, sourceRemittanceId: receiptId,
        note: `Paid ahead — bank deposit posted ${txn.posted_date}`,
      })
    }

    const creditEventIds = settledIds.length === 0 ? [] : (await client.query<{ id: string }>(
      `SELECT e.id FROM credit_events e
        WHERE e.event_type LIKE 'payment_received_%' AND e.event_data->>'payment_id' = ANY($1::text[])
        ORDER BY e.id`,
      [settledIds])).rows.map(r => r.id)

    const undo: DepositSettleUndo = {
      version: 1,
      rows: undoRows,
      lateFeesZeroed: zeroed,
      lateFeeRefundCreditIds: refundCredits,
      paidAheadCreditId,
      receiptId,
      declarationId,
      creditEventIds,
      confirmedBy: input.confirmedByUserId ?? null,
      ...(securityDepositRaised.length > 0 ? { securityDepositRaised } : {}),
    }

    await client.query(
      `UPDATE bank_transactions
          SET status='matched', matched_payment_id=$2, auto_settle_undo=$3::jsonb,
              auto_settled_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END, updated_at=NOW()
        WHERE id=$1`,
      [txn.id, settledIds[0] ?? charges[0].id, JSON.stringify(undo), input.auto === true])

    if (declarationId) {
      await client.query(
        `UPDATE tenant_declared_deposits
            SET status='confirmed', bank_transaction_id=$2, confirmed_at=NOW(),
                updated_at=NOW()
          WHERE id=$1 AND status = 'pending'`,
        [declarationId, txn.id])
    }

    await client.query('COMMIT')

    for (const f of afterCommit) {
      await f().catch(e => logger.error({ err: e }, '[deposit-confirm] after-commit step failed'))
    }
    if (escrowPaidToLandlord.length > 0) {
      await noteEscrowDepositPaidToLandlord(txn.id, txn.landlord_id, escrowPaidToLandlord)
    }

    // A credit was created (paid-ahead money, a late-fee refund): if it now
    // covers a whole bill, that bill is paid from it — in its own transaction,
    // after this one, so nothing here is mixed into it.
    if (paidAheadCreditId || refundCredits.length > 0) {
      await runWholeBillCheckAfterCommit({ tenantId: householdTenant, landlordId: txn.landlord_id })
    }

    // "covers $X of $Y owed": X is what this deposit paid, Y that plus what is
    // still owed now (after any bill the new credit paid in full).
    const owedAfterCents = await householdBankOwedCents(client, leaseIds, txn.landlord_id).catch(() => 0)
    const coverage = owedAfterCents > 0 ? coversText(linesCents, linesCents + owedAfterCents) : null

    // Notifications are deliberately OUTSIDE the transaction and never fatal.
    // A failed email must not roll back a settled rent payment.
    void notifyBothSides({
      tenantId: householdTenant, landlordId: txn.landlord_id, effectivePaidDate, unbilled, refunded,
      amount: toDollars(depositCents), paidAhead: toDollars(excessCents), coverage,
      auto: input.auto === true, postedDate: txn.posted_date,
    }).catch(e => logger.error({ err: e }, '[deposit-confirm] notify failed'))

    return {
      settledChargeIds: settledIds,
      effectivePaidDate,
      lateFeesUnbilled: unbilled,
      lateFeesRefunded: refunded,
      amountApplied: toDollars(linesCents),
      owedBefore: toDollars(owedBeforeCents),
      paidAhead: toDollars(excessCents),
      paidAheadCreditId,
      coverage,
      receiptId,
      declarationId,
      undo,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * A bank deposit paid a security-deposit charge whose record was planned as
 * GAM-held (GAM escrow). 10/4 (decisions #46.3): information only — a deposit
 * paid into the landlord's own bank is held by the landlord, so the record now
 * says so (or, when GAM already held part of it, this payment is told apart as
 * the landlord's part at move-out), and the landlord refunds it themselves.
 * Nothing needs doing by hand. Once per charge, by name. Never throws.
 */
async function noteEscrowDepositPaidToLandlord(
  bankTransactionId: string, landlordId: string,
  rows: Array<{ id: string; lease_id: string; amount: string; record_id: string | null; held_by: string | null }>,
): Promise<void> {
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    for (const r of rows) {
      await createAdminNotification({
        severity: 'info',
        category: 'escrow_deposit_paid_to_landlord',
        title: `A $${Number(r.amount).toFixed(2)} security deposit planned for GAM to hold was paid into the landlord’s bank`,
        body: `Payment ${r.id} (lease ${r.lease_id}) was settled from bank deposit ${bankTransactionId}: the money is in the landlord’s bank, ` +
          `so the landlord holds it. Deposit record ${r.record_id} counts it ` +
          (r.held_by === 'landlord'
            ? 'and now says the landlord holds the deposit: GAM accrues no interest on it, does not count it in trust, and never refunds it — the landlord does at move-out.'
            : 'as the landlord’s part of a deposit GAM holds the rest of: at move-out the landlord refunds this part themselves and GAM refunds only what it holds.') +
          ' For your information — nothing needs doing.',
        context: { payment_id: r.id, lease_id: r.lease_id, security_deposit_id: r.record_id,
                   bank_transaction_id: bankTransactionId, landlord_id: landlordId, amount: Number(r.amount),
                   held_by: r.held_by },
      })
    }
  } catch (e) {
    logger.error({ err: e, ctx: bankTransactionId }, '[deposit-confirm] escrow-deposit alert failed')
  }
}

/**
 * Step 9 review (fix pass 3): the match that settled a security deposit
 * planned for GAM to hold from the landlord's bank was undone. The earlier
 * notice (noteEscrowDepositPaidToLandlord) no longer applies: the charge is
 * owed again and the deposit record — amount, status and who holds it — is
 * back as it was. GAM is told once per earlier notice, by name. Never throws.
 */
async function noteEscrowDepositMatchUndone(bankTransactionId: string, reopenedIds: string[]): Promise<void> {
  try {
    const earlier = await query<{ id: string; context: any }>(
      `SELECT n.id, n.context FROM admin_notifications n
        WHERE n.category = 'escrow_deposit_paid_to_landlord'
          AND n.context->>'bank_transaction_id' = $1
          AND n.context->>'payment_id' = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM admin_notifications u
                           WHERE u.category = 'escrow_deposit_paid_to_landlord_undone'
                             AND u.context->>'earlier_notice_id' = n.id::text)
        ORDER BY n.created_at, n.id`, [bankTransactionId, reopenedIds])
    if (earlier.length === 0) return
    const { createAdminNotification } = await import('./adminNotifications')
    for (const n of earlier) {
      const c = n.context ?? {}
      await createAdminNotification({
        severity: 'warn',
        category: 'escrow_deposit_paid_to_landlord_undone',
        title: `The landlord undid the bank match that paid a $${Number(c.amount ?? 0).toFixed(2)} GAM-escrow security deposit`,
        body: `Bank deposit ${bankTransactionId} no longer pays payment ${c.payment_id} (lease ${c.lease_id}): the deposit charge is owed again. ` +
          'The earlier notice that this deposit was paid into the landlord’s bank no longer applies: the deposit record was put back as it was before the match.',
        context: { earlier_notice_id: n.id, payment_id: c.payment_id, lease_id: c.lease_id,
                   security_deposit_id: c.security_deposit_id ?? null, bank_transaction_id: bankTransactionId },
      })
    }
  } catch (e) {
    logger.error({ err: e, ctx: bankTransactionId }, '[deposit-undo] escrow-deposit undo notice failed')
  }
}

/**
 * Tell both parties, with the REASON (Nic, S624).
 *
 * A money figure must never change silently on either side. The tenant needs to
 * know their late fee went away and why; the landlord needs to see the reversal
 * on their own ledger rather than discovering a number moved.
 */
async function notifyBothSides(o: {
  tenantId: string; landlordId: string; effectivePaidDate: string
  unbilled: number; refunded: number; amount: number; paidAhead: number; coverage: string | null
  /** S655 (Step 12): settled by itself on amount — both sides are told, the landlord with Undo. */
  auto?: boolean; postedDate?: string
}): Promise<void> {
  const reversed = o.unbilled + o.refunded
  const aheadLine = o.paidAhead > 0
    ? ` $${o.paidAhead.toFixed(2)} more than the bills it paid is kept as money paid ahead for later bills.`
    : ''
  const coverLine = o.coverage ? ` It ${o.coverage} — the rest is still due.` : ''

  const tenantUser = (await queryOne<{ user_id: string }>(
    `SELECT user_id FROM tenants WHERE id=$1`, [o.tenantId]))?.user_id
  if (tenantUser) {
    const lateLine = reversed > 0
      ? ` Your late ${reversed === o.refunded ? 'fee has been refunded' : 'fees have been removed'} — $${reversed.toFixed(2)} — because your deposit shows you paid on ${o.effectivePaidDate}.`
      : ''
    await createNotification({
      userId: tenantUser,
      type: 'payment_recorded',
      title: 'Your bank deposit has been applied',
      body: o.auto
        ? `We applied your $${o.amount.toFixed(2)} deposit of ${o.postedDate ?? o.effectivePaidDate} to your bill — it matched what you owed to the cent. If it wasn’t yours, tell your landlord.${lateLine}`
        : `We matched your $${o.amount.toFixed(2)} deposit and applied it to your bill, dated ${o.effectivePaidDate}.${coverLine}${aheadLine}${lateLine}`,
      actionUrl: '/payments',
    })
  }

  const landlordUser = (await queryOne<{ owner_user_id: string }>(
    `SELECT user_id AS owner_user_id FROM landlords WHERE id=$1`, [o.landlordId]))?.owner_user_id
  if (landlordUser) {
    const lateLine = reversed > 0
      ? ` $${reversed.toFixed(2)} in late fees was reversed — the deposit is dated ${o.effectivePaidDate}.`
      : ''
    await createNotification({
      userId: landlordUser,
      landlordId: o.landlordId,
      // Reuses the existing landlord type so this lands in the same place as
      // every other "your rent arrived" notice, and honors the same preference.
      type: 'rent_collected',
      title: o.auto ? 'A bank deposit was applied to rent by itself' : 'A bank deposit was applied to rent',
      body: o.auto
        ? `Your $${o.amount.toFixed(2)} bank deposit of ${o.postedDate ?? o.effectivePaidDate} was auto-applied — it was exactly one tenant’s whole bill and nothing else fit. ` +
          `If that is wrong, press Undo on it under Bank → Bank feed.${lateLine}`
        : `A $${o.amount.toFixed(2)} deposit was matched to rent and recorded as paid ${o.effectivePaidDate}.${coverLine}${aheadLine}${lateLine}`,
      actionUrl: o.auto ? '/bank?tab=feed' : '/payments',
    })
  }
}

/**
 * The bank voided a deposit that was already matched to rent (Step 9 review).
 *
 * A matched deposit settled rent, dated to the day the money moved. If the
 * bank later voids that deposit, no money came in — but the rent stays marked
 * paid: undoing a match is the landlord's decision (Step 12's Undo), never the
 * feed's. What must not happen is silence. The landlord and GAM are each told
 * once, in plain words, what the deposit paid and that the money never
 * arrived.
 *
 * For the bank feed to call when a MATCHED row turns void
 * (bankFeed.followTheBank and voidTheOriginal, which today only write a log
 * line). Never throws; returns whether anyone was told.
 */
export async function alertMatchedDepositVoided(transactionId: string): Promise<boolean> {
  try {
    const t = await queryOne<{
      landlord_id: string; amount: string; posted_date: string; status: string
      undo: DepositSettleUndo | null; matched_payment_id: string | null; owner_user_id: string | null
    }>(
      `SELECT bt.landlord_id, bt.amount::text AS amount, to_char(bt.posted_date,'YYYY-MM-DD') AS posted_date,
              bt.status, bt.auto_settle_undo AS undo, bt.matched_payment_id, l.user_id AS owner_user_id
         FROM bank_transactions bt JOIN landlords l ON l.id = bt.landlord_id
        WHERE bt.id = $1`,
      [transactionId])
    if (!t || t.status !== 'matched') return false
    const rowIds = t.undo?.rows?.length
      ? t.undo.rows.map(r => r.paymentId)
      : t.matched_payment_id ? [t.matched_payment_id] : []
    const who = rowIds.length === 0 ? null : await queryOne<{ name: string | null; spaces: string | null }>(
      `SELECT (SELECT NULLIF(TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')), '')
                 FROM payments p JOIN tenants tn ON tn.id = p.tenant_id JOIN users usr ON usr.id = tn.user_id
                WHERE p.id = ANY($1::uuid[]) ORDER BY p.id LIMIT 1) AS name,
              (SELECT string_agg(DISTINCT un.unit_number, ', ' ORDER BY un.unit_number)
                 FROM payments p JOIN units un ON un.id = p.unit_id
                WHERE p.id = ANY($1::uuid[])) AS spaces`,
      [rowIds])
    const amount = `$${toDollars(toCents(t.amount)).toFixed(2)}`
    const whose = who?.name ? `${who.name}${who.spaces ? ` (${who.spaces})` : ''}` : who?.spaces ? `the household at ${who.spaces}` : 'a tenant'
    if (t.owner_user_id) {
      await createNotification({
        userId: t.owner_user_id,
        landlordId: t.landlord_id,
        type: 'bank_deposit_voided',
        title: 'Your bank voided a deposit that paid rent',
        body: `Your bank voided the ${amount} deposit of ${t.posted_date} that was matched to ${whose}'s bills — the money did not come in. ` +
          'Those bills still show as paid. Talk with your tenant — if the money never arrived, those bills are still owed. GAM has been told too.',
        actionUrl: '/bank-feed',
      })
    }
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'bank_deposit_voided_after_match',
      title: `The bank voided a ${amount} deposit already matched to rent (${transactionId})`,
      body: `Deposit ${transactionId} (${t.posted_date}) settled ${rowIds.length} bill line(s) for ${whose}; the bank has now voided it, so no money came in. ` +
        'The lines are still settled. The landlord was told; confirm with them whether to undo the match.',
      context: {
        bank_transaction_id: transactionId, landlord_id: t.landlord_id, payment_ids: rowIds,
        receipt_id: t.undo?.receiptId ?? null, amount: toDollars(toCents(t.amount)),
      },
    })
    return true
  } catch (e) {
    logger.error({ err: e, transactionId }, '[deposit-confirm] could not tell anyone a matched deposit was voided')
    return false
  }
}

// ─── Undo (S655 money plan §3, K-C; Step 12) ─────────────────────────────────

/** What a bank row carries once its match was undone, so nothing automatic ever acts on it again. */
export interface UndoneMarker {
  version: 1
  undone: true
  undoneAt: string
  undoneBy: string | null
  /** The record of the match that was undone. */
  was: unknown
}

export interface UndoDepositResult {
  kind: 'tenant_deposit' | 'deposit_slip'
  /** Bill lines that are owed again. */
  reopenedChargeIds: string[]
  /** Late fees put back. */
  lateFeesRestored: number
  /** Credits withdrawn (late-fee refunds, paid-ahead money from the deposit). */
  creditsWithdrawn: string[]
  /** The tenant's report, back to waiting. */
  declarationId: string | null
  /** A slip staff made, open again (deposit_slip kind). */
  slipReopened?: boolean
}

/**
 * Undo a bank deposit's match — one a person confirmed, one the feed made by
 * itself, or a deposit slip's — exactly: every bill line it paid is owed again
 * as it was (a bank retry it replaced is not put back: that pull was canceled,
 * so the tenant pays again), the late fees it zeroed come back, the late-fee
 * refund credits it gave and the paid-ahead money it made are withdrawn, the
 * receipt is closed, the bank allocations are marked reversed, the on-time
 * marks it wrote are withdrawn, the tenant's report goes back to waiting, and
 * the bank row goes back to review — never to be acted on by itself again.
 *
 * REFUSED IF ANYTHING CHANGED SINCE: a line paid again, disputed or changed; a
 * zeroed fee no longer zero; a credit it made already used (or set aside for a
 * payment); the receipt already closed. The reason is said plainly and nothing
 * is changed.
 */
export async function undoDepositMatch(input: {
  bankTransactionId: string; landlordId: string; undoneBy: string | null
}): Promise<UndoDepositResult> {
  const client = await getClient()
  let result: UndoDepositResult
  let tenantToTell: { tenantId: string; amount: number; postedDate: string } | null = null
  const subjects = new Set<string>()
  try {
    await client.query('BEGIN')
    const txn = (await client.query<{
      id: string; landlord_id: string; status: string; amount: string; posted_date: string
      matched_disbursement_id: string | null; undo: any
    }>(
      `SELECT id, landlord_id, status, amount::text AS amount, to_char(posted_date,'YYYY-MM-DD') AS posted_date,
              matched_disbursement_id, auto_settle_undo AS undo
         FROM bank_transactions WHERE id = $1 FOR UPDATE`, [input.bankTransactionId])).rows[0]
    if (!txn || txn.landlord_id !== input.landlordId) throw new AppError(404, 'Deposit not found')
    if (txn.status !== 'matched') throw new AppError(409, 'This deposit is not matched to anything, so there is nothing to undo.')
    if (txn.matched_disbursement_id) {
      throw new AppError(409, 'This deposit is a payout GAM sent you. It is matched to that payout and there is nothing to undo.')
    }
    const undo = txn.undo
    const marker = (was: unknown): UndoneMarker => ({
      version: 1, undone: true, undoneAt: new Date().toISOString(), undoneBy: input.undoneBy, was,
    })

    if (undo?.kind === 'deposit_slip') {
      const { undoSlipMatch } = await import('./depositSlips')
      const r = await undoSlipMatch(client, {
        transactionId: txn.id, landlordId: txn.landlord_id, undo, undoneBy: input.undoneBy,
      })
      await client.query(
        `UPDATE bank_transactions
            SET status = 'needs_review', landlord_other_income_id = NULL, auto_settle_undo = $2::jsonb, updated_at = NOW()
          WHERE id = $1`, [txn.id, JSON.stringify(marker(undo))])
      await client.query('COMMIT')
      return {
        kind: 'deposit_slip', reopenedChargeIds: [], lateFeesRestored: 0, creditsWithdrawn: [],
        declarationId: null, slipReopened: r.reopened,
      }
    }

    const snap = undo as DepositSettleUndo | null
    if (!snap || snap.version !== 1 || !snap.receiptId || !Array.isArray(snap.rows)) {
      throw new AppError(409,
        'This deposit was matched before GAM kept a record of everything a match changes, so it can’t be undone here. Contact GAM support.')
    }
    const receipt = (await client.query<{ tenant_id: string; status: string }>(
      `SELECT tenant_id, status FROM tenant_remittances WHERE id = $1 FOR UPDATE`, [snap.receiptId])).rows[0]
    if (!receipt) throw new AppError(409, 'This deposit’s receipt is missing, so the match can’t be undone here. Contact GAM support.')
    if (receipt.status !== 'settled') throw new AppError(409, 'This deposit’s receipt was already closed, so there is nothing to undo.')

    // The household first, then the rows by id (§1.5).
    await lockHousehold(client, receipt.tenant_id, txn.landlord_id)
    const rowIds = snap.rows.map(r => r.paymentId)
    const feeIds = (snap.lateFeesZeroed ?? []).map(z => z.paymentId)
    await lockPaymentRowsById(client, [...rowIds, ...feeIds])

    // ── Has anything changed since? ──────────────────────────────────────────
    const changed = (why: string) => new AppError(409, `${why} Nothing was undone — the match stays as it is.`)
    if (rowIds.length > 0) {
      const live = (await client.query<{ id: string; status: string; manual_method: string | null; reopened: boolean; other_receipt: boolean; credit: boolean }>(
        `SELECT p.id, p.status, p.manual_method,
                EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id) AS reopened,
                EXISTS (SELECT 1 FROM remittance_applications ra JOIN tenant_remittances r ON r.id = ra.remittance_id
                         WHERE ra.payment_id = p.id AND ra.remittance_id <> $2 AND r.status <> 'failed') AS other_receipt,
                EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('held','applied')) AS credit
           FROM payments p WHERE p.id = ANY($1::uuid[])`, [rowIds, snap.receiptId])).rows
      if (live.length !== rowIds.length) throw changed('A bill line this deposit paid no longer exists.')
      for (const r of live) {
        if (r.status !== 'settled' || !r.manual_method) throw changed('A bill line this deposit paid has changed since (it is no longer paid by this deposit).')
        if (r.reopened) throw changed('A bill line this deposit paid was disputed or returned since.')
        if (r.other_receipt) throw changed('A bill line this deposit paid was also paid by another payment.')
        if (r.credit) throw changed('Account credit was used on a bill line this deposit paid.')
      }
    }
    if (feeIds.length > 0) {
      const fees = (await client.query<{ id: string; amount: string; status: string }>(
        `SELECT id, amount::text AS amount, status FROM payments WHERE id = ANY($1::uuid[])`, [feeIds])).rows
      if (fees.length !== feeIds.length || fees.some(f => toCents(f.amount) !== 0 || f.status !== 'settled')) {
        throw changed('A late fee this deposit took off has changed since.')
      }
    }
    const refundIds = snap.lateFeeRefundCreditIds ?? []
    if (refundIds.length > 0) {
      const used = (await client.query<{ id: string; status: string; used: boolean; amount: string }>(
        `SELECT tc.id, tc.status, tc.amount_original::text AS amount,
                EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.tenant_credit_id = tc.id AND cu.status <> 'released') AS used
           FROM tenant_credits tc WHERE tc.id = ANY($1::uuid[]) FOR UPDATE`, [refundIds])).rows
      for (const c of used) {
        if (c.used) throw changed(`The ${money(toCents(c.amount))} late-fee refund credit from this match has already been used (or is set aside for a payment).`)
        if (c.status !== 'active') throw changed('A late-fee refund credit from this match was voided since.')
      }
    }
    if (snap.paidAheadCreditId) {
      const pa = (await client.query<{ used: boolean; voided_at: Date | null; amount: string }>(
        `SELECT c.voided_at, c.amount_original::text AS amount,
                EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.prepaid_credit_id = c.id AND cu.status <> 'released') AS used
           FROM lease_prepaid_credits c WHERE c.id = $1 FOR UPDATE`, [snap.paidAheadCreditId])).rows[0]
      if (pa?.used) throw changed(`The ${money(toCents(pa.amount))} paid ahead from this deposit has already been used to pay a bill.`)
      if (pa?.voided_at) throw changed('The paid-ahead money from this deposit was withdrawn since.')
    }
    // Step 9 review (fix pass 1): a security deposit this deposit paid raised
    // the deposit record. Once that deposit has been returned at move-out (or
    // carried to another lease, or lowered since), taking the payment back
    // would leave the tenant refunded money that was never paid.
    const raised = snap.securityDepositRaised ?? []
    for (const r of raised) {
      const sd = (await client.query<{ collected: string; status: string; disbursed_at: Date | null; returned: boolean }>(
        `SELECT sd.collected_amount::text AS collected, sd.status, sd.disbursed_at,
                EXISTS (SELECT 1 FROM deposit_returns dr
                         WHERE dr.security_deposit_id = sd.id AND dr.finalized_at IS NOT NULL) AS returned
           FROM security_deposits sd WHERE sd.id = $1 FOR UPDATE`, [r.depositId])).rows[0]
      if (!sd) throw changed('The security deposit this deposit paid no longer exists.')
      if (sd.returned || sd.disbursed_at || sd.status === 'disbursed') {
        throw changed('The security deposit this deposit paid has already been returned at move-out.')
      }
      if (toCents(sd.collected) < toCents(r.amount)) {
        throw changed('The security deposit this deposit paid has changed since (it holds less than this deposit put in).')
      }
    }

    // ── Put everything back ──────────────────────────────────────────────────
    const day = new Date().toISOString().slice(0, 10)
    const reopenedIds: string[] = []
    for (const r of snap.rows) {
      // Owed again as it was: pending, or failed (payable). A bank retry this
      // deposit replaced was canceled, so it is not scheduled again.
      const prior = r.priorStatus === 'failed' ? 'failed' : 'pending'
      const u = await client.query(
        `UPDATE payments
            SET status = $2, settled_at = NULL, manual_method = NULL, next_retry_at = NULL, platform_held = FALSE,
                notes = COALESCE(notes || ' — ', '') || $3
          WHERE id = $1 AND status = 'settled'`,
        [r.paymentId, prior, `Bank deposit match undone ${day} — owed again`])
      if ((u.rowCount ?? 0) !== 1) throw changed('A bill line this deposit paid has changed since.')
      reopenedIds.push(r.paymentId)
    }
    // Fix pass (rev9, decisions #55): a line this deposit paid that was a
    // charge a dispute or bank return had reopened: the deposit's payment had
    // resolved that reversal as paid in person (the landlord holds it — and a
    // reopened move-out deposit charge took the refill off their payout).
    // That payment is gone, so the resolution is undone with it: the refill is
    // given back to the landlord and the reversal is open again (the tenant
    // owes the line again; the landlord is never left charged for cash they
    // did not get). Inside this transaction, after the line is owed again.
    const reopenedReversals = (await client.query<{ reversal_id: string }>(
      `SELECT DISTINCT reversal_id::text AS reversal_id FROM payments
        WHERE id = ANY($1::uuid[]) AND reversal_id IS NOT NULL ORDER BY 1`, [reopenedIds])).rows.map(x => x.reversal_id)
    if (reopenedReversals.length > 0) {
      const { undoTenantPaidResolution } = await import('./paymentReversal')
      for (const id of reopenedReversals) await undoTenantPaidResolution(client, id)
    }
    for (const z of snap.lateFeesZeroed ?? []) {
      await client.query(
        `UPDATE payments SET amount = $2, status = $3, settled_at = NULL, notes = $4
          WHERE id = $1 AND amount = 0 AND status = 'settled'`,
        [z.paymentId, toDollars(toCents(z.priorAmount)).toFixed(2), z.priorStatus === 'settled' ? 'pending' : z.priorStatus, z.priorNotes])
    }
    const withdrawn: string[] = []
    for (const id of refundIds) {
      await client.query(
        `UPDATE tenant_credits SET status = 'void', voided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'active'`, [id])
      withdrawn.push(id)
    }
    if (snap.paidAheadCreditId) {
      await voidPaidAhead(client, snap.paidAheadCreditId, `Bank deposit of ${txn.posted_date} match undone`)
      withdrawn.push(snap.paidAheadCreditId)
    }
    for (const r of raised) {
      await client.query(
        `UPDATE security_deposits
            SET collected_amount = collected_amount - $2::numeric,
                status = CASE WHEN collected_amount - $2::numeric <= 0 THEN 'pending'
                              WHEN collected_amount - $2::numeric < total_amount THEN 'partial'
                              ELSE status END,
                -- 10/4 (decisions #46.3): who holds it goes back to what it was
                -- before this deposit paid it (the match recorded the landlord).
                held_by = COALESCE($4, held_by),
                notes = LEFT(COALESCE(notes || E'\\n', '') || $3, 2000),
                updated_at = NOW()
          WHERE id = $1`,
        [r.depositId, toDollars(toCents(r.amount)).toFixed(2),
         `Bank deposit of ${txn.posted_date} match undone ${day}: the $${toDollars(toCents(r.amount)).toFixed(2)} it paid toward the deposit is owed again`,
         r.priorHeldBy ?? null])
    }
    await client.query(
      `UPDATE bank_deposit_allocations SET reversed_at = NOW(), reversed_by = $2
        WHERE bank_transaction_id = $1 AND reversed_at IS NULL`, [txn.id, input.undoneBy])
    await client.query(
      `UPDATE tenant_remittances
          SET status = 'failed', updated_at = NOW(),
              notes = COALESCE(notes || ' — ', '') || $2
        WHERE id = $1 AND status = 'settled'`,
      [snap.receiptId, `Undone ${day}: this bank deposit was taken back off the bills it paid`])
    // The on-time marks this settle wrote were never earned by this money:
    // withdrawn (a mark pointing at itself is withdrawn; the score skips it).
    for (const id of snap.creditEventIds ?? []) {
      const e = (await client.query<{ subject_id: string; superseded_by: string | null }>(
        `SELECT subject_id, superseded_by FROM credit_events WHERE id = $1 FOR UPDATE`, [id])).rows[0]
      if (!e || e.superseded_by) continue
      await supersedeEvent(client, id, id, 'attestation_invalidated')
      subjects.add(e.subject_id)
    }
    if (snap.declarationId) {
      await client.query(
        `UPDATE tenant_declared_deposits
            SET status = 'pending', bank_transaction_id = NULL, confirmed_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'confirmed' AND bank_transaction_id = $2`, [snap.declarationId, txn.id])
    }
    await client.query(
      `UPDATE bank_transactions
          SET status = 'needs_review', matched_payment_id = NULL, auto_settled_at = NULL,
              auto_settle_undo = $2::jsonb, updated_at = NOW()
        WHERE id = $1`, [txn.id, JSON.stringify(marker(snap))])
    await client.query('COMMIT')
    tenantToTell = { tenantId: receipt.tenant_id, amount: toDollars(toCents(txn.amount)), postedDate: txn.posted_date }
    result = {
      kind: 'tenant_deposit', reopenedChargeIds: reopenedIds,
      lateFeesRestored: (snap.lateFeesZeroed ?? []).length, creditsWithdrawn: withdrawn,
      declarationId: snap.declarationId ?? null,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  if (subjects.size > 0) {
    const { recomputeAndSnapshot } = await import('./creditScore')
    for (const s of subjects) {
      await recomputeAndSnapshot(s).catch(err =>
        logger.error({ err, subjectId: s }, '[deposit-undo] score recompute failed; the nightly run picks it up'))
    }
  }
  if (result.reopenedChargeIds.length > 0) {
    await noteEscrowDepositMatchUndone(input.bankTransactionId, result.reopenedChargeIds)
  }
  if (tenantToTell) {
    const t = tenantToTell
    void (async () => {
      const u = (await queryOne<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [t.tenantId]))?.user_id
      if (!u) return
      await createNotification({
        userId: u,
        type: 'payment_recorded',
        title: 'A bank deposit is no longer applied to your bill',
        body: `Your landlord took the $${t.amount.toFixed(2)} bank deposit of ${t.postedDate} back off your bill — it did not match your payment. ` +
          'What it paid is owed again. If you made that deposit, tell your landlord.',
        actionUrl: '/payments',
      })
    })().catch(e => logger.error({ err: e }, '[deposit-undo] tenant notice failed'))
  }
  return result
}
