/**
 * 10/26 (Nic) — THE LEARN-MORE SCREEN'S WIRE CONTRACT.
 *
 * The screen reads this payload, and the API camelizes every response on the
 * way out (index.ts: res.json wraps camelCaseKeys). So the names the service
 * writes are NOT the names the browser receives, and a page field spelled the
 * service's way reads `undefined` with no error anywhere — a blank screen and
 * a green test suite.
 *
 * That is exactly how it was written the first time. These tests assert the
 * keys the PAGE actually reads, through HTTP, so the two can never drift
 * apart again without something going red.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { camelCaseKeys } from '../lib/caseConversion'
import { db, query, queryOne } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant,
} from '../test/dbHelpers'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  // The same camelCase layer index.ts installs. Without it this test would
  // assert the service's own names and prove nothing about the screen.
  app.use((_req, res, next) => {
    const original = res.json.bind(res)
    res.json = (body: any) => original(camelCaseKeys(body))
    next()
  })
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_flexpay_learn_more'
  await query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('flexpay_rollout_visible', TRUE, 'test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
})

async function resident() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId: l.landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: l.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: l.landlordId, rentAmount: 1000 })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    const ut = (await c.query<{ unit_type: string }>(
      `SELECT unit_type FROM units WHERE id = $1`, [unitId])).rows[0].unit_type
    await c.query(
      `INSERT INTO property_unit_type_late_fees
         (property_id, unit_type, late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type)
       VALUES ($1, $2, 5, 50, 'flat')`, [propertyId, ut])
    await c.query('COMMIT')
    const userId = (await queryOne<any>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).user_id
    return {
      tenantId,
      token: jwt.sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const learnMore = (token: string) => request(buildApp())
  .get('/api/tenants/me/flexpay-learn-more').set('Authorization', `Bearer ${token}`)
const say = (token: string, day: unknown) => request(buildApp())
  .post('/api/tenants/me/flexpay-money-arrives').set('Authorization', `Bearer ${token}`).send({ day })

describe('the keys the screen reads', () => {
  it('comes back camelCase, exactly as the page spells them', async () => {
    const r = await resident()
    const res = await learnMore(r.token)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(Object.keys(res.body.data).sort()).toEqual([
      'arrivesBeforeRentIsLate', 'disclaimer', 'door', 'lateFeeWords',
      'moneyArrivesDay', 'offered', 'pullDay', 'savings',
    ])
    expect(Object.keys(res.body.data.door).sort()).toEqual(['cleanMonths', 'lateMonths', 'needs', 'open', 'via'])
    expect(Object.keys(res.body.data.door.needs).sort()).toEqual(['cleanMonths', 'lateMonths'])
    // And none of the service's own spellings survive the trip.
    expect(JSON.stringify(res.body)).not.toContain('money_arrives_day')
    expect(JSON.stringify(res.body)).not.toContain('late_fee_words')
  })

  it('answering gives back the whole screen, so there is no second round trip', async () => {
    const r = await resident()
    const res = await say(r.token, 17)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.moneyArrivesDay).toBe(17)
    expect(res.body.data.pullDay).toBe(17)
    expect(res.body.data).toHaveProperty('savings')
  })

  it('a savings payload spells its own fields the way the page reads them', async () => {
    const r = await resident()
    await say(r.token, 17)
    const res = await learnMore(r.token)
    const s = res.body.data.savings
    expect(s).not.toBeNull()
    expect(Object.keys(s).sort()).toEqual([
      'benefitWednesday', 'couldHaveBeenCharged', 'difference', 'months',
      'monthsCompared', 'monthsUnpriced', 'noLateFeePolicy', 'pullDay', 'wouldHavePaid',
    ])
  })
})

describe('what the route refuses', () => {
  it('is tenants only', async () => {
    const token = jwt.sign({ userId: 'x', role: 'landlord', email: 'l@l.dev', permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    expect((await learnMore(token)).status).toBe(403)
    expect((await say(token, 17)).status).toBe(403)
  })

  it('refuses a day that is not a day of the month, in words a person can act on', async () => {
    const r = await resident()
    for (const bad of [0, 29, 31, -1, 'tuesday', null]) {
      const res = await say(r.token, bad)
      expect(res.status, `day=${bad}`).toBe(400)
      expect(res.body.error).toMatch(/1st to the 28th/)
    }
  })

  it('is read as a path and not as an id — /me/... sits above /:id', async () => {
    // A literal route below /:id comes back 403 "not your resident", which
    // looks exactly like a permission bug and is not one.
    const r = await resident()
    expect((await learnMore(r.token)).status).not.toBe(403)
  })
})
