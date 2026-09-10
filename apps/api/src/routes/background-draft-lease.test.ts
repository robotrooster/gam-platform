/**
 * S639 (Nic): "I've marked him as approved, but what is the next course of
 * action? I need to generate him a lease... I wanted to just, like, draft up a
 * lease, essentially, from the information on the background check."
 *
 * The screening now asks when they want to move in and how long they want the
 * space, so an approval has everything a draft needs. This route files the
 * screening as an application and hands it to the ONE lease drafter — it does
 * not grow a second one.
 *
 * The thing this test is really guarding is the walk-up case: a QR applicant
 * named no unit, so the landlord picks one at the drafting step, and that pick
 * is a body-supplied id — it has to be ownership-checked, because unit numbers
 * repeat across parks and a lease filed at the wrong property is a real one.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_draftlease'
})

const llToken = (userId: string, landlordId: string) => jwt.sign(
  { userId, role: 'landlord', email: 'll@t.dev', landlordIds: [landlordId], permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Fx {
  landlordUserId: string; landlordId: string
  propertyId: string; unitId: string
  applicantUserId: string; checkId: string
}

async function seedFixture(opts: {
  status?: string
  withUnit?: boolean
  moveIn?: string | null
  term?: number | null
  monthToMonth?: boolean
} = {}): Promise<Fx> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 725 })
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','Walk','Up',TRUE) RETURNING id`, [`walkup-${randomUUID()}@t.dev`])
    const applicantUserId = u.rows[0].id
    const bc = await c.query<{ id: string }>(
      `INSERT INTO background_checks
         (landlord_id, user_id, unit_id, property_id, status, first_name, last_name,
          desired_move_in, desired_term_months, desired_month_to_month)
       VALUES ($1,$2,$3,$4,$5,'Walk','Up',$6,$7,$8) RETURNING id`,
      [landlordId, applicantUserId, opts.withUnit ? unitId : null, propertyId,
       opts.status ?? 'approved',
       opts.moveIn === undefined ? '2026-10-01' : opts.moveIn,
       opts.term ?? null, !!opts.monthToMonth])
    await c.query('COMMIT')
    return { landlordUserId, landlordId, propertyId, unitId, applicantUserId, checkId: bc.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('POST /api/background/:id/draft-lease', () => {
  it('drafts a fixed-term lease from an approved screening that named a unit', async () => {
    const fx = await seedFixture({ withUnit: true, term: 6 })
    const res = await request(buildApp())
      .post(`/api/background/${fx.checkId}/draft-lease`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
      .send({})
    expect(res.status).toBe(200)
    const leaseId = res.body.data.leaseId
    const l = (await db.query<any>('SELECT * FROM leases WHERE id=$1', [leaseId])).rows[0]
    expect(l.unit_id).toBe(fx.unitId)
    expect(l.status).toBe('pending')
    expect(l.needs_review).toBe(true)
    expect(l.lease_type).toBe('fixed_term')
    expect(l.start_date.toISOString().slice(0, 10)).toBe('2026-10-01')
    expect(l.end_date.toISOString().slice(0, 10)).toBe('2027-03-31')
    expect(Number(l.rent_amount)).toBe(725)
  })

  it('drafts month-to-month when the applicant said month to month', async () => {
    const fx = await seedFixture({ withUnit: true, monthToMonth: true })
    const res = await request(buildApp())
      .post(`/api/background/${fx.checkId}/draft-lease`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
      .send({})
    expect(res.status).toBe(200)
    const l = (await db.query<any>('SELECT lease_type, end_date FROM leases WHERE id=$1', [res.body.data.leaseId])).rows[0]
    expect(l.lease_type).toBe('month_to_month')
    expect(l.end_date).toBeNull()
  })

  it('takes the unit the landlord picks for a walk-up who named none', async () => {
    const fx = await seedFixture({ withUnit: false, term: 12 })
    const res = await request(buildApp())
      .post(`/api/background/${fx.checkId}/draft-lease`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
      .send({ unitId: fx.unitId })
    expect(res.status).toBe(200)
    const l = (await db.query<any>('SELECT unit_id FROM leases WHERE id=$1', [res.body.data.leaseId])).rows[0]
    expect(l.unit_id).toBe(fx.unitId)
  })

  it('refuses a unit belonging to somebody else — a picked id is never trusted', async () => {
    const mine = await seedFixture({ withUnit: false })
    const theirs = await seedFixture({ withUnit: false })
    const res = await request(buildApp())
      .post(`/api/background/${mine.checkId}/draft-lease`)
      .set('Authorization', `Bearer ${llToken(mine.landlordUserId, mine.landlordId)}`)
      .send({ unitId: theirs.unitId })
    expect(res.status).toBe(404)
    const n = await db.query<any>('SELECT COUNT(*)::int AS c FROM leases')
    expect(n.rows[0].c).toBe(0)
  })

  it('will not draft before the screening is approved', async () => {
    const fx = await seedFixture({ withUnit: true, status: 'complete' })
    const res = await request(buildApp())
      .post(`/api/background/${fx.checkId}/draft-lease`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('will not read another account’s screening', async () => {
    const mine = await seedFixture({ withUnit: true })
    const theirs = await seedFixture({ withUnit: true })
    const res = await request(buildApp())
      .post(`/api/background/${theirs.checkId}/draft-lease`)
      .set('Authorization', `Bearer ${llToken(mine.landlordUserId, mine.landlordId)}`)
      .send({})
    expect(res.status).toBe(404)
  })

  it('a second click returns the same draft instead of a second lease', async () => {
    const fx = await seedFixture({ withUnit: true, term: 12 })
    const app = buildApp()
    const auth = `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`
    const a = await request(app).post(`/api/background/${fx.checkId}/draft-lease`).set('Authorization', auth).send({})
    const b = await request(app).post(`/api/background/${fx.checkId}/draft-lease`).set('Authorization', auth).send({})
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.body.data.leaseId).toBe(a.body.data.leaseId)
    const n = await db.query<any>('SELECT COUNT(*)::int AS c FROM leases')
    expect(n.rows[0].c).toBe(1)
    const m = await db.query<any>('SELECT COUNT(*)::int AS c FROM unit_applications WHERE background_check_id=$1', [fx.checkId])
    expect(m.rows[0].c).toBe(1)
  })
})
