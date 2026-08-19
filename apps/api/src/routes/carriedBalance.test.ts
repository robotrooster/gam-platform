// S605 (Nic): carrying a tenant's outstanding balance in from a prior system.
//
// The decision under test is the late-fee default. The nightly engine walks
// unpaid invoices, so a carried balance that isn't exempted starts compounding
// the day it's entered — turning a landlord's good-faith migration into a fine
// on a tenant already behind. Nic: "a tenant on a catch-up plan shouldn't be
// fined for arrears from the old system."
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import express from 'express'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'

// Each suite builds its own app — there is no shared harness in this codebase.
function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query('COMMIT')
    return {
      leaseId, landlordId, tenantId,
      token: sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

beforeEach(async () => { await cleanupAllSchema() })
afterAll(async () => { await db.end() })

describe('POST /api/leases/:id/carried-balance', () => {
  it('creates a payable invoice that is late-fee exempt BY DEFAULT', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/leases/${f.leaseId}/carried-balance`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ amount: 2000, description: 'Balance from Acme PM' })
    expect(res.status).toBe(201)

    const { rows: [inv] } = await db.query<any>(
      `SELECT total_amount, is_opening_balance, late_fee_exempt FROM invoices WHERE id = $1`,
      [res.body.data.invoiceId])
    expect(Number(inv.total_amount)).toBe(2000)
    expect(inv.is_opening_balance).toBe(true)
    expect(inv.late_fee_exempt).toBe(true)      // the whole point

    // Payable: a charge row the tenant can actually settle.
    const { rows: [pay] } = await db.query<any>(
      `SELECT type, amount, status FROM payments WHERE invoice_id = $1`, [res.body.data.invoiceId])
    expect(pay.type).toBe('carried_balance')    // not 'rent' — pre-platform money
    expect(pay.status).toBe('pending')
    expect(Number(pay.amount)).toBe(2000)
  })

  it('a landlord may opt a specific debt back INTO late fees', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/leases/${f.leaseId}/carried-balance`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ amount: 500, accruesLateFees: true })
    expect(res.status).toBe(201)
    const { rows: [inv] } = await db.query<any>(
      `SELECT late_fee_exempt FROM invoices WHERE id = $1`, [res.body.data.invoiceId])
    expect(inv.late_fee_exempt).toBe(false)
  })

  // A second entry is nearly always the same debt keyed twice, which would
  // double what the tenant owes.
  it('refuses a second carried balance on the same lease', async () => {
    const f = await seed()
    await request(buildApp()).post(`/api/leases/${f.leaseId}/carried-balance`)
      .set('Authorization', `Bearer ${f.token}`).send({ amount: 100 })
    const dup = await request(buildApp()).post(`/api/leases/${f.leaseId}/carried-balance`)
      .set('Authorization', `Bearer ${f.token}`).send({ amount: 100 })
    expect(dup.status).toBe(409)
  })

  it('another landlord cannot add a balance to this lease', async () => {
    const f = await seed()
    const other = await seed()
    const res = await request(buildApp()).post(`/api/leases/${f.leaseId}/carried-balance`)
      .set('Authorization', `Bearer ${other.token}`).send({ amount: 100 })
    expect(res.status).toBe(403)
  })

  it('reads back the balance and its fee decision', async () => {
    const f = await seed()
    await request(buildApp()).post(`/api/leases/${f.leaseId}/carried-balance`)
      .set('Authorization', `Bearer ${f.token}`).send({ amount: 750 })
    const res = await request(buildApp()).get(`/api/leases/${f.leaseId}/carried-balance`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.total_amount)).toBe(750)
    expect(res.body.data.late_fee_exempt).toBe(true)
  })

  it('returns null when the lease has no carried balance', async () => {
    const f = await seed()
    const res = await request(buildApp()).get(`/api/leases/${f.leaseId}/carried-balance`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.body.data).toBeNull()
  })
})
