/**
 * S637 — a bank account does not need a nickname to be added.
 *
 * Nic, watching a co-owner stall on the form: "Is the nickname for the account
 * actually required? That may be holding him up. He's old school, and he may
 * not have named the account."
 *
 * It was required on both sides, and the client refused BEFORE any request —
 * so pressing Add produced a re-render and nothing else: no spinner, no
 * network call, and "Required" printed under the first field of a long form,
 * off-screen on a phone. Somebody who had correctly entered a routing number
 * and an account number was stopped by a label for their own convenience.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { bankAccountsRouter } from './bankAccounts'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/bank-accounts', bankAccountsRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_banknick'
let token: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    await c.query('COMMIT')
    token = jwt.sign(
      { userId: l.userId, role: 'landlord', email: 'me@t.dev', profileId: null,
        landlordIds: [l.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

// 121000248 is Wells Fargo's real ABA and passes the checksum.
const add = (body: Record<string, unknown> = {}) => request(buildApp())
  .post('/api/bank-accounts').set('Authorization', `Bearer ${token}`)
  .send({
    accountHolderName: 'Dusty Rhoades',
    accountHolderType: 'individual',
    accountType: 'checking',
    routingNumber: '121000248',
    accountNumber: '1234564821',
    ...body,
  })

describe('POST /bank-accounts', () => {
  it('accepts an account with NO nickname', async () => {
    const res = await add()
    expect(res.status).toBe(201)
  })

  it('names it from the account details when none is given', async () => {
    const res = await add()
    expect(res.body.data.nickname).toBe('Checking ••4821')
  })

  it('says Savings for a savings account', async () => {
    const res = await add({ accountType: 'savings' })
    expect(res.body.data.nickname).toBe('Savings ••4821')
  })

  it('keeps a nickname when one IS given', async () => {
    const res = await add({ nickname: 'Mountain View operating' })
    expect(res.body.data.nickname).toBe('Mountain View operating')
  })

  it('treats blank and whitespace as not given', async () => {
    const res = await add({ nickname: '   ' })
    expect(res.body.data.nickname).toBe('Checking ••4821')
  })

  it('still rejects a routing number that fails the ABA checksum', async () => {
    const res = await add({ routingNumber: '123456789' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/routing number/i)
  })
})
