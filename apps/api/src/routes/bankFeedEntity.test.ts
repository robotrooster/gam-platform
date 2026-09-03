/**
 * S637 — connecting a bank must respect the company already chosen.
 *
 * Nic: "When I select Mountain View or Oak Park from the banking page and then
 * click connect to bank, it still wants me to choose which one it belongs to
 * after I've already gone onto that entity's selection."
 *
 * scope() read entityId from the QUERY STRING only. The GET routes pass it
 * that way, so listing connections respected the picker — but /link-session
 * and /finalize are POSTs, and a POST carries its arguments in the body. The
 * one action that actually links a bank discarded the answer and asked again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

vi.mock('../services/bankFeed', () => ({
  createLinkSession: vi.fn(async (landlordId: string) => ({ clientSecret: 'fcsess_secret', landlordId })),
  finalizeLinkSession: vi.fn(async (landlordId: string) => ({ connected: true, landlordId })),
  listConnections: vi.fn(async () => []),
  syncConnection: vi.fn(async () => ({ imported: 0 })),
  disconnectConnection: vi.fn(async () => ({ ok: true })),
  listTransactions: vi.fn(async () => []),
}))

import { bankFeedRouter } from './bankFeed'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/bank-feed', bankFeedRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_bankfeed'
let token: string, coA: string, coB: string, strangerCo: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const b = await seedLandlord(c)
    const s = await seedLandlord(c)
    coA = a.landlordId; coB = b.landlordId; strangerCo = s.landlordId
    // One human, two companies — Oak Park and Mountain View.
    await c.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT DO NOTHING`, [coB, a.userId])
    await c.query('COMMIT')
    token = jwt.sign(
      { userId: a.userId, role: 'landlord', email: 'me@t.dev', profileId: null,
        landlordIds: [coA, coB], permissions: {} }, SECRET, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const link = (body: any) => request(buildApp())
  .post('/api/bank-feed/link-session').set('Authorization', `Bearer ${token}`).send(body)

describe('POST /bank-feed/link-session', () => {
  it('uses the company sent in the BODY — the picker is honoured', async () => {
    const res = await link({ entityId: coB })
    expect(res.status).toBe(200)
    const { createLinkSession } = await import('../services/bankFeed')
    expect(createLinkSession).toHaveBeenCalledWith(coB)
  })

  it('still refuses when NO company is named and there are two', async () => {
    const res = await link({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/more than one company/i)
  })

  it("refuses a company the caller is not a member of", async () => {
    const res = await link({ entityId: strangerCo })
    expect(res.status).toBe(403)
  })

  it('accepts it from the query string too, as the GET routes always did', async () => {
    const res = await request(buildApp())
      .post(`/api/bank-feed/link-session?entityId=${coA}`)
      .set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(200)
    const { createLinkSession } = await import('../services/bankFeed')
    expect(createLinkSession).toHaveBeenCalledWith(coA)
  })
})
