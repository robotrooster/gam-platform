/**
 * 10/13 (Nic) — the Metrics page's money billed and collected, tenants ever,
 * the landlords' default rate through GAM, and ages.
 *
 * "Money metrics, all time, BILLED AND COLLECTED: utilities billed back BY
 * UTILITY + total; rent; total platform fees." "Total tenants ever on GAM:
 * every person on a lease, counted once (even if they come back)." "DEFAULT
 * RATE ... months left unpaid by tenants who moved out owing ÷ all calendar
 * months of rent billed — AS A FRACTION of a month ($300 of $460 = 0.65), plus
 * a DOLLAR % too, plus where defaults happen by RENT RANGE. Paying later does
 * NOT take it off." "Ages: every person on a lease; average age toggled by
 * property, oldest/youngest, age at default."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { adminRouter } from './admin'
import { errorHandler } from '../middleware/errorHandler'
import {
  clearPlatformMetricsCache, ageOn, rentBandLabel, rentBandOf, RENT_BANDS,
} from '../services/platformMetrics'
import { NEVER_MOVED_IN_REASON } from '../lib/unwindIssuedLease'
import { todayIn } from '../lib/timezone'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_metrics_lifetime'
})

async function lifetime() {
  const res = await request(buildApp()).get('/api/admin/metrics/lifetime')
    .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
  expect(res.status).toBe(200)
  return res.body.data
}

/** The pieces of a park, written straight to the tables. */
function park(c: PoolClient, landlordId: string) {
  const tenant = async (first: string, last: string, dob: string | null) => {
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', $2, $3, TRUE) RETURNING id`, [`t-${randomUUID()}@test.dev`, first, last])
    return (await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id, date_of_birth) VALUES ($1, $2) RETURNING id`, [u.rows[0].id, dob])).rows[0].id
  }
  const lease = async (o: {
    unitId: string; rent: number; start: string; status?: string; end?: string | null
    terminatedAt?: string | null; reason?: string | null; supersedes?: string | null
  }) => (await c.query<{ id: string }>(
    `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
                         terminated_at, termination_reason, supersedes_lease_id)
     VALUES ($1, $2, $3, 'month_to_month', $4, $5, $6, $7, $8, $9) RETURNING id`,
    [o.unitId, landlordId, o.rent, o.status ?? 'active', o.start, o.end ?? null,
     o.terminatedAt ?? null, o.reason ?? null, o.supersedes ?? null])).rows[0].id
  const onLease = (leaseId: string, tenantId: string, role = 'primary', status = 'active') => c.query(
    `INSERT INTO lease_tenants (lease_id, tenant_id, role, status) VALUES ($1, $2, $3, $4)`,
    [leaseId, tenantId, role, status])
  const occupant = (leaseId: string, name: string, dob: string | null) => c.query(
    `INSERT INTO lease_occupants (lease_id, full_name, date_of_birth) VALUES ($1, $2, $3)`, [leaseId, name, dob])
  /** A bill; `paid` pays it in full through a settled tenant payment made on that day. */
  const bill = async (o: {
    unitId: string; leaseId: string; tenantId: string; type?: string; entry?: string; amount: number
    due: string; paid?: string; method?: string; voided?: boolean
  }) => {
    const type = o.type ?? 'rent'
    const status = o.voided ? 'voided' : o.paid ? 'settled' : 'pending'
    const p = await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description,
                             due_date, settled_at, voided_at, void_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12) RETURNING id`,
      [o.unitId, o.tenantId, landlordId, o.leaseId, type, o.amount, status,
       o.entry ?? (type === 'rent' ? 'RENT' : 'UTILITY'), o.due,
       o.paid ? `${o.paid} 12:00:00-07` : null,
       o.voided ? new Date() : null, o.voided ? 'test: not owed' : null])
    if (o.paid) {
      const method = o.method ?? 'cash'
      const r = await c.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, status,
                                         payment_method, stripe_payment_intent_id, created_at, settled_at)
         VALUES ($1, $2, $3, $4, $4, 'settled', $5, $6, $7::timestamptz, $7::timestamptz) RETURNING id`,
        [o.tenantId, landlordId, o.leaseId, o.amount, method,
         method === 'card' || method === 'ach' ? `pi_${randomUUID()}` : null, `${o.paid} 12:00:00-07`])
      await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`,
        [r.rows[0].id, p.rows[0].id, o.amount])
    }
    return p.rows[0].id
  }
  return { tenant, lease, onLease, occupant, bill }
}

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * One landlord, two properties:
 *   Oak (P1): L1 — two tenants and an occupant, June closed and covered by
 *             work trade, three months paid, October still being worked, utilities;
 *             L2 — moved out 9/15 owing August and September ($920 = 2.0
 *             months), September paid on 9/20, after the move-out.
 *   Pine (P2): L3 → L4 — the same tenant went straight on to another lease
 *             (not a move-out, though September was left open); L5 → L6 — a
 *             renewal (not a move-out); L7 never moved in; L8 voided; L9 starts
 *             in December. The occupant of L1 is listed on L4 too.
 */
async function seedParks() {
  return tx(async c => {
    const { userId, landlordId } = await seedLandlord(c)
    const oak = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const pine = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET name = 'Oak' WHERE id = $1`, [oak])
    await c.query(`UPDATE properties SET name = 'Pine' WHERE id = $1`, [pine])
    const unit = (propertyId: string) => seedUnit(c, { propertyId, landlordId })
    const k = park(c, landlordId)

    const t1 = await k.tenant('Pat', 'Rivera', '1960-03-29')
    const t2 = await k.tenant('Lee', 'Rivera', '1990-05-01')
    const t3 = await k.tenant('Sam', 'Ortiz', '1980-09-20')
    const t4 = await k.tenant('Kim', 'Lane', null)
    const t5 = await k.tenant('Ray', 'Diaz', '2000-01-15')
    const t6 = await k.tenant('Never', 'Moved', '1970-01-01')
    const t7 = await k.tenant('Void', 'Ed', '1971-01-01')
    const t8 = await k.tenant('Future', 'Person', '1972-01-01')

    // Oak
    const u1 = await unit(oak)
    const l1 = await k.lease({ unitId: u1, rent: 460, start: '2026-06-01' })
    await k.onLease(l1, t1)
    await k.onLease(l1, t2, 'co_tenant')
    await k.occupant(l1, 'Mia Rivera', '2015-01-01')
    await k.occupant(l1, 'pat rivera', null) // the tenant again, listed as an occupant: still one person
    const a1 = { unitId: u1, leaseId: l1, tenantId: t1 }
    // June: the month CLOSED and the hours covered the rent in full — the close
    // zeroes the charge and writes what the hours paid (work_trade_credit), so
    // no money was billed and the month is a month billed all the same
    // (10/14 (Nic): "count them in months billed, as paid").
    const june = await k.bill({ ...a1, amount: 460, due: '2026-06-01' })
    await c.query(
      `UPDATE payments SET amount = 0, status = 'settled', settled_at = '2026-06-30 18:00:00-07',
              work_trade_credit = 460 WHERE id = $1`, [june])
    await k.bill({ ...a1, amount: 460, due: '2026-07-01', paid: '2026-07-01', method: 'card' })
    await k.bill({ ...a1, amount: 460, due: '2026-08-01', paid: '2026-08-01', method: 'ach' })
    await k.bill({ ...a1, amount: 460, due: '2026-09-01', paid: '2026-09-01' })
    // October: labor is still working this one and the month has not closed —
    // the charge is parked, nothing is asked of the tenant and nothing is
    // credited. 10/17 (review): not a month billed, and not a month paid by
    // work trade either, until its hours are judged at the close.
    const oct = await k.bill({ ...a1, amount: 460, due: '2026-10-01' })
    await c.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE id = $1`, [oct])
    // Utilities, each by its own bill.
    const meter = async (type: string) => (await c.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits)
       VALUES ($1, $2, 'M', 'submeter', $3) RETURNING id`, [oak, type, type === 'trash' ? null : 6])).rows[0].id
    const utility = async (type: string, amount: number, paid?: string) => {
      const pid = await k.bill({ ...a1, type: 'utility', amount, due: '2026-09-05', paid })
      await c.query(
        `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
                                    charge_amount, payment_id, status, utility_type)
         VALUES ($1, $2, $3, $4, $5, '2026-08-01', $6, $7, 'billed', $8)`,
        [await meter(type), u1, t1, l1, landlordId, amount, pid, type])
    }
    await utility('electric', 50, '2026-09-06')
    await utility('water', 30)
    await utility('trash', 10)
    await k.bill({ ...a1, type: 'utility', entry: 'PROPANE', amount: 40, due: '2026-09-10', paid: '2026-09-10' })

    const u2 = await unit(oak)
    const l2 = await k.lease({ unitId: u2, rent: 460, start: '2026-06-01', status: 'terminated',
                               end: '2026-09-15', terminatedAt: '2026-09-15 12:00:00-07' })
    await k.onLease(l2, t3, 'primary', 'removed')
    await k.occupant(l2, 'Kid Ortiz', '2010-09-01')
    await k.occupant(l2, 'Sam  Ortiz', '1980-09-20') // Sam himself, listed again: still one person
    await c.query(`UPDATE lease_tenants SET removed_at = '2026-09-15 12:00:00-07', removed_reason = 'lease_ended' WHERE lease_id = $1`, [l2])
    const a2 = { unitId: u2, leaseId: l2, tenantId: t3 }
    await k.bill({ ...a2, amount: 460, due: '2026-07-01', paid: '2026-07-01' })
    await k.bill({ ...a2, amount: 460, due: '2026-08-01' })
    await k.bill({ ...a2, amount: 460, due: '2026-09-01', paid: '2026-09-20' }) // paid after the move-out
    await k.bill({ ...a2, amount: 460, due: '2026-10-01', voided: true })

    // Pine
    const u3 = await unit(pine)
    const l3 = await k.lease({ unitId: u3, rent: 900, start: '2026-08-01', status: 'expired',
                               end: '2026-09-30', terminatedAt: '2026-10-01 02:00:00-07' })
    await k.onLease(l3, t4, 'primary', 'removed')
    await k.bill({ unitId: u3, leaseId: l3, tenantId: t4, amount: 900, due: '2026-08-01', paid: '2026-08-01' })
    await k.bill({ unitId: u3, leaseId: l3, tenantId: t4, amount: 900, due: '2026-09-01' })
    const u4 = await unit(pine)
    const l4 = await k.lease({ unitId: u4, rent: 900, start: '2026-10-01' })
    await k.onLease(l4, t4)
    await k.occupant(l4, 'MIA  rivera.', '2015-01-01') // the same occupant as on L1
    await k.bill({ unitId: u4, leaseId: l4, tenantId: t4, amount: 900, due: '2026-10-01', paid: '2026-10-01' })

    const u5 = await unit(pine)
    const l5 = await k.lease({ unitId: u5, rent: 300, start: '2026-07-01', status: 'expired',
                               end: '2026-08-31', terminatedAt: '2026-09-01 02:00:00-07' })
    await k.onLease(l5, t5, 'primary', 'removed')
    await k.bill({ unitId: u5, leaseId: l5, tenantId: t5, amount: 300, due: '2026-07-01' })
    await k.bill({ unitId: u5, leaseId: l5, tenantId: t5, amount: 300, due: '2026-08-01' })
    const u6 = await unit(pine)
    const l6 = await k.lease({ unitId: u6, rent: 300, start: '2026-09-01', supersedes: l5 })
    await k.onLease(l6, t5)
    await k.bill({ unitId: u6, leaseId: l6, tenantId: t5, amount: 300, due: '2026-09-01', paid: '2026-09-01' })
    await k.bill({ unitId: u6, leaseId: l6, tenantId: t5, amount: 300, due: '2026-10-01' })

    const u7 = await unit(pine)
    const l7 = await k.lease({ unitId: u7, rent: 500, start: '2026-09-01', status: 'terminated',
                               terminatedAt: '2026-09-05 12:00:00-07', reason: NEVER_MOVED_IN_REASON })
    await k.onLease(l7, t6, 'primary', 'removed')
    await k.bill({ unitId: u7, leaseId: l7, tenantId: t6, amount: 500, due: '2026-09-01', voided: true })
    const u8 = await unit(pine)
    const l8 = await k.lease({ unitId: u8, rent: 500, start: '2026-09-01', status: 'terminated',
                               terminatedAt: '2026-09-02 12:00:00-07' })
    await k.onLease(l8, t7, 'primary', 'void')
    const u9 = await unit(pine)
    const l9 = await k.lease({ unitId: u9, rent: 500, start: '2026-12-01', status: 'pending' })
    await k.onLease(l9, t8)
    // A reservation's draft lease, cancelled before anyone signed: ended with a
    // bare status change, never in force — nobody on it was ever a tenant.
    const t9 = await k.tenant('Draft', 'Guest', '1973-01-01')
    const u10 = await unit(pine)
    const l10 = await k.lease({ unitId: u10, rent: 500, start: '2026-09-10', status: 'terminated', end: '2026-09-12' })
    await k.onLease(l10, t9)

    // GAM's platform fee: September's $48 for Oak collected; October's $24 for Pine still open.
    const fee = async (propertyId: string, month: string, amount: number, collected: number) => {
      const a = (await c.query<{ id: string }>(
        `INSERT INTO platform_fee_accruals (landlord_id, property_id, accrual_month, rate_per_unit,
                                            min_per_connect_account, total_amount, payer)
         VALUES ($1, $2, $3, 2, 10, $4, 'landlord') RETURNING id`, [landlordId, propertyId, month, amount])).rows[0].id
      await c.query(
        `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, property_id)
         VALUES ('platform_fee_subscription', $1, 0, $2, 'platform_fee_accrual', $3)`, [amount, a, propertyId])
      await c.query(
        `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, collected_amount, source_type, source_id)
         VALUES ($1, $2, 'subscription', $3, $4, 'platform_fee_accrual', $5)`, [landlordId, propertyId, amount, collected, a])
    }
    await fee(oak, '2026-09-01', 48, 48)
    await fee(pine, '2026-10-01', 24, 0)
    return { oak, pine }
  })
}

/** A demo landlord with everything that would count — none of it may. */
async function seedDemo() {
  return tx(async c => {
    const { userId, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [landlordId])
    const p = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const k = park(c, landlordId)
    const t = await k.tenant('Demo', 'Person', '1950-01-01')
    const u = await seedUnit(c, { propertyId: p, landlordId })
    const l = await k.lease({ unitId: u, rent: 1000, start: '2026-06-01', status: 'terminated',
                              end: '2026-08-15', terminatedAt: '2026-08-15 12:00:00-07' })
    await k.onLease(l, t, 'primary', 'removed')
    await k.bill({ unitId: u, leaseId: l, tenantId: t, amount: 1000, due: '2026-07-01' })
    await k.bill({ unitId: u, leaseId: l, tenantId: t, type: 'utility', amount: 75, due: '2026-07-05', paid: '2026-07-05' })
  })
}

describe('GET /api/admin/metrics/lifetime', () => {
  it('is super admin only', async () => {
    const admin = await staffToken('admin')
    expect((await request(buildApp()).get('/api/admin/metrics/lifetime').set('Authorization', `Bearer ${admin}`)).status).toBe(403)
    expect((await request(buildApp()).get('/api/admin/metrics/lifetime')).status).toBe(401)
    const ok = await request(buildApp()).get('/api/admin/metrics/lifetime')
      .set('Authorization', `Bearer ${await staffToken('super_admin')}`)
    expect(ok.status).toBe(200)
    expect(ok.body.data.tenants.ever).toBe(0)
    expect(ok.body.data.defaults.rate).toBeNull()
    expect(ok.body.data.ages.average).toBeNull()
  })

  it('money: rent, each utility and GAM platform fees, billed and collected', async () => {
    await seedParks()
    await seedDemo()
    const m = await lifetime()

    // Rent due through today, voided bills and L1's work-traded October left out:
    // L1 1380 + L2 1380 + L3 1800 + L4 900 + L5 600 + L6 600.
    expect(m.money.rent.label).toBe('Lot/space rent')
    expect(m.money.rent.billed).toBeCloseTo(6660, 2)
    // 10/14 (Nic): "Unpaid-at-move-out dollar %: rent + utilities + late fees"
    // — so what the default rate divides by is this rent plus the utilities
    // below, and nothing else. One set of billed facts on the page: the card
    // adds up to the figure the tile divides by (10/17 review — the figure was
    // printed with nothing on the page adding up to it).
    expect(m.defaults.billed).toBeCloseTo(m.money.rent.billed + m.money.utilities.billed, 2)
    expect(m.defaults.billed).toBeCloseTo(6660 + 130, 2)
    expect(m.defaults.rentBilled).toBeUndefined()
    // Paid: L1 1380, L2 460 + 460 (paid late, still collected), L3 900, L4 900, L6 300.
    expect(m.money.rent.collected).toBeCloseTo(4400, 2)
    expect(m.money.rent.owed).toBeCloseTo(2260, 2)

    const u = Object.fromEntries(m.money.utilities.byUtility.map((x: any) => [x.utility, x]))
    expect(u.electric).toMatchObject({ label: 'Electric', billed: 50, collected: 50 })
    expect(u.water).toMatchObject({ label: 'Water', billed: 30, collected: 0 })
    expect(u.trash).toMatchObject({ label: 'Trash', billed: 10, collected: 0 })
    expect(u.propane).toMatchObject({ label: 'Propane', billed: 40, collected: 40 })
    expect(u.sewer).toMatchObject({ billed: 0, collected: 0 })
    expect(u.gas).toMatchObject({ label: 'Natural gas', billed: 0, collected: 0 })
    // "Other utilities" only when there is some.
    expect(u.utility_other).toBeUndefined()
    expect(m.money.utilities.billed).toBeCloseTo(130, 2)
    expect(m.money.utilities.collected).toBeCloseTo(90, 2)

    // 10/14 (Nic): "Platform fees on Metrics: show each separately (space fee,
    // processing margin, screening margin) plus a total." Only the monthly
    // space fee is seeded here: September's $48 collected, October's $24 open.
    expect(m.money.platformFees.spaceFee).toEqual({ billed: 72, collected: 48, owed: 24 })
    expect(m.money.platformFees.processing).toEqual({ billed: 0, collected: 0, owed: 0 })
    expect(m.money.platformFees.screening).toEqual({ billed: 0, collected: 0, owed: 0 })
    expect(m.money.platformFees).toMatchObject({ billed: 72, collected: 48, owed: 24 })
  })

  it('platform fees: the space fee, the processing margin and the screening margin, each on its own, plus the total', async () => {
    // 10/14 (Nic): all three read GAM's own revenue book, cut the way the money
    // page's pies cut it (services/revenueSlices) — so the monthly processing
    // true-up is processing income, not an unexplained "adjustment", and a
    // screening margin taken back nets inside the screening line.
    const { oak } = await seedParks()
    await seedDemo()
    const book = (type: string, amount: number, propertyId: string | null, referenceType?: string) => db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_type, property_id)
       VALUES ($1, $2, 0, $3, $4)`, [type, amount, referenceType ?? null, propertyId])
    await book('banking_spread', 12.5, oak)                                      // the card and ACH margin
    await book('adjustment', 1.25, oak, 'processing_margin_true_up')             // Stripe's real invoice, monthly
    await book('screening_margin', 9, oak)
    await book('adjustment', -4, oak, 'screening_margin_reversal')               // a check cancelled before a report
    await book('banking_spread', 99, null)                                       // not tied to a property: GAM's own
    // A demo landlord's margin is not GAM's revenue; neither is a slice of
    // another kind (FlexPay here), which has its own card on the money page.
    const demoProperty = (await db.query<{ id: string }>(
      `SELECT p.id FROM properties p JOIN landlords l ON l.id = p.landlord_id WHERE l.is_demo = TRUE LIMIT 1`)).rows[0].id
    await book('banking_spread', 500, demoProperty)
    await book('flexpay_subscription', 25, oak)
    clearPlatformMetricsCache()

    const f = (await lifetime()).money.platformFees
    expect(f.spaceFee).toEqual({ billed: 72, collected: 48, owed: 24 })
    // A margin is earned when the money it rode in on is paid, so it is billed
    // and collected at once — nothing of it is ever "owed".
    expect(f.processing).toEqual({ billed: 112.75, collected: 112.75, owed: 0 })
    expect(f.screening).toEqual({ billed: 5, collected: 5, owed: 0 })
    expect(f.billed).toBeCloseTo(72 + 112.75 + 5, 2)
    expect(f.collected).toBeCloseTo(48 + 112.75 + 5, 2)
    expect(f.owed).toBeCloseTo(24, 2)
  })

  it('tenants ever: every person on a lease once — never moved in, void, a cancelled draft and not started left out', async () => {
    await seedParks()
    await seedDemo()
    const t = (await lifetime()).tenants
    // Pat, Lee, Sam, Kim (two leases, once), Ray (renewed, once) + Mia (listed on two
    // leases, once) and Kid.
    expect(t.tenants).toBe(5)
    expect(t.occupants).toBe(2)
    expect(t.ever).toBe(7)
    // Sam's household moved out; everyone else is on an active lease.
    expect(t.onALeaseNow).toBe(5)
    expect(t.movedOn).toBe(2)
  })

  it('the default rate: months left unpaid at move-out over calendar months billed, and by dollars, by rent range', async () => {
    await seedParks()
    await seedDemo()
    const d = (await lifetime()).defaults
    // L1 4 + L2 3 + L3 2 + L4 1 + L5 2 + L6 2 lease-months; L2's October and L7
    // were voided. 10/14 (Nic): "Months fully covered by work trade: count them
    // in months billed (as paid)" — L1's June billed no money because the hours
    // covered it, and it is a month billed all the same. L1's October, still
    // being worked, is in neither figure: its hours have not been judged.
    expect(d.monthsBilled).toBe(14)
    expect(d.monthsWorkTrade).toBe(1)
    // Billed is rent + utilities + late fees (none here) — the Money section's
    // own figures, nothing added back: 6660 rent + 130 utilities.
    expect(d.billed).toBeCloseTo(6790, 2)
    // Only Sam's household moved out owing: August, and September — paid on 9/20, after
    // the move-out, which does not take it off. Kim went straight on to another
    // lease; Ray renewed; the never-moved-in lease owes nothing.
    expect(d.householdsOwing).toBe(1)
    expect(d.monthsUnpaid).toBeCloseTo(2, 4)
    expect(d.dollarsUnpaid).toBeCloseTo(920, 2)
    expect(d.rate).toBeCloseTo(2 / 14, 6)
    expect(d.dollarRate).toBeCloseTo(920 / 6790, 6)

    const band = Object.fromEntries(d.byRentRange.map((b: any) => [b.label, b]))
    expect(Object.keys(band)).toEqual(['$300 to $399', '$400 to $499', '$900 to $999'])
    // The $400 band is L1 and L2: L1's four months (June by work trade) and
    // L2's three; billed is the money rent on them, 1380 + 1380, and L1's
    // utilities 130 — June billed no money, so it adds nothing to the dollars.
    expect(band['$400 to $499']).toMatchObject({
      leases: 2, monthsBilled: 7, monthsWorkTrade: 1, billed: 2890, householdsOwing: 1, dollarsUnpaid: 920,
    })
    expect(band['$400 to $499'].rate).toBeCloseTo(2 / 7, 6)
    expect(band['$400 to $499'].dollarRate).toBeCloseTo(920 / 2890, 6)
    expect(band['$300 to $399']).toMatchObject({ leases: 2, monthsBilled: 4, billed: 1200, householdsOwing: 0, monthsUnpaid: 0 })
    // 10/14 (Nic): the even $100 steps put the two $900 leases in their own band.
    expect(band['$900 to $999']).toMatchObject({ leases: 2, monthsBilled: 3, billed: 2700, householdsOwing: 0 })
  })

  it('the rent bands are even $100 steps: under $300, every $100 to $2,000, then $2,000+', () => {
    // 10/14 (Nic): "Rent ranges: even $100 steps (under $300, every $100 to
    // $2,000, then $2,000+)."
    expect(RENT_BANDS.length).toBe(19)
    expect(rentBandLabel(RENT_BANDS[0])).toBe('Under $300')
    expect(rentBandLabel(RENT_BANDS[1])).toBe('$300 to $399')
    expect(rentBandLabel(RENT_BANDS[17])).toBe('$1,900 to $1,999')
    expect(rentBandLabel(RENT_BANDS[18])).toBe('$2,000 and up')
    // Every step is $100, with no gap and no overlap between one band and the next.
    for (let i = 1; i < RENT_BANDS.length - 1; i++) {
      expect(RENT_BANDS[i].max! - RENT_BANDS[i].min).toBe(100)
      expect(RENT_BANDS[i].min).toBe(RENT_BANDS[i - 1].max)
    }
    expect(RENT_BANDS[18].min).toBe(2000)
    expect(RENT_BANDS[18].max).toBeNull()
    expect(rentBandOf(299.99)).toBe(RENT_BANDS[0])
    expect(rentBandOf(1250)).toEqual({ min: 1200, max: 1300 })
    expect(rentBandOf(1999.99)).toEqual({ min: 1900, max: 2000 })
    expect(rentBandOf(2000)).toBe(RENT_BANDS[18])
  })

  it('unpaid at move-out counts rent, utilities and late fees — and what the deposit covered is still a default', async () => {
    // 10/14 (Nic): "Unpaid-at-move-out dollar %: rent + utilities + late fees",
    // and "Deposit covering unpaid rent at move-out: still a default."
    await tx(async c => {
      const { userId, landlordId } = await seedLandlord(c)
      const p = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const k = park(c, landlordId)
      const t = await k.tenant('Dee', 'Moore', null)
      const u = await seedUnit(c, { propertyId: p, landlordId })
      const l = await k.lease({ unitId: u, rent: 500, start: '2026-08-01', status: 'terminated',
                                end: '2026-09-30', terminatedAt: '2026-09-30 12:00:00-07' })
      await k.onLease(l, t, 'primary', 'removed')
      await k.bill({ unitId: u, leaseId: l, tenantId: t, amount: 500, due: '2026-08-01', paid: '2026-08-01' })
      // September: the rent swept to the deposit after the lease ended, a water
      // bill never paid, and a late fee. All three were left unpaid.
      const rent = await k.bill({ unitId: u, leaseId: l, tenantId: t, amount: 500, due: '2026-09-01' })
      await c.query(`UPDATE payments SET status = 'paid_via_deposit', settled_at = '2026-10-02 09:00:00-07' WHERE id = $1`, [rent])
      await k.bill({ unitId: u, leaseId: l, tenantId: t, type: 'utility', amount: 60, due: '2026-09-05' })
      await k.bill({ unitId: u, leaseId: l, tenantId: t, type: 'late_fee', entry: 'LATEFEE', amount: 25, due: '2026-09-06' })
    })
    const d = (await lifetime()).defaults
    expect(d.householdsOwing).toBe(1)
    // The rent left unpaid is what the months are counted in: $500 of a $500 month.
    expect(d.monthsUnpaid).toBeCloseTo(1, 4)
    expect(d.dollarsUnpaid).toBeCloseTo(585, 2)
    expect(d.billed).toBeCloseTo(1085, 2)
    expect(d.dollarRate).toBeCloseTo(585 / 1085, 6)
  })

  it('a household that left only a water bill moved out owing, and owes no month of rent', async () => {
    // 10/14 (Nic): the dollars count "rent + utilities + late fees", so a
    // household that left a water bill behind did move out owing and its $60 is
    // in the dollar figure. The months figure counts RENT left unpaid, and a
    // month has no meaning for a water bill — so it reads 0 beside it. 10/17
    // (review): pinned here because the two tiles sit side by side on the page,
    // and this is the case where they differ. Nic has not been asked whether a
    // utility or a late fee should make a month; see the lane's open questions.
    await tx(async c => {
      const { userId, landlordId } = await seedLandlord(c)
      const p = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const k = park(c, landlordId)
      const t = await k.tenant('Wes', 'Doyle', null)
      const u = await seedUnit(c, { propertyId: p, landlordId })
      const l = await k.lease({ unitId: u, rent: 500, start: '2026-08-01', status: 'terminated',
                                end: '2026-09-30', terminatedAt: '2026-09-30 12:00:00-07' })
      await k.onLease(l, t, 'primary', 'removed')
      await k.bill({ unitId: u, leaseId: l, tenantId: t, amount: 500, due: '2026-08-01', paid: '2026-08-01' })
      await k.bill({ unitId: u, leaseId: l, tenantId: t, amount: 500, due: '2026-09-01', paid: '2026-09-01' })
      await k.bill({ unitId: u, leaseId: l, tenantId: t, type: 'utility', amount: 60, due: '2026-09-05' })
    })
    const d = (await lifetime()).defaults
    expect(d.householdsOwing).toBe(1)
    expect(d.dollarsUnpaid).toBeCloseTo(60, 2)
    expect(d.monthsUnpaid).toBe(0)
    expect(d.rate).toBe(0)
    expect(d.dollarRate).toBeCloseTo(60 / 1060, 6)
  })

  /**
   * A household on two spaces: one lease owes money and ended on `ended`, the
   * other is the same tenant's second space, ending on `secondEnds` (null = it
   * runs on). Used by the two tests below.
   */
  const twoSpaces = (ended: string, secondEnds: string | null) => tx(async c => {
    const { userId, landlordId } = await seedLandlord(c)
    const p = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const k = park(c, landlordId)
    const t = await k.tenant('Jo', 'Vance', null)
    const u1 = await seedUnit(c, { propertyId: p, landlordId })
    const u2 = await seedUnit(c, { propertyId: p, landlordId })
    const l1 = await k.lease({ unitId: u1, rent: 500, start: '2026-08-01', status: 'terminated',
                               end: ended, terminatedAt: `${ended} 12:00:00-07` })
    await k.onLease(l1, t, 'primary', 'removed')
    await k.bill({ unitId: u1, leaseId: l1, tenantId: t, amount: 500, due: '2026-09-01' })
    const l2 = secondEnds
      ? await k.lease({ unitId: u2, rent: 500, start: '2026-08-01', status: 'terminated',
                        end: secondEnds, terminatedAt: `${secondEnds} 12:00:00-07` })
      : await k.lease({ unitId: u2, rent: 500, start: '2026-08-01' })
    await k.onLease(l2, t, 'primary', secondEnds ? 'removed' : 'active')
  })

  it('two spaces given up the same day is still a move-out', async () => {
    // 10/17 (review): the rule the comment on DEFAULT_CTES states — "a lease of
    // theirs that runs past the day it ended" — now with the case it is about.
    // Both spaces were given up on 9/30, so nobody went on living there.
    await twoSpaces('2026-09-30', '2026-09-30')
    const d = (await lifetime()).defaults
    expect(d.householdsOwing).toBe(1)
    expect(d.dollarsUnpaid).toBeCloseTo(500, 2)
  })

  it('a second space that runs on is not a move-out', async () => {
    // The control for the test above: they kept the other space, so the
    // household is still living under this landlord and owes a current balance.
    await twoSpaces('2026-09-30', null)
    const d = (await lifetime()).defaults
    expect(d.householdsOwing).toBe(0)
    expect(d.dollarsUnpaid).toBe(0)
  })

  it('a work-trade month counts once its hours are judged: the month still being worked does not', async () => {
    // 10/14 (Nic): "Months FULLY COVERED by work trade: count them in months
    // billed (as paid)." 10/17 (review): the only month anyone can call fully
    // covered is one the month close has judged. Three months, one of each:
    //   July — closed, the hours covered the rent: a month billed, paid by work trade.
    //   August — closed, the hours fell short: the lapse was billed in money,
    //            so it is a money month, not a work-trade one.
    //   October — still being worked: neither, until the close.
    await tx(async c => {
      const { userId, landlordId } = await seedLandlord(c)
      const p = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const k = park(c, landlordId)
      const t = await k.tenant('Cal', 'Hart', null)
      const u = await seedUnit(c, { propertyId: p, landlordId })
      const l = await k.lease({ unitId: u, rent: 400, start: '2026-07-01' })
      await k.onLease(l, t)
      const a = { unitId: u, leaseId: l, tenantId: t }
      const july = await k.bill({ ...a, amount: 400, due: '2026-07-01' })
      await c.query(
        `UPDATE payments SET amount = 0, status = 'settled', settled_at = '2026-07-31 18:00:00-07',
                work_trade_credit = 400 WHERE id = $1`, [july])
      const august = await k.bill({ ...a, amount: 400, due: '2026-08-01' })
      await c.query(`UPDATE payments SET amount = 90, work_trade_credit = 310 WHERE id = $1`, [august])
      const october = await k.bill({ ...a, amount: 400, due: '2026-10-01' })
      await c.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE id = $1`, [october])
    })
    const d = (await lifetime()).defaults
    expect(d.monthsBilled).toBe(2)
    expect(d.monthsWorkTrade).toBe(1)
    // Only August's $90 lapse is money billed; the hours are not dollars on this page.
    expect(d.billed).toBeCloseTo(90, 2)
  })

  it('a part of a month left unpaid is that part: $300 of a $460 month is 0.65', async () => {
    await tx(async c => {
      const { userId, landlordId } = await seedLandlord(c)
      const p = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const k = park(c, landlordId)
      const t = await k.tenant('Ann', 'Lee', null)
      const u = await seedUnit(c, { propertyId: p, landlordId })
      const l = await k.lease({ unitId: u, rent: 460, start: '2026-08-01', status: 'terminated',
                                end: '2026-09-10', terminatedAt: '2026-09-10 12:00:00-07' })
      await k.onLease(l, t, 'primary', 'removed')
      await k.bill({ unitId: u, leaseId: l, tenantId: t, amount: 460, due: '2026-08-01', paid: '2026-08-01' })
      // A prorated last bill: one calendar month billed, $300 of it left.
      await k.bill({ unitId: u, leaseId: l, tenantId: t, amount: 300, due: '2026-09-01' })
    })
    const d = (await lifetime()).defaults
    expect(d.monthsBilled).toBe(2)
    expect(d.monthsUnpaid).toBeCloseTo(0.65, 2)
    expect(d.rate).toBeCloseTo((300 / 460) / 2, 6)
    expect(d.dollarRate).toBeCloseTo(300 / 760, 6)
  })

  it('ages: everyone on a lease with a birthday — by property, youngest and oldest, and age at default', async () => {
    await seedParks()
    await seedDemo()
    const a = (await lifetime()).ages
    const today = todayIn(null)
    const all = ['1960-03-29', '1990-05-01', '1980-09-20', '2000-01-15', '2015-01-01', '2010-09-01'].map(d => ageOn(d, today))
    expect(a.people).toBe(7)
    expect(a.withBirthday).toBe(6)
    expect(a.average).toBeCloseTo(Math.round((all.reduce((s, x) => s + x, 0) / all.length) * 10) / 10, 5)
    expect(a.youngest).toBe(ageOn('2015-01-01', today))
    expect(a.oldest).toBe(ageOn('1960-03-29', today))

    const by = Object.fromEntries(a.byProperty.map((p: any) => [p.name, p]))
    expect(Object.keys(by)).toEqual(['Oak', 'Pine'])
    // Oak: Pat, Lee, Sam, Mia and Kid. Pine: Kim (no birthday), Ray and Mia.
    expect(by.Oak).toMatchObject({ people: 5, withBirthday: 5, oldest: ageOn('1960-03-29', today), youngest: ageOn('2015-01-01', today) })
    expect(by.Pine).toMatchObject({ people: 3, withBirthday: 2, oldest: ageOn('2000-01-15', today), youngest: ageOn('2015-01-01', today) })

    // Sam was 45 on 9/15/2026, the day his household moved out owing (born 9/20/1980),
    // and Kid 16 — Sam listed again as an occupant is still one person.
    expect(a.atDefault).toEqual({ people: 2, withBirthday: 2, average: 30.5, youngest: 16, oldest: 45 })
  })

  it('leaves demo landlords out of every number', async () => {
    await seedDemo()
    const m = await lifetime()
    expect(m.money.rent.billed).toBe(0)
    expect(m.money.utilities.billed).toBe(0)
    expect(m.tenants.ever).toBe(0)
    expect(m.defaults.monthsBilled).toBe(0)
    expect(m.defaults.householdsOwing).toBe(0)
    expect(m.ages.atDefault.people).toBe(0)
  })
})

describe('rent ranges', () => {
  it('every rent lands in exactly one band, and the labels read as dollars', () => {
    for (const rent of [0, 220, 299.99, 300, 459, 460, 589, 900, 1499, 1500, 2000, 12000]) {
      const hits = RENT_BANDS.filter(b => rent >= b.min && (b.max == null || rent < b.max))
      expect(hits).toHaveLength(1)
      expect(rentBandOf(rent)).toBe(hits[0])
    }
    expect(rentBandLabel(RENT_BANDS[0])).toBe('Under $300')
    expect(rentBandLabel({ min: 1000, max: 1500 })).toBe('$1,000 to $1,499')
    expect(rentBandLabel(RENT_BANDS[RENT_BANDS.length - 1])).toBe('$2,000 and up')
  })

  it('ageOn counts a birthday not yet reached this year', () => {
    expect(ageOn('1980-09-20', '2026-09-15')).toBe(45)
    expect(ageOn('1980-09-20', '2026-09-20')).toBe(46)
    expect(ageOn('2000-02-29', '2026-02-28')).toBe(25)
  })
})
