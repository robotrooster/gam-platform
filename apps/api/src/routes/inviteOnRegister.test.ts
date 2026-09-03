/**
 * S637 — registering with an invited email accepts the invitation.
 *
 * Nic: "you need to fix it so that his registered new account is the invite
 * accepted. They need to be merged into one. He doesn't have a separate
 * account for anything."
 *
 * Dusty Rhoades was invited as a co-owner of Mountain View, then REGISTERED
 * instead of opening the invite link. Both are him, at the same address — but
 * the invite stayed pending, so his account owned nothing and the entity he
 * was invited to was invisible. Recovering meant finding the original email
 * and clicking it: undoing a step he did not know he took wrong.
 *
 * An invitation is addressed to an EMAIL, and registering with that address
 * proves the same thing clicking the link proves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailLoginCode: vi.fn(async () => 'msg'),
  sendEmailVerification: vi.fn(async () => 'msg'),
  emailLandlordWelcomeOutreach: vi.fn(async () => 'msg'),
}))

import { authRouter } from './auth'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

let inviterUserId: string, entityId: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_invitereg'
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    inviterUserId = l.userId
    entityId = l.landlordId
    await c.query(`UPDATE landlords SET business_name='Mountain View RV Park Ranch LLC' WHERE id=$1`, [entityId])
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const invite = (email: string, opts: { expired?: boolean; status?: string } = {}) =>
  db.query(
    `INSERT INTO landlord_member_invitations
       (landlord_id, email, invited_by_user_id, status, token, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`,
    [entityId, email, inviterUserId, opts.status ?? 'pending',
     randomUUID().replace(/-/g, ''), opts.expired ? '-1' : '7'])

const register = (email: string) =>
  request(buildApp()).post('/api/auth/register').send({
    email, password: 'Str0ng!Passw0rd', firstName: 'Dusty', lastName: 'Rhoades',
    role: 'landlord', acceptedTerms: true,
  })

const membershipsFor = async (email: string) => (await db.query<any>(
  `SELECT m.landlord_id, m.role FROM landlord_members m
     JOIN users u ON u.id = m.user_id WHERE LOWER(u.email) = LOWER($1)`, [email])).rows

describe('registering with a pending invitation', () => {
  it('makes the new account an owner of the entity it was invited to', async () => {
    const email = `dusty-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    const res = await register(email)
    expect(res.status).toBe(201)

    const rows = await membershipsFor(email)
    expect(rows.map((r: any) => r.landlord_id)).toContain(entityId)
    expect(rows.every((r: any) => r.role === 'owner')).toBe(true)
  })

  it('marks the invitation accepted against that user', async () => {
    const email = `dusty-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email)
    await register(email)
    const { rows } = await db.query<any>(
      `SELECT i.status, i.accepted_user_id, u.email
         FROM landlord_member_invitations i
         JOIN users u ON u.id = i.accepted_user_id
        WHERE LOWER(i.email) = LOWER($1)`, [email])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('accepted')
    expect(String(rows[0].email).toLowerCase()).toBe(email.toLowerCase())
  })

  it('matches the address case-insensitively', async () => {
    const email = `Dusty-${randomUUID().slice(0, 8)}@Mailer-Test.co`
    await invite(email.toLowerCase())
    await register(email.toUpperCase())
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).toContain(entityId)
  })

  it('ignores an EXPIRED invitation', async () => {
    const email = `late-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email, { expired: true })
    await register(email)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).not.toContain(entityId)
  })

  it('ignores an already-accepted invitation', async () => {
    const email = `done-${randomUUID().slice(0, 8)}@mailer-test.co`
    await invite(email, { status: 'accepted' })
    await register(email)
    expect((await membershipsFor(email)).map((r: any) => r.landlord_id)).not.toContain(entityId)
  })

  it('attaches nothing to somebody who was never invited', async () => {
    const email = `stranger-${randomUUID().slice(0, 8)}@mailer-test.co`
    await register(email)
    const rows = await membershipsFor(email)
    // Their own new entity only — never the inviter's.
    expect(rows.map((r: any) => r.landlord_id)).not.toContain(entityId)
    expect(rows).toHaveLength(1)
  })
})
