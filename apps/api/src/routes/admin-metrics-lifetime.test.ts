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
 *   Oak (P1): L1 — two tenants and an occupant, three months paid, utilities;
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
    await k.bill({ ...a1, amount: 460, due: '2026-07-01', paid: '2026-07-01', method: 'card' })
    await k.bill({ ...a1, amount: 460, due: '2026-08-01', paid: '2026-08-01', method: 'ach' })
    await k.bill({ ...a1, amount: 460, due: '2026-09-01', paid: '2026-09-01' })
    // October: labor is paying it (work trade, the month still open) — no money billed.
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
    // One "rent billed" on the page: the default rate divides by the same figure.
    expect(m.defaults.rentBilled).toBeCloseTo(m.money.rent.billed, 2)
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

    expect(m.money.platformFees).toEqual({ billed: 72, collected: 48, owed: 24 })
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
    // L1 3 + L2 3 + L3 2 + L4 1 + L5 2 + L6 2 lease-months; L2's October and L7 were
    // voided, and L1's October billed no money (work trade is paying it).
    expect(d.monthsBilled).toBe(13)
    expect(d.rentBilled).toBeCloseTo(6660, 2)
    // Only Sam's household moved out owing: August, and September — paid on 9/20, after
    // the move-out, which does not take it off. Kim went straight on to another
    // lease; Ray renewed; the never-moved-in lease owes nothing.
    expect(d.householdsOwing).toBe(1)
    expect(d.monthsUnpaid).toBeCloseTo(2, 4)
    expect(d.dollarsUnpaid).toBeCloseTo(920, 2)
    expect(d.rate).toBeCloseTo(2 / 13, 6)
    expect(d.dollarRate).toBeCloseTo(920 / 6660, 6)

    const band = Object.fromEntries(d.byRentRange.map((b: any) => [b.label, b]))
    expect(Object.keys(band)).toEqual(['$300 to $399', '$400 to $499', '$800 to $999'])
    expect(band['$400 to $499']).toMatchObject({ leases: 2, monthsBilled: 6, rentBilled: 2760, householdsOwing: 1, dollarsUnpaid: 920 })
    expect(band['$400 to $499'].rate).toBeCloseTo(2 / 6, 6)
    expect(band['$300 to $399']).toMatchObject({ leases: 2, monthsBilled: 4, householdsOwing: 0, monthsUnpaid: 0 })
    expect(band['$800 to $999']).toMatchObject({ leases: 2, monthsBilled: 3, householdsOwing: 0 })
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
