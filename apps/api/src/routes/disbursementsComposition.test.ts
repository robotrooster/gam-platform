/**
 * S655 — GET /api/disbursements/:id/composition: what a payout carried.
 *
 * The contents of a payout name tenants, units and amounts, so the detail obeys
 * exactly the rule the payout list does: your own payouts, or (admins) the
 * landlords you manage. Another landlord's payout is "not found", not a list of
 * their tenants.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { disbursementsRouter } from './disbursements'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/disbursements', disbursementsRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_disbursements'
let mine: { userId: string; landlordId: string }, theirs: { userId: string; landlordId: string }
let myPayout: string, theirPayout: string

const tokenFor = (u: { userId: string; landlordId: string }) => jwt.sign(
  { userId: u.userId, role: 'landlord', email: 'me@t.dev', profileId: null,
    landlordIds: [u.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    mine = await seedLandlord(c)
    theirs = await seedLandlord(c)
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  const payout = async (u: typeof mine, amount: number) => (await db.query(
    `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at)
     VALUES ($1,$2,'auto_friday',$3,'settled',$4,NOW()) RETURNING id`,
    [u.userId, u.landlordId, amount, `po_${Math.random().toString(36).slice(2)}`])).rows[0].id
  myPayout = await payout(mine, 589)
  theirPayout = await payout(theirs, 413)
  await db.query(
    `INSERT INTO platform_transfer_intents
       (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
        stripe_transfer_id, transferred_at, disbursement_id)
     VALUES ($1,$2,'acct_mine',589,589,'transferred','tr_mine',NOW(),$3)`, [mine.landlordId, mine.userId, myPayout])
})

describe('GET /api/disbursements/:id/composition', () => {
  it('shows a landlord what their own payout carried', async () => {
    const res = await request(buildApp())
      .get(`/api/disbursements/${myPayout}/composition`).set('Authorization', `Bearer ${tokenFor(mine)}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ disbursementId: myPayout, amount: 589, traced: true })
  })

  it('another landlord’s payout is not found', async () => {
    const res = await request(buildApp())
      .get(`/api/disbursements/${theirPayout}/composition`).set('Authorization', `Bearer ${tokenFor(mine)}`)
    expect(res.status).toBe(404)
    expect(res.body.data).toBeUndefined()
  })

  it('a malformed id is not found, not a server error', async () => {
    const res = await request(buildApp())
      .get(`/api/disbursements/not-a-uuid/composition`).set('Authorization', `Bearer ${tokenFor(mine)}`)
    expect(res.status).toBe(404)
  })
})
