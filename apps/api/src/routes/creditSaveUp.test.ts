/**
 * 10/26 (Nic): A PROPERTY CHOOSES WHETHER CREDIT MAY BE SAVED UP.
 *
 *   "there needs to be a property level setting where landlords can choose if
 *    people are allowed to save up credit ahead of time... Blue wants to have
 *    his property set where any credit is automatically applied against the
 *    thing. There's no saving it up."
 *
 * The setting governs ONE thing: the pay screen's "Save it for later". Credit
 * already goes onto an open balance by itself on every property (Nic, 10/15) —
 * at the bill run, before any late fee, and whenever a credit is issued — and
 * no setting turns that off. These tests pin both halves, because the easy
 * mistake is to build a toggle that silently disables the 10/15 rule.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query, queryOne, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'
import { planLeaseCharge, quoteLeaseCharge } from '../services/rentCharge'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_credit_save_up'
})

/** A lease owing $450 rent, with $100 of landlord-issued credit on the account. */
async function seed(opts: { credit?: number } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 450 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    // An OPEN rent row on the lease — seedRentPayment settles it and keys off
    // the unit rather than the lease, so neither the bill nor the credit plan
    // would see anything.
    const paymentId = (await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status,
                             entry_description, due_date)
       VALUES ($1, $2, $3, $4, 'rent', 450, 'pending', 'RENT', CURRENT_DATE) RETURNING id`,
      [ll.landlordId, tenantId, unitId, leaseId])).rows[0].id
    // A charge checks the payment setup before it ever reaches the credit
    // question, so the tenant needs a Stripe customer for these tests to get
    // as far as the thing they are about.
    await c.query(`UPDATE tenants SET stripe_customer_id = 'cus_credit_save_up' WHERE id = $1`, [tenantId])
    const credit = opts.credit ?? 100
    if (credit > 0) {
      await c.query(
        `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining,
                                     category, reason)
         VALUES ($1, $2, $3, $4, $4, 'other', 'Goodwill')`,
        [ll.landlordId, tenantId, leaseId, credit])
    }
    await c.query('COMMIT')
    return {
      ...ll, propertyId, unitId, tenantId, leaseId, paymentId,
      landlordToken: jwt.sign(
        { userId: ll.userId, role: 'landlord', email: `${ll.userId}@t.dev`, profileId: ll.landlordId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const setting = (propertyId: string) => queryOne<any>(
  `SELECT credit_save_up_allowed FROM properties WHERE id = $1`, [propertyId])

async function turnOff(s: { propertyId: string; landlordToken: string }) {
  const res = await request(buildApp()).patch(`/api/properties/${s.propertyId}`)
    .set('Authorization', `Bearer ${s.landlordToken}`)
    .send({ creditSaveUpAllowed: false })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}

describe('the setting itself', () => {
  // Default TRUE so nothing changes for any property the day this lands, and
  // no tenant loses a choice they were being offered.
  it('starts out allowing credit to be saved, as every property did before', async () => {
    const s = await seed()
    expect((await setting(s.propertyId)).credit_save_up_allowed).toBe(true)
  })

  it('saves when a landlord turns it off', async () => {
    const s = await seed()
    await turnOff(s)
    expect((await setting(s.propertyId)).credit_save_up_allowed).toBe(false)
  })

  // THE BUG THIS TEST EXISTS FOR. Every setting on this PATCH shares one
  // UPDATE and one numbered parameter list, and the suite line's "was it sent"
  // flag sits in the middle of it. A new setting that reuses a number already
  // in use swaps two columns' values — which is exactly what nearly shipped
  // with the trailer-billing setting on 10/25.
  it('does not disturb the address or the trailer-billing choice', async () => {
    const s = await seed()
    await request(buildApp()).patch(`/api/properties/${s.propertyId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ street2: 'Suite 7', homePaymentsOwnBill: false }).expect(200)
    const before = await queryOne<any>(
      `SELECT street1, street2, home_payments_own_bill FROM properties WHERE id = $1`, [s.propertyId])
    expect(before).toMatchObject({ street2: 'Suite 7', home_payments_own_bill: false })

    await turnOff(s)
    const after = await queryOne<any>(
      `SELECT street1, street2, home_payments_own_bill, credit_save_up_allowed
         FROM properties WHERE id = $1`, [s.propertyId])
    expect(after).toMatchObject({
      street1: before.street1, street2: 'Suite 7',
      home_payments_own_bill: false, credit_save_up_allowed: false,
    })
  })

  it('and saving something else does not flip it back on', async () => {
    const s = await seed()
    await turnOff(s)
    await request(buildApp()).patch(`/api/properties/${s.propertyId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ street2: 'Suite 9' }).expect(200)
    const after = await queryOne<any>(
      `SELECT credit_save_up_allowed, street2 FROM properties WHERE id = $1`, [s.propertyId])
    expect(after).toMatchObject({ credit_save_up_allowed: false, street2: 'Suite 9' })
  })
})

describe('what the pay screen is told', () => {
  it('offers the choice where saving is allowed', async () => {
    const s = await seed()
    const client = await getClient()
    try {
      const plan = await planLeaseCharge(client, { tenantId: s.tenantId, scope: { kind: 'lease', leaseId: s.leaseId } })
      expect(plan.ctx.creditSaveUpAllowed).toBe(true)
      expect(plan.usableCredit).toBe(100)
    } finally { client.release() }
  })

  it('says there is no choice where saving is off', async () => {
    const s = await seed()
    await turnOff(s)
    const client = await getClient()
    try {
      const plan = await planLeaseCharge(client, { tenantId: s.tenantId, scope: { kind: 'lease', leaseId: s.leaseId } })
      expect(plan.ctx.creditSaveUpAllowed).toBe(false)
      expect(plan.usableCredit).toBe(100)
    } finally { client.release() }
  })
})

describe('paying where credit cannot be saved', () => {
  // A quote with no answer stands in for the screen asking: where saving is
  // off, the credit is already counted as used, so the figure the tenant is
  // shown is the figure they are charged.
  it('quotes the bill with the credit already taken off', async () => {
    const s = await seed()
    await turnOff(s)
    const q = await quoteLeaseCharge({
      tenantId: s.tenantId, leaseId: s.leaseId, paymentMethodType: 'ach',
    })
    expect(q.usableCredit).toBe(100)
    expect(q.ctx.creditSaveUpAllowed).toBe(false)
  })

  // An older screen still showing "Save it for later" must be refused, not
  // quietly charged the other figure — the amount a tenant confirmed has to be
  // the amount they are charged.
  it('refuses a payment that asks to save the credit', async () => {
    const s = await seed()
    await turnOff(s)
    const { chargeLeaseBalance } = await import('../services/rentCharge')
    await expect(chargeLeaseBalance({
      tenantId: s.tenantId, leaseId: s.leaseId, amount: 450, paymentMethodType: 'ach',
      credit: { use: false, expected: 100 }, source: 'tenant_portal', dryRun: true,
    } as any)).rejects.toThrow(/cannot be saved for later/)
  })

  it('still allows it where the property leaves saving on', async () => {
    const s = await seed()
    const { chargeLeaseBalance } = await import('../services/rentCharge')
    await expect(chargeLeaseBalance({
      tenantId: s.tenantId, leaseId: s.leaseId, amount: 450, paymentMethodType: 'ach',
      credit: { use: false, expected: 100 }, source: 'tenant_portal', dryRun: true,
    } as any)).resolves.toBeTruthy()
  })
})

describe('what the setting must never change', () => {
  // Nic, 10/15: credit never sits on an account while they owe. That is every
  // property, and this setting governs only the payer's option at the moment
  // they pay. A toggle that switched off the automatic draw would quietly undo
  // a money rule Nic set, so it is pinned here on a property with saving ON.
  it('credit still goes onto the open balance by itself, whatever the setting', async () => {
    for (const allowed of [true, false]) {
      await cleanupAllSchema()
      const s = await seed()
      if (!allowed) await turnOff(s)
      const { runWholeBillCheckAfterCommit } = await import('../services/creditUse')
      await runWholeBillCheckAfterCommit({ tenantId: s.tenantId, landlordId: s.landlordId })
      const used = await query<any>(
        `SELECT COALESCE(SUM(amount), 0)::float AS used FROM credit_uses
          WHERE payment_id = $1 AND status = 'applied'`, [s.paymentId])
      expect(used[0].used, `save-up allowed=${allowed}`).toBe(100)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10/26 (Nic) — THE DESK HAS TO FOLLOW THE SAME ANSWER.
//
//   "It doesn't make sense for it to auto take it and apply it when the
//    landlord is marking a payment versus if the tenant is paying through the
//    app. A tenant who's paying cash may still want to save it up for later,
//    and they would have no way to do that."
//
// The desk has always asked Use/Save (the credit choice in
// services/manualPaymentSettle), so a cash payer could in fact hold credit.
// What it did NOT do was read the property's setting, so a property set to
// apply credit automatically still offered Save at the counter — the opposite
// of the landlord's answer, reached by walking in instead of logging in.
describe('the front desk', () => {
  async function onClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
    const c = await getClient()
    try { return await fn(c) } finally { c.release() }
  }

  const deskQuoteFor = (s: { tenantId: string; landlordId: string }) => onClient(async c => {
    const { deskQuote } = await import('../services/manualPaymentSettle')
    return deskQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId })
  })

  /** The desk recording cash against the open rent row, in the desk's own shape. */
  const recordCash = (
    s: { paymentId: string; tenantId: string; landlordId: string; unitId: string; leaseId: string },
    extra: Record<string, unknown>,
  ) => onClient(async c => {
    const { settleManualRentPayment } = await import('../services/manualPaymentSettle')
    await c.query('BEGIN')
    try {
      const r = await settleManualRentPayment(c, {
        payment: {
          id: s.paymentId, landlord_id: s.landlordId, tenant_id: s.tenantId,
          unit_id: s.unitId, lease_id: s.leaseId, due_date: null,
        },
        method: 'cash', settleHousehold: true, surplusHandling: 'credit',
        confirmWrittenAmount: true, sendReceipt: false, ...extra,
      } as any)
      await c.query('COMMIT')
      return r
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
  })

  const creditUsedOn = async (paymentId: string) => (await query<any>(
    `SELECT COALESCE(SUM(amount), 0)::float AS used FROM credit_uses
      WHERE payment_id = $1 AND status = 'applied'`, [paymentId]))[0].used

  it('is told the credit must be used where the landlord turned saving off', async () => {
    const s = await seed()
    expect((await deskQuoteFor(s)).creditMustBeUsed).toBe(false)
    await turnOff(s)
    const q = await deskQuoteFor(s)
    expect(q.creditMustBeUsed).toBe(true)
    // The figure is still there to STATE — the desk shows it, it just is not asked.
    expect(q.usableCredit).toBe(100)
    expect(q.owedIfUsed).toBe(350)
  })

  it('refuses a counter payment that tries to save the credit anyway', async () => {
    const s = await seed()
    await turnOff(s)
    await expect(recordCash(s, { amountTendered: 450, creditToUse: 0 }))
      .rejects.toThrow(/cannot be saved for later/)
  })

  it('takes the payment with the credit used, no answer asked', async () => {
    const s = await seed()
    await turnOff(s)
    await recordCash(s, { amountTendered: 350 })
    expect(await creditUsedOn(s.paymentId)).toBe(100)
  })

  it('still asks at a property that allows saving, and honours Save', async () => {
    const s = await seed()
    await expect(recordCash(s, { amountTendered: 450 })).rejects.toThrow(/Choose Use/)
    await recordCash(s, { amountTendered: 450, creditToUse: 0 })
    const left = await query<any>(
      `SELECT COALESCE(SUM(amount_remaining), 0)::float AS c FROM tenant_credits WHERE tenant_id = $1`,
      [s.tenantId])
    expect(left[0].c).toBe(100)
  })

  // The bug this caught before it shipped: neverUseCredit is not a Save
  // answer, it is services/postPayment — money that arrived before there was a
  // bill, which by S655 never spends credit and is never asked about. Refusing
  // it alongside Save would have broken posting a check at Country Acres.
  it('does not break posting a payment, which never spends credit by design', async () => {
    const s = await seed()
    await turnOff(s)
    await recordCash(s, { amountTendered: 450, neverUseCredit: true })
    expect(await creditUsedOn(s.paymentId)).toBe(0)
    const left = await query<any>(
      `SELECT COALESCE(SUM(amount_remaining), 0)::float AS c FROM tenant_credits WHERE tenant_id = $1`,
      [s.tenantId])
    expect(left[0].c).toBe(100)
  })
})
