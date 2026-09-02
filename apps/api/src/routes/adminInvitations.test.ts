/**
 * S631 — admin console invitations.
 *
 * The security properties worth pinning: only a super_admin can invite, an
 * address already on the platform is refused rather than promoted, and the
 * public accept route can only ever create the one address that was invited.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { adminRouter, adminInviteRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', adminRouter)
  app.use('/api/admin-invite', adminInviteRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_inv'
})

async function seedUser(email: string, role: string) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name)
     VALUES ($1, 'x', $2, 'Test', 'User') RETURNING id`, [email, role])
  return r.rows[0].id
}
const tok = (userId: string, role: string) => jwt.sign(
  { userId, role, email: 'x@t.dev', profileId: userId, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

describe('S631 admin invitations', () => {
  it('an admin cannot invite — only a super_admin can', async () => {
    const app = buildApp()
    const adminId = await seedUser('plain@gam.dev', 'admin')
    const res = await request(app).post('/api/admin/invitations')
      .set('Authorization', `Bearer ${tok(adminId, 'admin')}`)
      .send({ email: 'new@gam.dev', role: 'admin' })
    expect(res.status).toBe(403)
    const n = await db.query(`SELECT 1 FROM admin_invitations`)
    expect(n.rows).toHaveLength(0)
  })

  it('refuses an address that already belongs to a landlord instead of promoting it', async () => {
    const app = buildApp()
    const su = await seedUser('boss@gam.dev', 'super_admin')
    const client = await db.connect()
    let landlordEmail: string
    try {
      const { userId } = await seedLandlord(client)
      landlordEmail = (await client.query<{ email: string }>(
        `SELECT email FROM users WHERE id=$1`, [userId])).rows[0].email
    } finally { client.release() }

    const res = await request(app).post('/api/admin/invitations')
      .set('Authorization', `Bearer ${tok(su, 'super_admin')}`)
      .send({ email: landlordEmail!, role: 'admin' })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toMatch(/separate login/i)
  })

  it('accepting creates the invited address in the invited role, once', async () => {
    const app = buildApp()
    const su = await seedUser('boss2@gam.dev', 'super_admin')
    const sent = await request(app).post('/api/admin/invitations')
      .set('Authorization', `Bearer ${tok(su, 'super_admin')}`)
      .send({ email: 'newadmin@gam.dev', role: 'admin' })
    expect(sent.status).toBe(201)

    const token = (await db.query<{ token: string }>(
      `SELECT token FROM admin_invitations WHERE lower(email)='newadmin@gam.dev'`)).rows[0].token

    const ok = await request(app).post(`/api/admin-invite/${token}/accept`)
      .send({ firstName: 'New', lastName: 'Admin', password: 'a-long-enough-pw' })
    expect(ok.status).toBe(201)

    const u = await db.query<{ role: string }>(
      `SELECT role FROM users WHERE lower(email)='newadmin@gam.dev'`)
    expect(u.rows[0].role).toBe('admin')

    // Single use — the same link cannot mint a second account.
    const again = await request(app).post(`/api/admin-invite/${token}/accept`)
      .send({ firstName: 'Imposter', lastName: 'X', password: 'a-long-enough-pw' })
    expect(again.status).toBe(404)
  })

  it('a revoked invitation stops working', async () => {
    const app = buildApp()
    const su = await seedUser('boss3@gam.dev', 'super_admin')
    const sent = await request(app).post('/api/admin/invitations')
      .set('Authorization', `Bearer ${tok(su, 'super_admin')}`)
      // S631: 'admin', not 'super_admin' — only the platform owner can invite a
      // super admin now, and this test is about revocation, not role.
      .send({ email: 'revokeme@gam.dev', role: 'admin' })
    const id = sent.body.data.id
    const token = (await db.query<{ token: string }>(
      `SELECT token FROM admin_invitations WHERE id=$1`, [id])).rows[0].token

    await request(app).delete(`/api/admin/invitations/${id}`)
      .set('Authorization', `Bearer ${tok(su, 'super_admin')}`).expect(200)

    const res = await request(app).post(`/api/admin-invite/${token}/accept`)
      .send({ firstName: 'No', lastName: 'Way', password: 'a-long-enough-pw' })
    expect(res.status).toBe(404)
    const u = await db.query(`SELECT 1 FROM users WHERE lower(email)='revokeme@gam.dev'`)
    expect(u.rows).toHaveLength(0)
  })

  it('a short password is refused', async () => {
    const app = buildApp()
    const su = await seedUser('boss4@gam.dev', 'super_admin')
    await request(app).post('/api/admin/invitations')
      .set('Authorization', `Bearer ${tok(su, 'super_admin')}`)
      .send({ email: 'shortpw@gam.dev', role: 'admin' })
    const token = (await db.query<{ token: string }>(
      `SELECT token FROM admin_invitations WHERE lower(email)='shortpw@gam.dev'`)).rows[0].token
    const res = await request(app).post(`/api/admin-invite/${token}/accept`)
      .send({ firstName: 'A', lastName: 'B', password: 'short' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const u = await db.query(`SELECT 1 FROM users WHERE lower(email)='shortpw@gam.dev'`)
    expect(u.rows).toHaveLength(0)
  })
})

// S631 (Nic, DIRECTIVE): "My super admin account can never be removed by another
// super admin... never removed, never edited, never downgraded." And: "Super
// admins only be able to be added by me."
describe('S631 platform owner lock', () => {
  async function makeOwner(email: string) {
    const id = await seedUser(email, 'super_admin')
    // The pointer is immutable by trigger, so establish it the way the migration
    // does — on a table cleared between tests.
    await db.query(`DELETE FROM platform_owner`)
    await db.query(`INSERT INTO platform_owner (user_id, note) VALUES ($1,'test')`, [id])
    return id
  }

  it('the owner cannot be deleted or downgraded, even straight in the database', async () => {
    const ownerId = await makeOwner('owner@gam.dev')
    await expect(db.query(`DELETE FROM users WHERE id=$1`, [ownerId]))
      .rejects.toThrow(/cannot be deleted/i)
    await expect(db.query(`UPDATE users SET role='admin' WHERE id=$1`, [ownerId]))
      .rejects.toThrow(/role cannot be changed/i)
    // Repointing ownership is the two-step way round the above; it is refused too.
    const other = await seedUser('other@gam.dev', 'super_admin')
    await expect(db.query(`UPDATE platform_owner SET user_id=$1`, [other]))
      .rejects.toThrow(/cannot be changed here/i)
    const still = await db.query<{ role: string }>(`SELECT role FROM users WHERE id=$1`, [ownerId])
    expect(still.rows[0].role).toBe('super_admin')
  })

  it('the owner can still change their own email and name', async () => {
    const ownerId = await makeOwner('owner2@gam.dev')
    await db.query(`UPDATE users SET email='moved@gam.dev', first_name='Nick' WHERE id=$1`, [ownerId])
    const u = await db.query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [ownerId])
    expect(u.rows[0].email).toBe('moved@gam.dev')
  })

  it('a non-owner super_admin can invite an admin but NOT a super_admin', async () => {
    const app = buildApp()
    await makeOwner('owner3@gam.dev')
    const other = await seedUser('deputy@gam.dev', 'super_admin')

    const refused = await request(app).post('/api/admin/invitations')
      .set('Authorization', `Bearer ${tok(other, 'super_admin')}`)
      .send({ email: 'wannabe@gam.dev', role: 'super_admin' })
    expect(refused.status).toBe(403)
    expect(String(refused.body.error)).toMatch(/only the platform owner/i)

    const allowed = await request(app).post('/api/admin/invitations')
      .set('Authorization', `Bearer ${tok(other, 'super_admin')}`)
      .send({ email: 'staffer@gam.dev', role: 'admin' })
    expect(allowed.status).toBe(201)
  })

  it('the owner can invite a super_admin', async () => {
    const app = buildApp()
    const ownerId = await makeOwner('owner4@gam.dev')
    const res = await request(app).post('/api/admin/invitations')
      .set('Authorization', `Bearer ${tok(ownerId, 'super_admin')}`)
      .send({ email: 'copilot@gam.dev', role: 'super_admin' })
    expect(res.status).toBe(201)
  })

  it('team-capabilities tells each viewer only about themselves', async () => {
    const app = buildApp()
    const ownerId = await makeOwner('owner5@gam.dev')
    const other = await seedUser('deputy5@gam.dev', 'super_admin')
    const asOwner = await request(app).get('/api/admin/team-capabilities')
      .set('Authorization', `Bearer ${tok(ownerId, 'super_admin')}`)
    const asOther = await request(app).get('/api/admin/team-capabilities')
      .set('Authorization', `Bearer ${tok(other, 'super_admin')}`)
    expect(asOwner.body.data.canInviteSuperAdmin).toBe(true)
    expect(asOther.body.data.canInviteSuperAdmin).toBe(false)
    // Nothing in the payload names the owner.
    expect(JSON.stringify(asOther.body)).not.toMatch(/owner5@gam\.dev/)
  })
})
