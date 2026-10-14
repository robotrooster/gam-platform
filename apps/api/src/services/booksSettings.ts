/**
 * 10/12 (Nic) — GAM BOOKS: THE COMPANY'S BOOKS SETTINGS AND ITS OPENING BALANCES
 *
 * GAM Books is becoming an automatic double-entry ledger
 * (gam-ledger-design-2026-10-12). A handful of choices about how a company's
 * books count money are the OWNER's (Nic, 10/12: "landlord's choice"), and so
 * is what the books start with. This is the one place both are read and saved;
 * routes/booksSettings.ts is its door and the Books "Books Settings" and
 * "Opening Balances" pages (apps/{books,landlord}/src/bookkeeping) its screens.
 *
 * THE SETTINGS (landlords columns; values in packages/shared booksLedger.ts)
 *   books start        books_start_date (the bank feed's cutoff too — saved
 *                      through bankFeed.setBooksStartDate so its review queue
 *                      moves with it) and books_history_start: 'since_joining'
 *                      (the first day of the month the company joined GAM) or
 *                      'start_date' (a date the owner picks; what came before
 *                      opens as opening balances). Nobody but the owner picks
 *                      it — GAM never does (L16, "TruBlu picks its own start
 *                      date, no default set by GAM").
 *   close / reopen     books_close_by, books_reopen_by (L3)
 *   open-month fixes   books_open_month_fixes (L4)
 *   home sales         books_home_sale_method (L11)
 *   work trade         books_work_trade_method (L12)
 *   register stock     books_register_stock + books_register_stock_from (L8;
 *                      the register lane's columns, migration 20261014150000):
 *                      a change applies from the day it is made, so sales
 *                      already booked keep their treatment — from the books'
 *                      start while nothing has posted yet. Every change is
 *                      kept (books_register_stock_changes, 20261014170100):
 *                      the ledger reads the choice in force on a sale's day
 *   (company costs     books_company_costs_method (L7) — RETIRED 10/13 (Nic):
 *                      "each expense is chosen on the split or specific unit or
 *                      property at the time of logging. there should never be a
 *                      default setting to apply expenses." The column stays on
 *                      the table; nothing here reads or writes it. Where a cost
 *                      goes is picked on each record — cost_place,
 *                      services/ledgerProjectors/companyCosts.)
 *   write-offs         books_write_off_by (L15)
 *   repair bills       books_repair_bills (L6, money out — services/repairBills):
 *                      a repair closed with a cost makes an unpaid bill by
 *                      itself, or only on "Record as bill" (NULL: not chosen,
 *                      which reads as the button). Changeable any time: it
 *                      decides what is made from now on, never what posted.
 * Home sales and work trade start NOT CHOSEN (NULL): a record whose posting
 * depends on one waits until the owner chooses. Once the company's books have
 * posted, a chosen one no longer changes — a rebuild reads today's choice, so
 * changing it would rewrite what already posted. Choosing one that was never
 * chosen is always allowed (nothing posted under it).
 * (Register stock has a starting choice and a from-date instead — above.)
 *
 * THE OPENING BALANCES (books_opening_items; design J1, §15 step 5)
 *   bank          a linked bank account's balance on the start date (one live
 *                 balance per account: entering it again replaces the old one,
 *                 which is voided with the reason, never removed)
 *   deposit_held  a deposit a tenant paid the landlord before GAM that the
 *                 landlord still holds — tenant, amount, the day it was paid —
 *                 only if the owner chooses to enter them (L14)
 *   other         anything else the books start with (cash on hand, an account
 *                 GAM does not see, a loan, equipment), on an account the owner
 *                 picks, in that account's normal sense
 * Home-sale balances still owed are not typed in: they are worked out from the
 * contracts (financed − the principal of every installment billed before the
 * start, on or off GAM) and shown, prefilled, for the owner to check (J1 b).
 * Every change marks the company's opening posting for the engine (the
 * 'opening' source: the capture trigger on books_opening_items, migration
 * 20261013200600 / 20261014001100), and the after-commit kick posts it as soon
 * as the opening projector is registered (services/ledgerProjectors).
 *
 * WHO. The owner (the founding user or a co-owner — landlord_members) changes
 * everything here. A bookkeeper reads it with "May use the whole-company
 * ledger" or the company-wide box; bank balances are the company-wide box's
 * (the bank account is). Nobody else.
 */
import type { PoolClient } from 'pg'
import {
  BOOKS_HISTORY_STARTS, BOOKS_HOME_SALE_METHODS, BOOKS_WORK_TRADE_METHODS, LEDGER_REGISTER_STOCK_METHODS,
  DEFAULT_LEDGER_REGISTER_STOCK_METHOD, LEDGER_WRITE_OFF_PERMISSIONS,
  LEDGER_CLOSE_PERMISSIONS, LEDGER_OPEN_MONTH_FIX_MODES, BOOKS_REPAIR_BILL_MODES, type BooksRepairBillMode,
  LEDGER_CONTROL_ROLES, LEDGER_OPENING_ITEM_KINDS_ENTERED, booksCents, ledgerCentsToNumeric,
  type BooksHistoryStart, type BooksHomeSaleMethod, type BooksWorkTradeMethod, type LedgerRegisterStockMethod,
  type LedgerWriteOffPermission, type LedgerClosePermission,
  type LedgerOpenMonthFixMode, type LedgerOpeningItemKind, type LedgerOpeningItemKindEntered,
} from '@gam/shared'
import { db } from '../db'
import { ledgerQuery } from '../db/ledgerPool'
import { AppError } from '../middleware/errorHandler'
import { loadOwnerContext, addDaysIso, ISO_DAY } from './ledgerOwner'
import { ensureChart } from './booksLedgerChart'
import { currentLedgerXid, kickLedgerAfterCommit } from './ledgerEngine'

// ─── Who is looking ──────────────────────────────────────────────────────────

export interface BooksViewer {
  landlordId: string
  userId: string
  /** owner: changes everything here; bookkeeper and admin: read only. */
  kind: 'owner' | 'bookkeeper' | 'admin'
  canEdit: boolean
  /** The company's bank accounts and their opening balances (the company-wide box, for a bookkeeper). */
  seesBank: boolean
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }

/** Is this user an owner of the company: its founding user, or a co-owner (landlord_members)? */
export async function isCompanyOwnerUser(c: Queryable, userId: string, landlordId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT EXISTS (SELECT 1 FROM landlords WHERE id = $2 AND user_id = $1)
         OR EXISTS (SELECT 1 FROM landlord_members WHERE landlord_id = $2 AND user_id = $1) AS ok`,
    [userId, landlordId])
  return !!r.rows[0]?.ok
}

/** Runs `fn` in one transaction on the API's pool. */
async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
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

/** Runs `fn` on one connection of the API's pool (read only, one snapshot per statement). */
async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    return await fn(c)
  } finally {
    c.release()
  }
}

// ─── The choices, as the posting rules read them ─────────────────────────────

export interface BooksChoices {
  booksStartDate: string | null
  /** How the start date was picked; a date picked on the Bank page before this setting reads as 'start_date'. */
  historyStart: BooksHistoryStart | null
  homeSaleMethod: BooksHomeSaleMethod | null
  workTradeMethod: BooksWorkTradeMethod | null
  /** Register stock (the register lane's books_register_stock), and the first day it applies (null: from the books start). */
  registerStockMethod: LedgerRegisterStockMethod
  registerStockFrom: string | null
  writeOffBy: LedgerWriteOffPermission
}

const CHOICE_COLUMNS = `l.books_start_date::text AS books_start_date, l.books_history_start, l.books_home_sale_method,
  l.books_work_trade_method, l.books_register_stock, l.books_register_stock_from::text AS books_register_stock_from,
  l.books_write_off_by`

function choicesOf(row: any): BooksChoices {
  const start: string | null = row.books_start_date ?? null
  return {
    booksStartDate: start,
    historyStart: start ? (row.books_history_start ?? 'start_date') : null,
    homeSaleMethod: row.books_home_sale_method ?? null,
    workTradeMethod: row.books_work_trade_method ?? null,
    registerStockMethod: row.books_register_stock ?? DEFAULT_LEDGER_REGISTER_STOCK_METHOD,
    registerStockFrom: row.books_register_stock_from ?? null,
    writeOffBy: row.books_write_off_by ?? 'owner',
  }
}

/**
 * A company's books choices, on the caller's connection — for the posting
 * rules (a projector reads them inside its own transaction). NULL = the owner
 * has not chosen; a source whose posting depends on that choice waits.
 */
export async function loadBooksChoices(c: Queryable, landlordId: string): Promise<BooksChoices | null> {
  const r = await c.query(`SELECT ${CHOICE_COLUMNS} FROM landlords l WHERE l.id = $1`, [landlordId])
  return r.rows[0] ? choicesOf(r.rows[0]) : null
}

// ─── Reading the settings ────────────────────────────────────────────────────

export interface BooksSettingsView extends BooksChoices {
  companyName: string | null
  canEdit: boolean
  viewer: BooksViewer['kind']
  /** The day the company joined GAM, and the first day of that month (what "since joining GAM" starts on). */
  joinedOn: string
  joinMonthStart: string
  closeBy: LedgerClosePermission
  reopenBy: LedgerClosePermission
  openMonthFixes: LedgerOpenMonthFixMode
  /** 10/12 (Nic, L6): what a repair closed with a cost does (null: not chosen — the button). */
  repairBills: BooksRepairBillMode | null
  closedThrough: string | null
  /** The company's calendar day today. */
  today: string
  /** The books have posted: a chosen accounting method no longer changes. */
  hasPostings: boolean
  /** Live opening balances entered (so the settings page can point to them). */
  openingItems: number
}

async function readSettings(c: PoolClient, viewer: BooksViewer): Promise<BooksSettingsView> {
  const ctx = await loadOwnerContext(c, { landlordId: viewer.landlordId })
  if (!ctx.exists) throw new AppError(404, 'No such company.')
  const r = await c.query(
    `SELECT l.business_name, ${CHOICE_COLUMNS},
            l.books_close_by, l.books_reopen_by, l.books_open_month_fixes, l.books_repair_bills,
            (l.created_at AT TIME ZONE $2)::date::text AS joined_on,
            EXISTS (SELECT 1 FROM ledger_postings p WHERE p.landlord_id = l.id) AS has_postings,
            (SELECT count(*)::int FROM books_opening_items o WHERE o.landlord_id = l.id AND o.voided_at IS NULL) AS opening_items
       FROM landlords l WHERE l.id = $1`, [viewer.landlordId, ctx.timezone])
  const row = r.rows[0]
  const joinMonthStart = `${String(row.joined_on).slice(0, 7)}-01`
  const choices = choicesOf(row)
  // A start date moved on the Bank page after "since joining GAM" was chosen
  // is a date the owner picked.
  if (choices.historyStart === 'since_joining' && choices.booksStartDate !== joinMonthStart) choices.historyStart = 'start_date'
  return {
    ...choices,
    companyName: row.business_name ?? null,
    canEdit: viewer.canEdit,
    viewer: viewer.kind,
    joinedOn: row.joined_on,
    joinMonthStart,
    closeBy: row.books_close_by,
    reopenBy: row.books_reopen_by,
    openMonthFixes: row.books_open_month_fixes,
    repairBills: row.books_repair_bills ?? null,
    closedThrough: ctx.closedThrough,
    today: ctx.today,
    hasPostings: !!row.has_postings,
    openingItems: Number(row.opening_items) || 0,
  }
}

export async function getBooksSettings(viewer: BooksViewer): Promise<BooksSettingsView> {
  return withClient(c => readSettings(c, viewer))
}

// ─── Saving the settings ─────────────────────────────────────────────────────

export interface BooksSettingsPatch {
  historyStart?: BooksHistoryStart
  /** With historyStart 'start_date': the first day the books cover. */
  startDate?: string
  closeBy?: LedgerClosePermission
  reopenBy?: LedgerClosePermission
  openMonthFixes?: LedgerOpenMonthFixMode
  homeSaleMethod?: BooksHomeSaleMethod
  workTradeMethod?: BooksWorkTradeMethod
  registerStockMethod?: LedgerRegisterStockMethod
  writeOffBy?: LedgerWriteOffPermission
  repairBills?: BooksRepairBillMode
}

/** The accounting methods: chosen once, then fixed after the books post (see header). */
const METHODS = [
  { key: 'homeSaleMethod',      column: 'books_home_sale_method',      values: BOOKS_HOME_SALE_METHODS,      what: 'how home sales count' },
  { key: 'workTradeMethod',     column: 'books_work_trade_method',     values: BOOKS_WORK_TRADE_METHODS,     what: 'how work trade that covers rent counts' },
] as const

/** Choices anyone may change at any time (they say who may act, or how a fix made from now on is dated). */
const POLICIES = [
  { key: 'closeBy',        column: 'books_close_by',         values: LEDGER_CLOSE_PERMISSIONS,     what: 'who may close a month' },
  { key: 'reopenBy',       column: 'books_reopen_by',        values: LEDGER_CLOSE_PERMISSIONS,     what: 'who may reopen a month' },
  { key: 'openMonthFixes', column: 'books_open_month_fixes', values: LEDGER_OPEN_MONTH_FIX_MODES,  what: 'where fixes to an open month show' },
  { key: 'writeOffBy',     column: 'books_write_off_by',     values: LEDGER_WRITE_OFF_PERMISSIONS, what: 'who may write off a balance' },
  // 10/12 (Nic, L6): what a repair closed with a cost does from now on.
  { key: 'repairBills',    column: 'books_repair_bills',     values: BOOKS_REPAIR_BILL_MODES,      what: 'what a repair closed with a cost does' },
] as const

/** A real calendar day 'YYYY-MM-DD'. */
function isRealDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/**
 * The owner changes the company's books settings. Everything in one
 * transaction on the company row (two owners saving at once take turns). The
 * books start date goes through the bank feed's own save so its review queue
 * moves with it (lines before the date are set aside, lines a later date had
 * set aside come back). Every change is journaled (audit_landlords).
 */
export async function updateBooksSettings(args: {
  viewer: BooksViewer; patch: BooksSettingsPatch
}): Promise<BooksSettingsView> {
  const { viewer, patch } = args
  if (!viewer.canEdit) throw new AppError(403, 'Only the owner changes the books settings.')
  let xid: string | null = null
  let ledgerTouched = false
  const view = await inTransaction(async (c) => {
    await c.query(`SET LOCAL lock_timeout = '5s'`)
    if (!(await isCompanyOwnerUser(c, viewer.userId, viewer.landlordId))) {
      throw new AppError(403, 'Only the owner changes the books settings.')
    }
    const cur = (await c.query(
      `SELECT ${CHOICE_COLUMNS}, l.books_close_by, l.books_reopen_by, l.books_open_month_fixes, l.books_repair_bills
         FROM landlords l WHERE l.id = $1 FOR NO KEY UPDATE`, [viewer.landlordId])).rows[0]
    if (!cur) throw new AppError(404, 'No such company.')
    const ctx = await loadOwnerContext(c, { landlordId: viewer.landlordId })
    const hasPostings = !!(await c.query(
      `SELECT EXISTS (SELECT 1 FROM ledger_postings WHERE landlord_id = $1) AS p`, [viewer.landlordId])).rows[0]?.p

    const sets: string[] = []
    const params: unknown[] = [viewer.landlordId]
    const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`) }

    // The books start.
    if (patch.historyStart !== undefined) {
      if (!(BOOKS_HISTORY_STARTS as readonly string[]).includes(patch.historyStart)) {
        throw new AppError(400, 'Choose when your books start: since joining GAM, or a date you pick.')
      }
      let date: string
      if (patch.historyStart === 'since_joining') {
        const joined = (await c.query(
          `SELECT (created_at AT TIME ZONE $2)::date::text AS d FROM landlords WHERE id = $1`,
          [viewer.landlordId, ctx.timezone])).rows[0].d as string
        date = `${joined.slice(0, 7)}-01`
      } else {
        const d = String(patch.startDate ?? '').trim()
        if (!isRealDay(d)) throw new AppError(400, 'Enter the date your books start.')
        if (d < '1900-01-01') throw new AppError(400, 'Enter the date your books start.')
        if (d > addDaysIso(ctx.today, 366)) throw new AppError(400, 'Pick a start date within the next year.')
        date = d
      }
      if (date !== cur.books_start_date) {
        // Its own UPDATE of books_start_date marks the company's opening posting
        // and, when the date moves, every source the move crosses (the
        // ledger_capture_books_start trigger) — the engine re-sorts them.
        // (Loaded when needed, as routes/bankFeed does: the bank feed module is large.)
        const { setBooksStartDate } = await import('./bankFeed')
        // 10/13 review: the database refuses a start that would fall between a
        // fixed asset and the loan that paid for it (books_start_asset_loan_guard)
        // — said to the owner in its own words.
        await setBooksStartDate(viewer.landlordId, date, c).catch((e: any) => {
          if (e?.code === '23514') throw new AppError(409, String(e.message))
          throw e
        })
        ledgerTouched = true
      }
      if (patch.historyStart !== cur.books_history_start) set('books_history_start', patch.historyStart)
    } else if (patch.startDate !== undefined) {
      throw new AppError(400, 'Say how your books start along with the date.')
    }

    // The accounting methods.
    let methodChosen = false
    for (const m of METHODS) {
      const v = (patch as Record<string, unknown>)[m.key]
      if (v === undefined) continue
      if (!(m.values as readonly unknown[]).includes(v)) throw new AppError(400, `Choose ${m.what}.`)
      const was = cur[m.column] as string | null
      if (was === v) continue
      if (was !== null && hasPostings) {
        throw new AppError(409, `Your books have already posted under ${m.what}, so it cannot change now.`)
      }
      set(m.column, v)
      methodChosen = true
    }
    // Register stock (the register lane's books_register_stock): a change
    // applies from the day it is made, so sales already booked keep theirs —
    // from the books' start while nothing has posted (nothing was booked under
    // the old choice).
    if (patch.registerStockMethod !== undefined) {
      if (!(LEDGER_REGISTER_STOCK_METHODS as readonly string[]).includes(patch.registerStockMethod)) {
        throw new AppError(400, 'Choose how register stock counts.')
      }
      if (patch.registerStockMethod !== cur.books_register_stock) {
        set('books_register_stock', patch.registerStockMethod)
        set('books_register_stock_from', hasPostings ? ctx.today : null)
        // 10/12 (Nic, ledger review): every change is kept with the day it
        // applies from (books_register_stock_changes), and the ledger reads the
        // choice in force on each sale's own day — so a second or third change
        // never re-dates sales booked under an earlier one. The first change
        // also records what was in force until now.
        const kept = (await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM books_register_stock_changes WHERE landlord_id = $1`, [viewer.landlordId])).rows[0].n
        if (kept === 0 && hasPostings) {
          const was = cur.books_register_stock as LedgerRegisterStockMethod
          const wasFrom = cur.books_register_stock_from as string | null
          if (wasFrom) {
            const before = LEDGER_REGISTER_STOCK_METHODS.find(m => m !== was)!
            await c.query(`INSERT INTO books_register_stock_changes (landlord_id, method, effective_from) VALUES ($1, $2, NULL), ($1, $3, $4::date)`,
              [viewer.landlordId, before, was, wasFrom])
          } else {
            await c.query(`INSERT INTO books_register_stock_changes (landlord_id, method, effective_from) VALUES ($1, $2, NULL)`,
              [viewer.landlordId, was])
          }
        }
        await c.query(
          `INSERT INTO books_register_stock_changes (landlord_id, method, effective_from, changed_by) VALUES ($1, $2, $3::date, $4)`,
          [viewer.landlordId, patch.registerStockMethod, hasPostings ? ctx.today : null, viewer.userId])
        if (hasPostings) {
          // Today's sales (any of its properties' calendars) re-post under the
          // choice in force for them. Writers only ever insert into the outbox.
          await c.query(
            `INSERT INTO ledger_outbox (source_type, source_id, owner_id)
             SELECT 'pos_sale', t.id::text, t.landlord_id FROM pos_transactions t
              WHERE t.landlord_id = $1 AND t.created_at >= now() - interval '2 days'`, [viewer.landlordId])
        }
        methodChosen = true
      }
    }
    // Who may act, and how a fix made from now on is dated.
    for (const p of POLICIES) {
      const v = (patch as Record<string, unknown>)[p.key]
      if (v === undefined) continue
      if (!(p.values as readonly unknown[]).includes(v)) throw new AppError(400, `Choose ${p.what}.`)
      if (cur[p.column] !== v) set(p.column, v)
    }

    if (sets.length) {
      await c.query(`UPDATE landlords SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params)
    }
    if (methodChosen) {
      // The opening posting reads the home-sale method (a note owed, or
      // nothing on the balance sheet), and a record that waited on a method
      // posts once it is chosen. Writers only ever insert into the outbox.
      await c.query(`INSERT INTO ledger_outbox (source_type, source_id, owner_id) VALUES ('opening', $1::text, $1::uuid)`,
        [viewer.landlordId])
      ledgerTouched = true
    }
    if (ledgerTouched) xid = await currentLedgerXid(c)
    return readSettings(c, viewer)
  })
  if (ledgerTouched) await afterLedgerChange(viewer.landlordId, xid)
  return view
}

/**
 * After a change the books read has committed: what was waiting on it is tried
 * again at the next pass, not after its back-off (a source that waited on a
 * choice or a start date), and this transaction's marks are posted now. Never
 * throws — a books problem never undoes a saved setting.
 */
async function afterLedgerChange(landlordId: string, xid: string | null): Promise<void> {
  try {
    // On the books' own pool (db/ledgerPool): a poster holding the row for an
    // instant never makes an API connection wait.
    await ledgerQuery(`UPDATE ledger_source_errors SET next_try_at = now() WHERE owner_id = $1 AND next_try_at > now()`, [landlordId])
  } catch { /* the back-off runs out on its own */ }
  if (xid) void kickLedgerAfterCommit(xid)
}

// ─── Opening balances ────────────────────────────────────────────────────────

/** Posting roles an "other" opening balance never opens on (see the migration 20261014001100 header). */
const NOT_FOR_OTHER_ITEMS: readonly string[] = [
  ...LEDGER_CONTROL_ROLES, 'opening_balance_equity', 'retained_earnings', 'interproperty_clearing',
]

export interface OpeningItemView {
  id: string
  kind: LedgerOpeningItemKind
  amount: string
  asOf: string
  paidOn: string | null
  memo: string | null
  enteredAt: string
  voidedAt: string | null
  voidReason: string | null
  /** Entered for a different start date than the books have now: check it and enter it again. */
  stale: boolean
  bankConnectionId: string | null
  bankName: string | null
  leaseId: string | null
  tenantId: string | null
  tenantName: string | null
  propertyId: string | null
  propertyName: string | null
  unitLabel: string | null
  accountId: string | null
  accountCode: string | null
  accountName: string | null
  accountType: string | null
}

export interface OpeningBankAccount {
  id: string
  name: string
  status: string
  /** current balance − the feed's posted lines since the start date, when the feed reaches back that far. */
  suggested: string | null
  balanceAsOf: string | null
  feedFrom: string | null
}

export interface OpeningHomeSale {
  contractId: string
  buyerName: string
  propertyName: string | null
  unitLabel: string | null
  status: string
  financed: string
  principalBeforeStart: string
  /** What the note still owes on the start date: financed − principal billed before it. */
  stillOwed: string
  /** Installments billed before the start and not yet paid (they open as what the tenant owes). */
  billedUnpaid: string
}

export interface OpeningLeaseOption {
  leaseId: string
  tenantName: string | null
  propertyName: string
  unitLabel: string
  startDate: string
  endDate: string | null
  /** A deposit GAM already has a record of on this lease (only money GAM has no record of belongs here). */
  gamDeposit: string | null
}

export interface OpeningAccountOption { id: string; code: string; name: string; type: string }

export interface OpeningBalancesView {
  canEdit: boolean
  seesBank: boolean
  booksStartDate: string | null
  closedThrough: string | null
  homeSaleMethod: BooksHomeSaleMethod | null
  /** The company's chart is set up for the automatic postings (an "other" balance needs it). */
  chartReady: boolean
  items: OpeningItemView[]
  /** null when the viewer does not see the bank account (a bookkeeper without the company-wide box). */
  bankAccounts: OpeningBankAccount[] | null
  homeSales: OpeningHomeSale[]
  /** For the owner's forms only. */
  leases: OpeningLeaseOption[]
  accounts: OpeningAccountOption[]
}

const money = (v: unknown) => ledgerCentsToNumeric(booksCents(v as string))

/** "Name Surname", or null. */
const personName = (first: unknown, last: unknown) => {
  const n = `${first ?? ''} ${last ?? ''}`.trim()
  return n || null
}

async function eligibleAccounts(c: Queryable, landlordId: string): Promise<OpeningAccountOption[]> {
  const r = await c.query(
    `SELECT a.id, a.code, a.name, a.type FROM books_accounts a
      WHERE a.landlord_id = $1 AND a.active IS NOT FALSE AND a.type IN ('asset', 'liability', 'equity')
        AND a.bank_connection_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM books_account_map m
                         WHERE m.landlord_id = $1 AND m.account_id = a.id
                           AND (m.map_kind <> 'role' OR m.map_value = ANY($2::text[])))
      ORDER BY a.code, a.name`, [landlordId, NOT_FOR_OTHER_ITEMS])
  return r.rows.map(x => ({ id: x.id, code: x.code, name: x.name, type: x.type }))
}

async function chartIsReady(c: Queryable, landlordId: string): Promise<boolean> {
  const r = await c.query(`SELECT EXISTS (SELECT 1 FROM books_account_map WHERE landlord_id = $1 AND map_kind = 'role') AS ok`, [landlordId])
  return !!r.rows[0]?.ok
}

export async function getOpeningBalances(viewer: BooksViewer): Promise<OpeningBalancesView> {
  return withClient(async (c) => {
    const ctx = await loadOwnerContext(c, { landlordId: viewer.landlordId })
    if (!ctx.exists) throw new AppError(404, 'No such company.')
    const choices = (await loadBooksChoices(c, viewer.landlordId))!
    const start = choices.booksStartDate
    const lid = viewer.landlordId

    const items = (await c.query(
      `SELECT o.id, o.kind, o.amount::text AS amount, o.as_of::text AS as_of, o.paid_on::text AS paid_on, o.memo,
              o.entered_at::text AS entered_at, o.voided_at::text AS voided_at, o.void_reason,
              o.bank_connection_id, COALESCE(NULLIF(bc.display_name, ''), bc.institution_name, 'Bank account')
                || CASE WHEN bc.account_last4 IS NOT NULL THEN ' ••' || bc.account_last4 ELSE '' END AS bank_name,
              o.lease_id, o.tenant_id, u.first_name, u.last_name,
              o.property_id, p.name AS property_name, COALESCE(NULLIF(un.display_label, ''), un.unit_number) AS unit_label,
              o.account_id, a.code AS account_code, a.name AS account_name, a.type AS account_type
         FROM books_opening_items o
         LEFT JOIN bank_connections bc ON bc.id = o.bank_connection_id
         LEFT JOIN tenants t ON t.id = o.tenant_id
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN properties p ON p.id = o.property_id
         LEFT JOIN leases l ON l.id = o.lease_id
         LEFT JOIN units un ON un.id = l.unit_id
         LEFT JOIN books_accounts a ON a.id = o.account_id
        WHERE o.landlord_id = $1 AND ($2::boolean OR o.kind <> 'bank')
        ORDER BY o.voided_at IS NOT NULL, o.kind, o.entered_at`, [lid, viewer.seesBank])).rows.map((x): OpeningItemView => ({
      id: x.id, kind: x.kind, amount: x.amount, asOf: x.as_of, paidOn: x.paid_on, memo: x.memo,
      enteredAt: x.entered_at, voidedAt: x.voided_at, voidReason: x.void_reason,
      stale: !x.voided_at && !!start && (x.as_of !== start || (x.kind === 'deposit_held' && !!x.paid_on && x.paid_on > start)),
      bankConnectionId: x.bank_connection_id, bankName: x.bank_connection_id ? x.bank_name : null,
      leaseId: x.lease_id, tenantId: x.tenant_id, tenantName: personName(x.first_name, x.last_name),
      propertyId: x.property_id, propertyName: x.property_name, unitLabel: x.unit_label,
      accountId: x.account_id, accountCode: x.account_code, accountName: x.account_name, accountType: x.account_type,
    }))

    let bankAccounts: OpeningBankAccount[] | null = null
    if (viewer.seesBank) {
      bankAccounts = (await c.query(
        `SELECT bc.id, COALESCE(NULLIF(bc.display_name, ''), bc.institution_name, 'Bank account')
                  || CASE WHEN bc.account_last4 IS NOT NULL THEN ' ••' || bc.account_last4 ELSE '' END AS name,
                bc.status, bc.current_balance::text AS current_balance, bc.balance_as_of::text AS balance_as_of,
                (SELECT min(t.posted_date)::text FROM bank_transactions t WHERE t.bank_connection_id = bc.id) AS feed_from,
                (SELECT COALESCE(sum(t.amount), 0)::text FROM bank_transactions t
                  WHERE t.bank_connection_id = bc.id AND $2::date IS NOT NULL AND t.posted_date >= $2::date
                    AND (bc.balance_as_of IS NULL OR t.posted_date <= (bc.balance_as_of AT TIME ZONE $3)::date)
                    AND COALESCE(t.bank_status, 'posted') = 'posted'
                    AND COALESCE(t.ignored_reason, '') NOT IN ('duplicate', 'bank_void')) AS since_start
           FROM bank_connections bc WHERE bc.landlord_id = $1
          ORDER BY bc.status = 'active' DESC, bc.created_at`, [lid, start, ctx.timezone])).rows.map((x): OpeningBankAccount => ({
        id: x.id, name: x.name, status: x.status, balanceAsOf: x.balance_as_of, feedFrom: x.feed_from,
        // A suggestion only when the feed reaches back to the start date and the bank told us a balance.
        suggested: start && x.current_balance != null && x.feed_from && x.feed_from <= start
          ? ledgerCentsToNumeric(booksCents(x.current_balance) - booksCents(x.since_start))
          : null,
      }))
    }

    let homeSales: OpeningHomeSale[] = []
    if (start) {
      homeSales = (await c.query(
        `SELECT c.id, c.status, c.financed_amount::text AS financed, u.first_name, u.last_name,
                p.name AS property_name, COALESCE(NULLIF(un.display_label, ''), un.unit_number) AS unit_label,
                COALESCE((SELECT sum(i.principal_portion) FROM home_sale_installments i
                           WHERE i.contract_id = c.id AND i.billing_month < $2::date), 0)::text AS principal_before,
                COALESCE((SELECT sum(i.amount) FROM home_sale_installments i JOIN payments pm ON pm.id = i.payment_id
                           WHERE i.contract_id = c.id AND i.billing_month < $2::date AND i.settled_off_platform_at IS NULL
                             AND pm.status IN ('pending', 'processing', 'failed')), 0)::text AS billed_unpaid
           FROM home_sale_contracts c
           JOIN tenants t ON t.id = c.tenant_id
           JOIN users u ON u.id = t.user_id
           JOIN units un ON un.id = c.unit_id
           JOIN properties p ON p.id = un.property_id
          WHERE c.landlord_id = $1
            -- a sale that went active (signed): pending signatures never post
            AND (c.status IN ('active', 'paid_off') OR (c.status = 'cancelled' AND c.activated_at IS NOT NULL))
            -- cancelled before the books start: nothing is owed on that day
            AND NOT (c.status = 'cancelled' AND (c.cancelled_at AT TIME ZONE $3)::date < $2::date)
            -- before the books start: it opens as a note still owed (design J1 b)
            AND (c.start_month < $2::date OR (c.activated_at IS NOT NULL AND (c.activated_at AT TIME ZONE $3)::date < $2::date))
          ORDER BY p.name, unit_label, c.start_month`, [lid, start, ctx.timezone])).rows
        .map((x): OpeningHomeSale => {
          const owed = Math.max(0, booksCents(x.financed) - booksCents(x.principal_before))
          return {
            contractId: x.id, buyerName: personName(x.first_name, x.last_name) ?? 'Buyer',
            propertyName: x.property_name, unitLabel: x.unit_label, status: x.status,
            financed: money(x.financed), principalBeforeStart: money(x.principal_before),
            stillOwed: ledgerCentsToNumeric(owed), billedUnpaid: money(x.billed_unpaid),
          }
        })
        .filter(h => booksCents(h.stillOwed) > 0 || booksCents(h.billedUnpaid) > 0)
    }

    let leases: OpeningLeaseOption[] = []
    let accounts: OpeningAccountOption[] = []
    const chartReady = await chartIsReady(c, lid)
    if (viewer.canEdit) {
      leases = (await c.query(
        `SELECT l.id, l.start_date::text AS start_date, l.end_date::text AS end_date,
                p.name AS property_name, COALESCE(NULLIF(un.display_label, ''), un.unit_number) AS unit_label,
                u.first_name, u.last_name,
                -- 10/12 (Nic): a deposit record voided before anything was
                -- collected (lib/unwindIssuedLease) is not a deposit GAM holds.
                (SELECT sum(sd.total_amount)::text FROM security_deposits sd
                  WHERE sd.lease_id = l.id AND sd.status <> 'voided') AS gam_deposit
           FROM leases l
           JOIN units un ON un.id = l.unit_id
           JOIN properties p ON p.id = un.property_id
           LEFT JOIN LATERAL (SELECT lt.tenant_id FROM lease_tenants lt
                               WHERE lt.lease_id = l.id AND lt.role = 'primary'
                               ORDER BY (lt.status = 'active') DESC, lt.created_at LIMIT 1) pt ON TRUE
           LEFT JOIN tenants t ON t.id = pt.tenant_id
           LEFT JOIN users u ON u.id = t.user_id
          WHERE l.landlord_id = $1
            -- living there on the start date or since (an onboarding lease often starts after it)
            AND ($2::date IS NULL OR l.end_date IS NULL OR l.end_date >= $2::date)
          ORDER BY p.name, unit_label, l.start_date DESC`, [lid, start])).rows.map((x): OpeningLeaseOption => ({
        leaseId: x.id, tenantName: personName(x.first_name, x.last_name), propertyName: x.property_name,
        unitLabel: x.unit_label, startDate: x.start_date, endDate: x.end_date,
        gamDeposit: x.gam_deposit != null && booksCents(x.gam_deposit) > 0 ? money(x.gam_deposit) : null,
      }))
      if (chartReady) accounts = await eligibleAccounts(c, lid)
    }
    return {
      canEdit: viewer.canEdit, seesBank: viewer.seesBank, booksStartDate: start, closedThrough: ctx.closedThrough,
      homeSaleMethod: choices.homeSaleMethod, chartReady, items, bankAccounts, homeSales, leases, accounts,
    }
  })
}

export interface OpeningItemInput {
  kind: string
  amount: number | string
  bankConnectionId?: string
  leaseId?: string
  accountId?: string
  paidOn?: string
  memo?: string
}

/** An amount as whole cents, refused when it is not a dollar amount a numeric(12,2) holds. */
function amountCents(v: unknown): number {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').replace(/[$,\s]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new AppError(400, 'Enter the amount in dollars and cents.')
  const cents = booksCents(s)
  if (Math.abs(cents) >= 1_000_000_000_000) throw new AppError(400, 'That amount is too large.')
  return cents
}

/**
 * The owner enters one opening balance. Dated the books start date (as_of);
 * the books must have one first. A bank account has one live balance: a new
 * one replaces the old, which is voided with the reason.
 */
export async function addOpeningItem(args: { viewer: BooksViewer; input: OpeningItemInput }): Promise<OpeningItemView['id']> {
  const { viewer, input } = args
  if (!viewer.canEdit) throw new AppError(403, 'Only the owner enters opening balances.')
  if (!(LEDGER_OPENING_ITEM_KINDS_ENTERED as readonly string[]).includes(input.kind)) {
    throw new AppError(400, 'Choose a bank balance, a deposit you hold, or another opening balance.')
  }
  const kind = input.kind as LedgerOpeningItemKindEntered
  const cents = amountCents(input.amount)
  const memo = typeof input.memo === 'string' && input.memo.trim() ? input.memo.trim() : null
  if (memo && memo.length > 500) throw new AppError(400, 'A note is 500 characters at most.')
  let xid: string | null = null
  const id = await inTransaction(async (c) => {
    await c.query(`SET LOCAL lock_timeout = '5s'`)
    if (!(await isCompanyOwnerUser(c, viewer.userId, viewer.landlordId))) {
      throw new AppError(403, 'Only the owner enters opening balances.')
    }
    // One company's opening balances are entered one at a time (a bank
    // account's replacement reads and voids the live one).
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`books_opening:${viewer.landlordId}`])
    const start = (await c.query(`SELECT books_start_date::text AS d FROM landlords WHERE id = $1`, [viewer.landlordId])).rows[0]?.d as string | null
    if (!start) throw new AppError(409, 'Pick when your books start first, on Books Settings.')

    let bankConnectionId: string | null = null
    let leaseId: string | null = null
    let tenantId: string | null = null
    let propertyId: string | null = null
    let accountId: string | null = null
    let paidOn: string | null = null

    if (kind === 'bank') {
      const conn = String(input.bankConnectionId ?? '')
      const ok = /^[0-9a-f-]{36}$/i.test(conn) && (await c.query(
        `SELECT 1 FROM bank_connections WHERE id = $1::uuid AND landlord_id = $2`, [conn, viewer.landlordId])).rows.length > 0
      if (!ok) throw new AppError(404, 'That bank account is not one of this company\'s.')
      bankConnectionId = conn
      await c.query(
        `UPDATE books_opening_items
            SET voided_at = now(), voided_by = $3, void_reason = 'Replaced by a new balance for this bank account.'
          WHERE landlord_id = $1 AND kind = 'bank' AND bank_connection_id = $2 AND voided_at IS NULL`,
        [viewer.landlordId, conn, viewer.userId])
    } else if (kind === 'deposit_held') {
      if (cents <= 0) throw new AppError(400, 'Enter the deposit you hold — more than $0.')
      const lease = String(input.leaseId ?? '')
      const row = /^[0-9a-f-]{36}$/i.test(lease) ? (await c.query(
        `SELECT l.id, un.property_id,
                (SELECT lt.tenant_id FROM lease_tenants lt WHERE lt.lease_id = l.id AND lt.role = 'primary'
                  ORDER BY (lt.status = 'active') DESC, lt.created_at LIMIT 1) AS tenant_id
           FROM leases l JOIN units un ON un.id = l.unit_id
          WHERE l.id = $1::uuid AND l.landlord_id = $2`, [lease, viewer.landlordId])).rows[0] : null
      if (!row) throw new AppError(404, 'That lease is not one of this company\'s.')
      const day = String(input.paidOn ?? '').trim()
      if (!isRealDay(day)) throw new AppError(400, 'Enter the day the tenant paid the deposit.')
      if (day > start) {
        throw new AppError(400, 'A deposit paid after your books start belongs on the tenant\'s account, not in opening balances.')
      }
      leaseId = row.id
      tenantId = row.tenant_id ?? null
      propertyId = row.property_id
      paidOn = day
    } else {
      if (cents === 0) throw new AppError(400, 'Enter the opening balance — not $0.')
      if (!(await chartIsReady(c, viewer.landlordId))) {
        throw new AppError(409, 'Set up the chart of accounts for your books first.')
      }
      const acct = String(input.accountId ?? '')
      const eligible = /^[0-9a-f-]{36}$/i.test(acct) && (await eligibleAccounts(c, viewer.landlordId)).some(a => a.id === acct)
      if (!eligible) {
        throw new AppError(400, 'Choose one of your own balance-sheet accounts. Receivables, money GAM holds and deposits owed open from GAM\'s records, never by hand.')
      }
      accountId = acct
    }

    const ins = await c.query(
      `INSERT INTO books_opening_items (landlord_id, kind, lease_id, tenant_id, property_id, bank_connection_id, account_id,
                                        amount, as_of, paid_on, memo, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::date, $10::date, $11, $12) RETURNING id`,
      [viewer.landlordId, kind, leaseId, tenantId, propertyId, bankConnectionId, accountId,
       ledgerCentsToNumeric(cents), start, paidOn, memo, viewer.userId])
    xid = await currentLedgerXid(c)
    return ins.rows[0].id as string
  })
  await afterLedgerChange(viewer.landlordId, xid)
  return id
}

/** The owner voids an opening balance entered by mistake. Kept, with why. */
export async function voidOpeningItem(args: { viewer: BooksViewer; id: string; reason: string }): Promise<void> {
  const { viewer } = args
  if (!viewer.canEdit) throw new AppError(403, 'Only the owner changes opening balances.')
  const reason = String(args.reason ?? '').trim()
  if (!reason) throw new AppError(400, 'Say why this opening balance is being voided.')
  if (reason.length > 500) throw new AppError(400, 'A reason is 500 characters at most.')
  if (!/^[0-9a-f-]{36}$/i.test(args.id)) throw new AppError(404, 'No such opening balance.')
  let xid: string | null = null
  await inTransaction(async (c) => {
    await c.query(`SET LOCAL lock_timeout = '5s'`)
    if (!(await isCompanyOwnerUser(c, viewer.userId, viewer.landlordId))) {
      throw new AppError(403, 'Only the owner changes opening balances.')
    }
    const row = (await c.query(
      `SELECT id, voided_at FROM books_opening_items WHERE id = $1::uuid AND landlord_id = $2 FOR UPDATE`,
      [args.id, viewer.landlordId])).rows[0]
    if (!row) throw new AppError(404, 'No such opening balance.')
    if (row.voided_at) throw new AppError(409, 'That opening balance is already voided.')
    await c.query(
      `UPDATE books_opening_items SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`,
      [args.id, viewer.userId, reason])
    xid = await currentLedgerXid(c)
  })
  await afterLedgerChange(viewer.landlordId, xid)
}

/**
 * The owner sets up the company's chart for the automatic postings (the same
 * seeding the first posting does, services/booksLedgerChart ensureChart), so
 * an "other" opening balance has its accounts to choose from. Idempotent.
 */
export async function setupOpeningChart(viewer: BooksViewer): Promise<OpeningAccountOption[]> {
  if (!viewer.canEdit) throw new AppError(403, 'Only the owner sets up the chart of accounts here.')
  return inTransaction(async (c) => {
    if (!(await isCompanyOwnerUser(c, viewer.userId, viewer.landlordId))) {
      throw new AppError(403, 'Only the owner sets up the chart of accounts here.')
    }
    await ensureChart(c, { landlordId: viewer.landlordId })
    return eligibleAccounts(c, viewer.landlordId)
  })
}
