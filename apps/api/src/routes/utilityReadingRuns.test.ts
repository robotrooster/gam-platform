/**
 * Reading runs — end-of-month meter workflow (S532, redesigned S533).
 *
 * Flow under test:
 *   main walk (blind, silent flags) → verification phase (system-built
 *   blind re-read list: all suspects + random pads to ≥6) → automatic
 *   reconciliation → billing. Landlord only sees true escalations
 *   (re-read-confirmed below-previous: rollover vs meter swap).
 *
 * Uses the REAL utilityBilling engine — reconciliation → billing is the
 * integration seam this workflow exists for.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'
import { lastBusinessDayOfMonth } from '../services/utilityReadingRuns'
import { generateInvoices } from '../jobs/invoiceGeneration'
import { generateBillsForMeter } from '../services/utilityBilling'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_utility_runs'
})

const CYCLE = '2026-07-01'

interface Fixture {
  landlordAUserId: string
  landlordAId: string
  landlordBId: string
  propertyAId: string
  unitAId: string
  unit2Id: string
  tenantAId: string
  leaseAId: string
  meterLeased: string   // unitA — active lease, tenant-responsible electric, baseline 1000
  meterVacant: string   // unit2 — no lease, baseline 500
  tokenA: string
  tokenB: string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const unit2 = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const tenantA = await seedTenant(c)
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: aId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA })
    await c.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
       VALUES ($1, 'electric', TRUE)`, [leaseA])

    const meterLeased = await seedUtilityMeter(c, { propertyId: propA, utilityType: 'electric', billingMethod: 'submeter' })
    const meterVacant = await seedUtilityMeter(c, { propertyId: propA, utilityType: 'electric', billingMethod: 'submeter' })
    await c.query(`UPDATE utility_meters SET rate_per_unit = 0.14, base_fee = 0 WHERE id IN ($1, $2)`,
      [meterLeased, meterVacant])
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2), ($3, $4)`,
      [meterLeased, unitA, meterVacant, unit2])
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
       VALUES ($1, '2026-06-30', 1000, '2026-06-01', $3), ($2, '2026-06-30', 500, '2026-06-01', $3)`,
      [meterLeased, meterVacant, aUid])
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid,
      landlordAId: aId, landlordBId: bId, propertyAId: propA,
      unitAId: unitA, unit2Id: unit2, tenantAId: tenantA, leaseAId: leaseA,
      meterLeased, meterVacant,
      tokenA: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      tokenB: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

const openRun = async (app: express.Express, f: Fixture) => {
  const res = await request(app)
    .post('/api/utility/reading-runs')
    .set('Authorization', `Bearer ${f.tokenA}`)
    .send({ propertyId: f.propertyAId, cycleMonth: CYCLE })
  expect(res.status).toBe(201)
  return res.body.data
}

const enterReading = (app: express.Express, f: Fixture, runId: string, meterId: string, value: number) =>
  request(app)
    .post(`/api/utility/reading-runs/${runId}/meters/${meterId}/reading`)
    .set('Authorization', `Bearer ${f.tokenA}`)
    .send({ readingValue: value })

const enterDC = (app: express.Express, f: Fixture, runId: string, meterId: string, value: number) =>
  request(app)
    .post(`/api/utility/reading-runs/${runId}/double-checks/${meterId}`)
    .set('Authorization', `Bearer ${f.tokenA}`)
    .send({ readingValue: value })

const getDCs = (app: express.Express, f: Fixture, runId: string) =>
  request(app)
    .get(`/api/utility/reading-runs/${runId}/double-checks`)
    .set('Authorization', `Bearer ${f.tokenA}`)

/** Run the main walk with both fixture meters, landing in double_check. */
async function mainWalk(app: express.Express, f: Fixture, run: any, leasedVal: number, vacantVal: number) {
  const r1 = await enterReading(app, f, run.id, f.meterLeased, leasedVal)
  expect(r1.status).toBe(201)
  const r2 = await enterReading(app, f, run.id, f.meterVacant, vacantVal)
  expect(r2.status).toBe(201)
  expect(r2.body.data.run.status).toBe('double_check')
  return r2.body.data
}

describe('lastBusinessDayOfMonth', () => {
  it('returns the plain last weekday when nothing intervenes', () => {
    expect(lastBusinessDayOfMonth(2026, 7)).toBe('2026-07-31') // Friday
  })
  it('walks back over a weekend month-end', () => {
    expect(lastBusinessDayOfMonth(2027, 1)).toBe('2027-01-29') // Jan 31 Sun → 30 Sat → 29 Fri
  })
  it('walks a federal holiday, then continues past the weekend behind it', () => {
    // May 31 2027 = Memorial Day (Mon) → 30 Sun → 29 Sat → 28 Fri
    expect(lastBusinessDayOfMonth(2027, 5)).toBe('2027-05-28')
  })
})

describe('POST /api/utility/reading-runs', () => {
  it('opens a run and is idempotent per property + cycle', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    expect(run.status).toBe('open')
    const again = await request(app)
      .post('/api/utility/reading-runs')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, cycleMonth: CYCLE })
    expect(again.body.data.id).toBe(run.id)
  })

  it('400s when the property has no readable meters', async () => {
    const app = buildApp()
    const f = await seed()
    let bareProp: string
    const c2 = await db.connect()
    try {
      await c2.query('BEGIN')
      const prop = await seedProperty(c2, { landlordId: f.landlordAId, ownerUserId: f.landlordAUserId, managedByUserId: f.landlordAUserId })
      await seedUtilityMeter(c2, { propertyId: prop, billingMethod: 'master_bill_to_landlord' })
      await c2.query('COMMIT')
      bareProp = prop
    } finally { c2.release() }
    const res = await request(app)
      .post('/api/utility/reading-runs')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: bareProp!, cycleMonth: CYCLE })
    expect(res.status).toBe(400)
  })

  it("403s opening a run on another landlord's property", async () => {
    const app = buildApp()
    const f = await seed()
    const res = await request(app)
      .post('/api/utility/reading-runs')
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ propertyId: f.propertyAId, cycleMonth: CYCLE })
    expect(res.status).toBe(403)
  })
})

describe('blind entry', () => {
  it('walk payload has no reading values, no prior values, no flags', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    const meters = await request(app)
      .get(`/api/utility/reading-runs/${run.id}/meters`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(meters.status).toBe(200)
    expect(meters.body.data).toHaveLength(2)
    expect(JSON.stringify(meters.body.data)).not.toMatch(/reading_value|prior|needs_review/)
  })

  it('rejects values over the meter capacity; decimals and negatives 400', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    for (const bad of [1250.5, -3, 1000000]) {
      const res = await enterReading(app, f, run.id, f.meterLeased, bad)
      expect(res.status, `readingValue ${bad}`).toBe(400)
    }
  })

  it('a below-prior entry gets an indistinguishable 201 and a silent flag', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    const res = await enterReading(app, f, run.id, f.meterLeased, 900) // wrap ≥ half range → suspect
    expect(res.status).toBe(201)
    expect(JSON.stringify(res.body)).not.toMatch(/needs_review|review_note|reading_value/)
    const row = await db.query(
      `SELECT needs_review FROM utility_meter_readings WHERE meter_id = $1 AND billing_cycle_month = $2`,
      [f.meterLeased, CYCLE])
    expect(row.rows[0].needs_review).toBe(true)
  })
})

describe('verification phase', () => {
  it('main-walk completion builds the blind list (all meters when fewer than the minimum) — no bills yet', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    const done = await mainWalk(app, f, run, 1250, 560)
    expect(done.dcTotal).toBe(2) // only 2 submeters exist — both listed
    const dcs = await getDCs(app, f, run.id)
    expect(dcs.body.data).toHaveLength(2)
    // Blind: no first values, no suspicion markers.
    expect(JSON.stringify(dcs.body.data)).not.toMatch(/first_value|is_suspicious|reading_value/)
    const bills = await db.query(`SELECT id FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(bills.rows).toHaveLength(0)
  })

  it('re-read within 1-2 units: the FIRST read stands for billing; drift bills next cycle', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    await mainWalk(app, f, run, 1250, 560)
    await enterDC(app, f, run.id, f.meterLeased, 1252) // meter moved 2 between reads
    const done = await enterDC(app, f, run.id, f.meterVacant, 561)
    expect(done.body.data.run.status).toBe('completed')
    // Billed from 1250, NOT 1252: usage 250 × $0.14 = $35.00.
    const bills = await db.query(
      `SELECT usage_amount, charge_amount, status FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(bills.rows).toHaveLength(1)
    expect(Number(bills.rows[0].usage_amount)).toBe(250)
    expect(Number(bills.rows[0].charge_amount)).toBeCloseTo(35.0, 2)
    expect(bills.rows[0].status).toBe('billed')
    const reading = await db.query(
      `SELECT reading_value FROM utility_meter_readings WHERE meter_id = $1 AND billing_cycle_month = $2`,
      [f.meterLeased, CYCLE])
    expect(Number(reading.rows[0].reading_value)).toBe(1250) // second read silently ignored
    // Tenant-invoice transparency: bill snapshots begin/end reads.
    const snap = await db.query(
      `SELECT reading_start, reading_end FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(Number(snap.rows[0].reading_start)).toBe(1000)
    expect(Number(snap.rows[0].reading_end)).toBe(1250)
  })

  it('re-read beyond tolerance replaces the original and bills from the re-read', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    await mainWalk(app, f, run, 1250, 560)
    await enterDC(app, f, run.id, f.meterLeased, 1400) // 150 off — re-read wins
    await enterDC(app, f, run.id, f.meterVacant, 561)
    const bills = await db.query(
      `SELECT usage_amount, charge_amount FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(Number(bills.rows[0].usage_amount)).toBe(400)
    expect(Number(bills.rows[0].charge_amount)).toBeCloseTo(56.0, 2)
  })

  it('rollover flows through untouched: 999822 → 000138 re-read 000139 bills 316 automatically', async () => {
    const app = buildApp()
    const f = await seed()
    await db.query(
      `UPDATE utility_meter_readings SET reading_value = 999822
        WHERE meter_id = $1 AND billing_cycle_month = '2026-06-01'`, [f.meterLeased])
    const run = await openRun(app, f)
    await mainWalk(app, f, run, 138, 560)
    await enterDC(app, f, run.id, f.meterLeased, 139) // within tolerance — 138 stands
    const done = await enterDC(app, f, run.id, f.meterVacant, 561)
    expect(done.body.data.run.status).toBe('completed')
    expect(done.body.data.escalated).toBe(0)
    const bills = await db.query(
      `SELECT usage_amount, charge_amount FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(Number(bills.rows[0].usage_amount)).toBe(316) // (1,000,000 − 999822) + 138
    expect(Number(bills.rows[0].charge_amount)).toBeCloseTo(44.24, 2)
  })

  it('suspicious-high usage verified by the re-read bills with no landlord involvement', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    await mainWalk(app, f, run, 7000, 560) // 6,000 kWh — over the 5,000 threshold, silently flagged
    await enterDC(app, f, run.id, f.meterLeased, 7001) // re-read confirms
    const done = await enterDC(app, f, run.id, f.meterVacant, 561)
    expect(done.body.data.run.status).toBe('completed')
    expect(done.body.data.run.bills_created).toBe(1)
    const bills = await db.query(
      `SELECT usage_amount, charge_amount FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(Number(bills.rows[0].usage_amount)).toBe(6000)
    expect(Number(bills.rows[0].charge_amount)).toBeCloseTo(840.0, 2)
    // Landlord queue stays EMPTY — the re-read was the verification.
    const flagged = await request(app)
      .get(`/api/utility/readings/flagged?propertyId=${f.propertyAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(flagged.body.data).toHaveLength(0)
  })

  it('re-read-confirmed implausible low value escalates to the landlord (rollover vs swap)', async () => {
    const app = buildApp()
    const f = await seed()
    await db.query(
      `UPDATE utility_meter_readings SET reading_value = 500000
        WHERE meter_id = $1 AND billing_cycle_month = '2026-06-01'`, [f.meterLeased])
    const run = await openRun(app, f)
    await mainWalk(app, f, run, 50, 560) // wrap 500050 ≥ half range → suspect
    await enterDC(app, f, run.id, f.meterLeased, 51) // re-read confirms the low value
    const done = await enterDC(app, f, run.id, f.meterVacant, 561)
    expect(done.body.data.run.status).toBe('completed')
    expect(done.body.data.escalated).toBe(1)
    expect(done.body.data.run.bills_created).toBe(0) // escalated meter held from billing

    const flagged = await request(app)
      .get(`/api/utility/readings/flagged?propertyId=${f.propertyAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(flagged.body.data).toHaveLength(1)
    expect(flagged.body.data[0].review_note).toMatch(/rollover or meter swap/)
    // Landlord: meter was swapped → nothing bills this cycle.
    const resolved = await request(app)
      .post(`/api/utility/readings/${flagged.body.data[0].id}/resolve-review`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(resolved.status).toBe(200)
    expect(resolved.body.data.billsCreated).toBe(0)
  })

  it('list pads with random clean meters to the 6 minimum and always includes the suspects', async () => {
    const app = buildApp()
    const f = await seed()
    // 6 more submeters (8 total) on their own units, all with baselines.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      for (let i = 0; i < 6; i++) {
        const u = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
        const m = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'electric', billingMethod: 'submeter' })
        await c.query(`UPDATE utility_meters SET rate_per_unit = 0.14 WHERE id = $1`, [m])
        await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [m, u])
        await c.query(
          `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
           VALUES ($1, '2026-06-30', 1000, '2026-06-01', $2)`, [m, f.landlordAUserId])
      }
      await c.query('COMMIT')
    } finally { c.release() }

    const run = await openRun(app, f)
    const meters = await request(app)
      .get(`/api/utility/reading-runs/${run.id}/meters`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    // Main walk: leased meter suspicious (6,000 kWh), everything else normal.
    let last: any = null
    for (const m of meters.body.data) {
      const value = m.meter_id === f.meterLeased ? 7000 : 1100
      const r = await enterReading(app, f, run.id, m.meter_id, value)
      last = r.body.data
    }
    expect(last.run.status).toBe('double_check')
    expect(last.dcTotal).toBe(6) // 1 suspect + 5 random pads
    const dcs = await getDCs(app, f, run.id)
    expect(dcs.body.data.map((d: any) => d.meter_id)).toContain(f.meterLeased)
  })

  it('per-meter digits drive the wrap: a 4-digit meter rolls 9822 → 0138 = 316', async () => {
    const app = buildApp()
    const f = await seed()
    await db.query(`UPDATE utility_meters SET digits = 4 WHERE id = $1`, [f.meterLeased])
    await db.query(
      `UPDATE utility_meter_readings SET reading_value = 9822
        WHERE meter_id = $1 AND billing_cycle_month = '2026-06-01'`, [f.meterLeased])
    const run = await openRun(app, f)
    const over = await enterReading(app, f, run.id, f.meterLeased, 10000)
    expect(over.status).toBe(400) // over 4-digit capacity
    await mainWalk(app, f, run, 138, 560)
    await enterDC(app, f, run.id, f.meterLeased, 138)
    await enterDC(app, f, run.id, f.meterVacant, 561)
    const bills = await db.query(
      `SELECT usage_amount FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(Number(bills.rows[0].usage_amount)).toBe(316)
  })

  it('escape hatch: /complete force-bills the clean meters from either phase', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    await mainWalk(app, f, run, 1250, 560) // now in double_check, no re-reads entered
    const done = await request(app)
      .post(`/api/utility/reading-runs/${run.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(done.status).toBe(200)
    expect(done.body.data.status).toBe('completed')
    expect(done.body.data.bills_created).toBe(1)
    const again = await request(app)
      .post(`/api/utility/reading-runs/${run.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(again.status).toBe(409)
  })

  it('sewer rides the water meter: ONE line item at usage × (water + sewer rates), tax per type', async () => {
    const app = buildApp()
    const f = await seed()
    // Make the leased meter a water meter with a sewer rate; lease
    // carries water responsibility; per-type tax: water 2%, sewer 4%.
    await db.query(
      `UPDATE utility_meters SET utility_type = 'water', rate_per_unit = 0.008, sewer_rate_per_unit = 0.006
        WHERE id = $1`, [f.meterLeased])
    await db.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
       VALUES ($1, 'water', TRUE)`, [f.leaseAId])
    await db.query(
      `INSERT INTO property_utility_tax_rates (property_id, utility_type, tax_rate_pct)
       VALUES ($1, 'water', 2), ($1, 'sewer', 4)`, [f.propertyAId])

    const run = await openRun(app, f)
    await mainWalk(app, f, run, 1250, 560) // water usage 250 gal
    await enterDC(app, f, run.id, f.meterLeased, 1250)
    const done = await enterDC(app, f, run.id, f.meterVacant, 560)
    expect(done.body.data.run.status).toBe('completed')

    // ONE bill: 250 × (0.008 + 0.006) = $3.50.
    // Tax = 250×0.008×2% + 250×0.006×4% = 0.04 + 0.06 = $0.10.
    const bills = await db.query(
      `SELECT utility_type, charge_amount, tax_amount, rate_per_unit, sewer_rate_per_unit
         FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(bills.rows).toHaveLength(1)
    expect(bills.rows[0].utility_type).toBe('water')
    expect(Number(bills.rows[0].charge_amount)).toBeCloseTo(3.5, 2)
    expect(Number(bills.rows[0].tax_amount)).toBeCloseTo(0.1, 2)
    expect(Number(bills.rows[0].sewer_rate_per_unit)).toBeCloseTo(0.006, 4)
  })

  it('double-check entries are refused outside the verification phase', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    const early = await enterDC(app, f, run.id, f.meterLeased, 1250)
    expect(early.status).toBe(409) // still 'open'
  })
})

// ── S534 (Nic): billing decoupled from run completion ────────────────
// Each unit bills on its lease's invoice date the moment its own meters
// have original reads. The ONLY invoice blocker is a missing original
// read on a tenant-responsible submeter; verification never blocks.
describe('S534 per-unit billing on the lease invoice date', () => {
  // Aug 5 in Phoenix — the catch-up window covers the Aug 1 due date
  // (rent_due_day defaults to 1), which is the invoice that carries the
  // July reading-run cycle.
  const AUG = new Date('2026-08-05T12:00:00Z')
  const invoiceFor = (leaseId: string) => db.query(
    `SELECT id, subtotal_utilities FROM invoices WHERE lease_id = $1`, [leaseId])

  it("a missing original read holds the unit's invoice; it releases the moment the read lands", async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    await enterReading(app, f, run.id, f.meterVacant, 560) // leased meter still unread

    await generateInvoices(AUG)
    expect((await invoiceFor(f.leaseAId)).rows).toHaveLength(0) // held

    const r = await enterReading(app, f, run.id, f.meterLeased, 1250)
    expect(r.body.data.run.status).toBe('double_check') // verification NOT done

    await generateInvoices(AUG)
    const inv = await invoiceFor(f.leaseAId)
    expect(inv.rows).toHaveLength(1) // released — billed from the original read
    expect(Number(inv.rows[0].subtotal_utilities)).toBeCloseTo(35.0, 2) // 250 × 0.14
    const bill = await db.query(
      `SELECT status, payment_id FROM utility_bills WHERE billing_cycle_month = $1`, [CYCLE])
    expect(bill.rows).toHaveLength(1)
    expect(bill.rows[0].status).toBe('billed')
    expect(bill.rows[0].payment_id).not.toBeNull()
  })

  it("an unread meter on ANOTHER unit never holds this unit's invoice", async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    await enterReading(app, f, run.id, f.meterLeased, 1250) // vacant meter unread, run still open

    await generateInvoices(AUG)
    const inv = await invoiceFor(f.leaseAId)
    expect(inv.rows).toHaveLength(1)
    expect(Number(inv.rows[0].subtotal_utilities)).toBeCloseTo(35.0, 2)
  })

  it('force-completing the run releases a held invoice; the unread meter just does not bill', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)

    await generateInvoices(AUG)
    expect((await invoiceFor(f.leaseAId)).rows).toHaveLength(0) // held — nothing read

    const done = await request(app)
      .post(`/api/utility/reading-runs/${run.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(done.status).toBe(200)

    await generateInvoices(AUG)
    const inv = await invoiceFor(f.leaseAId)
    expect(inv.rows).toHaveLength(1) // rent goes out; no utility line this cycle
    expect(Number(inv.rows[0].subtotal_utilities)).toBeCloseTo(0, 2)
  })

  it("an unresolved flagged read holds the unit's ENTIRE invoice; resolving it releases everything", async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    // 6,000 kWh — over the 5,000 threshold → silently flagged. Vacant
    // meter clean, so the run sits in double_check with the flag open.
    await mainWalk(app, f, run, 7000, 560)

    await generateInvoices(AUG)
    expect((await invoiceFor(f.leaseAId)).rows).toHaveLength(0) // held — rent goes nowhere either

    await enterDC(app, f, run.id, f.meterLeased, 7001) // re-read confirms → flag resolves
    await enterDC(app, f, run.id, f.meterVacant, 561)

    await generateInvoices(AUG)
    const inv = await invoiceFor(f.leaseAId)
    expect(inv.rows).toHaveLength(1) // released with the full charge on board
    expect(Number(inv.rows[0].subtotal_utilities)).toBeCloseTo(840.0, 2) // 6,000 × 0.14
  })

  it('once the bill is on an invoice the reading is immutable — a big-diff re-read cannot replace it', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    await mainWalk(app, f, run, 1250, 560)

    await generateInvoices(AUG) // bills + invoices from the original reads
    expect((await invoiceFor(f.leaseAId)).rows).toHaveLength(1)

    const dc = await enterDC(app, f, run.id, f.meterLeased, 1400) // would normally replace
    expect(dc.status).toBe(201)
    await enterDC(app, f, run.id, f.meterVacant, 561)

    const reading = await db.query(
      `SELECT reading_value FROM utility_meter_readings WHERE meter_id = $1 AND billing_cycle_month = $2`,
      [f.meterLeased, CYCLE])
    expect(Number(reading.rows[0].reading_value)).toBe(1250) // first read stands; drift bills next cycle
    const bill = await db.query(
      `SELECT usage_amount FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = $2`,
      [f.meterLeased, CYCLE])
    expect(bill.rows).toHaveLength(1)
    expect(Number(bill.rows[0].usage_amount)).toBe(250)
    const outcome = await db.query(
      `SELECT outcome FROM utility_reading_double_checks WHERE run_id = $1 AND meter_id = $2`,
      [run.id, f.meterLeased])
    expect(outcome.rows[0].outcome).toBe('verified')
  })
})

// S558 (Nic): a RUBS-group unit's invoice must NOT go out without the current
// master read behind its water charge. The master (and any linked submeter) now
// hold the invoice, same as a submeter.
describe('S558 RUBS invoice gate', () => {
  const AUG = new Date('2026-08-05T12:00:00Z')
  const invoiceFor = (leaseId: string) => db.query(
    `SELECT id, subtotal_utilities FROM invoices WHERE lease_id = $1`, [leaseId])

  async function addRubsMaster(f: Fixture): Promise<string> {
    const c = await db.connect()
    let masterId = ''
    try {
      await c.query('BEGIN')
      masterId = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(`UPDATE utility_meters SET billing_method='rubs', rubs_allocation_method='rented_spaces', rate_per_unit=0.01, base_fee=0 WHERE id=$1`, [masterId])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [masterId, f.unitAId])
      await c.query(`INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible) VALUES ($1,'water',TRUE)`, [f.leaseAId])
      await c.query('COMMIT')
    } finally { c.release() }
    return masterId
  }

  it("holds the RUBS-group unit's whole invoice until the master is read, then releases with the water charge", async () => {
    const app = buildApp()
    const f = await seed()
    const masterId = await addRubsMaster(f)
    const run = await openRun(app, f)
    // Read the electric submeter (clears the submeter hold) but NOT the master.
    await enterReading(app, f, run.id, f.meterLeased, 1250)
    await enterReading(app, f, run.id, f.meterVacant, 560)

    await generateInvoices(AUG)
    expect((await invoiceFor(f.leaseAId)).rows).toHaveLength(0) // held — RUBS master unread

    // Read the master (period usage 500 gal → 1 rented RUBS unit → $5).
    await enterReading(app, f, run.id, masterId, 500)
    await generateInvoices(AUG)
    const inv = await invoiceFor(f.leaseAId)
    expect(inv.rows).toHaveLength(1) // released
    // electric 250 × 0.14 = 35 + water RUBS 500 × 0.01 = 5 → 40
    expect(Number(inv.rows[0].subtotal_utilities)).toBeCloseTo(40.0, 2)
  })

  it('an unread submeter on one of the master units also holds the RUBS unit invoice', async () => {
    const app = buildApp()
    const f = await seed()
    const masterId = await addRubsMaster(f)
    // unit2 is ALSO served by the master and has its own water submeter — so
    // the master's pool depends on it. Leave that submeter unread this cycle.
    const c = await db.connect()
    let subId = ''
    try {
      await c.query('BEGIN')
      subId = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(`UPDATE utility_meters SET rate_per_unit=0.01 WHERE id=$1`, [subId])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [subId, f.unit2Id])       // submeter on unit2
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [masterId, f.unit2Id])    // unit2 also on the master
      await c.query('COMMIT')
    } finally { c.release() }
    const run = await openRun(app, f)
    await enterReading(app, f, run.id, f.meterLeased, 1250)
    await enterReading(app, f, run.id, f.meterVacant, 560)
    await enterReading(app, f, run.id, masterId, 500)   // master read…
    // …but unit2's submeter is left unread → pool unknowable → hold.
    await generateInvoices(AUG)
    expect((await invoiceFor(f.leaseAId)).rows).toHaveLength(0) // still held
  })
})

// ── S560 regression: mid-month reference read must not break the monthly run ──
// A stay_turnover/special read shares the run's billing_cycle_month but is not
// a monthly_cycle read. Before the fix, the run-progress joins counted it, so
// the walk skipped the meter and the run completed with no cycle read → the
// tenant was silently never billed. getRunMeters / isRunFullyRead now filter
// reason='monthly_cycle'.
describe('S560: mid-month reference read does not break the monthly run', () => {
  it('a stay_turnover read in the cycle month is not counted as the meter being read', async () => {
    const app = buildApp()
    const f = await seed()
    await db.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-07-10', 1500, $2, $3, 'stay_turnover')`,
      [f.meterLeased, CYCLE, f.landlordAUserId])

    const run = await openRun(app, f)

    // The blind walk must still list the leased meter as unread.
    const meters = await request(app)
      .get(`/api/utility/reading-runs/${run.id}/meters`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(meters.status).toBe(200)
    const leased = (meters.body.data as any[]).find((m: any) => m.meter_id === f.meterLeased)
    expect(leased?.is_read).toBe(false)

    // Reading only the OTHER meter must NOT auto-advance the run — the leased
    // meter still needs its monthly_cycle read (isRunFullyRead must not count
    // the turnover read).
    const r = await enterReading(app, f, run.id, f.meterVacant, 800)
    expect(r.status).toBe(201)
    expect(r.body.data.run.status).toBe('open')
  })
})

// ── S607 regression: a RUBS master's entry is a USAGE TOTAL, not an odometer ──
// generateBillsForMeter bills a master's reading_value directly (nothing is
// subtracted), so "below the previous reading" describes a park that used less
// water, not a wrapped odometer. Flagging it held every RUBS tenant's WHOLE
// invoice — rent included — via invoiceGeneration's flagHold. What a master
// does need is the opposite guard: it is never re-read by the blind
// verification walk, so a slipped digit has to be caught at entry.
describe('S607: RUBS master usage totals', () => {
  /** Adds a water RUBS master over unitA with a prior-cycle total. */
  async function seedMaster(f: Fixture, priorTotal: number) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const master = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(
        `UPDATE utility_meters SET billing_method = 'rubs', rubs_allocation_method = 'rented_spaces',
                rate_per_unit = 0.01, base_fee = 0 WHERE id = $1`, [master])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [master, f.unitAId])
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'water', TRUE)`, [f.leaseAId])
      await c.query(
        `INSERT INTO utility_meter_readings
           (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
         VALUES ($1, '2026-06-30', $2, '2026-06-01', $3, 'monthly_cycle')`,
        [master, priorTotal, f.landlordAUserId])
      await c.query('COMMIT')
      return master
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  const flagOn = async (meterId: string) => (await db.query(
    `SELECT needs_review FROM utility_meter_readings
      WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'`,
    [meterId, CYCLE])).rows[0]?.needs_review

  it('a lower total than last cycle is normal usage — never flagged', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedMaster(f, 90_000)
    const run = await openRun(app, f)

    // Summer 90,000 gal → autumn 70,000 gal. Under the odometer rule this
    // wrapped ((10^6 − 90000) + 70000 = 980,000 ≥ half the range) and flagged.
    const r = await enterReading(app, f, run.id, master, 70_000)
    expect(r.status).toBe(201)
    expect(await flagOn(master)).toBe(false)
  })

  it('bills the pool off that lower total instead of holding it', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedMaster(f, 90_000)
    const run = await openRun(app, f)
    await enterReading(app, f, run.id, master, 70_000)

    const { billsCreated } = await generateBillsForMeter(master, new Date(CYCLE + 'T00:00:00Z'))
    expect(billsCreated).toBe(1)
    const bill = (await db.query(
      `SELECT charge_amount FROM utility_bills WHERE meter_id = $1`, [master])).rows[0]
    expect(Number(bill.charge_amount)).toBeCloseTo(700, 2)   // 70,000 × $0.01
  })

  it('flags a total that jumps implausibly against the master\'s own history', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedMaster(f, 50_000)
    const run = await openRun(app, f)

    // 600,000 entered where 60,000 was meant — one slipped digit, and it prices
    // every unit on the pool. Response stays blind (no giveaway to the reader).
    const r = await enterReading(app, f, run.id, master, 600_000)
    expect(r.status).toBe(201)
    expect(r.body.data.reading.needs_review).toBeUndefined()
    expect(await flagOn(master)).toBe(true)
  })

  it('does not bill the pool off a flagged total', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedMaster(f, 50_000)
    const run = await openRun(app, f)
    await enterReading(app, f, run.id, master, 600_000)

    const res = await generateBillsForMeter(master, new Date(CYCLE + 'T00:00:00Z'))
    expect(res.billsCreated).toBe(0)
    expect(res.reason).toMatch(/double-check/)
  })

  it('a seasonal swing under the factor passes untouched', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedMaster(f, 50_000)
    const run = await openRun(app, f)

    // A park filling for the season with a leak running — 8× the quiet month,
    // and every gallon of it real. Must not hold the park's rent.
    const r = await enterReading(app, f, run.id, master, 400_000)
    expect(r.status).toBe(201)
    expect(await flagOn(master)).toBe(false)
  })
})

// ── S607: RUBS priced from the utility bill instead of a rate we chose ───────
// Nic: "you're allowed to take the total dollar value of the bill and divide it
// out, not just the gallons usage — that way you're recouping the full cost of
// the bill. On a bill with low gallon usage and then your base fee, you're not
// recouping that." The blended rate (dollars ÷ usage) folds the provider's
// service charge and taxes INTO the rate, so the tenant sees one line and the
// landlord recovers the bill exactly. usage_rate masters must be untouched.
describe('S607: bill_amount RUBS masters', () => {
  /** Master over unitA (leased) + unit2 (vacant), priced from the dollar bill. */
  async function seedDollarMaster(f: Fixture, opts: { alloc?: string } = {}) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const master = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(
        `UPDATE utility_meters SET billing_method = 'rubs', rubs_allocation_method = $2,
                rubs_basis = 'bill_amount', rate_per_unit = 0.01, base_fee = 0 WHERE id = $1`,
        [master, opts.alloc ?? 'rented_spaces'])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2), ($1,$3)`,
        [master, f.unitAId, f.unit2Id])
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'water', TRUE)`, [f.leaseAId])
      await c.query('COMMIT')
      return master
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  const bills = (meterId: string) => db.query(
    `SELECT charge_amount, rate_per_unit, base_fee_share, tax_amount, unit_id
       FROM utility_bills WHERE meter_id = $1`, [meterId])

  it('recovers the whole bill, base fee and all, across the rented spaces', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedDollarMaster(f)
    const run = await openRun(app, f)

    // $1,284.50 for 90,000 gal. unitA is leased; unit2 is not, so under
    // rented_spaces the whole bill lands on unitA rather than half of it going
    // to a vacancy and silently never being billed.
    const r = await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 90_000, billAmount: 1284.50 })
    expect(r.status).toBe(201)

    await generateBillsForMeter(master, new Date(CYCLE + 'T00:00:00Z'))
    const rows = (await bills(master)).rows
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].charge_amount)).toBeCloseTo(1284.50, 2)
    expect(Number(rows[0].base_fee_share)).toBe(0)
    // Blended rate is what was charged: 1284.50 / 90,000.
    // Snapshotted at 6dp — enough that rate × usage reconstructs the charge to
    // the cent. charge_amount stays the authoritative figure.
    expect(Number(rows[0].rate_per_unit)).toBeCloseTo(1284.50 / 90_000, 5)
  })

  it('refuses the entry without the bill total rather than guessing', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedDollarMaster(f)
    const run = await openRun(app, f)

    const r = await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 90_000 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/utility bill total/i)
  })

  it('lets a master total exceed the meter face — it is a total, not an odometer', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedDollarMaster(f)
    const run = await openRun(app, f)

    // 1,400,000 gal clears a 6-digit meter's 999,999. A big park does that in a
    // month, and the digit cap describes a dial this meter does not have.
    const r = await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 1_400_000, billAmount: 4000 })
    expect(r.status).toBe(201)
  })

  it('leaves usage_rate masters exactly as they were', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedDollarMaster(f, { alloc: 'rented_spaces' })
    await db.query(
      `UPDATE utility_meters SET rubs_basis = 'usage_rate', base_fee = 0 WHERE id = $1`, [master])
    const run = await openRun(app, f)

    const r = await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 90_000 })
    expect(r.status).toBe(201)

    await generateBillsForMeter(master, new Date(CYCLE + 'T00:00:00Z'))
    const rows = (await bills(master)).rows
    // Only unitA is rented, so it takes the whole 90,000 × $0.01 pool. (unit2
    // has no lease, and rented_spaces leaves a vacancy out of the split rather
    // than handing it a share nobody can be billed for.)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].charge_amount)).toBeCloseTo(900, 2)
  })

  it('bills a submetered unit on the line at the same blended rate', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedDollarMaster(f)
    const run = await openRun(app, f)

    // unitA also has its own water submeter, so it is excluded from the pool
    // and bills its MEASURED gallons — at the master's blended rate, not at the
    // property rate. That is what makes the line recover the bill exactly.
    await db.query(`UPDATE utility_meters SET rubs_submeter_rate = 'blended' WHERE id = $1`, [master])
    const sub = await db.query(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits, base_fee)
       VALUES ($1, 'water', 'MH sub', 'submeter', 6, 0) RETURNING id`, [f.propertyAId])
    const subId = sub.rows[0].id
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [subId, f.unitAId])
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-06-30', 1000, '2026-06-01', $2, 'monthly_cycle')`, [subId, f.landlordAUserId])

    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 90_000, billAmount: 900 })          // blended = $0.01/gal
    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${subId}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 3000 })                              // 2,000 gal used

    await generateBillsForMeter(subId, new Date(CYCLE + 'T00:00:00Z'))
    const subBills = (await bills(subId)).rows
    expect(subBills).toHaveLength(1)
    expect(Number(subBills[0].charge_amount)).toBeCloseTo(20, 2)   // 2,000 × 0.01
    expect(Number(subBills[0].rate_per_unit)).toBeCloseTo(0.01, 6)
  })

  it('holds a submetered tenant to the prevailing residential rate when one is set', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedDollarMaster(f)
    const run = await openRun(app, f)
    // The park's blended cost is $0.02/gal, but the utility's own residential
    // rate is $0.012 — the tenant may not be charged above it, and the
    // difference is the landlord's to absorb.
    await db.query(`UPDATE utility_meters SET rubs_submeter_rate = 'blended' WHERE id = $1`, [master])
    await db.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, prevailing_residential_rate)
       VALUES ($1, 'water', 0.012)`, [f.propertyAId])

    const sub = await db.query(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits, base_fee)
       VALUES ($1, 'water', 'MH sub', 'submeter', 6, 0) RETURNING id`, [f.propertyAId])
    const subId = sub.rows[0].id
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [subId, f.unitAId])
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-06-30', 1000, '2026-06-01', $2, 'monthly_cycle')`, [subId, f.landlordAUserId])

    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 90_000, billAmount: 1800 })          // blended = $0.02/gal
    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${subId}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 3000 })                              // 2,000 gal

    await generateBillsForMeter(subId, new Date(CYCLE + 'T00:00:00Z'))
    const subBills = (await bills(subId)).rows
    expect(Number(subBills[0].charge_amount)).toBeCloseTo(24, 2)   // 2,000 × 0.012, not 0.02
  })

  it('stamps the read dates the bill format has to show', async () => {
    const app = buildApp()
    const f = await seed()
    const run = await openRun(app, f)
    await enterReading(app, f, run.id, f.meterLeased, 1500)

    await generateBillsForMeter(f.meterLeased, new Date(CYCLE + 'T00:00:00Z'))
    const row = (await db.query(
      `SELECT reading_start_date, reading_end_date FROM utility_bills WHERE meter_id = $1`,
      [f.meterLeased])).rows[0]
    expect(row.reading_start_date).not.toBeNull()
    expect(row.reading_end_date).not.toBeNull()
  })
})

// S607 (Nic, DIRECTIVE): "we are not enforcing legality... we offer the
// flexibility for all the different options to be billed in all the ways that
// are common use." Blended mode substitutes the RATE only — a base fee set on
// the master is the landlord's OWN addition on top of the provider's bill (the
// admin/margin lever RUBS billers charge) and must survive. An earlier cut
// zeroed it, silently removing that lever platform-wide.
describe('S607: blended mode does not strip the landlord\'s own fee', () => {
  it('adds a configured base fee on top of the divided bill', async () => {
    const app = buildApp()
    const f = await seed()
    const c = await db.connect()
    let master: string
    try {
      await c.query('BEGIN')
      master = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(
        `UPDATE utility_meters SET billing_method = 'rubs', rubs_allocation_method = 'rented_spaces',
                rubs_basis = 'bill_amount', base_fee = 50 WHERE id = $1`, [master])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [master, f.unitAId])
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'water', TRUE)`, [f.leaseAId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }

    const run = await openRun(app, f)
    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master!}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 90_000, billAmount: 1000 })

    await generateBillsForMeter(master!, new Date(CYCLE + 'T00:00:00Z'))
    const row = (await db.query(
      `SELECT charge_amount, base_fee_share FROM utility_bills WHERE meter_id = $1`, [master!])).rows[0]
    // $1,000 bill + the landlord's own $50 — one unit rented, so it carries both.
    expect(Number(row.charge_amount)).toBeCloseTo(1050, 2)
    expect(Number(row.base_fee_share)).toBeCloseTo(50, 2)
  })
})

// S607 (Nic): "we need the entire bill to be able to input as a total dollar
// amount." An electric bill with peak/off-peak tiers, demand charges and riders
// has no single usage × rate to reconstruct — demanding a usage figure would be
// asking the landlord to invent one. Usage is required only where it does real
// work: carving submetered units out of the pool.
describe('S607: bill total with no usage figure', () => {
  async function seedBillOnlyMaster(f: Fixture) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const m = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'gas', billingMethod: 'submeter' })
      await c.query(
        `UPDATE utility_meters SET billing_method = 'rubs', rubs_allocation_method = 'rented_spaces',
                rubs_basis = 'bill_amount', base_fee = 0 WHERE id = $1`, [m])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2), ($1,$3)`,
        [m, f.unitAId, f.unit2Id])
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'gas', TRUE)`, [f.leaseAId])
      await c.query('COMMIT')
      return m
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('divides the bill with usage left at zero when nothing is submetered', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedBillOnlyMaster(f)
    const run = await openRun(app, f)

    const r = await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 0, billAmount: 742.19 })
    expect(r.status).toBe(201)

    await generateBillsForMeter(master, new Date(CYCLE + 'T00:00:00Z'))
    const rows = (await db.query(
      `SELECT charge_amount FROM utility_bills WHERE meter_id = $1`, [master])).rows
    // unitA is the only rented unit on the line, so it carries the whole bill.
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].charge_amount)).toBeCloseTo(742.19, 2)
  })

  it('says plainly that usage is needed once a submetered unit is on the line', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedBillOnlyMaster(f)
    // unitA now has its own gas submeter, so its share must come out of the pool
    // — and that carve-out is measured in usage.
    const sub = await db.query(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits, base_fee)
       VALUES ($1, 'gas', 'Sub', 'submeter', 6, 0) RETURNING id`, [f.propertyAId])
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
      [sub.rows[0].id, f.unitAId])

    const run = await openRun(app, f)
    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 0, billAmount: 742.19 })

    const res = await generateBillsForMeter(master, new Date(CYCLE + 'T00:00:00Z'))
    expect(res.billsCreated).toBe(0)
    expect(res.reason).toMatch(/total usage is needed/i)
  })

  it('still carves submetered usage out when the usage total IS given', async () => {
    const app = buildApp()
    const f = await seed()
    const master = await seedBillOnlyMaster(f)
    const sub = await db.query(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits, base_fee)
       VALUES ($1, 'gas', 'Sub', 'submeter', 6, 0) RETURNING id`, [f.propertyAId])
    const subId = sub.rows[0].id
    // unit2 is the submetered one; unitA (rented) splits what's left.
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [subId, f.unit2Id])
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-06-30', 100, '2026-06-01', $2, 'monthly_cycle')`, [subId, f.landlordAUserId])

    const run = await openRun(app, f)
    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 1000, billAmount: 1000 })      // blended $1.00 / therm
    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${subId}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 300 })                          // 200 therms submetered

    await generateBillsForMeter(master, new Date(CYCLE + 'T00:00:00Z'))
    const rows = (await db.query(
      `SELECT charge_amount FROM utility_bills WHERE meter_id = $1`, [master])).rows
    // $1,000 bill − 200 therms × $1.00 carved out = $800 left for unitA.
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].charge_amount)).toBeCloseTo(800, 2)
  })
})

// S607 (Nic, DIRECTIVE): "we're going for flexibility here." The submeter rate
// and the carve-out are two INDEPENDENT settings, both defaulting to what the
// platform already did. This covers Oak Park's intended combination — mobile
// homes on a published penny a gallon, the spaces dividing whatever dollars
// that leaves of the real bill.
describe('S607: submeter rate × carve-out are independent options', () => {
  async function seedLine(f: Fixture, opts: { subRate: string; exclMode: string }) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const master = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(
        `UPDATE utility_meters SET billing_method = 'rubs', rubs_allocation_method = 'rented_spaces',
                rubs_basis = 'bill_amount', base_fee = 0,
                rubs_submeter_rate = $2, rubs_exclusion_mode = $3 WHERE id = $1`,
        [master, opts.subRate, opts.exclMode])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2), ($1,$3)`,
        [master, f.unitAId, f.unit2Id])
      // A published $0.01/gal for submetered units at this property.
      await c.query(
        `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit)
         VALUES ($1, 'water', 0.01)`, [f.propertyAId])
      // unit2 is submetered; unitA (the only OTHER rented unit) takes the pool.
      const sub = await c.query(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits, base_fee)
         VALUES ($1, 'water', 'MH sub', 'submeter', 6, 0) RETURNING id`, [f.propertyAId])
      const subId = sub.rows[0].id
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [subId, f.unit2Id])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
         VALUES ($1, '2026-06-30', 0, '2026-06-01', $2, 'monthly_cycle')`, [subId, f.landlordAUserId])
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'water', TRUE)`, [f.leaseAId])
      await c.query('COMMIT')
      return { master, subId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  /** Master: 100,000 gal for $2,000 (blended $0.02). Submeter drew 5,000 gal —
   *  deliberately under METER_USAGE_ALERT_THRESHOLDS.water, or the S533
   *  suspicious-usage flag estimates it instead of measuring it. */
  async function runCycle(app: express.Express, f: Fixture, ids: { master: string; subId: string }) {
    const run = await openRun(app, f)
    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${ids.master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 100_000, billAmount: 2000 })
    await request(app)
      .post(`/api/utility/reading-runs/${run.id}/meters/${ids.subId}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 5_000 })
    await generateBillsForMeter(ids.master, new Date(CYCLE + 'T00:00:00Z'))
    const pool = (await db.query(
      `SELECT charge_amount FROM utility_bills WHERE meter_id = $1`, [ids.master])).rows
    return Number(pool[0]?.charge_amount ?? 0)
  }

  it('published rate + dollars carve-out: the bill closes exactly', async () => {
    const app = buildApp()
    const f = await seed()
    const ids = await seedLine(f, { subRate: 'property_rate', exclMode: 'dollars' })
    const poolCharge = await runCycle(app, f, ids)
    // The submetered unit is invoiced 5,000 × $0.01 = $50. The pool takes the
    // rest of the REAL bill: $2,000 − $50 = $1,950. Together they are the bill.
    expect(poolCharge).toBeCloseTo(1950, 2)
  })

  it('published rate + usage carve-out: priced at the blended rate instead', async () => {
    const app = buildApp()
    const f = await seed()
    const ids = await seedLine(f, { subRate: 'property_rate', exclMode: 'usage' })
    const poolCharge = await runCycle(app, f, ids)
    // Usage carve-out: (100,000 − 5,000) × $0.02 blended = $1,900. The
    // submetered unit still pays only $50, so $50 of the bill goes unrecovered —
    // the reason Nic wanted the dollars option, and why the setup card warns
    // about this exact pairing.
    expect(poolCharge).toBeCloseTo(1900, 2)
  })

  it('blended rate: both carve-outs agree, because there is one rate', async () => {
    const app = buildApp()
    const f = await seed()
    const byUsage = await runCycle(app, f, await seedLine(f, { subRate: 'blended', exclMode: 'usage' }))
    const f2 = await seed()
    const byDollars = await runCycle(app, f2, await seedLine(f2, { subRate: 'blended', exclMode: 'dollars' }))
    expect(byUsage).toBeCloseTo(1900, 2)
    expect(byDollars).toBeCloseTo(1900, 2)
  })

  it('defaults leave a master on the long-standing carve-out', async () => {
    const c = await db.connect()
    try {
      const r = await c.query(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name = 'utility_meters' AND column_name IN ('rubs_exclusion_mode','rubs_submeter_rate')
          ORDER BY column_name`)
      expect(r.rows[0].column_default).toContain('usage')          // exclusion_mode
      expect(r.rows[1].column_default).toContain('property_rate')  // submeter_rate
    } finally { c.release() }
  })
})

// S607 — Nic's worked example, at a rate where the arithmetic is visible.
// Master bill $2,000 for 100,000 gal. Two submetered mobile homes at a
// published $0.03/gal. Two RV spaces split the remaining DOLLARS by headcount,
// so two people pay twice what one person pays. Everyone sees one dollar figure.
describe('S607: worked example — $0.03/gal submeters, remainder by occupancy', () => {
  it('subtracts submeter dollars and splits the rest per person', async () => {
    const app = buildApp()
    const f = await seed()
    const c = await db.connect()
    let master: string, subA: string, spot1: string, spot2: string
    try {
      await c.query('BEGIN')
      // Two RV spaces: spot1 has ONE occupant, spot2 has TWO.
      spot1 = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
      spot2 = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
      for (const [unit, heads] of [[spot1, 1], [spot2, 2]] as [string, number][]) {
        const lease = await seedLease(c, { unitId: unit, landlordId: f.landlordAId, status: 'active' })
        for (let i = 0; i < heads; i++) {
          const t = await seedTenant(c)
          await seedLeaseTenant(c, { leaseId: lease, tenantId: t, role: i === 0 ? 'primary' : 'co_tenant' })
        }
        await c.query(
          `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
           VALUES ($1, 'water', TRUE)`, [lease])
      }
      // The published submeter rate: 3 cents a gallon.
      await c.query(
        `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit)
         VALUES ($1, 'water', 0.03)`, [f.propertyAId])

      master = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(
        `UPDATE utility_meters SET billing_method='rubs', rubs_allocation_method='occupant_count',
                rubs_basis='bill_amount', rubs_submeter_rate='property_rate',
                rubs_exclusion_mode='dollars', base_fee=0 WHERE id=$1`, [master])
      // The master feeds the mobile home AND both spaces.
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2), ($1,$3), ($1,$4)`,
        [master, f.unitAId, spot1, spot2])

      // unitA is submetered — it falls out of the split automatically.
      const r = await c.query(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits, base_fee)
         VALUES ($1,'water','MH 01 water','submeter',6,0) RETURNING id`, [f.propertyAId])
      subA = r.rows[0].id
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [subA, f.unitAId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
         VALUES ($1,'2026-06-30',0,'2026-06-01',$2,'monthly_cycle')`, [subA, f.landlordAUserId])
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1,'water',TRUE)`, [f.leaseAId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }

    const run = await openRun(app, f)
    await request(app).post(`/api/utility/reading-runs/${run.id}/meters/${master!}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 100_000, billAmount: 2000 })
    await request(app).post(`/api/utility/reading-runs/${run.id}/meters/${subA!}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ readingValue: 8_000 })                       // 8,000 gal on the mobile home

    await generateBillsForMeter(subA!, new Date(CYCLE + 'T00:00:00Z'))
    await generateBillsForMeter(master!, new Date(CYCLE + 'T00:00:00Z'))

    const mh = (await db.query(
      `SELECT charge_amount FROM utility_bills WHERE meter_id=$1`, [subA!])).rows
    const pool = (await db.query(
      `SELECT unit_id, charge_amount, allocation_basis FROM utility_bills WHERE meter_id=$1`, [master!])).rows

    // Mobile home: 8,000 × $0.03 = $240 — its own published rate, nothing else.
    expect(Number(mh[0].charge_amount)).toBeCloseTo(240, 2)

    // Pool: $2,000 − $240 = $1,760, split by headcount across 1 + 2 people.
    const one = pool.find((r: any) => r.unit_id === spot1!)
    const two = pool.find((r: any) => r.unit_id === spot2!)
    expect(Number(one.allocation_basis)).toBe(1)
    expect(Number(two.allocation_basis)).toBe(2)
    expect(Number(one.charge_amount)).toBeCloseTo(586.67, 2)   // 1,760 × 1/3
    expect(Number(two.charge_amount)).toBeCloseTo(1173.33, 2)  // 1,760 × 2/3 — twice the single occupant

    // And the whole bill is accounted for, to the cent.
    const total = Number(mh[0].charge_amount) + pool.reduce((s: number, r: any) => s + Number(r.charge_amount), 0)
    expect(total).toBeCloseTo(2000, 2)
  })
})

// S607: the widened allocation menu. Nic: "we need a wider window scope for
// available options, and we narrow it on our property setup." Each basis is
// inert until selected; none replaces another.
describe('S607: widened allocation bases', () => {
  /** Master over three units, $900 bill, no submeters — so the split is the
   *  only thing under test. unitA is seeded rented with 1 occupant. */
  async function seedSplit(f: Fixture, method: string, weights: any) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const u2 = f.unit2Id
      // unit2 gets a lease with 3 occupants and different physical attributes.
      const lease2 = await seedLease(c, { unitId: u2, landlordId: f.landlordAId, status: 'active' })
      for (let i = 0; i < 3; i++) {
        const t = await seedTenant(c)
        await seedLeaseTenant(c, { leaseId: lease2, tenantId: t, role: i === 0 ? 'primary' : 'co_tenant' })
      }
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1,'water',TRUE), ($2,'water',TRUE)`, [f.leaseAId, lease2])
      await c.query(`UPDATE units SET sqft = 300, water_fixture_count = 2, unit_type = 'rv_spot' WHERE id = $1`, [f.unitAId])
      await c.query(`UPDATE units SET sqft = 900, water_fixture_count = 6, unit_type = 'mobile_home' WHERE id = $1`, [u2])

      const master = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(
        `UPDATE utility_meters SET billing_method='rubs', rubs_allocation_method=$2,
                rubs_basis='bill_amount', rubs_weights=$3::jsonb, base_fee=0 WHERE id=$1`,
        [master, method, weights ? JSON.stringify(weights) : null])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2), ($1,$3)`,
        [master, f.unitAId, u2])
      await c.query('COMMIT')
      return master
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  async function charges(app: express.Express, f: Fixture, master: string) {
    const run = await openRun(app, f)
    await request(app).post(`/api/utility/reading-runs/${run.id}/meters/${master}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ readingValue: 0, billAmount: 900 })
    await generateBillsForMeter(master, new Date(CYCLE + 'T00:00:00Z'))
    const rows = (await db.query(
      `SELECT unit_id, charge_amount FROM utility_bills WHERE meter_id=$1`, [master])).rows
    return {
      a: Number(rows.find((r: any) => r.unit_id === f.unitAId)?.charge_amount ?? 0),
      b: Number(rows.find((r: any) => r.unit_id === f.unit2Id)?.charge_amount ?? 0),
      total: rows.reduce((s: number, r: any) => s + Number(r.charge_amount), 0),
    }
  }

  it('fixture_count splits on plumbing fixtures', async () => {
    const app = buildApp(); const f = await seed()
    const m = await seedSplit(f, 'fixture_count', null)
    const c = await charges(app, f, m)
    expect(c.a).toBeCloseTo(225, 2)   // 2 of 8 fixtures
    expect(c.b).toBeCloseTo(675, 2)   // 6 of 8
    expect(c.total).toBeCloseTo(900, 2)
  })

  it('unit_type_weight splits on the landlord\'s own weights', async () => {
    const app = buildApp(); const f = await seed()
    const m = await seedSplit(f, 'unit_type_weight', { rv_spot: 1, mobile_home: 1.5 })
    const c = await charges(app, f, m)
    expect(c.a).toBeCloseTo(360, 2)   // 1 of 2.5
    expect(c.b).toBeCloseTo(540, 2)   // 1.5 of 2.5
    expect(c.total).toBeCloseTo(900, 2)
  })

  it('hybrid blends two bases as proportions, not raw numbers', async () => {
    const app = buildApp(); const f = await seed()
    const m = await seedSplit(f, 'hybrid', { primary: 'sqft', secondary: 'occupant_count', primaryPct: 50 })
    const c = await charges(app, f, m)
    // sqft shares 300/1200 = .25 and 900/1200 = .75; occupancy shares 1/4 = .25
    // and 3/4 = .75. Blended 50/50 → .25 / .75. Normalising each side FIRST is
    // what stops square footage (hundreds) swamping headcount (ones).
    expect(c.a).toBeCloseTo(225, 2)
    expect(c.b).toBeCloseTo(675, 2)
    expect(c.total).toBeCloseTo(900, 2)
  })

  it('hybrid weights the two sides when the split is not 50/50', async () => {
    const app = buildApp(); const f = await seed()
    const m = await seedSplit(f, 'hybrid', { primary: 'rented_spaces', secondary: 'occupant_count', primaryPct: 50 })
    const c = await charges(app, f, m)
    // rented-equal shares .5/.5 blended with occupancy .25/.75 → .375 / .625.
    expect(c.a).toBeCloseTo(337.50, 2)
    expect(c.b).toBeCloseTo(562.50, 2)
    expect(c.total).toBeCloseTo(900, 2)
  })

  it('a unit missing the data a basis needs is skipped, not given a free share', async () => {
    const app = buildApp(); const f = await seed()
    const m = await seedSplit(f, 'fixture_count', null)
    await db.query(`UPDATE units SET water_fixture_count = NULL WHERE id = $1`, [f.unitAId])
    const c = await charges(app, f, m)
    expect(c.a).toBe(0)                 // no fixture count recorded → no bill
    expect(c.b).toBeCloseTo(900, 2)     // and the pool still closes
  })

  it('a self-referential hybrid config cannot recurse', async () => {
    const app = buildApp(); const f = await seed()
    const m = await seedSplit(f, 'hybrid', { primary: 'hybrid', secondary: 'sqft', primaryPct: 50 })
    const c = await charges(app, f, m)
    expect(c.total).toBe(0)             // refuses to split rather than hanging
  })
})

// S607 — Oak Park's real topology: THREE water masters on one property, each
// feeding a different set of units, with a submeter on one of them. Nic: "we
// have three different master meters for water at Oak Park, but different units
// are on each one." Each master must price its own line and nothing else.
describe('S607: several master meters on one property', () => {
  it('bills each master independently off its own bill and its own units', async () => {
    const app = buildApp()
    const f = await seed()
    const c = await db.connect()
    const M: string[] = []
    const U: string[] = []
    let subId = ''
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit)
         VALUES ($1, 'water', 0.01)`, [f.propertyAId])
      // Three masters, each with one rented unit on it.
      for (let i = 0; i < 3; i++) {
        const unit = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
        const lease = await seedLease(c, { unitId: unit, landlordId: f.landlordAId, status: 'active' })
        const t = await seedTenant(c)
        await seedLeaseTenant(c, { leaseId: lease, tenantId: t })
        await c.query(
          `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
           VALUES ($1,'water',TRUE)`, [lease])
        const m = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
        await c.query(
          `UPDATE utility_meters SET billing_method='rubs', rubs_allocation_method='rented_spaces',
                  rubs_basis='bill_amount', rubs_submeter_rate='property_rate',
                  rubs_exclusion_mode='dollars', base_fee=0, label=$2 WHERE id=$1`,
          [m, `Master ${i + 1}`])
        await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [m, unit])
        M.push(m); U.push(unit)
      }
      // Master 3 also feeds a SUBMETERED unit, which must affect master 3 only.
      const subUnit = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
      const subLease = await seedLease(c, { unitId: subUnit, landlordId: f.landlordAId, status: 'active' })
      const st = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: subLease, tenantId: st })
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1,'water',TRUE)`, [subLease])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [M[2], subUnit])
      const sr = await c.query(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits, base_fee)
         VALUES ($1,'water','MH sub','submeter',6,0) RETURNING id`, [f.propertyAId])
      subId = sr.rows[0].id
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [subId, subUnit])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
         VALUES ($1,'2026-06-30',0,'2026-06-01',$2,'monthly_cycle')`, [subId, f.landlordAUserId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }

    const run = await openRun(app, f)
    // Three separate bills, three separate amounts.
    const amounts = [300, 500, 900]
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post(`/api/utility/reading-runs/${run.id}/meters/${M[i]}/reading`)
        .set('Authorization', `Bearer ${f.tokenA}`)
        .send({ readingValue: 50_000, billAmount: amounts[i] })
      expect(r.status).toBe(201)
    }
    await request(app).post(`/api/utility/reading-runs/${run.id}/meters/${subId}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ readingValue: 4_000 })

    await generateBillsForMeter(subId, new Date(CYCLE + 'T00:00:00Z'))
    for (const m of M) await generateBillsForMeter(m, new Date(CYCLE + 'T00:00:00Z'))

    const charge = async (meterId: string) => Number((await db.query(
      `SELECT COALESCE(SUM(charge_amount),0) AS t FROM utility_bills WHERE meter_id=$1`, [meterId])).rows[0].t)

    // Masters 1 and 2: whole bill to their single rented unit, untouched by the
    // submeter that hangs off master 3.
    expect(await charge(M[0])).toBeCloseTo(300, 2)
    expect(await charge(M[1])).toBeCloseTo(500, 2)
    // Submetered unit pays its own measured usage at the published rate.
    expect(await charge(subId)).toBeCloseTo(40, 2)          // 4,000 × $0.01
    // Master 3's pool is ITS bill less ITS submeter's invoice: $900 − $40.
    expect(await charge(M[2])).toBeCloseTo(860, 2)
    // Every line closes on its own bill.
    expect(await charge(M[0]) + await charge(M[1]) + await charge(M[2]) + await charge(subId))
      .toBeCloseTo(300 + 500 + 900, 2)
  })

  it('refuses to put one unit on two masters of the same utility', async () => {
    const app = buildApp()
    const f = await seed()
    const c = await db.connect()
    const M: string[] = []
    try {
      await c.query('BEGIN')
      for (let i = 0; i < 2; i++) {
        const m = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
        await c.query(
          `UPDATE utility_meters SET billing_method='rubs', rubs_allocation_method='rented_spaces' WHERE id=$1`, [m])
        M.push(m)
      }
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [M[0], f.unitAId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }

    // Two masters are fine; the same unit on both would double-bill it.
    const r = await request(app).post(`/api/utility/meters/${M[1]}/units`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ unitId: f.unitAId })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/only be on one master meter/i)
  })
})

// S607 — Nic: "if I do rented units only instead of by occupancy, that's not
// gonna bill out the entire amount, is it? Or is it gonna be inaccurate because
// people with a second tenant are gonna be paying the same as people that are
// just by themselves?"
//
// Two separate properties, and they come apart: BOTH bases recover 100% of the
// pool — a vacancy is excluded from the denominator either way, so nothing is
// left with the landlord. What differs is only how the burden is spread, and
// that is the real trade Nic was pointing at.
describe('S607: rented_spaces vs occupant_count — recovery and fairness', () => {
  /** One master, $900 bill, three units: vacant, 1 occupant, 2 occupants. */
  async function seedThree(f: Fixture, method: string) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const vacant = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
      const solo   = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
      const couple = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
      for (const [unit, heads] of [[solo, 1], [couple, 2]] as [string, number][]) {
        const lease = await seedLease(c, { unitId: unit, landlordId: f.landlordAId, status: 'active' })
        for (let i = 0; i < heads; i++) {
          const t = await seedTenant(c)
          await seedLeaseTenant(c, { leaseId: lease, tenantId: t, role: i === 0 ? 'primary' : 'co_tenant' })
        }
        await c.query(
          `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
           VALUES ($1,'water',TRUE)`, [lease])
      }
      const m = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(
        `UPDATE utility_meters SET billing_method='rubs', rubs_allocation_method=$2,
                rubs_basis='bill_amount', base_fee=0 WHERE id=$1`, [m, method])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2),($1,$3),($1,$4)`,
        [m, vacant, solo, couple])
      await c.query('COMMIT')
      return { m, vacant, solo, couple }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  async function bill(app: express.Express, f: Fixture, ids: any) {
    const run = await openRun(app, f)
    await request(app).post(`/api/utility/reading-runs/${run.id}/meters/${ids.m}/reading`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ readingValue: 0, billAmount: 900 })
    await generateBillsForMeter(ids.m, new Date(CYCLE + 'T00:00:00Z'))
    const rows = (await db.query(
      `SELECT unit_id, charge_amount FROM utility_bills WHERE meter_id=$1`, [ids.m])).rows
    const get = (u: string) => Number(rows.find((r: any) => r.unit_id === u)?.charge_amount ?? 0)
    return { solo: get(ids.solo), couple: get(ids.couple), vacant: get(ids.vacant),
             total: rows.reduce((s: number, r: any) => s + Number(r.charge_amount), 0) }
  }

  it('rented units only: bills the WHOLE pool, flat per unit', async () => {
    const app = buildApp(); const f = await seed()
    const r = await bill(app, f, await seedThree(f, 'rented_spaces'))
    expect(r.vacant).toBe(0)
    expect(r.solo).toBeCloseTo(450, 2)      // same as the couple — the fairness cost
    expect(r.couple).toBeCloseTo(450, 2)
    expect(r.total).toBeCloseTo(900, 2)     // nothing left on the landlord
  })

  it('occupancy: also bills the WHOLE pool, and scales with people', async () => {
    const app = buildApp(); const f = await seed()
    const r = await bill(app, f, await seedThree(f, 'occupant_count'))
    expect(r.vacant).toBe(0)                // a vacancy has no tenants → no share
    expect(r.solo).toBeCloseTo(300, 2)      // 1 of 3 people
    expect(r.couple).toBeCloseTo(600, 2)    // 2 of 3 — twice the single occupant
    expect(r.total).toBeCloseTo(900, 2)     // still nothing left on the landlord
  })

})
