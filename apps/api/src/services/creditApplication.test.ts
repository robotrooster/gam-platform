/**
 * S607 — a credit lands on the OPEN balance immediately.
 *
 * Nic: "The credit needs to go to the balance and kind of zero it out so that
 * the landlord's not thinking that the tenant still owes money, the books look
 * good, everything's zeroed out."
 *
 * Before this, credits were only consumed when the NEXT invoice was generated —
 * so forgiving a late fee left it showing as owed for the rest of the month, and
 * because rent is pay-in-full, the forgiven charge also blocked the tenant from
 * paying anything at all.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { tenantCreditsRouter } from '../routes/tenantCredits'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenant-credits', tenantCreditsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_credits'
})

async function seedLeaseWithCharges(charges: number[]) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    let day = 1
    for (const amt of charges) {
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'late_fee',$5,'pending', DATE '2026-09-01' + ($6::int), 'LATEFEE')`,
        [unitId, leaseId, tenantId, landlordId, amt, day++])
    }
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { leaseId, tenantId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const openBalance = async (leaseId: string) => Number((await db.query<{ t: string }>(
  `SELECT COALESCE(SUM(amount),0)::text AS t FROM payments
    WHERE lease_id = $1 AND status = 'pending'`, [leaseId])).rows[0].t)

// ─── S638 (Nic, DIRECTIVE) — REWRITTEN. A CREDIT SETTLES NOTHING. ───────────
//
//   "The credit doesn't settle individual items. It takes just the total down.
//    It's not separatable. It's her rent, her trash, her water are line items
//    that combine to one bill. That one total charge has the credit applied
//    against it... The credit has to be applied and visible before they pay."
//
// Every test below used to assert the opposite: that posting a credit closed
// open charges one at a time, oldest first. That is what happened to Kim
// Harland — a $450 Move In Special was issued and instantly spent settling a
// $10.45 water row, a $25 trash row and five $5 late fees. Her credit read
// $389.55, her landlord saw settled charges no money had arrived for, and she
// was still shown the full rent.
//
// S637 had already banned SPLITTING a charge. This goes further: a credit does
// not touch a charge at all. It sits whole on the account and nets against the
// one total wherever a balance is shown or paid.
describe('S638 posting a credit changes no charge', () => {
  it('leaves every open charge exactly as it was', async () => {
    const f = await seedLeaseWithCharges([25, 5, 5])
    expect(await openBalance(f.leaseId)).toBeCloseTo(35, 2)

    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 35, category: 'late_fee_refund', reason: 'waived' })
    expect(res.status).toBe(201)

    // The charges stand. Nothing was settled, nothing was split, nothing was
    // invented — the ledger still says what the resident was billed.
    expect(await openBalance(f.leaseId)).toBeCloseTo(35, 2)
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments
        WHERE lease_id = $1 AND status = 'settled'`, [f.leaseId])
    expect(Number(rows[0].n)).toBe(0)
  })

  it('keeps the credit whole, at its full face value', async () => {
    const f = await seedLeaseWithCharges([25, 5, 5])
    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 35, category: 'goodwill' })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.amountRemaining ?? res.body.data.amount_remaining))
      .toBeCloseTo(35, 2)
  })

  // A credit bigger than the bill is not change — the rest stays on account.
  it('a credit larger than the balance stays whole too', async () => {
    const f = await seedLeaseWithCharges([50])
    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 500, category: 'goodwill' })
    expect(res.status).toBe(201)
    expect(await openBalance(f.leaseId)).toBeCloseTo(50, 2)
    expect(Number(res.body.data.amountRemaining ?? res.body.data.amount_remaining))
      .toBeCloseTo(500, 2)
  })

  it('posts fine against a lease with nothing open', async () => {
    const f = await seedLeaseWithCharges([])
    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 100, category: 'goodwill' })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.amountRemaining ?? res.body.data.amount_remaining))
      .toBeCloseTo(100, 2)
  })
})
