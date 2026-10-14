/**
 * 10/14 (Nic, answers 15 and 16) — the two Bank page actions a person takes
 * when GAM will not guess, through the routes:
 *   POST /api/bank-feed/transactions/:id/returned-check — the owner picks the
 *     check the bank returned (offered by GET /transactions/:id/matches);
 *   POST /api/bank-feed/transactions/:id/match-payout — the owner says a
 *     deposit is GAM's payout (offered on the line, payout_suggestion).
 * Both are the owner's: taking a tenant's payment back is a tenant action, never
 * a bookkeeper's (Nic 10/12), and an id from another company is never acted on.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { errorHandler } from '../middleware/errorHandler'
import { bankFeedRouter } from './bankFeed'
import { createSlip } from '../services/depositSlips'
import { reconcileDeposits } from '../services/bankFeed'
import { cleanupAllSchema, seedLandlord, seedProperty, seedTenant, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'

vi.mock('../services/email', async (orig) => ({ ...(await orig<any>()), sendNotificationEmail: async () => 'msg_test' }))

const SECRET = 'test_jwt_secret_bank_returned_check'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/bank-feed', bankFeedRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, SECRET, { expiresIn: '1h' })
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` })
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

beforeEach(async () => { await cleanupAllSchema() })

interface Co { landlordId: string; connectionId: string; ownerId: string; owner: string; bk: string; checkId: string; rentId: string }

/** A company whose $460 desk check went to the bank on a slip with a $300 one. */
async function company(): Promise<Co> {
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  let co: Omit<Co, 'checkId' | 'rentId'>
  const checks: Array<{ id: string; rentId: string }> = []
  try {
    const { userId: ownerId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: ownerId, managedByUserId: ownerId })
    const connectionId = (await c.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
      [landlordId])).rows[0].id
    const bkId = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bea', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
    await c.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide, money_in_filing)
       VALUES ($1, $2, 'read_write', $3, TRUE, 'any')`, [bkId, landlordId, [propertyId]])
    for (const amount of [460, 300]) {
      const tenantId = await seedTenant(c)
      const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: amount })
      const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: amount })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      const at = `${daysAgo(9)}T18:00:00Z`
      const rentId = (await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, manual_method, settled_at)
         VALUES ($1,$2,$3,$4,'rent',$5,'settled',$6::date,'RENT','check',$7) RETURNING id`,
        [unitId, leaseId, tenantId, landlordId, amount, daysAgo(9), at])).rows[0].id
      const id = (await c.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, settled_at)
         VALUES ($1,$2,$3,$4,$4,0,'settled','check',$5) RETURNING id`, [tenantId, leaseId, landlordId, amount, at])).rows[0].id
      await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`, [id, rentId, amount])
      checks.push({ id, rentId })
    }
    co = {
      landlordId, connectionId, ownerId,
      owner: sign({ userId: ownerId, role: 'landlord', email: 'o@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} }),
      bk: sign({ userId: bkId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: 'read_write' } }),
    }
  } finally { c.release() }
  await createSlip({ landlordId: co.landlordId, depositDate: daysAgo(8), receiptIds: checks.map(x => x.id), createdBy: co.ownerId })
  await line(co, 760, daysAgo(8), 'BRANCH DEPOSIT')
  await reconcileDeposits(co.landlordId)
  return { ...co, checkId: checks[0].id, rentId: checks[0].rentId }
}

async function line(co: { landlordId: string; connectionId: string }, amount: number, day: string, description: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status, bank_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'needs_review', 'posted') RETURNING id`,
    [co.connectionId, co.landlordId, randomUUID(), day, amount.toFixed(2), description])).rows[0].id
}

describe('POST /transactions/:id/returned-check', () => {
  it('the owner sees the check under "What did this pay?" and picks it; a bookkeeper sees none and may not', async () => {
    const co = await company()
    // A bare "RETURN ITEM": GAM does not read it as a returned check by itself, the owner may.
    const returned = await line(co, -460, daysAgo(2), 'RETURN ITEM')

    const mine = await request(app()).get(`/api/bank-feed/transactions/${returned}/matches`).set(as(co.owner))
    expect(mine.status).toBe(200)
    expect(mine.body.data.returnedLine).toBe(true)
    expect(mine.body.data.returnedChecks).toEqual([expect.objectContaining({ remittanceId: co.checkId, amount: 460, tenantDeposit: false })])
    const theirs = await request(app()).get(`/api/bank-feed/transactions/${returned}/matches`).set(as(co.bk))
    expect(theirs.status).toBe(200)
    expect(theirs.body.data.returnedChecks).toEqual([])

    expect((await request(app()).post(`/api/bank-feed/transactions/${returned}/returned-check`).set(as(co.bk))
      .send({ remittanceId: co.checkId })).status).toBe(403)
    const done = await request(app()).post(`/api/bank-feed/transactions/${returned}/returned-check`).set(as(co.owner))
      .send({ remittanceId: co.checkId })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data).toMatchObject({ remittanceId: co.checkId, reopenedPaymentIds: [co.rentId] })
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [co.rentId])).rows[0].status).toBe('pending')
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id = $1`, [returned])).rows[0].status).toBe('matched')
  })

  it('never acts on another company’s line or check', async () => {
    const a = await company()
    const b = await company()
    const returnedA = await line(a, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    // Company B's owner cannot reach A's line…
    expect((await request(app()).post(`/api/bank-feed/transactions/${returnedA}/returned-check`).set(as(b.owner))
      .send({ remittanceId: a.checkId })).status).toBe(404)
    // …and A's owner cannot take back B's check on A's line.
    const r = await request(app()).post(`/api/bank-feed/transactions/${returnedA}/returned-check`).set(as(a.owner))
      .send({ remittanceId: b.checkId })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/not a check of \$460.00/)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [b.rentId])).rows[0].status).toBe('settled')
  })
})

describe('POST /transactions/:id/match-payout', () => {
  it('the owner matches a deposit to their own payout; a bookkeeper may not, and another company’s payout never fits', async () => {
    const a = await company()
    const b = await company()
    const payout = async (co: Co) => (await db.query<{ id: string }>(
      `INSERT INTO disbursements (landlord_id, amount, status, settled_at, target_date)
       VALUES ($1, 400.26, 'settled', now() - interval '1 day', CURRENT_DATE - 1) RETURNING id`, [co.landlordId])).rows[0].id
    const pa = await payout(a)
    const pb = await payout(b)
    const dep = await line(a, 400.26, daysAgo(0), 'ST-G5D4S5T9R5P7 TRANSFER OAK PARK MOTEL A CORPORATE ACH')

    expect((await request(app()).post(`/api/bank-feed/transactions/${dep}/match-payout`).set(as(a.bk))
      .send({ disbursementId: pa })).status).toBe(403)
    const foreign = await request(app()).post(`/api/bank-feed/transactions/${dep}/match-payout`).set(as(a.owner))
      .send({ disbursementId: pb })
    expect(foreign.status).toBe(409)
    const ok = await request(app()).post(`/api/bank-feed/transactions/${dep}/match-payout`).set(as(a.owner))
      .send({ disbursementId: pa })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await db.query(`SELECT status, matched_disbursement_id, matched_by FROM bank_transactions WHERE id = $1`, [dep])).rows[0])
      .toEqual({ status: 'matched', matched_disbursement_id: pa, matched_by: expect.any(String) })
  })
})
