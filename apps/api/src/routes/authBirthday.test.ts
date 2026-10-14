/**
 * 10/13 (Nic): "landlords need a birthday on their profile" — for the
 * happy-birthday email (jobs/birthdayEmails.ts). A landlord sets, changes and
 * clears their OWN birthday through PATCH /api/auth/me and reads it back on
 * GET /api/auth/me; nobody else's, and no other kind of account.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

vi.mock('../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendEmailVerification: vi.fn(async () => 'msg'),
  sendPasswordResetEmail: vi.fn(async () => 'msg'),
}))

import { db } from '../db'
import { authRouter, ownBirthdayFrom } from './auth'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { await cleanupAllSchema() })

const tokenFor = (userId: string, role: string) => jwt.sign(
  { userId, role, email: 'x@y.dev', profileId: randomUUID() },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

async function landlord() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    await c.query('COMMIT')
    return { userId: ll.userId, token: tokenFor(ll.userId, 'landlord') }
  } finally { c.release() }
}

async function storedBirthday(userId: string): Promise<string | null> {
  const { rows: [r] } = await db.query<{ d: string | null }>(
    `SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS d FROM users WHERE id = $1`, [userId])
  return r.d
}

describe('a landlord\'s own birthday on PATCH/GET /api/auth/me', () => {
  it('sets it, returns it, and GET /me reads it back as the same calendar date', async () => {
    const me = await landlord()
    const res = await request(buildApp())
      .patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ dateOfBirth: '1979-10-14' })
    expect(res.status).toBe(200)
    expect(res.body.data.date_of_birth).toBe('1979-10-14')
    expect(await storedBirthday(me.userId)).toBe('1979-10-14')

    const got = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
    expect(got.status).toBe(200)
    expect(got.body.data.date_of_birth).toBe('1979-10-14')
  })

  it('a profile save that does not mention the birthday leaves it alone', async () => {
    const me = await landlord()
    await request(buildApp()).patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ dateOfBirth: '1979-10-14' })
    const res = await request(buildApp()).patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ firstName: 'Nic' })
    expect(res.status).toBe(200)
    expect(await storedBirthday(me.userId)).toBe('1979-10-14')
  })

  it('null (or an emptied box) clears it', async () => {
    const me = await landlord()
    await request(buildApp()).patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ dateOfBirth: '1979-10-14' })
    await request(buildApp()).patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ dateOfBirth: null })
    expect(await storedBirthday(me.userId)).toBeNull()

    await request(buildApp()).patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ dateOfBirth: '1979-10-14' })
    await request(buildApp()).patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ dateOfBirth: '' })
    expect(await storedBirthday(me.userId)).toBeNull()
  })

  it('refuses a date that is not real, not in the past, or before 1900 — and stores nothing', async () => {
    const me = await landlord()
    for (const bad of ['1979-02-30', '10/14/1979', 'tomorrow', '2999-01-01', '1850-06-01', 19791014]) {
      const res = await request(buildApp()).patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
        .send({ dateOfBirth: bad })
      expect(res.status).toBe(400)
    }
    expect(await storedBirthday(me.userId)).toBeNull()
  })

  it('only changes the caller\'s own row', async () => {
    const me = await landlord()
    const other = await landlord()
    await request(buildApp()).patch('/api/auth/me').set('Authorization', `Bearer ${me.token}`)
      .send({ dateOfBirth: '1979-10-14' })
    expect(await storedBirthday(other.userId)).toBeNull()
  })

  it('a tenant account cannot set one here — a tenant\'s birthday comes from their lease', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      const tenantId = await seedTenant(c)
      userId = (await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    } finally { c.release() }
    const res = await request(buildApp()).patch('/api/auth/me')
      .set('Authorization', `Bearer ${tokenFor(userId, 'tenant')}`)
      .send({ dateOfBirth: '1990-01-01' })
    expect(res.status).toBe(403)
    expect(await storedBirthday(userId)).toBeNull()
  })
})

describe('ownBirthdayFrom', () => {
  it('absent → not given', () => {
    expect(ownBirthdayFrom({ firstName: 'x' }, 'landlord')).toEqual({ given: false, value: null })
    expect(ownBirthdayFrom(undefined, 'tenant')).toEqual({ given: false, value: null })
  })
  it('a leap day is a real date in a leap year only', () => {
    expect(ownBirthdayFrom({ dateOfBirth: '1988-02-29' }, 'landlord')).toEqual({ given: true, value: '1988-02-29' })
    expect(() => ownBirthdayFrom({ dateOfBirth: '1987-02-29' }, 'landlord')).toThrow()
  })
  it('"in the past" is by Phoenix\'s calendar: today is refused even after UTC has turned over', () => {
    // 2026-10-14 05:00 UTC is still 10:00 pm on the 13th in Phoenix.
    const phoenixEvening = new Date('2026-10-14T05:00:00Z')
    expect(() => ownBirthdayFrom({ dateOfBirth: '2026-10-13' }, 'landlord', phoenixEvening)).toThrow(/not a date in the past/)
    expect(ownBirthdayFrom({ dateOfBirth: '2026-10-12' }, 'landlord', phoenixEvening))
      .toEqual({ given: true, value: '2026-10-12' })
  })
})
