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
import { checkOutFor, nightsBetween, createStayBooking, siteIsFree, bookingLeaseTypeFor, reservationDue, priceStayBySchedule, stayTaxRate, taxInside,
  wholeStayPrice, priceWholeStay, leaseDepositFor, stayExtensionQuote, extendStayByMonth, undoStayExtension, payTowardStay } from './registerStay'

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

  // 10/2 (review): the bookings CHECK knows 'month_to_month', not 'monthly' —
  // every month stay rung at the register failed on it and rolled the sale back.
  it('sells a month: on the schedule as a month-to-month stay, a calendar month long', async () => {
    const r = await sell(line('month', 1, 900), { checkIn: '2026-10-15' })
    expect(r.checkOut).toBe('2026-11-15')
    expect(r.nights).toBe(31)
    const [b] = await query<any>(`SELECT lease_type, status, total_amount::float AS total FROM unit_bookings WHERE id = $1`, [r.bookingId])
    expect(b).toMatchObject({ lease_type: 'month_to_month', status: 'confirmed', total: 900 })
    expect(bookingLeaseTypeFor('night')).toBe('nightly')
    expect(bookingLeaseTypeFor('week')).toBe('weekly')
    expect(bookingLeaseTypeFor('month')).toBe('month_to_month')
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

/**
 * 10/2 (decisions #9): what a reservation still owes is its own quoted price
 * less what was paid toward it — never re-priced by the till.
 */
describe('what a reservation still owes', () => {
  async function booking(cols: Record<string, any> = {}) {
    const r = await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type, check_in, check_out, nights, total_amount, status,
                                  deposit_amount, deposit_paid_at, balance_paid_at)
       VALUES ($1,$2,'Gina Guest','nightly','2027-05-01','2027-05-08',7,$3,$4,$5,$6,$7) RETURNING id`,
      [unitId, landlordId, cols.total ?? 280, cols.status ?? 'tentative', cols.depositAmount ?? null,
       cols.depositPaid ? new Date() : null, cols.balancePaid ? new Date() : null])
    return r[0].id
  }

  it('is the whole quote with nothing paid, the rest after a deposit, nothing once the balance is paid', async () => {
    expect(await reservationDue(db, await booking())).toMatchObject({ total: 280, paid: 0, owed: 280, paidInFull: false, closed: false, noPrice: false, nights: 7, unitNumber: 'RV 01' })
    expect(await reservationDue(db, await booking({ depositAmount: 56, depositPaid: true, status: 'confirmed' })))
      .toMatchObject({ paid: 56, owed: 224, paidInFull: false })
    // A deposit set but not paid yet is not money in.
    expect(await reservationDue(db, await booking({ depositAmount: 56 }))).toMatchObject({ paid: 0, owed: 280 })
    expect(await reservationDue(db, await booking({ depositAmount: 56, depositPaid: true, balancePaid: true })))
      .toMatchObject({ paid: 280, owed: 0, paidInFull: true })
    // Paid whole at the counter (deposit stamped with no amount): nothing left.
    expect(await reservationDue(db, await booking({ depositPaid: true, status: 'confirmed' }))).toMatchObject({ owed: 0, paidInFull: true })
  })

  it('says when there is nothing to take money for', async () => {
    expect(await reservationDue(db, await booking({ status: 'cancelled' }))).toMatchObject({ closed: true })
    expect(await reservationDue(db, await booking({ total: 0 }))).toMatchObject({ noPrice: true, paidInFull: false })
    expect(await reservationDue(db, '00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(await reservationDue(db, 'not-an-id')).toBeNull()
  })

  // 10/3 (decisions #15): a stay its lease bills is never owed whole at the register.
  // 10/5 (Nic, R3/R14): and only a stay whose lease was CHOSEN (or drafted) is
  // one — never by its length, wherever it was made, whatever the park's
  // weekly-lease setting says.
  it('a stay whose lease was chosen owes the register only its deposit; length alone never makes a lease', async () => {
    await query(`UPDATE units SET weekly_rate = 210, monthly_rate = 900 WHERE id = $1`, [unitId])
    await query(`UPDATE properties SET booking_deposit_pct = 10, booking_monthly_deposit = 150, weekly_lease_mode = TRUE WHERE id = $1`, [propertyId])
    const make = async (nights: number, total: number, terms: string | null = null, source = 'direct') => (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type, check_in, check_out, nights, total_amount, status, source, stay_terms)
       VALUES ($1,$2,'Gina Guest','month_to_month','2027-05-01', DATE '2027-05-01' + $3::int, $3, $4, 'tentative', $5, $6) RETURNING id`,
      [unitId, landlordId, nights, total, source, terms]))[0].id
    const month = await make(30, 900, 'lease')
    expect(await reservationDue(db, month)).toMatchObject({ leaseBillsRest: true, depositDue: 150, owed: 150, paidInFull: false })
    // Its deposit paid: nothing more for the register — the lease bills the rest.
    await query(`UPDATE unit_bookings SET deposit_amount = 150, deposit_paid_at = NOW() WHERE id = $1`, [month])
    expect(await reservationDue(db, month)).toMatchObject({ paid: 150, owed: 0, paidInFull: true, leaseBillsRest: true })
    // A month on the schedule with no answer, or answered "no lease", is owed whole.
    expect(await reservationDue(db, await make(30, 900))).toMatchObject({ leaseBillsRest: false, owed: 900 })
    expect(await reservationDue(db, await make(30, 900, 'stay'))).toMatchObject({ leaseBillsRest: false, owed: 900 })
    // A week at a weekly-lease park is a stay like any other (R14).
    expect(await reservationDue(db, await make(7, 210))).toMatchObject({ leaseBillsRest: false, owed: 210 })
    // A lease drafted from it bills it, whatever its answer said.
    const drafted = await make(30, 900, null, 'register')
    await query(`INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, needs_review, lease_source, source_booking_id)
                 VALUES ($1,$2,900,'month_to_month','pending','2027-05-01',TRUE,'booking_draft',$3)`, [unitId, landlordId, drafted])
    expect(await reservationDue(db, drafted)).toMatchObject({ leaseBillsRest: true, depositDue: 150, owed: 150 })
  })
})

// 10/5 (Nic, R5): "point of sale cannot prorate a stay."
describe('a stay at the register is sold whole', () => {
  it('nights, weeks and months each at their own rate — never a week or a month cut into pieces', () => {
    const rates = { nightly: 40, weekly: 210, monthly: 900 }
    // Ten nights rung as nights are ten nights — never the weekly tier × 10/7.
    expect(wholeStayPrice(rates, 10, 'night', 10, '2027-01-12')).toMatchObject({ total: 440, base: 400, tax: 40, taxRate: 0.1, nights: 10, checkOut: '2027-01-22', rate: 40 })
    expect(wholeStayPrice(rates, 10, 'week', 2, '2027-01-12')).toMatchObject({ total: 462, base: 420, tax: 42, nights: 14, tier: 'weekly' })
    // A month is the monthly rate — 31 nights from Mar 5, never the calendar
    // schedule's two prorated pieces — and the monthly tier is never taxed.
    expect(wholeStayPrice(rates, 10, 'month', 1, '2027-03-05')).toMatchObject({ total: 900, base: 900, tax: 0, nights: 31, checkOut: '2027-04-05', tier: 'monthly' })
    expect(wholeStayPrice(rates, 10, 'month', 1, '2027-02-01')).toMatchObject({ total: 900, nights: 28, tax: 0 })
    expect(wholeStayPrice(rates, 10, 'month', 2, '2027-01-15')).toMatchObject({ total: 1800, nights: 59 })
    // 30 nights rung as nights: whole nights, untaxed at 30+.
    expect(wholeStayPrice(rates, 10, 'night', 30, '2027-01-01')).toMatchObject({ total: 1200, tax: 0 })
    // No rate for what one of these is: nothing prices it.
    expect(wholeStayPrice({ nightly: 40, weekly: 210, monthly: null }, 10, 'month', 1, '2027-03-05')).toMatchObject({ total: 0, rate: null })
  })

  it('reads the site\'s rate, else the property\'s, and refuses a site with none in plain words', async () => {
    await query(`UPDATE units SET nightly_rate = 40, monthly_rate = NULL WHERE id = $1`, [unitId])
    await query(`UPDATE properties SET short_term_tax_rate = 12, monthly_rate = 950 WHERE id = $1`, [propertyId])
    expect(await priceWholeStay(db, unitId, 'night', 3, '2027-06-01')).toMatchObject({ total: 134.4, base: 120, tax: 14.4, unitNumber: 'RV 01' })
    expect(await priceWholeStay(db, unitId, 'month', 1, '2027-06-01')).toMatchObject({ total: 950, tax: 0, checkOut: '2027-07-01' })
    await query(`UPDATE properties SET monthly_rate = NULL WHERE id = $1`, [propertyId])
    await expect(priceWholeStay(db, unitId, 'month', 1, '2027-06-01'))
      .rejects.toThrow('Site RV 01 has no monthly rate set, and neither does the property, so this stay cannot be priced — nothing was charged. Set the site\'s monthly rate (or the property\'s), then press Charge again.')
  })

  it('a lease is paid its deposit — the booking site\'s deposit for the same stay, never more than the stay', async () => {
    await query(`UPDATE units SET monthly_rate = 900 WHERE id = $1`, [unitId])
    await query(`UPDATE properties SET booking_monthly_deposit = 150 WHERE id = $1`, [propertyId])
    expect(await leaseDepositFor(db, unitId, 900, 31)).toBe(150)
    await query(`UPDATE properties SET booking_monthly_deposit = 2000 WHERE id = $1`, [propertyId])
    expect(await leaseDepositFor(db, unitId, 900, 31)).toBe(900)
  })

  it('writes the counter\'s lease answer, the screening flag and a lease\'s deposit on the booking', async () => {
    const r = await withClient(async (c) => {
      await c.query('BEGIN')
      try {
        const tx = await c.query(
          `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total)
           VALUES ($1,$2,$3,'cash',0,0,0) RETURNING id`, [landlordId, propertyId, userId])
        const out = await createStayBooking(c, {
          landlordId, propertyId, posTransactionId: tx.rows[0].id, lines: line('month', 1, 900),
          details: { ...guest, unitId, guestEmail: 'dale@t.dev' }, stayTerms: 'lease', screeningRequired: true, depositAmount: 150,
        })
        await c.query('COMMIT')
        return out
      } catch (e) { await c.query('ROLLBACK'); throw e }
    })
    const [b] = await query<any>(`SELECT stay_terms, screening_required, deposit_amount::float AS deposit, total_amount::float AS total FROM unit_bookings WHERE id = $1`, [r.bookingId])
    expect(b).toEqual({ stay_terms: 'lease', screening_required: true, deposit: 150, total: 900 })
    expect(await reservationDue(db, r.bookingId)).toMatchObject({ leaseBillsRest: true, paid: 150, owed: 0 })
  })
})

// 10/5 (Nic, R6): "Add a month" lengthens the stay that is here now.
describe('adding a month to the stay here now', () => {
  async function paidStay(cols: Record<string, any> = {}) {
    await query(`UPDATE units SET monthly_rate = 900 WHERE id = $1`, [unitId])
    return (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, booked_check_out, nights,
                                  total_amount, status, source, deposit_paid_at, balance_billed_at, balance_paid_at, stay_terms)
       VALUES ($1,$2,'Dale Carter','dale@t.dev','month_to_month','2027-05-05','2027-06-05','2027-06-05',31,900,$3,'register',NOW(),NOW(),$4,$5) RETURNING id`,
      [unitId, landlordId, cols.status ?? 'checked_in', cols.balancePaid === false ? null : new Date(), cols.terms ?? null]))[0].id
  }
  const extend = (bookingId: string) => withClient(async (c) => {
    await c.query('BEGIN')
    try { const r = await extendStayByMonth(c, { landlordId, propertyId, bookingId }); await c.query('COMMIT'); return r }
    catch (e) { await c.query('ROLLBACK'); throw e }
  })

  it('moves the same booking\'s check-out a calendar month, prices the month on its own, and leaves the month owed until it is paid', async () => {
    const b = await paidStay()
    const q = await stayExtensionQuote(db, { landlordId, propertyId, bookingId: b })
    expect(q).toMatchObject({ fromCheckOut: '2027-06-05', checkOut: '2027-07-05', addedNights: 30, nights: 61, price: 900, paidBefore: 900 })
    await extend(b)
    const [row] = await query<any>(`SELECT check_out::text, booked_check_out::text, nights, total_amount::float AS total, deposit_amount::float AS deposit, balance_paid_at FROM unit_bookings WHERE id = $1`, [b])
    expect(row).toMatchObject({ check_out: '2027-07-05', booked_check_out: '2027-07-05', nights: 61, total: 1800, deposit: 900, balance_paid_at: null })
    expect(await reservationDue(db, b)).toMatchObject({ total: 1800, paid: 900, owed: 900 })
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(1)   // the same row — never a second stay
    // Paid at the counter: the month is paid and the stay is paid whole again.
    await withClient(async (c) => {
      await c.query('BEGIN')
      const tx = await c.query(
        `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total)
         VALUES ($1,$2,$3,'cash',900,0,900) RETURNING id`, [landlordId, propertyId, userId])
      await payTowardStay(c, { bookingId: b, saleId: tx.rows[0].id, amount: 900 })
      await c.query('COMMIT')
    })
    expect(await reservationDue(db, b)).toMatchObject({ paid: 1800, owed: 0, paidInFull: true })
  })

  it('is refused when the site is taken for any night of that month, and nothing changes', async () => {
    const b = await paidStay()
    await query(`INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type, check_in, check_out, nights, total_amount, status)
                 VALUES ($1,$2,'Next Guest','nightly','2027-06-20','2027-06-22',2,80,'confirmed')`, [unitId, landlordId])
    await expect(extend(b)).rejects.toThrow('Site RV 01 is not free for the whole month from June 5, 2027 to July 5, 2027 — someone else has it for some of those nights, so the stay cannot be lengthened there. Nothing was charged. Ring a new stay on another site instead.')
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-06-05', total: 900, owed: 0 })
  })

  it('is refused for a stay with a lease, an unpaid one, or one that still owes', async () => {
    await expect(stayExtensionQuote(db, { landlordId, propertyId, bookingId: await paidStay({ terms: 'lease' }) }))
      .rejects.toThrow(/has a lease — the lease holds the site/)
    await query(`DELETE FROM unit_bookings`)
    await expect(stayExtensionQuote(db, { landlordId, propertyId, bookingId: await paidStay({ status: 'tentative' }) }))
      .rejects.toThrow(/not paid yet/)
    await query(`DELETE FROM unit_bookings`)
    const owes = await paidStay({ balancePaid: false })
    await query(`UPDATE unit_bookings SET deposit_amount = 400 WHERE id = $1`, [owes])
    await expect(stayExtensionQuote(db, { landlordId, propertyId, bookingId: owes })).rejects.toThrow(/still owes \$500\.00/)
  })

  it('a month nobody paid for is given back — only while nothing was paid toward it', async () => {
    const b = await paidStay()
    const ext = await extend(b)
    expect(await withClient((c) => undoStayExtension(c, ext))).toBe(true)
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-06-05', total: 900, paid: 900, owed: 0, paidInFull: true })
    const again = await extend(b)
    await query(`UPDATE unit_bookings SET deposit_amount = 1800 WHERE id = $1`, [b])
    expect(await withClient((c) => undoStayExtension(c, again))).toBe(false)
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-07-05' })
  })
})

// 10/3 (decisions #9, #21): a new stay is priced the way the schedule prices it.
describe('pricing a stay by the schedule', () => {
  it('tiers by length from the site\'s rates (else the property\'s), adds the short-term tax under 30 nights, and refuses a site with no rate', async () => {
    await query(`UPDATE units SET nightly_rate = 40, weekly_rate = 210 WHERE id = $1`, [unitId])
    await query(`UPDATE properties SET short_term_tax_rate = 10, monthly_rate = 900 WHERE id = $1`, [propertyId])
    expect(await priceStayBySchedule(db, unitId, '2027-01-12', '2027-01-14')).toMatchObject({ total: 88, nights: 2, tier: 'nightly' })
    expect(await priceStayBySchedule(db, unitId, '2027-01-12', '2027-01-19')).toMatchObject({ total: 231, nights: 7, tier: 'weekly' })
    // 30+ nights: the property's monthly rate on the calendar schedule, untaxed.
    expect(await priceStayBySchedule(db, unitId, '2027-03-01', '2027-04-01')).toMatchObject({ total: 900, nights: 31, tier: 'monthly' })
    await query(`UPDATE units SET nightly_rate = NULL, weekly_rate = NULL WHERE id = $1`, [unitId])
    await query(`UPDATE properties SET monthly_rate = NULL WHERE id = $1`, [propertyId])
    await expect(priceStayBySchedule(db, unitId, '2027-01-12', '2027-01-14')).rejects.toThrow(/has no stay rate set, so this stay cannot be priced — nothing was changed/)
  })
})

// 10/3 (decisions #21): the tax inside a stay's price — the part a sale records as tax.
describe('the lodging tax inside a stay\'s price', () => {
  it('is the short-term rate for a nightly or weekly stay under 30 nights, and nothing for a month; priceStayBySchedule says how much', async () => {
    const rates = { nightly: 40, weekly: 210, monthly: 900 }
    expect(stayTaxRate(rates, 10, 2)).toBe(0.1)
    expect(stayTaxRate(rates, 10, 7)).toBe(0.1)
    expect(stayTaxRate(rates, 10, 30)).toBe(0)
    expect(stayTaxRate({ nightly: null, weekly: null, monthly: 900 }, 10, 10)).toBe(0)   // priced on the monthly schedule, untaxed
    expect(stayTaxRate(rates, 0, 2)).toBe(0)
    expect(taxInside(88, 0.1)).toBe(8)
    expect(taxInside(254.1, 0.1)).toBe(23.1)
    expect(taxInside(50, 0)).toBe(0)
    await query(`UPDATE units SET nightly_rate = 40, weekly_rate = 210 WHERE id = $1`, [unitId])
    await query(`UPDATE properties SET short_term_tax_rate = 10, monthly_rate = 900 WHERE id = $1`, [propertyId])
    expect(await priceStayBySchedule(db, unitId, '2027-01-12', '2027-01-14')).toMatchObject({ total: 88, base: 80, tax: 8, taxRate: 0.1 })
    expect(await priceStayBySchedule(db, unitId, '2027-03-01', '2027-04-01')).toMatchObject({ total: 900, base: 900, tax: 0, taxRate: 0 })
  })
})
