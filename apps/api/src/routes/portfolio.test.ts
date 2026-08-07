/**
 * S592 — the portfolio_manager scoped surface (allow-list wall).
 *
 * Proves: a portfolio_manager reaches the /api/portfolio endpoints and is
 * scoped to their own book; the SAME token is denied on /api/admin (the wall);
 * and unrelated roles can't reach /api/portfolio either.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { portfolioRouter } from './portfolio'
import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/portfolio', portfolioRouter)
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_portfolio'
})

async function seedPm(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','portfolio_manager','PM','Rep',TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])
  return r.rows[0].id
}
const tokenFor = (userId: string, role: string) =>
  jwt.sign({ userId, role, email: 'x@t.dev', profileId: userId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })

describe('portfolio_manager scoped surface', () => {
  it('reaches /api/portfolio; the SAME token is denied on /api/admin (the wall)', async () => {
    const pm = await seedPm()
    const app = buildApp()
    const token = tokenFor(pm, 'portfolio_manager')

    const ok = await request(app).get('/api/portfolio/onboarding/overview').set('Authorization', `Bearer ${token}`)
    expect(ok.status).toBe(200)
    expect(typeof ok.body.data.landlords_no_bank).toBe('number')

    // Denied on the platform admin router entirely.
    const walled = await request(app).get('/api/admin/onboarding/overview').set('Authorization', `Bearer ${token}`)
    expect(walled.status).toBe(403)
    // ...and specifically the platform-financial endpoint.
    const fin = await request(app).get('/api/admin/income/projection').set('Authorization', `Bearer ${token}`)
    expect(fin.status).toBe(403)
  })

  it('/api/portfolio/commissions/summary returns only the PM\'s OWN earnings (no pot)', async () => {
    const pm = await seedPm()
    const res = await request(buildApp())
      .get('/api/portfolio/commissions/summary')
      .set('Authorization', `Bearer ${tokenFor(pm, 'portfolio_manager')}`)
    expect(res.status).toBe(200)
    expect(res.body.data.myEarnings).toBeDefined()
    expect(res.body.data.pot).toBeUndefined()       // super-only
    expect(res.body.data.byManager).toBeUndefined() // super-only
  })

  it('tenants list is scoped to the PM\'s book (a tenant under an unrelated landlord is not shown)', async () => {
    const pm = await seedPm()
    // Landlord NOT under this PM, with an active-lease tenant.
    const client = await db.connect()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await seedUnit(client, { propertyId, landlordId })
    } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/portfolio/tenants')
      .set('Authorization', `Bearer ${tokenFor(pm, 'portfolio_manager')}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])  // none of that landlord's tenants belong to this PM
  })

  it('/portfolio/landlords is scoped to the PM\'s book', async () => {
    const pm = await seedPm()
    // A landlord NOT under this PM.
    const client = await db.connect()
    try { await seedLandlord(client) } finally { client.release() }
    const res = await request(buildApp())
      .get('/api/portfolio/landlords')
      .set('Authorization', `Bearer ${tokenFor(pm, 'portfolio_manager')}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])  // unrelated landlord not in this PM's book
  })

  it('my-referral mints the PM a personal referral code + link', async () => {
    const pm = await seedPm()
    const res = await request(buildApp())
      .get('/api/portfolio/my-referral')
      .set('Authorization', `Bearer ${tokenFor(pm, 'portfolio_manager')}`)
    expect(res.status).toBe(200)
    expect(res.body.data.referralCode).toBeTruthy()
    expect(res.body.data.referralLink).toContain('?ref=')
  })

  it('resend is scoped: a PM cannot resend to a tenant outside their book → 403', async () => {
    const pm = await seedPm()
    // A tenant with no lease / no relationship to this PM.
    const tu = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','T','U',FALSE) RETURNING id`, [`t-${randomUUID()}@t.dev`])
    const tRow = await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [tu.rows[0].id])
    const res = await request(buildApp())
      .post('/api/portfolio/onboarding/resend')
      .set('Authorization', `Bearer ${tokenFor(pm, 'portfolio_manager')}`)
      .send({ type: 'tenant_invite', targetId: tRow.rows[0].id })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/portfolio/i)
  })

  it('a landlord (or any non-rep role) is denied on /api/portfolio', async () => {
    const t = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','landlord','L','L',TRUE) RETURNING id`, [`l-${randomUUID()}@test.dev`])
    const res = await request(buildApp())
      .get('/api/portfolio/onboarding/overview')
      .set('Authorization', `Bearer ${tokenFor(t.rows[0].id, 'landlord')}`)
    expect(res.status).toBe(403)
  })
})
