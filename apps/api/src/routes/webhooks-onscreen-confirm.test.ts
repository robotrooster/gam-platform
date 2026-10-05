/**
 * decisions.md #48.4 — a card the tenant pay screen was confirming with its
 * bank (3-D Secure), through the real Stripe webhook.
 *
 * The pay screen keeps such a charge (services/rentCharge stamps
 * gam_confirm_on_screen) and holds the bill while the cardholder confirms. When
 * the bank's confirmation fails or is abandoned, Stripe sends
 * payment_intent.payment_failed — usually before the screen's own release
 * lands. That is NOT a declined payment: the screen tells the payer nothing was
 * charged and the bill is open again, so the webhook does exactly that and
 * nothing more — no $1 decline fee, no "payment failed" notice or email, no
 * NSF event on the tenant's credit record. A cancel of such a charge (the
 * 30-minute release, the screen's Cancel, or in Stripe) is the same release.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})
vi.mock('../services/creditLedgerEmitters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/creditLedgerEmitters')>()
  return { ...actual, emitPaymentFailedEvent: vi.fn(actual.emitPaymentFailedEvent) }
})

// Stripe's copy of each charge: its status, and the metadata it was made with
// (every charge here is the pay screen's unless a case says otherwise — Stripe
// hands back the same metadata the event carries).
const stripeState = vi.hoisted(() => ({ status: new Map<string, string>(), metadata: new Map<string, Record<string, string>>() }))
const piMocks = vi.hoisted(() => ({
  retrieve: null as any,
  cancel: null as any,
}))
vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  piMocks.retrieve = vi.fn(async (id: string) => ({ id, status: stripeState.status.get(id) ?? 'requires_payment_method',
    metadata: stripeState.metadata.get(id) ?? { gam_confirm_on_screen: 'true', gam_charge_source: 'portal' } }))
  piMocks.cancel = vi.fn(async (id: string) => { stripeState.status.set(id, 'canceled'); return { id, status: 'canceled' } })
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_mock' })) }
    this.customers = { retrieve: vi.fn(async (id: string) => ({ id, invoice_settings: { default_payment_method: null } })), update: vi.fn(async (id: string) => ({ id })) }
    this.paymentIntents = { create: vi.fn(async () => ({ id: 'pi_mock' })), cancel: piMocks.cancel, retrieve: piMocks.retrieve }
    this.paymentMethods = { retrieve: vi.fn(async (id: string) => ({ id })), update: vi.fn(async (id: string) => ({ id })), list: vi.fn(async () => ({ data: [] })) }
    this.setupIntents = { list: vi.fn(async () => ({ data: [] })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
  }
  return { default: FakeStripe }
})

import { webhooksRouter } from './webhooks'
import { db, getClient } from '../db'
import { sendNotificationEmail } from '../services/email'
import { emitPaymentFailedEvent } from '../services/creditLedgerEmitters'
import { holdCredit } from '../services/creditUse'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  return app
}
const postEvent = (evt: unknown) => request(buildApp()).post('/webhooks/stripe')
  .set('Content-Type', 'application/json').set('stripe-signature', 'test').send(JSON.stringify(evt))

beforeEach(async () => {
  await cleanupAllSchema()
  stripeState.status.clear()
  stripeState.metadata.clear()
  piMocks.retrieve.mockClear()
  piMocks.cancel.mockClear()
  vi.mocked(sendNotificationEmail).mockClear()
  vi.mocked(emitPaymentFailedEvent).mockClear()
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
})

interface Held { tenantId: string; tenantUserId: string; landlordId: string; unitId: string; rowId: string; remId: string; creditId: string }

/** A $1,000 rent bill held by a $700 pay-screen card charge plus $300 of credit set aside on it. */
async function seedHeld(pi: string): Promise<Held> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const rowId = (await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',1000,'pending','2026-10-01','RENT') RETURNING id`,
      [unitId, leaseId, tenantId, ll.landlordId])).rows[0].id
    const creditId = (await c.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,300,300,'goodwill') RETURNING id`, [ll.landlordId, tenantId, leaseId])).rows[0].id
    const remId = (await c.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, gross_amount, processing_fee_amount)
       VALUES ($1,$2,$3,700,700,0,'card',725.05,25.05) RETURNING id`, [tenantId, leaseId, ll.landlordId])).rows[0].id
    await holdCredit(c, [{ creditKind: 'issued', creditId, paymentId: rowId, leaseId, amount: 300, billingMonth: '2026-10-01' }],
      { remittanceId: remId, source: 'portal' })
    await c.query(`UPDATE payments SET status = 'processing', platform_held = TRUE, stripe_payment_intent_id = $2 WHERE id = $1`, [rowId, pi])
    await c.query(`UPDATE tenant_remittances SET stripe_payment_intent_id = $2 WHERE id = $1`, [remId, pi])
    await c.query('COMMIT')
    return { tenantId, tenantUserId, landlordId: ll.landlordId, unitId, rowId, remId, creditId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Stripe's payment_failed for a card whose bank's confirmation failed (3-D Secure). */
function confirmationFailed(pi: string, metadata: Record<string, string>, eventId = 'evt_fail_' + pi) {
  return {
    id: eventId, type: 'payment_intent.payment_failed',
    data: { object: {
      id: pi, status: 'requires_payment_method', metadata, payment_method_types: ['card'],
      last_payment_error: {
        type: 'card_error', code: 'payment_intent_authentication_failure',
        message: 'The provided PaymentMethod has failed authentication.', payment_method: { type: 'card' },
      },
    } },
  }
}
function canceled(pi: string, metadata: Record<string, string>) {
  return { id: 'evt_cancel_' + pi, type: 'payment_intent.canceled', data: { object: { id: pi, status: 'canceled', metadata } } }
}
const ON_SCREEN = { gam_confirm_on_screen: 'true', gam_charge_source: 'portal' }

const rowOf = async (id: string) => (await db.query<any>(
  `SELECT status, next_retry_at FROM payments WHERE id = $1`, [id])).rows[0]
const remOf = async (id: string) => (await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [id])).rows[0].status
const creditLeft = async (id: string) => Number((await db.query<any>(
  `SELECT amount_remaining FROM tenant_credits WHERE id = $1`, [id])).rows[0].amount_remaining)
const declineFees = async () => (await db.query(`SELECT 1 FROM payments WHERE entry_description = 'DECLINEFEE'`)).rowCount
const nsfEvents = async () => (await db.query(`SELECT 1 FROM credit_events WHERE event_type = 'payment_failed_nsf'`)).rowCount
const noticesTo = async (userId: string) => (await db.query(`SELECT type FROM notifications WHERE user_id = $1`, [userId])).rows

describe('payment_intent.payment_failed for a pay-screen card confirmation (decisions.md #48.4)', () => {
  it('a failed bank confirmation is not a decline: the bill opens again, the credit comes back — no decline fee, no notice or email, no NSF event', async () => {
    const h = await seedHeld('pi_3ds_fail')
    const res = await postEvent(confirmationFailed('pi_3ds_fail', ON_SCREEN))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(piMocks.cancel).toHaveBeenCalledWith('pi_3ds_fail')
    expect(await rowOf(h.rowId)).toEqual({ status: 'pending', next_retry_at: null })
    expect(await remOf(h.remId)).toBe('failed')
    expect(await creditLeft(h.creditId)).toBe(300)
    expect(await declineFees()).toBe(0)
    expect(await nsfEvents()).toBe(0)
    expect(vi.mocked(emitPaymentFailedEvent)).not.toHaveBeenCalled()
    expect(vi.mocked(sendNotificationEmail)).not.toHaveBeenCalled()
    expect(await noticesTo(h.tenantUserId)).toEqual([])
  })

  it('the screen\'s own Cancel landed first: the failure that follows changes nothing more', async () => {
    const h = await seedHeld('pi_3ds_late')
    // The screen released it: canceled in Stripe, rows open again, credit back.
    stripeState.status.set('pi_3ds_late', 'canceled')
    await db.query(`UPDATE payments SET status = 'pending', stripe_payment_intent_id = NULL, next_retry_at = NULL WHERE id = $1`, [h.rowId])
    expect((await postEvent(canceled('pi_3ds_late', ON_SCREEN))).status).toBe(200)
    expect(await creditLeft(h.creditId)).toBe(300)
    const res = await postEvent(confirmationFailed('pi_3ds_late', ON_SCREEN))
    expect(res.status).toBe(200)
    expect(piMocks.cancel).not.toHaveBeenCalled()
    expect(await creditLeft(h.creditId)).toBe(300)
    expect(await declineFees()).toBe(0)
    expect(vi.mocked(sendNotificationEmail)).not.toHaveBeenCalled()
  })

  it('a confirmation the cardholder finished meanwhile is left to the success webhook — nothing reopened', async () => {
    const h = await seedHeld('pi_3ds_won')
    stripeState.status.set('pi_3ds_won', 'succeeded')
    const res = await postEvent(confirmationFailed('pi_3ds_won', ON_SCREEN))
    expect(res.status).toBe(200)
    expect(piMocks.cancel).not.toHaveBeenCalled()
    expect((await rowOf(h.rowId)).status).toBe('processing')
    expect(await remOf(h.remId)).toBe('processing')
    expect(await declineFees()).toBe(0)
  })

  it('Stripe could not be asked: the webhook answers 500 so Stripe sends it again — never the decline path', async () => {
    const h = await seedHeld('pi_3ds_down')
    piMocks.retrieve.mockRejectedValueOnce(new Error('Stripe unreachable'))
    const res = await postEvent(confirmationFailed('pi_3ds_down', ON_SCREEN))
    expect(res.status).toBe(500)
    expect((await rowOf(h.rowId)).status).toBe('processing')
    expect(await declineFees()).toBe(0)
  })

  it('why it was released is recorded on the receipt: a failed confirmation as canceled, a decline after confirming as declined (from the event, which Stripe clears once canceled) — still no decline fee or notice', async () => {
    const { CARD_RELEASE_NOTE } = await import('../jobs/paymentReconcile')
    const a = await seedHeld('pi_3ds_note_auth')
    expect((await postEvent(confirmationFailed('pi_3ds_note_auth', ON_SCREEN))).status).toBe(200)
    expect((await db.query<any>(`SELECT notes FROM tenant_remittances WHERE id = $1`, [a.remId])).rows[0].notes).toBe(CARD_RELEASE_NOTE.canceled)
    const d = await seedHeld('pi_3ds_note_declined')
    const declined = confirmationFailed('pi_3ds_note_declined', ON_SCREEN) as any
    declined.data.object.last_payment_error = { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card was declined.' }
    expect((await postEvent(declined)).status).toBe(200)
    expect((await db.query<any>(`SELECT notes FROM tenant_remittances WHERE id = $1`, [d.remId])).rows[0].notes).toBe(CARD_RELEASE_NOTE.declined)
    expect(await rowOf(d.rowId)).toEqual({ status: 'pending', next_retry_at: null })
    expect(await declineFees()).toBe(0)
    expect(vi.mocked(sendNotificationEmail)).not.toHaveBeenCalled()
    // The cancel event that follows (no error on it) leaves the decline recorded.
    expect((await postEvent(canceled('pi_3ds_note_declined', ON_SCREEN))).status).toBe(200)
    expect((await db.query<any>(`SELECT notes FROM tenant_remittances WHERE id = $1`, [d.remId])).rows[0].notes).toBe(CARD_RELEASE_NOTE.declined)
  })

  it('a card declined anywhere else still takes the normal failure path (the $1 decline fee)', async () => {
    const h = await seedHeld('pi_card_declined')
    const res = await postEvent(confirmationFailed('pi_card_declined', { gam_charge_source: 'autopay' }))
    expect(res.status).toBe(200)
    expect(piMocks.retrieve).not.toHaveBeenCalled()
    expect((await rowOf(h.rowId)).status).toBe('failed')
    expect(await declineFees()).toBe(1)
  })
})

describe('payment_intent.canceled for a pay-screen card confirmation (decisions.md #48.4)', () => {
  it('canceled (the 30-minute release or in Stripe): the bill opens again and its platform-fee link clears, without asking Stripe again', async () => {
    const h = await seedHeld('pi_3ds_cancel')
    const propertyId = (await db.query<any>(`SELECT property_id FROM units WHERE id = $1`, [h.unitId])).rows[0].property_id
    const accrual = (await db.query<{ id: string }>(
      `INSERT INTO platform_fee_accruals (property_id, landlord_id, accrual_month, rate_per_unit, min_per_connect_account, total_amount, payer, tenant_charge_id)
       VALUES ($1,$2,'2026-10-01',2,10,2,'tenant',$3) RETURNING id`, [propertyId, h.landlordId, h.rowId])).rows[0].id
    const res = await postEvent(canceled('pi_3ds_cancel', ON_SCREEN))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(piMocks.retrieve).not.toHaveBeenCalled()
    expect(await rowOf(h.rowId)).toEqual({ status: 'pending', next_retry_at: null })
    expect(await remOf(h.remId)).toBe('failed')
    expect(await creditLeft(h.creditId)).toBe(300)
    expect((await db.query<any>(`SELECT tenant_charge_id FROM platform_fee_accruals WHERE id = $1`, [accrual])).rows[0].tenant_charge_id).toBeNull()
    expect(vi.mocked(sendNotificationEmail)).not.toHaveBeenCalled()
    expect(await noticesTo(h.tenantUserId)).toEqual([])
  })
})
