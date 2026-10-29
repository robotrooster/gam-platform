/**
 * S512 #30 — GET /api/background/pool/search proximity ordering.
 *
 * The pool list is sorted by administrative proximity to the landlord's
 * properties (no street-level distance yet — properties carry no lat/lon).
 * Tiering: 0 same ZIP · 1 same city+state · 2 same ZIP3 region ·
 * 3 same state · 4 elsewhere, ties broken on risk_score then recency.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pool'
})

const sign = (claims: any) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

/** Create user + background_check + an available pool entry at a location. */
async function seedPoolEntry(landlordId: string, loc: {
  city: string; state: string; zip: string; riskScore?: number
}): Promise<string> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'Pool', 'Applicant', TRUE) RETURNING id`,
      [`pool-${randomUUID()}@test.dev`])
    const bc = await c.query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, consent_pool)
       VALUES ($1, $2, TRUE) RETURNING id`,
      [landlordId, u.rows[0].id])
    const ap = await c.query<{ id: string }>(
      `INSERT INTO application_pool
         (background_check_id, user_id, status, consent_pool, city, state, zip, risk_score)
       VALUES ($1, $2, 'available', TRUE, $3, $4, $5, $6) RETURNING id`,
      [bc.rows[0].id, u.rows[0].id, loc.city, loc.state, loc.zip, loc.riskScore ?? 50])
    await c.query('COMMIT')
    return ap.rows[0].id
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedLandlordWithProperty() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    // seedProperty fixes Phoenix / AZ / 85001.
    await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query('COMMIT')
    return { userId, landlordId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

describe('GET /api/background/pool/search — proximity ordering', () => {
  it('orders candidates by proximity tier to the landlord properties', async () => {
    const { userId, landlordId } = await seedLandlordWithProperty()
    // Insert out of order; expect the response sorted by proximity.
    const elsewhere = await seedPoolEntry(landlordId, { city: 'Denver',  state: 'CO', zip: '80014' }) // 4
    const sameState = await seedPoolEntry(landlordId, { city: 'Tucson',  state: 'AZ', zip: '85701' }) // 3
    const sameZip   = await seedPoolEntry(landlordId, { city: 'Phoenix', state: 'AZ', zip: '85001' }) // 0
    const sameRegion= await seedPoolEntry(landlordId, { city: 'Mesa',    state: 'AZ', zip: '85003' }) // 2 (zip3 850, diff city)
    const sameCity  = await seedPoolEntry(landlordId, { city: 'Phoenix', state: 'AZ', zip: '85099' }) // 1

    const token = sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} })
    const res = await request(buildApp()).get('/api/background/pool/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const ids   = res.body.data.map((r: any) => r.id)
    const ranks = res.body.data.map((r: any) => r.proximity_rank)
    expect(ids).toEqual([sameZip, sameCity, sameRegion, sameState, elsewhere])
    expect(ranks).toEqual([0, 1, 2, 3, 4])
  })

  it('only returns available entries, scoped per landlord', async () => {
    const a = await seedLandlordWithProperty()
    const b = await seedLandlordWithProperty()
    await seedPoolEntry(a.landlordId, { city: 'Phoenix', state: 'AZ', zip: '85001' })
    // B's own pool row referencing a different bg-check; A should still see
    // the global available pool (pool is platform-wide), so seed under B too.
    await seedPoolEntry(b.landlordId, { city: 'Reno', state: 'NV', zip: '89501' })
    const token = sign({ userId: a.userId, role: 'landlord', email: 'a@t.dev', profileId: a.landlordId, permissions: {} })
    const res = await request(buildApp()).get('/api/background/pool/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // Pool is platform-wide (any landlord can reach out), so both appear,
    // but A's local Phoenix candidate ranks first.
    expect(res.body.data[0].city).toBe('Phoenix')
    expect(res.body.data[0].proximity_rank).toBe(0)
  })

  it('ranks against EVERY company the account owns, not just the first', async () => {
    // S651. The route took landlordIds[0] and passed one id. An account holding
    // two LLCs had every applicant ranked against whichever came back first, so
    // a renter standing next door to the second park sorted as though they were
    // in another state — and `already_contacted` read FALSE for anyone the
    // other company had already paid the dollar to unlock, which is a second
    // dollar for the same person. (memory: gam-account-is-not-an-entity)
    const c = await db.connect()
    let userId = '', companyA = '', companyB = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      userId = l.userId; companyA = l.landlordId
      // Phoenix park under the first company.
      await seedProperty(c, { landlordId: companyA, ownerUserId: userId, managedByUserId: userId })
      // A SECOND company under the same account, with a park in Yarnell.
      const b = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, business_name) VALUES ($1, 'Second LLC') RETURNING id`,
        [userId])
      companyB = b.rows[0].id
      await c.query(
        `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                                 owner_user_id, managed_by_user_id)
         VALUES ($1, 'Yarnell Park', '2 Test St', 'Yarnell', 'AZ', '85362', $2, $2)`,
        [companyB, userId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }

    const nextDoorToB = await seedPoolEntry(companyA, { city: 'Yarnell', state: 'AZ', zip: '85362' })
    const farAway     = await seedPoolEntry(companyA, { city: 'Denver',  state: 'CO', zip: '80014' })

    const token = sign({ userId, role: 'landlord', email: 'two@t.dev', profileId: companyA,
                         landlordIds: [companyA], permissions: {} })
    const res = await request(buildApp()).get('/api/background/pool/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)

    const byId = Object.fromEntries(res.body.data.map((r: any) => [r.id, r]))
    // Same ZIP as the SECOND company's park — tier 0, not "somewhere in AZ".
    expect(byId[nextDoorToB].proximity_rank).toBe(0)
    expect(byId[farAway].proximity_rank).toBe(4)
  })

  it('shows a renter as already contacted when the account\'s OTHER company paid for them', async () => {
    const c = await db.connect()
    let userId = '', companyA = '', companyB = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      userId = l.userId; companyA = l.landlordId
      await seedProperty(c, { landlordId: companyA, ownerUserId: userId, managedByUserId: userId })
      const b = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, business_name) VALUES ($1, 'Second LLC') RETURNING id`,
        [userId])
      companyB = b.rows[0].id
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }

    const entry = await seedPoolEntry(companyA, { city: 'Phoenix', state: 'AZ', zip: '85001' })
    // The other company already paid the $1 to unlock this person.
    await db.query(
      `INSERT INTO pool_match_requests (pool_entry_id, landlord_id) VALUES ($1, $2)`,
      [entry, companyB])

    // landlordIds is pinned so companyA is unambiguously FIRST in the scope.
    // Without it the order comes from a UNION and is arbitrary — the test would
    // pass against the old landlordIds[0] code roughly half the time, which is
    // worse than no test at all.
    const token = sign({ userId, role: 'landlord', email: 'dupe@t.dev', profileId: companyA,
                         landlordIds: [companyA], permissions: {} })
    const res = await request(buildApp()).get('/api/background/pool/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.find((r: any) => r.id === entry).already_contacted).toBe(true)
  })

  it('landlord with no properties → all rank 4, no crash', async () => {
    const c = await db.connect()
    let landlordId = '', userId = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      landlordId = l.landlordId; userId = l.userId
      await c.query('COMMIT')
    } finally { c.release() }
    await seedPoolEntry(landlordId, { city: 'Phoenix', state: 'AZ', zip: '85001' })
    const token = sign({ userId, role: 'landlord', email: 'np@t.dev', profileId: landlordId, permissions: {} })
    const res = await request(buildApp()).get('/api/background/pool/search')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].proximity_rank).toBe(4)
  })
})

/**
 * ── 10/20: THE RENTER POOL'S NOTICE HONORS THE ANSWER TOO ───────────────────
 *
 * 'match_interest' was the one notification type the API emitted that was in
 * NEITHER the catalog NOR the retired list, so it had no switch on any settings
 * page and no way for a pool member to decline it. It got there by writing a
 * SECOND notification table — tenant_notifications — which the completeness
 * scanner never looked at (its regex only read `INSERT INTO notifications`),
 * and by ignoring in_app_enabled, which no other notification does.
 *
 * It is in the catalog now, the scanner reads both tables, and the write below
 * asks the same question createNotification asks: a missing row means on, an
 * explicit FALSE means off.
 */
describe('a renter-pool member who switched the interest notice off', () => {
  async function reachOut(poolId: string, token: string) {
    return request(buildApp())
      .post(`/api/background/pool/${poolId}/reach-out`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'We have a space that fits you' })
  }

  async function landlordToken() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query('COMMIT')
      const { rows } = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])
      return {
        landlordId,
        token: sign({
          userId, role: 'landlord', email: rows[0]!.email, profileId: landlordId,
          landlordIds: [landlordId], permissions: {},
        }),
      }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  const poolUserOf = async (poolId: string) =>
    (await db.query<{ user_id: string }>(
      `SELECT user_id FROM application_pool WHERE id = $1`, [poolId])).rows[0]!.user_id

  it('gets the in-app notice when they have answered nothing', async () => {
    const ll = await landlordToken()
    const poolId = await seedPoolEntry(ll.landlordId, { city: 'Mesa', state: 'AZ', zip: '85201' })
    const res = await reachOut(poolId, ll.token)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { rows } = await db.query(
      `SELECT type FROM tenant_notifications WHERE user_id = $1`, [await poolUserOf(poolId)])
    expect(rows.map((r: any) => r.type)).toEqual(['match_interest'])
  })

  it('gets no in-app notice once they have switched it off', async () => {
    const ll = await landlordToken()
    const poolId = await seedPoolEntry(ll.landlordId, { city: 'Mesa', state: 'AZ', zip: '85202' })
    const userId = await poolUserOf(poolId)
    await db.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
       VALUES ($1, 'match_interest', FALSE, FALSE)`, [userId])

    const res = await reachOut(poolId, ll.token)
    // The reach-out itself still succeeds — the match request is a real record
    // the landlord made. Only the notice to the member is declined.
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const notices = await db.query(
      `SELECT 1 FROM tenant_notifications WHERE user_id = $1`, [userId])
    expect(notices.rows).toEqual([])
    const matches = await db.query(
      `SELECT 1 FROM pool_match_requests WHERE pool_entry_id = $1`, [poolId])
    expect(matches.rows.length).toBe(1)
  })

  it('and the email beside it is declined by the same answer', async () => {
    const ll = await landlordToken()
    const poolId = await seedPoolEntry(ll.landlordId, { city: 'Mesa', state: 'AZ', zip: '85203' })
    const userId = await poolUserOf(poolId)
    await db.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
       VALUES ($1, 'match_interest', FALSE, TRUE)`, [userId])
    const { rows: who } = await db.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`, [userId])

    expect((await reachOut(poolId, ll.token)).status).toBe(200)
    const { rows } = await db.query<{ error_message: string | null }>(
      `SELECT error_message FROM email_send_log
        WHERE lower(to_email) = lower($1) AND category = 'pool_match_interest'
        ORDER BY created_at DESC LIMIT 1`, [who[0]!.email])
    expect(rows[0], 'the send must still be recorded').toBeTruthy()
    expect(rows[0]!.error_message ?? '').toContain('switched this one off')
    // In-app was left on, so the portal row is there — "nothing is thrown away".
    const notices = await db.query(
      `SELECT 1 FROM tenant_notifications WHERE user_id = $1`, [userId])
    expect(notices.rows.length).toBe(1)
  })
})
