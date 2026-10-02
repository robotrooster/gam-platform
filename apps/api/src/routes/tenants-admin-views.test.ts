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
    for (const k of ['stripe_customer_id', 'bank_last4', 'bank_routing_last4', 'date_of_birth',
      'mailing_address', 'flexpay_disqualified_reason', 'background_check_status', 'flexpay_enrolled']) {
      expect(t[k]).toBeUndefined()
    }
  })

  // S655 (Nic, 10/2): "That's our check for the flex products." The SSI/SSDI
  // flag is GAM's FlexPay/FlexDeposit eligibility check — never the landlord's.
  it('never sends the SSI/SSDI flag to a landlord or staff viewer; the resident and GAM admin still see it', async () => {
    const m = await seedMovedResident()
    await db.query(`UPDATE tenants SET ssi_ssdi = TRUE WHERE id = $1`, [m.a.tenantId])
    const sign = (payload: object) => jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const { rows: [staff] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Pat', 'Manager', TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])
    await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [staff.id, m.bLandlordId])
    const staffToken = sign({ userId: staff.id, role: 'property_manager', email: 'pm@test.dev',
      profileId: null, landlordId: m.bLandlordId, permissions: { 'payments.view_all': true, 'books.view': true } })
    for (const token of [m.bToken, m.a.landlordToken, staffToken]) {
      const res = await request(buildApp())
        .get(`/api/tenants/${m.a.tenantId}/profile`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect('ssi_ssdi' in res.body.data.tenant).toBe(false)
      expect(JSON.stringify(res.body)).not.toMatch(/ssi_ssdi|ssiSsdi/)
    }
    for (const token of [m.a.tenantToken, m.a.adminToken]) {
      const res = await request(buildApp())
        .get(`/api/tenants/${m.a.tenantId}/profile`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data.tenant.ssi_ssdi).toBe(true)
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
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [staff.id, f.landlordId])
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

  // S655: the paid-ahead figure is money too. It goes to whoever may see
  // payments, and to the front desk that posts them (so a check is not posted
  // twice) — to nobody else.
  it('the paid-ahead figure goes only to staff who may see payments or who post them', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, 125, 125)`, [f.leaseId, f.tenantId])
    const { rows: [staff] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'On', 'Site', TRUE) RETURNING id`, [`os-${randomUUID()}@test.dev`])
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [staff.id, f.landlordId])
    const sign = (permissions: Record<string, boolean>) => jwt.sign(
      { userId: staff.id, role: 'onsite_manager', email: 'os@test.dev',
        profileId: null, landlordId: f.landlordId, permissions },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const paidAheadFor = async (token: string) => {
      const res = await request(buildApp())
        .get(`/api/tenants/${f.tenantId}/profile`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      return res.body.data.paidAhead
    }

    expect(await paidAheadFor(sign({}))).toBeNull()
    expect(await paidAheadFor(sign({ 'maintenance.view': true }))).toBeNull()
    expect(await paidAheadFor(sign({ take_payment: true }))).toBe(125)
    expect(await paidAheadFor(sign({ 'payments.view_all': true }))).toBe(125)
    expect(await paidAheadFor(sign({ 'books.view': true }))).toBe(125)
    expect(await paidAheadFor(f.landlordToken)).toBe(125)
    expect(await paidAheadFor(f.adminToken)).toBe(125)

    // The front desk gets the figure, not the history.
    const desk = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${sign({ take_payment: true })}`)
    expect(desk.body.data.paymentsHidden).toBe(true)
    expect(desk.body.data.payments).toEqual([])
    expect(desk.body.data.stats.totalPaid).toBeNull()
  })

  // S655: a staff member assigned to one park sees the person's time at that
  // park — not at the company's other parks.
  it('a staff member assigned to one property sees only that property\'s history; all-properties staff see both', async () => {
    const f = await seedPortfolio()   // park 1: the current lease
    const c = await db.connect()
    let p2 = '', u2 = '', l2 = ''
    try {
      await c.query('BEGIN')
      p2 = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
      u2 = await seedUnit(c, { propertyId: p2, landlordId: f.landlordId })
      l2 = await seedLease(c, { unitId: u2, landlordId: f.landlordId, status: 'terminated', startDate: '2025-01-01' })
      await seedLeaseTenant(c, { leaseId: l2, tenantId: f.tenantId, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await payment(f.unitId, f.tenantId, f.landlordId, 800, 1)
    await payment(u2, f.tenantId, f.landlordId, 650, 14)
    await db.query(
      `INSERT INTO maintenance_requests (tenant_id, unit_id, landlord_id, title, description, priority, status)
       VALUES ($1, $2, $3, 'Park 1 gate', 'x', 'normal', 'open'), ($1, $4, $3, 'Park 2 roof', 'y', 'normal', 'completed')`,
      [f.tenantId, f.unitId, f.landlordId, u2])
    await db.query(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date) VALUES ($1, $2, $3, '2025-01-01')`,
      [u2, f.tenantId, f.landlordId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $3, 50, 50), ($2, $3, 20, 20)`, [f.leaseId, l2, f.tenantId])

    const { rows: [staff] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Park', 'One', TRUE) RETURNING id`, [`os1-${randomUUID()}@test.dev`])
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3::uuid[], FALSE)`, [staff.id, f.landlordId, [f.propertyId]])
    const token = jwt.sign({ userId: staff.id, role: 'onsite_manager', email: 'os1@test.dev', profileId: null,
      landlordId: f.landlordId, permissions: { 'payments.view_all': true } }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const view = async () => {
      const res = await request(buildApp())
        .get(`/api/tenants/${f.tenantId}/profile`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      return res.body.data
    }

    const d = await view()
    expect(d.units.map((u: any) => u.id)).toEqual([f.unitId])
    expect(d.payments.map((p: any) => Number(p.amount))).toEqual([800])
    expect(d.maintenance.map((m: any) => m.title)).toEqual(['Park 1 gate'])
    expect(d.workTrade).toEqual([])
    expect(d.paidAhead).toBe(50)
    expect(d.stats.totalPaid).toBeCloseTo(800, 2)
    expect(d.stats.unitsOccupied).toBe(1)

    // Moved to park 2 only: park 2's history, none of park 1's.
    await db.query(`UPDATE onsite_manager_scopes SET property_ids = $2::uuid[] WHERE user_id = $1`, [staff.id, [p2]])
    const d2 = await view()
    expect(d2.units.map((u: any) => u.id)).toEqual([u2])
    expect(d2.payments.map((p: any) => Number(p.amount))).toEqual([650])
    expect(d2.maintenance.map((m: any) => m.title)).toEqual(['Park 2 roof'])
    expect(d2.workTrade).toHaveLength(1)
    expect(d2.paidAhead).toBe(20)

    // All properties: the company's whole history with this person.
    await db.query(`UPDATE onsite_manager_scopes SET all_properties = TRUE WHERE user_id = $1`, [staff.id])
    const all = await view()
    expect(all.units).toHaveLength(2)
    expect(all.payments).toHaveLength(2)
    expect(all.maintenance).toHaveLength(2)
    expect(all.paidAhead).toBe(70)

    // The owner is never property-limited.
    const owner = await request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(owner.body.data.units).toHaveLength(2)
  })

  // S655: limiting the history lists was not enough — the contact card (name,
  // email, phone) still came back for someone who never lived at the staff
  // member's park. Same company, so nothing crossed companies, but staff are
  // scoped on the server.
  it('a staff member assigned to one property cannot open a resident who never had a lease or invitation there', async () => {
    const f = await seedPortfolio()   // the resident's only lease is at park 1
    const c = await db.connect()
    let p2 = '', u2 = ''
    try {
      p2 = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
      u2 = await seedUnit(c, { propertyId: p2, landlordId: f.landlordId })
    } finally { c.release() }
    const { rows: [staff] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Park', 'Two', TRUE) RETURNING id`, [`os2-${randomUUID()}@test.dev`])
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3::uuid[], FALSE)`, [staff.id, f.landlordId, [p2]])
    const token = jwt.sign({ userId: staff.id, role: 'onsite_manager', email: 'os2@test.dev', profileId: null,
      landlordId: f.landlordId, permissions: { 'payments.view_all': true } }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const open = () => request(buildApp())
      .get(`/api/tenants/${f.tenantId}/profile`)
      .set('Authorization', `Bearer ${token}`)

    const refused = await open()
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/never had a lease at the properties you're assigned to/)
    expect(JSON.stringify(refused.body)).not.toContain('@')   // no contact details ride along

    // An open invitation to a site at park 2 lets them open the person.
    const { rows: [intent] } = await db.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id)
       VALUES ($1, $2, $3, $4) RETURNING id`, [f.landlordId, f.tenantId, u2, p2])
    const invited = await open()
    expect(invited.status).toBe(200)
    expect(invited.body.data.tenant.id).toBe(f.tenantId)
    expect(invited.body.data.units).toEqual([])        // still none of park 1's history
    expect(invited.body.data.payments).toEqual([])

    // A withdrawn invitation does not.
    await db.query(`UPDATE pending_tenant_intents SET cancelled_at = NOW() WHERE id = $1`, [intent.id])
    expect((await open()).status).toBe(403)

    // Assigned to park 1 (where the lease is), or to every property: they can.
    await db.query(`UPDATE onsite_manager_scopes SET property_ids = $2::uuid[] WHERE user_id = $1`, [staff.id, [f.propertyId]])
    expect((await open()).status).toBe(200)
    await db.query(`UPDATE onsite_manager_scopes SET property_ids = $2::uuid[], all_properties = TRUE WHERE user_id = $1`, [staff.id, [p2]])
    expect((await open()).status).toBe(200)

    // A staff login with no properties at all opens nobody.
    await db.query(`UPDATE onsite_manager_scopes SET property_ids = '{}'::uuid[], all_properties = FALSE WHERE user_id = $1`, [staff.id])
    expect((await open()).status).toBe(403)
  })
})
