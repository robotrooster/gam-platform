/**
 * 10/5 (Nic): a property's office email is where its residents' replies go.
 * Set on its own, cleared with blank, checked, and only by whoever may edit
 * the property.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

const app = () => { const a = express(); a.use(express.json()); a.use('/api/properties', propertiesRouter); a.use(errorHandler); return a }
beforeEach(async () => { await cleanupAllSchema(); process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_office_email' })

async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const token = jwt.sign({ userId, role: 'landlord', profileId: null, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { propertyId, token }
  } finally { c.release() }
}
const save = (f: { propertyId: string; token: string }, officeEmail: any) =>
  request(app()).patch(`/api/properties/${f.propertyId}/office-email`).set('Authorization', `Bearer ${f.token}`).send({ officeEmail })
const stored = async (id: string) => (await db.query(`SELECT office_email FROM properties WHERE id=$1`, [id])).rows[0].office_email

describe('a property\\u2019s office email', () => {
  it('saves trimmed and lowercased, and blank clears it', async () => {
    const f = await seed()
    const r = await save(f, '  Front.Desk@MyPark.com ')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.officeEmail).toBe('front.desk@mypark.com')
    expect(await stored(f.propertyId)).toBe('front.desk@mypark.com')
    expect((await save(f, '')).status).toBe(200)
    expect(await stored(f.propertyId)).toBeNull()
  })

  it('refuses a malformed address, a non-text value, and another company\\u2019s property', async () => {
    const f = await seed()
    expect((await save(f, 'not an email')).status).toBe(400)
    expect((await save(f, 42)).status).toBe(400)
    const g = await seed()
    expect((await save({ propertyId: g.propertyId, token: f.token }, 'x@y.com')).status).toBe(403)
    expect(await stored(g.propertyId)).toBeNull()
  })
})
