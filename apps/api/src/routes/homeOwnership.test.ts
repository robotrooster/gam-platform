// S568: home-ownership tracking — who owns a tenant-owned home (the sublessor),
// transfers (retained as history), external-investor accounts, portfolio view.
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit } from '../test/dbHelpers'
import { homeOwnershipRouter } from './homeOwnership'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/home-ownerships', homeOwnershipRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_homeowner'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: llUser, landlordId } = await seedLandlord(c)
    const t1 = await seedTenant(c); const t2 = await seedTenant(c)
    const u1 = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [t1])).rows[0].user_id
    const u2 = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [t2])).rows[0].user_id
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query('COMMIT')
    const token = jwt.sign({ userId: llUser, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, unitId, u1, u2, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('home-ownership', () => {
  it('assigns an owner by userId and marks the unit tenant-owned', async () => {
    const f = await seed()
    const res = await request(buildApp()).put(`/api/home-ownerships/unit/${f.unitId}`)
      .set('Authorization', `Bearer ${f.token}`).send({ ownerUserId: f.u1, acquiredVia: 'recorded' })
    expect(res.status).toBe(200)
    const get = await request(buildApp()).get(`/api/home-ownerships/unit/${f.unitId}`).set('Authorization', `Bearer ${f.token}`)
    expect(get.body.data.owner.owner_user_id).toBe(f.u1)
    const unit = await db.query<any>(`SELECT dwelling_ownership FROM units WHERE id=$1`, [f.unitId])
    expect(unit.rows[0].dwelling_ownership).toBe('tenant')
  })

  it('transferring owner retains the prior owner as history (one active per unit)', async () => {
    const f = await seed()
    const put = (uid: string, via: string) => request(buildApp()).put(`/api/home-ownerships/unit/${f.unitId}`)
      .set('Authorization', `Bearer ${f.token}`).send({ ownerUserId: uid, acquiredVia: via })
    await put(f.u1, 'recorded').expect(200)
    await put(f.u2, 'sale').expect(200)   // sale from u1 → u2
    const active = await db.query<any>(`SELECT owner_user_id FROM home_ownerships WHERE unit_id=$1 AND status='active'`, [f.unitId])
    expect(active.rows).toHaveLength(1)
    expect(active.rows[0].owner_user_id).toBe(f.u2)
    const history = await db.query<any>(`SELECT status FROM home_ownerships WHERE unit_id=$1 ORDER BY acquired_at`, [f.unitId])
    expect(history.rows.map(r => r.status)).toEqual(['transferred', 'active'])   // prior kept
  })

  it('assigns an EXTERNAL investor by name+email, minting a contact account', async () => {
    const f = await seed()
    const email = `investor-${Math.floor(performance.now())}@ext.dev`
    const res = await request(buildApp()).put(`/api/home-ownerships/unit/${f.unitId}`)
      .set('Authorization', `Bearer ${f.token}`).send({ ownerName: 'Ivy Investor', ownerEmail: email, acquiredVia: 'recorded' })
    expect(res.status).toBe(200)
    expect(res.body.data.mintedAccount).toBe(true)
    const acct = await db.query<any>(`SELECT role FROM users WHERE LOWER(email)=$1`, [email])
    expect(acct.rows[0].role).toBe('contact')
    // Portfolio: the investor now owns this home.
    const port = await request(buildApp()).get(`/api/home-ownerships/portfolio/${res.body.data.ownerUserId}`).set('Authorization', `Bearer ${f.token}`)
    expect(port.body.data).toHaveLength(1)
    expect(port.body.data[0].unit_id).toBe(f.unitId)
  })

  it('re-assigning the SAME owner is a no-op (no duplicate history)', async () => {
    const f = await seed()
    const put = () => request(buildApp()).put(`/api/home-ownerships/unit/${f.unitId}`)
      .set('Authorization', `Bearer ${f.token}`).send({ ownerUserId: f.u1 })
    await put().expect(200)
    await put().expect(200)
    const rows = await db.query<any>(`SELECT COUNT(*)::int AS n FROM home_ownerships WHERE unit_id=$1`, [f.unitId])
    expect(rows.rows[0].n).toBe(1)
  })
})
