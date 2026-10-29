/**
 * 10/21 (Nic) — A NIGHT THAT HAPPENED IS BILLABLE FOREVER.
 *
 *   "that's one of the reasons why I want the reservation locked at checkout
 *    with no way to delete it. Because if, like, say I had 10 or 12 people go
 *    in the month, and then the landlord goes to delete all of those out of the
 *    schedule before the close of the month, then when it reads the schedule,
 *    the landlord could be cheating us out of the subscription fee by deleting
 *    the history. We need a way to have that no matter what changes they try to
 *    do."
 *
 *   "let's do the migration you were talking about where it counts who's in the
 *    spot each night. That way, you know, that way if people extend or leave
 *    early, it's got an accurate count."
 *
 * Nights are the one thing GAM bills in arrears, and the count used to read the
 * reservations' own dates at the moment the bill was cut. These tests hold the
 * two halves of the answer: what the record freezes, and what it deliberately
 * does NOT change about the money.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { NIGHTS_AGGREGATION_UNIT_TYPES } from '@gam/shared'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { billableUnitsForProperty } from './billableUnits'
import { stampOccupancyNights } from './occupancyNights'

interface World { landlordId: string; propertyId: string; siteId: string; site2Id: string }
let w: World

/** 'YYYY-MM-DD', `n` days from today in Phoenix (where the park is). */
const day = (n: number): string => {
  const now = new Date()
  const phoenix = new Date(now.getTime() - 7 * 3600_000)
  phoenix.setUTCDate(phoenix.getUTCDate() + n)
  return phoenix.toISOString().slice(0, 10)
}
/** The bill month a date falls in, as its 1st. */
const monthOf = (ymd: string) => `${ymd.slice(0, 7)}-01`
/** The month after that one. */
const nextMonth = (first: string) => {
  const [y, m] = first.split('-').map(Number)
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM platform_fee_config`)
  await db.query(
    `INSERT INTO platform_fee_config (rate_per_unit, min_per_connect_account, str_fee_pct, notes)
     VALUES (2.00, 10.00, 0.03, 'Test default')`)
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    const siteId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 600 })
    const site2Id = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 600 })
    await c.query('COMMIT')
    w = { landlordId, propertyId, siteId, site2Id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

async function stay(unitId: string, checkIn: string, checkOut: string, opts: {
  leaseType?: string; status?: string; cancelledAt?: string | null
} = {}): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights,
                                status, lease_type, total_amount, stay_terms, cancelled_at)
     VALUES ($1,$2,'Dale Carter',$3::date,$4::date,($4::date - $3::date),$5,$6,400,'stay',$7::timestamptz)
     RETURNING id`,
    [unitId, w.landlordId, checkIn, checkOut, opts.status ?? 'confirmed', opts.leaseType ?? 'nightly',
     opts.cancelledAt ?? null])
  return b.id
}

/** The nights the bill would count for the month `first` belongs to. */
async function nightsBilledFor(first: string): Promise<number> {
  const c = await db.connect()
  try {
    const counted = await billableUnitsForProperty(c, w.propertyId, nextMonth(first), first, NIGHTS_AGGREGATION_UNIT_TYPES)
    return counted.shortStayNights
  } finally { c.release() }
}

const written = async (unitId?: string) => (await db.query<{ night: string }>(
  `SELECT to_char(night, 'YYYY-MM-DD') AS night FROM unit_occupancy_nights
    WHERE property_id = $1 AND ($2::uuid IS NULL OR unit_id = $2::uuid) ORDER BY night`,
  [w.propertyId, unitId ?? null])).rows.map(r => r.night)

// ─────────────────────────────────────────────────────────────────────────────

describe('what gets written down', () => {
  it('writes a night only once it has passed, and writing again writes nothing', async () => {
    // Here since the day before yesterday, leaving the day after tomorrow.
    await stay(w.siteId, day(-2), day(2))
    const first = await stampOccupancyNights(db, { propertyId: w.propertyId })
    // Last night and the one before: tonight has not happened yet.
    expect(await written()).toEqual([day(-2), day(-1)])
    expect(first.stamped).toBe(2)
    const again = await stampOccupancyNights(db, { propertyId: w.propertyId })
    expect(again.stamped).toBe(0)
    expect(await written()).toEqual([day(-2), day(-1)])
  })

  it('the night before check-out is the last one — a stay Oct 1 to Oct 3 is two nights, the same arithmetic the old count used', async () => {
    await stay(w.siteId, day(-9), day(-7))
    await stampOccupancyNights(db, { propertyId: w.propertyId })
    expect(await written()).toEqual([day(-9), day(-8)])
  })

  it('a stay of no nights writes nothing', async () => {
    await stay(w.siteId, day(-3), day(-3))
    await stampOccupancyNights(db, { propertyId: w.propertyId })
    expect(await written()).toEqual([])
  })

  it('writes each park on its own calendar and only what is asked for', async () => {
    await stay(w.siteId, day(-30), day(-1))
    // `through` holds it to a day: the nights after that one wait.
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: day(-30), through: day(-25) })
    expect(await written()).toEqual([day(-30), day(-29), day(-28), day(-27), day(-26), day(-25)])
    // Another park's nights are never written by this one's run.
    const other = await getClient()
    try {
      await other.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(other)
      const propertyId = await seedProperty(other, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const siteId = await seedUnit(other, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 600 })
      await other.query(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, status, lease_type, total_amount, stay_terms)
         VALUES ($1,$2,'Elsewhere',$3::date,$4::date,2,'confirmed','nightly',80,'stay')`,
        [siteId, landlordId, day(-5), day(-3)])
      await other.query('COMMIT')
    } catch (e) { await other.query('ROLLBACK'); throw e } finally { other.release() }
    await stampOccupancyNights(db, { propertyId: w.propertyId })
    expect((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM unit_occupancy_nights`)).rows[0].n)
      .toBe(String((await written()).length))
  })
})

describe('THE CHEAT: re-dating or deleting the history after the nights happened', () => {
  // "the landlord could be cheating us out of the subscription fee by deleting
  //  the history. We need a way to have that no matter what changes they try to do."
  it('shortening a stay that already happened does not lower the bill — the nights were written down as they passed', async () => {
    const lastMonth = monthOf(day(-40))
    const checkIn = `${lastMonth.slice(0, 8)}05`
    const checkOut = `${lastMonth.slice(0, 8)}15`
    const booking = await stay(w.siteId, checkIn, checkOut)
    // The nights happened and were written down, a night at a time.
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: checkIn })
    expect(await nightsBilledFor(lastMonth)).toBe(10)

    // Now the landlord rewrites history before the month closes.
    await db.query(`UPDATE unit_bookings SET check_out = $2::date, nights = 2 WHERE id = $1`,
      [booking, `${lastMonth.slice(0, 8)}07`])
    expect(await nightsBilledFor(lastMonth)).toBe(10)

    // And the reservation cannot be removed at all.
    await expect(db.query(`DELETE FROM unit_bookings WHERE id = $1`, [booking]))
      .rejects.toThrow(/cannot be deleted/)
    expect(await nightsBilledFor(lastMonth)).toBe(10)
  })

  it('the same edit on nights nobody wrote down DOES lower it — which is what the record is for', async () => {
    const lastMonth = monthOf(day(-40))
    const checkIn = `${lastMonth.slice(0, 8)}05`
    const booking = await stay(w.siteId, checkIn, `${lastMonth.slice(0, 8)}15`)
    // No run ever happened for these nights: the count falls back to the
    // schedule, exactly as it did before 10/21 …
    expect(await nightsBilledFor(lastMonth)).toBe(10)
    await db.query(`UPDATE unit_bookings SET check_out = $2::date WHERE id = $1`,
      [booking, `${lastMonth.slice(0, 8)}07`])
    // … and the edit moves the bill.
    expect(await nightsBilledFor(lastMonth)).toBe(2)
  })

  it('a night that was written down cannot be deleted, moved to another site or re-dated', async () => {
    await stay(w.siteId, day(-5), day(-3))
    await stampOccupancyNights(db, { propertyId: w.propertyId })
    const id = (await db.query<{ id: string }>(`SELECT id FROM unit_occupancy_nights LIMIT 1`)).rows[0].id
    await expect(db.query(`DELETE FROM unit_occupancy_nights WHERE id = $1`, [id]))
      .rejects.toThrow(/cannot be deleted/)
    await expect(db.query(`UPDATE unit_occupancy_nights SET night = night - 1 WHERE id = $1`, [id]))
      .rejects.toThrow(/frozen/)
    await expect(db.query(`UPDATE unit_occupancy_nights SET unit_id = $2 WHERE id = $1`, [id, w.site2Id]))
      .rejects.toThrow(/frozen/)
    await expect(db.query(`UPDATE unit_occupancy_nights SET lease_type = 'month_to_month' WHERE id = $1`, [id]))
      .rejects.toThrow(/frozen/)
  })

  it('changing the site\'s type afterwards cannot un-count a night either', async () => {
    const lastMonth = monthOf(day(-40))
    const checkIn = `${lastMonth.slice(0, 8)}05`
    await stay(w.siteId, checkIn, `${lastMonth.slice(0, 8)}12`)
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: checkIn })
    expect(await nightsBilledFor(lastMonth)).toBe(7)
    // 'storage' is not a type whose nights aggregate.
    await db.query(`UPDATE units SET unit_type = 'storage' WHERE id = $1`, [w.siteId])
    expect(await nightsBilledFor(lastMonth)).toBe(7)
  })
})

describe('what the record does NOT change about the money', () => {
  it('a stay cancelled before it arrived is still no nights at all', async () => {
    const lastMonth = monthOf(day(-40))
    const checkIn = `${lastMonth.slice(0, 8)}10`
    await stay(w.siteId, checkIn, `${lastMonth.slice(0, 8)}20`,
      { status: 'cancelled', cancelledAt: `${lastMonth.slice(0, 8)}09T09:00:00Z` })
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: checkIn })
    expect(await written()).toEqual([])
    expect(await nightsBilledFor(lastMonth)).toBe(0)
  })

  it('a stay cancelled the day it started, and a no-show, still bill their nights — "the site was held either way"', async () => {
    const lastMonth = monthOf(day(-40))
    const checkIn = `${lastMonth.slice(0, 8)}10`
    const checkOut = `${lastMonth.slice(0, 8)}20`
    await stay(w.siteId, checkIn, checkOut, { status: 'cancelled', cancelledAt: `${checkIn}T09:00:00Z` })
    await stay(w.site2Id, checkIn, checkOut, { status: 'no_show' })
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: checkIn })
    expect(await written(w.siteId)).toHaveLength(10)
    expect(await written(w.site2Id)).toHaveLength(10)
    expect(await nightsBilledFor(lastMonth)).toBe(20)
  })

  it('a month stay is a space for the month, never nights — written down all the same, counted by neither rule twice', async () => {
    const lastMonth = monthOf(day(-40))
    const checkIn = `${lastMonth.slice(0, 8)}02`
    await stay(w.siteId, checkIn, `${lastMonth.slice(0, 8)}28`, { leaseType: 'month_to_month' })
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: checkIn })
    // The record holds the occupancy …
    expect(await written(w.siteId)).toHaveLength(26)
    // … and the nights aggregate ignores it, as it always has.
    expect(await nightsBilledFor(lastMonth)).toBe(0)
  })

  it('a stay typed in (or imported) after its nights had already passed still bills — nothing is lost by the run being late', async () => {
    const lastMonth = monthOf(day(-40))
    const checkIn = `${lastMonth.slice(0, 8)}05`
    await stay(w.siteId, checkIn, `${lastMonth.slice(0, 8)}09`)
    // No run has reached those nights: the schedule answers for them.
    expect(await written()).toEqual([])
    expect(await nightsBilledFor(lastMonth)).toBe(4)
    // And once a run does reach them, the answer is the same.
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: checkIn })
    expect(await nightsBilledFor(lastMonth)).toBe(4)
  })

  it('leaving early stops the nights from the day they go, and the nights already stayed stand', async () => {
    // Booked for ten nights from nine days ago; the desk checked them out
    // after four and moved the check-out in, which is what frees the site.
    const booking = await stay(w.siteId, day(-9), day(1))
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: day(-9), through: day(-6) })
    await db.query(`UPDATE unit_bookings SET check_out = $2::date, status = 'checked_out' WHERE id = $1`,
      [booking, day(-5)])
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: day(-9) })
    // Four nights: the 9th, 8th, 7th and 6th days ago. Nothing after they left.
    expect(await written()).toEqual([day(-9), day(-8), day(-7), day(-6)])
  })

  // 10/21 (Nic): "What happens if we don't adjust his move-out day until he
  // moves out? Say it stops counting on the 22nd according to the reservation,
  // and he doesn't move out till the 26th, and then we change the schedule as
  // of the 26th. Will it backtrack and count those other days, or will it not?
  // Because it would be really tedious for somebody who doesn't know exactly
  // when they're leaving to have the front desk person update the schedule
  // daily."
  it('IT BACKTRACKS: a departure corrected days later fills in the nights nobody had written down yet', async () => {
    // Booked to leave six days ago; stayed on and nobody touched the schedule.
    const booking = await stay(w.siteId, day(-10), day(-6))
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: day(-10) })
    // Four nights written: the 10th through the 7th day ago. Nothing after the
    // check-out the schedule still claims.
    expect(await written()).toEqual([day(-10), day(-9), day(-8), day(-7)])

    // The desk catches up today and sets the day they actually left.
    await db.query(`UPDATE unit_bookings SET check_out = $2::date, status = 'checked_out' WHERE id = $1`, [booking, day(-1)])
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: day(-10) })
    // The nights in between are now written, in one pass, with no daily
    // babysitting: nothing is lost by the correction being late.
    expect(await written()).toEqual([day(-10), day(-9), day(-8), day(-7), day(-6), day(-5), day(-4), day(-3), day(-2)])
  })

  it('and the bill counts a late correction even before the next run reaches it', async () => {
    const lastMonth = monthOf(day(-40))
    const checkIn = `${lastMonth.slice(0, 8)}05`
    const booking = await stay(w.siteId, checkIn, `${lastMonth.slice(0, 8)}09`)
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: checkIn })
    expect(await nightsBilledFor(lastMonth)).toBe(4)
    // They stayed four nights longer than the schedule said, corrected after
    // the fact. No run has happened since.
    await db.query(`UPDATE unit_bookings SET check_out = $2::date WHERE id = $1`, [booking, `${lastMonth.slice(0, 8)}13`])
    expect(await nightsBilledFor(lastMonth)).toBe(8)
  })

  it('extending adds the nights as they happen', async () => {
    const booking = await stay(w.siteId, day(-4), day(-2))
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: day(-4) })
    expect(await written()).toEqual([day(-4), day(-3)])
    // They stayed on; the desk lengthened the reservation.
    await db.query(`UPDATE unit_bookings SET check_out = $2::date WHERE id = $1`, [booking, day(1)])
    await stampOccupancyNights(db, { propertyId: w.propertyId, from: day(-4) })
    expect(await written()).toEqual([day(-4), day(-3), day(-2), day(-1)])
  })
})
