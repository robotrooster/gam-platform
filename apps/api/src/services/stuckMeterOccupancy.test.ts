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
async function parkWithAStuckMeter(opts: { unitStatus: string; withLease: boolean }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone='America/Phoenix' WHERE id=$1`, [propertyId])

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
      const sLease = await seedLease(c, { unitId: stuckUnit, landlordId: ll.landlordId, startDate: '2026-08-01' })
      await seedLeaseTenant(c, { leaseId: sLease, tenantId: await seedTenant(c) })
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
