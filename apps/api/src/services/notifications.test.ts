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

import { createNotification, notifyRentCollected, notifyAchRetryScheduled, notifyAchRetriesExhausted, notifyAutopayFailed, notifyFlexDepositPullFailed } from './notifications'
import { portalLink } from '../lib/portalUrls'

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
    `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
     VALUES ($1, $2, $3, $4)`,
    [userId, type, prefs.email ?? true, prefs.inApp ?? true])
}

describe('createNotification — preference defaults (no row exists)', () => {
  it('writes in-app row + sends email when sendEmail+emailTo set', async () => {
    const { userId, email } = await seedUser()
    await createNotification({
      userId, type: 'rent_collected', title: 'Rent paid', body: 'Got it',
      sendEmail: true, emailTo: email,
    })
    const rows = await db.query<{ id: string; email_sent: boolean }>(
      `SELECT id, email_sent FROM notifications WHERE user_id = $1`, [userId])
    expect(rows.rows.length).toBe(1)
    // email flipped TRUE (default email=true + flags set + messageId returned)
    expect(rows.rows[0].email_sent).toBe(true)
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

// ─── S642: the rent-collected card states the money, not the lease ──────────
//
// Nic: "It's only showing the base rent in the email card. It's not showing
// what they actually paid. So it's misleading… Calvin Curtis paid four ninety
// five for unit RV 40. That is not the total he paid."
//
// He settled $495.00 rent and $25.20 electricity on ONE intent. The webhook
// looped the settled rows, fired once per RENT row, and read that row's own
// amount — so the landlord was told $495.00, the lease's base rent, as though
// that were the payment.
describe('notifyRentCollected — S642: the figure is the money that arrived', () => {
  // createNotification writes an in-app row whose landlord_id is a REAL FK to
  // landlords. A made-up uuid makes the insert throw, the best-effort catch
  // swallows it, and NO email is sent — so an assertion-on-the-email test fails
  // for a reason that has nothing to do with the thing under test. Seed one.
  async function seedLandlord(): Promise<string> {
    const { userId } = await seedUser()
    const r = await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [userId])
    return r.rows[0].id
  }

  async function fire(over: Partial<Parameters<typeof notifyRentCollected>[0]> = {}) {
    const { userId, email } = await seedUser()
    const landlordId = await seedLandlord()
    await notifyRentCollected({
      landlordUserId: userId,
      landlordId,
      landlordEmail:  email,
      tenantName:     'Calvin Curtis',
      unitNumber:     'RV 40',
      propertyName:   'Mountain View RV Ranch',
      amount:         520.20,
      ...over,
    } as any)
    const call = (sendNotificationEmailMock.mock.calls as any[][])[0]![0] as any
    return { call, userId }
  }

  it('states the event total, not the rent row', async () => {
    const { call } = await fire({
      breakdown: [
        { label: 'Rent',        amount: 495.00 },
        { label: 'Electricity', amount: 25.20 },
      ],
    })
    expect(call.html).toContain('$520.20')
    // The exact shape of the old bug: announcing base rent as the amount paid.
    expect(call.html).not.toContain('paid <b>$495.00</b>')
  })

  it('names where the money went when the total covers more than one charge', async () => {
    const { call } = await fire({
      breakdown: [
        { label: 'Rent',        amount: 495.00 },
        { label: 'Electricity', amount: 25.20 },
      ],
    })
    // A landlord reading $520.20 against a $495 lease needs the $25.20 named,
    // or the total itself looks like the error.
    expect(call.html).toContain('Electricity')
    expect(call.html).toContain('$25.20')
    expect(call.html).toContain('$495.00')
    expect(call.html).toContain('Total paid')
  })

  it('a rent-only payment grows no one-line breakdown', async () => {
    const { call } = await fire({ amount: 495.00, breakdown: undefined })
    expect(call.html).toContain('$495.00')
    expect(call.html).not.toContain('Total paid')
  })

  it('the in-app row carries the same total as the email', async () => {
    const { userId } = await fire({
      breakdown: [
        { label: 'Rent',        amount: 495.00 },
        { label: 'Electricity', amount: 25.20 },
      ],
    })
    const row = await db.query<{ body: string }>(
      `SELECT body FROM notifications WHERE user_id = $1 AND type = 'rent_collected'`, [userId])
    expect(row.rows[0].body).toContain('$520.20')
    expect(row.rows[0].body).toContain('Electricity: $25.20')
  })
})

// S654: one email per thing. The webhook called these once per landlord-side
// contact, and each call also emailed the tenant: two contacts meant two
// identical tenant emails, none meant none. The tenant's copy now goes once.
describe('ACH retry notices — the tenant is told once per failed payment', () => {
  async function setup(contacts: number) {
    const tenant = await seedUser()
    const { userId: ownerUserId } = await seedUser()
    const landlordId = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [ownerUserId])).rows[0].id
    const landlordRecipients: { userId: string; email: string }[] = []
    for (let i = 0; i < contacts; i++) {
      const u = await seedUser()
      landlordRecipients.push({ userId: u.userId, email: u.email })
    }
    return { tenant, landlordId, landlordRecipients }
  }

  const sentTo = (type: string) => (sendNotificationEmailMock.mock.calls as any[][])
    .map((c) => c[0] as any)
    .filter((c) => c.notificationType === type)
    .map((c) => c.to as string)

  for (const contacts of [2, 0]) {
    it(`retry scheduled with ${contacts} landlord contacts: one tenant email, one per contact`, async () => {
      const { tenant, landlordId, landlordRecipients } = await setup(contacts)
      await notifyAchRetryScheduled({
        tenantUserId: tenant.userId, tenantEmail: tenant.email, tenantName: 'Test Tenant',
        landlordId, landlordRecipients,
        unitNumber: 'MH 25', propertyName: 'Oak Park', amount: 450,
        reason: 'there was not enough money in the account', retryDate: '2026-10-04', retryAttempt: 1,
      })
      expect(sentTo('ach_retry_scheduled')).toEqual([tenant.email])
      expect(sentTo('ach_retry_scheduled_info').sort()).toEqual(landlordRecipients.map((r) => r.email).sort())
      const rows = await db.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'ach_retry_scheduled'`, [tenant.userId])
      expect(rows.rows).toHaveLength(1)
    })

    it(`retries exhausted with ${contacts} landlord contacts: one tenant email, one per contact`, async () => {
      const { tenant, landlordId, landlordRecipients } = await setup(contacts)
      await notifyAchRetriesExhausted({
        paymentId: randomUUID(),
        tenantUserId: tenant.userId, tenantEmail: tenant.email, tenantName: 'Test Tenant',
        landlordId, landlordRecipients,
        unitNumber: 'MH 25', propertyName: 'Oak Park', amount: 450,
        reason: 'there was not enough money in the account',
        finalReason: 'retries_used', attempts: 3, payUrl: 'https://tenant.example/login?ef=tok&to=%2Fpayments',
      })
      expect(sentTo('ach_retries_exhausted')).toEqual([tenant.email])
      expect(sentTo('ach_retries_exhausted_landlord').sort()).toEqual(landlordRecipients.map((r) => r.email).sort())
    })
  }

  it('the tenant\'s in-app data carries no landlord-side contact', async () => {
    const { tenant, landlordId, landlordRecipients } = await setup(2)
    await notifyAchRetryScheduled({
      tenantUserId: tenant.userId, tenantEmail: tenant.email, tenantName: 'Test Tenant',
      landlordId, landlordRecipients,
      unitNumber: 'MH 25', propertyName: 'Oak Park', amount: 450,
      reason: 'Insufficient funds', retryDate: '2026-10-04', retryAttempt: 1,
    })
    const { rows } = await db.query<{ data: any }>(
      `SELECT data FROM notifications WHERE user_id = $1 AND type = 'ach_retry_scheduled'`, [tenant.userId])
    const text = JSON.stringify(rows[0].data)
    for (const r of landlordRecipients) expect(text).not.toContain(r.email)
    expect(rows[0].data.retryDate).toBe('2026-10-04')
  })
})

// S654 (Nic): the "Payment cannot be retried" email. It had no way to pay, it
// said "failed multiple times ... NACHA limits us to 2 retries" even when it
// fired on the first bounce of a closed account, and it quoted one line of a
// payment that covered several. Now it has a Pay now button, the whole amount,
// and one of two true stories.
describe('the payment-didn\'t-go-through notice (final failure)', () => {
  const PAY_URL = 'https://tenant.example/login?ef=signed-token&to=%2Fpayments'

  async function fire(over: Partial<Parameters<typeof notifyAchRetriesExhausted>[0]> = {}) {
    const tenant = await seedUser()
    const staff = await seedUser()
    const { userId: ownerUserId } = await seedUser()
    const landlordId = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [ownerUserId])).rows[0].id
    await notifyAchRetriesExhausted({
      paymentId: randomUUID(),
      tenantUserId: tenant.userId, tenantEmail: tenant.email, tenantName: 'Pat Doe',
      landlordId, landlordRecipients: [{ userId: staff.userId, email: staff.email }],
      unitNumber: 'MH 25', propertyName: 'Oak Park', amount: 520.20,
      reason: 'there was not enough money in the account',
      finalReason: 'retries_used', attempts: 3, payUrl: PAY_URL,
      ...over,
    })
    return { tenant, staff }
  }
  const mailOf = (type: string) => (sendNotificationEmailMock.mock.calls as any[][])
    .map((c) => c[0] as any).find((c) => c.notificationType === type)

  it('the tenant email has a gold Pay now button that opens the pay link', async () => {
    await fire()
    const html: string = mailOf('ach_retries_exhausted').html
    expect(html).toContain(`<a href="${PAY_URL}" class="btn">Pay now</a>`)
  })

  it('the in-app notice opens the Payments page', async () => {
    const { tenant } = await fire()
    const { rows } = await db.query<{ action_url: string | null }>(
      `SELECT action_url FROM notifications WHERE user_id = $1 AND type = 'ach_retries_exhausted'`, [tenant.userId])
    expect(rows[0].action_url).toBe('/payments')
  })

  it('without a signed link the button still goes to the Payments page', async () => {
    await fire({ payUrl: null })
    expect(mailOf('ach_retries_exhausted').html).toContain(`href="${portalLink('tenant', 'payments')}"`)
  })

  it('retries used: says how many tries, the last reason, and that the whole amount is still owed', async () => {
    const { tenant } = await fire()
    const mail = mailOf('ach_retries_exhausted')
    expect(mail.subject).toBe(`Your payment didn't go through — Unit MH 25`)
    expect(mail.html).toContain('from your bank 3 times')
    expect(mail.html).toContain('the last time because there was not enough money in the account')
    expect(mail.html).toContain('<b>$520.20</b> is still owed')
    expect(mail.html).not.toMatch(/NACHA|exhausted|R0\d/)
    const { rows } = await db.query<{ body: string }>(
      `SELECT body FROM notifications WHERE user_id = $1 AND type = 'ach_retries_exhausted'`, [tenant.userId])
    expect(rows[0].body).toContain('3 times')
    expect(rows[0].body).not.toContain('<b>')
  })

  it('bank refused on the FIRST try: says the bank turned it down and why — never "multiple times"', async () => {
    await fire({ finalReason: 'bank_refused', attempts: 1, reason: 'the account is closed' })
    const html: string = mailOf('ach_retries_exhausted').html
    expect(html).toContain('Your bank turned down your <b>$520.20</b> payment for Oak Park Unit MH 25 because the account is closed')
    expect(html).toContain('different bank account or a card')
    expect(html).not.toMatch(/multiple|times|retries|NACHA/i)
  })

  it('bank refused with a reason we could not read: no empty "because"', async () => {
    await fire({ finalReason: 'bank_refused', attempts: 1, reason: null })
    const html: string = mailOf('ach_retries_exhausted').html
    expect(html).toContain('Your bank turned down your <b>$520.20</b> payment for Oak Park Unit MH 25, so we can')
    expect(html).not.toContain('because')
  })

  it('a declined card says so, not "your bank"', async () => {
    await fire({ finalReason: 'card_declined', attempts: 1, reason: null })
    const html: string = mailOf('ach_retries_exhausted').html
    expect(html).toContain('Your card was declined')
    expect(html).not.toContain('Your bank')
  })

  it('the landlord side gets the same total and reason, and no pay button', async () => {
    await fire({ finalReason: 'bank_refused', attempts: 1, reason: 'the account is closed' })
    const mail = mailOf('ach_retries_exhausted_landlord')
    expect(mail.html).toContain('$520.20')
    expect(mail.html).toContain('the account is closed')
    expect(mail.html).not.toContain('Pay now')
    expect(mail.html).not.toContain(PAY_URL)
  })

  it('the signed pay link is never stored in either audience\'s notice data', async () => {
    const { tenant, staff } = await fire()
    const { rows } = await db.query<{ data: any }>(
      `SELECT data FROM notifications WHERE user_id = ANY($1::uuid[])`, [[tenant.userId, staff.userId]])
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(JSON.stringify(r.data)).not.toContain('signed-token')
  })
})

describe('the retry-scheduled notice reads plainly', () => {
  async function fireRetry(retryAttempt: 1 | 2) {
    const tenant = await seedUser()
    const { userId: ownerUserId } = await seedUser()
    const landlordId = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [ownerUserId])).rows[0].id
    await notifyAchRetryScheduled({
      tenantUserId: tenant.userId, tenantEmail: tenant.email, tenantName: 'Pat Doe',
      landlordId, landlordRecipients: [],
      unitNumber: 'MH 25', propertyName: 'Oak Park', amount: 520.20,
      reason: 'there was not enough money in the account', retryDate: '2026-10-04', retryAttempt,
    })
    return (sendNotificationEmailMock.mock.calls as any[][]).map((c) => c[0] as any)
      .find((c) => c.notificationType === 'ach_retry_scheduled')
  }

  it('names the day in words and the reason in plain words — no NACHA, no ISO date in the copy', async () => {
    const mail = await fireRetry(1)
    expect(mail.subject).toBe('Payment retry scheduled — Sunday, October 4')
    expect(mail.html).toContain('<b>$520.20</b> payment for Oak Park Unit MH 25 didn\'t go through because there was not enough money in the account')
    expect(mail.html).not.toMatch(/NACHA|2026-10-04/)
  })

  // S654 (review): the first retry is not the last — a short-of-money bounce on
  // retry 1 schedules retry 2. "We can't try your bank again" was false there.
  it('the FIRST retry says one more try follows if it bounces for the same reason — never "can\'t try again"', async () => {
    const mail = await fireRetry(1)
    expect(mail.html).toContain('This is the first of two retries')
    expect(mail.html).toContain('we\'ll try one last time three days later')
    expect(mail.html).not.toMatch(/can't try your bank again|another way/)
  })

  it('the SECOND retry is the last, and says so', async () => {
    const mail = await fireRetry(2)
    expect(mail.html).toContain('This is the last retry')
    expect(mail.html).toContain('we can\'t try your bank again and you\'ll need to pay another way')
    expect(mail.html).not.toContain('first of two')
  })
})

// S654 (review): a retry that was due but not fired because part of the pull
// was paid another way (cash at the desk, a matched deposit) in the meantime.
describe('the retry-skipped notice (part was paid another way)', () => {
  it('tells the tenant the bank was not retried and what is still owed, with the Pay now button', async () => {
    const tenant = await seedUser()
    const staff = await seedUser()
    const { userId: ownerUserId } = await seedUser()
    const landlordId = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [ownerUserId])).rows[0].id
    const PAY_URL = 'https://tenant.example/login?ef=signed-token&to=%2Fpayments'
    await notifyAchRetriesExhausted({
      paymentId: randomUUID(),
      tenantUserId: tenant.userId, tenantEmail: tenant.email, tenantName: 'Pat Doe',
      landlordId, landlordRecipients: [{ userId: staff.userId, email: staff.email }],
      unitNumber: 'MH 25', propertyName: 'Oak Park', amount: 25.20,
      reason: 'there was not enough money in the account',
      finalReason: 'partly_paid', attempts: 1, payUrl: PAY_URL,
    })
    const mails = (sendNotificationEmailMock.mock.calls as any[][]).map((c) => c[0] as any)
    const toTenant = mails.find((c) => c.notificationType === 'ach_retries_exhausted')
    expect(toTenant.html).toContain('has since been paid another way, so we didn\'t try your bank again')
    expect(toTenant.html).toContain('The rest, <b>$25.20</b>, is still owed')
    expect(toTenant.html).toContain(`<a href="${PAY_URL}" class="btn">Pay now</a>`)
    expect(toTenant.html).not.toMatch(/turned down|times/)
    const toStaff = mails.find((c) => c.notificationType === 'ach_retries_exhausted_landlord')
    expect(toStaff.html).toContain('was paid another way before its retry')
    expect(toStaff.html).toContain('$25.20')
    expect(toStaff.html).not.toContain('Pay now')
  })
})

// S654: an autopay that could not even start (no usable method, card refused on
// the spot) was an in-app bell only. It is a critical type, so it emails.
describe('notifyAutopayFailed', () => {
  const PAY_URL = 'https://tenant.example/login?ef=signed-token&to=%2Fpayments'
  const mail = () => (sendNotificationEmailMock.mock.calls as any[][]).map((c) => c[0] as any)
    .find((c) => c.notificationType === 'autopay_failed')

  it('emails the tenant with a Pay now button, and the bell opens Payments', async () => {
    const tenant = await seedUser()
    await notifyAutopayFailed({ tenantUserId: tenant.userId, tenantEmail: tenant.email, disarming: false, payUrl: PAY_URL })
    expect(mail().to).toBe(tenant.email)
    expect(mail().subject).toBe('Your scheduled rent payment didn’t go through')
    expect(mail().html).toContain(`<a href="${PAY_URL}" class="btn">Pay now</a>`)
    const { rows } = await db.query<{ action_url: string; body: string }>(
      `SELECT action_url, body FROM notifications WHERE user_id = $1 AND type = 'autopay_failed'`, [tenant.userId])
    expect(rows[0].action_url).toBe('/payments')
    expect(rows[0].body).toContain('Autopay is still on')
  })

  it('emails even when the tenant switched that email off — a missed rent payment is critical', async () => {
    const tenant = await seedUser()
    await setPrefs(tenant.userId, 'autopay_failed', { email: false })
    await notifyAutopayFailed({ tenantUserId: tenant.userId, tenantEmail: tenant.email, disarming: true, payUrl: PAY_URL })
    expect(mail().to).toBe(tenant.email)
    expect(mail().subject).toBe('Autopay has been turned off')
  })
})

// S654 (review): "check the account you pay from, then pay" went out for every
// autopay failure — including an eviction hold (whose Payments page refuses the
// payment) and GAM's own errors. Each kind is now told what is true of it.
describe('notifyAutopayFailed — each reason is told truthfully', () => {
  const rowsFor = async (userId: string) => (await db.query<{ action_url: string; body: string }>(
    `SELECT action_url, body FROM notifications WHERE user_id = $1 AND type = 'autopay_failed'`, [userId])).rows
  const autopayMails = () => (sendNotificationEmailMock.mock.calls as any[][]).map((c) => c[0] as any)
    .filter((c) => c.notificationType === 'autopay_failed')

  it('a paused space: in-app only, no email, no pay button, and points them to their landlord', async () => {
    const tenant = await seedUser()
    await notifyAutopayFailed({ tenantUserId: tenant.userId, tenantEmail: tenant.email, disarming: false, kind: 'payments_paused', payUrl: 'https://x/pay' })
    expect(autopayMails()).toHaveLength(0)
    const [row] = await rowsFor(tenant.userId)
    expect(row.body).toContain('payments for your space are paused')
    expect(row.body).toContain('contact your landlord')
    expect(row.body).not.toMatch(/Check the account|Payments page/)
    expect(row.action_url).toBe('/lease')
  })

  it('our side: emailed with the Pay now button, says nothing was taken and nothing is wrong with their account', async () => {
    const tenant = await seedUser()
    await notifyAutopayFailed({ tenantUserId: tenant.userId, tenantEmail: tenant.email, disarming: false, kind: 'our_side', payUrl: 'https://x/pay' })
    const [mail] = autopayMails()
    expect(mail.to).toBe(tenant.email)
    expect(mail.html).toContain('a problem on our end')
    expect(mail.html).toContain('nothing was taken from your account')
    expect(mail.html).not.toContain('Check the account you pay from')
    expect(mail.html).toContain('<a href="https://x/pay" class="btn">Pay now</a>')
  })

  it('our side, second time: says autopay is off without blaming their bank', async () => {
    const tenant = await seedUser()
    await notifyAutopayFailed({ tenantUserId: tenant.userId, tenantEmail: tenant.email, disarming: true, kind: 'our_side' })
    const [mail] = autopayMails()
    expect(mail.subject).toBe('Autopay has been turned off')
    expect(mail.html).not.toContain('stop your bank charging you')
  })

  it('the tenant\'s own payment method: the original copy, emailed', async () => {
    const tenant = await seedUser()
    await notifyAutopayFailed({ tenantUserId: tenant.userId, tenantEmail: tenant.email, disarming: false, kind: 'payment_method' })
    const [mail] = autopayMails()
    expect(mail.html).toContain('Check the account you pay from')
  })
})

// S654 (review): a bounced FlexDeposit pull gets no generic notice (its retry is
// pre-scheduled, and the landlord side never hears of FlexDeposit) — but the
// tenant must still be told.
describe('notifyFlexDepositPullFailed — tenant only, true to the plan', () => {
  const LEASE_URL = 'https://tenant.example/login?ef=signed-token&to=%2Flease'
  const fdMails = () => (sendNotificationEmailMock.mock.calls as any[][]).map((c) => c[0] as any)
    .filter((c) => c.notificationType === 'flexdeposit_payment_failed')

  it('first bounce: names the scheduled retry day and the reason, and has no pay button', async () => {
    const tenant = await seedUser()
    await notifyFlexDepositPullFailed({
      tenantUserId: tenant.userId, tenantEmail: tenant.email, amount: 150,
      reason: 'there was not enough money in the account', outcome: 'will_retry', retryDate: '2026-10-04', leaseUrl: LEASE_URL,
    })
    const [mail] = fdMails()
    expect(mail.to).toBe(tenant.email)
    expect(mail.html).toContain('<b>$150.00</b> deposit installment payment didn\'t go through because there was not enough money in the account')
    expect(mail.html).toContain('We\'ll try your bank again on <b>Sunday, October 4</b>')
    expect(mail.html).not.toContain('class="btn"')
  })

  it('first bounce with its retry day already reached: no stale date', async () => {
    const tenant = await seedUser()
    await notifyFlexDepositPullFailed({
      tenantUserId: tenant.userId, tenantEmail: tenant.email, amount: 150, reason: null, outcome: 'will_retry', retryDate: null,
    })
    const [mail] = fdMails()
    expect(mail.html).toContain('in the next few days')
    expect(mail.html).not.toContain('because')
  })

  it('retry bounce: the installment is missed, the plan stays on, and the button opens the Lease page', async () => {
    const tenant = await seedUser()
    await notifyFlexDepositPullFailed({
      tenantUserId: tenant.userId, tenantEmail: tenant.email, amount: 154,
      reason: 'there was not enough money in the account', outcome: 'missed', leaseUrl: LEASE_URL,
    })
    const [mail] = fdMails()
    expect(mail.subject).toBe('A deposit installment was missed')
    expect(mail.html).toContain('this installment is marked missed')
    expect(mail.html).toContain('Your deposit plan stays on')
    expect(mail.html).toContain(`<a href="${LEASE_URL}" class="btn">Go to your lease</a>`)
    expect(mail.html).not.toMatch(/debt|collections|default/i)
  })

  it('a pay-ahead they started: nothing else changes', async () => {
    const tenant = await seedUser()
    await notifyFlexDepositPullFailed({
      tenantUserId: tenant.userId, tenantEmail: tenant.email, amount: 450, reason: 'the account is closed', outcome: 'pay_ahead',
    })
    const [mail] = fdMails()
    expect(mail.html).toContain('<b>$450.00</b> payment toward your deposit didn\'t go through because the account is closed')
    expect(mail.html).toContain('your scheduled deposit installments continue as planned')
    expect(mail.html).toContain(`href="${portalLink('tenant', 'lease')}"`)
  })

  it('only the tenant is notified — one row, theirs, opening the Lease page; the link is not stored', async () => {
    const tenant = await seedUser()
    await notifyFlexDepositPullFailed({
      tenantUserId: tenant.userId, tenantEmail: tenant.email, amount: 150, reason: null, outcome: 'missed', leaseUrl: LEASE_URL,
    })
    const { rows } = await db.query<{ user_id: string; action_url: string; data: any }>(
      `SELECT user_id, action_url, data FROM notifications`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: tenant.userId, action_url: '/lease' })
    expect(JSON.stringify(rows[0].data)).not.toContain('signed-token')
  })
})
