/**
 * S654 — the single-resident onboarding routes find an account by email in
 * any letter case, and never reuse a login that isn't a resident's.
 *
 * They looked the address up with an exact `u.email = $1` on a lowercased
 * address. An account stored in mixed case was missed and a second 'tenant'
 * login was made on the same address, after which the real owner's sign-in
 * picked either row. And when the case did match, a landlord's or staff
 * member's own login was reused as a resident. The CSV commit already refuses
 * both (NOT_A_RESIDENT_ACCOUNT); these four doors now do the same:
 *   POST /me/onboard-tenant
 *   POST /me/onboard-new-lease-tenant
 *   POST /me/onboard-tenant-pending
 *   POST /me/onboard-tenants-csv/commit-pending
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

const { emailTenantOnboardedMock } = vi.hoisted(() => ({
  emailTenantOnboardedMock: vi.fn(async (..._args: any[]) => 'msg_mock'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailTenantOnboarded: emailTenantOnboardedMock }
})

import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailTenantOnboardedMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_onboard_s654'
})

async function seedFixture(email?: string) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c, email ? { email } : {})
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 900, withLateFeeDecision: true })
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>

const ROUTES: { name: string; send: (f: Fixture, email: string) => Promise<request.Response> }[] = [
  {
    name: '/me/onboard-tenant',
    send: (f, email) => request(buildApp()).post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ firstName: 'Al', lastName: 'Bee', email, phone: '555-0100', unitId: f.unitId,
              leaseStart: '2026-01-01', monthlyRent: 900 }),
  },
  {
    name: '/me/onboard-new-lease-tenant',
    send: (f, email) => request(buildApp()).post('/api/landlords/me/onboard-new-lease-tenant')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ firstName: 'Al', lastName: 'Bee', email, unitId: f.unitId }),
  },
  {
    name: '/me/onboard-tenant-pending',
    send: (f, email) => request(buildApp()).post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ firstName: 'Al', lastName: 'Bee', email, phone: '555-0100' }),
  },
  {
    name: '/me/onboard-tenants-csv/commit-pending',
    send: (f, email) => request(buildApp()).post('/api/landlords/me/onboard-tenants-csv/commit-pending')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ rows: [{ rowIndex: 0, firstName: 'Al', lastName: 'Bee', email, phone: '555-0100' }] }),
  },
]

/** Did the route refuse? commit-pending answers per row, the rest with a 409. */
function refused(name: string, res: request.Response) {
  if (name.endsWith('commit-pending')) {
    expect(res.status).toBe(200)
    expect(res.body.data.results[0].status).toBe('error')
    expect(res.body.data.results[0].message).toMatch(/isn't a resident's/)
  } else {
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/isn't a resident's/)
  }
}

describe('S654: single-resident onboarding and existing accounts', () => {
  for (const route of ROUTES) {
    it(`${route.name}: a landlord stored in mixed case is refused, with no second login made`, async () => {
      const victim = await seedFixture(`Victim.${randomUUID().slice(0, 6)}@Test.dev`)
      const me = await seedFixture()
      const stored = (await db.query(`SELECT email FROM users WHERE id=$1`, [victim.userId])).rows[0].email
      const before = (await db.query(
        `SELECT password_hash, tenant_invite_token FROM users WHERE id=$1`, [victim.userId])).rows[0]

      const res = await route.send(me, stored.toLowerCase())
      refused(route.name, res)
      expect((await db.query(`SELECT id, role FROM users WHERE lower(email) = lower($1)`, [stored])).rows)
        .toEqual([{ id: victim.userId, role: 'landlord' }])
      expect((await db.query(`SELECT id FROM tenants WHERE user_id=$1`, [victim.userId])).rows).toEqual([])
      expect((await db.query(
        `SELECT password_hash, tenant_invite_token FROM users WHERE id=$1`, [victim.userId])).rows[0]).toEqual(before)
      expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
    })

    it(`${route.name}: a landlord's exact address is refused too, never reused as a resident`, async () => {
      const victim = await seedFixture()
      const me = await seedFixture()
      const stored = (await db.query(`SELECT email FROM users WHERE id=$1`, [victim.userId])).rows[0].email
      const res = await route.send(me, stored)
      refused(route.name, res)
      expect((await db.query(`SELECT id FROM tenants WHERE user_id=$1`, [victim.userId])).rows).toEqual([])
    })
  }

  it('a resident stored in mixed case is reused, not duplicated, and mailed at their own address', async () => {
    const f = await seedFixture()
    const stored = `Kim.${randomUUID().slice(0, 6)}@Example.test`
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', 'Kim', 'H') RETURNING id`, [stored])).rows[0]
    const res = await ROUTES[0].send(f, stored.toLowerCase())
    expect(res.status).toBe(200)
    expect(res.body.data.userId).toBe(u.id)
    expect((await db.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [stored])).rows).toHaveLength(1)
    expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
    expect(emailTenantOnboardedMock.mock.calls[0]![0]).toBe(stored)
  })

  // Same class as the /tenants/invite fix: another landlord's invitee who has
  // not set up yet is not handed a fresh password link by a second landlord.
  for (const route of ROUTES.slice(0, 2)) {
    it(`${route.name}: another landlord's invitee gets no new link, and theirs keeps working`, async () => {
      const first = await seedFixture()
      const me = await seedFixture()
      const email = `invitee-${randomUUID().slice(0, 6)}@test.dev`
      const u = (await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, tenant_invite_token, tenant_invite_expires_at)
         VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', 'In', 'Vitee', 'first-live-link', NOW() + INTERVAL '7 days')
         RETURNING id`, [email])).rows[0]
      const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.id])).rows[0]
      await db.query(
        `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
         VALUES ($1, $2, 'not_uploaded', $3)`, [first.landlordId, t.id, first.unitId])

      const res = await route.send(me, email)
      expect(res.status).toBe(200)
      expect(res.body.data.activationUrl).toBeNull()
      expect(res.body.data.alreadyOnPlatform).toBe(true)
      expect((await db.query(`SELECT tenant_invite_token FROM users WHERE id=$1`, [u.id])).rows[0].tenant_invite_token)
        .toBe('first-live-link')
      expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
    })

    // S654: an e-sign witness login another landlord set up has no tenants row
    // and none of the resident ties; it is still that landlord's signer.
    it(`${route.name}: another landlord's e-sign witness gets no link and no email`, async () => {
      const first = await seedFixture()
      const me = await seedFixture()
      const email = `witness-${randomUUID().slice(0, 6)}@test.dev`
      const w = (await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name)
         VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', 'Wit', 'Ness') RETURNING id`, [email])).rows[0]
      const d = (await db.query<{ id: string }>(
        `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
         VALUES ($1, $2, 'First lease', 'original_lease', 'sent') RETURNING id`, [first.landlordId, first.unitId])).rows[0]
      await db.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
         VALUES ($1, $2, 'witness', 'Wit Ness', $3, 3, $4, 'pending')`, [d.id, w.id, email, randomUUID()])

      const res = await route.send(me, email)
      expect(res.status).toBe(200)
      expect(res.body.data.activationUrl).toBeNull()
      expect(res.body.data.alreadyOnPlatform).toBe(true)
      expect((await db.query(`SELECT tenant_invite_token FROM users WHERE id=$1`, [w.id])).rows[0].tenant_invite_token)
        .toBeNull()
      expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
    })

    // S654: the link comes back only for an account this call made. Anyone
    // else who still needs setting up gets it by email at their own address.
    it(`${route.name}: an existing account gets its link by email only, never in the response`, async () => {
      const me = await seedFixture()
      const stored = `Wait.${randomUUID().slice(0, 6)}@Example.test`
      const u = (await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name)
         VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', 'Wait', 'Ing') RETURNING id`, [stored])).rows[0]

      const res = await route.send(me, stored.toLowerCase())
      expect(res.status).toBe(200)
      expect(res.body.data.userId).toBe(u.id)
      expect(res.body.data.activationUrl).toBeNull()
      expect(res.body.data.alreadyOnPlatform).toBe(false)
      const token = (await db.query(`SELECT tenant_invite_token FROM users WHERE id=$1`, [u.id])).rows[0].tenant_invite_token
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
      expect(emailTenantOnboardedMock.mock.calls[0]![0]).toBe(stored)
      expect(emailTenantOnboardedMock.mock.calls[0]![5]).toMatch(new RegExp(`/accept-invite\\?token=${token}$`))
    })

    it(`${route.name}: a brand-new address still gets its link back`, async () => {
      const me = await seedFixture()
      const res = await route.send(me, `brand-new-${randomUUID().slice(0, 6)}@test.dev`)
      expect(res.status).toBe(200)
      expect(res.body.data.alreadyOnPlatform).toBe(false)
      expect(res.body.data.activationUrl).toMatch(/\/accept-invite\?token=[0-9a-f]{64}$/)
    })
  }
})
