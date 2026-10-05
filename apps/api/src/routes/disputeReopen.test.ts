/**
 * S655 (money plan Step 10, §3 "Dispute"): a dispute reopens EVERY row the
 * disputed charge paid, through the real webhook.
 *
 * Each fixture pays a bill the way services/rentCharge does — rows pending,
 * credit set aside on the receipt, rows claimed 'processing' with the intent —
 * and settles it through payment_intent.succeeded (real allocation, real owner
 * shares), then posts charge.dispute.created for that charge.
 *
 * Until contract step C0 drops it, the old UNIQUE(stripe_event_id) allows one
 * reversal record per event; this file drops it for its own run and puts it
 * back afterwards (C0 itself is covered in db/migrations.creditUses.test.ts).
 */

import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

// A pass-through spy on the one receipt, so a test can see which rows it names.
vi.mock('../services/paymentReceipt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/paymentReceipt')>()
  return { ...actual, sendPaymentReceipt: vi.fn(actual.sendPaymentReceipt) }
})

vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_mock' })) }
    this.customers = { retrieve: vi.fn(async () => ({})), update: vi.fn(async () => ({})) }
    this.paymentIntents = { create: vi.fn(async () => ({ id: 'pi_mock' })), cancel: vi.fn(async (id: string) => ({ id })) }
    this.paymentMethods = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
    // GAM's available balance, read by the Tuesday batch before it transfers.
    this.balance = { retrieve: vi.fn(async () => ({ available: [{ currency: 'usd', amount: 100_000_000 }] })) }
    // A move-out's card refund (fix pass rev9: the reopened deposit charge paid by a bank deposit).
    this.refunds = {
      create: vi.fn(async (p: any) => ({ id: `re_${p.payment_intent}_${p.amount}`, status: 'succeeded', metadata: p.metadata })),
      list: vi.fn(async () => ({ data: [] })),
    }
  }
  return { default: FakeStripe }
})

// Fix pass (rev9): a test can make the charge's paid-ahead take-back answer
// "try again in a moment" (DisputeRetryLater); every other test runs the real one.
const clawOverride = vi.hoisted(() => ({ fn: null as null | ((...a: any[]) => Promise<any>) }))
vi.mock('../services/creditUse', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    clawBackDisputedCharge: (...args: any[]) => (clawOverride.fn ? clawOverride.fn(...args) : actual.clawBackDisputedCharge(...args)),
  }
})

import { webhooksRouter } from './webhooks'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule,
  seedLease, seedLeaseTenant, seedLeaseFee, seedSecurityDeposit, seedDepositReturnDraft,
} from '../test/dbHelpers'
import {
  createPaidAhead, holdCredit, clawBackRemittanceCredit, runWholeBillCheckAfterCommit,
  disputeClaimJoinSql, usablePaidAheadSql,
} from '../services/creditUse'
import { handlePaymentReversal } from '../services/paymentReversal'
import { reconcilePlatformHeldPayments } from '../services/landlordPassthrough'
import { prepaidDrawAvailable } from '../services/prepaidRelease'
import { sendPaymentReceipt } from '../services/paymentReceipt'
import { incomeTotals } from '../services/incomeBasis'

function buildApp() {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  return app
}
const post = (body: unknown) => request(buildApp()).post('/webhooks/stripe')
  .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub').send(JSON.stringify(body))

// The old one-per-event constraint (dropped by contract step C0) is dropped for
// this file and put back after only if it was there, so a run with C0 applied
// stays post-C0 for every later suite.
let hadOldConstraint = false
// Fix pass 1 (rev10, review): the ACH rate row this file needs ($6 flat, 0.8%
// Stripe cost) is reference data cleanupAllSchema never wipes. It is tagged,
// any other suite's ACH rows are set aside for this file's run, and both are
// put back as they were after — so no later suite reads this file's 0.8%.
const RATE_TAG = 'dispute-reopen-test'
let setAsideAchRates: Array<Record<string, unknown>> = []
beforeAll(async () => {
  hadOldConstraint = (await db.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'payment_reversals_stripe_event_id_key'`)).rowCount === 1
  await db.query(`ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_stripe_event_id_key`)
  setAsideAchRates = (await db.query(
    `SELECT * FROM platform_processing_rates WHERE payment_method = 'ach' AND notes IS DISTINCT FROM $1`, [RATE_TAG])).rows
  await db.query(`DELETE FROM platform_processing_rates WHERE payment_method = 'ach'`)
  await db.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent, notes)
     VALUES ('ach', 6, 0, 0, 0.8, $1)`, [RATE_TAG])
})
afterAll(async () => {
  await db.query(`DELETE FROM platform_processing_rates WHERE notes = $1`, [RATE_TAG])
  for (const r of setAsideAchRates) {
    const cols = Object.keys(r)
    await db.query(
      `INSERT INTO platform_processing_rates (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map(c => r[c]))
  }
  if (!hadOldConstraint) return
  await cleanupAllSchema()
  await db.query(`ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_stripe_event_id_key UNIQUE (stripe_event_id)`)
})

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
  // ACH: $6 flat to the tenant on top; Stripe's cost 0.8% (both in the rate
  // table, the tagged row beforeAll put in place).
})

interface H {
  landlordId: string; landlordUserId: string; tenantId: string; propertyId: string; unitId: string; leaseId: string
}

async function household(o: { achFeePayer?: 'tenant' | 'landlord' } = {}): Promise<H> {
  const c = await getClient()
  try {
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    await seedAllocationRule(c, { propertyId, achFeePayer: o.achFeePayer ?? 'tenant', cardFeePayer: 'tenant' })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    return { landlordId, landlordUserId, tenantId, propertyId, unitId, leaseId }
  } finally { c.release() }
}

async function row(h: H, o: {
  amount: number; type?: string; entry?: string; owner?: string; due?: string; leaseFeeId?: string | null; notes?: string | null
}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, revenue_owner, lease_fee_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8::date,$9,$10,$11) RETURNING id`,
    [h.unitId, h.leaseId, h.tenantId, h.landlordId, o.type ?? 'rent', o.amount,
     o.entry ?? ({ rent: 'RENT', utility: 'UTILITY', late_fee: 'LATEFEE' } as Record<string, string>)[o.type ?? 'rent'] ?? 'OTHERFEE',
     o.due ?? '2026-10-01', o.owner ?? 'landlord', o.leaseFeeId ?? null, o.notes ?? null])).rows[0].id
}

/**
 * A bank charge for `money` (+ the $6 fee on top, or `fee`: 0 where the
 * landlord pays the bank fee), banking `surplus` of it ahead, settled through
 * the webhook.
 */
async function payByBank(h: H, pi: string, rowIds: string[], money: number, o: {
  surplus?: number; hold?: Array<{ creditId: string; paymentId: string; amount: number }>; settle?: boolean; fee?: number
} = {}): Promise<string> {
  const fee = o.fee ?? 6
  const rem = (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                     payment_method, gross_amount, processing_fee_amount)
     VALUES ($1,$2,$3,$4,$5,$6,'ach',$7,$8) RETURNING id`,
    [h.tenantId, h.leaseId, h.landlordId, money, money - (o.surplus ?? 0), o.surplus ?? 0, money + fee, fee])).rows[0].id
  if (o.hold?.length) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await holdCredit(c as any, o.hold.map(x => ({ creditKind: 'paid_ahead' as const, creditId: x.creditId, paymentId: x.paymentId,
        leaseId: h.leaseId, amount: x.amount, billingMonth: '2026-11-01' })), { remittanceId: rem, source: 'portal' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  await db.query(`UPDATE payments SET status = 'processing', platform_held = TRUE, stripe_payment_intent_id = $2 WHERE id = ANY($1::uuid[])`, [rowIds, pi])
  await db.query(`UPDATE tenant_remittances SET stripe_payment_intent_id = $2 WHERE id = $1`, [rem, pi])
  if (o.settle !== false) {
    const res = await post({
      id: 'evt_ok_' + pi, type: 'payment_intent.succeeded',
      data: { object: { id: pi, metadata: { gam_remittance_id: rem }, payment_method_types: ['us_bank_account'],
        latest_charge: { id: 'ch_' + pi, payment_method_details: { type: 'us_bank_account' } } } },
    })
    expect(res.status).toBe(200)
  }
  return rem
}

function dispute(pi: string, cents: number, eventId = 'evt_dispute_' + pi) {
  return {
    id: eventId, type: 'charge.dispute.created',
    data: { object: { id: 'du_' + pi, object: 'dispute', charge: 'ch_' + pi, payment_intent: pi, amount: cents,
      currency: 'usd', status: 'needs_response', reason: 'fraudulent', balance_transactions: [{ fee: 1500 }] } },
  }
}

const reopenedRows = async (eventId: string) => (await db.query<any>(
  `SELECT r.payment_id AS orig, r.reversed_amount::float AS lost, r.recovery_status, r.status AS rec_status,
          o.status AS orig_status, n.id AS new_id, n.amount::float AS new_amount, n.status AS new_status
     FROM payment_reversals r
     JOIN payments o ON o.id = r.payment_id
     LEFT JOIN payments n ON n.reversal_id = r.id
    WHERE r.stripe_event_id = $1
    ORDER BY r.reversed_amount DESC, r.payment_id`, [eventId])).rows

/** The Tuesday batch runs for the household's landlord (the real reserve + transfer). */
async function payoutRuns(h: H): Promise<void> {
  await db.query(`UPDATE landlords SET stripe_connect_account_id = COALESCE(stripe_connect_account_id, 'acct_' || substr(md5(id::text), 1, 12)) WHERE id = $1`, [h.landlordId])
  await reconcilePlatformHeldPayments(h.landlordUserId)
}

/**
 * What the next Tuesday batch owes a landlord for their shares: owner shares
 * on settled rows not yet paid out (the batch's own pool), plus the held lines
 * a reversal wrote for a share (owner_share_*). Stripe's kept fee is its own
 * line and is left out here.
 */
const batchOwed = async (landlordId: string) => (await db.query<any>(
  `SELECT (SELECT COALESCE(SUM(ubl.amount), 0) FROM payments p
             JOIN user_balance_ledger ubl ON ubl.reference_id = p.id AND ubl.reference_type = 'payment'
              AND ubl.type = 'allocation_owner_share' AND ubl.stripe_transfer_id IS NULL
            WHERE p.landlord_id = $1 AND p.platform_held = TRUE AND p.status = 'settled')::float
        + (SELECT COALESCE(SUM(h.amount), 0) FROM held_payout_items h
            WHERE h.landlord_id = $1 AND h.payout_intent_id IS NULL AND h.source_id LIKE 'owner_share_%')::float AS owed`,
  [landlordId])).rows[0].owed
/** What GAM still asks a landlord to give back (pending or scheduled recovery). */
const recoveryOwed = async (landlordId: string) => (await db.query<any>(
  `SELECT COALESCE(SUM(reversed_amount - recovered_amount), 0)::float AS s FROM payment_reversals
    WHERE landlord_id = $1 AND recovery_status IN ('pending', 'scheduled_netting')`, [landlordId])).rows[0].s

describe('S655 Step 10 — a dispute reopens every row on the charge', () => {
  it('a dispute reopens every row on the charge (rent, utility, late fee, fee, GAM fee) at the money part, one reversal per row, one notice', async () => {
    const h = await household()
    const petFee = await seedLeaseFee(db as any, { leaseId: h.leaseId, feeType: 'pet_deposit', amount: 30, dueTiming: 'move_in' })
    const rent = await row(h, { amount: 1000 })
    const water = await row(h, { amount: 50, type: 'utility' })
    const late = await row(h, { amount: 25, type: 'late_fee' })
    const pet = await row(h, { amount: 30, type: 'fee', entry: 'DEPOSIT', leaseFeeId: petFee, notes: 'Pet deposit' })
    const gamFee = await row(h, { amount: 4, type: 'fee', entry: 'RETURNFEE', owner: 'gam', notes: 'ACH return fee (passed through at cost)' })
    await payByBank(h, 'pi_dispute_all', [rent, water, late, pet, gamFee], 1109)

    const res = await post(dispute('pi_dispute_all', 111500))
    expect(res.status).toBe(200)

    const rows = await reopenedRows('evt_dispute_pi_dispute_all')
    expect(rows).toHaveLength(5)
    expect(rows.map((r: any) => [r.orig, r.lost, r.orig_status, r.new_amount, r.new_status])).toEqual([
      [rent, 1000, 'returned', 1000, 'pending'],
      [water, 50, 'returned', 50, 'pending'],
      [pet, 30, 'returned', 30, 'pending'],
      [late, 25, 'returned', 25, 'pending'],
      [gamFee, 4, 'returned', 4, 'pending'],
    ])
    // No payout ran: the landlord's owner shares on its four rows are still on
    // GAM's balance, so they are withheld (recovered on the spot) and nothing
    // is asked of the landlord; GAM's own row needs nothing.
    const rec = new Map(rows.map((r: any) => [r.orig, r.recovery_status]))
    expect(rec.get(gamFee)).toBe('not_needed')
    for (const id of [rent, water, late, pet]) expect(rec.get(id)).toBe('recovered')
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(0)
    // One pass-through dispute fee, billed to the tenant at what Stripe charged.
    const fee = await db.query<any>(`SELECT amount::float AS a, revenue_owner FROM payments WHERE entry_description = 'RETURNFEE' AND id <> $1 AND reversal_id IS NULL`, [gamFee])
    expect(fee.rows).toEqual([{ a: 15, revenue_owner: 'gam' }])
    // One landlord notice for the event.
    const notices = await db.query(`SELECT 1 FROM notifications WHERE type = 'rent_reversed'`)
    expect(notices.rowCount).toBe(1)
    // The pet fee stays the landlord's fee (its lease fee is kept).
    const petAgain = await db.query<any>(`SELECT lease_fee_id, revenue_owner FROM payments WHERE reversal_id IS NOT NULL AND amount = 30`)
    expect(petAgain.rows).toEqual([{ lease_fee_id: petFee, revenue_owner: 'landlord' }])
  })

  it('credit uses on the charge stay applied, so the tenant owes only the money part and nothing is paid out twice', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    const c = await getClient()
    let credit: string
    try { credit = await createPaidAhead(c as any, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 100, fundedBy: 'landlord', receivedAt: new Date() }) }
    finally { c.release() }
    await payByBank(h, 'pi_dispute_credit', [rent], 900, { hold: [{ creditId: credit!, paymentId: rent, amount: 100 }] })
    expect((await db.query<any>(`SELECT amount::float AS a FROM user_balance_ledger WHERE reference_id = $1`, [rent])).rows).toEqual([{ a: 900 }])

    expect((await post(dispute('pi_dispute_credit', 90600))).status).toBe(200)
    const rows = await reopenedRows('evt_dispute_pi_dispute_credit')
    expect(rows.map((r: any) => [r.lost, r.new_amount])).toEqual([[900, 900]])
    // The $100 of credit is not given back: spent once, on this row.
    const use = await db.query<any>(`SELECT status FROM credit_uses WHERE prepaid_credit_id = $1`, [credit!])
    expect(use.rows).toEqual([{ status: 'applied' }])
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit!])).rows[0].r).toBe(0)
  })

  it('a disputed charge\'s paid-ahead surplus: unspent part clawed back, a later spend reverses and reopens that row, and recovery includes it', async () => {
    const h = await household()
    const oct = await row(h, { amount: 1000, due: '2026-10-01' })
    // November's $200 bill is open when the October charge brings $300 extra:
    // the whole-bill rule pays it from that credit after the settle.
    const nov = await row(h, { amount: 200, due: '2026-11-01' })
    // November is not part of the charge.
    await db.query(`UPDATE payments SET stripe_payment_intent_id = NULL WHERE id = $1`, [nov])
    const rem = await payByBank(h, 'pi_dispute_surplus', [oct], 1300, { surplus: 300 })
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rows[0].id
    await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [nov])).rows[0].status).toBe('settled')
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(100)
    // Tuesday's batch pays the landlord both shares.
    await payoutRuns(h)
    expect(await batchOwed(h.landlordId)).toBe(0)

    expect((await post(dispute('pi_dispute_surplus', 130600))).status).toBe(200)
    const rows = await reopenedRows('evt_dispute_pi_dispute_surplus')
    expect(rows.map((r: any) => [r.orig, r.lost, r.new_amount])).toEqual([[oct, 1000, 1000], [nov, 200, 200]])
    // The spend of the disputed money is undone, and the rest is taken back.
    expect((await db.query<any>(`SELECT status FROM credit_uses WHERE prepaid_credit_id = $1 AND payment_id = $2`, [credit, nov])).rows[0].status).toBe('reversed')
    const drained = await db.query<any>(`SELECT COALESCE(SUM(amount), 0)::float AS d FROM credit_uses WHERE prepaid_credit_id = $1 AND source = 'reversal'`, [credit])
    expect(drained.rows[0].d).toBe(300)
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(0)
    // Recovery covers both rows the landlord was paid on: $1,200, decided once.
    const need = await db.query<any>(
      `SELECT SUM(reversed_amount)::float AS s, COUNT(DISTINCT recovery_method)::int AS m
         FROM payment_reversals WHERE stripe_event_id = 'evt_dispute_pi_dispute_surplus' AND recovery_status <> 'not_needed'`)
    expect(need.rows[0]).toEqual({ s: 1200, m: 1 })
    expect(await recoveryOwed(h.landlordId)).toBe(1200)
  })

  it('a partial dispute takes the surplus first, then rows newest first', async () => {
    const h = await household()
    const sep = await row(h, { amount: 500, due: '2026-09-01' })
    const oct = await row(h, { amount: 500, due: '2026-10-01' })
    const rem = await payByBank(h, 'pi_dispute_partial', [sep, oct], 1100, { surplus: 100 })
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rows[0].id

    // $300 disputed: the $100 surplus, then $200 of October (the newest row).
    expect((await post(dispute('pi_dispute_partial', 30000))).status).toBe(200)
    const rows = await reopenedRows('evt_dispute_pi_dispute_partial')
    expect(rows.map((r: any) => [r.orig, r.lost, r.orig_status, r.new_amount, r.recovery_status])).toEqual([
      [oct, 200, 'returned', 200, 'recovered'],
      [sep, 0, 'settled', null, 'not_needed'],
    ])
    const drained = await db.query<any>(`SELECT COALESCE(SUM(amount), 0)::float AS d FROM credit_uses WHERE prepaid_credit_id = $1 AND source = 'reversal'`, [credit])
    expect(drained.rows[0].d).toBe(100)
    // No payout ran yet: October's $200 comes out of its unpaid share, and the
    // $300 of October the tenant still paid reaches the landlord on a held
    // line; September's share is untouched. Nothing is asked of the landlord.
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(800)
  })

  it('a redelivered dispute changes nothing', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_dispute_twice', [rent], 1000)
    const ev = dispute('pi_dispute_twice', 100600)
    expect((await post(ev)).status).toBe(200)
    expect((await post(ev)).status).toBe(200)
    expect(await reopenedRows('evt_dispute_pi_dispute_twice')).toHaveLength(1)
    expect((await db.query(`SELECT 1 FROM payments WHERE reversal_id IS NOT NULL`)).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'RETURNFEE'`)).rowCount).toBe(1)
  })

  it('a redelivered partial dispute changes nothing (the clawback takes only what the dispute still claims)', async () => {
    const h = await household()
    const sep = await row(h, { amount: 500, due: '2026-09-01' })
    const oct = await row(h, { amount: 500, due: '2026-10-01' })
    const rem = await payByBank(h, 'pi_dispute_partial2', [sep, oct], 1100, { surplus: 100 })
    expect((await post(dispute('pi_dispute_partial2', 30000))).status).toBe(200)
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rows[0].id
    const before = (await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r
    // A second take for the same dispute claims nothing more.
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const again = await clawBackRemittanceCredit(c as any, rem, null, { maxAmount: 300 })
      expect(again.clawed).toBe(0)
      await c.query('COMMIT')
    } finally { c.release() }
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(before)
  })

  it('GAM keeps the spread it earned on a disputed charge (decisions #38 Q4): nothing comes off GAM\'s book', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_dispute_spread', [rent], 1000)
    const spread = async () => (await db.query<any>(
      `SELECT COALESCE(SUM(amount), 0)::float AS s FROM platform_revenue_ledger WHERE type IN ('banking_spread', 'adjustment')`)).rows[0].s
    const booked = await spread()
    expect(booked).not.toBe(0)
    expect((await post(dispute('pi_dispute_spread', 100600))).status).toBe(200)
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE reference_type = 'dispute_spread_reversal'`)).rowCount).toBe(0)
    expect(await spread()).toBe(booked)
  })

  it('a partial dispute that leaves the fee alone keeps the spread and charges the landlord no fee', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_dispute_spread2', [rent], 1000)
    expect((await post(dispute('pi_dispute_spread2', 50000))).status).toBe(200)
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE reference_type = 'dispute_spread_reversal'`)).rowCount).toBe(0)
    // The tenant's fee was not taken back, so nothing is netted from the landlord.
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE source_id LIKE 'stripe_fee_kept:%'`)).rowCount).toBe(0)
  })

  it('the whole fee a dispute took back is netted from the landlord\'s next payout, once, through the webhook (decisions #38 Q4)', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_dispute_kept', [rent], 1000)
    // The tenant paid $6 on top of the $1,000; the dispute gave all $1,006 back.
    const ev = dispute('pi_dispute_kept', 100600)
    expect((await post(ev)).status).toBe(200)
    expect((await post(ev)).status).toBe(200)
    const items = await db.query<any>(
      `SELECT landlord_id, amount::float AS a, description, payout_intent_id FROM held_payout_items WHERE source_id LIKE 'stripe_fee_kept:%'`)
    expect(items.rows).toHaveLength(1)
    // The WHOLE fee — Stripe's kept cost and GAM's spread together — never just Stripe's part.
    expect(items.rows[0]).toMatchObject({ landlord_id: h.landlordId, a: -6, payout_intent_id: null })
    expect(items.rows[0].description).toMatch(/went back to the payer with the payment, so it comes off your payout/)
  })

  it('a partial dispute that took half the fee back nets half of it from the landlord', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_dispute_halffee', [rent], 1000)
    // $1,003 of the $1,006: all the money and $3 of the $6 fee.
    expect((await post(dispute('pi_dispute_halffee', 100300))).status).toBe(200)
    const items = await db.query<any>(`SELECT amount::float AS a FROM held_payout_items WHERE source_id LIKE 'stripe_fee_kept:%'`)
    expect(items.rows).toEqual([{ a: -3 }])
  })

  it('a charge that paid only GAM\'s own rows leaves Stripe\'s kept fee with GAM, never a landlord', async () => {
    const h = await household()
    const gamFee = await row(h, { amount: 4, type: 'fee', entry: 'RETURNFEE', owner: 'gam', notes: 'ACH return fee (passed through at cost)' })
    await payByBank(h, 'pi_dispute_gamonly', [gamFee], 4)
    expect((await post(dispute('pi_dispute_gamonly', 1000))).status).toBe(200)
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE source_type = 'dispute'`)).rowCount).toBe(0)
  })
})

describe('S655 Step 10 — a row a credit\'s dispute reopened, then its own charge disputed', () => {
  const openRent = async (h: H) => (await db.query<any>(
    `SELECT COALESCE(SUM(amount), 0)::float AS s FROM payments
      WHERE status IN ('pending', 'failed') AND type = 'rent' AND tenant_id = $1`, [h.tenantId])).rows[0].s
  const lostOn = async (paymentId: string) => (await db.query<any>(
    `SELECT COALESCE(SUM(reversed_amount), 0)::float AS s FROM payment_reversals WHERE payment_id = $1`, [paymentId])).rows[0].s

  /** October paid by charge A ($800, $300 banked ahead); November ($400) by $300 of that credit + $100 from charge Z. */
  async function twoCharges(h: H) {
    const oct = await row(h, { amount: 500, due: '2026-10-01' })
    const remA = await payByBank(h, 'pi_two_a', [oct], 800, { surplus: 300 })
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [remA])).rows[0].id
    const nov = await row(h, { amount: 400, due: '2026-11-01' })
    await payByBank(h, 'pi_two_z', [nov], 100, { hold: [{ creditId: credit, paymentId: nov, amount: 300 }] })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [nov])).rows[0].status).toBe('settled')
    return { oct, nov, credit }
  }

  it('the credit\'s charge disputed first, then the row\'s own: its own money reopens too, once, with its fee billed', async () => {
    const h = await household()
    const { oct, nov } = await twoCharges(h)
    expect((await post(dispute('pi_two_a', 80600))).status).toBe(200)
    expect((await reopenedRows('evt_dispute_pi_two_a')).map((r: any) => [r.orig, r.lost]))
      .toEqual([[oct, 500], [nov, 300]])
    // November's own charge is taken back too: its $100 is owed again.
    expect((await post(dispute('pi_two_z', 10600))).status).toBe(200)
    const z = await reopenedRows('evt_dispute_pi_two_z')
    expect(z.map((r: any) => [r.orig, r.lost, r.orig_status, r.new_amount, r.new_status])).toEqual([[nov, 100, 'returned', 100, 'pending']])
    // No payout ran: November's $400 share was still on GAM's balance. The
    // first dispute withheld $300 of it and put the $100 the tenant still paid
    // on a held line; this one withholds that $100 back (a netting line).
    // Nothing is asked of the landlord, and nothing is owed to them for November.
    expect(z[0].recovery_status).toBe('recovered')
    expect(await lostOn(nov)).toBe(400)
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(0)
    // Both charges taken back: October's $500 and November's $400 are owed again.
    expect(await openRent(h)).toBe(900)
    // Each dispute's fee is billed to the tenant, once each.
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM payments WHERE entry_description = 'RETURNFEE'`)).rows[0].n).toBe(2)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'payment_reversal_nothing_reopened'`)).rowCount).toBe(0)
    // Redelivered: nothing more.
    expect((await post(dispute('pi_two_z', 10600))).status).toBe(200)
    expect(await lostOn(nov)).toBe(400)
    expect(await openRent(h)).toBe(900)
  })

  it('the row\'s own charge disputed first, then the credit\'s: each part reopens once', async () => {
    const h = await household()
    const { oct, nov } = await twoCharges(h)
    expect((await post(dispute('pi_two_z', 10600))).status).toBe(200)
    expect((await reopenedRows('evt_dispute_pi_two_z')).map((r: any) => [r.orig, r.lost])).toEqual([[nov, 100]])
    expect((await post(dispute('pi_two_a', 80600))).status).toBe(200)
    expect((await reopenedRows('evt_dispute_pi_two_a')).map((r: any) => [r.orig, r.lost])).toEqual([[oct, 500], [nov, 300]])
    expect(await lostOn(nov)).toBe(400)
    expect(await openRent(h)).toBe(900)
  })

  it('a charge whose set-aside credit was disputed money settles, then that charge is disputed: its own money reopens too', async () => {
    const h = await household()
    const oct = await row(h, { amount: 500, due: '2026-10-01' })
    const remA = await payByBank(h, 'pi_funding_a2', [oct], 800, { surplus: 300 })
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [remA])).rows[0].id
    const nov = await row(h, { amount: 400, due: '2026-11-01' })
    await payByBank(h, 'pi_charge_b2', [nov], 100, { hold: [{ creditId: credit, paymentId: nov, amount: 300 }], settle: false })
    expect((await post(dispute('pi_funding_a2', 80600))).status).toBe(200)
    const ok = await post({
      id: 'evt_ok_pi_charge_b2', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_charge_b2', metadata: {}, payment_method_types: ['us_bank_account'],
        latest_charge: { id: 'ch_pi_charge_b2', payment_method_details: { type: 'us_bank_account' } } } },
    })
    expect(ok.status).toBe(200)
    expect((await reopenedRows('evt_ok_pi_charge_b2')).map((r: any) => [r.orig, r.lost])).toEqual([[nov, 300]])
    // Then B itself is disputed in full.
    expect((await post(dispute('pi_charge_b2', 10600))).status).toBe(200)
    expect((await reopenedRows('evt_dispute_pi_charge_b2')).map((r: any) => [r.orig, r.lost, r.new_amount])).toEqual([[nov, 100, 100]])
    expect(await lostOn(nov)).toBe(400)
    expect(await openRent(h)).toBe(900)
  })
})

describe('Step 10 review — the landlord gives back only what they were paid', () => {
  it('a full dispute before the Tuesday payout: the share is withheld, nothing is netted or pulled, and paying again pays the landlord once', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_before_payout', [rent], 1000)
    expect(await batchOwed(h.landlordId)).toBe(1000)
    expect((await post(dispute('pi_before_payout', 100600))).status).toBe(200)
    const [r] = await reopenedRows('evt_dispute_pi_before_payout')
    expect(r).toMatchObject({ lost: 1000, recovery_status: 'recovered', new_status: 'pending' })
    // Never both: the share is not paid out AND nothing is asked back.
    expect(await batchOwed(h.landlordId)).toBe(0)
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    // The tenant pays the reopened rent: the landlord is paid it, once.
    await payByBank(h, 'pi_before_payout_again', [r.new_id], 1000)
    expect((await db.query<any>(`SELECT outcome FROM payment_reversals WHERE stripe_event_id = 'evt_dispute_pi_before_payout'`)).rows[0].outcome).toBe('tenant_paid')
    expect(await batchOwed(h.landlordId)).toBe(1000)
    expect(await recoveryOwed(h.landlordId)).toBe(0)
  })

  it('after the Tuesday payout: what went out is asked back once, nothing is withheld, and a re-payment first is kept by GAM', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_after_payout', [rent], 1000)
    await payoutRuns(h)
    expect(await batchOwed(h.landlordId)).toBe(0)
    expect((await post(dispute('pi_after_payout', 100600))).status).toBe(200)
    const [r] = await reopenedRows('evt_dispute_pi_after_payout')
    expect(['pending', 'scheduled_netting']).toContain(r.recovery_status)
    expect(await recoveryOwed(h.landlordId)).toBe(1000)
    const stamp = (await db.query<any>(`SELECT stripe_transfer_id FROM user_balance_ledger WHERE reference_id = $1`, [rent])).rows[0].stripe_transfer_id
    expect(stamp).not.toMatch(/^withheld:/)
    // The tenant pays again before GAM recovered it: GAM keeps the re-payment,
    // the recovery is called off, and the landlord keeps what they were paid.
    await payByBank(h, 'pi_after_payout_again', [r.new_id], 1000)
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(0)
  })

  it('success path: November used a $300 credit that turned out disputed + $100 really paid — the landlord is paid the $100 now and the $300 when the tenant pays it again', async () => {
    const h = await household()
    const oct = await row(h, { amount: 500, due: '2026-10-01' })
    const remA = await payByBank(h, 'pi_case2_a', [oct], 800, { surplus: 300 })
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [remA])).rows[0].id
    // October was paid out on Tuesday.
    await payoutRuns(h)
    const nov = await row(h, { amount: 400, due: '2026-11-01' })
    await payByBank(h, 'pi_case2_b', [nov], 100, { hold: [{ creditId: credit, paymentId: nov, amount: 300 }], settle: false })
    expect((await post(dispute('pi_case2_a', 80600))).status).toBe(200)
    const ok = await post({
      id: 'evt_ok_pi_case2_b', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_case2_b', metadata: {}, payment_method_types: ['us_bank_account'],
        latest_charge: { id: 'ch_pi_case2_b', payment_method_details: { type: 'us_bank_account' } } } },
    })
    expect(ok.status).toBe(200)
    // October was paid out: its $500 is asked back. November's $300 credit part
    // is withheld from its unpaid share, and the $100 the tenant really paid
    // reaches the landlord on the next batch.
    expect(await recoveryOwed(h.landlordId)).toBe(500)
    const [n] = await reopenedRows('evt_ok_pi_case2_b')
    expect(n).toMatchObject({ orig: nov, lost: 300, recovery_status: 'recovered', new_amount: 300 })
    expect(await batchOwed(h.landlordId)).toBe(100)
    // The tenant pays November's $300 again: the landlord is paid it too — $400 in all for November.
    await payByBank(h, 'pi_case2_again', [n.new_id], 300)
    expect(await batchOwed(h.landlordId)).toBe(400)
  })

  it('a neighbor landlord\'s utility on the disputed charge: each landlord is told only its own rows, and Stripe\'s kept fee is split by each one\'s share', async () => {
    const h = await household()
    // The neighbor landlord who sells this tenant water.
    const c = await getClient()
    let nb: { landlordId: string; landlordUserId: string; unitId: string }
    try {
      const { userId: nbUser, landlordId: nbId } = await seedLandlord(c)
      const nbProp = await seedProperty(c, { landlordId: nbId, ownerUserId: nbUser, managedByUserId: nbUser })
      const nbUnit = await seedUnit(c, { propertyId: nbProp, landlordId: nbId, rentAmount: 0 })
      await seedAllocationRule(c, { propertyId: nbProp, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
      nb = { landlordId: nbId, landlordUserId: nbUser, unitId: nbUnit }
    } finally { c.release() }
    const rent = await row(h, { amount: 1000 })
    const water = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, revenue_owner, notes)
       VALUES ($1, NULL, $2, $3, 'utility', 100, 'pending', 'UTILITY', '2026-10-01', 'landlord', 'Water') RETURNING id`,
      [nb!.unitId, h.tenantId, nb!.landlordId])).rows[0].id
    await payByBank(h, 'pi_neighbor', [rent, water], 1100)
    // The whole $6 fee the dispute gave back is the landlords' (decisions #38 Q4).
    const kept = 600

    expect((await post(dispute('pi_neighbor', 110600))).status).toBe(200)
    const notices = (await db.query<any>(
      `SELECT user_id, (data->>'landlordId') AS landlord_id, (data->>'amountOwed')::float AS owed FROM notifications
        WHERE type = 'rent_reversed' ORDER BY owed`)).rows
    expect(notices.map((x: any) => [x.landlord_id, x.owed])).toEqual([[nb!.landlordId, 100], [h.landlordId, 1000]])
    expect(notices.find((x: any) => x.landlord_id === nb!.landlordId).user_id).toBe(nb!.landlordUserId)
    // The fee: each landlord's share of the money taken back (1000 : 100).
    const lines = (await db.query<any>(
      `SELECT landlord_id, ROUND(amount * 100)::int AS c FROM held_payout_items WHERE source_id LIKE 'stripe_fee_kept:%'`)).rows
    const byL = new Map<string, number>(lines.map((x: any) => [x.landlord_id as string, -Number(x.c)]))
    expect((byL.get(h.landlordId) ?? 0) + (byL.get(nb!.landlordId) ?? 0)).toBe(kept)
    expect(Math.abs((byL.get(nb!.landlordId) ?? 0) - Math.round(kept * 100 / 1100))).toBeLessThanOrEqual(1)
    // Each landlord's withheld share is its own: nothing asked of either.
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect(await recoveryOwed(nb!.landlordId)).toBe(0)
  })

  it('GAM-first money a disputed charge routed to a FlexPay balance: never asked of the landlord, and the balance is open again', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    // A written-off FlexPay month ($175 + the $25) the charge's GAM-first part pays first.
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount,
                                     pull_day, status, defaulted_at, default_reason)
       VALUES ('2026-08-01', $1, $2, $3, $4, 175, 25, 10, 'defaulted', NOW() - interval '30 days', 'pull_not_collected') RETURNING id`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])).rows[0].id
    await db.query(`UPDATE payments SET gam_supersedence_amount = 200 WHERE id = $1`, [rent])
    await payByBank(h, 'pi_routed', [rent], 1000)
    expect((await db.query<any>(`SELECT status FROM flexpay_advances WHERE id = $1`, [adv])).rows[0].status).toBe('reconciled')
    // The landlord's share was $800; Tuesday pays it.
    await payoutRuns(h)
    expect((await post(dispute('pi_routed', 100600))).status).toBe(200)
    const [r] = await reopenedRows('evt_dispute_pi_routed')
    // The row lost all $1,000, but the tenant owes it again ONCE: $800 on the
    // reopened rent and the $200 on the FlexPay month it had paid — never the
    // $200 on both (the reopened row carries no GAM-first amount of its own).
    expect(r).toMatchObject({ lost: 1000, new_amount: 800, new_status: 'pending' })
    expect((await db.query<any>(`SELECT COALESCE(gam_supersedence_amount, 0)::float AS g FROM payments WHERE id = $1`, [r.new_id])).rows[0].g).toBe(0)
    // Only the $800 the landlord was paid is asked back, never GAM's $200.
    expect(await recoveryOwed(h.landlordId)).toBe(800)
    // The FlexPay month is open again (the tenant owes it as before they paid), its $25 off GAM's book.
    expect((await db.query<any>(`SELECT status FROM flexpay_advances WHERE id = $1`, [adv])).rows[0].status).toBe('defaulted')
    const fee = (await db.query<any>(
      `SELECT COALESCE(SUM(amount), 0)::float AS s FROM platform_revenue_ledger WHERE reference_id = $1`, [adv])).rows[0].s
    expect(fee).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'payment_reversal_gam_balance_reopen'`)).rowCount).toBe(0)
    // The landlord is told the tenant owes $800 again on their rent.
    const notice = (await db.query<any>(
      `SELECT (data->>'amountOwed')::float AS owed FROM notifications WHERE type = 'rent_reversed'`)).rows
    expect(notice).toEqual([{ owed: 800 }])
    // The $6 fee the dispute gave back: the landlord carries the share on their
    // $800; the share on GAM's own $200 is GAM's (GAM was paid that money).
    const line = await db.query<any>(`SELECT amount::float AS a FROM held_payout_items WHERE source_id LIKE 'stripe_fee_kept:%'`)
    expect(line.rows).toEqual([{ a: -4.8 }])
  })

  it('a dispute that took only GAM-first money reopens no landlord row: the GAM balance is owed again once, and the landlord\'s unpaid share still reaches them', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount,
                                     pull_day, status, defaulted_at, default_reason)
       VALUES ('2026-08-01', $1, $2, $3, $4, 175, 25, 10, 'defaulted', NOW() - interval '30 days', 'pull_not_collected') RETURNING id`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])).rows[0].id
    await db.query(`UPDATE payments SET gam_supersedence_amount = 200 WHERE id = $1`, [rent])
    await payByBank(h, 'pi_routed_only', [rent], 1000)
    expect(await batchOwed(h.landlordId)).toBe(800)
    // $200 disputed before the Tuesday payout: exactly the GAM-first part.
    expect((await post(dispute('pi_routed_only', 20000))).status).toBe(200)
    const [r] = await reopenedRows('evt_dispute_pi_routed_only')
    expect(r).toMatchObject({ orig: rent, lost: 200, orig_status: 'returned', new_id: null, recovery_status: 'not_needed', rec_status: 'resolved' })
    expect((await db.query(`SELECT 1 FROM payments WHERE reversal_id IS NOT NULL`)).rowCount).toBe(0)
    // The FlexPay month is owed again instead.
    expect((await db.query<any>(`SELECT status FROM flexpay_advances WHERE id = $1`, [adv])).rows[0].status).toBe('defaulted')
    // Nothing is asked of the landlord, and their $800 share — on a row now
    // marked returned, which no batch pays — reaches them on the next batch.
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(800)
    expect((await db.query(`SELECT 1 FROM notifications WHERE type = 'rent_reversed'`)).rowCount).toBe(0)
  })
})

describe('Step 10 review, pass 3 — the payout lines a dispute writes are never income', () => {
  // These pass once incomeBasis's chargeback query leaves out the landlord's
  // own share lines (paymentReversal.disputeShareLineSql) and shows the fee
  // line (disputeFeeLineSql) beside the total as a chargeback fee, never as a
  // register sale. incomeBasis.ts is another step's file; the change is handed
  // to it.
  // The landlord's report under Money received, over every day of the test.
  const received = (h: H) => incomeTotals({ landlordIds: [h.landlordId], start: '2020-01-01', end: '2035-12-31', basis: 'received' })

  it('a partial dispute before the payout: the share the tenant still paid is rent already counted, never a register sale', async () => {
    const h = await household()
    const sep = await row(h, { amount: 500, due: '2026-09-01' })
    const oct = await row(h, { amount: 500, due: '2026-10-01' })
    await payByBank(h, 'pi_income_partial', [sep, oct], 1000)
    // $200 disputed before the Tuesday payout: October loses $200, and its
    // other $300 reaches the landlord on a held line.
    expect((await post(dispute('pi_income_partial', 20000))).status).toBe(200)
    expect(await batchOwed(h.landlordId)).toBe(800)
    const t = await received(h)
    expect(t.lines.registerAndStays).toBe(0)
    expect(t.total).toBe(800)
  })

  it('a full dispute after the payout: the fee netted from the landlord is no register sale', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_income_after', [rent], 1000)
    await payoutRuns(h)
    expect((await post(dispute('pi_income_after', 100600))).status).toBe(200)
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE source_id LIKE 'stripe_fee_kept:%'`)).rowCount).toBe(1)
    const t = await received(h)
    expect(t.lines.registerAndStays).toBe(0)
    expect(t.total).toBe(0)
  })

  it('the landlord pays the bank fee, a dispute before the payout, then a re-payment GAM keeps: the share paid back is rent already counted', async () => {
    const h = await household({ achFeePayer: 'landlord' })
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_income_kept', [rent], 1000, { fee: 0 })
    // The landlord's share is the rent less the bank fee they pay (the rate table's).
    const share = await batchOwed(h.landlordId)
    expect(share).toBeGreaterThan(0)
    expect(share).toBeLessThan(1000)
    const fee = Math.round((1000 - share) * 100) / 100
    expect((await post(dispute('pi_income_kept', 100000))).status).toBe(200)
    const [r] = await reopenedRows('evt_dispute_pi_income_kept')
    // The unpaid share is withheld; the fee GAM no longer has is asked back.
    expect(r).toMatchObject({ lost: 1000, recovery_status: 'pending', new_amount: 1000 })
    expect(await recoveryOwed(h.landlordId)).toBe(fee)
    // The tenant pays again first: GAM keeps it, calls off the fee, and pays
    // the landlord back the share it held — what they would have had all along.
    await payByBank(h, 'pi_income_kept_again', [r.new_id], 1000, { fee: 0 })
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(share)
    const t = await received(h)
    expect(t.lines.registerAndStays).toBe(0)
    expect(t.total).toBe(1000)
  })
})

describe('S655 Step 10 — a dispute that finds nothing to reopen is never silent', () => {
  it('a dispute that reopens nothing on a tenant payment GAM knows alerts an admin', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    // The dispute arrives before the charge's success was handled: nothing is
    // settled through it yet, and Stripe has taken the money back.
    await payByBank(h, 'pi_dispute_early', [rent], 1000, { settle: false })
    expect((await post(dispute('pi_dispute_early', 100600))).status).toBe(200)
    const alerts = await db.query<any>(`SELECT severity, body FROM admin_notifications WHERE category = 'payment_reversal_nothing_reopened'`)
    expect(alerts.rows).toHaveLength(1)
    expect(alerts.rows[0].severity).toBe('critical')
    expect(alerts.rows[0].body).toMatch(/processing/)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'dispute_charge_unplaced'`)).rowCount).toBe(0)
  })

  it('a dispute on a charge GAM cannot place at all is told to an admin', async () => {
    await household()
    expect((await post(dispute('pi_nobody_knows', 5000))).status).toBe(200)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'dispute_charge_unplaced'`)).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'payment_reversal_nothing_reopened'`)).rowCount).toBe(0)
  })
})

describe('S655 Step 10 — charges that paid no rows', () => {
  /** A settled receipt whose money is all paid-ahead credit; `spends` are later rows paid from it. */
  async function noRowCharge(h: H, pi: string, money: number, spends: Array<{ amount: number; due: string }>) {
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,$4,0,$4,'settled','ach',$5,6,$6,NOW()) RETURNING id`,
      [h.tenantId, h.leaseId, h.landlordId, money, money + 6, pi])).rows[0].id
    const c = await getClient()
    let credit: string
    try {
      credit = await createPaidAhead(c as any, { leaseId: h.leaseId, tenantId: h.tenantId, amount: money, fundedBy: 'gam', receivedAt: new Date(), sourceRemittanceId: rem })
    } finally { c.release() }
    const rows: string[] = []
    for (const s of spends) {
      const id = await row(h, { amount: s.amount, due: s.due })
      rows.push(id)
      await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId })
      expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status).toBe('settled')
    }
    return { rem, credit: credit!, rows }
  }

  it('a bank return of a charge that paid no rows withdraws its paid-ahead money and undoes its spends', async () => {
    const h = await household()
    const { credit, rows } = await noRowCharge(h, 'pi_norow_return', 300, [{ amount: 200, due: '2026-11-01' }])
    const res = await handlePaymentReversal({
      paymentIntentId: 'pi_norow_return', reversalType: 'ach_return', reversedAmount: null, reversalFee: 4,
      stripeEventId: 'evt_norow_return', stripeObjectId: 'py_norow', rawEvent: {},
    })
    expect(res.handled).toBe(true)
    const c = (await db.query<any>(`SELECT voided_at, void_reason FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0]
    expect(c.voided_at).not.toBeNull()
    expect(c.void_reason).toMatch(/returned/)
    expect((await db.query<any>(`SELECT status FROM credit_uses WHERE prepaid_credit_id = $1 AND payment_id = $2`, [credit, rows[0]])).rows[0].status).toBe('reversed')
    const reopened = await reopenedRows('evt_norow_return')
    expect(reopened.map((r: any) => [r.orig, r.lost, r.new_amount])).toEqual([[rows[0], 200, 200]])
    // The return fee is billed once, on the credit's lease.
    expect((await db.query<any>(`SELECT amount::float AS a, lease_id FROM payments WHERE entry_description = 'RETURNFEE'`)).rows)
      .toEqual([{ a: 4, lease_id: h.leaseId }])
    // Withdrawn money is out of every balance.
    const c2 = await getClient()
    try { expect((await prepaidDrawAvailable(c2 as any, h.leaseId, '2026-12-01')).remaining).toBe(0) } finally { c2.release() }
  })

  it('a partial dispute of a charge that paid no rows undoes whole spends newest first until met and takes back only the claim', async () => {
    const h = await household()
    const { credit, rows } = await noRowCharge(h, 'pi_norow_partial', 300, [
      { amount: 200, due: '2026-11-01' },
      { amount: 50, due: '2026-12-01' },
    ])
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(50)
    // $220 disputed: the $50 unspent, then December's $50, then November's
    // $200 whole (the claim is met inside it); $220 is taken back, $80 is the
    // tenant's again.
    expect((await post(dispute('pi_norow_partial', 22000))).status).toBe(200)
    const reopened = await reopenedRows('evt_dispute_pi_norow_partial')
    expect(reopened.map((r: any) => [r.orig, r.lost])).toEqual([[rows[0], 200], [rows[1], 50]])
    const drained = await db.query<any>(`SELECT COALESCE(SUM(amount), 0)::float AS d FROM credit_uses WHERE prepaid_credit_id = $1 AND source = 'reversal'`, [credit])
    expect(drained.rows[0].d).toBe(220)
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(80)
  })

  it('paid-ahead money a dispute still claims is never drawn for a bill (usable remaining)', async () => {
    const h = await household()
    const { credit } = await noRowCharge(h, 'pi_norow_claim', 300, [])
    // A partial dispute on file that nothing has taken back yet.
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('du_claim', 'ch_claim', 'pi_norow_claim', 120, 'needs_response')`)
    const c = await getClient()
    try {
      const a = await prepaidDrawAvailable(c as any, h.leaseId, '2026-11-01')
      expect(a.remaining).toBe(180)
    } finally { c.release() }
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(300)
  })
})

describe('S655 Step 10 — credit set aside on a charge whose funding was disputed', () => {
  it('when that charge succeeds, the spend is undone, its row reopens for the use amount and the money is taken back', async () => {
    const h = await household()
    const oct = await row(h, { amount: 500, due: '2026-10-01' })
    const remA = await payByBank(h, 'pi_funding_a', [oct], 800, { surplus: 300 })
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [remA])).rows[0].id
    // November's $400: the tenant uses the $300 credit and pays $100 by bank.
    const nov = await row(h, { amount: 400, due: '2026-11-01' })
    await payByBank(h, 'pi_charge_b', [nov], 100, { hold: [{ creditId: credit, paymentId: nov, amount: 300 }], settle: false })
    // Charge A is disputed in full while B is clearing.
    expect((await post(dispute('pi_funding_a', 80600))).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM credit_uses WHERE payment_id = $1`, [nov])).rows[0].status).toBe('held')
    const collectedBefore = (await db.query(`SELECT 1 FROM notifications WHERE type = 'rent_collected'`)).rowCount

    // B's money arrives.
    const ok = await post({
      id: 'evt_ok_pi_charge_b', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_charge_b', metadata: {}, payment_method_types: ['us_bank_account'],
        latest_charge: { id: 'ch_pi_charge_b', payment_method_details: { type: 'us_bank_account' } } } },
    })
    expect(ok.status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM credit_uses WHERE payment_id = $1 AND source = 'portal'`, [nov])).rows[0].status).toBe('reversed')
    const reopened = await reopenedRows('evt_ok_pi_charge_b')
    expect(reopened.map((r: any) => [r.orig, r.lost, r.orig_status, r.new_amount])).toEqual([[nov, 300, 'returned', 300]])
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'disputed_credit_spent_on_charge'`)).rowCount).toBe(1)
    // November is owed again: never announced to the landlord as collected,
    // and never printed on the tenant's receipt as paid in full.
    expect((await db.query(`SELECT 1 FROM notifications WHERE type = 'rent_collected'`)).rowCount).toBe(collectedBefore)
    const receipts = vi.mocked(sendPaymentReceipt).mock.calls.map(c => c[0].paymentIds)
    expect(receipts.some(ids => ids.includes(nov))).toBe(false)
  })
})

describe('S655 Step 10 — a disputed FlexPay pull', () => {
  it('a disputed FlexPay pull writes its advance off instead of reopening a row', async () => {
    const h = await household()
    await db.query(`UPDATE tenants SET flexpay_enrolled = TRUE, flexpay_pull_day = 10, flexpay_monthly_fee = 25 WHERE id = $1`, [h.tenantId])
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount,
                                     pull_day, status, fronted_at, pulled_at, reconciled_at, pull_date)
       VALUES ('2026-10-01', $1, $2, $3, $4, 500, 25, 10, 'reconciled', NOW(), NOW(), NOW(), '2026-10-10') RETURNING id`,
      [h.tenantId, h.landlordId, h.unitId, h.leaseId])).rows[0].id
    const pull = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             revenue_owner, stripe_payment_intent_id, flexpay_advance_id, settled_at)
       VALUES ($1,$2,$3,$4,'fee',525,'settled','FLEXPAY','2026-10-10','gam','pi_flex_disputed',$5,NOW()) RETURNING id`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId, adv])).rows[0].id
    await db.query(`UPDATE flexpay_advances SET rent_payment_id = $2 WHERE id = $1`, [adv, pull])

    expect((await post(dispute('pi_flex_disputed', 52500))).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM flexpay_advances WHERE id = $1`, [adv])).rows[0].status).toBe('defaulted')
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [pull])).rows[0].status).toBe('returned')
    // Never a reopened row the tenant would pay as rent, and the fee rides the advance.
    expect((await db.query(`SELECT 1 FROM payments WHERE reversal_id IS NOT NULL`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'RETURNFEE'`)).rowCount).toBe(0)
    const a = (await db.query<any>(`SELECT tenant_fee_amount::float AS f FROM flexpay_advances WHERE id = $1`, [adv])).rows[0]
    expect(a.f).toBe(40)
    expect((await db.query(`SELECT 1 FROM notifications WHERE type = 'rent_reversed'`)).rowCount).toBe(0)
  })
})

describe('Step 10 fix pass 3 — a dispute on a charge whose money was banked after its rows failed for good', () => {
  it('a dispute on a charge whose money was banked after its rows failed for good reopens the bill that money paid, and the landlord\'s share is withheld', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    const c = await getClient()
    let credit: string
    try { credit = await createPaidAhead(c as any, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 100, fundedBy: 'landlord', receivedAt: new Date() }) }
    finally { c.release() }
    const pi = 'pi_fp3_banked_then_disputed'
    const rem = await payByBank(h, pi, [rent], 900, { hold: [{ creditId: credit!, paymentId: rent, amount: 100 }], settle: false })
    // The bank closes the account: final. The row fails for good, keeping the intent.
    expect((await post({
      id: 'evt_fail_' + pi, type: 'payment_intent.payment_failed',
      data: { object: { id: pi, metadata: { gam_remittance_id: rem }, payment_method_types: ['us_bank_account'],
        last_payment_error: { payment_method_details: { us_bank_account: { return_details: { code: 'R02' } } } } } },
    })).status).toBe(200)
    expect((await db.query<any>(`SELECT status, stripe_payment_intent_id AS pi FROM payments WHERE id = $1`, [rent])).rows[0])
      .toEqual({ status: 'failed', pi })
    // Then the intent succeeds: the $900 is banked as GAM-held paid-ahead money,
    // and the whole-bill check pays the bill from it and the tenant's own $100.
    expect((await post({
      id: 'evt_ok_' + pi, type: 'payment_intent.succeeded',
      data: { object: { id: pi, metadata: { gam_remittance_id: rem }, payment_method_types: ['us_bank_account'],
        latest_charge: { id: 'ch_' + pi, payment_method_details: { type: 'us_bank_account' } } } },
    })).status).toBe(200)
    expect((await db.query<any>(`SELECT status, stripe_payment_intent_id AS pi FROM payments WHERE id = $1`, [rent])).rows[0])
      .toEqual({ status: 'settled', pi })
    expect((await db.query<any>(`SELECT amount::float AS a FROM user_balance_ledger WHERE reference_id = $1 AND type = 'allocation_owner_share'`, [rent])).rows)
      .toEqual([{ a: 900 }])

    // Stripe takes the $900 back.
    const res = await handlePaymentReversal({
      paymentIntentId: pi, reversalType: 'ach_unauthorized', reversedAmount: null, reversalFee: 4,
      stripeEventId: 'evt_fp3_unauth', stripeObjectId: 'py_fp3', rawEvent: {},
    })
    expect(res.handled).toBe(true)
    expect(res.creditClawed).toBe(900)
    // The bill that money paid is owed again for $900 (the tenant's own $100 stays spent on it),
    // on ONE record for the row.
    const rows = await reopenedRows('evt_fp3_unauth')
    expect(rows.map((r: any) => [r.orig, r.lost, r.orig_status, r.new_amount, r.new_status])).toEqual([
      [rent, 900, 'returned', 900, 'pending'],
    ])
    expect(res.reopenedTotal).toBe(900)
    // No payout ran: the landlord's $900 share is withheld, nothing is asked of them,
    // and nothing of it is still to be paid out (GAM absorbs nothing).
    expect(rows[0].recovery_status).toBe('recovered')
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(0)
    // The event's fee is recorded once and billed to the tenant once.
    expect((await db.query<any>(`SELECT reversal_fee::float AS f FROM payment_reversals WHERE stripe_event_id = 'evt_fp3_unauth'`)).rows)
      .toEqual([{ f: 4 }])
    expect((await db.query<any>(`SELECT amount::float AS a FROM payments WHERE entry_description = 'RETURNFEE'`)).rows).toEqual([{ a: 4 }])
    // The tenant's own $100: the use the failed charge set aside was given back, and the
    // one the whole-bill check made stays spent on the bill.
    expect((await db.query<any>(`SELECT status, amount::float AS a FROM credit_uses WHERE prepaid_credit_id = $1 ORDER BY status`, [credit!])).rows)
      .toEqual([{ status: 'applied', a: 100 }, { status: 'released', a: 100 }])
  })
})

/**
 * The fix pass 3 fixture: a $1,000 rent row, $100 of it from the tenant's own
 * paid-ahead money; the $900 charge fails for good (the row keeps the intent),
 * then succeeds — its money is banked as paid-ahead credit and the whole-bill
 * check pays the row from it. The row holds no money of its own: all $900 of
 * it is a spend of the charge's banked money.
 * `disputedAs: 'card'`: only a card is disputed in part (a bank return is
 * whole), and the dispute webhook reads card or bank off the receipt, so the
 * receipt is then marked a card charge. (A real declined card leaves a $1
 * decline fee on the bill, which the $1,000 of credit would not cover in full.)
 */
async function bankedThenWholeBill(h: H, pi: string, disputedAs: 'card' | 'ach'): Promise<{ rent: string; rem: string; banked: string }> {
  const rent = await row(h, { amount: 1000 })
  const c = await getClient()
  let own: string
  try { own = await createPaidAhead(c as any, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 100, fundedBy: 'landlord', receivedAt: new Date() }) }
  finally { c.release() }
  const types = ['us_bank_account']
  const rem = await payByBank(h, pi, [rent], 900, { hold: [{ creditId: own!, paymentId: rent, amount: 100 }], settle: false })
  expect((await post({
    id: 'evt_fail_' + pi, type: 'payment_intent.payment_failed',
    data: { object: { id: pi, metadata: { gam_remittance_id: rem }, payment_method_types: types,
      last_payment_error: { payment_method_details: { us_bank_account: { return_details: { code: 'R02' } } } } } },
  })).status).toBe(200)
  expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('failed')
  expect((await post({
    id: 'evt_ok_' + pi, type: 'payment_intent.succeeded',
    data: { object: { id: pi, metadata: { gam_remittance_id: rem }, payment_method_types: types,
      latest_charge: { id: 'ch_' + pi, payment_method_details: { type: types[0] } } } },
  })).status).toBe(200)
  expect((await db.query<any>(`SELECT status, stripe_payment_intent_id AS pi FROM payments WHERE id = $1`, [rent])).rows[0])
    .toEqual({ status: 'settled', pi })
  const banked = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rows[0].id
  expect((await db.query<any>(`SELECT status, amount::float AS a FROM credit_uses WHERE prepaid_credit_id = $1`, [banked])).rows)
    .toEqual([{ status: 'applied', a: 900 }])
  if (disputedAs === 'card') await db.query(`UPDATE tenant_remittances SET payment_method = 'card' WHERE id = $1`, [rem])
  return { rent, rem, banked }
}

/** Paid-ahead money the tenant can still use on a credit (THE shared reader). */
const usable = async (creditId: string) => (await db.query<any>(
  `SELECT ${usablePaidAheadSql('c', 'dc')}::float AS u FROM lease_prepaid_credits c ${disputeClaimJoinSql('c', 'dc')} WHERE c.id = $1`,
  [creditId])).rows[0].u

describe('Step 10 fix pass 4 — a partial claim is never left on nobody', () => {
  it('a partial dispute on a charge whose money was banked after its rows failed for good reopens the bill that money paid for the claim and withholds the landlord\'s share', async () => {
    const h = await household()
    const pi = 'pi_fp4_partial_banked'
    const { rent, banked } = await bankedThenWholeBill(h, pi, 'card')
    expect(await batchOwed(h.landlordId)).toBe(900)

    // The card holder disputes $450 of the $906 charge.
    expect((await post(dispute(pi, 45000))).status).toBe(200)
    const rows = await reopenedRows('evt_dispute_' + pi)
    // The $900 spend of the disputed money is undone whole: the bill it paid is owed again for $900.
    expect(rows.map((r: any) => [r.orig, r.lost, r.orig_status, r.new_amount, r.new_status, r.recovery_status])).toEqual([
      [rent, 900, 'returned', 900, 'pending', 'recovered'],
    ])
    // Only the $450 the dispute took comes off the credit; the other $450 is the tenant's again, and usable.
    expect((await db.query<any>(
      `SELECT status, (source = 'reversal') AS drain, amount::float AS a FROM credit_uses WHERE prepaid_credit_id = $1 ORDER BY amount DESC`,
      [banked])).rows).toEqual([{ status: 'reversed', drain: false, a: 900 }, { status: 'applied', drain: true, a: 450 }])
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [banked])).rows[0].r).toBe(450)
    expect(await usable(banked)).toBe(450)
    // No payout ran: the landlord's $900 share is withheld (they are paid again when the tenant
    // pays the bill again), nothing is asked of them, nothing of it is still to be paid out.
    expect(await batchOwed(h.landlordId)).toBe(0)
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    // Every dollar once: what Stripe took ($450) = owed again on the bill ($900) less the credit given back ($450).
    const owedAgain = (await db.query<any>(`SELECT COALESCE(SUM(amount), 0)::float AS s FROM payments WHERE reversal_id IS NOT NULL AND status = 'pending'`)).rows[0].s
    expect(owedAgain - await usable(banked)).toBe(450)
    // The dispute fee is recorded once and billed to the tenant once.
    expect((await db.query<any>(`SELECT COALESCE(SUM(reversal_fee), 0)::float AS f FROM payment_reversals`)).rows[0].f).toBe(15)
    expect((await db.query<any>(`SELECT amount::float AS a FROM payments WHERE entry_description = 'RETURNFEE'`)).rows).toEqual([{ a: 15 }])
    // Nothing was left over: no shortfall alert.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category IN ('payment_reversal_short', 'disputed_credit_short', 'payment_reversal_nothing_reopened')`)).rowCount).toBe(0)
  })

  it('a partial dispute on that charge after the payout recovers the paid-out share from the landlord, and the tenant keeps the undisputed half as credit', async () => {
    const h = await household()
    const pi = 'pi_fp4_partial_paid'
    const { rent, banked } = await bankedThenWholeBill(h, pi, 'card')
    await payoutRuns(h)
    expect(await batchOwed(h.landlordId)).toBe(0)

    expect((await post(dispute(pi, 45000))).status).toBe(200)
    const rows = await reopenedRows('evt_dispute_' + pi)
    expect(rows.map((r: any) => [r.orig, r.lost, r.new_amount])).toEqual([[rent, 900, 900]])
    // The $900 went out to the landlord: it is asked back once; the tenant owes $900 again and has $450 back.
    expect(await recoveryOwed(h.landlordId)).toBe(900)
    expect(await usable(banked)).toBe(450)
  })

  it('a second event for the same return records and bills its fee once', async () => {
    const h = await household()
    const pi = 'pi_fp4_two_events'
    await bankedThenWholeBill(h, pi, 'ach')
    const first = await handlePaymentReversal({ paymentIntentId: pi, reversalType: 'ach_unauthorized', reversedAmount: null, reversalFee: 4,
      stripeEventId: 'evt_fp4_a', stripeObjectId: 'py_fp4', rawEvent: {} })
    expect(first.handled).toBe(true)
    expect(first.feeRowId).not.toBeNull()
    const second = await handlePaymentReversal({ paymentIntentId: pi, reversalType: 'ach_unauthorized', reversedAmount: null, reversalFee: 4,
      stripeEventId: 'evt_fp4_b', stripeObjectId: 'py_fp4', rawEvent: {} })
    expect(second.feeRowId).toBeNull()
    expect((await db.query<any>(`SELECT COALESCE(SUM(reversal_fee), 0)::float AS f FROM payment_reversals WHERE stripe_object_id = 'py_fp4'`)).rows[0].f).toBe(4)
    expect((await db.query<any>(`SELECT amount::float AS a FROM payments WHERE entry_description = 'RETURNFEE'`)).rows).toEqual([{ a: 4 }])
  })

  it('a partial claim that neither the paid-ahead money nor the bills can carry tells an admin the shortfall', async () => {
    const h = await household()
    const rent = await row(h, { amount: 600 })
    const pi = 'pi_fp4_short'
    const rem = await payByBank(h, pi, [rent], 600)
    // The receipt says the charge brought $1,000, but its one bill holds $600 and it banked
    // nothing ahead: a $800 claim finds only $600 to reopen.
    await db.query(`UPDATE tenant_remittances SET amount = 1000, applied_amount = 1000, gross_amount = 1006 WHERE id = $1`, [rem])
    const b = await handlePaymentReversal({ paymentIntentId: pi, reversalType: 'card_dispute', reversedAmount: 800, reversalFee: 0,
      stripeEventId: 'evt_fp4_short_b', stripeObjectId: 'du_fp4_b', rawEvent: {} })
    expect(b.reopenedTotal).toBe(600)
    const alert = (await db.query<any>(`SELECT severity, title, context FROM admin_notifications WHERE category = 'payment_reversal_short'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].severity).toBe('critical')
    expect(Number(alert[0].context.short)).toBe(200)
  })
})

// ── Fix pass (rev8): partial disputes that add up across events ──────────────
// Stripe can take one card charge back in more than one dispute. Each is
// counted with the ones already handled: the money first, the card fee only
// past the money; a row an earlier dispute reopened in part still holds the
// rest of its money for a later one; and whatever no bill or paid-ahead money
// can carry is told to an admin, never left on nobody.

/** A card charge for `rent` of rent plus `ahead` paid ahead, with `fee` of card fee on top, settled through the webhook. */
async function cardWithAhead(h: H, pi: string, rent: number, ahead: number, fee: number): Promise<{ rent: string; rem: string; credit: string }> {
  const rentId = await row(h, { amount: rent })
  const rem = await payByBank(h, pi, [rentId], rent + ahead, { surplus: ahead, fee })
  await db.query(`UPDATE tenant_remittances SET payment_method = 'card' WHERE id = $1`, [rem])
  const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE source_remittance_id = $1`, [rem])).rows[0].id
  return { rent: rentId, rem, credit }
}
/** One of several disputes on the same charge: its own Stripe dispute id and event id. */
function disputeNo(pi: string, cents: number, tag: string, eventTag = tag) {
  return {
    id: `evt_dispute_${pi}_${eventTag}`, type: 'charge.dispute.created',
    data: { object: { id: `du_${pi}_${tag}`, object: 'dispute', charge: 'ch_' + pi, payment_intent: pi, amount: cents,
      currency: 'usd', status: 'needs_response', reason: 'fraudulent', balance_transactions: [{ fee: 1500 }] } },
  }
}
const takenOffRow = async (paymentId: string) => (await db.query<any>(
  `SELECT COALESCE(SUM(reversed_amount), 0)::float AS s FROM payment_reversals WHERE payment_id = $1`, [paymentId])).rows[0].s
const owedAgainOn = async (paymentId: string) => (await db.query<any>(
  `SELECT n.amount::float AS a FROM payments n JOIN payment_reversals pr ON pr.id = n.reversal_id
    WHERE pr.payment_id = $1 AND n.status = 'pending' ORDER BY n.created_at, n.amount`, [paymentId])).rows.map((r: any) => r.a)
const drainedOff = async (creditId: string) => (await db.query<any>(
  `SELECT COALESCE(SUM(amount), 0)::float AS d FROM credit_uses WHERE prepaid_credit_id = $1 AND source = 'reversal' AND status = 'applied'`,
  [creditId])).rows[0].d
const notesOf = async (category: string) => (await db.query<any>(
  `SELECT title, body, context FROM admin_notifications WHERE category = $1 ORDER BY created_at`, [category])).rows
const keptFeeLines = async () => (await db.query<any>(
  `SELECT amount::float AS a FROM held_payout_items WHERE source_id LIKE 'stripe_fee_kept:%'`)).rows

describe('Fix pass (rev8) — partial disputes that add up across events', () => {
  it('$60 then $20 on $50 rent + $51 paid ahead: the second dispute reopens $20 of the rent row (SUM reversed_amount = 29)', async () => {
    const h = await household()
    const pi = 'pi_rev8_6020'
    const f = await cardWithAhead(h, pi, 50, 51, 3.55)
    expect((await post(disputeNo(pi, 6000, 'a'))).status).toBe(200)
    // The $51 paid ahead goes first, then $9 of the rent.
    expect(await drainedOff(f.credit)).toBe(51)
    expect(await takenOffRow(f.rent)).toBe(9)
    expect((await post(disputeNo(pi, 2000, 'b'))).status).toBe(200)
    // The rent row was 'returned' for $9 and still held $41 of this charge's money: $20 more of it reopens.
    expect(await takenOffRow(f.rent)).toBe(29)
    expect(await owedAgainOn(f.rent)).toEqual([9, 20])
    expect(await drainedOff(f.credit)).toBe(51)
    // Every dollar Stripe took ($80) is placed once: $51 off the money paid ahead, $29 owed again on the rent.
    expect(r2(await drainedOff(f.credit) + await takenOffRow(f.rent))).toBe(80)
    expect(await notesOf('payment_reversal_short')).toEqual([])
    // Nothing of the card fee was taken: nothing is netted from the landlord for it.
    expect(await keptFeeLines()).toEqual([])
  })

  it('$60 then $20: the bills carried the $20, so no admin notice is raised for it (nothing is left on nobody)', async () => {
    const h = await household()
    const pi = 'pi_rev8_6020n'
    const f = await cardWithAhead(h, pi, 50, 51, 3.55)
    await post(disputeNo(pi, 6000, 'a'))
    await post(disputeNo(pi, 2000, 'b'))
    expect(await takenOffRow(f.rent)).toBe(29)
    expect(await notesOf('dispute_second_on_charge')).toEqual([])
    expect(await notesOf('payment_reversal_short')).toEqual([])
  })

  it('$60, then $41, then $3.55: the $41 reopens the rest of the rent, and the fee-only third dispute is named to settle by hand — never silent, never netted twice', async () => {
    const h = await household()
    const pi = 'pi_rev8_three'
    const f = await cardWithAhead(h, pi, 50, 51, 3.55)
    await post(disputeNo(pi, 6000, 'a'))
    expect((await post(disputeNo(pi, 4100, 'b'))).status).toBe(200)
    expect(await takenOffRow(f.rent)).toBe(50)
    expect(await owedAgainOn(f.rent)).toEqual([9, 41])
    expect(await notesOf('payment_reversal_short')).toEqual([])
    // The bills carried the $41: no notice for it.
    expect(await notesOf('dispute_second_on_charge')).toEqual([])

    expect((await post(disputeNo(pi, 355, 'c'))).status).toBe(200)
    // All the money was placed already: nothing more is reopened.
    expect(await takenOffRow(f.rent)).toBe(50)
    const short = await notesOf('payment_reversal_short')
    expect(short).toHaveLength(1)
    expect(Number(short[0].context.short)).toBe(3.55)
    expect(Number(short[0].context.card_fee_part)).toBe(3.55)
    expect(short[0].body).toContain('Bill the other $3.55 to the tenant, or settle it with the landlord, by hand')
    const second = await notesOf('dispute_second_on_charge')
    expect(second.map((n: any) => n.title)).toEqual([
      `A second card dispute on the same payment (${pi}) — settle $3.55 of card fee by hand`,
    ])
    // Named by hand once (the two notices say it is the same money), never also netted from the landlord.
    expect(await keptFeeLines()).toEqual([])
    // Every dollar Stripe took ($104.55): $101 placed, $3.55 named by hand.
    expect(r2(await drainedOff(f.credit) + await takenOffRow(f.rent) + Number(short[0].context.short))).toBe(104.55)
  })

  it('$60 then $44.55: the second dispute is $41 of money and $3.55 of card fee — the $41 reopens the rent, the fee is named by hand', async () => {
    const h = await household()
    const pi = 'pi_rev8_6044'
    const f = await cardWithAhead(h, pi, 50, 51, 3.55)
    await post(disputeNo(pi, 6000, 'a'))
    expect((await post(disputeNo(pi, 4455, 'b'))).status).toBe(200)
    expect(await takenOffRow(f.rent)).toBe(50)
    expect(await owedAgainOn(f.rent)).toEqual([9, 41])
    const short = await notesOf('payment_reversal_short')
    expect(short.map((n: any) => [Number(n.context.short), Number(n.context.card_fee_part)])).toEqual([[3.55, 3.55]])
    expect(await keptFeeLines()).toEqual([])
  })

  it('a second event for a partial dispute already handled (another event id, the same dispute) takes nothing more', async () => {
    const h = await household()
    const pi = 'pi_rev8_again'
    const f = await cardWithAhead(h, pi, 50, 51, 3.55)
    await post(disputeNo(pi, 6000, 'a'))
    expect((await post(disputeNo(pi, 6000, 'a', 'a2'))).status).toBe(200)
    expect(await takenOffRow(f.rent)).toBe(9)
    expect(await owedAgainOn(f.rent)).toEqual([9])
    expect(await drainedOff(f.credit)).toBe(51)
    // The dispute's fee is billed once.
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'RETURNFEE'`)).rowCount).toBe(1)
    expect(await notesOf('payment_reversal_short')).toEqual([])
  })

  it('a partial dispute after an earlier one reopened every bill, which nothing is left to carry, still tells an admin the shortfall', async () => {
    const h = await household()
    const pi = 'pi_rev8_nothingleft'
    const f = await cardWithAhead(h, pi, 50, 51, 3.55)
    // The receipt says the charge brought $200, but its bill held $50 and it banked $51 ahead.
    await db.query(`UPDATE tenant_remittances SET amount = 200, gross_amount = 203.55 WHERE id = $1`, [f.rem])
    await post(disputeNo(pi, 10100, 'a'))
    expect(await takenOffRow(f.rent)).toBe(50)
    expect(await drainedOff(f.credit)).toBe(51)
    expect(await notesOf('payment_reversal_short')).toEqual([])
    // A second $40 dispute: no bill and no paid-ahead money is left to take it.
    expect((await post(disputeNo(pi, 4000, 'b'))).status).toBe(200)
    const short = await notesOf('payment_reversal_short')
    expect(short).toHaveLength(1)
    expect(Number(short[0].context.short)).toBe(40)
    expect(short[0].body).toContain('Bill the other $40.00 to the tenant, or settle it with the landlord, by hand — GAM does not absorb it.')
  })

  it('the first dispute still nets its card-fee part from the landlord once (the rule in force is unchanged)', async () => {
    const h = await household()
    const pi = 'pi_rev8_firstfee'
    await cardWithAhead(h, pi, 50, 51, 3.55)
    // $103 of the $104.55: all the money and $2 of the fee.
    expect((await post(disputeNo(pi, 10300, 'a'))).status).toBe(200)
    expect(await keptFeeLines()).toEqual([{ a: -2 }])
    expect(await notesOf('payment_reversal_short')).toEqual([])
  })
})

describe('Fix pass (rev8) — a reopened bill paid again in cash at the desk', () => {
  it('a reopened rent bill paid in cash: the landlord holds the cash, so their withheld share is never paid back to them too (paid once), and the record learns the tenant paid', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_rev8_cash', [rent], 1000)
    // Before the Tuesday payout: the landlord's $1,000 share is withheld for the dispute.
    expect((await post(dispute('pi_rev8_cash', 100600))).status).toBe(200)
    expect(await batchOwed(h.landlordId)).toBe(0)
    const rec = (await db.query<any>(`SELECT id, recovery_status FROM payment_reversals WHERE payment_id = $1`, [rent])).rows[0]
    expect(rec.recovery_status).toBe('recovered')
    const again = (await db.query<any>(
      `SELECT id, landlord_id, tenant_id, unit_id, lease_id, due_date::text AS due_date FROM payments WHERE reversal_id = $1`, [rec.id])).rows[0]
    const { settleManualRentPayment } = await import('../services/manualPaymentSettle')
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const out = await settleManualRentPayment(c as any, {
        payment: again, method: 'cash', settledAt: null, settleHousehold: true, amountTendered: 1000, source: 'desk',
      })
      expect(out.settledPaymentIds).toContain(again.id)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect((await db.query<any>(`SELECT outcome, recovery_status FROM payment_reversals WHERE id = $1`, [rec.id])).rows[0])
      .toEqual({ outcome: 'tenant_paid', recovery_status: 'recovered' })
    // Nothing goes back to the landlord on a payout: they hold the $1,000 cash.
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE source_id = $1`, [`owner_share_returned:${rec.id}`])).rowCount).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(0)
  })

  it('after the payout: a reopened rent bill paid in cash leaves the landlord\'s recovery standing (they hold the cash and were paid the share already)', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_rev8_cash_paid', [rent], 1000)
    await payoutRuns(h)
    expect((await post(dispute('pi_rev8_cash_paid', 100600))).status).toBe(200)
    expect(await recoveryOwed(h.landlordId)).toBe(1000)
    const rec = (await db.query<any>(`SELECT id FROM payment_reversals WHERE payment_id = $1`, [rent])).rows[0]
    const again = (await db.query<any>(
      `SELECT id, landlord_id, tenant_id, unit_id, lease_id, due_date::text AS due_date FROM payments WHERE reversal_id = $1`, [rec.id])).rows[0]
    const { settleManualRentPayment } = await import('../services/manualPaymentSettle')
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await settleManualRentPayment(c as any, {
        payment: again, method: 'cash', settledAt: null, settleHousehold: true, amountTendered: 1000, source: 'desk',
      })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    // Never cancelled: the $1,000 paid out is still asked back (the cash at the desk is the rent).
    expect((await db.query<any>(`SELECT outcome, recovery_status FROM payment_reversals WHERE id = $1`, [rec.id])).rows[0])
      .toEqual({ outcome: 'tenant_paid', recovery_status: 'pending' })
    expect(await recoveryOwed(h.landlordId)).toBe(1000)
  })
})

// ── Fix pass 2 (review): an inquiry moves no money ───────────────────────────
// charge.dispute.created also fires for a bank's INQUIRY (warning_needs_response
// / warning_under_review): Stripe takes nothing back, so nothing may reopen,
// be withheld or be asked of the landlord. Only when it becomes a dispute does
// the reversal run — once for that dispute, whatever event brings it.

function disputeWithStatus(pi: string, cents: number, status: string, eventId: string, type = 'charge.dispute.created') {
  const ev = dispute(pi, cents, eventId)
  return { ...ev, type, data: { object: { ...ev.data.object, status } } }
}
const recordsOn = async (pi: string) => (await db.query<any>(
  `SELECT pr.stripe_event_id, pr.reversed_amount::float AS lost FROM payment_reversals pr
     JOIN payments p ON p.id = pr.payment_id WHERE p.stripe_payment_intent_id = $1 ORDER BY pr.created_at`, [pi])).rows

describe('Fix pass 2 — an inquiry moves no money', () => {
  it('an inquiry reopens nothing and asks the landlord for nothing', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_inq_only', [rent], 1000)
    expect(await batchOwed(h.landlordId)).toBe(1000)
    expect((await post(disputeWithStatus('pi_inq_only', 100600, 'warning_needs_response', 'evt_inq_only'))).status).toBe(200)
    // Nothing reversed: no record, the bill stays paid, no fee billed, the landlord's share untouched.
    expect(await recordsOn('pi_inq_only')).toEqual([])
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('settled')
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'RETURNFEE'`)).rowCount).toBe(0)
    expect(await batchOwed(h.landlordId)).toBe(1000)
    expect(await recoveryOwed(h.landlordId)).toBe(0)
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE source_type = 'dispute'`)).rowCount).toBe(0)
    // An admin is told once, in plain words, and nothing critical is raised.
    const told = await notesOf('dispute_inquiry_open')
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe('A bank inquiry was opened on a tenant payment (pi_inq_only)')
    expect(told[0].body).toContain('Stripe has not taken any money back, so no bill was reopened')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE severity = 'critical'`)).rowCount).toBe(0)
    // The inquiry under review (another event for it) changes nothing and tells no one again.
    expect((await post(disputeWithStatus('pi_inq_only', 100600, 'warning_under_review', 'evt_inq_only_2', 'charge.dispute.updated'))).status).toBe(200)
    expect(await recordsOn('pi_inq_only')).toEqual([])
    expect(await notesOf('dispute_inquiry_open')).toHaveLength(1)
  })

  // Fix pass (rev9): renamed from 'an inquiry that becomes a dispute reverses
  // once' — it called handlePaymentReversal by hand after each event, which
  // hid that the webhook itself never reversed on charge.dispute.updated. Now
  // every event goes through the real webhook route only.
  it('an inquiry that escalates through the webhook reverses exactly once, whatever events follow', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_inq_up', [rent], 1000)
    expect((await post(disputeWithStatus('pi_inq_up', 100600, 'warning_needs_response', 'evt_inq_up_0'))).status).toBe(200)
    expect(await recordsOn('pi_inq_up')).toEqual([])
    // The bank turns it into a dispute: charge.dispute.updated reverses it.
    expect((await post(disputeWithStatus('pi_inq_up', 100600, 'needs_response', 'evt_inq_up_1', 'charge.dispute.updated'))).status).toBe(200)
    expect(await recordsOn('pi_inq_up')).toEqual([{ stripe_event_id: 'evt_inq_up_1', lost: 1000 }])
    expect((await db.query<any>(`SELECT amount::float AS a, status FROM payments WHERE reversal_id IS NOT NULL`)).rows)
      .toEqual([{ a: 1000, status: 'pending' }])
    // Later events for the same dispute (funds withdrawn, under review, lost) change nothing.
    for (const [status, id, type] of [
      ['needs_response', 'evt_inq_up_2', 'charge.dispute.funds_withdrawn'],
      ['under_review', 'evt_inq_up_3', 'charge.dispute.updated'],
      ['lost', 'evt_inq_up_4', 'charge.dispute.closed'],
    ] as const) {
      expect((await post(disputeWithStatus('pi_inq_up', 100600, status, id, type))).status).toBe(200)
    }
    expect(await recordsOn('pi_inq_up')).toEqual([{ stripe_event_id: 'evt_inq_up_1', lost: 1000 }])
    expect((await db.query<any>(`SELECT amount::float AS a FROM payments WHERE reversal_id IS NOT NULL`)).rows).toEqual([{ a: 1000 }])
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'RETURNFEE'`)).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM notifications WHERE type = 'rent_reversed'`)).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE severity = 'critical'`)).rowCount).toBe(0)
    // A stale inquiry event delivered late never rolls the dispute on file back.
    expect((await post(disputeWithStatus('pi_inq_up', 100600, 'warning_needs_response', 'evt_inq_up_5'))).status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM connect_disputes WHERE stripe_dispute_id = 'du_pi_inq_up'`)).rows[0].status).toBe('lost')
    expect(await recordsOn('pi_inq_up')).toEqual([{ stripe_event_id: 'evt_inq_up_1', lost: 1000 }])
  })

  it('an inquiry first heard of at its close (warning_closed) reopens nothing and asks no one to answer it', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_inq_closed', [rent], 1000)
    expect((await post(disputeWithStatus('pi_inq_closed', 100600, 'warning_closed', 'evt_inq_closed', 'charge.dispute.closed'))).status).toBe(200)
    expect(await recordsOn('pi_inq_closed')).toEqual([])
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('settled')
    expect(await notesOf('dispute_inquiry_open')).toEqual([])
    expect(await notesOf('dispute_won_undo_by_hand')).toEqual([])
    expect((await db.query(`SELECT 1 FROM admin_notifications`)).rowCount).toBe(0)
  })

  it('the event that takes the money without Stripe\'s fee passes on $15; a later event of the same dispute that says a different fee tells an admin once, and changes nothing else', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_fee_late', [rent], 1000)
    const noFee = disputeWithStatus('pi_fee_late', 100600, 'needs_response', 'evt_fee_late_1', 'charge.dispute.updated')
    ;(noFee.data.object as any).balance_transactions = []
    expect((await post(noFee)).status).toBe(200)
    expect(await returnFees()).toEqual([{ a: 15, status: 'pending' }])
    expect(await notesOf('dispute_fee_differs')).toEqual([])
    // Stripe's funds_withdrawn says its fee was $20.
    const withdrawn = disputeWithStatus('pi_fee_late', 100600, 'needs_response', 'evt_fee_late_2', 'charge.dispute.funds_withdrawn')
    ;(withdrawn.data.object as any).balance_transactions = [{ fee: 2000 }]
    expect((await post(withdrawn)).status).toBe(200)
    const told = await notesOf('dispute_fee_differs')
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain("Stripe's fee is $20.00, but $15.00 was billed to the tenant (the dispute fee line)")
    expect(told[0].body).toContain('Correct that line by $5.00 (up)')
    // Nothing else moved; the same fee said again tells no one again.
    expect(await returnFees()).toEqual([{ a: 15, status: 'pending' }])
    expect(await recordsOn('pi_fee_late')).toEqual([{ stripe_event_id: 'evt_fee_late_1', lost: 1000 }])
    const again = disputeWithStatus('pi_fee_late', 100600, 'under_review', 'evt_fee_late_3', 'charge.dispute.updated')
    ;(again.data.object as any).balance_transactions = [{ fee: 2000 }]
    expect((await post(again)).status).toBe(200)
    expect(await notesOf('dispute_fee_differs')).toHaveLength(1)
  })

  it('a later event that says the same fee as was passed on tells no one', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_fee_same', [rent], 1000)
    expect((await post(dispute('pi_fee_same', 100600))).status).toBe(200)
    expect((await post(disputeWithStatus('pi_fee_same', 100600, 'needs_response', 'evt_fee_same_2', 'charge.dispute.funds_withdrawn'))).status).toBe(200)
    expect(await notesOf('dispute_fee_differs')).toEqual([])
  })

  it('a register sale\'s chargeback netted with the $15 fallback, then Stripe says $20: an admin is told to correct the payee\'s line', async () => {
    const h = await household()
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, stripe_payment_intent_id)
       VALUES ($1, $2, 'card', 100, 103.8, 'pi_reg_fee_late')`, [h.landlordId, h.landlordUserId])
    const first = disputeWithStatus('pi_reg_fee_late', 10380, 'needs_response', 'evt_reg_fee_1')
    ;(first.data.object as any).balance_transactions = []
    expect((await post(first)).status).toBe(200)
    const later = disputeWithStatus('pi_reg_fee_late', 10380, 'needs_response', 'evt_reg_fee_2', 'charge.dispute.funds_withdrawn')
    ;(later.data.object as any).balance_transactions = [{ fee: 2000 }]
    expect((await post(later)).status).toBe(200)
    const told = await notesOf('dispute_fee_differs')
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain("but $15.00 was netted from the payee's payout (the chargeback line)")
  })

  it('a dispute first heard of at its close (lost) reverses once through the webhook', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_lost_only', [rent], 1000)
    expect((await post(disputeWithStatus('pi_lost_only', 100600, 'lost', 'evt_lost_only', 'charge.dispute.closed'))).status).toBe(200)
    expect(await recordsOn('pi_lost_only')).toEqual([{ stripe_event_id: 'evt_lost_only', lost: 1000 }])
  })

  it('a dispute Stripe already decided for the payer\'s bank changes nothing when its status is not one that holds money (won)', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_inq_won', [rent], 1000)
    const r = await handlePaymentReversal({
      paymentIntentId: 'pi_inq_won', reversalType: 'card_dispute', reversedAmount: 1006, reversalFee: 15,
      stripeEventId: 'evt_inq_won', stripeObjectId: 'du_pi_inq_won', disputeStatus: 'won', rawEvent: {},
    })
    expect(r).toMatchObject({ handled: false, reason: 'no_money_taken' })
    expect(await recordsOn('pi_inq_won')).toEqual([])
  })
})

// ── Fix pass 2 (review): a repayment taken back off the bill ─────────────────
// Only a bank-deposit match can take a recorded payment back off a bill. When
// it took off a cash repayment of a reopened charge, the record's resolution
// no longer stands: a later real repayment resolves it afresh, never swallowed.

describe('Fix pass 2 — a stale resolution never swallows a real repayment', () => {
  it('a reopened rent bill paid in cash, taken back off the bill, then paid online: GAM keeps the online payment once and the landlord\'s recovery is cancelled', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_stale_cash', [rent], 1000)
    await payoutRuns(h)
    expect((await post(dispute('pi_stale_cash', 100600))).status).toBe(200)
    const rec = (await db.query<any>(`SELECT id FROM payment_reversals WHERE payment_id = $1`, [rent])).rows[0]
    const again = (await db.query<any>(
      `SELECT id, landlord_id, tenant_id, unit_id, lease_id, due_date::text AS due_date FROM payments WHERE reversal_id = $1`, [rec.id])).rows[0]
    const { settleManualRentPayment } = await import('../services/manualPaymentSettle')
    const { resolveReversalOnTenantPayment } = await import('../services/paymentReversal')
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await settleManualRentPayment(c as any, {
        payment: again, method: 'cash', settledAt: null, settleHousehold: true, amountTendered: 1000, source: 'desk',
      })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect((await db.query<any>(`SELECT outcome FROM payment_reversals WHERE id = $1`, [rec.id])).rows[0].outcome).toBe('tenant_paid')
    // The cash is taken back off the bill (as a bank-deposit match undone does): owed again.
    await db.query(`UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL WHERE id = $1`, [again.id])
    // The tenant pays it online: the success path settles the row and resolves its record.
    const c2 = await getClient()
    let reDisburse: boolean
    try {
      await c2.query('BEGIN')
      await c2.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [again.id])
      reDisburse = await resolveReversalOnTenantPayment(c2 as any, rec.id)
      // A second call for the same repayment in the same transaction changes nothing.
      expect(await resolveReversalOnTenantPayment(c2 as any, rec.id)).toBe(reDisburse)
      await c2.query('COMMIT')
    } catch (e) { await c2.query('ROLLBACK'); throw e } finally { c2.release() }
    // GAM keeps the online repayment (it makes GAM whole), so the landlord is no longer asked for the $1,000.
    expect(reDisburse).toBe(false)
    expect((await db.query<any>(`SELECT outcome, recovery_status, status FROM payment_reversals WHERE id = $1`, [rec.id])).rows[0])
      .toEqual({ outcome: 'tenant_paid', recovery_status: 'not_needed', status: 'resolved' })
    expect(await recoveryOwed(h.landlordId)).toBe(0)
  })
})

const r2 = (n: number) => Math.round(n * 100) / 100

// ── A dispute GAM wins (decisions #55, as AMENDED 10/4 ~midnight) ───────────
// "For this deploy, a won dispute is NOT undone automatically. The webhook
// raises ONE critical admin notice per won dispute, listing exactly what to
// undo by hand (the reopened rows to void, the landlord share to give back,
// credit to restore, fees), with amounts. Undoing it automatically is a
// follow-up." Each test checks nothing changed by itself and what the notice
// lists, then runs the follow-up's undo directly (followUpUndo) to keep its
// coverage and to check it does what the notice listed.

/** charge.dispute.closed (won) for the dispute dispute(pi) opened; Stripe gives back the money and `feeBack` cents of its fee. */
function won(pi: string, cents: number, o: { eventId?: string; feeBack?: number; type?: string; disputeId?: string } = {}) {
  return {
    id: o.eventId ?? 'evt_won_' + pi, type: o.type ?? 'charge.dispute.closed',
    data: { object: { id: o.disputeId ?? 'du_' + pi, object: 'dispute', charge: 'ch_' + pi, payment_intent: pi, amount: cents,
      currency: 'usd', status: 'won', reason: 'fraudulent',
      balance_transactions: [{ amount: -cents, fee: 1500 }, { amount: cents, fee: -(o.feeBack ?? 1500) }] } },
  }
}
const owedNow = async (h: H) => (await db.query<any>(
  `SELECT COALESCE(SUM(amount), 0)::float AS s FROM payments
    WHERE tenant_id = $1 AND status IN ('pending', 'failed') AND revenue_owner = 'landlord'`, [h.tenantId])).rows[0].s
const usablePaidAhead = async (h: H) => (await db.query<any>(
  `SELECT COALESCE(SUM(${usablePaidAheadSql('c', 'dc')}), 0)::float AS s
     FROM lease_prepaid_credits c ${disputeClaimJoinSql('c', 'dc')} WHERE c.lease_id = $1`, [h.leaseId])).rows[0].s
const wonLines = async () => (await db.query<any>(
  `SELECT amount::float AS a FROM held_payout_items WHERE source_id LIKE 'owner\\_share\\_returned\\_on\\_win:%' ORDER BY amount DESC`)).rows
async function invoiceFor(h: H, rowIds: string[]): Promise<string> {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
     VALUES ($1,$2,$3,$4,$5,'2026-10-01',1000,1050) RETURNING id`,
    [h.landlordId, h.tenantId, h.leaseId, h.unitId, `W-${Math.random().toString(36).slice(2, 10)}`])).rows[0].id
  await db.query(`UPDATE payments SET invoice_id = $2 WHERE id = ANY($1::uuid[])`, [rowIds, inv])
  return inv
}

/** Decisions #55-AMENDED: the one critical notice a won dispute raises (what to undo by hand). */
const wonNotices = async () => notesOf('dispute_won_undo_by_hand')
/** Critical notices other than the won-dispute notice. */
const otherCriticals = async () => (await db.query(
  `SELECT 1 FROM admin_notifications WHERE severity = 'critical' AND category <> 'dispute_won_undo_by_hand'`)).rowCount
/**
 * The automatic undo (paymentReversal.undoWonDispute) is a follow-up and is NOT
 * called by the webhook in this deploy (decisions #55-AMENDED). These tests run
 * it directly after the win, so the follow-up keeps its coverage and its
 * result can be checked against what the notice listed.
 */
async function followUpUndo(pi: string, o: { feeBack?: number; disputeId?: string; eventId?: string } = {}) {
  const { undoWonDispute } = await import('../services/paymentReversal')
  return undoWonDispute({
    stripeDisputeId: o.disputeId ?? 'du_' + pi, stripeEventId: o.eventId ?? 'evt_won_' + pi,
    paymentIntentId: pi, feeReturnedCents: o.feeBack ?? 1500,
  })
}

describe('Decisions #55-AMENDED — a dispute GAM wins is undone by hand from one critical notice', () => {
  it('won before the payout: nothing is undone by itself, and one critical notice lists the reopened bills to void, the withheld share and card fee to give back, the dispute fee and the late fee — with amounts', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    const water = await row(h, { amount: 50, type: 'utility' })
    const inv = await invoiceFor(h, [rent, water])
    await payByBank(h, 'pi_won_all', [rent, water], 1050)
    expect(await batchOwed(h.landlordId)).toBe(1050)

    expect((await post(dispute('pi_won_all', 105600))).status).toBe(200)
    expect(await batchOwed(h.landlordId)).toBe(0)                       // the shares are withheld
    expect(await owedNow(h)).toBe(1050)
    expect(await keptFeeLines()).toEqual([{ a: -6 }])                   // the bank fee came off the landlord
    // The back-fill a reopened bill earns (written here as the late-fee run would).
    const late = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, invoice_id)
       VALUES ($1,$2,$3,$4,'late_fee',25,'pending','LATEFEE','2026-10-06',$5) RETURNING id`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId, inv])).rows[0].id

    expect((await post(won('pi_won_all', 105600))).status).toBe(200)
    // Nothing undone by itself: still owed, still withheld, no line given back, the fee still billed.
    expect(await owedNow(h)).toBe(1075)
    expect(await batchOwed(h.landlordId)).toBe(0)
    expect(await wonLines()).toEqual([])
    expect(await keptFeeLines()).toEqual([{ a: -6 }])
    expect(await returnFees()).toEqual([{ a: 15, status: 'pending' }])
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = ANY($1::uuid[])`, [[rent, water]])).rows)
      .toEqual([{ status: 'returned' }, { status: 'returned' }])
    expect(await notesOf('dispute_won_undone')).toHaveLength(0)
    expect((await db.query<any>(`SELECT status FROM connect_disputes WHERE stripe_dispute_id = 'du_pi_won_all'`)).rows[0].status).toBe('won')
    // ONE critical notice: every step, by name, with its amount.
    const told = await wonNotices()
    expect(told).toHaveLength(1)
    expect(told[0].title).toMatch(/^A dispute was won: undo \d+ things by hand \(pi_won_all\)$/)
    const body: string = told[0].body
    expect(body).toContain('Stripe decided dispute du_pi_won_all for GAM and put back $1056.00 on payment pi_won_all, with $15.00 of its $15.00 dispute fee.')
    expect(body).toContain('GAM does not undo a won dispute by itself yet: nothing was changed.')
    expect(body).toMatch(/Void the reopened rent charge of \$1000\.00 \(line [0-9a-f-]+\): Test Tenant no longer owes it\./)
    expect(body).toMatch(/Void the reopened utility charge of \$50\.00 \(line [0-9a-f-]+\): Test Tenant no longer owes it\./)
    expect(body).toContain(`Mark the disputed rent line paid again (line ${rent}, $1000.00 of it was taken back).`)
    expect(body).toContain(`Mark the disputed utility line paid again (line ${water}, $50.00 of it was taken back).`)
    expect(body).toContain('Give Test Landlord back $1000.00 that was withheld from or netted out of their payout for the disputed rent')
    expect(body).toContain('Give Test Landlord back $50.00 that was withheld from or netted out of their payout for the disputed utility')
    expect(body).toContain(`Give Test Landlord back the $6.00 card or bank fee taken off their payout for the disputed payment (a positive payout line with source id stripe_fee_kept:pi_won_all:${h.landlordId}:returned_on_win).`)
    expect(body).toMatch(/Void the \$15\.00 dispute fee billed to Test Tenant \(line [0-9a-f-]+\): Stripe gave its fee back\./)
    expect(body).toContain(`Check the $25.00 late fee for 2026-10-06 (line ${late})`)
    expect(body).not.toContain('Call off')                              // before the payout nothing is still asked of the landlord
    expect(body).toContain('GAM absorbs none of it.')
    expect(told[0].context).toMatchObject({
      stripe_dispute_id: 'du_pi_won_all', stripe_payment_intent_id: 'pi_won_all', disputed: 1056, dispute_fee: 15, dispute_fee_returned: 15,
      give_back: { 'Test Landlord': 1056 }, recovery_to_call_off: {}, credit_to_restore: 0, fee_to_take_off: 15, fee_kept_unbilled: 0,
    })
    expect([...told[0].context.rows_to_mark_paid].sort()).toEqual([rent, water].sort())
    expect(told[0].context.rows_to_void.map((r: any) => r.amount).sort()).toEqual([1000, 50].sort())
    expect(await otherCriticals()).toBe(0)

    // The win again (funds reinstated, another event) and a stale "needs response" change nothing and tell no one again.
    expect((await post(won('pi_won_all', 105600, { eventId: 'evt_won_again', type: 'charge.dispute.funds_reinstated' }))).status).toBe(200)
    expect((await post(dispute('pi_won_all', 105600, 'evt_stale_after_win'))).status).toBe(200)
    expect(await wonNotices()).toHaveLength(1)
    expect(await owedNow(h)).toBe(1075)
    expect(await wonLines()).toEqual([])
    expect((await db.query<any>(`SELECT status FROM connect_disputes WHERE stripe_dispute_id = 'du_pi_won_all'`)).rows[0].status).toBe('won')

    // The follow-up's undo (not wired) does exactly what the notice listed.
    const undone = await followUpUndo('pi_won_all')
    expect(undone.handled).toBe(true)
    expect(undone.landlordGivenBack).toEqual({ [h.landlordId]: 1050 })
    expect(undone.feeLinesGivenBack).toBe(6)
    expect(undone.voidedRows).toHaveLength(3)                             // the two reopened bills and the dispute fee
    expect(undone.lateFeesVoided).toEqual([late])
    const again = (await db.query<any>(`SELECT amount::float AS a, status FROM payments WHERE reversal_id IS NOT NULL ORDER BY amount DESC`)).rows
    expect(again).toEqual([{ a: 1000, status: 'voided' }, { a: 50, status: 'voided' }])
    expect(await owedNow(h)).toBe(0)
    expect((await db.query<any>(`SELECT status FROM invoices WHERE id = $1`, [inv])).rows[0].status).toBe('settled')
    expect(await wonLines()).toEqual([{ a: 1000 }, { a: 50 }])
    expect(await batchOwed(h.landlordId)).toBe(1050)
    expect((await keptFeeLines()).reduce((s: number, x: any) => s + x.a, 0)).toBe(0)
    expect(await returnFees()).toEqual([{ a: 15, status: 'voided' }])
    expect((await followUpUndo('pi_won_all')).reason).toBe('already_undone')
  })

  it('won after the payout: the notice names what the Tuesday batch netted to give back, and the recovery still owed to call off', async () => {
    // Netted already.
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_netted', [rent], 1000)
    await payoutRuns(h)
    expect((await post(dispute('pi_won_netted', 100600))).status).toBe(200)
    expect(await recoveryOwed(h.landlordId)).toBe(1000)
    // The batch nets it (as landlordPassthrough.applyReversalNetting records it).
    await db.query(
      `UPDATE payment_reversals SET recovered_amount = reversed_amount, recovery_status = 'recovered', recovery_method = 'netting',
              recovered_at = NOW(), outcome = 'landlord_clawback', late_fee_owner = 'landlord', status = 'resolved', resolved_at = NOW()
        WHERE landlord_id = $1`, [h.landlordId])
    expect((await post(won('pi_won_netted', 100600))).status).toBe(200)
    expect(await wonLines()).toEqual([])
    expect(await owedNow(h)).toBe(1000)
    const netted = (await wonNotices())[0]
    expect(netted.body).toContain('Give Test Landlord back $1000.00 that was withheld from or netted out of their payout for the disputed rent')
    expect(netted.body).not.toContain('Call off')
    expect(netted.context.give_back).toEqual({ 'Test Landlord': 1006 })   // the share and the $6 bank fee

    // Not netted yet: nothing was taken from the landlord, so nothing to give back — the ask is to be called off.
    const h2 = await household()
    const rent2 = await row(h2, { amount: 1000 })
    await payByBank(h2, 'pi_won_pending', [rent2], 1000)
    await payoutRuns(h2)
    expect((await post(dispute('pi_won_pending', 100600))).status).toBe(200)
    expect(await recoveryOwed(h2.landlordId)).toBe(1000)
    expect((await post(won('pi_won_pending', 100600))).status).toBe(200)
    expect(await recoveryOwed(h2.landlordId)).toBe(1000)                 // still asked: called off by hand
    const pending = (await wonNotices())[1]
    expect(pending.title).toContain('(pi_won_pending)')
    expect(pending.body).toContain('Call off the $1000.00 still to be asked of Test Landlord for it')
    expect(pending.body).not.toContain('that was withheld from or netted out of')
    expect(pending.context.recovery_to_call_off).toEqual({ 'Test Landlord': 1000 })

    // The follow-up's undo agrees.
    expect((await followUpUndo('pi_won_netted')).landlordGivenBack).toEqual({ [h.landlordId]: 1000 })
    await followUpUndo('pi_won_pending')
    expect(await recoveryOwed(h2.landlordId)).toBe(0)
    expect((await db.query<any>(`SELECT recovery_status, status FROM payment_reversals WHERE landlord_id = $1`, [h2.landlordId])).rows)
      .toEqual([{ recovery_status: 'not_needed', status: 'resolved' }])
    expect(await wonLines()).toEqual([{ a: 1000 }])                     // only the first landlord's
    expect(await owedNow(h2)).toBe(0)
  })

  it('won on a charge that banked paid-ahead money: the notice names the spend to mark paid again and only the unspent money to restore — never both', async () => {
    const h = await household()
    const oct = await row(h, { amount: 1000, due: '2026-10-01' })
    const nov = await row(h, { amount: 200, due: '2026-11-01' })
    await db.query(`UPDATE payments SET stripe_payment_intent_id = NULL WHERE id = $1`, [nov])
    await payByBank(h, 'pi_won_surplus', [oct], 1300, { surplus: 300 })
    await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId })
    await payoutRuns(h)
    expect(await usablePaidAhead(h)).toBe(100)
    expect((await post(dispute('pi_won_surplus', 130600))).status).toBe(200)
    expect(await usablePaidAhead(h)).toBe(0)
    expect(await owedNow(h)).toBe(1200)

    expect((await post(won('pi_won_surplus', 130600))).status).toBe(200)
    expect(await owedNow(h)).toBe(1200)                                  // nothing undone by itself
    expect(await usablePaidAhead(h)).toBe(0)
    const body: string = (await wonNotices())[0].body
    expect(body).toMatch(new RegExp(`The dispute undid \\$200\\.00 of spends of paid-ahead credit [0-9a-f-]+ \\(lines ${nov}\\): mark those lines paid by that credit again`))
    expect(body).toMatch(/Restore \$100\.00 of paid-ahead money to Test Tenant that the dispute took off credit [0-9a-f-]+/)
    expect((await wonNotices())[0].context.credit_to_restore).toBe(100)

    // The follow-up's undo agrees: both bills paid again, $100 back, never the $200 too.
    const undone = await followUpUndo('pi_won_surplus')
    expect(undone.creditRestored).toBe(100)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = ANY($1::uuid[]) ORDER BY due_date`, [[oct, nov]])).rows)
      .toEqual([{ status: 'settled' }, { status: 'settled' }])
    expect(await owedNow(h)).toBe(0)
    expect(await usablePaidAhead(h)).toBe(100)
    expect(await recoveryOwed(h.landlordId)).toBe(0)
  })

  it('won after the tenant paid the reopened bill again: the notice says they paid twice and to save it as their paid-ahead money, and leaves the landlord as that payment squared them', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_repaid', [rent], 1000)
    expect((await post(dispute('pi_won_repaid', 100600))).status).toBe(200)
    const again = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id IS NOT NULL`)).rows[0].id
    await payByBank(h, 'pi_repays', [again], 1000)
    const owedToLandlord = await batchOwed(h.landlordId)

    expect((await post(won('pi_won_repaid', 100600))).status).toBe(200)
    expect(await usablePaidAhead(h)).toBe(0)                             // nothing saved by itself
    const n = (await wonNotices())[0]
    expect(n.body).toContain(`Test Tenant already paid the reopened rent charge again ($1000.00, line ${again}), and the card company gave the first payment back too: save $1000.00 as their paid-ahead money.`)
    expect(n.body).not.toContain('Mark the disputed rent line paid again')
    expect(n.body).not.toContain('withheld from or netted out of')
    expect(n.context.credit_to_restore).toBe(1000)

    await followUpUndo('pi_won_repaid')
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('returned')
    expect(await usablePaidAhead(h)).toBe(1000)
    expect(await wonLines()).toEqual([])
    expect(await batchOwed(h.landlordId)).toBe(owedToLandlord)
    expect(await owedNow(h)).toBe(0)
  })

  it('after a won dispute undone by hand, a later dispute of the same charge takes its whole money again (the won one counts for nothing)', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_then', [rent], 1000)
    expect((await post(dispute('pi_won_then', 100600))).status).toBe(200)
    expect((await post(won('pi_won_then', 100600))).status).toBe(200)
    await followUpUndo('pi_won_then')                                     // stands in for the undo by hand
    expect(await owedNow(h)).toBe(0)
    const second = { id: 'evt_second_dispute', type: 'charge.dispute.created',
      data: { object: { id: 'du_second', object: 'dispute', charge: 'ch_pi_won_then', payment_intent: 'pi_won_then', amount: 100600,
        currency: 'usd', status: 'needs_response', reason: 'fraudulent', balance_transactions: [{ fee: 1500 }] } } }
    expect((await post(second)).status).toBe(200)
    const rows = await reopenedRows('evt_second_dispute')
    expect(rows.map((r: any) => [r.orig, r.lost, r.orig_status, r.new_amount, r.new_status])).toEqual([[rent, 1000, 'returned', 1000, 'pending']])
    expect(await owedNow(h)).toBe(1000)
    // Its card fee cannot ride the line handed back for the win: told to an admin, never absorbed in silence.
    expect(await notesOf('dispute_fee_after_win_unnetted')).toHaveLength(1)
  })

  it('a register sale: an inquiry nets nobody, the dispute nets the payee once, and a win names the sale and the dispute fee Stripe returned to give back by hand — no line written', async () => {
    const h = await household()
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, stripe_payment_intent_id)
       VALUES ($1, $2, 'card', 100, 103.8, 'pi_reg_sale')`, [h.landlordId, h.landlordUserId])
    const lines = async () => (await db.query<any>(
      `SELECT source_id, amount::float AS a FROM held_payout_items WHERE source_type = 'dispute' ORDER BY created_at, source_id`)).rows
    expect((await post(disputeWithStatus('pi_reg_sale', 10380, 'warning_needs_response', 'evt_reg_inq'))).status).toBe(200)
    expect(await lines()).toEqual([])
    expect((await post(disputeWithStatus('pi_reg_sale', 10380, 'needs_response', 'evt_reg_up', 'charge.dispute.updated'))).status).toBe(200)
    expect((await post(disputeWithStatus('pi_reg_sale', 10380, 'under_review', 'evt_reg_up2', 'charge.dispute.updated'))).status).toBe(200)
    expect(await lines()).toEqual([{ source_id: 'du_pi_reg_sale', a: -118.8 }])
    expect((await post(won('pi_reg_sale', 10380))).status).toBe(200)
    expect((await post(won('pi_reg_sale', 10380, { eventId: 'evt_reg_won_2', type: 'charge.dispute.funds_reinstated' }))).status).toBe(200)
    expect(await lines()).toEqual([{ source_id: 'du_pi_reg_sale', a: -118.8 }])
    const told = await wonNotices()
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain('Give Test Landlord back $118.80 of the $118.80 chargeback taken off their payout ($103.80 of the sale and the $15.00 dispute fee Stripe returned; a positive payout line with source id du_pi_reg_sale:returned_on_win).')
    expect(told[0].context.give_back).toEqual({ 'Test Landlord': 118.8 })
  })

  it('a won chargeback whose dispute fee Stripe kept: the notice says that part stays with the payee', async () => {
    const h = await household()
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, stripe_payment_intent_id)
       VALUES ($1, $2, 'card', 100, 103.8, 'pi_reg_kept')`, [h.landlordId, h.landlordUserId])
    expect((await post(dispute('pi_reg_kept', 10380))).status).toBe(200)
    expect((await post(won('pi_reg_kept', 10380, { feeBack: 0 }))).status).toBe(200)
    const body: string = (await wonNotices())[0].body
    expect(body).toContain('Give Test Landlord back $103.80 of the $118.80 chargeback taken off their payout ($103.80 of the sale;')
    expect(body).toContain('Stripe kept $15.00 of its dispute fee: that part stays with them.')
  })

  it('a dispute GAM never reversed (the money-taken events were lost) won with its fee kept: the notice names the fee nobody was billed, so GAM never absorbs it in silence', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_unseen', [rent], 1000)
    expect((await post(won('pi_won_unseen', 100600, { feeBack: 0 }))).status).toBe(200)
    expect(await recordsOn('pi_won_unseen')).toEqual([])
    const n = (await wonNotices())[0]
    expect(n.title).toBe('A dispute was won: undo 1 thing by hand (pi_won_unseen)')
    expect(n.body).toContain('Stripe kept $15.00 of its dispute fee, and nothing billed it to anyone for this dispute.')
    expect(n.context.fee_kept_unbilled).toBe(15)
  })

  it('a won dispute with nothing to undo still raises its one notice, saying so', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_nothing', [rent], 1000)
    expect((await post(won('pi_won_nothing', 100600))).status).toBe(200)
    const n = await wonNotices()
    expect(n).toHaveLength(1)
    expect(n[0].title).toBe('A dispute was won: nothing to undo (pi_won_nothing)')
    expect(n[0].body).toContain('No bill was reopened and nothing was taken from anyone for it, so there is nothing to undo.')
  })

  it('two won events for one dispute at the same moment raise exactly one notice', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_twice', [rent], 1000)
    expect((await post(dispute('pi_won_twice', 100600))).status).toBe(200)
    const [a, b] = await Promise.all([
      post(won('pi_won_twice', 100600)),
      post(won('pi_won_twice', 100600, { eventId: 'evt_won_twice_2', type: 'charge.dispute.funds_reinstated' })),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(await wonNotices()).toHaveLength(1)
  })
})

describe('Fix pass (rev9) — a dispute put off answers 503 so Stripe delivers it again', () => {
  it('"try again in a moment" writes nothing, raises no critical alert, and the redelivery reverses it', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_later', [rent], 1000)
    const { DisputeRetryLater } = await import('../services/creditUse')
    clawOverride.fn = async () => { throw new DisputeRetryLater('refund_part_busy', 'A refund of this money was being sent at that same moment — try again in a moment.') }
    try {
      expect((await post(dispute('pi_later', 100600))).status).toBe(503)
    } finally { clawOverride.fn = null }
    expect(await recordsOn('pi_later')).toEqual([])
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE severity = 'critical'`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'webhook_dispute_handler_failed'`)).rowCount).toBe(0)
    expect((await post(dispute('pi_later', 100600))).status).toBe(200)
    expect(await recordsOn('pi_later')).toEqual([{ stripe_event_id: 'evt_dispute_pi_later', lost: 1000 }])
  })
})

// ── Fix pass (rev9, decisions #55): undoing a bank-deposit match that paid a reopened charge ──

async function bankDeposit(h: H, amount: number): Promise<string> {
  const conn = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`, [h.landlordId])).rows[0].id
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
     VALUES ($1,$2,$3,CURRENT_DATE,$4,'MOBILE DEPOSIT','needs_review') RETURNING id`,
    [conn, h.landlordId, `ext_${Math.random().toString(36).slice(2)}`, amount.toFixed(2)])).rows[0].id
}

describe('Fix pass (rev9) — a bank deposit match that paid a reopened charge, undone', () => {
  it('a reopened rent bill: the undo puts the reversal back as the dispute left it, and a later online payment is kept by GAM once', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_bank_undo', [rent], 1000)
    await payoutRuns(h)
    expect((await post(dispute('pi_bank_undo', 100600))).status).toBe(200)
    const rec = (await db.query<any>(`SELECT id FROM payment_reversals WHERE payment_id = $1`, [rent])).rows[0].id
    const again = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id = $1`, [rec])).rows[0].id
    const txn = await bankDeposit(h, 1000)
    const { confirmDepositMatch, undoDepositMatch } = await import('../services/bankDepositConfirm')
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [again], method: 'check' })
    expect((await db.query<any>(`SELECT outcome, late_fee_owner FROM payment_reversals WHERE id = $1`, [rec])).rows[0])
      .toEqual({ outcome: 'tenant_paid', late_fee_owner: 'landlord' })

    await undoDepositMatch({ bankTransactionId: txn, landlordId: h.landlordId, undoneBy: null })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [again])).rows[0].status).toBe('pending')
    // Back as the dispute left it: the $1,000 paid out is still asked of the landlord.
    expect((await db.query<any>(`SELECT outcome, late_fee_owner, status FROM payment_reversals WHERE id = $1`, [rec])).rows[0])
      .toEqual({ outcome: null, late_fee_owner: null, status: 'recovering' })
    expect(await recoveryOwed(h.landlordId)).toBe(1000)
    // The tenant pays it online: GAM keeps it (it makes GAM whole) and the landlord is asked for nothing more.
    await payByBank(h, 'pi_bank_undo_repay', [again], 1000)
    expect((await db.query<any>(`SELECT outcome, recovery_status FROM payment_reversals WHERE id = $1`, [rec])).rows[0])
      .toEqual({ outcome: 'tenant_paid', recovery_status: 'not_needed' })
    expect(await recoveryOwed(h.landlordId)).toBe(0)
  })

  it('a reopened move-out deposit charge: the undo gives the refill back, so the landlord is never charged for cash they did not get', async () => {
    const h = await household()
    const c = await getClient()
    let depositId: string
    try {
      depositId = await seedSecurityDeposit(c as any, { unitId: h.unitId, leaseId: h.leaseId, tenantId: h.tenantId, totalAmount: 500, heldBy: 'gam_escrow' })
    } finally { c.release() }
    await db.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_landlord_undo' WHERE id = $1`, [h.landlordId])
    const pay = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             revenue_owner, settled_at, platform_held, stripe_payment_intent_id, stripe_charge_id)
       VALUES ($1,$2,$3,$4,'deposit',500,'settled',CURRENT_DATE - 30,'DEPOSIT','landlord',NOW() - INTERVAL '30 days',
               TRUE,'pi_dep_undo','ch_pi_dep_undo') RETURNING id`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,500,500,'card','pi_dep_undo','settled')`, [h.tenantId, h.leaseId, h.landlordId])
    const c2 = await getClient()
    let draftId: string
    try {
      draftId = await seedDepositReturnDraft(c2 as any, {
        leaseId: h.leaseId, tenantId: h.tenantId, landlordId: h.landlordId, securityDepositId: depositId!,
        totalDeposit: 500, damageLines: [{ description: 'Broken window', amount: 250 }] })
    } finally { c2.release() }
    const { finalizeDepositReturn } = await import('../services/depositReturn')
    await finalizeDepositReturn(draftId!, h.landlordUserId)
    expect((await post(dispute('pi_dep_undo', 50000))).status).toBe(200)
    const rec = (await db.query<any>(`SELECT id FROM payment_reversals WHERE payment_id = $1`, [pay])).rows[0].id
    const again = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id = $1`, [rec])).rows[0].id
    const refillNet = async () => (await db.query<any>(
      `SELECT COALESCE(SUM(amount), 0)::float AS s FROM held_payout_items WHERE source_id LIKE 'owner\\_share\\_refill%' || $1 || '%'`, [rec])).rows[0].s

    const txn = await bankDeposit(h, 500)
    const { confirmDepositMatch, undoDepositMatch } = await import('../services/bankDepositConfirm')
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [again], method: 'check' })
    expect(await refillNet()).toBe(-250)
    expect((await db.query<any>(`SELECT outcome FROM payment_reversals WHERE id = $1`, [rec])).rows[0].outcome).toBe('tenant_paid')

    await undoDepositMatch({ bankTransactionId: txn, landlordId: h.landlordId, undoneBy: null })
    // The refill is given back on the same payout; the reversal is back as the dispute left it.
    expect(await refillNet()).toBe(0)
    expect((await db.query<any>(`SELECT outcome, status FROM payment_reversals WHERE id = $1`, [rec])).rows[0])
      .toEqual({ outcome: 'landlord_clawback', status: 'resolved' })
    expect((await db.query<any>(`SELECT status, released_by_deposit_return_id IS NULL AS free FROM payments WHERE id = $1`, [again])).rows[0])
      .toEqual({ status: 'pending', free: true })
  })
})

// ── Fix pass (rev9): lock order — payout lock first, then the record ─────────
// The weekly payout takes a landlord's payout lock and then locks their
// reversal records (landlordPassthrough.applyReversalNetting). Undoing a cash
// resolution (and a stale one met by a real repayment) needs both: it must
// take them in the same order, or the two can deadlock.

async function cashResolved(pi: string): Promise<{ h: H; recId: string; againId: string }> {
  const h = await household()
  const rent = await row(h, { amount: 1000 })
  await payByBank(h, pi, [rent], 1000)
  expect((await post(dispute(pi, 100600))).status).toBe(200)
  const recId = (await db.query<any>(`SELECT id FROM payment_reversals WHERE payment_id = $1`, [rent])).rows[0].id
  const again = (await db.query<any>(
    `SELECT id, landlord_id, tenant_id, unit_id, lease_id, due_date::text AS due_date FROM payments WHERE reversal_id = $1`, [recId])).rows[0]
  const { settleManualRentPayment } = await import('../services/manualPaymentSettle')
  const c = await getClient()
  try {
    await c.query('BEGIN')
    await settleManualRentPayment(c as any, { payment: again, method: 'cash', settledAt: null, settleHousehold: true, amountTendered: 1000, source: 'desk' })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  return { h, recId, againId: again.id }
}

/** While the payout lock is held elsewhere, `run` must wait WITHOUT holding the record's row lock. */
async function waitsForPayoutLockFirst(landlordId: string, recId: string, run: (c: any) => Promise<unknown>): Promise<void> {
  const batch = await getClient()
  const worker = await getClient()
  const probe = await getClient()
  try {
    await batch.query('BEGIN')
    await batch.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`platform_held_reconcile:${landlordId}`])
    await worker.query('BEGIN')
    const pending = run(worker)
    await new Promise(r => setTimeout(r, 300))
    // The record is not locked by the waiting worker: the batch could still take it.
    await probe.query('BEGIN')
    await expect(probe.query(`SELECT 1 FROM payment_reversals WHERE id = $1 FOR UPDATE NOWAIT`, [recId])).resolves.toBeTruthy()
    await probe.query('ROLLBACK')
    await batch.query('COMMIT')
    await pending
    await worker.query('COMMIT')
  } catch (e) {
    await batch.query('ROLLBACK').catch(() => {}); await worker.query('ROLLBACK').catch(() => {}); await probe.query('ROLLBACK').catch(() => {})
    throw e
  } finally { batch.release(); worker.release(); probe.release() }
}

describe('Fix pass (rev9) — the payout lock comes before the reversal record', () => {
  it('undoing a cash resolution waits for the weekly payout lock before it locks the record', async () => {
    const x = await cashResolved('pi_lock_undo')
    const { undoTenantPaidResolution } = await import('../services/paymentReversal')
    await waitsForPayoutLockFirst(x.h.landlordId, x.recId, async (c) => {
      await c.query(`UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL WHERE id = $1`, [x.againId])
      await undoTenantPaidResolution(c, x.recId)
    })
    expect((await db.query<any>(`SELECT outcome FROM payment_reversals WHERE id = $1`, [x.recId])).rows[0].outcome).toBe('landlord_clawback')
  })

  it('a stale cash resolution met by a real repayment waits for the payout lock before it locks the record', async () => {
    const x = await cashResolved('pi_lock_resolve')
    await db.query(`UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL WHERE id = $1`, [x.againId])
    const { resolveReversalOnTenantPayment } = await import('../services/paymentReversal')
    await waitsForPayoutLockFirst(x.h.landlordId, x.recId, async (c) => {
      await c.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [x.againId])
      await resolveReversalOnTenantPayment(c, x.recId)
    })
    expect((await db.query<any>(`SELECT outcome, late_fee_owner FROM payment_reversals WHERE id = $1`, [x.recId])).rows[0])
      .toEqual({ outcome: 'tenant_paid', late_fee_owner: 'gam' })
  })
})

// ── Fix pass 2 (rev9 review): a won dispute on a charge that paid no bill,
// the credit a partial dispute left holding money twice, decided disputes stay
// decided, and only the late fees the reopen earned are voided. ──

/** A settled card-or-bank receipt whose money is all paid ahead; `spends` are later bills paid from it. */
async function paidAheadOnly(h: H, pi: string, money: number, spends: Array<{ amount: number; due: string }>) {
  const rem = (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                     payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id, settled_at)
     VALUES ($1,$2,$3,$4,0,$4,'settled','ach',$5,6,$6,NOW()) RETURNING id`,
    [h.tenantId, h.leaseId, h.landlordId, money, money + 6, pi])).rows[0].id
  const c = await getClient()
  let credit: string
  try {
    credit = await createPaidAhead(c as any, { leaseId: h.leaseId, tenantId: h.tenantId, amount: money, fundedBy: 'gam', receivedAt: new Date(), sourceRemittanceId: rem })
  } finally { c.release() }
  const rows: string[] = []
  for (const s of spends) {
    const id = await row(h, { amount: s.amount, due: s.due })
    rows.push(id)
    await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status).toBe('settled')
  }
  return { rem, credit: credit!, rows }
}
const returnFees = async () => (await db.query<any>(`SELECT amount::float AS a, status FROM payments WHERE entry_description = 'RETURNFEE'`)).rows

describe('A won dispute on a charge that paid no bill (decisions #55-AMENDED: by hand, then the follow-up)', () => {
  it('a charge that paid no bill, disputed in full and then won: the notice names the withdrawn paid-ahead money to restore, the dispute fee and the kept card fee — and the follow-up does exactly that, once', async () => {
    const h = await household()
    const { credit } = await paidAheadOnly(h, 'pi_won_norow', 300, [])
    expect((await post(dispute('pi_won_norow', 30600))).status).toBe(200)
    // The dispute withdrew the credit whole (no bill: no record), billed the fee and netted the kept fee.
    expect((await db.query<any>(`SELECT voided_at IS NOT NULL AS v FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].v).toBe(true)
    expect(await usablePaidAhead(h)).toBe(0)
    expect(await returnFees()).toEqual([{ a: 15, status: 'pending' }])
    expect(await keptFeeLines()).toEqual([{ a: -6 }])
    expect((await db.query(`SELECT 1 FROM payment_reversals`)).rowCount).toBe(0)

    expect((await post(won('pi_won_norow', 30600))).status).toBe(200)
    // Nothing by itself.
    expect(await usablePaidAhead(h)).toBe(0)
    expect(await returnFees()).toEqual([{ a: 15, status: 'pending' }])
    expect(await keptFeeLines()).toEqual([{ a: -6 }])
    const told = await wonNotices()
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain(`Restore $300.00 of paid-ahead money to Test Tenant that the dispute took off credit ${credit} (the dispute withdrew it)`)
    expect(told[0].body).toMatch(/Void the \$15\.00 dispute fee billed to Test Tenant/)
    expect(told[0].body).toContain('Give Test Landlord back the $6.00 card or bank fee taken off their payout')
    expect(told[0].context).toMatchObject({ credit_to_restore: 300, fee_to_take_off: 15, give_back: { 'Test Landlord': 6 } })
    // The win again (funds reinstated) tells no one again.
    expect((await post(won('pi_won_norow', 30600, { eventId: 'evt_won_norow_2', type: 'charge.dispute.funds_reinstated' }))).status).toBe(200)
    expect(await wonNotices()).toHaveLength(1)

    // The follow-up's undo, once.
    await followUpUndo('pi_won_norow')
    expect(await usablePaidAhead(h)).toBe(300)
    expect(await returnFees()).toEqual([{ a: 15, status: 'voided' }])
    expect((await keptFeeLines()).reduce((s: number, x: any) => s + x.a, 0)).toBe(0)
    expect(await notesOf('dispute_won_undone')).toHaveLength(1)
    expect(await notesOf('dispute_won_by_hand')).toHaveLength(0)
    expect(await otherCriticals()).toBe(0)
    expect((await followUpUndo('pi_won_norow', { eventId: 'evt_won_norow_2' })).reason).toBe('already_undone')
    expect(await usablePaidAhead(h)).toBe(300)
  })

  it('a charge that paid no bill, disputed in part and then won: the claim (nothing was taken) lets go of the money by itself, and the notice names only the dispute fee to take off', async () => {
    const h = await household()
    await paidAheadOnly(h, 'pi_won_norow_part', 300, [])
    expect((await post(dispute('pi_won_norow_part', 10000))).status).toBe(200)
    expect(await usablePaidAhead(h)).toBe(200)
    expect(await returnFees()).toEqual([{ a: 15, status: 'pending' }])
    expect((await post(won('pi_won_norow_part', 10000))).status).toBe(200)
    // A claim on money still held writes nothing: once the dispute is won, it claims nothing.
    expect(await usablePaidAhead(h)).toBe(300)
    expect(await returnFees()).toEqual([{ a: 15, status: 'pending' }])
    const told = await wonNotices()
    expect(told[0].title).toBe('A dispute was won: undo 1 thing by hand (pi_won_norow_part)')
    expect(told[0].body).toMatch(/1\. Void the \$15\.00 dispute fee billed to Test Tenant/)
    await followUpUndo('pi_won_norow_part')
    expect(await usablePaidAhead(h)).toBe(300)
    expect(await returnFees()).toEqual([{ a: 15, status: 'voided' }])
    expect(await notesOf('dispute_won_undone')).toHaveLength(1)
    expect(await otherCriticals()).toBe(0)
  })

  it('a partial dispute that undid whole spends, then won: the notice names the spends to mark paid again and the money they put back to take off the credit, so nothing is held twice', async () => {
    const h = await household()
    const { credit, rows } = await paidAheadOnly(h, 'pi_won_p2', 300, [
      { amount: 200, due: '2026-11-01' },
      { amount: 50, due: '2026-12-01' },
    ])
    // $220: the $50 unspent, December's $50, then November's $200 whole — $220 taken back, $80 left.
    expect((await post(dispute('pi_won_p2', 22000))).status).toBe(200)
    expect((await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])).rows[0].r).toBe(80)
    expect(await owedNow(h)).toBe(250)

    expect((await post(won('pi_won_p2', 22000))).status).toBe(200)
    expect(await owedNow(h)).toBe(250)                                    // nothing by itself
    const body: string = (await wonNotices())[0].body
    expect(body).toMatch(new RegExp(`The dispute undid \\$250\\.00 of spends of paid-ahead credit ${credit} \\(lines [0-9a-f-, ]+\\): mark those lines paid by that credit again`))
    expect(body).toContain(`The dispute undid $30.00 more of credit ${credit}'s spends than it took off it`)
    expect(body).toContain(`take $30.00 off credit ${credit}.`)
    await followUpUndo('pi_won_p2')
    // November and December are paid by their spends again ($250 used): $50 of the $300 is left.
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = ANY($1::uuid[]) ORDER BY due_date`, [rows])).rows)
      .toEqual([{ status: 'settled' }, { status: 'settled' }])
    expect(await owedNow(h)).toBe(0)
    expect(await usablePaidAhead(h)).toBe(50)
    expect(await notesOf('dispute_won_by_hand')).toHaveLength(0)
    expect(await otherCriticals()).toBe(0)
  })

  it('the same, after the tenant paid December again: the notice names their repayment to save as paid-ahead money, and the follow-up takes the money held twice off the credit', async () => {
    const h = await household()
    const { rows } = await paidAheadOnly(h, 'pi_won_p2r', 300, [
      { amount: 200, due: '2026-11-01' },
      { amount: 50, due: '2026-12-01' },
    ])
    expect((await post(dispute('pi_won_p2r', 22000))).status).toBe(200)
    const decAgain = (await db.query<{ id: string }>(
      `SELECT n.id FROM payments n JOIN payment_reversals pr ON pr.id = n.reversal_id WHERE pr.payment_id = $1`, [rows[1]])).rows[0].id
    await payByBank(h, 'pi_won_p2r_dec', [decAgain], 50)
    expect((await post(won('pi_won_p2r', 22000))).status).toBe(200)
    expect((await wonNotices())[0].body).toContain(`Test Tenant already paid the reopened rent charge again ($50.00, line ${decAgain})`)
    await followUpUndo('pi_won_p2r')
    // Paid $300 + $50; owed $250 → $100 is theirs: $50 left on the credit, $50 saved from the repayment.
    expect(await owedNow(h)).toBe(0)
    expect(await usablePaidAhead(h)).toBe(100)
    expect(await otherCriticals()).toBe(0)
  })
})

describe('Fix pass 2 (rev9 review) — a decided dispute stays decided', () => {
  it('a won dispute stays won when a "lost" or an "under review" event comes after it: nothing more is reversed and no second notice is raised', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_final', [rent], 1000)
    expect((await post(dispute('pi_won_final', 100600))).status).toBe(200)
    expect((await post(won('pi_won_final', 100600))).status).toBe(200)
    expect(await owedNow(h)).toBe(1000)                                  // undone by hand, not by itself
    for (const [status, id, type] of [
      ['lost', 'evt_final_lost', 'charge.dispute.closed'],
      ['under_review', 'evt_final_review', 'charge.dispute.updated'],
      ['needs_response', 'evt_final_needs', 'charge.dispute.funds_withdrawn'],
    ] as const) {
      expect((await post(disputeWithStatus('pi_won_final', 100600, status, id, type))).status).toBe(200)
      expect((await db.query<any>(`SELECT status FROM connect_disputes WHERE stripe_dispute_id = 'du_pi_won_final'`)).rows[0].status).toBe('won')
    }
    expect(await owedNow(h)).toBe(1000)
    expect(await recordsOn('pi_won_final')).toEqual([{ stripe_event_id: 'evt_dispute_pi_won_final', lost: 1000 }])
    expect(await wonNotices()).toHaveLength(1)
    expect(await notesOf('dispute_won_undone')).toHaveLength(0)
  })

  it('an event that says money was taken, reaching the reversal after the win was recorded, reverses nothing and nets no payee', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_race', [rent], 1000)
    // The win is on file before any reversal ran (the stale event lost the race).
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('du_pi_won_race', 'ch_pi_won_race', 'pi_won_race', 1006, 'won')`)
    const r = await handlePaymentReversal({
      paymentIntentId: 'pi_won_race', reversalType: 'ach_unauthorized', reversedAmount: 1006, reversalFee: 15,
      stripeEventId: 'evt_won_race', stripeObjectId: 'du_pi_won_race', disputeStatus: 'needs_response', rawEvent: {},
    })
    expect(r).toMatchObject({ handled: false, reason: 'no_money_taken' })
    expect(await recordsOn('pi_won_race')).toEqual([])
    expect(await owedNow(h)).toBe(0)
    // A register sale's chargeback for the same kind of late event nets nobody either.
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, stripe_payment_intent_id)
       VALUES ($1, $2, 'card', 100, 103.8, 'pi_reg_race')`, [h.landlordId, h.landlordUserId])
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('du_reg_race', 'ch_reg_race', 'pi_reg_race', 103.8, 'won')`)
    const { recordChargeback } = await import('../services/heldPayouts')
    expect(await recordChargeback({ paymentIntentId: 'pi_reg_race', amountCents: 10380, feeCents: 1500, stripeDisputeId: 'du_reg_race', disputeStatus: 'needs_response' }))
      .toEqual({ handled: false, reason: 'no money taken' })
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE source_type = 'dispute'`)).rowCount).toBe(0)
  })
})

describe('A won dispute and the late fees the reopen earned (decisions #55-AMENDED)', () => {
  it('the notice names each late fee written since the dispute to check; the follow-up voids only the one for a day only the reopened rent was owed', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    const water = await row(h, { amount: 50, type: 'utility' })
    const inv = await invoiceFor(h, [rent, water])
    await payByBank(h, 'pi_won_late', [rent], 1000)
    expect((await post(dispute('pi_won_late', 100600))).status).toBe(200)
    // The water bill on the same invoice was paid by itself, late, on October 10.
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = '2026-10-10 18:00:00+00', created_at = '2026-10-01 12:00:00+00',
              manual_method = 'cash' WHERE id = $1`, [water])
    const lateFee = async (due: string) => (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, invoice_id)
       VALUES ($1,$2,$3,$4,'late_fee',10,'pending','LATEFEE',$5::date,$6) RETURNING id`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId, due, inv])).rows[0].id
    const whileWaterOwed = await lateFee('2026-10-06')
    const onlyRentOwed = await lateFee('2026-10-12')

    expect((await post(won('pi_won_late', 100600))).status).toBe(200)
    expect((await db.query<any>(`SELECT id, status FROM payments WHERE id = ANY($1::uuid[]) ORDER BY due_date`, [[whileWaterOwed, onlyRentOwed]])).rows)
      .toEqual([{ id: whileWaterOwed, status: 'pending' }, { id: onlyRentOwed, status: 'pending' }])
    const body: string = (await wonNotices())[0].body
    expect(body).toContain(`Check the $10.00 late fee for 2026-10-06 (line ${whileWaterOwed}): if only the reopened charge was owed that day`)
    expect(body).toContain(`Check the $10.00 late fee for 2026-10-12 (line ${onlyRentOwed})`)
    await followUpUndo('pi_won_late')
    expect((await db.query<any>(`SELECT id, status FROM payments WHERE id = ANY($1::uuid[]) ORDER BY due_date`, [[whileWaterOwed, onlyRentOwed]])).rows)
      .toEqual([{ id: whileWaterOwed, status: 'pending' }, { id: onlyRentOwed, status: 'voided' }])
  })
})

describe('The follow-up undo (not wired, decisions #55-AMENDED) — money a won dispute gives back on a lease that ended', () => {
  it('a reopened charge paid from the security deposit at move-out: the money GAM got back is the tenant\'s paid-ahead money, listed for the landlord\'s choice', async () => {
    const h = await household()
    const rent = await row(h, { amount: 1000 })
    await payByBank(h, 'pi_won_moved', [rent], 1000)
    expect((await post(dispute('pi_won_moved', 100600))).status).toBe(200)
    const again = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id IS NOT NULL`)).rows[0].id
    // The move-out took it out of the deposit, and the lease ended.
    await db.query(`UPDATE payments SET status = 'paid_via_deposit', settled_at = NOW() WHERE id = $1`, [again])
    await db.query(`UPDATE leases SET status = 'terminated', end_date = CURRENT_DATE - 1 WHERE id = $1`, [h.leaseId])

    const { undoWonDispute } = await import('../services/paymentReversal')
    await db.query(`UPDATE connect_disputes SET status = 'won' WHERE stripe_dispute_id = 'du_pi_won_moved'`)
    const r = await undoWonDispute({ stripeDisputeId: 'du_pi_won_moved', stripeEventId: 'evt_won_moved', paymentIntentId: 'pi_won_moved', feeReturnedCents: 1500 })
    expect(r.handled).toBe(true)
    expect(r.creditRestored).toBe(1000)
    expect(r.waitsForChoice).toEqual([h.leaseId])
    expect((await db.query<any>(`SELECT funded_by, note FROM lease_prepaid_credits WHERE id = ANY($1::uuid[])`, [r.creditIds])).rows)
      .toEqual([{ funded_by: 'gam', note: expect.stringContaining('from the security deposit at move-out') }])
    expect((await notesOf('dispute_won_undone'))[0].body).toContain('the landlord decides that money')
    const { paidAheadChoiceTodos } = await import('../services/paidAheadChoice')
    const todos = await paidAheadChoiceTodos([h.landlordId])
    expect(todos.map(t => t.id)).toContain(`paid-ahead-${h.leaseId}`)
  })
})
