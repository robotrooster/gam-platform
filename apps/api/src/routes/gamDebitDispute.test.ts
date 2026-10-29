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
 *
 * 10/13 (Nic, afternoon): "Won GAM pull dispute: AUTOMATIC (back to collected;
 * anything collected twice credited back). Dispute fee unknown → bill $15."
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
import {
  chargeLandlord, outstandingForLandlord, voidGamCharge, netAgainstDisbursement, recordGamChargeCollections, type GamChargeTake,
} from '../services/landlordGamAccount'
import {
  debitLandlordForCharges, handleGamDebitDispute, readDisputedPullCosts, runGamDebitSweep, applyWonGamDebitDisputes,
  disputeCostRebillSourceId, gamDebitWonGiveBackSourceId, gamChargeVoidedGiveBackSourceId, gamChargeVoidedTakeBackSourceId,
  GAM_DEBIT_DISPUTE_COST_SOURCE, GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY, GAM_DEBIT_DISPUTE_FEE_ASSUMED_CATEGORY,
  GAM_DEBIT_DISPUTE_FEE_CORRECTED_CATEGORY, GAM_DEBIT_DISPUTE_WON_CATEGORY, STRIPE_USUAL_DISPUTE_FEE_CENTS,
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
  // 10/13: a won dispute reads what Stripe gave back of its fee from the
  // dispute's stored webhooks too; every test here reuses one dispute id.
  await db.query(`TRUNCATE stripe_webhook_events`)
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
/** 10/13: the dispute fee inside the bill, and whether it is Stripe's word or the $15 in its place. */
const feeRow = async (id: string) => (await db.query<any>(
  `SELECT dispute_fee_amount::float AS fee, dispute_fee_assumed_at IS NOT NULL AS assumed, dispute_fee_stated_at IS NOT NULL AS stated,
          dispute_cost_amount::float AS cost, dispute_cost_charge_id
     FROM landlord_gam_debits WHERE id = $1`, [id])).rows[0]
/** 10/13: what a win did. */
const wonRow = async (id: string) => (await db.query<any>(
  `SELECT status, disputed_at IS NOT NULL AS disputed, dispute_won_at IS NOT NULL AS won,
          dispute_won_restored_amount::float AS restored, dispute_won_given_back_amount::float AS given_back,
          dispute_cost_amount::float AS cost, dispute_cost_charge_id
     FROM landlord_gam_debits WHERE id = $1`, [id])).rows[0]
/** What GAM holds to pay the landlord on their next payout. */
const held = async (landlordId: string) => (await db.query<any>(
  `SELECT source_type, source_id, amount::float AS amount, payout_intent_id FROM held_payout_items WHERE landlord_id = $1 ORDER BY source_id`,
  [landlordId])).rows
/** Payout lines in a fixed order (byte order, not the database's collation). */
const sortedBySource = <T extends { source_id: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0))
/** The live charges billing what a dispute cost (one at a time). */
const liveCostCharges = async (landlordId: string) => (await db.query<any>(
  `SELECT id, amount::float AS amount, source_id FROM landlord_gam_charges
    WHERE landlord_id = $1 AND source_type = $2 AND voided_at IS NULL`, [landlordId, GAM_DEBIT_DISPUTE_COST_SOURCE])).rows
/** The event that carries the win; Stripe gives back `returnedFee` of its $15 with it. */
const wonEvent = (o: { id?: string; returnedFee?: number; pi?: string; cents?: number } = {}) => {
  const pi = o.pi ?? 'pi_gam_pull_sep'
  const cents = o.cents ?? 5400
  return {
    id: o.id ?? (pi === 'pi_gam_pull_sep' ? 'evt_won' : `evt_won_${pi}`), type: 'charge.dispute.closed',
    data: { object: { id: `du_${pi}`, object: 'dispute', charge: `ch_${pi}`, payment_intent: pi,
      amount: cents, currency: 'usd', status: 'won', reason: 'fraudulent',
      balance_transactions: [{ amount: -cents, fee: 1500 }, { amount: cents, fee: -(o.returnedFee ?? 1500) }] } },
  }
}
/** The next pull (pi_next_pull) settles. */
async function settleNextPull(): Promise<string> {
  const nextId = (await db.query<{ id: string }>(`SELECT id FROM landlord_gam_debits WHERE stripe_payment_intent_id = 'pi_next_pull'`)).rows[0].id
  const ok = await post({
    id: 'evt_ok_next', type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_next_pull', metadata: { gam_debit_id: nextId }, payment_method_types: ['us_bank_account'] } },
  })
  expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  return nextId
}
/**
 * 10/13 (migration 20261015180000): per charge, the collections of pulls not
 * disputed (or whose dispute GAM won) and of payouts, less what a win gave back
 * for it as collected twice, = what it has collected.
 */
async function expectCollectionsTie(landlordId: string) {
  const tie = (await db.query<any>(
    `SELECT c.id, c.collected_amount::float AS collected,
            (COALESCE((SELECT SUM(col.amount) FROM landlord_gam_charge_collections col
                         LEFT JOIN landlord_gam_debits d ON d.id = col.landlord_gam_debit_id
                        WHERE col.charge_id = c.id AND (d.id IS NULL OR d.disputed_at IS NULL OR d.dispute_won_at IS NOT NULL)), 0)
             - COALESCE((SELECT SUM(h.amount) FROM held_payout_items h
                          WHERE h.source_type = 'refund' AND h.source_id LIKE 'gam_debit_dispute_won:%:' || c.id::text), 0))::float AS live
       FROM landlord_gam_charges c WHERE c.landlord_id = $1`, [landlordId])).rows
  for (const r of tie) expect(r.collected, r.id).toBe(r.live)
  // 10/13 review: a voided charge's collected_amount is given back whole, net
  // of what a later dispute of the pull that collected it took back.
  const voided = (await db.query<any>(
    `SELECT c.id, c.collected_amount::float AS collected,
            COALESCE((SELECT SUM(h.amount) FROM held_payout_items h
                       WHERE h.source_type = 'refund'
                         AND (h.source_id = 'gam_charge_voided:' || c.id::text
                              OR (split_part(h.source_id, ':', 1) = 'gam_charge_voided_taken_back'
                                  AND split_part(h.source_id, ':', 3) = c.id::text))), 0)::float AS given_back
       FROM landlord_gam_charges c WHERE c.landlord_id = $1 AND c.voided_at IS NOT NULL`, [landlordId])).rows
  for (const r of voided) expect(Math.round(r.given_back * 100), r.id).toBe(Math.round(r.collected * 100))
}

/**
 * 10/13 review ("every dollar counted once"): what the landlord has paid GAM —
 * every pull that stands (not disputed, or won back) and what payouts kept —
 * less every payout line GAM holds for them (given back, or taken back), plus
 * what they still owe, = every live charge. Nothing paid twice, nothing lost.
 */
async function expectEveryDollarOnce(landlordId: string) {
  const r = (await db.query<any>(
    `SELECT (SELECT COALESCE(SUM(total_amount), 0) FROM landlord_gam_debits
              WHERE landlord_id = $1 AND status = 'succeeded' AND (disputed_at IS NULL OR dispute_won_at IS NOT NULL))::float AS pulled,
            (SELECT COALESCE(SUM(col.amount), 0) FROM landlord_gam_charge_collections col
               JOIN landlord_gam_charges c ON c.id = col.charge_id
              WHERE c.landlord_id = $1 AND col.platform_transfer_intent_id IS NOT NULL)::float AS netted,
            (SELECT COALESCE(SUM(amount), 0) FROM held_payout_items WHERE landlord_id = $1)::float AS held,
            (SELECT COALESCE(SUM(amount), 0) FROM landlord_gam_charges WHERE landlord_id = $1 AND voided_at IS NULL)::float AS live`,
    [landlordId])).rows[0]
  const owed = await outstandingForLandlord(landlordId)
  expect(Math.round((r.pulled + r.netted - r.held + owed) * 100)).toBe(Math.round(r.live * 100))
}

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

  it('a cost Stripe has not said is read by the nightly sweep once Stripe says it', async () => {
    const p = await settledPull()
    expect((await post(dispute('pi_gam_pull_sep', 5400, { fee: 0 }))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(48)

    // The first night: still nothing from Stripe, and too soon to bill anything in its place.
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    expect(await notices(GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY)).toEqual([])
    expect(await notices(GAM_DEBIT_DISPUTE_FEE_ASSUMED_CATEGORY)).toEqual([])

    // Stripe says its fee: the nightly sweep (runGamDebitSweep) bills it at cost.
    disputeRetrieve.mockImplementation(async (id: string) => ({ id, balance_transactions: [{ amount: -5400, fee: 1500 }] }))
    await runGamDebitSweep()
    expect(await pullRow(p.debitId)).toMatchObject({ cost: 15.27, cost_read: true })
    expect(await feeRow(p.debitId)).toMatchObject({ fee: 15, assumed: false, stated: true })
    const owed = (await db.query<any>(
      `SELECT amount::float AS amount FROM landlord_gam_charges WHERE source_type = $1 AND source_id = $2`,
      [GAM_DEBIT_DISPUTE_COST_SOURCE, p.debitId])).rows
    expect(owed).toEqual([{ amount: 15.27 }])
  })

  // 10/13 (Nic, afternoon): "Dispute fee unknown → bill $15."
  it('Stripe never states its dispute fee: three days on, $15 (its usual fee) is billed with its fee on the pull, once, and an admin is told', async () => {
    expect(STRIPE_USUAL_DISPUTE_FEE_CENTS).toBe(1500)
    const p = await settledPull()
    expect((await post(dispute('pi_gam_pull_sep', 5400, { fee: 0 }))).status).toBe(200)
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(48)

    // Three days on, Stripe still silent: $15 in its place, with Stripe's $0.27 on the pull.
    await db.query(`UPDATE landlord_gam_debits SET disputed_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [p.debitId])
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 1 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
    expect(await feeRow(p.debitId)).toMatchObject({ fee: 15, assumed: true, stated: false, cost: 15.27 })
    const billed = (await db.query<any>(
      `SELECT kind, amount::float AS amount, source_id, notes FROM landlord_gam_charges WHERE id = $1`,
      [(await feeRow(p.debitId)).dispute_cost_charge_id])).rows[0]
    expect(billed).toMatchObject({ kind: 'bank_debit_failed_cost', amount: 15.27, source_id: p.debitId })
    expect(billed.notes).toContain('$15 — Stripe\'s usual dispute fee, as Stripe has not stated its own')
    // Told once — and it was billed, so the "could not be read" notice is not raised.
    const told = await notices(GAM_DEBIT_DISPUTE_FEE_ASSUMED_CATEGORY)
    expect(told).toHaveLength(1)
    expect(told[0].severity).toBe('info')
    expect(told[0].context).toMatchObject({ debit_id: p.debitId, stripe_dispute_id: 'du_pi_gam_pull_sep', cost_billed: 15.27 })
    expect(await notices(GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY)).toEqual([])

    // The next nights, Stripe still silent: asked again, never billed twice, told once.
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
    expect(await liveCostCharges(p.landlordId)).toHaveLength(1)
    expect(await notices(GAM_DEBIT_DISPUTE_FEE_ASSUMED_CATEGORY)).toHaveLength(1)

    // Stripe states $15 after all: nothing to correct, and it stops asking.
    disputeRetrieve.mockImplementation(async (id: string) => ({ id, balance_transactions: [{ amount: -5400, fee: 1500 }] }))
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    expect(await feeRow(p.debitId)).toMatchObject({ fee: 15, assumed: true, stated: true, cost: 15.27, dispute_cost_charge_id: expect.any(String) })
    expect(await liveCostCharges(p.landlordId)).toEqual([expect.objectContaining({ amount: 15.27, source_id: p.debitId })])
    expect((await db.query(`SELECT 1 FROM landlord_gam_charges WHERE landlord_id = $1 AND voided_at IS NOT NULL AND void_reason <> 'bank_debit_failed'`, [p.landlordId])).rowCount).toBe(0)
    expect(await notices(GAM_DEBIT_DISPUTE_FEE_CORRECTED_CATEGORY)).toEqual([])
    expect(await readDisputedPullCosts()).toEqual({ considered: 0, read: 0 })
  })

  it('Stripe later states a different fee: the $15 bill is voided and replaced by one at Stripe\'s fee — never both owed', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400, { fee: 0 }))
    await db.query(`UPDATE landlord_gam_debits SET disputed_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [p.debitId])
    await readDisputedPullCosts()
    const first = (await feeRow(p.debitId)).dispute_cost_charge_id
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)

    disputeRetrieve.mockImplementation(async (id: string) => ({ id, balance_transactions: [{ amount: -5400, fee: 2000 }] }))
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    // The $15 bill, voided (kept on record); Stripe's $20 with its $0.27 on the pull, billed instead.
    const old = await charge(first)
    expect(old).toMatchObject({ amount: 15.27, collected: 0, void_reason: 'dispute_cost_rebilled' })
    expect(old.voided_at).not.toBeNull()
    const now = await feeRow(p.debitId)
    expect(now).toMatchObject({ fee: 20, assumed: true, stated: true, cost: 20.27 })
    expect(now.dispute_cost_charge_id).not.toBe(first)
    expect(await liveCostCharges(p.landlordId)).toEqual([
      { id: now.dispute_cost_charge_id, amount: 20.27, source_id: disputeCostRebillSourceId(p.debitId, 'stated') }])
    expect(await outstandingForLandlord(p.landlordId)).toBe(68.27)
    expect(await held(p.landlordId)).toEqual([])
    const told = await notices(GAM_DEBIT_DISPUTE_FEE_CORRECTED_CATEGORY)
    expect(told).toHaveLength(1)
    expect(told[0].context).toMatchObject({ was: 15.27, now: 20.27, stated_fee: 20 })

    // Asked again (a sweep, a redelivered event): nothing more.
    expect(await readDisputedPullCosts()).toEqual({ considered: 0, read: 0 })
    expect((await post(dispute('pi_gam_pull_sep', 5400, { type: 'charge.dispute.updated', eventId: 'evt_upd20', fee: 2000 }))).status).toBe(200)
    expect(await liveCostCharges(p.landlordId)).toHaveLength(1)
    expect(await outstandingForLandlord(p.landlordId)).toBe(68.27)
  })

  it('the $15 already collected when an event states $10: given back on the next payout, and $10.27 billed — Stripe\'s fee paid once', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400, { fee: 0 }))
    await db.query(`UPDATE landlord_gam_debits SET disputed_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [p.debitId])
    await readDisputedPullCosts()
    const first = (await feeRow(p.debitId)).dispute_cost_charge_id
    // The next pull collects the reopened $48 and the $15.27.
    expect(await debitLandlordForCharges(p.landlordId)).toMatchObject({ status: 'debited', chargesAmount: 63.27, total: 69.27 })
    await settleNextPull()
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)

    // A later event states Stripe's fee: $10.
    expect((await post(dispute('pi_gam_pull_sep', 5400, { type: 'charge.dispute.funds_withdrawn', eventId: 'evt_fw10', fee: 1000 }))).status).toBe(200)
    const old = await charge(first)
    expect(old).toMatchObject({ amount: 15.27, collected: 15.27, void_reason: 'dispute_cost_rebilled' })
    expect(await held(p.landlordId)).toEqual([
      { source_type: 'refund', source_id: gamChargeVoidedGiveBackSourceId(first), amount: 15.27, payout_intent_id: null }])
    expect(await feeRow(p.debitId)).toMatchObject({ fee: 10, stated: true, cost: 10.27 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(10.27)
    await expectCollectionsTie(p.landlordId)
    await expectEveryDollarOnce(p.landlordId)
  })

  it('Stripe that cannot be read at all for three days: nothing is assumed, an admin is told once', async () => {
    const p = await settledPull()
    stripeRetrieve.mockRejectedValueOnce(new Error('Stripe is down'))
      .mockRejectedValueOnce(new Error('Stripe is down'))
      .mockRejectedValueOnce(new Error('Stripe is down'))
    disputeRetrieve.mockImplementation(async (id: string) => ({ id, balance_transactions: [{ amount: -5400, fee: 1500 }] }))
    expect((await post(dispute('pi_gam_pull_sep', 5400))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(48)
    await db.query(`UPDATE landlord_gam_debits SET disputed_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [p.debitId])
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 0 })
    const told = await notices(GAM_DEBIT_DISPUTE_COST_UNREAD_CATEGORY)
    expect(told).toHaveLength(1)
    expect(told[0].context).toMatchObject({ debit_id: p.debitId, stripe_dispute_id: 'du_pi_gam_pull_sep' })
    expect(await notices(GAM_DEBIT_DISPUTE_FEE_ASSUMED_CATEGORY)).toEqual([])
    expect(await feeRow(p.debitId)).toMatchObject({ fee: null, assumed: false, cost: null })
    // Readable again: Stripe's own fee is billed, at cost.
    expect(await readDisputedPullCosts()).toEqual({ considered: 1, read: 1 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
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

  // 10/13 (Nic, afternoon): "Won GAM pull dispute: AUTOMATIC (back to
  // collected; anything collected twice credited back)."
  it('a won dispute undoes itself: the fees back to collected, the pull\'s $6 too (and back on GAM\'s book), the dispute\'s cost voided; an admin is told, once', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    expect(await outstandingForLandlord(p.landlordId)).toBe(63.27)
    const costCharge = (await pullRow(p.debitId)).dispute_cost_charge_id

    expect((await post(wonEvent())).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    expect(await charge(p.fee)).toMatchObject({ amount: 48, collected: 48, voided_at: null })
    // The transfer collected after all: GAM's $6 price for it stands again.
    expect(await charge(p.cost)).toMatchObject({ amount: 6, collected: 6, voided_at: null, void_reason: null })
    // Stripe gave its $15 back with the win: what the dispute cost is taken off (kept on record).
    const voided = await charge(costCharge)
    expect(voided).toMatchObject({ amount: 15.27, collected: 0, void_reason: 'dispute_won' })
    expect(voided.voided_at).not.toBeNull()
    expect(await wonRow(p.debitId)).toMatchObject({
      status: 'succeeded', disputed: true, won: true, restored: 54, given_back: 0, cost: 0, dispute_cost_charge_id: null })
    expect(await liveCostCharges(p.landlordId)).toEqual([])
    expect(await held(p.landlordId)).toEqual([])
    // GAM's book: the $6 taken back with the dispute is put back.
    expect(await revenue(p.debitId)).toEqual([
      { type: 'banking_spread', reference_type: 'gam_bank_debit', amount: 6 },
      { type: 'adjustment', reference_type: 'dispute_spread_reversal', amount: -6 },
      { type: 'banking_spread', reference_type: 'gam_bank_debit_dispute_won', amount: 6 },
    ])
    await expectCollectionsTie(p.landlordId)

    const told = await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY)
    expect(told).toHaveLength(1)
    expect(told[0].severity).toBe('info')
    expect(told[0].body).toContain('GAM undid the dispute by itself')
    expect(told[0].body).toContain('1. The 1 charge it had paid went back to collected ($48.00).')
    expect(told[0].body).toContain('2. The pull\'s own $6.00 bank transfer cost is collected again')
    expect(told[0].body).toContain('3. What the dispute cost ($15.27) was taken off.')
    expect(told[0].context).toMatchObject({ debit_id: p.debitId, restored: 54, collected_twice: 0, cost_was: 15.27, cost_now: 0, fee_returned: 15 })

    // A redelivery, an older event read as won, and the nightly sweep change nothing.
    expect((await post(wonEvent({ id: 'evt_won_again' }))).status).toBe(200)
    expect((await post(dispute('pi_gam_pull_sep', 5400, { type: 'charge.dispute.updated', eventId: 'evt_late_upd' }))).status).toBe(200)
    expect(await applyWonGamDebitDisputes()).toEqual({ considered: 0, applied: 0 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    expect(await revenue(p.debitId)).toHaveLength(3)
    expect(await held(p.landlordId)).toEqual([])
    expect(await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY)).toHaveLength(1)
    expect(await handleGamDebitDispute({
      paymentIntentId: 'pi_gam_pull_sep', stripeDisputeId: 'du_pi_gam_pull_sep', disputeStatus: 'won', eventStatus: 'won',
      disputedCents: 5400, feeCents: 1500, feeStated: true, feeReturnedCents: 1500,
    })).toMatchObject({ handled: true, action: 'won', restored: 54, givenBack: 0, costBilled: 0 })
  })

  it('collected again meanwhile by the next pull: what was collected twice is given back on the landlord\'s next payout, with what was collected on the dispute\'s cost', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    const costCharge = (await pullRow(p.debitId)).dispute_cost_charge_id
    expect(await debitLandlordForCharges(p.landlordId)).toMatchObject({ status: 'debited', chargesAmount: 63.27, total: 69.27 })
    await settleNextPull()
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)

    expect((await post(wonEvent())).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    // The $48 was collected by both pulls: given back once.
    expect(await charge(p.fee)).toMatchObject({ amount: 48, collected: 48 })
    expect(await charge(p.cost)).toMatchObject({ collected: 6, voided_at: null })
    expect(await charge(costCharge)).toMatchObject({ collected: 15.27, void_reason: 'dispute_won' })
    expect(await held(p.landlordId)).toEqual([
      { source_type: 'refund', source_id: gamChargeVoidedGiveBackSourceId(costCharge), amount: 15.27, payout_intent_id: null },
      { source_type: 'refund', source_id: gamDebitWonGiveBackSourceId(p.debitId, p.fee), amount: 48, payout_intent_id: null },
    ].sort((a, b) => a.source_id.localeCompare(b.source_id)))
    expect(await wonRow(p.debitId)).toMatchObject({ won: true, restored: 6, given_back: 63.27 })
    await expectCollectionsTie(p.landlordId)
    await expectEveryDollarOnce(p.landlordId)
    const told = await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY)
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain('$48.00 had been collected again meanwhile (collected twice); it is given back to')
    expect(told[0].body).toContain('the $15.27 already collected on it is given back on their next payout')

    // Retried: given back once.
    expect((await post(wonEvent({ id: 'evt_won_again' }))).status).toBe(200)
    expect(await held(p.landlordId)).toHaveLength(2)
  })

  it('a later pull still settling holds the win back (that money is on its way); the nightly sweep undoes it once that pull settles', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    expect(await debitLandlordForCharges(p.landlordId)).toMatchObject({ status: 'debited', total: 69.27 })

    const res = await post(wonEvent())
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await wonRow(p.debitId)).toMatchObject({ won: false, restored: null, given_back: null })
    expect(await charge(p.fee)).toMatchObject({ collected: 0 })
    expect(await charge(p.cost)).toMatchObject({ void_reason: 'bank_debit_failed' })
    expect(await held(p.landlordId)).toEqual([])
    expect(await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY)).toEqual([])
    // Still settling the next night: still waiting.
    expect(await applyWonGamDebitDisputes()).toEqual({ considered: 1, applied: 0 })

    await settleNextPull()
    expect(await applyWonGamDebitDisputes()).toEqual({ considered: 1, applied: 1 })
    expect(await wonRow(p.debitId)).toMatchObject({ won: true, restored: 6, given_back: 63.27 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    await expectCollectionsTie(p.landlordId)
    expect(await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY)).toHaveLength(1)
    expect(await applyWonGamDebitDisputes()).toEqual({ considered: 0, applied: 0 })
  })

  it('Stripe kept its dispute fee with the win: only that stays the landlord\'s, billed at cost on its own (Nic G1)', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    const costCharge = (await pullRow(p.debitId)).dispute_cost_charge_id
    expect((await post(wonEvent({ returnedFee: 0 }))).status).toBe(200)
    expect(await charge(costCharge)).toMatchObject({ void_reason: 'dispute_won' })
    const now = await wonRow(p.debitId)
    expect(now).toMatchObject({ won: true, restored: 54, cost: 15 })
    expect(await liveCostCharges(p.landlordId)).toEqual([
      { id: now.dispute_cost_charge_id, amount: 15, source_id: disputeCostRebillSourceId(p.debitId, 'won_stated') }])
    expect(await outstandingForLandlord(p.landlordId)).toBe(15)
    await expectEveryDollarOnce(p.landlordId)
    expect((await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY))[0].body).toContain('Stripe kept $15.00 of its dispute fee, which stays theirs at cost.')
  })

  // 10/13 review ("every dollar counted once"): a landlord whose bank disputes
  // two pulls in a row — the second one paid the first dispute's cost.
  it('the next pull, which paid the first dispute\'s cost, disputed after GAM won the first: that cost (voided, given back) is never owed again — the bank\'s return of it is taken back from the next payout, once; won too, given back again', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    const costCharge = (await pullRow(p.debitId)).dispute_cost_charge_id
    expect(await debitLandlordForCharges(p.landlordId)).toMatchObject({ status: 'debited', chargesAmount: 63.27, total: 69.27 })
    const next = await settleNextPull()
    expect((await post(wonEvent())).status).toBe(200)
    // GAM won the first: the $48 collected twice and the $15.27 dispute cost are given back.
    const afterFirstWin = [
      { source_type: 'refund', source_id: gamChargeVoidedGiveBackSourceId(costCharge), amount: 15.27, payout_intent_id: null },
      { source_type: 'refund', source_id: gamDebitWonGiveBackSourceId(p.debitId, p.fee), amount: 48, payout_intent_id: null },
    ]
    expect(sortedBySource(await held(p.landlordId))).toEqual(sortedBySource(afterFirstWin))
    await expectCollectionsTie(p.landlordId)
    await expectEveryDollarOnce(p.landlordId)

    // Then the landlord's bank disputes the next pull ($69.27).
    const res = await post(dispute('pi_next_pull', 6927))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // The $48 is owed again. The voided $15.27 is not — but the bank returned
    // what the pull paid on it, which was already given back: taken back.
    expect(await charge(p.fee)).toMatchObject({ collected: 0, voided_at: null })
    expect(await charge(costCharge)).toMatchObject({ collected: 0, void_reason: 'dispute_won' })
    expect(await pullRow(next)).toMatchObject({ disputed: true, reopened: 48, cost: 15 })
    const takenBack = { source_type: 'refund', source_id: gamChargeVoidedTakeBackSourceId(next, costCharge), amount: -15.27, payout_intent_id: null }
    expect(sortedBySource(await held(p.landlordId))).toEqual(sortedBySource([...afterFirstWin, takenBack]))
    // Owed: the $48 again, and what the second dispute cost ($15; Stripe's fee on this pull reads $0 here).
    expect(await outstandingForLandlord(p.landlordId)).toBe(63)
    await expectCollectionsTie(p.landlordId)
    await expectEveryDollarOnce(p.landlordId)
    const told = (await notices('gam_debit_disputed')).filter((n: any) => n.context.stripe_dispute_id === 'du_pi_next_pull')
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain('The 1 charge it paid ($48.00) is owed by')
    expect(told[0].body).toContain('$15.27 it paid on a fee GAM has since taken off had already been given back')
    expect(told[0].body).toContain('so it is taken back from their next payout')
    expect(told[0].context).toMatchObject({ reopened: 48, charges: 1, taken_back: 15.27 })

    // Redelivered, or a later update: taken back once.
    expect((await post(dispute('pi_next_pull', 6927, { type: 'charge.dispute.updated', eventId: 'evt_next_upd' }))).status).toBe(200)
    expect(await held(p.landlordId)).toHaveLength(3)
    await expectEveryDollarOnce(p.landlordId)

    // GAM wins that one too: the pull stands again, so what it paid on the
    // voided cost is given back again — once in all.
    expect((await post(wonEvent({ pi: 'pi_next_pull', cents: 6927 }))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    expect(await charge(p.fee)).toMatchObject({ collected: 48 })
    expect(sortedBySource(await held(p.landlordId))).toEqual(sortedBySource([...afterFirstWin, takenBack,
      { source_type: 'refund', source_id: gamDebitWonGiveBackSourceId(next, costCharge), amount: 15.27, payout_intent_id: null }]))
    expect(await wonRow(next)).toMatchObject({ won: true, restored: 54, given_back: 15.27 })
    await expectCollectionsTie(p.landlordId)
    await expectEveryDollarOnce(p.landlordId)
    const won = (await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY)).filter((n: any) => n.context.stripe_dispute_id === 'du_pi_next_pull')
    expect(won).toHaveLength(1)
    expect(won[0].body).toContain('$15.27 it had paid on fees taken off since is given back')
    expect(won[0].body).not.toContain('collected twice')
    expect(won[0].context).toMatchObject({ collected_twice: 0, voided_given_back: 15.27 })
  })

  it('the next pull paid the $15 that Stripe\'s stated fee later replaced, then was disputed: the replaced bill (voided, given back) is never owed again — its give-back is taken back', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400, { fee: 0 }))
    await db.query(`UPDATE landlord_gam_debits SET disputed_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [p.debitId])
    await readDisputedPullCosts()
    const first = (await feeRow(p.debitId)).dispute_cost_charge_id
    expect(await debitLandlordForCharges(p.landlordId)).toMatchObject({ status: 'debited', chargesAmount: 63.27, total: 69.27 })
    const next = await settleNextPull()
    // Stripe states $10: the $15.27 bill is voided and given back; $10.27 billed in its place.
    expect((await post(dispute('pi_gam_pull_sep', 5400, { type: 'charge.dispute.funds_withdrawn', eventId: 'evt_fw10', fee: 1000 }))).status).toBe(200)
    expect(await charge(first)).toMatchObject({ collected: 15.27, void_reason: 'dispute_cost_rebilled' })
    expect(await outstandingForLandlord(p.landlordId)).toBe(10.27)
    await expectEveryDollarOnce(p.landlordId)

    // The landlord's bank disputes the next pull.
    expect((await post(dispute('pi_next_pull', 6927))).status).toBe(200)
    expect(await charge(first)).toMatchObject({ collected: 0, void_reason: 'dispute_cost_rebilled' })
    expect(await pullRow(next)).toMatchObject({ disputed: true, reopened: 48 })
    expect(sortedBySource(await held(p.landlordId))).toEqual(sortedBySource([
      { source_type: 'refund', source_id: gamChargeVoidedGiveBackSourceId(first), amount: 15.27, payout_intent_id: null },
      { source_type: 'refund', source_id: gamChargeVoidedTakeBackSourceId(next, first), amount: -15.27, payout_intent_id: null },
    ]))
    // Owed: the $48 again, Stripe's stated $10.27 on the first dispute, and $15 on the second.
    expect(await outstandingForLandlord(p.landlordId)).toBe(73.27)
    await expectCollectionsTie(p.landlordId)
    await expectEveryDollarOnce(p.landlordId)
  })

  it('a fee taken off while the dispute is open: the win gives back what the pull paid on it — nobody owes it, and it is not "collected twice"', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    // The reopened $48 is taken off (nothing is collected on it now; any reason a GAM charge is voided).
    expect(await voidGamCharge(null, p.fee, 'screening_payment_taken_back')).toBe(true)
    expect(await outstandingForLandlord(p.landlordId)).toBe(15.27)

    expect((await post(wonEvent())).status).toBe(200)
    expect(await charge(p.fee)).toMatchObject({ collected: 0, void_reason: 'screening_payment_taken_back' })
    expect(await held(p.landlordId)).toEqual([
      { source_type: 'refund', source_id: gamDebitWonGiveBackSourceId(p.debitId, p.fee), amount: 48, payout_intent_id: null }])
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    expect(await wonRow(p.debitId)).toMatchObject({ won: true, restored: 6, given_back: 48 })
    await expectCollectionsTie(p.landlordId)
    await expectEveryDollarOnce(p.landlordId)
    const told = await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY)
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain('$48.00 it had paid on fees taken off since is given back')
    expect(told[0].body).not.toContain('collected twice')
    expect(told[0].context).toMatchObject({ collected_twice: 0, voided_given_back: 48 })
  })

  it('collected again meanwhile by a payout, not a pull: what was collected twice is given back the same way', async () => {
    const p = await settledPull()
    await post(dispute('pi_gam_pull_sep', 5400))
    const costCharge = (await pullRow(p.debitId)).dispute_cost_charge_id
    // The next payout nets what is owed: the $48 and the $15.27.
    const intent = (await db.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents (landlord_id, destination_connect_account_id, amount, gross_owed, netted_amount)
       VALUES ($1, 'acct_test', 36.73, 100, 63.27) RETURNING id`, [p.landlordId])).rows[0].id
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const takes: GamChargeTake[] = []
      expect(await netAgainstDisbursement(c, p.landlordId, 100, takes)).toBe(63.27)
      await recordGamChargeCollections(c, takes, { platformTransferIntentId: intent })
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    } finally { c.release() }
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)

    expect((await post(wonEvent())).status).toBe(200)
    expect(await charge(p.fee)).toMatchObject({ collected: 48, voided_at: null })
    expect(await charge(costCharge)).toMatchObject({ collected: 15.27, void_reason: 'dispute_won' })
    expect(sortedBySource(await held(p.landlordId))).toEqual(sortedBySource([
      { source_type: 'refund', source_id: gamChargeVoidedGiveBackSourceId(costCharge), amount: 15.27, payout_intent_id: null },
      { source_type: 'refund', source_id: gamDebitWonGiveBackSourceId(p.debitId, p.fee), amount: 48, payout_intent_id: null },
    ]))
    expect(await wonRow(p.debitId)).toMatchObject({ won: true, restored: 6, given_back: 63.27 })
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    await expectCollectionsTie(p.landlordId)
    await expectEveryDollarOnce(p.landlordId)
    expect((await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY))[0].context).toMatchObject({ collected_twice: 48, voided_given_back: 0 })
  })

  it('a won dispute that never reopened the pull has nothing to undo: an admin is told so, once', async () => {
    const p = await settledPull()
    expect((await post(wonEvent())).status).toBe(200)
    expect((await post(wonEvent({ id: 'evt_won_again' }))).status).toBe(200)
    expect(await outstandingForLandlord(p.landlordId)).toBe(0)
    expect(await wonRow(p.debitId)).toMatchObject({ disputed: false, won: false })
    expect(await held(p.landlordId)).toEqual([])
    const told = await notices(GAM_DEBIT_DISPUTE_WON_CATEGORY)
    expect(told).toHaveLength(1)
    expect(told[0].severity).toBe('info')
    expect(told[0].title).toContain('nothing to undo')
  })

  it('a re-bill\'s source is one per pull and basis, so a retry can never bill one twice', () => {
    const a = disputeCostRebillSourceId('11111111-1111-4111-8111-111111111111', 'stated')
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(disputeCostRebillSourceId('11111111-1111-4111-8111-111111111111', 'stated')).toBe(a)
    expect(new Set([a,
      disputeCostRebillSourceId('11111111-1111-4111-8111-111111111111', 'won_stated'),
      disputeCostRebillSourceId('11111111-1111-4111-8111-111111111111', 'won_assumed'),
      disputeCostRebillSourceId('22222222-2222-4222-8222-222222222222', 'stated'),
    ]).size).toBe(4)
  })

  it('a charge that is not a pull is left to the rest of the dispute path', async () => {
    expect(await handleGamDebitDispute({
      paymentIntentId: 'pi_not_a_pull', stripeDisputeId: 'du_x', disputeStatus: 'needs_response', eventStatus: 'needs_response',
      disputedCents: 100, feeCents: 1500,
    })).toEqual({ handled: false })
  })
})
