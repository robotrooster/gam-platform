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

describe('issuing a credit clears the open balance now', () => {
  it('zeroes out accrued late fees the moment it is posted', async () => {
    // Nic's example: 4 days past grace — an initial fee plus a few daily ticks.
    const f = await seedLeaseWithCharges([25, 5, 5])
    expect(await openBalance(f.leaseId)).toBeCloseTo(35, 2)

    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 35, category: 'late_fee_refund', reason: 'waived' })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.appliedToBalance)).toBeCloseTo(35, 2)

    // The books are square immediately — not next month.
    expect(await openBalance(f.leaseId)).toBeCloseTo(0, 2)
  })

  // S637 (Nic, DIRECTIVE): "Credits do not fucking split charges. It's a credit
  // against the overall ledger, not fucking settling partial payments. We don't
  // do partial payments."
  //
  // This test used to assert the split — a $20 credit against a $50 charge left
  // TWO payment rows, a $20 settled and a $30 remainder. That is a partial
  // payment, banned platform-wide, and it also invented a settled payment no
  // money arrived for.
  it('S637: leaves a charge it cannot fully cover ALONE — no split, no remainder row', async () => {
    const f = await seedLeaseWithCharges([50])
    await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 20, category: 'goodwill' })

    // The charge is untouched: still one row, still $50, still pending.
    const rows = await db.query<{ status: string; amount: string; is_remainder: boolean }>(
      `SELECT status, amount::text, is_remainder FROM payments WHERE lease_id=$1`, [f.leaseId])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].status).toBe('pending')
    expect(Number(rows.rows[0].amount)).toBeCloseTo(50, 2)
    expect(rows.rows.some(r => r.is_remainder)).toBe(false)

    // The $20 stays on the account as a balance the landlord owes back.
    const credit = await db.query<{ remaining: string }>(
      `SELECT amount_remaining::text AS remaining FROM tenant_credits WHERE lease_id=$1`, [f.leaseId])
    expect(Number(credit.rows[0].remaining)).toBeCloseTo(20, 2)
  })

  // A credit that cannot clear the row in front of it must still clear one it
  // can reach — `continue`, not `break`.
  it('S637: skips past a charge too big for it and clears a smaller one behind', async () => {
    const f = await seedLeaseWithCharges([500, 35])
    await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 40, category: 'late_fee_refund' })

    const rows = await db.query<{ status: string; amount: string }>(
      `SELECT status, amount::text FROM payments WHERE lease_id=$1 ORDER BY amount::numeric`, [f.leaseId])
    expect(rows.rows).toHaveLength(2)                    // still two, nothing split
    expect(rows.rows[0].status).toBe('settled')          // the $35 cleared
    expect(rows.rows[1].status).toBe('pending')          // the $500 untouched
    expect(Number(rows.rows[1].amount)).toBeCloseTo(500, 2)
  })

  it('keeps the unused remainder on the credit for later', async () => {
    const f = await seedLeaseWithCharges([10])
    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 100, category: 'overcharge' })
    expect(Number(res.body.data.appliedToBalance)).toBeCloseTo(10, 2)
    expect(Number(res.body.data.amountRemaining ?? res.body.data.amount_remaining)).toBeCloseTo(90, 2)
    expect(await openBalance(f.leaseId)).toBeCloseTo(0, 2)
  })

  it('does nothing when there is no open balance, and banks the whole credit', async () => {
    const f = await seedLeaseWithCharges([])
    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 40, category: 'goodwill' })
    expect(Number(res.body.data.appliedToBalance)).toBe(0)
    expect(Number(res.body.data.amountRemaining ?? res.body.data.amount_remaining)).toBeCloseTo(40, 2)
  })

  it('pays the oldest charge first', async () => {
    const f = await seedLeaseWithCharges([25, 5])
    await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 25, category: 'late_fee_refund' })
    const still = await db.query<{ amount: string }>(
      `SELECT amount::text FROM payments WHERE lease_id=$1 AND status='pending'`, [f.leaseId])
    expect(still.rows).toHaveLength(1)
    expect(Number(still.rows[0].amount)).toBeCloseTo(5, 2)   // the $25 went first
  })
})
