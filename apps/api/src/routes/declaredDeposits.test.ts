/**
 * S624 — the "I paid at the bank" routes.
 *
 * What matters here is that a declaration is a CLAIM and behaves like one: it
 * changes no balance, it cannot be made about somebody else's lease, and it
 * cannot be withdrawn once it has become a settled payment.
 */
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { DateTime } from 'luxon'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { declaredDepositsRouter } from './declaredDeposits'
import { errorHandler } from '../middleware/errorHandler'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/declared-deposits', declaredDepositsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_declared'
})

const sign = (claims: any) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Fx {
  tenantId: string; tenantUserId: string; leaseId: string; landlordId: string
  landlordUserId: string; unitId: string; token: string; landlordToken: string
}

async function fixture(): Promise<Fx> {
  const client = await getClient()
  try {
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 250 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 250 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const tu = (await client.query(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0]
    return {
      tenantId, tenantUserId: tu.user_id, leaseId, landlordId, landlordUserId, unitId,
      token: sign({ id: tu.user_id, userId: tu.user_id, role: 'tenant', profileId: tenantId }),
      landlordToken: sign({ id: landlordUserId, userId: landlordUserId,
                            role: 'landlord', profileId: landlordId }),
    }
  } finally { client.release() }
}

// S624: these used UTC, so after 5pm Phoenix they produced TOMORROW's date and
// the suite started failing every evening. Use the property's own zone, which is
// what the route compares against.
const phx = (offsetDays = 0) =>
  DateTime.now().setZone('America/Phoenix').plus({ days: offsetDays }).toISODate()!
const today = () => phx()
const daysAgo = (n: number) => phx(-n)

describe('a tenant reporting a deposit', () => {
  it('records the claim and says the balance has not moved', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    expect(res.status).toBe(200)
    // The single most important sentence on the screen: this did not pay anything.
    expect(res.body.data.message).toMatch(/balance stays the same/i)
    expect(res.body.data.trusted).toBe(true)

    const row = (await db.query(
      `SELECT status, amount::float AS amount, method FROM tenant_declared_deposits
        WHERE tenant_id=$1`, [f.tenantId])).rows[0]
    expect(row.status).toBe('pending')
    expect(row.amount).toBe(250)
  })

  // The anti-fraud property, asserted directly: a claim credits NOTHING.
  it('creates no payment, no credit, and no change to what is owed', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type,
                             amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',250,'pending',CURRENT_DATE,'RENT')`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])

    await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })

    const rent = (await db.query(
      `SELECT status, amount::float AS amount FROM payments WHERE lease_id=$1`,
      [f.leaseId])).rows[0]
    expect(rent.status).toBe('pending')
    expect(rent.amount).toBe(250)
    const credits = await db.query(`SELECT 1 FROM tenant_credits`)
    expect(credits.rowCount).toBe(0)
  })

  it('refuses a date in the future, in words', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250,
              // Two days out — one day of slack is allowed on purpose, for a
              // tenant east of the property who is already on tomorrow's date.
              declaredDate: phx(2),
              method: 'cash' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/after you have made it/i)
  })

  it('refuses something too old to chase and points at the landlord', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: daysAgo(60), method: 'cash' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/contact your landlord/i)
  })

  it('treats a double-tap as the same report, not a second deposit', async () => {
    const f = await fixture()
    const body = { leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' }
    const a = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`).send(body)
    const b = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`).send(body)
    expect(b.body.data.id).toBe(a.body.data.id)
    expect(b.body.data.alreadyReported).toBe(true)
    const n = await db.query(`SELECT COUNT(*)::int AS n FROM tenant_declared_deposits`)
    expect(n.rows[0].n).toBe(1)
  })

  it('cannot report against somebody else’s lease', async () => {
    const mine = await fixture()
    const theirs = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ leaseId: theirs.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    expect(res.status).toBe(404)
  })

  it('a landlord cannot report on a tenant’s behalf', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    expect(res.status).toBe(403)
  })
})

describe('withdrawing a report', () => {
  it('lets the tenant take back a claim they have not proved', async () => {
    const f = await fixture()
    const made = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    const res = await request(buildApp())
      .delete(`/api/declared-deposits/${made.body.data.id}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const row = (await db.query(
      `SELECT status FROM tenant_declared_deposits WHERE id=$1`,
      [made.body.data.id])).rows[0]
    // Withdrawn, not deleted — GAM keeps everything.
    expect(row.status).toBe('withdrawn')
  })

  it('cannot take back one that has already settled a payment', async () => {
    const f = await fixture()
    const made = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    await db.query(
      `UPDATE tenant_declared_deposits SET status='unconfirmed' WHERE id=$1`,
      [made.body.data.id])
    const res = await request(buildApp())
      .delete(`/api/declared-deposits/${made.body.data.id}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(409)
  })

  it('cannot withdraw someone else’s', async () => {
    const mine = await fixture()
    const theirs = await fixture()
    const made = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${theirs.token}`)
      .send({ leaseId: theirs.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    const res = await request(buildApp())
      .delete(`/api/declared-deposits/${made.body.data.id}`)
      .set('Authorization', `Bearer ${mine.token}`)
    expect(res.status).toBe(409)
  })
})

describe('the landlord’s view', () => {
  it('shows open reports for their own tenants only', async () => {
    const a = await fixture()
    const b = await fixture()
    await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ leaseId: a.leaseId, amount: 250, declaredDate: today(), method: 'check' })
    await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ leaseId: b.leaseId, amount: 250, declaredDate: today(), method: 'cash' })

    const res = await request(buildApp()).get('/api/declared-deposits/landlord/open')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].method).toBe('check')
    expect(res.body.data[0].prior_unconfirmed).toBe(0)
  })
})

// S655 review: with no bank linked nothing can match a report and it never
// expires, so "we will apply it automatically — usually a day or two" with a
// 7-day clock was a promise GAM could not keep (Country Acres / TruBlu).
// "Linked" means GAM is reading the bank right now: an active link that has
// synced at least once — the same thing the expiry job needs before it writes
// a report off.
async function linkBank(landlordId: string, opts: { status?: string; synced?: boolean } = {}) {
  await db.query(
    `INSERT INTO bank_connections (landlord_id, provider, stripe_fc_account_id, institution_name, display_name,
                                   status, last_synced_at)
     VALUES ($1,'stripe_fc','fca_' || substr(md5(random()::text), 1, 8),'Test Bank','Test Bank ••1111',$2,
             CASE WHEN $3::boolean THEN NOW() END)`,
    [landlordId, opts.status ?? 'active', opts.synced ?? true])
}

describe('what the tenant is told depends on whether GAM is reading the landlord’s bank', () => {
  const report = (f: Fx) => request(buildApp()).post('/api/declared-deposits')
    .set('Authorization', `Bearer ${f.token}`)
    .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })

  it('no bank linked: the landlord checks by hand, the tenant is told to let them know, and no expiry is promised', async () => {
    const f = await fixture()
    const res = await report(f)
    expect(res.status).toBe(200)
    expect(res.body.data.bankFeedLinked).toBe(false)
    expect(res.body.data.message).toMatch(/isn’t connected to GAM right now/i)
    expect(res.body.data.message).toMatch(/let your landlord know/i)
    expect(res.body.data.message).toMatch(/balance stays the same/i)
    expect(res.body.data.message).not.toMatch(/automatically|day or two|expire/i)
    expect(res.body.data).not.toHaveProperty('expiresInDays')
  })

  it('a disconnected bank counts as no bank', async () => {
    const f = await fixture()
    await linkBank(f.landlordId, { status: 'disconnected' })
    const res = await report(f)
    expect(res.body.data.bankFeedLinked).toBe(false)
    expect(res.body.data).not.toHaveProperty('expiresInDays')
  })

  it('a bank link whose sync is failing is told the same — and is not told the landlord never linked one', async () => {
    const f = await fixture()
    await linkBank(f.landlordId, { status: 'error' })
    const res = await report(f)
    expect(res.body.data.bankFeedLinked).toBe(false)
    expect(res.body.data.message).not.toMatch(/hasn’t connected/i)
    expect(res.body.data.message).toMatch(/right now/i)
    expect(res.body.data).not.toHaveProperty('expiresInDays')
  })

  it('a bank linked but never read yet promises nothing automatic', async () => {
    const f = await fixture()
    await linkBank(f.landlordId, { synced: false })
    const res = await report(f)
    expect(res.body.data.bankFeedLinked).toBe(false)
    expect(res.body.data.message).not.toMatch(/automatically/i)
    expect(res.body.data).not.toHaveProperty('expiresInDays')
  })

  it('bank linked and read: GAM watches the feed and applies it automatically, with the 7-day window', async () => {
    const f = await fixture()
    await linkBank(f.landlordId)
    const res = await report(f)
    expect(res.body.data.bankFeedLinked).toBe(true)
    expect(res.body.data.message).toMatch(/apply it automatically/i)
    expect(res.body.data.expiresInDays).toBe(7)
  })

  // S655 review: the agent relays the reply. A double tap answered with only
  // { id, alreadyReported } left it unable to tell a tenant at a company with
  // no bank read to let the landlord know and keep the slip.
  it('reported twice, no bank read: says it was already reported, with the same next step', async () => {
    const f = await fixture()
    const first = await report(f)
    const again = await report(f)
    expect(again.status).toBe(200)
    expect(again.body.data).toMatchObject({ id: first.body.data.id, alreadyReported: true, bankFeedLinked: false })
    expect(again.body.data.message).toMatch(/^You already reported this deposit\. /)
    expect(again.body.data.message).toMatch(/let your landlord know you paid and keep your deposit slip/i)
    expect(again.body.data.message).not.toMatch(/automatically|day or two|expire/i)
    expect(again.body.data).not.toHaveProperty('expiresInDays')
    expect((await db.query(`SELECT count(*)::int AS n FROM tenant_declared_deposits`)).rows[0].n).toBe(1)
  })

  it('reported twice, bank read: says it was already reported, and that GAM applies it, with the 7-day window', async () => {
    const f = await fixture()
    await linkBank(f.landlordId)
    const first = await report(f)
    const again = await report(f)
    expect(again.body.data).toMatchObject({ id: first.body.data.id, alreadyReported: true, bankFeedLinked: true })
    expect(again.body.data.message).toMatch(/^You already reported this deposit\. /)
    expect(again.body.data.message).toMatch(/apply it automatically/i)
    expect(again.body.data.message).not.toMatch(/Reported\./)
    expect(again.body.data.expiresInDays).toBe(7)
  })
})

describe('the report window knows before submitting whether GAM can watch', () => {
  const ask = (f: Fx, leaseId = f.leaseId, token = f.token) =>
    request(buildApp()).get(`/api/declared-deposits/feed/${leaseId}`).set('Authorization', `Bearer ${token}`)

  it('no bank: says so, with no expiry window', async () => {
    const f = await fixture()
    const res = await ask(f)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ leaseId: f.leaseId, bankFeedLinked: false })
  })

  it('a bank GAM reads: says so, with the 7-day window', async () => {
    const f = await fixture()
    await linkBank(f.landlordId)
    const res = await ask(f)
    expect(res.body.data).toEqual({ leaseId: f.leaseId, bankFeedLinked: true, expiresInDays: 7 })
  })

  it('cannot ask about somebody else’s lease', async () => {
    const mine = await fixture()
    const theirs = await fixture()
    await linkBank(theirs.landlordId)
    const res = await ask(mine, theirs.leaseId)
    expect(res.status).toBe(404)
  })

  it('only a tenant can ask', async () => {
    const f = await fixture()
    const res = await ask(f, f.leaseId, f.landlordToken)
    expect(res.status).toBe(403)
  })
})

describe('the tenant’s list of reports', () => {
  it('says which lease each report is for, so the payments page can show it under that lease', async () => {
    const f = await fixture()
    await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    const res = await request(buildApp()).get('/api/declared-deposits').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].lease_id).toBe(f.leaseId)
  })

  it('says whether GAM is watching that landlord’s bank for each report', async () => {
    const f = await fixture()
    await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    const get = () => request(buildApp()).get('/api/declared-deposits').set('Authorization', `Bearer ${f.token}`)
    expect((await get()).body.data[0].bank_feed_linked).toBe(false)
    await linkBank(f.landlordId)
    expect((await get()).body.data[0].bank_feed_linked).toBe(true)
  })
})

// S655 (Step 12): a match the landlord undoes gives the tenant their report back.
describe('a report whose deposit match is undone', () => {
  it('is waiting again, and the tenant may withdraw it', async () => {
    const f = await fixture()
    const { autoSettleDeclaredDeposits } = await import('../services/bankFeed')
    const { undoDepositMatch } = await import('../services/bankDepositConfirm')
    const rent = (await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',250,'pending',$5::date,'RENT') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId, today()])).rows[0].id
    const made = await request(buildApp()).post('/api/declared-deposits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 250, declaredDate: today(), method: 'cash' })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const conn = (await db.query(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`, [f.landlordId])).rows[0].id
    const txn = (await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,'d1',$3::date,250,'ATM CASH DEPOSIT','needs_review') RETURNING id`, [conn, f.landlordId, today()])).rows[0].id
    expect(await autoSettleDeclaredDeposits(f.landlordId)).toBe(1)
    expect((await db.query(`SELECT status FROM tenant_declared_deposits WHERE id=$1`, [made.body.data.id])).rows[0].status).toBe('confirmed')

    await undoDepositMatch({ bankTransactionId: txn, landlordId: f.landlordId, undoneBy: f.landlordUserId })
    expect((await db.query(`SELECT status FROM tenant_declared_deposits WHERE id=$1`, [made.body.data.id])).rows[0].status).toBe('pending')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [rent])).rows[0].status).toBe('pending')
    // The feed never settles it again by itself — the landlord said no.
    expect(await autoSettleDeclaredDeposits(f.landlordId)).toBe(0)
    const res = await request(buildApp())
      .delete(`/api/declared-deposits/${made.body.data.id}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })
})
