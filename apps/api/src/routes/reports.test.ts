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

  it('S408 finding B: summary.totalPlatformFees uses STALE $15/unit hardcode (current pricing is $2)', async () => {
    const f = await seed()
    await db.query(`UPDATE units SET status='active' WHERE id=$1`, [f.aUnitId])
    const res = await request(buildApp())
      .get('/api/reports/monthly-statement?year=2026&month=6')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(res.status).toBe(200)
    // Pre-fix: 1 non-vacant unit * $15 = $15. Current GAM pricing per
    // CLAUDE.md is $2/occupied-unit + $10/property/mo; correct number
    // would come from platform_fee_accruals table. Pin pre-fix value.
    expect(res.body.data.summary.totalPlatformFees).toBe(15)
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

  it('S408 finding B: deductions.platformFees uses STALE $15/non-vacant-unit hardcode', async () => {
    const f = await seed()
    await db.query(`UPDATE units SET status='active' WHERE id=$1`, [f.aUnitId])
    const res = await request(buildApp())
      .get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    // 1 active unit * $15 = $15 (pre-fix). Current pricing per CLAUDE.md
    // would have this come from platform_fee_accruals.
    expect(res.body.data.deductions.platformFees).toBe(15)
  })

  it('w2099Threshold filters work trade with ytd_value >= 600', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO work_trade_agreements
         (landlord_id, tenant_id, unit_id, tax_year, ytd_value, trade_type, hourly_rate, weekly_hours, market_rent, trade_credit_max, start_date, status)
       VALUES ($1, $2, $3, 2026, 700, 'partial', 15, 10, 1000, 500, '2026-01-01', 'active'),
              ($1, $2, $3, 2026, 200, 'partial', 15, 5,  1000, 500, '2026-01-01', 'active')`,
      [f.aLid, f.tenant1Id, f.aUnitId])
    const res = await request(buildApp())
      .get('/api/reports/tax-summary?year=2026')
      .set('Authorization', `Bearer ${ownerTokenWithBooks(f.aUid, f.aLid)}`)
    expect(res.status).toBe(200)
    expect(res.body.data.w2099Threshold).toHaveLength(1)
    expect(parseFloat(res.body.data.w2099Threshold[0].ytd_value)).toBe(700)
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

  it('S408 finding B: platform_fees uses STALE $15/occupied/month hardcode (year=$15*12, month=$15)', async () => {
    const f = await seed()
    await db.query(`UPDATE units SET status='active' WHERE id=$1`, [f.aUnitId])
    // Force occupied via v_unit_occupancy — needs an active lease+tenant.
    const yearRes = await request(buildApp()).get('/api/reports/property-pl?year=2026')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(yearRes.status).toBe(200)
    // year mode: $15 * 12 = $180 per occupied unit
    expect(yearRes.body.data.properties[0].platform_fees).toBe(15 * 12)
    const monthRes = await request(buildApp())
      .get('/api/reports/property-pl?year=2026&month=6')
      .set('Authorization', `Bearer ${f.tokenLandlordA}`)
    expect(monthRes.body.data.properties[0].platform_fees).toBe(15)
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

  it('eligible1099Count = agreements with ytd_value >= 600', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO work_trade_agreements
         (landlord_id, tenant_id, unit_id, tax_year, ytd_value, trade_type, hourly_rate, weekly_hours, market_rent, trade_credit_max, start_date, status)
       VALUES ($1, $2, $3, 2026, 599,  'partial', 15, 10, 1000, 500, '2026-01-01', 'active'),
              ($1, $2, $3, 2026, 600,  'partial', 15, 10, 1000, 500, '2026-01-01', 'active'),
              ($1, $2, $3, 2026, 1500, 'partial', 15, 10, 1000, 500, '2026-01-01', 'active')`,
      [f.aLid, f.tenant1Id, f.aUnitId])
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
    await db.query(
      `INSERT INTO work_trade_agreements
         (landlord_id, tenant_id, unit_id, tax_year, ytd_value, trade_type, hourly_rate, weekly_hours, market_rent, trade_credit_max, start_date, status)
       VALUES ($1, $2, $3, 2026, 700, 'partial', 15, 10, 1000, 500, '2026-01-01', 'active')`,
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
