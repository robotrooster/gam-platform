// Landlord-entered expenses (S568, Nic). Unit-linked or common (property-level);
// common expenses can be allocated per unit for per-unit P&L. Feeds the landlord
// reports P&L. Soft-void, never hard-delete (keep-everything).
//
// 10/12 (Nic, GAM Books P6, L5): MONEY OUT IS ONE RECORD. "those all sound like
// real expenses. just let bookkeeper/landlord create custom labels or
// categories to charge things off to." Every dollar out is an expense here:
//   - filed under one of the company's own categories (books_categories,
//     services/booksCategories) — the category's account says what it was;
//   - paid or not: a bill is an unpaid expense (due date, bill number, vendor);
//     its payments (landlord_expense_payments) say when, how much and how —
//     cash from the office, a check, a card, the owner personally, or the bank
//     line that paid it. Paid / partly paid / unpaid is worked out from them;
//   - cash that never touched the bank is logged by hand and never has to
//     match a bank line;
//   - a bank line going out creates or matches an expense (services/
//     bankMoneyOut); one line may pay several bills.
// createMoneyOutExpense is how other GAM features leave money owed here (a
// payroll run's take-home pay and taxes, a repair's bill, work-trade hours paid
// as a contractor, the manager's cut GAM held too little to pay).
import type { PoolClient } from 'pg'
import {
  LANDLORD_EXPENSE_PAYMENT_METHODS, LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED, booksCents,
  type LandlordExpensePaymentMethod, type LandlordExpensePaymentSource, type ExpensePayState,
} from '@gam/shared'
import { db, query, queryOne } from '../db'
import { cutoffsParam, withinCutoffsSql, type PropertyCutoff } from '../lib/bookkeeperScope'
import { liveExpenseSql } from '../lib/liveExpense'
import { AppError } from '../middleware/errorHandler'
import { resolveCategory } from './booksCategories'

type Runner = Pick<PoolClient, 'query'>

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How an expense was paid when it is entered (or later), for one payment. */
export interface ExpensePaymentInput {
  method: LandlordExpensePaymentMethod
  /** The day it was paid (defaults to the expense's date). */
  paidOn?: string | null
  /** Defaults to everything still owed. */
  amount?: number | null
  /** The linked bank it came out of (method 'bank' / 'check'), when known. */
  bankConnectionId?: string | null
  memo?: string | null
}

export interface CreateExpenseInput {
  landlordId: string
  createdBy?: string | null
  propertyId?: string | null
  unitId?: string | null
  /** GAM's starting category key (the old fixed list: 'repairs', 'utilities'…). */
  category?: string | null
  /** 10/12 (Nic, L5): one of the company's own categories (wins over `category`). */
  categoryId?: string | null
  amount: number
  description?: string | null
  /** A payee typed by hand (one not on the vendor list). */
  vendor?: string | null
  /** 10/12: who was paid, from the company's one vendor list. */
  vendorId?: string | null
  billNumber?: string | null
  /** When an unpaid bill is due. */
  dueDate?: string | null
  expenseDate: string          // YYYY-MM-DD
  isCommon?: boolean
  /** S613: which utility, when the category is utilities. Optional — an untyped
   *  utility bill still counts toward what the property spent. */
  utilityType?: string | null
  /** 10/12 (Nic): the bank line this is one PART of, when the owner split that
   *  line on the Bank page (services/bankFeed splitTransaction). Its payment is
   *  that line. Omitted for everything else, including a bank line filed as one
   *  expense (that link stays on bank_transactions.expense_id, and the filing
   *  records the payment with the line). */
  bankTransactionId?: string | null
  /** 10/12 (Nic, L6): the repair this bill is for. */
  maintenanceRequestId?: string | null
  /** 10/12: work-trade extra hours paid as a contractor payment from GAM Books. */
  workTradeExtraHoursId?: string | null
  /** 10/12 (Nic, L18): the payout split whose manager's cut GAM held too little to pay. */
  allocationSplitId?: string | null
  /**
   * How it was paid now. Omitted: paid in full on its date, how not recorded
   * ('other' — what "logged" always meant; a bank-line part: that line). null:
   * a bill — owed, nothing paid yet.
   */
  payment?: ExpensePaymentInput | null
  /**
   * 10/12 review: a bill GAM makes for another feature (createMoneyOutExpense)
   * goes under its starting category even when the company archived it — the
   * repair, the manager's cut or the contractor's hours are still owed, and
   * archiving a category only takes it out of the pickers.
   */
  allowArchivedCategory?: boolean
}

/** Runs `fn` in the caller's transaction, else in one of its own. */
async function withTx<T>(client: Runner | undefined, fn: (c: Runner) => Promise<T>): Promise<T> {
  if (client) return fn(client)
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

/** A vendor named for an expense must be on this company's list. */
async function assertVendor(run: Runner, landlordId: string, vendorId: string | null | undefined): Promise<{ id: string; name: string } | null> {
  if (!vendorId) return null
  if (!UUID.test(vendorId)) throw new AppError(400, 'Choose a vendor from the list.')
  const v = (await run.query<{ id: string; name: string }>(
    `SELECT id, name FROM books_vendors WHERE id = $1 AND landlord_id = $2`, [vendorId, landlordId])).rows[0]
  if (!v) throw new AppError(400, 'That vendor is not one of this company\'s.')
  return v
}

/** A bank named for a payment must be one of this company's linked banks. */
async function assertBank(run: Runner, landlordId: string, bankConnectionId: string | null | undefined): Promise<string | null> {
  if (!bankConnectionId) return null
  if (!UUID.test(bankConnectionId)) throw new AppError(400, 'Choose one of your linked banks.')
  const b = (await run.query(`SELECT 1 FROM bank_connections WHERE id = $1 AND landlord_id = $2`, [bankConnectionId, landlordId])).rows[0]
  if (!b) throw new AppError(400, 'That bank is not one of this company\'s.')
  return bankConnectionId
}

function dollars(n: number): string {
  return (booksCents(n) / 100).toFixed(2)
}

/**
 * 10/12 review — what else an expense stands for, as SQL on the expense
 * aliased `e` (NULL = nothing; an expense like any other):
 *   payroll      a payroll run's take-home or tax bill (payroll_run_expenses):
 *                its amount is the run's; it is voided with the run
 *   manager_cut  the manager's cut a payout split owes (Nic L18): its amount
 *                is the split's, which booked the debt to Accounts payable
 *   fixed_asset  it became a fixed asset (books_fixed_assets.source_expense_id):
 *                the asset copied its cost and day
 *   work_trade   work-trade extra hours paid as a contractor (1099): its
 *                amount is what marks those hours paid
 *   work_trade_by_hand  10/12 (Nic): work-trade extra hours marked paid by
 *                hand on the Work Trade page (check or cash) — the paid
 *                expense that records them (services/workTradeBooksPay
 *                recordWorkTradeHoursPaidByHand): its amount and day are the
 *                hours'; removing it puts the hours back to owed
 * Such an expense keeps its amount, day, category and place; it is changed or
 * removed where it came from (updateLandlordExpense, voidLandlordExpense).
 */
export function systemLinkSql(e = 'e'): string {
  return `(CASE WHEN EXISTS (SELECT 1 FROM payroll_run_expenses prx WHERE prx.expense_id = ${e}.id) THEN 'payroll'
              WHEN ${e}.allocation_split_id IS NOT NULL THEN 'manager_cut'
              WHEN EXISTS (SELECT 1 FROM books_fixed_assets fxa WHERE fxa.source_expense_id = ${e}.id AND fxa.voided_at IS NULL) THEN 'fixed_asset'
              WHEN ${e}.work_trade_extra_hours_id IS NOT NULL AND ${workTradePaidByHandSql(e)} THEN 'work_trade_by_hand'
              WHEN ${e}.work_trade_extra_hours_id IS NOT NULL THEN 'work_trade' END)`
}

/**
 * 10/12 (Nic): SQL over the expense aliased `e` — it is the paid expense that
 * records work-trade extra hours marked paid by hand (check or cash): the
 * hours name it, and still say paid by hand.
 */
export function workTradePaidByHandSql(e = 'e'): string {
  return `EXISTS (SELECT 1 FROM work_trade_extra_hours wtx
                   WHERE wtx.id = ${e}.work_trade_extra_hours_id AND wtx.books_reference_id = ${e}.id
                     AND wtx.status = 'paid' AND wtx.paid_how IN ('check', 'cash'))`
}

type SystemLink = 'payroll' | 'manager_cut' | 'fixed_asset' | 'work_trade' | 'work_trade_by_hand'

/** Why a system-linked expense's amount, day, category or place cannot change here. */
const SYSTEM_LINK_EDIT_REFUSAL: Record<SystemLink, string> = {
  payroll: 'A payroll run left this to pay, so its amount, date and category are the run\'s. Void the run in Payroll and run it again to change them.',
  manager_cut: 'This is the manager\'s cut a payout could not pay (it is owed to the manager), so its amount and date are that payout\'s.',
  fixed_asset: 'This expense became a fixed asset, which copied its cost and day. Void the asset on the Fixed assets page first, then change the expense.',
  work_trade: 'This pays a work trader\'s extra hours as a contractor, so its amount is those hours. To change it, remove this expense; the hours then wait on Run Payroll to be confirmed again.',
  work_trade_by_hand: 'This records a work trader\'s extra hours marked paid on the Work Trade page, so its amount, date and category are those hours\'. To change them, remove this expense; the hours then show as owed again on the Work Trade page.',
}

/**
 * Book one landlord expense, and how it was paid (see CreateExpenseInput.payment).
 *
 * `client` (S655 review): pass the caller's transaction to book the expense
 * inside it. The bank feed files a bank row by booking its expense and marking
 * the row filed — written on two different connections, a failure after the
 * expense left it booked with no bank row pointing at it, and the row back in
 * review to be filed (and booked) again. Without a client it runs in a
 * transaction of its own (the expense and its payment commit together).
 */
export async function createLandlordExpense(input: CreateExpenseInput, client?: Runner) {
  if (!(Number.isFinite(input.amount) && booksCents(input.amount) > 0)) throw new AppError(400, 'An expense is for an amount above zero.')
  if (!ISO_DAY.test(String(input.expenseDate))) throw new AppError(400, 'Enter the expense date as a date.')
  if (input.dueDate && !ISO_DAY.test(String(input.dueDate))) throw new AppError(400, 'Enter the due date as a date.')
  return withTx(client, async (run) => {
    const one = async <T = any>(sql: string, params: any[]): Promise<T | null> => ((await run.query(sql, params)).rows[0] ?? null)
    const cat = await resolveCategory(run, input.landlordId, 'expense', { categoryId: input.categoryId, key: input.category },
      { allowArchived: !!input.allowArchivedCategory })
    // Unit-linked ⇒ not common. Common ⇒ property-level (no unit). Validate + verify
    // the unit/property belong to this landlord.
    const unitId = input.unitId ?? null
    const isCommon = !!input.isCommon && !unitId
    let propertyId = input.propertyId ?? null
    if (unitId) {
      const u = await one<any>('SELECT id, property_id, landlord_id FROM units WHERE id=$1', [unitId])
      if (!u || u.landlord_id !== input.landlordId) throw new AppError(400, 'Unit does not belong to you')
      propertyId = u.property_id
    } else if (propertyId) {
      const p = await one<any>('SELECT id, landlord_id FROM properties WHERE id=$1', [propertyId])
      if (!p || p.landlord_id !== input.landlordId) throw new AppError(400, 'Property does not belong to you')
    }
    const vendor = await assertVendor(run, input.landlordId, input.vendorId)
    // S603 (Nic): allocation is unconditional now — any non-unit-linked cost is
    // split across the property's units at report time. The column is retained
    // (keep-everything) and written TRUE so historical rows read consistently,
    // but nothing consults it any more.
    const allocate = isCommon
    const row = await one<any>(
      `INSERT INTO landlord_expenses
         (landlord_id, created_by, property_id, unit_id, category, category_id, amount, description, vendor, vendor_id,
          bill_number, due_date, expense_date, is_common, allocate_per_unit, utility_type, bank_transaction_id,
          maintenance_request_id, work_trade_extra_hours_id, allocation_split_id, payments_tracked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,TRUE) RETURNING *`,
      [input.landlordId, input.createdBy ?? null, propertyId, unitId, cat.legacyKey, cat.id,
       dollars(input.amount), input.description ?? null, input.vendor ?? vendor?.name ?? null, vendor?.id ?? null,
       input.billNumber ? String(input.billNumber).slice(0, 100) : null, input.dueDate ?? null,
       input.expenseDate, isCommon, allocate,
       cat.legacyKey === 'utilities' ? (input.utilityType ?? null) : null,
       input.bankTransactionId ?? null, input.maintenanceRequestId ?? null, input.workTradeExtraHoursId ?? null,
       input.allocationSplitId ?? null])
    if (input.bankTransactionId) {
      // One part of a split bank line: that line pays it, whole, on the bank's day.
      const bt = await one<{ bank_connection_id: string; posted_date: string; amount: string }>(
        `SELECT bank_connection_id, posted_date::text AS posted_date, amount::text AS amount
           FROM bank_transactions WHERE id = $1 AND landlord_id = $2`, [input.bankTransactionId, input.landlordId])
      if (!bt) throw new AppError(404, 'Transaction not found')
      await insertPayment(run, {
        expenseId: row.id, landlordId: input.landlordId, paidOn: bt.posted_date, amountCents: booksCents(input.amount),
        method: 'bank', bankConnectionId: bt.bank_connection_id, bankTransactionId: input.bankTransactionId,
        source: 'bank_match', memo: null, createdBy: input.createdBy ?? null,
      })
    } else if (input.payment !== null) {
      const p = input.payment ?? { method: 'other' as const }
      await recordPaymentIn(run, {
        landlordId: input.landlordId, expenseId: row.id, method: p.method, paidOn: p.paidOn ?? input.expenseDate,
        amount: p.amount ?? null, bankConnectionId: p.bankConnectionId ?? null, memo: p.memo ?? null,
        createdBy: input.createdBy ?? null, allowOther: true,
      })
    }
    return row
  })
}

/**
 * 10/12 (Nic, L5) — how another GAM feature leaves money owed on the Expenses
 * record: an UNPAID expense (a bill) under one of GAM's starting categories
 * (`categoryKey`: 'payroll_take_home', 'payroll_taxes', 'contractor_payments',
 * 'repairs', 'management'…), in the caller's transaction. Returns { id }.
 * A payment, a bank line or a person pays it later.
 */
export async function createMoneyOutExpense(client: Runner, input: {
  landlordId: string; categoryKey: string; amount: number; expenseDate: string; dueDate?: string | null
  description?: string | null; createdBy?: string | null
  vendorId?: string | null; vendor?: string | null; propertyId?: string | null; unitId?: string | null
  workTradeExtraHoursId?: string | null; maintenanceRequestId?: string | null; allocationSplitId?: string | null
}): Promise<{ id: string }> {
  const row = await createLandlordExpense({
    landlordId: input.landlordId, createdBy: input.createdBy ?? null, category: input.categoryKey,
    amount: input.amount, expenseDate: input.expenseDate, dueDate: input.dueDate ?? null,
    description: input.description ?? null, vendorId: input.vendorId ?? null, vendor: input.vendor ?? null,
    propertyId: input.propertyId ?? null, unitId: input.unitId ?? null,
    isCommon: !input.unitId && !!input.propertyId,
    workTradeExtraHoursId: input.workTradeExtraHoursId ?? null, maintenanceRequestId: input.maintenanceRequestId ?? null,
    allocationSplitId: input.allocationSplitId ?? null,
    payment: null,
    // 10/12 review: archiving Repairs, Management or Contractor payments must
    // never silently stop the bills GAM makes there (L6, L18, 1099 hours).
    allowArchivedCategory: true,
  }, client)
  return { id: row.id }
}

interface PaymentRow {
  expenseId: string; landlordId: string; paidOn: string; amountCents: number; method: LandlordExpensePaymentMethod
  bankConnectionId: string | null; bankTransactionId: string | null; source: LandlordExpensePaymentSource
  memo: string | null; createdBy: string | null
}

/** Inserts one payment row (the sums are checked at commit by the database). */
export async function insertPayment(run: Runner, p: PaymentRow): Promise<string> {
  return (await run.query<{ id: string }>(
    `INSERT INTO landlord_expense_payments
       (expense_id, landlord_id, paid_on, amount, method, bank_connection_id, bank_transaction_id, source, memo, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [p.expenseId, p.landlordId, p.paidOn, (p.amountCents / 100).toFixed(2), p.method, p.bankConnectionId,
     p.bankTransactionId, p.source, p.memo, p.createdBy])).rows[0].id
}

/** What is still owed on a live expense, in cents (locks the expense row). */
async function owedCents(run: Runner, landlordId: string, expenseId: string): Promise<{ owed: number; date: string }> {
  const e = (await run.query<{ amount: string; status: string; day: string; paid: string }>(
    `SELECT e.amount::text AS amount, e.status, e.expense_date::text AS day,
            COALESCE((SELECT sum(p.amount) FROM landlord_expense_payments p WHERE p.expense_id = e.id AND p.voided_at IS NULL), 0)::text AS paid
       FROM landlord_expenses e WHERE e.id = $1 AND e.landlord_id = $2 FOR UPDATE`, [expenseId, landlordId])).rows[0]
  if (!e) throw new AppError(404, 'Expense not found')
  if (e.status !== 'active') throw new AppError(409, 'This expense was voided.')
  return { owed: booksCents(e.amount) - booksCents(e.paid), date: e.day }
}

async function recordPaymentIn(run: Runner, input: {
  landlordId: string; expenseId: string; method: LandlordExpensePaymentMethod; paidOn?: string | null
  amount?: number | null; bankConnectionId?: string | null; memo?: string | null; createdBy: string | null
  allowOther?: boolean
}): Promise<string> {
  const allowed: readonly string[] = input.allowOther ? LANDLORD_EXPENSE_PAYMENT_METHODS : LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED
  if (!allowed.includes(input.method)) throw new AppError(400, 'Choose how it was paid.')
  const { owed, date } = await owedCents(run, input.landlordId, input.expenseId)
  if (owed <= 0) throw new AppError(409, 'This expense is already paid in full.')
  const cents = input.amount == null ? owed : booksCents(input.amount)
  if (!(cents > 0)) throw new AppError(400, 'A payment is an amount above zero.')
  if (cents > owed) throw new AppError(409, `Only ${(owed / 100).toFixed(2)} is still owed on this expense.`)
  const paidOn = input.paidOn ?? date
  if (!ISO_DAY.test(String(paidOn))) throw new AppError(400, 'Enter the day it was paid as a date.')
  const bank = (input.method === 'bank' || input.method === 'check')
    ? await assertBank(run, input.landlordId, input.bankConnectionId) : null
  return insertPayment(run, {
    expenseId: input.expenseId, landlordId: input.landlordId, paidOn, amountCents: cents, method: input.method,
    bankConnectionId: bank, bankTransactionId: null, source: 'payment', memo: input.memo ? String(input.memo).slice(0, 500) : null,
    createdBy: input.createdBy,
  })
}

/**
 * 10/12 (Nic, L5): record a payment toward an expense (a bill paid, or part of
 * it) — cash from the office, a check, a card, the owner personally, or the
 * bank. A check or a bank payment is matched to its bank line when that line
 * arrives (Bank page). Returns the payment's id.
 */
export async function recordExpensePayment(input: {
  landlordId: string; expenseId: string; method: LandlordExpensePaymentMethod; paidOn?: string | null
  amount?: number | null; bankConnectionId?: string | null; memo?: string | null; createdBy: string | null
}, client?: Runner): Promise<string> {
  return withTx(client, run => recordPaymentIn(run, input))
}

/**
 * Takes back a payment recorded by hand (kept on record, voided). A payment a
 * bank line made is that line's filing: it is changed or undone on the Bank
 * page, so the books keep matching the bank.
 */
export async function voidExpensePayment(input: {
  landlordId: string; expenseId: string; paymentId: string; reason?: string | null; by: string | null
}, client?: Runner): Promise<void> {
  if (!UUID.test(input.paymentId)) throw new AppError(404, 'Payment not found')
  await withTx(client, async (run) => {
    const p = (await run.query<{ bank_transaction_id: string | null; voided_at: string | null }>(
      `SELECT bank_transaction_id, voided_at FROM landlord_expense_payments
        WHERE id = $1 AND expense_id = $2 AND landlord_id = $3 FOR UPDATE`,
      [input.paymentId, input.expenseId, input.landlordId])).rows[0]
    if (!p) throw new AppError(404, 'Payment not found')
    if (p.voided_at) throw new AppError(409, 'This payment was already taken back.')
    if (p.bank_transaction_id) {
      throw new AppError(409, 'This payment is a bank line. Undo it on the Bank page, so your books still match your bank.')
    }
    // 10/12 (Nic): the payment of work-trade hours marked paid by hand is what
    // the Work Trade page's "paid" stands on — taken back alone, the hours
    // would say paid with nothing paid behind them.
    const byHand = (await run.query(
      `SELECT 1 FROM landlord_expenses e WHERE e.id = $1 AND e.work_trade_extra_hours_id IS NOT NULL AND ${workTradePaidByHandSql('e')}`,
      [input.expenseId])).rows[0]
    if (byHand) {
      throw new AppError(409, 'This payment is a work trader\'s extra hours marked paid on the Work Trade page. To take it back, remove this expense; the hours then show as owed again there.')
    }
    await run.query(
      `UPDATE landlord_expense_payments SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now() WHERE id = $1`,
      [input.paymentId, input.by, (input.reason && String(input.reason).trim().slice(0, 500)) || 'Taken back'])
  })
}

/** An expense's paid / unpaid state as the Expenses page lists it. */
export interface ExpensePaymentView {
  id: string; paidOn: string; amount: number; method: LandlordExpensePaymentMethod; source: LandlordExpensePaymentSource
  bankTransactionId: string | null; memo: string | null; voided: boolean
}

/**
 * S637: takes ONE entity id or the whole set the account owns.
 *
 * The read side of "an account is not an entity" (S633): a landlord who owns
 * two companies has one book, and this list is a read. It was reached through
 * resolveLandlordTarget, a WRITE resolver, which answers "you own more than one
 * company, choose which" — correct when creating an expense, a 400 that blanks
 * the Expenses tab when merely opening it.
 *
 * 10/12 (Nic, L5): each row carries its category's name, its vendor, its bill
 * number and due date, what was paid and what is still owed (pay_state), and
 * its payments. `state` narrows to unpaid bills ('open': unpaid or partly
 * paid) or to paid ones.
 */
export async function listLandlordExpenses(landlordId: string | string[], opts: {
  from?: string; to?: string; propertyId?: string; unitId?: string
  /** 10/11: a bookkeeper kept to some properties reads only theirs (null = all). */
  propertyIds?: string[] | null
  /** 10/12 (Nic): a former property's expenses only up to the day it left. */
  cutoffs?: readonly PropertyCutoff[] | null
  /** 10/12 (Nic, L5): 'open' = unpaid or partly paid bills; 'paid' = paid in full. */
  state?: 'open' | 'paid' | null
} = {}) {
  const ids = Array.isArray(landlordId) ? landlordId : [landlordId]
  const conds = ['e.landlord_id = ANY($1::uuid[])', `e.status = 'active'`]
  const params: any[] = [ids]
  if (opts.propertyIds) { params.push(opts.propertyIds); conds.push(`e.property_id = ANY($${params.length}::uuid[])`) }
  if (opts.cutoffs?.length) {
    params.push(cutoffsParam(opts.cutoffs))
    conds.push(withinCutoffsSql('e.property_id', 'e.expense_date', `$${params.length}`))
  }
  if (opts.from) { params.push(opts.from); conds.push(`e.expense_date >= $${params.length}`) }
  if (opts.to)   { params.push(opts.to);   conds.push(`e.expense_date <= $${params.length}`) }
  if (opts.propertyId) { params.push(opts.propertyId); conds.push(`e.property_id = $${params.length}`) }
  if (opts.unitId) { params.push(opts.unitId); conds.push(`e.unit_id = $${params.length}`) }
  if (opts.state === 'open') conds.push(`COALESCE(pay.paid, 0) < e.amount`)
  if (opts.state === 'paid') conds.push(`COALESCE(pay.paid, 0) >= e.amount`)
  return query<any>(
    `SELECT e.id, e.category, e.amount::float AS amount, e.description, e.vendor, e.expense_date,
            e.is_common, e.allocate_per_unit, e.unit_id, e.property_id,
            e.receipt_url, e.receipt_name, e.receipt_mime, e.receipt_size,
            e.utility_type, e.created_by, e.landlord_id, to_char(e.expense_date, 'YYYY-MM-DD') AS expense_day,
            -- 10/12 (Nic, L5): the company's own category, its vendor and the bill.
            -- 10/12 review: on the P&L as its category's account stood on the
            -- expense's own day (lib/liveExpense), the ledger's rule.
            e.category_id, bc.name AS category_name, books_category_on_pl_on(e.category_id, e.expense_date) AS on_profit_and_loss,
            e.vendor_id, COALESCE(bv.name, e.vendor) AS vendor_name, e.bill_number,
            to_char(e.due_date, 'YYYY-MM-DD') AS due_date,
            COALESCE(pay.paid, 0)::float AS paid, (e.amount - COALESCE(pay.paid, 0))::float AS unpaid,
            CASE WHEN COALESCE(pay.paid, 0) <= 0 THEN 'unpaid'
                 WHEN COALESCE(pay.paid, 0) < e.amount THEN 'partial' ELSE 'paid' END AS pay_state,
            pay.payments,
            e.maintenance_request_id, e.work_trade_extra_hours_id, e.allocation_split_id,
            -- 10/12 (Nic): the record of work-trade hours marked paid by hand —
            -- its payment is never taken back alone (remove the expense instead).
            (e.work_trade_extra_hours_id IS NOT NULL AND ${workTradePaidByHandSql('e')}) AS work_trade_paid_by_hand,
            e.migrated_from_table,
            -- 10/12 review: a bill GAM keeps for something else, removed there
            -- (voidLandlordExpense): a payroll run's, a payout split's (L18),
            -- one that became a fixed asset.
            COALESCE(${systemLinkSql('e')} IN ('payroll', 'manager_cut', 'fixed_asset'), FALSE) AS system_linked,
            -- 10/11: an expense the bank feed filed keeps the bank's amount and day.
            -- 10/12 (Nic): so does each part of a bank line the owner split.
            (e.bank_transaction_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.expense_id = e.id)) AS from_bank,
            -- 10/12 (Nic, L5): paid by a bank line matched to it (a bill paid
            -- from the bank) — changed or undone on the Bank page.
            EXISTS (SELECT 1 FROM landlord_expense_payments mp
                     WHERE mp.expense_id = e.id AND mp.voided_at IS NULL AND mp.bank_transaction_id IS NOT NULL) AS bank_paid,
            -- 10/12 review: one part of a split bank line (voidLandlordExpense
            -- refuses to remove a part alone — undo or change the split instead).
            (e.bank_transaction_id IS NOT NULL) AS split_part,
            -- 10/12 (Nic): the bank line it came from, so the Expenses page can
            -- send the owner there to change it (it is never removed here).
            COALESCE(e.bank_transaction_id,
                     (SELECT bt.id FROM bank_transactions bt WHERE bt.expense_id = e.id
                       ORDER BY bt.created_at, bt.id LIMIT 1),
                     (SELECT mp.bank_transaction_id FROM landlord_expense_payments mp
                       WHERE mp.expense_id = e.id AND mp.voided_at IS NULL AND mp.bank_transaction_id IS NOT NULL
                       ORDER BY mp.paid_on, mp.id LIMIT 1)) AS bank_line_id,
            u.unit_number, p.name AS property_name
       FROM landlord_expenses e
       LEFT JOIN units u ON u.id = e.unit_id
       LEFT JOIN properties p ON p.id = e.property_id
       LEFT JOIN books_categories bc ON bc.id = e.category_id
       LEFT JOIN books_vendors bv ON bv.id = e.vendor_id
       LEFT JOIN LATERAL (
         SELECT sum(x.amount) FILTER (WHERE x.voided_at IS NULL) AS paid,
                json_agg(json_build_object(
                  'id', x.id, 'paid_on', to_char(x.paid_on, 'YYYY-MM-DD'), 'amount', x.amount::float,
                  'method', x.method, 'source', x.source, 'bank_transaction_id', x.bank_transaction_id,
                  'memo', x.memo, 'voided', x.voided_at IS NOT NULL)
                  ORDER BY x.paid_on, x.created_at, x.id) AS payments
           FROM landlord_expense_payments x WHERE x.expense_id = e.id
       ) pay ON TRUE
      WHERE ${conds.join(' AND ')}
      ORDER BY e.expense_date DESC, e.created_at DESC`, params)
}

/**
 * Attach an uploaded receipt to an existing active expense. Scoped by landlord
 * so a landlord can only stamp a receipt onto their own row. (S575)
 */
export async function attachExpenseReceipt(
  id: string, landlordId: string,
  receipt: { url: string; name: string; mime: string; size: number },
) {
  const row = await queryOne<any>(
    `UPDATE landlord_expenses
        SET receipt_url=$3, receipt_name=$4, receipt_mime=$5, receipt_size=$6, updated_at=NOW()
      WHERE id=$1 AND landlord_id=$2 AND status='active'
      RETURNING id, receipt_url, receipt_name, receipt_mime, receipt_size`,
    [id, landlordId, receipt.url, receipt.name, receipt.mime, receipt.size])
  if (!row) throw new AppError(404, 'Expense not found')
  return row
}

export interface UpdateExpenseInput {
  /** GAM's starting key (the old fixed list). */
  category?: string
  /** 10/12 (Nic, L5): one of the company's own categories (wins over `category`). */
  categoryId?: string
  amount?: number
  description?: string | null
  vendor?: string | null
  vendorId?: string | null
  billNumber?: string | null
  dueDate?: string | null
  expenseDate?: string
  utilityType?: string | null
  /** Re-file it: on a unit, or on the property (common). Omitted = where it is. */
  unitId?: string | null
  propertyId?: string | null
}

/**
 * 10/11 (Nic): edit an expense — an owner any of their company's, a
 * bookkeeper the ones they entered (the route decides who may). Scoped by
 * company like every other write here. The same placement rules as create: on
 * a unit (its property follows) or on a property (common, split per unit).
 * An expense the bank feed filed keeps the bank's amount and day — changing
 * them would leave the bank row saying one thing and the P&L another.
 *
 * 10/12 (Nic, L5): an expense paid in full by ONE payment entered by hand
 * (not a bank line) keeps being paid in full when its amount or day is
 * corrected — the payment follows. Otherwise the amount may not drop below
 * what has been paid on it.
 */
export async function updateLandlordExpense(id: string, landlordId: string, patch: UpdateExpenseInput) {
  return withTx(undefined, async (run) => {
    const one = async <T = any>(sql: string, params: any[]): Promise<T | null> => ((await run.query(sql, params)).rows[0] ?? null)
    const cur = await one<any>(
      `SELECT e.*, to_char(e.expense_date, 'YYYY-MM-DD') AS expense_day,
              (e.bank_transaction_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.expense_id = e.id)
                OR EXISTS (SELECT 1 FROM landlord_expense_payments mp WHERE mp.expense_id = e.id
                             AND mp.voided_at IS NULL AND mp.bank_transaction_id IS NOT NULL
                             AND mp.amount = e.amount)) AS from_bank,
              ${systemLinkSql('e')} AS system_link
         FROM landlord_expenses e WHERE e.id = $1 AND e.landlord_id = $2 AND e.status = 'active' FOR UPDATE`, [id, landlordId])
    if (!cur) throw new AppError(404, 'Expense not found')
    const cat = (patch.categoryId !== undefined || patch.category !== undefined)
      ? await resolveCategory(run, landlordId, 'expense', { categoryId: patch.categoryId, key: patch.category })
      : await resolveCategory(run, landlordId, 'expense', { categoryId: cur.category_id, key: cur.category }, { allowArchived: true })
    const amount = patch.amount ?? Number(cur.amount)
    if (!(booksCents(amount) > 0)) throw new AppError(400, 'An expense is for an amount above zero.')
    const expenseDate = patch.expenseDate ?? cur.expense_day
    if (!ISO_DAY.test(String(expenseDate))) throw new AppError(400, 'Enter the expense date as a date.')
    if (patch.dueDate && !ISO_DAY.test(String(patch.dueDate))) throw new AppError(400, 'Enter the due date as a date.')
    if (cur.from_bank) {
      const sameAmount = booksCents(amount) === booksCents(cur.amount)
      if (!sameAmount || expenseDate !== cur.expense_day) {
        throw new AppError(409, 'This expense came from your bank feed, so its amount and date come from the bank.')
      }
    }
    let unitId: string | null = cur.unit_id
    let propertyId: string | null = cur.property_id
    if (patch.unitId !== undefined || patch.propertyId !== undefined) {
      unitId = patch.unitId ?? null
      propertyId = patch.propertyId ?? null
      if (unitId) {
        const u = await one<any>('SELECT property_id, landlord_id FROM units WHERE id=$1', [unitId])
        if (!u || u.landlord_id !== landlordId) throw new AppError(400, 'Unit does not belong to you')
        propertyId = u.property_id
      } else if (propertyId) {
        const p = await one<any>('SELECT landlord_id FROM properties WHERE id=$1', [propertyId])
        if (!p || p.landlord_id !== landlordId) throw new AppError(400, 'Property does not belong to you')
      }
    }
    // 10/12 review: an expense another feature keeps (systemLinkSql) keeps
    // its amount, day, category and place — a payroll bill's amount clears the
    // run's liability, the manager's cut is the split's, an asset copied the
    // cost, a contractor bill pays the hours. Its words (description, vendor,
    // bill number, due date) are still the owner's to fix.
    if (cur.system_link) {
      const moved = booksCents(amount) !== booksCents(cur.amount) || expenseDate !== cur.expense_day
        || cat.id !== cur.category_id || (unitId ?? null) !== (cur.unit_id ?? null) || (propertyId ?? null) !== (cur.property_id ?? null)
      if (moved) throw new AppError(409, SYSTEM_LINK_EDIT_REFUSAL[cur.system_link as SystemLink])
    }
    const vendor = patch.vendorId !== undefined ? await assertVendor(run, landlordId, patch.vendorId) : undefined
    const isCommon = !unitId && !!propertyId
    const utilityType = cat.legacyKey === 'utilities'
      ? (patch.utilityType !== undefined ? patch.utilityType : cur.utility_type)
      : null
    // Paid in full by one hand-entered payment: it follows the correction.
    const pays = (await run.query<{ id: string; amount: string; paid_on: string; bank_transaction_id: string | null }>(
      `SELECT id, amount::text AS amount, paid_on::text AS paid_on, bank_transaction_id FROM landlord_expense_payments
        WHERE expense_id = $1 AND voided_at IS NULL`, [id])).rows
    const only = pays.length === 1 && !pays[0].bank_transaction_id && booksCents(pays[0].amount) === booksCents(cur.amount) ? pays[0] : null
    if (only && (booksCents(amount) !== booksCents(cur.amount) || (expenseDate !== cur.expense_day && only.paid_on === cur.expense_day))) {
      await run.query(
        `UPDATE landlord_expense_payments SET amount = $2, paid_on = $3, updated_at = now() WHERE id = $1`,
        [only.id, dollars(amount), only.paid_on === cur.expense_day ? expenseDate : only.paid_on])
    }
    return one<any>(
      `UPDATE landlord_expenses
          SET category=$3, category_id=$4, amount=$5, description=$6, vendor=$7, vendor_id=$8, bill_number=$9,
              due_date=$10, expense_date=$11, unit_id=$12, property_id=$13, is_common=$14, allocate_per_unit=$14,
              utility_type=$15, updated_at=NOW()
        WHERE id=$1 AND landlord_id=$2 AND status='active'
        RETURNING *`,
      [id, landlordId, cat.legacyKey, cat.id, dollars(amount),
       patch.description !== undefined ? patch.description : cur.description,
       patch.vendor !== undefined ? patch.vendor : (vendor ? vendor.name : cur.vendor),
       vendor !== undefined ? (vendor?.id ?? null) : cur.vendor_id,
       patch.billNumber !== undefined ? (patch.billNumber ? String(patch.billNumber).slice(0, 100) : null) : cur.bill_number,
       patch.dueDate !== undefined ? (patch.dueDate || null) : cur.due_date,
       expenseDate, unitId, propertyId, isCommon, utilityType])
  })
}

/**
 * 10/12 (Nic): "voiding a bank-filed expense on the Expenses page is REFUSED
 * there and sends you to the Bank page to change it." An expense the bank feed
 * filed — one category, or one part of a split line — is the bank line's
 * filing. Voided here, the line would still read "filed" with nothing in the
 * books behind it, and could never be filed again. The Bank page changes it
 * (split it, change the split) or undoes it (the line goes back to review).
 * 10/12 (Nic, L5): so is a bill a bank line paid (matched on the Bank page).
 * An expense logged by hand — cash that never went through the bank — or a
 * bill still unpaid is removed here as always; its hand-entered payments are
 * voided with it (kept on record).
 *
 * `opts.client`: the caller's transaction (payroll voids the run's unpaid
 * bills in its own).
 *
 * 10/12 review: an expense another feature keeps is removed where it came
 * from, never here: a payroll run's take-home or tax bill goes with the run
 * (voidPayrollMoneyOut passes `opts.payrollRun`, the one way in), the
 * manager's cut a payout split owes stays (the split booked that debt to
 * Accounts payable; a bill removed here would leave it owed with nothing on
 * Expenses), and one that became a fixed asset waits for the asset's void.
 */
export async function voidLandlordExpense(id: string, landlordId: string, opts: { client?: Runner; payrollRun?: boolean } = {}) {
  await withTx(opts.client, async (run) => {
    const fromBank = (await run.query<{ split_part: boolean; filed: boolean; matched: boolean; system_link: SystemLink | null }>(
      `SELECT (e.bank_transaction_id IS NOT NULL) AS split_part,
              EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.expense_id = e.id) AS filed,
              EXISTS (SELECT 1 FROM landlord_expense_payments mp WHERE mp.expense_id = e.id
                        AND mp.voided_at IS NULL AND mp.bank_transaction_id IS NOT NULL) AS matched,
              ${systemLinkSql('e')} AS system_link
         FROM landlord_expenses e
        WHERE e.id=$1 AND e.landlord_id=$2 AND e.status='active'`, [id, landlordId])).rows[0]
    if (fromBank?.system_link === 'payroll' && !opts.payrollRun) {
      throw new AppError(409, 'A payroll run left this to pay. Void the run in Payroll; what it left to pay is removed with it.')
    }
    if (fromBank?.system_link === 'manager_cut') {
      throw new AppError(409, 'This is the manager\'s cut a payout could not pay. It is owed to the manager, so it stays until it is paid.')
    }
    if (fromBank?.system_link === 'fixed_asset') {
      throw new AppError(409, 'This expense became a fixed asset. Void the asset on the Fixed assets page first.')
    }
    if (fromBank && (fromBank.split_part || fromBank.filed || fromBank.matched)) {
      throw new AppError(409, fromBank.split_part
        ? 'This expense is one part of a bank line you split. Change or undo the split on the Bank page, so the parts still add up to what your bank shows.'
        : fromBank.filed
          ? 'This expense came from your bank feed. Change how that bank line is filed, or undo it, on the Bank page, so your books still match your bank.'
          : 'A bank line paid this expense. Undo that match on the Bank page first, so your books still match your bank.')
    }
    const row = (await run.query<{ id: string }>(
      `UPDATE landlord_expenses SET status='voided', voided_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND landlord_id=$2 AND status='active' RETURNING id`, [id, landlordId])).rows[0]
    if (!row) throw new AppError(404, 'Expense not found or already voided')
    // 10/12 (Nic): the expense recorded work-trade extra hours marked paid by
    // hand — removed, the hours are owed again (waiting for GAM Books when they
    // had been sent there first), so the Work Trade page says what the books
    // say. Their paid stamps go; the audit journal keeps what they said.
    // 10/12 (Nic, review): and their link to the removed expense — owed again,
    // they name no expense, so a payroll run (W-2) or a contractor bill
    // (1099) can take them (payroll refuses hours that still name one); the
    // removed expense still names the hours (work_trade_extra_hours_id).
    if (fromBank?.system_link === 'work_trade_by_hand') {
      try {
        await run.query(
          `UPDATE work_trade_extra_hours x
              SET status = CASE WHEN x.sent_to_books_at IS NOT NULL THEN 'sent_to_books' ELSE 'unpaid' END,
                  paid_on = NULL, paid_how = NULL, paid_note = NULL, paid_by = NULL, paid_at = NULL,
                  books_reference_id = NULL, updated_at = NOW()
            WHERE x.books_reference_id = $1 AND x.status = 'paid' AND x.paid_how IN ('check', 'cash')
              AND x.id = (SELECT work_trade_extra_hours_id FROM landlord_expenses WHERE id = $1)`, [id])
      } catch (e: any) {
        // Another record of the same month's extra hours is already waiting
        // (work_trade_extra_hours_one_unpaid): two owed records of one month
        // cannot stand side by side.
        if (e?.code === '23505') {
          throw new AppError(409, 'More extra hours for the same month are already waiting on the Work Trade page. Pay or send those first, then remove this expense.')
        }
        throw e
      }
    }
  })
}

/**
 * Total live landlord-entered expenses for a landlord in a date range (P&L).
 * 10/12 (Nic, L5): only what counts as a cost (lib/liveExpense) — never an
 * owner draw, what payroll left to pay, or the manager's-cut bill of a split.
 */
export async function landlordExpensesTotal(landlordId: string, from: string, to: string): Promise<number> {
  const r = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total FROM landlord_expenses
      WHERE landlord_id=$1 AND ${liveExpenseSql('')} AND expense_date >= $2 AND expense_date <= $3`,
    [landlordId, from, to])
  return Math.round(parseFloat(r?.total ?? '0') * 100) / 100
}

/**
 * Expense attributable to a single UNIT in a range, for per-unit P&L:
 * unit-linked expenses in full + EVERY non-unit-linked expense on the unit's
 * property divided by that property's unit count.
 *
 * S603 (Nic): allocation is unconditional. Any cost not tied to one unit gets
 * spread across all of them — "there's no reason to just have it sit higher at a
 * property level and not get factored into a per-unit cost." Pre-S603 this
 * required the landlord to tick `allocate_per_unit`, so an un-ticked insurance
 * bill dropped out of per-unit cost entirely and made units look cheaper to run
 * than they are. Divided by ALL units, not just occupied ones — a vacant unit
 * still carries its share, and dividing by occupied would spike costs as
 * occupancy falls.
 *
 * Must stay in lockstep with services/reportEngine.ts, which applies the same
 * rule; if these two drift, a landlord's per-unit cost differs by screen.
 * 10/12 (Nic, L5): costs only (lib/liveExpense), as there.
 */
export async function unitAllocatedExpenses(unitId: string, from: string, to: string): Promise<number> {
  const direct = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total FROM landlord_expenses
      WHERE unit_id=$1 AND ${liveExpenseSql('')} AND expense_date >= $2 AND expense_date <= $3`,
    [unitId, from, to])
  const allocated = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(e.amount / NULLIF(uc.n, 0)), 0)::text AS total
       FROM landlord_expenses e
       JOIN units target ON target.id = $1
       JOIN LATERAL (SELECT COUNT(*)::int AS n FROM units u2 WHERE u2.property_id = target.property_id) uc ON TRUE
      WHERE e.property_id = target.property_id AND e.unit_id IS NULL
        AND ${liveExpenseSql('e')}
        AND e.expense_date >= $2 AND e.expense_date <= $3`,
    [unitId, from, to])
  return Math.round((parseFloat(direct?.total ?? '0') + parseFloat(allocated?.total ?? '0')) * 100) / 100
}

export type { ExpensePayState }
