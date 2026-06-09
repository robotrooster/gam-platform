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
