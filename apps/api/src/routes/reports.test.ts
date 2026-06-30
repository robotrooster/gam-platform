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
      tokenLandlordA: sign({ userId: aUid, role: 'landlord', email: 'a@t.dev',
                              profileId: aLid, permissions: {} }),
      tokenLandlordB: sign({ userId: bUid, role: 'landlord', email: 'b@t.dev',
                              profileId: bLid, permissions: {} }),
      tokenAdmin: sign({ userId: randomUUID(), role: 'admin', email: 'admin@t.dev',
                          profileId: randomUUID() }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

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
             COALESCE($6::timestamptz, NOW())) RETURNING id`,
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
    const now = new Date()
    const currentMonth1Idx = now.getMonth() + 1
    // Pre-fix behavior: returns prior month (currentMonth-1 when called
    // mid-current-month). January edge case wraps to December of prior
    // year via the Date constructor.
    expect(res.body.data.period.month).toBe(currentMonth1Idx - 1)
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
                                    landlordId: f.aLid, amount: 1000 })
    await seedSettledRentPayment({ unitId: f.bUnitId, tenantId: f.tenant1Id,
                                    landlordId: f.bLid, amount: 2000 })
    const res = await request(buildApp())
      .get('/api/reports/monthly-statement?year=2026&month=6')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data.payments as any[]).map(p => p.landlord_id)
    expect(ids.every(lid => lid === f.aLid)).toBe(true)
  })
})

// ─── GET /api/reports/tax-summary ───────────────────────────

describe('GET /api/reports/tax-summary', () => {
  function ownerTokenWithBooks(uid: string, lid: string) {
    return sign({ userId: uid, role: 'landlord', email: 'a@t.dev',
                   profileId: lid, permissions: { 'books.view': true } })
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
    expect(res.body.data.year).toBe(new Date().getFullYear())
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

  it('$10/property minimum full stop: a fully-vacant property still bills $10/mo', async () => {
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
    expect(res.body.data.summary.platformFee).toBe(10) // property minimum, even fully vacant
  })

  it('real onboarding: no platform fee for months before the property joined the platform', async () => {
    const f = await seed()
    // A property that onboarded May 15, 2026 (real data — NOT backdated).
    const propId = await seedProperty(db as any, { landlordId: f.aLid, ownerUserId: f.aUid, managedByUserId: f.aUid })
    await db.query(`UPDATE properties SET created_at = '2026-05-15' WHERE id = $1`, [propId])
    await seedUnit(db as any, { propertyId: propId, landlordId: f.aLid })
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
      (landlord_id, property_id, accrual_month, rate_per_unit, min_per_property, total_amount, payer)
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
                   profileId: lid, permissions: { 'books.view': true } })
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
