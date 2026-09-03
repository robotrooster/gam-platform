/**
 * S637 — the monthly P&L needs to be told which company.
 *
 * Nic: "I can click on the line item down below that shows September's profit
 * and loss. It just says loading. It doesn't show me which people made
 * payments."
 *
 * /reports/monthly-pl refuses to answer for an account owning more than one
 * company — a P&L is a per-entity artifact and blending two would be wrong
 * (reportEntity, S633). The modal never sent one, so it 400'd on open for any
 * multi-company landlord, and the UI rendered that failure as "Loading…"
 * forever because it tested `!data`.
 *
 * These pin the contract the modal now honours.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { reportsRouter } from './reports'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', reportsRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_monthlypl'
let twoCoToken: string, oneCoToken: string, coA: string, coB: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const b = await seedLandlord(c)
    coA = a.landlordId; coB = b.landlordId
    const pA = await seedProperty(c, { landlordId: coA, ownerUserId: a.userId, managedByUserId: a.userId })
    await seedUnit(c, { propertyId: pA, landlordId: coA })
    await c.query('COMMIT')
    // One human, two companies — the shape that broke.
    twoCoToken = jwt.sign(
      { userId: a.userId, role: 'landlord', email: 'two@t.dev', profileId: null,
        landlordIds: [coA, coB], permissions: {} }, SECRET, { expiresIn: '1h' })
    oneCoToken = jwt.sign(
      { userId: a.userId, role: 'landlord', email: 'one@t.dev', profileId: null,
        landlordIds: [coA], permissions: {} }, SECRET, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const pl = (qs: string, token: string) => request(buildApp())
  .get(`/api/reports/monthly-pl?${qs}`).set('Authorization', `Bearer ${token}`)

describe('GET /reports/monthly-pl', () => {
  it('refuses to blend two companies, and says so', async () => {
    const res = await pl('year=2026&month=9', twoCoToken)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/more than one company/i)
  })

  it('answers once a company is named — what the modal now sends', async () => {
    const res = await pl(`year=2026&month=9&landlordId=${coA}`, twoCoToken)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('payments')
  })

  it('needs no company when the account owns exactly one', async () => {
    const res = await pl('year=2026&month=9', oneCoToken)
    expect(res.status).toBe(200)
  })

  it("refuses a company the caller does not own", async () => {
    const stranger = await (async () => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const s = await seedLandlord(c)
        await c.query('COMMIT')
        return s.landlordId
      } finally { c.release() }
    })()
    const res = await pl(`year=2026&month=9&landlordId=${stranger}`, twoCoToken)
    expect([400, 403, 404]).toContain(res.status)
  })
})
