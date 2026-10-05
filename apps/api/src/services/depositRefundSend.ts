/**
 * 10/4 (decisions #47a, Nic, FINAL) — SENDING THE DEPOSIT REFUND GAM HOLDS.
 *
 *   "land it on a to do list if original payment cant complete. especially if
 *    theres a split such as landlord keeping half. we need to verify both
 *    parts of that flow."
 *
 * When the landlord finalizes a move-out (depositReturn.finalizeDepositReturn)
 * the refund is split by who holds each part (decisions #46.3, refundSplit):
 *
 *   - THE PART GAM HOLDS (deposit_returns.refund_from_gam) IS SENT
 *     AUTOMATICALLY, back the way the deposit was paid: a card to that same
 *     card, a bank payment to that same bank (decisions #37.B, #38 Q3/Q10).
 *     It goes through the SAME refund parts the early check-out and the
 *     paid-ahead money screen use (stay_refund_parts; services/earlyCheckOut:
 *     planRefund, runCardPart, "Give it back in cash instead", and the
 *     refund.updated webhook's stripeRefundFailed) — one part per original
 *     deposit payment, most recent first — so a retry, a failure and a late
 *     answer from Stripe work exactly the same way. Only what GAM holds is
 *     sent (#46.3: "GAM refunds only money GAM holds"): the deposit itself,
 *     never a card fee on top, and nothing comes off the landlord's payout
 *     (payout_drop 0 — it is GAM's balance that pays it back).
 *   - A PART THE ORIGINAL PAYMENT CANNOT TAKE — too old for the card company
 *     or bank, a closed card, a refund that failed for good, or no Stripe
 *     payment behind it at all (deposit interest, a deposit record raised
 *     without one) — lands on the owner's to-do list (depositRefundTodos) in
 *     plain words with the next step: give it back in cash at the office
 *     ("Give it back in cash instead" — GAM then pays the landlord what it held
 *     for it, once, on their next payout), or Try again when trying again can
 *     work. GAM is told too (an admin notice). It never silently disappears
 *     and never stays GAM's money.
 *   - THE PART THE LANDLORD HOLDS (refund_from_landlord) is theirs to hand
 *     back; the move-out page offers "Mark handed back" with the day
 *     (deposit_returns.landlord_part_handed_back_on), so it shows done, and
 *     until then it is on their to-do list.
 *   - NOTHING SAYS WHO HOLDS WHAT (#47c). The tenant is told only how each
 *     part reaches them: "$X back to your card", "$Y returned to you at the
 *     office" (refundReachWords).
 *
 * The move-out's refund row (deposit_returns.refund_payment_id, a negative
 * 'fee' DEPOSIT row) stays 'pending' while any part GAM holds still has to go
 * out, and is 'settled' once every one has gone back (sent, given back in
 * cash, or taken back by a dispute) — syncDepositRefundRow. GAM's balance
 * book must count, as money it owes the tenant, exactly the parts still open
 * (depositRefundsOwedSql), so the money GAM holds stays counted until each
 * part is actually sent and a split refund is never counted whole
 * (stripeCosts.loadPlatformBalanceBook reads it).
 *
 * A dispute or bank return of the original deposit payment AFTER the move-out
 * (decisions #51): the reversal reopens the deposit charge on the tenant's
 * balance (services/paymentReversal — the normal returned-payment recovery).
 * A refund part already sent stays sent: the tenant owes the refunded part
 * again on that reopened charge, and GAM is alerted. Of a part not sent yet,
 * only as much as the dispute or return actually took is stopped (that much
 * already went back to the tenant through their card company or bank); the
 * rest stays a live part, still owed to the tenant (Try again, or cash at the
 * office). The reopened charge is lowered by exactly the share stopped, so
 * nothing is owed twice and nothing stays GAM's (noteDepositRefundOfReturnedPayment).
 * The share the deductions KEPT, already paid to the landlord, is asked back
 * of them on their next payout, and the tenant's repayment of the reopened
 * charge refills GAM and pays that back to them once (decisions #54 —
 * paymentReversal.settleDepositKeptSide / resolveReversalOnTenantPayment).
 */
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { todayIn, dateIn } from '../lib/timezone'
import { lockHousehold } from './moneyPredicates'
import { replyToProperty } from './replyRouting'
import {
  planRefund, runCardPart, givePartBackInCash, findSentRefund, livePartSql, money,
  DEPOSIT_PART_TOO_OLD, DEPOSIT_PART_DISPUTED, DEPOSIT_PART_TAKEN_BACK, type MoneySource,
} from './earlyCheckOut'

const toCents = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100)
const toDollars = (c: number) => Math.round(c) / 100

// ─── Words ───────────────────────────────────────────────────────────────────

/**
 * The cash way out, said so the press comes FIRST (fix pass 2): the button
 * checks the part fresh and only then says "Hand back $X in cash now." — so
 * no cash leaves the drawer for a refund that already reached the card.
 */
const PRESS_CASH_FIRST = 'Press "Give it back in cash instead" — it tells you when to hand over the cash.'

/** A part with no card or bank payment behind it (deposit interest, a deposit record raised without one). */
export const DEPOSIT_PART_NO_PAYMENT = 'This part of the deposit was not paid by a card or bank payment GAM can send it back to, so nothing was sent. ' +
  PRESS_CASH_FIRST

/** A part not sent yet whose payment the tenant disputed, or their bank returned, since (decisions #51). Defined by the runner (fix pass 3). */
export { DEPOSIT_PART_TAKEN_BACK }

/** "went out but GAM could not record it" (earlyCheckOut.sendCardPart) — only recorded on Try again, never handed back too. */
const NOT_RECORDED = /^The refund went to /

/** Failures Try again cannot fix: only the cash way out is left. */
const CASH_ONLY = [DEPOSIT_PART_TOO_OLD, DEPOSIT_PART_DISPUTED, DEPOSIT_PART_NO_PAYMENT] as const
const isCashOnly = (failure: string | null) => !!failure && (CASH_ONLY as readonly string[]).includes(failure)
const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * How a deposit payment was paid, read from GAM's own records: its receipt
 * (by charge, or by what the receipt paid), else a bank trace number. NULL
 * when none says — the charge itself is then asked (confirmPartKind).
 */
const depositMethodSql = (p: string) => `COALESCE(
    (SELECT r.payment_method FROM tenant_remittances r
      WHERE r.stripe_payment_intent_id = ${p}.stripe_payment_intent_id ORDER BY r.created_at LIMIT 1),
    (SELECT r.payment_method FROM remittance_applications ra JOIN tenant_remittances r ON r.id = ra.remittance_id
      WHERE ra.payment_id = ${p}.id ORDER BY r.created_at LIMIT 1),
    CASE WHEN ${p}.ach_trace_number IS NOT NULL THEN 'ach' END)`

/** Refused when the part the landlord marks is not the one the page showed (fresh at the moment of action). */
export const LANDLORD_PART_CHANGED = 'The amount to hand back changed since you opened this, so nothing was marked. ' +
  'The page now shows the new amount — look it over and mark it again.'

const WAITS_MINUTES = 10
const PRESS_WAIT_MS = 3000

/**
 * How each part of a move-out refund reaches the tenant (decisions #47c, Nic:
 * never who holds it). "$400.00 back to your card; $50.00 returned to you at
 * the office." Empty when nothing is refunded.
 *
 * Fix pass 3: `voice: 'staff'` says the same thing to the owner or a team
 * member — "$400.00 back to the card they paid with; $50.00 back to them in
 * cash at the office." — so "your card" is never read as the owner's own card
 * or "returned to you" as money coming to them. Fix pass 4: it says HOW each
 * part reaches them, never that it already did ("handed back" read as done
 * before anyone had handed anything over) — the refund card below says where
 * each part stands. The tenant's statement, email and refund row keep the
 * tenant's voice.
 */
export function refundReachWords(o: { card: number; bank: number; office: number }, opts: { voice?: 'tenant' | 'staff' } = {}): string {
  const staff = opts.voice === 'staff'
  const bits: string[] = []
  if (toCents(o.card) > 0) bits.push(`${money(o.card)} back to ${staff ? 'the card they paid with' : 'your card'}`)
  if (toCents(o.bank) > 0) bits.push(`${money(o.bank)} back to ${staff ? 'the bank they paid from' : 'your bank'}`)
  if (toCents(o.office) > 0) bits.push(`${money(o.office)} ${staff ? 'back to them in cash' : 'returned to you'} at the office`)
  if (!bits.length) return ''
  const s = bits.join('; ')
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`
}

// ─── Finalize: the parts ─────────────────────────────────────────────────────

/** The deposit payment a part goes back to, as finalize reads it. */
interface GamDepositPayment {
  id: string; amount: number; intent: string | null; method: string | null; paid_at: Date | null; already: number
}

/**
 * Inside finalize's transaction (its locks held): the parts that send back
 * `refundFromGam` — the part of the refund GAM holds — through the deposit
 * payments GAM took (`gamPayments`, refundSplit.gamParts), each back to
 * itself, most recent first (earlyCheckOut.planRefund), never more than the
 * payment. What no card or bank payment can carry is one 'cash' part, failed
 * with the plain words and the next step (DEPOSIT_PART_NO_PAYMENT): it is on
 * the owner's to-do list from the start. Card and bank parts are 'pending';
 * sendDepositRefund sends them after the commit.
 *
 * Returns how each part reaches the tenant (refundReachWords).
 */
export async function planDepositRefundParts(client: PoolClient, o: {
  draftId: string; landlordId: string; refundFromGam: number
  gamPayments: ReadonlyArray<{ id: string; label: string }>
}): Promise<{ card: number; bank: number; office: number; noPayment: number }> {
  const out = { card: 0, bank: 0, office: 0, noPayment: 0 }
  const total = toCents(o.refundFromGam)
  if (total <= 0) return out
  const labels = new Map(o.gamPayments.map((p) => [p.id, p.label]))
  const pays = o.gamPayments.length === 0 ? [] : (await client.query<GamDepositPayment>(
    `SELECT p.id, p.amount::float AS amount, p.stripe_payment_intent_id AS intent,
            ${depositMethodSql('p')} AS method,
            COALESCE(p.settled_at, p.created_at) AS paid_at,
            COALESCE((SELECT SUM(rp.toward_amount) FROM stay_refund_parts rp
                       WHERE rp.deposit_payment_id = p.id AND ${livePartSql('rp')}), 0)::float AS already
       FROM payments p
      WHERE p.id = ANY($1::uuid[])
      ORDER BY COALESCE(p.settled_at, p.created_at) DESC, p.id DESC`,
    [o.gamPayments.map((p) => p.id)])).rows
  const day = (d: Date | null) => d
    ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''
  // Only a payment with a Stripe charge behind it can take a refund. One whose
  // records do not say how it was paid starts as a card part; the charge
  // itself is asked before anything is sent (confirmPartKind).
  const sources: MoneySource[] = pays.filter((p) => !!p.intent).map((p) => {
    const kind = p.method === 'ach' ? 'bank' : 'card'
    const what = labels.get(p.id) ?? 'Deposit'
    return {
      key: p.id, kind, label: `${kind === 'bank' ? 'Bank payment' : 'Card'} · ${what.toLowerCase()} ${day(p.paid_at)}`.trim(),
      toward: p.amount, paid: p.amount, refundable: Math.max(0, toDollars(toCents(p.amount) - toCents(p.already))),
      paidAt: new Date(p.paid_at ?? 0).toISOString(), feeRate: 0, landlordFeeRate: 0, taxRate: 0,
      stayPaymentId: null, posTransactionId: null, remittanceId: null, paymentIntentId: p.intent, method: p.method ?? 'card',
    }
  })
  const plan = planRefund(sources, toDollars(total))
  let seq = 0
  let planned = 0
  for (const p of plan) {
    seq++
    planned += toCents(p.toward)
    // Only what GAM holds goes back: the deposit dollars, no card fee on top,
    // and nothing off the landlord's payout (it is GAM's balance that pays).
    await client.query(
      `INSERT INTO stay_refund_parts
         (deposit_return_id, landlord_id, seq, kind, deposit_payment_id, stripe_payment_intent_id,
          toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7, 0, 0, $8, 'pending')`,
      [o.draftId, o.landlordId, seq, p.kind, p.source.key, p.source.paymentIntentId, p.toward.toFixed(2), p.source.label])
    if (p.kind === 'bank') out.bank += toCents(p.toward)
    else out.card += toCents(p.toward)
  }
  const rest = total - planned
  if (rest > 0) {
    seq++
    await client.query(
      `INSERT INTO stay_refund_parts
         (deposit_return_id, landlord_id, seq, kind, toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share,
          label, status, failure)
       VALUES ($1, $2, $3, 'cash', $4, 0, $4, 0, 0, $5, 'failed', $6)`,
      [o.draftId, o.landlordId, seq, toDollars(rest).toFixed(2), 'Not paid by card or bank', DEPOSIT_PART_NO_PAYMENT])
    out.office += rest
    out.noPayment += rest
  }
  return { card: toDollars(out.card), bank: toDollars(out.bank), office: toDollars(out.office), noPayment: toDollars(out.noPayment) }
}

/**
 * The refund row follows the parts GAM holds: 'pending' while any of them
 * still has to go back, 'settled' (on the day the last one went) once none
 * does. Only a move-out that recorded who sends what (refund_from_gam set) and
 * whose row is still a live refund row. Never throws.
 */
export async function syncDepositRefundRow(draftId: string, runner?: Pick<PoolClient, 'query'>): Promise<void> {
  const sql = `
    UPDATE payments rp
       SET status = CASE WHEN x.open THEN 'pending' ELSE 'settled' END,
           settled_at = CASE WHEN x.open THEN NULL ELSE COALESCE(rp.settled_at, x.last_done, NOW()) END
      FROM deposit_returns dr
      CROSS JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM stay_refund_parts p
                        WHERE p.deposit_return_id = dr.id AND ${openPartSql('p')}) AS open,
               (SELECT MAX(p.refunded_at) FROM stay_refund_parts p
                 WHERE p.deposit_return_id = dr.id AND ${livePartSql('p')}) AS last_done
      ) x
     WHERE dr.id = $1 AND dr.finalized_at IS NOT NULL AND dr.refund_from_gam IS NOT NULL
       AND rp.id = dr.refund_payment_id AND rp.amount < 0 AND rp.status IN ('pending', 'settled')
       AND rp.status <> CASE WHEN x.open THEN 'pending' ELSE 'settled' END`
  try {
    if (runner) await runner.query(sql, [draftId])
    else await query(sql, [draftId])
  } catch (err) {
    logger.error({ err, draftId }, '[deposit-refund] could not bring the refund row up to date')
  }
}

/** SQL on a stay_refund_parts alias: a move-out part that still has to go back (failed, or waiting to be sent). */
export function openPartSql(p: string): string {
  return `(${livePartSql(p)} AND ${p}.status IN ('pending', 'failed') AND ${p}.failure IS DISTINCT FROM '${DEPOSIT_PART_TAKEN_BACK.replace(/'/g, "''")}')`
}

/**
 * Fix pass 5 (review, #47a "every dollar counted once"): ONE query, one row
 * `amt` — the move-out refund money GAM holds and still has to send back,
 * for GAM's balance book (stripeCosts.loadPlatformBalanceBook, refundsOwed).
 *
 * The refund row (syncDepositRefundRow) stays 'pending' while ANY part GAM
 * holds is still open, so counting all of refund_from_gam while it is pending
 * overstates a split refund: $300 back to the card and $200 failed is $200
 * still owed, not $500. This counts what is really left:
 *   - each open part of a finalized move-out (openPartSql: waiting to be
 *     sent, or failed and on the owner's to-do list), less a part whose money
 *     already reached the card or bank and only its record is missing ("The
 *     refund went to …" — it already left GAM's balance);
 *   - plus a finalized move-out from before the refund parts existed (no part
 *     at all): its refund_from_gam while its refund row is pending, as before.
 * A part given back in cash is not here: it is the landlord's payout line
 * (held_payout_items 'deposit_settlement', 'cash-part:<part>').
 *
 * Known, self-correcting: a card or bank part still 'pending' whose earlier
 * try reached Stripe (attempts > 0) but whose answer was lost may already
 * have left GAM's balance; it counts as owed until the part is run again —
 * by the move-out page, Try again, or the sweep resumeStaleDepositRefunds
 * (every part left "sending" more than 10 minutes), which finds the refund
 * Stripe already made and records it, so nothing goes out twice.
 */
export function depositRefundsOwedSql(): string {
  return `SELECT COALESCE(SUM(x.amt), 0)::float AS amt FROM (
      SELECT p.toward_amount AS amt
        FROM stay_refund_parts p
        JOIN deposit_returns dr ON dr.id = p.deposit_return_id
       WHERE dr.finalized_at IS NOT NULL AND ${openPartSql('p')}
         AND NOT (p.status = 'failed' AND p.failure IS NOT NULL AND p.failure ~ '^The refund went to ')
      UNION ALL
      SELECT dr.refund_from_gam AS amt
        FROM deposit_returns dr
        JOIN payments rp ON rp.id = dr.refund_payment_id
       WHERE dr.finalized_at IS NOT NULL AND dr.refund_from_gam > 0 AND rp.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM stay_refund_parts p0 WHERE p0.deposit_return_id = dr.id)
    ) x`
}

/**
 * After finalize's commit: send the card and bank parts still waiting (each
 * through earlyCheckOut.runCardPart — the same runner, key and safety as every
 * other refund part), bring the refund row up to date, and tell the owner and
 * GAM about a part with no payment to go back to. Never throws.
 */
export async function sendDepositRefund(draftId: string): Promise<void> {
  try {
    const waiting = await query<{ id: string }>(
      `SELECT p.id FROM stay_refund_parts p
        WHERE p.deposit_return_id = $1 AND p.status = 'pending' AND p.kind IN ('card', 'bank')
        ORDER BY p.seq`, [draftId])
    let kindChanged = false
    for (const p of waiting) {
      if (await confirmPartKind(p.id)) kindChanged = true
      await runCardPart(p.id).catch((err) => logger.error({ err, partId: p.id }, '[deposit-refund] a refund could not be sent'))
    }
    // The refund row's note says how each part reaches the tenant (finalize
    // wrote it from the plan): said again when a part turned out to be a bank one.
    if (kindChanged) {
      const dr = await queryOne<{ from_landlord: number }>(
        `SELECT COALESCE(refund_from_landlord, 0)::float AS from_landlord FROM deposit_returns WHERE id = $1`, [draftId])
      const words = refundReachWords(await reachOf(draftId, Number(dr?.from_landlord ?? 0)))
      if (words) {
        await query(
          `UPDATE payments SET notes = regexp_replace(notes, '(deducted\\. ).*$', '\\1' || $2)
            WHERE id = (SELECT refund_payment_id FROM deposit_returns WHERE id = $1) AND notes ~ 'deducted\\. '`,
          [draftId, words])
      }
    }
    // A part with no payment behind it was failed from the start (no
    // pending→failed step tells about it): told once, here.
    const noPayment = await query<{ id: string }>(
      `SELECT p.id FROM stay_refund_parts p
        WHERE p.deposit_return_id = $1 AND p.kind = 'cash' AND p.status = 'failed' AND p.failure = $2
        ORDER BY p.seq`, [draftId, DEPOSIT_PART_NO_PAYMENT])
    for (const p of noPayment) await tellDepositPartFailed(p.id, 'no_payment')
  } catch (err) {
    logger.error({ err, draftId }, '[deposit-refund] sending the refund failed')
  } finally {
    await syncDepositRefundRow(draftId)
  }
}

/**
 * Fix pass 2: a part planned as 'card' because GAM's records did not say how
 * its payment was made (no receipt, no bank trace) — the charge is asked
 * before the part is sent, so a bank payment is said and sent as a bank part
 * ("back to your bank"), never "back to your card". Stripe unreachable: the
 * part stays as planned (the refund still goes back to the same charge; only
 * the words could be off). Never throws.
 */
async function confirmPartKind(partId: string): Promise<boolean> {
  try {
    const r = await queryOne<{ kind: string; intent: string | null; method: string | null }>(
      `SELECT p.kind, p.stripe_payment_intent_id AS intent, ${depositMethodSql('dp')} AS method
         FROM stay_refund_parts p JOIN payments dp ON dp.id = p.deposit_payment_id
        WHERE p.id = $1 AND p.status = 'pending' AND p.kind IN ('card', 'bank')`, [partId])
    if (!r?.intent || r.method) return false
    const { getStripe } = await import('../lib/stripe')
    const pi: any = await (getStripe() as any).paymentIntents.retrieve(r.intent)
    const types: string[] = Array.isArray(pi?.payment_method_types) ? pi.payment_method_types : []
    const kind = types.includes('us_bank_account') && !types.includes('card') ? 'bank' : 'card'
    if (kind === r.kind) return false
    await query(
      `UPDATE stay_refund_parts
          SET kind = $2,
              label = CASE WHEN $2 = 'bank' THEN regexp_replace(label, '^Card · ', 'Bank payment · ')
                           ELSE regexp_replace(label, '^Bank payment · ', 'Card · ') END
        WHERE id = $1 AND status = 'pending'`, [partId, kind])
    return true
  } catch (err) {
    logger.warn({ err, partId }, '[deposit-refund] could not ask Stripe how a deposit was paid — sent as planned')
    return false
  }
}

// ─── Telling ─────────────────────────────────────────────────────────────────

interface PartCtx {
  id: string; deposit_return_id: string; landlord_id: string; lease_id: string; unit_number: string | null
  property_name: string | null; tenant_name: string | null; amount: number; kind: string
}

async function partCtx(partId: string): Promise<PartCtx | null> {
  return queryOne<PartCtx>(
    `SELECT p.id, p.deposit_return_id, p.landlord_id, dr.lease_id, un.unit_number, pr.name AS property_name,
            NULLIF(btrim(CONCAT(u.first_name, ' ', u.last_name)), '') AS tenant_name,
            p.amount::float AS amount, p.kind
       FROM stay_refund_parts p
       JOIN deposit_returns dr ON dr.id = p.deposit_return_id
       JOIN leases l ON l.id = dr.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
       LEFT JOIN tenants t ON t.id = dr.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE p.id = $1`, [partId])
}

const moveOutPage = (leaseId: string) => `/leases/${leaseId}/deposit-return`

/**
 * A part of a move-out refund did not go out (earlyCheckOut.markFailed and
 * stripeRefundFailed call this for a move-out part; sendDepositRefund for a
 * part with no payment). The owner is told in plain words with the next step
 * (their notice opens the move-out page, where the part is listed with its
 * buttons, and it is on their to-do list), and GAM is told too. Never throws.
 */
export async function tellDepositPartFailed(
  partId: string,
  why: 'not_sent' | 'not_recorded' | 'turned_down' | 'no_room' | 'too_old' | 'disputed' | 'sent_back' | 'no_payment',
): Promise<void> {
  try {
    const p = await partCtx(partId)
    if (!p) return
    const who = p.tenant_name ?? 'the tenant'
    const where = p.kind === 'bank' ? 'their bank' : 'their card'
    const amt = money(p.amount)
    const said = why === 'not_recorded' ? `The ${amt} deposit refund to ${who} went to ${where}, but GAM could not finish recording it.`
      : why === 'turned_down' ? `The ${amt} deposit refund to ${who} was turned down by ${p.kind === 'bank' ? 'their bank' : 'the card company'}.`
      : why === 'sent_back' ? `The ${amt} deposit refund to ${who} could not reach ${where} and came back.`
      : why === 'too_old' ? `The ${amt} deposit refund to ${who} could not go back to ${where}: the payment is too old for a refund.`
      : why === 'disputed' ? `The ${amt} deposit refund to ${who} could not go back to ${where}: they disputed the payment it came from.`
      : why === 'no_payment' ? `${amt} of ${who}'s deposit refund was not paid by a card or bank payment it can go back to.`
      : `The ${amt} deposit refund to ${who} could not be sent to ${where}.`
    // Fix pass 2: the press comes first — the button says when to hand the
    // cash over — and never who held the money (#47c).
    const next = why === 'not_recorded'
      ? 'Open the move-out and press Try again to finish recording it — hand nothing back in cash.'
      : why === 'too_old' || why === 'no_payment' || why === 'disputed'
        ? `Open the move-out and press "Give it back in cash instead" — it tells you when to hand over the cash, and ${amt} is added to your next payout.`
        : `Open the move-out and press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash, and ${amt} is added to your next payout.`
    const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [p.landlord_id])
    if (owner) {
      const { createNotification } = await import('./notifications')
      await createNotification({
        userId: owner.user_id, landlordId: p.landlord_id, type: 'deposit_refund_failed',
        title: why === 'sent_back' ? `A deposit refund to ${who} came back` : `A deposit refund to ${who} did not go out`,
        body: `${said} ${next}`,
        data: { leaseId: p.lease_id, depositReturnId: p.deposit_return_id, partId },
        actionUrl: moveOutPage(p.lease_id),
      })
    }
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn', category: 'deposit_refund_part_failed',
      title: `A move-out deposit refund did not go out (${p.unit_number ?? 'a space'}${p.property_name ? `, ${p.property_name}` : ''})`,
      body: `${said} It is on the owner's to-do list until it is sent or given back in cash at the office (the landlord is then paid that amount on their next payout). ` +
        `Move-out ${p.deposit_return_id}, refund part ${partId}.`,
      context: { deposit_return_id: p.deposit_return_id, lease_id: p.lease_id, part_id: partId, amount: p.amount, why },
    })
  } catch (err) {
    logger.error({ err, partId }, '[deposit-refund] could not tell the owner a refund did not go out')
  }
}

/**
 * The tenant's move-out statement (decisions #47c): how each part of their
 * refund reaches them — never who holds it. In the app and by email, once per
 * move-out (a later change is its own short notice, tellTenantPartNowInCash).
 * Never throws.
 */
export async function tellTenantDepositRefund(draftId: string): Promise<void> {
  try {
    const dr = await tenantOf(draftId)
    if (!dr?.tenant_user_id || toCents(dr.refund) <= 0) return
    const seen = await queryOne(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'deposit_refund_statement'
          AND data->>'depositReturnId' = $2 AND NOT (data ? 'nowInCash') LIMIT 1`,
      [dr.tenant_user_id, draftId])
    if (seen) return
    const reach = await reachOf(draftId, dr.from_landlord)
    const words = refundReachWords(reach)
    if (!words) return
    const { createNotification } = await import('./notifications')
    await createNotification({
      userId: dr.tenant_user_id, type: 'deposit_refund_statement',
      title: `Your deposit refund${dr.unit_number ? ` — ${dr.unit_number}` : ''}`,
      body: `Your move-out${dr.property_name ? ` at ${dr.property_name}` : ''} is final. Your deposit refund is ${money(dr.refund)}: ${words}`,
      data: { depositReturnId: draftId, leaseId: dr.lease_id, refund: dr.refund,
              card: reach.card, bank: reach.bank, office: reach.office, toCardOrBank: reach.toCardOrBank },
      // Fix pass 4: tapping it opens the tenant's Payments page, where the refund row is.
      actionUrl: TENANT_REFUND_PAGE,
      ...(dr.email ? { sendEmail: true, emailTo: dr.email, emailSubject: 'Your deposit refund' } : {}),
      // 10/5: replies reach the people who run this property (services/replyRouting).
      replyTo: replyToProperty(dr.property_id),
    })
  } catch (err) {
    logger.error({ err, draftId }, '[deposit-refund] could not send the tenant their move-out statement')
  }
}

/** The tenant portal's Payments page: the move-out refund row is listed there. */
export const TENANT_REFUND_PAGE = '/payments'

async function tenantOf(draftId: string) {
  return queryOne<{
    lease_id: string; tenant_user_id: string | null; email: string | null; unit_number: string | null
    property_id: string | null; property_name: string | null; refund: number; from_landlord: number; landlord_id: string
  }>(
    `SELECT dr.lease_id, t.user_id AS tenant_user_id, u.email, un.unit_number, un.property_id, pr.name AS property_name,
            dr.refund_amount::float AS refund, COALESCE(dr.refund_from_landlord, 0)::float AS from_landlord, dr.landlord_id
       FROM deposit_returns dr
       JOIN leases l ON l.id = dr.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
       LEFT JOIN tenants t ON t.id = dr.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE dr.id = $1 AND dr.finalized_at IS NOT NULL`, [draftId])
}

/**
 * Fix pass 2: a part the tenant's statement said goes "back to your card" (or
 * bank) was given back in cash at the office instead — the tenant is told, in
 * a short notice of its own, so the statement is never left wrong. Only when
 * their statement counted that part as going to the card or bank. Never throws.
 */
async function tellTenantPartNowInCash(replacedPartId: string): Promise<void> {
  try {
    const p = await queryOne<{ deposit_return_id: string; kind: string; amount: number }>(
      `SELECT deposit_return_id, kind, toward_amount::float AS amount FROM stay_refund_parts WHERE id = $1`, [replacedPartId])
    if (!p?.deposit_return_id) return
    const dr = await tenantOf(p.deposit_return_id)
    if (!dr?.tenant_user_id) return
    const statement = await queryOne<{ ids: string[] | null }>(
      `SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(data->'toCardOrBank', '[]'::jsonb))) AS ids
         FROM notifications WHERE user_id = $1 AND type = 'deposit_refund_statement'
          AND data->>'depositReturnId' = $2 AND NOT (data ? 'nowInCash')
        ORDER BY created_at LIMIT 1`, [dr.tenant_user_id, p.deposit_return_id])
    // The part, or a part it replaced (a refund that came back is replaced by a new part).
    const chain = (await query<{ id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, replaces_part_id FROM stay_refund_parts WHERE id = $1
         UNION ALL
         SELECT p.id, p.replaces_part_id FROM stay_refund_parts p JOIN chain c ON p.id = c.replaces_part_id)
       SELECT id::text AS id FROM chain`, [replacedPartId])).map((r) => r.id)
    if (!chain.some((id) => statement?.ids?.includes(id))) return
    const amt = money(p.amount)
    const { createNotification } = await import('./notifications')
    await createNotification({
      userId: dr.tenant_user_id, type: 'deposit_refund_statement',
      title: `Your deposit refund${dr.unit_number ? ` — ${dr.unit_number}` : ''}: ${amt} at the office`,
      body: `${amt} of your deposit refund could not go back to your ${p.kind === 'bank' ? 'bank' : 'card'}, ` +
        `so it was returned to you at the office instead${dr.property_name ? ` (${dr.property_name})` : ''}.`,
      data: { depositReturnId: p.deposit_return_id, leaseId: dr.lease_id, nowInCash: replacedPartId, amount: p.amount },
      actionUrl: TENANT_REFUND_PAGE,
      ...(dr.email ? { sendEmail: true, emailTo: dr.email, emailSubject: 'Your deposit refund' } : {}),
      // 10/5: replies reach the people who run this property (services/replyRouting).
      replyTo: replyToProperty(dr.property_id),
    })
  } catch (err) {
    logger.error({ err, partId: replacedPartId }, '[deposit-refund] could not tell the tenant a part was given back in cash')
  }
}

/**
 * How the parts reach the tenant now: card and bank parts going (or gone)
 * back, the rest at the office — a card or bank part Try again cannot send
 * (too old, disputed) included, since cash is its only way out. A share the
 * tenant's card company or bank already gave back (a dispute) is not counted.
 */
async function reachOf(draftId: string, fromLandlord: number): Promise<{
  card: number; bank: number; office: number; toCardOrBank: string[]
}> {
  const rows = await query<{ id: string; kind: string; amount: number; failure: string | null }>(
    `SELECT p.id, p.kind, p.toward_amount::float AS amount, p.failure FROM stay_refund_parts p
      WHERE p.deposit_return_id = $1 AND ${livePartSql('p')} AND p.failure IS DISTINCT FROM $2`,
    [draftId, DEPOSIT_PART_TAKEN_BACK])
  let card = 0, bank = 0, office = toCents(fromLandlord)
  const toCardOrBank: string[] = []
  for (const r of rows) {
    const cashOnly = isCashOnly(r.failure)
    if (r.kind === 'card' && !cashOnly) { card += toCents(r.amount); toCardOrBank.push(r.id) }
    else if (r.kind === 'bank' && !cashOnly) { bank += toCents(r.amount); toCardOrBank.push(r.id) }
    else office += toCents(r.amount)
  }
  return { card: toDollars(card), bank: toDollars(bank), office: toDollars(office), toCardOrBank }
}

// ─── The move-out page ───────────────────────────────────────────────────────

export interface DepositRefundPartView {
  id: string; kind: string; label: string; amount: number; status: string
  words: string; can_try_again: boolean; can_give_in_cash: boolean; done: boolean
}
export interface DepositRefundView {
  parts: DepositRefundPartView[]
  /** Still to go back of the part GAM sends (failed or waiting). */
  open_amount: number
  landlord_part: null | { amount: number; handed_back_on: string | null; handed_back_by_name: string | null }
  /** How each part reaches the tenant (#47c), said to the owner or team member (fix pass 3: never "your card"). */
  reach_words: string
}

const shortDay = (d: Date | string | null): string => d == null ? ''
  : new Date(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** One part, in the words the move-out page shows, with the buttons it may offer. */
export function partView(p: { id: string; kind: string; label: string; amount: number; status: string; failure: string | null; refunded_at: Date | string | null; reversed_at?: Date | string | null }): DepositRefundPartView {
  const amt = money(p.amount)
  const card = p.kind === 'card' || p.kind === 'bank'
  const to = p.kind === 'bank' ? 'their bank' : 'the card they paid with'
  const takenBack = p.failure === DEPOSIT_PART_TAKEN_BACK
  // Too old, disputed, or no payment behind it: Try again cannot help.
  const cashOnly = isCashOnly(p.failure)
  const notRecorded = NOT_RECORDED.test(p.failure ?? '')
  let words: string
  if (p.status === 'refunded') words = `${amt} sent back to ${to} (${p.label}) on ${shortDay(p.refunded_at)}.`
  else if (p.status === 'handed_back') words = `${amt} given back in cash at the office on ${shortDay(p.refunded_at)}.`
  else if (p.status === 'pending') words = `${amt} is being sent back to ${to} (${p.label}).`
  else if (takenBack) words = `${amt}: ${DEPOSIT_PART_TAKEN_BACK}`
  else words = `${amt}${card ? ` to ${to} (${p.label})` : ''}: ${p.failure ?? 'it did not go out.'}`
  return {
    id: p.id, kind: p.kind, label: p.label, amount: p.amount, status: p.status, words,
    can_try_again: card && p.status === 'failed' && !takenBack && !cashOnly,
    can_give_in_cash: p.status === 'failed' && !takenBack && !notRecorded,
    done: p.status === 'refunded' || p.status === 'handed_back' || takenBack,
  }
}

/** What the move-out page shows of a finalized refund: each part GAM sends, and the landlord's own part. */
export async function depositRefundView(draftId: string): Promise<DepositRefundView> {
  const parts = await query<any>(
    `SELECT p.id, p.kind, p.label, p.amount::float AS amount, p.status, p.failure, p.refunded_at, p.reversed_at
       FROM stay_refund_parts p
      WHERE p.deposit_return_id = $1 AND ${livePartSql('p')}
      ORDER BY p.seq, p.created_at, p.id`, [draftId])
  const dr = await queryOne<{ from_landlord: number | null; on: string | null; by_name: string | null }>(
    `SELECT dr.refund_from_landlord::float AS from_landlord,
            to_char(dr.landlord_part_handed_back_on, 'YYYY-MM-DD') AS on,
            NULLIF(btrim(CONCAT(u.first_name, ' ', u.last_name)), '') AS by_name
       FROM deposit_returns dr LEFT JOIN users u ON u.id = dr.landlord_part_handed_back_by
      WHERE dr.id = $1`, [draftId])
  const views = parts.map(partView)
  const open = views.filter((v) => !v.done).reduce((t, v) => t + toCents(v.amount), 0)
  const fromLandlord = Number(dr?.from_landlord ?? 0)
  return {
    parts: views,
    open_amount: toDollars(open),
    landlord_part: toCents(fromLandlord) > 0
      ? { amount: fromLandlord, handed_back_on: dr?.on ?? null, handed_back_by_name: dr?.by_name ?? null }
      : null,
    reach_words: refundReachWords(await reachOf(draftId, fromLandlord), { voice: 'staff' }),
  }
}

/**
 * When the move-out page is opened: the refund row is brought up to date.
 * When the viewer may run the move-out (`act`), also: a refund part of a
 * payment the tenant disputed since is stopped for the share the dispute took
 * (noteDepositRefundOfReturnedPayment), and a card or bank part left "sending"
 * for more than 10 minutes (a crash between finalize and Stripe) is sent
 * again — the same runner, which finds a refund an earlier try already made,
 * so nothing goes out twice. Fix pass 2: someone who may only read the
 * move-out never moves money by opening it. Never throws.
 */
export async function resumeDepositRefund(draftId: string, opts: { act?: boolean } = {}): Promise<void> {
  try {
    if (opts.act === false) return
    const returned = await query<{ id: string }>(
      `SELECT DISTINCT dp.id FROM stay_refund_parts p JOIN payments dp ON dp.id = p.deposit_payment_id
        WHERE p.deposit_return_id = $1 AND ${openPartSql('p')} AND dp.status = 'returned'`, [draftId])
    for (const r of returned) await noteDepositRefundOfReturnedPayment(r.id)
    const stale = await query<{ id: string }>(
      `SELECT p.id FROM stay_refund_parts p
        WHERE p.deposit_return_id = $1 AND p.status = 'pending' AND p.kind IN ('card', 'bank')
          AND p.created_at < NOW() - make_interval(mins => ${WAITS_MINUTES})
        ORDER BY p.seq`, [draftId])
    for (const p of stale) await runCardPart(p.id).catch((err) => logger.error({ err, partId: p.id }, '[deposit-refund] resume failed'))
  } catch (err) {
    logger.error({ err, draftId }, '[deposit-refund] could not resume the refund')
  } finally {
    await syncDepositRefundRow(draftId)
  }
}

/**
 * The sweep (deprefund review): every finalized move-out with a card or bank
 * part left "sending" for more than 10 minutes (a crash between finalize and
 * Stripe, an answer lost) is run again by itself, as opening its move-out page
 * would (resumeDepositRefund with act) — so GAM's book and the owner's to-do
 * never wait for someone to open the page. The same runner and key: a refund
 * Stripe already made is found and recorded, never sent twice. Returns how
 * many move-outs it looked at. Never throws.
 */
export async function resumeStaleDepositRefunds(limit = 50): Promise<number> {
  try {
    const rows = await query<{ id: string }>(
      `SELECT DISTINCT p.deposit_return_id AS id
         FROM stay_refund_parts p JOIN deposit_returns dr ON dr.id = p.deposit_return_id
        WHERE dr.finalized_at IS NOT NULL AND p.status = 'pending' AND p.kind IN ('card', 'bank')
          AND p.created_at < NOW() - make_interval(mins => ${WAITS_MINUTES})
        LIMIT $1`, [limit])
    for (const r of rows) await resumeDepositRefund(r.id, { act: true })
    return rows.length
  } catch (err) {
    logger.error({ err }, '[deposit-refund] the stale-refund sweep failed')
    return 0
  }
}

interface LeasePart {
  id: string; deposit_return_id: string; kind: string; status: string; failure: string | null; amount: number; landlord_id: string
  reversed_at: Date | null; deposit_payment_id: string | null; payment_status: string | null
}

/** The part, checked to be one of this lease's finalized move-out. */
async function partOfLease(leaseId: string, partId: string): Promise<LeasePart> {
  if (!/^[0-9a-f-]{36}$/i.test(partId)) throw new AppError(404, PART_GONE)
  const p = await queryOne<LeasePart>(
    `SELECT p.id, p.deposit_return_id, p.kind, p.status, p.failure, p.amount::float AS amount, p.landlord_id, p.reversed_at,
            p.deposit_payment_id, dp.status AS payment_status
       FROM stay_refund_parts p JOIN deposit_returns dr ON dr.id = p.deposit_return_id
       LEFT JOIN payments dp ON dp.id = p.deposit_payment_id
      WHERE p.id = $1 AND dr.lease_id = $2`, [partId, leaseId])
  if (!p) throw new AppError(404, PART_GONE)
  return p
}
const PART_GONE = 'That refund is not on this move-out any more — the page now shows the latest.'
const DISPUTED_SINCE = 'The tenant disputed the payment this refund came from, so the amount still to give back changed. ' +
  'Nothing was sent or handed back — the page now shows the new amount.'

/**
 * Fix pass 2 (fresh at the moment of action): before a press acts on a part,
 * a dispute or bank return of its payment that the webhook could not apply yet
 * (the part was busy) is applied now. When that changed the part — stopped,
 * or a smaller share left — the press is refused (409) and the page reads the
 * move-out again, so nothing is sent or handed back on an old amount.
 */
async function applyDisputeFirst(leaseId: string, p: LeasePart): Promise<LeasePart> {
  if (!p.deposit_payment_id || p.payment_status !== 'returned') return p
  await noteDepositRefundOfReturnedPayment(p.deposit_payment_id)
  const now = await partOfLease(leaseId, p.id)
  if (now.failure === DEPOSIT_PART_TAKEN_BACK || toCents(now.amount) !== toCents(p.amount) || now.status !== p.status) {
    throw new AppError(409, DISPUTED_SINCE)
  }
  return now
}

/**
 * Try again on a card or bank part that did not go out (the same runner and
 * safety as the first try). Refused in plain words when trying again cannot
 * help (too old for a refund, disputed, taken back by a dispute) or when it
 * is no longer waiting. Returns what to say — a try that did not go out says
 * so once; the part's own line on the page says why and what to do next.
 */
export async function retryDepositRefundPart(leaseId: string, partId: string): Promise<{ words: string[] }> {
  let p = await partOfLease(leaseId, partId)
  if (p.failure === DEPOSIT_PART_TAKEN_BACK) throw new AppError(409, `${DEPOSIT_PART_TAKEN_BACK} Nothing was sent — the page now shows the latest.`)
  if (isCashOnly(p.failure) || (p.kind !== 'card' && p.kind !== 'bank')) {
    throw new AppError(409, `Trying again cannot send this one back to a card or bank. ${PRESS_CASH_FIRST} The page now shows it.`)
  }
  if (p.status !== 'failed' && p.status !== 'pending') {
    await syncDepositRefundRow(p.deposit_return_id)
    return { words: ['This refund already went back — nothing more was sent. The page now shows it.'] }
  }
  p = await applyDisputeFirst(leaseId, p)
  const ran = await runCardPart(partId, { waitMs: PRESS_WAIT_MS })
  await syncDepositRefundRow(p.deposit_return_id)
  const now = await queryOne<{ status: string; failure: string | null; amount: number }>(
    `SELECT status, failure, amount::float AS amount FROM stay_refund_parts WHERE id = $1`, [partId])
  if (!ran) return { words: ['This refund was being worked on by another request at that same moment, so it was not sent again. Wait a moment, then press Try again.'] }
  if (now?.status === 'refunded') return { words: [`${money(now.amount)} was sent back to ${p.kind === 'bank' ? 'their bank' : 'their card'}.`] }
  return { words: ['Tried again — it did not go out. The refund below says why and what to do next.'] }
}

/**
 * The money GAM held for a move-out part the office gave back in cash
 * (`cashPartId`, the 'handed_back' cash part): released to the landlord once,
 * on their next payout (held item 'deposit_settlement', keyed
 * 'cash-part:<part>' — the move-out's own kind of payout line, as finalize
 * writes). earlyCheckOut.givePartBackInCash writes it in the same transaction
 * that records the cash part; giveDepositPartBackInCash does for a part with
 * no payment behind it. Written as SQL: heldPayouts.HELD_ITEM_SOURCES (the
 * code list) does not name 'deposit_settlement' though the table's CHECK
 * allows it (reported). Returns whether it was written now.
 */
export async function releaseDepositCashPart(runner: Pick<PoolClient, 'query'>, cashPartId: string): Promise<boolean> {
  const r = (await runner.query<{ landlord_id: string; toward: string; unit_number: string | null; tenant_name: string | null }>(
    `SELECT p.landlord_id, p.toward_amount::text AS toward, un.unit_number,
            NULLIF(btrim(CONCAT(u.first_name, ' ', u.last_name)), '') AS tenant_name
       FROM stay_refund_parts p
       JOIN deposit_returns dr ON dr.id = p.deposit_return_id
       JOIN leases l ON l.id = dr.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN tenants t ON t.id = dr.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE p.id = $1 AND p.kind = 'cash' AND p.status = 'handed_back'`, [cashPartId])).rows[0]
  if (!r || toCents(r.toward) <= 0) return false
  const ins = await runner.query(
    `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
     VALUES ($1, 'deposit_settlement', $2, $3, $4)
     ON CONFLICT (source_type, source_id) DO NOTHING RETURNING id`,
    [r.landlord_id, `cash-part:${cashPartId}`, toDollars(toCents(r.toward)).toFixed(2),
     `Move-out at ${r.unit_number ?? 'the space'}: deposit refund given back in cash to ${r.tenant_name ?? 'the tenant'}`])
  return (ins.rows?.length ?? 0) > 0
}

/**
 * "Give it back in cash instead": the office hands the tenant this part in
 * cash. A card or bank part goes through earlyCheckOut.givePartBackInCash
 * (it first asks Stripe whether an earlier try reached the card after all —
 * then nothing is handed back), which records the cash part and releases what
 * GAM held to the landlord in one transaction. A part with no payment behind
 * it (or one too old to refund) is recorded given back here, the same way.
 * Returns what to say: the gold order "Hand back $X in cash now." only when
 * cash is to be handed over.
 */
export async function giveDepositPartBackInCash(leaseId: string, partId: string, actorUserId: string, opts: {
  /** The amount the page showed: a different live amount refuses (409) and the page reads it again. */
  expectedAmount?: number
  /** Fix pass 2: "your next payout" to the owner, "the landlord's next payout" to a team member. */
  viewerIsOwner?: boolean
} = {}): Promise<{ words: string[]; handBack: boolean }> {
  let p = await partOfLease(leaseId, partId)
  const whose = opts.viewerIsOwner === false ? 'the landlord\'s' : 'your'
  if (p.failure === DEPOSIT_PART_TAKEN_BACK) {
    throw new AppError(409, `${DEPOSIT_PART_TAKEN_BACK} Hand nothing back — the page now shows the latest.`)
  }
  if (NOT_RECORDED.test(p.failure ?? '')) {
    throw new AppError(409, `This refund already went to ${p.kind === 'bank' ? 'their bank' : 'their card'} — GAM only has to finish recording it, so hand nothing back in cash. Press Try again to finish recording it.`)
  }
  if (p.status === 'pending' && (p.kind === 'card' || p.kind === 'bank')) {
    throw new AppError(409, `This refund is being sent to ${p.kind === 'bank' ? 'their bank' : 'the card'} right now — hand nothing back. The page shows it.`)
  }
  if (p.status !== 'failed' || p.reversed_at) {
    await syncDepositRefundRow(p.deposit_return_id)
    return { words: ['This refund already went back — hand nothing back. The page now shows it.'], handBack: false }
  }
  if (opts.expectedAmount !== undefined && toCents(opts.expectedAmount) !== toCents(p.amount)) {
    throw new AppError(409, 'The amount to give back changed since you opened this, so nothing was handed back. The page now shows the new amount — look it over and press it again.')
  }
  p = await applyDisputeFirst(leaseId, p)
  if (p.kind === 'card' || p.kind === 'bank') {
    const out = await givePartBackInCash(partId, null, actorUserId)
    await syncDepositRefundRow(p.deposit_return_id)
    // The amount recorded in cash is the one under the part's lock (never an older read).
    const cash = await queryOne<{ amount: number }>(
      `SELECT amount::float AS amount FROM stay_refund_parts WHERE replaces_part_id = $1 AND kind = 'cash' AND status = 'handed_back'`, [partId])
    const handed = !!cash && out.words.some((w) => /^Hand back /.test(w))
    if (handed) await tellTenantPartNowInCash(partId)
    if (!handed) {
      // Fix pass 4: a dispute or bank return applied while this press waited
      // for the part's lock stopped it — nothing was handed back; said once.
      const now = await queryOne<{ failure: string | null }>(`SELECT failure FROM stay_refund_parts WHERE id = $1`, [partId])
      if (now?.failure === DEPOSIT_PART_TAKEN_BACK) {
        throw new AppError(409, `${DEPOSIT_PART_TAKEN_BACK} Hand nothing back — the page now shows the latest.`)
      }
    }
    return {
      words: handed
        ? [`Hand back ${money(cash!.amount)} in cash now.`,
           `It is recorded as given back — nothing goes to the ${p.kind === 'bank' ? 'bank' : 'card'}, and ${money(cash!.amount)} is added to ${whose} next payout.`]
        : out.words.length ? out.words : ['This refund already went back — hand nothing back. The page now shows it.'],
      handBack: handed,
    }
  }
  // A cash part (no payment behind it): recorded given back now, and that amount paid to the landlord.
  const c = await getClient()
  let handed: number | null = null
  try {
    await c.query('BEGIN')
    const cur = (await c.query<{ status: string; amount: number; failure: string | null }>(
      `SELECT status, amount::float AS amount, failure FROM stay_refund_parts WHERE id = $1 FOR UPDATE`, [partId])).rows[0]
    // Fix pass 4: read under the row's lock — a part a dispute stopped while
    // this press waited is never handed back (the dispute gave it back).
    if (cur?.failure === DEPOSIT_PART_TAKEN_BACK) {
      throw new AppError(409, `${DEPOSIT_PART_TAKEN_BACK} Hand nothing back — the page now shows the latest.`)
    }
    if (cur?.status === 'failed') {
      await c.query(
        `UPDATE stay_refund_parts SET status = 'handed_back', refunded_at = NOW(), failure = NULL WHERE id = $1`, [partId])
      await releaseDepositCashPart(c, partId)
      handed = cur.amount
    }
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
  await syncDepositRefundRow(p.deposit_return_id)
  logger.info({ partId, leaseId, by: actorUserId }, '[deposit-refund] given back in cash at the office')
  return handed != null
    ? { words: [`Hand back ${money(handed)} in cash now.`, `It is recorded as given back, and ${money(handed)} is added to ${whose} next payout.`], handBack: true }
    : { words: ['This refund already went back — hand nothing back. The page now shows it.'], handBack: false }
}

// ─── The landlord's own part ─────────────────────────────────────────────────

/**
 * "Mark handed back" for the part of the refund the landlord holds
 * (refund_from_landlord), with the day they handed it back. The day is never
 * after today (the property's calendar) nor before the move-out was
 * finalized. `expectedAmount` is the amount the page showed — a different
 * live amount refuses (409) and the page reads it again in place. Already
 * marked: said once, with when and by whom.
 */
export async function markLandlordPartHandedBack(leaseId: string, o: {
  handedBackOn: string; expectedAmount?: number; actorUserId: string
}): Promise<{ words: string[] }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.handedBackOn) || Number.isNaN(Date.parse(`${o.handedBackOn}T12:00:00Z`))) {
    throw new AppError(400, 'Pick the day it was handed back.')
  }
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const dr = (await c.query<any>(
      `SELECT dr.id, dr.refund_from_landlord::float AS amount, dr.finalized_at,
              to_char(dr.landlord_part_handed_back_on, 'YYYY-MM-DD') AS on,
              NULLIF(btrim(CONCAT(u.first_name, ' ', u.last_name)), '') AS by_name, pr.timezone
         FROM deposit_returns dr
         JOIN leases l ON l.id = dr.lease_id
         LEFT JOIN units un ON un.id = l.unit_id
         LEFT JOIN properties pr ON pr.id = un.property_id
         LEFT JOIN users u ON u.id = dr.landlord_part_handed_back_by
        WHERE dr.lease_id = $1 FOR UPDATE OF dr`, [leaseId])).rows[0]
    if (!dr?.finalized_at) throw new AppError(409, 'This move-out is not finalized yet, so there is nothing to hand back. The page now shows it.')
    if (toCents(dr.amount) <= 0) throw new AppError(409, 'There is no part of this refund for you to hand back — the page now shows how it goes back.')
    if (o.expectedAmount !== undefined && toCents(o.expectedAmount) !== toCents(dr.amount)) throw new AppError(409, LANDLORD_PART_CHANGED)
    if (dr.on) {
      throw new AppError(409, `It is already marked handed back on ${shortDay(dr.on)}${dr.by_name ? ` by ${dr.by_name}` : ''}. The page shows it.`)
    }
    const today = todayIn(dr.timezone)
    const finalizedDay = dateIn(dr.timezone, new Date(dr.finalized_at))
    if (o.handedBackOn > today) throw new AppError(400, 'That day has not come yet — pick the day it was handed back (today or earlier).')
    if (o.handedBackOn < finalizedDay) {
      throw new AppError(400, `That day is before the move-out was finalized (${shortDay(finalizedDay)}) — pick the day it was handed back.`)
    }
    await c.query(
      `UPDATE deposit_returns SET landlord_part_handed_back_on = $2::date, landlord_part_handed_back_by = $3,
              landlord_part_handed_back_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [dr.id, o.handedBackOn, o.actorUserId])
    await c.query('COMMIT')
    return { words: [`Marked handed back: ${money(dr.amount)} on ${shortDay(o.handedBackOn)}.`] }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

/** Undo a "Mark handed back" made by mistake (no money moves either way). */
export async function undoLandlordPartHandedBack(leaseId: string): Promise<{ words: string[] }> {
  const r = await queryOne<{ id: string }>(
    `UPDATE deposit_returns SET landlord_part_handed_back_on = NULL, landlord_part_handed_back_by = NULL,
            landlord_part_handed_back_at = NULL, updated_at = NOW()
      WHERE lease_id = $1 AND landlord_part_handed_back_on IS NOT NULL RETURNING id`, [leaseId])
  return { words: [r ? 'No longer marked handed back.' : 'It was not marked handed back — the page now shows it.'] }
}

// ─── The owner's to-do ───────────────────────────────────────────────────────

/**
 * Every finalized move-out with part of its refund still to go back: a part
 * GAM sends that did not go out (failed, or still "sending" after 10 minutes),
 * and the landlord's own part not marked handed back. Each opens the move-out
 * page. `propertyIds`: a property-locked worker's properties (null = all).
 *
 * Fix pass 2: the next step is said per kind of part, as the move-out page
 * offers it — never "give it back in cash" for a refund that already reached
 * the card (only its record is missing), never "try again" where Try again
 * cannot help, and a part still being sent says to check on it.
 */
export async function depositRefundTodos(
  landlordIds: readonly string[], opts: { propertyIds?: readonly string[] | null } = {},
): Promise<Array<{ id: string; type: string; title: string; subtitle: string; href: string }>> {
  if (!landlordIds.length) return []
  const props = opts.propertyIds == null ? null : [...opts.propertyIds]
  if (props && !props.length) return []
  const cashOnlyList = CASH_ONLY.map(sqlText).join(', ')
  const rows = await query<any>(
    `SELECT dr.id, dr.lease_id, un.unit_number, pr.name AS property_name,
            NULLIF(btrim(CONCAT(u.first_name, ' ', u.last_name)), '') AS tenant_name,
            to_char(dr.finalized_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'), 'YYYY-MM-DD') AS finalized_on,
            x.not_recorded, x.sending, x.cash_only, x.either,
            CASE WHEN dr.landlord_part_handed_back_on IS NULL THEN COALESCE(dr.refund_from_landlord, 0) ELSE 0 END::float AS landlord_open
       FROM deposit_returns dr
       JOIN leases l ON l.id = dr.lease_id
       JOIN units un ON un.id = l.unit_id
       JOIN properties pr ON pr.id = un.property_id
       LEFT JOIN tenants t ON t.id = dr.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'failed' AND p.failure ~ '^The refund went to '), 0)::float AS not_recorded,
                COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'pending'
                                                 AND p.created_at < NOW() - make_interval(mins => ${WAITS_MINUTES})), 0)::float AS sending,
                COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'failed'
                                                 AND (p.kind NOT IN ('card', 'bank') OR p.failure IN (${cashOnlyList}))), 0)::float AS cash_only,
                COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'failed' AND p.kind IN ('card', 'bank')
                                                 AND (p.failure IS NULL OR (p.failure !~ '^The refund went to '
                                                                            AND p.failure NOT IN (${cashOnlyList})))), 0)::float AS either
           FROM stay_refund_parts p
          WHERE p.deposit_return_id = dr.id AND ${openPartSql('p')}) x
      WHERE dr.landlord_id = ANY($1::uuid[]) AND dr.finalized_at IS NOT NULL
        AND ($2::uuid[] IS NULL OR un.property_id = ANY($2::uuid[]))
      ORDER BY dr.finalized_at`, [[...landlordIds], props])
  const out: Array<{ id: string; type: string; title: string; subtitle: string; href: string }> = []
  for (const r of rows) {
    const who = r.tenant_name ?? 'a tenant'
    const steps: string[] = []
    if (toCents(r.either) > 0) {
      steps.push(`${money(r.either)} could not go back the way it was paid — open the move-out and press Try again, or "Give it back in cash instead"`)
    }
    if (toCents(r.cash_only) > 0) {
      steps.push(`${money(r.cash_only)} cannot go back the way it was paid — open the move-out and press "Give it back in cash instead"`)
    }
    if (toCents(r.not_recorded) > 0) {
      steps.push(`${money(r.not_recorded)} already went back the way it was paid — open the move-out and press Try again to finish recording it; hand nothing back`)
    }
    if (toCents(r.sending) > 0) {
      steps.push(`${money(r.sending)} is still being sent — open the move-out to check on it`)
    }
    if (steps.length) {
      const toGive = toCents(r.either) + toCents(r.cash_only) > 0
      out.push({
        id: `deposit-refund-${r.id}`, type: 'deposit_refund_not_sent',
        title: toGive ? `Give back ${who}'s deposit refund (${r.unit_number})` : `Finish ${who}'s deposit refund (${r.unit_number})`,
        subtitle: `${r.property_name} · ${steps.join('; ')}`,
        href: moveOutPage(r.lease_id),
      })
    }
    if (toCents(r.landlord_open) > 0) {
      out.push({
        id: `deposit-handback-${r.id}`, type: 'deposit_refund_hand_back',
        title: `Hand back ${money(r.landlord_open)} of ${who}'s deposit (${r.unit_number})`,
        subtitle: `${r.property_name} · move-out finalized ${shortDay(r.finalized_on)} · mark it handed back on the move-out once it is`,
        href: moveOutPage(r.lease_id),
      })
    }
  }
  return out
}

// ─── A dispute or bank return of the deposit payment (decisions #51) ─────────

const REVERSAL_WORDS: Record<string, string> = {
  card_dispute: 'a card dispute',
  ach_return: 'a bank return',
  ach_unauthorized: 'a bank return (the tenant told their bank they did not authorize it)',
}

/**
 * The deposit payment `paymentId` was disputed or returned by the bank after
 * part of it was put on a move-out refund. Called by
 * depositReturn.noteGapChargeReturned (the dispute webhook calls it for every
 * row the reversal reopened), when the move-out page is opened by someone who
 * may run it, and before a press acts on one of its parts. Inside one
 * transaction under the household lock:
 *   - a part already SENT (or given back in cash) stays so: the reversal
 *     reopened the deposit charge on the tenant's balance (the normal
 *     returned-payment recovery), so the tenant owes it again. GAM is alerted.
 *   - of the parts NOT SENT yet, only as much as the dispute or return took
 *     from this payment (payment_reversals.reversed_amount, less what an
 *     earlier pass already stopped) is stopped — that much already went back
 *     to the tenant through their card company or bank. A part bigger than
 *     that is split: the share taken back is stopped, the rest stays a live
 *     part still owed to the tenant (Try again, or cash at the office). Never
 *     a part a send holds right now (the next pass takes it), and never one
 *     whose earlier try may have reached the card: Stripe is asked first, and
 *     a refund it already made is recorded as sent.
 *   - the reopened deposit charge is lowered by exactly the share stopped
 *     (voided when that is all of it), so the tenant never owes money they
 *     were never refunded, and nothing they are owed stays GAM's.
 *   - Fix pass 3: a share is stopped ONLY as far as the reopened charge can
 *     still come down — its rows still owed with no payment of them on the
 *     way. When the tenant already paid it (or a payment is on its way), the
 *     rest of the part stays live and still owed to them, and the alert says
 *     how much was not stopped and why.
 * Then the refund row is brought up to date. GAM's alert says the real
 * amounts, once per state of the dispute. A dispute GAM later WINS changes
 * nothing here by itself (nothing in GAM handles a won dispute yet — the
 * alert says to check the move-out). Returns whether the payment had move-out
 * refund parts. Never throws.
 */
export async function noteDepositRefundOfReturnedPayment(paymentId: string, opts: { askStripe?: boolean } = {}): Promise<boolean> {
  try {
    const head = await queryOne<{ deposit_return_id: string; tenant_id: string; landlord_id: string }>(
      `SELECT p.deposit_return_id, dr.tenant_id, dr.landlord_id
         FROM stay_refund_parts p JOIN deposit_returns dr ON dr.id = p.deposit_return_id
        WHERE p.deposit_payment_id = $1 LIMIT 1`, [paymentId])
    if (!head) return false
    const returned = await queryOne<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [paymentId])
    if (returned?.status !== 'returned') return true

    // A part tried before may have reached the card after all (an answer lost,
    // or "went out but GAM could not record it"): Stripe is asked first, and a
    // refund it already made is recorded as sent — never stopped. One that
    // cannot be checked now is left for the next pass.
    const unsure = new Set<string>()
    const tried = await query<{ id: string; stripe_payment_intent_id: string }>(
      `SELECT p.id, p.stripe_payment_intent_id FROM stay_refund_parts p
        WHERE p.deposit_payment_id = $1 AND ${openPartSql('p')} AND p.kind IN ('card', 'bank') AND p.attempts > 0
        ORDER BY p.seq`, [paymentId])
    if (tried.length && opts.askStripe === false) tried.forEach((t) => unsure.add(t.id))
    else if (tried.length) {
      const { getStripe } = await import('../lib/stripe')
      const stripe = getStripe()
      for (const t of tried) {
        const found = await findSentRefund(stripe, t)
        if (found === 'unreachable') { unsure.add(t.id); continue }
        if (!found) continue
        const ran = await runCardPart(t.id).catch(() => false)
        const now = await queryOne<{ status: string }>(`SELECT status FROM stay_refund_parts WHERE id = $1`, [t.id])
        if (!ran || now?.status !== 'refunded') unsure.add(t.id)
      }
    }

    const c = await getClient()
    let gone = 0, stoppedNow = 0, lowered = 0, taken = 0, stillOwed = 0, owedAgain = 0, paidAlready = 0, askedBack = 0
    let how = 'a dispute or bank return'
    const lowerRows: string[] = []
    try {
      await c.query('BEGIN')
      await lockHousehold(c, head.tenant_id, head.landlord_id)
      const parts = (await c.query<{
        id: string; status: string; amount: string; kind: string; failure: string | null; seq: number
        label: string; stripe_payment_intent_id: string | null
      }>(
        `SELECT p.id, p.status, p.toward_amount::text AS amount, p.kind, p.failure, p.seq, p.label, p.stripe_payment_intent_id
           FROM stay_refund_parts p
          WHERE p.deposit_payment_id = $1 AND ${livePartSql('p')}
          ORDER BY p.seq DESC, p.created_at DESC FOR UPDATE`, [paymentId])).rows
      const rev = (await c.query<{ taken: string; kind: string | null }>(
        `SELECT COALESCE(SUM(reversed_amount), 0)::text AS taken,
                (SELECT r2.reversal_type FROM payment_reversals r2 WHERE r2.payment_id = $1 AND r2.reversed_amount > 0
                  ORDER BY r2.created_at DESC LIMIT 1) AS kind
           FROM payment_reversals WHERE payment_id = $1`, [paymentId])).rows[0]
      taken = toCents(rev?.taken)
      how = REVERSAL_WORDS[rev?.kind ?? ''] ?? how
      const stoppedBefore = parts.filter((p) => p.failure === DEPOSIT_PART_TAKEN_BACK).reduce((t, p) => t + toCents(p.amount), 0)
      gone = parts.filter((p) => p.status === 'refunded' || p.status === 'handed_back').reduce((t, p) => t + toCents(p.amount), 0)
      // Fix pass 3: what the reopened deposit charge can still be lowered by —
      // its rows still owed, with no payment of them on the way (no charge
      // started, no bank retry scheduled, no credit set aside or spent on
      // them). Read (and locked) BEFORE anything is stopped: a share is
      // stopped only when the tenant's reopened charge comes down by exactly
      // that much. When the tenant has already paid the reopened charge (or a
      // payment of it is on the way), stopping their refund would leave them
      // out that money and GAM holding it — so that part stays live, still
      // owed to them (Try again, or cash at the office), and the alert says so.
      const reopened = (await c.query<{ id: string; amount: string }>(
        `SELECT q.id, q.amount::text AS amount FROM payments q
          WHERE q.reversal_id IN (SELECT pr.id FROM payment_reversals pr WHERE pr.payment_id = $1)
            AND q.status IN ('pending', 'failed') AND q.stripe_payment_intent_id IS NULL AND q.next_retry_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = q.id AND cu.status IN ('held', 'applied'))
          ORDER BY q.created_at DESC, q.id DESC FOR UPDATE OF q`, [paymentId])).rows
      const lowerable = reopened.reduce((t, q) => t + toCents(q.amount), 0)
      const wanted = Math.max(0, taken - stoppedBefore)
      let room = Math.min(wanted, lowerable)
      // What the dispute took that could have been stopped, but the reopened charge was already paid (or is being paid).
      const stoppable = parts.filter((p) => ['pending', 'failed'].includes(p.status) && p.failure !== DEPOSIT_PART_TAKEN_BACK
        && !unsure.has(p.id)).reduce((t, p) => t + toCents(p.amount), 0)
      paidAlready = Math.max(0, Math.min(wanted, stoppable) - lowerable)
      for (const p of parts) {
        if (room <= 0) break
        if (!['pending', 'failed'].includes(p.status) || p.failure === DEPOSIT_PART_TAKEN_BACK || unsure.has(p.id)) continue
        // Never while a send holds the part (it would go out anyway): the next pass takes it.
        const got = (await c.query<{ ok: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok`, [`stay-refund-part:${p.id}`])).rows[0]?.ok
        if (!got) continue
        const amt = toCents(p.amount)
        const share = Math.min(room, amt)
        if (share >= amt) {
          await c.query(`UPDATE stay_refund_parts SET status = 'failed', failure = $2 WHERE id = $1`, [p.id, DEPOSIT_PART_TAKEN_BACK])
        } else {
          // Split: the rest stays this part (still owed to the tenant, its
          // buttons as before); the share taken back is a part of its own.
          await c.query(
            `UPDATE stay_refund_parts SET toward_amount = toward_amount - $2::numeric, amount = amount - $2::numeric WHERE id = $1`,
            [p.id, toDollars(share).toFixed(2)])
          await c.query(
            `INSERT INTO stay_refund_parts
               (deposit_return_id, landlord_id, seq, kind, deposit_payment_id, stripe_payment_intent_id,
                toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label, status, failure)
             SELECT deposit_return_id, landlord_id, seq, kind, deposit_payment_id, stripe_payment_intent_id,
                    $2::numeric, 0, $2::numeric, 0, 0, label, 'failed', $3
               FROM stay_refund_parts WHERE id = $1`,
            [p.id, toDollars(share).toFixed(2), DEPOSIT_PART_TAKEN_BACK])
        }
        stoppedNow += share
        room -= share
      }
      // The reopened deposit charge is lowered by exactly the share stopped now
      // (never more than `lowerable`, so it always fits).
      let left = stoppedNow
      if (left > 0) {
        for (const q of reopened) {
          if (left <= 0) break
          const amt = toCents(q.amount)
          if (amt <= left) {
            await c.query(
              `UPDATE payments SET status = 'voided', voided_at = NOW(), next_retry_at = NULL,
                      void_reason = 'Not owed: the dispute or bank return already gave this deposit money back, and the move-out refund of it was never sent'
                WHERE id = $1`, [q.id])
            left -= amt
          } else {
            await c.query(
              `UPDATE payments SET amount = amount - $2::numeric,
                      notes = LEFT(COALESCE(notes || E'\\n', '') || $3, 2000)
                WHERE id = $1`,
              [q.id, toDollars(left).toFixed(2),
               `Lowered by ${money(toDollars(left))}: the dispute or bank return already gave that deposit money back, and its move-out refund was never sent`])
            left = 0
          }
          lowerRows.push(q.id)
        }
        lowered = stoppedNow - left
        if (left > 0) throw new Error(`stopped ${left} cents more than the reopened charge could be lowered by`)
      }
      stillOwed = toCents((await c.query<{ n: string }>(
        `SELECT COALESCE(SUM(p.toward_amount), 0)::text AS n FROM stay_refund_parts p
          WHERE p.deposit_payment_id = $1 AND ${openPartSql('p')}`, [paymentId])).rows[0]?.n)
      owedAgain = toCents((await c.query<{ n: string }>(
        `SELECT COALESCE(SUM(q.amount), 0)::text AS n FROM payments q
          WHERE q.reversal_id IN (SELECT pr.id FROM payment_reversals pr WHERE pr.payment_id = $1)
            AND q.status IN ('pending', 'failed')`, [paymentId])).rows[0]?.n)
      // Decisions #54: the kept share the move-out paid the landlord, asked back
      // of them on their next payout (paymentReversal.settleDepositKeptSide).
      // Fix pass 2: the reversal counted every refund part not sent as taking
      // the dispute first; one found sent after all above (its earlier try did
      // reach the card or bank) leaves that take on the kept share — the
      // landlord's part of it is asked now, once (topUpDepositKeptAsk).
      const { topUpDepositKeptAsk } = await import('./paymentReversal')
      await topUpDepositKeptAsk(c, paymentId)
      askedBack = toCents((await c.query<{ n: string }>(
        `SELECT COALESCE(-SUM(h.amount), 0)::text AS n FROM held_payout_items h
           JOIN payment_reversals pr ON split_part(h.source_id, ':', 2) = pr.id::text
          WHERE h.source_type = 'dispute' AND h.source_id LIKE 'owner\\_share\\_withheld:%' AND pr.payment_id = $1`,
        [paymentId])).rows[0]?.n)
      await syncDepositRefundRow(head.deposit_return_id, c)
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    } finally { c.release() }

    if (taken <= 0 || (gone <= 0 && stoppedNow <= 0 && stillOwed <= 0)) return true
    // Once per state: a pass that stopped something, or the first word of
    // this much taken back. Opening the page again alerts nobody twice.
    // Fix pass 3: a refund share left live because the tenant already paid the
    // reopened charge is a state of its own — told once, too.
    const seen = stoppedNow > 0 ? null : await queryOne(
      `SELECT 1 FROM admin_notifications WHERE category = 'deposit_refund_then_returned'
          AND context->>'payment_id' = $1 AND (context->>'taken_cents')::int = $2
          AND COALESCE((context->>'not_stopped_paid_cents')::int, 0) = $3
          AND COALESCE((context->>'asked_back_cents')::int, 0) = $4 LIMIT 1`, [paymentId, taken, paidAlready, askedBack])
    if (seen) return true
    const bits: string[] = [`The tenant's ${how} took back ${money(toDollars(taken))} of this deposit payment.`]
    if (gone > 0) {
      bits.push(`GAM had already sent ${money(toDollars(gone))} of this deposit payment back to the tenant at move-out. That refund stays sent.`)
    }
    if (stoppedNow > 0) {
      bits.push(`${money(toDollars(stoppedNow))} of the move-out refund had not gone out yet, so that much is no longer sent — the ${how} already gave it back` +
        `${lowered > 0 ? `, and the reopened deposit charge was lowered by ${money(toDollars(lowered))}` : ''}.`)
    }
    if (paidAlready > 0) {
      bits.push(`${money(toDollars(paidAlready))} of the move-out refund was NOT stopped: the tenant has already paid the reopened deposit charge ` +
        `(or a payment of it is on its way), so that refund is still theirs and nothing of it stays GAM's.`)
    }
    if (stillOwed > 0) {
      bits.push(`${money(toDollars(stillOwed))} of the refund is still owed to the tenant: it stays on the owner's to-do list until it is sent or given back in cash at the office.`)
    }
    if (askedBack > 0) {
      bits.push(`${money(toDollars(askedBack))} the move-out paid the landlord for the deductions comes back off their next payout; ` +
        'it is paid to them again when the tenant pays the reopened deposit charge.')
    }
    if (owedAgain > 0) {
      bits.push(`The tenant now owes ${money(toDollars(owedAgain))} again on the reopened deposit charge (the normal returned-payment recovery).`)
    }
    bits.push('If GAM wins the dispute, nothing here changes by itself — check this move-out then.')
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn', category: 'deposit_refund_then_returned',
      title: `A deposit payment was disputed or returned after its move-out refund${gone > 0 ? ' went out' : ' was set to go out'}`,
      body: `${bits.join(' ')} Move-out ${head.deposit_return_id}, deposit payment ${paymentId}.`,
      context: { deposit_return_id: head.deposit_return_id, payment_id: paymentId, taken_cents: taken, sent_cents: gone,
                 stopped_cents: stoppedNow, lowered_cents: lowered, still_owed_cents: stillOwed, owed_again_cents: owedAgain,
                 not_stopped_paid_cents: paidAlready, asked_back_cents: askedBack,
                 reopened_payment_ids: lowerRows },
    })
    return true
  } catch (err) {
    logger.error({ err, paymentId }, '[deposit-refund] could not handle a returned deposit payment')
    return false
  }
}
