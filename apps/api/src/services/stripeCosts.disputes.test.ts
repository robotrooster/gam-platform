/**
 * 10/4 (review, pass 3) — GAM's Own Money checks itself through real disputes.
 *
 * A payment Stripe takes back after it settled moves money on GAM's balance in
 * several parts at once: the payment's money, the fee on top, Stripe's dispute
 * fee, and what the landlord is charged back on a later payout. The check has
 * to follow what the code that handles the dispute ACTUALLY records
 * (paymentReversal.handlePaymentReversal, heldPayouts.recordChargeback), so
 * these run the real webhook end to end: a card payment settles (real
 * allocation, real owner share, Stripe's cost from the rate table), the
 * landlord is paid out (the real weekly batch), the payer disputes it (the real
 * dispute handler), and the landlord's next payout nets it back (the real
 * netting). The Stripe balance is kept beside it the way Stripe would move it,
 * and the check must read no difference at every step.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import express from 'express'
import request from 'supertest'

vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_' + Math.random().toString(36).slice(2, 10) })) }
    this.customers = { retrieve: vi.fn(async () => ({})), update: vi.fn(async () => ({})) }
    this.paymentIntents = { create: vi.fn(async () => ({ id: 'pi_mock' })), cancel: vi.fn(async (id: string) => ({ id })) }
    this.paymentMethods = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
    // What the weekly batch may claim: plenty (the cap is not what these test).
    this.balance = { retrieve: vi.fn(async () => ({ available: [{ currency: 'usd', amount: 100_000_00 }], pending: [] })) }
  }
  return { default: FakeStripe }
})

import { webhooksRouter } from '../routes/webhooks'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  disputeFeeReturnedOnWinCents, loadPlatformBalanceBook, marginForMonth, splitPlatformBalance, wonChargebackReturnSourceId, wonDisputeFeeReturnSourceId, type PlatformStripeLive,
} from './stripeCosts'
import { disputeFeeLineSql, disputeShareLineSql } from './paymentReversal'
import { PROCESSING_MARGIN_ON_THE_BOOK_SQL, recordPlatformRevenue, trueUpProcessingMargin } from './platformRevenue'
import { reconcilePlatformHeldPayments } from './landlordPassthrough'
import { insertPosSale } from './posSale'

function buildApp() {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  return app
}
const post = (body: unknown) => request(buildApp()).post('/webhooks/stripe')
  .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=stub').send(JSON.stringify(body))

const c2 = (n: number) => Math.round(n * 100)

/** The Stripe balance, moved the way Stripe moves it, in cents. */
let onBalance = 0
const liveNow = (): PlatformStripeLive => ({
  available: onBalance / 100, pending: 0, clearingOnBalance: {}, paidOutToGamBank: 0, costsNotYetRecorded: 0,
})
/** What Stripe charged GAM, recorded as the nightly sync records it, and taken off the balance. */
async function stripeCharges(id: string, txnType: string, category: string, amount: number) {
  await db.query(
    `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at)
     VALUES ($1, $2, $3, $4, NOW())`, [id, txnType, category, amount])
  onBalance -= c2(amount)
}
const check = async () => splitPlatformBalance(await loadPlatformBalanceBook(), liveNow())

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM stripe_processing_costs`)
  await db.query(`DELETE FROM platform_revenue_ledger`)
  await db.query(`DELETE FROM connect_disputes`)
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
  // Card: 3.5% + $0.55 to the payer on top; Stripe's cost for the book, 1% + $0.26.
  await db.query(`DELETE FROM platform_processing_rates WHERE payment_method = 'card'`)
  await db.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
     VALUES ('card', 0.55, 3.5, 0.26, 1.0)`)
  onBalance = 0
})

interface H {
  landlordId: string; landlordUserId: string; tenantId: string; propertyId: string; unitId: string; leaseId: string
}

async function household(): Promise<H> {
  const c = await getClient()
  try {
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(`UPDATE users SET stripe_connect_account_id = 'acct_disputes' WHERE id = $1`, [landlordUserId])
    return { landlordId, landlordUserId, tenantId, propertyId, unitId, leaseId }
  } finally { c.release() }
}

/** The landlord's next rent is due within the netting window (or not): the dispute recovery nets from it, or pulls. */
async function nextRentDue(h: H, soon: boolean) {
  await db.query(
    `UPDATE leases SET rent_due_day = CASE WHEN $2
        THEN EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Phoenix'))::int
        ELSE EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Phoenix') + interval '14 days')::int END
      WHERE id = $1`, [h.leaseId, soon])
}

async function rentRow(h: H, amount: number, due: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, revenue_owner)
     VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',$6::date,'landlord') RETURNING id`,
    [h.unitId, h.leaseId, h.tenantId, h.landlordId, amount, due])).rows[0].id
}

/** A card payment of `money` (+ 3.5% + $0.55 on top) for the rows, settled through the webhook; Stripe's day cost posts. */
async function payByCard(h: H, pi: string, rowIds: string[], money: number, stripeDayCost: number): Promise<number> {
  const fee = Math.round((0.55 + money * 0.035) * 100) / 100
  const rem = (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                     payment_method, gross_amount, processing_fee_amount)
     VALUES ($1,$2,$3,$4,$4,0,'card',$5,$6) RETURNING id`,
    [h.tenantId, h.leaseId, h.landlordId, money, money + fee, fee])).rows[0].id
  await db.query(`UPDATE payments SET status = 'processing', platform_held = TRUE, stripe_payment_intent_id = $2 WHERE id = ANY($1::uuid[])`, [rowIds, pi])
  await db.query(`UPDATE tenant_remittances SET stripe_payment_intent_id = $2 WHERE id = $1`, [rem, pi])
  const res = await post({
    id: 'evt_ok_' + pi, type: 'payment_intent.succeeded',
    data: { object: { id: pi, amount_received: c2(money + fee), metadata: { gam_remittance_id: rem }, payment_method_types: ['card'],
      latest_charge: { id: 'ch_' + pi, payment_method_details: { type: 'card', card: { country: 'US' } } } } },
  })
  expect(res.status).toBe(200)
  onBalance += c2(money + fee)
  await stripeCharges('n_' + pi, 'network_cost', 'card_interchange', stripeDayCost)
  return fee
}

/** The weekly batch: whatever it sends to the landlord leaves the balance. */
async function payout(h: H): Promise<number> {
  const r = await reconcilePlatformHeldPayments(h.landlordUserId)
  onBalance -= c2(r.amount)
  return r.amount
}

/** The payer disputes the charge: Stripe takes the disputed amount and its $15 fee off the balance. */
async function dispute(pi: string, amount: number) {
  const res = await post({
    id: 'evt_dispute_' + pi, type: 'charge.dispute.created',
    data: { object: { id: 'du_' + pi, object: 'dispute', charge: 'ch_' + pi, payment_intent: pi, amount: c2(amount),
      currency: 'usd', status: 'needs_response', reason: 'fraudulent', balance_transactions: [{ fee: 1500 }] } },
  })
  expect(res.status).toBe(200)
  onBalance -= c2(amount)
  await stripeCharges('txn_du_' + pi + ':fee', 'adjustment', 'other', 15)
}

describe('GAM\'s Own Money through a disputed card payment (10/4 review, pass 3)', () => {
  it('a disputed card payment the landlord was paid for: the check ties after the dispute and again once the landlord\'s next payout nets it back', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    const fee = await payByCard(h, 'pi_oct', [oct], 460, 6)
    expect(fee).toBe(16.65)
    expect(await payout(h)).toBe(460)
    expect((await check()).reconciliation).toMatchObject({ gap: 0 })

    await nextRentDue(h, true)
    await dispute('pi_oct', 476.65)
    // What the dispute handling recorded: the rent reopened and owed back by the
    // landlord, and — decisions #38 Q4 (DISPUTE_FEE_RULE 'landlord_bears_whole_fee')
    // — the WHOLE fee the dispute gave back to the payer ($16.65) charged to the
    // landlord's next payout: GAM keeps the fee it earned and absorbs nothing.
    const kept = (await db.query<{ a: string }>(
      `SELECT (-amount)::text AS a FROM held_payout_items WHERE source_type = 'dispute' AND landlord_id = $1`, [h.landlordId])).rows
    expect(kept).toEqual([{ a: '16.65' }])
    const after = await check()
    expect(after.reconciliation!.takenBack).toEqual({
      feesGivenBack: 16.65, feesChargedToLandlords: 16.65, chargebackFeesFromPayees: 0, rentNotRepaid: 460, gamLinesTakenBack: 0,
      feesOwedBackOnWins: 0, chargebacksOwedBackOnWins: 0, disputeFeesReturnedOnWins: 0, net: -460,
    })
    expect(after.reconciliation).toMatchObject({ stripeCosts: 21, gap: 0 })
    // GAM's own: the fee it kept, less Stripe's costs and dispute fee, less the
    // fee given back, plus that fee the landlord pays back, less the rent not repaid yet.
    expect(after.gamsOwn).toBe(Math.round((16.65 - 6 - 15 - 16.65 + 16.65 - 460) * 100) / 100)

    // November's rent arrives; the batch nets the $460 and the $16.65 out of it.
    const nov = await rentRow(h, 1000, '2026-11-01')
    await payByCard(h, 'pi_nov', [nov], 1000, 12)
    expect(await payout(h)).toBe(Math.round((1000 - 460 - 16.65) * 100) / 100)
    const rec = (await db.query<{ recovery_status: string }>(`SELECT recovery_status FROM payment_reversals WHERE stripe_event_id = 'evt_dispute_pi_oct'`)).rows
    expect(rec).toEqual([{ recovery_status: 'recovered' }])
    const netted = await check()
    expect(netted.reconciliation!.takenBack).toMatchObject({ rentNotRepaid: 0, feesGivenBack: 16.65, feesChargedToLandlords: 16.65 })
    expect(netted.reconciliation).toMatchObject({ gap: 0 })
    expect(netted.gamsOwn).toBe(Math.round((16.65 + 35.55 - 6 - 15 - 12 - 16.65 + 16.65) * 100) / 100)
  })

  it('a payment disputed before the landlord\'s payout: their unpaid share is held back, nothing is owed back, and the check ties', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_early', [oct], 460, 6)
    await dispute('pi_early', 476.65)
    const s = await check()
    expect(s.reconciliation!.takenBack).toMatchObject({ feesGivenBack: 16.65, rentNotRepaid: 0 })
    expect(s.reconciliation).toMatchObject({ gap: 0 })
    // The batch pays the landlord nothing for the disputed row; only the fee given back comes off their next payout.
    expect(s.owedToLandlords).toBe(-s.reconciliation!.takenBack.feesChargedToLandlords)
  })

  it('the tenant pays the taken-back rent again before the landlord repays it: GAM keeps that payment, and the check still ties', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_oct2', [oct], 460, 6)
    await payout(h)
    await nextRentDue(h, false)
    await dispute('pi_oct2', 476.65)
    const owed = (await db.query<{ recovery_status: string; recovery_method: string }>(
      `SELECT recovery_status, recovery_method FROM payment_reversals WHERE stripe_event_id = 'evt_dispute_pi_oct2'`)).rows
    expect(owed).toEqual([{ recovery_status: 'pending', recovery_method: 'ach_pull' }])
    expect((await check()).reconciliation).toMatchObject({ gap: 0 })

    const again = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id IS NOT NULL AND status = 'pending'`)).rows
    expect(again).toHaveLength(1)
    await payByCard(h, 'pi_again', [again[0].id], 460, 6)
    const s = await check()
    expect(s.reconciliation!.takenBack).toMatchObject({ rentNotRepaid: 0 })
    expect(s.reconciliation).toMatchObject({ gap: 0 })
    // The landlord is owed nothing for the re-payment (GAM keeps it), only the fee given back is still to come off their payout.
    expect(s.owedToLandlords).toBe(-16.65)
  })

  it('a disputed register card sale: the landlord repays the sale and Stripe\'s dispute fee off their payout, GAM keeps its card fee, and the check ties', async () => {
    const h = await household()
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const sale = await insertPosSale(c as any, {
        landlordId: h.landlordId, propertyId: h.propertyId, cashierId: h.landlordUserId, paymentMethod: 'card',
        subtotal: 100, taxAmount: 0, surcharge: 4.05, total: 104.05, platformFee: 4.05, stripePaymentIntentId: 'pi_reg',
        items: [{ name: 'Propane', qty: 1, price: 100 }],
      })
      await c.query('COMMIT')
      await sale.cardFeeBooked
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    onBalance += c2(104.05)
    await stripeCharges('n_reg', 'network_cost', 'card_interchange', 2)
    expect((await check()).reconciliation).toMatchObject({ gap: 0 })

    await dispute('pi_reg', 104.05)
    const s = await check()
    expect(s.reconciliation!.takenBack).toMatchObject({ chargebackFeesFromPayees: 15, feesGivenBack: 0, feesChargedToLandlords: 0, rentNotRepaid: 0 })
    expect(s.reconciliation).toMatchObject({ gap: 0 })
    expect(s.gamsOwn).toBe(2.05)                          // GAM's $4.05 card fee less Stripe's $2.00
    expect(s.owedToLandlords).toBe(-19.05)                // the $100 sale, less $104.05 + $15 they repay
  })

  it('a dispute that is only an inquiry moves no money: no fee is counted as given back', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_inq', [oct], 460, 6)
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('du_inq', 'ch_pi_inq', 'pi_inq', 476.65, 'warning_needs_response')`)
    expect((await check()).reconciliation!.takenBack.feesGivenBack).toBe(0)
    await db.query(`UPDATE connect_disputes SET status = 'lost' WHERE stripe_dispute_id = 'du_inq'`)
    expect((await check()).reconciliation!.takenBack.feesGivenBack).toBe(16.65)
  })

  it('a disputed card payment that paid only GAM\'s own fee: GAM gives back the fee and the line, no landlord is charged, and the check ties', async () => {
    const h = await household()
    const gamFee = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, revenue_owner, notes)
       VALUES ($1,$2,$3,$4,'fee',4,'pending','RETURNFEE','2026-10-01','gam','ACH return fee (passed through at cost)') RETURNING id`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId])).rows[0].id
    const fee = await payByCard(h, 'pi_gamonly', [gamFee], 4, 0.30)
    expect(fee).toBe(0.69)
    const paid = await check()
    expect(paid.reconciliation!.gamOwnedBillLinesByKind).toEqual([{ kind: 'return_fee', label: 'Returned bank payment fees', amount: 4 }])
    expect(paid.reconciliation).toMatchObject({ gap: 0 })

    await dispute('pi_gamonly', 4.69)
    const s = await check()
    expect(s.reconciliation!.takenBack).toMatchObject({ feesGivenBack: 0.69, gamLinesTakenBack: 4, feesChargedToLandlords: 0, rentNotRepaid: 0 })
    expect(s.reconciliation).toMatchObject({ gap: 0 })
    expect(s.gamsOwn).toBe(-15.30)                        // Stripe's $0.30 and its $15 dispute fee; the $15 is billed to the tenant
  })

  it('one of GAM\'s own lines charged on its own, taken back: still counted as paid, and taken back on its own line', async () => {
    const h = await household()
    // A GAM fee charged by itself (no tenant payment record around it), settled.
    const custody = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             revenue_owner, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,$4,'fee',3,'settled','SUBSCRIP','2026-10-01','gam','pi_custody',NOW()) RETURNING id`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId])).rows[0].id
    onBalance += c2(3)
    expect((await check()).reconciliation).toMatchObject({ gap: 0 })

    await dispute('pi_custody', 3)
    const st = (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [custody])).rows[0]
    expect(st.status).toBe('returned')
    const s = await check()
    expect(s.reconciliation!.gamOwnedBillLinesByKind).toEqual([
      { kind: 'subscription', label: 'GAM subscriptions tenants paid (FlexDeposit custody, FlexCredit)', amount: 3 }])
    expect(s.reconciliation!.takenBack).toMatchObject({ gamLinesTakenBack: 3, feesGivenBack: 0 })
    expect(s.reconciliation).toMatchObject({ gap: 0 })
  })
})

/** This month on GAM's calendar, from the database clock. */
const thisMonth = async () => (await db.query<{ m: string }>(`SELECT to_char(NOW(), 'YYYY-MM') AS m`)).rows[0].m
/** The processing margin the revenue book says for `month`: the per-payment rows, their corrections and the true-up. */
const bookMargin = async (month: string) => Number((await db.query<{ amt: string }>(
  `SELECT COALESCE(SUM(amount), 0)::text AS amt FROM platform_revenue_ledger
    WHERE to_char(date_trunc('month', created_at), 'YYYY-MM') = $1
      AND (${PROCESSING_MARGIN_ON_THE_BOOK_SQL} OR (type = 'adjustment' AND reference_type = 'processing_margin_true_up'))`,
  [month])).rows[0].amt)

/**
 * Stripe's card costs for TODAY's card volume, posted as Stripe posts a card
 * day (period = that UTC day), so the card splits them across the day's card
 * payments instead of estimating them.
 */
async function postCardDay(id: string) {
  await db.query(
    `UPDATE stripe_processing_costs
        SET period_start = (NOW() AT TIME ZONE 'UTC')::date, period_end = (NOW() AT TIME ZONE 'UTC')::date
      WHERE stripe_txn_id = $1`, [id])
}

describe('Processing Margin card and its true-up through disputes (10/4 review, fix pass 1)', () => {
  it('a disputed register card sale: Stripe\'s dispute fee the landlord repays counts back, so the card, the true-up and GAM\'s Own Money all say GAM kept its fee less Stripe\'s cost', async () => {
    const h = await household()
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const sale = await insertPosSale(c as any, {
        landlordId: h.landlordId, propertyId: h.propertyId, cashierId: h.landlordUserId, paymentMethod: 'card',
        subtotal: 100, taxAmount: 0, surcharge: 4.05, total: 104.05, platformFee: 4.05, stripePaymentIntentId: 'pi_regm',
        items: [{ name: 'Propane', qty: 1, price: 100 }],
      })
      await c.query('COMMIT')
      await sale.cardFeeBooked
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    onBalance += c2(104.05)
    await stripeCharges('n_regm', 'network_cost', 'card_interchange', 2)
    await postCardDay('n_regm')
    await dispute('pi_regm', 104.05)

    const month = await thisMonth()
    const card = await marginForMonth(month)
    expect(card.feeRevenue).toBe(4.05)
    expect(card.stripeCost).toBe(17)                       // $2.00 on the day + the $15 dispute fee
    expect(card.feesBack.byKind).toEqual([{
      kind: 'chargeback_fee_repaid', label: expect.any(String), amount: 15, count: 1,
    }])
    expect(card.margin).toBe(2.05)
    expect(card.payments!.find(p => p.kind === 'register_card')).toMatchObject({ disputed: true, feeGivenBack: 0 })
    expect((await check()).gamsOwn).toBe(card.margin)

    await trueUpProcessingMargin(month)
    expect(await bookMargin(month)).toBe(2.05)
  })

  it('a disputed tenant card payment: the fee on top that went back to the payer and the same fee taken from the landlord net out, the $15 billed to the tenant counts once paid, and the true-up follows', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_tm', [oct], 460, 6)
    await postCardDay('n_pi_tm')
    await payout(h)
    await nextRentDue(h, true)
    await dispute('pi_tm', 476.65)
    const month = await thisMonth()

    const card = await marginForMonth(month)
    expect(card.feeRevenue).toBe(16.65)
    expect(card.stripeCost).toBe(21)
    expect(card.feesBack.byKind.map(k => [k.kind, k.amount, k.count])).toEqual([
      ['fee_given_back', -16.65, 1], ['fee_charged_to_landlord', 16.65, 1],
    ])
    expect(card.margin).toBe(-4.35)                        // GAM kept its fee; only the $15 is still out
    expect(card.payments!.find(p => p.kind === 'rent_card')).toMatchObject({ disputed: true, feeGivenBack: 16.65, gamKeeps: 10.65 })
    // The list's rows add up to the card.
    const list = card.payments!.filter(p => !p.clearing).reduce((a, p) => a + c2(p.gamKeeps), 0)
      - c2(card.notTiedTotal) + (card.feesBack.items ?? []).reduce((a, f) => a + c2(f.amount), 0)
    expect(list / 100).toBe(card.margin)

    // The tenant pays the $15 dispute fee GAM billed them, by card.
    const feeRow = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE entry_description = 'RETURNFEE' AND tenant_id = $1`, [h.tenantId])).rows
    expect(feeRow).toHaveLength(1)
    const fee2 = await payByCard(h, 'pi_tm_fee', [feeRow[0].id], 15, 0.40)
    await postCardDay('n_pi_tm_fee')
    const paid = await marginForMonth(month)
    expect(paid.feesBack.byKind.find(k => k.kind === 'billed_fee_paid')).toMatchObject({ amount: 15, count: 1 })
    expect(paid.margin).toBe(Math.round((16.65 + fee2 - 6 - 15 - 0.40 - 16.65 + 16.65 + 15) * 100) / 100)
    // GAM's Own Money says the same, apart from the rent the landlord has not repaid yet (not processing).
    const own = await check()
    expect(own.reconciliation).toMatchObject({ gap: 0 })
    expect(Math.round((own.gamsOwn! + own.reconciliation!.takenBack.rentNotRepaid) * 100) / 100).toBe(paid.margin)

    await trueUpProcessingMargin(month)
    expect(await bookMargin(month)).toBe(paid.margin)
  })

  it('a spread taken back for a dispute under the superseded rule is part of what the book already says, so the true-up never takes it off twice', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_sr', [oct], 460, 6)
    await postCardDay('n_pi_sr')
    const month = await thisMonth()
    await recordPlatformRevenue({
      type: 'adjustment', amount: -3, referenceId: randomUUID(), referenceType: 'dispute_spread_reversal', notes: 'superseded-rule spread reversal',
    })
    const r = await trueUpProcessingMargin(month, { dryRun: true })
    const card = await marginForMonth(month)
    expect(r.actualMargin).toBe(card.margin)
    expect(Math.round((r.alreadyRecorded + r.adjustment) * 100) / 100).toBe(card.margin)
    await trueUpProcessingMargin(month)
    expect(await bookMargin(month)).toBe(card.margin)
  })
})

describe('A dispute GAM wins (10/4 review, fix pass 2)', () => {
  it('the month the dispute was opened never changes when it is won later; the win counts in its own month and nets to nothing', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_won', [oct], 460, 6)
    await postCardDay('n_pi_won')
    await payout(h)
    await nextRentDue(h, true)
    await dispute('pi_won', 476.65)
    const month = await thisMonth()
    const next = (await db.query<{ m: string }>(`SELECT to_char(NOW() + interval '1 month', 'YYYY-MM') AS m`)).rows[0].m
    const before = await marginForMonth(month)
    expect(before.margin).toBe(-4.35)

    // Won next month: Stripe puts the disputed money back.
    await db.query(`UPDATE connect_disputes SET status = 'won', outcome_at = NOW() + interval '1 month' WHERE stripe_payment_intent_id = 'pi_won'`)
    const after = await marginForMonth(month)
    expect(after.margin).toBe(before.margin)
    expect(after.feesBack).toEqual(before.feesBack)
    expect(after.payments!.find(p => p.kind === 'rent_card')).toMatchObject({ disputed: true, disputeWon: true, feeGivenBack: 16.65 })
    const won = await marginForMonth(next)
    expect(won.feesBack.byKind.map(k => [k.kind, k.amount, k.count])).toEqual([
      ['fee_returned_on_win', 16.65, 1], ['fee_owed_back_on_win', -16.65, 1],
    ])
    expect(won.feesBack.total).toBe(0)
  })

  it('GAM\'s Own Money: the fee on top that came back is GAM\'s again, what the landlord was charged for it is owed back to them, and the line handing it back changes nothing', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_won2', [oct], 460, 6)
    await payout(h)
    await nextRentDue(h, true)
    await dispute('pi_won2', 476.65)
    const disputed = await check()
    expect(disputed.reconciliation).toMatchObject({ gap: 0 })

    await db.query(`UPDATE connect_disputes SET status = 'won', outcome_at = NOW() WHERE stripe_payment_intent_id = 'pi_won2'`)
    onBalance += c2(476.65)
    const won = await check()
    expect(won.reconciliation!.takenBack).toMatchObject({
      feesGivenBack: 0, feesChargedToLandlords: 16.65, feesOwedBackOnWins: 16.65, rentNotRepaid: 460,
    })
    // The fee part ties; what is left is the rent the dispute handling has not undone (the other build's).
    expect(won.reconciliation!.gap).toBe(460)
    expect(won.owedToLandlords).toBe(Math.round((disputed.owedToLandlords + 16.65) * 100) / 100)
    expect(won.reconciliation!.book).toBe(disputed.reconciliation!.book)

    // The dispute handling hands the fee back to the landlord's payout: nothing on the cards moves.
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'dispute', $2, 16.65, 'fee handed back: dispute won')`,
      [h.landlordId, wonDisputeFeeReturnSourceId('pi_won2', h.landlordId)])
    const handed = await check()
    expect(handed.reconciliation!.takenBack).toMatchObject({ feesChargedToLandlords: 0, feesOwedBackOnWins: 0 })
    expect(handed.reconciliation).toMatchObject({ gap: 460, book: won.reconciliation!.book })
    expect(handed.gamsOwn).toBe(won.gamsOwn)
    expect(handed.owedToLandlords).toBe(won.owedToLandlords)
    const month = await thisMonth()
    const card = await marginForMonth(month)
    expect(card.feesBack.byKind.map(k => [k.kind, k.amount])).toEqual([
      ['fee_given_back', -16.65], ['fee_charged_to_landlord', 16.65], ['fee_returned_on_win', 16.65], ['fee_owed_back_on_win', -16.65],
    ])
  })
})

/** Stripe closes the dispute in GAM's favor: the real webhook, and the disputed money back on the balance. */
async function disputeWon(pi: string, amount: number) {
  const res = await post({
    id: 'evt_won_' + pi, type: 'charge.dispute.closed',
    data: { object: { id: 'du_' + pi, object: 'dispute', charge: 'ch_' + pi, payment_intent: pi, amount: c2(amount),
      currency: 'usd', status: 'won', reason: 'fraudulent', balance_transactions: [] } },
  })
  expect(res.status).toBe(200)
  onBalance += c2(amount)
}

/**
 * Decisions #55-AMENDED: a won dispute is undone by hand for this deploy. The
 * webhook writes nothing for the win but ONE critical notice listing what to
 * undo, with amounts.
 */
const wonNotices = async () => (await db.query<{ severity: string; title: string; body: string; context: any }>(
  `SELECT severity, title, body, context FROM admin_notifications WHERE category = 'dispute_won_undo_by_hand'`)).rows
/** Lines the webhook wrote for a win by itself (none: the win is undone by hand). */
const winLinesWritten = async () => (await db.query(
  `SELECT 1 FROM held_payout_items WHERE source_id LIKE '%returned\_on\_win%'`)).rowCount

describe('A dispute GAM wins (10/4 review, fix pass 3)', () => {
  it('won through the real webhook with no outcome time recorded: the win stays in the month Stripe said so, even when the dispute is touched again a month later', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_wonhook', [oct], 460, 6)
    await postCardDay('n_pi_wonhook')
    await payout(h)
    await nextRentDue(h, true)
    await dispute('pi_wonhook', 476.65)
    await disputeWon('pi_wonhook', 476.65)
    // What the dispute handling records today: the status, never the outcome time.
    const [row] = (await db.query<any>(`SELECT status, outcome_at FROM connect_disputes WHERE stripe_dispute_id = 'du_pi_wonhook'`)).rows
    expect(row).toMatchObject({ status: 'won', outcome_at: null })

    const month = await thisMonth()
    const next = (await db.query<{ m: string }>(`SELECT to_char(NOW() + interval '1 month', 'YYYY-MM') AS m`)).rows[0].m
    const won = await marginForMonth(month)
    const winLines = (m: Awaited<ReturnType<typeof marginForMonth>>) =>
      m.feesBack.byKind.filter(k => k.kind === 'fee_returned_on_win' || k.kind === 'fee_owed_back_on_win').map(k => [k.kind, k.amount])
    expect(winLines(won)).toEqual([['fee_returned_on_win', 16.65], ['fee_owed_back_on_win', -16.65]])

    // A later update of the same dispute (another webhook next month) moves updated_at; the win must not move.
    await db.query(`UPDATE connect_disputes SET updated_at = NOW() + interval '1 month' WHERE stripe_dispute_id = 'du_pi_wonhook'`)
    const again = await marginForMonth(month)
    expect(winLines(again)).toEqual(winLines(won))
    expect(again.feesBack).toEqual(won.feesBack)
    expect(winLines(await marginForMonth(next))).toEqual([])
  })

  it('the line handing back a won dispute\'s fee reads as the landlord\'s dispute-fee line under the payout readers\' contract, never as a chargeback', async () => {
    const h = await household()
    const id = wonDisputeFeeReturnSourceId('pi_shape', h.landlordId)
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'dispute', $2, 16.65, 'fee handed back: dispute won')`, [h.landlordId, id])
    const pick = async (where: string) => (await db.query<{ source_id: string }>(
      `SELECT h.source_id FROM held_payout_items h WHERE ${where}`)).rows.map(r => r.source_id)
    expect(await pick(disputeFeeLineSql('h'))).toEqual([id])
    expect(await pick(`h.source_type = 'dispute' AND NOT ${disputeShareLineSql('h')} AND NOT ${disputeFeeLineSql('h')}`)).toEqual([])
    // The payment it belongs to is still the second part, as on the fee line it hands back.
    expect(id.split(':')[1]).toBe('pi_shape')
  })

  it('a register card sale\'s chargeback GAM wins: nothing is given back by itself — one critical notice names the $104.05 to give back, and the check ties before and after that line is written by hand', async () => {
    const h = await household()
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const sale = await insertPosSale(c as any, {
        landlordId: h.landlordId, propertyId: h.propertyId, cashierId: h.landlordUserId, paymentMethod: 'card',
        subtotal: 100, taxAmount: 0, surcharge: 4.05, total: 104.05, platformFee: 4.05, stripePaymentIntentId: 'pi_regwon',
        items: [{ name: 'Propane', qty: 1, price: 100 }],
      })
      await c.query('COMMIT')
      await sale.cardFeeBooked
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    onBalance += c2(104.05)
    await stripeCharges('n_regwon', 'network_cost', 'card_interchange', 2)
    await dispute('pi_regwon', 104.05)
    const lost = await check()
    expect(lost.reconciliation).toMatchObject({ gap: 0 })
    expect(lost.owedToLandlords).toBe(-19.05)

    await disputeWon('pi_regwon', 104.05)
    // Nothing given back by itself; one critical notice says what and how much.
    expect(await winLinesWritten()).toBe(0)
    const told = await wonNotices()
    expect(told).toHaveLength(1)
    expect(told[0].severity).toBe('critical')
    expect(told[0].body).toContain('back $104.05 of the $119.05 chargeback taken off their payout')
    expect(told[0].body).toContain(wonChargebackReturnSourceId('du_pi_regwon'))
    expect(Object.values(told[0].context.give_back)).toEqual([104.05])
    const won = await check()
    expect(won.reconciliation!.takenBack).toMatchObject({ chargebackFeesFromPayees: 15, chargebacksOwedBackOnWins: 104.05 })
    expect(won.reconciliation).toMatchObject({ gap: 0, book: lost.reconciliation!.book })
    expect(won.gamsOwn).toBe(lost.gamsOwn)
    expect(won.owedToLandlords).toBe(85)                   // −$19.05 + the $104.05 that came back

    // Given back by hand from the notice, on the landlord's payout: nothing on the cards moves.
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'dispute', $2, 104.05, 'chargeback won: sale given back')`,
      [h.landlordId, wonChargebackReturnSourceId('du_pi_regwon')])
    const handed = await check()
    expect(handed.reconciliation!.takenBack).toMatchObject({ chargebackFeesFromPayees: 15, chargebacksOwedBackOnWins: 0 })
    expect(handed.reconciliation).toMatchObject({ gap: 0, book: lost.reconciliation!.book })
    expect(handed.owedToLandlords).toBe(85)
    expect(handed.gamsOwn).toBe(lost.gamsOwn)
  })
  it('a won chargeback whose $15 fee Stripe returned owes the payee amount + $15, named on the won-dispute notice to give back by hand', async () => {
    const h = await household()
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const sale = await insertPosSale(c as any, {
        landlordId: h.landlordId, propertyId: h.propertyId, cashierId: h.landlordUserId, paymentMethod: 'card',
        subtotal: 100, taxAmount: 0, surcharge: 4.05, total: 104.05, platformFee: 4.05, stripePaymentIntentId: 'pi_regfee',
        items: [{ name: 'Propane', qty: 1, price: 100 }],
      })
      await c.query('COMMIT')
      await sale.cardFeeBooked
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    onBalance += c2(104.05)
    await stripeCharges('n_regfee', 'network_cost', 'card_interchange', 2)
    await dispute('pi_regfee', 104.05)
    const lost = await check()
    expect(lost.reconciliation).toMatchObject({ gap: 0 })
    expect(lost.owedToLandlords).toBe(-19.05)

    // Stripe closes it in GAM's favor and gives back the disputed amount AND its $15 fee.
    const res = await post({
      id: 'evt_won_pi_regfee', type: 'charge.dispute.closed',
      data: { object: { id: 'du_pi_regfee', object: 'dispute', charge: 'ch_pi_regfee', payment_intent: 'pi_regfee',
        amount: c2(104.05), currency: 'usd', status: 'won', reason: 'fraudulent',
        balance_transactions: [{ amount: -c2(104.05), fee: 1500 }, { amount: c2(104.05), fee: -1500 }] } },
    })
    expect(res.status).toBe(200)
    onBalance += c2(104.05) + 1500
    expect(await winLinesWritten()).toBe(0)
    const told = await wonNotices()
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain('back $119.05 of the $119.05 chargeback taken off their payout ($104.05 of the sale and the $15.00 dispute fee Stripe returned')
    const won = await check()
    expect(won.reconciliation!.takenBack).toMatchObject({ chargebackFeesFromPayees: 15, chargebacksOwedBackOnWins: 119.05 })
    expect(won.reconciliation).toMatchObject({ gap: 0, book: lost.reconciliation!.book })
    expect(won.gamsOwn).toBe(lost.gamsOwn)               // GAM keeps none of the $15 the landlord repaid
    expect(won.owedToLandlords).toBe(100)                // −$19.05 + $104.05 + the $15 fee that came back

    // The line giving it back, written by hand for the amount + the returned fee: nothing on the cards moves.
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'dispute', $2, 119.05, 'chargeback won: sale and dispute fee given back')`,
      [h.landlordId, wonChargebackReturnSourceId('du_pi_regfee')])
    const handed = await check()
    expect(handed.reconciliation!.takenBack).toMatchObject({ chargebacksOwedBackOnWins: 0 })
    expect(handed.reconciliation).toMatchObject({ gap: 0, book: lost.reconciliation!.book })
    expect(handed.owedToLandlords).toBe(100)
  })

  it('a won rent dispute whose $15 fee Stripe returned: the $15 is GAM\'s again on the check and on the margin card, the check\'s only gap is the rent still to be undone by hand, and the notice lists each step with its amount', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_rentfee', [oct], 460, 6)
    await postCardDay('n_pi_rentfee')
    await payout(h)
    await nextRentDue(h, true)
    await dispute('pi_rentfee', 476.65)
    const disputed = await check()
    expect(disputed.reconciliation).toMatchObject({ gap: 0 })
    // The tenant is billed Stripe's $15 as GAM's own line.
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'RETURNFEE' AND tenant_id = $1`, [h.tenantId])).rows).toHaveLength(1)
    const month = await thisMonth()
    const before = await marginForMonth(month)

    // Stripe closes it in GAM's favor and gives back the disputed amount AND its $15 fee.
    const res = await post({
      id: 'evt_won_pi_rentfee', type: 'charge.dispute.closed',
      data: { object: { id: 'du_pi_rentfee', object: 'dispute', charge: 'ch_pi_rentfee', payment_intent: 'pi_rentfee',
        amount: c2(476.65), currency: 'usd', status: 'won', reason: 'fraudulent',
        balance_transactions: [{ amount: -c2(476.65), fee: 1500 }, { amount: c2(476.65), fee: -1500 }] } },
    })
    expect(res.status).toBe(200)
    onBalance += c2(476.65) + 1500
    // Nothing undone by itself: the reopened rent is still owed, and the notice says what to undo.
    expect((await db.query<any>(`SELECT status FROM payments WHERE reversal_id IS NOT NULL`)).rows).toEqual([{ status: 'pending' }])
    expect(await winLinesWritten()).toBe(0)
    const told = await wonNotices()
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain('Void the reopened rent charge of $460.00')
    expect(told[0].body).toContain(`Mark the disputed rent line paid again (line ${oct}, $460.00 of it was taken back)`)
    expect(told[0].body).toContain('back the $16.65 card or bank fee taken off their payout')
    expect(told[0].body).toContain('Call off the $460.00 still to be asked of')
    expect(told[0].body).toMatch(/Void the \$15\.00 dispute fee billed to .* Stripe gave its fee back/)
    expect(told[0].context).toMatchObject({ rows_to_mark_paid: [oct], fee_to_take_off: 15, fee_kept_unbilled: 0 })
    const won = await check()
    expect(won.reconciliation!.takenBack).toMatchObject({ disputeFeesReturnedOnWins: 15, chargebacksOwedBackOnWins: 0, rentNotRepaid: 460 })
    // The $15 is named (book up by exactly $15); what is left is the rent undone by hand from the notice.
    expect(won.reconciliation!.book).toBe(Math.round((disputed.reconciliation!.book + 15) * 100) / 100)
    expect(won.reconciliation!.gap).toBe(460)
    // The margin card counts it once, in the month of the win, beside the fee-on-top lines.
    const card = await marginForMonth(month)
    expect(card.feesBack.byKind.find(k => k.kind === 'dispute_fee_returned_on_win')).toMatchObject({ amount: 15, count: 1 })
    expect(Math.round((card.margin - before.margin) * 100) / 100).toBe(15)
  })

  it('choice46d (books review): a won dispute on a test landlord\'s charge never counts Stripe\'s returned fee — not on the margin card, not in the book (the same real-landlord filter as every sibling kind)', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_rentdemo', [oct], 460, 6)
    await payout(h)
    await nextRentDue(h, true)
    await dispute('pi_rentdemo', 476.65)
    await db.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [h.landlordId])
    const res = await post({
      id: 'evt_won_pi_rentdemo', type: 'charge.dispute.closed',
      data: { object: { id: 'du_pi_rentdemo', object: 'dispute', charge: 'ch_pi_rentdemo', payment_intent: 'pi_rentdemo',
        amount: c2(476.65), currency: 'usd', status: 'won', reason: 'fraudulent',
        balance_transactions: [{ amount: -c2(476.65), fee: 1500 }, { amount: c2(476.65), fee: -1500 }] } },
    })
    expect(res.status).toBe(200)
    onBalance += c2(476.65) + 1500
    const won = await check()
    expect(won.reconciliation!.takenBack).toMatchObject({ disputeFeesReturnedOnWins: 0 })
    const card = await marginForMonth(await thisMonth())
    expect(card.feesBack.byKind.find(k => k.kind === 'dispute_fee_returned_on_win')).toBeUndefined()
  })

  it('a won rent dispute whose $15 Stripe kept: nothing comes back, nothing is counted, and the notice says the dispute fee billed to the tenant stays', async () => {
    const h = await household()
    const oct = await rentRow(h, 460, '2026-10-01')
    await payByCard(h, 'pi_rentkept', [oct], 460, 6)
    await payout(h)
    await nextRentDue(h, true)
    await dispute('pi_rentkept', 476.65)
    const disputed = await check()
    const res = await post({
      id: 'evt_won_pi_rentkept', type: 'charge.dispute.closed',
      data: { object: { id: 'du_pi_rentkept', object: 'dispute', charge: 'ch_pi_rentkept', payment_intent: 'pi_rentkept',
        amount: c2(476.65), currency: 'usd', status: 'won', reason: 'fraudulent',
        balance_transactions: [{ amount: -c2(476.65), fee: 1500 }, { amount: c2(476.65), fee: 0 }] } },
    })
    expect(res.status).toBe(200)
    onBalance += c2(476.65)
    const told = await wonNotices()
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/Stripe kept its dispute fee, so the \$15\.00 dispute fee billed to .* stays\./)
    expect(told[0].context).toMatchObject({ fee_to_take_off: 0, fee_kept_unbilled: 0 })
    const won = await check()
    expect(won.reconciliation!.takenBack).toMatchObject({ disputeFeesReturnedOnWins: 0 })
    expect(won.reconciliation!.book).toBe(disputed.reconciliation!.book)
    expect(won.reconciliation!.gap).toBe(460)
    const card = await marginForMonth(await thisMonth())
    expect(card.feesBack.byKind.find(k => k.kind === 'dispute_fee_returned_on_win')).toBeUndefined()
  })

  it('the fee Stripe gave back is read from the won dispute\'s balance transactions: nothing when Stripe kept it', async () => {
    expect(disputeFeeReturnedOnWinCents({ balance_transactions: [{ amount: -10405, fee: 1500 }, { amount: 10405, fee: 0 }] })).toBe(0)
    expect(disputeFeeReturnedOnWinCents({ balance_transactions: [{ amount: -10405, fee: 1500 }, { amount: 10405, fee: -1500 }] })).toBe(1500)
    expect(disputeFeeReturnedOnWinCents({ balance_transactions: [{ amount: -10405, fee: 1500 }] })).toBe(0)
    expect(disputeFeeReturnedOnWinCents({ balance_transactions: ['txn_unexpanded'] })).toBe(0)
    expect(disputeFeeReturnedOnWinCents({})).toBe(0)
  })
})
