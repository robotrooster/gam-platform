/**
 * notifications.createNotification — the core fan-out function used
 * by ~30 notify* wrapper helpers across the codebase (rent collected,
 * ACH retry scheduled, payout paid/failed, maintenance updated, lease
 * expiring, low stock, inspection lifecycle, entry-request lifecycle,
 * dispute resolved, sublease lifecycle, etc.).
 *
 * Contract:
 *   1. Read notification_preferences for (user_id, type). When no row
 *      exists, defaults are: email=TRUE, sms=FALSE, in_app=TRUE.
 *   2. If in_app_enabled: INSERT a notifications row, capture id.
 *   3. If email_enabled AND p.sendEmail AND p.emailTo: call
 *      sendNotificationEmail. On non-null messageId, UPDATE
 *      notifications.email_sent=TRUE + email_sent_at=NOW() on THIS
 *      specific row (S106 fix — pre-S106 the UPDATE used MySQL ORDER
 *      BY LIMIT 1 which postgres rejected, leaving flags FALSE).
 *   4. If sms_enabled AND p.sendSMS AND p.smsTo: SMS stub fires +
 *      flip sms_sent flag.
 *   5. Best-effort: never throws. Outer try/catch logs and returns.
 *
 * The 30 notify* wrappers are thin shells over this; testing them all
 * is overkill. This file pins the createNotification contract; if
 * that's right, every wrapper benefits.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

const { sendNotificationEmailMock } = vi.hoisted(() => ({
  sendNotificationEmailMock: vi.fn(async (): Promise<string | null> => 'msg_mock'),
}))
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: sendNotificationEmailMock }
})

import { createNotification } from './notifications'

beforeEach(async () => {
  await cleanupAllSchema()
  sendNotificationEmailMock.mockClear()
  sendNotificationEmailMock.mockResolvedValue('msg_mock')
})

async function seedUser(email?: string): Promise<{ userId: string; email: string }> {
  const e = email ?? `user-${randomUUID()}@gam.dev`
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'tenant', 'Test', 'User', TRUE) RETURNING id`,
    [e])
  return { userId: r.rows[0].id, email: e }
}

async function setPrefs(
  userId: string,
  type: string,
  prefs: { email?: boolean; sms?: boolean; inApp?: boolean },
): Promise<void> {
  await db.query(
    `INSERT INTO notification_preferences (user_id, type, email_enabled, sms_enabled, in_app_enabled)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, prefs.email ?? true, prefs.sms ?? false, prefs.inApp ?? true])
}

describe('createNotification — preference defaults (no row exists)', () => {
  it('writes in-app row + sends email when sendEmail+emailTo set; SMS skipped (default sms=false)', async () => {
    const { userId, email } = await seedUser()
    await createNotification({
      userId, type: 'rent_collected', title: 'Rent paid', body: 'Got it',
      sendEmail: true, emailTo: email,
      sendSMS: true, smsTo: '+15555550001',
    })
    const rows = await db.query<{ id: string; email_sent: boolean; sms_sent: boolean }>(
      `SELECT id, email_sent, sms_sent FROM notifications WHERE user_id = $1`, [userId])
    expect(rows.rows.length).toBe(1)
    // email flipped TRUE (default email=true + flags set + messageId returned)
    expect(rows.rows[0].email_sent).toBe(true)
    // sms NOT flipped — default sms_enabled is false even though p.sendSMS=true
    expect(rows.rows[0].sms_sent).toBe(false)
    expect(sendNotificationEmailMock).toHaveBeenCalledTimes(1)
  })
})

describe('createNotification — prefs gates', () => {
  it('in_app_enabled=false → no notifications row written; email still attempted', async () => {
    const { userId, email } = await seedUser()
    await setPrefs(userId, 'lease_expiring', { inApp: false, email: true })
    await createNotification({
      userId, type: 'lease_expiring', title: 'Lease ending', body: 'In 30 days',
      sendEmail: true, emailTo: email,
    })
    const rows = await db.query(`SELECT id FROM notifications WHERE user_id = $1`, [userId])
    expect(rows.rows.length).toBe(0)
    // Email still sends (it's gated on email_enabled, not in_app_enabled)
    expect(sendNotificationEmailMock).toHaveBeenCalledTimes(1)
  })

  it('email_enabled=false → no email call even when sendEmail+emailTo set', async () => {
    const { userId, email } = await seedUser()
    await setPrefs(userId, 'payout_failed', { email: false, inApp: true })
    await createNotification({
      userId, type: 'payout_failed', title: 'Payout failed', body: 'Stripe error',
      sendEmail: true, emailTo: email,
    })
    expect(sendNotificationEmailMock).not.toHaveBeenCalled()
    // In-app row still written
    const rows = await db.query(`SELECT id FROM notifications WHERE user_id = $1`, [userId])
    expect(rows.rows.length).toBe(1)
  })

  it('sms_enabled=true → SMS stub fires + sms_sent flag flips', async () => {
    const { userId, email } = await seedUser()
    await setPrefs(userId, 'maintenance_update', { sms: true, email: true, inApp: true })
    await createNotification({
      userId, type: 'maintenance_update', title: 'Status', body: 'In progress',
      sendEmail: false, emailTo: email,
      sendSMS: true, smsTo: '+15555550002', smsBody: 'GAM: maintenance update',
    })
    const row = await db.query<{ sms_sent: boolean; email_sent: boolean }>(
      `SELECT sms_sent, email_sent FROM notifications WHERE user_id = $1`, [userId])
    expect(row.rows[0].sms_sent).toBe(true)
    expect(row.rows[0].email_sent).toBe(false)  // sendEmail=false
  })
})

describe('createNotification — sendEmail / emailTo gating', () => {
  it('p.sendEmail=false → no email call (even if prefs + emailTo both set)', async () => {
    const { userId, email } = await seedUser()
    await createNotification({
      userId, type: 'silent_inapp', title: 'In-app only', body: 'X',
      sendEmail: false, emailTo: email,
    })
    expect(sendNotificationEmailMock).not.toHaveBeenCalled()
  })

  it('no emailTo → no email call (even if sendEmail=true)', async () => {
    const { userId } = await seedUser()
    await createNotification({
      userId, type: 'partial', title: 'No recipient', body: 'X',
      sendEmail: true,  // but no emailTo
    })
    expect(sendNotificationEmailMock).not.toHaveBeenCalled()
  })
})

describe('createNotification — email_sent flag flip semantics', () => {
  it('messageId returned → email_sent flips TRUE + email_sent_at stamped', async () => {
    const { userId, email } = await seedUser()
    sendNotificationEmailMock.mockResolvedValueOnce('msg_abc123')
    await createNotification({
      userId, type: 'rent_collected', title: 'Rent paid', body: 'Got it',
      sendEmail: true, emailTo: email,
    })
    const row = await db.query<{ email_sent: boolean; email_sent_at: string | null }>(
      `SELECT email_sent, email_sent_at FROM notifications WHERE user_id = $1`, [userId])
    expect(row.rows[0].email_sent).toBe(true)
    expect(row.rows[0].email_sent_at).toBeTruthy()
  })

  it('null messageId (Resend rejected) → email_sent stays FALSE', async () => {
    const { userId, email } = await seedUser()
    sendNotificationEmailMock.mockResolvedValueOnce(null)  // simulating Resend rejection
    await createNotification({
      userId, type: 'rent_collected', title: 'Rent paid', body: 'Got it',
      sendEmail: true, emailTo: email,
    })
    const row = await db.query<{ email_sent: boolean; email_sent_at: string | null }>(
      `SELECT email_sent, email_sent_at FROM notifications WHERE user_id = $1`, [userId])
    expect(row.rows[0].email_sent).toBe(false)
    expect(row.rows[0].email_sent_at).toBeNull()
  })

  it('S106 fix: flag UPDATE targets the specific notification row, not the first row by created_at', async () => {
    // Pre-S106 the UPDATE used MySQL-shaped `ORDER BY created_at LIMIT 1`
    // which postgres rejected, leaving flags FALSE forever. The fix
    // captures the inserted row's id and UPDATEs by id. Pin this by
    // creating TWO notifications back-to-back for the same user+type,
    // both with sendEmail. The second one's email_sent should flip but
    // the first one's should stay FALSE if it failed.
    const { userId, email } = await seedUser()
    // First: returns null messageId → flag stays FALSE
    sendNotificationEmailMock.mockResolvedValueOnce(null)
    await createNotification({
      userId, type: 'rent_collected', title: 'First', body: 'fail',
      sendEmail: true, emailTo: email,
    })
    // Second: returns messageId → flag flips TRUE on the SECOND row only
    sendNotificationEmailMock.mockResolvedValueOnce('msg_ok')
    await createNotification({
      userId, type: 'rent_collected', title: 'Second', body: 'ok',
      sendEmail: true, emailTo: email,
    })
    const rows = await db.query<{ title: string; email_sent: boolean }>(
      `SELECT title, email_sent FROM notifications WHERE user_id = $1 ORDER BY created_at`,
      [userId])
    expect(rows.rows.length).toBe(2)
    expect(rows.rows[0].title).toBe('First')
    expect(rows.rows[0].email_sent).toBe(false)   // failed → FALSE
    expect(rows.rows[1].title).toBe('Second')
    expect(rows.rows[1].email_sent).toBe(true)   // succeeded → TRUE
  })
})

describe('createNotification — JSONB data + custom email HTML', () => {
  it('data JSONB roundtrip — stored as object, readable as object', async () => {
    const { userId } = await seedUser()
    await createNotification({
      userId, type: 'inspection_due', title: 'T', body: 'B',
      data: { inspectionId: 'abc', dueAt: '2026-06-01', severity: 3 },
    })
    const row = await db.query<{ data: any }>(
      `SELECT data FROM notifications WHERE user_id = $1`, [userId])
    expect(row.rows[0].data).toEqual({ inspectionId: 'abc', dueAt: '2026-06-01', severity: 3 })
  })

  it('emailHtml override → custom HTML used in the email body (not the default template)', async () => {
    const { userId, email } = await seedUser()
    const customHtml = '<div>Custom marketing HTML</div>'
    await createNotification({
      userId, type: 'custom', title: 'X', body: 'Y',
      sendEmail: true, emailTo: email,
      emailHtml: customHtml,
    })
    const call = (sendNotificationEmailMock.mock.calls as any[][])[0]![0] as any
    expect(call.html).toBe(customHtml)
  })

  it('emailSubject override → custom subject used (not p.title)', async () => {
    const { userId, email } = await seedUser()
    await createNotification({
      userId, type: 'rent', title: 'Default would be this', body: 'Y',
      sendEmail: true, emailTo: email,
      emailSubject: 'Custom subject line',
    })
    const call = (sendNotificationEmailMock.mock.calls as any[][])[0]![0] as any
    expect(call.subject).toBe('Custom subject line')
  })
})

describe('createNotification — best-effort error swallow', () => {
  it('sendNotificationEmail throws → caught, function returns normally, in-app row still written', async () => {
    const { userId, email } = await seedUser()
    sendNotificationEmailMock.mockRejectedValueOnce(new Error('Resend down'))
    await expect(createNotification({
      userId, type: 'rent_collected', title: 'Rent paid', body: 'Got it',
      sendEmail: true, emailTo: email,
    })).resolves.toBeUndefined()
    // In-app row was written BEFORE the email attempt → it persists
    const row = await db.query<{ id: string; email_sent: boolean }>(
      `SELECT id, email_sent FROM notifications WHERE user_id = $1`, [userId])
    expect(row.rows.length).toBe(1)
    expect(row.rows[0].email_sent).toBe(false)  // email never succeeded
  })

  it('INSERT fails (bad user_id FK) → caught, function returns without throwing', async () => {
    await expect(createNotification({
      userId: randomUUID(),  // not in users table
      type: 'orphan', title: 'X', body: 'Y',
    })).resolves.toBeUndefined()
  })
})
