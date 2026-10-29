/**
 * 10/13 (Nic) — GAM Books ledger: where a cost goes is picked when it is
 * logged, never a setting; a fixed asset's money may come from several places.
 *
 *   Nic, 10/13: "each expense is chosen on the split or specific unit or
 *   property at the time of logging. there should never be a default setting
 *   to apply expenses." And: "except gams charge all those costs get logged by
 *   a person or they wont show as itemized in the books." And: "Funding: ALLOW
 *   A MIX (several funding lines adding up to the cost; a loan may spread over
 *   several assets)."
 *
 * An expense, a loan's interest and an asset's depreciation go where their own
 * record says (cost_place: split across the properties by units, one property,
 * one unit); a record logged before 10/13 stays as it posted (its property,
 * else the Company column); the retired company-costs setting is read by
 * nothing; GAM's own company-wide charges go to the Company column. Funding
 * lines post their cash and owner parts; a loan's and an expense's parts are
 * carried by those records, and the database holds the lines to the cost and
 * a loan's lines to what it lent. Real tables, real capture triggers, the
 * production projectors and checks; debits equal credits, no integrity
 * finding, no drift.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedUnit } from '../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../test/ledgerFixtures'
import { drainLedgerOutbox } from './ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { checkOwner } from './ledgerCheck'
import { rebuildOwner } from './ledgerRebuild'
import { createLandlordExpense, voidLandlordExpense, updateLandlordExpense, EXPENSE_NO_PLACE } from './landlordExpenses'
import { categorizeTransaction } from './bankFeed'
import { randomUUID } from 'crypto'

beforeEach(async () => {
  await cleanupAllSchema()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

/** A source's active lines on a role, as [property, unit, debit − credit], sorted. */
async function costLines(sourceType: string, sourceId: string, role: string): Promise<[string | null, string | null, number][]> {
  return (await db.query<{ property_id: string | null; unit_id: string | null; n: number }>(
    `SELECT l.property_id, l.unit_id, (l.debit - l.credit)::float AS n
       FROM ledger_posting_lines l JOIN ledger_postings p ON p.id = l.posting_id
      WHERE p.source_type = $1 AND p.source_id = $2 AND p.role = 'post' AND p.superseded_at IS NULL AND l.account_role = $3
      ORDER BY l.property_id NULLS FIRST, l.unit_id NULLS FIRST`, [sourceType, sourceId, role])).rows
    .map(r => [r.property_id, r.unit_id, r.n] as [string | null, string | null, number])
}
const sorted = <T>(xs: T[]) => [...xs].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))

/** Three units on the first property (the fixture's and two more), one on the second, all there since January. */
async function units(co: LedgerCompany): Promise<void> {
  await inTx(async c => {
    for (const [p, n] of [[co.propertyId, 2], [co.propertyId2, 1]] as const) {
      for (let i = 0; i < n; i++) await seedUnit(c, { propertyId: p, landlordId: co.landlordId })
    }
    await c.query(`UPDATE units SET created_at = '2026-01-01' WHERE landlord_id = $1`, [co.landlordId])
  })
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

/** The retired setting, set the way the old Books settings page did — read by nothing now. */
async function retiredSettingSaysSplit(co: LedgerCompany): Promise<void> {
  await db.query(`UPDATE landlords SET books_company_costs_method = 'split_by_units', books_company_costs_from = '2026-01-01'
                   WHERE id = $1`, [co.landlordId])
}

async function loan(co: LedgerCompany, o: {
  name?: string; amount?: number; start?: string; fundedTo?: 'bank' | 'property' | 'equipment'
  place?: 'split_by_units' | 'property' | 'unit' | null; propertyId?: string | null; unitId?: string | null
}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO books_loans (landlord_id, property_id, unit_id, cost_place, name, lender_name, original_amount, annual_rate, start_date, funded_to)
     VALUES ($1, $2, $3, $4, $5, 'First Bank', $6, 6, $7, $8) RETURNING id`,
    [co.landlordId, o.propertyId ?? null, o.unitId ?? null, o.place ?? null, o.name ?? 'Deere loan', o.amount ?? 10000,
     o.start ?? '2026-02-01', o.fundedTo ?? 'bank'])).rows[0].id
}

async function loanPayment(co: LedgerCompany, loanId: string, o: { day?: string; principal: number; interest: number }): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO books_loan_payments (loan_id, landlord_id, paid_on, amount, principal, interest, escrow, method)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 'owner_paid') RETURNING id`,
    [loanId, co.landlordId, o.day ?? '2026-03-01', o.principal + o.interest, o.principal, o.interest])).rows[0].id
}

describe('an expense goes where the person logging it said', () => {
  it('split across the properties by units, one property, or one unit; nothing chosen is refused', async () => {
    const co = await ledgerCompany()
    await units(co)
    await retiredSettingSaysSplit(co)
    const split = await createLandlordExpense({
      landlordId: co.landlordId, category: 'insurance', amount: 400, expenseDate: '2026-10-05', costPlace: 'split_by_units', payment: null,
    })
    expect(split.cost_place).toBe('split_by_units')
    const onProperty = await createLandlordExpense({
      landlordId: co.landlordId, propertyId: co.propertyId2, category: 'insurance', amount: 50, expenseDate: '2026-10-05', payment: null,
    })
    expect(onProperty.cost_place).toBe('property')
    const onUnit = await createLandlordExpense({
      landlordId: co.landlordId, unitId: co.unitId, category: 'repairs', amount: 80, expenseDate: '2026-10-05', payment: null,
    })
    expect(onUnit.cost_place).toBe('unit')
    await expect(createLandlordExpense({
      landlordId: co.landlordId, category: 'insurance', amount: 10, expenseDate: '2026-10-05', payment: null,
    })).rejects.toThrow(EXPENSE_NO_PLACE)
    await expect(createLandlordExpense({
      landlordId: co.landlordId, propertyId: co.propertyId, costPlace: 'split_by_units', category: 'insurance', amount: 10,
      expenseDate: '2026-10-05', payment: null,
    })).rejects.toThrow(/names no one property or unit/)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    expect(await costLines('expense', split.id, 'insurance')).toEqual(sorted([[co.propertyId, null, 300], [co.propertyId2, null, 100]]))
    expect(await costLines('expense', onProperty.id, 'insurance')).toEqual([[co.propertyId2, null, 50]])
    expect(await costLines('expense', onUnit.id, 'repairs_maintenance')).toEqual([[co.propertyId, co.unitId, 80]])

    // Re-filed on one property: it follows.
    await updateLandlordExpense(split.id, co.landlordId, { propertyId: co.propertyId, unitId: null })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('expense', split.id, 'insurance')).toEqual([[co.propertyId, null, 400]])
    expect((await db.query(`SELECT cost_place FROM landlord_expenses WHERE id = $1`, [split.id])).rows[0].cost_place).toBe('property')
    // And split again.
    await updateLandlordExpense(split.id, co.landlordId, { costPlace: 'split_by_units' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('expense', split.id, 'insurance')).toEqual(sorted([[co.propertyId, null, 300], [co.propertyId2, null, 100]]))
    await clean(co)
  })

  it('one logged before 10/13 on no property stays in the Company column, whatever the retired setting says — rebuilt from scratch too', async () => {
    const co = await ledgerCompany()
    await units(co)
    await retiredSettingSaysSplit(co)
    const old = (await db.query<{ id: string }>(
      `INSERT INTO landlord_expenses (landlord_id, category, amount, expense_date, payments_tracked)
       VALUES ($1, 'insurance', 75, '2026-09-10', TRUE) RETURNING id`, [co.landlordId])).rows[0].id
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('expense', old, 'insurance')).toEqual([[null, null, 75]])
    expect((await rebuildOwner(co.owner, { mode: 'from_scratch' })).counts.failed).toBe(0)
    expect(await costLines('expense', old, 'insurance')).toEqual([[null, null, 75]])
    await clean(co)
  })
})

describe('a loan\'s interest goes where the loan said when it was logged', () => {
  it('split by units, one unit, or (logged before 10/13 on no property) the Company column', async () => {
    const co = await ledgerCompany()
    await units(co)
    await retiredSettingSaysSplit(co)
    const split = await loan(co, { place: 'split_by_units' })
    const unit = await loan(co, { name: 'Shop loan', place: 'unit', propertyId: co.propertyId, unitId: co.unitId })
    const legacy = await loan(co, { name: 'Old loan' })
    const ps = await loanPayment(co, split, { principal: 160, interest: 40 })
    const pu = await loanPayment(co, unit, { principal: 90, interest: 10 })
    const pl = await loanPayment(co, legacy, { principal: 80, interest: 20 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('loan_payment', ps, 'mortgage_interest')).toEqual(sorted([[co.propertyId, null, 30], [co.propertyId2, null, 10]]))
    expect(await costLines('loan_payment', pu, 'mortgage_interest')).toEqual([[co.propertyId, co.unitId, 10]])
    // A unit loan's other lines stay on its property.
    expect(await costLines('loan_payment', pu, 'mortgage_payable')).toEqual([[co.propertyId, null, 90]])
    expect(await costLines('loan_payment', pl, 'mortgage_interest')).toEqual([[null, null, 20]])
    // Moving where the interest goes re-posts every payment.
    await db.query(`UPDATE books_loans SET cost_place = 'property', property_id = $2, unit_id = NULL WHERE id = $1`, [split, co.propertyId2])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('loan_payment', ps, 'mortgage_interest')).toEqual([[co.propertyId2, null, 40]])
    await clean(co)
  })
})

describe('an asset\'s depreciation goes where the asset said when it was logged', () => {
  it('split by units each month; one owned before the books start still opens against Opening balance equity', async () => {
    const co = await ledgerCompany()
    await units(co)
    const truck = (await db.query<{ id: string }>(
      `INSERT INTO books_fixed_assets (landlord_id, property_id, cost_place, name, asset_class, cost, salvage_value, acquired_on,
                                       in_service_date, life_years, funded_by)
       VALUES ($1, NULL, 'split_by_units', 'Office truck', 'vehicle', 4800, 0, '2026-02-01', '2026-02-01', 4, 'owner') RETURNING id`,
      [co.landlordId])).rows[0].id
    const old = (await db.query<{ id: string }>(
      `INSERT INTO books_fixed_assets (landlord_id, property_id, unit_id, cost_place, name, asset_class, cost, salvage_value, acquired_on,
                                       in_service_date, life_years)
       VALUES ($1, $2, $3, 'unit', 'Water heater', 'equipment', 1200, 0, '2025-01-01', '2025-01-01', 10) RETURNING id`,
      [co.landlordId, co.propertyId, co.unitId])).rows[0].id
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('fixed_asset', `${truck}|2026-02`, 'depreciation_expense'))
      .toEqual(sorted([[co.propertyId, null, 75], [co.propertyId2, null, 25]]))
    expect(await costLines('fixed_asset', `${truck}|2026-02`, 'accumulated_depreciation')).toEqual([[null, null, -100]])
    // Bought with the owner's own money: its cost is on the books.
    expect(await costLines('fixed_asset', truck, 'equipment')).toEqual([[null, null, 4800]])
    // Owned before the books start (2026-01-01): it opens on that day against Opening balance equity, a year taken.
    expect(await costLines('fixed_asset', old, 'equipment')).toEqual([[co.propertyId, null, 1200]])
    expect(await costLines('fixed_asset', old, 'accumulated_depreciation')).toEqual([[co.propertyId, null, -120]])
    expect(await costLines('fixed_asset', old, 'opening_balance_equity')).toEqual([[co.propertyId, null, -1080]])
    expect(await costLines('fixed_asset', `${old}|2026-01`, 'depreciation_expense')).toEqual([[co.propertyId, co.unitId, 10]])
    await clean(co)
  })
})

describe('"Funding: ALLOW A MIX" — several lines adding up to the cost; a loan may spread over several assets', () => {
  /** An asset and its funding lines, committed together (the database checks the lines at commit). */
  async function assetWithLines(co: LedgerCompany, a: { name: string; cost: number; on?: string },
    lines: { kind: 'cash' | 'owner' | 'loan' | 'expense'; amount: number; loanId?: string; expenseId?: string }[]): Promise<string> {
    return inTx(async c => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO books_fixed_assets (landlord_id, property_id, cost_place, name, asset_class, cost, salvage_value, acquired_on,
                                         in_service_date, life_years)
         VALUES ($1, $2, 'property', $3, 'equipment', $4, 0, $5, $5, 5) RETURNING id`,
        [co.landlordId, co.propertyId, a.name, a.cost, a.on ?? '2026-03-02'])).rows[0].id
      for (const l of lines) {
        await c.query(
          `INSERT INTO books_fixed_asset_funding (asset_id, landlord_id, kind, loan_id, expense_id, amount) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, co.landlordId, l.kind, l.loanId ?? null, l.expenseId ?? null, l.amount])
      }
      return id
    })
  }

  it('an $8,000 mower = $6,000 from a loan + $2,000 cash on hand; the same loan pays $4,000 of a trailer; never past what it lent', async () => {
    const co = await ledgerCompany()
    const deere = await loan(co, { amount: 10000, start: '2026-03-01', fundedTo: 'equipment', place: 'property', propertyId: co.propertyId })
    const mower = await assetWithLines(co, { name: 'Riding mower', cost: 8000 }, [
      { kind: 'loan', amount: 6000, loanId: deere }, { kind: 'cash', amount: 2000 },
    ])
    const trailer = await assetWithLines(co, { name: 'Trailer', cost: 4000 }, [{ kind: 'loan', amount: 4000, loanId: deere }])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    // The mower's own posting carries the cash part only; the loan's posting put the $10,000 on Equipment.
    expect(await costLines('fixed_asset', mower, 'equipment')).toEqual([[co.propertyId, null, 2000]])
    expect(await costLines('fixed_asset', mower, 'undeposited_funds')).toEqual([[co.propertyId, null, -2000]])
    expect(await costLines('fixed_asset', trailer, 'equipment')).toEqual([])
    expect(await costLines('loan', deere, 'equipment')).toEqual([[co.propertyId, null, 10000]])
    // Equipment holds both assets' cost exactly: 8,000 + 4,000.
    const equipment = (await db.query<{ n: string }>(
      `SELECT sum(debit - credit)::text AS n FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = 'equipment'`,
      [co.landlordId])).rows[0].n
    expect(Number(equipment)).toBe(12000)

    // The loan has nothing left for a third asset.
    await expect(assetWithLines(co, { name: 'Edger', cost: 300 }, [{ kind: 'loan', amount: 300, loanId: deere }]))
      .rejects.toThrow(/lent \$10,000\.00, and the fixed assets it paid for add up to \$10,300\.00/)
    // Lines that do not add up to the cost never save.
    await expect(assetWithLines(co, { name: 'Blower', cost: 500 }, [{ kind: 'cash', amount: 400 }]))
      .rejects.toThrow(/adds up to \$400\.00, and it cost \$500\.00/)
    // The loan cannot drop below what its assets say came from it, nor be voided under them.
    await expect(db.query(`UPDATE books_loans SET original_amount = 9000 WHERE id = $1`, [deere])).rejects.toThrow(/lent \$9,000\.00/)
    await expect(db.query(`UPDATE books_loans SET voided_at = now() WHERE id = $1`, [deere])).rejects.toThrow(/paid for the fixed asset/)
    // A line is a record: never removed or changed.
    await expect(db.query(`DELETE FROM books_fixed_asset_funding WHERE asset_id = $1`, [mower])).rejects.toThrow(/never removed/)
    await expect(db.query(`UPDATE books_fixed_asset_funding SET amount = 1 WHERE asset_id = $1`, [mower])).rejects.toThrow(/does not change/)

    // Said again: the cash part becomes the owner's money; the old lines stay on record, replaced.
    await inTx(async c => {
      await c.query(`UPDATE books_fixed_asset_funding SET replaced_at = now() WHERE asset_id = $1 AND replaced_at IS NULL`, [mower])
      await c.query(
        `INSERT INTO books_fixed_asset_funding (asset_id, landlord_id, kind, loan_id, amount)
         VALUES ($1, $2, 'loan', $3, 6000), ($1, $2, 'owner', NULL, 2000)`, [mower, co.landlordId, deere])
    })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('fixed_asset', mower, 'undeposited_funds')).toEqual([])
    expect(await costLines('fixed_asset', mower, 'owner_equity')).toEqual([[co.propertyId, null, -2000]])
    expect(Number((await db.query(`SELECT count(*) FROM books_fixed_asset_funding WHERE asset_id = $1`, [mower])).rows[0].count)).toBe(4)
    await clean(co)
  })

  it('the books start, and a paying loan\'s day, never move so part of an asset\'s cost would count twice', async () => {
    const co = await ledgerCompany()
    const deere = await loan(co, { amount: 6000, start: '2026-03-01', fundedTo: 'equipment', place: 'split_by_units' })
    await assetWithLines(co, { name: 'Riding mower', cost: 8000 }, [{ kind: 'loan', amount: 6000, loanId: deere }, { kind: 'cash', amount: 2000 }])
    await expect(db.query(`UPDATE landlords SET books_start_date = '2026-04-01' WHERE id = $1`, [co.landlordId]))
      .rejects.toThrow(/Your books cannot start on 2026-04-01: the fixed asset "Riding mower" \(bought on 2026-03-02\) was paid for in part by the loan "Deere loan"/)
    await expect(db.query(`UPDATE books_loans SET start_date = '2025-12-01' WHERE id = $1`, [deere]))
      .rejects.toThrow(/This loan paid for the fixed asset "Riding mower"/)
    // An earlier start is fine: both stay after it.
    await db.query(`UPDATE landlords SET books_start_date = '2025-12-01' WHERE id = $1`, [co.landlordId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    await clean(co)
  })

  it('"already an expense" for a part: that expense\'s cost moves to the asset, and it stays as it is while the asset stands', async () => {
    const co = await ledgerCompany()
    const down = await createLandlordExpense({
      landlordId: co.landlordId, propertyId: co.propertyId, category: 'supplies', amount: 2000, expenseDate: '2026-03-02',
      description: 'Mower down payment', payment: { method: 'cash' },
    })
    const mower = await assetWithLines(co, { name: 'Riding mower', cost: 8000 }, [
      { kind: 'expense', amount: 2000, expenseId: down.id }, { kind: 'owner', amount: 6000 },
    ])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('expense', down.id, 'equipment')).toEqual([[co.propertyId, null, 2000]])
    expect(await costLines('expense', down.id, 'supplies')).toEqual([])
    expect(await costLines('fixed_asset', mower, 'equipment')).toEqual([[co.propertyId, null, 6000]])
    expect(await costLines('fixed_asset', mower, 'owner_equity')).toEqual([[co.propertyId, null, -6000]])
    await expect(voidLandlordExpense(down.id, co.landlordId)).rejects.toThrow(/paid for part of one/)
    await expect(db.query(`UPDATE landlord_expenses SET amount = 2500 WHERE id = $1`, [down.id])).rejects.toThrow(/paid for part of the fixed asset "Riding mower"/)
    // 10/13 review: nor does it move to another property, nor is it removed
    // (a line naming a missing expense would drop that part of the cost).
    await expect(db.query(`UPDATE landlord_expenses SET property_id = $2 WHERE id = $1`, [down.id, co.propertyId2]))
      .rejects.toThrow(/paid for part of the fixed asset "Riding mower"/)
    await expect(db.query(`DELETE FROM landlord_expenses WHERE id = $1`, [down.id]))
      .rejects.toThrow(/part of the fixed asset "Riding mower", so it is never removed/)
    // An expense filed on another property never pays for part of this one
    // (it would put that part of the asset's cost on the other property's books).
    const elsewhere = await createLandlordExpense({
      landlordId: co.landlordId, propertyId: co.propertyId2, category: 'supplies', amount: 500, expenseDate: '2026-03-02',
      description: 'Edger at the other park', payment: { method: 'cash' },
    })
    await expect(assetWithLines(co, { name: 'Edger', cost: 500 }, [{ kind: 'expense', amount: 500, expenseId: elsewhere.id }]))
      .rejects.toThrow(/The expense "Edger at the other park" is not filed where the fixed asset "Edger" goes/)
    // Counted whole, once.
    await expect(assetWithLines(co, { name: 'Second mower', cost: 2000 }, [{ kind: 'expense', amount: 2000, expenseId: down.id }]))
      .rejects.toThrow(/already part of another fixed asset/)
    // Voiding the asset frees the expense: it posts to its own category again.
    await db.query(`UPDATE books_fixed_assets SET voided_at = now(), voided_by = $2, void_reason = 'test' WHERE id = $1`, [mower, co.ownerUserId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('expense', down.id, 'supplies')).toEqual([[co.propertyId, null, 2000]])
    await clean(co)
  })
})

describe('GAM\'s own company-wide charges — the only costs nobody logs — go to the Company column', () => {
  it('a $6 transfer cost on no property, whatever the retired setting says; one that waited on the owner posts at its retry', async () => {
    const co = await ledgerCompany()
    await units(co)
    await retiredSettingSaysSplit(co)
    const id = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, created_at)
       VALUES ($1, NULL, 'bank_debit_cost', 6, 'gam_bank_debit_cost', '2026-09-26 23:12:25+00') RETURNING id`,
      [co.landlordId])).rows[0].id
    // As a source waiting on the retired choice would have (none does on production — checked 10/13).
    await db.query(
      `INSERT INTO ledger_source_errors (source_type, source_id, owner_id, reason_code, attempts, last_error, next_try_at)
       VALUES ('gam_charge', $1, $2, 'owner_not_ready', 3, 'Waiting on the owner: where company-level costs go …', now())`,
      [id, co.landlordId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('gam_charge', id, 'bank_fees')).toEqual([[null, null, 6]])
    expect((await db.query(`SELECT 1 FROM ledger_source_errors WHERE source_id = $1`, [id])).rows).toEqual([])
    await clean(co)
  })
})

// 10/13 review: "split across the properties by units" read the units by the
// day each was typed into GAM. Oak Park's books start 8/1 and its units went in
// 8/14, so a split dated 8/1-8/13 fell silently into the Company column — an
// explicit choice overridden. A unit already in GAM when the cost was logged
// counts on any earlier day too; one added after both the cost's day and its
// logging never joins its split, so a rebuild tomorrow comes out the same.
describe('a split reads the units in GAM when the cost was logged', () => {
  it('units typed in after the cost\'s day count; one added after it was logged never joins; never the Company column', async () => {
    const co = await ledgerCompany({ booksStart: '2026-08-01' })
    await units(co)
    // Typed into GAM on 8/14, after the cost's day — as Oak Park's were.
    await db.query(`UPDATE units SET created_at = '2026-08-14' WHERE landlord_id = $1`, [co.landlordId])
    const e = await createLandlordExpense({
      landlordId: co.landlordId, category: 'insurance', amount: 400, expenseDate: '2026-08-05', costPlace: 'split_by_units', payment: null,
    })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('expense', e.id, 'insurance')).toEqual(sorted([[co.propertyId, null, 300], [co.propertyId2, null, 100]]))
    // A unit added after the cost's day and after it was logged: its split does not move.
    await inTx(c => seedUnit(c, { propertyId: co.propertyId2, landlordId: co.landlordId }))
    await clean(co)
    expect(await costLines('expense', e.id, 'insurance')).toEqual(sorted([[co.propertyId, null, 300], [co.propertyId2, null, 100]]))
    // A cost on the same day logged after that unit was added counts it.
    const later = await createLandlordExpense({
      landlordId: co.landlordId, category: 'insurance', amount: 500, expenseDate: '2026-08-05', costPlace: 'split_by_units', payment: null,
    })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('expense', later.id, 'insurance')).toEqual(sorted([[co.propertyId, null, 300], [co.propertyId2, null, 200]]))
    await clean(co)
  })
})

// 10/13 review: the Bank page is where most costs are logged; a bank line
// going out may be split across the properties by units, and it posts so.
describe('a bank line filed split across the properties by units', () => {
  it('posts by units on its day, paid by the line; debits equal credits, no drift', async () => {
    const co = await ledgerCompany()
    await units(co)
    const connectionId = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
      [co.landlordId])).rows[0].id
    const line = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
       VALUES ($1, $2, $3, '2026-10-05', -400, 'STATE FARM INS', 'STATE FARM INS', 'needs_review', 'posted') RETURNING id`,
      [connectionId, co.landlordId, randomUUID()])).rows[0].id
    const r = await categorizeTransaction(co.landlordId, line, { category: 'insurance', scopeKind: 'split_by_units' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('expense', r.expenseId!, 'insurance')).toEqual(sorted([[co.propertyId, null, 300], [co.propertyId2, null, 100]]))
    await clean(co)
  })
})
