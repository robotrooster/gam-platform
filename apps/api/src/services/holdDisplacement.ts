/**
 * S652 — what happens when a site somebody is holding, unpaid, is the last one
 * a paying guest could take.
 *
 * Nic set the whole rule in one sentence, asked how long a counter hold should
 * last: "there's no timer for deposit link but if it's not paid and someone
 * else pays it boots them as unconfirmed when there's no other spaces."
 *
 * A TIMER WAS THE OBVIOUS ANSWER AND IT WAS THE WRONG ONE. Every hold-expiry
 * scheme throws away real business for the crime of being slow — a link sent at
 * five on a Friday, read on Monday, and the site is gone. So an unpaid hold has
 * no clock. What it has instead is a rank: it loses to money.
 *
 * "WHEN THERE'S NO OTHER SPACES" IS THE ORDER OF OPERATIONS, and it is the part
 * that is easy to skip. Displacing an unpaid guest is the LAST resort, not the
 * first. If the park has an equivalent site free for their whole stay, they get
 * moved onto it and they are still coming — a fact they never need to learn.
 * Only a genuinely full park costs somebody their reservation, and when that
 * happens a human is told, because that is a phone call, not a notification.
 *
 * WHAT IS NEVER DISPLACED: anything with a deposit paid, anything already
 * checked in, and anything that is not a hold at all. Paid beats unpaid, and
 * nothing here can reach a confirmed stay.
 */
import type { PoolClient } from 'pg'
import { logger } from '../lib/logger'

export interface UnpaidHold {
  id: string
  unit_id: string
  unit_number: string
  guest_name: string | null
  guest_email: string | null
  guest_phone: string | null
  check_in: string
  check_out: string
  required_site_layout: string
  required_amp_service: string
  locked_to_unit: boolean
  /** S653 / 10/6 (Nic): sites this guest asked not to be put on — never a destination. */
  avoided_unit_ids: string[] | null
}

/**
 * The unpaid holds standing between a paying guest and this site.
 *
 * Deliberately narrow: `tentative` AND no deposit paid. A booking that took a
 * deposit is somebody's money and is not a candidate no matter what its status
 * says, which is why the deposit column is tested rather than trusted to the
 * status alone.
 */
export async function unpaidHoldsOn(
  client: PoolClient, unitId: string, checkIn: string, checkOut: string,
): Promise<UnpaidHold[]> {
  const { rows } = await client.query<UnpaidHold>(
    `SELECT b.id, b.unit_id, u.unit_number, b.guest_name, b.guest_email, b.guest_phone,
            b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.required_site_layout, b.required_amp_service, b.locked_to_unit, b.avoided_unit_ids
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
      WHERE b.unit_id = $1
        AND b.status = 'tentative'
        AND b.deposit_paid_at IS NULL
        AND b.displaced_at IS NULL
        -- 10/3 (review): only an UNTIMED hold yields (S652: "an unpaid hold has
        -- no timer"). A timed hold is a guest in the middle of paying online —
        -- moving it would let their money land with nothing recorded; an
        -- expired one is already gone and must not trigger a "site changed".
        AND b.hold_expires_at IS NULL
        AND b.check_in < $3::date AND b.check_out > $2::date
      FOR UPDATE OF b`,
    [unitId, checkIn, checkOut])
  return rows
}

/**
 * Somewhere else this guest could go, free for their WHOLE stay.
 *
 * Matches on what they asked for rather than on what they were given: a guest
 * who needed a 50-amp pull-through is not "accommodated" by being dropped on a
 * 30-amp back-in. A site with no stated requirement matches anything.
 *
 * Excludes sites holding other unpaid reservations too — moving one guest onto
 * another guest's hold just moves the problem, and would cascade.
 *
 * 10/6 (Nic): never a site the guest asked not to be put on
 * (unit_bookings.avoided_unit_ids) — "we need it to actually do something in
 * the schedule." With nowhere else free, the hold is cancelled and the owner
 * told, as when the park is full.
 */
export async function equivalentSiteFor(
  client: PoolClient, hold: UnpaidHold, excludeUnitIds: string[],
): Promise<{ id: string; unit_number: string } | null> {
  const { rows } = await client.query<{ id: string; unit_number: string }>(
    `SELECT u.id, u.unit_number
       FROM units u
       JOIN units cur ON cur.id = $1
      WHERE u.property_id = cur.property_id
        AND u.id <> ALL($2::uuid[])
        AND u.retired_at IS NULL
        AND u.status = 'vacant'
        AND u.unit_type = cur.unit_type
        AND ($3 = 'none' OR u.rv_site_layout = $3)
        AND ($4 = 'none' OR u.rv_amp_service = $4 OR u.rv_amp_service = 'both')
        AND NOT EXISTS (
          SELECT 1 FROM unit_bookings b
           WHERE b.unit_id = u.id AND b.status <> 'cancelled'
             AND b.check_in < $6::date AND b.check_out > $5::date)
        AND NOT EXISTS (
          SELECT 1 FROM leases l
           WHERE l.unit_id = u.id AND l.status IN ('active','pending')
             AND l.start_date < $6::date AND (l.end_date IS NULL OR l.end_date > $5::date))
        AND NOT unit_out_of_order_overlaps(u.id, $5::date, $6::date)
      ORDER BY u.unit_number
      LIMIT 1`,
    [hold.unit_id, [hold.unit_id, ...excludeUnitIds, ...(hold.avoided_unit_ids ?? [])], hold.required_site_layout,
     hold.required_amp_service, hold.check_in, hold.check_out])
  return rows[0] ?? null
}

export interface DisplacementOutcome {
  holdId: string
  guestName: string | null
  guestEmail: string | null
  guestPhone: string | null
  outcome: 'moved' | 'displaced'
  /** Where they went, when they went anywhere. */
  toUnitId?: string
  toUnitNumber?: string
  fromUnitNumber: string
  /** They had asked to be pinned to that exact site. Worth a human knowing. */
  wasLocked: boolean
  /**
   * 10/2 (review): a hold that was CANCELLED for want of a site had its unpaid
   * pay link(s) closed with it — there is no reservation left to pay for.
   * Never true for a hold that was moved (decisions #12).
   */
  linkClosed: boolean
  /**
   * 10/3 (decisions #12): a hold that was MOVED keeps its unpaid pay link — it
   * pays the same booking, now on the new site. True when one is still out.
   */
  linkKept?: boolean
}

/**
 * 10/2 (review): a hold CANCELLED for want of a site loses its unpaid pay link
 * too — there is no reservation left for it to pay for, and paid, it would be
 * money for a site somebody else now has. The link is closed (kept, never
 * deleted), and a card page the guest may already have open is closed at
 * Stripe too — a payment that lands anyway is handled when it arrives
 * (finalizePayLink tells the landlord). Its register ticket gives up its stay:
 * a ticket that carried only the stay is voided; one that also carries other
 * things (a tank of propane held on it) stays open for those
 * (registerStay releaseReservationTickets).
 *
 * 10/3 (decisions #12): a hold that was MOVED is not touched here. It is the
 * same booking on another site — its link pays it (at the reservation's own
 * price, read when the link is paid) and its ticket settles it.
 */
async function closeHoldPayment(client: PoolClient, hold: UnpaidHold): Promise<boolean> {
  const closed = await client.query<{ id: string; landlord_id: string; last_checkout_session_id: string | null }>(
    `UPDATE pos_pay_links SET status = 'cancelled', updated_at = NOW()
      WHERE booking_id = $1 AND status = 'open'
      RETURNING id, landlord_id, last_checkout_session_id`, [hold.id])
  const { releaseReservationTickets } = await import('./registerStay')
  await releaseReservationTickets(client, hold.id, 'The reservation lost its site to a guest who paid first')
  for (const l of closed.rows) {
    if (!l.last_checkout_session_id) continue
    try {
      const { expirePayLinkCheckoutSession } = await import('./stripeConnect')
      await expirePayLinkCheckoutSession(l.landlord_id, l.last_checkout_session_id)
    } catch (e) {
      // Already paid or already gone: a payment that lands anyway is caught
      // when it arrives (routes/posPayLinks finalizePayLink).
      logger.warn({ err: e, payLinkId: l.id, holdId: hold.id }, '[hold-displacement] could not close the pay link\'s card page')
    }
  }
  return closed.rows.length > 0
}

/**
 * Clear this site's unpaid holds so a paying booking can have it.
 *
 * Call INSIDE the paying booking's own transaction, before writing it. Both
 * halves then commit together: either the payer has the site and the holder has
 * been moved or told, or neither happened.
 *
 * A LOCKED hold is still moved rather than dropped. The lock says "this exact
 * site", which we can no longer honor either way — and between losing the site
 * you wanted and losing the reservation entirely, the first is the smaller
 * injury. It is reported so somebody can ring them.
 */
export async function clearUnpaidHolds(
  client: PoolClient, unitId: string, checkIn: string, checkOut: string,
  reason = 'A paid reservation took this site',
): Promise<DisplacementOutcome[]> {
  const holds = await unpaidHoldsOn(client, unitId, checkIn, checkOut)
  if (!holds.length) return []

  const out: DisplacementOutcome[] = []
  const taken: string[] = []
  for (const hold of holds) {
    // 10/3 (review): take the destination's booking lock (the same key
    // createStayBooking takes) and re-check it is free, so a register selling
    // that site at the same instant can never end up sharing it with the moved
    // hold. A destination lost to the race is skipped for the next candidate.
    let dest = await equivalentSiteFor(client, hold, taken)
    while (dest) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('unit-booking:' || $1::text))`, [dest.id])
      const { siteIsFree } = await import('./registerStay')
      if (await siteIsFree(client, dest.id, hold.check_in, hold.check_out)) break
      taken.push(dest.id)
      dest = await equivalentSiteFor(client, hold, taken)
    }
    if (dest) {
      taken.push(dest.id)
      await client.query(
        `UPDATE unit_bookings
            SET unit_id = $2, displaced_at = NOW(), displaced_from_unit = $3,
                displaced_reason = $4, updated_at = NOW()
          WHERE id = $1`,
        [hold.id, dest.id, hold.unit_id, `${reason} — moved to ${dest.unit_number}`])
      // 10/3 (review): a long stay drafts its lease alongside the booking
      // (services/bookingLeaseDraft). Still unsigned paperwork ('pending' or
      // 'draft'), it follows the booking to the new site — never left naming a
      // site the guest is no longer on, or the site a paying guest now has. A
      // signed (active) lease is never touched here.
      // (Its unit history says it moves on its start day, or today if that has
      // passed — the move-date column the history trigger reads.)
      await client.query(
        `UPDATE leases SET unit_id = $2, unit_moved_on = GREATEST(start_date, CURRENT_DATE), updated_at = NOW()
          WHERE source_booking_id = $1 AND status IN ('pending', 'draft') AND unit_id IS DISTINCT FROM $2`, [hold.id, dest.id])
      // decisions #12: its pay link stays open — it pays the same booking, now
      // on the new site. Its register ticket says where they are now.
      const kept = await client.query(
        `SELECT 1 FROM pos_pay_links WHERE booking_id = $1 AND status = 'open' LIMIT 1`, [hold.id])
      await client.query(
        `UPDATE pos_open_tickets
            SET note = TRIM(BOTH ' ·' FROM COALESCE(note, '') || ' · ' || $2), updated_at = NOW()
          WHERE booking_id = $1 AND status = 'open'`,
        [hold.id, `moved to site ${dest.unit_number} (a paid reservation took site ${hold.unit_number})`])
      out.push({
        holdId: hold.id, guestName: hold.guest_name, guestEmail: hold.guest_email,
        guestPhone: hold.guest_phone, outcome: 'moved', toUnitId: dest.id, toUnitNumber: dest.unit_number,
        fromUnitNumber: hold.unit_number, wasLocked: hold.locked_to_unit, linkClosed: false,
        linkKept: kept.rows.length > 0,
      })
    } else {
      // Nothing free anywhere. They lose the site — recorded, never deleted
      // (standing retention rule), and surfaced so a person makes the call.
      await client.query(
        `UPDATE unit_bookings
            SET status = 'cancelled', displaced_at = NOW(), displaced_from_unit = unit_id,
                displaced_reason = $2, updated_at = NOW()
          WHERE id = $1`,
        [hold.id, `${reason} — the property had nothing else free for those dates`])
      // 10/3 (review): a cancelled reservation takes its unsigned lease with it
      // — exactly as cancelling it on the schedule does (routes/units PATCH
      // bookings, S639): 'pending' and 'draft' are terminated; a signed
      // (active) lease is never touched.
      await client.query(
        `UPDATE leases SET status = 'terminated', updated_at = NOW()
          WHERE source_booking_id = $1 AND status IN ('pending', 'draft')`, [hold.id])
      const linkClosed = await closeHoldPayment(client, hold)
      out.push({
        holdId: hold.id, guestName: hold.guest_name, guestEmail: hold.guest_email,
        guestPhone: hold.guest_phone, outcome: 'displaced', fromUnitNumber: hold.unit_number, wasLocked: hold.locked_to_unit,
        linkClosed,
      })
    }
  }
  logger.warn({ unitId, checkIn, checkOut, outcomes: out },
    '[hold-displacement] an unpaid hold yielded to a paid booking')
  return out
}

/**
 * Tell the people who need to know that a hold lost its site.
 *
 * TWO DIFFERENT PIECES OF NEWS, and collapsing them would be the mistake. A
 * guest who was MOVED is still coming and needs their new site number. A guest
 * who was DISPLACED has no reservation any more, and no email covers that — the
 * landlord gets told plainly so somebody rings them.
 */
export async function notifyDisplacedHolds(
  landlordId: string,
  propertyId: string,
  outcomes: DisplacementOutcome[],
): Promise<void> {
  // 10/6 (review): first, what follows a stay follows these too — a hold
  // moved to another site, or cancelled, takes its work trade and its utility
  // agreement with it (moved: onto the new site; cancelled: ended). Every
  // caller tells the landlord after its commit, so this runs on what was saved.
  await followDisplacedHolds(outcomes)
  const { createNotification } = await import('./notifications')
  const { emailBookingSiteChanged } = await import('./email')
  const { queryOne } = await import('../db')
  const prop = await queryOne<{ name: string }>(
    `SELECT name FROM properties WHERE id = $1`, [propertyId])
  const propName = prop?.name ?? 'the property'
  // The notification goes to the account holder — the person who answers for
  // the park when a guest turns up expecting a site they no longer have.
  const owner = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM landlords WHERE id = $1`, [landlordId])
  if (!owner) return

  for (const o of outcomes) {
    const who = o.guestName || 'A guest'
    if (o.outcome === 'moved') {
      await createNotification({
        userId: owner.user_id,
        landlordId,
        type: 'booking_moved',
        title: `${who} moved to site ${o.toUnitNumber}`,
        body: `${who} was holding site ${o.fromUnitNumber} without a deposit and a paid reservation took it. `
          + `They are now on ${o.toUnitNumber}, free for their whole stay.`
          + (o.wasLocked ? ' They had asked to be pinned to the original site — worth a call.' : '')
          + (o.linkKept ? ` Their pay link still works — it now pays for site ${o.toUnitNumber}; nothing to resend.` : ''),
      }).catch(() => {})
      if (o.guestEmail) {
        // 10/5: replies reach the people who run this property (services/replyRouting).
        await emailBookingSiteChanged(
          o.guestEmail, o.guestName, propName, o.fromUnitNumber, o.toUnitNumber!,
          { landlordId, replyTo: { kind: 'property', propertyId } },
        ).catch(() => {})
      }
    } else {
      // No email on purpose. "Your reservation is cancelled because somebody
      // else paid" is not a message to receive from a robot at 2am.
      await createNotification({
        userId: owner.user_id,
        landlordId,
        type: 'booking_displaced',
        title: `${who} lost site ${o.fromUnitNumber} — call them`,
        body: `${who} was holding site ${o.fromUnitNumber} without a deposit, a paid reservation took it, `
          + `and ${propName} had nothing else free for those dates. Their reservation is canceled. `
          + `They have NOT been emailed — this one needs a phone call`
          + (o.guestPhone ? `: ${o.guestPhone}.` : ', and no phone number was taken.')
          + (o.linkClosed ? ' Their unpaid pay link was closed, so it can no longer be paid.' : ''),
      }).catch(() => {})
    }
  }
}

/**
 * 10/6 (review): bring a displaced hold's work trade and utility agreement in
 * step with where it went (services/stayTerms syncStayUtilityAgreement, which
 * syncs the stay's work trade too). Best-effort, after the commit — the move or
 * cancellation stands either way, and the next change to the stay syncs again.
 */
export async function followDisplacedHolds(outcomes: DisplacementOutcome[]): Promise<void> {
  if (!outcomes.length) return
  const { syncStayUtilityAgreement } = await import('./stayTerms')
  for (const o of outcomes) {
    await syncStayUtilityAgreement(o.holdId).catch(err =>
      logger.error({ err, bookingId: o.holdId }, '[hold-displacement] the hold\'s work trade or utilities could not follow it'))
  }
}
