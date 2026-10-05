/**
 * 10/5 (Nic) — PREPAID STAYS at the screening intake and the landlord's decision.
 *
 *   "Charged whether or not they complete the check; the paid check waits for
 *    them (no second charge at intake)." (R8)
 *   "Approving a stay guest's check only clears check-in." (R10)
 *
 * A stay of more than three weeks carried the check's fee on its own payment
 * (services/stayTerms recordScreeningPrepayment). The guest's intake finds that
 * prepayment instead of a card payment, Submit claims it with the check in one
 * transaction, and GAM's $5 is booked once, on the check. Approving the guest
 * clears the stay for check-in and drafts nothing — a stay that chose a lease
 * already has its own draft lease (A8). A decision waits for results (A6), and
 * a provider update never overwrites it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The suite runs every file in one process, so a Stripe key an earlier file set
// ('sk_test_mocked') is still here — and background.ts reads it once, when it
// loads. These tests drive its no-Stripe branch, so the key goes before it loads.
vi.hoisted(() => { delete process.env.STRIPE_SECRET_KEY })

const { stubProvider } = vi.hoisted(() => ({
  stubProvider: {
    name: 'stub',
    initiate: vi.fn(async () => ({ providerRef: 'ref_prepaid', status: 'awaiting_applicant' as const, applicantRedirectUrl: null })),
    verifyWebhook: vi.fn(() => true),
    parseWebhook: vi.fn(),
    craDisclosure: vi.fn(() => ({ name: 'Stub', address: '', phone: '' })),
  },
}))
vi.mock('../services/backgroundProvider', () => ({ getProvider: vi.fn(() => stubProvider) }))
vi.mock('../services/riskScore', () => ({
  calculateRiskScore: vi.fn(async () => ({ score: 10, level: 'low', flags: [] })),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailNewBackgroundCheck: vi.fn(async () => undefined),
  emailBackgroundDecision: vi.fn(async () => undefined),
  emailScreeningApplyLink: vi.fn(async () => undefined),
  emailAdverseActionNotice: vi.fn(async () => 'msg_mock'),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

const SECRET = 'test_jwt_secret_screening_prepaid'
const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/api/background', backgroundRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  stubProvider.initiate.mockClear()
})

interface World {
  landlordId: string; landlordUserId: string; propertyId: string; unitId: string
  tenantId: string; userId: string; email: string
  tenantToken: string; landlordToken: string
}

async function world(): Promise<World> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET background_provider = 'mock' WHERE id = $1`, [landlordId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    const email = `guest-${randomUUID().slice(0, 8)}@test.dev`
    const tenantId = await seedTenant(c, { email })
    const userId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return {
      landlordId, landlordUserId, propertyId, unitId, tenantId, userId, email,
      tenantToken: jwt.sign({ userId, role: 'tenant', email, profileId: tenantId }, SECRET, { expiresIn: '1h' }),
      landlordToken: jwt.sign(
        { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', landlordIds: [landlordId], permissions: {} },
        SECRET, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A 30-night stay on the site, needing screening (R1), with its answer to R2. */
async function stay(w: World, o: { terms?: 'lease' | 'stay' | null; email?: string | null; tenantId?: string | null; unitId?: string } = {}): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, tenant_id, guest_name, guest_email, check_in, check_out, status,
        lease_type, total_amount, stay_terms, screening_required, created_at)
     VALUES ($1, $2, $3, 'Long Stayer', $4, CURRENT_DATE + 3, CURRENT_DATE + 33, 'confirmed',
             'month_to_month', 900, $5, TRUE, NOW() - INTERVAL '1 day')
     RETURNING id`,
    [o.unitId ?? w.unitId, w.landlordId, o.tenantId === undefined ? null : o.tenantId,
     o.email === undefined ? w.email : o.email, o.terms ?? null])
  return b.id
}

async function prepay(w: World, bookingId: string | null, o: { tenantId?: string | null; email?: string | null; landlordId?: string; status?: string } = {}): Promise<string> {
  const { rows: [p] } = await db.query<{ id: string }>(
    `INSERT INTO screening_prepayments (landlord_id, property_id, booking_id, tenant_id, email, amount, source, status)
     VALUES ($1, $2, $3, $4, $5, 42.94, 'register', $6) RETURNING id`,
    [o.landlordId ?? w.landlordId, w.propertyId, bookingId, o.tenantId ?? null,
     o.email === undefined ? w.email : o.email, o.status ?? 'unused'])
  return p.id
}

const askIntent = (w: World, landlordId = w.landlordId) => request(app())
  .post('/api/background/payment-intent')
  .set('Authorization', `Bearer ${w.tenantToken}`)
  .send({ landlordId })

const payload = (w: World, extra: Record<string, unknown> = {}) => ({
  firstName: 'Long', lastName: 'Stayer',
  dateOfBirth: '1988-02-03', ssn: '123-45-6789',
  street1: '1 Main St', city: 'Phoenix', state: 'AZ', zip: '85001',
  consentCredit: true, consentCriminal: true, consentPool: false,
  landlordId: w.landlordId,
  ...extra,
})

const submit = (w: World, body: Record<string, unknown>) => request(app())
  .post('/api/background/submit')
  .set('Authorization', `Bearer ${w.tenantToken}`)
  .send(body)

async function waitFor<T>(read: () => Promise<T | null | undefined>, ms = 3000): Promise<T | null> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = await read()
    if (v) return v
    await new Promise(r => setTimeout(r, 50))
  }
  return null
}

describe('POST /background/payment-intent — a check paid with a stay waits for the guest (R8)', () => {
  it('hands back the prepayment for the guest by their email, and charges nothing', async () => {
    const w = await world()
    const pre = await prepay(w, await stay(w))
    const res = await askIntent(w)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({
      alreadyPaid: true, paidWithStay: true, screeningPrepaymentId: pre, intentId: null, clientSecret: null, amount: 42.94,
    })
  })

  it('finds it by the guest\'s tenant record when the stay was sold to them', async () => {
    const w = await world()
    const pre = await prepay(w, await stay(w, { tenantId: w.tenantId, email: null }), { tenantId: w.tenantId, email: null })
    expect((await askIntent(w)).body.data.screeningPrepaymentId).toBe(pre)
  })

  it('never another company\'s, a used one, or one sold to a different tenant under the same email', async () => {
    const w = await world()
    const other = await world()
    const c = await getClient()
    let stranger: string
    try { stranger = await seedTenant(c) } finally { c.release() }
    await prepay(other, null, { email: w.email })                       // another company
    await prepay(w, null, { status: 'used' })                           // already used
    await prepay(w, null, { tenantId: stranger!, email: w.email })      // someone else's, same email
    const res = await askIntent(w)
    expect(res.status).toBe(200)
    expect(res.body.data.alreadyPaid).toBeFalsy()
    expect(res.body.data.screeningPrepaymentId).toBeUndefined()
  })
})

describe('POST /background/submit with a prepaid check (R8)', () => {
  it('claims the prepayment with the check, for the stay\'s site, and books GAM\'s $5 once', async () => {
    const w = await world()
    const bookingId = await stay(w)
    const pre = await prepay(w, bookingId)
    const res = await submit(w, payload(w, { screeningPrepaymentId: pre }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const checkId = res.body.data.id

    const { rows: [sp] } = await db.query<any>(
      `SELECT status, used_by_check_id, used_at, tenant_id FROM screening_prepayments WHERE id = $1`, [pre])
    expect(sp).toMatchObject({ status: 'used', used_by_check_id: checkId, tenant_id: w.tenantId })
    expect(sp.used_at).not.toBeNull()

    const { rows: [bc] } = await db.query<any>(
      `SELECT applicant_payment_intent_id, amount_charged::text AS amount, unit_id, property_id FROM background_checks WHERE id = $1`, [checkId])
    expect(bc.applicant_payment_intent_id).toBeNull()
    expect(bc.amount).toBe('42.94')                  // what was collected for the check, without card processing
    expect(bc.unit_id).toBe(w.unitId)                // the stay's site, though the page named none
    expect(bc.property_id).toBe(w.propertyId)

    const margin = await waitFor(async () => (await db.query<any>(
      `SELECT amount::text AS amount FROM platform_revenue_ledger
        WHERE type = 'screening_margin' AND reference_id = $1`, [checkId])).rows[0])
    expect(margin?.amount).toBe('5.00')
    // No card spread of its own — the stay's payment charged the card fee once.
    const spread = await db.query(
      `SELECT 1 FROM platform_revenue_ledger WHERE type = 'banking_spread' AND reference_id = $1`, [checkId])
    expect(spread.rows).toHaveLength(0)
  })

  it('a prepayment pays for exactly one check', async () => {
    const w = await world()
    const pre = await prepay(w, await stay(w))
    expect((await submit(w, payload(w, { screeningPrepaymentId: pre }))).status).toBe(201)
    const again = await submit(w, payload(w, { screeningPrepaymentId: pre }))
    expect(again.status).toBe(409)
    expect((await db.query(`SELECT 1 FROM background_checks WHERE user_id = $1`, [w.userId])).rows).toHaveLength(1)
  })

  it('refuses a prepayment paid for someone else, and a renter-pool intake', async () => {
    const w = await world()
    const other = await world()
    const theirs = await prepay(other, await stay(other))
    const res = await submit(w, payload(w, { landlordId: other.landlordId, screeningPrepaymentId: theirs }))
    expect(res.status).toBe(409)
    expect((await db.query(`SELECT status FROM screening_prepayments WHERE id = $1`, [theirs])).rows[0].status).toBe('unused')

    const mine = await prepay(w, await stay(w))
    // (A test database may have no renter-pool shell, which refuses earlier —
    // either way the prepayment is never spent on a pool intake.)
    const pool = await submit(w, payload(w, { landlordId: undefined, consentPool: true, screeningPrepaymentId: mine }))
    expect(pool.status).toBeGreaterThanOrEqual(400)
    expect((await db.query(`SELECT status FROM screening_prepayments WHERE id = $1`, [mine])).rows[0].status).toBe('unused')
  })

  it('ignores a unit from another company named in the body', async () => {
    const w = await world()
    const other = await world()
    const pre = await prepay(w, await stay(w))
    const res = await submit(w, payload(w, { screeningPrepaymentId: pre, unitId: other.unitId }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const { rows: [bc] } = await db.query<any>(`SELECT unit_id FROM background_checks WHERE id = $1`, [res.body.data.id])
    expect(bc.unit_id).toBe(w.unitId)
  })

  it('cancelling a prepaid check puts the paid screening back to wait for them', async () => {
    const w = await world()
    const pre = await prepay(w, await stay(w))
    const sub = await submit(w, payload(w, { screeningPrepaymentId: pre }))
    const res = await request(app())
      .post(`/api/background/${sub.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${w.tenantToken}`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ refunded: false, paidWithStay: true })
    const { rows: [sp] } = await db.query<any>(`SELECT status, used_by_check_id FROM screening_prepayments WHERE id = $1`, [pre])
    expect(sp).toMatchObject({ status: 'unused', used_by_check_id: null })
    expect((await askIntent(w)).body.data.screeningPrepaymentId).toBe(pre)
  })
})

// ── F12: the 30-day stale sweep ────────────────────────────────────────────
describe('the stale-check sweep and a check paid with a stay', () => {
  it('a prepaid check the guest never finished is closed, and its paid screening waits for them again', async () => {
    const w = await world()
    const pre = await prepay(w, await stay(w))
    const sub = await submit(w, payload(w, { screeningPrepaymentId: pre }))
    expect(sub.status, JSON.stringify(sub.body)).toBe(201)
    const checkId = sub.body.data.id
    await db.query(`UPDATE background_checks SET status = 'awaiting_applicant', created_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [checkId])
    const { sweepStaleBackgroundChecks } = await import('../services/backgroundRefund')
    const r = await sweepStaleBackgroundChecks()
    expect(r).toMatchObject({ swept: 1, refunded: 0 })
    expect((await db.query(`SELECT status FROM background_checks WHERE id = $1`, [checkId])).rows[0].status).toBe('cancelled')
    expect((await db.query(`SELECT status, used_by_check_id FROM screening_prepayments WHERE id = $1`, [pre])).rows[0])
      .toEqual({ status: 'unused', used_by_check_id: null })
    expect((await askIntent(w)).body.data.screeningPrepaymentId).toBe(pre)
  })
})

// ── R10 ────────────────────────────────────────────────────────────────────
async function decidableCheck(w: World, o: { unitId?: string | null } = {}): Promise<string> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO background_checks (landlord_id, user_id, tenant_id, unit_id, property_id, status, first_name, last_name, report_summary)
     VALUES ($1, $2, $3, $4, $5, 'complete', 'Long', 'Stayer', '{"result":"clear"}'::jsonb) RETURNING id`,
    [w.landlordId, w.userId, w.tenantId, o.unitId === undefined ? w.unitId : o.unitId, w.propertyId])
  return r.id
}
const decide = (w: World, checkId: string, decision: 'approved' | 'denied') => request(app())
  .patch(`/api/background/${checkId}/decision`)
  .set('Authorization', `Bearer ${w.landlordToken}`)
  .send({ decision })
const intentsOn = async (unitId: string) =>
  (await db.query(`SELECT 1 FROM pending_tenant_intents WHERE unit_id = $1 AND cancelled_at IS NULL`, [unitId])).rows

describe('PATCH /background/:id/decision for a stay guest (R10)', () => {
  it('approving the check a stay paid for clears check-in and drafts nothing', async () => {
    const w = await world()
    const bookingId = await stay(w, { terms: 'stay' })
    const checkId = await decidableCheck(w)
    await db.query(`UPDATE screening_prepayments SET status = 'used', used_by_check_id = $2 WHERE id = $1`,
      [await prepay(w, bookingId), checkId])
    const res = await decide(w, checkId, 'approved')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lease: null, needsUnit: false })
    expect(res.body.data.stay).toMatchObject({ bookingId, clearedForCheckIn: true, terms: 'stay' })
    expect(await intentsOn(w.unitId)).toHaveLength(0)              // no resident record on the site
    expect((await db.query(`SELECT status FROM background_checks WHERE id = $1`, [checkId])).rows[0].status).toBe('approved')
  })

  it('a stay that needs screening on the check\'s site is the stay\'s, with no prepayment too', async () => {
    const w = await world()
    await stay(w)                                       // 30 nights, no answer recorded yet
    const res = await decide(w, await decidableCheck(w), 'approved')
    expect(res.status).toBe(200)
    expect(res.body.data.needsUnit).toBe(false)
    expect(res.body.data.stay?.clearedForCheckIn).toBe(true)
    expect(await intentsOn(w.unitId)).toHaveLength(0)
  })

  it('a check for a different site is not the stay\'s — approval goes on to the lease as before', async () => {
    const w = await world()
    const c = await getClient()
    let otherUnit: string
    try { otherUnit = await seedUnit(c, { propertyId: w.propertyId, landlordId: w.landlordId }) } finally { c.release() }
    await stay(w)
    const res = await decide(w, await decidableCheck(w, { unitId: otherUnit! }), 'approved')
    expect(res.status).toBe(200)
    expect(res.body.data.stay).toBeNull()
    expect(await intentsOn(otherUnit!)).toHaveLength(1)            // recorded on the space it named
  })

  it('A8: a stay that chose a lease drafts no second lease — its own draft is the lease', async () => {
    const w = await world()
    const bookingId = await stay(w, { terms: 'lease' })
    const { draftLeaseFromStay } = await import('../services/stayTerms')
    const { leaseId } = await draftLeaseFromStay(bookingId)
    const checkId = await decidableCheck(w)
    await db.query(`UPDATE screening_prepayments SET status = 'used', used_by_check_id = $2 WHERE id = $1`,
      [await prepay(w, bookingId), checkId])
    const res = await decide(w, checkId, 'approved')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lease: null, needsUnit: false })
    expect(res.body.data.stay).toMatchObject({ bookingId, terms: 'lease', leaseId, clearedForCheckIn: true })
    expect(await intentsOn(w.unitId)).toHaveLength(0)              // no signing packet
    expect((await db.query(`SELECT 1 FROM leases WHERE unit_id = $1`, [w.unitId])).rows).toHaveLength(1)

    // and the explicit Draft lease is refused in plain words, pointing at it
    const again = await request(app())
      .post(`/api/background/${checkId}/draft-lease`)
      .set('Authorization', `Bearer ${w.landlordToken}`).send({})
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already drafted. Open it on the Leases page/)
    expect(await intentsOn(w.unitId)).toHaveLength(0)
  })

  it('A6: a decision before the results are back is refused in plain words', async () => {
    const w = await world()
    const checkId = await decidableCheck(w)
    for (const status of ['submitted', 'processing', 'awaiting_applicant']) {
      await db.query(`UPDATE background_checks SET status = $2 WHERE id = $1`, [checkId, status])
      const res = await decide(w, checkId, 'approved')
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('The background check results aren\'t back yet. You can approve or deny once they are.')
    }
    expect((await db.query(`SELECT status, decided_at FROM background_checks WHERE id = $1`, [checkId])).rows[0])
      .toEqual({ status: 'awaiting_applicant', decided_at: null })
  })

  it('A6: a provider update never overwrites the landlord\'s decision', async () => {
    const w = await world()
    const checkId = await decidableCheck(w)
    await decide(w, checkId, 'approved')
    const { rows: [before] } = await db.query(`SELECT expires_at FROM background_checks WHERE id = $1`, [checkId])
    const { applyProviderUpdate } = await import('../services/backgroundApplyUpdate')
    const check = (await db.query(`SELECT * FROM background_checks WHERE id = $1`, [checkId])).rows[0]
    await applyProviderUpdate({
      provider: stubProvider as any, check, source: 'webhook',
      update: { status: 'complete', reportSummary: { result: 'clear', late: true } } as any,
    })
    const { rows: [after] } = await db.query(`SELECT status, report_summary, expires_at FROM background_checks WHERE id = $1`, [checkId])
    expect(after.status).toBe('approved')
    expect(after.report_summary).toMatchObject({ late: true })
    expect(after.expires_at).toEqual(before.expires_at)
    // an undecided check still takes the provider's status
    const open = await decidableCheck(w)
    await db.query(`UPDATE background_checks SET status = 'processing' WHERE id = $1`, [open])
    await applyProviderUpdate({
      provider: stubProvider as any, check: { id: open, landlord_id: w.landlordId }, source: 'poll',
      update: { status: 'complete' } as any,
    })
    expect((await db.query(`SELECT status FROM background_checks WHERE id = $1`, [open])).rows[0].status).toBe('complete')
  })

  it('the screening list files an approved stay guest as done, not "needs a lease"', async () => {
    const w = await world()
    const bookingId = await stay(w, { terms: 'stay' })
    const checkId = await decidableCheck(w)
    await decide(w, checkId, 'approved')
    const res = await request(app()).get('/api/background').set('Authorization', `Bearer ${w.landlordToken}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r: any) => r.id === checkId)
    expect(row).toMatchObject({ stay_booking_id: bookingId, cleared_for_stay: true, bucket: 'past' })
  })

  it('a guest whose stay chose a lease is cleared for the stay too, with its lease named', async () => {
    const w = await world()
    const bookingId = await stay(w, { terms: 'lease' })
    const { draftLeaseFromStay } = await import('../services/stayTerms')
    const { leaseId } = await draftLeaseFromStay(bookingId)
    const checkId = await decidableCheck(w)
    await decide(w, checkId, 'approved')
    const res = await request(app()).get('/api/background').set('Authorization', `Bearer ${w.landlordToken}`)
    const row = res.body.data.find((r: any) => r.id === checkId)
    expect(row).toMatchObject({ stay_booking_id: bookingId, stay_terms: 'lease', stay_lease_id: leaseId, cleared_for_stay: true, bucket: 'past' })
  })
})
