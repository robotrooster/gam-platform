/**
 * S616 — autopay and the grace period.
 *
 * Nic: "if people get their Social Security on the third or the fifth or
 * whatever the case may be, if they set autopay and it's still within the grace
 * period, they should be able to choose to have auto payment set up."
 *
 * They always could — pull_day has existed since S609. What was wrong was what
 * the screen TOLD them: every day after the due day was called late, so a
 * tenant paid on the 3rd with a five-day grace was warned about fees they would
 * never be charged. The row now carries the grace so the screen can tell the
 * difference between "late" and "later than the 1st".
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
import { tenantAutopayRouter } from './tenantAutopay'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'
import { lateFeeStartDate } from '@gam/shared'

function buildApp() {
  const app = express()
  app.use(express.json())
  // The real app camelizes on the way out; without it these assertions would
  // describe a contract the portal never receives.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/autopay', tenantAutopayRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_autopay'
})

async function seed(opts: { graceDays?: number | null; dueDay?: number } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(
      `UPDATE leases SET rent_due_day = $2, late_fee_grace_days = $3,
                         late_fee_enabled = true
        WHERE id = $1`,
      [leaseId, opts.dueDay ?? 1, opts.graceDays ?? 5])
    await c.query('COMMIT')
    return {
      tenantId, leaseId,
      token: jwt.sign({ userId, role: 'tenant', profileId: tenantId },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('GET /api/autopay carries the grace period (S616)', () => {
  it('returns the lease grace days so the screen can tell late from merely later', async () => {
    const f = await seed({ graceDays: 5, dueDay: 1 })
    const res = await request(buildApp())
      .get('/api/autopay')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].rentDueDay).toBe(1)
    expect(res.body.data[0].lateFeeGraceDays).toBe(5)
    expect(res.body.data[0].lateFeeEnabled).toBe(true)
  })

  // The engine's own fallback is 5. If these two ever disagree the screen
  // promises a free day the charge then penalises.
  it('falls back to 5 exactly as the late-fee engine does', async () => {
    const f = await seed({ graceDays: null })
    const res = await request(buildApp())
      .get('/api/autopay')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.body.data[0].lateFeeGraceDays).toBe(5)
  })

  // The portal computes lastFreeDay = dueDay + grace - 1. This pins that
  // arithmetic to the shared engine rather than to a comment.
  it('the last free day matches where the engine actually starts charging', () => {
    const dueDay = 1
    const graceDays = 5
    // Engine: a fee applies when today >= dueDate + grace.
    const firstLateDate = lateFeeStartDate('2026-03-01', graceDays)
    expect(firstLateDate).toBe('2026-03-06')
    // So the last free day is the 5th — which is what the card offers as safe.
    const lastFreeDay = dueDay + graceDays - 1
    expect(lastFreeDay).toBe(5)
    expect(`2026-03-0${lastFreeDay + 1}`).toBe(firstLateDate)
  })

  it('a Social Security payer can set the 3rd and be told it costs nothing', async () => {
    const f = await seed({ graceDays: 5, dueDay: 1 })
    const app = buildApp()
    const put = await request(app)
      .put('/api/autopay')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, enabled: false, pullDay: 3 })
    expect(put.status).toBe(200)

    const res = await request(app)
      .get('/api/autopay')
      .set('Authorization', `Bearer ${f.token}`)
    const row = res.body.data[0]
    expect(row.pullDay).toBe(3)
    // The card's rule: inside dueDay..lastFreeDay is free.
    const lastFreeDay = row.rentDueDay + row.lateFeeGraceDays - 1
    expect(row.pullDay).toBeLessThanOrEqual(lastFreeDay)
  })
})
