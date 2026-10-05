/**
 * S648 (Nic): "landlord can choose to absorb the processing cost..."
 * 10/5 (Nic): "they cannot absorb it for some people and pass it through to
 * other people." ONE choice per property — card and bank fees, for rent, the
 * counter, pay links and the booking site.
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

const stored = async (propertyId: string) => ({
  ...(await db.query(`SELECT register_card_fee_payer, booking_card_fee_payer FROM properties WHERE id = $1`, [propertyId])).rows[0],
  ...(await db.query(`SELECT ach_fee_payer, card_fee_payer FROM property_allocation_rules WHERE property_id = $1`, [propertyId])).rows[0],
})
const withRule = (propertyId: string) => db.query(
  `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer) VALUES ($1, 'tenant', 'tenant')`, [propertyId])

describe('one card-and-bank fee choice per property', () => {
  it('starts passed on everywhere; "cover" covers rent, the counter and the booking site at once, and back', async () => {
    const f = await seed()
    await withRule(f.propertyId)
    expect(await stored(f.propertyId)).toEqual({
      register_card_fee_payer: 'customer', booking_card_fee_payer: 'customer', ach_fee_payer: 'tenant', card_fee_payer: 'tenant' })
    const r1 = await patch(f, { choice: 'cover' })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(r1.body.data).toMatchObject({ choice: 'cover', registerCardFeePayer: 'landlord', bookingCardFeePayer: 'landlord' })
    expect(await stored(f.propertyId)).toEqual({
      register_card_fee_payer: 'landlord', booking_card_fee_payer: 'landlord', ach_fee_payer: 'landlord', card_fee_payer: 'landlord' })
    expect((await patch(f, { choice: 'pass_on' })).status).toBe(200)
    expect(await stored(f.propertyId)).toEqual({
      register_card_fee_payer: 'customer', booking_card_fee_payer: 'customer', ach_fee_payer: 'tenant', card_fee_payer: 'tenant' })
  })

  it('a page cached from before sends one channel: it is taken as the choice for everything', async () => {
    const f = await seed()
    await withRule(f.propertyId)
    expect((await patch(f, { booking: 'landlord' })).status).toBe(200)
    expect(await stored(f.propertyId)).toEqual({
      register_card_fee_payer: 'landlord', booking_card_fee_payer: 'landlord', ach_fee_payer: 'landlord', card_fee_payer: 'landlord' })
  })

  it('no write anywhere can split it — a stray UPDATE of one column carries to all four', async () => {
    const f = await seed()
    await withRule(f.propertyId)
    await db.query(`UPDATE properties SET booking_card_fee_payer = 'landlord' WHERE id = $1`, [f.propertyId])
    expect(await stored(f.propertyId)).toEqual({
      register_card_fee_payer: 'landlord', booking_card_fee_payer: 'landlord', ach_fee_payer: 'landlord', card_fee_payer: 'landlord' })
    await db.query(`UPDATE property_allocation_rules SET card_fee_payer = 'tenant' WHERE property_id = $1`, [f.propertyId])
    expect(await stored(f.propertyId)).toEqual({
      register_card_fee_payer: 'customer', booking_card_fee_payer: 'customer', ach_fee_payer: 'tenant', card_fee_payer: 'tenant' })
  })

  it('refuses a split, anything else, nothing, and another landlord\'s property', async () => {
    const f = await seed()
    await withRule(f.propertyId)
    expect((await patch(f, { register: 'landlord', booking: 'customer' })).status).toBe(400)
    expect((await patch(f, { choice: 'half' })).status).toBe(400)
    expect((await patch(f, { register: 'tenant' })).status).toBe(400)
    expect((await patch(f, {})).status).toBe(400)
    const g = await seed()
    expect((await patch({ propertyId: g.propertyId, token: f.token }, { choice: 'cover' })).status).toBe(403)
  })
})
