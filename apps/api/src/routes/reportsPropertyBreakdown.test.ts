/**
 * S655 decision #4 (Nic, 10/2): the property report LEADS with a breakdown.
 *
 *   "here's the total collected... I want to see how much electric was billed
 *    back, property-wide... the distinction between lot rent collected, late
 *    fees, trailer payments, etc." And the lists after it: "way too long".
 *
 * The dashboard's property-health card reads the same category totals, and the
 * landlord's agent reads the same P&L and the same card, so every screen agrees
 * for the same month and the same switch.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedLeaseFee,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { reportsRouter } from './reports'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'
import { getProfitAndLoss } from '../services/agents/tools/getProfitAndLoss'
import { getPortfolioStats } from '../services/agents/tools/getPortfolioStats'

const SECRET = 'test_jwt_secret_breakdown'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', reportsRouter)
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
})

interface Park {
  userId: string; landlordId: string; propertyId: string; token: string
  units: Array<{ unitId: string; tenantId: string; leaseId: string }>
}

/** A park with three occupied spaces (Mountain View-shaped). */
async function park(): Promise<Park> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET name = 'Mountain View RV', created_at = '2024-01-01' WHERE id = $1`, [propertyId])
    const units = []
    for (let i = 0; i < 3; i++) {
      const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 460, unitType: 'rv_spot' })
      await c.query(`UPDATE units SET status = 'active' WHERE id = $1`, [unitId])
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 460 })
      await seedLeaseTenant(c, { leaseId, tenantId })
      units.push({ unitId, tenantId, leaseId })
    }
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'mv@t.dev', profileId: null,
                             landlordIds: [landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, token, units }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function row(p: Park, i: number, o: {
  type: string; entry: string; amount: number; due: string; settledAt?: string; leaseFeeId?: string; status?: string
}): Promise<string> {
  const u = p.units[i]
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, settled_at, lease_fee_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::timestamptz,$11) RETURNING id`,
    [u.unitId, u.leaseId, u.tenantId, p.landlordId, o.type, o.amount,
     o.status ?? (o.settledAt ? 'settled' : 'pending'), o.entry, o.due, o.settledAt ?? null, o.leaseFeeId ?? null])
  return r.rows[0].id
}

/** One September at the park: rent, electric bills, trash, propane, a home payment, a late fee. */
async function september(p: Park) {
  const c = await db.connect()
  try {
    const meter = await seedUtilityMeter(c, { propertyId: p.propertyId, utilityType: 'electric' })
    // Electric: two bills paid, one still owed.
    for (const [i, amt, paid] of [[0, 96.81, true], [1, 54.20, true], [2, 31.00, false]] as const) {
      const pay = await row(p, i, { type: 'utility', entry: 'UTILITY', amount: amt, due: '2026-09-01',
                                    settledAt: paid ? '2026-09-05T10:00:00-07:00' : undefined })
      await seedUtilityBill(c, { meterId: meter, unitId: p.units[i].unitId, tenantId: p.units[i].tenantId,
        leaseId: p.units[i].leaseId, landlordId: p.landlordId, chargeAmount: amt, paymentId: pay,
        billingCycleMonth: '2026-08-01', utilityType: 'electric', status: paid ? 'paid' : 'billed' })
    }
    // Trash: a flat lease fee billed as a utility line.
    const trashFee = await seedLeaseFee(c, { leaseId: p.units[0].leaseId, feeType: 'trash_fee', amount: 25, dueTiming: 'monthly_ongoing' })
    await row(p, 0, { type: 'fee', entry: 'OTHERFEE', amount: 25, due: '2026-09-01', settledAt: '2026-09-05T10:00:00-07:00', leaseFeeId: trashFee })
  } finally { c.release() }
  for (let i = 0; i < 3; i++) {
    await row(p, i, { type: 'rent', entry: 'RENT', amount: 460, due: '2026-09-01',
                      settledAt: i < 2 ? '2026-09-03T10:00:00-07:00' : undefined })
  }
  await row(p, 1, { type: 'utility', entry: 'PROPANE', amount: 42.5, due: '2026-09-10', settledAt: '2026-09-10T10:00:00-07:00' })
  await row(p, 2, { type: 'home_payment', entry: 'HOMEPMT', amount: 200, due: '2026-09-01', settledAt: '2026-09-02T10:00:00-07:00' })
  await row(p, 2, { type: 'late_fee', entry: 'LATEFEE', amount: 25, due: '2026-09-07' })
}

const get = (p: Park, path: string) => request(buildApp()).get(path).set('Authorization', `Bearer ${p.token}`)
const cat = (d: any, c: string) => d.breakdown.categories.find((x: any) => x.category === c)

describe('GET /reports/property-detail — the breakdown (decision #4)', () => {
  it('Mountain View electric billed vs collected equals its utility_bills rows', async () => {
    const p = await park()
    await september(p)
    const bills = (await db.query<{ billed: string; paid: string }>(
      `SELECT SUM(ub.charge_amount)::text AS billed,
              SUM(ub.charge_amount) FILTER (WHERE pay.status = 'settled')::text AS paid
         FROM utility_bills ub JOIN payments pay ON pay.id = ub.payment_id
        WHERE ub.utility_type = 'electric' AND ub.landlord_id = $1`, [p.landlordId])).rows[0]
    for (const basis of ['received', 'billed']) {
      const d = (await get(p, `/api/reports/property-detail?propertyId=${p.propertyId}&year=2026&month=9&basis=${basis}`)).body.data
      const e = cat(d, 'electric')
      expect(e.label).toBe('Electric')
      expect(e.billed).toBe(Number(bills.billed))     // 182.01
      expect(e.collected).toBe(Number(bills.paid))    // 151.01
    }
    const billed = (await get(p, `/api/reports/property-detail?propertyId=${p.propertyId}&year=2026&month=9&basis=billed`)).body.data
    expect(cat(billed, 'electric').stillOwed).toBe(31)
  })

  it('trash fee resolves to trash, propane to propane, HOMEPMT to home payments', async () => {
    const p = await park()
    await september(p)
    const d = (await get(p, `/api/reports/property-detail?propertyId=${p.propertyId}&year=2026&month=9`)).body.data
    expect(cat(d, 'trash').collected).toBe(25)
    expect(cat(d, 'propane').collected).toBe(42.5)
    expect(cat(d, 'home_payments').collected).toBe(200)
    expect(cat(d, 'space_rent').collected).toBe(920)
    expect(cat(d, 'space_rent').billed).toBe(1380)
    expect(cat(d, 'late_fees').billed).toBe(25)
    expect(cat(d, 'late_fees').collected).toBe(0)
    expect(cat(d, 'other_fees').amount).toBe(0)
    // Categories in Nic's order: lot rent, each utility, late fees, home payments, ...
    expect(d.breakdown.categories.map((c: any) => c.category).slice(0, 4)).toEqual(['space_rent', 'electric', 'water', 'sewer'])
    // The breakdown, expenses and net add up.
    expect(d.breakdown.total).toBe(Math.round(d.breakdown.categories.reduce((s: number, c: any) => s + c.amount, 0) * 100) / 100)
    expect(d.net).toBe(Math.round((d.breakdown.total - d.expenses.total) * 100) / 100)
  })

  it('lists come after the breakdown', async () => {
    const p = await park()
    await september(p)
    const d = (await get(p, `/api/reports/property-detail?propertyId=${p.propertyId}&year=2026&month=9`)).body.data
    const keys = Object.keys(d)
    for (const list of ['units', 'payments', 'maintenance']) {
      expect(keys.indexOf('breakdown')).toBeLessThan(keys.indexOf(list))
      expect(keys.indexOf('expenses')).toBeLessThan(keys.indexOf(list))
      expect(keys.indexOf('net')).toBeLessThan(keys.indexOf(list))
    }
    expect(d.meta.listsAfterBreakdown).toBe(true)
    // The payments list is the charges behind the total.
    const rowsSum = Math.round(d.payments.reduce((s: number, r: any) => s + r.amount, 0) * 100) / 100
    expect(rowsSum).toBe(d.breakdown.total)
  })
})

describe('the By Property row and the drill-in it opens', () => {
  it('a property row\'s net equals its drill-in net when it has lot rent and an entered expense', async () => {
    const p = await park()
    await september(p)
    // September's costs at the park: $50 of lot rent, a $100 expense booked to
    // it (and a voided one that never counts), and a $75 repair.
    await db.query(
      `INSERT INTO lot_rent_charges (unit_id, property_id, landlord_id, billing_month, amount)
       VALUES ($1,$2,$3,'2026-09-01',50)`, [p.units[0].unitId, p.propertyId, p.landlordId])
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, description, expense_date, status, voided_at)
       VALUES ($1,$2,'repairs',100,'a bill','2026-09-14','active',NULL),
              ($1,$2,'repairs',999,'voided','2026-09-14','voided',now())`, [p.landlordId, p.propertyId])
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
       VALUES ($1,$2,'Fix','Fix it','completed',75,'2026-09-20T10:00:00-07:00')`, [p.units[1].unitId, p.landlordId])

    for (const basis of ['received', 'billed']) {
      const rows = (await get(p, `/api/reports/property-pl?year=2026&month=9&basis=${basis}`)).body.data.properties
      const r = rows.find((x: any) => x.id === p.propertyId)
      const d = (await get(p, `/api/reports/property-detail?propertyId=${p.propertyId}&year=2026&month=9&basis=${basis}`)).body.data
      // (The app camelizes on the way out; the router's own JSON is snake_case.)
      expect(r.lot_rent).toBe(50)
      expect(r.entered_expenses).toBe(100)
      expect(r.maint_cost).toBe(75)
      expect(r.lot_rent).toBe(d.expenses.lotRent)
      expect(r.entered_expenses).toBe(d.expenses.enteredExpenses)
      expect(r.maint_cost).toBe(d.expenses.maintenance)
      expect(r.platform_fees).toBe(d.expenses.platformFee)
      expect(r.expenses_total).toBe(d.expenses.total)
      expect(r.income_total).toBe(d.breakdown.total)
      expect(r.net_income).toBe(d.net)
      expect(r.net_income).toBe(Math.round((r.income_total - r.platform_fees - 75 - 50 - 100) * 100) / 100)
    }
  })
})

describe('the dashboard property card and the agent read the same totals', () => {
  /** This month at the park, so the dashboard's current-month card has data. */
  async function thisMonth(p: Park): Promise<string> {
    const today = todayIn(null)
    const first = today.slice(0, 8) + '01'
    await row(p, 0, { type: 'rent', entry: 'RENT', amount: 460, due: first, settledAt: `${first}T10:00:00-07:00` })
    await row(p, 1, { type: 'rent', entry: 'RENT', amount: 460, due: first })
    await row(p, 1, { type: 'utility', entry: 'PROPANE', amount: 30, due: first, settledAt: `${first}T11:00:00-07:00` })
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date) VALUES ($1,$2,'laundry',18,$3)`,
      [p.landlordId, p.propertyId, first])
    // Paid ahead today for next month (arrives this month).
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
       VALUES ($1,$2,460,460,'landlord',$3::timestamptz,$3::timestamptz)`,
      [p.units[2].leaseId, p.units[2].tenantId, `${first}T12:00:00-07:00`])
    return today
  }

  it('the dashboard property card equals the property report for the same month and basis', async () => {
    const p = await park()
    const today = await thisMonth(p)
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
    for (const basis of ['received', 'billed']) {
      const dash = (await get(p, `/api/landlords/me/dashboard?propertyId=${p.propertyId}&basis=${basis}`)).body.data
      const detail = (await get(p, `/api/reports/property-detail?propertyId=${p.propertyId}&year=${y}&month=${m}&basis=${basis}`)).body.data
      expect(dash.property_health.total).toBe(detail.breakdown.total)
      expect(dash.trend[dash.trend.length - 1].revenue).toBe(detail.breakdown.total)
      for (const c of detail.breakdown.categories) {
        const mine = dash.property_health.categories.find((x: any) => x.category === c.category)
        expect(mine.amount).toBe(c.amount)
      }
      expect(dash.basis.basis).toBe(basis)
    }
    const rx = (await get(p, `/api/landlords/me/dashboard?basis=received`)).body.data
    // Money received this month $A, incl. $460 paid ahead for later bills.
    expect(rx.income_card.received.amount).toBe(460 + 30 + 18 + 460)
    expect(rx.income_card.received.paidAhead).toBe(460)
    // The rent card: rent that arrived, incl. the $460 paid ahead this month.
    expect(rx.collected_mtd).toBe(920)
    expect(rx.rent_card.received).toEqual({ amount: 920, clearing: 0 })
    const bx = (await get(p, `/api/landlords/me/dashboard?basis=billed`)).body.data
    expect(bx.income_card.billed.amount).toBe(460 + 460 + 30 + 18)
    expect(bx.income_card.billed.stillOwed).toBe(460)
    expect(bx.collected_mtd).toBe(460)
  })

  it('the agent P&L and portfolio stats equal the report and the card', async () => {
    const p = await park()
    const today = await thisMonth(p)
    await september(p)
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
    const actor = { userId: p.userId, role: 'landlord', profileId: '', landlordIds: [p.landlordId] } as any
    for (const [yr, mo] of [[2026, 9], [y, m]] as const) {
      for (const basis of ['received', 'billed']) {
        const tool: any = await getProfitAndLoss.execute({ year: yr, month: mo, basis }, actor)
        const report = (await get(p, `/api/reports/monthly-pl?year=${yr}&month=${mo}&basis=${basis}`)).body.data
        expect(tool.income.total).toBe(report.gross.total)
        expect(tool.net).toBe(report.net)
        expect(tool.basis).toBe(report.meta.basis.label)
      }
    }
    const stats: any = await getPortfolioStats.execute({ topic: 'money' }, actor)
    const dash = (await get(p, '/api/landlords/me/dashboard')).body.data
    expect(stats.money.thisMonth.moneyReceived).toBe(dash.income_card.received.amount)
    expect(stats.money.thisMonth.includesPaidAhead).toBe(dash.income_card.received.paidAhead)
    expect(stats.money.thisMonth.stillClearing).toBe(dash.income_card.received.clearing)
  })
})
