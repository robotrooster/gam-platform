/**
 * Login lockout — S280.
 *
 * 5 failed attempts in a row → 15-minute lockout. The gate runs
 * BEFORE bcrypt.compare so a correct password during the lockout
 * window stays denied. Successful login + password reset both clear
 * the counter and any lockout stamp.
 *
 * Schema: `users.failed_login_count int NOT NULL DEFAULT 0`,
 * `users.locked_until timestamptz` (S280 migration).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'

// Email sender is mocked everywhere else; keep parity here so
// nothing accidentally hits Resend during password-reset assertions.
const { sendResetMock } = vi.hoisted(() => ({
  sendResetMock: vi.fn(async () => 'msg_mock'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendPasswordResetEmail: sendResetMock }
})

import { authRouter, lockedSignInMessage } from './auth'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sendResetMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_login_lockout'
})

async function seedUser(email: string, password: string): Promise<string> {
  const hash = await bcrypt.hash(password, 12)
  const res = await db.query<{ id: string }>(
    // email_verified=TRUE — lockout suite tests the lockout gate
    // specifically; verification gate has its own suite.
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'tenant', 'Test', 'User', TRUE) RETURNING id`,
    [email, hash],
  )
  return res.rows[0].id
}

async function readLockoutState(userId: string): Promise<{
  failed_login_count: number
  locked_until: string | null
}> {
  const r = await db.query<{
    failed_login_count: number
    locked_until: string | null
  }>(
    `SELECT failed_login_count, locked_until::text FROM users WHERE id=$1`,
    [userId],
  )
  return r.rows[0]
}

async function attemptLogin(email: string, password: string) {
  return request(buildApp())
    .post('/api/auth/login')
    .send({ email, password })
}

describe('login lockout', () => {
  it('4 failures: counter bumps, account still unlocked', async () => {
    const id = await seedUser('a@test.dev', 'rightpass123')
    for (let i = 0; i < 4; i++) {
      const res = await attemptLogin('a@test.dev', 'wrongpass')
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Invalid credentials')
    }
    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(4)
    expect(state.locked_until).toBeNull()
  })

  it('5 failures: account locks (locked_until ~15min out)', async () => {
    const id = await seedUser('b@test.dev', 'rightpass123')
    for (let i = 0; i < 5; i++) {
      await attemptLogin('b@test.dev', 'wrongpass')
    }
    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(5)
    expect(state.locked_until).not.toBeNull()
    const lockMs = new Date(state.locked_until!).getTime() - Date.now()
    // Should be between 14 and 16 minutes from now.
    expect(lockMs).toBeGreaterThan(14 * 60_000)
    expect(lockMs).toBeLessThan(16 * 60_000)
  })

  it('correct password during lockout: still 401 with lockout message', async () => {
    const id = await seedUser('c@test.dev', 'rightpass123')
    for (let i = 0; i < 5; i++) {
      await attemptLogin('c@test.dev', 'wrongpass')
    }
    const res = await attemptLogin('c@test.dev', 'rightpass123')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/temporarily locked/i)
    // Final sweep (10/3): plain words, a clock time and the minutes left —
    // never a machine timestamp like 2026-10-03T20:11:27.596Z.
    expect(res.body.error).toMatch(
      /^Your account is temporarily locked after too many sign-in attempts\. Try again after \d{1,2}:\d{2} [AP]M \(in 1[45] minutes\), or reset your password\.$/)
    expect(res.body.error).not.toMatch(/\d{4}-\d{2}-\d{2}T|Z\b|UTC/)

    // Counter is unchanged on the gate path (we don't bump for
    // attempts during an active lockout; only ones that reach
    // bcrypt do).
    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(5)
  })

  it('expired lockout: correct password works AND counter resets to 0', async () => {
    const id = await seedUser('d@test.dev', 'rightpass123')
    for (let i = 0; i < 5; i++) {
      await attemptLogin('d@test.dev', 'wrongpass')
    }
    // Backdate the lockout stamp to simulate the 15-min window passing.
    await db.query(
      `UPDATE users SET locked_until = NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [id],
    )
    const res = await attemptLogin('d@test.dev', 'rightpass123')
    expect(res.status).toBe(200)
    // S571/S578: universal 2FA — a correct password past an expired lockout
    // proceeds to the emailed-code step. The failure counter still resets first
    // (that happens before the 2FA branch), which is what this test guards.
    expect(res.body.data.requiresEmailOtp).toBe(true)

    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(0)
    expect(state.locked_until).toBeNull()
  })

  it('intermediate success resets the counter (3 fails + 1 success)', async () => {
    const id = await seedUser('e@test.dev', 'rightpass123')
    for (let i = 0; i < 3; i++) {
      await attemptLogin('e@test.dev', 'wrongpass')
    }
    expect((await readLockoutState(id)).failed_login_count).toBe(3)

    const ok = await attemptLogin('e@test.dev', 'rightpass123')
    expect(ok.status).toBe(200)
    expect((await readLockoutState(id)).failed_login_count).toBe(0)
  })

  it('password reset clears lockout state', async () => {
    const id = await seedUser('f@test.dev', 'rightpass123')
    for (let i = 0; i < 5; i++) {
      await attemptLogin('f@test.dev', 'wrongpass')
    }
    expect((await readLockoutState(id)).locked_until).not.toBeNull()

    // Request + consume a reset.
    await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'f@test.dev' })
    const { rows: [{ reset_token }] } = await db.query<{ reset_token: string }>(
      `SELECT reset_token FROM users WHERE id=$1`, [id],
    )
    const reset = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token: reset_token, newPassword: 'newpass45678' })
    expect(reset.status).toBe(200)

    const state = await readLockoutState(id)
    expect(state.failed_login_count).toBe(0)
    expect(state.locked_until).toBeNull()

    // And the new password works immediately — no waiting out the
    // lockout window.
    const login = await attemptLogin('f@test.dev', 'newpass45678')
    expect(login.status).toBe(200)
  })

  it('unknown email: 401 (no enumeration); does not throw on missing locked_until', async () => {
    const res = await attemptLogin('ghost@nowhere.test', 'anything')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid credentials')
  })
})

// ── Final sweep (10/3): the lock is said in plain words, on the person's clock ──
//
// "Account temporarily locked. Try again after 2026-10-03T20:11:27.596Z" was a
// UTC machine timestamp, seven hours off for Arizona, on the sign-in page where
// most people meet a lock. It is now a clock time in the zone of the person's
// place (a tenant's lease's property, a landlord's company's property, else
// GAM's default), with the minutes left beside it.
describe('lockedSignInMessage', () => {
  // 20:11:27 UTC on Oct 3 is 1:11:27 PM in Arizona (no daylight saving).
  const lockedUntil = new Date('2026-10-03T20:11:27.596Z')
  const now = new Date('2026-10-03T19:56:27.596Z')   // 15 minutes before

  it('says the clock time on the given zone, rounded up to the minute, with the minutes left', () => {
    expect(lockedSignInMessage(lockedUntil, 'America/Phoenix', now)).toBe(
      'Your account is temporarily locked after too many sign-in attempts. '
      + 'Try again after 1:12 PM (in 15 minutes), or reset your password.')
  })

  it('a different zone, a different clock (New York is on daylight time in October)', () => {
    expect(lockedSignInMessage(lockedUntil, 'America/New_York', now)).toContain('Try again after 4:12 PM (in 15 minutes)')
  })

  it('under a minute left reads "in 1 minute", never "0 minutes"', () => {
    expect(lockedSignInMessage(lockedUntil, 'America/Phoenix', new Date(lockedUntil.getTime() - 20_000)))
      .toContain('Try again after 1:12 PM (in 1 minute), or reset your password.')
  })

  it('a time exactly on the minute is not pushed to the next one', () => {
    expect(lockedSignInMessage(new Date('2026-10-03T20:11:00.000Z'), 'America/Phoenix', now)).toContain('after 1:11 PM')
  })

  it('a zone the clock cannot read falls back to GAM\'s default rather than failing', () => {
    expect(lockedSignInMessage(lockedUntil, 'Not/AZone', now)).toContain('Try again after 1:12 PM')
  })

  it('plain spaces only (no narrow no-break space before PM)', () => {
    expect(lockedSignInMessage(lockedUntil, 'America/Phoenix', now)).not.toMatch(/[\u202f\u00a0]/)
  })
})

describe('login lock message: whose clock', () => {
  async function lockFor(userId: string): Promise<Date> {
    // 10m30s out, so the minutes read 11 both at the request and when the test checks.
    const until = new Date(Date.now() + 10 * 60_000 + 30_000)
    await db.query(`UPDATE users SET failed_login_count = 5, locked_until = $2 WHERE id = $1`, [userId, until])
    return until
  }
  async function setZone(propertyId: string, tz: string) {
    await db.query(`UPDATE properties SET timezone = $2, timezone_source = 'manual' WHERE id = $1`, [propertyId, tz])
  }

  it('a tenant hears their lease property\'s clock', async () => {
    const c = await db.connect()
    let tenantUserId = '', propertyId = '', email = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId, state: 'NY' })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId })
      const t = await c.query<any>(`SELECT u.id, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])
      tenantUserId = t.rows[0].id; email = t.rows[0].email
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await setZone(propertyId, 'America/New_York')
    const until = await lockFor(tenantUserId)

    const res = await attemptLogin(email, 'whatever-password')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe(lockedSignInMessage(until, 'America/New_York'))
    expect(res.body.error).toContain('(in 11 minutes), or reset your password.')
    // Really New York's clock, not the default's (three hours apart in October).
    expect(res.body.error).not.toBe(lockedSignInMessage(until, 'America/Phoenix'))
  })

  it('a landlord hears their company\'s property clock', async () => {
    const c = await db.connect()
    let userId = '', propertyId = '', email = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      userId = l.userId
      propertyId = await seedProperty(c, { landlordId: l.landlordId, ownerUserId: l.userId, managedByUserId: l.userId, state: 'IL' })
      email = (await c.query<any>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await setZone(propertyId, 'America/Chicago')
    const until = await lockFor(userId)

    const res = await attemptLogin(email, 'whatever-password')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe(lockedSignInMessage(until, 'America/Chicago'))
    expect(res.body.error).not.toBe(lockedSignInMessage(until, 'America/Phoenix'))
  })

  it('someone with no place yet hears GAM\'s default clock', async () => {
    const id = await seedUser('nowhere@test.dev', 'rightpass123')
    const until = await lockFor(id)
    const res = await attemptLogin('nowhere@test.dev', 'rightpass123')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe(lockedSignInMessage(until, 'America/Phoenix'))
  })

  // Workers (manager, onsite manager, maintenance, bookkeeper) are not company
  // members: their company comes only from their own scope row, so these fail
  // (Phoenix, the default) if the lock message stops reading the scope.
  async function companyWithProperty(tz: string): Promise<{ landlordId: string; propertyId: string }> {
    const c = await db.connect()
    let landlordId = '', propertyId = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      landlordId = l.landlordId
      propertyId = await seedProperty(c, { landlordId, ownerUserId: l.userId, managedByUserId: l.userId, state: 'IL' })
      // The company's first property, a day older than any added in the test.
      await c.query(`UPDATE properties SET created_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [propertyId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await setZone(propertyId, tz)
    return { landlordId, propertyId }
  }
  async function addProperty(landlordId: string, tz: string): Promise<string> {
    const c = await db.connect()
    let propertyId = ''
    try {
      const owner = (await c.query<any>(`SELECT user_id FROM landlords WHERE id = $1`, [landlordId])).rows[0].user_id
      propertyId = await seedProperty(c, { landlordId, ownerUserId: owner, managedByUserId: owner, state: 'NY' })
    } finally { c.release() }
    await setZone(propertyId, tz)
    return propertyId
  }
  async function seedWorker(role: 'property_manager' | 'onsite_manager' | 'maintenance' | 'bookkeeper',
                            landlordId: string, propertyIds: string[] | 'all'): Promise<{ id: string; email: string }> {
    const email = `${role}-${Math.random().toString(36).slice(2)}@test.dev`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', $2, 'Test', 'Worker', TRUE) RETURNING id`, [email, role])
    const all = propertyIds === 'all'
    const ids = all ? [] : propertyIds
    if (role === 'bookkeeper') {
      await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id) VALUES ($1, $2)`, [u.id, landlordId])
    } else {
      const table = { property_manager: 'property_manager_scopes', onsite_manager: 'onsite_manager_scopes',
                      maintenance: 'maintenance_worker_scopes' }[role]
      await db.query(`INSERT INTO ${table} (user_id, landlord_id, all_properties, property_ids) VALUES ($1, $2, $3, $4::uuid[])`,
        [u.id, landlordId, all, ids])
    }
    return { id: u.id, email }
  }

  it('a property manager on every property hears their company\'s property clock', async () => {
    const { landlordId } = await companyWithProperty('America/Chicago')
    const pm = await seedWorker('property_manager', landlordId, 'all')
    const until = await lockFor(pm.id)

    const res = await attemptLogin(pm.email, 'whatever-password')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe(lockedSignInMessage(until, 'America/Chicago'))
    expect(res.body.error).not.toBe(lockedSignInMessage(until, 'America/Phoenix'))
  })

  it.each(['onsite_manager', 'maintenance', 'bookkeeper'] as const)(
    'a %s hears their company\'s property clock (read from their own scope)', async (role) => {
      const { landlordId } = await companyWithProperty('America/Chicago')
      const w = await seedWorker(role, landlordId, 'all')
      const until = await lockFor(w.id)

      const res = await attemptLogin(w.email, 'whatever-password')
      expect(res.status).toBe(401)
      expect(res.body.error).toBe(lockedSignInMessage(until, 'America/Chicago'))
    })

  it('a manager kept to one property hears THAT property\'s clock, not the company\'s first', async () => {
    // The company's first property is in Chicago; the manager works only the New York one.
    const { landlordId } = await companyWithProperty('America/Chicago')
    const nyPropertyId = await addProperty(landlordId, 'America/New_York')
    const pm = await seedWorker('property_manager', landlordId, [nyPropertyId])
    const until = await lockFor(pm.id)

    const res = await attemptLogin(pm.email, 'whatever-password')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe(lockedSignInMessage(until, 'America/New_York'))
    expect(res.body.error).not.toBe(lockedSignInMessage(until, 'America/Chicago'))
  })

  it('a scope naming another company\'s property is ignored: the clock stays the company\'s', async () => {
    const { landlordId } = await companyWithProperty('America/Chicago')
    const other = await companyWithProperty('America/New_York')
    const pm = await seedWorker('property_manager', landlordId, [other.propertyId])
    const until = await lockFor(pm.id)

    const res = await attemptLogin(pm.email, 'whatever-password')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe(lockedSignInMessage(until, 'America/Chicago'))
  })
})
