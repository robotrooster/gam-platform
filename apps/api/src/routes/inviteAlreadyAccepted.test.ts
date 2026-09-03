/**
 * S637 — an invite that was USED is not an invite that EXPIRED.
 *
 * Nic: "Several more people tell me that their invite expired when they
 * already accepted it. They tried to go back to that email only to find out
 * that it's expired because they used it, and they think that it locked them
 * out, and they need a new invite."
 *
 * Activation cleared the token, so a tenant reopening their own email was
 * indistinguishable from somebody holding a bad link — both got "Invalid or
 * expired invite link", and the screen told them to ask their landlord for a
 * new one. For a person who had just successfully set a password that is
 * false, and it reads as being locked out of an account that works.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailLoginCode: vi.fn(async () => 'msg'),
}))

import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

let token: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_invite'
  token = randomUUID().replace(/-/g, '')
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: l.landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
    await seedUnit(c, { propertyId, landlordId: l.landlordId })
    const { rows: [u] } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified,
                          tenant_invite_token, tenant_invite_expires_at)
       VALUES ($1, '', 'tenant', 'New', 'Tenant', FALSE, $2, NOW() + INTERVAL '7 days')
       RETURNING id`, [`inv-${randomUUID().slice(0, 8)}@mailer-test.co`, token])
    await c.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

// The token travels in the BODY — the route is declared before requireAuth
// precisely so an un-activated tenant can reach it.
const accept = (t: string) => request(buildApp())
  .post('/api/tenants/accept-invite')
  .send({ token: t, password: 'Str0ng!Passw0rd', acceptedTerms: true })

describe('POST /tenants/accept-invite/:token', () => {
  it('activates the account the first time', async () => {
    const res = await accept(token)
    expect(res.status).toBe(200)
  })

  it('tells a returning tenant they are ALREADY SET UP, not expired', async () => {
    await accept(token)
    const again = await accept(token)
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('ALREADY_ACCEPTED')
    expect(again.body.error).toMatch(/already set up/i)
    expect(again.body.error).not.toMatch(/expired/i)
  })

  it('does not let a used link change the password again', async () => {
    await accept(token)
    const { rows: [before] } = await db.query<any>(
      `SELECT password_hash FROM users WHERE tenant_invite_token = $1`, [token])
    await request(buildApp()).post('/api/tenants/accept-invite')
      .send({ token, password: 'Different!Passw0rd', acceptedTerms: true })
    const { rows: [after] } = await db.query<any>(
      `SELECT password_hash FROM users WHERE tenant_invite_token = $1`, [token])
    expect(after.password_hash).toBe(before.password_hash)
  })

  it('still says invalid for a token that never existed', async () => {
    const res = await accept(randomUUID().replace(/-/g, ''))
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/invalid or expired/i)
  })

  it('still says invalid for a genuinely expired token', async () => {
    await db.query(
      `UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day'
        WHERE tenant_invite_token = $1`, [token])
    const res = await accept(token)
    expect(res.status).toBe(404)
  })
})
