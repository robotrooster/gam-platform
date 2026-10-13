/**
 * 10/12 (Nic) — the monthly property report, EMAILED at month close with the
 * PDF attached to the recipients the owner picks.
 *
 *   - when: the 2nd from 8 am on the company's own clock, made up through the
 *     5th, never on the 1st or after;
 *   - once per address per company per month, however many times the job runs;
 *   - each address gets the properties its recipient may see (a manager of one
 *     park never gets the other park's money); another address gets them all;
 *   - a send the mail service refused is tried again (where mail is live),
 *     at most three times; a claim never confirmed is never sent twice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }))
vi.mock('../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailMonthlyPropertyReport: sendSpy,
}))

const { scheduleSpy } = vi.hoisted(() => ({ scheduleSpy: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) }))
vi.mock('node-cron', () => ({ default: { schedule: scheduleSpy }, schedule: scheduleSpy }))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  reportMonthDue, runMonthlyPropertyReportEmails, sendCompanyMonthlyReport, registerMonthlyPropertyReportEmail,
  MONTHLY_REPORT_MAX_ATTEMPTS, MONTHLY_REPORT_STUCK_CATEGORY, noticeStuckSends,
} from './monthlyPropertyReportEmail'
import { saveRecipients, lastSends } from '../services/monthlyPropertyReport'

beforeEach(async () => {
  await cleanupAllSchema()
  sendSpy.mockReset()
  sendSpy.mockImplementation(async () => `msg_${Math.random().toString(36).slice(2)}`)
})

/** 9 am on Oct 2 in Arizona. */
const SECOND_9AM = new Date('2026-10-02T16:00:00Z')

interface Co { landlordId: string; ownerUserId: string; propA: string; propB: string; pm: string }

async function company(o: { timezone?: string; demo?: boolean } = {}): Promise<Co> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c, { firstName: 'Olive', lastName: 'Owner' })
    await c.query(`UPDATE landlords SET business_name = 'Owner Parks LLC', is_demo = $2 WHERE id = $1`, [ll.landlordId, o.demo === true])
    const prop = async (name: string) => {
      const id = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      await c.query(`UPDATE properties SET name = $2, timezone = $3 WHERE id = $1`, [id, name, o.timezone ?? 'America/Phoenix'])
      return id
    }
    const propA = await prop('Alpha Park'), propB = await prop('Bravo Park')
    for (const [propertyId, amt, paid] of [[propA, 500, true], [propB, 700, false]] as const) {
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at, settled_at, manual_method)
         VALUES ($1,$2,$3,$4,'rent',$5,$6,'2026-09-01','RENT','2026-08-25T09:00:00-07:00',$7,$8)`,
        [unitId, leaseId, tenantId, ll.landlordId, amt, paid ? 'settled' : 'pending',
         paid ? '2026-09-03T10:00:00-07:00' : null, paid ? 'cash' : null])
    }
    const pm = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','property_manager','Pat','Manager',TRUE) RETURNING id`, [`pm-${ll.landlordId.slice(0, 8)}@example.org`])).rows[0].id
    await c.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,FALSE,$3)`,
      [pm, ll.landlordId, [propA]])
    await c.query('COMMIT')
    return { landlordId: ll.landlordId, ownerUserId: ll.userId, propA, propB, pm }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const sends = async (landlordId: string) => (await db.query(
  `SELECT to_char(report_month, 'YYYY-MM') AS month, email, status, attempts, property_ids, provider_message_id
     FROM monthly_report_sends WHERE landlord_id = $1 ORDER BY email`, [landlordId])).rows

describe('when the monthly report is due', () => {
  it('the 2nd from 8 am on the company\'s clock, made up through the 5th; never the 1st, never after', () => {
    expect(reportMonthDue(new Date('2026-10-01T16:00:00Z'), 'America/Phoenix')).toBeNull()        // 9 am on the 1st
    expect(reportMonthDue(new Date('2026-10-02T14:30:00Z'), 'America/Phoenix')).toBeNull()        // 7:30 am on the 2nd
    expect(reportMonthDue(new Date('2026-10-02T15:00:00Z'), 'America/Phoenix')).toBe('2026-09')   // 8 am on the 2nd
    expect(reportMonthDue(new Date('2026-10-05T23:00:00Z'), 'America/Phoenix')).toBe('2026-09')   // catch-up on the 5th
    expect(reportMonthDue(new Date('2026-10-06T16:00:00Z'), 'America/Phoenix')).toBeNull()        // too late
    // The company's own clock: 8:30 am on the 2nd in New York is 5:30 am in Arizona.
    expect(reportMonthDue(new Date('2026-10-02T12:30:00Z'), 'America/New_York')).toBe('2026-09')
    expect(reportMonthDue(new Date('2026-10-02T12:30:00Z'), 'America/Phoenix')).toBeNull()
    // January reports December.
    expect(reportMonthDue(new Date('2027-01-02T16:00:00Z'), null)).toBe('2026-12')
  })

  it('is registered hourly on the first days of the month, on the Phoenix calendar', () => {
    scheduleSpy.mockClear()
    registerMonthlyPropertyReportEmail()
    // 10/12: through the 7th — nothing is due anywhere then; the run only looks for stuck sends.
    expect(scheduleSpy).toHaveBeenCalledWith('25 * 1-7 * *', expect.any(Function), { timezone: 'America/Phoenix' })
    for (const tz of ['Pacific/Honolulu', 'America/Anchorage', 'America/Phoenix', 'America/New_York']) {
      expect(reportMonthDue(new Date('2026-10-07T07:25:00Z'), tz), tz).toBeNull()   // the 7th's first run (Phoenix)
    }
  })
})

describe('the monthly report email', () => {
  it('goes to the owner only by default, with the PDF attached and every property', async () => {
    const co = await company()
    const r = await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
    expect(r).toMatchObject({ companies: 1, due: 1, sent: 1, notSent: 0 })
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const a = sendSpy.mock.calls[0][0]
    expect(a).toMatchObject({ companyName: 'Owner Parks LLC', monthLabel: 'September 2026', landlordId: co.landlordId })
    expect(a.to).toMatch(/@test\.dev$/)
    expect(a.rows.map((x: any) => [x.name, x.charged, x.received, x.owed])).toEqual([
      ['Alpha Park', 500, 500, 0], ['Bravo Park', 700, 0, 700],
    ])
    expect(Buffer.isBuffer(a.pdf) && a.pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(a.filename).toBe('Monthly-report-Owner-Parks-LLC-2026-09.pdf')
    expect(a.reportUrl).toMatch(/\/reports\?tab=monthly&month=2026-09$/)
    expect(await sends(co.landlordId)).toEqual([expect.objectContaining({ month: '2026-09', status: 'sent', attempts: 1 })])
  })

  it('is idempotent per company per month: a second run, and a catch-up run on the 3rd, send nothing more', async () => {
    const co = await company()
    await saveRecipients(co.landlordId, co.ownerUserId, [co.ownerUserId, co.pm], ['cpa@example.org'])
    await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
    expect(sendSpy).toHaveBeenCalledTimes(3)
    const again = await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
    const third = await runMonthlyPropertyReportEmails({ now: new Date('2026-10-03T16:00:00Z'), only: [co.landlordId] })
    expect(again).toMatchObject({ sent: 0, skipped: 3 })
    expect(third).toMatchObject({ sent: 0, skipped: 3 })
    expect(sendSpy).toHaveBeenCalledTimes(3)
    expect((await sends(co.landlordId)).map(s => [s.status, s.attempts])).toEqual([['sent', 1], ['sent', 1], ['sent', 1]])
    // Two runs at once: one email per address all the same.
    sendSpy.mockClear()
    await db.query(`DELETE FROM monthly_report_sends`)
    await Promise.all([sendCompanyMonthlyReport(co.landlordId, '2026-09'), sendCompanyMonthlyReport(co.landlordId, '2026-09')])
    expect(sendSpy).toHaveBeenCalledTimes(3)
  })

  it('each address gets the properties its recipient may see; another address gets them all', async () => {
    const co = await company()
    await saveRecipients(co.landlordId, co.ownerUserId, [co.pm], ['cpa@example.org'])
    await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
    const byTo = new Map(sendSpy.mock.calls.map(c => [c[0].to, c[0]]))
    const pmMail = [...byTo.values()].find(a => a.to.startsWith('pm-'))!
    expect(pmMail.rows.map((r: any) => r.name)).toEqual(['Alpha Park'])
    expect(pmMail.reportUrl).toMatch(/tab=monthly/)
    const cpa = byTo.get('cpa@example.org')!
    expect(cpa.rows.map((r: any) => r.name)).toEqual(['Alpha Park', 'Bravo Park'])
    expect(cpa.reportUrl).toBeNull()
    // 10/5 reply routing: an outside address answers to the account owner; a team member's copy keeps GAM's default.
    expect(cpa.replyTo).toEqual({ kind: 'person', userId: co.ownerUserId })
    expect(pmMail.replyTo).toBeUndefined()
    const rows = await sends(co.landlordId)
    expect(rows.find(s => s.email === 'cpa@example.org').property_ids.sort()).toEqual([co.propA, co.propB].sort())
    expect(rows.find(s => s.email.startsWith('pm-')).property_ids).toEqual([co.propA])
  })

  it('an empty list sends to nobody; a demo company and a day outside the window send nothing', async () => {
    const co = await company()
    await saveRecipients(co.landlordId, co.ownerUserId, [], [])
    expect(await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })).toMatchObject({ due: 1, sent: 0 })
    const demo = await company({ demo: true })
    expect(await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [demo.landlordId] })).toMatchObject({ companies: 0 })
    const other = await company()
    expect(await runMonthlyPropertyReportEmails({ now: new Date('2026-10-01T16:00:00Z'), only: [other.landlordId] })).toMatchObject({ due: 0 })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('GAM\'s own system company (the renter pool) is never claimed or sent, though it owns a property', async () => {
    const sys = await company()
    await db.query(`UPDATE landlords SET is_system = TRUE WHERE id = $1`, [sys.landlordId])
    expect(await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [sys.landlordId] })).toMatchObject({ companies: 0, sent: 0 })
    expect(sendSpy).not.toHaveBeenCalled()
    expect(await sends(sys.landlordId)).toEqual([])
  })

  it('where mail is live, a send the mail service refused is tried again on a later run — at most three times', async () => {
    const co = await company()
    sendSpy.mockImplementation(async () => null)
    process.env.EMAIL_SEND_LIVE = '1'
    try {
      for (let i = 0; i < MONTHLY_REPORT_MAX_ATTEMPTS + 2; i++) {
        await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
      }
      expect(sendSpy).toHaveBeenCalledTimes(MONTHLY_REPORT_MAX_ATTEMPTS)
      expect(await sends(co.landlordId)).toEqual([expect.objectContaining({ status: 'not_sent', attempts: MONTHLY_REPORT_MAX_ATTEMPTS })])
      // Accepted on a retry: sent, and never again.
      await db.query(`UPDATE monthly_report_sends SET attempts = 1`)
      sendSpy.mockImplementation(async () => 'msg_ok')
      await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
      await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
      expect(await sends(co.landlordId)).toEqual([expect.objectContaining({ status: 'sent', attempts: 2, provider_message_id: 'msg_ok' })])
    } finally {
      delete process.env.EMAIL_SEND_LIVE
    }
  })

  it('where mail is not live, nothing is retried (one attempt per address per month)', async () => {
    const co = await company()
    sendSpy.mockImplementation(async () => null)
    await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
    await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(await sends(co.landlordId)).toEqual([expect.objectContaining({ status: 'not_sent', attempts: 1 })])
  })

  // 10/12 (Nic): a send stuck at 'sending' raises an admin notice instead of
  // silently never sending — once per send, never sent again by itself.
  it('a claim stuck at sending raises one admin notice, names the company, month and address, and is not sent again', async () => {
    const co = await company()
    const sendRow = (await db.query<{ id: string; email: string }>(
      `INSERT INTO monthly_report_sends (landlord_id, report_month, recipient_key, email, status, updated_at)
       SELECT $1, '2026-09-01', lower(u.email), lower(u.email), 'sending', $3::timestamptz FROM users u WHERE u.id = $2
       RETURNING id, email`,
      [co.landlordId, co.ownerUserId, '2026-10-02T15:25:00Z'])).rows[0]
    // Twenty minutes after the claim it may still be going: no notice.
    expect(await noticeStuckSends(new Date('2026-10-02T15:45:00Z'), [co.landlordId])).toBe(0)
    // The next hourly run finds it stuck.
    process.env.EMAIL_SEND_LIVE = '1'
    try {
      const r = await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
      expect(r.stuck).toBe(1)
      // Later runs never raise it again, and never send it.
      const again = await runMonthlyPropertyReportEmails({ now: new Date('2026-10-03T16:00:00Z'), only: [co.landlordId] })
      expect(again.stuck).toBe(0)
    } finally { delete process.env.EMAIL_SEND_LIVE }
    expect(sendSpy).not.toHaveBeenCalled()
    const notes = (await db.query(
      `SELECT severity, title, body, context FROM admin_notifications WHERE category = $1`, [MONTHLY_REPORT_STUCK_CATEGORY])).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].severity).toBe('warn')
    expect(notes[0].title).toBe("Owner Parks LLC's September 2026 monthly report may not have been emailed")
    expect(notes[0].body).toContain(sendRow.email)
    expect(notes[0].context).toMatchObject({ send_id: sendRow.id, landlord_id: co.landlordId, report_month: '2026-09', email: sendRow.email })
    // Archived notices still count as raised.
    await db.query(
      `INSERT INTO admin_notifications_archive (severity, category, title, body, context, created_at)
       SELECT severity, category, title, body, context, created_at FROM admin_notifications WHERE category = $1`, [MONTHLY_REPORT_STUCK_CATEGORY])
    await db.query(`DELETE FROM admin_notifications WHERE category = $1`, [MONTHLY_REPORT_STUCK_CATEGORY])
    expect(await noticeStuckSends(new Date('2026-10-04T16:00:00Z'), [co.landlordId])).toBe(0)
    // The send row itself is left as it was (keep everything; one missing email beats two).
    expect(await sends(co.landlordId)).toEqual([expect.objectContaining({ status: 'sending', attempts: 1 })])
  })

  // 10/12 (Nic, review): every read of the recipient list raises the notice
  // too, alongside the hourly job — overlapping calls raised it twice.
  it('overlapping checks raise one notice per send', async () => {
    const co = await company()
    await db.query(
      `INSERT INTO monthly_report_sends (landlord_id, report_month, recipient_key, email, status, updated_at)
       SELECT $1, '2026-09-01', lower(u.email), lower(u.email), 'sending', $3::timestamptz FROM users u WHERE u.id = $2`,
      [co.landlordId, co.ownerUserId, '2026-10-02T15:00:00Z'])
    const at = new Date('2026-10-02T16:00:00Z')
    const raised = await Promise.all(Array.from({ length: 5 }, () => noticeStuckSends(at, [co.landlordId])))
    expect(raised.reduce((a, b) => a + b, 0)).toBe(1)
    expect((await db.query(
      `SELECT COUNT(*)::int AS n FROM admin_notifications WHERE category = $1`, [MONTHLY_REPORT_STUCK_CATEGORY])).rows[0].n).toBe(1)
  })

  // 10/12 (Nic, review): the list said "GAM was alerted" from the time alone,
  // even when raising the notice had failed and none existed.
  it('the recipient list says "GAM was alerted" only where the notice is on record', async () => {
    const co = await company()
    await db.query(
      `INSERT INTO monthly_report_sends (landlord_id, report_month, recipient_key, email, status, updated_at)
       SELECT $1, '2026-09-01', lower(u.email), lower(u.email), 'sending', $3::timestamptz FROM users u WHERE u.id = $2`,
      [co.landlordId, co.ownerUserId, '2026-10-02T15:00:00Z'])
    const at = new Date('2026-10-02T16:00:00Z')
    const label = async () => (await lastSends(co.landlordId, at))[0]
    // Stuck, and no notice raised: it does not say GAM was told.
    expect(await label()).toMatchObject({ stuck: true, statusLabel: 'Not sent — stuck' })
    expect(await noticeStuckSends(at, [co.landlordId])).toBe(1)
    expect(await label()).toMatchObject({ stuck: true, statusLabel: 'Not sent — stuck, GAM was alerted' })
    // An archived notice is still on record.
    await db.query(
      `INSERT INTO admin_notifications_archive (severity, category, title, body, context, created_at)
       SELECT severity, category, title, body, context, created_at FROM admin_notifications WHERE category = $1`, [MONTHLY_REPORT_STUCK_CATEGORY])
    await db.query(`DELETE FROM admin_notifications WHERE category = $1`, [MONTHLY_REPORT_STUCK_CATEGORY])
    expect(await label()).toMatchObject({ statusLabel: 'Not sent — stuck, GAM was alerted' })
    // Another send's notice is not this one's.
    await db.query(`DELETE FROM admin_notifications_archive WHERE category = $1`, [MONTHLY_REPORT_STUCK_CATEGORY])
    await db.query(
      `INSERT INTO admin_notifications (severity, category, title, context) VALUES ('warn', $1, 'x', $2)`,
      [MONTHLY_REPORT_STUCK_CATEGORY, JSON.stringify({ send_id: '00000000-0000-0000-0000-000000000000' })])
    expect(await label()).toMatchObject({ statusLabel: 'Not sent — stuck' })
  })

  it('a claim never confirmed (the process stopped mid-send) is never sent twice', async () => {
    const co = await company()
    await db.query(
      `INSERT INTO monthly_report_sends (landlord_id, report_month, recipient_key, email, status)
       SELECT $1, '2026-09-01', lower(u.email), lower(u.email), 'sending' FROM users u WHERE u.id = $2`,
      [co.landlordId, co.ownerUserId])
    process.env.EMAIL_SEND_LIVE = '1'
    try {
      await runMonthlyPropertyReportEmails({ now: SECOND_9AM, only: [co.landlordId] })
    } finally { delete process.env.EMAIL_SEND_LIVE }
    expect(sendSpy).not.toHaveBeenCalled()
  })
})
