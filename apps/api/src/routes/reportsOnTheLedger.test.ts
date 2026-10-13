/**
 * 10/12 (Nic) — GAM Books ledger, phase P8: the landlord's Reports, dashboard
 * and Money In read the books once they are live, with every screen agreeing
 * (gam-ledger-design-2026-10-12 §10 "Switch every reader").
 *
 *   "NO Money received / Money billed toggle anywhere — show Charged, Received
 *   and Owed side by side." (L2) "Received leads."
 *
 * One company, two properties:
 *   property 1  rent $1,000 due 10/1, $400 paid in cash 10/3; a $150 repair
 *               bill dated 10/4, paid in cash 10/20
 *   property 2  rent $300 due 10/1, unpaid; September rent $300 unpaid too
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { reportsRouter } from './reports'
import { financialsRouter } from './financials'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'
import { tenantCo, bill, receipt, drain, addLease, cleanupTenantLedger, type TenantCo } from '../test/ledgerTenantFixtures'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../services/ledgerProjectors'
import { createLandlordExpense, recordExpensePayment } from '../services/landlordExpenses'
import { markLedgerLive } from '../test/ledgerReportFixtures'
import { collectedRentMtd } from '../lib/rentCollected'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', reportsRouter)
  app.use('/api/financials', financialsRouter)
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_reports_on_the_ledger'
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

interface World extends TenantCo { tok: string; unit2: string }

async function world(live = true): Promise<World> {
  const co = await tenantCo()
  const rent = await bill(co, { amount: 1000, due: '2026-10-01' })
  await receipt(co, { method: 'cash', settledAt: '2026-10-03T17:00:00Z', apps: [{ paymentId: rent, amount: 400 }], settleRows: false })
  const second = await addLease(co)
  await bill(co, { amount: 300, due: '2026-09-01', unitId: second.unitId, leaseId: second.leaseId })
  await bill(co, { amount: 300, due: '2026-10-01', unitId: second.unitId, leaseId: second.leaseId })
  const exp = await createLandlordExpense({
    landlordId: co.landlordId, category: 'repairs', amount: 150, expenseDate: '2026-10-04', propertyId: co.propertyId, payment: null,
  })
  await recordExpensePayment({ landlordId: co.landlordId, expenseId: exp.id, method: 'cash', paidOn: '2026-10-20', createdBy: null })
  await drain()
  if (live) await markLedgerLive(co.landlordId)
  const tok = jwt.sign({ userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ...co, tok, unit2: second.unitId }
}
const get = (w: World, url: string) => request(buildApp()).get(url).set('Authorization', `Bearer ${w.tok}`)

describe('Reports read the books once they are live', () => {
  it('the monthly P&L: Received, Charged and Owed at the month\'s end, the strip, and the net on what was paid', async () => {
    const w = await world()
    const r = await get(w, '/api/reports/monthly-pl?year=2026&month=10')
    expect(r.status).toBe(200)
    const v = r.body.data.view
    expect(v.source).toBe('ledger')
    expect([v.received, v.charged, v.owed]).toEqual([400, 1300, 1200])
    expect(v.proof).toMatchObject({ owedAtStart: 300, billed: 1300, received: 400, owedAtEnd: 1200 })
    expect(v.tieText[1]).toMatch(/^Owed \$300\.00 at the end of Sep 30, 2026 \+ billed \$1,300\.00 − received against bills \$400\.00 = owed \$1,200\.00 at the end of Oct 31, 2026\.$/)
    // The repair was dated 10/4 and paid 10/20 — the same month either way.
    expect(r.body.data.nets).toEqual({ received: 250, charged: 1150 })
  })

  it('By Property and its drill-in take the books\' expenses, and agree with each other', async () => {
    const w = await world()
    const pl = await get(w, '/api/reports/property-pl?year=2026&month=10')
    expect(pl.status).toBe(200)
    const one = pl.body.data.properties.find((p: any) => p.id === w.propertyId)
    const two = pl.body.data.properties.find((p: any) => p.id === w.propertyId2)
    expect([one.received, one.charged, one.owed]).toEqual([400, 1000, 600])
    expect([two.received, two.charged, two.owed]).toEqual([0, 300, 600])
    expect([one.maint_cost, one.expenses_total, one.expenses_paid]).toEqual([150, 150, 150])
    expect([one.net_received, one.net_charged]).toEqual([250, 850])
    const detail = await get(w, `/api/reports/property-detail?propertyId=${w.propertyId}&year=2026&month=10`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.expenses).toMatchObject({ maintenance: 150, total: 150, paid: 150 })
    expect(detail.body.data.nets).toEqual({ received: one.net_received, charged: one.net_charged })
  })

  it('the report engine: Owed at each month\'s end (never added across months), the books\' expenses', async () => {
    const w = await world()
    const r = await get(w, '/api/reports/query?start=2026-09-01&end=2026-10-31&level=portfolio&bucket=monthly')
    expect(r.status).toBe(200)
    expect(r.body.data.meta.source).toBe('ledger')
    expect(r.body.data.meta.columns[2].note).toMatch(/at the end of the period/)
    const sep = r.body.data.rows.find((x: any) => x.period === '2026-09')
    const oct = r.body.data.rows.find((x: any) => x.period === '2026-10')
    expect([sep.money.charged, sep.money.owed]).toEqual([300, 300])
    expect([oct.money.charged, oct.money.received, oct.money.owed]).toEqual([1300, 400, 1200])
    expect(oct.expenses.byCategory.repairs).toBe(150)
    // The whole span: Owed at its last day once, not September's plus October's.
    expect(r.body.data.totals.money.owed).toBe(1200)
    const total = await get(w, '/api/reports/query?start=2026-09-01&end=2026-10-31&level=portfolio&bucket=total')
    expect(total.body.data.totals.money.owed).toBe(1200)
    // The net takes what was PAID (the repair, paid 10/20), as the P&L's Received net does.
    expect(oct.expenses.paid).toBe(150)
    expect(oct.net).toBe(250)
    expect(total.body.data.totals.net).toBe(250)
  })

  it('Money In: Charged and Owed per type from the books, nothing in no total counted', async () => {
    const w = await world()
    const r = await get(w, '/api/financials/income?from=2026-10-01&to=2026-10-31')
    expect(r.status).toBe(200)
    expect([r.body.data.total, r.body.data.charged, r.body.data.owed]).toEqual([400, 1300, 1200])
  })

  it('the dashboard\'s income card: billed, paid against bills in the month, still owed at its end', async () => {
    const w = await world()
    const all = await collectedRentMtd([w.landlordId], null, { scope: 'all', month: '2026-10-15' })
    expect(all.collected).toBe(400)
    expect(all.billed).toEqual({ amount: 1300, collected: 400, clearing: 0, stillOwed: 1200 })
    const rent = await collectedRentMtd([w.landlordId], w.propertyId2, { month: '2026-10-15' })
    expect(rent.billed).toEqual({ amount: 300, collected: 0, clearing: 0, stillOwed: 600 })
  })

  it('the utility recovery report takes what the property spent from the books', async () => {
    const w = await world()
    await createLandlordExpense({
      landlordId: w.landlordId, category: 'utilities', utilityType: 'electric', amount: 90, expenseDate: '2026-10-06',
      propertyId: w.propertyId, payment: { method: 'cash' },
    })
    await drain()
    const r = await get(w, `/api/utility/recovery?propertyId=${w.propertyId}&from=2026-10-01&to=2026-10-31`)
    expect(r.status).toBe(200)
    const electric = r.body.data.lines.find((x: any) => x.utilityType === 'electric')
    expect(electric.spent).toBe(90)
    expect(r.body.data.totals.spent).toBe(90)
  })

  it('the column notes follow the books: ledger-status says so', async () => {
    const live = await world()
    expect((await get(live, '/api/reports/ledger-status')).body.data).toEqual({ live: true })
    const notYet = await world(false)
    expect((await get(notYet, '/api/reports/ledger-status')).body.data).toEqual({ live: false })
    // And the money records answer exactly as before for a company not live yet.
    const r = await get(notYet, '/api/reports/monthly-pl?year=2026&month=10')
    expect(r.body.data.view.source).toBeUndefined()
    expect(r.body.data.view.proof).toBeUndefined()
  })
})
