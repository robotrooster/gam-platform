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
