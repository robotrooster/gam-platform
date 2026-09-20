/**
 * S652 — an unpaid hold has no clock, and loses to money.
 *
 * Nic, asked how long a counter hold should last: "there's no timer for deposit
 * link but if it's not paid and someone else pays it boots them as unconfirmed
 * when there's no other spaces."
 *
 * The half that is easy to get wrong is "when there's no other spaces" —
 * displacing somebody is the LAST resort, and a park with a free equivalent
 * site must move them instead.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { clearUnpaidHolds } from './holdDisplacement'

async function seed(opts: { sites: number; layout?: string; amp?: string }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const ids: string[] = []
    for (let i = 1; i <= opts.sites; i++) {
      const u = await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, rv_site_layout, rv_amp_service)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',40,$4,$5) RETURNING id`,
        [propertyId, landlordId, `RV 0${i}`, opts.layout ?? 'back_in', opts.amp ?? '30'])
      ids.push(u.rows[0].id)
    }
    await c.query('COMMIT')
    return { landlordId, propertyId, unitIds: ids }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function hold(unitId: string, landlordId: string, opts: { paid?: boolean; locked?: boolean } = {}) {
  const r = await query<any>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, nights,
        total_amount, status, deposit_paid_at, locked_to_unit, hold_expires_at)
     VALUES ($1,$2,'Dale Carter','dale@t.dev','nightly','2027-03-06','2027-03-13',7,280,
             'tentative', $3, $4, NULL) RETURNING id`,
    [unitId, landlordId, opts.paid ? new Date() : null, opts.locked === true])
  return r[0].id
}

const withTx = async (fn: (c: any) => Promise<any>) => {
  const c = await db.connect()
  try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out }
  catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

beforeEach(async () => { await cleanupAllSchema() })

describe('an unpaid hold yields to somebody who paid', () => {
  it('moves the holder to an equivalent free site rather than bumping them', async () => {
    const f = await seed({ sites: 2 })
    const held = await hold(f.unitIds[0], f.landlordId)

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out).toHaveLength(1)
    expect(out[0].outcome).toBe('moved')
    expect(out[0].toUnitNumber).toBe('RV 02')

    const [b] = await query<any>(`SELECT unit_id, status, displaced_at FROM unit_bookings WHERE id=$1`, [held])
    expect(b.unit_id).toBe(f.unitIds[1])
    expect(b.status).toBe('tentative')       // still theirs, still coming
    expect(b.displaced_at).toBeTruthy()
  })

  it('only bumps them when the park genuinely has nothing else', async () => {
    const f = await seed({ sites: 1 })
    const held = await hold(f.unitIds[0], f.landlordId)

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('displaced')

    const [b] = await query<any>(`SELECT status, displaced_reason FROM unit_bookings WHERE id=$1`, [held])
    expect(b.status).toBe('cancelled')
    expect(b.displaced_reason).toMatch(/nothing else free/i)
  })

  it('never touches a booking that has paid a deposit', async () => {
    // The whole point of the rank. Paid beats unpaid, and a paid booking is a
    // paid booking whatever its status says.
    const f = await seed({ sites: 2 })
    const paid = await hold(f.unitIds[0], f.landlordId, { paid: true })

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out).toHaveLength(0)

    const [b] = await query<any>(`SELECT unit_id, status FROM unit_bookings WHERE id=$1`, [paid])
    expect(b.unit_id).toBe(f.unitIds[0])
    expect(b.status).toBe('tentative')
  })

  it('will not move a guest onto a site that does not match what they asked for', async () => {
    // A 50-amp pull-through is not accommodated by a 30-amp back-in.
    const f = await seed({ sites: 2 })
    const held = await hold(f.unitIds[0], f.landlordId)
    await query(`UPDATE unit_bookings SET required_amp_service='50' WHERE id=$1`, [held])

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('displaced')
  })

  it('moves a locked hold rather than dropping it, and says it was locked', async () => {
    // Losing the site you asked for is a smaller injury than losing the stay.
    const f = await seed({ sites: 2 })
    await hold(f.unitIds[0], f.landlordId, { locked: true })

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('moved')
    expect(out[0].wasLocked).toBe(true)
  })

  it('does not cascade one holder onto another holder\'s site', async () => {
    const f = await seed({ sites: 2 })
    await hold(f.unitIds[0], f.landlordId)
    await hold(f.unitIds[1], f.landlordId)

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('displaced')
  })

  it('leaves a hold on other dates completely alone', async () => {
    const f = await seed({ sites: 1 })
    const other = await query<any>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type, check_in, check_out,
                                  nights, total_amount, status)
       VALUES ($1,$2,'Someone Else','nightly','2027-05-01','2027-05-05',4,160,'tentative') RETURNING id`,
      [f.unitIds[0], f.landlordId])

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out).toHaveLength(0)
    const [b] = await query<any>(`SELECT status FROM unit_bookings WHERE id=$1`, [other[0].id])
    expect(b.status).toBe('tentative')
  })
})
