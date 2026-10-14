/**
 * 10/12 (Nic) — GAM Books ledger, phase P6: money out is one record, and it
 * posts itself (gam-ledger-design-2026-10-12 §6 I, §12; Nic's 10/12 answers
 * L5, L6, L18). Real tables, real capture triggers, the real engine with the
 * production projector set (it commits on its own connections, so every test
 * starts from a clean database).
 *
 *   L5: "those all sound like real expenses. just let bookkeeper/landlord
 *        create custom labels or categories to charge things off to."
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { cleanupAllSchema } from '../../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../../test/ledgerFixtures'
import { active, balance, received, waiting } from '../../test/ledgerP5Fixtures'
import { drainLedgerOutbox } from '../ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../ledgerProjectors'
import { accountsPayableCheck } from './moneyOutChecks'
import {
  createLandlordExpense, createMoneyOutExpense, recordExpensePayment, landlordExpensesTotal, voidLandlordExpense,
} from '../landlordExpenses'
import { createCategory, updateCategory, resolveCategory, listCategories } from '../booksCategories'
import { matchLineToExpenses, matchLineToRecord, unmatchMoneyOut } from '../bankMoneyOut'
import { categorizeTransaction } from '../bankFeed'
import { liveExpenseSql } from '../../lib/liveExpense'
import { rebuildOwner } from '../ledgerRebuild'

beforeEach(async () => {
  await cleanupAllSchema()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

const brief = (ls: Awaited<ReturnType<typeof active>>) => ls.map(l => [l.role, l.dr, l.cr])
const tagged = (ls: Awaited<ReturnType<typeof active>>) => ls.map(l => [l.role, l.dr, l.cr, l.cash, l.cat])

async function company(o: { costs?: 'company_bucket' | 'split_by_units' | null } = {}): Promise<LedgerCompany & { connectionId: string }> {
  const co = await ledgerCompany()
  if (o.costs !== null) await db.query(`UPDATE landlords SET books_company_costs_method = $2 WHERE id = $1`, [co.landlordId, o.costs ?? 'company_bucket'])
  const connectionId = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
    [co.landlordId])).rows[0].id
  return { ...co, connectionId }
}

async function line(co: { landlordId: string; connectionId: string }, amount: number, day = '2026-10-05', connectionId?: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
     VALUES ($1, $2, $3, $4, $5, 'ACME PLUMBING', 'ACME PLUMBING', 'needs_review', 'posted') RETURNING id`,
    [connectionId ?? co.connectionId, co.landlordId, randomUUID(), day, amount.toFixed(2)])).rows[0].id
}

async function paymentsOf(expenseId: string) {
  return (await db.query<{ id: string; method: string; amount: string; source: string; bank_transaction_id: string | null; voided_at: string | null }>(
    `SELECT id, method, amount::text AS amount, source, bank_transaction_id, voided_at FROM landlord_expense_payments
      WHERE expense_id = $1 ORDER BY created_at, id`, [expenseId])).rows
}

describe('I1/I2: an expense and how it was paid', () => {
  it('a repair paid in cash from the office: Repairs (its category) / Accounts payable, then Accounts payable / the drawer — a cash line that is a cost', async () => {
    const co = await company()
    const e = await createLandlordExpense({
      landlordId: co.landlordId, propertyId: co.propertyId, category: 'repairs', amount: 125, expenseDate: '2026-10-03',
      payment: { method: 'cash' },
    })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(brief(await active('expense', e.id))).toEqual([['repairs_maintenance', 125, 0], ['accounts_payable', 0, 125]])
    const [p] = await paymentsOf(e.id)
    expect(p).toMatchObject({ method: 'cash', source: 'payment', amount: '125.00' })
    expect(tagged(await active('expense_payment', p.id))).toEqual([
      ['accounts_payable', 125, 0, 'out', 'repairs'],
      ['undeposited_funds', 0, 125, null, null],
    ])
    const kind = (await db.query<{ k: string }>(
      `SELECT l.expense_kind AS k FROM ledger_posting_lines l JOIN ledger_postings x ON x.id = l.posting_id
        WHERE x.source_type = 'expense_payment' AND x.source_id = $1 AND l.cash_effect = 'out'`, [p.id])).rows[0].k
    expect(kind).toBe('expense')
    const c = await db.connect()
    try { expect(await accountsPayableCheck.run(c, co.owner)).toEqual([]) } finally { c.release() }
  })

  it('a bill is an unpaid expense: owed until paid, partly paid, then paid — Accounts payable ties every step', async () => {
    const co = await company()
    const bill = await createLandlordExpense({
      landlordId: co.landlordId, propertyId: co.propertyId, category: 'utilities', amount: 300, expenseDate: '2026-10-01',
      dueDate: '2026-10-20', billNumber: 'INV-77', payment: null,
    })
    await drainLedgerOutbox()
    expect(await balance(co.landlordId, 'accounts_payable')).toBe(-300)
    const c = await db.connect()
    try {
      expect(await accountsPayableCheck.run(c, co.owner)).toEqual([])
      await recordExpensePayment({ landlordId: co.landlordId, expenseId: bill.id, method: 'check', amount: 100, paidOn: '2026-10-10', createdBy: null })
      await drainLedgerOutbox()
      expect(await balance(co.landlordId, 'accounts_payable')).toBe(-200)
      expect(await balance(co.landlordId, 'outstanding_checks')).toBe(-100)
      expect(await accountsPayableCheck.run(c, co.owner)).toEqual([])
      // More than is owed is refused.
      await expect(recordExpensePayment({ landlordId: co.landlordId, expenseId: bill.id, method: 'cash', amount: 250, createdBy: null }))
        .rejects.toMatchObject({ statusCode: 409 })
      await recordExpensePayment({ landlordId: co.landlordId, expenseId: bill.id, method: 'owner_paid', createdBy: null })
      await drainLedgerOutbox()
      expect(await balance(co.landlordId, 'accounts_payable')).toBe(0)
      expect(await balance(co.landlordId, 'owner_equity')).toBe(-200)
      expect(await accountsPayableCheck.run(c, co.owner)).toEqual([])
    } finally { c.release() }
  })

  it('an owner draw is real money out but never a cost: its category is on equity, the P&L leaves it out, its cash line is kind equity', async () => {
    const co = await company()
    // 10/13 review: an owner draw is not a cost — never split; put on the company (no place), it posts at company level.
    const draw = await createLandlordExpense({
      landlordId: co.landlordId, category: 'owner_draw', amount: 1000, expenseDate: '2026-10-02',
      payment: { method: 'bank', bankConnectionId: co.connectionId },
    })
    const repair = await createLandlordExpense({
      landlordId: co.landlordId, propertyId: co.propertyId, category: 'repairs', amount: 40, expenseDate: '2026-10-02',
    })
    await drainLedgerOutbox()
    expect(brief(await active('expense', draw.id))).toEqual([['owner_draws', 1000, 0], ['accounts_payable', 0, 1000]])
    const [p] = await paymentsOf(draw.id)
    const k = (await db.query<{ k: string; cash: string }>(
      `SELECT l.expense_kind AS k, l.cash_effect AS cash FROM ledger_posting_lines l JOIN ledger_postings x ON x.id = l.posting_id
        WHERE x.source_type = 'expense_payment' AND x.source_id = $1 AND l.account_role = 'accounts_payable'`, [p.id])).rows[0]
    expect(k).toEqual({ k: 'equity', cash: 'out' })
    // The older P&L readers count only the repair (lib/liveExpense).
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(40)
    const live = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM landlord_expenses e WHERE e.landlord_id = $1 AND ${liveExpenseSql('e')}`, [co.landlordId])).rows[0].n
    expect(live).toBe(1)
    expect(repair.category_id).toBeTruthy()
  })

  // 10/13 (Nic): "each expense is chosen on the split or specific unit or
  // property at the time of logging. there should never be a default setting
  // to apply expenses."
  it('a cost on no property: split by units when the person logging it said so; one logged before 10/13 stays in the Company column', async () => {
    const co = await company({ costs: null })
    // Logged before 10/13 with no place (as an expense was then): the Company column.
    const e = await createLandlordExpense({ landlordId: co.landlordId, category: 'software', amount: 49, expenseDate: '2026-10-04', systemBill: true })
    expect(e.cost_place).toBeNull()
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await waiting('expense', e.id)).toBeNull()
    expect((await active('expense', e.id)).map(l => [l.role, l.property, l.dr, l.cr]))
      .toEqual([['software_subscriptions', null, 49, 0], ['accounts_payable', null, 0, 49]])
    await db.query(`UPDATE units SET created_at = '2026-01-01' WHERE landlord_id = $1`, [co.landlordId])
    // The retired setting decides nothing: it stays there, re-posted or rebuilt.
    await db.query(`UPDATE landlords SET books_company_costs_method = 'split_by_units', books_company_costs_from = now() WHERE id = $1`, [co.landlordId])
    await db.query(`UPDATE landlord_expenses SET amount = 50 WHERE id = $1`, [e.id])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect((await active('expense', e.id)).map(l => [l.role, l.property, l.dr, l.cr]))
      .toEqual([['software_subscriptions', null, 50, 0], ['accounts_payable', null, 0, 50]])
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
    // Nothing chosen is refused; said "split": split across the properties by units.
    await expect(createLandlordExpense({ landlordId: co.landlordId, category: 'software', amount: 49, expenseDate: '2026-10-04' }))
      .rejects.toThrow(/Choose where this cost goes/)
    const later = await createLandlordExpense({
      landlordId: co.landlordId, category: 'software', amount: 49, expenseDate: '2026-10-04', costPlace: 'split_by_units' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const cost = (await active('expense', later.id)).filter(l => l.role === 'software_subscriptions')
    expect(cost.every(l => l.property !== null)).toBe(true)
    expect(cost.reduce((s, l) => s + l.dr, 0)).toBe(49)
  })

  it('voiding a hand-logged expense voids its payments with it (kept on record), and both postings are taken back', async () => {
    const co = await company()
    const e = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'supplies', amount: 20, expenseDate: '2026-10-06' })
    await drainLedgerOutbox()
    const [p] = await paymentsOf(e.id)
    expect(p.method).toBe('other')
    await voidLandlordExpense(e.id, co.landlordId)
    await drainLedgerOutbox()
    expect((await paymentsOf(e.id))[0].voided_at).not.toBeNull()
    expect(await active('expense', e.id)).toEqual([])
    expect(await active('expense_payment', p.id)).toEqual([])
    expect(await balance(co.landlordId, 'suspense')).toBe(0)
  })
})

describe('L5: the company\'s own categories', () => {
  it('a category the company makes and points at an account of its own chart charges there; pointing it again moves postings from today on', async () => {
    const co = await company()
    // The chart exists once anything has posted.
    await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'repairs', amount: 1, expenseDate: '2026-10-01' })
    await drainLedgerOutbox()
    const acct = (await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '5045', 'Septic pumping', 'expense') RETURNING id`, [co.landlordId])).rows[0].id
    const catId = await createCategory({ landlordId: co.landlordId, direction: 'expense', name: 'Septic', accountId: acct, actorUserId: null })
    const e = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, categoryId: catId, amount: 380, expenseDate: '2026-10-07', payment: null })
    await drainLedgerOutbox()
    const lines = (await db.query<{ account_id: string; map_kind: string; role: string | null }>(
      `SELECT l.account_id, l.map_kind, l.account_role AS role FROM ledger_posting_lines l JOIN ledger_postings x ON x.id = l.posting_id
        WHERE x.source_type = 'expense' AND x.source_id = $1 AND x.superseded_at IS NULL AND x.role = 'post' AND l.debit > 0`, [e.id])).rows
    expect(lines).toEqual([{ account_id: acct, map_kind: 'expense_category', role: null }])
    // The old reports read it as 'other' (its own name is on the category).
    expect((await db.query(`SELECT category FROM landlord_expenses WHERE id = $1`, [e.id])).rows[0].category).toBe('other')
    // A control account is refused.
    const ar = (await db.query<{ account_id: string }>(
      `SELECT account_id FROM books_account_map WHERE landlord_id = $1 AND map_kind = 'role' AND map_value = 'ar_tenants'`, [co.landlordId])).rows[0].account_id
    await expect(updateCategory({ landlordId: co.landlordId, id: catId, accountId: ar, actorUserId: null })).rejects.toMatchObject({ statusCode: 409 })
    // A name the company already uses is refused; archiving keeps it off the picker.
    await expect(createCategory({ landlordId: co.landlordId, direction: 'expense', name: ' septic ', actorUserId: null })).rejects.toMatchObject({ statusCode: 409 })
    await updateCategory({ landlordId: co.landlordId, id: catId, archived: true, actorUserId: null })
    await expect(resolveCategory(db as any, co.landlordId, 'expense', { categoryId: catId })).rejects.toMatchObject({ statusCode: 409 })
    const list = await listCategories([co.landlordId], { direction: 'expense', includeArchived: true })
    expect(list.find(c => c.id === catId)).toMatchObject({ archived: true, inPicker: false, onProfitAndLoss: true, accountName: 'Septic pumping' })
    expect(list.find(c => c.systemKey === 'payroll_take_home')).toMatchObject({ inPicker: false, onProfitAndLoss: false })
  })

  it('10/12 review: pointing a category that posted keeps EVERY earlier account of its starting role (a role repointed before), through a rebuild', async () => {
    const co = await company()
    await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'repairs', amount: 1, expenseDate: '2026-10-01' })
    await drainLedgerOutbox()
    const r1 = (await db.query<{ account_id: string }>(
      `SELECT account_id FROM books_account_map WHERE landlord_id = $1 AND map_kind = 'role' AND map_value = 'repairs_maintenance'`,
      [co.landlordId])).rows[0].account_id
    const mk = async (code: string, name: string) => (await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, $2, $3, 'expense') RETURNING id`, [co.landlordId, code, name])).rows[0].id
    const r2 = await mk('5031', 'Repairs (new)')
    const r3 = await mk('5032', 'Repairs (outside crews)')
    // The role was repointed on 10/5: earlier repairs post to r1, later ones to r2.
    await db.query(`INSERT INTO books_account_map (landlord_id, map_kind, map_value, account_id, effective_from)
                    VALUES ($1, 'role', 'repairs_maintenance', $2, '2026-10-05')`, [co.landlordId, r2])
    const before = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'repairs', amount: 40, expenseDate: '2026-10-02' })
    const after = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'repairs', amount: 70, expenseDate: '2026-10-06' })
    await drainLedgerOutbox()
    const repairs = (await resolveCategory(db as any, co.landlordId, 'expense', { key: 'repairs' })).id
    await updateCategory({ landlordId: co.landlordId, id: repairs, accountId: r3, actorUserId: null })
    await drainLedgerOutbox()
    expect(await rebuildOwner(co.owner, { mode: 'from_scratch' })).toMatchObject({ status: 'done', counts: { failed: 0 } })
    const debitAccount = async (id: string) => (await db.query<{ account_id: string }>(
      `SELECT l.account_id FROM ledger_posting_lines l JOIN ledger_postings x ON x.id = l.posting_id
        WHERE x.source_type = 'expense' AND x.source_id = $1 AND x.role = 'post' AND x.superseded_at IS NULL AND l.debit > 0`, [id])).rows[0].account_id
    expect(await debitAccount(before.id)).toBe(r1)
    expect(await debitAccount(after.id)).toBe(r2)
  })

  it('pointing an equity category at an expense account puts its money on the P&L from then on', async () => {
    const co = await company()
    const catId = await createCategory({ landlordId: co.landlordId, direction: 'expense', name: 'Truck', actorUserId: null })
    const e = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, categoryId: catId, amount: 60, expenseDate: '2026-10-08' })
    await drainLedgerOutbox()
    // Made without an account: Other expenses.
    expect(brief(await active('expense', e.id))).toEqual([['other_expenses', 60, 0], ['accounts_payable', 0, 60]])
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(60)
  })
})

describe('§12: a bank line going out matches what is already on record first', () => {
  it('a bank line filed as a new expense is paid by that line (its own bank sub-account), on the bank\'s day', async () => {
    const co = await company()
    const t = await line(co, -82.5)
    const { expenseId } = await categorizeTransaction(co.landlordId, t, { category: 'utilities', scopeKind: 'property_common', propertyId: co.propertyId })
    await drainLedgerOutbox()
    const [p] = await paymentsOf(expenseId!)
    expect(p).toMatchObject({ method: 'bank', source: 'bank_match', bank_transaction_id: t })
    const ls = await active('expense_payment', p.id)
    expect(brief(ls)).toEqual([['accounts_payable', 82.5, 0], ['bank_checking', 0, 82.5]])
    expect(ls[0].day).toBe('2026-10-05')
  })

  it('one bank line pays two bills; undoing the match voids its payments and the bills are owed again', async () => {
    const co = await company()
    const a = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'utilities', amount: 60, expenseDate: '2026-10-02', payment: null })
    const b = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'landscaping', amount: 40, expenseDate: '2026-10-03', payment: null })
    const t = await line(co, -100)
    // Expenses that do not add up to the line are refused (one alone may be paid in part).
    const c3 = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'supplies', amount: 10, expenseDate: '2026-10-03', payment: null })
    await expect(matchLineToExpenses({ landlordId: co.landlordId, lineId: t, expenseIds: [a.id, c3.id], by: null }))
      .rejects.toMatchObject({ statusCode: 409 })
    await expect(matchLineToExpenses({ landlordId: co.landlordId, lineId: t, expenseIds: [a.id, b.id, randomUUID()], by: null }))
      .rejects.toMatchObject({ statusCode: 404 })
    await voidLandlordExpense(c3.id, co.landlordId)
    await matchLineToExpenses({ landlordId: co.landlordId, lineId: t, expenseIds: [a.id, b.id], by: null })
    await drainLedgerOutbox()
    expect(await balance(co.landlordId, 'accounts_payable')).toBe(0)
    expect((await db.query(`SELECT status, matched_kind FROM bank_transactions WHERE id = $1`, [t])).rows[0])
      .toEqual({ status: 'matched', matched_kind: 'expenses' })
    // A second payment past the line is refused by the database's sum guard.
    await expect(inTx(c => c.query(
      `INSERT INTO landlord_expense_payments (expense_id, landlord_id, paid_on, amount, method, bank_connection_id, bank_transaction_id, source)
       VALUES ($1, $2, '2026-10-05', 1, 'bank', $3, $4, 'bank_match')`, [a.id, co.landlordId, co.connectionId, t])))
      .rejects.toThrow()
    await unmatchMoneyOut(co.landlordId, t)
    await drainLedgerOutbox()
    expect(await balance(co.landlordId, 'accounts_payable')).toBe(-100)
    expect((await db.query(`SELECT status, matched_kind FROM bank_transactions WHERE id = $1`, [t])).rows[0])
      .toEqual({ status: 'needs_review', matched_kind: null })
    expect((await paymentsOf(a.id)).every(p => p.voided_at)).toBe(true)
  })

  it('a check written and recorded by hand clears when its bank line arrives: Outstanding checks, then the bank on the bank\'s day', async () => {
    const co = await company()
    const e = await createLandlordExpense({ landlordId: co.landlordId, propertyId: co.propertyId, category: 'repairs', amount: 250, expenseDate: '2026-10-01',
      payment: { method: 'check', paidOn: '2026-10-01' } })
    const [p] = await paymentsOf(e.id)
    const t = await line(co, -250, '2026-10-09')
    await matchLineToExpenses({ landlordId: co.landlordId, lineId: t, paymentIds: [p.id], by: null })
    await drainLedgerOutbox()
    expect((await waiting('expense_payment', p.id))?.last_error ?? null).toBeNull()
    const ls = await active('expense_payment', p.id)
    expect(ls.map(l => [l.kind, l.day, l.role, l.dr, l.cr])).toEqual([
      ['bank_clear', '2026-10-09', 'outstanding_checks', 250, 0],
      ['bank_clear', '2026-10-09', 'bank_checking', 0, 250],
      ['main', '2026-10-01', 'accounts_payable', 250, 0],
      ['main', '2026-10-01', 'outstanding_checks', 0, 250],
    ])
    expect(await balance(co.landlordId, 'outstanding_checks')).toBe(0)
  })

  it('GAM\'s fee debit: the bank line clears Outstanding checks property by property; never an expense', async () => {
    const co = await company()
    const charge = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type) VALUES ($1, $2, 'subscription', 30, 'test') RETURNING id`,
      [co.landlordId, co.propertyId])).rows[0].id
    const debit = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, charge_ids, settled_at)
       VALUES ($1, 30, 0, 30, 'succeeded', ARRAY[$2::uuid], '2026-10-04 18:00:00+00') RETURNING id`, [co.landlordId, charge])).rows[0].id
    await db.query(
      `INSERT INTO landlord_gam_charge_collections (charge_id, landlord_gam_debit_id, amount, collected_at) VALUES ($1, $2, 30, '2026-10-04 18:00:00+00')`,
      [charge, debit])
    const t = await line(co, -30, '2026-10-06')
    await matchLineToRecord({ landlordId: co.landlordId, lineId: t, kind: 'gam_debit', recordId: debit, by: null })
    await drainLedgerOutbox()
    expect((await active('bank_match', t)).map(l => [l.role, l.property, l.dr, l.cr])).toEqual([
      ['outstanding_checks', co.propertyId, 30, 0], ['bank_checking', co.propertyId, 0, 30],
    ])
    expect(await balance(co.landlordId, 'outstanding_checks')).toBe(0)
    expect((await db.query(`SELECT count(*)::int AS n FROM landlord_expenses WHERE landlord_id = $1`, [co.landlordId])).rows[0].n).toBe(0)
  })

  it('a transfer between two linked accounts: the line going out posts it, the line arriving posts nothing', async () => {
    const co = await company()
    const savings = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Savings') RETURNING id`,
      [co.landlordId])).rows[0].id
    const out = await line(co, -500, '2026-10-05')
    const arrived = await line(co, 500, '2026-10-06', savings)
    await matchLineToRecord({ landlordId: co.landlordId, lineId: out, kind: 'transfer', recordId: arrived, by: null })
    await drainLedgerOutbox()
    expect(brief(await active('bank_match', out))).toEqual([['bank_checking', 500, 0], ['bank_checking', 0, 500]])
    expect(await active('bank_match', arrived)).toEqual([])
    await unmatchMoneyOut(co.landlordId, arrived)
    expect((await db.query(`SELECT count(*)::int AS n FROM bank_transactions WHERE id IN ($1, $2) AND status = 'needs_review'`, [out, arrived])).rows[0].n).toBe(2)
  })
})

describe('I4: money in filed as other income', () => {
  it('a deposit filed as laundry: the bank line\'s own account / Laundry and vending, Received; an owner contribution is not income', async () => {
    const co = await company()
    const t = await line(co, 75)
    const { incomeId } = await categorizeTransaction(co.landlordId, t, { category: 'laundry', scopeKind: 'property_common', propertyId: co.propertyId })
    const t2 = await line(co, 2000, '2026-10-07')
    const own = await categorizeTransaction(co.landlordId, t2, { category: 'owner_contribution', scopeKind: 'property_common', propertyId: co.propertyId })
    await drainLedgerOutbox()
    expect(tagged(await active('other_income', incomeId!))).toEqual([
      ['bank_checking', 75, 0, null, null], ['laundry_vending', 0, 75, 'in', 'other_income'],
    ])
    expect(tagged(await active('other_income', own.incomeId!))).toEqual([
      ['bank_checking', 2000, 0, null, null], ['owner_equity', 0, 2000, 'in', 'not_income'],
    ])
    expect(await received(co.landlordId, '2026-10-01', '2026-10-31')).toBe(2075)
  })
})

describe('what other features leave owed', () => {
  it('a payroll run\'s take-home pay moves Net pay payable to Accounts payable (P7\'s link), never a cost here', async () => {
    const co = await company()
    const made = await inTx(c => createMoneyOutExpense(c, {
      landlordId: co.landlordId, categoryKey: 'payroll_take_home', amount: 812.4, expenseDate: '2026-10-10', dueDate: '2026-10-10',
      description: 'Take-home pay: Pat', createdBy: null,
    }))
    const hasLink = (await db.query(`SELECT to_regclass('public.payroll_run_expenses') IS NOT NULL AS ok`)).rows[0].ok
    await drainLedgerOutbox()
    // Without the run link, its category (Net pay payable) carries it the same way.
    expect(brief(await active('expense', made.id))).toEqual([['net_pay_payable', 812.4, 0], ['accounts_payable', 0, 812.4]])
    expect(hasLink).toBe(true)
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(0)
  })

  it('Nic L18: the manager\'s cut GAM held too little to pay is a bill on Expenses; its cost is the split\'s, its payments clear Accounts payable', async () => {
    const co = await company()
    const split = (await db.query<{ id: string }>(
      `INSERT INTO allocation_splits (payment_id, landlord_id, property_id, gross_held, landlord_fee_withheld, supersedence,
                                      pm_fee_due, pm_paid, manager_fee_due, manager_paid, short_by, owner_share, created_at)
       VALUES ($1, $2, $3, 20, 0, 0, 0, 0, 25, 20, 5, 0, '2026-10-02 18:00:00+00') RETURNING id`,
      [randomUUID(), co.landlordId, co.propertyId])).rows[0].id
    const bill = await inTx(c => createMoneyOutExpense(c, {
      landlordId: co.landlordId, categoryKey: 'management', amount: 5, expenseDate: '2026-10-02', propertyId: co.propertyId,
      allocationSplitId: split, description: 'Management fee GAM held too little to pay',
    }))
    await drainLedgerOutbox()
    expect(await active('expense', bill.id)).toEqual([])
    expect(await balance(co.landlordId, 'accounts_payable')).toBe(-5)
    await recordExpensePayment({ landlordId: co.landlordId, expenseId: bill.id, method: 'bank', createdBy: null })
    await drainLedgerOutbox()
    expect(await balance(co.landlordId, 'accounts_payable')).toBe(0)
    const c = await db.connect()
    try { expect(await accountsPayableCheck.run(c, co.owner)).toEqual([]) } finally { c.release() }
    expect(await landlordExpensesTotal(co.landlordId, '2026-10-01', '2026-10-31')).toBe(0)
  })
})
