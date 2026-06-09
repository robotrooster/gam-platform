/**
 * tenants.ts lease-views slice — S378 (tenants.ts slice 5 of N).
 *
 * Covered routes (3):
 *   - GET  /api/tenants/lease — tenant's active lease detail
 *   - POST /api/tenants/lease/sign — deprecated 410 (e-sign owns this)
 *   - GET  /api/tenants/lease/addendums — credit-ledger event history
 *     for the tenant's active lease, with actor name resolved
 *
 * Slice 1 (S374): /me + landlord-banking + verify-ach + deposit-interest.
 * Slice 2 (S375): Flex + portability eligibility/authorize.
 * Slice 3 (S376): OTP-deprecated + credit-reporting + payments +
 *   portability decline + re-acceptance preview.
 * Slice 4 (S377): invite + accept-invite + invite-info
 *   (uncovered 2 production-breaking bugs — requireAuth gating
 *   public routes + bcryptjs typo).
 *
 * Out of slice (next sessions): admin-facing /:id/profile +
 *   /:id/transfer + /:id/available-units, profile patch + avatar +
 *   password, work-trade, charge-account.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const { resolveAddendumActorMock } = vi.hoisted(() => ({
  resolveAddendumActorMock: vi.fn(async (..._a: any[]) => ({
    name: 'Test Landlord', role: 'owner' as const,
  })),
}))
vi.mock('../services/addendumActor', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, resolveAddendumActor: resolveAddendumActorMock }
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
  resolveAddendumActorMock.mockClear()
  resolveAddendumActorMock.mockResolvedValue({ name: 'Test Landlord', role: 'owner' } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_lease'
})

interface LeasedTenantFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  unitId:         string
  tenantId:       string
  tenantUserId:   string
  leaseId:        string
  token:          string
}

async function seedLeasedTenant(opts: {
  leaseStatus?: 'pending' | 'active'
  attachLeaseTenant?: boolean
} = {}): Promise<LeasedTenantFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, {
      unitId, landlordId,
      status: opts.leaseStatus ?? 'active',
    })
    if (opts.attachLeaseTenant !== false) {
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    }
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev',
        profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return {
      landlordUserId, landlordId, propertyId, unitId,
      tenantId, tenantUserId: tu.rows[0].user_id, leaseId, token,
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

function tokenForUserId(userId: string, profileId: string | null = null): string {
  return jwt.sign(
    { userId, role: 'tenant', email: 't@test.dev', profileId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' },
  )
}

// Insert a lease_addendum_recorded credit event for `tenantId` against
// `leaseId`. Hash + chain integrity don't matter to the consumer route
// (it filters by subject + event_type + lease_id), so we pass random
// bytes and a NULL prev_hash.
async function insertAddendumEvent(args: {
  tenantId:    string
  leaseId:     string
  changes:     Array<{ field: string; from: string; to: string }>
  pdfFilename?: string | null
  recordedByUserId?: string | null
  occurredAt?: Date
}): Promise<string> {
  const subj = await db.query<{ id: string }>(
    `INSERT INTO credit_subjects (subject_type, subject_ref_id)
     VALUES ('tenant', $1)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [args.tenantId])
  const subjectId = subj.rows[0]?.id ?? (await db.query<{ id: string }>(
    `SELECT id FROM credit_subjects WHERE subject_type='tenant' AND subject_ref_id=$1`,
    [args.tenantId])).rows[0].id

  const evRes = await db.query<{ id: string }>(
    `INSERT INTO credit_events (
       subject_id, event_type, event_data, occurred_at,
       attestation_source, attestation_evidence,
       network_visibility, this_hash
     ) VALUES ($1, 'lease_addendum_recorded', $2, $3,
               'test', '{}'::jsonb, 'visible_to_current_landlord', $4)
     RETURNING id`,
    [
      subjectId,
      JSON.stringify({
        lease_id:             args.leaseId,
        changes:              args.changes,
        pdf_filename:         args.pdfFilename ?? null,
        recorded_by_user_id:  args.recordedByUserId ?? null,
      }),
      args.occurredAt ?? new Date(),
      crypto.randomBytes(32),
    ])
  return evRes.rows[0].id
}

describe('GET /lease', () => {
  it('no tenants row for caller → 404 Tenant not found', async () => {
    // JWT with a userId that has no users row (and therefore no
    // tenants row). The route SELECT t.id FROM tenants WHERE
    // user_id=$1 returns nothing.
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${tokenForUserId(randomUUID())}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/tenant not found/i)
  })

  it('tenant exists but no active lease_tenant → 404 No active unit', async () => {
    // Seed tenant but skip the lease_tenants attachment, so the
    // SELECT unit JOIN lease_tenants finds nothing.
    const f = await seedLeasedTenant({ attachLeaseTenant: false })
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/no active unit/i)
  })

  it('happy: returns lease with property_name, unit_number, landlord_name', async () => {
    const f = await seedLeasedTenant()
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.id).toBe(f.leaseId)
    expect(res.body.data.property_name).toBe('Test Property')
    expect(res.body.data.unit_number).toMatch(/^U-/)
    expect(res.body.data.landlord_name).toBe('Test Landlord')
    expect(res.body.data.status).toBe('active')
  })

  it('pending-only lease still surfaces (status IN pending, active)', async () => {
    const f = await seedLeasedTenant({ leaseStatus: 'pending' })
    // GET /lease first joins on `l.status = 'active'` (units join),
    // so a pending-only lease should 404 on "No active unit" even
    // though the second SELECT accepts pending. Pin that branch.
    const res = await request(buildApp())
      .get('/api/tenants/lease')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/no active unit/i)
  })
})

describe('POST /lease/sign (deprecated S20)', () => {
  it('returns 410 with e-sign redirect message', async () => {
    const f = await seedLeasedTenant()
    const res = await request(buildApp())
      .post('/api/tenants/lease/sign')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ signature: 'irrelevant' })
    expect(res.status).toBe(410)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toMatch(/no longer supported/i)
    expect(res.body.error).toMatch(/e-sign/i)
  })
})

describe('GET /lease/addendums', () => {
  it('no tenants row → 404 Tenant not found', async () => {
    const res = await request(buildApp())
      .get('/api/tenants/lease/addendums')
      .set('Authorization', `Bearer ${tokenForUserId(randomUUID())}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/tenant not found/i)
  })

  it('tenant with no active lease → 200 empty array (NOT 404)', async () => {
    // Asymmetry vs /lease: the addendum route is intentionally
    // generous with "no lease" since it's a history view —
    // returning empty is correct.
    const f = await seedLeasedTenant({ attachLeaseTenant: false })
    const res = await request(buildApp())
      .get('/api/tenants/lease/addendums')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual([])
  })

  it('happy: returns the addendum with resolved actor name', async () => {
    const f = await seedLeasedTenant()
    await insertAddendumEvent({
      tenantId: f.tenantId,
      leaseId:  f.leaseId,
      changes:  [{ field: 'rent_amount', from: '1000', to: '1100' }],
      pdfFilename: 'addendum-1.pdf',
      recordedByUserId: f.landlordUserId,
    })
    resolveAddendumActorMock.mockResolvedValueOnce({
      name: 'Test Landlord', role: 'owner',
    } as any)

    const res = await request(buildApp())
      .get('/api/tenants/lease/addendums')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({
      changes:          [{ field: 'rent_amount', from: '1000', to: '1100' }],
      pdf_filename:     'addendum-1.pdf',
      recorded_by_name: 'Test Landlord',
    })
    expect(resolveAddendumActorMock).toHaveBeenCalledWith(
      f.landlordUserId, f.landlordId,
    )
  })

  it('multiple addendums returned DESC by occurred_at', async () => {
    const f = await seedLeasedTenant()
    const olderDate = new Date('2026-01-01T12:00:00Z')
    const newerDate = new Date('2026-04-15T12:00:00Z')
    await insertAddendumEvent({
      tenantId: f.tenantId, leaseId: f.leaseId,
      changes: [{ field: 'pet_policy', from: 'no', to: 'yes' }],
      occurredAt: olderDate,
    })
    await insertAddendumEvent({
      tenantId: f.tenantId, leaseId: f.leaseId,
      changes: [{ field: 'parking_spot', from: '3', to: '7' }],
      occurredAt: newerDate,
    })

    const res = await request(buildApp())
      .get('/api/tenants/lease/addendums')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    // Newer first
    expect(res.body.data[0].changes[0].field).toBe('parking_spot')
    expect(res.body.data[1].changes[0].field).toBe('pet_policy')
  })

  it('addendum for a DIFFERENT lease is excluded', async () => {
    const f = await seedLeasedTenant()
    // Seed a second lease + addendum for the same tenant but
    // different lease_id; should NOT appear in results (route
    // filters event_data->>'lease_id' = $2).
    const otherLeaseId = randomUUID()
    await insertAddendumEvent({
      tenantId: f.tenantId, leaseId: otherLeaseId,
      changes: [{ field: 'other_field', from: 'a', to: 'b' }],
    })
    await insertAddendumEvent({
      tenantId: f.tenantId, leaseId: f.leaseId,
      changes: [{ field: 'this_lease', from: 'c', to: 'd' }],
    })

    const res = await request(buildApp())
      .get('/api/tenants/lease/addendums')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].changes[0].field).toBe('this_lease')
  })
})
