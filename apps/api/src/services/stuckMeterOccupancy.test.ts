/**
 * S642 (Nic, via Calvin Curtis on RV 40) — "it's not showing any electricity.
 * We're supposed to be matching broken reads that are active spots."
 *
 * A stuck meter on an OCCUPIED space bills the lowest comparable rather than
 * zero. That worked — RV 23 billed $25.20 off a comparable in the same cycle —
 * and it silently failed for four spaces at Mountain View, every one of them
 * within days of its lease starting.
 *
 * The test was the unit's status at the INSTANT of billing, and a lease
 * finalising bills its utilities BEFORE marking the unit occupied. So a space
 * lived in all cycle read 'vacant' while its own bill was written.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { generateBillsForMeter } from './utilityBilling'

beforeEach(async () => { await cleanupAllSchema() })

const CYCLE = '2026-08-01'

/** A space whose meter has not moved, plus a neighbour that used 120 kWh. */
// S648: estimating is a landlord's per-property choice. These fixtures turn it
// on unless a test says otherwise.
async function parkWithAStuckMeter(opts: {
  unitStatus: string; withLease: boolean; existingTenancy?: boolean; leaseStart?: string
  estimates?: boolean
}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone='America/Phoenix', estimates_stuck_meters=$2 WHERE id=$1`,
      [propertyId, opts.estimates ?? true])

    const mkMeter = async (unitId: string, label: string, rate: number) => {
      const m = await c.query<{ id: string }>(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, digits)
         VALUES ($1,'electric',$2,'submeter',$3,6) RETURNING id`, [propertyId, label, rate])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [m.rows[0].id, unitId])
      return m.rows[0].id
    }
    const read = (meterId: string, date: string, value: number, reason: string) =>
      c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6)`, [meterId, date, value, CYCLE, reason, ll.userId])

    // the space in question — meter has not moved
    const stuckUnit = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    await c.query(`UPDATE units SET unit_number='RV 40', unit_type='rv_spot', status=$2 WHERE id=$1`,
      [stuckUnit, opts.unitStatus])
    const stuckMeter = await mkMeter(stuckUnit, 'RV 40 electric', 0.21)
    await read(stuckMeter, '2026-08-01', 28999, 'baseline')
    await read(stuckMeter, '2026-09-02', 28999, 'monthly_cycle')

    // a comparable neighbour that really used 120
    const neighbour = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    await c.query(`UPDATE units SET unit_number='RV 28', unit_type='rv_spot', status='active' WHERE id=$1`, [neighbour])
    const nMeter = await mkMeter(neighbour, 'RV 28 electric', 0.21)
    await read(nMeter, '2026-08-01', 51999, 'baseline')
    await read(nMeter, '2026-09-02', 52119, 'monthly_cycle')
    const nLease = await seedLease(c, { unitId: neighbour, landlordId: ll.landlordId, startDate: '2026-01-01' })
    await seedLeaseTenant(c, { leaseId: nLease, tenantId: await seedTenant(c) })

    if (opts.withLease) {
      // A bill needs somebody to bill — the lookup joins the primary tenant.
      const sLease = await seedLease(c, {
        unitId: stuckUnit, landlordId: ll.landlordId,
        startDate: opts.leaseStart ?? '2026-08-01',
      })
      await seedLeaseTenant(c, { leaseId: sLease, tenantId: await seedTenant(c) })
      if (opts.existingTenancy) {
        await c.query(`UPDATE leases SET is_existing_tenancy = TRUE WHERE id = $1`, [sLease])
      }
    }
    await c.query('COMMIT')
    return { stuckUnit, stuckMeter, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const billFor = async (unitId: string) =>
  (await db.query(
    `SELECT usage_amount, charge_amount, allocation_method
       FROM utility_bills WHERE unit_id=$1 AND billing_cycle_month=$2`, [unitId, CYCLE])).rows[0]

describe('a stuck meter on a space somebody lives in', () => {
  it('bills the lowest comparable when the unit reads occupied', async () => {
    const w = await parkWithAStuckMeter({ unitStatus: 'active', withLease: true })
    await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    const b = await billFor(w.stuckUnit)
    expect(b.allocation_method).toBe('comparable_low')
    expect(Number(b.usage_amount)).toBe(120)
  })

  // THE BUG: a lease finalising bills before the unit is marked occupied, so
  // the space still read 'vacant' while its own bill was written.
  it('bills the comparable even when the status still says vacant', async () => {
    const w = await parkWithAStuckMeter({ unitStatus: 'vacant', withLease: true })
    await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    const b = await billFor(w.stuckUnit)
    expect(b.allocation_method, 'a lease covered this cycle — somebody was living there')
      .toBe('comparable_low')
    expect(Number(b.charge_amount)).toBeGreaterThan(0)
  })

  it('a delinquent space is still somebody living there', async () => {
    const w = await parkWithAStuckMeter({ unitStatus: 'delinquent', withLease: true })
    await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    expect((await billFor(w.stuckUnit)).allocation_method).toBe('comparable_low')
  })

  // The other direction must still hold: an empty space owes nothing.
  it('a genuinely empty space is still billed nothing', async () => {
    const w = await parkWithAStuckMeter({ unitStatus: 'vacant', withLease: false })
    await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    const b = await billFor(w.stuckUnit)
    if (b) {
      expect(b.allocation_method).not.toBe('comparable_low')
      expect(Number(b.charge_amount)).toBe(0)
    }
  })
})

// ── S648 (Nic, DIRECTIVE): a property that has not chosen estimates ────────
//
// "I do not want other landlords having the meter reads guessed on... flag if
// there's no change in the meter and flag that it's broken... No electric bill
// if the meter isn't working."
describe('a stuck meter at any other property', () => {
  it('bills nothing and marks the meter broken, telling the landlord once', async () => {
    const w = await parkWithAStuckMeter({ unitStatus: 'active', withLease: true, estimates: false })
    const r = await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    expect(r.billsCreated).toBe(0)
    expect(await billFor(w.stuckUnit)).toBeUndefined()
    const m = (await db.query(`SELECT out_of_service, out_of_service_since FROM utility_meters WHERE id=$1`,
      [w.stuckMeter])).rows[0]
    expect(m.out_of_service).toBe(true)
    expect(m.out_of_service_since).not.toBeNull()
    await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    const notes = await db.query(`SELECT title FROM notifications WHERE type='utility_meter_broken'`)
    expect(notes.rows).toHaveLength(1)
    expect(notes.rows[0].title).toContain('RV 40')
  })

  // S648 (Nic): the repaired meter's own number is the next bill's start.
  it('after repair, bills from the new meter\'s starting reading', async () => {
    const w = await parkWithAStuckMeter({ unitStatus: 'active', withLease: true, estimates: false })
    await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    // replaced with a refurbished meter reading 700 on Sept 10, marked repaired
    await db.query(`UPDATE utility_meters SET out_of_service=FALSE, out_of_service_since=NULL WHERE id=$1`, [w.stuckMeter])
    const uid = (await db.query(`SELECT user_id FROM landlords LIMIT 1`)).rows[0].user_id
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1,'2026-09-10',700,'2026-09-01','meter_replaced',$2),
              ($1,'2026-10-01',950,'2026-09-01','monthly_cycle',$2)`, [w.stuckMeter, uid])
    const r = await generateBillsForMeter(w.stuckMeter, new Date('2026-09-01T00:00:00Z'))
    expect(r.billsCreated).toBe(1)
    const b = (await db.query(
      `SELECT usage_amount::float AS usage, allocation_method FROM utility_bills
        WHERE unit_id=$1 AND billing_cycle_month='2026-09-01'`, [w.stuckUnit])).rows[0]
    expect(b.usage).toBe(250)
    expect(b.allocation_method).not.toBe('comparable_low')
  })

  it('keeps billing nothing while it is marked broken', async () => {
    const w = await parkWithAStuckMeter({ unitStatus: 'active', withLease: true, estimates: false })
    await db.query(`UPDATE utility_meters SET out_of_service=TRUE WHERE id=$1`, [w.stuckMeter])
    const r = await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    expect(r.billsCreated).toBe(0)
    expect(await billFor(w.stuckUnit)).toBeUndefined()
  })
})

// ── the onboarding window ──────────────────────────────────────────────────
//
// Nic: "all the leases are onboarding existing tenants. During the onboarding
// window, we are supposed to count it as existing tenants here."
//
// An onboarding lease's start_date is the day they signed onto GAM, not the day
// they moved in. Reading it as a move-in makes every month before it look like
// a vacancy — so a park's first cycle billed $0 on spaces full of people using
// power.
describe('a resident who was already living there', () => {
  it('is billed for the cycle BEFORE their GAM lease starts', async () => {
    const w = await parkWithAStuckMeter({
      unitStatus: 'active', withLease: true,
      existingTenancy: true, leaseStart: '2026-09-02',   // after the Aug cycle
    })
    await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    const b = await billFor(w.stuckUnit)
    expect(b.allocation_method, 'they lived there in August — the meter is dead, not the space')
      .toBe('comparable_low')
    expect(Number(b.charge_amount)).toBeGreaterThan(0)
  })

  // The boundary that keeps it honest: a genuinely NEW tenant is not billed for
  // the month before they arrived.
  it('a new tenant is NOT billed for the month before they moved in', async () => {
    const w = await parkWithAStuckMeter({
      unitStatus: 'active', withLease: true,
      existingTenancy: false, leaseStart: '2026-09-02',
    })
    await generateBillsForMeter(w.stuckMeter, new Date(CYCLE + 'T00:00:00Z'))
    const b = await billFor(w.stuckUnit)
    if (b) {
      expect(b.allocation_method).not.toBe('comparable_low')
      expect(Number(b.charge_amount)).toBe(0)
    }
  })
})
