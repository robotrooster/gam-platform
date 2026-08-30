/**
 * S630 (Nic): "I don't wanna sign in to my landlord account with the Oak Park
 * email. We're gonna be selling Oak Park and potentially giving up control of
 * that email address to the new buyer, and I need my sign in to be something
 * that stays with me."
 *
 * The security property that matters: a change that is merely REQUESTED must
 * never be able to lock the owner out, and must never take effect until the new
 * mailbox is proven.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

const { confirmMock, noticeMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(async (..._a: any[]) => 'msg_confirm'),
  noticeMock:  vi.fn(async (..._a: any[]) => 'msg_notice'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    sendEmailVerification: vi.fn(async () => 'msg_verify'),
    sendPasswordResetEmail: vi.fn(async () => 'msg_reset'),
    sendEmailChangeConfirmation: confirmMock,
    sendEmailChangeNotice: noticeMock,
  }
})

import { db } from '../db'
import { authRouter } from './auth'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

const PASSWORD = 'CorrectHorse!42'

describe('POST /api/auth/change-email', () => {
  let userId = '', oldEmail = '', token = ''

  beforeEach(async () => {
    await cleanupAllSchema()
    confirmMock.mockClear(); noticeMock.mockClear()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s450'
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      userId = ll.userId
      await c.query(`UPDATE users SET password_hash = $1 WHERE id = $2`,
        [await bcrypt.hash(PASSWORD, 10), userId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const u = await db.query<any>(`SELECT email FROM users WHERE id=$1`, [userId])
      .then((r: any) => r.rows[0])
    oldEmail = u.email
    token = jwt.sign({ userId, role: 'landlord', email: oldEmail, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  })

  const req = () => request(buildApp())
  const pending = () => db.query<any>(
    `SELECT email, pending_email, pending_email_token FROM users WHERE id=$1`, [userId])
    .then((r: any) => r.rows[0])

  it('holds the new address pending — the old email still signs in until confirmed', async () => {
    const target = `keeps-with-me-${randomUUID()}@example.com`
    const res = await req().post('/api/auth/change-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail: target, password: PASSWORD }).expect(200)

    expect(res.body.data.pendingEmail).toBe(target)
    const row = await pending()
    expect(row.email).toBe(oldEmail)          // unchanged — this is the point
    expect(row.pending_email).toBe(target)
    expect(confirmMock).toHaveBeenCalledTimes(1)   // to the NEW address
    // The old mailbox is warned while its holder can still act.
    expect(noticeMock).toHaveBeenCalledTimes(1)
    expect(noticeMock.mock.calls[0][0]).toBe(oldEmail)
    expect(noticeMock.mock.calls[0][3]).toBe('requested')

    // Old credentials still work.
    await req().post('/api/auth/login')
      .send({ email: oldEmail, password: PASSWORD }).expect(200)
  })

  it('confirming swaps it, and the old address stops working', async () => {
    const target = `confirmed-${randomUUID()}@example.com`
    await req().post('/api/auth/change-email').set('Authorization', `Bearer ${token}`)
      .send({ newEmail: target, password: PASSWORD }).expect(200)
    const { pending_email_token } = await pending()

    const res = await req().post('/api/auth/change-email/confirm')
      .send({ token: pending_email_token }).expect(200)
    expect(res.body.data.email).toBe(target)

    const row = await pending()
    expect(row.email).toBe(target)
    expect(row.pending_email).toBeNull()
    expect(row.pending_email_token).toBeNull()

    await req().post('/api/auth/login').send({ email: target, password: PASSWORD }).expect(200)
    await req().post('/api/auth/login').send({ email: oldEmail, password: PASSWORD }).expect(401)
  })

  it('refuses without the correct password — this is the recovery credential', async () => {
    await req().post('/api/auth/change-email').set('Authorization', `Bearer ${token}`)
      .send({ newEmail: `nope-${randomUUID()}@example.com`, password: 'wrong-password' })
      .expect(401)
    expect((await pending()).pending_email).toBeNull()
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('refuses an address another account already uses', async () => {
    const c = await db.connect()
    let otherEmail = ''
    try {
      await c.query('BEGIN')
      const other = await seedLandlord(c)
      await c.query('COMMIT')
      otherEmail = await db.query<any>(`SELECT email FROM users WHERE id=$1`, [other.userId])
        .then((r: any) => r.rows[0].email)
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    await req().post('/api/auth/change-email').set('Authorization', `Bearer ${token}`)
      .send({ newEmail: otherEmail, password: PASSWORD }).expect(409)
    expect((await pending()).pending_email).toBeNull()
  })

  it('an expired link does not swap anything', async () => {
    const target = `expired-${randomUUID()}@example.com`
    await req().post('/api/auth/change-email').set('Authorization', `Bearer ${token}`)
      .send({ newEmail: target, password: PASSWORD }).expect(200)
    const { pending_email_token } = await pending()
    await db.query(
      `UPDATE users SET pending_email_expires_at = NOW() - interval '1 minute' WHERE id=$1`,
      [userId])

    await req().post('/api/auth/change-email/confirm')
      .send({ token: pending_email_token }).expect(400)
    expect((await pending()).email).toBe(oldEmail)
  })

  it('the same link cannot be replayed', async () => {
    const target = `once-${randomUUID()}@example.com`
    await req().post('/api/auth/change-email').set('Authorization', `Bearer ${token}`)
      .send({ newEmail: target, password: PASSWORD }).expect(200)
    const { pending_email_token } = await pending()
    await req().post('/api/auth/change-email/confirm').send({ token: pending_email_token }).expect(200)
    await req().post('/api/auth/change-email/confirm').send({ token: pending_email_token }).expect(400)
  })

  it('a pending change can be called off', async () => {
    await req().post('/api/auth/change-email').set('Authorization', `Bearer ${token}`)
      .send({ newEmail: `cancel-${randomUUID()}@example.com`, password: PASSWORD }).expect(200)
    await req().delete('/api/auth/change-email').set('Authorization', `Bearer ${token}`).expect(200)
    const row = await pending()
    expect(row.pending_email).toBeNull()
    expect(row.email).toBe(oldEmail)
  })
})
