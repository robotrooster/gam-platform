/**
 * 10/4 (decisions #46.1, Nic, FINAL) — THE LANDLORD'S CHOICE FOR PAID-AHEAD
 * MONEY LEFT ON AN ENDED LEASE (services/paidAheadChoice, routes/paidAheadChoice).
 *
 *   - "No refund" / "Refund the unused days" / "Refund a different amount": a refund
 *     goes back the way the money was paid (earlyCheckOut's refund parts and
 *     runner), the landlord's exact cost shown first;
 *   - after No refund or a partial refund the LANDLORD chooses: "Keep it"
 *     (GAM-held money released once through a prepaid_draw held item; money
 *     the landlord already has is just recorded) or "Leave it as their
 *     credit" (decisions #46.1a: nothing spent or released — it stays their
 *     money paid ahead, GAM-held money released only when it pays a bill, and
 *     it follows the person to their next lease with this landlord);
 *   - a refund goes back the way it was paid on EVERY lease (a stay behind it
 *     or not), comes off Money received on its day with its card fee beside
 *     it, cash handed back reaches the end-of-day drawer, and a chargeback
 *     after Keep it is charged back to the landlord, never absorbed by GAM;
 *   - decided once (409 + fresh view), "Issue refunds" for all of it, the
 *     owner's to-do lists every ended lease waiting on it.
 *
 * Stripe is mocked (refunds, intents).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const h = vi.hoisted(() => {
  const made: any[] = []
  // loseNext: Stripe makes the refund but its answer never arrives (a timeout).
  // listFailNext: Stripe cannot be reached to list refunds.
  const state = { n: 0, failNext: 0, status: 'succeeded', loseNext: 0, listFailNext: 0 }
  return {
    made, state,
    refundsCreate: vi.fn(async (p: any, _o?: any) => {
      if (state.failNext > 0) { state.failNext--; throw new Error('Stripe is down') }
      const r = { id: `re_${++state.n}`, status: state.status, amount: p.amount, payment_intent: p.payment_intent, metadata: p.metadata }
      made.push(r)
      if (state.loseNext > 0) { state.loseNext--; throw new Error('Stripe timed out') }
      return r
    }),
    refundsList: vi.fn(async (p: any) => {
      if (state.listFailNext > 0) { state.listFailNext--; throw new Error('Stripe is unreachable') }
      return { data: made.filter((r) => r.payment_intent === p.payment_intent) }
    }),
    piRetrieve: vi.fn(async (id: string) => ({ id })),
    sendPaymentReceipt: vi.fn(async () => undefined),
  }
})
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ refunds: { create: h.refundsCreate, list: h.refundsList }, paymentIntents: { retrieve: h.piRetrieve } }),
}))
vi.mock('./paymentReceipt', () => ({ sendPaymentReceipt: h.sendPaymentReceipt }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'
import { paidAheadChoiceRouter } from '../routes/paidAheadChoice'
import { landlordsRouter } from '../routes/landlords'
import { createPaidAhead, runWholeBillCheckAfterCommit, clawBackDisputedCharge, isDisputeRetryLater, PAID_AHEAD_PART_TAKEN_BACK, paidAheadCashPressKey } from './creditUse'
import { incomeEvents } from './incomeBasis'
import { generateEodSettlement, generateEodForAllActiveLandlords } from './posEod'
import { ownerStatement } from './ownerStatement'
import { paidAheadChoiceTodos, paidAheadView, carryLeftAfterCommit, unlockSession, releaseAfterSessionLock, stripeUnreachableWords } from './paidAheadChoice'
import { stripeRefundFailed, poolQ, givePartBackInCash } from './earlyCheckOut'
import { paidAheadLeftNotices } from './depositReturn'
import { STAY_SHORTENED_CREDIT_NOTE } from './bookingLeaseBilling'
import { STAY_DEPOSIT_CREDIT_NOTE } from '../jobs/moveInBundle'
import { handlePaymentReversal } from './paymentReversal'

function app() {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  a.use('/api/leases', paidAheadChoiceRouter)
  a.use('/api/landlords', landlordsRouter)
  a.use(errorHandler)
  return a
}

// paid_ahead_choices is new (decisions #46.1) and the shared cleanupAllSchema
// does not clear it yet (reported): this file clears its own rows before and
// after, so neither it nor the next file's cleanup ever trips over them. The
// ledger first (TRUNCATE: a credit use refuses deletion), then the parts.
async function clearChoices() {
  const who = (await db.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0].db
  if (!who.endsWith('_test')) throw new Error(`refusing to clear ${who}`)
  await db.query(`TRUNCATE credit_uses`)
  await db.query(`DELETE FROM stay_refund_parts WHERE paid_ahead_choice_id IS NOT NULL`)
  // Money left as the tenant's credit names the choice that left it (#46.1a).
  await db.query(`UPDATE lease_prepaid_credits SET left_by_choice_id = NULL WHERE left_by_choice_id IS NOT NULL`)
  await db.query(`DELETE FROM paid_ahead_choices`)
}
afterAll(clearChoices)

beforeEach(async () => {
  await clearChoices()
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_paid_ahead_choice'
  h.made.length = 0; h.state.n = 0; h.state.failNext = 0; h.state.status = 'succeeded'; h.state.loseNext = 0; h.state.listFailNext = 0
  for (const m of [h.refundsCreate, h.refundsList, h.piRetrieve, h.sendPaymentReceipt]) m.mockClear()
})

interface F {
  userId: string; landlordId: string; propertyId: string; unitId: string; unitNumber: string
  tenantId: string; leaseId: string; token: string
}

async function seed(o: { status?: 'expired' | 'terminated' | 'active'; endDate?: string } = {}): Promise<F> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET name = 'Oak Park', timezone = 'America/Phoenix', timezone_source = 'manual' WHERE id = $1`, [propertyId])
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET unit_number = 'MH 08' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c)
    await c.query(`UPDATE users SET first_name = 'Glenda', last_name = 'Ross' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 460, status: o.status ?? 'expired', startDate: '2025-10-01' })
    await c.query(`UPDATE leases SET end_date = $2 WHERE id = $1`, [leaseId, o.endDate ?? '2026-09-30'])
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, unitNumber: 'MH 08', tenantId, leaseId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A front-desk worker with these permissions. */
async function staff(f: F, perms: Record<string, boolean>): Promise<string> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Lisa','Desk',TRUE) RETURNING id`, [`desk-${randomUUID()}@t.dev`])
  await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,'{}',TRUE,$3)`,
    [u[0].id, f.landlordId, JSON.stringify(perms)])
  return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/** A receipt the money came in on. */
async function remittance(f: F, o: { amount: number; method: 'card' | 'ach' | 'cash' | 'check' | 'money_order'; intent?: string | null; fee?: number; at?: string }): Promise<string> {
  return (await query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method,
                                     stripe_payment_intent_id, processing_fee_amount, settled_at, created_at)
     VALUES ($1,$2,$3,$4,0,$4,'settled',$5,$6,$7,$8,$8) RETURNING id`,
    [f.tenantId, f.leaseId, f.landlordId, o.amount.toFixed(2), o.method, o.intent ?? null, (o.fee ?? 0).toFixed(2),
     o.at ?? '2026-09-03T17:00:00Z']))[0].id
}

const paidAhead = (f: F, amount: number, fundedBy: 'landlord' | 'gam' | 'reclassified', extra: { sourceRemittanceId?: string; note?: string; receivedAt?: string } = {}) =>
  tx((c) => createPaidAhead(c, {
    leaseId: f.leaseId, tenantId: f.tenantId, amount, fundedBy, receivedAt: extra.receivedAt ?? '2026-09-03T17:00:00Z',
    sourceRemittanceId: extra.sourceRemittanceId ?? null, note: extra.note ?? null,
  }))

const view = (f: F, token = f.token) => request(app()).get(`/api/leases/${f.leaseId}/paid-ahead-choice`).set('Authorization', `Bearer ${token}`)
const decide = async (f: F, body: Record<string, unknown>, token = f.token) => {
  const v = body.quoteToken ? null : (await view(f, token)).body.data
  return request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice`).set('Authorization', `Bearer ${token}`)
    .send({ idempotencyKey: randomUUID(), ...(v ? { quoteToken: v.quoteToken } : {}), ...body })
}
const remaining = async (id: string) => Number((await query<{ r: string }>(`SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE id = $1`, [id]))[0].r)
const heldItems = () => query<any>(`SELECT source_type, source_id, amount::float AS amount, description FROM held_payout_items ORDER BY created_at, id`)
const tenantCredits = () => query<any>(`SELECT tenant_id, lease_id, amount_original::float AS amount, amount_remaining::float AS remaining, category, reason FROM tenant_credits ORDER BY created_at`)
const usesOf = () => query<any>(`SELECT prepaid_credit_id, source, amount::float AS amount, refund_part_id IS NOT NULL AS refund, paid_ahead_choice_id IS NOT NULL AS choice FROM credit_uses ORDER BY (refund_part_id IS NULL), held_at, amount DESC`)
const parts = () => query<any>(`SELECT kind, status, toward_amount::float AS toward, card_fee_back::float AS fee_back, amount::float AS amount,
                                       payout_drop::float AS drop, booking_id, decision_id, paid_ahead_choice_id IS NOT NULL AS on_choice
                                  FROM stay_refund_parts ORDER BY seq`)

describe('the screen', () => {
  it('shows the tenant, the space, the money paid ahead left and how it was paid, with the three refund choices', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 500, method: 'money_order' })
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: rem })
    const r = await view(f)
    expect(r.status).toBe(200)
    const v = r.body.data
    expect(v.tenants).toEqual([{ id: f.tenantId, name: 'Glenda Ross' }])
    expect(v.unit.number).toBe('MH 08')
    expect(v.property.name).toBe('Oak Park')
    expect(v.left).toBe(40)
    expect(v.ended).toBe(true)
    expect(v.waits).toBeNull()
    expect(v.credits).toHaveLength(1)
    expect(v.credits[0]).toMatchObject({ amount: 40, gamHeld: false, howPaid: 'Money order · Sep 3' })
    expect(v.refundOptions.map((o: any) => o.choice)).toEqual(['no_refund', 'refund_all', 'refund_other'])
    expect(v.refundOptions[1].label).toBe('Refund the unused days ($40.00)')
    // Choice46e: before the press it says what will happen — never an order to give the money back now.
    expect(v.refundOptions[1].result).toBe('$40.00 back at the desk — they paid by money order (Money order · Sep 3); you are told to give it back after you confirm')
    expect(v.restOptions.map((o: any) => o.label)).toEqual(['Keep it', 'Leave it as their credit'])
  })

  it('a lease that has not ended waits — its money paid ahead still pays its bills', async () => {
    const f = await seed({ status: 'active', endDate: '2027-09-30' })
    await paidAhead(f, 40, 'landlord')
    const v = (await view(f)).body.data
    expect(v.ended).toBe(false)
    expect(v.waits.words).toMatch(/has not ended/)
    expect(v.refundOptions).toEqual([])
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/has not ended/)
    expect(await remaining((await query<any>(`SELECT id FROM lease_prepaid_credits`))[0].id)).toBe(40)
  })

  it('waits while the move-out is still being worked out, and sends the landlord to the deposit return', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    await query(`INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, status)
                 VALUES ($1, $2, $3, 500, 0, 'draft')`, [f.leaseId, f.tenantId, f.landlordId])
    const v = (await view(f)).body.data
    expect(v.waits.href).toBe(`/leases/${f.leaseId}/deposit-return`)
    expect(v.refundOptions).toEqual([])
  })
})

describe('No refund', () => {
  it('Keep it, money the landlord already has: recorded as theirs, nothing on a payout', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 486, method: 'money_order' })
    const credit = await paidAhead(f, 0.55, 'landlord', { sourceRemittanceId: rem })
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual(['$0.55 is now your money (you already had it).'])
    expect(await remaining(credit)).toBe(0)
    expect(await usesOf()).toEqual([{ prepaid_credit_id: credit, source: 'paid_ahead_choice', amount: 0.55, refund: false, choice: true }])
    expect(await heldItems()).toEqual([])
    expect(await tenantCredits()).toEqual([])
    const pc = (await query<any>(`SELECT refund_choice, rest_choice, left_amount::float AS l, rest_amount::float AS r, released_amount::float AS rel FROM paid_ahead_choices`))[0]
    expect(pc).toEqual({ refund_choice: 'no_refund', rest_choice: 'keep', l: 0.55, r: 0.55, rel: 0 })
  })

  it('Keep it, money GAM holds: released to the landlord once, as a prepaid_draw on their next payout', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 660, method: 'card', intent: 'pi_surplus', fee: 23.65 })
    const credit = await paidAhead(f, 200, 'gam', { sourceRemittanceId: rem })
    const v = (await view(f)).body.data
    expect(v.restOptions[0].result).toBe('$200.00 becomes your money — $200.00 that GAM holds is added to your next payout')
    const key = randomUUID()
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', idempotencyKey: key, quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual(['$200.00 is now your money — $200.00 that GAM held is added to your next payout.'])
    // The same press again (a double click, a retry): what the first did, nothing twice.
    const again = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', idempotencyKey: key, quoteToken: v.quoteToken })
    expect(again.status).toBe(200)
    const use = (await query<any>(`SELECT id FROM credit_uses WHERE prepaid_credit_id = $1`, [credit]))
    expect(use).toHaveLength(1)
    expect(await heldItems()).toEqual([{ source_type: 'prepaid_draw', source_id: use[0].id, amount: 200,
      description: 'MH 08: money paid ahead through GAM on an ended lease, kept by you' }])
    expect(await remaining(credit)).toBe(0)
    expect(h.refundsCreate).not.toHaveBeenCalled()
  })

  it('Leave it as their credit, money GAM holds (decisions #46.1a): nothing is spent or released — it stays their GAM-held money paid ahead, off the screen and the to-do, and no landlord credit is written that could be voided', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 560, method: 'ach', intent: 'pi_ach_surplus' })
    const credit = await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    const v = (await view(f)).body.data
    // The owner is told before confirming that GAM keeps holding it until it pays one of their bills.
    expect(v.restOptions[1].result).toBe('$100.00 stays theirs as money paid ahead — if they rent from you again it pays their bills there, and it cannot be taken back later. GAM keeps holding it for them and pays it to you only when it pays one of their bills.')
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'credit', quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual(['$100.00 stays theirs as money paid ahead — it pays their bills with you if they rent again. GAM keeps holding it for them and pays it to you when it pays one of their bills.'])
    // Still their money paid ahead, still GAM's to hold: nothing spent, nothing on a payout, no tenant credit.
    expect(await remaining(credit)).toBe(100)
    expect(await usesOf()).toEqual([])
    expect(await heldItems()).toEqual([])
    expect(await tenantCredits()).toEqual([])
    const c = (await query<any>(`SELECT lease_id, funded_by, left_by_choice_id FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0]
    expect(c).toMatchObject({ lease_id: f.leaseId, funded_by: 'gam', left_by_choice_id: r.body.data.choice.id })
    expect((await query<any>(`SELECT left_gam_held::float AS g, released_amount::float AS rel, tenant_credit_ids FROM paid_ahead_choices`))[0])
      .toEqual({ g: 100, rel: 0, tenant_credit_ids: [] })
    // Decided once: the screen shows the decision, and the to-do no longer lists it.
    const after = (await view(f)).body.data
    expect(after.left).toBe(0)
    expect(after.refundOptions).toEqual([])
    expect(after.latest.restChoiceLabel).toBe('Leave it as their credit')
    expect(await paidAheadChoiceTodos([f.landlordId])).toEqual([])
    expect(h.refundsCreate).not.toHaveBeenCalled()
  })

  it('a rest choice is required: after No refund the landlord must say Keep it or Leave it as their credit', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 40, 'landlord')
    const r = await decide(f, { refundChoice: 'no_refund' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Choose what happens to the $40.00 that is not refunded — Keep it, or Leave it as their credit — then confirm again.')
    expect(await remaining(credit)).toBe(40)
    expect(await query(`SELECT 1 FROM paid_ahead_choices`)).toHaveLength(0)
  })
})

describe('Refund the unused days (all of it)', () => {
  it('cash the landlord took goes back by hand at the desk, recorded as a refund of the credit', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 500, method: 'cash' })
    const credit = await paidAhead(f, 40, 'landlord', { sourceRemittanceId: rem })
    const r = await decide(f, { refundChoice: 'refund_all' })
    expect(r.status).toBe(200)
    // The reply to the press is the order to the worker standing there…
    expect(r.body.data.words).toEqual(['Hand back $40.00 in cash now.'])
    // …the record (and every later visit) says it was handed back — never an order again.
    expect(r.body.data.choice.words).toEqual(['$40.00 handed back in cash.'])
    expect((await view(f)).body.data.latest.words).toEqual(['$40.00 handed back in cash.'])
    expect(await parts()).toEqual([{ kind: 'cash', status: 'handed_back', toward: 40, fee_back: 0, amount: 40, drop: 0,
      booking_id: null, decision_id: null, on_choice: true }])
    expect(await usesOf()).toEqual([{ prepaid_credit_id: credit, source: 'refund', amount: 40, refund: true, choice: false }])
    expect(await remaining(credit)).toBe(0)
    expect(await heldItems()).toEqual([])
    // Nothing is left, so no rest choice was recorded.
    expect((await query<any>(`SELECT rest_choice FROM paid_ahead_choices`))[0].rest_choice).toBeNull()
  })

  it('a long stay\'s card money goes back to that same card with the card fee, and the landlord\'s exact cost is shown first: only the card fee given back comes off their payout (GAM held the money)', async () => {
    const f = await seed()
    // The lease came from a stay on the schedule.
    const booking = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, lease_type, nightly_rate, total_amount, status)
       VALUES ($1,$2,'Glenda Ross','2026-08-01','2026-09-30',60,'long_term',0,1000,'checked_out') RETURNING id`, [f.unitId, f.landlordId]))[0].id
    await query(`UPDATE leases SET source_booking_id = $2 WHERE id = $1`, [f.leaseId, booking])
    const rem = await remittance(f, { amount: 1200, method: 'card', intent: 'pi_card_ahead', fee: 42.55 })
    const credit = await paidAhead(f, 200, 'gam', { sourceRemittanceId: rem })
    const v = (await view(f)).body.data
    const all = v.refundOptions.find((o: any) => o.choice === 'refund_all')
    expect(all.result).toBe('$207.09 back to the card they paid with (Card · Sep 3)')
    // GAM still holds this money (it was never paid to the landlord): only the card fee given back comes off their payout,
    // said as that — never "more than you were paid" (review fix pass 3).
    expect(all.refund.cost).toBe('Stripe keeps its processing fee on a refund, and that is your cost: your next payout drops by $7.09 — the card fee they get back; the refund itself comes out of the money GAM holds for them, which was never paid to you.')
    expect(all.refund).toMatchObject({ amount: 200, rest: 0, restOptions: [] })
    const r = await decide(f, { refundChoice: 'refund_all', quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(h.refundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: 'pi_card_ahead', amount: 20709 })
    expect(r.body.data.words).toEqual(['$207.09 back to the card they paid with (Card · Sep 3) — sent.'])
    expect(await parts()).toEqual([{ kind: 'card', status: 'refunded', toward: 200, fee_back: 7.09, amount: 207.09, drop: 7.09,
      booking_id: booking, decision_id: null, on_choice: true }])
    expect(await heldItems()).toEqual([expect.objectContaining({ source_type: 'refund', amount: -7.09 })])
    expect(await remaining(credit)).toBe(0)
  })

  // Review fix (choice46b): earlyCheckOut's runner reads a part with no stay
  // (a LEFT JOIN; its unit from this choice's lease), so card money on an
  // ordinary lease goes back to that same card like any other.
  it('card money on an ordinary lease (no stay behind it) goes back to that same card with the card fee; the payout line and the notice name money paid ahead, never "left early"', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 1200, method: 'card', intent: 'pi_card_plain', fee: 42.55 })
    const credit = await paidAhead(f, 200, 'gam', { sourceRemittanceId: rem })
    const v = (await view(f)).body.data
    expect(v.maxRefund).toBe(200)
    expect(v.refundNotes).toEqual([])
    expect(v.refundOptions.map((o: any) => o.choice)).toEqual(['no_refund', 'refund_all', 'refund_other'])
    const r = await decide(f, { refundChoice: 'refund_all', quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(h.refundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: 'pi_card_plain', amount: 20709 })
    expect(h.refundsCreate.mock.calls[0][0].metadata).toMatchObject({ gam_purpose: 'stay_early_checkout_refund' })
    expect(h.refundsCreate.mock.calls[0][0].metadata.gam_booking_id).toBeUndefined()
    expect(await parts()).toEqual([{ kind: 'card', status: 'refunded', toward: 200, fee_back: 7.09, amount: 207.09, drop: 7.09,
      booking_id: null, decision_id: null, on_choice: true }])
    expect(await heldItems()).toEqual([{ source_type: 'refund', source_id: h.made[0].id, amount: -7.09,
      description: 'Refund of money paid ahead on MH 08 (card fee included)' }])
    expect(await remaining(credit)).toBe(0)
    // Stripe sends it back: the put-back line and the owner's notice name money paid ahead and open THIS screen.
    expect(await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })).toBe(true)
    expect((await heldItems())[1]).toMatchObject({ source_type: 'refund', amount: 7.09,
      description: 'A refund of money paid ahead on MH 08 came back — put back on your payout until it is sent again' })
    const n = await query<any>(`SELECT title, body, action_url FROM notifications WHERE type = 'stay_refund_failed'`)
    expect(n).toHaveLength(1)
    expect(n[0].action_url).toBe(`/leases/${f.leaseId}/paid-ahead-choice`)
    expect(n[0].title).toBe('A refund of money paid ahead on MH 08 came back')
    expect(`${n[0].title} ${n[0].body}`).not.toMatch(/left early|the stay|schedule/)
  })

  it('a landlord-held bank deposit is given back by the landlord — never called "cash"', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 500, method: 'ach', intent: null })
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: rem })
    const v = (await view(f)).body.data
    const all = v.refundOptions.find((o: any) => o.choice === 'refund_all')
    expect(all.result).toBe('$40.00 for you to give back — they paid by bank deposit (Bank deposit · Sep 3); you are told to give it back after you confirm')
    const r = await decide(f, { refundChoice: 'refund_all', quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual(['Give back $40.00 — they paid by bank deposit (Bank deposit · Sep 3).'])
    expect(r.body.data.choice.words).toEqual(['$40.00 given back — they paid by bank deposit (Bank deposit · Sep 3).'])
    expect([...r.body.data.words, ...r.body.data.choice.words].join(' ')).not.toMatch(/cash/)
  })

  it('a card refund that does not go out is said plainly in this screen\'s own words (press first, cash only after GAM checks), waits for Try again, and Try again sends it once', async () => {
    const f = await seed()
    const booking = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, lease_type, nightly_rate, total_amount, status)
       VALUES ($1,$2,'Glenda Ross','2026-08-01','2026-09-30',60,'long_term',0,1000,'checked_out') RETURNING id`, [f.unitId, f.landlordId]))[0].id
    await query(`UPDATE leases SET source_booking_id = $2 WHERE id = $1`, [f.leaseId, booking])
    const rem = await remittance(f, { amount: 1000, method: 'card', intent: 'pi_retry', fee: 0 })
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    h.state.failNext = 1
    const r = await decide(f, { refundChoice: 'refund_all' })
    expect(r.status).toBe(200)
    expect(r.body.data.next).toBe('try_again')
    // Said once: on the part's own line with Try again (its failure), never in the summary as well.
    expect(r.body.data.words).toEqual([])
    expect(r.body.data.choice.parts).toEqual([expect.objectContaining({ status: 'failed', stale: false,
      failure: 'Stripe could not send this refund just now ($100.00) — press Try again, or press "Give it back in cash instead" (GAM first checks that it did not reach the card, then tells you when to hand the cash over).' })])
    // Choice46d: never earlyCheckOut's "hand it back in cash and press …" (cash before GAM has checked).
    expect(r.body.data.choice.parts[0].failure).not.toMatch(/hand it back in cash and press/)
    expect((await paidAheadChoiceTodos([f.landlordId])).map((t) => t.type)).toEqual(['paid_ahead_refund_retry'])
    const partId = r.body.data.choice.parts[0].id
    const again = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${partId}/retry`).set('Authorization', `Bearer ${f.token}`)
    expect(again.status).toBe(200)
    expect(again.body.data.next).toBe('done')
    expect(h.refundsCreate).toHaveBeenCalledTimes(2)
    expect(h.made).toHaveLength(1)
    expect(await paidAheadChoiceTodos([f.landlordId])).toEqual([])
  })
})

/** The lease came from a long stay on the schedule. */
async function fromStay(f: F): Promise<string> {
  const booking = (await query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, lease_type, nightly_rate, total_amount, status)
     VALUES ($1,$2,'Glenda Ross','2026-08-01','2026-09-30',60,'long_term',0,1000,'checked_out') RETURNING id`, [f.unitId, f.landlordId]))[0].id
  await query(`UPDATE leases SET source_booking_id = $2 WHERE id = $1`, [f.leaseId, booking])
  return booking
}

describe('a card refund that Stripe sends back, or that never went out', () => {
  it('Stripe sending it back: the part is reversed and replaced ON THIS CHOICE (never a crash on the parent check), the payout line is put back, and Try again here sends it again', async () => {
    const f = await seed()
    await fromStay(f)
    const rem = await remittance(f, { amount: 1200, method: 'card', intent: 'pi_back', fee: 42.55 })
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    const r = await decide(f, { refundChoice: 'refund_all' })
    expect(r.status).toBe(200)
    expect(h.made).toHaveLength(1)
    // The card company sends it back (refund.updated → failed).
    expect(await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })).toBe(true)
    const rows = await query<any>(
      `SELECT id, status, reversed_at IS NOT NULL AS reversed, paid_ahead_choice_id, decision_id, replaces_part_id
         FROM stay_refund_parts ORDER BY created_at, seq`)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ status: 'refunded', reversed: true, decision_id: null })
    expect(rows[1]).toMatchObject({ status: 'failed', reversed: false, decision_id: null, replaces_part_id: rows[0].id,
      paid_ahead_choice_id: rows[0].paid_ahead_choice_id })
    expect(rows[1].paid_ahead_choice_id).toBeTruthy()
    // Stripe kept nothing of the landlord's on a refund that came back: the line is put back.
    expect((await heldItems()).map((i) => [i.source_type, i.amount])).toEqual([['refund', -3.55], ['refund', 3.55]])
    // The screen shows it once, with Try again; the owner's to-do lists it.
    const v = (await view(f)).body.data
    expect(v.latest.parts).toEqual([expect.objectContaining({ id: rows[1].id, status: 'failed' })])
    expect(v.latest.words).toEqual([])
    expect((await paidAheadChoiceTodos([f.landlordId])).map((t) => t.type)).toEqual(['paid_ahead_refund_retry'])
    const again = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${rows[1].id}/retry`).set('Authorization', `Bearer ${f.token}`)
    expect(again.status).toBe(200)
    expect(again.body.data.next).toBe('done')
    expect(h.made).toHaveLength(2)
    expect((await heldItems()).map((i) => [i.source_type, i.amount])).toEqual([['refund', -3.55], ['refund', 3.55], ['refund', -3.55]])
    expect(await paidAheadChoiceTodos([f.landlordId])).toEqual([])
  })

  it('a refund left "sending" for 10+ minutes (a crash before Stripe) is on the to-do, offered Try again, and opening the screen sends it once', async () => {
    const f = await seed()
    const booking = await fromStay(f)
    const rem = await remittance(f, { amount: 1000, method: 'card', intent: 'pi_stale', fee: 0 })
    const credit = await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    // What a crash right after the decision committed leaves behind.
    const choice = (await query<{ id: string }>(
      `INSERT INTO paid_ahead_choices (lease_id, landlord_id, left_amount, refund_choice, refund_total, rest_amount, idempotency_key, decided_by)
       VALUES ($1,$2,100,'refund_all',100,0,$3,$4) RETURNING id`, [f.leaseId, f.landlordId, randomUUID(), f.userId]))[0].id
    const part = (await query<{ id: string }>(
      `INSERT INTO stay_refund_parts (paid_ahead_choice_id, booking_id, landlord_id, seq, kind, remittance_id, prepaid_credit_id,
                                      stripe_payment_intent_id, toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label, status, created_at)
       VALUES ($1,$2,$3,1,'card',$4,$5,'pi_stale',100,0,100,0,0,'Card · Sep 3','pending', NOW() - INTERVAL '15 minutes') RETURNING id`,
      [choice, booking, f.landlordId, rem, credit]))[0].id
    await query(
      `INSERT INTO credit_uses (prepaid_credit_id, refund_part_id, lease_id, amount, billing_month, source, status, applied_at, created_by)
       VALUES ($1,$2,$3,100,'2026-10-01','refund','applied',NOW(),$4)`, [credit, part, f.leaseId, f.userId])
    expect((await paidAheadChoiceTodos([f.landlordId])).map((t) => t.type)).toEqual(['paid_ahead_refund_retry'])
    // Read as it stands: offered Try again, said once (not "sending now").
    const before = await paidAheadView(poolQ, f.leaseId)
    expect(before.latest!.parts).toEqual([expect.objectContaining({ id: part, status: 'pending', stale: true,
      words: '$100.00 to the card has not gone out yet — press Try again' })])
    expect(before.latest!.words).toEqual([])
    // Opening the screen sends it.
    const v = (await view(f)).body.data
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(v.latest.parts).toEqual([expect.objectContaining({ id: part, status: 'refunded', stale: false })])
    expect(v.latest.words).toEqual(['$100.00 back to the card they paid with (Card · Sep 3) — sent.'])
    expect(await paidAheadChoiceTodos([f.landlordId])).toEqual([])
    // Opening it again sends nothing more.
    await view(f)
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
  })
})

describe('the move-out comes first (decisions #46.2)', () => {
  it('a security deposit still held with no move-out done: waits and sends the landlord to the deposit return; the to-do says so; once the move-out is done the choice opens', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    await query(`INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
                 VALUES ($1,$2,$3,500,500,'funded','landlord')`, [f.unitId, f.leaseId, f.tenantId])
    const v = (await view(f)).body.data
    expect(v.waits).toEqual({ words: 'This lease still has a $500.00 security deposit that has not been settled. Do the move-out first — deductions come out of the deposit, and the money paid ahead only covers what the deposit cannot — then come back here.',
      href: `/leases/${f.leaseId}/deposit-return`, linkLabel: 'Start the deposit return' })
    expect(v.refundOptions).toEqual([])
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', quoteToken: v.quoteToken })
    expect(r.status).toBe(409)
    expect(await query(`SELECT 1 FROM paid_ahead_choices`)).toHaveLength(0)
    const todo = await paidAheadChoiceTodos([f.landlordId])
    expect(todo).toHaveLength(1)
    expect(todo[0].subtitle).toBe('Oak Park · $40.00 paid ahead is still on a lease that ended Sep 30 — finish the move-out first, then decide it')
    await query(`INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, status)
                 VALUES ($1, $2, $3, 500, 0, 'sent_refund')`, [f.leaseId, f.tenantId, f.landlordId])
    const after = (await view(f)).body.data
    expect(after.waits).toBeNull()
    expect(after.refundOptions.map((o: any) => o.choice)).toEqual(['no_refund', 'refund_all', 'refund_other'])
    expect((await paidAheadChoiceTodos([f.landlordId]))[0].subtitle).toMatch(/refund it, keep it, or leave it as their credit$/)
  })

  it('money still owed on the lease with no move-out done: waits — what is paid ahead pays what is owed before anything is refunded or kept', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    await query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','2026-09-01','RENT','landlord')`, [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    const v = (await view(f)).body.data
    expect(v.waits.words).toBe('They still owe $460.00 on this lease. Do the move-out first — the money paid ahead pays what is owed before anything is refunded or kept — then come back here.')
    expect(v.waits.href).toBe(`/leases/${f.leaseId}/deposit-return`)
    expect(v.refundOptions).toEqual([])
  })
})

describe('Refund a different amount', () => {
  it('partial refund + Keep it: the refund goes back the way it was paid, the rest becomes the landlord\'s', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 600, method: 'check' })
    const credit = await paidAhead(f, 140, 'landlord', { sourceRemittanceId: rem })
    const p = await request(app()).get(`/api/leases/${f.leaseId}/paid-ahead-choice/refund-preview?amount=100`).set('Authorization', `Bearer ${f.token}`)
    expect(p.status).toBe(200)
    expect(p.body.data).toMatchObject({ amount: 100, rest: 40, cost: null })
    expect(p.body.data.parts[0].words).toBe('$100.00 back at the desk — they paid by check (Check · Sep 3); you are told to give it back after you confirm')
    expect(p.body.data.restOptions[0].result).toBe('$40.00 becomes your money — you already have it, so it is recorded as yours')
    const r = await decide(f, { refundChoice: 'refund_other', refundAmount: 100, restChoice: 'keep' })
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual(['Give back $100.00 — they paid by check (Check · Sep 3).', '$40.00 is now your money (you already had it).'])
    expect(r.body.data.choice.words).toEqual(['$100.00 given back — they paid by check (Check · Sep 3).', '$40.00 is now your money (you already had it).'])
    expect(await usesOf()).toEqual([
      { prepaid_credit_id: credit, source: 'refund', amount: 100, refund: true, choice: false },
      { prepaid_credit_id: credit, source: 'paid_ahead_choice', amount: 40, refund: false, choice: true },
    ])
    expect(await remaining(credit)).toBe(0)
    expect(await tenantCredits()).toEqual([])
  })

  it('partial refund + Leave it as their credit, money the landlord holds: the refund is handed back, the rest stays their money paid ahead that the landlord holds for them — no landlord credit, nothing on a payout', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 600, method: 'cash' })
    const credit = await paidAhead(f, 140, 'landlord', { sourceRemittanceId: rem })
    const p = await request(app()).get(`/api/leases/${f.leaseId}/paid-ahead-choice/refund-preview?amount=90`).set('Authorization', `Bearer ${f.token}`)
    expect(p.body.data.restOptions[1].result).toBe('$50.00 stays theirs as money paid ahead — if they rent from you again it pays their bills there, and it cannot be taken back later. You already have it, and you hold it for them.')
    const r = await decide(f, { refundChoice: 'refund_other', refundAmount: 90, restChoice: 'credit' })
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual(['Hand back $90.00 in cash now.', '$50.00 stays theirs as money paid ahead — it pays their bills with you if they rent again. You hold it for them.'])
    expect(await remaining(credit)).toBe(50)
    expect(await usesOf()).toEqual([{ prepaid_credit_id: credit, source: 'refund', amount: 90, refund: true, choice: false }])
    expect(await tenantCredits()).toEqual([])
    expect(await heldItems()).toEqual([])
    expect((await query<any>(`SELECT left_by_choice_id FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0].left_by_choice_id).toBe(r.body.data.choice.id)
  })

  it('more than can go back is refused in plain words and nothing changes', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 40, 'landlord')
    const r = await decide(f, { refundChoice: 'refund_other', refundAmount: 41, restChoice: 'keep' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('That is more than can be refunded — $40.00 at most. Change the amount, then confirm again.')
    expect(await remaining(credit)).toBe(40)
  })
})

describe('money left as their credit follows the person to their next lease here (decisions #46.1a)', () => {
  /** They rent another space from the same landlord: a lease in force with them on it, and its first bill. */
  const rentAgain = (f: F) => tx(async (c) => {
    const unit2 = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
    const lease2 = await seedLease(c, { unitId: unit2, landlordId: f.landlordId, rentAmount: 460, status: 'active', startDate: '2026-11-01' })
    await seedLeaseTenant(c, { leaseId: lease2, tenantId: f.tenantId, role: 'primary' })
    const rent = (await c.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','2026-11-01','RENT','landlord') RETURNING id`,
      [unit2, lease2, f.tenantId, f.landlordId])).rows[0].id
    return { lease2, rent }
  })

  it('money the landlord holds: it moves to the new lease once they are on it, pays that lease\'s whole bill, and is never paid out', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 500, 'landlord')
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    const { lease2, rent } = await rentAgain(f)
    const moved = (await query<any>(`SELECT lease_id, left_by_choice_id, funded_by FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0]
    expect(moved).toEqual({ lease_id: lease2, left_by_choice_id: null, funded_by: 'landlord' })
    await runWholeBillCheckAfterCommit({ tenantId: f.tenantId, landlordId: f.landlordId })
    expect((await query<any>(`SELECT status FROM payments WHERE id = $1`, [rent]))[0].status).toBe('settled')
    const used = await query<any>(`SELECT prepaid_credit_id, payment_id, amount::float AS amount, lease_id FROM credit_uses WHERE payment_id IS NOT NULL`)
    expect(used).toEqual([{ prepaid_credit_id: credit, payment_id: rent, amount: 460, lease_id: lease2 }])
    expect(await remaining(credit)).toBe(40)
    expect(await heldItems()).toEqual([])
    expect(await tenantCredits()).toEqual([])
  })

  it('money GAM holds: GAM keeps it until it pays a bill on the new lease, and only that bill\'s part is the landlord\'s to be paid out', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 960, method: 'card', intent: 'pi_left_gam', fee: 0 })
    const credit = await paidAhead(f, 500, 'gam', { sourceRemittanceId: rem })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    expect(await heldItems()).toEqual([])
    const { rent } = await rentAgain(f)
    await runWholeBillCheckAfterCommit({ tenantId: f.tenantId, landlordId: f.landlordId })
    const pay = (await query<any>(
      `SELECT p.status, p.platform_held, vm.gam_held_part::float AS gam_part FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id WHERE p.id = $1`, [rent]))[0]
    expect(pay).toEqual({ status: 'settled', platform_held: true, gam_part: 460 })
    expect(await remaining(credit)).toBe(40)
  })

  it('already on another lease here when the choice is made: it moves there at once', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 60, 'landlord')
    const { lease2 } = await rentAgain(f)
    expect((await query<any>(`SELECT lease_id FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0].lease_id).toBe(f.leaseId)
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    expect((await query<any>(`SELECT lease_id, left_by_choice_id FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0])
      .toEqual({ lease_id: lease2, left_by_choice_id: null })
  })

  it('a lease with another landlord never takes it', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 60, 'landlord')
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    await tx(async (c) => {
      const other = await seedLandlord(c)
      const prop = await seedProperty(c, { landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId })
      const unit = await seedUnit(c, { propertyId: prop, landlordId: other.landlordId })
      const lease = await seedLease(c, { unitId: unit, landlordId: other.landlordId, status: 'active', startDate: '2026-11-01' })
      await seedLeaseTenant(c, { leaseId: lease, tenantId: f.tenantId, role: 'primary' })
    })
    expect((await query<any>(`SELECT lease_id, left_by_choice_id IS NOT NULL AS left FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0])
      .toEqual({ lease_id: f.leaseId, left: true })
  })
})

describe('decided once', () => {
  it('a second decision gets a 409 in plain words with the fresh page, and changes nothing', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 40, 'landlord')
    const v = (await view(f)).body.data
    const first = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', quoteToken: v.quoteToken })
    expect(first.status).toBe(200)
    // Someone else, on the page they had open (a different press).
    const second = await decide(f, { refundChoice: 'refund_all', quoteToken: v.quoteToken })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('already_decided')
    expect(second.body.error).toMatch(/^Test Landlord already decided this on [A-Z][a-z]{2} \d+: No refund, then Keep it\. Nothing else was changed\.$/)
    expect(second.body.data.left).toBe(0)
    expect(second.body.data.latest.restChoiceLabel).toBe('Keep it')
    expect(await query(`SELECT 1 FROM paid_ahead_choices`)).toHaveLength(1)
    expect(await usesOf()).toHaveLength(1)
    expect(await remaining(credit)).toBe(0)
  })

  it('money that changed since the page loaded is a 409 with the latest, never a choice on old figures', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 40, 'landlord')
    const v = (await view(f)).body.data
    await paidAhead(f, 10, 'landlord', { receivedAt: '2026-09-20T17:00:00Z' })
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', quoteToken: v.quoteToken })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('paid_ahead_changed')
    expect(r.body.data.left).toBe(50)
    expect(await remaining(credit)).toBe(40)
  })
})

describe('permission', () => {
  it('staff without "Issue refunds" are refused in plain words, see nothing and change nothing; with it they can decide', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 40, 'landlord')
    const desk = await staff(f, { 'guests.check_out': true })
    const seen = await view(f, desk)
    expect(seen.status).toBe(403)
    expect(seen.body.error).toBe('Deciding what happens to money paid ahead needs the "Issue refunds" permission, and nothing was changed. Ask the account owner to turn it on for you in My Team.')
    const tried = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice`).set('Authorization', `Bearer ${desk}`)
      .send({ refundChoice: 'no_refund', restChoice: 'keep', quoteToken: 'x', idempotencyKey: randomUUID() })
    expect(tried.status).toBe(403)
    expect(await remaining(credit)).toBe(40)
    const refunder = await staff(f, { 'pos.refund': true })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' }, refunder)).status).toBe(200)
  })
})

describe('after an early check-out', () => {
  it('money a stay\'s check-out already answered "No refund" for is not offered a refund again — only Keep it / Leave it as their credit', async () => {
    const f = await seed()
    const booking = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, lease_type, nightly_rate, total_amount, status)
       VALUES ($1,$2,'Glenda Ross','2026-08-01','2026-09-30',60,'long_term',0,1000,'checked_out') RETURNING id`, [f.unitId, f.landlordId]))[0].id
    await query(`UPDATE leases SET source_booking_id = $2 WHERE id = $1`, [f.leaseId, booking])
    await query(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, lease_id, left_on, question, choice, status, booked_price, stayed_worth, paid, decided_at)
       VALUES ($1,$2,$3,'2026-09-30','overpaid','no_refund','decided',1000,700,300,NOW())`, [booking, f.landlordId, f.leaseId])
    const credit = await paidAhead(f, 300, 'reclassified', { note: STAY_SHORTENED_CREDIT_NOTE })
    const v = (await view(f)).body.data
    expect(v.refundAnswered).toBe(300)
    expect(v.maxRefund).toBe(0)
    expect(v.refundOptions.map((o: any) => o.choice)).toEqual(['no_refund'])
    expect(v.credits[0].refundAnswered).toBe(true)
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(await remaining(credit)).toBe(0)
    // Rent banked at a shortened stay was already the landlord's money: nothing to release.
    expect(await heldItems()).toEqual([])
  })

  it('while the stay\'s own money question is still open, this screen waits and points at the stay', async () => {
    const f = await seed()
    const booking = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, lease_type, nightly_rate, total_amount, status)
       VALUES ($1,$2,'Glenda Ross','2026-08-01','2026-09-30',60,'long_term',0,1000,'checked_out') RETURNING id`, [f.unitId, f.landlordId]))[0].id
    await query(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, lease_id, left_on, question, status, booked_price, stayed_worth, paid)
       VALUES ($1,$2,$3,'2026-09-30','overpaid','pending',1000,700,300)`, [booking, f.landlordId, f.leaseId])
    await paidAhead(f, 300, 'reclassified', { note: STAY_SHORTENED_CREDIT_NOTE })
    const v = (await view(f)).body.data
    expect(v.waits.href).toBe(`/schedule?checkout=${booking}&unit=${f.unitId}`)
    expect(v.refundOptions).toEqual([])
    // The stay's own to-do covers it: not listed twice.
    expect(await paidAheadChoiceTodos([f.landlordId])).toEqual([])
  })
})

describe('the owner\'s to-do', () => {
  it('lists every ended lease still waiting on this choice, opens the screen, and goes away once decided', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    const r = await request(app()).get('/api/landlords/me/todos').set('Authorization', `Bearer ${f.token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.paidAhead).toEqual([{
      id: `paid-ahead-${f.leaseId}`, type: 'paid_ahead_choice',
      title: 'Decide the money paid ahead: Glenda Ross (MH 08)',
      subtitle: 'Oak Park · $40.00 paid ahead is still on a lease that ended Sep 30 — refund it, keep it, or leave it as their credit',
      href: `/leases/${f.leaseId}/paid-ahead-choice`,
    }])
    expect(r.body.data.counts.paidAhead).toBe(1)
    await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })
    const after = await request(app()).get('/api/landlords/me/todos').set('Authorization', `Bearer ${f.token}`)
    expect(after.body.data.paidAhead).toEqual([])
  })

  it('a lease still running is not on it', async () => {
    const f = await seed({ status: 'active', endDate: '2027-09-30' })
    await paidAhead(f, 40, 'landlord')
    expect(await paidAheadChoiceTodos([f.landlordId])).toEqual([])
  })
})

describe('GAM\'s notice after a move-out (deposit_return_paid_ahead_left)', () => {
  it('points at the landlord\'s screen with every choice named', async () => {
    const f = await seed()
    await paidAhead(f, 60, 'landlord')
    const n = await paidAheadLeftNotices(f.leaseId, 60)
    expect(n).toHaveLength(1)
    expect(n[0].href).toMatch(new RegExp(`/leases/${f.leaseId}/paid-ahead-choice$`))
    expect(n[0].body).toContain(n[0].href)
    expect(n[0].body).toMatch(/the landlord decides — No refund, Refund all of it, or Refund a different amount, then for anything not refunded, Keep it or Leave it as their credit/)
    expect(n[0].earlyCheckOut).toBeNull()
  })

  it('money a stay\'s check-out answered "No refund" for: the landlord still chooses Keep it or Leave it as their credit, and it is still the tenant\'s until then', async () => {
    const f = await seed()
    const booking = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, lease_type, nightly_rate, total_amount, status)
       VALUES ($1,$2,'Glenda Ross','2026-08-01','2026-09-30',60,'long_term',0,1000,'checked_out') RETURNING id`, [f.unitId, f.landlordId]))[0].id
    await query(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, lease_id, left_on, question, choice, status, booked_price, stayed_worth, paid, decided_at)
       VALUES ($1,$2,$3,'2026-09-30','overpaid','no_refund','decided',1000,700,300,NOW())`, [booking, f.landlordId, f.leaseId])
    await paidAhead(f, 300, 'reclassified', { note: STAY_SHORTENED_CREDIT_NOTE })
    const n = await paidAheadLeftNotices(f.leaseId, 300)
    expect(n).toHaveLength(1)
    expect(n[0].earlyCheckOut).toBe('decided')
    // The day they left as a plain day, never a raw date string.
    expect(n[0].body).toContain('rent paid past the day the tenant left (Sep 30, 2026)')
    expect(n[0].body).toMatch(/already chose “No refund \(keep the price as booked\)” for it when the guest was checked out, so they are not asked about a refund again/)
    expect(n[0].body).toMatch(/They still choose what happens to it — Keep it, or Leave it as their credit/)
    expect(n[0].body).toContain(n[0].href)
    expect(n[0].body).toMatch(/still the tenant’s money paid ahead/)
    expect(n[0].body).not.toMatch(/landlord’s/)
  })
})

// ─── Review fix pass 3 ───────────────────────────────────────────────────────

describe('Refund all that can go back (part of it cannot)', () => {
  it('the option names its own rest and that rest\'s choices — never the whole amount\'s — and the decision is named as pressed', async () => {
    const f = await seed()
    // $40 cash the landlord took (refundable by hand) + $200 GAM holds with no payment on file to send it back to.
    const cash = await remittance(f, { amount: 500, method: 'cash', at: '2026-09-10T17:00:00Z' })
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: cash, receivedAt: '2026-09-10T17:00:00Z' })
    await paidAhead(f, 200, 'gam')
    const v = (await view(f)).body.data
    expect(v.left).toBe(240)
    expect(v.maxRefund).toBe(40)
    const all = v.refundOptions.find((o: any) => o.choice === 'refund_all')
    expect(all.label).toBe('Refund all that can go back ($40.00)')
    expect(all.refund.rest).toBe(200)
    expect(all.refund.restOptions.map((o: any) => o.result)).toEqual([
      '$200.00 becomes your money — $200.00 that GAM holds is added to your next payout',
      '$200.00 stays theirs as money paid ahead — if they rent from you again it pays their bills there, and it cannot be taken back later. GAM keeps holding it for them and pays it to you only when it pays one of their bills.',
    ])
    // "No refund"'s own choices are still for the whole $240.
    expect(v.restOptions[0].result).toMatch(/^\$240\.00 becomes your money/)
    const r = await decide(f, { refundChoice: 'refund_all', restChoice: 'keep', quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(r.body.data.choice.refundChoiceLabel).toBe('Refund all that can go back')
    expect(r.body.data.words).toEqual(['Hand back $40.00 in cash now.', '$200.00 is now your money — $200.00 that GAM held is added to your next payout.'])
    expect(await heldItems()).toEqual([expect.objectContaining({ source_type: 'prepaid_draw', amount: 200 })])
  })
})

describe('a bill added after the move-out was done (decisions #46.2)', () => {
  it('waits and sends the landlord to Payments: what is paid ahead pays what is owed before anything is refunded or kept', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    await query(`INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, status)
                 VALUES ($1, $2, $3, 500, 0, 'sent_refund')`, [f.leaseId, f.tenantId, f.landlordId])
    await query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,'utility',35,'pending','2026-10-10','UTILITY','landlord')`, [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    const v = (await view(f)).body.data
    expect(v.waits).toEqual({
      words: 'They still owe $35.00 on this lease, billed after the move-out was done. The money paid ahead pays what is owed before anything is refunded or kept — settle that bill on Payments first, then come back here.',
      href: '/payments', linkLabel: 'Open Payments' })
    expect(v.refundOptions).toEqual([])
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', quoteToken: v.quoteToken })
    expect(r.status).toBe(409)
    expect(await query(`SELECT 1 FROM paid_ahead_choices`)).toHaveLength(0)
    expect((await paidAheadChoiceTodos([f.landlordId]))[0].subtitle).toMatch(/ — settle what they still owe first, then decide it$/)
  })
})

describe('the to-do names only what the screen offers', () => {
  it('money that cannot be refunded from the screen: "keep it, or leave it as their credit" — never "refund it"', async () => {
    const f = await seed()
    // Money GAM holds with no payment on file to send it back to.
    await paidAhead(f, 200, 'gam')
    const todo = await paidAheadChoiceTodos([f.landlordId])
    expect(todo).toHaveLength(1)
    expect(todo[0].subtitle).toBe('Oak Park · $200.00 paid ahead is still on a lease that ended Sep 30 — keep it, or leave it as their credit')
  })
})

describe('days on the property\'s own calendar', () => {
  it('an evening payment and an evening decision in Phoenix are named on that day, never the next (UTC) day', async () => {
    const f = await seed()
    // Sep 3, 7:30pm in Phoenix = Sep 4, 02:30 UTC.
    const rem = await remittance(f, { amount: 500, method: 'money_order', at: '2026-09-04T02:30:00Z' })
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: rem, receivedAt: '2026-09-04T02:30:00Z' })
    const v = (await view(f)).body.data
    expect(v.credits[0]).toMatchObject({ howPaid: 'Money order · Sep 3', receivedOn: '2026-09-03' })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', quoteToken: v.quoteToken })).status).toBe(200)
    // Decided Oct 4, 6:30pm in Phoenix = Oct 5, 01:30 UTC.
    await query(`UPDATE paid_ahead_choices SET decided_at = '2026-10-05T01:30:00Z'`)
    const again = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('Test Landlord already decided this on Oct 4: No refund, then Keep it. Nothing else was changed.')
  })
})

describe('Give it back in cash instead', () => {
  it('a card refund Stripe sent back: offered on its line, handed back in cash ON THIS CHOICE, never sent to the card as well, and the to-do clears', async () => {
    const f = await seed()
    await fromStay(f)
    const rem = await remittance(f, { amount: 1200, method: 'card', intent: 'pi_cash_instead', fee: 42.55 })
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    expect((await decide(f, { refundChoice: 'refund_all' })).status).toBe(200)
    expect(await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })).toBe(true)
    const v = (await view(f)).body.data
    const failed = v.latest.parts[0]
    expect(failed).toMatchObject({ status: 'failed', cashInstead: true })
    expect(failed.failure).toMatch(/Give it back in cash instead/)
    const r = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.next).toBe('done')
    // Choice46c: the press comes before the hand-back — Stripe was asked first, so only this reply orders it, in gold, said once.
    expect(r.body.data.words).toEqual(['Hand back $103.55 in cash now.', 'It is recorded as given back — nothing goes to the card. The $100.00 GAM held for them is added to your next payout.'])
    expect(r.body.data.handBack).toEqual([true, false])
    // GAM held the tenant's $100: it is the landlord's again, once — their only cost is the $3.55 card fee they handed back with it (#38 Q4).
    expect((await heldItems()).map((i) => [i.source_type, i.amount])).toEqual([['refund', -3.55], ['refund', 3.55], ['prepaid_draw', 100]])
    const rows = await query<any>(`SELECT kind, status, paid_ahead_choice_id IS NOT NULL AS on_choice, replaces_part_id IS NOT NULL AS replaces
                                     FROM stay_refund_parts ORDER BY created_at, seq`)
    expect(rows).toEqual([
      { kind: 'card', status: 'refunded', on_choice: true, replaces: false },   // went out, came back (reversed on its day)
      { kind: 'card', status: 'replaced', on_choice: true, replaces: true },    // what was still owed: never sent again
      { kind: 'cash', status: 'handed_back', on_choice: true, replaces: true }, // handed back at the desk instead
    ])
    expect(await paidAheadChoiceTodos([f.landlordId])).toEqual([])
    // Pressed again (a double press): nothing more is handed back.
    const twice = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(twice.status).toBe(200)
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(1)
    expect(h.made).toHaveLength(1)
    // …and GAM releases nothing more.
    expect((await heldItems()).map((i) => [i.source_type, i.amount])).toEqual([['refund', -3.55], ['refund', 3.55], ['prepaid_draw', 100]])
    // A revisit says it as recorded — by whom and when (choice46e) — with what GAM released.
    const revisit = (await view(f)).body.data.latest.words
    expect(revisit).toHaveLength(1)
    expect(revisit[0]).toMatch(/^\$103\.55 recorded as handed back in cash instead of to the card by Test Landlord on \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M — the \$100\.00 GAM held for them is added to your next payout\.$/)
  })

  it('a card refund of money GAM holds that never went out, on an ordinary lease: handed back in cash, GAM releases what it held once — the landlord\'s cost is only the card fee', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 1200, method: 'card', intent: 'pi_never_out', fee: 42.55 })
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    h.state.failNext = 1
    const d = await decide(f, { refundChoice: 'refund_all' })
    expect(d.body.data.next).toBe('try_again')
    const failed = d.body.data.choice.parts[0]
    expect(failed).toMatchObject({ status: 'failed', cashInstead: true })
    const r = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual(['Hand back $103.55 in cash now.', 'It is recorded as given back — nothing goes to the card. The $100.00 GAM held for them is added to your next payout.'])
    expect(r.body.data.handBack).toEqual([true, false])
    // Nothing was ever taken off the payout for the card refund (it never left): +$100 against $103.55 handed out = $3.55, the card fee.
    expect((await heldItems()).map((i) => [i.source_type, i.source_id.startsWith('cash-part:'), i.amount])).toEqual([['prepaid_draw', true, 100]])
    await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(await heldItems()).toHaveLength(1)
    expect(h.made).toHaveLength(0)
  })

  it('card money the landlord already had (rent banked from their payout) handed back in cash instead: nothing is released — they were paid it', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 460, method: 'card', intent: 'pi_rent_card', fee: 16.31 })
    const rentRow = (await query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner, settled_at, stripe_payment_intent_id, platform_held)
       VALUES ($1,$2,$3,$4,'rent',460,'settled','2026-09-01','RENT','landlord','2026-09-01T17:00:00Z','pi_rent_card',FALSE) RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId]))[0].id
    await query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,460)`, [rem, rentRow])
    await tx((c) => createPaidAhead(c, { leaseId: f.leaseId, tenantId: f.tenantId, amount: 100, fundedBy: 'reclassified',
      receivedAt: '2026-09-01T17:00:00Z', sourcePaymentId: rentRow, note: 'Rent paid past the day they left' }))
    h.state.failNext = 1
    const d = await decide(f, { refundChoice: 'refund_all' })
    const failed = d.body.data.choice.parts[0]
    expect(failed).toMatchObject({ kind: 'card', status: 'failed', cashInstead: true })
    const r = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual(['Hand back $103.55 in cash now.', 'It is recorded as given back — nothing goes to the card.'])
    expect(await heldItems()).toEqual([])
  })

  it('needs "Issue refunds"', async () => {
    const f = await seed()
    const desk = await staff(f, { 'guests.check_out': true })
    const r = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${randomUUID()}/cash`).set('Authorization', `Bearer ${desk}`)
    expect(r.status).toBe(403)
  })
})

// ─── Review fix (choice46b) ──────────────────────────────────────────────────

describe('a payment still going through holds some of the money', () => {
  it('the choice waits for it (it could come back here if that payment fails), and is never decided twice', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 100, 'landlord')
    // A card charge in flight set $30 of it aside on a bill.
    const bill = (await query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,'utility',30,'pending','2026-09-25','UTILITY','landlord') RETURNING id`, [f.unitId, f.leaseId, f.tenantId, f.landlordId]))[0].id
    const charge = await remittance(f, { amount: 0.01, method: 'card', intent: 'pi_in_flight' })
    await query(`UPDATE tenant_remittances SET status = 'processing', settled_at = NULL WHERE id = $1`, [charge])
    await query(`INSERT INTO credit_uses (prepaid_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
                 VALUES ($1,$2,$3,$4,30,'2026-09-01','portal','held')`, [credit, bill, charge, f.leaseId])
    const v = (await view(f)).body.data
    expect(v.waits).toEqual({ words: 'A payment using some of this money paid ahead is still going through. Wait for it to finish, then come back here — what is left then is shown to decide.', href: null, linkLabel: null })
    expect(v.refundOptions).toEqual([])
    const r = await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', quoteToken: v.quoteToken })
    expect(r.status).toBe(409)
    expect(await query(`SELECT 1 FROM paid_ahead_choices`)).toHaveLength(0)
    expect((await paidAheadChoiceTodos([f.landlordId]))[0].subtitle).toMatch(/ — wait for a payment using it to finish, then decide it$/)
  })
})

describe('each error once, with the next step — never "reload the page"', () => {
  it('a press with no press key gets the latest back (409) to show in place', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    const r = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice`).set('Authorization', `Bearer ${f.token}`)
      .send({ refundChoice: 'no_refund', restChoice: 'keep', quoteToken: 'x', idempotencyKey: '' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('This page was out of date, so nothing was saved. The latest is shown now — look it over and choose again.')
    expect(r.body.data.left).toBe(40)
  })

  it('an unknown refund choice names the choices the page offers, as they are labeled', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    const r = await decide(f, { refundChoice: 'refund_some' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Pick No refund, Refund the unused days ($40.00) or Refund a different amount, then confirm again.')
  })

  it('a refund part that is not on this lease says so and that the page shows the latest', async () => {
    const f = await seed()
    const r = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${randomUUID()}/retry`).set('Authorization', `Bearer ${f.token}`)
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('That refund is not on this lease any more, so nothing was changed. The page now shows the latest.')
  })
})

describe('the decision\'s time, on the property\'s clock', () => {
  it('decidedOn names the property\'s own day and time, the same day the 409 names', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
    // 6:30pm Oct 4 in Phoenix = 01:30 UTC Oct 5.
    await query(`UPDATE paid_ahead_choices SET decided_at = '2026-10-05T01:30:00Z'`)
    expect((await view(f)).body.data.latest.decidedOn).toBe('October 4, 2026 at 6:30 PM')
  })
})

describe('Money received: a refund from this screen comes off on its own day (§0.0)', () => {
  const day = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })
  const events = async (f: F, line: string, start = day(), end = day()) =>
    (await incomeEvents({ landlordIds: [f.landlordId], start, end, basis: 'received' })).filter((e) => e.line === line && e.leaseId === f.leaseId)
  const sum = (xs: Array<{ amount: number }>) => Math.round(xs.reduce((a, e) => a + e.amount, 0) * 100) / 100

  it('cash handed back on an ordinary lease: negative on the day it was handed back (it counted the day it arrived)', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 500, method: 'cash' })
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: rem })
    expect(sum(await events(f, 'paidAhead', '2026-09-01', '2026-09-30'))).toBe(40)
    expect((await decide(f, { refundChoice: 'refund_all' })).status).toBe(200)
    expect(sum(await events(f, 'paidAheadRefunded'))).toBe(-40)
    expect(sum(await events(f, 'refundCardFees'))).toBe(0)
  })

  it('a card refund: the money off Money received and its card fee beside it on the refund day; a refund Stripe sends back is added back that day; cash instead comes off again', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 1200, method: 'card', intent: 'pi_income', fee: 42.55 })
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    expect((await decide(f, { refundChoice: 'refund_all' })).status).toBe(200)
    expect(sum(await events(f, 'paidAheadRefunded'))).toBe(-100)
    expect(sum(await events(f, 'refundCardFees'))).toBe(3.55)
    await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })
    expect(sum(await events(f, 'paidAheadRefunded'))).toBe(0)
    expect(sum(await events(f, 'refundCardFees'))).toBe(0)
    const failed = (await view(f)).body.data.latest.parts[0]
    await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(sum(await events(f, 'paidAheadRefunded'))).toBe(-100)
    expect(sum(await events(f, 'refundCardFees'))).toBe(3.55)
  })

  it('Keep it and Leave it as their credit add nothing (the money already counted when it arrived)', async () => {
    const kept = await seed()
    await paidAhead(kept, 40, 'gam', { sourceRemittanceId: await remittance(kept, { amount: 500, method: 'card', intent: 'pi_kept_income' }) })
    expect((await decide(kept, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
    const left = await seed()
    await paidAhead(left, 40, 'landlord')
    expect((await decide(left, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    for (const f of [kept, left]) {
      expect((await incomeEvents({ landlordIds: [f.landlordId], start: day(), end: day(), basis: 'received' })).filter((e) => e.leaseId === f.leaseId)).toEqual([])
    }
  })
})

describe('cash handed back at the desk reaches the end-of-day drawer', () => {
  it('a hand-back on an ordinary lease is a cash refund of that lease\'s property on its day, and that day closes for it', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 500, method: 'cash' }) })
    expect((await decide(f, { refundChoice: 'refund_all' })).status).toBe(200)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })
    const eod = await generateEodSettlement(f.landlordId, f.propertyId, today)
    expect(eod.cashRefunds).toBe(40)
    const all = await generateEodForAllActiveLandlords(today)
    expect(all.map((r: any) => r.propertyId ?? r.property_id)).toContain(f.propertyId)
  })
})

describe('the owner statement shows what Keep it released', () => {
  it('money GAM held and the landlord kept is collected through GAM on the day it was released — once, matching the payout line', async () => {
    const f = await seed()
    await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 660, method: 'card', intent: 'pi_stmt' }) })
    const before = await ownerStatement({ landlordId: f.landlordId, periodMonth: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }).slice(0, 7) })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
    const after = await ownerStatement({ landlordId: f.landlordId, periodMonth: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }).slice(0, 7) })
    const payout = (await heldItems()).filter((i) => i.source_type === 'prepaid_draw').reduce((a, i) => a + i.amount, 0)
    expect(payout).toBe(200)
    expect(Math.round((after.totals.collectedThroughGam - before.totals.collectedThroughGam) * 100) / 100).toBe(200)
  })
})

describe('a chargeback or bank return after the choice is never absorbed by GAM', () => {
  it('after Keep it (GAM held it and paid it out): the whole dispute is charged back to the landlord\'s next payout, and a redelivered event changes nothing', async () => {
    const f = await seed()
    await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 660, method: 'card', intent: 'pi_kept_dispute' }) })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
    const use = (await query<{ id: string }>(`SELECT id FROM credit_uses WHERE paid_ahead_choice_id IS NOT NULL`))[0].id
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_kept_dispute', reversalId: null }))
    expect(r.nettedFromLandlord).toEqual([{ useId: use, amount: 200 }])
    expect(await heldItems()).toEqual([
      { source_type: 'prepaid_draw', source_id: use, amount: 200, description: 'MH 08: money paid ahead through GAM on an ended lease, kept by you' },
      { source_type: 'dispute', source_id: `owner_share_returned:paid-ahead-choice:pi_kept_dispute:${use}`, amount: -200,
        description: 'MH 08: money paid ahead that you kept was taken back by the card company (a dispute) — it comes off your next payout' },
    ])
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_kept_dispute', reversalId: null }))
    expect(await heldItems()).toHaveLength(2)
    // Money received: it counted the day it arrived; it comes off the day it was taken back.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })
    const back = (await incomeEvents({ landlordIds: [f.landlordId], start: today, end: today, basis: 'received' })).filter((e) => e.leaseId === f.leaseId)
    expect(back.map((e) => [e.line, e.amount])).toEqual([['returned', -200]])
  })

  it('after Keep it, a partial dispute charges back only the disputed part', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 660, method: 'card', intent: 'pi_kept_partial' })
    await paidAhead(f, 200, 'gam', { sourceRemittanceId: rem })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_kept_partial', reversalId: null, maxAmount: 75 }))
    expect(r.nettedFromLandlord?.map((n) => n.amount)).toEqual([75])
    expect((await heldItems()).filter((i) => i.source_type === 'dispute').map((i) => i.amount)).toEqual([-75])
  })

  it('after Leave it as their credit: a bank return takes back what is left of it (withdrawn), so nothing of it is ever paid out', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 560, method: 'ach', intent: 'pi_left_return' }) })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_left_return', reversalId: null }))
    expect(r.withdrawn).toBe(true)
    expect((await query<any>(`SELECT voided_at IS NOT NULL AS gone FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0].gone).toBe(true)
    expect(await heldItems()).toEqual([])
  })
})

// ─── Review fix pass 2 (choice46b) ──────────────────────────────────────────

const phxToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })
const received = async (f: F, start: string, end: string) =>
  (await incomeEvents({ landlordIds: [f.landlordId], start, end, basis: 'received' })).filter((e) => e.inTotal)
const lines = (xs: Array<{ line: string; amount: number }>) => xs.map((e) => [e.line, e.amount])
const total = (xs: Array<{ amount: number }>) => Math.round(xs.reduce((a, e) => a + e.amount, 0) * 100) / 100
const choiceNets = async () => (await heldItems()).filter((i) => /^owner_share_returned:paid-ahead-choice:/.test(i.source_id))

describe('a chargeback after Keep it is counted ONCE in Money received (§0.0: a past month is never rewritten)', () => {
  it('a whole dispute after Keep it: the September arrival stays in September, the take-back is on its own day, and arrival to dispute nets to $0', async () => {
    const f = await seed()
    await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 660, method: 'card', intent: 'pi_once_full' }) })
    const september = lines(await received(f, '2026-09-01', '2026-09-30'))
    expect(september).toEqual([['paidAhead', 200]])
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_once_full', reversalId: null }))
    // The dispute withdrew the credit; its arrival is still September's.
    expect(lines(await received(f, '2026-09-01', '2026-09-30'))).toEqual(september)
    expect(lines(await received(f, phxToday(), phxToday()))).toEqual([['returned', -200]])
    expect(total(await received(f, '2026-09-01', phxToday()))).toBe(0)
  })

  it('a partial dispute after Keep it: the arrival is unchanged and only the disputed part comes off', async () => {
    const f = await seed()
    await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 660, method: 'card', intent: 'pi_once_part' }) })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_once_part', reversalId: null, maxAmount: 75 }))
    expect(lines(await received(f, '2026-09-01', '2026-09-30'))).toEqual([['paidAhead', 200]])
    expect(total(await received(f, '2026-09-01', phxToday()))).toBe(125)
  })
})

describe('a chargeback or bank return after Keep it, through the real dispute and return path (paymentReversal)', () => {
  for (const [kind, method, type] of [['a card dispute', 'card', 'card_dispute'], ['a bank return', 'ach', 'ach_return']] as const) {
    it(`${kind}: the landlord's payout is charged back the kept money once, and Money received from arrival to take-back nets to $0`, async () => {
      const f = await seed()
      const pi = `pi_real_${method}`
      await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 200, method, intent: pi }) })
      expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
      const use = (await query<{ id: string }>(`SELECT id FROM credit_uses WHERE paid_ahead_choice_id IS NOT NULL`))[0].id
      const out = await handlePaymentReversal({ paymentIntentId: pi, reversalType: type, reversalFee: 15, stripeEventId: `evt_${method}`, rawEvent: {} })
      expect(out.handled).toBe(true)
      expect((await heldItems()).filter((i) => i.source_type === 'prepaid_draw').map((i) => [i.source_id, i.amount])).toEqual([[use, 200]])
      expect((await choiceNets()).map((i) => i.amount)).toEqual([-200])
      // A redelivered event changes nothing.
      await handlePaymentReversal({ paymentIntentId: pi, reversalType: type, reversalFee: 15, stripeEventId: `evt_${method}`, rawEvent: {} })
      expect(await choiceNets()).toHaveLength(1)
      const mine = (await received(f, '2026-09-01', phxToday())).filter((e) => e.leaseId === f.leaseId)
      expect(lines(mine.filter((e) => e.day <= '2026-09-30'))).toEqual([['paidAhead', 200]])
      expect(total(mine)).toBe(0)
    })
  }
})

describe('the owner statement ties to the payout', () => {
  const month = () => phxToday().slice(0, 7)
  const payoutOf = async (types: string[]) => Math.round((await heldItems()).filter((i) => types.includes(i.source_type)).reduce((a, i) => a + i.amount, 0) * 100) / 100

  it('Keep it: the release is in the owner share and net (what the payout carries); a dispute that month is under Returned or disputed, so owner share plus returned equals the payout lines', async () => {
    const f = await seed()
    await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 660, method: 'card', intent: 'pi_stmt_tie' }) })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'keep' })).status).toBe(200)
    const kept = await ownerStatement({ landlordId: f.landlordId, periodMonth: month() })
    expect(kept.totals).toMatchObject({ collectedThroughGam: 200, ownerShare: 200, net: 200, returnedOrDisputed: 0 })
    expect(kept.totals.ownerShare).toBe(await payoutOf(['prepaid_draw']))
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_stmt_tie', reversalId: null }))
    const after = await ownerStatement({ landlordId: f.landlordId, periodMonth: month() })
    expect(after.totals).toMatchObject({ ownerShare: 200, returnedOrDisputed: -200 })
    expect(Math.round((after.totals.ownerShare + after.totals.returnedOrDisputed) * 100) / 100).toBe(await payoutOf(['prepaid_draw', 'dispute']))
  })

  it('cash handed back instead of a card refund of money GAM held: the release is in the owner share and through GAM, the cash that went back comes off collected directly — gross unchanged', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 1200, method: 'card', intent: 'pi_stmt_cash', fee: 42.55 }) })
    h.state.failNext = 1
    const d = await decide(f, { refundChoice: 'refund_all' })
    const before = await ownerStatement({ landlordId: f.landlordId, periodMonth: month() })
    await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${d.body.data.choice.parts[0].id}/cash`).set('Authorization', `Bearer ${f.token}`)
    const after = await ownerStatement({ landlordId: f.landlordId, periodMonth: month() })
    const diff = (k: 'ownerShare' | 'collectedThroughGam' | 'collectedDirectly' | 'grossCollected' | 'net') =>
      Math.round((after.totals[k] - before.totals[k]) * 100) / 100
    expect([diff('ownerShare'), diff('net'), diff('collectedThroughGam'), diff('collectedDirectly'), diff('grossCollected')]).toEqual([100, 100, 100, -100, 0])
    expect(after.totals.ownerShare).toBe(await payoutOf(['prepaid_draw']))
  })
})

describe('money left as their credit keeps where it arrived when it follows them (decisions #46.1a)', () => {
  it('carried to a lease at another property: the arrival\'s month and property do not change — in Money received and on the owner statement', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 500, 'landlord', { receivedAt: '2026-09-03T17:00:00Z' })
    const where = async () => (await received(f, '2026-09-01', '2026-09-30')).filter((e) => e.line === 'paidAhead').map((e) => [e.propertyId, e.leaseId, e.amount])
    const before = await where()
    expect(before).toEqual([[f.propertyId, f.leaseId, 500]])
    const stmtBefore = (await ownerStatement({ landlordId: f.landlordId, periodMonth: '2026-09' })).properties.map((p) => [p.propertyId, p.collectedDirectly])
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    const other = await tx(async (c) => {
      const prop = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId })
      const unit = await seedUnit(c, { propertyId: prop, landlordId: f.landlordId })
      const lease = await seedLease(c, { unitId: unit, landlordId: f.landlordId, rentAmount: 460, status: 'active', startDate: '2026-11-01' })
      await seedLeaseTenant(c, { leaseId: lease, tenantId: f.tenantId, role: 'primary' })
      return { prop, lease }
    })
    expect((await query<any>(`SELECT lease_id, received_lease_id FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0])
      .toEqual({ lease_id: other.lease, received_lease_id: f.leaseId })
    expect(await where()).toEqual(before)
    const stmtAfter = (await ownerStatement({ landlordId: f.landlordId, periodMonth: '2026-09' })).properties.map((p) => [p.propertyId, p.collectedDirectly])
    expect(stmtAfter.filter(([id]) => id === f.propertyId)).toEqual(stmtBefore.filter(([id]) => id === f.propertyId))
    expect(stmtAfter.find(([id]) => id === other.prop)?.[1] ?? 0).toBe(0)
  })

  it('a pending addendum (not signed yet) never moves it; it moves once their membership is active', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 60, 'landlord')
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    const { lease2, member } = await tx(async (c) => {
      const unit2 = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      const lease2 = await seedLease(c, { unitId: unit2, landlordId: f.landlordId, rentAmount: 460, status: 'active', startDate: '2026-11-01' })
      await seedLeaseTenant(c, { leaseId: lease2, tenantId: await seedTenant(c), role: 'primary' })
      const member = (await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role, status) VALUES ($1,$2,'co_tenant','pending_add') RETURNING id`,
        [lease2, f.tenantId])).rows[0].id
      return { lease2, member }
    })
    expect((await query<any>(`SELECT lease_id, left_by_choice_id IS NOT NULL AS left FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0])
      .toEqual({ lease_id: f.leaseId, left: true })
    await query(`UPDATE lease_tenants SET status = 'active' WHERE id = $1`, [member])
    expect((await query<any>(`SELECT lease_id, left_by_choice_id IS NOT NULL AS left FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0])
      .toEqual({ lease_id: lease2, left: false })
  })
})

describe('a bank-deposit give-back is not cash out of the drawer', () => {
  it('giving back a tenant\'s own bank deposit does not change the day\'s cash refunds, and does not close a drawer by itself', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 500, method: 'ach', intent: null }) })
    expect((await decide(f, { refundChoice: 'refund_all' })).status).toBe(200)
    const eod = await generateEodSettlement(f.landlordId, f.propertyId, phxToday())
    expect(eod.cashRefunds).toBe(0)
    expect((await generateEodForAllActiveLandlords(phxToday())).map((r: any) => r.propertyId ?? r.property_id)).not.toContain(f.propertyId)
  })
})

describe('reclassified money paid ahead with no payment of its own goes back the way it was paid (decisions #37.B)', () => {
  it('a reservation deposit\'s leftover paid by card on the booking site goes back to that same card with its card fee — never "no payment on file", never cash at the desk', async () => {
    const f = await seed()
    const booking = await fromStay(f)
    const stayPayment = (await query<{ id: string }>(
      `INSERT INTO stay_payments (booking_id, landlord_id, kind, stripe_payment_intent_id, method, toward_stay, card_fee, landlord_card_fee, paid_at)
       VALUES ($1,$2,'site_deposit','pi_site_deposit','card',300,10.50,0,'2026-07-20T17:00:00Z') RETURNING id`, [booking, f.landlordId]))[0].id
    await paidAhead(f, 120, 'reclassified', { note: STAY_DEPOSIT_CREDIT_NOTE, receivedAt: '2026-07-20T17:00:00Z' })
    const v = (await view(f)).body.data
    expect(v.sources).toEqual([{ key: expect.any(String), kind: 'card', label: 'Card · booking site deposit · Jul 20', refundable: 120 }])
    expect(v.refundNotes).toEqual([])
    expect(v.credits[0].howPaid).not.toMatch(/no payment on file/)
    const all = v.refundOptions.find((o: any) => o.choice === 'refund_all')
    expect(all.result).toBe('$124.20 back to the card they paid with (Card · booking site deposit · Jul 20)')
    const r = await decide(f, { refundChoice: 'refund_all', quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(h.refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_site_deposit', amount: 12420 }), expect.anything())
    expect((await query<any>(`SELECT kind, status, stay_payment_id, amount::float AS amount FROM stay_refund_parts`))).toEqual([
      { kind: 'card', status: 'refunded', stay_payment_id: stayPayment, amount: 124.2 }])
    // The landlord was paid the reservation: their payout gives back all of it.
    expect((await heldItems()).map((i) => [i.source_type, i.amount])).toEqual([['refund', -124.2]])
  })
})

describe('a shortened stay\'s credit made again (no payment of its own) goes back the way the rent was paid', () => {
  it('rent paid by card on the lease: offered back to that card, never "no payment on file"', async () => {
    const f = await seed()
    await fromStay(f)
    const rem = await remittance(f, { amount: 460, method: 'card', intent: 'pi_rent_remade', at: '2026-09-01T17:00:00Z' })
    const rentRow = (await query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner, settled_at)
       VALUES ($1,$2,$3,$4,'rent',460,'settled','2026-09-01','RENT','landlord','2026-09-01T17:00:00Z') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId]))[0].id
    await query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,460)`, [rem, rentRow])
    await paidAhead(f, 100, 'reclassified', { note: STAY_SHORTENED_CREDIT_NOTE, receivedAt: '2026-09-01T17:00:00Z' })
    const v = (await view(f)).body.data
    expect(v.sources.map((x: any) => [x.kind, x.label, x.refundable])).toEqual([['card', 'Card · Sep 1', 100]])
    expect(v.refundNotes).toEqual([])
  })
})

describe('a bank refund is never called a card refund', () => {
  it('turned down by the bank: the part and the owner\'s notice say their bank, and open the screen', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 560, method: 'ach', intent: 'pi_bank_down' }) })
    h.state.status = 'failed'
    const d = await decide(f, { refundChoice: 'refund_all' })
    expect(d.body.data.choice.parts[0]).toMatchObject({ kind: 'bank', status: 'failed' })
    expect(d.body.data.choice.parts[0].failure).toMatch(/^Their bank turned this refund down \(\$100\.00\) — press Try again, or press "Give it back in cash instead" \(GAM first checks that it did not reach their bank, then tells you when to hand the cash over\)\.$/)
    const n = await query<any>(`SELECT body, action_url FROM notifications WHERE type = 'stay_refund_failed'`)
    expect(n).toHaveLength(1)
    expect(n[0].body).toMatch(/was turned down by their bank\./)
    expect(n[0].body).not.toMatch(/card company|left early/)
    expect(n[0].action_url).toBe(`/leases/${f.leaseId}/paid-ahead-choice`)
  })

  it('"Give it back in cash instead" on a bank refund another request is working on: nothing handed back, press Check again (the page shows it beside these words)', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 560, method: 'ach', intent: 'pi_bank_sending' })
    const credit = await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    const choice = (await query<{ id: string }>(
      `INSERT INTO paid_ahead_choices (lease_id, landlord_id, left_amount, refund_choice, refund_total, rest_amount, idempotency_key, decided_by)
       VALUES ($1,$2,100,'refund_all',100,0,$3,$4) RETURNING id`, [f.leaseId, f.landlordId, randomUUID(), f.userId]))[0].id
    const part = (await query<{ id: string }>(
      `INSERT INTO stay_refund_parts (paid_ahead_choice_id, landlord_id, seq, kind, remittance_id, prepaid_credit_id,
                                      stripe_payment_intent_id, toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label, status)
       VALUES ($1,$2,1,'bank',$3,$4,'pi_bank_sending',100,0,100,0,0,'Bank payment · Sep 3','pending') RETURNING id`,
      [choice, f.landlordId, rem, credit]))[0].id
    const r = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${part}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(r.status).toBe(409)
    // Choice46d: never "the page shows it" (a Try again keeps the line failed while it works); the next step is the page's own Check again.
    expect(r.body.error).toBe('Another request is working on this refund right now, so nothing was handed back. Wait a moment, then press Check again.')
  })

  it('cash handed back instead of a bank refund is said as that — never "they paid by bank deposit"', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 560, method: 'ach', intent: 'pi_bank_cash' }) })
    h.state.failNext = 1
    const d = await decide(f, { refundChoice: 'refund_all' })
    const r = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${d.body.data.choice.parts[0].id}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(r.status).toBe(200)
    const cash = (await view(f)).body.data.latest.parts.find((p: any) => p.kind === 'cash')
    expect(cash.words).toMatch(/^\$100\.00 recorded as handed back in cash instead of to the bank by Test Landlord on \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M$/)
    // It came out of the drawer: a cash refund of the day.
    expect((await generateEodSettlement(f.landlordId, f.propertyId, phxToday())).cashRefunds).toBe(100)
  })
})

describe('every desk order in the reply is marked for the gold box', () => {
  it('two cash payments ahead, and a check with cash: each "give back now" line is flagged, wherever it falls; the record lines are not', async () => {
    const f = await seed()
    await paidAhead(f, 20, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 20, method: 'cash', at: '2026-09-02T17:00:00Z' }), receivedAt: '2026-09-02T17:00:00Z' })
    await paidAhead(f, 20, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 20, method: 'cash', at: '2026-09-04T17:00:00Z' }), receivedAt: '2026-09-04T17:00:00Z' })
    await paidAhead(f, 25, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 25, method: 'check', at: '2026-09-06T17:00:00Z' }), receivedAt: '2026-09-06T17:00:00Z' })
    const r = await decide(f, { refundChoice: 'refund_other', refundAmount: 60, restChoice: 'keep' })
    expect(r.status).toBe(200)
    const { words, handBack } = r.body.data
    expect(words).toEqual([
      'Give back $25.00 — they paid by check (Check · Sep 6).',
      'Hand back $20.00 in cash now.',
      'Hand back $15.00 in cash now.',
      '$5.00 is now your money (you already had it).',
    ])
    expect(handBack).toEqual([true, true, true, false])
    // A later visit's record is past tense, and nothing in it is an order.
    expect((await view(f)).body.data.latest.words.join(' ')).not.toMatch(/Hand back|Give back/)
  })
})

describe('the to-do follows who can open the screen', () => {
  it('a property-locked worker\'s to-dos list only their properties\' leases', async () => {
    const f = await seed()
    await paidAhead(f, 40, 'landlord')
    expect(await paidAheadChoiceTodos([f.landlordId], { propertyIds: [f.propertyId] })).toHaveLength(1)
    expect(await paidAheadChoiceTodos([f.landlordId], { propertyIds: [randomUUID()] })).toEqual([])
    expect(await paidAheadChoiceTodos([f.landlordId], { propertyIds: [] })).toEqual([])
    expect(await paidAheadChoiceTodos([f.landlordId], { propertyIds: null })).toHaveLength(1)
  })
})

// The landlord page's test renders THESE responses (review fix pass 3: never
// hand-written fixtures that could drift from the server). Captured from the
// real routes, ids and instants made stable; a change in what the server
// sends fails here until the fixture is refreshed with
// PAID_AHEAD_FIXTURE_UPDATE=1 — and then the page test runs on the new shape.
describe('the page\'s fixture is the real response', () => {
  it('open (part of it cannot go back), the preview, the decision, a refund Stripe sent back, a Try again that could not try, cash handed back instead, and the visit after', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const f = await seed()
    await fromStay(f)
    const cash = await remittance(f, { amount: 500, method: 'cash', at: '2026-09-10T17:00:00Z' })
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: cash, receivedAt: '2026-09-10T17:00:00Z' })
    // A long stay's card money with no intent on file: not refundable here ("no payment GAM can send it back to").
    await paidAhead(f, 60, 'gam', { receivedAt: '2026-09-12T17:00:00Z' })
    const card = await remittance(f, { amount: 1200, method: 'card', intent: 'pi_fixture', fee: 42.55, at: '2026-09-03T17:00:00Z' })
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: card })
    const open = (await view(f)).body.data
    const preview = (await request(app()).get(`/api/leases/${f.leaseId}/paid-ahead-choice/refund-preview?amount=120`)
      .set('Authorization', `Bearer ${f.token}`)).body.data
    const decided = (await decide(f, { refundChoice: 'refund_all', restChoice: 'credit', quoteToken: open.quoteToken })).body.data
    await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })
    // A fixed instant, so the 409's words name the same day on every run.
    await query(`UPDATE paid_ahead_choices SET decided_at = '2026-10-04T18:00:00Z'`)
    const sentBack = (await view(f)).body.data
    const again = (await decide(f, { refundChoice: 'no_refund', restChoice: 'keep', quoteToken: open.quoteToken }))
    expect(again.status).toBe(409)
    const failedId = sentBack.latest.parts.find((p: any) => p.status === 'failed').id
    // Try again while another request holds that refund for a moment: the reply says so.
    const holder = await db.connect()
    let busyRetry: any
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${failedId}`])
      busyRetry = (await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failedId}/retry`)
        .set('Authorization', `Bearer ${f.token}`)).body.data
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${failedId}`]).catch(() => {})
      holder.release()
    }
    expect(busyRetry.words[0]).toBe('This refund was being worked on by another request at that same moment, so it was not sent again. Wait a moment, then press Try again.')
    // "Give back $103.55 in cash": the reply (the order, after Stripe was asked), then a later visit.
    const cashReply = (await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failedId}/cash`)
      .set('Authorization', `Bearer ${f.token}`)).body.data
    const revisit = (await view(f)).body.data
    // Choice46c: a refund whose register sale the register already refunded
    // can never be sent — the screen offers no Try again (retry: false), its
    // line says what to do instead, and a Try again press is refused (409).
    const g = await seed()
    const gStay = await fromStay(g)
    const regSale = (await query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, stripe_payment_intent_id)
       VALUES ($1,$2,'card',300,300,'pi_fixture_reg') RETURNING id`, [g.landlordId, g.userId]))[0].id
    await query(`INSERT INTO stay_payments (booking_id, landlord_id, kind, stripe_payment_intent_id, method, pos_transaction_id, toward_stay, card_fee, landlord_card_fee, paid_at)
                 VALUES ($1,$2,'pos_sale','pi_fixture_reg','card',$3,300,0,0,'2026-07-20T17:00:00Z')`, [gStay, g.landlordId, regSale])
    await paidAhead(g, 120, 'reclassified', { note: STAY_DEPOSIT_CREDIT_NOTE, receivedAt: '2026-07-20T17:00:00Z' })
    h.state.failNext = 1
    const gDecided = (await decide(g, { refundChoice: 'refund_all' })).body.data
    await query(`INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, reason) VALUES ($1,$2,300,'cash','register')`, [regSale, g.landlordId])
    await query(`UPDATE paid_ahead_choices SET decided_at = '2026-10-04T18:00:00Z' WHERE lease_id = $1`, [g.leaseId])
    const noRoom = (await view(g)).body.data
    const noRoomRetry = await request(app()).post(`/api/leases/${g.leaseId}/paid-ahead-choice/parts/${gDecided.choice.parts[0].id}/retry`)
      .set('Authorization', `Bearer ${g.token}`)
    expect(noRoomRetry.status).toBe(409)
    const ids = new Map<string, string>()
    const stable = JSON.stringify({ open, preview, decided, sentBack, conflict: { status: again.status, body: again.body }, busyRetry, cashReply, revisit,
      noRoom, noRoomRetry: { status: noRoomRetry.status, body: noRoomRetry.body } }, null, 2)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
        if (!ids.has(u)) ids.set(u, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`)
        return ids.get(u)!
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '2026-10-04T18:00:00.000Z')
      // The instant above, as the property's clock names it (the reply to the press is made before decided_at is fixed).
      .replace(/"decidedOn": "[^"]+"/g, '"decidedOn": "October 4, 2026 at 11:00 AM"')
      // When cash was recorded (choice46d fix pass 3: a look names it) — on the property's clock, made stable.
      .replace(/(recorded as given back in cash \(\$[\d.,]+\)(?: by [^"—]+?)? at )\w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M/g, '$1October 4, 2026 at 11:30 AM')
      // Choice46e: the record line for cash given instead of a card refund names who recorded it and when — made stable.
      .replace(/(recorded as handed back in cash instead of to the (?:card|bank)(?: by [^"—]+?)? on )\w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M/g, '$1October 4, 2026 at 11:30 AM')
      .replace(/"quoteToken": "[0-9a-f]+"/g, '"quoteToken": "quote-token"')
      .replace(/https?:\/\/[^\s"/]+/g, 'http://landlord.test') + '\n'
    const file = path.join(__dirname, '../../../landlord/src/pages/__fixtures__/paidAheadChoice.real.json')
    if (process.env.PAID_AHEAD_FIXTURE_UPDATE === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, stable)
    }
    expect(fs.readFileSync(file, 'utf8'), 'The paid-ahead screen\'s response changed: run this test with PAID_AHEAD_FIXTURE_UPDATE=1, then the landlord page test').toBe(stable)
  })
})

// ─── Review fix pass 3 (choice46b) ──────────────────────────────────────────

describe('a dispute or bank return that withdraws money this screen touched keeps its arrival (§0.0)', () => {
  it('$200 paid ahead by bank, $50 refunded to the bank, $150 left as their credit, then a full return: September keeps $200, the refund and the $150 taken back come off on their own day, and it nets to $0', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 200, method: 'ach', intent: 'pi_p1_return' }) })
    expect(lines(await received(f, '2026-09-01', '2026-09-30'))).toEqual([['paidAhead', 200]])
    const d = await decide(f, { refundChoice: 'refund_other', refundAmount: 50, restChoice: 'credit' })
    expect(d.status).toBe(200)
    expect(d.body.data.choice.parts.map((p: any) => [p.kind, p.status])).toEqual([['bank', 'refunded']])
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_p1_return', reversalId: null }))
    expect(r.withdrawn).toBe(true)
    expect(await remaining(credit)).toBe(150)
    expect(lines(await received(f, '2026-09-01', '2026-09-30'))).toEqual([['paidAhead', 200]])
    const today = lines(await received(f, phxToday(), phxToday())).sort()
    expect(today).toEqual([['paidAheadRefunded', -50], ['returned', -150]])
    expect(total(await received(f, '2026-09-01', phxToday()))).toBe(0)
  })

  it('Leave it as their credit, then a full card dispute: September stays $200 and the take-back is on the dispute day — the same way Keep it reads', async () => {
    const f = await seed()
    await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 200, method: 'card', intent: 'pi_p2_dispute' }) })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_p2_dispute', reversalId: null }))
    expect(r.withdrawn).toBe(true)
    expect(lines(await received(f, '2026-09-01', '2026-09-30'))).toEqual([['paidAhead', 200]])
    expect(lines(await received(f, phxToday(), phxToday()))).toEqual([['returned', -200]])
    expect(total(await received(f, '2026-09-01', phxToday()))).toBe(0)
    // Nothing of it is ever paid out (it was GAM-held and left as theirs).
    expect(await heldItems()).toEqual([])
  })

  it('an ordinary withdrawn credit (never on this screen) keeps its older reading', async () => {
    const f = await seed()
    await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 200, method: 'card', intent: 'pi_plain_dispute' }) })
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_plain_dispute', reversalId: null }))
    expect(lines(await received(f, '2026-09-01', phxToday()))).toEqual([])
  })
})

describe('money carried to a lease at another property that a move-out there sweeps comes off where it arrived', () => {
  it('Money received and the owner statement: the arrival property nets to $0, the move-out property shows only what its pool kept', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 300, 'landlord', { receivedAt: '2026-09-03T17:00:00Z' })
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    const b = await tx(async (c) => {
      const prop = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId })
      await c.query(`UPDATE properties SET timezone = 'America/Phoenix', timezone_source = 'manual' WHERE id = $1`, [prop])
      const unit = await seedUnit(c, { propertyId: prop, landlordId: f.landlordId })
      const lease = await seedLease(c, { unitId: unit, landlordId: f.landlordId, rentAmount: 460, status: 'active', startDate: '2026-09-20' })
      await seedLeaseTenant(c, { leaseId: lease, tenantId: f.tenantId, role: 'primary' })
      return { prop, lease }
    })
    expect((await query<any>(`SELECT lease_id, received_lease_id FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0])
      .toEqual({ lease_id: b.lease, received_lease_id: f.leaseId })
    // B's move-out: $300 of cleaning, paid from the carried money (the pool).
    await tx(async (c) => {
      const dr = (await c.query(
        `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines, other_deductions,
                                      unpaid_balance_amount, total_deductions, gap_amount, status, finalized_at)
         VALUES ($1,$2,$3,0,300,'[]','[]',0,300,0,'sent_refund',NOW()) RETURNING id`, [b.lease, f.tenantId, f.landlordId])).rows[0].id
      await c.query(
        `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, applied_at)
         VALUES ($1,$2,$3,300,date_trunc('month', now())::date,'move_out','applied',NOW())`, [credit, dr, b.lease])
    })
    const all = await received(f, '2026-09-01', phxToday())
    const at = (prop: string) => total(all.filter((e) => e.propertyId === prop))
    expect(at(f.propertyId)).toBe(0)
    expect(at(b.prop)).toBe(300)
    expect(all.filter((e) => e.line === 'paidAheadRefunded').map((e) => [e.propertyId, e.leaseId, e.amount])).toEqual([[f.propertyId, f.leaseId, -300]])
    const month = phxToday().slice(0, 7)
    const direct = async (m: string) => new Map((await ownerStatement({ landlordId: f.landlordId, periodMonth: m })).properties.map((p) => [p.propertyId, p.collectedDirectly]))
    const sep = await direct('2026-09')
    const now = await direct(month)
    expect(sep.get(f.propertyId)).toBe(300)
    expect(now.get(f.propertyId)).toBe(-300)
    expect(now.get(b.prop)).toBe(300)
  })

  it('one property (nothing carried): the move-out reads exactly as before', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 300, 'landlord', { receivedAt: '2026-09-03T17:00:00Z' })
    await tx(async (c) => {
      const dr = (await c.query(
        `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines, other_deductions,
                                      unpaid_balance_amount, total_deductions, gap_amount, status, finalized_at)
         VALUES ($1,$2,$3,0,300,'[]','[]',0,300,0,'sent_refund',NOW()) RETURNING id`, [f.leaseId, f.tenantId, f.landlordId])).rows[0].id
      await c.query(
        `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, applied_at)
         VALUES ($1,$2,$3,300,date_trunc('month', now())::date,'move_out','applied',NOW())`, [credit, dr, f.leaseId])
    })
    const s = await ownerStatement({ landlordId: f.landlordId, periodMonth: phxToday().slice(0, 7) })
    expect(s.properties.find((p) => p.propertyId === f.propertyId)?.collectedDirectly).toBe(0)
    expect(total((await received(f, phxToday(), phxToday())).filter((e) => e.leaseId === f.leaseId))).toBe(0)
  })
})

describe('a refund of money that was paid with credit goes back the way it was paid', () => {
  /** A shortened stay's credit (C1) whose rent bill was paid with `how`: money paid ahead (C0) or a credit the landlord gave. */
  async function creditPaidRent(f: F, how: 'paid_ahead' | 'issued'): Promise<string> {
    return tx(async (c) => {
      const rent = (await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, settled_at, revenue_owner, entry_description)
         VALUES ($1,$2,$3,$4,'rent',40,'pending','2026-09-01',NULL,'landlord','RENT') RETURNING id`,
        [f.unitId, f.leaseId, f.tenantId, f.landlordId])).rows[0].id
      if (how === 'paid_ahead') {
        const c0 = await createPaidAhead(c, { leaseId: f.leaseId, tenantId: f.tenantId, amount: 40, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' })
        await c.query(`INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
                       VALUES ($1,$2,$3,40,'2026-09-01','desk','applied','2026-09-01T17:00:00Z')`, [c0, rent, f.leaseId])
      } else {
        const t0 = (await c.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
                                   VALUES ($1,$2,$3,40,40,'other','goodwill') RETURNING id`, [f.landlordId, f.tenantId, f.leaseId])).rows[0].id
        await c.query(`INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
                       VALUES ($1,$2,$3,40,'2026-09-01','desk','applied','2026-09-01T17:00:00Z')`, [t0, rent, f.leaseId])
      }
      // The credit paid the bill in full (credit is applied to a bill still owed; then it is settled).
      await c.query(`UPDATE payments SET status = 'settled', settled_at = '2026-09-01T17:00:00Z' WHERE id = $1`, [rent])
      return createPaidAhead(c, { leaseId: f.leaseId, tenantId: f.tenantId, amount: 40, fundedBy: 'reclassified', sourcePaymentId: rent,
        note: STAY_SHORTENED_CREDIT_NOTE, receivedAt: '2026-09-25T17:00:00Z' })
    })
  }

  it('paid with money paid ahead: it stays theirs as money paid ahead — no landlord credit that could be voided, nothing spent, and it follows them', async () => {
    const f = await seed()
    const c1 = await creditPaidRent(f, 'paid_ahead')
    const v = (await view(f)).body.data
    expect(v.sources.map((s: any) => [s.kind, s.label])).toEqual([['credit', 'Money paid ahead · Sep 1']])
    const all = v.refundOptions.find((o: any) => o.choice === 'refund_all')
    expect(all.result).toBe('$40.00 stays theirs as money paid ahead (the way it was paid) — it pays their bills with you if they rent again')
    const before = await tenantCredits()
    const d = await decide(f, { refundChoice: 'refund_all', quoteToken: v.quoteToken })
    expect(d.status).toBe(200)
    expect(await tenantCredits()).toEqual(before)
    expect(await remaining(c1)).toBe(40)
    expect((await query<any>(`SELECT COUNT(*)::int AS n FROM credit_uses WHERE refund_part_id IS NOT NULL`))[0].n).toBe(0)
    expect((await query<any>(`SELECT left_by_choice_id IS NOT NULL AS left FROM lease_prepaid_credits WHERE id = $1`, [c1]))[0].left).toBe(true)
    expect(d.body.data.choice.parts).toEqual([expect.objectContaining({ kind: 'credit', status: 'credited', words: '$40.00 stays theirs as money paid ahead' })])
    // Decided once: the screen and the to-do skip it now.
    expect((await view(f)).body.data.left).toBe(0)
    expect(await paidAheadChoiceTodos([f.landlordId])).toEqual([])
    // Money received: nothing moved, nothing counted.
    expect((await received(f, phxToday(), phxToday())).filter((e) => e.leaseId === f.leaseId)).toEqual([])
  })

  it('paid with a credit the landlord gave: it goes back as such a credit', async () => {
    const f = await seed()
    await creditPaidRent(f, 'issued')
    const v = (await view(f)).body.data
    expect(v.sources.map((s: any) => [s.kind, s.label])).toEqual([['credit', 'Account credit · Sep 1']])
    expect((await decide(f, { refundChoice: 'refund_all', quoteToken: v.quoteToken })).status).toBe(200)
    expect((await tenantCredits()).filter((c) => c.reason !== 'goodwill').map((c) => [c.amount, c.category])).toEqual([[40, 'other']])
  })
})

describe('a credit moved by something else keeps no stale mark', () => {
  it('money left as their credit that a renewal hand-off moved (rewriting its lease) is asked about again when that lease ends — never skipped for good', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 70, 'landlord')
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    const b = await tx(async (c) => {
      const lease = await seedLease(c, { unitId: f.unitId, landlordId: f.landlordId, rentAmount: 460, status: 'expired', startDate: '2026-10-01' })
      await c.query(`UPDATE leases SET end_date = '2026-10-02' WHERE id = $1`, [lease])
      await seedLeaseTenant(c, { leaseId: lease, tenantId: f.tenantId, role: 'primary' })
      return lease
    })
    // What a hand-off does today: the lease is rewritten, the mark is kept.
    await query(`UPDATE lease_prepaid_credits SET lease_id = $2 WHERE id = $1`, [credit, b])
    const v = (await request(app()).get(`/api/leases/${b}/paid-ahead-choice`).set('Authorization', `Bearer ${f.token}`)).body.data
    expect(v.left).toBe(70)
    expect((await paidAheadChoiceTodos([f.landlordId])).map((t) => t.href)).toEqual([`/leases/${b}/paid-ahead-choice`])
    const d = await request(app()).post(`/api/leases/${b}/paid-ahead-choice`).set('Authorization', `Bearer ${f.token}`)
      .send({ idempotencyKey: randomUUID(), quoteToken: v.quoteToken, refundChoice: 'no_refund', restChoice: 'keep' })
    expect(d.status).toBe(200)
    expect(await remaining(credit)).toBe(0)
  })
})

describe('a lease that came into force while the choice was made still gets the money', () => {
  it('the carry runs again after the choice commits (a trigger that fired before the mark was committed carried nothing)', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 80, 'landlord')
    expect((await decide(f, { refundChoice: 'no_refund', restChoice: 'credit' })).status).toBe(200)
    // A lease made active by another transaction whose trigger ran before the
    // mark was committed — emulated with the trigger off for that write.
    const lease2 = await tx(async (c) => {
      await c.query(`ALTER TABLE lease_tenants DISABLE TRIGGER trg_paid_ahead_carry_left_member`)
      await c.query(`ALTER TABLE leases DISABLE TRIGGER trg_paid_ahead_carry_left_lease`)
      const unit2 = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      const l2 = await seedLease(c, { unitId: unit2, landlordId: f.landlordId, rentAmount: 460, status: 'active', startDate: '2026-10-01' })
      await seedLeaseTenant(c, { leaseId: l2, tenantId: f.tenantId, role: 'primary' })
      await c.query(`ALTER TABLE leases ENABLE TRIGGER trg_paid_ahead_carry_left_lease`)
      await c.query(`ALTER TABLE lease_tenants ENABLE TRIGGER trg_paid_ahead_carry_left_member`)
      return l2
    })
    expect((await query<any>(`SELECT lease_id FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0].lease_id).toBe(f.leaseId)
    expect(await carryLeftAfterCommit(f.landlordId, f.leaseId, [f.tenantId])).toEqual([{ tenantId: f.tenantId, landlordId: f.landlordId }])
    expect((await query<any>(`SELECT lease_id, received_lease_id FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0])
      .toEqual({ lease_id: lease2, received_lease_id: f.leaseId })
  })
})

describe('a bank refund that the bank sends back says the bank', () => {
  it('refund.updated failed on a bank part: the part\'s failure and the owner\'s notice both say their bank — never the card company or a guest', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 560, method: 'ach', intent: 'pi_bank_back' }) })
    expect((await decide(f, { refundChoice: 'refund_all' })).status).toBe(200)
    expect(await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })).toBe(true)
    const part = (await view(f)).body.data.latest.parts.find((p: any) => p.status === 'failed')
    expect(part.kind).toBe('bank')
    expect(part.failure).toMatch(/^Their bank sent this refund back \(\$100\.00\) — press Try again, or press "Give it back in cash instead"/)
    expect(part.failure).not.toMatch(/card company|hand it back in cash and press/)
    const n = await query<any>(`SELECT title, body, action_url FROM notifications WHERE type = 'stay_refund_failed'`)
    expect(n).toHaveLength(1)
    expect(n[0].body).toMatch(/could not reach their bank\./)
    expect(`${n[0].title} ${n[0].body}`).not.toMatch(/card|guest|left early/)
    expect(n[0].action_url).toBe(`/leases/${f.leaseId}/paid-ahead-choice`)
  })
})

describe('a register-sale refund the register already gave back (no room left on the sale)', () => {
  it('offers no Try again and no "Give it back in cash instead": the line says to check at the register, a Try again press and the cash press are refused (409) in plain words, and the to-do says to check it', async () => {
    const f = await seed()
    const booking = await fromStay(f)
    const sale = (await query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, stripe_payment_intent_id)
       VALUES ($1,$2,'card',300,300,'pi_reg_sale') RETURNING id`, [f.landlordId, f.userId]))[0].id
    await query(`INSERT INTO stay_payments (booking_id, landlord_id, kind, stripe_payment_intent_id, method, pos_transaction_id, toward_stay, card_fee, landlord_card_fee, paid_at)
                 VALUES ($1,$2,'pos_sale','pi_reg_sale','card',$3,300,0,0,'2026-07-20T17:00:00Z')`, [booking, f.landlordId, sale])
    await paidAhead(f, 120, 'reclassified', { note: STAY_DEPOSIT_CREDIT_NOTE, receivedAt: '2026-07-20T17:00:00Z' })
    h.state.failNext = 1
    const d = await decide(f, { refundChoice: 'refund_all' })
    expect(d.status).toBe(200)
    const failed = d.body.data.choice.parts[0]
    expect(failed).toMatchObject({ kind: 'card', status: 'failed', cashInstead: true })
    // The register refunds the whole sale before anyone tries again.
    await query(`INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, reason) VALUES ($1,$2,300,'cash','register')`, [sale, f.landlordId])
    const v = (await view(f)).body.data
    expect(v.latest.parts[0]).toMatchObject({ id: failed.id, attention: true, retry: false, cashInstead: false, words: '$120.00 was not sent to the card — that sale was already refunded at the register' })
    // What to do, said to the person reading it — never "ask the owner" on the owner's own screen.
    expect(v.latest.parts[0].failure).toBe('Nothing was sent to the card: this sale was already refunded at the register, so only $0.00 is left on it. Check at the register what the tenant got back before giving anything more.')
    const sent = h.refundsCreate.mock.calls.length
    const again = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/retry`).set('Authorization', `Bearer ${f.token}`)
    expect(again.status).toBe(409)
    expect(again.body.error).toBe(`${v.latest.parts[0].failure} The page now shows the latest.`)
    expect(h.refundsCreate.mock.calls.length).toBe(sent)
    const cash = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/cash`).set('Authorization', `Bearer ${f.token}`)
    expect(cash.status).toBe(409)
    expect(cash.body.error).toMatch(/^This money came in on a register sale that was already refunded at the register/)
    expect((await query<any>(`SELECT COUNT(*)::int AS n FROM stay_refund_parts WHERE kind = 'cash'`))[0].n).toBe(0)
    const todos = (await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')
    expect(todos.map((t) => t.title)).toEqual(['Check a refund: money paid ahead on MH 08'])
    expect(todos[0].subtitle).toMatch(/already refunded at the register/)
  })
})

// ─── Choice46c ───────────────────────────────────────────────────────────────

const stmtMonth = () => phxToday().slice(0, 7)
/** The charges a tenant owes again for a refund a dispute or return took back (creditUse.recoverChoiceMoney). */
const owedAgain = () => query<any>(
  `SELECT import_extra_data->>'owed' AS what, amount::float AS amount, revenue_owner AS owed_to, status, type, entry_description AS entry,
          tenant_id, lease_id, notes
     FROM payments WHERE import_extra_data ? 'paid_ahead_refund_use_id' ORDER BY (import_extra_data->>'owed') DESC, created_at`)
const takenBackAlerts = () => query<any>(`SELECT title, body, context FROM admin_notifications WHERE category = 'paid_ahead_choice_taken_back' ORDER BY created_at`)
const partOn = (r: any) => r.body.data.choice.parts[0]
const cashPress = (f: F, partId: string) => request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${partId}/cash`).set('Authorization', `Bearer ${f.token}`)
const retryPress = (f: F, partId: string) => request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${partId}/retry`).set('Authorization', `Bearer ${f.token}`)
const r2 = (n: number) => Math.round(n * 100) / 100

/** $100 paid ahead by card through GAM (a $3.55 card fee); "Refund the unused days" did not reach the card; handed back in cash instead. */
async function handedBackInstead(f: F, pi: string) {
  await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: pi, fee: 3.55 }) })
  h.state.failNext = 1
  const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
  expect((await cashPress(f, failed.id)).status).toBe(200)
  const cash = (await query<{ id: string; amount: number }>(`SELECT id, amount::float AS amount FROM stay_refund_parts WHERE kind = 'cash'`))[0]
  expect(cash.amount).toBe(103.55)
  return { failed, cash }
}

describe('choice46c: a chargeback after "Give it back in cash instead" is netted from the landlord exactly like a Keep it release, and the refund becomes a balance the tenant owes (decisions #51)', () => {
  it('a full card dispute through the real dispute path: the $100 GAM released for the cash is charged back to the landlord once, the tenant owes the landlord the $103.55 handed back, GAM is told once, and a redelivered or second event changes nothing', async () => {
    const f = await seed()
    const { cash } = await handedBackInstead(f, 'pi_cash_disp')
    expect((await heldItems()).map((i) => [i.source_type, i.source_id, i.amount])).toEqual([['prepaid_draw', `cash-part:${cash.id}`, 100]])
    const out = await handlePaymentReversal({ paymentIntentId: 'pi_cash_disp', reversalType: 'card_dispute', reversalFee: 15, stripeEventId: 'evt_cash_disp', rawEvent: {} })
    expect(out.handled).toBe(true)
    expect((await choiceNets()).map((i) => [i.source_id, i.amount])).toEqual([[`owner_share_returned:paid-ahead-choice:pi_cash_disp:${cash.id}`, -100]])
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.owed_to, o.status, o.type, o.entry])).toEqual([
      ['refund', 100, 'landlord', 'pending', 'fee', 'OTHERFEE'],
      ['card_fee', 3.55, 'landlord', 'pending', 'fee', 'OTHERFEE'],
    ])
    expect((await owedAgain())[0]).toMatchObject({ tenant_id: f.tenantId, lease_id: f.leaseId })
    expect((await owedAgain())[0].notes).toMatch(/^Refund of money paid ahead on MH 08 \(\w{3} \d{1,2}\) — owed again: the payment it came from was disputed with their card company$/)
    expect(await takenBackAlerts()).toHaveLength(1)
    // A redelivered event, and a second event for the same charge: nothing more.
    await handlePaymentReversal({ paymentIntentId: 'pi_cash_disp', reversalType: 'card_dispute', reversalFee: 15, stripeEventId: 'evt_cash_disp', rawEvent: {} })
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_cash_disp', reversalId: null }))
    expect(await choiceNets()).toHaveLength(1)
    expect(await owedAgain()).toHaveLength(2)
    expect(await takenBackAlerts()).toHaveLength(1)
  })

  it('a full dispute: clawed is the $100 really covered, and the owner statement shows the charge-back under Returned or disputed — owner share plus returned equals the payout lines', async () => {
    const f = await seed()
    const { cash } = await handedBackInstead(f, 'pi_cash_full')
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_cash_full', reversalId: null }))
    expect(r).toMatchObject({ withdrawn: true, clawed: 100 })
    expect(r.nettedFromLandlord).toEqual([{ useId: expect.any(String), amount: 100, cashPartId: cash.id }])
    const st = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    const payout = r2((await heldItems()).filter((i) => ['prepaid_draw', 'dispute'].includes(i.source_type)).reduce((a, i) => a + i.amount, 0))
    expect(payout).toBe(0)
    expect(st.totals.returnedOrDisputed).toBe(-100)
    expect(r2(st.totals.ownerShare + st.totals.returnedOrDisputed)).toBe(payout)
  })

  it('a partial dispute charges back only the disputed part, and the tenant owes only that part (no card fee until the refund is wholly covered); a second event for the same dispute changes nothing', async () => {
    const f = await seed()
    const { cash } = await handedBackInstead(f, 'pi_cash_part')
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_cash_part', 'ch_cash_part', 'pi_cash_part', 40, 'needs_response')`)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_cash_part', reversalId: null, maxAmount: 40 }))
    expect(r.clawed).toBe(40)
    expect(r.nettedFromLandlord).toEqual([{ useId: expect.any(String), amount: 40, cashPartId: cash.id }])
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.owed_to])).toEqual([['refund', 40, 'landlord']])
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_cash_part', reversalId: null, maxAmount: 40 }))
    expect((await choiceNets()).map((i) => i.amount)).toEqual([-40])
    expect(await owedAgain()).toHaveLength(1)
    const st = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(st.totals.returnedOrDisputed).toBe(-40)
    expect(r2(st.totals.ownerShare + st.totals.returnedOrDisputed))
      .toBe(r2((await heldItems()).filter((i) => ['prepaid_draw', 'dispute'].includes(i.source_type)).reduce((a, i) => a + i.amount, 0)))
  })
})

describe('choice46c: a refund from this screen followed by a return or dispute of the original payment is owed again by the tenant (decisions #51)', () => {
  it('$200 paid ahead by bank, $50 refunded to the bank, $150 left as their credit, then a full return: the tenant owes GAM the $50, clawed is the $200 really covered ($150 taken off + $50 owed), GAM is told once — never silently short', async () => {
    const f = await seed()
    const credit = await paidAhead(f, 200, 'gam', { sourceRemittanceId: await remittance(f, { amount: 200, method: 'ach', intent: 'pi_probe_a' }) })
    const v = (await view(f)).body.data
    expect((await request(app()).get(`/api/leases/${f.leaseId}/paid-ahead-choice/refund-preview?amount=50`).set('Authorization', `Bearer ${f.token}`)).status).toBe(200)
    const d = await decide(f, { refundChoice: 'refund_other', refundAmount: 50, restChoice: 'credit', quoteToken: v.quoteToken })
    expect(partOn(d)).toMatchObject({ kind: 'bank', status: 'refunded' })
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_probe_a', reversalId: null }))
    expect(r).toMatchObject({ withdrawn: true, clawed: 200 })
    expect(r.refundsOwed?.map((o) => [o.what, o.owedTo, o.amount])).toEqual([['refund', 'gam', 50]])
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.owed_to, o.status])).toEqual([['refund', 50, 'gam', 'pending']])
    expect((await owedAgain())[0].notes).toMatch(/— owed again: the payment it came from was returned by their bank$/)
    const alerts = await takenBackAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].body).toContain('$50.00 of the')
    expect(alerts[0].body).toContain('is owed again by the tenant, to GAM.')
    expect(await query(`SELECT 1 FROM admin_notifications WHERE category = 'disputed_credit_short'`)).toHaveLength(0)
    expect((await query<any>(`SELECT voided_at IS NOT NULL AS gone FROM lease_prepaid_credits WHERE id = $1`, [credit]))[0].gone).toBe(true)
    // Again (a second event for the same charge): nothing more is owed, nobody is told again.
    const again = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_probe_a', reversalId: null }))
    expect(again.refundsOwed).toEqual([])
    expect(await owedAgain()).toHaveLength(1)
    expect(await takenBackAlerts()).toHaveLength(1)
  })

  it('a card refund of money GAM held, then a full dispute: the tenant owes GAM the $100 GAM sent back and the landlord the $3.55 card fee their payout gave back', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_card_refunded', fee: 3.55 }) })
    expect(partOn(await decide(f, { refundChoice: 'refund_all' }))).toMatchObject({ kind: 'card', status: 'refunded' })
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_card_refunded', reversalId: null }))
    expect(r.clawed).toBe(100)
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.owed_to])).toEqual([['refund', 100, 'gam'], ['card_fee', 3.55, 'landlord']])
  })
})

describe('choice46c: a refund that had not gone out when a dispute took the money back', () => {
  it('is marked, never sent or handed back: no Try again, no cash, off the to-do; clawed counts it and nothing is owed', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_not_out', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    expect(failed).toMatchObject({ status: 'failed', attention: true, retry: true })
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_not_out', reversalId: null }))
    expect(r.clawed).toBe(100)
    expect(r.refundsNotSent).toEqual([{ useId: expect.any(String), partId: failed.id, amount: 100 }])
    expect(await owedAgain()).toEqual([])
    const sent = h.refundsCreate.mock.calls.length
    const v = (await view(f)).body.data
    expect(v.latest.parts[0]).toMatchObject({ attention: false, retry: false, cashInstead: false, failure: null,
      words: '$103.55 was not sent to the card — the payment it came from was disputed with their card company, so that money already went back to them. Nothing more goes back' })
    expect(v.latest.words).toContain('$103.55 was not sent to the card — the payment it came from was disputed with their card company, so that money already went back to them. Nothing more goes back.')
    const retry = await retryPress(f, failed.id)
    expect(retry.status).toBe(409)
    expect(retry.body.error).toBe('This refund will not be sent: the payment it came from was disputed with their card company, so that $103.55 already went back to them. Nothing was sent, and nothing more goes back for it — the page now shows the latest.')
    const cash = await cashPress(f, failed.id)
    expect(cash.status).toBe(409)
    expect(cash.body.error).toMatch(/^The payment this money came from was disputed with their card company, so that \$103\.55 already went back to them\. Nothing was handed back/)
    expect(h.refundsCreate.mock.calls.length).toBe(sent)
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
    expect(await heldItems()).toEqual([])
    expect((await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')).toEqual([])
    // Fix pass 3: the owner statement ties to the payout — nothing went to or came off the landlord.
    const st = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect([st.totals.ownerShare, st.totals.returnedOrDisputed]).toEqual([0, 0])
  })
})

describe('choice46c: a refund of a payment that was disputed (not taken back by the dispute) can never go back the way it was paid', () => {
  it('no Try again (refused 409 in plain words) — the line and the to-do say to give it back in cash, and that works', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_disputed_rest', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_rest', 'ch_rest', 'pi_disputed_rest', 10, 'needs_response')`)
    const v = (await view(f)).body.data
    const line = '$103.55 cannot go back to the card: the payment it came from was disputed with their card company, so the card company will not take a refund.'
      + ' Press "Give it back in cash instead" (GAM first checks that it did not reach the card, then tells you when to hand the cash over).'
    expect(v.latest.parts[0]).toMatchObject({ attention: true, retry: false, cashInstead: true, failure: line })
    const sent = h.refundsCreate.mock.calls.length
    const retry = await retryPress(f, failed.id)
    expect(retry.status).toBe(409)
    expect(retry.body.error).toBe(`${line} The page now shows the latest.`)
    expect(h.refundsCreate.mock.calls.length).toBe(sent)
    const todos = (await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')
    expect(todos.map((t) => t.title)).toEqual(['A refund needs you: money paid ahead on MH 08'])
    expect((await cashPress(f, failed.id)).status).toBe(200)
    expect((await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')).toEqual([])
  })
})

describe('choice46c: the owner statement reconciles with the payout and Money received for every refund made from this screen', () => {
  it('a card refund of money GAM held: owner share and net drop by the card fee the payout gave back (owner share equals the payout lines), gross is unchanged; a refund Stripe sends back puts it back', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_stmt_refund', fee: 3.55 }) })
    const before = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(partOn(await decide(f, { refundChoice: 'refund_all' }))).toMatchObject({ status: 'refunded' })
    const after = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    const refundLines = r2((await heldItems()).filter((i) => i.source_type === 'refund').reduce((a, i) => a + i.amount, 0))
    expect(refundLines).toBe(-3.55)
    expect([r2(after.totals.ownerShare - before.totals.ownerShare), r2(after.totals.net - before.totals.net), r2(after.totals.grossCollected - before.totals.grossCollected)])
      .toEqual([-3.55, -3.55, 0])
    expect(after.totals.ownerShare).toBe(refundLines)
    expect(await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })).toBe(true)
    const back = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(back.totals.ownerShare).toBe(r2((await heldItems()).filter((i) => i.source_type === 'refund').reduce((a, i) => a + i.amount, 0)))
    expect(back.totals.ownerShare).toBe(0)
  })

  it('$40 the manager held, paid ahead in September and handed back in cash from this screen: September plus this month nets to $0 on the statement, matching Money received', async () => {
    const f = await seed()
    const cashIn = await remittance(f, { amount: 40, method: 'cash', at: '2026-09-03T17:00:00Z' })
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: cashIn, receivedAt: '2026-09-03T17:00:00Z' })
    const sept = await ownerStatement({ landlordId: f.landlordId, periodMonth: '2026-09' })
    expect(sept.totals.collectedDirectly).toBe(40)
    const before = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(partOn(await decide(f, { refundChoice: 'refund_all' }))).toMatchObject({ kind: 'cash', status: 'handed_back' })
    const after = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    const thisMonth = r2(after.totals.collectedDirectly - before.totals.collectedDirectly)
    expect(thisMonth).toBe(-40)
    expect(r2(after.totals.ownerShare - before.totals.ownerShare)).toBe(0)
    expect(r2(sept.totals.grossCollected + thisMonth)).toBe(0)
    // Money received reads the same: +$40 in September, −$40 the day it was handed back.
    const mine = (await received(f, '2026-09-01', phxToday())).filter((e) => e.leaseId === f.leaseId)
    expect(total(mine.filter((e) => e.day <= '2026-09-30'))).toBe(40)
    expect(total(mine)).toBe(0)
  })
})

// ─── Choice46c fix pass 2 ────────────────────────────────────────────────────

const NOT_RECORDED = 'The refund went to the card, but GAM could not finish recording it — press Try again.'
const partRows = () => query<any>(
  `SELECT id, kind, status, failure, toward_amount::float AS toward, card_fee_back::float AS fee_back, amount::float AS amount,
          replaces_part_id FROM stay_refund_parts ORDER BY created_at, seq`)
const payoutSum = async () => r2((await heldItems()).filter((i) => ['prepaid_draw', 'dispute', 'refund'].includes(i.source_type)).reduce((a, i) => a + i.amount, 0))

describe('choice46c fix pass 2: a partial dispute of a refund that had not gone out marks only what it covered', () => {
  it('a $10 partial dispute on a $100 failed refund leaves $90 offered as cash (on the to-do), and GAM releases exactly $90 when it is handed back', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_split', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    expect(failed).toMatchObject({ status: 'failed', amount: 103.55 })
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_split', 'ch_split', 'pi_split', 10, 'needs_response')`)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_split', reversalId: null, maxAmount: 10 }))
    // Reported truthfully: the dispute covered $10 — never the whole refund.
    expect(r.clawed).toBe(10)
    expect(r.refundsNotSent).toEqual([{ useId: expect.any(String), partId: failed.id, amount: 10 }])
    const rows = await partRows()
    expect(rows.map((p) => [p.kind, p.status, p.toward, p.fee_back, p.amount])).toEqual([
      ['card', 'failed', 10, 0, 10],          // what the dispute took back: never sent
      ['card', 'failed', 90, 3.55, 93.55],    // the rest, still theirs
    ])
    expect(rows[0].failure).toMatch(/^Not sent: .*Nothing more goes back\.$/)
    expect(rows[1]).toMatchObject({ replaces_part_id: failed.id })
    expect(rows[1].failure).toMatch(/Give it back in cash instead\.$/)
    // GAM is told what happened — never "settle the other $90.00 with the tenant by hand".
    const alert = (await takenBackAlerts())[0]
    expect(alert.body).toContain('the dispute took $10.00 of that money back to the tenant, so that part will never be sent.')
    expect(alert.body).toContain('The other $93.55 of the refund is still theirs and cannot go back to the card either')
    expect(alert.body).not.toMatch(/by hand/)
    // The screen: the $10 line is done, the $90 rest is offered as cash (no Try again: the card company takes no refund).
    const v = (await view(f)).body.data
    expect(v.latest.parts.map((p: any) => [p.amount, p.attention, p.retry, p.cashInstead])).toEqual([[10, false, false, false], [93.55, true, false, true]])
    expect(v.latest.parts[1].failure).toBe('$93.55 cannot go back to the card: the payment it came from was disputed with their card company, so the card company will not take a refund.'
      + ' Press "Give it back in cash instead" (GAM first checks that it did not reach the card, then tells you when to hand the cash over).')
    const todos = (await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')
    expect(todos.map((t) => [t.title, t.subtitle])).toEqual([['A refund needs you: money paid ahead on MH 08',
      'Oak Park · $93.55 cannot go back the way it was paid — that payment was disputed or returned by the bank. '
        + 'Open it and press "Give it back in cash instead" — GAM first checks that it did not go out, then tells you when to hand the cash over.']])
    // The same dispute again: nothing more is marked or split.
    const again = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_split', reversalId: null, maxAmount: 10 }))
    expect(again.refundsNotSent ?? []).toEqual([])
    expect(await partRows()).toHaveLength(2)
    // Handed back: GAM releases exactly the $90 it still holds — never the $100.
    const cash = await cashPress(f, v.latest.parts[1].id)
    expect(cash.status).toBe(200)
    expect(cash.body.data.words.slice(0, 2)).toEqual(['Hand back $93.55 in cash now.',
      'It is recorded as given back — nothing goes to the card. The $90.00 GAM held for them is added to your next payout.'])
    expect((await heldItems()).map((i) => [i.source_type, i.amount])).toEqual([['prepaid_draw', 90]])
    expect((await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')).toEqual([])
    // The owner statement carries what the payout carries.
    const st = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(st.totals.ownerShare + st.totals.returnedOrDisputed)).toBe(await payoutSum())
  })

  it('the dispute grows: a later, larger event takes only what is left of the rest, never what was already covered', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_grow', fee: 3.55 }) })
    h.state.failNext = 1
    partOn(await decide(f, { refundChoice: 'refund_all' }))
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_grow', 'ch_grow', 'pi_grow', 10, 'needs_response')`)
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_grow', reversalId: null, maxAmount: 10 }))
    await query(`UPDATE connect_disputes SET amount = 50 WHERE stripe_dispute_id = 'dp_grow'`)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_grow', reversalId: null, maxAmount: 50 }))
    expect(r.clawed).toBe(40)
    expect((await partRows()).map((p) => [p.status, p.toward, p.amount])).toEqual([['failed', 10, 10], ['failed', 40, 40], ['failed', 50, 53.55]])
  })
})

describe('choice46c fix pass 2: a chargeback after "Give it back in cash instead" whose release was never written', () => {
  it('the dispute writes the release first, then nets it, once: opening the screen pays nothing more — the payout lines sum to $0 and GAM is not short', async () => {
    const f = await seed()
    const { cash } = await handedBackInstead(f, 'pi_cash_crash')
    // A crash right after the press committed: the release was never written.
    await query(`DELETE FROM held_payout_items WHERE source_id = $1`, [`cash-part:${cash.id}`])
    const out = await handlePaymentReversal({ paymentIntentId: 'pi_cash_crash', reversalType: 'card_dispute', reversalFee: 15, stripeEventId: 'evt_cash_crash', rawEvent: {} })
    expect(out.handled).toBe(true)
    // Both written in the dispute's own transaction (one instant): compared by kind.
    expect((await heldItems()).map((i) => [i.source_type, i.source_id, i.amount]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ['dispute', `owner_share_returned:paid-ahead-choice:pi_cash_crash:${cash.id}`, -100],
      ['prepaid_draw', `cash-part:${cash.id}`, 100],
    ])
    // The screen opened afterwards releases nothing more.
    expect((await view(f)).status).toBe(200)
    expect(await heldItems()).toHaveLength(2)
    expect(await payoutSum()).toBe(0)
    // The tenant owes the landlord what was handed back (decisions #51); GAM absorbs nothing.
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.owed_to])).toEqual([['refund', 100, 'landlord'], ['card_fee', 3.55, 'landlord']])
    const st = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(st.totals.ownerShare + st.totals.returnedOrDisputed)).toBe(0)
  })
})

describe('choice46c fix pass 2: a refund that reached the card but was not recorded', () => {
  /** "Refund the unused days" went out to the card, then recording it failed (earlyCheckOut marks it not_recorded). */
  async function wentOutUnrecorded(f: F, pi: string) {
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: pi, fee: 3.55 }) })
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    expect(part.status).toBe('refunded')
    await query(`UPDATE stay_refund_parts SET status = 'failed', failure = $2, refunded_at = NULL, stripe_refund_id = NULL WHERE id = $1`, [part.id, NOT_RECORDED])
    await query(`DELETE FROM held_payout_items WHERE source_type = 'refund'`)
    return part
  }

  it('offers only Try again (never cash): a cash press is refused before anything is handed back, and Try again records it without sending again', async () => {
    const f = await seed()
    const part = await wentOutUnrecorded(f, 'pi_unrec')
    const line = (await view(f)).body.data.latest.parts[0]
    // Fix pass 3: the line leads with its amount, says Try again sends nothing again, and the press reads "Recording…" (recordOnly).
    expect(line).toMatchObject({ attention: true, retry: true, cashInstead: false, checkAgain: false, recordOnly: true,
      failure: '$103.55 went back to the card, but GAM could not finish recording it — press Try again to record it (nothing is sent again).',
      words: '$103.55 went back to the card — GAM has to finish recording it' })
    const cash = await cashPress(f, part.id)
    expect(cash.status).toBe(409)
    expect(cash.body.error).toBe('This refund already went to the card — GAM only has to finish recording it, so hand nothing back in cash. Press Try again to finish recording it — the page now shows the latest.')
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
    const sent = h.refundsCreate.mock.calls.length
    const retry = await retryPress(f, part.id)
    expect(retry.status).toBe(200)
    expect(partOn(retry)).toMatchObject({ status: 'refunded', attention: false })
    expect(h.refundsCreate.mock.calls.length).toBe(sent)
  })

  it('a dispute after it: the refund counts as gone out (the tenant owes it again, decisions #51), and Try again still only records it', async () => {
    const f = await seed()
    const part = await wentOutUnrecorded(f, 'pi_unrec_disp')
    const todo = (await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')
    // Fix pass 3: its own to-do — the money DID go back; GAM only has to record it.
    expect(todo.map((t) => [t.title, t.subtitle])).toEqual([['Finish recording a refund: money paid ahead on MH 08',
      'Oak Park · $103.55 already went back to the card — GAM only has to finish recording it. Do not hand anything back.']])
    expect(todo[0].subtitle).not.toMatch(/has not gone back/)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_unrec_disp', reversalId: null }))
    expect(r.refundsNotSent ?? []).toEqual([])
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.owed_to])).toEqual([['refund', 100, 'gam'], ['card_fee', 3.55, 'landlord']])
    expect((await view(f)).body.data.latest.parts[0]).toMatchObject({ retry: true, cashInstead: false })
    const after = (await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')
    expect(after.map((t) => t.title)).toEqual(['Finish recording a refund: money paid ahead on MH 08'])
    // Even after the dispute made the tenant owe it again (#51), the to-do never says it has not gone back.
    expect(after[0].subtitle).not.toMatch(/has not gone back/)
    const sent = h.refundsCreate.mock.calls.length
    const retry = await retryPress(f, part.id)
    expect(retry.status).toBe(200)
    expect(partOn(retry)).toMatchObject({ status: 'refunded' })
    expect(h.refundsCreate.mock.calls.length).toBe(sent)
  })
})

describe('choice46c fix pass 2: a refund stopped for a dispute that was later won', () => {
  it('offers Try again with the ordinary words (never "give it back in cash" beside it), and Try again sends it', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_won', fee: 3.55 }) })
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_won', 'ch_won', 'pi_won', 10, 'needs_response')`)
    const d = await decide(f, { refundChoice: 'refund_all' })
    expect(d.status).toBe(200)
    const stopped = partOn(d)
    expect(stopped).toMatchObject({ status: 'failed', retry: false, cashInstead: true })
    expect(h.refundsCreate).not.toHaveBeenCalled()
    await query(`UPDATE connect_disputes SET status = 'won' WHERE stripe_dispute_id = 'dp_won'`)
    const line = (await view(f)).body.data.latest.parts[0]
    expect(line).toMatchObject({ retry: true, failure: null, words: `${'$' + stopped.amount.toFixed(2)} could not be refunded to the card yet — press Try again` })
    const retry = await retryPress(f, stopped.id)
    expect(retry.status).toBe(200)
    expect(partOn(retry)).toMatchObject({ status: 'refunded' })
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
  })
})

describe('choice46c fix pass 2: a refund still sending whose payment was disputed, not stopped yet', () => {
  it('says it is being stopped with "Check again" — never a cash order with no button; Try again is refused in the same words; the next look stops it and offers cash', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_stopping', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    // Still "sending" 20 minutes on (a crash before Stripe), and its payment disputed since.
    await query(`UPDATE stay_refund_parts SET status = 'pending', failure = NULL, created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [part.id])
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_stopping', 'ch_stopping', 'pi_stopping', 10, 'needs_response')`)
    const words = '$103.55 to the card is being stopped: the payment it came from was disputed with their card company, so the card company will not take a refund.'
      + ' Press Check again in a moment; then "Give it back in cash instead" is offered (GAM tells you when to hand the cash over).'
    // A send holds its lock at that moment, so it cannot be stopped yet.
    const holder = await db.connect()
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`])
      const line = (await view(f)).body.data.latest.parts[0]
      expect(line).toMatchObject({ status: 'pending', attention: true, retry: false, cashInstead: false, checkAgain: true, failure: words })
      const retry = await retryPress(f, part.id)
      expect(retry.status).toBe(409)
      expect(retry.body.error).toBe(`${words} The page now shows the latest.`)
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`]).catch(() => {})
      holder.release()
    }
    // Check again: stopped now, and offered as cash.
    expect((await view(f)).body.data.latest.parts[0]).toMatchObject({ status: 'failed', retry: false, cashInstead: true, checkAgain: false })
    expect(h.refundsCreate.mock.calls.length).toBe(1)   // only the first try that failed
  })
})

describe('choice46c fix pass 2: a dispute meets a refund being sent at that moment', () => {
  it('waits for the send to finish, then sees what it became — a refund that went out is owed again, never marked "not sent"', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_race', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    const holder = await db.connect()
    let done = false
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`])
      const dispute = tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_race', reversalId: null })).then((r) => { done = true; return r })
      await new Promise((r) => setTimeout(r, 300))
      expect(done).toBe(false)   // waiting on the send's lock
      // The send finishes: Stripe took the refund.
      await holder.query(`UPDATE stay_refund_parts SET status = 'refunded', failure = NULL, refunded_at = NOW(), stripe_refund_id = 're_race' WHERE id = $1`, [part.id])
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`])
      const r = await dispute
      expect(r.refundsNotSent ?? []).toEqual([])
      expect(r.refundsOwed?.map((o) => [o.what, o.owedTo, o.amount])).toEqual([['refund', 'gam', 100], ['card_fee', 'landlord', 3.55]])
      expect((await partRows())[0].status).toBe('refunded')
    } finally {
      await holder.query(`SELECT pg_advisory_unlock_all()`).catch(() => {})
      holder.release()
    }
  })
})

// ─── Choice46c fix pass 3 ────────────────────────────────────────────────────

const STRIPE_DOWN = 'Stripe could not send this refund just now — press Try again, or hand it back in cash and press "Give it back in cash instead".'

describe('choice46c fix pass 3: a refund whose answer from Stripe was lost (it went out after all), then a dispute', () => {
  it('Stripe is asked first: the part is never marked "not sent", the tenant owes GAM the $100 again (decisions #51), and Try again only records it — nothing is sent twice', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_lost', fee: 3.55 }) })
    h.state.loseNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    expect(part).toMatchObject({ status: 'failed', retry: true })
    expect(h.made).toHaveLength(1)   // Stripe made it; GAM never heard back
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_lost', reversalId: null }))
    expect(r.refundsNotSent ?? []).toEqual([])
    expect(r.clawed).toBe(100)
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.owed_to])).toEqual([['refund', 100, 'gam'], ['card_fee', 3.55, 'landlord']])
    const line = (await view(f)).body.data.latest.parts[0]
    expect(line).toMatchObject({ retry: true, cashInstead: false, recordOnly: true,
      failure: '$103.55 went back to the card, but GAM could not finish recording it — press Try again to record it (nothing is sent again).' })
    expect((await cashPress(f, part.id)).status).toBe(409)
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
    const retry = await retryPress(f, part.id)
    expect(retry.status).toBe(200)
    expect(partOn(retry)).toMatchObject({ status: 'refunded' })
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    // The owner statement carries what the payout carries (the card fee their payout gave back with the refund).
    const st = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(await payoutSum()).toBe(-3.55)
    expect(r2(st.totals.ownerShare + st.totals.returnedOrDisputed)).toBe(await payoutSum())
  })

  it('Stripe out of reach: nothing is decided — a retry-later error (503, not a failure: Stripe delivers the event again) and nothing written; the next delivery marks it', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_unreach', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    h.state.listFailNext = 1
    const err = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_unreach', reversalId: null })).catch((e) => e)
    expect(isDisputeRetryLater(err)).toBe(true)
    expect(err).toMatchObject({ statusCode: 503, code: 'stripe_unreachable' })
    expect((await partRows()).map((p) => [p.status, p.failure])).toEqual([['failed', STRIPE_DOWN]])
    expect(await owedAgain()).toEqual([])
    expect(await takenBackAlerts()).toEqual([])
    const again = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_unreach', reversalId: null }))
    expect(again.refundsNotSent).toEqual([{ useId: expect.any(String), partId: part.id, amount: 100 }])
  })

  it('a refund Stripe turned down is never looked up again — it is marked at once', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_turned', fee: 3.55 }) })
    h.state.status = 'failed'
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    expect(part.failure).toMatch(/turned this refund down/)
    h.refundsList.mockClear()
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_turned', reversalId: null }))
    expect(r.refundsNotSent).toEqual([{ useId: expect.any(String), partId: part.id, amount: 100 }])
    expect(h.refundsList).not.toHaveBeenCalled()
  })
})

describe('choice46c fix pass 3: a dispute that meets a refund being sent for more than 10 seconds', () => {
  it('gives up with a distinct retry-later error (refund_part_busy, 503) — an expected wait, not a failed reversal — and writes nothing', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_busy_long', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    const holder = await db.connect()
    let err: any
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`])
      err = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_busy_long', reversalId: null })).catch((e) => e)
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`]).catch(() => {})
      holder.release()
    }
    expect(isDisputeRetryLater(err)).toBe(true)
    expect(err).toMatchObject({ statusCode: 503, code: 'refund_part_busy' })
    expect((await partRows()).map((p) => [p.status, p.failure])).toEqual([['failed', STRIPE_DOWN]])
    expect(await takenBackAlerts()).toEqual([])
  }, 30000)
})

describe('choice46c fix pass 3: a stay check-out refund of paid-ahead money that had not gone out when the dispute came', () => {
  it('a full dispute: the part is left exactly as it was (never marked done), what the dispute took of it is counted in clawed (the whole $100 — it went back to the tenant that way), nothing owed, and GAM is told plainly not to send it or hand it back', async () => {
    const f = await seed()
    const booking = await fromStay(f)
    const credit = await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_stay_left', fee: 3.55 }) })
    const decision = (await query<{ id: string }>(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, lease_id, left_on, question, choice, status, booked_price, stayed_worth, paid, refund_total, decided_at)
       VALUES ($1,$2,$3,'2026-09-20','overpaid','refund_unused','decided',1000,900,1100,100,NOW()) RETURNING id`, [booking, f.landlordId, f.leaseId]))[0].id
    const part = (await query<{ id: string }>(
      `INSERT INTO stay_refund_parts (decision_id, booking_id, landlord_id, seq, kind, prepaid_credit_id, stripe_payment_intent_id,
                                      toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label, status, failure)
       VALUES ($1,$2,$3,1,'card',$4,'pi_stay_left',100,0,100,0,0,'Card · Sep 3','failed',$5) RETURNING id`,
      [decision, booking, f.landlordId, credit, STRIPE_DOWN]))[0].id
    await query(`INSERT INTO credit_uses (prepaid_credit_id, refund_part_id, lease_id, amount, billing_month, source, status, applied_at)
                 VALUES ($1,$2,$3,100,'2026-09-01','refund','applied',NOW())`, [credit, part, f.leaseId])
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_stay_left', reversalId: null }))
    expect(r.refundsNotSent ?? []).toEqual([])
    expect(r.stayRefundsLeft).toEqual([{ useId: expect.any(String), partId: part, amount: 100, refund: 100, stillTheirs: 0 }])
    // Choice46d: counted once, here — so no rows or spends take it as well, and GAM is not told it is short.
    expect(r.clawed).toBe(100)
    expect(await query(`SELECT 1 FROM admin_notifications WHERE category = 'disputed_credit_short'`)).toHaveLength(0)
    expect((await partRows()).map((p) => [p.id, p.status, p.failure])).toEqual([[part, 'failed', STRIPE_DOWN]])
    expect(await owedAgain()).toEqual([])
    const alerts = await takenBackAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].body).toContain('A $100.00 refund from Glenda Ross\'s early check-out on MH 08 had not gone out: the dispute already gave that money back to the tenant.')
    expect(alerts[0].body).toContain('do NOT press either')
    expect(alerts[0].body).toContain(part)
    expect(alerts[0].body).toContain('Nothing of it is absorbed by GAM, as long as that stay refund is fixed by hand as said.')
  })

  /** $300 paid ahead by card through GAM; $100 of it spent on a stay's early check-out card refund that did not go out; $200 unspent. */
  async function stayRefundOf300(f: F, pi: string) {
    const booking = await fromStay(f)
    const credit = await paidAhead(f, 300, 'gam', { sourceRemittanceId: await remittance(f, { amount: 300, method: 'card', intent: pi, fee: 0 }) })
    const decision = (await query<{ id: string }>(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, lease_id, left_on, question, choice, status, booked_price, stayed_worth, paid, refund_total, decided_at)
       VALUES ($1,$2,$3,'2026-09-20','overpaid','refund_unused','decided',1000,900,1100,100,NOW()) RETURNING id`, [booking, f.landlordId, f.leaseId]))[0].id
    const part = (await query<{ id: string }>(
      `INSERT INTO stay_refund_parts (decision_id, booking_id, landlord_id, seq, kind, prepaid_credit_id, stripe_payment_intent_id,
                                      toward_amount, card_fee_back, amount, payout_drop, lodging_tax_share, label, status, failure, attempts)
       VALUES ($1,$2,$3,1,'card',$4,$5,100,0,100,0,0,'Card · Sep 3','failed','The card company turned this refund down — press Try again.',1) RETURNING id`,
      [decision, booking, f.landlordId, credit, pi]))[0].id
    await query(`INSERT INTO credit_uses (prepaid_credit_id, refund_part_id, lease_id, amount, billing_month, source, status, applied_at)
                 VALUES ($1,$2,$3,100,'2026-09-01','refund','applied',NOW())`, [credit, part, f.leaseId])
    const dispute = (amount: number) => query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ($1, $2, $3, $4, 'needs_response')`, [`dp_${pi}`, `ch_${pi}`, pi, amount])
    return { credit, part, dispute }
  }

  it('choice46d: a partial dispute the unspent money covers in full leaves the stay refund off the list, and nobody is told anything about it', async () => {
    const f = await seed()
    const { part, dispute } = await stayRefundOf300(f, 'pi_stay_part_a')
    await dispute(150)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_stay_part_a', reversalId: null, maxAmount: 150 }))
    expect(r.clawed).toBe(150)
    expect(r.stayRefundsLeft ?? []).toEqual([])
    expect(await takenBackAlerts()).toEqual([])
    expect((await partRows()).map((p) => [p.id, p.status])).toEqual([[part, 'failed']])
  })

  it('choice46d: a partial dispute covering $50 of a $100 stay refund says $50 went back and only the other $50 is still theirs; clawed counts the $50, no spend is undone for it, and GAM is not short', async () => {
    const f = await seed()
    const { part, dispute } = await stayRefundOf300(f, 'pi_stay_part_b')
    await dispute(250)
    const r = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_stay_part_b', reversalId: null, maxAmount: 250 }))
    expect(r.clawed).toBe(250)
    expect(r.reversed).toEqual([])
    expect(r.stayRefundsLeft).toEqual([{ useId: expect.any(String), partId: part, amount: 50, refund: 100, stillTheirs: 50 }])
    const alerts = await takenBackAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].body).toContain('$50.00 of it went back to the tenant through the dispute, so only the other $50.00 is still theirs.')
    expect(alerts[0].body).toContain('do NOT press either for the full amount')
    expect(alerts[0].body).toContain(`Send or hand back only the $50.00, by hand (refund part ${part}).`)
    expect(alerts[0].body).not.toContain('already gave that money back to the tenant')
    expect(await query(`SELECT 1 FROM admin_notifications WHERE category = 'disputed_credit_short'`)).toHaveLength(0)
    // The part itself is left exactly as it was (the stay's screen does not know a mark).
    expect((await partRows()).map((p) => [p.id, p.status, p.toward])).toEqual([[part, 'failed', 100]])
    // The same dispute again covers nothing more of it, and tells nobody again.
    const again = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_stay_part_b', reversalId: null, maxAmount: 250 }))
    expect(again.stayRefundsLeft ?? []).toEqual([])
    expect(await takenBackAlerts()).toHaveLength(1)
  })
})

describe('choice46c fix pass 3: each 409 names what the refetched page shows', () => {
  it('Try again on a refund still "sending" whose payment was disputed since: it is stopped first, so the 409 says what the refetched line says — give it back in cash — and that line offers cash', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_stop_first', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    await query(`UPDATE stay_refund_parts SET status = 'pending', failure = NULL, created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [part.id])
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_stop_first', 'ch_stop_first', 'pi_stop_first', 10, 'needs_response')`)
    const sent = h.refundsCreate.mock.calls.length
    const retry = await retryPress(f, part.id)
    expect(retry.status).toBe(409)
    const line = (await view(f)).body.data.latest.parts[0]
    expect(line).toMatchObject({ status: 'failed', retry: false, cashInstead: true, checkAgain: false })
    expect(line.failure).toMatch(/Press "Give it back in cash instead" \(GAM first checks that it did not reach the card, then tells you when to hand the cash over\)\.$/)
    expect(retry.body.error).toBe(`${line.failure} The page now shows the latest.`)
    expect(h.refundsCreate.mock.calls.length).toBe(sent)
  })

  it('a cash press while another request holds the refund: nothing was handed back, press Check again — never "the page shows it" (a Try again keeps the line failed) and never "look at this line again" (the page could not)', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_cash_busy', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    const holder = await db.connect()
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`])
      const cash = await cashPress(f, part.id)
      expect(cash.status).toBe(409)
      expect(cash.body.error).toBe('Another request is working on this refund right now, so nothing was handed back. Wait a moment, then press Check again.')
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`]).catch(() => {})
      holder.release()
    }
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
  })
})

// The landlord page's tests for these refund states render THESE responses
// (fix pass 3: never hand-made views) — refreshed with PAID_AHEAD_FIXTURE_UPDATE=1.
describe('the page\'s fixture for the refund states is the real response', () => {
  it('a refund that went out but was not recorded (and its Try again reply), one being stopped and then stopped, and a partial dispute\'s split', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const fixed = (leaseId: string) => query(`UPDATE paid_ahead_choices SET decided_at = '2026-10-04T18:00:00Z' WHERE lease_id = $1`, [leaseId])
    // Went to the card; GAM could not finish recording it (earlyCheckOut's own words).
    const a = await seed()
    await paidAhead(a, 100, 'gam', { sourceRemittanceId: await remittance(a, { amount: 100, method: 'card', intent: 'pi_fx_unrec', fee: 3.55 }) })
    const aPart = partOn(await decide(a, { refundChoice: 'refund_all' }))
    await query(`UPDATE stay_refund_parts SET status = 'failed', failure = $2, refunded_at = NULL, stripe_refund_id = NULL WHERE id = $1`, [aPart.id, NOT_RECORDED])
    await query(`DELETE FROM held_payout_items WHERE source_type = 'refund'`)
    await fixed(a.leaseId)
    const unrecorded = (await view(a)).body.data
    const unrecordedRetry = (await retryPress(a, aPart.id)).body.data
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    // Still "sending", its payment disputed since; a send holds it — then stopped.
    const b = await seed()
    await paidAhead(b, 100, 'gam', { sourceRemittanceId: await remittance(b, { amount: 100, method: 'card', intent: 'pi_fx_stop', fee: 3.55 }) })
    h.state.failNext = 1
    const bPart = partOn(await decide(b, { refundChoice: 'refund_all' }))
    await query(`UPDATE stay_refund_parts SET status = 'pending', failure = NULL, created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [bPart.id])
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_fx_stop', 'ch_fx_stop', 'pi_fx_stop', 10, 'needs_response')`)
    await fixed(b.leaseId)
    const holder = await db.connect()
    let stopping: any
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${bPart.id}`])
      stopping = (await view(b)).body.data
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${bPart.id}`]).catch(() => {})
      holder.release()
    }
    const stopped = (await view(b)).body.data
    // A $10 partial dispute of a $100 refund that had not gone out: $10 taken back, the rest offered as cash.
    const c = await seed()
    await paidAhead(c, 100, 'gam', { sourceRemittanceId: await remittance(c, { amount: 100, method: 'card', intent: 'pi_fx_split', fee: 3.55 }) })
    h.state.failNext = 1
    partOn(await decide(c, { refundChoice: 'refund_all' }))
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_fx_split', 'ch_fx_split', 'pi_fx_split', 10, 'needs_response')`)
    await tx((cl) => clawBackDisputedCharge(cl, { paymentIntentId: 'pi_fx_split', reversalId: null, maxAmount: 10 }))
    await fixed(c.leaseId)
    const split = (await view(c)).body.data
    // Choice46d fix pass 2 — a cash press whose answer was lost: the line
    // before it, the busy 409 a second press can meet while the first is still
    // working, the look after the first was recorded, and the reply to
    // pressing again after that (when it was recorded, and the next step).
    const d = await seed()
    await paidAhead(d, 100, 'gam', { sourceRemittanceId: await remittance(d, { amount: 100, method: 'card', intent: 'pi_fx_lost', fee: 3.55 }) })
    h.state.failNext = 1
    const dPart = partOn(await decide(d, { refundChoice: 'refund_all' }))
    await fixed(d.leaseId)
    const cashOpen = (await view(d)).body.data
    const dHolder = await db.connect()
    let cashBusy: any
    try {
      await dHolder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${dPart.id}`])
      const r = await cashPress(d, dPart.id)
      cashBusy = { status: r.status, body: r.body }
    } finally {
      await dHolder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${dPart.id}`]).catch(() => {})
      dHolder.release()
    }
    expect((await cashPress(d, dPart.id)).status).toBe(200)
    await query(`UPDATE stay_refund_parts SET created_at = '2026-10-04T18:30:00Z' WHERE replaces_part_id = $1`, [dPart.id])
    const cashDone = (await view(d)).body.data
    const cashAgain = (await cashPress(d, dPart.id)).body.data
    expect(cashBusy.body.code).toBe('refund_busy')
    // Choice46d fix pass 3: a look after the press never orders cash outright — by you (the gold box) or by someone else (ask them).
    const cashDoneCash = cashDone.latest.parts.find((p: any) => p.replacesPartId === dPart.id)
    expect(cashDoneCash.cashReply).toEqual([
      'This was recorded as given back in cash ($103.55) by you at October 4, 2026 at 11:30 AM — GAM checked first that it did not reach the card. If you have not handed that $103.55 over yet, hand it back in cash now; if you have, give nothing more.',
      'It is recorded as given back — nothing goes to the card. The $100.00 GAM held for them is added to your next payout.'])
    expect(cashDoneCash.cashReplyHandBack).toEqual([true, false])
    const otherDesk = await staff(d, { 'pos.refund': true })
    const cashDoneOther = (await view(d, otherDesk)).body.data
    const otherCash = cashDoneOther.latest.parts.find((p: any) => p.replacesPartId === dPart.id)
    expect(otherCash.cashReply[0]).toBe('This was recorded as given back in cash ($103.55) by Test Landlord at October 4, 2026 at 11:30 AM — GAM checked first that it did not reach the card. Ask Test Landlord whether it was handed over before giving anything.')
    expect(otherCash.cashReplyHandBack).toEqual([false, false])
    expect(unrecorded.latest.parts[0]).toMatchObject({ recordOnly: true, retry: true, cashInstead: false })
    expect(stopping.latest.parts[0]).toMatchObject({ checkAgain: true, retry: false, cashInstead: false })
    expect(stopped.latest.parts[0]).toMatchObject({ checkAgain: false, retry: false, cashInstead: true })
    expect(split.latest.parts.map((p: any) => [p.attention, p.retry, p.cashInstead])).toEqual([[false, false, false], [true, false, true]])
    const ids = new Map<string, string>()
    const stable = JSON.stringify({ unrecorded, unrecordedRetry, stopping, stopped, split, cashOpen, cashBusy, cashDone, cashDoneOther, cashAgain }, null, 2)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
        if (!ids.has(u)) ids.set(u, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`)
        return ids.get(u)!
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '2026-10-04T18:00:00.000Z')
      .replace(/(recorded as handed back in cash instead of to the (?:card|bank)(?: by [^"—]+?)? on )\w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M/g, '$1October 4, 2026 at 11:30 AM')
      .replace(/"decidedOn": "[^"]+"/g, '"decidedOn": "October 4, 2026 at 11:00 AM"')
      .replace(/"quoteToken": "[0-9a-f]+"/g, '"quoteToken": "quote-token"')
      .replace(/https?:\/\/[^\s"/]+/g, 'http://landlord.test') + '\n'
    const file = path.join(__dirname, '../../../landlord/src/pages/__fixtures__/paidAheadChoice.states.real.json')
    if (process.env.PAID_AHEAD_FIXTURE_UPDATE === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, stable)
    }
    expect(fs.readFileSync(file, 'utf8'), 'The paid-ahead screen\'s refund-state responses changed: run this test with PAID_AHEAD_FIXTURE_UPDATE=1, then the landlord page test').toBe(stable)
  })
})

// ─── Choice46d ───────────────────────────────────────────────────────────────

/** Money received from the arrival month through today, and the owner statement over the same months (gross plus returned). */
async function receivedAndStatement(f: F) {
  const mr = total((await received(f, '2026-09-01', phxToday())).filter((e) => e.leaseId === f.leaseId))
  let st = 0
  for (const m of [...new Set(['2026-09', stmtMonth()])]) {
    const s = await ownerStatement({ landlordId: f.landlordId, periodMonth: m })
    st = r2(st + s.totals.grossCollected + s.totals.returnedOrDisputed)
  }
  return { mr, st }
}

describe('choice46d: Money received reconciles with the owner statement and the payout after a dispute of money this screen refunded', () => {
  it('cash handed back instead, then a full dispute: the charge-back of the release comes off Money received on the dispute day, so it equals the statement — and owner share plus returned equals the payout lines', async () => {
    const f = await seed()
    await handedBackInstead(f, 'pi_mr_cash')
    expect((await handlePaymentReversal({ paymentIntentId: 'pi_mr_cash', reversalType: 'card_dispute', reversalFee: 15, stripeEventId: 'evt_mr_cash', rawEvent: {} })).handled).toBe(true)
    const today = (await received(f, phxToday(), phxToday())).filter((e) => e.leaseId === f.leaseId)
    expect(lines(today).filter(([l]) => l === 'returned')).toEqual([['returned', -100]])
    const { mr, st } = await receivedAndStatement(f)
    expect(mr).toBe(-100)
    expect(mr).toBe(st)
    const month = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(month.totals.ownerShare + month.totals.returnedOrDisputed)).toBe(await payoutSum())
  })

  it('a $10 partial dispute of a $100 refund that had not gone out, the other $90 handed back in cash: the $10 comes off once on the dispute day, and Money received equals the statement and the payout lines', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_mr_split', fee: 3.55 }) })
    h.state.failNext = 1
    partOn(await decide(f, { refundChoice: 'refund_all' }))
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_mr_split', 'ch_mr_split', 'pi_mr_split', 10, 'needs_response')`)
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_mr_split', reversalId: null, maxAmount: 10 }))
    const rest = (await view(f)).body.data.latest.parts.find((p: any) => p.cashInstead)
    expect((await cashPress(f, rest.id)).status).toBe(200)
    const today = (await received(f, phxToday(), phxToday())).filter((e) => e.leaseId === f.leaseId)
    expect(lines(today).sort()).toEqual([['paidAheadRefunded', -90], ['returned', -10]])
    const { mr, st } = await receivedAndStatement(f)
    expect(mr).toBe(0)
    expect(mr).toBe(st)
    const month = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(month.totals.ownerShare + month.totals.returnedOrDisputed)).toBe(await payoutSum())
  })

  it('a refund that had not gone out, wholly taken back by a full dispute: the $100 comes off once on the dispute day (it never goes out), so the September arrival nets to $0 and equals the statement', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_mr_mark', fee: 3.55 }) })
    h.state.failNext = 1
    partOn(await decide(f, { refundChoice: 'refund_all' }))
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_mr_mark', reversalId: null }))
    expect(lines((await received(f, '2026-09-01', '2026-09-30')).filter((e) => e.leaseId === f.leaseId))).toEqual([['paidAhead', 100]])
    expect(lines((await received(f, phxToday(), phxToday())).filter((e) => e.leaseId === f.leaseId))).toEqual([['returned', -100]])
    const { mr, st } = await receivedAndStatement(f)
    expect(mr).toBe(0)
    expect(mr).toBe(st)
    // A second event for the same charge adds nothing.
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_mr_mark', reversalId: null }))
    expect((await receivedAndStatement(f)).mr).toBe(0)
  })
})

describe('choice46d: a refund counted as owed again that then comes back failed at Stripe (decisions #51)', () => {
  it('the tenant never got it: the "owed again" refund and card fee are voided (kept as a record), the new part is marked as given back by the dispute — no Try again, no cash, off the to-do — and Money received nets to $0', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_owed_back', fee: 3.55 }) })
    expect(partOn(await decide(f, { refundChoice: 'refund_all' }))).toMatchObject({ kind: 'card', status: 'refunded' })
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_owed_back', reversalId: null }))
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.status])).toEqual([['refund', 100, 'pending'], ['card_fee', 3.55, 'pending']])
    // The refund comes back failed after the dispute counted it as gone out.
    expect(await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })).toBe(true)
    const v = (await view(f)).body.data
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.status])).toEqual([['refund', 100, 'voided'], ['card_fee', 3.55, 'voided']])
    const live = v.latest.parts.find((p: any) => p.kind === 'card' && p.status === 'failed')
    expect(live).toMatchObject({ attention: false, retry: false, cashInstead: false, failure: null })
    expect(live.words).toMatch(/^\$103\.55 was not sent to the card — the payment it came from was disputed with their card company/)
    expect((await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')).toEqual([])
    expect((await cashPress(f, live.id)).status).toBe(409)
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
    expect(await query(`SELECT 1 FROM admin_notifications WHERE category = 'paid_ahead_refund_owed_again_undone'`)).toHaveLength(1)
    // Opening it again changes nothing more.
    await view(f)
    expect(await query(`SELECT 1 FROM admin_notifications WHERE category = 'paid_ahead_refund_owed_again_undone'`)).toHaveLength(1)
    // Choice46d (review): Money received, the owner statement and the payout
    // agree — the refund's payout drop was put back when it came back, and
    // the marked part's card fee and payout drop are never charged.
    const { mr, st } = await receivedAndStatement(f)
    expect(mr).toBe(0)
    expect(mr).toBe(st)
    expect(await payoutSum()).toBe(0)
    expect((await heldItems()).map((i) => [i.source_type, i.amount])).toEqual([['refund', -3.55], ['refund', 3.55]])
    const month = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(month.totals.ownerShare + month.totals.returnedOrDisputed)).toBe(await payoutSum())
  })

  it('an "owed again" refund the tenant already paid is left alone: the new part stays theirs, offered as cash', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_owed_paid', fee: 3.55 }) })
    partOn(await decide(f, { refundChoice: 'refund_all' }))
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_owed_paid', reversalId: null }))
    await query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE import_extra_data ? 'paid_ahead_refund_use_id'`)
    await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })
    const live = (await view(f)).body.data.latest.parts.find((p: any) => p.kind === 'card' && p.status === 'failed')
    expect(live).toMatchObject({ attention: true, cashInstead: true })
    expect((await owedAgain()).map((o) => o.status)).toEqual(['settled', 'settled'])
    // Choice46d (review): handed back in cash — GAM releases the $100 it holds
    // again (the refund came back to it), once; the statement ties to the
    // payout and to Money received.
    expect((await cashPress(f, live.id)).status).toBe(200)
    const cash = (await query<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE kind = 'cash'`))[0]
    expect((await heldItems()).filter((i) => i.source_type === 'prepaid_draw').map((i) => [i.source_id, i.amount])).toEqual([[`cash-part:${cash.id}`, 100]])
    const { mr, st } = await receivedAndStatement(f)
    expect(mr).toBe(st)
    const month = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(month.totals.ownerShare + month.totals.returnedOrDisputed)).toBe(await payoutSum())
  })
})

describe('choice46d: the screen\'s own words for a refund that did not go out', () => {
  it('a Stripe timeout and a card refund sent back: the line never tells the worker to hand cash over before pressing — the press comes first and GAM checks the card', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_words', fee: 3.55 }) })
    expect((await decide(f, { refundChoice: 'refund_all' })).status).toBe(200)
    await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })
    const line = (await view(f)).body.data.latest.parts.find((p: any) => p.status === 'failed')
    expect(line.failure).toBe('The card company sent this refund back ($103.55) — press Try again, or press "Give it back in cash instead" (GAM first checks that it did not reach the card, then tells you when to hand the cash over).')
    expect(line.failure).not.toMatch(/hand it back in cash and press/)
    expect(line.replacesPartId).toEqual(expect.any(String))
  })

  it('a record-only Try again says it recorded the refund that had already gone out — never "— sent." as if a second one went', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_rec_words', fee: 3.55 }) })
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    await query(`UPDATE stay_refund_parts SET status = 'failed', failure = $2, refunded_at = NULL, stripe_refund_id = NULL WHERE id = $1`, [part.id, NOT_RECORDED])
    await query(`DELETE FROM held_payout_items WHERE source_type = 'refund'`)
    const r = await retryPress(f, part.id)
    expect(r.status).toBe(200)
    expect(r.body.data.words[0]).toBe('Recorded — the $103.55 had already gone back to the card; nothing was sent again.')
    expect(r.body.data.words.join(' ')).not.toMatch(/— sent\./)
    expect(r.body.data.handBack[0]).toBe(false)
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
  })

  it('a split: the taken-back part says its own amount only while the rest still waits — never "Nothing more goes back" beside a cash button', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_split_words', fee: 3.55 }) })
    h.state.failNext = 1
    partOn(await decide(f, { refundChoice: 'refund_all' }))
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_split_words', 'ch_split_words', 'pi_split_words', 10, 'needs_response')`)
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_split_words', reversalId: null, maxAmount: 10 }))
    const v = (await view(f)).body.data
    expect(v.latest.parts[0].words).toBe('$10.00 was not sent to the card — the payment it came from was disputed with their card company, so that $10.00 already went back to them')
    expect(v.latest.words.join(' ')).not.toMatch(/Nothing more goes back/)
    // Once the rest is handed back, nothing else waits: the plain "Nothing more goes back" again.
    expect((await cashPress(f, v.latest.parts[1].id)).status).toBe(200)
    expect((await view(f)).body.data.latest.parts[0].words).toMatch(/Nothing more goes back$/)
  })
})

// ─── Choice46d fix pass 2 ────────────────────────────────────────────────────

describe('choice46d fix pass 3: a dispute between the refund and the refund plus its card fee, through the real dispute path (paymentReversal)', () => {
  /** $100 paid ahead by card through GAM, charged $103.55 (a $3.55 card fee). */
  const card103 = async (f: F, pi: string) => {
    const rem = await remittance(f, { amount: 100, method: 'card', intent: pi, fee: 3.55 })
    await query(`UPDATE tenant_remittances SET gross_amount = 103.55 WHERE id = $1`, [rem])
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
  }
  /** A card dispute recorded and handled the way the webhook does it (connect_disputes, then paymentReversal). */
  const dispute = async (pi: string, id: string, amount: number) => {
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ($1, $2, $3, $4, 'needs_response')`, [`dp_${id}`, `ch_${id}`, pi, amount])
    const out = await handlePaymentReversal({ paymentIntentId: pi, reversalType: 'card_dispute', reversedAmount: amount, reversalFee: 15,
                                              stripeEventId: `evt_${id}`, stripeObjectId: `dp_${id}`, rawEvent: {} })
    expect(out.handled).toBe(true)
    return out
  }
  const keptFee = async () => (await heldItems()).filter((i) => /^stripe_fee_kept:/.test(i.source_id)).map((i) => [i.source_type, i.amount])
  /** Money received's chargeback-fee line (beside the total), the landlord's cost of the fee the dispute took. */
  const chargebackFeesBeside = async (f: F) => r2((await incomeEvents({ landlordIds: [f.landlordId], start: '2026-09-01', end: phxToday(), basis: 'received' }))
    .filter((e: any) => e.line === 'chargebackFees' && !e.inTotal).reduce((a: number, e: any) => a + e.amount, 0))
  const secondDisputeAlerts = () => query<any>(`SELECT title, body, context FROM admin_notifications WHERE category = 'dispute_second_on_charge'`)

  it('a refund that went out, then a $101 dispute: the tenant owes the $100 refund again and only $1.00 of the $3.55 card fee; Money received equals the statement, and the statement\'s owner share plus returned equals the payout lines (the kept-fee line included); a second dispute of the same charge is never guessed at; the refund then coming back failed voids both and leaves $2.55 theirs, offered as cash', async () => {
    const f = await seed()
    await card103(f, 'pi_fee101')
    expect(partOn(await decide(f, { refundChoice: 'refund_all' }))).toMatchObject({ status: 'refunded', amount: 103.55 })
    const out = await dispute('pi_fee101', 'fee101', 101)
    expect(out.creditClawed).toBe(100)
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.status])).toEqual([['refund', 100, 'pending'], ['card_fee', 1, 'pending']])
    expect((await takenBackAlerts())[0].body).toContain('$1.00 of the $3.55 card fee given back with that refund is owed again by the tenant, to the landlord')
    // Money received, the owner statement and the payout lines agree — Stripe's kept fee included, wherever it lands.
    // The landlord's payout carries the $3.55 card fee they gave back with the refund and Stripe's kept $1.00 — the fee
    // the dispute took (paymentReversal.chargeKeptStripeFee); the tenant owes them that $1.00 again.
    expect(await keptFee()).toEqual([['dispute', -1]])
    expect(await payoutSum()).toBe(-4.55)
    // Money received ties to the statement, and its chargeback-fee line beside the total is that same $1.00 payout line.
    const { mr, st } = await receivedAndStatement(f)
    expect([mr, st]).toEqual([0, 0])
    expect(await chargebackFeesBeside(f)).toBe(1)
    // Choice46e: the statement carries the kept $1.00 in the owner share (it is on the payout), beside the $3.55 card fee given back.
    const month = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect([month.totals.ownerShare, month.totals.returnedOrDisputed, month.totals.net]).toEqual([-4.55, 0, -4.55])
    expect(r2(month.totals.ownerShare + month.totals.returnedOrDisputed)).toBe(await payoutSum())
    // The same event again: nothing more is owed.
    await handlePaymentReversal({ paymentIntentId: 'pi_fee101', reversalType: 'card_dispute', reversedAmount: 101, reversalFee: 15, stripeEventId: 'evt_fee101', stripeObjectId: 'dp_fee101', rawEvent: {} })
    expect(await owedAgain()).toHaveLength(2)
    // A second dispute of the same charge (all its money already disputed): the ledger takes nothing more and bills no card fee by guessing — GAM is told, once.
    await dispute('pi_fee101', 'fee101b', 2.55)
    expect((await owedAgain()).map((o) => [o.what, o.amount])).toEqual([['refund', 100], ['card_fee', 1]])
    const second = await secondDisputeAlerts()
    expect(second).toHaveLength(1)
    expect(second[0].body).toContain('A card dispute of $2.55 (dp_fee101b) came on a payment that already had $101.00 disputed. The payment\'s money was $100.00, so none of this dispute can be its money and the other $2.55 is card fee.')
    expect(second[0].body).toContain('took back $0.00 of money for it and billed no card fee to the tenant or the landlord for it')
    await handlePaymentReversal({ paymentIntentId: 'pi_fee101', reversalType: 'card_dispute', reversedAmount: 2.55, reversalFee: 15, stripeEventId: 'evt_fee101b', stripeObjectId: 'dp_fee101b', rawEvent: {} })
    expect(await secondDisputeAlerts()).toHaveLength(1)
    await query(`DELETE FROM connect_disputes WHERE stripe_dispute_id = 'dp_fee101b'`)
    // The refund comes back failed: the tenant never got it.
    expect(await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })).toBe(true)
    const v = (await view(f)).body.data
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.status])).toEqual([['refund', 100, 'voided'], ['card_fee', 1, 'voided']])
    const live = v.latest.parts.filter((p: any) => p.kind === 'card' && p.status === 'failed')
    expect(live.map((p: any) => [p.amount, p.attention, p.cashInstead])).toEqual([[101, false, false], [2.55, true, true]])
    expect(live[0].words).toBe('$101.00 was not sent to the card — the payment it came from was disputed with their card company, so that $101.00 already went back to them')
    // Handed back: the $2.55 is the card fee the dispute did not give back — GAM held none of it, so it releases nothing.
    const cash = await cashPress(f, live[1].id)
    expect(cash.status).toBe(200)
    expect(cash.body.data.words.slice(0, 2)).toEqual(['Hand back $2.55 in cash now.', 'It is recorded as given back — nothing goes to the card.'])
    expect((await heldItems()).filter((i) => i.source_type === 'prepaid_draw')).toEqual([])
    // Stripe sent the refund back, so its $3.55 payout line was put back: only the kept $1.00 stays on the payout.
    expect(await payoutSum()).toBe(-1)
    const after = await receivedAndStatement(f)
    expect([after.mr, after.st]).toEqual([0, 0])
    expect(await chargebackFeesBeside(f)).toBe(1)
    const monthAfter = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(monthAfter.totals.ownerShare).toBe(-1)
    expect(r2(monthAfter.totals.ownerShare + monthAfter.totals.returnedOrDisputed)).toBe(await payoutSum())
  })

  it('a refund that had not gone out, then a $101 dispute: $101.00 of it is marked as given back and the other $2.55 is still theirs, offered as cash — GAM releases nothing for it; Money received equals the statement, and the statement\'s owner share plus returned equals the payout lines (the kept $1.00 included)', async () => {
    const f = await seed()
    await card103(f, 'pi_fee101ns')
    h.state.failNext = 1
    partOn(await decide(f, { refundChoice: 'refund_all' }))
    const out = await dispute('pi_fee101ns', 'fee101ns', 101)
    expect(out.creditClawed).toBe(100)
    expect((await partRows()).map((p) => [p.kind, p.status, p.toward, p.fee_back, p.amount])).toEqual([
      ['card', 'failed', 97.45, 3.55, 101],   // what the dispute gave back: the $100 and $1.00 of its fee
      ['card', 'failed', 2.55, 0, 2.55],      // the rest of the card fee, still theirs
    ])
    expect((await takenBackAlerts())[0].body).toContain('the dispute took $101.00 of that money back to the tenant, so that part will never be sent. The other $2.55 of the refund is still theirs')
    // The same event again marks nothing more.
    await handlePaymentReversal({ paymentIntentId: 'pi_fee101ns', reversalType: 'card_dispute', reversedAmount: 101, reversalFee: 15, stripeEventId: 'evt_fee101ns', stripeObjectId: 'dp_fee101ns', rawEvent: {} })
    expect(await partRows()).toHaveLength(2)
    const v = (await view(f)).body.data
    const rest = v.latest.parts.find((p: any) => p.cashInstead)
    expect(rest.amount).toBe(2.55)
    const cash = await cashPress(f, rest.id)
    expect(cash.status).toBe(200)
    expect(cash.body.data.words[1]).toBe('It is recorded as given back — nothing goes to the card.')
    expect((await heldItems()).filter((i) => i.source_type === 'prepaid_draw')).toEqual([])
    // Only Stripe's kept $1.00 is on the payout (the $2.55 left the landlord's drawer); Money received ties to the
    // statement, and its chargeback-fee line beside the total is that same $1.00.
    expect(await keptFee()).toEqual([['dispute', -1]])
    expect(await payoutSum()).toBe(-1)
    const { mr, st } = await receivedAndStatement(f)
    expect([mr, st]).toEqual([0, 0])
    expect(await chargebackFeesBeside(f)).toBe(1)
    const month = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect([month.totals.ownerShare, month.totals.returnedOrDisputed]).toEqual([-1, 0])
    expect(r2(month.totals.ownerShare + month.totals.returnedOrDisputed)).toBe(await payoutSum())
  })
})

describe('choice46d fix pass 2: the cash press puts right what a dispute settled first', () => {
  it('a refund counted as owed again that came back failed, before anyone opened the screen: the press runs the undo first — refused, nothing handed back, the owed-again charges voided', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_press_undo', fee: 3.55 }) })
    partOn(await decide(f, { refundChoice: 'refund_all' }))
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_press_undo', reversalId: null }))
    await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })
    const live = (await partRows()).find((p) => p.kind === 'card' && p.status === 'failed')!
    const r = await cashPress(f, live.id)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/^The payment this money came from was disputed with their card company, so that \$103\.55 already went back to them\. Nothing was handed back/)
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
    expect((await owedAgain()).map((o) => o.status)).toEqual(['voided', 'voided'])
  })

  it('cash handed back for a refund a dispute had already counted as never sent (the two raced): GAM releases nothing and tells its admin once, exactly', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_race_cash', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_race_cash', reversalId: null }))
    // The press's own check ran before the dispute marked it; earlyCheckOut's locked step then replaced it anyway.
    await givePartBackInCash(failed.id, null, f.userId)
    await view(f)
    await view(f)
    expect((await heldItems()).filter((i) => i.source_type === 'prepaid_draw')).toEqual([])
    const alerts = await query<any>(`SELECT title, body, context FROM admin_notifications WHERE category = 'paid_ahead_cash_after_taken_back'`)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].body).toContain('handed back $103.55 for a refund of money paid ahead on MH 08 that a card dispute or bank return of the payment it came from had already given back to the tenant')
    expect(alerts[0].body).toContain('GAM did not release the money it had held for it to the landlord')
    // The record never says GAM pays the landlord for it.
    expect((await view(f)).body.data.latest.words.join(' ')).not.toMatch(/added to your next payout/)
  })
})

describe('choice46d fix pass 2: a cash press whose answer was lost', () => {
  it('pressed again by the same person after the first one was recorded: the reply says it was recorded by you, when, and the plain next step, in the gold box — never a bare "handed back"', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_again', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    expect((await cashPress(f, failed.id)).status).toBe(200)
    const again = await cashPress(f, failed.id)
    expect(again.status).toBe(200)
    const w = again.body.data.words
    expect(w[0]).toMatch(/^This was already recorded as given back in cash \(\$103\.55\) by you at \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M — GAM checked first that it did not reach the card\. If you have not handed that \$103\.55 over yet, hand it back in cash now; if you have, give nothing more\.$/)
    expect(w[1]).toBe('It is recorded as given back — nothing goes to the card. The $100.00 GAM held for them is added to your next payout.')
    expect(again.body.data.handBack.slice(0, 2)).toEqual([true, false])
    expect(w.join(' ')).not.toMatch(/handed back in cash instead of to the card/)
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(1)
  })

  it('while another request holds the refund: a coded 409 (refund_busy), so the page keeps the press as not known yet', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_busy_code', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    const holder = await db.connect()
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`])
      const cash = await cashPress(f, part.id)
      expect([cash.status, cash.body.code]).toEqual([409, 'refund_busy'])
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${part.id}`]).catch(() => {})
      holder.release()
    }
  })

  it('an unexpected failure is said as "could not tell", coded outcome_unknown — never "nothing was saved"', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_unknown', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    const dbMod = await import('../db')
    const spy = vi.spyOn(dbMod, 'queryOne').mockImplementationOnce(async () => { throw new Error('connection reset') })
    try {
      const r = await cashPress(f, part.id)
      expect(r.status).toBe(500)
      expect(r.body.code).toBe('outcome_unknown')
      expect(r.body.error).toBe('GAM could not tell if that went through. The page now shows the latest — look at that line again before giving anything.')
    } finally { spy.mockRestore() }
  })
})

describe('choice46d fix pass 2: no line or to-do orders cash before the press', () => {
  it('a refund still "sending" whose payment was disputed: its to-do says to open it (GAM stops it first) — never "give it back in cash"', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_todo_stop', fee: 3.55 }) })
    h.state.failNext = 1
    const part = partOn(await decide(f, { refundChoice: 'refund_all' }))
    await query(`UPDATE stay_refund_parts SET status = 'pending', failure = NULL, created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [part.id])
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ('dp_todo_stop', 'ch_todo_stop', 'pi_todo_stop', 10, 'needs_response')`)
    const todos = (await paidAheadChoiceTodos([f.landlordId])).filter((t) => t.type === 'paid_ahead_refund_retry')
    expect(todos.map((t) => [t.id, t.title, t.subtitle])).toEqual([[`paid-ahead-refund-stop-${f.leaseId}`, 'A refund needs you: money paid ahead on MH 08',
      'Oak Park · $103.55 cannot go back the way it was paid — that payment was disputed or returned by the bank. '
        + 'Open it: GAM stops the refund, then offers "Give it back in cash instead" and tells you when to hand the cash over.']])
    // Every line, failure and to-do: "give it back in cash" only ever as the quoted button name.
    const v = (await view(f)).body.data
    const said = [...v.latest.words, ...v.latest.parts.flatMap((p: any) => [p.words, p.failure ?? '']), ...todos.flatMap((t) => [t.title, t.subtitle])].join(' | ')
    expect(said.replace(/"Give it back in cash instead"/g, '')).not.toMatch(/give it back in cash/i)
  })
})

// ─── Choice46d fix pass 3 ────────────────────────────────────────────────────

describe('choice46d fix pass 3: a cash press and a dispute (or the owed-again undo) never both give the money back', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const cashAfterAlerts = () => query<any>(`SELECT title, body, context FROM admin_notifications WHERE category = 'paid_ahead_cash_after_taken_back'`)
  const takenBackParts = () => query<any>(`SELECT id FROM stay_refund_parts WHERE failure = $1`, [PAID_AHEAD_PART_TAKEN_BACK])
  /** Runs `during` inside the press, after its checks and before the hand-back (earlyCheckOut.givePartBackInCash), then the real hand-back. */
  const between = async (during: () => Promise<void>) => {
    const eco = await import('./earlyCheckOut')
    const real = eco.givePartBackInCash
    return vi.spyOn(eco, 'givePartBackInCash').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await during()
      return real(...args)
    })
  }

  it('a dispute that arrives between the press\'s checks and its hand-back cannot mark the part (it is sent round again, never waiting under the credit\'s lock); delivered again it counts the cash as handed back: the press\'s order stands, the release is charged back once, the tenant owes it again, and nothing is marked "never sent"', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_race_press', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    let during: unknown = null
    const spy = await between(async () => {
      during = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_race_press', reversalId: null })).catch((e) => e)
    })
    try {
      const r = await cashPress(f, failed.id)
      expect(r.status).toBe(200)
      expect(r.body.data.words[0]).toBe('Hand back $103.55 in cash now.')
      expect(r.body.data.handBack[0]).toBe(true)
    } finally { spy.mockRestore() }
    // The dispute could not mark the part while the press held it: a retry-later (Stripe delivers it again), nothing written.
    expect(isDisputeRetryLater(during)).toBe(true)
    expect((during as any).code).toBe('refund_part_busy')
    expect(await takenBackParts()).toEqual([])
    const out = await tx((c) => clawBackDisputedCharge(c, { paymentIntentId: 'pi_race_press', reversalId: null }))
    expect(out.clawed).toBe(100)
    expect(await takenBackParts()).toEqual([])
    expect((await choiceNets()).map((i) => i.amount)).toEqual([-100])
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.owed_to])).toEqual([['refund', 100, 'landlord'], ['card_fee', 3.55, 'landlord']])
    expect(await cashAfterAlerts()).toEqual([])
  })

  it('a dispute recorded first holds the part: a cash press that arrives meanwhile waits for it, then is refused — nothing handed back', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_race_first', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    const c = await db.connect()
    let press: Promise<any>
    try {
      await c.query('BEGIN')
      await clawBackDisputedCharge(c as any, { paymentIntentId: 'pi_race_first', reversalId: null })
      press = cashPress(f, failed.id).then((r) => r)
      await sleep(300)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
    const r = await press!
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/so that \$103\.55 already went back to them\. Nothing was handed back/)
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
  })

  it('the owed-again undo that runs while a cash press is handing back steps aside (it never marks the part under the press), and after it finds nothing to mark: the order stands and the tenant still owes the refund the cash replaced', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_race_undo', fee: 3.55 }) })
    expect(partOn(await decide(f, { refundChoice: 'refund_all' }))).toMatchObject({ status: 'refunded' })
    // Stripe sends the refund back: a new failed part takes its place.
    expect(await stripeRefundFailed({ id: h.made[0].id, status: 'failed', metadata: h.made[0].metadata })).toBe(true)
    const live = (await partRows()).find((p) => p.kind === 'card' && p.status === 'failed')!
    const use = (await query<{ id: string }>(`SELECT id FROM credit_uses WHERE refund_part_id IS NOT NULL`))[0].id
    const { undoOwedAgainForFailedRefunds } = await import('./creditUse')
    let during = -1
    const spy = await between(async () => {
      // A dispute's "owed again" lands just now, and the undo runs for it (the sweep, a to-do).
      await query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, notes, revenue_owner, import_extra_data)
         VALUES ($1,$2,$3,$4,'fee',100,'pending','OTHERFEE',CURRENT_DATE,'owed again','gam',$5::jsonb)`,
        [f.unitId, f.leaseId, f.tenantId, f.landlordId, JSON.stringify({ paid_ahead_refund_use_id: use, owed: 'refund', charge: 'pi_race_undo' })])
      during = await tx((cl) => undoOwedAgainForFailedRefunds(cl, { leaseId: f.leaseId }))
    })
    try {
      const r = await cashPress(f, live.id)
      expect(r.status).toBe(200)
      expect(r.body.data.words[0]).toBe('Hand back $103.55 in cash now.')
    } finally { spy.mockRestore() }
    expect(during).toBe(0)
    expect(await tx((cl) => undoOwedAgainForFailedRefunds(cl, { leaseId: f.leaseId }))).toBe(0)
    expect(await takenBackParts()).toEqual([])
    expect(await query(`SELECT 1 FROM admin_notifications WHERE category = 'paid_ahead_refund_owed_again_undone'`)).toHaveLength(0)
    expect((await owedAgain()).map((o) => [o.what, o.amount, o.status])).toEqual([['refund', 100, 'pending']])
    expect(await cashAfterAlerts()).toEqual([])
  })

  it('a press whose own undo cannot finish is refused in plain words (503) — nothing handed back, the button named for the next try', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_undo_fails', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    const cu = await import('./creditUse')
    const spy = vi.spyOn(cu, 'undoOwedAgainForFailedRefunds').mockRejectedValueOnce(new Error('connection reset'))
    try {
      const r = await cashPress(f, failed.id)
      expect(r.status).toBe(503)
      expect(r.body.error).toBe('Nothing was handed back — GAM could not finish checking this refund. Wait a moment, then press "Give it back in cash instead" again.')
    } finally { spy.mockRestore() }
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
    // Pressed again once it can check: handed back.
    expect((await cashPress(f, failed.id)).body.data.words[0]).toBe('Hand back $103.55 in cash now.')
  })

  it('backstop — cash recorded for a part the owed-again undo had counted as given back (it names the part in its notice): the reply says do not hand anything back, never in gold; GAM is told once that the worker was told not to; nothing is released; the look says the same', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_backstop', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    const spy = await between(async () => {
      await query(`INSERT INTO admin_notifications (severity, category, title, body, context) VALUES ('info','paid_ahead_refund_owed_again_undone','t','b',$1)`,
        [JSON.stringify({ part_id: failed.id })])
    })
    let r: any
    try { r = await cashPress(f, failed.id) } finally { spy.mockRestore() }
    expect(r.status).toBe(200)
    expect(r.body.data.words[0]).toBe('Do not hand anything back — the payment this $103.55 came from was disputed with their card company a moment ago, so that money already went back to them. GAM has been told the record needs correcting.')
    expect(r.body.data.handBack[0]).toBe(false)
    expect(r.body.data.words.join(' ')).not.toMatch(/Hand back|added to your next payout/)
    const alerts = await cashAfterAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toMatch(/told NOT to hand it over/)
    expect(alerts[0].context.told_not_to).toBe(true)
    await view(f)
    expect(await cashAfterAlerts()).toHaveLength(1)
    expect((await heldItems()).filter((i) => i.source_type === 'prepaid_draw')).toEqual([])
    const cash = (await view(f)).body.data.latest.parts.find((p: any) => p.kind === 'cash')
    expect(cash.cashReply).toEqual(['Do not hand this $103.55 back — the payment it came from was disputed with their card company, so that money already went back to them. GAM has been told the record needs correcting.'])
    expect(cash.cashReplyHandBack).toEqual([false])
    expect(cash.words).toMatch(/^\$103\.55 was recorded as handed back in cash instead of to the card, but the payment it came from had already been disputed with their card company/)
  })
})

describe('choice46d fix pass 3: cash already recorded, pressed again by someone else', () => {
  it('names who recorded it and when, and says to ask them — never an order, never in gold; the look says the same', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_other_desk', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    expect((await cashPress(f, failed.id)).body.data.words[0]).toBe('Hand back $103.55 in cash now.')
    const desk = await staff(f, { 'pos.refund': true })
    const again = await request(app()).post(`/api/leases/${f.leaseId}/paid-ahead-choice/parts/${failed.id}/cash`).set('Authorization', `Bearer ${desk}`)
    expect(again.status).toBe(200)
    expect(again.body.data.words[0]).toMatch(/^This was already recorded as given back in cash \(\$103\.55\) by Test Landlord at \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M — GAM checked first that it did not reach the card\. Ask Test Landlord whether it was handed over before giving anything\.$/)
    expect(again.body.data.handBack.slice(0, 2)).toEqual([false, false])
    expect(again.body.data.words.join(' ')).not.toMatch(/hand it back in cash now|Hand back \$/)
    const cash = (await view(f, desk)).body.data.latest.parts.find((p: any) => p.kind === 'cash')
    expect(cash.cashReply[0]).toMatch(/by Test Landlord at .* Ask Test Landlord whether it was handed over before giving anything\.$/)
    expect(cash.cashReplyHandBack).toEqual([false, false])
    // The person who pressed it sees it as theirs (the gold box: hand it back if they have not).
    const mine = (await view(f)).body.data.latest.parts.find((p: any) => p.kind === 'cash')
    expect(mine.cashReply[0]).toMatch(/by you at .* If you have not handed that \$103\.55 over yet, hand it back in cash now; if you have, give nothing more\.$/)
    expect(mine.cashReplyHandBack).toEqual([true, false])
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(1)
  })
})

// ─── Choice46e ───────────────────────────────────────────────────────────────

describe('choice46e: nothing on the screen orders money given back before the press', () => {
  it('cash, a check, a money order and a bank deposit: the choice and the preview say what will happen after Confirm — never "Hand back" or "Give back"; the reply to the press gives each order, flagged for the gold box', async () => {
    const f = await seed()
    await paidAhead(f, 15, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 15, method: 'ach', intent: null, at: '2026-09-02T17:00:00Z' }), receivedAt: '2026-09-02T17:00:00Z' })
    await paidAhead(f, 20, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 20, method: 'money_order', at: '2026-09-04T17:00:00Z' }), receivedAt: '2026-09-04T17:00:00Z' })
    await paidAhead(f, 25, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 25, method: 'check', at: '2026-09-06T17:00:00Z' }), receivedAt: '2026-09-06T17:00:00Z' })
    await paidAhead(f, 40, 'landlord', { sourceRemittanceId: await remittance(f, { amount: 40, method: 'cash', at: '2026-09-10T17:00:00Z' }), receivedAt: '2026-09-10T17:00:00Z' })
    const v = (await view(f)).body.data
    const all = v.refundOptions.find((o: any) => o.choice === 'refund_all')
    expect(all.refund.parts.map((p: any) => p.words)).toEqual([
      '$40.00 back in cash at the desk — you are told to hand it over after you confirm',
      '$25.00 back at the desk — they paid by check (Check · Sep 6); you are told to give it back after you confirm',
      '$20.00 back at the desk — they paid by money order (Money order · Sep 4); you are told to give it back after you confirm',
      '$15.00 for you to give back — they paid by bank deposit (Bank deposit · Sep 2); you are told to give it back after you confirm',
    ])
    const before = [all.result, ...all.refund.parts.map((p: any) => p.words), ...v.refundOptions.map((o: any) => o.result)].join(' ')
    expect(before).not.toMatch(/Hand back|Give back|in cash now/)
    const preview = (await request(app()).get(`/api/leases/${f.leaseId}/paid-ahead-choice/refund-preview?amount=50`)
      .set('Authorization', `Bearer ${f.token}`)).body.data
    expect(preview.parts.map((p: any) => p.words).join(' ')).not.toMatch(/Hand back|Give back|in cash now/)
    expect(preview.parts[0].words).toBe('$40.00 back in cash at the desk — you are told to hand it over after you confirm')
    // The press itself: only its reply orders the money back.
    const r = await decide(f, { refundChoice: 'refund_all', quoteToken: v.quoteToken })
    expect(r.status).toBe(200)
    expect(r.body.data.words).toEqual([
      'Hand back $40.00 in cash now.',
      'Give back $25.00 — they paid by check (Check · Sep 6).',
      'Give back $20.00 — they paid by money order (Money order · Sep 4).',
      'Give back $15.00 — they paid by bank deposit (Bank deposit · Sep 2).',
    ])
    expect(r.body.data.handBack).toEqual([true, true, true, true])
  })
})

describe('choice46e: "Give it back in cash instead" when Stripe cannot be asked', () => {
  it('a 503 in this screen\'s own words, naming the button — nothing handed back, the refund still waits with its cash button', async () => {
    const f = await seed()
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: await remittance(f, { amount: 100, method: 'card', intent: 'pi_cash_503', fee: 3.55 }) })
    h.state.failNext = 1
    const failed = partOn(await decide(f, { refundChoice: 'refund_all' }))
    expect(failed).toMatchObject({ status: 'failed', cashInstead: true })
    h.state.listFailNext = 1
    const r = await cashPress(f, failed.id)
    expect(r.status).toBe(503)
    expect(r.body.error).toBe(stripeUnreachableWords('card'))
    expect(r.body.error).toBe('Nothing was handed back — GAM could not reach Stripe to check whether this refund already reached the card. Wait a minute, then press "Give it back in cash instead" again.')
    expect(r.body.error).not.toMatch(/press it again/)
    expect(await query(`SELECT 1 FROM stay_refund_parts WHERE kind = 'cash'`)).toHaveLength(0)
    expect((await heldItems()).filter((i) => i.source_type === 'prepaid_draw')).toEqual([])
    const still = (await view(f)).body.data.latest.parts.find((p: any) => p.id === failed.id)
    expect(still).toMatchObject({ status: 'failed', cashInstead: true })
    // Stripe reachable again: the same press goes through.
    const ok = await cashPress(f, failed.id)
    expect(ok.status).toBe(200)
    expect(ok.body.data.words[0]).toBe('Hand back $103.55 in cash now.')
  })
})

describe('choice46e: the record line for cash given instead of a card refund says it was recorded, by whom and when', () => {
  it('the same line for the person who pressed and for someone looking from another screen — never a bare "handed back" as a fact', async () => {
    const f = await seed()
    await handedBackInstead(f, 'pi_rec_line')
    const desk = await staff(f, { 'pos.refund': true })
    const mine = (await view(f)).body.data.latest
    const theirs = (await view(f, desk)).body.data.latest
    const line = /^\$103\.55 recorded as handed back in cash instead of to the card by Test Landlord on \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M$/
    expect(mine.parts.find((p: any) => p.kind === 'cash').words).toMatch(line)
    expect(theirs.parts.find((p: any) => p.kind === 'cash').words).toMatch(line)
    expect(theirs.words.join(' ')).not.toMatch(/(?<!recorded as )handed back in cash instead/)
    expect(theirs.words[0]).toMatch(/^\$103\.55 recorded as handed back in cash instead of to the card by Test Landlord on .* — the \$100\.00 GAM held for them is added to your next payout\.$/)
  })
})

describe('choice46e: a session lock whose unlock fails never stays on a pooled connection', () => {
  it('the connection is closed instead of pooled, so the lock goes with it — the next press can take the key', async () => {
    const key = paidAheadCashPressKey(randomUUID())
    const held = await db.connect()
    await held.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [key])
    const failing = {
      query: async (sql: string, params?: unknown[]) => {
        if (/pg_advisory_unlock/.test(sql)) throw new Error('the connection dropped mid-unlock')
        return held.query(sql, params as any[])
      },
    }
    expect(await unlockSession(failing as any, key)).toBe(false)
    releaseAfterSessionLock(held, false)
    const next = await db.connect()
    try {
      let ok = false
      for (let i = 0; i < 50 && !ok; i++) {
        ok = !!(await next.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key])).rows[0]?.ok
        if (!ok) await new Promise((r) => setTimeout(r, 50))
      }
      expect(ok).toBe(true)
      expect(await unlockSession(next, key)).toBe(true)
    } finally { next.release() }
  })

  it('a clean unlock gives the connection back to the pool; a failed one asks the pool to destroy it', async () => {
    const calls: unknown[] = []
    releaseAfterSessionLock({ release: (x?: unknown) => { calls.push(x) } } as any, true)
    releaseAfterSessionLock({ release: (x?: unknown) => { calls.push(x) } } as any, false)
    expect(calls).toEqual([undefined, true])
  })
})

describe('choice46e: the card fee a dispute takes back is on the owner statement, as on the payout', () => {
  /** A card dispute recorded and handled the way the webhook does it (connect_disputes, then paymentReversal). */
  const dispute = async (pi: string, id: string, amount: number) => {
    await query(`INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
                 VALUES ($1, $2, $3, $4, 'needs_response')`, [`dp_${id}`, `ch_${id}`, pi, amount])
    const out = await handlePaymentReversal({ paymentIntentId: pi, reversalType: 'card_dispute', reversedAmount: amount, reversalFee: 15,
                                              stripeEventId: `evt_${id}`, stripeObjectId: `dp_${id}`, rawEvent: {} })
    expect(out.handled).toBe(true)
    return out
  }
  /** A card payment through GAM ($fee on top) that paid a rent row of `rent` and banked `ahead` as money paid ahead. */
  async function cardPayment(f: F, pi: string, rent: number, ahead: number, fee: number) {
    const rem = await remittance(f, { amount: rent + ahead, method: 'card', intent: pi, fee, at: new Date().toISOString() })
    await query(`UPDATE tenant_remittances SET gross_amount = $2, applied_amount = $3, unapplied_amount = $4 WHERE id = $1`,
      [rem, (rent + ahead + fee).toFixed(2), rent.toFixed(2), ahead.toFixed(2)])
    const row = (await query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner, settled_at, stripe_payment_intent_id, platform_held)
       VALUES ($1,$2,$3,$4,'rent',$5,'settled','2026-10-01','RENT','landlord',NOW(),$6,TRUE) RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId, rent.toFixed(2), pi]))[0].id
    await query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`, [rem, row, rent.toFixed(2)])
    if (ahead > 0) await paidAhead(f, ahead, 'gam', { sourceRemittanceId: rem })
    return { rem, row }
  }

  it('a plain rent dispute: the kept card fee comes off the owner share (and net) in the month it was netted, at the rent\'s property — gross untouched, the money taken back beside it, and Money received shows the same fee beside its total', async () => {
    const f = await seed()
    await cardPayment(f, 'pi_rent_dp', 460, 0, 16.31)
    const before = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    await dispute('pi_rent_dp', 'rent_dp', 476.31)
    const kept = (await heldItems()).filter((i) => /^stripe_fee_kept:/.test(i.source_id))
    expect(kept.map((i) => [i.source_type, i.amount])).toEqual([['dispute', -16.31]])
    const after = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(after.totals.ownerShare - before.totals.ownerShare)).toBe(-16.31)
    expect(r2(after.totals.net - before.totals.net)).toBe(-16.31)
    expect(after.properties.find((p) => p.propertyId === f.propertyId)!.ownerShare).toBe(r2(before.properties.find((p) => p.propertyId === f.propertyId)!.ownerShare - 16.31))
    expect(after.totals.grossCollected).toBe(before.totals.grossCollected)
    expect(r2(after.totals.returnedOrDisputed - before.totals.returnedOrDisputed)).toBe(-460)
    const beside = (await incomeEvents({ landlordIds: [f.landlordId], start: '2026-09-01', end: phxToday(), basis: 'received' }))
      .filter((e: any) => e.line === 'chargebackFees' && !e.inTotal)
    expect(beside.map((e: any) => [e.propertyId, e.amount])).toEqual([[f.propertyId, 16.31]])
  })

  /** What of a charge's money is placed: reopened on its bills plus taken back off its money paid ahead. */
  const placed = async (pi: string) => r2(Number((await query<{ s: string }>(
    `SELECT (COALESCE((SELECT SUM(pr.reversed_amount) FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
                        WHERE p.stripe_payment_intent_id = $1), 0)
           + COALESCE((SELECT SUM(c.amount_original - c.amount_remaining) FROM lease_prepaid_credits c
                         JOIN tenant_remittances tr ON tr.id = c.source_remittance_id
                        WHERE tr.stripe_payment_intent_id = $1), 0))::text AS s`, [pi]))[0].s))
  const secondNotices = () => query<any>(`SELECT title, body, context FROM admin_notifications WHERE category = 'dispute_second_on_charge'`)
  const shortAlerts = () => query<any>(`SELECT title, body FROM admin_notifications WHERE category = 'payment_reversal_short'`)

  it('a second dispute on a charge that paid a bill and money paid ahead: the card-fee part is always named to settle by hand, and the notice says a bill-by-bill alert naming the same dollars is the same money — settle it once', async () => {
    const f = await seed()
    await cardPayment(f, 'pi_rows2', 50, 51, 3.55)
    await dispute('pi_rows2', 'rows2a', 51)
    await dispute('pi_rows2', 'rows2b', 53.55)
    const short = await shortAlerts()
    expect(short).toHaveLength(1)
    expect(short[0].body).toContain('Bill the other $3.55 to the tenant, or settle it with the landlord, by hand')
    const second = await secondNotices()
    expect(second).toHaveLength(1)
    expect(second[0].title).toBe('A second card dispute on the same payment (pi_rows2) — settle $3.55 of card fee by hand')
    expect(second[0].body).toContain('Settle the $3.55 with the landlord and the tenant by hand — GAM does not absorb it.')
    expect(second[0].body).toContain('The other $50.00 of this dispute\'s money is for the bills this payment paid to carry')
    expect(second[0].body).toContain('If an alert "… was not reopened on any bill (pi_rows2)" for this same dispute (dp_rows2b) names any of these same dollars, it is the same money — settle it once.')
    expect(second[0].body).not.toMatch(/do not bill it again|from that alert/)
    expect(second[0].context).toMatchObject({ card_fee_part: 3.55, for_bills: 50, charge_rows: 1, may_match_bill_alert: true })
    // Every dollar Stripe took is placed once: $101 on the bill and the money paid ahead, $3.55 named by hand.
    expect(await placed('pi_rows2')).toBe(101)
  })

  it('all of the charge\'s money disputed first, then a fee-only second dispute: no bill-by-bill alert is raised, so the notice itself names the $3.55 to settle by hand — never on nobody', async () => {
    const f = await seed()
    await cardPayment(f, 'pi_feeonly', 50, 51, 3.55)
    await dispute('pi_feeonly', 'feeonly_a', 101)
    expect(await placed('pi_feeonly')).toBe(101)
    await dispute('pi_feeonly', 'feeonly_b', 3.55)
    // Nothing more is reopened or taken back — the charge's money is all placed already.
    expect(await placed('pi_feeonly')).toBe(101)
    const byHand = [...(await shortAlerts()), ...(await secondNotices())]
      .filter((n) => /\$3\.55\b[^.]*by hand/.test(`${n.title} ${n.body}`))
    expect(byHand.length).toBeGreaterThanOrEqual(1)
    const second = await secondNotices()
    expect(second).toHaveLength(1)
    expect(second[0].title).toBe('A second card dispute on the same payment (pi_feeonly) — settle $3.55 of card fee by hand')
    expect(second[0].body).toContain('so none of this dispute can be its money and the other $3.55 is card fee')
    expect(second[0].body).toContain('Settle the $3.55 with the landlord and the tenant by hand — GAM does not absorb it.')
    // 101 placed + 3.55 named by hand = all 104.55 Stripe took.
    expect(r2((await placed('pi_feeonly')) + second[0].context.card_fee_part)).toBe(104.55)
  })

  it('$60 disputed first, then $44.55: the $3.55 of card fee is named by hand, and the $41.00 of money the paid-ahead ledger could not take back is named for the bills to carry, to check and settle by hand what was not reopened — every dollar Stripe took is placed or named, never on nobody', async () => {
    const f = await seed()
    await cardPayment(f, 'pi_6044', 50, 51, 3.55)
    await dispute('pi_6044', 'd6044a', 60)
    expect(await placed('pi_6044')).toBe(60)
    await dispute('pi_6044', 'd6044b', 44.55)
    const second = await secondNotices()
    expect(second).toHaveLength(1)
    expect(second[0].title).toBe('A second card dispute on the same payment (pi_6044) — settle $3.55 of card fee by hand')
    expect(second[0].body).toContain('so only $41.00 of this dispute can be its money and the other $3.55 is card fee')
    expect(second[0].body).toContain('took back $0.00 of money for it')
    expect(second[0].body).toContain('The other $41.00 of this dispute\'s money is for the bills this payment paid to carry: open them and check that $41.00 was reopened on them — bill whatever of it was not to the tenant, or settle it with the landlord, by hand.')
    expect(second[0].body).toContain('If an alert "… was not reopened on any bill (pi_6044)" for this same dispute (dp_d6044b) names any of these same dollars, it is the same money — settle it once.')
    expect(second[0].context).toMatchObject({ card_fee_part: 3.55, for_bills: 41, taken: 0 })
    // Placed (reopened on the bill or taken back) or named by hand: never less than the $104.55 Stripe took.
    expect(r2((await placed('pi_6044')) + second[0].context.for_bills + second[0].context.card_fee_part)).toBeGreaterThanOrEqual(104.55)
  })

  it('a kept-fee line whose charge has no lease on its receipt and paid no bills (all of it paid ahead) is placed at the lease the money arrived on — on the owner statement as on the payout, and beside Money received at the same property', async () => {
    const f = await seed()
    const rem = await remittance(f, { amount: 100, method: 'card', intent: 'pi_nolease', fee: 3.55, at: new Date().toISOString() })
    await query(`UPDATE tenant_remittances SET gross_amount = 103.55, lease_id = NULL WHERE id = $1`, [rem])
    await paidAhead(f, 100, 'gam', { sourceRemittanceId: rem })
    const before = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    await dispute('pi_nolease', 'nolease', 103.55)
    const kept = (await heldItems()).filter((i) => /^stripe_fee_kept:pi_nolease:/.test(i.source_id))
    expect(kept).toHaveLength(1)
    const after = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(after.totals.ownerShare - before.totals.ownerShare)).toBe(kept[0].amount)
    expect(r2(after.properties.find((p) => p.propertyId === f.propertyId)!.ownerShare
      - (before.properties.find((p) => p.propertyId === f.propertyId)?.ownerShare ?? 0))).toBe(kept[0].amount)
    const beside = (await incomeEvents({ landlordIds: [f.landlordId], start: '2026-09-01', end: phxToday(), basis: 'received' }))
      .filter((e: any) => e.line === 'chargebackFees' && !e.inTotal)
    expect(beside.map((e: any) => [e.propertyId, e.amount])).toEqual([[f.propertyId, -kept[0].amount]])
  })

  it('a kept-fee line for a charge GAM can place nowhere else lands at the landlord\'s first property — never dropped from the statement it is on the payout of', async () => {
    const f = await seed()
    const before = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    await query(`INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
                 VALUES ($1, 'dispute', $2, -2.50, 'Stripe fee kept')`, [f.landlordId, `stripe_fee_kept:pi_nowhere:${f.landlordId}`])
    const after = await ownerStatement({ landlordId: f.landlordId, periodMonth: stmtMonth() })
    expect(r2(after.totals.ownerShare - before.totals.ownerShare)).toBe(-2.5)
    expect(r2(after.totals.net - before.totals.net)).toBe(-2.5)
    const beside = (await incomeEvents({ landlordIds: [f.landlordId], start: '2026-09-01', end: phxToday(), basis: 'received' }))
      .filter((e: any) => e.line === 'chargebackFees' && !e.inTotal)
    expect(beside.map((e: any) => [e.propertyId, e.amount])).toEqual([[f.propertyId, 2.5]])
  })
})
