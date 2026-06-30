/**
 * landlords route slice — S356 part 1 of N.
 *
 * Profile + dashboard + theme + onboarding + deposit-interest
 * overrides slice. First cut of landlords.ts (3817 lines, biggest
 * unwalked file). Multi-session arc — POS customers / FlexCharge /
 * todos / payouts / disputes / OTP / pm-property-invitations / CSV
 * onboarding / tenant onboarding all stay out of this slice for
 * future sessions.
 *
 * Coverage focus:
 *   - GET /:id + 'me' shortcut + cross-landlord 403
 *   - GET /:id/dashboard aggregator (SQL multi-query rollup — primary
 *     bug-yield surface in this slice; S355's F1 was this exact class)
 *   - PATCH /theme S236 owner-only guard (PM blocked even though their
 *     profileId is the landlord_id)
 *   - POST /complete-onboarding signature required
 *   - PATCH /me with CLEAR sentinel on
 *     defaultEarlyTerminationMonthsRent
 *   - PUT /me/deposit-interest-overrides statutory-rate blocker (409
 *     when state has a hardcoded statutory rate for the year)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedAllocationRule, seedUnit, seedManager } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_landlords'
})

interface LFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedLFixture(): Promise<LFixture> {
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

// PM token shape per production login: profileId = landlordId (user.profile_id
// is null for PM, scope.landlordId fills in). landlordId claim duplicates it.
async function seedPmTokenFor(f: LFixture): Promise<string> {
  const client = await db.connect()
  let pmUserId = ''
  try {
    pmUserId = await seedManager(client)
    await client.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
       VALUES ($1, $2, '{}', '{}', TRUE, $3)`,
      [pmUserId, f.landlordId, JSON.stringify({ 'team.invite': true })])
  } finally { client.release() }
  return jwt.sign(
    { userId: pmUserId, role: 'property_manager', email: 'pm@test.dev',
      profileId: f.landlordId, landlordId: f.landlordId,
      permissions: { 'team.invite': true } },
    process.env.JWT_SECRET!, { expiresIn: '1h' },
  )
}

describe('GET /api/landlords/:id', () => {
  it('"me" shortcut resolves to caller profileId and returns own landlord', async () => {
    const f = await seedLFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(f.landlordId)
  })

  it('cross-landlord get → 403', async () => {
    const a = await seedLFixture()
    const b = await seedLFixture()
    const res = await request(buildApp())
      .get(`/api/landlords/${b.landlordId}`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/landlords/:id/dashboard', () => {
  it('happy path: aggregates unit / disbursement / maintenance / OTP stats', async () => {
    const f = await seedLFixture()
    // Seed two units in different statuses to exercise the FILTER counts.
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      const u1 = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      const u2 = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      await client.query(`UPDATE units SET status='active', rent_amount=1500 WHERE id=$1`, [u1])
      await client.query(`UPDATE units SET status='vacant' WHERE id=$1`, [u2])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/landlords/me/dashboard')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.active_units).toBe(1)
    expect(res.body.data.vacant_units).toBe(1)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1500)
    expect(res.body.data.property_count).toBe(1)
    // Nested rollups present
    expect(res.body.data.upcoming_disbursement).toBeDefined()
    expect(Array.isArray(res.body.data.trend)).toBe(true)
    expect(res.body.data.maintenance).toBeDefined()
    expect(typeof res.body.data.bg_pending).toBe('number')
    expect(typeof res.body.data.otp_units).toBe('number')
  })

  it('PM (team role) → 403 (canViewLandlordFinances rejects team roles)', async () => {
    const f = await seedLFixture()
    const pmToken = await seedPmTokenFor(f)
    const res = await request(buildApp())
      .get('/api/landlords/me/dashboard')
      .set('Authorization', `Bearer ${pmToken}`)
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/landlords/theme — S236 owner-only', () => {
  it('landlord can update theme', async () => {
    const f = await seedLFixture()
    const res = await request(buildApp())
      .patch('/api/landlords/theme')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ themeAccent: '#ff8800', fontStyle: 'serif' })
    expect(res.status).toBe(200)
    const row = await db.query<{ theme_accent: string; font_style: string }>(
      `SELECT theme_accent, font_style FROM landlords WHERE id=$1`, [f.landlordId])
    expect(row.rows[0].theme_accent).toBe('#ff8800')
    expect(row.rows[0].font_style).toBe('serif')
  })

  it('PM (scoped to this landlord) → 403 (S236 fix prevents PM from rewriting owner branding)', async () => {
    const f = await seedLFixture()
    const pmToken = await seedPmTokenFor(f)
    const res = await request(buildApp())
      .patch('/api/landlords/theme')
      .set('Authorization', `Bearer ${pmToken}`)
      .send({ themeAccent: '#000000' })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/landlords/complete-onboarding', () => {
  it('missing signature → 400', async () => {
    const f = await seedLFixture()
    const res = await request(buildApp())
      .post('/api/landlords/complete-onboarding')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Signature required/)
  })

  it('happy path: flips onboarding_complete + stamps agreement fields', async () => {
    const f = await seedLFixture()
    const res = await request(buildApp())
      .post('/api/landlords/complete-onboarding')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ signature: 'Nic Rhoades', agreedAt: new Date().toISOString() })
    expect(res.status).toBe(200)
    const row = await db.query<{ onboarding_complete: boolean; agreement_signature: string; agreement_signed_at: string }>(
      `SELECT onboarding_complete, agreement_signature, agreement_signed_at FROM landlords WHERE id=$1`,
      [f.landlordId])
    expect(row.rows[0].onboarding_complete).toBe(true)
    expect(row.rows[0].agreement_signature).toBe('Nic Rhoades')
    expect(row.rows[0].agreement_signed_at).not.toBeNull()
  })

  it('no coverTenantAch → default_ach_fee_payer stays tenant (S513 #2)', async () => {
    const f = await seedLFixture()
    const res = await request(buildApp())
      .post('/api/landlords/complete-onboarding')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ signature: 'Nic Rhoades' })
    expect(res.status).toBe(200)
    const ll = await db.query<{ default_ach_fee_payer: string }>(
      `SELECT default_ach_fee_payer FROM landlords WHERE id=$1`, [f.landlordId])
    expect(ll.rows[0].default_ach_fee_payer).toBe('tenant')
  })

  it('coverTenantAch=true → default landlord + applies to existing properties; card stays tenant (S513 #2)', async () => {
    const f = await seedLFixture()
    const client = await db.connect()
    let propertyId = ''
    try {
      await client.query('BEGIN')
      propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId,
      })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .post('/api/landlords/complete-onboarding')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ signature: 'Nic Rhoades', coverTenantAch: true })
    expect(res.status).toBe(200)

    const ll = await db.query<{ default_ach_fee_payer: string }>(
      `SELECT default_ach_fee_payer FROM landlords WHERE id=$1`, [f.landlordId])
    expect(ll.rows[0].default_ach_fee_payer).toBe('landlord')

    const ar = await db.query<{ ach_fee_payer: string; card_fee_payer: string }>(
      `SELECT ach_fee_payer, card_fee_payer FROM property_allocation_rules WHERE property_id=$1`, [propertyId])
    expect(ar.rows[0].ach_fee_payer).toBe('landlord')  // election applied to the portfolio
    expect(ar.rows[0].card_fee_payer).toBe('tenant')   // card never covered
  })
})

describe('PATCH /api/landlords/me — profile + CLEAR sentinel', () => {
  it('happy path: COALESCE preserves unset fields', async () => {
    const f = await seedLFixture()
    // Set initial business_name + ein
    await db.query(
      `UPDATE landlords SET business_name='Acme LLC', ein='12-3456789' WHERE id=$1`,
      [f.landlordId])

    const res = await request(buildApp())
      .patch('/api/landlords/me')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ maintApprovalThreshold: 750 })  // only this field
    expect(res.status).toBe(200)
    expect(res.body.data.business_name).toBe('Acme LLC')  // preserved
    expect(res.body.data.ein).toBe('12-3456789')  // preserved
    expect(Number(res.body.data.maint_approval_threshold)).toBe(750)
  })

  it('defaultEarlyTerminationMonthsRent=null → clears the field', async () => {
    const f = await seedLFixture()
    await db.query(
      `UPDATE landlords SET default_early_termination_months_rent=2 WHERE id=$1`,
      [f.landlordId])

    const res = await request(buildApp())
      .patch('/api/landlords/me')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ defaultEarlyTerminationMonthsRent: null })
    expect(res.status).toBe(200)
    expect(res.body.data.default_early_termination_months_rent).toBeNull()
  })
})

describe('Deposit interest overrides (S188-S190)', () => {
  it('GET empty list → []', async () => {
    const f = await seedLFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/deposit-interest-overrides')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('PUT upsert for non-statutory state happy → row persists', async () => {
    const f = await seedLFixture()
    // AK is not in the 2026 statutory catalog (MA/MD/MN only)
    const res = await request(buildApp())
      .put('/api/landlords/me/deposit-interest-overrides')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stateCode: 'ak', effectiveYear: 2026, annualRatePct: 0.5, sourceNotes: 'bank passbook' })
    expect(res.status).toBe(200)
    expect(res.body.data.state_code).toBe('AK')  // zod uppercase transform
    expect(res.body.data.effective_year).toBe(2026)
    expect(Number(res.body.data.annual_rate_pct)).toBe(0.5)

    const row = await db.query(
      `SELECT 1 FROM landlord_deposit_interest_rate_overrides
        WHERE landlord_id=$1 AND state_code='AK' AND effective_year=2026`,
      [f.landlordId])
    expect(row.rows.length).toBe(1)
  })

  it('PUT against statutory state (MA 2026) → 409 with statutory rate disclosure', async () => {
    const f = await seedLFixture()
    // The test DB is schema-only — seed the MA 2026 statutory row
    // mirroring the prod migration 20260508130000_deposit_interest.sql.
    await db.query(
      `INSERT INTO state_deposit_interest_rates (state_code, effective_year, annual_rate_pct, statute_citation)
       VALUES ('MA', 2026, 5.0000, 'Mass. Gen. Laws Ch. 186 § 15B(2)(a)')
       ON CONFLICT DO NOTHING`)

    const res = await request(buildApp())
      .put('/api/landlords/me/deposit-interest-overrides')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stateCode: 'MA', effectiveYear: 2026, annualRatePct: 1.0 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/statutory rate of 5/)
    // No row persisted in the overrides table
    const row = await db.query(
      `SELECT 1 FROM landlord_deposit_interest_rate_overrides
        WHERE landlord_id=$1 AND state_code='MA'`, [f.landlordId])
    expect(row.rows.length).toBe(0)
  })

  it('DELETE removes a specific (state, year) override; idempotent on missing', async () => {
    const f = await seedLFixture()
    // Seed one then delete via the route
    await request(buildApp())
      .put('/api/landlords/me/deposit-interest-overrides')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stateCode: 'AK', effectiveYear: 2026, annualRatePct: 0.5 })

    const res = await request(buildApp())
      .delete('/api/landlords/me/deposit-interest-overrides/AK/2026')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)

    const row = await db.query(
      `SELECT 1 FROM landlord_deposit_interest_rate_overrides
        WHERE landlord_id=$1 AND state_code='AK' AND effective_year=2026`,
      [f.landlordId])
    expect(row.rows.length).toBe(0)

    // Second DELETE → still 200 (idempotent; DELETE was no-op)
    const res2 = await request(buildApp())
      .delete('/api/landlords/me/deposit-interest-overrides/AK/2026')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res2.status).toBe(200)
  })

  it('DELETE with malformed year → 400', async () => {
    const f = await seedLFixture()
    const res = await request(buildApp())
      .delete('/api/landlords/me/deposit-interest-overrides/AK/not-a-year')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid state or year/)
  })
})
