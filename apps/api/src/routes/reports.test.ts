/**
 * reports.ts gap-close slice — S408. Closes the file at 5/5 (100%).
 *
 * Covered routes (5):
 *   - GET /api/reports/summary
 *   - GET /api/reports/monthly-statement
 *   - GET /api/reports/tax-summary
 *   - GET /api/reports/property-pl
 *   - GET /api/reports/work-trade-1099
 *
 * No production bug fixes in this slice — but two architectural
 * findings flagged for validation-hygiene:
 *
 *   FINDING A: `/monthly-statement` defaults to LAST month when no
 *   `?month` is provided (0-indexed Date.getMonth() vs 1-indexed
 *   explicit input). Could be deliberate (showing the completed
 *   month) or an off-by-one. Needs product input.
 *
 *   FINDING B: $15 hardcoded platform fee in 3 routes (monthly-
 *   statement, tax-summary, property-pl). Current GAM pricing per
 *   CLAUDE.md is $2/occupied-unit + $10/property/mo. Hardcoded $15
 *   is ~7× too high. Tax summary deductions are wrong. Fix needs
 *   platform_fee_accruals table query + product decision on
 *   historical vs current rate.
 *
 * Tests pin current behavior so any future fix is visible.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { reportsRouter } from './reports'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/reports', reportsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_reports'
})

const sign = (claims: any) =>
  jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Fixture {
  aUid: string; aLid: string; aPropId: string; aUnitId: string
  bUid: string; bLid: string; bPropId: string; bUnitId: string
  tenant1Id: string; lease1Id: string
  tokenLandlordA: string
  tokenLandlordB: string
  tokenAdmin: string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aLid } = await seedLandlord(c)
    const { userId: bUid, landlordId: bLid } = await seedLandlord(c)
    const aPropId = await seedProperty(c, { landlordId: aLid, ownerUserId: aUid, managedByUserId: aUid })
    const bPropId = await seedProperty(c, { landlordId: bLid, ownerUserId: bUid, managedByUserId: bUid })
    // Backdate onboarding so platform-fee queries for any past year see the
    // property as on-platform (the fee excludes pre-onboarding months).
    await c.query(`UPDATE properties SET created_at = '2024-01-01' WHERE id IN ($1,$2)`, [aPropId, bPropId])
    const aUnitId = await seedUnit(c, { propertyId: aPropId, landlordId: aLid })
    const bUnitId = await seedUnit(c, { propertyId: bPropId, landlordId: bLid })
    const tenant1Id = await seedTenant(c)
    const lease1Id = await seedLease(c, { unitId: aUnitId, landlordId: aLid })
    await seedLeaseTenant(c, { leaseId: lease1Id, tenantId: tenant1Id, role: 'primary' })
    await c.query('COMMIT')
    return {
      aUid, aLid, aPropId, aUnitId,
      bUid, bLid, bPropId, bUnitId,
      tenant1Id, lease1Id,
      // S633: a landlord session names no entity — landlordIds carries the
      // ACCOUNT's companies, and profileId is null for role='landlord'.
      tokenLandlordA: sign({ userId: aUid, role: 'landlord', email: 'a@t.dev',
                              profileId: null, landlordIds: [aLid], permissions: {} }),
      tokenLandlordB: sign({ userId: bUid, role: 'landlord', email: 'b@t.dev',
                              profileId: null, landlordIds: [bLid], permissions: {} }),
      tokenAdmin: sign({ userId: randomUUID(), role: 'admin', email: 'admin@t.dev',
                          profileId: randomUUID() }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// S655: a row paid with no settle time given was paid ON its due date (noon,
// Phoenix), so "Money received" (settle day) and "Money billed" (due date)
// put it in the same month; with no due date either, it is due and paid now.
async function seedSettledRentPayment(opts: {
  unitId: string; tenantId: string; landlordId: string
  amount?: number; settledAt?: string; dueDate?: string
}): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, tenant_id, landlord_id, type, amount, status,
        entry_description, due_date, settled_at)
     VALUES ($1,$2,$3,'rent',$4,'settled','RENT',
             COALESCE($5::date, CURRENT_DATE),
             COALESCE($6::timestamptz,
                      ($5::date + TIME '12:00') AT TIME ZONE 'America/Phoenix',
                      NOW())) RETURNING id`,
    [opts.unitId, opts.tenantId, opts.landlordId,
     opts.amount ?? 1000, opts.dueDate ?? null, opts.settledAt ?? null])
  return id
}

async function seedMaint(opts: {
  unitId: string; landlordId: string; actualCost: number
  platformFee?: number; completedAt: string
}): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO maintenance_requests
       (unit_id, landlord_id, title, description, status, actual_cost, platform_fee, completed_at)
     VALUES ($1,$2,'Repair','desc','completed',$3,$4,$5::timestamptz) RETURNING id`,
    [opts.unitId, opts.landlordId, opts.actualCost, opts.platformFee ?? 0, opts.completedAt])
  return id
}

async function seedBooking(opts: {
  unitId: string; landlordId: string; checkIn: string; checkOut: string
  leaseType?: 'nightly' | 'weekly'
}): Promise<void> {
  await db.query(
    `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status)
     VALUES ($1,$2,$3,$4,$5,'confirmed')`,
    [opts.unitId, opts.landlordId, opts.checkIn, opts.checkOut, opts.leaseType ?? 'nightly'])
}

// S517: seed a work-trade agreement plus an invoice carrying the applied
// work-trade credit (the bartered value the 1099/tax reports now read).
async function seedWtCredit(opts: {
  landlordId: string; tenantId: string; unitId: string; leaseId: string
  creditValue: number; dueDate: string
}): Promise<string> {
  const a = await db.query<{ id: string }>(
    `INSERT INTO work_trade_agreements (landlord_id, tenant_id, unit_id, start_date, status)
     VALUES ($1,$2,$3,'2026-01-01','active') RETURNING id`,
    [opts.landlordId, opts.tenantId, opts.unitId])
  const agId = a.rows[0].id
  await db.query(
    `INSERT INTO invoices
       (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
        total_amount, work_trade_credit_amount, work_trade_agreement_id)
     VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
    [opts.landlordId, opts.tenantId, opts.leaseId, opts.unitId,
     `INV-${agId.slice(0, 8)}`, opts.dueDate, opts.creditValue, agId])
  return agId
}

// ─── GET /api/reports/summary ───────────────────────────────

describe('GET /api/reports/summary', () => {
  it('landlord-scoped: includes only own collected MTD + own units', async () => {
    const f = await seed()
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 1500 })
    await seedSettledRentPayment({ unitId: f.bUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.bLid, amount: 2000 })
    const res = await request(buildApp()).get('/api/reports/summary')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(parseFloat(res.body.data.collectedMtd)).toBe(1500)
    expect(res.body.data.totalUnits).toBe(1)  // A's unit only
    // YTD chart series — caller-scoped, settled rent this calendar year.
    expect(parseFloat(res.body.data.ytdCollected)).toBe(1500)
    expect(res.body.data.ytdMonthly.reduce((s: number, m: any) => s + m.collected, 0)).toBe(1500)
  })

  it('admin sees platform-wide totals', async () => {
    const f = await seed()
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 1500 })
    await seedSettledRentPayment({ unitId: f.bUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.bLid, amount: 2000 })
    const res = await request(buildApp()).get('/api/reports/summary')
      .set('Authorization', `Bearer ${f.tokenAdmin}`)
    expect(res.status).toBe(200)
    expect(parseFloat(res.body.data.collectedMtd)).toBe(3500)
    expect(res.body.data.totalUnits).toBe(2)  // both landlords' units
  })

  it('occupancyRate = round(100 * active / total)', async () => {
    const f = await seed()
    // 1 active, 1 vacant for landlord A
    await db.query(`UPDATE units SET status='active' WHERE id=$1`, [f.aUnitId])
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await seedUnit(c, { propertyId: f.aPropId, landlordId: f.aLid })  // vacant by default
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).get('/api/reports/summary')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totalUnits).toBe(2)
    expect(res.body.data.occupiedUnits).toBe(1)
    expect(res.body.data.occupancyRate).toBe(50)
  })

  it('zero units → occupancyRate 0 (no divide-by-zero)', async () => {
    const f = await seed()
    // Strand A's unit to landlord B so A has 0.
    await db.query(`UPDATE units SET landlord_id=$1 WHERE id=$2`, [f.bLid, f.aUnitId])
    const res = await request(buildApp()).get('/api/reports/summary')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totalUnits).toBe(0)
    expect(res.body.data.occupancyRate).toBe(0)
  })

  it('non-owner role without payments.view_all → 403', async () => {
    const f = await seed()
    const pmNoPerm = sign({ userId: randomUUID(), role: 'property_manager',
                             email: 'pm@t.dev', profileId: randomUUID(),
                             landlordId: f.aLid, permissions: {} })
    const res = await request(buildApp()).get('/api/reports/summary')
      .set('Authorization', `Bearer ${pmNoPerm}`)
    expect(res.status).toBe(403)
  })

  it('monthly array is last 6 months sorted DESC', async () => {
    const f = await seed()
    // Seed 3 settled payments in different months (this month, last month,
    // 2 months ago). Use Postgres relative dates to keep test deterministic.
    // S414: spread due_date too so the rows don't collide on the partial
    // UNIQUE index ux_payments_unit_rent_due_date_active. The route's
    // monthly aggregation groups by settled_at — varying due_date in
    // lockstep keeps the test semantically equivalent.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount,
        status, entry_description, due_date, settled_at)
       VALUES ($1, $2, $3, 'rent', 100, 'settled', 'RENT', CURRENT_DATE, NOW()),
              ($1, $2, $3, 'rent', 200, 'settled', 'RENT', CURRENT_DATE - INTERVAL '1 month', NOW() - INTERVAL '1 month'),
              ($1, $2, $3, 'rent', 300, 'settled', 'RENT', CURRENT_DATE - INTERVAL '2 months', NOW() - INTERVAL '2 months')`,
      [f.aUnitId, f.tenant1Id, f.aLid])
    const res = await request(buildApp()).get('/api/reports/summary')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.monthly.length).toBeGreaterThanOrEqual(3)
    // DESC sort: first entry month >= subsequent entries.
    const months = res.body.data.monthly.map((m: any) => m.month)
    expect([...months]).toEqual([...months].sort((a, b) => b.localeCompare(a)))
  })
})

// ─── GET /api/reports/monthly-statement ─────────────────────

describe('GET /api/reports/monthly-statement', () => {
  it('happy: explicit year+month returns expected shape', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/reports/monthly-statement?year=2026&month=6')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('period')
    expect(res.body.data.period.year).toBe(2026)
    expect(res.body.data.period.month).toBe(6)
    expect(res.body.data).toHaveProperty('landlord')
    expect(res.body.data).toHaveProperty('properties')
    expect(res.body.data).toHaveProperty('payments')
    expect(res.body.data).toHaveProperty('summary')
  })

  it('S408 finding A: defaults to LAST calendar month when ?month omitted (0-indexed trap)', async () => {
    const f = await seed()
    // No ?month query param. Route uses `parseInt(req.query.month) ||
    // new Date().getMonth()`. Date.getMonth() is 0-indexed, so it
    // effectively returns "current month index - 1" in 1-indexed terms.
    // Compare to the explicit-input path which uses 1-indexed months.
    const res = await request(buildApp())
      .get('/api/reports/monthly-statement')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    // S654: "last month" is on the database's (Phoenix) calendar, the same one
    // the route reads. Node's local getMonth() was wrong every January (0, not
    // 12) and on the last evening of a month when Node runs in UTC.
    const last = (await db.query<{ y: number; m: number }>(
      `SELECT extract(year FROM CURRENT_DATE - interval '1 month')::int AS y,
              extract(month FROM CURRENT_DATE - interval '1 month')::int AS m`)).rows[0]
    expect(res.body.data.period.year).toBe(last.y)
    expect(res.body.data.period.month).toBe(last.m)
  })

  it('summary.totalPlatformFees uses the launch fee model ($2/occupied unit, $10/property min)', async () => {
    const f = await seed()
    await db.query(`UPDATE units SET status='active' WHERE id=$1`, [f.aUnitId])
    const res = await request(buildApp())
      .get('/api/reports/monthly-statement?year=2026&month=6')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    // 1 occupied unit on 1 property → max(1 × $2, $10 property min) = $10.
    // Reconciles with the monthly-pl drill-in + Dashboard fee card
    // (launchPlatformFeeForProperty). No longer the stale $15/unit.
    expect(res.body.data.summary.totalPlatformFees).toBe(10)
  })

  it('caller with perm but no landlord scope → 400', async () => {
    const noScope = sign({ userId: randomUUID(), role: 'tenant',
                            email: 't@t.dev', profileId: randomUUID(),
                            permissions: { 'payments.view_all': true } })
    const res = await request(buildApp())
      .get('/api/reports/monthly-statement?year=2026&month=6')
      .set('Authorization', `Bearer ${noScope}`)
    expect(res.status).toBe(400)
  })

  it('non-owner without payments.view_all → 403', async () => {
    const f = await seed()
    const pmNoPerm = sign({ userId: randomUUID(), role: 'property_manager',
                             email: 'pm@t.dev', profileId: randomUUID(),
                             landlordId: f.aLid, permissions: {} })
    const res = await request(buildApp())
      .get('/api/reports/monthly-statement?year=2026&month=6')
      .set('Authorization', `Bearer ${pmNoPerm}`)
    expect(res.status).toBe(403)
  })

  it('cross-landlord: payments returned are caller-scoped only', async () => {
    const f = await seed()
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 1000, dueDate: '2026-06-01' })
    await seedSettledRentPayment({ unitId: f.bUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.bLid, amount: 2000, dueDate: '2026-06-01' })
    const res = await request(buildApp())
      .get('/api/reports/monthly-statement?year=2026&month=6')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const rows = res.body.data.payments as any[]
    expect(rows.map(p => [p.landlordId, p.amount])).toEqual([[f.aLid, 1000]])
  })
})

// ─── GET /api/reports/tax-summary ───────────────────────────

describe('GET /api/reports/tax-summary', () => {
  function ownerTokenWithBooks(uid: string, lid: string) {
    return sign({ userId: uid, role: 'landlord', email: 'a@t.dev',
                   profileId: null, landlordIds: [lid], permissions: { 'books.view': true } })
  }

  it('happy: returns year, landlord, income, deductions, deposits', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.year).toBe(2026)
    expect(res.body.data).toHaveProperty('income')
    expect(res.body.data).toHaveProperty('deductions')
    expect(res.body.data).toHaveProperty('deposits')
    expect(res.body.data).toHaveProperty('netIncome')
    expect(res.body.data).toHaveProperty('w2099Threshold')
  })

  it('totalRent sums settled payments for the year', async () => {
    const f = await seed()
    // Two settled rent payments in 2026, one in 2025 (should not count).
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 1000,
                                    dueDate: '2026-03-15' })
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 1500,
                                    dueDate: '2026-07-15' })
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 9999,
                                    dueDate: '2025-12-15' })
    const res = await request(buildApp())
      .get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    expect(parseFloat(res.body.data.income.totalRent)).toBe(2500)
    expect(res.body.data.income.paymentCount).toBe(2)
  })

  it('deductions.platformFees = billed income summed over the year (×12 for a full past year)', async () => {
    const f = await seed()
    // 2025 is fully elapsed; fixture lease overlaps every month → 1 billable
    // unit/mo → $10/mo × 12 = $120. Sourced from billed income, not a snapshot ×12.
    const res = await request(buildApp())
      .get('/api/reports/tax-summary?year=2025')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.deductions.platformFees).toBe(120)
  })

  it('w2099Threshold filters work trade with applied credit >= 600', async () => {
    const f = await seed()
    // S517: bartered value = work-trade credit applied to invoices that year.
    await seedWtCredit({ landlordId: f.aLid, tenantId: f.tenant1Id, unitId: f.aUnitId, leaseId: f.lease1Id, creditValue: 700, dueDate: '2026-01-01' })
    await seedWtCredit({ landlordId: f.aLid, tenantId: f.tenant1Id, unitId: f.aUnitId, leaseId: f.lease1Id, creditValue: 200, dueDate: '2026-02-01' })
    const res = await request(buildApp())
      .get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.w2099Threshold).toHaveLength(1)
    expect(parseFloat(res.body.data.w2099Threshold[0].credit_value)).toBe(700)
  })

  it('owner without books.view auto-passes via OWNER_ROLES', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)  // no perm in token
    expect(res.status).toBe(200)
  })

  it('bookkeeper without books.view → 403', async () => {
    const bookkeeper = sign({ userId: randomUUID(), role: 'bookkeeper',
                                email: 'bk@t.dev', profileId: randomUUID(),
                                landlordId: randomUUID(), permissions: {} })
    const res = await request(buildApp())
      .get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${bookkeeper}`)
    expect(res.status).toBe(403)
  })
})

// ─── GET /api/reports/property-pl ───────────────────────────

describe('GET /api/reports/property-pl', () => {
  it('happy: returns properties array scoped to caller landlord', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/reports/property-pl')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    // S654: "this year" on the database's (Phoenix) calendar, as the route reads it.
    const thisYear = (await db.query<{ y: number }>(
      `SELECT extract(year FROM CURRENT_DATE)::int AS y`)).rows[0].y
    expect(res.body.data.year).toBe(thisYear)
    expect(res.body.data.month).toBeNull()
    expect(res.body.data.properties).toHaveLength(1)
    expect(res.body.data.properties[0].id).toBe(f.aPropId)
  })

  it('rent_collected sums settled payments in the year window', async () => {
    const f = await seed()
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 1000,
                                    dueDate: '2026-04-15' })
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 1200,
                                    dueDate: '2026-05-15' })
    const res = await request(buildApp()).get('/api/reports/property-pl?year=2026')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(parseFloat(res.body.data.properties[0].rent_collected)).toBe(2200)
  })

  it('month filter narrows the window', async () => {
    const f = await seed()
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 1000,
                                    dueDate: '2026-04-15' })
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.aLid, amount: 9999,
                                    dueDate: '2026-05-15' })
    const res = await request(buildApp())
      .get('/api/reports/property-pl?year=2026&month=4')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.month).toBe(4)
    expect(parseFloat(res.body.data.properties[0].rent_collected)).toBe(1000)
  })

  it('platform_fees = billed income per month (month = $10 min, full past year = ×12)', async () => {
    const f = await seed()
    // Fixture lease (start 2025-01-01, no end) overlaps every month → 1 billable
    // unit/month → max(1×$2, $10 min) = $10/mo. No accruals seeded, so the live
    // estimate is used. 2025 is a fully-elapsed year → all 12 months counted.
    const yearRes = await request(buildApp()).get('/api/reports/property-pl?year=2025')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(yearRes.status).toBe(200)
    expect(yearRes.body.data.properties[0].platform_fees).toBe(120) // $10 × 12
    const monthRes = await request(buildApp())
      .get('/api/reports/property-pl?year=2025&month=6')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(monthRes.body.data.properties[0].platform_fees).toBe(10)
  })

  it('a month that has not occurred is never billed (future month → $0 platform fee)', async () => {
    const f = await seed()
    // Next year is entirely in the future → no platform fee for any month.
    const nextYear = new Date().getFullYear() + 1
    const monthRes = await request(buildApp())
      .get(`/api/reports/property-pl?year=${nextYear}&month=6`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(monthRes.status).toBe(200)
    expect(monthRes.body.data.properties[0].platform_fees).toBe(0)
    const yearRes = await request(buildApp())
      .get(`/api/reports/property-pl?year=${nextYear}`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(yearRes.body.data.properties[0].platform_fees).toBe(0)
  })

  it('no payments×maintenance fan-out: sums stay independent when a unit has both', async () => {
    const f = await seed()
    // 2 settled payments AND 2 completed maintenance rows on the SAME unit.
    // The old multi-LEFT-JOIN inflated each sum by the other table's row
    // count (rent → ×2 maint rows = 4000; maint → ×2 payment rows = 200).
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000, dueDate: '2026-04-15' })
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000, dueDate: '2026-05-15' })
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 50, platformFee: 4, completedAt: '2026-04-20T10:00:00Z' })
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 50, platformFee: 4, completedAt: '2026-05-20T10:00:00Z' })
    const res = await request(buildApp()).get('/api/reports/property-pl?year=2026')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const p = res.body.data.properties[0]
    expect(parseFloat(p.rent_collected)).toBe(2000)
    expect(parseFloat(p.maint_cost)).toBe(100)
  })

  it('non-owner without payments.view_all → 403', async () => {
    const f = await seed()
    const pmNoPerm = sign({ userId: randomUUID(), role: 'property_manager',
                             email: 'pm@t.dev', profileId: randomUUID(),
                             landlordId: f.aLid, permissions: {} })
    const res = await request(buildApp()).get('/api/reports/property-pl')
      .set('Authorization', `Bearer ${pmNoPerm}`)
    expect(res.status).toBe(403)
  })
})

// ─── GET /api/reports/property-detail ───────────────────────

describe('GET /api/reports/property-detail', () => {
  it('happy: returns property, summary, units, payments, maintenance, trend', async () => {
    const f = await seed()
    // Use a fully-elapsed year (2025) so the platform fee is a stable ×12.
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000, dueDate: '2025-04-15' })
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 50, platformFee: 4, completedAt: '2025-04-20T10:00:00Z' })
    const res = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${f.aPropId}&year=2025`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.property.id).toBe(f.aPropId)
    expect(d.property.totalUnits).toBe(1)
    expect(d.units).toHaveLength(1)
    expect(d.payments).toHaveLength(1)
    expect(d.maintenance).toHaveLength(1)
    // collected 1000 − maint 50 − platform ($10/mo × 12) 120 = 830.
    // The 8% maintenance platform fee ($4) is NOT deducted — not billed today.
    expect(d.summary.collected).toBe(1000)
    expect(d.summary.maintCost).toBe(50)
    expect(d.summary.platformFee).toBe(120)
    expect(d.summary.net).toBe(830)
    expect(d.monthlyTrend.find((t: any) => t.month === '2025-04').collected).toBe(1000)
  })

  it('month filter narrows payments + platform fee to that month', async () => {
    const f = await seed()
    await db.query(`UPDATE units SET status='active' WHERE id=$1`, [f.aUnitId])
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 1000, dueDate: '2026-04-15' })
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 9999, dueDate: '2026-05-15' })
    const res = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${f.aPropId}&year=2026&month=4`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.payments).toHaveLength(1)
    expect(res.body.data.summary.collected).toBe(1000)
    expect(res.body.data.summary.platformFee).toBe(10) // single month
  })

  it('cross-landlord property → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${f.bPropId}&year=2026`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(404)
  })

  it('missing propertyId → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/reports/property-detail?year=2026')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(400)
  })

  it('non-owner without payments.view_all → 403', async () => {
    const f = await seed()
    const pmNoPerm = sign({ userId: randomUUID(), role: 'property_manager',
                             email: 'pm@t.dev', profileId: randomUUID(),
                             landlordId: f.aLid, permissions: {} })
    const res = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${f.aPropId}&year=2026`)
      .set('Authorization', `Bearer ${pmNoPerm}`)
    expect(res.status).toBe(403)
  })

  // The bug Nic caught: a property that earned rent showed a $0 platform fee.
  it('short-stay bookings alone bill a platform fee (no long-term lease — the $0 bug)', async () => {
    const f = await seed()
    // Fresh property whose only occupancy is a 30-night booking — no lease, so
    // v_unit_occupancy calls every unit vacant. It still earns, so GAM still
    // bills: 30 nights → 1 billable unit → $10 for the month. The old snapshot
    // logic returned $0 here.
    const propId = await seedProperty(db as any, { landlordId: f.aLid, ownerUserId: f.aUid, managedByUserId: f.aUid })
    await db.query(`UPDATE properties SET created_at = '2024-01-01' WHERE id = $1`, [propId])
    const unitId = await seedUnit(db as any, { propertyId: propId, landlordId: f.aLid })
    // S637: the nights aggregation only counts rv_spot / campsite / boat_slip
    // (NIGHTS_AGGREGATION_UNIT_TYPES). The default seeded type is not one, so
    // this fixture produced ZERO billable and only reached $10 via the floor —
    // it was passing for the opposite of the reason it claims. Now the nights
    // genuinely count: 30 → 1 billable → $2 → lifted to the $10 floor.
    await db.query(`UPDATE units SET unit_type = 'rv_spot' WHERE id = $1`, [unitId])
    await seedBooking({ unitId, landlordId: f.aLid, checkIn: '2025-04-01', checkOut: '2025-05-01' })
    await seedSettledRentPayment({ unitId, tenantId: f.tenant1Id, landlordId: f.aLid, amount: 900, dueDate: '2025-04-10' })
    const res = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${propId}&year=2025&month=4`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.property.occupiedUnits).toBe(0) // no long-term lease
    expect(res.body.data.summary.collected).toBe(900)
    expect(res.body.data.summary.platformFee).toBe(10)   // ← was $0 before the fix
  })

  it('S631: a fully-vacant property bills NOTHING — the floor is not a subscription', async () => {
    const f = await seed()
    // Fresh property with a unit but NO lease and NO booking — zero occupancy.
    const propId = await seedProperty(db as any, { landlordId: f.aLid, ownerUserId: f.aUid, managedByUserId: f.aUid })
    await db.query(`UPDATE properties SET created_at = '2024-01-01' WHERE id = $1`, [propId])
    await seedUnit(db as any, { propertyId: propId, landlordId: f.aLid })
    const res = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${propId}&year=2025&month=4`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.property.occupiedUnits).toBe(0)
    // S631 (Nic, DIRECTIVE): "We do ten dollars a month minimum, but only when
    // money's moving through the system. Leaving it vacant forever as a ghost
    // in the system is okay." The accrual has obeyed that since S631; the
    // REPORT still floored an empty property, so the two disagreed and this
    // test pinned the wrong side. An empty month bills nothing.
    expect(res.body.data.summary.platformFee).toBe(0)
  })

  it('real onboarding: no platform fee for months before the property joined the platform', async () => {
    const f = await seed()
    // A property that onboarded May 15, 2026 (real data — NOT backdated).
    const propId = await seedProperty(db as any, { landlordId: f.aLid, ownerUserId: f.aUid, managedByUserId: f.aUid })
    await db.query(`UPDATE properties SET created_at = '2026-05-15' WHERE id = $1`, [propId])
    const onbUnit = await seedUnit(db as any, { propertyId: propId, landlordId: f.aLid })
    // S637: give it a real tenancy from the day it onboarded. This used to be a
    // bare unit, and May's $10 came from the floor being applied to a month
    // with nobody in it — the behavior S631 removed. The point of the test is
    // that months BEFORE onboarding bill nothing; occupancy is what makes the
    // month after it bill at all.
    const onbLease = await seedLease(db as any, {
      unitId: onbUnit, landlordId: f.aLid, status: 'active', startDate: '2026-05-15' })
    await db.query(`UPDATE leases SET end_date = NULL WHERE id = $1`, [onbLease])
    // April — before onboarding → $0 (nothing in expenses).
    const apr = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${propId}&year=2026&month=4`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(apr.status).toBe(200)
    expect(apr.body.data.summary.platformFee).toBe(0)
    // May — the onboarding month → $10 (charged from here forward).
    const may = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${propId}&year=2026&month=5`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(may.body.data.summary.platformFee).toBe(10)
  })

  it('uses the actual billed accrual over the live estimate when a row exists', async () => {
    const f = await seed()
    // A real accrual row (e.g. a landlord rate override) of $7.50 for the month.
    // The live estimate would say $10; the report must report the billed $7.50.
    await db.query(`INSERT INTO platform_fee_accruals
      (landlord_id, property_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer)
      VALUES ($1,$2,'2025-04-01',2,10,7.50,'landlord')`, [f.aLid, f.aPropId])
    const res = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${f.aPropId}&year=2025&month=4`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.summary.platformFee).toBe(7.5)
  })
})

// ─── GET /api/reports/work-trade-1099 ───────────────────────

describe('GET /api/reports/work-trade-1099', () => {
  function ownerTokenWithBooks(uid: string, lid: string) {
    return sign({ userId: uid, role: 'landlord', email: 'a@t.dev',
                   profileId: null, landlordIds: [lid], permissions: { 'books.view': true } })
  }

  it('happy: returns landlord, agreements, eligible, summary', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/reports/work-trade-1099?year=2026')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.year).toBe(2026)
    expect(res.body.data).toHaveProperty('landlord')
    expect(res.body.data).toHaveProperty('agreements')
    expect(res.body.data).toHaveProperty('eligible')
    expect(res.body.data.summary).toEqual(
      expect.objectContaining({ totalAgreements: 0, eligible1099Count: 0, totalValue: 0 }))
  })

  it('eligible1099Count = agreements with applied credit >= 600', async () => {
    const f = await seed()
    await seedWtCredit({ landlordId: f.aLid, tenantId: f.tenant1Id, unitId: f.aUnitId, leaseId: f.lease1Id, creditValue: 599,  dueDate: '2026-01-01' })
    await seedWtCredit({ landlordId: f.aLid, tenantId: f.tenant1Id, unitId: f.aUnitId, leaseId: f.lease1Id, creditValue: 600,  dueDate: '2026-02-01' })
    await seedWtCredit({ landlordId: f.aLid, tenantId: f.tenant1Id, unitId: f.aUnitId, leaseId: f.lease1Id, creditValue: 1500, dueDate: '2026-03-01' })
    const res = await request(buildApp())
      .get('/api/reports/work-trade-1099?year=2026')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.summary.totalAgreements).toBe(3)
    expect(res.body.data.summary.eligible1099Count).toBe(2)
    expect(parseFloat(res.body.data.summary.totalValue)).toBe(599 + 600 + 1500)
  })

  it('cross-landlord agreements not returned', async () => {
    const f = await seed()
    // B's enrollment is scoped out of A's report regardless of any credit.
    await db.query(
      `INSERT INTO work_trade_agreements (landlord_id, tenant_id, unit_id, start_date, status)
       VALUES ($1, $2, $3, '2026-01-01', 'active')`,
      [f.bLid, f.tenant1Id, f.bUnitId])
    const res = await request(buildApp())
      .get('/api/reports/work-trade-1099?year=2026')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.agreements).toHaveLength(0)
  })

  it('non-owner without books.view → 403', async () => {
    const f = await seed()
    const pmNoPerm = sign({ userId: randomUUID(), role: 'property_manager',
                             email: 'pm@t.dev', profileId: randomUUID(),
                             landlordId: f.aLid, permissions: {} })
    const res = await request(buildApp())
      .get('/api/reports/work-trade-1099?year=2026')
      .set('Authorization', `Bearer ${pmNoPerm}`)
    expect(res.status).toBe(403)
  })

  it('caller without landlord scope → 400', async () => {
    const noScope = sign({ userId: randomUUID(), role: 'tenant',
                            email: 't@t.dev', profileId: randomUUID(),
                            permissions: { 'books.view': true } })
    const res = await request(buildApp())
      .get('/api/reports/work-trade-1099?year=2026')
      .set('Authorization', `Bearer ${noScope}`)
    expect(res.status).toBe(400)
  })
})

// ─── GET /api/reports/monthly-pl — S512 #20 ─────────────────

describe('GET /api/reports/monthly-pl', () => {
  it('returns gross/expenses/net + actual-payment-date breakdown', async () => {
    const f = await seed()
    // Two settled rent payments in March 2026, distinct due_dates so they
    // don't collide on the partial unique rent index.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
         entry_description, due_date, settled_at, ach_trace_number)
       VALUES ($1,$2,$3,'rent',1500,'settled','RENT','2026-03-01','2026-03-05T10:00:00Z','TRACE1'),
              ($1,$2,$3,'rent',1500,'settled','RENT','2026-03-15','2026-03-20T10:00:00Z','TRACE2')`,
      [f.aUnitId, f.tenant1Id, f.aLid])

    const res = await request(buildApp()).get('/api/reports/monthly-pl?year=2026&month=3')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.gross.rent).toBe(3000)
    expect(d.gross.total).toBe(3000)
    // 1 occupied unit → $2 floored to the $10/property minimum.
    expect(d.expenses.platformFee).toBe(10)
    expect(d.expenses.total).toBe(10)
    expect(d.net).toBe(2990)
    expect(d.paymentCount).toBe(2)
    expect(d.payments).toHaveLength(2)
    // Newest payment first.
    expect(new Date(d.payments[0].settledAt).getTime())
      .toBeGreaterThan(new Date(d.payments[1].settledAt).getTime())
    expect(d.payments[0].method).toBe('ACH')
  })

  it('excludes payments settled outside the requested month', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
         entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,'rent',1000,'settled','RENT','2026-03-01','2026-03-10T10:00:00Z'),
              ($1,$2,$3,'rent',1000,'settled','RENT','2026-04-01','2026-04-10T10:00:00Z')`,
      [f.aUnitId, f.tenant1Id, f.aLid])
    const res = await request(buildApp()).get('/api/reports/monthly-pl?year=2026&month=3')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.gross.rent).toBe(1000)
    expect(res.body.data.paymentCount).toBe(1)
  })

  it('separates rent from other income in gross', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
         entry_description, due_date, settled_at, stripe_charge_id)
       VALUES ($1,$2,$3,'rent',1200,'settled','RENT','2026-03-01','2026-03-05T10:00:00Z','ch_1'),
              ($1,$2,$3,'late_fee',50,'settled','LATEFEE','2026-03-02','2026-03-06T10:00:00Z','ch_2')`,
      [f.aUnitId, f.tenant1Id, f.aLid])
    const res = await request(buildApp()).get('/api/reports/monthly-pl?year=2026&month=3')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.gross.rent).toBe(1200)
    expect(res.body.data.gross.other).toBe(50)
    expect(res.body.data.gross.total).toBe(1250)
    expect(res.body.data.payments.find((p: any) => p.type === 'late_fee').method).toBe('Card')
  })

  it('landlord-scoped: B sees nothing for A activity', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
         entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,'rent',1000,'settled','RENT','2026-03-01','2026-03-10T10:00:00Z')`,
      [f.aUnitId, f.tenant1Id, f.aLid])
    const res = await request(buildApp()).get('/api/reports/monthly-pl?year=2026&month=3')
      .set('Authorization', `Bearer ${f.tokenLandlordB}`)
    expect(res.status).toBe(200)
    expect(res.body.data.gross.total).toBe(0)
    expect(res.body.data.paymentCount).toBe(0)
  })

  it('rejects an out-of-range month', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/reports/monthly-pl?year=2026&month=13')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(400)
  })

  it('non-owner role without payments.view_all → 403', async () => {
    const f = await seed()
    const pmNoPerm = sign({ userId: randomUUID(), role: 'property_manager',
                             email: 'pm@t.dev', profileId: randomUUID(),
                             landlordId: f.aLid, permissions: {} })
    const res = await request(buildApp()).get('/api/reports/monthly-pl?year=2026&month=3')
      .set('Authorization', `Bearer ${pmNoPerm}`)
    expect(res.status).toBe(403)
  })
})

// ── S603: flexible report engine + T-12 preset ─────────────────────────────
// These assert real MONEY, so every expectation is a hand-computed number, not
// a reflection of whatever the engine happened to return.
describe('GET /reports/query — flexible engine', () => {
  async function seedSettledRent(args: {
    landlordId: string; unitId: string; tenantId: string
    amount: number; settledAt: string; type?: string
  }) {
    await db.query(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,$5,'settled','RENT',$6::date,$6::timestamptz)`,
      [args.unitId, args.tenantId, args.landlordId,
       args.type ?? 'rent', args.amount, args.settledAt])
  }

  async function seedExpense(args: {
    landlordId: string; propertyId: string; unitId?: string | null
    category: string; amount: number; date: string
  }) {
    await db.query(
      `INSERT INTO landlord_expenses
         (landlord_id, property_id, unit_id, category, amount, expense_date, status)
       VALUES ($1,$2,$3,$4,$5,$6::date,'active')`,
      [args.landlordId, args.propertyId, args.unitId ?? null,
       args.category, args.amount, args.date])
  }

  it('sums income and expenses over an ARBITRARY range (not a whole month)', async () => {
    const f = await seed()
    // In range (Mar 10 – Mar 20), plus one on each boundary day.
    await seedSettledRent({ landlordId: f.aLid, unitId: f.aUnitId, tenantId: f.tenant1Id, amount: 1000, settledAt: '2025-03-10' })
    await seedSettledRent({ landlordId: f.aLid, unitId: f.aUnitId, tenantId: f.tenant1Id, amount: 500,  settledAt: '2025-03-20' })
    // Outside the range — must NOT count.
    await seedSettledRent({ landlordId: f.aLid, unitId: f.aUnitId, tenantId: f.tenant1Id, amount: 9999, settledAt: '2025-03-09' })
    await seedSettledRent({ landlordId: f.aLid, unitId: f.aUnitId, tenantId: f.tenant1Id, amount: 8888, settledAt: '2025-03-21' })
    await seedExpense({ landlordId: f.aLid, propertyId: f.aPropId, unitId: f.aUnitId, category: 'repairs', amount: 200, date: '2025-03-15' })

    const res = await request(buildApp())
      .get('/api/reports/query?start=2025-03-10&end=2025-03-20&level=portfolio&bucket=total')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const t = res.body.data.totals
    expect(t.income.rent).toBe(1500)          // 1000 + 500, boundaries inclusive
    expect(t.expenses.entered).toBe(200)
    expect(t.expenses.byCategory.repairs).toBe(200)
  })

  it('a DEPOSIT is never counted as income (it is a held liability)', async () => {
    const f = await seed()
    await seedSettledRent({ landlordId: f.aLid, unitId: f.aUnitId, tenantId: f.tenant1Id, amount: 1000, settledAt: '2025-04-05' })
    await seedSettledRent({ landlordId: f.aLid, unitId: f.aUnitId, tenantId: f.tenant1Id, amount: 2000, settledAt: '2025-04-06', type: 'deposit' })

    const res = await request(buildApp())
      .get('/api/reports/query?start=2025-04-01&end=2025-04-30&level=portfolio&bucket=total')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const t = res.body.data.totals
    expect(t.income.rent).toBe(1000)
    expect(t.income.total).toBe(1000)   // the 2000 deposit is absent entirely
  })

  it('monthly bucket splits the range into months', async () => {
    const f = await seed()
    await seedSettledRent({ landlordId: f.aLid, unitId: f.aUnitId, tenantId: f.tenant1Id, amount: 100, settledAt: '2025-01-15' })
    await seedSettledRent({ landlordId: f.aLid, unitId: f.aUnitId, tenantId: f.tenant1Id, amount: 250, settledAt: '2025-02-15' })

    const res = await request(buildApp())
      .get('/api/reports/query?start=2025-01-01&end=2025-02-28&level=portfolio&bucket=monthly')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const byPeriod: Record<string, number> = {}
    for (const r of res.body.data.rows) byPeriod[r.period] = r.income.rent
    expect(byPeriod['2025-01']).toBe(100)
    expect(byPeriod['2025-02']).toBe(250)
  })

  // S603 (Nic): a property-level cost must land in per-unit numbers. Insurance
  // is a property expense but a per-unit cost in how operators actually think.
  it('spreads a property-level expense across every unit at unit level', async () => {
    const f = await seed()
    const c = await db.connect()
    let unit2 = ''
    try { unit2 = await seedUnit(c, { propertyId: f.aPropId, landlordId: f.aLid }) }
    finally { c.release() }

    // $900 insurance on the property, tied to NO unit and NOT flagged for
    // allocation — under the old rule this vanished from per-unit cost.
    await seedExpense({ landlordId: f.aLid, propertyId: f.aPropId, unitId: null,
                        category: 'insurance', amount: 900, date: '2025-06-15' })

    const res = await request(buildApp())
      .get('/api/reports/query?start=2025-06-01&end=2025-06-30&level=unit&bucket=total')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    // 3 units on the property (seed unit + unit2 + ... whatever the fixture has)
    // — each must carry an equal share, and the shares must re-add to $900.
    const unitRows = res.body.data.rows.filter((r: any) => r.unitId || r.unitNumber !== null)
    const shares = res.body.data.rows.map((r: any) => r.expenses.entered).filter((n: number) => n > 0)
    expect(shares.length).toBeGreaterThan(1)          // spread, not parked on one row
    const summed = shares.reduce((a: number, b: number) => a + b, 0)
    expect(Math.round(summed)).toBe(900)              // nothing lost, nothing invented
    expect(new Set(shares.map((n: number) => Math.round(n))).size).toBe(1)  // even split
    expect(unitRows.length).toBeGreaterThan(0)
  })

  it('NEVER leaks another landlord\'s money', async () => {
    const f = await seed()
    await seedSettledRent({ landlordId: f.bLid, unitId: f.bUnitId, tenantId: f.tenant1Id, amount: 7777, settledAt: '2025-05-10' })
    const res = await request(buildApp())
      .get('/api/reports/query?start=2025-05-01&end=2025-05-31&level=portfolio&bucket=total')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totals.income.rent).toBe(0)
  })

  it('rejects a bad range, a bad level, and an oversized daily report', async () => {
    const f = await seed()
    const app = buildApp()
    const call = (qs: string) => request(app).get(`/api/reports/query?${qs}`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect((await call('start=2025-05-31&end=2025-05-01')).status).toBe(400)   // end before start
    expect((await call('start=2025-05-01&end=2025-05-31&level=galaxy')).status).toBe(400)
    expect((await call('start=2020-01-01&end=2025-12-31&bucket=daily')).status).toBe(400)
  })
})

describe('GET /reports/t12 — trailing twelve months', () => {
  it('covers 12 complete months and EXCLUDES the current partial month', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/reports/t12')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const m = res.body.data.meta
    expect(m.report).toBe('T-12')
    expect(m.months).toBe(12)
    expect(m.bucket).toBe('monthly')

    // End must be the last day of LAST month — never today's month.
    const end = new Date(m.end + 'T00:00:00Z')
    const now = new Date()
    const thisMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    expect(end.getTime()).toBeLessThan(thisMonthStart)

    // Start must be exactly 11 months before the end month.
    const start = new Date(m.start + 'T00:00:00Z')
    const span = (end.getUTCFullYear() - start.getUTCFullYear()) * 12
      + (end.getUTCMonth() - start.getUTCMonth())
    expect(span).toBe(11)
    expect(start.getUTCDate()).toBe(1)
  })

  it('refuses a property outside the caller\'s portfolio', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/reports/t12?propertyId=${f.bPropId}`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    // Landlord A asking for landlord B's property returns no money either way.
    expect([200, 403]).toContain(res.status)
    if (res.status === 200) expect(res.body.data.totals.income.total).toBe(0)
  })
})

// ── S654: EVERY DOLLAR COUNTED ONCE ─────────────────────────────────────────
// A landlord's income is their own money only. A GAM fee carrying the
// landlord_id (revenue_owner 'gam') is GAM's revenue; a deposit is held, not
// income; paid-ahead money GAM holds ('held') becomes the landlord's as rent
// when it is drawn down — counting it at settlement too counted it twice.
async function seedSettledRow(opts: {
  unitId: string; tenantId: string; landlordId: string
  type: string; amount: number; revenueOwner: 'landlord' | 'gam' | 'held'
  entry: string; dueDate: string; settledAt: string
}): Promise<void> {
  await db.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
       entry_description, due_date, settled_at, revenue_owner)
     VALUES ($1,$2,$3,$4,$5,'settled',$6,$7::date,$8::timestamptz,$9)`,
    [opts.unitId, opts.tenantId, opts.landlordId, opts.type, opts.amount,
     opts.entry, opts.dueDate, opts.settledAt, opts.revenueOwner])
}

describe('S654: every dollar counted once in the landlord reports', () => {
  // The reviewer's September: $700 rent, a $6 GAM decline fee, a $500 held deposit.
  async function seedSeptember(f: Fixture) {
    const base = { unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid }
    await seedSettledRow({ ...base, type: 'rent', amount: 700, revenueOwner: 'landlord', entry: 'RENT',
      dueDate: '2026-09-01', settledAt: '2026-09-03T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'fee', amount: 6, revenueOwner: 'gam', entry: 'DECLINEFEE',
      dueDate: '2026-09-04', settledAt: '2026-09-05T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'deposit', amount: 500, revenueOwner: 'held', entry: 'DEPOSIT',
      dueDate: '2026-09-01', settledAt: '2026-09-02T10:00:00-07:00' })
  }
  const sum = (rows: any[]) => Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100

  it('monthly-pl: rent 700, fees 0, the deposit held apart, and the rows sum to the gross', async () => {
    const f = await seed()
    await seedSeptember(f)
    const res = await request(buildApp()).get('/api/reports/monthly-pl?year=2026&month=9')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.gross.rent).toBe(700)
    expect(d.gross.fees).toBe(0)
    expect(d.gross.total).toBe(700)
    expect(d.depositsHeld).toBe(500)
    expect(d.paymentCount).toBe(1)
    expect(d.payments.map((p: any) => p.type)).toEqual(['rent'])
    expect(sum(d.payments)).toBe(d.gross.total - d.gross.otherIncome)
  })

  it('monthly-statement: the GAM fee and the deposit stay out of income', async () => {
    const f = await seed()
    await seedSeptember(f)
    const res = await request(buildApp()).get('/api/reports/monthly-statement?year=2026&month=9')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const s = res.body.data.summary
    expect(s.rentCollected).toBe(700)
    expect(s.otherIncome).toBe(0)
    expect(s.totalIncome).toBe(700)
    expect(s.depositsCollected).toBe(500)
  })

  it('tax-summary: totalRent is 700 and the monthly breakdown sums to it', async () => {
    const f = await seed()
    await seedSeptember(f)
    const res = await request(buildApp()).get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(parseFloat(d.income.totalRent)).toBe(700)
    expect(d.income.paymentCount).toBe(1)
    const months = d.monthlyBreakdown.map((m: any) => ({ month: m.month, collected: parseFloat(m.collected) }))
    expect(months.reduce((s: number, m: any) => s + m.collected, 0)).toBe(700)
    expect(months.find((m: any) => m.month === 9).collected).toBe(700)
  })

  it('property-pl: rent_collected is 700', async () => {
    const f = await seed()
    await seedSeptember(f)
    const res = await request(buildApp()).get('/api/reports/property-pl?year=2026&month=9')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(parseFloat(res.body.data.properties[0].rent_collected)).toBe(700)
  })

  it('property-detail: collected 700, the deposit reported as held, rows and trend agree', async () => {
    const f = await seed()
    await seedSeptember(f)
    const res = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${f.aPropId}&year=2026&month=9`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.summary.collected).toBe(700)
    expect(d.summary.depositsHeld).toBe(500)
    expect(d.payments.map((p: any) => p.type)).toEqual(['rent'])
    expect(sum(d.payments.filter((p: any) => p.status === 'settled'))).toBe(d.summary.collected)
    expect(d.monthlyTrend.find((t: any) => t.month === '2026-09').collected).toBe(700)
  })

  // S655 (Nic, 10/2, binding): "Money received" is strictly the day money
  // ARRIVED. Paid-ahead money GAM holds counts in full in August, when the
  // card payment arrived, on its own line — and $0 in September when it pays
  // the rent. "Money billed" counts the September bill, covered by money paid
  // ahead. Either way the money counts once.
  it('paid-ahead money GAM holds counts once: received when it arrived, $0 when it pays; billed covered by money paid ahead', async () => {
    const f = await seed()
    // August: the tenant pays September ahead (a 'prepaid' box → revenue_owner
    // 'held'); settling it banks the paid-ahead credit (M3 trigger), funded by GAM.
    const box = await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
       VALUES ($1,'last_month_rent',700,false,'move_in','prepaid') RETURNING id`, [f.lease1Id])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                             due_date, settled_at, revenue_owner, lease_fee_id, platform_held, stripe_charge_id)
       VALUES ($1,$2,$3,$4,'fee',700,'settled','OTHERFEE','2026-08-01','2026-08-05T10:00:00-07:00','held',$5,TRUE,'ch_box')`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid, box.rows[0].id])
    const credit = await db.query<{ id: string; funded_by: string }>(
      `SELECT id, funded_by FROM lease_prepaid_credits WHERE lease_id = $1`, [f.lease1Id])
    expect(credit.rows[0].funded_by).toBe('gam')
    // September: the rent bill is paid by that credit and settles.
    const sep = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',700,'pending','RENT','2026-09-01') RETURNING id`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid])
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,700,'2026-09-01','whole_bill','applied','2026-09-01T07:00:00-07:00')`,
      [credit.rows[0].id, sep.rows[0].id, f.lease1Id])
    await db.query(`UPDATE payments SET status='settled', settled_at='2026-09-01T07:00:00-07:00', platform_held=TRUE WHERE id=$1`,
      [sep.rows[0].id])

    const get = (m: number, basis: string) => request(buildApp()).get(`/api/reports/monthly-pl?year=2026&month=${m}&basis=${basis}`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    const aug = (await get(8, 'received')).body.data
    const sep9 = (await get(9, 'received')).body.data
    expect(aug.gross.total).toBe(700)
    expect(aug.lines).toEqual([{ line: 'paidAhead', label: 'Paid ahead for later bills', amount: 700 }])
    expect(aug.payments).toHaveLength(0)
    expect(sep9.gross.rent).toBe(0)
    expect(sep9.gross.total).toBe(0)
    expect(aug.gross.total + sep9.gross.total).toBe(700)
    const sepBilled = (await get(9, 'billed')).body.data
    expect(sepBilled.gross.rent).toBe(700)
    expect(sepBilled.parts).toEqual([{ part: 'coveredByPaidAhead', label: 'Covered by money paid ahead', amount: 700 }])
    expect((await get(8, 'billed')).body.data.gross.total).toBe(0)

    const tax = (await request(buildApp()).get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)).body.data
    expect(parseFloat(tax.income.totalRent)).toBe(700)
    const augStatement = (await request(buildApp()).get('/api/reports/monthly-statement?year=2026&month=8')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)).body.data.summary
    expect(augStatement.totalIncome).toBe(700)
    expect(augStatement.rentCollected).toBe(0)
  })
})

// ── S654: the period's last day counts in full, in the rows and the totals ───
// Round 3 moved these ends from `<= end` to `< end::date + 1`. A bare
// 'YYYY-MM-DD' end is midnight at the START of the day, and monthRange's
// '...T23:59:59-07:00' drops the month's final half-second.
describe('S654: report day bounds take the whole last day', () => {
  it('monthly-pl: a payment settled at 23:59:59.5 on Sept 30 is in payments[] and gross.rent', async () => {
    const f = await seed()
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid,
      amount: 800, dueDate: '2026-09-01', settledAt: '2026-09-30T23:59:59.5-07:00' })
    // First instant of October: not September's.
    await seedSettledRentPayment({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid,
      amount: 900, dueDate: '2026-10-01', settledAt: '2026-10-01T00:00:00-07:00' })
    const res = await request(buildApp()).get('/api/reports/monthly-pl?year=2026&month=9')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.gross.rent).toBe(800)
    expect(d.payments).toHaveLength(1)
    expect(d.payments[0].amount).toBe(800)
  })

  it('tax-summary: a repair completed Dec 31 at 6 pm Phoenix counts', async () => {
    const f = await seed()
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 250, completedAt: '2026-12-31T18:00:00-07:00' })
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 999, completedAt: '2027-01-01T00:00:00-07:00' })
    const res = await request(buildApp()).get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.deductions.maintExpenses).toBe(250)
  })

  it('property-pl and property-detail (month=9) count a repair completed Sept 30 afternoon', async () => {
    const f = await seed()
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 250, completedAt: '2026-09-30T15:00:00-07:00' })
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 999, completedAt: '2026-10-01T00:00:00-07:00' })
    const pl = await request(buildApp()).get('/api/reports/property-pl?year=2026&month=9')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(pl.status).toBe(200)
    expect(parseFloat(pl.body.data.properties[0].maint_cost)).toBe(250)
    const detail = await request(buildApp())
      .get(`/api/reports/property-detail?propertyId=${f.aPropId}&year=2026&month=9`)
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.summary.maintCost).toBe(250)
    expect(detail.body.data.maintenance).toHaveLength(1)
  })
})

// ── S654: ONE DEFINITION OF LANDLORD INCOME, IN EVERY REPORT ────────────────
// services/landlordPL.ts landlordIncomeSql: settled rows that are the
// landlord's money (revenue_owner 'landlord') of kind rent, late fee, fee,
// utility, home-sale payment or carried balance, never a FlexPay pull.
// September: $700 rent + $400 home-sale payment + $50 carried balance = 1,150.
// The $6 GAM decline fee is GAM's; the $500 deposit is held, never income.
describe('S654: one definition of landlord income — every report says 1,150 for September', () => {
  async function seedSept(f: Fixture) {
    const base = { unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid }
    await seedSettledRow({ ...base, type: 'rent', amount: 700, revenueOwner: 'landlord', entry: 'RENT',
      dueDate: '2026-09-01', settledAt: '2026-09-03T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'home_payment', amount: 400, revenueOwner: 'landlord', entry: 'HOMEPMT',
      dueDate: '2026-09-01', settledAt: '2026-09-04T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'carried_balance', amount: 50, revenueOwner: 'landlord', entry: 'BALANCE',
      dueDate: '2026-09-01', settledAt: '2026-09-06T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'fee', amount: 6, revenueOwner: 'gam', entry: 'DECLINEFEE',
      dueDate: '2026-09-04', settledAt: '2026-09-05T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'deposit', amount: 500, revenueOwner: 'landlord', entry: 'DEPOSIT',
      dueDate: '2026-09-01', settledAt: '2026-09-02T10:00:00-07:00' })
  }
  const get = (f: Fixture, path: string) =>
    request(buildApp()).get(path).set('Authorization', `Bearer ${f.tokenLandlordA}`)
  const sum = (rows: any[]) => Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100
  const types = (rows: any[]) => rows.map((r: any) => r.type).sort()

  it('monthly-pl: 1,150 with a "Balances collected" line; the deposit held apart; rows sum to the gross', async () => {
    const f = await seed()
    await seedSept(f)
    const res = await get(f, '/api/reports/monthly-pl?year=2026&month=9')
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.gross).toMatchObject({ rent: 700, fees: 0, utilities: 0, homeSale: 400, balances: 50, other: 450, total: 1150 })
    expect(d.depositsHeld).toBe(500)
    expect(types(d.payments)).toEqual(['carried_balance', 'home_payment', 'rent'])
    expect(sum(d.payments)).toBe(1150)
  })

  it('monthly-statement agrees with monthly-pl for the same month, and its settled rows sum to its totals', async () => {
    const f = await seed()
    await seedSept(f)
    const pl = (await get(f, '/api/reports/monthly-pl?year=2026&month=9')).body.data
    const res = await get(f, '/api/reports/monthly-statement?year=2026&month=9')
    expect(res.status).toBe(200)
    const s = res.body.data.summary
    expect(s.totalIncome).toBe(1150)
    expect(s.totalIncome).toBe(pl.gross.total)
    expect(s.rentCollected).toBe(700)
    expect(s.homeSaleCollected).toBe(400)
    expect(s.balancesCollected).toBe(50)
    expect(s.otherIncome).toBe(450)
    expect(s.rentCollected + s.otherIncome).toBe(s.totalIncome)
    expect(s.depositsCollected).toBe(500)
    expect(s.depositsCollected).toBe(pl.depositsHeld)
    expect(s.totalExpenses).toBe(pl.expenses.total)
    expect(s.netToOwner).toBe(pl.net)
    // S655: the GAM fee is not on the landlord's statement; the rows are the
    // charges behind the income total (they sum to rowsTotal), and the deposit
    // held is its own list — never income.
    const settled = res.body.data.payments.filter((p: any) => p.status === 'settled')
    expect(types(settled)).toEqual(['carried_balance', 'home_payment', 'rent'])
    expect(sum(settled)).toBe(s.totalIncome - s.bankedOtherIncome)
    expect(res.body.data.rowsTotal).toBe(1150)
    expect(res.body.data.deposits.map((d: any) => d.amount)).toEqual([500])
    expect(sum(res.body.data.deposits)).toBe(s.depositsCollected)
    expect(s.totalCollected).toBe(1150)
    expect(s.settledPayments).toBe(3)
  })

  it('tax-summary: totalRent 1,150, broken out by kind, and the months sum to it', async () => {
    const f = await seed()
    await seedSept(f)
    const res = await get(f, '/api/reports/tax-summary?year=2026')
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(parseFloat(d.income.totalRent)).toBe(1150)
    expect(d.income.paymentCount).toBe(3)
    expect(d.income.breakdown).toEqual({ rent: 700, fees: 0, utilities: 0, homeSale: 400, balances: 50 })
    const months = d.monthlyBreakdown.map((m: any) => ({ month: m.month, collected: parseFloat(m.collected) }))
    expect(months.reduce((t: number, m: any) => t + m.collected, 0)).toBe(1150)
    expect(months.find((m: any) => m.month === 9).collected).toBe(1150)
  })

  it('property-pl: rent_collected 1,150', async () => {
    const f = await seed()
    await seedSept(f)
    const res = await get(f, '/api/reports/property-pl?year=2026&month=9')
    expect(res.status).toBe(200)
    expect(parseFloat(res.body.data.properties[0].rent_collected)).toBe(1150)
  })

  it('property-detail: collected 1,150 (no separate definition), the deposit held, rows and trend agree', async () => {
    const f = await seed()
    await seedSept(f)
    const res = await get(f, `/api/reports/property-detail?propertyId=${f.aPropId}&year=2026&month=9`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.summary.collected).toBe(1150)
    expect(d.summary.depositsHeld).toBe(500)
    expect(types(d.payments)).toEqual(['carried_balance', 'home_payment', 'rent'])
    expect(sum(d.payments.filter((p: any) => p.status === 'settled'))).toBe(d.summary.collected)
    expect(d.monthlyTrend.find((t: any) => t.month === '2026-09').collected).toBe(1150)
  })

  it('/reports/query: 1,150 at portfolio, property and unit level; the balance is its own line', async () => {
    const f = await seed()
    await seedSept(f)
    for (const level of ['portfolio', 'property', 'unit']) {
      const res = await get(f, `/api/reports/query?start=2026-09-01&end=2026-09-30&level=${level}&bucket=monthly`)
      expect(res.status).toBe(200)
      const t = res.body.data.totals
      expect(t.income).toMatchObject({ rent: 700, fees: 0, utilities: 0, homeSale: 400, other: 50, total: 1150 })
      const rowIncome = res.body.data.rows.reduce((s: number, r: any) => s + r.income.total, 0)
      expect(rowIncome).toBe(1150)
    }
  })

  it('/reports/t12: the September month carries 1,150', async () => {
    const f = await seed()
    await seedSept(f)
    const res = await get(f, '/api/reports/t12?asOf=2026-10-15')
    expect(res.status).toBe(200)
    expect(res.body.data.totals.income.total).toBe(1150)
    const sept = res.body.data.rows.filter((r: any) => r.period === '2026-09')
    expect(sept.reduce((s: number, r: any) => s + r.income.total, 0)).toBe(1150)
  })

  it('statement and P&L agree when a bill is paid in a later month than it was due', async () => {
    const f = await seed()
    const base = { unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid }
    // August's rent, paid late on Sept 2; September's rent still pending.
    await seedSettledRow({ ...base, type: 'rent', amount: 700, revenueOwner: 'landlord', entry: 'RENT',
      dueDate: '2026-08-01', settledAt: '2026-09-02T10:00:00-07:00' })
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,'rent',700,'pending','RENT','2026-09-01')`, [f.aUnitId, f.tenant1Id, f.aLid])
    for (const m of [8, 9]) {
      const pl = (await get(f, `/api/reports/monthly-pl?year=2026&month=${m}`)).body.data
      const st = (await get(f, `/api/reports/monthly-statement?year=2026&month=${m}`)).body.data
      expect(st.summary.totalIncome).toBe(pl.gross.total)
      expect(st.summary.netToOwner).toBe(pl.net)
      expect(sum(st.payments.filter((p: any) => p.status === 'settled'))).toBe(st.summary.totalCollected)
    }
    const sep = (await get(f, '/api/reports/monthly-statement?year=2026&month=9')).body.data
    expect(sep.summary.totalIncome).toBe(700)
    // S655: Money received lists the money that arrived — the late August
    // payment — and the rows sum to the total. September's open bill brought
    // nothing in; it is counted as late, and it is on the Money billed statement.
    expect(sep.payments.map((p: any) => [p.dueDate, p.status])).toEqual([['2026-08-01', 'settled']])
    expect(sep.rowsTotal).toBe(700)
    expect(sep.summary.latePayments).toBe(1)
    const sepBilled = (await get(f, '/api/reports/monthly-statement?year=2026&month=9&basis=billed')).body.data
    expect(sepBilled.payments.map((p: any) => [p.dueDate, p.status, p.parts])).toEqual([['2026-09-01', 'pending', { stillOwed: 700 }]])
    expect(sepBilled.summary.totalCollected).toBe(0)
    expect(sepBilled.rowsTotal).toBe(sepBilled.summary.totalIncome)
    const aug = (await get(f, '/api/reports/monthly-statement?year=2026&month=8')).body.data
    expect(aug.summary.totalIncome).toBe(0)
    expect(aug.payments).toHaveLength(0)
  })
})

// S654: a FlexPay pull (entry 'FLEXPAY', written only by services/flexpay.ts)
// is GAM reimbursing its own front plus its $25 fee. The landlord was paid by
// the front Transfer, so the pull is never the landlord's income.
describe('S654: a FlexPay pull is not landlord income in any report', () => {
  async function seedWithPull(f: Fixture) {
    const base = { unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid }
    // Rent due on the 5th; the FlexPay pull is dated the cycle's 1st, as flexpay.ts writes it.
    await seedSettledRow({ ...base, type: 'rent', amount: 700, revenueOwner: 'landlord', entry: 'RENT',
      dueDate: '2026-09-05', settledAt: '2026-09-06T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'rent', amount: 725, revenueOwner: 'landlord', entry: 'FLEXPAY',
      dueDate: '2026-09-01', settledAt: '2026-09-12T10:00:00-07:00' })
  }
  const get = (f: Fixture, path: string) =>
    request(buildApp()).get(path).set('Authorization', `Bearer ${f.tokenLandlordA}`)

  it('monthly-pl, statement, tax, property-pl, property-detail, query and summary count only the 700', async () => {
    const f = await seed()
    await seedWithPull(f)
    const pl = (await get(f, '/api/reports/monthly-pl?year=2026&month=9')).body.data
    expect(pl.gross.rent).toBe(700)
    expect(pl.payments).toHaveLength(1)
    const st = (await get(f, '/api/reports/monthly-statement?year=2026&month=9')).body.data
    expect(st.summary.totalIncome).toBe(700)
    expect(st.payments.map((p: any) => p.entryDescription)).toEqual(['RENT'])
    const tax = (await get(f, '/api/reports/tax-summary?year=2026')).body.data
    expect(parseFloat(tax.income.totalRent)).toBe(700)
    const ppl = (await get(f, '/api/reports/property-pl?year=2026&month=9')).body.data
    expect(parseFloat(ppl.properties[0].rent_collected)).toBe(700)
    const det = (await get(f, `/api/reports/property-detail?propertyId=${f.aPropId}&year=2026&month=9`)).body.data
    expect(det.summary.collected).toBe(700)
    expect(det.payments).toHaveLength(1)
    const q = (await get(f, '/api/reports/query?start=2026-09-01&end=2026-09-30&level=unit&bucket=total')).body.data
    expect(q.totals.income.total).toBe(700)
  })

  it('/summary rent figures skip the pull', async () => {
    const f = await seed()
    const base = { unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid }
    const now = new Date().toISOString()
    await seedSettledRow({ ...base, type: 'rent', amount: 700, revenueOwner: 'landlord', entry: 'RENT',
      dueDate: '2026-07-05', settledAt: now })
    await seedSettledRow({ ...base, type: 'rent', amount: 725, revenueOwner: 'landlord', entry: 'FLEXPAY',
      dueDate: '2026-07-01', settledAt: now })
    const d = (await get(f, '/api/reports/summary')).body.data
    expect(d.ytdCollected).toBe(700)
    expect(d.monthly.reduce((s: number, m: any) => s + m.collected, 0)).toBe(700)
  })
})

// ── S655: "Money received" / "Money billed" on every report ──────────────────
describe('S655: the basis switch on every report', () => {
  const get = (f: Fixture, path: string) =>
    request(buildApp()).get(path).set('Authorization', `Bearer ${f.tokenLandlordA}`)

  async function seedSept(f: Fixture) {
    const base = { unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid }
    await seedSettledRow({ ...base, type: 'rent', amount: 700, revenueOwner: 'landlord', entry: 'RENT',
      dueDate: '2026-09-01', settledAt: '2026-09-03T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'home_payment', amount: 400, revenueOwner: 'landlord', entry: 'HOMEPMT',
      dueDate: '2026-09-01', settledAt: '2026-09-04T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'carried_balance', amount: 50, revenueOwner: 'landlord', entry: 'BALANCE',
      dueDate: '2026-09-01', settledAt: '2026-09-06T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'fee', amount: 6, revenueOwner: 'gam', entry: 'DECLINEFEE',
      dueDate: '2026-09-04', settledAt: '2026-09-05T10:00:00-07:00' })
    await seedSettledRow({ ...base, type: 'deposit', amount: 500, revenueOwner: 'landlord', entry: 'DEPOSIT',
      dueDate: '2026-09-01', settledAt: '2026-09-02T10:00:00-07:00' })
  }

  it('every report says 1,150 for September under Money billed too (the bills were due and paid in September)', async () => {
    const f = await seed()
    await seedSept(f)
    const q = 'basis=billed'
    expect((await get(f, `/api/reports/monthly-pl?year=2026&month=9&${q}`)).body.data.gross.total).toBe(1150)
    expect((await get(f, `/api/reports/monthly-statement?year=2026&month=9&${q}`)).body.data.summary.totalIncome).toBe(1150)
    expect((await get(f, `/api/reports/tax-summary?year=2026&${q}`)).body.data.income.totalRent).toBe(1150)
    expect((await get(f, `/api/reports/property-pl?year=2026&month=9&${q}`)).body.data.properties[0].rent_collected).toBe(1150)
    expect((await get(f, `/api/reports/property-detail?propertyId=${f.aPropId}&year=2026&month=9&${q}`)).body.data.breakdown.total).toBe(1150)
    expect((await get(f, `/api/reports/query?start=2026-09-01&end=2026-09-30&level=unit&bucket=total&${q}`)).body.data.totals.income.total).toBe(1150)
    expect((await get(f, `/api/reports/t12?asOf=2026-10-15&${q}`)).body.data.totals.income.total).toBe(1150)
  })

  it('every report echoes meta.basis and refuses an unknown basis', async () => {
    const f = await seed()
    for (const path of [
      '/api/reports/summary', '/api/reports/monthly-pl?year=2026&month=9',
      '/api/reports/monthly-statement?year=2026&month=9', '/api/reports/tax-summary?year=2026',
      '/api/reports/property-pl?year=2026', `/api/reports/property-detail?propertyId=${f.aPropId}&year=2026`,
      '/api/reports/query?start=2026-09-01&end=2026-09-30', '/api/reports/t12?asOf=2026-10-15',
    ]) {
      const ok = await get(f, path)
      expect(ok.status).toBe(200)
      expect(ok.body.data.meta.basis).toMatchObject({ basis: 'received', label: 'Money received' })
      expect(ok.body.data.meta.basis.note).toMatch(/day the money arrived/)
      const billed = await get(f, `${path}${path.includes('?') ? '&' : '?'}basis=billed`)
      expect(billed.body.data.meta.basis.label).toBe('Money billed')
      const bad = await get(f, `${path}${path.includes('?') ? '&' : '?'}basis=accrual`)
      expect(bad.status).toBe(400)
    }
  })

  it('tax-summary net equals the P&L', async () => {
    const f = await seed()
    await seedSept(f)
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 75, completedAt: '2026-09-12T10:00:00-07:00' })
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, description)
       VALUES ($1,$2,'insurance',120,'2026-06-01','Policy')`, [f.aLid, f.aPropId])
    for (const basis of ['received', 'billed']) {
      const tax = (await get(f, `/api/reports/tax-summary?year=2026&basis=${basis}`)).body.data
      const { computeLandlordPL } = await import('../services/landlordPL')
      const { periodMonths } = await import('../services/platformFee')
      const pl = await computeLandlordPL(f.aLid, '2026-01-01', '2026-12-31', periodMonths(2026, null), basis as any)
      expect(tax.netIncome).toBe(pl.net)
      expect(tax.income.totalRent).toBe(pl.gross.total)
      expect(tax.deductions.enteredExpenses).toBe(120)
      const months = tax.monthlyBreakdown.reduce((s: number, m: any) => s + m.collected, 0)
      expect(Math.round(months * 100) / 100).toBe(tax.income.totalRent)
    }
  })

  it('tax-summary shows paid ahead, not used yet at Dec 31 beside the total', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
       VALUES ($1,$2,920,920,'landlord','2026-12-20T10:00:00-07:00','2026-12-20T10:00:00-07:00')`,
      [f.lease1Id, f.tenant1Id])
    const tax = (await get(f, '/api/reports/tax-summary?year=2026')).body.data
    expect(tax.income.totalRent).toBe(920)
    expect(tax.paidAheadUnusedAtYearEnd).toBe(920)
    // The label depends on whether 2026 has ended (paidAheadLeftoverLabel, tested on its own).
    const { paidAheadLeftoverLabel } = await import('./reports')
    expect(tax.paidAheadNextYear).toEqual({ label: paidAheadLeftoverLabel(2026), amount: 920 })
    expect(tax.beside.find((b: any) => b.key === 'paidAheadUnused').amount).toBe(920)
  })

  it('the summary row equals the P&L it opens', async () => {
    const f = await seed()
    const today = new Date().toISOString().slice(0, 10)
    const base = { unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid }
    await seedSettledRow({ ...base, type: 'rent', amount: 700, revenueOwner: 'landlord', entry: 'RENT',
      dueDate: today, settledAt: new Date().toISOString() })
    await seedSettledRow({ ...base, type: 'utility', amount: 35, revenueOwner: 'landlord', entry: 'UTILITY',
      dueDate: today, settledAt: new Date().toISOString() })
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, category, amount, income_date) VALUES ($1,'laundry',15,CURRENT_DATE)`, [f.aLid])
    for (const basis of ['received', 'billed']) {
      const sum = (await get(f, `/api/reports/summary?basis=${basis}`)).body.data
      for (const row of sum.monthly) {
        const [y, m] = row.month.split('-').map(Number)
        const pl = (await get(f, `/api/reports/monthly-pl?year=${y}&month=${m}&basis=${basis}`)).body.data
        expect(row.collected).toBe(pl.gross.total)
      }
      // The KPI is the shared rent card — the dashboard's own figure.
      const { collectedRentMtd } = await import('../lib/rentCollected')
      const card = await collectedRentMtd([f.aLid], null, { basis: basis as any })
      expect(sum.collectedMtd).toBe(basis === 'received' ? card.collected : card.billed.collected)
      expect(sum.collectedMtd).toBe(700)
      expect(sum.incomeCard[basis].amount).toBe(sum.monthly[0].collected)
    }
  })

  it('monthly-pl lists the charges behind the total, and they sum to rowsTotal', async () => {
    const f = await seed()
    await seedSept(f)
    const d = (await get(f, '/api/reports/monthly-pl?year=2026&month=9')).body.data
    expect(d.rowsTotal).toBe(1150)
    expect(d.payments.map((p: any) => p.categoryLabel).sort()).toEqual(['Balances collected', 'Home/trailer payments', 'Lot/space rent'])
    expect(d.lines.map((l: any) => l.line)).toEqual(['rent', 'homeSale', 'balances'])
  })

  it('a move-out shortfall paid in the month is one charge in the list, its whole payment, with no single category; the rent card and the property breakdown collect the swept rent', async () => {
    const f = await seed()
    const fin = '2026-09-15T10:00:00-07:00'
    // $700 of rent swept to a $400 deposit, $100 of cleaning: the $400 gap is paid on Sep 20.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',700,'paid_via_deposit','RENT','2026-09-01',$5)`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid, fin])
    const gap = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, manual_method)
       VALUES ($1,$2,$3,$4,'fee',400,'settled','DEPOSIT','2026-09-15','2026-09-20T10:00:00-07:00','cash') RETURNING id`,
      [f.aUnitId, f.lease1Id, f.tenant1Id, f.aLid])).rows[0].id
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                    status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',700,800,400,$4,'sent_gap',$5)`,
      [f.lease1Id, f.tenant1Id, f.aLid, gap, fin])
    const d = (await get(f, '/api/reports/monthly-pl?year=2026&month=9')).body.data
    expect(d.gross.total).toBe(800)
    const shortfall = d.payments.find((p: any) => p.id === gap)
    expect(shortfall).toMatchObject({ amount: 400, category: null, categoryLabel: null })
    const swept = d.payments.find((p: any) => p.id !== gap)
    expect(swept).toMatchObject({ amount: 400, category: 'space_rent' })
    const detail = (await get(f, `/api/reports/property-detail?propertyId=${f.aPropId}&year=2026&month=9`)).body.data
    expect(detail.breakdown.categories.find((c: any) => c.category === 'space_rent').collected).toBe(700)
    expect(detail.breakdown.total).toBe(800)
  })

  it('a team member assigned to another property gets no P&L for this one', async () => {
    const f = await seed()
    await seedSept(f)
    const pmUid = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','property_manager','P','M') RETURNING id`,
      [`pm-${randomUUID()}@t.dev`])).rows[0].id
    const otherProp = await seedProperty(db as any, { landlordId: f.aLid, ownerUserId: f.aUid, managedByUserId: f.aUid })
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids) VALUES ($1,$2,ARRAY[$3]::uuid[])`,
      [pmUid, f.aLid, otherProp])
    const token = sign({ userId: pmUid, role: 'property_manager', email: 'pm@t.dev', profileId: null,
                         landlordId: f.aLid, permissions: { 'payments.view_all': true } })
    const detail = await request(buildApp()).get(`/api/reports/property-detail?propertyId=${f.aPropId}&year=2026&month=9`)
      .set('Authorization', `Bearer ${token}`)
    expect(detail.status).toBe(404)
    const ppl = await request(buildApp()).get('/api/reports/property-pl?year=2026&month=9')
      .set('Authorization', `Bearer ${token}`)
    expect(ppl.status).toBe(200)
    expect(ppl.body.data.properties.map((p: any) => p.id)).toEqual([otherProp])
  })

  it('a park-2-only manager sees no park-1 money on /summary or /monthly-pl, and is refused the company-wide tax summary, owner statement and 1099 summary', async () => {
    const f = await seed()
    const today = (await db.query<{ d: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d
    const [y, m] = today.split('-').map(Number)
    const at = `${today}T12:00:00-07:00`
    // Park 1 (f.aPropId): $700 of rent and a $75 repair this month. Park 2: $300 of rent.
    await seedSettledRow({ unitId: f.aUnitId, tenantId: f.tenant1Id, landlordId: f.aLid, type: 'rent', amount: 700,
      revenueOwner: 'landlord', entry: 'RENT', dueDate: today, settledAt: at })
    await seedMaint({ unitId: f.aUnitId, landlordId: f.aLid, actualCost: 75, completedAt: at })
    await db.query(`INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on) VALUES ($1,$2,CURRENT_DATE - 3)`,
      [f.aUnitId, f.aLid])
    const park2 = await seedProperty(db as any, { landlordId: f.aLid, ownerUserId: f.aUid, managedByUserId: f.aUid })
    const unit2 = await seedUnit(db as any, { propertyId: park2, landlordId: f.aLid })
    await seedSettledRow({ unitId: unit2, tenantId: f.tenant1Id, landlordId: f.aLid, type: 'rent', amount: 300,
      revenueOwner: 'landlord', entry: 'RENT', dueDate: today, settledAt: at })
    const pmUid = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','property_manager','P','M') RETURNING id`,
      [`pm2-${randomUUID()}@t.dev`])).rows[0].id
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids) VALUES ($1,$2,ARRAY[$3]::uuid[])`,
      [pmUid, f.aLid, park2])
    const token = sign({ userId: pmUid, role: 'property_manager', email: 'pm2@t.dev', profileId: null,
                         landlordId: f.aLid, permissions: { 'payments.view_all': true, 'books.view': true } })
    const pm = (path: string) => request(buildApp()).get(path).set('Authorization', `Bearer ${token}`)

    const sumPm = (await pm('/api/reports/summary')).body.data
    expect(sumPm.collectedMtd).toBe(300)
    expect(sumPm.monthly[0].collected).toBe(300)
    expect(sumPm.totalUnits).toBe(1)
    const sumOwner = (await get(f, '/api/reports/summary')).body.data
    expect(sumOwner.collectedMtd).toBe(1000)

    const plPm = (await pm(`/api/reports/monthly-pl?year=${y}&month=${m}`)).body.data
    expect(plPm.gross.total).toBe(300)
    expect(plPm.payments.map((p: any) => p.amount)).toEqual([300])
    expect(plPm.expenses.maintenance).toBe(0)
    const plOwner = (await get(f, `/api/reports/monthly-pl?year=${y}&month=${m}`)).body.data
    expect(plOwner.gross.total).toBe(1000)
    expect(plOwner.expenses.maintenance).toBe(75)

    for (const path of [`/api/reports/tax-summary?year=${y}`, `/api/reports/monthly-statement?year=${y}&month=${m}`,
                        `/api/reports/work-trade-1099?year=${y}`]) {
      const refused = await pm(path)
      expect(refused.status).toBe(403)
      expect(refused.body.error ?? refused.body.message).toMatch(/covers the whole company/)
      expect(JSON.stringify(refused.body)).not.toMatch(/700/)
      expect((await get(f, path)).status).toBe(200)
    }

    const downPm = (await pm(`/api/reports/site-downtime?year=${y}&month=${m}`)).body.data
    expect(downPm.rows).toEqual([])
    const downOwner = (await get(f, `/api/reports/site-downtime?year=${y}&month=${m}`)).body.data
    expect(downOwner.rows.map((r: any) => r.property_id)).toEqual([f.aPropId])
  })
})
