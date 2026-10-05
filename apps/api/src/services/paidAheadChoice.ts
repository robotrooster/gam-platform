/**
 * 10/4 (decisions #46.1, Nic, FINAL) — THE LANDLORD'S CHOICE FOR PAID-AHEAD
 * MONEY LEFT ON AN ENDED LEASE.
 *
 * Paid-ahead money (lease_prepaid_credits) still on a lease that ended — after
 * a move-out finalize, after a long stay's early check-out, or a lease that
 * simply ended — gets ONE decision, by someone with "Issue refunds"
 * (pos.refund):
 *
 *   1. "No refund", "Refund the unused days" or "Refund a different amount". A
 *      refund goes back ONLY the way the money was paid (decisions #37.B, #38
 *      Q3/Q10) — a card to that same card, a bank payment to the bank, cash,
 *      a check or a money order handed back at the desk, credit back to
 *      credit — through the SAME refund parts the early check-out uses
 *      (services/earlyCheckOut: planRefund, cardRefundTerms, partWords,
 *      landlordCostWords, and runCardPart to send card and bank parts). The
 *      tenant gets back everything they paid for it, the card fee included
 *      (#38 Q4); Stripe keeps its processing fee and that is the LANDLORD's
 *      cost, shown exactly before they confirm. GAM absorbs nothing.
 *   2. What is not refunded, the LANDLORD decides (GAM never does):
 *        "Keep it" — it becomes the landlord's money. When GAM holds it (it
 *          came through Stripe) it is released to them once, as a
 *          'prepaid_draw' held item on their next payout (one per spend, so it
 *          can never be paid twice); when they already hold it, it is simply
 *          recorded as kept.
 *        "Leave it as their credit" — still the tenant's money (decisions
 *          #46.1a, the orchestrator's default following the existing
 *          paid-ahead rule): NOTHING is spent or released at the decision. It
 *          stays their money paid ahead (lease_prepaid_credits, marked
 *          left_by_choice_id): what GAM holds stays GAM-held and is paid to
 *          the landlord only when it pays one of their bills; what the
 *          landlord holds is credit they owe the tenant. It follows the person
 *          to their next lease with this landlord (the DB moves it when that
 *          lease is in force: paid_ahead_carry_left) and pays their bills
 *          there. It is not a landlord-issued credit, so nothing can void it.
 *
 * Every dollar moves through the credit ledger (credit_uses): a refund is a
 * 'refund' spend on its part (refund_part_id); money kept is a
 * 'paid_ahead_choice' spend on the decision (paid_ahead_choice_id); money
 * left as their credit is not spent at all. Decided
 * once: the screen carries the figures it showed (quoteToken); anything that
 * changed — including someone else deciding it a moment ago — is a 409 in
 * plain words with the fresh view, so the page shows the latest in place. A
 * repeat of the same press (idempotency key) returns what the first did.
 *
 * Waits, never guesses: while a long stay's early check-out still has its own
 * money question open, or the move-out is not done yet (a deposit return in
 * draft or waiting for approval — or none yet while a security deposit is
 * still held or money is still owed on the lease: decisions #46.2, deductions
 * come out of the deposit first and the money paid ahead only covers what the
 * deposit cannot), the screen says where to finish that first and offers no
 * choice here. Paid-ahead money a stay's check-out
 * already answered "No refund" (or part-refunded) for is not offered a refund
 * again — only Keep it / Leave it as their credit.
 *
 * Card and bank refunds go back to the card or bank on EVERY ended lease, a
 * stay behind it or not (review fix, choice46b: earlyCheckOut reads a part's
 * stay with a LEFT JOIN and takes its unit from this choice's lease). A card
 * or bank refund of money GAM holds that is given back in cash instead has
 * what GAM held released to the landlord once (releaseCashInsteadHeld), so
 * their only cost is the card fee they handed back with it (#38 Q4).
 *
 * Review fix pass 3: a card or bank refund that did not go out has a way out
 * here — Try again, or "Give it back in cash instead" (the early check-out's
 * own givePartBackInCash); the landlord's cost is said in words that fit
 * money GAM still holds (costWordsFor); "Refund all that can go back" carries
 * its own rest and that rest's choices; a bill added after the move-out waits
 * the choice; days are named on the property's calendar.
 *
 * Choice46c: a refund that can never be sent shows no Try again — the server
 * says so (PartLine.retry false), refuses a retry with a plain 409, and the
 * line says what to do instead: a register sale the register already refunded
 * (check at the register), or a payment that was disputed or returned by the
 * bank (press "Give it back in cash instead"). A refund that had not gone out when a
 * dispute or return took the money back is marked by the dispute handler
 * (creditUse.PAID_AHEAD_PART_TAKEN_BACK): never sent, never handed back, off
 * the to-do. A dispute or return after a refund from here makes the refund a
 * balance the tenant owes again, and after "Give it back in cash instead" the
 * money GAM released is charged back to the landlord like a Keep it release
 * (creditUse.recoverChoiceMoney, decisions #51).
 *
 * Choice46d fix pass 2: no line or to-do ever orders cash before the press
 * (the press asks Stripe first; only its answer says "Hand back $X in cash
 * now."). The cash press puts right what a dispute settled first (the
 * owed-again undo, stopping a refund of a disputed payment); pressed again
 * after an earlier press was recorded (its answer lost), the reply says when
 * it was recorded and the plain next step. GAM releases for cash handed back
 * only what it still holds of that refund (creditUse.cashPartReleaseSql) —
 * never money a dispute took, which is told to GAM's admin instead. Each cash
 * part carries the reply's own words (PartLine.cashReply), so the page shows
 * them once for a press whose answer was lost.
 *
 * Choice46d fix pass 3: the cash press holds its own key
 * (creditUse.paidAheadCashPressKey) from its undo and checks through the
 * hand-back; a dispute, a bank return and the owed-again undo try that key
 * before they mark a part (creditUse.lockRefundParts) and are sent round again
 * while a press holds it — so a dispute can never mark a part between a
 * press's look and its replacement. If the undo or the stop step cannot
 * finish, the press is refused (503) and nothing is handed back. A backstop
 * still checks the cash just recorded (creditUse.cashAfterTakenBackSql, which
 * also reads the undo's own notice): then the reply says "Do not hand anything
 * back" and GAM's admin is told the worker was told not to. Cash recorded by a
 * press whose reply the reader never saw is never an unconditional order:
 * PartLine.cashReply and the repeat-press reply name who recorded it and when
 * (audit_log 'paid_ahead_cash_handed_back') — "by you: hand it back if you
 * have not" in gold; anyone else: ask them first.
 *
 * Choice46e (review): before any press, the choices and the preview say money
 * given back at the desk as what will happen after Confirm (deskPlanWords) —
 * "Hand back $X in cash now." and "Give back $X — …" are only in the reply to
 * the press (deskOrder, cashPressWords). The record line for cash given
 * instead of a card or bank refund reads "recorded as handed back … by <who>
 * on <when>", never a bare "handed back" (the press's answer may have been
 * lost). A cash press that cannot ask Stripe answers 503 in this screen's own
 * words (stripeUnreachableWords). A session lock whose unlock fails closes its
 * connection instead of pooling it (unlockSession, releaseAfterSessionLock).
 */
import type { PoolClient } from 'pg'
import crypto from 'crypto'
import {
  PAID_AHEAD_REFUND_CHOICES, PAID_AHEAD_REFUND_CHOICE_LABEL, PAID_AHEAD_REST_CHOICES, PAID_AHEAD_REST_CHOICE_LABEL,
  PAID_AHEAD_REFUND_ALL_PARTIAL_LABEL,
  type PaidAheadRefundChoice, type PaidAheadRestChoice, type StayRefundPartKind,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { todayIn, dateIn } from '../lib/timezone'
import {
  planRefund, landlordCostWords, partWords, runCardPart, givePartBackInCash, livePartSql, money, poolQ, recordSaleRefund,
  type MoneySource, type PlannedPart,
} from './earlyCheckOut'
import {
  disputeClaimJoinSql, usablePaidAheadSql, createIssuedCredit, runWholeBillCheckAfterCommit,
  fundingTakenBackSql, PAID_AHEAD_PART_TAKEN_BACK, PAID_AHEAD_PART_CANNOT_GO, REFUND_NOT_RECORDED_PATTERN,
  refundWentOutUnrecorded, cashPartReleaseWords, undoOwedAgainForFailedRefunds, cashPartReleaseSql, cashAfterTakenBackSql,
  paidAheadCashPressKey, isDisputeRetryLater,
} from './creditUse'
import { lockHousehold, payableRowSql } from './moneyPredicates'
import { recordHeldItem } from './heldPayouts'

type Q = Pick<PoolClient, 'query'>

const round2 = (n: number) => Math.round(n * 100) / 100
const toCents = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100)
/**
 * A day as "Oct 4": a calendar day (YYYY-MM-DD) as it is; an INSTANT (a
 * payment, a decision) on the property's own calendar — an evening payment in
 * Phoenix is never shown as the next day (review fix pass 3).
 */
const shortDay = (d: Date | string, tz: string | null = null): string => {
  const ymd = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : dateIn(tz, new Date(d))
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** The landlord screen for a lease's paid-ahead money (also the link in notices and to-dos). */
export const paidAheadChoicePath = (leaseId: string) => `/leases/${leaseId}/paid-ahead-choice`

/** The permission words, said once with the next step. */
export const PAID_AHEAD_PERM_WORDS =
  'Deciding what happens to money paid ahead needs the "Issue refunds" permission, and nothing was changed. '
  + 'Ask the account owner to turn it on for you in My Team.'

const isRefundChoice = (c: unknown): c is PaidAheadRefundChoice =>
  typeof c === 'string' && (PAID_AHEAD_REFUND_CHOICES as readonly string[]).includes(c)
const isRestChoice = (c: unknown): c is PaidAheadRestChoice =>
  typeof c === 'string' && (PAID_AHEAD_REST_CHOICES as readonly string[]).includes(c)

// ─── Which leases ────────────────────────────────────────────────────────────

/**
 * SQL, on a leases alias `l` and its property `pr`: the lease has ENDED —
 * expired or terminated, or a long stay's lease that ends on the day the guest
 * was checked out (the 2am lease-end run has not flipped it yet) — and no
 * renewal of it is pending or running (a renewal hands its paid-ahead money on;
 * the tenancy did not end).
 */
export const endedLeaseSql = (l: string, pr: string) => `(
  (${l}.status IN ('expired', 'terminated')
   OR (${l}.status = 'active' AND ${l}.end_date IS NOT NULL
       AND ${l}.end_date <= (NOW() AT TIME ZONE COALESCE(${pr}.timezone, 'America/Phoenix'))::date
       AND EXISTS (SELECT 1 FROM unit_bookings eb WHERE eb.id = ${l}.source_booking_id AND eb.status = 'checked_out')))
  AND NOT EXISTS (SELECT 1 FROM leases rn WHERE rn.supersedes_lease_id = ${l}.id AND rn.status IN ('pending', 'active')))`

// ─── The money left, and how it was paid ─────────────────────────────────────

/** One paid-ahead credit still on the lease. */
interface CreditRow {
  id: string
  tenant_id: string
  usable: number
  note: string | null
  funded_by: string | null
  gam_held: boolean
  received_at: string
  source_remittance_id: string | null
  source_payment_id: string | null
}

/** A payment a credit's money came from, and how much of it can still go back to it. */
interface Funding {
  remittance_id: string | null
  method: string | null
  intent: string | null
  status: string | null
  at: string
  cap: number
  amount: number
  tenant_fee: number
  alloc_fee: number | null
  fee_payer: string | null
  parts_toward: number
  /**
   * Paid with account credit (credit back to credit): 'issued' — a credit the
   * landlord gave (back as such); 'paid_ahead' — the tenant's own money paid
   * ahead (it stays theirs as money paid ahead, never a voidable credit).
   */
  credit?: 'issued' | 'paid_ahead'
  /**
   * A stay's own payment (stay_payments) — the reservation money behind a
   * credit with no payment of its own (review fix, choice46b pass 2): its
   * sale, how it is named, and its card fees per dollar (stay_payments
   * carries them; no remittance to read them from).
   */
  stay?: { stayPaymentId: string; posTransactionId: string | null; where: string; feeRate: number; landlordFeeRate: number }
}

export interface CreditLine {
  id: string
  amount: number
  howPaid: string
  receivedOn: string
  /** GAM holds this money (it came through Stripe); otherwise the landlord does. */
  gamHeld: boolean
  /** A long stay's check-out already asked the refund question for it. */
  refundAnswered: boolean
}

/** A MoneySource as the screen reads it (no internals). */
export interface SourceLine { key: string; kind: string; label: string; refundable: number }

interface Ctx {
  lease: {
    id: string; landlord_id: string; status: string; end_date: string | null; unit_id: string; unit_number: string
    property_id: string; property_name: string; timezone: string | null; source_booking_id: string | null
  }
  credits: CreditRow[]
  sources: MoneySource[]
  /** Source key → the credit it draws, and whether GAM holds that money. */
  sourceCredit: Map<string, { creditId: string; gamHeld: boolean; creditBack?: 'issued' | 'paid_ahead' }>
  answeredCreditIds: Set<string>
  left: number
}

/**
 * SQL, on a lease_prepaid_credits alias: GAM holds this credit's money (it
 * came through Stripe, or a platform-held prepaid fee) — the same facts
 * v_credit_uses.gam_held reads for a spend, for money not spent yet.
 */
const creditGamHeldSql = (c: string) => `(CASE WHEN ${c}.funded_by IS NOT NULL THEN ${c}.funded_by = 'gam'
                 ELSE EXISTS (SELECT 1 FROM tenant_remittances r
                               WHERE r.id = ${c}.source_remittance_id AND r.payment_method IN ('ach', 'card')
                                 AND r.stripe_payment_intent_id IS NOT NULL)
                      OR EXISTS (SELECT 1 FROM payments sp WHERE sp.id = ${c}.source_payment_id AND sp.platform_held) END)`

/**
 * SQL, on a lease_prepaid_credits alias: money a choice on THIS lease already
 * left as the tenant's credit (decided once — it waits for their next lease).
 * Review fix pass 3: the mark counts only while the credit is still on the
 * lease that choice was made on. A credit something else moved by rewriting
 * its lease (a renewal hand-off, a move-out carry-forward) keeps a stale mark;
 * on its new lease it is ordinary money paid ahead again, so when THAT lease
 * ends with it left, the landlord is asked again — never skipped for good.
 */
const leftHereSql = (c: string) => `(${c}.left_by_choice_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM paid_ahead_choices lhc WHERE lhc.id = ${c}.left_by_choice_id AND lhc.lease_id = ${c}.lease_id))`

async function loadLease(q: Q, leaseId: string): Promise<Ctx['lease'] | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(leaseId ?? ''))) return null
  return (await q.query<Ctx['lease']>(
    `SELECT l.id, l.landlord_id, l.status, to_char(l.end_date, 'YYYY-MM-DD') AS end_date, l.unit_id, u.unit_number,
            u.property_id, pr.name AS property_name, pr.timezone, l.source_booking_id
       FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
      WHERE l.id = $1`, [leaseId])).rows[0] ?? null
}

/**
 * The paid-ahead credits still on the lease: each one's usable money (less
 * what a dispute or return of its own Stripe funding still claims —
 * creditUse.usablePaidAheadSql, the one reader everyone shares), newest first.
 * `lock` locks them (the decision); the view reads without locks.
 */
async function loadCredits(q: Q, leaseId: string, lock: boolean): Promise<CreditRow[]> {
  if (lock) {
    await q.query(
      `SELECT c.id FROM lease_prepaid_credits c WHERE c.lease_id = $1 AND c.voided_at IS NULL AND c.amount_remaining > 0
          AND NOT ${leftHereSql('c')}
        ORDER BY c.id FOR UPDATE OF c`, [leaseId])
  }
  const rows = (await q.query<any>(
    `SELECT c.id, c.tenant_id, (${usablePaidAheadSql('c', 'dc')})::float AS usable, c.note, c.funded_by,
            to_char(COALESCE(c.received_at, c.created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
            c.source_remittance_id, c.source_payment_id,
            -- Who holds the money (v_credit_uses.gam_held reads the same facts
            -- for a spend; this is the same rule for money not spent yet).
            ${creditGamHeldSql('c')} AS gam_held
       FROM lease_prepaid_credits c
       ${disputeClaimJoinSql('c', 'dc')}
      -- Money a choice already left as the tenant's credit is decided: it
      -- waits for their next lease (decided once).
      WHERE c.lease_id = $1 AND c.voided_at IS NULL AND c.amount_remaining > 0 AND NOT ${leftHereSql('c')}
      ORDER BY COALESCE(c.received_at, c.created_at) DESC, c.id DESC`, [leaseId])).rows
  return rows
    .map((r) => ({ ...r, usable: round2(Number(r.usable)) }))
    .filter((r) => r.usable > 0.005)
}

const FUNDING_COLS = `
  r.id AS remittance_id, r.payment_method AS method, r.stripe_payment_intent_id AS intent, r.status,
  to_char(COALESCE(r.settled_at, r.created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
  r.amount::float AS amount`

/**
 * Where one credit's money came from, newest first: the payment that made it
 * (an over-payment's remittance), or — for rent banked when a stay was
 * shortened, or a prepaid move-in fee — the payments that paid its anchor row,
 * and credit that paid it (back to credit).
 */
async function fundingOf(q: Q, c: CreditRow, lease: Ctx['lease']): Promise<Funding[]> {
  const { remittanceFeeColumnsSql } = await import('./stripeCosts')
  const { TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL } = await import('./platformRevenue')
  const parts = `COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                           WHERE rp.remittance_id = r.id AND ${livePartSql('rp')}), 0)::float AS parts_toward`
  const fee = remittanceFeeColumnsSql('r', 'tpf')
  if (!c.source_remittance_id && !c.source_payment_id && c.funded_by === 'reclassified') {
    return reclassifiedFunding(q, c, lease, fee, parts)
  }
  if (c.source_remittance_id) {
    return (await q.query<any>(
      `SELECT ${FUNDING_COLS}, ${fee}, ${parts}, $2::float AS cap
         FROM tenant_remittances r LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
        WHERE r.id = $1`, [c.source_remittance_id, c.usable])).rows
  }
  if (!c.source_payment_id) return []
  const rows: Funding[] = (await q.query<any>(
    `SELECT ${FUNDING_COLS}, ${fee}, ${parts}, SUM(ra.amount_applied)::float AS cap
       FROM remittance_applications ra
       JOIN tenant_remittances r ON r.id = ra.remittance_id
       LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
      WHERE ra.payment_id = $1
      GROUP BY r.id, tpf.amt
      ORDER BY COALESCE(r.settled_at, r.created_at) DESC, r.id DESC`, [c.source_payment_id])).rows
  if (!rows.length) {
    // A prepaid fee paid through Stripe with no application on record: its own intent.
    const viaIntent = (await q.query<any>(
      `SELECT ${FUNDING_COLS}, ${fee}, ${parts}, sp.amount::float AS cap
         FROM payments sp
         JOIN tenant_remittances r ON r.stripe_payment_intent_id = sp.stripe_payment_intent_id
         LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
        WHERE sp.id = $1 AND sp.stripe_payment_intent_id IS NOT NULL
        LIMIT 1`, [c.source_payment_id])).rows
    rows.push(...viaIntent)
  }
  // Review fix pass 3: credit that paid it, by where that credit came from —
  // a credit the landlord gave goes back as such (createIssuedCredit), but
  // money paid ahead (the tenant's own) goes back as money paid ahead, never
  // as a landlord credit that could be voided (decisions #46.1a).
  const byCredit = (await q.query<{ amount: number; at: string | null; from_paid_ahead: boolean }>(
    `SELECT COALESCE(SUM(u.amount), 0)::float AS amount, (u.prepaid_credit_id IS NOT NULL) AS from_paid_ahead,
            to_char(MAX(u.applied_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
       FROM credit_uses u WHERE u.payment_id = $1 AND u.status = 'applied'
      GROUP BY (u.prepaid_credit_id IS NOT NULL)
      ORDER BY (u.prepaid_credit_id IS NOT NULL)`, [c.source_payment_id])).rows
  for (const b of byCredit) {
    if (!(b.amount > 0.005)) continue
    rows.push({ remittance_id: null, method: 'credit', intent: null, status: 'settled', at: b.at ?? c.received_at,
      cap: b.amount, amount: b.amount, tenant_fee: 0, alloc_fee: null, fee_payer: null, parts_toward: 0,
      credit: b.from_paid_ahead ? 'paid_ahead' : 'issued' })
  }
  return rows
}

/**
 * Review fix (choice46b pass 2), decisions #37.B — back only the way it was
 * paid: reclassified money paid ahead with no payment of its own on record —
 * a reservation deposit's leftover (moveInBundle, STAY_DEPOSIT_CREDIT_NOTE)
 * or a shortened stay's credit made again when the stay changed
 * (bookingLeaseBilling, STAY_SHORTENED_CREDIT_NOTE with no anchor row) — is
 * traced to the payments that brought it in, newest first: for a shortened
 * stay, the lease's rent payments; then the stay's own payments (the lease's
 * source_booking_id: stay_payments, a register sale's room after what the
 * register and earlier refunds already gave back). So a card-paid
 * reservation deposit goes back to that card — never "no payment on file",
 * never cash at the desk.
 */
async function reclassifiedFunding(q: Q, c: CreditRow, lease: Ctx['lease'], fee: string, parts: string): Promise<Funding[]> {
  const { STAY_DEPOSIT_CREDIT_NOTE } = await import('../jobs/moveInBundle')
  const { STAY_SHORTENED_CREDIT_NOTE } = await import('./bookingLeaseBilling')
  if (c.note !== STAY_DEPOSIT_CREDIT_NOTE && c.note !== STAY_SHORTENED_CREDIT_NOTE) return []
  const { TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL } = await import('./platformRevenue')
  const out: Funding[] = []
  if (c.note === STAY_SHORTENED_CREDIT_NOTE) {
    out.push(...(await q.query<any>(
      `SELECT ${FUNDING_COLS}, ${fee}, ${parts}, SUM(ra.amount_applied)::float AS cap
         FROM remittance_applications ra
         JOIN tenant_remittances r ON r.id = ra.remittance_id
         JOIN payments p ON p.id = ra.payment_id
         LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
        WHERE p.lease_id = $1 AND p.type = 'rent' AND p.status IN ('settled', 'paid_via_deposit') AND r.status = 'settled'
        GROUP BY r.id, tpf.amt
        ORDER BY COALESCE(r.settled_at, r.created_at) DESC, r.id DESC`, [lease.id])).rows)
  }
  if (lease.source_booking_id) {
    const stay = (await q.query<any>(
      `SELECT sp.id, sp.kind, sp.method, sp.stripe_payment_intent_id AS intent, sp.pos_transaction_id,
              to_char(sp.paid_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, t.pay_link_id,
              sp.toward_stay::float AS toward, sp.card_fee::float AS card_fee, sp.landlord_card_fee::float AS landlord_card_fee,
              COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                         WHERE rp.stay_payment_id = sp.id AND ${livePartSql('rp')}), 0)::float AS parts_toward,
              (t.total - COALESCE(t.surcharge, 0))::float AS sale_base,
              COALESCE((SELECT SUM(r.amount - r.card_fee_refunded) FROM pos_refunds r
                         WHERE r.transaction_id = t.id AND r.stay_refund_part_id IS NULL AND r.reversed_at IS NULL), 0)::float AS other_refunds,
              COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                         WHERE rp.pos_transaction_id = t.id AND ${livePartSql('rp')}), 0)::float AS sale_parts
         FROM stay_payments sp
         LEFT JOIN pos_transactions t ON t.id = sp.pos_transaction_id
        WHERE sp.booking_id = $1 AND (t.id IS NULL OR t.status <> 'voided')
        ORDER BY sp.paid_at DESC, sp.created_at DESC, sp.id DESC`, [lease.source_booking_id])).rows
    for (const r of stay) {
      // What can still go back to it: what it put toward the stay less what
      // already went back from it, and never more than its sale has left.
      const own = round2(r.toward - r.parts_toward)
      const saleLeft = r.pos_transaction_id ? round2(r.sale_base - r.other_refunds - r.sale_parts) : own
      const room = round2(Math.max(0, Math.min(own, saleLeft)))
      out.push({
        remittance_id: null, method: r.method, intent: r.intent ?? null, status: 'settled', at: r.at,
        cap: room, amount: r.toward, tenant_fee: 0, alloc_fee: null, fee_payer: null, parts_toward: 0,
        stay: {
          stayPaymentId: r.id, posTransactionId: r.pos_transaction_id ?? null,
          where: r.kind === 'site_deposit' ? 'booking site deposit' : r.pay_link_id ? 'pay link' : 'register',
          feeRate: r.toward > 0 ? r.card_fee / r.toward : 0,
          landlordFeeRate: r.toward > 0 ? r.landlord_card_fee / r.toward : 0,
        },
      })
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** How a payment is named on the screen. */
function kindOf(f: Funding): { kind: StayRefundPartKind | 'unrecorded'; how: string } {
  if (f.credit) return { kind: 'credit', how: f.credit === 'paid_ahead' ? 'Money paid ahead' : 'Account credit' }
  const stripe = !!f.intent && f.status === 'settled'
  const at = f.stay ? ` · ${f.stay.where}` : ''
  if (f.method === 'card_on_file') return stripe ? { kind: 'card', how: `Card on file${at}` } : { kind: 'unrecorded', how: `Card on file${at}` }
  if (f.method === 'charge') return { kind: 'charge', how: `Charge account${at}` }
  if (f.stay) {
    if (f.method === 'card') return stripe ? { kind: 'card', how: `Card${at}` } : { kind: 'unrecorded', how: `Card${at}` }
    if (f.method === 'check') return { kind: 'check', how: `Check${at}` }
    return { kind: 'cash', how: `Cash${at}` }
  }
  if (f.method === 'card') return stripe ? { kind: 'card', how: 'Card' } : { kind: 'unrecorded', how: 'Card' }
  if (f.method === 'ach') return stripe ? { kind: 'bank', how: 'Bank payment' } : { kind: 'cash', how: 'Bank deposit' }
  if (f.method === 'money_order') return { kind: 'money_order', how: 'Money order' }
  if (f.method === 'check') return { kind: 'check', how: 'Check' }
  return { kind: 'cash', how: 'Cash' }
}

/**
 * #38 Q4 for paid-ahead money GAM still holds: the tenant gets back all of it
 * and the card fee they paid on it (cardRefundTerms worked those out). The
 * money itself comes out of what GAM holds for them — the landlord was never
 * paid it — so the landlord's payout drops only by the card fee given back;
 * their cost is that fee plus any fee they had covered on it (cardRefundTerms'
 * landlordCost). Money the landlord was already paid (rent banked when a stay
 * was shortened) keeps cardRefundTerms' figures unchanged.
 */
function gamHeldTerms(p: PlannedPart): PlannedPart {
  if (p.kind !== 'card' && p.kind !== 'bank') return p
  return { ...p, payoutDrop: p.cardFeeBack }
}

async function buildCtx(q: Q, leaseId: string, lock: boolean): Promise<Ctx> {
  const lease = await loadLease(q, leaseId)
  if (!lease) throw new AppError(404, 'That lease is not on this account any more — go back to Leases and open it again.')
  const credits = await loadCredits(q, leaseId, lock)
  // Paid-ahead money a long stay's check-out already asked the refund question
  // about, and that question was answered: no refund is offered again.
  const { STAY_SHORTENED_CREDIT_NOTE } = await import('./bookingLeaseBilling')
  const answered = (await q.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM stay_checkout_decisions
      WHERE lease_id = $1 AND status = 'decided' AND question = 'overpaid'`, [leaseId])).rows[0].n > 0
  const answeredCreditIds = new Set(answered
    ? credits.filter((c) => c.funded_by === 'reclassified' && c.note === STAY_SHORTENED_CREDIT_NOTE).map((c) => c.id)
    : [])

  const sources: MoneySource[] = []
  const sourceCredit = new Map<string, { creditId: string; gamHeld: boolean; creditBack?: 'issued' | 'paid_ahead' }>()
  const { remittanceFeeOf, gamFeeOnRemittance } = await import('./stripeCosts')
  // What of each payment earlier credits in this list already take (a payment can fund more than one).
  const usedOf = new Map<string, number>()
  for (const c of credits) {
    if (answeredCreditIds.has(c.id)) continue
    let left = toCents(c.usable)
    const funding = await fundingOf(q, c, lease)
    for (const f of funding) {
      if (left <= 0) break
      const { kind, how } = kindOf(f)
      const fk = f.remittance_id ?? (f.stay ? `stay:${f.stay.stayPaymentId}` : `credit:${c.source_payment_id}:${f.credit ?? ''}`)
      const room = toCents(f.cap) - toCents(f.parts_toward) - (usedOf.get(fk) ?? 0)
      const take = Math.max(0, Math.min(left, room))
      if (take <= 0) continue
      usedOf.set(fk, (usedOf.get(fk) ?? 0) + take)
      left -= take
      const stripe = kind === 'card' || kind === 'bank'
      const fee = stripe && !f.stay ? gamFeeOnRemittance(remittanceFeeOf({ ...f, payment_method: f.method })) : { tenantBorne: 0, landlordBorne: 0 }
      const key = `${c.id}:${fk}`
      sources.push({
        key, kind, label: `${how} · ${shortDay(f.at, lease.timezone)}`,
        toward: round2(take / 100), paid: round2(take / 100), refundable: kind === 'unrecorded' ? 0 : round2(take / 100),
        paidAt: new Date(f.at).toISOString(),
        feeRate: !stripe ? 0 : f.stay ? f.stay.feeRate : f.amount > 0 ? fee.tenantBorne / f.amount : 0,
        landlordFeeRate: !stripe ? 0 : f.stay ? f.stay.landlordFeeRate : f.amount > 0 ? fee.landlordBorne / f.amount : 0,
        taxRate: 0,
        stayPaymentId: f.stay?.stayPaymentId ?? null, posTransactionId: f.stay?.posTransactionId ?? null, remittanceId: f.remittance_id,
        paymentIntentId: stripe ? f.intent : null, method: f.method ?? 'cash',
      })
      sourceCredit.set(key, { creditId: c.id, gamHeld: c.gam_held, ...(f.credit ? { creditBack: f.credit } : {}) })
    }
    if (left > 0) {
      // No payment on record for the rest: money the landlord holds goes back
      // from them by hand; money GAM holds with no payment to send it back to
      // is not refundable here (Keep it or Leave it as their credit only).
      const key = `${c.id}:none`
      const landlordHeld = !c.gam_held
      sources.push({
        key, kind: landlordHeld ? 'cash' : 'unrecorded',
        label: landlordHeld ? `Paid ahead ${shortDay(c.received_at, lease.timezone)} (no payment on file)` : `Paid ahead ${shortDay(c.received_at, lease.timezone)} — no payment on file to send it back to`,
        toward: round2(left / 100), paid: round2(left / 100), refundable: landlordHeld ? round2(left / 100) : 0,
        paidAt: new Date(c.received_at).toISOString(), feeRate: 0, landlordFeeRate: 0, taxRate: 0,
        stayPaymentId: null, posTransactionId: null, remittanceId: null, paymentIntentId: null, method: landlordHeld ? 'cash' : 'unrecorded',
      })
      sourceCredit.set(key, { creditId: c.id, gamHeld: c.gam_held })
    }
  }
  // Each payment back to itself, most recent first (#38 Q3).
  sources.sort((a, b) => (a.paidAt < b.paidAt ? 1 : a.paidAt > b.paidAt ? -1 : 0))
  const left = round2(credits.reduce((a, c) => a + c.usable, 0))
  return { lease, credits, sources, sourceCredit, answeredCreditIds, left }
}

/** A tenant's own deposit into the landlord's bank (ACH with no Stripe payment): the landlord gives it back, not "cash". */
const isBankDeposit = (kind: string, method: string | null | undefined) => kind === 'cash' && method === 'ach'
const bankDepositWords = (amount: number, label: string) => `Give back ${money(amount)} — they paid by bank deposit (${label})`
/** A refund of money that was paid with money paid ahead: it stays theirs as money paid ahead (pass 3, #46.1a). */
const paidAheadBackWords = (amount: number) => `${money(amount)} stays theirs as money paid ahead (the way it was paid) — it pays their bills with you if they rent again`

/**
 * Choice46e (review): money given back at the desk (cash, a check, a money
 * order, a bank deposit), as the choices and the preview say it BEFORE the
 * press — what will happen, never an order. "Hand back $X in cash now." is
 * said only in the reply to the press (deskOrder): a worker who handed the
 * money over on reading the option, and then met a 409 (someone else just
 * decided, or the figures changed), would have given away cash the landlord
 * kept.
 */
function deskPlanWords(p: { kind: StayRefundPartKind; amount: number; label: string; method: string | null }): string | null {
  const amt = money(p.amount)
  if (isBankDeposit(p.kind, p.method)) return `${amt} for you to give back — they paid by bank deposit (${p.label}); you are told to give it back after you confirm`
  if (p.kind === 'cash') return `${amt} back in cash at the desk — you are told to hand it over after you confirm`
  if (p.kind === 'check') return `${amt} back at the desk — they paid by check (${p.label}); you are told to give it back after you confirm`
  if (p.kind === 'money_order') return `${amt} back at the desk — they paid by money order (${p.label}); you are told to give it back after you confirm`
  return null
}

/** The refund of `amount`, split across the payments it goes back to, with GAM-held money's payout figures. */
function planFor(ctx: Ctx, amount: number): PlannedPart[] {
  return planRefund(ctx.sources, amount)
    .map((p) => (ctx.sourceCredit.get(p.source.key)?.gamHeld ? gamHeldTerms(p) : p))
    .map((p) => {
      const w = deskPlanWords({ kind: p.kind, amount: p.amount, label: p.source.label, method: p.source.method ?? null })
      return w ? { ...p, words: w } : p
    })
    // Money paid ahead that paid it goes back as money paid ahead: it stays theirs (pass 3).
    .map((p) => (ctx.sourceCredit.get(p.source.key)?.creditBack === 'paid_ahead' ? { ...p, words: paidAheadBackWords(p.amount) } : p))
}

/**
 * The landlord's exact cost of the card and bank parts, before they confirm
 * (#38 Q4, GAM absorbs nothing). Money the landlord was already paid keeps
 * earlyCheckOut.landlordCostWords as it is. Money GAM still holds for the
 * tenant was never paid to the landlord, so "more than you were paid" would be
 * wrong there (review fix pass 3): the payout drops only by the card fee they
 * get back, and a fee the landlord covered when the tenant paid is said as not
 * given back.
 */
function costWordsFor(ctx: Ctx, parts: readonly PlannedPart[]): string | null {
  const card = parts.filter((p) => p.kind === 'card' || p.kind === 'bank')
  const gam = card.filter((p) => ctx.sourceCredit.get(p.source.key)?.gamHeld)
  const theirs = card.filter((p) => !ctx.sourceCredit.get(p.source.key)?.gamHeld)
  if (!gam.length) return landlordCostWords(parts, 'lease')
  const sum = (xs: readonly PlannedPart[], f: (p: PlannedPart) => number) => round2(xs.reduce((a, p) => a + f(p), 0))
  const drop = sum(card, (p) => p.payoutDrop)
  const theirsMore = sum(theirs, (p) => p.landlordCost)
  const covered = sum(gam, (p) => Math.max(0, p.landlordCost - p.cardFeeBack))
  let w = `Stripe keeps its processing fee on a refund, and that is your cost: your next payout drops by ${money(drop)}`
  w += theirs.length
    ? ` — ${money(sum(gam, (p) => p.payoutDrop))} of it is the card fee they get back on money GAM holds for them`
    : ' — the card fee they get back; the refund itself comes out of the money GAM holds for them, which was never paid to you'
  if (theirsMore > 0.005) w += `, and ${money(theirsMore)} is more than you were paid for the rest`
  if (covered > 0.005) w += `. The ${money(covered)} fee you covered when they paid is not given back`
  return `${w}.`
}

// ─── The view ────────────────────────────────────────────────────────────────

export interface PartLine {
  id: string; kind: StayRefundPartKind; label: string; amount: number; status: string; words: string; failure: string | null
  /** A card or bank refund still "sending" after 10 minutes (a crash between the decision and Stripe). */
  stale: boolean
  /**
   * Choice46c: a card or bank refund that did not go out and still needs
   * someone (failed, or still "sending" after 10 minutes) — shown on its own
   * line with what to do. Never one a dispute or return already took back
   * (PAID_AHEAD_PART_TAKEN_BACK: nothing is left to do for it).
   */
  attention: boolean
  /**
   * Choice46c: Try again can send it (the server decides). False when it never
   * can — its register sale was already refunded at the register, or the
   * payment it came from was disputed or returned by the bank (the card
   * company or bank takes no refund) — and then a retry is refused (409) and
   * the line (failure) says what to do instead.
   */
  retry: boolean
  /** A card or bank refund that did not go out: also offered "Give it back in cash instead" (givePaidAheadPartBackInCash). */
  cashInstead: boolean
  /**
   * Choice46c (review): a refund still "sending" whose payment was disputed
   * or returned since — it is being stopped (the next look stops it, then
   * offers cash). The page offers "Check again", which looks again in place.
   */
  checkAgain: boolean
  /**
   * Choice46c fix pass 3: the refund already went to the card or bank, and
   * only GAM's record of it is missing — Try again only records it (nothing
   * is sent again), so the page names the press "Recording…", never "Sending…".
   */
  recordOnly: boolean
  /**
   * Choice46d: the part this one took the place of (cash handed back instead
   * of a card or bank refund, a refund Stripe sent back, the rest of a refund a
   * dispute covered in part) — so a press whose answer was lost can tell, on
   * the next look, what became of the part it pressed.
   */
  replacesPartId: string | null
  /**
   * Choice46d fix pass 3: cash handed back instead of a card or bank refund,
   * said for a press whose answer the page never got (a lost answer, or a
   * "being worked on" 409 while another press recorded it) — never an
   * unconditional order: when it was recorded and by whom (by you: hand it
   * back now if you have not; someone else: ask them first), then what was
   * recorded; or, when a dispute had already given that money back, "Do not
   * hand this back". null on every other part.
   */
  cashReply: string[] | null
  /** Which cashReply lines are an order to the person reading (the gold box): only "by you". */
  cashReplyHandBack: boolean[] | null
}

export interface ChoiceSummary {
  id: string
  refundChoice: PaidAheadRefundChoice
  refundChoiceLabel: string
  restChoice: PaidAheadRestChoice | null
  restChoiceLabel: string | null
  leftAmount: number
  refundTotal: number
  restAmount: number
  releasedAmount: number
  /** Of restAmount left as their credit, what GAM keeps holding for them (decisions #46.1a). */
  leftGamHeld: number
  decidedBy: string | null
  decidedAt: string
  /** When it was decided, on the property's own clock ("October 4, 2026 at 6:30 PM") — the day every other line names. */
  decidedOn: string
  parts: PartLine[]
  /** The decision as a record (past tense). The reply to the press itself carries its own words (DecideChoiceResult.words). */
  words: string[]
}

export interface RefundOption {
  choice: PaidAheadRefundChoice
  label: string
  result: string
  /**
   * What this refund sends back, its exact cost, and what is left after it
   * with the choices for that rest (review fix pass 3: "Refund all that can go
   * back" names its own rest here, never the whole amount's).
   */
  refund?: {
    amount: number; parts: Array<{ kind: StayRefundPartKind; label: string; amount: number; words: string }>; cost: string | null
    rest: number; restOptions: RestOption[]
  }
}

export interface RestOption { choice: PaidAheadRestChoice; label: string; result: string }

export interface PaidAheadView {
  leaseId: string
  unit: { id: string; number: string }
  property: { id: string; name: string }
  tenants: Array<{ id: string; name: string }>
  leaseStatus: string
  endedOn: string | null
  ended: boolean
  left: number
  credits: CreditLine[]
  sources: SourceLine[]
  maxRefund: number
  /** Paid-ahead money a stay's check-out already answered the refund question for. */
  refundAnswered: number
  /** Why some (or all) of the money cannot be refunded from here — each said once; Keep it / Leave it as their credit still apply. */
  refundNotes: string[]
  owedOnLease: number
  /** Why nothing can be decided here right now, and where to go instead. */
  waits: { words: string; href: string | null; linkLabel: string | null } | null
  refundOptions: RefundOption[]
  /** The choices for what is not refunded, for "No refund" (the whole amount left); a refund's own rest is on its option, or in the preview. */
  restOptions: RestOption[]
  latest: ChoiceSummary | null
  quoteToken: string
}

/**
 * Who holds money left as the tenant's credit, in words (decisions #46.1a):
 * GAM keeps holding what it holds until it pays one of their bills; the
 * landlord holds the rest for them.
 */
function heldForThemWords(gamHeld: number, landlordHeld: number, tense: 'will' | 'now'): string {
  const g = gamHeld > 0.005
  const l = landlordHeld > 0.005
  const gam = (amt: string) => tense === 'will'
    ? ` GAM keeps holding ${amt} for them and pays it to you only when it pays one of their bills.`
    : ` GAM keeps holding ${amt} for them and pays it to you when it pays one of their bills.`
  if (g && l) return gam(`the ${money(gamHeld)} it holds`) + ` You hold the other ${money(landlordHeld)} for them.`
  if (g) return gam('it')
  if (l) return tense === 'will' ? ' You already have it, and you hold it for them.' : ' You hold it for them.'
  return ''
}

function restOptionsFor(rest: number, gamHeldRest: number): RestOption[] {
  if (rest <= 0.005) return []
  const ll = round2(rest - gamHeldRest)
  return [
    { choice: 'keep', label: PAID_AHEAD_REST_CHOICE_LABEL.keep,
      result: gamHeldRest > 0.005
        ? `${money(rest)} becomes your money — ${money(gamHeldRest)} that GAM holds is added to your next payout`
          + (ll > 0.005 ? `, and the ${money(ll)} you already have is recorded as yours` : '')
        : `${money(rest)} becomes your money — you already have it, so it is recorded as yours` },
    { choice: 'credit', label: PAID_AHEAD_REST_CHOICE_LABEL.credit,
      result: `${money(rest)} stays theirs as money paid ahead — if they rent from you again it pays their bills there, and it cannot be taken back later.`
        + heldForThemWords(gamHeldRest, ll, 'will') },
  ]
}

/** What GAM holds of what is left after a refund of `refund` (the refund draws its own payments' credits first). */
function gamHeldRestAfter(ctx: Ctx, plan: readonly PlannedPart[]): number {
  const taken = new Map<string, number>()
  for (const p of plan) {
    const c = ctx.sourceCredit.get(p.source.key)
    if (c) taken.set(c.creditId, (taken.get(c.creditId) ?? 0) + toCents(p.toward))
  }
  return round2(ctx.credits.reduce((a, c) => a + (c.gam_held ? Math.max(0, toCents(c.usable) - (taken.get(c.id) ?? 0)) : 0), 0) / 100)
}

/** The page's button for handing a refund back at the desk instead (named in words only in quotes, as a button). */
const CASH_BUTTON = 'Give it back in cash instead'
/** What the cash press does first, said wherever it is offered: never an order to hand cash over before it. */
const cashChecksWords = (where: string) => `GAM first checks that it did not reach ${where}, then tells you when to hand the cash over`

/** How the payment a part came from was taken back, in words. */
const takenBackBy = (kind: string) => (kind === 'bank' ? 'returned by their bank' : 'disputed with their card company')

/**
 * Choice46c: why a card or bank refund that did not go out can never be sent
 * (null: Try again can send it) — said to the person reading the screen, with
 * what to do instead.
 */
function cannotSend(r: any): string | null {
  const where = r.kind === 'bank' ? 'their bank' : 'the card'
  // The refund already went out; Try again only records it (it finds the
  // refund at Stripe and sends nothing) — whatever happened to the payment since.
  if (r.status === 'failed' && refundWentOutUnrecorded(r.failure)) return null
  if (r.status === 'failed' && noSaleRoom(r)) {
    return `Nothing was sent to ${where}: this sale was already refunded at the register, so only ${money(Math.max(0, Number(r.sale_room)))} is left on it. `
      + 'Check at the register what the tenant got back before giving anything more.'
  }
  // Choice46d (review): never an order to hand cash over before GAM has
  // checked the card — the press comes first, and only its answer says when.
  if (r.funding_disputed && r.status === 'pending') {
    // Not stopped yet (a send held its lock at that moment): the next look stops it, then offers cash.
    return `${money(Number(r.amount))} to ${where} is being stopped: the payment it came from was ${takenBackBy(r.kind)}, so ${r.kind === 'bank' ? 'their bank' : 'the card company'} will not take a refund. `
      + `Press Check again in a moment; then "${CASH_BUTTON}" is offered (GAM tells you when to hand the cash over).`
  }
  if (r.funding_disputed) {
    return `${money(Number(r.amount))} cannot go back to ${where}: the payment it came from was ${takenBackBy(r.kind)}, so ${r.kind === 'bank' ? 'their bank' : 'the card company'} will not take a refund. `
      + `Press "${CASH_BUTTON}" (${cashChecksWords(where)}).`
  }
  return null
}

/**
 * Choice46d (review): what a card or bank refund that did not go out says on
 * this screen, in its own words. earlyCheckOut's failure text ends with its
 * own ways out ("…press Try again, or hand it back in cash and press …"),
 * which would have a worker hand cash over BEFORE GAM has checked the refund
 * did not reach the card after all — so only its reason is kept, with the
 * amount (two parts are told apart), and this screen says the rest: the cash
 * press comes first, and only its answer says to hand the cash over.
 */
function screenFailure(r: any, amt: string, where: string, cash: boolean): string {
  const raw = String(r.failure ?? '')
  const cut = raw.startsWith('Not sent:') ? ''
    : raw.replace(/\s*—\s*(press Try again|hand it back|open the|wait)[\s\S]*$/i, '').replace(/[.\s]+$/, '').trim()
  // A reason that still names cash or a hand-back is never shown (it could read as an order).
  const reason = /cash|hand/i.test(cut) ? '' : cut
  const lead = reason ? `${reason} (${amt})` : `${amt} could not be refunded to ${where} yet`
  return cash
    ? `${lead} — press Try again, or press "${CASH_BUTTON}" (${cashChecksWords(where)}).`
    : `${lead} — press Try again.`
}

function partLine(r: any, who: { viewerId?: string | null; tz?: string | null } = {}): PartLine {
  const where = r.kind === 'bank' ? 'their bank' : 'the card'
  const stale = r.status === 'pending' && !!r.stale
  const amt = money(Number(r.amount))
  const stripe = r.kind === 'card' || r.kind === 'bank'
  // Choice46c: a dispute or return took this money back before it went out (creditUse.recoverChoiceMoney).
  const takenBack = stripe && r.status === 'failed' && r.failure === PAID_AHEAD_PART_TAKEN_BACK
  // Review fix (choice46c): still "sending", but its payment was disputed or
  // returned since — being stopped (never a cash order with no button).
  const stopping = stripe && r.status === 'pending' && !!r.funding_disputed
  const attention = stripe && (r.status === 'failed' || stale || stopping) && !takenBack
  const never = attention ? cannotSend(r) : null
  // Stopped for a dispute that has since been won (the payment can take a
  // refund again): the stored "give it back in cash" reason no longer holds,
  // so the line says the ordinary words beside its Try again.
  const disputeOver = r.failure === CANNOT_GO_WORDS && !r.funding_disputed
  // Review fix (choice46c pass 3): the refund reached the card or bank and only
  // GAM's record is missing — the line leads with its amount (two parts are
  // told apart), and says Try again sends nothing again.
  const unrecorded = stripe && r.status === 'failed' && refundWentOutUnrecorded(r.failure)
  return {
    id: r.id, kind: r.kind, label: r.label, amount: Number(r.amount), status: r.status, stale, attention,
    retry: attention && !never,
    // What to do, said to whoever reads it (never "ask the owner" on the owner's own screen).
    failure: takenBack || disputeOver ? null
      : unrecorded ? `${amt} went back to ${where}, but GAM could not finish recording it — press Try again to record it (nothing is sent again).`
      : never ? never
      // Choice46d: never earlyCheckOut's own "hand it back in cash and press …" words.
      : attention && r.status === 'failed' && r.failure ? screenFailure(r, amt, where, canGiveInCash(r))
      : null,
    // Review fix (choice46b): offered on every lease — a stay behind it or not.
    cashInstead: canGiveInCash(r),
    checkAgain: attention && stopping,
    recordOnly: attention && unrecorded,
    replacesPartId: r.replaces_part_id ?? null,
    ...cashReplyOf(r, who),
    words: takenBack
      ? `${amt} was not sent to ${where} — the payment it came from was ${takenBackBy(r.kind)}, so that money already went back to them. Nothing more goes back`
      : unrecorded ? `${amt} went back to ${where} — GAM has to finish recording it`
      : r.status === 'failed' && noSaleRoom(r)
      ? `${amt} was not sent to ${where} — that sale was already refunded at the register`
      : stopping ? `${amt} to ${where} is being stopped — the payment it came from was ${takenBackBy(r.kind)}`
      : attention && r.funding_disputed
        ? `${amt} could not go back to ${where} — the payment it came from was ${takenBackBy(r.kind)}`
      : r.status === 'failed' ? `${amt} could not be refunded to ${where} yet — press Try again`
      : stale ? `${amt} to ${where} has not gone out yet — press Try again`
      : r.status === 'pending' ? `${amt} to ${where} — sending now`
      : r.status === 'handed_back'
        ? (!r.replaces_part_id && isBankDeposit(r.kind, r.method) ? `${amt} given back — they paid by bank deposit (${r.label})`
          // Choice46d fix pass 3: recorded for money a dispute had already given back — never "handed back" as if it were due.
          : r.kind === 'cash' && r.blocked && (r.replaces_kind === 'card' || r.replaces_kind === 'bank')
            ? `${amt} was recorded as handed back in cash instead of to the ${r.replaces_kind === 'bank' ? 'bank' : 'card'}, but the payment it came from had already been ${takenBackBy(r.replaces_kind)} — that money already went back to them, and GAM has been told`
          // Choice46e (review): as RECORDED, by whom and when — the press's answer may have been lost, and someone
          // looking from another screen must not read "handed back" as a fact (the cash may still be in the drawer).
          : r.kind === 'cash' && (r.replaces_kind === 'card' || r.replaces_kind === 'bank')
            ? `${amt} recorded as handed back in cash instead of to the ${r.replaces_kind === 'bank' ? 'bank' : 'card'}`
              + `${r.recorded_by_name ? ` by ${r.recorded_by_name}` : ''}${r.created_at ? ` on ${longWhen(r.created_at, who.tz ?? null)}` : ''}`
          : r.kind === 'cash' ? `${amt} handed back in cash`
          : `${amt} given back — they paid by ${r.kind === 'money_order' ? 'money order' : 'check'} (${r.label})`)
      : r.status === 'credited'
        // Money paid ahead refunded back to money paid ahead stays on its credit (no spend): pass 3.
        ? (r.spent === false ? `${amt} stays theirs as money paid ahead` : `${amt} back to their account credit`)
      : partWords({ kind: r.kind, amount: Number(r.amount), label: r.label }) + (r.kind === 'card' || r.kind === 'bank' ? ' — sent' : ''),
  }
}

/** A card or bank refund that did not go out and still needs someone (PartLine.attention). */
export const needsAttention = (p: Pick<PartLine, 'attention'>): boolean => p.attention

/**
 * The words for money given back at the desk as the press that decided it
 * says them — an order to the worker standing there ("Hand back $40.00 in
 * cash now."). Only the reply to that press says it (finish, fresh); the
 * decision's own record and every later visit say it in the past tense, so a
 * worker opening the page again never reads it as cash still owed (review
 * fix, choice46b).
 */
function deskOrder(r: any): string | null {
  if (r.status !== 'handed_back' || r.replaces_part_id) return null
  const amt = money(Number(r.amount))
  if (isBankDeposit(r.kind, r.method)) return `${bankDepositWords(Number(r.amount), r.label)}.`
  if (r.kind === 'cash') return `Hand back ${amt} in cash now.`
  return `${partWords({ kind: r.kind, amount: Number(r.amount), label: r.label })}.`
}

/**
 * Choice46d (review): what the reply to "Give it back in cash instead" leads
 * with once GAM has checked the refund did not go out — the order, then what
 * was recorded (and what GAM pays the landlord for it, when it held the
 * money). One place, so a lost answer read again from the next look says it
 * exactly as the reply did.
 */
function cashPressWords(replacedKind: string, amount: number, released: number): string[] {
  return [`Hand back ${money(amount)} in cash now.`,
    `It is recorded as given back — nothing goes to the ${replacedKind === 'bank' ? 'bank' : 'card'}.`
      + (released > 0.005 ? ` The ${money(released)} GAM held for them is added to your next payout.` : '')]
}

/**
 * Choice46d fix pass 3: cash recorded as handed back instead of a card or bank
 * refund, said to someone who did not get the press's own reply — never an
 * unconditional order (the cash may already be in the tenant's hand): when it
 * was recorded and by whom. Recorded by the person reading: hand it back now
 * if you have not (the gold box); by someone else: ask them before giving
 * anything; by nobody GAM can name: ask the team first. Then what was
 * recorded. `already`: the reply to pressing it again.
 */
function recordedCashWords(
  r: { amount: number; replacedKind: string; at: Date | string; byId: string | null; byName: string | null; released: number; tz: string | null },
  viewerId: string | null | undefined, already: boolean,
): { words: string[]; handBack: boolean[] } {
  const amt = money(r.amount)
  const where = r.replacedKind === 'bank' ? 'their bank' : 'the card'
  const when = longWhen(r.at, r.tz)
  const lead = `This was ${already ? 'already ' : ''}recorded as given back in cash (${amt})`
  const checked = `GAM checked first that it did not reach ${where}.`
  const after = cashPressWords(r.replacedKind, r.amount, r.released)[1]
  if (viewerId && r.byId === viewerId) {
    return { words: [`${lead} by you at ${when} — ${checked} If you have not handed that ${amt} over yet, hand it back in cash now; if you have, give nothing more.`, after],
             handBack: [true, false] }
  }
  if (r.byName) {
    return { words: [`${lead} by ${r.byName} at ${when} — ${checked} Ask ${r.byName} whether it was handed over before giving anything.`, after],
             handBack: [false, false] }
  }
  return { words: [`${lead} at ${when} — ${checked} Ask your team whether it was already handed over before giving anything; if nobody has, hand it back in cash now.`, after],
           handBack: [false, false] }
}

/** Choice46d fix pass 3: cash recorded for money a dispute or bank return had already given back — never handed over. */
const blockedCashWords = (replacedKind: string, amount: number, now: boolean): string =>
  `Do not hand ${now ? 'anything' : `this ${money(amount)}`} back — the payment ${now ? `this ${money(amount)}` : 'it'} came from was ${takenBackBy(replacedKind)}${now ? ' a moment ago' : ''}, `
  + 'so that money already went back to them. GAM has been told the record needs correcting.'

/** PartLine.cashReply / cashReplyHandBack for one part row (see recordedCashWords). */
function cashReplyOf(r: any, who: { viewerId?: string | null; tz?: string | null }): Pick<PartLine, 'cashReply' | 'cashReplyHandBack'> {
  if (!(r.status === 'handed_back' && r.kind === 'cash' && (r.replaces_kind === 'card' || r.replaces_kind === 'bank'))) {
    return { cashReply: null, cashReplyHandBack: null }
  }
  if (r.blocked) return { cashReply: [blockedCashWords(r.replaces_kind, Number(r.amount), false)], cashReplyHandBack: [false] }
  const said = recordedCashWords({
    amount: Number(r.amount), replacedKind: r.replaces_kind, at: r.created_at ?? r.refunded_at ?? new Date(),
    byId: r.recorded_by ?? null, byName: r.recorded_by_name ?? null, released: Number(r.released ?? 0), tz: who.tz ?? null,
  }, who.viewerId, false)
  return { cashReply: said.words, cashReplyHandBack: said.handBack }
}

/** An instant as "October 4, 2026 at 6:30 PM" on the property's own clock (never the browser's). */
const longWhen = (iso: Date | string, tz: string | null): string =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: tz || 'America/Phoenix', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })

/**
 * One line of a decision: its part (null: the rest), as the record says it,
 * and as the press that decided it says it — `order` when that fresh line is
 * money to give back at the desk now (cash, a check, a money order, a bank
 * deposit), which the page draws in the gold box wherever it falls.
 */
interface SummaryLine { partId: string | null; past: string; fresh: string; order: boolean }
interface SummaryParts { summary: ChoiceSummary; lines: SummaryLine[] }

async function summaryOf(q: Q, choiceId: string, viewerId: string | null = null): Promise<SummaryParts | null> {
  const d = (await q.query<any>(
    `SELECT pc.*, pc.left_amount::float AS left_f, pc.refund_total::float AS refund_f, pc.rest_amount::float AS rest_f,
            pc.released_amount::float AS released_f, pc.left_gam_held::float AS left_gam_f, pr.timezone,
            NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS decided_by_name
       FROM paid_ahead_choices pc
       LEFT JOIN users u ON u.id = pc.decided_by
       JOIN leases l ON l.id = pc.lease_id JOIN units un ON un.id = l.unit_id JOIN properties pr ON pr.id = un.property_id
      WHERE pc.id = $1`, [choiceId])).rows[0]
  if (!d) return null
  const rows = (await q.query<any>(
    `SELECT p.id, p.kind, p.label, p.amount::float AS amount, p.status, p.failure, p.booking_id, p.replaces_part_id,
            rr.kind AS replaces_kind, r.payment_method AS method, p.toward_amount::float AS toward,
            COALESCE(${creditGamHeldSql('c')}, FALSE) AS gam_held,
            (p.status = 'pending' AND p.created_at < NOW() - INTERVAL '10 minutes') AS stale,
            EXISTS (SELECT 1 FROM credit_uses k WHERE k.refund_part_id = p.id) AS spent,
            -- What GAM released (or will release) to the landlord for cash handed back instead: never more than it holds.
            CASE WHEN p.kind = 'cash' AND p.replaces_part_id IS NOT NULL AND COALESCE(${creditGamHeldSql('c')}, FALSE)
                 THEN COALESCE((SELECT h.amount FROM held_payout_items h
                                 WHERE h.source_type = 'prepaid_draw' AND h.source_id = 'cash-part:' || p.id::text), ${cashPartReleaseSql('p')})
                 ELSE 0 END::float AS released,
            ${saleRoomSql('p')} AS sale_room, ${fundingTakenBackSql('p.stripe_payment_intent_id')} AS funding_disputed,
            p.created_at, p.refunded_at,
            -- Choice46d fix pass 3: cash recorded for money a dispute had already given back, and who pressed for it.
            (p.kind = 'cash' AND COALESCE(${cashAfterTakenBackSql('p')}, FALSE)) AS blocked,
            rec.user_id AS recorded_by, rec.name AS recorded_by_name
       FROM stay_refund_parts p
       LEFT JOIN tenant_remittances r ON r.id = p.remittance_id
       LEFT JOIN stay_refund_parts rr ON rr.id = p.replaces_part_id
       LEFT JOIN lease_prepaid_credits c ON c.id = p.prepaid_credit_id
       LEFT JOIN LATERAL ${cashPresserSql('p')} rec ON p.kind = 'cash' AND p.replaces_part_id IS NOT NULL
      WHERE p.paid_ahead_choice_id = $1 AND ${livePartSql('p')}
      ORDER BY p.seq, p.created_at`, [choiceId])).rows
  const parts = rows.map((r) => partLine(r, { viewerId, tz: d.timezone }))
  // Choice46d (review): "Nothing more goes back" only when nothing else of
  // this decision still waits to be given back — a split's taken-back part
  // says its own amount only, so the desk never stops at it.
  if (parts.some((p) => p.attention)) {
    rows.forEach((r, i) => {
      if ((r.kind === 'card' || r.kind === 'bank') && r.status === 'failed' && r.failure === PAID_AHEAD_PART_TAKEN_BACK) {
        const amt = money(Number(r.amount))
        parts[i] = { ...parts[i], words: `${amt} was not sent to ${r.kind === 'bank' ? 'their bank' : 'the card'} — the payment it came from was ${takenBackBy(r.kind)}, so that ${amt} already went back to them` }
      }
    })
  }
  const lines: SummaryLine[] = []
  // Money given back at the desk first and plain: in the record it is said
  // in the past tense; the press that decided it says it as an order.
  rows.forEach((r, i) => {
    const p = parts[i]
    if (p.status !== 'handed_back') return
    // Cash handed back instead of a card refund GAM could not send: what GAM held is the landlord's again.
    const past = `${p.words}${p.words.includes('instead of to the') && Number(r.released) > 0.005 ? ` — the ${money(Number(r.released))} GAM held for them is added to your next payout` : ''}.`
    const order = deskOrder(r)
    lines.push({ partId: p.id, past, fresh: order ?? past, order: !!order })
  })
  // A refund that did not go out and still needs someone (failed, or still
  // "sending" after 10 minutes) is said once — on its own line with what to
  // do (needsAttention), never here as well.
  for (const p of parts) if (p.status !== 'handed_back' && !needsAttention(p)) lines.push({ partId: p.id, past: `${p.words}.`, fresh: `${p.words}.`, order: false })
  const restLine = (w: string) => lines.push({ partId: null, past: w, fresh: w, order: false })
  if (d.rest_choice === 'keep') {
    restLine(d.released_f > 0.005
      ? `${money(d.rest_f)} is now your money — ${money(d.released_f)} that GAM held is added to your next payout.`
      : `${money(d.rest_f)} is now your money (you already had it).`)
  } else if (d.rest_choice === 'credit') {
    restLine(`${money(d.rest_f)} stays theirs as money paid ahead — it pays their bills with you if they rent again.`
      + heldForThemWords(d.left_gam_f, round2(d.rest_f - d.left_gam_f), 'now'))
  }
  if (!parts.length && !d.rest_choice) restLine('Nothing was left to decide.')
  const words = lines.map((l) => l.past)
  return {
    lines,
    summary: {
      id: d.id, refundChoice: d.refund_choice,
      // What was pressed, as it was named: "Refund all that can go back" when part of it could not.
      refundChoiceLabel: d.refund_choice === 'refund_all' && d.rest_f > 0.005
        ? PAID_AHEAD_REFUND_ALL_PARTIAL_LABEL : PAID_AHEAD_REFUND_CHOICE_LABEL[d.refund_choice as PaidAheadRefundChoice],
      restChoice: d.rest_choice ?? null, restChoiceLabel: d.rest_choice ? PAID_AHEAD_REST_CHOICE_LABEL[d.rest_choice as PaidAheadRestChoice] : null,
      leftAmount: d.left_f, refundTotal: d.refund_f, restAmount: d.rest_f, releasedAmount: d.released_f, leftGamHeld: d.left_gam_f,
      decidedBy: d.decided_by_name ?? null, decidedAt: new Date(d.decided_at).toISOString(),
      decidedOn: longWhen(d.decided_at, d.timezone), parts, words,
    },
  }
}

async function choiceSummary(q: Q, choiceId: string, viewerId: string | null = null): Promise<ChoiceSummary | null> {
  return (await summaryOf(q, choiceId, viewerId))?.summary ?? null
}

/**
 * Choice46d fix pass 3: the audit action a cash press writes for the cash part
 * it recorded (who pressed), so a later look can name them.
 */
const CASH_PRESS_AUDIT_ACTION = 'paid_ahead_cash_handed_back'

/** SQL (LATERAL), on a stay_refund_parts alias: who pressed for this cash part (user_id, name), from the audit log. */
const cashPresserSql = (p: string) => `(
  SELECT a.user_id, COALESCE(NULLIF(TRIM(CONCAT(us.first_name, ' ', us.last_name)), ''), us.email) AS name
    FROM (SELECT user_id, created_at FROM audit_log WHERE action = '${CASH_PRESS_AUDIT_ACTION}' AND entity_id = ${p}.id
          UNION ALL
          SELECT user_id, created_at FROM audit_log_archive WHERE action = '${CASH_PRESS_AUDIT_ACTION}' AND entity_id = ${p}.id) a
    LEFT JOIN users us ON us.id = a.user_id
   ORDER BY a.created_at LIMIT 1)`

/** What is still owed on the lease (bills the landlord is owed, open). */
async function owedOn(q: Q, leaseId: string): Promise<number> {
  return round2((await q.query<{ s: number }>(
    `SELECT COALESCE(SUM(p.amount), 0)::float AS s FROM payments p
      WHERE p.lease_id = $1 AND p.revenue_owner IN ('landlord', 'held') AND ${payableRowSql('p')}`, [leaseId])).rows[0].s)
}

/** Deposit returns that are done (sent, or sent and then disputed) — the move-out deductions are settled. */
const MOVE_OUT_DONE_SQL = `status IN ('sent_refund', 'sent_gap', 'sent_zero', 'sent_carried_forward', 'disputed')`

/**
 * Why nothing can be decided here right now, and where to go instead (null =
 * the choice is open). In order: a long stay's own check-out money question;
 * a move-out being worked out; a lease that has not ended; and (decisions
 * #46.2) a move-out not done yet while a security deposit is still held or
 * money is still owed — deductions come out of the deposit first and the
 * money paid ahead only covers what the deposit cannot, so the refund choice
 * comes after that, never before.
 */
const MOVE_OUT_FIRST = 'finish the move-out first, then decide it'

/** A wait, and the few words the owner's to-do says for it. */
type Wait = NonNullable<PaidAheadView['waits']> & { todo: string }

async function waitsFor(q: Q, leaseId: string, ended: boolean): Promise<Wait | null> {
  const stay = (await q.query<{ booking_id: string; unit_id: string }>(
    `SELECT d.booking_id, b.unit_id FROM stay_checkout_decisions d JOIN unit_bookings b ON b.id = d.booking_id
      WHERE d.lease_id = $1 AND d.status = 'pending' LIMIT 1`, [leaseId])).rows[0]
  if (stay) {
    return { words: 'This stay\'s early check-out still has its own money question open. Decide it on the schedule first; anything paid ahead that is left after it comes back here.',
      href: `/schedule?checkout=${stay.booking_id}&unit=${stay.unit_id}`, linkLabel: 'Open the stay', todo: 'decide the stay\'s check-out first' }
  }
  // Review fix (choice46b): a payment still going through holds some of this
  // money (a 'held' spend). If it fails, that money comes back here — so the
  // choice waits for it, and is never made twice.
  const inFlight = (await q.query(
    `SELECT 1 FROM credit_uses u JOIN lease_prepaid_credits c ON c.id = u.prepaid_credit_id
      WHERE c.lease_id = $1 AND c.voided_at IS NULL AND NOT ${leftHereSql('c')} AND u.status = 'held' LIMIT 1`, [leaseId])).rows.length > 0
  if (inFlight) {
    return { words: 'A payment using some of this money paid ahead is still going through. Wait for it to finish, then come back here — what is left then is shown to decide.',
      href: null, linkLabel: null, todo: 'wait for a payment using it to finish, then decide it' }
  }
  const depositReturn = `/leases/${leaseId}/deposit-return`
  const moveOut = (await q.query<{ id: string }>(
    `SELECT id FROM deposit_returns WHERE lease_id = $1 AND status IN ('draft', 'awaiting_approval') LIMIT 1`, [leaseId])).rows[0]
  if (moveOut) {
    return { words: 'This lease\'s move-out is still being worked out. Finish the deposit return first — what is paid ahead may be needed for the move-out bill — then come back here.',
      href: depositReturn, linkLabel: 'Open the deposit return', todo: MOVE_OUT_FIRST }
  }
  if (!ended) {
    return { words: 'This lease has not ended, so its money paid ahead still pays its bills. This choice opens once the lease ends.', href: null, linkLabel: null, todo: 'decide it once the lease ends' }
  }
  const done = (await q.query(`SELECT 1 FROM deposit_returns WHERE lease_id = $1 AND ${MOVE_OUT_DONE_SQL} LIMIT 1`, [leaseId])).rows.length > 0
  // Review fix pass 3: a bill added after the move-out was done (a final
  // utility bill) still comes first — the money paid ahead covers what is
  // owed before anything is refunded or kept (#46.2).
  const owed = await owedOn(q, leaseId)
  if (done && owed > 0.005) {
    return { words: `They still owe ${money(owed)} on this lease, billed after the move-out was done. The money paid ahead pays what is owed before anything is refunded or kept — settle that bill on Payments first, then come back here.`,
      href: '/payments', linkLabel: 'Open Payments', todo: 'settle what they still owe first, then decide it' }
  }
  if (done) return null
  const held = round2((await q.query<{ s: number }>(
    `SELECT COALESCE(SUM(collected_amount), 0)::float AS s FROM security_deposits
      WHERE lease_id = $1 AND status NOT IN ('disbursed', 'claimed')`, [leaseId])).rows[0].s)
  if (held > 0.005) {
    return { words: `This lease still has a ${money(held)} security deposit that has not been settled. Do the move-out first — deductions come out of the deposit, and the money paid ahead only covers what the deposit cannot — then come back here.`,
      href: depositReturn, linkLabel: 'Start the deposit return', todo: MOVE_OUT_FIRST }
  }
  if (owed > 0.005) {
    return { words: `They still owe ${money(owed)} on this lease. Do the move-out first — the money paid ahead pays what is owed before anything is refunded or kept — then come back here.`,
      href: depositReturn, linkLabel: 'Start the deposit return', todo: MOVE_OUT_FIRST }
  }
  return null
}

async function isEnded(q: Q, leaseId: string): Promise<boolean> {
  return (await q.query(
    `SELECT 1 FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
      WHERE l.id = $1 AND ${endedLeaseSql('l', 'pr')}`, [leaseId])).rows.length > 0
}

/** The screen: the tenant, the space, the money left and how it was paid, and the choices. */
export async function paidAheadView(q: Q, leaseId: string, opts: { lock?: boolean; viewerId?: string | null } = {}): Promise<PaidAheadView> {
  const ctx = await buildCtx(q, leaseId, !!opts.lock)
  const tenants = (await q.query<{ id: string; name: string }>(
    `SELECT DISTINCT ON (lt.tenant_id) lt.tenant_id AS id,
            COALESCE(NULLIF(TRIM(CONCAT(us.first_name, ' ', us.last_name)), ''), us.email, 'Tenant') AS name
       FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users us ON us.id = t.user_id
      WHERE lt.lease_id = $1 AND lt.status <> 'void'
      ORDER BY lt.tenant_id, (lt.role = 'primary') DESC`, [leaseId])).rows
  const ended = await isEnded(q, leaseId)
  const owed = await owedOn(q, leaseId)
  const latestId = (await q.query<{ id: string }>(
    `SELECT id FROM paid_ahead_choices WHERE lease_id = $1 ORDER BY decided_at DESC, id DESC LIMIT 1`, [leaseId])).rows[0]?.id
  const latest = latestId ? await choiceSummary(q, latestId, opts.viewerId ?? null) : null
  // Nothing left = nothing waits (the decision, if any, is shown instead).
  const wait = ctx.left > 0.005 ? await waitsFor(q, leaseId, ended) : null
  const waits: PaidAheadView['waits'] = wait ? { words: wait.words, href: wait.href, linkLabel: wait.linkLabel } : null

  const maxRefund = round2(ctx.sources.reduce((a, s) => a + s.refundable, 0))
  const refundAnswered = round2(ctx.credits.filter((c) => ctx.answeredCreditIds.has(c.id)).reduce((a, c) => a + c.usable, 0))
  const refundOptions: RefundOption[] = []
  let restOptions: RestOption[] = []
  // Why some of it cannot be refunded from here — said once, in plain words.
  const refundNotes: string[] = []
  if (refundAnswered > 0.005) {
    refundNotes.push(`${money(refundAnswered)} is rent paid past the day they left. The check-out already asked about a refund for it, so it is not offered again — you still choose whether to keep it or leave it as their credit.`)
  }
  const noPayment = round2(ctx.sources.filter((src) => src.kind === 'unrecorded').reduce((a, src) => a + src.toward, 0))
  if (noPayment > 0.005) {
    refundNotes.push(`${money(noPayment)} has no payment GAM can send it back to, so it cannot be refunded from here. You can keep it or leave it as their credit.`)
  }
  if (!waits && ctx.left > 0.005) {
    restOptions = restOptionsFor(ctx.left, gamHeldRestAfter(ctx, []))
    refundOptions.push({ choice: 'no_refund', label: PAID_AHEAD_REFUND_CHOICE_LABEL.no_refund,
      result: `Nothing goes back. You choose next what happens to the ${money(ctx.left)}.` })
    if (maxRefund > 0.005) {
      const parts = planFor(ctx, maxRefund)
      const all = maxRefund >= ctx.left - 0.005
      const restAfter = all ? 0 : round2(ctx.left - maxRefund)
      refundOptions.push({
        choice: 'refund_all',
        label: `${all ? PAID_AHEAD_REFUND_CHOICE_LABEL.refund_all : PAID_AHEAD_REFUND_ALL_PARTIAL_LABEL} (${money(maxRefund)})`,
        result: parts.map((p) => p.words).join(' + ') + (all ? '' : `. You choose next what happens to the other ${money(restAfter)}.`),
        refund: { amount: maxRefund, cost: costWordsFor(ctx, parts),
          parts: parts.map((p) => ({ kind: p.kind, label: p.source.label, amount: p.amount, words: p.words })),
          rest: restAfter, restOptions: restOptionsFor(restAfter, gamHeldRestAfter(ctx, parts)) },
      })
      refundOptions.push({ choice: 'refund_other', label: PAID_AHEAD_REFUND_CHOICE_LABEL.refund_other,
        result: `Type any amount up to ${money(maxRefund)}. You choose next what happens to the rest.` })
    }
  }

  const token = crypto.createHash('sha256').update(JSON.stringify([
    ctx.credits.map((c) => [c.id, c.usable]), ctx.sources.map((s) => [s.key, s.refundable]),
    waits?.words ?? null, ended, latestId ?? null,
  ])).digest('hex').slice(0, 32)

  return {
    leaseId, unit: { id: ctx.lease.unit_id, number: ctx.lease.unit_number },
    property: { id: ctx.lease.property_id, name: ctx.lease.property_name },
    tenants, leaseStatus: ctx.lease.status, endedOn: ctx.lease.end_date, ended,
    left: ctx.left,
    credits: ctx.credits.map((c) => ({
      id: c.id, amount: c.usable, receivedOn: dateIn(ctx.lease.timezone, new Date(c.received_at)), gamHeld: c.gam_held,
      refundAnswered: ctx.answeredCreditIds.has(c.id),
      howPaid: ctx.sources.filter((s) => ctx.sourceCredit.get(s.key)?.creditId === c.id).map((s) => s.label).join(', ')
        || (ctx.answeredCreditIds.has(c.id) ? 'Rent paid past the day they left (the check-out already asked about a refund)' : 'No payment on file'),
    })),
    sources: ctx.sources.map((s) => ({ key: s.key, kind: s.kind, label: s.label, refundable: s.refundable })),
    maxRefund, refundAnswered, refundNotes: waits ? [] : refundNotes, owedOnLease: owed, waits, refundOptions, restOptions, latest, quoteToken: token,
  }
}

/** "Refund a different amount": where it goes back, its cost, and the choices for the rest — updated as it is typed. */
export async function previewPaidAheadRefund(q: Q, leaseId: string, amount: number): Promise<{
  amount: number; parts: Array<{ kind: StayRefundPartKind; label: string; amount: number; words: string }>; cost: string | null
  rest: number; restOptions: RestOption[]
}> {
  const ctx = await buildCtx(q, leaseId, false)
  const max = round2(ctx.sources.reduce((a, s) => a + s.refundable, 0))
  const r = round2(amount)
  if (!(r > 0)) throw new AppError(400, 'Type how much to refund (more than $0.00).')
  if (r > max + 0.005) throw new AppError(400, `That is more than can be refunded — ${money(max)} at most.`)
  const parts = planFor(ctx, r)
  const rest = round2(ctx.left - r)
  return {
    amount: r, cost: costWordsFor(ctx, parts),
    parts: parts.map((p) => ({ kind: p.kind, label: p.source.label, amount: p.amount, words: p.words })),
    rest, restOptions: restOptionsFor(rest, gamHeldRestAfter(ctx, parts)),
  }
}

// ─── Deciding ────────────────────────────────────────────────────────────────

export class PaidAheadChanged extends AppError {
  constructor(public view: PaidAheadView, words: string, public kind: 'paid_ahead_changed' | 'already_decided' = 'paid_ahead_changed') {
    super(409, words)
  }
}

export interface DecideChoiceInput {
  leaseId: string
  actor: { userId: string; canRefund: boolean }
  refundChoice: unknown
  refundAmount?: number | null
  restChoice?: unknown
  quoteToken: string
  idempotencyKey: string
}

export interface DecideChoiceResult {
  leaseId: string
  choice: ChoiceSummary
  /**
   * What THIS press did, in order: anything it says first (`leading`), a
   * request that could not try because another held the part, then the
   * decision — money to give back at the desk said as an order only in the
   * reply to the press that decided it. The page shows these words for the
   * press, and choice.words (the record) on a later visit.
   */
  words: string[]
  /**
   * One flag per line of `words`: true when that line is money to give back
   * at the desk NOW (cash, a check, a money order, a bank deposit — only in the
   * reply to the press that decided it, and in the reply to "Give it back in
   * cash instead" once Stripe confirmed the refund never went out: choice46c).
   * The page draws every such line in the gold box, whatever its position
   * (review fix, choice46b pass 2).
   */
  handBack: boolean[]
  next: 'done' | 'try_again'
}

const CHANGED_WORDS = 'The money paid ahead on this lease changed a moment ago, so nothing was saved. The latest is shown now — look it over and choose again.'
const OUT_OF_DATE_WORDS = 'This page was out of date, so nothing was saved. The latest is shown now — look it over and choose again.'
const PART_GONE_WORDS = 'That refund is not on this lease any more, so nothing was changed. The page now shows the latest.'

/** The refund choices the page offers now, named as its buttons are ("No refund, Refund the unused days ($40.00) or Refund a different amount"). */
function offeredWords(v: PaidAheadView): string {
  const labels = v.refundOptions.map((o) => o.label)
  if (!labels.length) return 'a choice on the page'
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`
}

/** Internal: the same press was already recorded. */
class SameKey extends Error { constructor(public choiceId: string) { super('same key') } }

/**
 * Record the landlord's choice and do what it says, in one transaction (the
 * household locked, the credits locked); then send any card or bank refunds
 * (earlyCheckOut.runCardPart) and, when money moved to account credit or to
 * the person's next lease, let it pay a bill it covers in full (the
 * whole-bill rule).
 */
export async function decidePaidAhead(input: DecideChoiceInput): Promise<DecideChoiceResult> {
  if (!input.actor.canRefund) throw new AppError(403, PAID_AHEAD_PERM_WORDS)
  const key = String(input.idempotencyKey ?? '').trim()
  // Fresh at the moment of action: a page that cannot say which press this is
  // gets the latest back with the 409 (it shows it in place), never "reload".
  if (!key || key.length > 120) throw new PaidAheadChanged(await paidAheadView(poolQ, input.leaseId, { viewerId: input.actor.userId }), OUT_OF_DATE_WORDS)
  const again = await queryOne<{ id: string; lease_id: string }>(`SELECT id, lease_id FROM paid_ahead_choices WHERE idempotency_key = $1`, [key])
  if (again) {
    if (again.lease_id !== input.leaseId) throw new PaidAheadChanged(await paidAheadView(poolQ, input.leaseId, { viewerId: input.actor.userId }), OUT_OF_DATE_WORDS)
    // The same press again (a double click, a reply that was lost): what the first said.
    return finish(again.id, input.leaseId, { fresh: true, viewerId: input.actor.userId })
  }
  if (!isRefundChoice(input.refundChoice)) {
    throw new AppError(400, `Pick ${offeredWords(await paidAheadView(poolQ, input.leaseId, { viewerId: input.actor.userId }))}, then confirm again.`)
  }
  const refundChoice = input.refundChoice

  const client = await getClient()
  let choiceId: string | null = null
  const creditTenants: Array<{ tenantId: string; landlordId: string }> = []
  /** People whose money this choice left as theirs (#46.1a): carried again after commit. */
  const leftFor: string[] = []
  let landlordId: string | null = null
  try {
    await client.query('BEGIN')
    const lease = await loadLease(client, input.leaseId)
    if (!lease) throw new AppError(404, 'That lease is not on this account any more — go back to Leases and open it again.')
    landlordId = lease.landlord_id
    // One household per transaction (moneyPredicates): the people whose money this is.
    const tenant = (await client.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM lease_prepaid_credits WHERE lease_id = $1 AND voided_at IS NULL AND amount_remaining > 0
        ORDER BY tenant_id LIMIT 1`, [lease.id])).rows[0]
    if (tenant) await lockHousehold(client, tenant.tenant_id, lease.landlord_id)
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`paid_ahead_choice:${lease.id}`])
    const same = (await client.query<{ id: string }>(`SELECT id FROM paid_ahead_choices WHERE idempotency_key = $1`, [key])).rows[0]
    if (same) throw new SameKey(same.id)

    const view = await paidAheadView(client, lease.id, { lock: true, viewerId: input.actor.userId })
    if (view.left <= 0.005) {
      const who = view.latest
        ? `${view.latest.decidedBy ?? 'Someone'} already decided this on ${shortDay(view.latest.decidedAt, lease.timezone)}: ${view.latest.refundChoiceLabel}`
          + (view.latest.restChoiceLabel ? `, then ${view.latest.restChoiceLabel}` : '') + '. Nothing else was changed.'
        : 'There is no money paid ahead left on this lease, so there is nothing to decide. Nothing was changed.'
      throw new PaidAheadChanged(view, who, 'already_decided')
    }
    if (view.waits) throw new PaidAheadChanged(view, view.waits.words)
    if (view.quoteToken !== String(input.quoteToken ?? '')) throw new PaidAheadChanged(view, CHANGED_WORDS)

    const ctx = await buildCtx(client, lease.id, false)
    if (refundChoice !== 'no_refund' && view.maxRefund <= 0.005) {
      throw new PaidAheadChanged(view, ['None of this money can be refunded from this screen, so nothing was saved.', ...view.refundNotes].join(' '))
    }
    // How much goes back.
    let R = 0
    if (refundChoice === 'refund_all') R = view.maxRefund
    if (refundChoice === 'refund_other') {
      R = round2(Number(input.refundAmount))
      if (!(R > 0)) throw new AppError(400, 'Type how much to refund (more than $0.00), then confirm again.')
      if (R > view.maxRefund + 0.005) throw new AppError(400, `That is more than can be refunded — ${money(view.maxRefund)} at most. Change the amount, then confirm again.`)
    }
    if (refundChoice !== 'no_refund' && !(R > 0)) throw new PaidAheadChanged(view, CHANGED_WORDS)
    const rest = round2(ctx.left - R)
    const restChoice = rest > 0.005 ? input.restChoice : null
    if (rest > 0.005 && !isRestChoice(restChoice)) {
      throw new AppError(400, `Choose what happens to the ${money(rest)} that is not refunded — Keep it, or Leave it as their credit — then confirm again.`)
    }

    // What goes where, worked out first: the refund parts (each payment back
    // to itself, most recent first), then what is left of each credit.
    const plan = R > 0 ? planFor(ctx, R) : []
    if (Math.abs(round2(plan.reduce((a, p) => a + p.toward, 0)) - R) > 0.005) throw new PaidAheadChanged(view, CHANGED_WORDS)
    const tenantOf = new Map(ctx.credits.map((c) => [c.id, c.tenant_id]))
    const remaining = new Map(ctx.credits.map((c) => [c.id, toCents(c.usable)]))
    const creditBack = new Map<string, number>()   // tenant → cents of a refund paid by a credit the landlord gave, back to such credit
    // Review fix pass 3 (#46.1a): a refund of money that was paid with money
    // paid ahead goes back as money paid ahead — it simply stays on its credit
    // (no spend), marked as left by this choice, so it is the tenant's, follows
    // them, and nothing on the landlord's side can void it.
    const staysOn = new Set<string>()
    for (const p of plan) {
      const src = ctx.sourceCredit.get(p.source.key)!
      remaining.set(src.creditId, (remaining.get(src.creditId) ?? 0) - toCents(p.toward))
      if (p.kind === 'credit' && src.creditBack === 'paid_ahead') staysOn.add(src.creditId)
      else if (p.kind === 'credit') creditBack.set(tenantOf.get(src.creditId)!, (creditBack.get(tenantOf.get(src.creditId)!) ?? 0) + toCents(p.toward))
    }
    const restUses = [...ctx.credits].reverse()    // oldest first
      .map((c) => ({ credit: c, cents: remaining.get(c.id) ?? 0 })).filter((x) => x.cents > 0)
    const leftAsCredit = rest > 0.005 && restChoice === 'credit'
    const leftGamCents = leftAsCredit ? restUses.filter((x) => x.credit.gam_held).reduce((a, x) => a + x.cents, 0) : 0

    // A refund of a payment made with a credit the landlord gave goes back the
    // way it was paid: onto their account as such credit (no lease: it follows
    // the person).
    const creditIds: string[] = []
    for (const [tenantId, cents] of creditBack) {
      if (cents <= 0) continue
      creditIds.push(await createIssuedCredit(client, {
        landlordId: lease.landlord_id, tenantId, leaseId: null, amount: cents / 100, category: 'other',
        reason: `Refund of money paid ahead on ${lease.unit_number}, back to their account credit (the way it was paid)`, createdBy: input.actor.userId,
      }))
      creditTenants.push({ tenantId, landlordId: lease.landlord_id })
    }

    choiceId = (await client.query<{ id: string }>(
      `INSERT INTO paid_ahead_choices (lease_id, landlord_id, left_amount, refund_choice, refund_total, rest_choice, rest_amount,
                                       tenant_credit_ids, left_gam_held, idempotency_key, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10, $11) RETURNING id`,
      [lease.id, lease.landlord_id, ctx.left.toFixed(2), refundChoice, R.toFixed(2), rest > 0.005 ? restChoice : null,
       Math.max(0, rest).toFixed(2), creditIds, (leftGamCents / 100).toFixed(2), key, input.actor.userId])).rows[0].id

    const month = todayIn(lease.timezone).slice(0, 7) + '-01'
    let seq = 0
    for (const p of plan) {
      seq++
      const src = ctx.sourceCredit.get(p.source.key)!
      // A charge account takes its refund at once, as the early check-out's does.
      const status = p.kind === 'cash' || p.kind === 'check' || p.kind === 'money_order' ? 'handed_back'
        : p.kind === 'credit' ? 'credited' : p.kind === 'charge' ? 'refunded' : 'pending'
      const partId = (await client.query<{ id: string }>(
        `INSERT INTO stay_refund_parts
           (decision_id, paid_ahead_choice_id, booking_id, landlord_id, seq, kind, stay_payment_id, remittance_id, prepaid_credit_id,
            pos_transaction_id, stripe_payment_intent_id, toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label, status, refunded_at)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16,
                 CASE WHEN $16 IN ('handed_back', 'credited', 'refunded') THEN NOW() END)
         RETURNING id`,
        [choiceId, lease.source_booking_id, lease.landlord_id, seq, p.kind, p.source.stayPaymentId, p.source.remittanceId, src.creditId,
         p.source.posTransactionId, p.source.paymentIntentId, p.toward.toFixed(2), p.cardFeeBack.toFixed(2), p.amount.toFixed(2),
         p.payoutDrop.toFixed(2), p.source.label, status])).rows[0].id
      // Review fix (choice46b pass 2): reservation money that came in on a
      // register sale goes back on that sale's own record, as the early
      // check-out's does — a cash, check or charge-account part now (a card
      // part when it goes out, earlyCheckOut.sendCardPart) — so the register
      // never gives the same money back again.
      if (p.source.posTransactionId && (p.kind === 'cash' || p.kind === 'check' || p.kind === 'charge')) {
        if (p.kind === 'charge') {
          const acct = (await client.query<{ account_id: string }>(
            `SELECT account_id FROM flex_charge_transactions WHERE pos_transaction_id = $1 AND amount > 0 ORDER BY created_at LIMIT 1`,
            [p.source.posTransactionId])).rows[0]
          if (!acct) throw new AppError(409, 'This money was put on a charge account that can no longer be found, so it cannot be refunded here — nothing was changed. Ask the owner to check the account.')
          const { postFlexChargeRefund } = await import('./flexCharge')
          await postFlexChargeRefund({ accountId: acct.account_id, posTransactionId: p.source.posTransactionId,
            amount: p.amount, notes: `Refund of money paid ahead on ${lease.unit_number}` }, client)
        }
        const refundId = await recordSaleRefund(client, {
          saleId: p.source.posTransactionId, landlordId: lease.landlord_id, amount: p.amount,
          method: p.kind, reason: `Refund of money paid ahead on ${lease.unit_number}`, stayRefundPartId: partId,
        })
        await client.query(`UPDATE stay_refund_parts SET pos_refund_id = $2 WHERE id = $1`, [partId, refundId])
      }
      // Money paid ahead that went back to money paid ahead stays on its
      // credit: nothing is spent (it is marked left by this choice below).
      if (p.kind === 'credit' && src.creditBack === 'paid_ahead') continue
      // The refund comes off the credit as a recorded spend (credit back to
      // credit too: it moves to their account credit above).
      await client.query(
        `INSERT INTO credit_uses (prepaid_credit_id, refund_part_id, lease_id, amount, billing_month, source, status, applied_at, created_by)
         VALUES ($1, $2, $3, $4, $5::date, 'refund', 'applied', NOW(), $6)`,
        [src.creditId, partId, lease.id, p.toward.toFixed(2), month, input.actor.userId])
    }

    // The rest: the landlord's choice.
    let released = 0
    if (rest > 0.005 && restChoice === 'keep') {
      // Kept: a recorded spend of each credit it comes from. Money GAM holds
      // goes to the landlord once, on their next payout (one held item per
      // spend, v_credit_uses.gam_held — the one rule for who holds a spend's
      // money); money they already have is simply theirs.
      const useIds: string[] = []
      for (const x of restUses) {
        useIds.push((await client.query<{ id: string }>(
          `INSERT INTO credit_uses (prepaid_credit_id, paid_ahead_choice_id, lease_id, amount, billing_month, source, status, applied_at, created_by)
           VALUES ($1, $2, $3, $4, $5::date, 'paid_ahead_choice', 'applied', NOW(), $6) RETURNING id`,
          [x.credit.id, choiceId, lease.id, (x.cents / 100).toFixed(2), month, input.actor.userId])).rows[0].id)
      }
      const gamHeld = (await client.query<{ id: string; amount: string }>(
        `SELECT v.id, v.amount::text AS amount FROM v_credit_uses v WHERE v.id = ANY($1::uuid[]) AND v.gam_held ORDER BY v.id`,
        [useIds])).rows
      for (const u of gamHeld) {
        const ok = await recordHeldItem({
          landlordId: lease.landlord_id, sourceType: 'prepaid_draw', sourceId: u.id, amount: Number(u.amount),
          description: `${lease.unit_number}: money paid ahead through GAM on an ended lease, kept by you`,
        }, client)
        if (ok) released = round2(released + Number(u.amount))
      }
    }
    // decisions #46.1a: left as their credit (the rest), or money paid ahead
    // refunded back to money paid ahead (staysOn), it stays the tenant's
    // money paid ahead — nothing is spent and nothing is released now. What
    // GAM holds stays GAM-held until it pays one of their bills (allocation
    // pays its gam_held_part out that day); what the landlord holds is credit
    // they owe the tenant. Marked as decided, it follows the person to their
    // next lease with this landlord (paid_ahead_carry_left, also run by the DB
    // when such a lease comes into force, and again after this commit).
    const markIds = new Set<string>([...(leftAsCredit ? restUses.map((x) => x.credit.id) : []), ...staysOn])
    if (markIds.size) {
      for (const id of [...markIds].sort()) {
        await client.query(
          `UPDATE lease_prepaid_credits c SET left_by_choice_id = $2, updated_at = NOW() WHERE c.id = $1 AND NOT ${leftHereSql('c')}`,
          [id, choiceId])
      }
      const people = [...new Set([...markIds].map((id) => tenantOf.get(id)!))]
      leftFor.push(...people)
      // Already on another lease of this landlord that is in force: it moves there now.
      creditTenants.push(...await carryLeftTo(client, lease.landlord_id, lease.id, people))
    }
    if (released > 0) {
      await client.query(`UPDATE paid_ahead_choices SET released_amount = $2 WHERE id = $1`, [choiceId, released.toFixed(2)])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    if (e instanceof SameKey) return finish(e.choiceId, input.leaseId, { fresh: true, viewerId: input.actor.userId })
    if ((e as any)?.code === '23505' && (e as any)?.constraint === 'ux_paid_ahead_choices_idem') {
      const first = await queryOne<{ id: string }>(`SELECT id FROM paid_ahead_choices WHERE idempotency_key = $1`, [key])
      if (first) return finish(first.id, input.leaseId, { fresh: true, viewerId: input.actor.userId })
    }
    throw e
  }
  client.release()

  // Review fix pass 3: a lease of theirs that came into force in another
  // transaction while this one ran fired its carry before these marks were
  // committed — so carry once more now, and nothing stays behind.
  if (leftFor.length && landlordId) {
    for (const t of await carryLeftAfterCommit(landlordId, input.leaseId, leftFor)) creditTenants.push(t)
  }
  const seen = new Set<string>()
  for (const t of creditTenants) {
    if (seen.has(t.tenantId)) continue
    seen.add(t.tenantId)
    await runWholeBillCheckAfterCommit(t)
  }
  return finish(choiceId!, input.leaseId, { fresh: true, viewerId: input.actor.userId })
}

/**
 * Money left as these people's credit moves to a lease of this landlord that
 * is in force and that they signed (never a pending addendum: pass 2) —
 * paid_ahead_carry_left, the same function the DB runs when such a lease comes
 * into force. Returns who had money moved (for the whole-bill check).
 */
async function carryLeftTo(q: Q, landlordId: string, leaseId: string, people: readonly string[]): Promise<Array<{ tenantId: string; landlordId: string }>> {
  if (!people.length) return []
  const next = (await q.query<{ id: string; tenant_id: string }>(
    `SELECT DISTINCT ON (lt.tenant_id) l.id, lt.tenant_id
       FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
       JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
      WHERE l.landlord_id = $1 AND l.status = 'active' AND l.id <> $2
        AND lt.tenant_id = ANY($3::uuid[]) AND lt.status = 'active'
        AND NOT ${endedLeaseSql('l', 'pr')}
      ORDER BY lt.tenant_id, l.start_date DESC NULLS LAST, l.id`, [landlordId, leaseId, [...people]])).rows
  const out: Array<{ tenantId: string; landlordId: string }> = []
  for (const n of next) {
    const moved = Number((await q.query<{ n: number }>(`SELECT paid_ahead_carry_left($1) AS n`, [n.id])).rows[0]?.n ?? 0)
    if (moved > 0) out.push({ tenantId: n.tenant_id, landlordId })
  }
  return out
}

/** After the choice commits: carry again (its own transaction), so a lease made active meanwhile still gets the money. */
export async function carryLeftAfterCommit(landlordId: string, leaseId: string, people: readonly string[]): Promise<Array<{ tenantId: string; landlordId: string }>> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const moved = await carryLeftTo(c, landlordId, leaseId, [...new Set(people)])
    await c.query('COMMIT')
    return moved
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    logger.error({ err, leaseId }, '[paid-ahead-choice] could not carry money left as their credit after the choice')
    return []
  } finally { c.release() }
}

/** How long Try again waits for a part another request holds for a moment (earlyCheckOut's press wait). */
const PRESS_WAIT_MS = 3000
const BUSY_TRY_AGAIN = 'This refund was being worked on by another request at that same moment, so it was not sent again. Wait a moment, then press Try again.'

/**
 * Review fix (choice46b) — #38 Q4 for money GAM holds: a card or bank refund
 * of it that the desk handed back in cash instead (a cash part replacing it,
 * earlyCheckOut.givePartBackInCash) came out of the landlord's drawer, while
 * the tenant's money stayed with GAM. GAM releases what it held of that part
 * (its toward_amount) to the landlord, once ('prepaid_draw', keyed
 * 'cash-part:<the cash part>'), so their only cost is the card fee they handed
 * back with it. Money the landlord already had (rent banked when a stay was
 * shortened) releases nothing. Idempotent: run after every press and whenever
 * the screen is opened, so a crash between the two never loses it.
 */
async function releaseCashInsteadHeld(where: { choiceId?: string; leaseId?: string }): Promise<void> {
  const rows = await query<{ id: string; release: string; blocked: boolean; amount: string; replaces: string; landlord_id: string; unit_number: string | null; lease_id: string }>(
    `SELECT rp.id, ${cashPartReleaseSql('rp')}::text AS release, ${cashAfterTakenBackSql('rp')} AS blocked,
            rp.amount::text AS amount, rp.replaces_part_id AS replaces, rp.landlord_id, un.unit_number, pc.lease_id
       FROM stay_refund_parts rp
       JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
       JOIN lease_prepaid_credits c ON c.id = rp.prepaid_credit_id
       JOIN leases l ON l.id = pc.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
      WHERE (pc.id = $1::uuid OR pc.lease_id = $2::uuid)
        AND rp.kind = 'cash' AND rp.status = 'handed_back' AND rp.replaces_part_id IS NOT NULL
        AND ${creditGamHeldSql('c')}
        AND NOT EXISTS (SELECT 1 FROM held_payout_items h
                         WHERE h.source_type = 'prepaid_draw' AND h.source_id = 'cash-part:' || rp.id::text)
      ORDER BY rp.created_at, rp.id`, [where.choiceId ?? null, where.leaseId ?? null])
  for (const r of rows) {
    // Choice46d (review): cash handed back for a refund a dispute or bank
    // return had already given back to the tenant (it raced the cash press):
    // GAM no longer holds that money, so nothing is released — GAM is told
    // once, exactly, to sort out by hand.
    if (r.blocked) {
      await alertCashAfterTakenBack(r).catch((err) => logger.error({ err, partId: r.id }, '[paid-ahead-choice] could not tell GAM about cash handed back for money a dispute took'))
      continue
    }
    // Only what GAM still holds of that refund (cashPartReleaseSql): never money a dispute took, never twice.
    if (!(Number(r.release) > 0.005)) continue
    await recordHeldItem({
      landlordId: r.landlord_id, sourceType: 'prepaid_draw', sourceId: `cash-part:${r.id}`, amount: Number(r.release),
      description: cashPartReleaseWords(r.unit_number),
    })
  }
}

/** GAM's alert for cash handed back for a refund a dispute had already given back (once per cash part). */
async function alertCashAfterTakenBack(r: { id: string; amount: string; replaces: string; unit_number: string | null; lease_id: string }, o: { toldNotTo?: boolean } = {}): Promise<void> {
  const seen = await query(
    `SELECT 1 FROM admin_notifications WHERE category = 'paid_ahead_cash_after_taken_back' AND context->>'cash_part_id' = $1
     UNION ALL
     SELECT 1 FROM admin_notifications_archive WHERE category = 'paid_ahead_cash_after_taken_back' AND context->>'cash_part_id' = $1
     LIMIT 1`, [r.id])
  if (seen.length) return
  const amt = money(Number(r.amount))
  await query(
    `INSERT INTO admin_notifications (severity, category, title, body, context) VALUES ('warn', $1, $2, $3, $4)`,
    ['paid_ahead_cash_after_taken_back',
     o.toldNotTo
       ? `Cash was recorded for a refund a dispute had already given back — the desk was told NOT to hand it over${r.unit_number ? ` (${r.unit_number})` : ''}`
       : `Cash was handed back for a refund a dispute had already given back${r.unit_number ? ` (${r.unit_number})` : ''}`,
     o.toldNotTo
       ? `The desk pressed "${CASH_BUTTON}" for ${amt} of money paid ahead${r.unit_number ? ` on ${r.unit_number}` : ''}, and the hand-back was recorded, `
         + `but a card dispute or bank return of the payment it came from had already given that money back to the tenant (refund part ${r.replaces}). `
         + `The reply told the worker NOT to hand anything over. GAM released nothing to the landlord for it. The record still shows ${amt} handed back in cash `
         + `and needs correcting by hand — confirm with the desk that no cash went out (cash part ${r.id}).`
       : `The desk pressed "${CASH_BUTTON}" and handed back ${amt} for a refund of money paid ahead${r.unit_number ? ` on ${r.unit_number}` : ''} `
         + `that a card dispute or bank return of the payment it came from had already given back to the tenant (refund part ${r.replaces}). `
         + `GAM did not release the money it had held for it to the landlord, because the dispute took it. The tenant got this ${amt} twice, `
         + `and the landlord is out the ${amt} cash. Settle it with the landlord and the tenant by hand (cash part ${r.id}).`,
     JSON.stringify({ cash_part_id: r.id, replaced_part_id: r.replaces, lease_id: r.lease_id, amount: Number(r.amount), told_not_to: !!o.toldNotTo })])
}

/**
 * After commit: send the card and bank parts still waiting (and `retry`, a
 * failed one tried again — that press waits a moment for a part another
 * request holds, and says so once when it could not try), then say what was
 * done. `leading` comes first (what a press just did); `fresh` (the press
 * that decided it) says money to give back at the desk as an order;
 * `omit` leaves out the line of a part the leading words already said.
 */
async function finish(choiceId: string, leaseId: string, o: { retry?: string | null; leading?: string[]; leadingHandBack?: boolean[]; fresh?: boolean; omit?: string[]; viewerId?: string | null } = {}): Promise<DecideChoiceResult> {
  const retry = o.retry ?? null
  await undoOwedAgain({ leaseId }).catch((err) => logger.error({ err, choiceId }, '[paid-ahead-choice] could not undo a refund owed again'))
  await releaseCashInsteadHeld({ choiceId }).catch((err) => logger.error({ err, choiceId }, '[paid-ahead-choice] could not release money GAM held for a refund handed back in cash'))
  await stopRefundsThatCannotGo({ choiceId }).catch((err) => logger.error({ err, choiceId }, '[paid-ahead-choice] could not stop refunds of a disputed payment'))
  // Choice46c: never a refund of a payment that was disputed or returned
  // (the card company or bank takes none), and never one a dispute already
  // took back (PAID_AHEAD_PART_TAKEN_BACK).
  const waiting = await query<{ id: string }>(
    `SELECT p.id FROM stay_refund_parts p
      WHERE p.paid_ahead_choice_id = $1 AND p.kind IN ('card', 'bank')
        AND (p.status = 'pending' OR (p.id = $2::uuid AND p.status = 'failed'))
        AND p.failure IS DISTINCT FROM $3
        -- A refund that went out but was not recorded is only recorded (the
        -- runner finds it at Stripe and sends nothing), dispute or not.
        AND (NOT ${fundingTakenBackSql('p.stripe_payment_intent_id')}
             OR (p.id = $2::uuid AND p.status = 'failed' AND COALESCE(p.failure ~ $4, FALSE)))
      ORDER BY p.seq`, [choiceId, retry, PAID_AHEAD_PART_TAKEN_BACK, REFUND_NOT_RECORDED_PATTERN])
  let busy = false
  for (const p of waiting) {
    const ran = await runCardPart(p.id, p.id === retry ? { waitMs: PRESS_WAIT_MS } : {})
      .catch((err) => { logger.error({ err, partId: p.id }, '[paid-ahead-choice] a card refund could not be sent'); return true })
    if (!ran && p.id === retry) busy = true
  }
  const sp = (await summaryOf(poolQ, choiceId, o.viewerId ?? null))!
  const summary = sp.summary
  const stillWaits = busy && summary.parts.some((x) => x.id === retry && (x.status === 'failed' || x.status === 'pending'))
  const omit = new Set(o.omit ?? [])
  const kept = sp.lines.filter((l) => !l.partId || !omit.has(l.partId))
  const before = [...(o.leading ?? []), ...(stillWaits ? [BUSY_TRY_AGAIN] : [])]
  return {
    leaseId, choice: summary, words: [...before, ...kept.map((l) => (o.fresh ? l.fresh : l.past))],
    handBack: [...before.map((_, i) => !!o.leadingHandBack?.[i]), ...kept.map((l) => !!o.fresh && l.order)],
    next: summary.parts.some((x) => x.retry) ? 'try_again' : 'done',
  }
}

/**
 * Choice46d (review): creditUse.undoOwedAgainForFailedRefunds in its own
 * transaction — a refund the tenant was billed for again (a dispute took the
 * money back after it went out) that has since come back failed at Stripe is
 * no longer owed, and the dispute's part of it is marked as given back.
 */
async function undoOwedAgain(where: { leaseId?: string; landlordIds?: readonly string[] }): Promise<void> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    await undoOwedAgainForFailedRefunds(c, where)
    await c.query('COMMIT')
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    throw err
  } finally { c.release() }
}

/**
 * Choice46d (review): undoOwedAgain for every company, for a scheduled sweep —
 * a refund counted as owed again that came back failed at Stripe is put right
 * promptly (its "returned" line is dated the day it came back), not only when
 * someone opens the screen or the to-do. Until earlyCheckOut.stripeRefundFailed
 * runs creditUse.undoOwedAgainForFailedRefunds itself, a short-interval cron
 * should call this. Returns nothing; failures are logged.
 */
export async function sweepOwedAgainUndo(): Promise<void> {
  await undoOwedAgain({}).catch((err) => logger.error({ err }, '[paid-ahead-choice] the owed-again sweep failed'))
}

/** The failure a refund of a disputed or returned payment carries once it is stopped (the screen says it in its own words: cannotSend). */
const CANNOT_GO_WORDS = PAID_AHEAD_PART_CANNOT_GO

/**
 * Choice46c: a card or bank refund of this screen still waiting to go out
 * whose payment was disputed or returned by the bank since (the card company
 * or the bank takes no refund of it) is stopped — failed, under its own
 * advisory lock so it is never stopped while a send is running — so it is
 * offered "Give it back in cash instead" rather than left "sending" for good.
 * A part the dispute itself took back (PAID_AHEAD_PART_TAKEN_BACK) was
 * already stopped by the dispute handler.
 */
async function stopRefundsThatCannotGo(where: { choiceId?: string; leaseId?: string }): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT p.id FROM stay_refund_parts p JOIN paid_ahead_choices pc ON pc.id = p.paid_ahead_choice_id
      WHERE (pc.id = $1::uuid OR pc.lease_id = $2::uuid)
        AND p.kind IN ('card', 'bank') AND p.status = 'pending'
        AND ${fundingTakenBackSql('p.stripe_payment_intent_id')}
      ORDER BY p.seq`, [where.choiceId ?? null, where.leaseId ?? null])
  for (const r of rows) {
    const c = await getClient()
    const key = `stay-refund-part:${r.id}`
    let unlocked = true
    try {
      if (!(await c.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key])).rows[0]?.ok) continue
      unlocked = false
      try {
        await c.query(`UPDATE stay_refund_parts SET status = 'failed', failure = $2 WHERE id = $1 AND status = 'pending'`, [r.id, CANNOT_GO_WORDS])
      } finally {
        unlocked = await unlockSession(c, key)
      }
    } finally { releaseAfterSessionLock(c, unlocked) }
  }
}

/**
 * Card or bank parts of this lease's choices left "sending" for more than 10
 * minutes (a crash between the decision and Stripe) are sent again when the
 * screen is opened — the same runner and safety as the first try
 * (earlyCheckOut.runCardPart: it finds a refund an earlier try already made,
 * so nothing goes out twice). The stay's own resumeStaleParts does the same
 * when a stay is opened. Money GAM held for a refund handed back in cash is
 * released here too, if a crash kept it from being released at the press.
 */
export async function resumeStalePaidAheadParts(leaseId: string): Promise<void> {
  await undoOwedAgain({ leaseId }).catch((err) => logger.error({ err, leaseId }, '[paid-ahead-choice] could not undo a refund owed again'))
  await releaseCashInsteadHeld({ leaseId }).catch((err) => logger.error({ err, leaseId }, '[paid-ahead-choice] could not release money GAM held for a refund handed back in cash'))
  await stopRefundsThatCannotGo({ leaseId }).catch((err) => logger.error({ err, leaseId }, '[paid-ahead-choice] could not stop refunds of a disputed payment'))
  const stale = await query<{ id: string }>(
    `SELECT rp.id FROM stay_refund_parts rp JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
      WHERE pc.lease_id = $1 AND rp.status = 'pending' AND rp.kind IN ('card', 'bank')
        AND rp.created_at < NOW() - INTERVAL '10 minutes'
        AND NOT ${fundingTakenBackSql('rp.stripe_payment_intent_id')}
      ORDER BY rp.seq`, [leaseId])
  for (const p of stale) {
    await runCardPart(p.id).catch((err) => logger.error({ err, partId: p.id }, '[paid-ahead-choice] resume failed'))
  }
}

/**
 * Try again on a card or bank refund of this screen that did not go out (the
 * same runner and safety as the first try). Choice46c: a refund that can never
 * be sent — its register sale was already refunded at the register, or the
 * payment it came from was disputed or returned by the bank, or a dispute
 * already took that money back — is refused (409) in plain words with what to
 * do instead; nothing is sent.
 */
export async function retryPaidAheadPart(leaseId: string, partId: string, actor: { canRefund: boolean; userId?: string | null }): Promise<DecideChoiceResult> {
  if (!actor.canRefund) throw new AppError(403, PAID_AHEAD_PERM_WORDS)
  // Review fix (choice46c pass 3): a refund still "sending" whose payment was
  // disputed since is stopped FIRST — exactly what the page's refetch after a
  // 409 does — so the 409 below says what the refetched line says ("cannot go
  // back … press "Give it back in cash instead" …"), never a button that is gone.
  const of = await queryOne<{ choice_id: string; lease_id: string }>(
    `SELECT p.paid_ahead_choice_id AS choice_id, pc.lease_id
       FROM stay_refund_parts p JOIN paid_ahead_choices pc ON pc.id = p.paid_ahead_choice_id WHERE p.id = $1`, [partId])
  if (!of || of.lease_id !== leaseId) throw new AppError(404, PART_GONE_WORDS)
  await stopRefundsThatCannotGo({ choiceId: of.choice_id })
    .catch((err) => logger.error({ err, partId }, '[paid-ahead-choice] could not stop refunds of a disputed payment'))
  const part = await queryOne<any>(
    `SELECT p.paid_ahead_choice_id AS choice_id, pc.lease_id, p.status, p.kind, p.amount::float AS amount, p.failure,
            ${saleRoomSql('p')} AS sale_room, ${fundingTakenBackSql('p.stripe_payment_intent_id')} AS funding_disputed
       FROM stay_refund_parts p JOIN paid_ahead_choices pc ON pc.id = p.paid_ahead_choice_id WHERE p.id = $1`, [partId])
  if (!part || part.lease_id !== leaseId) throw new AppError(404, PART_GONE_WORDS)
  const stripe = part.kind === 'card' || part.kind === 'bank'
  if (stripe && part.status === 'failed' && part.failure === PAID_AHEAD_PART_TAKEN_BACK) {
    throw new AppError(409, `This refund will not be sent: the payment it came from was ${takenBackBy(part.kind)}, so that ${money(Number(part.amount))} already went back to them. Nothing was sent, and nothing more goes back for it — the page now shows the latest.`)
  }
  if (stripe && (part.status === 'failed' || part.status === 'pending')) {
    const never = cannotSend(part)
    // The reason already says nothing went out ("Nothing was sent…", "…cannot go back…"): said once, with what to do.
    if (never) throw new AppError(409, `${never} The page now shows the latest.`)
  }
  const recordOnly = stripe && part.status === 'failed' && refundWentOutUnrecorded(part.failure)
  const out = await finish(part.choice_id, leaseId, { retry: partId, viewerId: actor.userId ?? null })
  // Choice46d (review): a record-only Try again says it recorded what had
  // already gone out — never "— sent." as if a second refund went.
  const now = out.choice.parts.find((x) => x.id === partId)
  if (recordOnly && now?.status === 'refunded') {
    const line = `${now.words}.`
    const keep = out.words.map((w, i) => ({ w, h: out.handBack[i] })).filter((x) => x.w !== line)
    out.words = [`Recorded — the ${money(now.amount)} had already gone back to ${part.kind === 'bank' ? 'their bank' : 'the card'}; nothing was sent again.`, ...keep.map((x) => x.w)]
    out.handBack = [false, ...keep.map((x) => !!x.h)]
  }
  return out
}

/**
 * Choice46d (review): the 409 a cash press gets while another request is
 * working on that refund (a send, a Try again, another worker's cash press, a
 * dispute being recorded) — coded ('refund_busy'). Nothing was handed back by
 * THIS press; the page keeps it until the next looks settle it (another
 * press's cash showing up is said with who recorded it, never as an order).
 */
export class RefundBusy extends AppError {
  readonly code = 'refund_busy'
  constructor(words: string) { super(409, words) }
}

/**
 * Choice46d fix pass 3: the busy words name the page's own next step — "Check
 * again" (the page shows it beside these words and looks again in place),
 * never "look at this line again", which the page could not do.
 */
const beingSentWords = (_kind: string) =>
  'Another request is working on this refund right now, so nothing was handed back. Wait a moment, then press Check again.'

/** Choice46e (review): a cash press that could not ask Stripe whether the refund already went out — nothing is handed back. */
export const stripeUnreachableWords = (kind: string) =>
  `Nothing was handed back — GAM could not reach Stripe to check whether this refund already reached ${kind === 'bank' ? 'their bank' : 'the card'}. `
  + `Wait a minute, then press "${CASH_BUTTON}" again.`

/** Choice46d fix pass 3: the press could not finish checking the refund first (a failed undo or stop) — nothing is handed back. */
const CHECK_FAILED_WORDS = `Nothing was handed back — GAM could not finish checking this refund. Wait a moment, then press "${CASH_BUTTON}" again.`

/** How long a cash press waits for another press of the same refund to let go of it. */
const PRESS_LOCK_WAIT_MS = 2000

/**
 * A card or bank part that did not go out and can be handed back in cash
 * instead (failed; never one being sent, never one whose register sale the
 * register already refunded, never one a dispute already took back — the
 * tenant got that money back from the card company or the bank).
 */
export const canGiveInCash = (p: { kind: string; status: string; amount?: number | string; sale_room?: number | string | null; failure?: string | null }): boolean =>
  (p.kind === 'card' || p.kind === 'bank') && p.status === 'failed' && !noSaleRoom(p) && p.failure !== PAID_AHEAD_PART_TAKEN_BACK
  // Review fix (choice46c): a refund that reached the card but was not recorded is never handed back in cash as well.
  && !refundWentOutUnrecorded(p.failure)

/**
 * Review fix pass 3: a part of money that came in on a register sale the
 * register has since refunded (sendCardPart's 'no_room'): the sale has less
 * left to give back than the part, so neither the card nor cash at the desk
 * can take it (recordSaleRefund refuses) — "Give it back in cash instead" is
 * never offered for it (it would only be refused).
 */
const noSaleRoom = (p: { amount?: number | string; sale_room?: number | string | null }): boolean =>
  p.sale_room != null && Number(p.sale_room) < Number(p.amount ?? 0) - 0.005

/**
 * SQL, on a stay_refund_parts alias: what the part's register sale still has
 * to give back (its total less the refunds on it — the room recordSaleRefund
 * checks), or NULL when the part is not on a sale.
 */
const saleRoomSql = (p: string) => `(SELECT (t.total - COALESCE((SELECT SUM(r2.amount) FROM pos_refunds r2
                                                       WHERE r2.transaction_id = t.id AND r2.reversed_at IS NULL), 0))::float
                    FROM pos_transactions t WHERE t.id = ${p}.pos_transaction_id AND t.status <> 'voided')`

/**
 * "Give it back in cash instead" for a card or bank refund of this screen
 * that did not go out (failed, or sent back by Stripe): the way out when the
 * card is closed, so the tenant's money is never stuck. The press comes
 * before the hand-back (choice46c review): only its reply says "Hand back $X
 * in cash now." (gold, handBack), after Stripe was asked; a refund that went
 * out but was not recorded is refused (409) — it is never handed back as
 * well. The SAME code the
 * early check-out uses (earlyCheckOut.givePartBackInCash, which reads a part
 * with no stay too): it first asks Stripe whether an earlier try reached the
 * card after all (then nothing is handed back), else the failed part becomes
 * 'replaced' and a cash part, handed back now, takes its place on this choice
 * (the replacement trigger names its parent) — so it is never sent to the
 * card as well, and the to-do and Try again go away. When GAM held the money,
 * what it held is released to the landlord once (releaseCashInsteadHeld, run
 * by finish): their only cost is the card fee they handed back with it.
 */
export async function givePaidAheadPartBackInCash(leaseId: string, partId: string, actor: { userId: string; canRefund: boolean }): Promise<DecideChoiceResult> {
  if (!actor.canRefund) throw new AppError(403, PAID_AHEAD_PERM_WORDS)
  const of = await queryOne<{ choice_id: string; lease_id: string }>(
    `SELECT p.paid_ahead_choice_id AS choice_id, pc.lease_id
       FROM stay_refund_parts p JOIN paid_ahead_choices pc ON pc.id = p.paid_ahead_choice_id WHERE p.id = $1`, [partId])
  if (!of || of.lease_id !== leaseId) throw new AppError(404, PART_GONE_WORDS)
  // A refund still "sending" whose payment was disputed is stopped first (it
  // takes the part's own lock, never this press's). Choice46d fix pass 3: if
  // that cannot be finished, nothing is checked or handed back.
  try {
    await stopRefundsThatCannotGo({ choiceId: of.choice_id })
  } catch (err) {
    logger.error({ err, partId }, '[paid-ahead-choice] could not stop refunds of a disputed payment')
    throw new AppError(503, CHECK_FAILED_WORDS)
  }
  type Reply = { leading: string[]; leadingHandBack: boolean[]; omit: string[] }
  let reply: Reply | null = null
  // Choice46d fix pass 3: this press's own key (creditUse.paidAheadCashPressKey),
  // held from the undo and the checks through the hand-back. A dispute, a bank
  // return or the owed-again undo takes the same key before it marks a part
  // (creditUse.lockRefundParts), so none of them can mark this part between
  // this press's look and its replacement — one waits for the other.
  const press = await getClient()
  const key = paidAheadCashPressKey(partId)
  // True until the key is taken and then let go of cleanly (releaseAfterSessionLock).
  let unlocked = true
  try {
    if (!(await tryAdvisoryLock(press, key, PRESS_LOCK_WAIT_MS))) throw new RefundBusy(beingSentWords(''))
    unlocked = false
    try {
      // What a dispute or return already settled of THIS part is put right
      // first, on this session (it holds the key): a refund counted as owed
      // again that came back failed is marked as given back by the dispute.
      // Choice46d fix pass 3: if that cannot be finished, nothing is handed back.
      try {
        await press.query('BEGIN')
        await undoOwedAgainForFailedRefunds(press, { leaseId, partId }, { strict: true, lockWait: '3s' })
        await press.query('COMMIT')
      } catch (err) {
        await press.query('ROLLBACK').catch(() => {})
        if (isDisputeRetryLater(err)) throw new RefundBusy(beingSentWords(''))
        logger.error({ err, partId }, '[paid-ahead-choice] could not undo a refund owed again before a cash press')
        throw new AppError(503, CHECK_FAILED_WORDS)
      }
      reply = await pressUnderKey(press, leaseId, partId, actor)
    } finally {
      unlocked = await unlockSession(press, key)
    }
  } finally { releaseAfterSessionLock(press, unlocked) }
  return finish(of.choice_id, leaseId, { ...(reply ?? {}), viewerId: actor.userId })
}

/**
 * The cash press's checks and hand-back, under its own key (the caller holds
 * it). Returns the reply's leading words, or null when there is nothing to
 * say beyond what stands now.
 */
async function pressUnderKey(
  press: PoolClient, leaseId: string, partId: string, actor: { userId: string },
): Promise<{ leading: string[]; leadingHandBack: boolean[]; omit: string[] } | null> {
  const part = (await press.query<{ choice_id: string; lease_id: string; kind: string; status: string; amount: number; sale_room: number | null; failure: string | null; timezone: string | null }>(
    `SELECT p.paid_ahead_choice_id AS choice_id, pc.lease_id, p.kind, p.status, p.amount::float AS amount, ${saleRoomSql('p')} AS sale_room, p.failure,
            pr.timezone
       FROM stay_refund_parts p JOIN paid_ahead_choices pc ON pc.id = p.paid_ahead_choice_id
       JOIN leases l ON l.id = pc.lease_id JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
      WHERE p.id = $1`, [partId])).rows[0]
  if (!part || part.lease_id !== leaseId) throw new AppError(404, PART_GONE_WORDS)
  const stripe = part.kind === 'card' || part.kind === 'bank'
  // Choice46c: a dispute or bank return already took this money back to the
  // tenant — said once, before anything is handed over (GAM no longer holds it).
  if (stripe && part.status === 'failed' && part.failure === PAID_AHEAD_PART_TAKEN_BACK) {
    throw new AppError(409, `The payment this money came from was ${takenBackBy(part.kind)}, so that ${money(Number(part.amount))} already went back to them. Nothing was handed back, and nothing more goes back for it — the page now shows the latest.`)
  }
  // Review fix (choice46c): the refund already reached the card or bank — GAM
  // only has to finish recording it. Said before anything is handed over.
  if (stripe && part.status === 'failed' && refundWentOutUnrecorded(part.failure)) {
    throw new AppError(409, `This refund already went to ${part.kind === 'bank' ? 'their bank' : 'the card'} — GAM only has to finish recording it, so hand nothing back in cash. Press Try again to finish recording it — the page now shows the latest.`)
  }
  // Review fix pass 3: the register already gave this sale's money back — said
  // once, plainly, before anything is handed over.
  if (stripe && part.status === 'failed' && noSaleRoom(part)) {
    throw new AppError(409, `This money came in on a register sale that was already refunded at the register (only ${money(Math.max(0, Number(part.sale_room)))} is left on it), so nothing was handed back. Check what the tenant got back at the register before giving anything more — the page now shows the latest.`)
  }
  // Nothing waits on it any more (it went out, or was already given back): what stands now.
  if (!canGiveInCash(part)) {
    if (part.status === 'pending' && stripe) throw new RefundBusy(beingSentWords(part.kind))
    // Already handed back in cash by an earlier press — this worker's, whose
    // answer was lost, or a colleague's on another screen. Choice46d fix pass
    // 3: never an unconditional order — when, and by whom (recordedCashWords).
    const earlier = part.status === 'replaced' ? (await press.query<any>(
      `SELECT rp.id, rp.amount::float AS amount, rp.created_at, rec.user_id AS recorded_by, rec.name AS recorded_by_name,
              (rp.kind = 'cash' AND COALESCE(${cashAfterTakenBackSql('rp')}, FALSE)) AS blocked,
              COALESCE((SELECT h.amount FROM held_payout_items h
                         WHERE h.source_type = 'prepaid_draw' AND h.source_id = 'cash-part:' || rp.id::text), 0)::float AS released
         FROM stay_refund_parts rp
         LEFT JOIN LATERAL ${cashPresserSql('rp')} rec ON TRUE
        WHERE rp.replaces_part_id = $1 AND rp.kind = 'cash' AND rp.status = 'handed_back' ORDER BY rp.created_at DESC LIMIT 1`, [partId])).rows[0] : null
    if (earlier) {
      if (earlier.blocked) {
        return { leading: [blockedCashWords(part.kind, Number(earlier.amount), false)], leadingHandBack: [false], omit: [earlier.id] }
      }
      const said = recordedCashWords({
        amount: Number(earlier.amount), replacedKind: part.kind, at: earlier.created_at, byId: earlier.recorded_by ?? null,
        byName: earlier.recorded_by_name ?? null, released: Number(earlier.released), tz: part.timezone,
      }, actor.userId, true)
      return { leading: said.words, leadingHandBack: said.handBack, omit: [earlier.id] }
    }
    return null
  }
  let out: Awaited<ReturnType<typeof givePartBackInCash>>
  try {
    out = await givePartBackInCash(partId, null, actor.userId)
  } catch (err) {
    // Another request held this refund at that moment (a send, a Try again):
    // the same plain words.
    if (err instanceof AppError && err.statusCode === 409 && /^This refund is being sent to /.test(err.message)) {
      throw new RefundBusy(beingSentWords(part.kind))
    }
    // Choice46e (review): Stripe could not be asked whether an earlier try
    // reached the card or bank (earlyCheckOut's 503) — this screen's own
    // words, naming the button to press again; nothing was handed back.
    if (err instanceof AppError && err.statusCode === 503) throw new AppError(503, stripeUnreachableWords(part.kind))
    throw err
  }
  const cash = (await press.query<{ id: string; amount: number; blocked: boolean; replaces: string; unit_number: string | null; lease_id: string }>(
    `SELECT rp.id, rp.amount::float AS amount, rp.replaces_part_id AS replaces, un.unit_number, pc.lease_id,
            COALESCE(${cashAfterTakenBackSql('rp')}, FALSE) AS blocked
       FROM stay_refund_parts rp
       JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
       JOIN leases l ON l.id = pc.lease_id LEFT JOIN units un ON un.id = l.unit_id
      WHERE rp.replaces_part_id = $1 AND rp.kind = 'cash' AND rp.status = 'handed_back'`, [partId])).rows[0]
  const handedNow = !!cash && out.words.some((w) => /^Hand back /.test(w))
  if (handedNow) {
    // Who pressed, so a later look can name them (never an unconditional order to someone else).
    await press.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value) VALUES ($1, $2, 'stay_refund_part', $3, $4)`,
      [actor.userId, CASH_PRESS_AUDIT_ACTION, cash!.id, JSON.stringify({ replaced_part_id: partId, amount: Number(cash!.amount), lease_id: leaseId })])
      .catch((err) => logger.error({ err, partId }, '[paid-ahead-choice] could not record who pressed a cash hand-back'))
  }
  // Choice46d fix pass 3 (backstop): the part this cash replaced had already
  // been counted by a dispute or return as given back (it cannot happen while
  // the key is held, but if it ever does): no order — the worker is told not
  // to hand it over, and GAM's admin is told the record needs correcting.
  if (handedNow && cash!.blocked) {
    await alertCashAfterTakenBack({ id: cash!.id, amount: String(cash!.amount), replaces: cash!.replaces, unit_number: cash!.unit_number, lease_id: cash!.lease_id }, { toldNotTo: true })
      .catch((err) => logger.error({ err, partId }, '[paid-ahead-choice] could not tell GAM about cash recorded for money a dispute took'))
    return { leading: [blockedCashWords(part.kind, Number(cash!.amount), true)], leadingHandBack: [false], omit: [cash!.id] }
  }
  // What GAM held is released first (only what it still holds), so the reply names what was.
  await releaseCashInsteadHeld({ choiceId: part.choice_id })
    .catch((err) => logger.error({ err, partId }, '[paid-ahead-choice] could not release money GAM held for a refund handed back in cash'))
  const released = cash ? Number((await press.query<{ a: number }>(
    `SELECT COALESCE((SELECT h.amount FROM held_payout_items h WHERE h.source_type = 'prepaid_draw' AND h.source_id = 'cash-part:' || $1::text), 0)::float AS a`,
    [cash.id])).rows[0]?.a ?? 0) : 0
  // Review fix (choice46c): the press comes BEFORE the hand-back. Stripe was
  // asked first (givePartBackInCash): only when the refund never reached the
  // card or bank does the reply carry the order, in the gold box (handBack) —
  // so no cash leaves the drawer for a refund that already went out (then
  // the reply says that instead, and nothing is handed back).
  if (handedNow) return { leading: cashPressWords(part.kind, cash!.amount, released), leadingHandBack: [true, false], omit: [cash!.id] }
  return { leading: out.words.filter((w) => !/^Hand back /.test(w)), leadingHandBack: [], omit: [] }
}

/**
 * Choice46e (review): let go of a session advisory lock taken on a pooled
 * client. True when it was let go of; false when the unlock itself failed —
 * the connection may still hold the key.
 */
export async function unlockSession(c: Pick<PoolClient, 'query'>, key: string): Promise<boolean> {
  try {
    await c.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key])
    return true
  } catch (err) {
    logger.error({ err, key }, '[paid-ahead-choice] could not let go of a session lock — the connection is closed so the lock goes with it')
    return false
  }
}

/**
 * Choice46e (review): give a pooled client back after a session advisory lock.
 * If the unlock failed (`unlocked` false), the connection is destroyed
 * (release(true)) rather than returned to the pool, so Postgres frees the
 * session lock with it — never a pooled connection that keeps the key, which
 * would answer every later press "busy" and every dispute "try again" until
 * the connection was recycled.
 */
export function releaseAfterSessionLock(c: Pick<PoolClient, 'release'>, unlocked: boolean): void {
  if (unlocked) c.release()
  else c.release(true)
}

/** Choice46d fix pass 3: a session advisory lock, tried for up to `waitMs` (never waiting on it forever). */
async function tryAdvisoryLock(c: PoolClient, key: string, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs
  for (;;) {
    if ((await c.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key])).rows[0]?.ok) return true
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ─── The owner's to-do ───────────────────────────────────────────────────────

/**
 * Every ended lease still waiting on this choice (paid-ahead money left), and
 * every refund of this screen that did not go out — each opens the screen.
 * `propertyIds` (review fix, choice46b pass 2): a property-locked worker's
 * properties (getScopedPropertyIds; null = every property) — the to-do never
 * lists a lease the screen would refuse them. The caller lists none at all
 * for staff without "Issue refunds" (the screen needs it).
 */
export async function paidAheadChoiceTodos(
  landlordIds: readonly string[], opts: { propertyIds?: readonly string[] | null } = {},
): Promise<Array<{ id: string; type: string; title: string; subtitle: string; href: string }>> {
  if (!landlordIds.length) return []
  const props = opts.propertyIds == null ? null : [...opts.propertyIds]
  if (props && !props.length) return []
  // Choice46d: a refund counted as owed again that came back failed is put
  // right before the to-do is read (it would otherwise ask for cash the
  // dispute already gave back).
  await undoOwedAgain({ landlordIds }).catch((err) => logger.error({ err }, '[paid-ahead-choice] could not undo a refund owed again'))
  const rows = await query<any>(
    `SELECT l.id, u.unit_number, pr.name AS property_name, to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
            SUM(${usablePaidAheadSql('c', 'dc')})::float AS left_amount,
            (SELECT COALESCE(NULLIF(TRIM(CONCAT(us.first_name, ' ', us.last_name)), ''), us.email)
               FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users us ON us.id = t.user_id
              WHERE lt.lease_id = l.id AND lt.status <> 'void' ORDER BY (lt.role = 'primary') DESC, lt.created_at LIMIT 1) AS tenant_name
       FROM leases l
       JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
       JOIN lease_prepaid_credits c ON c.lease_id = l.id AND c.voided_at IS NULL AND c.amount_remaining > 0
                                   AND NOT ${leftHereSql('c')}
       ${disputeClaimJoinSql('c', 'dc')}
      WHERE l.landlord_id = ANY($1::uuid[]) AND ${endedLeaseSql('l', 'pr')}
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
        -- A stay whose own check-out money question is still open has that to-do instead.
        AND NOT EXISTS (SELECT 1 FROM stay_checkout_decisions sd WHERE sd.lease_id = l.id AND sd.status = 'pending')
      GROUP BY l.id, u.unit_number, pr.name, l.end_date
     HAVING SUM(${usablePaidAheadSql('c', 'dc')}) > 0.005
      ORDER BY l.end_date NULLS LAST, l.id`, [[...landlordIds], props])
  // Review fix pass 3: a part whose register sale was already refunded at the
  // register (no room left on the sale) is not "send it again" — it says so.
  // Choice46c: neither is one whose payment was disputed or returned by the
  // bank (it takes no refund: give it back in cash instead); one a dispute
  // already took back (PAID_AHEAD_PART_TAKEN_BACK) needs nothing, so it is not
  // on the to-do at all.
  const retry = await query<any>(
    `SELECT pc.lease_id, u.unit_number, pr.name AS property_name, SUM(x.amount)::float AS amount, x.why, x.dest
       FROM (SELECT rp.paid_ahead_choice_id, rp.amount,
                    -- Where an unrecorded refund went (named on its to-do); one to-do per lease for the rest.
                    CASE WHEN rp.status = 'failed' AND COALESCE(rp.failure ~ $4, FALSE) THEN rp.kind ELSE NULL END AS dest,
                    -- A refund that went out but was not recorded only needs recording (Try again).
                    CASE WHEN rp.status = 'failed' AND COALESCE(rp.failure ~ $4, FALSE) THEN 'not_recorded'
                         WHEN rp.status = 'failed' AND COALESCE(${saleRoomSql('rp')} < rp.amount - 0.005, FALSE) THEN 'no_room'
                         -- Choice46d (review): one still "sending" is being stopped (opening it stops it); one stopped is offered as cash.
                         WHEN ${fundingTakenBackSql('rp.stripe_payment_intent_id')} AND rp.status = 'pending' THEN 'stopping'
                         WHEN ${fundingTakenBackSql('rp.stripe_payment_intent_id')} THEN 'disputed'
                         ELSE 'send' END AS why
               FROM stay_refund_parts rp
              WHERE rp.kind IN ('card', 'bank') AND ${livePartSql('rp')}
                AND rp.failure IS DISTINCT FROM $3
                AND (rp.status = 'failed' OR (rp.status = 'pending' AND rp.created_at < NOW() - INTERVAL '10 minutes'))) x
       JOIN paid_ahead_choices pc ON pc.id = x.paid_ahead_choice_id
       JOIN leases l ON l.id = pc.lease_id JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
      WHERE pc.landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
      GROUP BY pc.lease_id, u.unit_number, pr.name, x.why, x.dest
      ORDER BY pc.lease_id, x.why, x.dest`, [[...landlordIds], props, PAID_AHEAD_PART_TAKEN_BACK, REFUND_NOT_RECORDED_PATTERN])
  // A lease whose move-out is not done yet (decisions #46.2) is still listed —
  // so it is never forgotten — but says what comes first.
  // Review fix pass 3: the to-do never tells the owner to refund money the
  // screen will not refund (a stay's check-out answered it, card money it
  // cannot reach yet, or no payment on file) — it names what the screen offers.
  const tail = new Map<string, string>()
  for (const r of rows) {
    const w = await waitsFor(poolQ, r.id, true)
    if (w) { tail.set(r.id, w.todo); continue }
    const ctx = await buildCtx(poolQ, r.id, false)
    const refundable = ctx.sources.reduce((a, s) => a + s.refundable, 0)
    tail.set(r.id, refundable > 0.005 ? 'refund it, keep it, or leave it as their credit' : 'keep it, or leave it as their credit')
  }
  return [
    ...rows.map((r) => ({
      id: `paid-ahead-${r.id}`,
      type: 'paid_ahead_choice',
      title: `Decide the money paid ahead: ${r.tenant_name || 'a tenant'} (${r.unit_number})`,
      subtitle: `${r.property_name} · ${money(Number(r.left_amount) || 0)} paid ahead is still on a lease that ended`
        + (r.end_date ? ` ${shortDay(r.end_date)}` : '')
        + ` — ${tail.get(r.id)}`,
      href: paidAheadChoicePath(r.id),
    })),
    ...retry.map((r) => (r.why === 'not_recorded'
      // Review fix (choice46c pass 3): the refund DID go back — GAM only has to
      // finish recording it. Never "send it again" / "has not gone back", and
      // nothing is to be handed back at the desk for it.
      ? {
          id: `paid-ahead-refund-record-${r.lease_id}-${r.dest}`,
          type: 'paid_ahead_refund_retry',
          title: `Finish recording a refund: money paid ahead on ${r.unit_number}`,
          subtitle: `${r.property_name} · ${money(Number(r.amount) || 0)} already went back to ${r.dest === 'bank' ? 'their bank' : 'the card'} — GAM only has to finish recording it. Do not hand anything back.`,
          href: paidAheadChoicePath(r.lease_id),
        }
      : r.why === 'no_room'
      ? {
          id: `paid-ahead-refund-sale-${r.lease_id}`,
          type: 'paid_ahead_refund_retry',
          title: `Check a refund: money paid ahead on ${r.unit_number}`,
          subtitle: `${r.property_name} · ${money(Number(r.amount) || 0)} was not sent — that sale was already refunded at the register. Check what they got back.`,
          href: paidAheadChoicePath(r.lease_id),
        }
      // Choice46d (review): never an order to hand cash over from the to-do —
      // the screen's press checks the card first and says when.
      : r.why === 'disputed' || r.why === 'stopping'
      ? {
          id: `paid-ahead-refund-${r.why === 'stopping' ? 'stop' : 'cash'}-${r.lease_id}`,
          type: 'paid_ahead_refund_retry',
          title: `A refund needs you: money paid ahead on ${r.unit_number}`,
          subtitle: `${r.property_name} · ${money(Number(r.amount) || 0)} cannot go back the way it was paid — that payment was disputed or returned by the bank. `
            + (r.why === 'stopping'
              ? `Open it: GAM stops the refund, then offers "${CASH_BUTTON}" and tells you when to hand the cash over.`
              : `Open it and press "${CASH_BUTTON}" — GAM first checks that it did not go out, then tells you when to hand the cash over.`),
          href: paidAheadChoicePath(r.lease_id),
        }
      : {
          id: `paid-ahead-refund-${r.lease_id}`,
          type: 'paid_ahead_refund_retry',
          title: `Send the refund again: money paid ahead on ${r.unit_number}`,
          subtitle: `${r.property_name} · ${money(Number(r.amount) || 0)} has not gone back to them yet`,
          href: paidAheadChoicePath(r.lease_id),
        })),
  ]
}

