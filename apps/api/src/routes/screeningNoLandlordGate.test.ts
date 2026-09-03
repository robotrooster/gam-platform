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
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'

// STRIPE_LIVE is fixed when background.ts is first imported, from whatever
// STRIPE_SECRET_KEY happens to be set at that moment. The whole API suite
// shares one process, so which file imports it first decides whether this
// route takes the mock branch or calls Stripe for real — and a sibling test
// sets a fake key, which made a real call come back "Invalid API Key" as a
// 401. That is why these passed alone and failed in the full run.
// Mocking the SDK makes this file correct on either branch.
vi.mock('stripe', () => {
  const create = vi.fn(async (args: any) => ({
    id: 'pi_mock_' + Math.random().toString(36).slice(2, 10),
    client_secret: 'pi_mock_secret',
    amount: args.amount,
  }))
  return { default: class { paymentIntents = { create } } }
})

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

// The whole suite runs in ONE fork (vitest singleFork), so process.env is
// shared and any file that replaces it changes the secret out from under a
// token minted earlier. Signing with an explicit constant, and pinning the
// env to the same constant at request time, makes this file independent of
// whatever ran before it — it passed alone and failed only in the full run.
const SECRET = 'test_jwt_secret_gate'
const sign = (p: object) => {
  process.env.JWT_SECRET = SECRET
  return jwt.sign(p, SECRET, { expiresIn: '1h' })
}

let applicantId: string
let applicantEmail: string
let landlordNoConnect: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
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
    applicantId = u.id
    applicantEmail = u.email
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

describe('POST /background/payment-intent', () => {
  it('opens for a landlord who has never touched Connect', async () => {
    const res = await request(buildApp())
      .post('/api/background/payment-intent')
      .set('Authorization', `Bearer ${sign({ userId: applicantId, role: 'tenant', email: applicantEmail, profileId: randomUUID() })}`)
      .send({ landlordId: landlordNoConnect })
    expect(res.status).toBe(200)
    expect(res.body.data.amount).toBeGreaterThan(0)
  })

  it('opens on the pool route, with no landlord at all', async () => {
    const res = await request(buildApp())
      .post('/api/background/payment-intent')
      .set('Authorization', `Bearer ${sign({ userId: applicantId, role: 'tenant', email: applicantEmail, profileId: randomUUID() })}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.amount).toBeGreaterThan(0)
  })

  it('charges the same flat price either way', async () => {
    const app = buildApp()
    const withLandlord = await request(app).post('/api/background/payment-intent')
      .set('Authorization', `Bearer ${sign({ userId: applicantId, role: 'tenant', email: applicantEmail, profileId: randomUUID() })}`).send({ landlordId: landlordNoConnect })
    const pool = await request(app).post('/api/background/payment-intent')
      .set('Authorization', `Bearer ${sign({ userId: applicantId, role: 'tenant', email: applicantEmail, profileId: randomUUID() })}`).send({})
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


// ── S636: the scanned property must be VISIBLE to the landlord ───────
//
// Everything about the QR exists to bind an applicant to a park. The
// landlord's review list resolved the property through the applicant's
// UNIT — and a walk-up who scanned a code has no unit, which is the whole
// point of the code. So the binding was recorded and then shown as blank
// on the one page a landlord would look at.
describe('GET /background — property on the review list', () => {
  it("shows the property a walk-up scanned at, with no unit", async () => {
    const c = await db.connect()
    let landlordId: string, landlordUserId: string, propertyId: string, applicantId: string
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      landlordId = l.landlordId; landlordUserId = l.userId
      propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
      await c.query(`UPDATE properties SET name='Mountain View RV Ranch' WHERE id=$1`, [propertyId])
      const { rows: [a] } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','tenant','Walk','Up',TRUE) RETURNING id`,
        [`walk-${randomUUID()}@test.dev`])
      applicantId = a.id
      await c.query(
        `INSERT INTO background_checks
           (user_id, landlord_id, property_id, unit_id, status, first_name, last_name)
         VALUES ($1,$2,$3,NULL,'pending','Walk','Up')`,
        [applicantId, landlordId, propertyId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const llToken = sign(
      { userId: landlordUserId!, role: 'landlord', email: 'll@t.dev', profileId: landlordId!, permissions: {} })
    const res = await request(buildApp())
      .get('/api/background').set('Authorization', `Bearer ${llToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].property_name).toBe('Mountain View RV Ranch')
    expect(res.body.data[0].unit_number).toBeNull()
  })
})
