// 10/12 (Nic) — GAM BOOKS: VENDORS, LOANS AND FIXED ASSETS
//
// gam-ledger-design-2026-10-12 §6 I, J and §12, adapted to Nic's 10/12 answers
// (gam-nic-answers-2026-10-12):
//
//   VENDORS  "one list of everyone the company pays (contractors, the garbage
//            company, the power company) with a type; contractors get a 1099
//            box and their payments add up per calendar year." The separate
//            Contractors list folds into it (each folded row keeps a pointer to
//            the contractor it came from). The Tax Center's 1099 list reads the
//            payments made to vendors with the 1099 box, per calendar year.
//   LOANS    a loan register (lender, property, original amount, rate,
//            payment, escrow part). Each payment splits into principal (owed on
//            the loan goes down), interest (an expense) and escrow (money the
//            lender holds to pay property tax and insurance). A payment can be
//            typed on the Loans page or matched from a bank line.
//   ASSETS   fixed assets with straight-line depreciation (cost, the day it
//            went into service, a life in years the landlord chooses, what it
//            will be worth at the end). One amount is posted each month. An
//            expense filed under a capital-improvement category (one that
//            charges to an asset account) can be turned into an asset.
//
// The routes are apps/api/src/routes/booksLoansAssets.ts; the ledger postings
// are services/ledgerProjectors/loansAssets.ts. Every list below is mirrored
// by a CHECK in migrations 20261014190000-190300 (the API tests hold the two
// together). Displayed values go through the *_LABEL maps, never the raw value.
// This file imports nothing (index.ts re-exports it), so there is no
// load-order cycle.

// ─── Vendors: one list of everyone the company pays ──────────────────────────

/**
 * books_vendors.vendor_type. Nic, 10/12: "contractors, garbage company, power
 * company" — each vendor has a type; only a contractor may carry the 1099 box
 * (books_vendors.is_1099).
 */
export const BOOKS_VENDOR_TYPES = ['contractor', 'utility', 'supplier', 'other'] as const
export type BooksVendorType = typeof BOOKS_VENDOR_TYPES[number]
export const BOOKS_VENDOR_TYPE_LABEL: Record<BooksVendorType, string> = {
  contractor: 'Contractor',
  utility:    'Utility company',
  supplier:   'Supplier',
  other:      'Other',
}
/** The type a vendor must have to carry the 1099 box. */
export const BOOKS_VENDOR_1099_TYPE: BooksVendorType = 'contractor'

/** books_vendors.status. A vendor is never removed: one the company stops using is inactive (its payments stay). */
export const BOOKS_VENDOR_STATUSES = ['active', 'inactive'] as const
export type BooksVendorStatus = typeof BOOKS_VENDOR_STATUSES[number]
export const BOOKS_VENDOR_STATUS_LABEL: Record<BooksVendorStatus, string> = {
  active:   'Active',
  inactive: 'Inactive',
}

/** books_vendors.payment_terms. */
export const BOOKS_VENDOR_PAYMENT_TERMS = ['due_on_receipt', 'net15', 'net30', 'net45', 'net60', 'cod'] as const
export type BooksVendorPaymentTerm = typeof BOOKS_VENDOR_PAYMENT_TERMS[number]
export const BOOKS_VENDOR_PAYMENT_TERM_LABEL: Record<BooksVendorPaymentTerm, string> = {
  due_on_receipt: 'Due on receipt',
  net15:          'Net 15 days',
  net30:          'Net 30 days',
  net45:          'Net 45 days',
  net60:          'Net 60 days',
  cod:            'Cash on delivery',
}

/**
 * The federal tax classification boxes on a payee's Form W-9
 * (books_vendors.tax_classification; books_contractors.entity_type before the
 * fold). An individual or sole proprietor is identified by their Social
 * Security number, every other classification by its EIN. The taxpayer id is
 * optional on a vendor: most utilities and suppliers never give one.
 * (A contractor saved before 10/11 may say 'business'; the folded vendor
 * leaves the classification blank and the contractor row keeps the word.)
 */
export const BOOKS_CONTRACTOR_TAX_CLASSIFICATIONS = ['individual', 'c_corp', 's_corp', 'partnership', 'llc', 'other'] as const
export type BooksContractorTaxClassification = typeof BOOKS_CONTRACTOR_TAX_CLASSIFICATIONS[number]
export const BOOKS_CONTRACTOR_TAX_CLASSIFICATION_LABEL: Record<BooksContractorTaxClassification, string> = {
  individual:  'Individual / sole proprietor',
  c_corp:      'C corporation',
  s_corp:      'S corporation',
  partnership: 'Partnership',
  llc:         'Limited liability company (LLC)',
  other:       'Other',
}
/** The same W-9 list, by the name the Vendors page uses. */
export const BOOKS_W9_TAX_CLASSIFICATIONS = BOOKS_CONTRACTOR_TAX_CLASSIFICATIONS
export type BooksW9TaxClassification = BooksContractorTaxClassification
export const BOOKS_W9_TAX_CLASSIFICATION_LABEL = BOOKS_CONTRACTOR_TAX_CLASSIFICATION_LABEL

/** books_vendors.pay_unit — what a contractor's usual rate is per. */
export const BOOKS_CONTRACTOR_PAY_UNITS = ['project', 'hour', 'day', 'sqft'] as const
export type BooksContractorPayUnit = typeof BOOKS_CONTRACTOR_PAY_UNITS[number]
export const BOOKS_CONTRACTOR_PAY_UNIT_LABEL: Record<BooksContractorPayUnit, string> = {
  project: 'Project',
  hour:    'Hour',
  day:     'Day',
  sqft:    'Square foot',
}

/** An EIN (12-3456789) or a Social Security number (123-45-6789), dashes optional. */
export const BOOKS_TAX_ID_PATTERN = /^\d{2}-?\d{7}$|^\d{3}-?\d{2}-?\d{4}$/

/** The last four digits of a taxpayer id, for showing it without showing it. */
export function taxIdLast4(taxId: string | null | undefined): string | null {
  const digits = String(taxId ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

/**
 * The yearly total at which a payee with the 1099 box needs a Form 1099-NEC,
 * by the calendar year the money was paid. Federal, the same for every
 * company: $600 through 2025; $2,000 for payments made in 2026 (raised by the
 * 2025 federal tax law), adjusted for inflation from 2027.
 *
 * ANNUAL REFRESH: add next year's figure when the IRS announces it. Until it
 * is added, a year past the table uses the latest year known. The Tax Center
 * lists every 1099 payee paid in the year, at or over the line or not.
 */
export const FORM_1099_NEC_THRESHOLD_BY_YEAR: Readonly<Record<number, number>> = {
  2024: 600,
  2025: 600,
  2026: 2000,
}

/** The 1099-NEC threshold for payments made in `year` (dollars). */
export function form1099NecThreshold(year: number): number {
  const known = FORM_1099_NEC_THRESHOLD_BY_YEAR[year]
  if (known !== undefined) return known
  const years = Object.keys(FORM_1099_NEC_THRESHOLD_BY_YEAR).map(Number).sort((a, b) => a - b)
  return year < years[0] ? FORM_1099_NEC_THRESHOLD_BY_YEAR[years[0]] : FORM_1099_NEC_THRESHOLD_BY_YEAR[years[years.length - 1]]
}

/**
 * Payments made by card are not reported on a Form 1099-NEC: the card company
 * reports them (IRS instructions for Forms 1099-MISC and 1099-NEC, "payments
 * made with a credit card or payment card"). The Tax Center adds a 1099
 * vendor's year without them and shows them beside it.
 */
export const FORM_1099_NOT_REPORTED_PAYMENT_METHODS = ['card'] as const

// ─── Loans ───────────────────────────────────────────────────────────────────

/**
 * books_loans.funded_to — for a loan made on or after the books start date,
 * where the money went:
 *   bank       into one of the company's bank accounts
 *   property   straight to the seller of a property the company bought (the
 *              lender paid the seller; Rental property goes up)
 *   equipment  straight to the seller of equipment or a vehicle
 * A loan made before the books start opens instead at what was still owed on
 * the books start date (books_loans.opening_balance), with the escrow the
 * lender held that day (books_loans.opening_escrow).
 */
export const BOOKS_LOAN_FUNDED_TO = ['bank', 'property', 'equipment'] as const
export type BooksLoanFundedTo = typeof BOOKS_LOAN_FUNDED_TO[number]
export const BOOKS_LOAN_FUNDED_TO_LABEL: Record<BooksLoanFundedTo, string> = {
  bank:      'Into a bank account',
  property:  'Straight to the seller of a property you bought',
  equipment: 'Straight to the seller of equipment or a vehicle you bought',
}

/** books_loan_payments.method — where the money for a loan payment came from. */
export const BOOKS_LOAN_PAYMENT_METHODS = ['bank', 'card', 'owner_paid'] as const
export type BooksLoanPaymentMethod = typeof BOOKS_LOAN_PAYMENT_METHODS[number]
export const BOOKS_LOAN_PAYMENT_METHOD_LABEL: Record<BooksLoanPaymentMethod, string> = {
  bank:       'From a bank account',
  card:       'By credit card',
  owner_paid: 'Paid by the owner personally',
}

/**
 * books_loan_payments.source — how the payment was recorded: typed on the
 * Loans page ('entered'), or made from a bank line when the line was filed
 * ('bank_line'; taking that filing back voids it).
 */
export const BOOKS_LOAN_PAYMENT_SOURCES = ['entered', 'bank_line'] as const
export type BooksLoanPaymentSource = typeof BOOKS_LOAN_PAYMENT_SOURCES[number]

/** A loan's state, worked out (never stored): being paid, paid off, or voided. */
export const BOOKS_LOAN_STATES = ['active', 'paid_off', 'voided'] as const
export type BooksLoanState = typeof BOOKS_LOAN_STATES[number]
export const BOOKS_LOAN_STATE_LABEL: Record<BooksLoanState, string> = {
  active:   'Being paid',
  paid_off: 'Paid off',
  voided:   'Voided',
}

/** How many days either side of a bank line a loan payment (or the loan's funding) may sit and still match it. */
export const BOOKS_LOAN_MATCH_WINDOW_DAYS = 7

/** The highest yearly interest rate a loan may carry, in percent. */
export const BOOKS_LOAN_MAX_RATE_PCT = 99.9999

/** One loan payment split three ways, in whole cents. */
export interface LoanPaymentSplit { principalCents: number; interestCents: number; escrowCents: number }

/**
 * The split GAM suggests for a loan payment: the loan's regular escrow part
 * (never more than the payment), a month's interest on what is still owed
 * (yearly rate ÷ 12, never more than what is left), and the rest toward
 * principal. The three parts always add up to the payment. It is a
 * suggestion — the lender's statement decides, and the person changes it
 * before saving; a principal part bigger than what is still owed is refused
 * when it is saved.
 */
export function loanPaymentSuggestion(a: {
  balanceCents: number; annualRatePct: number | string; paymentCents: number; escrowCents: number
}): LoanPaymentSplit {
  const payment = Math.max(0, Math.round(a.paymentCents))
  const escrowCents = Math.min(Math.max(0, Math.round(a.escrowCents)), payment)
  const balance = Math.max(0, Math.round(a.balanceCents))
  const monthly = Math.round((balance * Math.max(0, Number(a.annualRatePct) || 0)) / 1200)
  const interestCents = Math.min(monthly, payment - escrowCents)
  const principalCents = payment - escrowCents - interestCents
  return { principalCents, interestCents, escrowCents }
}

// ─── Fixed assets and depreciation ───────────────────────────────────────────

/**
 * books_fixed_assets.asset_class — what the asset is: which account its cost
 * sits on and whether it wears out (land never depreciates).
 */
export const BOOKS_FIXED_ASSET_CLASSES = ['building', 'improvement', 'equipment', 'vehicle', 'land'] as const
export type BooksFixedAssetClass = typeof BOOKS_FIXED_ASSET_CLASSES[number]
export const BOOKS_FIXED_ASSET_CLASS_LABEL: Record<BooksFixedAssetClass, string> = {
  building:    'Building',
  improvement: 'Improvement to a property',
  equipment:   'Equipment',
  vehicle:     'Vehicle',
  land:        'Land',
}
/**
 * The posting role whose account an asset of each class sits on (the ledger's
 * role names, LEDGER_ACCOUNT_ROLES — spelled out here because this file
 * imports nothing; packages/shared booksVendorsLoans.test.ts holds them to it).
 */
export const BOOKS_FIXED_ASSET_CLASS_ROLE: Record<BooksFixedAssetClass, 'rental_property' | 'equipment'> = {
  building:    'rental_property',
  improvement: 'rental_property',
  equipment:   'equipment',
  vehicle:     'equipment',
  land:        'rental_property',
}
/**
 * books_fixed_assets.funded_by — 10/13 (Nic): "Fixed asset typed by hand: the
 * form ASKS where the money came from (cash on hand / owner put money in /
 * loan / already an expense) and posts to that." Asked of an asset bought on
 * or after the books start (one bought before opens at the books start):
 *   cash     cash on hand — Dr the asset's account / Cr Undeposited funds
 *            (1040, the office drawer, where "Cash from the office" comes from)
 *   owner    the owner put money in — Dr the asset's account / Cr Owner equity
 *            and contributions (3010)
 *   loan     a loan on the Loans page whose money went straight to the seller
 *            (funded_loan_id): the loan's own posting put the cost on the
 *            asset's account, so the asset posts none of its own
 *   expense  already an expense (source_expense_id): "LINK that expense (cost
 *            moves to the asset)" — the expense posts its cost to the asset's
 *            account instead of its category's, counted once
 * Mirrors books_fixed_assets_funded_by_check (migration 20261015190100).
 */
export const BOOKS_FIXED_ASSET_FUNDED_BY = ['cash', 'owner', 'loan', 'expense'] as const
export type BooksFixedAssetFundedBy = typeof BOOKS_FIXED_ASSET_FUNDED_BY[number]
export const BOOKS_FIXED_ASSET_FUNDED_BY_LABEL: Record<BooksFixedAssetFundedBy, string> = {
  cash:    'Cash on hand',
  owner:   'The owner put money in',
  loan:    'A loan',
  expense: 'Already an expense',
}
/**
 * The loans that can have paid for an asset of each posting role: a loan whose
 * money went straight to the seller of a property puts its cost on Rental
 * property, one to the seller of equipment or a vehicle on Equipment
 * (BOOKS_LOAN_FUNDED_TO). A loan whose money went into the bank paid nothing
 * itself — the purchase came out of the bank.
 */
export const BOOKS_LOAN_FUNDED_TO_ASSET_ROLE: Record<BooksLoanFundedTo, 'rental_property' | 'equipment' | null> = {
  bank:      null,
  property:  'rental_property',
  equipment: 'equipment',
}

/** The classes that never depreciate. */
export const BOOKS_FIXED_ASSET_NOT_DEPRECIATED = ['land'] as const satisfies readonly BooksFixedAssetClass[]
export function fixedAssetDepreciates(assetClass: string): boolean {
  return !(BOOKS_FIXED_ASSET_NOT_DEPRECIATED as readonly string[]).includes(assetClass)
}

/**
 * books_fixed_assets.method. Straight line: the cost less what it will be
 * worth at the end, spread evenly over its useful life, a month at a time,
 * starting the month it went into service. (A tax return's own depreciation
 * schedule is the accountant's.)
 */
export const BOOKS_DEPRECIATION_METHODS = ['straight_line'] as const
export type BooksDepreciationMethod = typeof BOOKS_DEPRECIATION_METHODS[number]
export const BOOKS_DEPRECIATION_METHOD_LABEL: Record<BooksDepreciationMethod, string> = {
  straight_line: 'Straight line (the same amount each month)',
}

/** The longest life an asset may be given, in years. */
export const BOOKS_FIXED_ASSET_MAX_LIFE_YEARS = 100

/** An asset's life in whole months (27.5 years → 330), or null when the years are not a whole number of months. */
export function fixedAssetLifeMonths(lifeYears: number | string | null | undefined): number | null {
  const y = Number(lifeYears)
  if (lifeYears == null || !Number.isFinite(y) || y <= 0 || y > BOOKS_FIXED_ASSET_MAX_LIFE_YEARS) return null
  const months = Math.round(y * 12)
  return Math.abs(months - y * 12) < 1e-9 && months >= 1 ? months : null
}

/** One month of an asset's depreciation: posted on the month's last day. */
export interface DepreciationMonth { month: string; endDay: string; cents: number }

function monthEndOf(year: number, month1: number): string {
  const last = new Date(Date.UTC(year, month1, 0)).getUTCDate()
  return `${year}-${String(month1).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

/** `total` cents in `n` equal parts; the first (total mod n) parts carry one cent more. */
function evenCents(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(total / n)
  const extra = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

/**
 * A fixed asset's straight-line schedule: cost less salvage spread evenly over
 * its life, one amount per month, starting the month it was put in service
 * (that month counts in full) and posted on each month's last day. The parts
 * add up to cost − salvage to the cent.
 *
 * `priorCents` / `priorAsOf`: depreciation the owner says was already taken
 * before their books start (`priorAsOf` = that start date). The months that
 * ended before it then carry exactly `priorCents` between them, and the rest
 * of the life spreads what is left — so the books start where the owner's
 * earlier records left off. Throws (plain words) when that cannot be: nothing
 * was in service before the start, more than cost − salvage, or the life ended
 * before the start with something still left.
 */
export function depreciationSchedule(a: {
  costCents: number; salvageCents: number; inServiceDate: string; lifeMonths: number
  priorCents?: number | null; priorAsOf?: string | null
}): DepreciationMonth[] {
  const depreciable = Math.max(0, Math.round(a.costCents) - Math.round(a.salvageCents))
  const n = Math.max(0, Math.round(a.lifeMonths))
  const [y0, m0] = a.inServiceDate.split('-').map(Number)
  const months: { month: string; endDay: string }[] = []
  for (let i = 0; i < n; i++) {
    const idx = (y0 * 12 + (m0 - 1)) + i
    const y = Math.floor(idx / 12)
    const m = (idx % 12) + 1
    months.push({ month: `${y}-${String(m).padStart(2, '0')}`, endDay: monthEndOf(y, m) })
  }
  if (a.priorCents == null) {
    const parts = evenCents(depreciable, n)
    return months.map((m, i) => ({ ...m, cents: parts[i] }))
  }
  const prior = Math.round(a.priorCents)
  const asOf = a.priorAsOf ?? ''
  const pre = months.filter(m => m.endDay < asOf).length
  const post = n - pre
  if (prior < 0) throw new Error('Depreciation already taken cannot be less than $0.')
  if (prior > depreciable) throw new Error('Depreciation already taken cannot be more than the cost less the salvage value.')
  if (pre === 0 && prior > 0) throw new Error('No depreciation was taken before your books start: the asset went into service after it.')
  if (post === 0 && prior !== depreciable) {
    throw new Error('This asset\'s life ended before your books start, so the depreciation already taken is all of it (the cost less the salvage value).')
  }
  const preParts = evenCents(prior, pre)
  const postParts = evenCents(depreciable - prior, post)
  return months.map((m, i) => ({ ...m, cents: i < pre ? preParts[i] : postParts[i - pre] }))
}

/** Depreciation through `day` (every month that ended on or before it), in cents. */
export function depreciationThrough(schedule: readonly DepreciationMonth[], day: string): number {
  return schedule.reduce((s, m) => (m.endDay <= day ? s + m.cents : s), 0)
}

/** Depreciation of the months that ended before `day` (the books start: what opens as already taken), in cents. */
export function depreciationBefore(schedule: readonly DepreciationMonth[], day: string): number {
  return schedule.reduce((s, m) => (m.endDay < day ? s + m.cents : s), 0)
}
