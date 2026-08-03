/**
 * S577 — landlord-issued tenant account credits.
 * API (issue / list / void / scoping) + consumption through generateInvoices
 * (credit reduces the next rent invoice, drawn down; independent of work-trade).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { tenantCreditsRouter } from './tenantCredits'
import { generateInvoices } from '../jobs/invoiceGeneration'
import { errorHandler } from '../middleware/errorHandler'

const app = express()
app.use(express.json())
app.use('/api/tenant-credits', tenantCreditsRouter)
app.use(errorHandler)

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tc'
})

async function seed() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const A = await seedLandlord(c)
    const B = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: A.landlordId, ownerUserId: A.userId, managedByUserId: A.userId })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: A.landlordId, rentAmount: 1000 })
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: A.landlordId, rentAmount: 1000, status: 'active', startDate: '2026-04-01' })
    await c.query('UPDATE leases SET rent_due_day=1 WHERE id=$1', [leaseA])
    const tenantA = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA, role: 'primary' })
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      leaseA, tenantA, landlordAId: A.landlordId,
      tokenA: sign({ userId: A.userId, role: 'landlord', email: 'a@t.dev', profileId: A.landlordId, permissions: {} }),
      tokenB: sign({ userId: B.userId, role: 'landlord', email: 'b@t.dev', profileId: B.landlordId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const NOW = new Date('2026-05-05T12:00:00Z')

describe('tenant credits — API', () => {
  it('landlord issues a credit (201) and can list it', async () => {
    const f = await seed()
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA))
      .send({ leaseId: f.leaseA, amount: 42.94, category: 'screening_cap', reason: 'AZ cap' })
    expect(issue.status).toBe(201)
    expect(Number(issue.body.data.amount_remaining)).toBeCloseTo(42.94, 2)
    const list = await request(app).get(`/api/tenant-credits?leaseId=${f.leaseA}`).set(auth(f.tokenA))
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].category).toBe('screening_cap')
  })

  it('another landlord cannot issue on the lease (403)', async () => {
    const f = await seed()
    const res = await request(app).post('/api/tenant-credits').set(auth(f.tokenB))
      .send({ leaseId: f.leaseA, amount: 50 })
    expect(res.status).toBe(403)
  })

  it('void cancels the remaining balance', async () => {
    const f = await seed()
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 100 })
    const id = issue.body.data.id
    const v = await request(app).post(`/api/tenant-credits/${id}/void`).set(auth(f.tokenA))
    expect(v.status).toBe(200)
    const { rows } = await db.query('SELECT status, amount_remaining FROM tenant_credits WHERE id=$1', [id])
    expect(rows[0].status).toBe('void')
    expect(Number(rows[0].amount_remaining)).toBe(0)
  })
})

describe('tenant credits — consumption at invoice generation', () => {
  async function issueCredit(leaseId: string, tenantId: string, landlordId: string, amount: number) {
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,$4,$4,'goodwill')`, [landlordId, tenantId, leaseId, amount.toFixed(2)])
  }
  async function pendingOwed(leaseId: string) {
    const inv = await db.query<any>('SELECT id FROM invoices WHERE lease_id=$1', [leaseId])
    const pays = await db.query<any>(
      `SELECT COALESCE(SUM(amount),0)::float AS owed FROM payments
        WHERE invoice_id=$1 AND status='pending'`, [inv.rows[0].id])
    return Math.round(pays.rows[0].owed * 100) / 100
  }

  it('a $300 credit on $1000 rent → tenant owes $700; credit drawn to 0', async () => {
    const f = await seed()
    await issueCredit(f.leaseA, f.tenantA, f.landlordAId, 300)
    await generateInvoices(NOW)
    expect(await pendingOwed(f.leaseA)).toBe(700)
    const { rows } = await db.query('SELECT amount_remaining FROM tenant_credits WHERE lease_id=$1', [f.leaseA])
    expect(Number(rows[0].amount_remaining)).toBe(0)
  })

  it('a $1000 credit on $1000 rent → owes $0; credit drawn to 0', async () => {
    const f = await seed()
    await issueCredit(f.leaseA, f.tenantA, f.landlordAId, 1000)
    await generateInvoices(NOW)
    expect(await pendingOwed(f.leaseA)).toBe(0)
    const { rows } = await db.query('SELECT amount_remaining FROM tenant_credits WHERE lease_id=$1', [f.leaseA])
    expect(Number(rows[0].amount_remaining)).toBe(0)
  })

  it('a $1500 credit on $1000 rent → owes $0; $500 carries forward', async () => {
    const f = await seed()
    await issueCredit(f.leaseA, f.tenantA, f.landlordAId, 1500)
    await generateInvoices(NOW)
    expect(await pendingOwed(f.leaseA)).toBe(0)
    const { rows } = await db.query('SELECT amount_remaining FROM tenant_credits WHERE lease_id=$1', [f.leaseA])
    expect(Number(rows[0].amount_remaining)).toBe(500)
  })

  it('a voided credit is NOT consumed', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, status)
       VALUES ($1,$2,$3,300,300,'goodwill','void')`, [f.landlordAId, f.tenantA, f.leaseA])
    await generateInvoices(NOW)
    expect(await pendingOwed(f.leaseA)).toBe(1000)
  })
})
