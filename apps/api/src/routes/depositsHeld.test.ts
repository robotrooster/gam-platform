/**
 * S637 — "deposits held" must mean money actually in custody.
 *
 * Nic: "when I select Mountain View RV, the deposits held shows eight hundred
 * dollars, and on Oak Park, it shows a thousand and fifty dollars for deposits
 * held. We aren't holding any deposits at either property so far. So where is
 * that pulling data from?"
 *
 * It summed units.security_deposit — the amount CONFIGURED on each occupied
 * unit, which is what a deposit WOULD be if one were taken. Nothing had been
 * collected. On a tax page that is the worst place to invent a figure: a
 * deposit is a liability, and this one came from a setting.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import { reportsRouter } from './reports'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', reportsRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_deposits'
let token: string, landlordId: string, unitId: string, tenantId: string, leaseId: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    landlordId = l.landlordId
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
    unitId = await seedUnit(c, { propertyId, landlordId })
    // A unit CONFIGURED for a $500 deposit that nobody has paid.
    await c.query(`UPDATE units SET security_deposit = 500, status='active' WHERE id=$1`, [unitId])
    tenantId = await seedTenant(c)
    leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await c.query('COMMIT')
    token = jwt.sign(
      { userId: l.userId, role: 'landlord', email: 'll@t.dev', profileId: null,
        landlordIds: [landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const held = async () => {
  const res = await request(buildApp())
    .get(`/api/reports/tax-summary?year=${new Date().getFullYear()}&landlordId=${landlordId}`)
    .set('Authorization', `Bearer ${token}`)
  expect(res.status).toBe(200)
  return res.body.data.deposits.total_held ?? res.body.data.deposits.totalHeld
}

const addDeposit = (status: string, collected: number, total = 500) =>
  db.query(
    `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount,
                                    collected_amount, status, held_by)
     VALUES ($1,$2,$3,$4,$5,$6,'landlord')`,
    [unitId, leaseId, tenantId, total, collected, status])

describe('GET /reports/tax-summary — deposits held', () => {
  it('is ZERO when the unit is configured for one but nobody has paid', async () => {
    expect(await held()).toBe(0)
  })

  it('counts a funded deposit', async () => {
    await addDeposit('funded', 500)
    expect(await held()).toBe(500)
  })

  it('counts what was actually collected on a partial, not the full amount', async () => {
    await addDeposit('partial', 200, 500)
    expect(await held()).toBe(200)
  })

  it('excludes a disbursed deposit — it went back to the tenant', async () => {
    await addDeposit('disbursed', 500)
    expect(await held()).toBe(0)
  })

  it('excludes a claimed deposit — it was applied, not held', async () => {
    await addDeposit('claimed', 500)
    expect(await held()).toBe(0)
  })

  it('excludes a pending deposit — it was never collected', async () => {
    await addDeposit('pending', 0)
    expect(await held()).toBe(0)
  })
})

// S655: a deposit is held for the tenant under either switch — never inside
// the income total, always beside it.
describe('deposits stay out of income under both bases', () => {
  it('a settled deposit is beside the tax summary total, never in it', async () => {
    const y = new Date().getFullYear()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, revenue_owner)
       VALUES ($1,$2,$3,$4,'deposit',500,'settled','DEPOSIT',$5::date,($5::date + TIME '12:00') AT TIME ZONE 'America/Phoenix','held')`,
      [unitId, leaseId, tenantId, landlordId, `${y}-02-01`])
    for (const basis of ['received', 'billed']) {
      const res = await request(buildApp())
        .get(`/api/reports/tax-summary?year=${y}&landlordId=${landlordId}&basis=${basis}`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.data.income.totalRent).toBe(0)
      expect(res.body.data.beside.find((b: any) => b.key === 'depositsHeld').amount).toBe(500)
    }
  })
})
