/**
 * pm route slice — S352 part 1 of N.
 *
 * Covers companies CRUD + staff CRUD + fee plans + invitations.
 * Out of scope for this slice (separate sessions):
 *   - Connect onboarding (/companies/:id/connect/*) — Stripe boundary
 *   - Payouts / drilldown — owner-visibility surface
 *   - Property invitations (PM <-> Landlord handshake) — separate flow
 *
 * Coverage focus:
 *   - assertPmStaffRole gates (owner/manager/staff role tiers + 403 for
 *     non-members)
 *   - Self-promote / self-demote guards (last-owner safety)
 *   - Fee-plan per-feeType required-field validation
 *   - Invitation lifecycle: send / dup-active-member / dup-pending /
 *     accept (happy + email mismatch + expired)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

const { emailPmInvitationMock, emailPmPropertyInvitationMock } = vi.hoisted(() => ({
  emailPmInvitationMock:         vi.fn(async (..._args: any[]) => 'msg_pm_invite_mock'),
  emailPmPropertyInvitationMock: vi.fn(async (..._args: any[]) => 'msg_pm_prop_invite_mock'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emailPmInvitation:         emailPmInvitationMock,
    emailPmPropertyInvitation: emailPmPropertyInvitationMock,
  }
})

import { pmRouter } from './pm'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pm', pmRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailPmInvitationMock.mockClear()
  emailPmPropertyInvitationMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pm'
})

// Seed a generic user; returns { userId, email, token }
async function seedUser(role: 'landlord' | 'tenant' | 'property_manager' = 'landlord'): Promise<{
  userId: string; email: string; token: string;
}> {
  const email = `${role}-${randomUUID()}@test.dev`
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', $2, 'Test', 'User', TRUE) RETURNING id`,
    [email, role])
  const userId = r.rows[0].id
  const token = jwt.sign(
    { userId, role, email, profileId: userId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' },
  )
  return { userId, email, token }
}

// Create company via the route (so the auto-owner pm_staff row gets
// inserted in the same transaction as in production).
async function createCompany(token: string, name = 'Acme PM'): Promise<string> {
  const res = await request(buildApp())
    .post('/api/pm/companies')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, businessEmail: 'biz@acme.dev' })
  if (res.status !== 201) throw new Error(`createCompany failed: ${JSON.stringify(res.body)}`)
  return res.body.data.id
}

describe('POST /api/pm/companies', () => {
  it('happy path: caller auto-becomes owner pm_staff in same txn', async () => {
    const u = await seedUser()
    const res = await request(buildApp())
      .post('/api/pm/companies')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ name: 'Acme PM', businessEmail: 'biz@acme.dev', ein: '12-3456789' })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Acme PM')
    expect(res.body.data.status).toBe('active')

    const staffRow = await db.query<{ role: string; status: string }>(
      `SELECT role, status FROM pm_staff WHERE pm_company_id=$1 AND user_id=$2`,
      [res.body.data.id, u.userId])
    expect(staffRow.rows.length).toBe(1)
    expect(staffRow.rows[0].role).toBe('owner')
    expect(staffRow.rows[0].status).toBe('active')
  })
})

describe('GET /api/pm/companies', () => {
  it('lists only companies the caller is staff of', async () => {
    const a = await seedUser()
    const b = await seedUser()
    const cAid = await createCompany(a.token, 'A Co')
    await createCompany(b.token, 'B Co')

    const res = await request(buildApp())
      .get('/api/pm/companies')
      .set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(cAid)
    expect(res.body.data[0].my_role).toBe('owner')
  })
})

describe('GET /api/pm/companies/:id', () => {
  it('non-staff caller → 403', async () => {
    const owner = await seedUser()
    const outsider = await seedUser()
    const cId = await createCompany(owner.token)

    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${outsider.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Not a staff member/)
  })
})

describe('PATCH /api/pm/companies/:id', () => {
  it('manager can edit company details but NOT bankAccountId (owner-only)', async () => {
    const owner = await seedUser()
    const manager = await seedUser()
    const cId = await createCompany(owner.token)

    // Make manager a manager
    await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: manager.userId, role: 'manager' })

    // Manager edits name → 200
    const r1 = await request(buildApp())
      .patch(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ name: 'Acme PM Renamed' })
    expect(r1.status).toBe(200)
    expect(r1.body.data.name).toBe('Acme PM Renamed')

    // Manager tries to set bankAccountId → 403 (owner-only)
    const r2 = await request(buildApp())
      .patch(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ bankAccountId: null })
    expect(r2.status).toBe(403)
  })
})

describe('S353 — status owner-only + suspended lockout', () => {
  it('F1: manager cannot change company status → 403', async () => {
    const owner = await seedUser()
    const manager = await seedUser()
    const cId = await createCompany(owner.token)
    await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: manager.userId, role: 'manager' })

    const res = await request(buildApp())
      .patch(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'suspended' })
    expect(res.status).toBe(403)

    // Status unchanged
    const row = await db.query<{ status: string }>(
      `SELECT status FROM pm_companies WHERE id=$1`, [cId])
    expect(row.rows[0].status).toBe('active')
  })

  it('F1: owner can change company status', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const res = await request(buildApp())
      .patch(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ status: 'inactive' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('inactive')
  })

  it('F2: suspended company locks out even owners (full lockout — admin must un-suspend)', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    // Suspend via direct DB write (simulates super_admin / platform action)
    await db.query(`UPDATE pm_companies SET status='suspended' WHERE id=$1`, [cId])

    // Owner can no longer GET company detail
    const r1 = await request(buildApp())
      .get(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(r1.status).toBe(403)
    expect(r1.body.error).toMatch(/suspended; contact platform support/)

    // Owner cannot PATCH it back to active via this route either —
    // re-activation requires super_admin / DB override by design.
    const r2 = await request(buildApp())
      .patch(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ status: 'active' })
    expect(r2.status).toBe(403)

    // Staff list also locked
    const r3 = await request(buildApp())
      .get(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(r3.status).toBe(403)
  })

  it('F2: inactive (not suspended) does NOT lock out — staff still have full access', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    // Owner flips to inactive (self-pause, not punitive)
    await request(buildApp())
      .patch(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ status: 'inactive' })

    // Owner can still access everything
    const r1 = await request(buildApp())
      .get(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(r1.status).toBe(200)
    expect(r1.body.data.status).toBe('inactive')

    // Owner can flip back to active themselves (no admin escalation needed)
    const r2 = await request(buildApp())
      .patch(`/api/pm/companies/${cId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ status: 'active' })
    expect(r2.status).toBe(200)
    expect(r2.body.data.status).toBe('active')
  })
})

describe('POST /api/pm/companies/:id/staff', () => {
  it('owner adds existing user happy path', async () => {
    const owner = await seedUser()
    const newStaff = await seedUser()
    const cId = await createCompany(owner.token)

    const res = await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: newStaff.userId, role: 'staff' })
    expect(res.status).toBe(201)
    expect(res.body.data.role).toBe('staff')
    expect(res.body.data.invited_by_user_id).toBe(owner.userId)
  })

  it('duplicate user already staff → 409', async () => {
    const owner = await seedUser()
    const newStaff = await seedUser()
    const cId = await createCompany(owner.token)
    await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: newStaff.userId })

    const dup = await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: newStaff.userId })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toMatch(/already a staff member/)
  })

  it('non-owner caller (e.g., manager) → 403', async () => {
    const owner = await seedUser()
    const manager = await seedUser()
    const target = await seedUser()
    const cId = await createCompany(owner.token)
    await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: manager.userId, role: 'manager' })

    const res = await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ userId: target.userId })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Requires role: owner/)
  })
})

describe('PATCH /api/pm/companies/:id/staff/:staffId', () => {
  it('last-owner demotion → 409', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    // Get the owner's pm_staff row id
    const staff = await db.query<{ id: string }>(
      `SELECT id FROM pm_staff WHERE pm_company_id=$1 AND user_id=$2`,
      [cId, owner.userId])
    const staffId = staff.rows[0].id

    const res = await request(buildApp())
      .patch(`/api/pm/companies/${cId}/staff/${staffId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'manager' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/last active owner/)
    const row = await db.query<{ role: string }>(
      `SELECT role FROM pm_staff WHERE id=$1`, [staffId])
    expect(row.rows[0].role).toBe('owner')  // unchanged
  })

  it('owner can demote other owner when 2+ owners exist', async () => {
    const owner1 = await seedUser()
    const owner2 = await seedUser()
    const cId = await createCompany(owner1.token)
    await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner1.token}`)
      .send({ userId: owner2.userId, role: 'owner' })
    const o2staff = await db.query<{ id: string }>(
      `SELECT id FROM pm_staff WHERE pm_company_id=$1 AND user_id=$2`,
      [cId, owner2.userId])

    const res = await request(buildApp())
      .patch(`/api/pm/companies/${cId}/staff/${o2staff.rows[0].id}`)
      .set('Authorization', `Bearer ${owner1.token}`)
      .send({ role: 'manager' })
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('manager')
  })
})

describe('POST /api/pm/companies/:id/fee-plans', () => {
  it('percent_of_rent without percent → 400', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const res = await request(buildApp())
      .post(`/api/pm/companies/${cId}/fee-plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Standard 8%', feeType: 'percent_of_rent' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/percent_of_rent requires percent/)
  })

  it('happy path: percent_with_floor sets both fields', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const res = await request(buildApp())
      .post(`/api/pm/companies/${cId}/fee-plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        name: 'Premium 10% floor $200',
        feeType: 'percent_with_floor',
        percent: 10,
        floorAmount: 200,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.fee_type).toBe('percent_with_floor')
    expect(Number(res.body.data.percent)).toBe(10)
    expect(Number(res.body.data.floor_amount)).toBe(200)
  })
})

describe('POST /api/pm/companies/:id/invitations', () => {
  it('owner sends invite: row + email fired', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const inviteEmail = `prospect-${randomUUID()}@test.dev`
    const res = await request(buildApp())
      .post(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: inviteEmail, role: 'staff' })
    expect(res.status).toBe(201)
    expect(res.body.data.email).toBe(inviteEmail)
    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.token).toMatch(/^[0-9a-f]{64}$/)
    expect(emailPmInvitationMock).toHaveBeenCalledTimes(1)
  })

  it('invite to existing active staff email → 409', async () => {
    const owner = await seedUser()
    const existing = await seedUser()
    const cId = await createCompany(owner.token)
    await request(buildApp())
      .post(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: existing.userId })

    const res = await request(buildApp())
      .post(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: existing.email })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already an active staff member/)
    expect(emailPmInvitationMock).not.toHaveBeenCalled()
  })

  it('duplicate pending invite (same company + email) → 409', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const email = `dup-${randomUUID()}@test.dev`
    const r1 = await request(buildApp())
      .post(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email })
    expect(r1.status).toBe(201)

    const r2 = await request(buildApp())
      .post(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email })
    expect(r2.status).toBe(409)
    expect(r2.body.error).toMatch(/pending invitation already exists/)
  })
})

describe('POST /api/pm/invitations/accept', () => {
  it('happy path: caller email matches → pm_staff row created, invite flips to accepted', async () => {
    const owner = await seedUser()
    const recipient = await seedUser()
    const cId = await createCompany(owner.token)

    const sendRes = await request(buildApp())
      .post(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: recipient.email, role: 'staff' })
    const token = sendRes.body.data.token

    const res = await request(buildApp())
      .post('/api/pm/invitations/accept')
      .set('Authorization', `Bearer ${recipient.token}`)
      .send({ token })
    expect(res.status).toBe(200)
    expect(res.body.data.pm_company_id).toBe(cId)
    expect(res.body.data.role).toBe('staff')

    const staff = await db.query<{ status: string }>(
      `SELECT status FROM pm_staff WHERE pm_company_id=$1 AND user_id=$2`,
      [cId, recipient.userId])
    expect(staff.rows[0].status).toBe('active')

    const inv = await db.query<{ status: string; accepted_user_id: string }>(
      `SELECT status, accepted_user_id FROM pm_invitations WHERE token=$1`,
      [token])
    expect(inv.rows[0].status).toBe('accepted')
    expect(inv.rows[0].accepted_user_id).toBe(recipient.userId)
  })

  it('caller email does NOT match invite email → 403 (token-theft guard)', async () => {
    const owner = await seedUser()
    const recipient = await seedUser()
    const attacker = await seedUser()
    const cId = await createCompany(owner.token)
    const sendRes = await request(buildApp())
      .post(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: recipient.email, role: 'staff' })
    const token = sendRes.body.data.token

    const res = await request(buildApp())
      .post('/api/pm/invitations/accept')
      .set('Authorization', `Bearer ${attacker.token}`)
      .send({ token })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/email does not match/)
    // Invite still pending
    const inv = await db.query<{ status: string }>(
      `SELECT status FROM pm_invitations WHERE token=$1`, [token])
    expect(inv.rows[0].status).toBe('pending')
  })

  it('expired invitation → 409 AND flips status to expired (persisted)', async () => {
    const owner = await seedUser()
    const recipient = await seedUser()
    const cId = await createCompany(owner.token)
    const sendRes = await request(buildApp())
      .post(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: recipient.email })
    const token = sendRes.body.data.token

    // Force-expire
    await db.query(
      `UPDATE pm_invitations SET expires_at=NOW() - INTERVAL '1 hour' WHERE token=$1`,
      [token])

    const res = await request(buildApp())
      .post('/api/pm/invitations/accept')
      .set('Authorization', `Bearer ${recipient.token}`)
      .send({ token })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/expired/)
    // Status flip persisted (the route COMMITs the expired flip before throwing)
    const inv = await db.query<{ status: string }>(
      `SELECT status FROM pm_invitations WHERE token=$1`, [token])
    expect(inv.rows[0].status).toBe('expired')
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pm/companies/:id/properties/:propertyId/drilldown
//  S488: backfill coverage for the property drilldown endpoint.
//  Pre-S488 this endpoint had no dedicated coverage — only the
//  state-law check shape was indirectly verified via the helper.
// ═══════════════════════════════════════════════════════════════

async function seedPmManagedProperty(opts: {
  ownerToken: string  // PM-company owner JWT
  cId: string          // PM company id
  state?: string       // property state (default AZ)
}): Promise<{
  landlordId: string
  propertyId: string
}> {
  // Distinct landlord whose property gets assigned to this PM company.
  const landlordUserEmail = `ll-${randomUUID()}@test.dev`
  const llUser = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'landlord', 'LL', 'User', TRUE) RETURNING id`,
    [landlordUserEmail])
  const llRec = await db.query<{ id: string }>(
    `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`,
    [llUser.rows[0].id])
  const landlordId = llRec.rows[0].id
  const prop = await db.query<{ id: string }>(
    `INSERT INTO properties
       (landlord_id, name, street1, city, state, zip,
        owner_user_id, managed_by_user_id, pm_company_id)
     VALUES ($1, 'Test Drilldown Prop', '1 Main', 'Phoenix', $2, '85001',
             $3, $3, $4)
     RETURNING id`,
    [landlordId, opts.state ?? 'AZ', llUser.rows[0].id, opts.cId])
  return { landlordId, propertyId: prop.rows[0].id }
}

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

describe('GET /api/pm/companies/:id/properties/:propertyId/drilldown', () => {
  it('happy path: returns property + units + leases + maintenance + fee impact shape', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const { propertyId } = await seedPmManagedProperty({ ownerToken: owner.token, cId })

    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/properties/${propertyId}/drilldown`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.property.id).toBe(propertyId)
    expect(res.body.data.property.pm_company_id).toBe(cId)
    // Empty subcollections still present.
    expect(Array.isArray(res.body.data.units)).toBe(true)
    expect(Array.isArray(res.body.data.active_leases)).toBe(true)
    expect(Array.isArray(res.body.data.recent_maintenance)).toBe(true)
    expect(res.body.data.mtd_fee_impact).toBeDefined()
    // S487 state-law block always present (empty when within range).
    expect(Array.isArray(res.body.data.property.state_law_warnings)).toBe(true)
  })

  it('cross-pm-company: company A staff cannot view company B\'s property → 404', async () => {
    const ownerA = await seedUser()
    const ownerB = await seedUser()
    const cA = await createCompany(ownerA.token, 'PM A')
    const cB = await createCompany(ownerB.token, 'PM B')
    const { propertyId } = await seedPmManagedProperty({ ownerToken: ownerB.token, cId: cB })

    const res = await request(buildApp())
      .get(`/api/pm/companies/${cA}/properties/${propertyId}/drilldown`)
      .set('Authorization', `Bearer ${ownerA.token}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not managed by this PM company/i)
  })

  it('suspended PM company: staff blocked even on managed property → 403', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const { propertyId } = await seedPmManagedProperty({ ownerToken: owner.token, cId })
    await db.query(
      `UPDATE pm_companies SET status='suspended' WHERE id=$1`, [cId])

    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/properties/${propertyId}/drilldown`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/suspended/i)
  })

  it('S487: NV property with 10% percent-of-rent above cap → state_law_warnings populated', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const { propertyId } = await seedPmManagedProperty({
      ownerToken: owner.token, cId, state: 'NV',
    })
    await seedNvLateFeeCap()
    // Set the late-fee config above the NV cap.
    await db.query(
      `UPDATE properties
          SET late_fee_initial_amount = 10,
              late_fee_initial_type   = 'percent_of_rent'
        WHERE id = $1`, [propertyId])

    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/properties/${propertyId}/drilldown`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    const warnings = res.body.data.property.state_law_warnings
    expect(warnings.length).toBe(1)
    expect(warnings[0].topic).toBe('late_fee_max_pct')
    expect(warnings[0].message).toMatch(/above the 5/)
    expect(warnings[0].message).toMatch(/NV/)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S489: backfill for the remaining untested read endpoints.
//  Same pattern that caught S488's prod bug — happy-path GET
//  exercises every column referenced in the SELECT, catching any
//  schema mismatch silently sitting in production.
// ═══════════════════════════════════════════════════════════════

describe('GET /api/pm/companies/:id/staff', () => {
  it('returns the auto-created owner row + invited members', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    // createCompany auto-inserts the owner row.
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].role).toBe('owner')
    expect(res.body.data[0].status).toBe('active')
    expect(res.body.data[0].user_id).toBe(owner.userId)
  })

  it('non-staff caller → 403', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const outsider = await seedUser()
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/staff`)
      .set('Authorization', `Bearer ${outsider.token}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/pm/companies/:id/fee-plans', () => {
  it('happy path: returns empty array on a fresh company', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/fee-plans`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('returns fee plans after one is created', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const create = await request(buildApp())
      .post(`/api/pm/companies/${cId}/fee-plans`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Standard', feeType: 'percent_of_rent', percent: 8 })
    expect(create.status).toBe(201)
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/fee-plans`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].name).toBe('Standard')
  })
})

describe('GET /api/pm/companies/:id/invitations', () => {
  it('happy path: returns empty array on a fresh company', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('returns invitations after sending one', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    await request(buildApp())
      .post(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newhire@test.dev', role: 'staff' })
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].email).toBe('newhire@test.dev')
    expect(res.body.data[0].status).toBe('pending')
  })
})

describe('GET /api/pm/companies/:id/payouts', () => {
  it('happy path: empty array for a company with no payouts', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/payouts`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('non-staff → 403', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const outsider = await seedUser()
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/payouts`)
      .set('Authorization', `Bearer ${outsider.token}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/pm/companies/:id/property-invitations', () => {
  it('happy path: empty array for a company with no property invites', async () => {
    const owner = await seedUser()
    const cId = await createCompany(owner.token)
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cId}/property-invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('cross-pm-company isolation: company A staff sees only company A invites', async () => {
    const ownerA = await seedUser()
    const ownerB = await seedUser()
    const cA = await createCompany(ownerA.token, 'PM A')
    const cB = await createCompany(ownerB.token, 'PM B')
    // Seed a property under B and an inbound owner_to_pm invitation
    // pointing at it.
    const { propertyId } = await seedPmManagedProperty({ ownerToken: ownerB.token, cId: cB })
    await db.query(
      `INSERT INTO pm_property_invitations
         (pm_company_id, direction, property_id, landlord_id,
          invited_email, invited_by_user_id, token, status, expires_at)
       SELECT $1, 'owner_to_pm', $2, p.landlord_id,
              'somebody@test.dev', $3, $4, 'pending', NOW() + INTERVAL '7 days'
         FROM properties p WHERE p.id = $2`,
      [cB, propertyId, ownerB.userId, randomUUID()])
    const res = await request(buildApp())
      .get(`/api/pm/companies/${cA}/property-invitations`)
      .set('Authorization', `Bearer ${ownerA.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})
