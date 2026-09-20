/**
 * S651 — a stay sold at the counter lands on the Master Schedule.
 *
 * Before this the register took the money and stopped: no site, no dates,
 * nothing on the schedule. Somebody was parked on a site the software believed
 * was empty, which is how two rigs get sold the same spot.
 *
 * The arithmetic is deliberately dull — Nic: "You add two of those, it's two
 * days or two weeks or two months." What is worth testing is that the counter
 * cannot sell a site that is already spoken for, by any of the three ways a
 * site can be spoken for.
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { checkOutFor, nightsBetween, createStayBooking, siteIsFree } from './registerStay'

let landlordId = '', userId = '', propertyId = '', unitId = ''

async function withClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try { return await fn(c) } finally { c.release() }
}

beforeEach(async () => {
  await cleanupAllSchema()
  await withClient(async (c) => {
    const l = await seedLandlord(c); landlordId = l.landlordId; userId = l.userId
    propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const u = await c.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type)
       VALUES ($1,$2,'RV 01','vacant',500,'rv_spot') RETURNING id`, [propertyId, landlordId])
    unitId = u.rows[0].id
  })
})

const line = (stayUnit: any, qty: number, lineTotal: number) =>
  [{ itemId: 'i1', qty, stayUnit, lineTotal, name: `RV site — ${stayUnit}` }]

const guest = { unitId: '', checkIn: '2026-10-01', guestName: 'Dale Carter', guestPhone: '520-555-0110' }

async function sell(lines: any[], details: any = {}) {
  return withClient(async (c) => {
    await c.query('BEGIN')
    try {
      const tx = await c.query(
        `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method,
                                       subtotal, tax_amount, total)
         VALUES ($1,$2,$3,'cash',0,0,0) RETURNING id`, [landlordId, propertyId, userId])
      const r = await createStayBooking(c, {
        landlordId, propertyId, posTransactionId: tx.rows[0].id, lines,
        details: { ...guest, unitId, ...details },
      })
      await c.query('COMMIT')
      return r
    } catch (e) { await c.query('ROLLBACK'); throw e }
  })
}

describe('how long a stay lasts', () => {
  it('multiplies by the quantity rung', () => {
    // Nic: "by default one day or by default one week. You add two of those,
    // it's two days or two weeks or two months."
    expect(checkOutFor('2026-10-01', 'night', 1)).toBe('2026-10-02')
    expect(checkOutFor('2026-10-01', 'night', 3)).toBe('2026-10-04')
    expect(checkOutFor('2026-10-01', 'week', 2)).toBe('2026-10-15')
    expect(checkOutFor('2026-10-01', 'month', 2)).toBe('2026-12-01')
  })

  it('counts a month as a calendar month, not thirty nights', () => {
    // Somebody who pays for a month from the 15th of January is there until
    // the 15th of February, which is how billing and every human already
    // treat it. February makes the difference visible.
    expect(checkOutFor('2026-01-15', 'month', 1)).toBe('2026-02-15')
    expect(nightsBetween('2026-01-15', '2026-02-15')).toBe(31)
    expect(nightsBetween('2026-02-15', '2026-03-15')).toBe(28)
  })

  it('refuses a quantity that is not a stay', () => {
    expect(() => checkOutFor('2026-10-01', 'night', 0)).toThrow()
    expect(() => checkOutFor('not-a-date', 'night', 1)).toThrow()
  })
})

describe('selling a stay at the counter', () => {
  it('puts it on the schedule, with what the register actually charged', async () => {
    const r = await sell(line('night', 3, 147))
    expect(r.checkOut).toBe('2026-10-04')
    expect(r.nights).toBe(3)

    const [b] = await query<any>(
      `SELECT guest_name, guest_phone, check_in::text, check_out::text, nights,
              total_amount::text, status, source, lease_type, pos_transaction_id
         FROM unit_bookings WHERE id = $1`, [r.bookingId])
    expect(b.guest_name).toBe('Dale Carter')
    expect(b.check_in).toBe('2026-10-01')
    expect(b.status).toBe('confirmed')      // they paid at the counter
    expect(b.source).toBe('register')
    expect(b.lease_type).toBe('nightly')
    // The register's own price, carried through untouched — not re-quoted from
    // the site's rate card. Nic: "register price should be its own thing."
    expect(Number(b.total_amount)).toBe(147)
    expect(b.pos_transaction_id).toBeTruthy()
  })

  it('will not sell a site that already has a booking over those dates', async () => {
    await sell(line('night', 3, 147))
    await expect(sell(line('night', 2, 98), { checkIn: '2026-10-02' }))
      .rejects.toThrow(/already taken/i)
  })

  it('will not sell a site somebody has a lease on', async () => {
    await query(
      `INSERT INTO leases (unit_id, landlord_id, status, start_date, end_date, rent_amount, lease_type)
       VALUES ($1,$2,'active','2026-09-01','2027-09-01',500,'fixed_term')`,
      [unitId, landlordId])
    await expect(sell(line('night', 2, 98))).rejects.toThrow(/already taken/i)
  })

  it('will not sell a site that is out of order', async () => {
    // memory: gam-out-of-order-sites — every availability path goes through
    // unit_out_of_order_overlaps, including this one.
    await query(
      `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason, created_by)
       VALUES ($1,$2,'2026-09-25','2026-10-10','water line',$3)`, [unitId, landlordId, userId])
    await expect(sell(line('night', 2, 98))).rejects.toThrow(/already taken/i)
  })

  it('takes the site once the blocking stay has ended', async () => {
    await sell(line('night', 3, 147))                       // 1st → 4th
    const r = await sell(line('night', 2, 98), { checkIn: '2026-10-04' })
    expect(r.checkOut).toBe('2026-10-06')
  })

  it('refuses a site at another property', async () => {
    const other = await withClient(async (c) => {
      const l = await seedLandlord(c)
      const p = await seedProperty(c, { landlordId: l.landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
      const u = await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount)
         VALUES ($1,$2,'RV 99','vacant',500) RETURNING id`, [p, l.landlordId])
      return u.rows[0].id
    })
    await expect(sell(line('night', 1, 49), { unitId: other }))
      .rejects.toThrow(/not at this property/i)
  })

  it('refuses two different stay lengths on one sale', async () => {
    // A stay whose length depends on which line you read has no dates.
    await expect(sell([...line('night', 1, 49), ...line('week', 1, 250)]))
      .rejects.toThrow(/one kind of stay/i)
  })

  it('asks for the things it cannot derive', async () => {
    await expect(sell(line('night', 1, 49), { guestName: '' })).rejects.toThrow(/who is the stay for/i)
    await expect(sell(line('night', 1, 49), { checkIn: '' })).rejects.toThrow(/what date/i)
  })
})
