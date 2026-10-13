/**
 * 10/12 (Nic) — GAM Books ledger, phase P8: the switch of a company's reports
 * to its books, from the admin's ledger page (routes/admin/ledger.ts): whether
 * the reports read the books and why not, run the parity check now, accept the
 * differences with a reason. super_admin only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { adminLedgerRouter } from './admin/ledger'
import { errorHandler } from '../middleware/errorHandler'
import { tenantCo, bill, drain, cleanupTenantLedger } from '../test/ledgerTenantFixtures'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../services/ledgerProjectors'
import { markRebuilt } from '../test/ledgerReportFixtures'

const app = express()
app.use(express.json())
app.use('/api/admin', adminLedgerRouter)
app.use(errorHandler)

const sign = (id: string, role: string) => jwt.sign(
  { userId: id, role, email: `${role}@test.dev`, profileId: id, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
async function user(role: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified) VALUES ($1, 'x', $2, 'A', 'B', TRUE) RETURNING id`,
    [`${role}-${randomUUID()}@test.dev`, role])).rows[0].id
}

beforeEach(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_ledger_parity'
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

describe('the reports switch, from the admin ledger page', () => {
  it('says why a company is not switched, runs the check now, and an accepted check switches it', async () => {
    const co = await tenantCo()
    await bill(co, { type: 'carried_balance', amount: 250, due: '2026-10-01' })
    await drain()
    await markRebuilt(co.landlordId)
    const sa = sign(await user('super_admin'), 'super_admin')
    const base = `/api/admin/ledger/landlords/${co.landlordId}`

    const before = await request(app).get(`${base}/reports`).set('Authorization', `Bearer ${sa}`)
    expect(before.status).toBe(200)
    expect(before.body.data.live).toBe(false)
    expect(before.body.data.reason).toMatch(/nightly check/)

    const run = await request(app).post(`${base}/parity`).set('Authorization', `Bearer ${sa}`)
    expect(run.status).toBe(200)
    expect(run.body.data.landlordId).toBe(co.landlordId)

    const refused = await request(app).post(`${base}/parity/accept`).set('Authorization', `Bearer ${sa}`).send({ reason: '  ' })
    expect(refused.status).toBe(400)
    const ok = await request(app).post(`${base}/parity/accept`).set('Authorization', `Bearer ${sa}`)
      .send({ reason: 'The old balances are opening equity on purpose.' })
    expect(ok.status).toBe(200)
    const after = await request(app).get(`${base}/reports`).set('Authorization', `Bearer ${sa}`)
    expect(after.body.data).toMatchObject({ live: true, reason: null })
    expect(after.body.data.runs[0].scope).toMatchObject({ kind: 'parity', accepted: true, reason: 'The old balances are opening equity on purpose.' })
  })

  it('is super_admin only', async () => {
    const co = await tenantCo()
    const admin = sign(await user('admin'), 'admin')
    const landlord = sign(co.ownerUserId, 'landlord')
    for (const tok of [admin, landlord]) {
      const r = await request(app).post(`/api/admin/ledger/landlords/${co.landlordId}/parity/accept`)
        .set('Authorization', `Bearer ${tok}`).send({ reason: 'x' })
      expect(r.status).toBe(403)
    }
  })
})
