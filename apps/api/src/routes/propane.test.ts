/**
 * Propane tank fills + utility tax (S533).
 *
 * Covers: fill math (gallons × per-fill PPG + landlord-set propane tax),
 * split gating (2/4 only; <40 gal never; 4-way needs 100+; property
 * opt-in), immediate first payment, installment schedule, refill gate,
 * rounding, tax snapshot on metered utility bills, and the invoice cron
 * picking up split installments at face value.
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
import { propaneRouter } from './propane'
import { utilityRouter } from './utility'
import { paymentsRouter } from './payments'
import { errorHandler } from '../middleware/errorHandler'
import { generateBillsForMeter } from '../services/utilityBilling'
import { applyAcceleratedPropane } from '../services/propaneRedistribution'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/propane', propaneRouter)
  app.use('/api/utility', utilityRouter)
  app.use('/api/payments', paymentsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_propane'
})

interface Fixture {
  landlordAUserId: string
  landlordAId: string
  propertyAId: string
  unitAId: string
  vacantUnitId: string
  tenantAId: string
  leaseAId: string
  tokenA: string
  tokenB: string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { landlordId: bId, userId: bUid } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const vacant = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const tenantA = await seedTenant(c)
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: aId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA })
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId, propertyAId: propA,
      unitAId: unitA, vacantUnitId: vacant, tenantAId: tenantA, leaseAId: leaseA,
      tokenA: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      tokenB: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

const postFill = (app: express.Express, f: Fixture, body: any) =>
  request(app).post('/api/propane/fills').set('Authorization', `Bearer ${f.tokenA}`).send(body)

const setSetting = (app: express.Express, f: Fixture, body: any) =>
  request(app).post('/api/propane/settings').set('Authorization', `Bearer ${f.tokenA}`)
    .send({ propertyId: f.propertyAId, ...body })

const setTax = (app: express.Express, f: Fixture, utilityType: string, pct: number) =>
  request(app).post('/api/utility/tax-rates').set('Authorization', `Bearer ${f.tokenA}`)
    .send({ propertyId: f.propertyAId, utilityType, taxRatePct: pct })

describe('propane fills', () => {
  it('bills gallons × per-fill PPG + landlord propane tax; first payment due immediately', async () => {
    const app = buildApp()
    const f = await seed()
    await setTax(app, f, 'propane', 8)
    const res = await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3.5, installments: 1 })
    expect(res.status).toBe(201)
    // 20 × 3.50 = 70.00 + 8% tax 5.60 = 75.60
    expect(Number(res.body.data.total_amount)).toBeCloseTo(75.6, 2)
    expect(Number(res.body.data.tax_amount)).toBeCloseTo(5.6, 2)

    const pay = await db.query(
      `SELECT amount, type, entry_description, status, due_date, invoice_id
         FROM payments WHERE entry_description = 'PROPANE'`)
    expect(pay.rows).toHaveLength(1)
    expect(Number(pay.rows[0].amount)).toBeCloseTo(75.6, 2)
    expect(pay.rows[0].type).toBe('utility')
    expect(pay.rows[0].status).toBe('pending')
    expect(pay.rows[0].invoice_id).toBeNull() // standalone, due now
  })

  it('splits: <40 gal never; 40-99 gal 2 only; 100+ gal 2 or 4; property must opt in', async () => {
    const app = buildApp()
    const f = await seed()
    // opt-in off → any split 400
    const off = await postFill(app, f, { unitId: f.unitAId, gallons: 120, pricePerGallon: 3, installments: 2 })
    expect(off.status).toBe(400)
    await setSetting(app, f, { allowInstallments: true })
    // under 40 gal → no split
    expect((await postFill(app, f, { unitId: f.unitAId, gallons: 39, pricePerGallon: 3, installments: 2 })).status).toBe(400)
    // 50 gal → 4-way not allowed
    expect((await postFill(app, f, { unitId: f.unitAId, gallons: 50, pricePerGallon: 3, installments: 4 })).status).toBe(400)
    // 3 payments never an option
    expect((await postFill(app, f, { unitId: f.unitAId, gallons: 120, pricePerGallon: 3, installments: 3 })).status).toBe(400)
    // 120 gal 4-way → ok
    const ok = await postFill(app, f, { unitId: f.unitAId, gallons: 120, pricePerGallon: 3, installments: 4 })
    expect(ok.status).toBe(201)
  })

  // S534 (Nic): the 40/100 defaults are just that — each landlord sets
  // their own thresholds per property.
  it('landlord-set thresholds override the defaults and gate fills', async () => {
    const app = buildApp()
    const f = await seed()
    const set = await setSetting(app, f, {
      allowInstallments: true, splitMinGallons: 10, splitFourMinGallons: 60,
    })
    expect(set.status).toBe(200)
    expect(Number(set.body.data.propane_split_min_gallons)).toBe(10)
    expect(Number(set.body.data.propane_split_four_min_gallons)).toBe(60)
    // 15 gal splits 2-way under the lowered floor (default 40 would refuse)
    expect((await postFill(app, f, { unitId: f.unitAId, gallons: 15, pricePerGallon: 3, installments: 2 })).status).toBe(201)
    // 60 gal 4-way ok under the lowered 4-way floor (default 100 would refuse)
    expect((await postFill(app, f, { unitId: f.unitAId, gallons: 60, pricePerGallon: 3, installments: 4 })).status).toBe(201)
    // 9 gal still can't split
    expect((await postFill(app, f, { unitId: f.unitAId, gallons: 9, pricePerGallon: 3, installments: 2 })).status).toBe(400)
    // 4-way floor below the split floor is rejected
    expect((await setSetting(app, f, { splitFourMinGallons: 5 })).status).toBe(400)
  })

  it('4-way split schedules consecutive cycles, first billed now, last takes the rounding remainder', async () => {
    const app = buildApp()
    const f = await seed()
    await setSetting(app, f, { allowInstallments: true })
    // 111.11 gal × $3 = 333.33 → 83.33 × 3 + 83.34 last
    const res = await postFill(app, f, { unitId: f.unitAId, gallons: 111.11, pricePerGallon: 3, installments: 4 })
    expect(res.status).toBe(201)
    const inst = await db.query(
      `SELECT installment_number, amount, billing_cycle_month, payment_id
         FROM propane_fill_installments ORDER BY installment_number`)
    expect(inst.rows).toHaveLength(4)
    expect(inst.rows.map((r: any) => Number(r.amount))).toEqual([83.33, 83.33, 83.33, 83.34])
    expect(Number(inst.rows.reduce((s: number, r: any) => s + Number(r.amount), 0))).toBeCloseTo(333.33, 2)
    expect(inst.rows[0].payment_id).not.toBeNull()   // #1 billed immediately
    expect(inst.rows[1].payment_id).toBeNull()       // rest wait for their cycle
    const months = inst.rows.map((r: any) => String(r.billing_cycle_month).slice(0, 7))
    expect(new Set(months).size).toBe(4)             // four consecutive cycles
  })

  it('acceleration: a new fill makes every remaining prior installment due immediately', async () => {
    const app = buildApp()
    const f = await seed()
    await setSetting(app, f, { allowInstallments: true })
    // Fill 1: 120 gal × $3 = $360, 4-way split → $90 now + 3 × $90 scheduled.
    await postFill(app, f, { unitId: f.unitAId, gallons: 120, pricePerGallon: 3, installments: 4 })
    let due = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE entry_description = 'PROPANE'`)
    expect(due.rows[0].n).toBe(1) // only payment 1 billed so far

    // Fill 2 lands while $270 is still scheduled — the truck already
    // filled the tank, so the prior balance accelerates to due-now.
    const fill2 = await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3, installments: 1 })
    expect(fill2.status).toBe(201)

    // Prior fill: no unbilled installments remain; each got a due-now payment.
    const unbilled = await db.query(
      `SELECT COUNT(*)::int AS n FROM propane_fill_installments WHERE payment_id IS NULL`)
    expect(unbilled.rows[0].n).toBe(0)
    const payments = await db.query(
      `SELECT amount, due_date, invoice_id FROM payments
        WHERE entry_description = 'PROPANE' ORDER BY created_at`)
    // 1 (fill1 first) + 3 (accelerated) + 1 (fill2 first) = 5, all standalone.
    expect(payments.rows).toHaveLength(5)
    expect(payments.rows.every((p: any) => p.invoice_id === null)).toBe(true)
    const total = payments.rows.reduce((s: number, p: any) => s + Number(p.amount), 0)
    expect(total).toBeCloseTo(360 + 60, 2) // full fill-1 total + fill-2 payment

    // Accelerated rows are flagged; the fill's own first payments are not.
    const flags = await db.query(
      `SELECT accelerated, COUNT(*)::int AS n FROM propane_fill_installments
        WHERE payment_id IS NOT NULL GROUP BY accelerated ORDER BY accelerated`)
    expect(flags.rows).toEqual([
      expect.objectContaining({ accelerated: false, n: 2 }), // fill1 #1 + fill2 #1
      expect.objectContaining({ accelerated: true,  n: 3 }), // fill1 #2-#4
    ])
  })

  it('settle-time redistribution: rent funds apply to accelerated propane first, rent splits, ACH never blocked', async () => {
    const app = buildApp()
    const f = await seed()
    await setSetting(app, f, { allowInstallments: true })
    // Fill 1 four-way ($90 now + 3 × $90), then fill 2 accelerates $270.
    await postFill(app, f, { unitId: f.unitAId, gallons: 120, pricePerGallon: 3, installments: 4 })
    await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3, installments: 1 })

    // Rent payment of $800 settles (simulating the webhook flip)...
    const rent = await db.query<any>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, 'rent', 800, 'settled', CURRENT_DATE, 'RENT')
       RETURNING id, tenant_id, amount::text AS amount, due_date::text AS due_date`,
      [f.unitAId, f.leaseAId, f.tenantAId, f.landlordAId])

    // ...and redistribution applies the funds propane-first.
    const client = await db.connect()
    let result: any
    try {
      await client.query('BEGIN')
      result = await applyAcceleratedPropane(client, rent.rows[0])
      await client.query('COMMIT')
    } finally { client.release() }

    expect(result.applied).toBeCloseTo(270, 2)         // 3 × $90 accelerated rows
    expect(result.rentRemainder).toBeCloseTo(270, 2)
    // Accelerated propane rows are settled.
    const accel = await db.query(
      `SELECT p.status FROM payments p JOIN propane_fill_installments i ON i.payment_id = p.id
        WHERE i.accelerated`)
    expect(accel.rows).toHaveLength(3)
    expect(accel.rows.every((r: any) => r.status === 'settled')).toBe(true)
    // Rent row shrank to what the funds still covered; a pending
    // remainder row carries the rest. Total rent ledger unchanged.
    const rentRows = await db.query(
      `SELECT amount, status FROM payments WHERE type = 'rent' ORDER BY created_at`)
    expect(rentRows.rows).toHaveLength(2)
    expect(Number(rentRows.rows[0].amount)).toBeCloseTo(530, 2)
    expect(rentRows.rows[0].status).toBe('settled')
    expect(Number(rentRows.rows[1].amount)).toBeCloseTo(270, 2)
    expect(rentRows.rows[1].status).toBe('pending')

    // Idempotent-ish: nothing left to redistribute on a second pass.
    const client2 = await db.connect()
    try {
      await client2.query('BEGIN')
      const again = await applyAcceleratedPropane(client2, rent.rows[0])
      await client2.query('COMMIT')
      expect(again).toBeNull()
    } finally { client2.release() }
  })

  it('redistribution satisfies whole rows only — a sliver of rent survives when it cannot cover the next row', async () => {
    const app = buildApp()
    const f = await seed()
    await setSetting(app, f, { allowInstallments: true })
    await postFill(app, f, { unitId: f.unitAId, gallons: 120, pricePerGallon: 3, installments: 4 })
    await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3, installments: 1 })
    // $200 rent covers only 2 of the 3 accelerated $90 rows.
    const rent = await db.query<any>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, 'rent', 200, 'settled', CURRENT_DATE, 'RENT')
       RETURNING id, tenant_id, amount::text AS amount, due_date::text AS due_date`,
      [f.unitAId, f.leaseAId, f.tenantAId, f.landlordAId])
    const client = await db.connect()
    let result: any
    try {
      await client.query('BEGIN')
      result = await applyAcceleratedPropane(client, rent.rows[0])
      await client.query('COMMIT')
    } finally { client.release() }
    expect(result.applied).toBeCloseTo(180, 2)  // 2 whole rows; $20 stays on rent
    const stillOwed = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments p
         JOIN propane_fill_installments i ON i.payment_id = p.id
        WHERE i.accelerated AND p.status = 'pending'`)
    expect(stillOwed.rows[0].n).toBe(1)
  })

  it('400s a fill on a unit without an active lease; 403 cross-landlord', async () => {
    const app = buildApp()
    const f = await seed()
    expect((await postFill(app, f, { unitId: f.vacantUnitId, gallons: 20, pricePerGallon: 3, installments: 1 })).status).toBe(400)
    const cross = await request(app).post('/api/propane/fills')
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ unitId: f.unitAId, gallons: 20, pricePerGallon: 3, installments: 1 })
    expect(cross.status).toBe(403)
  })
})

describe('utility tax on metered bills', () => {
  it('snapshots the landlord rate onto generated bills as a separate amount', async () => {
    const app = buildApp()
    const f = await seed()
    await setTax(app, f, 'electric', 5.6)
    const c = await db.connect()
    let meter: string
    try {
      await c.query('BEGIN')
      meter = await seedUtilityMeter(c, { propertyId: f.propertyAId, utilityType: 'electric', billingMethod: 'submeter' })
      await c.query(`UPDATE utility_meters SET rate_per_unit = 0.14, base_fee = 0 WHERE id = $1`, [meter])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meter, f.unitAId])
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'electric', TRUE)`, [f.leaseAId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
         VALUES ($1, '2026-06-30', 1000, '2026-06-01', $2), ($1, '2026-07-31', 1250, '2026-07-01', $2)`,
        [meter, f.landlordAUserId])
      await c.query('COMMIT')
    } finally { c.release() }

    const result = await generateBillsForMeter(meter!, new Date('2026-07-01T00:00:00Z'))
    expect(result.billsCreated).toBe(1)
    const bill = await db.query(`SELECT charge_amount, tax_rate_pct, tax_amount FROM utility_bills`)
    expect(Number(bill.rows[0].charge_amount)).toBeCloseTo(35.0, 2)  // 250 × 0.14
    expect(Number(bill.rows[0].tax_rate_pct)).toBeCloseTo(5.6, 2)
    expect(Number(bill.rows[0].tax_amount)).toBeCloseTo(1.96, 2)     // separate line
  })
})
