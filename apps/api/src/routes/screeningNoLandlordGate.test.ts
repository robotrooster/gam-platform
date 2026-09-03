/**
 * S636 — the landlord is not part of the screening transaction.
 *
 * Nic: "Landlords are not part of the screening process at all. Doesn't
 * matter what their bank account is set up for. The tenant is paying for
 * the application. GAM and Checkr get the application fee. The landlord...
 * why is that gated at all?"
 *
 * S577 routed the applicant's card `on_behalf_of` the landlord's Connect to
 * make them merchant of record, and refused to open a payment intent until
 * that landlord had finished Connect onboarding. It moved no money — no
 * transfer_data, funds settle to GAM, landlord nets $0 — so the gate blocked
 * a paying applicant over a payout account the charge never touches. The
 * pool route has always charged with no landlord at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

vi.mock('../services/poolIntake', async (orig) => ({
  ...(await orig() as any),
  getPoolIntakeShell: vi.fn(async () => ({ landlordId: randomUUID(), backgroundProvider: 'checkr' })),
}))

import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

let token: string
let landlordNoConnect: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_gate'
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    landlordNoConnect = l.landlordId
    // Explicitly NOT onboarded: no Connect account, charges disabled.
    await c.query(
      `UPDATE landlords SET stripe_connect_account_id=NULL, connect_charges_enabled=FALSE WHERE id=$1`,
      [landlordNoConnect])
    await c.query(
      `UPDATE users SET stripe_connect_account_id=NULL, connect_charges_enabled=FALSE WHERE id=$1`,
      [l.userId])
    const { rows: [u] } = await c.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','App','Licant',TRUE) RETURNING id, email`,
      [`app-${randomUUID()}@test.dev`])
    await c.query('COMMIT')
    token = jwt.sign({ userId: u.id, role: 'tenant', email: u.email, profileId: randomUUID() },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

describe('POST /background/payment-intent', () => {
  it('opens for a landlord who has never touched Connect', async () => {
    const res = await request(buildApp())
      .post('/api/background/payment-intent')
      .set('Authorization', `Bearer ${token}`)
      .send({ landlordId: landlordNoConnect })
    expect(res.status).toBe(200)
    expect(res.body.data.amount).toBeGreaterThan(0)
  })

  it('opens on the pool route, with no landlord at all', async () => {
    const res = await request(buildApp())
      .post('/api/background/payment-intent')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.amount).toBeGreaterThan(0)
  })

  it('charges the same flat price either way', async () => {
    const app = buildApp()
    const withLandlord = await request(app).post('/api/background/payment-intent')
      .set('Authorization', `Bearer ${token}`).send({ landlordId: landlordNoConnect })
    const pool = await request(app).post('/api/background/payment-intent')
      .set('Authorization', `Bearer ${token}`).send({})
    expect(withLandlord.body.data.amount).toBe(pool.body.data.amount)
  })

  it('quotes the screening blended with GAM\'s margin, processing separate', async () => {
    const res = await request(buildApp())
      .get('/api/background/price?landlordId=' + landlordNoConnect)
    expect(res.status).toBe(200)
    const d = res.body.data
    // What the applicant's receipt shows as one screening line.
    expect(d.applicantFee).toBe(
      Math.round((d.breakdown.screening + d.breakdown.gamFee) * 100) / 100)
    // Card processing is a cost of paying by card, not part of the screen.
    expect(d.processingFee).toBe(d.breakdown.processing)
    expect(d.totalFee).toBeCloseTo(d.applicantFee + d.processingFee + d.breakdown.tax, 2)
  })
})
