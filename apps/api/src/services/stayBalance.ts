/**
 * S649 (Nic) — the rest of a short stay, billed on arrival day.
 *
 *   "If somebody pays a 10% deposit on a week long stay, the other 90% needs to
 *    generate on the day they're due to arrive."
 *
 * A stay with no lease had nothing that billed what was left after the
 * deposit. On the
 * morning of arrival the guest is emailed a pay link for the balance — the same
 * pay-link machinery as the register, so the money lands with GAM and is held
 * for the landlord's weekly payout, and the card fee follows the property's
 * booking-site setting.
 *
 * Longer stays are not billed here: their booking lease bills the rest of the
 * arrival month on arrival day and monthly after that — never the whole stay up
 * front. 10/5 (Nic): nor is a stay whose guest chose a lease (stay_terms
 * 'lease'); a no-lease stay of 30+ nights is booked and paid a month at a time,
 * so the whole stay is never what it owes on the day it arrives.
 *
 * ── 10/20: A SEASON IS NOT A BILL ───────────────────────────────────────────
 *
 * That last sentence used to be an ASSUMPTION rather than a rule. This job
 * billed `total_amount` less the deposit, and it got away with it only because
 * the booking site was the one door that had ever written a no-lease 30+ night
 * stay — and it writes ONE MONTH into both the check-out and the total, so
 * there was never anything left over to get wrong.
 *
 * The reservations Nic is bringing over from his old system are not like that.
 * They hold the WHOLE season on the board, because they have to: those guests
 * were promised those dates and several were promised a particular site. So
 * their `total_amount` is the whole season's price, and billing it less the
 * deposit emailed a seasonal guest a card page for $1,617 on the morning they
 * pulled in — after the confirmation had quoted them $589 and nobody had
 * pressed anything.
 *
 *   "If they're seasonal and going to be here more than the 30 days, I just
 *    want it to tell them the first month's rate."
 *
 * So what is due on arrival is no longer read off the stored total. For a stay
 * of 30+ nights it is the same first month the booking site sells and the
 * confirmation quotes (propertyBookingQuote soldStayFirstMonth — ONE definition
 * of what a long stay owes right now, which is the whole point of putting it
 * there), less whatever has already been paid. A booking-site stay is untouched
 * by this: its first month IS its total, so it still comes to nothing left to
 * bill. Later months are added the way every other month is — at the counter,
 * on a pay link, or "Add a month" on the schedule.
 *
 * 10/20 (defect) — AND THAT ANSWER IS NOT ALWAYS A MONTH. Asking the rate card
 * for a month of a season the card never priced gives a figure belonging to a
 * different reservation: the card's month of an imported $1,767 season on a
 * site carrying only a $49 nightly rate is $1,519, which is what this run
 * emailed while the confirmation was quoting the guest $1,767 — and nothing,
 * ever, billed the $248 between them. The two read one answer now, so a guest
 * is only ever asked for the figure he was shown.
 *
 * The length that decides it is the length the stay was SOLD for (the booked
 * check-out, registerStay soldCheckOutSql), never a shortened stored check-out
 * — a guest who left early does not retroactively become a short stay.
 */
import { DateTime } from 'luxon'
import { longCalendarDate } from '@gam/shared'
import { query } from '../db'
import { logger } from '../lib/logger'
import { createStayBalanceLink } from '../routes/posPayLinks'
import { soldStayFirstMonth } from './propertyBookingQuote'
import { soldCheckOutSql } from './registerStay'

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export async function billStayBalances(now: Date = new Date()): Promise<{ billed: number; failed: number }> {
  // Arrival day in each property's own time zone; yesterday too, so a missed
  // run still catches up — but never older stays, which were handled by hand
  // before this existed.
  const rows = await query<{
    id: string; landlord_id: string; property_id: string; timezone: string; unit_number: string
    property_name: string; guest_name: string | null; guest_email: string
    check_in: string; check_out: string; sold_check_out: string
    total_amount: string; deposit_amount: string | null
    nightly_rate: string | null; weekly_rate: string | null; monthly_rate: string | null
  }>(
    `SELECT b.id, b.landlord_id, u.property_id, p.timezone, u.unit_number, p.name AS property_name,
            b.guest_name, b.guest_email,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            to_char(${soldCheckOutSql('b')}, 'YYYY-MM-DD') AS sold_check_out,
            b.total_amount::text, b.deposit_amount::text,
            -- The site's own rate card, else the property's — the same fallback
            -- every other door prices a stay from (bookingConfirmation ratesOf).
            COALESCE(u.nightly_rate, p.nightly_rate)::text AS nightly_rate,
            COALESCE(u.weekly_rate,  p.weekly_rate)::text  AS weekly_rate,
            COALESCE(u.monthly_rate, p.monthly_rate)::text  AS monthly_rate
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.status IN ('confirmed', 'checked_in')
        AND b.deposit_paid_at IS NOT NULL
        AND b.balance_billed_at IS NULL
        AND b.guest_email IS NOT NULL
        -- A cheap prefilter only: what is actually due is worked out below, and
        -- it is never more than the whole stay, so a stay already paid past its
        -- total has nothing due however long it is.
        AND b.total_amount > COALESCE(b.deposit_amount, 0)
        -- 10/5 (Nic, R2/R4): a stay that answered 'lease' is billed by its
        -- lease, never here — even while that lease is still being drafted
        -- (or its draft failed and a person must redo it).
        AND b.stay_terms IS DISTINCT FROM 'lease'
        AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id)`)
  let billed = 0, failed = 0
  for (const b of rows) {
    const today = DateTime.fromJSDate(now).setZone(b.timezone || 'America/Phoenix').toISODate()!
    const yesterday = DateTime.fromISO(today).minus({ days: 1 }).toISODate()!
    if (b.check_in !== today && b.check_in !== yesterday) continue
    if (b.check_out <= today) continue

    const soldOut = b.sold_check_out || b.check_out
    const total = round2(Number(b.total_amount))
    const paid = round2(Number(b.deposit_amount ?? 0))
    // 10/20: a stay of 30+ nights owes its FIRST MONTH now, not the season —
    // and what that month is (or whether there is one at all) is the ONE answer
    // the confirmation quotes from, so the ticket cannot ask for a figure the
    // guest was never shown (propertyBookingQuote soldStayFirstMonth).
    const owed = soldStayFirstMonth({
      checkIn: b.check_in, checkOut: soldOut, soldTotal: total,
      rates: {
        nightly: b.nightly_rate == null ? null : Number(b.nightly_rate),
        weekly: b.weekly_rate == null ? null : Number(b.weekly_rate),
        monthly: b.monthly_rate == null ? null : Number(b.monthly_rate),
      },
    })
    if (owed.kind === 'unpriceable') {
      // No rate on the site or the property can price a month of it, so GAM
      // does not know what this guest owes today — and the one thing it must
      // not do is fall back to the whole season. Said out loud so the office
      // takes it at the counter rather than nobody finding out.
      logger.warn({ bookingId: b.id, propertyId: b.property_id },
        '[stay-balance] 30+ night stay has no monthly/weekly/nightly rate to price its first month — nothing billed')
      continue
    }
    const month = owed.kind === 'month' ? owed : null
    // 10/20 (defect): 'whole_stay' is a 30+ night season the rate card never
    // priced — a figure Nic typed or imported — and the card's own month is a
    // different stay's money. The card page asks for what the confirmation told
    // this guest: the price the season was sold at, less what is already in. It
    // billed the card's $1,519 "first month" of a $1,767 season against a
    // confirmation quoting $1,767, and the $248 between them was billed by
    // nothing, ever.
    const dueNow = month ? month.amount : total
    const balance = round2(dueNow - paid)
    // Already covered by what they paid ahead (this is every booking-site 30+
    // night stay, whose first month and whose total are the same figure).
    if (balance <= 0.004) continue
    const label = month
      ? `First month${paid > 0 ? ', less your deposit' : ''} — ${b.property_name}, site ${b.unit_number}`
        + ` (through ${longCalendarDate(month.checkOut)})`
      : `Stay balance — ${b.property_name}, site ${b.unit_number} (${b.check_in} to ${b.check_out})`
    try {
      await createStayBalanceLink({
        bookingId: b.id, landlordId: b.landlord_id, propertyId: b.property_id,
        label,
        amount: balance, guestName: b.guest_name, guestEmail: b.guest_email,
      })
      billed++
    } catch (e) {
      failed++
      logger.error({ err: e, bookingId: b.id }, '[stay-balance] could not bill the balance')
    }
  }
  return { billed, failed }
}
