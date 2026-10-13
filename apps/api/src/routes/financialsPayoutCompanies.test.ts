/**
 * 10/12 (Nic, G2): a payout from a Stripe account several companies share is
 * labeled with EVERY company paid through it — never the first company the
 * login created (the S652 pattern, routes/disbursements companies_on_account).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { financialsRouter } from './financials'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/financials', financialsRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_financials'
})

describe('payouts from a Stripe account two companies share', () => {
  it('name both companies; a payout stamped on one company names that one', async () => {
    const c = await db.connect()
    let userId: string, alpha: string, beta: string
    try {
      ({ userId, landlordId: alpha } = await seedLandlord(c))
      beta = (await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [userId])).rows[0].id
      // Beta is created first, so "the first company on the login" would be Beta alone.
      await c.query(`UPDATE landlords SET business_name = 'Beta Park', created_at = '2025-01-01' WHERE id = $1`, [beta])
      await c.query(`UPDATE landlords SET business_name = 'Alpha Acres', created_at = '2025-06-01' WHERE id = $1`, [alpha])
      // One login's Stripe account, both companies paid through it (a company's
      // own account is unique to it, so sharing is at the login).
      await c.query(`UPDATE users SET stripe_connect_account_id = 'acct_shared' WHERE id = $1`, [userId])
      await c.query(
        `INSERT INTO disbursements (user_id, landlord_id, amount, status, trigger_type, stripe_account_id, created_at)
         VALUES ($1, NULL, 500, 'settled', 'auto_friday', 'acct_shared', '2026-10-01T12:00:00Z'),
                ($1, NULL, 200, 'settled', 'auto_friday', NULL,          '2026-09-01T12:00:00Z'),
                ($1, $2,   100, 'settled', 'auto_friday', 'acct_shared', '2026-08-01T12:00:00Z')`, [userId, alpha])
    } finally { c.release() }
    const token = sign({ userId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [alpha, beta], permissions: {} })
    const r = await request(app()).get('/api/financials/payouts').set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.payouts.map((p: any) => [p.amount, p.companyName])).toEqual([
      [500, 'Alpha Acres + Beta Park'],   // the shared account's payout: both
      [200, 'Alpha Acres + Beta Park'],   // an older one naming only the login: every company on it
      [100, 'Alpha Acres'],               // stamped on one company: that one
    ])
  })
})
