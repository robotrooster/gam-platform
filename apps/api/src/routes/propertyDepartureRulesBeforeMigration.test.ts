/**
 * 10/19 (review) — THE WINDOW BETWEEN THE MIGRATION AND THE CODE.
 *
 * GAM applies a migration to production ahead of the code that uses it, and a
 * rollback puts the old code back on the new schema, so every path that touches
 * properties.early_departure_refunds / prorates_mid_month_rent has to work in
 * BOTH orders. The read side does, through `to_jsonb(p) ->> 'col'` (NULL for a
 * column that is not there, which falls through to money back + proration).
 *
 * The WRITE side did not, and it was not a soft failure: the onboarding form
 * puts both answers in every POST body, so the UPDATE ran on every property
 * creation, Postgres raised 42703 as it planned the statement, the route's
 * catch rolled the whole transaction back, and a landlord pressing Next on
 * step 2 got a 500 and NO PROPERTY. Every other test in this area applies the
 * migration in beforeEach, so none of them could see it.
 *
 * This file is the only one that runs with the columns NOT there. It drops them
 * first (they are absent from the base test schema; another file on this worker
 * may have applied the migration already) and puts back whatever it found at
 * the end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { readFileSync } from 'fs'
import { join } from 'path'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'
import { departureRuleSql, departureRulesStored, DEPARTURE_RULES_NOT_STORED_YET } from '../services/departureRules'

const MIGRATION = join(__dirname, '..', 'db', 'migrations', '20261020120000_leaving_early_is_the_propertys_call.sql')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

const columnCount = async () => Number((await query<{ n: string }>(
  `SELECT COUNT(*) AS n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'properties'
      AND column_name IN ('early_departure_refunds', 'prorates_mid_month_rent')`))[0].n)

let wasApplied = false

beforeAll(async () => {
  wasApplied = (await columnCount()) === 2
  await db.query(`ALTER TABLE properties
    DROP COLUMN IF EXISTS early_departure_refunds, DROP COLUMN IF EXISTS prorates_mid_month_rent`)
})

afterAll(async () => {
  if (wasApplied) await db.query(readFileSync(MIGRATION, 'utf8'))
})

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_departure_rules_pre'
})

async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const token = jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId, landlordIds: [landlordId] },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { propertyId, token }
  } finally { c.release() }
}

const onboardingBody = {
  name: 'Cottonwood Flats', street1: '18 Mesa Rd', city: 'Prescott', state: 'AZ', zip: '86301',
  firstBillingCycle: '2026-11',
  // What apps/landlord OnboardingPage sends with every property: both answers,
  // always, whether the landlord touched them or not.
  refundsEarlyDeparture: true, proratesMidMonth: true,
}

describe('before the columns exist', () => {
  it('the onboarding form still creates the property, and claims no answer it could not keep', async () => {
    const f = await seed()
    const made = await request(buildApp()).post('/api/properties')
      .set('Authorization', `Bearer ${f.token}`).send(onboardingBody)
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data?.id ?? made.body.id
    expect(id).toBeTruthy()
    expect(await query(`SELECT 1 FROM properties WHERE id = $1`, [id])).toHaveLength(1)
    // What it reports is what is actually in effect, which is also what the
    // property card will show once it reads the property back.
    const said = made.body.data ?? made.body
    expect(said.early_departure_refunds ?? said.earlyDepartureRefunds).toBe(true)
    expect(said.prorates_mid_month_rent ?? said.proratesMidMonthRent).toBe(true)
  })

  it('a landlord answering No is told plainly, never shown a 500 or a silent success', async () => {
    const f = await seed()
    const r = await request(buildApp()).patch(`/api/properties/${f.propertyId}/departure-rules`)
      .set('Authorization', `Bearer ${f.token}`).send({ refundsEarlyDeparture: false })
    expect(r.status).toBe(503)
    expect(r.body.error).toBe(DEPARTURE_RULES_NOT_STORED_YET)
  })

  it('reading an answer works anyway: every property gives money back and prorates', async () => {
    const f = await seed()
    const read = await query<{ refunds: boolean; prorates: boolean }>(
      `SELECT ${departureRuleSql('early_departure_refunds')} AS refunds,
              ${departureRuleSql('prorates_mid_month_rent')} AS prorates
         FROM properties p WHERE p.id = $1`, [f.propertyId])
    expect(read[0]).toEqual({ refunds: true, prorates: true })
    expect(await departureRulesStored()).toBe(false)
  })

  // LAST: this one applies the migration, and the columns stay for the rest of
  // the file. Nothing is restarted — a "not yet" is asked again every time.
  it('the moment the migration lands, the same answer saves — no restart', async () => {
    const f = await seed()
    const before = await request(buildApp()).patch(`/api/properties/${f.propertyId}/departure-rules`)
      .set('Authorization', `Bearer ${f.token}`).send({ refundsEarlyDeparture: false })
    expect(before.status).toBe(503)

    await db.query(readFileSync(MIGRATION, 'utf8'))
    expect(await departureRulesStored()).toBe(true)

    const after = await request(buildApp()).patch(`/api/properties/${f.propertyId}/departure-rules`)
      .set('Authorization', `Bearer ${f.token}`).send({ refundsEarlyDeparture: false })
    expect(after.status, JSON.stringify(after.body)).toBe(200)
    expect(after.body.data).toMatchObject({ earlyDepartureRefunds: false, proratesMidMonthRent: true })

    // And a property created from the form now carries what it was given.
    const made = await request(buildApp()).post('/api/properties')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ ...onboardingBody, name: 'Juniper Park', refundsEarlyDeparture: false, proratesMidMonth: false })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data?.id ?? made.body.id
    expect((await query<any>(
      `SELECT early_departure_refunds, prorates_mid_month_rent FROM properties WHERE id = $1`, [id]))[0])
      .toEqual({ early_departure_refunds: false, prorates_mid_month_rent: false })
  })
})
