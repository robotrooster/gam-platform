/**
 * 10/5 (Nic) — a month stay with no lease is billed like a lease: one occupied
 * space for each month it covers, up front.
 *
 *   "rv 10 and 11 and 15 and 47 are active stays in october. they get billed
 *    for october. arrears is only for short term stays where we dont know the
 *    aggregate total nights. we know all 4 stays will be here the entire month"
 *
 * Month stays (lease_type 'month_to_month' — the register, a pay link, the
 * booking site and the schedule all write it) used to be counted by their
 * nights, in arrears, like a nightly stay. Now they are a space for the month,
 * and never also nights or a revenue share. A stay whose guest chose a lease is
 * counted through the lease once the lease is in force, and carries the space
 * itself until then. Nightly and weekly stays keep nights ÷ 30 in
 * arrears. And a space counts ONCE a month, however many leases, month stays,
 * owner use or utility arrangements it had.
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

interface World { landlordId: string; propertyId: string; siteId: string; site2Id: string; aptId: string; tenantId: string }
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
    const site2Id = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 600 })
    const aptId = await seedUnit(c, { propertyId, landlordId, unitType: 'apartment', rentAmount: 900 })
    const tenantId = await seedTenant(c)
    await c.query('COMMIT')
    w = { landlordId, propertyId, siteId, site2Id, aptId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

async function stay(unitId: string, checkIn: string, checkOut: string, opts: {
  total?: number; leaseType?: string; status?: string; terms?: 'stay' | 'lease' | null; cancelledAt?: string
} = {}): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status, lease_type, total_amount, stay_terms, cancelled_at)
     VALUES ($1, $2, 'Month Guest', 'month@test.dev', $3, $4, $5, $6, $7, $8, $9::timestamptz) RETURNING id`,
    [unitId, w.landlordId, checkIn, checkOut, opts.status ?? 'confirmed', opts.leaseType ?? 'month_to_month',
     opts.total ?? 900, opts.terms === undefined ? 'stay' : opts.terms, opts.cancelledAt ?? null])
  return b.id
}

async function lease(unitId: string, status: 'active' | 'pending' | 'expired' | 'terminated', startDate: string,
                     sourceBookingId: string | null, signedAt: string | null = null,
                     ended: { endDate?: string; terminatedAt?: string } = {}): Promise<void> {
  await db.query(
    `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, lease_source, source_booking_id, signed_at, terminated_at)
     VALUES ($1, $2, 600, 'month_to_month', $3, $4, $8::date, $5, $6, $7::timestamptz, $9::timestamptz)`,
    [unitId, w.landlordId, status, startDate, sourceBookingId ? 'booking_draft' : 'esigned', sourceBookingId, signedAt,
     ended.endDate ?? null, ended.terminatedAt ?? null])
}

/** October's spaces and September's nights — what the Oct 1 run bills. */
async function octoberBill() {
  const c = await db.connect()
  try {
    return await billableUnitsForProperty(c, w.propertyId, '2026-10-01', '2026-09-01', NIGHTS_AGGREGATION_UNIT_TYPES)
  } finally { c.release() }
}

describe('10/5 — the bill counts a month stay as a space, up front', () => {
  it('a month stay with no lease is one space for the month — not its nights', async () => {
    await stay(w.siteId, '2026-09-05', '2026-11-05')
    const b = await octoberBill()
    expect(b.monthStays).toBe(1)
    expect(b.longTerm).toBe(1)
    expect(b.shortStayNights).toBe(0)           // September's 26 nights are NOT billed again in arrears
    expect(b.total).toBe(1)
  })

  it('RV 10 and RV 11 — two month stays here all October are two spaces', async () => {
    await stay(w.siteId, '2026-10-01', '2026-11-01')
    await stay(w.site2Id, '2026-09-15', '2026-11-15')
    const b = await octoberBill()
    expect(b.monthStays).toBe(2)
    expect(b.total).toBe(2)
  })

  it('a month stay that ended in September is not on October\'s bill at all', async () => {
    await stay(w.siteId, '2026-09-05', '2026-10-01')
    const b = await octoberBill()
    expect(b.total).toBe(0)
    expect(b.shortStayNights).toBe(0)
  })

  // 10/5 (Nic), on RV 10 and RV 11 — month stays sold by pay link, not paid
  // yet: "We've invoiced for that spot and it's on the schedule. So we are
  // billing Mountain View for it either way."
  it('RV 10 and RV 11: a month stay on the schedule whose guest has not paid (tentative) is a space all the same', async () => {
    await stay(w.siteId, '2026-10-01', '2026-11-01', { status: 'tentative' })
    await stay(w.site2Id, '2026-09-15', '2026-11-15', { status: 'tentative' })
    const b = await octoberBill()
    expect(b.monthStays).toBe(2)
    expect(b.total).toBe(2)
  })

  // 10/5 (review): a booking-site checkout hold is a guest on the card page,
  // nothing invoiced — counting it would bill the month for a checkout that
  // may be abandoned, and the bill is never lowered after.
  it('a booking-site checkout hold is not on the schedule — in progress or lapsed — until the guest pays', async () => {
    const s = await stay(w.siteId, '2026-10-01', '2026-11-01', { status: 'tentative' })
    await db.query(`UPDATE unit_bookings SET hold_expires_at = now() - INTERVAL '5 minutes' WHERE id = $1`, [s])
    expect((await octoberBill()).total).toBe(0)
    await db.query(`UPDATE unit_bookings SET hold_expires_at = now() + INTERVAL '20 minutes' WHERE id = $1`, [s])
    expect((await octoberBill()).total).toBe(0)
    // Paid: the timer is cleared and the stay is confirmed — a space.
    await db.query(`UPDATE unit_bookings SET hold_expires_at = NULL, status = 'confirmed', deposit_paid_at = now() WHERE id = $1`, [s])
    expect((await octoberBill()).total).toBe(1)
  })

  it('a tentative month stay cancelled before its arrival day is not counted', async () => {
    await stay(w.siteId, '2026-10-10', '2026-11-10', { status: 'cancelled', cancelledAt: '2026-10-02T12:00:00Z' })
    expect((await octoberBill()).total).toBe(0)
  })

  it('checked in and checked out stays count; one cancelled before it arrived does not', async () => {
    await stay(w.siteId, '2026-09-05', '2026-11-05', { status: 'checked_in' })
    await stay(w.site2Id, '2026-10-01', '2026-10-20', { status: 'checked_out' })
    await stay(w.aptId, '2026-10-01', '2026-11-01', { status: 'cancelled', cancelledAt: '2026-09-25T12:00:00Z' })
    expect((await octoberBill()).total).toBe(2)
  })

  it('a month stay cancelled on or after arrival still held the site (S652), so it counts', async () => {
    await stay(w.siteId, '2026-10-12', '2026-11-12', { status: 'cancelled', cancelledAt: '2026-10-13T12:00:00Z' })
    expect((await octoberBill()).monthStays).toBe(1)
  })

  it('a lease and a month stay on one site are one space', async () => {
    await stay(w.siteId, '2026-09-05', '2026-11-05')
    await lease(w.siteId, 'active', '2026-10-10', null)   // the signing packet: no booking id
    const b = await octoberBill()
    expect(b.total).toBe(1)
  })

  it('a stay that chose a lease is counted once — through the lease', async () => {
    const s = await stay(w.siteId, '2026-09-05', '2026-11-05', { terms: 'lease' })
    await lease(w.siteId, 'active', '2026-09-05', s)
    const b = await octoberBill()
    expect(b.monthStays).toBe(0)
    expect(b.longTerm).toBe(1)
    expect(b.total).toBe(1)
  })

  it('a stay whose lease is still waiting on signatures carries the space itself — never nobody', async () => {
    const s = await stay(w.siteId, '2026-09-05', '2026-11-05', { terms: 'lease' })
    await lease(w.siteId, 'pending', '2026-09-05', s)
    expect((await octoberBill()).total).toBe(1)
    await stay(w.site2Id, '2026-09-05', '2026-11-05', { terms: 'lease' })   // chose a lease, none drafted yet
    const b = await octoberBill()
    expect(b.monthStays).toBe(2)
    expect(b.total).toBe(2)
  })

  it('a stay whose lease was thrown away unsigned counts as a stay again', async () => {
    const s = await stay(w.siteId, '2026-09-05', '2026-11-05', { terms: 'lease' })
    await lease(w.siteId, 'terminated', '2026-09-05', s)      // terminated, no terminated_at: discarded paperwork
    expect((await octoberBill()).monthStays).toBe(1)
  })

  it('a month stay on a furnished unit is a space, not a revenue share', async () => {
    await stay(w.aptId, '2026-09-01', '2026-10-01', { total: 1500 })
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    expect(fees.get(w.propertyId)).toBe(10)      // one space, $2, floored — not 3% of $1,500
  })

  it('the stay\'s own utility agreement never adds a second $2 for the space', async () => {
    const s = await stay(w.siteId, '2026-09-05', '2026-10-25')
    await db.query(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, start_date, end_date, booking_id, payer_attested_at)
       VALUES ($1, $2, $3, '2026-09-05', '2026-10-25', $4, NOW())`,
      [w.landlordId, w.siteId, w.tenantId, s])
    const b = await octoberBill()
    expect(b.utilityService).toBe(0)
    expect(b.total).toBe(1)
  })

  it('owner use and a utility arrangement on one space are one space', async () => {
    await db.query(`UPDATE units SET status = 'owner_use' WHERE id = $1`, [w.siteId])
    await db.query(
      `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, start_date, payer_attested_at)
       VALUES ($1, $2, $3, '2026-09-01', NOW())`,
      [w.landlordId, w.siteId, w.tenantId])
    const b = await octoberBill()
    expect(b.ownerOccupied).toBe(1)
    expect(b.utilityService).toBe(0)
    expect(b.total).toBe(1)
  })
})

describe('nightly and weekly stays keep nights ÷ 30, in arrears', () => {
  it('nightly and weekly stays are counted by their nights', async () => {
    await stay(w.siteId, '2026-09-01', '2026-09-08', { total: 300, leaseType: 'weekly' })
    await stay(w.siteId, '2026-09-20', '2026-09-22', { total: 80, leaseType: 'nightly' })
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(9)
    expect(b.total).toBe(1)
  })

  it('M6: a 30+ night stay rung up by the night or week whose lease is active is counted once — by the lease', async () => {
    const byNight = await stay(w.siteId, '2026-09-05', '2026-10-15', { total: 1200, leaseType: 'nightly' })
    // signed in August: the lease was already paying for September up front
    await lease(w.siteId, 'active', '2026-09-05', byNight, '2026-08-20T12:00:00Z')
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(0)
    expect(b.longTerm).toBe(1)
    expect(b.total).toBe(1)
    // someone else's nightly stay on a leased site still counts (S652)
    await stay(w.siteId, '2026-09-20', '2026-09-22', { total: 80, leaseType: 'nightly' })
    expect((await octoberBill()).shortStayNights).toBe(2)
  })

  it('M6: a lease signed partway through the month is billed for that month by the top-up, so that month\'s stay nights are not billed again', async () => {
    const s = await stay(w.siteId, '2026-09-05', '2026-10-15', { total: 1200, leaseType: 'nightly' })
    // chosen at booking, signed on Sept 20: the Sept 20 top-up billed it for September
    await lease(w.siteId, 'active', '2026-09-05', s, '2026-09-20T12:00:00Z')
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(0)
    expect(b.longTerm).toBe(1)           // the lease pays October up front
    expect(b.total).toBe(1)
  })

  it('M6: a lease signed after the month\'s last top-up was billed for nobody\'s month, so the stay\'s nights carry it', async () => {
    const s = await stay(w.siteId, '2026-09-05', '2026-10-15', { total: 1200, leaseType: 'nightly' })
    // Sept 30 2026 is a Wednesday: its 6 pm Phoenix top-up is September's last.
    // Signed at 7 pm Phoenix that evening — after it.
    await lease(w.siteId, 'active', '2026-09-05', s, '2026-10-01T02:00:00Z')
    const b = await octoberBill()
    expect(b.shortStayNights).toBe(26)   // Sept 5 → Oct 1, billed by nobody else
    expect(b.longTerm).toBe(1)           // the lease pays October up front
  })

  it('M6: the same stay on a furnished unit adds no revenue share on top of its lease', async () => {
    const byWeek = await stay(w.aptId, '2026-09-01', '2026-10-13', { total: 2000, leaseType: 'weekly' })
    await lease(w.aptId, 'active', '2026-09-01', byWeek, '2026-08-20T12:00:00Z')
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    expect(fees.get(w.propertyId)).toBe(10)      // one leased unit, $2, floored — no 3% on the stay too
  })
})

describe('a space occupied at any point in the month counts for the month', () => {
  it('a lease that ended or was terminated during the month still counts for it; one thrown away unsigned never does', async () => {
    await lease(w.siteId, 'expired', '2026-03-01', null, null, { endDate: '2026-10-10', terminatedAt: '2026-10-11T09:00:00Z' })
    await lease(w.site2Id, 'terminated', '2026-03-01', null, null, { terminatedAt: '2026-10-03T18:00:00Z' })
    await lease(w.aptId, 'terminated', '2026-10-05', null)    // discarded draft: no terminated_at
    const b = await octoberBill()
    expect(b.longTerm).toBe(2)
    expect(b.total).toBe(2)
  })

  it('a lease that ended before the month does not', async () => {
    await lease(w.siteId, 'expired', '2026-03-01', null, null, { endDate: '2026-09-30', terminatedAt: '2026-09-30T09:00:00Z' })
    await lease(w.site2Id, 'terminated', '2026-10-05', null, null, { terminatedAt: '2026-09-28T18:00:00Z' })  // ended before it began
    expect((await octoberBill()).total).toBe(0)
  })
})

describe('the landlord\'s estimate reads the same rule as the bill', () => {
  it('a bare-site month stay with no lease is a $2 space', async () => {
    await stay(w.siteId, '2026-09-05', '2026-10-05')
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    // One space → $2, floored at the $10 the account pays once money moves.
    expect(fees.get(w.propertyId)).toBe(10)
  })

  it('six month stays are $12 — each a whole space, not a share of their nights', async () => {
    const c = await getClient()
    const units: string[] = []
    try {
      for (let i = 0; i < 6; i++) units.push(await seedUnit(c, { propertyId: w.propertyId, landlordId: w.landlordId, unitType: 'rv_spot' }))
    } finally { c.release() }
    // each only 10 nights of September — by nights that would be 60/30 = 2 spaces
    for (const u of units) await stay(u, '2026-09-20', '2026-09-30')
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    expect(fees.get(w.propertyId)).toBe(12)
    const c2 = await db.connect()
    try {
      const b = await billableUnitsForProperty(c2, w.propertyId, '2026-09-01', '2026-08-01', NIGHTS_AGGREGATION_UNIT_TYPES)
      expect(b.total).toBe(6)                      // the bill agrees
    } finally { c2.release() }
  })

  it('an unpaid (tentative) month stay is in the estimate, as it is on the bill', async () => {
    const c = await getClient()
    const units: string[] = []
    try {
      for (let i = 0; i < 6; i++) units.push(await seedUnit(c, { propertyId: w.propertyId, landlordId: w.landlordId, unitType: 'rv_spot' }))
    } finally { c.release() }
    for (const u of units) await stay(u, '2026-09-01', '2026-10-01', { status: 'tentative' })
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    expect(fees.get(w.propertyId)).toBe(12)      // six spaces at $2, above the floor
  })

  it('a lease and a month stay on one site are one space in the estimate too', async () => {
    await stay(w.aptId, '2026-09-01', '2026-10-01', { total: 1500 })
    await lease(w.aptId, 'active', '2026-09-01', null)
    await lease(w.siteId, 'active', '2026-09-01', null)
    const fees = await platformFeesByProperty(w.landlordId, ['2026-09-01'])
    expect(fees.get(w.propertyId)).toBe(10)      // two spaces, $4, floored — not three
  })
})
