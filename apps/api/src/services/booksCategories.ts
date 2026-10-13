/**
 * 10/12 (Nic) — GAM BOOKS, PHASE P6: THE COMPANY'S OWN CATEGORIES
 *
 *   Nic, 10/12 (L5): "those all sound like real expenses. just let
 *   bookkeeper/landlord create custom labels or categories to charge things
 *   off to."
 *
 * A company keeps its own list of categories for money out (expenses) and
 * money in (other income): GAM's starting ones (the old fixed lists, seeded by
 * books_seed_categories — migration 20261014180000) and any it makes. Each
 * category points at an account in the company's fully editable chart:
 *
 *   - until the company points it, a category charges to its starting role's
 *     account (a seeded category's own; one the company made: Other expenses /
 *     Other income), resolved through the company's map like every automatic
 *     line (services/booksLedgerChart resolveAccount);
 *   - pointing it writes a books_account_map row (map_kind 'expense_category' /
 *     'income_category', map_value = the category id) dated today — postings
 *     dated earlier keep their account, postings already made for today or
 *     later are marked to re-post (the same rule as a role's repoint). The
 *     first time a category that already posted is pointed, its starting
 *     role's whole history (every account it pointed at, from the day it did)
 *     is written down as the category's own first, so history stays where it
 *     is;
 *   - a category may point at any active account of the company's chart except
 *     one GAM keeps from the money records (a control account: receivables,
 *     money GAM holds, deposits owed, accounts payable…). The database refuses
 *     it too (books_account_map_guard).
 *
 * The account's TYPE says what the money was (books_category_on_pl): an
 * expense category on an expense account is a cost of the business; on equity
 * ("Owner draw") it is the owner's money and stays off the P&L by itself; on a
 * liability (payroll's take-home pay) it pays down what is owed.
 *
 * A category is never removed: archived, it leaves the pickers and its money
 * stays where it was filed. Its direction, company and starting account never
 * change (books_categories_guard).
 *
 * WHO (routes/expenses.ts): the owner, and a bookkeeper — "bookkeeper/landlord
 * create custom labels" — who keeps any of the company's books. Pointing a
 * category at an account changes the company's books, so a bookkeeper needs
 * the ledger (the company-wide box, or "May use the whole-company ledger").
 */
import type { PoolClient } from 'pg'
import {
  BOOKS_CATEGORY_DIRECTIONS, BOOKS_CATEGORY_MAP_KIND, BOOKS_CATEGORY_NAME_MAX, BOOKS_CATEGORY_PICKER_HIDDEN_USES,
  LEDGER_MAP_BEGINNING, booksCategoryLegacyKey, booksCategoryOnProfitAndLoss,
  type BooksCategoryDirection, type BooksCategorySystemUse,
} from '@gam/shared'
import { db, query } from '../db'
import { AppError } from '../middleware/errorHandler'

type Runner = Pick<PoolClient, 'query'>

export interface BooksCategoryView {
  id: string
  landlordId: string
  direction: BooksCategoryDirection
  name: string
  /** GAM's starting key, or null for one the company made. Never shown. */
  systemKey: string | null
  systemUse: BooksCategorySystemUse | null
  archived: boolean
  /** The word the older reports group by (the seeded key, else 'other'). */
  legacyKey: string
  /** The account it charges to today (null until the company's chart is set up). */
  accountId: string | null
  accountCode: string | null
  accountName: string | null
  accountType: string | null
  /** True when the company pointed it at an account itself (else it uses its starting account). */
  pointed: boolean
  /** True when its money counts on the Profit & Loss. */
  onProfitAndLoss: boolean
  /** Offered in the everyday pickers (payroll's own categories are not). */
  inPicker: boolean
  /** How many live rows are filed under it. */
  used: number
}

/** A category of this company, as the money writers need it. */
export interface ResolvedCategory {
  id: string
  direction: BooksCategoryDirection
  name: string
  systemKey: string | null
  systemUse: BooksCategorySystemUse | null
  archived: boolean
  legacyKey: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GAM's starting categories for a company it does not have yet (idempotent). */
export async function ensureCategories(run: Runner | null, landlordId: string): Promise<void> {
  const r: Runner = run ?? db
  await r.query(`SELECT books_seed_categories($1)`, [landlordId])
}

function asDirection(v: unknown): BooksCategoryDirection {
  if (!(BOOKS_CATEGORY_DIRECTIONS as readonly unknown[]).includes(v)) throw new AppError(400, 'A category is for money out or money in.')
  return v as BooksCategoryDirection
}

/**
 * The company's category for a write: by id (it must be the company's, of the
 * right direction), else by GAM's starting key (`key` — the old fixed lists:
 * 'repairs', 'payroll_take_home'…). Seeds the company's starting categories the
 * first time. An archived category is refused for new money unless
 * `allowArchived` (an edit that keeps a row where it was).
 */
export async function resolveCategory(run: Runner, landlordId: string, direction: BooksCategoryDirection,
  pick: { categoryId?: string | null; key?: string | null }, opts: { allowArchived?: boolean } = {}): Promise<ResolvedCategory> {
  let row: any
  if (pick.categoryId) {
    if (!UUID.test(pick.categoryId)) throw new AppError(400, 'Choose a category from the list.')
    row = (await run.query(
      `SELECT id, direction, name, system_key, system_use, archived_at FROM books_categories
        WHERE id = $1 AND landlord_id = $2`, [pick.categoryId, landlordId])).rows[0]
    if (!row) throw new AppError(400, 'That category is not one of this company\'s.')
    if (row.direction !== direction) {
      throw new AppError(400, direction === 'expense' ? 'Pick a money-out category for money going out.' : 'Pick a money-in category for money coming in.')
    }
  } else {
    const key = String(pick.key ?? '').trim()
    if (!key) throw new AppError(400, 'Choose a category.')
    await ensureCategories(run, landlordId)
    row = (await run.query(
      `SELECT id, direction, name, system_key, system_use, archived_at FROM books_categories
        WHERE landlord_id = $1 AND direction = $2 AND system_key = $3`, [landlordId, direction, key])).rows[0]
    if (!row) {
      throw new AppError(400, direction === 'expense'
        ? `"${key}" is not a money-out category.` : `"${key}" is not a money-in category.`)
    }
  }
  if (row.archived_at && !opts.allowArchived) {
    throw new AppError(409, `The category "${row.name}" is archived. Bring it back on the Categories page, or choose another.`)
  }
  return {
    id: row.id, direction: row.direction, name: row.name, systemKey: row.system_key, systemUse: row.system_use,
    archived: !!row.archived_at, legacyKey: booksCategoryLegacyKey(row.direction, row.system_key),
  }
}

/** The categories of these companies, live first, each with the account it charges to today. */
export async function listCategories(landlordIds: string[], opts: { direction?: BooksCategoryDirection; includeArchived?: boolean } = {}): Promise<BooksCategoryView[]> {
  if (!landlordIds.length) return []
  for (const id of landlordIds) await ensureCategories(null, id)
  const rows = await query<any>(
    `SELECT c.id, c.landlord_id, c.direction, c.name, c.system_key, c.system_use, c.archived_at,
            a.id AS account_id, a.code AS account_code, a.name AS account_name,
            books_category_account_type(c.id) AS account_type,
            EXISTS (SELECT 1 FROM books_account_map m
                     WHERE m.landlord_id = c.landlord_id AND m.map_value = c.id::text
                       AND m.map_kind = CASE c.direction WHEN 'expense' THEN 'expense_category' ELSE 'income_category' END) AS pointed,
            CASE c.direction
              WHEN 'expense' THEN (SELECT count(*)::int FROM landlord_expenses e WHERE e.category_id = c.id AND e.status = 'active')
              ELSE (SELECT count(*)::int FROM landlord_other_income o WHERE o.category_id = c.id AND o.status = 'active')
            END AS used
       FROM books_categories c
       LEFT JOIN books_accounts a ON a.id = books_category_account(c.id, CURRENT_DATE)
      WHERE c.landlord_id = ANY($1::uuid[])
        AND ($2::text IS NULL OR c.direction = $2)
        AND ($3::boolean OR c.archived_at IS NULL)
      ORDER BY c.direction, c.archived_at IS NOT NULL, lower(c.name), c.id`,
    [landlordIds, opts.direction ?? null, !!opts.includeArchived])
  return rows.map((r): BooksCategoryView => ({
    id: r.id, landlordId: r.landlord_id, direction: r.direction, name: r.name, systemKey: r.system_key,
    systemUse: r.system_use, archived: !!r.archived_at, legacyKey: booksCategoryLegacyKey(r.direction, r.system_key),
    accountId: r.account_id, accountCode: r.account_code, accountName: r.account_name, accountType: r.account_type,
    pointed: !!r.pointed, onProfitAndLoss: booksCategoryOnProfitAndLoss(r.direction, r.account_type),
    inPicker: !r.archived_at && !(BOOKS_CATEGORY_PICKER_HIDDEN_USES as readonly string[]).includes(r.system_use ?? ''),
    used: Number(r.used) || 0,
  }))
}

/** One account a category may point at. */
export interface CategoryAccountChoice { id: string; code: string; name: string; type: string }

/**
 * The accounts of the company's chart a category may point at: active, and
 * never one GAM keeps from the money records (an account a control role uses
 * or used).
 */
export async function categoryAccountChoices(landlordId: string): Promise<CategoryAccountChoice[]> {
  return query<CategoryAccountChoice>(
    `SELECT a.id, a.code, a.name, a.type FROM books_accounts a
      WHERE a.landlord_id = $1 AND a.active IS NOT FALSE
        AND NOT EXISTS (SELECT 1 FROM books_account_map m
                         WHERE m.account_id = a.id AND m.map_kind = 'role' AND ledger_account_role_is_control(m.map_value))
      ORDER BY a.code, a.name`, [landlordId])
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!name) throw new AppError(400, 'Give the category a name.')
  if (name.length > BOOKS_CATEGORY_NAME_MAX) throw new AppError(400, `A category name is ${BOOKS_CATEGORY_NAME_MAX} characters at most.`)
  return name
}

function nameTaken(e: any): boolean {
  return e?.code === '23505' && /books_categories_.*_name/.test(String(e?.constraint ?? ''))
}

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

/** Makes a category for the company, pointed at `accountId` when one is given. Returns its id. */
export async function createCategory(input: {
  landlordId: string; direction: unknown; name: unknown; accountId?: string | null; actorUserId: string | null
}): Promise<string> {
  const direction = asDirection(input.direction)
  const name = cleanName(input.name)
  return inTransaction(async (c) => {
    await ensureCategories(c, input.landlordId)
    let id: string
    try {
      id = (await c.query<{ id: string }>(
        `INSERT INTO books_categories (landlord_id, direction, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.landlordId, direction, name, input.actorUserId])).rows[0].id
    } catch (e) {
      if (nameTaken(e)) throw new AppError(409, `There is already a ${direction === 'expense' ? 'money-out' : 'money-in'} category called "${name}".`)
      throw e
    }
    if (input.accountId) await pointCategory(c, input.landlordId, id, input.accountId, input.actorUserId)
    return id
  })
}

/** Renames, archives or brings back a category, or points it at another account. */
export async function updateCategory(input: {
  landlordId: string; id: string; name?: unknown; archived?: boolean; accountId?: string | null; actorUserId: string | null
}): Promise<void> {
  if (!UUID.test(input.id)) throw new AppError(404, 'Category not found.')
  await inTransaction(async (c) => {
    const cur = (await c.query<{ id: string; direction: BooksCategoryDirection; name: string; archived_at: string | null; system_use: string | null }>(
      `SELECT id, direction, name, archived_at, system_use FROM books_categories WHERE id = $1 AND landlord_id = $2 FOR UPDATE`,
      [input.id, input.landlordId])).rows[0]
    if (!cur) throw new AppError(404, 'Category not found.')
    if (input.name !== undefined) {
      const name = cleanName(input.name)
      if (name !== cur.name) {
        try {
          await c.query(`UPDATE books_categories SET name = $2, updated_at = now() WHERE id = $1`, [cur.id, name])
        } catch (e) {
          if (nameTaken(e)) throw new AppError(409, `There is already a category called "${name}".`)
          throw e
        }
      }
    }
    if (input.archived !== undefined && input.archived !== !!cur.archived_at) {
      if (input.archived && cur.system_use === 'payroll') {
        throw new AppError(409, 'Payroll files what each run leaves to pay under this category, so it stays.')
      }
      try {
        await c.query(
          `UPDATE books_categories SET archived_at = $2, archived_by = $3, updated_at = now() WHERE id = $1`,
          [cur.id, input.archived ? new Date().toISOString() : null, input.archived ? input.actorUserId : null])
      } catch (e) {
        if (nameTaken(e)) throw new AppError(409, `Another live category is called "${cur.name}". Rename one of them first.`)
        throw e
      }
    }
    if (input.accountId) await pointCategory(c, input.landlordId, cur.id, input.accountId, input.actorUserId)
  })
}

/**
 * Points a category at an account of the company's chart, from today on (the
 * company's calendar). See the header for history and re-posting. In the
 * caller's transaction.
 */
export async function pointCategory(c: PoolClient, landlordId: string, categoryId: string, accountId: string, actorUserId: string | null): Promise<{ changed: boolean }> {
  if (!UUID.test(accountId)) throw new AppError(400, 'Choose an account from the chart.')
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`books_chart:${landlordId}`])
  const cat = (await c.query<{ id: string; direction: BooksCategoryDirection; default_role: string | null }>(
    `SELECT id, direction, default_role FROM books_categories WHERE id = $1 AND landlord_id = $2`, [categoryId, landlordId])).rows[0]
  if (!cat) throw new AppError(404, 'Category not found.')
  const acct = (await c.query<{ id: string; name: string; active: boolean | null; kept: boolean }>(
    `SELECT a.id, a.name, a.active,
            EXISTS (SELECT 1 FROM books_account_map m WHERE m.account_id = a.id AND m.map_kind = 'role'
                       AND ledger_account_role_is_control(m.map_value)) AS kept
       FROM books_accounts a WHERE a.id = $1 AND a.landlord_id = $2`, [accountId, landlordId])).rows[0]
  if (!acct) throw new AppError(404, 'That account is not in this company\'s chart.')
  if (acct.active === false) throw new AppError(409, `${acct.name} is deleted. Choose an active account.`)
  if (acct.kept) throw new AppError(409, `${acct.name} is kept by GAM from the money records. Choose another account for this category.`)
  const kind = BOOKS_CATEGORY_MAP_KIND[cat.direction]
  const rows = (await c.query<{ account_id: string; effective_from: string }>(
    `SELECT account_id, effective_from::text AS effective_from FROM books_account_map
      WHERE landlord_id = $1 AND map_kind = $2 AND map_value = $3
      ORDER BY effective_from DESC, id DESC`, [landlordId, kind, cat.id])).rows
  const cur = rows[0] ?? null
  if (cur && cur.account_id === accountId) return { changed: false }
  // 10/12 (Nic, integrate): loaded when a category is pointed, so the Expenses
  // record (landlordExpenses, which every money screen and agent tool imports)
  // never pulls the ledger engine's own connection pool in with it.
  const { loadOwnerContext } = await import('./ledgerOwner')
  const ctx = await loadOwnerContext(c, { landlordId })
  const insert = (account: string, from: string, note: string) => c.query(
    `INSERT INTO books_account_map (landlord_id, map_kind, map_value, account_id, effective_from, set_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [landlordId, kind, cat.id, account, from, actorUserId, note])
  let from = ctx.today
  if (!cur) {
    // Already posted through its starting account: write that role's history
    // down as the category's own first, so what posted before today stays
    // where it posted. 10/12 review: EVERY row of the role's history (each
    // account it pointed at, from the day it did), never only today's: a role
    // repointed earlier had its older months moved onto the newer account by
    // the next rebuild (closed months included — the first row for a key may
    // cover all history). The guard (books_account_map_guard) lets these
    // copies into closed months, and only these.
    const posted = (await c.query<{ yes: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ledger_posting_lines l JOIN ledger_postings p ON p.id = l.posting_id
                       WHERE p.landlord_id = $1 AND p.role = 'post' AND p.superseded_at IS NULL
                         AND l.map_kind = $2 AND l.map_value = $3) AS yes`, [landlordId, kind, cat.id])).rows[0].yes
    const role = cat.default_role ?? (cat.direction === 'expense' ? 'other_expenses' : 'other_income')
    const history = posted
      ? (await c.query<{ account_id: string; effective_from: string }>(
          `SELECT account_id, effective_from::text AS effective_from FROM books_account_map
            WHERE landlord_id = $1 AND map_kind = 'role' AND map_value = $2
            ORDER BY effective_from, id`, [landlordId, role])).rows
      : []
    if (history.length) {
      for (const h of history) await insert(h.account_id, h.effective_from, 'Where this category posted before it was pointed')
      // Already charging there today: nothing more to write.
      const inForce = [...history].reverse().find(h => h.effective_from <= ctx.today) ?? history[0]
      if (inForce.account_id === accountId) return { changed: false }
    } else {
      from = LEDGER_MAP_BEGINNING
    }
  }
  await insert(accountId, from, 'Pointed by the company')
  // Postings already made for that day or later re-post at the next drain: the
  // category's own lines (incurred), and the payments of its expenses (their
  // cash lines say whether it is a cost — MONEY_OUT_LINE_KINDS).
  await c.query(
    `INSERT INTO ledger_outbox (source_type, source_id, owner_id)
     SELECT DISTINCT p.source_type, p.source_id, $1::uuid
       FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.landlord_id = $1 AND p.role = 'post' AND p.superseded_at IS NULL
        AND l.map_kind = $2 AND l.map_value = $3 AND p.intended_date >= $4::date
     UNION
     SELECT 'expense_payment', x.id::text, $1::uuid FROM landlord_expense_payments x
       JOIN landlord_expenses e ON e.id = x.expense_id
      WHERE e.category_id = $5 AND x.paid_on >= $4::date`,
    [landlordId, kind, cat.id, from, cat.id])
  return { changed: true }
}
