/**
 * S652 — the portal lock, and the three things it must not do.
 *
 * Nic: "In the off chance they refuse to put a bank account in there, we can
 * just lock down all the data and say, please, when they log in, maybe the only
 * thing they can see is 'please contact GAM support to restore your account
 * access.'"
 *
 * It must not be a dead end (the bank-linking route it demands stays open), it
 * must not touch tenants (they owe GAM nothing), and it must not read as a dead
 * session (402, not 401 — a 401 would bounce a correctly-signed-in landlord to
 * the login page to type a password that already works).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { requireAuth, isLockEscapeRoute } from './auth'
import { errorHandler } from './errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use(requireAuth)
  app.get('/api/properties', (_req, res) => res.json({ success: true, data: [] }))
  app.get('/api/bank-feed', (_req, res) => res.json({ success: true, data: [] }))
  app.get('/api/auth/me', (_req, res) => res.json({ success: true, data: { ok: true } }))
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_lock'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const lock = (landlordId: string, reason = 'Owes $480 with no bank on file') =>
  query(`UPDATE landlords SET platform_locked_at = NOW(), platform_locked_reason = $2 WHERE id = $1`,
    [landlordId, reason])

describe('a locked landlord', () => {
  it('is let through as normal until somebody locks the account', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/properties').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
  })

  it('gets 402 and a reason, not a 401 that would bounce them to login', async () => {
    const f = await seed()
    await lock(f.landlordId)
    const res = await request(buildApp()).get('/api/properties').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(402)
    expect(res.body.code).toBe('ACCOUNT_LOCKED')
    expect(res.body.lockedReason).toMatch(/no bank on file/i)
  })

  it('can still reach the bank-linking route that fixes it', async () => {
    // A lock whose only remedy sits behind the lock is a deadlock.
    const f = await seed()
    await lock(f.landlordId)
    const res = await request(buildApp()).get('/api/bank-feed').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
  })

  it('can still read who they are, so the portal can draw the lock screen', async () => {
    const f = await seed()
    await lock(f.landlordId)
    const res = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
  })

  it('is unlocked the moment the flag comes off', async () => {
    const f = await seed()
    await lock(f.landlordId)
    await query(`UPDATE landlords SET platform_locked_at = NULL WHERE id = $1`, [f.landlordId])
    const res = await request(buildApp()).get('/api/properties').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
  })

  it('keeps working when only ONE of their companies is locked', async () => {
    // An account with two parks, one settled, is not locked out of the settled
    // one. The scope checks already keep them out of the locked company's data.
    const f = await seed()
    const c = await db.connect()
    let second: string
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      second = r.landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    await lock(f.landlordId)
    const token = jwt.sign(
      { userId: f.userId, role: 'landlord', email: 'll@t.dev', profileId: f.landlordId,
        landlordIds: [f.landlordId, second!], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp()).get('/api/properties').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('everybody else', () => {
  it('a TENANT of a locked landlord is completely unaffected', async () => {
    // They owe GAM nothing. Locking them to make a point about their landlord's
    // bill would punish the wrong party — and stop rent being paid, which is
    // the money this whole mechanism exists to collect.
    const f = await seed()
    await lock(f.landlordId)
    const tenantToken = jwt.sign(
      { userId: f.userId, role: 'tenant', email: 't@t.dev', profileId: 'x', permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp()).get('/api/properties').set('Authorization', `Bearer ${tenantToken}`)
    expect(res.status).toBe(200)
  })
})

describe('the escape list', () => {
  it('opens the bank route and nothing resembling it', () => {
    expect(isLockEscapeRoute('GET',  '/api/bank-feed/connections')).toBe(true)
    expect(isLockEscapeRoute('POST', '/api/bank-feed/link')).toBe(true)
    expect(isLockEscapeRoute('GET',  '/api/auth/me')).toBe(true)
    // Their own operation stays shut.
    expect(isLockEscapeRoute('GET',  '/api/properties')).toBe(false)
    expect(isLockEscapeRoute('GET',  '/api/payments')).toBe(false)
    expect(isLockEscapeRoute('POST', '/api/pos/transactions')).toBe(false)
    // A query string must not change the answer.
    expect(isLockEscapeRoute('GET',  '/api/bank-feed?propertyId=1')).toBe(true)
    // Nor may a lookalike path sneak in.
    expect(isLockEscapeRoute('GET',  '/api/bank-feeds-report')).toBe(false)
  })
})
