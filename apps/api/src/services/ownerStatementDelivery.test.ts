/**
 * PM readiness 4 — who a statement is due to, and "sent on X".
 *
 * Two things that have to be right or the delivery is worse than none:
 *   - the DUE list, because it decides who is emailed their own money. An
 *     owner's statement is not a manager's to withhold (S645), so an unopened
 *     portal must not keep one off the list; a demo or internal account must
 *     stay off it, because those addresses bounce.
 *   - the DELIVERY record the owner-facing endpoints print, which must be the
 *     send for THIS manager and THIS month and no other.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedUserBankAccount, seedPmCompany,
} from '../test/dbHelpers'
import { ownerStatementsDue, ownerStatementDelivery } from './ownerStatementDelivery'
import { pmRouter } from '../routes/pm'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_owner_statement'
})

const MONTH = '2026-08-01'

interface Managed {
  landlordId: string; userId: string; pmCompanyId: string; pmStaffUserId: string
  propertyId: string; email: string; ownerToken: string
}

/** A manager, an owner, and a park of theirs it runs. */
async function managed(opts: { pmName?: string; businessName?: string } = {}): Promise<Managed> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    await client.query(`UPDATE landlords SET business_name = $2 WHERE id = $1`,
      [landlordId, opts.businessName ?? 'Olive Owner LLC'])
    const bankId = await seedUserBankAccount(client, { userId })
    const pmCompanyId = await seedPmCompany(client, {
      bankAccountId: bankId, name: opts.pmName ?? 'Hilltop Management' })
    const pmStaffUserId = (await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','property_manager','Pat','Manager',TRUE) RETURNING id`,
      [`pm-${randomUUID().slice(0, 8)}@test.dev`])).rows[0].id
    await client.query(
      `INSERT INTO pm_staff (pm_company_id, user_id, role, status) VALUES ($1,$2,'owner','active')`,
      [pmCompanyId, pmStaffUserId])
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    // The trigger on properties opens the pm_owner_relationship.
    await client.query(`UPDATE properties SET pm_company_id = $2, timezone = 'America/Phoenix' WHERE id = $1`,
      [propertyId, pmCompanyId])
    await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    const email = (await client.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email
    return {
      landlordId, userId, pmCompanyId, pmStaffUserId, propertyId, email,
      ownerToken: jwt.sign(
        { userId, role: 'landlord', email, profileId: userId, permissions: {}, landlordIds: [landlordId] },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } finally { client.release() }
}

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pm', pmRouter)
  app.use(errorHandler)
  return app
}

async function recordSend(o: Managed, opts: {
  month?: string; status?: string; sentAt?: string | null; email?: string; pmCompanyId?: string
} = {}): Promise<string> {
  const email = opts.email ?? o.email
  return (await db.query<{ id: string }>(`
    INSERT INTO owner_statement_sends
      (landlord_id, pm_company_id, period_month, recipient_key, email, user_id, status, sent_at)
    VALUES ($1,$2,$3::date,$4,$4,$5,$6,$7::timestamptz) RETURNING id`,
    [o.landlordId, opts.pmCompanyId ?? o.pmCompanyId, opts.month ?? MONTH,
     email.toLowerCase(), o.userId, opts.status ?? 'sent',
     opts.sentAt === undefined ? '2026-09-03T15:00:00Z' : opts.sentAt])).rows[0].id
}

describe('who a statement is due to', () => {
  it('lists the owner, their manager, the address and where a reply lands', async () => {
    const o = await managed()
    const due = await ownerStatementsDue([o.landlordId])
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({
      landlordId: o.landlordId,
      pmCompanyId: o.pmCompanyId,
      pmCompanyName: 'Hilltop Management',
      entityName: 'Olive Owner LLC',
      ownerName: 'Test Landlord',
      email: o.email,
      // The manager's owner-role staff member, not GAM.
      replyToUserId: o.pmStaffUserId,
      timezone: 'America/Phoenix',
    })
  })

  it('does NOT wait for a manager to open the portal — S645, an owner\'s own money', async () => {
    const o = await managed()
    expect((await db.query(
      `SELECT portal_access FROM pm_owner_relationships WHERE landlord_id = $1`, [o.landlordId])).rows[0])
      .toMatchObject({ portal_access: 'none' })
    expect(await ownerStatementsDue([o.landlordId])).toHaveLength(1)
  })

  it('falls back to the entity name a person goes by when there is no company name', async () => {
    const o = await managed()
    await db.query(`UPDATE landlords SET business_name = NULL WHERE id = $1`, [o.landlordId])
    expect((await ownerStatementsDue([o.landlordId]))[0].entityName).toBe('Test Landlord')
  })

  it('drops a relationship that ended, and a suspended manager', async () => {
    const ended = await managed()
    await db.query(`UPDATE pm_owner_relationships SET status = 'ended' WHERE landlord_id = $1`, [ended.landlordId])
    const suspended = await managed()
    await db.query(`UPDATE pm_companies SET status = 'suspended' WHERE id = $1`, [suspended.pmCompanyId])
    expect(await ownerStatementsDue([ended.landlordId, suspended.landlordId])).toHaveLength(0)
  })

  it('leaves demo and internal accounts off, because those addresses bounce', async () => {
    const demo = await managed()
    await db.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [demo.landlordId])
    const system = await managed()
    await db.query(`UPDATE landlords SET is_system = TRUE WHERE id = $1`, [system.landlordId])
    expect(await ownerStatementsDue([demo.landlordId, system.landlordId])).toHaveLength(0)
  })

  it('reports no reply address rather than a wrong one when the manager has no owner-role staff', async () => {
    const o = await managed()
    await db.query(`UPDATE pm_staff SET status = 'removed' WHERE pm_company_id = $1`, [o.pmCompanyId])
    expect((await ownerStatementsDue([o.landlordId]))[0].replyToUserId).toBeNull()
  })
})

describe('"sent on X"', () => {
  it('is null until one has been sent', async () => {
    const o = await managed()
    expect(await ownerStatementDelivery({
      landlordId: o.landlordId, pmCompanyId: o.pmCompanyId, periodMonth: MONTH })).toBeNull()
  })

  it('reads the send for THIS manager and THIS month, never another', async () => {
    const o = await managed()
    const other = await managed({ pmName: 'Other Management' })
    await recordSend(o)
    await recordSend(o, { month: '2026-07-01', email: 'old@test.dev' })
    await recordSend(other)

    const d = await ownerStatementDelivery({
      landlordId: o.landlordId, pmCompanyId: o.pmCompanyId, periodMonth: MONTH })
    expect(d).toMatchObject({ status: 'sent', email: o.email, attempts: 1, lastError: null })
    expect(d!.sentAt).toBe('2026-09-03T15:00:00.000Z')

    // Another manager's send is never this manager's answer.
    expect(await ownerStatementDelivery({
      landlordId: o.landlordId, pmCompanyId: other.pmCompanyId, periodMonth: MONTH })).toBeNull()
    // A month with no send of its own stays null.
    expect(await ownerStatementDelivery({
      landlordId: o.landlordId, pmCompanyId: o.pmCompanyId, periodMonth: '2026-09-01' })).toBeNull()
  })

  it('accepts a month written either way', async () => {
    const o = await managed()
    await recordSend(o)
    for (const m of ['2026-08', '2026-08-01', '2026-08-31']) {
      expect(await ownerStatementDelivery({
        landlordId: o.landlordId, pmCompanyId: o.pmCompanyId, periodMonth: m }), m)
        .toMatchObject({ status: 'sent' })
    }
  })

  it('says why it has not gone, in the words the job recorded', async () => {
    const o = await managed()
    const id = await recordSend(o, { status: 'not_sent', sentAt: null })
    await db.query(
      `UPDATE owner_statement_sends SET last_error = $2, attempts = 2 WHERE id = $1`,
      [id, 'The mail service did not accept it.'])
    expect(await ownerStatementDelivery({
      landlordId: o.landlordId, pmCompanyId: o.pmCompanyId, periodMonth: MONTH }))
      .toMatchObject({ status: 'not_sent', sentAt: null, attempts: 2,
        lastError: 'The mail service did not accept it.' })
  })
})

describe('what the owner-facing endpoints print', () => {
  it('carries the delivery beside the statement on the owner\'s own list', async () => {
    const o = await managed()
    await recordSend(o)
    const res = await request(buildApp())
      .get('/api/pm/my-statements?month=2026-08')
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].statement.periodMonth).toBe('2026-08-01')
    expect(res.body.data[0].delivery).toMatchObject({
      status: 'sent', email: o.email, sentAt: '2026-09-03T15:00:00.000Z',
    })
  })

  it('carries it on the manager\'s view of the same statement, so the two agree', async () => {
    const o = await managed()
    await recordSend(o)
    const staffToken = jwt.sign(
      { userId: o.pmStaffUserId, role: 'property_manager', email: 'pat@test.dev',
        profileId: o.pmStaffUserId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get(`/api/pm/companies/${o.pmCompanyId}/owners/${o.landlordId}/statement?month=2026-08`)
      .set('Authorization', `Bearer ${staffToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.delivery).toMatchObject({ status: 'sent', sentAt: '2026-09-03T15:00:00.000Z' })
  })

  it('says null rather than inventing a send that never happened', async () => {
    const o = await managed()
    const res = await request(buildApp())
      .get('/api/pm/my-statements?month=2026-08')
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data[0].delivery).toBeNull()
  })
})
