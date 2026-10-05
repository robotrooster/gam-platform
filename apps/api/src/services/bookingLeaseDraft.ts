import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import { createNotification } from './notifications'
import { todayIn, dateIn } from '../lib/timezone'
import { pooledCheckSql } from './onboardingWindow'

// S547 (Nic): the long-stay ping is a DECISION for the landlord — screen
// first, or send the lease directly if they know the guest. The system never
// auto-sends a background check. To inform that decision we surface the
// guest's history WITH THIS ACCOUNT: prior completed stays with this landlord,
// an approved background check run for this account (or shared by the guest
// through the renter pool), and whether they've rented from this account
// continuously since that check (approved check + continuous tenancy since
// = no new check needed). S655: never another company's checks or leases.
const CONTINUITY_GAP_DAYS = 30   // move-between-units grace when chaining leases

interface GuestScreeningContext {
  priorStays: number
  approvedCheckAt: string | null           // date of latest approved GAM check
  continuousTenancySince: boolean          // leases chain from that check to today
}

async function guestScreeningContext(
  guestEmail: string | null, landlordId: string, tz: string | null,
): Promise<GuestScreeningContext> {
  const out: GuestScreeningContext = { priorStays: 0, approvedCheckAt: null, continuousTenancySince: false }
  if (!guestEmail) return out

  const person = await queryOne<{ user_id: string; tenant_id: string | null }>(
    `SELECT u.id AS user_id, t.id AS tenant_id
       FROM users u LEFT JOIN tenants t ON t.user_id = u.id
      WHERE LOWER(u.email) = LOWER($1) LIMIT 1`, [guestEmail])

  // S654: a stay is "prior" once its check-out is before the park's today —
  // the same calendar the continuity walk below counts from.
  const stays = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM unit_bookings
      WHERE LOWER(guest_email) = LOWER($1) AND landlord_id = $2
        AND status IN ('checked_out', 'confirmed', 'checked_in')
        AND check_out < $3::date`, [guestEmail, landlordId, todayIn(tz)])
  out.priorStays = Number(stays?.n ?? 0)
  if (!person) return out

  // decided_at can be NULL on older approved rows — fall back to created_at.
  //
  // S655: only a check THIS account may rely on — one run for any of its
  // companies, or one the guest put in the renter pool (they agreed to share
  // it). This read any company's approval, so the notification told company B
  // that company A had approved the guest, on what date, and B's own screening
  // email was skipped on A's say-so. Each company's screening decision is its
  // own.
  //
  // "Renter pool" means a check run through GAM's pool intake (no company),
  // not any check with the share box ticked — a check another company ran is
  // that company's decision even when the applicant agreed to share it.
  const check = await queryOne<{ at: string }>(
    `SELECT COALESCE(bc.decided_at, bc.created_at) AS at FROM background_checks bc
      WHERE bc.status = 'approved' AND (bc.user_id = $1 OR bc.tenant_id = $2)
        AND (${pooledCheckSql('bc')} OR bc.landlord_id IN (SELECT public.account_companies($3)))
      ORDER BY COALESCE(bc.decided_at, bc.created_at) DESC LIMIT 1`,
    [person.user_id, person.tenant_id, landlordId])
  if (!check?.at) return out
  // pg returns a Date object — normalize to YYYY-MM-DD. S654: the day it was
  // approved on the property's calendar; the UTC day reads as tomorrow for a
  // check decided after 5 pm in Phoenix.
  out.approvedCheckAt = dateIn(tz, new Date(check.at))

  if (person.tenant_id) {
    // Continuous = their leases with THIS account (any of its companies, via
    // the lease_tenants junction), merged with a small move-between-properties
    // grace, cover check-date → today. S655: it walked leases at every GAM
    // landlord, which told this company where else the guest had lived.
    // S654: ::text — pg hands a bare DATE back as a JS Date, and String(Date)
    // .slice(0, 10) is "Fri Jul 10", which made every lease below an Invalid
    // Date: the walk never advanced and continuity was judged off the check
    // date alone.
    const leases = await query<{ start_date: string; end_date: string | null }>(
      `SELECT l.start_date::text AS start_date, l.end_date::text AS end_date
         FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id
        WHERE lt.tenant_id = $1 AND l.status NOT IN ('pending', 'cancelled')
          AND l.landlord_id IN (SELECT public.account_companies($2))
        ORDER BY l.start_date ASC`, [person.tenant_id, landlordId])
    let cover = new Date(out.approvedCheckAt + 'T12:00:00Z')
    // S654: today is the property's calendar day, anchored at noon UTC like
    // the lease dates, so the 30-day grace is counted in whole days and does
    // not flip with the hour.
    const today = new Date(todayIn(tz) + 'T12:00:00Z')
    for (const l of leases) {
      const s = new Date(String(l.start_date).slice(0, 10) + 'T12:00:00Z')
      const e = l.end_date ? new Date(String(l.end_date).slice(0, 10) + 'T12:00:00Z') : today
      if (s.getTime() - cover.getTime() > CONTINUITY_GAP_DAYS * 86400000) break
      if (e > cover) cover = e
    }
    out.continuousTenancySince = today.getTime() - cover.getTime() <= CONTINUITY_GAP_DAYS * 86400000
  }
  return out
}

/**
 * 10/3 (decisions #15): what has been paid toward a reservation, as SQL on a
 * unit_bookings row aliased `b` — NULL when nothing has been. The stay paid
 * whole (balance_paid_at) is its whole price; otherwise the deposit paid
 * (deposit_paid_at), or the whole price when that payment carried no separate
 * deposit amount. The ONE definition: the lease drafted from the reservation
 * takes this off its first bill (jobs/moveInBundle) and the landlord's notice
 * here names the same amount.
 */
export const RESERVATION_PAID_SQL =
  `(CASE WHEN b.balance_paid_at IS NOT NULL THEN b.total_amount
         WHEN b.deposit_paid_at IS NOT NULL THEN COALESCE(b.deposit_amount, b.total_amount)
    END)`

// S526 (Nic): "anyone staying 30 or more days needs to be drafted a lease
// automatically" — guests often just keep staying. When a reservation is
// created or its dates change and the stay meets the property's threshold
// (30 days; 7 when the property runs weekly leases — weekly_lease_mode),
// draft a PENDING lease from the booking for the landlord to review:
//   * lease_source 'booking_draft', needs_review TRUE (landlord completes:
//     attach the tenant account, adjust rent/terms, send for signature)
//   * rent = the unit's monthly rent (fallback: its monthly stay rate)
//   * idempotent per booking via the unique source_booking_id index —
//     re-checks (extend, move) never create a second draft.
// Best-effort by design: callers .catch() so a draft failure never fails
// the reservation itself.
export async function maybeDraftLeaseFromBooking(bookingId: string): Promise<{ drafted: boolean; leaseId?: string }> {
  const booking = await queryOne<any>(
    `SELECT b.id, b.unit_id, b.landlord_id, b.status, b.check_in, b.check_out, b.guest_name, b.guest_email,
            ${RESERVATION_PAID_SQL}::text AS paid_toward_stay,
            -- the whole stay: paid in full, or a payment stamped with no separate deposit amount
            (b.balance_paid_at IS NOT NULL OR (b.deposit_paid_at IS NOT NULL AND b.deposit_amount IS NULL)) AS paid_whole,
            u.rent_amount, u.monthly_rate, u.unit_number,
            p.weekly_lease_mode, p.timezone
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`,
    [bookingId],
  )
  if (!booking) return { drafted: false }
  if (['cancelled', 'no_show', 'checked_out'].includes(booking.status)) return { drafted: false }

  const nights = Math.round(
    (new Date(booking.check_out).getTime() - new Date(booking.check_in).getTime()) / 86400000,
  )
  const threshold = booking.weekly_lease_mode ? 7 : 30
  if (nights < threshold) return { drafted: false }

  // One draft per booking — the unique partial index backs this up.
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM leases WHERE source_booking_id = $1`,
    [bookingId],
  )
  if (existing) return { drafted: false, leaseId: existing.id }

  const rent = Number(booking.rent_amount) > 0
    ? Number(booking.rent_amount)
    : Number(booking.monthly_rate) > 0 ? Number(booking.monthly_rate) : 0

  const rows = await query<any>(
    `INSERT INTO leases
       (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
        needs_review, lease_source, source_booking_id)
     VALUES ($1, $2, $3, 'fixed_term', 'pending', $4, $5, TRUE, 'booking_draft', $6)
     ON CONFLICT (source_booking_id) WHERE source_booking_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [booking.unit_id, booking.landlord_id, rent, booking.check_in, booking.check_out, bookingId],
  )
  const leaseId = rows[0]?.id
  if (leaseId) {
    logger.info({ bookingId, leaseId, nights, threshold },
      '[booking-lease-draft] stay met the lease threshold — draft lease created')
    // In-app heads-up to the landlord — the draft needs a tenant + review.
    // Best-effort: a notification failure never unwinds the draft.
    try {
      const owner = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM landlords WHERE id = $1`, [booking.landlord_id])
      if (owner) {
        const ctx = await guestScreeningContext(booking.guest_email, booking.landlord_id, booking.timezone)

        // ── S639 (Nic): A LONG STAY IS SCREENED AUTOMATICALLY ───────────────
        //
        // "When the reservation is longer than thirty days, don't have me
        // manually click on a thing to send a request for screening. Longer
        // than thirty days, they automatically get the link for the background
        // check."
        //
        // The notification below already warned that screening some guests and
        // not others in the same situation can be considered discriminatory —
        // and then handed the landlord a button that makes exactly that choice,
        // guest by guest, at the moment they are looking at somebody's name.
        // The consistent policy is the automatic one: every stay that crosses
        // the threshold gets the same email, so there is no judgment call to
        // apply unevenly.
        //
        // Skipped for a guest who already passed a GAM check and has had
        // continuous tenancy since — that is the same rule the landlord was
        // being told to apply by hand, and asking them to pay for a second
        // check they do not need is its own unfairness.
        const alreadyCleared = !!ctx.approvedCheckAt && !!ctx.continuousTenancySince
        let screeningEmailed = false
        if (booking.guest_email && !alreadyCleared) {
          try {
            const { emailBackgroundCheckScreeningRequest } = await import('./email')
            const prop = await queryOne<{ name: string; id: string }>(
              `SELECT p.name, p.id FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
              [booking.unit_id])
            // 10/4: the link names this landlord, park and site. Without them the
            // tenant page has nobody in scope and runs the guest through the
            // speculative renter-pool check — not this landlord's screening.
            const qs = new URLSearchParams({ landlordId: booking.landlord_id, unitId: booking.unit_id })
            if (prop?.id) qs.set('propertyId', prop.id)
            await emailBackgroundCheckScreeningRequest(
              booking.guest_email, booking.guest_name, prop?.name || 'the property',
              `${(process.env.TENANT_APP_URL || 'https://tenant.goldassetmanagement.com').replace(/\/$/, '')}/background-check?${qs.toString()}`,
              // 10/5: replies reach the people who run this property (services/replyRouting).
              { landlordId: booking.landlord_id, replyTo: prop?.id ? { kind: 'property', propertyId: prop.id } : undefined })
            screeningEmailed = true
            logger.info({ bookingId, leaseId, nights },
              '[booking-lease-draft] screening request emailed automatically to long-stay guest')
          } catch (e) {
            logger.error({ err: e, bookingId }, '[booking-lease-draft] auto screening email failed')
          }
        }
        // S655: everything here is this account's own record (plus a check the
        // guest shared through the renter pool) — never another company's.
        const history = ctx.approvedCheckAt && ctx.continuousTenancySince
          ? ` They passed a background check on ${ctx.approvedCheckAt} and have rented from you continuously since — no new check is needed.`
          : ctx.approvedCheckAt
          ? ` They passed a background check on ${ctx.approvedCheckAt}, but haven't rented from you continuously since.`
          : ctx.priorStays > 0
          ? ` They've stayed with you ${ctx.priorStays} time${ctx.priorStays === 1 ? '' : 's'} before; no background check with you is on file.`
          : ' No background check with you is on file for this guest.'
        // 10/3 (decisions #15): what was paid toward the reservation (at the
        // register or on the booking site) is part of the stay's price — the
        // lease's first bill takes it off the rent (jobs/moveInBundle), so the
        // landlord is told it will not be billed twice. Said as the code does
        // it: the first bill is written when the lease is signed, from what has
        // been paid by then (RESERVATION_PAID_SQL), and what that bill's rent
        // does not use is kept as credit toward the next one.
        const paidTowardStay = Number(booking.paid_toward_stay ?? 0)
        const depositLine = paidTowardStay > 0
          ? (booking.paid_whole
              ? ` The $${paidTowardStay.toFixed(2)} already paid for the whole stay comes off the lease's first bill.`
              : ` The $${paidTowardStay.toFixed(2)} deposit already paid on the reservation comes off the lease's first bill.`)
            + ' Anything more than that bill\'s rent is kept as credit toward the next one.'
          : ' A deposit paid on the reservation before the lease is signed comes off its first bill.'
        await createNotification({
          userId: owner.user_id,
          landlordId: booking.landlord_id,
          type: 'lease_drafted_from_booking',
          title: screeningEmailed ? 'Long stay — screening sent' : 'Long stay — draft lease ready',
          body: `${booking.guest_name || 'A guest'} is requesting a ${nights}-night stay on unit ${booking.unit_number}. A draft lease is ready on your Leases page.${history} `
            + (screeningEmailed
                ? 'A background-check link has been emailed to them automatically, as it is for every stay over the threshold — nothing to do until it comes back.'
                : alreadyCleared
                ? 'No screening was sent: they already passed a background check and have rented from you continuously since.'
                : 'No screening was sent because the reservation has no guest email on file.')
            + depositLine,
          data: {
            leaseId, bookingId,
            priorStays: ctx.priorStays,
            approvedCheckAt: ctx.approvedCheckAt,
            continuousTenancySince: ctx.continuousTenancySince,
          },
          actionUrl: `/leases?open=${leaseId}`,   // S527 W-1: deep-link to the draft
        })
      }
    } catch (err) {
      logger.error({ err, bookingId, leaseId }, '[booking-lease-draft] notification failed')
    }
  }
  return { drafted: !!leaseId, leaseId }
}
