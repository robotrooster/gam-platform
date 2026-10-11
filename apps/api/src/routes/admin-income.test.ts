/**
 * admin.ts income + onboarding-detail slice — S369
 * (admin.ts slice 3 of N; bulletin moderation removed S567).
 *
 * Coverage focus:
 *   - Income projection: financial rollup with seeded
 *     active-unit + flex tenants — pin the math without testing
 *     every fee constant.
 *   - Onboarding landlord detail: checklist derivation
 *     (bank/property/unit/tenant/onboarding flags).
 *
 * Out of slice (next admin.ts session): NACHA monitoring, audit
 * log viewer, invoices backfill, email failures, OTP+FlexCharge
 * retry, deposit-portability, connect-readiness, onboarding
 * tenant detail (parallel to landlord detail but separate test).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedUserBankAccount, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_bul'
})

interface AFixture {
  landlordUserId: string
  landlordId:     string
  adminUserId:    string
  superAdminUserId: string
  adminToken:     string
  superAdminToken: string
}

async function seedAFixture(): Promise<AFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const adminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'D', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    const superAdminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'super_admin', 'S', 'U', TRUE) RETURNING id`,
      [`super-${randomUUID()}@test.dev`])
    await client.query('COMMIT')
    const sign = (id: string, role: string) => jwt.sign(
      { userId: id, role, email: 'x@test.dev', profileId: id, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return {
      landlordUserId, landlordId,
      adminUserId:      adminRes.rows[0].id,
      superAdminUserId: superAdminRes.rows[0].id,
      adminToken:       sign(adminRes.rows[0].id, 'admin'),
      superAdminToken:  sign(superAdminRes.rows[0].id, 'super_admin'),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('GET /api/admin/income/projection', () => {
  it('empty fixture: returns zero-everything shape with correct fee constants', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get('/api/admin/income/projection')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.monthly).toMatchObject({
      platform_unit_fees: 0, flex_pay_fees: 0, total: 0,
    })
    expect(d.annual).toBe(0)
    expect(d.counts).toMatchObject({
      active_units: 0, flex_pay: 0,
    })
  })

  it('seeded data: math pins direct-unit fees ($2/occupied unit, LAUNCH_PLATFORM_FEE)', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      const u1 = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      const u2 = await seedUnit(client, { propertyId, landlordId: f.landlordId })
      await client.query(`UPDATE units SET status='active' WHERE id IN ($1, $2)`, [u1, u2])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/admin/income/projection')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.counts.active_units).toBe(2)
    // S512+ launch pricing: $2/occupied unit, floored at the $10/property
    // minimum — 2 occupied units on one property = max(2×$2, $10) = $10.
    expect(res.body.data.monthly.platform_unit_fees).toBe(10)
    expect(res.body.data.annual).toBe(120)  // 10 × 12
  })
})

describe('GET /api/admin/onboarding/landlord/:id — detail + checklist', () => {
  it('happy path: checklist reflects state (bank=false initially)', async () => {
    const f = await seedAFixture()
    const res = await request(buildApp())
      .get(`/api/admin/onboarding/landlord/${f.landlordId}`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.landlord.id).toBe(f.landlordId)
    const checklist = Object.fromEntries(
      res.body.data.checklist.map((c: any) => [c.key, c.done]))
    expect(checklist.account_created).toBe(true)
    expect(checklist.bank_account_added).toBe(false)  // no bank seeded
    expect(checklist.property_added).toBe(false)
    expect(checklist.onboarding_complete).toBe(false)  // landlords default
  })

  it('checklist updates after seeding bank + property + unit', async () => {
    const f = await seedAFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await seedUserBankAccount(client, { userId: f.landlordUserId })
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      await seedUnit(client, { propertyId, landlordId: f.landlordId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get(`/api/admin/onboarding/landlord/${f.landlordId}`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    const checklist = Object.fromEntries(
      res.body.data.checklist.map((c: any) => [c.key, c.done]))
    expect(checklist.bank_account_added).toBe(true)
    expect(checklist.property_added).toBe(true)
    expect(checklist.unit_added).toBe(true)
    expect(checklist.tenant_invited).toBe(false)  // no active lease
    expect(res.body.data.counts.property_count).toBe(1)
    expect(res.body.data.counts.unit_count).toBe(1)
  })
})

/**
 * S652 — every number on the admin money page comes from one book.
 *
 * Nic, reading the page: "all the KPI cards are not linked up to each other...
 * the pie charts at the bottom are showing all-time money $172.72 versus the
 * KPI card up near the top that says GAM's own money... $218.87 all time, which
 * is about a $50 difference... just reconcile all the different KPI cards where
 * they're getting their numbers from the same source."
 *
 * He reproduced it to the cent. Three books were being added together: accruals
 * plus a live run-rate for platform fees, a COUNT of background checks times a
 * constant, and a ledger that also held adjustments nothing else knew about.
 */
describe('S652: the money page agrees with itself', () => {
  let superToken = ''
  beforeEach(async () => { superToken = (await seedAFixture()).superAdminToken })

  async function ledger(rows: Array<{ type: string; amount: number; monthsAgo?: number; referenceType?: string }>) {
    for (const r of rows) {
      await db.query(
        // balance_after is the running balance the real helper maintains; these
        // fixtures only care about `amount`, so it carries the same value.
        `INSERT INTO platform_revenue_ledger (type, amount, balance_after, notes, reference_type, created_at)
         VALUES ($1, $2, $2, 'test', $4, NOW() - ($3 || ' months')::interval)`,
        [r.type, r.amount, r.monthsAgo ?? 0, r.referenceType ?? null])
    }
  }

  it('the pie sums to exactly what the balance card calls all-time revenue', async () => {
    await ledger([
      { type: 'platform_fee_subscription', amount: 130 },
      { type: 'banking_spread',            amount: 47.72 },
      { type: 'screening_margin',          amount: 5 },
      { type: 'adjustment',                amount: -13.85 },
    ])
    const comp = await request(buildApp())
      .get('/api/admin/income/composition?window=all')
      .set('Authorization', `Bearer ${superToken}`)
    const [row] = await db.query<any>(`SELECT COALESCE(SUM(amount),0)::float AS amt FROM platform_revenue_ledger`)
      .then((r: any) => r.rows)
    expect(comp.status).toBe(200)
    expect(comp.body.data.gross).toBeCloseTo(Number(row.amt), 2)
  })

  it('shows adjustments, which used to exist in the ledger and in no pie', async () => {
    await ledger([
      { type: 'platform_fee_subscription', amount: 130 },
      { type: 'adjustment',                amount: -13.85 },
    ])
    const comp = await request(buildApp())
      .get('/api/admin/income/composition?window=all')
      .set('Authorization', `Bearer ${superToken}`)
    const adj = comp.body.data.sources.find((s: any) => s.key === 'adjustments')
    expect(adj.amount).toBeCloseTo(-13.85, 2)
    expect(comp.body.data.gross).toBeCloseTo(116.15, 2)
  })

  it('never folds a forward run-rate into a historical total', async () => {
    // The original defect: an "all time" figure that was part history and part
    // forecast, and whose forecast disagreed with the bill that went out.
    await ledger([{ type: 'platform_fee_subscription', amount: 130 }])
    const comp = await request(buildApp())
      .get('/api/admin/income/composition?window=all')
      .set('Authorization', `Bearer ${superToken}`)
    expect(comp.body.data.gross).toBeCloseTo(130, 2)
    expect(comp.body.data).toHaveProperty('runRate')   // returned, and kept apart
  })

  it('reports recurring revenue as the bill that actually went out', async () => {
    // Nic: "The recurring revenue is showing only $120 per month off of the
    // subscription fees." September billed $130.
    // S653 (Nic): "$171.75 when our price is $2 per unit" — the ACH spread
    // rode along. The card is the subscription bill; processing is not in it.
    await ledger([
      { type: 'platform_fee_subscription', amount: 10,  monthsAgo: 1 },
      { type: 'platform_fee_subscription', amount: 130, monthsAgo: 0 },
      { type: 'banking_spread',            amount: 41.75, monthsAgo: 0 },
    ])
    const all = await request(buildApp())
      .get('/api/admin/income/composition/all')
      .set('Authorization', `Bearer ${superToken}`)
    expect(all.body.data.recurringMonthly).toBeCloseTo(130, 2)
    expect(all.body.data.recurringAnnual).toBeCloseTo(1560, 2)
  })

  // S653 (Nic): "we are not spending any money" — the monthly true-up is
  // processing income and sits in the Processing slice, not under Adjustments.
  it('files the processing true-up under Processing, not Adjustments', async () => {
    await ledger([
      { type: 'banking_spread', amount: 41.75, monthsAgo: 0 },
      { type: 'adjustment',     amount: 31.95, monthsAgo: 0, referenceType: 'processing_margin_true_up' },
    ])
    const res = await request(buildApp())
      .get('/api/admin/income/composition?window=month')
      .set('Authorization', `Bearer ${superToken}`)
    const by = Object.fromEntries(res.body.data.sources.map((s: any) => [s.key, s.amount]))
    expect(by.processing).toBeCloseTo(73.70, 2)
    expect(by.adjustments ?? 0).toBe(0)
  })

  it('does not read an unbilled current month as a collapse in revenue', async () => {
    // On the 2nd, before the accrual runs, there is no current-month row yet.
    await ledger([{ type: 'platform_fee_subscription', amount: 130, monthsAgo: 1 }])
    const all = await request(buildApp())
      .get('/api/admin/income/composition/all')
      .set('Authorization', `Bearer ${superToken}`)
    expect(all.body.data.recurringMonthly).toBeCloseTo(130, 2)
  })

  it('a slice opens onto the rows that make it up', async () => {
    await ledger([
      { type: 'banking_spread', amount: 2.5 },
      { type: 'banking_spread', amount: 3.5 },
    ])
    const bd = await request(buildApp())
      .get('/api/admin/income/breakdown?window=all')
      .set('Authorization', `Bearer ${superToken}`)
    const proc = bd.body.data.sources.find((s: any) => s.key === 'processing')
    expect(proc.count).toBe(2)
    expect(proc.amount).toBeCloseTo(6, 2)
    expect(bd.body.data.gross).toBeCloseTo(6, 2)
  })
})

// ─── S655 money plan Step 4 ──────────────────────────────────────
describe('S655: admin money cards read the right facts', () => {
  async function tenantUnder(f: AFixture, flags: { flexpay?: boolean; otp?: boolean } = {}): Promise<string> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      await c.query(
        `UPDATE tenants SET flexpay_enrolled = $2, float_fee_active = $3 WHERE id = $1`,
        [tenantId, !!flags.flexpay, !!flags.otp])
      await c.query('COMMIT')
      return tenantId
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('manual and bank-match receipts never enter the moved-through-Stripe card', async () => {
    const f = await seedAFixture()
    const tenantId = await tenantUnder(f)
    const receipt = (o: { amount: number; gross: number | null; method: string; intent: string | null }) => db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       stripe_payment_intent_id, gross_amount, settled_at)
       VALUES ($1, $2, $3, $3, 'settled', $4, $5, $6, NOW())`,
      [tenantId, f.landlordId, o.amount, o.method, o.intent, o.gross])
    await receipt({ amount: 1000, gross: 1006, method: 'ach', intent: 'pi_through_stripe' })
    // A posted check the old manual post stamped with gross = amount (Glenda's $460).
    await receipt({ amount: 460, gross: 460, method: 'check', intent: null })
    // A matched bank deposit and a desk cash receipt.
    await receipt({ amount: 815, gross: 815, method: 'cash', intent: null })
    await receipt({ amount: 486, gross: null, method: 'money_order', intent: null })

    const res = await request(buildApp())
      .get('/api/admin/rent-volume-trend?months=1')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].gross).toBe(1006)
  })

  it('FlexPay counts and the projection read the FlexPay flag, not On-Time Pay\'s', async () => {
    const f = await seedAFixture()
    await tenantUnder(f, { flexpay: true })
    await tenantUnder(f, { flexpay: true })
    await tenantUnder(f, { otp: true })        // On-Time Pay only: not a FlexPay tenant

    const proj = await request(buildApp())
      .get('/api/admin/income/projection')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(proj.status).toBe(200)
    expect(proj.body.data.counts.flex_pay).toBe(2)
    expect(proj.body.data.monthly.flex_pay_fees).toBe(50)

    const overview = await request(buildApp())
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(overview.status).toBe(200)
    expect(JSON.stringify(overview.body.data)).toMatch(/"flexPay":2\b|"flex_pay":2\b/)
  })

  it('the tenants list and the onboarding checklist say FlexPay from the FlexPay flag', async () => {
    const f = await seedAFixture()
    const tenantId = await tenantUnder(f, { flexpay: true })
    const list = await request(buildApp())
      .get('/api/admin/tenants')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(list.status).toBe(200)
    const row = list.body.data.find((t: any) => t.id === tenantId)
    expect(row.flexpay_enrolled ?? row.flexpayEnrolled).toBe(true)

    const detail = await request(buildApp())
      .get(`/api/admin/onboarding/tenant/${tenantId}`)
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(detail.status).toBe(200)
    const checklist = Object.fromEntries(detail.body.data.checklist.map((c: any) => [c.key, c.done]))
    expect(checklist.flex_pay).toBe(true)
  })

  it('a FlexPay $25 taken back nets inside the FlexPay slice, never under Adjustments', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, notes, reference_type)
       VALUES ('flexpay_subscription', 25, 25, 'test', 'flexpay_advance'),
              ('flexpay_subscription', 25, 50, 'test', 'flexpay_advance'),
              ('adjustment', -25, 25, 'test', 'flexpay_advance_reversal')`)
    const comp = await request(buildApp())
      .get('/api/admin/income/composition?window=all')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    const by = Object.fromEntries(comp.body.data.sources.map((s: any) => [s.key, s.amount]))
    expect(by.flexpay).toBeCloseTo(25, 2)
    expect(by.adjustments ?? 0).toBe(0)
    expect(comp.body.data.gross).toBeCloseTo(25, 2)
    const rows = await request(buildApp())
      .get('/api/admin/income/breakdown?window=all')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    const flex = rows.body.data.sources.find((s: any) => s.key === 'flexpay')
    expect(flex.items.map((i: any) => i.amount).sort()).toEqual([-25, 25, 25])
  })

  it('FlexPay\'s $25 is its own slice of the money page and stays out of the recurring subscription card', async () => {
    const f = await seedAFixture()
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, notes)
       VALUES ('platform_fee_subscription', 130, 130, 'test'), ('flexpay_subscription', 25, 155, 'test')`)
    const comp = await request(buildApp())
      .get('/api/admin/income/composition?window=all')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    const by = Object.fromEntries(comp.body.data.sources.map((s: any) => [s.key, s.amount]))
    expect(by.flexpay).toBeCloseTo(25, 2)
    expect(by.other ?? 0).toBe(0)
    expect(comp.body.data.gross).toBeCloseTo(155, 2)
    const all = await request(buildApp())
      .get('/api/admin/income/composition/all')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(all.body.data.recurringMonthly).toBeCloseTo(130, 2)
  })
})

// S578 + S655 Step 4 fix round: the FlexPay request queue's "returner" flag
// reads the service's one definition of a counted write-off — any advance
// written off for life, recovered since or not, but never one GAM could not
// even create the pull for (no customer, no verified bank).
describe('admin FlexPay queue — who is a returner', () => {
  it('a pull GAM could not create never marks a returner; a write-off recovered since still does', async () => {
    const f = await seedAFixture()
    await db.query(`DELETE FROM flexpay_inquiries`)
    await db.query(`DELETE FROM flexpay_advances`)
    const seedApplicant = async (advance: { status: string; reason: string } | null) => {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const propertyId = await seedProperty(client, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
        const unitId = await seedUnit(client, { propertyId, landlordId: f.landlordId })
        const tenantId = await seedTenant(client)
        const leaseId = await seedLease(client, { unitId, landlordId: f.landlordId, rentAmount: 440 })
        await seedLeaseTenant(client, { leaseId, tenantId })
        await client.query(
          `INSERT INTO flexpay_inquiries (tenant_id, status, claimed_income_source) VALUES ($1, 'pending', 'ssi')`, [tenantId])
        if (advance) {
          await client.query(
            `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount,
                                           tenant_fee_amount, pull_day, status, defaulted_at, default_reason)
             VALUES ('2026-06-01', $1, $2, $3, $4, 440, 25, 10, $5, NOW() - interval '120 days', $6)`,
            [tenantId, f.landlordId, unitId, leaseId, advance.status, advance.reason])
        }
        await client.query('COMMIT')
        return tenantId
      } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    }
    const gamSide   = await seedApplicant({ status: 'defaulted', reason: 'pull_not_created' })
    const recovered = await seedApplicant({ status: 'reconciled', reason: 'pull_not_collected' })
    const firstTime = await seedApplicant(null)

    const list = await request(buildApp())
      .get('/api/admin/flexpay/inquiries')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(list.status).toBe(200)
    const flag = (id: string) => list.body.data.find((r: any) => r.tenant_id === id)?.is_flexpay_returner
    expect(flag(gamSide)).toBe(false)
    expect(flag(recovered)).toBe(true)
    expect(flag(firstTime)).toBe(false)
    // The returner sorts behind both first-timers.
    expect(list.body.data.map((r: any) => r.tenant_id).at(-1)).toBe(recovered)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10/3 (Nic): the two admin money cards. "Is that actually accurate?"
// ═══════════════════════════════════════════════════════════════════════════
describe('10/3: GAM\'s own money and the processing margin, from the routes', () => {
  async function seedMoney() {
    const f = await seedAFixture()
    const c = await db.connect()
    let tenantId = '', propertyId = ''
    try {
      tenantId = await seedTenant(c)
      propertyId = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
    } finally { c.release() }
    await db.query(`DELETE FROM stripe_processing_costs`)
    // A card payment that settled: $460 of rent owed on to the landlord, $16.65 of fee GAM's.
    const { rows: [p] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, type, amount, status, entry_description, due_date, platform_held, settled_at)
       VALUES ($1, $2, 'rent', 460, 'settled', 'RENT', '2026-10-01', TRUE, '2026-10-01T22:43:00Z') RETURNING id`,
      [f.landlordId, tenantId])
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type)
       VALUES ($1, 'allocation_owner_share', 460, 460, $2, 'payment')`, [f.landlordUserId, p.id])
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, 460, 460, 'settled', 'card', 476.65, 16.65, 'pi_card', '2026-10-01T22:43:00Z', '2026-10-01T22:43:00Z'),
              ($1, $2, 460, 460, 'processing', 'ach', 466, 6, 'pi_ach', '2026-10-01T14:56:00Z', NULL)`,
      [tenantId, f.landlordId])
    // A background check an applicant paid: $5 + $2.05 GAM's, $37.94 Checkr's.
    const { rows: [bc] } = await db.query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, amount_charged, applicant_payment_intent_id, created_at)
       VALUES ($1, $2, 44.99, 'pi_bc', '2026-10-01T20:00:00Z') RETURNING id`, [f.landlordId, f.landlordUserId])
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, customer_fee_charged)
       VALUES ('screening_margin', 5, 5, $1, 'background_check', NULL),
              ('banking_spread', 0.49, 5.49, $1, 'background_check', 2.05)`, [bc.id])
    // What Stripe charged: the day's card costs, and its fee on the clearing bank payment.
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end, stripe_payment_intent_id)
       VALUES ('n_oct1', 'network_cost', 'card_interchange', 10.00, '2026-10-02T12:00:00Z', '2026-10-01', '2026-10-01', NULL),
              ('ach:fee', 'payment', 'bank_debit_fee', 2.33, '2026-10-01T20:53:00Z', NULL, NULL, 'pi_ach')`)
    return { ...f, propertyId }
  }

  /** Stripe as it reads with that money on it: 476.65 + 463.67 + 44.99 − 10.00 = 975.31. */
  const fakeStripe = (balanceCents = 97531) => ({
    balance: { retrieve: async () => ({ available: [{ amount: 50000, currency: 'usd' }], pending: [{ amount: balanceCents - 50000, currency: 'usd' }] }) },
    paymentIntents: { retrieve: async () => { throw new Error('a bank payment is read from the balance list, never one call each') } },
    payouts: { list: async () => ({ data: [], has_more: false }) },
    // The clearing bank payment as Stripe records it: a 'payment' balance
    // transaction, net of Stripe's $2.33.
    balanceTransactions: { list: async (p: any) => p.type === 'payment'
      ? { data: [{ id: 'txn_ach', type: 'payment', amount: 46600, fee: 233, net: 46367, created: Math.floor(Date.now() / 1000) - 3600,
                   source: { id: 'py_ach', payment_intent: 'pi_ach' } }], has_more: false }
      : { data: [], has_more: false } },
  })

  async function balanceWith(token: string, stripe: any) {
    vi.resetModules()
    vi.doMock('../lib/stripe', () => ({ getStripe: () => stripe, stripeSecretKeyOrNull: () => undefined }))
    try {
      const { adminRouter: router } = await import('./admin')
      const app = express(); app.use(express.json()); app.use('/api/admin', router); app.use(errorHandler)
      return await request(app).get('/api/admin/platform-balance').set('Authorization', `Bearer ${token}`)
    } finally { vi.doUnmock('../lib/stripe') }
  }

  it('GAM\'s own leaves out landlords\' clearing bank payments and Checkr\'s money, and checks out against GAM\'s records', async () => {
    const f = await seedMoney()
    const res = await balanceWith(f.superAdminToken, fakeStripe())
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.on_balance).toBe(975.31)
    expect(d.owed_to_landlords).toBe(460)
    expect(d.clearing).toMatchObject({ count: 1, landlords_on_balance: 460, gam_fees: 6, stripe_took: 2.33, net_on_balance: 463.67 })
    expect(d.checkr_held).toBe(37.94)
    expect(d.gams_own).toBe(13.70)                  // 16.65 + 7.05 − 10.00: the card fee and GAM's part of the check, less Stripe
    expect(d.reconciliation).toMatchObject({ collected: 23.70, stripe_costs: 10, book: 13.70, on_balance: 13.70, gap: 0 })
  })

  it('both cards get GAM\'s clearing money on one basis: on the balance after Stripe\'s cut, and not on it yet', async () => {
    const f = await seedMoney()
    const res = await balanceWith(f.superAdminToken, fakeStripe())
    // The clearing bank payment: $466 paid, $460 the landlord's, $6 GAM's fee; Stripe took $2.33.
    expect(res.body.data.clearing).toMatchObject({ gam_total: 6, gam_on_balance: 3.67, gam_not_yet_on_balance: 0, stripe_took: 2.33 })
  })

  it('a returned-payment fee the tenant paid is its own line on the check, and the check still ties', async () => {
    const f = await seedMoney()
    const { rows: [fee] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, type, amount, status, entry_description, due_date, revenue_owner, settled_at)
       VALUES ($1, 'fee', 4, 'settled', 'RETURNFEE', '2026-10-01', 'gam', '2026-10-02T15:00:00Z') RETURNING id`, [f.landlordId])
    const { rows: [rm] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       SELECT tenant_id, landlord_id, 4, 4, 'settled', 'ach', 4, 0, 'pi_return_fee', '2026-10-02T15:00:00Z', '2026-10-02T15:00:00Z'
         FROM tenant_remittances WHERE stripe_payment_intent_id = 'pi_card' RETURNING id`)
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 4)`, [rm.id, fee.id])
    const res = await balanceWith(f.superAdminToken, fakeStripe(97531 + 400))
    const d = res.body.data
    expect(d.gams_own).toBe(17.70)
    expect(d.reconciliation.collected_parts.gam_owned_bill_lines).toBe(4)
    expect(d.reconciliation.gam_owned_bill_lines_by_kind).toEqual([{ kind: 'return_fee', label: 'Returned bank payment fees', amount: 4 }])
    expect(d.reconciliation).toMatchObject({ book: 17.70, gap: 0 })
  })

  it('names each kind of GAM money on the check, and businesses\' and unknown clearing money apart from GAM\'s (10/3 review)', async () => {
    const f = await seedMoney()
    const res = await balanceWith(f.superAdminToken, fakeStripe())
    const d = res.body.data
    expect(d.reconciliation.collected_parts).toMatchObject({
      tenant_paid_platform_fees: 0, stay_deposit_fees: 0, business_payment_fees: 0, business_invoicing_fees: 0,
    })
    expect(d.clearing).toMatchObject({ businesses_on_balance: 0, unrecorded: { count: 0, net_on_balance: 0 } })
  })

  it('a disputed card payment puts each part of the dispute on its own line of the check, and the check ties (10/4 review)', async () => {
    const f = await seedMoney()
    // The landlord was paid the $460; then the payer disputed the $476.65 charge.
    const { rows: [p] } = await db.query<{ id: string; tenant_id: string }>(
      `UPDATE payments SET status = 'returned', stripe_payment_intent_id = 'pi_card'
        WHERE landlord_id = $1 AND type = 'rent' RETURNING id, tenant_id`, [f.landlordId])
    await db.query(`UPDATE user_balance_ledger SET stripe_transfer_id = 'tr_paid' WHERE reference_id = $1`, [p.id])
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('du_card', 'ch_card', 'pi_card', 476.65, 'needs_response')`)
    await db.query(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, reversal_type, reversed_amount, reversal_fee,
                                      stripe_event_id, raw_event, recovery_status, status)
       VALUES ($1, $2, $3, 'card_dispute', 460, 15, 'evt_du_card', '{}', 'pending', 'open')`, [p.id, f.landlordId, p.tenant_id])
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount)
       VALUES ($1, 'dispute', 'stripe_fee_kept:pi_card', -5.03)`, [f.landlordId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at)
       VALUES ('txn_du_card:fee', 'adjustment', 'other', 15, NOW())`)
    // The balance: less the $460 paid out, the $476.65 taken back and Stripe's $15.
    const res = await balanceWith(f.superAdminToken, fakeStripe(97531 - 46000 - 47665 - 1500))
    const d = res.body.data
    expect(d.reconciliation.taken_back).toEqual({
      fees_given_back: 16.65, fees_charged_to_landlords: 5.03, chargeback_fees_from_payees: 0,
      rent_not_repaid: 460, gam_lines_taken_back: 0, fees_owed_back_on_wins: 0, chargebacks_owed_back_on_wins: 0, net: -471.62,
    })
    expect(d.reconciliation).toMatchObject({ collected: 23.70, stripe_costs: 25, book: -472.92, on_balance: -472.92, gap: 0 })
  })

  it('a dollar on the balance GAM\'s records cannot explain shows as a gap with its amount', async () => {
    const f = await seedMoney()
    const res = await balanceWith(f.superAdminToken, fakeStripe(97531 + 125))
    expect(res.body.data.gams_own).toBe(14.95)
    expect(res.body.data.reconciliation.gap).toBe(1.25)
  })

  it('with Stripe unreachable the card shows GAM\'s records and no headline', async () => {
    const f = await seedMoney()
    const res = await balanceWith(f.superAdminToken, { ...fakeStripe(), balance: { retrieve: async () => { throw new Error('Stripe is down') } } })
    expect(res.status).toBe(200)
    expect(res.body.data.gams_own).toBeNull()
    expect(res.body.data.reconciliation).toBeNull()
    expect(res.body.data.checkr_held).toBe(37.94)
  })

  it('is for the super admin only', async () => {
    const f = await seedMoney()
    const res = await balanceWith(f.adminToken, fakeStripe())
    expect(res.status).toBe(403)
  })

  it('the per-payment list is the card\'s month: cleared fees are the fee revenue, and the clearing payment is marked', async () => {
    const f = await seedMoney()
    const list = await request(buildApp()).get('/api/admin/processing-margin/payments?month=2026-10')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(list.status).toBe(200)
    const m = list.body.data
    const cleared = m.payments.filter((p: any) => !p.clearing)
    expect(m.feeRevenue).toBe(18.70)                       // card 16.65 + the check's 2.05
    expect(Math.round(cleared.reduce((a: number, p: any) => a + p.feeCharged, 0) * 100)).toBe(1870)
    expect(Math.round((cleared.reduce((a: number, p: any) => a + p.stripeCost, 0) + m.notTiedTotal) * 100)).toBe(Math.round(m.stripeCost * 100))
    expect(m.payments.find((p: any) => p.clearing)).toMatchObject({ methodLabel: 'Bank', feeCharged: 6, stripeCost: 2.33, costBasis: 'exact' })
    expect(m.clearing).toEqual({ count: 1, amount: 466, fees: 6, stripeCost: 2.33 })
  })

  it('the per-payment list refuses a month that is not one, and anyone but the super admin', async () => {
    const f = await seedMoney()
    const bad = await request(buildApp()).get('/api/admin/processing-margin/payments?month=October')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(bad.status).toBe(400)
    const admin = await request(buildApp()).get('/api/admin/processing-margin/payments?month=2026-10')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(admin.status).toBe(403)
  })

  it('the monthly card counts only cleared fees, and names its rails in words', async () => {
    const f = await seedMoney()
    const res = await request(buildApp()).get('/api/admin/processing-margin?months=24')
      .set('Authorization', `Bearer ${f.superAdminToken}`)
    expect(res.status).toBe(200)
    const oct = res.body.data.find((r: any) => r.month === '2026-10')
    expect(oct.feeRevenue).toBe(18.70)
    expect(oct.payments).toBeUndefined()
    expect(oct.byRail.map((r: any) => r.label).sort()).toEqual(['Background check', 'Card payment'])
  })
})
