/**
 * "I TURNED IT OFF AND I'M STILL GETTING EMAILS" — THE END-TO-END PROOF.
 *
 * 10/20 (Nic): "I don't want you to switch off three remaining email settings
 * when you said there's five critical things and 22 other ones that weren't even
 * on the list... I want you to fix the root."
 *
 * Blu Haws sat with Nic on 10/19 and unchecked every box the settings page
 * showed him. Fifteen rows saved. He kept getting email, because twenty-two
 * types GAM actually sends him had no box anywhere and a missing row means
 * email-on.
 *
 * So this file does not assert that a checkbox saved a column. It drives the
 * REAL route the page calls, and then puts EVERY type through the REAL
 * createNotification and counts the emails that would have gone out. If a type
 * is ever added without a switch, the first test here goes red.
 *
 * ── AND THE HALF IT USED TO MISS ────────────────────────────────────────────
 * The describe below is named for a system-wide claim — "a landlord who
 * switches everything off stops getting every optional email" — and for a while
 * it could not fail when that claim was false. It only counts calls to a mocked
 * `sendNotificationEmail`, which is the createNotification road. The overdue
 * digest, the monthly bill, the payment receipt, the signing request, its
 * reminders and the monthly property report all go out through the OTHER road
 * (their own senders in services/email.ts, straight to send()), outside the
 * mock's reach and outside the assertion. The suite was green, 15 of 15, while
 * every one of those still mailed Blu Haws.
 *
 * The last describe in this file closes that. It drives the REAL senders with
 * the REAL send(), and reads the answer off the email_send_log row each one
 * writes: a notification somebody switched off is logged 'suppressed' with
 * EMAIL_DECLINED_BY_PREFERENCE as the reason, and a transactional email —
 * a password reset — is not. A test whose name is the product requirement
 * should fail when the requirement is unmet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { sendNotificationEmailMock } = vi.hoisted(() => ({
  sendNotificationEmailMock: vi.fn(async (): Promise<string | null> => 'msg_mock'),
}))
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: sendNotificationEmailMock }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'
import { notificationsRouter } from '../routes/notifications'
import { errorHandler } from '../middleware/errorHandler'
import { createNotification } from './notifications'
import {
  notificationCatalogFor, isCriticalNotificationType, CRITICAL_NOTIFICATION_TYPES,
  EMAIL_DECLINED_BY_PREFERENCE, EMAIL_CATEGORY_RULES,
  type NotificationType,
} from '@gam/shared'
import {
  sendLatePaymentDigest, emailInvoiceReady, emailPaymentReceipt, emailBalanceDue,
  emailMonthlyPropertyReport, emailSigningRequest, emailSigningReminder,
  emailSigningCompleted, emailDocumentAutoVoided, emailNewLeaseTenantUnsigned,
  emailNewBackgroundCheck, emailPoolMatchInterest, emailPoolTenantInterested,
  emailBirthdayGreeting, sendPasswordResetEmail,
} from './email'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/notifications', notificationsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sendNotificationEmailMock.mockClear()
  sendNotificationEmailMock.mockResolvedValue('msg_mock')
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_notif_prefs'
})

async function seedLandlordUser(): Promise<{ userId: string; email: string; token: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId } = await seedLandlord(c)
    await c.query('COMMIT')
    const { rows } = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])
    return {
      userId, email: rows[0]!.email,
      token: jwt.sign(
        { userId, role: 'landlord', email: rows[0]!.email, profileId: null, landlordIds: [], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * A RESIDENT, for the senders whose notification lives on the resident's page.
 * The monthly bill, the payment receipt, the balance reminder and the
 * renter-pool notice are theirs, not a landlord's — firing those at a landlord
 * address would prove nothing, because a landlord was never offered those rows.
 */
async function seedTenantUser(): Promise<{ userId: string; email: string; token: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const tenantId = await seedTenant(c)
    await c.query('COMMIT')
    const { rows } = await db.query<{ user_id: string; email: string }>(
      `SELECT t.user_id, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [tenantId])
    const { user_id: userId, email } = rows[0]!
    return {
      userId, email,
      token: jwt.sign(
        { userId, role: 'tenant', email, profileId: tenantId, landlordIds: [], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Everything on the landlord's settings page that is not one of the locked five. */
const LANDLORD_OPTIONAL = notificationCatalogFor('landlord', { isAccountHolder: true })
  .filter(e => !isCriticalNotificationType(e.type))

/** What the page sends when somebody presses "Turn off every optional email". */
function allOffBody() {
  return {
    updates: LANDLORD_OPTIONAL.map(e => ({
      // 10/20 (Nic, on Blu): email off, in-app on — "he told Nic he would rather
      // log in and see what needs attention."
      type: e.type, emailEnabled: false, inAppEnabled: true,
    })),
  }
}

/** Put one type through the real notify path as if its event had just happened. */
async function fire(userId: string, email: string, type: NotificationType) {
  await createNotification({
    userId, type, title: `A ${type} happened`, body: 'body',
    sendEmail: true, emailTo: email,
  })
}

describe('a landlord who switches everything off stops getting every optional email', () => {
  it('EVERY optional type is silent by email after one press of the button', async () => {
    const ll = await seedLandlordUser()

    const res = await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${ll.token}`)
      .send(allOffBody())
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.saved).toBe(LANDLORD_OPTIONAL.length)

    // Now fire every one of them for real.
    for (const entry of LANDLORD_OPTIONAL) await fire(ll.userId, ll.email, entry.type as NotificationType)

    // Not one email. Named, so a failure says WHICH type still emails rather
    // than just a count — that is the whole lesson of the twenty-two.
    const stillEmailing = sendNotificationEmailMock.mock.calls
      .map(c => (c as any[])[0]?.notificationType)
    expect(stillEmailing).toEqual([])
  })

  it('and the in-app copies are all still there, so nothing is lost', async () => {
    const ll = await seedLandlordUser()
    await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${ll.token}`)
      .send(allOffBody())
      .expect(200)

    for (const entry of LANDLORD_OPTIONAL) await fire(ll.userId, ll.email, entry.type as NotificationType)

    const { rows } = await db.query<{ type: string }>(
      `SELECT type FROM notifications WHERE user_id = $1`, [ll.userId])
    expect(new Set(rows.map(r => r.type)).size).toBe(LANDLORD_OPTIONAL.length)
  })

  it('one answer is recorded per type, so there is nothing left unanswered', async () => {
    const ll = await seedLandlordUser()
    await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${ll.token}`)
      .send(allOffBody())
      .expect(200)
    const { rows } = await db.query<{ type: string; email_enabled: boolean }>(
      `SELECT type, email_enabled FROM notification_preferences WHERE user_id = $1`, [ll.userId])
    expect(rows.length).toBe(LANDLORD_OPTIONAL.length)
    expect(rows.filter(r => r.email_enabled)).toEqual([])
  })
})

describe('the five GAM always sends reach that same landlord anyway', () => {
  it.each([...CRITICAL_NOTIFICATION_TYPES])(
    '%s still emails after everything was switched off', async (type) => {
      const ll = await seedLandlordUser()
      await request(buildApp())
        .patch('/api/notifications/preferences')
        .set('Authorization', `Bearer ${ll.token}`)
        .send(allOffBody())
        .expect(200)
      // And belt-and-braces: try to switch this one off by hand, the way the
      // agent tool or a stray script might.
      await request(buildApp())
        .patch('/api/notifications/preferences')
        .set('Authorization', `Bearer ${ll.token}`)
        .send({ type, emailEnabled: false, inAppEnabled: false })
        .expect(200)

      sendNotificationEmailMock.mockClear()
      await fire(ll.userId, ll.email, type)
      expect(sendNotificationEmailMock).toHaveBeenCalledTimes(1)
    })

  it('the stored row says email-on too — never off-on-screen-but-sending', async () => {
    const ll = await seedLandlordUser()
    await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${ll.token}`)
      .send({ type: 'autopay_failed', emailEnabled: false, inAppEnabled: false })
      .expect(200)
    const { rows } = await db.query<{ email_enabled: boolean; in_app_enabled: boolean }>(
      `SELECT email_enabled, in_app_enabled FROM notification_preferences
        WHERE user_id = $1 AND type = 'autopay_failed'`, [ll.userId])
    expect(rows[0]).toMatchObject({ email_enabled: true, in_app_enabled: true })
  })

  it('a critical notice is posted in-app even with in_app_enabled FALSE on the row', async () => {
    const ll = await seedLandlordUser()
    // Written straight to the table, past the route's coercion — an old row, or
    // whatever a future script does.
    await db.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
       VALUES ($1, 'autopay_failed', FALSE, FALSE)`, [ll.userId])
    await fire(ll.userId, ll.email, 'autopay_failed')
    const { rows } = await db.query(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'autopay_failed'`, [ll.userId])
    expect(rows.length).toBe(1)
    expect(sendNotificationEmailMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * ITEM 4, THE DECISION, SAID OUT LOUD IN THE TEST NAME.
 *
 * A missing row still means email-on. That default is only honest because the
 * page now renders EVERY type GAM can send (notificationCatalog + the compiler
 * on createNotification), so a landlord can always answer, and one press records
 * an answer for all of them. What was wrong before was not the default — it was
 * that twenty-two types had nowhere to be answered.
 *
 * The cost of the other option (writing a row per type per user up front) is a
 * backfill for every user every time a type is added, which fails in exactly the
 * same way the moment one is missed.
 */
describe('a brand-new user with no rows at all: GAM emails by default, and the page can always be answered', () => {
  it('emails an optional type when nothing has been answered yet', async () => {
    const ll = await seedLandlordUser()
    await fire(ll.userId, ll.email, 'rent_collected')
    expect(sendNotificationEmailMock).toHaveBeenCalledTimes(1)
  })

  it('shows no stored answers, and the page still offers every type', async () => {
    const ll = await seedLandlordUser()
    const res = await request(buildApp()).get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${ll.token}`)
      .expect(200)
    expect(res.body.data).toEqual([])
    // The page is built from the catalog, not from these rows, so an empty
    // answer set is a full page of switches rather than a blank screen.
    expect(notificationCatalogFor('landlord').length).toBeGreaterThan(50)
  })

  it('one press of the button turns every optional email off for them', async () => {
    const ll = await seedLandlordUser()
    await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${ll.token}`)
      .send(allOffBody())
      .expect(200)
    sendNotificationEmailMock.mockClear()
    await fire(ll.userId, ll.email, 'rent_collected')
    expect(sendNotificationEmailMock).not.toHaveBeenCalled()
  })
})

describe('the route will not store a preference GAM cannot act on', () => {
  it('rejects a type nothing sends', async () => {
    const ll = await seedLandlordUser()
    const res = await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${ll.token}`)
      .send({ type: 'rent_due', emailEnabled: false, inAppEnabled: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('rent_due')
  })

  it('still accepts a retired type, because someone already answered it', async () => {
    const ll = await seedLandlordUser()
    await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${ll.token}`)
      .send({ type: 'rent_failed', emailEnabled: false, inAppEnabled: true })
      .expect(200)
  })
})

/**
 * ── THE OTHER ROAD, DRIVEN FOR REAL ─────────────────────────────────────────
 *
 * Every sender below is one Blu Haws kept hearing from after he answered all 90
 * of his rows. None of them touches createNotification; each calls send()
 * itself with its own category. The gate in services/email.ts reads the
 * declaration in @gam/shared emailCategories, looks up the recipient by
 * address, and writes the reason on the log row.
 *
 * `sendNotificationEmail` is mocked at the top of this file but these do not go
 * through it — the real send() runs, and in a test environment no network call
 * is made (S536/S553) while the log row is still written. The row is therefore
 * the honest observable: 'suppressed' with EMAIL_DECLINED_BY_PREFERENCE means
 * the recipient's answer stopped it; 'suppressed' with no reason means only
 * that this machine does not send mail.
 */
describe('a landlord who switches everything off also stops getting the mail that never asked', () => {
  /** The one row this send wrote, newest first. */
  async function logRowFor(toEmail: string, category: string) {
    const { rows } = await db.query<{ status: string; error_message: string | null }>(
      `SELECT status, error_message FROM email_send_log
        WHERE lower(to_email) = lower($1) AND category = $2
        ORDER BY created_at DESC LIMIT 1`, [toEmail, category])
    return rows[0]
  }

  /** Press "turn off every optional email" on that audience's own page. */
  async function switchEverythingOff(token: string, audience: 'landlord' | 'tenant') {
    const optional = notificationCatalogFor(audience, { isAccountHolder: true })
      .filter(e => !isCriticalNotificationType(e.type))
    await request(buildApp())
      .patch('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ updates: optional.map(e => ({ type: e.type, emailEnabled: false, inAppEnabled: true })) })
      .expect(200)
  }

  /**
   * One call per gated category that reaches a landlord or a resident at their
   * own address. Each returns the category its send stamps, so the assertion
   * can read the row back.
   */
  function sendersFor(
    landlordEmail: string, residentEmail: string, landlordId: string,
  ): Array<{ category: string; who: 'landlord' | 'resident'; fire: () => Promise<unknown> }> {
    // Whose page the notification lives on decides which address it is fired
    // at. An 'audience: both' type (the e-sign ones, the birthday) is on the
    // landlord's page too, so the landlord's address proves it.
    const email = landlordEmail
    const resident = residentEmail
    return [
      { category: 'late_payment_notice', who: 'landlord', fire: () => sendLatePaymentDigest({
          landlordEmail: email, landlordName: 'Blu', ctx: { landlordId },
          items: [{ tenantName: 'A Resident', unitNumber: '1', propertyName: 'TruBlu', daysLate: 4, amount: 500 }],
        }) },
      { category: 'invoice_ready', who: 'resident', fire: () => emailInvoiceReady(resident, {
          tenantName: 'Blu', unitLabel: 'TruBlu — 1', invoiceNumber: 'INV-1',
          dueDateLabel: 'Nov 1, 2026', total: 500,
          lines: [{ label: 'Rent', amount: 500 }],
        }, { landlordId }) },
      { category: 'payment_receipt', who: 'resident', fire: () => emailPaymentReceipt(resident, {
          tenantName: 'Blu', unitLabel: 'TruBlu — 1', amount: 500, method: 'check',
          paidAt: new Date('2026-10-20T12:00:00Z'), lines: [{ label: 'Rent', amount: 500 }],
        }, { landlordId }) },
      { category: 'balance_due_reminder', who: 'resident', fire: () => emailBalanceDue(resident, {
          tenantName: 'Blu', unitLabel: 'TruBlu — 1', total: 500,
          lines: [{ label: 'Rent', amount: 500 }],
        }, { landlordId }) },
      { category: 'monthly_property_report', who: 'landlord', fire: () => emailMonthlyPropertyReport({
          to: email, recipientName: 'Blu', companyName: 'TruBlu', monthLabel: 'October 2026',
          rows: [{ name: 'TruBlu', charged: 500, received: 500, owed: 0, lateHouseholds: 0 }],
          pdf: Buffer.from('%PDF-1.4 test'), filename: 'report.pdf', reportUrl: null, landlordId,
          sendId: '00000000-0000-0000-0000-00000000beef',
        }) },
      { category: 'esign_signing_request', who: 'landlord', fire: () => emailSigningRequest(
          email, 'Blu', 'Lease', 'TruBlu — 1', 'TruBlu', 'https://example.test/sign/x',
          { landlordId }) },
      { category: 'esign_signing_reminder', who: 'landlord', fire: () => emailSigningReminder(
          email, 'Blu', 'Lease', 'TruBlu — 1', 'TruBlu', 'https://example.test/sign/x',
          { landlordId }) },
      { category: 'esign_signing_completed', who: 'landlord', fire: () => emailSigningCompleted(
          email, 'Blu', 'Lease', 'TruBlu — 1', undefined, undefined, { landlordId }) },
      { category: 'esign_document_auto_voided', who: 'landlord', fire: () => emailDocumentAutoVoided(
          email, 'Blu', 'Lease', 'TruBlu — 1', { landlordId }) },
      { category: 'esign_new_lease_unsigned', who: 'landlord', fire: () => emailNewLeaseTenantUnsigned(
          email, 'Blu', [{ unitLabel: 'TruBlu — 1', startDate: '2026-11-01', rent: 500, tenantNames: 'A Resident' }],
          { stage: 'started', landlordId }) },
      { category: 'background_new', who: 'landlord', fire: () => emailNewBackgroundCheck(
          email, 'Blu', 'A Resident', 'TruBlu', '1', 'low', 'https://example.test/background',
          { landlordId }) },
      { category: 'pool_match_interest', who: 'resident', fire: () => emailPoolMatchInterest(
          resident, 'Blu', 'TruBlu', 'TruBlu', '1', null, 500, 'https://example.test/notifications',
          { landlordId }) },
      { category: 'pool_tenant_interested', who: 'landlord', fire: () => emailPoolTenantInterested(
          email, 'Blu', 'https://example.test/pool', { landlordId }) },
      { category: 'birthday', who: 'landlord', fire: () => emailBirthdayGreeting({
          to: email, firstName: 'Blu', ctx: { audience: 'landlord' } }) },
    ]
  }

  /** A landlord and a resident, each having pressed the button on their own page. */
  async function bothAnsweredEverythingOff() {
    const ll = await seedLandlordUser()
    const tn = await seedTenantUser()
    await switchEverythingOff(ll.token, 'landlord')
    await switchEverythingOff(tn.token, 'tenant')
    const landlordId = (await db.query<{ id: string }>(
      `SELECT id FROM landlords WHERE user_id = $1`, [ll.userId])).rows[0]!.id
    return { ll, tn, landlordId, senders: sendersFor(ll.email, tn.email, landlordId) }
  }

  it('EVERY one of these senders goes quiet, and the row says it was their own answer', async () => {
    const { ll, tn, senders } = await bothAnsweredEverythingOff()
    for (const s of senders) await s.fire()

    // Named, so a failure says WHICH email still goes out rather than a count —
    // that is the whole lesson of the twenty-two.
    const stillSending: string[] = []
    for (const s of senders) {
      const row = await logRowFor(s.who === 'landlord' ? ll.email : tn.email, s.category)
      if (!row) { stillSending.push(`${s.category} (no log row at all)`); continue }
      if (!(row.error_message ?? '').startsWith(EMAIL_DECLINED_BY_PREFERENCE)) {
        stillSending.push(`${s.category} (status ${row.status}, reason ${row.error_message ?? 'none'})`)
      }
    }
    expect(stillSending,
      'These reached somebody who had switched every optional email off. Each one needs a ' +
      'declaration in packages/shared/src/emailCategories.ts whose gate names a notification type ' +
      'with a row on their settings page.',
    ).toEqual([])
  })

  it('and the transactional mail they cannot decline is NOT stopped', async () => {
    const { ll } = await bothAnsweredEverythingOff()
    await sendPasswordResetEmail(ll.email, 'Blu', 'https://example.test/reset/x')
    const row = await logRowFor(ll.email, 'password_reset')
    expect(row, 'a password reset must still be attempted').toBeTruthy()
    // Not declined. In a test environment nothing leaves the machine, so the
    // status is 'suppressed' for THAT reason and the row carries no reason at
    // all — which is exactly how the two cases are told apart.
    expect(row!.error_message ?? '').not.toContain(EMAIL_DECLINED_BY_PREFERENCE)
  })

  it('somebody who has answered nothing still gets all of it', async () => {
    const ll = await seedLandlordUser()
    const tn = await seedTenantUser()
    const landlordId = (await db.query<{ id: string }>(
      `SELECT id FROM landlords WHERE user_id = $1`, [ll.userId])).rows[0]!.id
    const senders = sendersFor(ll.email, tn.email, landlordId)
    for (const s of senders) await s.fire()
    const declined: string[] = []
    for (const s of senders) {
      const row = await logRowFor(s.who === 'landlord' ? ll.email : tn.email, s.category)
      if ((row?.error_message ?? '').startsWith(EMAIL_DECLINED_BY_PREFERENCE)) declined.push(s.category)
    }
    expect(declined, 'nothing is declined for somebody who has not answered').toEqual([])
  })

  it('every gated category in the declaration is one of the senders above', () => {
    // The list in sendersFor is the thing that could go stale. This fails when
    // a new gated category is declared and nobody drives it here — the same
    // staleness that let the settings pages drift, caught in the file whose
    // name is the promise.
    const gated = Object.entries(EMAIL_CATEGORY_RULES).filter(([, r]) => r.gate).map(([c]) => c)
    const driven = sendersFor('a@test.dev', 'b@test.dev', '00000000-0000-0000-0000-000000000000')
      .map(s => s.category)
    expect([...gated].sort()).toEqual([...driven].sort())
  })
})
