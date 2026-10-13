/**
 * 10/13 (Nic): "GAM fee pull disputed by landlord's bank: AUTOMATIC — the
 * disputed fees reopen as owed by the landlord, collected on the next pull,
 * admin told." Through the real webhook: a pull of GAM's fees settles
 * (payment_intent.succeeded), the landlord's bank disputes it
 * (charge.dispute.*), and the next pull takes the fees again.
 *
 * It used to reach the webhook as a charge nobody could place — one
 * 'dispute_charge_unplaced' notice, and the fees the bank took back read as
 * collected (GAM ate them). GAM never eats fees (Nic G1, "gam eats no fees of
 * failed pulls ever", on a later return alike): a pull that came back is a
 * failed pull — its own $6 is voided (GAM's price is for a transfer that
 * collects) and what it cost GAM at Stripe (its fee on the pull and the
 * dispute fee) is billed to the landlord at cost.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const stripeCreate = vi.hoisted(() => vi.fn(async (): Promise<any> => ({ id: 'pi_next_pull', status: 'processing' })))
/** Stripe's own fee on Oak Park's $54 pull: $0.27 (on its charge's balance transaction). */
const PULL_FEE_CENTS = 27
const stripeRetrieve = vi.hoisted(() => vi.fn(async (id: string): Promise<any> => (
  id === 'pi_gam_pull_sep'
    ? { id, latest_charge: { id: `ch_${id}`, balance_transaction: { fee: 27 }, failure_balance_transaction: null } }
    : { id })))
/** A dispute read from Stripe: by default it has not said its fee yet (no balance transaction). */
const disputeRetrieve = vi.hoisted(() => vi.fn(async (id: string): Promise<any> => ({ id, balance_transactions: [] })))
vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.paymentIntents = { create: stripeCreate, retrieve: vi.fn(async (id: string) => ({ id })), cancel: vi.fn(async (id: string) => ({ id })) }
    this.customers = { retrieve: vi.fn(async () => ({})), update: vi.fn(async () => ({})) }
    this.paymentMethods = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.refunds = { create: vi.fn(async () => ({ id: 're_x' })), list: vi.fn(async () => ({ data: [] })) }
  }
  return { default: FakeStripe }
})
// The pull itself goes through lib/stripe (which refuses a live key under test).
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ paymentIntents: { create: stripeCreate, retrieve: stripeRetrieve }, disputes: { retrieve: disputeRetrieve } }),
}))

import { webhooksRouter } from './webhooks'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { chargeLandlord, outstandingForLandlord } from '../services/landlordGamAccount'
import {
  debitLandlordForCharges, handleGamDebitDispute, readDisputedPullCosts, runGamDebitSweep,
  GAM_DEBIT_DISPUTE_COST_SOURCE, GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY,
} from '../services/landlordGamDebit'

function buildApp() {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  return app
}
const post = (body: unknown) => request(buildApp()).post('/webhooks/stripe')
  .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub').send(JSON.stringify(body))

beforeEach(async () => {
  await cleanupAllSchema()
  stripeCreate.mockClear()
  stripeRetrieve.mockClear()
  disputeRetrieve.mockReset()
  disputeRetrieve.mockImplementation(async (id: string) => ({ id, balance_transactions: [] }))
})

interface Pull { landlordId: string; propertyId: string; debitId: string; fee: string; cost: string }

/**
 * Oak Park's September: a $48 platform fee pulled from the bank with its $6
 * transfer cost — $54, settled. Made the way the sweep makes it
 * (debitLandlordForCharges), so the $6 is the pull's own cost line.
 */
async function settledPull(pi = 'pi_gam_pull_sep'): Promise<Pull> {
  const c = await db.connect()
  let landlordId: string, propertyId: string
  try {
    const ll = await seedLandlord(c)
    landlordId = ll.landlordId
    propertyId = await seedProperty(c, { landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
  } finally { c.release() }
  // A $40 threshold: the $48 fee is pulled, and so is what is owed after the dispute.
  await db.query(`UPDATE properties SET gam_debit_threshold = 40 WHERE id = $1`, [propertyId])
  await db.query(`UPDATE landlords SET gam_debit_payment_method_id = 'pm_test_bank', stripe_fc_customer_id = 'cus_test' WHERE id = $1`, [landlordId])
  const fee = (await chargeLandlord(null, { landlordId, propertyId, kind: 'subscription', amount: 48,
    sourceType: 'test_platform_fee', sourceId: '11111111-1111-4111-8111-111111111111' }))!
  stripeCreate.mockResolvedValueOnce({ id: pi, status: 'processing' })
  const made = await debitLandlordForCharges(landlordId)
  expect(made).toMatchObject({ status: 'debited', chargesAmount: 48, bankCost: 6, total: 54 })
  const debitId = made.debitId!
  const cost = (await db.query<{ id: string }>(
    `SELECT id FROM landlord_gam_charges WHERE landlord_id = $1 AND kind = 'bank_debit_cost'`, [landlordId])).rows[0].id
  const ok = await post({
    id: `evt_ok_${pi}`, type: 'payment_intent.succeeded',
    data: { object: { id: pi, metadata: { gam_debit_id: debitId }, payment_method_types: ['us_bank_account'] } },
  })
  expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  expect(await outstandingForLandlord(landlordId)).toBe(0)
  return { landlordId: landlordId!, propertyId: propertyId!, debitId, fee, cost }
}

function dispute(pi: string, cents: number, o: { status?: string; type?: string; eventId?: string; fee?: number } = {}) {
  return {
    id: o.eventId ?? `evt_dispute_${pi}_${o.status ?? 'needs_response'}`, type: o.type ?? 'charge.dispute.created',
    data: { object: { id: `du_${pi}`, object: 'dispute', charge: `ch_${pi}`, payment_intent: pi, amount: cents, currency: 'usd',
      status: o.status ?? 'needs_response', reason: 'fraudulent',
      balance_transactions: o.fee === undefined ? [{ amount: -cents, fee: 1500 }] : (o.fee ? [{ amount: -cents, fee: o.fee }] : []) } },
  }
}

const charge = async (id: string) => (await db.query<any>(
  `SELECT amount::float AS amount, collected_amount::float AS collected, voided_at, void_reason FROM landlord_gam_charges WHERE id = $1`, [id])).rows[0]
const pullRow = async (id: string) => (await db.query<any>(
  `SELECT status, disputed_at IS NOT NULL AS disputed, stripe_dispute_id, dispute_reopened_amount::float AS reopened,
          dispute_cost_amount::float AS cost, dispute_cost_charge_id, dispute_cost_read_at IS NOT NULL AS cost_read
     FROM landlord_gam_debits WHERE id = $1`, [id])).rows[0]
/** GAM's own book for the pull: the $6 booked when it landed, and anything taken back. */
const revenue = async (debitId: string) => (await db.query<any>(
  `SELECT type, reference_type, amount::float AS amount FROM platform_revenue_ledger WHERE reference_id = $1 ORDER BY created_at, amount DESC`,
  [debitId])).rows
const notices = async (category: string) => (await db.query<any>(
  `SELECT severity, title, body, context FROM admin_notifications WHERE category = $1 ORDER BY created_at`, [category])).rows

describe('the landlord\'s bank disputes a pull of GAM\'s fees', () => {
  it('the fees are owed again, the pull\'s own $6 is voided, what it cost GAM at Stripe is billed at cost, and an admin is told — never "a charge GAM cannot place"', async () => {
    const p = await settledPull()
    const res = await post(dispute('pi_gam_pull_sep', 5400))
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    // The fee the pull collected is owed again.
    expect(await charge(p.fee)).toMatchObject({ amount: 48, collected: 0, voided_at: null })
    // Nic G1: the pull came back, so its own $6 — GAM's price for a transfer
    // that collects — is voided, as on a failed pull (kept on record).
    const cost = await charge(p.cost)
    expect(cost).toMatchObject({ amount: 6, collected: 0, void_reason: 'bank_debit_failed' })
    expect(cost.voided_at).not.toBeNull()
    // The pull went through, so it stays succeeded — and says it was disputed.
    const pull = await pullRow(p.debitId)
    expect(pull).toMatchObject({ status: 'succeeded', disputed: true, stripe_dispute_id: 'du_pi_gam_pull_sep',
      reopened: 48, cost: (1500 + PULL_FEE_CENTS) / 100, cost_read: true })
    // Its collection records stay as written (keep-everything).
    expect((await db.query(`SELECT 1 FROM landlord_gam_charge_collections WHERE landlord_gam_debit_id = $1`, [p.debitId])).rowCount).toBe(2)
    // What the pull cost GAM at Stripe — its $0.27 fee on the pull and the
    // $15 dispute fee — is the landlord's, at cost (Nic G1).
    const costCharge = (await db.query<any>(
      `SELECT kind, amount::float AS amount, source_type, source_id FROM landlord_gam_charges WHERE id = $1`, [pull.dispute_cost_charge_id])).rows[0]
    expect(costCharge).toEqual({ kind: 'bank_debit_failed_cost', amount: 15.27, source_type: GAM_DEBIT_DISPUTE_COST_SOURCE, source_id: p.debitId })
    expect(stripeRetrieve).toHaveBeenCalledWith('pi_gam_pull_sep', expect.anything())
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
    // GAM's book: the $6 written down when the pull landed is taken back.
    expect(await revenue(p.debitId)).toEqual([
      { type: 'banking_spread', reference_type: 'gam_bank_debit', amount: 6 },
      { type: 'adjustment', reference_type: 'dispute_spread_reversal', amount: -6 },
    ])

    // An admin is told, once; the old "cannot place" notice is not raised.
    const told = await notices('gam_debit_disputed')
    expect(told).toHaveLength(1)
    expect(told[0].severity).toBe('warn')
    expect(told[0].body).toContain('The 1 charge it paid ($48.00) is owed by')
    expect(told[0].body).toContain('The pull\'s own $6.00 bank transfer cost was taken off')
    expect(told[0].body).toContain('What the pull cost GAM at Stripe ($15.27: its fee on the transfer and the dispute fee) is billed to them at cost.')
    expect(told[0].context).toMatchObject({ debit_id: p.debitId, reopened: 48, cost_line_voided: 6, cost_billed: 15.27, stripe_dispute_id: 'du_pi_gam_pull_sep' })
    expect(await notices('dispute_charge_unplaced')).toEqual([])
  })

  it('the same dispute again (updated, lost) changes nothing: reopened once, billed once, taken back once, told once', async () => {
    const p = await settledPull()
    expect((await post(dispute('pi_gam_pull_sep', 5400))).status).toBe(200)
    expect((await post(dispute('pi_gam_pull_sep', 5400, { status: 'needs_response', type: 'charge.dispute.updated', eventId: 'evt_upd' }))).status).toBe(200)
    expect((await post(dispute('pi_gam_pull_sep', 5400, { status: 'lost', type: 'charge.dispute.closed', eventId: 'evt_lost' }))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
    expect((await db.query(`SELECT 1 FROM landlord_gam_charges WHERE source_type = $1`, [GAM_DEBIT_DISPUTE_COST_SOURCE])).rowCount).toBe(1)
    expect((await revenue(p.debitId)).filter(r => r.reference_type === 'dispute_spread_reversal')).toHaveLength(1)
    expect(await notices('gam_debit_disputed')).toHaveLength(1)
  })

  it('collected on the next pull: the reopened fee and what the dispute cost go on it (never the voided $6), and settle', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    const next = await debitLandlordForCharges(p.landlordId)
    expect(next).toMatchObject({ status: 'debited', chargesAmount: 63.27, bankCost: 6, total: 69.27 })
    const nextPull = (await db.query<any>(`SELECT id, charge_ids FROM landlord_gam_debits WHERE stripe_payment_intent_id = 'pi_next_pull'`)).rows[0]
    const costChargeId = (await pullRow(p.debitId)).dispute_cost_charge_id
    expect(nextPull.charge_ids).toEqual(expect.arrayContaining([p.fee, costChargeId]))
    expect(nextPull.charge_ids).not.toContain(p.cost)
    const ok = await post({
      id: 'evt_ok_next', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_next_pull', metadata: { gam_debit_id: nextPull.id }, payment_method_types: ['us_bank_account'] } },
    })
    expect(ok.status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    expect(await charge(p.fee)).toMatchObject({ collected: 48 })
    // What each charge has collected = the collections of pulls that were not disputed.
    const tie = (await db.query<any>(
      `SELECT c.id, c.collected_amount::float AS collected,
              COALESCE((SELECT SUM(col.amount) FROM landlord_gam_charge_collections col
                          LEFT JOIN landlord_gam_debits d ON d.id = col.landlord_gam_debit_id
                         WHERE col.charge_id = c.id AND d.disputed_at IS NULL), 0)::float AS live
         FROM landlord_gam_charges c WHERE c.landlord_id = $1`, [p.landlordId])).rows
    for (const r of tie) expect(r.collected, r.id).toBe(r.live)
  })

  it('a dispute that has not said its fee yet reopens the fees; what it cost is billed when a later event says it', async () => {
    const p = await settledPull()
    expect((await post(dispute('pi_gam_pull_sep', 5400, { fee: 0 }))).status).toBe(200)
    // Read from Stripe instead: the dispute has no balance transaction yet.
    expect(disputeRetrieve).toHaveBeenCalledWith('du_pi_gam_pull_sep')
    expect(await outstandingForLandlord(p.landlordId)).toBe(48)
    expect(await pullRow(p.debitId)).toMatchObject({ reopened: 48, cost: null, cost_read: false })
    expect((await notices('gam_debit_disputed'))[0].body).toContain('What the pull cost GAM at Stripe could not be read yet')
    expect((await post(dispute('pi_gam_pull_sep', 5400, { type: 'charge.dispute.funds_withdrawn', eventId: 'evt_fw', fee: 1500 }))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
    expect(await pullRow(p.debitId)).toMatchObject({ reopened: 48, cost: 15.27, cost_read: true })
  })

  it('a cost Stripe has not said is read by the nightly sweep; still unread after three days, an admin is told once', async () => {
    const p = await settledPull()
    expect((await post(dispute('pi_gam_pull_sep', 5400, { fee: 0 }))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(48)

    // The first night: still nothing from Stripe, and too soon to tell anyone.
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    expect(await notices(GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY)).toEqual([])

    // Three days on, Stripe still silent: an admin is told — once.
    await db.query(`UPDATE landlord_gam_debits SET disputed_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [p.debitId])
    await readDisputedPullCosts()
    await readDisputedPullCosts()
    const told = await notices(GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY)
    expect(told).toHaveLength(1)
    expect(told[0].context).toMatchObject({ debit_id: p.debitId, stripe_dispute_id: 'du_pi_gam_pull_sep' })

    // Stripe says its fee: the nightly sweep (runGamDebitSweep) bills it at cost.
    disputeRetrieve.mockImplementation(async (id: string) => ({ id, balance_transactions: [{ amount: -5400, fee: 1500 }] }))
    await runGamDebitSweep()
    expect(await pullRow(p.debitId)).toMatchObject({ cost: 15.27, cost_read: true })
    const owed = (await db.query<any>(
      `SELECT amount::float AS amount FROM landlord_gam_charges WHERE source_type = $1 AND source_id = $2`,
      [GAM_DEBIT_DISPUTE_COST_SOURCE, p.debitId])).rows
    expect(owed).toEqual([{ amount: 15.27 }])
  })

  it('Stripe unreachable when the dispute comes: the fees still reopen, and what it cost is billed once Stripe can be read', async () => {
    const p = await settledPull()
    stripeRetrieve.mockRejectedValueOnce(new Error('Stripe is down'))
    expect((await post(dispute('pi_gam_pull_sep', 5400))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(48)
    expect(await pullRow(p.debitId)).toMatchObject({ disputed: true, reopened: 48, cost_read: false })
    // The nightly sweep reads the pull's own fee and the dispute fee from Stripe.
    disputeRetrieve.mockImplementation(async (id: string) => ({ id, balance_transactions: [{ amount: -5400, fee: 1500 }] }))
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 1 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
    expect(await readDisputedPullCosts()).toEqual({ considered: 0, read: 0 })
  })

  it('an inquiry takes no money: nothing reopens, an admin is told once', async () => {
    const p = await settledPull()
    expect((await post(dispute('pi_gam_pull_sep', 5400, { status: 'warning_needs_response' }))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    expect(await pullRow(p.debitId)).toMatchObject({ disputed: false })
    expect(await notices('gam_debit_dispute_inquiry')).toHaveLength(1)
    expect(await notices('dispute_charge_unplaced')).toEqual([])
  })

  it('a dispute before the pull\'s own success is recorded is put off (503: Stripe sends it again), and nothing changes', async () => {
    const c = await db.connect()
    let landlordId: string
    try { landlordId = (await seedLandlord(c)).landlordId } finally { c.release() }
    const fee = (await chargeLandlord(null, { landlordId, kind: 'subscription', amount: 48,
      sourceType: 'test_platform_fee', sourceId: '22222222-2222-4222-8222-222222222222' }))!
    await db.query(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, stripe_payment_intent_id, charge_ids)
       VALUES ($1, 48, 0, 48, 'pending', 'pi_pull_unsettled', ARRAY[$2::uuid])`, [landlordId, fee])
    const res = await post(dispute('pi_pull_unsettled', 4800))
    expect(res.status).toBe(503)
    expect((await db.query(`SELECT disputed_at FROM landlord_gam_debits WHERE stripe_payment_intent_id = 'pi_pull_unsettled'`)).rows[0].disputed_at).toBeNull()
    expect(await notices('gam_debit_disputed')).toEqual([])
  })

  it('a dispute for part of a pull is not reopened by itself: a person decides (critical, once)', async () => {
    const p = await settledPull()
    expect((await post(dispute('pi_gam_pull_sep', 2000))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    const told = await notices('gam_debit_dispute_unplaced')
    expect(told).toHaveLength(1)
    expect(told[0].severity).toBe('critical')
  })

  it('a won dispute is not undone by itself: one critical notice lists what to undo by hand', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    const won = {
      id: 'evt_won', type: 'charge.dispute.closed',
      data: { object: { id: 'du_pi_gam_pull_sep', object: 'dispute', charge: 'ch_pi_gam_pull_sep', payment_intent: 'pi_gam_pull_sep',
        amount: 5400, currency: 'usd', status: 'won', reason: 'fraudulent',
        balance_transactions: [{ amount: -5400, fee: 1500 }, { amount: 5400, fee: -1500 }] } },
    }
    expect((await post(won)).status).toBe(200)
    // Nothing changed by itself.
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
    expect(await charge(p.cost)).toMatchObject({ void_reason: 'bank_debit_failed' })
    const told = await notices('gam_debit_dispute_won')
    expect(told).toHaveLength(1)
    expect(told[0].severity).toBe('critical')
    expect(told[0].body).toContain('1. Mark $48.00 of the reopened charges collected again')
    expect(told[0].body).toContain('2. The pull\'s $6.00 bank transfer cost was voided when the dispute opened')
    expect(told[0].body).toContain('3. Take $15.00 off what the dispute cost was billed to')
    expect(told[0].body).toContain('($15.27)')
    // A redelivery tells nobody again.
    expect((await post({ ...won, id: 'evt_won_again' })).status).toBe(200)
    expect(await notices('gam_debit_dispute_won')).toHaveLength(1)
  })

  it('a charge that is not a pull is left to the rest of the dispute path', async () => {
    expect(await handleGamDebitDispute({
      paymentIntentId: 'pi_not_a_pull', stripeDisputeId: 'du_x', disputeStatus: 'needs_response', eventStatus: 'needs_response',
      disputedCents: 100, feeCents: 1500,
    })).toEqual({ handled: false })
  })
})
