/**
 * bankAccounts.ts gap-close slice — S404. Closes the file at 4/4 (100%).
 *
 * Covered routes (4):
 *   - GET   /api/bank-accounts
 *   - POST  /api/bank-accounts
 *   - PATCH /api/bank-accounts/:id
 *   - POST  /api/bank-accounts/:id/archive
 *
 * Per-user scoping is the contract: account_number_encrypted is never
 * returned to any client (SAFE_COLUMNS allowlist); routing/account
 * numbers are immutable post-create; cross-user reads/writes 404 (not
 * 403 — we don't leak existence of a row belonging to someone else).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedUserBankAccount,
} from '../test/dbHelpers'
import { bankAccountsRouter } from './bankAccounts'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/bank-accounts', bankAccountsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bank_accts'
})

// A known-valid ABA routing number (Federal Reserve Bank of Boston).
// Prefix 01 in valid range + checksum verified by validateAbaRoutingNumber.
const VALID_ROUTING = '011000015'

interface Fixture {
  userA: string; userATok: string
  userB: string; userBTok: string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aLid } = await seedLandlord(c)
    const { userId: bUid, landlordId: bLid } = await seedLandlord(c)
    await c.query('COMMIT')
    const sign = (uid: string, lid: string) =>
      jwt.sign({ userId: uid, role: 'landlord', email: `${uid}@t.dev`,
                 profileId: lid, permissions: {} },
               process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      userA: aUid, userATok: sign(aUid, aLid),
      userB: bUid, userBTok: sign(bUid, bLid),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── GET /api/bank-accounts ────────────────────────────────

describe('GET /api/bank-accounts', () => {
  it('returns only caller\'s accounts', async () => {
    const f = await seed()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await seedUserBankAccount(c, { userId: f.userA })
      await seedUserBankAccount(c, { userId: f.userA })
      await seedUserBankAccount(c, { userId: f.userB })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).get('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })

  it('returns [] when caller has no accounts', async () => {
    const f = await seed()
    const res = await request(buildApp()).get('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('never returns account_number_encrypted in payload', async () => {
    const f = await seed()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await seedUserBankAccount(c, { userId: f.userA })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).get('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
    expect(res.status).toBe(200)
    expect(res.body.data[0]).not.toHaveProperty('account_number_encrypted')
    // last4 IS exposed (used in the UI for disambiguation).
    expect(res.body.data[0]).toHaveProperty('account_number_last4')
  })

  it('archived accounts still appear (ORDER BY status ASC) — UI disambiguates', async () => {
    const f = await seed()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const archivedId = await seedUserBankAccount(c, { userId: f.userA })
      const activeId = await seedUserBankAccount(c, { userId: f.userA })
      await c.query(`UPDATE user_bank_accounts SET status='archived' WHERE id=$1`, [archivedId])
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).get('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    const statuses = res.body.data.map((r: any) => r.status).sort()
    expect(statuses).toEqual(['active', 'archived'])
  })
})

// ─── POST /api/bank-accounts ───────────────────────────────

describe('POST /api/bank-accounts', () => {
  const happyPayload = () => ({
    nickname: 'Main Operating',
    accountHolderName: 'Acme LLC',
    accountHolderType: 'business',
    accountType: 'checking',
    routingNumber: VALID_ROUTING,
    accountNumber: '1234567890',
  })

  it('happy: 201 with last4 + no encrypted payload returned', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send(happyPayload())
    expect(res.status).toBe(201)
    expect(res.body.data.account_number_last4).toBe('7890')
    expect(res.body.data).not.toHaveProperty('account_number_encrypted')
    expect(res.body.data.routing_number).toBe(VALID_ROUTING)
    // DB row has the encrypted blob.
    const { rows: [row] } = await db.query<any>(
      `SELECT account_number_encrypted FROM user_bank_accounts WHERE id=$1`,
      [res.body.data.id])
    expect(row.account_number_encrypted).toBeTruthy()
    expect(row.account_number_encrypted).not.toBe('1234567890')
  })

  it('routing number with formatting (spaces / dashes) is stripped and validated', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), routingNumber: '011-000-015' })
    expect(res.status).toBe(201)
    expect(res.body.data.routing_number).toBe(VALID_ROUTING)
  })

  it('invalid routing number checksum → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), routingNumber: '011000019' })  // bad checksum
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid routing number/)
  })

  it('routing number wrong length → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), routingNumber: '12345' })
    expect(res.status).toBe(400)
  })

  it('account number < 4 digits → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), accountNumber: '123' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/4.*17 digits/)
  })

  it('account number > 17 digits → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), accountNumber: '1'.repeat(18) })
    expect(res.status).toBe(400)
  })

  it('nickname required → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), nickname: '' })
    expect(res.status).toBe(400)
  })

  it('invalid accountType enum → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), accountType: 'crypto' })
    expect(res.status).toBe(400)
  })

  it('invalid accountHolderType enum → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), accountHolderType: 'pet' })
    expect(res.status).toBe(400)
  })

  it('nickname is trimmed before insert', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-accounts')
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ ...happyPayload(), nickname: '   Padded   ' })
    expect(res.status).toBe(201)
    expect(res.body.data.nickname).toBe('Padded')
  })
})

// ─── PATCH /api/bank-accounts/:id ──────────────────────────

describe('PATCH /api/bank-accounts/:id', () => {
  it('happy: updates nickname only', async () => {
    const f = await seed()
    let acctId = ''
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      acctId = await seedUserBankAccount(c, { userId: f.userA })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).patch(`/api/bank-accounts/${acctId}`)
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ nickname: 'Renamed' })
    expect(res.status).toBe(200)
    expect(res.body.data.nickname).toBe('Renamed')
    // Routing/account_number unchanged.
    expect(res.body.data.routing_number).toBe('123456789')
    expect(res.body.data.account_number_last4).toBe('4321')
  })

  it('immutability: routing/account fields in body are ignored', async () => {
    const f = await seed()
    let acctId = ''
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      acctId = await seedUserBankAccount(c, { userId: f.userA })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).patch(`/api/bank-accounts/${acctId}`)
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({
        nickname: 'Renamed',
        routingNumber: '999999999',
        accountNumber: '9999999999',
      })
    expect(res.status).toBe(200)
    expect(res.body.data.nickname).toBe('Renamed')
    // Pre-existing values unchanged.
    expect(res.body.data.routing_number).toBe('123456789')
    expect(res.body.data.account_number_last4).toBe('4321')
  })

  it('cross-user → 404 (does NOT leak existence as 403)', async () => {
    const f = await seed()
    let acctId = ''
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      acctId = await seedUserBankAccount(c, { userId: f.userB })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).patch(`/api/bank-accounts/${acctId}`)
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ nickname: 'Hijacked' })
    expect(res.status).toBe(404)
    // Verify the foreign row was NOT touched.
    const { rows: [row] } = await db.query<any>(
      `SELECT nickname FROM user_bank_accounts WHERE id=$1`, [acctId])
    expect(row.nickname).toBe('Test Bank')
  })

  it('unknown id → 404', async () => {
    const f = await seed()
    const res = await request(buildApp()).patch(`/api/bank-accounts/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ nickname: 'Whatever' })
    expect(res.status).toBe(404)
  })

  it('empty nickname → 400', async () => {
    const f = await seed()
    let acctId = ''
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      acctId = await seedUserBankAccount(c, { userId: f.userA })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).patch(`/api/bank-accounts/${acctId}`)
      .set('Authorization', `Bearer ${f.userATok}`)
      .send({ nickname: '' })
    expect(res.status).toBe(400)
  })
})

// ─── POST /api/bank-accounts/:id/archive ───────────────────

describe('POST /api/bank-accounts/:id/archive', () => {
  it('happy: status flips to archived', async () => {
    const f = await seed()
    let acctId = ''
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      acctId = await seedUserBankAccount(c, { userId: f.userA })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).post(`/api/bank-accounts/${acctId}/archive`)
      .set('Authorization', `Bearer ${f.userATok}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('archived')
    // Row + encrypted blob persist (soft delete contract).
    const { rows: [row] } = await db.query<any>(
      `SELECT account_number_encrypted FROM user_bank_accounts WHERE id=$1`,
      [acctId])
    expect(row.account_number_encrypted).toBeTruthy()
  })

  it('cross-user archive → 404; row NOT touched', async () => {
    const f = await seed()
    let acctId = ''
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      acctId = await seedUserBankAccount(c, { userId: f.userB })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await request(buildApp()).post(`/api/bank-accounts/${acctId}/archive`)
      .set('Authorization', `Bearer ${f.userATok}`)
    expect(res.status).toBe(404)
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM user_bank_accounts WHERE id=$1`, [acctId])
    expect(row.status).toBe('active')
  })

  it('idempotent: re-archive an already-archived account stays archived (no error)', async () => {
    const f = await seed()
    let acctId = ''
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      acctId = await seedUserBankAccount(c, { userId: f.userA })
      await c.query('COMMIT')
    } finally { c.release() }
    await request(buildApp()).post(`/api/bank-accounts/${acctId}/archive`)
      .set('Authorization', `Bearer ${f.userATok}`)
    const res = await request(buildApp()).post(`/api/bank-accounts/${acctId}/archive`)
      .set('Authorization', `Bearer ${f.userATok}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('archived')
  })

  it('unknown id → 404', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/bank-accounts/${randomUUID()}/archive`)
      .set('Authorization', `Bearer ${f.userATok}`)
    expect(res.status).toBe(404)
  })
})
