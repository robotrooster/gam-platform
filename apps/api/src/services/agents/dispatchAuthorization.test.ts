/**
 * S628 — THE HALF OF THE DISPATCHER'S SAFETY STORY NOTHING WAS TESTING.
 *
 * The whole argument for calling real endpoints instead of writing 200 bespoke
 * tools is that the middleware runs for real: "Claims are the caller's own,
 * forwarded from routes/agent.ts. What it preserves is AUTHORIZATION —
 * requirePerm reads req.user.permissions, and without it a staff member's agent
 * is denied everything their portal allows."
 *
 * portalDispatch.test.ts proves the token carries the right claims. It stops
 * there, because its transport is a stub — no router, no middleware, nothing
 * that could actually say no. So the sentence above was an argument, not a
 * fact, and if forwarding ever broke the failure would be silent and total: a
 * maintenance worker's agent quietly able to change the business EIN.
 *
 * This drives the REAL router through the REAL middleware, with the transport
 * pointed at it, and checks that authority is preserved in BOTH directions —
 * the owner is allowed and the unprivileged staff member is not. One without
 * the other proves nothing: a dispatcher that refused everybody would pass a
 * refusal test and be useless.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { db } from '../../db'
import { cleanupAllSchema, seedLandlord } from '../../test/dbHelpers'
import { landlordsRouter } from '../../routes/landlords'
import { errorHandler } from '../../middleware/errorHandler'
import { dispatchPortalAction, __setTransport } from './portalDispatch'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

/** Routes the dispatcher's HTTP call into supertest instead of the network. */
function routeThrough(app: express.Express) {
  __setTransport(async (url, init) => {
    const path = new URL(url).pathname
    const req = (request(app) as any)[String(init.method).toLowerCase()](path)
      .set('Authorization', init.headers.Authorization)
      .set('Content-Type', 'application/json')
    const res = await (init.body ? req.send(JSON.parse(init.body)) : req)
    return { status: res.status, json: res.body }
  })
}

let landlordId = ''
let ownerUserId = ''

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_dispatch_authz'
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const seeded = await seedLandlord(c, { firstName: 'Dana', lastName: 'Okafor' })
    ownerUserId = seeded.userId
    landlordId = seeded.landlordId
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  routeThrough(buildApp())
})

afterAll(() => { __setTransport(null) })

const ownerActor = () => ({
  userId: ownerUserId, role: 'landlord', profileId: landlordId,
  // permissions: null is what an OWNER carries — owner roles bypass requirePerm.
  auth: { userId: ownerUserId, role: 'landlord', profileId: landlordId,
          landlordId, landlordIds: [landlordId], permissions: null },
})

/**
 * A team member on this landlord, holding exactly the permissions listed.
 *
 * `permissions` is a KEYED OBJECT and not an array — requirePerm reads
 * `perms[key] === true` (middleware/auth.ts:199). Writing it as an array made
 * the grant case fail with "Insufficient permissions", which is the same
 * message a genuine denial produces: a test asserting only the refusal would
 * have passed while proving nothing, because it cannot tell "correctly denied"
 * from "shape wrong, denies everybody".
 */
const staffActor = (keys: string[]) => ({
  userId: ownerUserId, role: 'landlord', profileId: landlordId,
  auth: {
    userId: ownerUserId, role: 'maintenance_worker', profileId: landlordId,
    landlordId, landlordIds: [landlordId],
    permissions: Object.fromEntries(keys.map((k) => [k, true])),
  },
})

describe('the dispatcher preserves authorization, both ways', () => {
  it('the OWNER can change their own business settings', async () => {
    const r = await dispatchPortalAction(
      'update_business_settings', { businessName: 'Okafor Holdings LLC' }, ownerActor() as any)
    expect(r.ok, `refused: ${r.error}`).toBe(true)
    const row = await db.query(`SELECT business_name FROM landlords WHERE id = $1`, [landlordId])
    expect(row.rows[0].business_name).toBe('Okafor Holdings LLC')
  })

  it('a staff member WITHOUT the permission is refused by the real middleware', async () => {
    // update_business_settings gates on settings.maintenance_approval. Somebody
    // holding only work-order permissions must not reach it through the agent
    // any more than through the portal.
    const r = await dispatchPortalAction(
      'update_business_settings', { businessName: 'Should Not Happen' },
      staffActor(['work_orders.complete', 'time.clock_in_out']) as any)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    const row = await db.query(`SELECT business_name FROM landlords WHERE id = $1`, [landlordId])
    expect(row.rows[0].business_name, 'the write must not have happened').not.toBe('Should Not Happen')
  })

  it('the same staff member WITH the permission is allowed', async () => {
    // The other direction, and the reason the refusal above means something. A
    // dispatcher that said no to everybody would pass the previous test and be
    // worthless.
    const r = await dispatchPortalAction(
      'update_business_settings', { businessName: 'Granted By Permission' },
      staffActor(['settings.maintenance_approval']) as any)
    expect(r.ok, `refused: ${r.error}`).toBe(true)
    const row = await db.query(`SELECT business_name FROM landlords WHERE id = $1`, [landlordId])
    expect(row.rows[0].business_name).toBe('Granted By Permission')
  })

  it('a refusal is reported as a refusal — never as done', async () => {
    const r = await dispatchPortalAction(
      'update_business_settings', { ein: '99-9999999' },
      staffActor([]) as any)
    expect(r.ok).toBe(false)
    // The agent is handed the API's own words, so it can say what happened
    // rather than inventing a reason or claiming success.
    expect(typeof r.error).toBe('string')
    expect(r.error!.length).toBeGreaterThan(0)
  })
})
