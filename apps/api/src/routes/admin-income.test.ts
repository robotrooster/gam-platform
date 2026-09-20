/**
 * admin.ts income + onboarding-detail slice — S369
 * (admin.ts slice 3 of N; bulletin moderation removed S567).
 *
 * Coverage focus:
 *   - Income projection: financial rollup with seeded
 *     active-unit + flex tenants — pin the math without testing
 *     every fee constant.
 *   - Onboarding landlord detail: checklist derivation
 *     (bank/property/unit/tenant/onboarding flags).
 *
 * Out of slice (next admin.ts session): NACHA monitoring, audit
 * log viewer, invoices backfill, email failures, OTP+FlexCharge
 * retry, deposit-portability, connect-readiness, onboarding
 * tenant detail (parallel to landlord detail but separate test).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedUserBankAccount,
} from '../test/dbHelpers'
import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_bul'
})

interface AFixture {
  landlordUserId: string
  landlordId:     string
  adminUserId:    string
  superAdminUserId: string
  adminToken:     string
  superAdminToken: string
}

async function seedAFixture(): Promise<AFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const adminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'D', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    const superAdminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'super_admin', 'S', 'U', TRUE) RETURNING id`,
      [`super-${randomUUID()}@test.dev`])
    await client.query('COMMIT')
    const sign = (id: string, role: string) => jwt.sign(
      { userId: id, role, email: 'x@test.dev', profileId: id, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return {
      landlordUserId, landlordId,
      adminUserId:      adminRes.rows[0].id,
      superAdminUserId: superAdminRes.rows[0].id,
      adminToken:       sign(adminRes.rows[0].id, 'admin'),
      superAdminToken:  sign(superAdminRes.rows[0].id, 'super_admin'),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /api/admin/income/projection', () => {
  it('empty fixture: returns zero-everything shape with correct fee constants', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/income/projection')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.monthly).toMatchObject({
      platform_unit_fees: 0, flex_pay_fees: 0, total: 0,
    })
    expect(d.annual).toBe(0)
    expect(d.counts).toMatchObject({
      active_units: 0, flex_pay: 0,
    })
  })

  it('seeded data: math pins direct-unit fees ($2/occupied unit, LAUNCH_PLATFORM_FEE)', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      const u1 = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      const u2 = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      await client.query(`UPDATE units SET status='active' WHERE id IN ($1, $2)`, [u1, u2])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/admin/income/projection')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.counts.active_units).toBe(2)
    // S512+ launch pricing: $2/occupied unit, floored at the $10/property
    // minimum — 2 occupied units on one property = max(2×$2, $10) = $10.
    expect(res.body.data.monthly.platform_unit_fees).toBe(10)
    expect(res.body.data.annual).toBe(120)  // 10 × 12
  })
})

describe('GET /api/admin/onboarding/landlord/:id — detail + checklist', () => {
  it('happy path: checklist reflects state (bank=false initially)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get(`/api/admin/onboarding/landlord/${f.landlordId}`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.landlord.id).toBe(f.landlordId)
    const checklist = Object.fromEntries(
      res.body.data.checklist.map((c: any) => [c.key, c.done]))
    expect(checklist.account_created).toBe(true)
    expect(checklist.bank_account_added).toBe(false)  // no bank seeded
    expect(checklist.property_added).toBe(false)
    expect(checklist.onboarding_complete).toBe(false)  // landlords default
  })

  it('checklist updates after seeding bank + property + unit', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await seedUserBankAccount(client, { userId: f.landlordUserId })
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      await seedUnit(client, { propertyId, landlordId: f.landlordId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get(`/api/admin/onboarding/landlord/${f.landlordId}`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    const checklist = Object.fromEntries(
      res.body.data.checklist.map((c: any) => [c.key, c.done]))
    expect(checklist.bank_account_added).toBe(true)
    expect(checklist.property_added).toBe(true)
    expect(checklist.unit_added).toBe(true)
    expect(checklist.tenant_invited).toBe(false)  // no active lease
    expect(res.body.data.counts.property_count).toBe(1)
    expect(res.body.data.counts.unit_count).toBe(1)
  })
})

/**
 * S652 — every number on the admin money page comes from one book.
 *
 * Nic, reading the page: "all the KPI cards are not linked up to each other...
 * the pie charts at the bottom are showing all-time money $172.72 versus the
 * KPI card up near the top that says GAM's own money... $218.87 all time, which
 * is about a $50 difference... just reconcile all the different KPI cards where
 * they're getting their numbers from the same source."
 *
 * He reproduced it to the cent. Three books were being added together: accruals
 * plus a live run-rate for platform fees, a COUNT of background checks times a
 * constant, and a ledger that also held adjustments nothing else knew about.
 */
describe('S652: the money page agrees with itself', () => {
  let superToken = ''
  beforeEach(async () => { superToken = (await seedAFixture()).superAdminToken })

  async function ledger(rows: Array<{ type: string; amount: number; monthsAgo?: number }>) {
    for (const r of rows) {
      await db.query(
        // balance_after is the running balance the real helper maintains; these
        // fixtures only care about `amount`, so it carries the same value.
        `INSERT INTO platform_revenue_ledger (type, amount, balance_after, notes, created_at)
         VALUES ($1, $2, $2, 'test', NOW() - ($3 || ' months')::interval)`,
        [r.type, r.amount, r.monthsAgo ?? 0])
    }
  }

  it('the pie sums to exactly what the balance card calls all-time revenue', async () => {
    await ledger([
      { type: 'platform_fee_subscription', amount: 130 },
      { type: 'banking_spread',            amount: 47.72 },
      { type: 'screening_margin',          amount: 5 },
      { type: 'adjustment',                amount: -13.85 },
    ])
    const comp = await request(buildApp())
      .get('/api/admin/income/composition?window=all')
      .set('Authorization', `Bearer ${superToken}`)
    const [row] = await db.query<any>(`SELECT COALESCE(SUM(amount),0)::float AS amt FROM platform_revenue_ledger`)
      .then((r: any) => r.rows)
    expect(comp.status).toBe(200)
    expect(comp.body.data.gross).toBeCloseTo(Number(row.amt), 2)
  })

  it('shows adjustments, which used to exist in the ledger and in no pie', async () => {
    await ledger([
      { type: 'platform_fee_subscription', amount: 130 },
      { type: 'adjustment',                amount: -13.85 },
    ])
    const comp = await request(buildApp())
      .get('/api/admin/income/composition?window=all')
      .set('Authorization', `Bearer ${superToken}`)
    const adj = comp.body.data.sources.find((s: any) => s.key === 'adjustments')
    expect(adj.amount).toBeCloseTo(-13.85, 2)
    expect(comp.body.data.gross).toBeCloseTo(116.15, 2)
  })

  it('never folds a forward run-rate into a historical total', async () => {
    // The original defect: an "all time" figure that was part history and part
    // forecast, and whose forecast disagreed with the bill that went out.
    await ledger([{ type: 'platform_fee_subscription', amount: 130 }])
    const comp = await request(buildApp())
      .get('/api/admin/income/composition?window=all')
      .set('Authorization', `Bearer ${superToken}`)
    expect(comp.body.data.gross).toBeCloseTo(130, 2)
    expect(comp.body.data).toHaveProperty('runRate')   // returned, and kept apart
  })

  it('reports recurring revenue as the bill that actually went out', async () => {
    // Nic: "The recurring revenue is showing only $120 per month off of the
    // subscription fees." September billed $130.
    await ledger([
      { type: 'platform_fee_subscription', amount: 10,  monthsAgo: 1 },
      { type: 'platform_fee_subscription', amount: 130, monthsAgo: 0 },
    ])
    const all = await request(buildApp())
      .get('/api/admin/income/composition/all')
      .set('Authorization', `Bearer ${superToken}`)
    expect(all.body.data.recurringMonthly).toBeCloseTo(130, 2)
    expect(all.body.data.recurringAnnual).toBeCloseTo(1560, 2)
  })

  it('does not read an unbilled current month as a collapse in revenue', async () => {
    // On the 2nd, before the accrual runs, there is no current-month row yet.
    await ledger([{ type: 'platform_fee_subscription', amount: 130, monthsAgo: 1 }])
    const all = await request(buildApp())
      .get('/api/admin/income/composition/all')
      .set('Authorization', `Bearer ${superToken}`)
    expect(all.body.data.recurringMonthly).toBeCloseTo(130, 2)
  })

  it('a slice opens onto the rows that make it up', async () => {
    await ledger([
      { type: 'banking_spread', amount: 2.5 },
      { type: 'banking_spread', amount: 3.5 },
    ])
    const bd = await request(buildApp())
      .get('/api/admin/income/breakdown?window=all')
      .set('Authorization', `Bearer ${superToken}`)
    const proc = bd.body.data.sources.find((s: any) => s.key === 'processing')
    expect(proc.count).toBe(2)
    expect(proc.amount).toBeCloseTo(6, 2)
    expect(bd.body.data.gross).toBeCloseTo(6, 2)
  })
})
