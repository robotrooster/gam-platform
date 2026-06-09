/**
 * adminNotifications service — S132 admin alert surface.
 *
 * Single exported function `createAdminNotification`:
 *   - INSERT one row into admin_notifications (always, on any severity)
 *   - For severity='critical' OR opts.emailSuperAdmins=true: email
 *     every users.role='super_admin' with a non-null email
 *   - Best-effort: never throws. Inner failures log only.
 *
 * Load-bearing because every error-escalation site in the codebase
 * (ACH retry failures, allocation engine breaks, post-commit
 * pm_transfer failures, e-sign lease build failures, csv-import
 * review pending) flows through here. Silent failures here mean
 * admin would never know about real production incidents.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

const { sendNotificationEmailMock } = vi.hoisted(() => ({
  sendNotificationEmailMock: vi.fn(async () => ({ id: 'msg_mock' })),
}))
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: sendNotificationEmailMock }
})

import { createAdminNotification } from './adminNotifications'

beforeEach(async () => {
  await cleanupAllSchema()
  sendNotificationEmailMock.mockClear()
  sendNotificationEmailMock.mockResolvedValue({ id: 'msg_mock' })
})

async function seedSuperAdmin(emailOverride?: string): Promise<string> {
  const email = emailOverride ?? `super-${randomUUID()}@gam.dev`
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'super_admin', 'Super', 'Admin', TRUE) RETURNING id`,
    [email])
  return r.rows[0].id
}

describe('createAdminNotification — row insertion', () => {
  it('writes a row with all fields (severity, category, title, body, context as JSONB)', async () => {
    await createAdminNotification({
      severity: 'warn',
      category: 'test_category',
      title:    'Test title',
      body:     'Test body',
      context:  { tenantId: 'abc', amount: 42 },
    })
    const rows = await db.query<{
      severity: string; category: string; title: string; body: string;
      context: any; acknowledged_at: string | null
    }>(`SELECT severity, category, title, body, context, acknowledged_at FROM admin_notifications`)
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0].severity).toBe('warn')
    expect(rows.rows[0].category).toBe('test_category')
    expect(rows.rows[0].title).toBe('Test title')
    expect(rows.rows[0].body).toBe('Test body')
    expect(rows.rows[0].context).toEqual({ tenantId: 'abc', amount: 42 })
    expect(rows.rows[0].acknowledged_at).toBeNull()  // unack by default
  })

  it('body + context optional — null defaults persist correctly', async () => {
    await createAdminNotification({
      severity: 'info',
      category: 'minimal',
      title:    'Minimal alert',
    })
    const rows = await db.query<{ body: string | null; context: any }>(
      `SELECT body, context FROM admin_notifications`)
    expect(rows.rows[0].body).toBeNull()
    expect(rows.rows[0].context).toBeNull()
  })
})

describe('createAdminNotification — super_admin email gate', () => {
  it('severity=info → no super_admin email fires', async () => {
    await seedSuperAdmin()
    await createAdminNotification({
      severity: 'info', category: 'test', title: 'Info ping',
    })
    expect(sendNotificationEmailMock).not.toHaveBeenCalled()
  })

  it('severity=warn → no super_admin email fires', async () => {
    await seedSuperAdmin()
    await createAdminNotification({
      severity: 'warn', category: 'test', title: 'Warn ping',
    })
    expect(sendNotificationEmailMock).not.toHaveBeenCalled()
  })

  it('severity=critical → email fires to every super_admin with email', async () => {
    const u1 = await seedSuperAdmin('admin1@gam.dev')
    const u2 = await seedSuperAdmin('admin2@gam.dev')
    await createAdminNotification({
      severity: 'critical', category: 'system_break', title: 'Allocation engine down',
      body: 'Stripe API unavailable for 5 minutes',
    })
    expect(sendNotificationEmailMock).toHaveBeenCalledTimes(2)
    const calls = sendNotificationEmailMock.mock.calls.map((c: any[]) => c[0])
    const emails = (calls as any[]).map(c => c.to).sort()
    expect(emails).toEqual(['admin1@gam.dev', 'admin2@gam.dev'])
    // Every call has subject prefixed with [GAM ADMIN CRITICAL], notificationType prefixed
    // with admin_, userId matching the super_admin row, notificationId stamped from the
    // inserted admin_notifications row.
    for (const call of calls as any[]) {
      expect(call.subject).toMatch(/\[GAM ADMIN CRITICAL\] Allocation engine down/)
      expect(call.notificationType).toBe('admin_system_break')
      expect([u1, u2]).toContain(call.userId)
      expect(call.notificationId).toBeTruthy()  // matches the row.id from the INSERT
    }
  })

  it('emailSuperAdmins=true on info severity → email path fires anyway (S298 csv-import path)', async () => {
    await seedSuperAdmin('admin@gam.dev')
    await createAdminNotification({
      severity:         'info',
      category:         'csv_import_pending',
      title:            'Pending review',
      emailSuperAdmins: true,
    })
    expect(sendNotificationEmailMock).toHaveBeenCalledTimes(1)
    const call = (sendNotificationEmailMock.mock.calls as any[][])[0]![0] as any
    expect(call.subject).toMatch(/\[GAM ADMIN INFO\] Pending review/)
  })

  it('zero super_admins → row still inserted, no email firings, no throw', async () => {
    // No super_admin seeded
    await expect(createAdminNotification({
      severity: 'critical', category: 'test', title: 'Critical with no admins',
    })).resolves.toBeUndefined()
    expect(sendNotificationEmailMock).not.toHaveBeenCalled()
    const rows = await db.query(`SELECT id FROM admin_notifications`)
    expect(rows.rows.length).toBe(1)
  })
})

describe('createAdminNotification — best-effort error swallow', () => {
  it('sendNotificationEmail throw → logged but caller does not see throw', async () => {
    await seedSuperAdmin('admin@gam.dev')
    sendNotificationEmailMock.mockRejectedValueOnce(new Error('Resend 503'))
    await expect(createAdminNotification({
      severity: 'critical', category: 'test', title: 'Email will fail',
    })).resolves.toBeUndefined()
    // Row still inserted (the email fail is post-INSERT, separate concern)
    const rows = await db.query(`SELECT id FROM admin_notifications`)
    expect(rows.rows.length).toBe(1)
  })

  it('INSERT failure → outer catch swallows; caller does not see throw', async () => {
    // Force a CHECK constraint violation by passing an invalid severity.
    // The route-level type would normally prevent this, but the function
    // body's outer try/catch should still swallow at runtime.
    await expect(createAdminNotification({
      severity: 'NOT_A_VALID_SEVERITY' as any,
      category: 'test',
      title:    'Invalid severity',
    })).resolves.toBeUndefined()
    const rows = await db.query(`SELECT id FROM admin_notifications`)
    expect(rows.rows.length).toBe(0)  // INSERT failed → no row
  })
})

describe('createAdminNotification — HTML escape (XSS shape)', () => {
  it('title + body with <script> tags get escaped in the rendered email HTML', async () => {
    await seedSuperAdmin('admin@gam.dev')
    await createAdminNotification({
      severity: 'critical',
      category: 'test',
      title:    '<script>alert(1)</script>',
      body:     'evil: <img src=x onerror=alert(1)>',
      context:  { snippet: '"><svg/onload=alert(1)>' },
      action:   { label: 'Click <b>here</b>', url: 'https://admin.example.com/page?q=&x=<y>' },
    })
    expect(sendNotificationEmailMock).toHaveBeenCalledTimes(1)
    const call = (sendNotificationEmailMock.mock.calls as any[][])[0]![0] as any
    const html: string = call.html
    // Raw < / > / " do not appear unescaped — all rendered as entities
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('"><svg/onload=alert(1)>')
    // Title gets escaped
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // Body gets escaped
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // Action label gets escaped
    expect(html).toContain('Click &lt;b&gt;here&lt;/b&gt;')
    // The action URL is href-rendered; escapeHtml on quotes prevents
    // breakout from the attribute. The raw < and > in the query string
    // also get escaped.
    expect(html).toMatch(/href="https:\/\/admin\.example\.com\/page\?q=&amp;x=&lt;y&gt;"/)
  })

  it('action block omitted when no action is passed', async () => {
    await seedSuperAdmin('admin@gam.dev')
    await createAdminNotification({
      severity: 'critical', category: 'test', title: 'No action',
    })
    const call = (sendNotificationEmailMock.mock.calls as any[][])[0]![0] as any
    expect(call.html).not.toContain('<a href=')
  })
})
