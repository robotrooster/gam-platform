/**
 * S641 (Nic) — a resident moves spaces without ending their tenancy.
 *
 *   "Moving sites at an RV park is very common, especially when somebody with a
 *    nice shade tree leaves and somebody else wants to take that spot. I don't
 *    wanna have to terminate their lease, send them a new lease for the new
 *    spot. I want to just be able to move them in the system and say, as of this
 *    date, they moved from this spot to this spot, have it coordinate utilities
 *    for both."
 *
 *   "If they move mid month, it's gonna have a meter read start and end from the
 *    first part of the month for that first site and for the later half of the
 *    month start and end for the later site, and show them as line items."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant } from '../test/dbHelpers'
import { moveLeaseToUnit, leaseUnitsInWindow } from './unitMove'

beforeEach(async () => { await cleanupAllSchema() })

async function world(opts: { withMeters?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const mk = async (n: string) => {
      const id = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      await c.query(`UPDATE units SET unit_number=$2, unit_type='rv_spot', status='vacant' WHERE id=$1`, [id, n])
      return id
    }
    const shady = await mk('RV 12')
    const sunny = await mk('RV 23')
    const taken = await mk('RV 40')

    const leaseId = await seedLease(c, { unitId: shady, landlordId: ll.landlordId, startDate: '2026-01-01' })
    await c.query(`UPDATE units SET status='active' WHERE id=$1`, [shady])

    // somebody else already lives on RV 40
    const otherLease = await seedLease(c, { unitId: taken, landlordId: ll.landlordId, startDate: '2026-01-01' })

    if (opts.withMeters) {
      for (const [unitId, label] of [[shady, 'RV 12 electric'], [sunny, 'RV 23 electric']] as const) {
        const m = await c.query<{ id: string }>(
          `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits)
           VALUES ($1,'electric',$2,'submeter',6) RETURNING id`, [propertyId, label])
        await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
          [m.rows[0].id, unitId])
      }
    }
    await c.query('COMMIT')
    return { ...ll, propertyId, shady, sunny, taken, leaseId, otherLease }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('moving a resident to another space', () => {
  it('keeps the same lease and changes only which space it occupies', async () => {
    const w = await world()
    const r = await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    expect(r.fromUnitId).toBe(w.shady)
    expect(r.toUnitId).toBe(w.sunny)

    const { rows } = await db.query(`SELECT unit_id, status FROM leases WHERE id=$1`, [w.leaseId])
    expect(rows[0].unit_id).toBe(w.sunny)
    expect(rows[0].status).toBe('active')   // not terminated, not replaced
  })

  it('records both periods, seamed on the move date', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const { rows } = await db.query(
      `SELECT unit_id, to_char(effective_from,'YYYY-MM-DD') AS f,
              to_char(effective_to,'YYYY-MM-DD') AS t
         FROM lease_unit_history WHERE lease_id=$1 ORDER BY effective_from`, [w.leaseId])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ unit_id: w.shady, f: '2026-01-01', t: '2026-06-15' })
    expect(rows[1]).toMatchObject({ unit_id: w.sunny, f: '2026-06-15', t: null })
  })

  // The whole point: two line items, not one blended figure.
  it('a mid-month move splits the billing window across both spaces', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const slices = await leaseUnitsInWindow(w.leaseId, '2026-06-01', '2026-06-30')
    expect(slices).toHaveLength(2)
    expect(slices[0]).toMatchObject({ unit_number: 'RV 12', from_date: '2026-06-01', to_date: '2026-06-15' })
    expect(slices[1]).toMatchObject({ unit_number: 'RV 23', from_date: '2026-06-15', to_date: '2026-06-30' })
  })

  it('a month with no move is still a single line', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const july = await leaseUnitsInWindow(w.leaseId, '2026-07-01', '2026-07-31')
    expect(july).toHaveLength(1)
    expect(july[0].unit_number).toBe('RV 23')
  })

  // S652 (Nic): "moving somebody in the system should initiate two meter
  // reads… it needs to happen at the time of move." No numbers, no move.
  it('refuses to move until both spaces\' meters have a reading', async () => {
    const w = await world({ withMeters: true })
    await expect(moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' }))
      .rejects.toThrow(/RV 12 electric, RV 23 electric/)
    const { rows } = await db.query(`SELECT unit_id FROM leases WHERE id=$1`, [w.leaseId])
    expect(rows[0].unit_id).toBe(w.shady)   // nothing moved
  })

  it('records the closing read on the old space and the opening read on the new one, dated the move', async () => {
    const w = await world({ withMeters: true })
    const meters = await db.query<{ id: string; label: string }>(`SELECT id, label FROM utility_meters ORDER BY label`)
    const [m12, m23] = meters.rows
    const r = await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15', actorUserId: w.userId,
      reads: [{ meterId: m12.id, value: 4210 }, { meterId: m23.id, value: 118 }] })
    expect(r.closingReadsNeeded.map(m => m.label)).toEqual(['RV 12 electric'])
    expect(r.openingReadsNeeded.map(m => m.label)).toEqual(['RV 23 electric'])
    const reads = await db.query<{ meter_id: string; reading_value: string; reading_date: string; reason: string; reason_note: string }>(
      `SELECT meter_id, reading_value, to_char(reading_date,'YYYY-MM-DD') AS reading_date, reason, reason_note
         FROM utility_meter_readings ORDER BY reason`)
    expect(reads.rows).toHaveLength(2)
    const cl = reads.rows.find(x => x.meter_id === m12.id)!, op = reads.rows.find(x => x.meter_id === m23.id)!
    expect(Number(cl.reading_value)).toBe(4210); expect(cl.reason).toBe('other'); expect(cl.reading_date).toBe('2026-06-15'); expect(cl.reason_note).toMatch(/moved out/i)
    expect(Number(op.reading_value)).toBe(118); expect(op.reason).toBe('baseline'); expect(op.reading_date).toBe('2026-06-15')
  })

  it('refuses a reading past the meter face', async () => {
    const w = await world({ withMeters: true })
    const meters = await db.query<{ id: string }>(`SELECT id FROM utility_meters ORDER BY label`)
    await expect(moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15',
      reads: [{ meterId: meters.rows[0].id, value: 1_000_000 }, { meterId: meters.rows[1].id, value: 5 }] }))
      .rejects.toThrow(/capacity/)
  })

  it('frees the old space and occupies the new one', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const { rows } = await db.query(
      `SELECT id, status FROM units WHERE id = ANY($1::uuid[])`, [[w.shady, w.sunny]])
    const by = Object.fromEntries(rows.map((r: any) => [r.id, r.status]))
    expect(by[w.shady]).toBe('vacant')
    expect(by[w.sunny]).toBe('active')
  })

  // The one mistake that cannot be repaired by history.
  it('refuses a space somebody else occupies', async () => {
    const w = await world()
    await expect(moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.taken, movedOn: '2026-06-15' }))
      .rejects.toThrow(/occupied/i)
  })

  it('refuses a move date before the tenancy started', async () => {
    const w = await world()
    await expect(moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2025-12-01' }))
      .rejects.toThrow(/before the tenancy/i)
  })

  it('refuses moving somewhere they already are', async () => {
    const w = await world()
    await expect(moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.shady, movedOn: '2026-06-15' }))
      .rejects.toThrow(/already in that space/i)
  })

  it('two moves in one month produce three slices', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-10' })
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.shady, movedOn: '2026-06-20' })
    const slices = await leaseUnitsInWindow(w.leaseId, '2026-06-01', '2026-06-30')
    expect(slices.map(s => s.unit_number)).toEqual(['RV 12', 'RV 23', 'RV 12'])
  })
})

// ── the bill follows the occupancy, not the lease's current space ──────────
//
// Nic: "if they move mid month, it's gonna have a meter read start and end from
// the first part of the month for that first site and for the later half of the
// month start and end for the later site, and show them as line items."
describe('billing a month with a move in it', () => {
  // S652 (Nic): "make sure that Dakota Lane was billed properly." The closing
  // read was recorded and never billed; her old space billed 0 kWh for the
  // month and the 481 kWh she used there went nowhere.
  it('bills the resident for the old space up to the closing read, on the move month', async () => {
    const w = await world({ withMeters: true })
    const c = await db.connect()
    let tenantId: string
    try { tenantId = await seedTenant(c) } finally { c.release() }
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role, status) VALUES ($1,$2,'primary','active')`, [w.leaseId, tenantId])
    await db.query(`INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible) VALUES ($1,'electric',true)`, [w.leaseId])
    await db.query(`UPDATE utility_meters SET rate_per_unit = 0.21`)
    const meters = await db.query<{ id: string; label: string }>(`SELECT id, label FROM utility_meters ORDER BY label`)
    const [m12, m23] = meters.rows
    // the month-end read before the move: 4000 on June 1 (May's cycle)
    await db.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, '2026-06-01', 4000, '2026-05-01', $2, 'monthly_cycle')`, [m12.id, w.userId])

    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15', actorUserId: w.userId,
      reads: [{ meterId: m12.id, value: 4210 }, { meterId: m23.id, value: 118 }] })

    const bills = await db.query<any>(
      `SELECT unit_id, lease_id, usage_amount, charge_amount, reading_start, reading_end, to_char(billing_cycle_month,'YYYY-MM-DD') AS cycle
         FROM utility_bills`)
    expect(bills.rows).toHaveLength(1)
    expect(bills.rows[0]).toMatchObject({ unit_id: w.shady, lease_id: w.leaseId, cycle: '2026-06-01' })
    expect(Number(bills.rows[0].usage_amount)).toBe(210)          // 4210 − 4000
    expect(Number(bills.rows[0].charge_amount)).toBeCloseTo(44.10, 2)
    expect(Number(bills.rows[0].reading_start)).toBe(4000)
    expect(Number(bills.rows[0].reading_end)).toBe(4210)
  })

  it('attributes the OLD spot’s usage to the resident who was there', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })

    // Who does a bill dated the 1st of that month belong to, for the space
    // they LEFT? Before this, nothing — the lease had walked away from it.
    const { rows } = await db.query(`
      SELECT h.lease_id
        FROM lease_unit_history h
        JOIN leases l ON l.id = h.lease_id
       WHERE h.unit_id = $1
         AND h.effective_from <= '2026-06-01'::date
         AND (h.effective_to IS NULL OR h.effective_to > '2026-06-01'::date)`, [w.shady])
    expect(rows).toHaveLength(1)
    expect(rows[0].lease_id).toBe(w.leaseId)
  })

  it('attributes the NEW spot’s usage to the same resident', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const { rows } = await db.query(`
      SELECT h.lease_id
        FROM lease_unit_history h
       WHERE h.unit_id = $1
         AND h.effective_from <= '2026-06-20'::date
         AND (h.effective_to IS NULL OR h.effective_to > '2026-06-20'::date)`, [w.sunny])
    expect(rows).toHaveLength(1)
    expect(rows[0].lease_id).toBe(w.leaseId)
  })

  it('the spot they left stops being theirs after the move date', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const { rows } = await db.query(`
      SELECT h.lease_id
        FROM lease_unit_history h
       WHERE h.unit_id = $1
         AND h.effective_from <= '2026-07-01'::date
         AND (h.effective_to IS NULL OR h.effective_to > '2026-07-01'::date)`, [w.shady])
    expect(rows).toHaveLength(0)
  })
})

// The route: the move screen sends the readings with the move itself, and
// asks beforehand which meters it will need.
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { leasesRouter } from '../routes/leases'
import { errorHandler } from '../middleware/errorHandler'

describe('POST /api/leases/:id/move with readings', () => {
  const app = () => { const a = express(); a.use(express.json()); a.use('/api/leases', leasesRouter); a.use(errorHandler); return a }
  const tokenFor = (w: any) => jwt.sign({ userId: w.userId, role: 'landlord', email: 'll@test.dev', profileId: w.landlordId, landlordIds: [w.landlordId], permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  it('says which meters the move will need, refuses without them, moves with them', async () => {
    const w = await world({ withMeters: true })
    const need = await request(app()).get(`/api/leases/${w.leaseId}/move-reads?toUnitId=${w.sunny}`).set('Authorization', `Bearer ${tokenFor(w)}`)
    expect(need.status).toBe(200)
    expect(need.body.data.map((m: any) => `${m.label}:${m.kind}`)).toEqual(['RV 12 electric:closing', 'RV 23 electric:opening'])
    const bare = await request(app()).post(`/api/leases/${w.leaseId}/move`).set('Authorization', `Bearer ${tokenFor(w)}`)
      .send({ toUnitId: w.sunny, movedOn: '2026-06-15' })
    expect(bare.status).toBe(409)
    const res = await request(app()).post(`/api/leases/${w.leaseId}/move`).set('Authorization', `Bearer ${tokenFor(w)}`)
      .send({ toUnitId: w.sunny, movedOn: '2026-06-15', reads: need.body.data.map((m: any, i: number) => ({ meterId: m.meterId, value: 100 + i })) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const reads = await db.query(`SELECT count(*)::int AS n FROM utility_meter_readings`)
    expect(reads.rows[0].n).toBe(2)
  })
})

// S652 (Nic, DIRECTIVE): "make sure the master schedule splits that stay… it
// only moves the stay going forward at that day."
import { unitsRouter } from '../routes/units'
describe('the master schedule after a move', () => {
  it('shows one bar per stretch: the old space until the day before, the new space from the move day', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const a = express(); a.use(express.json()); a.use('/api/units', unitsRouter); a.use(errorHandler)
    const token = jwt.sign({ userId: w.userId, role: 'landlord', email: 'll@test.dev', profileId: w.landlordId, landlordIds: [w.landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(a).get(`/api/units/schedule/master?from=2026-01-01&to=2026-12-31&propertyId=${w.propertyId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const mine = (res.body.data.leases as any[]).filter(l => l.id === w.leaseId)
      .map(l => ({ unit: l.unit_id, from: String(l.start_date).slice(0, 10), to: l.end_date ? String(l.end_date).slice(0, 10) : null }))
      .sort((x, y) => x.from.localeCompare(y.from))
    expect(mine).toHaveLength(2)
    expect(mine[0].unit).toBe(w.shady); expect(mine[0].to).toBe('2026-06-14')
    expect(mine[1].unit).toBe(w.sunny); expect(mine[1].from).toBe('2026-06-15'); expect(mine[1].to).toBeNull()
    // the other household on RV 40 is untouched: one bar
    expect((res.body.data.leases as any[]).filter(l => l.id === w.otherLease)).toHaveLength(1)
  })
})

// S652 (Nic): the move takes its readings itself — nobody is emailed to go
// and get them afterwards.
describe('a move sends no meter-reads email', () => {
  it('raises no notification once the readings are recorded with the move', async () => {
    const w = await world({ withMeters: true })
    const meters = await db.query<{ id: string }>(`SELECT id FROM utility_meters ORDER BY label`)
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15', actorUserId: w.userId,
      reads: [{ meterId: meters.rows[0].id, value: 100 }, { meterId: meters.rows[1].id, value: 200 }] })
    await new Promise(r => setTimeout(r, 300))   // the old chase was fire-and-forget
    const n = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE type = 'move_meter_reads_due'`)
    expect(n.rows[0].n).toBe(0)
  })
})
