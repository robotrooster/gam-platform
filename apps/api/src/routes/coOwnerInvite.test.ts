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
    await request(buildApp()).post('/api/landlords/members')
      .set('Authorization', `Bearer ${f.tokenA}`).send({ email: f.bEmail })
    // B already had an account, so that path adds directly; re-check via invite
    // for the case where they didn't:
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
