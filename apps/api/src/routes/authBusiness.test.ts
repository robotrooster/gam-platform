/**
 * S454 — auth.ts business-role extension.
 *
 * Pins the business_owner and business_staff login + /me paths added in
 * S454. Companion to S450's auth.test.ts (landlord/tenant/worker paths).
 *
 * Coverage:
 *   POST /api/auth/login
 *     - business_owner: profile_id resolves to businesses.id, JWT
 *       carries businessId, no scope dispatch needed
 *     - business_staff with active scope row: businessId + staffRole +
 *       permissions all on response + JWT
 *     - business_staff WITHOUT scope row: 403 "deactivated" with the
 *       business-owner-flavored message (NOT the landlord message)
 *     - business_staff with status='revoked' scope row: same 403 path
 *       (the scope query filters status='active')
 *   GET /api/auth/me
 *     - business_owner: surfaces business_id + businessId (camelCase
 *       mirror) + business_type from the JOIN
 *     - business_staff: surfaces business_id + staffRole from scope
 *     - non-business role: business_id + staffRole are null
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

const { sendVerifyMock } = vi.hoisted(() => ({
  sendVerifyMock: vi.fn(async () => 'msg_mock_verify'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendEmailVerification: sendVerifyMock }
})

import { db } from '../db'
import { authRouter } from './auth'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sendVerifyMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s454'
})

/** Seed a business with its owner user pre-verified. Returns ids + the
 *  password used so tests can log in. */
async function seedBusinessWithOwner(opts: {
  businessType?: 'trash_hauling' | 'maintenance_crew' | 'mobile_rental' | 'equipment_rental' | 'other'
  businessName?: string
  ownerEmail?:   string
  ownerPassword?: string
} = {}): Promise<{
  ownerUserId: string
  ownerEmail:  string
  password:    string
  businessId:  string
  businessType: string
  businessName: string
}> {
  const password = opts.ownerPassword ?? 'super-strong-password-12!'
  const hash = await bcrypt.hash(password, 12)
  const email = opts.ownerEmail ?? `bowner-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const businessType = opts.businessType ?? 'trash_hauling'
  const businessName = opts.businessName ?? 'Test Hauling Co'
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses
       (owner_user_id, name, business_type, email)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [u.id, businessName, businessType, `biz-${u.id}@biz.dev`])
  return {
    ownerUserId: u.id,
    ownerEmail:  email,
    password,
    businessId:  b.id,
    businessType,
    businessName,
  }
}

/** Seed a business_staff user scoped into an existing business. */
async function seedBusinessStaff(args: {
  businessId: string
  staffRole?: 'manager' | 'dispatcher' | 'driver' | 'office'
  status?:    'active' | 'invited' | 'revoked'
  permissions?: Record<string, any>
  password?:  string
}): Promise<{ userId: string; email: string; password: string }> {
  const password = args.password ?? 'super-strong-password-12!'
  const hash = await bcrypt.hash(password, 12)
  const email = `bstaff-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_staff', 'Biz', 'Staff', TRUE) RETURNING id`,
    [email, hash])
  await db.query(
    `INSERT INTO business_users
       (business_id, user_id, staff_role, permissions, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [args.businessId, u.id,
     args.staffRole ?? 'dispatcher',
     JSON.stringify(args.permissions ?? {}),
     args.status ?? 'active'])
  return { userId: u.id, email, password }
}

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/login — business_owner
// ═══════════════════════════════════════════════════════════════

describe('POST /api/auth/login — business_owner', () => {
  it('happy: 200 + businessId on user object + JWT carries businessId', async () => {
    const seed = await seedBusinessWithOwner()
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email: seed.ownerEmail, password: seed.password })
    expect(res.status).toBe(200)
    expect(res.body.data.user.role).toBe('business_owner')
    expect(res.body.data.user.businessId).toBe(seed.businessId)
    expect(res.body.data.user.profileId).toBe(seed.businessId)
    expect(res.body.data.user.staffRole).toBeNull()
    expect(res.body.data.user.landlordId).toBeNull()

    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.role).toBe('business_owner')
    expect(decoded.businessId).toBe(seed.businessId)
    expect(decoded.profileId).toBe(seed.businessId)
    expect(decoded.staffRole).toBeNull()
  })

  it('business archived → owner still logs in with businessId=null (no business attached)', async () => {
    const seed = await seedBusinessWithOwner()
    await db.query(`UPDATE businesses SET status='archived' WHERE id=$1`, [seed.businessId])
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email: seed.ownerEmail, password: seed.password })
    expect(res.status).toBe(200)
    // JOIN filters businesses.status='active', so business_id is null for
    // the response. Owner can still log in — portal will show "your
    // business has been archived" rather than a hard 403.
    expect(res.body.data.user.businessId).toBeNull()
    expect(res.body.data.user.profileId).toBeNull()
  })

  it('business_owner does NOT go through worker-scope dispatch (no deactivated 403)', async () => {
    // Even with no businesses row at all, owner login succeeds (just with
    // no businessId). Important: business_owner is NOT in the worker list,
    // so the absence of a business doesn't deactivate them.
    const password = 'super-strong-password-12!'
    const hash = await bcrypt.hash(password, 12)
    const email = `lonely-${randomUUID()}@example.com`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'business_owner', 'No', 'Biz', TRUE)`,
      [email, hash])
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email, password })
    expect(res.status).toBe(200)
    expect(res.body.data.user.businessId).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/login — business_staff
// ═══════════════════════════════════════════════════════════════

describe('POST /api/auth/login — business_staff', () => {
  it('happy: scope row resolves businessId + staffRole + permissions on response and JWT', async () => {
    const owner = await seedBusinessWithOwner()
    const staff = await seedBusinessStaff({
      businessId: owner.businessId,
      staffRole:  'manager',
      permissions: { routes: { view_all: true }, customers: { edit: true } },
    })
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email: staff.email, password: staff.password })
    expect(res.status).toBe(200)
    expect(res.body.data.user.role).toBe('business_staff')
    expect(res.body.data.user.businessId).toBe(owner.businessId)
    expect(res.body.data.user.staffRole).toBe('manager')
    expect(res.body.data.user.permissions).toMatchObject({
      routes: { view_all: true }, customers: { edit: true },
    })
    expect(res.body.data.user.landlordId).toBeNull()

    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.businessId).toBe(owner.businessId)
    expect(decoded.staffRole).toBe('manager')
    expect(decoded.permissions).toMatchObject({ routes: { view_all: true } })
  })

  it('staff role variants: each resolves into staffRole correctly', async () => {
    const owner = await seedBusinessWithOwner()
    for (const role of ['manager', 'dispatcher', 'driver', 'office'] as const) {
      const staff = await seedBusinessStaff({
        businessId: owner.businessId, staffRole: role,
      })
      const res = await request(buildApp())
        .post('/api/auth/login').send({ email: staff.email, password: staff.password })
      expect(res.status).toBe(200)
      expect(res.body.data.user.staffRole).toBe(role)
    }
  })

  it('staff WITHOUT scope row → 403 deactivated, business-owner-flavored message', async () => {
    // User has role='business_staff' but no business_users row — was
    // scoped at some point then revoked, or the row was never created.
    const password = 'super-strong-password-12!'
    const hash = await bcrypt.hash(password, 12)
    const email = `unscoped-${randomUUID()}@example.com`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'business_staff', 'Un', 'Scoped', TRUE)`,
      [email, hash])
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email, password })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/deactivated/i)
    // Critical: should say "business owner" not "landlord" — the
    // business_staff message must differ from the worker message so
    // the deactivated user knows whom to contact.
    expect(res.body.error).toMatch(/business owner/i)
    expect(res.body.error).not.toMatch(/landlord/i)
  })

  it('staff with status="revoked" scope row → 403 (scope query filters status=active)', async () => {
    const owner = await seedBusinessWithOwner()
    const staff = await seedBusinessStaff({
      businessId: owner.businessId, status: 'revoked',
    })
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email: staff.email, password: staff.password })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/business owner/i)
  })

  it('staff with status="invited" (not yet accepted) → 403 (scope query filters status=active)', async () => {
    const owner = await seedBusinessWithOwner()
    const staff = await seedBusinessStaff({
      businessId: owner.businessId, status: 'invited',
    })
    const res = await request(buildApp())
      .post('/api/auth/login').send({ email: staff.email, password: staff.password })
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/auth/me — business-side surfaces
// ═══════════════════════════════════════════════════════════════

describe('GET /api/auth/me — business roles', () => {
  it('business_owner: surfaces business_id + businessId mirror + business_type', async () => {
    const seed = await seedBusinessWithOwner({
      businessType: 'maintenance_crew',
      businessName: 'AAA Mtc',
    })
    const token = jwt.sign(
      { userId: seed.ownerUserId, role: 'business_owner', email: seed.ownerEmail,
        profileId: seed.businessId, businessId: seed.businessId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.business_id).toBe(seed.businessId)
    expect(res.body.data.businessId).toBe(seed.businessId)
    expect(res.body.data.business_type).toBe('maintenance_crew')
    // Business owners aren't workers — staff_role + staffRole stay null.
    expect(res.body.data.staff_role).toBeNull()
    expect(res.body.data.staffRole).toBeNull()
    expect(res.body.data.landlord_id).toBeNull()
  })

  it('business_staff: surfaces business_id + staffRole + permissions from re-fetched scope', async () => {
    const owner = await seedBusinessWithOwner()
    const staff = await seedBusinessStaff({
      businessId: owner.businessId, staffRole: 'driver',
      permissions: { routes: { view_assigned: true } },
    })
    const token = jwt.sign(
      { userId: staff.userId, role: 'business_staff', email: staff.email,
        profileId: owner.businessId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.businessId).toBe(owner.businessId)
    expect(res.body.data.staffRole).toBe('driver')
    expect(res.body.data.staff_role).toBe('driver')
    expect(res.body.data.permissions).toMatchObject({ routes: { view_assigned: true } })
  })

  it('non-business role (landlord): business_id + staffRole stay null', async () => {
    // Verify the new fields don't accidentally surface for unrelated roles.
    const password = 'super-strong-password-12!'
    const hash = await bcrypt.hash(password, 12)
    const email = `nonbiz-${randomUUID()}@example.com`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'landlord', 'No', 'Biz', TRUE) RETURNING id`,
      [email, hash])
    const { rows: [l] } = await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [u.id])
    const token = jwt.sign(
      { userId: u.id, role: 'landlord', email, profileId: l.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.business_id).toBeNull()
    expect(res.body.data.businessId).toBeNull()
    expect(res.body.data.staffRole).toBeNull()
  })
})
