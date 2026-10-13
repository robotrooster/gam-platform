/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P6: MONEY OUT IS ONE RECORD, AND IT POSTS ITSELF
 * (gam-ledger-design-2026-10-12 §6 I, §12; Nic's 10/12 answers L5, L6, L18)
 *
 *   Nic, 10/12 (L5): "those all sound like real expenses. just let
 *   bookkeeper/landlord create custom labels or categories to charge things
 *   off to." Money out is ONE record — the Expense — and the company's own
 *   category says what it was (it points at an account in the chart).
 *
 *   expense          I1  incurred on its date:
 *                          Dr the category's account (a seeded category's
 *                             starting role until the company points it —
 *                             booksLedgerChart resolveAccount)
 *                          Cr Accounts payable (2010)
 *                        on its property (its unit's), else company level —
 *                        an expense on no property is split across the
 *                        properties by units or kept in a Company column as
 *                        the owner chose (Nic L7, companyCosts); only an
 *                        expense-type account is split. A bill payroll left
 *                        (payroll_run_expenses, phase P7) moves that payroll
 *                        liability to Accounts payable instead (Dr the
 *                        liability). The manager's cut GAM held too little to
 *                        pay (Nic L18, allocation_split_id) posts nothing
 *                        here: the split itself posted Dr 5080 / Cr 2010
 *                        (payoutAllocation), the bill is its record.
 *   expense_payment  I2  paid on its day: Dr Accounts payable / Cr where the
 *                        money came from —
 *                          bank, the bank line that paid it   the bank's own
 *                                                             sub-account
 *                          bank, no line yet (a linked bank)  that bank
 *                          bank, no bank named                Checking
 *                          check                              Outstanding checks (2015),
 *                                                             cleared by the bank line
 *                          card                               Credit card payable (2110)
 *                          cash                               Undeposited funds (the drawer, 1040)
 *                          owner_paid                         Owner equity and contributions (3010)
 *                          other (how was not recorded)       Suspense: to classify (1099)
 *                        The Accounts payable line carries cash_effect 'out',
 *                        the expense's report category and expense_kind = the
 *                        TYPE of its category's account that day
 *                        (MONEY_OUT_LINE_KINDS: a cash-basis report counts
 *                        'expense' only — never an owner draw or a payroll
 *                        liability paid down).
 *                        A check (or a bank payment made before its bank line
 *                        posted) that a bank line cleared posts a second
 *                        posting 'bank_clear' on the bank's day:
 *                        Dr Outstanding checks / Cr the bank.
 *   other_income     I4  money in filed as other income, on its day:
 *                          Dr the bank line's own sub-account (a deposit
 *                             slip's other money: Undeposited funds, cleared
 *                             by the slip, B8; nothing to say where: Suspense)
 *                          Cr the category's account — Received (cash_effect
 *                             'in'): 'other_income' when on the P&L, else
 *                             'not_income' (an owner contribution)
 *   bank_match       §12 a money-out bank line matched to a record GAM already
 *                        has — this phase's PART of the bank_match projector
 *                        (merged with the tenant part, services/
 *                        ledgerProjectors.ts). The record already credited
 *                        Outstanding checks (a GAM fee debit H5, a register
 *                        refund by check F3, a refund check D4); the line
 *                        clears it on the bank's day: Dr 2015 / Cr the bank,
 *                        property by property as the record posted. A transfer
 *                        between two of the company's linked accounts: Dr the
 *                        receiving bank / Cr the sending bank (the line going
 *                        out posts it; the line arriving posts nothing).
 *                        Expenses matched to a line post through their
 *                        payments (above), never here.
 *
 * Facts only (ledgerProjectorPurity): stored amounts, days and links; the
 * category's account on a day comes from the company's dated map
 * (books_category_account_type_on); the cost-split choice is fixed once the
 * books have posted (companyCosts).
 */
import type { PoolClient } from 'pg'
import {
  booksCategoryOnProfitAndLoss, booksCategoryReportCategory, BOOKS_CATEGORY_FALLBACK_ROLE,
  type LedgerAccountRole, type LedgerReportCategory, type LandlordExpensePaymentMethod, type MoneyOutLineKind,
} from '@gam/shared'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { cr, dr, toCents } from './registerBookingPayoutKit'
import { isUuid } from './tenantShared'
import { companyCostSpread, drSpread } from './companyCosts'
import { payoutGamDebitProjector } from './payoutGamCharges'
import { registerRefundProjector } from './registerRefund'
import { refundPartProjector } from './tenantDeposits'

export const MONEY_OUT_RULE_VERSION = 1

interface ExpenseFacts {
  landlord_id: string
  status: string
  amount: string
  day: string
  property_id: string | null
  unit_id: string | null
  vendor_id: string | null
  description: string | null
  category_id: string | null
  system_key: string | null
  default_role: string | null
  account_type: string | null
  allocation_split_id: string | null
  liability_role: string | null
}

const EXPENSE_FACTS_SQL = `
  SELECT e.landlord_id, e.status, e.amount::text AS amount, e.expense_date::text AS day,
         COALESCE(u.property_id, e.property_id) AS property_id, e.unit_id, e.vendor_id, e.description,
         e.category_id, c.system_key, c.default_role,
         CASE WHEN e.category_id IS NULL THEN NULL ELSE books_category_account_type_on(e.category_id, e.expense_date) END AS account_type,
         e.allocation_split_id,
         (SELECT x.liability_role FROM payroll_run_expenses x WHERE x.expense_id = e.id LIMIT 1) AS liability_role
    FROM landlord_expenses e
    LEFT JOIN units u ON u.id = e.unit_id
    LEFT JOIN books_categories c ON c.id = e.category_id`

/** What a category's lines say: where it posts, the report's category, and what kind of money it is. */
function categoryTags(f: Pick<ExpenseFacts, 'category_id' | 'system_key' | 'default_role' | 'account_type'>): {
  sel: Pick<DesiredLine, 'role' | 'sub'>; reportCategory: LedgerReportCategory; kind: MoneyOutLineKind | null
} {
  const role = (f.default_role ?? BOOKS_CATEGORY_FALLBACK_ROLE.expense) as LedgerAccountRole
  const onPl = booksCategoryOnProfitAndLoss('expense', f.account_type ?? 'expense')
  return {
    sel: f.category_id ? { role, sub: { kind: 'expense_category', value: f.category_id } } : { role },
    reportCategory: booksCategoryReportCategory('expense', f.system_key, onPl),
    kind: (f.account_type as MoneyOutLineKind | null) ?? 'expense',
  }
}

// ─── I1: the expense, incurred ──────────────────────────────────────────────

export async function projectExpense(client: PoolClient, expenseId: string): Promise<DesiredPosting[]> {
  if (!isUuid(expenseId)) return []
  const f = (await client.query<ExpenseFacts>(`${EXPENSE_FACTS_SQL} WHERE e.id = $1`, [expenseId])).rows[0]
  if (!f || f.status !== 'active') return []
  // Nic L18: the manager's cut GAM held too little to pay — the split posted its cost.
  if (f.allocation_split_id) return []
  const cents = toCents(f.amount)
  if (cents <= 0) return []
  const memo = f.description ? f.description.slice(0, 200) : null
  const dims = { unitId: f.unit_id, vendorId: f.vendor_id }
  const lines: DesiredLine[] = []
  if (f.liability_role) {
    // What a payroll run left to pay: that liability is now a bill (Accounts payable).
    lines.push(...dr(f.liability_role as LedgerAccountRole, cents, { propertyId: null, vendorId: f.vendor_id, memo }))
    lines.push(...cr('accounts_payable', cents, { propertyId: null, vendorId: f.vendor_id, memo }))
  } else {
    const t = categoryTags(f)
    const extra = { ...dims, reportCategory: t.reportCategory, expenseKind: t.kind, memo }
    if (f.property_id || t.kind !== 'expense') {
      lines.push({ ...t.sel, ...extra, propertyId: f.property_id, debitCents: cents })
    } else {
      // A cost on no property: split by units, or a Company column (Nic L7).
      const spread = await companyCostSpread(client, f.landlord_id, f.day)
      for (const l of drSpread(t.sel.role!, cents, spread, extra)) lines.push({ ...l, sub: t.sel.sub })
    }
    lines.push(...cr('accounts_payable', cents, { propertyId: f.property_id, vendorId: f.vendor_id, memo }))
  }
  return [{ owner: { landlordId: f.landlord_id }, intendedDate: f.day, memo: memo ?? 'Expense', lines }]
}

export const expenseProjector: LedgerProjector = {
  sourceType: 'expense',
  ruleVersion: MONEY_OUT_RULE_VERSION,
  project: (client, sourceId) => projectExpense(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT id::text AS id, expense_date::text AS day FROM landlord_expenses
        WHERE landlord_id = $1 AND ($2::date IS NULL OR expense_date >= $2::date)`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

// ─── I2: a payment toward an expense ────────────────────────────────────────

/** Where the money for a payment came from (the credit line). */
function paidFrom(method: LandlordExpensePaymentMethod, connection: string | null): Pick<DesiredLine, 'role' | 'sub'> {
  switch (method) {
    case 'bank':       return connection ? { role: 'bank_checking', sub: { kind: 'bank_connection', value: connection } } : { role: 'bank_checking' }
    case 'check':      return { role: 'outstanding_checks' }
    case 'card':       return { role: 'credit_card_payable' }
    case 'cash':       return { role: 'undeposited_funds' }
    case 'owner_paid': return { role: 'owner_equity' }
    default:           return { role: 'suspense' }
  }
}

export async function projectExpensePayment(client: PoolClient, paymentId: string): Promise<DesiredPosting[]> {
  if (!isUuid(paymentId)) return []
  const p = (await client.query<{
    landlord_id: string; expense_id: string; paid_on: string; amount: string; method: LandlordExpensePaymentMethod
    bank_connection_id: string | null; bank_transaction_id: string | null; voided: boolean
    line_connection: string | null; line_day: string | null
  }>(
    `SELECT p.landlord_id, p.expense_id, p.paid_on::text AS paid_on, p.amount::text AS amount, p.method,
            p.bank_connection_id, p.bank_transaction_id, p.voided_at IS NOT NULL AS voided,
            bt.bank_connection_id AS line_connection, bt.posted_date::text AS line_day
       FROM landlord_expense_payments p
       LEFT JOIN bank_transactions bt ON bt.id = p.bank_transaction_id
      WHERE p.id = $1`, [paymentId])).rows[0]
  if (!p || p.voided) return []
  const f = (await client.query<ExpenseFacts>(`${EXPENSE_FACTS_SQL} WHERE e.id = $1`, [p.expense_id])).rows[0]
  if (!f) return []
  const cents = toCents(p.amount)
  if (cents <= 0) return []
  // Its category's kind on the day it was paid.
  const kindOnDay = f.category_id
    ? (await client.query<{ t: string | null }>(`SELECT books_category_account_type_on($1, $2::date) AS t`, [f.category_id, p.paid_on])).rows[0]?.t ?? null
    : null
  const t = categoryTags({ ...f, account_type: kindOnDay ?? f.account_type })
  const kind = f.liability_role ? 'liability' : t.kind
  const prop = f.property_id
  const memo = f.description ? f.description.slice(0, 200) : null
  const lineConn = p.line_connection ?? p.bank_connection_id
  const out: DesiredPosting[] = []
  // A check, or a bank payment dated before its bank line: Outstanding checks
  // first, cleared by the line on the bank's day.
  const clearsLater = !!p.bank_transaction_id && !!p.line_day
    && (p.method === 'check' || (p.method === 'bank' && p.line_day !== p.paid_on))
  const from = clearsLater ? { role: 'outstanding_checks' as const } : paidFrom(p.method, lineConn)
  out.push({
    owner: { landlordId: p.landlord_id }, intendedDate: p.paid_on, memo: memo ?? 'Expense paid',
    lines: [
      ...dr('accounts_payable', cents, { propertyId: prop, vendorId: f.vendor_id, cashEffect: 'out',
        reportCategory: t.reportCategory, expenseKind: kind, memo }),
      { ...from, creditCents: cents, propertyId: prop, vendorId: f.vendor_id, memo },
    ],
  })
  if (clearsLater && lineConn) {
    out.push({
      owner: { landlordId: p.landlord_id }, postingKind: 'bank_clear', intendedDate: p.line_day!,
      memo: 'The bank paid it',
      lines: [
        ...dr('outstanding_checks', cents, { propertyId: prop, memo: 'Cleared by the bank' }),
        ...cr('bank_checking', cents, { propertyId: prop, sub: { kind: 'bank_connection', value: lineConn }, memo }),
      ],
    })
  }
  return out
}

export const expensePaymentProjector: LedgerProjector = {
  sourceType: 'expense_payment',
  ruleVersion: MONEY_OUT_RULE_VERSION,
  project: (client, sourceId) => projectExpensePayment(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT p.id::text AS id, p.paid_on::text AS day FROM landlord_expense_payments p
         LEFT JOIN bank_transactions bt ON bt.id = p.bank_transaction_id
        WHERE p.landlord_id = $1 AND ($2::date IS NULL OR GREATEST(p.paid_on, COALESCE(bt.posted_date, p.paid_on)) >= $2::date)`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

// ─── I4: money in filed as other income ─────────────────────────────────────

export async function projectOtherIncome(client: PoolClient, incomeId: string): Promise<DesiredPosting[]> {
  if (!isUuid(incomeId)) return []
  const o = (await client.query<{
    landlord_id: string; status: string; voided: boolean; amount: string; day: string; property_id: string | null
    unit_id: string | null; description: string | null; category_id: string | null; default_role: string | null
    account_type: string | null; connection: string | null; from_slip: boolean
  }>(
    `SELECT o.landlord_id, o.status, o.voided_at IS NOT NULL AS voided, o.amount::text AS amount, o.income_date::text AS day,
            COALESCE(u.property_id, o.property_id) AS property_id, o.unit_id, o.description,
            o.category_id, c.default_role,
            CASE WHEN o.category_id IS NULL THEN NULL ELSE books_category_account_type_on(o.category_id, o.income_date) END AS account_type,
            bt.bank_connection_id AS connection,
            COALESCE(bt.auto_settle_undo->>'kind' = 'deposit_slip', FALSE) AS from_slip
       FROM landlord_other_income o
       LEFT JOIN units u ON u.id = o.unit_id
       LEFT JOIN books_categories c ON c.id = o.category_id
       LEFT JOIN LATERAL (
         SELECT b.bank_connection_id, b.auto_settle_undo FROM bank_transactions b
          WHERE b.id = o.bank_transaction_id OR b.landlord_other_income_id = o.id
          ORDER BY (b.id = o.bank_transaction_id) DESC, b.created_at, b.id LIMIT 1
       ) bt ON TRUE
      WHERE o.id = $1`, [incomeId])).rows[0]
  if (!o || o.status !== 'active' || o.voided) return []
  const cents = toCents(o.amount)
  if (cents <= 0) return []
  const role = (o.default_role ?? BOOKS_CATEGORY_FALLBACK_ROLE.income) as LedgerAccountRole
  const onPl = booksCategoryOnProfitAndLoss('income', o.account_type ?? 'income')
  const memo = o.description ? o.description.slice(0, 200) : null
  const into: Pick<DesiredLine, 'role' | 'sub'> = o.from_slip
    ? { role: 'undeposited_funds' }
    : o.connection ? { role: 'bank_checking', sub: { kind: 'bank_connection', value: o.connection } } : { role: 'suspense' }
  return [{
    owner: { landlordId: o.landlord_id }, intendedDate: o.day, memo: memo ?? 'Other income',
    lines: [
      { ...into, debitCents: cents, propertyId: o.property_id, unitId: o.unit_id, memo },
      {
        ...(o.category_id ? { role, sub: { kind: 'income_category' as const, value: o.category_id } } : { role }),
        creditCents: cents, propertyId: o.property_id, unitId: o.unit_id, cashEffect: 'in',
        reportCategory: booksCategoryReportCategory('income', null, onPl), memo,
      },
    ],
  }]
}

export const otherIncomeProjector: LedgerProjector = {
  sourceType: 'other_income',
  ruleVersion: MONEY_OUT_RULE_VERSION,
  project: (client, sourceId) => projectOtherIncome(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT id::text AS id, income_date::text AS day FROM landlord_other_income
        WHERE landlord_id = $1 AND ($2::date IS NULL OR income_date >= $2::date)`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

// ─── §12: a money-out bank line matched to a record GAM already has ─────────

/** The record's Outstanding-checks credits, by property — what the bank line clears. */
async function outstandingByProperty(client: PoolClient, landlordId: string, postings: DesiredPosting[]): Promise<Map<string, number>> {
  const by = new Map<string, number>()
  for (const p of postings) {
    if (p.owner.landlordId !== landlordId) continue
    for (const l of p.lines) {
      if (l.role !== 'outstanding_checks') continue
      const k = l.propertyId ?? ''
      by.set(k, (by.get(k) ?? 0) + (l.creditCents ?? 0) - (l.debitCents ?? 0))
    }
  }
  return by
}

export async function projectBankMatchMoneyOut(client: PoolClient, lineId: string): Promise<DesiredPosting[]> {
  if (!isUuid(lineId)) return []
  const t = (await client.query<{
    landlord_id: string; bank_connection_id: string; posted_date: string; amount: string; status: string
    matched_kind: string | null; matched_gam_debit_id: string | null; matched_pos_refund_id: string | null
    matched_refund_part_id: string | null; other_connection: string | null
  }>(
    `SELECT bt.landlord_id, bt.bank_connection_id, bt.posted_date::text AS posted_date, bt.amount::text AS amount, bt.status,
            bt.matched_kind, bt.matched_gam_debit_id, bt.matched_pos_refund_id, bt.matched_refund_part_id,
            o.bank_connection_id AS other_connection
       FROM bank_transactions bt LEFT JOIN bank_transactions o ON o.id = bt.matched_transfer_line_id
      WHERE bt.id = $1`, [lineId])).rows[0]
  if (!t || t.status !== 'matched' || !t.matched_kind || t.matched_kind === 'expenses') return []
  const cents = -toCents(t.amount)
  if (cents <= 0) return []
  const bank = { sub: { kind: 'bank_connection' as const, value: t.bank_connection_id } }
  if (t.matched_kind === 'transfer') {
    if (!t.other_connection) return []
    return [{
      owner: { landlordId: t.landlord_id }, intendedDate: t.posted_date, memo: 'Transfer between your accounts',
      lines: [
        ...dr('bank_checking', cents, { propertyId: null, sub: { kind: 'bank_connection', value: t.other_connection } }),
        ...cr('bank_checking', cents, { propertyId: null, ...bank }),
      ],
    }]
  }
  const record = t.matched_kind === 'gam_debit' && t.matched_gam_debit_id
    ? await payoutGamDebitProjector.project(client, t.matched_gam_debit_id)
    : t.matched_kind === 'pos_refund' && t.matched_pos_refund_id
      ? await registerRefundProjector.project(client, t.matched_pos_refund_id)
      : t.matched_kind === 'refund_part' && t.matched_refund_part_id
        ? await refundPartProjector.project(client, t.matched_refund_part_id)
        : []
  const by = await outstandingByProperty(client, t.landlord_id, record)
  const lines: DesiredLine[] = []
  for (const [k, v] of [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (v <= 0) continue
    const propertyId = k === '' ? null : k
    lines.push(...dr('outstanding_checks', v, { propertyId, memo: 'Cleared by the bank' }))
    lines.push(...cr('bank_checking', v, { propertyId, ...bank }))
  }
  if (!lines.length) return []
  return [{ owner: { landlordId: t.landlord_id }, intendedDate: t.posted_date, memo: 'The bank paid it', lines }]
}

/** Phase P6's part of 'bank_match' (merged with the tenant part in services/ledgerProjectors.ts). */
export const bankMatchMoneyOutProjector: LedgerProjector = {
  sourceType: 'bank_match',
  ruleVersion: MONEY_OUT_RULE_VERSION,
  project: (client, sourceId) => projectBankMatchMoneyOut(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT bt.id::text AS id, bt.posted_date::text AS day FROM bank_transactions bt
        WHERE bt.landlord_id = $1 AND bt.status = 'matched' AND bt.matched_kind IS NOT NULL AND bt.matched_kind <> 'expenses'
          AND ($2::date IS NULL OR bt.posted_date >= $2::date)`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

/** Everything phase P6 posts (services/ledgerProjectors.ts registers them). */
export const P6_LEDGER_PROJECTORS: readonly LedgerProjector[] = [
  expenseProjector,
  expensePaymentProjector,
  otherIncomeProjector,
  bankMatchMoneyOutProjector,
]
