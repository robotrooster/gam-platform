/**
 * 10/3 final sweep — utilities (scratchpad investigate1003 "utility-audit").
 *
 *   1. A meter that moved on a space with nobody to bill tells the landlord
 *      (Mountain View RV 05/27/30/16, Oak Park RV 22) instead of the usage
 *      quietly vanishing as "skipped".
 *   2. A property that ESTIMATES a meter that is not reading also marks it
 *      broken and tells the landlord (Mountain View RV 07/08/40/48 were
 *      estimated month after month and never reported).
 *   3. A meter that did not move on a lease that is hibernating when the bills
 *      run is not estimated and not flagged (Mountain View RV 50/51 were billed
 *      a $22.47 estimate while away) — and stays that way after the lease
 *      wakes up.
 *   4. The occupancy check finds a lease on a space whose status still says
 *      vacant (the S642 fix looked for leases on no unit at all).
 *   5. ...and counts only somebody who lived there ACROSS the read span: a
 *      move-out read then an empty space, a lease ended early in the cycle, a
 *      lease terminated before it started (Mountain View RV 09), an unsigned
 *      draft thrown away (RV 01) and a household that arrived after the cycle
 *      are not a broken meter — no flag, no estimate, no notice.
 *   6. A cycle written off as paused stays that way once the lease is resumed,
 *      and correcting its read prices it again.
 *   7. A bill goes only to a lease in force on the cycle's first day (or its
 *      own move-out read), never to one that never took effect.
 *
 * Third pass:
 *   8. A read span that is no evidence of a broken meter: two reads on the same
 *      day (a move-out or opening read, then the cycle read — Oak Park RV 24's
 *      new meter), and a span that starts at a move-out read for a lease that
 *      does not run past the cycle read. At the run and at lease signing.
 *   9. A move-out read bills the household it closes out — never one gone
 *      before the span it measures began.
 *  10. An invited existing resident (no lease yet) is somebody living there;
 *      a $0.00 share held for them does not stop signing from flagging it.
 *  11. A $0.00 final cycle with nothing owed is closed out, never left open for
 *      the deposit return to list.
 *  12. A lease paused and resumed before any run priced the cycle is still a
 *      paused cycle (read from the lease's change journal).
 *
 * Fourth pass:
 *  13. An existing-resident invite counts as somebody living there only while
 *      the property's onboarding window is open — the rule a share is held by.
 *  14. A move-out read bills the newest household on the space before the
 *      read's day: never one whose last day was the read before (A ended 8/31,
 *      the August read day), never one arriving the day of the read.
 *  15. A pause explains a flat meter only if it was still on at the cycle read
 *      — not a two-day pause early in the span, not one that began after it.
 *  16. Correcting a read: the paused-cycle record, and nothing else, counts as
 *      never issued (utilityReview).
 *
 * Fifth pass:
 *  17. A move-out read entered late bills the household that LEFT, not the one
 *      that arrived after it (S548): a household counts only if it was on the
 *      space after the read before, and one that has left by the read's day
 *      comes ahead of one still there. A renewal is not leaving.
 *
 * Sixth pass:
 *  18. A move-out read whose household the caller knows (a resident moving to
 *      another space) bills that household, ahead of one that left earlier
 *      without a read — but only a household the move-out rule could bill.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { generateBillsForMeter, releaseSuspendedChargesForLease, ensureBillsForUnit, billMoveOutRead } from './utilityBilling'
import { dropUnissuedBillsFrom, billReview } from './utilityReview'
import { PAUSED_CYCLE_NOTE } from './utilityPausedCycle'

beforeEach(async () => { await cleanupAllSchema() })

const SEPT = '2026-09-01'
const sept = new Date(SEPT + 'T00:00:00Z')

async function park(opts: { estimates: boolean }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name='Mountain View RV Ranch', timezone='America/Phoenix', estimates_stuck_meters=$2 WHERE id=$1`,
      [propertyId, opts.estimates])
    await c.query('COMMIT')
    return { ...ll, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Park = Awaited<ReturnType<typeof park>>

/** A space with its own electric submeter: reads at 8/31 (start) and 9/30 (the September read). */
async function space(p: Park, o: {
  unit: string; start: number; end: number; lease?: boolean; status?: string
  existingTenancy?: boolean; leaseStart?: string
}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
    let leaseId: string | null = null
    let tenantId: string | null = null
    if (o.lease) {
      leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: o.leaseStart ?? '2026-01-01' })
      tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId })
      if (o.existingTenancy) await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
    }
    // Set AFTER the lease: the status a space shows can lag its lease.
    await c.query(`UPDATE units SET unit_number=$2, unit_type='rv_spot', status=$3 WHERE id=$1`,
      [unitId, o.unit, o.status ?? (o.lease ? 'active' : 'vacant')])
    const m = await c.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, base_fee, digits)
       VALUES ($1,'electric',$2,'submeter',0.21,0,6) RETURNING id`, [p.propertyId, `${o.unit} electric`])
    const meterId = m.rows[0].id
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, unitId])
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1,'2026-08-31',$2,'2026-08-01','monthly_cycle',$4), ($1,'2026-09-30',$3,$5,'monthly_cycle',$4)`,
      [meterId, o.start, o.end, p.userId, SEPT])
    await c.query('COMMIT')
    return { unitId, meterId, leaseId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const notices = (type: string) => db.query<{ title: string; body: string; data: any }>(
  `SELECT title, body, data FROM notifications WHERE type = $1 ORDER BY created_at`, [type]).then(r => r.rows)
const billsFor = (meterId: string) => db.query<any>(
  `SELECT usage_amount::float AS usage, charge_amount::float AS charge, allocation_method, status, notes
     FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = $2`, [meterId, SEPT]).then(r => r.rows)
const outOfService = (meterId: string) => db.query<{ out_of_service: boolean }>(
  `SELECT out_of_service FROM utility_meters WHERE id = $1`, [meterId]).then(r => r.rows[0].out_of_service)
const allBills = (meterId: string) => db.query<any>(
  `SELECT to_char(billing_cycle_month, 'YYYY-MM-DD') AS cycle, usage_amount::float AS usage, charge_amount::float AS charge,
          allocation_method, status, lease_id, notes
     FROM utility_bills WHERE meter_id = $1 ORDER BY billing_cycle_month`, [meterId]).then(r => r.rows)
/** One more read on a meter; returns its id. */
const read = (meterId: string, date: string, value: number, cycle: string, reason = 'monthly_cycle') =>
  db.query<{ id: string }>(
    `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,(SELECT user_id FROM landlords LIMIT 1)) RETURNING id`,
    [meterId, date, value, cycle, reason]).then(r => r.rows[0].id)
const OCT = '2026-10-01'
const oct = new Date(OCT + 'T00:00:00Z')
/** Nothing says this meter is broken: not marked, nothing estimated, nobody told. */
async function notBroken(meterId: string) {
  expect(await outOfService(meterId)).toBe(false)
  expect(await notices('utility_meter_broken')).toHaveLength(0)
  expect((await allBills(meterId)).filter((b: any) => b.allocation_method === 'comparable_low')).toHaveLength(0)
  expect(await notices('utility_usage_unbilled')).toHaveLength(0)
}

describe('a meter that moved with nobody to bill', () => {
  it('tells the landlord what was used and what to do — once', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 05', start: 15692, end: 16055 })   // 363 kWh, nobody set up
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(0)
    expect(await billsFor(s.meterId)).toHaveLength(0)
    const n = await notices('utility_usage_unbilled')
    expect(n).toHaveLength(1)
    expect(n[0].title).toBe('Electric used on RV 05 — nobody to bill')
    expect(n[0].body).toContain('moved 363 kWh ($76.23) for Sep 2026')
    expect(n[0].body).toContain('nobody is set up on that space')
    expect(n[0].body).toContain('Billed outside GAM — start fresh here')
    expect(n[0].data).toMatchObject({ meterId: s.meterId, cycle: SEPT, usage: 363, amount: 76.23, why: 'nobody' })
    // The bill run is re-runnable; the landlord is told once.
    await generateBillsForMeter(s.meterId, sept)
    expect(await notices('utility_usage_unbilled')).toHaveLength(1)
  })

  it('what it tells the landlord to do works: set up as an existing resident, the usage goes on their bill', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 27', start: 17506, end: 17896 })   // 390 kWh
    await generateBillsForMeter(s.meterId, sept)
    expect((await notices('utility_usage_unbilled'))[0].body)
      .toContain('set them up as an existing resident of RV 27 in time for a bill due by Nov 30, 2026; this usage goes on that bill')
    const c = await db.connect()
    try {
      const leaseId = await seedLease(c, { unitId: s.unitId, landlordId: p.landlordId, startDate: '2026-10-02' })
      await seedLeaseTenant(c, { leaseId, tenantId: await seedTenant(c) })
      await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
    } finally { c.release() }
    // The nightly bill run catches up a meter's last two cycles for the space.
    expect(await ensureBillsForUnit(s.unitId, '2026-11-01')).toBe(1)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ usage: 390, charge: 81.9, status: 'unbilled' })
  })

  it('the deadline it names is real: a first bill due after Nov 30 no longer reaches September', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 30', start: 4000, end: 4300, lease: false })
    await generateBillsForMeter(s.meterId, sept)
    const c = await db.connect()
    try {
      const leaseId = await seedLease(c, { unitId: s.unitId, landlordId: p.landlordId, startDate: '2026-11-15' })
      await seedLeaseTenant(c, { leaseId, tenantId: await seedTenant(c) })
      await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
    } finally { c.release() }
    expect(await ensureBillsForUnit(s.unitId, '2026-12-01')).toBe(0)
    expect(await billsFor(s.meterId)).toHaveLength(0)
    expect(await ensureBillsForUnit(s.unitId, '2026-11-30')).toBe(1)
  })

  it('says nothing for a space guests stayed on — a reservation has no lease by design', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 16', start: 9000, end: 9180, lease: false })
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, status, source)
       VALUES ($1,$2,'nightly','2026-09-12','2026-09-15',3,'Overnight Guest','checked_out','direct')`,
      [s.unitId, p.landlordId])
    await generateBillsForMeter(s.meterId, sept)
    expect(await notices('utility_usage_unbilled')).toHaveLength(0)
  })

  it('a cancelled reservation or a no-show does not explain the usage — the landlord is told', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 17', start: 9000, end: 9180, lease: false })
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, status, source, cancelled_at)
       VALUES ($1,$2,'nightly','2026-09-12','2026-09-15',3,'Called Off','cancelled','direct',now()),
              ($1,$2,'nightly','2026-09-20','2026-09-22',2,'Never Came','no_show','direct',NULL)`,
      [s.unitId, p.landlordId])
    await generateBillsForMeter(s.meterId, sept)
    expect(await notices('utility_usage_unbilled')).toHaveLength(1)
  })

  it('a reservation outside the read span does not explain it either', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 18', start: 9000, end: 9180, lease: false })
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, status, source)
       VALUES ($1,$2,'nightly','2026-10-03','2026-10-05',2,'Later Guest','confirmed','direct')`,
      [s.unitId, p.landlordId])
    await generateBillsForMeter(s.meterId, sept)
    expect(await notices('utility_usage_unbilled')).toHaveLength(1)
  })

  it('says nothing when the landlord already closed it out as billed outside GAM', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 37', start: 63476, end: 64006 })
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1,'2026-09-30',64006,'2026-10-01','billed_off_platform',$2)`, [s.meterId, p.userId])
    await generateBillsForMeter(s.meterId, sept)
    expect(await notices('utility_usage_unbilled')).toHaveLength(0)
  })

  it('says nothing for an empty space whose meter did not move', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 31', start: 700, end: 700 })
    await generateBillsForMeter(s.meterId, sept)
    expect(await notices('utility_usage_unbilled')).toHaveLength(0)
  })

  it('a space that is billed is not reported', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 20', start: 1000, end: 1300, lease: true })
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(1)
    expect(await notices('utility_usage_unbilled')).toHaveLength(0)
  })

  it('usage on a lease paused for the whole cycle is not billed, but the landlord is told', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 50', start: 30546, end: 30646, lease: true })
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-08-15' WHERE id = $1`, [s.leaseId])
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(0)
    const n = await notices('utility_usage_unbilled')
    expect(n).toHaveLength(1)
    expect(n[0].data.why).toBe('paused')
    expect(n[0].body).toContain('while the lease there was paused (hibernating)')
  })
})

describe('a property that estimates a meter that is not reading', () => {
  it('bills the estimate AND marks the meter broken, telling the landlord what it billed — once', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })   // a real household, 387 kWh
    const s = await space(p, { unit: 'RV 07', start: 206, end: 206, lease: true })
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(1)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ usage: 387, allocation_method: 'comparable_low' })
    expect(await outOfService(s.meterId)).toBe(true)
    const n = await notices('utility_meter_broken')
    expect(n).toHaveLength(1)
    expect(n[0].title).toBe('Electric meter not reading — RV 07 at Mountain View RV Ranch')
    expect(n[0].body).toContain('This property bills an estimate while a meter is broken: 387 kWh')
    expect(n[0].body).toContain('mark it repaired on the Utilities page with its new reading')
    // Next month it is still estimated — it is marked broken now — and not reported twice.
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1,'2026-10-31',206,'2026-10-01','monthly_cycle',$2)`, [s.meterId, p.userId])
    await generateBillsForMeter(s.meterId, new Date('2026-10-01T00:00:00Z'))
    expect(await notices('utility_meter_broken')).toHaveLength(1)
  })

  it('with nothing to estimate from: marked broken, and the landlord is told nothing was billed', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 48', start: 49083, end: 49083, lease: true })
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(0)
    expect(await outOfService(s.meterId)).toBe(true)
    const n = await notices('utility_meter_broken')
    expect(n).toHaveLength(1)
    expect(n[0].body).toContain('no similar occupied space had a reading to estimate from, so nothing is billed')
  })

  it('a property that does not estimate keeps its own words (nothing billed until repaired)', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, { unit: 'RV 20', start: 24590, end: 24590, lease: true })
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    const n = await notices('utility_meter_broken')
    expect(n[0].body).toContain('no electric is being billed for it')
  })

  it('at lease signing too: an onboarding resident\'s stuck meter is estimated, marked broken and reported', async () => {
    const p = await park({ estimates: true })
    // The neighbor's September read is what the estimate is drawn from.
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const c = await db.connect()
    let unitId = '', meterId = '', leaseId = '', tenantId = ''
    try {
      await c.query('BEGIN')
      unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
      await c.query(`UPDATE units SET unit_number='RV 40', unit_type='rv_spot' WHERE id=$1`, [unitId])
      leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: '2026-10-02' })
      tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
      meterId = (await c.query<{ id: string }>(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, base_fee, digits)
         VALUES ($1,'electric','RV 40 electric','submeter',0.21,0,6) RETURNING id`, [p.propertyId])).rows[0].id
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, unitId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
         VALUES ($1,'2026-09-01',28999,$3,'baseline',$2), ($1,'2026-09-30',28999,$3,'monthly_cycle',$2)`,
        [meterId, p.userId, SEPT])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await releaseSuspendedChargesForLease({ unitId, leaseId, tenantId, landlordId: p.landlordId })
    expect(await outOfService(meterId)).toBe(true)
    const n = await notices('utility_meter_broken')
    expect(n).toHaveLength(1)
    expect(n[0].body).toContain('This property bills an estimate while a meter is broken: 387 kWh')
  })
})

describe('a meter that did not move on a lease that is paused', () => {
  it('is not estimated or flagged — the cycle is written down as nothing used', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 50', start: 30546, end: 30546, lease: true })
    // Asleep from 9/19 — part of September, and still asleep when the bills run.
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-09-19' WHERE id = $1`, [s.leaseId])
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(0)
    expect(r.reason).toBe('lease paused (hibernating) and the meter did not move — nothing to bill')
    const bills = await billsFor(s.meterId)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ usage: 0, charge: 0, status: 'void', allocation_method: 'submeter' })
    expect(bills[0].notes).toContain('the lease was paused (hibernating) and the meter did not move')
    expect(await outOfService(s.meterId)).toBe(false)
    expect(await notices('utility_meter_broken')).toHaveLength(0)
  })

  it('stays that way after the household is back and the bills run again', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 51', start: 71881, end: 71881, lease: true })
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-08-20' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    // Resumed: the flag and the date are cleared (routes/leases /resume).
    await db.query(`UPDATE leases SET is_hibernating = FALSE, hibernated_at = NULL WHERE id = $1`, [s.leaseId])
    const again = await generateBillsForMeter(s.meterId, sept)
    expect(again.billsCreated).toBe(0)
    const bills = await billsFor(s.meterId)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ status: 'void', charge: 0 })
    // The meter WORKS: not marked broken, and nobody told it read twice while occupied.
    expect(await outOfService(s.meterId)).toBe(false)
    expect(await notices('utility_meter_broken')).toHaveLength(0)
    // October, the household back and using power: the real reading bills, not an estimate.
    await read(s.meterId, '2026-10-31', 72181, OCT)
    const neighbor = (await db.query<{ id: string }>(`SELECT id FROM utility_meters WHERE label = 'RV 28 electric'`)).rows[0].id
    await read(neighbor, '2026-10-31', 52786, OCT)
    const octRun = await generateBillsForMeter(s.meterId, oct)
    expect(octRun.billsCreated).toBe(1)
    expect((await allBills(s.meterId)).find((b: any) => b.cycle === OCT))
      .toMatchObject({ usage: 300, charge: 63, allocation_method: 'submeter', status: 'unbilled' })
  })

  it('the same holds when the cycle runs again through the review page and through ensureBillsForUnit', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, { unit: 'RV 53', start: 800, end: 800, lease: true })
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-09-25' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    await db.query(`UPDATE leases SET is_hibernating = FALSE, hibernated_at = NULL WHERE id = $1`, [s.leaseId])
    const runId = (await db.query<{ id: string }>(
      `INSERT INTO utility_reading_runs (property_id, landlord_id, billing_cycle_month, opened_on, status)
       VALUES ($1,$2,$3,'2026-09-30','open') RETURNING id`, [p.propertyId, p.landlordId, SEPT])).rows[0].id
    const review = await billReview(runId)
    // The record of a paused cycle is not an issued bill: its read can still be fixed.
    expect(review.lines.find((l: any) => l.meterId === s.meterId)).toMatchObject({ charge: 0, issued: false })
    await ensureBillsForUnit(s.unitId, '2026-10-01')
    expect(await outOfService(s.meterId)).toBe(false)
    expect(await notices('utility_meter_broken')).toHaveLength(0)
  })

  it('correcting the read of a paused cycle is allowed, and prices that cycle again', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 50', start: 30546, end: 30546, lease: true })
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-09-19' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    // Nothing from this cycle was issued — the read, and the one before it, can be fixed.
    expect(await dropUnissuedBillsFrom(s.meterId, SEPT)).toBe(true)
    expect(await dropUnissuedBillsFrom(s.meterId, '2026-08-01')).toBe(true)
    // The reader got it wrong: the meter really read 30646.
    await db.query(
      `UPDATE utility_meter_readings SET reading_value = 30646
        WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'`, [s.meterId, SEPT])
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(1)
    const bills = await billsFor(s.meterId)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ usage: 100, charge: 21, status: 'unbilled', allocation_method: 'submeter' })
    expect(bills[0].notes).not.toBe(PAUSED_CYCLE_NOTE)
    expect(await outOfService(s.meterId)).toBe(false)
  })

  it('a read corrected to the same flat number after the household is back keeps the cycle written off', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 54', start: 600, end: 600, lease: true })
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-09-10' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    await db.query(`UPDATE leases SET is_hibernating = FALSE, hibernated_at = NULL WHERE id = $1`, [s.leaseId])
    expect(await dropUnissuedBillsFrom(s.meterId, SEPT)).toBe(true)
    await db.query(
      `UPDATE utility_meter_readings SET reading_date = '2026-09-29'
        WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'`, [s.meterId, SEPT])
    await generateBillsForMeter(s.meterId, sept)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ status: 'void', charge: 0, notes: PAUSED_CYCLE_NOTE })
    expect(await outOfService(s.meterId)).toBe(false)
    expect(await notices('utility_meter_broken')).toHaveLength(0)
  })

  it('a lease that went to sleep AFTER the cycle is billed as usual — it was there', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 52', start: 5000, end: 5000, lease: true })
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-10-05' WHERE id = $1`, [s.leaseId])
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(1)
    expect((await billsFor(s.meterId))[0].allocation_method).toBe('comparable_low')
  })
})

describe('the occupancy check reads the lease, not just the status', () => {
  it('a stuck meter on a space whose status still says vacant, with a lease covering the cycle, is estimated', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 41', start: 900, end: 900, lease: true, status: 'vacant' })
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(1)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ allocation_method: 'comparable_low', usage: 387 })
  })
})

// ── 10/3 (final sweep, second pass): somebody lived there ACROSS the read span ──
//
// Looking the lease up by the unit's id switched on an occupancy check that had
// never run: any lease that touched the cycle by even a day — ended, terminated,
// pending — made a meter that did not move "broken". These spaces were empty
// for the read span, and their meters work.
describe('a working meter on a space nobody lived on across the read span', () => {
  /** A space with its own meter and a lease that is now over; the neighbor RV 28 used 387 kWh (an estimate would be drawn from it). */
  async function departed(p: Park, o: { unit: string; start: number; end: number; leaseStart?: string; existing?: boolean }) {
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    return space(p, { unit: o.unit, start: o.start, end: o.end, lease: true, status: 'vacant',
                      leaseStart: o.leaseStart, existingTenancy: o.existing })
  }

  it.each([true, false])('a move-out read, then an empty space whose meter does not move (estimates %s)', async (estimates) => {
    const p = await park({ estimates })
    const s = await departed(p, { unit: 'RV 12', start: 1000, end: 1080 })
    // Out on 9/5 with a move-out read; the space sits empty after that.
    await db.query(`UPDATE leases SET status = 'terminated', end_date = '2026-09-05',
                      terminated_at = '2026-09-05 12:00:00-07' WHERE id = $1`, [s.leaseId])
    const moveOutRead = await read(s.meterId, '2026-09-05', 1080, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, moveOutRead)).billed).toBe(true)
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
    // October: still empty, still 1080.
    await read(s.meterId, '2026-10-31', 1080, OCT)
    await read((await db.query<{ id: string }>(`SELECT id FROM utility_meters WHERE label = 'RV 28 electric'`)).rows[0].id,
      '2026-10-31', 52786, OCT)
    await generateBillsForMeter(s.meterId, oct)
    await notBroken(s.meterId)
    // The household that left is billed its move-out read and nothing after it.
    expect((await allBills(s.meterId)).map((b: any) => [b.cycle, b.usage])).toEqual([[SEPT, 80]])
    expect(await notices('final_utility_invoice')).toHaveLength(2)   // landlord + tenant, the move-out bill only
  })

  it('a lease that ended early in the cycle, no move-out read, meter flat: no estimate to the person who left', async () => {
    const p = await park({ estimates: true })
    const s = await departed(p, { unit: 'RV 13', start: 2000, end: 2000 })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-02' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
    // Their September bill reads what the meter says: nothing used, nothing owed —
    // and a $0.00 bill is not sent to them as a "final utility bill".
    expect(await allBills(s.meterId)).toMatchObject([{ cycle: SEPT, usage: 0, charge: 0, allocation_method: 'submeter' }])
    expect(await notices('final_utility_invoice')).toHaveLength(0)
  })

  it('a lease terminated before it started (Mountain View RV 09): never broken, never billed, every month', async () => {
    const p = await park({ estimates: true })
    const s = await departed(p, { unit: 'RV 09', start: 362, end: 362, leaseStart: '2026-10-01', existing: true })
    await db.query(`UPDATE leases SET status = 'terminated', end_date = NULL,
                      terminated_at = '2026-09-18 12:50:38-07',
                      termination_reason = 'Lease document voided before the tenant signed' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    await read(s.meterId, '2026-10-31', 362, OCT)
    await generateBillsForMeter(s.meterId, oct)
    await notBroken(s.meterId)
    // The voided lease is nobody's to bill.
    expect(await allBills(s.meterId)).toHaveLength(0)
    // And if the space is used in November, the voided household is still not
    // billed — the landlord is told there is nobody to bill.
    await read(s.meterId, '2026-11-30', 500, '2026-11-01')
    await generateBillsForMeter(s.meterId, new Date('2026-11-01T00:00:00Z'))
    expect(await allBills(s.meterId)).toHaveLength(0)
    const n = await notices('utility_usage_unbilled')
    expect(n).toHaveLength(1)
    expect(n[0].data).toMatchObject({ cycle: '2026-11-01', usage: 138, why: 'nobody' })
  })

  it('an unsigned draft thrown away (Mountain View RV 01) is nobody living there', async () => {
    const p = await park({ estimates: true })
    const s = await departed(p, { unit: 'RV 01', start: 0, end: 0, leaseStart: '2026-09-11' })
    // The booking was cancelled; its draft lease went with it — no terminated_at.
    await db.query(`UPDATE leases SET status = 'terminated', end_date = '2026-11-13', lease_source = 'booking_draft'
                     WHERE id = $1`, [s.leaseId])
    await read(s.meterId, '2026-10-31', 0, OCT)
    await generateBillsForMeter(s.meterId, oct)
    await notBroken(s.meterId)
    expect(await allBills(s.meterId)).toHaveLength(0)
  })

  it('a household that arrived after the cycle: running September again does not mark the meter broken', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    // Empty all September; a new household from 10/2, the space now showing occupied.
    const s = await space(p, { unit: 'RV 14', start: 700, end: 700, lease: true, leaseStart: '2026-10-02', status: 'active' })
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
    expect(await allBills(s.meterId)).toHaveLength(0)
  })

  it('still a broken meter when somebody DID live there across the span — a lease ending after the read', async () => {
    const p = await park({ estimates: true })
    const s = await departed(p, { unit: 'RV 15', start: 3000, end: 3000 })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-10-15' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ allocation_method: 'comparable_low', usage: 387 })
  })

  it('still a broken meter across a renewal mid-cycle — the household never left', async () => {
    const p = await park({ estimates: true })
    const s = await departed(p, { unit: 'RV 19', start: 4000, end: 4000 })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-14' WHERE id = $1`, [s.leaseId])
    const c = await db.connect()
    try {
      const renewal = await seedLease(c, { unitId: s.unitId, landlordId: p.landlordId, startDate: '2026-09-15' })
      await seedLeaseTenant(c, { leaseId: renewal, tenantId: s.tenantId! })
      await c.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [renewal, s.leaseId])
    } finally { c.release() }
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect(await notices('utility_meter_broken')).toHaveLength(1)
  })
})

describe('who a bill goes to', () => {
  it('a household that left in August is not billed what the space used in October', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 21', start: 5000, end: 5000, lease: true, status: 'vacant' })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-08-20' WHERE id = $1`, [s.leaseId])
    await read(s.meterId, '2026-10-31', 5250, OCT)
    await generateBillsForMeter(s.meterId, oct)
    expect((await allBills(s.meterId)).filter((b: any) => b.cycle === OCT)).toHaveLength(0)
    expect(await notices('final_utility_invoice')).toHaveLength(0)
    expect((await notices('utility_usage_unbilled'))[0].data).toMatchObject({ cycle: OCT, usage: 250, why: 'nobody' })
  })

  it('a late move-out read still lands on the household that left (S548)', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 22', start: 6000, end: 6300, lease: true, status: 'vacant' })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-30' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    // Unplugged and read on 10/2 — October's cycle, two days after the lease ended.
    const late = await read(s.meterId, '2026-10-02', 6312, OCT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, late)).billed).toBe(true)
    const octBill = (await allBills(s.meterId)).find((b: any) => b.cycle === OCT)
    expect(octBill).toMatchObject({ usage: 12, lease_id: s.leaseId })
  })
})

describe('marking a meter broken while a lease is being signed', () => {
  it('a signing that rolls back leaves no "marked broken" notice behind', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const c = await db.connect()
    let unitId = '', meterId = '', leaseId = '', tenantId = ''
    try {
      await c.query('BEGIN')
      unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
      await c.query(`UPDATE units SET unit_number='RV 41', unit_type='rv_spot' WHERE id=$1`, [unitId])
      leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: '2026-10-02' })
      tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
      meterId = (await c.query<{ id: string }>(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, base_fee, digits)
         VALUES ($1,'electric','RV 41 electric','submeter',0.21,0,6) RETURNING id`, [p.propertyId])).rows[0].id
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, unitId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
         VALUES ($1,'2026-09-01',900,$3,'baseline',$2), ($1,'2026-09-30',900,$3,'monthly_cycle',$2)`,
        [meterId, p.userId, SEPT])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    // The signing transaction: the release runs inside it, then the signing fails.
    const tx = await db.connect()
    try {
      await tx.query('BEGIN')
      await releaseSuspendedChargesForLease({ unitId, leaseId, tenantId, landlordId: p.landlordId, client: tx })
      // Inside the transaction the mark and its notice are there together...
      expect((await tx.query(`SELECT out_of_service FROM utility_meters WHERE id=$1`, [meterId])).rows[0].out_of_service).toBe(true)
      expect((await tx.query(`SELECT 1 FROM notifications WHERE type='utility_meter_broken'`)).rows).toHaveLength(1)
      await tx.query('ROLLBACK')
    } finally { tx.release() }
    // ...and they roll back together.
    expect(await outOfService(meterId)).toBe(false)
    expect(await notices('utility_meter_broken')).toHaveLength(0)
    // The retry tells the landlord once.
    await releaseSuspendedChargesForLease({ unitId, leaseId, tenantId, landlordId: p.landlordId })
    expect(await outOfService(meterId)).toBe(true)
    expect(await notices('utility_meter_broken')).toHaveLength(1)
  })
})

// ── 10/3 (final sweep, third pass) ─────────────────────────────────────────
//
// What the second pass still read as a broken meter, and who it still billed.
describe('a read span that is no evidence of a broken meter', () => {
  /** Make the September cycle read come AFTER a read added now on the same day. */
  const cycleReadLast = (meterId: string) => db.query(
    `UPDATE utility_meter_readings SET created_at = now() + interval '1 minute'
      WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'`, [meterId, SEPT])
  const neighbor = (p: Park) => space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })

  it.each([true, false])('a lease ending 9/30, read out 9/30, then the September read 9/30 with the same number (estimates %s)', async (estimates) => {
    const p = await park({ estimates })
    await neighbor(p)
    const s = await space(p, { unit: 'RV 60', start: 1000, end: 1080, lease: true, status: 'vacant' })
    // processLeaseEnds expires it at 2am on its last day; the front desk reads it out that day.
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-30' WHERE id = $1`, [s.leaseId])
    await cycleReadLast(s.meterId)
    const out = await read(s.meterId, '2026-09-30', 1080, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
    expect((await allBills(s.meterId)).map((b: any) => [b.cycle, b.usage, b.lease_id])).toEqual([[SEPT, 80, s.leaseId]])
  })

  it.each(['expired', 'active'])('read out 9/29 on a lease ending 9/30 (%s), then the September read 9/30 with the same number', async (status) => {
    const p = await park({ estimates: true })
    await neighbor(p)
    const s = await space(p, { unit: 'RV 61', start: 2000, end: 2050, lease: true, status: 'vacant' })
    await db.query(`UPDATE leases SET status = $2, end_date = '2026-09-30' WHERE id = $1`, [s.leaseId, status])
    const out = await read(s.meterId, '2026-09-29', 2050, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
  })

  it.each(['baseline', 'meter_replaced'])('a new meter: its %s read and the September read on the same day, same number, on an occupied space', async (reason) => {
    const p = await park({ estimates: true })
    await neighbor(p)
    // Oak Park RV 24: a new water meter with a 9/30 opening read of 21800 — September's read day.
    const s = await space(p, { unit: 'RV 24', start: 21800, end: 21800, lease: true })
    await db.query(
      `UPDATE utility_meter_readings SET reading_date = '2026-09-30', billing_cycle_month = $2, reason = $3,
              created_at = now() - interval '1 hour'
        WHERE meter_id = $1 AND reading_date = '2026-08-31'`, [s.meterId, SEPT, reason])
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
    // The next month reads the new meter as it stands.
    await read(s.meterId, '2026-10-31', 21950, OCT)
    await read((await db.query<{ id: string }>(`SELECT id FROM utility_meters WHERE label = 'RV 28 electric'`)).rows[0].id,
      '2026-10-31', 52786, OCT)
    expect((await generateBillsForMeter(s.meterId, oct)).billsCreated).toBe(1)
    expect((await allBills(s.meterId)).find((b: any) => b.cycle === OCT)).toMatchObject({ usage: 150, allocation_method: 'submeter' })
  })

  it('at lease signing: an onboarding resident\'s opening read on the September read day is not a broken meter', async () => {
    const p = await park({ estimates: true })
    await neighbor(p)
    const c = await db.connect()
    let unitId = '', meterId = '', leaseId = '', tenantId = ''
    try {
      await c.query('BEGIN')
      unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
      await c.query(`UPDATE units SET unit_number='RV 24', unit_type='rv_spot' WHERE id=$1`, [unitId])
      leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: '2026-10-02' })
      tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
      meterId = (await c.query<{ id: string }>(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, base_fee, digits)
         VALUES ($1,'electric','RV 24 electric','submeter',0.21,0,6) RETURNING id`, [p.propertyId])).rows[0].id
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, unitId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id, created_at)
         VALUES ($1,'2026-09-30',21800,$3,'baseline',$2, now() - interval '1 hour'),
                ($1,'2026-09-30',21800,$3,'monthly_cycle',$2, now())`,
        [meterId, p.userId, SEPT])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await releaseSuspendedChargesForLease({ unitId, leaseId, tenantId, landlordId: p.landlordId })
    await notBroken(meterId)
    expect((await db.query(`SELECT 1 FROM suspended_utility_charges WHERE meter_id = $1 AND allocation_method = 'comparable_low'`, [meterId])).rows).toHaveLength(0)
  })

  it('still a broken meter when the household read out is still there after the read (lease runs past it)', async () => {
    const p = await park({ estimates: true })
    await neighbor(p)
    const s = await space(p, { unit: 'RV 62', start: 3000, end: 3000, lease: true })
    // A move-out read taken by mistake mid-month; the lease runs to December.
    await db.query(`UPDATE leases SET end_date = '2026-12-31' WHERE id = $1`, [s.leaseId])
    await db.query(
      `UPDATE utility_meter_readings SET reading_date = '2026-09-15', reason = 'move_out_final', billing_cycle_month = $2
        WHERE meter_id = $1 AND reading_date = '2026-08-31'`, [s.meterId, SEPT])
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
  })
})

describe('a move-out read bills the household it closes out', () => {
  it('a household gone since August (its space history never closed) is not billed a later household\'s move-out read', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 63', start: 1000, end: 1200, lease: true, status: 'vacant' })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-08-20' WHERE id = $1`, [s.leaseId])
    const c = await db.connect()
    let b = ''
    try {
      b = await seedLease(c, { unitId: s.unitId, landlordId: p.landlordId, startDate: '2026-09-10' })
      await seedLeaseTenant(c, { leaseId: b, tenantId: await seedTenant(c) })
      await c.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-25' WHERE id = $1`, [b])
    } finally { c.release() }
    const out = await read(s.meterId, '2026-09-25', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    const bills = await allBills(s.meterId)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ cycle: SEPT, usage: 100, lease_id: b })
    const dated = (await db.query<any>(
      `SELECT to_char(reading_start_date,'YYYY-MM-DD') AS s, to_char(reading_end_date,'YYYY-MM-DD') AS e
         FROM utility_bills WHERE meter_id = $1`, [s.meterId])).rows[0]
    expect(dated).toEqual({ s: '2026-08-31', e: '2026-09-25' })
    // The final invoice goes to the household that just left — not the August one.
    const finals = (await db.query<{ lease_id: string }>(
      `SELECT DISTINCT ub.lease_id FROM utility_bills ub WHERE ub.meter_id = $1 AND ub.status = 'billed'`, [s.meterId])).rows
    expect(finals.map(r => r.lease_id)).toEqual([b])
  })
})

describe('an invited existing resident\'s flat meter', () => {
  async function invitedSpace(p: Park, o: { unit: string; invitedOn: string }) {
    await db.query(`UPDATE properties SET onboarding_started_at = now() - interval '2 days' WHERE id = $1`, [p.propertyId])
    const s = await space(p, { unit: o.unit, start: 4000, end: 4000, status: 'active' })
    // Their opening read, taken when the space was set up for onboarding.
    await read(s.meterId, '2026-09-01', 4000, SEPT, 'baseline')
    const c = await db.connect()
    let tenantId = ''
    try {
      tenantId = await seedTenant(c)
      await c.query(
        `INSERT INTO pending_tenant_intents (unit_id, tenant_id, landlord_id, property_id, is_existing_tenancy, created_at)
         VALUES ($1,$2,$3,$4,TRUE,$5)`, [s.unitId, tenantId, p.landlordId, p.propertyId, o.invitedOn])
    } finally { c.release() }
    return { ...s, tenantId }
  }
  async function sign(p: Park, s: { unitId: string; tenantId: string }) {
    const c = await db.connect()
    let leaseId = ''
    try {
      leaseId = await seedLease(c, { unitId: s.unitId, landlordId: p.landlordId, startDate: '2026-10-05' })
      await seedLeaseTenant(c, { leaseId, tenantId: s.tenantId })
      await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [leaseId])
      await c.query(`UPDATE pending_tenant_intents SET resolved_at = now(), resolved_lease_id = $2 WHERE unit_id = $1`, [s.unitId, leaseId])
    } finally { c.release() }
    await releaseSuspendedChargesForLease({ unitId: s.unitId, leaseId, tenantId: s.tenantId, landlordId: p.landlordId })
    return leaseId
  }

  it('invited before the read: the run marks the meter broken and holds the estimate for their first bill', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await invitedSpace(p, { unit: 'RV 33', invitedOn: '2026-09-15' })
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect(await notices('utility_meter_broken')).toHaveLength(1)
    const held = (await db.query<any>(
      `SELECT usage_amount::float AS usage, allocation_method FROM suspended_utility_charges
        WHERE meter_id = $1 AND released_at IS NULL AND cancelled_at IS NULL`, [s.meterId])).rows
    expect(held).toEqual([{ usage: 387, allocation_method: 'comparable_low' }])
    const leaseId = await sign(p, s)
    expect((await allBills(s.meterId))).toMatchObject([{ cycle: SEPT, usage: 387, allocation_method: 'comparable_low', lease_id: leaseId }])
  })

  it('invited after the read: the $0.00 held at the run does not stop signing from marking it broken and estimating', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await invitedSpace(p, { unit: 'RV 34', invitedOn: '2026-10-02' })
    await generateBillsForMeter(s.meterId, sept)
    // Nobody counted as living there across September at the run: nothing flagged, the $0.00 share held.
    expect(await outOfService(s.meterId)).toBe(false)
    const leaseId = await sign(p, s)
    expect(await outOfService(s.meterId)).toBe(true)
    expect(await notices('utility_meter_broken')).toHaveLength(1)
    expect((await allBills(s.meterId))).toMatchObject([{ cycle: SEPT, usage: 387, allocation_method: 'comparable_low', lease_id: leaseId }])
    const zero = (await db.query<any>(
      `SELECT cancelled_reason FROM suspended_utility_charges WHERE meter_id = $1 AND charge_amount = 0`, [s.meterId])).rows
    expect(zero).toHaveLength(1)
    expect(zero[0].cancelled_reason).toBeTruthy()
  })

  it('without estimates: invited before the read, the run marks it broken and bills nothing', async () => {
    const p = await park({ estimates: false })
    const s = await invitedSpace(p, { unit: 'RV 35', invitedOn: '2026-09-15' })
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect((await db.query(`SELECT 1 FROM suspended_utility_charges WHERE meter_id = $1`, [s.meterId])).rows).toHaveLength(0)
  })
})

describe('a $0.00 final cycle after the household left', () => {
  it('is closed out as nothing owed — no final invoice, and no $0.00 line on the deposit return', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 64', start: 2000, end: 2000, lease: true, status: 'vacant' })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-02' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
    expect(await allBills(s.meterId)).toMatchObject([{ cycle: SEPT, usage: 0, charge: 0, status: 'void' }])
    expect((await allBills(s.meterId))[0].notes).toContain('nothing was owed')
    expect(await notices('final_utility_invoice')).toHaveLength(0)
    const { calculateDepositReturn } = await import('./depositReturn')
    const dr = await calculateDepositReturn(s.leaseId!)
    expect(dr!.final_utility_lines).toEqual([])
    // Running the cycle again leaves it closed.
    await generateBillsForMeter(s.meterId, sept)
    expect(await allBills(s.meterId)).toMatchObject([{ status: 'void' }])
  })

  it('a household that still owes something gets its final bill, the $0.00 line on it as before', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 65', start: 2000, end: 2000, lease: true, status: 'vacant' })
    // August's water, billed while they were still there and not invoiced yet.
    const w = (await db.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, base_fee, digits)
       VALUES ($1,'water','RV 65 water','submeter',0.01,0,6) RETURNING id`, [p.propertyId])).rows[0].id
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [w, s.unitId])
    await read(w, '2026-07-31', 500, '2026-07-01')
    await read(w, '2026-08-31', 900, '2026-08-01')
    expect((await generateBillsForMeter(w, new Date('2026-08-01T00:00:00Z'))).billsCreated).toBe(1)
    expect((await allBills(w))[0]).toMatchObject({ usage: 400, status: 'unbilled' })
    // Then they left on 9/2; September's electric did not move.
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-02' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    expect((await allBills(w))[0]).toMatchObject({ status: 'billed' })
    expect((await allBills(s.meterId))[0]).toMatchObject({ usage: 0, charge: 0, status: 'billed' })
    expect(await notices('final_utility_invoice')).toHaveLength(2)
  })
})

const neighborMeter = async () => (await db.query<{ id: string }>(`SELECT id FROM utility_meters WHERE label = 'RV 28 electric'`)).rows[0].id
/** Asleep from `from`, awake again on `to` — as the hibernate and resume buttons do it. */
async function pauseThenResume(leaseId: string, from: string, to: string) {
  await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = $2 WHERE id = $1`, [leaseId, from])
  await db.query(`UPDATE leases SET is_hibernating = FALSE, hibernated_at = NULL WHERE id = $1`, [leaseId])
  await db.query(
    `UPDATE audit_row_changes SET changed_at = $2
      WHERE table_name = 'leases' AND row_id = $1 AND (new_row->>'is_hibernating')::boolean = FALSE
        AND (old_row->>'is_hibernating')::boolean = TRUE`, [leaseId, to])
  await db.query(
    `UPDATE audit_row_changes SET changed_at = $2
      WHERE table_name = 'leases' AND row_id = $1 AND (new_row->>'is_hibernating')::boolean = TRUE`, [leaseId, from])
}

describe('a lease paused and resumed before the cycle was priced', () => {
  it('paused 9/19, resumed 10/2, the meter flat: not broken, the cycle written down as paused', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 55', start: 800, end: 800, lease: true })
    await pauseThenResume(s.leaseId!, '2026-09-19 10:00:00-07', '2026-10-02 09:00:00-07')
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(0)
    await notBroken(s.meterId)
    expect(await allBills(s.meterId)).toMatchObject([{ cycle: SEPT, status: 'void', charge: 0, notes: PAUSED_CYCLE_NOTE, lease_id: s.leaseId }])
    // October, back and using power: billed off the real reading.
    await read(s.meterId, '2026-10-31', 1100, OCT)
    await read(await neighborMeter(), '2026-10-31', 52786, OCT)
    expect((await generateBillsForMeter(s.meterId, oct)).billsCreated).toBe(1)
    expect((await allBills(s.meterId)).find((b: any) => b.cycle === OCT)).toMatchObject({ usage: 300, allocation_method: 'submeter' })
  })

  it('a below-previous read flagged, then corrected to the flat number after the household is back: not broken', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, { unit: 'RV 56', start: 800, end: 790, lease: true })
    await db.query(`UPDATE utility_meter_readings SET needs_review = TRUE WHERE meter_id = $1 AND billing_cycle_month = $2`, [s.meterId, SEPT])
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-09-19 10:00:00-07' WHERE id = $1`, [s.leaseId])
    expect((await generateBillsForMeter(s.meterId, sept)).reason).toBe('reading awaiting double-check — no bill until resolved')
    await db.query(`UPDATE leases SET is_hibernating = FALSE, hibernated_at = NULL WHERE id = $1`, [s.leaseId])
    await db.query(`UPDATE utility_meter_readings SET reading_value = 800, needs_review = FALSE WHERE meter_id = $1 AND billing_cycle_month = $2`, [s.meterId, SEPT])
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
  })

  it('a pause that ended before the read span does not explain a flat meter — still broken', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 57', start: 800, end: 800, lease: true })
    await pauseThenResume(s.leaseId!, '2026-07-01 10:00:00-07', '2026-08-10 09:00:00-07')
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ allocation_method: 'comparable_low', usage: 387 })
  })
})

// ── 10/3 (final sweep, fourth pass) ────────────────────────────────────────
//
// What the third pass's own fixes still got wrong.
describe('an existing-resident invite counts only while the onboarding window is open', () => {
  /**
   * A space marked vacant with a WORKING meter that read the same number twice
   * (nobody there), and an existing-resident invite from June that nobody ever
   * cancelled. Invites are not closed when the window closes.
   */
  async function staleInvite(p: Park, unit: string, window: 'completed' | 'timed out' | 'open') {
    await db.query(
      window === 'completed'
        ? `UPDATE properties SET onboarding_started_at = '2026-06-01', onboarding_completed_at = '2026-07-15' WHERE id = $1`
        : window === 'timed out'
        ? `UPDATE properties SET onboarding_started_at = now() - interval '60 days', onboarding_completed_at = NULL WHERE id = $1`
        : `UPDATE properties SET onboarding_started_at = now() - interval '2 days', onboarding_completed_at = NULL WHERE id = $1`,
      [p.propertyId])
    const s = await space(p, { unit, start: 7000, end: 7000, status: 'vacant' })
    const c = await db.connect()
    try {
      await c.query(
        `INSERT INTO pending_tenant_intents (unit_id, tenant_id, landlord_id, property_id, is_existing_tenancy, created_at)
         VALUES ($1,$2,$3,$4,TRUE,'2026-06-10')`, [s.unitId, await seedTenant(c), p.landlordId, p.propertyId])
    } finally { c.release() }
    return s
  }

  it.each([
    ['marked complete', true], ['marked complete', false],
    ['ran out of time', true], ['ran out of time', false],
  ] as const)('window %s (estimates %s): a working meter on an empty space is not marked broken', async (how, estimates) => {
    const p = await park({ estimates })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await staleInvite(p, 'RV 70', how === 'marked complete' ? 'completed' : 'timed out')
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
    // Nothing held for the invite either — the window that holds shares is closed.
    expect((await db.query(`SELECT 1 FROM suspended_utility_charges WHERE meter_id = $1`, [s.meterId])).rows).toHaveLength(0)
    // The next household's real reading bills: the meter was never marked.
    expect((await db.query(`SELECT out_of_service FROM utility_meters WHERE id = $1`, [s.meterId])).rows[0].out_of_service).toBe(false)
  })

  it('the same invite while the window is still open is somebody living there: marked broken, the estimate held for them', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await staleInvite(p, 'RV 71', 'open')
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect(await notices('utility_meter_broken')).toHaveLength(1)
    expect((await db.query<any>(
      `SELECT usage_amount::float AS usage, allocation_method FROM suspended_utility_charges
        WHERE meter_id = $1 AND released_at IS NULL AND cancelled_at IS NULL`, [s.meterId])).rows)
      .toEqual([{ usage: 387, allocation_method: 'comparable_low' }])
  })
})

describe('a move-out read bills the household it closes out (fourth pass)', () => {
  /** A second household B on the same space, its lease from `start` (to `end`, expired, when given). */
  async function nextHousehold(p: Park, unitId: string, start: string, end?: string) {
    const c = await db.connect()
    try {
      const b = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: start })
      await seedLeaseTenant(c, { leaseId: b, tenantId: await seedTenant(c) })
      if (end) await c.query(`UPDATE leases SET status = 'expired', end_date = $2 WHERE id = $1`, [b, end])
      return b
    } finally { c.release() }
  }

  it('a household whose last day was the August read day is not billed the next household\'s move-out read', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 66', start: 1000, end: 1200, lease: true, status: 'vacant' })
    // A ended 8/31, the day August was read — the usual month-end pattern. Its space history never closed.
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-08-31' WHERE id = $1`, [s.leaseId])
    const b = await nextHousehold(p, s.unitId, '2026-09-10', '2026-09-25')
    const out = await read(s.meterId, '2026-09-25', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, b]])
    // Nothing reaches the household that left in August; the final invoice (one
    // notice to the landlord, one to the tenant) is B's.
    expect((await db.query(`SELECT 1 FROM utility_bills WHERE lease_id = $1`, [s.leaseId])).rows).toHaveLength(0)
    const finals = await notices('final_utility_invoice')
    expect(finals).toHaveLength(2)
    expect(finals.map(n => n.data.leaseId)).toEqual([b, b])
  })

  it('a household arriving the day of the move-out read is not billed the departing household\'s read', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 67', start: 1000, end: 1200, lease: true })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-25' WHERE id = $1`, [s.leaseId])
    // Same-day turnover: B's lease starts the day A is read out.
    const b = await nextHousehold(p, s.unitId, '2026-09-25')
    const out = await read(s.meterId, '2026-09-25', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    const bills = await allBills(s.meterId)
    expect(bills.map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, s.leaseId]])
    expect(bills.some((x: any) => x.lease_id === b)).toBe(false)
  })
})

// ── 10/3 (final sweep, fifth pass) ─────────────────────────────────────────
describe('a late move-out read bills the household that left, not the one that arrived (fifth pass)', () => {
  /** Another household on the space from `start` (to `end`, expired, when given). */
  async function household(p: Park, unitId: string, start: string, o: { end?: string; renews?: string } = {}) {
    const c = await db.connect()
    try {
      const id = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: start })
      await seedLeaseTenant(c, { leaseId: id, tenantId: await seedTenant(c) })
      if (o.end) await c.query(`UPDATE leases SET status = 'expired', end_date = $2 WHERE id = $1`, [id, o.end])
      if (o.renews) await c.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [id, o.renews])
      return id
    } finally { c.release() }
  }
  const billsOn = (leaseId: string) => db.query(`SELECT 1 FROM utility_bills WHERE lease_id = $1`, [leaseId]).then(r => r.rows)
  const finalsFor = async () => (await notices('final_utility_invoice')).map(n => n.data.leaseId)

  it('A left 9/10, B arrived 9/10, A read out a day late (9/11): A is billed, B gets no bill and no final invoice', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 90', start: 1000, end: 1200, lease: true })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-10' WHERE id = $1`, [s.leaseId])
    const b = await household(p, s.unitId, '2026-09-10')
    const out = await read(s.meterId, '2026-09-11', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, s.leaseId]])
    expect(await billsOn(b)).toHaveLength(0)
    const finals = await finalsFor()
    expect(finals).toHaveLength(2)
    expect(finals).toEqual([s.leaseId, s.leaseId])
  })

  it('A left 9/14, B arrived 9/15, A read out 9/16: A is billed, B gets no bill and no final invoice', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 91', start: 1000, end: 1200, lease: true })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-14' WHERE id = $1`, [s.leaseId])
    const b = await household(p, s.unitId, '2026-09-15')
    const out = await read(s.meterId, '2026-09-16', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, s.leaseId]])
    expect(await billsOn(b)).toHaveLength(0)
    expect(await finalsFor()).toEqual([s.leaseId, s.leaseId])
  })

  it('A ended 8/31 (the August read day), B still active since 9/10 and read out 9/25: B is billed', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 92', start: 1000, end: 1200, lease: true, status: 'vacant' })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-08-31' WHERE id = $1`, [s.leaseId])
    const b = await household(p, s.unitId, '2026-09-10')
    const out = await read(s.meterId, '2026-09-25', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, b]])
    expect(await billsOn(s.leaseId!)).toHaveLength(0)
  })

  it('two households both gone by the read: the newer one is billed', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 93', start: 1000, end: 1200, lease: true, status: 'vacant' })
    // A left 9/5 with no move-out read; B was there 9/6 to 9/20 and read out 9/22.
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-05' WHERE id = $1`, [s.leaseId])
    const b = await household(p, s.unitId, '2026-09-06', { end: '2026-09-20' })
    const out = await read(s.meterId, '2026-09-22', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, b]])
  })

  it('a renewal is not leaving: A renewed as A2 on 9/15 and read out 9/25 — A2 is billed, not the old lease', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 94', start: 1000, end: 1200, lease: true })
    // The lease a renewal follows ends the day before the renewal starts.
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-14' WHERE id = $1`, [s.leaseId])
    const a2 = await household(p, s.unitId, '2026-09-15', { renews: s.leaseId! })
    const out = await read(s.meterId, '2026-09-25', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, a2]])
    expect(await billsOn(s.leaseId!)).toHaveLength(0)
  })

  it('a household that moved to another space the day after the read before is not billed the next one\'s read', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 95', start: 1000, end: 1200, lease: true })
    const other = await space(p, { unit: 'RV 96', start: 3000, end: 3000 })
    // X moved RV 95 -> RV 96 effective 9/1: its last day on RV 95 was 8/31, the read before.
    await db.query(`UPDATE leases SET unit_id = $2, unit_moved_on = '2026-09-01' WHERE id = $1`, [s.leaseId, other.unitId])
    const y = await household(p, s.unitId, '2026-09-05')
    const out = await read(s.meterId, '2026-09-20', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out)).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, y]])
  })
})

describe('a pause counts only when it was still on at the cycle read', () => {
  it('paused 9/3, resumed 9/5, the meter flat 8/31 to 9/30: still a broken meter, estimated — not written off', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 58', start: 800, end: 800, lease: true })
    await pauseThenResume(s.leaseId!, '2026-09-03 10:00:00-07', '2026-09-05 09:00:00-07')
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect(await notices('utility_meter_broken')).toHaveLength(1)
    const bills = await billsFor(s.meterId)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ allocation_method: 'comparable_low', usage: 387, status: 'unbilled' })
    expect(bills[0].notes).not.toBe(PAUSED_CYCLE_NOTE)
  })

  it('without estimates: paused 9/3 to 9/5, the flat meter is marked broken and nothing is billed', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, { unit: 'RV 59', start: 800, end: 800, lease: true })
    await pauseThenResume(s.leaseId!, '2026-09-03 10:00:00-07', '2026-09-05 09:00:00-07')
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect(await billsFor(s.meterId)).toHaveLength(0)
  })

  it('a meter already marked broken, the lease paused 9/3 to 9/5: September is estimated, not written off', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 68', start: 800, end: 800, lease: true })
    await db.query(`UPDATE utility_meters SET out_of_service = TRUE, out_of_service_since = '2026-08-15' WHERE id = $1`, [s.meterId])
    await pauseThenResume(s.leaseId!, '2026-09-03 10:00:00-07', '2026-09-05 09:00:00-07')
    const r = await generateBillsForMeter(s.meterId, sept)
    expect(r.billsCreated).toBe(1)
    const bills = await billsFor(s.meterId)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ allocation_method: 'comparable_low', usage: 387, status: 'unbilled' })
  })

  it('a lease that went to sleep the day after the cycle read and is still asleep: the flat span is a broken meter', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 69', start: 800, end: 800, lease: true })
    // September was read on 9/28; the household left on a pause 9/29 — after a span they lived through.
    await db.query(
      `UPDATE utility_meter_readings SET reading_date = '2026-09-28'
        WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'`, [s.meterId, SEPT])
    await db.query(`UPDATE leases SET is_hibernating = TRUE, hibernated_at = '2026-09-29 10:00:00-07' WHERE id = $1`, [s.leaseId])
    await generateBillsForMeter(s.meterId, sept)
    expect(await outOfService(s.meterId)).toBe(true)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ allocation_method: 'comparable_low', usage: 387 })
  })

  it('a lease asleep since before the cycle read, awake again after it: still the paused cycle (regression guard)', async () => {
    const p = await park({ estimates: true })
    await space(p, { unit: 'RV 28', start: 51999, end: 52386, lease: true })
    const s = await space(p, { unit: 'RV 72', start: 800, end: 800, lease: true })
    await pauseThenResume(s.leaseId!, '2026-08-20 10:00:00-07', '2026-09-30 15:00:00-07')
    await generateBillsForMeter(s.meterId, sept)
    await notBroken(s.meterId)
    expect(await allBills(s.meterId)).toMatchObject([{ cycle: SEPT, status: 'void', charge: 0, notes: PAUSED_CYCLE_NOTE }])
  })
})

describe('correcting a read: only the paused-cycle record counts as never issued', () => {
  /** A September bill row on the space's meter, written as the engine or the invoice run would leave it. */
  const bill = (s: { meterId: string; unitId: string; leaseId: string | null; tenantId: string | null }, p: Park,
                o: { status: string; charge: number; notes?: string | null; billed?: boolean }) =>
    db.query(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, usage_amount,
          allocation_method, charge_amount, tax_amount, utility_type, status, notes, billed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'submeter',$8,0,'electric',$9,$10,$11)`,
      [s.meterId, s.unitId, s.tenantId, s.leaseId, p.landlordId, SEPT, o.charge > 0 ? 100 : 0,
       o.charge, o.status, o.notes ?? null, o.billed ? new Date() : null])
  const reviewLine = async (p: Park, meterId: string) => {
    // A completed run (one per property and cycle): the review only reads what
    // is there, it prices nothing.
    const runId = (await db.query<{ id: string }>(
      `INSERT INTO utility_reading_runs (property_id, landlord_id, billing_cycle_month, opened_on, status)
       VALUES ($1,$2,$3,'2026-09-30','completed')
       ON CONFLICT DO NOTHING RETURNING id`, [p.propertyId, p.landlordId, SEPT])).rows[0]?.id
      ?? (await db.query<{ id: string }>(
        `SELECT id FROM utility_reading_runs WHERE property_id = $1 AND billing_cycle_month = $2`,
        [p.propertyId, SEPT])).rows[0].id
    return (await billReview(runId)).lines.find((l: any) => l.meterId === meterId)
  }

  it.each([
    ['a bill sent to the tenant', { status: 'billed', charge: 21, billed: true }],
    ['a voided bill that carried a charge, even with the paused words on it', { status: 'void', charge: 21, notes: PAUSED_CYCLE_NOTE }],
    ['a $0.00 row with the paused words that was sent', { status: 'void', charge: 0, notes: PAUSED_CYCLE_NOTE, billed: true }],
  ])('%s is issued: the read cannot be changed, and the review says so', async (_label, o) => {
    const p = await park({ estimates: false })
    const s = await space(p, { unit: 'RV 73', start: 800, end: 900, lease: true })
    await bill(s, p, o)
    expect(await dropUnissuedBillsFrom(s.meterId, SEPT)).toBe(false)
    expect(await dropUnissuedBillsFrom(s.meterId, '2026-08-01')).toBe(false)
    expect(await reviewLine(p, s.meterId)).toMatchObject({ issued: true })
  })

  it('the paused-cycle record is not: the read can be changed, the unissued bills go, the record stays for the engine', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, { unit: 'RV 74', start: 800, end: 800, lease: true })
    const n = await space(p, { unit: 'RV 75', start: 500, end: 600, lease: true })
    await bill(s, p, { status: 'void', charge: 0, notes: PAUSED_CYCLE_NOTE })
    await bill(n, p, { status: 'unbilled', charge: 21 })
    expect(await reviewLine(p, s.meterId)).toMatchObject({ issued: false, charge: 0 })
    expect(await reviewLine(p, n.meterId)).toMatchObject({ issued: false, charge: 21 })
    expect(await dropUnissuedBillsFrom(s.meterId, SEPT)).toBe(true)
    // The neighbor's unissued bill is dropped to be priced again; the record is kept.
    expect(await allBills(n.meterId)).toHaveLength(0)
    expect(await allBills(s.meterId)).toMatchObject([{ status: 'void', charge: 0, notes: PAUSED_CYCLE_NOTE }])
  })
})

// ── 10/3 (final sweep, sixth pass) ─────────────────────────────────────────
describe('a read whose household the caller names bills that household (sixth pass)', () => {
  /** Another household on the space from `start` (to `end`, expired, when given). */
  async function household(p: Park, unitId: string, start: string, o: { end?: string } = {}) {
    const c = await db.connect()
    try {
      const id = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: start })
      await seedLeaseTenant(c, { leaseId: id, tenantId: await seedTenant(c) })
      if (o.end) await c.query(`UPDATE leases SET status = 'expired', end_date = $2 WHERE id = $1`, [id, o.end])
      return id
    } finally { c.release() }
  }
  const billsOn = (leaseId: string) => db.query(`SELECT 1 FROM utility_bills WHERE lease_id = $1`, [leaseId]).then(r => r.rows)
  const finalsFor = async () => (await notices('final_utility_invoice')).map(n => n.data.leaseId)

  it('A left 9/5 with no read, D (there since 9/6) moves to another space 9/20: D is billed the old space, A gets no bill and no final invoice', async () => {
    const p = await park({ estimates: true })
    const x = await space(p, { unit: 'RV 10', start: 1000, end: 1200, lease: true })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-05' WHERE id = $1`, [x.leaseId])
    const d = await household(p, x.unitId, '2026-09-06')
    const y = await space(p, { unit: 'RV 11', start: 3000, end: 3000 })
    // The move's closing read, the way unitMove takes it: dated the move day,
    // billed BEFORE the lease changes spaces (its space history is still open),
    // naming the lease that is moving.
    const closing = await read(x.meterId, '2026-09-20', 1100, SEPT, 'other')
    expect((await billMoveOutRead(x.meterId, closing, { leaseId: d })).billed).toBe(true)
    await db.query(`UPDATE leases SET unit_id = $2, unit_moved_on = '2026-09-20' WHERE id = $1`, [d, y.unitId])
    expect((await allBills(x.meterId)).map((b: any) => [b.cycle, b.usage, b.lease_id])).toEqual([[SEPT, 100, d]])
    expect(await billsOn(x.leaseId!)).toHaveLength(0)
    expect((await finalsFor()).filter(l => l === x.leaseId)).toHaveLength(0)
  })

  it('naming a household gone before the read before does not bill it: A ended 8/31 (the August read day), B read out 9/25 — B is billed', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 12', start: 1000, end: 1200, lease: true, status: 'vacant' })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-08-31' WHERE id = $1`, [s.leaseId])
    const b = await household(p, s.unitId, '2026-09-10')
    const out = await read(s.meterId, '2026-09-25', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out, { leaseId: s.leaseId })).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, b]])
    expect(await billsOn(s.leaseId!)).toHaveLength(0)
  })

  it('naming a household that arrived the day of the read does not bill it: same-day turnover still bills the one that left', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 13', start: 1000, end: 1200, lease: true })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-25' WHERE id = $1`, [s.leaseId])
    const b = await household(p, s.unitId, '2026-09-25')
    const out = await read(s.meterId, '2026-09-25', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out, { leaseId: b })).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, s.leaseId]])
    expect(await billsOn(b)).toHaveLength(0)
  })

  it('naming a lease on another space changes nothing: the read bills by the move-out rule', async () => {
    const p = await park({ estimates: true })
    const s = await space(p, { unit: 'RV 14', start: 1000, end: 1200, lease: true })
    await db.query(`UPDATE leases SET status = 'expired', end_date = '2026-09-10' WHERE id = $1`, [s.leaseId])
    const b = await household(p, s.unitId, '2026-09-10')
    const elsewhere = await space(p, { unit: 'RV 15', start: 500, end: 600, lease: true })
    const out = await read(s.meterId, '2026-09-11', 1100, SEPT, 'move_out_final')
    expect((await billMoveOutRead(s.meterId, out, { leaseId: elsewhere.leaseId })).billed).toBe(true)
    expect((await allBills(s.meterId)).map((x: any) => [x.cycle, x.usage, x.lease_id])).toEqual([[SEPT, 100, s.leaseId]])
    expect(await billsOn(b)).toHaveLength(0)
    expect(await billsOn(elsewhere.leaseId!)).toHaveLength(0)
  })
})
