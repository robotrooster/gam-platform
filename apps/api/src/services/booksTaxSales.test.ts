/**
 * 10/17 (Nic) — what was sold, and what tax was collected, for the filing
 * (services/booksTaxSales, routes/booksTaxSales, and the one-time script that
 * gives the $0.87 of propane tax the name of the agency it is owed to).
 *
 * Real tables, the real register projectors, the real engine (it commits on its
 * own connections, so every test starts from a clean database).
 *
 * The numbers are production's, read 10/17: four gallons of propane at $3.30 =
 * $13.20 with $0.87 of transaction privilege tax, a $20.00 dump station, and a
 * week of RV site at $269.00 with $17.08 of lodging tax.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { addOtherIncome, ledgerCompany, type LedgerCompany } from '../test/ledgerFixtures'
import { registerP5, unregisterAll, sale, booking } from '../test/ledgerP5Fixtures'
import { markLedgerLive } from '../test/ledgerReportFixtures'
import { drainLedgerOutbox } from './ledgerEngine'
import { booksSalesAndTax } from './booksTaxSales'
import { checkOwner } from './ledgerCheck'
import { checkCompanyParity } from './ledgerParity'
import { planNameUnnamedSaleTaxes, applyNameUnnamedSaleTaxes } from '../scripts/oct17_name_unnamed_sale_taxes'
import { BOOKS_TAX_UNNAMED_LABEL, isNamedAgencyTax, PLACEHOLDER_TAX_NAME } from '@gam/shared'
import { cartTaxBreakdown } from '../routes/pos'
import { P6_LEDGER_PROJECTORS } from './ledgerProjectors/moneyOut'
import { registerLedgerProjector } from './ledgerEngine'
import { booksRouter } from '../routes/books'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_tax_sales'
  await cleanupAllSchema()
  registerP5()
})
afterEach(() => unregisterAll())

const TPT = 'Transaction privilege tax'
const LODGING = 'Lodging tax'
const SEPT = { start: '2026-09-01', end: '2026-09-30' }

/** A catalog item in its own category, optionally with a named tax assigned to it. */
async function catalogItem(co: LedgerCompany, c: {
  category: string; name: string; price: number; stayUnit?: 'night' | 'week' | 'month'
  tax?: { name: string; rate: number }
}): Promise<string> {
  const categoryId = (await db.query<{ id: string }>(
    `INSERT INTO pos_categories (landlord_id, name, property_id) VALUES ($1, $2, $3) RETURNING id`,
    [co.landlordId, c.category, co.propertyId])).rows[0].id
  const itemId = (await db.query<{ id: string }>(
    `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, tax_rate, stay_unit)
     VALUES ($1, $2, $3, $4, $5, 0, $6) RETURNING id`,
    [co.landlordId, co.propertyId, categoryId, c.name, c.price, c.stayUnit ?? null])).rows[0].id
  if (c.tax) {
    await db.query(
      `INSERT INTO pos_tax_rates (landlord_id, property_id, name, rate, applies_to, item_ids)
       VALUES ($1, $2, $3, $4, '{}'::text[], ARRAY[$5]::uuid[])`,
      [co.landlordId, co.propertyId, c.tax.name, c.tax.rate, itemId])
  }
  return itemId
}

/** Says which catalog item (and at which combined rate) a sale's line was, as the register records it. */
async function tagLine(saleId: string, line: { name: string; itemId: string; category: string; rate: number }): Promise<void> {
  const r = await db.query(
    `UPDATE pos_transaction_items SET item_id = $2, item_category = $3, tax_rate = $4
      WHERE transaction_id = $1 AND item_name = $5`,
    [saleId, line.itemId, line.category, line.rate, line.name])
  expect(r.rowCount, `no sale line named ${line.name}`).toBeGreaterThan(0)
}

const scopeOf = (co: LedgerCompany) => ({ landlordIds: [co.landlordId] })
const breakdown = (co: LedgerCompany, p = SEPT) => booksSalesAndTax(scopeOf(co), p.start, p.end, 'September 2026')

/** An account's balance on the books, by the code the chart gave it. */
async function accountBalance(co: LedgerCompany, code: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS n
       FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
      WHERE l.landlord_id = $1 AND a.code = $2`, [co.landlordId, code])
  return Math.round(Number(r.rows[0].n) * 100) / 100
}

// ─── (1) What was sold ───────────────────────────────────────────────────────

describe('what was sold', () => {
  it('itemizes every item with its quantity and its dollars, grouped by register category', async () => {
    const co = await ledgerCompany()
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    const dump = await catalogItem(co, { category: 'Services', name: 'Dump station', price: 20 })

    const s1 = await sale(co, {
      subtotal: 13.2, tax: 0.87, taxBreakdown: [{ name: TPT, rate: 0.066, amount: 0.87 }],
      at: '2026-09-29 22:08:00+00', items: [{ name: 'Propane', qty: 4, price: 3.3 }],
    })
    await tagLine(s1, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    const s2 = await sale(co, {
      subtotal: 21.78, tax: 1.44, taxBreakdown: [{ name: TPT, rate: 0.066, amount: 1.44 }],
      at: '2026-09-08 21:56:00+00', items: [{ name: 'Propane', qty: 6.6, price: 3.3 }],
    })
    await tagLine(s2, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    const s3 = await sale(co, { subtotal: 20, at: '2026-09-14 18:43:00+00', items: [{ name: 'Dump station', qty: 1, price: 20 }] })
    await tagLine(s3, { name: 'Dump station', itemId: dump, category: 'Services', rate: 0 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const data = await breakdown(co)
    expect(data.sales.salesCount).toBe(3)
    expect(data.sales.categories.map(c => [c.label, c.sales])).toEqual([
      // Biggest category first; "Propane · 10.6 · $34.98" is the whole month of it.
      ['Utilities', 34.98],
      ['Services', 20],
    ])
    expect(data.sales.categories[0].items).toEqual([
      { name: 'Propane', unit: null, qty: 10.6, sales: 34.98, salesCount: 2 },
    ])
    expect(data.sales.categories[1].items).toEqual([
      { name: 'Dump station', unit: null, qty: 1, sales: 20, salesCount: 1 },
    ])
  })

  it('ties to the cent to what the books posted to Register sales, through a discount, a stay, a background check and a cash card fee', async () => {
    const co = await ledgerCompany()
    const item = await catalogItem(co, { category: 'Store', name: 'Firewood', price: 10 })
    // A plain cash sale.
    const plain = await sale(co, { subtotal: 20, at: '2026-09-02 19:00:00+00', items: [{ name: 'Firewood', qty: 2, price: 10 }] })
    await tagLine(plain, { name: 'Firewood', itemId: item, category: 'Store', rate: 0 })
    // A discount, a background check GAM keeps, and a card fee the drawer took.
    const mixed = await sale(co, {
      subtotal: 50, discount: 5, screening: 30, surcharge: 2, at: '2026-09-03 19:00:00+00',
      items: [{ name: 'Firewood', qty: 5, price: 10 }],
    })
    await tagLine(mixed, { name: 'Firewood', itemId: item, category: 'Store', rate: 0 })
    // Money that paid toward a stay: held as a guest deposit, not register sales.
    const stayId = await booking(co, { checkIn: '2026-10-05', checkOut: '2026-10-08' })
    const toStay = await sale(co, {
      subtotal: 100, at: '2026-09-04 19:00:00+00', stay: { bookingId: stayId, toward: 60 },
      items: [{ name: 'Firewood', qty: 10, price: 10 }],
    })
    await tagLine(toStay, { name: 'Firewood', itemId: item, category: 'Store', rate: 0 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const { sales } = await breakdown(co)
    expect(sales.tie).toEqual({
      itemLines: 170,         // 20 + 50 + 100, at their prices
      discounts: 5,
      towardStays: 60,
      backgroundChecks: 30,
      cashSurcharge: 2,
      corrections: 0,
      posted: 77,             // 20 + (50 − 5 − 30 + 2) + (100 − 60)
      difference: 0,
      returns: 0,
    })
    expect(sales.tie.posted).toBe(await accountBalance(co, '4500'))
  })

  it('shows money given back beside the total, never inside it', async () => {
    const co = await ledgerCompany()
    const item = await catalogItem(co, { category: 'Store', name: 'Firewood', price: 10 })
    const s = await sale(co, { subtotal: 20, at: '2026-09-02 19:00:00+00', items: [{ name: 'Firewood', qty: 2, price: 10 }] })
    await tagLine(s, { name: 'Firewood', itemId: item, category: 'Store', rate: 0 })
    await db.query(
      `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, card_fee_refunded, tax_refunded, created_at)
       VALUES ($1, $2, 10, 'cash', 0, 0, '2026-09-05 19:00:00+00')`, [s, co.landlordId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const { sales } = await breakdown(co)
    expect(sales.tie.posted).toBe(20)
    expect(sales.tie.returns).toBe(10)
    expect(sales.tie.difference).toBe(0)
  })
})

// ─── (1b) The other half Nic named: "other income" ──────────────────────────

describe('other money in (what the account called "other income" actually was)', () => {
  /** The other-income projector, which is phase P6's, beside the register set. */
  function registerP6(): void {
    for (const p of P6_LEDGER_PROJECTORS) registerLedgerProjector(p)
  }

  /** The company's own name for a kind of money in, pointed at Other income. */
  async function incomeCategory(co: LedgerCompany, name: string): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO books_categories (landlord_id, direction, name, default_role)
       VALUES ($1, 'income', $2, 'other_income') RETURNING id`, [co.landlordId, name])).rows[0].id
  }

  it('names each lump by its category, its own words and who paid it — and adds up to the account', async () => {
    const co = await ledgerCompany()
    registerP6()
    // Production's Mountain View rows, read 10/17: Square card sales from
    // before the GAM card reader, logged as lumps, $457.43 in all.
    const square = await incomeCategory(co, 'Square (pre-reader)')
    const words = 'Square card sales before the GAM card reader (propane, overnight stays)'
    for (const [amount, day] of [[72.13, '2026-09-10'], [251.05, '2026-09-21'], [24.13, '2026-09-23'], [61.73, '2026-09-29']] as [number, string][]) {
      const id = await addOtherIncome(co, { amount, day })
      await db.query(
        `UPDATE landlord_other_income SET category_id = $2, description = $3, payer = 'Square' WHERE id = $1`,
        [id, square, words])
    }
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const { otherIncome } = await breakdown(co)
    expect(otherIncome.rows).toEqual([{
      accountCode: '4900', accountName: 'Other income',
      category: 'Square (pre-reader)', label: 'Square (pre-reader)',
      description: words, payer: 'Square',
      amount: 409.04, records: 4, lumpSum: true,
    }])
    // It adds up to the account itself, to the cent — the list can never say
    // something the books do not.
    expect(otherIncome.total).toBe(await accountBalance(co, '4900'))
    // And the page can say the sentence she needs before filing: none of it
    // recorded any tax inside it.
    expect(otherIncome.noTaxSplit).toBe(409.04)
  })

  it('money in with a category of its own is its own line, and interest is not called a lump', async () => {
    const co = await ledgerCompany()
    registerP6()
    const laundry = (await db.query<{ id: string }>(
      `INSERT INTO books_categories (landlord_id, direction, name, default_role)
       VALUES ($1, 'income', 'Laundry', 'laundry_vending') RETURNING id`, [co.landlordId])).rows[0].id
    const washers = await addOtherIncome(co, { amount: 75, day: '2026-09-04' })
    await db.query(`UPDATE landlord_other_income SET category_id = $2, description = 'Washers and dryers' WHERE id = $1`, [washers, laundry])
    const plain = await addOtherIncome(co, { amount: 20, day: '2026-09-06' })
    await db.query(`UPDATE landlord_other_income SET description = NULL WHERE id = $1`, [plain])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const { otherIncome } = await breakdown(co)
    expect(otherIncome.rows.map(r => [r.label, r.accountCode, r.description, r.amount])).toEqual([
      ['Laundry', '4050', 'Washers and dryers', 75],
      // Filed under no category of its own: shown by the account it landed on.
      ['Other income', '4900', null, 20],
    ])
    expect(otherIncome.total).toBe(95)
    expect(otherIncome.total).toBe(round2(await accountBalance(co, '4050') + await accountBalance(co, '4900')))
  })

  it('a company that filed nothing as other income gets an empty list, not a zero row', async () => {
    const co = await ledgerCompany()
    registerP6()
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const { otherIncome } = await breakdown(co)
    expect(otherIncome).toEqual({ rows: [], total: 0, noTaxSplit: 0 })
  })
})

const round2 = (n: number) => Math.round(n * 100) / 100

// ─── (2) What tax was collected ──────────────────────────────────────────────

describe('what tax was collected', () => {
  it('one line per named tax: the sales it was charged on, the rate, what was collected, and the account it sits in', async () => {
    const co = await ledgerCompany()
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    const site = await catalogItem(co, { category: 'Stays', name: 'RV site — weekly', price: 269, stayUnit: 'week', tax: { name: LODGING, rate: 0.066 } })

    // Propane, at the rate it was charged at then (6.35%) and the rate now (6.6%).
    const old = await sale(co, {
      subtotal: 42.9, tax: 2.72, taxBreakdown: [{ name: TPT, rate: 0.0635, amount: 2.72 }],
      at: '2026-09-24 21:58:00+00', items: [{ name: 'Propane', qty: 13, price: 3.3 }],
    })
    await tagLine(old, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.0635 })
    const now = await sale(co, {
      subtotal: 13.2, tax: 0.87, taxBreakdown: [{ name: TPT, rate: 0.066, amount: 0.87 }],
      at: '2026-09-29 22:08:00+00', items: [{ name: 'Propane', qty: 4, price: 3.3 }],
    })
    await tagLine(now, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    // A week of RV site: lodging tax, its own account.
    const stay = await sale(co, {
      subtotal: 269, tax: 17.08, taxBreakdown: [{ name: LODGING, rate: 0.0635, amount: 17.08 }],
      at: '2026-09-17 17:58:00+00', items: [{ name: 'RV site — weekly', qty: 1, price: 269 }],
    })
    await tagLine(stay, { name: 'RV site — weekly', itemId: site, category: 'Stays', rate: 0.0635 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const { taxes } = await breakdown(co)
    const tpt = taxes.rows.find(r => r.taxName === TPT)!
    const lodging = taxes.rows.find(r => r.taxName === LODGING)!

    // Each agency's money is in its own account, named.
    expect(tpt.accountCode).toBe('2040-1')
    expect(tpt.accountName).toContain(TPT)
    expect(tpt.accountRole).toBe('sales_tax_payable')
    expect(lodging.accountCode).toBe('2042')
    expect(lodging.accountRole).toBe('lodging_tax_payable')

    // Collected is the account's own figure; nothing has been sent on yet, so
    // all of it is still owed to the agency.
    expect([tpt.collected, tpt.paid, tpt.unpaid]).toEqual([3.59, 0, 3.59])
    expect([lodging.collected, lodging.paid, lodging.unpaid]).toEqual([17.08, 0, 17.08])
    expect(tpt.collected).toBe(await accountBalance(co, '2040-1'))
    expect(lodging.collected).toBe(await accountBalance(co, '2042'))

    // A rate change in the period is two rows, each with the sales behind it,
    // read off the sale's own lines — not worked back from the tax.
    expect(tpt.rates).toEqual([
      { rate: 0.0635, taxableSales: 42.9, estimated: false, collected: 2.72 },
      { rate: 0.066, taxableSales: 13.2, estimated: false, collected: 0.87 },
    ])
    expect(tpt.taxableSales).toBe(56.1)
    expect(tpt.estimated).toBe(false)
    expect(lodging.rates).toEqual([{ rate: 0.0635, taxableSales: 269, estimated: false, collected: 17.08 }])

    // The rate rows always add up to the account's figure.
    expect(tpt.rates.reduce((a, r) => a + Math.round(r.collected * 100), 0)).toBe(Math.round(tpt.collected * 100))
    expect(taxes.totals.collected).toBe(20.67)
    expect(taxes.totals.unpaid).toBe(20.67)
  })

  it('a tax sent on to the agency comes off what is still owed, and a refunded tax comes off Collected', async () => {
    const co = await ledgerCompany()
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    const s = await sale(co, {
      subtotal: 13.2, tax: 0.87, taxBreakdown: [{ name: TPT, rate: 0.066, amount: 0.87 }],
      at: '2026-09-29 22:08:00+00', items: [{ name: 'Propane', qty: 4, price: 3.3 }],
    })
    await tagLine(s, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    // Half of it handed back to the customer at the register.
    await db.query(
      `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, card_fee_refunded, tax_refunded, created_at)
       VALUES ($1, $2, 6.93, 'cash', 0, 0.43, '2026-09-30 19:00:00+00')`, [s, co.landlordId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const { taxes } = await breakdown(co)
    const tpt = taxes.rows.find(r => r.taxName === TPT)!
    // 10/12 (ledger review): tax given back comes off Collected and is never
    // "paid to the government".
    expect(tpt.collected).toBe(0.44)
    expect(tpt.paid).toBe(0)
    expect(tpt.unpaid).toBe(0.44)
    expect(tpt.unpaid).toBe(await accountBalance(co, '2040-1'))

    // 10/17 (review): AND THE TAXABLE SALES COME DOWN WITH IT. Collected is the
    // account's figure, which a refund reduces; a base still reading the whole
    // $13.20 beside $0.44 of tax is an implied 3.3% — arithmetic no agency
    // takes.
    //
    // The base that came off is the base the REFUNDED TAX was charged on:
    // $0.43 at 6.6% is $6.52, so $6.68 of the propane stayed sold. (The refund
    // recorded a round $0.43 where 6.6% of $6.50 is $0.429, which is why it is
    // not exactly the $6.50 of goods handed back — the refund's own tax figure
    // is the authority for both columns, so they can never disagree.)
    expect(tpt.taxableSales).toBe(6.68)
    expect(tpt.estimated).toBe(false)
    expect(tpt.rates).toEqual([{ rate: 0.066, taxableSales: 6.68, estimated: false, collected: 0.44 }])
    // The row is submittable: base × rate is the tax collected, to the cent.
    expect(Math.round(tpt.taxableSales * 0.066 * 100) / 100).toBe(tpt.collected)
  })

  it('two taxes stacked on one line: the base is worked back from the money, and the row says so', async () => {
    const co = await ledgerCompany()
    // 10/17 (review): a line records the COMBINED rate of every tax on it
    // (posTax effectiveItemTaxes), so neither of two stacked taxes matches it.
    // Propane carries the privilege tax alone; firewood carries it plus a town
    // tax, so firewood's line reads 8.6% and the privilege tax's 6.6% misses
    // it. Read off the lines, the base would be the propane only — $100
    // against $13.20 of tax, an implied 13.2%.
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 100, tax: { name: TPT, rate: 0.066 } })
    const wood = await catalogItem(co, { category: 'Store', name: 'Firewood', price: 100, tax: { name: TPT, rate: 0.066 } })
    const s = await sale(co, {
      subtotal: 200, tax: 15.2, taxBreakdown: [{ name: TPT, rate: 0.066, amount: 13.2 }, { name: 'Town tax', rate: 0.02, amount: 2 }],
      at: '2026-09-12 19:00:00+00', items: [{ name: 'Propane', qty: 1, price: 100 }, { name: 'Firewood', qty: 1, price: 100 }],
    })
    await tagLine(s, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    await tagLine(s, { name: 'Firewood', itemId: wood, category: 'Store', rate: 0.086 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const { taxes } = await breakdown(co)
    const tpt = taxes.rows.find(r => r.taxName === TPT)!
    expect(tpt.collected).toBe(13.2)
    // $13.20 at 6.6% was charged on $200 of sales, not $100 — and the page says
    // the figure was derived rather than read.
    expect(tpt.taxableSales).toBe(200)
    expect(tpt.estimated).toBe(true)
    expect(tpt.rates).toEqual([{ rate: 0.066, taxableSales: 200, estimated: true, collected: 13.2 }])
    // The town gets its own line and its own base — $2 at 2% was charged on
    // the $100 of firewood. Its own lines cannot say so either (the firewood
    // line records 8.6%, the two taxes added together), so it is derived too
    // and says so, rather than reading $0 of taxable sales beside $2 of tax.
    const town = taxes.rows.find(r => r.taxName === 'Town tax')!
    expect([town.collected, town.taxableSales, town.estimated]).toEqual([2, 100, true])
  })

  it('a sale that never recorded which tax it was shows on its own line, named, and last', async () => {
    const co = await ledgerCompany()
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    const named = await sale(co, {
      subtotal: 42.9, tax: 2.83, taxBreakdown: [{ name: TPT, rate: 0.066, amount: 2.83 }],
      at: '2026-09-24 21:58:00+00', items: [{ name: 'Propane', qty: 13, price: 3.3 }],
    })
    await tagLine(named, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    // Production's 9/29 pay link: $13.20 of propane, $0.87 of tax, no names.
    const unnamed = await sale(co, {
      method: 'card', subtotal: 13.2, tax: 0.87, surcharge: 1.04, platformFee: 1.04, held: 14.07, payLink: true,
      at: '2026-09-29 22:08:00+00', items: [{ name: 'Propane', qty: 4, price: 3.3 }],
    })
    await tagLine(unnamed, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const { taxes } = await breakdown(co)
    const last = taxes.rows[taxes.rows.length - 1]
    expect(last.unnamed).toBe(true)
    expect(last.label).toBe(BOOKS_TAX_UNNAMED_LABEL)
    expect(last.accountCode).toBe('2040')
    expect(last.collected).toBe(0.87)
    expect(last.unpaid).toBe(0.87)
    // It has no rate and no taxable sales: nothing on the sale says what it was.
    expect(last.rates).toEqual([])
    expect(last.taxableSales).toBe(0)
    // The named tax is unaffected and still ties to its own account.
    const tpt = taxes.rows.find(r => r.taxName === TPT)!
    expect(tpt.collected).toBe(2.83)
    expect(tpt.accountCode).toBe('2040-1')
  })
})

// ─── (3) The correction: the $0.87 gets its agency's name ────────────────────

describe('naming the taxes a sale never recorded (scripts/oct17_name_unnamed_sale_taxes)', () => {
  /** Production's 9/29 pay link, in a test company: $13.20 of propane, $0.87 of tax, no names. */
  async function thePropaneSale(): Promise<{ co: LedgerCompany; saleId: string; itemId: string }> {
    const co = await ledgerCompany()
    const itemId = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    const saleId = await sale(co, {
      method: 'card', subtotal: 13.2, tax: 0.87, surcharge: 1.04, platformFee: 1.04, held: 14.07, payLink: true,
      at: '2026-09-29 22:08:00+00', items: [{ name: 'Propane', qty: 4, price: 3.3 }],
    })
    await tagLine(saleId, { name: 'Propane', itemId, category: 'Utilities', rate: 0.066 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    return { co, saleId, itemId }
  }

  it('the dry run finds it, says what it would name, and writes nothing', async () => {
    const { co, saleId } = await thePropaneSale()
    expect(await accountBalance(co, '2040')).toBe(0.87)

    const plan = await planNameUnnamedSaleTaxes(db, [{ landlordId: co.landlordId, name: 'Test co' }])
    expect(plan.sales).toHaveLength(1)
    expect(plan.writable).toHaveLength(1)
    const s = plan.sales[0]
    expect(s.saleId).toBe(saleId)
    expect(s.taxAmount).toBe('0.87')
    expect(s.viaPayLink).toBe(true)
    expect(s.lines).toEqual(['Propane × 4 @ $3.30 = $13.20'])
    expect(s.accountNow).toContain('2040 Sales tax payable')
    expect(s.named).toEqual([{ name: TPT, rate: 0.066, amount: 0.87 }])
    expect(s.skipped).toBeNull()

    // Nothing written: the sale still records nothing and the money has not moved.
    const row = await db.query<{ b: unknown }>(`SELECT tax_breakdown AS b FROM pos_transactions WHERE id = $1`, [saleId])
    expect(row.rows[0].b).toBeNull()
    expect(await accountBalance(co, '2040')).toBe(0.87)
  })

  it('--apply names it, the books re-post it to the named account, and the generic one empties — same money, to the cent', async () => {
    const { co, saleId } = await thePropaneSale()
    const plan = await planNameUnnamedSaleTaxes(db, [{ landlordId: co.landlordId, name: 'Test co' }])
    expect(await applyNameUnnamedSaleTaxes(db, plan)).toBe(1)
    // The sale's own capture trigger marked it for posting again; the engine
    // takes the old posting back and posts it on the named account.
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    expect(await accountBalance(co, '2040')).toBe(0)
    expect(await accountBalance(co, '2040-1')).toBe(0.87)
    const lines = await db.query<{ code: string; tax_name: string | null }>(
      `SELECT a.code, l.tax_name FROM ledger_posting_lines l
         JOIN ledger_postings ps ON ps.id = l.posting_id
         JOIN books_accounts a ON a.id = l.account_id
        WHERE ps.source_type = 'pos_sale' AND ps.source_id = $1 AND ps.role = 'post' AND ps.superseded_at IS NULL
          AND l.account_role = 'sales_tax_payable'`, [saleId])
    expect(lines.rows).toEqual([{ code: '2040-1', tax_name: TPT }])

    // The customer paid what they paid; only the name is new.
    const row = await db.query<{ tax: string }>(`SELECT tax_amount::text AS tax FROM pos_transactions WHERE id = $1`, [saleId])
    expect(row.rows[0].tax).toBe('0.87')

    // The breakdown has no unnamed line left, and the agency's figure is right.
    const { taxes } = await breakdown(co)
    expect(taxes.rows.filter(r => r.unnamed)).toEqual([])
    const tpt = taxes.rows.find(r => r.taxName === TPT)!
    expect([tpt.collected, tpt.unpaid, tpt.taxableSales]).toEqual([0.87, 0.87, 13.2])
  })

  it('run again, it finds nothing to do', async () => {
    const { co } = await thePropaneSale()
    const first = await planNameUnnamedSaleTaxes(db, [{ landlordId: co.landlordId, name: 'Test co' }])
    await applyNameUnnamedSaleTaxes(db, first)
    const again = await planNameUnnamedSaleTaxes(db, [{ landlordId: co.landlordId, name: 'Test co' }])
    expect(again.sales).toEqual([])
    expect(again.writable).toEqual([])
    expect(await applyNameUnnamedSaleTaxes(db, again)).toBe(0)
  })

  it('refuses to name a sale whose tax today\'s rates do not agree with — one agency\'s money never gets another\'s name', async () => {
    const co = await ledgerCompany()
    // 10/17 (review): the sale charged 6.35% ($2.72 on $42.90) and the company's
    // rate reads 6.6% today. Scaling what resolved up to the sale's own tax
    // would stamp the privilege tax at a rate it never charged, and on a mixed
    // sale would hand it money charged for something else entirely.
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    const saleId = await sale(co, {
      subtotal: 42.9, tax: 2.72, at: '2026-09-24 21:58:00+00', items: [{ name: 'Propane', qty: 13, price: 3.3 }],
    })
    await tagLine(saleId, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.0635 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const plan = await planNameUnnamedSaleTaxes(db, [{ landlordId: co.landlordId, name: 'Test co' }])
    expect(plan.sales).toHaveLength(1)
    expect(plan.writable).toEqual([])
    expect(plan.sales[0].named).toEqual([])
    expect(plan.sales[0].skipped).toContain('would charge $2.83 of tax')
    expect(plan.sales[0].skipped).toContain('the sale charged $2.72')
    expect(await applyNameUnnamedSaleTaxes(db, plan)).toBe(0)
    // Its money stays where it is, visible as a tax with no agency.
    expect(await accountBalance(co, '2040')).toBe(2.72)
    const { taxes } = await breakdown(co)
    expect(taxes.rows.some(r => r.unnamed)).toBe(true)
  })

  it('refuses a sale that paid toward a stay: a lodging tax is the property\'s percentage, not the catalog\'s', async () => {
    const co = await ledgerCompany()
    // A mixed sale with no names on it: propane the catalog knows, plus money
    // toward a stay whose lodging tax is priced off the property. Naming it
    // from the catalog would stamp the town's money with the state's name.
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    const stayId = await booking(co, { checkIn: '2026-10-05', checkOut: '2026-10-08' })
    const saleId = await sale(co, {
      subtotal: 113.2, tax: 7.22, at: '2026-09-30 19:00:00+00', stay: { bookingId: stayId, toward: 100 },
      items: [{ name: 'Propane', qty: 4, price: 3.3 }],
    })
    await tagLine(saleId, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const plan = await planNameUnnamedSaleTaxes(db, [{ landlordId: co.landlordId, name: 'Test co' }])
    expect(plan.sales).toHaveLength(1)
    expect(plan.writable).toEqual([])
    expect(plan.sales[0].skipped).toContain('paid toward a stay')
    expect(await applyNameUnnamedSaleTaxes(db, plan)).toBe(0)
    const row = await db.query<{ b: unknown }>(`SELECT tax_breakdown AS b FROM pos_transactions WHERE id = $1`, [saleId])
    expect(row.rows[0].b).toBeNull()
  })

  it('leaves a sale it cannot name alone, and says why', async () => {
    const co = await ledgerCompany()
    // A line the cashier typed: no catalog item, so no rate of the company's
    // can be resolved and no agency can be named.
    const saleId = await sale(co, {
      subtotal: 10, tax: 0.66, at: '2026-09-11 19:00:00+00', items: [{ name: 'Walk-up something', qty: 1, price: 10 }],
    })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const plan = await planNameUnnamedSaleTaxes(db, [{ landlordId: co.landlordId, name: 'Test co' }])
    expect(plan.sales).toHaveLength(1)
    expect(plan.writable).toEqual([])
    expect(plan.sales[0].skipped).toContain('catalog item')
    expect(await applyNameUnnamedSaleTaxes(db, plan)).toBe(0)
    const row = await db.query<{ b: unknown }>(`SELECT tax_breakdown AS b FROM pos_transactions WHERE id = $1`, [saleId])
    expect(row.rows[0].b).toBeNull()
    // It stays visible as a tax with no name, so it is never silently filed.
    const { taxes } = await breakdown(co)
    expect(taxes.rows.some(r => r.unnamed)).toBe(true)
  })
})

// ─── The write path: what a goods pay link is allowed to name ───────────────

describe('a goods pay link names only an agency (routes/posPayLinks)', () => {
  /**
   * 10/17 (review): the link's own composition — cartTaxBreakdown filtered by
   * isNamedAgencyTax — because what it resolves is what gets written onto the
   * sale and therefore which chart account the agency's money lands in.
   */
  const linkNames = async (co: LedgerCompany, items: any[]) =>
    (await cartTaxBreakdown(co.landlordId, items)).filter(isNamedAgencyTax)

  it('a company with a named rate gets the agency on it', async () => {
    const co = await ledgerCompany()
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    expect(await linkNames(co, [{ id: propane, name: 'Propane', qty: 4, price: 3.3 }]))
      .toEqual([{ name: TPT, rate: 0.066, amount: 0.87 }])
  })

  it('a company with no named rate at all names NOTHING — never a tax called "Tax"', async () => {
    const co = await ledgerCompany()
    // No pos_tax_rates row: the item carries its own bare rate, which names no
    // department. Unfiltered, the resolution hands back the placeholder.
    const categoryId = (await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, property_id) VALUES ($1, 'Store', $2) RETURNING id`,
      [co.landlordId, co.propertyId])).rows[0].id
    const itemId = (await db.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, tax_rate)
       VALUES ($1, $2, $3, 'Firewood', 10, 0.066) RETURNING id`, [co.landlordId, co.propertyId, categoryId])).rows[0].id
    const items = [{ id: itemId, name: 'Firewood', qty: 1, price: 10 }]
    const raw = await cartTaxBreakdown(co.landlordId, items)
    expect(raw.map(t => t.name)).toEqual([PLACEHOLDER_TAX_NAME])
    // Filtered — what the pay link writes — it is nothing, so the sale records
    // no name, the money lands on the generic Sales tax payable, and the
    // breakdown shows it by name as a tax with no agency.
    expect(await linkNames(co, items)).toEqual([])
  })
})

// ─── The route ───────────────────────────────────────────────────────────────

describe('GET /api/books/tax/sales-breakdown', () => {
  function buildApp() {
    const app = express()
    app.use(express.json())
    app.use('/api/books', booksRouter)
    app.use(errorHandler)
    return app
  }
  const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
  const ownerTok = (co: LedgerCompany) => sign({
    userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {},
  })
  const URL = `/api/books/tax/sales-breakdown?startDate=${SEPT.start}&endDate=${SEPT.end}`

  async function soldCompany(): Promise<LedgerCompany> {
    const co = await ledgerCompany()
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    const s = await sale(co, {
      subtotal: 13.2, tax: 0.87, taxBreakdown: [{ name: TPT, rate: 0.066, amount: 0.87 }],
      at: '2026-09-29 22:08:00+00', items: [{ name: 'Propane', qty: 4, price: 3.3 }],
    })
    await tagLine(s, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    return co
  }

  it('a company whose books are not live is told why, instead of a page of zeros', async () => {
    const co = await soldCompany()
    const res = await request(buildApp()).get(URL).set('Authorization', `Bearer ${ownerTok(co)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.live).toBe(false)
    expect(typeof res.body.data.reason).toBe('string')
  })

  it('the owner gets the items, the tie and each named tax once the books are live', async () => {
    const co = await soldCompany()
    await markLedgerLive(co.landlordId)
    const res = await request(buildApp()).get(URL).set('Authorization', `Bearer ${ownerTok(co)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.live).toBe(true)
    expect(res.body.data.period).toMatchObject({ start: SEPT.start, end: SEPT.end })
    expect(res.body.data.sales.categories[0].items[0]).toMatchObject({ name: 'Propane', qty: 4, sales: 13.2 })
    expect(res.body.data.sales.tie.difference).toBe(0)
    expect(res.body.data.taxes.rows[0]).toMatchObject({ taxName: TPT, accountCode: '2040-1', collected: 0.87, unpaid: 0.87 })
  })

  it('one property at a time, and a property the viewer does not keep is refused', async () => {
    const co = await soldCompany()
    await markLedgerLive(co.landlordId)
    const mine = await request(buildApp())
      .get(`${URL}&property=${co.propertyId}`).set('Authorization', `Bearer ${ownerTok(co)}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data.sales.tie.posted).toBe(13.2)
    // The company's other property sold nothing.
    const other = await request(buildApp())
      .get(`${URL}&property=${co.propertyId2}`).set('Authorization', `Bearer ${ownerTok(co)}`)
    expect(other.status).toBe(200)
    expect(other.body.data.sales.categories).toEqual([])
    expect(other.body.data.sales.tie.posted).toBe(0)
  })

  it('a bookkeeper on some properties is refused a company document in plain words', async () => {
    const co = await soldCompany()
    await markLedgerLive(co.landlordId)
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
    await db.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide, company_ledger, access_level)
       VALUES ($1, $2, ARRAY[$3]::uuid[], FALSE, FALSE, 'read_only')`, [userId, co.landlordId, co.propertyId])
    const tok = sign({ userId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: co.landlordId, permissions: { access_level: 'read_only' } })
    const res = await request(buildApp()).get(URL).set('Authorization', `Bearer ${tok}`).set('X-Client-Id', co.landlordId)
    expect(res.status).toBe(403)
    expect(String(res.body.error)).toMatch(/company/i)
  })

  it('a bookkeeper with the whole-company ledger box gets it', async () => {
    const co = await soldCompany()
    await markLedgerLive(co.landlordId)
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
    await db.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide, company_ledger, whole_company_reports, access_level)
       VALUES ($1, $2, ARRAY[$3]::uuid[], FALSE, TRUE, TRUE, 'read_only')`, [userId, co.landlordId, co.propertyId])
    const tok = sign({ userId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: co.landlordId, permissions: { access_level: 'read_only' } })
    const res = await request(buildApp()).get(URL).set('Authorization', `Bearer ${tok}`).set('X-Client-Id', co.landlordId)
    expect(res.status).toBe(200)
    expect(res.body.data.taxes.rows[0]).toMatchObject({ accountCode: '2040-1', collected: 0.87 })
  })
})

// ─── The proof the books still hold ─────────────────────────────────────────

describe('after the correction the books still tie', () => {
  it('debits equal credits, nothing drifted, and the parity check has nothing unexplained', async () => {
    const co = await ledgerCompany()
    const propane = await catalogItem(co, { category: 'Utilities', name: 'Propane', price: 3.3, tax: { name: TPT, rate: 0.066 } })
    // The 9/29 pay link, unnamed, beside a counter sale that named its tax.
    const counter = await sale(co, {
      subtotal: 42.9, tax: 2.83, taxBreakdown: [{ name: TPT, rate: 0.066, amount: 2.83 }],
      at: '2026-09-24 21:58:00+00', items: [{ name: 'Propane', qty: 13, price: 3.3 }],
    })
    await tagLine(counter, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    const link = await sale(co, {
      method: 'card', subtotal: 13.2, tax: 0.87, surcharge: 1.04, platformFee: 1.04, held: 14.07, payLink: true,
      at: '2026-09-29 22:08:00+00', items: [{ name: 'Propane', qty: 4, price: 3.3 }],
    })
    await tagLine(link, { name: 'Propane', itemId: propane, category: 'Utilities', rate: 0.066 })
    await drainLedgerOutbox()

    const before = await breakdown(co)
    const plan = await planNameUnnamedSaleTaxes(db, [{ landlordId: co.landlordId, name: 'Test co' }])
    expect(await applyNameUnnamedSaleTaxes(db, plan)).toBe(1)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const after = await breakdown(co)

    // Debits equal credits, on every posting and over the whole company.
    const sides = await db.query<{ dr: string; cr: string; off: number }>(
      `SELECT SUM(l.debit)::text AS dr, SUM(l.credit)::text AS cr,
              (SELECT COUNT(*)::int FROM (
                 SELECT posting_id FROM ledger_posting_lines WHERE landlord_id = $1
                  GROUP BY posting_id, property_id HAVING SUM(debit) <> SUM(credit)) q) AS off
         FROM ledger_posting_lines l WHERE l.landlord_id = $1`, [co.landlordId])
    expect(sides.rows[0].dr).toBe(sides.rows[0].cr)
    expect(sides.rows[0].off).toBe(0)

    // The ledger's own integrity and drift checks find nothing.
    const check = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])

    // The parity check against the money records explains everything.
    const parity = await checkCompanyParity(co.landlordId, '2026-10-17')
    expect(parity.unexplained).toBe(0)

    // The same money, differently named: the breakdown's totals do not move,
    // only which agency's bucket the $0.87 is in.
    expect(after.taxes.totals.collected).toBe(before.taxes.totals.collected)
    expect(after.sales.tie).toEqual(before.sales.tie)
    expect(before.taxes.rows.some(r => r.unnamed)).toBe(true)
    expect(after.taxes.rows.some(r => r.unnamed)).toBe(false)
    expect(after.taxes.rows).toHaveLength(1)
    expect(after.taxes.rows[0]).toMatchObject({ taxName: TPT, accountCode: '2040-1', collected: 3.7, unpaid: 3.7 })
  })
})
