/**
 * S649 (Nic) — the rest of a short stay, billed on arrival day.
 *
 *   "If somebody pays a 10% deposit on a week long stay, the other 90% needs to
 *    generate on the day they're due to arrive."
 *
 * A stay under the lease threshold (30 nights, or 7 at a weekly-lease park) has
 * no lease, so nothing ever billed what was left after the deposit. On the
 * morning of arrival the guest is emailed a pay link for the balance — the same
 * pay-link machinery as the register, so the money lands with GAM and is held
 * for the landlord's weekly payout, and the card fee follows the property's
 * booking-site setting.
 *
 * Longer stays are not billed here: their booking lease bills the rest of the
 * arrival month on arrival day and monthly after that — never the whole stay up
 * front.
 */
import { DateTime } from 'luxon'
import { query } from '../db'
import { logger } from '../lib/logger'
import { createStayBalanceLink } from '../routes/posPayLinks'

export async function billStayBalances(now: Date = new Date()): Promise<{ billed: number; failed: number }> {
  // Arrival day in each property's own time zone; yesterday too, so a missed
  // run still catches up — but never older stays, which were handled by hand
  // before this existed.
  const rows = await query<{
    id: string; landlord_id: string; property_id: string; timezone: string; unit_number: string
    property_name: string; guest_name: string | null; guest_email: string
    check_in: string; check_out: string; total_amount: string; deposit_amount: string | null
  }>(
    `SELECT b.id, b.landlord_id, u.property_id, p.timezone, u.unit_number, p.name AS property_name,
            b.guest_name, b.guest_email,
            to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.total_amount::text, b.deposit_amount::text
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.status IN ('confirmed', 'checked_in')
        AND b.deposit_paid_at IS NOT NULL
        AND b.balance_billed_at IS NULL
        AND b.guest_email IS NOT NULL
        AND b.total_amount > COALESCE(b.deposit_amount, 0)
        AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id)`)
  let billed = 0, failed = 0
  for (const b of rows) {
    const today = DateTime.fromJSDate(now).setZone(b.timezone || 'America/Phoenix').toISODate()!
    const yesterday = DateTime.fromISO(today).minus({ days: 1 }).toISODate()!
    if (b.check_in !== today && b.check_in !== yesterday) continue
    if (b.check_out <= today) continue
    const balance = Math.round((Number(b.total_amount) - Number(b.deposit_amount ?? 0)) * 100) / 100
    try {
      await createStayBalanceLink({
        bookingId: b.id, landlordId: b.landlord_id, propertyId: b.property_id,
        label: `Stay balance — ${b.property_name}, site ${b.unit_number} (${b.check_in} to ${b.check_out})`,
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
