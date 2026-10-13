/**
 * 10/12 (Nic) — GAM BOOKS: VENDORS, LOANS AND FIXED ASSETS (the service)
 *
 * What the Vendors, Loans and Fixed assets pages (routes/booksLoansAssets.ts),
 * the Tax Center's 1099 list (routes/books.ts) and the other money-out lanes
 * share:
 *
 *   VENDORS  Nic, 10/12: "one list of everyone the company pays (contractors,
 *            garbage company, power company) with a type; contractors get a
 *            1099 box and their payments add up per calendar year."
 *              vendorYearTotals / vendor1099List — what a vendor was paid in a
 *                calendar year: the live payments (landlord_expense_payments,
 *                voided_at IS NULL) on its active expenses
 *                (landlord_expenses.vendor_id, status 'active'), by paid_on.
 *                Card payments are left out of the 1099 figure (the card
 *                company reports them) and shown beside it.
 *              getOrCreateContractorVendorForTenant — the one vendor a work
 *                trader is when the landlord pays their extra hours as a
 *                contractor (1099), so every such payment adds up on one 1099.
 *   LOANS    loanFigures — what is still owed and the escrow the lender holds;
 *            matchLoanPaymentForBankLine — the Bank page's filing calls this
 *              for a bank line: money out that is a loan payment (one typed
 *              already, or the loan's regular payment) becomes that payment;
 *              money in that is a loan's money arriving is matched to the
 *              loan. unmatchLoanBankLine takes it back (the Bank page's Undo).
 *   ASSETS   assetFigures — depreciation so far and what the asset is worth on
 *            the books; capitalExpense — an expense that can become an asset
 *            (its category charges to an asset account);
 *            markDepreciationMonthsDue — marks each month of depreciation for
 *            posting once the month is over (run with the minute ledger drain).
 */
import type { PoolClient } from 'pg'
import {
  FORM_1099_NOT_REPORTED_PAYMENT_METHODS, BOOKS_LOAN_MATCH_WINDOW_DAYS, form1099NecThreshold, loanPaymentSuggestion,
  depreciationSchedule, depreciationThrough, fixedAssetDepreciates, fixedAssetLifeMonths, taxIdLast4,
  type BooksLoanState, type LoanPaymentSplit, type DepreciationMonth,
} from '@gam/shared'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { companyTzSql, cSql } from './ledgerProjectors/tenantShared'
import { assetSchedule } from './ledgerProjectors/loansAssets'

/** A client or the pool: anything with query(). */
type Q = Pick<PoolClient, 'query'>

/** The company a Books request names (routes/books.ts ownerScope). */
export interface BooksOwner { col: 'landlord_id' | 'business_id'; id: string }

/** Whole cents from a numeric column read as text. */
export const toCents = (v: string | number | null | undefined): number => Math.round((Number(v) || 0) * 100)
const dollars = (cents: number): number => Math.round(cents) / 100

// ═════════════════════════════════════════════════════════════════════════════
// VENDORS
// ═════════════════════════════════════════════════════════════════════════════

export interface VendorYearTotal {
  /** Everything paid to the vendor in the year (cents). */
  paidCents: number
  /** What a Form 1099-NEC counts: the year less card payments (cents). */
  reportableCents: number
  /** Paid by card — reported by the card company, not on the 1099 (cents). */
  cardCents: number
}

/**
 * What each vendor of a company was paid in calendar `year`: the live
 * payments on its active expenses, by the day each was paid. A business's
 * books have no expenses record yet, so its vendors were paid nothing here.
 */
export async function vendorYearTotals(q: Q, owner: BooksOwner, year: number, vendorIds?: readonly string[]): Promise<Map<string, VendorYearTotal>> {
  const out = new Map<string, VendorYearTotal>()
  if (owner.col !== 'landlord_id') return out
  const r = await q.query<{ vendor_id: string; paid: string; card: string }>(
    `SELECT e.vendor_id::text AS vendor_id,
            COALESCE(sum(p.amount), 0)::text AS paid,
            COALESCE(sum(p.amount) FILTER (WHERE p.method = ANY($4::text[])), 0)::text AS card
       FROM landlord_expense_payments p
       JOIN landlord_expenses e ON e.id = p.expense_id
      WHERE e.landlord_id = $1 AND e.vendor_id IS NOT NULL AND e.status = 'active'
        AND p.voided_at IS NULL
        AND p.paid_on >= make_date($2::int, 1, 1) AND p.paid_on < make_date($2::int + 1, 1, 1)
        AND ($3::uuid[] IS NULL OR e.vendor_id = ANY($3::uuid[]))
      GROUP BY e.vendor_id`,
    [owner.id, year, vendorIds ? [...vendorIds] : null, [...FORM_1099_NOT_REPORTED_PAYMENT_METHODS]])
  for (const row of r.rows) {
    const paid = toCents(row.paid)
    const card = toCents(row.card)
    out.set(row.vendor_id, { paidCents: paid, cardCents: card, reportableCents: paid - card })
  }
  return out
}

/** What each vendor is still owed: its active expenses less their live payments (cents). */
export async function vendorOwed(q: Q, owner: BooksOwner, vendorIds?: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (owner.col !== 'landlord_id') return out
  const r = await q.query<{ vendor_id: string; owed: string }>(
    `SELECT e.vendor_id::text AS vendor_id,
            sum(e.amount - COALESCE((SELECT sum(p.amount) FROM landlord_expense_payments p
                                      WHERE p.expense_id = e.id AND p.voided_at IS NULL), 0))::text AS owed
       FROM landlord_expenses e
      WHERE e.landlord_id = $1 AND e.vendor_id IS NOT NULL AND e.status = 'active'
        AND ($2::uuid[] IS NULL OR e.vendor_id = ANY($2::uuid[]))
      GROUP BY e.vendor_id`,
    [owner.id, vendorIds ? [...vendorIds] : null])
  for (const row of r.rows) out.set(row.vendor_id, toCents(row.owed))
  return out
}

/** The vendor columns the pages read — never the taxpayer id itself, only its last four. */
export const VENDOR_COLUMNS = `
  v.id, v.landlord_id, v.business_id, v.name, v.contact_name, v.email, v.phone, v.address, v.category,
  v.payment_terms, v.account_number, v.status, v.notes, v.vendor_type, v.is_1099, v.tax_classification,
  v.w9_on_file, v.trade, v.pay_rate::float AS pay_rate, v.pay_unit, v.tenant_id, v.migrated_from_contractor_id,
  v.created_at, v.updated_at,
  (v.tax_id IS NOT NULL AND v.tax_id <> '') OR v.ssn_last4 IS NOT NULL AS has_tax_id,
  COALESCE(right(regexp_replace(COALESCE(v.tax_id, ''), '[^0-9]', '', 'g'), 4), '') AS tax_id_digits_last4,
  v.ssn_last4`

/** One vendor row as the pages read it (the last four of its taxpayer id, never the id). */
export function vendorOut(v: Record<string, any>, year: number, totals?: VendorYearTotal, owedCents?: number): Record<string, unknown> {
  const last4 = (v.tax_id_digits_last4 && v.tax_id_digits_last4.length === 4 ? v.tax_id_digits_last4 : null) ?? v.ssn_last4 ?? null
  const { tax_id_digits_last4: _d, ssn_last4: _s, ...rest } = v
  return {
    ...rest,
    tax_id_last4: last4,
    year,
    paid_this_year: dollars(totals?.paidCents ?? 0),
    paid_by_card_this_year: dollars(totals?.cardCents ?? 0),
    reportable_this_year: dollars(totals?.reportableCents ?? 0),
    owed: dollars(owedCents ?? 0),
  }
}

/** The company's vendors with what each was paid this year and is still owed. */
export async function listVendors(q: Q, owner: BooksOwner, opts: { year: number; includeInactive?: boolean; type?: string | null }) {
  const r = await q.query<Record<string, any>>(
    `SELECT ${VENDOR_COLUMNS} FROM books_vendors v
      WHERE v.${owner.col} = $1 AND ($2::boolean OR v.status = 'active') AND ($3::text IS NULL OR v.vendor_type = $3)
      ORDER BY lower(v.name), v.id`, [owner.id, !!opts.includeInactive, opts.type ?? null])
  const ids = r.rows.map(v => v.id as string)
  const [totals, owed] = await Promise.all([vendorYearTotals(q, owner, opts.year, ids), vendorOwed(q, owner, ids)])
  return r.rows.map(v => vendorOut(v, opts.year, totals.get(v.id), owed.get(v.id)))
}

export interface Vendor1099Row {
  vendor_id: string
  name: string
  contact_name: string | null
  tax_classification: string | null
  tax_id_last4: string | null
  has_tax_id: boolean
  w9_on_file: boolean
  address: string | null
  status: string
  paid: number
  paid_by_card: number
  reportable: number
  threshold: number
  needs_1099: boolean
}

/**
 * The Tax Center's 1099 list for calendar `year`: every vendor with the 1099
 * box paid anything in the year — what a Form 1099-NEC counts (the year less
 * card payments), the threshold that year, and whether a form is needed.
 * Inactive vendors are listed too (they were paid that year).
 */
export async function vendor1099List(q: Q, owner: BooksOwner, year: number): Promise<{ year: number; threshold: number; vendors: Vendor1099Row[] }> {
  const threshold = form1099NecThreshold(year)
  const r = await q.query<Record<string, any>>(
    `SELECT ${VENDOR_COLUMNS} FROM books_vendors v WHERE v.${owner.col} = $1 AND v.is_1099 ORDER BY lower(v.name), v.id`, [owner.id])
  const totals = await vendorYearTotals(q, owner, year, r.rows.map(v => v.id))
  const vendors: Vendor1099Row[] = []
  for (const v of r.rows) {
    const t = totals.get(v.id)
    if (!t || t.paidCents <= 0) continue
    const out = vendorOut(v, year, t)
    vendors.push({
      vendor_id: v.id, name: v.name, contact_name: v.contact_name, tax_classification: v.tax_classification,
      tax_id_last4: out.tax_id_last4 as string | null, has_tax_id: !!v.has_tax_id, w9_on_file: !!v.w9_on_file,
      address: v.address, status: v.status,
      paid: dollars(t.paidCents), paid_by_card: dollars(t.cardCents), reportable: dollars(t.reportableCents),
      threshold, needs_1099: t.reportableCents >= threshold * 100,
    })
  }
  vendors.sort((a, b) => b.reportable - a.reportable || a.name.localeCompare(b.name))
  return { year, threshold, vendors }
}

/**
 * The vendor a work trader is when the landlord pays their extra hours as a
 * contractor (1099) — one per company, made the first time (type contractor,
 * the 1099 box ticked, individual, named as the tenant's account says), so
 * every payment to them adds up on one 1099. Refused for someone who is not
 * the company's tenant or work trader. Runs in the caller's transaction.
 */
export async function getOrCreateContractorVendorForTenant(
  client: Q, args: { landlordId: string; tenantId: string },
): Promise<{ id: string; vendorId: string; name: string; created: boolean }> {
  // Found again the next time (paying them makes an inactive one active again).
  const found = await client.query<{ id: string; name: string }>(
    `UPDATE books_vendors SET status = 'active', updated_at = CASE WHEN status = 'active' THEN updated_at ELSE now() END
      WHERE landlord_id = $1 AND tenant_id = $2 RETURNING id, name`, [args.landlordId, args.tenantId])
  if (found.rows[0]) return { id: found.rows[0].id, vendorId: found.rows[0].id, name: found.rows[0].name, created: false }
  const who = (await client.query<{ first_name: string | null; last_name: string | null; theirs: boolean }>(
    `SELECT u.first_name, u.last_name,
            (EXISTS (SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
                      WHERE lt.tenant_id = t.id AND l.landlord_id = $1)
             OR EXISTS (SELECT 1 FROM work_trade_extra_hours x WHERE x.tenant_id = t.id AND x.landlord_id = $1)) AS theirs
       FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE t.id = $2`, [args.landlordId, args.tenantId])).rows[0]
  if (!who || !who.theirs) throw new AppError(404, 'That person is not one of this company\'s tenants.')
  const name = [who.first_name, who.last_name].map(s => (s ?? '').trim()).filter(Boolean).join(' ') || 'Work trader'
  // 10/12 review (Nic 10/11: bookkeepers see names, never a tenant's contact
  // details): the vendor carries the work trader's name only. Their email and
  // phone stay on their tenant account; the owner may type them in here.
  const made = await client.query<{ id: string }>(
    `INSERT INTO books_vendors (landlord_id, name, contact_name, payment_terms, vendor_type, is_1099,
                                tax_classification, tenant_id, notes)
     VALUES ($1, $2, $2, 'due_on_receipt', 'contractor', TRUE, 'individual', $3,
             'Work trader paid for extra hours as a contractor (1099).')
     ON CONFLICT (landlord_id, tenant_id) WHERE tenant_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [args.landlordId, name.slice(0, 200), args.tenantId])
  if (made.rows[0]) return { id: made.rows[0].id, vendorId: made.rows[0].id, name, created: true }
  // Another request made it a moment ago.
  const again = (await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM books_vendors WHERE landlord_id = $1 AND tenant_id = $2`, [args.landlordId, args.tenantId])).rows[0]
  return { id: again.id, vendorId: again.id, name: again.name, created: false }
}

// ═════════════════════════════════════════════════════════════════════════════
// LOANS
// ═════════════════════════════════════════════════════════════════════════════

export interface LoanFigures {
  state: BooksLoanState
  /** The company's books start date, when it has one. */
  books_start: string | null
  /** Made before the books start: it opens at opening_balance. */
  opens_at_books_start: boolean
  /** What is still owed now: what it started at on the books less the principal paid since. Null until an opening balance is entered. */
  balance: number | null
  /** Escrow the lender holds: what it held on the books start date plus the escrow paid since. */
  escrow_held: number
  principal_paid: number
  interest_paid: number
  payments: number
  last_paid_on: string | null
}

interface LoanBase {
  id: string; start_date: string; original_amount: string; opening_balance: string | null; opening_escrow: string | null
  voided_at: string | null; books_start: string | null
}

/** Figures for each loan: live payments on or after the day the loan starts on the books. */
export async function loanFigures(q: Q, loans: readonly LoanBase[], asOf?: string | null): Promise<Map<string, LoanFigures>> {
  const out = new Map<string, LoanFigures>()
  if (!loans.length) return out
  const sums = await q.query<{ loan_id: string; principal: string; interest: string; escrow: string; n: number; last: string | null }>(
    `SELECT p.loan_id::text AS loan_id,
            COALESCE(sum(p.principal), 0)::text AS principal, COALESCE(sum(p.interest), 0)::text AS interest,
            COALESCE(sum(p.escrow), 0)::text AS escrow, count(*)::int AS n, max(p.paid_on)::text AS last
       FROM books_loan_payments p
       JOIN books_loans l ON l.id = p.loan_id
      WHERE p.loan_id = ANY($1::uuid[]) AND p.voided_at IS NULL
        AND p.paid_on >= GREATEST(l.start_date,
              COALESCE((SELECT x.books_start_date FROM landlords x WHERE x.id = l.landlord_id), l.start_date))
        AND ($2::date IS NULL OR p.paid_on <= $2::date)
      GROUP BY p.loan_id`, [loans.map(l => l.id), asOf ?? null])
  const by = new Map(sums.rows.map(s => [s.loan_id, s]))
  for (const l of loans) {
    const s = by.get(l.id)
    const opens = !!l.books_start && l.start_date < l.books_start
    const baseCents = opens ? (l.opening_balance == null ? null : toCents(l.opening_balance)) : toCents(l.original_amount)
    const principal = toCents(s?.principal)
    const escrow = toCents(s?.escrow) + (opens ? toCents(l.opening_escrow) : 0)
    const balance = baseCents == null ? null : baseCents - principal
    out.set(l.id, {
      state: l.voided_at ? 'voided' : balance === 0 ? 'paid_off' : 'active',
      books_start: l.books_start,
      opens_at_books_start: opens,
      balance: balance == null ? null : dollars(balance),
      escrow_held: dollars(escrow),
      principal_paid: dollars(principal),
      interest_paid: dollars(toCents(s?.interest)),
      payments: s?.n ?? 0,
      last_paid_on: s?.last ?? null,
    })
  }
  return out
}

/** The loan columns the pages and the figures read. */
export const LOAN_COLUMNS = `
  l.id, l.landlord_id, l.business_id, l.property_id, l.vendor_id, l.name, l.lender_name,
  l.original_amount::text AS original_amount, l.annual_rate::text AS annual_rate, l.start_date::text AS start_date,
  l.term_months, l.payment_amount::text AS payment_amount, l.escrow_amount::text AS escrow_amount, l.payment_day,
  l.funded_to, l.funded_bank_connection_id, l.funded_bank_transaction_id,
  l.opening_balance::text AS opening_balance, l.opening_escrow::text AS opening_escrow, l.notes,
  l.created_at, l.updated_at, l.voided_at::text AS voided_at, l.void_reason,
  (SELECT x.books_start_date::text FROM landlords x WHERE x.id = l.landlord_id) AS books_start,
  (SELECT p.name FROM properties p WHERE p.id = l.property_id) AS property_name,
  (SELECT v.name FROM books_vendors v WHERE v.id = l.vendor_id) AS vendor_name`

/** What is still owed on a loan on `day` (before a payment that day), in cents; null when its opening balance is not entered. */
export async function loanBalanceOn(q: Q, loanId: string, day: string, excludePaymentId?: string | null): Promise<number | null> {
  const l = (await q.query<LoanBase>(`SELECT ${LOAN_COLUMNS} FROM books_loans l WHERE l.id = $1`, [loanId])).rows[0]
  if (!l) return null
  const opens = !!l.books_start && l.start_date < l.books_start
  const base = opens ? (l.opening_balance == null ? null : toCents(l.opening_balance)) : toCents(l.original_amount)
  if (base == null) return null
  const r = await q.query<{ c: string }>(
    `SELECT COALESCE(sum(p.principal), 0)::text AS c FROM books_loan_payments p
      WHERE p.loan_id = $1 AND p.voided_at IS NULL AND ($3::uuid IS NULL OR p.id <> $3::uuid)
        AND p.paid_on >= $4::date AND p.paid_on <= $2::date`,
    [loanId, day, excludePaymentId ?? null, opens ? l.books_start : l.start_date])
  return base - toCents(r.rows[0]?.c)
}

/** GAM's suggested split for a payment of `amountCents` on `day` (the regular payment when no amount is given). */
export async function suggestLoanSplit(q: Q, loanId: string, day: string, amountCents?: number | null): Promise<LoanPaymentSplit & { balanceCents: number | null }> {
  const l = (await q.query<{ annual_rate: string; payment_amount: string | null; escrow_amount: string }>(
    `SELECT annual_rate::text AS annual_rate, payment_amount::text AS payment_amount, escrow_amount::text AS escrow_amount
       FROM books_loans WHERE id = $1`, [loanId])).rows[0]
  if (!l) throw new AppError(404, 'Loan not found.')
  const balanceCents = await loanBalanceOn(q, loanId, day)
  const paymentCents = amountCents ?? toCents(l.payment_amount)
  const split = loanPaymentSuggestion({
    balanceCents: balanceCents ?? 0, annualRatePct: l.annual_rate, paymentCents, escrowCents: toCents(l.escrow_amount),
  })
  return { ...split, balanceCents }
}

/** Refuses a principal part bigger than what is still owed on the loan that day. */
export async function assertPrincipalFits(q: Q, loanId: string, day: string, principalCents: number, excludePaymentId?: string | null): Promise<void> {
  const owed = await loanBalanceOn(q, loanId, day, excludePaymentId)
  if (owed != null && principalCents > owed) {
    throw new AppError(409, `That is more principal than is still owed on the loan on that day ($${(owed / 100).toFixed(2)}). Check the split against the lender's statement.`)
  }
}

/** What matchLoanPaymentForBankLine did with a bank line. */
export interface LoanBankMatch {
  /** loan_payment: money out that is a loan payment. loan_funding: money in that is a loan's money arriving. */
  kind: 'loan_payment' | 'loan_funding'
  loanId: string
  loanName: string
  /** The loan payment the line is (loan_payment only). */
  loanPaymentId: string | null
  /** True when the payment was made from the line; false when the line was matched to one already there. */
  created: boolean
  split: LoanPaymentSplit | null
}

/** One loan a bank line could be (read-only, for the Bank page to offer). */
export interface LoanBankCandidate {
  kind: 'loan_payment' | 'loan_funding'
  loanId: string
  loanName: string
  lenderName: string
  /** A payment typed already that the line would match (loan_payment only). */
  loanPaymentId: string | null
  paidOn: string | null
  suggested: LoanPaymentSplit | null
}

interface LineRow { id: string; landlord_id: string; bank_connection_id: string; posted_date: string; amount: string }

async function lineOf(q: Q, landlordId: string, bankTransactionId: string, lock: boolean): Promise<LineRow> {
  const r = await q.query<LineRow>(
    `SELECT id, landlord_id, bank_connection_id, posted_date::text AS posted_date, amount::text AS amount
       FROM bank_transactions WHERE id = $1 AND landlord_id = $2${lock ? ' FOR UPDATE' : ''}`, [bankTransactionId, landlordId])
  if (!r.rows[0]) throw new AppError(404, 'That bank line is not this company\'s.')
  return r.rows[0]
}

/** The loans (and payments typed already) a bank line could be. Nothing is written. */
export async function findLoanMatchesForBankLine(
  q: Q, args: { landlordId: string; bankTransactionId: string; loanId?: string | null },
): Promise<LoanBankCandidate[]> {
  const line = await lineOf(q, args.landlordId, args.bankTransactionId, false)
  const cents = toCents(line.amount)
  const w = BOOKS_LOAN_MATCH_WINDOW_DAYS
  if (cents < 0) {
    const amount = dollars(-cents)
    const typed = await q.query<{ id: string; loan_id: string; name: string; lender_name: string; paid_on: string; principal: string; interest: string; escrow: string }>(
      `SELECT p.id, p.loan_id, l.name, l.lender_name, p.paid_on::text AS paid_on,
              p.principal::text AS principal, p.interest::text AS interest, p.escrow::text AS escrow
         FROM books_loan_payments p JOIN books_loans l ON l.id = p.loan_id
        WHERE p.landlord_id = $1 AND p.voided_at IS NULL AND l.voided_at IS NULL
          AND p.method = 'bank' AND p.bank_transaction_id IS NULL AND p.amount = $2::numeric
          AND (p.bank_connection_id IS NULL OR p.bank_connection_id = $3)
          AND abs(p.paid_on - $4::date) <= $5
          AND ($6::uuid IS NULL OR p.loan_id = $6::uuid)
        ORDER BY abs(p.paid_on - $4::date), p.paid_on, p.id`,
      [args.landlordId, amount, line.bank_connection_id, line.posted_date, w, args.loanId ?? null])
    const out: LoanBankCandidate[] = typed.rows.map(t => ({
      kind: 'loan_payment', loanId: t.loan_id, loanName: t.name, lenderName: t.lender_name, loanPaymentId: t.id, paidOn: t.paid_on,
      suggested: { principalCents: toCents(t.principal), interestCents: toCents(t.interest), escrowCents: toCents(t.escrow) },
    }))
    const typedLoans = new Set(out.map(o => o.loanId))
    const regular = await q.query<{ id: string; name: string; lender_name: string }>(
      `SELECT l.id, l.name, l.lender_name FROM books_loans l
        WHERE l.landlord_id = $1 AND l.voided_at IS NULL AND l.start_date <= $3::date + $4::int
          AND ($5::uuid IS NOT NULL OR l.payment_amount = $2::numeric)
          AND ($5::uuid IS NULL OR l.id = $5::uuid)
        ORDER BY l.start_date, l.id`, [args.landlordId, amount, line.posted_date, w, args.loanId ?? null])
    for (const l of regular.rows) {
      if (typedLoans.has(l.id)) continue
      const s = await suggestLoanSplit(q, l.id, line.posted_date, -cents)
      // Not this loan's payment when it would pay more principal than is owed —
      // unless the person picked the loan (their own split then decides).
      if (!args.loanId && s.balanceCents != null && s.principalCents > s.balanceCents) continue
      out.push({ kind: 'loan_payment', loanId: l.id, loanName: l.name, lenderName: l.lender_name, loanPaymentId: null,
        paidOn: line.posted_date, suggested: { principalCents: s.principalCents, interestCents: s.interestCents, escrowCents: s.escrowCents } })
    }
    return out
  }
  if (cents > 0) {
    const r = await q.query<{ id: string; name: string; lender_name: string }>(
      `SELECT l.id, l.name, l.lender_name FROM books_loans l
        WHERE l.landlord_id = $1 AND l.voided_at IS NULL AND l.funded_to = 'bank' AND l.funded_bank_transaction_id IS NULL
          AND l.original_amount = $2::numeric AND abs(l.start_date - $4::date) <= $5
          -- 10/12 review: a loan made before the books start opens at what was
          -- still owed (its posting carries no bank money), so its money
          -- arriving is no line of these books to match.
          AND l.start_date >= COALESCE((SELECT x.books_start_date FROM landlords x WHERE x.id = l.landlord_id), l.start_date)
          AND (l.funded_bank_connection_id IS NULL OR l.funded_bank_connection_id = $3)
          AND ($6::uuid IS NULL OR l.id = $6::uuid)
        ORDER BY abs(l.start_date - $4::date), l.id`,
      [args.landlordId, dollars(cents), line.bank_connection_id, line.posted_date, w, args.loanId ?? null])
    return r.rows.map(l => ({ kind: 'loan_funding', loanId: l.id, loanName: l.name, lenderName: l.lender_name,
      loanPaymentId: null, paidOn: null, suggested: null }))
  }
  return []
}

/**
 * The Bank page's filing calls this for a bank line (in its own transaction,
 * `client`). It does the match and says what it did, or returns null when the
 * line is no loan's (or could be more than one's — the person then picks,
 * passing `loanId`):
 *   money OUT — a loan payment typed already for the same amount within a
 *     week of the line (paid from the bank, not matched yet) becomes this
 *     line's; otherwise a loan whose regular payment is the line's amount (or
 *     the `loanId` given) gets a payment made from the line, dated the line's
 *     day, split as `split` says or as GAM suggests (interest on what is
 *     owed, the regular escrow, the rest principal — never more principal
 *     than is owed);
 *   money IN — a loan made into this bank account for the line's amount within
 *     a week of its start is marked as arrived by this line.
 * Matching the same line again returns what it already is. The line's own
 * status (matched) is the Bank page's to set; a loan payment names its line
 * (books_loan_payments.bank_transaction_id), a loan its funding line
 * (books_loans.funded_bank_transaction_id), and the loan payment — not the
 * line — is what posts the money out (ledger source 'loan_payment').
 */
export async function matchLoanPaymentForBankLine(
  client: Q,
  args: { landlordId: string; bankTransactionId: string; loanId?: string | null; split?: LoanPaymentSplit | null; actorUserId?: string | null },
): Promise<LoanBankMatch | null> {
  const line = await lineOf(client, args.landlordId, args.bankTransactionId, true)
  // Already matched: say what it is.
  const already = (await client.query<{ id: string; loan_id: string; name: string; principal: string; interest: string; escrow: string }>(
    `SELECT p.id, p.loan_id, l.name, p.principal::text AS principal, p.interest::text AS interest, p.escrow::text AS escrow
       FROM books_loan_payments p JOIN books_loans l ON l.id = p.loan_id
      WHERE p.bank_transaction_id = $1 AND p.voided_at IS NULL`, [line.id])).rows[0]
  if (already) {
    return { kind: 'loan_payment', loanId: already.loan_id, loanName: already.name, loanPaymentId: already.id, created: false,
      split: { principalCents: toCents(already.principal), interestCents: toCents(already.interest), escrowCents: toCents(already.escrow) } }
  }
  const funded = (await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM books_loans WHERE funded_bank_transaction_id = $1 AND voided_at IS NULL`, [line.id])).rows[0]
  if (funded) return { kind: 'loan_funding', loanId: funded.id, loanName: funded.name, loanPaymentId: null, created: false, split: null }

  const candidates = await findLoanMatchesForBankLine(client, args)
  if (candidates.length === 0) return null
  // A payment typed already wins over making one (the nearest day; two equally
  // near are the person's to pick); more than one loan is the person's to pick.
  const typed = candidates.filter(c => c.loanPaymentId)
  const away = (c: LoanBankCandidate) => Math.abs(Date.parse(`${c.paidOn}T12:00:00Z`) - Date.parse(`${line.posted_date}T12:00:00Z`))
  const pick = typed.length ? (typed.length === 1 || away(typed[0]) < away(typed[1]) ? typed[0] : null)
    : candidates.length === 1 ? candidates[0] : null
  if (!pick) return null

  if (pick.kind === 'loan_funding') {
    await client.query(
      `UPDATE books_loans SET funded_bank_transaction_id = $2,
              funded_bank_connection_id = COALESCE(funded_bank_connection_id, $3), updated_at = now()
        WHERE id = $1`, [pick.loanId, line.id, line.bank_connection_id])
    return { kind: 'loan_funding', loanId: pick.loanId, loanName: pick.loanName, loanPaymentId: null, created: false, split: null }
  }

  if (pick.loanPaymentId) {
    await client.query(
      `UPDATE books_loan_payments SET bank_transaction_id = $2, bank_connection_id = $3, updated_at = now() WHERE id = $1`,
      [pick.loanPaymentId, line.id, line.bank_connection_id])
    return { kind: 'loan_payment', loanId: pick.loanId, loanName: pick.loanName, loanPaymentId: pick.loanPaymentId, created: false, split: pick.suggested }
  }

  const amountCents = -toCents(line.amount)
  const split = args.split ?? pick.suggested!
  if (split.principalCents + split.interestCents + split.escrowCents !== amountCents
      || split.principalCents < 0 || split.interestCents < 0 || split.escrowCents < 0) {
    throw new AppError(400, `The principal, interest and escrow must add up to the bank line ($${(amountCents / 100).toFixed(2)}).`)
  }
  await assertPrincipalFits(client, pick.loanId, line.posted_date, split.principalCents)
  const owner = (await client.query<{ landlord_id: string }>(`SELECT landlord_id FROM books_loans WHERE id = $1`, [pick.loanId])).rows[0]
  const made = await client.query<{ id: string }>(
    `INSERT INTO books_loan_payments (loan_id, landlord_id, paid_on, amount, principal, interest, escrow, method,
                                      bank_connection_id, bank_transaction_id, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'bank', $8, $9, 'bank_line', $10) RETURNING id`,
    [pick.loanId, owner.landlord_id, line.posted_date, dollars(amountCents), dollars(split.principalCents),
     dollars(split.interestCents), dollars(split.escrowCents), line.bank_connection_id, line.id, args.actorUserId ?? null])
  return { kind: 'loan_payment', loanId: pick.loanId, loanName: pick.loanName, loanPaymentId: made.rows[0].id, created: true, split }
}

/**
 * The Bank page's Undo for a line matched to a loan: a payment MADE from the
 * line is voided (kept on record, its posting taken back); a payment typed
 * first is only unlinked from the line (it stays, paid from the bank); a loan's
 * funding line is unlinked. Returns what changed.
 */
export async function unmatchLoanBankLine(
  client: Q, args: { landlordId: string; bankTransactionId: string; actorUserId: string | null; reason?: string | null },
): Promise<{ voidedPaymentIds: string[]; unlinkedPaymentIds: string[]; unlinkedLoanIds: string[] }> {
  await lineOf(client, args.landlordId, args.bankTransactionId, true)
  const voided = await client.query<{ id: string }>(
    `UPDATE books_loan_payments
        SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now()
      WHERE bank_transaction_id = $1 AND voided_at IS NULL AND source = 'bank_line' RETURNING id`,
    [args.bankTransactionId, args.actorUserId, (args.reason ?? 'The bank line\'s filing was taken back.').slice(0, 500)])
  const unlinked = await client.query<{ id: string }>(
    `UPDATE books_loan_payments SET bank_transaction_id = NULL, updated_at = now()
      WHERE bank_transaction_id = $1 AND voided_at IS NULL AND source = 'entered' RETURNING id`, [args.bankTransactionId])
  const loans = await client.query<{ id: string }>(
    `UPDATE books_loans SET funded_bank_transaction_id = NULL, updated_at = now()
      WHERE funded_bank_transaction_id = $1 AND voided_at IS NULL RETURNING id`, [args.bankTransactionId])
  return {
    voidedPaymentIds: voided.rows.map(r => r.id),
    unlinkedPaymentIds: unlinked.rows.map(r => r.id),
    unlinkedLoanIds: loans.rows.map(r => r.id),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FIXED ASSETS
// ═════════════════════════════════════════════════════════════════════════════

export const ASSET_COLUMNS = `
  a.id, a.landlord_id, a.business_id, a.property_id, a.name, a.asset_class, a.cost::text AS cost,
  a.salvage_value::text AS salvage_value, a.acquired_on::text AS acquired_on, a.in_service_date::text AS in_service_date,
  a.life_years::text AS life_years, a.method, a.prior_depreciation::text AS prior_depreciation, a.source_expense_id,
  a.notes, a.created_at, a.updated_at, a.voided_at::text AS voided_at, a.void_reason,
  (SELECT x.books_start_date::text FROM landlords x WHERE x.id = a.landlord_id) AS books_start,
  (SELECT p.name FROM properties p WHERE p.id = a.property_id) AS property_name,
  (SELECT e.description FROM landlord_expenses e WHERE e.id = a.source_expense_id) AS source_expense_description`

export interface AssetFigures {
  /** Bought before the books start (and not from an expense): it opens at its cost less what was already taken. */
  opens_at_books_start: boolean
  monthly: number
  depreciated_to_date: number
  book_value: number
  months_left: number
  life_ends: string | null
  depreciates: boolean
  /** Why the schedule could not be worked out (the books post nothing until it is fixed), or null. */
  problem: string | null
}

/** Depreciation so far (every month ended on or before `today`) and what the asset is worth on the books. */
export function assetFigures(a: Record<string, any>, today: string): AssetFigures {
  const costCents = toCents(a.cost)
  const salvageCents = toCents(a.salvage_value)
  const start: string | null = a.books_start
  const opens = !!start && !a.source_expense_id && a.acquired_on < start
  const depreciates = fixedAssetDepreciates(a.asset_class)
  const lifeMonths = fixedAssetLifeMonths(a.life_years)
  let schedule: DepreciationMonth[] = []
  let problem: string | null = null
  if (depreciates && lifeMonths) {
    try {
      const usePrior = opens && a.prior_depreciation != null
      schedule = depreciationSchedule({
        costCents, salvageCents, inServiceDate: a.in_service_date, lifeMonths,
        priorCents: usePrior ? toCents(a.prior_depreciation) : null, priorAsOf: usePrior ? start : null,
      })
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e)
    }
  }
  const done = depreciationThrough(schedule, today)
  const next = schedule.find(m => m.endDay > today)
  return {
    opens_at_books_start: opens,
    monthly: dollars(next?.cents ?? schedule[schedule.length - 1]?.cents ?? 0),
    depreciated_to_date: dollars(done),
    book_value: dollars(costCents - done),
    months_left: schedule.filter(m => m.endDay > today).length,
    life_ends: schedule.length ? schedule[schedule.length - 1].endDay : null,
    depreciates,
    problem,
  }
}

/** Today on the company's books calendar. */
export async function companyToday(q: Q, landlordId: string | null): Promise<string> {
  const r = await q.query<{ d: string }>(
    landlordId
      ? `SELECT (now() AT TIME ZONE ${companyTzSql('$1::uuid')})::date::text AS d`
      : `SELECT (now() AT TIME ZONE 'America/Phoenix')::date::text AS d`,
    landlordId ? [landlordId] : [])
  return r.rows[0].d
}

/**
 * An expense that can become a fixed asset: active, the company's, with no
 * live asset made from it yet, filed under a category that charges to an
 * ASSET account (a capital improvement — its cost is already on the books as
 * an asset, so the asset adds the depreciation and nothing else). Refused in
 * plain words otherwise.
 */
export async function capitalExpense(q: Q, landlordId: string, expenseId: string): Promise<{
  id: string; amount: string; expense_date: string; description: string | null; property_id: string | null
  category_name: string | null
}> {
  const e = (await q.query<{
    id: string; amount: string; expense_date: string; description: string | null; property_id: string | null
    status: string; voided_at: string | null; category_id: string | null; category_name: string | null
    account_type: string | null; account_name: string | null; has_asset: boolean
  }>(
    `SELECT e.id, e.amount::text AS amount, e.expense_date::text AS expense_date, e.description, e.property_id,
            e.status, e.voided_at::text AS voided_at, e.category_id,
            (SELECT c.name FROM books_categories c WHERE c.id = e.category_id) AS category_name,
            COALESCE((SELECT a.type FROM books_accounts a WHERE a.id = books_category_account(e.category_id, e.expense_date)),
                     books_category_account_type(e.category_id)) AS account_type,
            (SELECT a.name FROM books_accounts a WHERE a.id = books_category_account(e.category_id, e.expense_date)) AS account_name,
            EXISTS (SELECT 1 FROM books_fixed_assets f WHERE f.source_expense_id = e.id AND f.voided_at IS NULL) AS has_asset
       FROM landlord_expenses e WHERE e.id = $1 AND e.landlord_id = $2`, [expenseId, landlordId])).rows[0]
  if (!e) throw new AppError(404, 'That expense is not this company\'s.')
  if (e.status !== 'active' || e.voided_at) throw new AppError(409, 'That expense was voided.')
  if (e.has_asset) throw new AppError(409, 'That expense is already a fixed asset.')
  if (!e.category_id) throw new AppError(409, 'That expense has no category. File it under a capital-improvement category first.')
  if (e.account_type !== 'asset') {
    throw new AppError(409, `That expense is filed under ${e.category_name ?? 'a category'}${e.account_name ? `, which charges to ${e.account_name}` : ''} — not an asset account. ` +
      'Only an expense filed under a capital-improvement category (one that charges to an asset account, such as Rental property or Equipment) can become a fixed asset.')
  }
  return e
}

/** Expenses that could become fixed assets (capitalExpense would take each). */
export async function capitalExpenses(q: Q, landlordId: string): Promise<Record<string, unknown>[]> {
  const r = await q.query(
    `SELECT e.id, e.amount::float AS amount, e.expense_date::text AS expense_date, e.description, e.property_id,
            (SELECT p.name FROM properties p WHERE p.id = e.property_id) AS property_name,
            c.name AS category_name
       FROM landlord_expenses e
       JOIN books_categories c ON c.id = e.category_id
      WHERE e.landlord_id = $1 AND e.status = 'active' AND e.voided_at IS NULL
        AND COALESCE((SELECT a.type FROM books_accounts a WHERE a.id = books_category_account(e.category_id, e.expense_date)),
                     books_category_account_type(e.category_id)) = 'asset'
        AND NOT EXISTS (SELECT 1 FROM books_fixed_assets f WHERE f.source_expense_id = e.id AND f.voided_at IS NULL)
      ORDER BY e.expense_date DESC, e.id`, [landlordId])
  return r.rows
}

/**
 * Marks for posting every month of depreciation that has ended (on its
 * company's calendar) and has no posting yet — from the books start on, for
 * every live asset that wears out, only the months that carry an amount (the
 * same schedule the projector posts). Run with the minute ledger drain
 * (services/ledgerJobs), so a month's depreciation posts within a minute of
 * the month ending; idempotent (a month already posted or already waiting is
 * not marked again). Returns how many months it marked.
 */
export async function markDepreciationMonthsDue(q: Q = db): Promise<number> {
  const assets = (await q.query<Record<string, any>>(
    `SELECT a.id::text AS id, a.landlord_id::text AS landlord_id, a.asset_class, ${cSql('a.cost')} AS cost_c,
            ${cSql('a.salvage_value')} AS salvage_c, a.acquired_on::text AS acquired_on, a.in_service_date::text AS in_service_date,
            a.life_years::text AS life_years,
            CASE WHEN a.prior_depreciation IS NULL THEN NULL ELSE ${cSql('a.prior_depreciation')} END AS prior_c,
            a.source_expense_id, l.books_start_date::text AS books_start,
            (now() AT TIME ZONE ${companyTzSql('a.landlord_id')})::date::text AS today
       FROM books_fixed_assets a
       JOIN landlords l ON l.id = a.landlord_id
      WHERE a.voided_at IS NULL AND a.life_years IS NOT NULL AND a.asset_class <> 'land' AND a.cost > a.salvage_value
        AND l.books_start_date IS NOT NULL
        AND (a.source_expense_id IS NULL
             OR EXISTS (SELECT 1 FROM landlord_expenses e WHERE e.id = a.source_expense_id AND e.status = 'active' AND e.voided_at IS NULL))`)).rows
  const due: { key: string; owner: string }[] = []
  for (const a of assets) {
    let schedule: DepreciationMonth[]
    try { schedule = assetSchedule(a as any, a.books_start) } catch { continue }
    for (const m of schedule) {
      if (m.cents > 0 && m.endDay >= a.books_start && m.endDay < a.today) due.push({ key: `${a.id}|${m.month}`, owner: a.landlord_id })
    }
  }
  if (!due.length) return 0
  const r = await q.query(
    `INSERT INTO ledger_outbox (source_type, source_id, owner_id)
     SELECT 'fixed_asset', d.key, d.owner
       FROM unnest($1::text[], $2::uuid[]) AS d(key, owner)
      WHERE NOT EXISTS (SELECT 1 FROM ledger_postings p
                         WHERE p.source_type = 'fixed_asset' AND p.source_id = d.key AND p.role = 'post' AND p.superseded_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM ledger_outbox o WHERE o.source_type = 'fixed_asset' AND o.source_id = d.key)`,
    [due.map(d => d.key), due.map(d => d.owner)])
  return r.rowCount ?? 0
}

export { taxIdLast4 }
