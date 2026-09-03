/**
 * S637 — the admin's Send Email screen.
 *
 * Nic: "let's add a way in the administrative portal for an admin to send
 * email to onboarded landlords, tenants, etcetera, all coming from support at
 * gold asset management dot com... we can have generic drafted ones that are
 * preloaded... and then I can also just compose an actual one if I need to."
 *
 * The rules worth holding: only admins, only to people who actually have a GAM
 * account, from support@, and signed by whoever pressed send.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'

const { supportMock } = vi.hoisted(() => ({ supportMock: vi.fn(async () => 'msg_mock') }))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSupportMessage: supportMock,
}))

import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_adminemail'
const sign = (p: object) => { process.env.JWT_SECRET = SECRET; return jwt.sign(p, SECRET, { expiresIn: '1h' }) }

let adminToken: string, landlordEmail: string, tenantEmail: string

beforeEach(async () => {
  await cleanupAllSchema()
  supportMock.mockClear()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    const { rows: [lu] } = await c.query<{ email: string }>(
      `UPDATE users SET first_name='Nancy', last_name='Sheptock' WHERE id=$1 RETURNING email`, [l.userId])
    landlordEmail = lu.email
    const tId = await seedTenant(c)
    const { rows: [tu] } = await c.query<{ email: string }>(
      `SELECT u.email FROM tenants t JOIN users u ON u.id=t.user_id WHERE t.id=$1`, [tId])
    tenantEmail = tu.email
    const { rows: [a] } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','admin','Nic','Rhoades',TRUE) RETURNING id`, [`adm-${randomUUID()}@t.dev`])
    await c.query('COMMIT')
    adminToken = sign({ userId: a.id, role: 'admin', email: 'adm@t.dev', profileId: null, permissions: {} })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const send = (body: any, token = adminToken) =>
  request(buildApp()).post('/api/admin/email/send')
    .set('Authorization', `Bearer ${token}`).send(body)

describe('GET /admin/email/templates', () => {
  it('offers drafts including a blank one to write from scratch', async () => {
    const res = await request(buildApp()).get('/api/admin/email/templates')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(1)
    expect(res.body.data.map((t: any) => t.id)).toContain('blank')
    expect(res.body.data.map((t: any) => t.id)).toContain('ach_failed')
  })
})

describe('GET /admin/email/recipients', () => {
  it('finds a landlord by name', async () => {
    const res = await request(buildApp()).get('/api/admin/email/recipients?q=Sheptock')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].kind).toBe('landlord')
    expect(res.body.data[0].email).toBe(landlordEmail)
  })

  it('stays quiet on a one-character query — this is search, not an export', async () => {
    const res = await request(buildApp()).get('/api/admin/email/recipients?q=a')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.body.data).toEqual([])
  })
})

describe('POST /admin/email/send', () => {
  it('sends to a landlord, signed by the admin who pressed send', async () => {
    const res = await send({ to: landlordEmail, subject: 'Following up', paragraphs: ['Hi Nancy,', 'Checking in.'] })
    expect(res.status).toBe(200)
    expect(supportMock).toHaveBeenCalledTimes(1)
    const arg = (supportMock.mock.calls.at(-1) as any[])[0]
    expect(arg.to).toBe(landlordEmail)
    expect(arg.signature).toBe('Nic Rhoades')
  })

  it('sends to a tenant too', async () => {
    const res = await send({ to: tenantEmail, subject: 'Your lease', paragraphs: ['Hi,'] })
    expect(res.status).toBe(200)
  })

  it('REFUSES an address with no GAM account — the domain is not a megaphone', async () => {
    const res = await send({ to: 'stranger@nowhere.example', subject: 'Hi', paragraphs: ['Hi'] })
    expect(res.status).toBe(404)
    expect(supportMock).not.toHaveBeenCalled()
  })

  it('refuses an empty body even when the paragraphs array is not', async () => {
    const res = await send({ to: landlordEmail, subject: 'Hi', paragraphs: ['   ', ''] })
    expect(res.status).toBe(400)
    expect(supportMock).not.toHaveBeenCalled()
  })

  it('refuses a non-admin', async () => {
    const tenantTok = sign({ userId: randomUUID(), role: 'tenant', email: 't@t.dev', profileId: null, permissions: {} })
    const res = await send({ to: landlordEmail, subject: 'Hi', paragraphs: ['Hi'] }, tenantTok)
    expect([401, 403]).toContain(res.status)
    expect(supportMock).not.toHaveBeenCalled()
  })

  it('records who sent what to whom', async () => {
    await send({ to: landlordEmail, subject: 'Following up', paragraphs: ['Hi'], templateId: 'landlord_never_started' })
    const { rows } = await db.query<any>(
      `SELECT action, new_value FROM audit_log WHERE action='admin_email_sent'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].new_value.to).toBe(landlordEmail)
    expect(rows[0].new_value.template_id).toBe('landlord_never_started')
  })
})

// ── S637: THE LOG IS THE LOG ──────────────────────────────────────────
//
// Nic (DIRECTIVE): "We should keep a log of any emails sent, with no way to
// be deleted by any super admin, even me. The log is the log. Any
// conversations with landlords through that email chain, or reaching out to
// these ghost landlords that signed up and did nothing — we should be
// tracking our reach out attempts."
//
// Two things had to change for that to be true: the log held no BODY, and a
// daily prune deleted it at 90 days. These hold both, plus the DB triggers
// that make a delete impossible through the application by any role.
describe('the email log is permanent', () => {
  const seedLog = (email: string, category: string, extra: Record<string, any> = {}) =>
    db.query(
      `INSERT INTO email_send_log (to_email, subject, category, status, body_text, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [email, extra.subject ?? 'Following up', category, extra.status ?? 'sent',
       extra.body ?? 'Hi there,\n\nChecking in.',
       extra.createdAt ?? new Date().toISOString()])

  it('refuses to delete correspondence — even raw SQL as the app role', async () => {
    await seedLog('ghost@mailer-test.co', 'support_message')
    await expect(
      db.query(`DELETE FROM email_send_log WHERE to_email='ghost@mailer-test.co'`)
    ).rejects.toThrow(/cannot be deleted/)
  })

  it('refuses to delete the automatic welcome outreach either', async () => {
    await seedLog('ghost2@mailer-test.co', 'landlord_welcome_outreach')
    await expect(
      db.query(`DELETE FROM email_send_log WHERE to_email='ghost2@mailer-test.co'`)
    ).rejects.toThrow(/cannot be deleted/)
  })

  it('still lets machine chatter be pruned — that is what the prune is for', async () => {
    await seedLog('code@mailer-test.co', 'login_2fa_code')
    await db.query(`DELETE FROM email_send_log WHERE to_email='code@mailer-test.co'`)
    const { rows } = await db.query<any>(
      `SELECT 1 FROM email_send_log WHERE to_email='code@mailer-test.co'`)
    expect(rows).toHaveLength(0)
  })

  it('freezes what was said — the body cannot be rewritten after the fact', async () => {
    await seedLog('frozen@mailer-test.co', 'support_message')
    await expect(
      db.query(`UPDATE email_send_log SET body_text='something else' WHERE to_email='frozen@mailer-test.co'`)
    ).rejects.toThrow(/frozen/)
    await expect(
      db.query(`UPDATE email_send_log SET subject='different' WHERE to_email='frozen@mailer-test.co'`)
    ).rejects.toThrow(/frozen/)
  })

  it('still accepts delivery events from the provider webhook', async () => {
    await seedLog('events@mailer-test.co', 'support_message')
    await db.query(
      `UPDATE email_send_log SET last_event='delivered', last_event_at=NOW()
        WHERE to_email='events@mailer-test.co'`)
    const { rows } = await db.query<any>(
      `SELECT last_event FROM email_send_log WHERE to_email='events@mailer-test.co'`)
    expect(rows[0].last_event).toBe('delivered')
  })

  it('the daily prune leaves correspondence alone, however old', async () => {
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString()
    await seedLog('ancient@mailer-test.co', 'support_message', { createdAt: old })
    await seedLog('ancient-code@mailer-test.co', 'login_2fa_code', { createdAt: old })
    const { pruneEmailSendLogForTest } = await import('../jobs/scheduler')
    await pruneEmailSendLogForTest()
    const kept = await db.query<any>(
      `SELECT to_email FROM email_send_log WHERE to_email LIKE 'ancient%'`)
    expect(kept.rows.map((r: any) => r.to_email)).toEqual(['ancient@mailer-test.co'])
  })
})

describe('GET /admin/email/history', () => {
  it('shows what we have already tried, newest first, with the words', async () => {
    await db.query(
      `INSERT INTO email_send_log (to_email, subject, category, status, body_text, created_at)
       VALUES ($1,'First try','landlord_welcome_outreach','sent','Hello there', NOW() - INTERVAL '3 days'),
              ($1,'Second try','support_message','sent','Following up again', NOW())`,
      [landlordEmail])
    const res = await request(buildApp())
      .get(`/api/admin/email/history?email=${encodeURIComponent(landlordEmail)}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((m: any) => m.subject)).toEqual(['Second try', 'First try'])
    expect(res.body.data[0].body_text).toBe('Following up again')
  })

  it('leaves sign-in codes out — those are not reach-out attempts', async () => {
    await db.query(
      `INSERT INTO email_send_log (to_email, subject, category, status)
       VALUES ($1,'Your GAM sign-in code: 123456','login_2fa_code','sent')`, [landlordEmail])
    const res = await request(buildApp())
      .get(`/api/admin/email/history?email=${encodeURIComponent(landlordEmail)}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.body.data).toHaveLength(0)
  })
})
