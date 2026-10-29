/**
 * 10/3 (final sweep) — a move-out read taken off the reads-due to-do names
 * whose move-out it is.
 *
 * The case: household A left a space with no read of its own; household D has
 * been on it since. When D's move-out read is taken, the move-out rule alone
 * would bill A (a household that left comes first). The to-do row knows the read
 * is D's, so the form sends D's lease and the bill lands on D. A lease from
 * another company is ignored, never an error.
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
import { unitPendingReads, getReadsDue } from '../services/utilityReadingRuns'
import { generateBillsForMeter } from '../services/utilityBilling'
import { expectNoFigures } from '../test/noLeaks'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_special_read'
})

const day = async (offset: number) =>
  (await db.query<{ d: string }>(`SELECT to_char(CURRENT_DATE + $1::int, 'YYYY-MM-DD') AS d`, [offset])).rows[0].d

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const b = await seedLandlord(c)
    const prop = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const unit = await seedUnit(c, { propertyId: prop, landlordId: a.landlordId })
    const meter = await seedUtilityMeter(c, { propertyId: prop, utilityType: 'electric', billingMethod: 'submeter' })
    await c.query(`UPDATE utility_meters SET rate_per_unit = 0.21, base_fee = 0 WHERE id = $1`, [meter])
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meter, unit])

    const lease = async (landlordId: string, unitId: string) => {
      const id = await seedLease(c, { unitId, landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: id, tenantId: await seedTenant(c) })
      await c.query(`INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
                     VALUES ($1, 'electric', TRUE)`, [id])
      return id
    }
    // A: on the space, left five days ago with no read of its own.
    const gone = await lease(a.landlordId, unit)
    await c.query(`UPDATE leases SET start_date = CURRENT_DATE - 200, status = 'expired', end_date = CURRENT_DATE - 5 WHERE id = $1`, [gone])
    // D: on the space since the day after; this is D's move-out read.
    const mover = await lease(a.landlordId, unit)
    await c.query(`UPDATE leases SET start_date = CURRENT_DATE - 4 WHERE id = $1`, [mover])
    await c.query(`UPDATE lease_unit_history SET effective_from = CURRENT_DATE - 4 WHERE lease_id = $1`, [mover])
    // A lease of another company, on its own space.
    const bProp = await seedProperty(c, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId })
    const foreign = await lease(b.landlordId, await seedUnit(c, { propertyId: bProp, landlordId: b.landlordId }))

    // The read before: ten days ago.
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, CURRENT_DATE - 10, 1000, date_trunc('month', CURRENT_DATE - 10)::date, $2, 'monthly_cycle')`, [meter, a.userId])
    await c.query('COMMIT')
    const token = jwt.sign({ userId: a.userId, role: 'landlord', email: 'a@t.dev', profileId: a.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { meter, unit, gone, mover, foreign, token, propertyId: prop, landlordId: a.landlordId, userId: a.userId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const readOut = (f: { meter: string; token: string }, body: object) =>
  request(buildApp()).post(`/api/utility/meters/${f.meter}/reads`)
    .set('Authorization', `Bearer ${f.token}`)
    .send({ readingValue: 1100, reason: 'move_out_final', ...body })

const billedTo = async (meter: string) =>
  (await db.query<{ lease_id: string; usage: number }>(
    `SELECT lease_id, usage_amount::float AS usage FROM utility_bills WHERE meter_id = $1`, [meter])).rows

/**
 * Every leaf value in an answer, as text — for asking "is the reading itself in
 * here anywhere", without a substring scan over ids that happen to contain it.
 */

describe('a move-out read names whose move-out it is', () => {
  it('the to-do sends the leaving household: that household is billed, not one that left earlier', async () => {
    const f = await seed()
    const r = await readOut(f, { leaseId: f.mover })
    expect(r.status).toBe(201)
    expect(r.body.data.billed).toBe(true)
    expect(await billedTo(f.meter)).toEqual([{ lease_id: f.mover, usage: 100 }])
  })

  it('a lease from another company is ignored, never an error: the read bills by the normal rule', async () => {
    const f = await seed()
    const r = await readOut(f, { leaseId: f.foreign })
    expect(r.status).toBe(201)
    expect(r.body.data.billed).toBe(true)
    expect(await billedTo(f.meter)).toEqual([{ lease_id: f.gone, usage: 100 }])
    expect((await db.query(`SELECT 1 FROM utility_bills WHERE lease_id = $1`, [f.foreign])).rows).toHaveLength(0)
  })

  it('the response stays blind: no reading values come back', async () => {
    const f = await seed()
    const r = await readOut(f, { leaseId: f.mover })
    // 10/17: this read `JSON.stringify(r.body)` for the text "1100" or "1000" —
    // an id like …a1000f… is not a leaked reading. 10/22 (Nic): the rule for
    // that lives in ONE place now, test/noLeaks, instead of a copy per file.
    expectNoFigures(r.body, [1100, 1000])
  })
})

describe('check-in asks for each meter once', () => {
  it('two departures on one space ask for its meter once, as the billing move-out, with that lease', async () => {
    const f = await seed()
    // D leaves too (yesterday) — tenant-responsible, so its read bills.
    await db.query(`UPDATE leases SET status = 'expired', end_date = $2 WHERE id = $1`, [f.mover, await day(-1)])
    // A's departure no longer bills on this meter (utilities included for it).
    await db.query(`UPDATE lease_utility_responsibilities SET tenant_responsible = FALSE WHERE lease_id = $1`, [f.gone])
    // Read before both departures still only the one from ten days ago.
    const rows = await unitPendingReads(f.unit)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ meter_id: f.meter, reason: 'move_out_final', lease_id: f.mover })
  })

  it('a stay turnover carries no lease', async () => {
    const f = await seed()
    await db.query(`UPDATE lease_utility_responsibilities SET tenant_responsible = FALSE`)
    await db.query(`UPDATE leases SET status = 'expired', end_date = $2 WHERE id = $1`, [f.mover, await day(-1)])
    const rows = await unitPendingReads(f.unit)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ meter_id: f.meter, reason: 'stay_turnover', lease_id: null })
  })
})

// 10/3 (permission-hints check): a staffer who only reads meters reads blind.
describe('a meter reader reads blind', () => {
  async function staff(f: { propertyId: string; landlordId: string }, perms: Record<string, boolean>) {
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u.rows[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
    return jwt.sign({ userId: u.rows[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }
  const meters = (token: string, propertyId: string) =>
    request(buildApp()).get(`/api/utility/meters?propertyId=${propertyId}`).set('Authorization', `Bearer ${token}`)
  // 10/17: the opening read used to be stamped `(SELECT user_id FROM landlords
  // LIMIT 1)` — an unordered pick over every landlord in the database, which is
  // this seed's OTHER company as often as its own. It is the owner's read, so
  // it says so.
  async function withOpeningRead(f: { meter: string; userId: string }) {
    await db.query(`UPDATE utility_meters SET base_fee = 3 WHERE id = $1`, [f.meter])
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, CURRENT_DATE - 60, 777, date_trunc('month', CURRENT_DATE - 60)::date, $2, 'baseline')`,
      [f.meter, f.userId])
  }

  it('master bills are owner-only: a meter reader gets 403, the owner gets the list', async () => {
    const f = await seed()
    const reader = await staff(f, { 'utility.read_meters': true })
    const r = await request(buildApp()).get(`/api/utility/master-bills?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${reader}`)
    expect(r.status).toBe(403)
    const o = await request(buildApp()).get(`/api/utility/master-bills?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.token}`)
    expect(o.status).toBe(200)
  })

  it('the meter list gives a reader no reading value and no prices', async () => {
    const f = await seed()
    await withOpeningRead(f)
    const reader = await staff(f, { 'utility.read_meters': true })
    const r = await meters(reader, f.propertyId)
    expect(r.status).toBe(200)
    const m = r.body.data.find((x: any) => x.id === f.meter)
    expect(m).toBeTruthy()
    expect(m.opening_read).toBeTruthy()
    expect(m.opening_read.value).toBeUndefined()
    expect(m.rate_per_unit).toBeUndefined()
    expect(m.base_fee).toBeUndefined()
    // 10/15: this read `JSON.stringify(r.body)` for the text "777", which an
    // id like …a777f… trips once the test database holds other rows — the
    // full suite failed on that, not on a leak. The check is now exact: no
    // field anywhere in the answer IS the reading.
    expectNoFigures(r.body.data, [777])
  })

  it('staff who can see units keep the prices but still never the reading value', async () => {
    const f = await seed()
    await withOpeningRead(f)
    const desk = await staff(f, { 'utility.read_meters': true, 'units.view_status': true })
    const m = (await meters(desk, f.propertyId)).body.data.find((x: any) => x.id === f.meter)
    expect(Number(m.rate_per_unit)).toBeCloseTo(0.21, 2)
    expect(m.opening_read.value).toBeUndefined()
  })

  it('the owner still sees the opening read and the prices', async () => {
    const f = await seed()
    await withOpeningRead(f)
    const m = (await meters(f.token, f.propertyId)).body.data.find((x: any) => x.id === f.meter)
    expect(Number(m.opening_read.value)).toBe(777)
    expect(Number(m.rate_per_unit)).toBeCloseTo(0.21, 2)
    expect(Number(m.base_fee)).toBe(3)
  })
})

// ── 10/20 — A DROPPED DIGIT AT A PULL-OUT IS NOT THE METER'S READING ────────
//
// The complaint: prior read 48000 on a six-digit electric submeter, the clerk
// drops a digit at the pull-out and types 4800. S561 already refused to bill it
// — a below-previous read on a meter nowhere near its ceiling is a typo, not a
// wrap — and then the 4800 sat in the table as the meter's newest reading
// anyway. It cleared the closing-read to-do as though the walk were done, the
// landlord was told nothing, and the next occupant's read of 49000 measured all
// the way back to 4800: 44,200 kWh, nearly all of it the departed guest's power,
// billed to whoever moved in behind them. The guest's real usage was billed to
// nobody.
//
// One rule closes all of it: A READING NOBODY HAS SETTLED IS NOT THE METER'S
// READING OF RECORD. It is kept (GAM never erases), flagged for the landlord's
// double-check carrying the household the desk named, and until it is settled it
// neither satisfies the to-do nor serves as anybody's baseline. The desk still
// learns nothing about the figure.
describe('a dropped digit at a pull-out', () => {
  /** The prior read of record is 48000; the pull-out read is a digit short. */
  async function typo() {
    const f = await seed()
    // 48000, and taken in the month BEFORE this one: the seed's read sits ten
    // days back, which is the same cycle as today for most of a month, and this
    // group needs room to add the current cycle's own monthly read.
    await db.query(
      `UPDATE utility_meter_readings
          SET reading_value = 48000,
              reading_date = CURRENT_DATE - 40,
              billing_cycle_month = date_trunc('month', CURRENT_DATE - 40)::date
        WHERE meter_id = $1`, [f.meter])
    const r = await request(buildApp()).post(`/api/utility/meters/${f.meter}/reads`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ readingValue: 4800, reason: 'move_out_final', leaseId: f.gone })
    return { f, r }
  }
  const closingRead = async (meter: string) => (await db.query<any>(
    `SELECT id, reading_value::float AS value, needs_review, review_note, move_out_lease_id
       FROM utility_meter_readings WHERE meter_id = $1 AND reason = 'move_out_final'`, [meter])).rows

  it('is kept, bills nobody, and waits on the landlord with the household it closes out', async () => {
    const { f, r } = await typo()
    expect(r.status).toBe(201)
    expect(r.body.data.billed).toBe(false)
    const rows = await closingRead(f.meter)
    expect(rows).toHaveLength(1)                       // kept — GAM never erases
    expect(rows[0].value).toBe(4800)
    expect(rows[0].needs_review).toBe(true)            // the landlord's double-check queue
    expect(rows[0].review_note).toBeTruthy()
    expect(rows[0].move_out_lease_id).toBe(f.gone)     // whose move-out it was
    expect((await db.query(`SELECT 1 FROM utility_bills WHERE meter_id = $1`, [f.meter])).rows).toHaveLength(0)
  })

  it('tells the desk it is waiting, and nothing that gives the previous read away', async () => {
    const { r } = await typo()
    expect(r.body.data.billingNote).toMatch(/double-check/i)
    // Not which way the number was off, and never a figure: say "below the last
    // read" and the clerk has learned the last read is higher.
    expect(r.body.data.billingNote).not.toMatch(/below|under|low|high|above/i)
    expectNoFigures(r.body, [4800, 48000])
  })

  it('leaves the closing-read to-do open — the walk still has to happen', async () => {
    const { f } = await typo()
    expect((await getReadsDue(f.propertyId)).map((d: any) => d.meter_id)).toContain(f.meter)
    expect((await unitPendingReads(f.unit)).map((d: any) => d.meter_id)).toContain(f.meter)
  })

  it('is not the next household\'s starting point: their read measures from the last settled figure', async () => {
    const { f } = await typo()
    // The space turns over and the next household takes its own pull-out read.
    await db.query(`UPDATE leases SET status = 'expired', end_date = CURRENT_DATE WHERE id = $1`, [f.mover])
    const r = await request(buildApp()).post(`/api/utility/meters/${f.meter}/reads`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ readingValue: 49000, reason: 'move_out_final', leaseId: f.mover })
    expect(r.status).toBe(201)
    expect(r.body.data.billed).toBe(true)
    // 49000 − 48000, not 49000 − 4800 (44,200 kWh of somebody else's power).
    expect(await billedTo(f.meter)).toEqual([{ lease_id: f.mover, usage: 1000 }])
  })

  it('does not let the monthly run bill a span with the unsettled read inside it', async () => {
    const { f } = await typo()
    const cycle = (await db.query<{ c: string }>(
      `SELECT date_trunc('month', CURRENT_DATE)::date::text AS c`)).rows[0].c
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, CURRENT_DATE, 49000, $2, $3, 'monthly_cycle')`, [f.meter, cycle, f.userId])
    const res = await generateBillsForMeter(f.meter, new Date(cycle + 'T00:00:00Z'))
    expect(res.billsCreated).toBe(0)
    expect(res.reason).toMatch(/double-check/i)
    expect((await db.query(`SELECT 1 FROM utility_bills WHERE meter_id = $1`, [f.meter])).rows).toHaveLength(0)
  })

  it('bills the household that left once the landlord corrects it, and closes the to-do', async () => {
    const { f } = await typo()
    const [held] = await closingRead(f.meter)
    const r = await request(buildApp()).post(`/api/utility/readings/${held.id}/resolve-review`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ correctedValue: 48060 })
    expect(r.status).toBe(200)
    expect(await billedTo(f.meter)).toEqual([{ lease_id: f.gone, usage: 60 }])
    expect((await getReadsDue(f.propertyId)).map((d: any) => d.meter_id)).not.toContain(f.meter)
  })

  it('bills nothing across a low read the landlord settles as a meter swap, not a wrap', async () => {
    const { f } = await typo()
    const [held] = await closingRead(f.meter)
    const r = await request(buildApp()).post(`/api/utility/readings/${held.id}/resolve-review`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ rollover: false })
    expect(r.status).toBe(200)
    // A swapped meter took its last turns with it — 4800 against a prior 48000
    // must never be read as a 995,200-unit wrap.
    expect(await billedTo(f.meter)).toEqual([])
  })
})
