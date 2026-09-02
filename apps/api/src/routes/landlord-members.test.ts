/**
 * S553 — multi-owner landlord entities: membership CRUD, JWT-carried
 * landlordIds scope acceptance, and the aggregated portfolio list
 * (Oak Park case: one user sees their own entity AND the shared LLC).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_members'
})

interface Fx { userId: string; landlordId: string; propertyId: string; email: string }

async function seedEntity(name: string): Promise<Fx> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    await client.query(`UPDATE landlords SET business_name = $2 WHERE id = $1`, [landlordId, name])
    // founding membership (mirrors registration + migration backfill)
    await client.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT DO NOTHING`, [landlordId, userId])
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const r = await client.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])
    await client.query('COMMIT')
    return { userId, landlordId, propertyId, email: r.rows[0].email }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const tokenFor = (fx: Fx, landlordIds?: string[]) =>
  jwt.sign(
    { userId: fx.userId, role: 'landlord', email: fx.email, profileId: fx.landlordId, landlordIds: landlordIds ?? [fx.landlordId], permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })

describe('landlord members CRUD', () => {
  it('add by email, list shows both, founding member is flagged and irremovable', async () => {
    const oakPark = await seedEntity('Oak Park LLC')
    const friend = await seedEntity('Friend WY Holdings')

    const app = buildApp()
    // founding owner adds the friend by email
    const add = await request(app)
      .post('/api/landlords/members')
      .set('Authorization', `Bearer ${tokenFor(oakPark)}`)
      .send({ email: friend.email })
    expect(add.status).toBe(201)

    const list = await request(app)
      .get('/api/landlords/members')
      .set('Authorization', `Bearer ${tokenFor(oakPark)}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(2)
    const founding = list.body.data.find((m: any) => m.is_founding)
    const added = list.body.data.find((m: any) => !m.is_founding)
    expect(founding.user_id).toBe(oakPark.userId)
    expect(added.user_id).toBe(friend.userId)

    // founding member cannot be removed
    const rmFounding = await request(app)
      .delete(`/api/landlords/members/${founding.id}`)
      .set('Authorization', `Bearer ${tokenFor(oakPark)}`)
    expect(rmFounding.status).toBe(400)

    // the added member can be removed
    const rmAdded = await request(app)
      .delete(`/api/landlords/members/${added.id}`)
      .set('Authorization', `Bearer ${tokenFor(oakPark)}`)
    expect(rmAdded.status).toBe(200)
  })

  // S592: a co-owner with no upline of their own is captured as the founder's
  // downline (dormant until they later go solo); an existing upline is untouched.
  it('adding a co-owner sets their person-upline to the founder (first-touch wins)', async () => {
    const oakPark = await seedEntity('Oak Park LLC')
    const friend = await seedEntity('Friend WY Holdings')       // organic — no upline
    const priorUpline = await seedEntity('Prior Upline Co')
    const alreadyReferred = await seedEntity('Already Referred Co')
    // alreadyReferred already has an upline → first-touch must leave it alone
    await db.query(`UPDATE users SET referred_by_user_id=$1 WHERE id=$2`, [priorUpline.userId, alreadyReferred.userId])

    const app = buildApp()
    const a1 = await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${tokenFor(oakPark)}`).send({ email: friend.email })
    expect(a1.status).toBe(201)
    const a2 = await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${tokenFor(oakPark)}`).send({ email: alreadyReferred.email })
    expect(a2.status).toBe(201)

    // friend (no prior upline) → captured under Oak Park's founder
    const f = await db.query<{ referred_by_user_id: string }>(`SELECT referred_by_user_id FROM users WHERE id=$1`, [friend.userId])
    expect(f.rows[0].referred_by_user_id).toBe(oakPark.userId)
    // alreadyReferred keeps their prior upline
    const a = await db.query<{ referred_by_user_id: string }>(`SELECT referred_by_user_id FROM users WHERE id=$1`, [alreadyReferred.userId])
    expect(a.rows[0].referred_by_user_id).toBe(priorUpline.userId)
  })

  it('invites unknown emails and rejects duplicate adds', async () => {
    const oakPark = await seedEntity('Oak Park LLC')
    const friend = await seedEntity('Friend WY Holdings')
    const app = buildApp()
    const t = tokenFor(oakPark)

    // S609: an unknown email is no longer a dead end. The route now SENDS AN
    // INVITE (202) instead of 404 — deliberate: requiring a co-owner to go and
    // register themselves first, with no invitation in hand, is how the
    // invitation quietly dies. The test name's "rejects unknown emails" no
    // longer describes the product; the duplicate-add half below still does.
    const missing = await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${t}`).send({ email: 'nobody@nowhere.dev' })
    expect(missing.status).toBe(202)
    expect(missing.body.data.invited).toBe(true)

    await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${t}`).send({ email: friend.email })
    const dup = await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${t}`).send({ email: friend.email })
    expect(dup.status).toBe(409)
  })

  it('dissolution-proofing: co-owners cannot remove each other — only the founder can (and anyone can leave)', async () => {
    const oakPark = await seedEntity('Oak Park LLC')
    const brother = await seedEntity('Brother Holdings')
    const friend = await seedEntity('Friend WY Holdings')
    const app = buildApp()
    const founderToken = tokenFor(oakPark)

    // founder adds both co-owners
    for (const co of [brother, friend]) {
      await request(app).post('/api/landlords/members')
        .set('Authorization', `Bearer ${founderToken}`).send({ email: co.email })
    }
    const list = await request(app).get('/api/landlords/members')
      .set('Authorization', `Bearer ${founderToken}`)
    const brotherRow = list.body.data.find((m: any) => m.user_id === brother.userId)
    const friendRow = list.body.data.find((m: any) => m.user_id === friend.userId)

    // a co-owner's JWT includes the shared entity (as login would mint it)
    const brotherToken = tokenFor(brother, [brother.landlordId, oakPark.landlordId])

    // RETALIATION BLOCKED: brother (non-founding) cannot remove friend
    const retaliate = await request(app)
      .delete(`/api/landlords/members/${friendRow.id}`)
      .set('Authorization', `Bearer ${brotherToken}`)
    expect(retaliate.status).toBe(403)

    // WALK AWAY ALLOWED: brother can remove himself
    const leave = await request(app)
      .delete(`/api/landlords/members/${brotherRow.id}`)
      .set('Authorization', `Bearer ${brotherToken}`)
    expect(leave.status).toBe(200)

    // FOUNDER CAN REMOVE: founder removes friend
    const founderRemoves = await request(app)
      .delete(`/api/landlords/members/${friendRow.id}`)
      .set('Authorization', `Bearer ${founderToken}`)
    expect(founderRemoves.status).toBe(200)

    // audit journal captured the deletes (trigger)
    const audits = await db.query(
      `SELECT count(*)::int AS n FROM audit_row_changes WHERE table_name = 'landlord_members'`)
    expect(Number(audits.rows[0].n)).toBeGreaterThanOrEqual(2)
  })

  it('a non-member landlord cannot list or add members of another entity', async () => {
    const oakPark = await seedEntity('Oak Park LLC')
    const stranger = await seedEntity('Stranger Props')
    const app = buildApp()
    const res = await request(app)
      .get(`/api/landlords/members?landlordId=${oakPark.landlordId}`)
      .set('Authorization', `Bearer ${tokenFor(stranger)}`)
    expect(res.status).toBe(403)
  })
})

describe('aggregated portfolio (the Oak Park case)', () => {
  it('a member sees the shared entity’s properties NEXT TO their own — a stranger sees neither', async () => {
    const nic = await seedEntity('Nic AZ Holdings')
    const oakPark = await seedEntity('Oak Park LLC')
    const stranger = await seedEntity('Stranger Props')
    const app = buildApp()

    // nic is an owner-member of Oak Park (as the login flow would resolve)
    await db.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [oakPark.landlordId, nic.userId])

    // JWT as login now mints it: memberships resolved into landlordIds
    const nicToken = tokenFor(nic, [nic.landlordId, oakPark.landlordId])
    const list = await request(app)
      .get('/api/properties')
      .set('Authorization', `Bearer ${nicToken}`)
    expect(list.status).toBe(200)
    const landlordIds = list.body.data.map((p: any) => p.landlord_id).sort()
    expect(landlordIds).toEqual([nic.landlordId, oakPark.landlordId].sort())
    // entity badge data present
    const shared = list.body.data.find((p: any) => p.landlord_id === oakPark.landlordId)
    expect(shared.entity_name).toBe('Oak Park LLC')

    // the stranger sees only their own
    const strangerList = await request(app)
      .get('/api/properties')
      .set('Authorization', `Bearer ${tokenFor(stranger)}`)
    expect(strangerList.body.data).toHaveLength(1)
    expect(strangerList.body.data[0].landlord_id).toBe(stranger.landlordId)

    // membership also unlocks the shared entity's scoped reads (dashboard)
    const dash = await request(app)
      .get(`/api/landlords/${oakPark.landlordId}/dashboard`)
      .set('Authorization', `Bearer ${nicToken}`)
    expect(dash.status).toBe(200)
    const dashDenied = await request(app)
      .get(`/api/landlords/${oakPark.landlordId}/dashboard`)
      .set('Authorization', `Bearer ${tokenFor(stranger)}`)
    expect(dashDenied.status).toBe(403)
  })
})

// S631 (Nic): "What happened to my other partner Blu that was a co-owner of Oak
// Park? He seems to have disappeared from the list." Nobody could answer,
// because removal was a hard DELETE with no record — and the removal that
// actually happened bypassed the app entirely, so app-level logging would have
// missed it too. The history is written by a DATABASE trigger for that reason.
describe('S631 membership history', () => {
  it('records an add and a removal, including one made straight in the database', async () => {
    const client = await getClient()
    let landlordId: string, coOwnerUserId: string
    try {
      const { landlordId: lid } = await seedLandlord(client)
      landlordId = lid
      const co = await seedLandlord(client)
      coOwnerUserId = co.userId
    } finally { client.release() }

    // A direct write — exactly the shape that erased Blu with no trace.
    await db.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')`,
      [landlordId!, coOwnerUserId!])
    await db.query(
      `DELETE FROM landlord_members WHERE landlord_id=$1 AND user_id=$2`,
      [landlordId!, coOwnerUserId!])

    const h = await db.query<{ action: string }>(
      `SELECT action FROM landlord_member_history
        WHERE landlord_id=$1 AND user_id=$2 ORDER BY occurred_at, action DESC`,
      [landlordId!, coOwnerUserId!])
    expect(h.rows.map(r => r.action)).toEqual(['added', 'removed'])
  })
})
