/**
 * 10/12 (Nic) — the admin Metrics page and the Recurring Revenue card.
 *
 * Metrics: "total rents that we've ever processed electronically through card
 * or ACH ... how much money we have logged for rent collected through the
 * platform all time, whether that's paid in cash or check in person."
 *
 * Recurring: "our recurring revenue is showing $166 ... is there only 12 units
 * there? ... as we bill for that month ... I want to see what we billed."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'
import { clearPlatformMetricsCache } from '../services/platformMetrics'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

const sign = (id: string, role: string) => jwt.sign(
  { userId: id, role, email: 'x@test.dev', profileId: id, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' },
)

async function staffToken(role: 'admin' | 'super_admin'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', $2, 'A', 'D', TRUE) RETURNING id`, [`${role}-${randomUUID()}@test.dev`, role])
  return sign(r.rows[0].id, role)
}

beforeEach(async () => {
  await cleanupAllSchema()
  clearPlatformMetricsCache()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_metrics'
})

/** One landlord's park: units, two households, and rent paid six different ways. */
async function seedPark(opts: { demo?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    if (opts.demo) await c.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [landlordId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const u1 = await seedUnit(c, { propertyId, landlordId })
    const u2 = await seedUnit(c, { propertyId, landlordId })
    const u3 = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET retired_at = NOW() WHERE id = $1`, [u3])
    const t1 = await seedTenant(c)
    const t2 = await seedTenant(c)
    const l1 = await seedLease(c, { unitId: u1, landlordId, rentAmount: 1000 })
    const l2 = await seedLease(c, { unitId: u2, landlordId, rentAmount: 800 })
    await seedLeaseTenant(c, { leaseId: l1, tenantId: t1 })
    await seedLeaseTenant(c, { leaseId: l2, tenantId: t2 })

    // A bill, and a payment applied to it. Each rent bill on a lease has its own
    // due date (one rent charge per lease per due date — ux_payments_rent_idempotent).
    let bill = 0
    const pay = async (o: { unitId: string; tenantId: string; leaseId: string; type: string; amount: number
                            method: string; status?: string }) => {
      const p = await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, 'settled', $7, CURRENT_DATE - $8::int) RETURNING id`,
        [o.unitId, o.tenantId, landlordId, o.leaseId, o.type, o.amount, o.type === 'rent' ? 'RENT' : 'UTILITY', bill++])
      const electronic = o.method === 'card' || o.method === 'ach'
      const r = await c.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, status,
                                         payment_method, stripe_payment_intent_id, settled_at)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, NOW()) RETURNING id`,
        [o.tenantId, landlordId, o.leaseId, o.amount, o.status ?? 'settled', o.method,
         electronic ? `pi_${randomUUID()}` : null])
      await c.query(
        `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`,
        [r.rows[0].id, p.rows[0].id, o.amount])
    }
    const a = { unitId: u1, tenantId: t1, leaseId: l1 }
    const b = { unitId: u2, tenantId: t2, leaseId: l2 }
    await pay({ ...a, type: 'rent', amount: 1000, method: 'card' })
    await pay({ ...b, type: 'rent', amount: 800, method: 'ach' })
    await pay({ ...a, type: 'rent', amount: 500, method: 'cash' })
    await pay({ ...b, type: 'rent', amount: 300, method: 'check' })
    await pay({ ...a, type: 'rent', amount: 200, method: 'money_order' })
    await pay({ ...b, type: 'rent', amount: 150, method: 'bank_deposit' })
    // Not rent: in "money paid in", not in either rent figure.
    await pay({ ...a, type: 'utility', amount: 75, method: 'card' })
    // Never settled: in nothing.
    await pay({ ...b, type: 'rent', amount: 999, method: 'card', status: 'failed' })

    // Payouts: one sent, one still waiting.
    await c.query(
      `INSERT INTO platform_transfer_intents (landlord_id, landlord_user_id, destination_connect_account_id,
                                              amount, gross_owed, status, transferred_at)
       VALUES ($1, $2, 'acct_x', 1500, 1500, 'transferred', NOW()),
              ($1, $2, 'acct_x', 700, 700, 'pending', NULL)`, [landlordId, userId])

    // Register: a cash sale counts; a voided card sale and a store-account sale do not.
    await c.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, status, void_reason)
       VALUES ($1, $2, 'cash', 50, 50, 'completed', NULL),
              ($1, $2, 'card', 40, 41.95, 'voided', 'test'),
              ($1, $2, 'charge', 30, 30, 'completed', NULL)`, [landlordId, userId])
    await c.query('COMMIT')
    return { landlordId, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('GET /api/admin/metrics', () => {
  it('is super admin only: an admin, a landlord and no sign-in are all refused', async () => {
    const admin = await staffToken('admin')
    const ll = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'landlord', 'L', 'L', TRUE) RETURNING id`, [`ll-${randomUUID()}@test.dev`])
    expect((await request(buildApp()).get('/api/admin/metrics').set('Authorization', `Bearer ${admin}`)).status).toBe(403)
    expect((await request(buildApp()).get('/api/admin/metrics')
      .set('Authorization', `Bearer ${sign(ll.rows[0].id, 'landlord')}`)).status).toBe(403)
    expect((await request(buildApp()).get('/api/admin/metrics')).status).toBe(401)
    const ok = await request(buildApp()).get('/api/admin/metrics')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    expect(ok.status).toBe(200)
  })

  it('electronic rent is card + bank only; logged rent adds cash, check, money order and bank deposit', async () => {
    await seedPark()
    const res = await request(buildApp()).get('/api/admin/metrics')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    expect(res.status).toBe(200)
    const m = res.body.data

    expect(m.rent.electronic.card).toBeCloseTo(1000, 2)
    expect(m.rent.electronic.ach).toBeCloseTo(800, 2)
    expect(m.rent.electronic.total).toBeCloseTo(1800, 2)
    expect(m.rent.electronic.payments).toBe(2)

    // 1000 + 800 + 500 + 300 + 200 + 150; the utility bill and the failed payment are not rent logged.
    expect(m.rent.logged.total).toBeCloseTo(2950, 2)
    expect(m.rent.logged.byHand).toBeCloseTo(1150, 2)
    expect(m.rent.logged.payments).toBe(6)
    const by = Object.fromEntries(m.rent.logged.byMethod.map((x: any) => [x.method, x]))
    expect(by.cash.amount).toBeCloseTo(500, 2)
    expect(by.check.amount).toBeCloseTo(300, 2)
    expect(by.money_order.amount).toBeCloseTo(200, 2)
    expect(by.bank_deposit.amount).toBeCloseTo(150, 2)
    expect(by.cash.electronic).toBe(false)
    expect(by.card.electronic).toBe(true)
    // Plain labels, never the stored value.
    expect(m.rent.logged.byMethod.map((x: any) => x.label).sort())
      .toEqual(['Bank (ACH)', 'Bank deposit', 'Card', 'Cash', 'Check', 'Money order'])
    // The month-by-month bars add to the same total.
    const months = m.rent.byMonth.reduce((s: number, x: any) => s + x.electronic + x.byHand, 0)
    expect(months).toBeCloseTo(2950, 2)
  })

  it('money paid in, payouts and the platform counts match the fixture, once each', async () => {
    await seedPark()
    const res = await request(buildApp()).get('/api/admin/metrics')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    const m = res.body.data
    expect(m.moneyIn.tenantPayments.amount).toBeCloseTo(3025, 2)        // 2950 rent + 75 utility
    expect(m.moneyIn.tenantPayments.electronic).toBeCloseTo(1875, 2)    // card 1000 + ach 800 + card 75
    expect(m.moneyIn.tenantPayments.byHand).toBeCloseTo(1150, 2)
    expect(m.moneyIn.tenantPayments.count).toBe(7)
    expect(m.moneyIn.registerSales.amount).toBeCloseTo(50, 2)
    expect(m.moneyIn.registerSales.count).toBe(1)
    expect(m.moneyIn.total).toBeCloseTo(3075, 2)
    expect(m.payouts.amount).toBeCloseTo(1500, 2)
    expect(m.payouts.count).toBe(1)
    expect(m.payments.biggest).toBeCloseTo(1000, 2)

    expect(m.footprint.landlords).toBe(1)
    expect(m.footprint.properties).toBe(1)
    expect(m.footprint.units).toBe(2)                 // the retired space is gone
    expect(m.footprint.households).toBe(2)
    expect(m.footprint.residents).toBe(2)
    expect(m.footprint.rentRollMonthly).toBeCloseTo(1800, 2)
  })

  it('leaves demo landlords out of every number', async () => {
    await seedPark({ demo: true })
    const res = await request(buildApp()).get('/api/admin/metrics')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    const m = res.body.data
    expect(m.rent.logged.total).toBe(0)
    expect(m.rent.electronic.total).toBe(0)
    expect(m.moneyIn.total).toBe(0)
    expect(m.payouts.amount).toBe(0)
    expect(m.footprint.properties).toBe(0)
    expect(m.footprint.units).toBe(0)
    expect(m.footprint.households).toBe(0)
  })
})

describe('Recurring Revenue card: the platform-fee bill, from the book', () => {
  async function billFixture() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const one = await seedLandlord(c)
      const two = await seedLandlord(c)
      // Landlord one has a payout bank linked; landlord two (Country Acres' position on 10/12) does not.
      await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`, [one.landlordId, `acct_${randomUUID()}`])
      const p1 = await seedProperty(c, { landlordId: one.landlordId, ownerUserId: one.userId, managedByUserId: one.userId })
      const p2 = await seedProperty(c, { landlordId: two.landlordId, ownerUserId: two.userId, managedByUserId: two.userId })
      const accrual = async (landlordId: string, propertyId: string, monthsBack: number, spaces: number, amount: number) =>
        (await c.query<{ id: string }>(
          `INSERT INTO platform_fee_accruals (landlord_id, property_id, accrual_month, long_term_unit_count,
                                              total_billable, rate_per_unit, min_per_connect_account, total_amount, payer)
           VALUES ($1, $2, (date_trunc('month', CURRENT_DATE) - ($3 || ' months')::interval)::date, $4, $4, 2, 10, $5, 'landlord')
           RETURNING id`, [landlordId, propertyId, monthsBack, spaces, amount])).rows[0].id
      const a1 = await accrual(one.landlordId, p1, 0, 25, 50)   // 24 on the 1st, one more topped up
      const a2 = await accrual(two.landlordId, p2, 0, 12, 24)
      const a0 = await accrual(one.landlordId, p1, 1, 20, 40)   // LAST month's bill …
      const topRef = randomUUID()
      const line = (amount: number, refId: string, refType: string, propertyId: string | null) => c.query(
        `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, property_id, notes)
         VALUES ('platform_fee_subscription', $1, $1, $2, $3, $4, 'test')`, [amount, refId, refType, propertyId])
      await line(48, a1, 'platform_fee_accrual', p1)
      await line(2, topRef, 'platform_fee_topup', p1)
      await line(24, a2, 'platform_fee_accrual', p2)
      await line(40, a0, 'platform_fee_accrual', p1)              // … written today, like September's on 9/19
      await line(35, one.landlordId, 'screening_fee_sweep', null) // background checks, not the subscription
      const charge = (landlordId: string, propertyId: string, kind: string, amount: number, collected: number,
                      sourceType: string, sourceId: string) => c.query(
        `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, collected_amount, source_type, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [landlordId, propertyId, kind, amount, collected, sourceType, sourceId])
      await charge(one.landlordId, p1, 'subscription', 48, 48, 'platform_fee_accrual', a1)
      await charge(one.landlordId, p1, 'subscription', 2, 2, 'platform_fee_topup', topRef)
      await charge(two.landlordId, p2, 'subscription', 24, 0, 'platform_fee_accrual', a2)
      await charge(one.landlordId, p1, 'subscription', 40, 0, 'platform_fee_accrual', a0)
      // Owed, but not a platform fee: never part of the recurring bill.
      await charge(one.landlordId, p1, 'device_installment', 87.5, 0, 'reader_order_test', randomUUID())
      await c.query('COMMIT')
      return { p1, p2 }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('is this month\'s bill as billed: top-ups in, a late-written past bill and the screening sweep out', async () => {
    const { p1, p2 } = await billFixture()
    const token = await staffToken('super_admin')
    const res = await request(buildApp()).get('/api/admin/income/composition/all').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    const [{ month }] = (await db.query<{ month: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM') AS month`)).rows
    expect(d.recurringMonth).toBe(month)
    expect(d.recurringMonthly).toBeCloseTo(74, 2)        // 48 + 2 + 24
    expect(d.recurringAnnual).toBeCloseTo(888, 2)
    expect(d.recurringSpaces).toBe(37)                   // 25 + 12
    expect(d.recurringNotCollected).toBeCloseTo(24, 2)   // landlord two's open fee only
    const by = Object.fromEntries(d.recurringByProperty.map((p: any) => [p.propertyId, p]))
    expect(by[p1]).toMatchObject({ spaces: 25, billed: 50, notCollected: 0, payoutBankLinked: true })
    expect(by[p2]).toMatchObject({ spaces: 12, billed: 24, notCollected: 24, payoutBankLinked: false })

    // The pies still file money by the day it was booked; the sweep lands under Background Checks.
    const comp = await request(buildApp()).get('/api/admin/income/composition?window=month').set('Authorization', `Bearer ${token}`)
    const slice = Object.fromEntries(comp.body.data.sources.map((s: any) => [s.key, s.amount]))
    expect(slice.platform_unit).toBeCloseTo(114, 2)      // 48 + 2 + 24 + 40
    expect(slice.background_checks).toBeCloseTo(35, 2)
  })

  it('names last month\'s bill until this month\'s is raised', async () => {
    const c = await db.connect()
    let propertyId = ''
    try {
      await c.query('BEGIN')
      const one = await seedLandlord(c)
      propertyId = await seedProperty(c, { landlordId: one.landlordId, ownerUserId: one.userId, managedByUserId: one.userId })
      const a = (await c.query<{ id: string }>(
        `INSERT INTO platform_fee_accruals (landlord_id, property_id, accrual_month, long_term_unit_count,
                                            total_billable, rate_per_unit, min_per_connect_account, total_amount, payer)
         VALUES ($1, $2, (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date, 65, 65, 2, 10, 130, 'landlord')
         RETURNING id`, [one.landlordId, propertyId])).rows[0].id
      await c.query(
        `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, property_id, notes, created_at)
         VALUES ('platform_fee_subscription', 130, 130, $1, 'platform_fee_accrual', $2, 'test', NOW() - INTERVAL '1 month')`,
        [a, propertyId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await request(buildApp()).get('/api/admin/income/composition/all')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    const [{ month }] = (await db.query<{ month: string }>(
      `SELECT to_char(CURRENT_DATE - INTERVAL '1 month', 'YYYY-MM') AS month`)).rows
    expect(res.body.data.recurringMonth).toBe(month)
    expect(res.body.data.recurringMonthly).toBeCloseTo(130, 2)
    expect(res.body.data.recurringSpaces).toBe(65)
    expect(res.body.data.recurringByProperty).toHaveLength(1)
    expect(res.body.data.recurringByProperty[0].propertyId).toBe(propertyId)
  })

  // 10/12 (Nic, A4): the card opens onto this list; a charge GAM took back is
  // voided and kept (ledger P0), and nobody owes it.
  it('a platform-fee charge GAM voided is not "not collected yet"', async () => {
    const { p2 } = await billFixture()
    await db.query(
      `UPDATE landlord_gam_charges SET voided_at = NOW(), void_reason = 'bank_debit_not_made'
        WHERE property_id = $1 AND kind = 'subscription'`, [p2])
    const res = await request(buildApp()).get('/api/admin/income/composition/all')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    const by = Object.fromEntries(res.body.data.recurringByProperty.map((p: any) => [p.propertyId, p]))
    expect(by[p2]).toMatchObject({ spaces: 12, billed: 24, notCollected: 0 })
    expect(res.body.data.recurringNotCollected).toBe(0)
  })
})

// ─── 10/12 (Nic) review fixes ───────────────────────────────────────────────

/** One landlord, one space, one household on a $460 lease, and ways to bill and pay it. */
async function household() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 460 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Household = Awaited<ReturnType<typeof household>>

/** A rent bill due `daysAgo` days back. */
async function rentBill(w: Household, o: { amount: number; daysAgo: number; status?: string; reversalId?: string }) {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, reversal_id, settled_at)
     VALUES ($1,$2,$3,$4,'rent',$5,$6,'RENT',CURRENT_DATE - $7::int,$8,CASE WHEN $6 = 'settled' THEN NOW() END)
     RETURNING id`,
    [w.unitId, w.leaseId, w.tenantId, w.landlordId, o.amount, o.status ?? 'settled', o.daysAgo, o.reversalId ?? null],
  )).rows[0].id
}

/** A settled tenant payment of `amount`, applying `applied` to `paymentId` and keeping the rest unapplied. */
async function tenantPayment(w: Household, o: { amount: number; method: string; paymentId?: string; applied?: number }) {
  const applied = o.paymentId ? (o.applied ?? o.amount) : 0
  const electronic = o.method === 'card' || o.method === 'ach'
  const r = (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, unapplied_amount, status,
                                     payment_method, stripe_payment_intent_id, settled_at)
     VALUES ($1,$2,$3,$4,$5,$6,'settled',$7,$8,NOW()) RETURNING id`,
    [w.tenantId, w.landlordId, w.leaseId, o.amount, applied, o.amount - applied, o.method,
     electronic ? `pi_${randomUUID()}` : null])).rows[0].id
  if (o.paymentId) {
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`,
      [r, o.paymentId, applied])
  }
  return r
}

/** Paid-ahead credit, and a spend of it on an open rent bill (the ledger trigger checks the bill is open). */
async function paidAhead(w: Household, o: { amount: number; fundedBy: string; sourceRemittanceId?: string; sourcePaymentId?: string }) {
  return (await db.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by,
                                        source_remittance_id, source_payment_id, received_at)
     VALUES ($1,$2,$3,$3,$4,$5,$6,NOW()) RETURNING id`,
    [w.leaseId, w.tenantId, o.amount, o.fundedBy, o.sourceRemittanceId ?? null, o.sourcePaymentId ?? null])).rows[0].id
}
async function spend(w: Household, creditId: string, paymentId: string, amount: number) {
  await db.query(
    `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
     VALUES ($1,$2,$3,$4,date_trunc('month', CURRENT_DATE)::date,'whole_bill','applied',NOW(),NOW())`,
    [creditId, paymentId, w.leaseId, amount])
  await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [paymentId])
}

async function metrics() {
  clearPlatformMetricsCache()
  const res = await request(buildApp()).get('/api/admin/metrics')
    .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
  expect(res.status).toBe(200)
  return res.body.data
}

describe('10/12 review: every rent dollar counted once', () => {
  it('a disputed card rent payment and its re-payment count the rent once', async () => {
    const w = await household()
    const original = await rentBill(w, { amount: 460, daysAgo: 20 })
    await tenantPayment(w, { amount: 460, method: 'card', paymentId: original })
    // The card is disputed: the bill goes 'returned', and the tenant is billed again for it
    // on the same due date (services/paymentReversal). The original payment stays settled.
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event)
       VALUES ($1,$2,$3,$4,'card_dispute',460,$5,'{}') RETURNING id`,
      [original, w.landlordId, w.tenantId, w.leaseId, `evt_${randomUUID()}`])).rows[0].id
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [original])
    const reopened = await rentBill(w, { amount: 460, daysAgo: 20, reversalId: rev })
    await tenantPayment(w, { amount: 460, method: 'cash', paymentId: reopened })

    const m = await metrics()
    expect(m.rent.logged.total).toBeCloseTo(460, 2)       // not 920
    expect(m.rent.electronic.card).toBeCloseTo(0, 2)      // the card money went back
    expect(m.rent.electronic.total).toBeCloseTo(0, 2)
    const by = Object.fromEntries(m.rent.logged.byMethod.map((x: any) => [x.method, x.amount]))
    expect(by.cash).toBeCloseTo(460, 2)
    const months = m.rent.byMonth.reduce((s: number, x: any) => s + x.electronic + x.byHand, 0)
    expect(months).toBeCloseTo(460, 2)
    // Money paid in: 460 by card, taken back, then 460 in cash.
    expect(m.moneyIn.tenantPayments.amount).toBeCloseTo(460, 2)
    expect(m.moneyIn.tenantPayments.electronic).toBeCloseTo(0, 2)
    expect(m.moneyIn.tenantPayments.byHand).toBeCloseTo(460, 2)
  })

  it('rent paid from a check overpayment counts, in the check, once; a carry-forward and reclassified rent do not', async () => {
    const w = await household()
    // Todd's case: a $920 check, $460 to September's rent, $460 kept as paid-ahead money.
    const sep = await rentBill(w, { amount: 460, daysAgo: 40 })
    const check = await tenantPayment(w, { amount: 920, method: 'check', paymentId: sep, applied: 460 })
    const ahead = await paidAhead(w, { amount: 460, fundedBy: 'landlord', sourceRemittanceId: check })
    const oct = await rentBill(w, { amount: 460, daysAgo: 10, status: 'pending' })
    await spend(w, ahead, oct, 460)
    // Neither of these is money that came in through GAM again.
    const carried = await paidAhead(w, { amount: 50, fundedBy: 'landlord' })                         // typed in
    const reclassified = await paidAhead(w, { amount: 40, fundedBy: 'reclassified', sourcePaymentId: sep })
    const nov = await rentBill(w, { amount: 90, daysAgo: 1, status: 'pending' })
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
       VALUES ($1,$3,$4,50,date_trunc('month', CURRENT_DATE)::date,'whole_bill','applied',NOW(),NOW()),
              ($2,$3,$4,40,date_trunc('month', CURRENT_DATE)::date,'whole_bill','applied',NOW(),NOW())`,
      [carried, reclassified, nov, w.leaseId])

    const m = await metrics()
    expect(m.rent.logged.total).toBeCloseTo(920, 2)
    const by = Object.fromEntries(m.rent.logged.byMethod.map((x: any) => [x.method, x]))
    expect(by.check.amount).toBeCloseTo(920, 2)
    expect(by.check.payments).toBe(1)                     // one check, however many bills it paid
    expect(m.rent.logged.payments).toBe(1)
    const months = m.rent.byMonth.reduce((s: number, x: any) => s + x.electronic + x.byHand, 0)
    expect(months).toBeCloseTo(920, 2)
    // The check is money paid in once, whole.
    expect(m.moneyIn.tenantPayments.amount).toBeCloseTo(920, 2)
  })

  it('rent refunded at an early check-out comes off rent and money paid in', async () => {
    const w = await household()
    const bill = await rentBill(w, { amount: 460, daysAgo: 5 })
    const cash = await tenantPayment(w, { amount: 460, method: 'cash', paymentId: bill })
    const booking = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status)
       VALUES ($1,$2,CURRENT_DATE - 5,CURRENT_DATE + 25,'month_to_month','checked_out') RETURNING id`,
      [w.unitId, w.landlordId])).rows[0].id
    const decision = (await db.query<{ id: string }>(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, lease_id, left_on, question, status, choice, decided_at,
                                            booked_price, stayed_worth, paid, refund_total)
       VALUES ($1,$2,$3,CURRENT_DATE,'overpaid','decided','refund_unused',NOW(),460,300,460,160) RETURNING id`,
      [booking, w.landlordId, w.leaseId])).rows[0].id
    await db.query(
      `INSERT INTO stay_refund_parts (decision_id, booking_id, landlord_id, seq, kind, remittance_id, toward_amount,
                                      amount, label, status, refunded_at)
       VALUES ($1,$2,$3,1,'cash',$4,160,160,'Cash · rent','handed_back',NOW())`,
      [decision, booking, w.landlordId, cash])

    const m = await metrics()
    expect(m.rent.logged.total).toBeCloseTo(300, 2)
    expect(m.moneyIn.tenantPayments.amount).toBeCloseTo(300, 2)
  })
})

describe('10/12 review: the footprint and the background checks', () => {
  it('"On GAM today" leaves out a signup with no tenants', async () => {
    await seedPark()
    // A signup that added a property in another state and never added a tenant.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET city = 'Hendersonville', state = 'NC' WHERE id = $1`, [propertyId])
      await seedUnit(c, { propertyId, landlordId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const m = await metrics()
    expect(m.footprint.landlords).toBe(1)
    expect(m.footprint.properties).toBe(1)
    expect(m.footprint.states).toBe(1)
    expect(m.footprint.cities).toBe(1)
    expect(m.footprint.units).toBe(2)
  })

  it('background checks paid online leave out the card fee on top', async () => {
    const w = await household()
    const check = async (bookedFee: number | null) => {
      const id = (await db.query<{ id: string }>(
        `INSERT INTO background_checks (landlord_id, user_id, status, amount_charged, applicant_payment_intent_id)
         VALUES ($1,$2,'complete',44.99,$3) RETURNING id`, [w.landlordId, w.userId, `pi_${randomUUID()}`])).rows[0].id
      if (bookedFee != null) {
        await db.query(
          `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, customer_fee_charged, notes)
           VALUES ('banking_spread', 1, 1, $1, 'background_check', $2, 'test')`, [id, bookedFee])
      }
    }
    await check(2.05)     // the fee GAM booked
    await check(null)     // none booked: worked back out of the $44.99 (3.5% + $0.55 on what came before it)

    const m = await metrics()
    expect(m.moneyIn.backgroundChecks.count).toBe(2)
    expect(m.moneyIn.backgroundChecks.amount).toBeCloseTo(2 * (44.99 - 2.05), 2)
  })
})

describe('10/12 review: the polled recurring read and what landlords owe', () => {
  it('composition/all leaves the forward run-rate out unless asked for it', async () => {
    const token = await staffToken('super_admin')
    const plain = await request(buildApp()).get('/api/admin/income/composition/all').set('Authorization', `Bearer ${token}`)
    expect(plain.status).toBe(200)
    expect(plain.body.data).not.toHaveProperty('platformRunRate')
    expect(plain.body.data.periods[0]).not.toHaveProperty('runRate')
    const asked = await request(buildApp()).get('/api/admin/income/composition/all?withRunRate=1')
      .set('Authorization', `Bearer ${token}`)
    expect(asked.body.data).toHaveProperty('platformRunRate')
    expect(asked.body.data.periods[0]).toHaveProperty('runRate')
  })

  it('names what landlords still owe GAM kind by kind', async () => {
    const w = await household()
    await db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, collected_amount, source_type, source_id)
       VALUES ($1,$2,'subscription',24,0,'platform_fee_accrual',$3),
              ($1,$2,'device_installment',87.5,0,'reader_order_test',$4),
              ($1,$2,'subscription',48,48,'platform_fee_accrual',$5)`,
      [w.landlordId, w.propertyId, randomUUID(), randomUUID(), randomUUID()])
    const { loadPlatformBalanceBook } = await import('../services/stripeCosts')
    const book = await loadPlatformBalanceBook()
    expect(book.owedByLandlordsUncollected).toBeCloseTo(111.5, 2)
    expect(book.owedByLandlordsByKind).toEqual([
      { kind: 'device_installment', label: 'Card reader installment', amount: 87.5 },
      { kind: 'subscription', label: 'Platform fee', amount: 24 },
    ])
  })
})

// ─── 10/12 (Nic, A5 + H1): occupied spaces, counted the way GAM bills ────────

describe('10/12 (A5/H1): Active Units and the heat map count occupied spaces the way GAM bills them', () => {
  /**
   * One live park: a lease, an owner-occupied space, a month stay, a space
   * marked 'active' with nobody in it (Springville's case, S652), a site with
   * only a nightly stay, a lease that ended last month, and a retired space.
   * Plus a demo landlord's leased space and a signup that never went live.
   */
  async function park() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET state = 'AZ' WHERE id = $1`, [propertyId])
      const u: string[] = []
      for (let i = 0; i < 7; i++) u.push(await seedUnit(c, { propertyId, landlordId }))
      const [leased, ownerUse, monthStay, markedActive, nightly, endedLastMonth, retired] = u
      const t = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: await seedLease(c, { unitId: leased, landlordId, rentAmount: 500 }), tenantId: t })
      await c.query(`UPDATE units SET status = 'owner_use' WHERE id = $1`, [ownerUse])
      await c.query(`UPDATE units SET status = 'active' WHERE id = $1`, [markedActive])
      await c.query(
        `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, status, lease_type)
         VALUES ($1, $3, CURRENT_DATE - 5, CURRENT_DATE + 40, 'confirmed', 'month_to_month'),
                ($2, $3, CURRENT_DATE, CURRENT_DATE + 2, 'confirmed', 'nightly')`, [monthStay, nightly, landlordId])
      const ended = await seedLease(c, { unitId: endedLastMonth, landlordId, rentAmount: 400, status: 'expired' })
      await c.query(`UPDATE leases SET end_date = CURRENT_DATE - 45 WHERE id = $1`, [ended])
      await c.query(`UPDATE units SET retired_at = NOW() WHERE id = $1`, [retired])

      const demo = await seedLandlord(c)
      await c.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [demo.landlordId])
      const dp = await seedProperty(c, { landlordId: demo.landlordId, ownerUserId: demo.userId, managedByUserId: demo.userId })
      await seedLease(c, { unitId: await seedUnit(c, { propertyId: dp, landlordId: demo.landlordId }), landlordId: demo.landlordId })

      const junk = await seedLandlord(c)
      const jp = await seedProperty(c, { landlordId: junk.landlordId, ownerUserId: junk.userId, managedByUserId: junk.userId })
      for (let i = 0; i < 4; i++) await seedUnit(c, { propertyId: jp, landlordId: junk.landlordId })
      await c.query('COMMIT')
      return { propertyId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('Active Units = the lease, owner use and month stay; vacant = the rest of the open spaces', async () => {
    await park()
    const res = await request(buildApp()).get('/api/admin/overview')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.active_units).toBe(3)
    expect(d.total_spaces).toBe(6)     // the retired space is gone; the demo and the junk signup are not on GAM
    expect(d.vacant_units).toBe(3)     // marked 'active' with nobody in it, nightly only, ended last month
    expect(d.spaces_month).toMatch(/^\d{4}-\d{2}-01$/)
  })

  it('the Metrics tile and the heat map\'s occupied view read the same count, and add up', async () => {
    await park()
    const m = await metrics()
    expect(m.footprint).toMatchObject({ units: 6, occupiedSpaces: 3, vacantSpaces: 3 })
    expect(m.footprint.occupiedMonth).toMatch(/^\d{4}-\d{2}-01$/)
    expect(m.map.states).toEqual([expect.objectContaining({ abbr: 'AZ', units: 6, occupied: 3, properties: 1 })])
    // No map location on file: the county map names it, with its occupied spaces.
    expect(m.map.missing).toEqual([expect.objectContaining({ reason: 'no_location', units: 6, occupied: 3 })])
  })

  it('the Onboarding page\'s Vacant Units tile is the same count (10/12, A5 "match billing"), in a regular admin\'s portfolio', async () => {
    const { propertyId } = await park()
    const superToken = await staffToken('super_admin')
    const overview = (await request(buildApp()).get('/api/admin/overview').set('Authorization', `Bearer ${superToken}`)).body.data
    const onboarding = await request(buildApp()).get('/api/admin/onboarding/overview').set('Authorization', `Bearer ${superToken}`)
    expect(onboarding.status).toBe(200)
    expect(onboarding.body.data.vacant_units).toBe(overview.vacant_units)
    expect(onboarding.body.data.vacant_units).toBe(3)
    // A regular admin sees the count for the landlords they closed or service — none until assigned.
    const adminToken = await staffToken('admin')
    const adminId = (jwt.decode(adminToken) as any).userId
    expect((await request(buildApp()).get('/api/admin/onboarding/overview')
      .set('Authorization', `Bearer ${adminToken}`)).body.data.vacant_units).toBe(0)
    await db.query(
      `UPDATE landlords SET portfolio_manager_id = $1 WHERE id = (SELECT landlord_id FROM properties WHERE id = $2)`,
      [adminId, propertyId])
    expect((await request(buildApp()).get('/api/admin/onboarding/overview')
      .set('Authorization', `Bearer ${adminToken}`)).body.data.vacant_units).toBe(3)
  })

  it('a space leased at any point this month counts for the month — leaving never lowers it', async () => {
    const { propertyId } = await park()
    // The lease ends the day before today (still this month unless today is the 1st).
    await db.query(
      `UPDATE leases SET status = 'expired', end_date = GREATEST(CURRENT_DATE - 1, date_trunc('month', CURRENT_DATE)::date)
        WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1) AND status = 'active'`, [propertyId])
    const res = await request(buildApp()).get('/api/admin/overview')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    expect(res.body.data.active_units).toBe(3)
  })
})
