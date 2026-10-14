import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth, requireLandlord, requireBooksRead, requireBooksWrite, getScopedPropertyIds, propertyCutoffsOf, bookkeeperRequestScopeOf } from '../middleware/auth'
import { bookkeeperScopesOf, requestScopeOf, companyWideRefusal, companyWideSql, keptIdsSql, KEEPS_NOTHING, LEDGER_REFUSAL, type PropertyCutoff } from '../lib/bookkeeperScope'
import { refuseScopedStaff } from './reports'
import { landlordScopeIds, ownsLandlord } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import { isDisposableEmail } from '../lib/email'
// 10/12 (Nic): one list of everyone the company pays, loans and fixed assets.
import { registerBooksLoansAssetsRoutes } from './booksLoansAssets'
// 10/12 (Nic, ledger P8): the Books statements read the ledger.
import { registerBooksLedgerReportRoutes, wholeLedgerScope } from './booksLedgerReports'
import { ledgerReportsLive, ledgerTaxSummary, ledgerProfitAndLoss, ledgerAccountBalances } from '../services/ledgerReports'
import { vendor1099List, resolveCostPlace } from '../services/booksVendorsLoans'
import { employeePayPlaceFrom, setEmployeePayPlace, paycheckPlaceOf, payPlaceMissingRefusal, EMPLOYEE_PAY_PLACE_REQUIRED } from '../services/booksEmployeePayPlace'
import { todayIn, monthStartOf } from '../lib/timezone'
import { basisMeta, incomeEvents, incomeTotals, incomeBoth, moneyViewFrom, summarize, lineList, ledgerOwedDay, type IncomeEvent } from '../services/incomeBasis'
import type { IncomeBasis } from '@gam/shared'

/**
 * 10/12 (Nic): "NO Money received / Money billed toggle anywhere — show
 * Charged, Received and Owed side by side." The Books P&L, owner statements
 * and rent roll read both kinds of facts and send the three columns
 * (Received leads, 10/12 L2); a stale ?basis= is ignored, as routes/reports
 * does. The single-number fields an older screen reads are Received.
 */
const BOOKS_BASIS: IncomeBasis = 'received'
import {
  BOOKS_ACCOUNT_TYPES, BOOKS_TRANSACTION_TYPES, BOOKS_JOURNAL_ENTRY_TYPES,
  BOOKS_PAY_TYPES, BOOKS_PAY_FREQUENCIES, BOOKS_PAY_PERIODS_PER_YEAR, BOOKS_EMPLOYEE_FILING_STATUSES,
  booksDefaultHours, booksNormalBalance, booksCents, socialSecurityWageBase, booksEmployerFica, BOOKS_COST_PLACES,
  type BooksPayFrequency,
} from '@gam/shared'
// 10/12 (Nic, ledger P7): payroll and journal entries post to the ledger
// within the minute — each write here kicks the books right after it commits.
import { currentLedgerXid, kickLedgerAfterCommit } from '../services/ledgerEngine'
import { createPayrollMoneyOut, payrollMoneyOutPaidRefusal, voidPayrollMoneyOut } from '../services/payrollMoneyOut'
import { BOOKS_JOURNAL_ENTRY_TYPES_TYPED, LEDGER_SOURCE_TYPE_LABEL, parseLedgerSourceKey, ledgerSourceKey } from '@gam/shared'
import type { PoolClient } from 'pg'
import { retireAccount } from '../services/booksLedgerChart'
import {
  recordWorkTradeContractorPayment, EXTRA_HOURS_ON_LIVE_RUN_SQL, EXTRA_HOURS_WAITING_FOR_BOOKS_SQL,
} from '../services/workTradeBooksPay'

// 10/12 (Nic, ledger P6, L5): which expenses count on a P&L, and a repair's cost once.
import { maintenanceCostNotBilledSql } from '../lib/liveExpense'

export const booksRouter = Router()
booksRouter.use(requireAuth)

// ── Scope helper — admin sees all, landlord sees own, bookkeeper uses active client ──
// Bookkeeper activeClientId is set by the middleware below from the
// X-Client-Id header. The middleware throws 400 if the header is missing
// and 403 if the claimed client isn't an assigned scope, so by the time
// we reach this helper, activeClientId is either a validated landlord_id
// or the caller is not a bookkeeper.
//
// S655 SECURITY FIX — A LANDLORD'S SESSION NAMES NO COMPANY (S633).
// This used to end `return user.landlordId || user.profileId`. Since S633 a
// landlord owner's pass carries profileId = null and landlordId = null (the
// account is not an entity; its companies ride in landlordIds), so that line
// returned null for EVERY landlord owner — and null is the admin "see all"
// value every `(landlord_id = $1 OR $1 IS NULL)` query below honors. A landlord
// opening Books saw every other landlord's rent roll and owner statement.
//
// The rule now: null is returned for an admin and nobody else. A landlord gets
// the company it chose (X-Client-Id, ownership-checked by the middleware
// below), or its only company; an account with several that chose none is
// ASKED (400), never defaulted — S654: "None is the default". A team role
// (a property manager with books.view) gets its one company. Anyone else is
// refused rather than handed a scope.
function landlordScope(user: any): string | null {
  if (user.role === 'admin' || user.role === 'super_admin') return null
  if (user.role === 'bookkeeper') {
    if (!user.activeClientId) throw new AppError(400, 'X-Client-Id header required for bookkeeper requests')
    return user.activeClientId
  }
  if (user.role === 'landlord') {
    if (user.activeClientId) return user.activeClientId
    const owned = landlordScopeIds(user)
    if (owned.length === 1) return owned[0]
    if (owned.length === 0) throw new AppError(400, 'No landlord scope on this user')
    throw new AppError(400, BOOKS_CHOOSE_COMPANY)
  }
  const teamIds = landlordScopeIds(user)
  if (teamIds.length === 1) return teamIds[0]
  throw new AppError(403, 'There are no company books on this account.')
}

/** The 400 an account with several companies gets until it picks one (Books shows its picker on it). */
export const BOOKS_CHOOSE_COMPANY = "You own more than one company. Choose which company's books to open."

/**
 * Does this landlord account own (or co-own) `landlordId`? The token first,
 * then the database — a company created after sign-in is still the account's
 * (S629), and a founding company predating landlord_members has no member row.
 */
async function accountOwnsCompany(user: any, landlordId: string): Promise<boolean> {
  if (ownsLandlord(user, landlordId)) return true
  if (!/^[0-9a-f-]{36}$/i.test(landlordId)) return false
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one FROM landlord_members WHERE user_id = $1 AND landlord_id = $2::uuid
     UNION ALL
     SELECT 1 FROM landlords WHERE id = $2::uuid AND user_id = $1
     LIMIT 1`, [user.userId, landlordId])
  return rows.length > 0
}

// S459 — owner generalization. GAM Books is reused by BOTH landlords and
// business customers (apps/business). Every owner-scoped Books table now
// carries landlord_id XOR business_id (migration 20260619120000). This
// resolves which owner column + id applies to the caller. For landlord /
// admin / bookkeeper callers it returns { col:'landlord_id', id:<same as
// landlordScope> } — so `${col}` interpolation produces byte-identical SQL
// and landlord behavior is unchanged. For a business_owner it returns
// { col:'business_id', id:<businessId> }. business_owner always has a
// concrete businessId, so the `$1 IS NULL` admin-sees-all branch never
// fires for them (no cross-tenant leak).
//
// The column name is from this fixed two-value allowlist, never user input,
// so interpolating it into SQL is injection-safe.
type OwnerCol = 'landlord_id' | 'business_id'
function ownerScope(user: any): { col: OwnerCol; id: string | null } {
  if (user.role === 'business_owner') return { col: 'business_id', id: user.businessId }
  return { col: 'landlord_id', id: landlordScope(user) }
}

// S459: landlord-only Books surfaces — owner statements, rent roll, and the
// tax summary — are built on landlord rent concepts (properties / units /
// payments / disbursements / per-property state tax forms) that have no
// business-customer analog. business_owner is admitted to the rest of the
// engine but blocked here; these endpoints keep using landlordScope.
function blockBusinessOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role === 'business_owner') {
    return next(new AppError(403, 'Not available for business accounts'))
  }
  next()
}

/**
 * 10/12 (Nic): the Books routes a bookkeeper reaches WITHOUT the company-wide
 * box — the client list (how they pick a company), the company list and the
 * rent roll, which is cut to their properties. Everything else in Books is
 * the company's own books.
 */
const BOOKS_WITHOUT_COMPANY_WIDE = /^\/(bookkeeper\/clients|companies|rent-roll)\/?$/

/**
 * 10/12 (Nic, BK1): the whole-company ledger — what "May use the
 * whole-company ledger" opens for a bookkeeper without the company-wide box:
 * the chart of accounts, journal entries, transactions and their bank
 * reconciliation, bills and vendors (10/12: one list, contractors included),
 * loans and fixed assets, payroll (employees, runs), the tax summary, the P&L
 * and the balance sheet. NOT the cash flow or the
 * owner statements (they carry the payouts, the company-wide box's), and not
 * a Books route added later: it stays the company-wide box's until someone
 * decides it is ledger (deny by default).
 */
// 10/12 (Nic, ledger P7): the work-trade pay a landlord sent to Books is
// payroll's (W-2 paychecks, 1099 contractor bills), and a journal line names
// its property from the company's property list — both are the ledger's.
// 10/12 (Nic, ledger P8): the ledger's own statements — the trial balance,
// the general ledger, money out and whether the books are live — are the
// ledger's too (routes/booksLedgerReports).
// 10/13 (Nic): "each expense is chosen on the split or specific unit or
// property at the time of logging" — the company's properties and units the
// Loans, Fixed assets and Run Payroll forms ask that from (GET /cost-places)
// are the ledger's, as the property list those forms read before was.
const BOOKS_LEDGER = /^\/(?:(?:accounts|employees|vendors|loans|fixed-assets|payroll|journal|transactions|bills|work-trade-pay)(?:\/.*)?|properties\/?|cost-places\/?|reconciliation\/?|reports\/(?:pl|balance-sheet|trial-balance|general-ledger|money-out|receivables|ledger-status)\/?|tax\/summary\/?)$/

// S383 fix — bookkeeper client-scope validation middleware. Pre-fix bug:
// the middleware blindly accepted the X-Client-Id header without
// verifying the bookkeeper had a bookkeeper_scopes row for that
// landlord, AND treated a missing header as activeClientId=null. Both
// paths flowed into landlordScope returning null, which made every
// route's `WHERE landlord_id=$1 OR $1 IS NULL` guard match every row
// across every landlord — a critical cross-tenant privilege escalation.
// Now: missing header → 400; unrecognized client id → 403; the
// access_level is re-read from the live scope row and re-stamped onto
// req.user.permissions so a revoked / downgraded scope takes effect
// immediately instead of being stuck on the JWT's stale value.
//
// Routes that don't require an active client scope (e.g.
// GET /bookkeeper/clients, the discovery endpoint) live above
// requireBooksRead/Write and bypass this gate by virtue of the route's
// own authz check.
booksRouter.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    // S655: a landlord account with more than one company names the one whose
    // books it is reading with the same header a bookkeeper uses. It must be
    // the account's own company; with no header, landlordScope takes the
    // account's only company or asks which.
    if (req.user?.role === 'landlord') {
      // The company list is how Books learns which companies there are, so a
      // remembered choice that is no longer the account's never blocks it.
      if (req.path === '/companies') return next()
      const headerVal = req.headers['x-client-id']
      const clientId = Array.isArray(headerVal) ? headerVal[0] : headerVal
      if (clientId) {
        if (!(await accountOwnsCompany(req.user, clientId))) {
          throw new AppError(403, 'That company is not yours. Choose one of your own companies in Books.')
        }
        ;(req.user as any).activeClientId = clientId
      }
      return next()
    }
    if (req.user?.role !== 'bookkeeper') return next()
    // Discovery + invite routes don't need a scoped client — they ARE
    // how a bookkeeper finds out which clients they're assigned to.
    if (req.path === '/bookkeeper/clients') return next()
    const headerVal = req.headers['x-client-id']
    const clientId = Array.isArray(headerVal) ? headerVal[0] : headerVal
    if (!clientId) {
      throw new AppError(400, 'X-Client-Id header required for bookkeeper requests')
    }
    const [scope] = await bookkeeperScopesOf(req.user.userId, String(clientId))
    if (!scope) {
      throw new AppError(403, 'You are not assigned to this client')
    }
    // 10/11 (Nic): a bookkeeper keeps the properties ticked for them. 10/12:
    // refused only when they keep nothing of the company at all — no
    // company-wide box, no property, no former property (lib/bookkeeperScope).
    const bk = requestScopeOf(scope)
    if (bk.keepsNothing) throw new AppError(403, KEEPS_NOTHING)
    // 10/12 (Nic): the company's books — its ledger, payroll, bills, bank
    // reconciliation and company reports — are not split by property, so they
    // are the company-wide box's, the owner's own choice per bookkeeper. A
    // bookkeeper without it reaches only their rent roll here (their
    // properties' money is on the financial pages). Deny by default: a Books
    // route added later is company-wide until someone decides otherwise.
    // 10/12 (Nic, BK1): unless the owner ticked "May use the whole-company
    // ledger" for them — then the ledger (BOOKS_LEDGER) is theirs too, and
    // the rest (cash flow, owner statements) stays the company-wide box's.
    if (!bk.companyWide && !BOOKS_WITHOUT_COMPANY_WIDE.test(req.path)) {
      const ledgerRoute = BOOKS_LEDGER.test(req.path)
      if (!ledgerRoute) throw new AppError(403, companyWideRefusal(bk.ledger ? 'This report' : "The company's books"))
      if (!bk.ledger) throw new AppError(403, LEDGER_REFUSAL)
    }
    ;(req.user as any).activeClientId = clientId
    ;(req.user as any).permissions = {
      ...(req.user.permissions || {}),
      access_level: scope.access_level,
    }
    next()
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// CHART OF ACCOUNTS
// ════════════════════════════════════════

/**
 * 10/11: a request body checked by zod, refused with the schema's own plain
 * sentence ("Choose asset, liability, …") rather than the field path and
 * zod's wording.
 */
function parseBooks<T>(schema: z.ZodType<T, any, any>, body: unknown): T {
  const r = schema.safeParse(body ?? {})
  if (!r.success) throw new AppError(400, r.error.issues[0]?.message || 'Check the form and try again.')
  return r.data
}

/** A form's empty box is "not given", not an empty value (forms send ''). */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
/** An optional text box: trimmed, '' read as not given. */
/**
 * 10/11: the Books edit routes take their fields loose (COALESCE updates), so
 * the column sizes are checked here before Postgres answers "value too long",
 * in the same words the create schemas use.
 */
const BOOKS_FIELD_MAX: Record<string, [number, string]> = {
  firstName: [100, 'A first name'], lastName: [100, 'A last name'], email: [200, 'An email'],
  phone: [20, 'A phone number'], title: [100, 'A title'], department: [100, 'A department'],
  trade: [100, 'A trade'], businessName: [200, 'A business name'], name: [200, 'A vendor name'],
  contactName: [200, 'A contact name'], category: [100, 'A category'], accountNumber: [100, 'An account number'],
}
function assertBooksFieldsFit(body: any, keys: string[]): void {
  for (const k of keys) {
    const v = body?.[k]
    const rule = BOOKS_FIELD_MAX[k]
    if (rule && typeof v === 'string' && v.length > rule[0]) {
      throw new AppError(400, `${rule[1]} is ${rule[0]} characters at most.`)
    }
  }
}
const optionalText = (max = 500) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional())
const isoDate = (what: string) => z.string({ required_error: `Enter the ${what}.` })
  .regex(/^\d{4}-\d{2}-\d{2}$/, `Enter the ${what} as a date.`)

/** 10/11: a unique-index refusal (Postgres 23505) on the given index. */
const isUniqueViolation = (e: any, index: string) => e?.code === '23505' && String(e?.constraint || '') === index

/**
 * 10/11: each account carries its balance the way people read it
 * (normal_balance: a liability owed, equity and income earned are positive),
 * beside the stored debits-minus-credits figure every posting adds to
 * (booksNormalBalance, packages/shared).
 */
const withNormalBalance = (a: any) => ({ ...a, normal_balance: booksNormalBalance(a.type, a.balance) })

const ACCOUNT_TYPE_REFUSAL = 'Choose the account type: asset, liability, equity, income or expense.'
const accountTypeSchema = z.enum(BOOKS_ACCOUNT_TYPES, { errorMap: () => ({ message: ACCOUNT_TYPE_REFUSAL }) })

/** 10/12 (Nic, review): passes refuseScopedStaff for a whole-company ledger statement (no throw). */
async function mayReadWholeLedger(user: any): Promise<boolean> {
  try {
    await refuseScopedStaff(user, 'chart of accounts', { ledger: true })
    return true
  } catch (e) {
    if (e instanceof AppError && e.statusCode === 403) return false
    throw e
  }
}

// GET /api/books/accounts — the active chart. 10/11: ?includeInactive=true
// lists deactivated accounts too, so one can be found and turned back on.
booksRouter.get('/accounts', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const includeInactive = String(req.query.includeInactive ?? '') === 'true'
    // 10/12 (Nic, ledger P7): each account says whether the books hold
    // anything on it (in_use: posted lines, hand journal lines, or a posting
    // role pointing at it today) — such an account is turned off only by
    // choosing the account that takes its place.
    const { rows } = await db.query(
      `SELECT a.*, ${ACCOUNT_IN_USE_SQL} AS in_use
       FROM books_accounts a
       WHERE (a.${col} = $1 OR $1 IS NULL)
       AND (a.active = TRUE OR $2::boolean)
       ORDER BY a.code ASC`,
      [lid, includeInactive]
    )
    // 10/12 (Nic, ledger P8): once the company's books are live, each
    // account's balance is the ledger's today — every automatic posting and
    // the journal entries — the figure the balance sheet and trial balance
    // show (the stored balance holds journal entries only; P10 retires it).
    // 10/12 (Nic, review): only for a viewer who may read the whole-company
    // ledger (the balance sheet's and trial balance's rule, refuseScopedStaff):
    // a team member assigned to some properties keeps the chart with its
    // stored balances, as before P8 — never the books' bank balances,
    // receivables and deposits held.
    if (col === 'landlord_id' && lid && await ledgerReportsLive([lid]) && await mayReadWholeLedger(req.user)) {
      const bal = await ledgerAccountBalances(await wholeLedgerScope(req.user, lid), todayIn(null))
      return res.json({ success: true, data: rows.map((a: any) => withNormalBalance({ ...a, balance: bal.get(a.id) ?? '0.00', balance_source: 'ledger' })) })
    }
    res.json({ success: true, data: rows.map(withNormalBalance) })
  } catch (e) { next(e) }
})

// POST /api/books/accounts
// 10/11: the type is one of the five every report reads (BOOKS_ACCOUNT_TYPES;
// books_accounts_type_check holds the same list). An account typed anything
// else used to save and then fall out of every report. Codes are unique per
// company (books_accounts_*_code_key); two saves at once used to slip a
// duplicate past the check-then-insert.
const accountCreateSchema = z.object({
  code:        z.string({ required_error: 'Enter an account code.' }).trim().min(1, 'Enter an account code.').max(20, 'An account code is 20 characters at most.'),
  name:        z.string({ required_error: 'Enter the account name.' }).trim().min(1, 'Enter the account name.').max(200),
  type:        accountTypeSchema,
  subtype:     optionalText(50),
  description: optionalText(2000),
})
booksRouter.post('/accounts', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const body = parseBooks(accountCreateSchema, req.body)
    // The owner's own chart (an admin's ownerless accounts are their own chart).
    const exists = await queryOne(
      `SELECT id FROM books_accounts WHERE code=$1 AND ${col} IS NOT DISTINCT FROM $2`,
      [body.code, lid]
    )
    if (exists) throw new AppError(409, `Account code ${body.code} already exists`)
    try {
      const { rows: [acct] } = await db.query(
        `INSERT INTO books_accounts (${col}, code, name, type, subtype, description)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [lid, body.code, body.name, body.type, body.subtype ?? null, body.description ?? null]
      )
      res.status(201).json({ success: true, data: withNormalBalance(acct) })
    } catch (e: any) {
      if (isUniqueViolation(e, `books_accounts_${col === 'business_id' ? 'business' : 'landlord'}_code_key`)) {
        throw new AppError(409, `Account code ${body.code} already exists`)
      }
      throw e
    }
  } catch (e) { next(e) }
})

/**
 * 10/11: an account is turned off only once nothing is in it. An account
 * deactivated with money in it disappeared from the chart and the balance
 * sheet, so the sheet stopped adding up and nobody could see why.
 */
function balanceRefusal(acct: { name: string; balance: any; type: string }): AppError {
  const shown = booksNormalBalance(acct.type, acct.balance)
  const amount = Math.abs(shown).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  return new AppError(409, `${acct.name} still has a balance of ${shown < 0 ? '-' : ''}${amount}. Move it to another account with a journal entry, then deactivate this one.`)
}

/**
 * 10/12 (Nic, ledger P7): does the company's ledger hold anything on account
 * `a` — lines the ledger posted to it (automatic postings and mirrored journal
 * entries), hand journal lines, or a posting role pointing at it today? SQL
 * over `a` (books_accounts).
 */
const ACCOUNT_IN_USE_SQL = `(EXISTS (SELECT 1 FROM ledger_posting_lines l WHERE l.account_id = a.id)
   OR EXISTS (SELECT 1 FROM journal_entry_lines j WHERE j.account_id = a.id)
   OR EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (m.map_kind, m.map_value) m.account_id
                              FROM books_account_map m
                             WHERE (a.landlord_id IS NOT NULL AND m.landlord_id = a.landlord_id)
                                OR (a.business_id IS NOT NULL AND m.business_id = a.business_id)
                             ORDER BY m.map_kind, m.map_value, m.effective_from DESC, m.id DESC) cur
               WHERE cur.account_id = a.id))`

/** What the ledger holds on one account: its posted lines and balance, hand lines, and whether a role points at it. */
async function accountLedgerUse(accountId: string): Promise<{ ledgerLines: boolean; journalLines: boolean; mapped: boolean; ledgerBalance: number }> {
  const r = await queryOne<any>(
    `SELECT EXISTS (SELECT 1 FROM ledger_posting_lines l WHERE l.account_id = a.id) AS ledger_lines,
            EXISTS (SELECT 1 FROM journal_entry_lines j WHERE j.account_id = a.id) AS journal_lines,
            EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (m.map_kind, m.map_value) m.account_id
                                     FROM books_account_map m
                                    WHERE (a.landlord_id IS NOT NULL AND m.landlord_id = a.landlord_id)
                                       OR (a.business_id IS NOT NULL AND m.business_id = a.business_id)
                                    ORDER BY m.map_kind, m.map_value, m.effective_from DESC, m.id DESC) cur
                     WHERE cur.account_id = a.id) AS mapped,
            COALESCE((SELECT sum(l.debit - l.credit) FROM ledger_posting_lines l WHERE l.account_id = a.id), 0)::text AS ledger_balance
       FROM books_accounts a WHERE a.id = $1`, [accountId])
  return {
    ledgerLines: !!r?.ledger_lines, journalLines: !!r?.journal_lines, mapped: !!r?.mapped,
    ledgerBalance: Number(r?.ledger_balance ?? 0),
  }
}

/**
 * Why an account cannot be turned off as it stands (null: it can). 10/11: an
 * account is turned off only once nothing is in it — deactivated with money in
 * it, it disappeared from the chart and the balance sheet stopped adding up.
 * 10/12 (Nic, ledger P7): "in it" is the ledger's balance as well as the
 * chart's running figure, and an account the books hold history on (or a
 * posting role points at) is turned off only by choosing the account that
 * takes its place (retireAccount — its open months move there).
 */
async function deactivationRefusal(acct: { id: string; name: string; balance: any; type: string }): Promise<AppError | null> {
  if (booksCents(acct.balance) !== 0) return balanceRefusal(acct)
  const use = await accountLedgerUse(acct.id)
  if (booksCents(use.ledgerBalance) !== 0) return balanceRefusal({ ...acct, balance: use.ledgerBalance })
  if (use.mapped) return new AppError(409, `${acct.name} is where automatic postings go. Choose the account that takes its place.`)
  if (use.ledgerLines || use.journalLines) return new AppError(409, `${acct.name} has posted history. Choose the account that takes its place.`)
  return null
}

/** Turns an account off when nothing is in it; refuses (409) when something is, 404 when it is not this owner's. */
async function deactivateAccount(col: OwnerCol, lid: string | null, id: string): Promise<any> {
  const acct = await queryOne<any>(
    `SELECT * FROM books_accounts WHERE id=$1 AND (${col}=$2 OR $2 IS NULL)`, [id, lid])
  if (!acct) throw new AppError(404, 'Account not found')
  const refusal = await deactivationRefusal(acct)
  if (refusal) throw refusal
  // One statement: the zero test and the switch happen together, so a journal
  // entry posting to the account at the same moment cannot slip money in
  // between (posting locks the account row and refuses an inactive one). The
  // database refuses it too while the ledger holds history on it.
  try {
    const { rows: [off] } = await db.query(
      `UPDATE books_accounts SET active=FALSE, updated_at=NOW()
        WHERE id=$1 AND (${col}=$2 OR $2 IS NULL) AND balance = 0
        RETURNING *`,
      [id, lid]
    )
    if (off) return off
  } catch (e) { throw ledgerGuardRefusal(e) ?? e }
  const again = await queryOne<any>(`SELECT * FROM books_accounts WHERE id=$1`, [id])
  throw balanceRefusal(again ?? acct)
}

/**
 * 10/12 (Nic, ledger P7): turns an account off in favor of the account that
 * takes its place (services/booksLedgerChart.retireAccount): every posting
 * role pointing at it moves there and its open months' postings follow at the
 * next drain; its closed months keep it. Same company, same type, active.
 */
async function retireAccountFor(user: any, col: OwnerCol, lid: string | null, id: string, replacementAccountId: string): Promise<any> {
  const acct = await queryOne<any>(`SELECT * FROM books_accounts WHERE id=$1 AND (${col}=$2 OR $2 IS NULL)`, [id, lid])
  if (!acct) throw new AppError(404, 'Account not found')
  const owner = acct.landlord_id ? { landlordId: acct.landlord_id as string } : acct.business_id ? { businessId: acct.business_id as string } : null
  if (!owner) throw new AppError(400, 'This account belongs to no company\'s books.')
  try {
    await retireAccount({ owner, accountId: acct.id, replacementAccountId, actorUserId: user.userId })
  } catch (e) { throw ledgerGuardRefusal(e) ?? e }
  return queryOne<any>(`SELECT * FROM books_accounts WHERE id=$1`, [acct.id])
}

// PATCH /api/books/accounts/:id — rename, describe, turn off or back on.
// 10/11: only the fields sent change; active=false goes through the same
// zero-balance rule as DELETE; a type change is checked against the list and
// refused once the account has entries (they were posted under the old type,
// and every report would silently move them).
const accountPatchSchema = z.object({
  name:        z.string().trim().min(1, 'Enter the account name.').max(200).optional(),
  subtype:     z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(50).nullable().optional()),
  description: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(2000).nullable().optional()),
  active:      z.boolean({ invalid_type_error: 'active is true or false.' }).optional(),
  type:        accountTypeSchema.optional(),
  // 10/12 (Nic, ledger P7): with active=false, the account that takes its place.
  replacementAccountId: z.string().uuid('Choose the account that takes its place from the list.').optional(),
})
booksRouter.patch('/accounts/:id', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const body = parseBooks(accountPatchSchema, req.body)
    const current = await queryOne<any>(
      `SELECT * FROM books_accounts WHERE id=$1 AND (${col}=$2 OR $2 IS NULL)`, [req.params.id, lid])
    if (!current) throw new AppError(404, 'Account not found')
    // 10/12 (Nic, ledger P7): the type is fixed once the books hold anything
    // on the account — journal lines, lines the ledger posted, or a posting
    // role pointing at it — since every report would silently move them.
    if (body.type !== undefined && body.type !== current.type) {
      const use = await accountLedgerUse(current.id)
      if (use.mapped) throw new AppError(409, `${current.name} is where automatic postings go, so its type cannot change. Add a new account of the right type and point the posting role at it.`)
      if (use.journalLines) throw new AppError(409, `${current.name} already has journal entries, so its type cannot change. Make a new account of the right type and move the balance with a journal entry.`)
      if (use.ledgerLines) throw new AppError(409, `${current.name} already carries automatic postings, so its type cannot change. Make a new account of the right type and move the balance with a journal entry.`)
    }
    if (body.replacementAccountId !== undefined && body.active !== false) {
      throw new AppError(400, 'An account takes another\'s place only when that one is turned off.')
    }
    // Refused before anything else in the request changes.
    if (body.active === false && current.active && body.replacementAccountId === undefined) {
      const refusal = await deactivationRefusal(current)
      if (refusal) throw refusal
    }
    const sets: string[] = []
    const params: any[] = []
    const set = (column: string, v: any) => { params.push(v); sets.push(`${column}=$${params.length}`) }
    if (body.name !== undefined) set('name', body.name)
    if (body.subtype !== undefined) set('subtype', body.subtype)
    if (body.description !== undefined) set('description', body.description)
    if (body.type !== undefined) set('type', body.type)
    if (body.active === true) set('active', true)
    let acct = current
    if (sets.length) {
      params.push(current.id)
      try {
        const { rows: [updated] } = await db.query(
          `UPDATE books_accounts SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
          params
        )
        acct = updated
      } catch (e) { throw ledgerGuardRefusal(e) ?? e }
    }
    if (body.active === false && acct.active) {
      acct = body.replacementAccountId
        ? await retireAccountFor(req.user, col, lid, current.id, body.replacementAccountId)
        : await deactivateAccount(col, lid, current.id)
    }
    res.json({ success: true, data: withNormalBalance(acct) })
  } catch (e) { next(e) }
})

// DELETE /api/books/accounts/:id — deactivates (never removes; GAM keeps
// everything). 10/11: refused while the account holds a balance, 404 when the
// account is not the caller's (it used to answer success either way).
booksRouter.delete('/accounts/:id', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    await deactivateAccount(col, lid, req.params.id)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// Landlord (property-management) default chart of accounts.
const LANDLORD_COA = [
  // Assets
  { code:'1010', name:'Checking Account',           type:'asset',     subtype:'bank' },
  { code:'1020', name:'Savings / Reserve Account',  type:'asset',     subtype:'bank' },
  { code:'1030', name:'Security Deposits Held',     type:'asset',     subtype:'current' },
  { code:'1100', name:'Accounts Receivable',        type:'asset',     subtype:'current' },
  { code:'1200', name:'Prepaid Expenses',           type:'asset',     subtype:'current' },
  { code:'1500', name:'Rental Property',            type:'asset',     subtype:'fixed' },
  { code:'1510', name:'Accumulated Depreciation',   type:'asset',     subtype:'fixed' },
  // Liabilities
  { code:'2010', name:'Accounts Payable',           type:'liability', subtype:'current' },
  { code:'2020', name:'Security Deposits Payable',  type:'liability', subtype:'current' },
  { code:'2030', name:'Payroll Liabilities',        type:'liability', subtype:'current' },
  { code:'2040', name:'Sales Tax Payable',          type:'liability', subtype:'current' },
  { code:'2100', name:'Mortgage Payable',           type:'liability', subtype:'longterm' },
  // Equity
  { code:'3010', name:'Owner Equity',               type:'equity',    subtype:null },
  { code:'3020', name:'Owner Draws',                type:'equity',    subtype:null },
  { code:'3030', name:'Retained Earnings',          type:'equity',    subtype:null },
  // Income
  { code:'4010', name:'Rental Income',              type:'income',    subtype:'operating' },
  { code:'4020', name:'Late Fee Income',            type:'income',    subtype:'operating' },
  { code:'4030', name:'Application Fee Income',     type:'income',    subtype:'operating' },
  { code:'4040', name:'Pet Fee Income',             type:'income',    subtype:'operating' },
  { code:'4050', name:'Laundry / Vending Income',   type:'income',    subtype:'operating' },
  { code:'4060', name:'Storage Fee Income',         type:'income',    subtype:'operating' },
  { code:'4070', name:'Utility Reimbursements',     type:'income',    subtype:'operating' },
  { code:'4900', name:'Other Income',               type:'income',    subtype:'other' },
  // Expenses
  { code:'5010', name:'Mortgage / Loan Interest',   type:'expense',   subtype:'operating' },
  { code:'5020', name:'Property Taxes',             type:'expense',   subtype:'operating' },
  { code:'5030', name:'Property Insurance',         type:'expense',   subtype:'operating' },
  { code:'5040', name:'Repairs & Maintenance',      type:'expense',   subtype:'operating' },
  { code:'5050', name:'Utilities',                  type:'expense',   subtype:'operating' },
  { code:'5060', name:'Landscaping',                type:'expense',   subtype:'operating' },
  { code:'5070', name:'Pest Control',               type:'expense',   subtype:'operating' },
  { code:'5080', name:'Property Management Fees',   type:'expense',   subtype:'operating' },
  { code:'5090', name:'Advertising & Marketing',    type:'expense',   subtype:'operating' },
  { code:'5100', name:'Legal & Professional Fees',  type:'expense',   subtype:'operating' },
  { code:'5110', name:'Accounting & Bookkeeping',   type:'expense',   subtype:'operating' },
  { code:'5120', name:'Payroll Expenses',           type:'expense',   subtype:'operating' },
  { code:'5130', name:'Contractor Payments',        type:'expense',   subtype:'operating' },
  { code:'5140', name:'Office Supplies',            type:'expense',   subtype:'operating' },
  { code:'5150', name:'Software & Subscriptions',   type:'expense',   subtype:'operating' },
  { code:'5160', name:'Vehicle & Travel',           type:'expense',   subtype:'operating' },
  { code:'5170', name:'Depreciation Expense',       type:'expense',   subtype:'operating' },
  { code:'5900', name:'Other Expenses',             type:'expense',   subtype:'other' },
]

// S459: service/retail business default chart of accounts. Generic across
// the GAM business types (trash hauling, mechanic, mini-market, equipment
// rental) — no property-management concepts.
const BUSINESS_COA = [
  // Assets
  { code:'1010', name:'Checking Account',           type:'asset',     subtype:'bank' },
  { code:'1020', name:'Savings Account',            type:'asset',     subtype:'bank' },
  { code:'1100', name:'Accounts Receivable',        type:'asset',     subtype:'current' },
  { code:'1200', name:'Inventory',                  type:'asset',     subtype:'current' },
  { code:'1500', name:'Equipment & Vehicles',       type:'asset',     subtype:'fixed' },
  // Liabilities
  { code:'2010', name:'Accounts Payable',           type:'liability', subtype:'current' },
  { code:'2030', name:'Payroll Liabilities',        type:'liability', subtype:'current' },
  { code:'2040', name:'Sales Tax Payable',          type:'liability', subtype:'current' },
  // Equity
  { code:'3010', name:'Owner Equity',               type:'equity',    subtype:null },
  { code:'3020', name:'Owner Draws',                type:'equity',    subtype:null },
  { code:'3030', name:'Retained Earnings',          type:'equity',    subtype:null },
  // Income
  { code:'4010', name:'Service Revenue',            type:'income',    subtype:'operating' },
  { code:'4020', name:'Product Sales',              type:'income',    subtype:'operating' },
  { code:'4030', name:'Rental Income',              type:'income',    subtype:'operating' },
  { code:'4900', name:'Other Income',               type:'income',    subtype:'other' },
  // Expenses
  { code:'5010', name:'Cost of Goods Sold',         type:'expense',   subtype:'operating' },
  { code:'5020', name:'Wages & Payroll',            type:'expense',   subtype:'operating' },
  { code:'5030', name:'Fuel & Vehicle',             type:'expense',   subtype:'operating' },
  { code:'5040', name:'Equipment & Supplies',       type:'expense',   subtype:'operating' },
  { code:'5050', name:'Rent & Utilities',           type:'expense',   subtype:'operating' },
  { code:'5060', name:'Insurance',                  type:'expense',   subtype:'operating' },
  { code:'5070', name:'Repairs & Maintenance',      type:'expense',   subtype:'operating' },
  { code:'5080', name:'Advertising & Marketing',    type:'expense',   subtype:'operating' },
  { code:'5090', name:'Office & Software',          type:'expense',   subtype:'operating' },
  { code:'5100', name:'Legal & Professional',       type:'expense',   subtype:'operating' },
  { code:'5110', name:'Bank & Processing Fees',     type:'expense',   subtype:'operating' },
  { code:'5900', name:'Other Expenses',             type:'expense',   subtype:'other' },
]

// POST /api/books/accounts/seed — seed a standard chart of accounts
// appropriate to the owner type (landlord PM vs service/retail business).
booksRouter.post('/accounts/seed', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const standardAccounts = col === 'business_id' ? BUSINESS_COA : LANDLORD_COA
    let inserted = 0
    for (const a of standardAccounts) {
      // 10/11: the owner's own chart; a code already in it is skipped, also
      // when a second click is seeding at the same moment (the per-company
      // unique code index — ON CONFLICT DO NOTHING).
      const exists = await queryOne(
        `SELECT id FROM books_accounts WHERE code=$1 AND ${col} IS NOT DISTINCT FROM $2`,
        [a.code, lid]
      )
      if (!exists) {
        const r = await db.query(
          `INSERT INTO books_accounts (${col}, code, name, type, subtype, is_system)
           VALUES ($1,$2,$3,$4,$5,TRUE)
           ON CONFLICT DO NOTHING`,
          [lid, a.code, a.name, a.type, a.subtype]
        )
        inserted += r.rowCount ?? 0
      }
    }
    res.json({ success: true, data: { inserted, message: `${inserted} accounts added` } })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// EMPLOYEES
// ════════════════════════════════════════

/**
 * 10/11 — AN EMPLOYEE'S YEAR-TO-DATE IS ONE CALENDAR YEAR.
 *
 * books_employees.ytd_* is a running total since the employee was added:
 * approving a run adds to it, voiding one takes it back, and nothing resets it
 * at New Year. Read as year-to-date it was lifetime pay, so the Social Security
 * wage-base check stopped withholding in an employee's second year and the Tax
 * Center's W-2 table showed every year's pay under this year. Year-to-date is
 * now worked out from the approved payroll runs PAID in that calendar year
 * (wages belong to the year they are paid). The stored columns are left as
 * they are (a lifetime total nothing reads for a year's figures).
 */
type EmployeeYear = {
  ytd_gross: number; ytd_federal_tax: number; ytd_state_tax: number
  ytd_ss: number; ytd_medicare: number; ytd_net: number
}
const NO_PAY_YET: EmployeeYear = { ytd_gross: 0, ytd_federal_tax: 0, ytd_state_tax: 0, ytd_ss: 0, ytd_medicare: 0, ytd_net: 0 }
async function employeeYearTotals(employeeIds: string[], year: number): Promise<Map<string, EmployeeYear>> {
  const out = new Map<string, EmployeeYear>()
  if (!employeeIds.length) return out
  const rows = await query<any>(
    `SELECT prl.employee_id,
            COALESCE(SUM(prl.gross_pay), 0)::text    AS ytd_gross,
            COALESCE(SUM(prl.federal_tax), 0)::text  AS ytd_federal_tax,
            COALESCE(SUM(prl.state_tax), 0)::text    AS ytd_state_tax,
            COALESCE(SUM(prl.ss_tax), 0)::text       AS ytd_ss,
            COALESCE(SUM(prl.medicare_tax), 0)::text AS ytd_medicare,
            COALESCE(SUM(prl.net_pay), 0)::text      AS ytd_net
       FROM payroll_run_lines prl
       JOIN payroll_runs pr ON pr.id = prl.run_id
      WHERE prl.employee_id = ANY($1::uuid[])
        AND pr.status = 'approved'
        AND pr.pay_date >= make_date($2::int, 1, 1)
        AND pr.pay_date <  make_date($2::int + 1, 1, 1)
      GROUP BY prl.employee_id`,
    [employeeIds, year])
  for (const r of rows) {
    out.set(r.employee_id, {
      ytd_gross: Number(r.ytd_gross), ytd_federal_tax: Number(r.ytd_federal_tax),
      ytd_state_tax: Number(r.ytd_state_tax), ytd_ss: Number(r.ytd_ss),
      ytd_medicare: Number(r.ytd_medicare), ytd_net: Number(r.ytd_net),
    })
  }
  return out
}

// GET /api/books/employees — 10/11: ytd_* is THIS calendar year's pay (by
// GAM's home-zone calendar, as the Tax Center's "this year"), and ytd_year says
// which year that is.
booksRouter.get('/employees', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const { rows } = await db.query(
      // 10/14 (Nic): where each employee's pay goes, with its property's name.
      `SELECT e.*, (SELECT p.name FROM properties p WHERE p.id = e.pay_property_id) AS pay_property_name
         FROM books_employees e WHERE (e.${col}=$1 OR $1 IS NULL) ORDER BY e.last_name, e.first_name`,
      [lid]
    )
    const year = Number(todayIn(null).slice(0, 4))
    const totals = await employeeYearTotals(rows.map((r: any) => r.id), year)
    res.json({
      success: true,
      data: rows.map((r: any) => ({ ...r, ...(totals.get(r.id) ?? NO_PAY_YET), ytd_year: year })),
    })
  } catch (e) { next(e) }
})

// S416 (S412 fan-out): strict zod validation on POST /employees.
// Same posture as the S384 contractors decision: "all fields required"
// by default. Pre-fix only firstName/lastName/payType/payRate were
// hand-checked; everything else passed through as null.
//
// S91 back-compat: stateWithholdingPct is the new generic name; the
// legacy azWithholdingPct is still accepted for callers that haven't
// updated. Either satisfies the required gate.
const employeeBaseSchema = z.object({
  // 10/11: the column sizes (varchar), said in words. Past them Postgres
  // answered "value too long" and the form showed that raw.
  firstName:           z.string().trim().min(1).max(100, 'A first name is 100 characters at most.'),
  lastName:            z.string().trim().min(1).max(100, 'A last name is 100 characters at most.'),
  email:               z.string().trim().email('valid email required').max(200, 'An email is 200 characters at most.'),
  phone:               z.string().trim().min(7).max(20, 'A phone number is 20 characters at most.'),
  address:             z.string().trim().min(1),
  ssnLast4:            z.string().trim().regex(/^\d{4}$/, 'ssnLast4 must be 4 digits'),
  // 10/11: one list each with the Add Employee form (packages/shared
  // booksLedger). The form offered 'married_higher', which this refused, so
  // the form could not save.
  payType:             z.enum(BOOKS_PAY_TYPES),
  payRate:             z.number().positive(),
  payFrequency:        z.enum(BOOKS_PAY_FREQUENCIES),
  filingStatus:        z.enum(BOOKS_EMPLOYEE_FILING_STATUSES),
  federalAllowances:   z.number().int().min(0),
  // Either the new name OR the legacy az* name; at least one required.
  stateWithholdingPct: z.number().min(0).max(100).optional(),
  azWithholdingPct:    z.number().min(0).max(100).optional(),
  title:               z.string().trim().min(1).max(100, 'A title is 100 characters at most.'),
  department:          z.string().trim().min(1).max(100, 'A department is 100 characters at most.'),
  startDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
}).refine(
  (v) => v.stateWithholdingPct !== undefined || v.azWithholdingPct !== undefined,
  { message: 'stateWithholdingPct (or legacy azWithholdingPct) required',
    path: ['stateWithholdingPct'] },
)
booksRouter.post('/employees', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const body = employeeBaseSchema.parse(req.body)
    // S417: disposable-domain block (same Set as tenant /profile).
    if (isDisposableEmail(body.email)) {
      throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
    }
    const stateRate = body.stateWithholdingPct ?? body.azWithholdingPct ?? 0
    // 10/14 (Nic): "an employee at one property goes to that property ...
    // once you set it it shouldnt change. if they work at multiple properties
    // it would be at the company level" — a landlord company's new employee
    // says where their pay goes (services/booksEmployeePayPlace).
    const landlordId = col === 'landlord_id' ? lid : null
    const payPlace = (await employeePayPlaceFrom(db, landlordId, req.body)).value
    if (landlordId && !payPlace) throw new AppError(400, EMPLOYEE_PAY_PLACE_REQUIRED)
    const { rows: [emp] } = await db.query(
      `INSERT INTO books_employees
         (${col}, first_name, last_name, email, phone, address, ssn_last4,
          pay_type, pay_rate, pay_frequency, filing_status, federal_allowances,
          state_withholding_pct, title, department, start_date,
          pay_place, pay_property_id, pay_place_set_at, pay_place_set_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,CASE WHEN $17::text IS NULL THEN NULL ELSE NOW() END,CASE WHEN $17::text IS NULL THEN NULL ELSE $19::uuid END)
       RETURNING *`,
      [lid, body.firstName, body.lastName, body.email, body.phone, body.address, body.ssnLast4,
       body.payType, body.payRate, body.payFrequency, body.filingStatus,
       body.federalAllowances, stateRate, body.title, body.department, body.startDate,
       payPlace?.place ?? null, payPlace?.propertyId ?? null, req.user!.userId]
    )
    res.status(201).json({ success: true, data: emp })
  } catch (e) { next(e) }
})

booksRouter.patch('/employees/:id', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const f = req.body
    assertBooksFieldsFit(f, ['firstName', 'lastName', 'email', 'phone', 'title', 'department'])
    // 10/11: pay type and frequency, when sent, are from the shared lists (as
    // on create) — payroll reads both. Checked before anything is saved.
    if (f.payType != null && f.payType !== '' && !(BOOKS_PAY_TYPES as readonly string[]).includes(f.payType)) {
      throw new AppError(400, 'Pay type is hourly or salary.')
    }
    if (f.payFrequency != null && f.payFrequency !== '' && !(BOOKS_PAY_FREQUENCIES as readonly string[]).includes(f.payFrequency)) {
      throw new AppError(400, 'Choose how often this employee is paid: weekly, every two weeks, twice a month or monthly.')
    }
    // 10/14 (Nic): where the employee's pay goes — set by anyone who keeps the
    // books (an employee added before 10/14 has none until it is set here).
    // 10/14 afternoon (Nic): "the owner can change it; only future paychecks
    // follow" — only the owner's different answer is saved, and the
    // employee's paychecks on draft runs move with it; approved runs stay as
    // they posted (services/booksEmployeePayPlace). Saved with the rest of the
    // form, in one transaction.
    const payPlace = await employeePayPlaceFrom(db, col === 'landlord_id' ? lid : null, f)
    const client = await db.connect()
    let emp: any
    try {
      await client.query('BEGIN')
      if (payPlace.given) {
        const cur = (await client.query<{ id: string; pay_place: string | null; pay_property_id: string | null }>(
          `SELECT id, pay_place, pay_property_id FROM books_employees WHERE id = $1 AND (${col} = $2 OR $2 IS NULL)`,
          [req.params.id, lid])).rows[0]
        if (!cur) throw new AppError(404, 'Employee not found')
        if (!payPlace.value) {
          // A paycheck always goes somewhere: a place is changed, never taken away.
          if (cur.pay_place) throw new AppError(409, EMPLOYEE_PAY_PLACE_REQUIRED)
        } else {
          await setEmployeePayPlace(client, cur, payPlace.value, req.user!.userId, { owner: req.user!.role === 'landlord' })
        }
      }
      emp = (await client.query(
        `UPDATE books_employees SET
           first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
           email=COALESCE($3,email), phone=COALESCE($4,phone), title=COALESCE($5,title),
           department=COALESCE($6,department), pay_type=COALESCE($7,pay_type),
           pay_rate=COALESCE($8,pay_rate), pay_frequency=COALESCE($9,pay_frequency),
           status=COALESCE($10,status), updated_at=NOW()
         WHERE id=$11 AND (${col}=$12 OR $12 IS NULL) RETURNING *`,
        [f.firstName||null, f.lastName||null, f.email||null, f.phone||null,
         f.title||null, f.department||null, f.payType||null, f.payRate||null,
         f.payFrequency||null, f.status||null, req.params.id, lid]
      )).rows[0]
      if (!emp) throw new AppError(404, 'Employee not found')
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    res.json({ success: true, data: emp })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// VENDORS, LOANS AND FIXED ASSETS
// ════════════════════════════════════════

// 10/12 (Nic): "VENDORS = one list of everyone the company pays (contractors,
// garbage company, power company) with a type; contractors get a 1099 box";
// loans (principal / interest / escrow per payment) and fixed assets with
// depreciation. The separate Contractors (1099) routes are gone — a contractor
// is a vendor of type contractor (the old list was folded in, migration
// 20261014190000). The routes live in routes/booksLoansAssets.ts and hang on
// this router, after its sign-in and company checks above.
registerBooksLoansAssetsRoutes(booksRouter, { ownerScope })

// ════════════════════════════════════════
// PAYROLL RUNS
// ════════════════════════════════════════

// Payroll tax helper.
// S592 (Nic): federal + state income-tax withholding are ENTERED BY THE
// BOOKKEEPER per employee — GAM does NOT compute income-tax withholding, so it
// stays out of tax-withholding decisions (and the friction/liability of getting
// IRS/state tables wrong). Social Security (6.2% up to the annual wage base) and
// Medicare (1.45% + 0.9% over $200k) ARE auto-computed here: those are fixed
// statutory rates, identical for everyone, so calculating them is arithmetic,
// not a withholding judgment. Net = gross − federal − state − SS − Medicare.
// State-specific quarterly forms (CA DE-9, NY NYS-45, AZ A1-QRT, etc.) are NOT
// generated here — they live in the landlord-configurable tax-form catalog (S91).
//
// 10/11: `ytdGross` is the employee's pay so far in the PAY DATE's calendar
// year (employeeYearTotals — it used to be a lifetime total, so Social
// Security stopped being withheld in an employee's second year), and the wage
// base is that year's (socialSecurityWageBase, packages/shared — it was a
// hardcoded 2024 figure, $168,600).
function payrollTaxes(grossPay: number, ytdGross: number, federalTax: number, stateTax: number, ssWageBase: number) {
  // Social Security: 6.2% up to the year's wage base
  const ssEligible = Math.max(0, Math.min(grossPay, ssWageBase - ytdGross))
  const ssTax = +(ssEligible * 0.062).toFixed(2)

  // Medicare: 1.45%, plus the 0.9% Additional Medicare Tax on only the wages
  // above $200,000 for the year (10/11: it was charged on the whole check once
  // the year crossed $200k — $195,000 so far and a $10,000 check withheld $90,
  // not $45). The employer never pays the 0.9%; see the Tax Center.
  const overAdditional = Math.max(0, Math.min(grossPay, ytdGross + grossPay - 200000))
  const medicareTax = +(grossPay * 0.0145 + overAdditional * 0.009).toFixed(2)

  // Federal + state: bookkeeper-supplied dollar amounts (default 0 if omitted).
  const fed   = +(Math.max(0, +federalTax || 0)).toFixed(2)
  const state = +(Math.max(0, +stateTax   || 0)).toFixed(2)

  const netPay = +(grossPay - fed - state - ssTax - medicareTax).toFixed(2)

  return { federalTax: fed, stateTax: state, ssTax, medicareTax, netPay }
}

/**
 * 10/12 (Nic, ledger P7): a payroll run as the Books pages read it — its days
 * as 'YYYY-MM-DD' (node-postgres hands a date column over as a Date at the
 * server's midnight, which the pages' "date + T12:00:00" could not read).
 */
const PAYROLL_RUN_COLUMNS = `pr.*, pr.pay_date::text AS pay_date, pr.period_start::text AS period_start, pr.period_end::text AS period_end,
  (SELECT p.name FROM properties p WHERE p.id = pr.property_id) AS property_name,
  (SELECT u.unit_number FROM units u WHERE u.id = pr.unit_id) AS unit_number`

/** A date column's value (a Date at the server's midnight, or text) as 'YYYY-MM-DD'. */
function toIsoDay(v: unknown): string {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return String(v ?? '').slice(0, 10)
}

// GET /api/books/payroll/runs
booksRouter.get('/payroll/runs', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const { rows } = await db.query(
      `SELECT ${PAYROLL_RUN_COLUMNS}, COUNT(prl.id) as line_count
       FROM payroll_runs pr
       LEFT JOIN payroll_run_lines prl ON prl.run_id = pr.id
       WHERE (pr.${col} = $1 OR $1 IS NULL)
       GROUP BY pr.id
       ORDER BY pr.pay_date DESC`,
      [lid]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/books/payroll/runs/:id — 10/12 (Nic, ledger P7): each paycheck
// carries the employer's taxes on it, and a work-trade extra-hours paycheck
// says which month's hours it pays.
booksRouter.get('/payroll/runs/:id', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const run = await queryOne<any>(
      `SELECT ${PAYROLL_RUN_COLUMNS} FROM payroll_runs pr WHERE pr.id=$1 AND (pr.${col}=$2 OR $2 IS NULL)`,
      [req.params.id, lid]
    )
    if (!run) throw new AppError(404, 'Run not found')
    const { rows: lines } = await db.query(
      `SELECT prl.*, e.first_name, e.last_name, e.title,
              (SELECT p.name FROM properties p WHERE p.id = prl.pay_property_id) AS pay_property_name, e.pay_type as emp_pay_type,
              e.pay_rate, to_char(x.period_month, 'YYYY-MM-DD') AS work_trade_period_month
       FROM payroll_run_lines prl
       JOIN books_employees e ON e.id = prl.employee_id
       LEFT JOIN work_trade_extra_hours x ON x.id = prl.work_trade_extra_hours_id
       WHERE prl.run_id = $1
       ORDER BY e.last_name, e.first_name, prl.work_trade_extra_hours_id NULLS FIRST, prl.created_at`,
      [req.params.id]
    )
    res.json({ success: true, data: { ...run, lines } })
  } catch (e) { next(e) }
})

/**
 * 10/12 (Nic, ledger P7): one money figure off the Run Payroll form — blank is
 * $0, anything else must be an amount of 0 or more. A negative withholding used
 * to be turned into $0 without a word.
 */
function payrollAmount(v: unknown, what: string, who: string): number {
  if (v === undefined || v === null || v === '') return 0
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new AppError(400, `Enter ${what} for ${who} as an amount of $0 or more.`)
  return +n.toFixed(2)
}

/** 10/12 (Nic, ledger P7): the four tax figures the person running payroll enters for one paycheck. */
function enteredTaxes(t: any, who: string) {
  const v = t && typeof t === 'object' ? t : {}
  return {
    federal: payrollAmount(v.federal, 'the federal withholding', who),
    state:   payrollAmount(v.state, 'the state withholding', who),
    futa:    payrollAmount(v.futa, 'the federal unemployment tax', who),
    suta:    payrollAmount(v.suta, 'the state unemployment tax', who),
  }
}


// POST /api/books/payroll/runs — calculate draft run
//
// 10/12 (Nic, ledger P7): each paycheck records the employer's own taxes —
// Social Security and Medicare worked out by GAM (booksEmployerFica: the same
// fixed rates for every employer, S592), federal and state unemployment tax as
// entered (taxMap[employee].futa / .suta; the rate depends on the employer's
// state and record). And work-trade extra hours the landlord sent to GAM Books
// as W-2 pay go on the run as their own paycheck lines (extraHours: [{ id,
// employeeId, federal, state, futa, suta }]): the person running payroll
// confirms which employee the work trader is, and the employee record
// remembers it (books_employees.tenant_id).
booksRouter.post('/payroll/runs', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    // taxMap: bookkeeper-entered withholding per employee — { [employeeId]:
    // { federal, state, futa, suta } }. Absent employees default to 0 (SS +
    // Medicare are still auto-computed).
    const { periodStart, periodEnd, payDate, payFrequency, employeeIds = [], hoursMap = {}, taxMap = {}, extraHours = [] } = req.body ?? {}
    if (!Array.isArray(employeeIds) || !Array.isArray(extraHours)) {
      throw new AppError(400, 'employeeIds and extraHours are lists.')
    }
    if (!periodStart || !periodEnd || !payDate || !payFrequency || (!employeeIds.length && !extraHours.length))
      throw new AppError(400, 'periodStart, periodEnd, payDate, payFrequency, employeeIds required')
    // 10/11: a frequency off the list used to be paid as every two weeks.
    if (!(BOOKS_PAY_FREQUENCIES as readonly string[]).includes(payFrequency)) {
      throw new AppError(400, 'Choose how often this payroll pays: weekly, every two weeks, twice a month or monthly.')
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payDate))) throw new AppError(400, 'Enter the pay date as a date.')
    const frequency = payFrequency as BooksPayFrequency
    if (extraHours.length && (col !== 'landlord_id' || !lid)) {
      throw new AppError(400, 'Work-trade hours are paid through a landlord company\'s own payroll.')
    }
    const extraIds: string[] = extraHours.map((x: any) => String(x?.id ?? ''))
    if (extraIds.some(id => !/^[0-9a-f-]{36}$/i.test(id)) || new Set(extraIds).size !== extraIds.length) {
      throw new AppError(400, 'Each work-trade extra-hours line names its record once.')
    }
    const extraEmployeeIds: string[] = extraHours.map((x: any) => String(x?.employeeId ?? ''))
    if (extraEmployeeIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))) {
      throw new AppError(400, 'Choose which employee each work trader is.')
    }

    // Fetch selected employees
    let employees: any[] = []
    if (employeeIds.length) {
      const placeholders = employeeIds.map((_: any, i: number) => `$${i + 2}`).join(',')
      employees = (await db.query(
        `SELECT * FROM books_employees WHERE id IN (${placeholders}) AND (${col}=$1 OR $1 IS NULL) AND status='active'`,
        [lid, ...employeeIds]
      )).rows
      if (!employees.length) throw new AppError(400, 'No active employees found')
    }
    const extraEmployees = new Map<string, any>()
    if (extraEmployeeIds.length) {
      const { rows } = await db.query(
        `SELECT * FROM books_employees WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND status = 'active'`,
        [[...new Set(extraEmployeeIds)], lid])
      for (const r of rows) extraEmployees.set(r.id, r)
      const missing = extraEmployeeIds.find(id => !extraEmployees.has(id))
      if (missing) throw new AppError(400, 'Choose an active employee of this company for each work trader.')
    }

    // Calculate gross per period
    const periodsPerYear = BOOKS_PAY_PERIODS_PER_YEAR[frequency]
    // 10/11: Social Security is figured on the pay date's calendar year — that
    // year's approved pay so far and that year's wage base.
    const payYear = Number(String(payDate).slice(0, 4))
    const ssWageBase = socialSecurityWageBase(payYear)
    const everyone = [...new Set([...employees.map((e: any) => e.id), ...extraEmployees.keys()])]
    const yearToDate = await employeeYearTotals(everyone, payYear)
    // 10/12 (Nic, ledger P7): pay earlier on THIS run counts too — an employee
    // with a regular paycheck and an extra-hours paycheck on one run reaches
    // the wage base once, not twice.
    const ytdSoFar = new Map<string, number>(everyone.map(id => [id, yearToDate.get(id)?.ytd_gross ?? 0]))

    // 10/14 (Nic): "an employee at one property goes to that property ... if
    // they work at multiple properties it would be at the company level" —
    // each paycheck follows its employee's place (no per-run pick). Everyone
    // on a landlord company's run must have one; who has none is named.
    const paycheckPlaces = new Map<string, { place: string; propertyId: string | null }>()
    if (col === 'landlord_id' && lid) {
      const missing: string[] = []
      for (const emp of [...employees, ...[...extraEmployees.values()].filter(e => !employees.some((x: any) => x.id === e.id))]) {
        const at = await paycheckPlaceOf(db, lid, emp)
        if (at) paycheckPlaces.set(emp.id, at)
        else missing.push(`${emp.first_name} ${emp.last_name}`)
      }
      if (missing.length) throw new AppError(400, payPlaceMissingRefusal(missing))
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [run] } = await client.query(
        `INSERT INTO payroll_runs (${col}, period_start, period_end, pay_date, pay_frequency, status)
         VALUES ($1,$2,$3,$4,$5,'draft') RETURNING *`,
        [lid, periodStart, periodEnd, payDate, payFrequency]
      )

      let totalGross = 0, totalFed = 0, totalState = 0, totalSS = 0, totalMedicare = 0, totalNet = 0
      let totalErSS = 0, totalErMedicare = 0, totalFuta = 0, totalSuta = 0

      // One paycheck line: the employee's taxes, the employer's, and the totals.
      const addLine = async (emp: any, line: { payType: string; hours: number | null; gross: number; entered: any; memo?: string | null; extraHoursId?: string | null }) => {
        const who = `${emp.first_name} ${emp.last_name}`
        const t = enteredTaxes(line.entered, who)
        const before = ytdSoFar.get(emp.id) ?? 0
        const taxes = payrollTaxes(line.gross, before, t.federal, t.state, ssWageBase)
        if (taxes.netPay < 0) {
          throw new AppError(400, `Withholding entered for ${who} exceeds their gross pay`)
        }
        const employer = booksEmployerFica(line.gross, before, ssWageBase)
        await client.query(
          `INSERT INTO payroll_run_lines
             (run_id, employee_id, pay_type, hours_worked, gross_pay,
              federal_tax, state_tax, ss_tax, medicare_tax, net_pay,
              employer_ss_tax, employer_medicare_tax, futa_tax, suta_tax, memo, work_trade_extra_hours_id,
              pay_place, pay_property_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [run.id, emp.id, line.payType, line.hours, line.gross,
           taxes.federalTax, taxes.stateTax, taxes.ssTax, taxes.medicareTax, taxes.netPay,
           employer.employerSs, employer.employerMedicare, t.futa, t.suta, line.memo ?? null, line.extraHoursId ?? null,
           // 10/14 (Nic): the employee's place, kept on the paycheck so a posted run never moves.
           paycheckPlaces.get(emp.id)?.place ?? null, paycheckPlaces.get(emp.id)?.propertyId ?? null]
        )
        ytdSoFar.set(emp.id, before + line.gross)
        totalGross += line.gross; totalFed += taxes.federalTax; totalState += taxes.stateTax
        totalSS += taxes.ssTax; totalMedicare += taxes.medicareTax; totalNet += taxes.netPay
        totalErSS += employer.employerSs; totalErMedicare += employer.employerMedicare
        totalFuta += t.futa; totalSuta += t.suta
      }

      for (const emp of employees) {
        let hours: number | null = null
        let grossPay = 0
        if (emp.pay_type === 'salary') {
          grossPay = +emp.pay_rate / periodsPerYear
        } else {
          // Hourly: the hours entered, else a full-time period for this
          // frequency (booksDefaultHours, packages/shared — the same figure the
          // Run Payroll preview shows). 10/11: it used 80 for every frequency
          // but weekly, so a monthly hourly employee was paid for 80 hours.
          // The hours paid for are kept on the line either way. A typed 0 is
          // "worked nothing" and pays $0 (it used to read as "nothing entered"
          // and paid a full period); only a box left blank takes the default.
          const raw = (hoursMap as Record<string, unknown>)[emp.id]
          hours = (raw === undefined || raw === null || raw === '') ? booksDefaultHours(frequency) : Number(raw)
          if (!Number.isFinite(hours) || hours < 0) {
            throw new AppError(400, `Enter the hours ${emp.first_name} ${emp.last_name} worked (0 or more).`)
          }
          grossPay = +emp.pay_rate * hours
        }
        grossPay = +grossPay.toFixed(2)
        await addLine(emp, { payType: emp.pay_type, hours, gross: grossPay, entered: (taxMap as Record<string, any>)[emp.id] })
      }

      // 10/12 (Nic, ledger P7): work-trade extra hours sent to GAM Books as W-2
      // pay. Each record is locked while it goes on the run: it must still be
      // waiting for payroll (sent, W-2, not marked paid by hand, on no other
      // run that is not voided), and the employee picked must be this work
      // trader (or not yet linked to anyone).
      for (const [i, item] of (extraHours as any[]).entries()) {
        const { rows: [x] } = await client.query<any>(
          `SELECT x.*, ${EXTRA_HOURS_ON_LIVE_RUN_SQL} AS on_run, u.first_name AS tenant_first, u.last_name AS tenant_last
             FROM work_trade_extra_hours x
             JOIN tenants t ON t.id = x.tenant_id JOIN users u ON u.id = t.user_id
            WHERE x.id = $1 AND x.landlord_id = $2
            FOR UPDATE OF x`, [extraIds[i], lid])
        if (!x) throw new AppError(404, 'Those work-trade extra hours are not this company\'s.')
        const trader = `${x.tenant_first ?? ''} ${x.tenant_last ?? ''}`.trim() || 'this work trader'
        if (x.status !== 'sent_to_books' || x.books_reference_id) {
          throw new AppError(409, x.status === 'paid'
            ? `The extra hours for ${trader} are already marked paid.`
            : `The extra hours for ${trader} have not been sent to GAM Books.`)
        }
        if (x.pay_method !== 'payroll_w2') {
          throw new AppError(409, `The extra hours for ${trader} were sent as a contractor payment (1099), not payroll.`)
        }
        if (x.on_run) throw new AppError(409, `The extra hours for ${trader} are already on another payroll run.`)
        const emp = extraEmployees.get(extraEmployeeIds[i])!
        if (emp.tenant_id && emp.tenant_id !== x.tenant_id) {
          throw new AppError(409, `${emp.first_name} ${emp.last_name} is a different person on this company's payroll. Choose the employee who is ${trader}.`)
        }
        if (!emp.tenant_id) {
          try {
            await client.query(`SAVEPOINT link_employee`)
            await client.query(`UPDATE books_employees SET tenant_id = $2, updated_at = NOW() WHERE id = $1`, [emp.id, x.tenant_id])
            await client.query(`RELEASE SAVEPOINT link_employee`)
            emp.tenant_id = x.tenant_id
          } catch (e: any) {
            await client.query(`ROLLBACK TO SAVEPOINT link_employee`)
            if (isUniqueViolation(e, 'books_employees_landlord_tenant')) {
              throw new AppError(409, `Another employee record is already ${trader}. Choose that one.`)
            }
            throw e
          }
        }
        await addLine(emp, {
          payType: 'hourly', hours: +x.hours, gross: +(+x.amount).toFixed(2), entered: item,
          memo: `Work-trade extra hours, ${toIsoDay(x.period_month).slice(0, 7)}`, extraHoursId: x.id,
        })
      }

      const r2 = (n: number) => +n.toFixed(2)
      await client.query(
        `UPDATE payroll_runs SET
           total_gross=$1, total_federal_tax=$2, total_state_tax=$3,
           total_ss=$4, total_medicare=$5, total_net=$6, employee_count=$7,
           total_employer_ss=$8, total_employer_medicare=$9, total_futa=$10, total_suta=$11
         WHERE id=$12`,
        [r2(totalGross), r2(totalFed), r2(totalState), r2(totalSS), r2(totalMedicare), r2(totalNet),
         everyone.length, r2(totalErSS), r2(totalErMedicare), r2(totalFuta), r2(totalSuta), run.id]
      )

      await client.query('COMMIT')
      const { rows: [finalRun] } = await db.query(`SELECT ${PAYROLL_RUN_COLUMNS} FROM payroll_runs pr WHERE pr.id=$1`, [run.id])
      const { rows: lines } = await db.query(
        `SELECT prl.*, e.first_name, e.last_name, e.title,
              (SELECT p.name FROM properties p WHERE p.id = prl.pay_property_id) AS pay_property_name, to_char(x.period_month, 'YYYY-MM-DD') AS work_trade_period_month
           FROM payroll_run_lines prl
           JOIN books_employees e ON e.id = prl.employee_id
           LEFT JOIN work_trade_extra_hours x ON x.id = prl.work_trade_extra_hours_id
          WHERE prl.run_id=$1
          ORDER BY e.last_name, e.first_name, prl.work_trade_extra_hours_id NULLS FIRST, prl.created_at`, [run.id]
      )
      res.status(201).json({ success: true, data: { ...finalRun, lines } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

/** 10/11: a payroll run's status, in words, for a refusal. */
const PAYROLL_RUN_STATUS_WORD: Record<string, string> = { draft: 'a draft', approved: 'approved', voided: 'voided' }

// POST /api/books/payroll/runs/:id/approve
//
// 10/12 (Nic, ledger P7): approving posts the run to the ledger on its pay
// date (services/ledgerProjectors/payrollRun, within the minute — kicked right
// after the commit), marks the work-trade extra hours it pays as paid through
// payroll, and leaves what it owes — each paycheck's take-home pay and each
// payroll tax — as unpaid expenses on the Expenses record
// (services/payrollMoneyOut).
booksRouter.post('/payroll/runs/:id/approve', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    let xid: string | null = null

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // 10/11: read and lock the run inside the transaction, and move it only
      // out of 'draft'. Read outside any lock, an approve overlapping a void
      // could leave a voided draft 'approved' (then counted in Cash Flow, the
      // Tax Center and year-to-date), and a double-click added the run to the
      // employees' stored ytd_* columns twice.
      const { rows: [run] } = await client.query(
        `SELECT * FROM payroll_runs WHERE id=$1 AND (${col}=$2 OR $2 IS NULL) FOR UPDATE`,
        [req.params.id, lid]
      )
      if (!run) throw new AppError(404, 'Run not found')
      if (run.status !== 'draft') throw new AppError(400, `This run is already ${PAYROLL_RUN_STATUS_WORD[run.status] ?? 'closed'}.`)
      // 10/14 (Nic): each paycheck follows its employee's place. A draft
      // calculated before 10/14 has paychecks with no place: they take their
      // employee's now; an employee with none yet is named and the run waits.
      if (run.landlord_id) {
        const { rows: unplaced } = await client.query<any>(
          `SELECT prl.id, prl.employee_id, e.first_name, e.last_name, e.pay_place, e.pay_property_id
             FROM payroll_run_lines prl JOIN books_employees e ON e.id = prl.employee_id
            WHERE prl.run_id = $1 AND prl.pay_place IS NULL`, [run.id])
        const missing = new Set<string>()
        for (const line of unplaced) {
          const at = await paycheckPlaceOf(client, run.landlord_id, line)
          if (!at) { missing.add(`${line.first_name} ${line.last_name}`); continue }
          await client.query(`UPDATE payroll_run_lines SET pay_place = $2, pay_property_id = $3 WHERE id = $1`,
            [line.id, at.place, at.propertyId])
        }
        if (missing.size) throw new AppError(400, payPlaceMissingRefusal([...missing]))
      }
      const moved = await client.query(
        `UPDATE payroll_runs SET status='approved', approved_at=NOW(), approved_by=$1, updated_at=NOW()
          WHERE id=$2 AND status='draft'`,
        [req.user!.userId, req.params.id]
      )
      if (!moved.rowCount) throw new AppError(409, 'This run changed while you were approving it. Reload and try again.')
      // Update YTD on each employee
      const { rows: lines } = await client.query(
        `SELECT prl.*, e.first_name, e.last_name FROM payroll_run_lines prl
           JOIN books_employees e ON e.id = prl.employee_id WHERE prl.run_id=$1`, [req.params.id]
      )
      for (const line of lines) {
        await client.query(
          `UPDATE books_employees SET
             ytd_gross = ytd_gross + $1,
             ytd_federal_tax = ytd_federal_tax + $2,
             ytd_state_tax = ytd_state_tax + $3,
             ytd_ss = ytd_ss + $4,
             ytd_medicare = ytd_medicare + $5,
             ytd_net = ytd_net + $6,
             updated_at = NOW()
           WHERE id = $7`,
          [line.gross_pay, line.federal_tax, line.state_tax, line.ss_tax, line.medicare_tax, line.net_pay, line.employee_id]
        )
      }
      // 10/12 (Nic, ledger P7): the work-trade extra hours this run pays are
      // paid through payroll on the pay date — unless one was marked paid by
      // hand on the Work Trade page since the run was calculated.
      const extra = lines.filter((l: any) => l.work_trade_extra_hours_id)
      if (extra.length) {
        const paid = await client.query(
          `UPDATE work_trade_extra_hours
              SET status = 'paid', paid_on = $2::date, paid_at = NOW(), paid_by = $3, paid_how = 'gam_books',
                  paid_note = 'Paid through GAM Books payroll', books_reference_id = $4, updated_at = NOW()
            WHERE id = ANY($1::uuid[]) AND status = 'sent_to_books' AND books_reference_id IS NULL`,
          [extra.map((l: any) => l.work_trade_extra_hours_id), toIsoDay(run.pay_date), req.user!.userId, run.id])
        if ((paid.rowCount ?? 0) !== extra.length) {
          throw new AppError(409, 'Work-trade extra hours on this run were marked paid another way since it was calculated. Void this draft and calculate it again.')
        }
      }
      if (run.landlord_id) {
        await createPayrollMoneyOut(client, { runId: run.id, landlordId: run.landlord_id, createdBy: req.user!.userId })
      }
      xid = await currentLedgerXid(client)
      await client.query('COMMIT')
      if (xid) void kickLedgerAfterCommit(xid)
      const { rows: [updated] } = await db.query(`SELECT ${PAYROLL_RUN_COLUMNS} FROM payroll_runs pr WHERE pr.id=$1`, [req.params.id])
      res.json({ success: true, data: updated })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/books/payroll/runs/:id/void
//
// 10/12 (Nic, ledger P7): voiding an approved run takes its ledger posting
// back (the payroll projector wants nothing for a voided run — a correction,
// on the first open day when its month is closed), puts the work-trade extra
// hours it paid back to "Sent to GAM Books", and voids the unpaid expenses it
// left — refused while any of those has been paid.
booksRouter.post('/payroll/runs/:id/void', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    let xid: string | null = null

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // 10/11: locked and re-read inside the transaction (see approve above):
      // the YTD reversal below must follow the status the run has NOW.
      const { rows: [run] } = await client.query(
        `SELECT * FROM payroll_runs WHERE id=$1 AND (${col}=$2 OR $2 IS NULL) FOR UPDATE`,
        [req.params.id, lid]
      )
      if (!run) throw new AppError(404, 'Run not found')
      if (run.status === 'voided') throw new AppError(400, 'This run is already voided.')
      // If approved, reverse YTD
      if (run.status === 'approved') {
        // Refused before anything else changes when part of it was paid.
        const refusal = await payrollMoneyOutPaidRefusal(client, run.id)
        if (refusal) throw new AppError(409, refusal)
        const { rows: lines } = await client.query('SELECT * FROM payroll_run_lines WHERE run_id=$1', [req.params.id])
        for (const line of lines) {
          await client.query(
            `UPDATE books_employees SET
               ytd_gross = GREATEST(0, ytd_gross - $1),
               ytd_federal_tax = GREATEST(0, ytd_federal_tax - $2),
               ytd_state_tax = GREATEST(0, ytd_state_tax - $3),
               ytd_ss = GREATEST(0, ytd_ss - $4),
               ytd_medicare = GREATEST(0, ytd_medicare - $5),
               ytd_net = GREATEST(0, ytd_net - $6),
               updated_at = NOW()
             WHERE id=$7`,
            [line.gross_pay, line.federal_tax, line.state_tax, line.ss_tax, line.medicare_tax, line.net_pay, line.employee_id]
          )
        }
        await client.query(
          `UPDATE work_trade_extra_hours
              SET status = 'sent_to_books', paid_on = NULL, paid_at = NULL, paid_by = NULL, paid_how = NULL,
                  paid_note = NULL, books_reference_id = NULL, updated_at = NOW()
            WHERE books_reference_id = $1 AND status = 'paid'`, [run.id])
      }
      const voided = await client.query(
        `UPDATE payroll_runs SET status='voided', voided_at=NOW(), updated_at=NOW() WHERE id=$1 AND status <> 'voided'`,
        [req.params.id]
      )
      if (!voided.rowCount) throw new AppError(400, 'This run is already voided.')
      // The unpaid expenses it left, on the Expenses record's own void, in this
      // same transaction: the run and what it left owed go together or not at all.
      if (run.status === 'approved' && run.landlord_id) {
        await voidPayrollMoneyOut(client, { runId: run.id, landlordId: run.landlord_id })
      }
      xid = await currentLedgerXid(client)
      await client.query('COMMIT')
      if (xid) void kickLedgerAfterCommit(xid)
      res.json({ success: true, data: { message: 'Run voided' } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// WORK-TRADE EXTRA HOURS SENT TO GAM BOOKS
// ════════════════════════════════════════
//
// 10/12 (Nic): paid extra work-trade hours are wages the landlord pays a
// person. On the Work Trade page the landlord either pays by hand (Mark paid)
// or presses Send to GAM Books, and here they become payroll (W-2: a paycheck
// line on a run, POST /payroll/runs extraHours) or a contractor payment (1099:
// an unpaid contractor expense, below) — the person paying confirms which.

// GET /api/books/work-trade-pay — what the landlord sent to GAM Books and
// Books has not picked up yet. Names only (no contact or account details).
booksRouter.get('/work-trade-pay', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    if (col !== 'landlord_id' || !lid) return res.json({ success: true, data: [] })
    const rows = await query<any>(
      `SELECT x.id, x.status, x.pay_method, x.hours::float AS hours, x.rate::float AS rate, x.amount::float AS amount,
              to_char(x.period_month, 'YYYY-MM-DD') AS period_month, x.sent_to_books_at,
              u.first_name AS tenant_first, u.last_name AS tenant_last,
              (SELECT e.id FROM books_employees e WHERE e.landlord_id = x.landlord_id AND e.tenant_id = x.tenant_id
                ORDER BY (e.status = 'active') DESC, e.created_at LIMIT 1) AS employee_id,
              (SELECT r.id FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.run_id
                WHERE l.work_trade_extra_hours_id = x.id AND r.status = 'draft' LIMIT 1) AS draft_run_id
         FROM work_trade_extra_hours x
         JOIN tenants t ON t.id = x.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE x.landlord_id = $1 AND ${EXTRA_HOURS_WAITING_FOR_BOOKS_SQL}
        ORDER BY x.period_start, u.last_name, u.first_name`, [lid])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/books/work-trade-pay/:id/contractor-payment — extra hours sent as
// a contractor payment (1099) become, when the landlord confirms, an unpaid
// contractor expense to the vendor who is this work trader — the one picked
// (vendorId), or else the contractor vendor the vendor list keeps for this
// tenant (made the first time) — due today (services/workTradeBooksPay).
// 10/13 (Nic): "except gams charge all those costs get logged by a person" —
// the person confirming it says where the cost goes (costPlace, with
// propertyId / unitId: split across the properties by units, one property,
// one unit); nothing records without it.
const CONTRACTOR_PLACE_WHAT = 'this contractor bill'
booksRouter.post('/work-trade-pay/:id/contractor-payment', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    if (col !== 'landlord_id' || !lid) throw new AppError(400, 'Work-trade hours are paid by a landlord company.')
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new AppError(404, 'Those work-trade extra hours are not this company\'s.')
    const rawVendor = req.body?.vendorId
    const vendorId = rawVendor === undefined || rawVendor === null || rawVendor === '' ? null : String(rawVendor)
    if (vendorId && !/^[0-9a-f-]{36}$/i.test(vendorId)) throw new AppError(400, 'Choose the vendor this work trader is paid as.')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const b = req.body ?? {}
      if (b.costPlace != null && b.costPlace !== '' && !(BOOKS_COST_PLACES as readonly unknown[]).includes(b.costPlace)) {
        throw new AppError(400, `Choose where ${CONTRACTOR_PLACE_WHAT} goes: one unit, one property, or split across your properties by units.`)
      }
      // Checked here when sent; the hours and the vendor are checked first, and
      // a bill with no place is refused after them (recordWorkTradeContractorPayment).
      const place = b.costPlace || b.propertyId || b.unitId
        ? await resolveCostPlace(client, { col: 'landlord_id', id: lid }, {
            costPlace: b.costPlace || null, propertyId: b.propertyId || null, unitId: b.unitId || null,
          }, CONTRACTOR_PLACE_WHAT)
        : null
      const made = await recordWorkTradeContractorPayment(client, {
        landlordId: lid, extraHoursId: req.params.id, vendorId, createdBy: req.user!.userId, place,
      })
      const xid = await currentLedgerXid(client)
      await client.query('COMMIT')
      void kickLedgerAfterCommit(xid)
      res.status(201).json({ success: true, data: made })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// GET /api/books/properties — 10/12 (Nic, ledger P7): the company's properties,
// for the journal entry's property on each line (the ledger tags every line
// with its property).
booksRouter.get('/properties', requireBooksRead, blockBusinessOwner, async (req, res, next) => {
  try {
    const lid = landlordScope(req.user)
    if (!lid) return res.json({ success: true, data: [] })
    const rows = await query<any>(
      `SELECT p.id, p.name FROM properties p WHERE p.landlord_id = $1 ORDER BY p.name, p.id`, [lid])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})


// ════════════════════════════════════════
// BOOKKEEPER MANAGEMENT
// ════════════════════════════════════════
// S91: All five endpoints below were rewritten against bookkeeper_scopes
// (the consolidated team-permission table from S80). Pre-S91 they
// referenced phantom `books_access` and threw at runtime. The canonical
// invitation flow (with email + token + accept page) now lives at
// POST /api/scopes/:roleType/invite — these endpoints stay as a
// books-portal convenience for direct create/list/revoke without the
// invitation round-trip.
//
// Schema bridge: the old books_access carried a `permissions jsonb`
// per-client. bookkeeper_scopes has `access_level` (read_only |
// read_write). Callers that depended on the legacy `permissions` shape
// should migrate; we expose access_level under both keys for
// backward-compat reads.

// GET /api/books/companies — S655: the companies a landlord account owns, so
// Books can ask which company's books to open when there is more than one
// (landlordScope never picks one). Read fresh, not from the pass, so a
// company made after sign-in is listed (S629). Anyone else gets an empty list:
// a bookkeeper picks from /bookkeeper/clients, a team member has one company.
booksRouter.get('/companies', async (req, res, next) => {
  try {
    if (req.user?.role !== 'landlord') return res.json({ success: true, data: [] })
    const rows = await query<any>(
      `SELECT l.id AS landlord_id, l.business_name,
              (SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM properties p WHERE p.landlord_id = l.id) AS property_names
         FROM landlords l
        WHERE l.id = ANY($2::uuid[])
           OR l.id IN (SELECT landlord_id FROM landlord_members WHERE user_id = $1)
           OR l.user_id = $1
        ORDER BY l.business_name NULLS LAST, l.created_at`,
      [req.user.userId, landlordScopeIds(req.user)])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/books/bookkeeper/clients — list all clients for logged-in bookkeeper
// S131 bug fix: was gated by requireLandlord (admin/super_admin/landlord
// only), which blocked the bookkeeper-self-fetch path the inner role
// check was clearly trying to support. Bug pre-existed S131; visible
// once you read both gates together. Fix: drop the requireLandlord
// outer gate and rely on the inner role check (which already lists
// bookkeeper / admin / super_admin).
booksRouter.get('/bookkeeper/clients', async (req, res, next) => {
  try {
    if (req.user?.role !== 'bookkeeper' && req.user?.role !== 'admin' && req.user?.role !== 'super_admin')
      throw new AppError(403, 'Bookkeeper access required')

    const userId = req.user.role === 'bookkeeper' ? req.user.userId : null

    const { rows } = await db.query(
      `SELECT
          bs.id AS access_id,
          bs.access_level,
          jsonb_build_object('access_level', bs.access_level) AS permissions,
          'active'::text AS status,
          bs.created_at AS access_since,
          l.id AS landlord_id, l.business_name, l.volume_tier,
          u.first_name, u.last_name, u.email,
          -- 10/12 (Nic): payroll is in the company-wide box, so its counts
          -- are given only to a bookkeeper who holds it (NULL otherwise).
          -- 10/12 (Nic, BK1): or the ledger box, which carries payroll too —
          -- 10/12 review: only while they keep a property (requestScopeOf's
          -- rule: the box ends with their last property's sale).
          ${companyWideSql('bs')} AS company_wide,
          (${companyWideSql('bs')} OR (bs.company_ledger AND cardinality(${keptIdsSql('bs')}) > 0)) AS company_ledger,
          CASE WHEN ${companyWideSql('bs')} OR (bs.company_ledger AND cardinality(${keptIdsSql('bs')}) > 0) THEN
            (SELECT COUNT(*) FROM books_employees WHERE landlord_id = l.id AND status='active') END AS employee_count,
          CASE WHEN ${companyWideSql('bs')} OR (bs.company_ledger AND cardinality(${keptIdsSql('bs')}) > 0) THEN
            (SELECT COUNT(*) FROM books_vendors WHERE landlord_id = l.id AND status='active' AND vendor_type = 'contractor') END AS contractor_count,
          CASE WHEN ${companyWideSql('bs')} OR (bs.company_ledger AND cardinality(${keptIdsSql('bs')}) > 0) THEN
            (SELECT COUNT(*) FROM payroll_runs WHERE landlord_id = l.id AND status='approved') END AS payroll_run_count
        FROM bookkeeper_scopes bs
        JOIN landlords l ON l.id = bs.landlord_id
        JOIN users u ON u.id = l.user_id
        WHERE ($1::uuid IS NULL OR bs.user_id = $1)
        ORDER BY l.business_name ASC`,
      [userId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/books/bookkeeper/all — admin: list all bookkeepers
// S131: stays requireLandlord. Inner check restricts further to
// admin/super_admin only; the outer gate is correct (admin owns this
// platform-wide view, no team-worker delegation).
booksRouter.get('/bookkeeper/all', requireLandlord, async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin')
      throw new AppError(403, 'Admin required')
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.created_at,
          COUNT(bs.id) AS client_count
        FROM users u
        LEFT JOIN bookkeeper_scopes bs ON bs.user_id = u.id
        WHERE u.role = 'bookkeeper'
        GROUP BY u.id ORDER BY u.last_name`
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/books/bookkeeper/invite — REMOVED S592 (Nic). This was a
// direct-create variant that set a password FOR the bookkeeper. A bookkeeper
// must set their OWN password via the email-link invite, and the LANDLORD owns
// that relationship — so bookkeepers are now invited from the landlord Team page
// (apps/landlord TeamPage → POST /api/scopes/bookkeeper/invite → accept page).
// GAM admins no longer provision bookkeeper accounts.
//
// POST /api/books/bookkeeper/assign — RETIRED 10/11 (Nic). It attached an
// existing bookkeeper to a company with no properties named, which reads as
// "every property", and nothing called it: the Team page invite has been the
// one way in since S592. A bookkeeper now keeps exactly the properties ticked
// for them there (routes/scopes), and a second door that skips the boxes would
// undo that.

// DELETE /api/books/bookkeeper/revoke — remove bookkeeper from a client
// Hard delete on bookkeeper_scopes (S80 model has no soft-delete column).
// Re-assign creates a fresh row.
// S131: stays requireLandlord. Revoking bookkeeper access is the
// inverse of grant — same owner-authority posture.
booksRouter.delete('/bookkeeper/revoke', requireLandlord, async (req, res, next) => {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin' && req.user?.role !== 'landlord')
      throw new AppError(403, 'Admin or Landlord required')
    const { bookkeeperUserId, landlordId } = req.body
    if (!bookkeeperUserId || !landlordId) throw new AppError(400, 'bookkeeperUserId and landlordId required')
    // S385 fix: landlord callers can only revoke bookkeepers from their
    // own books. Pre-fix any landlord could DELETE any other landlord's
    // bookkeeper scope row — denial-of-service against another landlord's
    // books access.
    if (req.user.role === 'landlord' && !(await accountOwnsCompany(req.user, String(landlordId)))) {
      throw new AppError(403, 'Landlords can only revoke bookkeepers from their own books')
    }
    await db.query(
      `DELETE FROM bookkeeper_scopes WHERE user_id=$1 AND landlord_id=$2`,
      [bookkeeperUserId, landlordId]
    )
    res.json({ success: true })
  } catch (e) { next(e) }
})


// ════════════════════════════════════════
// JOURNAL ENTRIES
// ════════════════════════════════════════

/**
 * 10/12 (Nic, ledger P7) — A BOOKKEEPER'S JOURNAL ENTRY IN THE LEDGER
 * (gam-ledger-design-2026-10-12 §6 J4, §11, §13)
 *
 *   Nic 10/12: every money event posts its own balanced lines automatically;
 *   the bookkeeper adds adjusting entries on top.
 *
 * An entry is kept exactly as entered (journal_entries / journal_entry_lines)
 * and mirrors into the ledger within the minute (services/ledgerProjectors/
 * manualJournal; each write here kicks the books right after it commits),
 * each line on the property, unit and lease it names — none is company level.
 * Where value moves between properties the ledger adds its own inter-property
 * clearing lines (3950) to the posting, never to the entry.
 *
 * Refused in words before anything is written:
 *   - a line on an account GAM keeps from the money records (an account a
 *     control posting role uses: receivables, money GAM holds, deposits owed,
 *     Accounts payable …). The nightly tie-outs prove those against the money
 *     records, so a hand line would make them disagree. The database refuses
 *     it too (journal_entry_lines_control_guard), with the same words.
 *   - an entry dated in a closed month (journal_entries_closed_period_guard):
 *     the fix is a new entry dated after the close, which shows as a
 *     correction.
 *   - a property, unit or lease that is not this company's.
 * Kinds (BOOKS_JOURNAL_ENTRY_TYPES): an ordinary entry; an adjusting entry,
 * which may name the automatic record it adjusts ('<source type>:<id>',
 * adjusts_line_key — one this company's ledger has posted); a reversing
 * entry, made only by Reverse on the entry it takes back (every line's side
 * swapped, its own date, reverses_entry_id).
 *
 * books_accounts.balance (the chart's running figure) is still kept by these
 * routes for the screens that read it, until the reports read the ledger
 * (design P8, P10).
 */

/** A Books write the database refused in one of its ledger guards (a trigger's RAISE): its own sentence, as a 409. */
function ledgerGuardRefusal(e: any): AppError | null {
  if (e?.code === '23514' && e?.routine === 'exec_stmt_raise' && typeof e?.message === 'string') return new AppError(409, e.message)
  return null
}

const JOURNAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface JournalLineDims { propertyId: string | null; unitId: string | null; leaseId: string | null }

/**
 * Each line's property, unit and lease, checked against the company: a lease
 * names its unit, a unit its property, and what a line leaves out is filled
 * from what it names. Refused when any is not this company's (404) or when
 * they disagree with each other (400).
 */
async function journalLineDimensions(col: OwnerCol, lid: string | null, lines: any[]): Promise<JournalLineDims[]> {
  const pick = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v))
  const dims: JournalLineDims[] = lines.map(l => ({ propertyId: pick(l?.propertyId), unitId: pick(l?.unitId), leaseId: pick(l?.leaseId) }))
  if (!dims.some(d => d.propertyId || d.unitId || d.leaseId)) return dims
  if (col !== 'landlord_id' || !lid) throw new AppError(400, 'Only a landlord company\'s journal lines name a property.')
  for (const d of dims) {
    for (const v of [d.propertyId, d.unitId, d.leaseId]) {
      if (v && !JOURNAL_UUID.test(v)) throw new AppError(400, 'Choose each line\'s property, unit or lease from the lists.')
    }
  }
  const leaseIds = [...new Set(dims.map(d => d.leaseId).filter((x): x is string => !!x))]
  const leases = new Map((await query<{ id: string; unit_id: string }>(
    `SELECT id, unit_id FROM leases WHERE id = ANY($1::uuid[]) AND landlord_id = $2`, [leaseIds, lid])).map(r => [r.id, r.unit_id]))
  for (const d of dims) {
    if (!d.leaseId) continue
    const unitOfLease = leases.get(d.leaseId)
    if (!unitOfLease) throw new AppError(404, 'That lease is not one of this company\'s.')
    if (d.unitId && d.unitId !== unitOfLease) throw new AppError(400, 'That lease is on a different unit than the line names.')
    d.unitId = unitOfLease
  }
  const unitIds = [...new Set(dims.map(d => d.unitId).filter((x): x is string => !!x))]
  const units = new Map((await query<{ id: string; property_id: string }>(
    `SELECT u.id, u.property_id FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = ANY($1::uuid[]) AND p.landlord_id = $2`, [unitIds, lid])).map(r => [r.id, r.property_id]))
  for (const d of dims) {
    if (!d.unitId) continue
    const propertyOfUnit = units.get(d.unitId)
    if (!propertyOfUnit) throw new AppError(404, 'That unit is not on one of this company\'s properties.')
    if (d.propertyId && d.propertyId !== propertyOfUnit) throw new AppError(400, 'That unit is on a different property than the line names.')
    d.propertyId = propertyOfUnit
  }
  const propertyIds = [...new Set(dims.map(d => d.propertyId).filter((x): x is string => !!x))]
  const owned = new Set((await query<{ id: string }>(
    `SELECT id FROM properties WHERE id = ANY($1::uuid[]) AND landlord_id = $2`, [propertyIds, lid])).map(r => r.id))
  if (propertyIds.some(id => !owned.has(id))) throw new AppError(404, 'That property is not one of this company\'s.')
  return dims
}

/** The first of these accounts GAM keeps from the money records (a control posting role uses it), as a refusal. */
async function controlAccountRefusal(accountIds: string[]): Promise<AppError | null> {
  const [hit] = await query<{ name: string }>(
    `SELECT a.name FROM books_accounts a
      WHERE a.id = ANY($1::uuid[])
        AND EXISTS (SELECT 1 FROM books_account_map m
                     WHERE m.account_id = a.id AND m.map_kind = 'role' AND ledger_account_role_is_control(m.map_value))
      ORDER BY a.code, a.id LIMIT 1`, [accountIds])
  return hit ? new AppError(409, `${hit.name} is kept by GAM from the money records, so it takes no journal lines. Post the adjustment to another account.`) : null
}

/**
 * An adjusting entry's record ('<source type>:<id>'): one this company's
 * ledger has posted (an active posting of it). Returned as stored.
 */
async function adjustedRecordKey(col: OwnerCol, lid: string | null, key: unknown): Promise<string> {
  const parsed = typeof key === 'string' ? parseLedgerSourceKey(key.trim()) : null
  if (!parsed) throw new AppError(400, 'That is not an automatic record in these books.')
  if (col !== 'landlord_id' || !lid) throw new AppError(400, 'An adjusting entry names an automatic record of a landlord company\'s books.')
  const hit = await queryOne(
    `SELECT 1 FROM ledger_postings
      WHERE source_type = $1 AND source_id = $2 AND landlord_id = $3 AND role = 'post' AND superseded_at IS NULL
      LIMIT 1`, [parsed.sourceType, parsed.sourceId, lid])
  if (!hit) throw new AppError(404, 'That automatic record is not on this company\'s books.')
  return ledgerSourceKey(parsed.sourceType, parsed.sourceId)
}

interface JournalLineToWrite extends JournalLineDims {
  accountId: string
  description: string | null
  /** Whole cents; exactly what the line carries. */
  debit: number
  credit: number
}

/**
 * Writes one entry and its lines in `client`'s transaction: the accounts are
 * locked and must still be active (an account is turned off only at a zero
 * balance), the company's next entry number is the database's
 * (journal_entries_number_per_owner), and each line moves the chart's running
 * balance. A ledger guard's refusal comes back as its own sentence (409).
 */
async function writeJournalEntry(client: PoolClient, a: {
  col: OwnerCol; lid: string | null; date: string; description: string; reference: string | null
  type: string; reversesEntryId?: string | null; adjustsLineKey?: string | null; createdBy: string
  lines: JournalLineToWrite[]
}): Promise<any> {
  const accountIds = [...new Set(a.lines.map(l => l.accountId))]
  const { rows: locked } = await client.query<{ id: string; name: string; active: boolean }>(
    `SELECT id, name, active FROM books_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [accountIds])
  const off = locked.find(x => !x.active)
  if (off) throw new AppError(409, `${off.name} is inactive. Turn it back on in the chart of accounts to post to it.`)
  const totalDebit = a.lines.reduce((s, l) => s + l.debit, 0)
  const totalCredit = a.lines.reduce((s, l) => s + l.credit, 0)
  try {
    await client.query('SAVEPOINT journal_write')
    const { rows: [entry] } = await client.query(
      `INSERT INTO journal_entries (${a.col}, date, description, reference, type, total_debits, total_credits, created_by,
                                    reverses_entry_id, adjusts_line_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.lid, a.date, a.description, a.reference, a.type, (totalDebit / 100).toFixed(2), (totalCredit / 100).toFixed(2),
       a.createdBy, a.reversesEntryId ?? null, a.adjustsLineKey ?? null])
    for (const l of a.lines) {
      await client.query(
        // clock_timestamp(): each line its own moment, so the lines keep the
        // order they were entered in (one transaction shares one now()).
        `INSERT INTO journal_entry_lines (entry_id, account_id, description, debit, credit, property_id, unit_id, lease_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, clock_timestamp())`,
        [entry.id, l.accountId, l.description, (l.debit / 100).toFixed(2), (l.credit / 100).toFixed(2),
         l.propertyId, l.unitId, l.leaseId])
      // The chart's running balance: debits minus credits whatever the type
      // (booksNormalBalance reads it back the way people read it).
      await client.query(
        `UPDATE books_accounts SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [((l.debit - l.credit) / 100).toFixed(2), l.accountId])
    }
    await client.query('RELEASE SAVEPOINT journal_write')
    return entry
  } catch (e: any) {
    await client.query('ROLLBACK TO SAVEPOINT journal_write')
    const refusal = ledgerGuardRefusal(e)
    if (refusal) throw refusal
    if (isUniqueViolation(e, 'journal_entries_one_live_reversal')) {
      throw new AppError(409, 'That entry has already been reversed. Void the reversing entry first to reverse it again.')
    }
    throw e
  }
}

/** One entry's lines as the Journal page reads them: account, property and unit names. */
async function journalEntryLines(entryId: string): Promise<any[]> {
  const { rows } = await db.query(
    `SELECT jel.*, ba.code, ba.name AS account_name, ba.type AS account_type,
            p.name AS property_name, u.unit_number
       FROM journal_entry_lines jel
       JOIN books_accounts ba ON ba.id = jel.account_id
       LEFT JOIN properties p ON p.id = jel.property_id
       LEFT JOIN units u ON u.id = jel.unit_id
      WHERE jel.entry_id = $1
      ORDER BY jel.debit DESC, jel.created_at, jel.id`, [entryId])
  return rows
}

/** The live entry that reverses each of these, if any (a voided reversal no longer counts). */
const JOURNAL_LIVE_REVERSAL_SQL = `(SELECT r.id FROM journal_entries r
   WHERE r.reverses_entry_id = je.id AND r.status <> 'voided' AND r.voided_at IS NULL LIMIT 1)`

// GET /api/books/journal — 10/12 (Nic, ledger P7): each entry says what kind it
// is and which entry reverses it (or it reverses).
booksRouter.get('/journal', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 500)
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0)
    const { rows } = await db.query(
      `SELECT je.*, je.date::text AS date, COUNT(jel.id) AS line_count,
              ${JOURNAL_LIVE_REVERSAL_SQL} AS reversed_by_entry_id,
              (SELECT o.entry_number FROM journal_entries o WHERE o.id = je.reverses_entry_id) AS reverses_entry_number
       FROM journal_entries je
       LEFT JOIN journal_entry_lines jel ON jel.entry_id = je.id
       WHERE (je.${col} = $1 OR $1 IS NULL)
       GROUP BY je.id
       ORDER BY je.date DESC, je.created_at DESC
       LIMIT $2 OFFSET $3`,
      [lid, limit, offset]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

booksRouter.get('/journal/:id', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    if (!JOURNAL_UUID.test(req.params.id)) throw new AppError(404, 'Entry not found')
    const entry = await queryOne<any>(
      `SELECT je.*, je.date::text AS date,
              ${JOURNAL_LIVE_REVERSAL_SQL} AS reversed_by_entry_id,
              (SELECT r.entry_number FROM journal_entries r
                WHERE r.reverses_entry_id = je.id AND r.status <> 'voided' AND r.voided_at IS NULL LIMIT 1) AS reversed_by_entry_number,
              (SELECT o.entry_number FROM journal_entries o WHERE o.id = je.reverses_entry_id) AS reverses_entry_number
         FROM journal_entries je WHERE je.id=$1 AND (je.${col}=$2 OR $2 IS NULL)`,
      [req.params.id, lid]
    )
    if (!entry) throw new AppError(404, 'Entry not found')
    const parsedKey = entry.adjusts_line_key ? parseLedgerSourceKey(entry.adjusts_line_key) : null
    res.json({ success: true, data: {
      ...entry,
      // The automatic record an adjusting entry adjusts, in words (never the raw key).
      adjusts_record_label: parsedKey ? (LEDGER_SOURCE_TYPE_LABEL[parsedKey.sourceType] ?? 'An automatic record') : null,
      lines: await journalEntryLines(entry.id),
    } })
  } catch (e) { next(e) }
})

// POST /api/books/journal — an ordinary or adjusting entry (see the block above).
booksRouter.post('/journal', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const { date, description, reference, type = 'manual', lines, adjustsLineKey } = req.body ?? {}
    if (!date || !description || !Array.isArray(lines) || !lines.length)
      throw new AppError(400, 'date, description, and lines required')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new AppError(400, 'Enter the entry date as a date.')
    // 10/11: the entry's type is from the shared list. 10/12 (ledger P7): a
    // reversing entry is made only by Reverse on the entry it takes back.
    if (type === 'reversing') throw new AppError(400, 'Use Reverse on the entry this one takes back.')
    if (!(BOOKS_JOURNAL_ENTRY_TYPES_TYPED as readonly string[]).includes(type)) {
      throw new AppError(400, 'That is not a kind of journal entry Books makes.')
    }
    const hasKey = adjustsLineKey !== undefined && adjustsLineKey !== null && adjustsLineKey !== ''
    if (hasKey && type !== 'adjusting') throw new AppError(400, 'Only an adjusting entry names the automatic record it adjusts.')

    // S386 fix — accountId scope validation: every account must be in the
    // caller's own chart (a foreign account would move another company's books).
    const accountIds = (lines as any[]).map(l => l?.accountId).filter(Boolean)
    if (accountIds.length !== lines.length) {
      throw new AppError(400, 'Each line requires accountId')
    }
    if (accountIds.some((id: unknown) => typeof id !== 'string' || !JOURNAL_UUID.test(id))) {
      throw new AppError(403, 'One or more accounts are not in your chart of accounts')
    }

    // 10/11: every amount is a number of dollars, never negative — a negative
    // credit is a debit in disguise — and the two sides are added and compared
    // in whole cents.
    const cents = (lines as any[]).map(l => {
      const d = l.debit ?? 0, c = l.credit ?? 0
      if ((d !== '' && !Number.isFinite(Number(d))) || (c !== '' && !Number.isFinite(Number(c)))) {
        throw new AppError(400, 'Each debit and credit is an amount in dollars.')
      }
      if (Number(d) < 0 || Number(c) < 0) throw new AppError(400, 'Debits and credits cannot be negative.')
      return { debit: booksCents(d), credit: booksCents(c) }
    })
    const debitCents = cents.reduce((s, l) => s + l.debit, 0)
    const creditCents = cents.reduce((s, l) => s + l.credit, 0)
    if (debitCents !== creditCents)
      throw new AppError(400, `Entry out of balance — debits ${(debitCents / 100).toFixed(2)} ≠ credits ${(creditCents / 100).toFixed(2)}`)
    if (debitCents === 0)
      throw new AppError(400, 'Entry must have at least one debit and one credit')
    if (lid !== null) {
      const validation = await db.query<{ id: string }>(
        `SELECT id FROM books_accounts WHERE id = ANY($1::uuid[]) AND ${col} = $2`,
        [accountIds, lid]
      )
      const validIds = new Set(validation.rows.map(r => r.id))
      if (accountIds.some((id: string) => !validIds.has(id))) {
        throw new AppError(403, 'One or more accounts are not in your chart of accounts')
      }
    }
    const control = await controlAccountRefusal(accountIds)
    if (control) throw control
    const dims = await journalLineDimensions(col, lid, lines)
    const adjusts = hasKey ? await adjustedRecordKey(col, lid, adjustsLineKey) : null

    const client = await db.connect()
    let entry: any
    try {
      await client.query('BEGIN')
      entry = await writeJournalEntry(client, {
        col, lid, date: String(date), description: String(description), reference: reference || null, type,
        adjustsLineKey: adjusts, createdBy: req.user!.userId,
        lines: (lines as any[]).map((l, i) => ({
          accountId: l.accountId, description: l.description || null, debit: cents[i].debit, credit: cents[i].credit, ...dims[i],
        })),
      })
      const xid = await currentLedgerXid(client)
      await client.query('COMMIT')
      void kickLedgerAfterCommit(xid)
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
    res.status(201).json({ success: true, data: { ...entry, date: String(date), lines: await journalEntryLines(entry.id) } })
  } catch (e) { next(e) }
})

// POST /api/books/journal/:id/reverse — 10/12 (Nic, ledger P7): a reversing
// entry takes back a posted entry on a later day (an accrual reversed on the
// first of the next month): every line's side swapped, the same accounts and
// properties, dated `date` (on or after the entry's own date). The original
// keeps its posting and the reversal posts beside it; an entry is reversed at
// most once while the reversal stands.
booksRouter.post('/journal/:id/reverse', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    if (!JOURNAL_UUID.test(req.params.id)) throw new AppError(404, 'Entry not found')
    const date = String(req.body?.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'Enter the date the reversal is dated, as a date.')
    const client = await db.connect()
    let entry: any
    try {
      await client.query('BEGIN')
      const { rows: [orig] } = await client.query<any>(
        `SELECT je.*, je.date::text AS day FROM journal_entries je
          WHERE je.id = $1 AND (je.${col} = $2 OR $2 IS NULL) FOR UPDATE`, [req.params.id, lid])
      if (!orig) throw new AppError(404, 'Entry not found')
      if (orig.status === 'voided' || orig.voided_at) throw new AppError(409, 'This entry is voided; there is nothing to reverse.')
      if (orig.type === 'reversing') throw new AppError(409, 'This entry is itself a reversal. Void it instead to undo it.')
      if (date < orig.day) throw new AppError(400, `A reversal is dated on or after the entry it takes back (${orig.day}).`)
      const { rows: [already] } = await client.query<{ entry_number: number | null }>(
        `SELECT entry_number FROM journal_entries
          WHERE reverses_entry_id = $1 AND status <> 'voided' AND voided_at IS NULL LIMIT 1`, [orig.id])
      if (already) throw new AppError(409, `Entry #${already.entry_number} already reverses this one. Void it first to reverse this entry again.`)
      const { rows: origLines } = await client.query<any>(
        `SELECT account_id, description, debit, credit, property_id, unit_id, lease_id
           FROM journal_entry_lines WHERE entry_id = $1 ORDER BY debit DESC, created_at, id`, [orig.id])
      if (!origLines.length) throw new AppError(409, 'This entry has no lines to reverse.')
      entry = await writeJournalEntry(client, {
        col, lid: orig[col] ?? null, date, reference: orig.reference ?? null, type: 'reversing', reversesEntryId: orig.id,
        description: `Reverses entry #${orig.entry_number}: ${orig.description}`,
        createdBy: req.user!.userId,
        lines: origLines.map(l => ({
          accountId: l.account_id, description: l.description ?? null,
          debit: booksCents(l.credit), credit: booksCents(l.debit),
          propertyId: l.property_id ?? null, unitId: l.unit_id ?? null, leaseId: l.lease_id ?? null,
        })),
      })
      const xid = await currentLedgerXid(client)
      await client.query('COMMIT')
      void kickLedgerAfterCommit(xid)
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
    res.status(201).json({ success: true, data: { ...entry, date, lines: await journalEntryLines(entry.id) } })
  } catch (e) { next(e) }
})

// POST /api/books/journal/:id/void — the entry stays on the books marked
// voided (when and by whom, 10/12); its ledger posting is taken back within the
// minute — a correction, on the first open day when its month is closed.
// 10/12 (Nic, ledger P7): refused while a reversing entry that takes it back
// stands (void the reversal first, or the books would undo something that no
// longer happened).
booksRouter.post('/journal/:id/void', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    if (!JOURNAL_UUID.test(req.params.id)) throw new AppError(404, 'Entry not found')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // 10/11: the entry is read and locked inside the transaction that voids
      // it, so two voids at once (a double-click) cannot both reverse it.
      const { rows: [entry] } = await client.query<any>(
        `SELECT * FROM journal_entries WHERE id=$1 AND (${col}=$2 OR $2 IS NULL) FOR UPDATE`,
        [req.params.id, lid]
      )
      if (!entry) throw new AppError(404, 'Entry not found')
      if (entry.status === 'voided') throw new AppError(400, 'Already voided')
      const { rows: [reversal] } = await client.query<{ entry_number: number | null }>(
        `SELECT entry_number FROM journal_entries
          WHERE reverses_entry_id = $1 AND status <> 'voided' AND voided_at IS NULL LIMIT 1`, [entry.id])
      if (reversal) throw new AppError(409, `Entry #${reversal.entry_number} reverses this one. Void that reversing entry first.`)
      const { rows: lines } = await client.query('SELECT * FROM journal_entry_lines WHERE entry_id=$1', [entry.id])
      // An inactive account holds nothing (deactivateAccount); reversing into
      // one would leave money in an account nobody can see.
      const { rows: locked } = await client.query<{ name: string; active: boolean }>(
        `SELECT name, active FROM books_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [lines.map((l: any) => l.account_id)]
      )
      const off = locked.find(a => !a.active)
      if (off) throw new AppError(409, `${off.name} is inactive. Turn it back on in the chart of accounts to void this entry.`)
      for (const line of lines) {
        await client.query(
          `UPDATE books_accounts SET balance = balance - $1, updated_at=NOW() WHERE id=$2`,
          [((booksCents(line.debit) - booksCents(line.credit)) / 100).toFixed(2), line.account_id]
        )
      }
      await client.query(
        `UPDATE journal_entries SET status='voided', voided_at=NOW(), voided_by=$2, updated_at=NOW() WHERE id=$1`,
        [entry.id, req.user!.userId])
      const xid = await currentLedgerXid(client)
      await client.query('COMMIT')
      void kickLedgerAfterCommit(xid)
      res.json({ success: true, data: { message: 'Entry voided' } })
    } catch (e: any) {
      await client.query('ROLLBACK')
      throw ledgerGuardRefusal(e) ?? e
    }
    finally { client.release() }
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// TRANSACTIONS
// ════════════════════════════════════════

// 10/11: a removed transaction is hidden, never erased (DELETE below sets
// deleted_at; migration 20261012150200). Every read here skips it.
booksRouter.get('/transactions', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const { type, reconciled, accountId, limit = 100, offset = 0 } = req.query
    const conditions = [`(bt.${col} = $1 OR $1 IS NULL)`, `bt.deleted_at IS NULL`]
    const params: any[] = [lid]
    if (type) { params.push(type); conditions.push(`bt.type = $${params.length}`) }
    if (reconciled !== undefined) { params.push(reconciled === 'true'); conditions.push(`bt.reconciled = $${params.length}`) }
    if (accountId) {
      if (!/^[0-9a-f-]{36}$/i.test(String(accountId))) throw new AppError(400, 'That account is not one of yours.')
      params.push(accountId); conditions.push(`bt.account_id = $${params.length}`)
    }
    params.push(limit, offset)
    const { rows } = await db.query(
      `SELECT bt.*, ba.code, ba.name AS account_name
       FROM books_transactions bt
       LEFT JOIN books_accounts ba ON ba.id = bt.account_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY bt.date DESC, bt.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/books/transactions/summary — 10/11: the Transactions page's tiles
// (total income, total expenses, net, unreconciled) over EVERY live
// transaction. The tiles added up only the rows the list returns, which stops
// at 100, so a company with more than 100 transactions saw wrong totals. The
// list stays paged; the totals come from here.
booksRouter.get('/transactions/summary', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const row = await queryOne<{
      income: string; expense: string; income_count: string; expense_count: string; unreconciled: string; total_count: string
    }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)::text  AS income,
              COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)::text AS expense,
              COUNT(*) FILTER (WHERE type = 'income')::text                  AS income_count,
              COUNT(*) FILTER (WHERE type = 'expense')::text                 AS expense_count,
              COUNT(*) FILTER (WHERE NOT reconciled)::text                   AS unreconciled,
              COUNT(*)::text                                                 AS total_count
         FROM books_transactions
        WHERE (${col} = $1 OR $1 IS NULL) AND deleted_at IS NULL`,
      [lid])
    const incomeCents = booksCents(row?.income), expenseCents = booksCents(row?.expense)
    res.json({
      success: true,
      data: {
        totalIncome: incomeCents / 100,
        totalExpenses: expenseCents / 100,
        net: (incomeCents - expenseCents) / 100,
        incomeCount: Number(row?.income_count ?? 0),
        expenseCount: Number(row?.expense_count ?? 0),
        unreconciled: Number(row?.unreconciled ?? 0),
        count: Number(row?.total_count ?? 0),
      },
    })
  } catch (e) { next(e) }
})

/** 10/11: a transaction's type is income or expense — the only two Cash Flow reads. */
const TRANSACTION_TYPE_REFUSAL = 'A transaction is income or an expense.'
const TRANSACTION_AMOUNT_REFUSAL = 'Enter the amount as a number of dollars above zero.'
const isTransactionType = (t: unknown) => (BOOKS_TRANSACTION_TYPES as readonly unknown[]).includes(t)
const isPositiveAmount = (a: unknown) => a !== '' && a !== null && Number.isFinite(Number(a)) && booksCents(a as any) > 0

/**
 * 10/12 (Nic, ledger P6, L5): money out is ONE record — the Expenses record.
 * A landlord company's Books Bills and Transactions moved onto it (migration
 * 20261014180300; each original kept, read only, pointing where it went), so
 * their pages retire: a bill is an unpaid expense, a payment is recorded on
 * it, money in or out typed by hand is an expense or other income, and a bank
 * line is filed or matched on the Bank page. A business's books keep their
 * own Bills and Transactions until the business books phase.
 */
const RETIRED_FOR_LANDLORDS = 'Bills and transactions are on Expenses now: a bill is an unpaid expense, and money in or out is filed there or on the Bank page.'
function refuseRetiredForLandlord(col: OwnerCol): void {
  if (col === 'landlord_id') throw new AppError(409, RETIRED_FOR_LANDLORDS)
}

booksRouter.post('/transactions', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    refuseRetiredForLandlord(col)
    const { date, description, amount, type, category, accountId, reference } = req.body
    if (!date || !description || amount === undefined || !type)
      throw new AppError(400, 'date, description, amount, type required')
    // 10/11: any type used to be stored (and then left out of Cash Flow), and
    // any amount, negative included.
    if (!isTransactionType(type)) throw new AppError(400, TRANSACTION_TYPE_REFUSAL)
    if (!isPositiveAmount(amount)) throw new AppError(400, TRANSACTION_AMOUNT_REFUSAL)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new AppError(400, 'Enter the date as a date.')
    assertBooksFieldsFit(req.body, ['category'])
    // S386 fix — accountId scope validation. Pre-fix, a landlord could
    // attach a transaction to another landlord's account_id; the LEFT
    // JOIN on GET would silently surface the wrong account_name.
    if (accountId && lid !== null) {
      const ok = await queryOne<{ id: string }>(
        `SELECT id FROM books_accounts WHERE id=$1 AND ${col}=$2`,
        [accountId, lid]
      )
      if (!ok) throw new AppError(403, 'Account is not in your chart of accounts')
    }
    const { rows: [tx] } = await db.query(
      `INSERT INTO books_transactions (${col}, date, description, amount, type, category, account_id, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [lid, date, description, amount, type, category || null, accountId || null, reference || null]
    )
    res.status(201).json({ success: true, data: tx })
  } catch (e) { next(e) }
})

booksRouter.patch('/transactions/:id/reconcile', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    // 10/12 review: a landlord company's transactions moved to Expenses and
    // stay read only (migration 20261014180300), like every other write here.
    refuseRetiredForLandlord(col)
    const { rows: [tx] } = await db.query(
      `UPDATE books_transactions SET reconciled=TRUE, reconciled_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND (${col}=$2 OR $2 IS NULL) AND deleted_at IS NULL RETURNING *`,
      [req.params.id, lid]
    )
    if (!tx) throw new AppError(404, 'Transaction not found')
    res.json({ success: true, data: tx })
  } catch (e) { next(e) }
})

// PATCH /api/books/transactions/:id — edit a cash transaction (fix a typo'd
// expense, recategorize, reassign account). books_transactions are plain
// ledger rows with NO account-balance side effect (unlike journal entries),
// so an in-place edit is safe — no balance reversal needed. Owner-scoped.
//
// 10/11: only the fields SENT change. It set category, account and reference
// to empty whenever they were left out, so fixing a typo in a description
// wiped the transaction's account. A field sent as null or '' is cleared on
// purpose. The type and amount are checked as on create.
booksRouter.patch('/transactions/:id', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    refuseRetiredForLandlord(col)
    const body = req.body ?? {}
    const sent = (k: string) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined
    const clearable = (v: unknown) => (v === '' ? null : v)
    if (sent('type') && !isTransactionType(body.type)) throw new AppError(400, TRANSACTION_TYPE_REFUSAL)
    if (sent('amount') && !isPositiveAmount(body.amount)) throw new AppError(400, TRANSACTION_AMOUNT_REFUSAL)
    if (sent('date') && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw new AppError(400, 'Enter the date as a date.')
    if (sent('description') && !String(body.description ?? '').trim()) throw new AppError(400, 'Enter a description.')
    assertBooksFieldsFit(body, ['category'])
    const accountId = sent('accountId') ? clearable(body.accountId) : undefined
    // accountId scope validation (S386 parity): a reassigned account must
    // belong to the caller's own books.
    if (accountId && lid !== null) {
      const ok = await queryOne<{ id: string }>(
        `SELECT id FROM books_accounts WHERE id=$1 AND ${col}=$2`,
        [accountId, lid]
      )
      if (!ok) throw new AppError(403, 'Account is not in your chart of accounts')
    }
    const sets: string[] = []
    const params: any[] = []
    const set = (column: string, v: any) => { params.push(v); sets.push(`${column}=$${params.length}`) }
    if (sent('date')) set('date', body.date)
    if (sent('description')) set('description', String(body.description).trim())
    if (sent('amount')) set('amount', (booksCents(body.amount) / 100).toFixed(2))
    if (sent('type')) set('type', body.type)
    if (sent('category')) set('category', clearable(body.category))
    if (sent('accountId')) set('account_id', accountId)
    if (sent('reference')) set('reference', clearable(body.reference))
    params.push(req.params.id, lid)
    const { rows: [tx] } = await db.query(
      `UPDATE books_transactions SET ${[...sets, 'updated_at=NOW()'].join(', ')}
       WHERE id=$${params.length - 1} AND (${col}=$${params.length} OR $${params.length} IS NULL)
         AND deleted_at IS NULL
       RETURNING *`,
      params
    )
    if (!tx) throw new AppError(404, 'Transaction not found')
    res.json({ success: true, data: tx })
  } catch (e) { next(e) }
})

// DELETE /api/books/transactions/:id — remove a cash transaction. No balance
// side effect to reverse (see PATCH note). Owner-scoped; 404 if not the
// caller's row.
//
// 10/11 (keep-everything rule): the row is hidden, never erased — deleted_at
// and deleted_by record who removed it and when, and every read skips it.
booksRouter.delete('/transactions/:id', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    refuseRetiredForLandlord(col)
    const { rows: [tx] } = await db.query(
      `UPDATE books_transactions SET deleted_at=NOW(), deleted_by=$3, updated_at=NOW()
       WHERE id=$1 AND (${col}=$2 OR $2 IS NULL) AND deleted_at IS NULL RETURNING id`,
      [req.params.id, lid, req.user!.userId]
    )
    if (!tx) throw new AppError(404, 'Transaction not found')
    res.json({ success: true })
  } catch (e) { next(e) }
})

/**
 * GET /api/books/reconciliation?accountId= — 10/11: Bank Reconciliation for
 * ONE bank account. The page used to take every unreconciled transaction in
 * the books (the first 100 of them — the list's default cap), whatever account
 * was chosen, and call their sum the "book balance". Now:
 *
 *   journalBalance  journal entries posted to this account (its ledger balance)
 *   clearedNet      this account's transactions already marked reconciled
 *                   (money in +, money out −)
 *   clearedBalance  journalBalance + clearedNet — what the bank statement's
 *                   ending balance should match
 *   unclearedNet    this account's transactions not yet marked
 *   bookBalance     clearedBalance + unclearedNet — everything the books say
 *                   is in the account
 *   uncleared       every one of those unmarked transactions (no cap)
 *   unassignedCount transactions tied to no account at all: they belong to no
 *                   reconciliation, and the page says so rather than guessing.
 *
 * Sums are taken over every row in the database, in whole cents.
 */
booksRouter.get('/reconciliation', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    const accountId = String(req.query.accountId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new AppError(400, 'Choose the bank account to reconcile.')
    const acct = await queryOne<any>(
      `SELECT * FROM books_accounts WHERE id=$1 AND (${col}=$2 OR $2 IS NULL)`, [accountId, lid])
    if (!acct) throw new AppError(404, 'Account not found')
    if (acct.type !== 'asset') throw new AppError(400, `${acct.name} is not a bank account, so there is nothing to reconcile.`)
    const sums = await queryOne<{ cleared: string; uncleared: string }>(
      `SELECT COALESCE(SUM(CASE WHEN reconciled THEN (CASE WHEN type='income' THEN amount ELSE -amount END) END), 0)::text AS cleared,
              COALESCE(SUM(CASE WHEN NOT reconciled THEN (CASE WHEN type='income' THEN amount ELSE -amount END) END), 0)::text AS uncleared
         FROM books_transactions
        WHERE account_id=$1 AND (${col}=$2 OR $2 IS NULL) AND deleted_at IS NULL`,
      [accountId, lid])
    const { rows: uncleared } = await db.query(
      `SELECT * FROM books_transactions
        WHERE account_id=$1 AND (${col}=$2 OR $2 IS NULL) AND deleted_at IS NULL AND reconciled = FALSE
        ORDER BY date ASC, created_at ASC`,
      [accountId, lid])
    const unassigned = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM books_transactions
        WHERE account_id IS NULL AND (${col}=$1 OR $1 IS NULL) AND deleted_at IS NULL AND reconciled = FALSE`,
      [lid])
    const journalCents = booksCents(booksNormalBalance(acct.type, acct.balance))
    const clearedCents = booksCents(sums?.cleared)
    const unclearedCents = booksCents(sums?.uncleared)
    res.json({
      success: true,
      data: {
        account: { id: acct.id, code: acct.code, name: acct.name },
        journalBalance: journalCents / 100,
        clearedNet:     clearedCents / 100,
        clearedBalance: (journalCents + clearedCents) / 100,
        unclearedNet:   unclearedCents / 100,
        bookBalance:    (journalCents + clearedCents + unclearedCents) / 100,
        uncleared,
        unassignedCount: unassigned?.n ?? 0,
      },
    })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════

/**
 * 10/12 review (Nic: "the property boxes keep governing property money"; "a
 * company-wide-only bookkeeper sees no property money"). The Books company
 * reports — P&L, cash flow, owner statements — are the company-wide box's, but
 * the PROPERTY money in them follows a bookkeeper's property boxes: their kept
 * properties and their former ones, each former one cut at the day it left
 * (lib/bookkeeperScope). The ledger, payroll, bills and payouts in them stay
 * whole (the company-wide box's own). Before, these reports read every
 * property for any company-wide bookkeeper, whatever their boxes said, so a
 * company-wide-only bookkeeper got every property's rent, and a sold property
 * that was never theirs counted even after the sale. Now the same report
 * never depends on boxes unrelated to it, and matches what the Team page
 * tells the owner (bookkeeperAccessSummary). The owner and staff over every
 * property read the whole company, as before.
 *
 * 10/12 (Nic, BK2): "Company reports show the whole company" is the owner's
 * box per bookkeeper. Ticked, these reports carry every property the company
 * still owns and its money on no property (a sold property they never kept
 * stays hidden — BK3); unticked, their properties only, as above.
 * (lib/bookkeeperScope requestScopeOf companyReports.)
 */
async function companyReportPropertyScope(user: any): Promise<{ propertyIds: string[] | null; cutoffs: PropertyCutoff[] }> {
  if (user?.role !== 'bookkeeper') return { propertyIds: null, cutoffs: [] }
  return (await bookkeeperRequestScopeOf(user)).companyReports
}

// 10/12 (Nic, ledger P8): once a company's books are live, its P&L, balance
// sheet and cash flow answer from the ledger, and the trial balance, general
// ledger and money-out report open (routes/booksLedgerReports). Registered
// here, ahead of the older routes below, which still answer for a company
// whose books are not live yet, an admin's every landlord and a business.
registerBooksLedgerReportRoutes(booksRouter, { ownerScope, companyReportPropertyScope })

booksRouter.get('/reports/pl', requireBooksRead, async (req, res, next) => {
  try {
    // 10/12 (Nic): no switch — gamPL carries Received, Charged and Owed side
    // by side (its view, with the tie line, and the net on each column);
    // gross / net stay Received for an older screen (BOOKS_BASIS).
    const basis = BOOKS_BASIS
    // S655 (gam-audience-data-isolation): the Books P&L is the whole company's
    // (its ledger accounts and every property's income), so a team member
    // assigned to some properties is refused it in plain words — as the
    // Reports owner statement and tax summary are. Reports' own P&L shows
    // them their properties.
    // 10/12 (Nic, BK1): the P&L is part of the ledger, so the ledger box opens it too.
    await refuseScopedStaff(req.user, 'Books profit and loss', { ledger: true })
    const { col, id: lid } = ownerScope(req.user)
    const { startDate, endDate } = req.query
    // S654: the default range runs to TODAY in GAM's home zone (Phoenix, the
    // database's CURRENT_DATE). UTC turns over at 5 pm here, so an evening
    // P&L used to run into tomorrow.
    const today = todayIn(null)
    const start = startDate || `${today.slice(0, 4)}-01-01`
    const end = endDate || today

    // Income and expense accounts: what was posted to each in the range.
    // 10/11: the date, posted-only and owner tests sat in the LEFT JOIN's ON to
    // journal_entries while the SUM read journal_entry_lines, so every line
    // was summed whatever its entry — voided entries and entries outside the
    // range included. The lines now join only through an entry that passes.
    // An account turned off since is still listed when it has activity in the
    // range (it held money then).
    const periodSql = (type: 'income' | 'expense', amount: string) =>
      `SELECT ba.code, ba.name, ba.balance,
          COALESCE(SUM(${amount}), 0) AS period_amount
        FROM books_accounts ba
        LEFT JOIN (journal_entry_lines jel
                   JOIN journal_entries je ON je.id = jel.entry_id
                    AND je.date BETWEEN $2 AND $3
                    AND je.status = 'posted'
                    AND (je.${col} = $1 OR $1 IS NULL))
          ON jel.account_id = ba.id
        WHERE ba.type = '${type}'
          AND (ba.${col} = $1 OR $1 IS NULL)
        GROUP BY ba.id
        HAVING ba.active OR COALESCE(SUM(${amount}), 0) <> 0
        ORDER BY ba.code`
    const { rows: income } = await db.query(periodSql('income', 'jel.credit - jel.debit'), [lid, start, end])
    const { rows: expenses } = await db.query(periodSql('expense', 'jel.debit - jel.credit'), [lid, start, end])

    // Pull rent income from GAM payments if synced. S387 fix: was
    // subquerying landlords WHERE user_id=$1 with req.user.userId —
    // worked by coincidence for landlord callers but returned 0 for
    // admin and bookkeeper callers (their user_id doesn't match any
    // landlord's user_id). Use lid directly — it IS the ${col}
    // (or NULL for admin = all).
    // S568 detangle: for a specific landlord, pull the GAM P&L from the SINGLE
    // shared definition (computeLandlordPL) — categorized income, deposits
    // EXCLUDED (they were wrongly counted as income here), same expenses as the
    // landlord reports. Admin (all-landlords) keeps the legacy lumped sum.
    let rentIncome: any[] = [{ total: 0 }]
    let gamPL: any = null
    if (col === 'landlord_id' && lid) {
      const { computeLandlordPL } = await import('../services/landlordPL')
      // platformFeesByProperty expects YYYY-MM-01 month keys (matches periodMonths).
      const monthKeys: string[] = []
      { const s = new Date(String(start) + 'T00:00:00'); const e = new Date(String(end) + 'T00:00:00')
        for (let d = new Date(s.getFullYear(), s.getMonth(), 1); d <= e; d.setMonth(d.getMonth() + 1))
          monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`) }
      // 10/12 (Nic): a bookkeeper's property money is their properties' only,
      // each property that left the company counted up to the day it left
      // (companyReportPropertyScope).
      const bkProps = await companyReportPropertyScope(req.user)
      gamPL = await computeLandlordPL(lid, String(start), String(end), monthKeys, basis, bkProps.propertyIds, bkProps.cutoffs)
      rentIncome = [{ total: gamPL.gross.total }]
    } else if (col === 'landlord_id') {
      // Admin (every landlord): the same income facts, platform-wide.
      const t = await incomeTotals({ landlordIds: null, start: String(start), end: String(end), basis })
      rentIncome = [{ total: t.total }]
    }

    // S459: for a business owner, pull REAL collected revenue the platform
    // already tracks — completed POS sales + collected invoices — so the P&L
    // reflects actual sales, not only manually-booked ledger entries. Mirrors
    // the landlord gamRentIncome pull and the businessReports revenue
    // definition (status='completed' POS by date, status='paid' invoices by
    // paid_at) so the two surfaces agree. Zero for non-business callers.
    let gamBusinessRevenue = 0
    if (col === 'business_id' && lid) {
      const { rows: bizRev } = await db.query(
        `SELECT
           COALESCE((SELECT SUM(total_amount) FROM business_pos_transactions
                      WHERE business_id=$1 AND status='completed'
                        AND created_at::date BETWEEN $2 AND $3), 0)
           +
           COALESCE((SELECT SUM(amount_paid) FROM business_invoices
                      WHERE business_id=$1 AND status='paid'
                        AND paid_at::date BETWEEN $2 AND $3), 0) AS total`,
        [lid, start, end]
      ).catch(() => ({ rows: [{ total: 0 }] }))
      gamBusinessRevenue = +bizRev[0]?.total || 0
    }

    const totalIncome = income.reduce((s: number, a: any) => s + (+a.period_amount || 0), 0)
    const totalExpenses = expenses.reduce((s: number, a: any) => s + (+a.period_amount || 0), 0)

    res.json({
      success: true,
      data: {
        period: { start, end },
        income,
        expenses,
        totalIncome,
        totalExpenses,
        netIncome: totalIncome - totalExpenses,
        gamRentIncome: +rentIncome[0]?.total || 0,
        // S568 detangle: the SAME shared P&L the landlord reports use (categorized
        // income, deposits-out, all expenses). Null for admin/business callers.
        gamPL,
        meta: { basis: basisMeta(basis) },
        // Auto-pulled real sales (POS + collected invoices). Surfaced
        // separately so totalIncome/netIncome stay journal-only (no landlord
        // behavior change); business P&L UI folds this into its net.
        gamBusinessRevenue,
      }
    })
  } catch (e) { next(e) }
})

/**
 * 10/11 — THE BALANCE SHEET, READ THE WAY IT IS WRITTEN.
 *
 * Balances are stored as debits minus credits for every account (one rule for
 * every posting), and the sheet used to print them as stored: every liability
 * and equity figure came out negative, the "balanced" test compared those raw
 * signs (assets = liabilities + equity can only hold with the signs flipped),
 * and income and expenses — never closed into equity — were left off entirely.
 * So it could never balance on real entries.
 *
 * Now each account is shown in its normal sign (booksNormalBalance), and the
 * earnings not yet closed into an equity account are added to equity on two
 * lines: earlier years' (posted entries dated before January 1) and this
 * year's (the rest, including anything dated later in the year). Assets = liabilities + equity then
 * holds whenever every entry balanced, and is compared in whole cents — so
 * "Out of balance" now means something is genuinely wrong in the books.
 * An account turned off while it still held money (before 10/11 that was
 * allowed) is listed, so its money is not missing from either side.
 */
booksRouter.get('/reports/balance-sheet', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    // S654: as of today in Phoenix, not the UTC date (tomorrow after 5 pm).
    const asOf = todayIn(null)
    const yearStart = `${asOf.slice(0, 4)}-01-01`
    const { rows: accounts } = await db.query(
      `SELECT code, name, type, balance, active FROM books_accounts
        WHERE (${col}=$1 OR $1 IS NULL) AND (active OR balance <> 0)
        ORDER BY code`,
      [lid]
    )
    const shown = (type: string) => accounts
      .filter((a: any) => a.type === type)
      .map((a: any) => ({ code: a.code, name: a.name, balance: booksNormalBalance(a.type, a.balance), active: a.active }))
    const sumCents = (rows: Array<{ balance: number }>) => rows.reduce((s, a) => s + booksCents(a.balance), 0)
    const assets = shown('asset'), liabilities = shown('liability'), equity = shown('equity')

    // Earnings not closed into equity: income earned less expenses, all time.
    const unclosedCents = sumCents(shown('income')) - sumCents(shown('expense'))
    // Earlier years' part, from posted entries dated before January 1 (an
    // income line's credit raises it, an expense line's debit lowers it); this
    // year's is the rest. 10/11: it was the other way round — this year from
    // entries dated January 1 through today, earlier years the remainder — so
    // an accrual posted now but dated December 31 (or next January) landed
    // under "Earnings from earlier years". The account balances hold every
    // posted entry whatever its date, so anything dated this year or later
    // belongs on this year's line.
    const before = await queryOne<{ net: string }>(
      `SELECT COALESCE(SUM(jel.credit - jel.debit), 0)::text AS net
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.entry_id
         JOIN books_accounts ba ON ba.id = jel.account_id
        WHERE ba.type IN ('income', 'expense')
          AND je.status = 'posted'
          AND je.date < $2
          AND (je.${col} = $1 OR $1 IS NULL)`,
      [lid, yearStart]
    )
    const earlierCents = booksCents(before?.net)
    const thisYearCents = unclosedCents - earlierCents

    const assetsCents = sumCents(assets)
    const liabilitiesCents = sumCents(liabilities)
    const equityCents = sumCents(equity) + unclosedCents
    res.json({
      success: true,
      data: {
        asOf,
        assets, totalAssets: assetsCents / 100,
        liabilities, totalLiabilities: liabilitiesCents / 100,
        equity,
        // Inside totalEquity: earnings not yet closed into an equity account.
        earnings: { thisYear: thisYearCents / 100, earlierYears: earlierCents / 100 },
        totalEquity: equityCents / 100,
        balances: assetsCents === liabilitiesCents + equityCents,
      }
    })
  } catch (e) { next(e) }
})


// ════════════════════════════════════════
// BILLS & AP
// ════════════════════════════════════════

/**
 * 10/11: money out for bills, one row per payment on the day it was made
 * (books_bill_payments), plus — for a bill whose amount_paid is more than its
 * payment rows — the difference, dated the day the bill was paid off (else its
 * last change).
 *
 * Why the second half: migrations reach production before the code that
 * writes payment rows. The table's backfill ran once, at the migration; a bill
 * paid in between by the old pay route got no row, and Cash Flow (which reads
 * bills only from here) would leave that money out for good. Read this way,
 * the gap closes on its own and nothing is counted twice: once every payment
 * has its row, the second half is empty.
 *
 * `col` is the owner column (landlord_id or business_id); the rows carry it as
 * owner_id. out_amount includes an overpayment kept as vendor credit — that
 * money left the bank too.
 */
const billMoneyOutSql = (col: OwnerCol) => `
  SELECT p.bill_id, p.${col} AS owner_id, p.paid_on, (p.amount + p.vendor_credit) AS out_amount
    FROM books_bill_payments p
    -- 10/12 (Nic, L5): a bill moved onto Expenses counts there (once).
    JOIN books_bills mb ON mb.id = p.bill_id AND mb.migrated_at IS NULL
  UNION ALL
  SELECT b.id, b.${col}, COALESCE(b.paid_at, b.updated_at, b.created_at)::date, b.amount_paid - COALESCE(s.paid, 0)
    FROM books_bills b
    LEFT JOIN (SELECT bill_id, SUM(amount) AS paid FROM books_bill_payments GROUP BY bill_id) s ON s.bill_id = b.id
   WHERE b.amount_paid > COALESCE(s.paid, 0) AND b.migrated_at IS NULL`

booksRouter.get('/bills', requireBooksRead, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    // 10/11: paid_this_month = what went out toward this bill since the 1st
    // (Phoenix), by the day of each payment. The Bills page's "Paid This
    // Month" tile summed amount_paid of bills paid OFF this month, so a
    // partial payment showed $0 until the last part, and then the whole bill,
    // earlier months' parts included.
    const monthStart = `${todayIn(null).slice(0, 7)}-01`
    const { rows } = await db.query(
      `SELECT bb.*, bv.name AS vendor_name,
              COALESCE(pm.paid_this_month, 0) AS paid_this_month
       FROM books_bills bb
       LEFT JOIN books_vendors bv ON bv.id = bb.vendor_id
       LEFT JOIN (SELECT bp.bill_id, SUM(bp.out_amount) AS paid_this_month
                    FROM (${billMoneyOutSql(col)}) bp
                   WHERE (bp.owner_id = $1 OR $1 IS NULL) AND bp.paid_on >= $2::date
                   GROUP BY bp.bill_id) pm ON pm.bill_id = bb.id
       WHERE (bb.${col} = $1 OR $1 IS NULL)
       ORDER BY bb.date DESC`,
      [lid, monthStart]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// 10/11: a bill is for an amount above zero; its date and due date are
// dates. Saving it and adding it to the vendor's open balance happen in one
// transaction — they were two statements, so a failure between them left a
// bill with no balance owed for it.
const billCreateSchema = z.object({
  vendorId:    z.preprocess(blankToUndefined, z.string().uuid('Choose a vendor from the list.').optional()),
  billNumber:  optionalText(100),
  date:        isoDate('bill date'),
  dueDate:     z.preprocess(blankToUndefined, isoDate('due date').optional()),
  description: z.string({ required_error: 'Enter what the bill is for.' }).trim().min(1, 'Enter what the bill is for.'),
  amount:      z.preprocess(v => (v === '' || v === null ? undefined : v),
                 z.coerce.number({ required_error: 'Enter the bill amount.', invalid_type_error: 'Enter the bill amount.' })
                   .refine(n => Number.isFinite(n) && booksCents(n) > 0, 'A bill is for an amount above zero.')),
  category:    optionalText(100),
  accountId:   z.preprocess(blankToUndefined, z.string().uuid('Choose an account from the list.').optional()),
  notes:       optionalText(5000),
})

booksRouter.post('/bills', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    refuseRetiredForLandlord(col)
    const { date, description, amount } = req.body ?? {}
    if (!date || !description || amount === undefined)
      throw new AppError(400, 'date, description, amount required')
    const body = parseBooks(billCreateSchema, req.body)
    const { vendorId, accountId } = body
    // S386 fix — vendorId + accountId scope validation. Pre-fix, the
    // route blindly trusted vendorId and would UPDATE another
    // landlord's books_vendors.ap_balance.
    if (vendorId && lid !== null) {
      const ok = await queryOne<{ id: string }>(
        `SELECT id FROM books_vendors WHERE id=$1 AND ${col}=$2`,
        [vendorId, lid]
      )
      if (!ok) throw new AppError(403, 'Vendor is not in your books')
    }
    if (accountId && lid !== null) {
      const ok = await queryOne<{ id: string }>(
        `SELECT id FROM books_accounts WHERE id=$1 AND ${col}=$2`,
        [accountId, lid]
      )
      if (!ok) throw new AppError(403, 'Account is not in your chart of accounts')
    }
    const amountText = (booksCents(body.amount) / 100).toFixed(2)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [bill] } = await client.query(
        `INSERT INTO books_bills
           (${col}, vendor_id, bill_number, date, due_date, description, amount, category, account_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [lid, vendorId ?? null, body.billNumber ?? null, body.date, body.dueDate ?? null,
         body.description, amountText, body.category ?? null, accountId ?? null, body.notes ?? null]
      )
      if (vendorId) {
        await client.query(
          `UPDATE books_vendors SET ap_balance = COALESCE(ap_balance,0) + $1, updated_at=NOW() WHERE id=$2`,
          [amountText, vendorId]
        )
      }
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: bill })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// POST /api/books/bills/:id/pay — record a payment toward a bill.
//
// 10/11:
//   - The amount is above zero (a negative "payment" lowered what was paid and
//     the vendor's year-to-date). Leaving it out pays what is left.
//   - The bill is read and locked inside the one transaction that moves the
//     bill, the vendor's balances and the payment's own row, so a double-click
//     cannot apply the same payment twice and a failure leaves nothing half done.
//   - Each payment is its own row in books_bill_payments, on the day it was
//     made. Cash Flow reads money out for bills from those rows: a bill paid in
//     parts shows each part on its own day (before, nothing showed until the
//     last part, and then the whole bill showed on that day).
//   - Amounts are compared in whole cents.
booksRouter.post('/bills/:id/pay', requireBooksWrite, async (req, res, next) => {
  try {
    const { col, id: lid } = ownerScope(req.user)
    refuseRetiredForLandlord(col)
    const sentAmount = req.body?.amount
    const amountGiven = sentAmount !== undefined && sentAmount !== null && sentAmount !== ''
    if (amountGiven && !(Number.isFinite(Number(sentAmount)) && booksCents(sentAmount) > 0)) {
      throw new AppError(400, 'A payment is an amount above zero.')
    }
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [bill] } = await client.query<any>(
        `SELECT * FROM books_bills WHERE id=$1 AND (${col}=$2 OR $2 IS NULL) FOR UPDATE`,
        [req.params.id, lid]
      )
      if (!bill) throw new AppError(404, 'Bill not found')
      if (bill.status === 'paid') throw new AppError(400, 'Bill already paid')
      const remainingCents = booksCents(bill.amount) - booksCents(bill.amount_paid)
      if (remainingCents <= 0) throw new AppError(400, 'Nothing is left to pay on this bill.')
      // S413's tolerance carries over: a payment within one cent over what is
      // left (100.005 against $100.00 rounds to $100.01) pays the bill off,
      // with no confirmation and no vendor credit.
      const askedCents = amountGiven ? booksCents(sentAmount) : remainingCents
      const payCents = askedCents - remainingCents === 1 ? remainingCents : askedCents

      // S413 (S386 Nic-locked decision): two-phase overpayment confirmation.
      // Pre-fix any amount was accepted; an overpayment silently:
      //   - stored amount_paid > amount on the bill
      //   - updated vendor.ytd_paid by the full payAmount
      //   - clamped ap_balance to 0 via GREATEST() — losing the excess
      //     from the vendor accounting picture entirely.
      // Now: detect the excess and require an explicit
      // acceptOverpayment=true second-request confirmation. On confirm,
      // bill closes at exactly amount_paid=amount, and the excess
      // accrues to books_vendors.credit_balance for future application.
      const overCents = payCents - remainingCents
      if (overCents > 0 && req.body?.acceptOverpayment !== true) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          success: false,
          error: 'Payment exceeds bill remaining; confirmation required',
          requiresOverpaymentConfirm: true,
          billRemaining: remainingCents / 100,
          overpaymentAmount: overCents / 100,
          vendorId: bill.vendor_id,
        })
      }

      // When confirmed, cap the bill at amount; route the excess to the
      // vendor credit balance below.
      const appliedCents = overCents > 0 ? remainingCents : payCents
      const creditCents = overCents > 0 ? overCents : 0
      const newPaidCents = booksCents(bill.amount_paid) + appliedCents
      const newStatus = newPaidCents >= booksCents(bill.amount) ? 'paid' : 'partial'
      // S386: paid_at computed in JS to avoid reusing $2 in two type
      // contexts. Pre-fix used $2 for both column-assign (varchar) and
      // literal compare inside CASE; Postgres couldn't deduce a single
      // type and the route returned 500 on every /pay call.
      const paidAtClause = newStatus === 'paid' ? 'NOW()' : 'paid_at'
      const { rows: [updated] } = await client.query(
        `UPDATE books_bills SET
           amount_paid=$1, status=$2,
           paid_at=${paidAtClause},
           updated_at=NOW()
         WHERE id=$3 RETURNING *`,
        [(newPaidCents / 100).toFixed(2), newStatus, bill.id]
      )
      // The payment's own row, on the day it was made (GAM's home-zone day,
      // as every Books report reads "today").
      await client.query(
        `INSERT INTO books_bill_payments
           (bill_id, landlord_id, business_id, paid_on, amount, vendor_credit, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'payment',$7)`,
        [bill.id, bill.landlord_id, bill.business_id, todayIn(null),
         (appliedCents / 100).toFixed(2), (creditCents / 100).toFixed(2), req.user!.userId]
      )
      if (bill.vendor_id) {
        // Vendor accounting: ap_balance / ytd_paid reflect ONLY the
        // bill-applied portion (cappedPayAmount). The excess flows to
        // credit_balance separately so consumers can distinguish
        // "vendor has been paid for THIS bill" from "vendor has a
        // pre-payment credit on file."
        await client.query(
          `UPDATE books_vendors SET
             ap_balance     = GREATEST(0, COALESCE(ap_balance,0) - $1),
             ytd_paid       = COALESCE(ytd_paid,0) + $1,
             credit_balance = COALESCE(credit_balance,0) + $2,
             updated_at     = NOW()
           WHERE id=$3`,
          [(appliedCents / 100).toFixed(2), (creditCents / 100).toFixed(2), bill.vendor_id]
        )
      }
      await client.query('COMMIT')
      res.json({
        success: true,
        data: updated,
        overpaymentCreditRecorded: creditCents / 100,
      })
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// CASH FLOW REPORT
// ════════════════════════════════════════

booksRouter.get('/reports/cash-flow', requireBooksRead, async (req, res, next) => {
  try {
    // S655 (gam-audience-data-isolation): the company's cash — every
    // property's money in, payroll, bills, payouts — so a team member assigned
    // to some properties is refused it in plain words.
    await refuseScopedStaff(req.user, 'Books cash flow')
    const { col, id: lid } = ownerScope(req.user)
    const { startDate, endDate } = req.query
    // S654: year-to-date ends today in Phoenix, not on the UTC date.
    const today = todayIn(null)
    const start = (startDate as string) || `${today.slice(0, 4)}-01-01`
    const end   = (endDate   as string) || today

    // S655: money IN through GAM, by the day it ARRIVED (Money received): each
    // bill's own money on its settle day, paid-ahead money on its own line on
    // the day it arrived (Todd's two-month check: $460 rent + $460 paid ahead,
    // both in September), register sales and stays. A credit the landlord gave
    // never appears: no money moved. Deposits are held, not income, and are
    // reported apart.
    //
    // 10/11: the company's money in and out that is recorded elsewhere in GAM
    // is here too, so this page agrees with what the owner sees on the
    // financial pages and in Reports: other income filed from the bank
    // (incomeBasis's "Other income" line — owner contributions and sale
    // proceeds are not income and are not on it), the Expenses page's spend
    // and the maintenance costs (landlordPLExpenses — the P&L's own
    // definitions: an expense by its date, a repair by the day it was
    // completed). The Books ledger's own transactions keep their own lines.
    // 10/12 (Nic): a bookkeeper's property money is their properties' only,
    // with the clean cut at a sale (companyReportPropertyScope).
    const { propertyIds: bkPropertyIds, cutoffs } = await companyReportPropertyScope(req.user)
    const gamEvents = col === 'landlord_id'
      ? await incomeEvents({ landlordIds: lid ? [lid] : null, start, end, basis: 'received', propertyIds: bkPropertyIds, cutoffs })
      : null
    const gamIn = gamEvents ? summarize(gamEvents, 'received') : null
    // 10/11: the processing fees the landlord covers for their tenants are
    // netted from the payout like a chargeback's fees, so they are money going
    // out too (landlordPLExpenses already counts them on the P&L).
    const companyCosts = await (async (): Promise<{ enteredExpenses: number; maintenance: number; processingFees: number }> => {
      if (col !== 'landlord_id') return { enteredExpenses: 0, maintenance: 0, processingFees: 0 }
      // 10/12 review: the Expenses record's money out is its PAYMENTS, on the
      // day each was made (landlordExpensesPaidOut). Since money out became one
      // record (Nic L5) an expense can be an unpaid bill (a repair's, payroll's
      // contractor hours, a hand-entered or moved bill) or paid in parts, so
      // the expense's amount on its date counted bills nobody had paid as cash
      // gone, and never showed the part-payments of an earlier bill. The old
      // Books bills that moved onto Expenses keep their payment days there.
      const { landlordPLExpenses, landlordExpensesPaidOut } = await import('../services/landlordPL')
      if (lid) {
        const x = await landlordPLExpenses(lid, start, end, [], bkPropertyIds, cutoffs)
        const paidOut = await landlordExpensesPaidOut(lid, start, end, bkPropertyIds, cutoffs)
        return { enteredExpenses: paidOut, maintenance: x.maintenance, processingFees: x.processingFees }
      }
      // An admin (every company): the same two definitions, across all of them.
      const row = await queryOne<{ maint: string }>(
        `SELECT (SELECT COALESCE(SUM(actual_cost), 0) FROM maintenance_requests mr
                  WHERE actual_cost IS NOT NULL AND completed_at >= $1 AND completed_at < ($2::date + 1)
                    AND ${maintenanceCostNotBilledSql('mr')})::text AS maint`,
        [start, end])
      return { enteredExpenses: await landlordExpensesPaidOut(null, start, end), maintenance: booksCents(row?.maint) / 100, processingFees: 0 }
    })()
    const [incomeRows, expenseRows, payrollRows, billRows, disbRows] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM books_transactions
         WHERE (${col}=$1 OR $1 IS NULL) AND type='income' AND date BETWEEN $2 AND $3
           AND deleted_at IS NULL AND migrated_at IS NULL`,
        [lid, start, end]
      ),
      db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM books_transactions
         WHERE (${col}=$1 OR $1 IS NULL) AND type='expense' AND date BETWEEN $2 AND $3
           AND deleted_at IS NULL AND migrated_at IS NULL`,
        [lid, start, end]
      ),
      db.query(
        `SELECT COALESCE(SUM(total_net),0) AS total FROM payroll_runs
         WHERE (${col}=$1 OR $1 IS NULL) AND status='approved' AND pay_date BETWEEN $2 AND $3`,
        [lid, start, end]
      ),
      // 10/11: each bill payment on the day it was made (books_bill_payments),
      // an overpayment kept as vendor credit included — that money left too.
      // It read the bill's running total on the day it was paid OFF, so a
      // bill paid in parts showed nothing until its last part, then all of it.
      // (billMoneyOutSql also counts a bill paid while the old pay route was
      // still live, before it wrote payment rows.)
      db.query(
        `SELECT COALESCE(SUM(bp.out_amount),0) AS total
           FROM (${billMoneyOutSql(col)}) bp
          WHERE (bp.owner_id=$1 OR $1 IS NULL) AND bp.paid_on BETWEEN $2 AND $3`,
        [lid, start, end]
      ),
      db.query(
        `SELECT COALESCE(SUM(d.amount),0) AS total FROM disbursements d
         JOIN landlords l ON l.id=d.landlord_id
         WHERE (l.id=$1::uuid OR $1 IS NULL) AND d.status='settled' AND d.target_date BETWEEN $2 AND $3`,
        [lid, start, end]
      ).catch(() => ({ rows: [{ total: 0 }] })),
    ])

    const r2 = (n: number) => Math.round(n * 100) / 100
    const L = gamIn?.lines
    const paidAhead     = L ? L.paidAhead : 0
    const registerAndStays = L ? L.registerAndStays : 0
    // Only money that ARRIVED: each bill's own money (rent, fees, utilities,
    // late fees, home payments, balances collected) and a deposit shortfall the
    // tenant paid, less returns and disputes.
    const ARRIVAL_LINES = ['rent', 'fees', 'utilities', 'lateFees', 'homeSale', 'balances', 'depositShortfall', 'returned'] as const
    const rentCollected = L ? r2(ARRIVAL_LINES.reduce((s, k) => s + L[k], 0)) : 0
    // The move-out lines of the P&L (kept from deposits, deposit deductions,
    // paid-ahead money that went into the settlement) are not money arriving
    // when the deposit was the landlord's to hold: it arrived when it was paid
    // (deposits held) and is only kept now. Two parts of a move-out ARE cash:
    //   - a deposit GAM held in escrow: GAM pays the landlord's share out at
    //     finalize (depositReturn's settlement transfer), so it arrives then;
    //   - paid-ahead money handed back: it counted when it arrived, so what
    //     goes back out at move-out is money leaving (a move-out's lines
    //     adding up below $0 means more paid-ahead money went back than the
    //     deductions kept).
    //
    // A move-out's facts are added up per MOVE-OUT (the deposit return), never
    // per lease: depositReturn sweeps the whole renewal chain, so a swept bill
    // can sit on the previous lease while the deposit and its deductions sit on
    // the new one. Grouped by lease, the swept bills read as money kept and the
    // move-out's own lines as money going out — cash that never moved. Who held
    // the deposit is read off the move-out's own lease, where depositReturn
    // reads it.
    const MOVE_OUT_LINES = new Set(['keptFromDeposits', 'depositDeductions', 'paidAheadRefunded'])
    const byMoveOut = new Map<string, number>()
    for (const e of gamEvents ?? []) {
      if (!e.inTotal || !MOVE_OUT_LINES.has(e.line)) continue
      const k = e.moveOutId ?? ''
      byMoveOut.set(k, (byMoveOut.get(k) ?? 0) + e.amount)
    }
    const escrowMoveOuts = new Set(byMoveOut.size
      ? (await db.query<{ id: string }>(
          `SELECT dr.id FROM deposit_returns dr
            WHERE dr.id = ANY($1::uuid[])
              AND EXISTS (SELECT 1 FROM security_deposits sd
                           WHERE sd.lease_id = dr.lease_id AND sd.held_by = 'gam_escrow' AND sd.status <> 'voided')`,
          [[...byMoveOut.keys()].filter(Boolean)])).rows.map(r => r.id)
      : [])
    let moveOutCash = 0, keptAtMoveOut = 0
    for (const [moveOutId, amt] of byMoveOut) {
      if (escrowMoveOuts.has(moveOutId)) moveOutCash += amt
      else { moveOutCash += Math.min(0, amt); keptAtMoveOut += Math.max(0, amt) }
    }
    moveOutCash = r2(moveOutCash)
    keptAtMoveOut = r2(keptAtMoveOut)
    const depositsHeld  = gamIn ? gamIn.beside.depositsHeld : 0
    // A chargeback's fees (Stripe's dispute fee, the buyer's card fee) are
    // netted from the landlord's payout: money going out.
    const chargebackFees = gamIn ? gamIn.beside.chargebackFees : 0
    // 10/4 (#38 Q4): the card fee a guest got back with an early check-out
    // refund is netted from the payout too.
    const refundCardFees = gamIn ? gamIn.beside.refundCardFees : 0
    // The Books ledger's own income and expense transactions.
    const otherIncome   = +incomeRows.rows[0]?.total || 0
    const expenses      = +expenseRows.rows[0]?.total || 0
    // 10/11: recorded elsewhere in GAM (see above).
    const filedOtherIncome = L ? r2(L.otherIncome ?? 0) : 0
    const { enteredExpenses, maintenance, processingFees } = companyCosts
    const payroll       = +payrollRows.rows[0]?.total || 0
    const bills         = +billRows.rows[0]?.total || 0
    const disbursements = +disbRows.rows[0]?.total || 0
    // 10/11: bank deposits filed as the owner putting money in, or as the
    // proceeds of selling something. Not income (kept off the P&L and out of
    // operating), but cash that arrived, so a cash statement counts them:
    // financing and investing, the way owner payouts already sit in financing.
    const ownerContributions = gamIn ? gamIn.beside.ownerContributions : 0
    const saleProceeds       = gamIn ? gamIn.beside.saleProceeds : 0
    const totalInflows  = r2(rentCollected + paidAhead + registerAndStays + moveOutCash + otherIncome + filedOtherIncome)
    const totalOutflows = r2(expenses + enteredExpenses + maintenance + payroll + bills + chargebackFees + refundCardFees + processingFees)
    const opNet         = r2(totalInflows - totalOutflows)
    // Signed: money in is positive.
    const netFinancing  = r2(ownerContributions - disbursements)
    const netInvesting  = r2(saleProceeds)

    res.json({
      success: true,
      data: {
        period: { start, end },
        operating: {
          inflows:  { rentCollected, paidAhead, registerAndStays, moveOut: moveOutCash, otherIncome, filedOtherIncome, total: totalInflows },
          outflows: { expenses, enteredExpenses, maintenance, payroll, bills, chargebackFees, refundCardFees, processingFees, total: totalOutflows },
          net: opNet,
        },
        // S655: kept from deposits the landlord already held — counted when
        // the deposit was paid, so not money arriving now (outside every total).
        nonCash: { keptAtMoveOut },
        // 10/11: totals are signed (money in positive). financing.total used
        // to be the disbursements as a positive outflow.
        financing: { disbursements, ownerContributions, total: netFinancing },
        investing: { saleProceeds, total: netInvesting },
        netCashFlow: r2(opNet + netFinancing + netInvesting),
        // S654: deposits collected in the range — held for tenants, not income,
        // so outside every total above.
        depositsHeld,
        // S655: still clearing at the bank — not arrived yet, so not counted.
        stillClearing: gamIn ? gamIn.beside.clearing : 0,
        meta: {
          basis: basisMeta('received'),
          note: 'Money in, by the day it arrived. Money paid ahead is its own line on the day it arrived. A credit you give never appears. A deposit you already held and keep at move-out is not new money.',
        },
      }
    })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// OWNER STATEMENTS REPORT
// ════════════════════════════════════════

booksRouter.get('/reports/owner-statements', requireBooksRead, blockBusinessOwner, async (req, res, next) => {
  try {
    const basis = BOOKS_BASIS
    // S655 (gam-audience-data-isolation): a company document, refused to a
    // team member assigned to some properties — as the Reports owner statement is.
    await refuseScopedStaff(req.user, 'owner statement')
    const lid = landlordScope(req.user)
    // 10/12 (Nic): a bookkeeper's statement lists their properties only, with
    // the clean cut at a sale (companyReportPropertyScope): a company-wide-only
    // bookkeeper gets the payouts and no property's own money.
    const bkProps = await companyReportPropertyScope(req.user)
    const { startDate, endDate } = req.query
    // S654: month-to-date in Phoenix. The UTC date flips at 5 pm here, and on
    // the last of the month that flipped the whole range into next month.
    const today = todayIn(null)
    const start = (startDate as string) || monthStartOf(today)
    const end   = (endDate   as string) || today

    const { rows: landlords } = await db.query(
      `SELECT l.id, l.business_name, u.first_name, u.last_name, u.email
       FROM landlords l JOIN users u ON u.id = l.user_id
       WHERE (l.id = $1::uuid OR $1 IS NULL)
       ORDER BY l.business_name, u.last_name`,
      [lid]
    )

    const statements = await Promise.all(landlords.map(async (landlord: any) => {
      const { rows: properties } = await db.query(
        `SELECT p.id, p.name,
                COUNT(u.id) AS unit_count,
                COUNT(u.id) FILTER (WHERE u.status='active') AS occupied,
                COALESCE(SUM(u.rent_amount) FILTER (WHERE u.status='active'), 0) AS expected_rent
         FROM properties p
         LEFT JOIN units u ON u.property_id = p.id
         WHERE p.landlord_id = $1
           AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
         GROUP BY p.id ORDER BY p.name`,
        [landlord.id, bkProps.propertyIds]
      )
      // S655: collected = the property's money received (the landlord
      // reports' own facts); deposits are held, not collected income, and are
      // listed apart. 10/12 (Nic): Received, Charged and Owed side by side —
      // both kinds of facts, read once.
      const both = await incomeBoth({ landlordIds: [landlord.id], start, end,
                                      propertyIds: bkProps.propertyIds, cutoffs: bkProps.cutoffs })
      const period = { start: String(start), end: String(end), label: `${start} to ${end}` }
      const of = (list: readonly IncomeEvent[], id: string) => list.filter(e => e.propertyId === id)
      for (const p of properties as any[]) {
        const t = summarize(of(both.received, p.id), basis)
        const v = moneyViewFrom(of(both.billed, p.id), of(both.received, p.id), period)
        p.collected = t.total
        p.received = v.received
        p.charged = v.charged
        p.owed = v.owed
        p.deposits_held = t.beside.depositsHeld
        p.lines = lineList(t.lines)
      }
      const { rows: disbRows } = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM disbursements
         WHERE landlord_id=$1 AND status='settled' AND target_date BETWEEN $2 AND $3`,
        [landlord.id, start, end]
      ).catch(() => ({ rows: [{ total: 0 }] }))

      const totalExpected  = properties.reduce((s: number, p: any) => s + +p.expected_rent, 0)
      const totalCollected = properties.reduce((s: number, p: any) => s + +p.collected, 0)
      const totalCharged = Math.round(properties.reduce((s: number, p: any) => s + +p.charged, 0) * 100) / 100
      const totalOwed = Math.round(properties.reduce((s: number, p: any) => s + +p.owed, 0) * 100) / 100
      const totalDepositsHeld = properties.reduce((s: number, p: any) => s + +p.deposits_held, 0)
      const totalDisbursed = +disbRows[0]?.total || 0

      return { landlord, properties, totalExpected, totalCollected, totalReceived: totalCollected, totalCharged, totalOwed,
               totalDepositsHeld, totalDisbursed, variance: totalCollected - totalExpected }
    }))

    res.json({ success: true, data: statements, meta: { basis: basisMeta(basis) } })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════
// TAX SUMMARY
// ════════════════════════════════════════

booksRouter.get('/tax/summary', requireBooksRead, blockBusinessOwner, async (req, res, next) => {
  try {
    // 10/12 (Nic, review): a company document (S655) — a team member assigned
    // to some properties is refused it in plain words; a bookkeeper opens it
    // with the company-wide box or the whole-company ledger box (BK1).
    await refuseScopedStaff(req.user, 'tax summary', { ledger: true })
    const lid  = landlordScope(req.user)
    // S654: "this year" by the Phoenix calendar, not the server clock's zone.
    const year = req.query.year || Number(todayIn(null).slice(0, 4))
    if (!/^\d{4}$/.test(String(year))) throw new AppError(400, 'Choose a tax year.')
    const start = `${year}-01-01`
    const end   = `${year}-12-31`

    const [payrollRows, contractors, employees] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(total_gross),0) AS ytd_gross,
                COALESCE(SUM(total_federal_tax),0) AS ytd_federal,
                COALESCE(SUM(total_state_tax),0) AS ytd_state,
                COALESCE(SUM(total_ss),0) AS ytd_ss,
                COALESCE(SUM(total_medicare),0) AS ytd_medicare,
                COALESCE(SUM(total_net),0) AS ytd_net,
                COALESCE(SUM(total_employer_ss),0) AS employer_ss,
                COALESCE(SUM(total_employer_medicare),0) AS employer_medicare,
                COALESCE(SUM(total_futa),0) AS futa,
                COALESCE(SUM(total_suta),0) AS suta,
                COUNT(*) AS run_count
         FROM payroll_runs
         WHERE (landlord_id=$1 OR $1 IS NULL) AND status='approved'
           AND pay_date BETWEEN $2 AND $3`,
        [lid, start, end]
      ),
      // 10/12 (Nic): "contractors get a 1099 box and their payments add up per
      // calendar year" — every vendor with the 1099 box paid in the tax year,
      // from the payments on its expenses (card payments left out: the card
      // company reports them), with that year's 1099-NEC threshold. It read
      // books_contractors.ytd_paid, a running number nothing added to, against
      // a fixed $600 (services/booksVendorsLoans vendor1099List).
      lid
        ? vendor1099List(db, { col: 'landlord_id', id: lid }, +year).then(r => ({ rows: r.vendors, threshold: r.threshold }))
        : Promise.resolve({ rows: [] as unknown[], threshold: null as number | null }),
      // 10/11: the W-2 table is the chosen tax year's pay — the approved runs
      // paid in that year, per employee. It read books_employees.ytd_*, a
      // running total since the employee was added, so every year's pay showed
      // under whichever year was picked.
      db.query(
        `SELECT e.first_name, e.last_name,
                SUM(prl.gross_pay)    AS ytd_gross,
                SUM(prl.federal_tax)  AS ytd_federal_tax,
                SUM(prl.state_tax)    AS ytd_state_tax,
                SUM(prl.ss_tax)       AS ytd_ss,
                SUM(prl.medicare_tax) AS ytd_medicare,
                SUM(prl.net_pay)      AS ytd_net
           FROM payroll_run_lines prl
           JOIN payroll_runs pr ON pr.id = prl.run_id
           JOIN books_employees e ON e.id = prl.employee_id
          WHERE (pr.landlord_id=$1 OR $1 IS NULL) AND pr.status='approved'
            AND pr.pay_date BETWEEN $2 AND $3
          GROUP BY e.id, e.first_name, e.last_name
         HAVING SUM(prl.gross_pay) > 0
          ORDER BY e.last_name, e.first_name`,
        [lid, start, end]
      ),
    ])

    const p = payrollRows.rows[0]
    // 10/12 (Nic, ledger P7): the employer's own taxes are recorded on each
    // paycheck now (migration 20261014200100) and read from the runs —
    // Social Security matching the employee's, Medicare at 1.45% of gross
    // (10/11: never a copy of what was withheld, which can include the
    // employee-only 0.9% Additional Medicare Tax), and the federal and state
    // unemployment tax entered when each run was calculated.
    const employerSS       = booksCents(p.employer_ss) / 100
    const employerMedicare = booksCents(p.employer_medicare) / 100
    const futa             = booksCents(p.futa) / 100
    const suta             = booksCents(p.suta) / 100
    const totalTaxLiability = (booksCents(p.ytd_federal) + booksCents(p.ytd_state) + booksCents(p.ytd_ss) + booksCents(p.ytd_medicare)
      + booksCents(p.employer_ss) + booksCents(p.employer_medicare) + booksCents(p.futa) + booksCents(p.suta)) / 100

    // S203: per-state tax form catalog (federal + state forms keyed
    // to property states + employee/contractor presence). Replaces
    // the S91 federal-only hardcoded list. Catalog is annual-refresh
    // hardcoded per CLAUDE.md S177 carve-out — see
    // services/taxForms.ts and migrations/*_state_tax_forms.sql.
    const { getApplicableTaxForms } = await import('../services/taxForms')
    // An admin (lid null, every landlord) gets the forms every landlord files, as before.
    const filingDeadlines = await getApplicableTaxForms(lid as string, +year)

    // 10/12 (Nic, ledger P8): on the ledger, the year's taxes as the books
    // hold them — sales, lodging and utility tax collected and paid, payroll
    // withholding and payroll taxes, what is still owed at the year's end —
    // and the year's income and expenses (Received and Charged, paid and
    // incurred). GAM shows them; it does not file them.
    let ledger: any = null
    if (lid && await ledgerReportsLive([lid])) {
      const throughDay = String(end) < todayIn(null) ? String(end) : todayIn(null)
      // 10/12 (Nic, review): the bookkeeper's own scope, the same as the
      // Books P&L and balance sheet — the taxes are whole-company ledger
      // balances (a sold property they never kept stays hidden, BK3); the
      // year's income and expenses are a company report (their properties
      // unless "Company reports show the whole company", BK2).
      const plScope = await companyReportPropertyScope(req.user)
      const [taxes, pl] = await Promise.all([
        wholeLedgerScope(req.user, lid).then(sc => ledgerTaxSummary(sc, start, throughDay)),
        ledgerProfitAndLoss({ landlordIds: [lid], propertyIds: plScope.propertyIds, cutoffs: plScope.cutoffs }, start, throughDay, String(year)),
      ])
      ledger = {
        taxes,
        income: { received: pl.view.received, charged: pl.view.charged },
        expenses: { paid: pl.expenses.paid, incurred: pl.expenses.incurred },
        nets: pl.nets,
      }
    }

    res.json({
      success: true,
      data: {
        year,
        payroll: { ...p, employer_ss: employerSS, employer_medicare: employerMedicare, futa, suta, total_tax_liability: totalTaxLiability.toFixed(2) },
        contractors1099: contractors.rows,
        contractors1099Threshold: contractors.threshold,
        employees: employees.rows,
        filingDeadlines,
        ledger,
      }
    })
  } catch (e) { next(e) }
})

// Rent roll — sync from GAM
booksRouter.get('/rent-roll', requireBooksRead, blockBusinessOwner, async (req, res, next) => {
  try {
    // 10/11 (Nic): tenant NAMES are allowed wherever bookkeeping needs them,
    // and the rent roll is open to a bookkeeper again (it was refused as
    // naming every tenant). Contact and account details stay out: a
    // bookkeeper's rows carry no tenant email or phone, and not whether the
    // tenant's bank is verified or they are enrolled in On-Time Pay (see
    // BOOKKEEPER_LEFT_OUT below — Books responses are not run through the
    // person scrub, so the route leaves them out itself). Their properties
    // narrow it as before (getScopedPropertyIds).
    const isBookkeeper = req.user?.role === 'bookkeeper'
    const lid = landlordScope(req.user)
    // S655 (gam-audience-data-isolation): a team member assigned to some
    // properties sees those properties' units, tenants and money only (null =
    // every property; an empty list sees nothing).
    const scopedIds = await getScopedPropertyIds(req.user)
    // 10/12 (Nic): lease start and end dates are the owner's choice per
    // bookkeeper (the "Show lease start and end dates" box) — the dates only,
    // never the lease's text or documents. Everyone else sees them.
    const showLeaseDates = !isBookkeeper || (await bookkeeperRequestScopeOf(req.user!)).showLeaseDates
    const cutoffs = await propertyCutoffsOf(req.user)

    // S387 fix: pre-fix had an extra `AND ($2::boolean OR l.user_id =
    // $3::uuid)` clause that filtered by the caller's user_id. Admin
    // bypassed via $2, landlords coincidentally worked (their user_id
    // matches), but bookkeepers got an empty rent roll because their
    // user_id doesn't match any landlord. The lid scope (set by
    // landlordScope → enforced by the X-Client-Id middleware for
    // bookkeepers) already provides the right tenant-trust boundary;
    // the extra user_id filter was redundant and buggy.
    const { rows } = await db.query(
      `SELECT
          u.unit_number, u.rent_amount, u.status, u.on_time_pay_active,
          p.name AS property_name,
          vuo.primary_first_name AS tenant_first, vuo.primary_last_name AS tenant_last,
          vuo.primary_email AS tenant_email,
          ten.ach_verified, ten.on_time_pay_enrolled,
          u.id AS unit_id,
          to_char(al.start_date, 'YYYY-MM-DD') AS lease_start_date,
          to_char(al.end_date, 'YYYY-MM-DD') AS lease_end_date,
          (SELECT COUNT(*) FROM payments
           WHERE unit_id=u.id AND status='pending') AS pending_count
        FROM units u
        JOIN properties p ON p.id = u.property_id
        JOIN landlords l ON l.id = u.landlord_id
        LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
        LEFT JOIN leases al ON al.id = vuo.active_lease_id
        LEFT JOIN tenants ten ON ten.id = vuo.primary_tenant_id
        WHERE ($1::uuid IS NULL OR l.id = $1::uuid)
          AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
        ORDER BY p.name, u.unit_number`,
      [lid, scopedIds]
    )

    // S604: an owner_use unit is occupied but collects no rent, so it belongs
    // in the occupancy rate and NOT in expected rent — including it would show
    // a permanent phantom variance the landlord can never collect.
    // S616: a UTILITY_SERVICE space is not a rental and never earns rent — it
    // is a neighbor's building this landlord happens to supply power or trash
    // to. Left in, it sat in the rent roll as a $0 unit and counted toward
    // occupancy, which is the same shape as the S604 owner_use fix: occupied,
    // but not by anyone paying this landlord rent.
    const earnsRent = (r: any) =>
      r.status !== 'vacant' && r.status !== 'owner_use' && r.status !== 'utility_service'
    // S655: THIS month's bills only — a month paid ahead is not this month's
    // rent. 10/12 (Nic): no switch — side by side, from the landlord reports'
    // own facts: Received = what arrived this month toward bills due this
    // month or earlier; Charged = this month's bills; Owed = what is still
    // unpaid of them.
    const today = todayIn(null)
    const monthFirst = monthStartOf(today)
    const [yy, mm] = monthFirst.split('-').map(Number)
    const monthLast = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10)
    const both = await incomeBoth({
      landlordIds: lid ? [lid] : null, start: monthFirst, end: monthLast, propertyIds: scopedIds, cutoffs,
    })
    const add = (m: Map<string, number>, k: string, n: number) => m.set(k, Math.round(((m.get(k) ?? 0) + n) * 100) / 100)
    const receivedBy = new Map<string, number>(), chargedBy = new Map<string, number>(), owedBy = new Map<string, number>()
    for (const e of both.received) {
      if (!e.inTotal || !e.paymentId || !e.unitId || !e.dueDate) continue
      if (e.dueDate > monthLast) continue
      add(receivedBy, e.unitId, e.amount)
    }
    // 10/12 (Nic, ledger P8): on the books, Owed is what each space still
    // owed at the month's end (the 'owed' facts), every bill included.
    const owedDay = ledgerOwedDay(both.billed)
    for (const e of both.billed) {
      if (e.ledger === 'owed') {
        if (e.day === owedDay && e.unitId) add(owedBy, e.unitId, e.amount)
        continue
      }
      if (!e.inTotal || !e.paymentId || !e.unitId || !e.dueDate) continue
      if (e.dueDate < monthFirst || e.dueDate > monthLast) continue
      add(chargedBy, e.unitId, e.amount)
      if (e.part === 'stillOwed') add(owedBy, e.unitId, e.amount)
    }
    for (const r of rows as any[]) {
      r.collected_mtd = receivedBy.get(r.unit_id) ?? 0
      r.charged_mtd = chargedBy.get(r.unit_id) ?? 0
      r.owed_mtd = owedBy.get(r.unit_id) ?? 0
    }
    const totalExpected = rows.reduce((s: number, r: any) => s + (earnsRent(r) ? +r.rent_amount : 0), 0)
    const sumOf = (k: string) => Math.round(rows.reduce((s: number, r: any) => s + (+r[k] || 0), 0) * 100) / 100
    const totalCollected = sumOf('collected_mtd')

    res.json({
      success: true,
      data: {
        units: isBookkeeper ? rows.map(r => withoutBookkeeperLeftOut(r, showLeaseDates)) : rows,
        // 10/12: whether the rows carry lease start and end dates.
        showLeaseDates,
        totalExpected,
        totalCollected,
        // 10/12 (Nic): the three columns side by side (Received is totalCollected).
        totalReceived: totalCollected,
        totalCharged: sumOf('charged_mtd'),
        totalOwed: sumOf('owed_mtd'),
        variance: totalCollected - totalExpected,
        occupancyRate: rows.length > 0 ? rows.filter((r: any) => r.status !== 'vacant').length / rows.length : 0,
        period: { start: monthFirst, end: monthLast },
        meta: { basis: basisMeta(BOOKS_BASIS) },
      }
    })
  } catch (e) { next(e) }
})

/**
 * 10/11 (Nic): what a bookkeeper's rent roll leaves out — the tenant's contact
 * details and their payment-account details. Names, units, rent and money
 * collected stay. Matched on the key with underscores removed and any case,
 * so a column renamed tenantEmail or TENANT_PHONE is still left out.
 */
const BOOKKEEPER_LEFT_OUT = new Set([
  'tenantemail', 'tenantphone', 'email', 'phone', 'phonenumber', 'primaryemail', 'primaryphone',
  'achverified', 'ontimepayenrolled', 'ontimepayactive', 'tenantuserid', 'userid',
])
/** 10/12 (Nic): the lease dates, left out unless the owner ticked "Show lease start and end dates". */
const BOOKKEEPER_LEASE_DATES = new Set(['leasestartdate', 'leaseenddate'])
function withoutBookkeeperLeftOut(row: Record<string, any>, showLeaseDates: boolean): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(row)) {
    const key = k.replace(/_/g, '').toLowerCase()
    if (BOOKKEEPER_LEFT_OUT.has(key)) continue
    if (!showLeaseDates && BOOKKEEPER_LEASE_DATES.has(key)) continue
    out[k] = v
  }
  return out
}
