/**
 * S655 money plan Step 16 — every payment path in §3, through the real code,
 * with the money invariants I1–I9 checked after each one.
 *
 * Each `it` is one row (or one edge) of the plan's payment-path matrix: it
 * drives the path the way production does (the real charge with Stripe
 * mocked at the SDK, the real Stripe webhook, the desk settle, the bank-deposit
 * confirm, the bill run, the late-fee engine, the retry cron, the autopay
 * runner, the card reader's capture) and then asks two questions:
 *
 *   1. did the path do what its matrix row says (rows, credit, receipt,
 *      owner share), and
 *   2. do I1–I9 still hold over the whole database
 *      (scripts/oct3_money_invariants_check — the same checks P10 runs on
 *      production the night before the first Tuesday payout).
 *
 * The per-step suites (rentCharge, webhooks, disputeReopen, achRetry,
 * bankDepositConfirm, autoSettleDeposits, wholeBillCredit, …) pin each path's
 * details; this file is the cross-path net: one harness, one set of invariants.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'

vi.mock('./email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendNotificationEmail: vi.fn(async () => undefined),
}))
vi.mock('./paymentReceipt', async (orig) => ({
  ...(await orig<typeof import('./paymentReceipt')>()),
  sendPaymentReceipt: vi.fn(async () => 'msg_receipt'),
}))

const stripeSpies = vi.hoisted(() => ({
  confirm: vi.fn(async (id: string, _p?: any) => ({ id, status: 'processing' })),
  retrieve: vi.fn(async (id: string): Promise<any> => ({
    id, status: 'requires_payment_method', payment_method: null, payment_method_types: ['us_bank_account'],
    last_payment_error: { code: 'insufficient_funds', payment_method: { id: 'pm_bank', type: 'us_bank_account' } },
  })),
  cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
  update: vi.fn(async (id: string, _p?: any) => ({ id })),
  capture: vi.fn(async (id: string) => ({ id, status: 'succeeded' })),
  transfer: vi.fn(async (_p?: any, _o?: any) => ({ id: 'tr_mock' })),
}))
vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: stripeSpies.transfer }
    this.customers = {
      retrieve: vi.fn(async () => ({ id: 'cus_paths', invoice_settings: { default_payment_method: 'pm_bank' } })),
      update: vi.fn(async () => ({})),
    }
    this.paymentIntents = {
      create: vi.fn(async () => ({ id: 'pi_mock' })),
      confirm: stripeSpies.confirm, retrieve: stripeSpies.retrieve, cancel: stripeSpies.cancel,
      update: stripeSpies.update, capture: stripeSpies.capture,
      search: vi.fn(async () => ({ data: [] })),
    }
    this.paymentMethods = {
      retrieve: vi.fn(async (id: string) => (id.startsWith('pm_card')
        ? { id, type: 'card', customer: 'cus_paths', card: { country: 'US' } }
        : { id, type: 'us_bank_account', customer: 'cus_paths', us_bank_account: { last4: '6789' } })),
      list: vi.fn(async (o: any) => ({ data: o?.type === 'us_bank_account' ? [{ id: 'pm_bank', type: 'us_bank_account', us_bank_account: { last4: '6789' } }] : [] })),
    }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.setupIntents = { list: vi.fn(async () => ({ data: [] })), create: vi.fn() }
    this.balance = { retrieve: vi.fn(async () => ({ available: [{ currency: 'usd', amount: 100_000_000 }] })) }
  }
  return { default: FakeStripe }
})

let piSeq = 0
vi.mock('./stripeConnect', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createRentPlatformCharge: vi.fn(async () => ({ id: `pi_paths_${++piSeq}`, status: 'processing' })),
}))

import { processingFeeFor } from '@gam/shared'
import { db, getClient } from '../db'
import { webhooksRouter } from '../routes/webhooks'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule } from '../test/dbHelpers'
import { generateInvoices } from '../jobs/invoiceGeneration'
import { generateLateFeesForInvoice } from '../jobs/lateFees'
import { runAutopayForTimezone } from '../jobs/autopayRunner'
import { processAchRetries } from './achRetry'
import { settleManualRentPayment } from './manualPaymentSettle'
import { postTenantPayment } from './postPayment'
import { lockHousehold } from './moneyPredicates'
import { chargeLeaseBalance } from './rentCharge'
import * as stripeConnect from './stripeConnect'
import { createPaidAhead, createIssuedCredit, runWholeBillCheckAfterCommit } from './creditUse'
import { confirmDepositMatch, undoDepositMatch } from './bankDepositConfirm'
import { autoSettleByAmount } from './bankFeed'
import { checkMoneyInvariants } from '../scripts/oct3_money_invariants_check'

// ─── harness ────────────────────────────────────────────────────────────────

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

async function invariantsHold(step: string): Promise<void> {
  const c = await getClient()
  try {
    // I5 measures a disputed row by what GAM held for the landlord when it
    // settled, so a dispute is checked as the script states it.
    const report = await checkMoneyInvariants(c)
    const broken = report.results.filter(r => r.violations > 0).map(r => ({ id: r.id, sample: r.sample.slice(0, 3) }))
    expect({ step, broken }).toEqual({ step, broken: [] })
  } finally { c.release() }
}

function app() {
  const a = express()
  a.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  a.use('/webhooks', webhooksRouter)
  return a
}
async function hook(body: Record<string, unknown>): Promise<void> {
  const res = await request(app()).post('/webhooks/stripe')
    .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub').send(JSON.stringify(body))
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}
const succeeded = (pi: string, method: 'us_bank_account' | 'card' | 'card_present' = 'us_bank_account', eventId = `evt_ok_${pi}`) => hook({
  id: eventId, type: 'payment_intent.succeeded',
  data: { object: { id: pi, metadata: {}, payment_method_types: [method],
    latest_charge: { id: `ch_${pi}`, payment_method_details: { type: method, ...(method !== 'us_bank_account' ? { card: { country: 'US' } } : {}) } } } },
})
const bankFailed = (pi: string, code: string, eventId = `evt_fail_${pi}_${code}_${randomUUID().slice(0, 6)}`) => hook({
  id: eventId, type: 'payment_intent.payment_failed',
  data: { object: { id: pi, metadata: {}, payment_method_types: ['us_bank_account'],
    last_payment_error: { payment_method_details: { us_bank_account: { return_details: { code } } } } } },
})
const canceled = (pi: string) => hook({ id: `evt_cancel_${pi}`, type: 'payment_intent.canceled', data: { object: { id: pi, metadata: {} } } })
const disputed = (pi: string, cents: number) => hook({
  id: `evt_dispute_${pi}`, type: 'charge.dispute.created',
  data: { object: { id: `du_${pi}`, object: 'dispute', charge: `ch_${pi}`, payment_intent: pi, amount: cents,
    currency: 'usd', status: 'needs_response', reason: 'fraudulent', balance_transactions: [{ fee: 1500 }] } },
})

interface H {
  landlordUserId: string; landlordId: string; propertyId: string; unitId: string
  tenantId: string; tenantName: string; leaseId: string
}

/** One household: a $460/month space, tenant pays the processing fee, $25 late fee after 5 days. */
async function household(o: { landlord?: { userId: string; landlordId: string; propertyId: string }; rent?: number; name?: string } = {}): Promise<H> {
  return tx(async c => {
    let landlordUserId: string, landlordId: string, propertyId: string
    if (o.landlord) ({ userId: landlordUserId, landlordId, propertyId } = o.landlord)
    else {
      ;({ userId: landlordUserId, landlordId } = await seedLandlord(c))
      propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
      await c.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
      await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    }
    const rent = o.rent ?? 460
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: rent })
    const tenantId = await seedTenant(c)
    const name = o.name ?? `Pat ${randomUUID().slice(0, 4)}`
    const [first, last] = name.split(' ')
    await c.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
    await c.query(`UPDATE tenants SET stripe_customer_id = 'cus_paths', ach_verified = TRUE WHERE id = $1`, [tenantId])
    const leaseId = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date,
                           late_fee_grace_days, late_fee_initial_type, late_fee_initial_amount)
       VALUES ($1, $2, $3, 'month_to_month', 'active', '2026-04-01', 5, 'flat', 25) RETURNING id`,
      [unitId, landlordId, rent])).rows[0].id
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    return { landlordUserId, landlordId, propertyId, unitId, tenantId, tenantName: name, leaseId }
  })
}

/** An open charge on the household's lease (a bill line). */
async function bill(h: H, o: { type?: string; amount: number; due?: string; entry?: string; owner?: string; invoiceId?: string | null }): Promise<string> {
  const type = o.type ?? 'rent'
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status, due_date,
                           entry_description, revenue_owner)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10) RETURNING id`,
    [h.unitId, h.leaseId, h.tenantId, h.landlordId, o.invoiceId ?? null, type, o.amount.toFixed(2), o.due ?? '2026-09-01',
     o.entry ?? ({ rent: 'RENT', utility: 'UTILITY', late_fee: 'LATEFEE', carried_balance: 'BALANCE', home_payment: 'HOMEPMT' } as Record<string, string>)[type] ?? 'OTHERFEE',
     o.owner ?? 'landlord'])).rows[0].id
}

const rowsOf = async (ids: string[]) => (await db.query<any>(
  `SELECT id, type, status, amount::float AS amount, platform_held, manual_method, next_retry_at, stripe_payment_intent_id AS pi,
          issued_credit_amount::float AS issued
     FROM payments WHERE id = ANY($1::uuid[]) ORDER BY due_date, type`, [ids])).rows
const statusOf = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status
const usesOn = async (paymentIds: string[]) => (await db.query<any>(
  `SELECT status, release_reason, amount::float AS amount, source FROM credit_uses WHERE payment_id = ANY($1::uuid[]) ORDER BY held_at, id`,
  [paymentIds])).rows
const paidAheadOf = async (h: H) => (await db.query<any>(
  `SELECT id, amount_original::float AS original, amount_remaining::float AS remaining, funded_by, voided_at
     FROM lease_prepaid_credits WHERE lease_id = $1 ORDER BY created_at`, [h.leaseId])).rows
const ownerShare = async (ids: string[]) => Number((await db.query<{ s: string }>(
  `SELECT COALESCE(SUM(amount), 0)::text AS s FROM user_balance_ledger
    WHERE reference_type = 'payment' AND type = 'allocation_owner_share' AND reference_id = ANY($1::uuid[])`, [ids])).rows[0].s)
const lastCharged = () => (stripeConnect.createRentPlatformCharge as any).mock.calls.at(-1)?.[0]?.amount as number

const payOnline = (h: H, o: { method?: 'ach' | 'card'; credit?: { use: boolean; expected?: number } | null; amount?: number } = {}) =>
  chargeLeaseBalance({
    tenantId: h.tenantId, leaseId: h.leaseId,
    ...(o.amount != null ? { amount: o.amount } : { chargeEverything: true }),
    paymentMethodId: o.method === 'card' ? 'pm_card' : 'pm_bank', paymentMethodType: o.method ?? 'ach',
    source: 'portal', credit: o.credit ?? null,
  })

async function desk(h: H, anchorId: string, o: Partial<Parameters<typeof settleManualRentPayment>[1]> & { method: 'cash' | 'check' | 'money_order' }) {
  const r = await tx(async c => {
    await lockHousehold(c, h.tenantId, h.landlordId)
    const row = (await c.query<any>(
      `SELECT id, landlord_id, tenant_id, unit_id, lease_id, due_date::text AS due_date FROM payments WHERE id = $1 FOR UPDATE`,
      [anchorId])).rows[0]
    return settleManualRentPayment(c, {
      payment: row, settledAt: null, settleHousehold: true, sendReceipt: false, takenBy: h.landlordUserId, ...o,
    })
  })
  await r.afterCommit()
  return r
}

const ACH_FEE = processingFeeFor({ amount: 100, paymentMethod: 'ach' })

beforeAll(async () => {
  for (const [method, flat, pct, sflat, spct] of [['ach', 6, 0, 0, 0.5], ['card', 0.55, 3.5, 0.26, 0.7]] as const) {
    await db.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = $1 AND effective_until IS NULL)`,
      [method, flat, pct, sflat, spct])
  }
})

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
  ;(stripeConnect.createRentPlatformCharge as any).mockClear()
  stripeSpies.confirm.mockClear()
  stripeSpies.cancel.mockClear()
  stripeSpies.transfer.mockClear()
})

// ─── Portal: Pay Now / Pay all ─────────────────────────────────────────────

describe('portal: Pay Now', () => {
  // A dispute reopens every row its charge paid, one reversal record per row.
  // The old one-record-per-event constraint goes in contract step C0 (deploy
  // day, after the restart); this file runs on the post-C0 shape and leaves
  // the database as it found it.
  let hadOldConstraint = false
  beforeAll(async () => {
    hadOldConstraint = (await db.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'payment_reversals_stripe_event_id_key'`)).rowCount === 1
    await db.query(`ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_stripe_event_id_key`)
  })
  afterAll(async () => {
    if (!hadOldConstraint) return
    await cleanupAllSchema()
    await db.query(`ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_stripe_event_id_key UNIQUE (stripe_event_id)`)
  })

  it('portal ACH success: the held credit is applied before allocation and the owner share is the money part', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    const water = await bill(h, { type: 'utility', amount: 40 })
    const ten = await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))

    // With credit used, the money must be exactly the bill less the credit:
    // paying ahead and spending credit at once is refused, nothing is charged.
    await expect(payOnline(h, { credit: { use: true, expected: 10 }, amount: 490 + 100 }))
      .rejects.toMatchObject({ message: expect.stringMatching(/exactly \$490\.00/) })
    expect(stripeConnect.createRentPlatformCharge).not.toHaveBeenCalled()
    expect(await usesOn([rent, water])).toEqual([])

    // Use all $10 — pay $490.
    const r = await payOnline(h, { credit: { use: true, expected: 10 } })
    expect(r.creditUsed).toBe(10)
    expect(lastCharged()).toBeCloseTo(490 + ACH_FEE, 2)
    expect((await usesOn([rent, water])).map(u => u.status)).toEqual(['held'])
    await invariantsHold('portal ACH, clearing')

    await succeeded(r.paymentIntentId)
    expect((await rowsOf([rent, water])).map(x => [x.type, x.status, x.platform_held])).toEqual([['rent', 'settled', true], ['utility', 'settled', true]])
    expect((await usesOn([rent, water])).map(u => u.status)).toEqual(['applied'])
    // The landlord took the $10 already: the payout carries the money only.
    expect(await ownerShare([rent, water])).toBe(490)
    expect((await paidAheadOf(h)).map((c: any) => [c.id === ten, c.remaining])).toEqual([[true, 0]])
    await invariantsHold('portal ACH, settled')
  })

  it('portal paying ahead: money over the bill becomes GAM-held paid-ahead money received the day it settles, and is not paid out until it pays a bill', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    const r = await payOnline(h, { amount: 560 })
    expect(r.payAhead).toBe(100)
    expect(lastCharged()).toBeCloseTo(560 + ACH_FEE, 2)
    await succeeded(r.paymentIntentId)
    expect(await statusOf(rent)).toBe('settled')
    const [pa] = await paidAheadOf(h)
    expect(pa).toMatchObject({ original: 100, remaining: 100, funded_by: 'gam' })
    expect(await ownerShare([rent])).toBe(460)
    await invariantsHold('portal paying ahead')
  })

  it('card: the card fee is on the money only — never on the credit part', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    await tx(c => createIssuedCredit(c, { landlordId: h.landlordId, tenantId: h.tenantId, leaseId: h.leaseId, amount: 60,
      category: 'goodwill', reason: 'test', createdBy: h.landlordUserId }))
    const r = await payOnline(h, { method: 'card', credit: { use: true, expected: 60 } })
    expect(lastCharged()).toBeCloseTo(400 + processingFeeFor({ amount: 400, paymentMethod: 'card' }), 2)
    await succeeded(r.paymentIntentId, 'card')
    const [row] = await rowsOf([rent])
    expect(row.status).toBe('settled')
    // A credit the landlord gave is never income and never paid out.
    expect(row.issued).toBe(60)
    expect(await ownerShare([rent])).toBe(400)
    await invariantsHold('card')
  })

  it('bounce then retry: the credit stays held through the bounce, the retry cron fires, and the second success applies it once', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))
    const r = await payOnline(h, { credit: { use: true, expected: 10 } })
    await bankFailed(r.paymentIntentId, 'R01')
    let [row] = await rowsOf([rent])
    expect(row.status).toBe('failed')
    expect(row.next_retry_at).not.toBeNull()
    expect((await usesOn([rent])).map(u => u.status)).toEqual(['held'])
    await invariantsHold('bounce, retry scheduled')

    // The retry is due now; the cron re-confirms the same intent.
    await db.query(`UPDATE payments SET next_retry_at = NOW() - interval '1 minute' WHERE id = $1`, [rent])
    await processAchRetries()
    expect(stripeSpies.confirm).toHaveBeenCalled()
    ;[row] = await rowsOf([rent])
    expect(row.status).toBe('processing')
    await invariantsHold('retry in flight')

    await succeeded(r.paymentIntentId, 'us_bank_account', `evt_ok_retry_${r.paymentIntentId}`)
    ;[row] = await rowsOf([rent])
    expect(row.status).toBe('settled')
    expect((await usesOn([rent])).map(u => [u.status, u.amount])).toEqual([['applied', 10]])
    expect(await ownerShare([rent])).toBe(450)
    await invariantsHold('retry settled')
  })

  it('bounce then pay now: paying over a scheduled retry releases its held credit as superseded, cancels the old intent, and holds afresh', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))
    const first = await payOnline(h, { credit: { use: true, expected: 10 } })
    await bankFailed(first.paymentIntentId, 'R01')

    const second = await payOnline(h, { method: 'card', credit: { use: true, expected: 10 } })
    expect(second.paymentIntentId).not.toBe(first.paymentIntentId)
    expect(stripeSpies.cancel).toHaveBeenCalledWith(first.paymentIntentId)
    const uses = await usesOn([rent])
    expect(uses.map(u => [u.status, u.release_reason])).toEqual([['released', 'superseded'], ['held', null]])
    const [row] = await rowsOf([rent])
    expect(row.next_retry_at).toBeNull()
    await invariantsHold('pay now over a retry')

    await succeeded(second.paymentIntentId, 'card')
    expect(await statusOf(rent)).toBe('settled')
    expect((await usesOn([rent])).map(u => u.status)).toEqual(['released', 'applied'])
    expect((await paidAheadOf(h))[0].remaining).toBe(0)
    await invariantsHold('pay now settled')
  })

  it('final failure: the held credit is released, the remittance fails, and the bill is payable again with no retry', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))
    const r = await payOnline(h, { credit: { use: true, expected: 10 } })
    await bankFailed(r.paymentIntentId, 'R02')                  // account closed: never retried
    const [row] = await rowsOf([rent])
    expect([row.status, row.next_retry_at]).toEqual(['failed', null])
    expect((await usesOn([rent])).map(u => [u.status, u.release_reason])).toEqual([['released', 'payment_failed']])
    expect((await paidAheadOf(h))[0].remaining).toBe(10)
    expect((await db.query(`SELECT status FROM tenant_remittances WHERE id = $1`, [r.remittanceId])).rows[0].status).toBe('failed')
    await invariantsHold('final failure')
  })

  it('cancel: payment_intent.canceled releases the held credit and leaves the bill payable', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))
    const r = await payOnline(h, { credit: { use: true, expected: 10 } })
    await canceled(r.paymentIntentId)
    expect(await statusOf(rent)).toBe('failed')
    expect((await usesOn([rent])).map(u => [u.status, u.release_reason])).toEqual([['released', 'payment_canceled']])
    expect((await paidAheadOf(h))[0].remaining).toBe(10)
    await invariantsHold('canceled')
  })

  it('dispute with a surplus: every row reopens at its money part, the unspent surplus is clawed back, and a later spend of it reopens its row', async () => {
    const h = await household()
    const sept = await bill(h, { amount: 460 })
    // September paid by bank with $540 extra: October and $80 more paid ahead through GAM.
    const r = await payOnline(h, { amount: 1000 })
    await succeeded(r.paymentIntentId)
    const [surplus] = await paidAheadOf(h)
    expect(surplus).toMatchObject({ original: 540, funded_by: 'gam' })
    // October's bill: the whole-bill rule pays it from the surplus.
    const oct = await bill(h, { amount: 460, due: '2026-10-01' })
    await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId })
    expect(await statusOf(oct)).toBe('settled')
    expect((await paidAheadOf(h))[0].remaining).toBe(80)
    await invariantsHold('dispute: before')

    await disputed(r.paymentIntentId, Math.round((1000 + ACH_FEE) * 100))
    // September reopens (its money part); October's spend of the disputed
    // surplus is undone and October reopens for that amount.
    const reopened = (await db.query<any>(
      `SELECT r.payment_id AS orig, r.reversed_amount::float AS lost, n.amount::float AS new_amount, n.status
         FROM payment_reversals r LEFT JOIN payments n ON n.reversal_id = r.id ORDER BY r.payment_id`)).rows
    expect(new Set(reopened.map((x: any) => x.orig))).toEqual(new Set([sept, oct]))
    for (const x of reopened) expect([x.lost, x.new_amount, x.status]).toEqual([460, 460, 'pending'])
    expect((await usesOn([oct])).map(u => u.status)).toEqual(['reversed'])
    // October's undone $460 returns to the credit, then the whole $540 is
    // taken back: nothing of the disputed money is left to spend or pay out.
    const claw = (await db.query<any>(
      `SELECT source, status, amount::float AS amount FROM credit_uses WHERE prepaid_credit_id = $1 AND payment_reversal_id IS NOT NULL`,
      [surplus.id])).rows
    expect(claw).toEqual([{ source: 'reversal', status: 'applied', amount: 540 }])
    expect((await paidAheadOf(h))[0].remaining).toBe(0)
    await invariantsHold('dispute with surplus')
  })
})

// ─── Desk, posted payments ─────────────────────────────────────────────────

describe('desk and posted payments', () => {
  it('desk cash with change: the whole household bill settles, change is handed back, one receipt for the money kept', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    const water = await bill(h, { type: 'utility', amount: 35.5 })
    const r = await desk(h, rent, { method: 'cash', amountTendered: 500, surplusHandling: 'change' })
    expect(r.settledPaymentIds.sort()).toEqual([rent, water].sort())
    expect(r.changeGiven).toBe(4.5)
    expect(r.creditId).toBeNull()
    const rec = (await db.query<any>(`SELECT amount::float AS amount, unapplied_amount::float AS unapplied, gross_amount FROM tenant_remittances WHERE id = $1`, [r.receiptId])).rows[0]
    expect(rec).toEqual({ amount: 495.5, unapplied: 0, gross_amount: null })
    expect((await rowsOf([rent, water])).every((x: any) => x.manual_method === 'cash' && x.platform_held === false)).toBe(true)
    expect(await ownerShare([rent, water])).toBe(0)
    await invariantsHold('desk cash with change')
  })

  it('desk cash kept as credit (no change on hand): the extra is money paid ahead the landlord holds — never paid out', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    const r = await desk(h, rent, { method: 'cash', amountTendered: 465, surplusHandling: 'credit' })
    expect(r.surplus).toBe(5)
    expect((await paidAheadOf(h))[0]).toMatchObject({ original: 5, funded_by: 'landlord' })
    expect(await ownerShare([rent])).toBe(0)
    await invariantsHold('desk cash kept as credit')
  })

  it('desk with saved credit: "Use $X" spends it at once; the receipt is the money only', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'gam', receivedAt: '2026-08-20T17:00:00Z' }))
    const r = await desk(h, rent, { method: 'cash', amountTendered: 450, creditToUse: 10 })
    expect(r.creditUsed).toBe(10)
    expect((await usesOn([rent])).map(u => [u.status, u.source])).toEqual([['applied', 'desk']])
    // The $10 GAM held is released to the landlord with the row (platform_held, owner share $10).
    const [row] = await rowsOf([rent])
    expect(row.platform_held).toBe(true)
    expect(await ownerShare([rent])).toBe(10)
    await invariantsHold('desk with GAM-held credit')
  })

  it('check surplus: a check over the bill becomes landlord-held paid ahead money tied to the receipt', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    const r = await desk(h, rent, { method: 'check', amountTendered: 470, confirmWrittenAmount: true })
    const [ten] = await paidAheadOf(h)
    expect(ten).toMatchObject({ original: 10, funded_by: 'landlord' })
    expect((await db.query(`SELECT source_remittance_id FROM lease_prepaid_credits WHERE id = $1`, [ten.id])).rows[0].source_remittance_id).toBe(r.receiptId)
    await invariantsHold('check surplus')
  })

  it('post a payment: money pays the bank-payable rows oldest first, spends no credit, and the rest is paid ahead from the day it was received', async () => {
    const h = await household()
    const aug = await bill(h, { amount: 460, due: '2026-08-01' })
    const sept = await bill(h, { amount: 460, due: '2026-09-01' })
    await tx(c => createIssuedCredit(c, { landlordId: h.landlordId, tenantId: h.tenantId, leaseId: h.leaseId, amount: 20,
      category: 'goodwill', reason: 'test', createdBy: h.landlordUserId }))
    const r = await tx(c => postTenantPayment(c, {
      tenantId: h.tenantId, landlordIds: [h.landlordId], method: 'check', amount: 1000,
      receivedAt: new Date('2026-09-03T17:00:00Z'), postedBy: h.landlordUserId,
    }))
    await r.afterCommit()
    expect(r.applied).toBe(920)
    expect(r.paidAhead).toBe(80)
    expect((await rowsOf([aug, sept])).map((x: any) => x.status)).toEqual(['settled', 'settled'])
    expect(await usesOn([aug, sept])).toEqual([])
    const pa = (await paidAheadOf(h))[0]
    expect(pa).toMatchObject({ original: 80, funded_by: 'landlord' })
    await invariantsHold('post a payment')
  })
})

// ─── The bank: deposit match, auto-settle, Undo ────────────────────────────

async function bankRow(h: H, amount: number, description = 'MOBILE DEPOSIT', posted = "CURRENT_DATE"): Promise<string> {
  const conn = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, status, created_at)
     VALUES ($1, 'stripe_fc', 'active', NOW() - interval '60 days')
     ON CONFLICT DO NOTHING RETURNING id`, [h.landlordId])).rows[0]?.id
    ?? (await db.query<{ id: string }>(`SELECT id FROM bank_connections WHERE landlord_id = $1 LIMIT 1`, [h.landlordId])).rows[0].id
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
     VALUES ($1,$2,$3,${posted},$4,$5,'needs_review') RETURNING id`,
    [conn, h.landlordId, randomUUID(), amount.toFixed(2), description])).rows[0].id
}

describe('the bank', () => {
  it('bank match, exact: the deposit settles the oldest lines it pays, $0 credit, one receipt, no payout', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 450 })
    const water = await bill(h, { type: 'utility', amount: 165 })
    const home = await bill(h, { type: 'home_payment', amount: 200 })
    await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))
    const txn = await bankRow(h, 815)
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [rent, water, home], method: 'cash', confirmedByUserId: h.landlordUserId })
    expect((await rowsOf([rent, water, home])).map((x: any) => x.status)).toEqual(['settled', 'settled', 'settled'])
    expect(await usesOn([rent, water, home])).toEqual([])          // bug 2: never credit
    expect((await paidAheadOf(h))[0].remaining).toBe(10)
    expect(await ownerShare([rent, water, home])).toBe(0)
    await invariantsHold('bank match exact')
  })

  it('bank match, short: a deposit smaller than the bill settles only the lines it covers; the rest stays owed', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 450, due: '2026-08-01' })
    const sept = await bill(h, { amount: 450, due: '2026-09-01' })
    const txn = await bankRow(h, 450)
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [rent], method: 'check', confirmedByUserId: h.landlordUserId })
    expect(await statusOf(rent)).toBe('settled')
    expect(await statusOf(sept)).toBe('pending')
    await invariantsHold('bank match short')
  })

  it('auto-settle by amount, then Undo: the whole bill to the cent settles by itself and Undo puts every row back', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460, due: '2026-09-01' })
    const water = await bill(h, { type: 'utility', amount: 12.34, due: '2026-09-01' })
    const txn = await bankRow(h, 472.34)
    expect(await autoSettleByAmount(h.landlordId)).toBe(1)
    expect((await rowsOf([rent, water])).map((x: any) => x.status)).toEqual(['settled', 'settled'])
    await invariantsHold('auto-settled')

    const u = await undoDepositMatch({ bankTransactionId: txn, landlordId: h.landlordId, undoneBy: h.landlordUserId })
    expect(u).toBeTruthy()
    expect((await rowsOf([rent, water])).map((x: any) => x.status)).toEqual(['pending', 'pending'])
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id = $1`, [txn])).rows[0].status).toBe('needs_review')
    await invariantsHold('auto-settle undone')
  })
})

// ─── Credit that pays a whole bill by itself ───────────────────────────────

describe('the whole-bill rule', () => {
  it('whole-bill bill run: money paid ahead that covers the whole bill pays it at the 7 AM run (Todd); less than the bill pays nothing (MH 25)', async () => {
    const todd = await household({ name: 'Todd Ahead' })
    const ll = { userId: todd.landlordUserId, landlordId: todd.landlordId, propertyId: todd.propertyId }
    const mh25 = await household({ landlord: ll, name: 'Mae Ten' })
    await tx(async c => {
      await createPaidAhead(c, { leaseId: todd.leaseId, tenantId: todd.tenantId, amount: 460, fundedBy: 'landlord', receivedAt: '2026-04-20T17:00:00Z' })
      await createPaidAhead(c, { leaseId: mh25.leaseId, tenantId: mh25.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-04-20T17:00:00Z' })
    })
    await generateInvoices(new Date('2026-05-05T19:00:00Z'))
    const may = async (h: H) => (await db.query<any>(
      `SELECT p.id, p.status FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.lease_id = $1 AND i.due_date = '2026-05-01' AND p.type = 'rent'`,
      [h.leaseId])).rows[0]
    const t = await may(todd)
    const m = await may(mh25)
    expect(t.status).toBe('settled')
    expect((await usesOn([t.id])).map(u => [u.status, u.source, u.amount])).toEqual([['applied', 'whole_bill', 460]])
    expect(m.status).toBe('pending')
    expect(await usesOn([m.id])).toEqual([])
    // Money the landlord already holds: no payout for Todd's month.
    expect(await ownerShare([t.id])).toBe(0)
    await invariantsHold('whole-bill bill run')
  })

  it('pre-late-fee settle: a credit that covers the whole bill by the late-fee check pays it, and no late fee posts', async () => {
    const h = await household()
    await generateInvoices(new Date('2026-08-01T15:00:00Z'))
    const inv = (await db.query<{ id: string }>(`SELECT id FROM invoices WHERE lease_id = $1 AND due_date = '2026-08-01'`, [h.leaseId])).rows[0]
    // A goodwill credit for the whole bill lands after the bill went out —
    // created straight on the table, so the after-commit check has not run.
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
       VALUES ($1,$2,$3,460,460,'goodwill','test','active')`, [h.landlordId, h.tenantId, h.leaseId])
    const lf = await generateLateFeesForInvoice(inv.id)
    expect(lf.errors).toEqual([])
    const rows = (await db.query<any>(`SELECT type, status FROM payments WHERE invoice_id = $1 ORDER BY type`, [inv.id])).rows
    expect(rows).toEqual([{ type: 'rent', status: 'settled' }])
    await invariantsHold('pre-late-fee settle')
  })

  it('deposit-interest use: GAM-funded interest pays a whole bill, is released to the landlord as an owner share, and is never "credits you gave"', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 25 })
    await tx(c => createIssuedCredit(c, { landlordId: h.landlordId, tenantId: h.tenantId, leaseId: h.leaseId, amount: 25,
      category: 'deposit_interest', reason: 'Deposit interest', createdBy: null }))
    await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId })
    const [row] = await rowsOf([rent])
    expect(row.status).toBe('settled')
    expect(row.issued).toBe(0)                        // GAM funded it: not a landlord-issued credit
    expect(row.platform_held).toBe(true)
    expect(await ownerShare([rent])).toBe(25)
    await invariantsHold('deposit-interest use')
  })
})

// ─── Autopay ────────────────────────────────────────────────────────────────

describe('autopay', () => {
  async function arm(h: H, useCredit: boolean): Promise<Date> {
    const now = new Date('2026-09-15T19:00:00Z')            // noon in Phoenix on the 15th
    await db.query(
      `INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, pull_day, payment_method_id, use_credit)
       VALUES ($1,$2,TRUE,15,'pm_bank',$3)`, [h.tenantId, h.leaseId, useCredit])
    return now
  }

  it('autopay with "use my credit first" off charges the whole bill and keeps the credit', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))
    const r = await runAutopayForTimezone('America/Phoenix', await arm(h, false))
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(lastCharged()).toBeCloseTo(460 + ACH_FEE, 2)
    expect(await usesOn([rent])).toEqual([])
    const pi = (await rowsOf([rent]))[0].pi
    await succeeded(pi)
    expect((await paidAheadOf(h))[0].remaining).toBe(10)
    await invariantsHold('autopay credit off')
  })

  it('autopay with "use my credit first" on spends all usable credit and charges the rest', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460 })
    await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))
    expect(await runAutopayForTimezone('America/Phoenix', await arm(h, true))).toMatchObject({ charged: 1, failed: 0 })
    expect(lastCharged()).toBeCloseTo(450 + ACH_FEE, 2)
    expect((await usesOn([rent])).map(u => [u.status, u.source])).toEqual([['held', 'autopay']])
    await succeeded((await rowsOf([rent]))[0].pi)
    expect((await usesOn([rent])).map(u => u.status)).toEqual(['applied'])
    expect(await ownerShare([rent])).toBe(450)
    await invariantsHold('autopay credit on')
  })
})

// ─── The counter card reader ───────────────────────────────────────────────

describe('counter card reader', () => {
  it('reader with old balance: the bill plus "also pay $X toward the old balance" is captured, the old balance is paid last, and the card fee is on all of it', async () => {
    const h = await household()
    const rent = await bill(h, { amount: 460, due: '2026-09-01' })
    const old = await bill(h, { type: 'carried_balance', amount: 300, due: '2026-03-01' })
    const quote = await chargeLeaseBalance({
      tenantId: h.tenantId, leaseId: h.leaseId, chargeEverything: true, towardOldBalance: 100,
      paymentMethodType: 'card_present', source: 'front_desk_reader', credit: null, dryRun: true,
    })
    const cents = Math.round(quote.chargeAmount * 100)
    expect(quote.chargeAmount).toBeCloseTo(560 + processingFeeFor({ amount: 560, paymentMethod: 'card' }), 2)
    const r = await chargeLeaseBalance({
      tenantId: h.tenantId, leaseId: h.leaseId, chargeEverything: true, towardOldBalance: 100,
      paymentMethodType: 'card_present', source: 'front_desk_reader', credit: null,
      existingIntent: { id: 'pi_reader_paths', amountCents: cents, capture: true },
    })
    expect(stripeSpies.capture).toHaveBeenCalledWith('pi_reader_paths')
    await succeeded(r.paymentIntentId, 'card_present')
    expect(await statusOf(rent)).toBe('settled')
    // $100 of the $300 old balance is paid; $200 is still owed.
    const left = (await db.query<any>(
      `SELECT COALESCE(SUM(amount), 0)::float AS s FROM payments WHERE lease_id = $1 AND type = 'carried_balance' AND status = 'pending'`,
      [h.leaseId])).rows[0].s
    expect(left).toBe(200)
    // The old balance is paid last and in part (S622): $100 of the $300 row settled.
    const oldRows = (await db.query<any>(
      `SELECT status, amount::float AS amount FROM payments WHERE lease_id = $1 AND type = 'carried_balance' ORDER BY status DESC`,
      [h.leaseId])).rows
    expect(oldRows).toEqual([{ status: 'settled', amount: 100 }, { status: 'pending', amount: 200 }])
    expect((await rowsOf([old]))[0].status).toBe('settled')
    await invariantsHold('reader with old balance')
  })
})

// ─── FlexPay, renewal hand-off, move-out ───────────────────────────────────

describe('FlexPay cover and pull', () => {
  it('FlexPay cover and pull: the whole monthly bill settles from GAM\'s float on the last grace day (owner share, no fee), saved credit stays saved, and the one pull row settles on its day', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description) VALUES ('flexpay_rollout_visible', TRUE, 'S655 Step 16')
       ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
    const h = await household()
    await db.query(
      `UPDATE tenants SET flexpay_enrolled = TRUE, flexpay_pull_day = 20, flexpay_monthly_fee = 25, ach_verified = TRUE WHERE id = $1`,
      [h.tenantId])
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, subtotal_utilities, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-FLEX-16','2026-10-01',460,40,500,'pending') RETURNING id`,
      [h.landlordId, h.tenantId, h.leaseId, h.unitId])).rows[0].id
    const rent = await bill(h, { amount: 460, due: '2026-10-01', invoiceId: inv })
    const water = await bill(h, { type: 'utility', amount: 40, due: '2026-10-01', invoiceId: inv })
    const saved = await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-09-20T17:00:00Z' }))

    const { coverFlexPayCycle, processFlexPayPullDay } = await import('./flexpay')
    const cover = await coverFlexPayCycle(new Date('2026-10-05T10:00:00Z'))   // the last grace day, before the late-fee run
    expect(cover).toMatchObject({ bills_covered: 1, errors: 0 })
    const rows = await rowsOf([rent, water])
    expect(rows.map((x: any) => [x.status, x.platform_held, x.manual_method])).toEqual([['settled', true, null], ['settled', true, null]])
    expect(await ownerShare([rent, water])).toBe(500)
    expect(await usesOn([rent, water])).toEqual([])
    expect((await paidAheadOf(h)).find((c: any) => c.id === saved).remaining).toBe(10)
    await invariantsHold('FlexPay cover')

    const pull = await processFlexPayPullDay(new Date('2026-10-20T12:00:00Z'))
    expect(pull).toMatchObject({ pulls_initiated: 1, errors: 0 })
    const pullRow = (await db.query<any>(
      `SELECT id, amount::float AS amount, revenue_owner, stripe_payment_intent_id AS pi FROM payments
        WHERE tenant_id = $1 AND entry_description = 'FLEXPAY'`, [h.tenantId])).rows
    expect(pullRow).toHaveLength(1)
    expect(pullRow[0].revenue_owner).toBe('gam')
    await invariantsHold('FlexPay pull clearing')
    await succeeded(pullRow[0].pi)
    expect(await statusOf(pullRow[0].id)).toBe('settled')
    // GAM's own money: never a landlord owner share.
    expect(await ownerShare([pullRow[0].id])).toBe(0)
    await invariantsHold('FlexPay pull settled')
  })
})

describe('renewal hand-off', () => {
  it('renewal hand-off with held credit: credit set aside by a payment in flight moves to the renewal, and the payment still settles it exactly once', async () => {
    const h = await household()
    const sept = await bill(h, { amount: 460, due: '2026-09-01' })
    const special = await tx(c => createIssuedCredit(c, { landlordId: h.landlordId, tenantId: h.tenantId, leaseId: h.leaseId, amount: 50,
      category: 'goodwill', reason: 'move-in special', createdBy: h.landlordUserId }))
    const r = await payOnline(h, { credit: { use: true, expected: 50 } })
    expect((await usesOn([sept])).map(u => u.status)).toEqual(['held'])

    const renewalId = (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, supersedes_lease_id, signed_by_landlord)
       VALUES ($1,$2,480,'month_to_month','pending','2026-10-01',$3,TRUE) RETURNING id`, [h.unitId, h.landlordId, h.leaseId])).rows[0].id
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`, [renewalId, h.tenantId])
    const { handOffOpenItemsToRenewal } = await import('../jobs/scheduler')
    const moved = await handOffOpenItemsToRenewal(h.leaseId, renewalId)
    expect(moved.credits).toBe(1)
    expect((await db.query(`SELECT lease_id FROM tenant_credits WHERE id = $1`, [special])).rows[0].lease_id).toBe(renewalId)
    await invariantsHold('hand-off with credit held')

    await succeeded(r.paymentIntentId)
    expect(await statusOf(sept)).toBe('settled')
    expect((await usesOn([sept])).map(u => [u.status, u.amount])).toEqual([['applied', 50]])
    expect((await rowsOf([sept]))[0].issued).toBe(50)
    expect(Number((await db.query(`SELECT amount_remaining FROM tenant_credits WHERE id = $1`, [special])).rows[0].amount_remaining)).toBe(0)
    await invariantsHold('hand-off, then settled')
  })
})

describe('move-out', () => {
  // decisions.md #46.2 (Nic, 10/4 ~2:30pm, FINAL): the deductions (damage,
  // cleaning, unpaid bills) come out of the SECURITY DEPOSIT FIRST — "that's
  // what a security deposit is for". The rent the tenant paid ahead is theirs:
  // it pays only what the deposit cannot, and what is left of it is never
  // refunded with the deposit — it stays paid-ahead credit on the lease for the
  // landlord's refund choice (#46.1). #46.3: whoever holds a deposit refunds
  // what is left of it; GAM refunds and releases only money GAM holds.
  //
  // The fixture: a $500 security deposit, a $150 cleaning fee and (unless
  // `unpaidRent: false`) September's $460 rent unpaid; money paid ahead of $100
  // GAM-held (created first, so spent first) and $40 landlord-held.
  async function moveOut(heldBy: 'landlord' | 'gam_escrow', o: { unpaidRent?: boolean } = {}) {
    const h = await household()
    const { seedSecurityDeposit, seedLeaseFee, seedDepositReturnDraft } = await import('../test/dbHelpers')
    const { finalizeDepositReturn } = await import('./depositReturn')
    await tx(async c => {
      await seedLeaseFee(c, { leaseId: h.leaseId, feeType: 'cleaning_fee', amount: 150, dueTiming: 'move_out' })
    })
    const depositId = await tx(c => seedSecurityDeposit(c, { unitId: h.unitId, leaseId: h.leaseId, tenantId: h.tenantId, totalAmount: 500, heldBy }))
    await db.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_paths_' || substr(md5(id::text), 1, 8) WHERE id = $1`, [h.landlordId])
    const lastRent = o.unpaidRent === false ? null : await bill(h, { amount: 460, due: '2026-09-01' })
    const gamHeld = await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 100, fundedBy: 'gam', receivedAt: '2026-08-20T17:00:00Z' }))
    const landlordHeld = await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 40, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' }))
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-30' WHERE id = $1`, [h.leaseId])
    const draftId = await tx(c => seedDepositReturnDraft(c, {
      leaseId: h.leaseId, tenantId: h.tenantId, landlordId: h.landlordId, securityDepositId: depositId,
      totalDeposit: 500, cleaningFeeAmount: 150 }))
    const final = await finalizeDepositReturn(draftId, h.landlordUserId)
    const left = Object.fromEntries((await paidAheadOf(h)).map((c: any) => [c.id === gamHeld ? 'gamHeld' : c.id === landlordHeld ? 'landlordHeld' : c.id, c.remaining]))
    const moveOutUses = (await db.query<any>(
      `SELECT prepaid_credit_id, amount::float AS amount, status, deposit_return_id FROM credit_uses WHERE source = 'move_out' ORDER BY applied_at, id`)).rows
    const usedFrom = (id: string) => moveOutUses.filter((u: any) => u.prepaid_credit_id === id).reduce((t: number, u: any) => t + u.amount, 0)
    const released = (await db.query<any>(
      `SELECT amount::float AS amount FROM held_payout_items WHERE landlord_id = $1 AND source_type = 'prepaid_draw'`, [h.landlordId])).rows
      .reduce((t: number, x: any) => t + x.amount, 0)
    const transfers = stripeSpies.transfer.mock.calls.map((c: any) => c[0]?.amount as number)
    // Who refunds what (#46.3) — columns on the saved row that DepositReturnRow does not declare yet.
    const split = (await db.query<{ g: string; l: string }>(
      `SELECT refund_from_gam::text AS g, refund_from_landlord::text AS l FROM deposit_returns WHERE id = $1`, [draftId])).rows[0]
    const refundBy = [Number(split.g), Number(split.l)]
    // The September rent the deposit paid ('paid_via_deposit') must book no
    // owner share and no held item of its own: the landlord is paid for it
    // ONCE, out of the deposit (the escrow transfer, or the deposit the
    // landlord already holds) — never again by the Tuesday payout.
    const lastRentRow = lastRent ? (await db.query<{ platform_held: boolean; ledger: number }>(
      `SELECT p.platform_held,
              (SELECT COUNT(*)::int FROM user_balance_ledger l
                WHERE l.reference_type = 'payment' AND l.reference_id = p.id) AS ledger
         FROM payments p WHERE p.id = $1`, [lastRent])).rows[0] : null
    const lastRentShare = lastRent ? await ownerShare([lastRent]) : 0
    const heldItems = (await db.query<{ source_type: string; amount: number }>(
      `SELECT source_type, amount::float AS amount FROM held_payout_items WHERE landlord_id = $1 ORDER BY source_type, amount`,
      [h.landlordId])).rows
    return { h, final, lastRent, gamHeld, landlordHeld, draftId, left, moveOutUses, usedFrom, released, transfers, refundBy,
             lastRentRow, lastRentShare, heldItems }
  }

  it('move-out with a landlord-held deposit: the deductions come out of the deposit first, money paid ahead pays only the $110 beyond it, $30 is left for the landlord\'s refund choice, and only the GAM-held part is released', async () => {
    const m = await moveOut('landlord')
    // Cleaning $150 + September's unpaid $460 = $610; the deposit pays $500 of it.
    expect(Number(m.final.total_deductions)).toBe(610)
    expect(await statusOf(m.lastRent!)).toBe('paid_via_deposit')
    // Nothing of the deposit is left to refund, and nothing is owed beyond it.
    expect(Number(m.final.refund_amount)).toBe(0)
    expect(Number(m.final.gap_amount)).toBe(0)
    expect(m.refundBy).toEqual([0, 0])
    // Paid-ahead money pays the $110 beyond the deposit, oldest credit first.
    expect(m.usedFrom(m.gamHeld)).toBe(100)
    expect(m.usedFrom(m.landlordHeld)).toBe(10)
    for (const u of m.moveOutUses) expect(u).toMatchObject({ status: 'applied', deposit_return_id: m.draftId })
    // The $30 left is still the tenant's paid-ahead credit, never refunded here.
    expect(m.left).toEqual({ gamHeld: 0, landlordHeld: 30 })
    // The landlord holds the deposit (no money moves for it, no transfer); GAM
    // releases the $100 of paid-ahead money it held that paid the deductions.
    expect(m.transfers).toEqual([])
    expect(m.released).toBe(100)
    // September's rent, paid by the deposit, is never paid to the landlord a
    // second time: no owner share, no ledger row, not GAM-held, and the only
    // held item is the $100 GAM-held paid-ahead release.
    expect(m.lastRentShare).toBe(0)
    expect(m.lastRentRow).toEqual({ platform_held: false, ledger: 0 })
    expect(m.heldItems).toEqual([{ source_type: 'prepaid_draw', amount: 100 }])
    await invariantsHold('move-out, landlord-held deposit')
  })

  it('move-out with a GAM escrow deposit: the deductions come out of the deposit first, GAM sends the landlord exactly the $500 deposit + the $100 GAM-held money that paid them, and $30 is left for the landlord\'s refund choice', async () => {
    const m = await moveOut('gam_escrow')
    expect(Number(m.final.total_deductions)).toBe(610)
    expect(await statusOf(m.lastRent!)).toBe('paid_via_deposit')
    expect(Number(m.final.refund_amount)).toBe(0)
    expect(Number(m.final.gap_amount)).toBe(0)
    expect(m.refundBy).toEqual([0, 0])
    expect(m.usedFrom(m.gamHeld)).toBe(100)
    expect(m.usedFrom(m.landlordHeld)).toBe(10)
    for (const u of m.moveOutUses) expect(u).toMatchObject({ status: 'applied', deposit_return_id: m.draftId })
    expect(m.left).toEqual({ gamHeld: 0, landlordHeld: 30 })
    // One settlement transfer: escrow $500 + GAM-held $100 − refund $0. The
    // GAM-held money rides it, never a second held item.
    expect(m.transfers).toEqual([60000])
    expect(m.released).toBe(0)
    // September's rent rides that one transfer and nothing else: no owner
    // share (the Tuesday payout would pay it twice), no held item of any kind.
    expect(m.lastRentShare).toBe(0)
    expect(m.lastRentRow).toEqual({ platform_held: false, ledger: 0 })
    expect(m.heldItems).toEqual([])
    // The dollars tie out: the $610 of deductions = $500 deposit + $110 paid ahead.
    expect(Math.round((500 + m.usedFrom(m.gamHeld) + m.usedFrom(m.landlordHeld)) * 100) / 100).toBe(Number(m.final.total_deductions))
    await invariantsHold('move-out, GAM escrow deposit')
  })

  it('move-out with deductions smaller than the deposit: the holder refunds the rest of the deposit and money paid ahead is not touched (decisions #46.2)', async () => {
    for (const heldBy of ['landlord', 'gam_escrow'] as const) {
      await cleanupAllSchema()
      stripeSpies.transfer.mockClear()
      const m = await moveOut(heldBy, { unpaidRent: false })
      expect(Number(m.final.total_deductions)).toBe(150)
      expect(Number(m.final.refund_amount)).toBe(350)
      expect(Number(m.final.gap_amount)).toBe(0)
      // Whoever holds the deposit refunds it (#46.3).
      expect(m.refundBy)
        .toEqual(heldBy === 'gam_escrow' ? [350, 0] : [0, 350])
      // The rent they paid ahead is theirs: no move-out use, all $140 still theirs.
      expect(m.moveOutUses).toEqual([])
      expect(m.left).toEqual({ gamHeld: 100, landlordHeld: 40 })
      expect(m.released).toBe(0)
      // GAM sends the landlord only the deposit the deductions took ($150), and only when GAM holds it.
      expect(m.transfers).toEqual(heldBy === 'gam_escrow' ? [15000] : [])
      // Nothing else is queued for the landlord's payout.
      expect(m.heldItems).toEqual([])
      await invariantsHold(`move-out, small deductions, ${heldBy}`)
    }
  })
})

