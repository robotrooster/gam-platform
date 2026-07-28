/**
 * S558 — smooth manual lease onboarding pipeline (Flow B, new leases).
 *
 * Exercises the real chain across landlords + tenants routers:
 *   POST /me/onboard-new-lease-tenant  (unit-linked invite, no lease row)
 *   POST /tenants/accept-invite        (accept → auto-draft when roster ready)
 *   → the e-sign document auto-drafts off the unit's default template with
 *     rent/deposit/term pre-filled, mode-aware (whole_unit shared vs by_room
 *     stacked), with the occupancy cap + co-tenant repair.
 *
 * emailTenantOnboarded is mocked; everything else writes the real DB chain.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLateFeeDecision, seedTenant, seedLease } from '../test/dbHelpers'

const { emailTenantOnboardedMock } = vi.hoisted(() => ({
  emailTenantOnboardedMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailTenantOnboarded: emailTenantOnboardedMock }
})

import { landlordsRouter } from './landlords'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailTenantOnboardedMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pipeline'
})

interface Base { landlordUserId: string; landlordId: string; landlordToken: string; propertyId: string; unitId: string }

async function seedBase(occupancyMode = 'whole_unit', bedrooms = 1): Promise<Base> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    // No-fee decision → template needs no late-fee fields for drafting.
    await seedLateFeeDecision(client, { propertyId, unitType: 'apartment', noLateFee: true })
    await client.query(`UPDATE units SET occupancy_mode=$1, bedrooms=$2 WHERE id=$3`, [occupancyMode, bedrooms, unitId])
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordUserId, landlordId, landlordToken, propertyId, unitId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function seedDefaultTemplate(landlordId: string, depositMonths: number | null, termMonths: number | null): Promise<string> {
  const t = await db.query<{ id: string }>(
    `INSERT INTO lease_templates (landlord_id, name, page_count, unit_type, deposit_months, default_term_months, is_unit_type_default)
     VALUES ($1, 'Primary Apartment', 1, 'apartment', $2, $3, true) RETURNING id`,
    [landlordId, depositMonths, termMonths])
  const tid = t.rows[0].id
  const cols = ['rent_amount', 'security_deposit', 'start_date', 'end_date', 'lease_type']
  for (const c of cols) {
    await db.query(
      `INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y, width, height)
       VALUES ($1, 'text', 'landlord', $2, 1, 10, 10, 100, 20)`, [tid, c])
  }
  // Signature fields so both parties have a place to sign.
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','primary','tenant_signature',1,10,100)`, [tid])
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','co_tenant_1','tenant_signature',1,10,140)`, [tid])
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','landlord','landlord_signature',1,10,180)`, [tid])
  return tid
}

async function onboard(f: Base, email: string, first = 'A') {
  return request(buildApp())
    .post('/api/landlords/me/onboard-new-lease-tenant')
    .set('Authorization', `Bearer ${f.landlordToken}`)
    .send({ firstName: first, lastName: 'Tester', email, phone: '555-0000', unitId: f.unitId })
}

async function inviteToken(email: string): Promise<string> {
  const r = await db.query<{ tenant_invite_token: string }>(`SELECT tenant_invite_token FROM users WHERE email=$1`, [email])
  return r.rows[0].tenant_invite_token
}

async function accept(token: string) {
  return request(buildApp()).post('/api/tenants/accept-invite').send({ token, password: 'password123', acceptedTerms: true })
}

async function draftsForUnit(unitId: string) {
  const r = await db.query<any>(`SELECT id, status FROM lease_documents WHERE unit_id=$1 AND document_type='original_lease' ORDER BY created_at`, [unitId])
  return r.rows
}
async function fieldVals(documentId: string): Promise<Record<string, string | null>> {
  const r = await db.query<{ lease_column: string; value: string | null }>(`SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1 AND lease_column IS NOT NULL`, [documentId])
  return Object.fromEntries(r.rows.map(x => [x.lease_column, x.value]))
}
async function signerRoles(documentId: string): Promise<string[]> {
  const r = await db.query<{ role: string }>(`SELECT role FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [documentId])
  return r.rows.map(x => x.role)
}

describe('onboard-new-lease-tenant (Flow B)', () => {
  it('creates a unit-bound intent + invite token and NO lease row', async () => {
    const f = await seedBase()
    const email = `t-${randomUUID().slice(0, 6)}@x.dev`
    const res = await onboard(f, email)
    expect(res.status).toBe(200)
    const intent = await db.query(`SELECT unit_id, accepted_at, draft_document_id FROM pending_tenant_intents WHERE unit_id=$1`, [f.unitId])
    expect(intent.rows.length).toBe(1)
    expect(intent.rows[0].accepted_at).toBeNull()
    const leases = await db.query(`SELECT id FROM leases WHERE unit_id=$1`, [f.unitId])
    expect(leases.rows.length).toBe(0)
    expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to invite before the unit has rent set', async () => {
    const f = await seedBase()
    await db.query(`UPDATE units SET rent_amount=0 WHERE id=$1`, [f.unitId])
    const res = await onboard(f, `t-${randomUUID().slice(0, 6)}@x.dev`)
    expect(res.status).toBe(400)
  })

  it('whole_unit: blocks a second lease when one is already active (409)', async () => {
    const f = await seedBase('whole_unit')
    const c = await db.connect()
    try {
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId: f.unitId, landlordId: f.landlordId, status: 'active' })
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role, status) VALUES ($1,$2,'primary','active')`, [leaseId, tenantId])
    } finally { c.release() }
    const res = await onboard(f, `t-${randomUUID().slice(0, 6)}@x.dev`)
    expect(res.status).toBe(409)
  })
})

describe('accept → auto-draft', () => {
  it('whole_unit: drafts ONE shared lease once both co-tenants accept, deposit + term pre-filled', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1.5, 12)
    const eA = `a-${randomUUID().slice(0, 6)}@x.dev`, eB = `b-${randomUUID().slice(0, 6)}@x.dev`
    await onboard(f, eA, 'Aaa'); await onboard(f, eB, 'Bbb')

    // First accept: roster incomplete → no draft yet.
    await accept(await inviteToken(eA))
    expect((await draftsForUnit(f.unitId)).length).toBe(0)

    // Second accept: roster complete → one draft.
    await accept(await inviteToken(eB))
    const drafts = await draftsForUnit(f.unitId)
    expect(drafts.length).toBe(1)
    const roles = await signerRoles(drafts[0].id)
    expect(roles).toContain('landlord')
    expect(roles).toContain('primary')
    expect(roles).toContain('co_tenant_1')
    const vals = await fieldVals(drafts[0].id)
    expect(vals.rent_amount).toBe('1000.00')
    expect(vals.security_deposit).toBe('1500.00') // 1000 × 1.5, from the template
    expect(vals.lease_type).toBe('fixed_term')
    expect(vals.start_date).toBeTruthy()
    expect(vals.end_date).toBeTruthy()
  })

  it('by_room: each accepted person gets their OWN lease; caps at 2×bedrooms', async () => {
    const f = await seedBase('by_room', 1) // cap = 2
    await seedDefaultTemplate(f.landlordId, 1, null) // month-to-month
    const eA = `a-${randomUUID().slice(0, 6)}@x.dev`, eB = `b-${randomUUID().slice(0, 6)}@x.dev`
    await onboard(f, eA, 'Aaa'); await onboard(f, eB, 'Bbb')
    await accept(await inviteToken(eA))
    await accept(await inviteToken(eB))
    const drafts = await draftsForUnit(f.unitId)
    expect(drafts.length).toBe(2) // two independent leases
    for (const d of drafts) {
      const roles = await signerRoles(d.id)
      expect(roles.filter(r => r === 'primary').length).toBe(1)
      expect(roles).not.toContain('co_tenant_1')
      expect((await fieldVals(d.id)).lease_type).toBe('month_to_month')
    }
    // Third onboard exceeds the 2×bedrooms cap.
    const third = await onboard(f, `c-${randomUUID().slice(0, 6)}@x.dev`)
    expect(third.status).toBe(409)
  })

  it('whole_unit repair: adding a co-tenant voids the unsigned draft and re-drafts with all three', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1, 12)
    const eA = `a-${randomUUID().slice(0, 6)}@x.dev`, eB = `b-${randomUUID().slice(0, 6)}@x.dev`, eC = `c-${randomUUID().slice(0, 6)}@x.dev`
    await onboard(f, eA, 'Aaa'); await onboard(f, eB, 'Bbb')
    await accept(await inviteToken(eA)); await accept(await inviteToken(eB))
    const first = await draftsForUnit(f.unitId)
    expect(first.filter(d => d.status !== 'voided').length).toBe(1)

    // Add a 3rd co-tenant → the unsigned draft voids.
    const add = await onboard(f, eC, 'Ccc')
    expect(add.status).toBe(200)
    const afterAdd = await draftsForUnit(f.unitId)
    expect(afterAdd.every(d => d.status === 'voided')).toBe(true)

    // 3rd accepts → re-draft now includes all three.
    await accept(await inviteToken(eC))
    const live = (await draftsForUnit(f.unitId)).filter(d => d.status !== 'voided')
    expect(live.length).toBe(1)
    const roles = await signerRoles(live[0].id)
    expect(roles).toContain('co_tenant_2')
  })
})
