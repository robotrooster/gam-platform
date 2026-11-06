/**
 * PM readiness 4 — the owner statement, EMAILED.
 *
 *   - when: the 3rd from 8 am on the manager's own clock, made up through the
 *     6th, never on the 1st or 2nd and never after;
 *   - once per owner entity per manager per month, however many times the job
 *     runs (a re-run and a catch-up run send nothing more);
 *   - an owner with no properties under that manager gets NO email, and the
 *     reason is on record rather than a page of zeros;
 *   - an owner never receives another owner's numbers, even under the same
 *     manager;
 *   - an owner with two managers gets two statements;
 *   - a send the mail service refused is tried again (where mail is live), at
 *     most three times; a claim never confirmed is never sent twice, and is
 *     noticed rather than going silently missing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }))
vi.mock('../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailOwnerStatement: sendSpy,
}))

const { scheduleSpy } = vi.hoisted(() => ({ scheduleSpy: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) }))
vi.mock('node-cron', () => ({ default: { schedule: scheduleSpy }, schedule: scheduleSpy }))

import type { PoolClient } from 'pg'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedUserBankAccount, seedPmCompany,
} from '../test/dbHelpers'
import {
  statementMonthDue, runOwnerStatementEmails, sendOwnerStatement, registerOwnerStatementEmail,
  noticeStuckOwnerStatements, OWNER_STATEMENT_MAX_ATTEMPTS, OWNER_STATEMENT_STUCK_CATEGORY,
} from './ownerStatementEmail'
import { ownerStatementsDue, ownerStatementDelivery } from '../services/ownerStatementDelivery'

beforeEach(async () => {
  await cleanupAllSchema()
  sendSpy.mockReset()
  sendSpy.mockImplementation(async () => `msg_${Math.random().toString(36).slice(2)}`)
})

/** 9 am on Sep 3 in Arizona — the statement for August is due. */
const THIRD_9AM = new Date('2026-09-03T16:00:00Z')
const MONTH = '2026-08'

interface Owner { landlordId: string; userId: string; email: string; propertyIds: string[] }

async function pmCompany(c: PoolClient, name: string): Promise<{ id: string; staffUserId: string }> {
  const staff = (await c.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','property_manager','Pat','Manager',TRUE) RETURNING id`,
    [`pm-${Math.random().toString(36).slice(2, 10)}@gam.dev`])).rows[0].id
  const bankId = await seedUserBankAccount(c, { userId: staff })
  const id = await seedPmCompany(c, { bankAccountId: bankId, name })
  await c.query(`INSERT INTO pm_staff (pm_company_id, user_id, role, status) VALUES ($1,$2,'owner','active')`,
    [id, staff])
  return { id, staffUserId: staff }
}

/**
 * One owner entity under one manager, with `parks` properties and money on
 * each. `opts.parks: []` is the owner a manager onboarded and has no property
 * for yet.
 */
async function owner(c: PoolClient, opts: {
  pmCompanyId: string
  businessName: string
  parks: Array<{ name: string; ownerShare: number; pmFee?: number; timezone?: string }>
  demo?: boolean
  system?: boolean
}): Promise<Owner> {
  const { userId, landlordId } = await seedLandlord(c)
  await c.query(`UPDATE landlords SET business_name = $2, is_demo = $3, is_system = $4 WHERE id = $1`,
    [landlordId, opts.businessName, opts.demo === true, opts.system === true])
  await c.query(
    `INSERT INTO pm_owner_relationships (pm_company_id, landlord_id, status) VALUES ($1,$2,'active')
     ON CONFLICT DO NOTHING`, [opts.pmCompanyId, landlordId])
  const propertyIds: string[] = []
  for (const park of opts.parks) {
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET name = $2, pm_company_id = $3, timezone = $4 WHERE id = $1`,
      [propertyId, park.name, opts.pmCompanyId, park.timezone ?? 'America/Phoenix'])
    await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    for (const [type, amount] of [
      ['allocation_owner_share', park.ownerShare],
      ['allocation_pm_company_fee', park.pmFee ?? 100],
    ] as const) {
      await c.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, property_id, created_at)
         VALUES ($1,$2,$3,0,$4,$5::date + INTERVAL '9 days')`,
        [userId, type, amount.toFixed(2), propertyId, `${MONTH}-01`])
    }
    propertyIds.push(propertyId)
  }
  const email = (await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email
  return { landlordId, userId, email, propertyIds }
}

const sends = async (landlordId: string) => (await db.query(
  `SELECT to_char(period_month, 'YYYY-MM') AS month, email, status, attempts, property_ids,
          provider_message_id, last_error, sent_at IS NOT NULL AS has_sent_at
     FROM owner_statement_sends WHERE landlord_id = $1 ORDER BY email, pm_company_id`,
  [landlordId])).rows

describe('when an owner statement is due', () => {
  it("the 3rd from 8 am on the manager's clock, made up through the 6th; never before, never after", () => {
    expect(statementMonthDue(new Date('2026-09-02T16:00:00Z'), 'America/Phoenix')).toBeNull()      // 9 am on the 2nd
    expect(statementMonthDue(new Date('2026-09-03T14:30:00Z'), 'America/Phoenix')).toBeNull()      // 7:30 am on the 3rd
    expect(statementMonthDue(new Date('2026-09-03T15:00:00Z'), 'America/Phoenix')).toBe('2026-08') // 8 am on the 3rd
    expect(statementMonthDue(new Date('2026-09-06T23:00:00Z'), 'America/Phoenix')).toBe('2026-08') // catch-up on the 6th
    expect(statementMonthDue(new Date('2026-09-07T16:00:00Z'), 'America/Phoenix')).toBeNull()      // too late
    // The manager's own clock: 8:30 am on the 3rd in New York is 5:30 am in Arizona.
    expect(statementMonthDue(new Date('2026-09-03T12:30:00Z'), 'America/New_York')).toBe('2026-08')
    expect(statementMonthDue(new Date('2026-09-03T12:30:00Z'), 'America/Phoenix')).toBeNull()
    // January reports December; no zone falls back to GAM's own.
    expect(statementMonthDue(new Date('2027-01-03T16:00:00Z'), null)).toBe('2026-12')
  })

  it('is registered hourly on the first days of the month, on the Phoenix calendar', () => {
    scheduleSpy.mockClear()
    registerOwnerStatementEmail()
    // Through the 7th: nothing is due anywhere then, so that day's runs only
    // look for stuck sends. :45 keeps it off the monthly report's :25 slot.
    expect(scheduleSpy).toHaveBeenCalledWith('45 * 1-8 * *', expect.any(Function), { timezone: 'America/Phoenix' })
    // The 8th, not the 7th: 00:45 Phoenix on the 7th is still 21:45 on the 6th
    // in Honolulu, which is a SENDING hour there. By the 8th's first Phoenix
    // run every US zone is past its catch-up day.
    expect(statementMonthDue(new Date('2026-09-07T07:45:00Z'), 'Pacific/Honolulu')).toBe('2026-08')
    for (const tz of ['Pacific/Honolulu', 'America/Anchorage', 'America/Phoenix', 'America/New_York']) {
      expect(statementMonthDue(new Date('2026-09-08T07:45:00Z'), tz), tz).toBeNull()  // the 8th's first run (Phoenix)
      expect(statementMonthDue(new Date('2026-09-02T07:45:00Z'), tz), tz).toBeNull()  // the 2nd's first run
    }
  })
})

describe('the owner statement email', () => {
  it('goes to the owner with the PDF attached, every park and the manager named', async () => {
    const c = await db.connect()
    let o: Owner
    try {
      const pm = await pmCompany(c, 'Hilltop Management')
      o = await owner(c, { pmCompanyId: pm.id, businessName: 'Olive Owner LLC', parks: [
        { name: 'Cedar Grove', ownerShare: 880, pmFee: 100 },
        { name: 'Birch Hollow', ownerShare: 980, pmFee: 110 },
      ] })
    } finally { c.release() }

    const r = await runOwnerStatementEmails({ now: THIRD_9AM, only: [o.landlordId] })
    expect(r).toMatchObject({ statements: 1, due: 1, sent: 1, notSent: 0, skipped: 0 })
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const a = sendSpy.mock.calls[0][0]
    expect(a).toMatchObject({
      to: o.email,
      entityName: 'Olive Owner LLC',
      pmCompanyName: 'Hilltop Management',
      monthLabel: 'August 2026',
      landlordId: o.landlordId,
      statementUrl: null,
    })
    expect(a.totals).toMatchObject({ ownerShare: 1860, managementFee: 210, net: 1860 })
    expect(a.rows.map((x: any) => [x.name, x.ownerShare, x.managementFee]).sort())
      .toEqual([['Birch Hollow', 980, 110], ['Cedar Grove', 880, 100]])
    expect(Buffer.isBuffer(a.pdf) && a.pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(a.filename).toBe('Owner-statement-Olive-Owner-LLC-2026-08.pdf')
    // A reply reaches the manager, not GAM.
    expect(a.replyTo).toEqual({ kind: 'person', userId: (await ownerStatementsDue([o.landlordId]))[0].replyToUserId })

    // The delivery record, and what the owner-facing endpoints read off it.
    expect(await sends(o.landlordId)).toEqual([expect.objectContaining({
      month: MONTH, email: o.email, status: 'sent', attempts: 1, has_sent_at: true, last_error: null,
    })])
    const pmCompanyId = (await ownerStatementsDue([o.landlordId]))[0].pmCompanyId
    const d = await ownerStatementDelivery({ landlordId: o.landlordId, pmCompanyId, periodMonth: `${MONTH}-01` })
    expect(d).toMatchObject({ status: 'sent', email: o.email, attempts: 1, lastError: null })
    expect(d!.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('sends exactly once per owner per month: a second run and a catch-up run send nothing more', async () => {
    const c = await db.connect()
    let o: Owner
    try {
      const pm = await pmCompany(c, 'Hilltop Management')
      o = await owner(c, { pmCompanyId: pm.id, businessName: 'Olive Owner LLC',
        parks: [{ name: 'Cedar Grove', ownerShare: 880 }] })
    } finally { c.release() }

    await runOwnerStatementEmails({ now: THIRD_9AM, only: [o.landlordId] })
    expect(sendSpy).toHaveBeenCalledTimes(1)

    const again = await runOwnerStatementEmails({ now: THIRD_9AM, only: [o.landlordId] })
    expect(again).toMatchObject({ due: 1, sent: 0, notSent: 0, skipped: 1 })
    // The catch-up run on the 5th, and the last one on the 6th.
    for (const when of ['2026-09-05T16:00:00Z', '2026-09-06T23:00:00Z']) {
      const later = await runOwnerStatementEmails({ now: new Date(when), only: [o.landlordId] })
      expect(later, when).toMatchObject({ due: 1, sent: 0, skipped: 1 })
    }
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(await sends(o.landlordId)).toHaveLength(1)
  })

  it('sends nothing to an owner with no properties, and says why rather than a statement of zeros', async () => {
    const c = await db.connect()
    let o: Owner
    try {
      const pm = await pmCompany(c, 'Hilltop Management')
      o = await owner(c, { pmCompanyId: pm.id, businessName: 'Onboarded But Empty LLC', parks: [] })
    } finally { c.release() }

    const r = await runOwnerStatementEmails({ now: THIRD_9AM, only: [o.landlordId] })
    expect(r).toMatchObject({ statements: 1, due: 1, sent: 0, notSent: 1 })
    expect(sendSpy).not.toHaveBeenCalled()
    expect(await sends(o.landlordId)).toEqual([expect.objectContaining({
      status: 'not_sent', has_sent_at: false,
      last_error: 'No properties under Hilltop Management for this month.',
      property_ids: [],
    })])
  })

  it("never puts one owner's numbers in another owner's email, under the same manager", async () => {
    const c = await db.connect()
    let mine: Owner, theirs: Owner
    try {
      const pm = await pmCompany(c, 'Hilltop Management')
      mine = await owner(c, { pmCompanyId: pm.id, businessName: 'Olive Owner LLC',
        parks: [{ name: 'Cedar Grove', ownerShare: 880, pmFee: 100 }] })
      theirs = await owner(c, { pmCompanyId: pm.id, businessName: 'Somebody Else Holdings',
        parks: [{ name: 'Not Your Park', ownerShare: 7654.32, pmFee: 900 }] })
    } finally { c.release() }

    const r = await runOwnerStatementEmails({ now: THIRD_9AM, only: [mine.landlordId, theirs.landlordId] })
    expect(r).toMatchObject({ statements: 2, due: 2, sent: 2 })
    expect(sendSpy).toHaveBeenCalledTimes(2)

    const byEntity = new Map<string, any>(sendSpy.mock.calls.map(([a]: any[]) => [a.entityName, a]))
    const a = byEntity.get('Olive Owner LLC')
    expect(a.to).toBe(mine.email)
    expect(a.totals).toMatchObject({ ownerShare: 880, managementFee: 100 })
    expect(a.rows.map((x: any) => x.name)).toEqual(['Cedar Grove'])
    const b = byEntity.get('Somebody Else Holdings')
    expect(b.to).toBe(theirs.email)
    expect(b.totals).toMatchObject({ ownerShare: 7654.32, managementFee: 900 })
    expect(b.rows.map((x: any) => x.name)).toEqual(['Not Your Park'])
    // And each address got exactly one statement.
    expect(await sends(mine.landlordId)).toHaveLength(1)
    expect(await sends(theirs.landlordId)).toHaveLength(1)
  })

  it('sends one statement per manager to an owner whose book is split between two', async () => {
    const c = await db.connect()
    let o: Owner
    try {
      const pmA = await pmCompany(c, 'Alpha Management')
      const pmB = await pmCompany(c, 'Bravo Management')
      o = await owner(c, { pmCompanyId: pmA.id, businessName: 'Olive Owner LLC',
        parks: [{ name: 'Cedar Grove', ownerShare: 880, pmFee: 100 }] })
      // The same entity, a second manager, a second park.
      await c.query(`INSERT INTO pm_owner_relationships (pm_company_id, landlord_id, status) VALUES ($1,$2,'active')`,
        [pmB.id, o.landlordId])
      const propertyId = await seedProperty(c, {
        landlordId: o.landlordId, ownerUserId: o.userId, managedByUserId: o.userId })
      await c.query(`UPDATE properties SET name = 'Birch Hollow', pm_company_id = $2, timezone = 'America/Phoenix' WHERE id = $1`,
        [propertyId, pmB.id])
      await seedUnit(c, { propertyId, landlordId: o.landlordId, rentAmount: 1000 })
      await c.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, property_id, created_at)
         VALUES ($1,'allocation_owner_share','1500.00',0,$2,$3::date + INTERVAL '9 days')`,
        [o.userId, propertyId, `${MONTH}-01`])
    } finally { c.release() }

    const r = await runOwnerStatementEmails({ now: THIRD_9AM, only: [o.landlordId] })
    expect(r).toMatchObject({ statements: 2, due: 2, sent: 2 })
    const byManager = new Map<string, any>(sendSpy.mock.calls.map(([a]: any[]) => [a.pmCompanyName, a]))
    expect(byManager.get('Alpha Management').rows.map((x: any) => x.name)).toEqual(['Cedar Grove'])
    expect(byManager.get('Alpha Management').totals.ownerShare).toBe(880)
    expect(byManager.get('Bravo Management').rows.map((x: any) => x.name)).toEqual(['Birch Hollow'])
    expect(byManager.get('Bravo Management').totals.ownerShare).toBe(1500)
    // Two rows, one per manager — one shared row would have swallowed the second.
    expect(await sends(o.landlordId)).toHaveLength(2)
  })

  it('skips a demo account and GAM\'s own system company', async () => {
    const c = await db.connect()
    let demo: Owner, system: Owner
    try {
      const pm = await pmCompany(c, 'Hilltop Management')
      demo = await owner(c, { pmCompanyId: pm.id, businessName: 'Demo Parks', demo: true,
        parks: [{ name: 'Demo Park', ownerShare: 880 }] })
      system = await owner(c, { pmCompanyId: pm.id, businessName: 'GAM Renter Pool', system: true,
        parks: [{ name: 'Internal Park', ownerShare: 880 }] })
    } finally { c.release() }

    const r = await runOwnerStatementEmails({ now: THIRD_9AM, only: [demo.landlordId, system.landlordId] })
    expect(r).toMatchObject({ statements: 0, due: 0, sent: 0 })
    expect(sendSpy).not.toHaveBeenCalled()
  })
})

describe('a send the mail service would not take', () => {
  it('is tried again where mail is live, at most three times in all', async () => {
    const c = await db.connect()
    let o: Owner
    try {
      const pm = await pmCompany(c, 'Hilltop Management')
      o = await owner(c, { pmCompanyId: pm.id, businessName: 'Olive Owner LLC',
        parks: [{ name: 'Cedar Grove', ownerShare: 880 }] })
    } finally { c.release() }

    process.env.EMAIL_SEND_LIVE = '1'
    try {
      sendSpy.mockImplementation(async () => null)   // the mail service refused it
      for (let i = 1; i <= OWNER_STATEMENT_MAX_ATTEMPTS + 2; i++) {
        await runOwnerStatementEmails({ now: THIRD_9AM, only: [o.landlordId] })
      }
      expect(sendSpy).toHaveBeenCalledTimes(OWNER_STATEMENT_MAX_ATTEMPTS)
      expect(await sends(o.landlordId)).toEqual([expect.objectContaining({
        status: 'not_sent', attempts: OWNER_STATEMENT_MAX_ATTEMPTS, has_sent_at: false,
      })])
    } finally { delete process.env.EMAIL_SEND_LIVE }
  })

  it('a claim a dead process left at "sending" is never sent twice, and is noticed', async () => {
    const c = await db.connect()
    let o: Owner, pmCompanyId: string
    try {
      const pm = await pmCompany(c, 'Hilltop Management')
      pmCompanyId = pm.id
      o = await owner(c, { pmCompanyId: pm.id, businessName: 'Olive Owner LLC',
        parks: [{ name: 'Cedar Grove', ownerShare: 880 }] })
      // The claim a process took and never came back from.
      await c.query(
        `INSERT INTO owner_statement_sends
           (landlord_id, pm_company_id, period_month, recipient_key, email, user_id, status, updated_at)
         VALUES ($1,$2,$3::date,$4,$4,$5,'sending', $6::timestamptz - INTERVAL '4 hours')`,
        [o.landlordId, pm.id, `${MONTH}-01`, o.email, o.userId, THIRD_9AM.toISOString()])
    } finally { c.release() }

    const r = await runOwnerStatementEmails({ now: THIRD_9AM, only: [o.landlordId] })
    expect(sendSpy).not.toHaveBeenCalled()
    expect(r).toMatchObject({ sent: 0, notSent: 0, skipped: 1, stuck: 1 })

    const notices = await db.query(
      `SELECT title, context->>'send_id' AS send_id FROM admin_notifications WHERE category = $1`,
      [OWNER_STATEMENT_STUCK_CATEGORY])
    expect(notices.rows).toHaveLength(1)
    expect(notices.rows[0].title).toContain('August 2026 owner statement may not have been emailed')

    // One notice per send, ever: a later run does not raise a second.
    expect(await noticeStuckOwnerStatements(THIRD_9AM, [o.landlordId])).toBe(0)
    expect((await db.query(
      `SELECT 1 FROM admin_notifications WHERE category = $1`, [OWNER_STATEMENT_STUCK_CATEGORY])).rows)
      .toHaveLength(1)
    // And the owner-facing endpoints say it is still sending rather than sent.
    expect(await ownerStatementDelivery({ landlordId: o.landlordId, pmCompanyId, periodMonth: `${MONTH}-01` }))
      .toMatchObject({ status: 'sending' })
  })
})

describe('a statement sent by hand', () => {
  it('uses the same claim, so it cannot be sent twice either', async () => {
    const c = await db.connect()
    let o: Owner
    try {
      const pm = await pmCompany(c, 'Hilltop Management')
      o = await owner(c, { pmCompanyId: pm.id, businessName: 'Olive Owner LLC',
        parks: [{ name: 'Cedar Grove', ownerShare: 880 }] })
    } finally { c.release() }

    const due = (await ownerStatementsDue([o.landlordId]))[0]
    expect(await sendOwnerStatement(due, MONTH)).toEqual({ sent: 1, notSent: 0, skipped: 0 })
    expect(await sendOwnerStatement(due, MONTH)).toEqual({ sent: 0, notSent: 0, skipped: 1 })
    expect(sendSpy).toHaveBeenCalledTimes(1)
    // And the cron that comes along afterwards sends nothing.
    const r = await runOwnerStatementEmails({ now: THIRD_9AM, only: [o.landlordId] })
    expect(r).toMatchObject({ due: 1, sent: 0, skipped: 1 })
  })
})
