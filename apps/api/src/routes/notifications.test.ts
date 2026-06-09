/**
 * notifications.ts gap-close slice — S402. Closes the file at 6/6 (100%).
 *
 * Covered routes (6):
 *   - GET   /api/notifications
 *   - PATCH /api/notifications/:id/read
 *   - PATCH /api/notifications/read-all
 *   - GET   /api/notifications/preferences
 *   - PATCH /api/notifications/preferences
 *   - POST  /api/notifications/bulk
 *
 * sendBulkNotification (services/notifications.ts) is mocked — the
 * service itself has its own coverage and writes to multiple tables +
 * sends email/SMS. Route-layer slice verifies (a) caller-scope
 * resolution, (b) propertyId uuid format gate, (c) title/body
 * required, (d) the resolved landlordId is passed through to the
 * service.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const sendBulkMock = vi.hoisted(() => vi.fn())
vi.mock('../services/notifications', () => ({
  sendBulkNotification: sendBulkMock,
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { notificationsRouter } from './notifications'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/notifications', notificationsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sendBulkMock.mockReset()
  sendBulkMock.mockResolvedValue({ sentTo: 3, emailSent: 0, smsSent: 0 })
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_notifications'
})

interface Fixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
  otherUserId:    string
  otherToken:     string
  noteA:          string
  noteB:          string
  noteOther:      string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const { userId: otherUserId } = await seedLandlord(c)
    // Three notifications: two for landlord, one for the other user.
    const { rows: [{ id: noteA }] } = await c.query<{ id: string }>(
      `INSERT INTO notifications (user_id, type, title, body, read)
       VALUES ($1, 'system', 'Note A', 'body A', FALSE) RETURNING id`,
      [landlordUserId])
    const { rows: [{ id: noteB }] } = await c.query<{ id: string }>(
      `INSERT INTO notifications (user_id, type, title, body, read)
       VALUES ($1, 'system', 'Note B', 'body B', FALSE) RETURNING id`,
      [landlordUserId])
    const { rows: [{ id: noteOther }] } = await c.query<{ id: string }>(
      `INSERT INTO notifications (user_id, type, title, body, read)
       VALUES ($1, 'system', 'Note Other', 'body other', FALSE) RETURNING id`,
      [otherUserId])
    await c.query('COMMIT')
    const sign = (claims: any) =>
      jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordUserId, landlordId,
      landlordToken: sign({
        userId: landlordUserId, role: 'landlord', email: 'll@t.dev',
        profileId: landlordId,
        permissions: { 'notifications.send_bulk': true },
      }),
      otherUserId,
      otherToken: sign({
        userId: otherUserId, role: 'landlord', email: 'other@t.dev',
        profileId: randomUUID(), permissions: {},
      }),
      noteA, noteB, noteOther,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── GET /api/notifications ──────────────────────────────────

describe('GET /api/notifications', () => {
  it('returns only the caller\'s notifications', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/notifications')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(n => n.id)
    expect(ids).toContain(f.noteA)
    expect(ids).toContain(f.noteB)
    expect(ids).not.toContain(f.noteOther)
    expect(res.body.unreadCount).toBe(2)
  })

  it('unread=true filters to unread only', async () => {
    const f = await seed()
    // Mark A as read.
    await db.query(
      `UPDATE notifications SET read=TRUE, read_at=NOW() WHERE id=$1`, [f.noteA])
    const res = await request(buildApp()).get('/api/notifications?unread=true')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(f.noteB)
    expect(res.body.unreadCount).toBe(1)
  })

  it('limit query param caps the result', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/notifications?limit=1')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    // unreadCount is the full count, not limited.
    expect(res.body.unreadCount).toBe(2)
  })

  it('unauthenticated → 401', async () => {
    await seed()
    const res = await request(buildApp()).get('/api/notifications')
    expect(res.status).toBe(401)
  })
})

// ─── PATCH /api/notifications/:id/read ──────────────────────

describe('PATCH /api/notifications/:id/read', () => {
  it('marks own notification as read', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/notifications/${f.noteA}/read`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    const { rows: [row] } = await db.query<any>(
      `SELECT read, read_at FROM notifications WHERE id=$1`, [f.noteA])
    expect(row.read).toBe(true)
    expect(row.read_at).toBeTruthy()
  })

  it('cannot mark another user\'s notification as read (silent no-op, row stays unread)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/notifications/${f.noteOther}/read`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    // Verify the other user's row was NOT touched.
    const { rows: [row] } = await db.query<any>(
      `SELECT read, read_at FROM notifications WHERE id=$1`, [f.noteOther])
    expect(row.read).toBe(false)
    expect(row.read_at).toBeNull()
  })
})

// ─── PATCH /api/notifications/read-all ──────────────────────

describe('PATCH /api/notifications/read-all', () => {
  it('marks all own unread as read; other users untouched', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT id, read FROM notifications WHERE user_id=$1`, [f.landlordUserId])
    expect(rows.every(r => r.read === true)).toBe(true)
    const { rows: [otherRow] } = await db.query<any>(
      `SELECT read FROM notifications WHERE id=$1`, [f.noteOther])
    expect(otherRow.read).toBe(false)
  })

  it('Express route order: PATCH /read-all is not swallowed by PATCH /:id/read', async () => {
    const f = await seed()
    // Pre-fix this would 404 or no-op as "/read-all" matched ":id" with id='read-all'.
    // Even though /:id/read is declared first, the path SHAPE differs (1 vs 2
    // segments) so this is a safety pin, not a regression cap.
    const res = await request(buildApp())
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
  })
})

// ─── GET /api/notifications/preferences ─────────────────────

describe('GET /api/notifications/preferences', () => {
  it('returns the caller\'s preference rows', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, sms_enabled, in_app_enabled)
       VALUES ($1, 'rent_due', TRUE, FALSE, TRUE)`,
      [f.landlordUserId])
    const res = await request(buildApp()).get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].type).toBe('rent_due')
    expect(res.body.data[0].email_enabled).toBe(true)
    expect(res.body.data[0].sms_enabled).toBe(false)
  })

  it('returns [] when caller has no preferences set', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('does not leak another user\'s preferences', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, sms_enabled, in_app_enabled)
       VALUES ($1, 'rent_due', TRUE, TRUE, TRUE)`,
      [f.otherUserId])
    const res = await request(buildApp()).get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

// ─── PATCH /api/notifications/preferences ───────────────────

describe('PATCH /api/notifications/preferences', () => {
  it('upsert: inserts new pref row on first call', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ type: 'rent_due', emailEnabled: false, smsEnabled: true, inAppEnabled: true })
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT email_enabled, sms_enabled, in_app_enabled FROM notification_preferences
        WHERE user_id=$1 AND type=$2`, [f.landlordUserId, 'rent_due'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email_enabled: false, sms_enabled: true, in_app_enabled: true,
    })
  })

  it('upsert: updates existing row on second call (ON CONFLICT)', async () => {
    const f = await seed()
    await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ type: 'rent_due', emailEnabled: true, smsEnabled: true, inAppEnabled: true })
    const res = await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ type: 'rent_due', emailEnabled: false, smsEnabled: false, inAppEnabled: false })
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT email_enabled, sms_enabled, in_app_enabled FROM notification_preferences
        WHERE user_id=$1 AND type=$2`, [f.landlordUserId, 'rent_due'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email_enabled: false, sms_enabled: false, in_app_enabled: false,
    })
  })
})

// ─── POST /api/notifications/bulk ───────────────────────────

describe('POST /api/notifications/bulk', () => {
  it('happy: forwards resolved landlordId to sendBulkNotification', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ title: 'Heads up', body: 'message body', sendEmail: false, sendSMS: false })
    expect(res.status).toBe(200)
    expect(sendBulkMock).toHaveBeenCalledTimes(1)
    expect(sendBulkMock).toHaveBeenCalledWith(expect.objectContaining({
      landlordId: f.landlordId,
      title: 'Heads up',
      body: 'message body',
    }))
  })

  it('happy: propertyId passed through when valid uuid', async () => {
    const f = await seed()
    const propId = randomUUID()
    const res = await request(buildApp()).post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ title: 'X', body: 'Y', propertyId: propId })
    expect(res.status).toBe(200)
    expect(sendBulkMock).toHaveBeenCalledWith(expect.objectContaining({
      propertyId: propId,
    }))
  })

  it('missing title → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ body: 'no title' })
    expect(res.status).toBe(400)
    expect(sendBulkMock).not.toHaveBeenCalled()
  })

  it('missing body → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ title: 'no body' })
    expect(res.status).toBe(400)
    expect(sendBulkMock).not.toHaveBeenCalled()
  })

  it('propertyId not a uuid → 400 (no SQL hits service)', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ title: 'T', body: 'B', propertyId: 'not-a-uuid' })
    expect(res.status).toBe(400)
    expect(sendBulkMock).not.toHaveBeenCalled()
  })

  it('non-owner role without notifications.send_bulk perm → 403', async () => {
    const f = await seed()
    // OWNER_ROLES (landlord/admin/super_admin) auto-pass requirePerm.
    // Use a property_manager without the perm to exercise the negative.
    const pmNoPerm = jwt.sign(
      { userId: randomUUID(), role: 'property_manager', email: 'pm@t.dev',
        profileId: randomUUID(), landlordId: f.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp()).post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${pmNoPerm}`)
      .send({ title: 'T', body: 'B' })
    expect(res.status).toBe(403)
    expect(sendBulkMock).not.toHaveBeenCalled()
  })

  it('caller with perm but no landlord scope → 400 No landlord scope', async () => {
    const f = await seed()
    // Tenant role with the perm somehow set — should fail at the scope
    // resolution step (resolveLandlordIdForUser returns null for tenant).
    const noScopeToken = jwt.sign(
      { userId: randomUUID(), role: 'tenant', email: 't@t.dev',
        profileId: randomUUID(),
        permissions: { 'notifications.send_bulk': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp()).post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${noScopeToken}`)
      .send({ title: 'T', body: 'B' })
    expect(res.status).toBe(400)
    expect(sendBulkMock).not.toHaveBeenCalled()
  })
})
