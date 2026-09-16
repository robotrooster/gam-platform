/**
 * S648 (Nic): "landlord can choose to absorb the processing cost... Landlord
 * chooses whether they pass through on the booking site or point of sale."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_card_fee_payers'
})

async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const token = jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { propertyId, token }
  } finally { c.release() }
}

const patch = (f: { propertyId: string; token: string }, body: any) =>
  request(buildApp()).patch(`/api/properties/${f.propertyId}/processing-fee-payers`)
    .set('Authorization', `Bearer ${f.token}`).send(body)

describe('who pays the card fee', () => {
  it('defaults to the customer on both, and each can be changed on its own', async () => {
    const f = await seed()
    const before = (await db.query(`SELECT register_card_fee_payer, booking_card_fee_payer FROM properties WHERE id = $1`, [f.propertyId])).rows[0]
    expect(before).toEqual({ register_card_fee_payer: 'customer', booking_card_fee_payer: 'customer' })
    const r1 = await patch(f, { register: 'landlord' })
    expect(r1.status).toBe(200)
    expect(r1.body.data).toMatchObject({ registerCardFeePayer: 'landlord', bookingCardFeePayer: 'customer' })
    const r2 = await patch(f, { booking: 'landlord' })
    expect(r2.body.data).toMatchObject({ registerCardFeePayer: 'landlord', bookingCardFeePayer: 'landlord' })
  })

  it('refuses anything else, and another landlord\'s property', async () => {
    const f = await seed()
    expect((await patch(f, { register: 'tenant' })).status).toBe(400)
    expect((await patch(f, {})).status).toBe(400)
    const g = await seed()
    expect((await patch({ propertyId: g.propertyId, token: f.token }, { register: 'landlord' })).status).toBe(403)
  })
})
