/**
 * 10/12 (Nic) — GAM Books, phase P6: one list for every allowed value.
 *
 * The categories GAM starts a company with, the expense-payment methods and
 * sources, the bank-line match kinds, the bookkeeper's money-in choice and
 * the repair-bill choice are each said once in packages/shared/src/
 * booksMoneyOut.ts; the database CHECKs and the SQL seed must say the same
 * (CLAUDE.md: single source of truth).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  BOOKS_DEFAULT_EXPENSE_CATEGORIES, BOOKS_DEFAULT_INCOME_CATEGORIES, EXPENSE_CATEGORIES, OTHER_INCOME_CATEGORIES,
  LANDLORD_EXPENSE_PAYMENT_METHODS, LANDLORD_EXPENSE_PAYMENT_SOURCES, BANK_LINE_MATCH_KINDS, BOOKKEEPER_MONEY_IN_FILING,
  BOOKS_REPAIR_BILL_MODES, BOOKS_CATEGORY_SYSTEM_USES, BOOKS_CATEGORY_DIRECTIONS, MONEY_OUT_LINE_KINDS,
  MONEY_OUT_MIGRATED_FROM_TABLES, LEDGER_MAP_KINDS, LEDGER_ACCOUNT_ROLES, BOOKS_ACCOUNT_TYPES,
  booksCategoryLegacyKey, booksCategoryReportCategory,
} from '@gam/shared'
import { db } from '../db'

const DIR = path.join(__dirname, '../db/migrations')
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')

/** The values a CHECK named `name` allows, as the database has it now. */
async function checkValues(table: string, name: string): Promise<string[]> {
  const r = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.conname = $2`, [table, name])
  expect(r.rows[0], `${table}.${name}`).toBeTruthy()
  return [...r.rows[0].def.matchAll(/'([^']+)'::text/g)].map(m => m[1])
}

describe('GAM\'s starting categories', () => {
  it('the first fifteen expense categories are the old fixed list, in order, and every income category is the old income list', () => {
    expect(BOOKS_DEFAULT_EXPENSE_CATEGORIES.slice(0, 15).map(c => c.key)).toEqual([...EXPENSE_CATEGORIES])
    expect(BOOKS_DEFAULT_INCOME_CATEGORIES.map(c => c.key)).toEqual([...OTHER_INCOME_CATEGORIES])
    for (const c of [...BOOKS_DEFAULT_EXPENSE_CATEGORIES, ...BOOKS_DEFAULT_INCOME_CATEGORIES]) {
      expect(LEDGER_ACCOUNT_ROLES, c.key).toContain(c.role)
    }
  })

  it('the SQL seed lists the same rows (key, name, role, system use) as the shared seed', () => {
    // 10/12 (Nic): the newest migration that re-creates books_seed_categories()
    // is the seed the database runs (20261014240100 added Work trade labor).
    const defining = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
      .filter(f => /CREATE OR REPLACE FUNCTION books_seed_categories\b/.test(read(f)))
    expect(defining[0]).toBe('20261014180000_books_categories.sql')
    const sql = read(defining[defining.length - 1])
    const rows = [...sql.matchAll(/\('(expense|income)',\s+'([a-z_]+)',\s+'([^']+)',\s+'([a-z_]+)',\s+(NULL(?:::text)?|'[a-z_]+'),\s+\d+\)/g)]
      .map(m => ({ direction: m[1], key: m[2], name: m[3], role: m[4], systemUse: m[5].startsWith('NULL') ? undefined : m[5].slice(1, -1) }))
    const want = [
      ...BOOKS_DEFAULT_EXPENSE_CATEGORIES.map(c => ({ direction: 'expense', key: c.key, name: c.name, role: c.role, systemUse: (c as any).systemUse })),
      ...BOOKS_DEFAULT_INCOME_CATEGORIES.map(c => ({ direction: 'income', key: c.key, name: c.name, role: c.role, systemUse: (c as any).systemUse })),
    ]
    expect(rows).toEqual(want)
  })

  it('an older report reads a seeded category by its own key and any other as other; report categories follow', () => {
    expect(booksCategoryLegacyKey('expense', 'repairs')).toBe('repairs')
    expect(booksCategoryLegacyKey('expense', 'owner_draw')).toBe('other')
    expect(booksCategoryLegacyKey('expense', null)).toBe('other')
    expect(booksCategoryLegacyKey('income', 'laundry')).toBe('laundry')
    expect(booksCategoryReportCategory('expense', 'hoa', true)).toBe('hoa')
    expect(booksCategoryReportCategory('income', 'laundry', true)).toBe('other_income')
    expect(booksCategoryReportCategory('income', 'owner_contribution', false)).toBe('not_income')
  })
})

describe('the database says what the shared lists say', () => {
  it('every CHECK', async () => {
    expect(await checkValues('books_categories', 'books_categories_direction_check')).toEqual([...BOOKS_CATEGORY_DIRECTIONS])
    expect(await checkValues('books_categories', 'books_categories_system_use_check')).toEqual([...BOOKS_CATEGORY_SYSTEM_USES])
    expect(await checkValues('landlord_expense_payments', 'landlord_expense_payments_method_check')).toEqual([...LANDLORD_EXPENSE_PAYMENT_METHODS])
    expect(await checkValues('landlord_expense_payments', 'landlord_expense_payments_source_check')).toEqual([...LANDLORD_EXPENSE_PAYMENT_SOURCES])
    // 10/12 (Nic): money out and money in (a loan's money arriving) — migration 20261014210000.
    expect(await checkValues('bank_transactions', 'bank_transactions_matched_kind_check')).toEqual([...BANK_LINE_MATCH_KINDS])
    expect(await checkValues('bookkeeper_scopes', 'bookkeeper_scopes_money_in_filing_check')).toEqual([...BOOKKEEPER_MONEY_IN_FILING])
    expect(await checkValues('landlords', 'landlords_books_repair_bills_check')).toEqual([...BOOKS_REPAIR_BILL_MODES])
    expect(await checkValues('ledger_posting_lines', 'ledger_posting_lines_expense_kind_check')).toEqual([...MONEY_OUT_LINE_KINDS])
    expect([...MONEY_OUT_LINE_KINDS].sort()).toEqual([...BOOKS_ACCOUNT_TYPES].sort())
    expect(await checkValues('landlord_expenses', 'landlord_expenses_migrated_from_check')).toEqual([...MONEY_OUT_MIGRATED_FROM_TABLES])
    expect((await checkValues('books_account_map', 'books_account_map_kind_check')).sort()).toEqual([...LEDGER_MAP_KINDS].sort())
    expect((await checkValues('ledger_posting_lines', 'ledger_posting_lines_map_kind_check')).sort()).toEqual([...LEDGER_MAP_KINDS].sort())
  })
})
