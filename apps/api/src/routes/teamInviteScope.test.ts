/**
 * S640 — a landlord can invite a team member at all.
 *
 * Setting Lisa Scheeler up on the front desk failed on a raw Postgres string:
 * "null value in column landlord_id of relation invitations". The Team page
 * resolved the company as `req.user.profileId`, and since S633 a landlord's
 * profileId is NULL — an account is not an entity. So EVERY invite, permission
 * change and scope listing on that page was dead in production.
 *
 * The existing suite was green throughout, because it signs its landlord token
 * with `profileId: landlordId` — the pre-S633 shape that login no longer
 * issues. These tests sign the token the way requireAuth actually builds it:
 * profileId null, the owned companies in landlordIds. That is the only
 * difference between a suite that catches this and one that cannot.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { scopesRouter } from './scopes'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/scopes', scopesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_teaminvite'
})

/** The token shape production issues: profileId NULL, companies in landlordIds. */
const realLandlordToken = (userId: string, landlordIds: string[]) => jwt.sign(
  { userId, role: 'landlord', email: 'owner@t.dev', profileId: null, landlordIds, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

/** One account, `companies` companies, each with one property. */
async function seedAccount(companies: number) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const first = await seedLandlord(c)
    const ids = [first.landlordId]
    const props = [await seedProperty(c, {
      landlordId: first.landlordId, ownerUserId: first.userId, managedByUserId: first.userId })]
    for (let i = 1; i < companies; i++) {
      const l = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, business_name) VALUES ($1,$2) RETURNING id`,
        [first.userId, `Company ${i}`])
      ids.push(l.rows[0].id)
      props.push(await seedProperty(c, {
        landlordId: l.rows[0].id, ownerUserId: first.userId, managedByUserId: first.userId }))
    }
    await c.query('COMMIT')
    return { userId: first.userId, landlordIds: ids, propertyIds: props,
             token: realLandlordToken(first.userId, ids) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const invite = (token: string, body: any) => request(buildApp())
  .post('/api/scopes/onsite_manager/invite').set('Authorization', `Bearer ${token}`).send(body)

describe('S640 team invites survive the account/entity split', () => {
  it('a one-company landlord can invite an on-site manager', async () => {
    const a = await seedAccount(1)
    const res = await invite(a.token, {
      email: 'desk@example.com', firstName: 'Front', lastName: 'Desk',
      scope: { propertyIds: [a.propertyIds[0]], unitIds: [], allProperties: false,
               permissions: { 'front_desk.view': true, 'take_payment': true } },
    })
    expect(res.status).toBe(201)
    const inv = (await db.query<any>(
      `SELECT landlord_id, scope_payload FROM invitations WHERE email='desk@example.com'`)).rows[0]
    expect(inv.landlord_id).toBe(a.landlordIds[0])
    const scope = typeof inv.scope_payload === 'string' ? JSON.parse(inv.scope_payload) : inv.scope_payload
    expect(scope.permissions['take_payment']).toBe(true)
  })

  // Deriving beats asking: a team member is scoped to a property, and the
  // property already names its company. Nothing for the owner to choose.
  it('a TWO-company landlord lands the invite on the named property’s company', async () => {
    const a = await seedAccount(2)
    const res = await invite(a.token, {
      email: 'desk2@example.com',
      scope: { propertyIds: [a.propertyIds[1]], unitIds: [], allProperties: false, permissions: {} },
    })
    expect(res.status).toBe(201)
    const inv = (await db.query<any>(
      `SELECT landlord_id FROM invitations WHERE email='desk2@example.com'`)).rows[0]
    expect(inv.landlord_id).toBe(a.landlordIds[1])   // the second company, not the first
  })

  it('refuses a property belonging to another account', async () => {
    const mine   = await seedAccount(1)
    const theirs = await seedAccount(1)
    const res = await invite(mine.token, {
      email: 'desk3@example.com',
      scope: { propertyIds: [theirs.propertyIds[0]], unitIds: [], allProperties: false, permissions: {} },
    })
    expect(res.status).toBe(403)
    const n = await db.query<any>(`SELECT COUNT(*)::int AS c FROM invitations`)
    expect(n.rows[0].c).toBe(0)
  })

  // 10/11 (Nic): a bookkeeper ticks at least one property, so their company is
  // derived from the property like everyone else's. An account with a single
  // company still resolves; a request naming no property and no company on a
  // two-company account is asked, in words.
  it('a bookkeeper invite resolves for one company, and from the ticked property when there are two', async () => {
    const one = await seedAccount(1)
    const okRes = await request(buildApp())
      .post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${one.token}`)
      .send({ email: 'books@example.com', scope: { accessLevel: 'read_only', propertyIds: [one.propertyIds[0]] } })
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(201)

    const two = await seedAccount(2)
    const askRes = await request(buildApp())
      .post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${two.token}`)
      .send({ email: 'books2@example.com', scope: { accessLevel: 'read_only' } })
    // S654 (Nic, DIRECTIVE): no default company — with none named and nothing
    // to derive one from, the invite is ASKED which company, never filed under
    // "the one the account founded". Naming it (or a property in the scope)
    // is what the form sends.
    expect(askRes.status, JSON.stringify(askRes.body)).toBe(400)
    expect(String(askRes.body?.error)).toMatch(/more than one company/i)
    const derived = await request(buildApp())
      .post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${two.token}`)
      .send({ email: 'books4@example.com', scope: { propertyIds: [two.propertyIds[1]] } })
    expect(derived.status, JSON.stringify(derived.body)).toBe(201)
    const inv = (await db.query<any>(
      `SELECT landlord_id FROM invitations WHERE email='books4@example.com'`)).rows[0]
    expect(inv.landlord_id).toBe(two.landlordIds[1])
    const namedRes = await request(buildApp())
      .post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${two.token}`)
      .send({ email: 'books3@example.com', landlordId: two.landlordIds[0],
              scope: { accessLevel: 'read_only', propertyIds: [two.propertyIds[0]] } })
    expect(namedRes.status, JSON.stringify(namedRes.body)).toBe(201)
  })

  it('a bookkeeper invite that ticks nothing is refused, in words', async () => {
    const one = await seedAccount(1)
    for (const scope of [{}, { propertyIds: [] }, { propertyIds: null }]) {
      const res = await request(buildApp())
        .post('/api/scopes/bookkeeper/invite').set('Authorization', `Bearer ${one.token}`)
        .send({ email: 'none@example.com', landlordId: one.landlordIds[0], scope })
      expect(res.status, JSON.stringify(scope)).toBe(400)
      expect(res.body.error).toBe('Tick at least one property or Company-wide.')
    }
    expect((await db.query<any>(`SELECT COUNT(*)::int AS c FROM invitations`)).rows[0].c).toBe(0)
  })
})
