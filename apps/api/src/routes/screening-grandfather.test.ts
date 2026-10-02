/**
 * S579 — screening grandfather (onboarding-window waive) + property-level invite.
 *
 * Covers:
 *   - computeWindowDays formula (14 + 1/10 units, cap 30)
 *   - getOnboardingWindow open/closed semantics
 *   - POST /tenants/invite with propertyId → property-bound intent (unit_id NULL)
 *   - POST /tenants/:id/waive-screening — window-gated grandfather:
 *       open + attested → waiver recorded on THIS company's intent + audit
 *       (the person's own screening status is untouched); closed → 403;
 *       not attested → 400; not being onboarded to that unit → 404.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import {
  computeWindowDays, getOnboardingWindow, openOnboardingWindow, closeOnboardingWindow,
  ONBOARDING_WINDOW_CAP_DAYS, hasScreeningWaiver, applyScreeningWaive,
} from '../services/onboardingWindow'

vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, notifyTenantInviteAccepted: vi.fn(async () => undefined) }
})

import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_screening_gf'
})

async function seedFixture() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, token }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function seedTenant(): Promise<string> {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name)
     VALUES ($1,'x','tenant','Sit','Ting') RETURNING id`, [`t-${randomUUID()}@test.dev`])
  const t = await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
  return t.rows[0].id
}

/** The person is being onboarded to this unit by this company (a live invite). */
async function inviteToUnit(tenantId: string, f: { landlordId: string; propertyId: string; unitId: string }) {
  await db.query(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, property_id)
     VALUES ($1, $2, 'not_uploaded', $3, $4)`,
    [f.landlordId, tenantId, f.unitId, f.propertyId])
}

/** Open the property's onboarding window for the waive tests. */
async function openWindow(propertyId: string) {
  await openOnboardingWindow(propertyId)
}

describe('computeWindowDays', () => {
  it('base 14 for small properties', () => {
    expect(computeWindowDays(0)).toBe(14)
    expect(computeWindowDays(9)).toBe(14)
    expect(computeWindowDays(10)).toBe(15)
    expect(computeWindowDays(32)).toBe(17)   // Oak Park ~32 units
    expect(computeWindowDays(100)).toBe(24)
  })
  it('caps at 30 (one billing cycle)', () => {
    expect(computeWindowDays(300)).toBe(ONBOARDING_WINDOW_CAP_DAYS)
    expect(computeWindowDays(9999)).toBe(30)
  })
})

describe('getOnboardingWindow', () => {
  it('a freshly-opened window is open; closing it ends the grandfather', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    let w = await getOnboardingWindow(f.propertyId)
    expect(w.open).toBe(true)
    expect(w.startedAt).not.toBeNull()
    expect((w.daysRemaining ?? 0)).toBeGreaterThan(0)

    await closeOnboardingWindow(f.propertyId)
    w = await getOnboardingWindow(f.propertyId)
    expect(w.open).toBe(false)
    expect(w.completedAt).not.toBeNull()
  })
})

describe('POST /tenants/invite — property-level', () => {
  it('propertyId (no unit) creates a property-bound intent with unit_id NULL', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/tenants/invite')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'applicant@test.dev', firstName: 'App', lastName: 'Licant', propertyId: f.propertyId })
    expect(res.status).toBe(200)
    const intent = await db.query<{ property_id: string; unit_id: string | null }>(
      `SELECT property_id, unit_id FROM pending_tenant_intents pti
         JOIN tenants t ON t.id = pti.tenant_id
         JOIN users u ON u.id = t.user_id WHERE u.email = $1`, ['applicant@test.dev'])
    expect(intent.rows).toHaveLength(1)
    expect(intent.rows[0].property_id).toBe(f.propertyId)
    expect(intent.rows[0].unit_id).toBeNull()   // no unit → no lease auto-draft
  })
})

describe('POST /tenants/:id/waive-screening — grandfather', () => {
  it('window open + attested → waiver recorded on this company, the person’s own status untouched', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const tenantId = await seedTenant()
    await inviteToUnit(tenantId, f)
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(200)
    const t = await db.query<{ background_check_status: string }>(
      `SELECT background_check_status FROM tenants WHERE id=$1`, [tenantId])
    // The waiver is THIS company's record — never stamped platform-wide.
    expect(t.rows[0].background_check_status).toBe('not_started')
    expect(await hasScreeningWaiver(tenantId, [f.landlordId])).toBe(true)
    const intent = await db.query<{ landlord_id: string; screening_waived: boolean; screening_attested: boolean; screening_waived_unit_id: string; unit_id: string | null }>(
      `SELECT landlord_id, screening_waived, screening_attested, screening_waived_unit_id, unit_id
         FROM pending_tenant_intents WHERE tenant_id=$1 AND unit_id IS NULL`, [tenantId])
    expect(intent.rows).toHaveLength(1)
    expect(intent.rows[0].landlord_id).toBe(f.landlordId)
    expect(intent.rows[0].screening_waived).toBe(true)
    expect(intent.rows[0].screening_attested).toBe(true)
    expect(intent.rows[0].screening_waived_unit_id).toBe(f.unitId)
    expect(intent.rows[0].unit_id).toBeNull()   // NOT set → no lease auto-draft
  })

  it('not attested → 400', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const tenantId = await seedTenant()
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: false })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/attest/i)
  })

  it('window closed → 403 (screening mandatory)', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    await closeOnboardingWindow(f.propertyId)
    const tenantId = await seedTenant()
    await inviteToUnit(tenantId, f)
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/onboarding window/i)
  })

  // S636 (Nic, DIRECTIVE) REVERSED THIS. It asserted one grandfather per unit,
  // which meant one per HOUSEHOLD — the first adult in a mobile home was waived
  // and their spouse was sent to a background check. See the household describe
  // below for the rule that replaced it.
})


// ─── S636: a household, not a slot ───────────────────────────────────────────
//
// Nic (DIRECTIVE): "All people that are onboarding as existing tenants with a
// new electronic signature should not be asked to do the background screening at
// all. The onboarding existing tenants should automatically be bypassing that
// during the onboarding window."
//
// The waive used to be ONE PER UNIT, which in practice meant one per HOUSEHOLD:
// the first adult invited to a mobile home was grandfathered and their spouse
// was sent to a background check. Both have lived there for years and neither is
// applying for anything. At Mountain View it put 22 sitting residents in front
// of a screening they should never have seen — Nic found it when the second
// Fierro was asked for one.
describe('S636 every adult in a household is grandfathered, not just the first', () => {
  it('a second tenant on the SAME unit is waived too', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const first = await seedTenant()
    const second = await seedTenant()

    for (const tenantId of [first, second]) {
      await inviteToUnit(tenantId, f)
      const res = await request(buildApp())
        .post(`/api/tenants/${tenantId}/waive-screening`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
      expect(res.status, `tenant ${tenantId} was refused the waive`).toBe(200)
    }

    // THE POINT: the spouse is not sent to a background check.
    expect(await hasScreeningWaiver(first, [f.landlordId])).toBe(true)
    expect(await hasScreeningWaiver(second, [f.landlordId])).toBe(true)
  })

  it('the window still bounds it — a closed window screens everybody', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    await db.query(`UPDATE properties SET onboarding_completed_at = NOW() WHERE id = $1`, [f.propertyId])
    const tenantId = await seedTenant()
    await inviteToUnit(tenantId, f)
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(403)
  })
})

// S652 (Nic, option 2): a RETURNING resident skips the check on the landlord's
// attestation, outside any window; every attestation is recorded and counted
// against a rolling year's allowance of 25% of the property's sites. Over it,
// the platform is flagged — the landlord never sees the count.
describe('returning resident — attested, recorded, capped', () => {
  it('waives the check, records why, and refuses once the allowance is used up', async () => {
    const f = await seedFixture()   // one unit → allowance = max(1, ceil(0.25)) = 1
    const app = buildApp()
    const invite = (email: string) => request(app).post('/api/tenants/invite')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email, firstName: 'Back', lastName: 'Again', unitId: f.unitId, returningResident: true })

    const one = await invite('back1@test.dev')
    expect(one.status).toBeLessThan(300)
    const t1 = (await db.query<any>(
      `SELECT t.background_check_status, i.waive_reason FROM tenants t JOIN users u ON u.id = t.user_id
         LEFT JOIN pending_tenant_intents i ON i.tenant_id = t.id AND i.waive_reason IS NOT NULL
        WHERE u.email = 'back1@test.dev'`)).rows[0]
    // Recorded on this company's intent; the person's own status is untouched.
    expect(t1.background_check_status).toBe('not_started')
    expect(t1.waive_reason).toBe('returning_resident')
    expect(Number((await db.query(`SELECT COUNT(*) FROM admin_notifications WHERE category = 'returning_resident_over_allowance'`)).rows[0].count)).toBe(0)

    const two = await invite('back2@test.dev')
    expect(two.status).toBe(409)
    expect(two.body.error).toMatch(/returning-resident allowance/i)
  })

  it('a returning resident must be invited to a space', async () => {
    const f = await seedFixture()
    const res = await request(buildApp()).post('/api/tenants/invite')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'back3@test.dev', firstName: 'Back', lastName: 'Again', propertyId: f.propertyId, returningResident: true })
    expect(res.status).toBe(400)
  })
})


// ─── S655 security: a waiver is one company's record ─────────────────────────
//
// A grandfather waiver used to be written onto the person's ONE platform-wide
// screening status. Every company then read it as "screened", it overwrote a
// real approval or denial, and any landlord with an open window could waive any
// tenant id on GAM.
describe('S655 the waiver belongs to the company that granted it', () => {
  it('a person not being onboarded to that unit gets 404 and nothing is written', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const stranger = await seedTenant()
    const res = await request(buildApp())
      .post(`/api/tenants/${stranger}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(404)
    const { rows } = await db.query(`SELECT 1 FROM pending_tenant_intents WHERE tenant_id = $1`, [stranger])
    expect(rows).toHaveLength(0)
  })

  it('an invite to a DIFFERENT unit is not enough', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const tenantId = await seedTenant()
    const c = await db.connect()
    let otherUnit: string
    try { otherUnit = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId }) } finally { c.release() }
    await inviteToUnit(tenantId, { ...f, unitId: otherUnit })
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(404)
  })

  it('a resident on an active lease at that unit can be waived', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    const tenantId = await seedTenant()
    const { rows: [l] } = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1, $2, 900, 'month_to_month', 'active', '2020-01-01') RETURNING id`, [f.unitId, f.landlordId])
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [l.id, tenantId])
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
    expect(res.status).toBe(200)
  })

  it('a real approval or denial survives a waiver', async () => {
    const f = await seedFixture()
    await openWindow(f.propertyId)
    for (const real of ['approved', 'denied']) {
      const tenantId = await seedTenant()
      await db.query(`UPDATE tenants SET background_check_status = $2 WHERE id = $1`, [tenantId, real])
      await inviteToUnit(tenantId, f)
      const res = await request(buildApp())
        .post(`/api/tenants/${tenantId}/waive-screening`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ propertyId: f.propertyId, unitId: f.unitId, attested: true })
      expect(res.status).toBe(200)
      const { rows: [t] } = await db.query<{ background_check_status: string }>(
        `SELECT background_check_status FROM tenants WHERE id = $1`, [tenantId])
      expect(t.background_check_status).toBe(real)
    }
  })

  it('hasScreeningWaiver answers only for the companies asked about', async () => {
    const x = await seedFixture()
    const y = await seedFixture()
    await openWindow(x.propertyId)
    const tenantId = await seedTenant()
    await inviteToUnit(tenantId, x)
    const r = await applyScreeningWaive({
      tenantId, landlordId: x.landlordId, propertyId: x.propertyId, unitId: x.unitId, byUserId: x.userId,
    })
    expect(r.waived).toBe(true)
    expect(await hasScreeningWaiver(tenantId, [x.landlordId])).toBe(true)
    expect(await hasScreeningWaiver(tenantId, [y.landlordId])).toBe(false)
    expect(await hasScreeningWaiver(tenantId, [])).toBe(false)
  })

  it('company X’s waiver never rewrites company Y’s no-unit invite', async () => {
    const x = await seedFixture()
    const y = await seedFixture()
    await openWindow(x.propertyId)
    const tenantId = await seedTenant()
    // Y invited this person to its PROPERTY (a live no-unit row).
    const { rows: [yRow] } = await db.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, property_id, unit_id)
       VALUES ($1, $2, 'not_uploaded', $3, NULL) RETURNING id`, [y.landlordId, tenantId, y.propertyId])
    await inviteToUnit(tenantId, x)

    const before = (await db.query(`SELECT * FROM pending_tenant_intents WHERE id = $1`, [yRow.id])).rows[0]

    // While the old tenant-only index still stands (before the contract
    // migration), X's waiver is refused rather than written onto Y's row.
    const res = await request(buildApp())
      .post(`/api/tenants/${tenantId}/waive-screening`)
      .set('Authorization', `Bearer ${x.token}`)
      .send({ propertyId: x.propertyId, unitId: x.unitId, attested: true })
    expect(res.status).toBe(409)
    const mid = (await db.query(`SELECT * FROM pending_tenant_intents WHERE id = $1`, [yRow.id])).rows[0]
    expect(mid).toEqual(before)

    // Once the old index is gone (the contract step), X gets its OWN row and
    // Y's is still untouched.
    await db.query(`DROP INDEX pending_tenant_intents_tenant_nounit_live_key`)
    try {
      const res2 = await request(buildApp())
        .post(`/api/tenants/${tenantId}/waive-screening`)
        .set('Authorization', `Bearer ${x.token}`)
        .send({ propertyId: x.propertyId, unitId: x.unitId, attested: true })
      expect(res2.status).toBe(200)
      const after = (await db.query(`SELECT * FROM pending_tenant_intents WHERE id = $1`, [yRow.id])).rows[0]
      expect(after).toEqual(before)
      expect(await hasScreeningWaiver(tenantId, [x.landlordId])).toBe(true)
      expect(await hasScreeningWaiver(tenantId, [y.landlordId])).toBe(false)
    } finally {
      await db.query(`UPDATE pending_tenant_intents SET cancelled_at = NOW() WHERE tenant_id = $1 AND unit_id IS NULL AND landlord_id = $2`, [tenantId, x.landlordId])
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS pending_tenant_intents_tenant_nounit_live_key
           ON pending_tenant_intents (tenant_id) WHERE cancelled_at IS NULL AND unit_id IS NULL`)
    }
  })
})
