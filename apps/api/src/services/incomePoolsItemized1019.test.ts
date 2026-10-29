/**
 * 10/19 (Nic) — MONEY IN SHOWS THE LINES THE BOOKS KEEP.
 *
 *   "i need the books breakdown for september mountain view. it still looks
 *    the same for betty she doesnt see any new information."
 *   "We need to make the books actually display the right way. So that she can
 *    see it if she needs to go back to it later."
 *
 * The itemization built on 10/17 works underneath — rent books to the line of
 * the space it is for — and never reached the page a bookkeeper reads, which
 * grouped rent by payment cadence instead. These tests hold the page to the
 * books: the rows are the ledger's lines, the cadence is still there beside
 * them, register money names its items, a hand-logged lump keeps its own words,
 * and every column still adds up to the figure it added up to before.
 *
 * One company, September 2026, built to look like Mountain View:
 *   property 1  an RV space, $1,000 rent due 9/1, paid in cash 9/3
 *               13 gallons of propane sold at the counter 9/24 ($42.90 + tax)
 *               a $72.13 lump logged as other money in on 9/10
 *   property 2  a mobile home space (tenant-owned trailer), $600 rent due 9/1,
 *               never paid
 *               a park-owned trailer at $650, lot rent $300 of it
 *   10/19 (review) with `monthStay`, three RV sites' worth of month stay:
 *               30 nights sold by the month, which the books post to RV
 *               long-term rent — rent on a rent row with no lease behind it
 *
 * The rent here does not post on a database built from production's schema
 * alone, so run it with the unapplied migrations:
 *
 *   DB_NAME=<yours>_test TEST_APPLY_MIGRATIONS_AFTER=20261020125959 npx vitest run services/incomePoolsItemized1019
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { LEDGER_RENT_LINE_LABEL, RENT_POOL_LABEL } from '@gam/shared'
import { db } from '../db'
import { incomePools, type IncomePools, type PoolRow } from './incomePools'
import { bill, cleanupTenantLedger, drain, receipt, tenantCo, type TenantCo } from '../test/ledgerTenantFixtures'
import { inTx } from '../test/ledgerFixtures'
import { seedLease, seedLeaseTenant, seedUnit } from '../test/dbHelpers'
import { markLedgerLive } from '../test/ledgerReportFixtures'
import { booking, sale, siteDeposit } from '../test/ledgerP5Fixtures'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'

const SEPTEMBER = { start: '2026-09-01', end: '2026-09-30' }
const LUMP = 'Square card sales before the GAM card reader (propane, overnight stays)'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

/**
 * A space of its own type, with a lease on it. The unit is INSERTED with
 * everything that decides where its rent books — its type, who owns the home on
 * it, its lot rent — and never updated into it: the projectors read a space as
 * it stood WHEN THE MONEY WAS MADE, from the change journal, so a space changed
 * after the fact reads as what it used to be (ledgerProjectors/incomeLines).
 */
async function space(co: TenantCo, o: {
  propertyId: string; number: string; unitType: string; rent: number
  /** units.dwelling_ownership — 'landlord' is a park-owned trailer (its lot rent splits out). */
  homeOwner?: 'landlord' | 'tenant'; lotRent?: number
}): Promise<{ unitId: string; leaseId: string }> {
  return inTx(async (c) => {
    const unitId = (await c.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, unit_type, dwelling_ownership, lot_rent_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [o.propertyId, co.landlordId, o.number, o.rent, o.unitType, o.homeOwner ?? 'tenant', o.lotRent ?? 0])).rows[0].id
    const leaseId = await seedLease(c, { unitId, landlordId: co.landlordId, rentAmount: o.rent })
    await seedLeaseTenant(c, { leaseId, tenantId: co.tenantId })
    return { unitId, leaseId }
  })
}

/** Money somebody logged as other money in, in their own words. */
async function lump(co: TenantCo, o: { amount: number; day: string; words: string; payer?: string }): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date, description, payer)
     VALUES ($1, $2, 'other', $3, $4, $5, $6) RETURNING id`,
    [co.landlordId, co.propertyId, o.amount.toFixed(2), o.day, o.words, o.payer ?? null])
  return r.rows[0].id
}

/**
 * 10/19 (review): a month stay on an RV site of its own — 30 nights SOLD BY
 * THE MONTH, which the books post to RV long-term rent, because a month stay
 * is long-term at any length (Nic 10/14). It is rent sitting on a rent row
 * with no lease behind it, which is exactly the money the cadence card used to
 * drop on the floor: at Mountain View in October that was $1,178.00 charged
 * and $1,767.00 received, under a card that says on screen it is the same
 * money as the rent rows.
 */
async function monthStay(co: TenantCo, o: { toward: number; at: string }): Promise<void> {
  const unitId = await inTx(c => seedUnit(c, { propertyId: co.propertyId, landlordId: co.landlordId, unitType: 'rv_spot' }))
  const site = { ...co, unitId }
  const id = await booking(site, {
    checkIn: '2026-09-01', checkOut: '2026-10-01', leaseType: 'month_to_month', stayTerms: 'stay', total: o.toward,
  })
  await siteDeposit(site, id, { toward: o.toward, lodgingTax: 0, held: o.toward, at: o.at })
}

interface Space { unitId: string; leaseId: string }
interface World { co: TenantCo; rv: Space; mh: Space; parkOwned: Space }

async function world(o: { live?: boolean; monthStay?: boolean } = {}): Promise<World> {
  const co = await tenantCo()
  const rv = await space(co, { propertyId: co.propertyId, number: 'RV 10', unitType: 'rv_spot', rent: 1000 })
  const mh = await space(co, { propertyId: co.propertyId2, number: 'MH 09', unitType: 'mobile_home', rent: 600 })
  // A trailer the park owns: its lot rent is lot rent, the rest trailer rent (Nic I4/I5).
  const parkOwned = await space(co, {
    propertyId: co.propertyId2, number: 'MH 12', unitType: 'mobile_home', rent: 650, homeOwner: 'landlord', lotRent: 300,
  })
  const rent = await bill(co, { amount: 1000, due: '2026-09-01', unitId: rv.unitId, leaseId: rv.leaseId })
  await receipt(co, {
    method: 'cash', settledAt: '2026-09-03T18:00:00Z', leaseId: rv.leaseId, apps: [{ paymentId: rent, amount: 1000 }],
  })
  await bill(co, { amount: 600, due: '2026-09-01', unitId: mh.unitId, leaseId: mh.leaseId })
  await bill(co, { amount: 650, due: '2026-09-01', unitId: parkOwned.unitId, leaseId: parkOwned.leaseId })
  // 13 gallons at $3.30, the privilege tax on top — the 9/24 sale at Mountain View.
  await sale(co, {
    subtotal: 42.9, tax: 2.72, taxBreakdown: [{ name: 'Transaction privilege tax', rate: 0.0635, amount: 2.72 }],
    at: '2026-09-24 18:00:00+00', items: [{ name: 'Propane', qty: 13, price: 3.3 }],
  })
  await lump(co, { amount: 72.13, day: '2026-09-10', words: LUMP, payer: 'Square' })
  if (o.monthStay) await monthStay(co, { toward: 589, at: '2026-09-05 18:00:00+00' })
  await drain()
  if (o.live !== false) await markLedgerLive(co.landlordId)
  return { co, rv, mh, parkOwned }
}

const read = (w: World, propertyIds: string[] | null = null): Promise<IncomePools> =>
  incomePools({ landlordIds: [w.co.landlordId], propertyIds, ...SEPTEMBER })

const row = (p: IncomePools, key: string): PoolRow | undefined => p.pools.find(r => r.key === key)
const sum = (rows: readonly PoolRow[], col: 'amount' | 'charged' | 'owed') =>
  Math.round(rows.reduce((t, r) => t + (r[col] ?? 0), 0) * 100) / 100

describe('Money in: the rows are the lines the books keep (10/19)', () => {
  it('a month with both RV and mobile home rent shows two rows, with the books\' own labels and figures', async () => {
    const w = await world()
    const p = await read(w)
    expect(p.itemized).toBe(true)
    // The unit-type split, by the names the ledger gives the accounts.
    expect(row(p, 'rent_line:rv_spot')).toMatchObject({
      label: LEDGER_RENT_LINE_LABEL.rv_spot, amount: 1000, charged: 1000, owed: 0,
    })
    // MH 09's whole rent, and the lot-rent share of the park-owned MH 12.
    expect(row(p, 'rent_line:mobile_home_lot')).toMatchObject({
      label: LEDGER_RENT_LINE_LABEL.mobile_home_lot, amount: 0, charged: 900, owed: 900,
    })
    // The rest of MH 12: the trailer the park owns (Nic I4/I5 — derived, no box).
    expect(row(p, 'rent_line:mobile_home_trailer')).toMatchObject({
      label: LEDGER_RENT_LINE_LABEL.mobile_home_trailer, amount: 0, charged: 350, owed: 350,
    })
    // And the cadence pools are no longer the rent rows.
    expect(p.pools.map(r => r.key)).not.toContain('monthly_rent')
  })

  it('register sales itemize per item: one item type reads as that item, and ties to the account', async () => {
    const w = await world()
    const p = await read(w)
    expect(row(p, 'register_sales')).toMatchObject({ amount: 42.9, charged: 42.9 })
    const items = (p.register?.categories ?? []).flatMap(c => c.items)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ name: 'Propane', qty: 13, sales: 42.9, salesCount: 1 })
    // Every figure stays tied to the ledger: the items add up to the account.
    expect(p.register?.tie).toMatchObject({ itemLines: 42.9, posted: 42.9, difference: 0 })
    // 10/19: the tax the sale collected is beside the total, never in it — a
    // figure the page used to leave out altogether.
    expect(p.besideTotal).toEqual([
      { key: 'taxCollected', label: 'Tax collected (owed to the government)', amount: 2.72 },
    ])
    expect(p.total).toBe(1115.03)
  })

  it('a lump filed as other money in keeps its own words and is never split', async () => {
    const w = await world()
    const p = await read(w)
    expect(row(p, 'other_income')).toMatchObject({ amount: 72.13, charged: 72.13 })
    const rows = p.otherMoneyIn?.rows ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ description: LUMP, payer: 'Square', amount: 72.13, records: 1, lumpSum: true })
    // Nothing guesses how much of it was propane and how much was a stay.
    expect(p.otherMoneyIn?.noTaxSplit).toBe(72.13)
    expect(p.otherMoneyIn?.total).toBe(72.13)
  })

  it('the rows add up to each column, and the columns are what they were before the split', async () => {
    const before = await read(await world({ live: false }))
    const after = await read(await world())
    expect(before.itemized).toBe(false)
    expect([after.total, after.charged, after.owed]).toEqual([before.total, before.charged, before.owed])
    expect([after.total, after.charged, after.owed]).toEqual([1115.03, 2365.03, 1250])
    for (const col of ['amount', 'charged', 'owed'] as const) {
      const total = col === 'amount' ? after.total : col === 'charged' ? after.charged : after.owed
      expect(sum(after.pools, col), `${col} rows add up to the column`).toBe(total)
      expect(sum(before.pools, col), `${col} rows added up before the split too`).toBe(total)
    }
    // Every month and day still adds up to the money that arrived that month or day.
    for (const m of after.months) expect(Math.round(m.pools.reduce((t, x) => t + x.amount, 0) * 100) / 100).toBe(m.total)
    for (const d of after.days) expect(Math.round(d.pools.reduce((t, x) => t + x.amount, 0) * 100) / 100).toBe(d.total)
    expect(Math.round(after.days.reduce((t, d) => t + d.total, 0) * 100) / 100).toBe(after.total)
  })

  it('the rent cadence is kept beside the new rows, and is the same rent money', async () => {
    const w = await world()
    const p = await read(w)
    // A lease's own rent, as the page has always called it — nothing dropped.
    expect(p.rentSoldAs).toEqual([
      { key: 'monthly_rent', label: RENT_POOL_LABEL.monthly_rent, amount: 1000, charged: 2250, owed: 1250 },
    ])
    const rent = p.pools.filter(r => r.key.startsWith('rent_line:') || r.key === 'space_rent')
    for (const col of ['amount', 'charged', 'owed'] as const) {
      expect(sum(p.rentSoldAs, col), `${col}: the two cuts of the rent agree`).toBe(sum(rent, col))
    }
  })

  /**
   * 10/19 (review): the test above asserted the invariant on a month with no
   * stay money in it, so it held while the page was wrong. These two put the
   * money that breaks it in front of the invariant.
   */
  it('rent that came in as a long-term stay is on the cadence card too, because it is on the rent rows', async () => {
    const p = await read(await world({ monthStay: true }))
    // The books post a month stay to the space's own long-term rent line, so
    // the RV rent row carries the lease's rent AND the stay's.
    expect(row(p, 'rent_line:rv_spot')).toMatchObject({ amount: 1589, charged: 1589 })
    // The card has to carry it as well. A stay has no lease to read a cadence
    // off and 30 nights can have been sold by the night, the week or the month,
    // so it is named for the stay it is instead of filed under a guess.
    expect(p.rentSoldAs.map(r => [r.key, r.label, r.amount, r.charged, r.owed])).toEqual([
      ['monthly_rent', RENT_POOL_LABEL.monthly_rent, 1000, 2250, 1250],
      ['long_term_stay', 'Sold as a long-term stay', 589, 589, 0],
    ])
    const rent = p.pools.filter(r => r.key.startsWith('rent_line:') || r.key === 'space_rent')
    for (const col of ['amount', 'charged', 'owed'] as const) {
      expect(sum(p.rentSoldAs, col), `${col}: the two cuts of the rent agree`).toBe(sum(rent, col))
    }
  })

  it('every month and every day carries its own cadence cut of the rent it received', async () => {
    const p = await read(await world({ monthStay: true }))
    const r2 = (n: number) => Math.round(n * 100) / 100
    const add = (rows: ReadonlyArray<{ amount: number }>) => r2(rows.reduce((t, x) => t + x.amount, 0))
    expect(p.months.length).toBeGreaterThan(0)
    for (const g of [...p.months, ...p.days]) {
      const at = 'month' in g ? g.month : g.day
      const rentRows = g.pools.filter(x => x.key.startsWith('rent_line:') || x.key === 'space_rent')
      expect(add(g.rentSoldAs), `${at}: the cadence is the rent of that month or day`).toBe(add(rentRows))
    }
    // The month the stay money arrived in names it, so "how much came in sold
    // by the month?" is answerable one month at a time and not only per period.
    const sept = p.months.find(m => m.month === '2026-09')!
    expect(sept.rentSoldAs).toEqual([{ key: 'monthly_rent', amount: 1000 }, { key: 'long_term_stay', amount: 589 }])
    // A company whose rows are still the cadence itself has nothing to add beside them.
    const plain = await read(await world({ live: false, monthStay: true }))
    expect(plain.months.every(m => m.rentSoldAs.length === 0)).toBe(true)
    expect(plain.rentSoldAs).toEqual([])
  })

  it('a property filter narrows every row, the items and the lumps with them', async () => {
    const w = await world()
    const p = await read(w, [w.co.propertyId])
    expect(row(p, 'rent_line:rv_spot')).toMatchObject({ amount: 1000, charged: 1000 })
    expect(row(p, 'rent_line:mobile_home_lot')).toBeUndefined()
    expect([p.total, p.charged, p.owed]).toEqual([1115.03, 1115.03, 0])
    expect(sum(p.pools, 'amount')).toBe(p.total)
    // The property's own counter sales and its own lump, and nothing of the other's.
    expect((p.register?.categories ?? []).flatMap(c => c.items).map(i => i.name)).toEqual(['Propane'])
    expect(p.otherMoneyIn?.total).toBe(72.13)
    const other = await read(w, [w.co.propertyId2])
    expect(row(other, 'rent_line:mobile_home_lot')).toMatchObject({ charged: 900, owed: 900 })
    expect([other.total, other.charged, other.owed]).toEqual([0, 1250, 1250])
    expect(other.register?.categories ?? []).toEqual([])
    expect(other.otherMoneyIn?.rows ?? []).toEqual([])
  })

  it('the shared Money in page is byte-identical in the landlord portal and GAM Books', () => {
    const root = join(__dirname, '../../../..')
    const of = (app: string) => readFileSync(join(root, 'apps', app, 'src/financials/IncomePage.tsx'), 'utf8')
    expect(of('books'), 'copy the change to both apps').toBe(of('landlord'))
  })
})
