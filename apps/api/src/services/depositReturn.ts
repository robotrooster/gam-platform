import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import type Stripe from 'stripe'
import { db, query, queryOne, getClient } from '../db'
import { appendEvent } from './creditLedger'
import { ensureBillsForUnit } from './utilityBilling'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'
import { todayIn } from '../lib/timezone'
import { AppError } from '../middleware/errorHandler'
import { lockHousehold, payableRowSql, depositOrMoveOutRowSql } from './moneyPredicates'
import { disputeClaimOnCredit, supersedeScheduledRetry, cancelSupersededIntents } from './creditUse'
import { computePlatformCut } from './stripeConnect'
import { depositCollectedBySql } from './leaseFeesSync'
import { EARLY_CHECKOUT_CHOICE_LABEL, LEASE_COLUMN_LABEL, PAYMENT_ENTRY_DESCRIPTION_LABELS, isUsFederalHoliday } from '@gam/shared'

// ============================================================
// Deposit-return service.
//
// Calculation model:
//   total_deposit         from security_deposits.total_amount
//   cleaning_fee_amount   sum of lease_fees with due_timing 'move_out' or
//                         'other' (cleaning, ending early, other move-out
//                         fees), read live at preview, draft and finalize
//                         (liveMoveOutFees)
//   damage_lines          landlord-added at finalize time
//   other_deductions      catch-all (utilities, last-month-rent, etc.)
//   total_deductions      = cleaning_fee + sum(damage_lines.amount) + sum(other_deductions.amount)
//   refund_amount         = MAX(0, deposit side - total_deductions)
//                           (deposit side = deposits + interest owed; the
//                           deductions come out of it FIRST — decisions #46.2)
//   gap_amount            = what the deposit side and then the tenant's
//                           paid-ahead money cannot cover (moveOutMath)
//   refund_from_gam / refund_from_landlord
//                         = who sends which part of the refund: whoever holds
//                           each deposit (decisions #46.3, refundSplit)
//
// Finalize flow:
//   1. Stamp finalized_at + status (sent_refund / sent_gap / sent_zero)
//   2. If refund_amount > 0: create a 'fee'-type payments row (negative)
//      that records the refund to the tenant. 10/4 (decisions #47a): the
//      part GAM holds (refund_from_gam) is SENT AUTOMATICALLY after the
//      commit, back the way the deposit was paid — one refund part per
//      deposit payment, most recent first (services/depositRefundSend, the
//      early check-out's refund parts); a part the payment cannot take is on
//      the owner's to-do list until it is sent or given back in cash. The
//      refund row stays 'pending' until every part GAM sends has gone back.
//      The landlord's own part (refund_from_landlord) they hand back
//      themselves and mark handed back on the move-out page.
//   3. If gap_amount > 0: create a 'fee'-type payments row for the
//      gap (status='pending'); attempt auto-charge against tenant's
//      on-file payment method via the existing Stripe Customer.
//      On charge success: payment row remains (will flip to 'settled'
//      via the standard webhook). On charge failure: gap_charge_failed
//      stays true; landlord sees the failure on the deposit_returns
//      row + admin notification fires.
//   4. Emit credit-ledger events:
//        - deposit_returned_full (refund_amount == total_deposit)
//        - deposit_returned_partial (refund_amount > 0 and < total_deposit)
//        - deposit_returned_zero (refund_amount == 0 and gap_amount == 0)
//        - tenancy_ended_with_balance (gap_amount > 0)
// ============================================================

export interface DamageLine {
  description: string
  amount: number
  // W-31: documents ids proving the damage (photo/receipt). Required ≥1 by
  // the route schema; stored verbatim in the damage_lines jsonb.
  evidenceDocumentIds?: string[]
}

export interface DepositReturnDraftInput {
  leaseId: string
  damageLines?: DamageLine[]
  otherDeductions?: DamageLine[]
  notes?: string
}

export interface DepositReturnRow {
  id: string
  lease_id: string
  tenant_id: string
  landlord_id: string
  security_deposit_id: string | null
  total_deposit: string
  cleaning_fee_amount: string
  unpaid_balance_amount: string  // S180: snapshot of auto-swept unpaid payments
  damage_lines: DamageLine[]
  other_deductions: DamageLine[]
  total_deductions: string
  refund_amount: string
  gap_amount: string
  status: string
  refund_payment_id: string | null
  gap_payment_id: string | null
  gap_charge_failed: boolean
  gap_charge_failure_reason: string | null
  finalized_at: string | null
  finalized_by_user_id: string | null
  /** 10/4 (decisions #46.3): who refunds which part, as finalize recorded it (NULL before it was recorded). */
  refund_from_gam?: string | null
  refund_from_landlord?: string | null
  /** 10/4 (decisions #46.4): the lines finalize closed as no longer owed (NULL before it was recorded). */
  closed_at_move_out_lines?: ClosedAtMoveOutLine[] | null
  notes: string | null
  created_at: string
  updated_at: string
}

const round2 = (n: number) => Math.round(n * 100) / 100
const sumLines = (lines: DamageLine[]) =>
  round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0))

// S180 / A1: shape of a single unpaid-balance line surfaced by the
// auto-sweep. Each row is a payments-table row (rent / utility /
// late_fee / fee with status pending or failed) that the deposit
// covers at finalize time. Returned alongside the existing
// damage_lines + other_deductions buckets so the UI can render a
// distinct "auto-pulled" section.
export interface UnpaidBalanceLine {
  payment_id:        string
  type:              string  // 'rent' | 'utility' | 'late_fee' | 'fee'
  amount:            number
  due_date:          string  // ISO date
  entry_description: string
  status:            'pending' | 'failed'
}

/**
 * S655: the leases one tenancy has run under — this lease and every lease it
 * follows as a NEW LEASE OF THE SAME HOUSEHOLD (an e-signed renewal), as a
 * subquery on $1.
 *
 * A renewal (month-to-month included) hands the household's OPEN items to the
 * new lease, but money already settled stays on the lease it was paid on, and
 * so does anything left unpaid there. A $200 pet deposit paid on the old lease
 * was missing from the renewal's move-out (the landlord kept the tenant's
 * money), and the old lease's unpaid lines were outside the sweep. Settled rows
 * never move, so reading the whole chain counts each one once.
 *
 * Only a real renewal is followed: an e-signed lease whose own signing named the
 * lease it renews (lease_documents.renews_lease_id — the only way an e-signed
 * lease gets supersedes_lease_id). supersedes_lease_id is ALSO written by the
 * PDF import, which links a new import to whatever lease was in force on the
 * same unit — very often a DIFFERENT household. Followed blindly, that
 * household's settled pet and key deposits were refunded to the new one, and
 * their unpaid bills were swept against the new household's deposit (and marked
 * paid from it at finalize). Same gate as invoiceGeneration.isRenewalSuccessor.
 */
const LEASE_CHAIN = `(WITH RECURSIVE chain(id) AS (
      SELECT $1::uuid
      UNION
      SELECT cl.supersedes_lease_id FROM leases cl JOIN chain c ON cl.id = c.id
       WHERE cl.supersedes_lease_id IS NOT NULL
         AND cl.lease_source = 'esigned'
         AND EXISTS (SELECT 1 FROM lease_documents rd
                      WHERE rd.lease_id = cl.id AND rd.renews_lease_id = cl.supersedes_lease_id))
    SELECT id FROM chain)`

/**
 * S655: the lines the deposit pays at move-out — every line still owed now on
 * the tenancy (moneyPredicates.payableRowSql: never a line work trade covers,
 * never GAM's FlexPay collection, never one whose money is already on its
 * way), except move-out rows themselves, at what is still owed on it in money
 * (the line less any credit already spent on it, v_payment_money). Before
 * this the sweep took work-trade lines (labor pays those — nothing is owed)
 * and FlexPay's own collection out of the tenant's deposit. $1 = the lease.
 *
 * Step 9 review (fix pass 1):
 *   - Only a deposit charge or a move-out row (refund or shortfall —
 *     moneyPredicates.depositOrMoveOutRowSql) and an unpaid deposit charge
 *     itself are left out. A NON-refundable pet, key, cleaning or utility
 *     "deposit" fee is an ordinary fee (type 'fee', entry DEPOSIT, with its
 *     lease fee behind it) and is owed like any other: before this, every
 *     DEPOSIT-entry row was dropped, so an unpaid one was never deducted and
 *     the tenant was refunded that much more while still owing it.
 *   - A prepaid box (revenue_owner 'held': money the tenant would have paid
 *     AHEAD, which becomes paid-ahead money only when it settles) is never
 *     swept. It is not money owed; paying it from the deposit turned the
 *     tenant's money into nothing (paid_via_deposit never makes paid-ahead
 *     money).
 *   - GAM's own lines (revenue_owner 'gam': a returned-payment or declined-card
 *     fee, a platform fee passed to tenants, a GAM subscription) ARE swept —
 *     the tenant owes them — and finalize routes their money to GAM, never to
 *     the landlord (revenue_owner is returned for that).
 */
const SWEEP_LINES_SQL = `
  SELECT p.id, p.type, vm.money_part::text AS amount, p.due_date::text AS due_date,
         p.entry_description, p.status, p.revenue_owner
    FROM payments p
    JOIN v_payment_money vm ON vm.payment_id = p.id
   WHERE p.lease_id IN ${LEASE_CHAIN}
     AND ${payableRowSql('p')}
     AND NOT ${depositOrMoveOutRowSql('p')}
     AND p.type <> 'deposit'
     AND p.revenue_owner <> 'held'
     AND vm.money_part > 0`

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100

/** A paid-ahead credit that joins the move-out pool, and how much of it does. */
interface PoolableCredit { id: string; leaseId: string; usable: number }

/**
 * S655 (money plan §3, Move-out): the tenant's paid-ahead money on this tenancy
 * that joins the deposit pool. Every paid-ahead credit on the lease chain that
 * is not withdrawn (voided credit never joins), less whatever a dispute or
 * return of its own funding still claims on it (creditUse.disputeClaimOnCredit):
 * money Stripe took back is not the tenant's to have back.
 * `lock` locks the credits (finalize); the preview reads without locks.
 */
async function poolablePaidAhead(client: PoolClient, leaseId: string, lock: boolean): Promise<PoolableCredit[]> {
  const rows = (await client.query<{ id: string; lease_id: string; amount_remaining: string }>(
    `SELECT c.id, c.lease_id, c.amount_remaining::text AS amount_remaining
       FROM lease_prepaid_credits c
      WHERE c.lease_id IN ${LEASE_CHAIN}
        AND c.voided_at IS NULL
        AND c.amount_remaining > 0
        -- Fix pass 1 (final fix): money a paid-ahead choice already left as the
        -- tenant's credit (decisions #46.1a, lease_prepaid_credits
        -- .left_by_choice_id) is decided — it waits for their next lease with
        -- this landlord, and no move-out counts or offers it again (the same
        -- rule services/paidAheadChoice reads by).
        AND c.left_by_choice_id IS NULL
      ORDER BY c.created_at, c.id
      ${lock ? 'FOR UPDATE' : ''}`,
    [leaseId])).rows
  const out: PoolableCredit[] = []
  for (const r of rows) {
    const k = await disputeClaimOnCredit(client, r.id)
    const remaining = toCents(r.amount_remaining)
    const claimed = k.paymentIntentId == null ? 0 : k.full ? remaining : Math.min(remaining, toCents(k.claim))
    const usable = remaining - claimed
    if (usable > 0) out.push({ id: r.id, leaseId: r.lease_id, usable: toDollars(usable) })
  }
  return out
}

/** The preview's read of poolablePaidAhead (its own connection, no locks). */
async function poolablePaidAheadTotal(leaseId: string): Promise<number> {
  const client = await getClient()
  try {
    const credits = await poolablePaidAhead(client, leaseId, false)
    return toDollars(credits.reduce((s, c) => s + toCents(c.usable), 0))
  } finally {
    client.release()
  }
}

type Runner = Pick<PoolClient, 'query'>

/** Deposit interest the annual payout credited that the tenant never spent. */
interface InterestCredit { id: string; leaseId: string; amount: number }

/**
 * Step 9 review (fix pass 2): the statutory deposit interest the annual payout
 * already CREDITED to the tenant (tenant_credits, category deposit_interest)
 * that is still unspent at move-out. It is the tenant's interest on the
 * deposit — owed back with the deposit, exactly like the interest not yet
 * credited (unpaidDepositInterest) — so it joins the move-out pool through the
 * credit ledger (one 'move_out' use per credit). Before this it sat on the
 * ended lease, neither refunded nor paid out. GAM holds it (v_credit_uses
 * .gam_held). `lock` locks the credits (finalize); the preview reads without.
 */
async function unspentInterestCredits(runner: Runner, leaseId: string, lock: boolean): Promise<InterestCredit[]> {
  const rows = (await runner.query<{ id: string; lease_id: string; amount_remaining: string }>(
    `SELECT tc.id, tc.lease_id, tc.amount_remaining::text AS amount_remaining
       FROM tenant_credits tc
      WHERE tc.lease_id IN ${LEASE_CHAIN}
        AND tc.category = 'deposit_interest'
        AND tc.status = 'active'
        AND tc.amount_remaining > 0
      ORDER BY tc.created_at, tc.id
      ${lock ? 'FOR UPDATE' : ''}`,
    [leaseId])).rows
  return rows.map((r) => ({ id: r.id, leaseId: r.lease_id, amount: toDollars(toCents(r.amount_remaining)) }))
}

const sumCredits = (cs: ReadonlyArray<{ amount: number }>): number =>
  toDollars(cs.reduce((s, c) => s + toCents(c.amount), 0))

/**
 * A deposit payment on the tenancy that settled, and who holds its money.
 *   kind 'box'      — a pet, key or cleaning deposit (S653): its own amount is
 *                     in the move-out pool.
 *   kind 'security' — a payment toward the security deposit. The pool counts
 *                     the deposit record (security_deposits.collected_amount),
 *                     never these rows; they only say who holds that money.
 */
interface SettledDepositPayment {
  id: string
  kind: 'box' | 'security'
  amount: number
  gamHeld: boolean
  /** What the landlord's page calls it: the box's printed label, else the lease column's name. */
  label: string
}

/**
 * Step 9 review (money plan §3, Move-out: "pool split by holder"): every
 * deposit payment on the tenancy that settled, and WHO HOLDS ITS MONEY — a
 * fact read off how it was paid, never a choice.
 *   GAM holds it when it settled on GAM's balance (platform_held) with no
 *   hand-payment method: a card or bank payment through GAM — the ONE rule
 *   (leaseFeesSync.depositCollectedBySql) the deposit record's holder is set
 *   by too, so the record and this split always agree. The weekly payout
 *   never passes a deposit through (landlordPassthrough, S602 deposit trust),
 *   so GAM still holds it at move-out. These are exactly the rows GAM's own
 *   balance book counts as deposits it holds (stripeCosts
 *   .loadPlatformBalanceBook).
 *   The landlord holds it otherwise: paid at the desk, matched from a bank
 *   deposit, posted by the landlord, or imported.
 * The deposit record's own pool is not split here: a GAM-escrow record is all
 * GAM's (only a payment through GAM or a FlexDeposit installment raises it); a
 * landlord-held record is the landlord's except the payments GAM took for it.
 * `lock` locks the rows (finalize); the preview reads without locks.
 */
async function settledDepositPayments(runner: Runner, leaseId: string, lock: boolean): Promise<SettledDepositPayment[]> {
  const rows = (await runner.query<{
    id: string; kind: 'box' | 'security'; amount: string; gam_held: boolean
    fee_type: string | null; description: string | null
  }>(
    `SELECT p.id,
            CASE WHEN p.lease_fee_id IS NULL THEN 'security' ELSE 'box' END AS kind,
            p.amount::text AS amount,
            (${depositCollectedBySql('p')} = 'gam') AS gam_held,
            lf.fee_type, NULLIF(btrim(lf.description), '') AS description
       FROM payments p
       LEFT JOIN lease_fees lf ON lf.id = p.lease_fee_id
      WHERE p.lease_id IN ${LEASE_CHAIN}
        AND p.type = 'deposit' AND p.status = 'settled' AND p.amount > 0
        AND (p.lease_fee_id IS NULL
             OR (lf.money_kind = 'deposit' AND lf.fee_type <> 'security_deposit'))
      ORDER BY p.settled_at NULLS LAST, p.id
      ${lock ? 'FOR UPDATE OF p' : ''}`,
    [leaseId])).rows
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: Number(r.amount),
    gamHeld: r.gam_held === true,
    label: r.kind === 'security'
      ? 'Security deposit'
      : r.description ?? (LEASE_COLUMN_LABEL as Record<string, string>)[r.fee_type ?? ''] ?? 'Deposit',
  }))
}

/**
 * The deposit money in the move-out pool, read live: the security deposit plus
 * every pet, key and cleaning deposit that settled on the tenancy (S653), with
 * who holds each payment.
 *
 * The security deposit is what the record says was collected (S262: never the
 * promised total) — less any of it a bank return or a dispute took back that
 * the tenant has not paid again (Step 9 review, fix pass 2). A return never
 * lowers the record (services/paymentReversal reopens the charge instead), so
 * a $500 deposit paid through GAM and sent back by the bank still read $500
 * collected, and GAM was recorded as refunding money Stripe had already taken.
 * The reopened line, still unpaid, is what is missing; once it is paid again
 * nothing is (the re-payment never raises the record a second time —
 * leaseFeesSync.reconcileSettledDepositPayment).
 *
 * With NO record (a lease whose deposit record was never made, or was removed
 * because nothing was ever paid on it), only security-deposit payments that
 * actually settled count — never the lease's deposit fee: a fee is what the
 * lease asks for, not money anyone holds (decisions #46.4: "a deposit is only
 * ever refunded"). Before this a lease ended before its tenant paid anything
 * showed its $500 deposit fee as $500 held and a $500 refund.
 */
async function liveDepositPool(runner: Runner, leaseId: string, lock: boolean): Promise<{
  security: number
  boxes: number
  total: number
  payments: SettledDepositPayment[]
  /** Security deposit the record counts that a return or dispute took back, not paid again. */
  securityReturnedUnpaid: number
}> {
  const sd = (await runner.query<{ collected_amount: string }>(
    `SELECT collected_amount::text AS collected_amount FROM security_deposits WHERE lease_id = $1 LIMIT 1`,
    [leaseId])).rows[0]
  const payments = await settledDepositPayments(runner, leaseId, lock)
  let security: number
  let returnedUnpaid = 0
  if (sd) {
    const reopened = (await runner.query<{ total: string }>(
      `SELECT COALESCE(SUM(p.amount), 0)::text AS total
         FROM payments p
        WHERE p.lease_id IN ${LEASE_CHAIN} AND p.type = 'deposit' AND p.lease_fee_id IS NULL
          AND p.reversal_id IS NOT NULL AND p.status IN ('pending', 'failed') AND p.amount > 0`,
      [leaseId])).rows[0]
    const collected = toCents(sd.collected_amount)
    returnedUnpaid = Math.min(collected, toCents(reopened?.total))
    security = toDollars(collected - returnedUnpaid)
  } else {
    security = toDollars(payments.filter((p) => p.kind === 'security').reduce((t, p) => t + toCents(p.amount), 0))
  }
  const boxes = toDollars(payments.filter((p) => p.kind === 'box').reduce((s, p) => s + toCents(p.amount), 0))
  return { security, boxes, total: round2(security + boxes), payments, securityReturnedUnpaid: toDollars(returnedUnpaid) }
}

/** Final utility bills never billed onto an invoice (the last meter read lands at move-out). */
async function finalUtilityTotal(leaseId: string): Promise<number> {
  const r = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(charge_amount + tax_amount), 0)::text AS total
       FROM utility_bills
      WHERE lease_id IN ${LEASE_CHAIN} AND payment_id IS NULL AND status IN ('unbilled', 'billed')`,
    [leaseId])
  return round2(Number(r?.total ?? 0))
}

/**
 * Step 9 review (fix pass 1): the statutory deposit interest the tenant is
 * still OWED at move-out — what accrued on the record less what was already
 * paid to them.
 *
 * security_deposits.interest_accrued is the running total of EVERY month that
 * accrued (depositInterest re-sums the accrual log), including the months the
 * annual payout already credited to the tenant (depositInterestPayout stamps
 * those accruals paid_at and issues a deposit_interest credit; it never lowers
 * the total). Reading the total here paid those months twice: a $1,000
 * GAM-escrow deposit at 5% credits $50 after a year — spent on rent and paid to
 * the landlord — and a move-out in month 13 pooled $54.17, so GAM paid the
 * same $50 again. What is owed is the total less every paid month, each paid
 * figure rounded to the cent as the payout credited it. A record with no
 * accrual log (hand-entered) owes its whole total, as before.
 *
 * `lock` (finalize) locks the record and the unpaid accrual rows, so the
 * annual payout cannot credit a month this move-out is paying (the payout also
 * takes the household lock first, which finalize holds).
 */
async function unpaidDepositInterest(runner: Runner, leaseId: string, lock: boolean): Promise<{
  depositId: string | null
  amount: number
  unpaidAccrualIds: string[]
}> {
  const sd = (await runner.query<{ id: string; interest_accrued: string | null }>(
    `SELECT id, interest_accrued::text AS interest_accrued
       FROM security_deposits WHERE lease_id = $1 LIMIT 1
       ${lock ? 'FOR UPDATE' : ''}`,
    [leaseId])).rows[0]
  if (!sd) return { depositId: null, amount: 0, unpaidAccrualIds: [] }
  const paid = (await runner.query<{ paid: string }>(
    `SELECT COALESCE(SUM(t.amount), 0)::text AS paid
       FROM (SELECT ROUND(SUM(a.interest_amount), 2) AS amount
               FROM security_deposit_interest_accruals a
              WHERE a.security_deposit_id = $1 AND a.paid_at IS NOT NULL
              GROUP BY a.paid_credit_id, a.paid_at) t`,
    [sd.id])).rows[0]
  const unpaid = (await runner.query<{ id: string }>(
    `SELECT id FROM security_deposit_interest_accruals
      WHERE security_deposit_id = $1 AND paid_at IS NULL
      ORDER BY accrual_month, id
      ${lock ? 'FOR UPDATE' : ''}`,
    [sd.id])).rows
  const owed = toCents(round2(Number(sd.interest_accrued ?? 0))) - toCents(paid?.paid)
  return { depositId: sd.id, amount: toDollars(Math.max(0, owed)), unpaidAccrualIds: unpaid.map((r) => r.id) }
}

/**
 * The figures the landlord's confirm showed, sent back with Finalize. Each one
 * sent is checked against the live figure under finalize's locks; one not sent
 * is not checked (a caller that sends none is not checked at all).
 */
export interface MoveOutExpected {
  expectedRefund?: number
  expectedGap?: number
  /** Who refunds which part (decisions #46.3) — fix pass 3. */
  expectedRefundFromGam?: number
  expectedRefundFromLandlord?: number
  /** The tenant's paid-ahead money the deductions take (decisions #46.2) — fix pass 3. */
  expectedPaidAheadUsed?: number
}

/**
 * The plain-words refusal when the figures the landlord's confirm showed are
 * not the live ones any more (finalize checks them under its locks). The page
 * reads the new figures in place.
 */
export const FIGURES_CHANGED_MESSAGE = 'The figures changed since you opened this, so nothing was paid out. ' +
  'The page now shows the new ones — review them and finalize again.'

// How each part of a refund comes back, in words (the refund row's note and
// the tenant's move-out statement), is services/depositRefundSend
// .refundReachWords (decisions #47c, Nic): never who HOLDS the deposit — GAM
// is only the custodian — only how the tenant's money reaches them: "$X back
// to your card", "$Y returned to you at the office".

/**
 * The one place a move-out's refund and shortfall are worked out — the
 * preview, the saved draft and finalize all call it, so the landlord never
 * sees one figure and pays another.
 *
 *   Ordinary move-out — 10/4 (decisions #46.2, Nic, FINAL: "that's what a
 *     security deposit is for"): the deductions (damage, cleaning, the unpaid
 *     bills the sweep takes) come out of the DEPOSIT SIDE FIRST — the
 *     security deposit + every pet, key and cleaning deposit that settled +
 *     the deposit interest still owed (`interest`: not yet credited, plus
 *     credited but never spent). The refund is what is left of the deposit
 *     side. The rent the tenant paid ahead is theirs: it pays ONLY what the
 *     deposit side cannot cover (finalize spends it oldest credit first), and
 *     a shortfall is billed only for what is beyond both.
 *     PAID-AHEAD MONEY IS NEVER REFUNDED HERE (decisions #38 Q8, #35.3,
 *     #46.1): whatever of it the deductions do not take (`paidAheadLeft`)
 *     stays the tenant's paid-ahead credit on the lease, untouched, and waits
 *     for the landlord's choice on the landlord page
 *     /leases/:leaseId/paid-ahead-choice (services/paidAheadChoice) — never an
 *     automatic refund. `paidAheadUsed` is what finalize spends into the pool
 *     (its 'move_out' credit uses: only the part beyond the deposit).
 *     (Before 10/4 the paid-ahead money paid the deductions first and the
 *     deposit only the rest — a $500 deposit, $300 paid ahead and a $40
 *     cleaning refunded $500 and left $260 paid ahead; now it refunds $460 and
 *     leaves all $300.)
 *   Carried forward (portability, S255): only the security deposit moves to
 *     the tenant's next lease. Landlord A's deductions come out of it first
 *     (their priority claim) and only the rest is carried; nothing is
 *     refunded (Step 9 review, fix pass 1: before this the deductions were
 *     marked paid from the deposit while the WHOLE deposit was carried —
 *     landlord A was paid nothing and the same dollars followed the tenant).
 *     Deductions beyond the security deposit follow #46.2 too (Step 9 review,
 *     fix pass 2 — before this they were billed while the tenant's pet, key
 *     and cleaning deposits and paid-ahead money sat untouched on the old
 *     lease): the rest of the deposit side — the pet, key and cleaning
 *     deposits (`boxesUsed`, oldest first) — then the paid-ahead money
 *     (`paidAheadUsed`, oldest credit first), and only what is beyond all of
 *     it is a shortfall the tenant owes, charged like any other. Interest
 *     still owed travels with the deposit record; whatever of the pet, key and
 *     cleaning deposits and paid-ahead money the deductions do not take stays
 *     on the old lease (GAM is told — finalize).
 * `deposit` is the deposit money in play (what the row records as total_deposit).
 */
export function moveOutMath(o: {
  carriedForward: boolean; security: number; boxes: number; interest: number; paidAhead: number; deductions: number
}): {
  deposit: number; refund: number; gap: number; carried: number; paidAheadUsed: number; paidAheadLeft: number
  /** Carried forward only: the pet, key and cleaning deposits the deductions took (0 otherwise — they are in the refund). */
  boxesUsed: number
} {
  const ded = Math.max(0, toCents(o.deductions))
  const paidAhead = Math.max(0, toCents(o.paidAhead))
  if (o.carriedForward) {
    const security = Math.max(0, toCents(o.security))
    const taken = Math.min(ded, security)
    const fromBoxes = Math.min(ded - taken, Math.max(0, toCents(o.boxes)))
    const used = Math.min(paidAhead, ded - taken - fromBoxes)
    return {
      deposit: toDollars(security), refund: 0, gap: toDollars(ded - taken - fromBoxes - used), carried: toDollars(security - taken),
      paidAheadUsed: toDollars(used), paidAheadLeft: toDollars(paidAhead - used), boxesUsed: toDollars(fromBoxes),
    }
  }
  const depositSide = toCents(o.security) + toCents(o.boxes) + toCents(o.interest)
  const fromDeposit = Math.min(ded, Math.max(0, depositSide))
  const beyondDeposit = ded - fromDeposit
  const used = Math.min(paidAhead, beyondDeposit)
  return {
    deposit: toDollars(toCents(o.security) + toCents(o.boxes)),
    refund: toDollars(Math.max(0, depositSide - fromDeposit)),
    gap: toDollars(beyondDeposit - used),
    carried: 0,
    paidAheadUsed: toDollars(used),
    paidAheadLeft: toDollars(paidAhead - used),
    boxesUsed: 0,
  }
}

/** One deposit payment and who refunds it at move-out. */
export interface DepositPart { id: string; kind: 'box' | 'security'; amount: number; label: string }

/**
 * 10/4 (decisions #46.3, Nic, FINAL): "Deposits come from where they're
 * held." Each deposit is counted, the deductions come out of it, and WHOEVER
 * HOLDS IT refunds the rest: GAM sends only what GAM holds; the part the
 * landlord holds they hand back themselves — GAM never refunds, releases or
 * nets it. A tenant can have both.
 *
 * Who holds each part is a fact of how it was collected (settledDepositPayments
 * and the deposit record — leaseFeesSync.reconcileSettledDepositPayment sets
 * the record's holder from the collection):
 *   GAM holds: the security deposit on a record GAM holds (less any part of
 *     it the tenant paid the landlord directly), a pet, key or cleaning deposit
 *     paid through GAM where GAM may hold deposits (`gamMayHold`: the record is
 *     GAM's, or the S604 custody gate allows it), the deposit interest already
 *     credited (a GAM-funded credit), and the accrued interest not yet credited
 *     on the part of the record GAM holds. Fix pass 3: the share of that
 *     accrued interest on money the landlord holds (a part of a GAM record paid
 *     to them directly; a record they hold) is theirs to pay back with their
 *     refund — before this GAM refunded interest on money it never held.
 *   The landlord holds: everything paid to them in person or into their bank,
 *     and the security deposit on a record they hold. A deposit payment that
 *     reached GAM where GAM may not hold deposits (the custody gate) is the
 *     landlord's too — GAM releases it to them at move-out (`releasedToLandlord`,
 *     as before) and they refund it with the rest of theirs.
 *     OPEN LEGAL-CUSTODY POINT (step 9 review, fix pass 3 — reported to Nic,
 *     not decided here): until that release the money still sits on GAM's
 *     balance (the weekly payout never passes a deposit through —
 *     landlordPassthrough), so in a gate-blocked state GAM holds tenant
 *     deposit money the record calls the landlord's. The fix belongs to the
 *     charge (never land it on GAM's balance) or the Tuesday batch (pass a
 *     landlord-held deposit through), both outside this file; once one lands,
 *     `releasedToLandlord` goes away.
 *
 * WHICH PART THE DEDUCTIONS COME OUT OF FIRST when one tenant has both kinds:
 * the part the landlord already holds (the deductions are theirs, so for that
 * part no money moves at all); then the part GAM holds, which GAM releases to
 * the landlord. GAM refunds what is left of what it holds; the landlord
 * refunds what is left of theirs. This order is the one place it is decided
 * (DEDUCTIONS_FROM_LANDLORD_HELD_FIRST). PROVISIONAL: decisions.md does not
 * settle it and Nic has not ruled on it — put to him before deploy (reported).
 * Flipping the constant is the whole change (false: GAM-held money first).
 */
export const DEDUCTIONS_FROM_LANDLORD_HELD_FIRST = true

export function refundSplit(o: {
  record: { heldBy: string | null; flex: boolean } | null
  /** The security deposit in the pool (the record's collected amount, or the lease fee with no record). */
  security: number
  payments: ReadonlyArray<{ id: string; kind: 'box' | 'security'; amount: number; gamHeld: boolean; label: string }>
  gamMayHold: boolean
  /** Deposit interest in the pool (still owed + credited, never spent). */
  interest: number
  /**
   * The part of `interest` that is accrued interest not yet credited
   * (unpaidDepositInterest). It accrued on the deposit record's collected
   * amount, so it belongs to whoever holds that money (fix pass 3): on a GAM
   * record the share of it on the part the tenant paid the landlord directly
   * is the landlord's to pay back; on a record the landlord holds, all of it.
   * Interest already credited (a GAM-funded credit) stays GAM's.
   */
  interestAccrued?: number
  /** What the refund is (moveOutMath). */
  refund: number
}): {
  gamHeld: number; landlordHeld: number
  /** The part of the deductions taken from each holder's money. */
  keptFromGam: number; keptFromLandlord: number
  refundFromGam: number; refundFromLandlord: number
  /** The security deposit the landlord holds (a GAM record: the part paid to them directly). */
  landlordSecurity: number
  /** Deposit payments that came through GAM and that GAM keeps (refunds, or releases for deductions). */
  gamParts: DepositPart[]
  /** Deposit payments that came through GAM where GAM may not hold them: released to the landlord at move-out. */
  releasedToLandlord: DepositPart[]
} {
  const sum = (ps: ReadonlyArray<{ amount: number }>) => ps.reduce((s, p) => s + toCents(p.amount), 0)
  const security = toCents(o.security)
  const secPays = o.payments.filter((p) => p.kind === 'security')
  const boxes = o.payments.filter((p) => p.kind === 'box')
  const part = (p: { id: string; kind: 'box' | 'security'; amount: number; label: string }): DepositPart =>
    ({ id: p.id, kind: p.kind, amount: p.amount, label: p.label })
  let gamSecurity = 0
  let releasedSecurity: DepositPart[] = []
  // Accrued interest not yet credited that is the landlord's to pay back (fix pass 3).
  const accrued = Math.max(0, Math.min(toCents(o.interestAccrued ?? 0), toCents(o.interest)))
  let landlordInterest = 0
  if (o.record?.heldBy === 'gam_escrow' || o.record?.flex) {
    // The record counts what was collected. The landlord's part is what was
    // paid to them directly, never more than the record holds beyond what
    // GAM took for it (a payment that never raised the record is not in the
    // pool, so it is never counted). A FlexDeposit record is GAM's alone.
    const landlordPart = o.record.flex ? 0 : Math.min(sum(secPays.filter((p) => !p.gamHeld)),
      Math.max(0, security - sum(secPays.filter((p) => p.gamHeld))))
    gamSecurity = security - landlordPart
    // The interest accrued on the landlord's part of the record is theirs (it
    // accrued on money they hold), never GAM's to fund.
    if (landlordPart > 0 && security > 0) landlordInterest = Math.round(accrued * landlordPart / security)
  } else if (o.record) {
    // A record the landlord holds: any interest accrued on it is theirs.
    landlordInterest = accrued
    // The landlord holds the record. A payment toward it that reached GAM is
    // released to them at move-out — never more than the record counts.
    let left = security
    releasedSecurity = secPays.filter((p) => p.gamHeld).flatMap((p) => {
      const cents = Math.min(toCents(p.amount), left)
      left -= cents
      return cents > 0 ? [{ ...part(p), amount: toDollars(cents) }] : []
    })
  } else {
    // No record: the pool's security deposit is only the payments that
    // settled (liveDepositPool), each held by whoever collected it — as a pet
    // or key deposit is: through GAM, GAM's where it may hold deposits (else
    // released to the landlord); in person, the landlord's.
    gamSecurity = o.gamMayHold ? sum(secPays.filter((p) => p.gamHeld)) : 0
    releasedSecurity = o.gamMayHold ? [] : secPays.filter((p) => p.gamHeld).map(part)
  }
  const gamBoxes = boxes.filter((p) => p.gamHeld && o.gamMayHold)
  const releasedBoxes = boxes.filter((p) => p.gamHeld && !o.gamMayHold)
  const landlordBoxes = boxes.filter((p) => !p.gamHeld)
  const gamHeld = gamSecurity + sum(gamBoxes) + toCents(o.interest) - landlordInterest
  const landlordHeld = (security - gamSecurity) + sum(landlordBoxes) + sum(releasedBoxes) + landlordInterest
  const kept = Math.max(0, gamHeld + landlordHeld - Math.max(0, toCents(o.refund)))
  const keptFromLandlord = DEDUCTIONS_FROM_LANDLORD_HELD_FIRST
    ? Math.min(kept, landlordHeld)
    : Math.max(0, kept - gamHeld)
  const keptFromGam = kept - keptFromLandlord
  return {
    gamHeld: toDollars(gamHeld), landlordHeld: toDollars(landlordHeld),
    keptFromGam: toDollars(keptFromGam), keptFromLandlord: toDollars(keptFromLandlord),
    refundFromGam: toDollars(gamHeld - keptFromGam), refundFromLandlord: toDollars(landlordHeld - keptFromLandlord),
    landlordSecurity: toDollars(security - gamSecurity),
    gamParts: [...(gamSecurity > 0 ? secPays.filter((p) => p.gamHeld).map(part) : []), ...gamBoxes.map(part)],
    releasedToLandlord: [...releasedSecurity, ...releasedBoxes.map(part)],
  }
}

/**
 * The lease's move-out fees, read LIVE — the one source the preview, the saved
 * draft and finalize all use (deposit-page review): every lease fee due at
 * move-out or 'other' (cleaning, ending early, other move-out fees — S113),
 * except a CONDITIONAL fee ("carpet cleaning within N days, else $X" —
 * condition_text set) that nobody assessed as FAILED (S550: unassessed or met
 * is no charge, ever). A walkthrough can mark a conditional fee failed after
 * Begin Move-Out, and a move-out fee can be edited; before this the draft and
 * finalize used the figure saved at Begin (deposit_returns
 * .cleaning_fee_amount), so the confirm could show one refund while finalize
 * paid another. `lock` (finalize) locks the fee rows.
 *
 * Step 9 review (fix pass 3) — every dollar counted once: a fee the tenant was
 * ALREADY BILLED for on this tenancy is not deducted again here. An 'other'
 * fee is billable before move-out (POST /leases/:id/bill-fee — its charge
 * carries "<who>-billed: <fee type> — …" in its note and the fee's amount, but
 * no link to the fee), and the early-termination fee is quoted and charged by
 * the termination request itself (leaseTermination: a fee_payment_id), or
 * waived there. Before this the same fee was deducted from the deposit on top:
 * paid twice when the tenant had paid that charge, counted twice when it was
 * still open (the sweep takes the open charge), and deducted though the
 * landlord had waived it. A billed charge is the one place that fee lives now
 * — paid, still owed (swept like any bill), or forgiven. Which fee a charge
 * billed is worked out by otherFeesNotBilled (one charge, one fee).
 */
async function liveMoveOutFees(runner: Runner, leaseId: string, lock: boolean): Promise<number> {
  const fees = (await runner.query<{ id: string; fee_type: string; due_timing: string; amount: string }>(
    `SELECT lf.id, lf.fee_type, lf.due_timing, lf.amount::text AS amount
       FROM lease_fees lf
      WHERE lf.lease_id = $1 AND lf.due_timing IN ('move_out', 'other')
        AND (lf.condition_text IS NULL OR lf.condition_result = 'failed')
        AND NOT (lf.fee_type = 'early_termination_fee' AND EXISTS (
              SELECT 1 FROM lease_termination_requests tr
               WHERE tr.lease_id IN ${LEASE_CHAIN}
                 AND (tr.fee_payment_id IS NOT NULL OR tr.fee_waived_at IS NOT NULL
                      OR tr.status IN ('fee_paid', 'fee_waived'))))
      ORDER BY lf.id
      ${lock ? 'FOR UPDATE OF lf' : ''}`,
    [leaseId])).rows
  // The charges Bill fee made on this tenancy, by the fee type their note names.
  const billed = (await runner.query<{ id: string; amount: string; notes: string | null }>(
    `SELECT bp.id, bp.amount::text AS amount, bp.notes
       FROM payments bp
      WHERE bp.lease_id IN ${LEASE_CHAIN}
        AND bp.type = 'fee' AND bp.lease_fee_id IS NULL
        AND position('-billed: ' IN COALESCE(bp.notes, '')) > 0
      ORDER BY bp.created_at, bp.id`,
    [leaseId])).rows
  const notBilled = otherFeesNotBilled(
    fees.filter((f) => f.due_timing === 'other').map((f) => ({ id: f.id, feeType: f.fee_type, cents: toCents(f.amount) })),
    billed.flatMap((b) => {
      const m = /-billed:\s*([a-z_]+)\s*—\s/i.exec(b.notes ?? '')
      return m ? [{ feeType: m[1], cents: toCents(b.amount) }] : []
    }))
  const counted = fees.filter((f) => f.due_timing === 'move_out' || notBilled.has(f.id))
  return toDollars(counted.reduce((s, r) => s + toCents(r.amount), 0))
}

/**
 * Fix pass 1 (final fix): which 'other' lease fees were NOT already billed
 * with Bill fee — each billed charge stands for ONE fee of its type. A Bill-fee
 * charge carries the fee type in its note but no link to the fee
 * (leaseFees.createLeaseFeePayment writes none), so they are paired:
 *   1. a charge pairs with a fee of its type for the same amount;
 *   2. a charge left over pairs with the fee of its type closest in amount —
 *      a fee EDITED after it was billed is still the fee that charge billed
 *      (before this the edited fee matched nothing and was deducted again on
 *      top of the open or paid charge: counted twice);
 *   3. every fee left unpaired is deducted.
 * Two fees of the same type and amount with only one billed: one pairs, the
 * other is deducted (before this both were dropped — one never charged).
 * Returns the ids of the fees still to deduct.
 */
export function otherFeesNotBilled(
  fees: ReadonlyArray<{ id: string; feeType: string; cents: number }>,
  charges: ReadonlyArray<{ feeType: string; cents: number }>,
): Set<string> {
  const left = new Map<string, Array<{ id: string; cents: number }>>()
  for (const f of fees) left.set(f.feeType, [...(left.get(f.feeType) ?? []), { id: f.id, cents: f.cents }])
  const leftover: Array<{ feeType: string; cents: number }> = []
  for (const c of charges) {
    const pool = left.get(c.feeType)
    const i = pool ? pool.findIndex((f) => f.cents === c.cents) : -1
    if (pool && i >= 0) pool.splice(i, 1)
    else leftover.push(c)
  }
  for (const c of leftover) {
    const pool = left.get(c.feeType)
    if (!pool || pool.length === 0) continue
    let best = 0
    for (let i = 1; i < pool.length; i++) {
      if (Math.abs(pool[i].cents - c.cents) < Math.abs(pool[best].cents - c.cents)) best = i
    }
    pool.splice(best, 1)
  }
  return new Set([...left.values()].flat().map((f) => f.id))
}

/**
 * Who may hold deposits on this lease: the record already says GAM holds it,
 * or the S604 custody gate allows GAM to (leaseFeesSync.gamMayHoldDeposits).
 */
async function gamMayHoldOnLease(runner: Runner, leaseId: string, recordHeldBy: string | null | undefined): Promise<boolean> {
  if (recordHeldBy === 'gam_escrow') return true
  const { gamMayHoldDeposits } = await import('./leaseFeesSync')
  return gamMayHoldDeposits(runner, leaseId)
}

/**
 * 10/4 (decisions #46.4, Nic, FINAL): the lines a move-out closes as no longer
 * owed instead of deducting them — a refundable deposit (security, or a pet,
 * key, cleaning or utility deposit the lease tags as held) the tenant never
 * paid ("a deposit is only ever refunded"), and an unpaid up-front "last
 * month's rent" (a prepaid box: a lease fee tagged money_kind 'prepaid',
 * revenue_owner 'held'). Nothing was ever paid ahead behind such a box, and
 * the months it was meant to cover are billed as ordinary rent every month
 * (jobs/invoiceGeneration writes a rent row each month regardless of any box;
 * a box that settles only becomes paid-ahead credit — prepaid_fee_follows_payment
 * — that draws those rent rows down), so it is never owed on top of them.
 * Damage, unpaid rent, non-refundable fees and every other unpaid line still
 * go on the final bill as before (SWEEP_LINES_SQL).
 * Left out: a line whose money is on its way (finalize refuses while a deposit
 * or prepaid-box payment clears), and a FlexDeposit installment (FlexDeposit
 * keeps its own books). A prepaid box a dispute reopened is left out too: the
 * dispute took the paid-ahead credit it made back, and its reversal is settled
 * where it is.
 * A DEPOSIT line a bank return or a dispute reopened (Step 9 review, fix pass
 * 2) IS closed: the deposit money it stood for is gone (the pool no longer
 * counts it — liveDepositPool), so it is a deposit the tenant never paid, and
 * before this it stayed owed on the ended lease for good (the sweep never
 * takes a deposit). Its reversal is resolved with it when nothing is being
 * asked of the landlord for it (finalize).
 * `amount` is the part still owed in money — a line part-paid by credit
 * closes only that part. $1 = the lease.
 */
const NEVER_OWED_AT_MOVE_OUT_SQL = `
  SELECT p.id, p.type, p.status, vm.money_part::text AS amount,
         (lf.money_kind = 'prepaid') AS prepaid,
         NULLIF(btrim(lf.description), '') AS label, lf.fee_type, p.reversal_id
    FROM payments p
    JOIN v_payment_money vm ON vm.payment_id = p.id
    LEFT JOIN lease_fees lf ON lf.id = p.lease_fee_id
   WHERE p.lease_id IN ${LEASE_CHAIN}
     AND p.status IN ('pending', 'failed')
     AND NOT (p.status = 'pending' AND p.stripe_payment_intent_id IS NOT NULL)
     AND vm.money_part > 0
     AND ((p.type = 'deposit'
           AND NOT EXISTS (SELECT 1 FROM flex_deposit_installments fi WHERE fi.payment_id = p.id))
          OR (p.revenue_owner = 'held' AND lf.money_kind = 'prepaid' AND p.reversal_id IS NULL))`

/** The note a closed line carries (plain words; the tenant's and landlord's screens show it). */
export const CLOSED_DEPOSIT_NOTE = 'Closed at move-out: this deposit was never paid, and a deposit is only ever refunded — it is no longer owed'
export const CLOSED_PREPAID_NOTE = 'Closed at move-out: this last month’s rent due up front was never paid, and the months it was for are billed as ordinary rent — it is no longer owed'

/** A line a move-out closes as no longer owed, as the page lists it. */
export interface ClosedAtMoveOutLine {
  payment_id: string; kind: 'deposit' | 'prepaid'; label: string; amount: number
  /** A deposit line a bank return or a dispute reopened: its reversal record (finalize resolves it). */
  reversal_id?: string | null
}

async function neverOwedAtMoveOut(runner: Runner, leaseId: string, lock: boolean): Promise<ClosedAtMoveOutLine[]> {
  const rows = (await runner.query<{ id: string; type: string; amount: string; prepaid: boolean | null; label: string | null; fee_type: string | null; reversal_id: string | null }>(
    `${NEVER_OWED_AT_MOVE_OUT_SQL}
      ORDER BY p.due_date, p.id
      ${lock ? 'FOR UPDATE OF p' : ''}`, [leaseId])).rows
  return rows.map((r) => ({
    payment_id: r.id,
    kind: r.prepaid ? 'prepaid' : 'deposit',
    label: r.label?.trim()
      || (r.fee_type ? (LEASE_COLUMN_LABEL as Record<string, string>)[r.fee_type] : null)
      || (r.prepaid ? 'Last month’s rent due up front' : 'Security deposit'),
    amount: toDollars(toCents(r.amount)),
    ...(r.reversal_id ? { reversal_id: r.reversal_id } : {}),
  }))
}

/** One GAM notice about paid-ahead money a move-out left on the ended lease. */
export interface PaidAheadLeftNotice {
  amount: number
  title: string
  body: string
  /** Which early check-out question covers it: 'decided', or null for money no check-out asked about. */
  earlyCheckOut: 'decided' | null
  /** 10/4 (decisions #46.1): the landlord's screen where this money is decided (also in the body). */
  href: string
}

/**
 * Step 9 review (fix pass 3; decisions #38 Q8, #35.3): what GAM is told about
 * the `left` dollars of paid-ahead money a move-out did not take (it stays on
 * the ended lease as the tenant's paid-ahead credit; never refunded here).
 *
 * 10/4 (decisions #46.1, Nic, FINAL): paid-ahead money left on ANY ended lease
 * gets the landlord's choice on ONE screen (services/paidAheadChoice, the
 * landlord page /leases/:id/paid-ahead-choice, also on the owner's to-do list):
 * No refund / Refund all of it / Refund a different amount, and after No refund
 * or a partial refund the LANDLORD chooses Keep it or Leave it as their credit.
 * GAM never decides it. Each notice points at that screen.
 *
 * A long stay's early check-out banks rent paid past the day they left as
 * paid-ahead credit (bookingLeaseBilling, STAY_SHORTENED_CREDIT_NOTE) and asks
 * the landlord the refund question about it (services/earlyCheckOut):
 *   - the question is still WAITING (pending): the owner already has that
 *     to-do, so that part gets no second notice;
 *   - the question was ANSWERED (decided): the refund question is not asked
 *     again — the screen offers only Keep it / Leave it as their credit for
 *     it. Until the landlord chooses, it is still the TENANT's paid-ahead
 *     money, never called the landlord's here.
 * Any other paid-ahead money left (no check-out asked about it) gets the
 * notice that the landlord decides on the screen — the refund choices first.
 */
/** A calendar day (YYYY-MM-DD) as "Sep 30, 2026" — a day, so no time zone can move it. */
const calendarDay = (ymd: string): string =>
  new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export async function paidAheadLeftNotices(leaseId: string, left: number): Promise<PaidAheadLeftNotice[]> {
  const leftCents = Math.max(0, toCents(left))
  if (leftCents === 0) return []
  const { STAY_SHORTENED_CREDIT_NOTE } = await import('./bookingLeaseBilling')
  const { paidAheadChoicePath } = await import('./paidAheadChoice')
  const { portalUrl } = await import('../lib/portalUrls')
  const href = `${portalUrl('landlord')}${paidAheadChoicePath(leaseId)}`
  const decision = await queryOne<{ status: string; choice: string | null; left_on: string; decided_at: string | null }>(
    `SELECT status, choice, left_on::text AS left_on, decided_at::text AS decided_at
       FROM stay_checkout_decisions
      WHERE lease_id = $1 AND status IN ('pending', 'decided') AND question = 'overpaid'
      ORDER BY created_at DESC LIMIT 1`, [leaseId])
  const fromCheckOut = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount_remaining), 0)::text AS total FROM lease_prepaid_credits
      WHERE lease_id = $1 AND voided_at IS NULL AND amount_remaining > 0
        AND funded_by = 'reclassified' AND note = $2`, [leaseId, STAY_SHORTENED_CREDIT_NOTE])
  const coveredCents = decision ? Math.min(leftCents, toCents(fromCheckOut?.total ?? 0)) : 0
  const restCents = leftCents - coveredCents
  const out: PaidAheadLeftNotice[] = []
  if (coveredCents > 0 && decision?.status === 'decided') {
    const choice = decision.choice && decision.choice in EARLY_CHECKOUT_CHOICE_LABEL
      ? EARLY_CHECKOUT_CHOICE_LABEL[decision.choice as keyof typeof EARLY_CHECKOUT_CHOICE_LABEL]
      : 'their choice'
    out.push({
      amount: toDollars(coveredCents),
      title: 'Money paid ahead is still on an ended lease after the landlord chose at check-out',
      // Review fix (choice46b): the day as a plain calendar day ("Sep 30, 2026"), never a raw date string.
      body: `$${toDollars(coveredCents).toFixed(2)} of rent paid past the day the tenant left (${calendarDay(decision.left_on)}) is still on the ended lease as money paid ahead. ` +
        `The landlord already chose “${choice}” for it when the guest was checked out, so they are not asked about a refund again. ` +
        'They still choose what happens to it — Keep it, or Leave it as their credit — on the lease’s paid-ahead money screen, ' +
        `which is on their to-do list: ${href}. Until they choose, it is still the tenant’s money paid ahead; nothing has released or refunded it.`,
      earlyCheckOut: 'decided',
      href,
    })
  }
  if (restCents > 0) {
    out.push({
      amount: toDollars(restCents),
      title: 'Money paid ahead is still on an ended lease',
      body: `$${toDollars(restCents).toFixed(2)} the tenant paid ahead was more than the move-out deductions, so it is still on the lease they left as money paid ahead. ` +
        'It was not refunded with the deposit: the landlord decides — No refund, Refund all of it, or Refund a different amount, ' +
        'then for anything not refunded, Keep it or Leave it as their credit — on the lease’s paid-ahead money screen, ' +
        `which is on their to-do list: ${href}.`,
      earlyCheckOut: null,
      href,
    })
  }
  return out
}

// S180 / A1 (S182 frontend): live re-pull of the auto-sweep lines.
// The deposit_returns row stores only the dollar total
// (unpaid_balance_amount); the line array isn't snapshotted because
// payment statuses can change between draft create and finalize.
// Always read fresh from the payments table — same posture as
// applyDeductionsToDraft. Excludes move-out rows (a refund or a gap row:
// DEPOSIT with no lease fee) so a prior gap-pending row from a different
// draft can't recursively roll back into a new deposit return (SWEEP_LINES_SQL).
export async function fetchUnpaidBalanceLines(leaseId: string): Promise<UnpaidBalanceLine[]> {
  const rows = await query<{
    id: string
    type: string
    amount: string
    due_date: string
    entry_description: string
    status: 'pending' | 'failed'
  }>(
    `${SWEEP_LINES_SQL}
      ORDER BY p.due_date ASC, p.created_at ASC, p.id`,
    [leaseId],
  )
  return rows.map((r) => ({
    payment_id:        r.id,
    type:              r.type,
    amount:            Number(r.amount),
    due_date:          r.due_date,
    entry_description: r.entry_description,
    status:            r.status,
  }))
}

/**
 * Calculate the deposit-return preview without persisting. Returns
 * the suggested deductions + refund/gap split. Caller can pass
 * additional damage lines to see the running total.
 *
 * S180 / A1: also auto-pulls outstanding tenant balance items via
 * the unpaid-payments query. Rent + utility + late_fee + fee rows
 * with status pending/failed get summed into total_deductions.
 * Landlord can review/forgive at finalize time by removing the line
 * (TODO — that surface is the follow-on UI session).
 */
export async function calculateDepositReturn(
  leaseId: string,
  damageLines: DamageLine[] = [],
  otherDeductions: DamageLine[] = [],
): Promise<{
  total_deposit: number
  interest_accrued: number  // S188: statutory interest tenant is owed on top of deposit
  prepaid_credit_remaining: number  // S548: unconsumed lease_prepaid_credits (the tenant's paid-ahead money)
  prepaid_credit_used: number       // Step 9 review (fix pass 2): the part of it the deductions take (paid first)
  prepaid_credit_left: number       // ...and the part left: stays paid-ahead credit for the landlord's refund choice, never refunded here
  deposit_interest_credited: number // Step 9 review (fix pass 2): interest the annual payout credited and the tenant never spent — refunded with the deposit
  final_utility_lines: { bill_id: string; utility_type: string; amount: number; cycle: string }[]  // S548: uninvoiced final meter-read bills, settled from the deposit
  final_utility_total: number
  cleaning_fee_amount: number
  damage_lines_total: number
  other_deductions_total: number
  unpaid_balance_lines: UnpaidBalanceLine[]
  unpaid_balance_total: number
  total_deductions: number
  refund_amount: number
  gap_amount: number
  /** 10/4 (decisions #46.3): the part of the refund GAM sends (only money GAM holds)… */
  refund_from_gam: number
  /** …and the part the landlord hands back themselves (money paid to them). */
  refund_from_landlord: number
  /** 10/4 (decisions #46.4): unpaid deposits and up-front rent paid ahead that finalize closes as no longer owed (never deducted). */
  closed_at_move_out_lines: ClosedAtMoveOutLine[]
  closed_at_move_out_total: number
  lease: { tenant_id: string; landlord_id: string }
  security_deposit_id: string | null
} | null> {
  const lease = await queryOne<{
    tenant_id: string
    landlord_id: string
    unit_id: string
    timezone: string | null
  }>(
    `SELECT lt.tenant_id, l.landlord_id, l.unit_id, p.timezone
       FROM leases l
       LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary'
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1`,
    [leaseId],
  )
  if (!lease) return null

  // S548 (Nic — end-of-stay): materialize any bills the readings support
  // BEFORE sweeping, so the final meter read entered at move-out becomes a
  // utility_bills row this calculation can see. Best-effort — a generation
  // hiccup must not block the deposit preview.
  // S654: the cycle is the property's month — a UTC "today" after 5 pm Phoenix
  // on the last of the month billed next month's flat-rate charges early.
  try { await ensureBillsForUnit(lease.unit_id, todayIn(lease.timezone)) } catch { /* preview stays usable */ }

  const sd = await queryOne<{
    id: string; total_amount: string; collected_amount: string; interest_accrued: string;
    held_by: string | null; flex_deposit_enabled: boolean | null
  }>(
    `SELECT id, total_amount, collected_amount, interest_accrued, held_by, flex_deposit_enabled
       FROM security_deposits WHERE lease_id = $1 LIMIT 1`,
    [leaseId],
  )

  // S262: deposit pool is `collected_amount` (what was actually collected),
  // NOT `total_amount` (what was promised); S196: with no deposit record, the
  // lease's security_deposit fee. S653 (Nic): every box the landlord tagged
  // DEPOSIT — pet, key, cleaning deposit — is held for the renter and comes
  // back here too: only what actually settled is in the pool (liveDepositPool,
  // the same read the draft and finalize use).
  const pool = await liveDepositPool(db, leaseId, false)
  // S188: statutory interest accrued (state-hardcoded rates per S177
  // carve-out). Added to the available pool for refund — tenant gets
  // their deposit + interest minus deductions. Reduces gap_amount
  // when deductions exceed the principal.
  //
  // S241 policy lock: this field is non-zero ONLY when state law
  // mandates tenant interest. For states without statutory requirement,
  // depositInterest.ts skips accrual entirely and interest_accrued
  // stays 0 here — GAM keeps whatever yield it earned on the held
  // principal. No GAM-side ledger entry needed; the yield is implicit
  // in GAM's bank/platform-balance income.
  //
  // Step 9 review (fix pass 1): only the interest still OWED — never a month
  // the annual payout already credited (unpaidDepositInterest).
  const interestAccrued = (await unpaidDepositInterest(db, leaseId, false)).amount

  // S113-PhaseB: include BOTH move_out and other due_timings. Per Nic's
  // spec, every configured lease_fee not on a per-month or move_in path
  // should deduct from the deposit at lease end. Move_out covers
  // cleaning_fee; other covers early_termination_fee + other_fee. Damage
  // lines stay separate (landlord-entered judgment calls).
  //
  // S550: CONDITIONAL fees ("carpet cleaning within N days, else $X" —
  // condition_text set) NEVER auto-sum here unless a human assessed the
  // condition as FAILED (move-out inspection 'Lease conditions' item →
  // condition_result). Unassessed or met = no charge, ever. Read live — the
  // one source the draft and finalize use too (liveMoveOutFees).
  const cleaningFeeAmount = await liveMoveOutFees(db, leaseId, false)

  // S180 / A1: auto-sweep outstanding tenant balance items. Pulls
  // every unpaid payment row tied to this lease so the deposit
  // deduction covers them. Excludes entry_description='DEPOSIT' so a
  // prior deposit-return gap-pending row doesn't recursively roll back
  // into a new deposit return. Excludes status='processing' (in flight
  // — let it settle naturally) and 'settled'/'returned'/'paid_via_deposit'
  // (already accounted for).
  const unpaidRows = await query<{
    id: string
    type: string
    amount: string
    due_date: string
    entry_description: string
    status: 'pending' | 'failed'
  }>(
    `${SWEEP_LINES_SQL}
      ORDER BY p.due_date ASC, p.created_at ASC, p.id`,
    [leaseId],
  )
  const unpaidBalanceLines: UnpaidBalanceLine[] = unpaidRows.map((r) => ({
    payment_id:        r.id,
    type:              r.type,
    amount:            Number(r.amount),
    due_date:          r.due_date,
    entry_description: r.entry_description,
    status:            r.status,
  }))
  const unpaidBalanceTotal = round2(unpaidBalanceLines.reduce((s, l) => s + l.amount, 0))

  // S548 (Nic): final utilities never billed onto an invoice (the last
  // meter read lands at/after move-out) settle straight from the deposit —
  // that's why the monthly-stay deposit exists.
  const finalUtilityRows = await query<{
    id: string; utility_type: string; amount: string; cycle: string
  }>(
    `SELECT id, utility_type, (charge_amount + tax_amount)::text AS amount,
            to_char(billing_cycle_month, 'YYYY-MM-DD') AS cycle
       FROM utility_bills
      WHERE lease_id IN ${LEASE_CHAIN} AND payment_id IS NULL AND status IN ('unbilled', 'billed')
      ORDER BY billing_cycle_month ASC`,
    [leaseId],
  )
  const finalUtilityLines = finalUtilityRows.map((r) => ({
    bill_id: r.id, utility_type: r.utility_type, amount: Number(r.amount), cycle: r.cycle,
  }))
  const finalUtilityTotal = round2(finalUtilityLines.reduce((s, l) => s + l.amount, 0))

  const damageTotal = sumLines(damageLines)
  const otherTotal = sumLines(otherDeductions)
  const totalDeductions = round2(
    cleaningFeeAmount + damageTotal + otherTotal + unpaidBalanceTotal + finalUtilityTotal
  )

  // S188: tenant pool = principal + statutory interest. Refund draws
  // against this pool; gap fires only when deductions exceed it.
  // S548: unconsumed prepaid credit (e.g. a long-stay guest paid the month
  // then left at week 3 — the schedule sync banked the overpayment, invoices
  // netted what they could, and whatever's left is the TENANT'S money). 10/4
  // (decisions #46.2): it pays only the deductions the deposit side cannot;
  // finalize spends that part into the pool as 'move_out' credit uses. The
  // rest is NOT refunded with the deposit — it stays paid-ahead credit and
  // waits for the landlord's choice (decisions #46.1).
  // S655: through the credit ledger's view of it — never a withdrawn credit,
  // never what a dispute of its funding still claims (poolablePaidAhead).
  const portable = await queryOne<{ id: string }>(
    `SELECT id FROM security_deposits WHERE lease_id = $1 AND portability_status = 'authorized' LIMIT 1`,
    [leaseId],
  )
  // Step 9 review (fix pass 2): a carried-forward deposit's deductions beyond
  // it are paid from the paid-ahead money too (#46.2, moveOutMath).
  const prepaidCreditRemaining = await poolablePaidAheadTotal(leaseId)
  // Step 9 review (fix pass 2): interest already credited and never spent is
  // owed back with the deposit. A carried-forward deposit refunds nothing.
  const interestCredited = portable ? 0 : sumCredits(await unspentInterestCredits(db, leaseId, false))

  // S188: tenant pool = principal + statutory interest. 10/4 (decisions
  // #46.2): the deductions come out of it first; the tenant's paid-ahead money
  // pays only what it cannot, and what is left of that money is NOT refunded
  // (moveOutMath). A carried-forward deposit refunds nothing.
  const { deposit, refund, gap, paidAheadUsed, paidAheadLeft } = moveOutMath({
    carriedForward: !!portable, security: pool.security, boxes: pool.boxes,
    interest: round2(interestAccrued + interestCredited), paidAhead: prepaidCreditRemaining, deductions: totalDeductions,
  })
  // 10/4 (decisions #46.3): who refunds which part — the same split finalize
  // records (refundSplit). A carried-forward deposit refunds nothing.
  const split = refundSplit({
    record: sd ? { heldBy: sd.held_by, flex: sd.flex_deposit_enabled === true } : null,
    security: pool.security, payments: pool.payments,
    gamMayHold: await gamMayHoldOnLease(db, leaseId, sd?.held_by),
    interest: round2(interestAccrued + interestCredited), interestAccrued, refund,
  })
  // 10/4 (decisions #46.4): what finalize closes as no longer owed (any ended
  // lease, a carried-forward deposit included).
  const closedLines = await neverOwedAtMoveOut(db, leaseId, false)

  return {
    total_deposit: deposit,
    interest_accrued: interestAccrued,
    prepaid_credit_remaining: prepaidCreditRemaining,
    prepaid_credit_used: paidAheadUsed,
    prepaid_credit_left: paidAheadLeft,
    deposit_interest_credited: interestCredited,
    final_utility_lines: finalUtilityLines,
    final_utility_total: finalUtilityTotal,
    cleaning_fee_amount: cleaningFeeAmount,
    damage_lines_total: damageTotal,
    other_deductions_total: otherTotal,
    unpaid_balance_lines: unpaidBalanceLines,
    unpaid_balance_total: unpaidBalanceTotal,
    total_deductions: totalDeductions,
    refund_amount: refund,
    gap_amount: gap,
    refund_from_gam: portable ? 0 : split.refundFromGam,
    refund_from_landlord: portable ? 0 : split.refundFromLandlord,
    closed_at_move_out_lines: closedLines,
    closed_at_move_out_total: toDollars(closedLines.reduce((t, l) => t + toCents(l.amount), 0)),
    lease,
    security_deposit_id: sd?.id ?? null,
  }
}

/**
 * Create-or-fetch the draft deposit-return for a lease. Idempotent —
 * if one exists, returns it (caller PATCHes to update). If none exists,
 * creates a draft with the auto-calculated cleaning_fee deduction.
 */
export async function createOrFetchDraft(
  leaseId: string,
): Promise<DepositReturnRow> {
  const existing = await queryOne<DepositReturnRow>(
    `SELECT * FROM deposit_returns WHERE lease_id = $1`,
    [leaseId],
  )
  if (existing) return existing

  // S609 (Nic): scheduled propane comes due IN FULL on the final bill —
  // "that's the only place where acceleration would still be needed." A
  // scheduled installment is not a payments row until its month arrives, so
  // without this the sweep below cannot see propane that has already been
  // delivered and burned, and it would never be billed to anyone.
  // Idempotent, and this runs only when the draft is first created.
  {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { billRemainingPropaneAtMoveOut } = await import('./propaneFill')
      const r = await billRemainingPropaneAtMoveOut(client, leaseId)
      await client.query('COMMIT')
      if (r.billed > 0) {
        logger.info({ leaseId, ...r }, '[deposit-return] remaining propane billed at move-out')
      }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
  }

  const calc = await calculateDepositReturn(leaseId)
  if (!calc) throw new Error(`Lease ${leaseId} not found`)
  if (!calc.lease.tenant_id) throw new Error(`Lease ${leaseId} has no primary tenant`)

  const row = await queryOne<DepositReturnRow>(
    `INSERT INTO deposit_returns (
       lease_id, tenant_id, landlord_id, security_deposit_id,
       total_deposit, cleaning_fee_amount, unpaid_balance_amount,
       damage_lines, other_deductions,
       total_deductions, refund_amount, gap_amount
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       '[]'::jsonb, '[]'::jsonb,
       $8, $9, $10
     ) RETURNING *`,
    [
      leaseId,
      calc.lease.tenant_id,
      calc.lease.landlord_id,
      calc.security_deposit_id,
      calc.total_deposit,
      calc.cleaning_fee_amount,
      calc.unpaid_balance_total,
      calc.total_deductions,
      calc.refund_amount,
      calc.gap_amount,
    ],
  )
  return row!
}

/**
 * Update damage lines / other deductions / notes on a draft. Recalculates
 * totals. No-op if status is not 'draft'.
 */
export async function applyDeductionsToDraft(
  draftId: string,
  patch: { damageLines?: DamageLine[]; otherDeductions?: DamageLine[]; notes?: string },
): Promise<DepositReturnRow | null> {
  const current = await queryOne<DepositReturnRow>(
    `SELECT * FROM deposit_returns WHERE id = $1`,
    [draftId],
  )
  if (!current) return null
  if (current.status !== 'draft') {
    throw new Error(`Cannot edit deposit return in status ${current.status}`)
  }

  const damageLines = patch.damageLines ?? current.damage_lines
  const otherDeductions = patch.otherDeductions ?? current.other_deductions
  const notes = patch.notes !== undefined ? patch.notes : current.notes

  const damageTotal = sumLines(damageLines)
  const otherTotal = sumLines(otherDeductions)
  // Deposit-page review: the lease's move-out fees read live (the one source
  // the preview and finalize use) and saved back, so the confirm shows exactly
  // what finalize pays even after a walkthrough marks a conditional fee failed
  // or a move-out fee is edited.
  const cleaningFee = await liveMoveOutFees(db, current.lease_id, false)
  // Step 9 review: the deposit money read live, as finalize reads it — a pet or
  // key deposit that settled (or was sent back) since the draft was made is
  // counted as it is now.
  const pool = await liveDepositPool(db, current.lease_id, false)

  // S180 / A1: re-pull live unpaid balance on every applyDeductions
  // pass. Between drafts being created and the landlord typing damage
  // lines, new payments could fail or settle. Always read fresh so
  // total_deductions reflects current reality.
  const unpaidRows = await query<{ amount: string }>(
    `${SWEEP_LINES_SQL}`,
    [current.lease_id],
  )
  const unpaidBalanceTotal = round2(unpaidRows.reduce((s, r) => s + Number(r.amount), 0))

  // S188: re-pull live interest in case the monthly cron has run between
  // draft creation and the landlord saving deductions. Step 9 review (fix
  // pass 1): only the interest still owed (unpaidDepositInterest).
  const interestAccrued = (await unpaidDepositInterest(db, current.lease_id, false)).amount

  // S655: the same pool and deductions the preview and finalize use — the
  // final utility bills deduct, and the tenant's paid-ahead money joins the
  // pool. Before this the saved draft showed a refund smaller (or a gap larger)
  // than the one finalize then paid.
  const finalUtilities = await finalUtilityTotal(current.lease_id)
  const portable = await queryOne<{ id: string }>(
    `SELECT id FROM security_deposits WHERE lease_id = $1 AND portability_status = 'authorized' LIMIT 1`,
    [current.lease_id],
  )
  const prepaidPool = await poolablePaidAheadTotal(current.lease_id)
  const interestCredited = portable ? 0 : sumCredits(await unspentInterestCredits(db, current.lease_id, false))
  const totalDeductions = round2(cleaningFee + damageTotal + otherTotal + unpaidBalanceTotal + finalUtilities)
  const { deposit, refund, gap } = moveOutMath({
    carriedForward: !!portable, security: pool.security, boxes: pool.boxes,
    interest: round2(interestAccrued + interestCredited), paidAhead: prepaidPool, deductions: totalDeductions,
  })

  const updated = await queryOne<DepositReturnRow>(
    `UPDATE deposit_returns
        SET damage_lines = $1::jsonb,
            other_deductions = $2::jsonb,
            unpaid_balance_amount = $3,
            total_deductions = $4,
            refund_amount = $5,
            gap_amount = $6,
            notes = $7,
            total_deposit = $9,
            cleaning_fee_amount = $10,
            updated_at = NOW()
      WHERE id = $8
      RETURNING *`,
    [
      JSON.stringify(damageLines),
      JSON.stringify(otherDeductions),
      unpaidBalanceTotal,
      totalDeductions,
      refund,
      gap,
      notes,
      draftId,
      deposit,
      cleaningFee,
    ],
  )
  return updated
}

/**
 * Finalize the deposit-return. Single transaction:
 *   1. Lock + verify draft status
 *   2. Compute final status (refund / gap / zero)
 *   3. Create payments row for refund OR gap
 *   4. Emit credit-ledger events
 *   5. Update deposit_returns + status
 *
 * Auto-charge of the gap is attempted post-commit (best-effort);
 * failure marks gap_charge_failed=TRUE and surfaces an admin alert
 * but doesn't roll back the finalize.
 */
export async function finalizeDepositReturn(
  draftId: string,
  finalizedByUserId: string,
  /**
   * The refund and shortfall the landlord's confirm showed. Checked here, AFTER
   * every lock is taken (fresh figures at the moment of action): if the live
   * figures differ, nothing is written and the 409 says so in plain words
   * (FIGURES_CHANGED_MESSAGE). A caller that sends neither is not checked.
   */
  expected: MoveOutExpected = {},
  /**
   * Fix pass 1 (final fix): a team member's finalize is judged against the
   * landlord's approval limit HERE, under finalize's locks, on the refund it
   * would pay now — never on a figure read before the locks (a caller that
   * sent no figures could otherwise be paid a larger refund than the limit
   * allows). Above it the return is parked 'awaiting_approval' and nothing is
   * paid; `parked` says whether this call parked it ('now') or it already was.
   * Not passed (the owner, an admin): no limit.
   */
  opts: { approvalThreshold?: number } = {},
): Promise<DepositReturnRow & { parked?: 'now' | 'already' }> {
  const client = await getClient()
  let row: DepositReturnRow
  let chargeAttempt: { gapPaymentId: string } | null = null
  let portabilityExecuteDepositId: string | null = null
  // S655: what finalize does after its commit — cancel bank pulls a swept row
  // replaced, and pay a positive escrow settlement to the landlord.
  let cancelAfterCommit: string[] = []
  // Fix pass 2 (review): lines of OTHER leases that rode on a bank pull the
  // move-out stopped (their retry is gone with it) — GAM is told after the
  // commit, so nothing is left owed with no pull and no word.
  let stoppedElsewhere: Array<{ id: string; lease_id: string | null; amount: string; intent: string }> = []
  let escrowSettlement: number | null = null
  let paidAheadLeftOnCarryForward = 0
  // Step 9 review (fix pass 2): paid-ahead money the deductions did not take — left on the lease for the landlord's refund choice.
  let paidAheadLeftAfterMoveOut = 0
  let interestLeftOnCarryForward = 0
  let boxDepositsLeftOnCarryForward: SettledDepositPayment[] = []
  // 10/4 (decisions #47a): a refund finalize recorded — its parts GAM holds are
  // sent (and the tenant told how each part reaches them) after the commit.
  let refundToSend = false
  try {
    await client.query('BEGIN')

    const cur = await client.query<DepositReturnRow>(
      `SELECT * FROM deposit_returns WHERE id = $1 FOR UPDATE`,
      [draftId],
    )
    if (cur.rows.length === 0) throw new Error('Draft not found')
    row = cur.rows[0]
    // S548: awaiting_approval = staff-prepared return parked above the
    // landlord's threshold — the landlord's finalize releases it.
    if (!['draft', 'awaiting_approval'].includes(row.status)) throw new Error(`Already finalized: ${row.status}`)

    // S655 (§1.5): move-out finalize writes the household's money — the
    // sweep, the paid-ahead pool — so it takes the household lock like every
    // other writer (a co-tenant, the desk, a webhook wait here).
    await lockHousehold(client, row.tenant_id, row.landlord_id)

    // S655 (money plan §3, Move-out): never while a card or bank payment on
    // this tenancy still holds account credit set aside. That credit is
    // either about to be spent (the payment clears) or given back (it fails);
    // pooling or sweeping around it would count it twice or not at all.
    const held = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM credit_uses u
        WHERE u.status = 'held' AND u.lease_id IN ${LEASE_CHAIN}`,
      [row.lease_id],
    )
    if ((held.rows[0]?.n ?? 0) > 0) {
      throw new AppError(409,
        'A card or bank payment on this lease is still clearing with account credit set aside, so the deposit can’t be settled yet. ' +
        'Finalize it once that payment clears or fails — usually within a few days.')
    }

    // Step 9 review (fix pass 1): nor while a payment toward the security,
    // pet, key or cleaning deposit is still clearing. Settled afterwards, its
    // money would land with GAM (or raise the deposit record) after the
    // deposit was already returned, with nothing left to release or refund it.
    //
    // Fix pass 2: a payment that never finishes (a card whose bank asked the
    // tenant to confirm it, and the tenant never did) would block finalize for
    // good, with nothing the landlord can do. One waiting longer than any bank
    // payment takes is told to GAM by name (once per payment) — canceling it
    // gives its rows back (the payment_intent.canceled webhook) — and the
    // landlord is told that, instead of "wait a few days" again. The age is
    // the LATEST attempt's (fix pass 3): a bank retry re-confirms the same
    // intent and stamps last_retry_at. A bank payment that came back and is set
    // to be tried again is in flight too.
    //
    // Step 9 final fix (fix pass 1 — decisions #48.6): ANY payment on the
    // tenancy, not only deposits and up-front rent. A rent or utility payment
    // that settled after the move-out swept its bill from the deposit was
    // money paid twice; one that failed afterwards left a bill the move-out
    // had already closed. The landlord is told plainly what is clearing and
    // the day it should clear (tenancyPaymentsClearing), read here under the
    // household lock — fresh at the moment of action; the page reads the
    // return again in place on the 409.
    const clearing = await tenancyPaymentsClearing((t, v) => client.query(t, v), row.lease_id)
    if (clearing) {
      if (clearing.stuck.length > 0) {
        await noteStuckTenancyPayments(draftId, row.lease_id, clearing.stuck)
        throw new AppError(409, STUCK_DEPOSIT_PAYMENT_MESSAGE)
      }
      throw new AppError(409, clearing.words)
    }

    // S180 / A1: re-query live unpaid payments inside the finalize tx
    // and refresh totals. Between draft create / last applyDeductions
    // and now, the unpaid set could have shifted (a payment settled,
    // a new one failed). Always finalize against the current state.
    // FOR UPDATE locks the rows so a concurrent webhook settle can't
    // race the deposit-sweep write.
    const sweptRows = await client.query<{ id: string; amount: string; revenue_owner: string; entry_description: string }>(
      `${SWEEP_LINES_SQL}
        ORDER BY p.id
        FOR UPDATE OF p`,
      [row.lease_id],
    )
    const sweptPaymentIds = sweptRows.rows.map((r) => r.id)
    const liveUnpaidBalance = round2(
      sweptRows.rows.reduce((s, r) => s + Number(r.amount), 0)
    )
    // Step 9 review (fix pass 1): GAM's own lines the deposit pays (a returned
    // payment's or declined card's fee, a platform fee passed to tenants, a GAM
    // subscription) are GAM's money. Before this they were marked paid from the
    // deposit and the money went to the landlord — in the escrow settlement, or
    // kept in the landlord's own hands — so GAM absorbed them. They are routed
    // to GAM in the settlement below.
    const gamLinesSwept = sweptRows.rows.filter((r) => r.revenue_owner === 'gam')
    const gamLinesTotal = toDollars(gamLinesSwept.reduce((s, r) => s + toCents(r.amount), 0))

    // S548 (Nic — end-of-stay): materialize + lock any final utility bills
    // that never rode an invoice (the last meter read lands at/after
    // move-out). They settle from the deposit right here.
    // S654: through the PROPERTY's today, not UTC's (same reason as the preview).
    const leaseUnit = (await client.query<{ unit_id: string; timezone: string | null }>(
      `SELECT l.unit_id, p.timezone
         FROM leases l
         LEFT JOIN units u ON u.id = l.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
        WHERE l.id = $1`, [row.lease_id])).rows[0]
    const leaseUnitId = leaseUnit.unit_id
    // S654: one property-calendar "today" for every row this finalize writes.
    const propertyToday = todayIn(leaseUnit.timezone)
    try { await ensureBillsForUnit(leaseUnitId, propertyToday) }
    catch { /* a generation hiccup must not block finalize */ }
    const finalBillRows = await client.query<{
      id: string; utility_type: string; amount: string
      usage_amount: string | null; reading_start: string | null; reading_end: string | null
    }>(
      `SELECT id, utility_type, (charge_amount + tax_amount)::text AS amount,
              usage_amount::text, reading_start::text, reading_end::text
         FROM utility_bills
        WHERE lease_id IN ${LEASE_CHAIN} AND payment_id IS NULL AND status IN ('unbilled', 'billed')
        FOR UPDATE`,
      [row.lease_id],
    )
    const liveFinalUtilities = round2(
      finalBillRows.rows.reduce((s, r) => s + Number(r.amount), 0)
    )

    // Refresh row totals using live unpaid balance + the stored
    // landlord-controlled lines (cleaning_fee / damage_lines / other).
    // S188: also re-pull live interest_accrued in case the monthly
    // accrual cron has run since the draft was created.
    // Deposit-page review: the lease's move-out fees read live and locked —
    // the one source the preview and the draft use (a walkthrough can mark a
    // conditional fee failed after Begin Move-Out, and a fee can be edited).
    const cleaningFeeAmount = await liveMoveOutFees(client, row.lease_id, true)
    const damageTotal       = sumLines(row.damage_lines)
    const otherTotal        = sumLines(row.other_deductions)
    const liveTotalDeductions = round2(
      cleaningFeeAmount + damageTotal + otherTotal + liveUnpaidBalance + liveFinalUtilities
    )
    // Step 9 review (fix pass 1): the deposit record is locked before it is
    // read — finalize writes it (returned; or, carried forward, lowered by the
    // deductions it pays).
    const sdRec = (await client.query<{
      id: string; held_by: string | null; collected_amount: string; flex_deposit_enabled: boolean | null
    }>(
      `SELECT id, held_by, collected_amount::text AS collected_amount, flex_deposit_enabled
         FROM security_deposits WHERE lease_id = $1 LIMIT 1
          FOR UPDATE`,
      [row.lease_id],
    )).rows[0] ?? null
    // Step 9 review: the deposit money read live and locked, with who holds
    // each deposit payment (pool split by holder, below). A pet or key deposit
    // that settled — or was sent back — since the draft was made counts as it is now.
    const depositPool = await liveDepositPool(client, row.lease_id, true)
    // Step 9 review (fix pass 1): only the interest still owed — never a month
    // the annual payout already credited — with its accrual rows locked
    // (stamped paid below when the deposit is returned).
    const interest = await unpaidDepositInterest(client, row.lease_id, true)
    const liveInterestAccrued = interest.amount
    // S548: the tenant's paid-ahead money pays the move-out deductions the
    // deposit cannot (a long-stay guest paid the month and left at week 3). S655 (money plan §3,
    // Move-out): THROUGH THE CREDIT LEDGER — one 'move_out' use per credit, on
    // this deposit return — never by zeroing the balance by hand. Voided credit
    // and money a dispute still claims stay out (poolablePaidAhead). A deposit
    // carried forward to the tenant's next lease (portability) carries only the
    // deposit: paid-ahead money pays only deductions beyond the deposit side,
    // and what is left of it stays where it is (GAM is told).
    // 10/4 (decisions #46.2): only the deductions the deposit side cannot
    // cover are spent from it (moveOutMath), oldest credit first. The rest stays
    // the tenant's paid-ahead credit on the lease, untouched, and waits for the
    // landlord's choice (decisions #46.1, /leases/:id/paid-ahead-choice) — it
    // is never refunded with the deposit.
    const portabilityCheck = await client.query<{ id: string }>(
      `SELECT id FROM security_deposits
        WHERE lease_id = $1 AND portability_status = 'authorized'
        LIMIT 1`,
      [row.lease_id],
    )
    const carriedForward = portabilityCheck.rows.length > 0
    // Step 9 review (fix pass 2): a carried-forward deposit's deductions beyond
    // it are paid from the paid-ahead money too (#46.2) — only that part is spent.
    const poolCredits = await poolablePaidAhead(client, row.lease_id, true)
    const livePrepaidCredit = toDollars(poolCredits.reduce((s, c) => s + toCents(c.usable), 0))
    // Step 9 review (fix pass 2): deposit interest already credited and never
    // spent is owed back with the deposit, so all of it joins the pool. A
    // carried-forward deposit leaves it where it is (GAM is told, below).
    const interestCredits = carriedForward ? [] : await unspentInterestCredits(client, row.lease_id, true)
    const liveInterestCredited = sumCredits(interestCredits)
    const math = moveOutMath({
      carriedForward, security: depositPool.security, boxes: depositPool.boxes,
      interest: round2(liveInterestAccrued + liveInterestCredited), paidAhead: livePrepaidCredit,
      deductions: liveTotalDeductions,
    })
    const totalDeposit = math.deposit
    const liveRefund = math.refund
    const liveGap    = math.gap
    paidAheadLeftAfterMoveOut = carriedForward ? 0 : math.paidAheadLeft

    // Deposit-page review: the figures the confirm showed, checked against the
    // live ones under every lock this finalize holds — a swept payment that
    // settled or failed, a meter bill that landed or a move-out fee that changed
    // since the page opened rolls everything back with the plain-words 409, and
    // the page reads the new figures in place.
    if ((expected.expectedRefund !== undefined && toCents(expected.expectedRefund) !== toCents(liveRefund))
      || (expected.expectedGap !== undefined && toCents(expected.expectedGap) !== toCents(liveGap))
      || (expected.expectedPaidAheadUsed !== undefined && toCents(expected.expectedPaidAheadUsed) !== toCents(math.paidAheadUsed))) {
      throw new AppError(409, FIGURES_CHANGED_MESSAGE)
    }

    // Fix pass 1 (final fix): the approval limit, under the locks, on the
    // refund this finalize would pay now. Nothing has been written yet.
    if (opts.approvalThreshold !== undefined && toCents(liveRefund) > toCents(opts.approvalThreshold)) {
      const parkedNow = row.status === 'draft'
      if (parkedNow) {
        await client.query(
          `UPDATE deposit_returns SET status = 'awaiting_approval', refund_amount = $2, gap_amount = $3, updated_at = NOW() WHERE id = $1`,
          [draftId, liveRefund, liveGap])
      }
      await client.query('COMMIT')
      return { ...row, status: 'awaiting_approval', refund_amount: String(liveRefund), gap_amount: String(liveGap), parked: parkedNow ? 'now' : 'already' }
    }

    // Step 9 review: money still on a lease this one renewed (left behind by
    // the renewal hand-off, or banked there afterwards) goes with the tenancy
    // first, exactly as the renewal hand-off moves it
    // (scheduler.handOffOpenItemsToRenewal): the credit ledger only lets a
    // credit join the move-out of the lease it is on, so pooling it where it
    // sat refused the whole move-out.
    const moveOutUse = async (column: 'prepaid_credit_id' | 'tenant_credit_id', creditId: string, amountCents: number) => {
      await client.query(
        `INSERT INTO credit_uses
           (${column}, deposit_return_id, lease_id, amount, billing_month, source, status, applied_at, created_by)
         VALUES ($1, $2, $3, $4, date_trunc('month', $5::date)::date, 'move_out', 'applied', now(), $6)`,
        [creditId, draftId, row.lease_id, toDollars(amountCents).toFixed(2), propertyToday, finalizedByUserId],
      )
    }
    let toSpend = toCents(math.paidAheadUsed)
    for (const c of poolCredits) {
      if (toSpend <= 0) break
      const cents = Math.min(toCents(c.usable), toSpend)
      toSpend -= cents
      if (c.leaseId !== row.lease_id) {
        // Step 9 final fix (fix pass 1): the lease the money ARRIVED on is
        // kept (received_lease_id, set once — as paid_ahead_carry_left does):
        // the readers of where money arrived (Money received's paid-ahead
        // line, the owner statement) read COALESCE(received_lease_id,
        // lease_id), and a past month is never rewritten (§0.0).
        await client.query(
          `UPDATE lease_prepaid_credits
              SET received_lease_id = COALESCE(received_lease_id, lease_id), lease_id = $2, updated_at = NOW()
            WHERE id = $1 AND lease_id = $3`,
          [c.id, row.lease_id, c.leaseId],
        )
      }
      await moveOutUse('prepaid_credit_id', c.id, cents)
    }
    for (const c of interestCredits) {
      if (c.leaseId !== row.lease_id) {
        await client.query(
          `UPDATE tenant_credits SET lease_id = $2, updated_at = NOW() WHERE id = $1 AND lease_id = $3`,
          [c.id, row.lease_id, c.leaseId],
        )
      }
      await moveOutUse('tenant_credit_id', c.id, toCents(c.amount))
    }
    // Who holds the pooled paid-ahead money: GAM (it came through Stripe) or
    // the landlord (cash, a check, a bank deposit, rent of a shortened stay).
    // Credited deposit interest is part of the deposit side (refundSplit).
    const poolSplit = (await client.query<{ gam_held: string }>(
      `SELECT COALESCE(SUM(v.amount) FILTER (WHERE v.gam_held), 0)::text AS gam_held
         FROM v_credit_uses v
        WHERE v.deposit_return_id = $1 AND v.status = 'applied' AND v.prepaid_credit_id IS NOT NULL`,
      [draftId],
    )).rows[0]
    const gamHeldPaidAhead = round2(Number(poolSplit?.gam_held ?? 0))
    const boxPayments = depositPool.payments.filter((p) => p.kind === 'box')

    // 10/4 (decisions #46.3): who holds each deposit, and so who refunds what
    // is left of it — the same split the preview and the draft show.
    const split = refundSplit({
      record: sdRec ? { heldBy: sdRec.held_by, flex: sdRec.flex_deposit_enabled === true } : null,
      security: depositPool.security, payments: depositPool.payments,
      gamMayHold: await gamMayHoldOnLease(client, row.lease_id, sdRec?.held_by),
      interest: round2(liveInterestAccrued + liveInterestCredited), interestAccrued: liveInterestAccrued, refund: liveRefund,
    })
    // Step 9 review (fix pass 3): who refunds which part is checked against
    // the confirm too — a deposit payment that settled another way, or a
    // holder that changed, since the page opened can move the split while the
    // refund stays the same.
    const refundFromGamNow = carriedForward ? 0 : split.refundFromGam
    const refundFromLandlordNow = carriedForward ? 0 : split.refundFromLandlord
    if ((expected.expectedRefundFromGam !== undefined && toCents(expected.expectedRefundFromGam) !== toCents(refundFromGamNow))
      || (expected.expectedRefundFromLandlord !== undefined && toCents(expected.expectedRefundFromLandlord) !== toCents(refundFromLandlordNow))) {
      throw new AppError(409, FIGURES_CHANGED_MESSAGE)
    }
    // The security deposit the landlord holds on a GAM record (paid to them
    // directly) — counted out of what GAM settles on a carried-forward deposit.
    const landlordHeldSecurity = sdRec?.held_by === 'gam_escrow' ? split.landlordSecurity : 0

    // 10/4 (decisions #46.4): the unpaid deposits and up-front rent paid ahead
    // this move-out closes as no longer owed (never deducted), locked.
    const closedLines = await neverOwedAtMoveOut(client, row.lease_id, true)
    const closedIds = closedLines.map((l) => l.payment_id)

    // S655: a swept row waiting on a bank retry is paid now: the retry is
    // cleared (on every row of that pull) and its pull canceled after the
    // commit, so the bank is never asked for money the deposit already paid.
    if (sweptPaymentIds.length + closedIds.length > 0) {
      stoppedElsewhere = (await client.query<{ id: string; lease_id: string | null; amount: string; intent: string }>(
        `SELECT o.id, o.lease_id, o.amount::text AS amount, o.stripe_payment_intent_id AS intent
           FROM payments o
          WHERE o.status = 'failed' AND o.next_retry_at IS NOT NULL
            AND NOT (o.id = ANY($1::uuid[]))
            AND o.stripe_payment_intent_id IN (
                  SELECT p.stripe_payment_intent_id FROM payments p
                   WHERE p.id = ANY($1::uuid[]) AND p.status = 'failed' AND p.stripe_payment_intent_id IS NOT NULL
                     AND p.next_retry_at IS NOT NULL)
            AND (o.lease_id IS NULL OR o.lease_id NOT IN ${LEASE_CHAIN.replace('$1::uuid', '$2::uuid')})
          ORDER BY o.id`,
        [[...sweptPaymentIds, ...closedIds], row.lease_id])).rows
    }
    const superseded = sweptPaymentIds.length + closedIds.length > 0
      ? await supersedeScheduledRetry(client, [...sweptPaymentIds, ...closedIds])
      : { cancelAfterCommit: [] as string[], released: 0 }
    cancelAfterCommit = superseded.cancelAfterCommit

    if (sweptPaymentIds.length > 0) {
      await client.query(
        `UPDATE payments
            SET status = 'paid_via_deposit', next_retry_at = NULL,
                settled_at = NOW(),
                notes = LEFT(
                  COALESCE(notes || E'\\n', '') ||
                  'S180: paid via security deposit on deposit_return ' || $2,
                  2000
                )
          WHERE id = ANY($1::uuid[])`,
        [sweptPaymentIds, draftId],
      )

      // S561: if any swept row was a reopened-after-reversal rent, close its
      // reversal here too. Otherwise the receivable stays open and GAM could
      // still net/ACH-pull it from the landlord while the tenant's deposit has
      // already made the landlord whole = double-recovery. Same resolution as a
      // tenant re-payment (GAM keeps / cancels a pending clawback). (The rare
      // landlord-already-clawed-back-before-move-out case returns true =
      // re-disburse; the deposit path doesn't re-transfer, so that edge is left
      // to the over-recovery admin alert — full re-disburse-from-deposit is a
      // post-launch refinement.)
      const reversalRows = await client.query<{ reversal_id: string }>(
        `SELECT DISTINCT reversal_id FROM payments
          WHERE id = ANY($1::uuid[]) AND reversal_id IS NOT NULL`,
        [sweptPaymentIds],
      )
      if (reversalRows.rows.length > 0) {
        const { resolveReversalOnTenantPayment } = await import('./paymentReversal')
        for (const rr of reversalRows.rows) {
          await resolveReversalOnTenantPayment(client, rr.reversal_id)
        }
      }
    }

    // 10/4 (decisions #46.4): a deposit, or an up-front "last month's rent",
    // the tenant never paid is no longer owed now the lease has ended. Each is
    // closed the way GAM closes a line nobody owes any more without erasing
    // it: its unpaid part comes off (a part credit already paid stays, as the
    // line's amount) and it is marked settled with the reason in its note, so
    // the household balance and Outstanding Balances stop showing it. Money
    // already paid is never touched (only pending/failed lines with nothing on
    // its way are read). A bank retry on one was stopped above.
    if (closedLines.length > 0) {
      for (const l of closedLines) {
        const done = await client.query(
          `UPDATE payments p
              SET amount = p.amount - $2::numeric, status = 'settled', settled_at = NOW(),
                  next_retry_at = NULL, platform_held = FALSE,
                  notes = LEFT(COALESCE(p.notes || E'\\n', '') || $3, 2000)
            WHERE p.id = $1 AND p.status IN ('pending', 'failed')`,
          [l.payment_id, l.amount.toFixed(2), l.kind === 'prepaid' ? CLOSED_PREPAID_NOTE : CLOSED_DEPOSIT_NOTE],
        )
        if ((done.rowCount ?? 0) !== 1) {
          throw new AppError(409, FIGURES_CHANGED_MESSAGE)
        }
      }
      // Step 9 review (fix pass 2): a deposit line a bank return or a dispute
      // reopened is closed above; its reversal is closed with it when nothing
      // is being asked of the landlord for it — the deposit money it stood for
      // was never paid out (GAM held it, or it was the landlord's own), Stripe
      // has it back, and nobody owes or is owed it now. A recovery from the
      // landlord still under way is left exactly as it is.
      const reversalIds = [...new Set(closedLines.map((l) => l.reversal_id).filter((x): x is string => !!x))]
      if (reversalIds.length > 0) {
        await client.query(
          `UPDATE payment_reversals
              SET status = 'resolved', resolved_at = COALESCE(resolved_at, NOW()), updated_at = NOW()
            WHERE id = ANY($1::uuid[]) AND status <> 'resolved'
              AND recovery_status IN ('not_needed', 'recovered')`,
          [reversalIds],
        )
      }
    }

    // S548: settle the final utility bills from the deposit — one
    // paid_via_deposit payments row per bill (books show what was consumed
    // and why), and the bill flips 'paid' with the payment linkage.
    for (const fb of finalBillRows.rows) {
      const readNote = fb.reading_start != null && fb.reading_end != null
        ? ` (meter ${Math.trunc(Number(fb.reading_start))} → ${Math.trunc(Number(fb.reading_end))})`
        : ''
      const pay = await client.query<{ id: string }>(
        `INSERT INTO payments (
           unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description, notes, settled_at
         ) VALUES ($1, $2, $3, $4, 'utility', $5, 'paid_via_deposit', $7::date, 'UTILITY', $6, NOW())
         RETURNING id`,
        [
          leaseUnitId, row.lease_id, row.tenant_id, row.landlord_id,
          Number(fb.amount).toFixed(2),
          `S548: final ${fb.utility_type} settled from security deposit on deposit_return ${draftId}${readNote}`,
          propertyToday,
        ],
      )
      await client.query(
        `UPDATE utility_bills
            SET payment_id = $1, status = 'paid', paid_at = NOW(), updated_at = NOW()
          WHERE id = $2`,
        [pay.rows[0].id, fb.id],
      )
    }

    // Update local references so the rest of the finalize logic (refund
    // / gap branches, ledger emission) works against the live numbers.
    row = {
      ...row,
      total_deposit:         String(totalDeposit),
      unpaid_balance_amount: String(liveUnpaidBalance),
      total_deductions:      String(liveTotalDeductions),
      refund_amount:         String(liveRefund),
      gap_amount:            String(liveGap),
    }
    const refund = liveRefund
    const gap    = liveGap

    // Pull lease unit context for credit-event evidence + payments row.
    const ctx = await client.query<{ unit_id: string }>(
      `SELECT l.unit_id FROM leases l WHERE l.id = $1`,
      [row.lease_id],
    )
    const unitId = ctx.rows[0]?.unit_id

    let nextStatus: 'sent_refund' | 'sent_gap' | 'sent_zero' | 'sent_carried_forward'
    let refundPaymentId: string | null = null
    let gapPaymentId: string | null = null

    // S255: deposit portability branch. If the security_deposits row
    // has portability_status='authorized', the tenant has signed away
    // their refund to carry the deposit forward to their next GAM
    // lease. Landlord A's unpaid-balance sweep already ran above
    // (priority claim); only what is left of the deposit transfers to the
    // target lease (moveOutMath) instead of being paid out.
    const portabilityAuthorized = carriedForward
    if (portabilityAuthorized) {
      portabilityExecuteDepositId = portabilityCheck.rows[0].id
    }

    // The move-out balance the tenant owes (deductions beyond the deposit):
    // the landlord's, charged to the tenant's saved method after the commit.
    const writeGapRow = async (amount: number, note: string): Promise<string> => {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description, due_date, notes
         ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'DEPOSIT', $7::date, $6)
         RETURNING id`,
        [row.landlord_id, row.tenant_id, row.lease_id, unitId, amount, note, propertyToday],
      )
      return ins.rows[0].id
    }

    // What the deposit kept for landlord A when it is carried forward.
    let takenForDeductions = 0
    if (portabilityAuthorized) {
      nextStatus = 'sent_carried_forward'
      // Step 9 review (fix pass 1): landlord A's deductions — the swept bills
      // and final utilities just marked paid from this deposit, the cleaning
      // and damage lines — come out of the deposit first; only the rest is
      // carried. Before this the bills were marked paid while the WHOLE
      // deposit was carried: landlord A received nothing for them, and the
      // same dollars followed the tenant to their next lease. The record is
      // lowered here, in this transaction, so executeDepositPortability (after
      // the commit) carries only what is left; a deductions total beyond the
      // deposit is a move-out balance the tenant owes, charged like any other.
      takenForDeductions = round2(math.deposit - math.carried)
      if (sdRec && takenForDeductions > 0) {
        await client.query(
          `UPDATE security_deposits
              SET collected_amount = collected_amount - $2::numeric,
                  status = CASE WHEN collected_amount - $2::numeric <= 0 THEN 'pending'
                                WHEN collected_amount - $2::numeric < total_amount THEN 'partial'
                                ELSE status END,
                  notes = LEFT(COALESCE(notes || E'\\n', '') || $3, 2000),
                  updated_at = NOW()
            WHERE id = $1`,
          [sdRec.id, takenForDeductions.toFixed(2),
           `Move-out ${draftId}: $${takenForDeductions.toFixed(2)} kept for the landlord's move-out deductions; the rest was carried forward`],
        )
      }
      if (gap > 0) {
        gapPaymentId = await writeGapRow(gap,
          `Move-out balance owed for lease ${row.lease_id} — the deductions were more than the deposit carried forward`)
        chargeAttempt = { gapPaymentId }
      }
    } else if (refund > 0 && gap === 0) {
      nextStatus = 'sent_refund'
      // 10/4 (decisions #47a, Nic, FINAL): the part GAM holds is SENT
      // AUTOMATICALLY, back the way the deposit was paid — one refund part per
      // deposit payment GAM took, most recent first (the early check-out's
      // refund parts, services/depositRefundSend); what no card or bank
      // payment can take is a part to give back in cash at the office, on the
      // owner's to-do list from the start. The parts are written here, under
      // finalize's locks; the card and bank parts go out after the commit.
      const { planDepositRefundParts, refundReachWords } = await import('./depositRefundSend')
      const reach = await planDepositRefundParts(client, {
        draftId, landlordId: row.landlord_id, refundFromGam: split.refundFromGam, gamPayments: split.gamParts,
      })
      refundToSend = true
      // Refund payment row — the tenant is owed this back. 'pending' while any
      // part GAM sends still has to go out, 'settled' once every one has
      // (depositRefundSend.syncDepositRefundRow). Recorded against the lease
      // for audit; entry_description='DEPOSIT' so it appears on the tenant's
      // payments tab as a credit. Its note says how each part reaches the
      // tenant (decisions #47c) — never who holds it.
      const ins = await client.query<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description, due_date, notes
         ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'DEPOSIT', $7::date, $6)
         RETURNING id`,
        [
          row.landlord_id,
          row.tenant_id,
          row.lease_id,
          unitId,
          -refund, // negative = landlord owes tenant
          `Deposit refund for lease ${row.lease_id} — ${(row.damage_lines as any[]).length} damage line(s) + cleaning fee deducted. ` +
            refundReachWords({ card: reach.card, bank: reach.bank, office: round2(reach.office + split.refundFromLandlord) }),
          propertyToday,
        ],
      )
      refundPaymentId = ins.rows[0].id
    } else if (gap > 0) {
      nextStatus = 'sent_gap'
      // Gap payment row — tenant OWES this. We try to auto-charge
      // post-commit; for now record as pending.
      gapPaymentId = await writeGapRow(gap, `Move-out balance owed for lease ${row.lease_id} — deposit was insufficient`)
      chargeAttempt = { gapPaymentId }
    } else {
      nextStatus = 'sent_zero'
    }

    // THE POOL IS SPLIT BY WHO HOLDS EACH PART — 10/4 (decisions #46.3, Nic,
    // FINAL: "Deposits come from where they're held"; replaces the S655 rule
    // that GAM paid the whole refund from escrow and netted the landlord for
    // money they held). Who holds a dollar is a fact of how it was collected
    // (refundSplit). Each deposit is counted, the deductions come out of it,
    // and whoever holds it refunds the rest:
    //   - GAM sends ONLY what GAM holds (split.refundFromGam). The landlord
    //     hands back what they hold themselves (split.refundFromLandlord):
    //     GAM never refunds, releases or nets money the landlord holds.
    //   - What the deductions took from money GAM holds is the landlord's:
    //     paid to them (split.keptFromGam), together with the paid-ahead money
    //     GAM held that paid deductions the deposit could not (one
    //     'prepaid_draw' held item per credit use), less GAM's own lines the
    //     deposit paid (they are GAM's).
    //       GAM escrow record: one signed figure — positive goes out as the
    //         existing transfer after the commit; negative (GAM's own lines
    //         were paid from money the landlord holds) is a negative
    //         'deposit_settlement' item netted from their next payout. Never
    //         clamped to 0.
    //       Landlord-held record: held items on the next Tuesday payout —
    //         'prepaid_draw' per GAM-held paid-ahead use, 'deposit_settlement'
    //         (source kept:<move-out>) for the deposit GAM held that the
    //         deductions kept, and a negative 'deposit_settlement' (source
    //         gam_lines:<move-out>) for GAM's own lines paid from money the
    //         landlord holds.
    //   - A deposit payment that reached GAM where GAM may not hold deposits
    //     (the S604 custody gate) is the landlord's (they refund it): GAM
    //     releases it to them now, unconditionally, one 'deposit_settlement'
    //     item per payment, as before.
    //   Carried forward: only landlord A's deductions are settled — the rest of
    //     the deposit moves to the next lease. GAM escrow: landlord A's
    //     settlement is the part taken for deductions − GAM's own lines − the
    //     part of the record the landlord already holds, SIGNED as above.
    // The space by name for the payout line (never an id).
    const space = (await client.query<{ unit_number: string | null }>(
      `SELECT u.unit_number FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`,
      [row.lease_id],
    )).rows[0]?.unit_number ?? 'the space'
    const release = async (sourceType: 'prepaid_draw' | 'deposit_settlement', sourceId: string, amount: number, description: string): Promise<boolean> => {
      if (amount === 0) return false
      await client.query(
        `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_type, source_id) DO NOTHING`,
        [row.landlord_id, sourceType, sourceId, amount.toFixed(2), description],
      )
      return true
    }
    // GAM's own lines by name, for the landlord's payout line.
    const gamLineNames = [...new Set(gamLinesSwept.map((r) =>
      (PAYMENT_ENTRY_DESCRIPTION_LABELS as Record<string, string | undefined>)[r.entry_description]?.toLowerCase() ?? 'GAM fee'))]
    const gamLinesText = `GAM's own charges on the tenant's bill (${gamLineNames.join(', ')})`
    // A signed escrow settlement: positive goes out as the transfer after the
    // commit; negative is netted from the landlord's next payout.
    const settleEscrow = async (settlementCents: number, why: string): Promise<number | null> => {
      if (settlementCents > 0) return toDollars(settlementCents)
      if (settlementCents < 0) {
        await release('deposit_settlement', draftId, toDollars(settlementCents),
          `Move-out at ${space}: ${why} — so $${toDollars(-settlementCents).toFixed(2)} comes out of this payout.`)
      }
      return null
    }
    const releasedPayments: string[] = []

    if (!portabilityAuthorized) {
      // Deposit payments GAM may not hold (custody gate): the landlord's, released now.
      for (const p of split.releasedToLandlord) {
        if (await release('deposit_settlement', p.id, p.amount,
          `Move-out at ${space}: ${p.kind === 'security' ? 'security deposit' : p.label} the tenant paid through GAM, released to you`)) releasedPayments.push(p.id)
      }
      if (sdRec?.held_by === 'gam_escrow') {
        escrowSettlement = await settleEscrow(
          toCents(split.keptFromGam) + toCents(gamHeldPaidAhead) - toCents(gamLinesTotal),
          `${gamLinesText}, $${gamLinesTotal.toFixed(2)}, were paid from deposit money paid to you directly, and they are GAM's`)
      } else {
        const uses = await client.query<{ id: string; amount: string }>(
          `SELECT v.id, v.amount::text AS amount FROM v_credit_uses v
            WHERE v.deposit_return_id = $1 AND v.status = 'applied' AND v.gam_held AND v.prepaid_credit_id IS NOT NULL
            ORDER BY v.id`,
          [draftId],
        )
        for (const u of uses.rows) {
          await release('prepaid_draw', u.id, Number(u.amount),
            `Move-out at ${space}: money the tenant paid ahead through GAM, used for the move-out deductions — released to you`)
        }
        // The deposit GAM held that the deductions kept is the landlord's; GAM
        // keeps its own lines out of it first.
        const keptCents = toCents(split.keptFromGam)
        const forGamCents = Math.min(keptCents, toCents(gamLinesTotal))
        await release('deposit_settlement', `kept:${draftId}`, toDollars(keptCents - forGamCents),
          `Move-out at ${space}: deposit money paid online, kept for the move-out deductions — released to you`)
        const owedCents = toCents(gamLinesTotal) - forGamCents
        if (owedCents > 0) {
          await release('deposit_settlement', `gam_lines:${draftId}`, -toDollars(owedCents),
            `Move-out at ${space}: ${gamLinesText}, $${toDollars(owedCents).toFixed(2)}, was paid from deposit money paid to you directly — it is GAM's, so it comes out of this payout`)
        }
      }
    } else {
      // Step 9 review (fix pass 1): landlord A is settled for the deductions the
      // carried deposit paid (above), and GAM keeps its own lines. Fix pass 2
      // (#46.2): deductions beyond the security deposit came out of the pet,
      // key and cleaning deposits (oldest first), then the paid-ahead money —
      // the parts of those GAM holds are paid to landlord A as well; the parts
      // the landlord holds are theirs already, so nothing moves for them.
      let boxLeft = toCents(math.boxesUsed)
      let boxGamUsedCents = 0
      const boxesLeft: SettledDepositPayment[] = []
      const boxesWhollyReleased: string[] = []
      for (const p of boxPayments) {
        const cents = Math.min(toCents(p.amount), boxLeft)
        boxLeft -= cents
        if (p.gamHeld) {
          boxGamUsedCents += cents
          if (cents > 0 && cents === toCents(p.amount)) boxesWhollyReleased.push(p.id)
        }
        if (toCents(p.amount) - cents > 0) boxesLeft.push({ ...p, amount: toDollars(toCents(p.amount) - cents) })
      }
      releasedPayments.push(...boxesWhollyReleased)
      if (sdRec?.held_by === 'gam_escrow') {
        escrowSettlement = await settleEscrow(toCents(takenForDeductions) - toCents(gamLinesTotal) - toCents(landlordHeldSecurity)
          + boxGamUsedCents + toCents(gamHeldPaidAhead),
          `${gamLinesText} and the part of the deposit paid to you directly came to more than the deductions the carried deposit paid for you`)
      } else {
        const uses = await client.query<{ id: string; amount: string }>(
          `SELECT v.id, v.amount::text AS amount FROM v_credit_uses v
            WHERE v.deposit_return_id = $1 AND v.status = 'applied' AND v.gam_held AND v.prepaid_credit_id IS NOT NULL
            ORDER BY v.id`,
          [draftId],
        )
        for (const u of uses.rows) {
          await release('prepaid_draw', u.id, Number(u.amount),
            `Move-out at ${space}: money the tenant paid ahead through GAM, used for the move-out deductions — released to you`)
        }
        const forGamCents = Math.min(boxGamUsedCents, toCents(gamLinesTotal))
        await release('deposit_settlement', `kept:${draftId}`, toDollars(boxGamUsedCents - forGamCents),
          `Move-out at ${space}: pet, key or cleaning deposit money paid online, used for the move-out deductions — released to you`)
        const owedCents = toCents(gamLinesTotal) - forGamCents
        if (owedCents > 0) {
          await release('deposit_settlement', `gam_lines:${draftId}`, -toDollars(owedCents),
            `Move-out at ${space}: ${gamLinesText}, $${toDollars(owedCents).toFixed(2)}, was paid from deposit money paid to you directly — it is GAM's, so it comes out of this payout`)
        }
      }
      const left = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_remaining), 0)::text AS total FROM lease_prepaid_credits
          WHERE lease_id IN ${LEASE_CHAIN} AND voided_at IS NULL AND amount_remaining > 0
            AND left_by_choice_id IS NULL`,
        [row.lease_id],
      )
      paidAheadLeftOnCarryForward = round2(Number(left.rows[0]?.total ?? 0))
      // Step 9 review (fix pass 2): deposit interest already credited and never
      // spent stays on the ended lease too (only the record moves).
      interestLeftOnCarryForward = sumCredits(await unspentInterestCredits(client, row.lease_id, false))
      // Pet, key and cleaning deposits are not part of the carried deposit
      // either: what the deductions did not take of them stays where it is.
      boxDepositsLeftOnCarryForward = boxesLeft
    }
    // Step 9 review (fix pass 3): every GAM-held deposit payment this
    // move-out used up is no longer a deposit GAM holds in trust either: the
    // part the deductions kept now rides the escrow transfer or the kept:
    // held item, and the rest is the refund GAM owes the tenant (recorded on
    // this return as refund_from_gam, its refund row pending). Before this the
    // payment kept counting as a deposit GAM holds in GAM's balance book
    // (stripeCosts.loadPlatformBalanceBook, platform_held) on top of the held
    // item — the same dollars twice, and for good after the payout went.
    if (!portabilityAuthorized) releasedPayments.push(...split.gamParts.map((p) => p.id))
    // Step 9 review (fix pass 1): a deposit payment GAM releases here is no
    // longer held in trust — its money now rides the held item — so it stops
    // reading as a deposit GAM holds (platform_held, the flag GAM's balance
    // book counts); otherwise the same dollars were counted twice.
    // Fix pass 3: each is stamped with this return, so who collected it still
    // reads 'gam' afterwards (leaseFeesSync.depositCollectedBySql reads the
    // stamp on the payment itself — a pet deposit GAM held on a lease whose
    // security deposit the landlord holds included).
    if (releasedPayments.length > 0) {
      await client.query(
        `UPDATE payments SET platform_held = FALSE, released_by_deposit_return_id = $2
          WHERE id = ANY($1::uuid[]) AND type = 'deposit' AND platform_held`,
        [releasedPayments, draftId],
      )
    }

    // Step 9 review (fix pass 1): a returned deposit is returned. The interest
    // this move-out paid is stamped paid (never credited again by the annual
    // payout), and the record is marked disbursed: interest stops accruing on
    // it, the annual payout and GAM's deposit-trust liability stop counting
    // it. Before this the record stayed 'funded' after move-out — interest kept
    // accruing on money already handed back and the payout credited it to the
    // ended lease. A carried-forward record moves to the next lease instead
    // (executeDepositPortability) and keeps its unpaid interest.
    if (!portabilityAuthorized && sdRec) {
      if (interest.unpaidAccrualIds.length > 0) {
        await client.query(
          `UPDATE security_deposit_interest_accruals SET paid_at = NOW()
            WHERE id = ANY($1::uuid[]) AND paid_at IS NULL`,
          [interest.unpaidAccrualIds],
        )
      }
      await client.query(
        `UPDATE security_deposits
            SET status = 'disbursed', disbursed_at = COALESCE(disbursed_at, NOW()), updated_at = NOW()
          WHERE id = $1`,
        [sdRec.id],
      )
    }

    // S193: deposit_returned_* events use principal-only thresholds.
    // The "full" case is principal fully refunded (refund >= totalDeposit);
    // any interest paid out on top is recorded separately via
    // deposit_interest_paid below. Pre-S193 the threshold accidentally
    // included interest because tenantPool = principal + interest was
    // the comparator.
    //
    // S255: skip the deposit_returned_* + tenancy_ended_with_balance
    // emits entirely on the carry-forward path. The deposit wasn't
    // "returned" to the tenant — it's continuing as the tenant's
    // collateral at the next lease. (Future: a distinct event type
    // like deposit_carried_forward could record this transition for
    // credit-ledger continuity. Out of scope this session.) Step 9 review
    // (fix pass 1): a carried-forward move-out whose deductions were more than
    // the deposit DID end with a balance owed to landlord A — the same fact
    // the ordinary branch records — so tenancy_ended_with_balance is recorded
    // for it too (the deposit itself was not returned, so no deposit_returned_*).
    const principalRefunded = round2(Math.min(refund, totalDeposit))
    if (portabilityAuthorized) {
      // Skip return/balance emits.
    } else if (principalRefunded > 0 && principalRefunded === totalDeposit) {
      await emitDepositEvent(client, row, 'deposit_returned_full', liveInterestAccrued)
    } else if (principalRefunded > 0 && principalRefunded < totalDeposit) {
      await emitDepositEvent(client, row, 'deposit_returned_partial', liveInterestAccrued)
    } else if (principalRefunded === 0 && gap === 0) {
      await emitDepositEvent(client, row, 'deposit_returned_zero', liveInterestAccrued)
    }
    if (gap > 0) {
      // Gap fires both deposit_returned_zero AND tenancy_ended_with_balance:
      // the deposit was wiped (zero refunded) AND there's outstanding balance.
      if (!portabilityAuthorized) await emitDepositEvent(client, row, 'deposit_returned_zero', liveInterestAccrued)
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: row.tenant_id,
          eventType: 'tenancy_ended_with_balance',
          eventData: {
            lease_id: row.lease_id,
            expected_total: Number(row.total_deductions),
            received_total: totalDeposit,
            delta: gap,
            settlement_status: 'unpaid',
            source: 'deposit_return',
          },
          occurredAt: new Date(),
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: { deposit_return_id: row.id, lease_id: row.lease_id },
          dimensionTags: ['payment_reliability', 'tenancy_stability'],
          networkVisibility: 'visible_to_gam_network',
        },
        client,
      )
    }

    // S193: distinct credit-ledger event for statutory deposit interest
    // settlement at lease end. Fires whenever interest_accrued > 0 so the
    // audit trail captures what happened to the interest portion (paid
    // out vs absorbed by deductions). Separate from deposit_returned_*
    // so reports can distinguish principal-refund flows from
    // statutory-interest-payout flows. Step 9 review (fix pass 1): only
    // interest this move-out actually paid (what was still owed); a
    // carried-forward deposit pays none — its interest travels with it.
    if (liveInterestAccrued > 0 && !portabilityAuthorized) {
      // interest_paid_to_tenant: how much of the interest the tenant
      // actually received as part of the refund. Refund pool draws from
      // tenant_pool = principal + interest in any order; for accounting
      // clarity, treat interest as paid first up to refund amount.
      const interestPaidToTenant = round2(Math.min(liveInterestAccrued, refund))
      const interestAppliedToDeductions = round2(liveInterestAccrued - interestPaidToTenant)

      // Pull rate context from the most recent accrual row so the event
      // records what rate was in effect at lease end.
      const lastAccrual = await client.query<{
        annual_rate_pct: string
        state_code:      string
        accrual_count:   string
      }>(
        `SELECT annual_rate_pct::text, state_code,
                (SELECT COUNT(*)::text FROM security_deposit_interest_accruals
                  WHERE security_deposit_id = (
                    SELECT id FROM security_deposits WHERE lease_id = $1 LIMIT 1
                  )) AS accrual_count
           FROM security_deposit_interest_accruals
          WHERE security_deposit_id = (
            SELECT id FROM security_deposits WHERE lease_id = $1 LIMIT 1
          )
          ORDER BY accrual_month DESC
          LIMIT 1`,
        [row.lease_id],
      )
      const rateCtx = lastAccrual.rows[0]

      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: row.tenant_id,
          eventType: 'deposit_interest_paid',
          eventData: {
            lease_id:                       row.lease_id,
            deposit_return_id:              row.id,
            interest_accrued_total:         liveInterestAccrued,
            interest_paid_to_tenant:        interestPaidToTenant,
            interest_applied_to_deductions: interestAppliedToDeductions,
            principal_amount:               totalDeposit,
            rate_pct_at_lease_end:          rateCtx ? parseFloat(rateCtx.annual_rate_pct) : null,
            state_code:                     rateCtx?.state_code ?? null,
            accrual_months_count:           rateCtx ? parseInt(rateCtx.accrual_count, 10) : 0,
          },
          occurredAt: new Date(),
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: {
            deposit_return_id: row.id,
            lease_id:          row.lease_id,
            source:            'deposit_return_finalize',
          },
          dimensionTags: ['property_care', 'tenancy_stability'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    }

    const finalized = await client.query<DepositReturnRow>(
      `UPDATE deposit_returns
          SET status = $1,
              refund_payment_id = $2,
              gap_payment_id = $3,
              unpaid_balance_amount = $4,
              total_deductions = $5,
              refund_amount = $6,
              gap_amount = $7,
              total_deposit = $10,
              cleaning_fee_amount = $11,
              refund_from_gam = $12,
              refund_from_landlord = $13,
              closed_at_move_out_lines = $14::jsonb,
              finalized_at = NOW(),
              finalized_by_user_id = $8,
              updated_at = NOW()
        WHERE id = $9
        RETURNING *`,
      [
        nextStatus,
        refundPaymentId,
        gapPaymentId,
        liveUnpaidBalance,
        liveTotalDeductions,
        liveRefund,
        liveGap,
        finalizedByUserId,
        draftId,
        totalDeposit,
        cleaningFeeAmount,
        portabilityAuthorized ? 0 : split.refundFromGam,
        portabilityAuthorized ? 0 : split.refundFromLandlord,
        // Fix pass 3: the lines this move-out closed as no longer owed, kept
        // with the return so the finished record still says so (the closed
        // rows themselves read $0 once their unpaid part is off).
        JSON.stringify(closedLines.map((l) => ({ payment_id: l.payment_id, kind: l.kind, label: l.label, amount: l.amount }))),
      ],
    )
    row = finalized.rows[0]

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // S655: a bank pull a swept row replaced is canceled now that the deposit
  // has paid it. Never throws.
  await cancelSupersededIntents(cancelAfterCommit)
  if (stoppedElsewhere.length > 0) {
    // Fix pass 2 (review): that pull also carried another lease's lines;
    // they stay owed with no pull coming. GAM is told by name, once.
    try {
      const { createAdminNotification } = await import('./adminNotifications')
      const total = stoppedElsewhere.reduce((t, r) => t + toCents(r.amount), 0)
      await createAdminNotification({
        severity: 'warn',
        category: 'move_out_stopped_shared_retry',
        title: 'A move-out stopped a bank retry that also paid another lease',
        body: `Deposit return ${draftId} (lease ${row.lease_id}) paid its lines from the deposit and stopped the bank retry ` +
          `${[...new Set(stoppedElsewhere.map(r => r.intent))].join(', ')}. That pull also carried ${stoppedElsewhere.length} line(s) of another lease ` +
          `($${(total / 100).toFixed(2)}: ${stoppedElsewhere.map(r => r.id).join(', ')}), which are still owed and will not be pulled again. ` +
          'Make sure the tenant knows to pay them (or set up a new payment).',
        context: { deposit_return_id: draftId, lease_id: row.lease_id, payment_ids: stoppedElsewhere.map(r => r.id),
                   stripe_payment_intent_ids: [...new Set(stoppedElsewhere.map(r => r.intent))] },
      })
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][stopped-shared-retry-alert]')
    }
  }

  // 10/4 (decisions #47a): the part of the refund GAM holds goes back now —
  // each card or bank part through the early check-out's runner (a failure
  // is said in plain words, on the owner's to-do list, and told to GAM) —
  // and the tenant is told how each part reaches them (#47c). Never throws.
  if (refundToSend) {
    const { sendDepositRefund, tellTenantDepositRefund } = await import('./depositRefundSend')
    await sendDepositRefund(row.id)
    await tellTenantDepositRefund(row.id)
  }

  // Post-commit gap auto-charge (best-effort).
  if (chargeAttempt) {
    try {
      await attemptGapAutoCharge(draftId, chargeAttempt)
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][gap-charge]')
    }
  }

  // Step 9 review (fix pass 2; decisions #38 Q8, #35.3): paid-ahead money the
  // deductions did not take stays on the ended lease as the tenant's paid-ahead
  // credit, for the landlord's refund choice — never refunded automatically.
  // GAM is told, so it is never forgotten (paidAheadLeftNotices). Fix pass 3:
  // the part a long stay's early check-out already asks about (or answered) is
  // told apart from the rest.
  if (paidAheadLeftAfterMoveOut > 0) {
    try {
      const notices = await paidAheadLeftNotices(row.lease_id, paidAheadLeftAfterMoveOut)
      if (notices.length > 0) {
        const { createAdminNotification } = await import('./adminNotifications')
        for (const n of notices) {
          await createAdminNotification({
            severity: 'warn',
            category: 'deposit_return_paid_ahead_left',
            title: `${n.title} (deposit return ${draftId})`,
            body: n.body,
            context: { deposit_return_id: draftId, lease_id: row.lease_id, amount: n.amount, early_checkout: n.earlyCheckOut },
          })
        }
      }
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][paid-ahead-left-alert]')
    }
  }

  // S655: a carried-forward deposit carries only the security deposit. The
  // tenant's paid-ahead money, and any pet, key or cleaning deposit, stay on the
  // ended lease (still theirs, and out of nobody's pocket); GAM is told so
  // someone decides where they go.
  if (paidAheadLeftOnCarryForward > 0 || interestLeftOnCarryForward > 0 || boxDepositsLeftOnCarryForward.length > 0) {
    try {
      const lines: string[] = []
      if (paidAheadLeftOnCarryForward > 0) {
        lines.push(`$${paidAheadLeftOnCarryForward.toFixed(2)} of money they paid ahead`)
      }
      if (interestLeftOnCarryForward > 0) {
        lines.push(`$${interestLeftOnCarryForward.toFixed(2)} of deposit interest credited to them and never spent (GAM holds it)`)
      }
      for (const p of boxDepositsLeftOnCarryForward) {
        lines.push(`a $${p.amount.toFixed(2)} ${p.label.toLowerCase()} (${p.gamHeld ? 'GAM holds it' : 'paid to the landlord'})`)
      }
      const boxTotal = toDollars(boxDepositsLeftOnCarryForward.reduce((s, p) => s + toCents(p.amount), 0))
      const { createAdminNotification } = await import('./adminNotifications')
      await createAdminNotification({
        severity: 'warn',
        category: 'deposit_carry_forward_paid_ahead_left',
        title: `Tenant money left on a carried-forward lease (deposit return ${draftId})`,
        body: `The tenant carried their security deposit forward to their next lease. Still on the lease they left, not refunded or moved: ${lines.join('; ')}. Decide with the landlord where it goes.`,
        context: {
          deposit_return_id: draftId, lease_id: row.lease_id,
          amount: paidAheadLeftOnCarryForward,
          interest_credited: interestLeftOnCarryForward,
          deposits: boxDepositsLeftOnCarryForward.map((p) => ({ payment_id: p.id, amount: p.amount, gam_held: p.gamHeld })),
          deposits_amount: boxTotal,
        },
      })
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][carry-forward-paid-ahead-alert]')
    }
  }

  // S255: post-commit portability execution. The deposit-return
  // transaction above flipped status='sent_carried_forward'; this
  // is where the security_deposits row actually re-points to the
  // new lease + (when held_by='landlord') flags admin for the
  // physical funds transfer. Outside the tx because
  // executeDepositPortability runs its own row-lock.
  if (portabilityExecuteDepositId) {
    try {
      const { executeDepositPortability } = await import('./depositPortability')
      await executeDepositPortability({ depositId: portabilityExecuteDepositId })
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][portability-execute]')
      // Don't throw — the deposit_returns row is already finalized
      // with sent_carried_forward; the portability execution can be
      // retried by an admin tool. Logging is enough for ops surfacing.
    }
  }

  // S262: post-commit landlord disbursement Transfer. Under S260
  // FlexDeposit deposits live in gam_escrow throughout the lease
  // (held_by='gam_escrow'); the landlord never received any deposit
  // funds at move-in. Lease-end finalize is when the landlord's share
  // moves from GAM platform balance to their Connect account.
  // Skipped when held_by='landlord' (legacy / non-FlexDeposit deposits
  // — landlord already has the money). Step 9 review (fix pass 1): a
  // carried-forward GAM-escrow deposit pays landlord A the part its
  // deductions took (finalize sets escrowSettlement for it too).
  if (escrowSettlement != null && escrowSettlement > 0) {
    try {
      await fireLandlordDisbursementTransfer(row, escrowSettlement)
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][landlord-disbursement]')
    }
  }

  return row
}

/**
 * S262: fire the Connect Transfer for the landlord's deposit-return
 * share. Idempotency-keyed per deposit_return id. Admin-notified when the
 * landlord lacks a Connect account.
 *
 * S655 (money plan §3, Move-out): the amount is the landlord's escrow
 * settlement finalize computed — escrow + interest + paid-ahead money GAM
 * held − the refund — and is only ever called with a positive figure (a
 * negative settlement is a held item netted from the next payout, written
 * inside finalize). Landlord-held deposits never reach here.
 */
async function fireLandlordDisbursementTransfer(row: DepositReturnRow, settlement: number): Promise<void> {
  // Step 9 review (fix pass 1): the landlord this move-out settles — read off
  // the move-out itself, never through the deposit record. A carried-forward
  // record is re-pointed to the tenant's NEXT lease (often another landlord's)
  // right after the commit, so reading through it paid nobody, or the wrong
  // landlord. Whether GAM held the deposit was decided inside finalize (it
  // sets a settlement only for a GAM-escrow record).
  const dep = await queryOne<{ connect_account: string | null }>(
    `SELECT -- S554 Connect re-anchor: entity account preferred, user fallback.
            COALESCE(ll.stripe_connect_account_id, usr.stripe_connect_account_id) AS connect_account
       FROM landlords ll
       JOIN users     usr ON usr.id = ll.user_id
      WHERE ll.id = $1`,
    [row.landlord_id],
  )
  if (!dep) return

  const disbursement = round2(settlement)
  if (disbursement <= 0) return

  if (!dep.connect_account) {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'deposit_disbursement_pending_no_connect',
      title:    `Deposit disbursement waiting — landlord has no Connect account`,
      body:     `Deposit return ${row.id} finalized for $${disbursement.toFixed(2)} to landlord but no Connect account on file. Funds remain on platform balance.`,
      context:  { deposit_return_id: row.id, lease_id: row.lease_id, amount: disbursement },
    })
    return
  }

  try {
    const stripe = getStripe()
    await stripe.transfers.create(
      {
        amount:      Math.round(disbursement * 100),
        currency:    'usd',
        destination: dep.connect_account,
        description: `Deposit disbursement — lease ${row.lease_id}`,
        metadata: {
          gam_purpose:           'deposit_return_landlord_disbursement',
          gam_deposit_return_id: row.id,
          gam_lease_id:          row.lease_id,
        },
      },
      { idempotencyKey: `deposit_disb_${row.id}` },
    )
  } catch (e: any) {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'deposit_disbursement_transfer_failed',
      title:    `Deposit disbursement Transfer failed — return ${row.id}`,
      body:     `Stripe Transfer for $${disbursement.toFixed(2)} to landlord Connect ${dep.connect_account} failed: ${e?.message ?? e}.`,
      context:  { deposit_return_id: row.id, lease_id: row.lease_id, amount: disbursement, connect_account: dep.connect_account },
    })
  }
}

async function emitDepositEvent(
  client: PoolClient,
  row: DepositReturnRow,
  eventType:
    | 'deposit_returned_full'
    | 'deposit_returned_partial'
    | 'deposit_returned_zero',
  interestAccrued: number = 0,  // S193: includes interest in audit context
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: row.tenant_id,
      eventType,
      eventData: {
        lease_id: row.lease_id,
        deposit_return_id: row.id,
        total_deposit: Number(row.total_deposit),
        interest_accrued: interestAccrued,
        total_deductions: Number(row.total_deductions),
        refund_amount: Number(row.refund_amount),
        gap_amount: Number(row.gap_amount),
      },
      occurredAt: new Date(),
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { deposit_return_id: row.id },
      dimensionTags: ['property_care', 'tenancy_stability'],
      networkVisibility:
        eventType === 'deposit_returned_full'
          ? 'visible_to_current_landlord'
          : 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Attempt to auto-charge the gap via the tenant's on-file Stripe customer
 * (their default payment method). On failure: marks gap_charge_failed=TRUE on
 * the deposit_returns row with a plain-words reason for the landlord
 * (GAP_CHARGE_REASON) + an admin notification carrying Stripe's detail; the
 * gap row stays payable, so the tenant can still pay it (it is on their bill)
 * or the landlord can record it at the desk. A charge saved but not finished
 * (Stripe unreachable) is not a failure: GAM finishes it
 * (finishPendingGapCharges) and the landlord is asked nothing.
 *
 * S655 (money plan Step 9 and its review; the charge used to leave the gap row
 * pending and payable while the money moved — a double charge waiting to
 * happen — and carried no card fee):
 *   - GAM'S RECORD NAMES THE CHARGE BEFORE ANY MONEY MOVES. The intent is made
 *     UNCONFIRMED (nothing is charged); then, under the household lock and in
 *     one transaction, the receipt (tenant_remittances) is written, the row is
 *     claimed 'processing' only if it is still payable (a row already paid, or
 *     whose money is on its way, is left alone) and the intent is stamped on
 *     both. Only once that has committed is the intent confirmed. A save that
 *     fails therefore never leaves money taken with nothing saying what it paid
 *     (the payment webhook would file it as paid-ahead money, and a move-out
 *     row cannot be paid from credit — the tenant would still owe it and could
 *     be charged again); the unconfirmed intent is canceled instead.
 *   - ONE CHARGE PER GAP ROW. A row that carries an intent is never given a
 *     second one: an earlier run's charge is finished (saved but never
 *     confirmed: it is confirmed now), left to the webhook (money moving or
 *     moved), or let go (declined, or it needs the tenant) — never duplicated.
 *     Each new attempt has its own receipt and its own key
 *     (deposit_gap_<receipt id>), so a retry after a decline is a new request;
 *     the confirm's key (deposit_gap_confirm_<intent id>) makes a lost reply a
 *     replay at Stripe, never a second charge.
 *   - THE TENANT IS NOT HERE: a card is confirmed off-session. A bank account
 *     is confirmed with the mandate every GAM bank pull sends.
 *   - A charge is let go only once Stripe has canceled it (a cancel Stripe
 *     refuses means the money moved: the webhook settles it).
 *   - THE PROCESSING FEE ON TOP, like every card or bank payment (card fee on
 *     every card payment; the bank fee by the property's fee setting).
 *   - A bank account is not charged while bank payments are paused after a
 *     return. A scheduled bank retry on the row is replaced, its pull canceled
 *     after the commit.
 */
export async function attemptGapAutoCharge(draftId: string, args: { gapPaymentId: string }): Promise<void> {
  const gap = await queryOne<{
    tenant_id: string; landlord_id: string; lease_id: string | null; stripe_customer_id: string | null
    ach_suspended: boolean; ach_fee_payer: string | null; card_fee_payer: string | null
    status: string; intent: string | null; payable: boolean
  }>(
    `SELECT p.tenant_id, p.landlord_id, p.lease_id, t.stripe_customer_id,
            (t.ach_suspended_at IS NOT NULL) AS ach_suspended,
            par.ach_fee_payer, par.card_fee_payer,
            p.status, p.stripe_payment_intent_id AS intent, ${payableRowSql('p')} AS payable
       FROM payments p
       JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN units u ON u.id = p.unit_id
       LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
      WHERE p.id = $1`,
    [args.gapPaymentId],
  )
  if (!gap) return

  // A charge an earlier run made for this row: finish it, never make a second.
  if (!gap.payable) {
    if (gap.status === 'processing' && gap.intent) {
      await finishEarlierGapCharge(draftId, args.gapPaymentId, gap.intent, gap.ach_suspended)
    }
    return
  }

  if (!gap.stripe_customer_id) {
    await markGapChargeFailed(draftId, GAP_CHARGE_REASON.noMethod, 'the tenant has no Stripe customer id')
    return
  }

  let stripe: ReturnType<typeof getStripe>
  try {
    stripe = getStripe()
  } catch (e) {
    await markGapChargeFailed(draftId, GAP_CHARGE_REASON.processorDown, `Stripe is not available: ${errText(e)}`)
    return
  }

  // Read the customer's default payment method.
  let paymentMethodId: string | null = null
  try {
    const customer = await stripe.customers.retrieve(gap.stripe_customer_id)
    if (customer && !(customer as any).deleted) {
      const c = customer as any
      const pmRef = c.invoice_settings?.default_payment_method ?? c.default_source ?? null
      paymentMethodId = typeof pmRef === 'string' ? pmRef : pmRef?.id ?? null
    }
  } catch (e) {
    await markGapChargeFailed(draftId, GAP_CHARGE_REASON.lookupFailed, `Stripe customer lookup failed: ${errText(e)}`)
    return
  }

  if (!paymentMethodId) {
    await markGapChargeFailed(draftId, GAP_CHARGE_REASON.noMethod, 'the Stripe customer has no default payment method')
    return
  }

  let method: GapMethod
  let cardCountry: string | null = null
  try {
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
    if (pm.type === 'us_bank_account') method = 'ach'
    else if (pm.type === 'card') { method = 'card'; cardCountry = pm.card?.country ?? null }
    else {
      await markGapChargeFailed(draftId, GAP_CHARGE_REASON.notChargeable, `the default payment method is a ${pm.type}`)
      return
    }
  } catch (e) {
    await markGapChargeFailed(draftId, GAP_CHARGE_REASON.lookupFailed, `Stripe payment method lookup failed: ${errText(e)}`)
    return
  }
  if (method === 'ach' && gap.ach_suspended) {
    await markGapChargeFailed(draftId, GAP_CHARGE_REASON.bankPaused,
      'ACH is suspended after a return and the default payment method is a bank account')
    return
  }

  // Save first: the receipt, the claim and the (unconfirmed) intent, together.
  const client = await getClient()
  let failure: string | null = null
  let unsaved: string | null = null           // an intent made but not saved: canceled below
  let saved: string | null = null             // the intent the row now carries: confirmed below
  let earlier: string | null = null           // another run's charge got there first
  let cancelAfterCommit: string[] = []
  try {
    await client.query('BEGIN')
    await lockHousehold(client, gap.tenant_id, gap.landlord_id)
    const live = (await client.query<{ amount: string; status: string; intent: string | null; payable: boolean }>(
      `SELECT p.amount::text AS amount, p.status, p.stripe_payment_intent_id AS intent, ${payableRowSql('p')} AS payable
         FROM payments p WHERE p.id = $1
          FOR UPDATE`,
      [args.gapPaymentId],
    )).rows[0]
    if (!live || !live.payable) {
      // Paid meanwhile, or a payment for it is on its way: nothing to charge.
      await client.query('ROLLBACK')
      if (live?.status === 'processing' && live.intent) earlier = live.intent
    } else {
      const amount = round2(Number(live.amount))
      const base = computePlatformCut({ amount, paymentMethod: method, cardCountry })
      // Mirror the portal charge (rentCharge.feeFor): only 'landlord' moves the fee off the tenant.
      const payer = method === 'ach' ? gap.ach_fee_payer : gap.card_fee_payer
      const tenantBorne = payer !== 'landlord' ? round2(base) : 0
      const chargeAmount = round2(amount + tenantBorne)

      // A scheduled bank retry on the row is replaced by this charge.
      const superseded = await supersedeScheduledRetry(client, [args.gapPaymentId])

      const receiptId = randomUUID()
      await client.query(
        `INSERT INTO tenant_remittances
           (id, tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
            payment_method, gross_amount, processing_fee_amount, notes)
         VALUES ($1, $2, $3, $4, $5, $5, 0, $6, $7, $8, $9)`,
        [receiptId, gap.tenant_id, gap.lease_id, gap.landlord_id, amount.toFixed(2), method,
         chargeAmount.toFixed(2), tenantBorne.toFixed(2), GAP_RECEIPT_NOTE])

      const metadata: Record<string, string> = {
        gam_remittance_id: receiptId,
        gam_payment_id: args.gapPaymentId,
        tenant_id: gap.tenant_id,
        landlord_id: gap.landlord_id,
        gam_kind: 'deposit_return_gap',
        gam_charge_source: 'move_out_balance',
      }
      if (gap.lease_id) metadata.gam_lease_id = gap.lease_id
      const intent = await stripe.paymentIntents.create(
        gapIntentCreateParams({ chargeAmount, customerId: gap.stripe_customer_id, paymentMethodId, method, metadata }),
        { idempotencyKey: `deposit_gap_${receiptId}` },
      )
      unsaved = intent.id

      const claimed = await client.query(
        `UPDATE payments p
            SET status = 'processing', platform_held = TRUE, next_retry_at = NULL, payment_channel = 'online',
                stripe_payment_intent_id = $2
          WHERE p.id = $1 AND ${payableRowSql('p')}`,
        [args.gapPaymentId, intent.id])
      if ((claimed.rowCount ?? 0) !== 1) throw new Error('The move-out balance changed while it was being charged')
      await client.query(
        `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`,
        [receiptId, args.gapPaymentId, amount.toFixed(2)])
      await client.query(
        `UPDATE tenant_remittances SET stripe_payment_intent_id = $1, updated_at = NOW() WHERE id = $2`,
        [intent.id, receiptId])
      await client.query('COMMIT')
      unsaved = null
      saved = intent.id
      cancelAfterCommit = superseded.cancelAfterCommit
    }
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {})
    failure = e instanceof Error ? e.message : String(e)
  } finally {
    client.release()
  }

  // Made but never saved: it was never confirmed, so nothing was charged. Let it go.
  if (unsaved) await stripe.paymentIntents.cancel(unsaved).catch(() => {})
  // A bank retry this charge replaced (after the commit only).
  await cancelSupersededIntents(cancelAfterCommit)

  if (failure) {
    await markGapChargeFailed(draftId, GAP_CHARGE_REASON.notSetUp, unsaved
      ? `saving the charge failed after intent ${unsaved} was made (it was canceled, never confirmed): ${failure}`
      : `making the charge failed before anything was saved: ${failure}`)
    return
  }
  if (earlier) {
    await finishEarlierGapCharge(draftId, args.gapPaymentId, earlier, gap.ach_suspended)
    return
  }
  if (saved) await confirmGapCharge(stripe, draftId, args.gapPaymentId, saved, method)
}

type GapMethod = 'ach' | 'card'

/** A deposit payment waiting this many days is past any bank payment's clearing time. */
export const DEPOSIT_PAYMENT_STUCK_DAYS = 7

/** What the landlord is told when a payment on the tenancy has been waiting past that. */
export const STUCK_DEPOSIT_PAYMENT_MESSAGE =
  'A payment on this tenancy has been waiting more than a week without clearing or failing, so the move-out can’t be finalized yet. ' +
  'GAM has been told and will check it with the payment processor, then finish or cancel it; you can finalize once it clears or is canceled.'

/** "Oct 9, 2026" from a calendar day (YYYY-MM-DD). */
function shortDayWords(ymd: string): string {
  return new Date(`${ymd.slice(0, 10)}T12:00:00Z`)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/**
 * A calendar day (YYYY-MM-DD) `n` business days after `ymd`: Mon–Fri, and
 * (fix pass 2, review) never a US federal holiday — banks don't move money
 * then, so a clear-by day said across a holiday would be a day early.
 */
export function addBusinessDays(ymd: string, n: number): string {
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00Z`)
  let left = n
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6 && !isUsFederalHoliday(d.toISOString().slice(0, 10))) left--
  }
  return d.toISOString().slice(0, 10)
}

/** A bank payment clears in about 3–5 business days; a card the next day or two (the processor's own timing). */
export const BANK_CLEARING_BUSINESS_DAYS = 5
export const CARD_CLEARING_DAYS = 2

/** What a clearing payment is toward, in a few plain words. */
function clearingPaymentWhat(r: { type: string; lease_fee_id: string | null; fee_label: string | null; prepaid: boolean }): string {
  if (r.prepaid) return 'last month’s rent (paid up front)'
  if (r.type === 'deposit') return r.lease_fee_id && r.fee_label ? `the ${r.fee_label.toLowerCase()}` : 'the security deposit'
  return ({
    rent: 'rent', utility: 'a utility bill', late_fee: 'a late fee', home_payment: 'the home payment',
    carried_balance: 'an earlier balance', fee: 'a fee',
  } as Record<string, string>)[r.type] ?? 'their bill'
}

/**
 * Step 9 final fix (fix pass 1 — decisions #48.6): every payment on this
 * tenancy (the lease, the leases it renewed, and their bills) that is still
 * clearing — processing, started and not finished, or a bank payment that
 * came back and is set to be tried again — and the plain words the landlord
 * is told: what it is toward, when it was made, and the day it should clear.
 * (A line that came back with a retry set is waited for only when it is a
 * deposit or up-front rent — any other the move-out pays from the deposit and
 * stops its retry.) Null when nothing is clearing. `stuck`: payments waiting past
 * DEPOSIT_PAYMENT_STUCK_DAYS (GAM is told). Finalize asks it under the
 * household lock; the deposit-return page reads it to say so before anyone
 * presses Finalize.
 */
export async function tenancyPaymentsClearing(
  q: (text: string, params?: any[]) => Promise<{ rows: any[] }>, leaseId: string,
): Promise<{ words: string; stuck: Array<{ id: string; intent: string | null; started: string }> } | null> {
  const rows = (await q(
    `SELECT p.id, p.stripe_payment_intent_id AS intent, x.started::text AS started, p.amount::text AS amount,
            p.type, p.lease_fee_id, NULLIF(btrim(COALESCE(lf.description, '')), '') AS fee_description, lf.fee_type,
            (p.revenue_owner = 'held' AND lf.money_kind = 'prepaid') AS prepaid,
            (p.status <> 'failed' AND x.started < NOW() - make_interval(days => $2)) AS stuck,
            (p.status = 'failed') AS retry_set,
            (SELECT tr.payment_method FROM tenant_remittances tr
              WHERE tr.stripe_payment_intent_id = p.stripe_payment_intent_id
              ORDER BY tr.created_at DESC LIMIT 1) AS method,
            to_char((x.started AT TIME ZONE tz.zone)::date, 'YYYY-MM-DD') AS started_day,
            to_char((p.next_retry_at AT TIME ZONE tz.zone)::date, 'YYYY-MM-DD') AS retry_day,
            to_char((NOW() AT TIME ZONE tz.zone)::date, 'YYYY-MM-DD') AS today
       FROM payments p
       LEFT JOIN lease_fees lf ON lf.id = p.lease_fee_id
       CROSS JOIN LATERAL (
         SELECT GREATEST(
                  COALESCE((SELECT MIN(tr.created_at) FROM tenant_remittances tr
                             WHERE tr.stripe_payment_intent_id = p.stripe_payment_intent_id),
                           p.created_at),
                  COALESCE(p.last_retry_at, '-infinity'::timestamptz)) AS started
       ) x
       CROSS JOIN LATERAL (
         SELECT COALESCE((SELECT pr.timezone FROM leases zl JOIN units zu ON zu.id = zl.unit_id
                           JOIN properties pr ON pr.id = zu.property_id WHERE zl.id = $1::uuid), 'America/Phoenix') AS zone
       ) tz
      WHERE (p.lease_id IN ${LEASE_CHAIN}
             OR p.invoice_id IN (SELECT ci.id FROM invoices ci WHERE ci.lease_id IN ${LEASE_CHAIN}))
        AND p.amount > 0
        AND (p.status = 'processing'
             OR (p.status = 'pending' AND p.stripe_payment_intent_id IS NOT NULL)
             -- A bank payment that came back and is set to be tried again is
             -- waited for only on a deposit or up-front rent: those are never
             -- paid from the deposit. Any other line the move-out sweeps is
             -- paid from the deposit and its retry is stopped (S655, the
             -- sweep's supersedeScheduledRetry) — nothing is in transit.
             OR (p.status = 'failed' AND p.next_retry_at IS NOT NULL AND COALESCE(p.retry_count, 0) < 2
                 AND p.stripe_payment_intent_id IS NOT NULL
                 AND (p.type = 'deposit' OR (p.revenue_owner = 'held' AND lf.money_kind = 'prepaid'))))
      ORDER BY x.started, (p.type = 'rent') DESC, p.type, p.id`,
    [leaseId, DEPOSIT_PAYMENT_STUCK_DAYS])).rows
  // Fix pass 3 (review, decisions #48.6): a card or bank payment the tenant
  // made toward money paid ahead (nothing owed then — rentCharge's pay-ahead)
  // is a receipt with no bill line, so the read above never saw it: finalize
  // went through while it cleared, and when it settled the webhook banked it
  // as paid-ahead money on the lease that had just ended — never in the
  // move-out pool, never in the landlord's refund choice (#46.1). A receipt
  // still clearing on the tenancy with money not put toward a bill (or no
  // bill line at all) holds finalize too, aged by when it was made.
  const ahead = (await q(
    `SELECT r.id, r.stripe_payment_intent_id AS intent, r.created_at::text AS started, r.payment_method AS method,
            (CASE WHEN r.unapplied_amount > 0 THEN r.unapplied_amount ELSE r.amount END)::text AS amount,
            (r.created_at < NOW() - make_interval(days => $2)) AS stuck,
            to_char((r.created_at AT TIME ZONE tz.zone)::date, 'YYYY-MM-DD') AS started_day,
            to_char((NOW() AT TIME ZONE tz.zone)::date, 'YYYY-MM-DD') AS today
       FROM tenant_remittances r
       CROSS JOIN LATERAL (
         SELECT COALESCE((SELECT pr.timezone FROM leases zl JOIN units zu ON zu.id = zl.unit_id
                           JOIN properties pr ON pr.id = zu.property_id WHERE zl.id = $1::uuid), 'America/Phoenix') AS zone
       ) tz
      WHERE r.lease_id IN ${LEASE_CHAIN}
        AND r.status = 'processing'
        -- Money not put toward a bill: its unapplied part, or a receipt that
        -- applied nothing and has no bill line at all. A receipt whose money
        -- went onto bill lines is counted by those lines (above), never twice.
        AND (r.unapplied_amount > 0
             OR (r.applied_amount = 0
                 AND NOT EXISTS (SELECT 1 FROM remittance_applications ra WHERE ra.remittance_id = r.id)))
      ORDER BY r.created_at, r.id`,
    [leaseId, DEPOSIT_PAYMENT_STUCK_DAYS])).rows
  if (rows.length === 0 && ahead.length === 0) return null
  const stuck = [...rows, ...ahead].filter((r: any) => r.stuck === true)
    .map((r: any) => ({ id: r.id as string, intent: r.intent as string | null, started: r.started as string }))
  const aheadEach = ahead.map((r: any) => ({
    amount: `$${Number(r.amount).toFixed(2)}`,
    way: r.method === 'card' ? 'card' : r.method === 'ach' ? 'bank' : null,
    what: 'money paid ahead',
    retrySet: false, retryDay: null as string | null, startedDay: r.started_day as string,
    clearBy: r.method === 'card' ? addBusinessDays(r.started_day, CARD_CLEARING_DAYS)
      : addBusinessDays(r.started_day, BANK_CLEARING_BUSINESS_DAYS),
  }))
  const lineEach = rows.map((r: any) => {
    const bank = r.method === 'ach' || r.retry_set === true
    const from = r.retry_set && r.retry_day ? r.retry_day : r.started_day
    // A card clears in a day or two; anything else (a bank payment, or a way
    // not on record) is given a bank payment's time, so the day said is never
    // too early.
    const clearBy = r.method === 'card' && !r.retry_set ? addBusinessDays(from, CARD_CLEARING_DAYS)
      : addBusinessDays(from, BANK_CLEARING_BUSINESS_DAYS)
    const label = r.fee_description ?? (r.fee_type ? (LEASE_COLUMN_LABEL as Record<string, string>)[r.fee_type] : null) ?? null
    return {
      amount: `$${Number(r.amount).toFixed(2)}`,
      way: r.method === 'card' ? 'card' : bank ? 'bank' : null,
      what: clearingPaymentWhat({ type: r.type, lease_fee_id: r.lease_fee_id, fee_label: label, prepaid: r.prepaid === true }),
      retrySet: r.retry_set === true, retryDay: r.retry_day as string | null, startedDay: r.started_day as string,
      clearBy,
    }
  })
  const each = [...lineEach, ...aheadEach]
  const latest = each.reduce((m, e) => (e.clearBy > m ? e.clearBy : m), each[0].clearBy)
  // Fix pass 2 (review): a clear-by day already gone (a card still
  // processing days later) is said as late — never "should clear by" a day
  // in the past.
  const today: string = (rows[0] ?? ahead[0]).today
  const clearBySaid = (ymd: string, one: boolean) => ymd < today
    ? `${one ? 'It' : 'The last'} should have cleared by ${shortDayWords(ymd)}.`
    : `${one ? 'It' : 'The last'} should clear by ${shortDayWords(ymd)}.`
  let words: string
  if (stuck.length > 0) {
    // Fix pass 2 (review): one waiting past DEPOSIT_PAYMENT_STUCK_DAYS never
    // clears or fails on its own — the landlord is told GAM has been told
    // (noteStuckTenancyPayments), never a clear-by day long gone with no
    // next step. The same words the page shows and finalize refuses with.
    words = STUCK_DEPOSIT_PAYMENT_MESSAGE
  } else if (each.length === 1) {
    const e = each[0]
    const pay = `${e.amount} ${e.way ? `${e.way} ` : ''}payment toward ${e.what}`
    words = e.retrySet && e.retryDay
      ? `A ${pay} came back and is set to be tried again on ${shortDayWords(e.retryDay)}, so the move-out can’t be finalized yet. ` +
        `If that try goes through it should clear by ${shortDayWords(e.clearBy)}. Finalize once it clears or fails.`
      : `A ${pay}, made ${shortDayWords(e.startedDay)}, is still clearing, so the move-out can’t be finalized yet. ` +
        `${clearBySaid(e.clearBy, true)} Finalize once it clears or fails.`
  } else {
    const list = each.map(e => `${e.amount} toward ${e.what}${e.retrySet && e.retryDay ? ` (to be tried again ${shortDayWords(e.retryDay)})` : ''}`)
    words = `${each.length} payments on this tenancy are still clearing — ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} — ` +
      `so the move-out can’t be finalized yet. ${clearBySaid(latest, false)} Finalize once they clear or fail.`
  }
  return { words, stuck }
}

/**
 * Fix pass 2: tell GAM, once per payment attempt (fix pass 3: a later bank
 * retry that also sticks is a new attempt), about a payment on the tenancy
 * stuck past DEPOSIT_PAYMENT_STUCK_DAYS that is holding up a move-out. Never
 * throws. Step 9 final fix (fix pass 2, review): the deposit-return page's
 * read calls it too (the page no longer presses Finalize while a payment is
 * clearing, so finalize alone never told GAM) — `draftId` is null when no
 * move-out has been begun yet.
 */
export async function noteStuckTenancyPayments(
  draftId: string | null, leaseId: string, rows: Array<{ id: string; intent: string | null; started: string }>,
): Promise<void> {
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    for (const r of rows) {
      const seen = await queryOne<{ x: number }>(
        `SELECT 1 AS x FROM admin_notifications
          WHERE category = 'deposit_payment_stuck_at_move_out' AND context->>'payment_id' = $1
            AND context->>'attempt_started' IS NOT DISTINCT FROM $2 LIMIT 1`, [r.id, r.started])
      if (seen) continue
      await createAdminNotification({
        severity: 'warn',
        category: 'deposit_payment_stuck_at_move_out',
        // decisions #48.6: any payment on the tenancy holds up a move-out now,
        // not only a deposit payment (the category name is kept for readers).
        title: 'A payment has been waiting more than a week and is holding up a move-out',
        body: `${draftId ? `Deposit return ${draftId}` : 'The move-out'} (lease ${leaseId}) cannot be finalized: payment ${r.id} has waited on ` +
          `${r.intent ? `PaymentIntent ${r.intent}` : 'a payment with no PaymentIntent'} since ${r.started}. ` +
          'Look it up in Stripe: if it is still waiting on the tenant (requires_action) or can no longer go through, cancel it — ' +
          'the canceled webhook gives its rows back and the landlord can finalize. If it went through, replay its success event.',
        context: { deposit_return_id: draftId, lease_id: leaseId, payment_id: r.id, stripe_payment_intent_id: r.intent,
                   attempt_started: r.started },
      })
    }
  } catch (e) {
    logger.error({ err: e, ctx: draftId }, '[deposit-return][stuck-deposit-payment-alert]')
  }
}

/** Statuses of an intent whose money is moving or has moved: the payment webhook settles (or fails) the row. */
const GAP_CHARGE_MOVING = new Set(['succeeded', 'processing', 'requires_capture'])

/** The receipt note every move-out balance charge is written with — how the finisher knows its own charges. */
const GAP_RECEIPT_NOTE = 'Move-out balance — charged to the saved payment method'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** What the landlord is told to do next whenever a charge was not made. */
const GAP_NEXT_STEP = 'ask the tenant to pay the move-out balance online, or record it at the desk'

/**
 * What the LANDLORD reads when the move-out balance was not charged
 * (deposit_returns.gap_charge_failure_reason, shown on their deposit-return
 * page). Plain words only: Stripe's states and error text go to GAM's notice,
 * never here (Step 9 review). Each is written only when NOTHING was taken and
 * the move-out balance is owed and payable again, so the next step it names
 * is always one they can take. A charge that is saved but not finished is
 * never one of these — GAM finishes it (finishPendingGapCharges) and nothing
 * is asked of the landlord.
 */
export const GAP_CHARGE_REASON = {
  noMethod: `The tenant has no card or bank account saved, so nothing was charged — ${GAP_NEXT_STEP}`,
  processorDown: `GAM could not reach its payment processor, so nothing was charged — ${GAP_NEXT_STEP}`,
  lookupFailed: `GAM could not look up the tenant's saved card or bank account, so nothing was charged — ${GAP_NEXT_STEP}`,
  notChargeable: `The tenant's saved payment method cannot be charged automatically, so nothing was charged — ${GAP_NEXT_STEP}`,
  bankPaused: `Bank payments are paused for this tenant after a returned bank payment, so their bank account was not charged — ${GAP_NEXT_STEP}`,
  notSetUp: `The charge could not be set up, so nothing was charged — ${GAP_NEXT_STEP}`,
  cardDeclined: `The tenant's card on file was declined, so nothing was charged — ${GAP_NEXT_STEP}`,
  didNotGoThrough: (method: GapMethod): string =>
    `The charge to the tenant's ${method === 'ach' ? 'bank account' : 'card'} on file did not go through, so nothing was charged — ${GAP_NEXT_STEP}`,
  /** Step 9 review (fix pass 1): it went out, then failed or came back at the bank (noteGapChargeReturned). */
  cameBack: (method: GapMethod): string =>
    `The move-out balance charged to the tenant's ${method === 'ach' ? 'bank account' : 'card'} came back unpaid, so it is owed again — ${GAP_NEXT_STEP}`,
} as const

/**
 * What became of a move-out balance charge GAM looked at:
 *   moving      — money is moving or has moved; the payment webhook settles the row
 *   let_go      — canceled at Stripe; the row is owed and payable again, and the landlord told why
 *   unfinished  — saved on the row but Stripe could not be reached; finishPendingGapCharges tries again
 *   not_ours    — the row carries a payment the tenant started themselves; never touched
 */
export type GapChargeOutcome = 'moving' | 'let_go' | 'unfinished' | 'not_ours'

/**
 * What the move-out balance's intent is made with: GAM's platform charge
 * (money held on GAM's balance, batched to the landlord on the weekly run —
 * the shape of stripeConnect.createRentPlatformCharge), but NOT confirmed, so
 * nothing is charged until GAM's record names it.
 */
export function gapIntentCreateParams(o: {
  chargeAmount: number; customerId: string; paymentMethodId: string; method: GapMethod
  metadata: Record<string, string>
}): Stripe.PaymentIntentCreateParams {
  return {
    amount: Math.round(o.chargeAmount * 100),
    currency: 'usd',
    customer: o.customerId,
    payment_method: o.paymentMethodId,
    payment_method_types: o.method === 'ach' ? ['us_bank_account'] : ['card'],
    confirm: false,
    description: 'DEPOSIT - Gold Asset Management',
    metadata: { entry_description: 'DEPOSIT', platform_held: 'true', ...o.metadata },
    ...(o.method === 'ach'
      ? {
          payment_method_options: {
            us_bank_account: {
              financial_connections: { permissions: ['payment_method'] as ('payment_method' | 'balances')[] },
            },
          },
        }
      : {}),
  }
}

/**
 * How it is confirmed. A card: off-session — the tenant has moved out and is
 * not here to answer a bank's challenge (the card is charged as a
 * merchant-initiated payment, or declined; never left waiting on the tenant).
 * A bank account: the same mandate every GAM bank pull confirms with
 * (stripeConnect.createRentPlatformCharge).
 */
export function gapIntentConfirmParams(method: GapMethod): Stripe.PaymentIntentConfirmParams {
  return method === 'card'
    ? { off_session: true }
    : {
        mandate_data: {
          customer_acceptance: {
            type: 'online',
            online: { ip_address: '0.0.0.0', user_agent: 'GAM-Platform/1.0' },
          },
        },
      }
}

/** Why Stripe refused a confirm, when it says (a decline carries the intent it made). */
function declineOf(e: any): string | null {
  const declinedIntent = e?.raw?.payment_intent?.id ?? e?.payment_intent?.id
  if (declinedIntent || e?.type === 'StripeCardError' || e?.rawType === 'card_error') {
    return e?.message ?? 'the card was declined'
  }
  return null
}

/**
 * Confirm the saved intent. Money moving: the webhook settles the row.
 * Declined (or it needs the tenant): it is let go and the row is owed again.
 * Stripe unreachable: the row keeps its saved charge (the tenant sees it
 * clearing; the landlord is asked nothing), GAM is told once, and
 * finishPendingGapCharges finishes it — never a second charge.
 */
async function confirmGapCharge(
  stripe: ReturnType<typeof getStripe>, draftId: string, gapPaymentId: string, intentId: string, method: GapMethod,
): Promise<GapChargeOutcome> {
  let status: string | null = null
  let declined: string | null = null
  let unreachable: string | null = null
  // Twice at most, same key: a lost reply is replayed by Stripe, never charged again.
  for (let i = 0; i < 2 && status === null && declined === null; i++) {
    try {
      const r = await stripe.paymentIntents.confirm(intentId, gapIntentConfirmParams(method),
        { idempotencyKey: `deposit_gap_confirm_${intentId}` })
      status = r.status
    } catch (e: any) {
      declined = declineOf(e)
      unreachable = declined === null ? errText(e) : null
    }
  }
  if (status === null && declined === null) {
    // We do not know whether Stripe took it: ask.
    status = (await stripe.paymentIntents.retrieve(intentId).catch(() => null))?.status ?? null
    if (status === null) {
      await noteGapChargeUnfinished(draftId, gapPaymentId, intentId,
        `the confirm failed twice and Stripe could not be asked about it either (${unreachable})`)
      return 'unfinished'
    }
  }
  if (status !== null && GAP_CHARGE_MOVING.has(status)) {
    await clearGapChargeFailed(draftId)
    return 'moving'
  }
  const landlordReason = declined !== null && method === 'card'
    ? GAP_CHARGE_REASON.cardDeclined
    : GAP_CHARGE_REASON.didNotGoThrough(method)
  const detail = declined !== null
    ? `declined: ${declined}`
    : unreachable ? `${unreachable} (the intent is ${status})` : `the intent is ${status} after the confirm`
  return letGoOfGapCharge(stripe, draftId, gapPaymentId, intentId, landlordReason, detail)
}

/**
 * A row already carrying a move-out balance charge from an earlier run (a
 * retried attempt, or one that stopped between saving and confirming).
 * Stripe unreachable here: nothing changes and nobody is told — the row keeps
 * its saved charge and the next finishPendingGapCharges run asks again.
 */
async function finishEarlierGapCharge(
  draftId: string, gapPaymentId: string, intentId: string, achSuspended: boolean,
): Promise<GapChargeOutcome> {
  let stripe: ReturnType<typeof getStripe>
  try {
    stripe = getStripe()
  } catch (e) {
    logger.warn({ err: e, ctx: draftId, stripe_payment_intent_id: intentId },
      '[deposit-return][gap-charge] Stripe is not available to finish the move-out balance charge; running finishPendingGapCharges again retries it')
    return 'unfinished'
  }
  const now = await stripe.paymentIntents.retrieve(intentId).catch(() => null)
  if (!now) {
    logger.warn({ ctx: draftId, stripe_payment_intent_id: intentId },
      '[deposit-return][gap-charge] Stripe could not be reached to check the move-out balance charge; running finishPendingGapCharges again retries it')
    return 'unfinished'
  }
  // Only ever this charge's own intent: a payment the tenant started on the
  // row themselves (the portal, a card waiting on their bank's check) is theirs
  // to finish, never confirmed or canceled from here.
  const md = (now.metadata ?? {}) as Record<string, string>
  if (md.gam_kind !== 'deposit_return_gap' || md.gam_payment_id !== gapPaymentId) return 'not_ours'
  if (GAP_CHARGE_MOVING.has(now.status)) {                  // the webhook settles it
    await clearGapChargeFailed(draftId)
    return 'moving'
  }
  const method: GapMethod = (now.payment_method_types ?? []).includes('us_bank_account') ? 'ach' : 'card'
  if (now.status === 'requires_confirmation') {
    if (method === 'ach' && achSuspended) {
      return letGoOfGapCharge(stripe, draftId, gapPaymentId, intentId, GAP_CHARGE_REASON.bankPaused,
        'ACH was suspended after a return before the saved bank charge was confirmed')
    }
    return confirmGapCharge(stripe, draftId, gapPaymentId, intentId, method)
  }
  return letGoOfGapCharge(stripe, draftId, gapPaymentId, intentId, GAP_CHARGE_REASON.didNotGoThrough(method),
    `the intent is ${now.status}`)
}

/**
 * Finish move-out balance charges that were saved but never confirmed (Step 9
 * review). attemptGapAutoCharge runs once, at finalize; when Stripe cannot be
 * reached between saving the charge and confirming it, the row is left
 * 'processing' on an intent nobody confirmed — the tenant sees it clearing,
 * the landlord cannot record it at the desk (it is not payable), and nothing
 * else ever looks at it. This looks: every gap row still 'processing' on a
 * move-out balance charge of GAM's own (its receipt says so) older than
 * `olderThanMinutes` (so a charge being made right now is left to its run) is
 * finished — confirmed with its own key (never a second charge), left to the
 * webhook when its money is moving, or let go when it cannot go through.
 *
 * The scheduler runs it every hour (jobs/scheduler.ts); running it again is
 * always safe. Never throws; one row's trouble never stops the rest.
 */
export async function finishPendingGapCharges(
  opts: { olderThanMinutes?: number } = {},
): Promise<{ checked: number; outcomes: Record<GapChargeOutcome, number>; errors: string[] }> {
  const minutes = opts.olderThanMinutes ?? 15
  const out = {
    checked: 0,
    outcomes: { moving: 0, let_go: 0, unfinished: 0, not_ours: 0 } as Record<GapChargeOutcome, number>,
    errors: [] as string[],
  }
  if (!(Number.isInteger(minutes) && minutes >= 0)) {
    out.errors.push(`olderThanMinutes must be a whole number of minutes, not ${minutes}`)
    return out
  }
  let rows: { draft_id: string; payment_id: string; intent: string; ach_suspended: boolean }[]
  try {
    rows = await query(
      `SELECT dr.id AS draft_id, p.id AS payment_id, p.stripe_payment_intent_id AS intent,
              (t.ach_suspended_at IS NOT NULL) AS ach_suspended
         FROM deposit_returns dr
         JOIN payments p ON p.id = dr.gap_payment_id
         JOIN tenants t ON t.id = p.tenant_id
        WHERE p.status = 'processing'
          AND p.stripe_payment_intent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM tenant_remittances r
                       WHERE r.stripe_payment_intent_id = p.stripe_payment_intent_id
                         AND r.status = 'processing'
                         AND r.notes = $2
                         AND r.created_at < NOW() - make_interval(mins => $1::int))
        ORDER BY dr.finalized_at NULLS LAST, dr.id`,
      [minutes, GAP_RECEIPT_NOTE])
  } catch (e) {
    out.errors.push(errText(e))
    logger.error({ err: e }, '[deposit-return][gap-charge] could not list move-out balance charges to finish')
    return out
  }
  for (const r of rows) {
    out.checked++
    try {
      out.outcomes[await finishEarlierGapCharge(r.draft_id, r.payment_id, r.intent, r.ach_suspended)]++
    } catch (e) {
      out.errors.push(`${r.payment_id}: ${errText(e)}`)
      logger.error({ err: e, ctx: r.draft_id, payment_id: r.payment_id },
        '[deposit-return][gap-charge] could not finish a move-out balance charge')
    }
  }
  return out
}

/**
 * Let a charge go: canceled at Stripe FIRST, and only then is the row owed and
 * payable again (pending, no intent) and its receipt closed as failed. A cancel
 * Stripe refuses means the money moved after all — the row is left for the
 * webhook to settle.
 */
async function letGoOfGapCharge(
  stripe: ReturnType<typeof getStripe>, draftId: string, gapPaymentId: string, intentId: string,
  landlordReason: string, detail: string,
): Promise<GapChargeOutcome> {
  let canceled = false
  try {
    canceled = (await stripe.paymentIntents.cancel(intentId)).status === 'canceled'
  } catch {
    canceled = (await stripe.paymentIntents.retrieve(intentId).catch(() => null))?.status === 'canceled'
  }
  if (!canceled) {
    const now = (await stripe.paymentIntents.retrieve(intentId).catch(() => null))?.status ?? null
    if (now !== null && GAP_CHARGE_MOVING.has(now)) {
      await clearGapChargeFailed(draftId)
      return 'moving'
    }
    // Not canceled and not moving: the row still carries it, so it is not yet
    // the landlord's to collect. GAM is told; the next finisher run tries again.
    await noteGapChargeUnfinished(draftId, gapPaymentId, intentId,
      `${detail}; letting it go, Stripe would not cancel it (${now ?? 'could not be reached'}), so the row still carries it`)
    return 'unfinished'
  }
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const row = (await client.query<{ tenant_id: string; landlord_id: string }>(
      `SELECT tenant_id, landlord_id FROM payments WHERE id = $1`, [gapPaymentId])).rows[0]
    if (row) await lockHousehold(client, row.tenant_id, row.landlord_id)
    await client.query(
      `UPDATE payments
          SET status = 'pending', stripe_payment_intent_id = NULL, platform_held = FALSE, next_retry_at = NULL
        WHERE id = $1 AND status = 'processing' AND stripe_payment_intent_id = $2`,
      [gapPaymentId, intentId])
    await client.query(
      `UPDATE tenant_remittances SET status = 'failed', updated_at = NOW()
        WHERE stripe_payment_intent_id = $1 AND status = 'processing'`,
      [intentId])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error({ err: e, payment_id: gapPaymentId, stripe_payment_intent_id: intentId },
      '[deposit-return][gap-charge] could not reopen the move-out balance after its charge was canceled (the webhook will)')
  } finally {
    client.release()
  }
  await markGapChargeFailed(draftId, landlordReason, detail)
  return 'let_go'
}

/**
 * The move-out balance was not charged and is the landlord's to collect:
 * `landlordReason` (one of GAP_CHARGE_REASON, plain words) is what their page
 * shows; `detail` (Stripe's words, states, errors) goes to GAM only.
 */
async function markGapChargeFailed(draftId: string, landlordReason: string, detail: string): Promise<void> {
  // Fix pass 4: once per failure. A card declined at finalize can be noted by
  // the payment_failed webhook (noteGapChargeReturned) before letGoOfGapCharge
  // reopens the row; the second mark keeps the first note (the landlord's
  // reason is not rewritten) and GAM is not told twice. clearGapChargeFailed
  // resets the flag when a charge moves again, so a later failure still tells.
  const marked = await query<{ id: string }>(
    `UPDATE deposit_returns
        SET gap_charge_failed = TRUE,
            gap_charge_failure_reason = $1,
            updated_at = NOW()
      WHERE id = $2 AND NOT gap_charge_failed
      RETURNING id`,
    [landlordReason, draftId],
  )
  if (marked.length === 0) {
    logger.info({ ctx: draftId, reason: landlordReason, detail },
      '[deposit-return][gap-charge] move-out balance already noted as not charged; the first note stands')
    return
  }
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'deposit_return_gap_charge_failed',
      title: 'Move-out gap auto-charge failed',
      body: `Deposit return ${draftId}: the move-out balance was not charged. The landlord was told: "${landlordReason}". Detail: ${detail}.`,
      context: { deposit_return_id: draftId, reason: landlordReason, detail },
    })
  } catch (e) {
    logger.error({ err: e }, '[deposit-return][gap-fail-alert]')
  }
}

/** The move-out balance charge is moving after all: an earlier "not charged" note no longer holds. */
async function clearGapChargeFailed(draftId: string): Promise<void> {
  await query(
    `UPDATE deposit_returns
        SET gap_charge_failed = FALSE, gap_charge_failure_reason = NULL, updated_at = NOW()
      WHERE id = $1 AND gap_charge_failed`,
    [draftId],
  ).catch(e => logger.error({ err: e, ctx: draftId }, '[deposit-return][gap-charge] could not clear the failure note'))
}

/**
 * Step 9 review (fix pass 1): the move-out balance charge failed or came back
 * at the bank AFTER finalize — a bank payment that bounced days later, or one
 * Stripe took back — and the balance is owed again. Before this only the
 * charge attempt at finalize ever set gap_charge_failed, so the landlord's
 * deposit-return page kept saying nothing while the tenant owed the balance
 * again. The payment webhook (routes/webhooks.ts) calls it when a payment
 * whose intent carries metadata gam_kind 'deposit_return_gap' fails for good
 * or is canceled (`how: 'did_not_go_through'`), or is taken back by a dispute
 * or bank return after it went through (`how: 'came_back'`); `paymentId` is
 * the move-out balance row, or a row a reversal of it reopened. Tells the
 * landlord once (an existing failure note stands), in plain words, and GAM
 * with `detail`. Never throws; returns whether the landlord was told.
 */
export async function noteGapChargeReturned(
  paymentId: string,
  detail = 'the payment failed or was returned after it was sent',
  opts: { how?: 'came_back' | 'did_not_go_through' | 'card_declined' } = {},
): Promise<boolean> {
  // 10/4 (decisions #51, #47a): the dispute webhook calls this for every row a
  // reversal reopened. A deposit payment part of whose money a finalized
  // move-out put on its refund: a part already sent stays sent (the tenant
  // owes it again on the reopened charge, GAM is alerted); of a part not sent
  // yet, only the share the dispute took is stopped and the reopened charge
  // lowered by exactly that share. Never throws.
  try {
    // Fix pass 2: the deposit refund's alert says what was taken back in its
    // own words (the webhook's detail names the move-out balance charge).
    const { noteDepositRefundOfReturnedPayment } = await import('./depositRefundSend')
    await noteDepositRefundOfReturnedPayment(paymentId)
  } catch (e) {
    logger.error({ err: e, payment_id: paymentId }, '[deposit-return] could not check a returned payment against its move-out refund')
  }
  try {
    const dr = await queryOne<{ id: string; gap_charge_failed: boolean; method: string | null }>(
      `SELECT dr.id, dr.gap_charge_failed,
              (SELECT r.payment_method FROM remittance_applications ra
                 JOIN tenant_remittances r ON r.id = ra.remittance_id
                WHERE ra.payment_id = dr.gap_payment_id
                ORDER BY r.created_at DESC LIMIT 1) AS method
         FROM deposit_returns dr
        WHERE dr.gap_payment_id = $1
           OR dr.gap_payment_id = (SELECT pr.payment_id FROM payments p
                                     JOIN payment_reversals pr ON pr.id = p.reversal_id
                                    WHERE p.id = $1)
        LIMIT 1`,
      [paymentId])
    if (!dr || dr.gap_charge_failed) return false
    const method: GapMethod = dr.method === 'ach' ? 'ach' : 'card'
    // Leftovers fix: a card the bank declined says so (cardDeclined), not the
    // generic "did not go through".
    await markGapChargeFailed(dr.id, opts.how === 'card_declined'
      ? GAP_CHARGE_REASON.cardDeclined
      : opts.how === 'did_not_go_through'
        ? GAP_CHARGE_REASON.didNotGoThrough(method)
        : GAP_CHARGE_REASON.cameBack(method), detail)
    return true
  } catch (e) {
    logger.error({ err: e, payment_id: paymentId }, '[deposit-return][gap-charge] could not note a returned move-out balance charge')
    return false
  }
}

/**
 * A move-out balance charge is saved on its row but could not be finished
 * (Stripe unreachable). Nothing is asked of the landlord — the row is not
 * theirs to collect while it carries the charge, and GAM finishes it
 * (finishPendingGapCharges). GAM is told once per charge, with the detail.
 */
async function noteGapChargeUnfinished(
  draftId: string, gapPaymentId: string, intentId: string, detail: string,
): Promise<void> {
  try {
    const seen = await queryOne<{ x: number }>(
      `SELECT 1 AS x FROM admin_notifications
        WHERE category = 'deposit_return_gap_charge_unfinished'
          AND context->>'stripe_payment_intent_id' = $1
        LIMIT 1`,
      [intentId])
    if (seen) {
      logger.warn({ ctx: draftId, stripe_payment_intent_id: intentId, detail },
        '[deposit-return][gap-charge] move-out balance charge still unfinished; running finishPendingGapCharges again retries it')
      return
    }
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'deposit_return_gap_charge_unfinished',
      title: 'A move-out balance charge is saved but not finished',
      body: `Deposit return ${draftId}: charge ${intentId} on move-out balance row ${gapPaymentId} is saved (the tenant sees it clearing) ` +
        `but could not be finished: ${detail}. GAM's hourly move-out charge finisher ` +
        '(depositReturn.finishPendingGapCharges) tries it again: it confirms this same charge with its own key, so it is never made twice. ' +
        'The landlord is not asked to do anything.',
      context: { deposit_return_id: draftId, payment_id: gapPaymentId, stripe_payment_intent_id: intentId, detail },
    })
  } catch (e) {
    logger.error({ err: e, ctx: draftId }, '[deposit-return][gap-unfinished-alert]')
  }
}
