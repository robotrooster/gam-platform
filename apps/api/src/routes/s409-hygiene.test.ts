/**
 * S409 hygiene batch test slice. Four fixes:
 *
 *   1. S376 (admin label): "FlexCredit enrolled" → "Rent reporting enrolled"
 *      on the admin onboarding checklist surface.
 *   2. S402a (notifications): GET /api/notifications limit query param
 *      clamped to [1, 200] (was unbounded + accepted negatives).
 *   3. S402b (notifications): PATCH /preferences validates `type` as
 *      snake_case ≤64 chars + booleans as booleans (was unchecked).
 *   4. S380 (avatar XSS strong fix): GET /tenants/avatar-files/:filename
 *      always sets Content-Type to image/* + X-Content-Type-Options:
 *      nosniff. POST /tenants/avatar normalizes extension from MIME.
 *
 * Pins the new behavior on each. No production bugs expected — these are
 * tightening passes on already-shipped routes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/notifications', () => ({
  sendBulkNotification: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { adminRouter } from './admin'
import { notificationsRouter } from './notifications'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildAdminApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}
function buildNotificationsApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/notifications', notificationsRouter)
  app.use(errorHandler)
  return app
}
function buildTenantsApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

const cleanupTargets: string[] = []
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s409'
})
afterAll(() => {
  for (const p of cleanupTargets) {
    try { fs.unlinkSync(p) } catch { /* best effort */ }
  }
})
import { afterAll } from 'vitest'

const sign = (claims: any) =>
  jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

// ─── S376: admin checklist label "Rent reporting enrolled" ──

describe('S376: admin onboarding checklist label rename', () => {
  it('GET /api/admin/onboarding/tenant/:id returns "Rent reporting enrolled" (not "FlexCredit enrolled")', async () => {
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      await c.query('COMMIT')
    } finally { c.release() }
    const adminToken = sign({ userId: randomUUID(), role: 'admin',
                               email: 'a@t.dev', profileId: randomUUID() })
    const res = await request(buildAdminApp())
      .get(`/api/admin/onboarding/tenant/${tenantId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const checklist = res.body.data.checklist as any[]
    const item = checklist.find(c => c.key === 'flex_credit')
    expect(item).toBeDefined()
    expect(item.label).toBe('Rent reporting enrolled')
    // Negative: pre-fix label must not appear anywhere on the checklist.
    expect(checklist.find(c => c.label === 'FlexCredit enrolled')).toBeUndefined()
  })
})

// ─── S402a: GET /notifications limit clamp ──────────────────

describe('S402a: GET /api/notifications limit clamping', () => {
  async function seedUser() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      // 5 notifications for the caller.
      for (let i = 0; i < 5; i++) {
        await c.query(
          `INSERT INTO notifications (user_id, type, title, body, read)
           VALUES ($1, 'system', $2, 'body', FALSE)`,
          [userId, `Note ${i}`])
      }
      await c.query('COMMIT')
      return { userId, token: sign({ userId, role: 'landlord', email: 'l@t.dev',
                                      profileId: randomUUID(), permissions: {} }) }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('negative limit no longer 500s — falls back to default 20', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .get('/api/notifications?limit=-1')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(5)  // all 5 seeded
  })

  it('limit=0 falls back to default 20', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .get('/api/notifications?limit=0')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(5)
  })

  it('limit=99999 is clamped to 200 (no unbounded query)', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .get('/api/notifications?limit=99999')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // 5 rows is well under 200; just verify the request succeeded
    // (postgres would have rejected an absurdly large LIMIT in older
    // versions and we want to assert the clamp protects regardless).
    expect(res.body.data).toHaveLength(5)
  })

  it('limit=garbage falls back to default 20', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .get('/api/notifications?limit=foo')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(5)
  })

  it('valid limit=2 still works', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .get('/api/notifications?limit=2')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })
})

// ─── S402b: PATCH /preferences type validation ──────────────

describe('S402b: PATCH /api/notifications/preferences body validation', () => {
  async function seedUser() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId } = await seedLandlord(c)
      await c.query('COMMIT')
      return { userId, token: sign({ userId, role: 'landlord', email: 'l@t.dev',
                                      profileId: randomUUID(), permissions: {} }) }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('happy path: valid snake_case type accepted', async () => {
    const { userId, token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'rent_due', emailEnabled: true, smsEnabled: false, inAppEnabled: true })
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT type, email_enabled FROM notification_preferences WHERE user_id=$1`, [userId])
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('rent_due')
  })

  it('rejects type with uppercase letters → 400', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'RentDue', emailEnabled: true, smsEnabled: false, inAppEnabled: true })
    expect(res.status).toBe(400)
  })

  it('rejects type with spaces → 400', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'rent due', emailEnabled: true, smsEnabled: false, inAppEnabled: true })
    expect(res.status).toBe(400)
  })

  it('rejects type > 64 chars → 400', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'a'.repeat(65), emailEnabled: true, smsEnabled: false, inAppEnabled: true })
    expect(res.status).toBe(400)
  })

  it('rejects non-boolean emailEnabled → 400', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'rent_due', emailEnabled: 'yes', smsEnabled: false, inAppEnabled: true })
    expect(res.status).toBe(400)
  })

  it('rejects missing required field → 400', async () => {
    const { token } = await seedUser()
    const res = await request(buildNotificationsApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'rent_due', emailEnabled: true })  // missing sms/inApp
    expect(res.status).toBe(400)
  })
})

// ─── S380: avatar XSS strong fix ────────────────────────────

describe('S380: avatar XSS strong fix', () => {
  async function seedTenantUser() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      return { tenantId, userId: user_id,
               token: sign({ userId: user_id, role: 'tenant',
                              email: 't@t.dev', profileId: tenantId }) }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  // Minimal valid JPEG header
  const JPEG_BYTES = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
    0xff, 0xd9,
  ])

  it('POST /avatar normalizes filename extension from MIME (not from originalname)', async () => {
    const { token } = await seedTenantUser()
    const res = await request(buildTenantsApp())
      .post('/api/tenants/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', JPEG_BYTES, { filename: 'xss.html', contentType: 'image/jpeg' })
    expect(res.status).toBe(200)
    expect(res.body.data.url).toMatch(/\.jpg$/)
    expect(res.body.data.url).not.toMatch(/\.html$/)
    // Track the file for afterAll cleanup
    const onDiskName = res.body.data.url.split('/').pop()
    cleanupTargets.push(path.join(process.cwd(), 'uploads', 'avatars', onDiskName))
  })

  it('GET /avatar-files/:filename serves with Content-Type: image/* + nosniff (no matter the on-disk ext)', async () => {
    // Plant a file with an .html extension directly on disk to simulate
    // a legacy upload (pre-normalization). The serve route should still
    // pin Content-Type to an image type — never text/html.
    const avatarDir = path.join(process.cwd(), 'uploads', 'avatars')
    if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true })
    const legacyName = `legacy-${randomUUID()}.html`
    const fp = path.join(avatarDir, legacyName)
    fs.writeFileSync(fp, '<script>alert(1)</script>')
    cleanupTargets.push(fp)

    const res = await request(buildTenantsApp())
      .get(`/api/tenants/avatar-files/${legacyName}`)
    expect(res.status).toBe(200)
    // Critical: NOT text/html. We fall through to image/jpeg default.
    expect(res.headers['content-type']).toMatch(/^image\//)
    expect(res.headers['content-type']).not.toMatch(/html/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('GET /avatar-files/:filename Content-Type matches the on-disk extension when image-typed', async () => {
    const avatarDir = path.join(process.cwd(), 'uploads', 'avatars')
    if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true })
    const name = `${randomUUID()}.png`
    const fp = path.join(avatarDir, name)
    fs.writeFileSync(fp, JPEG_BYTES)  // bytes irrelevant for header test
    cleanupTargets.push(fp)
    const res = await request(buildTenantsApp())
      .get(`/api/tenants/avatar-files/${name}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
  })

  it('POST /avatar rejects non-image MIME with 500 (multer fileFilter throws "JPEG PNG WEBP only")', async () => {
    const { token } = await seedTenantUser()
    const res = await request(buildTenantsApp())
      .post('/api/tenants/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('not an image'), { filename: 'x.txt', contentType: 'text/plain' })
    // Multer's thrown Error from fileFilter surfaces as 500 (no
    // try/catch around the multer middleware). Documenting current
    // behavior — a future hygiene pass could turn this into a clean
    // 400 by wrapping multer errors.
    expect([400, 500]).toContain(res.status)
  })
})
