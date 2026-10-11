// S605 (Nic): co-owner invitations.
//
// Nic, on a three-member partnership: "it seems like kind of a backwards flow.
// I should be able to invite him through a link." And the constraint that makes
// it safe: "I'm wanting it to be where when he adds his property that we are not
// part of, the two are not co-mingled."
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailLandlordCoOwnerInvitation: vi.fn(async () => {}),
}))

import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { requireAuth } from '../middleware/auth'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => { await cleanupAllSchema() })
afterAll(async () => { await db.end() })

async function seedTwoLandlords() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)   // inviter (e.g. Oak Park)
    const b = await seedLandlord(c)   // partner, with his OWN entity
    await c.query(`UPDATE landlords SET business_name='Oak Park LLC' WHERE id=$1`, [a.landlordId])
    await c.query('COMMIT')
    const bEmail = await db.query<any>(`SELECT email FROM users WHERE id=$1`, [b.userId])
    return {
      a, b, bEmail: bEmail.rows[0].email,
      tokenA: sign({ userId: a.userId, role: 'landlord', email: 'a@t.dev', profileId: a.landlordId, permissions: {} }),
      tokenB: sign({ userId: b.userId, role: 'landlord', email: bEmail.rows[0].email, profileId: b.landlordId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('co-owner invitations', () => {
  it('an UNKNOWN email gets an invitation instead of a 404', async () => {
    const f = await seedTwoLandlords()
    const res = await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ email: 'brand-new-partner@mailer-test.co' })
    expect(res.status).toBe(202)          // invited, not rejected
    const { rows } = await db.query<any>(
      `SELECT status, landlord_id FROM landlord_member_invitations WHERE lower(email)=$1`,
      ['brand-new-partner@mailer-test.co'])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
    expect(rows[0].landlord_id).toBe(f.a.landlordId)
  })

  it('the preview is readable WITHOUT signing in', async () => {
    const f = await seedTwoLandlords()
    await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: 'partner@mailer-test.co' })
    const { rows } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)='partner@mailer-test.co'`)
    const res = await request(buildApp()).get(`/api/landlords/member-invite/${rows[0].token}`)
    expect(res.status).toBe(200)          // no Authorization header at all
    expect(res.body.data.entityName).toBe('Oak Park LLC')
  })

  it('accepting adds membership ALONGSIDE the invitee\'s own entity', async () => {
    const f = await seedTwoLandlords()
    const sent = await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: f.bEmail })
    // S654: an existing landlord gets an invitation too (never a direct add),
    // and accepts it from their own session.
    expect(sent.status).toBe(202)
    const { rows: inv } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)=lower($1)`, [f.bEmail])
    const acc = await request(buildApp()).post(`/api/landlords/member-invite/${inv[0].token}/accept`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(acc.status).toBe(200)
    const { rows: mem } = await db.query<any>(
      `SELECT landlord_id FROM landlord_members WHERE user_id=$1 ORDER BY created_at`, [f.b.userId])
    const ids = mem.map((r: any) => r.landlord_id)
    expect(ids).toContain(f.a.landlordId)   // co-owner of Oak Park

    // THE SEPARATION: B's own entity is untouched and still his alone.
    const { rows: aMem } = await db.query<any>(
      `SELECT landlord_id FROM landlord_members WHERE user_id=$1`, [f.a.userId])
    expect(aMem.map((r: any) => r.landlord_id)).not.toContain(f.b.landlordId)
  })

  it('a link-holder cannot accept with a different account', async () => {
    const f = await seedTwoLandlords()
    await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: 'someone-else@mailer-test.co' })
    const { rows } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)='someone-else@mailer-test.co'`)
    const res = await request(buildApp()).post(`/api/landlords/member-invite/${rows[0].token}/accept`)
      .set('Authorization', `Bearer ${f.tokenB}`)   // B is not the invitee
    expect(res.status).toBe(403)
  })

  it('re-inviting refreshes the invite rather than issuing a second token', async () => {
    const f = await seedTwoLandlords()
    const app = buildApp()
    await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: 'dup@mailer-test.co' })
    const first = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)='dup@mailer-test.co'`)
    await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: 'dup@mailer-test.co' })
    const { rows } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)='dup@mailer-test.co'`)
    expect(rows).toHaveLength(1)                      // still ONE live invite
    expect(rows[0].token).not.toBe(first.rows[0].token)
  })

  // S605 (Nic): "for him to just register, it would have tried to get him to
  // onboard his property, which is already onboarded because I've completed Oak
  // Park." An invited co-owner must not be dropped into a five-step wizard for
  // an entity that owns nothing.
  it('accepting clears the wizard for an invitee who owns nothing', async () => {
    const f = await seedTwoLandlords()
    await db.query(`UPDATE landlords SET onboarding_complete = FALSE WHERE id = $1`, [f.b.landlordId])
    await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: 'fresh@mailer-test.co' })
    const { rows } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)='fresh@mailer-test.co'`)
    await db.query(`UPDATE users SET email='fresh@mailer-test.co' WHERE id=$1`, [f.b.userId])
    const tokenB = sign({ userId: f.b.userId, role: 'landlord', email: 'fresh@mailer-test.co',
                          profileId: f.b.landlordId, permissions: {} })
    const res = await request(buildApp()).post(`/api/landlords/member-invite/${rows[0].token}/accept`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(res.status).toBe(200)
    const { rows: [l] } = await db.query<any>(
      `SELECT onboarding_complete FROM landlords WHERE id=$1`, [f.b.landlordId])
    expect(l.onboarding_complete).toBe(true)
  })

  // ...but it must never skip a REAL onboarding for someone who already has
  // property of their own to set up.
  it('does NOT clear the wizard for an invitee who already owns property', async () => {
    const f = await seedTwoLandlords()
    await db.query(`UPDATE landlords SET onboarding_complete = FALSE WHERE id = $1`, [f.b.landlordId])
    await db.query(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip, type,
                               owner_user_id, managed_by_user_id)
       VALUES ($1,'Theirs','1 A St','Phoenix','AZ','85001','mixed',$2,$2)`,
      [f.b.landlordId, f.b.userId])
    await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: 'owns@mailer-test.co' })
    const { rows } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)='owns@mailer-test.co'`)
    await db.query(`UPDATE users SET email='owns@mailer-test.co' WHERE id=$1`, [f.b.userId])
    const tokenB = sign({ userId: f.b.userId, role: 'landlord', email: 'owns@mailer-test.co',
                          profileId: f.b.landlordId, permissions: {} })
    await request(buildApp()).post(`/api/landlords/member-invite/${rows[0].token}/accept`)
      .set('Authorization', `Bearer ${tokenB}`)
    const { rows: [l] } = await db.query<any>(
      `SELECT onboarding_complete FROM landlords WHERE id=$1`, [f.b.landlordId])
    expect(l.onboarding_complete).toBe(false)   // their own setup still owed
  })
})

describe('S654 only an owner adds an owner', () => {
  it('a bookkeeper or manager of the company cannot invite an owner', async () => {
    const f = await seedTwoLandlords()
    for (const role of ['bookkeeper', 'property_manager', 'onsite_manager', 'maintenance']) {
      const team = sign({ userId: f.b.userId, role, email: 'staff@mailer-test.co', landlordId: f.a.landlordId, profileId: null, permissions: {} })
      const res = await request(buildApp()).post('/api/landlords/members')
        .set('Authorization', `Bearer ${team}`).send({ email: 'staffs-own-landlord@mailer-test.co', landlordId: f.a.landlordId })
      expect([401, 403]).toContain(res.status)
    }
    const { rows } = await db.query(`SELECT 1 FROM landlord_member_invitations WHERE lower(email)='staffs-own-landlord@mailer-test.co'`)
    expect(rows).toHaveLength(0)
  })
})

// S655: an invitation that was USED is not a bad link. Registering with the
// invited address and entering the emailed code accepts it, and the
// registration then lands on the invite page — which used to say "expired or
// already been used" to the person who now owns the company.
describe('S655 an accepted invitation reads as accepted, for the person who accepted it', () => {
  async function acceptedInvite() {
    const f = await seedTwoLandlords()
    await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: f.bEmail })
    const { rows: [inv] } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)=lower($1)`, [f.bEmail])
    const first = await request(buildApp()).post(`/api/landlords/member-invite/${inv.token}/accept`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(first.status).toBe(200)
    expect(first.body.data.alreadyAccepted).toBe(false)
    return { ...f, token: inv.token as string }
  }

  it('the preview of an accepted invitation says accepted instead of 404', async () => {
    const f = await acceptedInvite()
    const res = await request(buildApp()).get(`/api/landlords/member-invite/${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.accepted).toBe(true)
    expect(res.body.data.entityName).toBe('Oak Park LLC')
  })

  it('accepting again as the same person is a harmless yes', async () => {
    const f = await acceptedInvite()
    const again = await request(buildApp()).post(`/api/landlords/member-invite/${f.token}/accept`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(again.status).toBe(200)
    expect(again.body.data.alreadyAccepted).toBe(true)
    expect(again.body.data.landlordId).toBe(f.a.landlordId)
    const { rows } = await db.query(
      `SELECT 1 FROM landlord_members WHERE user_id=$1 AND landlord_id=$2`, [f.b.userId, f.a.landlordId])
    expect(rows).toHaveLength(1)
  })

  it('anyone else is still refused an accepted invitation', async () => {
    const f = await acceptedInvite()
    const res = await request(buildApp()).post(`/api/landlords/member-invite/${f.token}/accept`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('a revoked or expired invitation still previews as gone', async () => {
    const f = await seedTwoLandlords()
    await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: 'gone@mailer-test.co' })
    const { rows: [inv] } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)='gone@mailer-test.co'`)
    await db.query(`UPDATE landlord_member_invitations SET status='revoked' WHERE token=$1`, [inv.token])
    expect((await request(buildApp()).get(`/api/landlords/member-invite/${inv.token}`)).status).toBe(404)
    await db.query(`UPDATE landlord_member_invitations SET status='pending', expires_at = now() - interval '1 minute' WHERE token=$1`, [inv.token])
    expect((await request(buildApp()).get(`/api/landlords/member-invite/${inv.token}`)).status).toBe(404)
  })
})

// S655 review: what the accept screen promises has to be true on the very next
// click. The screen says "{company} is in your account now" and its button
// reloads the dashboard at once — but requireAuth keeps each account's company
// list for 15 seconds (S629), and the page load right before the accept filled
// it. A removed co-owner reopening the old email must not be told they own it.
describe('S655 accepting is true on the next request, and only while it is still true', () => {
  function appWithEcho() {
    const app = express()
    app.use(express.json())
    app.get('/echo', requireAuth, (req, res) => res.json({ landlordIds: req.user!.landlordIds }))
    app.use('/api/landlords', landlordsRouter)
    app.use(errorHandler)
    return app
  }

  it('the invited company is in the account on the very next request after accepting', async () => {
    const f = await seedTwoLandlords()
    const app = appWithEcho()
    // The dashboard was open before the accept — this fills the 15s cache.
    const before = await request(app).get('/echo').set('Authorization', `Bearer ${f.tokenB}`)
    expect(before.body.landlordIds).not.toContain(f.a.landlordId)

    await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: f.bEmail })
    const { rows: [inv] } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)=lower($1)`, [f.bEmail])
    const acc = await request(app).post(`/api/landlords/member-invite/${inv.token}/accept`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(acc.status).toBe(200)
    expect(acc.body.data.reloginRequired).toBe(false)

    // "Go to your dashboard", clicked straight away.
    const after = await request(app).get('/echo').set('Authorization', `Bearer ${f.tokenB}`)
    expect(after.body.landlordIds).toContain(f.a.landlordId)
    expect(after.body.landlordIds).toContain(f.b.landlordId)
  })

  it('a removed co-owner reopening the old link is not told they own the company', async () => {
    const f = await seedTwoLandlords()
    const app = appWithEcho()
    await request(app).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: f.bEmail })
    const { rows: [inv] } = await db.query<any>(
      `SELECT token FROM landlord_member_invitations WHERE lower(email)=lower($1)`, [f.bEmail])
    expect((await request(app).post(`/api/landlords/member-invite/${inv.token}/accept`)
      .set('Authorization', `Bearer ${f.tokenB}`)).status).toBe(200)

    // The founding owner removes them. The invitation stays marked accepted.
    const { rows: [m] } = await db.query<any>(
      `SELECT id FROM landlord_members WHERE landlord_id=$1 AND user_id=$2`, [f.a.landlordId, f.b.userId])
    const removed = await request(app).delete(`/api/landlords/members/${m.id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(removed.status).toBe(200)

    const preview = await request(app).get(`/api/landlords/member-invite/${inv.token}`)
    expect(preview.status).toBe(404)
    const again = await request(app).post(`/api/landlords/member-invite/${inv.token}/accept`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(again.status).toBe(404)
    expect(again.body.data?.alreadyAccepted).toBeUndefined()
    const { rows } = await db.query(
      `SELECT 1 FROM landlord_members WHERE user_id=$1 AND landlord_id=$2`, [f.b.userId, f.a.landlordId])
    expect(rows).toHaveLength(0)
  })
})
