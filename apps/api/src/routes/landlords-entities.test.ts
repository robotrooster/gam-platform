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
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
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

    const u = await queryOne<{ active_landlord_id: string }>(
      `SELECT active_landlord_id FROM users WHERE id = $1`, [a.userId])
    expect(u!.active_landlord_id).toBe(newId)
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

  it('REFUSES to switch to an entity the user does not belong to', async () => {
    // The whole security property. A foreign key cannot express "an entity you
    // belong to", so without this check a session could be pointed at any
    // landlord on the platform and read their entire book.
    const mine = await seedOwnerWithEntity()
    const theirs = await seedOwnerWithEntity()
    const res = await request(buildApp())
      .post('/api/landlords/me/active-entity')
      .set('Authorization', `Bearer ${tokenFor(mine.userId, mine.landlordId, [mine.landlordId])}`)
      .send({ landlordId: theirs.landlordId })

    expect(res.status).toBe(403)
    const u = await queryOne<{ active_landlord_id: string | null }>(
      `SELECT active_landlord_id FROM users WHERE id = $1`, [mine.userId])
    expect(u!.active_landlord_id).not.toBe(theirs.landlordId)
  })

  it('switches to an entity the user co-owns', async () => {
    const mine = await seedOwnerWithEntity()
    const partners = await seedOwnerWithEntity()
    await query(
      `INSERT INTO landlord_members (landlord_id, user_id, role)
       VALUES ($1, $2, 'owner')`, [partners.landlordId, mine.userId])

    const res = await request(buildApp())
      .post('/api/landlords/me/active-entity')
      .set('Authorization', `Bearer ${tokenFor(mine.userId, mine.landlordId, [mine.landlordId, partners.landlordId])}`)
      .send({ landlordId: partners.landlordId })
    expect(res.status).toBe(200)
  })

  it('a new property lands on the ACTIVE entity, not the first one owned', async () => {
    // The failure this whole change exists to prevent: two owned entities and
    // a property landing on whichever the database returned first.
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
