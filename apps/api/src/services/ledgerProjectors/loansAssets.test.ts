/**
 * 10/12 (Nic) — GAM Books ledger: loans and fixed assets post themselves
 * (services/ledgerProjectors/loansAssets.ts).
 *
 *   Nic 10/12: "loans/mortgages (principal / interest / escrow per payment)
 *   and fixed assets with depreciation ARE IN THIS BUILD."
 *
 * Committed rows, the real capture triggers and the real engine (the engine
 * posts on its own connections): each test drains the outbox and reads back
 * what posted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { depreciationSchedule } from '@gam/shared'
import { db } from '../../db'
import { cleanupAllSchema } from '../../test/dbHelpers'
import { ledgerCompany, type LedgerCompany } from '../../test/ledgerFixtures'
import { active, balance, waiting, unregisterAll } from '../../test/ledgerP5Fixtures'
import { drainLedgerOutbox, registerLedgerProjector } from '../ledgerEngine'
import { rebuildOwner } from '../ledgerRebuild'
import { checkOwner } from '../ledgerCheck'
import { markDepreciationMonthsDue } from '../booksVendorsLoans'
import { LOANS_ASSETS_LEDGER_PROJECTORS, parseFixedAssetKey } from './loansAssets'
import { TENANT_LEDGER_PROJECTORS } from './tenantMoney'

beforeEach(async () => {
  await cleanupAllSchema()
  for (const p of LOANS_ASSETS_LEDGER_PROJECTORS) registerLedgerProjector(p)
})
afterEach(() => unregisterAll())

async function bank(co: LedgerCompany): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, institution_name, account_last4, display_name)
     VALUES ($1, 'csv', 'First Bank', '4321', 'Operating') RETURNING id`, [co.landlordId])).rows[0].id
}

async function loan(co: LedgerCompany, o: Record<string, unknown> = {}): Promise<string> {
  const v = {
    property_id: co.propertyId, name: 'Oak Street mortgage', lender_name: 'First Bank', original_amount: 200000,
    annual_rate: 6, start_date: '2026-03-01', payment_amount: 1500, escrow_amount: 100, funded_to: 'property',
    funded_bank_connection_id: null, opening_balance: null, opening_escrow: null, ...o,
  }
  return (await db.query<{ id: string }>(
    `INSERT INTO books_loans (landlord_id, property_id, name, lender_name, original_amount, annual_rate, start_date,
                              payment_amount, escrow_amount, funded_to, funded_bank_connection_id, opening_balance, opening_escrow)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [co.landlordId, v.property_id, v.name, v.lender_name, v.original_amount, v.annual_rate, v.start_date, v.payment_amount,
     v.escrow_amount, v.funded_to, v.funded_bank_connection_id, v.opening_balance, v.opening_escrow])).rows[0].id
}

async function payment(co: LedgerCompany, loanId: string, o: { paidOn: string; principal: number; interest: number; escrow: number;
  method?: string; bankConnectionId?: string | null }): Promise<string> {
  const amount = Math.round((o.principal + o.interest + o.escrow) * 100) / 100
  return (await db.query<{ id: string }>(
    `INSERT INTO books_loan_payments (loan_id, landlord_id, paid_on, amount, principal, interest, escrow, method, bank_connection_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [loanId, co.landlordId, o.paidOn, amount, o.principal, o.interest, o.escrow, o.method ?? 'bank', o.bankConnectionId ?? null])).rows[0].id
}

async function asset(co: LedgerCompany, o: Record<string, unknown> = {}): Promise<string> {
  const v = {
    property_id: co.propertyId, name: 'Clubhouse', asset_class: 'building', cost: 330000, salvage_value: 0,
    acquired_on: '2015-01-10', in_service_date: '2015-02-01', life_years: 27.5, prior_depreciation: null,
    source_expense_id: null, ...o,
  }
  return (await db.query<{ id: string }>(
    `INSERT INTO books_fixed_assets (landlord_id, property_id, name, asset_class, cost, salvage_value, acquired_on,
                                     in_service_date, life_years, prior_depreciation, source_expense_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [co.landlordId, v.property_id, v.name, v.asset_class, v.cost, v.salvage_value, v.acquired_on, v.in_service_date,
     v.life_years, v.prior_depreciation, v.source_expense_id])).rows[0].id
}

const today = async () => (await db.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'America/Phoenix')::date::text AS d`)).rows[0].d

describe('a loan', () => {
  it('made after the books start into a bank: the bank goes up, the loan is owed on its own account', async () => {
    const co = await ledgerCompany()
    const b = await bank(co)
    const id = await loan(co, { funded_to: 'bank', funded_bank_connection_id: b })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const lines = await active('loan', id)
    expect(lines.map(l => [l.day, l.role, l.dr, l.cr, l.property])).toEqual([
      ['2026-03-01', 'bank_checking', 200000, 0, co.propertyId],
      ['2026-03-01', 'mortgage_payable', 0, 200000, co.propertyId],
    ])
    // Its own sub-account, named for the loan, under Mortgage payable.
    const sub = (await db.query(
      `SELECT a.name, a.parent_account_id IS NOT NULL AS under, l.map_kind, l.map_value
         FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
        WHERE l.landlord_id = $1 AND l.account_role = 'mortgage_payable'`, [co.landlordId])).rows[0]
    expect(sub).toEqual({ name: 'Loan payable: Oak Street mortgage', under: true, map_kind: 'loan', map_value: id })
  })

  it('each payment: principal off the loan, interest an expense, escrow to the lender\'s escrow, money out of the bank', async () => {
    const co = await ledgerCompany()
    const b = await bank(co)
    const id = await loan(co)
    const p = await payment(co, id, { paidOn: '2026-04-01', principal: 400, interest: 1000, escrow: 100, bankConnectionId: b })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    // 10/12 review: money out is marked on the debits, by what each part paid
    // for (as an expense payment marks its debit); the bank credit is plain.
    expect((await active('loan_payment', p)).map(l => [l.role, l.dr, l.cr, l.cash, l.cat])).toEqual([
      ['mortgage_payable', 400, 0, 'out', null],
      ['mortgage_interest', 1000, 0, 'out', 'mortgage_interest'],
      ['loan_escrow', 100, 0, 'out', null],
      ['bank_checking', 0, 1500, null, null],
    ])
    expect((await db.query(
      `SELECT l.account_role AS role, l.expense_kind AS kind FROM ledger_posting_lines l JOIN ledger_postings x ON x.id = l.posting_id
        WHERE x.source_type = 'loan_payment' AND x.source_id = $1 AND x.role = 'post' AND x.superseded_at IS NULL AND l.cash_effect = 'out'
        ORDER BY l.account_role`, [p])).rows).toEqual([
      { role: 'loan_escrow', kind: 'asset' }, { role: 'mortgage_interest', kind: 'expense' }, { role: 'mortgage_payable', kind: 'liability' },
    ])
    expect(await balance(co.landlordId, 'mortgage_payable')).toBe(-199600)
    // A loan paid by card is owed to the card; the owner paying personally is money the owner put in.
    const card = await payment(co, id, { paidOn: '2026-05-01', principal: 500, interest: 0, escrow: 0, method: 'card' })
    const own = await payment(co, id, { paidOn: '2026-06-01', principal: 500, interest: 0, escrow: 0, method: 'owner_paid' })
    await drainLedgerOutbox()
    expect((await active('loan_payment', card)).map(l => l.role)).toEqual(['mortgage_payable', 'credit_card_payable'])
    expect((await active('loan_payment', own)).map(l => l.role)).toEqual(['mortgage_payable', 'owner_equity'])
  })

  it('a payment voided is taken back; a voided loan takes its posting back', async () => {
    const co = await ledgerCompany()
    const id = await loan(co)
    const p = await payment(co, id, { paidOn: '2026-04-01', principal: 400, interest: 1000, escrow: 100 })
    await drainLedgerOutbox()
    await db.query(`UPDATE books_loan_payments SET voided_at = now(), void_reason = 'typed twice' WHERE id = $1`, [p])
    await drainLedgerOutbox()
    expect(await active('loan_payment', p)).toEqual([])
    await db.query(`UPDATE books_loans SET voided_at = now(), void_reason = 'entered by mistake' WHERE id = $1`, [id])
    await drainLedgerOutbox()
    expect(await active('loan', id)).toEqual([])
    expect(await balance(co.landlordId, 'mortgage_payable')).toBe(0)
    // A voided record is a record: it never changes, and it is never removed.
    await expect(db.query(`UPDATE books_loans SET name = 'x' WHERE id = $1`, [id])).rejects.toThrow(/voided/)
    await expect(db.query(`DELETE FROM books_loan_payments WHERE id = $1`, [p])).rejects.toThrow(/never removed/)
  })

  it('made before the books start: waits for what was owed that day, then opens at it (with the escrow) — earlier payments post nothing', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const id = await loan(co, { start_date: '2020-05-01', funded_to: null })
    const early = await payment(co, id, { paidOn: '2025-12-01', principal: 300, interest: 700, escrow: 100 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 1 })
    expect(await waiting('loan', id)).toMatchObject({ reason_code: 'owner_not_ready' })
    await db.query(`UPDATE books_loans SET opening_balance = 150000, opening_escrow = 1200 WHERE id = $1`, [id])
    await drainLedgerOutbox({ ignoreBackoff: true })
    expect((await active('loan', id)).map(l => [l.day, l.role, l.dr, l.cr])).toEqual([
      ['2026-01-01', 'mortgage_payable', 0, 150000],
      ['2026-01-01', 'opening_balance_equity', 150000, 0],
      ['2026-01-01', 'loan_escrow', 1200, 0],
      ['2026-01-01', 'opening_balance_equity', 0, 1200],
    ])
    expect(await active('loan_payment', early)).toEqual([])
  })

  it('the opening posting carries nothing of a loan (it opens through its own posting, never twice)', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    for (const p of TENANT_LEDGER_PROJECTORS) registerLedgerProjector(p)
    await db.query(`UPDATE landlords SET books_home_sale_method = 'income_as_paid', books_work_trade_method = 'rent_discount' WHERE id = $1`, [co.landlordId])
    const id = await loan(co, { start_date: '2020-05-01', funded_to: null, opening_balance: 150000 })
    await payment(co, id, { paidOn: '2025-12-01', principal: 300, interest: 700, escrow: 100 })
    await db.query(`INSERT INTO ledger_outbox (source_type, source_id, owner_id) VALUES ('opening', $1::text, $2::uuid)`, [co.landlordId, co.landlordId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await waiting('opening', co.landlordId)).toBeNull()
    const opening = await active('opening', co.landlordId)
    expect(opening.filter(l => l.role === 'mortgage_payable' || l.role === 'loan_escrow')).toEqual([])
    expect(await balance(co.landlordId, 'mortgage_payable')).toBe(-150000)
  })

  // 10/13 (Nic): "Company-level costs before the owner picks: post to the
  // COMPANY column by default"; "a later 'split by units' splits only NEW costs".
  it('a company loan\'s interest goes to the Company column until the owner picks; a later split takes only payments entered after it', async () => {
    const co = await ledgerCompany()
    const id = await loan(co, { property_id: null })
    const p = await payment(co, id, { paidOn: '2026-04-01', principal: 400, interest: 1000, escrow: 100 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await waiting('loan_payment', p)).toBeNull()
    const interest = async (pid: string) => (await active('loan_payment', pid)).filter(l => l.role === 'mortgage_interest').map(l => [l.dr, l.property])
    expect(await interest(p)).toEqual([[1000, null]])
    await db.query(`UPDATE units SET created_at = '2026-01-01' WHERE landlord_id = $1`, [co.landlordId])
    await db.query(`UPDATE landlords SET books_company_costs_method = 'split_by_units', books_company_costs_from = now() WHERE id = $1`, [co.landlordId])
    // A change to the payment re-posts it: still the Company column (entered before the pick).
    await db.query(`UPDATE books_loan_payments SET paid_on = '2026-04-02' WHERE id = $1`, [p])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await interest(p)).toEqual([[1000, null]])
    const later = await payment(co, id, { paidOn: '2026-05-01', principal: 400, interest: 1000, escrow: 100 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const units = (await db.query<{ property_id: string; n: number }>(
      `SELECT property_id, count(*)::int AS n FROM units WHERE landlord_id = $1 GROUP BY property_id`, [co.landlordId])).rows
    expect(units.length).toBeGreaterThan(0)
    expect((await interest(later)).every(([, prop]) => prop !== null)).toBe(true)
    expect((await interest(later)).reduce((s, [dr]) => s + (dr as number), 0)).toBe(1000)
  })

  it('a change to the loan re-posts it and every payment (they carry its property)', async () => {
    const co = await ledgerCompany()
    const id = await loan(co)
    const p = await payment(co, id, { paidOn: '2026-04-01', principal: 400, interest: 1000, escrow: 100 })
    await drainLedgerOutbox()
    await db.query(`UPDATE books_loans SET property_id = $2 WHERE id = $1`, [id, co.propertyId2])
    await drainLedgerOutbox()
    expect(new Set((await active('loan_payment', p)).map(l => l.property))).toEqual(new Set([co.propertyId2]))
    expect(new Set((await active('loan', id)).map(l => l.property))).toEqual(new Set([co.propertyId2]))
  })

  it('the database keeps a payment whole and on its loan\'s company', async () => {
    const co = await ledgerCompany()
    const other = await ledgerCompany()
    const id = await loan(co)
    await expect(db.query(
      `INSERT INTO books_loan_payments (loan_id, landlord_id, paid_on, amount, principal, interest, escrow, method)
       VALUES ($1, $2, '2026-04-01', 100, 50, 40, 0, 'bank')`, [id, co.landlordId])).rejects.toThrow(/parts_add_up/)
    await expect(db.query(
      `INSERT INTO books_loan_payments (loan_id, landlord_id, paid_on, amount, principal, interest, escrow, method)
       VALUES ($1, $2, '2026-04-01', 100, 100, 0, 0, 'bank')`, [id, other.landlordId])).rejects.toThrow(/its loan's company/)
  })
})

describe('a fixed asset', () => {
  it('bought before the books start opens at its cost less the straight-line months before it; each month that ended posts once', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const id = await asset(co)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    // Feb 2015 – Dec 2025: 131 months of $1,000 already taken.
    expect((await active('fixed_asset', id)).map(l => [l.day, l.role, l.dr, l.cr])).toEqual([
      ['2026-01-01', 'rental_property', 330000, 0],
      ['2026-01-01', 'accumulated_depreciation', 0, 131000],
      ['2026-01-01', 'opening_balance_equity', 0, 199000],
    ])
    const t = await today()
    const ended = depreciationSchedule({ costCents: 33_000_000, salvageCents: 0, inServiceDate: '2015-02-01', lifeMonths: 330 })
      .filter(m => m.endDay >= '2026-01-01' && m.endDay < t)
    expect(ended.length).toBeGreaterThan(0)
    // Saving the asset marked every month that had ended; the drain posted each, on its last day.
    const jan = await active('fixed_asset', `${id}|2026-01`)
    expect(jan.map(l => [l.day, l.role, l.dr, l.cr, l.property])).toEqual([
      ['2026-01-31', 'depreciation_expense', 1000, 0, co.propertyId],
      ['2026-01-31', 'accumulated_depreciation', 0, 1000, co.propertyId],
    ])
    expect(await balance(co.landlordId, 'accumulated_depreciation')).toBe(-(131000 + 1000 * ended.length))
    // Nothing is marked twice, and a month still running is not marked at all.
    expect(await markDepreciationMonthsDue()).toBe(0)
    expect((await db.query(`SELECT 1 FROM ledger_postings WHERE source_type = 'fixed_asset' AND source_id = $1`,
      [`${id}|${t.slice(0, 7)}`])).rows).toEqual([])
  })

  it('a month that ends is marked by the minute job (markDepreciationMonthsDue) and posts', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const id = await asset(co, { acquired_on: '2026-02-01', in_service_date: '2026-02-01', life_years: 5, cost: 6000 })
    // As if saving it had marked nothing: the job finds every month that ended.
    await db.query(`DELETE FROM ledger_outbox WHERE source_type = 'fixed_asset' AND source_id LIKE $1`, [`${id}|%`])
    const t = await today()
    const ended = depreciationSchedule({ costCents: 600_000, salvageCents: 0, inServiceDate: '2026-02-01', lifeMonths: 60 })
      .filter(m => m.endDay < t)
    expect(await markDepreciationMonthsDue()).toBe(ended.length)
    expect(await markDepreciationMonthsDue()).toBe(0)   // already waiting
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await markDepreciationMonthsDue()).toBe(0)   // already posted
    expect((await active('fixed_asset', `${id}|2026-02`)).map(l => [l.day, l.dr])).toEqual([['2026-02-28', 100], ['2026-02-28', 0]])
  })

  it('bought after the books start posts no cost (its cost is on the books through how it was paid) — only the depreciation', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const id = await asset(co, { name: 'Mower', asset_class: 'equipment', cost: 6000, salvage_value: 600, acquired_on: '2026-02-15',
      in_service_date: '2026-03-01', life_years: 5 })
    await drainLedgerOutbox()
    expect(await active('fixed_asset', id)).toEqual([])
    expect((await active('fixed_asset', `${id}|2026-03`)).map(l => [l.role, l.dr, l.cr])).toEqual([
      ['depreciation_expense', 90, 0], ['accumulated_depreciation', 0, 90],
    ])
  })

  it('the owner\'s own "already taken" figure opens the books, and the rest of the life spreads what is left', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const id = await asset(co, { prior_depreciation: 120000 })
    await drainLedgerOutbox()
    expect((await active('fixed_asset', id)).find(l => l.role === 'accumulated_depreciation')!.cr).toBe(120000)
    const s = depreciationSchedule({ costCents: 33_000_000, salvageCents: 0, inServiceDate: '2015-02-01', lifeMonths: 330,
      priorCents: 12_000_000, priorAsOf: '2026-01-01' })
    const jan = s.find(m => m.month === '2026-01')!
    expect((await active('fixed_asset', `${id}|2026-01`))[0].dr).toBe(jan.cents / 100)
  })

  it('land never depreciates; a shorter life takes back the months beyond it; a voided asset takes everything back', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const land = await asset(co, { name: 'The lot', asset_class: 'land', cost: 90000, life_years: null })
    const truck = await asset(co, { name: 'Truck', asset_class: 'vehicle', cost: 3600, acquired_on: '2026-01-05',
      in_service_date: '2026-01-05', life_years: 3 })
    await drainLedgerOutbox()
    expect((await active('fixed_asset', land)).map(l => [l.role, l.dr, l.cr])).toEqual([
      ['rental_property', 90000, 0], ['opening_balance_equity', 0, 90000],
    ])
    expect((await db.query(`SELECT 1 FROM ledger_postings WHERE source_id LIKE $1`, [`${land}|%`])).rows).toEqual([])
    expect((await active('fixed_asset', `${truck}|2026-01`))[0].dr).toBe(100)
    await db.query(`UPDATE books_fixed_assets SET life_years = 0.25 WHERE id = $1`, [truck])   // 3 months
    await drainLedgerOutbox()
    expect((await active('fixed_asset', `${truck}|2026-01`))[0].dr).toBe(1200)
    expect(await active('fixed_asset', `${truck}|2026-04`)).toEqual([])
    await db.query(`UPDATE books_fixed_assets SET voided_at = now(), void_reason = 'sold it' WHERE id = $1`, [truck])
    await drainLedgerOutbox()
    expect(await active('fixed_asset', `${truck}|2026-01`)).toEqual([])
  })

  it('made from an expense: no cost of its own; the expense cannot be voided while the asset stands', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const exp = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, payments_tracked)
       VALUES ($1, $2, 'other', 12000, '2026-02-10', TRUE) RETURNING id`, [co.landlordId, co.propertyId])).rows[0].id
    const id = await asset(co, { name: 'New roof', asset_class: 'improvement', cost: 12000, acquired_on: '2026-02-10',
      in_service_date: '2026-02-10', life_years: 10, source_expense_id: exp })
    await drainLedgerOutbox()
    expect(await active('fixed_asset', id)).toEqual([])
    expect((await active('fixed_asset', `${id}|2026-02`))[0].dr).toBe(100)
    await expect(db.query(`UPDATE landlord_expenses SET status = 'voided', voided_at = now() WHERE id = $1`, [exp]))
      .rejects.toThrow(/New roof.*Void the asset/)
    await db.query(`UPDATE books_fixed_assets SET voided_at = now(), void_reason = 'not an asset' WHERE id = $1`, [id])
    await db.query(`UPDATE landlord_expenses SET status = 'voided', voided_at = now() WHERE id = $1`, [exp])
  })

  it('10/12 review: made from an expense dated before the books start — the depreciation already taken opens on the start date', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const exp = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, payments_tracked)
       VALUES ($1, $2, 'other', 12000, '2025-07-10', TRUE) RETURNING id`, [co.landlordId, co.propertyId])).rows[0].id
    const id = await asset(co, { name: 'Old roof', asset_class: 'improvement', cost: 12000, acquired_on: '2025-07-10',
      in_service_date: '2025-07-10', life_years: 10, source_expense_id: exp })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    // Jul–Dec 2025: six months of $100 already taken by the start date.
    expect((await active('fixed_asset', id)).map(l => [l.day, l.role, l.dr, l.cr])).toEqual([
      ['2026-01-01', 'opening_balance_equity', 600, 0],
      ['2026-01-01', 'accumulated_depreciation', 0, 600],
    ])
    expect(await active('fixed_asset', `${id}|2025-12`)).toEqual([])
    expect((await active('fixed_asset', `${id}|2026-01`))[0].dr).toBe(100)
  })

  it('keys: an asset, or an asset and a month', () => {
    expect(parseFixedAssetKey('2b1f5a8e-0c1d-4e2f-9a3b-4c5d6e7f8a9b')).toEqual({ assetId: '2b1f5a8e-0c1d-4e2f-9a3b-4c5d6e7f8a9b', month: null })
    expect(parseFixedAssetKey('2b1f5a8e-0c1d-4e2f-9a3b-4c5d6e7f8a9b|2026-09')).toEqual({ assetId: '2b1f5a8e-0c1d-4e2f-9a3b-4c5d6e7f8a9b', month: '2026-09' })
    expect(parseFixedAssetKey('2b1f5a8e-0c1d-4e2f-9a3b-4c5d6e7f8a9b|2026-13')).toBeNull()
    expect(parseFixedAssetKey('nope|2026-01')).toBeNull()
  })
})

describe('rebuild and the nightly check', () => {
  it('a rebuild from scratch posts the same lines, and the nightly check finds no drift', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const b = await bank(co)
    const l1 = await loan(co, { funded_to: 'bank', funded_bank_connection_id: b })
    await payment(co, l1, { paidOn: '2026-04-01', principal: 400, interest: 1000, escrow: 100, bankConnectionId: b })
    await loan(co, { name: 'Old note', start_date: '2019-06-01', funded_to: null, opening_balance: 50000, opening_escrow: 0 })
    await asset(co)
    await asset(co, { name: 'Mower', asset_class: 'equipment', cost: 6000, acquired_on: '2026-02-15', in_service_date: '2026-03-01', life_years: 5 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const fingerprints = async () => (await db.query<{ k: string }>(
      `SELECT source_type || ':' || source_id || ':' || posting_kind || ':' || fingerprint AS k FROM ledger_postings
        WHERE landlord_id = $1 AND role = 'post' AND superseded_at IS NULL ORDER BY 1`, [co.landlordId])).rows.map(r => r.k)
    const before = await fingerprints()
    expect(before.length).toBeGreaterThan(6)
    expect(await rebuildOwner(co.owner, { mode: 'dry_run' })).toMatchObject({ status: 'done', counts: { drift: 0, failed: 0 } })
    expect(await rebuildOwner(co.owner, { mode: 'from_scratch' })).toMatchObject({ status: 'done', counts: { failed: 0 } })
    expect(await fingerprints()).toEqual(before)
    const check = await checkOwner(co.owner)
    expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  })
})
