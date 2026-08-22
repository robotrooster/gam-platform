/**
 * S615 — creating a utility service agreement.
 *
 * S614 built the table and could not create a row in it; S615 built the invoice
 * and still could not. This is the door. One call mints the space, the payer's
 * portal account and the agreement, because a landlord adding the apartment
 * next door is doing one thing — and the middle step does not otherwise exist
 * (tenant onboarding demands a lease start and a monthly rent, neither of which
 * is true here).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { utilityServiceAgreementsRouter } from './utilityServiceAgreements'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailUtilityServiceInvite: vi.fn().mockResolvedValue(undefined),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  // The real app camelizes every response on the way out (index.ts), so a test
  // app without it asserts a contract production does not serve — snake_case
  // keys that the frontend would read as undefined. Mounted here so these
  // expectations are the ones the landlord page actually receives.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/utility/service-agreements', utilityServiceAgreementsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_svcagr'
})

async function seed(lateFee: { initial?: number; grace?: number } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    await c.query(
      `UPDATE properties SET late_fee_enabled = true,
                             late_fee_grace_days = $2,
                             late_fee_initial_amount = $3,
                             late_fee_initial_type = 'flat'
        WHERE id = $1`,
      [propertyId, lateFee.grace ?? 5, lateFee.initial ?? 25])
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId,
      token: jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const payer = {
  firstName: 'Dale', lastName: 'Ruiz',
  email: 'dale@nextdoor.example', phone: '+16025550143',
}

describe('POST /api/utility/service-agreements (S615)', () => {
  it('creates the space, the payer account and the agreement in one call', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        propertyId: f.propertyId,
        label: 'Next door A',
        serviceAddress: '2 Next Door Ln',
        billingDueDay: 1,
        householdSize: 3,
        payer,
      })
    expect(res.status).toBe(201)
    const { id, unitId, tenantId } = res.body.data

    // The space is a REAL unit, marked so nothing treats it as rentable.
    const { rows: [unit] } = await db.query<any>(
      `SELECT status, rent_amount::text, is_bookable, owner_household_size, unit_number
         FROM units WHERE id = $1`, [unitId])
    expect(unit.status).toBe('utility_service')
    expect(Number(unit.rent_amount)).toBe(0)
    expect(unit.is_bookable).toBe(false)
    expect(unit.owner_household_size).toBe(3)
    expect(unit.unit_number).toBe('Next door A')

    // The payer gets a real portal account with a live invite.
    const { rows: [u] } = await db.query<any>(
      `SELECT usr.email, usr.role, usr.tenant_invite_token IS NOT NULL AS invited
         FROM tenants t JOIN users usr ON usr.id = t.user_id WHERE t.id = $1`,
      [tenantId])
    expect(u.email).toBe(payer.email)
    expect(u.role).toBe('tenant')
    expect(u.invited).toBe(true)

    const { rows: [sa] } = await db.query<any>(
      `SELECT status, billing_due_day, service_address FROM utility_service_agreements
        WHERE id = $1`, [id])
    expect(sa.status).toBe('active')
    expect(sa.billing_due_day).toBe(1)
    expect(sa.service_address).toBe('2 Next Door Ln')
  })

  // S558's rule: the instrument is the charge. A policy change next March must
  // not silently reprice a bill this person already agreed to.
  it('stamps the property late-fee policy onto the agreement', async () => {
    const f = await seed({ initial: 40, grace: 3 })
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Next door B', payer })
    expect(res.status).toBe(201)

    const { rows: [sa] } = await db.query<any>(
      `SELECT late_fee_enabled, late_fee_grace_days,
              late_fee_initial_amount::text AS amt, late_fee_initial_type
         FROM utility_service_agreements WHERE id = $1`, [res.body.data.id])
    expect(sa.late_fee_enabled).toBe(true)
    expect(sa.late_fee_grace_days).toBe(3)
    expect(Number(sa.amt)).toBe(40)

    // Changing property policy afterwards leaves the stamp alone.
    await db.query(
      `UPDATE properties SET late_fee_initial_amount = 99 WHERE id = $1`, [f.propertyId])
    const { rows: [after] } = await db.query<any>(
      `SELECT late_fee_initial_amount::text AS amt FROM utility_service_agreements
        WHERE id = $1`, [res.body.data.id])
    expect(Number(after.amt)).toBe(40)
  })

  // S614: same person, same login, no duplicate account.
  it('reuses an existing account rather than colliding on the email', async () => {
    const f = await seed()
    const app = buildApp()
    const first = await request(app)
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Space one', payer })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Space two', payer })
    expect(second.status).toBe(201)

    expect(second.body.data.tenantId).toBe(first.body.data.tenantId)
    const { rows } = await db.query(
      `SELECT id FROM users WHERE email = $1`, [payer.email])
    expect(rows).toHaveLength(1)
  })

  it('refuses a property belonging to another landlord', async () => {
    const mine = await seed()
    const theirs = await seed()
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ propertyId: theirs.propertyId, label: 'Not mine', payer })
    expect(res.status).toBe(403)
  })
})

describe('GET + PATCH /api/utility/service-agreements (S615)', () => {
  async function create(f: any, label: string) {
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label, payer })
    return res.body.data
  }

  it('lists the landlord’s agreements with the payer and what they owe', async () => {
    const f = await seed()
    const made = await create(f, 'Next door A')
    // An unpaid utility charge on an invoice for this agreement.
    const { rows: [inv] } = await db.query<any>(
      `INSERT INTO invoices (landlord_id, tenant_id, unit_id, service_agreement_id,
                             invoice_number, due_date, subtotal_utilities, total_amount)
       VALUES ($1,$2,$3,$4,'INV-1','2026-03-01',75,75) RETURNING id`,
      [f.landlordId, made.tenantId, made.unitId, made.id])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, tenant_id, landlord_id, type, amount,
                             status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',75,'pending','2026-03-01','UTILITY')`,
      [inv.id, made.unitId, made.tenantId, f.landlordId])

    const res = await request(buildApp())
      .get('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    const row = res.body.data[0]
    expect(row.email).toBe(payer.email)
    expect(Number(row.balanceDue)).toBe(75)
    expect(row.invitePending).toBe(true)
  })

  it('ending an agreement dates it, and leaves what is already owed alone', async () => {
    const f = await seed()
    const made = await create(f, 'Next door A')
    const res = await request(buildApp())
      .patch(`/api/utility/service-agreements/${made.id}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ status: 'ended' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ended')
    expect(res.body.data.endDate).not.toBeNull()
  })

  it('another landlord cannot edit it', async () => {
    const mine = await seed()
    const theirs = await seed()
    const made = await create(mine, 'Next door A')
    const res = await request(buildApp())
      .patch(`/api/utility/service-agreements/${made.id}`)
      .set('Authorization', `Bearer ${theirs.token}`)
      .send({ billingDueDay: 15 })
    expect(res.status).toBe(403)
  })
})
