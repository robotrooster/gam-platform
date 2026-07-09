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
