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
  it('uses the company sent in the BODY — the picker is honored', async () => {
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

// S652 (Nic): "I select Mountain View, it shows the linked bank, and when I
// click sync it tells me I need to choose which business." A connection
// belongs to one company already; acting on it never asks.
describe('POST /bank-feed/connections/:id/sync — the row knows its company', () => {
  async function seedConnection(landlordId: string) {
    const { rows: [row] } = await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1, 'stripe_fc', 'active') RETURNING id`, [landlordId])
    return row.id
  }
  it('syncs a two-company account\'s connection without being told which company', async () => {
    const id = await seedConnection(coB)
    const res = await request(buildApp())
      .post(`/api/bank-feed/connections/${id}/sync`).set('Authorization', `Bearer ${token}`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })
  it("refuses a connection that belongs to somebody else's company", async () => {
    const id = await seedConnection(strangerCo)
    const res = await request(buildApp())
      .post(`/api/bank-feed/connections/${id}/sync`).set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(404)
  })
})

// S655 (Step 12): a deposit slip, an Undo, a filing undo — each lands on the
// company chosen on the page, or on the row's own company; never a guess.
describe('Step 12: deposit slips and undo respect the company', () => {
  it('a slip is made for the company chosen on the page; a company not yours is refused; none named with two is asked', async () => {
    const send = (body: any) => request(buildApp()).post('/api/bank-feed/deposit-slips')
      .set('Authorization', `Bearer ${token}`)
      .send({ depositDate: '2026-09-29', otherAmount: 12, otherNote: 'Vending', otherIsNotRent: true, ...body })
    const ok = await send({ entityId: coB })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const slip = (await db.query(`SELECT landlord_id FROM bank_deposit_slips WHERE id = $1`, [ok.body.data.id])).rows[0]
    expect(slip.landlord_id).toBe(coB)
    expect((await send({ entityId: strangerCo })).status).toBe(403)
    const unnamed = await send({})
    expect(unnamed.status).toBe(400)
    expect(unnamed.body.error).toMatch(/more than one company/i)
  })

  it('an Undo on another company’s deposit is not found', async () => {
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1, 'stripe_fc', 'active') RETURNING id`, [strangerCo])).rows[0].id
    const txn = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
       VALUES ($1,$2,'x1','2026-09-29',50,'matched') RETURNING id`, [conn, strangerCo])).rows[0].id
    for (const path of [`/api/bank-feed/deposits/${txn}/undo`, `/api/bank-feed/transactions/${txn}/undo-auto-file`]) {
      const res = await request(buildApp()).post(path).set('Authorization', `Bearer ${token}`).send({})
      expect(res.status, path).toBe(404)
    }
  })
})
