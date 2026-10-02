/**
 * S553 — multi-owner landlord entities: membership CRUD, JWT-carried
 * landlordIds scope acceptance, and the aggregated portfolio list
 * (Oak Park case: one user sees their own entity AND the shared LLC).
 *
 * S654 — adding an owner is always an invitation the person accepts from
 * their own session. Landlord B used to post landlord A's owner's address and
 * get a direct add: A's company joined B's account and A's owner became B's
 * commission downline, with no say from anybody at A.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailCoOwnerInviteMock } = vi.hoisted(() => ({
  emailCoOwnerInviteMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailLandlordCoOwnerInvitation: emailCoOwnerInviteMock,
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { processCommissionAccrual } from '../jobs/commissionAccrual'
import { _clearMembershipCache } from '../middleware/auth'
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
  emailCoOwnerInviteMock.mockClear()
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

/** The live invitation `owner`'s company holds for `email`, if any. */
const pendingInvite = async (company: Fx, email: string) => (await db.query<{ token: string; email: string }>(
  `SELECT token, email FROM landlord_member_invitations
    WHERE landlord_id = $1 AND lower(email) = lower($2) AND status = 'pending'`,
  [company.landlordId, email])).rows[0]

/**
 * S654: how an owner joins now. The company invites them; they accept from
 * their own session.
 */
async function addOwner(app: express.Express, company: Fx, co: Fx) {
  const add = await request(app).post('/api/landlords/members')
    .set('Authorization', `Bearer ${tokenFor(company)}`).send({ email: co.email })
  expect(add.status).toBe(202)
  const inv = await pendingInvite(company, co.email)
  const accept = await request(app).post(`/api/landlords/member-invite/${inv.token}/accept`)
    .set('Authorization', `Bearer ${tokenFor(co)}`)
  expect(accept.status).toBe(200)
  // Accepting asks them to sign in again; the session's company list is
  // cached for 15 seconds, which a real re-login outlasts.
  _clearMembershipCache()
}

describe('landlord members CRUD', () => {
  it('add by email, list shows both, founding member is flagged and irremovable', async () => {
    const oakPark = await seedEntity('Oak Park LLC')
    const friend = await seedEntity('Friend WY Holdings')

    const app = buildApp()
    // founding owner invites the friend by email; the friend accepts (S654)
    await addOwner(app, oakPark, friend)

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

  // S592 kept, at the point of consent (S654, Nic: "I added them as a co-owner…
  // therefore I am the referrer"): a co-owner who ACCEPTS becomes the founding
  // owner's downline if they have no upline yet; an existing upline never changes.
  it('a co-owner who accepts becomes the founding owner\'s downline; an existing upline is kept', async () => {
    const oakPark = await seedEntity('Oak Park LLC')
    const friend = await seedEntity('Friend WY Holdings')       // organic, no upline
    const priorUpline = await seedEntity('Prior Upline Co')
    const alreadyReferred = await seedEntity('Already Referred Co')
    await db.query(`UPDATE users SET referred_by_user_id=$1 WHERE id=$2`, [priorUpline.userId, alreadyReferred.userId])

    const app = buildApp()
    await addOwner(app, oakPark, friend)
    await addOwner(app, oakPark, alreadyReferred)

    const up = async (id: string) => (await db.query<{ referred_by_user_id: string | null }>(
      `SELECT referred_by_user_id FROM users WHERE id=$1`, [id])).rows[0].referred_by_user_id
    expect(await up(friend.userId)).toBe(oakPark.userId)
    expect(await up(alreadyReferred.userId)).toBe(priorUpline.userId)
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

    // S654: a second add while the first is still waiting refreshes that one
    // invitation; once they are an owner, adding them again is a 409.
    await addOwner(app, oakPark, friend)
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

    // founder invites both co-owners and each accepts (S654)
    for (const co of [brother, friend]) await addOwner(app, oakPark, co)
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

// ── S654: nobody attaches another company's person without their consent ──
//
// Reproduced in round 8: landlord B posted A's owner's address and got 201.
// account_companies(B) then held A's company, A's owner's referral upline
// became B's owner, and the commission run wrote the closing accrual on A's
// company to B.
describe("S654: POST /members on another company's owner", () => {
  it("B adding A's owner is an invitation only; nothing changes until A's owner accepts from their own session", async () => {
    const a = await seedEntity('A Holdings')
    const b = await seedEntity('B Holdings')
    // A has an occupied space, so the commission run has something to accrue on A.
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: a.propertyId, landlordId: a.landlordId })
      await c.query(`UPDATE units SET status = 'active' WHERE id = $1`, [unitId])
    } finally { c.release() }

    const app = buildApp()
    const res = await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${tokenFor(b)}`)
      .send({ email: a.email.toUpperCase() })
    expect(res.status).toBe(202)
    expect(res.body.data.invited).toBe(true)
    // The secret goes only by email, to the address on A's owner's account.
    const inv = await pendingInvite(b, a.email)
    expect(inv.email).toBe(a.email)
    expect(JSON.stringify(res.body)).not.toContain(inv.token)
    expect(emailCoOwnerInviteMock).toHaveBeenCalledTimes(1)
    expect(emailCoOwnerInviteMock.mock.calls[0]![0]).toBe(a.email)
    expect(emailCoOwnerInviteMock.mock.calls[0]![3]).toMatch(new RegExp(`/accept-owner-invite/${inv.token}$`))

    const companiesOf = async (userId: string) => (await db.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM landlord_members WHERE user_id = $1 ORDER BY landlord_id`, [userId]))
      .rows.map(r => r.landlord_id)
    const accountOf = async (landlordId: string) => (await db.query<{ id: string }>(
      `SELECT account_companies AS id FROM account_companies($1) ORDER BY 1`, [landlordId])).rows.map(r => r.id)
    const uplineOf = async (userId: string) => (await db.query<{ referred_by_user_id: string | null }>(
      `SELECT referred_by_user_id FROM users WHERE id = $1`, [userId])).rows[0].referred_by_user_id
    const accrualsTo = async (userId: string) => (await db.query(
      `SELECT landlord_id, role FROM commission_accruals WHERE manager_id = $1`, [userId])).rows

    expect(await companiesOf(a.userId)).toEqual([a.landlordId])
    expect(await accountOf(b.landlordId)).toEqual([b.landlordId])
    expect(await accountOf(a.landlordId)).toEqual([a.landlordId])
    expect(await uplineOf(a.userId)).toBeNull()
    await processCommissionAccrual()
    expect(await accrualsTo(b.userId)).toEqual([])

    // B can't accept it on A's owner's behalf.
    const forged = await request(app).post(`/api/landlords/member-invite/${inv.token}/accept`)
      .set('Authorization', `Bearer ${tokenFor(b)}`)
    expect(forged.status).toBe(403)
    expect(await companiesOf(a.userId)).toEqual([a.landlordId])

    // A's owner accepts from their own session: now, and only now, an owner of B.
    const ok = await request(app).post(`/api/landlords/member-invite/${inv.token}/accept`)
      .set('Authorization', `Bearer ${tokenFor(a)}`)
    expect(ok.status).toBe(200)
    expect(await companiesOf(a.userId)).toEqual([a.landlordId, b.landlordId].sort())
    const added = (await db.query<{ added_by_user_id: string | null }>(
      `SELECT added_by_user_id FROM landlord_members WHERE landlord_id = $1 AND user_id = $2`,
      [b.landlordId, a.userId])).rows[0]
    expect(added.added_by_user_id).toBe(b.userId)
    // Having accepted, A's owner is B's downline (S592 at the point of consent) —
    // the referral Nic wants, and it exists only because A said yes.
    expect(await uplineOf(a.userId)).toBe(b.userId)
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
