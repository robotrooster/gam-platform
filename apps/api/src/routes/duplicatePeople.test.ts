/**
 * 10/20 (Nic) — WHO MAY BE TOLD, AND WHO MAY ANSWER.
 *
 *   "But have it be always have the landlord check that the customer is the
 *    same."
 *
 * Looking is for anybody who may see the Tenants list. ANSWERING changes a
 * sign-in address and moves reservations between people, so it takes the key
 * that already means "I vouch for who this resident is" (tenants.invite) — the
 * same one that lets somebody skip a background check for a resident they know.
 * A front desk that can take a payment cannot decide who a person is.
 *
 * And the boundary that matters most: one account's questions are its own.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

let duplicatePeopleRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_duplicate_people'
  ;({ duplicatePeopleRouter } = await import('./duplicatePeople'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/duplicate-people', duplicatePeopleRouter)
  app.use(errorHandler)
  return app
}

/** A park with two halves of one guest on its board. */
async function parkWithADouble(email?: string) {
  const c = await db.connect()
  let fixture: any
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c, email ? { email } : {})
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    await c.query('COMMIT')
    fixture = { userId, landlordId, propertyId, unitId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

  // The file spelled him one way with an address; the text thread gave the same
  // phone and no address at all.
  await query(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, guest_phone,
       lease_type, check_in, check_out, nights, status)
     VALUES ($1,$2,'Robert Jenkins','rj@cox.net','(928) 555-1234','nightly','2027-03-01','2027-03-08',7,'confirmed'),
            ($1,$2,'JENKINS, ROBERT',NULL,'928-555-1234','nightly','2027-05-01','2027-05-08',7,'confirmed')`,
    [fixture.unitId, fixture.landlordId])

  fixture.token = jwt.sign(
    { userId: fixture.userId, role: 'landlord', email: 'll@t.dev',
      profileId: fixture.landlordId, landlordIds: [fixture.landlordId], permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return fixture
}

/** A worker at this park with exactly these boxes ticked. */
async function worker(f: any, perms: Record<string, boolean>) {
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`,
    [`desk-${randomUUID()}@t.dev`])
  await query(
    `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
     VALUES ($1,$2,$3,FALSE,$4)`,
    [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
  return jwt.sign(
    { userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

const list = (token: string, qs = '') =>
  request(buildApp()).get(`/api/duplicate-people${qs}`).set('Authorization', `Bearer ${token}`)

const same = (token: string, id: string, body: any) =>
  request(buildApp()).post(`/api/duplicate-people/${id}/same-person`)
    .set('Authorization', `Bearer ${token}`).send(body)

const different = (token: string, id: string) =>
  request(buildApp()).post(`/api/duplicate-people/${id}/not-duplicate`)
    .set('Authorization', `Bearer ${token}`).send({})

describe('GET /api/duplicate-people', () => {
  it('looks fresh on the way in and asks the question in sentences', async () => {
    const f = await parkWithADouble()
    const res = await list(f.token)
    expect(res.status).toBe(200)
    expect(res.body.data.openCount).toBe(1)
    const p = res.body.data.proposals[0]
    expect(p.confidence).toBe('strong')
    // Sentences, never the stored values, and built from the one shared list.
    expect(p.reasons).toEqual(['Same name', 'Same phone number'])
    expect(p.a.name).toBeTruthy()
    expect(p.b.name).toBeTruthy()
    expect(res.body.data.scanned.raised).toBe(1)
  })

  it('?scan=0 reads the list without looking again', async () => {
    const f = await parkWithADouble()
    const res = await list(f.token, '?scan=0')
    expect(res.status).toBe(200)
    expect(res.body.data.scanned).toBeNull()
    expect(res.body.data.openCount).toBe(0)
  })

  it('NEVER shows one account another account\'s people', async () => {
    const mine = await parkWithADouble(`nic-${randomUUID()}@test.dev`)
    const theirs = await parkWithADouble(`blu-${randomUUID()}@test.dev`)
    const res = await list(mine.token)
    expect(res.body.data.openCount).toBe(1)
    const ids = res.body.data.proposals.map((p: any) => p.id)

    const theirRes = await list(theirs.token)
    expect(theirRes.body.data.openCount).toBe(1)
    const theirIds = theirRes.body.data.proposals.map((p: any) => p.id)
    expect(theirIds.some((id: string) => ids.includes(id))).toBe(false)

    // And the other account cannot answer the question it was never shown.
    const refused = await different(theirs.token, ids[0])
    expect(refused.status).toBe(404)
  })

  it('a worker who may see the Tenants list may look', async () => {
    const f = await parkWithADouble()
    const token = await worker(f, { 'tenants.view': true })
    const res = await list(token)
    expect(res.status).toBe(200)
    expect(res.body.data.openCount).toBe(1)
  })

  it('a worker with no tenants box at all is refused', async () => {
    const f = await parkWithADouble()
    const token = await worker(f, { 'pos.ring_sale': true })
    expect((await list(token)).status).toBe(403)
  })
})

describe('answering', () => {
  async function openId(token: string) {
    const res = await list(token)
    return res.body.data.proposals[0]
  }

  it('a worker who may look may NOT decide who a person is', async () => {
    const f = await parkWithADouble()
    const p = await openId(f.token)
    const token = await worker(f, { 'tenants.view': true, 'pos.ring_sale': true })
    expect((await different(token, p.id)).status).toBe(403)
    expect((await same(token, p.id, { keeperSide: 'a' })).status).toBe(403)
    // Still open, still unanswered.
    expect((await list(f.token)).body.data.openCount).toBe(1)
  })

  it('a worker trusted with who a resident is may answer', async () => {
    const f = await parkWithADouble()
    const p = await openId(f.token)
    const token = await worker(f, { 'tenants.view': true, 'tenants.invite': true })
    const res = await different(token, p.id)
    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(/two different people/i)
  })

  it('"different people" sticks through every later look', async () => {
    const f = await parkWithADouble()
    const p = await openId(f.token)
    expect((await different(f.token, p.id)).status).toBe(200)
    expect((await list(f.token)).body.data.openCount).toBe(0)
    expect((await list(f.token)).body.data.openCount).toBe(0)
    const decided = (await list(f.token)).body.data.decided
    expect(decided).toHaveLength(1)
    expect(decided[0].status).toBe('not_duplicate')
  })

  it('"same person" joins them, says what happened, and answers the question for good', async () => {
    const f = await parkWithADouble()
    const p = await openId(f.token)
    // The one carrying the address is the one that can stay — it is the only
    // thing two reservations can be joined on.
    const keeperSide = p.a.email ? 'a' : 'b'
    const res = await same(f.token, p.id, { keeperSide })
    expect(res.status).toBe(200)
    expect(res.body.data.emailsFilled).toBe(1)
    expect(res.body.message).toMatch(/rj@cox\.net/)
    expect(res.body.message).toMatch(/nothing was deleted/i)

    // Both reservations are still on the board.
    const rows = await query<{ n: string }>(`SELECT count(*) AS n FROM unit_bookings`)
    expect(Number(rows[0].n)).toBe(2)
    expect((await list(f.token)).body.data.openCount).toBe(0)
  })

  it('refuses an answer that does not say who stays', async () => {
    const f = await parkWithADouble()
    const p = await openId(f.token)
    const res = await same(f.token, p.id, {})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/which of the two should stay/i)
  })

  it('refuses a question id that is not a question', async () => {
    const f = await parkWithADouble()
    expect((await different(f.token, 'not-a-uuid')).status).toBe(400)
    expect((await different(f.token, randomUUID())).status).toBe(404)
  })

  it('tells a GAM admin plainly that this is a landlord\'s own book', async () => {
    const f = await parkWithADouble()
    const adminToken = jwt.sign(
      { userId: randomUUID(), role: 'super_admin', email: 'nic@golddoor.io', permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await list(adminToken)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/No landlord scope/i)
    expect(f.token).toBeTruthy()
  })
})
