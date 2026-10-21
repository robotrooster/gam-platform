/**
 * 10/20 — A MONTH READ THAT SPANS A TURNOVER IS BILLED TO NOBODY.
 *
 * The defect, on Oak Park RV 27. Lease A ran Sep 1 → Oct 10 and the household
 * drove away on the 10th; nobody recorded a closing read. Lease B arrived on
 * the 12th. The October run read the submeter on the 30th, and the read before
 * it was Oct 4.
 *
 * The space-history row a lease opens is closed only when the lease MOVES
 * spaces, never when it ends, so lease A still "covered October 1" — and A was
 * billed Oct 4 → Oct 30, eighteen days of household B's power. A then got "your
 * final utility bill is ready" and the deposit-return sweep settled it out of
 * A's deposit. B was never billed for October at all: one bill per meter, spot,
 * month and utility, and A's bill had the slot.
 *
 * S548's rule — the cycle belongs to the household that covered its start —
 * justified the days on the end of a read as GAP days, days nobody was there.
 * It never covered another paying household's days. So:
 *
 *   1. the departing household is not billed for days the spot was somebody
 *      else's, is sent no final utility bill, and the month's bill slot is left
 *      open; the landlord is told what happened and which day;
 *   2. gap days are untouched (S548): a household that leaves with nobody
 *      behind them still carries the read to the end;
 *   3. their own renewal — or their next lease on the same spot — is the same
 *      household, not a turnover;
 *   4. a nightly guest arriving counts: the guest's power was inside their rate
 *      and billed to nobody, and the household that left is not billed for it
 *      either (and the reservation does not silence the notice);
 *   5. a resident who MOVES to another spot does not keep billing the old one
 *      after somebody else is on it (Oak Park RV 18's real shape);
 *   6. a closing read that WAS taken bills the departing household its own days
 *      and nothing past them.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { generateBillsForMeter, billMoveOutRead } from './utilityBilling'

beforeEach(async () => { await cleanupAllSchema() })

const OCT = '2026-10-01'
const oct = new Date(OCT + 'T00:00:00Z')

async function park() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name='Oak Park RV Park', timezone='America/Phoenix' WHERE id=$1`, [propertyId])
    await c.query('COMMIT')
    return { ...ll, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Park = Awaited<ReturnType<typeof park>>

/** An RV spot with its own electric submeter, read Oct 4 and Oct 30: 390 kWh. */
async function spot(p: Park, o: { unit: string; start?: number; end?: number }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
    await c.query(`UPDATE units SET unit_number=$2, unit_type='rv_spot', status='active' WHERE id=$1`, [unitId, o.unit])
    const m = await c.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, base_fee, digits)
       VALUES ($1,'electric',$2,'submeter',0.21,0,6) RETURNING id`, [p.propertyId, `${o.unit} electric`])
    const meterId = m.rows[0].id
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, unitId])
    // September's cycle read came in late, on Oct 4 — one monthly read per
    // meter per cycle, so it is September's, and the Oct 30 read is October's.
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1,'2026-10-04',$2,'2026-09-01','monthly_cycle',$4), ($1,'2026-10-30',$3,'2026-10-01','monthly_cycle',$4)`,
      [meterId, o.start ?? 17506, o.end ?? 17896, p.userId])
    await c.query('COMMIT')
    return { unitId, meterId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A household on a spot: its lease, its primary resident. */
async function household(p: Park, o: {
  unitId: string; start: string; end?: string | null
  status?: 'active' | 'expired' | 'terminated'; supersedes?: string | null
  tenantId?: string
}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const leaseId = await seedLease(c, { unitId: o.unitId, landlordId: p.landlordId, startDate: o.start, status: o.status ?? 'active' })
    const tenantId = o.tenantId ?? await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    if (o.end) await c.query(`UPDATE leases SET end_date = $2 WHERE id = $1`, [leaseId, o.end])
    if (o.supersedes) await c.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [leaseId, o.supersedes])
    await c.query('COMMIT')
    return { leaseId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const billsFor = (meterId: string) => db.query<any>(
  `SELECT lease_id, tenant_id, usage_amount::float AS usage, charge_amount::float AS charge, status,
          to_char(reading_start_date, 'YYYY-MM-DD') AS from_day,
          to_char(reading_end_date, 'YYYY-MM-DD') AS to_day
     FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = $2 ORDER BY created_at`,
  [meterId, OCT]).then(r => r.rows)
const notices = () => db.query<{ title: string; body: string; data: any }>(
  `SELECT title, body, data FROM notifications WHERE type = 'utility_usage_unbilled' ORDER BY created_at`)
  .then(r => r.rows)

describe('a month read that spans a turnover', () => {
  it('bills the departing household NOTHING for the next household\'s days, and tells the landlord', async () => {
    const p = await park()
    const s = await spot(p, { unit: 'RV 27' })
    const a = await household(p, { unitId: s.unitId, start: '2026-09-01', end: '2026-10-10', status: 'expired' })
    await household(p, { unitId: s.unitId, start: '2026-10-12' })

    const r = await generateBillsForMeter(s.meterId, oct)
    expect(r.billsCreated).toBe(0)
    // Nothing on household A, and nothing in the month's one bill slot — the
    // closing read that settles it can still be recorded.
    expect(await billsFor(s.meterId)).toHaveLength(0)

    const n = await notices()
    expect(n).toHaveLength(1)
    expect(n[0].title).toBe('Electric used on RV 27 — the spot changed hands mid-read')
    expect(n[0].body).toContain('moved 390 kWh ($81.90) for Oct 2026')
    expect(n[0].body).toContain('the spot changed hands on Oct 12')
    expect(n[0].body).toContain('billed to NEITHER')
    expect(n[0].body).toContain('Read the meter at the pull-out')
    expect(n[0].data).toMatchObject({ meterId: s.meterId, cycle: OCT, why: 'turnover', changedHandsOn: '2026-10-12' })

    // Told once per meter and cycle; the run stays re-runnable.
    await generateBillsForMeter(s.meterId, oct)
    expect(await notices()).toHaveLength(1)
    expect(await billsFor(s.meterId)).toHaveLength(0)
    expect(a.leaseId).toBeTruthy()
  })

  it('leaves GAP days alone (S548): nobody behind them, so the departing household carries the read', async () => {
    const p = await park()
    const s = await spot(p, { unit: 'RV 28' })
    const a = await household(p, { unitId: s.unitId, start: '2026-09-01', end: '2026-10-10', status: 'expired' })

    expect((await generateBillsForMeter(s.meterId, oct)).billsCreated).toBe(1)
    expect(await billsFor(s.meterId)).toEqual([expect.objectContaining({
      lease_id: a.leaseId, usage: 390, charge: 81.9, from_day: '2026-10-04', to_day: '2026-10-30',
    })])
    expect(await notices()).toHaveLength(0)
  })

  it('a renewal is the same household staying on, not a turnover', async () => {
    const p = await park()
    const s = await spot(p, { unit: 'RV 29' })
    const a = await household(p, { unitId: s.unitId, start: '2026-09-01', end: '2026-10-10', status: 'expired' })
    // Signed again on the same spot: linked as a renewal AND the same resident.
    await household(p, { unitId: s.unitId, start: '2026-10-11', supersedes: a.leaseId, tenantId: a.tenantId })

    expect((await generateBillsForMeter(s.meterId, oct)).billsCreated).toBe(1)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ lease_id: a.leaseId, usage: 390 })
    expect(await notices()).toHaveLength(0)
  })

  it('the same resident signing a fresh lease on the spot is the same household too', async () => {
    const p = await park()
    const s = await spot(p, { unit: 'RV 30' })
    const a = await household(p, { unitId: s.unitId, start: '2026-09-01', end: '2026-10-10', status: 'expired' })
    // No renewal link at all — a new lease for the same person on the same spot.
    await household(p, { unitId: s.unitId, start: '2026-10-12', tenantId: a.tenantId })

    expect((await generateBillsForMeter(s.meterId, oct)).billsCreated).toBe(1)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ lease_id: a.leaseId })
    expect(await notices()).toHaveLength(0)
  })

  it('a guest on the spot counts: the guest\'s power was in their rate, and the household that left is not billed for it', async () => {
    const p = await park()
    const s = await spot(p, { unit: 'RV 31' })
    await household(p, { unitId: s.unitId, start: '2026-09-01', end: '2026-10-10', status: 'expired' })
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, status, source)
       VALUES ($1,$2,'nightly','2026-10-12','2026-10-20',8,'Overnight Guest','checked_out','direct')`,
      [s.unitId, p.landlordId])

    expect((await generateBillsForMeter(s.meterId, oct)).billsCreated).toBe(0)
    expect(await billsFor(s.meterId)).toHaveLength(0)
    // A reservation normally explains usage nobody was billed for and the
    // landlord is left alone. Not here: the days BEFORE the guest arrived were
    // the departed household's own, and only a closing read can bill them.
    const n = await notices()
    expect(n).toHaveLength(1)
    expect(n[0].data).toMatchObject({ why: 'turnover', changedHandsOn: '2026-10-12' })
  })

  it('a cancelled reservation is nobody on the spot — gap days, billed as before', async () => {
    const p = await park()
    const s = await spot(p, { unit: 'RV 32' })
    const a = await household(p, { unitId: s.unitId, start: '2026-09-01', end: '2026-10-10', status: 'expired' })
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, status, source, cancelled_at)
       VALUES ($1,$2,'nightly','2026-10-12','2026-10-20',8,'Called Off','cancelled','direct',now()),
              ($1,$2,'nightly','2026-10-21','2026-10-23',2,'Never Came','no_show','direct',NULL)`,
      [s.unitId, p.landlordId])

    expect((await generateBillsForMeter(s.meterId, oct)).billsCreated).toBe(1)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ lease_id: a.leaseId, usage: 390 })
    expect(await notices()).toHaveLength(0)
  })

  it('a resident who moved to another spot stops carrying the old one once somebody else is on it', async () => {
    const p = await park()
    const s = await spot(p, { unit: 'RV 18' })
    const other = await spot(p, { unit: 'RV 44' })
    const a = await household(p, { unitId: s.unitId, start: '2026-09-02' })
    // They moved spots on the 20th (the space-history row closes), and a
    // different household took RV 18 on the 22nd.
    await db.query(`UPDATE leases SET unit_id = $2, unit_moved_on = '2026-10-20' WHERE id = $1`, [a.leaseId, other.unitId])
    await household(p, { unitId: s.unitId, start: '2026-10-22' })

    expect((await generateBillsForMeter(s.meterId, oct)).billsCreated).toBe(0)
    expect(await billsFor(s.meterId)).toHaveLength(0)
    expect((await notices())[0].data).toMatchObject({ why: 'turnover', changedHandsOn: '2026-10-22' })
  })

  it('a closing read that WAS taken bills the departing household its own days and nothing past them', async () => {
    const p = await park()
    const s = await spot(p, { unit: 'RV 33' })
    const a = await household(p, { unitId: s.unitId, start: '2026-09-01', end: '2026-10-10', status: 'expired' })
    await household(p, { unitId: s.unitId, start: '2026-10-12' })
    // Read at the pull-out: 17506 → 17600 is theirs.
    const closing = await db.query<{ id: string }>(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1,'2026-10-10',17600,'2026-10-01','move_out_final',$2) RETURNING id`, [s.meterId, p.userId])
    expect((await billMoveOutRead(s.meterId, closing.rows[0].id)).billed).toBe(true)

    const bills = await billsFor(s.meterId)
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ lease_id: a.leaseId, usage: 94, from_day: '2026-10-04', to_day: '2026-10-10' })

    // The month run then has only the arrival's days in front of it, and the
    // slot is already taken — so it adds nothing to the household that left.
    await generateBillsForMeter(s.meterId, oct)
    expect(await billsFor(s.meterId)).toHaveLength(1)
    expect((await billsFor(s.meterId))[0]).toMatchObject({ to_day: '2026-10-10' })
  })
})
