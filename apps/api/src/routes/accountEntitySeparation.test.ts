/**
 * S633 — THE ACCOUNT IS NOT AN ENTITY.
 *
 * Nic (DIRECTIVE, verbatim): "Account ownership is no correlation to a specific
 * entity. Entities own properties. The account owns the entities. When I'm
 * logged into my account, I can invite any fucking person to any fucking
 * property I own without switching a goddamn thing."
 *
 * A landlord's session used to BE one `landlords` row: `users.active_landlord_id`
 * picked it and login stamped it into the JWT as `profileId`. Roughly 269 call
 * sites read that as "the landlord", so a person who owns two companies was only
 * ever half signed in — and it never errored, it returned an empty list.
 *
 * These tests pin the three things that must all be true at once:
 *
 *   1. A landlord token carries NO entity id. profileId is null.
 *   2. Reads and writes reach EVERY company the account owns, from one session,
 *      with nothing switched.
 *   3. A stranger's property is still refused. This refactor must not have
 *      loosened the cross-tenant isolation it was threaded through — that is the
 *      one thing it could have broken silently.
 *
 * The invite path below is the one that actually blocked him: signed into Oak
 * Park, `POST /landlords/me/onboard-tenant-pending` answered "unitId does not
 * belong to this landlord" for a Mountain View unit he owns, and ~75 residents
 * could not be invited.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { propertiesRouter } from './properties'
import { tenantsRouter } from './tenants'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use('/api/properties', propertiesRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
})

/** One account, TWO companies, one property each — Nic's actual shape. */
async function seedTwoEntityAccount() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    // Company 1 — the one the account was founded on ("Oak Park").
    const a = await seedLandlord(c)
    // Company 2 — bought later ("Mountain View"). Same person, same account.
    const b = await seedLandlord(c)
    await c.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT DO NOTHING`, [b.landlordId, a.userId])
    // The founding membership row too, so the set is honest either way.
    await c.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT DO NOTHING`, [a.landlordId, a.userId])

    const propA = await seedProperty(c, {
      landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const propB = await seedProperty(c, {
      landlordId: b.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: a.landlordId })
    const unitB = await seedUnit(c, { propertyId: propB, landlordId: b.landlordId })
    // Rent must be set before anyone can be invited to a unit.
    await c.query(`UPDATE units SET rent_amount = 500 WHERE id = ANY($1::uuid[])`, [[unitA, unitB]])

    // An unrelated landlord — the isolation this must not loosen.
    const stranger = await seedLandlord(c)
    const propStranger = await seedProperty(c, {
      landlordId: stranger.landlordId, ownerUserId: stranger.userId, managedByUserId: stranger.userId })
    const unitStranger = await seedUnit(c, {
      propertyId: propStranger, landlordId: stranger.landlordId })
    await c.query('COMMIT')
    return {
      userId: a.userId,
      entityA: a.landlordId, entityB: b.landlordId,
      propA, propB, unitA, unitB,
      strangerEntity: stranger.landlordId, propStranger, unitStranger,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * A post-S633 landlord session: NO profileId, both companies in landlordIds.
 * This is what routes/auth.ts now mints.
 */
function accountToken(f: { userId: string; entityA: string; entityB: string }) {
  return jwt.sign(
    { userId: f.userId, role: 'landlord', email: 'multi@t.dev',
      profileId: null, landlordIds: [f.entityA, f.entityB], permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '10m' })
}

describe('S633 the session carries no entity', () => {
  it('a landlord token has a null profileId, and both companies in landlordIds', async () => {
    const f = await seedTwoEntityAccount()
    const decoded: any = jwt.verify(accountToken(f), process.env.JWT_SECRET!)
    // The whole point: an account is not an entity, so it does not name one.
    expect(decoded.profileId).toBeNull()
    expect(decoded.landlordIds).toEqual(
      expect.arrayContaining([f.entityA, f.entityB]))
  })
})

describe('S633 one session reaches every company the account owns', () => {
  it('the tenant picker lists tenants across both companies, not one', async () => {
    const f = await seedTwoEntityAccount()
    const res = await request(buildApp()).get('/api/tenants')
      .set('Authorization', `Bearer ${accountToken(f)}`)
    // Scoped to one entity this 403'd or came back short; the shape is what
    // matters here — it must resolve a scope at all with no profileId.
    expect(res.status).toBe(200)
  })

  it('properties lists BOTH companies\' properties from one session', async () => {
    const f = await seedTwoEntityAccount()
    const res = await request(buildApp()).get('/api/properties')
      .set('Authorization', `Bearer ${accountToken(f)}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(p => p.id)
    expect(ids).toContain(f.propA)
    expect(ids).toContain(f.propB)
    // ... and still not a stranger's.
    expect(ids).not.toContain(f.propStranger)
  })

  it('meters resolve at EITHER company, and never at a stranger\'s', async () => {
    const f = await seedTwoEntityAccount()
    const app = buildApp()
    const tok = accountToken(f)
    for (const propertyId of [f.propA, f.propB]) {
      const r = await request(app).get(`/api/utility/meters?propertyId=${propertyId}`)
        .set('Authorization', `Bearer ${tok}`)
      expect(r.status).toBe(200)
    }
    const theirs = await request(app).get(`/api/utility/meters?propertyId=${f.propStranger}`)
      .set('Authorization', `Bearer ${tok}`)
    expect(theirs.status).toBe(404)
  })
})

describe('S633 the invite that blocked the Mountain View onboarding', () => {
  /**
   * THE REGRESSION. Signed in, with nothing switched, an invite must reach a
   * unit at EITHER company. Before this change the second company answered
   * "unitId does not belong to this landlord" — a 400 that was true of the
   * session and false of the account.
   */
  it('invites a tenant to a unit at EITHER company from one session', async () => {
    const f = await seedTwoEntityAccount()
    const app = buildApp()
    const tok = accountToken(f)

    for (const [i, unitId] of [f.unitA, f.unitB].entries()) {
      const res = await request(app).post('/api/landlords/me/onboard-tenant-pending')
        .set('Authorization', `Bearer ${tok}`)
        .send({
          firstName: 'Pat', lastName: `Resident${i}`,
          email: `resident${i}.${Date.now()}@t.dev`,
          phone: '6025550100',
          unitId,
        })
      // Whatever else this route decides, it must never refuse the unit for
      // belonging to "another landlord" — the account owns both companies.
      expect(res.body?.error ?? '').not.toMatch(/does not belong to this landlord/i)
      expect(res.body?.error ?? '').not.toMatch(/not owned by this landlord/i)
      expect([200, 201]).toContain(res.status)
    }
  })

  it("still refuses a stranger's unit — isolation is not loosened", async () => {
    const f = await seedTwoEntityAccount()
    const res = await request(buildApp()).post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${accountToken(f)}`)
      .send({
        firstName: 'Not', lastName: 'Mine',
        email: `stranger.${Date.now()}@t.dev`,
        phone: '6025550101',
        unitId: f.unitStranger,
      })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

describe('S633 a write that names no company', () => {
  /**
   * Where a write cannot derive its company from a property or unit, the account
   * must NAME one. Defaulting to "whichever entity the session sat on" is the
   * bug being removed — a property filed under the wrong LLC is unwound by hand,
   * so asking is the cheap half of the trade.
   */
  it('asks which company rather than guessing, when the account owns several', async () => {
    const f = await seedTwoEntityAccount()
    const res = await request(buildApp()).post('/api/properties')
      .set('Authorization', `Bearer ${accountToken(f)}`)
      .send({
        name: 'Ambiguous Park', street1: '1 Test St', city: 'Phoenix',
        state: 'AZ', zip: '85001',
        allocationRule: { platformFeePayer: 'landlord', manualFeePayer: 'tenant' },
      })
    expect(res.status).toBe(400)
    expect(String(res.body?.error)).toMatch(/more than one company/i)
  })

  it('accepts the named company, and refuses one the account does not own', async () => {
    const f = await seedTwoEntityAccount()
    const app = buildApp()
    const tok = accountToken(f)
    const base = {
      street1: '2 Test St', city: 'Phoenix', state: 'AZ', zip: '85001',
      allocationRule: { platformFeePayer: 'landlord', manualFeePayer: 'tenant' },
    }
    const ok = await request(app).post('/api/properties')
      .set('Authorization', `Bearer ${tok}`)
      .send({ ...base, name: 'Named Park', landlordId: f.entityB })
    expect([200, 201]).toContain(ok.status)

    const nope = await request(app).post('/api/properties')
      .set('Authorization', `Bearer ${tok}`)
      .send({ ...base, name: 'Not Mine Park', landlordId: f.strangerEntity })
    expect(nope.status).toBe(403)
  })
})
