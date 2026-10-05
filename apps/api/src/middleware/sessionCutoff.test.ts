/**
 * 10/5 — a pass minted before the account's sessions_valid_from is refused on
 * EVERY route. A password reset, a retired account and a reset applicant all
 * stamp that column; before this the old pass was refused only at /auth/me and
 * /auth/refresh, and kept working everywhere else until the portal reloaded.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, query } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { requireAuth, forgetSessionCutoff, _clearSessionCutoffCache } from './auth'
import { errorHandler } from './errorHandler'

function buildApp() {
  const app = express()
  app.use(requireAuth)
  app.get('/api/payments', (_req, res) => res.json({ success: true }))
  app.use(errorHandler)
  return app
}

let userId: string
beforeEach(async () => {
  await cleanupAllSchema()
  _clearSessionCutoffCache()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_cutoff'
  userId = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','','') RETURNING id`,
    [`cutoff-${randomUUID()}@test.dev`])).rows[0].id
})

const passAt = (iatSeconds: number) =>
  jwt.sign({ userId, role: 'tenant', email: 'x@test.dev', profileId: null, iat: iatSeconds }, process.env.JWT_SECRET!, { expiresIn: '1h' })
const call = (token: string) => request(buildApp()).get('/api/payments').set('Authorization', `Bearer ${token}`)
const stampAt = (seconds: number) =>
  query(`UPDATE users SET sessions_valid_from = to_timestamp($2::double precision) WHERE id = $1`, [userId, seconds])

describe('requireAuth and the account’s session cutoff', () => {
  it('an account that was never reset is let through', async () => {
    const res = await call(passAt(Math.floor(Date.now() / 1000)))
    expect(res.status).toBe(200)
  })

  it('a pass minted before the reset is refused on an ordinary route, with "sign in again"', async () => {
    const now = Math.floor(Date.now() / 1000)
    await stampAt(now)
    const res = await call(passAt(now - 60))
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Your session has ended. Please sign in again.')
  })

  it('a pass minted after the reset works, and so does one from the same second (iat is whole seconds)', async () => {
    const now = Math.floor(Date.now() / 1000)
    await stampAt(now - 10 + 0.4)
    expect((await call(passAt(now - 10))).status).toBe(200)
    expect((await call(passAt(now))).status).toBe(200)
  })

  it('a reset right after a request is seen at once when the writer forgets the cached value', async () => {
    const now = Math.floor(Date.now() / 1000)
    const old = passAt(now - 60)
    expect((await call(old)).status).toBe(200)   // caches "never reset"
    await stampAt(now)
    forgetSessionCutoff(userId)
    expect((await call(old)).status).toBe(401)
  })
})
