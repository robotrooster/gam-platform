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
} = vi.hoisted(() => ({
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
    // The ledger is untouched until the card is approved.
    const { rows } = await db.query(`SELECT status, stripe_payment_intent_id FROM payments WHERE invoice_id=$1`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'pending' && r.stripe_payment_intent_id === null)).toBe(true)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
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

  // S654 review: the counter takes what is OWED — credit on the account netted,
  // exactly the figure the portal and the desk show.
  it('credit on the account comes off the reader total, and the quote says so', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'other')`, [f.landlordId, f.tenantId, f.leaseId])
    const q = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote`).set('Authorization', `Bearer ${f.token}`)
    expect(q.status).toBe(200)
    const fee = processingFeeFor({ amount: 382.47, paymentMethod: 'card' })
    expect(q.body.data).toEqual({ outstanding: 482.47, creditApplied: 100, balance: 382.47, cardFee: fee, total: Math.round((382.47 + fee) * 100) / 100 })
    const res = await request(buildApp()).post(`/api/payments/${f.rentId}/reader/charge`)
      .set('Authorization', `Bearer ${f.token}`).send({ stripeReaderId: 'tmr_1' })
    expect(res.status).toBe(201)
    expect(res.body.data.total).toBe(q.body.data.total)
    expect(createRentReaderPaymentIntentMock).toHaveBeenCalledWith(expect.objectContaining({ amountCents: Math.round(q.body.data.total * 100) }))
  })

  it('a credit that covers the whole balance means nothing goes to the reader', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,600,600,'other')`, [f.landlordId, f.tenantId, f.leaseId])
    const q = await request(buildApp()).get(`/api/payments/${f.rentId}/reader/quote`).set('Authorization', `Bearer ${f.token}`)
    expect(q.status).toBe(409)
    expect(createRentReaderPaymentIntentMock).not.toHaveBeenCalled()
  })

  it('refuses to book when the balance moved since the reader was sent the amount', async () => {
    const f = await fixture()
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_reader_1', status: 'requires_capture', amount: Math.round(TOTAL * 100) - 100,
      metadata: { gam_purpose: 'rent_terminal_pending', gam_landlord_id: f.landlordId, gam_anchor_payment_id: f.rentId },
    } as any)
    const res = await request(buildApp()).post(`/api/payments/reader/intents/pi_reader_1/capture`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(409)
    expect(captureTerminalPaymentIntentMock).not.toHaveBeenCalled()
    const { rows } = await db.query(`SELECT status FROM payments WHERE invoice_id=$1`, [f.invoiceId])
    expect(rows.every((r: any) => r.status === 'pending')).toBe(true)
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

  it('the history says how it was paid', async () => {
    const f = await fixture()
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW(), manual_method='check' WHERE id=$1`, [f.rentId])
    const res = await request(buildApp()).get(`/api/payments?status=settled`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((p: any) => p.id === f.rentId)
    expect(row.paid_by).toBe('check')   // camelized by the app-level middleware, not here
  })
})
