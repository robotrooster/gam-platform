/**
 * 10/12 (Nic) — GAM Books ledger, phase P3: capture coverage, and the promise
 * that the books never block, slow or fail a money write
 * (gam-ledger-design-2026-10-12 §3, §7, §17 "Safety and concurrency",
 * "Coverage and purity").
 *
 *   - every money table either marks its sources for posting (three
 *     statement-level triggers, reading transition tables, on exactly the
 *     columns the shared list names) or is named as deliberately left out;
 *   - the trigger bodies hold no EXCEPTION block (a subtransaction per
 *     statement) and take no lock;
 *   - a bulk update of columns the ledger does not read writes nothing;
 *   - a money write never waits on a poster, even at the moment the poster
 *     holds the most, and a projector that throws never touches the money;
 *   - the database's posting-role catalog and every ledger CHECK list exactly
 *     the shared values;
 *   - 10/12 (Nic) review: a later migration can never break a capture body
 *     (and with it every write to a money table) — the DDL is refused in its
 *     own migration; re-installing a capture never locks a money table against
 *     reads; the migration takes every table's lock at once, never waiting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  LEDGER_CAPTURE_COLUMNS, LEDGER_CAPTURE_TABLES, LEDGER_EXCLUDED_TABLES, LEDGER_ACCOUNT_ROLE_DEFS,
  LEDGER_SOURCE_TYPES, LEDGER_POSTING_KINDS, LEDGER_POSTING_ROLES, LEDGER_CASH_EFFECTS, LEDGER_REPORT_CATEGORIES,
  LEDGER_MAP_KINDS, LEDGER_SOURCE_ERROR_REASONS, LEDGER_RUN_MODES, LEDGER_RUN_STATUSES, LEDGER_OPENING_ITEM_KINDS,
  LEDGER_CLOSE_ACTIONS, LEDGER_CLOSE_PERMISSIONS, LEDGER_OPEN_MONTH_FIX_MODES, BOOKS_JOURNAL_ENTRY_TYPES,
  DEFAULT_LEDGER_CLOSE_BY, DEFAULT_LEDGER_REOPEN_BY, DEFAULT_LEDGER_OPEN_MONTH_FIXES,
} from '@gam/shared'
import { db } from '../db'
import {
  cleanupAllSchema, seedTenant, seedLease, seedLeaseFee, seedUtilityMeter, seedUtilityBill, seedUtilityPayment,
  seedSecurityDeposit,
} from '../test/dbHelpers'
import { inTx, ledgerCompany, addOtherIncome, outboxCount, postingsOf } from '../test/ledgerFixtures'
import {
  drainLedgerOutbox, registerLedgerProjector, unregisterLedgerProjector, registeredLedgerSourceTypes, ledgerTestHooks,
} from './ledgerEngine'
import { otherIncomeTestProjector } from './ledgerTestProjector'
import { productionLedgerProjectors, LEDGER_SOURCE_TYPES_NOT_POSTED_YET } from './ledgerProjectors'

beforeEach(async () => {
  await cleanupAllSchema()
})

afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
  delete ledgerTestHooks.afterOwnerLock
  delete ledgerTestHooks.beforeCommit
})

/** The quoted values in a CHECK constraint, in order. */
async function checkValues(table: string, constraint: string): Promise<string[]> {
  const r = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.conname = $2`, [table, constraint])
  expect(r.rows, `${table}.${constraint} exists`).toHaveLength(1)
  return [...r.rows[0].def.matchAll(/'([^']*)'/g)].map(m => m[1])
}

describe('capture coverage', () => {
  it('every capture table has its three statement-level triggers, on transition tables, on exactly the shared columns', async () => {
    const r = await db.query<{ table_name: string; tgname: string; is_row: boolean; old_t: string | null; new_t: string | null; src: string }>(
      `SELECT c.relname AS table_name, g.tgname, (g.tgtype & 1) = 1 AS is_row, g.tgoldtable AS old_t, g.tgnewtable AS new_t,
              p.prosrc AS src
         FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_proc p ON p.oid = g.tgfoid
        WHERE NOT g.tgisinternal AND g.tgname LIKE 'ledger_capture_%' AND c.relname <> 'landlords'`)
    const byTable = new Map<string, typeof r.rows>()
    for (const t of r.rows) byTable.set(t.table_name, [...(byTable.get(t.table_name) ?? []), t])
    expect([...byTable.keys()].sort()).toEqual([...LEDGER_CAPTURE_TABLES].sort())
    for (const table of LEDGER_CAPTURE_TABLES) {
      const trg = byTable.get(table)!
      expect(trg.map(t => t.tgname).sort(), table).toEqual(['ledger_capture_del', 'ledger_capture_ins', 'ledger_capture_upd'])
      for (const t of trg) {
        expect(t.is_row, `${table} ${t.tgname} is statement-level`).toBe(false)
        const cols = /-- ledger columns: ([^\n]*)/.exec(t.src)?.[1]
        expect(cols, `${table} ${t.tgname} column list`).toBe((LEDGER_CAPTURE_COLUMNS[table] as readonly string[]).join(','))
      }
      expect(trg.find(t => t.tgname === 'ledger_capture_ins')).toMatchObject({ old_t: null, new_t: 'ledger_new' })
      expect(trg.find(t => t.tgname === 'ledger_capture_upd')).toMatchObject({ old_t: 'ledger_old', new_t: 'ledger_new' })
      expect(trg.find(t => t.tgname === 'ledger_capture_del')).toMatchObject({ old_t: 'ledger_old', new_t: null })
    }
  })

  it('no capture body opens a subtransaction (EXCEPTION) or takes a lock; each is one INSERT into the outbox', async () => {
    const r = await db.query<{ proname: string; src: string }>(
      `SELECT proname, prosrc AS src FROM pg_proc WHERE proname LIKE 'ledger_capture_%'`)
    expect(r.rows.length).toBe(LEDGER_CAPTURE_TABLES.length * 3 + 1)
    for (const f of r.rows) {
      expect(f.src, f.proname).not.toMatch(/\bEXCEPTION\b/i)
      expect(f.src, f.proname).not.toMatch(/FOR\s+(NO\s+KEY\s+)?UPDATE|FOR\s+(KEY\s+)?SHARE|LOCK\s+TABLE|pg_advisory/i)
      expect((f.src.match(/INSERT INTO/g) ?? []).length, f.proname).toBe(1)
      expect(f.src, f.proname).toMatch(/INSERT INTO ledger_outbox/)
    }
    // The outbox itself can never make a writer wait or fail: no key, no foreign key, no CHECK, no trigger.
    const cons = await db.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'ledger_outbox'::regclass`)
    expect(cons.rows).toEqual([])
    const trg = await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'ledger_outbox'::regclass AND NOT tgisinternal`)
    expect(trg.rows).toEqual([])
  })

  it('every table with a money column marks its sources, or is named as left out with why — never both, never neither', async () => {
    const r = await db.query<{ t: string; captured: boolean }>(
      `SELECT DISTINCT c.table_name AS t,
              EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || c.table_name)::regclass
                                                   AND g.tgname = 'ledger_capture_ins') AS captured
         FROM information_schema.columns c
         JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
        WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE' AND c.data_type = 'numeric'
          AND (c.column_name LIKE '%amount%' OR c.column_name LIKE '%net%' OR c.column_name LIKE '%fee%'
               OR c.column_name LIKE '%total%' OR c.column_name LIKE '%price%' OR c.column_name LIKE '%paid%')
          AND c.table_name NOT LIKE 'ledger\\_%' AND c.table_name NOT IN ('books_opening_items', 'ledger_close_balances')`)
    const neither = r.rows.filter(x => !x.captured && !(x.t in LEDGER_EXCLUDED_TABLES)).map(x => x.t)
    expect(neither).toEqual([])
    const both = r.rows.filter(x => x.captured && x.t in LEDGER_EXCLUDED_TABLES).map(x => x.t)
    expect(both).toEqual([])
    expect(LEDGER_CAPTURE_TABLES.filter(t => t in LEDGER_EXCLUDED_TABLES)).toEqual([])
    for (const [t, why] of Object.entries(LEDGER_EXCLUDED_TABLES)) expect(why.trim().length, t).toBeGreaterThan(3)
  })
})

// 10/12 (Nic, ledger review): nothing a capture trigger marks waits without a
// written reason — every source type is posted by a production projector, or
// named in LEDGER_SOURCE_TYPES_NOT_POSTED_YET with why (never both).
describe('every source type a capture names posts, or says why it waits', () => {
  it('capture keys name only known source types; each is registered in production or listed with a reason', async () => {
    const r = await db.query<{ proname: string; src: string }>(
      `SELECT proname, prosrc AS src FROM pg_proc WHERE proname LIKE 'ledger_capture_%_ins'`)
    expect(r.rows.length).toBe(LEDGER_CAPTURE_TABLES.length)
    const named = new Set<string>()
    for (const f of r.rows) {
      for (const m of f.src.matchAll(/(?:\bSELECT\s+|\bVALUES\s*\(\s*|\)\s*,\s*\(\s*)'([a-z_]+)'(?:::text)?\s*,/g)) named.add(m[1])
    }
    expect(named.size).toBeGreaterThan(20)
    expect([...named].filter(t => !(LEDGER_SOURCE_TYPES as readonly string[]).includes(t))).toEqual([])
    const posted = new Set<string>(productionLedgerProjectors().map(p => p.sourceType))
    const waiting = LEDGER_SOURCE_TYPES_NOT_POSTED_YET as Record<string, string | undefined>
    for (const t of LEDGER_SOURCE_TYPES) {
      const why = waiting[t]
      expect(posted.has(t) !== !!why, `${t}: posted by a projector, or waiting with a reason — exactly one`).toBe(true)
      if (why) expect(why.trim().length, t).toBeGreaterThan(10)
    }
    // Every type a capture marks is covered (a capture never marks a type nothing will ever say anything about).
    for (const t of named) expect(posted.has(t) || !!waiting[t], t).toBe(true)
  })
})

describe('the posting-role catalog and every ledger CHECK match the shared lists', () => {
  it('ledger_account_role_type() and ledger_account_role_is_control() are LEDGER_ACCOUNT_ROLE_DEFS', async () => {
    const roles = LEDGER_ACCOUNT_ROLE_DEFS.map(d => d.role)
    const r = await db.query<{ role: string; type: string | null; control: boolean }>(
      `SELECT x AS role, ledger_account_role_type(x) AS type, ledger_account_role_is_control(x) AS control
         FROM unnest($1::text[]) x`, [roles])
    expect(r.rows.map(x => [x.role, x.type, x.control])).toEqual(LEDGER_ACCOUNT_ROLE_DEFS.map(d => [d.role, d.type, d.control]))
    const unknown = await db.query(`SELECT ledger_account_role_type('no_such_role') AS t, ledger_account_role_is_control('no_such_role') AS c`)
    expect(unknown.rows[0]).toEqual({ t: null, c: false })
  })

  it('each CHECK lists exactly its shared values, and the defaults are the shared defaults', async () => {
    const same = async (table: string, constraint: string, values: readonly string[]) =>
      expect((await checkValues(table, constraint)).sort(), `${table}.${constraint}`).toEqual([...values].sort())
    await same('ledger_postings', 'ledger_postings_source_type_check', LEDGER_SOURCE_TYPES)
    await same('ledger_postings', 'ledger_postings_kind_check', LEDGER_POSTING_KINDS)
    await same('ledger_postings', 'ledger_postings_role_check', LEDGER_POSTING_ROLES)
    await same('ledger_posting_lines', 'ledger_posting_lines_cash_effect_check', LEDGER_CASH_EFFECTS)
    await same('ledger_posting_lines', 'ledger_posting_lines_report_category_check', LEDGER_REPORT_CATEGORIES)
    await same('ledger_posting_lines', 'ledger_posting_lines_map_kind_check', LEDGER_MAP_KINDS)
    await same('books_account_map', 'books_account_map_kind_check', LEDGER_MAP_KINDS)
    await same('ledger_source_errors', 'ledger_source_errors_reason_check', LEDGER_SOURCE_ERROR_REASONS)
    await same('ledger_rebuild_runs', 'ledger_rebuild_runs_mode_check', LEDGER_RUN_MODES)
    await same('ledger_rebuild_runs', 'ledger_rebuild_runs_status_check', LEDGER_RUN_STATUSES)
    await same('books_opening_items', 'books_opening_items_kind_check', LEDGER_OPENING_ITEM_KINDS)
    await same('books_period_closes', 'books_period_closes_action_check', LEDGER_CLOSE_ACTIONS)
    await same('landlords', 'landlords_books_close_by_check', LEDGER_CLOSE_PERMISSIONS)
    await same('landlords', 'landlords_books_reopen_by_check', LEDGER_CLOSE_PERMISSIONS)
    await same('landlords', 'landlords_books_open_month_fixes_check', LEDGER_OPEN_MONTH_FIX_MODES)
    await same('journal_entries', 'journal_entries_type_check', BOOKS_JOURNAL_ENTRY_TYPES)
    const d = await db.query<{ column_name: string; column_default: string }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'landlords' AND column_name IN ('books_close_by', 'books_reopen_by', 'books_open_month_fixes')`)
    const def = Object.fromEntries(d.rows.map(x => [x.column_name, /'([^']*)'/.exec(x.column_default)?.[1]]))
    expect(def).toEqual({
      books_close_by: DEFAULT_LEDGER_CLOSE_BY, books_reopen_by: DEFAULT_LEDGER_REOPEN_BY,
      books_open_month_fixes: DEFAULT_LEDGER_OPEN_MONTH_FIXES,
    })
  })
})

describe('a money write is never blocked, slowed or failed by the books', () => {
  it('a bulk update of columns the ledger does not read writes nothing (10,000 payments); a real change marks each row once', async () => {
    const co = await ledgerCompany()
    const tenantId = await inTx(c => seedTenant(c))
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, platform_held)
       SELECT $1, $2, $3, 'rent', 100 + (g % 7), 'settled', 'RENT', DATE '2000-01-01' + g, TRUE FROM generate_series(1, 10000) g`,
      [co.unitId, tenantId, co.landlordId])
    expect(await outboxCount('payment')).toBe(10_000)   // one statement: one row per new source
    await db.query(`DELETE FROM ledger_outbox`)

    // The weekly passthrough's shape (landlordPassthrough): every settled row of a landlord.
    const upd = await db.query(`UPDATE payments SET platform_held = FALSE WHERE landlord_id = $1`, [co.landlordId])
    expect(upd.rowCount).toBe(10_000)
    expect(await outboxCount()).toBe(0)
    // Writing a ledger column back unchanged writes nothing either.
    await db.query(`UPDATE payments SET amount = amount, status = status WHERE landlord_id = $1`, [co.landlordId])
    expect(await outboxCount()).toBe(0)
    // A real change: one row per changed source, from one statement.
    await db.query(
      `UPDATE payments SET amount = amount + 1 WHERE id IN (SELECT id FROM payments WHERE landlord_id = $1 ORDER BY id LIMIT 5)`,
      [co.landlordId])
    expect(await outboxCount('payment')).toBe(5)
    const keys = await db.query(`SELECT count(DISTINCT source_id)::int AS n, count(DISTINCT xid)::int AS x FROM ledger_outbox`)
    expect(keys.rows[0]).toEqual({ n: 5, x: 1 })
  })

  it('a money write never waits on a poster — not even at the moment the poster holds the most', async () => {
    registerLedgerProjector(otherIncomeTestProjector)
    const co = await ledgerCompany()
    const tenantId = await inTx(c => seedTenant(c))
    const pay = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1, $2, $3, 'rent', 500, 'pending', 'RENT', DATE '2026-09-01') RETURNING id`, [co.unitId, tenantId, co.landlordId])).rows[0].id
    const id = await addOtherIncome(co, { amount: 100, day: '2026-09-10' })
    await db.query(`DELETE FROM ledger_outbox WHERE source_type = 'payment'`)   // the bill's own insert: not this test's

    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inside = new Promise<void>(r => { entered = r })
    ledgerTestHooks.beforeCommit = async () => { entered(); await gate }
    const drain = drainLedgerOutbox()
    await inside   // the poster has written its lines and deleted its outbox rows, and has not committed

    const w = await db.connect()
    try {
      await w.query(`SET lock_timeout = '2s'`)
      const started = Date.now()
      await w.query('BEGIN')
      await w.query(`UPDATE landlord_other_income SET amount = 140 WHERE id = $1`, [id])            // the very source being posted
      const other = (await w.query(`INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
                                    VALUES ($1, $2, 'other', 9, '2026-09-11') RETURNING id`, [co.landlordId, co.propertyId])).rows[0].id
      await w.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1`, [pay])
      await w.query(`UPDATE landlords SET updated_at = now() WHERE id = $1`, [co.landlordId])      // the company row the lines name
      await w.query(`UPDATE books_accounts SET name = name || ' ' WHERE landlord_id = $1 AND code = '4900'`, [co.landlordId])
      await w.query('COMMIT')
      expect(Date.now() - started).toBeLessThan(1500)
      release()
      await drain
      // The poster deleted only the outbox rows it read: the writer's change to
      // the same source stays for the next pass (the writer's new row, a key
      // this pass had not seen, was posted by the same pass).
      expect(await outboxCount('other_income', id)).toBe(1)
      expect(await outboxCount('other_income', other)).toBe(0)
      expect(await postingsOf('other_income', other)).toHaveLength(1)
      expect(await outboxCount('payment', pay)).toBe(1)
    } finally {
      release()
      await w.query('ROLLBACK').catch(() => {})
      w.release()
    }
    delete ledgerTestHooks.beforeCommit
    expect((await drainLedgerOutbox()).failed).toBe(0)
    expect(await postingsOf('other_income', id)).toHaveLength(3)   // posted, reversed, re-posted at 140
  })

  it('a projector that throws never touches the money: the write stays committed and the key waits with its error', async () => {
    registerLedgerProjector({
      ...otherIncomeTestProjector,
      async project() { throw new Error('projector bug') },
    })
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 77, day: '2026-09-15' })
    const s = await drainLedgerOutbox()
    expect(s.failed).toBe(1)
    expect((await db.query(`SELECT amount::text AS a FROM landlord_other_income WHERE id = $1`, [id])).rows[0].a).toBe('77.00')
    expect(await outboxCount('other_income', id)).toBe(1)
    const e = (await db.query(`SELECT reason_code, last_error FROM ledger_source_errors WHERE source_id = $1`, [id])).rows[0]
    expect(e).toEqual({ reason_code: 'projector_error', last_error: 'projector bug' })
    expect(await postingsOf('other_income', id)).toHaveLength(0)
  })

  it('one statement marks each changed source once, however many rows', async () => {
    const co = await ledgerCompany()
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, category, amount, income_date)
       SELECT $1, 'other', g, DATE '2026-09-01' FROM generate_series(1, 500) g`, [co.landlordId])
    expect(await outboxCount('other_income')).toBe(500)
    await db.query(`UPDATE landlord_other_income SET amount = amount + 1 WHERE landlord_id = $1`, [co.landlordId])
    const r = await db.query(`SELECT count(*)::int AS n, count(DISTINCT source_id)::int AS d, count(DISTINCT xid)::int AS x
                                FROM ledger_outbox WHERE source_type = 'other_income'`)
    expect(r.rows[0]).toEqual({ n: 1000, d: 500, x: 2 })
    expect((await db.query(`SELECT count(DISTINCT owner_id)::int AS n FROM ledger_outbox WHERE owner_id = $1`, [co.landlordId])).rows[0].n).toBe(1)
  })
})

describe('dependent tables mark the source that reads them', () => {
  it('utility bills, lease fees, invoices and FlexDeposit installment links mark their payment', async () => {
    const co = await ledgerCompany()
    const ids = await inTx(async c => {
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId: co.unitId, landlordId: co.landlordId })
      const meterId = await seedUtilityMeter(c, { propertyId: co.propertyId })
      const utilPay = await seedUtilityPayment(c, { unitId: co.unitId, tenantId, landlordId: co.landlordId, leaseId, amount: 30 })
      const billId = await seedUtilityBill(c, { meterId, unitId: co.unitId, tenantId, leaseId, landlordId: co.landlordId, chargeAmount: 30, paymentId: utilPay })
      const feeId = await seedLeaseFee(c, { leaseId, feeType: 'pet_fee', amount: 25, dueTiming: 'monthly_ongoing' })
      const feePay = (await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, lease_fee_id)
         VALUES ($1, $2, $3, $4, 'fee', 25, 'pending', 'OTHERFEE', DATE '2026-09-01', $5) RETURNING id`,
        [co.unitId, tenantId, co.landlordId, leaseId, feeId])).rows[0].id
      const invId = (await c.query(
        `INSERT INTO invoices (landlord_id, unit_id, lease_id, invoice_number, due_date, total_amount)
         VALUES ($1, $2, $3, $4, DATE '2026-09-01', 100) RETURNING id`, [co.landlordId, co.unitId, leaseId, `INV-${randomUUID().slice(0, 8)}`])).rows[0].id
      const invPay = (await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, invoice_id)
         VALUES ($1, $2, $3, $4, 'rent', 100, 'pending', 'RENT', DATE '2026-09-01', $5) RETURNING id`,
        [co.unitId, tenantId, co.landlordId, leaseId, invId])).rows[0].id
      const depId = await seedSecurityDeposit(c, { unitId: co.unitId, leaseId, tenantId, totalAmount: 300 })
      const depPay = (await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
         VALUES ($1, $2, $3, $4, 'deposit', 100, 'pending', 'DEPOSIT', DATE '2026-09-01') RETURNING id`,
        [co.unitId, tenantId, co.landlordId, leaseId])).rows[0].id
      const instId = (await c.query(
        `INSERT INTO flex_deposit_installments (security_deposit_id, tenant_id, installment_number, installment_count, amount, due_date)
         VALUES ($1, $2, 1, 3, 100, DATE '2026-09-01') RETURNING id`, [depId, tenantId])).rows[0].id
      return { utilPay, billId, feeId, feePay, invId, invPay, depPay, instId }
    })
    await db.query(`DELETE FROM ledger_outbox`)

    await db.query(`UPDATE utility_bills SET tax_amount = 1.5 WHERE id = $1`, [ids.billId])
    await db.query(`UPDATE lease_fees SET is_refundable = TRUE WHERE id = $1`, [ids.feeId])
    await db.query(`UPDATE invoices SET is_opening_balance = TRUE WHERE id = $1`, [ids.invId])
    // FlexDeposit links its installment to the payment in a statement of its own (flexDeposit.ts).
    await db.query(`UPDATE flex_deposit_installments SET payment_id = $2 WHERE id = $1`, [ids.instId, ids.depPay])
    const marked = await db.query<{ source_id: string }>(`SELECT DISTINCT source_id FROM ledger_outbox WHERE source_type = 'payment'`)
    expect(marked.rows.map(r => r.source_id).sort()).toEqual([ids.utilPay, ids.feePay, ids.invPay, ids.depPay].sort())
    // …and unlinking marks it again (OLD and NEW are both read).
    await db.query(`DELETE FROM ledger_outbox`)
    await db.query(`UPDATE flex_deposit_installments SET payment_id = NULL WHERE id = $1`, [ids.instId])
    expect(await outboxCount('payment', ids.depPay)).toBe(1)
    // 10/12 (Nic, ledger review): a FlexDeposit enroll or cancel alone marks
    // the lease's deposit rows (their posting reads whether they are installments).
    await db.query(`DELETE FROM ledger_outbox`)
    await db.query(`UPDATE security_deposits SET flex_deposit_enabled = TRUE WHERE lease_id = (SELECT lease_id FROM payments WHERE id = $1)`, [ids.depPay])
    expect(await outboxCount('payment', ids.depPay)).toBe(1)
  })

  it('10/12 review: a home sale\'s activation day or lease alone, a bank line\'s receipt, and a bank line matched to a payout each re-post what reads them', async () => {
    const co = await ledgerCompany()
    const ids = await inTx(async c => {
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId: co.unitId, landlordId: co.landlordId })
      const sale = (await c.query<{ id: string }>(
        `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount, annual_interest_rate,
                                          term_months, monthly_payment, start_month, installments_total, status)
         VALUES ($1, $2, $3, 1000, 0, 1000, 0, 10, 100, '2026-10-01', 10, 'active') RETURNING id`, [co.unitId, tenantId, co.landlordId])).rows[0].id
      const conn = (await c.query<{ id: string }>(
        `INSERT INTO bank_connections (landlord_id, account_last4) VALUES ($1, '1111') RETURNING id`, [co.landlordId])).rows[0].id
      const line = (await c.query<{ id: string }>(
        `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
         VALUES ($1, $2, $3, '2026-09-10', 50, 'needs_review') RETURNING id`, [conn, co.landlordId, `x-${randomUUID()}`])).rows[0].id
      const payout = (await c.query<{ id: string }>(
        `INSERT INTO disbursements (landlord_id, amount, status) VALUES ($1, 50, 'settled') RETURNING id`, [co.landlordId])).rows[0].id
      return { sale, leaseId, line, payout }
    })
    await db.query(`DELETE FROM ledger_outbox`)
    await db.query(`UPDATE home_sale_contracts SET activated_at = '2026-09-20T18:00:00Z' WHERE id = $1`, [ids.sale])
    expect(await outboxCount('home_sale', ids.sale)).toBe(1)
    await db.query(`UPDATE home_sale_contracts SET lease_id = $2 WHERE id = $1`, [ids.sale, ids.leaseId])
    expect(await outboxCount('home_sale', ids.sale)).toBe(2)
    await db.query(`UPDATE bank_transactions SET auto_settle_undo = jsonb_build_object('receiptId', $2::text) WHERE id = $1`, [ids.line, randomUUID()])
    expect(await outboxCount('bank_match', ids.line)).toBe(1)
    await db.query(`UPDATE bank_transactions SET matched_disbursement_id = $2, status = 'matched' WHERE id = $1`, [ids.line, ids.payout])
    expect(await outboxCount('disbursement', ids.payout)).toBe(1)
  })
})


describe('a later schema change can never break a capture body (10/12 (Nic) review)', () => {
  /** Runs `sql` in a transaction that is always rolled back; resolves to the error message, or null. */
  async function ddl(sql: string): Promise<string | null> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL lock_timeout = '5s'`)
      await c.query(sql)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
  }

  it('every column each capture lists is on its table, and every body compiles and runs', async () => {
    const cols = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [LEDGER_CAPTURE_TABLES as readonly string[]])
    const have = new Set(cols.rows.map(r => `${r.table_name}.${r.column_name}`))
    const missing = LEDGER_CAPTURE_TABLES.flatMap(t => (LEDGER_CAPTURE_COLUMNS[t] as readonly string[]).filter(c => !have.has(`${t}.${c}`)).map(c => `${t}.${c}`))
    expect(missing).toEqual([])
    await db.query(`SELECT ledger_check_capture()`)
  })

  it('the DDL guard is installed, on ALTER TABLE and DROP TABLE', async () => {
    const r = await db.query(`SELECT evtevent, evtenabled, evttags FROM pg_event_trigger WHERE evtname = 'ledger_ddl_guard'`)
    expect(r.rows).toEqual([{ evtevent: 'ddl_command_end', evtenabled: 'O', evttags: ['ALTER TABLE', 'DROP TABLE'] }])
  })

  it('a migration that drops or renames what a capture body names is refused in that migration, never in a money write', async () => {
    // A column a table's own capture lists.
    expect(await ddl(`ALTER TABLE remittance_applications DROP COLUMN amount_applied`)).toMatch(/books capture on remittance_applications reads column\(s\) \{amount_applied\}/)
    expect(await ddl(`ALTER TABLE payments RENAME COLUMN amount TO amount_old`)).toMatch(/books capture on payments reads column\(s\) \{amount\}/)
    // A key column another table's capture reads (payments' and bank_deposit_allocations' keys read it).
    expect(await ddl(`ALTER TABLE remittance_applications RENAME COLUMN payment_id TO pid`)).toMatch(/books capture/)
    // A table a capture body reads.
    expect(await ddl(`DROP TABLE remittance_applications CASCADE`)).toMatch(/removes or renames table\(s\) \{remittance_applications\}/)
    expect(await ddl(`ALTER TABLE leases RENAME TO leases_old`)).toMatch(/removes or renames table\(s\) \{leases\}/)
    expect(await ddl(`ALTER TABLE ledger_outbox DROP COLUMN owner_id`)).toMatch(/books capture/)
    // What the money tables still allow: adding to them, and anything on a table no capture reads.
    expect(await ddl(`ALTER TABLE payments ADD COLUMN ledger_guard_probe integer`)).toBeNull()
    expect(await ddl(`ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_stripe_event_id_key`)).toBeNull()
    expect(await ddl(`ALTER TABLE platform_owner DISABLE TRIGGER trg_protect_platform_owner_row`)).toBeNull()
    // And a money write after all of it still goes through.
    const co = await ledgerCompany()
    await addOtherIncome(co, { amount: 3, day: '2026-09-01' })
    expect(await outboxCount('other_income')).toBe(1)
  })

  it('re-installing a capture (a later phase widening its list) never takes more than a write\'s lock on a live money table', async () => {
    const before = await db.query<{ oid: number; tgname: string }>(
      `SELECT oid::int AS oid, tgname FROM pg_trigger WHERE tgrelid = 'payments'::regclass AND tgname LIKE 'ledger_capture_%' ORDER BY tgname`)
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SELECT ledger_install_capture('payments', $1::text[], $2)`, [
        LEDGER_CAPTURE_COLUMNS.payments,
        `SELECT 'payment'::text, r.id::text, r.landlord_id`])
      const locks = await c.query<{ mode: string }>(
        `SELECT DISTINCT mode FROM pg_locks WHERE relation = 'payments'::regclass AND pid = pg_backend_pid() ORDER BY mode`)
      expect(locks.rows.map(r => r.mode)).toEqual(['AccessShareLock', 'RowExclusiveLock'])
      const after = await c.query<{ oid: number; tgname: string }>(
        `SELECT oid::int AS oid, tgname FROM pg_trigger WHERE tgrelid = 'payments'::regclass AND tgname LIKE 'ledger_capture_%' ORDER BY tgname`)
      expect(after.rows).toEqual(before.rows)   // the same triggers: nothing dropped, nothing re-created
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
  })

  it('the migration locks every table it triggers in one NOWAIT statement, then installs the settle path last and payments very last', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/20261013200600_ledger_outbox_capture.sql'), 'utf8')
    const plan = [...sql.matchAll(/^ {2}\((\d+), '([a-z_]+)',$/gm)].map(m => ({ ord: Number(m[1]), table: m[2] }))
    // 10/12 (Nic, ledger P6): a money table made after this migration (the
    // expense payments, the loan register, the fixed assets) is captured by a
    // later one — a new table has no writer yet, so there is nothing to lock first.
    const dir = path.join(__dirname, '../db/migrations')
    const madeLater = fs.readdirSync(dir).filter(f => f > '20261013200600_ledger_outbox_capture.sql' && f.endsWith('.sql'))
      .flatMap(f => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(m => m[1]))
    expect(plan.map(p => p.table).sort()).toEqual([...LEDGER_CAPTURE_TABLES].filter(t => !madeLater.includes(t)).sort())
    expect(plan.map(p => p.ord)).toEqual(plan.map((_, i) => i + 1))
    expect(plan.slice(-9).map(p => p.table)).toEqual([
      'allocation_splits', 'payment_reversals', 'held_payout_items', 'platform_transfer_intents',
      'disbursements', 'credit_uses', 'remittance_applications', 'tenant_remittances', 'payments'])
    expect(sql).toMatch(/LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE NOWAIT/)
    expect(sql).toMatch(/UNION ALL SELECT 1000000, 'landlords'/)
    // (statements only; the comments explain why there is none)
    expect(sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')).not.toMatch(/DROP TRIGGER/)
  })
})
