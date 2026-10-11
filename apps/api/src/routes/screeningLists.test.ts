/**
 * S653 (Nic): two lists for one table.
 *
 *   "the main background checks page is only showing people that need
 *    attention... I want a full database of everybody that the platform ever
 *    does background checks on system-wide for the admin portal."
 *
 * The landlord's page sorts each check into `attention` or `past` on the
 * server — denied/expired/cancelled/failed are past, approved is past once a
 * lease (or a live lease packet) exists for that person under that landlord,
 * and everything else still needs somebody to act. The admin database shows
 * every check under every landlord, to super-admins only.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { adminRouter } from './admin'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', adminRouter)
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_screening_lists'
})

const sign = (userId: string, role: string, extra: any = {}) => jwt.sign(
  { userId, role, email: 'x@test.dev', permissions: {}, ...extra }, process.env.JWT_SECRET!, { expiresIn: '1h' })

async function world() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const other = await seedLandlord(c)
    const otherProperty = await seedProperty(c, { landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId })
    const mkApplicant = async (first: string) => {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','tenant',$2,'Applicant',TRUE) RETURNING id`, [`${first.toLowerCase()}-${randomUUID()}@t.dev`, first])
      const t = await c.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
      return { userId: u.rows[0].id, tenantId: t.rows[0].id }
    }
    const mkCheck = async (landlordId: string, propId: string, userId: string, status: string, first: string) => (await c.query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, property_id, status, first_name, last_name, decided_at)
       VALUES ($1,$2,$3,$4,$5,'Applicant', CASE WHEN $4 IN ('approved','denied') THEN NOW() END) RETURNING id`,
      [landlordId, userId, propId, status, first])).rows[0].id

    const waiting = await mkApplicant('Waiting')
    const undecided = await mkApplicant('Undecided')
    const approvedNoLease = await mkApplicant('Approvednolease')
    const housed = await mkApplicant('Housed')
    const denied = await mkApplicant('Denied')
    const stranger = await mkApplicant('Stranger')

    const ids = {
      waiting: await mkCheck(ll.landlordId, propertyId, waiting.userId, 'awaiting_applicant', 'Waiting'),
      undecided: await mkCheck(ll.landlordId, propertyId, undecided.userId, 'complete', 'Undecided'),
      approvedNoLease: await mkCheck(ll.landlordId, propertyId, approvedNoLease.userId, 'approved', 'Approvednolease'),
      housed: await mkCheck(ll.landlordId, propertyId, housed.userId, 'approved', 'Housed'),
      denied: await mkCheck(ll.landlordId, propertyId, denied.userId, 'denied', 'Denied'),
      stranger: await mkCheck(other.landlordId, otherProperty, stranger.userId, 'approved', 'Stranger'),
    }
    // Housed: a lease exists for them under this landlord.
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, status: 'active', startDate: '2026-09-01' })
    await seedLeaseTenant(c, { leaseId, tenantId: housed.tenantId })
    await c.query('COMMIT')
    return { ll, other, ids }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe("the landlord's screening list", () => {
  it('sorts every check into attention or past', async () => {
    const w = await world()
    const res = await request(buildApp()).get('/api/background')
      .set('Authorization', `Bearer ${sign(w.ll.userId, 'landlord', { landlordIds: [w.ll.landlordId] })}`)
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    const by = Object.fromEntries(res.body.data.map((c: any) => [c.first_name, c]))
    expect(Object.keys(by).sort(), JSON.stringify(res.body.data.map((c: any) => c.status))).toHaveLength(5)
    expect(by.Waiting.bucket).toBe('attention')
    expect(by.Undecided.bucket).toBe('attention')
    expect(by.Approvednolease.bucket).toBe('attention')
    expect(by.Approvednolease.housed).toBe(false)
    expect(by.Housed.bucket).toBe('past')
    expect(by.Housed.housed).toBe(true)
    expect(by.Denied.bucket).toBe('past')
    expect(by.Stranger).toBeUndefined()          // another landlord's screening
  })
})

describe("the platform's screening database", () => {
  it('shows every check under every landlord to a super-admin, with filters', async () => {
    const w = await world()
    const su = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','super_admin','S','U',TRUE) RETURNING id`, [`su-${randomUUID()}@t.dev`])).rows[0].id
    const token = sign(su, 'super_admin')
    const all = await request(buildApp()).get('/api/admin/screenings').set('Authorization', `Bearer ${token}`)
    expect(all.status).toBe(200)
    expect(all.body.data.total).toBe(6)
    expect(all.body.data.rows.map((r: any) => r.first_name).sort()).toEqual(
      ['Approvednolease', 'Denied', 'Housed', 'Stranger', 'Undecided', 'Waiting'])
    expect(all.body.data.rows.find((r: any) => r.first_name === 'Housed').housed).toBe(true)
    expect(all.body.data.landlords).toHaveLength(2)

    const approved = await request(buildApp()).get('/api/admin/screenings?status=approved').set('Authorization', `Bearer ${token}`)
    expect(approved.body.data.total).toBe(3)
    const one = await request(buildApp()).get(`/api/admin/screenings?landlordId=${w.other.landlordId}`).set('Authorization', `Bearer ${token}`)
    expect(one.body.data.rows.map((r: any) => r.first_name)).toEqual(['Stranger'])
    const search = await request(buildApp()).get('/api/admin/screenings?q=undec').set('Authorization', `Bearer ${token}`)
    expect(search.body.data.rows.map((r: any) => r.first_name)).toEqual(['Undecided'])
  })

  it('is closed to a regular admin and to landlords', async () => {
    const w = await world()
    const admin = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','admin','A','D',TRUE) RETURNING id`, [`ad-${randomUUID()}@t.dev`])).rows[0].id
    expect((await request(buildApp()).get('/api/admin/screenings').set('Authorization', `Bearer ${sign(admin, 'admin')}`)).status).toBe(403)
    expect((await request(buildApp()).get('/api/admin/screenings')
      .set('Authorization', `Bearer ${sign(w.ll.userId, 'landlord', { landlordIds: [w.ll.landlordId] })}`)).status).toBe(403)
  })
})

// S653 (Nic): "keep them approved but mark them as dormant for now... so this
// last one for Anastacio does not just forever say that it needs attention."
describe('an approved applicant set aside', () => {
  it('leaves the to-do list while parked, still approved, and comes back on un-park', async () => {
    const w = await world()
    const token = sign(w.ll.userId, 'landlord', { landlordIds: [w.ll.landlordId] })
    const park = await request(buildApp()).post(`/api/background/${w.ids.approvedNoLease}/park`)
      .set('Authorization', `Bearer ${token}`).send({ note: 'went back to Oregon for the winter' })
    expect(park.status).toBe(200)
    let list = (await request(buildApp()).get('/api/background').set('Authorization', `Bearer ${token}`)).body.data
    let row = list.find((c: any) => c.id === w.ids.approvedNoLease)
    expect(row.status).toBe('approved')
    expect(row.bucket).toBe('past')
    expect(row.parked_note).toBe('went back to Oregon for the winter')

    const back = await request(buildApp()).post(`/api/background/${w.ids.approvedNoLease}/unpark`).set('Authorization', `Bearer ${token}`)
    expect(back.status).toBe(200)
    list = (await request(buildApp()).get('/api/background').set('Authorization', `Bearer ${token}`)).body.data
    row = list.find((c: any) => c.id === w.ids.approvedNoLease)
    expect(row.bucket).toBe('attention')
    expect(row.parked_at).toBeNull()
  })

  it('only an approved applicant can be set aside', async () => {
    const w = await world()
    const token = sign(w.ll.userId, 'landlord', { landlordIds: [w.ll.landlordId] })
    expect((await request(buildApp()).post(`/api/background/${w.ids.undecided}/park`).set('Authorization', `Bearer ${token}`)).status).toBe(409)
    expect((await request(buildApp()).post(`/api/background/${w.ids.stranger}/park`).set('Authorization', `Bearer ${token}`)).status).toBe(404)
  })
})

// S653 (Nic): "background checks should be good for a year." Not six months —
// that was GAM's own number, not Checkr's.
describe('how long an approval stays good', () => {
  it('stamps a year from the decision', async () => {
    const w = await world()
    const token = sign(w.ll.userId, 'landlord', { landlordIds: [w.ll.landlordId] })
    const res = await request(buildApp()).patch(`/api/background/${w.ids.undecided}/decision`)
      .set('Authorization', `Bearer ${token}`).send({ decision: 'approved' })
    expect(res.status).toBe(200)
    const r = (await db.query(`SELECT (expires_at::date - CURRENT_DATE) AS days FROM background_checks WHERE id=$1`, [w.ids.undecided])).rows[0]
    expect(Number(r.days)).toBeGreaterThanOrEqual(364)
    expect(Number(r.days)).toBeLessThanOrEqual(366)
  })
})
