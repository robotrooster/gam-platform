/**
 * S655 money plan Step 16 — one scripted month at one park, every report tied out.
 *
 * Ten households at one landlord pay this month's bill ten different ways
 * (portal bank with saved credit used, card with credit saved, desk cash with
 * change, a check over the bill, money paid ahead last month paying the whole
 * bill by itself, a bank payment that bounces for good, a bank payment still
 * clearing, a posted check that pays ahead, a landlord's goodwill credit used
 * on a card, a bank deposit matched to rent + water + a home payment). Then:
 *
 *   - I1–I9 hold over the whole database;
 *   - I7's money-in half: every dollar that came in this month (Stripe
 *     receipts + desk and posted receipts + the matched bank deposit, each
 *     counted once) = the money part of the landlord rows it settled + new
 *     money paid ahead;
 *   - "Money received" and "Money billed" for the month equal the figures
 *     worked out by hand below from Nic's rules (plan §0.0: money counts the
 *     day it ARRIVED; paid-ahead money counts on arrival and $0 when used; a
 *     credit the landlord gives is never income; billed counts each bill by
 *     its due date);
 *   - Books (P&L), the dashboard's income card and property-health card, the
 *     Reports summary (GET /api/reports/summary: this month's row, the year so
 *     far and its income card) and the month's P&L drill-in
 *     (GET /api/reports/monthly-pl), the agent's P&L tool and the owner
 *     statement all say the same thing the report says.
 *
 * The month is THIS month in Phoenix (the dashboard reads this month), so the
 * file does not depend on the date it runs.
 */
import { vi, describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
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
vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_mock' })) }
    this.customers = { retrieve: vi.fn(async () => ({ id: 'cus_month' })), update: vi.fn(async () => ({})) }
    this.paymentIntents = {
      create: vi.fn(async () => ({ id: 'pi_mock' })), cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
      retrieve: vi.fn(async (id: string) => ({ id, status: 'processing' })), update: vi.fn(async (id: string) => ({ id })),
    }
    this.paymentMethods = {
      retrieve: vi.fn(async (id: string) => (id.startsWith('pm_card')
        ? { id, type: 'card', customer: 'cus_month', card: { country: 'US' } }
        : { id, type: 'us_bank_account', customer: 'cus_month' })),
    }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.balance = { retrieve: vi.fn(async () => ({ available: [{ currency: 'usd', amount: 100_000_000 }] })) }
  }
  return { default: FakeStripe }
})
let piSeq = 0
vi.mock('./stripeConnect', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createRentPlatformCharge: vi.fn(async () => ({ id: `pi_month_${++piSeq}`, status: 'processing' })),
}))

import { db, getClient } from '../db'
import { webhooksRouter } from '../routes/webhooks'
import { booksRouter } from '../routes/books'
import { landlordsRouter } from '../routes/landlords'
import { reportsRouter } from '../routes/reports'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule } from '../test/dbHelpers'
import { todayIn } from '../lib/timezone'
import { settleManualRentPayment } from './manualPaymentSettle'
import { postTenantPayment } from './postPayment'
import { lockHousehold } from './moneyPredicates'
import { chargeLeaseBalance } from './rentCharge'
import { createPaidAhead, createIssuedCredit, runWholeBillCheckAfterCommit } from './creditUse'
import { confirmDepositMatch } from './bankDepositConfirm'
import { heldOwnerShareForUser } from './landlordPassthrough'
import { incomeTotals, categoryTotals } from './incomeBasis'
import { computeLandlordPL } from './landlordPL'
import { incomeCardMtd } from '../lib/rentCollected'
import { ownerStatement } from './ownerStatement'
import { getProfitAndLoss } from './agents/tools/getProfitAndLoss'
import { checkMoneyInvariants } from '../scripts/oct3_money_invariants_check'

// ─── the month ──────────────────────────────────────────────────────────────

const TODAY = todayIn('America/Phoenix')
const MONTH = TODAY.slice(0, 7)
const DUE = `${MONTH}-01`
const MONTH_END = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)).toISOString().slice(0, 10)
const prev = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)) - 2, 15))
const LAST_MONTH_15 = `${prev.toISOString().slice(0, 10)}T17:00:00Z`
const LAST_MONTH = prev.toISOString().slice(0, 7)

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

function app() {
  const a = express()
  a.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  a.use('/webhooks', webhooksRouter)
  a.use(express.json())
  a.use('/api/books', booksRouter)
  a.use('/api/landlords', landlordsRouter)
  a.use('/api/reports', reportsRouter)
  a.use(errorHandler)
  return a
}
async function hook(body: Record<string, unknown>): Promise<void> {
  const res = await request(app()).post('/webhooks/stripe')
    .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub').send(JSON.stringify(body))
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}
const succeeded = (pi: string, method: 'us_bank_account' | 'card') => hook({
  id: `evt_ok_${pi}`, type: 'payment_intent.succeeded',
  data: { object: { id: pi, metadata: {}, payment_method_types: [method],
    latest_charge: { id: `ch_${pi}`, payment_method_details: { type: method, ...(method === 'card' ? { card: { country: 'US' } } : {}) } } } },
})
const bankFailed = (pi: string, code: string) => hook({
  id: `evt_fail_${pi}_${code}`, type: 'payment_intent.payment_failed',
  data: { object: { id: pi, metadata: {}, payment_method_types: ['us_bank_account'],
    last_payment_error: { payment_method_details: { us_bank_account: { return_details: { code } } } } } },
})

interface Park { landlordUserId: string; landlordId: string; propertyId: string; token: string }
interface H { tenantId: string; leaseId: string; unitId: string; name: string }

async function park(): Promise<Park> {
  return tx(async c => {
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    await c.query(`UPDATE properties SET name = 'Scripted Park', timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const token = jwt.sign({ userId: landlordUserId, role: 'landlord', email: 'park@t.dev', profileId: landlordId,
      landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordUserId, landlordId, propertyId, token }
  })
}

async function household(p: Park, name: string, rent: number): Promise<H> {
  return tx(async c => {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, rentAmount: rent })
    const tenantId = await seedTenant(c)
    const [first, last] = name.split(' ')
    await c.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
    await c.query(`UPDATE tenants SET stripe_customer_id = 'cus_month', ach_verified = TRUE WHERE id = $1`, [tenantId])
    const leaseId = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1, $2, $3, 'month_to_month', 'active', '2026-01-01') RETURNING id`, [unitId, p.landlordId, rent])).rows[0].id
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    return { tenantId, leaseId, unitId, name }
  })
}

async function bill(p: Park, h: H, type: string, amount: number): Promise<string> {
  const entry = ({ rent: 'RENT', utility: 'UTILITY', home_payment: 'HOMEPMT' } as Record<string, string>)[type]
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING id`,
    [h.unitId, h.leaseId, h.tenantId, p.landlordId, type, amount.toFixed(2), DUE, entry])).rows[0].id
}

const payOnline = (h: H, method: 'ach' | 'card', credit: { use: boolean; expected: number } | null, amount?: number) =>
  chargeLeaseBalance({
    tenantId: h.tenantId, leaseId: h.leaseId, ...(amount != null ? { amount } : { chargeEverything: true }),
    paymentMethodId: method === 'card' ? 'pm_card' : 'pm_bank', paymentMethodType: method, source: 'portal', credit,
  })

async function desk(p: Park, h: H, anchor: string, o: Record<string, unknown>) {
  const r = await tx(async c => {
    await lockHousehold(c, h.tenantId, p.landlordId)
    const row = (await c.query<any>(
      `SELECT id, landlord_id, tenant_id, unit_id, lease_id, due_date::text AS due_date FROM payments WHERE id = $1 FOR UPDATE`, [anchor])).rows[0]
    return settleManualRentPayment(c, { payment: row, settledAt: null, settleHousehold: true, sendReceipt: false, takenBy: p.landlordUserId, ...(o as any) })
  })
  await r.afterCommit()
  return r
}

/** I1–I9 over the whole database. */
async function invariantsHold(step: string): Promise<void> {
  const c = await getClient()
  try {
    const report = await checkMoneyInvariants(c)
    const broken = report.results.filter(r => r.violations > 0).map(r => ({ id: r.id, sample: r.sample.slice(0, 3) }))
    expect({ step, broken }).toEqual({ step, broken: [] })
  } finally { c.release() }
}

const r2 = (n: number) => Math.round(n * 100) / 100

// ─── the scripted month ─────────────────────────────────────────────────────

describe('one scripted month at one park: invariants, money in, and every report tie out', () => {
  let p: Park

  beforeAll(async () => {
    await cleanupAllSchema()
    process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_scripted_month'
    for (const [method, flat, pct, sflat, spct] of [['ach', 6, 0, 0, 0.5], ['card', 0.55, 3.5, 0.26, 0.7]] as const) {
      await db.query(
        `INSERT INTO platform_processing_rates
           (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
         SELECT $1, $2, $3, $4, $5
          WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = $1 AND effective_until IS NULL)`,
        [method, flat, pct, sflat, spct])
    }
    p = await park()

    // A — bank, "Use all $10" of money paid ahead LAST month (the landlord took it).
    const a = await household(p, 'Ada Bank', 460)
    await bill(p, a, 'rent', 460); await bill(p, a, 'utility', 40)
    await tx(c => createPaidAhead(c, { leaseId: a.leaseId, tenantId: a.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: LAST_MONTH_15 }))
    const ra = await payOnline(a, 'ach', { use: true, expected: 10 })
    await succeeded(ra.paymentIntentId, 'us_bank_account')

    // B — card, nothing saved.
    const b = await household(p, 'Ben Card', 500)
    await bill(p, b, 'rent', 500)
    const rb = await payOnline(b, 'card', null)
    await succeeded(rb.paymentIntentId, 'card')

    // C — desk cash, $500 handed over for $460, $40 change.
    const c = await household(p, 'Cy Cash', 460)
    const cRent = await bill(p, c, 'rent', 460)
    await desk(p, c, cRent, { method: 'cash', amountTendered: 500, surplusHandling: 'change' })

    // D — a $470 check for $460: $10 paid ahead (the MH 25 shape).
    const d = await household(p, 'Dee Check', 460)
    const dRent = await bill(p, d, 'rent', 460)
    await desk(p, d, dRent, { method: 'check', amountTendered: 470, confirmWrittenAmount: true })

    // E — Todd: last month's two-month check covers this whole bill; it pays itself.
    const e = await household(p, 'Todd Ahead', 460)
    await tx(cl => createPaidAhead(cl, { leaseId: e.leaseId, tenantId: e.tenantId, amount: 460, fundedBy: 'landlord', receivedAt: LAST_MONTH_15 }))
    await bill(p, e, 'rent', 460)
    await runWholeBillCheckAfterCommit({ tenantId: e.tenantId, landlordId: p.landlordId })

    // F — a bank payment the bank refuses for good (account closed): still owed.
    const f = await household(p, 'Fay Bounce', 460)
    await bill(p, f, 'rent', 460)
    const rf = await payOnline(f, 'ach', null)
    await bankFailed(rf.paymentIntentId, 'R02')

    // G — a bank payment still clearing.
    const g = await household(p, 'Gus Clearing', 460)
    await bill(p, g, 'rent', 460)
    await payOnline(g, 'ach', null)

    // H — the landlord posts a $1,000 check: $460 rent, $540 paid ahead.
    const h = await household(p, 'Hal Posted', 460)
    await bill(p, h, 'rent', 460)
    const ph = await tx(cl => postTenantPayment(cl, {
      tenantId: h.tenantId, landlordIds: [p.landlordId], method: 'check', amount: 1000, receivedAt: null, postedBy: p.landlordUserId }))
    await ph.afterCommit()

    // I — a $50 goodwill credit from the landlord, used on a card.
    const i = await household(p, 'Ivy Goodwill', 460)
    await bill(p, i, 'rent', 460)
    await tx(cl => createIssuedCredit(cl, { landlordId: p.landlordId, tenantId: i.tenantId, leaseId: i.leaseId, amount: 50,
      category: 'goodwill', reason: 'Sorry about the water outage', createdBy: p.landlordUserId }))
    const ri = await payOnline(i, 'card', { use: true, expected: 50 })
    await succeeded(ri.paymentIntentId, 'card')

    // J — MH 21's shape: one $815 bank deposit for rent $450 + water $165 + home payment $200.
    const j = await household(p, 'Jo Deposit', 450)
    const jIds = [await bill(p, j, 'rent', 450), await bill(p, j, 'utility', 165), await bill(p, j, 'home_payment', 200)]
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, created_at) VALUES ($1,'stripe_fc','active', NOW() - interval '90 days') RETURNING id`,
      [p.landlordId])).rows[0].id
    const txn = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,$3,$4::date,815,'MOBILE DEPOSIT','needs_review') RETURNING id`,
      [conn, p.landlordId, randomUUID(), TODAY])).rows[0].id
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: jIds, method: 'check', confirmedByUserId: p.landlordUserId })
  })

  // Worked out by hand from the rules (see the file header).
  const RECEIVED = {
    // A 450 + B 500 + C 460 + D 460 + H 460 + I 410 (460 less the $50 the landlord gave) + J 450
    rent: 3190,
    utilities: 40 + 165,
    homeSale: 200,
    // D's $10 over the check + H's $540 posted ahead. A's $10 and Todd's $460
    // arrived LAST month and count $0 now.
    paidAhead: 10 + 540,
    total: 3190 + 205 + 200 + 550,
    clearing: 460,           // G, beside the total
    creditsYouGave: 50,      // I, beside the total
  }
  const BILLED = {
    // Every bill due this month: A 500, B 500, C/D/E/F/G/H/I 460 each, J 815; less the $50 credit given.
    total: 500 + 500 + 7 * 460 + 815 - 50,
    paid: 490 + 500 + 460 + 460 + 460 + 410 + 815,     // A B C D H I J, money only
    coveredByPaidAhead: 10 + 460,                     // A's $10, Todd's $460
    clearing: 460,                                    // G
    stillOwed: 460,                                   // F
  }
  // What GAM holds and pays out: the money that came through Stripe (A, B, I).
  const PAYOUT = 490 + 500 + 410

  it('I1–I9 hold after the scripted month', async () => {
    await invariantsHold('scripted month')
  })

  it('money in = money part of the landlord rows it settled + new money paid ahead (I7, money-in half)', async () => {
    const moneyIn = Number((await db.query<{ s: string }>(
      `SELECT COALESCE(SUM(r.amount), 0)::text AS s FROM tenant_remittances r
        WHERE r.landlord_id = $1 AND r.status = 'settled'`, [p.landlordId])).rows[0].s)
    const moneyPart = Number((await db.query<{ s: string }>(
      `SELECT COALESCE(SUM(vm.money_part), 0)::text AS s FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
        WHERE p.landlord_id = $1 AND p.status = 'settled'`, [p.landlordId])).rows[0].s)
    const newPaidAhead = Number((await db.query<{ s: string }>(
      `SELECT COALESCE(SUM(c.amount_original), 0)::text AS s FROM lease_prepaid_credits c JOIN leases l ON l.id = c.lease_id
        WHERE l.landlord_id = $1 AND c.received_at >= $2::date`, [p.landlordId, DUE])).rows[0].s)
    expect(r2(moneyIn)).toBe(RECEIVED.total)
    expect(r2(moneyPart + newPaidAhead)).toBe(RECEIVED.total)
    expect(r2(newPaidAhead)).toBe(RECEIVED.paidAhead)
  })

  it('the payout carries only money GAM holds', async () => {
    expect(await heldOwnerShareForUser(p.landlordUserId)).toBe(PAYOUT)
  })

  it('Money received for the month equals the hand-worked figures', async () => {
    const t = await incomeTotals({ landlordIds: [p.landlordId], start: DUE, end: MONTH_END, basis: 'received' })
    expect({
      rent: t.lines.rent, utilities: t.lines.utilities, homeSale: t.lines.homeSale, paidAhead: t.lines.paidAhead,
      total: t.total, clearing: t.beside.clearing, creditsYouGave: t.beside.creditsYouGave,
    }).toEqual(RECEIVED)
    // Last month: the two arrivals that pay this month's bills, counted when they arrived.
    const last = await incomeTotals({ landlordIds: [p.landlordId], start: `${LAST_MONTH}-01`, end: `${LAST_MONTH}-28`, basis: 'received' })
    expect(last.lines.paidAhead).toBe(10 + 460)
    // Paid ahead and not used yet at the month's end: D's $10 and H's $540.
    expect(t.paidAheadUnused).toBe(550)
  })

  it('Money billed for the month equals the hand-worked figures, and its parts add up to it', async () => {
    const t = await incomeTotals({ landlordIds: [p.landlordId], start: DUE, end: MONTH_END, basis: 'billed' })
    expect({
      total: t.total, paid: t.parts.paid, coveredByPaidAhead: t.parts.coveredByPaidAhead,
      clearing: t.parts.clearing, stillOwed: t.parts.stillOwed,
    }).toEqual(BILLED)
    expect(t.lines.creditsGiven).toBe(-50)
    expect(r2(Object.values(t.parts).reduce((s, x) => s + x, 0))).toBe(t.total)
  })

  it('Books, the Reports P&L, the agent\'s P&L and the owner statement agree with the report, both ways', async () => {
    for (const basis of ['received', 'billed'] as const) {
      const want = basis === 'received' ? RECEIVED.total : BILLED.total
      const pl = await computeLandlordPL(p.landlordId, DUE, MONTH_END, [`${MONTH}-01`], basis)
      expect(pl.gross.total).toBe(want)

      const books = await request(app()).get(`/api/books/reports/pl?startDate=${DUE}&endDate=${MONTH_END}&basis=${basis}`)
        .set('Authorization', `Bearer ${p.token}`)
      expect(books.status, JSON.stringify(books.body)).toBe(200)
      expect(books.body.data.gamRentIncome).toBe(want)

      const agent: any = await getProfitAndLoss.execute(
        { year: Number(MONTH.slice(0, 4)), month: Number(MONTH.slice(5, 7)), basis },
        { userId: p.landlordUserId, role: 'landlord', profileId: '', landlordIds: [p.landlordId] } as any)
      expect(agent.ok).toBe(true)
      expect(Number(String(agent.income.total).replace(/[$,]/g, ''))).toBe(want)
    }
    const st = await ownerStatement({ landlordId: p.landlordId, periodMonth: MONTH })
    // Through GAM ties to the owner share; the rest the landlord took directly.
    expect(st.totals.collectedThroughGam).toBe(PAYOUT)
    expect(st.totals.ownerShare).toBe(PAYOUT)
    expect(r2(st.totals.collectedThroughGam + st.totals.collectedDirectly)).toBe(st.totals.grossCollected)
    expect(st.totals.grossCollected).toBe(RECEIVED.total)
    expect(st.totals.billed.billed).toBe(BILLED.total)
  })

  it('the Reports summary (this month\'s row, the income card) and the month\'s P&L drill-in agree with the report, both ways', async () => {
    for (const basis of ['received', 'billed'] as const) {
      const want = basis === 'received' ? RECEIVED.total : BILLED.total
      const sum = await request(app()).get(`/api/reports/summary?basis=${basis}`).set('Authorization', `Bearer ${p.token}`)
      expect(sum.status, JSON.stringify(sum.body).slice(0, 500)).toBe(200)
      const row = sum.body.data.monthly.find((m: any) => m.month === MONTH)
      expect(row, `no ${MONTH} row on the Reports summary`).toBeTruthy()
      expect(row.collected).toBe(want)
      expect(sum.body.data.incomeCard.received).toEqual({ amount: RECEIVED.total, paidAhead: RECEIVED.paidAhead, clearing: RECEIVED.clearing })
      expect(sum.body.data.incomeCard.billed).toEqual({
        amount: BILLED.total, collected: BILLED.paid + BILLED.coveredByPaidAhead, clearing: BILLED.clearing, stillOwed: BILLED.stillOwed,
      })
      expect(sum.body.data.ytdMonthly.find((m: any) => m.month === MONTH)?.collected).toBe(want)

      const pl = await request(app())
        .get(`/api/reports/monthly-pl?year=${Number(MONTH.slice(0, 4))}&month=${Number(MONTH.slice(5, 7))}&basis=${basis}`)
        .set('Authorization', `Bearer ${p.token}`)
      expect(pl.status, JSON.stringify(pl.body).slice(0, 500)).toBe(200)
      expect(pl.body.data.gross.total).toBe(want)
      // The drill-in opens the row: the same figure, never a second one.
      expect(pl.body.data.gross.total).toBe(row.collected)
    }
  })

  it('the dashboard\'s income card and property-health card agree with the report, both ways', async () => {
    const card = await incomeCardMtd([p.landlordId], null, 'received', TODAY)
    expect(card.received).toEqual({ amount: RECEIVED.total, paidAhead: RECEIVED.paidAhead, clearing: RECEIVED.clearing })
    expect(card.billed).toEqual({
      amount: BILLED.total,
      collected: BILLED.paid + BILLED.coveredByPaidAhead,
      clearing: BILLED.clearing,
      stillOwed: BILLED.stillOwed,
    })
    for (const basis of ['received', 'billed'] as const) {
      const dash = await request(app()).get(`/api/landlords/me/dashboard?basis=${basis}`).set('Authorization', `Bearer ${p.token}`)
      expect(dash.status, JSON.stringify(dash.body).slice(0, 500)).toBe(200)
      const data = dash.body.data
      expect(data.property_health.period).toBe(MONTH)
      const report = await categoryTotals({ landlordIds: [p.landlordId], start: DUE, end: MONTH_END, basis })
      expect(data.property_health.total).toBe(report.total)
      expect(data.income_card.received.amount).toBe(RECEIVED.total)
      expect(data.income_card.billed.amount).toBe(BILLED.total)
    }
  })
})

// ─── the checks themselves ──────────────────────────────────────────────────

/**
 * A check that can never fail proves nothing. Each of these writes the one
 * thing its invariant forbids — straight to the tables, the way a bug would —
 * and the check must name it.
 */
describe('the invariant checks catch what they guard', () => {
  let p: Park
  let h: H
  beforeAll(async () => {
    await cleanupAllSchema()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_scripted_month'
    p = await park()
    h = await household(p, 'Ivan Variant', 460)
  })
  const violationsOf = async (id: 'I1' | 'I5' | 'I8' | 'I9') => {
    const c = await getClient()
    try { return (await checkMoneyInvariants(c, { only: [id] })).results[0] } finally { c.release() }
  }

  it('I9 names credit held more than 10 days with no retry scheduled or in flight', async () => {
    const rent = await bill(p, h, 'rent', 460)
    const credit = await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: LAST_MONTH_15 }))
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,450,450,'ach','pi_stale_hold','processing') RETURNING id`, [h.tenantId, h.leaseId, p.landlordId])).rows[0].id
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_stale_hold' WHERE id = $1`, [rent])
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status, held_at)
       VALUES ($1,$2,$3,$4,10,$5::date,'portal','held', NOW() - interval '11 days')`, [credit, rent, rem, h.leaseId, DUE])
    expect((await violationsOf('I9')).violations).toBe(0)       // still clearing: fine
    // The bank's answer was lost: the row failed and nothing will retry it.
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = NULL WHERE id = $1`, [rent])
    expect((await violationsOf('I9')).violations).toBe(1)
  })

  it('I8 names an unpaid owner share on a row GAM does not hold', async () => {
    const rent = await bill(p, h, 'rent', 460)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash', platform_held = FALSE WHERE id = $1`, [rent])
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type)
       VALUES ($1,'allocation_owner_share',460,460,$2,'payment')`, [p.landlordUserId, rent])
    const r = await violationsOf('I8')
    expect(r.violations).toBe(1)
    expect(r.sample[0].payment_id).toBe(rent)
  })

  it('I5 names an owner share the landlord keeps that is more than the money GAM holds on the row', async () => {
    const rent = await bill(p, await household(p, 'Ola Over', 460), 'rent', 460)
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW(), stripe_payment_intent_id = 'pi_i5_over',
              stripe_charge_id = 'ch_i5_over', platform_held = TRUE WHERE id = $1`, [rent])
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type)
       VALUES ($1,'allocation_owner_share',500,500,$2,'payment')`, [p.landlordUserId, rent])
    const r = await violationsOf('I5')
    expect(r.sample.map(x => x.payment_id)).toContain(rent)
  })

  it('I1 names a credit balance moved outside the ledger — or, once C0 is in, the database refuses the write', async () => {
    const credit = await tx(c => createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 25, fundedBy: 'landlord', receivedAt: LAST_MONTH_15 }))
    let refused: string | null = null
    try {
      await db.query(`UPDATE lease_prepaid_credits SET amount_remaining = 5 WHERE id = $1`, [credit])
    } catch (e: any) { refused = String(e?.message ?? e) }
    if (refused) {
      expect(refused).toMatch(/moves only through credit_uses/)
    } else {
      const r = await violationsOf('I1')
      expect(r.sample.some(x => x.id === credit)).toBe(true)
    }
  })
})

describe('I5 on a disputed row', () => {
  let p: Park
  beforeAll(async () => {
    await cleanupAllSchema()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_scripted_month'
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mocked'
    process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_mocked'
    for (const [method, flat, pct, sflat, spct] of [['ach', 6, 0, 0, 0.5], ['card', 0.55, 3.5, 0.26, 0.7]] as const) {
      await db.query(
        `INSERT INTO platform_processing_rates
           (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
         SELECT $1, $2, $3, $4, $5
          WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = $1 AND effective_until IS NULL)`,
        [method, flat, pct, sflat, spct])
    }
    p = await park()
  })
  const i5 = async () => {
    const c = await getClient()
    try { return (await checkMoneyInvariants(c, { only: ['I5'] })).results[0] } finally { c.release() }
  }
  const flagged = async (paymentId: string) => (await i5()).sample.some(x => x.payment_id === paymentId)
  const shares = async (rent: string) => Number((await db.query<{ s: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS s FROM user_balance_ledger
      WHERE reference_type = 'payment' AND reference_id = $1 AND type = 'allocation_owner_share'`, [rent])).rows[0].s)
  /** One household's $460 rent paid by card and allocated. */
  const cardPaidRent = async (name: string) => {
    const d = await household(p, name, 460)
    const rent = await bill(p, d, 'rent', 460)
    const paid = await payOnline(d, 'card', null)
    await succeeded(paid.paymentIntentId, 'card')
    expect(await shares(rent)).toBeGreaterThan(0)
    expect(await flagged(rent)).toBe(false)
    return { rent, pi: paid.paymentIntentId, chargeCents: Math.round(paid.chargeAmount * 100) }
  }
  const dispute = (pi: string, amountCents: number) => hook({
    id: `evt_dispute_${pi}`, type: 'charge.dispute.created',
    data: { object: { id: `du_${pi}`, object: 'dispute', charge: `ch_${pi}`, payment_intent: pi,
      amount: amountCents, currency: 'usd', status: 'needs_response', reason: 'fraudulent',
      balance_transactions: [{ fee: 1500 }] } },
  })
  const rowAfter = async (rent: string) => (await db.query<{ status: string; held: string; recovered: string; reversed: string }>(
    `SELECT p.status, vm.gam_held_part::text AS held,
            (SELECT COALESCE(SUM(r.recovered_amount), 0) FROM payment_reversals r WHERE r.payment_id = p.id)::text AS recovered,
            (SELECT COALESCE(SUM(r.reversed_amount), 0) FROM payment_reversals r WHERE r.payment_id = p.id)::text AS reversed
       FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id WHERE p.id = $1`, [rent])).rows[0]

  // A disputed row reads gam_held_part 0 now, while the owner share booked when
  // it settled stays on the ledger. I5 measures such a row by what GAM held for
  // the landlord when it settled; the give-back is the recovery's job. Before
  // the fix the check named every dispute as a violation.
  it('a settled, allocated card payment that was disputed and recovered gives no I5 violation', async () => {
    const { rent, pi, chargeCents } = await cardPaidRent('Dee Dispute')
    const booked = await shares(rent)
    // The tenant disputes the whole card charge before the Tuesday payout.
    await dispute(pi, chargeCents)
    const after = await rowAfter(rent)
    // The case is real: the booked share is still on the ledger and is more
    // than the money GAM now holds on the row; the withheld share is recovered.
    expect(after.status).not.toBe('settled')
    expect(Number(after.held)).toBe(0)
    expect(await shares(rent)).toBe(booked)
    expect(Number(after.recovered)).toBe(booked)
    expect(await flagged(rent)).toBe(false)
  })

  it('a dispute after the payout, its recovery from the landlord still pending, gives no I5 violation', async () => {
    const { rent, pi, chargeCents } = await cardPaidRent('Pat Paidout')
    // The Tuesday batch already paid the share out.
    await db.query(
      `UPDATE user_balance_ledger SET stripe_transfer_id = 'tr_i5_paid_out'
        WHERE reference_type = 'payment' AND reference_id = $1 AND type = 'allocation_owner_share'`, [rent])
    await dispute(pi, chargeCents)
    const after = await rowAfter(rent)
    expect(after.status).not.toBe('settled')
    // Nothing was withheld (it was paid out): the recovery is still to come.
    expect(Number(after.recovered)).toBeLessThan(Number(after.reversed))
    expect(await flagged(rent)).toBe(false)
  })

  it('a dispute of part of the charge gives no I5 violation, and the part the tenant still paid stays the landlord\'s', async () => {
    const { rent, pi, chargeCents } = await cardPaidRent('Penny Partial')
    await dispute(pi, Math.round(chargeCents / 2))
    expect((await rowAfter(rent)).status).not.toBe('settled')
    const untouched = Number((await db.query<{ s: string }>(
      `SELECT COALESCE(SUM(h.amount), 0)::text AS s FROM held_payout_items h
        WHERE h.source_type = 'dispute' AND h.source_id IN (
          SELECT 'owner_share_untouched:' || r.id FROM payment_reversals r WHERE r.payment_id = $1)`, [rent])).rows[0].s)
    expect(untouched).toBeGreaterThan(0)
    expect(await flagged(rent)).toBe(false)
  })

  it('names a share booked over the GAM-first money the landlord never receives, before and after a dispute', async () => {
    const ok = await bill(p, await household(p, 'Gus Gamfirst', 460), 'rent', 460)
    const over = await bill(p, await household(p, 'Gail Gamfirst', 460), 'rent', 460)
    for (const [row, share] of [[ok, 400], [over, 460]] as const) {
      // $60 of each $460 card charge paid the tenant's GAM balance first.
      await db.query(
        `UPDATE payments SET status = 'settled', settled_at = NOW(), stripe_payment_intent_id = $2,
                stripe_charge_id = $3, platform_held = TRUE, gam_supersedence_amount = 60 WHERE id = $1`,
        [row, `pi_i5_g_${share}`, `ch_i5_g_${share}`])
      await db.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type)
         VALUES ($1,'allocation_owner_share',$3,$3,$2,'payment')`, [p.landlordUserId, row, share])
    }
    expect(await flagged(ok)).toBe(false)
    expect(await flagged(over)).toBe(true)
    // Disputed: the recovery (which counts the GAM-first money) never hides it.
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = ANY($1::uuid[])`, [[ok, over]])
    for (const row of [ok, over]) {
      await db.query(
        `INSERT INTO payment_reversals (payment_id, landlord_id, reversal_type, reversed_amount, stripe_event_id, raw_event,
                                        recovery_status, recovered_amount)
         VALUES ($1,$2,'card_dispute',460,$3,'{}'::jsonb,'recovered',460)`, [row, p.landlordId, `evt_i5_g_${row}`])
    }
    expect(await flagged(ok)).toBe(false)
    expect(await flagged(over)).toBe(true)
  })
})
