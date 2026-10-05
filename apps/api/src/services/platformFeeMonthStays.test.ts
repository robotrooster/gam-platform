/**
 * 10/5 (Nic, R12) — a month stay with no lease pays GAM's platform fee like
 * any stay.
 *
 * Month stays (lease_type 'month_to_month' — the register, a pay link, the
 * booking site and the schedule all write it) used to pay GAM only through the
 * lease drafted for them automatically at 30 nights. No lease is drafted
 * automatically any more: a guest who chooses a stay holds the site through
 * what they paid, and that stay counts by its nights on a bare site and by the
 * revenue share on a furnished one. A month stay a lease covers is counted by
 * the lease, once — and the utility agreement a no-lease stay pays its
 * utilities through (R11) never adds a second $2 for the same space.
 *
 * Both the bill (services/billableUnits, jobs/platformFeeAccrual) and the
 * landlord's estimate (services/platformFee) read one rule.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { NIGHTS_AGGREGATION_UNIT_TYPES } from '@gam/shared'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { billableUnitsForProperty } from './billableUnits'
import { platformFeesByProperty } from './platformFee'

interface World { landlordId: string; propertyId: string; siteId: string; aptId: string; tenantId: string }
let w: World

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM platform_fee_config`)
  await db.query(`DELETE FROM landlord_platform_fee_overrides`)
  await db.query(
    `INSERT INTO platform_fee_config (rate_per_unit, min_per_connect_account, str_fee_pct, notes)
     VALUES (2.00, 10.00, 0.03, 'Test default')`)
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET created_at = '2026-08-01' WHERE id = $1`, [propertyId])
    await c.query(`UPDATE landlords SET billing_starts_at = '2026-08-01' WHERE id = $1`, [landlordId])
    const siteId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 600 })
    const aptId = await seedUnit(c, { propertyId, landlordId, unitType: 'apartment', rentAmount: 900 })
    const tenantId = await seedTenant(c)
    await c.query('COMMIT')
    w = { landlordId, propertyId, siteId, aptId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

async function monthStay(unitId: string, checkIn: string, checkOut: string, total = 900, leaseType = 'month_to_month'): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status, lease_type, total_amount, stay_terms)
     VALUES ($1, $2, 'Month Guest', 'month@test.dev', $3, $4, 'confirmed', $5, $6, 'stay') RETURNING id`,
    [unitId, w.landlordId, checkIn, checkOut, leaseType, total])
  return b.id
}

async function lease(unitId: string, status: 'active' | 'pending', startDate: string, sourceBookingId: string | null,
                     signedAt: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, lease_source, source_booking_id, signed_at)
     VALUES ($1, $2, 600, 'month_to_month', $3, $4, NULL, $5, $6, $7::timestamptz)`,
    [unitId, w.landlordId, status, startDate, sourceBookingId ? 'booking_draft' : 'esigned', sourceBookingId, signedAt])
}

/** September's nights (billed in arrears on Oct 1) and October's spaces. */
async function octoberBill() {
  const c = await db.connect()
  try {
    return await billableUnitsForProperty(c, w.propertyId, '2026-10-01', '2026-09-01', NIGHTS_AGGREGATION_UNIT_TYPES)
  } finally { c.release() }
}

describe('R12 — the bill counts a month stay with no lease', () => {
  it('a month stay on a bare site counts its nights, exactly like a nightly one', async () => {
    await monthStay(w.siteId, '2026-09-05', '2026-10-05')
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(26)          // Sep 5 through Sep 30
    expect(b.shortStayEquivalent).toBe(1)
    expect(b.total).toBe(1)
  })

  it('a month stay its own lease covers is counted once — by the lease', async () => {
    const stay = await monthStay(w.siteId, '2026-09-05', '2026-11-05')
    await lease(w.siteId, 'active', '2026-09-05', stay)
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(0)
    expect(b.longTerm).toBe(1)
    expect(b.total).toBe(1)
  })

  it('a lease on the same site drafted without the stay\'s id (the signing packet) covers it too', async () => {
    await monthStay(w.siteId, '2026-09-05', '2026-11-05')
    await lease(w.siteId, 'active', '2026-09-10', null)
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(0)
    expect(b.total).toBe(1)
  })

  it('a lease still waiting for signatures counts nothing, so the stay carries the space', async () => {
    const stay = await monthStay(w.siteId, '2026-09-05', '2026-10-05')
    await lease(w.siteId, 'pending', '2026-09-05', stay)
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(26)
    expect(b.longTerm).toBe(0)
  })

  it('nightly and weekly stays are counted as before', async () => {
    await monthStay(w.siteId, '2026-09-01', '2026-09-08', 300, 'weekly')
    await monthStay(w.siteId, '2026-09-20', '2026-09-22', 80, 'nightly')
    expect((await octoberBill()).shortStayNights).toBe(9)
  })

  it('M6: a 30+ night stay rung up by the night or week whose lease is active is counted once — by the lease', async () => {
    const byNight = await monthStay(w.siteId, '2026-09-05', '2026-10-15', 1200, 'nightly')
    // signed in August: the lease was already paying for September up front
    await lease(w.siteId, 'active', '2026-09-05', byNight, '2026-08-20T12:00:00Z')
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(0)
    expect(b.longTerm).toBe(1)
    expect(b.total).toBe(1)
    // someone else's nightly stay on a leased site still counts (S652)
    await monthStay(w.siteId, '2026-09-20', '2026-09-22', 80, 'nightly')
    expect((await octoberBill()).shortStayNights).toBe(2)
  })

  it('M6: a lease signed partway through the month first pays for the next month, so that month\'s stay nights still count', async () => {
    const stay = await monthStay(w.siteId, '2026-09-05', '2026-10-15', 1200, 'nightly')
    // chosen at booking, signed on Sept 20: the Sept 1 run saw it pending
    await lease(w.siteId, 'active', '2026-09-05', stay, '2026-09-20T12:00:00Z')
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(26)   // Sept 5 → Oct 1, billed by nobody else
    expect(b.longTerm).toBe(1)           // the lease pays October up front
  })

  it('M6: the same stay on a furnished unit adds no revenue share on top of its lease', async () => {
    const byWeek = await monthStay(w.aptId, '2026-09-01', '2026-10-13', 2000, 'weekly')
    await lease(w.aptId, 'active', '2026-09-01', byWeek, '2026-08-20T12:00:00Z')
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    expect(fees.get(w.propertyId)).toBe(10)      // one leased unit, $2, floored — no 3% on the stay too
  })

  it('the stay\'s own utility agreement never adds a second $2 for the space', async () => {
    const stay = await monthStay(w.siteId, '2026-09-05', '2026-10-25')
    await db.query(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, start_date, end_date, booking_id, payer_attested_at)
       VALUES ($1, $2, $3, '2026-09-05', '2026-10-25', $4, NOW())`,
      [w.landlordId, w.siteId, w.tenantId, stay])
    const b = await octoberBill()
    expect(b.utilityService).toBe(0)
    expect(b.total).toBe(1)                      // the stay's nights, once
  })
})

describe('R12 — the landlord\'s estimate reads the same rule', () => {
  it('a bare-site month stay with no lease is no longer free', async () => {
    await monthStay(w.siteId, '2026-09-05', '2026-10-05')
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    // 26 nights → one space → $2, floored at the $10 the account pays once money moves.
    expect(fees.get(w.propertyId)).toBe(10)
  })

  it('a furnished month stay with no lease bills the revenue share, pro-rated to the month', async () => {
    await monthStay(w.aptId, '2026-09-01', '2026-10-01', 1500)
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    expect(fees.get(w.propertyId)).toBe(45)      // 3% of $1,500
  })

  it('a month stay its lease covers adds nothing on top of the lease', async () => {
    const stay = await monthStay(w.aptId, '2026-09-01', '2026-10-01', 1500)
    await lease(w.aptId, 'active', '2026-09-01', stay)
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    expect(fees.get(w.propertyId)).toBe(10)      // one leased unit, $2, floored
  })
})
