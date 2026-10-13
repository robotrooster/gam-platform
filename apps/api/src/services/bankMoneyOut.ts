/**
 * 10/12 (Nic) — GAM BOOKS, PHASE P6: A BANK LINE GOING OUT MATCHES WHAT IS ALREADY ON RECORD FIRST
 *
 *   Nic, 10/12 (L5): money out is ONE record — every dollar out is an expense,
 *   a bill is an unpaid expense, and filing a bank line CREATES OR MATCHES an
 *   expense.
 *
 * A money-out line on the Bank page is offered, in this order
 * (gam-ledger-design-2026-10-12 §12, BANK_OUT_MATCH_ORDER):
 *   1. open expenses — one, or several that add up to it (a bill, or a check
 *      already written and recorded as paid by check, waiting on its line);
 *      within EXPENSE_MATCH_WINDOW_DAYS of the line's day (its date or due date)
 *   2. GAM's fee debit of the same amount
 *   3. a register refund paid by check
 *   4. a refund check to a tenant or guest
 *   5. a transfer to another of the company's linked accounts (the same money
 *      arriving there)
 *   6. 10/12 (Nic): a payment on one of the company's loans — one typed
 *      already on the Loans page, or the loan's regular payment (split into
 *      principal / interest / escrow; services/booksVendorsLoans
 *      matchLoanPaymentForBankLine makes or links the loan payment)
 * and only when nothing fits is it filed as a new expense (bankFeed
 * categorizeTransaction / splitTransaction). Matching never makes a second
 * record of the same money: the bill's payment names the line; GAM's debit,
 * a refund, a transfer and a loan payment already have their record.
 * A money-IN line is offered one thing here: a loan's money arriving
 * (loan_funding) — the loan is its record, so it is never filed as income.
 *
 * UNFILE (unmatchMoneyOut): every match can be undone (Nic 10/12: "every bank
 * filing (hand-filed too) can be undone (kept on record)"). The payments the
 * match made are voided (kept), a check recorded by hand goes back to waiting
 * for its line, the line goes back to review, and the bill is unpaid again. A
 * line the bank voids after it was matched is undone the same way by itself
 * (the money never left) and set aside as the bank's void.
 *
 * WHO (Nic L19, design §11): the owner, and a bookkeeper with the bank (the
 * company-wide box) and Books write access — money going out is open to them.
 * Money COMING in follows the owner's choice per bookkeeper
 * (bookkeeper_scopes.money_in_filing, bookkeeperMayFileMoneyIn below).
 */
import type { PoolClient } from 'pg'
import {
  BANK_OUT_MATCH_KINDS, BANK_IN_MATCH_KINDS, EXPENSE_MATCH_WINDOW_DAYS, EXPENSE_MATCH_MAX, booksCents, BANK_MATCH_FIRST_CODE,
  DEFAULT_BOOKKEEPER_MONEY_IN_FILING, BOOKKEEPER_MONEY_IN_FILING,
  type BankOutMatchKind, type BankInMatchKind, type BankLineMatchKind, type BookkeeperMoneyInFiling, type LoanPaymentSplit,
} from '@gam/shared'
import { db, getClient, query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { insertPayment } from './landlordExpenses'
import { NOT_RENT_MARK } from './bankDepositCandidates'
// 10/12 (Nic): a mortgage payment leaving the bank is the loan payment, and a
// loan's money arriving is the loan — never an expense or income of its own.
import { findLoanMatchesForBankLine, matchLoanPaymentForBankLine, unmatchLoanBankLine } from './booksVendorsLoans'

type Runner = Pick<PoolClient, 'query'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How far back a refund check or a GAM debit may have been written and still clear on this line. */
const RECORD_LOOKBACK_DAYS = 120
/** Days either side a transfer's two lines may post. */
const TRANSFER_WINDOW_DAYS = 5

/** The key in auto_settle_undo that says a person undid this line's money-out match. */
export const MATCH_UNDONE_MARK = 'moneyOutMatchUndone'

export interface OpenExpenseCandidate {
  kind: 'expense'
  expenseId: string
  /** What is still owed on it. */
  unpaid: number
  amount: number
  expenseDate: string
  dueDate: string | null
  categoryName: string | null
  vendorName: string | null
  description: string | null
  propertyName: string | null
  /** True when it alone is the line's amount. */
  exact: boolean
}
export interface WrittenCheckCandidate {
  kind: 'check_payment'
  paymentId: string
  expenseId: string
  amount: number
  paidOn: string
  categoryName: string | null
  vendorName: string | null
  description: string | null
  exact: boolean
}
export interface RecordCandidate {
  kind: Exclude<BankOutMatchKind, 'expenses'> | BankInMatchKind
  /** The record: GAM's debit, a refund, the other line of a transfer — or, for a loan, the loan. */
  id: string
  amount: number
  day: string
  label: string
  /** A loan payment: how GAM would split the line (cents), editable before matching. */
  split?: LoanPaymentSplit | null
}
export interface MoneyOutMatches {
  lineId: string
  amount: number
  postedDate: string
  expenses: OpenExpenseCandidate[]
  checks: WrittenCheckCandidate[]
  records: RecordCandidate[]
}

interface LineRow {
  id: string; landlord_id: string; bank_connection_id: string; amount: string; posted_date: string
  status: string; ignored_reason: string | null; bank_status: string | null; expense_id: string | null
  landlord_other_income_id: string | null; matched_payment_id: string | null; matched_disbursement_id: string | null
  matched_kind: BankLineMatchKind | null; matched_transfer_line_id: string | null; auto_settle_undo: any
  normalized_merchant: string | null
}

async function lockLine(run: Runner, landlordId: string, lineId: string): Promise<LineRow> {
  if (!UUID.test(lineId)) throw new AppError(404, 'Transaction not found')
  const t = (await run.query<LineRow>(
    `SELECT id, landlord_id, bank_connection_id, amount::text AS amount, posted_date::text AS posted_date, status,
            ignored_reason, bank_status, expense_id, landlord_other_income_id, matched_payment_id,
            matched_disbursement_id, matched_kind, matched_transfer_line_id, auto_settle_undo, normalized_merchant
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [lineId, landlordId])).rows[0]
  if (!t) throw new AppError(404, 'Transaction not found')
  return t
}

/** A money-out line that can still be matched: in review (or one the owner ignored), not filed, not void. */
function assertMatchable(t: LineRow): void {
  if (booksCents(t.amount) >= 0) throw new AppError(409, 'This line is money coming in. Only money going out is matched to expenses or to GAM\'s records.')
  assertStillOpen(t)
}

/** 10/12 (Nic): a money-in line that can still be matched to a loan's money arriving. */
function assertMatchableIn(t: LineRow): void {
  if (booksCents(t.amount) <= 0) throw new AppError(409, 'This line is money going out. A loan\'s money arriving is money coming in.')
  assertStillOpen(t)
}

/** In review (or one the owner ignored), not filed, not matched, not void. */
function assertStillOpen(t: LineRow): void {
  if (t.bank_status === 'void' || t.ignored_reason === 'bank_void') throw new AppError(409, 'Your bank voided this transaction, so there is nothing to match.')
  if (t.status === 'matched') throw new AppError(409, 'This line is already matched. Undo that first to match it to something else.')
  if (t.status === 'categorized' || t.expense_id || t.landlord_other_income_id) {
    throw new AppError(409, 'This line is already filed in your books. Undo that filing first to match it instead.')
  }
  if (t.status === 'ignored' && t.ignored_reason !== 'landlord') {
    throw new AppError(409, t.ignored_reason === 'duplicate'
      ? 'This is a second copy of a transaction already on your feed. Match the original instead.'
      : 'This is from before your books start date. Move the start date earlier to match it.')
  }
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86400000)

/**
 * What a money-out line could be, in the order it is offered (see the header).
 * Open expenses are listed for picking one or several; each record must be
 * the line's amount to the cent.
 */
export async function moneyOutMatchesFor(landlordId: string, lineId: string): Promise<MoneyOutMatches> {
  if (!UUID.test(lineId)) throw new AppError(404, 'Transaction not found')
  const t = await queryOne<LineRow>(
    `SELECT id, landlord_id, bank_connection_id, amount::text AS amount, posted_date::text AS posted_date, status,
            ignored_reason, bank_status, normalized_merchant
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [lineId, landlordId])
  if (!t) throw new AppError(404, 'Transaction not found')
  const lineCents = -booksCents(t.amount)
  const empty: MoneyOutMatches = { lineId, amount: lineCents / 100, postedDate: t.posted_date, expenses: [], checks: [], records: [] }
  if (lineCents < 0) {
    // 10/12 (Nic): money in — only a loan's money arriving is matched here.
    const loans = await findLoanMatchesForBankLine(db, { landlordId, bankTransactionId: lineId })
    return { ...empty, amount: -lineCents / 100, records: loans.filter(l => l.kind === 'loan_funding').map(l => ({
      kind: 'loan_funding' as const, id: l.loanId, amount: -lineCents / 100, day: t.posted_date,
      label: `${l.loanName} from ${l.lenderName}`,
    })) }
  }
  if (lineCents === 0) return empty
  const w = EXPENSE_MATCH_WINDOW_DAYS
  const expenses = (await query<any>(
    `SELECT e.id, e.amount::text AS amount, (e.amount - COALESCE(b.paid, 0))::text AS unpaid,
            e.expense_date::text AS expense_date, e.due_date::text AS due_date, e.description,
            c.name AS category_name, COALESCE(v.name, e.vendor) AS vendor_name, p.name AS property_name
       FROM landlord_expenses e
       LEFT JOIN (SELECT expense_id, sum(amount) AS paid FROM landlord_expense_payments WHERE voided_at IS NULL GROUP BY expense_id) b
              ON b.expense_id = e.id
       LEFT JOIN books_categories c ON c.id = e.category_id
       LEFT JOIN books_vendors v ON v.id = e.vendor_id
       LEFT JOIN properties p ON p.id = e.property_id
      WHERE e.landlord_id = $1 AND e.status = 'active' AND e.amount > COALESCE(b.paid, 0)
        AND (e.expense_date BETWEEN $2::date - $3::int AND $2::date + $3::int
             OR e.due_date BETWEEN $2::date - $3::int AND $2::date + $3::int
             OR (e.expense_date <= $2::date AND (e.due_date IS NULL OR e.due_date >= $2::date - $3::int)))
      ORDER BY abs(e.amount - COALESCE(b.paid, 0) - $4::numeric), abs(e.expense_date - $2::date), e.id
      LIMIT 50`, [landlordId, t.posted_date, w, (lineCents / 100).toFixed(2)]))
    .map((r): OpenExpenseCandidate => ({
      kind: 'expense', expenseId: r.id, unpaid: booksCents(r.unpaid) / 100, amount: booksCents(r.amount) / 100,
      expenseDate: r.expense_date, dueDate: r.due_date, categoryName: r.category_name, vendorName: r.vendor_name,
      description: r.description, propertyName: r.property_name, exact: booksCents(r.unpaid) === lineCents,
    }))
  const checks = (await query<any>(
    `SELECT x.id, x.expense_id, x.amount::text AS amount, x.paid_on::text AS paid_on, e.description,
            c.name AS category_name, COALESCE(v.name, e.vendor) AS vendor_name
       FROM landlord_expense_payments x JOIN landlord_expenses e ON e.id = x.expense_id
       LEFT JOIN books_categories c ON c.id = e.category_id
       LEFT JOIN books_vendors v ON v.id = e.vendor_id
      WHERE x.landlord_id = $1 AND x.voided_at IS NULL AND x.bank_transaction_id IS NULL
        AND x.method IN ('check', 'bank') AND e.status = 'active'
        AND x.paid_on BETWEEN $2::date - $3::int AND $2::date + $4::int
      ORDER BY abs(x.amount - $5::numeric), x.paid_on DESC, x.id
      LIMIT 50`, [landlordId, t.posted_date, RECORD_LOOKBACK_DAYS, w, (lineCents / 100).toFixed(2)]))
    .map((r): WrittenCheckCandidate => ({
      kind: 'check_payment', paymentId: r.id, expenseId: r.expense_id, amount: booksCents(r.amount) / 100, paidOn: r.paid_on,
      categoryName: r.category_name, vendorName: r.vendor_name, description: r.description, exact: booksCents(r.amount) === lineCents,
    }))
  const amt = (lineCents / 100).toFixed(2)
  const records: RecordCandidate[] = []
  for (const d of await query<{ id: string; day: string }>(
    `SELECT d.id, (d.settled_at AT TIME ZONE 'America/Phoenix')::date::text AS day FROM landlord_gam_debits d
      WHERE d.landlord_id = $1 AND d.status = 'succeeded' AND d.settled_at IS NOT NULL AND d.total_amount = $2::numeric
        AND (d.settled_at AT TIME ZONE 'America/Phoenix')::date BETWEEN $3::date - $4::int AND $3::date + 3
        AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_gam_debit_id = d.id)
      ORDER BY d.settled_at DESC`, [landlordId, amt, t.posted_date, RECORD_LOOKBACK_DAYS])) {
    records.push({ kind: 'gam_debit', id: d.id, amount: lineCents / 100, day: d.day, label: 'GAM fees taken from your bank' })
  }
  for (const r of await query<{ id: string; day: string }>(
    `SELECT r.id, (r.created_at AT TIME ZONE 'America/Phoenix')::date::text AS day FROM pos_refunds r
      WHERE r.landlord_id = $1 AND r.refund_method = 'check' AND r.reversed_at IS NULL AND r.stay_refund_part_id IS NULL
        AND r.amount = $2::numeric
        AND (r.created_at AT TIME ZONE 'America/Phoenix')::date BETWEEN $3::date - $4::int AND $3::date + 3
        AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_pos_refund_id = r.id)
      ORDER BY r.created_at DESC`, [landlordId, amt, t.posted_date, RECORD_LOOKBACK_DAYS])) {
    records.push({ kind: 'pos_refund', id: r.id, amount: lineCents / 100, day: r.day, label: 'A register refund by check' })
  }
  for (const r of await query<{ id: string; day: string; label: string }>(
    `SELECT r.id, (r.refunded_at AT TIME ZONE 'America/Phoenix')::date::text AS day, r.label FROM stay_refund_parts r
      WHERE r.landlord_id = $1 AND r.kind IN ('check', 'money_order') AND r.status IN ('refunded', 'handed_back')
        AND r.reversed_at IS NULL AND r.amount = $2::numeric
        AND (r.refunded_at AT TIME ZONE 'America/Phoenix')::date BETWEEN $3::date - $4::int AND $3::date + 3
        AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_refund_part_id = r.id)
      ORDER BY r.refunded_at DESC`, [landlordId, amt, t.posted_date, RECORD_LOOKBACK_DAYS])) {
    records.push({ kind: 'refund_part', id: r.id, amount: lineCents / 100, day: r.day, label: r.label || 'A refund check' })
  }
  for (const o of await query<{ id: string; day: string; name: string | null }>(
    `SELECT o.id, o.posted_date::text AS day, COALESCE(NULLIF(c.display_name, ''), c.institution_name) AS name
       FROM bank_transactions o JOIN bank_connections c ON c.id = o.bank_connection_id
      WHERE o.landlord_id = $1 AND o.bank_connection_id <> $2 AND o.amount = $3::numeric
        AND o.posted_date BETWEEN $4::date - $5::int AND $4::date + $5::int
        AND (o.status = 'needs_review' OR (o.status = 'ignored' AND o.ignored_reason = 'landlord'))
        AND o.expense_id IS NULL AND o.landlord_other_income_id IS NULL AND o.matched_kind IS NULL
        AND COALESCE(o.bank_status, 'posted') <> 'void'
      ORDER BY abs(o.posted_date - $4::date), o.id`, [landlordId, t.bank_connection_id, amt, t.posted_date, TRANSFER_WINDOW_DAYS])) {
    records.push({ kind: 'transfer', id: o.id, amount: lineCents / 100, day: o.day, label: `Arrived in ${o.name ?? 'another of your accounts'}` })
  }
  // 10/12 (Nic): a payment on one of the company's loans (a payment typed
  // already, or the loan's regular payment), split as GAM suggests.
  for (const l of await findLoanMatchesForBankLine(db, { landlordId, bankTransactionId: lineId })) {
    if (l.kind !== 'loan_payment') continue
    records.push({
      kind: 'loan_payment', id: l.loanId, amount: lineCents / 100, day: l.paidOn ?? t.posted_date,
      label: `${l.loanName} (${l.lenderName})${l.loanPaymentId ? ' — the payment you recorded' : ''}`,
      split: l.suggested,
    })
  }
  return { ...empty, expenses, checks, records }
}

/** One record a money-out line fits to the cent (exactMoneyOutFits). */
export interface ExactMoneyOutFit {
  kind: 'expense' | 'check_payment' | RecordCandidate['kind']
  id: string
  label: string
}

/**
 * 10/12 review (Nic L5, design §12 "match first"): what already on record
 * fits this money-out line to the cent — an open expense whose unpaid part is
 * the line, a check written for the line's amount, and every record candidate
 * (GAM's fee debit, a register refund or refund check, a transfer, a loan's
 * payment — each offered only at the line's exact amount). Empty for money in.
 */
export async function exactMoneyOutFits(landlordId: string, lineId: string): Promise<ExactMoneyOutFit[]> {
  const t = await queryOne<{ amount: string }>(
    `SELECT amount::text AS amount FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [lineId, landlordId])
  if (!t || booksCents(t.amount) >= 0) return []
  const m = await moneyOutMatchesFor(landlordId, lineId)
  return [
    ...m.expenses.filter(e => e.exact).map((e): ExactMoneyOutFit => ({
      kind: 'expense', id: e.expenseId,
      label: [e.categoryName ?? 'Expense', e.vendorName, e.description].filter(Boolean).join(' · '),
    })),
    ...m.checks.filter(c => c.exact).map((c): ExactMoneyOutFit => ({
      kind: 'check_payment', id: c.paymentId, label: `A check written ${c.paidOn}${c.vendorName ? ` to ${c.vendorName}` : ''}`,
    })),
    ...m.records.filter(r => r.kind !== 'loan_funding').map((r): ExactMoneyOutFit => ({ kind: r.kind, id: r.id, label: r.label })),
  ]
}

/**
 * 10/12 review: refuses (409, BANK_MATCH_FIRST_CODE, with the fits) filing a
 * money-out line as a NEW expense while something on record fits it to the
 * cent — unless the person said it is none of them (`notAMatch`). Filed by
 * category instead, an open bill stayed owed and the cost counted twice (a
 * repair's automatic bill, payroll's take-home bill, a contractor's hours
 * bill), and GAM's fee debit counted as an expense beside GAM's own fee line.
 */
export async function refuseFilingWhenMoneyOutFits(landlordId: string, lineId: string, notAMatch: boolean | undefined): Promise<void> {
  if (notAMatch) return
  const matches = await exactMoneyOutFits(landlordId, lineId)
  if (!matches.length) return
  throw new AppError(409,
    'This bank line fits something already on your books to the cent (a bill, a check you wrote, GAM\'s fees, a refund, '
    + 'a transfer or a loan payment). Match it under "What did this pay?" so it is counted once, or say it is none of them '
    + 'and file it as a new expense.',
    { code: BANK_MATCH_FIRST_CODE, matches })
}

/**
 * Match a money-out line to open expenses (each paid from the line, oldest
 * first up to what it still owes) and/or checks already recorded as written
 * (the check's payment now names the line). The parts must come to the line's
 * amount to the cent — except one expense alone, which the line may pay only
 * part of (a bill paid in parts).
 */
export async function matchLineToExpenses(input: {
  landlordId: string; lineId: string; expenseIds?: string[]; paymentIds?: string[]; by: string | null
}): Promise<{ paymentIds: string[] }> {
  const expenseIds = [...new Set(input.expenseIds ?? [])]
  const paymentIds = [...new Set(input.paymentIds ?? [])]
  if (!expenseIds.length && !paymentIds.length) throw new AppError(400, 'Choose the expenses this bank line paid.')
  if (expenseIds.length + paymentIds.length > EXPENSE_MATCH_MAX) throw new AppError(400, `A bank line is matched to at most ${EXPENSE_MATCH_MAX} expenses.`)
  for (const id of [...expenseIds, ...paymentIds]) if (!UUID.test(id)) throw new AppError(400, 'Choose expenses from the list.')
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const t = await lockLine(client, input.landlordId, input.lineId)
    assertMatchable(t)
    const lineCents = -booksCents(t.amount)
    const exps = (await client.query<{ id: string; amount: string; paid: string; day: string }>(
      `SELECT e.id, e.amount::text AS amount, e.expense_date::text AS day,
              COALESCE((SELECT sum(p.amount) FROM landlord_expense_payments p WHERE p.expense_id = e.id AND p.voided_at IS NULL), 0)::text AS paid
         FROM landlord_expenses e
        WHERE e.id = ANY($1::uuid[]) AND e.landlord_id = $2 AND e.status = 'active'
        ORDER BY e.expense_date, e.created_at, e.id FOR UPDATE OF e`, [expenseIds, input.landlordId])).rows
    if (exps.length !== expenseIds.length) throw new AppError(404, 'One of those expenses is not this company\'s, or was voided.')
    const checks = (await client.query<{ id: string; amount: string; method: string; bank_transaction_id: string | null; voided_at: string | null; live: boolean }>(
      `SELECT x.id, x.amount::text AS amount, x.method, x.bank_transaction_id, x.voided_at::text AS voided_at,
              (e.status = 'active') AS live
         FROM landlord_expense_payments x JOIN landlord_expenses e ON e.id = x.expense_id
        WHERE x.id = ANY($1::uuid[]) AND x.landlord_id = $2 FOR UPDATE OF x`, [paymentIds, input.landlordId])).rows
    if (checks.length !== paymentIds.length) throw new AppError(404, 'One of those payments is not this company\'s.')
    for (const c of checks) {
      if (c.voided_at || !c.live) throw new AppError(409, 'One of those payments was taken back.')
      if (c.bank_transaction_id) throw new AppError(409, 'One of those payments is already matched to a bank line.')
      if (c.method !== 'check' && c.method !== 'bank') throw new AppError(409, 'Only a check or a bank payment clears on a bank line.')
    }
    const owed = exps.map(e => booksCents(e.amount) - booksCents(e.paid))
    if (owed.some(o => o <= 0)) throw new AppError(409, 'One of those expenses is already paid in full.')
    const checkCents = checks.reduce((s, c) => s + booksCents(c.amount), 0)
    const owedCents = owed.reduce((s, o) => s + o, 0)
    const partial = exps.length === 1 && !checks.length && lineCents < owedCents
    if (!partial && checkCents + owedCents !== lineCents) {
      const sum = ((checkCents + owedCents) / 100).toFixed(2)
      throw new AppError(409, `Those come to $${sum}, but the bank line is $${(lineCents / 100).toFixed(2)}. Choose expenses that add up to the line.`)
    }
    const made: string[] = []
    for (const [i, e] of exps.entries()) {
      made.push(await insertPayment(client, {
        expenseId: e.id, landlordId: input.landlordId, paidOn: t.posted_date,
        amountCents: partial ? lineCents : owed[i], method: 'bank', bankConnectionId: t.bank_connection_id,
        bankTransactionId: t.id, source: 'bank_match', memo: null, createdBy: input.by,
      }))
    }
    for (const c of checks) {
      await client.query(
        `UPDATE landlord_expense_payments SET bank_transaction_id = $2, bank_connection_id = $3, updated_at = now() WHERE id = $1`,
        [c.id, t.id, t.bank_connection_id])
    }
    await client.query(
      `UPDATE bank_transactions
          SET status = 'matched', ignored_reason = NULL, matched_kind = 'expenses', matched_at = now(), matched_by = $2,
              updated_at = now()
        WHERE id = $1`, [t.id, input.by])
    await client.query('COMMIT')
    return { paymentIds: [...made, ...checks.map(c => c.id)] }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Match a money-out line to a record GAM already has: its fee debit, a
 * register refund by check, a refund check, or the same money arriving in
 * another of the company's linked accounts (a transfer). The amounts must be
 * the same to the cent; each record is matched to one line.
 * 10/12 (Nic): or to one of the company's loans (recordId = the loan): money
 * out becomes that loan's payment (a payment typed already, or one made from
 * the line, split as `split` says or as GAM suggests), money in is the loan's
 * money arriving. The loan record names the line; it is what posts.
 */
export async function matchLineToRecord(input: {
  landlordId: string; lineId: string; kind: Exclude<BankOutMatchKind, 'expenses'> | BankInMatchKind; recordId: string; by: string | null
  split?: LoanPaymentSplit | null
}): Promise<void> {
  const loanKind = input.kind === 'loan_payment' || (BANK_IN_MATCH_KINDS as readonly string[]).includes(input.kind)
  if (!loanKind && (!(BANK_OUT_MATCH_KINDS as readonly string[]).includes(input.kind) || input.kind === ('expenses' as string))) {
    throw new AppError(400, 'Choose what this bank line was.')
  }
  if (!UUID.test(input.recordId)) throw new AppError(400, 'Choose a record from the list.')
  if (input.split && input.kind !== 'loan_payment') throw new AppError(400, 'Only a loan payment is split into principal, interest and escrow.')
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const t = await lockLine(client, input.landlordId, input.lineId)
    if (loanKind) {
      if (input.kind === 'loan_funding') assertMatchableIn(t); else assertMatchable(t)
      const m = await matchLoanPaymentForBankLine(client, {
        landlordId: input.landlordId, bankTransactionId: t.id, loanId: input.recordId, split: input.split ?? null, actorUserId: input.by,
      })
      if (!m || m.kind !== input.kind || m.loanId !== input.recordId) {
        throw new AppError(409, input.kind === 'loan_funding'
          ? 'That loan was not made into this account for this amount within a week of this line.'
          : 'That loan has no payment that fits this line.')
      }
      await client.query(
        `UPDATE bank_transactions SET status = 'matched', ignored_reason = NULL, matched_kind = $2, matched_at = now(),
                matched_by = $3, updated_at = now()
          WHERE id = $1`, [t.id, input.kind, input.by])
      await client.query('COMMIT')
      return
    }
    assertMatchable(t)
    const amt = (-booksCents(t.amount) / 100).toFixed(2)
    const found = async (sql: string) => (await client.query(sql, [input.recordId, input.landlordId, amt])).rows[0]
    let col: string
    if (input.kind === 'gam_debit') {
      if (!await found(`SELECT 1 FROM landlord_gam_debits WHERE id = $1 AND landlord_id = $2 AND status = 'succeeded' AND total_amount = $3::numeric FOR UPDATE`)) {
        throw new AppError(409, 'That GAM fee debit is not this amount, or did not go through.')
      }
      col = 'matched_gam_debit_id'
    } else if (input.kind === 'pos_refund') {
      if (!await found(`SELECT 1 FROM pos_refunds WHERE id = $1 AND landlord_id = $2 AND refund_method = 'check' AND reversed_at IS NULL AND amount = $3::numeric FOR UPDATE`)) {
        throw new AppError(409, 'That register refund was not paid by check for this amount.')
      }
      col = 'matched_pos_refund_id'
    } else if (input.kind === 'refund_part') {
      if (!await found(`SELECT 1 FROM stay_refund_parts WHERE id = $1 AND landlord_id = $2 AND kind IN ('check', 'money_order') AND status IN ('refunded', 'handed_back') AND reversed_at IS NULL AND amount = $3::numeric FOR UPDATE`)) {
        throw new AppError(409, 'That refund was not paid by check for this amount.')
      }
      col = 'matched_refund_part_id'
    } else {
      const other = await lockLine(client, input.landlordId, input.recordId)
      if (other.bank_connection_id === t.bank_connection_id) throw new AppError(409, 'A transfer goes to another of your accounts.')
      if (booksCents(other.amount) !== -booksCents(t.amount)) throw new AppError(409, 'The money arriving there is not the same amount.')
      if (other.status === 'matched' || other.status === 'categorized' || other.expense_id || other.landlord_other_income_id
          || other.bank_status === 'void' || (other.status === 'ignored' && other.ignored_reason !== 'landlord')) {
        throw new AppError(409, 'The line it arrived as is already filed or matched. Undo that first.')
      }
      await client.query(
        `UPDATE bank_transactions SET status = 'matched', ignored_reason = NULL, matched_kind = 'transfer',
                matched_transfer_line_id = $2, matched_at = now(), matched_by = $3, updated_at = now()
          WHERE id = $1`, [other.id, t.id, input.by])
      col = 'matched_transfer_line_id'
    }
    try {
      await client.query(
        `UPDATE bank_transactions SET status = 'matched', ignored_reason = NULL, matched_kind = $2, ${col} = $3,
                matched_at = now(), matched_by = $4, updated_at = now()
          WHERE id = $1`, [t.id, input.kind, input.recordId, input.by])
    } catch (e: any) {
      if (e?.code === '23505') throw new AppError(409, 'That record is already matched to another bank line.')
      throw e
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Undo a money-out match, in the caller's transaction (the line is locked):
 * the payments the match made are voided (kept), a check recorded by hand is
 * free again, a transfer's other line is released too, and the line goes
 * back to review — or, when the bank voided it, is set aside as the bank's void.
 */
export async function unmatchMoneyOutIn(client: Runner, t: Pick<LineRow, 'id' | 'landlord_id' | 'matched_kind' | 'matched_transfer_line_id' | 'bank_status'>,
  by: string | null, reason: string): Promise<{ voidedPayments: number }> {
  if (!t.matched_kind) throw new AppError(409, 'This line is not matched to anything you can undo here.')
  // 10/12 (Nic): a loan payment made from the line is voided (kept), one typed
  // first is only unlinked, a loan's funding line is unlinked.
  let loanVoided = 0
  if (t.matched_kind === 'loan_payment' || t.matched_kind === 'loan_funding') {
    loanVoided = (await unmatchLoanBankLine(client, { landlordId: t.landlord_id, bankTransactionId: t.id, actorUserId: by, reason })).voidedPaymentIds.length
  }
  const voided = await client.query(
    `UPDATE landlord_expense_payments SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now()
      WHERE bank_transaction_id = $1 AND source = 'bank_match' AND voided_at IS NULL`, [t.id, by, reason])
  await client.query(
    `UPDATE landlord_expense_payments SET bank_transaction_id = NULL, updated_at = now()
      WHERE bank_transaction_id = $1 AND source <> 'bank_match' AND voided_at IS NULL`, [t.id])
  const mark = JSON.stringify({ at: new Date().toISOString(), by, kind: t.matched_kind, reason })
  const release = async (id: string, voidedByBank: boolean) => client.query(
    `UPDATE bank_transactions
        SET status = $2, ignored_reason = CASE WHEN $2 = 'ignored' THEN 'bank_void' ELSE NULL END,
            matched_kind = NULL, matched_gam_debit_id = NULL, matched_pos_refund_id = NULL, matched_refund_part_id = NULL,
            matched_transfer_line_id = NULL, matched_at = NULL, matched_by = NULL,
            auto_settle_undo = COALESCE(auto_settle_undo, '{}'::jsonb) || jsonb_build_object('${MATCH_UNDONE_MARK}', $3::jsonb),
            updated_at = now()
      WHERE id = $1`, [id, voidedByBank ? 'ignored' : 'needs_review', mark])
  if (t.matched_kind === 'transfer') {
    // Both lines of the transfer: the one going out names the one arriving, or the other way round.
    const pair = (await client.query<{ id: string; bank_status: string | null }>(
      `SELECT id, bank_status FROM bank_transactions
        WHERE landlord_id = $1 AND id <> $2 AND (id = $3 OR matched_transfer_line_id = $2) FOR UPDATE`,
      [t.landlord_id, t.id, t.matched_transfer_line_id])).rows
    for (const p of pair) await release(p.id, p.bank_status === 'void')
  }
  await release(t.id, t.bank_status === 'void')
  return { voidedPayments: (voided.rowCount ?? 0) + loanVoided }
}

/** Undo a money-out match by itself (the owner's or a bookkeeper's press). */
export async function unmatchMoneyOut(landlordId: string, lineId: string, opts: { by?: string | null } = {}): Promise<{ voidedPayments: number }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const t = await lockLine(client, landlordId, lineId)
    if (t.status !== 'matched' || !t.matched_kind) throw new AppError(409, 'This line is not matched to anything you can undo here.')
    const out = await unmatchMoneyOutIn(client, t, opts.by ?? null, 'The bank-line match was undone')
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * A line the bank voided after it was matched: the money never left, so the
 * match is undone by itself (the bills are unpaid again) and the line is set
 * aside as the bank's void. Never throws (the sync carries on).
 */
export async function releaseVoidedMoneyOutMatches(lineIds: string[]): Promise<number> {
  let n = 0
  for (const id of lineIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const t = (await client.query<LineRow>(
        `SELECT id, landlord_id, matched_kind, matched_transfer_line_id, bank_status, status
           FROM bank_transactions WHERE id = $1 FOR UPDATE`, [id])).rows[0]
      if (t && t.status === 'matched' && t.matched_kind && t.bank_status === 'void') {
        await unmatchMoneyOutIn(client, t, null, 'The bank voided this transaction')
        n++
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      const { logger } = await import('../lib/logger')
      logger.error({ err: e, transactionId: id }, '[bank-feed] a voided bank line kept its money-out match')
    } finally {
      client.release()
    }
  }
  return n
}

// ── Nic L19: what a bookkeeper may file of the money coming in ──────────────

/** The owner's choice for this bookkeeper (DEFAULT_BOOKKEEPER_MONEY_IN_FILING when none). */
export async function bookkeeperMoneyInFiling(userId: string, landlordId: string): Promise<BookkeeperMoneyInFiling> {
  const r = await queryOne<{ money_in_filing: string | null }>(
    `SELECT money_in_filing FROM bookkeeper_scopes WHERE user_id = $1 AND landlord_id = $2 ORDER BY created_at LIMIT 1`,
    [userId, landlordId])
  const v = r?.money_in_filing
  return (BOOKKEEPER_MONEY_IN_FILING as readonly string[]).includes(v ?? '') ? v as BookkeeperMoneyInFiling : DEFAULT_BOOKKEEPER_MONEY_IN_FILING
}

/**
 * Refuses (403) a bookkeeper filing, splitting, ignoring or undoing a line of
 * money COMING in unless the owner's choice for them allows it: 'any', or
 * 'after_not_rent' with the line marked "Not rent" by someone who takes
 * payments. A deposit filed or ignored leaves the rent queue, and a tenant's
 * rent filed as other income stays open on the tenant's account with late
 * fees following (design §11). Money going out passes.
 */
export async function assertBookkeeperMayFileLine(user: { role?: string; userId?: string }, landlordId: string, lineId: string): Promise<void> {
  if (user.role !== 'bookkeeper') return
  const t = await queryOne<{ amount: string; marked: boolean }>(
    `SELECT amount::text AS amount, (auto_settle_undo ? '${NOT_RENT_MARK}') AS marked
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [lineId, landlordId])
  if (!t) throw new AppError(404, 'Transaction not found')
  if (booksCents(t.amount) < 0) return
  const choice = await bookkeeperMoneyInFiling(user.userId ?? '', landlordId)
  if (choice === 'any') return
  if (choice === 'after_not_rent' && t.marked) return
  // 10/12 review: "Not rent" is the owner's to mark (POST /bank-feed/deposits/
  // :id/not-rent is requireLandlord), so the bookkeeper is sent to the owner.
  throw new AppError(403, choice === 'never'
    ? 'The owner keeps money coming in to themselves. Money going out is yours to file.'
    : 'This deposit may be a tenant\'s rent. The owner marks it "Not rent" first; then you can file it.')
}

/**
 * 10/12 review (Nic L19): a transfer between two of the company's accounts
 * files BOTH lines — the one going out and the one arriving, which leaves the
 * rent queue (bankDepositCandidates reads lines in review). So a bookkeeper
 * matching or undoing a transfer must also be allowed to file the line
 * arriving, under the owner's choice for them (assertBookkeeperMayFileLine).
 * `otherLineId`: the arriving line (match-record's recordId), or — when null —
 * the line paired with `lineId` by an existing transfer match.
 */
export async function assertBookkeeperMayFileTransfer(user: { role?: string; userId?: string }, landlordId: string,
  lineId: string, otherLineId: string | null = null): Promise<void> {
  if (user.role !== 'bookkeeper') return
  let other = otherLineId
  if (!other) {
    const t = await queryOne<{ pair: string | null }>(
      `SELECT matched_transfer_line_id AS pair FROM bank_transactions
        WHERE id = $1 AND landlord_id = $2 AND matched_kind = 'transfer'`, [lineId, landlordId])
    other = t?.pair ?? null
  }
  if (other) await assertBookkeeperMayFileLine(user, landlordId, other)
}
