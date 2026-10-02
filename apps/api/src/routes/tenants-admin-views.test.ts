/**
 * tenants.ts admin-views slice — S379 (tenants.ts slice 6 of N).
 *
 * Covered routes (3):
 *   - GET  /api/tenants/:id/profile — lifetime tenant profile
 *     (large aggregation: tenant + units + payments + maintenance
 *     + workTrade + stats). Authz: tenant viewing self, admin,
 *     or related landlord/team via lease_tenants.
 *   - POST /api/tenants/:id/transfer — retired 501 with requirePerm
 *     ('tenants.archive') gate
 *   - GET  /api/tenants/:id/available-units — vacant units owned by
 *     the calling landlord, with requirePerm('tenants.archive')
 *
 * Slices 1–5 covered 29 of 40 tenants.ts routes (~73%).
 * After this slice: 32 of 40 (~80%).
 *
 * Out of slice (next sessions): profile patch + avatar POST/GET +
 *   password, work-trade, charge-account.
 *
 * Production bug fixed in this slice:
 *   - /:id/profile stats.lateCount was filtering for payments.status
 *     = 'late', which doesn't exist in the payments_status_check
 *     enum — the FILTER always returned 0. Source now reads from
 *     tenants.late_payment_count (maintained by scheduler.ts).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_admin_views'
})

interface PortfolioFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  unitId:         string
  tenantId:       string
  tenantUserId:   string
  leaseId:        string
  landlordToken:  string
  tenantToken:    string
  adminToken:     string
}

async function seedPortfolio(opts: { skipLeaseTenant?: boolean } = {}): Promise<PortfolioFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, { unitId, landlordId, status: 'active' })
    if (!opts.skipLeaseTenant) {
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    }
    // Admin user (no profile binding — admin role is global).
    const adminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'Admin', 'User', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await client.query('COMMIT')

    const sign = (payload: object) => jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordUserId, landlordId, propertyId, unitId,
      tenantId, tenantUserId: tu.rows[0].user_id, leaseId,
      landlordToken: sign({ userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
                            profileId: landlordId, permissions: {} }),
      tenantToken:   sign({ userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev',
                            profileId: tenantId, permissions: {} }),
      adminToken:    sign({ userId: adminRes.rows[0].id, role: 'admin', email: 'admin@test.dev',
                            profileId: null, permissions: {} }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /:id/profile — lifetime tenant profile', () => {
  it('unknown tenant id → 404', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${randomUUID()}/profile`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/tenant not found/i)
  })

  it('unrelated landlord (no lease_tenants chain) → 403', async () => {
    const f = await seedPortfolio()
    const other = await seedPortfolio()  // separate landlord/tenant
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${other.landlordToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/forbidden/i)
  })

  it('tenant viewing themselves → 200', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.tenant.id).toBe(f.tenantId)
  })

  it('admin viewing any tenant → 200', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.tenant.id).toBe(f.tenantId)
  })

  it('landlord with a lease_tenants relationship → 200', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    // Units aggregation surfaces the current unit + is_current=true
    expect(res.body.data.units).toHaveLength(1)
    expect(res.body.data.units[0].id).toBe(f.unitId)
    expect(res.body.data.units[0].is_current).toBe(true)
  })

  it('happy aggregation: payments + maintenance + stats populated', async () => {
    const f = await seedPortfolio()
    // Seed 2 settled payments + 1 failed payment + 1 maintenance request.
    // S414: spread settled payments across distinct due_dates so they
    // don't collide on ux_payments_unit_type_due_date_active.
    let monthOffset = 0
    for (const amount of [1000, 1100]) {
      await db.query(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date)
         VALUES ($1, $2, $3, 'rent', $4, 'settled', 'RENT',
                 CURRENT_DATE - ($5 || ' months')::interval)`,
        [f.unitId, f.tenantId, f.landlordId, amount, monthOffset++])
    }
    await db.query(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date)
       VALUES ($1, $2, $3, 'rent', 1200, 'failed', 'RENT', CURRENT_DATE)`,
      [f.unitId, f.tenantId, f.landlordId])
    await db.query(
      `INSERT INTO maintenance_requests
         (tenant_id, unit_id, landlord_id, title, description, priority, status)
       VALUES ($1, $2, $3, 'leak', 'leak under sink', 'normal', 'open')`,
      [f.tenantId, f.unitId, f.landlordId])

    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.payments).toHaveLength(3)
    expect(res.body.data.maintenance).toHaveLength(1)
    expect(res.body.data.stats.totalPayments).toBe(3)
    expect(res.body.data.stats.settledCount).toBe(2)
    expect(res.body.data.stats.failedCount).toBe(1)
    expect(res.body.data.stats.totalPaid).toBeCloseTo(2100, 2)
    expect(res.body.data.stats.avgPayment).toBeCloseTo(1050, 2)
    expect(res.body.data.stats.onTimeRate).toBe(67)  // 2/3 = 0.666… → 67
    expect(res.body.data.stats.maintenanceCount).toBe(1)
    expect(res.body.data.stats.unitsOccupied).toBe(1)
  })

  // S652 (Nic): lateCount is the number of charges the credit ledger recorded
  // as paid past grace — once per charge. The old tenants.late_payment_count
  // was bumped every morning a balance stayed open (thirty days late read as
  // thirty late payments) and is ignored now.
  it('lateCount counts ledger late-payment events, once per charge, and ignores the old daily counter', async () => {
    const f = await seedPortfolio()
    await db.query(`UPDATE tenants SET late_payment_count=30 WHERE id=$1`, [f.tenantId])
    const { emitPaymentSettledEvent } = await import('../services/creditLedgerEmitters')
    const c = await db.connect()
    try {
      const day = 86_400_000
      const due = new Date('2026-06-01T00:00:00Z')
      // on time, within grace, 2 days past grace, 10 days past grace, 40 days past grace
      for (const lateDays of [0, 3, 7, 15, 45]) {
        await emitPaymentSettledEvent(c, {
          tenantId: f.tenantId, paymentId: randomUUID(), paymentType: 'rent', amount: '500',
          dueDate: due, settledAt: new Date(due.getTime() + lateDays * day), graceDays: 5, stripePaymentIntentId: null,
        })
      }
    } finally { c.release() }

    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.stats.lateCount).toBe(3)
  })
})

describe('POST /:id/transfer — retired 501', () => {
  it('non-permitted role → 403 from requirePerm gate', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post(`/api/tenants/${f.tenantId}/transfer`)
      .set('Authorization', `Bearer ${f.tenantToken}`)  // tenant lacks tenants.archive
      .send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/insufficient permissions/i)
  })

  it('permitted role → 501 with retired-endpoint message', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post(`/api/tenants/${f.tenantId}/transfer`)
      .set('Authorization', `Bearer ${f.landlordToken}`)  // landlord = OWNER_ROLES auto-pass
      .send({ newUnitId: randomUUID() })
    expect(res.status).toBe(501)
    expect(res.body.error).toMatch(/retired/i)
    expect(res.body.error).toMatch(/e-sign/i)
  })
})

describe('GET /:id/available-units', () => {
  it('non-permitted role → 403', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/available-units`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(403)
  })

  it('landlord with no vacant units → 200 empty', async () => {
    const f = await seedPortfolio()
    // Default fixture has 1 unit with an active lease → not vacant.
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/available-units`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('landlord with mixed units → returns only vacant + no pending/active lease', async () => {
    const f = await seedPortfolio()
    // Seed a second + third unit. Second is vacant with no lease — should
    // appear. Third is vacant but has a 'pending' lease — should NOT appear
    // (NOT EXISTS guard).
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const vacantUnitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      await client.query(`UPDATE units SET status='vacant' WHERE id=$1`, [vacantUnitId])
      const pendingUnitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      await client.query(`UPDATE units SET status='vacant' WHERE id=$1`, [pendingUnitId])
      await seedLease(client, { unitId: pendingUnitId, landlordId: f.landlordId, status: 'pending' })
      await client.query('COMMIT')

      const res = await request(buildApp())
        .get(`/api/tenants/${f.tenantId}/available-units`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].id).toBe(vacantUnitId)
    } finally { client.release() }
  })

  it('admin caller with null profileId → 200 empty (units filtered by landlord_id = profileId)', async () => {
    const f = await seedPortfolio()
    // Admin's profileId is null in our JWT seed — the SQL filter
    // u.landlord_id = $1 matches nothing.
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/available-units`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

// A resident who lived at company A and now rents from company B. B's Tenant
// page used to show A's units, rent history, maintenance (with A's internal
// notes and costs), work trade and late marks, plus the person's bank digits,
// date of birth and Stripe id off the whole tenants row.
describe('GET /:id/profile — a landlord sees only its own company', () => {
  async function seedMovedResident() {
    const a = await seedPortfolio()   // company A: the resident's old landlord
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE leases SET status='terminated' WHERE id=$1`, [a.leaseId])
      await c.query(
        `UPDATE tenants SET stripe_customer_id='cus_secret', bank_last4='6789',
                bank_routing_last4='4321', date_of_birth='1980-02-03',
                mailing_address='1 Private Way', flexpay_disqualified_reason='returned payment'
          WHERE id=$1`, [a.tenantId])
      const { userId: bUserId, landlordId: bLandlordId } = await seedLandlord(c)
      const bPropertyId = await seedProperty(c, {
        landlordId: bLandlordId, ownerUserId: bUserId, managedByUserId: bUserId,
      })
      const bUnitId = await seedUnit(c, { propertyId: bPropertyId, landlordId: bLandlordId })
      const bLeaseId = await seedLease(c, { unitId: bUnitId, landlordId: bLandlordId, status: 'active', startDate: '2026-06-01' })
      await seedLeaseTenant(c, { leaseId: bLeaseId, tenantId: a.tenantId, role: 'primary' })
      await c.query('COMMIT')
      const sign = (payload: object) => jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' })
      return {
        a, bUserId, bLandlordId, bUnitId, bLeaseId,
        bToken: sign({ userId: bUserId, role: 'landlord', email: 'b@test.dev', profileId: null, permissions: {} }),
      }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  async function payment(unitId: string, tenantId: string, landlordId: string, amount: number, monthsAgo: number, status = 'settled') {
    const { rows: [r] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, notes)
       VALUES ($1, $2, $3, 'rent', $4, $5, 'RENT', CURRENT_DATE - ($6 || ' months')::interval, 'private note')
       RETURNING id`,
      [unitId, tenantId, landlordId, amount, status, monthsAgo])
    return r.id
  }

  it('shows company B nothing from company A', async () => {
    const m = await seedMovedResident()
    const aPay = await payment(m.a.unitId, m.a.tenantId, m.a.landlordId, 700, 6)
    await payment(m.bUnitId, m.a.tenantId, m.bLandlordId, 900, 1)
    await db.query(
      `INSERT INTO maintenance_requests (tenant_id, unit_id, landlord_id, title, description, priority, status, landlord_notes, actual_cost)
       VALUES ($1, $2, $3, 'A leak', 'at A', 'normal', 'completed', 'A internal note', 450)`,
      [m.a.tenantId, m.a.unitId, m.a.landlordId])
    await db.query(
      `INSERT INTO maintenance_requests (tenant_id, unit_id, landlord_id, title, description, priority, status)
       VALUES ($1, $2, $3, 'B door', 'at B', 'normal', 'open')`,
      [m.a.tenantId, m.bUnitId, m.bLandlordId])
    await db.query(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, duties)
       VALUES ($1, $2, $3, '2025-01-01', 'A grounds work')`,
      [m.a.unitId, m.a.tenantId, m.a.landlordId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, 300, 300)`, [m.a.leaseId, m.a.tenantId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, 40, 40)`, [m.bLeaseId, m.a.tenantId])
    // A late mark recorded on company A's charge.
    const { emitPaymentSettledEvent } = await import('../services/creditLedgerEmitters')
    const c = await db.connect()
    try {
      const due = new Date('2026-03-01T00:00:00Z')
      await emitPaymentSettledEvent(c, {
        tenantId: m.a.tenantId, paymentId: aPay, paymentType: 'rent', amount: '700',
        dueDate: due, settledAt: new Date(due.getTime() + 20 * 86_400_000), graceDays: 5, stripePaymentIntentId: null,
      })
    } finally { c.release() }

    const res = await request(buildApp())
      .get(`/api/tenants/${m.a.tenantId}/profile`)
      .set('Authorization', `Bearer ${m.bToken}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.units.map((u: any) => u.id)).toEqual([m.bUnitId])
    expect(d.payments).toHaveLength(1)
    expect(Number(d.payments[0].amount)).toBe(900)
    expect(d.payments[0].notes).toBeUndefined()
    expect(d.maintenance.map((r: any) => r.title)).toEqual(['B door'])
    expect(d.maintenance[0].landlord_notes).toBeUndefined()
    expect(d.workTrade).toEqual([])
    expect(d.stats.totalPayments).toBe(1)
    expect(d.stats.totalPaid).toBeCloseTo(900, 2)
    expect(d.stats.lateCount).toBe(0)
    expect(d.stats.unitsOccupied).toBe(1)
    expect(d.paidAhead).toBe(40)

    // Company A still sees its own history, including the late mark.
    const resA = await request(buildApp())
      .get(`/api/tenants/${m.a.tenantId}/profile`)
      .set('Authorization', `Bearer ${m.a.landlordToken}`)
    expect(resA.status).toBe(200)
    expect(resA.body.data.units.map((u: any) => u.id)).toEqual([m.a.unitId])
    expect(resA.body.data.payments).toHaveLength(1)
    expect(resA.body.data.stats.lateCount).toBe(1)
    expect(resA.body.data.workTrade).toHaveLength(1)
    expect(resA.body.data.paidAhead).toBe(300)

    // GAM admin keeps the whole picture.
    const resAdmin = await request(buildApp())
      .get(`/api/tenants/${m.a.tenantId}/profile`)
      .set('Authorization', `Bearer ${m.a.adminToken}`)
    expect(resAdmin.body.data.units).toHaveLength(2)
    expect(resAdmin.body.data.payments).toHaveLength(2)
    expect(resAdmin.body.data.stats.lateCount).toBe(1)
    expect(resAdmin.body.data.paidAhead).toBe(340)
  })

  it('gives a landlord only the contact fields the page uses — no bank, Stripe, birth date or Flex fields', async () => {
    const m = await seedMovedResident()
    const res = await request(buildApp())
      .get(`/api/tenants/${m.a.tenantId}/profile`)
      .set('Authorization', `Bearer ${m.bToken}`)
    expect(res.status).toBe(200)
    const t = res.body.data.tenant
    expect(t.id).toBe(m.a.tenantId)
    expect(t.email).toBeTruthy()
    expect('ssi_ssdi' in t).toBe(true)
    for (const k of ['stripe_customer_id', 'bank_last4', 'bank_routing_last4', 'date_of_birth',
      'mailing_address', 'flexpay_disqualified_reason', 'background_check_status', 'flexpay_enrolled']) {
      expect(t[k]).toBeUndefined()
    }
  })

  it('keeps the whole record for the resident themselves and for GAM admin', async () => {
    const m = await seedMovedResident()
    for (const token of [m.a.tenantToken, m.a.adminToken]) {
      const res = await request(buildApp())
        .get(`/api/tenants/${m.a.tenantId}/profile`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data.tenant.bank_last4).toBe('6789')
      expect(res.body.data.units).toHaveLength(2)
    }
  })

  it('a staff member without the payment permissions sees no payment history, work trade or money figures (S641)', async () => {
    const f = await seedPortfolio()
    await payment(f.unitId, f.tenantId, f.landlordId, 800, 1)
    await db.query(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date)
       VALUES ($1, $2, $3, '2025-01-01')`, [f.unitId, f.tenantId, f.landlordId])
    const { rows: [staff] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'On', 'Site', TRUE) RETURNING id`, [`os-${randomUUID()}@test.dev`])
    const sign = (payload: object) => jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const plain = sign({ userId: staff.id, role: 'onsite_manager', email: 'os@test.dev',
      profileId: null, landlordId: f.landlordId, permissions: {} })
    const res = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${plain}`)
    expect(res.status).toBe(200)
    expect(res.body.data.payments).toEqual([])
    expect(res.body.data.workTrade).toEqual([])
    expect(res.body.data.paymentsHidden).toBe(true)
    expect(res.body.data.stats.totalPaid).toBeNull()
    expect(res.body.data.stats.onTimeRate).toBeNull()
    expect(res.body.data.units).toHaveLength(1)

    // With "View all payments" they do see this company's history.
    const withPerm = sign({ userId: staff.id, role: 'onsite_manager', email: 'os@test.dev',
      profileId: null, landlordId: f.landlordId, permissions: { 'payments.view_all': true } })
    const res2 = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${withPerm}`)
    expect(res2.body.data.payments).toHaveLength(1)
    expect(res2.body.data.paymentsHidden).toBe(false)
    expect(res2.body.data.stats.totalPaid).toBeCloseTo(800, 2)
  })
})
