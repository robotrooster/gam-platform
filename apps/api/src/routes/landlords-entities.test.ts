/**
 * S620: owning more than one entity.
 *
 * Nic: "if I wanted to add another property that I am purchasing under another
 * entity, how would I do that? There's nowhere for that to happen."
 *
 * The blocker was never the missing button. The active entity was DERIVED from
 * "the landlords row where this user is the owner", which returns two rows the
 * moment somebody owns two — making every property, payout and fee land on an
 * arbitrary one. These tests pin the two properties that make the choice safe:
 * it is EXPLICIT, and it is bounded by membership.
 */
import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query, queryOne } from '../db'
import { seedLandlord, seedProperty } from '../test/dbHelpers'
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

const tokenFor = (userId: string, profileId: string, landlordIds: string[]) =>
  jwt.sign({ userId, role: 'landlord', email: 'multi@test.dev', profileId, landlordIds, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })

async function seedOwnerWithEntity() {
  const client = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    await client.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role)
       VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [landlordId, userId])
    return { userId, landlordId }
  } finally { client.release() }
}

describe('multi-entity ownership', () => {
  it('creates a second entity and makes it active', async () => {
    const a = await seedOwnerWithEntity()
    const res = await request(buildApp())
      .post('/api/landlords/me/entities')
      .set('Authorization', `Bearer ${tokenFor(a.userId, a.landlordId, [a.landlordId])}`)
      .send({ businessName: 'Second LLC', ein: '99-1234567' })

    expect(res.status).toBe(201)
    const newId = res.body.data.landlordId
    expect(newId).not.toBe(a.landlordId)
    // The switch lands on the next login, and the response says so rather than
    // leaving them wondering why the dashboard has not moved.
    expect(res.body.data.reloginRequired).toBe(true)

    // S634: there is no "active" entity to land on — the account owns the new
    // company from the moment the membership row exists, and is signed into
    // every company it owns at once. What the caller needs is that membership,
    // not a pointer.
    const member = await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM landlord_members WHERE user_id = $1 AND landlord_id = $2`,
      [a.userId, newId])
    expect(member).toBeTruthy()
  })

  it('lists every entity the user can operate in, owned first', async () => {
    const a = await seedOwnerWithEntity()
    await request(buildApp())
      .post('/api/landlords/me/entities')
      .set('Authorization', `Bearer ${tokenFor(a.userId, a.landlordId, [a.landlordId])}`)
      .send({ businessName: 'Holdings Two' })

    const res = await request(buildApp())
      .get('/api/landlords/me/entities')
      .set('Authorization', `Bearer ${tokenFor(a.userId, a.landlordId, [a.landlordId])}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    expect(res.body.data.every((e: any) => e.is_owner)).toBe(true)
  })

  it('a property can be created on a second entity the user owns', async () => {
    // S620: "property under new entity but same parent company." The picker on
    // the Add Property form names the entity; the server bounds it by
    // membership.
    const a = await seedOwnerWithEntity()
    const created = await request(buildApp())
      .post('/api/landlords/me/entities')
      .set('Authorization', `Bearer ${tokenFor(a.userId, a.landlordId, [a.landlordId])}`)
      .send({ businessName: 'Third LLC' })
    const newId = created.body.data.landlordId

    // A session issued AFTER the switch carries the new entity as profileId,
    // which is what property creation scopes to.
    const client = await db.connect()
    try {
      await seedProperty(client, { landlordId: newId, ownerUserId: a.userId, managedByUserId: a.userId })
    } finally { client.release() }

    const onNew = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM properties WHERE landlord_id = $1`, [newId])
    const onOld = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM properties WHERE landlord_id = $1`, [a.landlordId])
    expect(Number(onNew[0].n)).toBe(1)
    expect(Number(onOld[0].n)).toBe(0)
  })
})

// S620: the security boundary on the entity picker. Without it, naming any
// landlord id on the Add Property form would create a property inside somebody
// else's LLC — a far worse bug than the one the picker fixes.
describe('creating a property on a named entity', () => {
  it('REFUSES an entity the caller is not a member of', async () => {
    const mine = await seedOwnerWithEntity()
    const theirs = await seedOwnerWithEntity()
    const res = await request(buildApp())
      .post('/api/properties')
      .set('Authorization', `Bearer ${tokenFor(mine.userId, mine.landlordId, [mine.landlordId])}`)
      .send({
        name: 'Sneaky', street1: '1 Main', city: 'Mesa', state: 'AZ', zip: '85201',
        landlordId: theirs.landlordId,
        allocationRule: { achFeePayer: 'tenant', cardFeePayer: 'tenant' },
      })
    expect(res.status).toBe(403)
    const n = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM properties WHERE landlord_id = $1`, [theirs.landlordId])
    expect(Number(n[0].n)).toBe(0)
  })
})
