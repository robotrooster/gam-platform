/**
 * 10/12 (Nic), M1 — "ADD 'Works, tenant uses no power' choice next to
 * 'Repaired' (Gerald specifically is gone, not plugged in, paying for
 * occupancy)."
 *
 *   1. The choice (PATCH /api/utility/meters/:id { outOfService: false,
 *      zeroUseConfirmed: true }) puts a broken meter back in service with NO new
 *      reading and records the zero-use confirmation and who made it.
 *      "Repaired" still needs its reading and confirms nothing (S648).
 *   2. Billing: a confirmed meter's flat reads bill $0 — not marked broken, not
 *      estimated (even where the property estimates), nobody told — month after
 *      month. Without the confirmation the same flat read is a broken meter, as
 *      it is for everyone else (S648).
 *   3. A read after it that shows use ends it — decided from the reads as they
 *      stand when the cycle is billed (10/12 review: never the moment a read is
 *      saved, so a typo corrected before billing leaves it), and from then on a
 *      flat read is a stuck meter again. Reads that start a measurement, a read
 *      waiting on its double-check, a read on the day it was confirmed and a
 *      read showing the same number do not end it.
 *   4. Marking the meter broken by hand clears it.
 *   5. It is for the household that was there (the M1 build's reading of
 *      "tenant", not Nic's words): a new household on the space (even with no
 *      move-out read) is on the stuck-meter rule again; a renewal for the same
 *      people is not a new household; a former resident who comes back after
 *      it is (10/12 review: on the space = under a lease in force that day).
 *   6. 10/12 review: a move-out read ends it by the day it is DATED, not the
 *      day it was typed in, and an automatic broken-meter flag clears it.
 *   7. 10/12 (Nic), Q-d: the choice works on any meter, any time; an explicit
 *      zeroUseConfirmed: false is "not this choice", never a refusal.
 *   8. 10/12 (Nic), Q-f: voiding the unpaid estimates billed while it was
 *      flagged is the landlord's choice in the same window — soft void, kept on
 *      record; paid ones never touched; never the assistant's.
 *   9. 10/12 review: a team member scoped to some properties edits only their
 *      meters.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedManager } from '../test/dbHelpers'
import { ensureMeterZeroUseSchema } from '../test/pendingMeterSchema'
import { utilityRouter } from '../routes/utility'
import { errorHandler } from '../middleware/errorHandler'
import { generateBillsForMeter } from './utilityBilling'

beforeAll(ensureMeterZeroUseSchema)
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_meter_repair'
})

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/utility', utilityRouter)
  a.use(errorHandler)
  return a
}

async function park(opts: { estimates: boolean }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix', estimates_stuck_meters = $2 WHERE id = $1`,
      [propertyId, opts.estimates])
    await c.query('COMMIT')
    const token = jwt.sign({ userId: ll.userId, role: 'landlord', email: 'll@t.dev', profileId: ll.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { ...ll, propertyId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Park = Awaited<ReturnType<typeof park>>

/** An occupied RV space (lease since 1/1) with its own electric submeter, read 8/31 and 9/30. */
async function space(p: Park, unit: string, aug: number, sept: number) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: '2026-01-01' })
    await seedLeaseTenant(c, { leaseId, tenantId: await seedTenant(c) })
    await c.query(`UPDATE units SET unit_number = $2, unit_type = 'rv_spot', status = 'active' WHERE id = $1`, [unitId, unit])
    const meterId = (await c.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, base_fee, digits)
       VALUES ($1, 'electric', $2, 'submeter', 0.21, 0, 6) RETURNING id`, [p.propertyId, `${unit} electric`])).rows[0].id
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1, '2026-08-31', $2, '2026-08-01', 'monthly_cycle', $4), ($1, '2026-09-30', $3, '2026-09-01', 'monthly_cycle', $4)`,
      [meterId, aug, sept, p.userId])
    await c.query('COMMIT')
    return { unitId, meterId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const read = (p: Park, meterId: string, date: string, value: number, cycle: string,
  o: { reason?: string; needsReview?: boolean } = {}) =>
  db.query<{ id: string }>(
    `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, needs_review, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [meterId, date, value, cycle, o.reason ?? 'monthly_cycle', o.needsReview === true, p.userId]).then(r => r.rows[0].id)
const meterRow = (meterId: string) => db.query<any>(
  `SELECT out_of_service, out_of_service_since, zero_use_confirmed_at, zero_use_confirmed_by_user_id
     FROM utility_meters WHERE id = $1`, [meterId]).then(r => r.rows[0])
const confirmed = async (meterId: string) => (await meterRow(meterId)).zero_use_confirmed_at != null
const brokenNotices = () => db.query<{ body: string }>(
  `SELECT body FROM notifications WHERE type = 'utility_meter_broken' ORDER BY created_at`).then(r => r.rows)
const billsFor = (meterId: string, cycle: string) => db.query<any>(
  `SELECT usage_amount::float AS usage, charge_amount::float AS charge, allocation_method
     FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = $2`, [meterId, cycle]).then(r => r.rows)
const run = (meterId: string, cycle: string) => generateBillsForMeter(meterId, new Date(`${cycle}T00:00:00Z`))
const patch = (p: Park, meterId: string, body: any) =>
  request(app()).patch(`/api/utility/meters/${meterId}`).set('Authorization', `Bearer ${p.token}`).send(body)
/** As if the confirmation was made on 10/5 (Phoenix), so the dated reads below fall after it whatever day this runs. */
const confirmedOnOct5 = (meterId: string) =>
  db.query(`UPDATE utility_meters SET zero_use_confirmed_at = '2026-10-05 12:00:00-07' WHERE id = $1`, [meterId])
const broken = (meterId: string) =>
  db.query(`UPDATE utility_meters SET out_of_service = TRUE, out_of_service_since = '2026-10-01' WHERE id = $1`, [meterId])

describe('"Works, tenant uses no power" on a meter marked broken', () => {
  it('puts it back in service with no new reading and records the confirmation and who made it', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, 'RV 48', 49083, 49083)
    await broken(s.meterId)
    const res = await patch(p, s.meterId, { outOfService: false, zeroUseConfirmed: true })
    expect(res.status).toBe(200)
    const m = await meterRow(s.meterId)
    expect(m).toMatchObject({ out_of_service: false, out_of_service_since: null, zero_use_confirmed_by_user_id: p.userId })
    expect(m.zero_use_confirmed_at).not.toBeNull()
    // The meter was never broken: the reads it has stand, nothing is added.
    const reads = (await db.query(`SELECT reason FROM utility_meter_readings WHERE meter_id = $1 ORDER BY reading_date`, [s.meterId])).rows
    expect(reads.map((r: any) => r.reason)).toEqual(['monthly_cycle', 'monthly_cycle'])
  })

  it('"Repaired" still needs its reading and confirms nothing (S648)', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, 'RV 07', 100, 100)
    await broken(s.meterId)
    expect((await patch(p, s.meterId, { outOfService: false })).status).toBe(400)
    expect((await meterRow(s.meterId)).out_of_service).toBe(true)
    expect((await patch(p, s.meterId, { outOfService: false, repairedStartingReading: 0 })).status).toBe(200)
    const m = await meterRow(s.meterId)
    expect(m).toMatchObject({ out_of_service: false, zero_use_confirmed_at: null, zero_use_confirmed_by_user_id: null })
    const fresh = (await db.query(`SELECT reading_value::float AS v FROM utility_meter_readings WHERE meter_id = $1 AND reason = 'meter_replaced'`, [s.meterId])).rows
    expect(fresh).toEqual([{ v: 0 }])
  })

  it('is refused alongside marking it broken', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, 'RV 08', 100, 100)
    await broken(s.meterId)
    expect((await patch(p, s.meterId, { outOfService: true, zeroUseConfirmed: true })).status).toBe(400)
    expect(await confirmed(s.meterId)).toBe(false)
  })

  // 10/12 (Nic): "Any meter" — it was refused on everything but a submeter.
  it('works on any meter: a RUBS master, a master the landlord pays and a flat-rate meter, in service or marked broken', async () => {
    const p = await park({ estimates: false })
    const add = (label: string, method: string, extra: string, vals: string) => db.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method${extra})
       VALUES ($1, 'water', $2, $3${vals}) RETURNING id`, [p.propertyId, label, method]).then(r => r.rows[0].id)
    const rubs = await add('water master', 'rubs', ', rubs_allocation_method, digits', ", 'occupant_count', 6")
    const landlordPays = await add('office water', 'master_bill_to_landlord', ', digits', ', 6')
    const flat = await add('flat water', 'flat_rate', ', rate_per_unit', ', 25')
    for (const id of [rubs, landlordPays, flat]) {
      const res = await patch(p, id, { zeroUseConfirmed: true })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(await meterRow(id)).toMatchObject({ out_of_service: false, zero_use_confirmed_by_user_id: p.userId })
      expect(await confirmed(id)).toBe(true)
    }
    // Marked broken, it goes back in service with no reading — nothing was replaced.
    await broken(rubs)
    await db.query(`UPDATE utility_meters SET zero_use_confirmed_at = NULL, zero_use_confirmed_by_user_id = NULL WHERE id = $1`, [rubs])
    const back = await patch(p, rubs, { outOfService: false, zeroUseConfirmed: true })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(await meterRow(rubs)).toMatchObject({ out_of_service: false, out_of_service_since: null })
    expect(await confirmed(rubs)).toBe(true)
    expect((await db.query(`SELECT 1 FROM utility_meter_readings WHERE meter_id = ANY($1::uuid[])`, [[rubs, landlordPays, flat]])).rowCount).toBe(0)
  })

  it("is refused on another landlord's meter", async () => {
    const p = await park({ estimates: false })
    const other = await park({ estimates: false })
    const s = await space(other, 'RV 09', 100, 100)
    await broken(s.meterId)
    expect((await patch(p, s.meterId, { outOfService: false, zeroUseConfirmed: true })).status).toBe(403)
    expect(await meterRow(s.meterId)).toMatchObject({ out_of_service: true, zero_use_confirmed_at: null })
  })

  it('marking the meter broken by hand clears the confirmation', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, 'RV 40', 100, 100)
    await broken(s.meterId)
    await patch(p, s.meterId, { outOfService: false, zeroUseConfirmed: true })
    expect((await patch(p, s.meterId, { outOfService: true })).status).toBe(200)
    expect(await meterRow(s.meterId)).toMatchObject({ out_of_service: true, zero_use_confirmed_at: null, zero_use_confirmed_by_user_id: null })
  })
})

describe('billing a meter confirmed working with nobody using it', () => {
  it('flat reads bill $0 — not flagged, not estimated, nobody told — until a read shows use; then a flat read is a stuck meter again', async () => {
    // Mountain View estimates stuck meters, and RV 12 next door gives it a number to estimate from.
    const p = await park({ estimates: true })
    const g = await space(p, 'RV 48', 49083, 49083)
    const n = await space(p, 'RV 12', 5000, 5107)
    await read(p, n.meterId, '2026-10-31', 5210, '2026-10-01')
    await read(p, n.meterId, '2026-11-30', 5300, '2026-11-01')

    // September, as for everyone (S648): a flat read on an occupied space is a broken meter, estimated here.
    await run(g.meterId, '2026-09-01')
    expect((await meterRow(g.meterId)).out_of_service).toBe(true)
    expect((await billsFor(g.meterId, '2026-09-01')).map(b => b.allocation_method)).toEqual(['comparable_low'])
    const told = await brokenNotices()
    expect(told).toHaveLength(1)
    expect(told[0].body).toContain('Works, tenant uses no power')

    // The landlord: it works, he is not plugged in.
    expect((await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true })).status).toBe(200)
    await confirmedOnOct5(g.meterId)

    // October and November read the same number: $0, nothing flagged, nothing estimated, nobody told.
    await read(p, g.meterId, '2026-10-31', 49083, '2026-10-01')
    await run(g.meterId, '2026-10-01')
    await read(p, g.meterId, '2026-11-30', 49083, '2026-11-01')
    await run(g.meterId, '2026-11-01')
    expect((await meterRow(g.meterId)).out_of_service).toBe(false)
    expect(await confirmed(g.meterId)).toBe(true)
    for (const cycle of ['2026-10-01', '2026-11-01']) {
      expect((await billsFor(g.meterId, cycle)).filter(b => b.charge > 0 || b.allocation_method === 'comparable_low')).toEqual([])
    }
    expect(await brokenNotices()).toHaveLength(1)

    // He plugs in: a reference read on 12/10 shows use. Saving it decides nothing yet (10/12
    // review) — the cycle billed from the reads as they stand does.
    await read(p, g.meterId, '2026-12-10', 49123, '2026-12-01', { reason: 'other' })
    expect(await confirmed(g.meterId)).toBe(true)

    // The meter then sits still to 12/31 while he lives there: the confirmation has done its job
    // (it moved on 12/10), so the flat read is a broken meter again, like everyone else's.
    await read(p, n.meterId, '2026-12-31', 5400, '2026-12-01')
    await read(p, g.meterId, '2026-12-31', 49123, '2026-12-01')
    await run(g.meterId, '2026-12-01')
    expect(await confirmed(g.meterId)).toBe(false)
    expect((await meterRow(g.meterId)).out_of_service).toBe(true)
    expect(await brokenNotices()).toHaveLength(2)
  })

  it('a cycle read that shows use is billed, and clears it', async () => {
    const p = await park({ estimates: false })
    const g = await space(p, 'RV 48', 49083, 49083)
    await broken(g.meterId)
    await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true })
    await confirmedOnOct5(g.meterId)
    await read(p, g.meterId, '2026-10-31', 49190, '2026-10-01')
    await run(g.meterId, '2026-10-01')
    expect(await confirmed(g.meterId)).toBe(false)
    // Measured from the 9/30 read the meter already had: 107 kWh × $0.21.
    expect(await billsFor(g.meterId, '2026-10-01')).toEqual([expect.objectContaining({ usage: 107, charge: 22.47 })])
  })
})

describe('the confirmation is for the household that was there (the M1 build\'s reading of "tenant")', () => {
  /** Gerald's lease ends 10/15 and the next lease on the space starts the day after. */
  async function nextLease(p: Park, s: { unitId: string; meterId: string }, o: { sameTenant: boolean }) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const old = (await c.query<{ id: string; tenant_id: string }>(
        `SELECT l.id, lt.tenant_id FROM leases l JOIN lease_tenants lt ON lt.lease_id = l.id WHERE l.unit_id = $1`, [s.unitId])).rows[0]
      await c.query(`UPDATE leases SET status = 'expired', end_date = '2026-10-15' WHERE id = $1`, [old.id])
      const next = await seedLease(c, { unitId: s.unitId, landlordId: p.landlordId, startDate: '2026-10-16' })
      await seedLeaseTenant(c, { leaseId: next, tenantId: o.sameTenant ? old.tenant_id : await seedTenant(c) })
      if (o.sameTenant) await c.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [next, old.id])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('a new household on the space (no move-out read taken) is on the stuck-meter rule again', async () => {
    const p = await park({ estimates: false })
    const g = await space(p, 'RV 48', 49083, 49083)
    await broken(g.meterId)
    await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true })
    await confirmedOnOct5(g.meterId)
    await nextLease(p, g, { sameTenant: false })
    await read(p, g.meterId, '2026-10-31', 49083, '2026-10-01')
    await read(p, g.meterId, '2026-11-30', 49083, '2026-11-01')
    await run(g.meterId, '2026-11-01')
    expect((await meterRow(g.meterId)).out_of_service).toBe(true)
    expect(await brokenNotices()).toHaveLength(1)
  })

  it('a renewal for the same household is not a new one', async () => {
    const p = await park({ estimates: false })
    const g = await space(p, 'RV 48', 49083, 49083)
    await broken(g.meterId)
    await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true })
    await confirmedOnOct5(g.meterId)
    await nextLease(p, g, { sameTenant: true })
    await read(p, g.meterId, '2026-10-31', 49083, '2026-10-01')
    await read(p, g.meterId, '2026-11-30', 49083, '2026-11-01')
    await run(g.meterId, '2026-11-01')
    expect((await meterRow(g.meterId)).out_of_service).toBe(false)
    expect(await brokenNotices()).toHaveLength(0)
  })
})

describe('what ends the confirmation: the reads as they stand when the cycle is billed (10/12 review)', () => {
  async function confirmedMeter() {
    const p = await park({ estimates: true })
    const g = await space(p, 'RV 48', 49083, 49083)
    // RV 12 next door gives Mountain View a number to estimate from.
    const n = await space(p, 'RV 12', 5000, 5107)
    await read(p, n.meterId, '2026-10-31', 5210, '2026-10-01')
    await broken(g.meterId)
    await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true })
    await confirmedOnOct5(g.meterId)
    return { p, g }
  }
  /** October billed: still confirmed, not flagged, nothing estimated, nobody told. */
  async function octoberStillConfirmed(g: { meterId: string }) {
    await run(g.meterId, '2026-10-01')
    expect(await confirmed(g.meterId)).toBe(true)
    expect((await meterRow(g.meterId)).out_of_service).toBe(false)
    expect((await billsFor(g.meterId, '2026-10-01')).filter(b => b.charge > 0 || b.allocation_method === 'comparable_low')).toEqual([])
    expect(await brokenNotices()).toHaveLength(0)
  }

  it('a typo corrected before billing leaves it (the read is simply the corrected read)', async () => {
    const { p, g } = await confirmedMeter()
    const typo = await read(p, g.meterId, '2026-10-31', 49093, '2026-10-01')
    await db.query(`UPDATE utility_meter_readings SET reading_value = 49083 WHERE id = $1`, [typo])
    await octoberStillConfirmed(g)
  })

  it('not a read showing the same number', async () => {
    const { p, g } = await confirmedMeter()
    await read(p, g.meterId, '2026-10-20', 49083, '2026-10-01', { reason: 'other' })
    await read(p, g.meterId, '2026-10-31', 49083, '2026-10-01')
    await octoberStillConfirmed(g)
  })

  it('not a read that starts a measurement (a replaced meter)', async () => {
    const { p, g } = await confirmedMeter()
    await read(p, g.meterId, '2026-10-20', 0, '2026-10-01', { reason: 'meter_replaced' })
    await read(p, g.meterId, '2026-10-31', 0, '2026-10-01')
    await octoberStillConfirmed(g)
  })

  it('not a read dated on or before the day it was confirmed', async () => {
    const { p, g } = await confirmedMeter()
    await read(p, g.meterId, '2026-10-05', 49100, '2026-10-01', { reason: 'other' })
    await read(p, g.meterId, '2026-10-31', 49100, '2026-10-01')
    // (The 17 kWh it moved before the confirmation are billed as used; it has not moved since.)
    await run(g.meterId, '2026-10-01')
    expect(await confirmed(g.meterId)).toBe(true)
    expect((await meterRow(g.meterId)).out_of_service).toBe(false)
    expect(await brokenNotices()).toHaveLength(0)
  })

  it('a reference read that shows use ends it at the next billing', async () => {
    const { p, g } = await confirmedMeter()
    await read(p, g.meterId, '2026-10-20', 49150, '2026-10-01', { reason: 'other' })
    expect(await confirmed(g.meterId)).toBe(true)
    await read(p, g.meterId, '2026-10-31', 49150, '2026-10-01')
    await run(g.meterId, '2026-10-01')
    expect(await meterRow(g.meterId)).toMatchObject({ zero_use_confirmed_at: null, zero_use_confirmed_by_user_id: null })
  })
})

describe('the confirmation ends by the day a move-out read is dated (10/12 review)', () => {
  async function confirmedMeter() {
    const p = await park({ estimates: false })
    const g = await space(p, 'RV 48', 49083, 49083)
    await broken(g.meterId)
    await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true })
    await confirmedOnOct5(g.meterId)
    return { p, g }
  }

  it('a move-out read of the household before, dated before the confirmation but typed in after it, does not end it', async () => {
    const { p, g } = await confirmedMeter()
    await read(p, g.meterId, '2026-09-29', 49083, '2026-09-01', { reason: 'move_out_final' })
    await read(p, g.meterId, '2026-10-31', 49083, '2026-10-01')
    await run(g.meterId, '2026-10-01')
    expect(await meterRow(g.meterId)).toMatchObject({ out_of_service: false })
    expect(await confirmed(g.meterId)).toBe(true)
    expect(await brokenNotices()).toHaveLength(0)
  })

  it('a move-out read dated after the cycle being billed says nothing about that cycle', async () => {
    const { p, g } = await confirmedMeter()
    await read(p, g.meterId, '2026-10-31', 49083, '2026-10-01')
    await read(p, g.meterId, '2026-11-15', 49083, '2026-11-01', { reason: 'move_out_final' })
    await run(g.meterId, '2026-10-01')
    expect(await meterRow(g.meterId)).toMatchObject({ out_of_service: false })
    expect(await brokenNotices()).toHaveLength(0)
  })

  it('a move-out read dated after it ends it; the automatic flag that follows clears it, so the page stops saying "uses no power"', async () => {
    const { p, g } = await confirmedMeter()
    await read(p, g.meterId, '2026-10-20', 49083, '2026-10-01', { reason: 'move_out_final' })
    await read(p, g.meterId, '2026-10-31', 49083, '2026-10-01')
    await run(g.meterId, '2026-10-01')
    expect(await meterRow(g.meterId)).toMatchObject({
      out_of_service: true, zero_use_confirmed_at: null, zero_use_confirmed_by_user_id: null,
    })
    expect(await brokenNotices()).toHaveLength(1)
  })
})

describe('a former resident who comes back is a new household (10/12 review)', () => {
  it('their old lease, ended before the confirmation, does not make them the household it was made for', async () => {
    const p = await park({ estimates: false })
    const g = await space(p, 'RV 48', 49083, 49083)
    const c = await db.connect()
    let returning: string
    try {
      await c.query('BEGIN')
      const first = (await c.query<{ id: string; tenant_id: string }>(
        `SELECT l.id, lt.tenant_id FROM leases l JOIN lease_tenants lt ON lt.lease_id = l.id WHERE l.unit_id = $1`, [g.unitId])).rows[0]
      returning = first.tenant_id
      await c.query(`UPDATE leases SET status = 'expired', end_date = '2026-06-30' WHERE id = $1`, [first.id])
      const between = await seedLease(c, { unitId: g.unitId, landlordId: p.landlordId, startDate: '2026-07-01' })
      await seedLeaseTenant(c, { leaseId: between, tenantId: await seedTenant(c) })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await broken(g.meterId)
    await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true })
    await confirmedOnOct5(g.meterId)
    // The household it was made for leaves 10/15; the earlier resident comes back 10/16.
    const c2 = await db.connect()
    try {
      await c2.query('BEGIN')
      await c2.query(`UPDATE leases SET status = 'expired', end_date = '2026-10-15' WHERE unit_id = $1 AND start_date = '2026-07-01'`, [g.unitId])
      const back = await seedLease(c2, { unitId: g.unitId, landlordId: p.landlordId, startDate: '2026-10-16' })
      await seedLeaseTenant(c2, { leaseId: back, tenantId: returning! })
      await c2.query('COMMIT')
    } catch (e) { await c2.query('ROLLBACK'); throw e } finally { c2.release() }
    await read(p, g.meterId, '2026-10-31', 49083, '2026-10-01')
    await read(p, g.meterId, '2026-11-30', 49083, '2026-11-01')
    await run(g.meterId, '2026-11-01')
    expect((await meterRow(g.meterId)).out_of_service).toBe(true)
    expect(await brokenNotices()).toHaveLength(1)
  })
})

describe('the choice itself (10/12, Nic, Q-d: "usable on ANY meter, any time")', () => {
  it('works on a meter that is in service, and adds no reading', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, 'RV 20', 100, 150)
    expect((await patch(p, s.meterId, { zeroUseConfirmed: true })).status).toBe(200)
    expect(await meterRow(s.meterId)).toMatchObject({ out_of_service: false, zero_use_confirmed_by_user_id: p.userId })
    const reads = (await db.query(`SELECT 1 FROM utility_meter_readings WHERE meter_id = $1`, [s.meterId])).rows
    expect(reads).toHaveLength(2)
  })

  it('an explicit zeroUseConfirmed: false is "not this choice", never a refusal', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, 'RV 21', 100, 100)
    await broken(s.meterId)
    const res = await patch(p, s.meterId, { outOfService: false, repairedStartingReading: 0, zeroUseConfirmed: false })
    expect(res.status).toBe(200)
    expect(await meterRow(s.meterId)).toMatchObject({ out_of_service: false, zero_use_confirmed_at: null })
    expect((await patch(p, s.meterId, { label: 'RV 21 power', zeroUseConfirmed: false })).status).toBe(200)
    expect(await confirmed(s.meterId)).toBe(false)
  })
})

describe('the unpaid estimates billed while it was flagged (10/12, Nic, Q-f: the landlord\'s choice)', () => {
  /** Mountain View: RV 48 flat and flagged in September, estimated off RV 12 in September ($22.47) and October ($21.63). */
  async function estimatedTwice() {
    const p = await park({ estimates: true })
    const g = await space(p, 'RV 48', 49083, 49083)
    const n = await space(p, 'RV 12', 5000, 5107)
    await read(p, n.meterId, '2026-10-31', 5210, '2026-10-01')
    await run(g.meterId, '2026-09-01')
    await run(g.meterId, '2026-10-01')
    expect((await meterRow(g.meterId)).out_of_service).toBe(true)
    const bills = (await db.query<{ id: string; cycle: string; charge: number }>(
      `SELECT id, to_char(billing_cycle_month, 'YYYY-MM-DD') AS cycle, charge_amount::float AS charge
         FROM utility_bills WHERE meter_id = $1 AND allocation_method = 'comparable_low' ORDER BY billing_cycle_month`,
      [g.meterId])).rows
    expect(bills.map(b => [b.cycle, b.charge])).toEqual([['2026-09-01', 22.47], ['2026-10-01', 21.63]])
    return { p, g, sept: bills[0].id, oct: bills[1].id }
  }

  /** Puts an estimate on a bill of the tenant's (October's by default) beside $500 of paid rent, as an owed line. */
  async function onBill(billId: string, due = '2026-10-01') {
    const b = (await db.query<any>(`SELECT * FROM utility_bills WHERE id = $1`, [billId])).rows[0]
    const amount = Number(b.charge_amount) + Number(b.tax_amount)
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, subtotal_utilities, total_amount)
       VALUES ($1, $2, $3, $4, $5, $8, 500, $6, $7) RETURNING id`,
      [b.landlord_id, b.tenant_id, b.lease_id, b.unit_id, `INV-T-${billId.slice(0, 8)}`, amount, 500 + amount, due])).rows[0].id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, settled_at)
       VALUES ($1, $2, $3, $4, $5, 'rent', 500, 'settled', $6, 'RENT', NOW())`,
      [inv, b.unit_id, b.lease_id, b.tenant_id, b.landlord_id, due])
    const pay = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, $5, 'utility', $6, 'pending', $7, 'UTILITY') RETURNING id`,
      [inv, b.unit_id, b.lease_id, b.tenant_id, b.landlord_id, amount, due])).rows[0].id
    await db.query(`UPDATE utility_bills SET payment_id = $1, status = 'billed', billed_at = NOW() WHERE id = $2`, [pay, billId])
    return { invoiceId: inv, paymentId: pay }
  }
  const asked = (p: Park, meterId: string) =>
    request(app()).get(`/api/utility/meters/${meterId}/flagged-estimates`).set('Authorization', `Bearer ${p.token}`)
  const asAgent = (p: Park, meterId: string, body: any) =>
    request(app()).patch(`/api/utility/meters/${meterId}`).set('Authorization', `Bearer ${p.token}`)
      .set('X-GAM-Actor', 'agent').send(body)

  it('asks with how many and how much — on a bill or not on one yet — and voids them on yes: kept on record, the bill drops by the line and reads paid', async () => {
    const { p, g, sept, oct } = await estimatedTwice()
    const bill = await onBill(sept)
    const q = await asked(p, g.meterId)
    expect(q.status).toBe(200)
    expect(q.body.data).toMatchObject({ count: 2, amount: 44.1 })
    expect(q.body.data.charges).toEqual([
      { id: sept, state: 'on_bill', cycleMonth: '2026-09-01', amount: 22.47, invoiceNumber: `INV-T-${sept.slice(0, 8)}` },
      { id: oct, state: 'not_yet_billed', cycleMonth: '2026-10-01', amount: 21.63, invoiceNumber: null },
    ])

    const res = await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true, voidFlaggedEstimates: true,
      voidEstimateIds: q.body.data.charges.map((c: any) => c.id) })
    expect(res.status).toBe(200)
    expect(res.body.data.flagged_estimates_voided).toEqual({ voided: { count: 2, amount: 44.1 }, kept: { count: 0, amount: 0 },
      keptBy: { paid: { count: 0, amount: 0 }, heldByRecord: { count: 0, amount: 0 }, failed: { count: 0, amount: 0 }, changed: { count: 0, amount: 0 } } })
    expect(await meterRow(g.meterId)).toMatchObject({ out_of_service: false })
    expect(await confirmed(g.meterId)).toBe(true)

    const line = (await db.query<any>(`SELECT status, voided_at, void_reason, amount::float AS amount FROM payments WHERE id = $1`, [bill.paymentId])).rows[0]
    expect(line).toMatchObject({ status: 'voided', amount: 22.47 })
    expect(line.void_reason).toMatch(/meter was working while it was flagged broken/)
    const rows = (await db.query<any>(
      `SELECT to_char(billing_cycle_month, 'YYYY-MM-DD') AS cycle, status, payment_id, notes FROM utility_bills
        WHERE meter_id = $1 ORDER BY billing_cycle_month`, [g.meterId])).rows
    expect(rows.map((r: any) => [r.cycle, r.status])).toEqual([['2026-09-01', 'void'], ['2026-10-01', 'void']])
    expect(rows[0].payment_id).toBe(bill.paymentId)
    expect(rows[1].notes).toMatch(/an estimate/)
    const inv = (await db.query<any>(
      `SELECT total_amount::float AS total, subtotal_utilities::float AS util, status FROM invoices WHERE id = $1`, [bill.invoiceId])).rows[0]
    expect(inv).toEqual({ total: 500, util: 0, status: 'settled' })
    // Nothing is left to ask about: the meter is no longer flagged.
    expect((await asked(p, g.meterId)).body.data).toMatchObject({ count: 0, amount: 0 })
  })

  it('on no, leaves them exactly as they are', async () => {
    const { p, g, sept, oct } = await estimatedTwice()
    const bill = await onBill(sept)
    const res = await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true, voidFlaggedEstimates: false })
    expect(res.status).toBe(200)
    expect(res.body.data.flagged_estimates_voided).toBeUndefined()
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [bill.paymentId])).rows[0].status).toBe('pending')
    expect((await db.query(`SELECT status FROM utility_bills WHERE id = $1`, [oct])).rows[0].status).toBe('unbilled')
  })

  it('never touches a paid one, a line covered by work trade, or an estimate from an earlier flag that ended with "Repaired"', async () => {
    const { p, g, sept, oct } = await estimatedTwice()
    // The earlier flag ended with "Repaired" on 8/15 (its replacement read).
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id, created_at)
       VALUES ($1, '2026-08-15', 49083, '2026-08-01', 'meter_replaced', $2, '2026-08-15 12:00:00-07')`, [g.meterId, p.userId])
    const paid = await onBill(sept)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [paid.paymentId])
    const covered = await onBill(oct, '2026-11-01')
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE id = $1`, [covered.paymentId])
    // An estimate from an earlier flag (August), before this one began.
    const g2 = (await db.query<any>(`SELECT * FROM utility_bills WHERE id = $1`, [sept])).rows[0]
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, usage_amount,
                                  allocation_method, charge_amount, status, utility_type, created_at)
       VALUES ($1, $2, $3, $4, $5, '2026-07-01', 100, 'comparable_low', 21, 'unbilled', 'electric', '2026-08-02')`,
      [g.meterId, g2.unit_id, g2.tenant_id, g2.lease_id, g2.landlord_id])
    expect((await asked(p, g.meterId)).body.data).toMatchObject({ count: 0, amount: 0 })
    const res = await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true, voidFlaggedEstimates: true, voidEstimateIds: [] })
    expect(res.body.data.flagged_estimates_voided).toEqual({ voided: { count: 0, amount: 0 }, kept: { count: 0, amount: 0 },
      keptBy: { paid: { count: 0, amount: 0 }, heldByRecord: { count: 0, amount: 0 }, failed: { count: 0, amount: 0 }, changed: { count: 0, amount: 0 } } })
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [paid.paymentId])).rows[0].status).toBe('settled')
    expect((await db.query(`SELECT status FROM utility_bills WHERE id = $1`, [sept])).rows[0].status).toBe('paid')
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [covered.paymentId])).rows[0].status).toBe('pending')
    expect((await db.query(`SELECT status FROM utility_bills WHERE billing_cycle_month = '2026-07-01' AND meter_id = $1`, [g.meterId])).rows[0].status).toBe('unbilled')
  })

  it('only with "Works", and never by the assistant — which also cannot put a flagged meter back while estimates wait on the answer', async () => {
    const { p, g, oct } = await estimatedTwice()
    expect((await patch(p, g.meterId, { outOfService: false, repairedStartingReading: 49083, voidFlaggedEstimates: true })).status).toBe(400)
    expect((await asAgent(p, g.meterId, { outOfService: false, zeroUseConfirmed: true, voidFlaggedEstimates: true })).status).toBe(403)
    const refused = await asAgent(p, g.meterId, { outOfService: false, zeroUseConfirmed: true })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/2 unpaid estimated charges from while it was flagged \(\$44\.10\)/)
    expect(await meterRow(g.meterId)).toMatchObject({ out_of_service: true, zero_use_confirmed_at: null })
    expect((await db.query(`SELECT status FROM utility_bills WHERE id = $1`, [oct])).rows[0].status).toBe('unbilled')
  })

  // 10/12 (review): production — RV 08's and RV 48's $22.47 were written 9/30, and the meters were
  // only flagged 10/05 (the oct3 flag script). The flagged period starts where the meter last came
  // back into service, not at the day of the current flag.
  it('offers and voids an estimate written before the day the meter was flagged', async () => {
    const { p, g, sept, oct } = await estimatedTwice()
    await db.query(`UPDATE utility_bills SET created_at = '2026-09-30 10:00:00-07' WHERE id = ANY($1::uuid[])`, [[sept, oct]])
    await db.query(`UPDATE utility_meters SET out_of_service_since = '2026-10-05' WHERE id = $1`, [g.meterId])
    const q = await asked(p, g.meterId)
    expect(q.body.data).toMatchObject({ count: 2, amount: 44.1 })
    const res = await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true, voidFlaggedEstimates: true,
      voidEstimateIds: [sept, oct] })
    expect(res.body.data.flagged_estimates_voided.voided).toEqual({ count: 2, amount: 44.1 })
  })

  it('voids only what the window showed: an estimate written after it was asked stays', async () => {
    const { p, g, sept, oct } = await estimatedTwice()
    const res = await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true, voidFlaggedEstimates: true,
      voidEstimateIds: [sept] })
    expect(res.body.data.flagged_estimates_voided.voided).toEqual({ count: 1, amount: 22.47 })
    expect((await db.query(`SELECT status FROM utility_bills WHERE id = $1`, [oct])).rows[0].status).toBe('unbilled')
  })

  it('says why one shown was kept: a payment reached it first', async () => {
    const { p, g, sept, oct } = await estimatedTwice()
    const bill = await onBill(sept)
    const shown = (await asked(p, g.meterId)).body.data.charges.map((c: any) => c.id)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [bill.paymentId])
    const res = await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true, voidFlaggedEstimates: true, voidEstimateIds: shown })
    const v = res.body.data.flagged_estimates_voided
    expect(v.voided).toEqual({ count: 1, amount: 21.63 })
    expect(v.kept).toEqual({ count: 1, amount: 22.47 })
    expect(v.keptBy.paid).toEqual({ count: 1, amount: 22.47 })
    expect((await db.query(`SELECT status FROM utility_bills WHERE id = $1`, [oct])).rows[0].status).toBe('void')
  })

  // 10/12 (review): a bill the estimate was the only live line of (a final utility bill) is voided,
  // not left 'pending' at $0 — kept on record, and the lease's due date given back.
  it('voids a bill the estimate was the only line of', async () => {
    const { p, g, sept } = await estimatedTwice()
    const b = (await db.query<any>(`SELECT * FROM utility_bills WHERE id = $1`, [sept])).rows[0]
    const amount = Number(b.charge_amount) + Number(b.tax_amount)
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_utilities, total_amount)
       VALUES ($1, $2, $3, $4, 'INV-T-FINAL', '2026-10-20', $5, $5) RETURNING id`,
      [b.landlord_id, b.tenant_id, b.lease_id, b.unit_id, amount])).rows[0].id
    const pay = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, $5, 'utility', $6, 'pending', '2026-10-20', 'UTILITY') RETURNING id`,
      [inv, b.unit_id, b.lease_id, b.tenant_id, b.landlord_id, amount])).rows[0].id
    await db.query(`UPDATE utility_bills SET payment_id = $1, status = 'billed', billed_at = NOW() WHERE id = $2`, [pay, sept])
    const res = await patch(p, g.meterId, { outOfService: false, zeroUseConfirmed: true, voidFlaggedEstimates: true, voidEstimateIds: [sept] })
    expect(res.body.data.flagged_estimates_voided.voided).toEqual({ count: 1, amount: 22.47 })
    const row = (await db.query<any>(
      `SELECT status, total_amount::float AS total, lease_id, voided_from_lease_id, notes FROM invoices WHERE id = $1`, [inv])).rows[0]
    expect(row).toMatchObject({ status: 'void', total: 0, lease_id: null, voided_from_lease_id: b.lease_id })
    expect(row.notes).toMatch(/only charge was an estimate/)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [pay])).rows[0].status).toBe('voided')
  })

  it('the assistant can still choose "Works" on a flagged meter with no estimates waiting', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, 'RV 30', 100, 100)
    await broken(s.meterId)
    expect((await asAgent(p, s.meterId, { outOfService: false, zeroUseConfirmed: true })).status).toBe(200)
    expect(await confirmed(s.meterId)).toBe(true)
  })
})

describe('a team member held to some properties edits only their meters (10/12 review)', () => {
  it('refuses a property manager scoped to one park the meters of another park of the same company', async () => {
    const p = await park({ estimates: false })
    const s = await space(p, 'RV 48', 49083, 49083)
    await broken(s.meterId)
    const c = await db.connect()
    let pmUser: string, otherPark: string
    try {
      await c.query('BEGIN')
      pmUser = await seedManager(c)
      otherPark = await seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId })
      await c.query(
        `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties) VALUES ($1, $2, $3, FALSE)`,
        [pmUser, p.landlordId, [otherPark]])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const token = jwt.sign({ userId: pmUser!, role: 'property_manager', email: 'pm@t.dev', landlordId: p.landlordId,
      permissions: { 'properties.edit': true } }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`)
    expect((await as(request(app()).patch(`/api/utility/meters/${s.meterId}`)).send({ outOfService: false, zeroUseConfirmed: true })).status).toBe(403)
    expect((await as(request(app()).patch(`/api/utility/meters/${s.meterId}`)).send({ ratePerUnit: 0.01 })).status).toBe(403)
    expect((await as(request(app()).get(`/api/utility/meters/${s.meterId}/flagged-estimates`))).status).toBe(403)
    expect((await as(request(app()).post(`/api/utility/meters/${s.meterId}/readings`)).send({
      readingDate: '2026-10-31', readingValue: 49100, billingCycleMonth: '2026-10-01', reason: 'baseline' })).status).toBe(403)
    expect(await meterRow(s.meterId)).toMatchObject({ out_of_service: true, zero_use_confirmed_at: null })
    // 10/12 (review): every other meter write path too — a flagged read's correction, opening reads,
    // a bill run, a reading run's completion and approval, the property's rates and taxes, finalizing a bill.
    const reading = (await db.query<{ id: string }>(
      `SELECT id FROM utility_meter_readings WHERE meter_id = $1 ORDER BY reading_date DESC LIMIT 1`, [s.meterId])).rows[0].id
    const runId = (await db.query<{ id: string }>(
      `INSERT INTO utility_reading_runs (property_id, landlord_id, billing_cycle_month, opened_on)
       VALUES ($1, $2, '2026-10-01', '2026-10-31') RETURNING id`, [p.propertyId, p.landlordId])).rows[0].id
    const lease = (await db.query<{ id: string; tenant_id: string }>(
      `SELECT l.id, lt.tenant_id FROM leases l JOIN lease_tenants lt ON lt.lease_id = l.id WHERE l.unit_id = $1`, [s.unitId])).rows[0]
    const billId = (await db.query<{ id: string }>(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, usage_amount,
                                  allocation_method, charge_amount, status, utility_type)
       VALUES ($1, $2, $3, $4, $5, '2026-09-01', 10, 'submeter', 2.1, 'unbilled', 'electric') RETURNING id`,
      [s.meterId, s.unitId, lease.tenant_id, lease.id, p.landlordId])).rows[0].id
    const post = (path: string, body: any = {}) => as(request(app()).post(`/api/utility${path}`)).send(body)
    expect((await post(`/readings/${reading}/resolve-review`, { correctedValue: 49100 })).status).toBe(403)
    expect((await post('/opening-reads', { propertyId: p.propertyId, readingDate: '2026-10-31',
      reads: [{ meterId: s.meterId, value: 49100 }] })).status).toBe(403)
    expect((await post('/generate-bills', { cycleMonth: '2026-10-01', meterId: s.meterId })).status).toBe(403)
    expect((await post('/generate-bills', { cycleMonth: '2026-10-01', propertyId: p.propertyId })).status).toBe(403)
    expect((await post('/generate-bills', { cycleMonth: '2026-10-01' })).status).toBe(400)
    expect((await post(`/reading-runs/${runId}/complete`)).status).toBe(403)
    expect((await post(`/reading-runs/${runId}/approve`)).status).toBe(403)
    expect((await post('/property-rates', { propertyId: p.propertyId, utilityType: 'electric', ratePerUnit: 0.01 })).status).toBe(403)
    expect((await post('/tax-rates', { propertyId: p.propertyId, utilityType: 'electric', taxRatePct: 9 })).status).toBe(403)
    expect((await post(`/bills/${billId}/finalize`)).status).toBe(403)
    expect((await db.query(`SELECT status FROM utility_bills WHERE id = $1`, [billId])).rows[0].status).toBe('unbilled')
    expect((await db.query(`SELECT status FROM utility_reading_runs WHERE id = $1`, [runId])).rows[0].status).toBe('open')
    expect((await db.query(`SELECT 1 FROM property_utility_rates WHERE property_id = $1`, [p.propertyId])).rows).toEqual([])
    expect((await db.query(`SELECT 1 FROM property_utility_tax_rates WHERE property_id = $1`, [p.propertyId])).rows).toEqual([])
    // Scoped to this park, the same manager may.
    await db.query(`UPDATE property_manager_scopes SET property_ids = $2 WHERE user_id = $1`, [pmUser!, [p.propertyId]])
    expect((await as(request(app()).patch(`/api/utility/meters/${s.meterId}`)).send({ outOfService: false, zeroUseConfirmed: true })).status).toBe(200)
    expect((await as(request(app()).post(`/api/utility/bills/${billId}/finalize`)).send({})).status).toBe(200)
  })
})

// 10/12 (Nic, review): "Works, tenant uses no power" is on ANY meter (Q-d), but
// only a submeter ever reached the check that ends it: a master the landlord
// pays, a flat-rate meter and a meter serving no unit returned first, and only
// a submeter is offered "Mark broken". One press, or a mis-click, stayed for good.
describe('a meter that is not a submeter, and taking it back (10/12 review)', () => {
  const addMeter = (p: Park, label: string, method: 'master_bill_to_landlord' | 'flat_rate') => db.query<{ id: string }>(
    method === 'flat_rate'
      ? `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit) VALUES ($1, 'water', $2, 'flat_rate', 25) RETURNING id`
      : `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits) VALUES ($1, 'water', $2, 'master_bill_to_landlord', 6) RETURNING id`,
    [p.propertyId, label]).then(r => r.rows[0].id)

  it('a confirmed master the landlord pays loses it on its next read that moves', async () => {
    const p = await park({ estimates: false })
    const office = await addMeter(p, 'office water', 'master_bill_to_landlord')
    await read(p, office, '2026-09-30', 1000, '2026-09-01')
    expect((await patch(p, office, { zeroUseConfirmed: true })).status).toBe(200)
    await confirmedOnOct5(office)
    // The same number in October: it still stands.
    await read(p, office, '2026-10-31', 1000, '2026-10-01')
    await run(office, '2026-10-01')
    expect(await confirmed(office)).toBe(true)
    // November reads use: the confirmation has done its job.
    await read(p, office, '2026-11-30', 1042, '2026-11-01')
    const r = await run(office, '2026-11-01')
    expect(r.billsCreated).toBe(0)
    expect(await meterRow(office)).toMatchObject({ out_of_service: false, zero_use_confirmed_at: null, zero_use_confirmed_by_user_id: null })
  })

  it('a confirmed flat-rate meter loses it when a new household arrives on a space it serves', async () => {
    const p = await park({ estimates: false })
    const trash = await addMeter(p, 'trash', 'flat_rate')
    const s = await space(p, 'RV 30', 100, 150)
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [trash, s.unitId])
    expect((await patch(p, trash, { zeroUseConfirmed: true })).status).toBe(200)
    await confirmedOnOct5(trash)
    // Nobody new yet: it stands through October's charge.
    await run(trash, '2026-10-01')
    expect(await confirmed(trash)).toBe(true)
    // A new household on another space it serves, from 10/20.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId, startDate: '2026-10-20' })
      await seedLeaseTenant(c, { leaseId, tenantId: await seedTenant(c) })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [trash, unitId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await run(trash, '2026-10-01')
    expect(await confirmed(trash)).toBe(false)
  })

  it('a confirmed meter that serves no unit loses it on a read that moves', async () => {
    const p = await park({ estimates: false })
    const rubs = (await db.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rubs_allocation_method, digits)
       VALUES ($1, 'water', 'north master', 'rubs', 'occupant_count', 6) RETURNING id`, [p.propertyId])).rows[0].id
    await read(p, rubs, '2026-09-30', 500, '2026-09-01')
    await patch(p, rubs, { zeroUseConfirmed: true })
    await confirmedOnOct5(rubs)
    await read(p, rubs, '2026-10-31', 650, '2026-10-01')
    const r = await run(rubs, '2026-10-01')
    expect(r.reason).toBe('meter not assigned to any units')
    expect(await confirmed(rubs)).toBe(false)
  })

  it('the landlord takes it back on any meter (zeroUseWithdrawn: true); false or leaving it out changes nothing', async () => {
    const p = await park({ estimates: false })
    const office = await addMeter(p, 'office water', 'master_bill_to_landlord')
    const trash = await addMeter(p, 'trash', 'flat_rate')
    const s = await space(p, 'RV 31', 100, 150)
    for (const id of [office, trash, s.meterId]) {
      expect((await patch(p, id, { zeroUseConfirmed: true })).status).toBe(200)
      // A rename, or an explicit false, leaves it.
      expect((await patch(p, id, { label: 'renamed', zeroUseWithdrawn: false })).status).toBe(200)
      expect(await confirmed(id)).toBe(true)
      const res = await patch(p, id, { zeroUseWithdrawn: true })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.data).toMatchObject({ zero_use_confirmed_at: null, zero_use_confirmed_by_user_id: null, out_of_service: false })
      expect(await meterRow(id)).toMatchObject({ zero_use_confirmed_at: null, zero_use_confirmed_by_user_id: null })
      // Again, with nothing on record: nothing to take back, nothing changes.
      expect((await patch(p, id, { zeroUseWithdrawn: true })).status).toBe(200)
    }
    // Chosen and taken back at once is refused.
    expect((await patch(p, office, { zeroUseConfirmed: true, zeroUseWithdrawn: true })).status).toBe(400)
    expect(await confirmed(office)).toBe(false)
    // Taken back on a submeter, a flat read on the occupied space is a stuck meter again.
    await patch(p, s.meterId, { zeroUseConfirmed: true })
    await patch(p, s.meterId, { zeroUseWithdrawn: true })
    await read(p, s.meterId, '2026-10-31', 150, '2026-10-01')
    await run(s.meterId, '2026-10-01')
    expect((await meterRow(s.meterId)).out_of_service).toBe(true)
  })

  it("is refused on another landlord's meter", async () => {
    const p = await park({ estimates: false })
    const other = await park({ estimates: false })
    const office = await addMeter(other, 'office water', 'master_bill_to_landlord')
    await patch(other, office, { zeroUseConfirmed: true })
    expect((await patch(p, office, { zeroUseWithdrawn: true })).status).toBe(403)
    expect(await confirmed(office)).toBe(true)
  })
})
