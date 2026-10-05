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

  // Step 9 (final fix): the page shows these and never works a refund out itself.
  const liveFigures = {
    total_deposit: 500, interest_accrued: 2.5, deposit_interest_credited: 3,
    prepaid_credit_remaining: 300, prepaid_credit_used: 40, prepaid_credit_left: 260,
    cleaning_fee_amount: 40, final_utility_lines: [], final_utility_total: 0,
    damage_lines_total: 0, other_deductions_total: 0,
    unpaid_balance_lines: [{ payment_id: 'live-payment', type: 'rent', amount: 0, due_date: '2026-06-01', entry_description: 'RENT', status: 'pending' }],
    unpaid_balance_total: 0, total_deductions: 40, refund_amount: 505.5, gap_amount: 0,
    lease: { tenant_id: 't', landlord_id: 'l' }, security_deposit_id: null,
  }

  it('a preview carries the server figures: refund, shortfall, paid ahead used and left, interest still owed and credited', async () => {
    const f = await seed()
    calculateDepositReturnMock.mockResolvedValueOnce(liveFigures as any)
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      preview: true, refund_amount: 505.5, gap_amount: 0,
      prepaid_credit_used: 40, prepaid_credit_left: 260,
      interest_accrued: 2.5, deposit_interest_credited: 3,
      unpaid_balance_amount: 0, total_deductions: 40,
    })
  })

  it('a draft shows the figures finalize will pay, worked out now with its saved damage lines — never the saved snapshot or the deposit record\'s raw interest', async () => {
    const f = await seed()
    // The saved row says $800 back (a stale snapshot); the record's raw
    // interest total is $42.50, of which the annual payout already credited most.
    const damage = [{ description: 'Wall hole', amount: 25, evidenceDocumentIds: [randomUUID()] }]
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status, damage_lines)
       VALUES ($1, $2, $3, 1000, 200, 800, 'draft', $4::jsonb)`,
      [f.leaseAId, f.tenantAId, f.landlordAId, JSON.stringify(damage)])
    await db.query(
      `INSERT INTO security_deposits (lease_id, tenant_id, unit_id, total_amount, interest_accrued, status, held_by)
       VALUES ($1, $2, $3, 1000, 42.50, 'funded', 'landlord')`,
      [f.leaseAId, f.tenantAId, f.unitAId])
    calculateDepositReturnMock.mockResolvedValueOnce(liveFigures as any)

    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.preview).toBeUndefined()
    expect(calculateDepositReturnMock).toHaveBeenCalledWith(f.leaseAId, damage, [])
    expect(res.body.data).toMatchObject({
      status: 'draft', refund_amount: 505.5, gap_amount: 0, total_deposit: 500, total_deductions: 40,
      prepaid_credit_used: 40, prepaid_credit_left: 260, deposit_interest_credited: 3,
      interest_accrued: 2.5,
    })
    expect(res.body.data.unpaid_balance_lines).toHaveLength(1)
    expect(res.body.data.unpaid_balance_lines[0].payment_id).toBe('live-payment')
  })

  it('a return waiting for approval shows the live figures too (finalize recomputes them)', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'awaiting_approval')`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    calculateDepositReturnMock.mockResolvedValueOnce(liveFigures as any)
    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'awaiting_approval', refund_amount: 505.5, prepaid_credit_left: 260 })
  })

  it('a finalized return shows what it paid, as recorded: its refund, the paid-ahead money and credited interest it spent, and the interest it paid', async () => {
    const f = await seed()
    const dr = await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount,
                                    status, finalized_at, unpaid_balance_amount, damage_lines)
       VALUES ($1, $2, $3, 500, 40, 505.50, 'sent_refund', NOW(), 0, $4::jsonb) RETURNING id`,
      [f.leaseAId, f.tenantAId, f.landlordAId, JSON.stringify([{ description: 'Scuff', amount: 12.5 }])])
    const used = await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, 300, 300) RETURNING id`, [f.leaseAId, f.tenantAId])
    // The move-out's use of $40 (the credit ledger lowers what is left to $260).
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, 40, date_trunc('month', CURRENT_DATE)::date, 'move_out', 'applied', NOW())`,
      [used.rows[0].id, dr.rows[0].id, f.leaseAId])
    const subj = await db.query<{ id: string }>(
      `INSERT INTO credit_subjects (subject_type, subject_ref_id) VALUES ('tenant', $1) RETURNING id`, [f.tenantAId])
    await db.query(
      `INSERT INTO credit_events (subject_id, event_type, event_data, occurred_at, attestation_source, network_visibility, this_hash)
       VALUES ($1, 'deposit_interest_paid', $2::jsonb, NOW(), 'gam_workflow_auto', 'visible_to_gam_network', $3)`,
      [subj.rows[0].id, JSON.stringify({ deposit_return_id: dr.rows[0].id, interest_accrued_total: 2.5 }),
       crypto.randomBytes(32)])

    const res = await request(buildApp())
      .get(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    // Nothing is worked out again for a finished return.
    expect(calculateDepositReturnMock).not.toHaveBeenCalled()
    expect(res.body.data).toMatchObject({
      status: 'sent_refund', refund_amount: 505.5, gap_amount: 0, total_deposit: 500, total_deductions: 40,
      prepaid_credit_used: 40, prepaid_credit_left: 260, deposit_interest_credited: 0, interest_accrued: 2.5,
      damage_lines_total: 12.5, unpaid_balance_lines: [],
    })
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

  it('S548: apartment without a finalized move-out walkthrough → 409', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/move-out walkthrough/i)
    expect(createOrFetchDraftMock).not.toHaveBeenCalled()
  })

  it('happy: finalized move-out walkthrough → calls createOrFetchDraft', async () => {
    const f = await seed()
    // Gate satisfied: an in-person move-out inspection is finalized.
    await db.query(
      `INSERT INTO unit_inspections (unit_id, lease_id, landlord_id, inspection_type, status, finalized_at)
       SELECT l.unit_id, l.id, l.landlord_id, 'move_out', 'finalized', NOW() FROM leases l WHERE l.id=$1`,
      [f.leaseAId])
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

  // Fix pass 1 (final fix): said to the person reading it — the owner here —
  // with their next step (approve it, or send it back to draft).
  it('a return waiting for the owner\'s approval can\'t be edited — refused in the owner\'s own words with both next steps, nothing saved', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'awaiting_approval')`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ damageLines: [], notes: 'x' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('This deposit return is waiting for your approval, so its deductions can\'t be changed as it is. ' +
      'You can approve it as it is, or press Send back to draft to change it.')
    expect(applyDeductionsToDraftMock).not.toHaveBeenCalled()
  })

  it('a finalized return can\'t be edited — 409 in plain words', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'sent_refund')`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ damageLines: [] })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already finalized, so it can't be changed/)
    expect(applyDeductionsToDraftMock).not.toHaveBeenCalled()
  })

  it('happy: passes deductions to applyDeductionsToDraft', async () => {
    const f = await seed()
    const draft = await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'draft') RETURNING id`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    // W-31: damage lines require owned evidence documents.
    const ev = await db.query<{ id: string }>(
      `INSERT INTO documents (landlord_id, type, name, url) VALUES ($1, 'receipt', 'Wall hole photo', '/uploads/docs/x.jpg') RETURNING id`,
      [f.landlordAId],
    )
    const evidenceId = ev.rows[0].id
    const res = await request(buildApp())
      .patch(`/api/leases/${f.leaseAId}/deposit-return`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({
        damageLines: [{ description: 'Wall hole', amount: 200, evidenceDocumentIds: [evidenceId] }],
        notes: 'See photos',
      })
    expect(res.status).toBe(200)
    expect(res.body.data.total_deductions).toBe(500)
    expect(applyDeductionsToDraftMock).toHaveBeenCalledWith(
      draft.rows[0].id,
      expect.objectContaining({
        damageLines: [{ description: 'Wall hole', amount: 200, evidenceDocumentIds: [evidenceId] }],
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
    expect(res.body.error).toBe('This deposit return is already finalized. The page now shows what it paid.')
  })

  // Deposit-page review: finalize also gets the figures the confirm showed, so
  // it checks them again under its own locks (none sent here).
  it('happy: calls finalizeDepositReturn with draft id + caller userId + the confirm\'s figures, and no approval limit for the owner', async () => {
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
    expect(finalizeDepositReturnMock).toHaveBeenCalledWith(draft.rows[0].id, f.landlordAUserId,
      { expectedRefund: undefined, expectedGap: undefined }, { approvalThreshold: undefined })
  })
})

// ─── S548: deposit-return approval threshold ──────────────────────────

describe('POST /:id/deposit-return/finalize — S548 staff approval threshold', () => {
  // A real property manager with every property in scope — the deposit-return
  // routes check the caller's property scope (step 9 review, fix pass 3).
  const staffToken = async (landlordId: string) => {
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Test', 'Staff', TRUE) RETURNING id`, [`pm-${randomUUID()}@t.dev`])).rows[0].id
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`, [userId, landlordId])
    return jwt.sign(
      { userId, role: 'property_manager', profileId: randomUUID(),
        landlordId, permissions: { 'leases.deposit_return': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
  }

  // Fix pass 1 (final fix): the limit is judged by finalize itself, under its
  // locks, on the refund it would pay now (depositReturn.test.ts and
  // leases-deposit-return-figures.test.ts run it for real); the route hands
  // it the landlord's limit and answers for a return finalize parked.
  it('staff finalize hands finalize the landlord\'s limit; a return finalize parks answers 202 awaiting_approval and the landlord is notified, no payout', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'draft')`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    finalizeDepositReturnMock.mockResolvedValueOnce({ id: 'mock-draft', status: 'awaiting_approval', refund_amount: '800.00', parked: 'now' } as any)
    // Default threshold $500; the live refund finalize found is $800 → parked.
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseAId}/deposit-return/finalize`)
      .set('Authorization', `Bearer ${await staffToken(f.landlordAId)}`)
    expect(res.status).toBe(202)
    expect(res.body.data).toMatchObject({ status: 'awaiting_approval', refund_amount: 800, threshold: 500 })
    expect(finalizeDepositReturnMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), {}, { approvalThreshold: 500 })
    const n = await db.query<any>(
      `SELECT title FROM notifications WHERE type='deposit_return_approval' AND landlord_id=$1`, [f.landlordAId])
    expect(n.rows).toHaveLength(1)
  })

  it('staff refund at/below threshold → finalizes without the landlord', async () => {
    const f = await seed()
    calculateDepositReturnMock.mockResolvedValue({ deposit_amount: 150, total_deductions: 50, refund_amount: 100 } as any)
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 150, 50, 100, 'draft')`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseAId}/deposit-return/finalize`)
      .set('Authorization', `Bearer ${await staffToken(f.landlordAId)}`)
    expect(res.status).toBe(200)
    expect(finalizeDepositReturnMock).toHaveBeenCalledTimes(1)
  })

  it('landlord finalizes an awaiting_approval return', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status)
       VALUES ($1, $2, $3, 1000, 200, 800, 'awaiting_approval')`,
      [f.leaseAId, f.tenantAId, f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/leases/${f.leaseAId}/deposit-return/finalize`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(finalizeDepositReturnMock).toHaveBeenCalledTimes(1)
  })
})
