/**
 * properties route slice — S355.
 *
 * Largest properties.ts surfaces: POST (with allocation rule txn),
 * GET list/get, fee-schedule CRUD, PATCH (late-fee policy fields),
 * PATCH /allocation-rule (fee-payer toggles), PATCH /pm-assignment
 * (cross-table invariants), PATCH /manager (PM-conflict guard).
 *
 * Out of scope:
 *   - /:id/units/bulk — mechanical insert loop (unit_number
 *     generation deterministic; tested would be ceremony)
 *   - Unit photos upload (multer disk write; needs file-system
 *     fixtures)
 *   - /listings public (no-auth, multi-table JOIN; covered by
 *     /:id/eligible-managers + GET /:id for scope semantics)
 *   - /apply public — straightforward INSERT
 *   - /applications listing — mechanical SELECT
 *   - /:id/eligible-managers — joins + filtering; OK to skip
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedManager,
  seedUserBankAccount,
} from '../test/dbHelpers'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_props'
})

interface PropsFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedPropsFixture(): Promise<PropsFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function createProperty(f: PropsFixture, name = 'Test Prop') {
  return request(buildApp())
    .post('/api/properties')
    .set('Authorization', `Bearer ${f.landlordToken}`)
    .send({
      name, street1: '1 main st', city: 'Phoenix', state: 'AZ', zip: '85001',
      type: 'residential',
      allocationRule: {
        bankingFeePayer: 'landlord',
        platformFeePayer: 'landlord',
        rentPercent: 5,
      },
    })
}

describe('POST /api/properties — create', () => {
  it('happy path: property + allocation rule created in same txn', async () => {
    const f = await seedPropsFixture()
    const res = await createProperty(f, 'Acme Apartments')
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Acme Apartments')
    expect(res.body.data.landlord_id).toBe(f.landlordId)

    // Allocation rule row landed
    const ar = await db.query<{ ach_fee_payer: string; card_fee_payer: string; platform_fee_payer: string }>(
      `SELECT ach_fee_payer, card_fee_payer, platform_fee_payer
         FROM property_allocation_rules WHERE property_id=$1`,
      [res.body.data.id])
    expect(ar.rows.length).toBe(1)
    // bankingFeePayer mirrored into ach + card per S116 back-compat
    expect(ar.rows[0].ach_fee_payer).toBe('landlord')
    expect(ar.rows[0].card_fee_payer).toBe('landlord')
    expect(ar.rows[0].platform_fee_payer).toBe('landlord')
  })

  it('allocationRule missing both ach/card + bankingFeePayer → 400', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildApp())
      .post('/api/properties')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        name: 'No Rule Prop',
        street1: '1 Main', city: 'Phoenix', state: 'AZ', zip: '85001',
        type: 'residential',
        allocationRule: { platformFeePayer: 'landlord' },  // missing fee payers
      })
    expect(res.status).toBe(400)
  })

  it('duplicate address from same landlord → flags review_status', async () => {
    const f = await seedPropsFixture()
    const r1 = await createProperty(f, 'First')
    expect(r1.status).toBe(201)
    const r2 = await createProperty(f, 'Second')  // same address
    expect(r2.status).toBe(201)

    // First should remain clear (no duplicate at create time), second flagged
    const second = await db.query<{ review_status: string }>(
      `SELECT review_status FROM properties WHERE id=$1`, [r2.body.data.id])
    expect(second.rows[0].review_status).toBe('pending_review')

    const flags = await db.query<{ property_id: string; conflicting_property_id: string }>(
      `SELECT property_id, conflicting_property_id FROM property_duplicate_flags
         WHERE property_id=$1`, [r2.body.data.id])
    expect(flags.rows.length).toBe(1)
    expect(flags.rows[0].conflicting_property_id).toBe(r1.body.data.id)
  })
})

describe('GET /api/properties', () => {
  it('landlord-scoped: own properties only', async () => {
    const a = await seedPropsFixture()
    const b = await seedPropsFixture()
    await createProperty(a, 'A Prop')
    await createProperty(b, 'B Prop')

    const res = await request(buildApp())
      .get('/api/properties')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].name).toBe('A Prop')
  })
})

describe('GET /api/properties/:id', () => {
  it('cross-landlord property → 403', async () => {
    const a = await seedPropsFixture()
    const b = await seedPropsFixture()
    const bProp = await createProperty(b, 'B Prop')
    const res = await request(buildApp())
      .get(`/api/properties/${bProp.body.data.id}`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(403)
  })

  // ─────────────────────────────────────────────────────────────
  //  S486: state-law warnings on GET /:id recomputed against
  //  persisted property defaults.
  // ─────────────────────────────────────────────────────────────

  async function seedNvLateFeeCap(): Promise<void> {
    const { rows: [a] } = await db.query<{ id: string }>(
      `INSERT INTO state_landlord_tenant_acts
         (state_code, act_key, act_name, unit_types, source_date, effective_year)
       VALUES ('NV', 'residential', 'NV Residential Landlord-Tenant Act',
               ARRAY['apartment','single_family']::text[], '2026-06-11', 2026)
       ON CONFLICT DO NOTHING
       RETURNING id`)
    const actId = a?.id ?? (await db.query<{ id: string }>(
      `SELECT id FROM state_landlord_tenant_acts WHERE state_code='NV' AND act_key='residential' AND effective_year=2026 LIMIT 1`)).rows[0].id
    await db.query(
      `INSERT INTO state_law_provisions
         (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit,
          summary, statute_citation, source_url, source_date, effective_year)
       VALUES ($1, 'NV', 'late_fee_max_pct', 'max', 5, '% of rent',
               'Late fee may not exceed 5% of monthly rent',
               'NRS 118A.210', 'https://www.leg.state.nv.us/nrs/NRS-118A.html',
               '2026-06-11', 2026)
       ON CONFLICT DO NOTHING`, [actId])
  }

  async function createNvProperty(f: PropsFixture) {
    return request(buildApp())
      .post('/api/properties').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        name: 'NV Prop', street1: '1 main st', city: 'Las Vegas', state: 'NV', zip: '89101',
        type: 'residential',
        allocationRule: {
          bankingFeePayer: 'landlord',
          platformFeePayer: 'landlord',
          rentPercent: 5,
        },
      })
  }

  it('S486: NV property with 10% percent-of-rent default → state_law_warnings flag', async () => {
    const f = await seedPropsFixture()
    await seedNvLateFeeCap()
    const prop = await createNvProperty(f)
    // Patch to set the late-fee config above the NV cap.
    await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 10, lateFeeInitialType: 'percent_of_rent' })
    // GET should recompute and surface the warning.
    const res = await request(buildApp())
      .get(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.state_law_warnings)).toBe(true)
    expect(res.body.data.state_law_warnings.length).toBe(1)
    expect(res.body.data.state_law_warnings[0].topic).toBe('late_fee_max_pct')
  })

  it('S486: AZ property with 10% percent-of-rent → empty (no late_fee_max_pct seeded)', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)  // default AZ
    await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 10, lateFeeInitialType: 'percent_of_rent' })
    const res = await request(buildApp())
      .get(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S486: flat-dollar late fee → empty (no percent check fires)', async () => {
    const f = await seedPropsFixture()
    await seedNvLateFeeCap()
    const prop = await createNvProperty(f)
    await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 100, lateFeeInitialType: 'flat' })
    const res = await request(buildApp())
      .get(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })
})

describe('POST /api/properties/:id/fee-schedule', () => {
  it('happy path: insert + upsert on re-POST same fee_type', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const propId = prop.body.data.id

    const r1 = await request(buildApp())
      .post(`/api/properties/${propId}/fee-schedule`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ feeType: 'cleaning_fee', amount: 150, isRefundable: false, dueTiming: 'move_out' })
    expect(r1.status).toBe(200)
    expect(Number(r1.body.data.amount)).toBe(150)

    // Re-POST same fee_type → upsert (ON CONFLICT DO UPDATE)
    const r2 = await request(buildApp())
      .post(`/api/properties/${propId}/fee-schedule`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ feeType: 'cleaning_fee', amount: 200, isRefundable: false, dueTiming: 'move_out' })
    expect(r2.status).toBe(200)
    expect(Number(r2.body.data.amount)).toBe(200)

    // Exactly one row (upsert, not insert)
    const rows = await db.query(
      `SELECT id FROM property_fee_schedules WHERE property_id=$1 AND fee_type='cleaning_fee'`,
      [propId])
    expect(rows.rows.length).toBe(1)
  })

  it('cross-landlord property → 403', async () => {
    const a = await seedPropsFixture()
    const b = await seedPropsFixture()
    const bProp = await createProperty(b)
    const res = await request(buildApp())
      .post(`/api/properties/${bProp.body.data.id}/fee-schedule`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ feeType: 'cleaning_fee', amount: 150, isRefundable: false, dueTiming: 'move_out' })
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/properties/:id — late-fee accrual all-or-nothing', () => {
  it('partial accrual config (amount only, no type/period) → 400', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeAccrualAmount: 5 })  // missing type + period
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/accrual requires all of amount, type, and period/)
  })

  it('full accrual triple → 200', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        lateFeeAccrualAmount: 5,
        lateFeeAccrualType: 'flat',
        lateFeeAccrualPeriod: 'daily',
      })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.late_fee_accrual_amount)).toBe(5)
    expect(res.body.data.late_fee_accrual_type).toBe('flat')
    expect(res.body.data.late_fee_accrual_period).toBe('daily')
  })

  // ─────────────────────────────────────────────────────────────
  //  S481: state-law warnings on property defaults PATCH
  // ─────────────────────────────────────────────────────────────

  async function seedNvLateFeeCap(): Promise<void> {
    // NV has late_fee_max_pct=5% (NRS 118A.210). Seed inline since
    // schema.sql is schema-only.
    const { rows: [a] } = await db.query<{ id: string }>(
      `INSERT INTO state_landlord_tenant_acts
         (state_code, act_key, act_name, unit_types, source_date, effective_year)
       VALUES ('NV', 'residential', 'NV Residential Landlord-Tenant Act',
               ARRAY['apartment','single_family']::text[], '2026-06-11', 2026)
       ON CONFLICT DO NOTHING
       RETURNING id`)
    const actId = a?.id ?? (await db.query<{ id: string }>(
      `SELECT id FROM state_landlord_tenant_acts WHERE state_code='NV' AND act_key='residential' AND effective_year=2026 LIMIT 1`)).rows[0].id
    await db.query(
      `INSERT INTO state_law_provisions
         (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit,
          summary, statute_citation, source_url, source_date, effective_year)
       VALUES ($1, 'NV', 'late_fee_max_pct', 'max', 5, '% of rent',
               'Late fee may not exceed 5% of monthly rent',
               'NRS 118A.210', 'https://www.leg.state.nv.us/nrs/NRS-118A.html',
               '2026-06-11', 2026)
       ON CONFLICT DO NOTHING`, [actId])
  }

  async function createNvProperty(f: PropsFixture) {
    return request(buildApp())
      .post('/api/properties').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        name: 'NV Prop', street1: '1 main st', city: 'Las Vegas', state: 'NV', zip: '89101',
        type: 'residential',
        allocationRule: {
          bankingFeePayer: 'landlord',
          platformFeePayer: 'landlord',
          rentPercent: 5,
        },
      })
  }

  it('S481: NV late fee 10% (above 5% cap) → state_law_warnings flag', async () => {
    const f = await seedPropsFixture()
    await seedNvLateFeeCap()
    const prop = await createNvProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 10, lateFeeInitialType: 'percent_of_rent' })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.state_law_warnings)).toBe(true)
    expect(res.body.data.state_law_warnings.length).toBe(1)
    const flag = res.body.data.state_law_warnings[0]
    expect(flag.topic).toBe('late_fee_max_pct')
    expect(flag.message).toMatch(/above the 5/)
    expect(flag.message).toMatch(/NV/)
  })

  it('S481: NV late fee 4% (within 5% cap) → state_law_warnings empty', async () => {
    const f = await seedPropsFixture()
    await seedNvLateFeeCap()
    const prop = await createNvProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 4, lateFeeInitialType: 'percent_of_rent' })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S481: AZ residential 10% late fee → empty (AZ has no late_fee_max_pct provision)', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)  // default state AZ
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 10, lateFeeInitialType: 'percent_of_rent' })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S481: PATCH that does not touch fee fields → empty state_law_warnings', async () => {
    const f = await seedPropsFixture()
    await seedNvLateFeeCap()
    const prop = await createNvProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S481: flat-dollar late fee → no late_fee_max_pct check fires (apples vs oranges)', async () => {
    const f = await seedPropsFixture()
    await seedNvLateFeeCap()
    const prop = await createNvProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeInitialAmount: 100, lateFeeInitialType: 'flat' })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })
})

describe('PATCH /api/properties/:id/allocation-rule', () => {
  it('happy: flip ach_fee_payer to tenant', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/allocation-rule`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ achFeePayer: 'tenant' })
    expect(res.status).toBe(200)
    expect(res.body.data.ach_fee_payer).toBe('tenant')
  })

  it('empty body (no fields supplied) → 400', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/allocation-rule`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/No allocation-rule fields supplied/)
  })

  it('ownerBankAccountId belonging to different user → 403', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)

    // Seed a bank account under a different user (not the property owner)
    const client = await db.connect()
    let otherBankId = ''
    try {
      await client.query('BEGIN')
      const other = await seedManager(client)  // creates a separate user
      otherBankId = await seedUserBankAccount(client, { userId: other })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/allocation-rule`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ ownerBankAccountId: otherBankId })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/does not belong to property owner/)
  })
})

describe('PATCH /api/properties/:id/pm-assignment', () => {
  it('pmFeePlanId without pmCompanyId → 400', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/pm-assignment`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ pmCompanyId: null, pmFeePlanId: randomUUID() })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/pmFeePlanId requires pmCompanyId/)
  })

  it('pm_company missing bank_account_id → 409', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    // Seed a pm_company without bank_account_id
    const co = await db.query<{ id: string }>(
      `INSERT INTO pm_companies (name, status) VALUES ('NoBank PM', 'active') RETURNING id`)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/pm-assignment`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ pmCompanyId: co.rows[0].id, pmFeePlanId: null })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/no bank account assigned/)
  })
})

describe('PATCH /api/properties/:id/manager — PM conflict guard', () => {
  it('cannot set manager while pm_company_id is assigned → 409', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    // Force pm_company_id directly (bypass route, simulating prior PM
    // assignment); the manager route should refuse the conflict.
    const co = await db.query<{ id: string }>(
      `INSERT INTO pm_companies (name, status, bank_account_id) VALUES ('PM Co', 'active', NULL) RETURNING id`)
    await db.query(
      `UPDATE properties SET pm_company_id=$1 WHERE id=$2`,
      [co.rows[0].id, prop.body.data.id])

    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/manager`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ userId: null })  // even reverting to owner is rejected
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Clear the PM assignment before setting/)
  })

  it('non-scoped target user → 400', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    // Seed a property_manager user but DON'T grant scope for this property
    const client = await db.connect()
    let mgrId = ''
    try {
      mgrId = await seedManager(client)
    } finally { client.release() }
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/manager`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ userId: mgrId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not a property_manager scope holder/)
  })
})

describe('agent-permissions (per-property revenue opt-in)', () => {
  it('GET defaults every capability to false when no rows exist', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const res = await request(buildApp())
      .get(`/api/properties/${prop.body.data.id}/agent-permissions`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ take_payment: false, lease_renewal: false, bill_fee: false })
  })

  it('PATCH enables a capability and GET reflects it', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const propId = prop.body.data.id

    const patch = await request(buildApp())
      .patch(`/api/properties/${propId}/agent-permissions`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ capability: 'bill_fee', enabled: true })
    expect(patch.status).toBe(200)
    expect(patch.body.data).toEqual({ capability: 'bill_fee', enabled: true })

    const get = await request(buildApp())
      .get(`/api/properties/${propId}/agent-permissions`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(get.body.data.bill_fee).toBe(true)
    expect(get.body.data.lease_renewal).toBe(false)
  })

  it('PATCH toggling back to false persists off', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const propId = prop.body.data.id
    const buildAppOnce = buildApp()
    await request(buildAppOnce).patch(`/api/properties/${propId}/agent-permissions`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ capability: 'lease_renewal', enabled: true })
    const off = await request(buildApp()).patch(`/api/properties/${propId}/agent-permissions`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ capability: 'lease_renewal', enabled: false })
    expect(off.body.data.enabled).toBe(false)
  })

  it('rejects an unknown capability (zod enum)', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/agent-permissions`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ capability: 'evict_tenant', enabled: true })
    expect(res.status).toBe(400)
  })

  it('cross-landlord property → 403 on PATCH', async () => {
    const a = await seedPropsFixture()
    const b = await seedPropsFixture()
    const bProp = await createProperty(b, 'B Prop')
    const res = await request(buildApp())
      .patch(`/api/properties/${bProp.body.data.id}/agent-permissions`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ capability: 'bill_fee', enabled: true })
    expect(res.status).toBe(403)
  })
})
