/**
 * 10/12 (Nic) — GAM Books ledger, phase P5: a stay is earned when the guest
 * arrives (gam-ledger-design-2026-10-12 §6 F6; Nic's 10/12 answer L10:
 * "short stays on arrival; 30+ nights month by month; held as guest deposit
 * until then"). Real tables, real capture triggers, the real engine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../db'
import { cleanupAllSchema } from '../../test/dbHelpers'
import { ledgerCompany, outboxCount } from '../../test/ledgerFixtures'
import { registerP5, unregisterAll, sale, booking, siteDeposit, active, balance, received, waiting } from '../../test/ledgerP5Fixtures'
import { drainLedgerOutbox } from '../ledgerEngine'
import { parseBookingSourceId, staySchedule } from './bookingStay'

beforeEach(async () => {
  await cleanupAllSchema()
  registerP5()
})
afterEach(() => unregisterAll())

const earned = async (sourceId: string) =>
  (await active('booking', sourceId)).filter(l => l.kind === 'charge' && l.role === 'stay_income').map(l => [l.day, l.cr])

describe('the booking-site deposit and a short stay (F6, L10)', () => {
  it('the deposit is held as a guest deposit the day it is paid, and earned the day the guest arrives', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-10-08' })
    // $224 toward the stay, $24 of it lodging tax; the property covered GAM's card fee, so GAM holds $216.28.
    await siteDeposit(co, b, { toward: 224, lodgingTax: 24, held: 216.28, at: '2026-09-15 18:00:00+00' })
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const ls = await active('booking', b)
    expect(ls.filter(l => l.kind === 'main').map(l => [l.day, l.role, l.dr, l.cr, l.cash, l.cat])).toEqual([
      ['2026-09-15', 'due_from_gam', 216.28, 0, null, null],
      ['2026-09-15', 'processing_fees', 7.72, 0, null, null],
      ['2026-09-15', 'lodging_tax_payable', 0, 24, 'in', 'tax_collected'],
      ['2026-09-15', 'guest_deposits', 0, 200, 'in', 'stays_and_pay_links'],
    ])
    expect(await earned(b)).toEqual([['2026-10-04', 200]])
    expect(await balance(co.landlordId, 'guest_deposits', { through: '2026-09-30' })).toBe(-200)
    expect(await balance(co.landlordId, 'stay_income', { through: '2026-09-30' })).toBe(0)
    expect(await balance(co.landlordId, 'guest_deposits')).toBe(0)
    expect(await balance(co.landlordId, 'stay_income')).toBe(-200)
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30')).toBe(224)
    // A short stay has nothing past arrival.
    expect(await active('booking', `${b}|end`)).toEqual([])
  })

  it('money paid after arrival is earned on the arrival day; a deposit without its stored lodging tax waits for the fact', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-10-06' })
    await sale(co, { subtotal: 120, stay: { bookingId: b, toward: 120 }, at: '2026-10-05 18:00:00+00' })
    await drainLedgerOutbox()
    expect(await earned(b)).toEqual([['2026-10-04', 120]])
    const b2 = await booking(co, { checkIn: '2026-11-01', checkOut: '2026-11-03' })
    await siteDeposit(co, b2, { toward: 50, lodgingTax: null, held: 50, at: '2026-10-01 18:00:00+00' })
    await drainLedgerOutbox()
    expect((await waiting('booking', b2))?.reason_code).toBe('missing_fact')
  })
})

describe('30+ nights: month by month (L10)', () => {
  it('production\'s shape — 31 nights Oct 4 → Nov 4, $589 cash on Oct 6 — is one stay-month, earned on arrival', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-11-04', status: 'checked_in', total: 589 })
    const s = await sale(co, { subtotal: 589, stay: { bookingId: b, toward: 589 }, at: '2026-10-06 18:00:00+00' })
    await drainLedgerOutbox()
    expect((await active('pos_sale', s)).find(l => l.role === 'guest_deposits')).toMatchObject({ day: '2026-10-06', cr: 589 })
    expect(await earned(b)).toEqual([['2026-10-04', 589]])
    expect(await active('booking', `${b}|1`)).toEqual([])
    expect(await balance(co.landlordId, 'guest_deposits')).toBe(0)
  })

  it('a 45-night stay is earned by stay-month: 31 nights on arrival, 14 on the day the second month starts', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-11-18' })
    expect(await outboxCount('booking', `${b}|1`)).toBe(1)
    await sale(co, { subtotal: 900, stay: { bookingId: b, toward: 900 }, at: '2026-10-04 18:00:00+00' })
    await drainLedgerOutbox()
    expect(await earned(b)).toEqual([['2026-10-04', 620]])
    expect(await earned(`${b}|1`)).toEqual([['2026-11-04', 280]])
    expect(await balance(co.landlordId, 'stay_income', { through: '2026-10-31' })).toBe(-620)
    expect(await balance(co.landlordId, 'guest_deposits')).toBe(0)
  })

  it('an early check-out: the months never reached are earned the day the guest left, and their own postings are taken back', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2027-01-04' })
    await sale(co, { subtotal: 3000, stay: { bookingId: b, toward: 3000 }, at: '2026-10-04 18:00:00+00' })
    await drainLedgerOutbox()
    // 92 nights sold: 31 / 30 / 31.
    expect(await earned(b)).toEqual([['2026-10-04', 1010.87]])
    expect(await earned(`${b}|1`)).toEqual([['2026-11-04', 978.26]])
    expect(await earned(`${b}|2`)).toEqual([['2026-12-04', 1010.87]])
    // The guest leaves Nov 10 (the nights sold stay as they were).
    await db.query(`UPDATE unit_bookings SET check_out = '2026-11-10', status = 'checked_out' WHERE id = $1`, [b])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await earned(`${b}|2`)).toEqual([])
    expect(await earned(`${b}|end`)).toEqual([['2026-11-10', 1010.87]])
    expect(await balance(co.landlordId, 'stay_income')).toBe(-3000)
    expect(await balance(co.landlordId, 'guest_deposits')).toBe(0)
  })

  it('a stay whose lease bills the rest is one piece, earned on arrival', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-12-04', stayTerms: 'lease' })
    await sale(co, { subtotal: 500, stay: { bookingId: b, toward: 500 } })
    await drainLedgerOutbox()
    expect(await earned(b)).toEqual([['2026-10-04', 500]])
    expect(await earned(`${b}|1`)).toEqual([])
  })
})

describe('a stay that never happens (L10)', () => {
  it('cancelled before arrival: nothing is earned on the arrival day; what was kept is earned the day it was cancelled', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-10-07' })
    await siteDeposit(co, b, { toward: 100, lodgingTax: 0, held: 100, at: '2026-09-01 18:00:00+00' })
    await drainLedgerOutbox()
    expect(await earned(b)).toEqual([['2026-10-04', 100]])
    await db.query(`UPDATE unit_bookings SET status = 'cancelled', cancelled_at = '2026-09-20 18:00:00+00' WHERE id = $1`, [b])
    await drainLedgerOutbox()
    expect(await earned(b)).toEqual([])
    expect(await earned(`${b}|end`)).toEqual([['2026-09-20', 100]])
    expect(await balance(co.landlordId, 'guest_deposits')).toBe(0)
  })

  it('a no-show\'s money is earned on the day they were to arrive', async () => {
    const co = await ledgerCompany()
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-10-07', status: 'no_show' })
    await sale(co, { subtotal: 90, stay: { bookingId: b, toward: 90 } })
    await drainLedgerOutbox()
    expect(await earned(b)).toEqual([])
    expect(await earned(`${b}|end`)).toEqual([['2026-10-04', 90]])
  })
})

describe('the schedule itself', () => {
  it('reads source ids and splits by nights to the cent', () => {
    expect(parseBookingSourceId('8d59242e-0000-4000-8000-000000000001')).toMatchObject({ part: { kind: 'base' } })
    expect(parseBookingSourceId('8d59242e-0000-4000-8000-000000000001|end')).toMatchObject({ part: { kind: 'end' } })
    expect(parseBookingSourceId('8d59242e-0000-4000-8000-000000000001|3')).toMatchObject({ part: { kind: 'month', k: 3 } })
    expect(parseBookingSourceId('8d59242e-0000-4000-8000-000000000001|0')).toBeNull()
    expect(parseBookingSourceId('nope')).toBeNull()
    const s = staySchedule({ status: 'confirmed', check_in: '2026-01-31', check_out: '2026-05-01', booked_check_out: null,
      stay_terms: null, cancel_day: null, month_starts: ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'] }, 100_00)
    expect(s.pieces.map(p => [p.start, p.nights])).toEqual([['2026-01-31', 28], ['2026-02-28', 31], ['2026-03-31', 30], ['2026-04-30', 1]])
    expect(s.pieces.reduce((a, p) => a + p.cents, 0)).toBe(100_00)
    expect(s.unreachedCents).toBe(0)
  })
})
