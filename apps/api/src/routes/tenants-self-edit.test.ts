/**
 * tenants.ts self-edit slice — S380 (tenants.ts slice 7 of N).
 *
 * Covered routes (4):
 *   - PATCH /api/tenants/profile — phone/email/bio/theme/font
 *   - POST  /api/tenants/avatar — multer upload (5MB cap, JPEG/PNG/WEBP)
 *   - GET   /api/tenants/avatar-files/:filename — static serve
 *   - PATCH /api/tenants/password — bcrypt verify + replace
 *
 * Slices 1–6 covered 32 of 40 tenants.ts routes (~80%).
 * After this slice: 36 of 40 (~90%).
 *
 * Production bugs fixed in this slice:
 *   1. Path traversal in /avatar-files/:filename — path.join with
 *      raw param + res.sendFile served any reachable file. Fixed
 *      with path.basename() to strip directory components.
 *   2. Missing newPassword length validation on PATCH /password —
 *      route accepted empty/single-char passwords. Now enforces
 *      PASSWORD_MIN_LEN (12, S631) like every other password door
 *      (S655 final sweep; it was 8 until then).
 *
 * Out of slice (next session — closes the arc): work-trade,
 *   charge-account.
 */

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'fs'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedTenant, seedLandlord, seedManager,
} from '../test/dbHelpers'
import { PASSWORD_MIN_LEN } from '@gam/shared'

import { tenantsRouter } from './tenants'
import { authRouter } from './auth'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/auth', authRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

// Minimal JPEG header bytes — multer only reads .mimetype from the
// upload form, but real bytes mean the saved file is at least
// vaguely valid.
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

const traversalCleanupTargets: string[] = []

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_self_edit'
})

afterAll(() => {
  for (const p of traversalCleanupTargets) {
    try { fs.unlinkSync(p) } catch { /* best effort */ }
  }
})

async function seedTenantFixture(): Promise<{
  tenantId: string; tenantUserId: string; token: string;
}> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    // Set a known password hash on the user so PATCH /password tests
    // can exercise the bcrypt.compare path with a real password.
    const initialHash = await bcrypt.hash('correctOldPass123', 10)
    await client.query(
      `UPDATE users SET password_hash=$1 WHERE id=$2`,
      [initialHash, tu.rows[0].user_id])
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev',
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { tenantId, tenantUserId: tu.rows[0].user_id, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('PATCH /profile', () => {
  it('updates users.phone + users.email AND tenants.bio + theme + font', async () => {
    const f = await seedTenantFixture()
    const newEmail = `updated-${randomUUID()}@test.dev`
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ phone: '5550199', email: newEmail,
              bio: 'hi there', themeAccent: 'blue', fontStyle: 'serif' })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const u = await db.query<{ phone: string; email: string }>(
      `SELECT phone, email FROM users WHERE id=$1`, [f.tenantUserId])
    expect(u.rows[0].phone).toBe('5550199')
    expect(u.rows[0].email).toBe(newEmail)
    const t = await db.query<{ bio: string; theme_accent: string; font_style: string }>(
      `SELECT bio, theme_accent, font_style FROM tenants WHERE id=$1`, [f.tenantId])
    expect(t.rows[0].bio).toBe('hi there')
    expect(t.rows[0].theme_accent).toBe('blue')
    expect(t.rows[0].font_style).toBe('serif')
  })

  it('null phone + empty bio/theme/font normalize to NULL', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/profile')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: `n-${randomUUID()}@test.dev` })
    expect(res.status).toBe(200)
    const u = await db.query<{ phone: string | null }>(
      `SELECT phone FROM users WHERE id=$1`, [f.tenantUserId])
    expect(u.rows[0].phone).toBeNull()
    const t = await db.query<{ bio: string | null; theme_accent: string | null; font_style: string | null }>(
      `SELECT bio, theme_accent, font_style FROM tenants WHERE id=$1`, [f.tenantId])
    expect(t.rows[0].bio).toBeNull()
    expect(t.rows[0].theme_accent).toBeNull()
    expect(t.rows[0].font_style).toBeNull()
  })
})

describe('POST /avatar — multer upload', () => {
  it('no file attached → 400 No file', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .post('/api/tenants/avatar')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no file/i)
  })

  it('happy: JPEG saved + tenants.avatar_url updated', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .post('/api/tenants/avatar')
      .set('Authorization', `Bearer ${f.token}`)
      .attach('file', JPEG_HEADER, { filename: 'avatar.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(200)
    expect(res.body.data.url).toMatch(/^\/api\/tenants\/avatar-files\/\d+-[0-9a-f]+\.jpg$/)

    const t = await db.query<{ avatar_url: string }>(
      `SELECT avatar_url FROM tenants WHERE id=$1`, [f.tenantId])
    expect(t.rows[0].avatar_url).toBe(res.body.data.url)

    // Confirm the file actually landed on disk so future GETs work.
    const filename = res.body.data.url.split('/').pop()!
    const avatarDir = path.join(process.cwd(), 'uploads', 'avatars')
    const fp = path.join(avatarDir, filename)
    expect(fs.existsSync(fp)).toBe(true)
    traversalCleanupTargets.push(fp)
  })

  it('non-image MIME rejected by fileFilter', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .post('/api/tenants/avatar')
      .set('Authorization', `Bearer ${f.token}`)
      .attach('file', Buffer.from('not an image'),
        { filename: 'evil.exe', contentType: 'application/octet-stream' })
    // Multer rejects the file → next(error) → errorHandler converts.
    // The exact status depends on errorHandler shape, but it MUST
    // NOT be 200 and the file MUST NOT be saved to tenants.avatar_url.
    expect(res.status).not.toBe(200)
    const t = await db.query<{ avatar_url: string | null }>(
      `SELECT avatar_url FROM tenants WHERE id=$1`, [f.tenantId])
    expect(t.rows[0].avatar_url).toBeNull()
  })
})

describe('GET /avatar-files/:filename', () => {
  it('non-existent filename → 404', async () => {
    const res = await request(buildApp())
      .get('/api/tenants/avatar-files/does-not-exist-S380.jpg')
    expect(res.status).toBe(404)
  })

  it('happy: serves the file bytes', async () => {
    const avatarDir = path.join(process.cwd(), 'uploads', 'avatars')
    if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true })
    const filename = `test-S380-${randomUUID()}.jpg`
    const fp = path.join(avatarDir, filename)
    fs.writeFileSync(fp, JPEG_HEADER)
    traversalCleanupTargets.push(fp)

    const res = await request(buildApp())
      .get(`/api/tenants/avatar-files/${filename}`)
    expect(res.status).toBe(200)
    expect(Buffer.from(res.body)).toEqual(JPEG_HEADER)
  })

  it('path traversal attempt → 404 (basename strips ../ segments)', async () => {
    // Pre-fix: path.join(avatarDir, '../../uploads/secret-S380.txt')
    // would resolve to /…/uploads/secret-S380.txt and res.sendFile
    // would serve it. Post-fix: path.basename('../../uploads/secret-S380.txt')
    // = 'secret-S380.txt'; path.join(avatarDir, 'secret-S380.txt')
    // doesn't exist; 404.
    const uploadsDir = path.join(process.cwd(), 'uploads')
    const secretName = `secret-S380-${randomUUID()}.txt`
    const secretFp = path.join(uploadsDir, secretName)
    fs.writeFileSync(secretFp, 'SHOULD-NOT-BE-SERVED')
    traversalCleanupTargets.push(secretFp)

    const res = await request(buildApp())
      .get(`/api/tenants/avatar-files/${encodeURIComponent('../' + secretName)}`)
    expect(res.status).toBe(404)
    // Defense-in-depth: even if the route returned 200, the body
    // must not contain the secret contents.
    expect(res.text || '').not.toContain('SHOULD-NOT-BE-SERVED')
  })
})

describe('PATCH /password', () => {
  it('missing currentPassword or newPassword → 400', async () => {
    const f = await seedTenantFixture()
    const r1 = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ newPassword: 'a-valid-password-string' })
    expect(r1.status).toBe(400)
    expect(r1.body.error).toMatch(/required/i)
    const r2 = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123' })
    expect(r2.status).toBe(400)
  })

  it('a new password shorter than PASSWORD_MIN_LEN (12) → 400, the same minimum as every other password door', async () => {
    expect(PASSWORD_MIN_LEN).toBe(12)
    const f = await seedTenantFixture()
    const before = (await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [f.tenantUserId])).rows[0]
    for (const tooShort of ['short', 'elevenChars']) {
      expect(tooShort.length).toBeLessThan(PASSWORD_MIN_LEN)
      const res = await request(buildApp())
        .patch('/api/tenants/password')
        .set('Authorization', `Bearer ${f.token}`)
        .send({ currentPassword: 'correctOldPass123', newPassword: tooShort })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('New password must be at least 12 characters')
      expect(res.body.data?.token).toBeUndefined()
    }
    const after = (await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [f.tenantUserId])).rows[0]
    expect(after.password_hash).toBe(before.password_hash)

    // Exactly the minimum is accepted.
    const ok = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'twelveChars!' })
    expect('twelveChars!'.length).toBe(PASSWORD_MIN_LEN)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it('wrong currentPassword → 400 (never 401, which portals read as "session ended"); hash and sessions unchanged', async () => {
    const f = await seedTenantFixture()
    const before = await db.query<{ password_hash: string; sessions_valid_from: Date | null }>(
      `SELECT password_hash, sessions_valid_from FROM users WHERE id=$1`, [f.tenantUserId])
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'WRONG', newPassword: 'newGoodPass123' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/incorrect/i)
    expect(res.body.error).toMatch(/try again/i)
    expect(res.body.data?.token).toBeUndefined()
    const after = await db.query<{ password_hash: string; sessions_valid_from: Date | null }>(
      `SELECT password_hash, sessions_valid_from FROM users WHERE id=$1`, [f.tenantUserId])
    expect(after.rows[0].password_hash).toBe(before.rows[0].password_hash)
    expect(after.rows[0].sessions_valid_from).toEqual(before.rows[0].sessions_valid_from)
    // The pass that asked still works.
    const me = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${f.token}`)
    expect(me.status).toBe(200)
  })

  it('a non-text currentPassword → 400, not a crash', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: { $ne: '' }, newPassword: 'newGoodPass123' })
    expect(res.status).toBe(400)
  })

  it('happy: hash replaced; bcrypt-compare of newPassword succeeds', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(res.status).toBe(200)
    const u = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [f.tenantUserId])
    expect(await bcrypt.compare('brandNewPass456', u.rows[0].password_hash)).toBe(true)
    expect(await bcrypt.compare('correctOldPass123', u.rows[0].password_hash)).toBe(false)
  })
})

// ── A tenant changing their own password stays signed in ──────────────────
//
// A password change ends every session minted before it. It used to end the
// tenant's own as well: the stamp was NOW() and the reply carried no new pass,
// so their next /auth/me or /auth/refresh refused the pass they had just used.
// The stamp is now a whole second and the reply carries a fresh pass minted
// after it; every OTHER device is still signed out.
describe('PATCH /password keeps the tenant signed in and signs out every other device', () => {
  const passAt = (f: { tenantId: string; tenantUserId: string }, iat: number, extra: Record<string, unknown> = {}) =>
    jwt.sign({ userId: f.tenantUserId, role: 'tenant', email: 't@test.dev', profileId: f.tenantId,
               permissions: {}, iat, ...extra }, process.env.JWT_SECRET!, { expiresIn: '1h' })

  it('returns a fresh pass that /auth/me and /auth/refresh accept; a pass from before the change is refused', async () => {
    const f = await seedTenantFixture()
    // Another device signed in a minute ago.
    const otherDevice = passAt(f, Math.floor(Date.now() / 1000) - 60)
    expect((await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${otherDevice}`)).status).toBe(200)

    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${otherDevice}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const fresh = res.body.data?.token
    expect(typeof fresh).toBe('string')

    const decoded = jwt.decode(fresh) as any
    expect(decoded).toMatchObject({ userId: f.tenantUserId, role: 'tenant', profileId: f.tenantId, sp: 'rolling' })
    expect(decoded.purpose).toBeUndefined()

    const me = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${fresh}`)
    expect(me.status, JSON.stringify(me.body)).toBe(200)
    const renewed = await request(buildApp()).post('/api/auth/refresh').set('Authorization', `Bearer ${fresh}`)
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200)

    const old = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${otherDevice}`)
    expect(old.status).toBe(401)
    // 10/5: requireAuth refuses the old pass on every route now, in its own words.
    expect(old.body.error).toMatch(/sign in again/i)
    const oldRefresh = await request(buildApp()).post('/api/auth/refresh').set('Authorization', `Bearer ${otherDevice}`)
    expect(oldRefresh.status).toBe(401)
  })

  it('stamps the change at a whole second, never after the fresh pass', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(res.status).toBe(200)
    const row = (await db.query<{ sessions_valid_from: Date; frac: string }>(
      `SELECT sessions_valid_from,
              (EXTRACT(EPOCH FROM sessions_valid_from) - floor(EXTRACT(EPOCH FROM sessions_valid_from)))::text AS frac
         FROM users WHERE id=$1`, [f.tenantUserId])).rows[0]
    expect(Number(row.frac)).toBe(0)
    const iat = (jwt.decode(res.body.data.token) as any).iat as number
    expect(iat * 1000).toBeGreaterThanOrEqual(new Date(row.sessions_valid_from).getTime())
  })

  it('a second change from the fresh pass works too (the tenant is never locked out of changing again)', async () => {
    const f = await seedTenantFixture()
    const first = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(first.status).toBe(200)
    const second = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${first.body.data.token}`)
      .send({ currentPassword: 'brandNewPass456', newPassword: 'thirdPassword789' })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    const me = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${second.body.data.token}`)
    expect(me.status).toBe(200)
  })

  it('a pass an EARLIER change already ended cannot change the password or get a new pass', async () => {
    // It would otherwise trade a known password for a fresh full pass with no
    // emailed code — the same rule /auth/refresh applies.
    const f = await seedTenantFixture()
    const stale = passAt(f, Math.floor(Date.now() / 1000) - 120)
    await db.query(`UPDATE users SET sessions_valid_from = NOW() - INTERVAL '30 seconds' WHERE id=$1`, [f.tenantUserId])
    const before = (await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [f.tenantUserId])).rows[0]

    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${stale}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(res.status).toBe(401)
    expect(res.body.data?.token).toBeUndefined()
    const after = (await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [f.tenantUserId])).rows[0]
    expect(after.password_hash).toBe(before.password_hash)
  })

  it('a fixed-length pass stays fixed: the fresh pass ends when the old one would have', async () => {
    const f = await seedTenantFixture()
    const exp = Math.floor(Date.now() / 1000) + 3600
    const fixed = jwt.sign({ userId: f.tenantUserId, role: 'tenant', email: 't@test.dev', profileId: f.tenantId,
                             permissions: {}, sp: 'fixed', exp }, process.env.JWT_SECRET!)
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${fixed}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(res.status).toBe(200)
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.sp).toBe('fixed')
    expect(decoded.exp).toBe(exp)
  })
})


// ── S655 final sweep: only a tenant gets a pass back ───────────────────────
//
// The route is open to every signed-in role. It used to mint the fresh pass
// from the asking pass's own claims, so a team member whose access the landlord
// had pulled (scope row deleted — /auth/refresh answers 403 "deactivated")
// could trade their own password for a fresh seven days still carrying the
// pulled permissions, and repeat it every week to stay in forever. Now only a
// tenant gets a pass, built from the database; everyone else changes the
// password and gets none, as before. A locked account is refused outright.
describe('PATCH /password mints a pass for a tenant only', () => {
  const DAY = 24 * 3600

  async function seedWorker(opts: { withScope: boolean }) {
    const client = await db.connect()
    try {
      const { landlordId } = await seedLandlord(client)
      const userId = await seedManager(client)
      await client.query(`UPDATE users SET password_hash=$1 WHERE id=$2`,
        [await bcrypt.hash('workerPass12345', 10), userId])
      if (opts.withScope) {
        await client.query(
          `INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, permissions)
           VALUES ($1, $2, TRUE, '{"tenants.create": true}'::jsonb)`, [userId, landlordId])
      }
      // A rolling pass signed in six days ago — one day left on it.
      const iat = Math.floor(Date.now() / 1000) - 6 * DAY
      const exp = iat + 7 * DAY
      const pass = jwt.sign(
        { userId, role: 'property_manager', email: 'm@test.dev', profileId: landlordId, landlordId,
          permissions: { 'tenants.create': true }, sp: 'rolling', iat, exp },
        process.env.JWT_SECRET!)
      return { userId, landlordId, pass, exp }
    } finally { client.release() }
  }

  it('a team member whose access was pulled changes the password but gets NO pass; the old pass cannot be renewed or used to try again', async () => {
    const w = await seedWorker({ withScope: true })
    const app = buildApp()
    // The landlord pulls their access (DELETE /api/scopes/:roleType/:userId).
    await db.query(`DELETE FROM property_manager_scopes WHERE user_id=$1`, [w.userId])
    const refused = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${w.pass}`)
    expect(refused.status).toBe(403)

    const res = await request(app)
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${w.pass}`)
      .send({ currentPassword: 'workerPass12345', newPassword: 'workerPass67890' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(JSON.stringify(res.body)).not.toMatch(/token/i)

    // The password did change.
    const row = (await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [w.userId])).rows[0]
    expect(await bcrypt.compare('workerPass67890', row.password_hash)).toBe(true)

    // Nothing can stretch the old pass past its original end: it predates the
    // change now, so renewal is refused, and it cannot ask for another change.
    expect((jwt.decode(w.pass) as any).exp).toBe(w.exp)
    const renew = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${w.pass}`)
    expect(renew.status).not.toBe(200)
    expect(renew.body.data?.token).toBeUndefined()
    const again = await request(app)
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${w.pass}`)
      .send({ currentPassword: 'workerPass67890', newPassword: 'workerPass24680' })
    expect(again.status).toBe(401)
    expect(again.body.data?.token).toBeUndefined()
  })

  it('a team member in good standing also gets no pass (staff renew through /auth/refresh only)', async () => {
    const w = await seedWorker({ withScope: true })
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${w.pass}`)
      .send({ currentPassword: 'workerPass12345', newPassword: 'workerPass67890' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ success: true })
  })

  it('a landlord changes the password and gets no pass', async () => {
    const client = await db.connect()
    let userId = '', landlordId = ''
    try {
      ;({ userId, landlordId } = await seedLandlord(client))
      await client.query(`UPDATE users SET password_hash=$1 WHERE id=$2`,
        [await bcrypt.hash('landlordPass123', 10), userId])
    } finally { client.release() }
    const pass = jwt.sign({ userId, role: 'landlord', email: 'l@test.dev', profileId: null, landlordIds: [landlordId] },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${pass}`)
      .send({ currentPassword: 'landlordPass123', newPassword: 'landlordPass456' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ success: true })
    const row = (await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [userId])).rows[0]
    expect(await bcrypt.compare('landlordPass456', row.password_hash)).toBe(true)
  })

  it('a pass that still says tenant, for an account that is no longer a tenant, gets no pass', async () => {
    const f = await seedTenantFixture()
    await db.query(`UPDATE users SET role='property_manager' WHERE id=$1`, [f.tenantUserId])
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data?.token).toBeUndefined()
  })

  it("the tenant's fresh pass is built from the database, never copied from the asking pass", async () => {
    const f = await seedTenantFixture()
    const dbEmail = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [f.tenantUserId])).rows[0].email
    const asking = jwt.sign(
      { userId: f.tenantUserId, role: 'tenant', email: 'stale@test.dev', profileId: 'not-the-tenant-row',
        landlordId: 'some-landlord', permissions: { 'tenants.create': true }, extra: 'x' },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${asking}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const d = jwt.decode(res.body.data.token) as any
    expect(d).toMatchObject({
      userId: f.tenantUserId, role: 'tenant', email: dbEmail, profileId: f.tenantId,
      landlordId: null, landlordIds: null, businessId: null, staffRole: null, permissions: null,
      sp: 'rolling',
    })
    expect(d.extra).toBeUndefined()
  })

  it('a locked account is refused with 401: no pass, password and sessions unchanged', async () => {
    const f = await seedTenantFixture()
    // Nine and a half minutes left reads as "10 minutes" (whole minutes, rounded up).
    await db.query(`UPDATE users SET locked_until = NOW() + INTERVAL '9 minutes 30 seconds' WHERE id=$1`, [f.tenantUserId])
    const before = (await db.query<{ password_hash: string; sessions_valid_from: Date | null }>(
      `SELECT password_hash, sessions_valid_from FROM users WHERE id=$1`, [f.tenantUserId])).rows[0]
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/temporarily locked/i)
    expect(res.body.error).toMatch(/reset your password/i)
    // The pass still works, so the sentence says how long and never tells a
    // signed-in tenant to "sign in again".
    expect(res.body.error).toBe(
      'Your account is temporarily locked after too many sign-in attempts. ' +
      'Try again in 10 minutes, or reset your password from the sign-in page.')
    expect(res.body.error).not.toMatch(/sign in again/i)
    expect(res.body.data?.token).toBeUndefined()
    const after = (await db.query<{ password_hash: string; sessions_valid_from: Date | null }>(
      `SELECT password_hash, sessions_valid_from FROM users WHERE id=$1`, [f.tenantUserId])).rows[0]
    expect(after.password_hash).toBe(before.password_hash)
    expect(after.sessions_valid_from).toEqual(before.sessions_valid_from)

    // A lock that has run out does not get in the way.
    await db.query(`UPDATE users SET locked_until = NOW() - INTERVAL '1 minute' WHERE id=$1`, [f.tenantUserId])
    const ok = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'brandNewPass456' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(typeof ok.body.data?.token).toBe('string')
  })
})
