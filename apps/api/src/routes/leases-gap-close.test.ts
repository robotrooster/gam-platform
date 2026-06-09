/**
 * leases.ts gap-close slice — S398. Closes the file at 15/15 (100%).
 *
 * Covered routes (6):
 *   - GET   /api/leases/:id/addendums
 *   - GET   /api/leases/:id/addendum-pdf/:filename
 *   - GET   /api/leases/:id/deposit-return
 *   - POST  /api/leases/:id/deposit-return
 *   - PATCH /api/leases/:id/deposit-return
 *   - POST  /api/leases/:id/deposit-return/finalize
 *
 * All 6 are auth-gated correctly (canAccessLandlordResource for reads,
 * canManageLandlordResource for write paths). No production bugs
 * surfaced in this slice — pinning the existing contracts.
 *
 * Note on the addendum-pdf route: it uses the `resolveUploadPath`
 * helper (3-layer defense: basename + regex allowlist + relative
 * escape check) and validates the filename against credit_events for
 * THIS lease — so a leaked filename can't be used to fish other PDFs.
 * Strongest file-serving pattern in the codebase.
 */

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const {
  resolveAddendumActorMock, addendumActorRoleLabelMock, resolveTenantNamesMock,
  calculateDepositReturnMock, fetchUnpaidBalanceLinesMock,
  createOrFetchDraftMock, applyDeductionsToDraftMock, finalizeDepositReturnMock,
} = vi.hoisted(() => ({
  resolveAddendumActorMock:   vi.fn(async (..._a: any[]) => ({ name: 'Owner', role: 'owner' as const })),
  addendumActorRoleLabelMock: vi.fn((_r: string) => 'Owner'),
  resolveTenantNamesMock:     vi.fn(async (..._a: any[]) => ['Test Tenant']),
  calculateDepositReturnMock: vi.fn(async (..._a: any[]) => ({ deposit_amount: 1000, total_deductions: 200, refund_amount: 800 })),
  fetchUnpaidBalanceLinesMock: vi.fn(async (..._a: any[]) => []),
  createOrFetchDraftMock:     vi.fn(async (..._a: any[]) => ({ id: 'mock-draft', status: 'draft' })),
  applyDeductionsToDraftMock: vi.fn(async (..._a: any[]) => ({ id: 'mock-draft', total_deductions: 500 })),
  finalizeDepositReturnMock:  vi.fn(async (..._a: any[]) => ({ id: 'mock-draft', status: 'finalized' })),
}))
vi.mock('../services/addendumActor', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    resolveAddendumActor:   resolveAddendumActorMock,
    addendumActorRoleLabel: addendumActorRoleLabelMock,
    resolveTenantNames:     resolveTenantNamesMock,
  }
})
vi.mock('../services/depositReturn', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    calculateDepositReturn:  calculateDepositReturnMock,
    fetchUnpaidBalanceLines: fetchUnpaidBalanceLinesMock,
    createOrFetchDraft:      createOrFetchDraftMock,
    applyDeductionsToDraft:  applyDeductionsToDraftMock,
    finalizeDepositReturn:   finalizeDepositReturnMock,
  }
})

import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

const cleanupTargets: string[] = []

beforeEach(async () => {
  await cleanupAllSchema()
  resolveAddendumActorMock.mockClear();   resolveAddendumActorMock.mockResolvedValue({ name: 'Owner', role: 'owner' } as any)
  addendumActorRoleLabelMock.mockClear(); addendumActorRoleLabelMock.mockReturnValue('Owner')
  resolveTenantNamesMock.mockClear();     resolveTenantNamesMock.mockResolvedValue(['Test Tenant'])
  calculateDepositReturnMock.mockClear(); calculateDepositReturnMock.mockResolvedValue({ deposit_amount: 1000, total_deductions: 200, refund_amount: 800 } as any)
  fetchUnpaidBalanceLinesMock.mockClear(); fetchUnpaidBalanceLinesMock.mockResolvedValue([])
  createOrFetchDraftMock.mockClear();     createOrFetchDraftMock.mockResolvedValue({ id: 'mock-draft', status: 'draft' } as any)
  applyDeductionsToDraftMock.mockClear(); applyDeductionsToDraftMock.mockResolvedValue({ id: 'mock-draft', total_deductions: 500 } as any)
  finalizeDepositReturnMock.mockClear();  finalizeDepositReturnMock.mockResolvedValue({ id: 'mock-draft', status: 'finalized' } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_leases_gap'
})

afterAll(() => {
  for (const p of cleanupTargets) {
    try { fs.unlinkSync(p) } catch { /* best effort */ }
  }
})

interface Fixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  unitAId:         string
  unitBId:         string
  tenantAId:       string
  tenantAUserId:   string
  tenantBId:       string
  tenantBUserId:   string
  leaseAId:        string
  leaseBId:        string
  tokenA:          string
  tokenB:          string
  tenantAToken:    string
  tenantBToken:    string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propB = await seedProperty(c, { landlordId: bId, ownerUserId: bUid, managedByUserId: bUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const unitB = await seedUnit(c, { propertyId: propB, landlordId: bId })
    const tenantA = await seedTenant(c)
    const tenantB = await seedTenant(c)
    const taUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantA])
    const tbUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantB])
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: aId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA })
    const leaseB = await seedLease(c, { unitId: unitB, landlordId: bId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseB, tenantId: tenantB })
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      unitAId: unitA, unitBId: unitB,
      tenantAId: tenantA, tenantAUserId: taUser.rows[0].user_id,
      tenantBId: tenantB, tenantBUserId: tbUser.rows[0].user_id,
      leaseAId: leaseA, leaseBId: leaseB,
      tokenA:       sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      tokenB:       sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
      tenantAToken: sign({ userId: taUser.rows[0].user_id, role: 'tenant', email: 'ta@t.dev', profileId: tenantA, permissions: {} }),
      tenantBToken: sign({ userId: tbUser.rows[0].user_id, role: 'tenant', email: 'tb@t.dev', profileId: tenantB, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedAddendumEvent(f: Fixture, opts: {
  tenantId?: string; pdfFilename?: string;
} = {}): Promise<{ eventId: string; subjectId: string }> {
  const tenantId = opts.tenantId ?? f.tenantAId
  const subj = await db.query<{ id: string }>(
    `INSERT INTO credit_subjects (subject_type, subject_ref_id)
     VALUES ('tenant', $1) ON CONFLICT DO NOTHING RETURNING id`, [tenantId])
  const subjectId = subj.rows[0]?.id ?? (await db.query<{ id: string }>(
    `SELECT id FROM credit_subjects WHERE subject_type='tenant' AND subject_ref_id=$1`,
    [tenantId])).rows[0].id
  const ev = await db.query<{ id: string }>(
    `INSERT INTO credit_events (subject_id, event_type, event_data, occurred_at,
                                 attestation_source, attestation_evidence,
                                 network_visibility, this_hash)
     VALUES ($1, 'lease_addendum_recorded', $2, NOW(), 'test', '{}'::jsonb,
             'visible_to_current_landlord', $3) RETURNING id`,
    [subjectId,
     JSON.stringify({
       lease_id: f.leaseAId,
       changes: [{ field: 'rent_amount', from: '1000', to: '1100' }],
       pdf_filename: opts.pdfFilename ?? null,
       recorded_by_user_id: f.landlordAUserId,
     }),
     crypto.randomBytes(32)])
  return { eventId: ev.rows[0].id, subjectId }
}

// ───────────────────────────────────────────────────────────────────
// GET /:id/addendums
// ───────────────────────────────────────────────────────────────────

describe('GET /:id/addendums', () => {
  it('unknown lease → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/leases/${randomUUID()}/addendums`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseBId}/addendums`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('happy: returns resolved addendum + actor name/role label', async () => {
    const f = await seed()
    await seedAddendumEvent(f)
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/addendums`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].recorded_by_name).toBe('Owner')
    expect(res.body.data[0].recorded_by_role_label).toBe('Owner')
    expect(res.body.data[0].tenant_names).toEqual(['Test Tenant'])
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /:id/addendum-pdf/:filename
// ───────────────────────────────────────────────────────────────────

describe('GET /:id/addendum-pdf/:filename', () => {
  it('unknown lease → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/leases/${randomUUID()}/addendum-pdf/foo.pdf`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord, non-tenant → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseBId}/addendum-pdf/foo.pdf`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('cross-tenant (B on A lease) → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/addendum-pdf/foo.pdf`)
      .set('Authorization', `Bearer ${f.tenantBToken}`)
    expect(res.status).toBe(403)
  })

  it('filename not in any recorded addendum for this lease → 404', async () => {
    const f = await seed()
    // Seed an event with one filename; request a different filename
    await seedAddendumEvent(f, { pdfFilename: 'real-addendum.pdf' })
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/addendum-pdf/fake-addendum.pdf`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/addendum pdf not found/i)
  })

  it('valid event reference but file missing on disk → 404 (different from "no event")', async () => {
    const f = await seed()
    await seedAddendumEvent(f, { pdfFilename: 'missing-disk-S398.pdf' })
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/addendum-pdf/missing-disk-S398.pdf`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/file not on disk/i)
  })

  it('happy: own-tenant on lease can download own addendum PDF', async () => {
    const f = await seed()
    const filename = `s398-addendum-${randomUUID()}.pdf`
    await seedAddendumEvent(f, { pdfFilename: filename })
    // Write the file on disk
    const uploadDir = path.join(process.cwd(), 'uploads', 'leases')
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
    const fp = path.join(uploadDir, filename)
    fs.writeFileSync(fp, Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary'))
    cleanupTargets.push(fp)

    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/addendum-pdf/${filename}`)
      .set('Authorization', `Bearer ${f.tenantAToken}`)
    expect(res.status).toBe(200)
    expect(Buffer.from(res.body).slice(0, 4).toString()).toBe('%PDF')
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /:id/deposit-return
// ───────────────────────────────────────────────────────────────────

describe('GET /:id/deposit-return', () => {
  it('unknown lease → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/leases/${randomUUID()}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseBId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('no draft yet → returns calculation preview with `preview: true`', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.preview).toBe(true)
    expect(res.body.data.deposit_amount).toBe(1000)
    expect(calculateDepositReturnMock).toHaveBeenCalledWith(f.leaseAId)
  })

  it('existing draft → returns row + live unpaid_balance_lines + interest_accrued', async () => {
    const f = await seed()
    // Seed an existing deposit_returns draft + a security_deposits row
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'draft')`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    await db.query(
      `INSERT INTO security_deposits (lease_id, tenant_id, unit_id, total_amount, interest_accrued, status, held_by)
       VALUES ($1, $2, $3, 1000, 42.50, 'funded', 'landlord')`,
      [f.leaseAId, f.tenantAId, f.unitAId])
    fetchUnpaidBalanceLinesMock.mockResolvedValueOnce([
      {
        payment_id: 'mock-payment',
        type: 'rent',
        amount: 100,
        due_date: '2026-06-01',
        entry_description: 'RENT',
        status: 'pending',
      },
    ] as any)

    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.preview).toBeUndefined()
    expect(res.body.data.unpaid_balance_lines).toHaveLength(1)
    expect(res.body.data.interest_accrued).toBe(42.5)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /:id/deposit-return  (create draft)
// ───────────────────────────────────────────────────────────────────

describe('POST /:id/deposit-return', () => {
  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseBId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('happy: calls createOrFetchDraft', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe('mock-draft')
    expect(createOrFetchDraftMock).toHaveBeenCalledWith(f.leaseAId)
  })
})

// ───────────────────────────────────────────────────────────────────
// PATCH /:id/deposit-return
// ───────────────────────────────────────────────────────────────────

describe('PATCH /:id/deposit-return', () => {
  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseBId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ damageLines: [{ description: 'X', amount: 50 }] })
    expect(res.status).toBe(403)
  })

  it('no draft yet → 404 (POST first)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ damageLines: [] })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/post first/i)
  })

  it('happy: passes deductions to applyDeductionsToDraft', async () => {
    const f = await seed()
    const draft = await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'draft') RETURNING id`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        damageLines: [{ description: 'Wall hole', amount: 200 }],
        notes: 'See photos',
      })
    expect(res.status).toBe(200)
    expect(res.body.data.total_deductions).toBe(500)
    expect(applyDeductionsToDraftMock).toHaveBeenCalledWith(
      draft.rows[0].id,
      expect.objectContaining({
        damageLines: [{ description: 'Wall hole', amount: 200 }],
        notes: 'See photos',
      })
    )
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /:id/deposit-return/finalize
// ───────────────────────────────────────────────────────────────────

describe('POST /:id/deposit-return/finalize', () => {
  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseBId}/deposit-return/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('no draft → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseAId}/deposit-return/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('non-draft status → 409', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'sent_refund')`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseAId}/deposit-return/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already finalized/i)
  })

  it('happy: calls finalizeDepositReturn with draft id + caller userId', async () => {
    const f = await seed()
    const draft = await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'draft') RETURNING id`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseAId}/deposit-return/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('finalized')
    expect(finalizeDepositReturnMock).toHaveBeenCalledWith(draft.rows[0].id, f.landlordAUserId)
  })
})
