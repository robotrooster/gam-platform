/**
 * 10/5 (Nic) — the nightly platform-fee top-up.
 *
 *   "rv 10 and 11 and 15 and 47 are active stays in october. they get billed
 *    for october."
 *
 * A space occupied after the 1st is billed for THAT month on the next
 * weeknight, before the payout run, so the payout nets it. Only the current
 * month — a lease that started Sept 24 and was signed Oct 5 is billed for
 * October, never September ("the extra nights in september balance with the
 * late arrivals for october"). Never lowers a bill, never runs twice for the
 * same space, never charges the $10 floor twice, and never bills a landlord
 * still in onboarding grace.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { processPlatformFeeAccrual, processPlatformFeeTopUp } from './platformFeeAccrual'
import { netAgainstDisbursement } from '../services/landlordGamAccount'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

// The monthly runs: 1:30 am Phoenix on the 1st.
const SEPT_RUN = new Date('2026-09-01T08:30:00Z')
const OCT_RUN = new Date('2026-10-01T08:30:00Z')
const NOV_RUN = new Date('2026-11-01T08:30:00Z')
// The payout cron: 01:00 UTC Tuesday Oct 6 = 6 pm Monday Oct 5 in Phoenix.
const OCT_5_NIGHT = new Date('2026-10-06T01:00:00Z')
const OCT_6_NIGHT = new Date('2026-10-07T01:00:00Z')

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM platform_fee_config`)
  await db.query(`DELETE FROM landlord_platform_fee_overrides`)
  await db.query(
    `INSERT INTO platform_fee_config (rate_per_unit, min_per_connect_account, str_fee_pct, notes)
     VALUES (2.00, 10.00, 0.03, 'Test default')`)
})

interface Park { landlordId: string; ownerUserId: string; propertyId: string; tenantId: string }

async function park(leasedSpaces: number, connect = `acct_${Math.random().toString(36).slice(2)}`): Promise<Park> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`, [landlordId, connect])
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    await c.query(
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer)
       VALUES ($1, 'tenant', 'tenant', 'landlord')`, [propertyId])
    for (let i = 0; i < leasedSpaces; i++) await leasedSpace(c, { landlordId, propertyId, tenantId }, '2026-01-01')
    await c.query('COMMIT')
    return { landlordId, ownerUserId, propertyId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function leasedSpace(
  c: any, p: Pick<Park, 'landlordId' | 'propertyId' | 'tenantId'>, startDate: string, status: 'active' | 'pending' = 'active',
): Promise<string> {
  const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, unitType: 'rv_spot' })
  const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, status, startDate })
  await seedLeaseTenant(c, { leaseId, tenantId: p.tenantId, role: 'primary' })
  return leaseId
}

/** A lease that starts `startDate` and becomes active (signed) now. */
async function addLease(p: Park, startDate: string): Promise<string> {
  const c = await getClient()
  try { return await leasedSpace(c, p, startDate) } finally { c.release() }
}

async function addMonthStay(p: Park, checkIn: string, checkOut: string, status = 'confirmed'): Promise<void> {
  const c = await getClient()
  try {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, unitType: 'rv_spot' })
    await c.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type, total_amount, stay_terms)
       VALUES ($1, $2, 'Month Guest', $3, $4, $5, 'month_to_month', 900, 'stay')`,
      [unitId, p.landlordId, checkIn, checkOut, status])
  } finally { c.release() }
}

async function rowsFor(propertyId: string) {
  return (await db.query<{ month: string; total_billable: number; total_amount: string; connect_min_topup: string }>(
    `SELECT to_char(accrual_month, 'YYYY-MM-DD') AS month, total_billable,
            total_amount::text, connect_min_topup::text
       FROM platform_fee_accruals WHERE property_id = $1 ORDER BY accrual_month`, [propertyId])).rows
}

async function chargesFor(landlordId: string) {
  return (await db.query<{ amount: string; source_type: string; notes: string | null }>(
    `SELECT amount::text, source_type, notes FROM landlord_gam_charges
      WHERE landlord_id = $1 ORDER BY created_at, amount`, [landlordId])).rows
}

const sum = (xs: { amount: string }[]) => Math.round(xs.reduce((n, x) => n + parseFloat(x.amount), 0) * 100) / 100

describe('the nightly top-up bills a space occupied after the 1st, for this month only', () => {
  it('RV 15: a lease that started Sept 24 and was signed Oct 5 is billed for October, not September', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(SEPT_RUN)
    await processPlatformFeeAccrual(OCT_RUN)
    expect((await rowsFor(p.propertyId)).map(r => [r.month, r.total_amount]))
      .toEqual([['2026-09-01', '12.00'], ['2026-10-01', '12.00']])

    await addLease(p, '2026-09-24')
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.monthScanned).toBe('2026-10-01')
    expect(r.errors).toEqual([])
    expect(r.propertiesRaised).toBe(1)
    expect(r.amountCharged).toBe(2)

    const rows = await rowsFor(p.propertyId)
    expect(rows.map(x => [x.month, x.total_billable, x.total_amount])).toEqual([
      ['2026-09-01', 6, '12.00'],                // September untouched
      ['2026-10-01', 7, '14.00'],
    ])

    const topUp = (await db.query<{ amount: string; notes: string; reference_type: string }>(
      `SELECT amount::text, notes, reference_type FROM platform_revenue_ledger
        WHERE property_id = $1 AND reference_type = 'platform_fee_topup'`, [p.propertyId])).rows
    expect(topUp).toEqual([{
      amount: '2.00', reference_type: 'platform_fee_topup',
      notes: 'Platform fee for October 2026 — 1 more occupied space (7 in all)',
    }])
    const charges = await chargesFor(p.landlordId)
    expect(charges.filter(c => c.source_type === 'platform_fee_topup')).toEqual([{
      amount: '2.00', source_type: 'platform_fee_topup',
      notes: 'Platform fee for October 2026 — 1 more occupied space (7 in all)',
    }])
  })

  it('RV 10 and RV 11: month stays that arrive mid-month are more spaces — paid or not', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(OCT_RUN)
    await addMonthStay(p, '2026-10-03', '2026-11-03')
    await addMonthStay(p, '2026-10-04', '2026-12-04')
    // 10/5 (Nic): sold by pay link, the link not paid yet — "We've invoiced
    // for that spot and it's on the schedule. So we are billing Mountain View
    // for it either way."
    await addMonthStay(p, '2026-10-04', '2026-11-04', 'tentative')
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.amountCharged).toBe(6)
    expect((await rowsFor(p.propertyId))[0]).toMatchObject({ total_billable: 9, total_amount: '18.00' })
  })

  it('a tentative month stay on the schedule on the 1st is on the 1st\'s bill', async () => {
    const p = await park(6)
    await addMonthStay(p, '2026-09-20', '2026-11-20', 'tentative')
    await processPlatformFeeAccrual(OCT_RUN)
    expect((await rowsFor(p.propertyId))[0]).toMatchObject({ total_billable: 7, total_amount: '14.00' })
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.amountCharged).toBe(0)                     // counted once
  })

  it('a month stay cancelled before its arrival day adds nothing', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(OCT_RUN)
    await addMonthStay(p, '2026-10-10', '2026-11-10', 'cancelled')
    await db.query(`UPDATE unit_bookings SET cancelled_at = '2026-10-04T12:00:00Z' WHERE landlord_id = $1`, [p.landlordId])
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.amountCharged).toBe(0)
    expect((await rowsFor(p.propertyId))[0]).toMatchObject({ total_billable: 6, total_amount: '12.00' })
  })

  it('running every night, or twice in a night, adds nothing new', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(OCT_RUN)
    await addLease(p, '2026-10-03')
    await processPlatformFeeTopUp(OCT_5_NIGHT)
    const again = await processPlatformFeeTopUp(OCT_5_NIGHT)
    const tomorrow = await processPlatformFeeTopUp(OCT_6_NIGHT)
    expect(again.amountCharged).toBe(0)
    expect(again.propertiesRaised).toBe(0)
    expect(tomorrow.amountCharged).toBe(0)
    expect((await rowsFor(p.propertyId))[0].total_amount).toBe('14.00')
    expect(sum(await chargesFor(p.landlordId))).toBe(14)
  })

  it('someone leaving mid-month never lowers the month', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(OCT_RUN)
    await db.query(
      `UPDATE leases SET status = 'terminated', end_date = '2026-10-03', terminated_at = '2026-10-03T18:00:00Z'
        WHERE id IN (SELECT l.id FROM leases l JOIN units u ON u.id = l.unit_id WHERE u.property_id = $1 LIMIT 2)`,
      [p.propertyId])
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.amountCharged).toBe(0)
    expect((await rowsFor(p.propertyId))[0]).toMatchObject({ total_billable: 6, total_amount: '12.00' })
  })

  it('a departure never hides an arrival: one lease ends, another is signed — the new one is billed', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(OCT_RUN)
    await db.query(
      `UPDATE leases SET status = 'expired', end_date = '2026-10-03', terminated_at = '2026-10-04T09:00:00Z'
        WHERE id = (SELECT l.id FROM leases l JOIN units u ON u.id = l.unit_id WHERE u.property_id = $1 LIMIT 1)`,
      [p.propertyId])
    await db.query(
      `UPDATE leases SET status = 'terminated', terminated_at = '2026-10-04T18:00:00Z'
        WHERE id = (SELECT l.id FROM leases l JOIN units u ON u.id = l.unit_id
                     WHERE u.property_id = $1 AND l.status = 'active' LIMIT 1)`,
      [p.propertyId])
    await addLease(p, '2026-10-05')
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.propertiesRaised).toBe(1)
    expect(r.amountCharged).toBe(2)
    expect((await rowsFor(p.propertyId))[0]).toMatchObject({ total_billable: 7, total_amount: '14.00' })
  })

  it('Nic\'s RV 15: a nightly stay from Sept 24 whose lease is signed Oct 5 — October billed once, through the lease', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(SEPT_RUN)
    await processPlatformFeeAccrual(OCT_RUN)
    const c = await getClient()
    try {
      const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, unitType: 'rv_spot' })
      const { rows: [b] } = await c.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type, total_amount)
         VALUES ($1, $2, 'RV 15', '2026-09-24', '2026-11-24', 'checked_in', 'nightly', 2000) RETURNING id`,
        [unitId, p.landlordId])
      await c.query(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, lease_source, source_booking_id, signed_at)
         VALUES ($1, $2, 600, 'month_to_month', 'active', '2026-09-24', 'booking_draft', $3, '2026-10-05T19:00:00Z')`,
        [unitId, p.landlordId, b.id])
    } finally { c.release() }
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.amountCharged).toBe(2)                     // October, as a space, through the lease
    await processPlatformFeeAccrual(NOV_RUN)
    const rows = await rowsFor(p.propertyId)
    const nov = (await db.query<{ short_stay_nights: number; long_term_unit_count: number }>(
      `SELECT short_stay_nights, long_term_unit_count FROM platform_fee_accruals
        WHERE property_id = $1 AND accrual_month = '2026-11-01'`, [p.propertyId])).rows[0]
    expect(nov.short_stay_nights).toBe(0)               // October's nights are not billed a second time
    expect(nov.long_term_unit_count).toBe(7)
    expect(rows.find(x => x.month === '2026-09-01')).toMatchObject({ total_amount: '12.00' })   // never back-billed
  })

  it('does nothing before this month\'s monthly run has happened', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(SEPT_RUN)          // September billed, October not yet
    await addLease(p, '2026-10-01')
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.monthNotYetBilled).toBe(true)
    expect((await rowsFor(p.propertyId)).map(x => x.month)).toEqual(['2026-09-01'])
  })

  it('01:00 UTC on the 1st is still the last evening of the month before in Phoenix', async () => {
    await park(1)
    await processPlatformFeeAccrual(new Date('2026-10-01T08:30:00Z'))
    const r = await processPlatformFeeTopUp(new Date('2026-11-01T01:00:00Z'))
    expect(r.monthScanned).toBe('2026-10-01')
    expect(r.monthNotYetBilled).toBe(false)
  })
})

describe('the $10 minimum per payout account', () => {
  it('the monthly run now charges the floor it books, so the payout can net it', async () => {
    const p = await park(1)
    await processPlatformFeeAccrual(OCT_RUN)
    const charges = await chargesFor(p.landlordId)
    expect(charges.map(c => [c.source_type, c.amount])).toEqual([
      ['platform_fee_accrual', '2.00'],
      ['platform_fee_min_topup', '8.00'],
    ])
  })

  it('a space added while the account is under the floor adds $0; one that lifts it over adds only the excess', async () => {
    const p = await park(1)
    await processPlatformFeeAccrual(OCT_RUN)            // $2 earned + $8 floor = $10
    await addLease(p, '2026-10-02')
    await addLease(p, '2026-10-02')
    const under = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(under.amountCharged).toBe(0)                 // $6 earned, still under $10
    expect((await rowsFor(p.propertyId))[0]).toMatchObject({
      total_billable: 3, total_amount: '10.00', connect_min_topup: '4.00',
    })
    expect(sum(await chargesFor(p.landlordId))).toBe(10)

    for (let i = 0; i < 3; i++) await addLease(p, '2026-10-06')
    const over = await processPlatformFeeTopUp(OCT_6_NIGHT)
    expect(over.amountCharged).toBe(2)                  // $12 earned: $2 past the floor
    const row = (await rowsFor(p.propertyId))[0]
    expect(row).toMatchObject({ total_billable: 6, total_amount: '12.00' })
    expect(parseFloat(row.connect_min_topup)).toBe(0)
    expect(sum(await chargesFor(p.landlordId))).toBe(12)
    const last = (await chargesFor(p.landlordId)).find(c => c.source_type === 'platform_fee_topup')!
    expect(last.notes).toBe(
      'Platform fee for October 2026 — 3 more occupied spaces (6 in all); $4.00 of it was already covered by the $10.00 monthly minimum')
  })

  it('a second property on the same payout account shares the floor already paid', async () => {
    const p = await park(1, 'acct_shared_floor')
    await processPlatformFeeAccrual(OCT_RUN)            // $10
    // A second property, empty on the 1st, fills mid-month.
    const c = await getClient()
    let propB = ''
    try {
      propB = await seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.ownerUserId, managedByUserId: p.ownerUserId })
      await leasedSpace(c, { ...p, propertyId: propB }, '2026-10-02')
    } finally { c.release() }
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.propertiesCreated).toBe(1)
    expect(r.amountCharged).toBe(0)                     // $4 earned across both, under the $10 already paid
    expect((await rowsFor(propB))[0]).toMatchObject({ total_billable: 1, total_amount: '0.00', connect_min_topup: '-2.00' })
    expect(sum(await chargesFor(p.landlordId))).toBe(10)
  })

  it('a payout account with nothing on the 1st gets its first row and its floor, once', async () => {
    await park(6)                                       // somebody else billed on the 1st
    const p = await park(0)
    await processPlatformFeeAccrual(OCT_RUN)
    expect(await rowsFor(p.propertyId)).toEqual([])
    await addLease(p, '2026-10-02')
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.propertiesCreated).toBe(1)
    expect((await rowsFor(p.propertyId))[0]).toMatchObject({ total_billable: 1, total_amount: '10.00', connect_min_topup: '8.00' })
    // Both charged as top-ups: only the 1st's bill counts as a billing cycle
    // for the portal-lock rule (services/portalLockSweep).
    const charges = await chargesFor(p.landlordId)
    expect(charges.map(x => [x.source_type, x.amount])).toEqual([
      ['platform_fee_topup', '2.00'],
      ['platform_fee_topup', '8.00'],
    ])
    await processPlatformFeeTopUp(OCT_6_NIGHT)
    expect(sum(await chargesFor(p.landlordId))).toBe(10)
  })

  it('a payout account changed mid-month carries what it already paid toward the floor — no second floor', async () => {
    const p = await park(1, 'acct_before')
    await processPlatformFeeAccrual(OCT_RUN)            // $2 earned + $8 floor
    // A second property, empty on the 1st, and a new payout account.
    const c = await getClient()
    try {
      const propB = await seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.ownerUserId, managedByUserId: p.ownerUserId })
      await leasedSpace(c, { ...p, propertyId: propB }, '2026-10-02')
    } finally { c.release() }
    await db.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_after' WHERE id = $1`, [p.landlordId])
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.errors).toEqual([])
    expect(r.amountCharged).toBe(0)                     // $4 earned, under the $10 already paid
    expect(sum(await chargesFor(p.landlordId))).toBe(10)
  })
})

describe('onboarding grace', () => {
  it('a landlord still in grace is never billed by the top-up', async () => {
    await park(6)                                       // opens the month
    const g = await park(0)
    await processPlatformFeeAccrual(OCT_RUN)
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [g.landlordId])
    await addLease(g, '2026-10-02')
    await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(await rowsFor(g.propertyId)).toEqual([])
    expect(await chargesFor(g.landlordId)).toEqual([])

    await db.query(`UPDATE landlords SET billing_starts_at = '2026-11-01' WHERE id = $1`, [g.landlordId])
    await processPlatformFeeTopUp(OCT_6_NIGHT)
    expect(await rowsFor(g.propertyId)).toEqual([])
  })

  it('a landlord who goes live mid-month is billed for that month\'s spaces — never the free month before it', async () => {
    await park(6)                                       // opens the month
    const g = await park(0)
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [g.landlordId])
    const c = await getClient()
    try {
      // September, still in grace: a nightly stay of 20 nights.
      const unitId = await seedUnit(c, { propertyId: g.propertyId, landlordId: g.landlordId, unitType: 'rv_spot' })
      await c.query(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type, total_amount)
         VALUES ($1, $2, 'Grace Guest', '2026-09-05', '2026-09-25', 'checked_out', 'nightly', 800)`,
        [unitId, g.landlordId])
    } finally { c.release() }
    await processPlatformFeeAccrual(OCT_RUN)
    expect(await rowsFor(g.propertyId)).toEqual([])    // still in grace on the 1st
    // Oct 4: the first rent settles (services/billingActivation) — billing from October.
    await db.query(`UPDATE landlords SET billing_starts_at = '2026-10-01' WHERE id = $1`, [g.landlordId])
    await addLease(g, '2026-10-02')
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.propertiesCreated).toBe(1)
    const row = (await db.query<{ long_term_unit_count: number; short_stay_nights: number; total_billable: number }>(
      `SELECT long_term_unit_count, short_stay_nights, total_billable FROM platform_fee_accruals
        WHERE property_id = $1`, [g.propertyId])).rows[0]
    expect(row).toEqual({ long_term_unit_count: 1, short_stay_nights: 0, total_billable: 1 })
  })
})

// 10/5 (Nic): "The onboarding period is until money processes through the
// system... money movement is the end of onboarding." Every door where money
// lands ends the window itself (services/billingActivation); these are the
// backstop in the two runs, for a door the code missed.
describe('money moving through GAM ends onboarding — the backstop in the runs', () => {
  async function inGrace(): Promise<Park> {
    const g = await park(0)
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [g.landlordId])
    return g
  }
  /** A register sale written straight to the table — as if its door had been missed. */
  async function saleAt(g: Park, at: string, o: { method?: string; status?: string; total?: number } = {}): Promise<void> {
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, status, property_id, created_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7::timestamptz)`,
      [g.landlordId, g.ownerUserId, o.method ?? 'cash', o.total ?? 25, o.status ?? 'completed', g.propertyId, at])
  }
  async function nightsIn(g: Park, checkIn: string, checkOut: string): Promise<void> {
    const c = await getClient()
    try {
      const unitId = await seedUnit(c, { propertyId: g.propertyId, landlordId: g.landlordId, unitType: 'rv_spot' })
      await c.query(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type, total_amount)
         VALUES ($1, $2, 'Night Guest', $3, $4, 'checked_out', 'nightly', 800)`,
        [unitId, g.landlordId, checkIn, checkOut])
    } finally { c.release() }
  }
  const startsOf = async (g: Park) => (await db.query<{ s: string | null }>(
    `SELECT to_char(billing_starts_at, 'YYYY-MM-DD') AS s FROM landlords WHERE id = $1`, [g.landlordId])).rows[0].s

  it('the nightly top-up: money this month ends the window and bills this month\'s spaces — never the free month before', async () => {
    await park(6)                                       // opens the month
    const g = await inGrace()
    await nightsIn(g, '2026-09-05', '2026-09-25')       // September, still free
    await processPlatformFeeAccrual(OCT_RUN)
    expect(await rowsFor(g.propertyId)).toEqual([])
    await addLease(g, '2026-10-02')
    await saleAt(g, '2026-10-03T17:00:00Z')             // a utility or register payment on Oct 3
    const r = await processPlatformFeeTopUp(OCT_5_NIGHT)
    expect(r.graceEndedByMoney).toBe(1)
    expect(await startsOf(g)).toBe('2026-10-01')
    expect(r.propertiesCreated).toBe(1)
    const row = (await db.query<{ long_term_unit_count: number; short_stay_nights: number }>(
      `SELECT long_term_unit_count, short_stay_nights FROM platform_fee_accruals WHERE property_id = $1`,
      [g.propertyId])).rows[0]
    expect(row).toEqual({ long_term_unit_count: 1, short_stay_nights: 0 })
    expect(sum(await chargesFor(g.landlordId))).toBe(10) // one space, at the payout account's floor
    // Idempotent: tomorrow ends nothing again and adds nothing.
    const again = await processPlatformFeeTopUp(OCT_6_NIGHT)
    expect(again.graceEndedByMoney).toBe(0)
    expect(sum(await chargesFor(g.landlordId))).toBe(10)
  })

  it('the monthly run: money last month dates the start to last month; nothing before it is billed', async () => {
    const g = await inGrace()
    await nightsIn(g, '2026-08-05', '2026-08-25')       // August: free, never billed
    await nightsIn(g, '2026-09-02', '2026-09-12')       // September: 10 nights
    await saleAt(g, '2026-09-20T17:00:00Z')
    await addLease(g, '2026-09-01')
    const r = await processPlatformFeeAccrual(OCT_RUN)
    expect(r.graceEndedByMoney).toBe(1)
    expect(await startsOf(g)).toBe('2026-09-01')
    const rows = (await db.query<{ month: string; long_term_unit_count: number; short_stay_nights: number }>(
      `SELECT to_char(accrual_month, 'YYYY-MM-DD') AS month, long_term_unit_count, short_stay_nights
         FROM platform_fee_accruals WHERE property_id = $1`, [g.propertyId])).rows
    // October's space, and September's nights (a month past onboarding) — no
    // September or August row, and no August nights.
    expect(rows).toEqual([{ month: '2026-10-01', long_term_unit_count: 1, short_stay_nights: 10 }])
  })

  it('money from before last month is not the runs\' to date; voided, store-account and zero sales never count', async () => {
    const g = await inGrace()
    await saleAt(g, '2026-08-20T17:00:00Z')             // too far back for the backstop
    await saleAt(g, '2026-10-01T15:00:00Z', { status: 'voided' })
    await saleAt(g, '2026-10-01T15:00:00Z', { method: 'charge' })
    const r = await processPlatformFeeAccrual(OCT_RUN)
    expect(r.graceEndedByMoney).toBe(0)
    expect(await startsOf(g)).toBeNull()
  })

  it('a reopened row paid again, a prior-arrangement mark, an imported payment and a bill paid with credit do not end it', async () => {
    await park(1)                                       // opens the month
    const g = await inGrace()
    const c = await getClient()
    try {
      const unitId = await seedUnit(c, { propertyId: g.propertyId, landlordId: g.landlordId })
      let day = 0
      const row = (extra: string, vals: string) => c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at${extra})
         VALUES ($1, $2, $3, 'rent', 500, 'settled', 'RENT', DATE '2026-10-01' + $4::int, '2026-10-02T17:00:00Z'${vals}) RETURNING id`,
        [unitId, g.tenantId, g.landlordId, day++])
      const original = (await row('', '')).rows[0].id
      await c.query(`UPDATE payments SET status = 'returned', settled_at = NULL WHERE id = $1`, [original])
      const rev = (await c.query<{ id: string }>(
        `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
         VALUES ($1, 'card_dispute', 500, 'evt_backstop', '{}'::jsonb) RETURNING id`, [original])).rows[0].id
      await row(', reversal_id', `, '${rev}'`)
      await row(', manual_method', `, 'prior_arrangement'`)
      await row(', import_source', `, 'buildium'`)
      await row(', issued_credit_amount', `, 500`)
    } finally { c.release() }
    expect((await processPlatformFeeAccrual(OCT_RUN)).graceEndedByMoney).toBe(0)
    expect((await processPlatformFeeTopUp(OCT_5_NIGHT)).graceEndedByMoney).toBe(0)
    expect(await startsOf(g)).toBeNull()
  })

  it('a park whose only occupancy is month stays — paid or not — leaves onboarding on the 1st', async () => {
    const g = await inGrace()
    await addMonthStay(g, '2026-09-15', '2026-11-15', 'tentative')
    const r = await processPlatformFeeAccrual(OCT_RUN)
    expect(r.graceEndedByOccupancy).toBe(1)
    expect(await startsOf(g)).toBe('2026-10-01')
    expect((await rowsFor(g.propertyId))[0]).toMatchObject({ month: '2026-10-01', total_billable: 1, total_amount: '10.00' })
  })

  it('a landlord whose onboarding ends on the 1st by occupancy is not billed the free month\'s nights', async () => {
    const g = await inGrace()
    await nightsIn(g, '2026-09-05', '2026-09-25')
    await addLease(g, '2026-09-28')
    await processPlatformFeeAccrual(OCT_RUN)
    expect(await startsOf(g)).toBe('2026-10-01')
    const row = (await db.query<{ long_term_unit_count: number; short_stay_nights: number }>(
      `SELECT long_term_unit_count, short_stay_nights FROM platform_fee_accruals WHERE property_id = $1`,
      [g.propertyId])).rows[0]
    expect(row).toEqual({ long_term_unit_count: 1, short_stay_nights: 0 })
  })
})

describe('the payout nets it', () => {
  it('tonight\'s top-up is owed in time for tonight\'s payout to take it', async () => {
    const p = await park(6)
    await processPlatformFeeAccrual(OCT_RUN)
    await addLease(p, '2026-10-03')
    await processPlatformFeeTopUp(OCT_5_NIGHT)
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const taken = await netAgainstDisbursement(c, p.landlordId, 500)
      await c.query('COMMIT')
      expect(taken).toBe(14)                            // October's $12 and tonight's $2
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  })
})
