/**
 * S432 services-audit slice 9: utilityBilling.ts.
 *
 * `generateBillsForMeter` is the engine that turns a meter reading +
 * a billing cycle into per-unit utility_bills rows. Three branches:
 *   - master_bill_to_landlord — no bills generated
 *   - submeter — usage = cycle − prior; charge = usage × rate + base
 *   - rubs — split cycle across units by allocation_method
 *     (equal_split / sqft / bedrooms / occupant_count)
 *
 * Gates:
 *   - utility_meter_units row(s) required
 *   - cycle reading required
 *   - submeter needs a prior reading (first cycle = baseline, no bill)
 *   - submeter negative usage → noop
 *   - rubs basis sum 0 → noop
 *   - per-unit: active primary tenant + tenant_responsible=TRUE required
 *   - idempotency: utility_bills_one_per_meter_unit_cycle UNIQUE skips silently
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import {
  generateBillsForMeter, generateBillsForProperty, generateBillsForLandlord,
  billMoveOutRead,
} from './utilityBilling'

beforeEach(async () => {
  await cleanupAllSchema()
})

// ─── seed helpers (specific to this slice) ───────────────────

interface BaseCtx {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
}

async function seedBaseProperty(): Promise<BaseCtx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    await c.query('COMMIT')
    return { landlordUserId, landlordId, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedUnitWithActiveTenant(
  base: BaseCtx,
  opts: { sqft?: number; bedrooms?: number; tenantResponsible?: boolean } = {}
): Promise<{ unitId: string; tenantId: string; leaseId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const unitId = await seedUnit(c, {
      propertyId: base.propertyId, landlordId: base.landlordId,
    })
    if (opts.sqft != null || opts.bedrooms != null) {
      await c.query(
        `UPDATE units SET sqft = COALESCE($2, sqft),
                          bedrooms = COALESCE($3, bedrooms) WHERE id = $1`,
        [unitId, opts.sqft ?? null, opts.bedrooms ?? null])
    }
    const tenantId = await seedTenant(c)
    const leaseId  = await seedLease(c, {
      unitId, landlordId: base.landlordId, status: 'active',
    })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(
      `INSERT INTO lease_utility_responsibilities
         (lease_id, utility_type, tenant_responsible)
       VALUES ($1, 'water', $2)`,
      [leaseId, opts.tenantResponsible ?? true])
    await c.query('COMMIT')
    return { unitId, tenantId, leaseId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function attachMeterToUnit(meterId: string, unitId: string): Promise<void> {
  await db.query(
    `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`,
    [meterId, unitId])
}

async function seedReading(
  meterId: string, cycleMonthIso: string, value: number,
  landlordUserId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO utility_meter_readings
       (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [meterId, cycleMonthIso, value, cycleMonthIso, landlordUserId])
}

async function setMeterRateBase(
  meterId: string, ratePerUnit: number | null, baseFee: number,
): Promise<void> {
  await db.query(
    `UPDATE utility_meters SET rate_per_unit=$2, base_fee=$3 WHERE id=$1`,
    [meterId, ratePerUnit, baseFee])
}

async function setMeterRubs(
  meterId: string,
  method: 'equal_split' | 'sqft' | 'bedrooms' | 'occupant_count',
): Promise<void> {
  await db.query(
    `UPDATE utility_meters SET billing_method='rubs', rubs_allocation_method=$2
      WHERE id=$1`, [meterId, method])
}

// ─── error paths ─────────────────────────────────────────────

describe('generateBillsForMeter — error paths', () => {
  it('meter not found → 404', async () => {
    await expect(generateBillsForMeter(
      '00000000-0000-0000-0000-000000000000',
      new Date(2026, 4, 1),
    )).rejects.toThrow(/Meter not found/)
  })

  it('property not found for meter → 404 (orphaned meter)', async () => {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: base.propertyId })
      await c.query('COMMIT')
    } finally { c.release() }
    // Detach the property by repointing the FK then deleting — simulate
    // an orphan. Easier: delete the property after meter creation should
    // CASCADE-delete the meter. Instead, just simulate by pointing meter
    // at a fake property id (bypassing FK with disabled trigger isn't
    // worth the complexity — skip this test or use a different approach).
    // Simpler: this is a guard-rail path the FK normally prevents.
    // We can verify it by directly mutating to a non-existent property
    // with `SET CONSTRAINTS ALL DEFERRED` — but utility_meters FK isn't
    // deferrable. Use a raw bypass via a transaction with FK trigger off.
    await db.query(`SET session_replication_role = 'replica'`)
    try {
      await db.query(`UPDATE utility_meters SET property_id=$2 WHERE id=$1`,
        [meterId, '00000000-0000-0000-0000-000000000000'])
      await expect(generateBillsForMeter(
        meterId, new Date(2026, 4, 1),
      )).rejects.toThrow(/Property not found/)
    } finally {
      await db.query(`SET session_replication_role = 'origin'`)
    }
  })
})

// ─── master_bill_to_landlord ─────────────────────────────────

describe('generateBillsForMeter — master_bill_to_landlord', () => {
  it('returns noop result with reason; no bills generated', async () => {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, {
        propertyId: base.propertyId,
        billingMethod: 'master_bill_to_landlord',
      })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.unitsSkipped).toBe(0)
    expect(res.reason).toMatch(/master_bill_to_landlord/)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM utility_bills`)
    expect(rows[0].n).toBe(0)
  })
})

// ─── unit/reading gates ──────────────────────────────────────

describe('generateBillsForMeter — unit/reading gates', () => {
  it('no utility_meter_units rows → noop with reason', async () => {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: base.propertyId })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.reason).toMatch(/not assigned to any units/)
    expect(res.billsCreated).toBe(0)
  })

  it('no reading for cycle → noop with unitsSkipped=units.length', async () => {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: base.propertyId })
      await c.query('COMMIT')
    } finally { c.release() }
    const { unitId } = await seedUnitWithActiveTenant(base)
    await attachMeterToUnit(meterId, unitId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.reason).toMatch(/no reading recorded/)
    expect(res.unitsSkipped).toBe(1)
  })
})

// ─── submeter ────────────────────────────────────────────────

describe('generateBillsForMeter — submeter', () => {
  async function seedSubmeterWithUnit(opts: {
    rate?: number; base?: number; tenantResponsible?: boolean
  } = {}): Promise<{ meterId: string; unitId: string; tenantId: string; base: BaseCtx }> {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, {
        propertyId: base.propertyId, billingMethod: 'submeter',
      })
      await c.query('COMMIT')
    } finally { c.release() }
    await setMeterRateBase(meterId, opts.rate ?? 0.05, opts.base ?? 5)
    const { unitId, tenantId } = await seedUnitWithActiveTenant(base, {
      tenantResponsible: opts.tenantResponsible,
    })
    await attachMeterToUnit(meterId, unitId)
    return { meterId, unitId, tenantId, base }
  }

  it('first cycle, no prior reading → no bill produced (baseline)', async () => {
    const { meterId, base } = await seedSubmeterWithUnit()
    await seedReading(meterId, '2026-05-01', 1000, base.landlordUserId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.reason).toMatch(/no prior reading/)
  })

  // S605 (Nic): "make sure that if we don't have an opening meter read at the
  // minute we are setting up the meters, we can go back through and add the
  // opening read before the billing cycle is done."
  //
  // This is the proof that the recovery path actually works: the same cycle
  // that produced nothing above bills correctly once a BACKDATED opening read
  // is supplied. The prior-read lookup is point-in-time, so what matters is the
  // read's DATE, not when it was typed in.
  it('a backdated opening read added LATER unblocks the same cycle', async () => {
    const { meterId, base } = await seedSubmeterWithUnit({ rate: 0.05, base: 5 })
    await seedReading(meterId, '2026-05-01', 1000, base.landlordUserId)

    // Nothing yet — no starting point.
    const before = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(before.billsCreated).toBe(0)

    // The landlord goes back and enters the opening read, dated BEFORE the
    // cycle read, exactly as the portal does it.
    await db.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1, '2026-04-20', 900, '2026-04-01', 'baseline', $2)`,
      [meterId, base.landlordUserId])

    const after = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(after.billsCreated).toBe(1)          // 1000 − 900 = 100 units
    const { rows } = await db.query<any>(
      `SELECT usage_amount, charge_amount, reading_start, reading_end
         FROM utility_bills WHERE meter_id = $1`, [meterId])
    expect(Number(rows[0].usage_amount)).toBeCloseTo(100, 2)      // 1000 − 900
    expect(Number(rows[0].charge_amount)).toBeCloseTo(100 * 0.05 + 5, 2)
    // The opening read is the bill's starting point, proving it was consumed
    // as the prior reading rather than merely stored.
    expect(Number(rows[0].reading_start)).toBe(900)
    expect(Number(rows[0].reading_end)).toBe(1000)
  })

  // The date is what matters, and getting it wrong is silent. A baseline dated
  // AFTER the cycle read is not a prior read at all, so the cycle still won't
  // bill — the portal defaults the date to the start of the month and tells the
  // landlord to date it before the reads they want to bill, for this reason.
  it('an opening read dated AFTER the cycle read does not unblock it', async () => {
    const { meterId, base } = await seedSubmeterWithUnit()
    await seedReading(meterId, '2026-05-01', 1000, base.landlordUserId)
    await db.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1, '2026-05-20', 900, '2026-05-01', 'baseline', $2)`,
      [meterId, base.landlordUserId])
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.reason).toMatch(/no prior reading/)
  })

  // A baseline must never occupy the one-monthly_cycle-read-per-month slot,
  // or it would displace the real read for that month.
  it('a baseline does not collide with that month\'s cycle read', async () => {
    const { meterId, base } = await seedSubmeterWithUnit()
    await db.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1, '2026-04-20', 900, '2026-04-01', 'baseline', $2)`,
      [meterId, base.landlordUserId])
    // Same billing month, this time the real cycle read — must be accepted.
    await expect(
      seedReading(meterId, '2026-04-01', 950, base.landlordUserId),
    ).resolves.not.toThrow()
  })

  it('negative usage (meter rollback) → noop with reason; no bill', async () => {
    const { meterId, base } = await seedSubmeterWithUnit()
    await seedReading(meterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(meterId, '2026-05-01',  900, base.landlordUserId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.reason).toMatch(/negative usage/)
  })

  it('happy: charge = usage × rate + base_fee', async () => {
    // rate 0.05, base 5, prior 1000, current 1100 → usage 100 → 100*0.05 + 5 = 10
    const { meterId, unitId, base } = await seedSubmeterWithUnit({ rate: 0.05, base: 5 })
    await seedReading(meterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(meterId, '2026-05-01', 1100, base.landlordUserId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(1)
    const { rows: [bill] } = await db.query<any>(
      `SELECT charge_amount, usage_amount, allocation_method, rate_per_unit, base_fee_share
         FROM utility_bills WHERE meter_id=$1 AND unit_id=$2`, [meterId, unitId])
    expect(Number(bill.charge_amount)).toBe(10)
    expect(Number(bill.usage_amount)).toBe(100)
    expect(bill.allocation_method).toBe('submeter')
    expect(Number(bill.rate_per_unit)).toBe(0.05)
    expect(Number(bill.base_fee_share)).toBe(5)
  })

  it('tenant_responsible=FALSE → unit skipped, no bill', async () => {
    const { meterId, base } = await seedSubmeterWithUnit({ tenantResponsible: false })
    await seedReading(meterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(meterId, '2026-05-01', 1100, base.landlordUserId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.unitsSkipped).toBe(1)
  })

  it('no active primary tenant → unit skipped, no bill (landlord absorbs)', async () => {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let meterId = ''
    let unitId  = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, {
        propertyId: base.propertyId, billingMethod: 'submeter',
      })
      unitId = await seedUnit(c, {
        propertyId: base.propertyId, landlordId: base.landlordId,
      })
      await c.query('COMMIT')
    } finally { c.release() }
    await setMeterRateBase(meterId, 0.05, 5)
    await attachMeterToUnit(meterId, unitId)
    await seedReading(meterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(meterId, '2026-05-01', 1100, base.landlordUserId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.unitsSkipped).toBe(1)
  })

  it('idempotent: re-running same cycle skips silently (UNIQUE catches)', async () => {
    const { meterId, base } = await seedSubmeterWithUnit()
    await seedReading(meterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(meterId, '2026-05-01', 1100, base.landlordUserId)
    const r1 = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(r1.billsCreated).toBe(1)
    const r2 = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(r2.billsCreated).toBe(0)
    expect(r2.unitsSkipped).toBe(1)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM utility_bills`)
    expect(rows[0].n).toBe(1)  // only one bill total
  })

  it('cycle isoMonthStart: a non-1st input date still maps to the month start', async () => {
    const { meterId, base } = await seedSubmeterWithUnit()
    await seedReading(meterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(meterId, '2026-05-01', 1100, base.landlordUserId)
    // Pass a mid-month Date; result.cycleMonth should still be 2026-05-01.
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 17))
    expect(res.cycleMonth).toBe('2026-05-01')
  })
})

// ─── rubs ────────────────────────────────────────────────────

describe('generateBillsForMeter — rubs', () => {
  async function seedRubsMeter(base: BaseCtx,
    method: 'equal_split' | 'sqft' | 'bedrooms' | 'occupant_count',
  ): Promise<string> {
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      // submeter→update to rubs to satisfy the rubs/allocation CHECK.
      meterId = await seedUtilityMeter(c, {
        propertyId: base.propertyId, billingMethod: 'submeter',
      })
      await c.query('COMMIT')
    } finally { c.release() }
    await setMeterRubs(meterId, method)
    return meterId
  }

  it('equal_split: 3 units → each gets totalCharge / 3', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedRubsMeter(base, 'equal_split')
    await setMeterRateBase(meterId, 1, 30)  // rate 1, base 30
    const u1 = await seedUnitWithActiveTenant(base)
    const u2 = await seedUnitWithActiveTenant(base)
    const u3 = await seedUnitWithActiveTenant(base)
    await attachMeterToUnit(meterId, u1.unitId)
    await attachMeterToUnit(meterId, u2.unitId)
    await attachMeterToUnit(meterId, u3.unitId)
    await seedReading(meterId, '2026-05-01', 90, base.landlordUserId)
    // totalCharge = 90 * 1 + 30 = 120; each unit → 40
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(3)
    const { rows } = await db.query<any>(
      `SELECT charge_amount, base_fee_share, allocation_method, allocation_basis
         FROM utility_bills WHERE meter_id=$1`, [meterId])
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(Number(r.charge_amount)).toBe(40)
      expect(Number(r.base_fee_share)).toBe(10)  // 30/3
      expect(r.allocation_method).toBe('equal_split')
      expect(Number(r.allocation_basis)).toBe(1)
    }
  })

  it('sqft: bills split by sqft ratio', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedRubsMeter(base, 'sqft')
    await setMeterRateBase(meterId, 1, 0)  // simplify: no base fee
    const u1 = await seedUnitWithActiveTenant(base, { sqft: 500 })
    const u2 = await seedUnitWithActiveTenant(base, { sqft: 1500 })
    await attachMeterToUnit(meterId, u1.unitId)
    await attachMeterToUnit(meterId, u2.unitId)
    await seedReading(meterId, '2026-05-01', 200, base.landlordUserId)
    // totalCharge = 200; total sqft = 2000; u1 share 0.25 → 50, u2 share 0.75 → 150
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(2)
    const { rows: [b1] } = await db.query<any>(
      `SELECT charge_amount FROM utility_bills WHERE unit_id=$1`, [u1.unitId])
    const { rows: [b2] } = await db.query<any>(
      `SELECT charge_amount FROM utility_bills WHERE unit_id=$1`, [u2.unitId])
    expect(Number(b1.charge_amount)).toBe(50)
    expect(Number(b2.charge_amount)).toBe(150)
  })

  it('reconciles rounding: uneven split sums EXACTLY to the pool; remainder on the lowest bill (S587)', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedRubsMeter(base, 'sqft')
    await setMeterRateBase(meterId, 1, 0)  // rate 1, no base fee
    const u1 = await seedUnitWithActiveTenant(base, { sqft: 100 })
    const u2 = await seedUnitWithActiveTenant(base, { sqft: 150 })
    const u3 = await seedUnitWithActiveTenant(base, { sqft: 151 })
    await attachMeterToUnit(meterId, u1.unitId)
    await attachMeterToUnit(meterId, u2.unitId)
    await attachMeterToUnit(meterId, u3.unitId)
    await seedReading(meterId, '2026-05-01', 100, base.landlordUserId)
    // totalCharge = 100; total sqft 401. Naive round2 shares = 24.94 + 37.41 +
    // 37.66 = 100.01, so reconciliation trims 0.01 off the LOWEST bill (u1) →
    // 24.93, and the three bills sum to exactly 100.00 (no penny lost).
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(3)
    const { rows } = await db.query<any>(
      `SELECT unit_id, charge_amount FROM utility_bills WHERE meter_id=$1`, [meterId])
    const sum = rows.reduce((s: number, r: any) => s + Number(r.charge_amount), 0)
    expect(Math.round(sum * 100) / 100).toBe(100)
    const lowest = rows.reduce((lo: any, r: any) =>
      Number(r.charge_amount) < Number(lo.charge_amount) ? r : lo, rows[0])
    expect(lowest.unit_id).toBe(u1.unitId)
    expect(Number(lowest.charge_amount)).toBe(24.93)
  })

  it('bedrooms: bills split by bedroom ratio', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedRubsMeter(base, 'bedrooms')
    await setMeterRateBase(meterId, 1, 0)
    const u1 = await seedUnitWithActiveTenant(base, { bedrooms: 1 })
    const u2 = await seedUnitWithActiveTenant(base, { bedrooms: 3 })
    await attachMeterToUnit(meterId, u1.unitId)
    await attachMeterToUnit(meterId, u2.unitId)
    await seedReading(meterId, '2026-05-01', 100, base.landlordUserId)
    // total bedrooms 4; u1 share 0.25 → 25, u2 share 0.75 → 75
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(2)
    const { rows: [b1] } = await db.query<any>(
      `SELECT charge_amount FROM utility_bills WHERE unit_id=$1`, [u1.unitId])
    const { rows: [b2] } = await db.query<any>(
      `SELECT charge_amount FROM utility_bills WHERE unit_id=$1`, [u2.unitId])
    expect(Number(b1.charge_amount)).toBe(25)
    expect(Number(b2.charge_amount)).toBe(75)
  })

  it('occupant_count: bills split by active-tenant count', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedRubsMeter(base, 'occupant_count')
    await setMeterRateBase(meterId, 1, 0)
    const u1 = await seedUnitWithActiveTenant(base)  // 1 primary tenant
    const u2 = await seedUnitWithActiveTenant(base)  // 1 primary tenant
    // Add a co-tenant on u2 → 2 occupants there.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const t2 = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: u2.leaseId, tenantId: t2, role: 'co_tenant' })
      await c.query('COMMIT')
    } finally { c.release() }
    await attachMeterToUnit(meterId, u1.unitId)
    await attachMeterToUnit(meterId, u2.unitId)
    await seedReading(meterId, '2026-05-01', 90, base.landlordUserId)
    // total occupants 3; u1 1/3 → 30, u2 2/3 → 60
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(2)
    const { rows: [b1] } = await db.query<any>(
      `SELECT charge_amount FROM utility_bills WHERE unit_id=$1`, [u1.unitId])
    const { rows: [b2] } = await db.query<any>(
      `SELECT charge_amount FROM utility_bills WHERE unit_id=$1`, [u2.unitId])
    expect(Number(b1.charge_amount)).toBe(30)
    expect(Number(b2.charge_amount)).toBe(60)
  })

  it('total basis = 0 → noop with reason (e.g., sqft method but all units sqft null)', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedRubsMeter(base, 'sqft')
    await setMeterRateBase(meterId, 1, 0)
    const u1 = await seedUnitWithActiveTenant(base)  // sqft NULL
    const u2 = await seedUnitWithActiveTenant(base)
    await attachMeterToUnit(meterId, u1.unitId)
    await attachMeterToUnit(meterId, u2.unitId)
    await seedReading(meterId, '2026-05-01', 100, base.landlordUserId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.reason).toMatch(/basis sums to zero/)
  })

  it('zero-basis unit skipped; others still billed', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedRubsMeter(base, 'bedrooms')
    await setMeterRateBase(meterId, 1, 0)
    const u1 = await seedUnitWithActiveTenant(base, { bedrooms: 2 })
    const u2 = await seedUnitWithActiveTenant(base)  // bedrooms default 1
    // Force u2 bedrooms to 0 — explicit zero basis.
    await db.query(`UPDATE units SET bedrooms=0 WHERE id=$1`, [u2.unitId])
    await attachMeterToUnit(meterId, u1.unitId)
    await attachMeterToUnit(meterId, u2.unitId)
    await seedReading(meterId, '2026-05-01', 100, base.landlordUserId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    // u1 gets all 100 (sole basis); u2 skipped
    expect(res.billsCreated).toBe(1)
    expect(res.unitsSkipped).toBe(1)
    const { rows: [b1] } = await db.query<any>(
      `SELECT charge_amount FROM utility_bills WHERE unit_id=$1`, [u1.unitId])
    expect(Number(b1.charge_amount)).toBe(100)
  })
})

// ─── S558: RUBS metered exclusion (UNIT-DRIVEN) ──────────────
// A master serves a set of units; any served unit that has its OWN same-utility
// submeter is billed on that submeter and subtracted from the pool — derived
// from shared UNIT membership, no manual link.

describe('generateBillsForMeter — rubs metered exclusion (S558)', () => {
  // A RUBS master + a submetered unit (the MH): the submeter and the master
  // both serve mhUnitId, so the master auto-excludes it.
  async function seedMasterWithSubmeteredUnit(base: BaseCtx): Promise<{ masterId: string; submeterId: string; mhUnitId: string }> {
    const c = await db.connect()
    let masterId = '', submeterId = ''
    try {
      await c.query('BEGIN')
      masterId   = await seedUtilityMeter(c, { propertyId: base.propertyId, billingMethod: 'submeter' })
      submeterId = await seedUtilityMeter(c, { propertyId: base.propertyId, billingMethod: 'submeter' })
      await c.query('COMMIT')
    } finally { c.release() }
    await setMeterRubs(masterId, 'occupant_count')
    await setMeterRateBase(masterId, 0.01, 0) // 1¢/gal, no base fee (Oak Park)
    await setMeterRateBase(submeterId, 0.01, 0)
    const mh = await seedUnitWithActiveTenant(base)
    await attachMeterToUnit(submeterId, mh.unitId) // the MH's own submeter
    await attachMeterToUnit(masterId, mh.unitId)   // …and it's also on the master
    return { masterId, submeterId, mhUnitId: mh.unitId }
  }

  it('pool = master − submetered-unit usage, split across the un-submetered units', async () => {
    const base = await seedBaseProperty()
    const { masterId, submeterId, mhUnitId } = await seedMasterWithSubmeteredUnit(base)
    const u1 = await seedUnitWithActiveTenant(base) // 1 occupant, no submeter
    const u2 = await seedUnitWithActiveTenant(base) // 1 occupant, no submeter
    await attachMeterToUnit(masterId, u1.unitId)
    await attachMeterToUnit(masterId, u2.unitId)
    // MH submeter usage this cycle: 1000 → 1100 = 100 gal, excluded from pool.
    await seedReading(submeterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(submeterId, '2026-05-01', 1100, base.landlordUserId)
    // Master period usage = 300 → pool = 300 − 100 = 200 → 100 gal each × 1¢ = $1.
    await seedReading(masterId, '2026-05-01', 300, base.landlordUserId)
    const res = await generateBillsForMeter(masterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(2) // only u1, u2 — the MH is excluded
    const { rows } = await db.query<any>(`SELECT unit_id, charge_amount FROM utility_bills WHERE meter_id=$1`, [masterId])
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(Number(r.charge_amount)).toBe(1)
    // the master never bills the submetered unit
    expect(rows.some((r: any) => r.unit_id === mhUnitId)).toBe(false)
  })

  // S605 (Nic, DIRECTIVE) — these two tests previously asserted that the master
  // did NOT bill. That behaviour is now the bug: "if one water meter is broken
  // or not spinning, or somebody was on vacation... it still needs to bill the
  // water out." One unreadable submeter cost the landlord the entire property's
  // water bill for the month.
  it('STILL BILLS when a submeter on one of the master units has no reading', async () => {
    const base = await seedBaseProperty()
    const { masterId, submeterId } = await seedMasterWithSubmeteredUnit(base)
    await attachMeterToUnit(masterId, (await seedUnitWithActiveTenant(base)).unitId)
    await seedReading(submeterId, '2026-04-01', 1000, base.landlordUserId) // prior only
    await seedReading(masterId, '2026-05-01', 300, base.landlordUserId)
    const res = await generateBillsForMeter(masterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBeGreaterThan(0)
    // and it must SAY what it had to infer, rather than passing silently
    expect(res.reason).toMatch(/estimated/i)
  })

  it('STILL BILLS when a submeter read is flagged for double-check', async () => {
    const base = await seedBaseProperty()
    const { masterId, submeterId } = await seedMasterWithSubmeteredUnit(base)
    await attachMeterToUnit(masterId, (await seedUnitWithActiveTenant(base)).unitId)
    await seedReading(submeterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(submeterId, '2026-05-01', 1100, base.landlordUserId)
    await db.query(
      `UPDATE utility_meter_readings SET needs_review = TRUE
        WHERE meter_id = $1 AND billing_cycle_month = '2026-05-01'`, [submeterId])
    await seedReading(masterId, '2026-05-01', 300, base.landlordUserId)
    const res = await generateBillsForMeter(masterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBeGreaterThan(0)
    expect(res.reason).toMatch(/estimated/i)
  })

  // A zero-usage read is LEGITIMATE (an empty spot, a tenant away all month) and
  // must not be treated as a failure at all.
  it('a zero-usage submeter read is normal — bills with a full pool', async () => {
    const base = await seedBaseProperty()
    const { masterId, submeterId } = await seedMasterWithSubmeteredUnit(base)
    await attachMeterToUnit(masterId, (await seedUnitWithActiveTenant(base)).unitId)
    await seedReading(submeterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(submeterId, '2026-05-01', 1000, base.landlordUserId) // usage 0
    await seedReading(masterId, '2026-05-01', 300, base.landlordUserId)
    const res = await generateBillsForMeter(masterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBeGreaterThan(0)
    expect(res.reason).toBeUndefined()   // nothing was estimated
  })

  it('STILL BILLS when submetered usage exceeds the master reading (bad reading)', async () => {
    const base = await seedBaseProperty()
    const { masterId, submeterId } = await seedMasterWithSubmeteredUnit(base)
    await attachMeterToUnit(masterId, (await seedUnitWithActiveTenant(base)).unitId)
    await seedReading(submeterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(submeterId, '2026-05-01', 1400, base.landlordUserId) // usage 400
    await seedReading(masterId, '2026-05-01', 300, base.landlordUserId)   // master 300 < 400
    const res = await generateBillsForMeter(masterId, new Date(2026, 4, 1))
    // Pool clamps to zero rather than going negative; the base fee still bills.
    expect(res.billsCreated).toBeGreaterThan(0)
    expect(res.reason).toMatch(/exceeded the master reading/i)
  })
})

// ─── S558: flat-rate ─────────────────────────────────────────

describe('generateBillsForMeter — flat_rate (S558)', () => {
  async function seedFlatMeter(base: BaseCtx, flatAmount: number): Promise<string> {
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: base.propertyId, billingMethod: 'submeter' })
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(`UPDATE utility_meters SET billing_method='flat_rate' WHERE id=$1`, [meterId])
    await setMeterRateBase(meterId, 0, flatAmount) // flat amount lives on base_fee
    return meterId
  }

  it('bills each responsible unit the flat amount, no reading needed', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedFlatMeter(base, 20) // $20/unit trash
    const u1 = await seedUnitWithActiveTenant(base)
    const u2 = await seedUnitWithActiveTenant(base)
    await attachMeterToUnit(meterId, u1.unitId)
    await attachMeterToUnit(meterId, u2.unitId)
    // No reading seeded — flat rate doesn't need one.
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(2)
    const { rows } = await db.query<any>(
      `SELECT charge_amount, allocation_method, usage_amount FROM utility_bills WHERE meter_id=$1`, [meterId])
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(Number(r.charge_amount)).toBe(20)
      expect(r.allocation_method).toBe('flat_rate')
      expect(r.usage_amount).toBeNull()
    }
  })

  it('tenant_responsible=FALSE → that unit is skipped', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedFlatMeter(base, 20)
    const u1 = await seedUnitWithActiveTenant(base, { tenantResponsible: false })
    await attachMeterToUnit(meterId, u1.unitId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.unitsSkipped).toBe(1)
  })

  it('no amount set (base fee 0) → noop with reason', async () => {
    const base = await seedBaseProperty()
    const meterId = await seedFlatMeter(base, 0)
    await attachMeterToUnit(meterId, (await seedUnitWithActiveTenant(base)).unitId)
    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(0)
    expect(res.reason).toMatch(/no amount/i)
  })
})

// ─── property + landlord helpers ─────────────────────────────

describe('generateBillsForProperty', () => {
  it('invokes generateBillsForMeter for every meter on the property', async () => {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let m1 = '', m2 = ''
    try {
      await c.query('BEGIN')
      m1 = await seedUtilityMeter(c, {
        propertyId: base.propertyId, utilityType: 'water',
      })
      m2 = await seedUtilityMeter(c, {
        propertyId: base.propertyId, utilityType: 'gas',
        billingMethod: 'master_bill_to_landlord',
      })
      await c.query('COMMIT')
    } finally { c.release() }
    const results = await generateBillsForProperty(
      base.propertyId, new Date(2026, 4, 1))
    expect(results).toHaveLength(2)
    const ids = results.map(r => r.meterId).sort()
    expect(ids).toEqual([m1, m2].sort())
  })

  it('property with no meters → empty array', async () => {
    const base = await seedBaseProperty()
    const results = await generateBillsForProperty(
      base.propertyId, new Date(2026, 4, 1))
    expect(results).toEqual([])
  })
})

describe('generateBillsForLandlord', () => {
  it('invokes generateBillsForMeter for every meter across all the landlord\'s properties', async () => {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let p2 = '', m1 = '', m2 = ''
    try {
      await c.query('BEGIN')
      p2 = await seedProperty(c, {
        landlordId: base.landlordId,
        ownerUserId: base.landlordUserId,
        managedByUserId: base.landlordUserId,
      })
      m1 = await seedUtilityMeter(c, { propertyId: base.propertyId })
      m2 = await seedUtilityMeter(c, { propertyId: p2 })
      await c.query('COMMIT')
    } finally { c.release() }
    const results = await generateBillsForLandlord(
      base.landlordId, new Date(2026, 4, 1))
    expect(results).toHaveLength(2)
    const ids = results.map(r => r.meterId).sort()
    expect(ids).toEqual([m1, m2].sort())
  })

  it('unknown landlord → empty array (no meters joined)', async () => {
    const results = await generateBillsForLandlord(
      randomUUID(), new Date(2026, 4, 1))
    expect(results).toEqual([])
  })
})

// ─── S559: point-in-time baseline + broken-meter comparable-low ──────────

/** Insert a reading with an explicit date + reason (the seedReading helper
 *  above always stamps monthly_cycle on the 1st). */
async function seedReadingAt(
  meterId: string, readingDate: string, cycleMonthIso: string, value: number,
  reason: string, landlordUserId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO utility_meter_readings
       (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [meterId, readingDate, value, cycleMonthIso, landlordUserId, reason])
}

describe('S559 point-in-time baseline reset', () => {
  it('a mid-month turnover read becomes the baseline — the cycle bills from IT, not last month', async () => {
    const base = await seedBaseProperty()
    const { unitId } = await seedUnitWithActiveTenant(base, { tenantResponsible: true })
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: base.propertyId, utilityType: 'water' })
      await c.query('COMMIT')
    } finally { c.release() }
    await attachMeterToUnit(meterId, unitId)
    await setMeterRateBase(meterId, 1, 0) // $1/unit, no base fee → charge == usage

    // June cycle read = 100 (baseline). Mid-July turnover reference read = 150.
    // July cycle read = 200. Point-in-time usage = 200 − 150 = 50, NOT 100.
    await seedReadingAt(meterId, '2026-06-30', '2026-06-01', 100, 'monthly_cycle', base.landlordUserId)
    await seedReadingAt(meterId, '2026-07-10', '2026-07-01', 150, 'stay_turnover', base.landlordUserId)
    await seedReadingAt(meterId, '2026-07-31', '2026-07-01', 200, 'monthly_cycle', base.landlordUserId)

    const res = await generateBillsForMeter(meterId, new Date(2026, 6, 1))
    expect(res.billsCreated).toBe(1)
    const bill = await db.query(
      `SELECT usage_amount, charge_amount FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = '2026-07-01'`,
      [meterId])
    expect(Number(bill.rows[0].usage_amount)).toBe(50)
    expect(Number(bill.rows[0].charge_amount)).toBe(50)
  })
})

describe('S559 broken-meter comparable-low billing', () => {
  it('a broken submeter bills the LOWEST comparable usage (same property + unit type), as a normal charge', async () => {
    const base = await seedBaseProperty()
    // Two comparable units (default unit_type/amp match). One good meter with
    // real usage of 120; one broken meter with no read.
    const good = await seedUnitWithActiveTenant(base, { tenantResponsible: true })
    const broken = await seedUnitWithActiveTenant(base, { tenantResponsible: true })
    const c = await db.connect()
    let goodMeter = '', brokenMeter = ''
    try {
      await c.query('BEGIN')
      goodMeter = await seedUtilityMeter(c, { propertyId: base.propertyId, utilityType: 'water' })
      brokenMeter = await seedUtilityMeter(c, { propertyId: base.propertyId, utilityType: 'water' })
      await c.query('COMMIT')
    } finally { c.release() }
    await attachMeterToUnit(goodMeter, good.unitId)
    await attachMeterToUnit(brokenMeter, broken.unitId)
    await setMeterRateBase(goodMeter, 1, 0)
    await setMeterRateBase(brokenMeter, 2, 0) // broken meter's own rate = $2/unit
    await db.query(`UPDATE utility_meters SET out_of_service = true WHERE id = $1`, [brokenMeter])

    // Good meter: June 100 → July 220 = 120 usage.
    await seedReadingAt(goodMeter, '2026-06-30', '2026-06-01', 100, 'monthly_cycle', base.landlordUserId)
    await seedReadingAt(goodMeter, '2026-07-31', '2026-07-01', 220, 'monthly_cycle', base.landlordUserId)

    const res = await generateBillsForMeter(brokenMeter, new Date(2026, 6, 1))
    expect(res.billsCreated).toBe(1)
    const bill = await db.query(
      `SELECT usage_amount, charge_amount, allocation_method FROM utility_bills WHERE meter_id = $1`,
      [brokenMeter])
    expect(Number(bill.rows[0].usage_amount)).toBe(120)      // lowest comparable
    expect(Number(bill.rows[0].charge_amount)).toBe(240)     // 120 × $2
    expect(bill.rows[0].allocation_method).toBe('comparable_low')
  })

  it('a broken submeter with no comparable usage produces no bill (never invents a number)', async () => {
    const base = await seedBaseProperty()
    const broken = await seedUnitWithActiveTenant(base, { tenantResponsible: true })
    const c = await db.connect()
    let brokenMeter = ''
    try {
      await c.query('BEGIN')
      brokenMeter = await seedUtilityMeter(c, { propertyId: base.propertyId, utilityType: 'water' })
      await c.query('COMMIT')
    } finally { c.release() }
    await attachMeterToUnit(brokenMeter, broken.unitId)
    await setMeterRateBase(brokenMeter, 2, 0)
    await db.query(`UPDATE utility_meters SET out_of_service = true WHERE id = $1`, [brokenMeter])

    const res = await generateBillsForMeter(brokenMeter, new Date(2026, 6, 1))
    expect(res.billsCreated).toBe(0)
  })
})

// ── S560: move-out read odometer rollover bills the wrapped usage ────────────
describe('S560 billMoveOutRead odometer rollover', () => {
  it('a below-previous move-out read bills the wrapped usage, not $0', async () => {
    const base = await seedBaseProperty()
    const { unitId } = await seedUnitWithActiveTenant(base, { tenantResponsible: true })
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: base.propertyId, utilityType: 'water' })
      await c.query('COMMIT')
    } finally { c.release() }
    await attachMeterToUnit(meterId, unitId)
    await setMeterRateBase(meterId, 1, 0) // $1/unit

    // Prior read near the top of a 6-digit meter, then a move-out read that wrapped.
    await seedReadingAt(meterId, '2026-06-30', '2026-06-01', 999500, 'monthly_cycle', base.landlordUserId)
    const { rows: [mo] } = await db.query<any>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-07-15', 300, '2026-07-01', $2, 'move_out_final') RETURNING id`,
      [meterId, base.landlordUserId])

    const r = await billMoveOutRead(meterId, mo.id)
    expect(r.billed).toBe(true)
    const bill = await db.query<any>(
      `SELECT usage_amount, charge_amount FROM utility_bills WHERE meter_id = $1`, [meterId])
    expect(Number(bill.rows[0].usage_amount)).toBe(800)   // (1e6 - 999500) + 300
    expect(Number(bill.rows[0].charge_amount)).toBe(800)
  })

  it('S561 guard: below-previous read with prior NOT near the ceiling → refused, not billed a phantom wrap', async () => {
    const base = await seedBaseProperty()
    const { unitId } = await seedUnitWithActiveTenant(base, { tenantResponsible: true })
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: base.propertyId, utilityType: 'water' })
      await c.query('COMMIT')
    } finally { c.release() }
    await attachMeterToUnit(meterId, unitId)
    await setMeterRateBase(meterId, 1, 0)

    // Prior read mid-range (5000, nowhere near a 6-digit meter's ceiling), then a
    // below-prior move-out read — that's a typo, not a rollover.
    await seedReadingAt(meterId, '2026-06-30', '2026-06-01', 5000, 'monthly_cycle', base.landlordUserId)
    const { rows: [mo] } = await db.query<any>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-07-15', 300, '2026-07-01', $2, 'move_out_final') RETURNING id`,
      [meterId, base.landlordUserId])

    const r = await billMoveOutRead(meterId, mo.id)
    expect(r.billed).toBe(false)
    expect(r.reason).toMatch(/re-check|mis-entered|not near/i)
    const bill = await db.query<any>(`SELECT id FROM utility_bills WHERE meter_id = $1`, [meterId])
    expect(bill.rows.length).toBe(0)   // no phantom 995k-unit bill
  })
})


// ── S605 (Nic, DIRECTIVE): property-level utility rates ─────────────────────
// "Make utility rates set at the property level. Adding each unit is redundant
// and possible discrimination."
describe('S605 property utility rates', () => {
  // Local copy — the identically-named helper lives inside another describe and
  // isn't in scope here.
  async function seedSubmeterWithUnit(opts: { rate?: number; base?: number } = {}) {
    const base = await seedBaseProperty()
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: base.propertyId, billingMethod: 'submeter' })
      await c.query('COMMIT')
    } finally { c.release() }
    await setMeterRateBase(meterId, opts.rate ?? 0.05, opts.base ?? 0)
    const { unitId } = await seedUnitWithActiveTenant(base, {})
    await attachMeterToUnit(meterId, unitId)
    return { meterId, unitId, base }
  }

  it('the PROPERTY rate overrides whatever the meter carries', async () => {
    const { meterId, base } = await seedSubmeterWithUnit({ rate: 0.05, base: 0 })
    await db.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
       VALUES ($1, (SELECT utility_type FROM utility_meters WHERE id=$2), 0.25, 0)`,
      [base.propertyId, meterId])
    await seedReading(meterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(meterId, '2026-05-01', 1100, base.landlordUserId)   // 100 units

    const res = await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    expect(res.billsCreated).toBe(1)
    const { rows } = await db.query<any>(
      `SELECT charge_amount, rate_per_unit FROM utility_bills WHERE meter_id=$1`, [meterId])
    expect(Number(rows[0].rate_per_unit)).toBeCloseTo(0.25, 5)   // property policy, not 0.05
    expect(Number(rows[0].charge_amount)).toBeCloseTo(100 * 0.25, 2)
  })

  // THE ANTI-DISCRIMINATION PROPERTY: two units on the same property, whose
  // meters were entered with DIFFERENT rates, must bill at the same price.
  it('two units with different meter rates bill identically under property policy', async () => {
    const a = await seedSubmeterWithUnit({ rate: 0.05, base: 0 })
    const propertyId = a.base.propertyId
    // A second unit + submeter at the SAME property, typed in at another rate.
    const c = await db.connect()
    let meterB = ''
    try {
      await c.query('BEGIN')
      meterB = await seedUtilityMeter(c, { propertyId, billingMethod: 'submeter' })
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(`UPDATE utility_meters SET rate_per_unit=0.90, base_fee=0 WHERE id=$1`, [meterB])
    const unitB = await seedUnitWithActiveTenant(a.base, {})
    await attachMeterToUnit(meterB, unitB.unitId)

    await db.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
       VALUES ($1, (SELECT utility_type FROM utility_meters WHERE id=$2), 0.30, 0)
       ON CONFLICT (property_id, utility_type) DO UPDATE SET rate_per_unit=0.30`,
      [propertyId, a.meterId])

    for (const m of [a.meterId, meterB]) {
      await seedReading(m, '2026-04-01', 1000, a.base.landlordUserId)
      await seedReading(m, '2026-05-01', 1100, a.base.landlordUserId)
      await generateBillsForMeter(m, new Date(2026, 4, 1))
    }
    const { rows } = await db.query<any>(
      `SELECT DISTINCT rate_per_unit FROM utility_bills WHERE meter_id = ANY($1)`,
      [[a.meterId, meterB]])
    expect(rows).toHaveLength(1)                       // ONE rate across both tenants
    expect(Number(rows[0].rate_per_unit)).toBeCloseTo(0.30, 5)
  })

  // A property that has only configured water must not zero out electric.
  it('a rate set for one utility leaves the others on their meter rate', async () => {
    const { meterId, base } = await seedSubmeterWithUnit({ rate: 0.05, base: 0 })
    await db.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
       VALUES ($1, 'trash', 9.99, 0)`, [base.propertyId])
    await seedReading(meterId, '2026-04-01', 1000, base.landlordUserId)
    await seedReading(meterId, '2026-05-01', 1100, base.landlordUserId)
    await generateBillsForMeter(meterId, new Date(2026, 4, 1))
    const { rows } = await db.query<any>(
      `SELECT rate_per_unit FROM utility_bills WHERE meter_id=$1`, [meterId])
    expect(Number(rows[0].rate_per_unit)).toBeCloseTo(0.05, 5)   // untouched
  })
})
