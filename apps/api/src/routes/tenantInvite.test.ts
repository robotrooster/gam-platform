/**
 * S628 — CHARACTERISATION TESTS FOR THE TENANT INVITE.
 *
 * POST /api/tenants/invite is 120 lines that create a user account, mint a
 * seven-day activation token, and decide between two different downstream
 * shapes — and it had NO tests at all. The S627 handoff flagged it: do not
 * wrap it in an agent action blind. So this pins what it does first.
 *
 * Writing them found the reason it needed pinning. The landlord's screen says
 * "Invite Sent" and "they will receive an email to set up their account", and
 * the route sent NOTHING — it logged the accept URL and returned it for the
 * landlord to copy by hand. The sibling route that onboards a tenant onto a
 * lease (POST /landlords/me/onboard-new-lease-tenant) does send one, via
 * emailTenantOnboarded, so this was an omission rather than a decision. Every
 * tenant invited from that modal was waiting on an email nobody sent.
 *
 * The last test in this file is the one that would have caught it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

const sentInvites: any[] = []
vi.mock('../services/email', async (orig) => ({
  ...(await orig<any>()),
  emailTenantInvite: vi.fn(async (...args: any[]) => { sentInvites.push(args) }),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sentInvites.length = 0
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_invite'
  process.env.TENANT_APP_URL = 'https://tenants.example.test'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c, { firstName: 'Dana', lastName: 'Okafor' })
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId, unitId,
      token: jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const post = (app: any, token: string, body: any) =>
  request(app).post('/api/tenants/invite').set('Authorization', `Bearer ${token}`).send(body)

describe('POST /api/tenants/invite — what it actually does', () => {
  it('rejects an invite with no unit and no property', async () => {
    const { token } = await seed()
    const res = await post(buildApp(), token, { email: 'a@b.test', firstName: 'Al' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unit or property/i)
  })

  it('rejects a disposable email address', async () => {
    const { token, unitId } = await seed()
    const res = await post(buildApp(), token, {
      email: 'throwaway@mailinator.com', firstName: 'Al', unitId,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable/i)
  })

  it('404s on a unit that does not exist', async () => {
    const { token } = await seed()
    const res = await post(buildApp(), token, {
      email: 'a@b.test', firstName: 'Al',
      unitId: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(404)
  })

  it('refuses to invite into another landlord’s unit', async () => {
    const mine = await seed()
    const theirs = await seed()
    const res = await post(buildApp(), mine.token, {
      email: 'a@b.test', firstName: 'Al', unitId: theirs.unitId,
    })
    expect(res.status).toBe(403)
  })

  it('creates the user, the tenant, and a seven-day activation token', async () => {
    const { token, unitId } = await seed()
    const res = await post(buildApp(), token, {
      email: 'Nadia@example.test', firstName: 'Nadia', lastName: 'Reyes', unitId,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.tenantId).toBeTruthy()
    expect(res.body.data.acceptUrl).toContain('https://tenants.example.test/accept-invite?token=')

    const u = (await db.query(
      `SELECT role, first_name, last_name, tenant_invite_token,
              tenant_invite_expires_at > NOW() + INTERVAL '6 days' AS long_dated
         FROM users WHERE email = $1`, ['Nadia@example.test'])).rows[0]
    expect(u.role).toBe('tenant')
    expect(u.first_name).toBe('Nadia')
    expect(u.tenant_invite_token).toBeTruthy()
    expect(u.long_dated).toBe(true)
  })

  it('a unit-bound invite records a pending lease draft and NO intent', async () => {
    const { token, unitId } = await seed()
    await post(buildApp(), token, { email: 'a@b.test', firstName: 'Al', unitId })

    const drafts = (await db.query(
      `SELECT unit_id, household_order FROM pending_lease_drafts WHERE unit_id = $1`, [unitId])).rows
    expect(drafts).toHaveLength(1)
    expect(Number(drafts[0].household_order)).toBe(0)

    const intents = (await db.query(`SELECT id FROM pending_tenant_intents`)).rows
    expect(intents).toHaveLength(0)
  })

  it('household order follows who was invited first', async () => {
    const { token, unitId } = await seed()
    const app = buildApp()
    await post(app, token, { email: 'first@b.test',  firstName: 'First',  unitId })
    await post(app, token, { email: 'second@b.test', firstName: 'Second', unitId })

    const rows = (await db.query(
      `SELECT u.email, d.household_order
         FROM pending_lease_drafts d JOIN users u ON u.id = d.tenant_user_id
        WHERE d.unit_id = $1 ORDER BY d.household_order`, [unitId])).rows
    expect(rows.map((r: any) => [r.email, Number(r.household_order)]))
      .toEqual([['first@b.test', 0], ['second@b.test', 1]])
  })

  it('a property-level invite records an intent with no unit, and NO lease draft', async () => {
    const { token, propertyId } = await seed()
    await post(buildApp(), token, { email: 'a@b.test', firstName: 'Al', propertyId })

    const intents = (await db.query(
      `SELECT property_id, unit_id, parser_status FROM pending_tenant_intents`)).rows
    expect(intents).toHaveLength(1)
    expect(intents[0].property_id).toBe(propertyId)
    expect(intents[0].unit_id).toBeNull()

    expect((await db.query(`SELECT id FROM pending_lease_drafts`)).rows).toHaveLength(0)
  })

  it('re-inviting the same address reuses the account and re-mints the token', async () => {
    const { token, unitId } = await seed()
    const app = buildApp()
    const first  = await post(app, token, { email: 'a@b.test', firstName: 'Al', unitId })
    const second = await post(app, token, { email: 'a@b.test', firstName: 'Al', unitId })

    expect(second.body.data.userId).toBe(first.body.data.userId)
    expect(second.body.data.tenantId).toBe(first.body.data.tenantId)
    expect(second.body.data.inviteToken).not.toBe(first.body.data.inviteToken)
    expect((await db.query(`SELECT id FROM users WHERE email = $1`, ['a@b.test'])).rows)
      .toHaveLength(1)
    // And the second invite does not double up the household.
    expect((await db.query(`SELECT id FROM pending_lease_drafts`)).rows).toHaveLength(1)
  })

  it('SENDS THE INVITE EMAIL — the landlord is told one went out', async () => {
    const { token, unitId } = await seed()
    const res = await post(buildApp(), token, {
      email: 'nadia@example.test', firstName: 'Nadia', unitId,
    })
    expect(res.status).toBe(200)
    expect(sentInvites).toHaveLength(1)
    const [to, tenantName, landlordName, , , activationUrl] = sentInvites[0]
    expect(to).toBe('nadia@example.test')
    expect(tenantName).toBe('Nadia')
    expect(landlordName).toBe('Dana Okafor')
    expect(activationUrl).toBe(res.body.data.acceptUrl)
  })

  it('says a screening is coming on a property invite, and not on a unit invite', async () => {
    const { token, unitId, propertyId } = await seed()
    const app = buildApp()
    await post(app, token, { email: 'unit@b.test', firstName: 'U', unitId })
    await post(app, token, { email: 'prop@b.test', firstName: 'P', propertyId })

    const byEmail = Object.fromEntries(sentInvites.map((a) => [a[0], a[6]]))
    expect(byEmail['unit@b.test']).toBe(false)
    expect(byEmail['prop@b.test']).toBe(true)
  })

  it('a failed email does not fail the invite — the account and token still exist', async () => {
    const { token, unitId } = await seed()
    const email = await import('../services/email')
    ;(email.emailTenantInvite as any).mockRejectedValueOnce(new Error('resend down'))

    const res = await post(buildApp(), token, {
      email: 'a@b.test', firstName: 'Al', unitId,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.acceptUrl).toContain('accept-invite?token=')
    expect((await db.query(
      `SELECT tenant_invite_token FROM users WHERE email = $1`, ['a@b.test'])).rows[0]
      .tenant_invite_token).toBeTruthy()
  })
})
