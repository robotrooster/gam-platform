/**
 * 10/14 (Nic, answer 15) — A CHECK RETURNED OUT OF A BIGGER DEPOSIT, BY ITSELF.
 *
 *   "A returned check inside a bigger deposit: void just that check,
 *   AUTOMATICALLY reopen their invoice with any late fees that apply and the
 *   returned-payment charge the bank issued (usually $25) — this needs to be
 *   automatic as a big operation could take days to bounce the check and get
 *   the info back to the front desk."
 *   Follow-up: "the lease's returned-check fee; if the lease names none, bill
 *   what the bank charged on that line."
 *   And answer 16: "if gam 100 percent knows who that money came from it can
 *   file it but no guessing."
 *
 * The bank does not void the deposit when one check in it bounces: it takes
 * that check's amount back on a line of its own ("RETURNED DEPOSIT ITEM",
 * "DEPOSITED ITEM RETURNED"…) and usually charges a fee on another line. (A
 * bank that voids the WHOLE deposit is handled as before — services/bankFeed
 * voidWhatBounced.)
 *
 * WHAT GAM DOES BY ITSELF, after each bank sync (takeBackReturnedChecks):
 *   1. A money-out line in review whose memo reads as a deposited check
 *      returned (readReturnedItemMemo — never an ACH, a card chargeback or a
 *      bare "RETURN ITEM") is looked up against everything it could be in the
 *      RETURNED_ITEM_WINDOW_DAYS before it, on the same bank account
 *      (whatItCouldBe): the checks and money orders on a matched deposit slip,
 *      tenants' own bank deposits matched to their bills — and every deposit
 *      GAM cannot see inside that is big enough to hold it (a slip's "other
 *      money", a deposit filed as income, ignored or still in review; never a
 *      GAM payout or an electronic credit, which hold no paper check).
 *      Exactly ONE payment of exactly that amount — a check or money order on
 *      a slip, or a tenant's own deposit GAM matched as one (10/14 afternoon,
 *      below) — and nothing unseen that could hold it, or nothing happens by
 *      itself.
 *   2. That check's payment is taken back, and only it: the receipt is closed
 *      as taken back (kept on record), every bill line it paid is owed again,
 *      and the rest of the deposit stays as it is. The bills' payment marks are
 *      judged again, and the late-fee engine back-fills each reopened bill from
 *      its due date, as if it was never paid (jobs/lateFees
 *      generateLateFeesForInvoice).
 *   3. The returned-check fee is billed to the tenant: the fee the tenant's
 *      signed lease names (leaseReturnedFee — the lease's "Returned payment
 *      fee" field), else what the bank charged on its fee line for it
 *      (readReturnedItemMemo 'fee', within RETURNED_FEE_WINDOW_DAYS). A bank
 *      fee line that has not shown yet is billed when it does, on a later
 *      sync; one that never shows (FEE_LINE_GIVE_UP_DAYS) bills nothing and
 *      the owner is told. A lease fee GAM cannot read as an amount is never
 *      replaced by the bank's: nothing is billed and the owner is told. The
 *      fee is a charge of its own, due the day it is billed (on no bill, like
 *      every charge owed again — services/creditUse), so it never keeps the
 *      old bill late. The bank's fee line itself stays in review — it is the
 *      landlord's bank expense, filed by the owner; the fee billed to the
 *      tenant is the landlord's income. Each dollar once.
 *   4. The returned line is matched to that check (status 'matched', its
 *      auto_settle_undo kind 'returned_check', with everything the take-back
 *      changed), so it never waits to be filed as an expense, and the books
 *      put the check back in the drawer (ledgerProjectors/tenantReceipts
 *      projectBankMatchTenant; ledgerTenantChecks counts it).
 *   5. The owner, the person who took the check at the desk, and the tenant
 *      are each told once, by email too.
 *
 * 10/14 afternoon (Nic: "Automatic bounce handling also for: money orders that
 * come back, and a tenant's own single-check bank deposit that comes back"):
 *   - A MONEY ORDER on a matched deposit slip that comes back (counterfeit,
 *     stolen, altered) is taken back exactly like a check, by itself.
 *   - A TENANT'S OWN BANK DEPOSIT GAM matched to their bills (bankDepositConfirm
 *     confirmDepositMatch), recorded as a check or a money order, whose whole
 *     amount comes back as a returned item — the deposit was that one item —
 *     is taken back the same way: that match is undone (its receipt closed as
 *     taken back, every bill line it paid owed again with late fees from its
 *     due date, as if never paid, the deposit's bank allocations marked
 *     reversed), and the returned-payment fee is billed (the lease's, else the
 *     bank's). The returned line is matched to that deposit (kind
 *     RETURNED_DEPOSIT_KIND) and the deposit line is marked as come back on
 *     it (CAME_BACK_MARK), so neither waits to be filed. The books: the
 *     deposit's receipt is taken back, so the deposit line no longer moves
 *     anything into the bank, and the returned line puts nothing in either
 *     (the money came in and went out again; ledgerProjectors/tenantReceipts
 *     lists only 'returned_check' lines). Each dollar once.
 *     As if never paid, late fees included (10/14, follow-up): what the
 *     deposit's match did to late fees because the bank's date showed them
 *     never owed is taken back with it (lateFeesOwedAgain) — each fee it took
 *     off at $0.00 or paid with a late-fee credit is owed again exactly as
 *     before the match, and each late-fee refund credit it gave for fees
 *     already paid is withdrawn, as the deposit's own Undo does
 *     (bankDepositConfirm undoDepositMatch). The late-fee engine then
 *     back-fills the days after, as for any reopened bill.
 *
 * WHAT WAITS FOR A PERSON (the line stays in review; the owner is told once,
 * with what they can do):
 *   - GAM cannot tell which payment it is: nothing or more than one payment of
 *     that amount; another returned item of that amount waiting on the account
 *     near it (10/14 afternoon: one to one both ways); a deposit GAM cannot see
 *     inside that could hold it. The person picks the payment on the Bank page
 *     (checkChoices, takeBackChosenCheck — the same take-back, fee and notices).
 *   - GAM knows which payment it is but cannot take it back (by itself, or when
 *     picked — whatInstead says what the owner can do): a deposit the office
 *     logged by hand as a bank deposit (GAM cannot take a hand-logged payment
 *     back yet); a tenant's own bank deposit not recorded as a check or money
 *     order; a take-back that is not clean — money left over from it as credit
 *     or paid ahead, a line it paid that changed since (paid again, disputed,
 *     credit used on it, a security deposit), a line paid by more than one
 *     payment, or (a tenant's own deposit) a late fee or refund credit its
 *     match left that changed since. A tenant's own deposit GAM matched is then
 *     taken back with Undo this match on that deposit (the fee billed by hand).
 *
 * UNDO (undoReturnedCheck, from the Bank page's Undo this match — Nic 10/12:
 * "every bank filing (hand-filed too) can be undone (kept on record)"): the
 * check's payment stands again exactly as it was, the fee and the late fees
 * the bounce brought are voided (kept on record), and the line goes back to
 * review, never taken back by itself again. Refused when anything changed
 * since (the tenant paid again, the fee or a late fee was paid). A tenant's
 * own deposit taken back is put back the same way (undoReturnedDeposit): its
 * match stands again, its allocations too, the late fees its match had taken
 * off are taken off again (lateFeesOffAgain), and its line loses the come-back
 * mark.
 *
 * Money is in CENTS inside this file.
 */
import type { PoolClient } from 'pg'
import type { DepositSettleUndo } from './bankDepositConfirm'
import { db, getClient, query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { lockHousehold, lockPaymentRowsById } from './moneyPredicates'

/** A returned item is taken back by itself only against deposits the bank posted up to this many days before it. */
export const RETURNED_ITEM_WINDOW_DAYS = 30
/** The checks offered to the person who picks which one came back reach this far back. */
export const RETURNED_ITEM_PICK_WINDOW_DAYS = 90
/** The bank's fee for the returned item posts on its day or up to this many days after. */
export const RETURNED_FEE_WINDOW_DAYS = 3
/**
 * A fee line still not seen this many days after the window closed never
 * will be (a sync running late has had its time): nothing is billed, and the
 * owner is told.
 */
export const FEE_LINE_GIVE_UP_DAYS = 7
/** The auto_settle_undo kind on a returned line matched to the check (or money order) it took back out of a deposit slip. */
export const RETURNED_CHECK_KIND = 'returned_check'
/**
 * 10/14 afternoon (Nic): the auto_settle_undo kind on a returned line matched
 * to a tenant's own bank deposit it took back. Its own kind because the books
 * differ: a slip's check goes back in the drawer the slip took it from
 * (ledgerProjectors/tenantReceipts projectReturnedCheck reads 'returned_check'
 * only), while a tenant's own deposit never went through the drawer — its
 * receipt is taken back, so neither line puts anything in the books.
 */
export const RETURNED_DEPOSIT_KIND = 'returned_tenant_deposit'
/** Both kinds of returned line GAM matched to what it took back. */
export const RETURNED_KINDS = [RETURNED_CHECK_KIND, RETURNED_DEPOSIT_KIND] as const
export type ReturnedKind = typeof RETURNED_KINDS[number]
/** RETURNED_KINDS as a SQL list, for `auto_settle_undo->>'kind' IN …`. */
export const RETURNED_KINDS_SQL = `('${RETURNED_CHECK_KIND}', '${RETURNED_DEPOSIT_KIND}')`
/**
 * The key on a tenant's deposit line (its auto_settle_undo) that says the
 * deposit came back and was taken back: { lineId, postedDate } of the returned
 * line. The match record beside it stays as it was, for the Undo.
 */
export const CAME_BACK_MARK = 'cameBack'
/** What came back, in words. */
type Item = 'check' | 'money order'
const itemOf = (method: string | null | undefined): Item => (method === 'money_order' ? 'money order' : 'check')
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
/** The fee's name: the bank's "returned check", or the lease's "returned payment" for a money order. */
const feeName = (item: Item): string => (item === 'check' ? 'returned-check fee' : 'returned-payment fee')
/** The notification type for every notice this file sends. */
const NOTICE_TYPE = 'bank_returned_check'
/** Which notice, so each is sent once per person and line (one email per thing). */
type NoticeKind = 'waits' | 'taken_back' | 'fee_billed' | 'fee_none' | 'put_back' | 'void_stands'

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const money = (c: number): string =>
  `$${(Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A bank memo in capitals, one space between words ("CHARGE BACK" read as one). */
const words = (description: string | null | undefined): string =>
  ` ${String(description ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\bCHARGE BACK\b/g, 'CHARGEBACK').trim()} `

/**
 * Money that moved electronically: an ACH or wire, a card processor or payment
 * app, a Stripe payout ("ST-…" in the memo), direct deposit, interest. None of
 * it is a paper check, so none of it is ever a deposited check returned — and
 * a deposit like that cannot hold the check a returned line is.
 */
const ELECTRONIC = /\b(ACH|PPD|CCD|WIRE|WIRED|EFT|RTP|ZELLE|VENMO|PAYPAL|STRIPE|STP|SQUARE|SQ|CASHAPP|CASH APP|POS|CARD|VISA|MASTERCARD|AMEX|DISCOVER|MERCHANT|INSTANT PMT|DIRECT DEP|DIR DEP|DIRECT DEPOSIT|PAYROLL|INTEREST)\b|\bST [A-Z0-9]{6,}\b/

/**
 * What a bank memo says, for a line of money going out:
 *   'item' — a deposited check the bank took back: a return of a DEPOSITED
 *            item or check ("RETURNED DEPOSIT ITEM", "DEPOSITED ITEM
 *            RETURNED", "RET DEP ITEM 10/03"), a returned check ("RETURNED
 *            CHECK", "RETURN ITEM CHK 1042") or money order ("RETURNED MONEY
 *            ORDER" — 10/14, Nic: money orders come back too), or a
 *            chargeback of one ("CHARGEBACK DEPOSITED ITEM");
 *   'fee'  — the bank's fee for one, in the same words with a fee
 *            ("DEPOSITED ITEM RETURNED FEE", "RETURN DEP ITEM CHG");
 *   null   — anything else. Never an ACH, a card or payment-processor
 *            chargeback, a wire, an overdraft, a bare "RETURN ITEM" or
 *            "RETURNED ITEM FEE" (most often the landlord's own payment
 *            returned unpaid), or a bare "DEPOSIT RETURN" (most often a deposit
 *            the owner refunded). A line like that waits on the Bank page,
 *            where a person can still say it was a check that bounced.
 */
export function readReturnedItemMemo(description: string | null | undefined): 'item' | 'fee' | null {
  const s = words(description)
  if (/\b(OVERDRAFT|OD)\b/.test(s) || ELECTRONIC.test(s)) return null
  const returned = /\b(RETURNED|RETURN|RTN|RTRN|RET|RETD)\b/.test(s)
  const deposited = /\b(DEPOSITED|DEPOSIT|DEP)\b/.test(s)
  const check = /\b(CHECK|CHECKS|CHK|CK|CHQ|CHEQUE|MONEY ORDERS?|MONEY ORD)\b/.test(s)
  const item = /\b(ITEM|ITEMS)\b/.test(s)
  const isReturnedCheck = (returned && deposited && (item || check)) || (returned && check)
    || (/\bCHARGEBACK\b/.test(s) && (deposited || check))
  if (!isReturnedCheck) return null
  return /\b(FEE|FEES|CHG|CHARGE|SVC)\b/.test(s) ? 'fee' : 'item'
}

/**
 * Does a money-out memo speak of something returned at all ("RETURN ITEM",
 * "ITEM RETURNED NSF", "CHARGEBACK")? Wider than readReturnedItemMemo, never
 * electronic money and never the bank's fee: the Bank page opens the checks to
 * pick from on a line like this, and keeps them one press away on any other.
 */
export function mentionsAReturn(description: string | null | undefined): boolean {
  const s = words(description)
  if (ELECTRONIC.test(s) || /\b(FEE|FEES|CHG|SVC)\b/.test(s)) return false
  return readReturnedItemMemo(description) === 'item' || /\b(RETURNED|RETURN|RTN|RTRN|RETD|CHARGEBACK|NSF)\b/.test(s)
}

/** One payment inside a matched deposit that a returned line could be. */
export interface ItemInDeposit {
  remittance_id: string; slip_id: string | null; tenant_id: string; landlord_id: string; method: string
  received_by: string | null; deposited_on: string; property_id: string | null; bank_line_id: string
  /**
   * What the deposit line is matched as (its auto_settle_undo kind): null for
   * a tenant's deposit GAM matched to their bills (confirmDepositMatch),
   * 'recorded_deposit' for one tied to a deposit the office logged by hand,
   * 'deposit_slip' for a slip.
   */
  deposit_kind: string | null
}

/**
 * Everything a returned line of `cents`, posted on `day` to bank account
 * `connectionId`, could be, among deposits posted to that account in the
 * `windowDays` before it:
 *   items  — a check or money order on a deposit slip matched to a bank
 *            deposit, and a tenant's own bank deposit matched to their bills
 *            (a report, a person's confirm, a deposit the office logged), each
 *            of exactly that amount and not taken back. Cash never comes back.
 *   unseen — deposits GAM cannot see inside that could hold a check of that
 *            amount: a slip's "other money" at least that big, and any other
 *            deposit at least that big that is not a GAM payout, a transfer or
 *            loan matched by a person, an electronic credit (ELECTRONIC), or a
 *            tenant's own deposit of exactly that amount (an item above).
 * Only one item and nothing unseen is taken back by itself — a check or money
 * order on a slip, or (10/14 afternoon) a tenant's own deposit GAM matched,
 * recorded as a check or money order (takeBackOne).
 */
async function whatItCouldBe(runner: Pick<PoolClient, 'query'>, o: {
  landlordId: string; connectionId: string; cents: number; day: string; windowDays: number
}): Promise<{ items: ItemInDeposit[]; unseen: number }> {
  const amount = (o.cents / 100).toFixed(2)
  const items = (await runner.query<ItemInDeposit>(
    `SELECT r.id AS remittance_id, s.id AS slip_id, r.tenant_id, r.landlord_id, r.payment_method AS method, r.received_by,
            to_char(bt.posted_date, 'YYYY-MM-DD') AS deposited_on, s.property_id, bt.id AS bank_line_id,
            bt.auto_settle_undo->>'kind' AS deposit_kind
       FROM bank_deposit_slips s
       JOIN bank_transactions bt ON bt.id = s.bank_transaction_id AND bt.landlord_id = s.landlord_id
       JOIN bank_deposit_slip_items i ON i.slip_id = s.id AND i.voided_at IS NULL AND i.remittance_id IS NOT NULL
       JOIN tenant_remittances r ON r.id = i.remittance_id AND r.landlord_id = s.landlord_id
      WHERE s.landlord_id = $1 AND s.status = 'matched' AND bt.status = 'matched' AND bt.bank_connection_id = $5
        AND COALESCE(bt.bank_status, 'posted') <> 'void'
        AND bt.posted_date <= $3::date AND bt.posted_date >= ($3::date - $4::int)
        AND r.payment_method IN ('check', 'money_order') AND r.status = 'settled' AND r.undone_at IS NULL
        AND i.amount = $2::numeric AND r.amount = $2::numeric
     UNION ALL
     SELECT r.id, NULL, r.tenant_id, r.landlord_id, r.payment_method, r.received_by,
            to_char(bt.posted_date, 'YYYY-MM-DD'), NULL, bt.id, bt.auto_settle_undo->>'kind'
       FROM bank_transactions bt
       JOIN tenant_remittances r ON r.id::text = bt.auto_settle_undo->>'receiptId' AND r.landlord_id = bt.landlord_id
      WHERE bt.landlord_id = $1 AND bt.status = 'matched' AND bt.amount > 0 AND bt.bank_connection_id = $5
        AND COALESCE(bt.bank_status, 'posted') <> 'void'
        AND bt.posted_date <= $3::date AND bt.posted_date >= ($3::date - $4::int)
        AND r.payment_method <> 'cash' AND r.status = 'settled' AND r.undone_at IS NULL
        AND r.amount = $2::numeric
      ORDER BY 7, 1`,
    [o.landlordId, amount, o.day, o.windowDays, o.connectionId])).rows
  const deposits = (await runner.query<{
    description: string | null; slip_other: string | null; receipt_amount: string | null
  }>(
    `SELECT bt.description,
            (SELECT s.other_amount::text FROM bank_deposit_slips s
              WHERE s.bank_transaction_id = bt.id AND s.status = 'matched' LIMIT 1) AS slip_other,
            (SELECT r.amount::text FROM tenant_remittances r
              WHERE bt.status = 'matched' AND r.id::text = bt.auto_settle_undo->>'receiptId') AS receipt_amount
       FROM bank_transactions bt
      WHERE bt.landlord_id = $1 AND bt.bank_connection_id = $5 AND bt.amount > 0
        AND bt.posted_date <= $3::date AND bt.posted_date >= ($3::date - $4::int)
        AND COALESCE(bt.bank_status, 'posted') <> 'void'
        AND bt.ignored_reason IS DISTINCT FROM 'duplicate' AND bt.ignored_reason IS DISTINCT FROM 'bank_void'
        -- GAM's own payout (Stripe money, every payment in it known), and a
        -- transfer or loan a person matched: no paper check inside.
        AND bt.matched_disbursement_id IS NULL AND bt.matched_kind IS NULL
        AND (bt.amount >= $2::numeric
             OR EXISTS (SELECT 1 FROM bank_deposit_slips s WHERE s.bank_transaction_id = bt.id AND s.status = 'matched'))`,
    [o.landlordId, amount, o.day, o.windowDays, o.connectionId])).rows
  const { memoSaysTransfer } = await import('./bankDepositMatch')
  let unseen = 0
  for (const d of deposits) {
    if (d.slip_other != null) {
      // A slip: every payment on it is known (items above), except its lump of other money.
      if (toCents(d.slip_other) >= o.cents) unseen++
      continue
    }
    if (d.receipt_amount != null && toCents(d.receipt_amount) === o.cents) continue // an item above
    if (ELECTRONIC.test(words(d.description)) || memoSaysTransfer(d.description)) continue
    unseen++
  }
  return { items, unseen }
}

/** A returned line in review, as the take-back reads it. */
interface ReturnedLine {
  id: string; landlord_id: string; bank_connection_id: string; amount: string; posted_date: string; description: string | null
}

/** How the returned-check fee was settled at the take-back. */
export type FeeOutcome =
  | { kind: 'lease' | 'bank'; cents: number }
  | { kind: 'unreadable'; words: string }
  | { kind: 'later' }

/**
 * Why a returned line waits for a person (said in the owner's notice, or to
 * the person who picked), and — when GAM knows which payment it is but cannot
 * take it back — what the owner can do instead (whatInstead). Without `next`,
 * the owner picks the payment on the Bank page.
 */
class WaitsForAPerson extends Error {
  constructor(public readonly why: string, public readonly next: string | null = null) { super(why) }
}

/**
 * 10/14 (follow-up): what the owner can do about a returned line whose payment
 * GAM knows but cannot take back, by itself or when picked — never "pick it"
 * (the pick is refused for the same reason):
 *   - a tenant's own bank deposit GAM matched: Undo this match on that deposit
 *     takes it off the bills it paid (bankDepositConfirm undoDepositMatch);
 *     GAM bills no fee that way, so the owner bills it;
 *   - a deposit the office logged by hand as a bank deposit: Undo on that
 *     deposit leaves the hand-logged payment paid (recordedDepositMatch
 *     undoRecordedDepositMatch), and GAM cannot take back a payment logged by
 *     hand yet — GAM support;
 *   - a check or money order on a deposit slip whose take-back is not clean:
 *     GAM support.
 */
function whatInstead(i: Pick<ItemInDeposit, 'slip_id' | 'method' | 'deposit_kind' | 'deposited_on'>): string {
  const item = itemOf(i.method)
  if (!i.slip_id && i.deposit_kind == null) {
    return `To take it back, press Undo this match on that deposit of ${i.deposited_on}: the bills it paid are owed again. `
      + `GAM bills no fee that way, so bill the ${feeName(item)} by hand.`
  }
  if (!i.slip_id) {
    return 'GAM cannot take back a payment the office logged by hand yet, so the bills it paid stay paid and no fee is billed '
      + '(Undo this match on that deposit would not change that). Contact GAM support to have it taken back.'
  }
  return `GAM cannot take that ${item} back by itself or when you pick it, so the bills it paid stay paid and no fee is billed. `
    + 'Contact GAM support to have it taken back.'
}

export interface ReturnedCheckResult {
  /** Returned lines whose check was taken back by itself. */
  takenBack: number
  /** Returned lines left for a person (told once). */
  waiting: number
  /** Fees billed from bank fee lines that showed after the take-back. */
  feesBilled: number
}

/** A bill line as it was before the take-back reopened it (what Undo puts back). */
interface RowBefore {
  paymentId: string; settledAt: string | null; manualMethod: string | null; platformHeld: boolean
  depositCollectedBy: string | null
}

/**
 * 10/14 (follow-up): a late fee the take-back of a tenant's own deposit made
 * owed again — one the deposit's match had taken off because the bank's date
 * showed it never owed. Undo takes it off again exactly as the match had it.
 */
export interface LateFeeOwedAgain {
  paymentId: string
  /** How the match had it: at $0.00, or paid by a late-fee credit of its own. */
  was: 'zeroed' | 'credited'
  /** Its notes and paid time as the match left them (Undo writes them back). */
  notes: string | null; settledAt: string | null
  /** 'credited': the day its credit said the rent was paid (the new credit Undo gives says the same). */
  paidOn?: string
}

/** What the take-back wrote on the returned line (bank_transactions.auto_settle_undo). */
export interface ReturnedCheckUndo {
  version: 1; kind: ReturnedKind; at: string
  returnedReceiptId: string; slipId: string | null; propertyId: string | null
  /** 10/14 afternoon (RETURNED_DEPOSIT_KIND only): the tenant's own deposit line that came back. */
  depositLineId?: string
  /** 10/14 afternoon (RETURNED_DEPOSIT_KIND only): the bill lines whose bank allocation from that deposit was marked reversed. */
  allocationPaymentIds?: string[]
  /** 10/14 follow-up (RETURNED_DEPOSIT_KIND only): late fees the deposit's match had taken off, owed again (lateFeesOwedAgain). */
  lateFeesOwedAgain?: LateFeeOwedAgain[]
  /** 10/14 follow-up (RETURNED_DEPOSIT_KIND only): the late-fee refund credits the deposit's match gave, withdrawn. */
  refundCreditsWithdrawn?: string[]
  reopenedPaymentIds: string[]; rows: RowBefore[]; invoiceIds: string[]
  feeLineId: string | null; feePaymentId: string | null; feeAmount: number | null
  feeFrom: FeeOutcome['kind'] | 'none'
  /** Null when GAM took it back by itself; the person who picked the check otherwise. */
  pickedBy: string | null
}

/**
 * Every returned item in this company's feed, after a sync: take back the one
 * check each is, where GAM is certain; bill the bank's fee for checks taken
 * back earlier once its line shows. A line a person already took back and
 * undid is never taken back by itself again. Never throws (a sync must not
 * fail on it).
 */
export async function takeBackReturnedChecks(landlordId: string): Promise<ReturnedCheckResult> {
  const out: ReturnedCheckResult = { takenBack: 0, waiting: 0, feesBilled: 0 }
  let lines: ReturnedLine[]
  try {
    lines = (await query<ReturnedLine>(
      `SELECT id, landlord_id, bank_connection_id, amount::text AS amount, to_char(posted_date, 'YYYY-MM-DD') AS posted_date,
              description
         FROM bank_transactions
        WHERE landlord_id = $1 AND status = 'needs_review' AND amount < 0
          AND COALESCE(bank_status, 'posted') = 'posted'
          AND expense_id IS NULL AND landlord_other_income_id IS NULL AND matched_kind IS NULL
          AND auto_settle_undo IS NULL
        ORDER BY posted_date, id`, [landlordId])).filter(l => readReturnedItemMemo(l.description) === 'item')
  } catch (e) {
    logger.warn({ err: e, landlordId }, '[returned-check] skipped')
    return out
  }
  for (const line of lines) {
    try {
      if (await takeBackOne(line, null)) out.takenBack++
    } catch (e) {
      if (e instanceof WaitsForAPerson) {
        out.waiting++
        await tellOwnerItWaits(line, e.why, e.next)
        continue
      }
      logger.warn({ err: e, transactionId: line.id }, '[returned-check] could not take the check back by itself')
    }
  }
  try { out.feesBilled += await billLateFeeLines(landlordId) } catch (e) {
    logger.warn({ err: e, landlordId }, '[returned-check] fee lines skipped')
  }
  return out
}

/** One check a person may say came back on a returned line (the Bank page's list). */
export interface CheckChoice {
  remittanceId: string; method: string; amount: number; depositedOn: string; tenantName: string | null
  spaces: string | null
  /** True for a tenant's own bank deposit (not a payment on a deposit slip). */
  tenantDeposit: boolean
  /**
   * 10/14 afternoon: whether picking it takes it back here — a check or money
   * order on a slip, or a tenant's own deposit GAM matched as a check or money
   * order. False for a deposit the office logged by hand as a bank deposit (or
   * one not recorded as a check or money order).
   */
  takeBackHere: boolean
  /** 10/14 (follow-up): when it is not taken back here, what the owner can do instead (whatInstead), in words. */
  whyNot: string | null
}

/** Whether a payment a returned line could be is one GAM takes back (by itself, or as a person picks). */
function takenBackHere(i: Pick<ItemInDeposit, 'slip_id' | 'method' | 'deposit_kind'>): boolean {
  if (i.method !== 'check' && i.method !== 'money_order') return false
  return !!i.slip_id || i.deposit_kind == null
}

/**
 * The checks a person may pick for a money-out line in review: every check,
 * money order and tenant's own bank deposit of exactly the line's amount in
 * deposits on that account in the RETURNED_ITEM_PICK_WINDOW_DAYS before it.
 * Empty for a line that is not money out in review.
 */
export async function checkChoices(landlordId: string, lineId: string): Promise<CheckChoice[]> {
  const line = await queryOne<ReturnedLine & { status: string; matched_kind: string | null; expense_id: string | null }>(
    `SELECT id, landlord_id, bank_connection_id, amount::text AS amount, to_char(posted_date, 'YYYY-MM-DD') AS posted_date,
            description, status, matched_kind, expense_id
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [lineId, landlordId])
  if (!line || line.status !== 'needs_review' || toCents(line.amount) >= 0 || line.matched_kind || line.expense_id) return []
  const { items } = await whatItCouldBe(db, {
    landlordId, connectionId: line.bank_connection_id, cents: -toCents(line.amount), day: line.posted_date,
    windowDays: RETURNED_ITEM_PICK_WINDOW_DAYS,
  })
  if (items.length === 0) return []
  const who = await query<{ id: string; name: string | null; spaces: string | null }>(
    `SELECT r.id,
            NULLIF(TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')), '') AS name,
            (SELECT string_agg(DISTINCT un.unit_number, ', ' ORDER BY un.unit_number)
               FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id JOIN units un ON un.id = p.unit_id
              WHERE ra.remittance_id = r.id) AS spaces
       FROM tenant_remittances r
       LEFT JOIN tenants tn ON tn.id = r.tenant_id
       LEFT JOIN users usr ON usr.id = tn.user_id
      WHERE r.id = ANY($1::uuid[])`, [items.map(i => i.remittance_id)])
  const byId = new Map(who.map(w => [w.id, w]))
  return items.map(i => ({
    remittanceId: i.remittance_id, method: i.method, amount: -toCents(line.amount) / 100, depositedOn: i.deposited_on,
    tenantName: byId.get(i.remittance_id)?.name ?? null, spaces: byId.get(i.remittance_id)?.spaces ?? null,
    tenantDeposit: !i.slip_id, takeBackHere: takenBackHere(i), whyNot: takenBackHere(i) ? null : whatInstead(i),
  }))
}

/**
 * The person's pick: this check (or money order) on a matched deposit slip —
 * or (10/14 afternoon) this tenant's own bank deposit GAM matched — is the one
 * that came back on this line. The same take-back as GAM's own — just that
 * payment, the fee, the late fees, the notices — refused in words when it is
 * not clean.
 */
export async function takeBackChosenCheck(o: { landlordId: string; lineId: string; remittanceId: string; by: string }):
  Promise<{ remittanceId: string; reopenedPaymentIds: string[]; fee: FeeOutcome }> {
  const line = await queryOne<ReturnedLine & { status: string }>(
    `SELECT id, landlord_id, bank_connection_id, amount::text AS amount, to_char(posted_date, 'YYYY-MM-DD') AS posted_date,
            description, status
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [o.lineId, o.landlordId])
  if (!line) throw new AppError(404, 'Transaction not found')
  if (toCents(line.amount) >= 0) throw new AppError(409, 'Only money going out can be a check your bank returned.')
  try {
    const done = await takeBackOne(line, { remittanceId: o.remittanceId, by: o.by })
    if (!done) throw new AppError(409, 'This line was filed or matched meanwhile, so nothing was taken back. Look at it again.')
    return done
  } catch (e) {
    if (e instanceof WaitsForAPerson) throw new AppError(409, `${e.why} Nothing was taken back.${e.next ? ` ${e.next}` : ''}`)
    throw e
  }
}

/** The bank's fee line for a returned line, not already billed for another, or null. */
async function feeLineFor(client: PoolClient, line: { landlord_id: string; bank_connection_id: string; id: string; posted_date: string }):
  Promise<{ id: string; cents: number } | null> {
  const rows = (await client.query<{ id: string; amount: string; description: string | null }>(
    `SELECT f.id, f.amount::text AS amount, f.description
       FROM bank_transactions f
      WHERE f.landlord_id = $1 AND f.bank_connection_id = $5 AND f.id <> $2 AND f.amount < 0
        AND f.posted_date BETWEEN $3::date AND ($3::date + $4::int)
        AND COALESCE(f.bank_status, 'posted') <> 'void'
        AND f.ignored_reason IS DISTINCT FROM 'duplicate'
        AND NOT EXISTS (SELECT 1 FROM bank_transactions o
                         WHERE o.landlord_id = f.landlord_id
                           AND o.auto_settle_undo->>'kind' IN ${RETURNED_KINDS_SQL}
                           AND o.auto_settle_undo->>'feeLineId' = f.id::text)
      ORDER BY f.posted_date, f.id`,
    [line.landlord_id, line.id, line.posted_date, RETURNED_FEE_WINDOW_DAYS, line.bank_connection_id])).rows
  const fee = rows.find(r => readReturnedItemMemo(r.description) === 'fee')
  return fee ? { id: fee.id, cents: -toCents(fee.amount) } : null
}

/**
 * The returned-check fee the tenant's signed lease names: a field of a
 * completed lease document labeled as one ("Returned payment fee", "Returned
 * check fee", "NSF fee"), filled in. `cents` when it reads as a plain amount;
 * `unreadable` with its words when it does not ("$25 or 5%"); null when the
 * lease names none.
 */
export async function leaseReturnedFee(runner: Pick<PoolClient, 'query'>, leaseId: string | null):
  Promise<{ cents: number } | { unreadable: string } | null> {
  if (!leaseId) return null
  const v = (await runner.query<{ value: string }>(
    `SELECT TRIM(f.value) AS value
       FROM lease_document_fields f JOIN lease_documents d ON d.id = f.document_id
      WHERE d.lease_id = $1 AND d.status = 'completed'
        AND f.label ~* '(returned|bounced|dishono[u]?red)[[:space:]]+(payment|check|item)|(^|[^a-z])nsf([^a-z]|$)|insufficient[[:space:]]+funds'
        AND NULLIF(TRIM(f.value), '') IS NOT NULL
      ORDER BY d.completed_at DESC NULLS LAST, f.id
      LIMIT 1`, [leaseId])).rows[0]?.value
  if (!v) return null
  const m = /^\$?\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)$/.exec(v)
  const cents = m ? Math.round(Number(m[1].replace(/,/g, '')) * 100) : 0
  return cents > 0 ? { cents } : { unreadable: v }
}

/**
 * Bill the returned-check fee on the tenant's account: the landlord's own
 * one-off charge (a fee, OTHERFEE, revenue_owner 'landlord' — never a monthly
 * SUBSCRIP line work-trade hours could cover), due today on the property's
 * calendar, on the lease and space of the first line the check had paid. On
 * no bill, like every charge owed again (services/creditUse): the bounced
 * bill's own lateness stays its own.
 */
async function billFee(client: PoolClient, o: {
  anchorPaymentId: string; cents: number; returnedOn: string; from: 'lease' | 'bank'; item: Item
}): Promise<string> {
  // 10/14 afternoon: a money order that came back says so (the lease's word, "returned payment").
  const name = o.item === 'check' ? 'Returned check fee' : 'Returned payment fee'
  const id = (await client.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, notes, revenue_owner)
     SELECT a.unit_id, a.lease_id, a.tenant_id, a.landlord_id, 'fee', $2::numeric, 'pending', 'OTHERFEE',
            (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date, $3::text, 'landlord'
       FROM payments a
       LEFT JOIN units u ON u.id = a.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE a.id = $1
     RETURNING id`,
    [o.anchorPaymentId, (o.cents / 100).toFixed(2),
     o.from === 'lease'
       ? `${name} — as the lease names it, for the ${o.item} returned ${o.returnedOn}`
       : `${name} — what the bank charged for the ${o.item} returned ${o.returnedOn}`])).rows[0]?.id
  if (!id) throw new Error('the returned-check fee could not be billed: the line it goes with is gone')
  return id
}

/** The late fees a tenant's own deposit's match took off (zeroed, or credited), to lock with the bill lines. */
function lateFeeIdsOf(m: DepositSettleUndo | null): string[] {
  if (!m) return []
  return [...(m.lateFeesZeroed ?? []).map(z => z.paymentId), ...(m.lateFeesCredited ?? []).map(c => c.paymentId)]
}

/** The day a credited late fee's note says the rent was paid (lateFeeCredit CREDITED_LATE_FEE_NOTE + YYYY-MM-DD), or null. */
function creditedOn(notes: string | null, mark: string): string | null {
  const i = (notes ?? '').lastIndexOf(mark)
  if (i < 0) return null
  const d = (notes ?? '').slice(i + mark.length, i + mark.length + 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/**
 * 10/14 (follow-up — Nic, answer 15: "reopen their invoice with any late fees
 * that apply"; the lane: "the bills reopened with late fees as if never
 * paid"). A tenant's own deposit that came back never paid, so what its match
 * did to late fees because the bank's date showed them never owed is taken
 * back with it, inside the take-back's transaction (the fee rows locked by
 * the caller) — exactly as the deposit's own Undo does it
 * (bankDepositConfirm undoDepositMatch):
 *   - each late fee it took off at $0.00 is owed again as it was before the
 *     match (restoreZeroedLateFee);
 *   - each late fee it paid with a late-fee credit has that credit taken back
 *     and withdrawn (lateFeeCredit withdrawLateFeeCredit), and is owed again;
 *   - each late-fee refund credit it gave for fees already paid is withdrawn.
 * Anything changed since — a fee deleted, charged again or credited
 * otherwise, a refund credit used or withdrawn — waits for a person. Returns
 * what Undo needs to take them off again (lateFeesOffAgain).
 */
async function lateFeesOwedAgain(client: PoolClient, m: DepositSettleUndo, o: {
  tenantId: string; by: string | null; depositedOn: string; waits: (why: string) => WaitsForAPerson
}): Promise<{ owedAgain: LateFeeOwedAgain[]; refundCreditsWithdrawn: string[] }> {
  const owedAgain: LateFeeOwedAgain[] = []
  const zeroed = m.lateFeesZeroed ?? []
  const credited = m.lateFeesCredited ?? []
  const refunds = [...new Set(m.lateFeeRefundCreditIds ?? [])]
  if (zeroed.length + credited.length + refunds.length === 0) return { owedAgain, refundCreditsWithdrawn: [] }
  const [{ restoreZeroedLateFee }, { withdrawLateFeeCredit, CREDITED_LATE_FEE_NOTE }] =
    await Promise.all([import('./bankDepositConfirm'), import('./lateFeeCredit')])

  for (const z of zeroed) {
    const f = (await client.query<{ amount: string; status: string; notes: string | null; settled_at: string | null }>(
      `SELECT amount::text AS amount, status, notes, settled_at::text AS settled_at
         FROM payments WHERE id = $1 AND type = 'late_fee'`, [z.paymentId])).rows[0]
    if (!f || toCents(f.amount) !== 0 || f.status !== 'settled') {
      throw o.waits('A late fee that deposit’s match took off has changed since (deleted, or charged again).')
    }
    await restoreZeroedLateFee(client, z, { tenantId: o.tenantId, by: o.by })
    owedAgain.push({ paymentId: z.paymentId, was: 'zeroed', notes: f.notes, settledAt: f.settled_at })
  }

  for (const c of credited) {
    const f = (await client.query<{ status: string; issued: string; notes: string | null; settled_at: string | null }>(
      `SELECT status, issued_credit_amount::text AS issued, notes, settled_at::text AS settled_at
         FROM payments WHERE id = $1 AND type = 'late_fee'`, [c.paymentId])).rows[0]
    const use = f ? (await client.query<{ status: string; credit_status: string; other_uses: number }>(
      `SELECT u.status, tc.status AS credit_status,
              (SELECT COUNT(*)::int FROM credit_uses x
                WHERE x.tenant_credit_id = u.tenant_credit_id AND x.id <> u.id AND x.status IN ('held','applied')) AS other_uses
         FROM credit_uses u JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
        WHERE u.id = $1 AND u.payment_id = $2
          FOR UPDATE OF u, tc`, [c.useId, c.paymentId])).rows[0] : undefined
    // Charged, paid by its own late-fee credit and nothing else (other credit
    // already on it before the match stays — priorIssued).
    if (!f || f.status !== 'settled' || !use || use.status !== 'applied' || use.credit_status !== 'active' || use.other_uses > 0
        || toCents(f.issued) !== toCents(c.priorIssued ?? 0) + toCents(c.amount)) {
      throw o.waits('A late fee that deposit’s match credited has changed since.')
    }
    await withdrawLateFeeCredit(client, c.paymentId)
    const u = await client.query(
      `UPDATE payments SET status = $2, settled_at = NULL, notes = $3
        WHERE id = $1 AND status = 'settled' AND issued_credit_amount = $4::numeric`,
      [c.paymentId, c.priorStatus === 'failed' ? 'failed' : 'pending', c.priorNotes, (toCents(c.priorIssued ?? 0) / 100).toFixed(2)])
    if ((u.rowCount ?? 0) !== 1) throw o.waits('A late fee that deposit’s match credited has changed since.')
    owedAgain.push({
      paymentId: c.paymentId, was: 'credited', notes: f.notes, settledAt: f.settled_at,
      paidOn: creditedOn(f.notes, CREDITED_LATE_FEE_NOTE) ?? o.depositedOn,
    })
  }

  if (refunds.length > 0) {
    const rows = (await client.query<{ id: string; status: string; used: boolean }>(
      `SELECT tc.id, tc.status,
              EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.tenant_credit_id = tc.id AND cu.status <> 'released') AS used
         FROM tenant_credits tc WHERE tc.id = ANY($1::uuid[]) ORDER BY tc.id FOR UPDATE`, [refunds])).rows
    if (rows.length !== refunds.length || rows.some(r => r.used || r.status !== 'active')) {
      throw o.waits('A late-fee refund credit that deposit’s match gave has been used (or withdrawn) since.')
    }
    await client.query(
      `UPDATE tenant_credits SET status = 'void', voided_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND status = 'active'`, [refunds])
  }
  return { owedAgain, refundCreditsWithdrawn: refunds }
}

/**
 * Undo's half of lateFeesOwedAgain, inside undoReturnedCheck's transaction
 * (the fee rows locked): each late fee the take-back made owed again is taken
 * off again as the deposit's match had it — at $0.00 with its notes and paid
 * time, or paid by a new late-fee credit from the same day
 * (lateFeeCredit creditLateFee; the withdrawn one stays on record, like every
 * credit) — and each late-fee refund credit it withdrew is given again as a
 * new credit of the same amount and words. Refused, changing nothing, when
 * one of those fees was paid or changed since. Returns the deposit's match
 * record with the new credits in it, so the deposit's own Undo takes them back.
 */
async function lateFeesOffAgain(client: PoolClient, u: ReturnedCheckUndo, match: DepositSettleUndo, o: {
  tenantId: string; by: string | null; changed: (why: string) => AppError
}): Promise<DepositSettleUndo> {
  const back = u.lateFeesOwedAgain ?? []
  const next: DepositSettleUndo = { ...match }
  if (back.length > 0) {
    const live = new Map((await client.query<{
      id: string; status: string; amount: string; issued: string; intent: string | null; credit: boolean; paid: boolean
    }>(
      `SELECT p.id, p.status, p.amount::text AS amount, p.issued_credit_amount::text AS issued,
              p.stripe_payment_intent_id AS intent,
              EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('held','applied')
                         AND cu.source IS DISTINCT FROM 'late_fee_credit') AS credit,
              EXISTS (SELECT 1 FROM remittance_applications ra JOIN tenant_remittances r ON r.id = ra.remittance_id
                       WHERE ra.payment_id = p.id AND r.status <> 'failed' AND r.undone_at IS NULL) AS paid
         FROM payments p WHERE p.id = ANY($1::uuid[])`, [back.map(b => b.paymentId)])).rows.map(r => [r.id, r]))
    const zeroedBefore = new Map((match.lateFeesZeroed ?? []).map(z => [z.paymentId, z]))
    const creditedBefore = new Map((match.lateFeesCredited ?? []).map(c => [c.paymentId, c]))
    for (const b of back) {
      const f = live.get(b.paymentId)
      const z = zeroedBefore.get(b.paymentId)
      const c = creditedBefore.get(b.paymentId)
      const asOwed = !!f && (f.status === 'pending' || f.status === 'failed') && !f.intent && !f.paid
      const unchanged = b.was === 'zeroed'
        ? !!z && !!f && toCents(f.amount) === toCents(z.priorAmount) && toCents(f.issued) === 0 && !f.credit
        : !!c && !!f && toCents(f.issued) === toCents(c.priorIssued ?? 0)
      if (!asOwed || !unchanged) throw o.changed('A late fee the bounce made owed again was paid (or changed) since.')
    }
    const { creditLateFee } = await import('./lateFeeCredit')
    const credits = new Map<string, { creditId: string; useId: string }>()
    for (const b of back) {
      if (b.was === 'zeroed') {
        const r = await client.query(
          `UPDATE payments SET amount = 0, status = 'settled', settled_at = $2::timestamptz, next_retry_at = NULL, notes = $3
            WHERE id = $1 AND status IN ('pending', 'failed')`, [b.paymentId, b.settledAt, b.notes])
        if ((r.rowCount ?? 0) !== 1) throw o.changed('A late fee the bounce made owed again has changed since.')
        continue
      }
      const rec = await creditLateFee(client, b.paymentId, { paidOn: b.paidOn ?? u.at.slice(0, 10), tenantId: o.tenantId, createdBy: o.by })
      if (!rec) throw o.changed('A late fee the bounce made owed again could not be credited again.')
      // Its notes and paid time as the match left them (not the note written twice).
      await client.query(`UPDATE payments SET notes = $2, settled_at = $3::timestamptz WHERE id = $1`, [b.paymentId, b.notes, b.settledAt])
      credits.set(b.paymentId, { creditId: rec.creditId, useId: rec.useId })
    }
    if (credits.size > 0) {
      next.lateFeesCredited = (match.lateFeesCredited ?? []).map(c => credits.has(c.paymentId) ? { ...c, ...credits.get(c.paymentId)! } : c)
    }
  }
  const withdrawn = u.refundCreditsWithdrawn ?? []
  if (withdrawn.length > 0) {
    const { createIssuedCredit } = await import('./creditUse')
    const given = new Map<string, string>()
    for (const id of withdrawn) {
      const old = (await client.query<{
        landlord_id: string; tenant_id: string; lease_id: string | null; amount: string; category: string; reason: string | null
      }>(
        `SELECT landlord_id, tenant_id, lease_id, amount_original::text AS amount, category, reason
           FROM tenant_credits WHERE id = $1`, [id])).rows[0]
      if (!old) throw o.changed('A late-fee refund credit the bounce withdrew is missing.')
      given.set(id, await createIssuedCredit(client, {
        landlordId: old.landlord_id, tenantId: old.tenant_id, leaseId: old.lease_id, amount: toCents(old.amount) / 100,
        category: old.category, reason: old.reason, createdBy: o.by,
      }))
    }
    next.lateFeeRefundCreditIds = (match.lateFeeRefundCreditIds ?? []).map(id => given.get(id) ?? id)
  }
  return next
}

/**
 * Take back the one payment a returned line is, in one transaction — a check
 * or money order on a deposit slip, or (10/14 afternoon) a tenant's own bank
 * deposit GAM matched, recorded as a check or money order. `pick` is a
 * person's choice (the payment they say came back); null is GAM by itself.
 * Returns what was taken back, or null when someone acted on the line
 * meanwhile. Throws WaitsForAPerson when GAM is not certain or the take-back
 * is not clean.
 */
async function takeBackOne(line: ReturnedLine, pick: { remittanceId: string; by: string } | null):
  Promise<{ remittanceId: string; reopenedPaymentIds: string[]; fee: FeeOutcome } | null> {
  const cents = -toCents(line.amount)
  if (cents <= 0) return null
  const client = await getClient()
  let done: {
    remittanceId: string; tenantId: string; receivedBy: string | null; reopened: string[]; invoices: string[]
    fee: FeeOutcome; subjects: string[]; depositedOn: string; propertyId: string | null
    item: Item; fromDeposit: boolean; lateFeesBack: number
  } | null = null
  try {
    await client.query('BEGIN')
    // The line first (as every bank-row locker), still untouched in review. A
    // line a person undid is theirs: never taken back by GAM again.
    const still = (await client.query<{ id: string }>(
      `SELECT id FROM bank_transactions
        WHERE id = $1 AND status = 'needs_review' AND amount < 0 AND matched_kind IS NULL
          AND expense_id IS NULL AND landlord_other_income_id IS NULL
          AND COALESCE(bank_status, 'posted') = 'posted'
          ${pick ? '' : 'AND auto_settle_undo IS NULL'}
        FOR UPDATE`, [line.id])).rows[0]
    if (!still) { await client.query('ROLLBACK'); return null }
    const at = (await client.query<{ now: string }>(`SELECT now()::text AS now`)).rows[0].now

    const { items, unseen } = await whatItCouldBe(client, {
      landlordId: line.landlord_id, connectionId: line.bank_connection_id, cents, day: line.posted_date,
      windowDays: pick ? RETURNED_ITEM_PICK_WINDOW_DAYS : RETURNED_ITEM_WINDOW_DAYS,
    })
    let chk: ItemInDeposit
    if (pick) {
      const picked = items.find(i => i.remittance_id === pick.remittanceId)
      if (!picked) throw new WaitsForAPerson(`That payment is not a check or money order of ${money(cents)} in a deposit to this account in the ${RETURNED_ITEM_PICK_WINDOW_DAYS} days before this line.`)
      chk = picked
    } else {
      if (items.length === 0) {
        throw new WaitsForAPerson(`GAM found no check or money order of ${money(cents)} in a deposit matched in the ${RETURNED_ITEM_WINDOW_DAYS} days before it.`)
      }
      if (items.length > 1) {
        throw new WaitsForAPerson(`${items.length} payments of ${money(cents)} were in deposits matched in the ${RETURNED_ITEM_WINDOW_DAYS} days before it, so GAM cannot tell which one came back.`)
      }
      if (unseen > 0) {
        throw new WaitsForAPerson(`Money GAM cannot see inside could hold a check or money order of ${money(cents)} too (a deposit slip's other money, or a deposit not matched to payments in the ${RETURNED_ITEM_WINDOW_DAYS} days before it), so GAM cannot be sure which one came back.`)
      }
      // 10/14 afternoon ("anything that is not exactly one match waits"): one
      // to one both ways — another returned item of this amount on this
      // account, waiting near it, could be this payment just as well.
      const twin = (await client.query<{ description: string | null }>(
        `SELECT description FROM bank_transactions
          WHERE landlord_id = $1 AND bank_connection_id = $2 AND id <> $3 AND amount = $4::numeric
            AND status = 'needs_review' AND COALESCE(bank_status, 'posted') = 'posted'
            AND ignored_reason IS NULL
            AND posted_date BETWEEN ($5::date - $6::int) AND ($5::date + $6::int)`,
        [line.landlord_id, line.bank_connection_id, line.id, line.amount, line.posted_date, RETURNED_ITEM_WINDOW_DAYS])).rows
        .filter(t => readReturnedItemMemo(t.description) === 'item')
      if (twin.length > 0) {
        throw new WaitsForAPerson(`Another returned item of ${money(cents)} is on your bank too, so GAM cannot tell which payment each one is.`)
      }
      chk = items[0]
    }
    // 10/14 afternoon (Nic: "Automatic bounce handling also for: money orders
    // that come back, and a tenant's own single-check bank deposit that comes
    // back"): a check or a money order on a slip, or a tenant's own deposit GAM
    // matched — never one the office logged by hand as a bank deposit (that
    // payment stays as recorded, as in voidWhatBounced), and never a deposit
    // not recorded as a check or money order (cash never comes back).
    const fromDeposit = !chk.slip_id
    const item = itemOf(chk.method)
    // 10/14 (follow-up): GAM knows which payment it is from here on; when it
    // cannot take it back, the owner hears what they can do instead — never to
    // pick it (that is refused for the same reason).
    const waits = (why: string) => new WaitsForAPerson(why, whatInstead(chk))
    if (!takenBackHere(chk)) {
      const what = chk.deposit_kind === 'recorded_deposit'
        ? 'a deposit the office logged by hand as a bank deposit'
        : 'a tenant’s own bank deposit not recorded as a check or money order'
      throw waits(pick
        ? `That is ${what}, which GAM does not take back here.`
        : `The only payment of ${money(cents)} it could be is ${what}, which GAM does not take back by itself.`)
    }
    // A tenant's own deposit: its line (a bank row, so before the receipt —
    // the order every bank-row locker takes), still matched to that receipt by
    // the record a match keeps (bankDepositConfirm DepositSettleUndo), and
    // nothing that match did beyond paying whole bill lines and taking late
    // fees off (those are owed again below — lateFeesOwedAgain).
    let depositMatch: DepositSettleUndo | null = null
    if (fromDeposit) {
      const dep = (await client.query<{ status: string; undo: any }>(
        `SELECT status, auto_settle_undo AS undo FROM bank_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`,
        [chk.bank_line_id, line.landlord_id])).rows[0]
      const s = dep?.undo
      if (!dep || dep.status !== 'matched' || s?.receiptId !== chk.remittance_id || s?.kind || s?.[CAME_BACK_MARK]) {
        throw waits('That deposit’s match has changed since. Look at it again.')
      }
      if (s.version !== 1 || !Array.isArray(s.rows)) {
        throw waits('That deposit was matched before GAM kept a record of everything a match changes, so GAM does not take it back by itself.')
      }
      // A fee the office had credited by hand before the bank's date zeroed it
      // comes only from a deposit the office logged (recordedDepositMatch),
      // never from a tenant's own deposit's match: one that did waits.
      if ((s.lateFeesZeroed ?? []).some((z: { wasCredited?: unknown }) => z.wasCredited)) {
        throw waits('When that deposit was matched, a late fee the office had credited by hand came off by the bank’s date, which GAM does not put back by itself.')
      }
      if (s.paidAheadCreditId) throw waits(`Part of that ${item} was kept as paid-ahead money, which GAM does not take back by itself.`)
      if ((s.securityDepositRaised ?? []).length > 0) throw waits(`The ${item} paid a security deposit, which GAM does not take back by itself.`)
      depositMatch = s as DepositSettleUndo
    }
    const receipt = (await client.query<{ status: string; undone: boolean; amount: string; applied: string; unapplied: string }>(
      `SELECT status, undone_at IS NOT NULL AS undone, amount::text AS amount, applied_amount::text AS applied,
              unapplied_amount::text AS unapplied
         FROM tenant_remittances WHERE id = $1 FOR UPDATE`, [chk.remittance_id])).rows[0]
    if (!receipt || receipt.status !== 'settled' || receipt.undone) { await client.query('ROLLBACK'); return null }

    // The household, then the lines by id (§1.5).
    await lockHousehold(client, chk.tenant_id, chk.landlord_id)
    const apps = (await client.query<{
      payment_id: string; applied: string; amount: string; status: string; manual_method: string | null; type: string
      reversal_id: string | null; invoice_id: string | null; other_receipt: boolean; credit: boolean
      settled_at: string | null; platform_held: boolean; deposit_collected_by: string | null
    }>(
      `SELECT ra.payment_id, ra.amount_applied::text AS applied, p.amount::text AS amount, p.status, p.manual_method,
              p.type, p.reversal_id, p.invoice_id::text AS invoice_id, p.settled_at::text AS settled_at,
              p.platform_held, p.deposit_collected_by,
              EXISTS (SELECT 1 FROM remittance_applications o JOIN tenant_remittances r2 ON r2.id = o.remittance_id
                       WHERE o.payment_id = p.id AND o.remittance_id <> ra.remittance_id
                         AND r2.status <> 'failed' AND r2.undone_at IS NULL) AS other_receipt,
              EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('held','applied')) AS credit
         FROM remittance_applications ra JOIN payments p ON p.id = ra.payment_id
        WHERE ra.remittance_id = $1
        ORDER BY p.due_date, p.created_at, p.id`, [chk.remittance_id])).rows
    // With the late fees a tenant's own deposit's match took off (lateFeesOwedAgain).
    await lockPaymentRowsById(client, [...apps.map(a => a.payment_id), ...lateFeeIdsOf(depositMatch)])

    // ── Clean, or a person looks ─────────────────────────────────────────────
    if (apps.length === 0) throw waits(`The ${item} paid no bill line GAM can reopen.`)
    if (toCents(receipt.unapplied) !== 0 || apps.reduce((s, a) => s + toCents(a.applied), 0) !== toCents(receipt.amount)) {
      throw waits(`Part of that ${item} was kept as credit or paid ahead, which GAM does not take back by itself.`)
    }
    const paidAhead = (await client.query(
      `SELECT 1 FROM lease_prepaid_credits WHERE source_remittance_id = $1 AND voided_at IS NULL LIMIT 1`,
      [chk.remittance_id])).rowCount
    if (paidAhead) throw waits(`Part of that ${item} was kept as paid-ahead money, which GAM does not take back by itself.`)
    for (const a of apps) {
      if (a.status !== 'settled' || a.manual_method !== chk.method) throw waits(`A bill line the ${item} paid has changed since.`)
      if (a.type === 'deposit') throw waits(`The ${item} paid a security deposit, which GAM does not take back by itself.`)
      if (a.reversal_id) throw waits(`A bill line the ${item} paid had been reopened by a returned payment before.`)
      if (a.other_receipt) throw waits(`A bill line the ${item} paid was also paid by another payment.`)
      if (a.credit) throw waits(`Account credit was used on a bill line the ${item} paid.`)
      if (toCents(a.applied) !== toCents(a.amount)) throw waits(`The ${item} paid only part of a bill line.`)
    }

    // ── Take it back ─────────────────────────────────────────────────────────
    const ids = apps.map(a => a.payment_id)
    const note = `${capital(item)} returned by the bank ${line.posted_date} — owed again`
    const reopened = await client.query(
      `UPDATE payments
          SET status = 'pending', settled_at = NULL, manual_method = NULL, next_retry_at = NULL, platform_held = FALSE,
              deposit_collected_by = NULL, notes = COALESCE(notes || ' — ', '') || $2
        WHERE id = ANY($1::uuid[]) AND status = 'settled'`, [ids, note])
    if ((reopened.rowCount ?? 0) !== ids.length) throw waits(`A bill line the ${item} paid has changed since.`)
    // 10/14 (follow-up — Nic, answer 15: "reopen their invoice with any late
    // fees that apply"): a tenant's own deposit never paid, so the late fees
    // its match took off by the bank's date are owed again too.
    const feesBack = depositMatch
      ? await lateFeesOwedAgain(client, depositMatch, {
          tenantId: chk.tenant_id, by: pick?.by ?? null, depositedOn: chk.deposited_on, waits,
        })
      : null
    await client.query(
      `UPDATE tenant_remittances
          SET status = 'failed', undone_at = NOW(), undone_by = $3, updated_at = NOW(),
              notes = COALESCE(notes || ' — ', '') || $2
        WHERE id = $1 AND status = 'settled'`,
      [chk.remittance_id,
       fromDeposit
         ? `Returned by the bank ${line.posted_date}: the ${item} in this bank deposit bounced, so the deposit was taken back off the bills it paid`
         : item === 'check'
           ? `Returned by the bank ${line.posted_date}: the check bounced, so it was taken back off the bills it paid`
           : `Returned by the bank ${line.posted_date}: the money order came back, so it was taken back off the bills it paid`,
       pick?.by ?? null])
    // A tenant's own deposit: the bank allocations its match wrote are marked
    // reversed (as the deposit's own Undo does — the cash control must not
    // count those lines banked, nor the marks read the bank's day for them),
    // and its line says it came back, on this line.
    let allocationPaymentIds: string[] = []
    if (fromDeposit) {
      allocationPaymentIds = (await client.query<{ payment_id: string }>(
        `UPDATE bank_deposit_allocations SET reversed_at = NOW(), reversed_by = $2
          WHERE bank_transaction_id = $1 AND reversed_at IS NULL
        RETURNING payment_id`, [chk.bank_line_id, pick?.by ?? null])).rows.map(r => r.payment_id).sort()
      await client.query(
        `UPDATE bank_transactions
            SET auto_settle_undo = auto_settle_undo || jsonb_build_object('${CAME_BACK_MARK}', $2::jsonb), updated_at = NOW()
          WHERE id = $1`, [chk.bank_line_id, JSON.stringify({ lineId: line.id, postedDate: line.posted_date })])
    }
    // The bills' marks, judged again now they are owed (services/creditBillMarks).
    const subjects = new Set<string>()
    const { syncBillMarksAfterSettle } = await import('./creditLedgerEmitters')
    for (const ch of await syncBillMarksAfterSettle(client, ids)) ch.subjectIds.forEach(sid => subjects.add(sid))

    // The fee: the lease's, else the bank's if its line is in already.
    const anchor = (await client.query<{ lease_id: string | null }>(`SELECT lease_id FROM payments WHERE id = $1`, [ids[0]])).rows[0]
    const leaseFee = await leaseReturnedFee(client, anchor?.lease_id ?? null)
    const bankFee = await feeLineFor(client, line)
    const fee: FeeOutcome = leaseFee && 'cents' in leaseFee ? { kind: 'lease', cents: leaseFee.cents }
      : leaseFee ? { kind: 'unreadable', words: leaseFee.unreadable }
      : bankFee ? { kind: 'bank', cents: bankFee.cents }
      : { kind: 'later' }
    const feePaymentId = fee.kind === 'lease' || fee.kind === 'bank'
      ? await billFee(client, { anchorPaymentId: ids[0], cents: fee.cents, returnedOn: line.posted_date, from: fee.kind, item })
      : null
    const invoices = [...new Set(apps.map(a => a.invoice_id).filter((x): x is string => !!x))].sort()

    const undo: ReturnedCheckUndo = {
      version: 1, kind: fromDeposit ? RETURNED_DEPOSIT_KIND : RETURNED_CHECK_KIND, at,
      returnedReceiptId: chk.remittance_id, slipId: chk.slip_id, propertyId: chk.property_id,
      ...(fromDeposit ? { depositLineId: chk.bank_line_id, allocationPaymentIds } : {}),
      ...(feesBack && feesBack.owedAgain.length > 0 ? { lateFeesOwedAgain: feesBack.owedAgain } : {}),
      ...(feesBack && feesBack.refundCreditsWithdrawn.length > 0 ? { refundCreditsWithdrawn: feesBack.refundCreditsWithdrawn } : {}),
      reopenedPaymentIds: ids,
      rows: apps.map(a => ({
        paymentId: a.payment_id, settledAt: a.settled_at, manualMethod: a.manual_method,
        platformHeld: a.platform_held, depositCollectedBy: a.deposit_collected_by,
      })),
      invoiceIds: invoices,
      feeLineId: bankFee?.id ?? null, feePaymentId,
      feeAmount: fee.kind === 'lease' || fee.kind === 'bank' ? fee.cents / 100 : null, feeFrom: fee.kind,
      pickedBy: pick?.by ?? null,
    }
    await client.query(
      `UPDATE bank_transactions
          SET status = 'matched', matched_at = NOW(), matched_by = $3, auto_settle_undo = $2::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [line.id, JSON.stringify(undo), pick?.by ?? null])
    await client.query('COMMIT')
    done = {
      // A tenant's own deposit was taken at no desk: only the owner and the tenant hear it.
      remittanceId: chk.remittance_id, tenantId: chk.tenant_id, receivedBy: fromDeposit ? null : chk.received_by,
      reopened: ids, invoices, fee, subjects: [...subjects], depositedOn: chk.deposited_on, propertyId: chk.property_id,
      item, fromDeposit, lateFeesBack: feesBack?.owedAgain.length ?? 0,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // After the commit: scores, late fees from each bill's due date, and the notices.
  for (const s of done.subjects) {
    const { recomputeAndSnapshot } = await import('./creditScore')
    await recomputeAndSnapshot(s).catch(err =>
      logger.error({ err, subjectId: s }, '[returned-check] score recompute failed; the nightly run picks it up'))
  }
  const { generateLateFeesForInvoice } = await import('../jobs/lateFees')
  for (const inv of done.invoices) {
    await generateLateFeesForInvoice(inv).catch(err =>
      logger.error({ err, invoiceId: inv }, '[returned-check] late fees not back-filled; the nightly run picks it up'))
  }
  await tellTakenBack(line, { ...done, pickedBy: pick?.by ?? null })
  logger.info({ transactionId: line.id, receiptId: done.remittanceId, reopened: done.reopened.length, picked: !!pick,
    item: done.item, fromDeposit: done.fromDeposit },
    '[returned-check] a payment returned by the bank was taken back')
  return { remittanceId: done.remittanceId, reopenedPaymentIds: done.reopened, fee: done.fee }
}

/**
 * Checks taken back before the bank's fee line showed: the fee is billed when
 * it does (posted within RETURNED_FEE_WINDOW_DAYS of the returned line, synced
 * whenever), once, and the tenant is told. A fee line still not seen
 * FEE_LINE_GIVE_UP_DAYS after the window closed never will be: nothing is
 * billed (feeFrom 'none') and the owner is told, once.
 */
async function billLateFeeLines(landlordId: string): Promise<number> {
  const waiting = await query<{ id: string }>(
    `SELECT id FROM bank_transactions
      WHERE landlord_id = $1 AND status = 'matched' AND auto_settle_undo->>'kind' IN ${RETURNED_KINDS_SQL}
        AND auto_settle_undo->>'feeFrom' = 'later'
      ORDER BY posted_date, id`, [landlordId])
  let n = 0
  for (const w of waiting) {
    const client = await getClient()
    let told: { kind: 'fee_billed' | 'fee_none'; cents: number } | null = null
    let t: (ReturnedLine & { undo: any; overdue: boolean }) | undefined
    try {
      await client.query('BEGIN')
      t = (await client.query<ReturnedLine & { undo: any; overdue: boolean }>(
        `SELECT id, landlord_id, bank_connection_id, amount::text AS amount, to_char(posted_date, 'YYYY-MM-DD') AS posted_date,
                description, auto_settle_undo AS undo,
                CURRENT_DATE > posted_date + $2::int AS overdue
           FROM bank_transactions WHERE id = $1 AND status = 'matched' FOR UPDATE`,
        [w.id, RETURNED_FEE_WINDOW_DAYS + FEE_LINE_GIVE_UP_DAYS])).rows[0]
      const anchor = t?.undo?.reopenedPaymentIds?.[0]
      if (!t || !(RETURNED_KINDS as readonly string[]).includes(t.undo?.kind) || t.undo.feeFrom !== 'later' || !anchor) {
        await client.query('ROLLBACK'); continue
      }
      const fee = await feeLineFor(client, t)
      if (!fee) {
        if (!t.overdue) { await client.query('ROLLBACK'); continue }
        await client.query(
          `UPDATE bank_transactions SET auto_settle_undo = auto_settle_undo || '{"feeFrom":"none"}'::jsonb, updated_at = NOW()
            WHERE id = $1`, [w.id])
        await client.query('COMMIT')
        told = { kind: 'fee_none', cents: 0 }
      } else {
        const feePaymentId = await billFee(client, {
          anchorPaymentId: anchor, cents: fee.cents, returnedOn: t.posted_date, from: 'bank', item: itemOf(t.undo.rows?.[0]?.manualMethod),
        })
        await client.query(
          `UPDATE bank_transactions SET auto_settle_undo = auto_settle_undo || $2::jsonb, updated_at = NOW() WHERE id = $1`,
          [w.id, JSON.stringify({ feeLineId: fee.id, feePaymentId, feeAmount: fee.cents / 100, feeFrom: 'bank' })])
        await client.query('COMMIT')
        told = { kind: 'fee_billed', cents: fee.cents }
        n++
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      logger.warn({ err: e, transactionId: w.id }, '[returned-check] fee not billed')
    } finally {
      client.release()
    }
    if (told && t) await tellAboutLateFee(t, t.undo, told)
  }
  return n
}

// ── Undo ─────────────────────────────────────────────────────────────────────

export interface ReturnedCheckPutBack {
  /** Bill lines the check pays again. */
  paidAgainIds: string[]
  /** The returned-check fee, voided (kept on record), if one was billed. */
  feeVoided: string | null
  /** Late fees the bounce brought, voided (kept on record). */
  lateFeesVoided: string[]
  /** 10/14 follow-up: late fees the deposit's match had taken off and the bounce made owed again, taken off again. */
  lateFeesOffAgain: string[]
  subjects: string[]
  tenantId: string
  remittanceId: string
  /** 10/14 afternoon: what came back — a check, or a money order. */
  item: Item
}

/**
 * Undo a returned check's take-back, inside the caller's transaction (the
 * returned line is locked — bankDepositConfirm undoDepositMatch, or
 * undoReturnedDeposit): the check's payment stands again exactly as it was
 * (its receipt settled, every bill line it paid settled on its old day, by
 * check), the returned-check fee and every late fee written on those bills
 * since the take-back are voided (kept on record), and the bills' marks are
 * judged again. 10/14 afternoon: a tenant's own deposit taken back
 * (RETURNED_DEPOSIT_KIND) also gets its bank allocations back and loses its
 * come-back mark, so its match stands exactly as before. Refused, changing
 * nothing, when the tenant paid what the check paid again since, or paid the
 * fee or one of those late fees. The caller puts the line back in review.
 */
export async function undoReturnedCheck(client: PoolClient, o: {
  lineId: string; landlordId: string; undo: ReturnedCheckUndo; undoneBy: string | null
}): Promise<ReturnedCheckPutBack> {
  const u = o.undo
  const item = itemOf(u?.rows?.[0]?.manualMethod)
  const changed = (why: string) => new AppError(409, `${why} Nothing was undone — the ${item} stays taken back.`)
  if (!u || u.version !== 1 || !u.returnedReceiptId || !Array.isArray(u.rows) || u.rows.length === 0
      || (u.kind === RETURNED_DEPOSIT_KIND && !u.depositLineId)) {
    throw new AppError(409, `This returned ${item} was taken back before GAM kept a record of everything it changed, so it can’t be undone here. Contact GAM support.`)
  }
  // A tenant's own deposit: its line (a bank row, before the receipt), still
  // matched to that receipt and marked as come back on this returned line.
  let depositMatch: DepositSettleUndo | null = null
  if (u.kind === RETURNED_DEPOSIT_KIND) {
    const dep = (await client.query<{ status: string; undo: any }>(
      `SELECT status, auto_settle_undo AS undo FROM bank_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`,
      [u.depositLineId, o.landlordId])).rows[0]
    if (!dep || dep.status !== 'matched' || dep.undo?.receiptId !== u.returnedReceiptId || dep.undo?.[CAME_BACK_MARK]?.lineId !== o.lineId) {
      throw changed('The deposit it came back from has changed since.')
    }
    const { [CAME_BACK_MARK]: _cameBack, ...match } = dep.undo
    depositMatch = match as DepositSettleUndo
  }
  const receipt = (await client.query<{ tenant_id: string; landlord_id: string; status: string; undone: boolean }>(
    `SELECT tenant_id, landlord_id, status, undone_at IS NOT NULL AS undone FROM tenant_remittances WHERE id = $1 FOR UPDATE`,
    [u.returnedReceiptId])).rows[0]
  if (!receipt || receipt.status !== 'failed' || !receipt.undone) throw changed(`The ${item}’s payment has changed since.`)
  await lockHousehold(client, receipt.tenant_id, receipt.landlord_id)
  const ids = u.rows.map(r => r.paymentId)
  const lateFees = u.invoiceIds?.length ? (await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM payments
      WHERE invoice_id = ANY($1::uuid[]) AND type = 'late_fee' AND created_at >= $2::timestamptz
        AND status NOT IN ('voided') ORDER BY id`, [u.invoiceIds, u.at])).rows : []
  await lockPaymentRowsById(client, [...ids, ...(u.feePaymentId ? [u.feePaymentId] : []), ...lateFees.map(f => f.id),
    ...(u.lateFeesOwedAgain ?? []).map(f => f.paymentId)])

  const live = (await client.query<{ id: string; status: string; other_receipt: boolean; credit: boolean; reopened: boolean }>(
    `SELECT p.id, p.status,
            EXISTS (SELECT 1 FROM remittance_applications ra JOIN tenant_remittances r ON r.id = ra.remittance_id
                     WHERE ra.payment_id = p.id AND ra.remittance_id <> $2 AND r.status <> 'failed' AND r.undone_at IS NULL) AS other_receipt,
            EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('held','applied')) AS credit,
            EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id) AS reopened
       FROM payments p WHERE p.id = ANY($1::uuid[])`, [ids, u.returnedReceiptId])).rows
  if (live.length !== ids.length) throw changed(`A bill line the ${item} paid no longer exists.`)
  for (const r of live) {
    if (r.status !== 'pending' && r.status !== 'failed') throw changed(`What the ${item} paid was paid again (or changed) since.`)
    if (r.other_receipt) throw changed(`Another payment went on what the ${item} paid since.`)
    if (r.credit) throw changed(`Account credit was used on what the ${item} paid since.`)
    if (r.reopened) throw changed(`A bill line the ${item} paid was disputed or returned since.`)
  }
  if (lateFees.some(f => f.status !== 'pending' && f.status !== 'failed')) {
    throw changed('A late fee the bounce brought was paid (or changed) since.')
  }
  const { voidUnowedChargesOrRefuse } = await import('./chargeVoids')
  const q = (t: string, p?: any[]) => client.query(t, p)
  let feeVoided: string | null = null
  if (u.feePaymentId) {
    const fee = (await client.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [u.feePaymentId])).rows[0]
    if (fee && fee.status !== 'voided') {
      if (fee.status !== 'pending' && fee.status !== 'failed') throw changed(`The ${feeName(item)} was paid (or changed) since.`)
      const v = await voidUnowedChargesOrRefuse(q, [u.feePaymentId], `Returned ${item} put back: the ${item} went through after all`,
        `The ${feeName(item)} has a payment or credit on it since.`)
      feeVoided = v[0]?.id ?? null
    }
  }
  const lateFeesVoided = (await voidUnowedChargesOrRefuse(q, lateFees.map(f => f.id),
    `Returned ${item} put back: the late fee the bounce brought is not owed`, 'A late fee the bounce brought has a payment or credit on it since.'))
    .map(v => v.id)

  const day = new Date().toISOString().slice(0, 10)
  for (const r of u.rows) {
    const res = await client.query(
      `UPDATE payments
          SET status = 'settled', settled_at = $2::timestamptz, manual_method = $3, platform_held = $4,
              deposit_collected_by = $5, next_retry_at = NULL,
              notes = COALESCE(notes || ' — ', '') || $6
        WHERE id = $1 AND status IN ('pending', 'failed')`,
      [r.paymentId, r.settledAt, r.manualMethod, !!r.platformHeld, r.depositCollectedBy,
       `Returned ${item} put back ${day}: paid by the ${item} again`])
    if ((res.rowCount ?? 0) !== 1) throw changed(`A bill line the ${item} paid has changed since.`)
  }
  await client.query(
    `UPDATE tenant_remittances
        SET status = 'settled', undone_at = NULL, undone_by = NULL, updated_at = NOW(),
            notes = COALESCE(notes || ' — ', '') || $2
      WHERE id = $1 AND status = 'failed'`,
    [u.returnedReceiptId, `Put back ${day}: the returned ${item} was undone, so it pays its bills again`])
  if (u.kind === RETURNED_DEPOSIT_KIND && depositMatch) {
    // The deposit's match stands again: its allocations, the late fees it had
    // taken off taken off again (10/14 follow-up — its record then names the
    // new credits, so its own Undo takes them back), and no come-back mark.
    if (u.allocationPaymentIds?.length) {
      await client.query(
        `UPDATE bank_deposit_allocations SET reversed_at = NULL, reversed_by = NULL
          WHERE bank_transaction_id = $1 AND payment_id = ANY($2::uuid[]) AND reversed_at IS NOT NULL`,
        [u.depositLineId, u.allocationPaymentIds])
    }
    const match = (u.lateFeesOwedAgain?.length || u.refundCreditsWithdrawn?.length)
      ? await lateFeesOffAgain(client, u, depositMatch, { tenantId: receipt.tenant_id, by: o.undoneBy, changed })
      : depositMatch
    await client.query(
      `UPDATE bank_transactions SET auto_settle_undo = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [u.depositLineId, JSON.stringify(match)])
  }
  const subjects = new Set<string>()
  const { syncBillMarksAfterSettle } = await import('./creditLedgerEmitters')
  for (const ch of await syncBillMarksAfterSettle(client, ids)) ch.subjectIds.forEach(sid => subjects.add(sid))
  return {
    paidAgainIds: ids, feeVoided, lateFeesVoided, lateFeesOffAgain: (u.lateFeesOwedAgain ?? []).map(f => f.paymentId),
    subjects: [...subjects], tenantId: receipt.tenant_id, remittanceId: u.returnedReceiptId, item,
  }
}

/**
 * 10/14 afternoon: Undo this match on a returned line that took back a
 * tenant's own bank deposit (RETURNED_DEPOSIT_KIND) — the counterpart of
 * bankDepositConfirm undoDepositMatch's returned-check branch, which knows
 * only RETURNED_CHECK_KIND (the Bank page's Undo and the sync's bank-void
 * handling send this kind here: routes/bankFeed POST /deposits/:id/undo,
 * bankFeed voidWhatBounced). The deposit's match stands again exactly
 * (undoReturnedCheck), and the returned line goes back to review — never taken
 * back by itself again — or, when the bank voided the returned line itself,
 * is set aside as the bank's void. Refused in words, changing nothing, when
 * anything changed since.
 */
export async function undoReturnedDeposit(o: {
  lineId: string; landlordId: string; undoneBy: string | null; bankVoided?: boolean
}): Promise<{
  kind: 'returned_check'; reopenedChargeIds: string[]; lateFeesRestored: number; creditsWithdrawn: string[]
  declarationId: null; checkPutBack: { paidAgainIds: string[]; feeVoided: string | null; lateFeesVoided: string[] }
}> {
  const client = await getClient()
  let r: ReturnedCheckPutBack
  try {
    await client.query('BEGIN')
    const t = (await client.query<{ landlord_id: string; status: string; undo: any }>(
      `SELECT landlord_id, status, auto_settle_undo AS undo FROM bank_transactions WHERE id = $1 FOR UPDATE`, [o.lineId])).rows[0]
    if (!t || t.landlord_id !== o.landlordId) throw new AppError(404, 'Transaction not found')
    if (t.status !== 'matched' || t.undo?.kind !== RETURNED_DEPOSIT_KIND) {
      throw new AppError(409, 'This line is not a returned deposit GAM took back, so there is nothing to undo here.')
    }
    r = await undoReturnedCheck(client, { lineId: o.lineId, landlordId: o.landlordId, undo: t.undo, undoneBy: o.undoneBy })
    // Where the line goes: back to review (a person's call from now on), or set
    // aside as the bank's void — the shape bankDepositConfirm UndoneMarker keeps.
    const marker = {
      ...(o.bankVoided ? { bankVoided: true } : {}),
      version: 1, undone: true, undoneAt: new Date().toISOString(), undoneBy: o.undoneBy, was: t.undo,
    }
    await client.query(
      `UPDATE bank_transactions
          SET status = $3, ignored_reason = $4, matched_at = NULL, matched_by = NULL,
              auto_settle_undo = $2::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [o.lineId, JSON.stringify(marker), o.bankVoided ? 'ignored' : 'needs_review', o.bankVoided ? 'bank_void' : null])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  for (const s of r.subjects) {
    const { recomputeAndSnapshot } = await import('./creditScore')
    await recomputeAndSnapshot(s).catch(err =>
      logger.error({ err, subjectId: s }, '[returned-check] score recompute failed; the nightly run picks it up'))
  }
  await tellCheckPutBack(o.lineId, r, { bankVoided: o.bankVoided })
  return {
    kind: 'returned_check', reopenedChargeIds: [], lateFeesRestored: 0, creditsWithdrawn: [], declarationId: null,
    checkPutBack: { paidAgainIds: r.paidAgainIds, feeVoided: r.feeVoided, lateFeesVoided: r.lateFeesVoided },
  }
}

/** After an undo commits: the tenant is told their check pays again (in the portal). Never throws. */
export async function tellCheckPutBack(lineId: string, p: ReturnedCheckPutBack, o: { bankVoided?: boolean } = {}): Promise<void> {
  try {
    const who = await queryOne<{ tenant_user: string | null; owner: string | null; landlord_id: string; amount: string }>(
      `SELECT tn.user_id AS tenant_user, l.user_id AS owner, bt.landlord_id, bt.amount::text AS amount
         FROM bank_transactions bt JOIN landlords l ON l.id = bt.landlord_id
         LEFT JOIN tenants tn ON tn.id = $2
        WHERE bt.id = $1`, [lineId, p.tenantId])
    if (!who) return
    const amount = money(-toCents(who.amount))
    const { createNotification } = await import('./notifications')
    const item = p.item ?? 'check'
    // 10/14 follow-up: late fees the deposit's match had taken off, owed again by the bounce, came off again too.
    const lateFees = p.lateFeesVoided.length + (p.lateFeesOffAgain?.length ?? 0) > 0
    const extra = [p.feeVoided ? `the ${feeName(item)}` : null, lateFees ? 'the late fees it brought' : null]
      .filter(Boolean).join(' and ')
    if (who.tenant_user && !(await toldAlready(who.tenant_user, lineId, 'put_back'))) {
      await createNotification({
        userId: who.tenant_user, type: NOTICE_TYPE,
        title: `Your returned ${item} was put back`,
        body: `The ${amount} ${item} the bank returned counts as paid again — what it paid is paid${extra ? `, and ${extra} came off your account` : ''}.`,
        actionUrl: '/payments',
        data: { bank_transaction_id: lineId, notice: 'put_back' },
      })
    }
    // The bank itself took its return back: the owner did not press anything, so they hear it.
    if (o.bankVoided && who.owner && !(await toldAlready(who.owner, lineId, 'put_back'))) {
      await createNotification({
        userId: who.owner, landlordId: who.landlord_id, type: NOTICE_TYPE,
        title: `Your bank took back a returned ${item}`,
        body: `Your bank voided the ${amount} returned-${item} line, so GAM put the ${item} back: what it paid is paid again`
          + `${extra ? `, and ${extra} came off (kept on record)` : ''}. The tenant was told.`,
        actionUrl: '/bank',
        data: { bank_transaction_id: lineId, notice: 'put_back' },
      })
    }
  } catch (err) {
    logger.error({ err, lineId }, '[returned-check] could not tell anyone a returned check was put back')
  }
}

/**
 * 10/14 afternoon: the bank voided its own returned-item line, but what GAM
 * took back on it could not be put back by itself (the tenant paid again
 * since, or the fee was paid — bankFeed voidWhatBounced was refused). The
 * owner is told once, in the portal and by email; the take-back stands until
 * they look. Never throws.
 */
export async function tellOwnerReturnVoidStands(lineId: string): Promise<void> {
  try {
    const t = await queryOne<{ landlord_id: string; owner: string | null; amount: string; day: string; method: string | null }>(
      `SELECT bt.landlord_id, l.user_id AS owner, bt.amount::text AS amount, to_char(bt.posted_date, 'YYYY-MM-DD') AS day,
              bt.auto_settle_undo->'rows'->0->>'manualMethod' AS method
         FROM bank_transactions bt JOIN landlords l ON l.id = bt.landlord_id WHERE bt.id = $1`, [lineId])
    if (!t?.owner) return
    const item = itemOf(t.method)
    await tell({
      userId: t.owner, landlordId: t.landlord_id, lineId, kind: 'void_stands',
      title: `Your bank voided a returned ${item} — it needs you`,
      body: `Your bank voided the ${money(-toCents(t.amount))} returned-${item} line of ${t.day}, so the ${item} may have gone through `
        + `after all. GAM could not put it back by itself because something changed since (the tenant paid again, or the `
        + `${feeName(item)} was paid). Look at it on the Bank page.`,
      actionUrl: '/bank',
    })
  } catch (err) {
    logger.error({ err, lineId }, '[returned-check] could not tell the owner a voided returned line stands')
  }
}

// ── Notices ──────────────────────────────────────────────────────────────────

/** Has this notice about this returned line gone to this person already? */
async function toldAlready(userId: string, lineId: string, kind: NoticeKind): Promise<boolean> {
  return !!(await queryOne<{ hit: boolean }>(
    `SELECT TRUE AS hit FROM notifications WHERE user_id = $1 AND type = '${NOTICE_TYPE}'
        AND data->>'bank_transaction_id' = $2 AND data->>'notice' = $3 LIMIT 1`, [userId, lineId, kind]))
}

/** One person's email address, or null. */
async function emailOf(userId: string): Promise<string | null> {
  return (await queryOne<{ email: string | null }>(`SELECT NULLIF(TRIM(email), '') AS email FROM users WHERE id = $1`, [userId]))?.email ?? null
}

/** A notice in the portal and by email (once per person, line and kind). */
async function tell(o: {
  userId: string; landlordId?: string; lineId: string; kind: NoticeKind; title: string; body: string; actionUrl: string
  data?: Record<string, unknown>; replyToPropertyId?: string | null
}): Promise<void> {
  if (await toldAlready(o.userId, o.lineId, o.kind)) return
  const [{ createNotification, emailTemplate }, { replyToProperty }] =
    await Promise.all([import('./notifications'), import('./replyRouting')])
  const email = await emailOf(o.userId)
  await createNotification({
    userId: o.userId, landlordId: o.landlordId, type: NOTICE_TYPE, title: o.title, body: o.body, actionUrl: o.actionUrl,
    data: { ...(o.data ?? {}), bank_transaction_id: o.lineId, notice: o.kind },
    ...(email ? { sendEmail: true, emailTo: email, emailSubject: o.title, emailHtml: emailTemplate(esc(o.title), esc(o.body)) } : {}),
    ...(o.replyToPropertyId ? { replyTo: replyToProperty(o.replyToPropertyId) } : {}),
  })
}

/**
 * The owner, told once that a returned item waits for them — and what to do:
 * pick the payment on the Bank page when GAM cannot tell which it is, or (10/14
 * follow-up) `next` when GAM knows which it is but cannot take it back
 * (whatInstead: the pick would be refused for the same reason). A check or a
 * money order (10/14 afternoon): the bank's line rarely says which. Never throws.
 */
async function tellOwnerItWaits(line: ReturnedLine, why: string, next: string | null): Promise<void> {
  try {
    const owner = (await queryOne<{ user_id: string | null }>(`SELECT user_id FROM landlords WHERE id = $1`, [line.landlord_id]))?.user_id
    if (!owner) return
    await tell({
      userId: owner, landlordId: line.landlord_id, lineId: line.id, kind: 'waits',
      title: 'Your bank returned a check or money order — it needs you',
      body: `Your bank took back ${money(-toCents(line.amount))} on ${line.posted_date} as a returned check or money order. ${why} `
        + (next ?? ('On the Bank page, press "What did this pay?" on that line and pick the one that came back: GAM takes just '
          + 'that payment back, bills the fee for it and tells the tenant. Please do not bill the fee by hand as well.')),
      actionUrl: '/bank',
    })
  } catch (err) {
    logger.error({ err, lineId: line.id }, '[returned-check] could not tell the owner a returned item waits')
  }
}

/**
 * The owner, the person who took the check, and the tenant — each told once,
 * by email too. 10/14 afternoon: a money order says so, and a tenant's own
 * bank deposit is told as theirs (taken at no desk: the owner and the tenant).
 * Never throws.
 */
async function tellTakenBack(line: ReturnedLine, d: {
  remittanceId: string; tenantId: string; receivedBy: string | null; reopened: string[]; fee: FeeOutcome; depositedOn: string
  propertyId: string | null; pickedBy: string | null; item: Item; fromDeposit: boolean
  /** 10/14 follow-up: late fees the deposit's match had taken off, owed again. */
  lateFeesBack?: number
}): Promise<void> {
  try {
    const who = await queryOne<{
      owner: string | null; tenant_user: string | null; name: string | null; spaces: string | null; property_id: string | null
    }>(
      `SELECT l.user_id AS owner, tn.user_id AS tenant_user,
              NULLIF(TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')), '') AS name,
              (SELECT string_agg(DISTINCT un.unit_number, ', ' ORDER BY un.unit_number)
                 FROM payments p JOIN units un ON un.id = p.unit_id WHERE p.id = ANY($3::uuid[])) AS spaces,
              (SELECT un.property_id FROM payments p JOIN units un ON un.id = p.unit_id
                WHERE p.id = ANY($3::uuid[]) ORDER BY p.id LIMIT 1) AS property_id
         FROM landlords l
         JOIN tenants tn ON tn.id = $2
         LEFT JOIN users usr ON usr.id = tn.user_id
        WHERE l.id = $1`, [line.landlord_id, d.tenantId, d.reopened])
    if (!who) return
    const amount = money(-toCents(line.amount))
    const { item } = d
    const fee = feeName(item)
    const whose = who.name ? `${who.name}${who.spaces ? ` (${who.spaces})` : ''}` : who.spaces ? `the household at ${who.spaces}` : 'a tenant'
    const feeWords = d.fee.kind === 'lease'
      ? `A ${fee} of ${money(d.fee.cents)} (what their lease names) was billed to them. `
      : d.fee.kind === 'bank'
        ? `A ${fee} of ${money(d.fee.cents)} (what the bank charged) was billed to them. `
        : d.fee.kind === 'unreadable'
          ? `Their lease names a returned-payment fee GAM could not read as an amount ("${d.fee.words}"), so no fee was billed — add it by hand. `
          : `The ${fee} is billed to them when your bank’s fee for it shows on your account (what the bank charged); if none shows, nothing is billed and you are told. `
    const how = d.fromDeposit
      ? (d.pickedBy ? 'took that deposit back off the bills it paid, as you picked' : 'took that deposit back off the bills it paid, by itself')
      : (d.pickedBy ? `took just that ${item} back, as you picked` : `took just that ${item} back by itself`)
    const staff = [who.owner, d.receivedBy].filter((x, i, a): x is string => !!x && a.indexOf(x) === i)
    for (const userId of staff) {
      await tell({
        userId, landlordId: line.landlord_id, lineId: line.id, kind: 'taken_back',
        title: item === 'check' ? 'A check bounced — GAM took it back' : 'A money order came back — GAM took it back',
        body: d.fromDeposit
          ? `Your bank returned the ${amount} ${item} ${whose} deposited to your account on ${d.depositedOn}. `
            + `GAM ${how}: they are owed again, with any late fees from their due dates`
            + (d.lateFeesBack ? ' (the late fees the deposit’s date had taken off are owed again too)' : '')
            + '. ' + feeWords + 'The tenant was told.'
          : `Your bank returned ${whose}'s ${amount} ${item} from the deposit of ${d.depositedOn}. `
            + `GAM ${how}: the bills it paid are owed again, with any late fees from their due dates, `
            + 'and the rest of the deposit stays as it was. ' + feeWords + 'The tenant was told.',
        actionUrl: '/bank',
        data: { remittance_id: d.remittanceId, payment_ids: d.reopened },
      })
    }
    if (who.tenant_user) {
      const feeLine = d.fee.kind === 'lease' || d.fee.kind === 'bank'
        ? `, and a ${fee} of ${money(d.fee.cents)} is added`
        : d.fee.kind === 'later' ? `. If your landlord’s bank charges a fee for the returned ${item}, that fee is added too` : ''
      await tell({
        userId: who.tenant_user, lineId: line.id, kind: 'taken_back',
        title: `Your ${item} was returned by the bank`,
        body: (d.fromDeposit
          ? `The ${amount} ${item} you deposited on ${d.depositedOn} did not go through — the bank returned it, so it was taken off your bill. `
          : `Your ${amount} ${item} did not go through — the bank returned it, so it was taken off your bill. `)
          + `What it paid is owed again${d.lateFeesBack ? ', with the late fees that had come off for it' : ''}${feeLine}. `
          + 'If you think this is a mistake, check with your bank and tell your landlord.',
        actionUrl: '/payments',
        replyToPropertyId: d.propertyId ?? who.property_id,
      })
    }
  } catch (err) {
    logger.error({ err, lineId: line.id }, '[returned-check] could not tell who took back a returned check')
  }
}

/** The bank's fee line showed later (the tenant hears the fee), or never did (the owner hears nothing was billed). In the portal. Never throws. */
async function tellAboutLateFee(line: ReturnedLine, undo: any, t: { kind: 'fee_billed' | 'fee_none'; cents: number }): Promise<void> {
  try {
    const { createNotification } = await import('./notifications')
    const item = itemOf(undo?.rows?.[0]?.manualMethod)
    if (t.kind === 'fee_billed') {
      const tenantUser = (await queryOne<{ user_id: string | null }>(
        `SELECT tn.user_id FROM tenant_remittances r JOIN tenants tn ON tn.id = r.tenant_id WHERE r.id = $1`,
        [undo?.returnedReceiptId]))?.user_id
      if (!tenantUser || await toldAlready(tenantUser, line.id, 'fee_billed')) return
      await createNotification({
        userId: tenantUser, type: NOTICE_TYPE,
        title: `A ${feeName(item)} was added`,
        body: `Your landlord’s bank charged ${money(t.cents)} for your returned ${money(-toCents(line.amount))} ${item}, so that fee was added to your account.`,
        actionUrl: '/payments',
        data: { bank_transaction_id: line.id, notice: 'fee_billed' },
      })
      return
    }
    const owner = (await queryOne<{ user_id: string | null }>(`SELECT user_id FROM landlords WHERE id = $1`, [line.landlord_id]))?.user_id
    if (!owner || await toldAlready(owner, line.id, 'fee_none')) return
    await createNotification({
      userId: owner, landlordId: line.landlord_id, type: NOTICE_TYPE,
      title: `No ${feeName(item)} was billed`,
      body: `GAM found no fee line from your bank for the ${money(-toCents(line.amount))} ${item} returned on ${line.posted_date}, `
        + `so no ${feeName(item)} was billed to the tenant.`,
      actionUrl: '/bank',
      data: { bank_transaction_id: line.id, notice: 'fee_none' },
    })
  } catch (err) {
    logger.error({ err, lineId: line.id }, '[returned-check] could not tell anyone about the returned-check fee')
  }
}
