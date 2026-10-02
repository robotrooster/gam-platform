/**
 * S639 → S653 (Nic): an approved screening turns into the LEASE PACKET for the
 * landlord's signature — not a bare lease row and not an edit window.
 *
 *   "It needs to draft a lease for my signature first, not just the fucking
 *    little window that pops up for nothing."
 *
 * The applicant lands on the space as a unit-bound intent (the same row the
 * Tenants-page invite writes), the packet drafts off the unit's default
 * template with them as primary and the move-in date and term they gave at
 * screening, and the landlord is first signer. A walk-up who scanned the park
 * QR named no space, so the landlord picks one — a body-supplied id that has
 * to be ownership-checked, because unit numbers repeat across parks.
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
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

type Fx = { landlordUserId: string; landlordId: string; propertyId: string; unitId: string; applicantUserId: string; checkId: string }

async function seedFixture(opts: {
  status?: string
  withUnit?: boolean
  moveIn?: string | null
  term?: number | null
  monthToMonth?: boolean
  template?: boolean
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
       opts.moveIn === undefined ? MOVE_IN : opts.moveIn,
       opts.term ?? null, !!opts.monthToMonth])
    if (opts.template !== false) {
      const t = await c.query<{ id: string }>(
        `INSERT INTO lease_templates (landlord_id, name, page_count, unit_type, deposit_months, default_term_months, is_unit_type_default)
         VALUES ($1, 'Primary Apartment', 1, 'apartment', 1, 12, true) RETURNING id`, [landlordId])
      const tid = t.rows[0].id
      for (const col of ['rent_amount', 'security_deposit', 'start_date', 'end_date', 'lease_type']) {
        await c.query(
          `INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y, width, height)
           VALUES ($1, 'text', 'landlord', $2, 1, 10, 10, 100, 20)`, [tid, col])
      }
      await c.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','primary','tenant_signature',1,10,100)`, [tid])
      await c.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','landlord','landlord_signature',1,10,180)`, [tid])
    }
    await c.query('COMMIT')
    return { landlordUserId, landlordId, propertyId, unitId, applicantUserId, checkId: bc.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const liveDrafts = async (unitId: string) => (await db.query<any>(
  `SELECT id, status FROM lease_documents WHERE unit_id=$1 AND document_type='original_lease' AND status <> 'voided' ORDER BY created_at`, [unitId])).rows
const signers = async (documentId: string) => (await db.query<any>(
  `SELECT role, order_index, user_id FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [documentId])).rows
const fieldVals = async (documentId: string) => Object.fromEntries((await db.query<any>(
  `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1 AND lease_column IS NOT NULL`, [documentId])).rows.map((x: any) => [x.lease_column, x.value]))

const draft = (fx: Fx, body: any = {}) => request(buildApp())
  .post(`/api/background/${fx.checkId}/draft-lease`)
  .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
  .send(body)

// S654: the move-in was hard-coded to 2026-10-01; once that day passed the
// drafter (correctly) never starts a lease in the past and moved it to today.
// Take a future first-of-month from the database's own calendar instead.
let MOVE_IN = ''
let MOVE_IN_PLUS_6_END = ''
beforeAll(async () => {
  const r = await db.query<{ a: string; b: string }>(
    `SELECT (date_trunc('month', CURRENT_DATE) + interval '2 months')::date::text AS a,
            (date_trunc('month', CURRENT_DATE) + interval '8 months' - interval '1 day')::date::text AS b`)
  MOVE_IN = r.rows[0].a; MOVE_IN_PLUS_6_END = r.rows[0].b
})

describe('POST /api/background/:id/draft-lease', () => {
  it('drafts the signing packet with the applicant as primary and the landlord first, carrying their dates', async () => {
    const fx = await seedFixture({ withUnit: true, term: 6 })
    const res = await draft(fx)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.drafted).toBe(true)
    const docId = res.body.data.documentId
    expect(docId).toBeTruthy()

    const s = await signers(docId)
    expect(s.map((x: any) => x.role)).toEqual(['landlord', 'primary'])
    expect(s[1].user_id).toBe(fx.applicantUserId)
    const vals = await fieldVals(docId)
    expect(vals.start_date).toBe(MOVE_IN)
    expect(vals.end_date).toBe(MOVE_IN_PLUS_6_END)      // 6 months, month-end snapped
    expect(vals.lease_type).toBe('Fixed term')
    expect(vals.rent_amount).toBe('725.00')

    // The household is on the space the way an invite puts them there.
    const intent = (await db.query(`SELECT unit_id, draft_document_id FROM pending_tenant_intents WHERE unit_id=$1 AND cancelled_at IS NULL`, [fx.unitId])).rows
    expect(intent).toHaveLength(1)
    expect(intent[0].draft_document_id).toBe(docId)
    // and NO bare lease row was written outside the packet
    expect((await db.query(`SELECT 1 FROM leases WHERE lease_source = 'application_draft'`)).rows).toHaveLength(0)
  })

  it('drafts month-to-month when the applicant said month to month', async () => {
    const fx = await seedFixture({ withUnit: true, monthToMonth: true })
    const res = await draft(fx)
    expect(res.status).toBe(200)
    const vals = await fieldVals(res.body.data.documentId)
    expect(vals.lease_type).toBe('Month-to-month')
    expect(vals.end_date).toBe('-')   // the document's own "no end date" mark
  })

  it('takes the unit the landlord picks for a walk-up who named none, and remembers it', async () => {
    const fx = await seedFixture({ withUnit: false, term: 12 })
    const res = await draft(fx, { unitId: fx.unitId })
    expect(res.status).toBe(200)
    expect(res.body.data.unitId).toBe(fx.unitId)
    const bc = (await db.query(`SELECT unit_id FROM background_checks WHERE id=$1`, [fx.checkId])).rows[0]
    expect(bc.unit_id).toBe(fx.unitId)
  })

  it('refuses a unit belonging to somebody else — a picked id is never trusted', async () => {
    const fx = await seedFixture({ withUnit: false })
    const other = await seedFixture({ withUnit: true })
    const res = await draft(fx, { unitId: other.unitId })
    expect(res.status).toBe(404)
    expect(await liveDrafts(other.unitId)).toHaveLength(0)
  })

  it('will not draft before the screening is approved', async () => {
    const fx = await seedFixture({ withUnit: true, status: 'complete' })
    const res = await draft(fx)
    expect(res.status).toBe(400)
  })

  it('will not read another account’s screening', async () => {
    const fx = await seedFixture({ withUnit: true })
    const stranger = await seedFixture({ withUnit: true })
    const res = await request(buildApp())
      .post(`/api/background/${fx.checkId}/draft-lease`)
      .set('Authorization', `Bearer ${llToken(stranger.landlordUserId, stranger.landlordId)}`)
      .send({})
    expect(res.status).toBe(404)
  })

  it('a second click returns the same packet instead of a second one', async () => {
    const fx = await seedFixture({ withUnit: true, term: 6 })
    const a = await draft(fx)
    const b = await draft(fx)
    expect(b.status).toBe(200)
    expect(await liveDrafts(fx.unitId)).toHaveLength(1)
    expect(b.body.data.documentId).toBe(a.body.data.documentId)
  })

  it('says so when the unit type has no default template — the household stays on the space', async () => {
    const fx = await seedFixture({ withUnit: true, term: 6, template: false })
    const res = await draft(fx)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ drafted: false, needsTemplate: true, documentId: null })
    expect((await db.query(`SELECT 1 FROM pending_tenant_intents WHERE unit_id=$1 AND cancelled_at IS NULL`, [fx.unitId])).rows).toHaveLength(1)
  })
})

// S653 (Nic): "When we approve somebody for a background check, it doesn't
// automatically draft up a lease for me to sign... that should start another
// workflow." Approval IS the workflow.
describe('PATCH /api/background/:id/decision — approval drafts the packet', () => {
  it('approving a screening that named a space drafts its packet in the same click', async () => {
    const fx = await seedFixture({ withUnit: true, term: 6, status: 'complete' })
    const res = await request(buildApp())
      .patch(`/api/background/${fx.checkId}/decision`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
      .send({ decision: 'approved' })
    expect(res.status).toBe(200)
    expect(res.body.data.needsUnit).toBe(false)
    expect(res.body.data.lease?.documentId).toBeTruthy()
    expect(await liveDrafts(fx.unitId)).toHaveLength(1)
    const bc = (await db.query<any>('SELECT status FROM background_checks WHERE id=$1', [fx.checkId])).rows[0]
    expect(bc.status).toBe('approved')
  })

  it('a walk-up with no space named is approved and told to pick one', async () => {
    const fx = await seedFixture({ withUnit: false, term: 6, status: 'complete' })
    const res = await request(buildApp())
      .patch(`/api/background/${fx.checkId}/decision`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
      .send({ decision: 'approved' })
    expect(res.status).toBe(200)
    expect(res.body.data.needsUnit).toBe(true)
    expect(res.body.data.lease).toBeNull()
    expect(await liveDrafts(fx.unitId)).toHaveLength(0)
  })

  it('a denial drafts nothing', async () => {
    const fx = await seedFixture({ withUnit: true, term: 6, status: 'complete' })
    const res = await request(buildApp())
      .patch(`/api/background/${fx.checkId}/decision`)
      .set('Authorization', `Bearer ${llToken(fx.landlordUserId, fx.landlordId)}`)
      .send({ decision: 'denied' })
    expect(res.status).toBe(200)
    expect(res.body.data.lease).toBeNull()
    expect(await liveDrafts(fx.unitId)).toHaveLength(0)
  })
})
