/**
 * S574 — POS terminal lock screen: activate + unlock + passcode + capability lock.
 *
 * Coverage:
 *   PUT  /api/business-users/:id/passcode  — set / clear / uniqueness / owner-only
 *   POST /api/pos-lock/activate            — full session mints a terminal token
 *   POST /api/pos-lock/unlock              — passcode → cashier session; bad passcode
 *   requireAuth posLimited gate            — cashier session locked to the register
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessInvitation: vi.fn(async () => 'msg_mock') }
})

import { db } from '../db'
import { requireAuth } from '../middleware/auth'
import { businessUsersRouter } from './businessUsers'
import { posLockRouter } from './posLock'
import { businessPosRouter } from './businessPos'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-users', businessUsersRouter)
  app.use('/api/pos-lock', posLockRouter)
  app.use('/api/business-pos', businessPosRouter)
  // A stand-in protected route to prove the posLimited gate blocks non-register
  // paths (any requireAuth route that isn't allowlisted must 403).
  app.get('/api/reports/secret', requireAuth, (_req, res) => res.json({ success: true, data: { ok: true } }))
  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ success: true, data: { id: (req as any).user.userId } }))
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_poslock'

async function seedOwnerBiz(opts: { pos?: boolean } = {}) {
  const email = `owner-${randomUUID()}@test.dev`
  const hash = await bcrypt.hash('OwnerPass1234!', 10)
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,$2,'business_owner','Ow','Ner',TRUE) RETURNING id`, [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1,'Shop','mini_market',$2,$3) RETURNING id`,
    [u.id, `biz-${u.id}@biz.dev`, opts.pos === false ? [] : ['pos', 'inventory', 'customers']])
  const token = jwt.sign({ userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id }, SECRET, { expiresIn: '1h' })
  return { ownerId: u.id, businessId: b.id, ownerToken: token }
}

async function seedStaff(businessId: string, opts: { role?: string; perms?: string[] } = {}) {
  const email = `staff-${randomUUID()}@test.dev`
  const hash = await bcrypt.hash('StaffPass1234!', 10)
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,$2,'business_staff','St','Aff',TRUE) RETURNING id`, [email, hash])
  const { rows: [bu] } = await db.query<{ id: string }>(
    `INSERT INTO business_users (business_id, user_id, staff_role, permissions, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id`,
    [businessId, u.id, opts.role ?? 'office', JSON.stringify(opts.perms ?? ['pos.use', 'pos.refund'])])
  return { userId: u.id, rowId: bu.id, email }
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
})

// ═══════════════════════════════════════════════════════════════
//  Passcode set / clear / uniqueness
// ═══════════════════════════════════════════════════════════════

describe('PUT /api/business-users/:id/passcode', () => {
  it('owner sets a valid passcode; list reports has_pos_passcode without leaking the hash', async () => {
    const biz = await seedOwnerBiz()
    const staff = await seedStaff(biz.businessId)
    const res = await request(buildApp())
      .put(`/api/business-users/${staff.rowId}/passcode`)
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: '4321' })
    expect(res.status).toBe(200)
    expect(res.body.data.hasPasscode).toBe(true)

    const list = await request(buildApp())
      .get('/api/business-users').set('Authorization', `Bearer ${biz.ownerToken}`)
    const row = list.body.data.staff.find((s: any) => s.id === staff.rowId)
    expect(row.has_pos_passcode).toBe(true)
    expect(JSON.stringify(list.body)).not.toContain('pos_passcode_hash')
  })

  it('rejects a non-4-6-digit passcode', async () => {
    const biz = await seedOwnerBiz()
    const staff = await seedStaff(biz.businessId)
    for (const bad of ['12', '1234567', 'abcd', '12a4']) {
      const res = await request(buildApp())
        .put(`/api/business-users/${staff.rowId}/passcode`)
        .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: bad })
      expect(res.status).toBe(400)
    }
  })

  it('rejects a duplicate passcode within the same business', async () => {
    const biz = await seedOwnerBiz()
    const a = await seedStaff(biz.businessId)
    const b = await seedStaff(biz.businessId)
    await request(buildApp()).put(`/api/business-users/${a.rowId}/passcode`)
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: '2468' }).expect(200)
    const dup = await request(buildApp()).put(`/api/business-users/${b.rowId}/passcode`)
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: '2468' })
    expect(dup.status).toBe(409)
  })

  it('clears a passcode with null', async () => {
    const biz = await seedOwnerBiz()
    const staff = await seedStaff(biz.businessId)
    await request(buildApp()).put(`/api/business-users/${staff.rowId}/passcode`)
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: '1357' }).expect(200)
    const res = await request(buildApp()).put(`/api/business-users/${staff.rowId}/passcode`)
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: null })
    expect(res.status).toBe(200)
    expect(res.body.data.hasPasscode).toBe(false)
  })

  it('staff (non-owner) cannot set a passcode', async () => {
    const biz = await seedOwnerBiz()
    const staff = await seedStaff(biz.businessId)
    const staffToken = jwt.sign({ userId: staff.userId, role: 'business_staff', email: staff.email, profileId: biz.businessId, businessId: biz.businessId }, SECRET, { expiresIn: '1h' })
    const res = await request(buildApp()).put(`/api/business-users/${staff.rowId}/passcode`)
      .set('Authorization', `Bearer ${staffToken}`).send({ passcode: '9999' })
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Activate + unlock
// ═══════════════════════════════════════════════════════════════

describe('POST /api/pos-lock/activate + /unlock', () => {
  it('owner activates → terminal token; correct passcode unlocks → posLimited cashier session', async () => {
    const biz = await seedOwnerBiz()
    const staff = await seedStaff(biz.businessId, { perms: ['pos.use', 'pos.refund'] })
    await request(buildApp()).put(`/api/business-users/${staff.rowId}/passcode`)
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: '5678' }).expect(200)

    const act = await request(buildApp()).post('/api/pos-lock/activate')
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({})
    expect(act.status).toBe(200)
    const terminalToken = act.body.data.terminalToken
    expect(terminalToken).toBeTruthy()

    const unlock = await request(buildApp()).post('/api/pos-lock/unlock')
      .set('Authorization', `Bearer ${terminalToken}`).send({ passcode: '5678' })
    expect(unlock.status).toBe(200)
    expect(unlock.body.data.token).toBeTruthy()
    expect(unlock.body.data.cashier.staffRole).toBe('office')

    const decoded: any = jwt.decode(unlock.body.data.token)
    expect(decoded.posLimited).toBe(true)
    expect(decoded.role).toBe('business_staff')
    expect(decoded.businessId).toBe(biz.businessId)
    expect(decoded.userId).toBe(staff.userId)
    expect(decoded.purpose).toBeUndefined()  // must pass requireAuth as a real session
  })

  it('wrong passcode → 401', async () => {
    const biz = await seedOwnerBiz()
    const staff = await seedStaff(biz.businessId)
    await request(buildApp()).put(`/api/business-users/${staff.rowId}/passcode`)
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: '5678' }).expect(200)
    const act = await request(buildApp()).post('/api/pos-lock/activate')
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({})
    const unlock = await request(buildApp()).post('/api/pos-lock/unlock')
      .set('Authorization', `Bearer ${act.body.data.terminalToken}`).send({ passcode: '0000' })
    expect(unlock.status).toBe(401)
  })

  it('unlock without a terminal token → 401', async () => {
    const res = await request(buildApp()).post('/api/pos-lock/unlock').send({ passcode: '5678' })
    expect(res.status).toBe(401)
  })

  it('a terminal token is rejected by requireAuth on normal routes (purpose guard)', async () => {
    const biz = await seedOwnerBiz()
    const act = await request(buildApp()).post('/api/pos-lock/activate')
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({})
    const res = await request(buildApp()).get('/api/auth/me')
      .set('Authorization', `Bearer ${act.body.data.terminalToken}`)
    expect(res.status).toBe(401)
  })

  it('activate requires the pos feature enabled', async () => {
    const biz = await seedOwnerBiz({ pos: false })
    const res = await request(buildApp()).post('/api/pos-lock/activate')
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({})
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  posLimited capability gate
// ═══════════════════════════════════════════════════════════════

describe('requireAuth posLimited gate', () => {
  async function cashierToken() {
    const biz = await seedOwnerBiz()
    const staff = await seedStaff(biz.businessId)
    await request(buildApp()).put(`/api/business-users/${staff.rowId}/passcode`)
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({ passcode: '5678' }).expect(200)
    const act = await request(buildApp()).post('/api/pos-lock/activate')
      .set('Authorization', `Bearer ${biz.ownerToken}`).send({})
    const unlock = await request(buildApp()).post('/api/pos-lock/unlock')
      .set('Authorization', `Bearer ${act.body.data.terminalToken}`).send({ passcode: '5678' })
    return { token: unlock.body.data.token, businessId: biz.businessId }
  }

  it('cashier session can read /auth/me (bootstrap)', async () => {
    const { token } = await cashierToken()
    const res = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('cashier session is BLOCKED from a non-register route (reports)', async () => {
    const { token } = await cashierToken()
    const res = await request(buildApp()).get('/api/reports/secret').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/full sign-in/i)
  })

  it('cashier session CAN reach the register (list transactions)', async () => {
    const { token } = await cashierToken()
    const res = await request(buildApp()).get('/api/business-pos/transactions').set('Authorization', `Bearer ${token}`)
    // 200 = allowed through the gate AND the pos.use permission check passed.
    expect(res.status).toBe(200)
  })
})
