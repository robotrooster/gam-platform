/**
 * 10/12 (Nic) — GAM BOOKS: VENDORS, LOANS AND FIXED ASSETS (the routes)
 *
 *   VENDORS  "one list of everyone the company pays (contractors, garbage
 *            company, power company) with a type; contractors get a 1099 box
 *            and their payments add up per calendar year." The Contractors
 *            (1099) page and its routes are gone: a contractor is a vendor of
 *            type contractor (the old contractors were folded in, migration
 *            20261014190000).
 *              GET   /vendors            the list, with what each was paid this year and is owed
 *              POST  /vendors            add one
 *              PATCH /vendors/:id        change one (inactive, never removed)
 *              GET   /vendors/1099       the 1099 list for a calendar year (the Tax Center)
 *   LOANS    a loan register; each payment split into principal / interest /
 *            escrow; a payment typed here or matched from a bank line.
 *              GET   /loans, /loans/:id, /loans/form-options, /loans/:id/suggest
 *              POST  /loans, /loans/:id/void, /loans/:id/payments, /loans/:id/payments/:paymentId/void
 *              PATCH /loans/:id
 *   ASSETS   fixed assets with straight-line depreciation, a life the landlord
 *            chooses; an expense filed under a capital-improvement category can
 *            become one. 10/13 (Nic): one typed in by hand ASKS where its
 *            money came from (cash on hand / owner put money in / loan /
 *            already an expense) and posts to that; "already an expense"
 *            LINKS the expense and its cost moves to the asset.
 *              GET   /fixed-assets, /fixed-assets/capital-expenses, /fixed-assets/linkable-expenses
 *              POST  /fixed-assets, /fixed-assets/from-expense/:expenseId, /fixed-assets/:id/void
 *              PATCH /fixed-assets/:id
 *            10/13 (Nic): "Funding: ALLOW A MIX (several funding lines adding
 *            up to the cost; a loan may spread over several assets)" —
 *            `funding: [{ kind, amount, loanId?, expenseId? }]`, its lines
 *            adding up to the cost (books_fixed_asset_funding).
 *   WHERE A COST GOES  10/13 (Nic): "each expense is chosen on the split or
 *            specific unit or property at the time of logging. there should
 *            never be a default setting to apply expenses." A loan (each
 *            payment's interest) and a fixed asset (each month's depreciation)
 *            say where they go when they are logged — costPlace
 *            ('split_by_units' | 'property' | 'unit') with propertyId / unitId
 *            (services/booksVendorsLoans resolveCostPlace); nothing saves
 *            without it.
 *              GET   /cost-places        the company's properties and their units, for those forms
 *
 * These are GAM Books routes: they hang on booksRouter (routes/books.ts calls
 * registerBooksLoansAssetsRoutes after its own sign-in and company checks), so
 * a bookkeeper reaches them with the company-wide box or the whole-company
 * ledger box (BOOKS_LEDGER), the owner and an admin always, read-only access
 * reads. Nothing here moves money: each is a RECORD on the company's books,
 * posted to the ledger within the minute.
 */
import type { Router, Request } from 'express'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import {
  BOOKS_VENDOR_TYPES, BOOKS_VENDOR_STATUSES, BOOKS_VENDOR_PAYMENT_TERMS, BOOKS_W9_TAX_CLASSIFICATIONS,
  BOOKS_CONTRACTOR_PAY_UNITS, BOOKS_TAX_ID_PATTERN, BOOKS_VENDOR_1099_TYPE,
  BOOKS_LOAN_FUNDED_TO, BOOKS_LOAN_PAYMENT_METHODS, BOOKS_FIXED_ASSET_CLASSES, BOOKS_DEPRECIATION_METHODS,
  BOOKS_FIXED_ASSET_MAX_LIFE_YEARS, fixedAssetLifeMonths, fixedAssetDepreciates, depreciationSchedule,
  BOOKS_FIXED_ASSET_FUNDED_BY, BOOKS_FIXED_ASSET_CLASS_ROLE, BOOKS_LOAN_FUNDED_TO_ASSET_ROLE, BOOKS_COST_PLACES,
  type BooksFixedAssetClass, type BooksFixedAssetFundedBy, type BooksLoanFundedTo, type BooksCostPlace,
} from '@gam/shared'
import { db } from '../db'
import { requireBooksRead, requireBooksWrite } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { isDisposableEmail } from '../lib/email'
import { currentLedgerXid, kickLedgerAfterCommit } from '../services/ledgerEngine'
import {
  listVendors, vendor1099List, VENDOR_COLUMNS, vendorOut, vendorYearTotals, vendorOwed,
  loanFigures, LOAN_COLUMNS, suggestLoanSplit, assertPrincipalFits,
  ASSET_COLUMNS, assetFigures, companyToday, capitalExpense, capitalExpenses, linkableExpense, linkableExpenses,
  resolveCostPlace, costPlaceOptions, type BooksOwner, type CostPlaceChoice,
} from '../services/booksVendorsLoans'

/** What routes/books.ts lends these routes: the company a request names. */
export interface BooksLoansAssetsDeps {
  ownerScope: (user: any) => { col: 'landlord_id' | 'business_id'; id: string | null }
}

// ─── Reading a form ──────────────────────────────────────────────────────────

/** A form's empty box is "not given" (forms send ''). */
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
const optText = (max: number, what: string) =>
  z.preprocess(blank, z.string().trim().max(max, `${what} is ${max} characters at most.`).optional())
const nullableText = (max: number, what: string) =>
  z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max, `${what} is ${max} characters at most.`).nullable().optional())
const isoDay = (what: string) => z.string({ required_error: `Enter ${what}.`, invalid_type_error: `Enter ${what}.` })
  .regex(/^\d{4}-\d{2}-\d{2}$/, `Enter ${what} as a date.`)
  .refine(d => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d, `Enter ${what} as a real date.`)
/** Dollars and cents, as a number or a numeric string, never more than two decimals. */
const money = (what: string, opts: { min?: number; positive?: boolean } = {}) =>
  z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number({ required_error: `Enter ${what}.`, invalid_type_error: `Enter ${what} as an amount.` })
      .finite(`Enter ${what} as an amount.`)
      .refine(n => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, `${what[0].toUpperCase()}${what.slice(1)} is dollars and cents.`)
      .refine(n => (opts.positive ? n > 0 : n >= (opts.min ?? 0)), opts.positive ? `${what[0].toUpperCase()}${what.slice(1)} must be more than $0.` : `${what[0].toUpperCase()}${what.slice(1)} cannot be less than $0.`)
      .refine(n => n < 10_000_000_000, `${what[0].toUpperCase()}${what.slice(1)} is too large.`))
const uuid = (what: string) => z.string().regex(/^[0-9a-f-]{36}$/i, `Choose ${what}.`)
const optUuid = (what: string) => z.preprocess(v => (v === '' ? null : v), uuid(what).nullable().optional())
/** 10/13 (Nic): where a cost goes — split across the properties by units, one property, or one unit. */
const costPlace = z.preprocess(v => (v === '' ? null : v), z.enum(BOOKS_COST_PLACES, {
  errorMap: () => ({ message: 'Choose where it goes: one unit, one property, or split across your properties by units.' }),
}).nullable().optional())

function parse<T>(schema: z.ZodType<T, any, any>, body: unknown): T {
  const r = schema.safeParse(body ?? {})
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message || 'Check the form and try again.')
  return r.data
}

const cents = (n: number) => Math.round(n * 100)

// ─── Shared checks ───────────────────────────────────────────────────────────

/** The company a request names; an admin must name one to change anything (these pages are one company's books). */
function companyOf(deps: BooksLoansAssetsDeps, req: Request): BooksOwner {
  const { col, id } = deps.ownerScope(req.user)
  if (!id) throw new AppError(400, 'Choose a company first.')
  return { col, id }
}
/** The company a read names, or null for an admin with none (who reads an empty list, never every company's). */
function companyOrNone(deps: BooksLoansAssetsDeps, req: Request): BooksOwner | null {
  const { col, id } = deps.ownerScope(req.user)
  return id ? { col, id } : null
}

/** A property, vendor or bank account a form names must be the company's own. */
async function assertOwned(q: Pick<PoolClient, 'query'>, owner: BooksOwner, ids: { propertyId?: string | null; vendorId?: string | null; bankConnectionId?: string | null }) {
  if (ids.propertyId) {
    if (owner.col !== 'landlord_id') throw new AppError(400, 'A business\'s books have no properties.')
    const r = await q.query(`SELECT 1 FROM properties WHERE id = $1 AND landlord_id = $2`, [ids.propertyId, owner.id])
    if (!r.rows[0]) throw new AppError(404, 'That property is not this company\'s.')
  }
  if (ids.vendorId) {
    const r = await q.query(`SELECT 1 FROM books_vendors WHERE id = $1 AND ${owner.col} = $2`, [ids.vendorId, owner.id])
    if (!r.rows[0]) throw new AppError(404, 'That vendor is not this company\'s.')
  }
  if (ids.bankConnectionId) {
    if (owner.col !== 'landlord_id') throw new AppError(400, 'A business\'s books have no linked bank accounts.')
    const r = await q.query(`SELECT 1 FROM bank_connections WHERE id = $1 AND landlord_id = $2`, [ids.bankConnectionId, owner.id])
    if (!r.rows[0]) throw new AppError(404, 'That bank account is not this company\'s.')
  }
}

/** Runs `fn` in a transaction; a ledger write kicks the books right after it commits. */
async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    const xid = await currentLedgerXid(client)
    // 10/13: the funding rules are checked at commit (deferred) — said in words.
    await client.query('COMMIT').catch(dbRefusal)
    void kickLedgerAfterCommit(xid)
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** A database refusal (a CHECK or a guard trigger) in the words it was raised with. */
function dbRefusal(e: any): never {
  if (e?.code === '23514' || e?.code === 'P0001') throw new AppError(409, String(e.message || 'That change is not allowed.'))
  if (e?.code === '23505') throw new AppError(409, 'That is already recorded.')
  throw e
}

const thisYear = async (owner: BooksOwner) => Number((await companyToday(db, owner.col === 'landlord_id' ? owner.id : null)).slice(0, 4))

// ─── Vendors ─────────────────────────────────────────────────────────────────

const VENDOR_TYPE_REFUSAL = 'Choose what kind of vendor this is: contractor, utility company, supplier or other.'
const vendorFields = {
  vendorType:        z.enum(BOOKS_VENDOR_TYPES, { errorMap: () => ({ message: VENDOR_TYPE_REFUSAL }) }),
  name:              z.string({ required_error: 'Enter the vendor\'s name.' }).trim().min(1, 'Enter the vendor\'s name.').max(200, 'A vendor name is 200 characters at most.'),
  contactName:       z.string({ required_error: 'Enter who you deal with there.' }).trim().min(1, 'Enter who you deal with there.').max(200, 'A contact name is 200 characters at most.'),
  email:             z.string({ required_error: 'Enter the vendor\'s email.' }).trim().email('Enter a real email address.').max(200, 'An email is 200 characters at most.'),
  phone:             z.string({ required_error: 'Enter the vendor\'s phone number.' }).trim().min(7, 'Enter the vendor\'s phone number.').max(20, 'A phone number is 20 characters at most.'),
  address:           z.string({ required_error: 'Enter the vendor\'s address.' }).trim().min(1, 'Enter the vendor\'s address.').max(500, 'An address is 500 characters at most.'),
  category:          optText(100, 'What they do'),
  paymentTerms:      z.preprocess(blank, z.enum(BOOKS_VENDOR_PAYMENT_TERMS, { errorMap: () => ({ message: 'Choose the vendor\'s payment terms.' }) }).optional()),
  accountNumber:     optText(100, 'An account number'),
  taxId:             z.preprocess(blank, z.string().trim().regex(BOOKS_TAX_ID_PATTERN, 'A taxpayer ID is an EIN (12-3456789) or a Social Security number (123-45-6789).').optional()),
  notes:             optText(2000, 'Notes'),
  is1099:            z.boolean().optional(),
  taxClassification: z.preprocess(blank, z.enum(BOOKS_W9_TAX_CLASSIFICATIONS, { errorMap: () => ({ message: 'Choose the box ticked on their W-9.' }) }).nullable().optional()),
  w9OnFile:          z.boolean().optional(),
  trade:             optText(100, 'A trade'),
  payRate:           z.preprocess(blank, money('the usual rate', { positive: true }).optional()),
  payUnit:           z.preprocess(blank, z.enum(BOOKS_CONTRACTOR_PAY_UNITS, { errorMap: () => ({ message: 'Choose what the rate is per.' }) }).optional()),
}
const vendorCreateSchema = z.object(vendorFields)
const vendorPatchSchema = z.object({
  ...Object.fromEntries(Object.entries(vendorFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
  // Clearing a box on edit: '' is "remove it".
  category:          nullableText(100, 'What they do'),
  accountNumber:     nullableText(100, 'An account number'),
  notes:             nullableText(2000, 'Notes'),
  trade:             nullableText(100, 'A trade'),
  status:            z.enum(BOOKS_VENDOR_STATUSES, { errorMap: () => ({ message: 'A vendor is active or inactive.' }) }).optional(),
}) as z.ZodType<Partial<z.infer<typeof vendorCreateSchema>> & { status?: string; category?: string | null; accountNumber?: string | null; notes?: string | null; trade?: string | null }>

/** The 1099 box and the W-9 details only belong on a contractor. */
function contractorOnly(type: string, v: { is1099?: boolean }) {
  if (v.is1099 && type !== BOOKS_VENDOR_1099_TYPE) {
    throw new AppError(400, 'Only a contractor gets the 1099 box. Make this vendor a contractor first.')
  }
}

/**
 * A Social Security number is kept as its last four digits only (what the
 * Contractors page kept); an EIN in full, as 12-3456789. Nine digits with no
 * dashes are an SSN for an individual / sole proprietor and an EIN otherwise.
 */
function splitTaxId(taxId: string | undefined, classification: string | null | undefined): { taxId: string | null; ssnLast4: string | null } {
  if (!taxId) return { taxId: null, ssnLast4: null }
  const t = taxId.trim()
  const digits = t.replace(/\D/g, '')
  const ein = /^\d{2}-\d{7}$/.test(t) || (/^\d{9}$/.test(t) && classification != null && classification !== 'individual')
  return ein ? { taxId: `${digits.slice(0, 2)}-${digits.slice(2)}`, ssnLast4: null } : { taxId: null, ssnLast4: digits.slice(-4) }
}

// ─── Loans ───────────────────────────────────────────────────────────────────

const loanFields = {
  name:                   z.string({ required_error: 'Name the loan (for example "Oak Street mortgage").' }).trim().min(1, 'Name the loan (for example "Oak Street mortgage").').max(120, 'A loan name is 120 characters at most.'),
  lenderName:             z.string({ required_error: 'Enter the lender.' }).trim().min(1, 'Enter the lender.').max(200, 'A lender name is 200 characters at most.'),
  propertyId:             optUuid('the property'),
  // 10/13 (Nic): where each payment's interest goes, picked when the loan is logged.
  costPlace,
  unitId:                 optUuid('the unit'),
  vendorId:               optUuid('the lender from your vendors'),
  originalAmount:         money('the amount borrowed', { positive: true }),
  annualRate:             z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
                            z.number({ required_error: 'Enter the yearly interest rate.', invalid_type_error: 'Enter the yearly interest rate.' })
                              .min(0, 'The interest rate cannot be below 0%.').lt(100, 'The interest rate is a yearly percent below 100.')),
  startDate:              isoDay('the day the loan was made'),
  termMonths:             z.preprocess(v => (v === '' || v == null ? null : Number(v)),
                            z.number().int('The term is a whole number of months.').min(1, 'The term is at least one month.').max(600, 'The term is 50 years at most.').nullable().optional()),
  paymentAmount:          z.preprocess(v => (v === '' ? null : v), money('the regular payment', { positive: true }).nullable().optional()),
  escrowAmount:           z.preprocess(v => (v === '' || v == null ? 0 : v), money('the escrow part of each payment')),
  paymentDay:             z.preprocess(v => (v === '' || v == null ? null : Number(v)),
                            z.number().int().min(1, 'The payment day is 1 to 31.').max(31, 'The payment day is 1 to 31.').nullable().optional()),
  fundedTo:               z.preprocess(v => (v === '' ? null : v), z.enum(BOOKS_LOAN_FUNDED_TO, { errorMap: () => ({ message: 'Say where the loan money went.' }) }).nullable().optional()),
  fundedBankConnectionId: optUuid('the bank account the money went into'),
  openingBalance:         z.preprocess(v => (v === '' ? null : v), money('what was still owed on your books start date').nullable().optional()),
  openingEscrow:          z.preprocess(v => (v === '' ? null : v), money('the escrow the lender held on your books start date').nullable().optional()),
  notes:                  nullableText(2000, 'Notes'),
}
const loanCreateSchema = z.object(loanFields)
const loanPatchSchema = z.object(Object.fromEntries(Object.entries(loanFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]))) as
  z.ZodType<Partial<z.infer<typeof loanCreateSchema>>>

const voidSchema = z.object({
  reason: z.string({ required_error: 'Say why it is being voided.' }).trim().min(3, 'Say why it is being voided.').max(500, 'A reason is 500 characters at most.'),
})

const loanPaymentSchema = z.object({
  paidOn:           isoDay('the day it was paid'),
  amount:           money('the payment', { positive: true }),
  principal:        money('the principal part'),
  interest:         money('the interest part'),
  escrow:           money('the escrow part'),
  method:           z.enum(BOOKS_LOAN_PAYMENT_METHODS, { errorMap: () => ({ message: 'Say where the money came from.' }) }),
  bankConnectionId: optUuid('the bank account it was paid from'),
  memo:             optText(500, 'A memo'),
})

/** The loan's figures and the rest a page shows, one loan. */
async function loanOut(q: Pick<PoolClient, 'query'>, row: Record<string, any>) {
  const f = (await loanFigures(q, [row as any])).get(row.id)!
  return { ...row, ...f }
}

/** Where the loan's money went, and what it was owed at the books start, fit the books start date. */
function loanOpeningRules(v: { startDate: string; fundedTo?: string | null; fundedBankConnectionId?: string | null; openingBalance?: number | null; openingEscrow?: number | null }, booksStart: string | null) {
  if (v.fundedBankConnectionId && v.fundedTo !== 'bank') throw new AppError(400, 'A bank account is only for a loan whose money went into the bank.')
  if (!booksStart) return
  if (v.startDate < booksStart) {
    if (v.openingBalance == null) {
      throw new AppError(400, `This loan was made before your books start (${booksStart}). Enter what was still owed on it that day, from the lender's statement.`)
    }
  } else if (!v.fundedTo) {
    throw new AppError(400, 'Say where the money from this loan went: into a bank account, or straight to the seller of what you bought.')
  }
}

// ─── Fixed assets ────────────────────────────────────────────────────────────

const ASSET_CLASS_REFUSAL = 'Choose what the asset is: a building, an improvement to a property, equipment, a vehicle or land.'
const FUNDED_BY_REFUSAL = 'Say where the money for it came from: cash on hand, the owner put money in, a loan, or already an expense.'
/** 10/13 (Nic): one line of "where the money came from" (BooksFixedAssetFundingLine). */
const fundingLineSchema = z.object({
  kind:      z.enum(BOOKS_FIXED_ASSET_FUNDED_BY, { errorMap: () => ({ message: FUNDED_BY_REFUSAL }) }),
  amount:    money('each amount', { positive: true }),
  loanId:    optUuid('the loan'),
  expenseId: optUuid('the expense'),
})
type FundingLine = z.infer<typeof fundingLineSchema>
/** 10/13 (Nic): what an asset's depreciation is called in "Choose where … goes". */
const ASSET_PLACE_WHAT = 'this asset and its depreciation'
const lifeYears = z.preprocess(v => (v === '' || v == null ? null : Number(v)),
  z.number({ invalid_type_error: 'Enter the life in years.' })
    .gt(0, 'The life is more than 0 years.').max(BOOKS_FIXED_ASSET_MAX_LIFE_YEARS, `The life is ${BOOKS_FIXED_ASSET_MAX_LIFE_YEARS} years at most.`)
    .refine(y => fixedAssetLifeMonths(y) != null, 'The life must be a whole number of months (27.5 years is fine; 27.3 is not).')
    .nullable().optional())
const assetFields = {
  name:              z.string({ required_error: 'Name the asset.' }).trim().min(1, 'Name the asset.').max(120, 'An asset name is 120 characters at most.'),
  propertyId:        optUuid('the property'),
  assetClass:        z.enum(BOOKS_FIXED_ASSET_CLASSES, { errorMap: () => ({ message: ASSET_CLASS_REFUSAL }) }),
  cost:              money('the cost', { positive: true }),
  salvageValue:      z.preprocess(v => (v === '' || v == null ? 0 : v), money('what it will be worth at the end')),
  acquiredOn:        isoDay('the day it was bought'),
  inServiceDate:     z.preprocess(blank, isoDay('the day it went into service').optional()),
  lifeYears,
  method:            z.preprocess(v => (v == null || v === '' ? 'straight_line' : v), z.enum(BOOKS_DEPRECIATION_METHODS, { errorMap: () => ({ message: 'Depreciation is straight line.' }) })),
  priorDepreciation: z.preprocess(v => (v === '' ? null : v), money('the depreciation already taken').nullable().optional()),
  notes:             nullableText(2000, 'Notes'),
  // 10/13 (Nic): "the form ASKS where the money came from".
  fundedBy:          z.preprocess(blank, z.enum(BOOKS_FIXED_ASSET_FUNDED_BY, { errorMap: () => ({ message: FUNDED_BY_REFUSAL }) }).optional()),
  fundedLoanId:      optUuid('the loan that paid for it'),
  // 10/13 (Nic): "ALLOW A MIX" — several lines adding up to the cost.
  funding:           z.array(fundingLineSchema, { invalid_type_error: FUNDED_BY_REFUSAL }).max(20, 'Twenty funding lines at most.').optional(),
  // 10/13 (Nic): where each month's depreciation goes, picked when the asset is logged.
  costPlace,
  unitId:            optUuid('the unit'),
}
const assetCreateSchema = z.object({
  ...assetFields,
  // "Already an expense": the expense it was; its cost, day and property are the asset's.
  expenseId:         optUuid('the expense it was'),
  // Given with an expense, these come from the expense.
  cost:              z.preprocess(blank, assetFields.cost.optional()),
  acquiredOn:        z.preprocess(blank, assetFields.acquiredOn.optional()),
})
const assetPatchSchema = z.object(Object.fromEntries(Object.entries(assetFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]))) as
  z.ZodType<Partial<z.infer<typeof assetCreateSchema>>>
const fromExpenseSchema = z.object({
  name:          optText(120, 'An asset name'),
  assetClass:    assetFields.assetClass,
  salvageValue:  assetFields.salvageValue,
  inServiceDate: assetFields.inServiceDate,
  lifeYears,
  notes:         optText(2000, 'Notes'),
  // 10/13 (Nic): where its depreciation goes, picked now.
  costPlace,
  unitId:        assetFields.unitId,
})

/** The asset rules the form and the database share, said in plain words before the database says them. */
function assetRules(v: { assetClass: string; cost: number; salvageValue: number; acquiredOn: string; inServiceDate: string; lifeYears?: number | null; priorDepreciation?: number | null },
  booksStart: string | null, fromExpense: boolean) {
  if (v.salvageValue > v.cost) throw new AppError(400, 'What it will be worth at the end cannot be more than it cost.')
  if (v.inServiceDate < v.acquiredOn) throw new AppError(400, 'It cannot go into service before it was bought.')
  const wears = fixedAssetDepreciates(v.assetClass)
  if (!wears && v.lifeYears != null) throw new AppError(400, 'Land never wears out, so it has no life in years.')
  if (wears && v.lifeYears == null) throw new AppError(400, 'Enter the life in years you are spreading its cost over (your accountant can tell you which to use).')
  if (v.priorDepreciation != null) {
    if (fromExpense) throw new AppError(400, 'An asset made from an expense has no depreciation from before your books start.')
    if (!wears) throw new AppError(400, 'Land never wears out, so it has no depreciation.')
    if (!booksStart || v.acquiredOn >= booksStart) {
      throw new AppError(400, 'Depreciation already taken is only for an asset you owned before your books start.')
    }
    try {
      depreciationSchedule({ costCents: cents(v.cost), salvageCents: cents(v.salvageValue), inServiceDate: v.inServiceDate,
        lifeMonths: fixedAssetLifeMonths(v.lifeYears)!, priorCents: cents(v.priorDepreciation), priorAsOf: booksStart })
    } catch (e) {
      throw new AppError(400, e instanceof Error ? e.message : 'That depreciation already taken does not fit this asset.')
    }
  }
}

async function booksStartOf(q: Pick<PoolClient, 'query'>, owner: BooksOwner): Promise<string | null> {
  if (owner.col !== 'landlord_id') return null
  const r = await q.query<{ d: string | null }>(`SELECT books_start_date::text AS d FROM landlords WHERE id = $1`, [owner.id])
  return r.rows[0]?.d ?? null
}

/**
 * 10/13 (Nic): "the form ASKS where the money came from (cash on hand / owner
 * put money in / loan / already an expense) and posts to that" — for an asset
 * bought on or after the books start (one bought before opens at the books
 * start; with no start date yet, it is asked). A loan must be the company's,
 * live, and one whose money went straight to the seller of what this asset is
 * (its posting put the cost on this asset's account). Returns what to store.
 *
 * 10/13 review: and the loan and the asset sit on the same side of the books
 * start. A loan made before it opens at what was still owed that day, against
 * Opening balance equity — its money never put an asset bought on or after the
 * start on the books, so that asset would depreciate a cost the books never
 * had. A loan made on or after it posts the cost that day, while an asset
 * bought before the start opens with its own cost — twice. The database holds
 * the same rule when the loan's day or the books start moves
 * (books_loans_asset_guard, books_start_asset_loan_guard).
 */
async function assetFunding(q: Pick<PoolClient, 'query'>, owner: BooksOwner, v: {
  fundedBy?: BooksFixedAssetFundedBy | null; fundedLoanId?: string | null; assetClass: BooksFixedAssetClass; acquiredOn: string
}, booksStart: string | null): Promise<{ fundedBy: BooksFixedAssetFundedBy | null; fundedLoanId: string | null }> {
  if (v.fundedBy === 'expense') {
    throw new AppError(400, 'An asset that was already an expense is added from that expense: choose "Already an expense" when you add it.')
  }
  if (v.fundedLoanId && v.fundedBy !== 'loan') throw new AppError(400, 'A loan is only for an asset a loan paid for.')
  const asked = owner.col === 'landlord_id' && (!booksStart || v.acquiredOn >= booksStart)
  if (!v.fundedBy) {
    if (asked) throw new AppError(400, FUNDED_BY_REFUSAL)
    return { fundedBy: null, fundedLoanId: null }
  }
  if (v.fundedBy !== 'loan') return { fundedBy: v.fundedBy, fundedLoanId: null }
  if (!v.fundedLoanId) throw new AppError(400, 'Choose the loan that paid for it (add it on the Loans page first).')
  // 10/13 review: locked, so two assets saved at the same moment cannot each
  // spread the same loan's remainder (the second waits, then reads the first's
  // lines — assetFundingLines, and the commit check books_loan_funding_problem).
  const loan = (await q.query<{ name: string; funded_to: BooksLoanFundedTo | null; voided_at: string | null; start_date: string }>(
    `SELECT name, funded_to, voided_at::text AS voided_at, start_date::text AS start_date FROM books_loans WHERE id = $1 AND ${owner.col} = $2
        FOR UPDATE`,
    [v.fundedLoanId, owner.id])).rows[0]
  if (!loan) throw new AppError(404, 'That loan is not this company\'s.')
  if (loan.voided_at) throw new AppError(409, 'That loan was voided.')
  const role = loan.funded_to ? BOOKS_LOAN_FUNDED_TO_ASSET_ROLE[loan.funded_to] : null
  if (!role) {
    throw new AppError(409, `The money from "${loan.name}" went into your bank account, so the purchase was paid from the bank. ` +
      'File that bank payment as an expense, then add the asset as "Already an expense".')
  }
  if (role !== BOOKS_FIXED_ASSET_CLASS_ROLE[v.assetClass]) {
    throw new AppError(409, role === 'equipment'
      ? `"${loan.name}" paid the seller of equipment or a vehicle; this asset is not equipment or a vehicle.`
      : `"${loan.name}" paid the seller of a property; this asset is equipment or a vehicle.`)
  }
  if (booksStart && (loan.start_date < booksStart) !== (v.acquiredOn < booksStart)) {
    throw new AppError(409, loan.start_date < booksStart
      ? `"${loan.name}" was made on ${loan.start_date}, before your books start (${booksStart}), so your books open with what was still owed on it ` +
        'and its money never put this asset\'s cost on them. If it paid for this asset, the asset was bought before your books start too: ' +
        'enter the day the loan paid the seller.'
      : `"${loan.name}" was made on ${loan.start_date}, on or after your books start (${booksStart}), and put this asset's cost on your books that day. ` +
        'An asset bought before your books start opens with its own cost too, so it would count twice: check the day you bought it.')
  }
  return { fundedBy: 'loan', fundedLoanId: v.fundedLoanId }
}

/**
 * 10/13 (Nic): where an asset made from an expense (or "already an expense",
 * said once) goes. It sits where the expense was filed, so its depreciation
 * goes to that property or one of its units — or, for an expense on no
 * property, split across the properties by units. Picked on the form, never
 * taken for granted.
 */
async function expenseAssetPlace(q: Pick<PoolClient, 'query'>, owner: BooksOwner, expensePropertyId: string | null,
  v: { costPlace?: BooksCostPlace | null; unitId?: string | null }): Promise<CostPlaceChoice> {
  if (!v.costPlace && !v.unitId) {
    throw new AppError(400, `Choose where ${ASSET_PLACE_WHAT} goes: ${expensePropertyId ? 'the property the expense was filed on, or one of its units' : 'split across your properties by units'}.`)
  }
  const place = await resolveCostPlace(q, owner, {
    costPlace: v.costPlace ?? null, unitId: v.unitId ?? null,
    propertyId: v.costPlace === 'split_by_units' || v.unitId ? null : expensePropertyId,
  }, ASSET_PLACE_WHAT)
  if ((place.propertyId ?? null) !== (expensePropertyId ?? null)) {
    throw new AppError(409, expensePropertyId
      ? 'This asset sits where its expense was filed, so its depreciation goes to that property or one of its units.'
      : 'Its expense was split across your properties, so its depreciation is split across them by units too.')
  }
  return place
}

/**
 * 10/13 (Nic): "Funding: ALLOW A MIX (several funding lines adding up to the
 * cost; a loan may spread over several assets)." Checks each line of where an
 * asset bought on or after the books start got its money, in the words the
 * person reads (the database holds the same rules at commit,
 * books_fixed_asset_funding_problem): the lines add up to the cost; a loan is
 * the company's, live, one whose money went straight to the seller of what
 * this asset is, made on or after the books start, and never spread past what
 * it lent (`assetId`: the asset being changed, whose own lines are already
 * replaced); an expense is a purchase that is no asset yet, counted whole,
 * once, filed where the asset goes (`place`: 10/13 review — the expense posts
 * its part of the cost to the asset's account on its own property, so an
 * asset at Oak Park is never part-paid by an expense filed at Mountain View).
 * An asset owned before the books start is not asked.
 */
async function assetFundingLines(q: Pick<PoolClient, 'query'>, owner: BooksOwner, lines: FundingLine[], v: {
  assetClass: BooksFixedAssetClass; acquiredOn: string; cost: number
}, booksStart: string | null, assetId: string | null, place: CostPlaceChoice): Promise<FundingLine[]> {
  if (owner.col !== 'landlord_id') throw new AppError(400, 'A business\'s books do not say where an asset\'s money came from yet.')
  if (booksStart && v.acquiredOn < booksStart) {
    throw new AppError(400, `You owned this before your books start (${booksStart}), so it opens on them at its cost; where its money came from is not asked.`)
  }
  if (!lines.length) throw new AppError(400, FUNDED_BY_REFUSAL)
  const total = lines.reduce((t, l) => t + cents(l.amount), 0)
  if (total !== cents(v.cost)) {
    throw new AppError(400, `Where the money came from adds up to $${(total / 100).toFixed(2)}, and it cost $${(cents(v.cost) / 100).toFixed(2)}. The amounts must add up to what it cost.`)
  }
  const out: FundingLine[] = []
  const perLoan = new Map<string, number>()
  const expenses = new Set<string>()
  for (const l of lines) {
    if (l.kind !== 'loan' && l.loanId) throw new AppError(400, 'A loan is only for the part a loan paid for.')
    if (l.kind !== 'expense' && l.expenseId) throw new AppError(400, 'An expense is only for the part that was already an expense.')
    if (l.kind === 'loan') {
      if (!l.loanId) throw new AppError(400, 'Choose the loan that paid for that part (add it on the Loans page first).')
      // The same checks as a loan said once for the whole cost.
      await assetFunding(q, owner, { fundedBy: 'loan', fundedLoanId: l.loanId, assetClass: v.assetClass, acquiredOn: v.acquiredOn }, booksStart)
      perLoan.set(l.loanId, (perLoan.get(l.loanId) ?? 0) + cents(l.amount))
    } else if (l.kind === 'expense') {
      if (!l.expenseId) throw new AppError(400, 'Choose the expense that part already was.')
      if (expenses.has(l.expenseId)) throw new AppError(400, 'Each expense is named once.')
      expenses.add(l.expenseId)
      await q.query(`SELECT 1 FROM landlord_expenses WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [l.expenseId, owner.id])
      const e = await linkableExpense(q, owner.id, l.expenseId)
      if (cents(Number(e.amount)) !== cents(l.amount)) {
        throw new AppError(400, `An expense counts toward an asset whole: "${e.description ?? 'that expense'}" is $${Number(e.amount).toFixed(2)}.`)
      }
      if ((e.property_id ?? null) !== (place.propertyId ?? null)) {
        throw new AppError(409, `"${e.description ?? 'That expense'}" is not filed where this asset goes. An expense pays for part of an asset only where `
          + 'the asset is: put the asset on the property the expense was filed on (or split it, for an expense split across your properties), '
          + 'or choose another expense.')
      }
    }
    out.push({ kind: l.kind, amount: l.amount, loanId: l.kind === 'loan' ? l.loanId : null, expenseId: l.kind === 'expense' ? l.expenseId : null })
  }
  // "A loan may spread over several assets" — never past what it lent.
  for (const [loanId, here] of perLoan) {
    const r = (await q.query<{ name: string; lent: string; used: string }>(
      `SELECT l.name, l.original_amount::text AS lent,
              (books_loan_used_by_assets(l.id)
                 - COALESCE((SELECT sum(x.amount) FROM books_fixed_asset_funding x
                              WHERE x.asset_id = $2 AND x.loan_id = l.id AND x.replaced_at IS NULL), 0)
                 - COALESCE((SELECT f.cost FROM books_fixed_assets f
                              WHERE f.id = $2 AND f.funded_loan_id = l.id AND f.funded_by = 'loan' AND f.voided_at IS NULL), 0))::text AS used
         FROM books_loans l WHERE l.id = $1`, [loanId, assetId])).rows[0]
    const left = cents(Number(r.lent)) - cents(Number(r.used))
    if (here > left) {
      throw new AppError(409, `"${r.name}" lent $${Number(r.lent).toFixed(2)}, and $${(cents(Number(r.used)) / 100).toFixed(2)} of it already paid for other assets, `
        + `so $${(Math.max(0, left) / 100).toFixed(2)} of it is left for this one.`)
    }
  }
  return out
}

/** 10/13 (Nic): writes an asset's funding lines (its old ones already replaced). */
async function insertFundingLines(q: Pick<PoolClient, 'query'>, owner: BooksOwner, assetId: string, lines: FundingLine[], by: string | null) {
  for (const [i, l] of lines.entries()) {
    await q.query(
      `INSERT INTO books_fixed_asset_funding (asset_id, landlord_id, kind, loan_id, expense_id, amount, line_no, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [assetId, owner.id, l.kind, l.loanId ?? null, l.expenseId ?? null, l.amount, i + 1, by]).catch(dbRefusal)
  }
}

/** 10/13 (Nic): an edit replaces the asset's live funding lines (kept on record, never removed). */
async function replaceFundingLines(q: Pick<PoolClient, 'query'>, assetId: string): Promise<number> {
  const r = await q.query(`UPDATE books_fixed_asset_funding SET replaced_at = now() WHERE asset_id = $1 AND replaced_at IS NULL`, [assetId])
  return r.rowCount ?? 0
}

async function assetsOut(q: Pick<PoolClient, 'query'>, owner: BooksOwner, rows: Record<string, any>[]) {
  const today = await companyToday(q, owner.col === 'landlord_id' ? owner.id : null)
  return rows.map(a => ({ ...a, ...assetFigures(a, today), today }))
}

// ═════════════════════════════════════════════════════════════════════════════

export function registerBooksLoansAssetsRoutes(booksRouter: Router, deps: BooksLoansAssetsDeps): void {

  // ── VENDORS ───────────────────────────────────────────────────────────────

  // GET /api/books/vendors — ?includeInactive=true lists inactive ones too;
  // ?type=contractor one type. Each with what it was paid this calendar year
  // (and how much of that a 1099 counts) and what it is still owed.
  booksRouter.get('/vendors', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOrNone(deps, req)
      if (!owner) return res.json({ success: true, data: [] })
      const type = typeof req.query.type === 'string' && (BOOKS_VENDOR_TYPES as readonly string[]).includes(req.query.type) ? req.query.type : null
      const data = await listVendors(db, owner, {
        year: await thisYear(owner), includeInactive: req.query.includeInactive === 'true', type,
      })
      res.json({ success: true, data })
    } catch (e) { next(e) }
  })

  // GET /api/books/vendors/1099?year=YYYY — every vendor with the 1099 box paid
  // in that calendar year, what a 1099-NEC counts, and whether one is needed.
  booksRouter.get('/vendors/1099', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const year = req.query.year ? Number(req.query.year) : await thisYear(owner)
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError(400, 'Choose a tax year.')
      res.json({ success: true, data: await vendor1099List(db, owner, year) })
    } catch (e) { next(e) }
  })

  // POST /api/books/vendors — add a vendor. Its type is required; only a
  // contractor carries the 1099 box. The taxpayer ID is optional (most
  // utilities and suppliers never give one); a Social Security number is kept
  // as its last four digits only.
  booksRouter.post('/vendors', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const b = parse(vendorCreateSchema, req.body)
      contractorOnly(b.vendorType, b)
      if (isDisposableEmail(b.email)) throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
      const contractor = b.vendorType === BOOKS_VENDOR_1099_TYPE
      const tin = splitTaxId(b.taxId, b.taxClassification)
      const { rows: [v] } = await db.query(
        `INSERT INTO books_vendors (${owner.col}, name, contact_name, email, phone, address, category, payment_terms,
                                    account_number, tax_id, ssn_last4, notes, vendor_type, is_1099, tax_classification,
                                    w9_on_file, trade, pay_rate, pay_unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING id`,
        [owner.id, b.name, b.contactName, b.email, b.phone, b.address, b.category ?? null, b.paymentTerms ?? 'net30',
         b.accountNumber ?? null, tin.taxId, tin.ssnLast4, b.notes ?? null, b.vendorType, contractor && !!b.is1099,
         b.taxClassification ?? null, !!b.w9OnFile, contractor ? b.trade ?? null : null,
         contractor ? b.payRate ?? null : null, contractor ? b.payUnit ?? null : null]).catch(dbRefusal)
      const row = (await db.query(`SELECT ${VENDOR_COLUMNS} FROM books_vendors v WHERE v.id = $1`, [v.id])).rows[0]
      res.status(201).json({ success: true, data: vendorOut(row, await thisYear(owner)) })
    } catch (e) { next(e) }
  })

  // PATCH /api/books/vendors/:id — change what was sent. Making a vendor
  // inactive keeps it and everything paid to it. A vendor that stops being a
  // contractor loses the 1099 box (what it was paid stays on its expenses).
  booksRouter.patch('/vendors/:id', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const b = parse(vendorPatchSchema, req.body)
      const cur = (await db.query(`SELECT * FROM books_vendors WHERE id = $1 AND ${owner.col} = $2`, [req.params.id, owner.id])).rows[0]
      if (!cur) throw new AppError(404, 'Vendor not found')
      const type = b.vendorType ?? cur.vendor_type
      const is1099 = type === BOOKS_VENDOR_1099_TYPE ? (b.is1099 ?? cur.is_1099) : false
      if (b.is1099 && type !== BOOKS_VENDOR_1099_TYPE) contractorOnly(type, b)
      if (cur.tenant_id && type !== BOOKS_VENDOR_1099_TYPE) {
        throw new AppError(409, 'This vendor is a work trader paid as a contractor; it stays a contractor.')
      }
      if (b.email && isDisposableEmail(b.email)) throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
      const classification = b.taxClassification === undefined ? cur.tax_classification : b.taxClassification
      const tin = b.taxId ? splitTaxId(b.taxId, classification) : null
      const contractor = type === BOOKS_VENDOR_1099_TYPE
      const pick = <T>(sent: T | undefined, was: T) => (sent === undefined ? was : sent)
      await db.query(
        `UPDATE books_vendors SET
           name = $3, contact_name = $4, email = $5, phone = $6, address = $7, category = $8, payment_terms = $9,
           account_number = $10, notes = $11, status = $12, vendor_type = $13, is_1099 = $14, tax_classification = $15,
           w9_on_file = $16, trade = $17, pay_rate = $18, pay_unit = $19,
           tax_id = CASE WHEN $20::boolean THEN $21 ELSE tax_id END,
           ssn_last4 = CASE WHEN $20::boolean THEN $22 ELSE ssn_last4 END,
           updated_at = now()
         WHERE id = $1 AND ${owner.col} = $2`,
        [cur.id, owner.id, pick(b.name, cur.name), pick(b.contactName, cur.contact_name), pick(b.email, cur.email),
         pick(b.phone, cur.phone), pick(b.address, cur.address), pick(b.category, cur.category),
         pick(b.paymentTerms, cur.payment_terms), pick(b.accountNumber, cur.account_number), pick(b.notes, cur.notes),
         pick(b.status, cur.status), type, is1099, classification, pick(b.w9OnFile, cur.w9_on_file),
         contractor ? pick(b.trade, cur.trade) : null, contractor ? pick(b.payRate, cur.pay_rate) : null,
         contractor ? pick(b.payUnit, cur.pay_unit) : null,
         !!tin, tin?.taxId ?? null, tin?.ssnLast4 ?? null]).catch(dbRefusal)
      const row = (await db.query(`SELECT ${VENDOR_COLUMNS} FROM books_vendors v WHERE v.id = $1`, [cur.id])).rows[0]
      const year = await thisYear(owner)
      const [totals, owed] = await Promise.all([vendorYearTotals(db, owner, year, [cur.id]), vendorOwed(db, owner, [cur.id])])
      res.json({ success: true, data: vendorOut(row, year, totals.get(cur.id), owed.get(cur.id)) })
    } catch (e) { next(e) }
  })

  // ── WHERE A COST GOES ─────────────────────────────────────────────────────

  // GET /api/books/cost-places — 10/13 (Nic): "each expense is chosen on the
  // split or specific unit or property at the time of logging." The company's
  // properties and their units, for the Loans, Fixed assets and Run payroll
  // forms to ask where a cost goes (split across them by units, one
  // property, one unit). A business's books have none.
  booksRouter.get('/cost-places', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOrNone(deps, req)
      res.json({ success: true, data: {
        properties: owner ? await costPlaceOptions(db, owner) : [],
        asked: !owner || owner.col === 'landlord_id',
      } })
    } catch (e) { next(e) }
  })

  // ── LOANS ─────────────────────────────────────────────────────────────────

  // GET /api/books/loans/form-options — what the loan forms pick from: the
  // company's linked bank accounts and its books start date.
  booksRouter.get('/loans/form-options', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const banks = owner.col === 'landlord_id'
        ? (await db.query(
            `SELECT id, COALESCE(NULLIF(display_name, ''), institution_name, 'Bank account') AS name, account_last4, status
               FROM bank_connections WHERE landlord_id = $1 ORDER BY (status = 'active') DESC, created_at, id`, [owner.id])).rows
        : []
      res.json({ success: true, data: { bankAccounts: banks, booksStartDate: await booksStartOf(db, owner),
        today: await companyToday(db, owner.col === 'landlord_id' ? owner.id : null) } })
    } catch (e) { next(e) }
  })

  // GET /api/books/loans — ?includeVoided=true lists voided ones too.
  booksRouter.get('/loans', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOrNone(deps, req)
      if (!owner) return res.json({ success: true, data: [] })
      const rows = (await db.query(
        `SELECT ${LOAN_COLUMNS} FROM books_loans l
          WHERE l.${owner.col} = $1 AND ($2::boolean OR l.voided_at IS NULL)
          ORDER BY l.voided_at IS NOT NULL, l.start_date DESC, l.id`, [owner.id, req.query.includeVoided === 'true'])).rows
      const figures = await loanFigures(db, rows as any)
      res.json({ success: true, data: rows.map(r => ({ ...r, ...figures.get(r.id) })) })
    } catch (e) { next(e) }
  })

  // GET /api/books/loans/:id — the loan, its figures and every payment.
  booksRouter.get('/loans/:id', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const row = (await db.query(`SELECT ${LOAN_COLUMNS} FROM books_loans l WHERE l.id = $1 AND l.${owner.col} = $2`,
        [req.params.id, owner.id])).rows[0]
      if (!row) throw new AppError(404, 'Loan not found')
      const payments = (await db.query(
        `SELECT p.id, p.paid_on::text AS paid_on, p.amount::float AS amount, p.principal::float AS principal,
                p.interest::float AS interest, p.escrow::float AS escrow, p.method, p.bank_connection_id,
                p.bank_transaction_id, p.source, p.memo, p.voided_at::text AS voided_at, p.void_reason, p.created_at
           FROM books_loan_payments p WHERE p.loan_id = $1 ORDER BY p.paid_on DESC, p.created_at DESC`, [row.id])).rows
      res.json({ success: true, data: { ...(await loanOut(db, row)), paymentsList: payments } })
    } catch (e) { next(e) }
  })

  // GET /api/books/loans/:id/suggest?paidOn=YYYY-MM-DD&amount=1234.56 — GAM's
  // split of a payment (the lender's statement decides; the person changes it).
  booksRouter.get('/loans/:id/suggest', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const row = (await db.query(`SELECT id FROM books_loans WHERE id = $1 AND ${owner.col} = $2`, [req.params.id, owner.id])).rows[0]
      if (!row) throw new AppError(404, 'Loan not found')
      const paidOn = String(req.query.paidOn ?? '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new AppError(400, 'Enter the day it was paid as a date.')
      const amount = req.query.amount != null && req.query.amount !== '' ? Number(req.query.amount) : null
      if (amount != null && !(amount > 0)) throw new AppError(400, 'Enter the payment as an amount.')
      const s = await suggestLoanSplit(db, row.id, paidOn, amount == null ? null : cents(amount))
      res.json({ success: true, data: {
        principal: s.principalCents / 100, interest: s.interestCents / 100, escrow: s.escrowCents / 100,
        balanceBefore: s.balanceCents == null ? null : s.balanceCents / 100,
      } })
    } catch (e) { next(e) }
  })

  // POST /api/books/loans — add a loan.
  booksRouter.post('/loans', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const b = parse(loanCreateSchema, req.body)
      const out = await inTx(async (c) => {
        await assertOwned(c, owner, { vendorId: b.vendorId, bankConnectionId: b.fundedBankConnectionId })
        // 10/13 (Nic): where each payment's interest goes, picked now (required).
        const place = await resolveCostPlace(c, owner, b, 'this loan\'s interest')
        if (b.paymentAmount != null && b.escrowAmount > b.paymentAmount) throw new AppError(400, 'The escrow part cannot be more than the whole payment.')
        loanOpeningRules(b, await booksStartOf(c, owner))
        const { rows: [l] } = await c.query(
          `INSERT INTO books_loans (${owner.col}, property_id, vendor_id, name, lender_name, original_amount, annual_rate,
                                    start_date, term_months, payment_amount, escrow_amount, payment_day, funded_to,
                                    funded_bank_connection_id, opening_balance, opening_escrow, notes, created_by,
                                    cost_place, unit_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
          [owner.id, place.propertyId, b.vendorId ?? null, b.name, b.lenderName, b.originalAmount, b.annualRate,
           b.startDate, b.termMonths ?? null, b.paymentAmount ?? null, b.escrowAmount, b.paymentDay ?? null,
           b.fundedTo ?? null, b.fundedBankConnectionId ?? null, b.openingBalance ?? null, b.openingEscrow ?? null,
           b.notes ?? null, req.user!.userId, place.costPlace, place.unitId]).catch(dbRefusal)
        return (await c.query(`SELECT ${LOAN_COLUMNS} FROM books_loans l WHERE l.id = $1`, [l.id])).rows[0]
      })
      res.status(201).json({ success: true, data: await loanOut(db, out) })
    } catch (e) { next(e) }
  })

  // PATCH /api/books/loans/:id — change what was sent. Every payment re-posts
  // with it (they carry the loan's property and name).
  booksRouter.patch('/loans/:id', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const b = parse(loanPatchSchema, req.body)
      const out = await inTx(async (c) => {
        const cur = (await c.query(`SELECT l.*, l.start_date::text AS start_date_d FROM books_loans l WHERE l.id = $1 AND l.${owner.col} = $2 FOR UPDATE`,
          [req.params.id, owner.id])).rows[0]
        if (!cur) throw new AppError(404, 'Loan not found')
        if (cur.voided_at) throw new AppError(409, 'This loan was voided; it does not change.')
        await assertOwned(c, owner, { vendorId: b.vendorId, bankConnectionId: b.fundedBankConnectionId })
        // 10/13 (Nic): where its interest goes — as it was, unless the form says it again.
        const place: CostPlaceChoice = b.costPlace !== undefined || b.propertyId !== undefined || b.unitId !== undefined
          ? await resolveCostPlace(c, owner, { costPlace: b.costPlace ?? null, propertyId: b.propertyId ?? null, unitId: b.unitId ?? null },
            'this loan\'s interest')
          : { costPlace: cur.cost_place ?? null, propertyId: cur.property_id ?? null, unitId: cur.unit_id ?? null }
        const pick = <T>(sent: T | undefined, was: T) => (sent === undefined ? was : sent)
        const next1 = {
          startDate: pick(b.startDate, cur.start_date_d as string),
          fundedTo: pick(b.fundedTo, cur.funded_to),
          fundedBankConnectionId: pick(b.fundedBankConnectionId, cur.funded_bank_connection_id),
          openingBalance: pick(b.openingBalance, cur.opening_balance == null ? null : Number(cur.opening_balance)),
          openingEscrow: pick(b.openingEscrow, cur.opening_escrow == null ? null : Number(cur.opening_escrow)),
          paymentAmount: pick(b.paymentAmount, cur.payment_amount == null ? null : Number(cur.payment_amount)),
          escrowAmount: pick(b.escrowAmount, Number(cur.escrow_amount)),
        }
        // 10/12 review: the bank line its money arrived as says how much and
        // when — the amount borrowed and the day it was made stay with that
        // line too, or the loan would post a different amount (or, moved
        // before the books start, only an opening balance) while the line
        // stays matched and the books' cash no longer equals the bank.
        const amountMoved = b.originalAmount !== undefined && Math.round(Number(b.originalAmount) * 100) !== Math.round(Number(cur.original_amount) * 100)
        const dayMoved = b.startDate !== undefined && b.startDate !== cur.start_date_d
        if (cur.funded_bank_transaction_id && (next1.fundedTo !== 'bank' || amountMoved || dayMoved
            || (next1.fundedBankConnectionId && next1.fundedBankConnectionId !== cur.funded_bank_connection_id))) {
          throw new AppError(409, 'This loan\'s money is matched to a bank line. Take that match back on the Bank page first.')
        }
        if (next1.paymentAmount != null && next1.escrowAmount > next1.paymentAmount) throw new AppError(400, 'The escrow part cannot be more than the whole payment.')
        loanOpeningRules(next1, await booksStartOf(c, owner))
        await c.query(
          `UPDATE books_loans SET property_id = $3, vendor_id = $4, name = $5, lender_name = $6, original_amount = $7,
                  annual_rate = $8, start_date = $9, term_months = $10, payment_amount = $11, escrow_amount = $12,
                  payment_day = $13, funded_to = $14, funded_bank_connection_id = $15, opening_balance = $16,
                  opening_escrow = $17, notes = $18, cost_place = $19, unit_id = $20, updated_at = now()
            WHERE id = $1 AND ${owner.col} = $2`,
          [cur.id, owner.id, place.propertyId, pick(b.vendorId, cur.vendor_id), pick(b.name, cur.name),
           pick(b.lenderName, cur.lender_name), pick(b.originalAmount, cur.original_amount), pick(b.annualRate, cur.annual_rate),
           next1.startDate, pick(b.termMonths, cur.term_months), next1.paymentAmount, next1.escrowAmount,
           pick(b.paymentDay, cur.payment_day), next1.fundedTo, next1.fundedTo === 'bank' ? next1.fundedBankConnectionId : null,
           next1.openingBalance, next1.openingEscrow, pick(b.notes, cur.notes), place.costPlace, place.unitId]).catch(dbRefusal)
        // What is owed can never go below nothing after the change.
        const left = await c.query<{ id: string }>(
          `SELECT p.id FROM books_loan_payments p WHERE p.loan_id = $1 AND p.voided_at IS NULL ORDER BY p.paid_on DESC LIMIT 1`, [cur.id])
        if (left.rows[0]) {
          const f = (await loanFigures(c, (await c.query(`SELECT ${LOAN_COLUMNS} FROM books_loans l WHERE l.id = $1`, [cur.id])).rows as any)).get(cur.id)!
          if (f.balance != null && f.balance < 0) {
            throw new AppError(409, 'With that change the principal already paid is more than the loan. Check the amount borrowed or the opening balance.')
          }
        }
        return (await c.query(`SELECT ${LOAN_COLUMNS} FROM books_loans l WHERE l.id = $1`, [cur.id])).rows[0]
      })
      res.json({ success: true, data: await loanOut(db, out) })
    } catch (e) { next(e) }
  })

  // POST /api/books/loans/:id/void — a loan entered by mistake. Kept on record
  // (who, when, why); its payments are voided with it and every posting is
  // taken back. Refused while a bank line is matched to it or a payment (take
  // those back on the Bank page first).
  booksRouter.post('/loans/:id/void', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const { reason } = parse(voidSchema, req.body)
      await inTx(async (c) => {
        const cur = (await c.query(`SELECT id, voided_at, funded_bank_transaction_id FROM books_loans WHERE id = $1 AND ${owner.col} = $2 FOR UPDATE`,
          [req.params.id, owner.id])).rows[0]
        if (!cur) throw new AppError(404, 'Loan not found')
        if (cur.voided_at) throw new AppError(409, 'This loan is already voided.')
        const matched = (await c.query(
          `SELECT 1 FROM books_loan_payments WHERE loan_id = $1 AND voided_at IS NULL AND bank_transaction_id IS NOT NULL LIMIT 1`, [cur.id])).rows[0]
        if (cur.funded_bank_transaction_id || matched) {
          throw new AppError(409, 'A bank line is matched to this loan or one of its payments. Take that match back on the Bank page first.')
        }
        await c.query(
          `UPDATE books_loan_payments SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now()
            WHERE loan_id = $1 AND voided_at IS NULL`, [cur.id, req.user!.userId, `The loan was voided: ${reason}`.slice(0, 500)])
        // 10/13 (Nic): a loan a fixed asset stands on stays (books_loans_asset_guard says so in plain words).
        await c.query(`UPDATE books_loans SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now() WHERE id = $1`,
          [cur.id, req.user!.userId, reason]).catch(dbRefusal)
      })
      res.json({ success: true })
    } catch (e) { next(e) }
  })

  // POST /api/books/loans/:id/payments — record a payment, split into
  // principal, interest and escrow (adding up to the payment). Paid from the
  // bank, it is matched to its bank line when the line arrives.
  booksRouter.post('/loans/:id/payments', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const b = parse(loanPaymentSchema, req.body)
      if (cents(b.principal) + cents(b.interest) + cents(b.escrow) !== cents(b.amount)) {
        throw new AppError(400, `The principal, interest and escrow must add up to the payment ($${b.amount.toFixed(2)}).`)
      }
      if (b.bankConnectionId && b.method !== 'bank') throw new AppError(400, 'A bank account is only for a payment made from the bank.')
      const made = await inTx(async (c) => {
        const loan = (await c.query(`SELECT id, voided_at, start_date::text AS start_date FROM books_loans WHERE id = $1 AND ${owner.col} = $2 FOR UPDATE`,
          [req.params.id, owner.id])).rows[0]
        if (!loan) throw new AppError(404, 'Loan not found')
        if (loan.voided_at) throw new AppError(409, 'This loan was voided; it takes no payments.')
        if (b.paidOn < loan.start_date) throw new AppError(400, 'A payment cannot be before the loan was made.')
        await assertOwned(c, owner, { bankConnectionId: b.bankConnectionId })
        await assertPrincipalFits(c, loan.id, b.paidOn, cents(b.principal))
        const { rows: [p] } = await c.query(
          `INSERT INTO books_loan_payments (loan_id, ${owner.col}, paid_on, amount, principal, interest, escrow, method,
                                            bank_connection_id, source, memo, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'entered', $10, $11) RETURNING id`,
          [loan.id, owner.id, b.paidOn, b.amount, b.principal, b.interest, b.escrow, b.method,
           b.method === 'bank' ? b.bankConnectionId ?? null : null, b.memo ?? null, req.user!.userId]).catch(dbRefusal)
        return p.id as string
      })
      res.status(201).json({ success: true, data: { id: made } })
    } catch (e) { next(e) }
  })

  // POST /api/books/loans/:id/payments/:paymentId/void — a payment entered by
  // mistake (kept on record). One that is a bank line is changed on the Bank
  // page, where the line is (10/12, Nic: a bank filing is undone there).
  booksRouter.post('/loans/:id/payments/:paymentId/void', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const { reason } = parse(voidSchema, req.body)
      await inTx(async (c) => {
        const p = (await c.query(
          `SELECT p.id, p.voided_at, p.bank_transaction_id FROM books_loan_payments p
            WHERE p.id = $1 AND p.loan_id = $2 AND p.${owner.col} = $3 FOR UPDATE`, [req.params.paymentId, req.params.id, owner.id])).rows[0]
        if (!p) throw new AppError(404, 'Payment not found')
        if (p.voided_at) throw new AppError(409, 'This payment is already voided.')
        if (p.bank_transaction_id) {
          throw new AppError(409, 'This payment is matched to a bank line. Take it back on the Bank page, where the line is.')
        }
        await c.query(`UPDATE books_loan_payments SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now() WHERE id = $1`,
          [p.id, req.user!.userId, reason])
      })
      res.json({ success: true })
    } catch (e) { next(e) }
  })

  // ── FIXED ASSETS ──────────────────────────────────────────────────────────

  // GET /api/books/fixed-assets — ?includeVoided=true lists voided ones too.
  // Each with its depreciation so far, what it is worth on the books, the
  // monthly amount and the months left.
  booksRouter.get('/fixed-assets', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOrNone(deps, req)
      if (!owner) return res.json({ success: true, data: [] })
      const rows = (await db.query(
        `SELECT ${ASSET_COLUMNS} FROM books_fixed_assets a
          WHERE a.${owner.col} = $1 AND ($2::boolean OR a.voided_at IS NULL)
          ORDER BY a.voided_at IS NOT NULL, a.in_service_date DESC, a.id`, [owner.id, req.query.includeVoided === 'true'])).rows
      res.json({ success: true, data: await assetsOut(db, owner, rows) })
    } catch (e) { next(e) }
  })

  // GET /api/books/fixed-assets/capital-expenses — expenses filed under a
  // capital-improvement category (one charging to an asset account) that are
  // not an asset yet.
  booksRouter.get('/fixed-assets/capital-expenses', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOrNone(deps, req)
      res.json({ success: true, data: owner?.col === 'landlord_id' ? await capitalExpenses(db, owner.id) : [] })
    } catch (e) { next(e) }
  })

  // GET /api/books/fixed-assets/linkable-expenses — 10/13 (Nic): the expenses a
  // fixed asset typed in by hand can say it "already" was (any live purchase
  // that is no asset yet, and no repair's bill that can still change with its
  // repair): its cost then moves from the expense to the asset.
  booksRouter.get('/fixed-assets/linkable-expenses', requireBooksRead, async (req, res, next) => {
    try {
      const owner = companyOrNone(deps, req)
      res.json({ success: true, data: owner?.col === 'landlord_id' ? await linkableExpenses(db, owner.id) : [] })
    } catch (e) { next(e) }
  })

  // POST /api/books/fixed-assets — add an asset. One bought before the books
  // start opens at its cost less the depreciation already taken. 10/13 (Nic):
  // one bought on or after it says where its money came from (fundedBy) and
  // posts to that — cash on hand, the owner's own money, a loan whose money
  // went straight to the seller (the loan's posting carries the cost), or an
  // expense already on the books (expenseId: "LINK that expense (cost moves to
  // the asset)" — its cost, day and property are the asset's).
  booksRouter.post('/fixed-assets', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const b = parse(assetCreateSchema, req.body)
      if (b.expenseId && b.fundedBy !== 'expense') throw new AppError(400, 'An expense is only for an asset that was already an expense.')
      if (b.funding && (b.fundedBy || b.fundedLoanId || b.expenseId)) {
        throw new AppError(400, 'Say where the money came from once: as the list of where each part came from.')
      }
      const row = await inTx(async (c) => {
        const booksStart = await booksStartOf(c, owner)
        if (b.fundedBy === 'expense') {
          if (owner.col !== 'landlord_id') throw new AppError(400, 'A business\'s books have no expenses record yet.')
          if (!b.expenseId) throw new AppError(400, 'Choose the expense it was.')
          await c.query(`SELECT 1 FROM landlord_expenses WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [b.expenseId, owner.id])
          const e = await linkableExpense(c, owner.id, b.expenseId)
          const v = {
            assetClass: b.assetClass, cost: Number(e.amount), salvageValue: b.salvageValue, acquiredOn: e.expense_date,
            inServiceDate: b.inServiceDate ?? e.expense_date, lifeYears: b.lifeYears ?? null, priorDepreciation: b.priorDepreciation ?? null,
          }
          assetRules(v, booksStart, true)
          // 10/13 (Nic): where its depreciation goes, picked now (it sits where the expense was filed).
          const place = await expenseAssetPlace(c, owner, e.property_id, b)
          const { rows: [a] } = await c.query(
            `INSERT INTO books_fixed_assets (landlord_id, property_id, name, asset_class, cost, salvage_value, acquired_on,
                                             in_service_date, life_years, method, source_expense_id, funded_by, notes, created_by,
                                             cost_place, unit_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'expense', $12, $13, $14, $15) RETURNING id`,
            [owner.id, e.property_id, b.name, b.assetClass, e.amount, v.salvageValue, v.acquiredOn, v.inServiceDate,
             fixedAssetDepreciates(b.assetClass) ? v.lifeYears : null, b.method, e.id, b.notes ?? null, req.user!.userId,
             place.costPlace, place.unitId]).catch(dbRefusal)
          return (await c.query(`SELECT ${ASSET_COLUMNS} FROM books_fixed_assets a WHERE a.id = $1`, [a.id])).rows[0]
        }
        if (b.cost === undefined) throw new AppError(400, 'Enter the cost.')
        if (b.acquiredOn === undefined) throw new AppError(400, 'Enter the day it was bought.')
        // 10/13 (Nic): where it sits and its depreciation goes, picked now (required).
        const place = await resolveCostPlace(c, owner, b, ASSET_PLACE_WHAT)
        const v = { ...b, cost: b.cost, acquiredOn: b.acquiredOn, inServiceDate: b.inServiceDate ?? b.acquiredOn }
        assetRules(v, booksStart, false)
        // 10/13 (Nic): "ALLOW A MIX" — the lines, or one answer for the whole cost.
        const lines = b.funding ? await assetFundingLines(c, owner, b.funding, v, booksStart, null, place) : null
        const funding = lines ? { fundedBy: null, fundedLoanId: null } : await assetFunding(c, owner, v, booksStart)
        const { rows: [a] } = await c.query(
          `INSERT INTO books_fixed_assets (${owner.col}, property_id, name, asset_class, cost, salvage_value, acquired_on,
                                           in_service_date, life_years, method, prior_depreciation, funded_by, funded_loan_id,
                                           notes, created_by, cost_place, unit_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
          [owner.id, place.propertyId, b.name, b.assetClass, v.cost, v.salvageValue, v.acquiredOn, v.inServiceDate,
           fixedAssetDepreciates(b.assetClass) ? b.lifeYears ?? null : null, b.method, b.priorDepreciation ?? null,
           funding.fundedBy, funding.fundedLoanId, b.notes ?? null, req.user!.userId, place.costPlace, place.unitId]).catch(dbRefusal)
        if (lines) await insertFundingLines(c, owner, a.id, lines, req.user!.userId)
        return (await c.query(`SELECT ${ASSET_COLUMNS} FROM books_fixed_assets a WHERE a.id = $1`, [a.id])).rows[0]
      })
      res.status(201).json({ success: true, data: (await assetsOut(db, owner, [row]))[0] })
    } catch (e) { next(e) }
  })

  // POST /api/books/fixed-assets/from-expense/:expenseId — turn an expense
  // filed under a capital-improvement category into an asset: its cost, day
  // and property come from the expense (already on the books as an asset);
  // the asset adds the depreciation.
  booksRouter.post('/fixed-assets/from-expense/:expenseId', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      if (owner.col !== 'landlord_id') throw new AppError(400, 'A business\'s books have no expenses record yet.')
      const b = parse(fromExpenseSchema, req.body)
      const row = await inTx(async (c) => {
        await c.query(`SELECT 1 FROM landlord_expenses WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [req.params.expenseId, owner.id])
        const e = await capitalExpense(c, owner.id, String(req.params.expenseId))
        const v = {
          assetClass: b.assetClass, cost: Number(e.amount), salvageValue: b.salvageValue, acquiredOn: e.expense_date,
          inServiceDate: b.inServiceDate ?? e.expense_date, lifeYears: b.lifeYears ?? null, priorDepreciation: null,
        }
        assetRules(v, await booksStartOf(c, owner), true)
        // 10/13 (Nic): where its depreciation goes, picked now (it sits where the expense was filed).
        const place = await expenseAssetPlace(c, owner, e.property_id, b)
        const { rows: [a] } = await c.query(
          `INSERT INTO books_fixed_assets (landlord_id, property_id, name, asset_class, cost, salvage_value, acquired_on,
                                           in_service_date, life_years, method, source_expense_id, funded_by, notes, created_by,
                                           cost_place, unit_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'straight_line', $10, 'expense', $11, $12, $13, $14) RETURNING id`,
          [owner.id, e.property_id, (b.name ?? e.description ?? e.category_name ?? 'Capital improvement').slice(0, 120),
           b.assetClass, e.amount, v.salvageValue, v.acquiredOn, v.inServiceDate,
           fixedAssetDepreciates(b.assetClass) ? v.lifeYears : null, e.id, b.notes ?? null, req.user!.userId,
           place.costPlace, place.unitId]).catch(dbRefusal)
        return (await c.query(`SELECT ${ASSET_COLUMNS} FROM books_fixed_assets a WHERE a.id = $1`, [a.id])).rows[0]
      })
      res.status(201).json({ success: true, data: (await assetsOut(db, owner, [row]))[0] })
    } catch (e) { next(e) }
  })

  // PATCH /api/books/fixed-assets/:id — change what was sent; the opening and
  // every month of depreciation re-post with it. An asset made from an
  // expense keeps that expense's cost and day. 10/13 (Nic): where the money
  // came from may be said or corrected (cash on hand, the owner, a loan); an
  // expense is linked only when the asset is added.
  booksRouter.patch('/fixed-assets/:id', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const b = parse(assetPatchSchema, req.body)
      const row = await inTx(async (c) => {
        const cur = (await c.query(
          `SELECT a.*, a.acquired_on::text AS acquired_on_d, a.in_service_date::text AS in_service_d
             FROM books_fixed_assets a WHERE a.id = $1 AND a.${owner.col} = $2 FOR UPDATE`, [req.params.id, owner.id])).rows[0]
        if (!cur) throw new AppError(404, 'Fixed asset not found')
        if (cur.voided_at) throw new AppError(409, 'This asset was voided; it does not change.')
        const fromExpense = !!cur.source_expense_id
        if (fromExpense && (b.cost !== undefined || b.acquiredOn !== undefined || b.propertyId !== undefined)) {
          throw new AppError(409, 'This asset was made from an expense: its cost, day and property are the expense\'s. Change the expense instead.')
        }
        if (fromExpense && ((b.fundedBy !== undefined && b.fundedBy !== 'expense') || b.fundedLoanId !== undefined || b.funding !== undefined)) {
          throw new AppError(409, 'This asset was made from an expense, so the expense paid for it. Change the expense instead.')
        }
        if (!fromExpense && b.fundedBy === 'expense') {
          throw new AppError(409, 'To link an expense, void this asset and add it again as "Already an expense".')
        }
        if (b.funding && (b.fundedBy !== undefined || b.fundedLoanId !== undefined)) {
          throw new AppError(400, 'Say where the money came from once: as the list of where each part came from.')
        }
        // 10/13 (Nic): where it sits and its depreciation goes — as it was,
        // unless the form says it again (an asset made from an expense stays
        // where the expense was filed).
        const placeSent = b.costPlace !== undefined || b.propertyId !== undefined || b.unitId !== undefined
        const place: CostPlaceChoice = !placeSent
          ? { costPlace: cur.cost_place ?? null, propertyId: cur.property_id ?? null, unitId: cur.unit_id ?? null }
          : fromExpense
            ? await expenseAssetPlace(c, owner, cur.property_id ?? null, { costPlace: b.costPlace ?? null, unitId: b.unitId ?? null })
            : await resolveCostPlace(c, owner, { costPlace: b.costPlace ?? null, propertyId: b.propertyId ?? null, unitId: b.unitId ?? null }, ASSET_PLACE_WHAT)
        const pick = <T>(sent: T | undefined, was: T) => (sent === undefined ? was : sent)
        const assetClass = pick(b.assetClass, cur.asset_class)
        const v = {
          assetClass, cost: pick(b.cost, Number(cur.cost)), salvageValue: pick(b.salvageValue, Number(cur.salvage_value)),
          acquiredOn: pick(b.acquiredOn, cur.acquired_on_d), inServiceDate: pick(b.inServiceDate, cur.in_service_d),
          lifeYears: fixedAssetDepreciates(assetClass) ? pick(b.lifeYears, cur.life_years == null ? null : Number(cur.life_years)) : null,
          priorDepreciation: pick(b.priorDepreciation, cur.prior_depreciation == null ? null : Number(cur.prior_depreciation)),
        }
        const booksStart = await booksStartOf(c, owner)
        assetRules(v, booksStart, fromExpense)
        // Where the money came from: as it was, unless sent (a class or day
        // change re-checks a loan). An asset entered before 10/13 has none
        // until it is said.
        let funding = { fundedBy: cur.funded_by as BooksFixedAssetFundedBy | null, fundedLoanId: cur.funded_loan_id as string | null }
        // 10/13 (Nic, "ALLOW A MIX"): the lines said again replace the old
        // ones (kept on record); a single answer replaces them too.
        let lines: FundingLine[] | null = null
        if (!fromExpense && b.funding !== undefined) {
          await replaceFundingLines(c, cur.id)
          lines = await assetFundingLines(c, owner, b.funding, v, booksStart, cur.id, place)
          funding = { fundedBy: null, fundedLoanId: null }
        } else if (!fromExpense) {
          const live = Number((await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM books_fixed_asset_funding WHERE asset_id = $1 AND replaced_at IS NULL`, [cur.id])).rows[0].n)
          const owned = !!booksStart && v.acquiredOn < booksStart
          if (live && (b.fundedBy !== undefined || owned)) {
            // A single answer replaces the lines; and an asset now owned before
            // the books start is not asked (it opens at its cost), so its lines go.
            await replaceFundingLines(c, cur.id)
          } else if (live && (cents(v.cost) !== cents(Number(cur.cost)) || v.assetClass !== cur.asset_class || v.acquiredOn !== cur.acquired_on_d)) {
            throw new AppError(400, 'You changed what it cost, what it is or the day you bought it: say again where its money came from, '
              + 'so the amounts still add up to what it cost and each loan still fits.')
          }
          const fundedBy = b.fundedBy === undefined ? funding.fundedBy : b.fundedBy
          const fundedLoanId = b.fundedLoanId !== undefined ? b.fundedLoanId : fundedBy === 'loan' ? funding.fundedLoanId : null
          if (fundedBy || b.fundedBy !== undefined) {
            funding = await assetFunding(c, owner, { fundedBy, fundedLoanId, assetClass: v.assetClass, acquiredOn: v.acquiredOn }, booksStart)
          }
        }
        await c.query(
          `UPDATE books_fixed_assets SET property_id = $3, name = $4, asset_class = $5, cost = $6, salvage_value = $7,
                  acquired_on = $8, in_service_date = $9, life_years = $10, prior_depreciation = $11, notes = $12,
                  funded_by = $13, funded_loan_id = $14, cost_place = $15, unit_id = $16, updated_at = now()
            WHERE id = $1 AND ${owner.col} = $2`,
          [cur.id, owner.id, place.propertyId, pick(b.name, cur.name), v.assetClass, v.cost, v.salvageValue,
           v.acquiredOn, v.inServiceDate, v.lifeYears, v.priorDepreciation, pick(b.notes, cur.notes),
           funding.fundedBy, funding.fundedLoanId, place.costPlace, place.unitId]).catch(dbRefusal)
        if (lines) await insertFundingLines(c, owner, cur.id, lines, req.user!.userId)
        return (await c.query(`SELECT ${ASSET_COLUMNS} FROM books_fixed_assets a WHERE a.id = $1`, [cur.id])).rows[0]
      })
      res.json({ success: true, data: (await assetsOut(db, owner, [row]))[0] })
    } catch (e) { next(e) }
  })

  // POST /api/books/fixed-assets/:id/void — an asset entered by mistake: kept
  // on record (who, when, why); its opening and depreciation are taken back.
  // An asset made from an expense frees that expense (it can be voided after).
  booksRouter.post('/fixed-assets/:id/void', requireBooksWrite, async (req, res, next) => {
    try {
      const owner = companyOf(deps, req)
      const { reason } = parse(voidSchema, req.body)
      await inTx(async (c) => {
        const cur = (await c.query(`SELECT id, voided_at FROM books_fixed_assets WHERE id = $1 AND ${owner.col} = $2 FOR UPDATE`,
          [req.params.id, owner.id])).rows[0]
        if (!cur) throw new AppError(404, 'Fixed asset not found')
        if (cur.voided_at) throw new AppError(409, 'This asset is already voided.')
        await c.query(`UPDATE books_fixed_assets SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now() WHERE id = $1`,
          [cur.id, req.user!.userId, reason])
      })
      res.json({ success: true })
    } catch (e) { next(e) }
  })
}

