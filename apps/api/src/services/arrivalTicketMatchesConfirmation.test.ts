/**
 * 10/20 (defect) — THE ARRIVAL TICKET IS THE FIGURE THE CONFIRMATION QUOTED.
 *
 * Two files answer "what does this reservation owe right now": the email a
 * person presses send on (services/bookingConfirmation) and the run that raises
 * the ticket on the morning the guest turns up (services/stayBalance). They are
 * allowed to word it differently. They are not allowed to come to different
 * money, and every version of them disagreeing is the same accident:
 *
 *   "If they're seasonal and going to be here more than the 30 days, I just
 *    want it to tell them the first month's rate."
 *
 * A seasonal guest was quoted $589 and billed $1,467 three weeks later. That
 * was fixed on both sides — but only one side learned the rest of the lesson.
 * The confirmation asks, before it carves a month out of the rate card, whether
 * the card priced THIS stay; Nic's board is full of reservations it did not
 * price, imported straight across out of the old system at a figure of their
 * own. The arrival run never asked, so a 92-night season sold for $1,767 on a
 * site carrying nothing but a $49 nightly rate was quoted $1,767 ("the rest is
 * due when you arrive") and then billed the card's own idea of a first month —
 * $1,519, a figure no door had ever shown anybody, with the $248 difference
 * left for nothing at all to bill.
 *
 * So this file does not test either side's wording. It presses send, runs
 * arrival morning, and checks that the money agrees: what the ticket asks for
 * is what the confirmation said, less what the guest has already handed over.
 * It drives the production path both ways round (loadConfirmationBooking →
 * sendBookingConfirmation, then billStayBalances) rather than the arithmetic on
 * its own, because the arithmetic has never been the part that drifted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The arrival ticket's own email. Counted, never sent.
const { emailPayLinkMock } = vi.hoisted(() => ({
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('./email', async (orig) => ({ ...(await orig() as any), emailPayLink: emailPayLinkMock }))

import { getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { billStayBalances } from './stayBalance'
import { loadConfirmationBooking, sendBookingConfirmation } from './bookingConfirmation'

beforeEach(async () => {
  await cleanupAllSchema()
  emailPayLinkMock.mockClear()
})

/** Arrival morning at Mountain View — 8am March 6, Phoenix (UTC-7 all year). */
const ARRIVAL = new Date('2027-03-06T15:00:00Z')

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

interface Rates { nightly: number | null; weekly: number | null; monthly: number | null }

/**
 * Hal Brenner's season: 92 nights at Mountain View, March 6 to June 6, with his
 * deposit handed over in cash long before GAM existed — so the money is in,
 * nothing was processed, and the arrival run has a balance to raise.
 */
async function seedSeason(o: { rates: Rates; total: number; deposit: number }) {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE users SET stripe_connect_account_id = 'acct_season' WHERE id = $1`, [userId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(
      `UPDATE properties
          SET name = 'Mountain View RV Park', timezone = 'America/Phoenix',
              booking_card_fee_payer = 'customer', short_term_tax_rate = 6.6,
              booking_deposit_pct = 10, booking_monthly_deposit = NULL,
              nightly_rate = $2, weekly_rate = $3, monthly_rate = $4
        WHERE id = $1`,
      [propertyId, o.rates.nightly, o.rates.weekly, o.rates.monthly])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    await c.query(
      `UPDATE units SET nightly_rate = $2, weekly_rate = $3, monthly_rate = $4 WHERE id = $1`,
      [unitId, o.rates.nightly, o.rates.weekly, o.rates.monthly])
    const { rows: [b] } = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type,
                                  check_in, check_out, booked_check_out, nights,
                                  total_amount, deposit_amount, deposit_paid_at, status, source)
       VALUES ($1, $2, 'Hal Brenner', 'hal@mailer-test.co', 'month_to_month',
               '2027-03-06', '2027-06-06', '2027-06-06', 92, $3, $4, NOW(), 'confirmed', 'direct')
       RETURNING id`,
      [unitId, landlordId, o.total, o.deposit])
    return { landlordId, propertyId, unitId, bookingId: b.id }
  } finally { c.release() }
}

const FULL_CARD: Rates = { nightly: 49, weekly: 269, monthly: 589 }

const SEASONS = [
  {
    what: 'a season the rate card priced',
    // Three months at Nic's $589. The card set this price, so the card is
    // allowed to carve its own first month out of it.
    rates: FULL_CARD, total: 1767, deposit: 150,
    quoted: 589, firstMonthOnly: true,
  },
  {
    what: 'a season Nic priced himself, flat, under the card\'s month',
    rates: FULL_CARD, total: 400, deposit: 40,
    quoted: 400, firstMonthOnly: false,
  },
  {
    what: 'a season imported onto a site with nothing but a nightly rate',
    // The one that was wrong: the card prices these 92 nights at $4,508, so it
    // never priced this stay, and its $1,519 "first month" belongs to a
    // different reservation than the guest booked.
    rates: { nightly: 49, weekly: null, monthly: null }, total: 1767, deposit: 150,
    quoted: 1767, firstMonthOnly: false,
  },
] as const

describe('what the confirmation quotes is what arrival morning bills', () => {
  for (const s of SEASONS) {
    it(`agrees to the cent — ${s.what}`, async () => {
      const seeded = await seedSeason(s)

      // Somebody presses send. This is the figure the guest reads.
      const booking = await loadConfirmationBooking(seeded.bookingId)
      const sent = await sendBookingConfirmation(booking!, null)
      expect(sent.figures.amount).toBe(s.quoted)
      expect(sent.figures.firstMonthOnly).toBe(s.firstMonthOnly)
      // His cash deposit is in, so the email says so instead of asking again.
      expect(sent.paid).toEqual({ kind: 'deposit', amount: s.deposit })
      expect(sent.deposit).toBeNull()

      // Arrival morning. This is the figure the card page charges.
      expect((await billStayBalances(ARRIVAL)).billed).toBe(1)
      expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
      expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({
        to: 'hal@mailer-test.co',
        amount: round2(s.quoted - s.deposit),
      })
    })
  }
})
