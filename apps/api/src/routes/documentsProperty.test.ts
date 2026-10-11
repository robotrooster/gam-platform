/**
 * S641 (Nic) — the filing cabinet.
 *
 *   "If you have a specific rule about trash or notices about stuff specific to
 *    the property, you don't want that at the landlord level accidentally
 *    getting sent to a property that doesn't pertain to them… maybe you have
 *    assigned parking spots in one place and that gets sent to a property that
 *    doesn't have that, and then it's just generating confusion."
 *
 *   "If I have parking rules at two of my properties and not a third, I don't
 *    wanna have to upload it two times."
 *
 * A document could be tagged to a unit, a tenant or a lease — never to a
 * property. So park rules and trash notices had nowhere to live.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { documentsRouter } from './documents'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/documents', documentsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_docs_property'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const b = await seedLandlord(c)
    const mk = async (landlordId: string, ownerUserId: string, name: string) => {
      const id = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      await c.query(`UPDATE properties SET name=$2 WHERE id=$1`, [id, name])
      return id
    }
    const parkA = await mk(a.landlordId, a.userId, 'Mountain View')
    const parkB = await mk(a.landlordId, a.userId, 'Oak Park')
    const parkC = await mk(a.landlordId, a.userId, 'Country Acres')
    const foreign = await mk(b.landlordId, b.userId, 'Somebody Else')

    const doc = async (name: string, type: string) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO documents (landlord_id, type, name, url, is_reference)
         VALUES ($1,$2,$3,'/uploads/docs/x.pdf',TRUE) RETURNING id`, [a.landlordId, type, name])
      return r.rows[0].id
    }
    const parking = await doc('Assigned Parking Rules', 'park_rules')
    const leadPaint = await doc('Lead Paint Disclosure', 'disclosure')
    await c.query('COMMIT')

    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { a, b, parkA, parkB, parkC, foreign, parking, leadPaint,
             tokenA: sign(a.userId, a.landlordId), tokenB: sign(b.userId, b.landlordId) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const pin = (app: any, token: string, docId: string, ids: string[]) =>
  request(app).put(`/api/documents/${docId}/properties`)
    .set('Authorization', `Bearer ${token}`).send({ propertyIds: ids })

describe('pinning a document to the properties it applies to', () => {
  it('pins to two parks and leaves the third alone', async () => {
    const f = await seed()
    const app = buildApp()
    await pin(app, f.tokenA, f.parking, [f.parkA, f.parkB]).expect(200)

    const at = async (propertyId: string) => {
      const r = await request(app).get(`/api/documents?propertyId=${propertyId}`)
        .set('Authorization', `Bearer ${f.tokenA}`)
      return (r.body.data as any[]).map(d => d.name)
    }
    expect(await at(f.parkA)).toContain('Assigned Parking Rules')
    expect(await at(f.parkB)).toContain('Assigned Parking Rules')
    expect(await at(f.parkC)).not.toContain('Assigned Parking Rules')
  })

  // No pins = available everywhere. A state disclosure should not need pinning
  // to every park the landlord will ever buy.
  it('an unpinned document shows at every property', async () => {
    const f = await seed()
    const app = buildApp()
    for (const p of [f.parkA, f.parkB, f.parkC]) {
      const r = await request(app).get(`/api/documents?propertyId=${p}`)
        .set('Authorization', `Bearer ${f.tokenA}`)
      expect((r.body.data as any[]).map(d => d.name)).toContain('Lead Paint Disclosure')
    }
  })

  it('repinning replaces the set rather than adding to it', async () => {
    const f = await seed()
    const app = buildApp()
    await pin(app, f.tokenA, f.parking, [f.parkA, f.parkB]).expect(200)
    await pin(app, f.tokenA, f.parking, [f.parkC]).expect(200)

    const r = await request(app).get(`/api/documents/${f.parking}/properties`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(r.body.data).toEqual([f.parkC])
  })

  it('unpinning entirely puts it back everywhere', async () => {
    const f = await seed()
    const app = buildApp()
    await pin(app, f.tokenA, f.parking, [f.parkA]).expect(200)
    await pin(app, f.tokenA, f.parking, []).expect(200)
    const r = await request(app).get(`/api/documents?propertyId=${f.parkC}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect((r.body.data as any[]).map(d => d.name)).toContain('Assigned Parking Rules')
  })

  it('cannot pin to a property somebody else owns', async () => {
    const f = await seed()
    const res = await pin(buildApp(), f.tokenA, f.parking, [f.foreign])
    expect(res.status).toBe(403)
  })

  it('cannot repin a document somebody else owns', async () => {
    const f = await seed()
    const res = await pin(buildApp(), f.tokenB, f.parking, [f.parkA])
    expect(res.status).toBe(404)
  })

  it('the unfiltered list still shows everything', async () => {
    const f = await seed()
    const app = buildApp()
    await pin(app, f.tokenA, f.parking, [f.parkA]).expect(200)
    const r = await request(app).get('/api/documents').set('Authorization', `Bearer ${f.tokenA}`)
    const names = (r.body.data as any[]).map(d => d.name)
    expect(names).toContain('Assigned Parking Rules')
    expect(names).toContain('Lead Paint Disclosure')
  })
})

// S654 (Nic, DIRECTIVE): no default company. An upload with no unit names its
// company through its pins when they all sit under one company; pins across
// companies (or none) must name it, and a two-company account is asked.
describe('S654: which company an untagged upload is filed under', () => {
  async function twoCompanies() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const a = await seedLandlord(c)
      const b = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [a.userId])
      const llB = b.rows[0].id
      const propA = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
      const propB1 = await seedProperty(c, { landlordId: llB, ownerUserId: a.userId, managedByUserId: a.userId })
      const propB2 = await seedProperty(c, { landlordId: llB, ownerUserId: a.userId, managedByUserId: a.userId })
      await c.query('COMMIT')
      const token = jwt.sign({ userId: a.userId, role: 'landlord', email: 'two@t.dev', profileId: null, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
      return { llA: a.landlordId, llB, propA, propB1, propB2, token }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const upload = (token: string, fields: Record<string, string>) => {
    let r = request(buildApp()).post('/api/documents').set('Authorization', `Bearer ${token}`)
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v)
    return r.attach('file', Buffer.from('%PDF-1.4 rules'), { filename: 'rules.pdf', contentType: 'application/pdf' })
  }

  it('pins all under one company file there without asking', async () => {
    const f = await twoCompanies()
    const res = await upload(f.token, { name: 'B rules', type: 'other', propertyIds: JSON.stringify([f.propB1, f.propB2]) })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.landlord_id).toBe(f.llB)
  })

  it('pins across two companies are asked, then filed where named', async () => {
    const f = await twoCompanies()
    const ask = await upload(f.token, { name: 'Mixed', type: 'other', propertyIds: JSON.stringify([f.propA, f.propB1]) })
    expect(ask.status).toBe(400)
    expect(String(ask.body?.error)).toMatch(/more than one company/i)
    const named = await upload(f.token, { name: 'Mixed', type: 'other', landlordId: f.llA,
      propertyIds: JSON.stringify([f.propA, f.propB1]) })
    expect(named.status, JSON.stringify(named.body)).toBe(201)
    expect(named.body.data.landlord_id).toBe(f.llA)
  })

  it('no pins and no company is asked; a company the account does not own is refused', async () => {
    const f = await twoCompanies()
    const ask = await upload(f.token, { name: 'Everywhere', type: 'other' })
    expect(ask.status).toBe(400)
    const c = await db.connect()
    let foreignLl = ''
    try { foreignLl = (await seedLandlord(c)).landlordId } finally { c.release() }
    const foreign = await upload(f.token, { name: 'Everywhere', type: 'other', landlordId: foreignLl })
    expect(foreign.status).toBe(403)
    const ok = await upload(f.token, { name: 'Everywhere', type: 'other', landlordId: f.llB })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.data.landlord_id).toBe(f.llB)
  })
})
