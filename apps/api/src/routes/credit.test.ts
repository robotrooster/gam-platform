/**
 * credit.ts full slice — S392. Closes the credit-ledger route layer at 100%.
 *
 * Covered routes (16):
 *   Subject views: /subject/own, /subject/:id, /screening-by-tenant/:id, /stats/:id
 *   Score: /score/:id (lending-only), /score/:id/recompute (lending-only)
 *   Attest: /attest (landlord/PM with active relationship)
 *   Disputes: /disputes/mine, /disputes/:id (admin), /disputes (admin list),
 *             /dispute (open), /dispute/:id/evidence, /dispute/:id/resolve (admin)
 *   Hardship: /hardship-context (tenant-only on own)
 *   Integrity: /integrity/anchors, /integrity/verify/:id
 *
 * Production bugs fixed in this slice (2, both HIGH-severity):
 *   - **openDispute** in services/creditDispute.ts didn't verify the
 *     disputed event belongs to the disputing subject. **A tenant could
 *     open a dispute against ANY event in the system** (including
 *     strangers'). Admin resolution then writes a "corrected" event on
 *     the stranger's chain via supersede — cross-subject credit
 *     manipulation.
 *   - **submitDisputeEvidence** didn't verify dispute ownership.
 *     **Any tenant could submit evidence on another tenant's dispute**
 *     by passing the foreign dispute UUID — injecting evidence that
 *     influences admin resolution.
 *
 * Both fixed at the service layer with explicit ownership predicates.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedTenant, seedLandlord, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { appendEvent } from '../services/creditLedger'
import { creditRouter } from './credit'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/credit', creditRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_credit'
})

interface Fixture {
  landlordAUserId:   string
  landlordAId:       string
  landlordBUserId:   string
  landlordBId:       string
  tenantAId:         string  // tenant A leased to landlord A
  tenantAUserId:     string
  tenantBId:         string  // tenant B leased to landlord B (no relation to landlord A)
  tenantBUserId:     string
  unitAId:           string
  unitBId:           string
  propertyAId:       string
  propertyBId:       string
  tenantAToken:      string
  tenantBToken:      string
  landlordAToken:    string
  landlordBToken:    string
  adminToken:        string
}

// requireLendingService gate accepts admin/super_admin OR a request
// bearing X-Gam-Lending-Token equal to CREDIT_LENDING_SERVICE_TOKEN.
const LENDING_TOKEN_VALUE = 'test_lending_token_s392'

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aLU, landlordId: aLId } = await seedLandlord(c)
    const { userId: bLU, landlordId: bLId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aLId, ownerUserId: aLU, managedByUserId: aLU })
    const propB = await seedProperty(c, { landlordId: bLId, ownerUserId: bLU, managedByUserId: bLU })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aLId })
    const unitB = await seedUnit(c, { propertyId: propB, landlordId: bLId })
    const tenantA = await seedTenant(c)
    const tenantB = await seedTenant(c)
    const taUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantA])
    const tbUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantB])

    // Active lease: tenant A on landlord A's unit
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: aLId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA })
    // Active lease: tenant B on landlord B's unit (no overlap)
    const leaseB = await seedLease(c, { unitId: unitB, landlordId: bLId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseB, tenantId: tenantB })

    const admin = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])

    await c.query('COMMIT')
    process.env.CREDIT_LENDING_SERVICE_TOKEN = LENDING_TOKEN_VALUE
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aLU, landlordAId: aLId,
      landlordBUserId: bLU, landlordBId: bLId,
      tenantAId: tenantA, tenantAUserId: taUser.rows[0].user_id,
      tenantBId: tenantB, tenantBUserId: tbUser.rows[0].user_id,
      unitAId: unitA, unitBId: unitB, propertyAId: propA, propertyBId: propB,
      tenantAToken:   sign({ userId: taUser.rows[0].user_id, role: 'tenant', email: 'ta@t.dev', profileId: tenantA, permissions: {} }),
      tenantBToken:   sign({ userId: tbUser.rows[0].user_id, role: 'tenant', email: 'tb@t.dev', profileId: tenantB, permissions: {} }),
      landlordAToken: sign({ userId: aLU, role: 'landlord', email: 'la@t.dev', profileId: aLId, permissions: {} }),
      landlordBToken: sign({ userId: bLU, role: 'landlord', email: 'lb@t.dev', profileId: bLId, permissions: {} }),
      adminToken:     sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedTenantEvent(tenantId: string, opts: {
  eventType?: string; visibility?: string;
} = {}): Promise<{ eventId: string; subjectId: string }> {
  const r = await appendEvent({
    subjectType:           'tenant',
    subjectRefId:          tenantId,
    eventType:             (opts.eventType ?? 'payment_received_on_time') as any,
    eventData:             { amount: 1000 },
    occurredAt:            new Date(),
    attestationSource:     'gam_workflow_auto',
    attestationEvidence:   {},
    dimensionTags:         ['payment_history'] as any,
    networkVisibility:     (opts.visibility ?? 'visible_to_gam_network') as any,
  })
  return { eventId: r.eventId, subjectId: r.subjectId }
}

// ───────────────────────────────────────────────────────────────────
// GET /subject/own
// ───────────────────────────────────────────────────────────────────

describe('GET /subject/own', () => {
  it('tenant with no events → subject_id null + empty events', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/credit/subject/own')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.subject_id).toBeNull()
    expect(res.body.data.events).toEqual([])
  })

  it('tenant with events → returns own chain', async () => {
    const f = await seed()
    await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .get('/api/credit/subject/own')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.events).toHaveLength(1)
    expect(res.body.data.events[0].event_type).toBe('payment_received_on_time')
  })

  it('admin caller (no subject mapping) → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/credit/subject/own')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no subject mapping/i)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /subject/:subjectId
// ───────────────────────────────────────────────────────────────────

describe('GET /subject/:subjectId', () => {
  it('unknown subject → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/credit/subject/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(404)
  })

  it('admin sees all events regardless of visibility', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId, { visibility: 'private_to_subject' })
    const res = await request(buildApp())
      .get(`/api/credit/subject/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.events).toHaveLength(1)
  })

  it('unrelated landlord → only visible_to_gam_network events', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId, { visibility: 'private_to_subject' })
    // Landlord B has no lease relationship with tenant A.
    const res = await request(buildApp())
      .get(`/api/credit/subject/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.landlordBToken}`)
    expect(res.status).toBe(200)
    // private_to_subject event filtered out → empty events
    expect(res.body.data.events).toEqual([])
  })

  it('current landlord (active lease) → sees visible_to_current_landlord + network', async () => {
    const f = await seed()
    await seedTenantEvent(f.tenantAId, { visibility: 'visible_to_current_landlord' })
    const a = await seedTenantEvent(f.tenantAId, { visibility: 'visible_to_gam_network' })
    const res = await request(buildApp())
      .get(`/api/credit/subject/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.events).toHaveLength(2)
  })

  it('subject viewing own → 200 with all tiers including private', async () => {
    const f = await seed()
    await seedTenantEvent(f.tenantAId, { visibility: 'private_to_subject' })
    const a = await seedTenantEvent(f.tenantAId, { visibility: 'visible_to_gam_network' })
    const res = await request(buildApp())
      .get(`/api/credit/subject/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.events).toHaveLength(2)
  })
})

// ───────────────────────────────────────────────────────────────────
// Screening + stats
// ───────────────────────────────────────────────────────────────────

describe('GET /screening-by-tenant/:tenantId', () => {
  it('no events yet → empty payload', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/credit/screening-by-tenant/${f.tenantAId}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.subject_id).toBeNull()
    expect(res.body.data.events).toEqual([])
  })

  it('unrelated landlord with events on subject → still 200 with network-tier filter (no 403 when network-visible events exist)', async () => {
    const f = await seed()
    await seedTenantEvent(f.tenantAId, { visibility: 'visible_to_gam_network' })
    const res = await request(buildApp())
      .get(`/api/credit/screening-by-tenant/${f.tenantAId}`)
      .set('Authorization', `Bearer ${f.landlordBToken}`)
    // canViewSubject returns ['visible_to_gam_network'] for unrelated
    // landlord — allowed list is non-empty so no 403; filtered to
    // network-tier events only.
    expect(res.status).toBe(200)
    expect(res.body.data.events).toHaveLength(1)
  })

  it('related landlord → 200 with current+network events', async () => {
    const f = await seed()
    await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .get(`/api/credit/screening-by-tenant/${f.tenantAId}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.events).toHaveLength(1)
  })
})

describe('GET /stats/:subjectId', () => {
  it('unknown subject → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/credit/stats/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(404)
  })

  it('related landlord can read stats', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .get(`/api/credit/stats/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────
// Score routes (lending-service-gated)
// ───────────────────────────────────────────────────────────────────

describe('Score routes — requireLendingService gate', () => {
  it('GET /score/:id tenant caller (no admin, no token) → 403', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .get(`/api/credit/score/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(403)
  })

  it('GET /score/:id admin → 200 (admins bypass per the locked design)', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .get(`/api/credit/score/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
  })

  it('GET /score/:id non-admin with valid X-Gam-Lending-Token → 200', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .get(`/api/credit/score/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .set('X-Gam-Lending-Token', LENDING_TOKEN_VALUE)
    expect(res.status).toBe(200)
  })

  it('POST /score/:id/recompute admin passes the gate (not 403)', async () => {
    // The gate accepts admin; the underlying recompute may 500 if the
    // formula seed migration hasn't run in the test DB. We only verify
    // the requireLendingService gate, not the score math (that's
    // covered by creditScore.test.ts).
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .post(`/api/credit/score/${a.subjectId}/recompute`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).not.toBe(403)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /attest (landlord-attestable events)
// ───────────────────────────────────────────────────────────────────

describe('POST /attest', () => {
  it('non-landlord/PM → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/credit/attest')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ tenantId: f.tenantAId, eventType: 'eviction_notice_filed', occurredAt: '2026-06-01' })
    expect(res.status).toBe(403)
  })

  it('non-attestable event_type → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/credit/attest')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ tenantId: f.tenantAId, eventType: 'payment_received_on_time', occurredAt: '2026-06-01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not landlord-attestable/i)
  })

  it('no relationship with tenant → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/credit/attest')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ tenantId: f.tenantBId, eventType: 'eviction_notice_filed', occurredAt: '2026-06-01' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/no tenancy relationship/i)
  })

  it('happy: landlord with relationship attests eviction event', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/credit/attest')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        tenantId: f.tenantAId,
        eventType: 'eviction_notice_filed',
        occurredAt: '2026-06-01',
        evidence: { case_number: 'CV-123' },
      })
    expect(res.status).toBe(200)
    expect(res.body.data.event_id).toBeTruthy()
  })
})

// ───────────────────────────────────────────────────────────────────
// Disputes
// ───────────────────────────────────────────────────────────────────

describe('GET /disputes/mine + /disputes admin views', () => {
  it('/disputes/mine non-tenant/landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/credit/disputes/mine')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(403)
  })

  it('/disputes admin → 200; non-admin → 403', async () => {
    const f = await seed()
    const r1 = await request(buildApp())
      .get('/api/credit/disputes')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(r1.status).toBe(403)
    const r2 = await request(buildApp())
      .get('/api/credit/disputes')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(r2.status).toBe(200)
    expect(r2.body.data).toEqual([])
  })

  it('/disputes/:id non-admin → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/credit/disputes/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(403)
  })

  it('/disputes/:id admin unknown → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/credit/disputes/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /dispute — S392 ownership fix', () => {
  it('S392 fix: tenant disputing a STRANGER\'s event → error (cross-subject blocked)', async () => {
    const f = await seed()
    // Seed an event on tenant B's chain
    const bEvent = await seedTenantEvent(f.tenantBId)
    // Tenant A tries to dispute B's event
    const res = await request(buildApp())
      .post('/api/credit/dispute')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ disputedEventId: bEvent.eventId, reason: 'factual_inaccuracy', notes: 'attempt cross-subject dispute' })
    // Pre-fix: 200 with created dispute. Post-fix: errors out (400 or 500 from errorHandler).
    expect(res.status).not.toBe(200)
    // Confirm no dispute row was created.
    const disputes = await db.query(`SELECT id FROM credit_disputes`)
    expect(disputes.rows).toHaveLength(0)
  })

  it('happy: tenant opens dispute on own event', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .post('/api/credit/dispute')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ disputedEventId: a.eventId, reason: 'factual_inaccuracy', notes: 'wrong amount' })
    expect(res.status).toBe(200)
    expect(res.body.data.disputeId).toBeTruthy()
  })
})

describe('POST /dispute/:id/evidence — S392 ownership fix', () => {
  it('S392 fix: tenant submitting evidence on STRANGER\'s dispute → error', async () => {
    const f = await seed()
    // Tenant B opens a dispute on B's own event
    const bEvent = await seedTenantEvent(f.tenantBId)
    const open = await request(buildApp())
      .post('/api/credit/dispute')
      .set('Authorization', `Bearer ${f.tenantBToken}`)
      .send({ disputedEventId: bEvent.eventId, reason: 'factual_inaccuracy' })
    expect(open.status).toBe(200)
    const disputeId = open.body.data.disputeId

    // Tenant A tries to submit evidence on B's dispute
    const res = await request(buildApp())
      .post(`/api/credit/dispute/${disputeId}/evidence`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ evidence: { hijacked: true } })
    expect(res.status).not.toBe(200)
  })

  it('happy: dispute owner submits evidence', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId)
    const open = await request(buildApp())
      .post('/api/credit/dispute')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ disputedEventId: a.eventId, reason: 'factual_inaccuracy' })
    const disputeId = open.body.data.disputeId
    const res = await request(buildApp())
      .post(`/api/credit/dispute/${disputeId}/evidence`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ evidence: { receipt_url: 'https://x.test/r.pdf' } })
    expect(res.status).toBe(200)
  })
})

describe('POST /dispute/:id/resolve', () => {
  it('non-admin → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/credit/dispute/${randomUUID()}/resolve`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ outcome: 'no_change' })
    expect(res.status).toBe(403)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /hardship-context
// ───────────────────────────────────────────────────────────────────

describe('POST /hardship-context', () => {
  it('non-tenant → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/credit/hardship-context')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ category: 'medical', startDate: '2026-05-01' })
    expect(res.status).toBe(403)
  })

  it('tenant with no subject yet → 400 (must submit an event first)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/credit/hardship-context')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ category: 'medical', startDate: '2026-05-01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no credit subject/i)
  })

  it('happy: seeds hardship + appends private hardship_context_added event', async () => {
    const f = await seed()
    await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .post('/api/credit/hardship-context')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
      .send({ category: 'medical', startDate: '2026-05-01', note: 'broken arm' })
    expect(res.status).toBe(200)
    expect(res.body.data.hardship_id).toBeTruthy()
    expect(res.body.data.event_id).toBeTruthy()
  })
})

// ───────────────────────────────────────────────────────────────────
// Integrity
// ───────────────────────────────────────────────────────────────────

describe('Integrity', () => {
  it('GET /integrity/anchors returns list (empty when none anchored)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/credit/integrity/anchors')
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
  })

  it('GET /integrity/verify/:subjectId unknown → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/credit/integrity/verify/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(404)
  })

  it('GET /integrity/verify/:subjectId happy: returns VerifyChainResult shape', async () => {
    const f = await seed()
    const a = await seedTenantEvent(f.tenantAId)
    const res = await request(buildApp())
      .get(`/api/credit/integrity/verify/${a.subjectId}`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('ok')
    expect(res.body.data).toHaveProperty('eventCount')
    expect(res.body.data.ok).toBe(true)  // freshly seeded chain is valid
  })
})
