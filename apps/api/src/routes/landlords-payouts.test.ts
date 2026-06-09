/**
 * landlords.ts payouts + disputes + payments-history slice — S358
 * (landlords slice 3 of N).
 *
 * Money-adjacent rollups. All three reads gated by
 * `payments.view_all` (opened to team workers per S126); the
 * dispute-respond write stays owner-only (legal/financial action).
 *
 * Coverage focus:
 *   - GET /me/payouts: connect_payouts keyed on landlord's user_id;
 *     status filter; landlord-scoped (cross-landlord excluded)
 *   - GET /me/disputes: connect_disputes landlord-scoped; ordering
 *     priority (needs_response first); pending=true filter narrows
 *   - POST /me/disputes/:id/respond: status guard rejects non-
 *     respondable; cross-landlord 404; happy path stamps
 *     evidence_submitted_at + calls stripe.disputes.update
 *   - GET /me/payments-history: charges + payouts shape, both
 *     landlord-scoped
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
} from '../test/dbHelpers'

const { stripeDisputesUpdateMock, getStripeMock } = vi.hoisted(() => {
  const stripeDisputesUpdateMock = vi.fn(async (..._args: any[]) => ({ id: 'dp_mock', status: 'under_review' }))
  return {
    stripeDisputesUpdateMock,
    getStripeMock: vi.fn(() => ({ disputes: { update: stripeDisputesUpdateMock } })),
  }
})
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getStripe: getStripeMock }
})

import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  stripeDisputesUpdateMock.mockClear()
  stripeDisputesUpdateMock.mockResolvedValue({ id: 'dp_mock', status: 'under_review' } as any)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_payouts'
})

interface PFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedPFixture(): Promise<PFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedPayout(
  userId: string,
  opts: { amount?: number; status?: string; arrivalDate?: string } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO connect_payouts
       (stripe_payout_id, stripe_account_id, user_id, amount, status,
        destination_bank_last4, arrival_date)
     VALUES ($1, 'acct_test', $2, $3, $4, '4321', $5::date)
     RETURNING id`,
    [`po_${randomUUID().slice(0, 8)}`, userId, opts.amount ?? 1000,
     opts.status ?? 'paid', opts.arrivalDate ?? '2026-06-01'])
  return r.rows[0].id
}

async function seedDispute(
  landlordId: string,
  opts: { status?: string; evidenceDueBy?: string | null; amount?: number } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO connect_disputes
       (stripe_dispute_id, stripe_charge_id, landlord_id, amount, status,
        evidence_due_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [`dp_${randomUUID().slice(0, 8)}`, `ch_${randomUUID().slice(0, 8)}`,
     landlordId, opts.amount ?? 250, opts.status ?? 'needs_response',
     opts.evidenceDueBy ?? null])
  return r.rows[0].id
}

describe('GET /api/landlords/me/payouts', () => {
  it('empty → []', async () => {
    const f = await seedPFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/payouts')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('returns payouts keyed on landlord user_id; cross-landlord excluded', async () => {
    const a = await seedPFixture()
    const b = await seedPFixture()
    const aPayout = await seedPayout(a.landlordUserId, { amount: 500, status: 'paid' })
    await seedPayout(b.landlordUserId, { amount: 999, status: 'paid' })

    const res = await request(buildApp())
      .get('/api/landlords/me/payouts')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(aPayout)
    expect(Number(res.body.data[0].amount)).toBe(500)
  })

  it('status query param narrows results', async () => {
    const f = await seedPFixture()
    const paid = await seedPayout(f.landlordUserId, { status: 'paid' })
    await seedPayout(f.landlordUserId, { status: 'failed' })

    const res = await request(buildApp())
      .get('/api/landlords/me/payouts?status=paid')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(paid)
  })
})

describe('GET /api/landlords/me/disputes', () => {
  it('empty → []', async () => {
    const f = await seedPFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/disputes')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('ordering: needs_response first, then warning_needs_response, then others; secondary by evidence_due_by ASC', async () => {
    const f = await seedPFixture()
    // Seed three disputes in mixed order
    const won = await seedDispute(f.landlordId, { status: 'won' })
    const warning = await seedDispute(f.landlordId, {
      status: 'warning_needs_response', evidenceDueBy: '2026-07-01T00:00:00Z',
    })
    const needs = await seedDispute(f.landlordId, {
      status: 'needs_response', evidenceDueBy: '2026-08-01T00:00:00Z',
    })

    const res = await request(buildApp())
      .get('/api/landlords/me/disputes')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(3)
    // needs_response priority 1, warning_needs_response priority 2,
    // everything else 3. So order should be: needs, warning, won.
    expect(res.body.data[0].id).toBe(needs)
    expect(res.body.data[1].id).toBe(warning)
    expect(res.body.data[2].id).toBe(won)
  })

  it('pending=true filter returns only needs_response statuses', async () => {
    const f = await seedPFixture()
    const needs = await seedDispute(f.landlordId, { status: 'needs_response' })
    await seedDispute(f.landlordId, { status: 'won' })

    const res = await request(buildApp())
      .get('/api/landlords/me/disputes?pending=true')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(needs)
  })
})

describe('POST /api/landlords/me/disputes/:id/respond', () => {
  it('happy path: stamps evidence_submitted_at + calls stripe.disputes.update with evidence payload', async () => {
    const f = await seedPFixture()
    const disputeId = await seedDispute(f.landlordId, { status: 'needs_response' })

    const res = await request(buildApp())
      .post(`/api/landlords/me/disputes/${disputeId}/respond`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        evidence: { uncategorized_text: 'rent collected on time', customer_communication: 'em1' },
        response_notes: 'tenant confirmed payment',
      })
    expect(res.status).toBe(200)
    expect(stripeDisputesUpdateMock).toHaveBeenCalledTimes(1)
    const [stripeDisputeId, payload] = stripeDisputesUpdateMock.mock.calls[0]!
    expect(stripeDisputeId).toMatch(/^dp_/)
    expect(payload.evidence).toMatchObject({
      uncategorized_text: 'rent collected on time',
    })

    const row = await db.query<{ evidence_submitted_at: string; response_notes: string }>(
      `SELECT evidence_submitted_at, response_notes FROM connect_disputes WHERE id=$1`,
      [disputeId])
    expect(row.rows[0].evidence_submitted_at).not.toBeNull()
    expect(row.rows[0].response_notes).toBe('tenant confirmed payment')
  })

  it('non-respondable status (won) → 409 + Stripe not called', async () => {
    const f = await seedPFixture()
    const disputeId = await seedDispute(f.landlordId, { status: 'won' })

    const res = await request(buildApp())
      .post(`/api/landlords/me/disputes/${disputeId}/respond`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ evidence: {} })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Cannot submit evidence on a won dispute/)
    expect(stripeDisputesUpdateMock).not.toHaveBeenCalled()
  })

  it('cross-landlord dispute id → 404 + Stripe not called', async () => {
    const a = await seedPFixture()
    const b = await seedPFixture()
    const bDispute = await seedDispute(b.landlordId, { status: 'needs_response' })

    const res = await request(buildApp())
      .post(`/api/landlords/me/disputes/${bDispute}/respond`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ evidence: {} })
    expect(res.status).toBe(404)
    expect(stripeDisputesUpdateMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/landlords/me/payments-history', () => {
  it('returns charges + payouts; both landlord-scoped', async () => {
    const a = await seedPFixture()
    const b = await seedPFixture()

    // Seed an a-scoped charge (rent payment with stripe_payment_intent_id)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: a.landlordId, ownerUserId: a.landlordUserId,
        managedByUserId: a.landlordUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId: a.landlordId })
      const tenantId = await seedTenant(client)
      await client.query(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 'rent', 1500, 'settled', 'RENT', CURRENT_DATE, 'pi_test_abc')`,
        [unitId, tenantId, a.landlordId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    // Seed payouts for a + b
    await seedPayout(a.landlordUserId, { amount: 500, status: 'paid' })
    await seedPayout(b.landlordUserId, { amount: 999, status: 'paid' })

    const res = await request(buildApp())
      .get('/api/landlords/me/payments-history')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.charges.length).toBe(1)
    expect(res.body.data.charges[0].kind).toBe('charge')
    expect(res.body.data.charges[0].stripe_payment_intent_id).toBe('pi_test_abc')
    expect(res.body.data.payouts.length).toBe(1)
    expect(res.body.data.payouts[0].kind).toBe('payout')
    expect(Number(res.body.data.payouts[0].amount)).toBe(500)
  })

  it('charges WHERE filters out pre-Stripe rows (stripe_payment_intent_id NULL)', async () => {
    const f = await seedPFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      const tenantId = await seedTenant(client)
      // Insert a payment with stripe_payment_intent_id = NULL (legacy /
      // off-platform row that shouldn't surface in the Stripe timeline).
      await client.query(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date)
         VALUES ($1, $2, $3, 'rent', 1500, 'settled', 'RENT', CURRENT_DATE)`,
        [unitId, tenantId, f.landlordId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/landlords/me/payments-history')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.charges).toEqual([])
  })
})
