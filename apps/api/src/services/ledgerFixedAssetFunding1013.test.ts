/**
 * 10/13 (Nic) — GAM Books ledger: a fixed asset typed in by hand posts its
 * cost against where the money came from.
 *
 *   Nic, 10/13 (morning): "Fixed asset typed by hand: the form ASKS where the
 *   money came from (cash on hand / owner put money in / loan / already an
 *   expense) and posts to that." Nic, 10/13 (afternoon): "hand-typed asset
 *   'already an expense' → LINK that expense (cost moves to the asset)."
 *
 * Bought on or after the books start (services/ledgerProjectors/loansAssets,
 * moneyOut):
 *   cash on hand   Dr the asset's account / Cr Undeposited funds (1040) — the
 *                  1040 tie-out takes it out of the drawer
 *   owner          Dr the asset's account / Cr Owner equity and contributions
 *   loan           nothing of its own: the loan's posting carries the cost
 *   expense        the expense posts its cost to the asset's account instead of
 *                  its category's (each payment toward it pays for an asset) —
 *                  counted once; voiding the asset moves it back
 * Real tables, real capture triggers, the production projectors and checks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BOOKS_FIXED_ASSET_FUNDED_BY } from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, roleNet, type LedgerCompany } from '../test/ledgerFixtures'
import { active } from '../test/ledgerP5Fixtures'
import { drainLedgerOutbox } from './ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { checkOwner } from './ledgerCheck'
import { rebuildOwner } from './ledgerRebuild'

beforeEach(async () => {
  await cleanupAllSchema()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

async function asset(co: LedgerCompany, o: Record<string, unknown> = {}): Promise<string> {
  const v = {
    property_id: co.propertyId, name: 'Riding mower', asset_class: 'equipment', cost: 6000, salvage_value: 600,
    acquired_on: '2026-02-15', in_service_date: '2026-03-01', life_years: 5, source_expense_id: null, funded_by: null,
    funded_loan_id: null, ...o,
  }
  return (await db.query<{ id: string }>(
    `INSERT INTO books_fixed_assets (landlord_id, property_id, name, asset_class, cost, salvage_value, acquired_on,
                                     in_service_date, life_years, source_expense_id, funded_by, funded_loan_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [co.landlordId, v.property_id, v.name, v.asset_class, v.cost, v.salvage_value, v.acquired_on, v.in_service_date,
     v.life_years, v.source_expense_id, v.funded_by, v.funded_loan_id])).rows[0].id
}

/** An expense filed under a category of the company's (by its seeded system key), paid from the bank. */
async function expense(co: LedgerCompany, systemKey: string, amount: number): Promise<{ id: string; paymentId: string }> {
  await db.query(`SELECT books_seed_categories($1)`, [co.landlordId])
  const cat = (await db.query<{ id: string }>(
    `SELECT id FROM books_categories WHERE landlord_id = $1 AND direction = 'expense' AND system_key = $2`, [co.landlordId, systemKey])).rows[0].id
  const id = (await db.query<{ id: string }>(
    `INSERT INTO landlord_expenses (landlord_id, property_id, category, category_id, amount, expense_date, description, payments_tracked)
     VALUES ($1, $2, 'other', $3, $4, '2026-02-10', 'New roof', TRUE) RETURNING id`, [co.landlordId, co.propertyId, cat, amount])).rows[0].id
  const paymentId = (await db.query<{ id: string }>(
    `INSERT INTO landlord_expense_payments (expense_id, landlord_id, paid_on, amount, method, source)
     VALUES ($1, $2, '2026-02-12', $3, 'bank', 'payment') RETURNING id`, [id, co.landlordId, amount])).rows[0].id
  return { id, paymentId }
}

const brief = (ls: Awaited<ReturnType<typeof active>>) => ls.map(l => [l.role, l.dr, l.cr])
/** A source's active lines with what kind of money each is: [role, debit, credit, expense kind, cash effect]. */
async function kinds(sourceType: string, sourceId: string): Promise<(string | number | null)[][]> {
  return (await db.query<{ role: string; dr: string; cr: string; kind: string | null; cash: string | null }>(
    `SELECT l.account_role AS role, l.debit::text AS dr, l.credit::text AS cr, l.expense_kind AS kind, l.cash_effect AS cash
       FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.source_type = $1 AND p.source_id = $2 AND p.role = 'post' AND p.superseded_at IS NULL AND p.posting_kind = 'main'
      ORDER BY l.line_no`, [sourceType, sourceId])).rows.map(l => [l.role, Number(l.dr), Number(l.cr), l.kind, l.cash])
}

/** The nightly check finds nothing wrong; a dry-run rebuild finds no drift; debits equal credits. */
async function clean(co: LedgerCompany): Promise<void> {
  const check = await checkOwner(co.owner)
  expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  const b = (await db.query<{ dr: string; cr: string }>(
    `SELECT COALESCE(sum(debit), 0)::text AS dr, COALESCE(sum(credit), 0)::text AS cr FROM ledger_posting_lines WHERE landlord_id = $1`,
    [co.landlordId])).rows[0]
  expect(b.dr).toBe(b.cr)
}

describe('a fixed asset typed in by hand, bought on or after the books start', () => {
  it('cash on hand: its cost comes out of the office drawer on the day it was bought; the drawer still ties', async () => {
    const co = await ledgerCompany()
    const id = await asset(co, { funded_by: 'cash' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const ls = await active('fixed_asset', id)
    expect(ls.map(l => [l.day, l.role, l.dr, l.cr, l.cash])).toEqual([
      ['2026-02-15', 'equipment', 6000, 0, 'out'], ['2026-02-15', 'undeposited_funds', 0, 6000, null],
    ])
    expect(await roleNet(co.landlordId, 'undeposited_funds')).toBe(6000)
    await clean(co)
  })

  it('the owner put money in: Owner equity and contributions; a change of answer re-posts it', async () => {
    const co = await ledgerCompany()
    const id = await asset(co, { funded_by: 'owner', asset_class: 'building', name: 'Clubhouse', cost: 90000, salvage_value: 0, life_years: 39 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(brief(await active('fixed_asset', id))).toEqual([['rental_property', 90000, 0], ['owner_equity', 0, 90000]])
    await db.query(`UPDATE books_fixed_assets SET funded_by = 'cash' WHERE id = $1`, [id])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(brief(await active('fixed_asset', id))).toEqual([['rental_property', 90000, 0], ['undeposited_funds', 0, 90000]])
    expect(await roleNet(co.landlordId, 'owner_equity')).toBe(0)
    await clean(co)
  })

  it('a loan that paid the seller: the loan carries the cost, the asset adds none — never twice; the loan stays while the asset stands', async () => {
    const co = await ledgerCompany()
    const loan = (await db.query<{ id: string }>(
      `INSERT INTO books_loans (landlord_id, property_id, name, lender_name, original_amount, annual_rate, start_date, funded_to)
       VALUES ($1, $2, 'Mower loan', 'Deere Financial', 6000, 5, '2026-02-15', 'equipment') RETURNING id`,
      [co.landlordId, co.propertyId])).rows[0].id
    const id = await asset(co, { funded_by: 'loan', funded_loan_id: loan })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await active('fixed_asset', id)).toEqual([])
    expect(await roleNet(co.landlordId, 'equipment')).toBe(-6000)   // the loan's posting: one cost, a debit
    await expect(db.query(`UPDATE books_loans SET voided_at = now(), void_reason = 'typed twice' WHERE id = $1`, [loan]))
      .rejects.toThrow(/paid for the fixed asset "Riding mower".*Void the asset/)
    await expect(db.query(`UPDATE books_loans SET funded_to = 'bank' WHERE id = $1`, [loan])).rejects.toThrow(/Void the asset/)
    await clean(co)
  })

  it('not said (entered before 10/13): no cost of its own, as before — only the depreciation', async () => {
    const co = await ledgerCompany()
    const id = await asset(co)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await active('fixed_asset', id)).toEqual([])
    expect((await active('fixed_asset', `${id}|2026-03`)).map(l => [l.role, l.dr, l.cr])).toEqual([
      ['depreciation_expense', 90, 0], ['accumulated_depreciation', 0, 90],
    ])
  })

  it('bought before the books start: opens on the start date as before, whatever is said', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const id = await asset(co, { acquired_on: '2025-06-01', in_service_date: '2025-06-01', funded_by: 'cash' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect((await active('fixed_asset', id)).map(l => [l.day, l.role])).toEqual([
      ['2026-01-01', 'equipment'], ['2026-01-01', 'accumulated_depreciation'], ['2026-01-01', 'opening_balance_equity'],
    ])
    expect(await roleNet(co.landlordId, 'undeposited_funds')).toBe(0)
    await clean(co)
  })
})

describe('"already an expense": LINK that expense — its cost moves to the asset', () => {
  it('an expense filed under Repairs moves to Rental property while the asset stands; its payment paid for an asset; voiding the asset moves it back', async () => {
    const co = await ledgerCompany()
    const e = await expense(co, 'repairs', 12000)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await roleNet(co.landlordId, 'repairs_maintenance')).toBe(-12000)
    const linked = await asset(co, { name: 'New roof', asset_class: 'improvement', cost: 12000, salvage_value: 0, acquired_on: '2026-02-10',
      in_service_date: '2026-02-10', life_years: 10, source_expense_id: e.id, funded_by: 'expense' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    // Counted once, on the asset: the expense's cost is on Rental property, nothing on Repairs.
    expect(await kinds('expense', e.id)).toEqual([
      ['rental_property', 12000, 0, 'asset', null], ['accounts_payable', 0, 12000, null, null],
    ])
    expect(await roleNet(co.landlordId, 'repairs_maintenance')).toBe(0)
    expect(await roleNet(co.landlordId, 'rental_property')).toBe(-12000)
    // The payment toward it paid for an asset (a cash-basis P&L counts no expense).
    expect((await kinds('expense_payment', e.paymentId)).find(l => l[0] === 'accounts_payable')).toEqual(['accounts_payable', 12000, 0, 'asset', 'out'])
    // The asset posts no cost of its own; its depreciation runs from its month.
    expect(await active('fixed_asset', linked)).toEqual([])
    expect((await active('fixed_asset', `${linked}|2026-02`))[0]).toMatchObject({ role: 'depreciation_expense', dr: 100 })
    await clean(co)
    // The expense cannot be voided while the asset stands.
    await expect(db.query(`UPDATE landlord_expenses SET status = 'voided', voided_at = now() WHERE id = $1`, [e.id]))
      .rejects.toThrow(/New roof.*Void the asset/)
    // Voided, the asset lets go: the expense is a repair again.
    await db.query(`UPDATE books_fixed_assets SET voided_at = now(), void_reason = 'not an asset' WHERE id = $1`, [linked])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await roleNet(co.landlordId, 'repairs_maintenance')).toBe(-12000)
    expect(await roleNet(co.landlordId, 'rental_property')).toBe(0)
    expect((await kinds('expense_payment', e.paymentId)).find(l => l[0] === 'accounts_payable')).toEqual(['accounts_payable', 12000, 0, 'expense', 'out'])
    await clean(co)
  })

  it('an expense filed under a capital-improvement category is on an asset account already: it stays there', async () => {
    const co = await ledgerCompany()
    await db.query(`SELECT books_seed_categories($1)`, [co.landlordId])
    const cat = (await db.query<{ id: string }>(
      `INSERT INTO books_categories (landlord_id, direction, name, default_role) VALUES ($1, 'expense', 'Capital improvements', 'rental_property') RETURNING id`,
      [co.landlordId])).rows[0].id
    const e = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, category_id, amount, expense_date, payments_tracked)
       VALUES ($1, $2, 'other', $3, 3000, '2026-02-10', TRUE) RETURNING id`, [co.landlordId, co.propertyId, cat])).rows[0].id
    await drainLedgerOutbox()
    const before = brief(await active('expense', e))
    await asset(co, { name: 'Fence', asset_class: 'equipment', cost: 3000, salvage_value: 0, acquired_on: '2026-02-10',
      in_service_date: '2026-02-10', life_years: 10, source_expense_id: e, funded_by: 'expense' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(brief(await active('expense', e))).toEqual(before)
    expect(before[0]).toEqual(['rental_property', 3000, 0])
    await clean(co)
  })
})

describe('the database holds the shapes', () => {
  it('the funding CHECK is the shared list; a loan names its loan, an expense its expense', async () => {
    const def = (await db.query<{ d: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c
        WHERE c.conrelid = 'books_fixed_assets'::regclass AND c.conname = 'books_fixed_assets_funded_by_check'`)).rows[0].d
    expect([...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()).toEqual([...BOOKS_FIXED_ASSET_FUNDED_BY].sort())
    const co = await ledgerCompany()
    await expect(asset(co, { funded_by: 'loan' })).rejects.toThrow(/funded_shape/)
    await expect(asset(co, { funded_by: 'expense' })).rejects.toThrow(/funded_shape/)
    await expect(asset(co, { funded_by: 'cash', funded_loan_id: co.landlordId })).rejects.toThrow(/funded_shape/)
  })
})
