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
 *      ≥8 chars to match the invite-accept rule (S377).
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
  cleanupAllSchema, seedTenant,
} from '../test/dbHelpers'

import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
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

  it('newPassword < 8 chars → 400 (S380 fix)', async () => {
    const f = await seedTenantFixture()
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'correctOldPass123', newPassword: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least 8/i)
  })

  it('wrong currentPassword → 401; existing hash unchanged', async () => {
    const f = await seedTenantFixture()
    const before = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [f.tenantUserId])
    const res = await request(buildApp())
      .patch('/api/tenants/password')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ currentPassword: 'WRONG', newPassword: 'newGoodPass123' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/incorrect/i)
    const after = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`, [f.tenantUserId])
    expect(after.rows[0].password_hash).toBe(before.rows[0].password_hash)
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
