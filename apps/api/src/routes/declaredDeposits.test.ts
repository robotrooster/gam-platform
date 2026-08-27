/**
 * S624 — the "I paid at the bank" routes.
 *
 * What matters here is that a declaration is a CLAIM and behaves like one: it
 * changes no balance, it cannot be made about somebody else's lease, and it
 * cannot be withdrawn once it has become a settled payment.
 */
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { DateTime } from 'luxon'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { declaredDepositsRouter } from './declaredDeposits'
import { errorHandler } from '../middleware/errorHandler'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/declared-deposits', declaredDepositsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_declared'
})

const sign = (claims: any) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Fx {
  tenantId: string; tenantUserId: string; leaseId: string; landlordId: string
  landlordUserId: string; unitId: string; token: string; landlordToken: string
}

async function fixture(): Promise<Fx> {
  const client = await getClient()
  try {
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 250 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 250 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const tu = (await client.query(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0]
    return {
      tenantId, tenantUserId: tu.user_id, leaseId, landlordId, landlordUserId, unitId,
      token: sign({ id: tu.user_id, userId: tu.user_id, role: 'tenant', profileId: tenantId }),
      landlordToken: sign({ id: landlordUserId, userId: landlordUserId,
                            role: 'landlord', profileId: landlordId }),
    }
  } finally { client.release() }
}

// S624: these used UTC, so after 5pm Phoenix they produced TOMORROW's date and
// the suite started failing every evening. Use the property's own zone, which is
// what the route compares against.
const phx = (offsetDays = 0) =>
  DateTime.now().setZone('America/Phoenix').plus({ days: offsetDays }).toISODate()!
const today = () => phx()
const daysAgo = (n: number) => phx(-n)

describe('a tenant reporting a deposit', () => {
  it('records the claim and says the balance has not moved', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    expect(res.status).toBe(200)
    // The single most important sentence on the screen: this did not pay anything.
    expect(res.body.data.message).toMatch(/balance stays the same/i)
    expect(res.body.data.trusted).toBe(true)

    const row = (await db.query(
      `SELECT status, amount::float AS amount, method FROM tenant_declared_deposits
        WHERE tenant_id=$1`, [f.tenantId])).rows[0]
    expect(row.status).toBe('pending')
    expect(row.amount).toBe(250)
  })

  // The anti-fraud property, asserted directly: a claim credits NOTHING.
  it('creates no payment, no credit, and no change to what is owed', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type,
                             amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',250,'pending',CURRENT_DATE,'RENT')`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])

    await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })

    const rent = (await db.query(
      `SELECT status, amount::float AS amount FROM payments WHERE lease_id=$1`,
      [f.leaseId])).rows[0]
    expect(rent.status).toBe('pending')
    expect(rent.amount).toBe(250)
    const credits = await db.query(`SELECT 1 FROM tenant_credits`)
    expect(credits.rowCount).toBe(0)
  })

  it('refuses a date in the future, in words', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250,
              // Two days out — one day of slack is allowed on purpose, for a
              // tenant east of the property who is already on tomorrow's date.
              declaredDate: phx(2),
              method: 'cash' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/after you have made it/i)
  })

  it('refuses something too old to chase and points at the landlord', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: daysAgo(60), method: 'cash' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/contact your landlord/i)
  })

  it('treats a double-tap as the same report, not a second deposit', async () => {
    const f = await fixture()
    const body = { leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' }
    const a = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`).send(body)
    const b = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`).send(body)
    expect(b.body.data.id).toBe(a.body.data.id)
    expect(b.body.data.alreadyReported).toBe(true)
    const n = await db.query(`SELECT COUNT(*)::int AS n FROM tenant_declared_deposits`)
    expect(n.rows[0].n).toBe(1)
  })

  it('cannot report against somebody else’s lease', async () => {
    const mine = await fixture()
    const theirs = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ leaseId: theirs.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    expect(res.status).toBe(404)
  })

  it('a landlord cannot report on a tenant’s behalf', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    expect(res.status).toBe(403)
  })
})

describe('withdrawing a report', () => {
  it('lets the tenant take back a claim they have not proved', async () => {
    const f = await fixture()
    const made = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    const res = await request(buildApp())
      .delete(`/api/declared-deposits/${made.body.data.id}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const row = (await db.query(
      `SELECT status FROM tenant_declared_deposits WHERE id=$1`,
      [made.body.data.id])).rows[0]
    // Withdrawn, not deleted — GAM keeps everything.
    expect(row.status).toBe('withdrawn')
  })

  it('cannot take back one that has already settled a payment', async () => {
    const f = await fixture()
    const made = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    await db.query(
      `UPDATE tenant_declared_deposits SET status='unconfirmed' WHERE id=$1`,
      [made.body.data.id])
    const res = await request(buildApp())
      .delete(`/api/declared-deposits/${made.body.data.id}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(409)
  })

  it('cannot withdraw someone else’s', async () => {
    const mine = await fixture()
    const theirs = await fixture()
    const made = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${theirs.token}`)
      .send({ leaseId: theirs.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    const res = await request(buildApp())
      .delete(`/api/declared-deposits/${made.body.data.id}`)
      .set('Authorization', `Bearer ${mine.token}`)
    expect(res.status).toBe(409)
  })
})

describe('the landlord’s view', () => {
  it('shows open reports for their own tenants only', async () => {
    const a = await fixture()
    const b = await fixture()
    await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ leaseId: a.leaseId, amount: 250, declaredDate: today(), method: 'check' })
    await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ leaseId: b.leaseId, amount: 250, declaredDate: today(), method: 'cash' })

    const res = await request(buildApp()).get('/api/declared-deposits/landlord/open')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].method).toBe('check')
    expect(res.body.data[0].prior_unconfirmed).toBe(0)
  })
})
