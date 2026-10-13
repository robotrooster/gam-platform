/**
 * 10/12 (Nic) — GAM Books, phase P6: money out becomes one record, and the
 * migration window is safe.
 *
 *   20261014180100  an expense written by an older writer (payments_tracked
 *                   FALSE) is paid in full the day it was logged; when the old
 *                   bank-feed filing then points its line at it, that payment
 *                   moves onto the line; a voided expense voids its payments
 *   20261014180300  a landlord's old Books bills and transactions move onto
 *                   Expenses / other income with their payments, each pointing
 *                   both ways; a business's stay; running it again moves nothing
 *
 * 10/12 review: an older writer's edit keeps "logged = paid" (the payment
 * follows the amount and day); the move picks a category by the account the
 * old row was booked to first; and in the window the old pages' new rows,
 * bill payments, edits and removals reach Expenses at once (the triggers).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

beforeEach(async () => { await cleanupAllSchema() })

async function landlord(): Promise<{ landlordId: string; connectionId: string; vendorId: string }> {
  const c = await db.connect()
  try {
    const { landlordId } = await seedLandlord(c)
    const connectionId = (await c.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1, 'stripe_fc', 'active') RETURNING id`, [landlordId])).rows[0].id
    const vendorId = (await c.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name) VALUES ($1, 'Desert Waste') RETURNING id`, [landlordId])).rows[0].id
    return { landlordId, connectionId, vendorId }
  } finally { c.release() }
}

describe('the migration window (20261014180100)', () => {
  it('an older writer\'s expense is paid the day it was logged; its bank filing moves the payment onto the line', async () => {
    const co = await landlord()
    const e = (await db.query<{ id: string; category_id: string | null }>(
      `INSERT INTO landlord_expenses (landlord_id, category, amount, expense_date) VALUES ($1, 'repairs', 75, '2026-10-03') RETURNING id, category_id`,
      [co.landlordId])).rows[0]
    expect(e.category_id).toBeTruthy()   // the company's Repairs, seeded on the way
    let p = (await db.query(`SELECT method, amount::text AS amount, source, paid_on::text AS paid_on, bank_transaction_id FROM landlord_expense_payments WHERE expense_id = $1`, [e.id])).rows
    expect(p).toEqual([{ method: 'other', amount: '75.00', source: 'migrated', paid_on: '2026-10-03', bank_transaction_id: null }])
    const line = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
       VALUES ($1, $2, $3, '2026-10-04', -75, 'needs_review') RETURNING id`, [co.connectionId, co.landlordId, randomUUID()])).rows[0].id
    await db.query(`UPDATE bank_transactions SET status = 'categorized', expense_id = $2 WHERE id = $1`, [line, e.id])
    p = (await db.query(`SELECT method, paid_on::text AS paid_on, bank_transaction_id FROM landlord_expense_payments WHERE expense_id = $1`, [e.id])).rows
    expect(p).toEqual([{ method: 'bank', paid_on: '2026-10-04', bank_transaction_id: line }])
    await db.query(`UPDATE landlord_expenses SET status = 'voided', voided_at = now() WHERE id = $1`, [e.id])
    expect((await db.query(`SELECT voided_at IS NOT NULL AS v FROM landlord_expense_payments WHERE expense_id = $1`, [e.id])).rows[0].v).toBe(true)
    // A payment is never removed.
    await expect(db.query(`DELETE FROM landlord_expense_payments WHERE expense_id = $1`, [e.id])).rejects.toThrow(/never removed/)
  })

  it('10/12 review: an older writer correcting the amount or the day keeps it paid in full that day (lower, higher, moved)', async () => {
    const co = await landlord()
    const e = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, category, amount, expense_date) VALUES ($1, 'supplies', 100, '2026-10-03') RETURNING id`,
      [co.landlordId])).rows[0]
    const pay = async () => (await db.query(`SELECT amount::text AS amount, paid_on::text AS paid_on FROM landlord_expense_payments
                                              WHERE expense_id = $1 AND voided_at IS NULL`, [e.id])).rows
    // Lower: the deferred check would refuse the payment above the expense — the payment follows instead.
    await db.query(`UPDATE landlord_expenses SET amount = 60 WHERE id = $1`, [e.id])
    expect(await pay()).toEqual([{ amount: '60.00', paid_on: '2026-10-03' }])
    // Higher: no phantom unpaid remainder.
    await db.query(`UPDATE landlord_expenses SET amount = 140 WHERE id = $1`, [e.id])
    expect(await pay()).toEqual([{ amount: '140.00', paid_on: '2026-10-03' }])
    // The day moves with it.
    await db.query(`UPDATE landlord_expenses SET expense_date = '2026-10-05' WHERE id = $1`, [e.id])
    expect(await pay()).toEqual([{ amount: '140.00', paid_on: '2026-10-05' }])
  })
})

/** As before 20261014180300 ran: the window triggers off (re-running the file makes them again). */
async function beforeTheMove(): Promise<void> {
  await db.query(`DROP TRIGGER IF EXISTS books_bills_move ON books_bills;
                  DROP TRIGGER IF EXISTS books_bill_payments_move ON books_bill_payments;
                  DROP TRIGGER IF EXISTS books_transactions_move ON books_transactions;
                  DROP TRIGGER IF EXISTS books_transactions_removed_follows ON books_transactions`)
}
const moveSql = () => fs.readFileSync(path.join(__dirname, 'migrations/20261014180300_books_bills_transactions_move.sql'), 'utf8')

describe('the old Books bills and transactions move onto one record (20261014180300)', () => {
  it('moves a landlord\'s bills (with their payments, never more than the bill) and transactions, points both ways, leaves a business\'s, and moves nothing twice', async () => {
    await beforeTheMove()
    const co = await landlord()
    const bill = (await db.query<{ id: string }>(
      `INSERT INTO books_bills (landlord_id, vendor_id, bill_number, date, due_date, description, amount, amount_paid, status, category)
       VALUES ($1, $2, 'DW-9', '2026-09-01', '2026-09-15', 'Dumpster', 200, 200, 'paid', 'Utilities') RETURNING id`,
      [co.landlordId, co.vendorId])).rows[0].id
    await db.query(
      `INSERT INTO books_bill_payments (bill_id, landlord_id, paid_on, amount) VALUES ($1, $2, '2026-09-10', 150), ($1, $2, '2026-09-20', 120)`,
      [bill, co.landlordId])
    const out = (await db.query<{ id: string }>(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type, category) VALUES ($1, '2026-09-05', 'Paint', 42, 'expense', 'supplies') RETURNING id`,
      [co.landlordId])).rows[0].id
    const inc = (await db.query<{ id: string }>(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type, category) VALUES ($1, '2026-09-06', 'Coins', 30, 'income', 'Laundry') RETURNING id`,
      [co.landlordId])).rows[0].id
    const gone = (await db.query<{ id: string }>(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type, deleted_at) VALUES ($1, '2026-09-07', 'removed', 9, 'expense', now()) RETURNING id`,
      [co.landlordId])).rows[0].id
    const bizOwner = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1, 'x', 'business_owner', 'B', 'O') RETURNING id`,
      [`b-${randomUUID()}@t.dev`])).rows[0].id
    const biz = (await db.query<{ id: string }>(
      `INSERT INTO businesses (owner_user_id, name, business_type, email) VALUES ($1, 'Hauler', 'trash_hauling', 'h@t.dev') RETURNING id`, [bizOwner])).rows[0].id
    const bizBill = (await db.query<{ id: string }>(
      `INSERT INTO books_bills (business_id, date, description, amount) VALUES ($1, '2026-09-01', 'Fuel', 90) RETURNING id`, [biz])).rows[0].id

    const sql = fs.readFileSync(path.join(__dirname, 'migrations/20261014180300_books_bills_transactions_move.sql'), 'utf8')
    await db.query(sql)
    await db.query(sql)   // idempotent

    const e = (await db.query(
      `SELECT e.id, e.amount::text AS amount, e.bill_number, e.due_date::text AS due_date, e.vendor_id, e.vendor, c.system_key, e.payments_tracked
         FROM landlord_expenses e JOIN books_categories c ON c.id = e.category_id
        WHERE e.migrated_from_table = 'books_bills' AND e.migrated_from_id = $1`, [bill])).rows
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ amount: '200.00', bill_number: 'DW-9', due_date: '2026-09-15', vendor_id: co.vendorId,
      vendor: 'Desert Waste', system_key: 'utilities', payments_tracked: true })
    const pays = (await db.query(`SELECT paid_on::text AS paid_on, amount::text AS amount, method, source FROM landlord_expense_payments
                                   WHERE expense_id = $1 ORDER BY paid_on`, [e[0].id])).rows
    expect(pays).toEqual([
      { paid_on: '2026-09-10', amount: '150.00', method: 'other', source: 'migrated' },
      { paid_on: '2026-09-20', amount: '50.00', method: 'other', source: 'migrated' },
    ])
    expect((await db.query(`SELECT migrated_expense_id FROM books_bills WHERE id = $1`, [bill])).rows[0].migrated_expense_id).toBe(e[0].id)
    const x = (await db.query(`SELECT c.system_key, e.amount::text AS amount FROM landlord_expenses e JOIN books_categories c ON c.id = e.category_id
                                WHERE e.migrated_from_id = $1`, [out])).rows
    expect(x).toEqual([{ system_key: 'supplies', amount: '42.00' }])
    const oi = (await db.query(`SELECT o.category, o.amount::text AS amount, c.system_key FROM landlord_other_income o JOIN books_categories c ON c.id = o.category_id
                                 WHERE o.migrated_from_id = $1`, [inc])).rows
    expect(oi).toEqual([{ category: 'laundry', amount: '30.00', system_key: 'laundry' }])
    expect((await db.query(`SELECT migrated_at FROM books_transactions WHERE id = $1`, [gone])).rows[0].migrated_at).toBeNull()
    expect((await db.query(`SELECT migrated_at FROM books_bills WHERE id = $1`, [bizBill])).rows[0].migrated_at).toBeNull()
    expect((await db.query(`SELECT count(*)::int AS n FROM landlord_expenses WHERE landlord_id = $1`, [co.landlordId])).rows[0].n).toBe(2)
  })

  it('10/12 review: picks the category by the account the old row was booked to, before its word', async () => {
    await beforeTheMove()
    const co = await landlord()
    // The company's chart: Utilities' starting role points at an account of its own.
    await db.query(`SELECT books_seed_categories($1)`, [co.landlordId])
    const acct = (await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '5300', 'Utilities', 'expense') RETURNING id`,
      [co.landlordId])).rows[0].id
    await db.query(`INSERT INTO books_account_map (landlord_id, map_kind, map_value, account_id, effective_from)
                    VALUES ($1, 'role', 'utilities_expense', $2, '0001-01-01')`, [co.landlordId, acct])
    const bill = (await db.query<{ id: string }>(
      `INSERT INTO books_bills (landlord_id, date, description, amount, account_id) VALUES ($1, '2026-09-01', 'Power', 80, $2) RETURNING id`,
      [co.landlordId, acct])).rows[0].id
    await db.query(moveSql())
    expect((await db.query(`SELECT c.system_key FROM landlord_expenses e JOIN books_categories c ON c.id = e.category_id
                             WHERE e.migrated_from_id = $1`, [bill])).rows).toEqual([{ system_key: 'utilities' }])
  })

  it('10/12 review: in the window the old pages\' new rows, bill payments, edits and removals reach Expenses at once', async () => {
    const co = await landlord()
    // A bill added on the old page: moved at once, unpaid.
    const bill = (await db.query<{ id: string }>(
      `INSERT INTO books_bills (landlord_id, date, description, amount, category) VALUES ($1, '2026-10-01', 'Gravel', 300, 'supplies') RETURNING id`,
      [co.landlordId])).rows[0].id
    const be = (await db.query(`SELECT migrated_expense_id AS id FROM books_bills WHERE id = $1`, [bill])).rows[0].id
    expect(be).toBeTruthy()
    const paid = async (id: string) => (await db.query(`SELECT to_char(COALESCE(sum(amount), 0), 'FM999990.00') AS n FROM landlord_expense_payments
                                                         WHERE expense_id = $1 AND voided_at IS NULL`, [id])).rows[0].n
    expect(await paid(be)).toBe('0.00')
    // The old pay route moves amount_paid: that part is paid on Expenses too, never more than the bill.
    await db.query(`UPDATE books_bills SET amount_paid = 120, status = 'partial' WHERE id = $1`, [bill])
    expect(await paid(be)).toBe('120.00')
    await db.query(`UPDATE books_bills SET amount_paid = 300, status = 'paid', paid_at = now() WHERE id = $1`, [bill])
    expect(await paid(be)).toBe('300.00')
    await db.query(`UPDATE books_bills SET updated_at = now() WHERE id = $1`, [bill])
    expect(await paid(be)).toBe('300.00')
    // A transaction typed, then corrected, switched and removed.
    const t = (await db.query<{ id: string }>(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type, category) VALUES ($1, '2026-10-02', 'Paint', 40, 'expense', 'supplies') RETURNING id`,
      [co.landlordId])).rows[0].id
    const te = (await db.query(`SELECT migrated_expense_id AS id FROM books_transactions WHERE id = $1`, [t])).rows[0].id
    expect(te).toBeTruthy()
    await db.query(`UPDATE books_transactions SET amount = 55, date = '2026-10-04' WHERE id = $1`, [t])
    expect((await db.query(`SELECT amount::text AS amount, expense_date::text AS day FROM landlord_expenses WHERE id = $1`, [te])).rows[0])
      .toEqual({ amount: '55.00', day: '2026-10-04' })
    expect((await db.query(`SELECT amount::text AS amount, paid_on::text AS day FROM landlord_expense_payments WHERE expense_id = $1 AND voided_at IS NULL`, [te])).rows)
      .toEqual([{ amount: '55.00', day: '2026-10-04' }])
    await db.query(`UPDATE books_transactions SET type = 'income', category = 'laundry' WHERE id = $1`, [t])
    expect((await db.query(`SELECT status FROM landlord_expenses WHERE id = $1`, [te])).rows[0].status).toBe('voided')
    const ti = (await db.query(`SELECT migrated_expense_id, migrated_other_income_id FROM books_transactions WHERE id = $1`, [t])).rows[0]
    expect(ti.migrated_expense_id).toBeNull()
    expect((await db.query(`SELECT amount::text AS amount, status FROM landlord_other_income WHERE id = $1`, [ti.migrated_other_income_id])).rows[0])
      .toEqual({ amount: '55.00', status: 'active' })
    await db.query(`DELETE FROM books_transactions WHERE id = $1`, [t])
    expect((await db.query(`SELECT status FROM landlord_other_income WHERE id = $1`, [ti.migrated_other_income_id])).rows[0].status).toBe('voided')
  })
})
