/**
 * 10/5 (Nic) — money moving through GAM ends a landlord's free onboarding.
 *
 *   "The onboarding period is until money processes through the system. Rent
 *    is the same as a stay as an invoice... You don't need to tag it as only
 *    rent. Somebody's only paying utilities, that's the landlord doesn't have
 *    free onboarding... money movement is the end of onboarding."
 *
 * Each door where a payer's money lands ends the window in the same
 * transaction, and billing_starts_at becomes this month. (The pay-link and
 * booking-site doors are pinned in routes/posPayLinks.test.ts and
 * routes/propertyBookingFlow.test.ts; the backstop in the monthly run and the
 * nightly top-up in jobs/platformFeeTopUp.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PoolClient } from 'pg'

vi.mock('./paymentReceipt', () => ({ sendPaymentReceipt: vi.fn(async () => null) }))

import { afterRowsSettled } from './settleHooks'
import { insertPosSale } from './posSale'
import { settleManualRentPayment } from './manualPaymentSettle'
import { activateBillingForMoneyMoved, activateBillingForMoneyMovedIn } from './billingActivation'
import {
  cleanupAllSchema, withRollback, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

interface Company { landlordId: string; userId: string; propertyId: string; unitId: string; tenantId: string; leaseId: string }

async function company(c: PoolClient): Promise<Company> {
  const { userId, landlordId } = await seedLandlord(c)
  const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
  const unitId = await seedUnit(c, { propertyId, landlordId })
  const tenantId = await seedTenant(c)
  const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
  await seedLeaseTenant(c, { leaseId, tenantId })
  // Still onboarding: no money has moved yet.
  await c.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [landlordId])
  return { landlordId, userId, propertyId, unitId, tenantId, leaseId }
}

let seq = 0
async function charge(c: PoolClient, f: Company, o: { type: string; entry: string; status?: string; reversalId?: string }) {
  const due = new Date(Date.UTC(2026, 9, 1) + (seq++) * 86_400_000).toISOString().slice(0, 10)
  return (await c.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, settled_at, reversal_id)
     VALUES ($1, $2, $3, $4, $5, 75, $6, $7, $8::date,
             CASE WHEN $6 = 'settled' THEN now() END, $9) RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, o.type, o.status ?? 'settled', o.entry, due, o.reversalId ?? null])).rows[0].id
}

/** billing_starts_at, and whether it is this month. */
async function started(c: PoolClient, landlordId: string): Promise<{ starts: string | null; thisMonth: boolean }> {
  return (await c.query(
    `SELECT to_char(billing_starts_at, 'YYYY-MM-DD') AS starts,
            COALESCE(billing_starts_at = date_trunc('month', now())::date, false) AS "thisMonth"
       FROM landlords WHERE id = $1`, [landlordId])).rows[0]
}

const sale = (f: Company, method: string, total = 18) => ({
  landlordId: f.landlordId, propertyId: f.propertyId, cashierId: f.userId, paymentMethod: method,
  subtotal: total, taxAmount: 0, surcharge: 0, total, items: [],
})

beforeAll(async () => { await cleanupAllSchema() })
afterAll(async () => { await cleanupAllSchema() })

describe('10/5 every door where money lands ends free onboarding', () => {
  it('a utility payment, and nothing else, ends it', async () => {
    await withRollback(async c => {
      const f = await company(c)
      const water = await charge(c, f, { type: 'utility', entry: 'UTILITY' })
      const out = await afterRowsSettled(c, [water], { attestationSource: 'stripe_attested', receipt: null })
      expect(out.billingActivated).toBe(1)
      expect(await started(c, f.landlordId)).toMatchObject({ thisMonth: true })
    })
  })

  it('a fee that is not rent (a late fee, an other fee, a deposit, a home payment) ends it', async () => {
    for (const [type, entry] of [['fee', 'OTHERFEE'], ['late_fee', 'LATEFEE'], ['deposit', 'DEPOSIT'], ['home_payment', 'HOMEPMT']]) {
      await withRollback(async c => {
        const f = await company(c)
        const row = await charge(c, f, { type, entry })
        const out = await afterRowsSettled(c, [row], { attestationSource: 'landlord_self_reported_with_evidence', receipt: null })
        expect(out.billingActivated, type).toBe(1)
        expect((await started(c, f.landlordId)).thisMonth, type).toBe(true)
      })
    }
  })

  it('cash rent recorded at the desk ends it', async () => {
    await withRollback(async c => {
      const f = await company(c)
      const rent = await charge(c, f, { type: 'rent', entry: 'RENT', status: 'pending' })
      const due = (await c.query<{ d: string }>(`SELECT due_date::text AS d FROM payments WHERE id = $1`, [rent])).rows[0].d
      await settleManualRentPayment(c, {
        payment: { id: rent, landlord_id: f.landlordId, tenant_id: f.tenantId, unit_id: f.unitId, lease_id: f.leaseId, due_date: due },
        method: 'cash', settledAt: null,
      })
      expect(await started(c, f.landlordId)).toMatchObject({ thisMonth: true })
    })
  })

  it('a register sale, cash or card, ends it; a store-account sale moves no money and does not', async () => {
    await withRollback(async c => {
      const f = await company(c)
      await insertPosSale(c, sale(f, 'charge'))
      expect((await started(c, f.landlordId)).starts).toBeNull()
      await insertPosSale(c, sale(f, 'cash'))
      expect(await started(c, f.landlordId)).toMatchObject({ thisMonth: true })
    })
    await withRollback(async c => {
      const f = await company(c)
      await insertPosSale(c, { ...sale(f, 'card'), stripePaymentIntentId: `pi_door_${Date.now()}` })
      expect(await started(c, f.landlordId)).toMatchObject({ thisMonth: true })
    })
  })

  it('a re-payment of a row a dispute reopened does not end it (the original settle did)', async () => {
    await withRollback(async c => {
      const f = await company(c)
      const original = await charge(c, f, { type: 'utility', entry: 'UTILITY', status: 'returned' })
      const reversal = (await c.query<{ id: string }>(
        `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
         VALUES ($1, 'ach_return', 75, 'evt_door', '{}'::jsonb) RETURNING id`, [original])).rows[0].id
      const repaid = await charge(c, f, { type: 'utility', entry: 'UTILITY', reversalId: reversal })
      const out = await afterRowsSettled(c, [repaid], { attestationSource: 'stripe_attested', receipt: null })
      expect(out.billingActivated).toBe(0)
      expect((await started(c, f.landlordId)).starts).toBeNull()
    })
  })

  it('a bill paid wholly with credit the landlord gave moves no money and does not end it', async () => {
    await withRollback(async c => {
      const f = await company(c)
      const rent = await charge(c, f, { type: 'rent', entry: 'RENT' })
      await c.query(`UPDATE payments SET issued_credit_amount = amount WHERE id = $1`, [rent])
      const out = await afterRowsSettled(c, [rent], { attestationSource: 'gam_workflow_auto', receipt: null })
      expect(out.billingActivated).toBe(0)
      expect((await started(c, f.landlordId)).starts).toBeNull()
    })
  })

  it('is idempotent: a company already billing keeps the month it started', async () => {
    await withRollback(async c => {
      const f = await company(c)
      await c.query(`UPDATE landlords SET billing_starts_at = '2026-08-01' WHERE id = $1`, [f.landlordId])
      expect(await activateBillingForMoneyMoved(c, [f.landlordId, f.landlordId, null])).toBe(0)
      await insertPosSale(c, sale(f, 'cash'))
      const water = await charge(c, f, { type: 'utility', entry: 'UTILITY' })
      expect((await afterRowsSettled(c, [water], { attestationSource: 'stripe_attested', receipt: null })).billingActivated).toBe(0)
      expect((await started(c, f.landlordId)).starts).toBe('2026-08-01')
    })
  })
})

/** This month and next, as the backstop takes them. */
async function thisMonth(c: PoolClient): Promise<{ from: string; to: string }> {
  return (await c.query(
    `SELECT to_char(date_trunc('month', now()), 'YYYY-MM-DD') AS "from",
            to_char(date_trunc('month', now()) + INTERVAL '1 month', 'YYYY-MM-DD') AS "to"`)).rows[0]
}

async function booking(c: PoolClient, f: Company): Promise<string> {
  return (await c.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status)
     VALUES ($1, $2, 'nightly', current_date, current_date + 3, 'confirmed') RETURNING id`,
    [f.unitId, f.landlordId])).rows[0].id
}

/** A pay link for a stay's background check alone (createScreeningFeeLink's shape). */
async function feeOnlyLink(c: PoolClient, f: Company, bookingId: string): Promise<string> {
  return (await c.query<{ id: string }>(
    `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email)
     VALUES ($1, $2, $3, $4, 'one_time', 'Background check', $5::jsonb, 35, 35, 'guest@example.com') RETURNING id`,
    [`tok_${bookingId}`, f.landlordId, f.propertyId, f.userId,
     JSON.stringify([{ name: 'Background check', qty: 1, price: 35, screening: true, bookingId }])])).rows[0].id
}

describe('10/5 (review) what is not the company\'s money does not end free onboarding', () => {
  it('a pay link for a background check alone is GAM\'s screening money — the sale door does not end it', async () => {
    await withRollback(async c => {
      const f = await company(c)
      await insertPosSale(c, { ...sale(f, 'card', 36.78), stripePaymentIntentId: `pi_check_${Date.now()}`, screeningOnly: true })
      expect((await started(c, f.landlordId)).starts).toBeNull()
    })
  })

  it('the backstop skips a fee-only link\'s sale and held payment, and a voided sale toward a stay; it counts a booking-site deposit', async () => {
    await withRollback(async c => {
      const f = await company(c)
      const { from, to } = await thisMonth(c)
      const b = await booking(c, f)
      const link = await feeOnlyLink(c, f, b)
      // The check paid on its link, and paid twice (held).
      await c.query(
        `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, pay_link_id, stripe_payment_intent_id, paid_online)
         VALUES ($1, $2, 'card', 35, 36.78, $3, 'pi_fee_only', true)`, [f.landlordId, f.userId, link])
      await c.query(
        `INSERT INTO pos_held_payments (landlord_id, property_id, pay_link_id, stripe_payment_intent_id, reason, amount)
         VALUES ($1, $2, $3, 'pi_fee_only_twice', 'paid_twice', 36.78)`, [f.landlordId, f.propertyId, link])
      // A cash register sale toward the stay, voided: its stay_payments row stays.
      const voided = (await c.query<{ id: string }>(
        `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, status)
         VALUES ($1, $2, 'cash', 120, 120, 'voided') RETURNING id`, [f.landlordId, f.userId])).rows[0].id
      await c.query(
        `INSERT INTO stay_payments (booking_id, landlord_id, kind, pos_transaction_id, method, toward_stay)
         VALUES ($1, $2, 'pos_sale', $3, 'cash', 120)`, [b, f.landlordId, voided])
      expect(await activateBillingForMoneyMovedIn(c, from, to)).toBe(0)
      expect((await started(c, f.landlordId)).starts).toBeNull()
      // A booking-site deposit is money toward the stay: it ends the window.
      await c.query(
        `INSERT INTO stay_payments (booking_id, landlord_id, kind, stripe_payment_intent_id, method, toward_stay)
         VALUES ($1, $2, 'site_deposit', 'pi_site_dep', 'card', 50)`, [b, f.landlordId])
      expect(await activateBillingForMoneyMovedIn(c, from, to)).toBe(1)
      expect(await started(c, f.landlordId)).toMatchObject({ thisMonth: true })
    })
  })
})
