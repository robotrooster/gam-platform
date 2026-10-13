/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: LOANS AND FIXED ASSETS POST THEMSELVES
 *
 *   Nic 10/12: "loans/mortgages (principal / interest / escrow per payment)
 *   and fixed assets with depreciation ARE IN THIS BUILD."
 *
 * Three sources (gam-ledger-design-2026-10-12 §6 I, J; migrations
 * 20261014190100-190300):
 *
 * 'loan' — one books_loans row, one posting:
 *   made on or after the books start date, on the day it was made:
 *     Dr where the money went (funded_to): the bank account it arrived in
 *        (Checking, that bank's own sub-account), or Rental property /
 *        Equipment when the lender paid the seller straight
 *     Cr the loan's own account (a sub-account under Mortgage payable, map
 *        kind 'loan')                                     the amount borrowed
 *   made before the books start, on the books start date:
 *     Cr the loan's own account      what was still owed that day (opening_balance)
 *     Dr Escrow held by your lender  the escrow the lender held that day
 *     against Opening balance equity (3900)
 *   The posting waits on the owner (owner_not_ready, no admin notice) until
 *   they say where the money went, or what was owed on the books start date.
 *
 * 'loan_payment' — one books_loan_payments row, on the day it was paid:
 *     Dr the loan's own account          principal (what is owed goes down)
 *     Dr Mortgage and loan interest (5010) interest — on the loan's property,
 *                                        or, for a company loan, where the
 *                                        owner puts company-level costs (L7)
 *     Dr Escrow held by your lender (1250) escrow
 *     Cr where the money came from: the bank (that bank's sub-account), a
 *        credit card (2110), or the owner personally (3010)
 *   10/12 review: each debit is marked as money out by what it paid for
 *   (cash_effect 'out'; expense_kind 'expense' for the interest, with the
 *   mortgage-interest report category; 'liability' for the principal; 'asset'
 *   for the escrow), the way an expense payment marks its debit
 *   A payment dated before the books start posts nothing (the loan opens at
 *   what was still owed that day, which already counts it).
 *
 * 'fixed_asset' — '<asset>' and '<asset>|YYYY-MM':
 *   '<asset>' an asset bought before the books start opens on that date:
 *     Dr its account (Rental property, or Equipment for equipment and
 *        vehicles)                       the cost
 *     Cr Accumulated depreciation (1510) what was already taken (the owner's
 *                                        figure, or the straight-line months
 *                                        that ended before the start)
 *     Cr Opening balance equity (3900)   the rest
 *     An asset bought on or after the start posts no cost of its own: its
 *     cost is on the books through how it was paid (its expense, the loan
 *     that bought it, or a journal entry) — never twice.
 *     10/12 review: an asset made from an expense dated before the start
 *     (its cost opens through the expense) opens the depreciation already
 *     taken: Dr Opening balance equity / Cr Accumulated depreciation.
 *   '<asset>|YYYY-MM' that month's straight-line depreciation, on the month's
 *     last day: Dr Depreciation (5170) — on the asset's property, or where
 *     company-level costs go (L7) — / Cr Accumulated depreciation (1510).
 *     A month that ended before the books start posts nothing (the opening
 *     carries it). Land never depreciates. An asset made from an expense that
 *     is no longer active posts nothing (the database refuses that void while
 *     the asset stands; this is the backstop).
 *
 * Nothing here is dated before the company's books start, so the opening
 * posting's walk of every projector (tenantOpening J1 a) finds nothing of
 * these to carry — loans and assets open through their own postings above.
 *
 * Facts only (ledgerProjectorPurity): the rows as saved, the books start date,
 * the owner's company-cost choice (fixed once the books post). A business's
 * loans and assets wait for the business portal's own books (a later phase).
 */
import type { PoolClient } from 'pg'
import {
  BOOKS_FIXED_ASSET_CLASS_ROLE, depreciationBefore, depreciationSchedule, fixedAssetDepreciates, fixedAssetLifeMonths,
  type BooksFixedAssetClass, type DepreciationMonth, type LedgerAccountRole,
} from '@gam/shared'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import { LedgerSourceError } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { dr, cr, companyTzSql } from './registerBookingPayoutKit'
import { cSql, centsOf, isUuid } from './tenantShared'
import { companyCostSpread, drSpread } from './companyCosts'

export const LOANS_ASSETS_RULE_VERSION = 1

/** A loan's own account: its sub-account under Mortgage payable. */
function loanSub(loanId: string, name: string): DesiredLine['sub'] {
  return { kind: 'loan', value: loanId, name: `Loan payable: ${name}`.slice(0, 200) }
}

function needsBooksStart(): LedgerSourceError {
  return new LedgerSourceError('no_books_start', 'The company has no books start date yet; nothing posts until it picks one.')
}

// ─── Loans ───────────────────────────────────────────────────────────────────

interface LoanRow {
  landlord_id: string | null
  property_id: string | null
  vendor_id: string | null
  name: string
  original_c: string
  start_date: string
  funded_to: string | null
  funded_bank_connection_id: string | null
  opening_c: string | null
  opening_escrow_c: string | null
  voided_at: string | null
  books_start: string | null
  funded_line_day: string | null
}

const LOAN_SQL = `
  SELECT l.landlord_id, l.property_id, l.vendor_id, l.name, ${cSql('l.original_amount')} AS original_c,
         l.start_date::text AS start_date, l.funded_to, l.funded_bank_connection_id,
         CASE WHEN l.opening_balance IS NULL THEN NULL ELSE ${cSql('l.opening_balance')} END AS opening_c,
         CASE WHEN l.opening_escrow IS NULL THEN NULL ELSE ${cSql('l.opening_escrow')} END AS opening_escrow_c,
         l.voided_at::text AS voided_at,
         (SELECT x.books_start_date::text FROM landlords x WHERE x.id = l.landlord_id) AS books_start,
         (SELECT b.posted_date::text FROM bank_transactions b WHERE b.id = l.funded_bank_transaction_id) AS funded_line_day
    FROM books_loans l`

export async function projectLoan(client: PoolClient, loanId: string): Promise<DesiredPosting[]> {
  if (!isUuid(loanId)) return []
  const loan = (await client.query<LoanRow>(`${LOAN_SQL} WHERE l.id = $1`, [loanId])).rows[0]
  // A business's loans wait for the business portal's books (a later phase).
  if (!loan || !loan.landlord_id || loan.voided_at) return []
  const start = loan.books_start
  if (!start) throw needsBooksStart()
  const owner = { landlordId: loan.landlord_id }
  const d = { propertyId: loan.property_id, vendorId: loan.vendor_id }
  const sub = loanSub(loanId, loan.name)
  const lines: DesiredLine[] = []

  if (loan.start_date < start) {
    if (loan.opening_c == null) {
      throw new LedgerSourceError('owner_not_ready',
        `Waiting on the owner: what was still owed on the loan "${loan.name}" on the books start date (${start}) is not entered yet on the Loans page.`)
    }
    const owed = centsOf(loan.opening_c)
    const escrow = centsOf(loan.opening_escrow_c)
    lines.push(
      ...cr('mortgage_payable', owed, { ...d, sub, reportCategory: 'opening', memo: 'Owed on the books start date' }),
      ...dr('opening_balance_equity', owed, { ...d, reportCategory: 'opening', memo: `${loan.name}: owed on the books start date` }),
      ...dr('loan_escrow', escrow, { ...d, reportCategory: 'opening', memo: 'Escrow the lender held on the books start date' }),
      ...cr('opening_balance_equity', escrow, { ...d, reportCategory: 'opening', memo: `${loan.name}: escrow on the books start date` }),
    )
    if (!lines.length) return []
    return [{ owner, intendedDate: start, memo: `Loan ${loan.name}: opening balance`, lines }]
  }

  const borrowed = centsOf(loan.original_c)
  let target: { role: LedgerAccountRole; sub?: DesiredLine['sub'] }
  switch (loan.funded_to) {
    case 'bank':
      target = loan.funded_bank_connection_id
        ? { role: 'bank_checking', sub: { kind: 'bank_connection', value: loan.funded_bank_connection_id } }
        : { role: 'bank_checking' }
      break
    case 'property': target = { role: 'rental_property' }; break
    case 'equipment': target = { role: 'equipment' }; break
    default:
      throw new LedgerSourceError('owner_not_ready',
        `Waiting on the owner: where the money from the loan "${loan.name}" went is not entered yet on the Loans page.`)
  }
  lines.push(
    ...dr(target.role, borrowed, { ...d, ...(target.sub ? { sub: target.sub } : {}), memo: `Borrowed: ${loan.name}` }),
    ...cr('mortgage_payable', borrowed, { ...d, sub, memo: 'Amount borrowed' }),
  )
  // 10/12 (Nic, integrate): matched to the bank line it arrived as, the money
  // is in the bank on the bank's day (never before the loan was made).
  const day = loan.funded_to === 'bank' && loan.funded_line_day && loan.funded_line_day > loan.start_date
    ? loan.funded_line_day : loan.start_date
  return [{ owner, intendedDate: day, memo: `Loan ${loan.name}`, lines }]
}

export const loanProjector: LedgerProjector = {
  sourceType: 'loan',
  ruleVersion: LOANS_ASSETS_RULE_VERSION,
  project: (client, sourceId) => projectLoan(client, sourceId),
  // Every loan, dated the day it posts on (the books start for one made
  // before it), so a moved books start re-posts each one it crosses.
  async listSources(client: PoolClient, owner: LedgerOwner): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT l.id::text AS id,
              GREATEST(l.start_date, COALESCE((SELECT x.books_start_date FROM landlords x WHERE x.id = l.landlord_id), l.start_date),
                       COALESCE((SELECT b.posted_date FROM bank_transactions b WHERE b.id = l.funded_bank_transaction_id), l.start_date))::text AS day
         FROM books_loans l WHERE l.landlord_id = $1
        ORDER BY l.start_date, l.id`, [owner.landlordId])
    return r.rows
  },
}

// ─── Loan payments ───────────────────────────────────────────────────────────

interface LoanPaymentRow {
  landlord_id: string | null
  loan_id: string
  paid_on: string
  principal_c: string
  interest_c: string
  escrow_c: string
  method: string
  bank_connection_id: string | null
  voided_at: string | null
  loan_name: string
  property_id: string | null
  vendor_id: string | null
  loan_voided_at: string | null
  books_start: string | null
  bank_transaction_id: string | null
  line_day: string | null
  line_connection: string | null
}

export async function projectLoanPayment(client: PoolClient, paymentId: string): Promise<DesiredPosting[]> {
  if (!isUuid(paymentId)) return []
  const p = (await client.query<LoanPaymentRow>(
    `SELECT p.landlord_id, p.loan_id, p.paid_on::text AS paid_on,
            ${cSql('p.principal')} AS principal_c, ${cSql('p.interest')} AS interest_c, ${cSql('p.escrow')} AS escrow_c,
            p.method, p.bank_connection_id, p.voided_at::text AS voided_at,
            l.name AS loan_name, l.property_id, l.vendor_id, l.voided_at::text AS loan_voided_at,
            (SELECT x.books_start_date::text FROM landlords x WHERE x.id = p.landlord_id) AS books_start,
            p.bank_transaction_id, bt.posted_date::text AS line_day, bt.bank_connection_id AS line_connection
       FROM books_loan_payments p JOIN books_loans l ON l.id = p.loan_id
       LEFT JOIN bank_transactions bt ON bt.id = p.bank_transaction_id
      WHERE p.id = $1`, [paymentId])).rows[0]
  if (!p || !p.landlord_id || p.voided_at || p.loan_voided_at) return []
  if (!p.books_start) throw needsBooksStart()
  // Before the books start: the loan's opening balance already counts it.
  if (p.paid_on < p.books_start) return []

  const principal = centsOf(p.principal_c)
  const interest = centsOf(p.interest_c)
  const escrow = centsOf(p.escrow_c)
  const d = { propertyId: p.property_id, vendorId: p.vendor_id }
  // 10/12 review: money going out is marked on the DEBIT side, by what each
  // part paid for — the way an expense payment marks its Accounts payable
  // debit (moneyOut I2): cash_effect 'out' with expense_kind = the kind of
  // account it reached. A cash-basis report (design §10: Paid, by
  // expense_kind; the Received-based P&L counts expense_kind 'expense')
  // then counts the interest as a cost the day it was paid, and never the
  // principal (a liability paid down) or the escrow (money the lender holds).
  // The bank credit carries no cash effect, so the sign of every 'out' line
  // is the same as an expense payment's.
  const lines: DesiredLine[] = [
    ...dr('mortgage_payable', principal, { ...d, sub: loanSub(p.loan_id, p.loan_name), cashEffect: 'out', expenseKind: 'liability', memo: 'Principal' }),
  ]
  const interestTags = { cashEffect: 'out' as const, expenseKind: 'expense', reportCategory: 'mortgage_interest' as const }
  if (p.property_id) {
    lines.push(...dr('mortgage_interest', interest, { ...d, ...interestTags, memo: `Interest: ${p.loan_name}` }))
  } else {
    // A company loan's interest belongs to no one property (Nic L7).
    const spread = await companyCostSpread(client, p.landlord_id, p.paid_on)
    lines.push(...drSpread('mortgage_interest', interest, spread, { vendorId: p.vendor_id, ...interestTags, memo: `Interest: ${p.loan_name}` }))
  }
  lines.push(...dr('loan_escrow', escrow, { ...d, cashEffect: 'out', expenseKind: 'asset', memo: 'Escrow' }))

  // 10/12 (Nic, integrate): a payment typed on one day whose bank line posted
  // on another sits in Outstanding checks (2015) until the line's day, then
  // the line clears it — the bank account moves on the bank's day, the same
  // as an expense paid before its bank line (moneyOut I2).
  const lineConn = p.line_connection ?? p.bank_connection_id
  const clearsLater = p.method === 'bank' && !!p.bank_transaction_id && !!p.line_day && p.line_day !== p.paid_on
  let from: { role: LedgerAccountRole; sub?: DesiredLine['sub'] }
  switch (p.method) {
    case 'bank':
      from = clearsLater
        ? { role: 'outstanding_checks' }
        : lineConn
          ? { role: 'bank_checking', sub: { kind: 'bank_connection', value: lineConn } }
          : { role: 'bank_checking' }
      break
    case 'card': from = { role: 'credit_card_payable' }; break
    case 'owner_paid': from = { role: 'owner_equity' }; break
    default:
      throw new LedgerSourceError('projector_error', `Loan payment ${paymentId}: unknown method ${p.method}`)
  }
  lines.push(...cr(from.role, principal + interest + escrow, { ...d, ...(from.sub ? { sub: from.sub } : {}), memo: `Loan payment: ${p.loan_name}` }))
  const postings: DesiredPosting[] = [{ owner: { landlordId: p.landlord_id }, intendedDate: p.paid_on, memo: `Loan payment: ${p.loan_name}`, lines }]
  if (clearsLater && lineConn) {
    const total = principal + interest + escrow
    postings.push({
      owner: { landlordId: p.landlord_id }, postingKind: 'bank_clear', intendedDate: p.line_day!, memo: 'The bank paid it',
      lines: [
        ...dr('outstanding_checks', total, { propertyId: p.property_id, memo: 'Cleared by the bank' }),
        ...cr('bank_checking', total, { propertyId: p.property_id, sub: { kind: 'bank_connection', value: lineConn }, memo: `Loan payment: ${p.loan_name}` }),
      ],
    })
  }
  return postings
}

export const loanPaymentProjector: LedgerProjector = {
  sourceType: 'loan_payment',
  ruleVersion: LOANS_ASSETS_RULE_VERSION,
  project: (client, sourceId) => projectLoanPayment(client, sourceId),
  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    // A payment cleared by a later bank line posts again on that day.
    const r = await client.query<{ id: string; day: string }>(
      `SELECT p.id::text AS id, p.paid_on::text AS day FROM books_loan_payments p
         LEFT JOIN bank_transactions bt ON bt.id = p.bank_transaction_id
        WHERE p.landlord_id = $1 AND ($2::date IS NULL OR GREATEST(p.paid_on, COALESCE(bt.posted_date, p.paid_on)) >= $2::date)
        ORDER BY p.paid_on, p.id`, [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

// ─── Fixed assets ────────────────────────────────────────────────────────────

interface AssetRow {
  landlord_id: string | null
  property_id: string | null
  name: string
  asset_class: BooksFixedAssetClass
  cost_c: string
  salvage_c: string
  acquired_on: string
  in_service_date: string
  life_years: string | null
  prior_c: string | null
  source_expense_id: string | null
  source_expense_active: boolean | null
  voided_at: string | null
  books_start: string | null
}

const ASSET_SQL = `
  SELECT a.landlord_id, a.property_id, a.name, a.asset_class, ${cSql('a.cost')} AS cost_c, ${cSql('a.salvage_value')} AS salvage_c,
         a.acquired_on::text AS acquired_on, a.in_service_date::text AS in_service_date, a.life_years::text AS life_years,
         CASE WHEN a.prior_depreciation IS NULL THEN NULL ELSE ${cSql('a.prior_depreciation')} END AS prior_c,
         a.source_expense_id,
         (SELECT e.status = 'active' AND e.voided_at IS NULL FROM landlord_expenses e WHERE e.id = a.source_expense_id) AS source_expense_active,
         a.voided_at::text AS voided_at,
         (SELECT x.books_start_date::text FROM landlords x WHERE x.id = a.landlord_id) AS books_start
    FROM books_fixed_assets a`

/** Bought before the books start, and not made from an expense: its cost opens on the books start date. */
function opensAtStart(a: AssetRow, start: string): boolean {
  return !a.source_expense_id && a.acquired_on < start
}

/**
 * The asset's straight-line months. For an asset that opens at the books
 * start with the owner's own "already taken" figure, the months before the
 * start carry exactly that figure and the rest of the life spreads the rest.
 */
export function assetSchedule(a: Pick<AssetRow, 'asset_class' | 'cost_c' | 'salvage_c' | 'in_service_date' | 'life_years' | 'prior_c' | 'source_expense_id' | 'acquired_on'>,
  start: string): DepreciationMonth[] {
  if (!fixedAssetDepreciates(a.asset_class)) return []
  const lifeMonths = fixedAssetLifeMonths(a.life_years)
  if (!lifeMonths) return []
  const usePrior = a.prior_c != null && !a.source_expense_id && a.acquired_on < start
  return depreciationSchedule({
    costCents: centsOf(a.cost_c), salvageCents: centsOf(a.salvage_c), inServiceDate: a.in_service_date, lifeMonths,
    priorCents: usePrior ? centsOf(a.prior_c) : null, priorAsOf: usePrior ? start : null,
  })
}

/** '<asset>' or '<asset>|YYYY-MM'. */
export function parseFixedAssetKey(sourceId: string): { assetId: string; month: string | null } | null {
  const [assetId, month, extra] = sourceId.split('|')
  if (extra !== undefined || !isUuid(assetId ?? '')) return null
  if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null
  return { assetId, month: month ?? null }
}

export async function projectFixedAsset(client: PoolClient, sourceId: string): Promise<DesiredPosting[]> {
  const key = parseFixedAssetKey(sourceId)
  if (!key) return []
  const a = (await client.query<AssetRow>(`${ASSET_SQL} WHERE a.id = $1`, [key.assetId])).rows[0]
  // A business's assets wait for the business portal's books (a later phase).
  if (!a || !a.landlord_id || a.voided_at) return []
  if (a.source_expense_id && a.source_expense_active === false) return []
  const start = a.books_start
  if (!start) throw needsBooksStart()
  const owner = { landlordId: a.landlord_id }
  const role = BOOKS_FIXED_ASSET_CLASS_ROLE[a.asset_class] as LedgerAccountRole

  let schedule: DepreciationMonth[]
  try {
    schedule = assetSchedule(a, start)
  } catch (e) {
    throw new LedgerSourceError('projector_error', `Fixed asset "${a.name}": ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!key.month) {
    if (!opensAtStart(a, start)) {
      // 10/12 review: an asset made from an expense dated before the books
      // start. Its cost opened on the asset account through the expense (the
      // opening carries the expense's line, tenantOpening J1 a), but its months
      // that ended before the start post nothing (below) — so the depreciation
      // already taken by the start date opens here, on that date, against
      // opening balance equity. Without it the books carried the full cost while
      // the Fixed assets page showed those months as taken.
      const taken = a.source_expense_id ? depreciationBefore(schedule, start) : 0
      if (taken <= 0) return []
      const d = { propertyId: a.property_id, reportCategory: 'opening' as const }
      return [{ owner, intendedDate: start, memo: `Fixed asset ${a.name}: depreciation before the books start`, lines: [
        ...dr('opening_balance_equity', taken, { ...d, memo: `${a.name}: on the books start date` }),
        ...cr('accumulated_depreciation', taken, { ...d, memo: `${a.name}: depreciation taken before the books start` }),
      ] }]
    }
    const cost = centsOf(a.cost_c)
    const taken = a.prior_c != null && fixedAssetDepreciates(a.asset_class) ? centsOf(a.prior_c) : depreciationBefore(schedule, start)
    const d = { propertyId: a.property_id, reportCategory: 'opening' as const }
    const lines: DesiredLine[] = [
      ...dr(role, cost, { ...d, memo: `${a.name}: cost` }),
      ...cr('accumulated_depreciation', taken, { ...d, memo: `${a.name}: depreciation taken before the books start` }),
      ...cr('opening_balance_equity', cost - taken, { ...d, memo: `${a.name}: on the books start date` }),
    ]
    return [{ owner, intendedDate: start, memo: `Fixed asset ${a.name}: opening`, lines }]
  }

  const m = schedule.find(x => x.month === key.month)
  if (!m || m.cents === 0) return []
  // A month that ended before the books start: the opening carries it.
  if (m.endDay < start) return []
  const memo = `Depreciation ${m.month}: ${a.name}`
  const lines: DesiredLine[] = a.property_id
    ? dr('depreciation_expense', m.cents, { propertyId: a.property_id, memo })
    : drSpread('depreciation_expense', m.cents, await companyCostSpread(client, a.landlord_id, m.endDay), { memo })
  lines.push(...cr('accumulated_depreciation', m.cents, { propertyId: a.property_id, memo }))
  return [{ owner, intendedDate: m.endDay, memo, lines }]
}

export const fixedAssetProjector: LedgerProjector = {
  sourceType: 'fixed_asset',
  ruleVersion: LOANS_ASSETS_RULE_VERSION,
  project: (client, sourceId) => projectFixedAsset(client, sourceId),
  /**
   * Each asset's opening (dated the books start) and every month of its life
   * that has ENDED on the company's calendar, from its books start on.
   * Months still running are not sources yet: a month posts once it is over
   * (markDepreciationMonthsDue marks each one as it ends).
   */
  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const today = (await client.query<{ d: string }>(
      `SELECT (now() AT TIME ZONE ${companyTzSql('$1::uuid')})::date::text AS d`, [owner.landlordId])).rows[0].d
    const r = await client.query<AssetRow & { id: string }>(
      `${ASSET_SQL.replace('SELECT a.landlord_id', 'SELECT a.id::text AS id, a.landlord_id')}
        WHERE a.landlord_id = $1
        ORDER BY a.in_service_date, a.id`, [owner.landlordId])
    const out: LedgerSourceRef[] = []
    for (const a of r.rows) {
      const start = a.books_start
      out.push({ id: a.id, day: start ? (a.acquired_on > start ? a.acquired_on : start) : a.acquired_on })
      if (!start) continue
      let schedule: DepreciationMonth[]
      try { schedule = assetSchedule(a, start) } catch { schedule = [] }
      for (const m of schedule) {
        if (m.endDay < start || m.endDay >= today) continue
        if (opts.since && m.endDay < opts.since) continue
        out.push({ id: `${a.id}|${m.month}`, day: m.endDay })
      }
    }
    return out
  },
}

/** Everything loans and fixed assets post, for services/ledgerProjectors.ts. */
export const LOANS_ASSETS_LEDGER_PROJECTORS: readonly LedgerProjector[] = [
  loanProjector,
  loanPaymentProjector,
  fixedAssetProjector,
]
