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
 *      Exactly ONE payment of exactly that amount, it a check on a slip, and
 *      nothing unseen that could hold it — or nothing happens by itself.
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
 * WHAT WAITS FOR A PERSON (the line stays in review; the owner is told once):
 * nothing or more than one payment of that amount; a deposit GAM cannot see
 * inside that could hold it; the one it could be a money order or a tenant's
 * own bank deposit; a check whose take-back is not clean — money left over
 * from it as credit or paid ahead, a line it paid that changed since (paid
 * again, disputed, credit used on it, a security deposit), or a line paid by
 * more than one payment. The person picks the check on the Bank page
 * (checkChoices, takeBackChosenCheck — the same take-back, fee and notices);
 * a tenant's own bank deposit that bounced is taken back with Undo this match
 * on that deposit, as before.
 *
 * UNDO (undoReturnedCheck, from the Bank page's Undo this match — Nic 10/12:
 * "every bank filing (hand-filed too) can be undone (kept on record)"): the
 * check's payment stands again exactly as it was, the fee and the late fees
 * the bounce brought are voided (kept on record), and the line goes back to
 * review, never taken back by itself again. Refused when anything changed
 * since (the tenant paid again, the fee or a late fee was paid).
 *
 * Money is in CENTS inside this file.
 */
import type { PoolClient } from 'pg'
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
/** The auto_settle_undo kind on a returned line matched to the check it took back. */
export const RETURNED_CHECK_KIND = 'returned_check'
/** The notification type for every notice this file sends. */
const NOTICE_TYPE = 'bank_returned_check'
/** Which notice, so each is sent once per person and line (one email per thing). */
type NoticeKind = 'waits' | 'taken_back' | 'fee_billed' | 'fee_none' | 'put_back'

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
 *            CHECK", "RETURN ITEM CHK 1042"), or a chargeback of one
 *            ("CHARGEBACK DEPOSITED ITEM");
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
  const check = /\b(CHECK|CHECKS|CHK|CK|CHQ|CHEQUE)\b/.test(s)
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
 * Only one item, it a check on a slip, and nothing unseen is taken back by itself.
 */
async function whatItCouldBe(runner: Pick<PoolClient, 'query'>, o: {
  landlordId: string; connectionId: string; cents: number; day: string; windowDays: number
}): Promise<{ items: ItemInDeposit[]; unseen: number }> {
  const amount = (o.cents / 100).toFixed(2)
  const items = (await runner.query<ItemInDeposit>(
    `SELECT r.id AS remittance_id, s.id AS slip_id, r.tenant_id, r.landlord_id, r.payment_method AS method, r.received_by,
            to_char(bt.posted_date, 'YYYY-MM-DD') AS deposited_on, s.property_id, bt.id AS bank_line_id
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
            to_char(bt.posted_date, 'YYYY-MM-DD'), NULL, bt.id
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

/** Why a returned line waits for a person (said in the owner's notice, or to the person who picked). */
class WaitsForAPerson extends Error {
  constructor(public readonly why: string) { super(why) }
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

/** What the take-back wrote on the returned line (bank_transactions.auto_settle_undo). */
export interface ReturnedCheckUndo {
  version: 1; kind: typeof RETURNED_CHECK_KIND; at: string
  returnedReceiptId: string; slipId: string | null; propertyId: string | null
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
        await tellOwnerItWaits(line, e.why)
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
  /** True for a tenant's own bank deposit — taken back with Undo this match on that deposit, not here. */
  tenantDeposit: boolean
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
    tenantDeposit: !i.slip_id,
  }))
}

/**
 * The person's pick: this check (or money order) on a matched deposit slip is
 * the one that came back on this line. The same take-back as GAM's own — just
 * that check, the fee, the late fees, the notices — refused in words when it
 * is not clean.
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
    if (e instanceof WaitsForAPerson) throw new AppError(409, `${e.why} Nothing was taken back.`)
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
                           AND o.auto_settle_undo->>'kind' = '${RETURNED_CHECK_KIND}'
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
  anchorPaymentId: string; cents: number; returnedOn: string; from: 'lease' | 'bank'
}): Promise<string> {
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
       ? `Returned check fee — as the lease names it, for the check returned ${o.returnedOn}`
       : `Returned check fee — what the bank charged for the check returned ${o.returnedOn}`])).rows[0]?.id
  if (!id) throw new Error('the returned-check fee could not be billed: the line it goes with is gone')
  return id
}

/**
 * Take back the one check a returned line is, in one transaction. `pick` is a
 * person's choice (the check they say came back); null is GAM by itself.
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
      if (!picked) throw new WaitsForAPerson(`That payment is not a check of ${money(cents)} in a deposit to this account in the ${RETURNED_ITEM_PICK_WINDOW_DAYS} days before this line.`)
      if (!picked.slip_id) {
        throw new WaitsForAPerson('That is a tenant’s own bank deposit: take it back with Undo this match on that deposit.')
      }
      chk = picked
    } else {
      if (items.length === 0) {
        throw new WaitsForAPerson(`GAM found no check of ${money(cents)} in a deposit matched in the ${RETURNED_ITEM_WINDOW_DAYS} days before it.`)
      }
      if (items.length > 1) {
        throw new WaitsForAPerson(`${items.length} payments of ${money(cents)} were in deposits matched in the ${RETURNED_ITEM_WINDOW_DAYS} days before it, so GAM cannot tell which one came back.`)
      }
      if (unseen > 0) {
        throw new WaitsForAPerson(`Money GAM cannot see inside could hold a check of ${money(cents)} too (a deposit slip's other money, or a deposit not matched to payments in the ${RETURNED_ITEM_WINDOW_DAYS} days before it), so GAM cannot be sure which check came back.`)
      }
      chk = items[0]
      if (chk.method !== 'check' || !chk.slip_id) {
        throw new WaitsForAPerson(chk.method === 'money_order'
          ? `The only payment of ${money(cents)} it could be is a money order, which GAM does not take back by itself.`
          : `The only payment of ${money(cents)} it could be is a tenant’s own bank deposit, which GAM does not take back by itself.`)
      }
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
    await lockPaymentRowsById(client, apps.map(a => a.payment_id))

    // ── Clean, or a person looks ─────────────────────────────────────────────
    const waits = (why: string) => new WaitsForAPerson(why)
    if (apps.length === 0) throw waits('The check paid no bill line GAM can reopen.')
    if (toCents(receipt.unapplied) !== 0 || apps.reduce((s, a) => s + toCents(a.applied), 0) !== toCents(receipt.amount)) {
      throw waits('Part of that check was kept as credit or paid ahead, which GAM does not take back by itself.')
    }
    const paidAhead = (await client.query(
      `SELECT 1 FROM lease_prepaid_credits WHERE source_remittance_id = $1 AND voided_at IS NULL LIMIT 1`,
      [chk.remittance_id])).rowCount
    if (paidAhead) throw waits('Part of that check was kept as paid-ahead money, which GAM does not take back by itself.')
    for (const a of apps) {
      if (a.status !== 'settled' || a.manual_method !== chk.method) throw waits('A bill line the check paid has changed since.')
      if (a.type === 'deposit') throw waits('The check paid a security deposit, which GAM does not take back by itself.')
      if (a.reversal_id) throw waits('A bill line the check paid had been reopened by a returned payment before.')
      if (a.other_receipt) throw waits('A bill line the check paid was also paid by another payment.')
      if (a.credit) throw waits('Account credit was used on a bill line the check paid.')
      if (toCents(a.applied) !== toCents(a.amount)) throw waits('The check paid only part of a bill line.')
    }

    // ── Take it back ─────────────────────────────────────────────────────────
    const ids = apps.map(a => a.payment_id)
    const note = `Check returned by the bank ${line.posted_date} — owed again`
    const reopened = await client.query(
      `UPDATE payments
          SET status = 'pending', settled_at = NULL, manual_method = NULL, next_retry_at = NULL, platform_held = FALSE,
              deposit_collected_by = NULL, notes = COALESCE(notes || ' — ', '') || $2
        WHERE id = ANY($1::uuid[]) AND status = 'settled'`, [ids, note])
    if ((reopened.rowCount ?? 0) !== ids.length) throw waits('A bill line the check paid has changed since.')
    await client.query(
      `UPDATE tenant_remittances
          SET status = 'failed', undone_at = NOW(), undone_by = $3, updated_at = NOW(),
              notes = COALESCE(notes || ' — ', '') || $2
        WHERE id = $1 AND status = 'settled'`,
      [chk.remittance_id, `Returned by the bank ${line.posted_date}: the check bounced, so it was taken back off the bills it paid`,
       pick?.by ?? null])
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
      ? await billFee(client, { anchorPaymentId: ids[0], cents: fee.cents, returnedOn: line.posted_date, from: fee.kind })
      : null
    const invoices = [...new Set(apps.map(a => a.invoice_id).filter((x): x is string => !!x))].sort()

    const undo: ReturnedCheckUndo = {
      version: 1, kind: RETURNED_CHECK_KIND, at,
      returnedReceiptId: chk.remittance_id, slipId: chk.slip_id, propertyId: chk.property_id,
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
      remittanceId: chk.remittance_id, tenantId: chk.tenant_id, receivedBy: chk.received_by, reopened: ids, invoices,
      fee, subjects: [...subjects], depositedOn: chk.deposited_on, propertyId: chk.property_id,
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
  logger.info({ transactionId: line.id, receiptId: done.remittanceId, reopened: done.reopened.length, picked: !!pick },
    '[returned-check] a check returned out of a deposit was taken back')
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
      WHERE landlord_id = $1 AND status = 'matched' AND auto_settle_undo->>'kind' = '${RETURNED_CHECK_KIND}'
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
      if (!t || t.undo?.kind !== RETURNED_CHECK_KIND || t.undo.feeFrom !== 'later' || !anchor) { await client.query('ROLLBACK'); continue }
      const fee = await feeLineFor(client, t)
      if (!fee) {
        if (!t.overdue) { await client.query('ROLLBACK'); continue }
        await client.query(
          `UPDATE bank_transactions SET auto_settle_undo = auto_settle_undo || '{"feeFrom":"none"}'::jsonb, updated_at = NOW()
            WHERE id = $1`, [w.id])
        await client.query('COMMIT')
        told = { kind: 'fee_none', cents: 0 }
      } else {
        const feePaymentId = await billFee(client, { anchorPaymentId: anchor, cents: fee.cents, returnedOn: t.posted_date, from: 'bank' })
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
  subjects: string[]
  tenantId: string
  remittanceId: string
}

/**
 * Undo a returned check's take-back, inside the caller's transaction (the
 * returned line is locked — bankDepositConfirm undoDepositMatch): the check's
 * payment stands again exactly as it was (its receipt settled, every bill
 * line it paid settled on its old day, by check), the returned-check fee and
 * every late fee written on those bills since the take-back are voided (kept
 * on record), and the bills' marks are judged again. Refused, changing
 * nothing, when the tenant paid what the check paid again since, or paid the
 * fee or one of those late fees. The caller puts the line back in review.
 */
export async function undoReturnedCheck(client: PoolClient, o: {
  lineId: string; landlordId: string; undo: ReturnedCheckUndo; undoneBy: string | null
}): Promise<ReturnedCheckPutBack> {
  const u = o.undo
  const changed = (why: string) => new AppError(409, `${why} Nothing was undone — the check stays taken back.`)
  if (!u || u.version !== 1 || !u.returnedReceiptId || !Array.isArray(u.rows) || u.rows.length === 0) {
    throw new AppError(409, 'This returned check was taken back before GAM kept a record of everything it changed, so it can’t be undone here. Contact GAM support.')
  }
  const receipt = (await client.query<{ tenant_id: string; landlord_id: string; status: string; undone: boolean }>(
    `SELECT tenant_id, landlord_id, status, undone_at IS NOT NULL AS undone FROM tenant_remittances WHERE id = $1 FOR UPDATE`,
    [u.returnedReceiptId])).rows[0]
  if (!receipt || receipt.status !== 'failed' || !receipt.undone) throw changed('The check’s payment has changed since.')
  await lockHousehold(client, receipt.tenant_id, receipt.landlord_id)
  const ids = u.rows.map(r => r.paymentId)
  const lateFees = u.invoiceIds?.length ? (await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM payments
      WHERE invoice_id = ANY($1::uuid[]) AND type = 'late_fee' AND created_at >= $2::timestamptz
        AND status NOT IN ('voided') ORDER BY id`, [u.invoiceIds, u.at])).rows : []
  await lockPaymentRowsById(client, [...ids, ...(u.feePaymentId ? [u.feePaymentId] : []), ...lateFees.map(f => f.id)])

  const live = (await client.query<{ id: string; status: string; other_receipt: boolean; credit: boolean; reopened: boolean }>(
    `SELECT p.id, p.status,
            EXISTS (SELECT 1 FROM remittance_applications ra JOIN tenant_remittances r ON r.id = ra.remittance_id
                     WHERE ra.payment_id = p.id AND ra.remittance_id <> $2 AND r.status <> 'failed' AND r.undone_at IS NULL) AS other_receipt,
            EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('held','applied')) AS credit,
            EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id) AS reopened
       FROM payments p WHERE p.id = ANY($1::uuid[])`, [ids, u.returnedReceiptId])).rows
  if (live.length !== ids.length) throw changed('A bill line the check paid no longer exists.')
  for (const r of live) {
    if (r.status !== 'pending' && r.status !== 'failed') throw changed('What the check paid was paid again (or changed) since.')
    if (r.other_receipt) throw changed('Another payment went on what the check paid since.')
    if (r.credit) throw changed('Account credit was used on what the check paid since.')
    if (r.reopened) throw changed('A bill line the check paid was disputed or returned since.')
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
      if (fee.status !== 'pending' && fee.status !== 'failed') throw changed('The returned-check fee was paid (or changed) since.')
      const v = await voidUnowedChargesOrRefuse(q, [u.feePaymentId], 'Returned check put back: the check went through after all',
        'The returned-check fee has a payment or credit on it since.')
      feeVoided = v[0]?.id ?? null
    }
  }
  const lateFeesVoided = (await voidUnowedChargesOrRefuse(q, lateFees.map(f => f.id),
    'Returned check put back: the late fee the bounce brought is not owed', 'A late fee the bounce brought has a payment or credit on it since.'))
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
       `Returned check put back ${day}: paid by the check again`])
    if ((res.rowCount ?? 0) !== 1) throw changed('A bill line the check paid has changed since.')
  }
  await client.query(
    `UPDATE tenant_remittances
        SET status = 'settled', undone_at = NULL, undone_by = NULL, updated_at = NOW(),
            notes = COALESCE(notes || ' — ', '') || $2
      WHERE id = $1 AND status = 'failed'`,
    [u.returnedReceiptId, `Put back ${day}: the returned check was undone, so it pays its bills again`])
  const subjects = new Set<string>()
  const { syncBillMarksAfterSettle } = await import('./creditLedgerEmitters')
  for (const ch of await syncBillMarksAfterSettle(client, ids)) ch.subjectIds.forEach(sid => subjects.add(sid))
  return {
    paidAgainIds: ids, feeVoided, lateFeesVoided, subjects: [...subjects], tenantId: receipt.tenant_id,
    remittanceId: u.returnedReceiptId,
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
    const extra = [p.feeVoided ? 'the returned-check fee' : null, p.lateFeesVoided.length ? 'the late fees it brought' : null]
      .filter(Boolean).join(' and ')
    if (who.tenant_user && !(await toldAlready(who.tenant_user, lineId, 'put_back'))) {
      await createNotification({
        userId: who.tenant_user, type: NOTICE_TYPE,
        title: 'Your returned check was put back',
        body: `The ${amount} check the bank returned counts as paid again — what it paid is paid${extra ? `, and ${extra} came off your account` : ''}.`,
        actionUrl: '/payments',
        data: { bank_transaction_id: lineId, notice: 'put_back' },
      })
    }
    // The bank itself took its return back: the owner did not press anything, so they hear it.
    if (o.bankVoided && who.owner && !(await toldAlready(who.owner, lineId, 'put_back'))) {
      await createNotification({
        userId: who.owner, landlordId: who.landlord_id, type: NOTICE_TYPE,
        title: 'Your bank took back a returned check',
        body: `Your bank voided the ${amount} returned-check line, so GAM put the check back: what it paid is paid again`
          + `${extra ? `, and ${extra} were voided (kept on record)` : ''}. The tenant was told.`,
        actionUrl: '/bank',
        data: { bank_transaction_id: lineId, notice: 'put_back' },
      })
    }
  } catch (err) {
    logger.error({ err, lineId }, '[returned-check] could not tell anyone a returned check was put back')
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

/** The owner, told once that a returned item waits for them. Never throws. */
async function tellOwnerItWaits(line: ReturnedLine, why: string): Promise<void> {
  try {
    const owner = (await queryOne<{ user_id: string | null }>(`SELECT user_id FROM landlords WHERE id = $1`, [line.landlord_id]))?.user_id
    if (!owner) return
    await tell({
      userId: owner, landlordId: line.landlord_id, lineId: line.id, kind: 'waits',
      title: 'Your bank returned a check — it needs you',
      body: `Your bank took back ${money(-toCents(line.amount))} on ${line.posted_date} as a returned check. ${why} `
        + 'On the Bank page, press "What did this pay?" on that line and pick the check that bounced: GAM takes just that '
        + 'check back, bills the returned-check fee and tells the tenant. Please do not bill the fee by hand as well.',
      actionUrl: '/bank',
    })
  } catch (err) {
    logger.error({ err, lineId: line.id }, '[returned-check] could not tell the owner a returned item waits')
  }
}

/** The owner, the person who took the check, and the tenant — each told once, by email too. Never throws. */
async function tellTakenBack(line: ReturnedLine, d: {
  remittanceId: string; tenantId: string; receivedBy: string | null; reopened: string[]; fee: FeeOutcome; depositedOn: string
  propertyId: string | null; pickedBy: string | null
}): Promise<void> {
  try {
    const who = await queryOne<{ owner: string | null; tenant_user: string | null; name: string | null; spaces: string | null }>(
      `SELECT l.user_id AS owner, tn.user_id AS tenant_user,
              NULLIF(TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')), '') AS name,
              (SELECT string_agg(DISTINCT un.unit_number, ', ' ORDER BY un.unit_number)
                 FROM payments p JOIN units un ON un.id = p.unit_id WHERE p.id = ANY($3::uuid[])) AS spaces
         FROM landlords l
         JOIN tenants tn ON tn.id = $2
         LEFT JOIN users usr ON usr.id = tn.user_id
        WHERE l.id = $1`, [line.landlord_id, d.tenantId, d.reopened])
    if (!who) return
    const amount = money(-toCents(line.amount))
    const whose = who.name ? `${who.name}${who.spaces ? ` (${who.spaces})` : ''}` : who.spaces ? `the household at ${who.spaces}` : 'a tenant'
    const feeWords = d.fee.kind === 'lease'
      ? `A returned-check fee of ${money(d.fee.cents)} (what their lease names) was billed to them. `
      : d.fee.kind === 'bank'
        ? `A returned-check fee of ${money(d.fee.cents)} (what the bank charged) was billed to them. `
        : d.fee.kind === 'unreadable'
          ? `Their lease names a returned-payment fee GAM could not read as an amount ("${d.fee.words}"), so no fee was billed — add it by hand. `
          : 'The returned-check fee is billed to them when your bank’s fee for it shows on your account (what the bank charged); if none shows, nothing is billed and you are told. '
    const how = d.pickedBy ? 'took just that check back, as you picked' : 'took just that check back by itself'
    const staff = [who.owner, d.receivedBy].filter((x, i, a): x is string => !!x && a.indexOf(x) === i)
    for (const userId of staff) {
      await tell({
        userId, landlordId: line.landlord_id, lineId: line.id, kind: 'taken_back',
        title: 'A check bounced — GAM took it back',
        body: `Your bank returned ${whose}'s ${amount} check from the deposit of ${d.depositedOn}. `
          + `GAM ${how}: the bills it paid are owed again, with any late fees from their due dates, `
          + 'and the rest of the deposit stays as it was. ' + feeWords + 'The tenant was told.',
        actionUrl: '/bank',
        data: { remittance_id: d.remittanceId, payment_ids: d.reopened },
      })
    }
    if (who.tenant_user) {
      const feeLine = d.fee.kind === 'lease' || d.fee.kind === 'bank'
        ? `, and a returned-check fee of ${money(d.fee.cents)} is added`
        : d.fee.kind === 'later' ? '. If your landlord’s bank charges a fee for the returned check, that fee is added too' : ''
      await tell({
        userId: who.tenant_user, lineId: line.id, kind: 'taken_back',
        title: 'Your check was returned by the bank',
        body: `Your ${amount} check did not go through — the bank returned it, so it was taken off your bill. `
          + `What it paid is owed again${feeLine}. If you think this is a mistake, check with your bank and tell your landlord.`,
        actionUrl: '/payments',
        replyToPropertyId: d.propertyId,
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
    if (t.kind === 'fee_billed') {
      const tenantUser = (await queryOne<{ user_id: string | null }>(
        `SELECT tn.user_id FROM tenant_remittances r JOIN tenants tn ON tn.id = r.tenant_id WHERE r.id = $1`,
        [undo?.returnedReceiptId]))?.user_id
      if (!tenantUser || await toldAlready(tenantUser, line.id, 'fee_billed')) return
      await createNotification({
        userId: tenantUser, type: NOTICE_TYPE,
        title: 'A returned-check fee was added',
        body: `Your landlord’s bank charged ${money(t.cents)} for your returned ${money(-toCents(line.amount))} check, so that fee was added to your account.`,
        actionUrl: '/payments',
        data: { bank_transaction_id: line.id, notice: 'fee_billed' },
      })
      return
    }
    const owner = (await queryOne<{ user_id: string | null }>(`SELECT user_id FROM landlords WHERE id = $1`, [line.landlord_id]))?.user_id
    if (!owner || await toldAlready(owner, line.id, 'fee_none')) return
    await createNotification({
      userId: owner, landlordId: line.landlord_id, type: NOTICE_TYPE,
      title: 'No returned-check fee was billed',
      body: `GAM found no fee line from your bank for the ${money(-toCents(line.amount))} check returned on ${line.posted_date}, `
        + 'so no returned-check fee was billed to the tenant.',
      actionUrl: '/bank',
      data: { bank_transaction_id: line.id, notice: 'fee_none' },
    })
  } catch (err) {
    logger.error({ err, lineId: line.id }, '[returned-check] could not tell anyone about the returned-check fee')
  }
}
