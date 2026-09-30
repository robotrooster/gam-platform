/**
 * Application → lease PACKET (S593 door, S653 rebuilt). The listings marketplace
 * converges on the same Master Schedule as every other door — through the
 * signing packet, never a bare lease row. Nic: "that edit window should not
 * even fucking exist."
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

async function seedFixture(opts: { bg?: string; moveIn?: string | null; term?: number | null; template?: boolean } = {}): Promise<Fx> {
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
      `INSERT INTO unit_applications (unit_id, landlord_id, applicant_user_id, first_name, last_name, email, move_in_date, desired_term_months)
       VALUES ($1,$2,$3,'Rina','Renter',$4,$5,$6) RETURNING id`,
      [unitId, landlordId, applicantUserId, `app-${randomUUID()}@t.dev`,
       opts.moveIn === undefined ? '2026-09-01' : opts.moveIn, opts.term ?? null])
    const applicationId = a.rows[0].id
    if (opts.template !== false) {
      const t = await client.query<{ id: string }>(
        `INSERT INTO lease_templates (landlord_id, name, page_count, unit_type, deposit_months, default_term_months, is_unit_type_default)
         VALUES ($1, 'Primary Apartment', 1, 'apartment', 1, 12, true) RETURNING id`, [landlordId])
      for (const col of ['rent_amount', 'security_deposit', 'start_date', 'end_date', 'lease_type']) {
        await client.query(
          `INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y, width, height)
           VALUES ($1, 'text', 'landlord', $2, 1, 10, 10, 100, 20)`, [t.rows[0].id, col])
      }
      await client.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','primary','tenant_signature',1,10,100)`, [t.rows[0].id])
      await client.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','landlord','landlord_signature',1,10,180)`, [t.rows[0].id])
    }
    await client.query('COMMIT')
    return { landlordUserId, landlordId, unitId, applicantUserId, applicationId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const fieldVals = async (documentId: string) => Object.fromEntries((await db.query<any>(
  `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1 AND lease_column IS NOT NULL`, [documentId])).rows.map((x: any) => [x.lease_column, x.value]))
const liveDrafts = async (unitId: string) => (await db.query<any>(
  `SELECT id FROM lease_documents WHERE unit_id=$1 AND document_type='original_lease' AND status <> 'voided'`, [unitId])).rows

describe('draftLeaseFromApplication', () => {
  it('drafts the signing packet with the applicant as primary, rent from the unit, start from the application', async () => {
    const fx = await seedFixture({ term: 12 })
    const r = await draftLeaseFromApplication(fx.applicationId)
    expect(r.drafted).toBe(true)
    expect(r.documentId).toBeTruthy()
    const signers = (await db.query<any>(`SELECT role, user_id FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [r.documentId])).rows
    expect(signers.map((x: any) => x.role)).toEqual(['landlord', 'primary'])
    expect(signers[1].user_id).toBe(fx.applicantUserId)
    const vals = await fieldVals(r.documentId!)
    expect(vals.rent_amount).toBe('1350.00')
    expect(vals.start_date).toBe(new Date() > new Date('2026-09-01') ? new Date().toISOString().slice(0, 10) : '2026-09-01')
    // never a bare lease row
    expect((await db.query(`SELECT 1 FROM leases WHERE source_application_id=$1`, [fx.applicationId])).rows).toHaveLength(0)
    // the household is on the space
    expect((await db.query(`SELECT 1 FROM pending_tenant_intents WHERE unit_id=$1 AND cancelled_at IS NULL`, [fx.unitId])).rows).toHaveLength(1)
  })

  it('is idempotent — one packet per applicant on the space', async () => {
    const fx = await seedFixture({ term: 12 })
    const a = await draftLeaseFromApplication(fx.applicationId)
    const b = await draftLeaseFromApplication(fx.applicationId)
    expect(b.documentId).toBe(a.documentId)
    expect(await liveDrafts(fx.unitId)).toHaveLength(1)
  })

  it('drafts month-to-month with no end date when no term was named', async () => {
    const fx = await seedFixture({ term: null })
    const r = await draftLeaseFromApplication(fx.applicationId)
    const vals = await fieldVals(r.documentId!)
    expect(vals.lease_type).toBe('Month-to-month')
    expect(vals.end_date).toBe('-')
  })

  it('drafts a fixed term, month-end snapped, when one was named', async () => {
    const fx = await seedFixture({ moveIn: '2027-01-01', term: 6 })
    const r = await draftLeaseFromApplication(fx.applicationId)
    const vals = await fieldVals(r.documentId!)
    expect(vals.lease_type).toBe('Fixed term')
    expect(vals.start_date).toBe('2027-01-01')
    expect(vals.end_date).toBe('2027-06-30')
  })

  it('says so when the unit type has no default template — the applicant still lands on the space', async () => {
    const fx = await seedFixture({ template: false })
    const r = await draftLeaseFromApplication(fx.applicationId)
    expect(r).toMatchObject({ drafted: false, needsTemplate: true, reason: 'needs_template' })
    expect((await db.query(`SELECT 1 FROM pending_tenant_intents WHERE unit_id=$1 AND cancelled_at IS NULL`, [fx.unitId])).rows).toHaveLength(1)
  })
})

describe('POST /api/properties/applications/:id/onboard', () => {
  it('landlord onboards their applicant → 201 + the packet to sign', async () => {
    const fx = await seedFixture({ term: 12 })
    const res = await request(buildApp())
      .post(`/api/properties/applications/${fx.applicationId}/onboard`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
    expect(res.status).toBe(201)
    expect(res.body.data.documentId).toBeTruthy()
    expect(res.body.data.drafted).toBe(true)
  })

  it('second onboard returns the same packet', async () => {
    const fx = await seedFixture({ term: 12 })
    const app = buildApp()
    const tok = llToken(fx.landlordUserId, fx.landlordId)
    const r1 = await request(app).post(`/api/properties/applications/${fx.applicationId}/onboard`).set('Authorization', `Bearer ${tok}`)
    const r2 = await request(app).post(`/api/properties/applications/${fx.applicationId}/onboard`).set('Authorization', `Bearer ${tok}`)
    expect(r2.status).toBe(201)
    expect(r2.body.data.documentId).toBe(r1.body.data.documentId)
    expect(r2.body.data.drafted).toBe(false)
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
    expect(await liveDrafts(fx.unitId)).toHaveLength(0)
  })
})
