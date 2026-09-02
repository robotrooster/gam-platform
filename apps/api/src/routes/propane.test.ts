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
import { randomUUID } from 'crypto'
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
    // S613: a fill presupposes a tank — the space has to be marked as having one
    // before the delivery form will offer it, so the tenanted unit carries one.
    // `vacant` deliberately does NOT, which is what the no-tank cases exercise.
    await c.query(`UPDATE units SET has_propane_tank = true WHERE id = $1`, [unitA])
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
  it('idempotent: a repeat fill with the same clientKey records ONE fill + ONE charge', async () => {
    const app = buildApp()
    const f = await seed()
    const key = '11111111-1111-4111-8111-111111111111'
    const first = await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3.5, installments: 1, clientKey: key })
    expect(first.status).toBe(201)
    // Same intent resubmitted (lost-response retry / second open tab).
    const again = await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3.5, installments: 1, clientKey: key })
    expect(again.status).toBe(200)
    expect(again.body.idempotent).toBe(true)
    expect(again.body.data.id).toBe(first.body.data.id)
    // Exactly one fill and one scheduled installment — no double-billing.
    // S609: nothing is charged at record time any more, so the guard is on the
    // SCHEDULE rather than on an immediate payments row.
    const fillsN = await db.query<{ n: number }>(`SELECT count(*)::int n FROM propane_fills WHERE unit_id=$1`, [f.unitAId])
    expect(fillsN.rows[0].n).toBe(1)
    const instN = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM propane_fill_installments i
         JOIN propane_fills fl ON fl.id = i.fill_id WHERE fl.unit_id=$1`, [f.unitAId])
    expect(instN.rows[0].n).toBe(1)
  })

  // S609 (Nic): "All decided before any money moves." Nothing is charged at
  // record time — the first installment rides the NEXT monthly invoice.
  it('bills gallons × per-fill PPG + tax, scheduled onto next month — nothing charged now', async () => {
    const app = buildApp()
    const f = await seed()
    await setTax(app, f, 'propane', 8)
    const res = await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3.5, installments: 1 })
    expect(res.status).toBe(201)
    // 20 × 3.50 = 70.00 + 8% tax 5.60 = 75.60
    expect(Number(res.body.data.total_amount)).toBeCloseTo(75.6, 2)
    expect(Number(res.body.data.tax_amount)).toBeCloseTo(5.6, 2)

    // NOTHING is charged yet — no payments row exists until the invoice runs.
    const pay = await db.query(
      `SELECT id FROM payments WHERE entry_description = 'PROPANE'`)
    expect(pay.rows).toHaveLength(0)

    // The whole schedule is written up front, starting NEXT month.
    const inst = await db.query<any>(
      `SELECT installment_number, amount, gallons, billing_cycle_month::text AS cycle, payment_id
         FROM propane_fill_installments ORDER BY installment_number`)
    expect(inst.rows).toHaveLength(1)
    expect(Number(inst.rows[0].amount)).toBeCloseTo(75.6, 2)
    expect(Number(inst.rows[0].gallons)).toBeCloseTo(20, 2)
    expect(inst.rows[0].payment_id).toBeNull()   // not billed yet
    const nextMonth = new Date()
    nextMonth.setUTCDate(1)
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
    expect(inst.rows[0].cycle).toBe(nextMonth.toISOString().slice(0, 10))
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

  // S609 (Nic): the split is in GALLONS — "if it's a hundred and ninety gallons,
  // you do three forty-eights and then a forty-six" — and EVERY installment is a
  // future charge until its month comes, exactly like next month's rent.
  it('4-way split: even gallons, remainder on the last, all scheduled as future charges', async () => {
    const app = buildApp()
    const f = await seed()
    await setSetting(app, f, { allowInstallments: true })
    // 190 gal over 4 → 48, 48, 48, 46 gallons.
    const res = await postFill(app, f, { unitId: f.unitAId, gallons: 190, pricePerGallon: 3, installments: 4 })
    expect(res.status).toBe(201)
    const inst = await db.query(
      `SELECT installment_number, amount, gallons, billing_cycle_month, payment_id
         FROM propane_fill_installments ORDER BY installment_number`)
    expect(inst.rows).toHaveLength(4)
    expect(inst.rows.map((r: any) => Number(r.gallons))).toEqual([48, 48, 48, 46])
    // Gallons reconcile to the fill exactly — no propane invented by rounding.
    expect(inst.rows.reduce((s: number, r: any) => s + Number(r.gallons), 0)).toBe(190)
    // And the money still reconciles to the fill total.
    expect(inst.rows.reduce((s: number, r: any) => s + Number(r.amount), 0)).toBeCloseTo(570, 2)

    // NOTHING is payable yet. Every installment is a future charge — the same
    // way October's rent isn't owed in August.
    for (const r of inst.rows as any[]) expect(r.payment_id).toBeNull()
    const pays = await db.query(`SELECT id FROM payments WHERE entry_description='PROPANE'`)
    expect(pays.rows).toHaveLength(0)

    // Four consecutive months, starting NEXT month.
    const months = (inst.rows as any[]).map(r => String(r.billing_cycle_month).slice(0, 7))
    expect(new Set(months).size).toBe(4)
  })

  // S609 (Nic): ACCELERATION REMOVED. A new fill used to make every remaining
  // prior installment due immediately. That is incompatible with the model Nic
  // specified — "all decided before any money moves", each installment landing on
  // a known future invoice — and it re-created the harm the immediate charge was
  // removed for: a mid-month due-now row that, under pay-in-full, can block the
  // tenant paying their RENT.
  it('a second fill does NOT accelerate the first — both just run their schedules', async () => {
    const app = buildApp()
    const f = await seed()
    await setSetting(app, f, { allowInstallments: true })
    await postFill(app, f, { unitId: f.unitAId, gallons: 120, pricePerGallon: 3, installments: 4 })
    const fill2 = await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3, installments: 1 })
    expect(fill2.status).toBe(201)

    // Nothing became payable. Five scheduled installments across two fills,
    // every one still a future charge waiting for its month.
    const unbilled = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM propane_fill_installments WHERE payment_id IS NULL`)
    expect(unbilled.rows[0].n).toBe(5)
    const pays = await db.query(`SELECT id FROM payments WHERE entry_description='PROPANE'`)
    expect(pays.rows).toHaveLength(0)
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

/**
 * S609 (Nic): ONE MASTER BILL, SEVERAL TANKS.
 *
 * "We use separate tanks filled on one invoice (master) and then charge tenants
 * according to their gallons that went into their tank... It's already on the
 * bill in terms of gallons, so we just need to be able to type in this many
 * gallons at this unit or some units that don't have it, don't get those gallons
 * because they don't have propane. It's a per time fill... it may be once every
 * three months."
 *
 * Recording that meant the single-fill form once per tank, retyping the same
 * price each pass. A delivery is one document, so it is entered as one thing.
 */
describe('S609 POST /propane/deliveries', () => {
  async function unitWithTenant(f: Fixture): Promise<string> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unitId = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordAId, status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId })
      // S613: a space only takes a delivery once it is marked as having a tank.
      await c.query(`UPDATE units SET has_propane_tank = true WHERE id = $1`, [unitId])
      await c.query('COMMIT')
      return unitId
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  const postDelivery = (app: express.Express, f: Fixture, body: any) =>
    request(app).post('/api/propane/deliveries').set('Authorization', `Bearer ${f.tokenA}`).send(body)

  it('records one fill per tank at the invoice price', async () => {
    const f = await seed()
    const u2 = await unitWithTenant(f)
    const res = await postDelivery(buildApp(), f, {
      propertyId: f.propertyAId,
      pricePerGallon: 3.25,
      lines: [
        { unitId: f.unitAId, gallons: 40 },
        { unitId: u2,        gallons: 22.5 },
      ],
    })
    expect(res.status).toBe(201)
    expect(res.body.data.tanks).toBe(2)
    expect(res.body.data.totalGallons).toBeCloseTo(62.5, 2)

    const { rows } = await db.query<any>(
      `SELECT unit_id, gallons, price_per_gallon, total_amount
         FROM propane_fills ORDER BY gallons DESC`)
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].gallons)).toBe(40)
    // Each tank is charged its OWN gallons at the one invoice price.
    expect(Number(rows[0].total_amount)).toBeCloseTo(40 * 3.25, 2)
    expect(Number(rows[1].total_amount)).toBeCloseTo(22.5 * 3.25, 2)
    for (const r of rows) expect(Number(r.price_per_gallon)).toBeCloseTo(3.25, 2)
  })

  it('a unit not on the delivery is not billed — it has no propane', async () => {
    const f = await seed()
    const u2 = await unitWithTenant(f)
    await postDelivery(buildApp(), f, {
      propertyId: f.propertyAId, pricePerGallon: 3,
      lines: [{ unitId: f.unitAId, gallons: 30 }],
    })
    const { rows } = await db.query<any>(`SELECT unit_id FROM propane_fills`)
    expect(rows).toHaveLength(1)
    expect(rows[0].unit_id).toBe(f.unitAId)
    expect(rows[0].unit_id).not.toBe(u2)
  })

  it('ALL OR NOTHING — one bad line records nothing', async () => {
    // Transcribing one invoice must not leave some tanks in and some out.
    const f = await seed()
    // S613: give the vacant space a tank so this still fails for the reason it
    // was written to test — the missing LEASE, not the missing tank (which the
    // S613 block below covers on its own).
    await db.query(`UPDATE units SET has_propane_tank = true WHERE id = $1`, [f.vacantUnitId])
    const res = await postDelivery(buildApp(), f, {
      propertyId: f.propertyAId, pricePerGallon: 3,
      lines: [
        { unitId: f.unitAId,      gallons: 30 },
        { unitId: f.vacantUnitId, gallons: 20 },   // no active lease
      ],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no active lease/i)
    const { rows } = await db.query<any>(`SELECT id FROM propane_fills`)
    expect(rows).toHaveLength(0)
  })

  it('the same unit twice on one delivery is refused', async () => {
    const f = await seed()
    const res = await postDelivery(buildApp(), f, {
      propertyId: f.propertyAId, pricePerGallon: 3,
      lines: [
        { unitId: f.unitAId, gallons: 30 },
        { unitId: f.unitAId, gallons: 10 },
      ],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/twice/i)
  })

  it('a repeat submit of the same delivery is a no-op', async () => {
    const f = await seed()
    const key = randomUUID()
    const body = {
      propertyId: f.propertyAId, pricePerGallon: 3,
      lines: [{ unitId: f.unitAId, gallons: 30 }], clientKey: key,
    }
    await postDelivery(buildApp(), f, body).expect(201)
    const again = await postDelivery(buildApp(), f, body)
    expect(again.status).toBe(200)
    expect(again.body.data.idempotent).toBe(true)
    const { rows } = await db.query<any>(`SELECT id FROM propane_fills`)
    expect(rows).toHaveLength(1)
  })

  it('another landlord cannot record a delivery here', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/propane/deliveries')
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ propertyId: f.propertyAId, pricePerGallon: 3, lines: [{ unitId: f.unitAId, gallons: 10 }] })
    expect(res.status).toBe(403)
  })

  it('a unit at another property cannot be slipped onto the delivery', async () => {
    const f = await seed()
    const c = await db.connect()
    let foreignUnit = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const otherProp = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      foreignUnit = await seedUnit(c, { propertyId: otherProp, landlordId })
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await postDelivery(buildApp(), f, {
      propertyId: f.propertyAId, pricePerGallon: 3,
      lines: [{ unitId: foreignUnit, gallons: 10 }],
    })
    expect(res.status).toBe(404)
  })
  // S609 (Nic): the settle-time PROPANE REDISTRIBUTION tests are gone with the
  // behaviour they covered. That path applied a tenant's rent money to
  // accelerated propane FIRST — the exact rent-supersession Nic ruled out:
  // "it's gonna apply the payment to the oldest charge, which would supersede
  // the rent, which would still end up letting the tenant acquire late fees."
  //
  // S613: the service, its call in the settle webhook, its tenant notification
  // and the `accelerated` column are all DELETED. Verified dead before cutting —
  // nothing anywhere set the flag, so the query could never match. (The word
  // also appears as a flex_deposit_plan_status value in flexsuiteAcceptance;
  // that is a different column and was left alone.)

})

/**
 * S609 (Nic): FILLS QUEUE BEHIND EACH OTHER.
 *
 *   "It needs to queue behind. It shouldn't overlap on the December invoice.
 *    That's not really a thing."
 *
 * An invoice carries at most ONE propane installment. A refill starts after the
 * last installment already scheduled, not next month.
 */
describe('S609 propane fills queue behind each other', () => {
  it('a second fill starts after the first fill\'s last installment', async () => {
    const app = buildApp()
    const f = await seed()
    await setSetting(app, f, { allowInstallments: true })
    // Fill 1, 4 ways → the next four months.
    await postFill(app, f, { unitId: f.unitAId, gallons: 120, pricePerGallon: 3, installments: 4 })
    // Fill 2 lands while all four are still scheduled.
    await postFill(app, f, { unitId: f.unitAId, gallons: 40, pricePerGallon: 3, installments: 2 })

    const inst = await db.query<any>(
      `SELECT i.billing_cycle_month::text AS cycle
         FROM propane_fill_installments i
         JOIN propane_fills fl ON fl.id = i.fill_id
        WHERE fl.unit_id = $1 ORDER BY i.billing_cycle_month`, [f.unitAId])
    expect(inst.rows).toHaveLength(6)

    // SIX distinct months — never two installments sharing an invoice.
    const months = inst.rows.map((r: any) => r.cycle)
    expect(new Set(months).size).toBe(6)

    // And they are consecutive: fill 2 picks up right after fill 1 ends.
    for (let i = 1; i < months.length; i++) {
      const prev = new Date(months[i - 1] + 'T00:00:00Z')
      prev.setUTCMonth(prev.getUTCMonth() + 1)
      expect(months[i]).toBe(prev.toISOString().slice(0, 10))
    }
  })

  it('a fill on a unit with nothing queued still starts next month', async () => {
    const app = buildApp()
    const f = await seed()
    await postFill(app, f, { unitId: f.unitAId, gallons: 20, pricePerGallon: 3, installments: 1 })
    const inst = await db.query<any>(
      `SELECT billing_cycle_month::text AS cycle FROM propane_fill_installments`)
    const next = new Date()
    next.setUTCDate(1)
    next.setUTCMonth(next.getUTCMonth() + 1)
    expect(inst.rows[0].cycle).toBe(next.toISOString().slice(0, 10))
  })
})

// S613 (Nic): the unit page asks a narrower question than the property page —
// "does THIS space have propane, and what does it still owe" — and it renders
// nothing at all when the answer is no. A property-wide list capped at 50 could
// answer neither on a park with a busy winter.
describe('GET /api/propane/fills?unitId — S613 unit filter', () => {
  it("returns only that unit's fills, and nothing for a unit with none", async () => {
    const f = await seed()
    const app = buildApp()
    const made = await postFill(app, f, { unitId: f.unitAId, gallons: 100, pricePerGallon: 3, installments: 1 })
    expect(made.status).toBe(201)

    const mine = await request(app)
      .get(`/api/propane/fills?propertyId=${f.propertyAId}&unitId=${f.unitAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data).toHaveLength(1)
    expect(mine.body.data[0].unit_id).toBe(f.unitAId)

    const other = await request(app)
      .get(`/api/propane/fills?propertyId=${f.propertyAId}&unitId=${f.vacantUnitId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(other.status).toBe(200)
    expect(other.body.data).toHaveLength(0)
  })
})

// S613 (Nic): "You need to link which units even HAVE tanks to be filled so that
// you can record the event in the first place." A fill against a space with no
// tank on record is refused, and says where to mark it.
describe('propane tanks are declared on the unit (S613)', () => {
  it('refuses a fill on a unit with no tank, and names the fix', async () => {
    const f = await seed()
    const app = buildApp()
    await db.query(`UPDATE units SET has_propane_tank = false WHERE id = $1`, [f.unitAId])
    const res = await postFill(app, f, { unitId: f.unitAId, gallons: 50, pricePerGallon: 3, installments: 1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no propane tank on record/i)
    expect(res.body.error).toMatch(/unit/i)
  })

  it('a delivery is refused whole when one line has no tank — nothing is written', async () => {
    const f = await seed()
    const app = buildApp()
    const res = await request(app).post('/api/propane/deliveries')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, pricePerGallon: 3, installments: 1,
              lines: [{ unitId: f.unitAId, gallons: 40 }, { unitId: f.vacantUnitId, gallons: 40 }] })
    expect(res.status).toBe(400)
    const fills = await db.query(`SELECT id FROM propane_fills WHERE unit_id = $1`, [f.unitAId])
    expect(fills.rows).toHaveLength(0)
  })

  it('a marked tank takes a fill normally', async () => {
    const f = await seed()
    const app = buildApp()
    const ok = await postFill(app, f, { unitId: f.unitAId, gallons: 60, pricePerGallon: 3, installments: 1 })
    expect(ok.status).toBe(201)
  })
})

// S613 (Nic): "It needs to be toggled the same way as trash. If I just click on
// the propane — ten, eleven, twelve, fifteen, sixteen, eighteen — they're all
// toggled on, and so they all can get delivery amounts individually."
describe('bulk propane tanks (S613)', () => {
  it('sets membership: ticked spaces get a tank, unticked ones lose it', async () => {
    const f = await seed()
    const app = buildApp()
    // Fixture starts with a tank on unitA only.
    const on = await request(app).put('/api/propane/tanks')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, unitIds: [f.unitAId, f.vacantUnitId] })
    expect(on.status).toBe(200)
    expect(on.body.data.withTank).toBe(2)
    let rows = (await db.query(
      `SELECT id, has_propane_tank FROM units WHERE id = ANY($1::uuid[])`,
      [[f.unitAId, f.vacantUnitId]])).rows
    expect(rows.every((r: any) => r.has_propane_tank)).toBe(true)

    const off = await request(app).put('/api/propane/tanks')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, unitIds: [f.unitAId] })
    expect(off.status).toBe(200)
    rows = (await db.query(
      `SELECT id, has_propane_tank FROM units WHERE id = ANY($1::uuid[])`,
      [[f.unitAId, f.vacantUnitId]])).rows
    expect(rows.find((r: any) => r.id === f.unitAId).has_propane_tank).toBe(true)
    expect(rows.find((r: any) => r.id === f.vacantUnitId).has_propane_tank).toBe(false)
  })

  it('refuses a unit that is not at this property', async () => {
    const f = await seed()
    const other = await seed()
    const res = await request(buildApp()).put('/api/propane/tanks')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, unitIds: [other.unitAId] })
    expect(res.status).toBe(400)
  })

  it('cross-landlord property → 403', async () => {
    const f = await seed()
    const res = await request(buildApp()).put('/api/propane/tanks')
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ propertyId: f.propertyAId, unitIds: [] })
    expect(res.status).toBe(403)
  })
})

// S613 (Nic): the delivery charge on a supplier's ticket. A fill priced purely
// at gallons × price left the landlord absorbing the hazmat / fuel / per-stop
// fee on every delivery.
describe('propane delivery charge (S613)', () => {
  it('splits the ticket fee across tanks by gallons, remainder on the last', async () => {
    const f = await seed()
    const app = buildApp()
    const u2 = await (async () => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const unitId = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
        const tenantId = await seedTenant(c)
        const leaseId = await seedLease(c, { unitId, landlordId: f.landlordAId, status: 'active' })
        await seedLeaseTenant(c, { leaseId, tenantId })
        await c.query(`UPDATE units SET has_propane_tank = true WHERE id = $1`, [unitId])
        await c.query('COMMIT')
        return unitId
      } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    })()

    const res = await request(app).post('/api/propane/deliveries')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, pricePerGallon: 3, installments: 1,
              deliveryCharge: 30, deliveryChargeSplit: 'gallons',
              lines: [{ unitId: f.unitAId, gallons: 75 }, { unitId: u2, gallons: 25 }] })
    expect(res.status).toBe(201)

    const { rows } = await db.query<any>(
      `SELECT unit_id, gallons, delivery_fee_share, total_amount
         FROM propane_fills ORDER BY gallons DESC`)
    expect(rows).toHaveLength(2)
    // 75 of 100 gallons carries 75% of the $30.
    expect(Number(rows[0].delivery_fee_share)).toBe(22.50)
    expect(Number(rows[1].delivery_fee_share)).toBe(7.50)
    // The shares sum to the ticket exactly — the landlord passes on what he paid.
    expect(Number(rows[0].delivery_fee_share) + Number(rows[1].delivery_fee_share)).toBe(30)
    // And the fee is IN the tenant's total: 75 × $3 + $22.50.
    expect(Number(rows[0].total_amount)).toBe(247.50)
  })

  it('splits evenly per tank when asked', async () => {
    const f = await seed()
    const app = buildApp()
    const res = await request(app).post('/api/propane/deliveries')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, pricePerGallon: 3, installments: 1,
              deliveryCharge: 25, deliveryChargeSplit: 'even',
              lines: [{ unitId: f.unitAId, gallons: 80 }] })
    expect(res.status).toBe(201)
    const { rows } = await db.query<any>(`SELECT delivery_fee_share FROM propane_fills`)
    expect(Number(rows[0].delivery_fee_share)).toBe(25)
  })

  it('no delivery charge → nothing added, as before', async () => {
    const f = await seed()
    const app = buildApp()
    await postFill(app, f, { unitId: f.unitAId, gallons: 50, pricePerGallon: 3, installments: 1 })
    const { rows } = await db.query<any>(`SELECT delivery_fee_share, total_amount FROM propane_fills`)
    expect(Number(rows[0].delivery_fee_share)).toBe(0)
    expect(Number(rows[0].total_amount)).toBe(150)
  })
})

// S632 (Nic, DIRECTIVE): "We put in our true cost total dollar bill, and then we
// divide out total gallons delivered... we need a back end setting for the
// markup. That way when we have a fluctuating rate, we have our margin always
// balanced on the back end. The markup applies on every customer. It doesn't
// matter if they pay in full or get finance charge."
describe('S632 true cost + property markup', () => {
  async function unitWithTank(f: Fixture): Promise<string> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unitId = await seedUnit(c, { propertyId: f.propertyAId, landlordId: f.landlordAId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordAId, status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query(`UPDATE units SET has_propane_tank = true WHERE id = $1`, [unitId])
      await c.query('COMMIT')
      return unitId
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it("Nic's example: $5,000 / 1,000 gal + 25c, a 200-gallon tank bills $1,050", async () => {
    const f = await seed()
    const app = buildApp()
    const unitId = await unitWithTank(f)
    await request(app).post('/api/propane/settings')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, markupPerGallon: 0.25 }).expect(200)

    const res = await request(app).post('/api/propane/deliveries')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, invoiceTotal: 5000, invoiceGallons: 1000,
              installments: 1, lines: [{ unitId, gallons: 200 }] })
    expect(res.status).toBe(201)
    expect(res.body.data.trueCostPerGallon).toBe(5)
    expect(res.body.data.billedPerGallon).toBe(5.25)
    expect(res.body.data.totalAmount).toBe(1050)     // 200 × $5.25
    expect(res.body.data.margin).toBe(50)            // 200 × $0.25
    expect(res.body.data.unallocatedGallons).toBe(800)
  })

  it('keeps full precision on a rate that does not divide cleanly', async () => {
    const f = await seed()
    const app = buildApp()
    const unitId = await unitWithTank(f)
    await request(app).post('/api/propane/settings')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, markupPerGallon: 0.20 }).expect(200)

    // $4,873.20 / 940 gal = $5.1842553..., NOT $5.18. Rounding the rate would
    // lose real money across the delivery — the point of deriving it server-side.
    const res = await request(app).post('/api/propane/deliveries')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, invoiceTotal: 4873.20, invoiceGallons: 940,
              installments: 1, lines: [{ unitId, gallons: 300 }] })
    expect(res.status).toBe(201)
    expect(res.body.data.trueCostPerGallon).toBeCloseTo(5.1843, 3)
    // 300 × (5.1842553 + 0.20) = 1615.28, not 300 × 5.38 = 1614.00
    expect(res.body.data.totalAmount).toBeCloseTo(1615.28, 2)
  })

  it('the markup does not vary with the payment plan — 1 or 4 bills the same', async () => {
    const f = await seed()
    const app = buildApp()
    // Instalments are OFF per property by default — a 4-way split is refused
    // until the landlord turns them on. That is the gate, not the markup.
    await request(app).post('/api/propane/settings')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, markupPerGallon: 0.25, allowInstallments: true })
      .expect(200)

    const totals: number[] = []
    for (const installments of [1, 4]) {
      const unitId = await unitWithTank(f)
      const res = await request(app).post('/api/propane/deliveries')
        .set('Authorization', `Bearer ${f.tokenA}`)
        .send({ propertyId: f.propertyAId, invoiceTotal: 5000, invoiceGallons: 1000,
                installments, lines: [{ unitId, gallons: 200 }] })
      expect(res.status).toBe(201)
      totals.push(res.body.data.totalAmount)
    }
    // Paying over time costs no more than paying at once: a margin, not a
    // finance charge. This is the assertion that keeps it that way.
    expect(totals[0]).toBe(totals[1])
  })

  it('snapshots the cost and markup so a later rate change cannot restate history', async () => {
    const f = await seed()
    const app = buildApp()
    const unitId = await unitWithTank(f)
    await request(app).post('/api/propane/settings')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, markupPerGallon: 0.25 }).expect(200)
    await request(app).post('/api/propane/deliveries')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, invoiceTotal: 5000, invoiceGallons: 1000,
              installments: 1, lines: [{ unitId, gallons: 100 }] }).expect(201)

    // The market moves and the landlord re-rates the property.
    await request(app).post('/api/propane/settings')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, markupPerGallon: 0.40 }).expect(200)

    const row = await db.query<{ t: string; m: string; p: string }>(
      `SELECT true_cost_per_gallon::text AS t, markup_per_gallon::text AS m,
              price_per_gallon::text AS p
         FROM propane_fills WHERE unit_id = $1`, [unitId])
    expect(Number(row.rows[0].t)).toBe(5)
    expect(Number(row.rows[0].m)).toBe(0.25)   // still what it was that day
    expect(Number(row.rows[0].p)).toBe(5.25)
  })

  it('refuses a half-given invoice rather than guessing', async () => {
    const f = await seed()
    const app = buildApp()
    const unitId = await unitWithTank(f)
    const res = await request(app).post('/api/propane/deliveries')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyAId, invoiceTotal: 5000,
              installments: 1, lines: [{ unitId, gallons: 200 }] })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toMatch(/gallons delivered/i)
  })
})
