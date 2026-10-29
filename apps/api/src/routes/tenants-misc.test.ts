/**
 * tenants.ts misc slice — S381 (tenants.ts slice 8 of N, the CLOSER).
 *
 * Covered routes (2):
 *   - GET /api/tenants/work-trade — active work-trade agreement
 *   - GET /api/tenants/charge-account — deprecated 410 (S381)
 *
 * This slice closes the tenants.ts arc. After S381, all 40 routes
 * in tenants.ts have at least one test pin.
 *
 * Slice arc map (cumulative):
 *   S374 slice 1: /me + landlord-banking + verify-ach + deposit-interest (5)
 *     (S655: the mock POST /verify-ach was removed; its pin lives in
 *     tenants-profile-dashboard.test.ts)
 *   S375 slice 2: FlexCharge/Pay/Deposit/Suite + portability auth (13)
 *   S376 slice 3: OTP/credit/payments + portability decline + re-accept preview (5)
 *   S377 slice 4: invite + accept-invite + invite-info (3) [+ 2 bugs fixed]
 *   S378 slice 5: lease views (3)
 *   S379 slice 6: admin :id/profile + :id/transfer + :id/available-units (3) [+ 1 bug fixed]
 *   S380 slice 7: profile patch + avatar POST/GET + password (4) [+ 3 bugs fixed]
 *   S381 slice 8: work-trade + charge-account (2) [+ 1 bug fixed via retire-410]
 *
 * Production bug fixed in this slice:
 *   - GET /charge-account referenced non-existent
 *     pos_transactions.settled column; would 500 on every call.
 *     Route is orphaned (no frontend consumer); FlexCharge subsystem
 *     replaced it. Retired as 410 with redirect message to
 *     /api/tenants/flexcharge.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_misc'
})

interface TFixture {
  landlordId: string
  unitId:     string
  tenantId:   string
  token:      string
  leaseId:    string
}

async function seedFixture(): Promise<TFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const tenantId = await seedTenant(client)
    // 10/19 (review): the fixture now carries a REAL TENANCY, because the
    // paused-visibility gate is about the tenancy and not the status word. A
    // work trade cannot be created without an active lease in production
    // (routes/workTrade POST), so a fixture without one was a shape no landlord
    // can reach — and it would have hidden the move-out bug this pins below.
    const leaseId = await seedLease(client, { unitId, landlordId })
    await seedLeaseTenant(client, { leaseId, tenantId })
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev',
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordId, unitId, tenantId, token, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /work-trade', () => {
  it('no tenants row for caller → 404 Tenant not found', async () => {
    const token = jwt.sign(
      { userId: randomUUID(), role: 'tenant', email: 't@test.dev',
        profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/tenants/work-trade')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/tenant not found/i)
  })

  it('tenant with no active agreement → 200 data:null', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/tenants/work-trade')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toBeNull()
  })

  it('happy: returns active agreement with unit_number + property_name', async () => {
    const f = await seedFixture()
    await db.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, duties)
       VALUES ($1, $2, $3, CURRENT_DATE, 'active', 'groundskeeping')`,
      [f.unitId, f.tenantId, f.landlordId])

    const res = await request(buildApp())
      .get('/api/tenants/work-trade')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.duties).toBe('groundskeeping')
    // S613: seeded unit numbers are CANONICALISED like production ones, and an
    // all-digit hex suffix canonicalises 'U-123456' → 'U 123456' (hyphen to
    // space). Either shape is the same seeded unit.
    expect(res.body.data.unit_number).toMatch(/^U[- ]/)
    expect(res.body.data.property_name).toBe('Test Property')
  })

  it('ended agreements stay hidden — a dead trade does not come back', async () => {
    const f = await seedFixture()
    await db.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status)
       VALUES ($1, $2, $3, CURRENT_DATE - interval '1 year', 'ended')`,
      [f.unitId, f.tenantId, f.landlordId])

    const res = await request(buildApp())
      .get('/api/tenants/work-trade')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 10/19 (Nic) — "SHOW IT WHILE PAUSED."
  //
  // This one route is what FOUR tenant surfaces ask: the nav tab, the Work
  // Trade page, the Meter Readings page, and the tenant assistant's own tool
  // (which carries the same widening). It answered `status = 'active'` only, so
  // a paused agreement came back empty, the tab disappeared, and the honest
  // sentence — "your hours keep counting while this is paused", the one a
  // snowbird most needs — reached nobody.
  describe('a paused agreement is visible to its tenant', () => {
    const seedAgreement = (f: TFixture, status: string, extra: Record<string, any> = {}) => db.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, duties, tracks_hours)
       VALUES ($1, $2, $3, CURRENT_DATE - interval '2 months', $4, 'groundskeeping', $5)`,
      [f.unitId, f.tenantId, f.landlordId, status, extra.tracksHours ?? true])

    it('returns the paused agreement, so the tab stays up', async () => {
      const f = await seedFixture()
      await seedAgreement(f, 'paused')
      const res = await request(buildApp())
        .get('/api/tenants/work-trade')
        .set('Authorization', `Bearer ${f.token}`)
      expect(res.status).toBe(200)
      expect(res.body.data).not.toBeNull()
      expect(res.body.data.status).toBe('paused')
      // Every surface reads whether hours are counting off this one answer
      // rather than re-deriving it — the same expression the month close uses
      // (hoursCountedSql), which is what stops a tenant being shown a target
      // the close is about to waive. An unanswered pause counts hours, which is
      // what every paused agreement did before the space question existed.
      expect(res.body.data.hours_counted).toBe(true)
    })

    it('says hours are NOT counting on a paused trade nobody clocks', async () => {
      const f = await seedFixture()
      await seedAgreement(f, 'paused', { tracksHours: false })
      const res = await request(buildApp())
        .get('/api/tenants/work-trade')
        .set('Authorization', `Bearer ${f.token}`)
      expect(res.body.data.status).toBe('paused')
      expect(res.body.data.hours_counted).toBe(false)
    })

    it('prefers the running agreement when a tenant has both', async () => {
      const f = await seedFixture()
      await seedAgreement(f, 'paused')
      await seedAgreement(f, 'active')
      const res = await request(buildApp())
        .get('/api/tenants/work-trade')
        .set('Authorization', `Bearer ${f.token}`)
      // A paused seasonal trade on one space and a running one on another: the
      // portal is about the live arrangement.
      expect(res.body.data.status).toBe('active')
    })

    it('never shows one tenant another tenant’s paused agreement', async () => {
      const mine = await seedFixture()
      await seedAgreement(mine, 'paused')
      const stranger = await seedFixture()
      const res = await request(buildApp())
        .get('/api/tenants/work-trade')
        .set('Authorization', `Bearer ${stranger.token}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toBeNull()
    })

    // ─────────────────────────────────────────────────────────────────────────
    // 10/19 (review) — BUT A MOVE-OUT PAUSES IT TOO.
    //
    // Leaving 'ended' out of the widening was not the whole gate: the lease-end
    // processor PAUSES every active work trade on a unit when a lease reaches
    // its end_date with no signed successor (jobs/scheduler — "work trade is
    // rent-for-labor — it can't outlive the tenancy"), and nothing ever moves
    // that row on to 'ended'. So the widening alone handed a former resident
    // their Work Trade tab back a month after they left, reading "your hours
    // keep counting until your landlord says whether the space is still being
    // used". The gate is the tenancy, not the word (liveTenancySql).
    it('hides a trade paused by a move-out — the tenancy is gone', async () => {
      const f = await seedFixture()
      await seedAgreement(f, 'paused')
      // What the lease-end processor leaves behind: the lease expired, the
      // people on it removed, the work trade paused and never ended.
      await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [f.leaseId])
      await db.query(
        `UPDATE lease_tenants SET status='removed', removed_reason='lease_ended' WHERE lease_id=$1`,
        [f.leaseId])
      const res = await request(buildApp())
        .get('/api/tenants/work-trade')
        .set('Authorization', `Bearer ${f.token}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toBeNull()
    })

    // The pause the gate exists to KEEP showing: a snowbird's spot asleep for
    // the season. Hibernation sets is_hibernating on an ACTIVE lease and leaves
    // lease_tenants alone, so the tenancy is still there and the tab stays up.
    it('still shows a trade paused by lease hibernation', async () => {
      const f = await seedFixture()
      await seedAgreement(f, 'paused')
      await db.query(`UPDATE leases SET is_hibernating=TRUE WHERE id=$1`, [f.leaseId])
      await db.query(
        `UPDATE work_trade_agreements SET paused_by_hibernation=TRUE WHERE tenant_id=$1`,
        [f.tenantId])
      const res = await request(buildApp())
        .get('/api/tenants/work-trade')
        .set('Authorization', `Bearer ${f.token}`)
      expect(res.body.data?.status).toBe('paused')
    })

    // A work trade made for a STAY has a booking and may have no lease at all
    // (10/6, services/stayWorkTrade), so the booking is its tenancy.
    it('shows a stay trade paused against a live booking', async () => {
      const f = await seedFixture()
      await seedAgreement(f, 'paused')
      await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [f.leaseId])
      await db.query(`UPDATE lease_tenants SET status='removed' WHERE lease_id=$1`, [f.leaseId])
      const b = await db.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, tenant_id, landlord_id, lease_type, check_in, check_out, status)
         VALUES ($1, $2, $3, 'nightly', CURRENT_DATE - 5, CURRENT_DATE + 20, 'checked_in')
         RETURNING id`, [f.unitId, f.tenantId, f.landlordId])
      await db.query(`UPDATE work_trade_agreements SET booking_id=$2 WHERE tenant_id=$1`,
        [f.tenantId, b.rows[0].id])
      const res = await request(buildApp())
        .get('/api/tenants/work-trade')
        .set('Authorization', `Bearer ${f.token}`)
      expect(res.body.data?.status).toBe('paused')
    })

    // 10/12 (Nic): a rate kept from an earlier setting is not the tenant's to
    // read. This route handed over the whole row, so the one number that must
    // never sit beside an hour count for a tenant was reachable here.
    it('withholds the extra-hours rate unless the agreement pays extra hours', async () => {
      const f = await seedFixture()
      await seedAgreement(f, 'paused')
      await db.query(
        `UPDATE work_trade_agreements SET extra_hours_mode='bank', extra_hours_rate=15
          WHERE tenant_id=$1`, [f.tenantId])
      const res = await request(buildApp())
        .get('/api/tenants/work-trade')
        .set('Authorization', `Bearer ${f.token}`)
      expect(res.body.data.extra_hours_rate).toBeNull()
    })
  })
})

describe('GET /charge-account (deprecated S381)', () => {
  it('returns 410 with redirect message to /flexcharge', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/tenants/charge-account')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(410)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toMatch(/deprecated/i)
    expect(res.body.error).toMatch(/flexcharge/i)
  })
})
