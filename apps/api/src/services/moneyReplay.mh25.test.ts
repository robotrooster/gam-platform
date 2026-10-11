/**
 * S655 money plan Step 16 — the MH 25 replay, end to end through the real paths.
 *
 * Oak Park MH 25 handed over a $470 check against $460 rent. The $10 over is
 * money the LANDLORD took (paid ahead, funded_by 'landlord'). Nic's rules
 * (decisions.md, 10/2 credit decisions + plan §0.0 OWNER CORRECTION, and 10/6):
 *
 *   - 10/6 (Nic): "Credits need to not settle by line item. It needs to be a
 *     credit against the entire balance." Money paid ahead goes on the next
 *     bill by itself, whole or in part: July's bill run puts the $10 on the
 *     $460 rent, $450 is still owed, and nobody is asked "Use" or "Save";
 *     (it replaces 10/2's "only when it covers the whole bill" for money paid
 *     ahead — credit the landlord gives still waits for the payer's choice);
 *   - a bill not paid by the grace day takes its late fee;
 *   - the payout carries only money GAM holds — never the $10 the landlord
 *     already has in hand;
 *   - "Money received" is the day money ARRIVED: the $10 counts in the check's
 *     month (on its own "Paid ahead for later bills" line) and $0 again when it
 *     later pays a bill. "Money billed" counts each bill by its due date, with
 *     the part the $10 paid shown as "covered by money paid ahead".
 *
 * Months are fixed past dates (the bill run and the reports take explicit
 * days): the check month is June 2026, the month the $10 goes on the bill
 * July, a month with no credit at all August. Every step runs the real service (bill run, desk settle, portal
 * quote, portal charge with Stripe mocked, the real webhook, the late-fee
 * engine, the reports) and checks the money invariants I1–I9 after it.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { PoolClient } from 'pg'

const emailInvoiceReady = vi.hoisted(() => vi.fn(async (..._a: any[]) => 'msg_invoice'))
vi.mock('./email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailInvoiceReady,
  sendNotificationEmail: vi.fn(async () => undefined),
}))
vi.mock('./paymentReceipt', async (orig) => ({
  ...(await orig<typeof import('./paymentReceipt')>()),
  sendPaymentReceipt: vi.fn(async () => 'msg_receipt'),
}))

vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_mock' })) }
    this.customers = { retrieve: vi.fn(async () => ({})), update: vi.fn(async () => ({})) }
    this.paymentIntents = { create: vi.fn(async () => ({ id: 'pi_mock' })), cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })) }
    this.paymentMethods = { retrieve: vi.fn(async () => ({ id: 'pm_mock', card: { country: 'US' } })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.balance = { retrieve: vi.fn(async () => ({ available: [{ currency: 'usd', amount: 100_000_000 }] })) }
  }
  return { default: FakeStripe }
})

let piSeq = 0
vi.mock('./stripeConnect', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createRentPlatformCharge: vi.fn(async () => ({ id: `pi_mh25_${++piSeq}`, status: 'processing' })),
}))

import { processingFeeFor } from '@gam/shared'
import { db, getClient } from '../db'
import { webhooksRouter } from '../routes/webhooks'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule,
} from '../test/dbHelpers'
import { generateInvoices } from '../jobs/invoiceGeneration'
import { generateLateFeesForInvoice } from '../jobs/lateFees'
import { sendPendingInvoiceNotices } from './invoiceNotice'
import { settleManualRentPayment } from './manualPaymentSettle'
import { lockHousehold } from './moneyPredicates'
import { chargeLeaseBalance, quoteLeaseCharge } from './rentCharge'
import * as stripeConnect from './stripeConnect'
import { heldOwnerShareForUser } from './landlordPassthrough'
import { incomeTotals, paidAheadUnusedAt } from './incomeBasis'
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

/** I1–I9 over the whole test database; a failure names the invariant and its first rows. */
async function invariantsHold(step: string): Promise<void> {
  const c = await getClient()
  try {
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

/** Stripe says the card payment went through. */
async function cardCleared(pi: string, remittanceId: string): Promise<void> {
  const res = await request(app()).post('/webhooks/stripe')
    .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub')
    .send(JSON.stringify({
      id: `evt_ok_${pi}`, type: 'payment_intent.succeeded',
      data: { object: { id: pi, metadata: { gam_remittance_id: remittanceId }, payment_method_types: ['card'],
        latest_charge: { id: `ch_${pi}`, payment_method_details: { type: 'card', card: { country: 'US' } } } } },
    }))
  expect(res.status).toBe(200)
}

/**
 * Time passes in the test the way it did at the park: the webhook stamps the
 * settle "now", and the replay moves that stamp back to the day it happened.
 */
async function settledOn(pi: string, at: string): Promise<void> {
  await db.query(`UPDATE payments SET settled_at = $2::timestamptz WHERE stripe_payment_intent_id = $1 AND status = 'settled'`, [pi, at])
  await db.query(`UPDATE tenant_remittances SET settled_at = $2::timestamptz WHERE stripe_payment_intent_id = $1`, [pi, at])
  // A credit use's own stamps are a record and never move (the ledger trigger
  // refuses it), so they keep the real clock: read "paid ahead, not used yet"
  // as of today, not as of the replayed day.
}

interface Park {
  landlordUserId: string; landlordId: string; propertyId: string; unitId: string
  tenantId: string; leaseId: string
}

async function mh25(): Promise<Park> {
  return tx(async c => {
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    await c.query(`UPDATE properties SET name = 'Oak Park', timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    // The tenant pays the processing fee on top (the default).
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 460, unitType: 'mobile_home' })
    await c.query(`UPDATE units SET unit_number = 'MH 25' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c)
    await c.query(`UPDATE tenants SET stripe_customer_id = 'cus_mh25' WHERE id = $1`, [tenantId])
    await c.query(`UPDATE users SET first_name = 'Mae', last_name = 'Twentyfive' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    // The lease's own stamped late fee (S558: billing is pure lease stamp): $25
    // once the 5-day grace has passed.
    const leaseId = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date,
                           late_fee_grace_days, late_fee_initial_type, late_fee_initial_amount)
       VALUES ($1, $2, 460, 'month_to_month', 'active', '2026-04-01', 5, 'flat', 25) RETURNING id`,
      [unitId, landlordId])).rows[0].id
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    return { landlordUserId, landlordId, propertyId, unitId, tenantId, leaseId }
  })
}

const LATE_FEE = 25
const cardFee = (amount: number) => processingFeeFor({ amount, paymentMethod: 'card', cardCountry: 'US' })

async function billFor(p: Park, due: string) {
  return (await db.query<{ id: string; total_amount: string }>(
    `SELECT id, total_amount::text FROM invoices WHERE lease_id = $1 AND due_date = $2`, [p.leaseId, due])).rows[0]
}
async function rowsOn(invoiceId: string) {
  return (await db.query<{ id: string; type: string; amount: string; status: string; issued_credit_amount: string; platform_held: boolean }>(
    `SELECT id, type, amount::text, status, issued_credit_amount::text, platform_held
       FROM payments WHERE invoice_id = $1 ORDER BY type, created_at`, [invoiceId])).rows
}
async function theTen(p: Park) {
  return (await db.query<{ id: string; amount_original: string; amount_remaining: string; funded_by: string; received_at: Date; source_remittance_id: string | null }>(
    `SELECT id, amount_original::text, amount_remaining::text, funded_by, received_at, source_remittance_id
       FROM lease_prepaid_credits WHERE lease_id = $1`, [p.leaseId])).rows
}
async function usesOf(creditId: string) {
  return (await db.query<{ status: string; amount: string; payment_id: string; source: string }>(
    `SELECT status, amount::text, payment_id, source FROM credit_uses WHERE prepaid_credit_id = $1 ORDER BY held_at`, [creditId])).rows
}
async function ownerShares(paymentIds: string[]): Promise<number> {
  return Number((await db.query<{ s: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS s FROM user_balance_ledger
      WHERE reference_type = 'payment' AND type = 'allocation_owner_share' AND reference_id = ANY($1::uuid[])`,
    [paymentIds])).rows[0].s)
}
const received = (p: Park, start: string, end: string) =>
  incomeTotals({ landlordIds: [p.landlordId], start, end, basis: 'received' })
const billed = (p: Park, start: string, end: string) =>
  incomeTotals({ landlordIds: [p.landlordId], start, end, basis: 'billed' })

// ─── the replay ──────────────────────────────────────────────────────────────

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
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
})

describe('MH 25 replay: the $10 goes on the next bill by itself, the landlord is never paid twice', () => {
  // One scripted history, step by step (each `it` continues the one before).
  let p: Park
  let creditId: string
  let julyRowIds: string[] = []
  let augRowIds: string[] = []

  beforeAll(async () => {
    await cleanupAllSchema()
    p = await mh25()
  })

  it('June: a $470 check for $460 rent settles the rent and keeps $10 as money paid ahead that the landlord holds', async () => {
    await generateInvoices(new Date('2026-06-01T15:00:00Z'))          // 8 AM in Phoenix
    const june = await billFor(p, '2026-06-01')
    expect(Number(june.total_amount)).toBe(460)
    const [rent] = await rowsOn(june.id)

    const r = await tx(async c => {
      await lockHousehold(c, p.tenantId, p.landlordId)
      const row = (await c.query<any>(
        `SELECT id, landlord_id, tenant_id, unit_id, lease_id, due_date::text AS due_date FROM payments WHERE id = $1 FOR UPDATE`,
        [rent.id])).rows[0]
      return settleManualRentPayment(c, {
        payment: row, method: 'check', settledAt: new Date('2026-06-03T17:00:00Z'), settleHousehold: true,
        amountTendered: 470, confirmWrittenAmount: true, sendReceipt: false, takenBy: p.landlordUserId,
      })
    })
    expect(r.amountSettled).toBe(460)
    expect(r.surplus).toBe(10)
    expect(r.creditId).toBeTruthy()

    const [ten] = await theTen(p)
    creditId = ten.id
    expect(Number(ten.amount_original)).toBe(10)
    expect(Number(ten.amount_remaining)).toBe(10)
    expect(ten.funded_by).toBe('landlord')
    expect(new Date(ten.received_at).toISOString()).toBe('2026-06-03T17:00:00.000Z')
    expect(ten.source_remittance_id).toBe(r.receiptId)
    // One desk receipt for the whole $470 that was handed over: $460 applied, $10 banked.
    const rec = (await db.query<{ amount: string; unapplied_amount: string; gross_amount: string | null }>(
      `SELECT amount::text, unapplied_amount::text, gross_amount::text FROM tenant_remittances WHERE id = $1`, [r.receiptId])).rows[0]
    expect(Number(rec.amount)).toBe(470)
    expect(Number(rec.unapplied_amount)).toBe(10)
    expect(rec.gross_amount).toBeNull()                // not money that moved through Stripe
    // A check the landlord holds: nothing for GAM to pay out.
    expect(await ownerShares([rent.id])).toBe(0)
    await invariantsHold('June check')
  })

  it('July 1 bill run: the $10 goes on the $460 rent by itself — $450 still owed, the row never cut in two', async () => {
    await generateInvoices(new Date('2026-07-01T15:00:00Z'))
    const july = await billFor(p, '2026-07-01')
    expect(Number(july.total_amount)).toBe(460)
    const rows = await rowsOn(july.id)
    julyRowIds = rows.map(r => r.id)
    expect(rows.map(r => [r.type, Number(r.amount), r.status])).toEqual([['rent', 460, 'pending']])
    expect(Number((await theTen(p))[0].amount_remaining)).toBe(0)
    expect((await usesOf(creditId)).map(u => [u.status, Number(u.amount), u.source, u.payment_id]))
      .toEqual([['applied', 10, 'whole_bill', rows[0].id]])

    emailInvoiceReady.mockClear()
    const sent = await sendPendingInvoiceNotices({ invoiceId: july.id })
    expect(sent.sent).toBe(1)
    const args = emailInvoiceReady.mock.calls[0][1]
    expect(args.total).toBe(450)                       // still owed, after the credit applied
    expect(args.creditApplied).toBe(10)                // one "Credit applied" line under the charges
    expect(args.creditAvailable).toBe(0)               // nothing left to offer
    expect(args.lines).toEqual([expect.objectContaining({ label: 'Rent', amount: 460, covered: false })])
    await invariantsHold('July bill run')
  })

  it('July, Pay Now asks nothing about credit: $450 plus the card fee on $450', async () => {
    const q = await quoteLeaseCharge({ tenantId: p.tenantId, leaseId: p.leaseId, useCredit: false, paymentMethodType: 'card' })
    expect(q.usableCredit).toBe(0)
    expect(q.landing.dueCents).toBe(45000)
    expect(q.fee).toBe(cardFee(450))
    expect(q.total).toBeCloseTo(450 + cardFee(450), 2)
  })

  it('July, the card pays the $450: the payout carries $450 — never the $10 the landlord already holds', async () => {
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    const r = await chargeLeaseBalance({
      tenantId: p.tenantId, leaseId: p.leaseId, chargeEverything: true,
      paymentMethodId: 'pm_card', paymentMethodType: 'card', source: 'portal',
    })
    expect(r.creditUsed).toBe(0)
    const sent = (stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount
    expect(sent).toBeCloseTo(450 + cardFee(450), 2)
    await cardCleared(r.paymentIntentId, r.remittanceId)
    await settledOn(r.paymentIntentId, '2026-07-02T18:00:00Z')

    const rows = await rowsOn((await billFor(p, '2026-07-01')).id)
    expect(rows.map(x => x.status)).toEqual(['settled'])
    expect(rows[0].platform_held).toBe(true)
    expect(await ownerShares(julyRowIds)).toBe(450)
    expect(await heldOwnerShareForUser(p.landlordUserId)).toBe(450)
    await invariantsHold('July card')
  })

  it('reports after July: June received $470 (incl. $10 paid ahead), July received $450; July billed $460 — $450 paid, $10 covered by money paid ahead', async () => {
    const jun = await received(p, '2026-06-01', '2026-06-30')
    expect(jun.total).toBe(470)
    expect(jun.lines.rent).toBe(460)
    expect(jun.lines.paidAhead).toBe(10)
    const jul = await received(p, '2026-07-01', '2026-07-31')
    expect(jul.total).toBe(450)
    expect(jul.lines.paidAhead).toBe(0)
    const julB = await billed(p, '2026-07-01', '2026-07-31')
    expect(julB.total).toBe(460)
    expect(julB.parts.paid).toBe(450)
    expect(julB.parts.coveredByPaidAhead).toBe(10)
    expect(julB.parts.stillOwed).toBe(0)
  })

  it('August: nothing paid ahead is left; unpaid after the grace days, the $25 late fee posts', async () => {
    await generateInvoices(new Date('2026-08-01T15:00:00Z'))
    const aug = await billFor(p, '2026-08-01')
    expect(Number(aug.total_amount)).toBe(460)
    expect(await usesOf(creditId)).toHaveLength(1)    // July's $10 only

    const lf = await generateLateFeesForInvoice(aug.id)
    expect(lf.errors).toEqual([])
    const rows = await rowsOn(aug.id)
    augRowIds = rows.map(r => r.id)
    const fee = rows.filter(r => r.type === 'late_fee')
    expect(fee.map(r => Number(r.amount))).toEqual([LATE_FEE])
    expect((await db.query<{ status: string }>(`SELECT status FROM units WHERE id = $1`, [p.unitId])).rows[0].status).toBe('delinquent')
    await invariantsHold('August late fee')
  })

  it('August, the card pays $460 + $25 plus the fee on $485; the owner share is $485', async () => {
    const q = await quoteLeaseCharge({ tenantId: p.tenantId, leaseId: p.leaseId, useCredit: false, paymentMethodType: 'card' })
    expect(q.usableCredit).toBe(0)
    expect(q.landing.dueCents).toBe((460 + LATE_FEE) * 100)

    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    const r = await chargeLeaseBalance({
      tenantId: p.tenantId, leaseId: p.leaseId, chargeEverything: true,
      paymentMethodId: 'pm_card', paymentMethodType: 'card', source: 'portal',
    })
    const sent = (stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount
    expect(sent).toBeCloseTo(460 + LATE_FEE + cardFee(460 + LATE_FEE), 2)
    await cardCleared(r.paymentIntentId, r.remittanceId)
    await settledOn(r.paymentIntentId, '2026-08-10T18:00:00Z')

    expect(await ownerShares(augRowIds)).toBe(460 + LATE_FEE)
    // Everything GAM owes this landlord: July's $450 + August's $485. Never the $10.
    expect(await heldOwnerShareForUser(p.landlordUserId)).toBe(450 + 460 + LATE_FEE)
    await invariantsHold('August card')
  })

  it('reports after August: received $485; every dollar counts once across the history; nothing paid ahead is unused', async () => {
    const aug = await received(p, '2026-08-01', '2026-08-31')
    expect(aug.total).toBe(460 + LATE_FEE)
    expect(aug.lines.paidAhead).toBe(0)
    expect((await received(p, '2026-06-01', '2026-06-30')).total).toBe(470)
    // $470 + $450 + $485.
    expect((await received(p, '2026-06-01', '2026-08-31')).total).toBe(470 + 450 + 460 + LATE_FEE)

    const augB = await billed(p, '2026-08-01', '2026-08-31')
    expect(augB.total).toBe(460 + LATE_FEE)
    expect(augB.parts.paid).toBe(460 + LATE_FEE)
    expect(augB.parts.coveredByPaidAhead).toBe(0)
    expect(augB.parts.stillOwed).toBe(0)
    const today = new Date().toISOString().slice(0, 10)
    expect(await paidAheadUnusedAt({ landlordIds: [p.landlordId], end: today })).toBe(0)
    // Before any of it was spent, the $10 was on hand at the end of June.
    expect((await received(p, '2026-06-01', '2026-06-30')).paidAheadUnused).toBe(10)
  })
})
