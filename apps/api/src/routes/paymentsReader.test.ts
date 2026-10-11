/**
 * S654 (Nic) — a card on the counter reader, for a lease balance.
 *
 *   "It needs to be both… somebody stops by to pay their rent because maybe
 *    they couldn't log in online and they don't know how much they owe."
 *   Money: on GAM's balance, Tuesday payout, the card fee on the customer at
 *   the online rate. Nothing is booked until the reader approves the card.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const {
  createRentReaderPaymentIntentMock, processPaymentIntentOnReaderMock,
  retrieveTerminalPaymentIntentMock, captureTerminalPaymentIntentMock, cancelTerminalPaymentIntentMock,
  paymentIntentsUpdateMock, readersCancelActionMock, paymentIntentsCaptureMock, paymentIntentsRetrieveMock, paymentIntentsCancelMock,
  showCartOnReaderMock, cancelReaderActionMock, holdForTheCartMock, clearCartOnReaderMock, readerActionMock,
} = vi.hoisted(() => ({
  showCartOnReaderMock:              vi.fn(async (): Promise<boolean> => true),
  holdForTheCartMock:                vi.fn(async () => undefined),
  clearCartOnReaderMock:             vi.fn(async () => true),
  readerActionMock:                  vi.fn(async (): Promise<any> => null),
  cancelReaderActionMock:            vi.fn(async () => undefined),
  createRentReaderPaymentIntentMock: vi.fn(async (o: any) => ({ id: 'pi_reader_1', status: 'requires_payment_method', amount: o.amountCents, metadata: {} })),
  processPaymentIntentOnReaderMock:  vi.fn(async () => ({ id: 'tmr_1', action: { status: 'in_progress' } })),
  retrieveTerminalPaymentIntentMock: vi.fn(async () => ({ id: 'pi_reader_1', status: 'requires_payment_method', amount: 0, metadata: {} })),
  captureTerminalPaymentIntentMock:  vi.fn(async () => ({ id: 'pi_reader_1', status: 'succeeded' })),
  cancelTerminalPaymentIntentMock:   vi.fn(async () => ({ id: 'pi_reader_1', status: 'canceled' })),
  paymentIntentsUpdateMock:          vi.fn(async () => ({ id: 'pi_reader_1' })),
  readersCancelActionMock:           vi.fn(async () => ({})),
  paymentIntentsCaptureMock:         vi.fn(async () => ({ id: 'pi_reader_1', status: 'succeeded' })),
  paymentIntentsRetrieveMock:        vi.fn(async () => ({ id: 'pi_reader_1', status: 'requires_capture' })),
  paymentIntentsCancelMock:          vi.fn(async () => ({ id: 'pi_reader_1', status: 'canceled' })),
}))
vi.mock('../services/posTerminal', () => ({
  createRentReaderPaymentIntent: createRentReaderPaymentIntentMock,
  processPaymentIntentOnReader:  processPaymentIntentOnReaderMock,
  retrieveTerminalPaymentIntent: retrieveTerminalPaymentIntentMock,
  captureTerminalPaymentIntent:  captureTerminalPaymentIntentMock,
  cancelTerminalPaymentIntent:   cancelTerminalPaymentIntentMock,
  cancelReaderAction:            cancelReaderActionMock,
  showCartOnReader:              showCartOnReaderMock,
  holdForTheCart:                holdForTheCartMock,
  clearCartOnReader:             clearCartOnReaderMock,
  readerAction:                  readerActionMock,
  READER_CART_PAUSE_MS:          0,
}))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: { update: paymentIntentsUpdateMock, retrieve: paymentIntentsRetrieveMock, capture: paymentIntentsCaptureMock, cancel: paymentIntentsCancelMock },
    paymentMethods: { retrieve: vi.fn() },
    terminal: { readers: { cancelAction: readersCancelActionMock } },
  }),
  createTenantAchSetup: vi.fn(),
}))
vi.mock('../services/supersedence', () => ({ computeTenantGamOutstandingTotal: vi.fn(async () => 0) }))
vi.mock('../services/adminNotifications', () => ({ createAdminNotification: vi.fn(async () => undefined) }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { processingFeeFor } from '@gam/shared'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { paymentsRouter } from './payments'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express(); app.use(express.json())
  app.use('/api/payments', paymentsRouter); app.use(errorHandler); return app
}
const SECRET = 'test_jwt_secret_reader'

async function fixture() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, subtotal_utilities, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-READER-1', CURRENT_DATE, 460, 22.47, 482.47, 'pending') RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId])
    const rent = await c.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',460,'pending',CURRENT_DATE,'RENT') RETURNING id`,
      [inv.rows[0].id, unitId, leaseId, tenantId, ll.landlordId])
    await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,$5,'utility',22.47,'pending',CURRENT_DATE,'UTILITY','Water meter 100 → 150')`,
      [inv.rows[0].id, unitId, leaseId, tenantId, ll.landlordId])
    await c.query(
      `INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname, status, registered_at)
       VALUES ($1,$2,'tmr_1','Counter S710','active',NOW())`, [ll.landlordId, propertyId])
    await c.query('COMMIT')
    const token = jwt.sign({ userId: ll.userId, role: 'landlord', email: 'll@t.dev', profileId: null,
      landlordIds: [ll.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    return { ...ll, propertyId, unitId, tenantId, leaseId, invoiceId: inv.rows[0].id, rentId: rent.rows[0].id, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const FEE = processingFeeFor({ amount: 482.47, paymentMethod: 'card' })
const TOTAL = Math.round((482.47 + FEE) * 100) / 100

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  vi.clearAllMocks()
  // platform_processing_rates is reference data the cleanup leaves alone, so a
  // rate seeded here must be removed again (afterEach) or it leaks into suites
  // that expect their own card rate.
  await db.query(
    `INSERT INTO platform_processing_rates (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent, notes)
     SELECT 'card', 0.55, 3.5, 0.26, 2.9, 's654-reader-test'
      WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'card' AND effective_until IS NULL)`)
})
afterEach(async () => {
  await db.query(`DELETE FROM platform_processing_rates WHERE notes = 's654-reader-test'`)
})

describe('S654 card on the counter reader', () => {
  it('lists the readers paired at the charge\'s property', async () => {
    const f = await fixture()
    const res = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/readers`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].stripe_reader_id).toBe('tmr_1')   // camelized by the app-level middleware in index.ts, not here
  })

  it('quotes the whole balance plus the online card fee, sends it to the reader, books nothing yet', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(res.status).toBe(201)
    expect(res.body.data.balance).toBe(482.47)
    expect(res.body.data.cardFee).toBe(FEE)
    expect(res.body.data.total).toBe(TOTAL)
    expect(createRentReaderPaymentIntentMock).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: Math.round(TOTAL * 100), tenantId: f.tenantId, anchorPaymentId: f.rentId,
    }))
    expect(processPaymentIntentOnReaderMock).toHaveBeenCalledWith({ stripeReaderId: 'tmr_1', paymentIntentId: 'pi_reader_1' })
    // S654 (Nic): the reader shows whose balance, each charge by name, the fee, the total.
    const cart: any = (showCartOnReaderMock.mock.calls as any[])[0][0]
    expect(cart.stripeReaderId).toBe('tmr_1')
    expect(cart.lines.map((l: any) => l.description)).toEqual([expect.stringMatching(/^Rent — .+/), 'Water meter 100 → 150', 'Card processing fee'])
    expect(cart.lines.map((l: any) => l.amountCents)).toEqual([46000, 2247, Math.round(FEE * 100)])
    expect(cart.totalCents).toBe(Math.round(TOTAL * 100))
    expect(res.body.data.lineItems).toHaveLength(2)
    // The ledger is untouched until the card is approved.
    const { rows } = await db.query(`SELECT status, stripe_payment_intent_id FROM payments WHERE invoice_id=$1`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'pending' && r.stripe_payment_intent_id === null)).toBe(true)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  // S654 (Nic): "it needs to be there the whole time … until the payment is processed."
  it('puts the breakdown up as soon as the desk has the total; Send then finishes without holding it', async () => {
    const f = await fixture()
    const show = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/show`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(show.status, JSON.stringify(show.body)).toBe(200)
    expect(show.body.data.shown).toBe(true)
    const cart: any = (showCartOnReaderMock.mock.calls as any[])[0][0]
    expect(cart.lines[0].description).toMatch(/^Rent — .+/)
    expect(cart.totalCents).toBe(Math.round(TOTAL * 100))
    expect(createRentReaderPaymentIntentMock).not.toHaveBeenCalled()
    expect(processPaymentIntentOnReaderMock).not.toHaveBeenCalled()

    const send = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1', cartOnReader: true })
    expect(send.status).toBe(201)
    expect(holdForTheCartMock).not.toHaveBeenCalled()
    expect(processPaymentIntentOnReaderMock).toHaveBeenCalledTimes(1)

    // Without the breakdown up first, it is held for the resident to read.
    const cold = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(cold.status).toBe(201)
    expect(holdForTheCartMock).toHaveBeenCalledTimes(1)
  })

  it('leaves a busy reader alone, takes only a breakdown down, and refuses a stranger\'s reader', async () => {
    const f = await fixture()
    readerActionMock.mockResolvedValueOnce({ type: 'process_payment_intent', status: 'in_progress' })
    const busy = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/show`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(busy.body.data).toMatchObject({ shown: false, busy: 'process_payment_intent' })
    expect(showCartOnReaderMock).not.toHaveBeenCalled()
    const clear = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/show`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1', clear: true })
    expect(clear.status).toBe(200)
    expect(clearCartOnReaderMock).toHaveBeenCalledWith('tmr_1', expect.stringMatching(/^rent:/))
    const foreign = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/show`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_not_mine' })
    expect(foreign.status).toBe(404)
  })

  it('refuses a reader that is not paired to this company', async () => {
    const f = await fixture()
    const res = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_someone_elses' })
    expect(res.status).toBe(404)
    expect(createRentReaderPaymentIntentMock).not.toHaveBeenCalled()
  })

  it('on approval: books it like an online card payment, in person, then captures', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(TOTAL)
    expect(res.body.data.cardFee).toBe(FEE)

    const { rows } = await db.query<any>(
      `SELECT type, status, stripe_payment_intent_id, platform_held, payment_channel FROM payments WHERE invoice_id=$1 ORDER BY type`, [f.invoiceId])
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.status).toBe('processing')                    // the webhook settles it, as for Pay Now
      expect(r.stripe_payment_intent_id).toBe('pi_reader_1')
      expect(r.platform_held).toBe(true)                      // GAM's balance → Tuesday payout
      expect(r.payment_channel).toBe('in_person')             // "Card · in person" in the history
    }
    const { rows: [rem] } = await db.query<any>(`SELECT payment_method, amount::float AS amount, gross_amount::float AS gross, processing_fee_amount::float AS fee FROM tenant_remittances`)
    expect(rem.payment_method).toBe('card')
    expect(rem.amount).toBe(482.47)
    expect(rem.gross).toBe(TOTAL)
    expect(rem.fee).toBe(FEE)
    // Metadata rewritten to the rent shape BEFORE capture, so the webhook takes the normal path.
    expect(paymentIntentsUpdateMock).toHaveBeenCalledWith('pi_reader_1', expect.objectContaining({
      metadata: expect.objectContaining({ gam_purpose: 'rent_terminal', gam_charge_source: 'front_desk_reader' }),
    }))
    expect(paymentIntentsCaptureMock).toHaveBeenCalledWith('pi_reader_1')
  })

  // S655 (Nic, 10/2): credit is the payer's to use or save — the desk asks
  // before the amount goes to the reader, never nets it by itself.
  it('the reader asks before using credit', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'other')`, [f.landlordId, f.tenantId, f.leaseId])
    const feeUsed = processingFeeFor({ amount: 382.47, paymentMethod: 'card' })
    const totalUsed = Math.round((382.47 + feeUsed) * 100) / 100

    // Before the desk answers: the whole bill, the credit beside it, both prices.
    const q = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote`).set('Authorization', `Bearer ${f.token}`)
    expect(q.status).toBe(200)
    expect(q.body.data).toMatchObject({
      outstanding: 482.47, usableCredit: 100, needsCreditChoice: true, creditApplied: 0, balance: 482.47, total: TOTAL,
    })
    expect(q.body.data.ifUsed).toMatchObject({ balance: 382.47, cardFee: feeUsed, total: totalUsed })
    expect(q.body.data.ifSaved).toMatchObject({ balance: 482.47, cardFee: FEE, total: TOTAL })

    // No answer: nothing goes to the reader.
    const unanswered = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(unanswered.status).toBe(422)
    expect(unanswered.body.error).toMatch(/use it or save it/)
    expect(createRentReaderPaymentIntentMock).not.toHaveBeenCalled()

    // "Use": the card pays the bill less the credit; the choice rides on the intent.
    const used = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1', useCredit: true, expectedCredit: 100 })
    expect(used.status, JSON.stringify(used.body)).toBe(201)
    expect(used.body.data).toMatchObject({ creditUsed: 100, total: totalUsed })
    expect(createRentReaderPaymentIntentMock).toHaveBeenLastCalledWith(expect.objectContaining({ amountCents: Math.round(totalUsed * 100) }))
    expect(paymentIntentsUpdateMock).toHaveBeenCalledWith('pi_reader_1', { metadata: expect.objectContaining({
      gam_use_credit: 'true', gam_expected_credit: '100.00' }) })
    // The credit pays the oldest line first (rent); the card pays the rest of it and the water.
    expect(used.body.data.lineItems.map((l: any) => l.amountCents)).toEqual([36000, 2247])

    // "Save": the whole bill goes on the card and the credit stays.
    const saved = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1', useCredit: false, expectedCredit: 100 })
    expect(saved.status).toBe(201)
    expect(saved.body.data).toMatchObject({ creditUsed: 0, total: TOTAL })
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
  })

  it('on approval with the credit used: the credit is set aside on the receipt and the card pays the rest', async () => {
    const f = await fixture()
    const { rows: [credit] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'other') RETURNING id`, [f.landlordId, f.tenantId, f.leaseId])
    const feeUsed = processingFeeFor({ amount: 382.47, paymentMethod: 'card' })
    const totalUsed = Math.round((382.47 + feeUsed) * 100) / 100
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(totalUsed * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId,
                  gam_use_credit: 'true', gam_expected_credit: '100.00' },
    } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.total).toBe(totalUsed)
    const { rows: [rem] } = await db.query<any>(`SELECT id, amount::float AS amount FROM tenant_remittances`)
    expect(rem.amount).toBe(382.47)
    const { rows: uses } = await db.query<any>(`SELECT status, source, remittance_id, amount::float AS amount FROM credit_uses`)
    expect(uses).toEqual([{ status: 'held', source: 'front_desk_reader', remittance_id: rem.id, amount: 100 }])
    const { rows: [c] } = await db.query<any>(`SELECT amount_remaining::float AS r FROM tenant_credits WHERE id=$1`, [credit.id])
    expect(c.r).toBe(0)
    const { rows } = await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE invoice_id=$1`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'processing' && r.stripe_payment_intent_id === 'pi_reader_1')).toBe(true)
  })

  it('a credit that covers the whole balance means nothing goes to the reader', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,600,600,'other')`, [f.landlordId, f.tenantId, f.leaseId])
    const q = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote`).set('Authorization', `Bearer ${f.token}`)
    expect(q.status).toBe(200)
    expect(q.body.data).toMatchObject({ usableCredit: 482.47, needsCreditChoice: true })
    expect(q.body.data.ifUsed.total).toBe(0)
    const res = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1', useCredit: true, expectedCredit: 482.47 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/nothing goes on a card/)
    expect(createRentReaderPaymentIntentMock).not.toHaveBeenCalled()
  })

  it('old balance may be added to the reader amount and is paid last', async () => {
    const f = await fixture()
    const { rows: [old] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'carried_balance',300,'pending',CURRENT_DATE - 200,'BALANCE') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    const feeOld = processingFeeFor({ amount: 582.47, paymentMethod: 'card' })
    const totalOld = Math.round((582.47 + feeOld) * 100) / 100
    // Without the extra the old balance is never asked for.
    const plain = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote`).set('Authorization', `Bearer ${f.token}`)
    expect(plain.body.data).toMatchObject({ oldBalance: 300, towardOldBalance: 0, balance: 482.47, total: TOTAL })
    const q = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote?towardOldBalance=100`).set('Authorization', `Bearer ${f.token}`)
    expect(q.status).toBe(200)
    expect(q.body.data).toMatchObject({ towardOldBalance: 100, balance: 582.47, total: totalOld })
    // The old balance is the last line, after the current bill.
    expect(q.body.data.lineItems.map((l: any) => l.amountCents)).toEqual([46000, 2247, 10000])
    expect(q.body.data.lineItems[2].description).toBe('Earlier balance')

    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(totalOld * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId,
                  gam_toward_old: '100.00' },
    } as any)
    const cap = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(cap.status, JSON.stringify(cap.body)).toBe(200)
    const parts = await db.query<any>(
      `SELECT amount::float AS amount, status, is_remainder FROM payments WHERE type='carried_balance' ORDER BY is_remainder`)
    expect(parts.rows).toEqual([
      { amount: 100, status: 'processing', is_remainder: false },
      { amount: 200, status: 'pending', is_remainder: true },
    ])
    const { rows: [app] } = await db.query<any>(
      `SELECT amount_applied::float AS a FROM remittance_applications WHERE payment_id=$1`, [old.id])
    expect(app.a).toBe(100)
  })

  // Fix round 1: the reader was priced with the desk's whole added amount, so
  // the capture must re-price with the same amount — not just the part the
  // old balance took — or every capture of a pay-ahead refuses.
  async function sendThenCapture(f: Awaited<ReturnType<typeof fixture>>, body: Record<string, unknown>) {
    const sent = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1', ...body })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const amountCents = (createRentReaderPaymentIntentMock.mock.calls as any[]).at(-1)[0].amountCents
    const metadata = (paymentIntentsUpdateMock.mock.calls as any[]).at(-1)[1].metadata
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: amountCents,
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId, ...metadata },
    } as any)
    const cap = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    return { sent, cap, amountCents }
  }

  it('an amount added with no old balance at all is captured as sent and becomes paid-ahead money', async () => {
    const f = await fixture()
    const fee = processingFeeFor({ amount: 582.47, paymentMethod: 'card' })
    const { sent, cap, amountCents } = await sendThenCapture(f, { towardOldBalance: 100 })
    expect(amountCents).toBe(Math.round((582.47 + fee) * 100))
    expect(sent.body.data).toMatchObject({ towardOldBalance: 0, paidAhead: 100 })
    expect(cap.status, JSON.stringify(cap.body)).toBe(200)
    expect(cap.body.data).toMatchObject({ status: 'captured', total: Math.round((582.47 + fee) * 100) / 100 })
    expect(paymentIntentsCaptureMock).toHaveBeenCalledWith('pi_reader_1')
    expect(cancelTerminalPaymentIntentMock).not.toHaveBeenCalled()
    const { rows: [rem] } = await db.query<any>(
      `SELECT amount::float AS amount, applied_amount::float AS applied, unapplied_amount::float AS unapplied FROM tenant_remittances`)
    expect(rem).toEqual({ amount: 582.47, applied: 482.47, unapplied: 100 })   // the webhook banks the $100 as paid ahead
  })

  it('an amount added above the old balance pays the old balance and the rest is paid ahead', async () => {
    const f = await fixture()
    const { rows: [old] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'carried_balance',50,'pending',CURRENT_DATE - 200,'BALANCE') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    const { sent, cap } = await sendThenCapture(f, { towardOldBalance: 100 })
    expect(sent.body.data).toMatchObject({ oldBalance: 50, towardOldBalance: 50, paidAhead: 50 })
    expect(cap.status, JSON.stringify(cap.body)).toBe(200)
    const { rows: [rem] } = await db.query<any>(
      `SELECT amount::float AS amount, applied_amount::float AS applied, unapplied_amount::float AS unapplied FROM tenant_remittances`)
    expect(rem).toEqual({ amount: 582.47, applied: 532.47, unapplied: 50 })
    const { rows: [o] } = await db.query<any>(`SELECT status, amount::float AS amount FROM payments WHERE id=$1`, [old.id])
    expect(o).toEqual({ status: 'processing', amount: 50 })
  })

  it('the answer to use or save never goes to the reader without the credit figure it answered', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'other')`, [f.landlordId, f.tenantId, f.leaseId])
    const res = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1', useCredit: true })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/credit figure/)
    expect(createRentReaderPaymentIntentMock).not.toHaveBeenCalled()
  })

  // Probe B: a late fee waived while the card was on the reader leaves the
  // credit covering the whole bill. Nothing goes on the card: the hold is
  // released and the desk is told so — never "captured" with a hold left on.
  it('a bill the credit came to cover while the card was on the reader releases the hold and books nothing', async () => {
    const f = await fixture()
    const { rows: [late] } = await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'late_fee',26.43,'pending',CURRENT_DATE,'LATEFEE') RETURNING id`,
      [f.invoiceId, f.unitId, f.leaseId, f.tenantId, f.landlordId])
    const { rows: [credit] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,482.47,482.47,'other') RETURNING id`, [f.landlordId, f.tenantId, f.leaseId])
    const fee = processingFeeFor({ amount: 26.43, paymentMethod: 'card' })
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round((26.43 + fee) * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId,
                  gam_use_credit: 'true', gam_expected_credit: '482.47' },
    } as any)
    // The late fee is waived before the desk captures.
    await db.query(`UPDATE payments SET status = 'settled', amount = 0, settled_at = NOW() WHERE id = $1`, [late.id])
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/credit now covers this whole bill/)
    expect(res.body.error.match(/nothing was charged/gi)).toHaveLength(1)
    expect(cancelTerminalPaymentIntentMock).toHaveBeenCalledWith({ paymentIntentId: 'pi_reader_1' })
    expect(paymentIntentsCaptureMock).not.toHaveBeenCalled()
    const { rows } = await db.query<any>(`SELECT status FROM payments WHERE invoice_id=$1 AND type <> 'late_fee'`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'pending')).toBe(true)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    const { rows: [c] } = await db.query<any>(`SELECT amount_remaining::float AS r FROM tenant_credits WHERE id=$1`, [credit.id])
    expect(c.r).toBe(482.47)
  })

  // A double-clicked Capture: the second request waits behind the first,
  // which books and captures. It is told the payment is recorded — never
  // "released, nothing was charged" — and nothing is canceled.
  it('a second click on Capture is told the payment is already recorded', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const first = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    // The second request read the intent before the first captured it.
    const second = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.data).toMatchObject({ alreadyBooked: true, remittanceId: first.body.data.remittanceId })
    expect(cancelTerminalPaymentIntentMock).not.toHaveBeenCalled()
    expect(paymentIntentsCaptureMock).toHaveBeenCalledTimes(1)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(1)
  })

  it('two Capture clicks at once book the card once, and neither is told "nothing was charged"', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const capture = () => request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    const both = await Promise.all([capture(), capture()])
    expect(both.map(r => r.status), JSON.stringify(both.map(r => r.body))).toEqual([200, 200])
    expect(both.filter(r => r.body.data.alreadyBooked === true)).toHaveLength(1)
    expect(cancelTerminalPaymentIntentMock).not.toHaveBeenCalled()
    expect(paymentIntentsCaptureMock).toHaveBeenCalledTimes(1)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(1)
  })

  it('a moved balance at capture cancels the hold and books nothing', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100) - 100,
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/hold on the card was released and nothing was charged/)
    expect(captureTerminalPaymentIntentMock).not.toHaveBeenCalled()
    expect(paymentIntentsCaptureMock).not.toHaveBeenCalled()
    expect(cancelTerminalPaymentIntentMock).toHaveBeenCalledWith({ paymentIntentId: 'pi_reader_1' })
    const { rows } = await db.query(`SELECT status, stripe_payment_intent_id FROM payments WHERE invoice_id=$1`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'pending' && r.stripe_payment_intent_id === null)).toBe(true)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  it('a credit that moved since the reader was sent the amount cancels the hold and books nothing', async () => {
    const f = await fixture()
    // The reader was sent "use the $100 credit"; the credit is $50 now.
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,50,50,'other')`, [f.landlordId, f.tenantId, f.leaseId])
    const feeUsed = processingFeeFor({ amount: 382.47, paymentMethod: 'card' })
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round((382.47 + feeUsed) * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId,
                  gam_use_credit: 'true', gam_expected_credit: '100.00' },
    } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/credit changed/)
    // Each part said once: the cause, the released hold, the next step.
    expect(res.body.error).toBe(
      "Your credit changed — it's now $50.00. The hold on the card was released and nothing was charged — look at the balance again and start over.")
    expect(cancelTerminalPaymentIntentMock).toHaveBeenCalledWith({ paymentIntentId: 'pi_reader_1' })
    expect(paymentIntentsCaptureMock).not.toHaveBeenCalled()
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  it('will not book before the reader has approved the card', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_payment_method', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(409)
  })

  // S654 review: the capture happens INSIDE the booking transaction, so a
  // failed capture leaves no rows, no remittance, no "booked" label on the
  // intent, and no hold on the card.
  it('a failed capture leaves nothing behind and releases the hold', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    paymentIntentsCaptureMock.mockRejectedValueOnce(new Error('authorization expired'))
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(502)
    const { rows } = await db.query<any>(`SELECT status, stripe_payment_intent_id, payment_channel FROM payments WHERE invoice_id=$1`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'pending' && r.stripe_payment_intent_id === null && r.payment_channel === null)).toBe(true)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
    // The intent is put back in its pending shape and the authorization released.
    expect(paymentIntentsUpdateMock).toHaveBeenLastCalledWith('pi_reader_1', expect.objectContaining({
      metadata: expect.objectContaining({ gam_purpose: 'rent_terminal_pending' }),
    }))
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_reader_1')
  })

  it('a capture whose reply was lost but landed keeps the booking', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    paymentIntentsCaptureMock.mockRejectedValueOnce(new Error('socket hang up'))
    paymentIntentsRetrieveMock.mockResolvedValueOnce({ id: 'pi_reader_1', status: 'succeeded' } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(`SELECT status FROM payments WHERE invoice_id=$1`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'processing')).toBe(true)
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
  })

  it('a reader that is not the sale\'s company\'s is never told to cancel', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_payment_method', amount: 1,
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/cancel`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_someone_elses' })
    expect(res.status).toBe(200)
    expect(readersCancelActionMock).not.toHaveBeenCalled()
    expect(cancelTerminalPaymentIntentMock).toHaveBeenCalled()
  })

  it('cancel clears the reader and the intent, and a stranger cannot touch it', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_payment_method', amount: 1,
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/cancel`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(res.status).toBe(200)
    expect(readersCancelActionMock).toHaveBeenCalledWith('tmr_1')
    expect(cancelTerminalPaymentIntentMock).toHaveBeenCalled()

    const other = await seedLandlord(await db.connect().then(c => { c.release(); return c }))
    const strangerToken = jwt.sign({ userId: other.userId, role: 'landlord', email: 'x@t.dev', profileId: null,
      landlordIds: [other.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    const res2 = await request(buildApp()).get(`/api/payments/reader/intents/pi_reader_1`).set('Authorization', `Bearer ${strangerToken}`)
    expect(res2.status).toBe(404)
  })

  // S654 (Nic): "I don't want it to void the charge." A timed-out charge is
  // cleared off the reader and sent AGAIN, as long as the balance hasn't moved.
  it('clear-reader keeps the charge; resend puts the same charge back when the balance is unchanged', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_payment_method', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const cleared = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/clear-reader`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(cleared.status).toBe(200)
    expect(cancelReaderActionMock).toHaveBeenCalledWith('tmr_1')
    expect(cancelTerminalPaymentIntentMock).not.toHaveBeenCalled()
    const again = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/resend`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data.total).toBe(TOTAL)
    expect(processPaymentIntentOnReaderMock).toHaveBeenCalledWith({ stripeReaderId: 'tmr_1', paymentIntentId: 'pi_reader_1' })
    expect(showCartOnReaderMock).toHaveBeenCalled()
    expect(createRentReaderPaymentIntentMock).not.toHaveBeenCalled()   // the same charge, not a new one
  })

  it('resend refuses a moved balance and an already-approved card', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_reader_1', status: 'requires_payment_method', amount: Math.round(TOTAL * 100) - 100,
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const moved = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/resend`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(moved.status).toBe(409)
    expect(String(moved.body.error)).toMatch(/balance changed/i)
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const approved = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/resend`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(approved.status).toBe(409)
    expect(String(approved.body.error)).toMatch(/already approved/i)
    expect(processPaymentIntentOnReaderMock).not.toHaveBeenCalled()
  })

  it('a staffer assigned to another property cannot quote, send or capture this balance', async () => {
    const f = await fixture()
    const c = await db.connect()
    let otherProperty = ''
    try {
      await c.query('BEGIN')
      otherProperty = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('desk-elsewhere-' || gen_random_uuid() || '@t.dev','x','onsite_manager','Desk','Elsewhere',TRUE) RETURNING id`)
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, permissions)
       VALUES ($1,$2,$3,'{"take_payment":true}'::jsonb)`, [u.id, f.landlordId, [otherProperty]])
    const desk = jwt.sign({ userId: u.id, role: 'onsite_manager', email: 'd@t.dev', profileId: null,
      landlordId: f.landlordId, permissions: { take_payment: true } }, SECRET, { expiresIn: '1h' })
    const q = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote`).set('Authorization', `Bearer ${desk}`)
    expect(q.status).toBe(403)
    const send = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${desk}`).send({ stripeReaderId: 'tmr_1' })
    expect(send.status).toBe(403)
    expect(createRentReaderPaymentIntentMock).not.toHaveBeenCalled()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100),
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const cap = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${desk}`).send({})
    expect(cap.status).toBe(403)
    expect(paymentIntentsCaptureMock).not.toHaveBeenCalled()
    const { rows } = await db.query(`SELECT status FROM payments WHERE invoice_id=$1`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'pending')).toBe(true)
  })

  it('the history says how it was paid', async () => {
    const f = await fixture()
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW(), manual_method='check' WHERE id=$1`, [f.rentId])
    const res = await request(buildApp()).get(`/api/payments?status=settled`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((p: any) => p.id === f.rentId)
    expect(row.paid_by).toBe('check')   // camelized by the app-level middleware, not here
  })
})

// Review (pay7 money-3): the reader reads the bill as it really stands — a card
// hold of this household's that nobody confirmed in 30 minutes (decisions.md
// #48.4) is released before the reader is quoted, sent or captured, the same
// as the desk window. Otherwise the reader would ask for less than is owed and
// the resident would have to pay twice.
describe('the reader and a card hold on the bill (3-D Secure)', () => {
  const DEFAULT_RETRIEVE = async () => ({ id: 'pi_reader_1', status: 'requires_capture' })
  /** A pay-screen card payment of the resident's holding `rowId`, made `minutesAgo` minutes ago, its bank still asking. */
  async function portalHold(f: Awaited<ReturnType<typeof fixture>>, rowId: string, pi: string, minutesAgo: number, amount: number) {
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = $2 WHERE id = $1`, [rowId, pi])
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id, status, created_at)
       VALUES ($1,$2,$3,$4,$4,0,'card',$4,0,$5,'processing', now() - ($6 || ' minutes')::interval)`,
      [f.tenantId, f.leaseId, f.landlordId, amount, pi, String(minutesAgo)])
    ;(paymentIntentsRetrieveMock as any).mockImplementation(async (id: string) => id === pi
      ? { id, status: 'requires_action', metadata: { gam_confirm_on_screen: 'true' } }
      : DEFAULT_RETRIEVE())
  }
  afterEach(() => { (paymentIntentsRetrieveMock as any).mockImplementation(DEFAULT_RETRIEVE) })
  const utilityRow = async (f: Awaited<ReturnType<typeof fixture>>) => (await db.query<{ id: string }>(
    `SELECT id FROM payments WHERE lease_id = $1 AND type = 'utility'`, [f.leaseId])).rows[0].id

  it('a hold 40 minutes old is released before the reader quote, and the quote includes those rows', async () => {
    const f = await fixture()
    const water = await utilityRow(f)
    await portalHold(f, water, 'pi_portal_old', 40, 22.47)
    const res = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_portal_old')
    expect(res.body.data.balance).toBe(482.47)
    expect(res.body.data.total).toBe(TOTAL)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [water])).rows[0].status).toBe('pending')
  })

  it('a hold 40 minutes old on the very charge the reader starts from is released, and the charge goes to the reader for the whole bill', async () => {
    const f = await fixture()
    await portalHold(f, f.rentId, 'pi_portal_anchor', 40, 460)
    const res = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(paymentIntentsCancelMock).toHaveBeenCalledWith('pi_portal_anchor')
    expect(res.body.data.total).toBe(TOTAL)
  })

  it('a hold still inside its 30 minutes keeps the charge closed: refused in plain words, with how the resident can pay another way now — nothing canceled', async () => {
    const f = await fixture()
    await portalHold(f, f.rentId, 'pi_portal_fresh', 5, 460)
    const res = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(409)
    const msg = JSON.stringify(res.body)
    expect(msg).toContain('waiting on the resident\'s card payment to be confirmed by their card\'s bank — nothing has been charged yet')
    expect(msg).toContain('Cancel it and pay another way')
    expect(msg).not.toContain('status:')
    expect(paymentIntentsCancelMock).not.toHaveBeenCalled()
  })
})
