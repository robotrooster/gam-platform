/**
 * S483 — tenant GET /lease state-law warnings.
 *
 * 10/20 (Nic): "There should be no state law warnings anywhere in the system.
 * At least not right now. Just hide all that stuff." So the tenant sees
 * nothing, even on a lease the catalog would have flagged — the first test
 * below is the one that proves it on the real route, with the AZ deposit cap
 * seeded and a deposit at 2× rent.
 *
 * It is HIDDEN, not deleted, so the last test flips the one switch
 * (system_features.state_law_warnings_enabled) and shows the same request
 * producing the same warning again. cleanupAllSchema empties system_features
 * between tests, so the row never leaks into another case.
 *
 * Recompute-on-read posture mirrors S478 (entry-request GET). Schema.sql is
 * schema-only so state-law seed migrations don't survive the snapshot; this
 * file seeds AZ deposit_max_months inline.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s483'
})

interface Fixture {
  tenantUserId: string
  tenantId:     string
  leaseId:      string
  tenantToken:  string
}

async function seedAzDepositCap(): Promise<void> {
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO state_landlord_tenant_acts
       (state_code, act_key, act_name, unit_types, source_date, effective_year)
     VALUES ('AZ', 'residential', 'AZ Residential Landlord-Tenant Act',
             ARRAY['apartment','single_family']::text[], '2026-06-09', 2026)
     ON CONFLICT DO NOTHING
     RETURNING id`)
  const actId = a?.id ?? (await db.query<{ id: string }>(
    `SELECT id FROM state_landlord_tenant_acts WHERE state_code='AZ' AND act_key='residential' AND effective_year=2026 LIMIT 1`)).rows[0].id
  await db.query(
    `INSERT INTO state_law_provisions
       (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit,
        summary, statute_citation, source_url, source_date, effective_year)
     VALUES ($1, 'AZ', 'deposit_max_months', 'max', 1.5, 'months of rent',
             'Security deposit may not exceed 1.5 months of rent',
             'A.R.S. § 33-1321', 'https://www.azleg.gov/ars/33/01321.htm',
             '2026-06-09', 2026)
     ON CONFLICT DO NOTHING`, [actId])
}

async function seedFixture(opts: {
  rentAmount?: number
  depositAmount?: number | null
  state?: string
} = {}): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    const tenantUserId = tu.rows[0].user_id
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      state: opts.state ?? 'AZ',
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, {
      unitId, landlordId,
      leaseType: 'fixed_term',
      status: 'active',
      rentAmount: opts.rentAmount ?? 1500,
    })
    await client.query(
      `UPDATE leases SET end_date = '2026-12-31' WHERE id = $1`, [leaseId])
    await seedLeaseTenant(client, { leaseId, tenantId })
    if (opts.depositAmount != null) {
      await client.query(
        `INSERT INTO lease_fees
           (lease_id, fee_type, amount, is_refundable, due_timing)
         VALUES ($1, 'security_deposit', $2, TRUE, 'move_in')`,
        [leaseId, opts.depositAmount])
    }
    await client.query('COMMIT')
    const tenantToken = jwt.sign(
      { userId: tenantUserId, role: 'tenant', email: 't@test.dev',
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { tenantUserId, tenantId, leaseId, tenantToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

/** The one switch, turned on for a single test. */
async function showStateLawWarnings(): Promise<void> {
  await db.query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('state_law_warnings_enabled', TRUE, 'on for this test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
}

describe('GET /api/tenants/lease — S483 state-law warnings', () => {
  it('hidden 10/20: AZ deposit 2.0× rent (over the seeded 1.5mo cap) → nothing shown', async () => {
    await seedAzDepositCap()
    const f = await seedFixture({ rentAmount: 1500, depositAmount: 3000 })
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    // The field stays on the response so flipping the switch restores the
    // banner with no code change — it is simply always empty while hidden.
    expect(Array.isArray(res.body.data.state_law_warnings)).toBe(true)
    expect(res.body.data.state_law_warnings).toEqual([])
    expect(JSON.stringify(res.body)).not.toMatch(/not legal advice|A\.R\.S\./i)
  })

  it('AZ deposit 1.0× rent → state_law_warnings empty', async () => {
    await seedAzDepositCap()
    const f = await seedFixture({ rentAmount: 1500, depositAmount: 1500 })
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('no deposit lease_fees row → state_law_warnings empty (no deposit check fires)', async () => {
    await seedAzDepositCap()
    const f = await seedFixture({ rentAmount: 1500, depositAmount: null })
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('uncataloged state → state_law_warnings empty (no false alarm)', async () => {
    const f = await seedFixture({ rentAmount: 1500, depositAmount: 5000, state: 'XX' })
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('switch flipped ON → the same lease flags again (hidden, not deleted)', async () => {
    await seedAzDepositCap()
    await showStateLawWarnings()
    const f = await seedFixture({ rentAmount: 1500, depositAmount: 3000 })
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings.length).toBe(1)
    const flag = res.body.data.state_law_warnings[0]
    expect(flag.topic).toBe('deposit_max_months')
    expect(flag.message).toMatch(/above the 1\.5/)
    expect(flag.message).toMatch(/AZ/)
    expect(flag.disclaimer).toMatch(/may be out of date/i)
  })
})
