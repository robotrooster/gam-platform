/**
 * S649 (Nic): "if somebody pays a 10% deposit on a week long stay, the other
 * 90% needs to generate on the day they're due to arrive."
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailPayLinkMock, readSaleCardMock } = vi.hoisted(() => ({
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
  // finalizePayLink asks Stripe which card paid the link (to file the card on
  // the register customer). These stays are paid by a guest with no register
  // record, and a test run must never reach Stripe — without this mock every
  // paid balance logged "[pay-link] could not read the card it was paid with".
  readSaleCardMock: vi.fn(async (_pi: string): Promise<any> => null),
}))
vi.mock('./email', async (orig) => ({ ...(await orig() as any), emailPayLink: emailPayLinkMock }))
vi.mock('./posCustomerCards', async (orig) => ({ ...(await orig() as any), readSaleCard: readSaleCardMock }))

import { processingFeeFor } from '@gam/shared'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { billStayBalances } from './stayBalance'
import { finalizePayLink, payLinkCharge } from '../routes/posPayLinks'

beforeEach(async () => {
  await cleanupAllSchema()
  emailPayLinkMock.mockClear()
  readSaleCardMock.mockClear()
})

const NOW = new Date('2026-10-05T15:00:00Z')  // Oct 5, 8am in Phoenix

async function seedStay(opts: { checkIn?: string; checkOut?: string; payer?: 'customer' | 'landlord'; lease?: boolean } = {}) {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE users SET stripe_connect_account_id = 'acct_stay' WHERE id = $1`, [userId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix', booking_card_fee_payer = $2 WHERE id = $1`,
      [propertyId, opts.payer ?? 'customer'])
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const { rows: [b] } = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out,
                                  nights, total_amount, deposit_amount, deposit_paid_at, status, source)
       VALUES ($1, $2, 'Pat Guest', 'pat@guest.dev', 'weekly', $3, $4, 7, 700, 70, NOW(), 'confirmed', 'public')
       RETURNING id`,
      [unitId, landlordId, opts.checkIn ?? '2026-10-05', opts.checkOut ?? '2026-10-12'])
    return { landlordId, propertyId, unitId, bookingId: b.id }
  } finally { c.release() }
}

/**
 * 10/20 — A SEASON IS NOT A BILL.
 *
 * Nic's own numbers, off the schedule he is bringing over from the old system:
 * 92 nights at Mountain View, March 6 to June 6, $1,767 for the season, $150
 * handed over in cash long before GAM existed. The confirmation quotes him the
 * FIRST MONTH, $589 (services/bookingConfirmation — "if they're seasonal and
 * going to be here more than the 30 days, I just want it to tell them the first
 * month's rate"). Before the fix, arrival morning emailed him a card page for
 * $1,617 — the whole season less his deposit — and nobody had pressed anything.
 */
async function seedSeason(
  opts: { total?: number; deposit?: number; checkOut?: string; bookedCheckOut?: string | null } = {},
) {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE users SET stripe_connect_account_id = 'acct_season' WHERE id = $1`, [userId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    // Mountain View's own rate card: $49 a night, $269 a week, $589 a month.
    await c.query(
      `UPDATE properties
          SET name = 'Mountain View RV Park', timezone = 'America/Phoenix',
              booking_card_fee_payer = 'customer', short_term_tax_rate = 6.6,
              nightly_rate = 49, weekly_rate = 269, monthly_rate = 589
        WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    await c.query(`UPDATE units SET nightly_rate = 49, weekly_rate = 269, monthly_rate = 589 WHERE id = $1`, [unitId])
    const checkOut = opts.checkOut ?? '2027-06-06'
    const { rows: [b] } = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type,
                                  check_in, check_out, booked_check_out, nights,
                                  total_amount, deposit_amount, deposit_paid_at, status, source)
       VALUES ($1, $2, 'Hal Brenner', 'hal@guest.dev', 'month_to_month',
               '2027-03-06', $3::date, $4::date, ($3::date - '2027-03-06'::date),
               $5, $6, NOW(), 'confirmed', 'direct')
       RETURNING id`,
      [unitId, landlordId, checkOut,
       opts.bookedCheckOut === undefined ? checkOut : opts.bookedCheckOut,
       opts.total ?? 1767, opts.deposit ?? 150])
    return { landlordId, propertyId, unitId, bookingId: b.id }
  } finally { c.release() }
}

/** Arrival morning at Mountain View — 8am March 6, Phoenix (UTC-7 all year). */
const SEASON_ARRIVAL = new Date('2027-03-06T15:00:00Z')

describe('a seasonal stay owes its first month on arrival, not the season', () => {
  it('bills the first month less the deposit, never the whole season', async () => {
    const s = await seedSeason()
    expect((await billStayBalances(SEASON_ARRIVAL)).billed).toBe(1)
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
    // $589 for March 6 → April 6, less the $150 he already handed over. NOT
    // $1,617, which is what the whole season less the deposit comes to.
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ to: 'hal@guest.dev', amount: 439 })
    // And it says so, so the card page cannot read as the whole stay.
    expect(emailPayLinkMock.mock.calls[0][0].label).toContain('First month')
    expect(emailPayLinkMock.mock.calls[0][0].label).toContain('April 6, 2027')
    const { rows: [link] } = await db.query<any>(
      `SELECT total::float AS total FROM pos_pay_links WHERE booking_id = $1`, [s.bookingId])
    expect(link.total).toBe(439)
  })

  it('never asks for more than the season was sold for', async () => {
    // A season Nic priced himself, flat, under the rate card's month. The rate
    // card does not get to charge more than the stay costs in total.
    await seedSeason({ total: 400, deposit: 40 })
    expect((await billStayBalances(SEASON_ARRIVAL)).billed).toBe(1)
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ amount: 360 })
  })

  it('reads the stored check-out when nothing says what it was sold for', async () => {
    // booked_check_out empty: the length is the stored check-out
    // (registerStay soldCheckOutSql reads NULL as check_out), so this is still
    // a 92-night stay and still owes one month.
    await seedSeason({ bookedCheckOut: null })
    expect((await billStayBalances(SEASON_ARRIVAL)).billed).toBe(1)
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ amount: 439 })
  })

  it('a site with no rate card to price a month by is not billed the season instead', async () => {
    const s = await seedSeason()
    await db.query(`UPDATE units SET nightly_rate = NULL, weekly_rate = NULL, monthly_rate = NULL WHERE id = $1`, [s.unitId])
    await db.query(`UPDATE properties SET nightly_rate = NULL, weekly_rate = NULL, monthly_rate = NULL WHERE id = $1`, [s.propertyId])
    expect((await billStayBalances(SEASON_ARRIVAL)).billed).toBe(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
    const { rows: [b] } = await db.query<any>(`SELECT balance_billed_at FROM unit_bookings WHERE id = $1`, [s.bookingId])
    expect(b.balance_billed_at).toBeNull()
  })
})

describe('the rest of a short stay, on arrival day', () => {
  it('emails the guest a link for the balance on arrival day, once', async () => {
    const s = await seedStay()
    expect((await billStayBalances(NOW)).billed).toBe(1)
    expect((await billStayBalances(NOW)).billed).toBe(0)
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
    const fee = processingFeeFor({ amount: 630, paymentMethod: 'card' })
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ to: 'pat@guest.dev', amount: 630, cardFee: fee })
    const { rows: [b] } = await db.query<any>(`SELECT balance_billed_at, balance_pay_link_id FROM unit_bookings WHERE id = $1`, [s.bookingId])
    expect(b.balance_billed_at).not.toBeNull()
    expect(b.balance_pay_link_id).not.toBeNull()
  })

  it('does not bill before arrival day', async () => {
    await seedStay({ checkIn: '2026-10-06', checkOut: '2026-10-13' })
    expect((await billStayBalances(NOW)).billed).toBe(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
  })

  it('leaves longer stays to their lease', async () => {
    const s = await seedStay({ checkOut: '2026-11-20' })
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, end_date, rent_amount, lease_source, source_booking_id)
       VALUES ($1, $2, 'pending', 'month_to_month', '2026-10-05', '2026-11-20', 950, 'booking_draft', $3)`,
      [s.unitId, s.landlordId, s.bookingId])
    expect((await billStayBalances(NOW)).billed).toBe(0)
  })

  // 10/5 (Nic, review M13): a stay whose guest chose a lease is billed by
  // that lease — even before (or if) its draft lease is written.
  it('never bills the rest of a stay that answered lease, with or without its lease drafted', async () => {
    const s = await seedStay({ checkOut: '2026-11-20' })
    await db.query(`UPDATE unit_bookings SET stay_terms = 'lease', lease_type = 'month_to_month', nights = 46, total_amount = 1400 WHERE id = $1`, [s.bookingId])
    expect((await billStayBalances(NOW)).billed).toBe(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
    const { rows: [b] } = await db.query<any>(`SELECT balance_billed_at FROM unit_bookings WHERE id = $1`, [s.bookingId])
    expect(b.balance_billed_at).toBeNull()
  })

  it('follows the property when it absorbs the card fee, and marks the balance paid', async () => {
    const s = await seedStay({ payer: 'landlord' })
    await billStayBalances(NOW)
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ amount: 630, cardFee: 0 })
    const { rows: [b] } = await db.query<any>(`SELECT balance_pay_link_id FROM unit_bookings WHERE id = $1`, [s.bookingId])
    const r = await finalizePayLink({ id: 'cs_bal', amount_total: 63000, payment_intent: 'pi_bal',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: b.balance_pay_link_id } })
    expect(r.recorded).toBe(true)
    const { rows: [after] } = await db.query<any>(`SELECT balance_paid_at, status FROM unit_bookings WHERE id = $1`, [s.bookingId])
    expect(after.balance_paid_at).not.toBeNull()
    expect(after.status).toBe('confirmed')
    const { rows: [h] } = await db.query<any>(`SELECT amount FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])
    expect(Number(h.amount)).toBe(payLinkCharge(630, 'landlord').held)
  })

  // 10/2 (review): a stay paid IN FULL — on its pay link, or rung at the
  // register — has no deposit on record, and the arrival-day run billed the
  // whole stay a second time. A stay paid in full has nothing left to bill.
  it('a stay paid in full on its pay link is not billed again on arrival day', async () => {
    const s = await seedStay()
    // The stay a pay link held: no deposit, unpaid — then paid online in full.
    await db.query(`UPDATE unit_bookings SET deposit_amount = NULL, deposit_paid_at = NULL, status = 'tentative', total_amount = 700 WHERE id = $1`, [s.bookingId])
    const { rows: [cat] } = await db.query<{ id: string }>(`INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Stays') RETURNING id`, [s.landlordId])
    const { rows: [stay] } = await db.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price, stock_qty, stock_min, stock_max, tax_rate, stay_unit)
       VALUES ($1, $2, $3, 'RV site — nightly', 0, 0, 999, 0, 999, 0, 'night') RETURNING id`, [s.landlordId, s.propertyId, cat.id])
    const { rows: [link] } = await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, booking_id, card_fee_on_top)
       VALUES (md5(random()::text) || md5(random()::text), $1, $2, (SELECT user_id FROM landlords WHERE id = $1), 'one_time', 'RV site — nightly',
               $3::jsonb, 700, 700, 'pat@guest.dev', $4, FALSE) RETURNING id`,
      [s.landlordId, s.propertyId, JSON.stringify([{ id: stay.id, name: 'RV site — nightly', qty: 7, price: 100, tax: 0 }]), s.bookingId])
    const r = await finalizePayLink({ id: 'cs_full', amount_total: Math.round(payLinkCharge(700, 'landlord').charged * 100), payment_intent: 'pi_full',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id } })
    expect(r.recorded).toBe(true)
    const { rows: [b] } = await db.query<any>(`SELECT status, deposit_paid_at, pos_transaction_id, balance_paid_at FROM unit_bookings WHERE id = $1`, [s.bookingId])
    expect(b.status).toBe('confirmed')
    expect(b.deposit_paid_at).not.toBeNull()
    expect(b.pos_transaction_id).not.toBeNull()
    expect(b.balance_paid_at).not.toBeNull()
    expect((await billStayBalances(NOW)).billed).toBe(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
  })

  it('a deposit link still leaves the balance to bill on arrival day', async () => {
    const s = await seedStay()
    await db.query(`UPDATE unit_bookings SET deposit_paid_at = NULL, status = 'tentative' WHERE id = $1`, [s.bookingId])
    const { rows: [link] } = await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, booking_id, card_fee_on_top)
       VALUES (md5(random()::text) || md5(random()::text), $1, $2, (SELECT user_id FROM landlords WHERE id = $1), 'one_time', 'Reservation deposit',
               $3::jsonb, 70, 70, 'pat@guest.dev', $4, FALSE) RETURNING id`,
      [s.landlordId, s.propertyId, JSON.stringify([{ id: null, name: 'Reservation deposit', qty: 1, price: 70, tax: 0 }]), s.bookingId])
    expect((await finalizePayLink({ id: 'cs_dep', amount_total: Math.round(payLinkCharge(70, 'landlord').charged * 100), payment_intent: 'pi_dep',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id } })).recorded).toBe(true)
    expect((await billStayBalances(NOW)).billed).toBe(1)
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ amount: 630 })
  })
})
