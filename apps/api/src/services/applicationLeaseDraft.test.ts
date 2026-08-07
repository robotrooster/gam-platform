/**
 * Application → draft lease bridge (S593 defrag). The long-term listings
 * marketplace converges on the same Master Schedule as short-term bookings.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { propertiesRouter } from '../routes/properties'
import { errorHandler } from '../middleware/errorHandler'
import { draftLeaseFromApplication } from './applicationLeaseDraft'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_appdraft'
})

const llToken = (userId: string, landlordId: string) =>
  jwt.sign({ userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Fx {
  landlordUserId: string; landlordId: string
  unitId: string; applicantUserId: string; applicationId: string
}

async function seedFixture(opts: { bg?: string; moveIn?: string | null } = {}): Promise<Fx> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1350 })
    const ru = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','Rina','Renter',TRUE) RETURNING id`, [`app-${randomUUID()}@t.dev`])
    const applicantUserId = ru.rows[0].id
    await client.query(`INSERT INTO tenants (user_id, background_check_status) VALUES ($1,$2)`,
      [applicantUserId, opts.bg ?? 'approved'])
    const a = await client.query<{ id: string }>(
      `INSERT INTO unit_applications (unit_id, landlord_id, applicant_user_id, first_name, last_name, email, move_in_date)
       VALUES ($1,$2,$3,'Rina','Renter',$4,$5) RETURNING id`,
      [unitId, landlordId, applicantUserId, `app-${randomUUID()}@t.dev`,
       opts.moveIn === undefined ? '2026-09-01' : opts.moveIn])
    const applicationId = a.rows[0].id
    await client.query('COMMIT')
    return { landlordUserId, landlordId, unitId, applicantUserId, applicationId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

describe('draftLeaseFromApplication', () => {
  it('drafts a pending/needs-review lease from an application', async () => {
    const fx = await seedFixture()
    const r = await draftLeaseFromApplication(fx.applicationId)
    expect(r.drafted).toBe(true)
    expect(r.leaseId).toBeTruthy()
    const l = (await db.query<any>('SELECT * FROM leases WHERE id=$1', [r.leaseId])).rows[0]
    expect(l.status).toBe('pending')
    expect(l.needs_review).toBe(true)
    expect(l.lease_source).toBe('application_draft')
    expect(l.source_application_id).toBe(fx.applicationId)
    expect(l.unit_id).toBe(fx.unitId)
    expect(Number(l.rent_amount)).toBe(1350)
    expect(l.start_date.toISOString().slice(0, 10)).toBe('2026-09-01') // move_in_date flowed to start
  })

  it('is idempotent — one draft per application', async () => {
    const fx = await seedFixture()
    const r1 = await draftLeaseFromApplication(fx.applicationId)
    const r2 = await draftLeaseFromApplication(fx.applicationId)
    expect(r2.drafted).toBe(false)
    expect(r2.leaseId).toBe(r1.leaseId)
    const n = await db.query<any>('SELECT COUNT(*)::int AS c FROM leases WHERE source_application_id=$1', [fx.applicationId])
    expect(n.rows[0].c).toBe(1)
  })

  it('falls back to CURRENT_DATE when the application has no move-in date', async () => {
    const fx = await seedFixture({ moveIn: null })
    const r = await draftLeaseFromApplication(fx.applicationId)
    const l = (await db.query<any>('SELECT start_date FROM leases WHERE id=$1', [r.leaseId])).rows[0]
    expect(l.start_date).not.toBeNull()
  })
})

describe('POST /api/properties/applications/:id/onboard', () => {
  it('landlord onboards their applicant → 201 + draft leaseId', async () => {
    const fx = await seedFixture()
    const res = await request(buildApp())
      .post(`/api/properties/applications/${fx.applicationId}/onboard`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
    expect(res.status).toBe(201)
    expect(res.body.data.leaseId).toBeTruthy()
    expect(res.body.data.alreadyDrafted).toBe(false)
  })

  it('second onboard is idempotent (alreadyDrafted)', async () => {
    const fx = await seedFixture()
    const app = buildApp()
    const tok = llToken(fx.landlordUserId, fx.landlordId)
    await request(app).post(`/api/properties/applications/${fx.applicationId}/onboard`).set('Authorization', `Bearer ${tok}`)
    const res2 = await request(app).post(`/api/properties/applications/${fx.applicationId}/onboard`).set('Authorization', `Bearer ${tok}`)
    expect(res2.status).toBe(201)
    expect(res2.body.data.alreadyDrafted).toBe(true)
  })

  it("another landlord cannot onboard someone else's application → 403", async () => {
    const fx = await seedFixture()
    const client = await getClient()
    let otherUserId = '', otherLandlordId = ''
    try {
      await client.query('BEGIN')
      const o = await seedLandlord(client)
      otherUserId = o.userId; otherLandlordId = o.landlordId
      await client.query('COMMIT')
    } finally { client.release() }
    const res = await request(buildApp())
      .post(`/api/properties/applications/${fx.applicationId}/onboard`)
      .set('Authorization', `Bearer ${llToken(otherUserId, otherLandlordId)}`)
    expect(res.status).toBe(403)
    const n = await db.query<any>('SELECT COUNT(*)::int AS c FROM leases WHERE source_application_id=$1', [fx.applicationId])
    expect(n.rows[0].c).toBe(0)
  })
})
