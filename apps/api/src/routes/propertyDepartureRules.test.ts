/**
 * 10/18 (Nic) — WHAT HAPPENS WHEN SOMEBODY LEAVES EARLY IS THE PROPERTY'S CALL.
 *
 *   "refunds are pro rated to the next price down. people pay for a week they
 *    stay 4 days. the 4 day rate against the weekly rate is the difference for
 *    the refund if the landlord does refunds at all at that property. the only
 *    way it is different is for longer term people for rent pro ration. moving
 *    in or out at the middle of a month and also only if the landlord allows
 *    the pro rate. these should all be property level settings."
 *
 * Two answers, stored on the property: does it give money back when someone
 * leaves early, and does it prorate rent for a mid-month move. Both default to
 * what every property on GAM already does — money back, and proration — so a
 * landlord who answers nothing sees no change.
 *
 * The migration that adds the columns (20261020120000) has not been applied to
 * production, so it is applied here the way the runner will. It is idempotent,
 * so running it before each test is a no-op after the first.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { readFileSync } from 'fs'
import { join } from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

const MIGRATION = join(__dirname, '..', 'db', 'migrations', '20261020120000_leaving_early_is_the_propertys_call.sql')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(readFileSync(MIGRATION, 'utf8'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_departure_rules'
})

async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const token = jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId, landlordIds: [landlordId] },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { propertyId, token, landlordId, userId }
  } finally { c.release() }
}

const patch = (f: { propertyId: string; token: string }, body: any) =>
  request(buildApp()).patch(`/api/properties/${f.propertyId}/departure-rules`)
    .set('Authorization', `Bearer ${f.token}`).send(body)

const stored = async (propertyId: string) => (await db.query(
  `SELECT early_departure_refunds, prorates_mid_month_rent FROM properties WHERE id = $1`, [propertyId])).rows[0]

describe('the two departure answers', () => {
  it('both start at Yes — the way every property already works', async () => {
    const f = await seed()
    expect(await stored(f.propertyId)).toEqual({ early_departure_refunds: true, prorates_mid_month_rent: true })
  })

  it('each answer saves on its own, and the other is left exactly as it was', async () => {
    const f = await seed()
    const r1 = await patch(f, { refundsEarlyDeparture: false })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(r1.body.data).toMatchObject({ earlyDepartureRefunds: false, proratesMidMonthRent: true })
    expect(await stored(f.propertyId)).toEqual({ early_departure_refunds: false, prorates_mid_month_rent: true })

    const r2 = await patch(f, { proratesMidMonth: false })
    expect(r2.status, JSON.stringify(r2.body)).toBe(200)
    expect(r2.body.data).toMatchObject({ earlyDepartureRefunds: false, proratesMidMonthRent: false })
    expect(await stored(f.propertyId)).toEqual({ early_departure_refunds: false, prorates_mid_month_rent: false })

    // And back again — nothing here is one-way.
    expect((await patch(f, { refundsEarlyDeparture: true, proratesMidMonth: true })).status).toBe(200)
    expect(await stored(f.propertyId)).toEqual({ early_departure_refunds: true, prorates_mid_month_rent: true })
  })

  it('a body that answers neither is refused, not quietly accepted', async () => {
    const f = await seed()
    expect((await patch(f, {})).status).toBe(400)
    expect((await patch(f, { refundsEarlyDeparture: 'no' })).status).toBe(400)
    expect(await stored(f.propertyId)).toEqual({ early_departure_refunds: true, prorates_mid_month_rent: true })
  })

  it('another account cannot answer for this property, and an unknown one is a 404', async () => {
    const f = await seed()
    const g = await seed()
    expect((await patch({ propertyId: g.propertyId, token: f.token }, { refundsEarlyDeparture: false })).status).toBe(403)
    expect(await stored(g.propertyId)).toEqual({ early_departure_refunds: true, prorates_mid_month_rent: true })
    expect((await patch({ propertyId: '00000000-0000-0000-0000-000000000000', token: f.token },
      { refundsEarlyDeparture: false })).status).toBe(404)
  })

  it('the change is journaled: what the property said before is recoverable', async () => {
    const f = await seed()
    await patch(f, { refundsEarlyDeparture: false })
    const before = (await db.query(
      `SELECT old_row FROM audit_row_changes WHERE table_name = 'properties' AND row_id = $1 ORDER BY changed_at DESC LIMIT 1`,
      [f.propertyId])).rows[0]
    expect(before?.old_row?.early_departure_refunds).toBe(true)
  })

  // The onboarding form asks both with every other property choice, so the
  // answers have to arrive with the property, not a round trip after it.
  it('a property created from the onboarding form carries the answers it was given', async () => {
    const f = await seed()
    const made = await request(buildApp()).post('/api/properties')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: 'Cottonwood Flats', street1: '18 Mesa Rd', city: 'Prescott', state: 'AZ', zip: '86301',
              firstBillingCycle: '2026-11', refundsEarlyDeparture: false, proratesMidMonth: false })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data?.id ?? made.body.id
    expect(await stored(id)).toEqual({ early_departure_refunds: false, prorates_mid_month_rent: false })
  })

  it('a property created without being asked keeps the defaults', async () => {
    const f = await seed()
    const made = await request(buildApp()).post('/api/properties')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: 'Juniper Park', street1: '42 Pine Way', city: 'Prescott', state: 'AZ', zip: '86301',
              firstBillingCycle: '2026-11' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data?.id ?? made.body.id
    expect(await stored(id)).toEqual({ early_departure_refunds: true, prorates_mid_month_rent: true })
  })

  it('one answer at creation leaves the other at its default', async () => {
    const f = await seed()
    const made = await request(buildApp()).post('/api/properties')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: 'Agave Court', street1: '7 Agave Ln', city: 'Prescott', state: 'AZ', zip: '86301',
              firstBillingCycle: '2026-11', proratesMidMonth: false })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data?.id ?? made.body.id
    expect(await stored(id)).toEqual({ early_departure_refunds: true, prorates_mid_month_rent: false })
  })
})
