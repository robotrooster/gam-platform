/**
 * surveys.ts — S577 property-scoped tenant surveys.
 *
 * Covers the full loop (create → send → tenant responds → results) plus the
 * two hard rules: responses are one-per-tenant, and a survey never leaks across
 * properties/landlords.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { surveysRouter } from './surveys'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/surveys', surveysRouter)
  app.use(errorHandler)
  return app
}
const app = buildApp()

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_surveys'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA  = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propA2 = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propB  = await seedProperty(c, { landlordId: bId, ownerUserId: bUid, managedByUserId: bUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const unitB = await seedUnit(c, { propertyId: propB, landlordId: bId })
    const tenantA = await seedTenant(c)
    const tenantB = await seedTenant(c)
    const taUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantA])
    const tbUser = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantB])
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: aId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA })
    const leaseB = await seedLease(c, { unitId: unitB, landlordId: bId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseB, tenantId: tenantB })
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      aId, bId, propA, propA2, propB,
      tenantAToken: sign({ userId: taUser.rows[0].user_id, role: 'tenant', email: 'ta@t.dev', profileId: tenantA, permissions: {} }),
      tenantBToken: sign({ userId: tbUser.rows[0].user_id, role: 'tenant', email: 'tb@t.dev', profileId: tenantB, permissions: {} }),
      tokenA: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      tokenB: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const sampleBody = (propertyId: string) => ({
  propertyId, title: 'Pool closure', description: 'Pick a weekend', anonymous: false,
  questions: [
    { questionType: 'multiple_choice', prompt: 'Which weekend?', options: ['June 1', 'June 8'], required: true },
    { questionType: 'text', prompt: 'Anything else?', required: false },
  ],
})

async function createAndSend(f: any) {
  const created = await request(app).post('/api/surveys').set(auth(f.tokenA)).send(sampleBody(f.propA))
  expect(created.status).toBe(201)
  const id = created.body.data.id
  const sent = await request(app).post(`/api/surveys/${id}/send`).set(auth(f.tokenA))
  expect(sent.status).toBe(200)
  return id
}

describe('surveys — full loop', () => {
  it('create → send → tenant responds → results aggregate correctly', async () => {
    const f = await seed()
    const id = await createAndSend(f)

    // tenant A sees it, not yet responded
    const mine = await request(app).get('/api/surveys/tenant/mine').set(auth(f.tenantAToken))
    expect(mine.status).toBe(200)
    expect(mine.body.data).toHaveLength(1)
    expect(mine.body.data[0].responded).toBe(false)

    const detail = await request(app).get(`/api/surveys/tenant/${id}`).set(auth(f.tenantAToken))
    const qs = detail.body.data.questions
    const mcq = qs.find((q: any) => q.question_type === 'multiple_choice')
    const txtq = qs.find((q: any) => q.question_type === 'text')

    const resp = await request(app).post(`/api/surveys/tenant/${id}/respond`).set(auth(f.tenantAToken))
      .send({ answers: [{ questionId: mcq.id, answerText: 'June 8' }, { questionId: txtq.id, answerText: 'Prefer mornings' }] })
    expect(resp.status).toBe(200)

    // results: 1 response, tally has June 8 = 1
    const results = await request(app).get(`/api/surveys/${id}/results`).set(auth(f.tokenA))
    expect(results.status).toBe(200)
    expect(results.body.data.responseCount).toBe(1)
    expect(results.body.data.invited).toBe(1)
    const mcResult = results.body.data.results.find((r: any) => r.question_type === 'multiple_choice')
    expect(mcResult.tally.find((t: any) => t.option === 'June 8').count).toBe(1)
    expect(mcResult.tally.find((t: any) => t.option === 'June 1').count).toBe(0)
    const txtResult = results.body.data.results.find((r: any) => r.question_type === 'text')
    expect(txtResult.answers[0].text).toBe('Prefer mornings')
  })

  it('rejects a second response from the same tenant (409)', async () => {
    const f = await seed()
    const id = await createAndSend(f)
    const detail = await request(app).get(`/api/surveys/tenant/${id}`).set(auth(f.tenantAToken))
    const mcq = detail.body.data.questions.find((q: any) => q.question_type === 'multiple_choice')
    const txtq = detail.body.data.questions.find((q: any) => q.question_type === 'text')
    const first = await request(app).post(`/api/surveys/tenant/${id}/respond`).set(auth(f.tenantAToken))
      .send({ answers: [{ questionId: mcq.id, answerText: 'June 1' }, { questionId: txtq.id, answerText: 'NA' }] })
    expect(first.status).toBe(200)
    const second = await request(app).post(`/api/surveys/tenant/${id}/respond`).set(auth(f.tenantAToken))
      .send({ answers: [{ questionId: mcq.id, answerText: 'June 8' }, { questionId: txtq.id, answerText: 'NA' }] })
    expect(second.status).toBe(409)
  })

  it('rejects a multiple-choice answer that is not an offered option (400)', async () => {
    const f = await seed()
    const id = await createAndSend(f)
    const detail = await request(app).get(`/api/surveys/tenant/${id}`).set(auth(f.tenantAToken))
    const mcq = detail.body.data.questions.find((q: any) => q.question_type === 'multiple_choice')
    const txtq = detail.body.data.questions.find((q: any) => q.question_type === 'text')
    const bad = await request(app).post(`/api/surveys/tenant/${id}/respond`).set(auth(f.tenantAToken))
      .send({ answers: [{ questionId: mcq.id, answerText: 'June 99' }, { questionId: txtq.id, answerText: 'NA' }] })
    expect(bad.status).toBe(400)
  })

  it('rejects a response that leaves a question blank (all required)', async () => {
    const f = await seed()
    const id = await createAndSend(f)
    const detail = await request(app).get(`/api/surveys/tenant/${id}`).set(auth(f.tenantAToken))
    const mcq = detail.body.data.questions.find((q: any) => q.question_type === 'multiple_choice')
    const res = await request(app).post(`/api/surveys/tenant/${id}/respond`).set(auth(f.tenantAToken))
      .send({ answers: [{ questionId: mcq.id, answerText: 'June 1' }] }) // text question left blank
    expect(res.status).toBe(400)
  })
})

describe('surveys — scoping', () => {
  it('a tenant at another property never sees the survey', async () => {
    const f = await seed()
    await createAndSend(f)
    const mineB = await request(app).get('/api/surveys/tenant/mine').set(auth(f.tenantBToken))
    expect(mineB.body.data).toHaveLength(0)
  })

  it('another landlord cannot read the survey or its results (403/404)', async () => {
    const f = await seed()
    const id = await createAndSend(f)
    const get = await request(app).get(`/api/surveys/${id}`).set(auth(f.tokenB))
    expect([403, 404]).toContain(get.status)
    const results = await request(app).get(`/api/surveys/${id}/results`).set(auth(f.tokenB))
    expect([403, 404]).toContain(results.status)
  })

  it('copy duplicates to another property as a fresh draft with no responses', async () => {
    const f = await seed()
    const id = await createAndSend(f)
    // respond so the source has data that must NOT carry over
    const detail = await request(app).get(`/api/surveys/tenant/${id}`).set(auth(f.tenantAToken))
    const mcq = detail.body.data.questions.find((q: any) => q.question_type === 'multiple_choice')
    const txtq = detail.body.data.questions.find((q: any) => q.question_type === 'text')
    await request(app).post(`/api/surveys/tenant/${id}/respond`).set(auth(f.tenantAToken))
      .send({ answers: [{ questionId: mcq.id, answerText: 'June 1' }, { questionId: txtq.id, answerText: 'NA' }] })

    const copy = await request(app).post(`/api/surveys/${id}/copy`).set(auth(f.tokenA)).send({ targetPropertyId: f.propA2 })
    expect(copy.status).toBe(201)
    const newId = copy.body.data.id
    const newResults = await request(app).get(`/api/surveys/${newId}/results`).set(auth(f.tokenA))
    expect(newResults.body.data.responseCount).toBe(0)
    expect(newResults.body.data.survey.property_id).toBe(f.propA2)
    expect(newResults.body.data.survey.status).toBe('draft')
  })
})
