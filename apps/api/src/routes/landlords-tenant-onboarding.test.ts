/**
 * landlords.ts tenant onboarding (non-CSV) slice — S367
 * (landlords slice 11 of N — **arc-closer**).
 *
 * 5 routes covering single-tenant manual onboarding + the "limbo
 * pool" workflow where a landlord pre-creates a tenant without lease
 * info, then later attaches a lease via PDF parser (S29c-2-A):
 *   - POST /me/onboard-tenant — single-tenant happy path (user +
 *     tenant + lease + lease_tenant + activation email)
 *   - POST /me/onboard-tenant-pending — pre-create with no lease
 *     (no email)
 *   - POST /me/onboard-tenants-csv/commit-pending — batch limbo
 *     entry from CSV
 *   - GET  /me/pending-tenants — list landlord's unresolved intents
 *   - DELETE /me/pending-tenants/:intentId — cascade-delete intent
 *     + tenant + user (only if safe — preserve when tenant has other
 *     active lease links)
 *
 * emailTenantOnboarded is mocked; everything else writes through the
 * real DB chain.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

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
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailTenantOnboardedMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_onboard'
})

interface TOFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
  propertyId:     string
  unitId:         string
}

async function seedTOFixture(): Promise<TOFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId, withLateFeeDecision: true })
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken, propertyId, unitId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('POST /me/onboard-tenant — single-tenant manual onboarding', () => {
  it('happy: creates user + tenant + lease + lease_tenant + fires activation email', async () => {
    const f = await seedTOFixture()
    const email = `new-${randomUUID().slice(0,6)}@test.dev`
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        firstName: 'Alice', lastName: 'Smith', email, phone: '555-1234',
        unitId: f.unitId,
        leaseStart: '2026-01-01', leaseEnd: '2027-01-01',
        monthlyRent: 1500, securityDeposit: 1000,
      })
    expect(res.status).toBe(200)
    expect(res.body.data.email).toBe(email)
    expect(res.body.data.activationUrl).toMatch(/\/accept-invite\?token=[0-9a-f]{64}$/)

    // Full chain landed
    const u = await db.query<{ role: string }>(
      `SELECT role FROM users WHERE email=$1`, [email])
    expect(u.rows[0].role).toBe('tenant')
    const t = await db.query<{ onboarding_source: string }>(
      `SELECT onboarding_source FROM tenants WHERE id=$1`, [res.body.data.tenantId])
    expect(t.rows[0].onboarding_source).toBe('onboarded')
    const l = await db.query<{ status: string; lease_type: string; needs_review: boolean; lease_source: string }>(
      `SELECT status, lease_type, needs_review, lease_source FROM leases WHERE id=$1`,
      [res.body.data.leaseId])
    expect(l.rows[0].status).toBe('active')
    expect(l.rows[0].lease_type).toBe('fixed_term')  // leaseEnd present
    expect(l.rows[0].needs_review).toBe(true)
    expect(l.rows[0].lease_source).toBe('imported')
    const lt = await db.query<{ role: string; status: string }>(
      `SELECT role, status FROM lease_tenants WHERE lease_id=$1 AND tenant_id=$2`,
      [res.body.data.leaseId, res.body.data.tenantId])
    expect(lt.rows[0].role).toBe('primary')
    expect(lt.rows[0].status).toBe('active')

    expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
    expect(emailTenantOnboardedMock.mock.calls[0]![0]).toBe(email)
  })

  it('no leaseEnd → lease_type defaults to month_to_month', async () => {
    const f = await seedTOFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        firstName: 'Bob', lastName: 'M2M', email: `m2m-${randomUUID()}@test.dev`,
        phone: '555-1234', unitId: f.unitId,
        leaseStart: '2026-01-01', monthlyRent: 1200,
      })
    expect(res.status).toBe(200)
    const l = await db.query<{ lease_type: string }>(
      `SELECT lease_type FROM leases WHERE id=$1`, [res.body.data.leaseId])
    expect(l.rows[0].lease_type).toBe('month_to_month')
  })

  it('cross-landlord unit → 403', async () => {
    const a = await seedTOFixture()
    const b = await seedTOFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({
        firstName: 'X', lastName: 'Y', email: `x-${randomUUID()}@test.dev`,
        phone: '555', unitId: b.unitId,  // b's unit, a's token
        leaseStart: '2026-01-01', monthlyRent: 1000,
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not owned by this landlord/)
  })

  it('unit already occupied → 409', async () => {
    const f = await seedTOFixture()
    // Seed an existing primary tenant on the unit so v_unit_occupancy reports occupied
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const existingTenantId = await seedTenant(client)
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId: existingTenantId, role: 'primary' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        firstName: 'New', lastName: 'Person', email: `new-${randomUUID()}@test.dev`,
        phone: '555', unitId: f.unitId,
        leaseStart: '2026-01-01', monthlyRent: 1000,
      })
    expect(res.status).toBe(409)
    // S582: whole-unit units block a 2nd lease (occupancy-mode gate).
    expect(res.body.error).toMatch(/already has an active lease|whole-unit/i)
  })

  it('by_room: stacks an independent 2nd paper lease on the same unit (dorm/sober-living)', async () => {
    // S582: a landlord importing a rooming house / dorm / sober-living unit has a
    // SEPARATE paper lease per room, all on the same unit. whole_unit would 409;
    // by_room allows independent leases up to 2×bedrooms.
    const f = await seedTOFixture()
    await db.query(`UPDATE units SET occupancy_mode='by_room', bedrooms=2 WHERE id=$1`, [f.unitId])
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const t1 = await seedTenant(client)
      const l1 = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId, status: 'active' })
      await seedLeaseTenant(client, { leaseId: l1, tenantId: t1, role: 'primary' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        firstName: 'Room', lastName: 'Two', email: `r2-${randomUUID()}@test.dev`,
        phone: '555', unitId: f.unitId,
        leaseStart: '2026-01-01', monthlyRent: 500,
      })
    expect(res.status).toBe(200)  // whole_unit would 409 here
    const leases = await db.query(`SELECT id FROM leases WHERE unit_id=$1 AND status='active'`, [f.unitId])
    expect(leases.rows.length).toBe(2)
  })

  it('autoRenew=true with invalid mode → 400', async () => {
    const f = await seedTOFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        firstName: 'AR', lastName: 'Bad', email: `ar-${randomUUID()}@test.dev`,
        phone: '555', unitId: f.unitId,
        leaseStart: '2026-01-01', monthlyRent: 1000,
        autoRenew: true, autoRenewMode: 'not_a_real_mode',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/autoRenewMode must be/)
  })
})

describe('POST /me/onboard-tenant-pending — limbo entry', () => {
  it('happy: creates user + tenant + intent (no email fired)', async () => {
    const f = await seedTOFixture()
    const email = `pend-${randomUUID().slice(0,6)}@test.dev`
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'Pending', lastName: 'Tenant', email, phone: '555-9999' })
    expect(res.status).toBe(200)
    expect(res.body.data.parserStatus).toBe('not_uploaded')

    const intent = await db.query<{ landlord_id: string; tenant_id: string; resolved_at: string | null }>(
      `SELECT landlord_id, tenant_id, resolved_at FROM pending_tenant_intents WHERE id=$1`,
      [res.body.data.intentId])
    expect(intent.rows[0].landlord_id).toBe(f.landlordId)
    expect(intent.rows[0].resolved_at).toBeNull()

    // No email fired — limbo entry doesn't activate the tenant yet
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  })

  it('duplicate intent for same tenant → 409', async () => {
    const f = await seedTOFixture()
    const email = `dup-${randomUUID().slice(0,6)}@test.dev`
    const r1 = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'A', lastName: 'B', email, phone: '555' })
    expect(r1.status).toBe(200)

    const r2 = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'A', lastName: 'B', email, phone: '555' })
    expect(r2.status).toBe(409)
    expect(r2.body.error).toMatch(/already in your pending pool/)
  })
})

describe('POST /me/onboard-tenants-csv/commit-pending — batch limbo', () => {
  it('empty rows → 400', async () => {
    const f = await seedTOFixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ rows: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/rows array required/)
  })

  it('mixed batch: 1 valid + 1 missing-fields → per-row results; valid row landed', async () => {
    const f = await seedTOFixture()
    const okEmail = `ok-${randomUUID().slice(0,6)}@test.dev`
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/commit-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        rows: [
          { rowIndex: 0, firstName: 'Good', lastName: 'Row', email: okEmail, phone: '555-1111' },
          { rowIndex: 1, firstName: 'Bad', lastName: '', email: '', phone: '' },  // missing fields
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.data.created).toBe(1)
    expect(res.body.data.skipped).toBe(1)
    expect(res.body.data.results[0].status).toBe('created')
    expect(res.body.data.results[1].status).toBe('error')
    expect(res.body.data.results[1].message).toMatch(/required/)

    // The good row's intent persisted (rollback isolation)
    const intents = await db.query(
      `SELECT id FROM pending_tenant_intents WHERE landlord_id=$1`, [f.landlordId])
    expect(intents.rows.length).toBe(1)
  })
})

describe('GET /me/pending-tenants', () => {
  it('landlord-scoped; resolved intents excluded; cross-landlord excluded', async () => {
    const a = await seedTOFixture()
    const b = await seedTOFixture()
    const okEmail = `pa-${randomUUID().slice(0,6)}@test.dev`
    await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ firstName: 'A', lastName: 'A', email: okEmail, phone: '555' })

    // b's pending tenant (should be excluded from a's view)
    await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${b.landlordToken}`)
      .send({ firstName: 'B', lastName: 'B', email: `pb-${randomUUID()}@test.dev`, phone: '555' })

    // Mark one of a's intents as resolved (should be excluded)
    const aResolvedEmail = `rs-${randomUUID().slice(0,6)}@test.dev`
    const aResolved = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ firstName: 'R', lastName: 'R', email: aResolvedEmail, phone: '555' })
    await db.query(
      `UPDATE pending_tenant_intents SET resolved_at=NOW() WHERE id=$1`,
      [aResolved.body.data.intentId])

    const res = await request(buildApp())
      .get('/api/landlords/me/pending-tenants')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].email).toBe(okEmail)
  })
})

describe('DELETE /me/pending-tenants/:intentId', () => {
  it('not found / wrong landlord → 404', async () => {
    const f = await seedTOFixture()
    const res = await request(buildApp())
      .delete(`/api/landlords/me/pending-tenants/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
  })

  // Retention rule ("keep everything — a delete only hides a record from the
  // owner, it never leaves our server"): canceling a pending invite is a
  // SOFT-HIDE, not an erase. The intent row, tenant, user, and any PDF are all
  // retained; the invite just drops out of the landlord's list and frees the
  // person/unit for a re-invite.
  it('cancel is soft-hide: intent + tenant + user all retained on server, invite leaves the landlord list', async () => {
    const f = await seedTOFixture()
    const email = `del-${randomUUID().slice(0,6)}@test.dev`
    const create = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'D', lastName: 'EL', email, phone: '555' })
    const intentId = create.body.data.intentId
    const tenantId = create.body.data.tenantId
    const userId = create.body.data.userId

    const res = await request(buildApp())
      .delete(`/api/landlords/me/pending-tenants/${intentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.cancelled).toBe(true)
    expect(res.body.data.tenantDeleted).toBe(false)
    expect(res.body.data.userDeleted).toBe(false)

    // Nothing erased — all three rows persist, intent stamped cancelled_at.
    const intent = await db.query(`SELECT id, cancelled_at FROM pending_tenant_intents WHERE id=$1`, [intentId])
    expect(intent.rows.length).toBe(1)
    expect(intent.rows[0].cancelled_at).not.toBeNull()
    const t = await db.query(`SELECT id FROM tenants WHERE id=$1`, [tenantId])
    expect(t.rows.length).toBe(1)
    const u = await db.query(`SELECT id FROM users WHERE id=$1`, [userId])
    expect(u.rows.length).toBe(1)

    // But it's hidden from the landlord's pending list.
    const list = await request(buildApp())
      .get('/api/landlords/me/pending-tenants')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data.find((r: any) => r.intentId === intentId)).toBeUndefined()
  })

  it('cancel frees the person for re-invite (cancelled invite is not blocking)', async () => {
    const f = await seedTOFixture()
    const email = `reinvite-${randomUUID().slice(0,6)}@test.dev`
    const create = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'Re', lastName: 'Invite', email, phone: '555' })
    const intentId = create.body.data.intentId

    await request(buildApp())
      .delete(`/api/landlords/me/pending-tenants/${intentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .expect(200)

    // Re-inviting the same person now succeeds (the cancelled invite doesn't
    // trip the duplicate-pending guard).
    const again = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'Re', lastName: 'Invite', email, phone: '555' })
    expect(again.status).toBe(200)
    expect(again.body.data.intentId).not.toBe(intentId)
  })

  it('tenant with a lease elsewhere: canceling an invite retains everything', async () => {
    const f = await seedTOFixture()
    const email = `keep-${randomUUID().slice(0,6)}@test.dev`
    const create = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'Keep', lastName: 'Me', email, phone: '555' })
    const intentId = create.body.data.intentId
    const tenantId = create.body.data.tenantId
    const userId = create.body.data.userId

    // Unrelated lease elsewhere for the same tenant.
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const otherLeaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId: otherLeaseId, tenantId, role: 'primary' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .delete(`/api/landlords/me/pending-tenants/${intentId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.cancelled).toBe(true)

    // Everything preserved; intent soft-cancelled, not deleted.
    const intent = await db.query(`SELECT cancelled_at FROM pending_tenant_intents WHERE id=$1`, [intentId])
    expect(intent.rows.length).toBe(1)
    expect(intent.rows[0].cancelled_at).not.toBeNull()
    const t = await db.query(`SELECT id FROM tenants WHERE id=$1`, [tenantId])
    expect(t.rows.length).toBe(1)
    const u = await db.query(`SELECT id FROM users WHERE id=$1`, [userId])
    expect(u.rows.length).toBe(1)
  })
})

// S616 (Nic): "When a landlord is onboarding a property and goes to send an
// invite and lease to that person, it needs to be intercepted in the server
// that that person already is on the platform. And instead of giving them the
// tenant portal invite, it just drafts up the lease."
//
// The neighbour who has been paying for trash and electric for months already
// has a GAM login. Both onboarding routes reused their user row and then
// mailed them "activate your account and set a password" for an account they
// already use — and following it would overwrite their working password.
describe('onboarding somebody who is already on the platform (S616)', () => {
  async function existingAccount(email: string) {
    // A real password, not the placeholder the invite flow writes.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { rows: [u] } = await c.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1, '$2b$10$a.real.bcrypt.hash.for.an.active.account', 'tenant',
                 'Dale', 'Ruiz', '555-0143')
         RETURNING id`, [email])
      await c.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])
      await c.query('COMMIT')
      return u.id
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('drafts the lease instead of sending a portal invite', async () => {
    const f = await seedTOFixture()
    const email = `existing-${randomUUID().slice(0,6)}@test.dev`
    const userId = await existingAccount(email)

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        firstName: 'Dale', lastName: 'Ruiz', email, phone: '555-0143',
        unitId: f.unitId,
        leaseStart: '2026-01-01', leaseEnd: '2027-01-01',
        monthlyRent: 1500, securityDeposit: 1000,
      })
    expect(res.status).toBe(200)
    expect(res.body.data.alreadyOnPlatform).toBe(true)
    // No activation link, because there is nothing to activate.
    expect(res.body.data.activationUrl).toBeNull()

    // And no invite token was minted against their live account — that token is
    // what makes the "set a password" mail possible in the first place.
    const { rows } = await db.query<any>(
      `SELECT tenant_invite_token, password_hash FROM users WHERE id = $1`, [userId])
    expect(rows[0].tenant_invite_token).toBeNull()
    expect(rows[0].password_hash).toBe('$2b$10$a.real.bcrypt.hash.for.an.active.account')

    // The lease still gets made — that is the whole point.
    expect(res.body.data.leaseId).toBeTruthy()
  })

  it('a brand-new person still gets the invite, unchanged', async () => {
    const f = await seedTOFixture()
    const email = `brand-new-${randomUUID().slice(0,6)}@test.dev`
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        firstName: 'New', lastName: 'Person', email, phone: '555-0100',
        unitId: f.unitId,
        leaseStart: '2026-01-01', leaseEnd: '2027-01-01',
        monthlyRent: 1500, securityDeposit: 1000,
      })
    expect(res.status).toBe(200)
    expect(res.body.data.alreadyOnPlatform).toBe(false)
    expect(res.body.data.activationUrl).toMatch(/\/accept-invite\?token=[0-9a-f]{64}$/)
  })

  // An invite that was SENT but never accepted still needs re-sending — that
  // account is not "on the platform", it is waiting.
  it('re-invites someone who never accepted', async () => {
    const f = await seedTOFixture()
    const email = `pending-${randomUUID().slice(0,6)}@test.dev`
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', 'Wait', 'Ing', '555-0111')`,
        [email])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        firstName: 'Wait', lastName: 'Ing', email, phone: '555-0111',
        unitId: f.unitId,
        leaseStart: '2026-01-01', leaseEnd: '2027-01-01',
        monthlyRent: 1500, securityDeposit: 1000,
      })
    expect(res.status).toBe(200)
    expect(res.body.data.alreadyOnPlatform).toBe(false)
    expect(res.body.data.activationUrl).toBeTruthy()
  })
})
