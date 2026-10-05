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
 *   - /listings (S535: requireAuth + tenant bg-check gate; multi-table
 *     JOIN covered by /:id/eligible-managers + GET /:id for scope)
 *   - /apply public — straightforward INSERT
 *   - /applications listing — mechanical SELECT
 *   - /:id/eligible-managers — joins + filtering; OK to skip
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedManager, seedUnit,
  seedUserBankAccount,
} from '../test/dbHelpers'
import { propertiesRouter, publicPropertiesRouter } from './properties'
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
    // bankingFeePayer ('landlord') is the property's one card-and-bank choice
    // (10/5): both covered, and the counter and booking site follow.
    expect(ar.rows[0].ach_fee_payer).toBe('landlord')
    expect(ar.rows[0].card_fee_payer).toBe('landlord')
    const pr = await db.query(`SELECT register_card_fee_payer, booking_card_fee_payer FROM properties WHERE id=$1`, [res.body.data.id])
    expect(pr.rows[0]).toEqual({ register_card_fee_payer: 'landlord', booking_card_fee_payer: 'landlord' })
    expect(ar.rows[0].platform_fee_payer).toBe('landlord')
  })

  // 10/5: the company's onboarding choice reaches a new property. It was read
  // from the session's profileId, which names no company for a landlord since
  // S633, so every new property started "passed on" whatever was chosen.
  it('a new property with no fee answer takes its company\u2019s onboarding choice', async () => {
    const f = await seedPropsFixture()
    await db.query(`UPDATE landlords SET default_ach_fee_payer = 'landlord' WHERE id = $1`, [f.landlordId])
    // A session as login mints it today: no company in profileId.
    const modern = jwt.sign({ userId: f.landlordUserId, role: 'landlord', email: 'll@t.dev', profileId: null,
      landlordIds: [f.landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp()).post('/api/properties')
      .set('Authorization', `Bearer ${modern}`)
      .send({ name: 'Inherits', street1: '2 main st', city: 'Phoenix', state: 'AZ', zip: '85001', type: 'residential', allocationRule: {} })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const ar = (await db.query(`SELECT ach_fee_payer, card_fee_payer FROM property_allocation_rules WHERE property_id=$1`, [res.body.data.id])).rows[0]
    expect(ar).toEqual({ ach_fee_payer: 'landlord', card_fee_payer: 'landlord' })
  })

  it('S574: a new property auto-publishes a public website (slug + enabled)', async () => {
    const f = await seedPropsFixture()
    const res = await createProperty(f, 'Palm Grove RV')
    expect(res.status).toBe(201)
    // Response carries the published site so the UI can link it immediately.
    expect(res.body.data.public_booking_enabled).toBe(true)
    expect(res.body.data.booking_slug).toBeTruthy()
    // Slug derives from the name (name-city form).
    expect(res.body.data.booking_slug).toMatch(/^palm-grove-rv/)
    // Persisted + resolvable by the public storefront (enabled + slug).
    const row = await db.query<{ booking_slug: string; public_booking_enabled: boolean }>(
      `SELECT booking_slug, public_booking_enabled FROM properties WHERE id=$1`, [res.body.data.id])
    expect(row.rows[0].public_booking_enabled).toBe(true)
    expect(row.rows[0].booking_slug).toBe(res.body.data.booking_slug)
  })

  it('S568: homes-only external park (operatorOwnsLand=false) persists', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildApp())
      .post('/api/properties')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ name: 'Riverside MHP (homes only)', street1: '9 Lot Ln', city: 'Phoenix', state: 'AZ', zip: '85001',
              type: 'rv_longterm', operatorOwnsLand: false })
    expect(res.status).toBe(201)
    const row = await db.query<any>(`SELECT operator_owns_land FROM properties WHERE id=$1`, [res.body.data.id])
    expect(row.rows[0].operator_owns_land).toBe(false)
    // default stays TRUE when omitted
    const owned = await createProperty(f, 'Owned Park')
    const ownedRow = await db.query<any>(`SELECT operator_owns_land FROM properties WHERE id=$1`, [owned.body.data.id])
    expect(ownedRow.rows[0].operator_owns_land).toBe(true)
  })

  it('allocationRule with no fee payers → 201; ACH inherits landlord default, card locked tenant (S513 #2)', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildApp())
      .post('/api/properties')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        name: 'No Rule Prop',
        street1: '1 Main', city: 'Phoenix', state: 'AZ', zip: '85001',
        type: 'residential',
        allocationRule: { platformFeePayer: 'landlord' },  // no explicit fee payers
      })
    expect(res.status).toBe(201)
    const ar = await db.query<{ ach_fee_payer: string; card_fee_payer: string }>(
      `SELECT ach_fee_payer, card_fee_payer FROM property_allocation_rules WHERE property_id=$1`,
      [res.body.data.id])
    // A freshly-seeded landlord has default_ach_fee_payer 'tenant' (column default).
    expect(ar.rows[0].ach_fee_payer).toBe('tenant')
    expect(ar.rows[0].card_fee_payer).toBe('tenant')
  })

  it('allocationRule entirely omitted → 201 (fixes onboarding step-1; S513 #2)', async () => {
    const f = await seedPropsFixture()
    const res = await request(buildApp())
      .post('/api/properties')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        name: 'Onboarding Prop',
        street1: '2 Main', city: 'Phoenix', state: 'AZ', zip: '85002',
        type: 'residential',
      })
    expect(res.status).toBe(201)
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
      .send({ unitType: 'rv_spot', feeType: 'cleaning_fee', amount: 150, isRefundable: false, dueTiming: 'move_out' })
    expect(r1.status).toBe(200)
    expect(Number(r1.body.data.amount)).toBe(150)

    // Re-POST same fee_type → upsert (ON CONFLICT DO UPDATE)
    const r2 = await request(buildApp())
      .post(`/api/properties/${propId}/fee-schedule`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ unitType: 'rv_spot', feeType: 'cleaning_fee', amount: 200, isRefundable: false, dueTiming: 'move_out' })
    expect(r2.status).toBe(200)
    expect(Number(r2.body.data.amount)).toBe(200)

    // Exactly one row (upsert, not insert)
    const rows = await db.query(
      `SELECT id FROM property_fee_schedules WHERE property_id=$1 AND fee_type='cleaning_fee'`,
      [propId])
    expect(rows.rows.length).toBe(1)
  })

  // S648 (Nic): a fee is set per KIND of unit. The same fee for apartments and
  // for RV spots is two rows, and a POST without a unit type is refused.
  it('keeps each unit type separate, and requires one', async () => {
    const f = await seedPropsFixture()
    const propId = (await createProperty(f)).body.data.id
    const post = (body: any) => request(buildApp())
      .post(`/api/properties/${propId}/fee-schedule`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send(body)
    const base = { feeType: 'pet_deposit', isRefundable: true, dueTiming: 'move_in' }
    expect((await post({ ...base, unitType: 'apartment', amount: 350 })).status).toBe(200)
    expect((await post({ ...base, unitType: 'rv_spot', amount: 0 })).status).toBe(200)
    expect((await post({ ...base, amount: 350 })).status).toBe(400)
    expect((await post({ ...base, unitType: 'apartment', feeType: 'utility_deposit', amount: 100 })).status).toBe(200)
    const rows = await db.query<any>(
      `SELECT unit_type, fee_type, amount::float AS amount FROM property_fee_schedules
        WHERE property_id=$1 ORDER BY unit_type, fee_type`, [propId])
    expect(rows.rows).toEqual([
      { unit_type: 'apartment', fee_type: 'pet_deposit', amount: 350 },
      { unit_type: 'apartment', fee_type: 'utility_deposit', amount: 100 },
      { unit_type: 'rv_spot', fee_type: 'pet_deposit', amount: 0 },
    ])
  })

  it('cross-landlord property → 403', async () => {
    const a = await seedPropsFixture()
    const b = await seedPropsFixture()
    const bProp = await createProperty(b)
    const res = await request(buildApp())
      .post(`/api/properties/${bProp.body.data.id}/fee-schedule`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ unitType: 'rv_spot', feeType: 'cleaning_fee', amount: 150, isRefundable: false, dueTiming: 'move_out' })
    expect(res.status).toBe(403)
  })
})

// S558: the deposit-multiplier CRUD (S556 property_unit_type_deposits) was
// removed — the deposit multiplier is now a lease term on the template
// (lease_templates.deposit_months). Coverage moved to esign.test.ts
// "auto-populate from unit (S556/S558)".

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

  // S655: the check used to run after the rest of the save had committed, and
  // the address audit row was written before the save even started — so this
  // 400 came back with the rename and the new street already saved and logged.
  it('a refused accrual saves none of the request: no rename, no address change, no address audit row', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const id = prop.body.data.id as string
    const res = await request(buildApp())
      .patch(`/api/properties/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ name: 'Renamed', street1: '42 New Road', lateFeeGraceDays: 9, lateFeeAccrualAmount: 5 })
    expect(res.status).toBe(400)
    const { rows: [p] } = await db.query(
      `SELECT name, street1, late_fee_grace_days, late_fee_accrual_amount FROM properties WHERE id = $1`, [id])
    expect(p.name).toBe('Test Prop')
    expect(p.street1).toBe(prop.body.data.street1)
    expect(p.late_fee_grace_days).toBe(prop.body.data.late_fee_grace_days)
    expect(p.late_fee_accrual_amount).toBeNull()
    const { rows: audits } = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'property_address_changed' AND entity_id = $1`, [id])
    expect(audits).toHaveLength(0)

    // The same request with the whole triple saves all of it together.
    const ok = await request(buildApp())
      .patch(`/api/properties/${id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ name: 'Renamed', street1: '42 New Road', lateFeeGraceDays: 9,
              lateFeeAccrualAmount: 5, lateFeeAccrualType: 'flat', lateFeeAccrualPeriod: 'daily' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.name).toBe('Renamed')
    expect(ok.body.data.street1).toBe('42 New Road')
    expect(ok.body.data.late_fee_grace_days).toBe(9)
    expect(Number(ok.body.data.late_fee_accrual_amount)).toBe(5)
    const { rows: logged } = await db.query(
      `SELECT old_value, new_value FROM audit_log WHERE action = 'property_address_changed' AND entity_id = $1`, [id])
    expect(logged).toHaveLength(1)
    expect(logged[0].old_value.street1).toBe(prop.body.data.street1)
    expect(logged[0].new_value.street1).toBe('42 New Road')
  })

  it('a property that already has the accrual set accepts a change to just one part of it', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const id = prop.body.data.id as string
    await request(buildApp()).patch(`/api/properties/${id}`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeAccrualAmount: 5, lateFeeAccrualType: 'flat', lateFeeAccrualPeriod: 'daily' })
    const res = await request(buildApp()).patch(`/api/properties/${id}`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ lateFeeAccrualAmount: 7 })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.late_fee_accrual_amount)).toBe(7)
    expect(res.body.data.late_fee_accrual_period).toBe('daily')
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

  // S654: a landlord page cached from before the cash/check fee was retired
  // still sends its old toggle alone. Nothing changes and nothing errors.
  it('the retired cash-fee toggle alone → 200, rule unchanged, no fee field', async () => {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const res = await request(buildApp())
      .patch(`/api/properties/${prop.body.data.id}/allocation-rule`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ manualFeePayer: 'landlord' })
    expect(res.status).toBe(200)
    expect(res.body.data.property_id).toBe(prop.body.data.id)
    expect(res.body.data).not.toHaveProperty('manual_fee_payer')
    const row = await db.query(
      `SELECT manual_fee_payer FROM property_allocation_rules WHERE property_id = $1`,
      [prop.body.data.id])
    expect(row.rows[0].manual_fee_payer).toBe('tenant')
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
    expect(res.body.error).toMatch(/not a property-manager or on-site-manager scope holder/)
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

// ─── S550: duplicate property identity = name + ADDRESS, never name ─

describe('S550 — duplicate property identity', () => {
  const create = (f: PropsFixture, name: string, street1: string, city = 'Phoenix') =>
    request(buildApp())
      .post('/api/properties')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ name, street1, city, state: 'AZ', zip: '85001', type: 'residential', allocationRule: { platformFeePayer: 'landlord' } })

  it('same landlord + same name + same address → 409 (same property entered twice)', async () => {
    const f = await seedPropsFixture()
    expect((await create(f, 'Oak Park', '22658 Highway 89', 'Yarnell')).status).toBe(201)
    const dup = await create(f, 'oak park', '22658 highway 89', 'yarnell')
    expect(dup.status).toBe(409)
    expect(dup.body.error || dup.body.message).toContain('entered twice')
  })

  it('same landlord may own TWO properties sharing a name at different addresses', async () => {
    const f = await seedPropsFixture()
    expect((await create(f, 'Oak Park', '22658 Highway 89', 'Yarnell')).status).toBe(201)
    expect((await create(f, 'Oak Park', '101 Desert Rose Ln', 'Phoenix')).status).toBe(201)
  })

  it('a DIFFERENT landlord may use the same name at a different address', async () => {
    const f1 = await seedPropsFixture()
    const f2 = await seedPropsFixture()
    expect((await create(f1, 'Oak Park', '22658 Highway 89', 'Yarnell')).status).toBe(201)
    expect((await create(f2, 'Oak Park', '500 Elm St', 'Yarnell')).status).toBe(201)
  })

  it('a DIFFERENT landlord claiming the SAME full address is blocked (any name) + admins alerted', async () => {
    const f1 = await seedPropsFixture()
    const f2 = await seedPropsFixture()
    expect((await create(f1, 'Oak Park', '22658 Highway 89', 'Yarnell')).status).toBe(201)
    // Different NAME, same full address — still blocked (renamed claim).
    const claim = await create(f2, 'Sunset Pines', '22658 Highway 89', 'Yarnell')
    expect(claim.status).toBe(409)
    // Reveals nothing about the other account, and points at the suite path.
    const msg = String(claim.body.error || claim.body.message)
    expect(msg).toContain('already registered on GAM')
    expect(msg).toContain('suite')
    expect(msg).not.toContain(f1.landlordId)
    const alert = await db.query(
      `SELECT id FROM admin_notifications WHERE category='duplicate_property_claim'`)
    expect(alert.rows.length).toBe(1)
  })

  it('strip-mall case: same street, DIFFERENT suite line, different owners → allowed', async () => {
    const f1 = await seedPropsFixture()
    const f2 = await seedPropsFixture()
    const withSuite = (f: PropsFixture, name: string, street2: string) =>
      request(buildApp())
        .post('/api/properties')
        .set('Authorization', `Bearer ${f.landlordToken}`)
        .send({ name, street1: '100 Main St', street2, city: 'Phoenix', state: 'AZ', zip: '85001',
                type: 'residential', allocationRule: { platformFeePayer: 'landlord' } })
    expect((await withSuite(f1, 'Main St Plaza — East', 'Suite A')).status).toBe(201)
    expect((await withSuite(f2, 'Main St Plaza — West', 'Suite B')).status).toBe(201)
    // Same suite as an existing owner → blocked.
    expect((await withSuite(f2, 'Plaza Clone', 'Suite A')).status).toBe(409)
  })
})

// S592: the public /apply intake resolves the landlord AUTHORITATIVELY. It has
// no auth (it's a public form) and unit_applications has no FKs, so the route
// itself must reject bogus/mismatched landlord ids.
describe('POST /api/public/properties/apply — landlord resolution', () => {
  function buildPublicApp() {
    const app = express()
    app.use(express.json({ limit: '2mb' }))
    app.use('/api/public/properties', publicPropertiesRouter)
    app.use(errorHandler)
    return app
  }

  // Landlord A owns a property + unit; landlord B owns nothing here.
  async function seedTwoLandlordsWithUnit() {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const a = await seedLandlord(client)
      const b = await seedLandlord(client)
      const propertyId = await seedProperty(client, {
        landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
      const unitId = await seedUnit(client, { propertyId, landlordId: a.landlordId })
      await client.query('COMMIT')
      return { landlordA: a.landlordId, landlordB: b.landlordId, unitId }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }

  const applicant = { firstName: 'Pat', lastName: 'Guest', email: 'pat@guest.dev' }

  it('happy path: unitId → application stamped with the UNIT owner', async () => {
    const { landlordA, unitId } = await seedTwoLandlordsWithUnit()
    const res = await request(buildPublicApp())
      .post('/api/public/properties/apply')
      .send({ unitId, ...applicant })
    expect(res.status).toBe(201)
    expect(res.body.data.landlord_id).toBe(landlordA)
    expect(res.body.data.unit_id).toBe(unitId)
  })

  it('cross-landlord: unit of A + landlordId of B → 400, nothing inserted', async () => {
    const { landlordB, unitId } = await seedTwoLandlordsWithUnit()
    const res = await request(buildPublicApp())
      .post('/api/public/properties/apply')
      .send({ unitId, landlordId: landlordB, ...applicant })
    expect(res.status).toBe(400)
    const rows = await db.query(`SELECT id FROM unit_applications`)
    expect(rows.rows.length).toBe(0)
  })

  it('bogus landlordId (no unit) → 404, nothing inserted', async () => {
    const res = await request(buildPublicApp())
      .post('/api/public/properties/apply')
      .send({ landlordId: randomUUID(), ...applicant })
    expect(res.status).toBe(404)
    const rows = await db.query(`SELECT id FROM unit_applications`)
    expect(rows.rows.length).toBe(0)
  })

  it('landlord-only application with a REAL landlordId → 201', async () => {
    const { landlordB } = await seedTwoLandlordsWithUnit()
    const res = await request(buildPublicApp())
      .post('/api/public/properties/apply')
      .send({ landlordId: landlordB, ...applicant })
    expect(res.status).toBe(201)
    expect(res.body.data.landlord_id).toBe(landlordB)
    expect(res.body.data.unit_id).toBeNull()
  })
})

// S631 (Nic, DIRECTIVE): "We should maybe lock the street address once it's set.
// That way it's not altering our future heat map that we're gonna build."
describe('S631/S649 property address changes', () => {
  it('allows a changed street address (audited), and a rename leaves it alone', async () => {
    const app = buildApp()
    const fx = await seedPropsFixture()
    const client = await db.connect()
    let propertyId: string
    try {
      propertyId = await seedProperty(client, {
        landlordId: fx.landlordId,
        ownerUserId: fx.landlordUserId,
        managedByUserId: fx.landlordUserId,
      })
    } finally { client.release() }

    // S649 (Nic): "edit property window needs to be able to change property
    // address" — allowed now, with the old address kept in the audit log.
    const moved = await request(app)
      .patch(`/api/properties/${propertyId!}`)
      .set('Authorization', `Bearer ${fx.landlordToken}`)
      .send({ street1: '999 Somewhere Else Rd' })
    expect(moved.status).toBe(200)
    const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'property_address_changed' AND entity_id = $1`, [propertyId!])
    expect(audit.rows).toHaveLength(1)

    // The edit form posts the whole record back on every save, so an UNCHANGED
    // address must not be mistaken for an attempt to move the property.
    const cur = await db.query<{ street1: string; city: string }>(
      `SELECT street1, city FROM properties WHERE id=$1`, [propertyId!])
    const renamed = await request(app)
      .patch(`/api/properties/${propertyId!}`)
      .set('Authorization', `Bearer ${fx.landlordToken}`)
      .send({ name: 'Renamed Park', street1: cur.rows[0].street1, city: cur.rows[0].city })
    expect(renamed.status).toBe(200)
    const after = await db.query<{ name: string; street1: string }>(
      `SELECT name, street1 FROM properties WHERE id=$1`, [propertyId!])
    expect(after.rows[0].name).toBe('Renamed Park')
    expect(after.rows[0].street1).toBe(cur.rows[0].street1)
  })

  // The edit form always sends the suite line, blank when there is none. A
  // blank one used to be ignored, so a wrong suite line could never be
  // removed, while the audit row recorded it as removed.
  it('a blank suite line clears it (audited); re-sending the same suite line, or leaving it out, keeps it', async () => {
    const app = buildApp()
    const fx = await seedPropsFixture()
    const c = await db.connect()
    let propertyId = ''
    try {
      propertyId = await seedProperty(c, { landlordId: fx.landlordId, ownerUserId: fx.landlordUserId, managedByUserId: fx.landlordUserId })
    } finally { c.release() }
    await db.query(`UPDATE properties SET street2 = 'Suite 5' WHERE id = $1`, [propertyId])
    const suite = async () => (await db.query<{ street2: string | null }>(
      `SELECT street2 FROM properties WHERE id = $1`, [propertyId])).rows[0].street2
    const audits = async () => (await db.query(
      `SELECT old_value, new_value FROM audit_log WHERE action = 'property_address_changed' AND entity_id = $1`,
      [propertyId])).rows

    const same = await request(app).patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${fx.landlordToken}`).send({ name: 'Park', street2: 'Suite 5' })
    expect(same.status).toBe(200)
    expect(await suite()).toBe('Suite 5')
    const omitted = await request(app).patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${fx.landlordToken}`).send({ name: 'Park Two' })
    expect(omitted.status).toBe(200)
    expect(await suite()).toBe('Suite 5')
    expect(await audits()).toHaveLength(0)

    const cleared = await request(app).patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${fx.landlordToken}`).send({ street2: '' })
    expect(cleared.status).toBe(200)
    expect(await suite()).toBeNull()
    const logged = await audits()
    expect(logged).toHaveLength(1)
    expect(logged[0].old_value.street2).toBe('Suite 5')
  })
})

describe('S649 an address change cannot land on another landlord\'s property', () => {
  it('refuses moving onto an address registered to someone else', async () => {
    const app = buildApp()
    const fx = await seedPropsFixture()
    const other = await seedPropsFixture()
    const client = await db.connect()
    let mine = '', theirs = ''
    try {
      mine = await seedProperty(client, { landlordId: fx.landlordId, ownerUserId: fx.landlordUserId, managedByUserId: fx.landlordUserId })
      theirs = await seedProperty(client, { landlordId: other.landlordId, ownerUserId: other.landlordUserId, managedByUserId: other.landlordUserId })
    } finally { client.release() }
    await db.query(`UPDATE properties SET street1 = '77 Their Park Rd' WHERE id = $1`, [theirs])
    const t = (await db.query<any>(`SELECT street1, city, state, street2 FROM properties WHERE id = $1`, [theirs])).rows[0]
    const res = await request(app).patch(`/api/properties/${mine}`)
      .set('Authorization', `Bearer ${fx.landlordToken}`)
      .send({ street1: t.street1, city: t.city, state: t.state })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toMatch(/already registered/i)
  })

  // S655: the suite line is now cleared by a blank OR null one, but the check
  // read a null as "suite unchanged". A property registered as Suite 5 at
  // another landlord's street could drop its suite with {street2: null} and
  // sit on their address.
  it('clearing the suite line is refused when the street without it belongs to someone else, sent as null or blank', async () => {
    const app = buildApp()
    const fx = await seedPropsFixture()
    const other = await seedPropsFixture()
    const client = await db.connect()
    let mine = '', theirs = ''
    try {
      mine = await seedProperty(client, { landlordId: fx.landlordId, ownerUserId: fx.landlordUserId, managedByUserId: fx.landlordUserId })
      theirs = await seedProperty(client, { landlordId: other.landlordId, ownerUserId: other.landlordUserId, managedByUserId: other.landlordUserId })
    } finally { client.release() }
    await db.query(`UPDATE properties SET street1 = '77 Shared Rd', street2 = NULL WHERE id = $1`, [theirs])
    await db.query(`UPDATE properties SET street1 = '77 Shared Rd', street2 = 'Suite 5' WHERE id = $1`, [mine])
    const stored = async () => (await db.query<{ street1: string; street2: string | null }>(
      `SELECT street1, street2 FROM properties WHERE id = $1`, [mine])).rows[0]
    const moves = async () => (await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'property_address_changed' AND entity_id = $1`, [mine])).rows

    for (const street2 of [null, '']) {
      const res = await request(app).patch(`/api/properties/${mine}`)
        .set('Authorization', `Bearer ${fx.landlordToken}`).send({ street2 })
      expect(res.status, `street2=${JSON.stringify(street2)}`).toBe(409)
      expect(String(res.body.error)).toMatch(/already registered/i)
      expect(await stored()).toEqual({ street1: '77 Shared Rd', street2: 'Suite 5' })
    }
    expect(await moves()).toHaveLength(0)
    const alerts = await db.query(
      `SELECT 1 FROM admin_notifications WHERE category = 'duplicate_property_claim' AND context->>'propertyId' = $1`, [mine])
    expect(alerts.rows).toHaveLength(2)

    // A different suite is still fine, and is recorded as the change it is.
    const moved = await request(app).patch(`/api/properties/${mine}`)
      .set('Authorization', `Bearer ${fx.landlordToken}`).send({ street2: 'Suite 6' })
    expect(moved.status).toBe(200)
    expect((await stored()).street2).toBe('Suite 6')
    expect(await moves()).toHaveLength(1)
  })

  // A blank street, city or state is not stored (the save keeps the current
  // one), so it is neither checked nor logged as a move.
  it('a blank street line keeps the address and is not recorded as a move', async () => {
    const app = buildApp()
    const fx = await seedPropsFixture()
    const client = await db.connect()
    let mine = ''
    try {
      mine = await seedProperty(client, { landlordId: fx.landlordId, ownerUserId: fx.landlordUserId, managedByUserId: fx.landlordUserId })
    } finally { client.release() }
    const res = await request(app).patch(`/api/properties/${mine}`)
      .set('Authorization', `Bearer ${fx.landlordToken}`).send({ street1: '', city: '' })
    expect(res.status).toBe(200)
    const { rows: [p] } = await db.query(`SELECT street1, city FROM properties WHERE id = $1`, [mine])
    expect(p).toEqual({ street1: '1 Test St', city: 'Phoenix' })
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'property_address_changed' AND entity_id = $1`, [mine])
    expect(audit.rows).toHaveLength(0)
  })
})

// S655: a property's "lease-signing email" decides where the OWNER's signature
// requests for that property go, and the emailed link signs as the owner with
// no password. It sat on the general edit endpoint, whose gate lets property
// managers in — so a manager could point the owner's links at their own inbox.
describe('PATCH /api/properties/:id — owner signing routing is owner-only', () => {
  async function withManager(opts: { scoped: boolean } = { scoped: true }) {
    const f = await seedPropsFixture()
    const prop = await createProperty(f)
    const propertyId = prop.body.data.id as string
    const c = await db.connect()
    let mgrId = ''
    try { mgrId = await seedManager(c) } finally { c.release() }
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3::uuid[], FALSE)`,
      [mgrId, f.landlordId, opts.scoped ? [propertyId] : []])
    const mgrToken = jwt.sign(
      { userId: mgrId, role: 'property_manager', email: 'pm@test.dev', profileId: null,
        landlordId: f.landlordId, permissions: { 'properties.edit': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { f, propertyId, mgrId, mgrToken }
  }

  it('a property manager with Edit properties cannot change the signing email or name; other fields still save', async () => {
    const { propertyId, mgrToken } = await withManager()
    for (const body of [{ leaseSigningEmail: 'pm-inbox@evil.test' }, { leaseSigningName: 'Somebody Else' }]) {
      const res = await request(buildApp())
        .patch(`/api/properties/${propertyId}`)
        .set('Authorization', `Bearer ${mgrToken}`)
        .send(body)
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/Only the property owner/)
    }
    const { rows: [p] } = await db.query(`SELECT lease_signing_email, lease_signing_name FROM properties WHERE id=$1`, [propertyId])
    expect(p.lease_signing_email).toBeNull()
    expect(p.lease_signing_name).toBeNull()

    const ok = await request(buildApp())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Renamed By Manager', leaseSigningEmail: '' })   // unchanged value rides along
    expect(ok.status).toBe(200)
    expect(ok.body.data.name).toBe('Renamed By Manager')
  })

  it('the owner can set it, and the change is recorded', async () => {
    const { f, propertyId } = await withManager()
    const res = await request(buildApp())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseSigningEmail: 'Office@Park.test', leaseSigningName: 'On-Site Office' })
    expect(res.status).toBe(200)
    expect(res.body.data.lease_signing_email).toBe('office@park.test')
    const { rows } = await db.query(
      `SELECT user_id, old_value, new_value FROM audit_log
        WHERE action = 'property_lease_signing_changed' AND entity_id = $1`, [propertyId])
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(f.landlordUserId)
    expect(rows[0].old_value.leaseSigningEmail).toBeNull()
    expect(rows[0].new_value.leaseSigningEmail).toBe('office@park.test')
    expect(rows[0].new_value.leaseSigningName).toBe('On-Site Office')
  })

  it('a manager not assigned to this property cannot edit it at all', async () => {
    const { propertyId, mgrToken } = await withManager({ scoped: false })
    const res = await request(buildApp())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ name: 'Out of scope' })
    expect(res.status).toBe(403)
  })

  it('a manager sending an address change with a signing-email change gets 403 and nothing is recorded or changed', async () => {
    const { propertyId, mgrToken } = await withManager()
    const { rows: [before] } = await db.query(`SELECT street1 FROM properties WHERE id=$1`, [propertyId])
    const res = await request(buildApp())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ street1: '99 Elsewhere Rd', leaseSigningEmail: 'pm-inbox@evil.test' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Only the property owner/)
    const { rows: audits } = await db.query(
      `SELECT action FROM audit_log WHERE entity_id = $1`, [propertyId])
    expect(audits.map((a: any) => a.action)).not.toContain('property_address_changed')
    expect(audits).toHaveLength(0)
    const { rows: [after] } = await db.query(
      `SELECT street1, lease_signing_email FROM properties WHERE id=$1`, [propertyId])
    expect(after.street1).toBe(before.street1)
    expect(after.lease_signing_email).toBeNull()
  })

  it('another company’s landlord gets 403 and no audit row or admin notice is written', async () => {
    const { propertyId } = await withManager()
    const other = await seedPropsFixture()
    const res = await request(buildApp())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${other.landlordToken}`)
      .send({ street1: '99 Elsewhere Rd', leaseSigningEmail: 'thief@evil.test' })
    expect(res.status).toBe(403)
    const { rows: audits } = await db.query(`SELECT 1 FROM audit_log WHERE entity_id = $1`, [propertyId])
    expect(audits).toHaveLength(0)
    const { rows: notes } = await db.query(
      `SELECT 1 FROM admin_notifications WHERE context->>'propertyId' = $1`, [propertyId])
    expect(notes).toHaveLength(0)
  })

  // The new address, its audit row and the move of the owner's open seats are
  // one transaction with the rest of the save. The address used to be stored
  // first and the seats moved in a second step, so a failure there returned
  // 500 with the new address already saved, no audit row, and the old inbox's
  // link still signing as the owner.
  it('when moving the owner\'s open seats fails, nothing is saved: address, other fields, audit row and seat stay as they were', async () => {
    const { f, propertyId } = await withManager()
    await db.query(`UPDATE properties SET lease_signing_email='office@park.test' WHERE id=$1`, [propertyId])
    const c = await db.connect()
    let unitId = ''
    try { unitId = await seedUnit(c, { propertyId, landlordId: f.landlordId }) } finally { c.release() }
    const { rows: [doc] } = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, status)
       VALUES ($1, $2, 'Lease', 'sent') RETURNING id`, [f.landlordId, unitId])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, token, status)
       VALUES ($1, $2, 'landlord', 'Owner', 'office@park.test', 'tok-before-change', 'sent')`,
      [doc.id, f.landlordUserId])
    const seat = async () => (await db.query(
      `SELECT email, token FROM lease_document_signers WHERE document_id = $1`, [doc.id])).rows[0]

    await db.query(`CREATE OR REPLACE FUNCTION test_s655_fail_seat_move() RETURNS trigger
                      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'seat move failed'; END $$`)
    await db.query(`CREATE TRIGGER test_s655_fail_seat_move BEFORE UPDATE ON lease_document_signers
                      FOR EACH ROW EXECUTE FUNCTION test_s655_fail_seat_move()`)
    try {
      const res = await request(buildApp())
        .patch(`/api/properties/${propertyId}`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
        .send({ name: 'Renamed With It', leaseSigningEmail: 'new-office@park.test' })
      expect(res.status).toBe(500)
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS test_s655_fail_seat_move ON lease_document_signers`)
      await db.query(`DROP FUNCTION IF EXISTS test_s655_fail_seat_move()`)
    }

    const { rows: [p] } = await db.query(
      `SELECT name, lease_signing_email FROM properties WHERE id = $1`, [propertyId])
    expect(p.lease_signing_email).toBe('office@park.test')
    expect(p.name).toBe('Test Prop')
    const { rows: audits } = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'property_lease_signing_changed' AND entity_id = $1`, [propertyId])
    expect(audits).toHaveLength(0)
    expect(await seat()).toEqual({ email: 'office@park.test', token: 'tok-before-change' })

    // The same save goes through once nothing is in the way, all of it at once.
    const ok = await request(buildApp())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ name: 'Renamed With It', leaseSigningEmail: 'new-office@park.test' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.lease_signing_email).toBe('new-office@park.test')
    expect(ok.body.data.name).toBe('Renamed With It')
    const moved = await seat()
    expect(moved.email).toBe('new-office@park.test')
    expect(moved.token).not.toBe('tok-before-change')
    const { rows: done } = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'property_lease_signing_changed' AND entity_id = $1`, [propertyId])
    expect(done).toHaveLength(1)
  })

  // An open owner seat at this property, mailed to `email`.
  async function ownerSeat(f: PropsFixture, propertyId: string, email: string, token: string) {
    const c = await db.connect()
    let unitId = ''
    try { unitId = await seedUnit(c, { propertyId, landlordId: f.landlordId }) } finally { c.release() }
    const { rows: [doc] } = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, status)
       VALUES ($1, $2, 'Lease', 'sent') RETURNING id`, [f.landlordId, unitId])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, token, status)
       VALUES ($1, $2, 'landlord', 'Owner', $3, $4, 'sent')`,
      [doc.id, f.landlordUserId, email, token])
    return { docId: doc.id, seat: async () => (await db.query<{ email: string; token: string }>(
      `SELECT email, token FROM lease_document_signers WHERE document_id = $1`, [doc.id])).rows[0] }
  }

  // Holds the property row the way a save in progress does (locked, changed,
  // not yet committed), starts a second request while it is held, waits until
  // that request is queued behind the lock, then commits the first.
  async function whileAnotherSaveHoldsTheRow(
    propertyId: string,
    firstSave: (c: PoolClient) => Promise<void>,
    second: () => Promise<any>,
  ) {
    const first = await db.connect()
    try {
      await first.query('BEGIN')
      await first.query(`SELECT 1 FROM properties WHERE id = $1 FOR UPDATE`, [propertyId])
      await firstSave(first)
      const pending = second()
      const deadline = Date.now() + 5000
      for (;;) {
        const { rows: [w] } = await db.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`)
        if (w.n > 0) break
        if (Date.now() > deadline) throw new Error('the second save never waited for the first')
        await new Promise(r => setTimeout(r, 20))
      }
      await first.query('COMMIT')
      return await pending
    } catch (e) {
      await first.query('ROLLBACK').catch(() => {})
      throw e
    } finally { first.release() }
  }

  // Two owners save different signing addresses at the same moment (A to B,
  // A to C). The second save read the property before the first committed, so
  // it believed the address was still A. It used to look for seats at A, find
  // none (the first had moved them to B), and leave the owner's live link in
  // inbox B while the property pointed at C, with an audit row saying A to C.
  it('two owners saving different signing addresses at once: the later save moves the seats from where the earlier one left them', async () => {
    const { f, propertyId } = await withManager()
    await db.query(`UPDATE properties SET lease_signing_email='a@park.test' WHERE id=$1`, [propertyId])
    const { seat } = await ownerSeat(f, propertyId, 'a@park.test', 'tok-a')

    const res = await whileAnotherSaveHoldsTheRow(propertyId,
      async (c) => {
        // The first save: A to B, its seat already moved, not yet committed.
        await c.query(`UPDATE properties SET lease_signing_email='b@park.test' WHERE id=$1`, [propertyId])
        await c.query(`UPDATE lease_document_signers SET email='b@park.test', token='tok-b'
                        WHERE email='a@park.test'`)
      },
      () => request(buildApp())
        .patch(`/api/properties/${propertyId}`)
        .set('Authorization', `Bearer ${f.landlordToken}`)
        .send({ leaseSigningEmail: 'c@park.test' })
        .then(r => r))
    expect(res.status).toBe(200)
    expect(res.body.data.lease_signing_email).toBe('c@park.test')

    const s = await seat()
    expect(s.email).toBe('c@park.test')
    expect(['tok-a', 'tok-b']).not.toContain(s.token)
    const { rows } = await db.query(
      `SELECT old_value, new_value FROM audit_log
        WHERE action = 'property_lease_signing_changed' AND entity_id = $1`, [propertyId])
    expect(rows).toHaveLength(1)
    expect(rows[0].old_value.leaseSigningEmail).toBe('b@park.test')
    expect(rows[0].new_value.leaseSigningEmail).toBe('c@park.test')
  })

  it('a manager\'s save that carries the old signing address back does not undo an owner\'s change made a moment earlier', async () => {
    const { f, propertyId, mgrToken } = await withManager()
    await db.query(`UPDATE properties SET lease_signing_email='a@park.test' WHERE id=$1`, [propertyId])
    const { seat } = await ownerSeat(f, propertyId, 'a@park.test', 'tok-a')

    const res = await whileAnotherSaveHoldsTheRow(propertyId,
      async (c) => {
        await c.query(`UPDATE properties SET lease_signing_email='b@park.test' WHERE id=$1`, [propertyId])
        await c.query(`UPDATE lease_document_signers SET email='b@park.test', token='tok-b'
                        WHERE email='a@park.test'`)
      },
      // The manager's form was loaded while the address was still A.
      () => request(buildApp())
        .patch(`/api/properties/${propertyId}`)
        .set('Authorization', `Bearer ${mgrToken}`)
        .send({ name: 'Renamed By Manager', leaseSigningEmail: 'a@park.test' })
        .then(r => r))
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Renamed By Manager')
    expect(res.body.data.lease_signing_email).toBe('b@park.test')
    expect(await seat()).toEqual({ email: 'b@park.test', token: 'tok-b' })
    const { rows } = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'property_lease_signing_changed' AND entity_id = $1`, [propertyId])
    expect(rows).toHaveLength(0)
  })

  // The late-fee accrual check used to run after the save committed: its 400
  // came back for a change that had already taken effect — new signing
  // address, audit row, moved seat and new token included.
  it('a signing change sent with an incomplete late-fee accrual is refused and changes nothing', async () => {
    const { f, propertyId } = await withManager()
    await db.query(`UPDATE properties SET lease_signing_email='office@park.test' WHERE id=$1`, [propertyId])
    const { seat } = await ownerSeat(f, propertyId, 'office@park.test', 'tok-before')
    const res = await request(buildApp())
      .patch(`/api/properties/${propertyId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ name: 'Renamed', leaseSigningEmail: 'new-office@park.test', lateFeeAccrualAmount: 5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/accrual requires all of amount, type, and period/)
    const { rows: [p] } = await db.query(
      `SELECT name, lease_signing_email, late_fee_accrual_amount FROM properties WHERE id = $1`, [propertyId])
    expect(p.name).toBe('Test Prop')
    expect(p.lease_signing_email).toBe('office@park.test')
    expect(p.late_fee_accrual_amount).toBeNull()
    expect(await seat()).toEqual({ email: 'office@park.test', token: 'tok-before' })
    const { rows: audits } = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1`, [propertyId])
    expect(audits.map((a: any) => a.action)).not.toContain('property_lease_signing_changed')
  })
})

// S655: a transfer to another account waits for that account to accept.
describe('property transfer — the receiving side', () => {
  async function sale() {
    const seller = await seedPropsFixture()
    const buyer = await seedPropsFixture()
    const prop = await createProperty(seller)
    const propertyId = prop.body.data.id as string
    const { rows: [b] } = await db.query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [buyer.landlordUserId])
    return { seller, buyer, propertyId, buyerEmail: b.email }
  }

  it('a transfer by email raises a request that waits on the buyer — no codes in the response', async () => {
    const s = await sale()
    const res = await request(buildApp())
      .post(`/api/properties/${s.propertyId}/transfer`)
      .set('Authorization', `Bearer ${s.seller.landlordToken}`)
      .send({ toEmail: s.buyerEmail.toUpperCase() })
    expect(res.status).toBe(202)
    expect(res.body.data.awaitingBuyer).toBe(true)
    expect(JSON.stringify(res.body)).not.toMatch(/code/i)
    const { rows: [r] } = await db.query<any>(
      `SELECT to_user_id, to_landlord_id, buyer_code FROM property_transfer_requests WHERE id=$1`, [res.body.data.requestId])
    expect(r.to_user_id).toBe(s.buyer.landlordUserId)
    expect(r.to_landlord_id).toBeNull()
    expect(r.buyer_code).toMatch(/^\d{6}$/)

    // The seller's Ownership tab: the typed email, waiting on the buyer.
    const view = await request(buildApp())
      .get(`/api/properties/${s.propertyId}/transfer-request`)
      .set('Authorization', `Bearer ${s.seller.landlordToken}`)
    expect(view.status).toBe(200)
    expect(view.body.data.buyer_email).toBe(s.buyerEmail)
    expect(view.body.data.awaiting_buyer).toBe(true)
    expect(view.body.data.buyer_name).toBeNull()
  })

  it('requires exactly one receiver, and a company named directly must be your own', async () => {
    const s = await sale()
    for (const body of [{}, { toEmail: s.buyerEmail, toLandlordId: s.buyer.landlordId }]) {
      const res = await request(buildApp())
        .post(`/api/properties/${s.propertyId}/transfer`)
        .set('Authorization', `Bearer ${s.seller.landlordToken}`)
        .send(body)
      expect(res.status).toBe(400)
    }
    const theirs = await request(buildApp())
      .post(`/api/properties/${s.propertyId}/transfer`)
      .set('Authorization', `Bearer ${s.seller.landlordToken}`)
      .send({ toLandlordId: s.buyer.landlordId })
    expect(theirs.status).toBe(403)
    const { rows } = await db.query(`SELECT 1 FROM property_transfer_requests WHERE property_id=$1`, [s.propertyId])
    expect(rows).toHaveLength(0)
  })

  it('the buyer sees it under incoming transfers and accepts with their code; a stranger sees nothing', async () => {
    const s = await sale()
    const raised = await request(buildApp())
      .post(`/api/properties/${s.propertyId}/transfer`)
      .set('Authorization', `Bearer ${s.seller.landlordToken}`)
      .send({ toEmail: s.buyerEmail })
    const requestId = raised.body.data.requestId

    const incoming = await request(buildApp())
      .get('/api/properties/transfer-requests/incoming')
      .set('Authorization', `Bearer ${s.buyer.landlordToken}`)
    expect(incoming.status).toBe(200)
    expect(incoming.body.data.map((r: any) => r.id)).toEqual([requestId])
    const stranger = await seedPropsFixture()
    const none = await request(buildApp())
      .get('/api/properties/transfer-requests/incoming')
      .set('Authorization', `Bearer ${stranger.landlordToken}`)
    expect(none.body.data).toEqual([])

    const { rows: [r] } = await db.query<any>(`SELECT buyer_code FROM property_transfer_requests WHERE id=$1`, [requestId])
    const accepted = await request(buildApp())
      .post(`/api/properties/transfer-request/${requestId}/approve`)
      .set('Authorization', `Bearer ${s.buyer.landlordToken}`)
      .send({ code: r.buyer_code })
    expect(accepted.status).toBe(200)
    expect(accepted.body.data.side).toBe('buyer')
    expect(accepted.body.data.executed).toBe(false)   // the seller has not confirmed yet
    const { rows: [p] } = await db.query<any>(`SELECT landlord_id FROM properties WHERE id=$1`, [s.propertyId])
    expect(p.landlord_id).toBe(s.seller.landlordId)
  })
})
