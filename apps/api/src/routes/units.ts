import { Router } from 'express'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { db, query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord, requirePerm, getScopedPropertyIds, assertPropertyInScope, userHasPerm } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource, canViewLandlordFinances } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds } from '../lib/landlordScope'
import { canonicalUnitNumber, UNIT_TYPE_PREFIX, BOOKING_STATUSES, BOOKING_STATUS_LABEL, SUB_PERMISSION_LABEL, PERMISSION_CATALOG, type BookingStatus } from '@gam/shared'
import { STAY_TERMS, STAY_SCREENING_NIGHTS, stayHeldWords, type StayTerms } from '@gam/shared'
import { centsWords, NEVER_MOVED_IN_NOTE, NEVER_MOVED_IN_REASON } from '../lib/unwindIssuedLease'
import { UTILITY_TYPES, UnitStatus, calcNetPerUnit, getReservePhase, LAUNCH_PLATFORM_FEE, UNIT_STATUSES, UNIT_TYPES, RV_SITE_LAYOUTS, RV_AMP_SERVICES, isSiteLayoutMismatch, isAmpServiceMismatch, SHORT_STAY_LOCKED_UNIT_TYPES, leaseTypesForUnitType, isShortStayByNature, DWELLING_OWNERSHIP_VALUES, OCCUPANCY_MODES, FLOOR_LEVELS, MAX_INSPECTION_LIVING_AREAS, UNIT_FEATURE_CATALOG, dayDiff } from '@gam/shared'
import { findStayConflict, findAvailableUnits, STAY_CONFLICT_MESSAGE, type StayConflict } from '../services/unitAvailability'
import { formatUnitNumber } from '../lib/format'
import { logger } from '../lib/logger'
import { todayIn, addDaysTo } from '../lib/timezone'
import { promoteNextWaitlister } from '../services/propertyBooking'
import { linkUnitToSubtype } from '../services/unitSubtype'
import { recordBookingEvent, recordBookingChange } from '../services/bookingEvents'
import {
  stayNeeds, markScreeningRequired, chooseStayTerms, draftLeaseFromStay, syncStayUtilityAgreement, checkInBlock,
  continuousStayNights, canAttestReturningGuest, attestReturningGuest, planStayGuestAccount,
  RETURNING_GUEST_NOT_ALLOWED, type StayNeeds, type CheckInBlock,
} from '../services/stayTerms'
import {
  stayWorkTradeIn, coversRent, syncStayWorkTrade, stayWorkTradeSkippedWords, stayRentCovered, stayWorkTradeOf,
  sendStayWorkTradeInvite, type StayWorkTradeInvite,
  type StayWorkTradeTerms,
} from '../services/stayWorkTrade'
import { unitPendingReads } from '../services/utilityReadingRuns'
import { syncLeaseWithBookingDates } from '../services/bookingLeaseBilling'
import { bookedDayBeforeEarlyCheckOut, checkOutChangeRefusal, onCheckOutUndone, afterPatchEarlyCheckOut, refundNeedsRetrySql, healLeaseEnds } from '../services/earlyCheckOut'
import { scheduleStayPrice, stayExtensionQuote, extendStayByMonth, SCREENING_LINE_NAME, type StayExtension } from '../services/registerStay'
import { assertLateFeeDecision } from '../services/lateFeePolicy'
import { replyToProperty } from '../services/replyRouting'
import {
  sendBookingGuestAccessEmail,
  issueBookingGuestToken,
  bookingGuestQrDataUrl,
  revokeBookingGuestTokens,
} from '../services/bookingGuestTokens'

export const unitsRouter = Router()
unitsRouter.use(requireAuth)

// GET /api/units  — landlord sees their units, admin sees all
unitsRouter.get('/', async (req, res, next) => {
  try {
    const isSuper = req.user!.role === 'super_admin'
    const isAdmin = req.user!.role === 'admin' || isSuper
    const params: any[] = []
    // S400 fix: pre-fix used req.user.profileId unconditionally, which is the
    // landlord_id for role=landlord but the user_id for team roles (PM /
    // maintenance_worker / onsite_manager). Team members got an empty list
    // because user_id never matches units.landlord_id. Resolve to landlordId
    // for team members. Same pattern as credit.ts (line 109).
    // S620: EVERY entity this caller can read, not just the one they registered
    // under. Nic's co-owner opened Oak Park and saw "0 units, 0 of 0 occupied"
    // — the property listed (that query scopes differently) while its units
    // were filtered to his OWN entity, the empty one registering created so he
    // could accept the invite. Oak Park is his entity too; that is what
    // co-ownership means. A half-working screen is worse than a broken one:
    // nothing errored, it just looked like the park had no units.
    const callerScope = landlordScopeIds(req.user!)
    // S567 portfolio scoping: super sees all; a regular admin (portfolio
    // manager) sees only units under landlords they close or service; a
    // landlord/team member sees only their own.
    let landlordFilter = ''
    if (!isAdmin) {
      if (!callerScope.length) throw new AppError(403, 'Forbidden')
      landlordFilter = `AND u.landlord_id = ANY($${params.push(callerScope)})`
    } else if (!isSuper) {
      const i = params.push(req.user!.userId)
      landlordFilter = `AND u.landlord_id IN (SELECT id FROM landlords WHERE portfolio_manager_id = $${i} OR service_manager_id = $${i})`
    }
    const propertyFilter = req.query.propertyId
      ? `AND u.property_id = $${params.push(req.query.propertyId)}`
      : ''
    // S655: a staff member assigned to particular properties (property
    // manager, on-site manager or maintenance worker without "all
    // properties") lists only those properties' units — and so only those
    // residents. This list feeds the landlord Tenants page; before, such a
    // staff member saw every resident in the company by name and email, and
    // each row they could not open ended in "You can't open this resident".
    // null = no property limit (owners, GAM admin, all-properties staff);
    // [] = sees nothing (a staff login with no properties assigned).
    const scopedPropertyIds = await getScopedPropertyIds(req.user)
    const staffScopeFilter = scopedPropertyIds === null
      ? ''
      : `AND u.property_id = ANY($${params.push(scopedPropertyIds)}::uuid[])`
    // S605: retired units are EXCLUDED by default — fail-closed. Any frontend
    // that feeds a dropdown from this endpoint would otherwise silently offer a
    // unit the server will refuse to lease or book, and a long-lived park would
    // accumulate retired rows in its working list forever. Surfaces that show
    // history (the Units page, reports) opt in explicitly.
    const retiredFilter = req.query.includeRetired === 'true' ? '' : 'AND u.retired_at IS NULL'
    const units = await query<any>(`
      SELECT u.*,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        vuo.primary_tenant_id AS tenant_id,
        vuo.primary_first_name AS tenant_first,
        vuo.primary_last_name AS tenant_last,
        vuo.primary_email AS tenant_email,
        vuo.tenant_count,
        -- S652 (Nic): payment health on the list, not two clicks deep. Charges
        -- due before today; paid = settled, or covered by work trade (hours
        -- paid it, "there was no payment to be made, so how could they be at
        -- zero percent"). NULL until there is a bill to judge by.
        (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                     ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE p.status IN ('settled','paid_via_deposit') OR p.work_trade_suspended_at IS NOT NULL) / COUNT(*))
                END
           FROM payments p
          WHERE p.tenant_id = vuo.primary_tenant_id
            AND p.type IN ('rent','utility','fee','home_payment')
            AND p.due_date < CURRENT_DATE
            AND p.status IN ('pending','failed','settled','paid_via_deposit','returned')) AS payment_health,
        -- S554 (button-sweep bug #10): the admin-ops Units panel reads
        -- achVerified for the primary tenant's ACH badge; without this the
        -- field was always undefined and the badge stuck on "Pending".
        pt.ach_verified,
        -- ── S640 (Nic): "they're all showing pending ACH... not good to have
        -- that integrated everywhere when it's not really real money." ────────
        --
        -- A work-trade resident is never going to link a bank account, because
        -- no money is ever going to move. The Tenants list read their ACH badge
        -- as "Pending" and will read it that way for as long as they live there
        -- — a permanent to-do item for something nobody should ever do.
        EXISTS (SELECT 1 FROM work_trade_agreements a
                 WHERE a.unit_id = u.id AND a.status = 'active'
                   AND 'rent' = ANY(a.covered_charges)) AS work_trade_rent,
        -- S613 (Nic): how many people have ALREADY been invited to this unit and
        -- have not finished a lease yet. v_unit_occupancy only knows about an
        -- ACTIVE tenancy, so a unit with an invite out still looked free — and
        -- inviting thirty households in one sitting, that is how the same space
        -- gets offered to two of them.
        --
        -- S613 (Nic): "Any pending invites should block things from showing up
        -- on this list. It would only show up back on this list if there's a
        -- timeout at the end of the acceptance flow — if somebody never accepts
        -- the invite, then it would show back as available after a timeout."
        --
        -- A tenant invite lives SEVEN days (tenants.ts sets
        -- tenant_invite_expires_at = NOW() + 7 days). Accepting CLEARS the token
        -- and the expiry, so the three states are distinguishable and only one
        -- of them releases the unit:
        --
        --   expiry in the future  → invite is live, someone is considering it → BLOCK
        --   expiry NULL           → they accepted; mid-flow, lease not finished → BLOCK
        --   expiry in the past    → sent, never accepted, lapsed → RELEASE
        --
        -- Without the last case an unaccepted invite would hold a space out of
        -- the list forever, which is worse than the double-invite it prevents.
        --
        -- S629 (Nic): "I went into a different unit, and the apartment that I
        -- just sent invites to is still showing from the drop down list."
        --
        -- It was, because this counted ONE of the two invite doors. The Invite
        -- Tenant modal writes pending_lease_drafts; "New Lease — Invite to
        -- Sign" writes pending_tenant_intents, and nothing here looked at
        -- those. APT 04 had two people invited and still reported zero, so the
        -- S613 rule that stops one space being offered to two households was
        -- only ever half applied.
        --
        -- Both are counted, under the same three-state expiry test: a live
        -- invite blocks, an accepted-but-unfinished one blocks (accepting
        -- CLEARS the expiry, so NULL means mid-flow), and one that lapsed
        -- releases the unit.
        ((SELECT COUNT(*)::int FROM pending_lease_drafts pld
            JOIN users pu ON pu.id = pld.tenant_user_id
           WHERE pld.unit_id = u.id AND pld.resolved_at IS NULL
             AND (pu.tenant_invite_expires_at IS NULL
                  OR pu.tenant_invite_expires_at > NOW()))
         +
         (SELECT COUNT(*)::int FROM pending_tenant_intents pti
            JOIN tenants pt2 ON pt2.id = pti.tenant_id
            JOIN users pu2 ON pu2.id = pt2.user_id
           WHERE pti.unit_id = u.id
             AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL
             AND (pu2.tenant_invite_expires_at IS NULL
                  OR pu2.tenant_invite_expires_at > NOW()
                  -- S655: a DRAFTED LEASE holds the unit whatever the
                  -- invite's clock says. Since S647 the lease drafts at
                  -- invite and waits for the landlord's signature; a
                  -- landlord who took more than seven days to sign (or a
                  -- resident who took more than seven to sign after him)
                  -- saw the unit offered to a second household while that
                  -- lease was still live. Only a voided or failed document
                  -- lets it go.
                  OR EXISTS (SELECT 1 FROM lease_documents hold_doc
                              WHERE hold_doc.id = pti.draft_document_id
                                AND hold_doc.status NOT IN ('voided', 'execution_failed'))))
        ) AS pending_invite_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      LEFT JOIN tenants pt ON pt.id = vuo.primary_tenant_id
      WHERE 1=1 ${landlordFilter} ${propertyFilter} ${staffScopeFilter} ${retiredFilter}
      ORDER BY p.name, u.unit_number
    `, params)
    res.json({ success: true, data: units })
  } catch (e) { next(e) }
})

// S655: a request date as a plain calendar day ('YYYY-MM-DD'), or null when it
// is not a real day. Accepts a full ISO timestamp too (its first ten
// characters), the way every other date in this file is read.
function calendarDay(v: unknown): string | null {
  const s = String(v ?? '').slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? s : null
}

// S655: 'YYYY-MM-DD' → "October 5, 2026" for a sentence a person reads.
function longDay(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US',
    { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// Step 9 final fix (fix pass 1): what canceling a stay did to the lease
// drafted with it, in plain words (the save's `leaseClosed` notice).
// Fix pass 2 (review): what STAYS owed is said too — GAM's own fees (the $1
// declined-card fee, the returned-payment fee) and charges billed on purpose
// are never zeroed (the close's keptWords). "Nothing was owed on it" only when
// nothing is left owed either.
//
// Final fix (fix pass 1, decisions #53): the close zeroes ONLY the move-in bill
// (a later bill stays owed and keptWords names it), so "the move-in bill" is
// now the whole truth of what was zeroed — one bill per lease ("bills" when
// more than one lease was drafted with the stay).
function leaseClosedWords(guest: string, c: { amount: number; leases: number; keptTotal: number; keptWords: string[] }): string {
  const whose = guest === 'This guest' ? 'The' : `${guest}'s`
  const lease = c.leases === 1 ? 'lease' : 'leases'
  const it = c.leases === 1 ? 'it' : 'them'
  const kept = c.keptTotal > 0 && c.keptWords.length > 0 ? ` ${c.keptWords.join(' ')}` : ''
  return `${whose} ${lease} drafted with this reservation ended with it. `
    + (c.amount > 0
      ? `Nothing was paid on ${it}, so the ${centsWords(Math.round(c.amount * 100))} move-in ${c.leases === 1 ? 'bill is' : 'bills are'} no longer owed.${kept}`
      : c.keptTotal > 0
        ? `Nothing on ${it} was zeroed.${kept}`
        : `Nothing was owed on ${it}.`)
}

/**
 * Final fix (fix pass 1): a checked-out stay can't be canceled or marked a
 * no-show — it happened. The words name no step that undoes it (there is none
 * on the Schedule, and undoing a stay is how rent for nights stayed got
 * zeroed): the stay stays on the schedule as its record.
 */
function stayHappenedRefusal(guest: string, status: 'cancelled' | 'no_show'): string {
  return status === 'cancelled'
    ? `${guest} has already checked out, so the stay can't be canceled — a stay that happened stays on the schedule as its record, and nothing was changed.`
    : `${guest} checked in and out, so they came and can't be marked a no-show — the stay stays on the schedule as its record, and nothing was changed.`
}

/**
 * Final fix (fix pass 2, review): a checked-in stay can't be canceled or
 * marked a no-show either — the guest is on the site, so "the site is free
 * for those nights" would be untrue and the nights they are staying would go
 * unbilled. The step that exists is Check out (on the day, or early — it
 * settles the nights they stayed). Never "set it back to Confirmed".
 */
function stayUnderWayRefusal(guest: string, status: 'cancelled' | 'no_show'): string {
  return status === 'cancelled'
    ? `${guest} is checked in, so the stay can't be canceled — they are on the site, and nothing was changed. `
      + 'When they leave, use Check out on the Schedule; it settles the nights they stayed.'
    : `${guest} is checked in, so they came and can't be marked a no-show — nothing was changed. `
      + 'When they leave, use Check out on the Schedule; it settles the nights they stayed.'
}

/**
 * Step 9 final fix (fix pass 1 of the #53 close, review LOW): bringing back a
 * canceled or no-show stay whose drafted lease the never-moved-in close ended.
 *
 * Fix pass 2 (review): it says "(its move-in bill zeroed)" only when the close
 * actually zeroed one (`billZeroed`); a signed lease the close ended with no
 * bill on it is named as signed.
 */
export function closedStayRefusal(guest: string, was: 'cancelled' | 'no_show', billZeroed = true): string {
  const whose = guest === 'This guest' ? 'This' : `${guest}'s`
  return `${was === 'no_show' ? `${guest} was marked a no-show` : `${whose} reservation was canceled`}, and the lease drafted with it `
    + (billZeroed
      ? 'was ended as never moved in (its move-in bill zeroed), '
      : 'had been signed and was ended as never moved in, ')
    + 'so the reservation can’t be brought back — nothing was changed. '
    + `If ${guest === 'This guest' ? 'they' : guest} ${guest === 'This guest' ? 'are' : 'is'} coming after all, book a new reservation on the Schedule.`
}

/**
 * Step 9 final fix (fix pass 2, review MEDIUM): the drafted lease of a
 * canceled or no-show stay that the never-moved-in close ended AS AN ISSUED
 * LEASE — the close zeroed something on it (its move-in bill voided with
 * NEVER_MOVED_IN_NOTE, or a line zeroed with it), or the lease had been signed
 * by the landlord (the landlord's signature is what issues the lease — S647,
 * the landlord signs FIRST; signed_by_landlord is written TRUE only when a
 * lease is issued, so it marks an issued lease). Such a
 * stay can't be brought back: the lease stays ended and its bill zeroed, so
 * the guest would be back on the site with no lease and nothing billing them.
 *
 * Unsigned paperwork the cancel ended with nothing zeroed is NOT returned: a
 * mistaken Cancel on it can be undone, as S639 allowed, and any reservation
 * money stays on the stay it was paid toward. (Fix pass 1 refused on the
 * close's reason alone, which every lease the cancel ends carries — including
 * an unsigned draft with no bill — and told staff a bill was zeroed when none
 * existed, sending them to book a new stay while the money paid stayed on the
 * old one.)
 *
 * Read before the save, and again inside it once the stay's row is locked
 * (a "They never moved in" on the Leases page between the two locks the same
 * row first — assessNeverMovedIn — so it is seen).
 */
async function closedLeaseOfStay(
  bookingId: string, client?: PoolClient,
): Promise<{ billZeroed: boolean } | null> {
  const sql = `
    SELECT z.bill_zeroed FROM (
      SELECT l.id, l.signed_by_landlord, l.termination_reason,
             (EXISTS (SELECT 1 FROM invoices i
                       WHERE i.lease_id = l.id AND i.status = 'void' AND strpos(COALESCE(i.notes, ''), $3) > 0)
              OR EXISTS (SELECT 1 FROM payments p
                          WHERE (p.lease_id = l.id OR p.invoice_id IN (SELECT i.id FROM invoices i WHERE i.lease_id = l.id))
                            AND strpos(COALESCE(p.notes, ''), $3) > 0)) AS bill_zeroed
        FROM leases l
       WHERE l.source_booking_id = $1 AND l.status IN ('terminated', 'expired')
    ) z
    WHERE z.bill_zeroed OR (z.termination_reason = $2 AND z.signed_by_landlord IS TRUE)
    ORDER BY z.bill_zeroed DESC
    LIMIT 1`
  const params = [bookingId, NEVER_MOVED_IN_REASON, NEVER_MOVED_IN_NOTE]
  const row = client
    ? (await client.query<{ bill_zeroed: boolean }>(sql, params)).rows[0]
    : await queryOne<{ bill_zeroed: boolean }>(sql, params)
  return row ? { billZeroed: row.bill_zeroed === true } : null
}

/** What a cancel (or a no-show) of a stay with a drafted lease says before the close's own refusal words. */
function cancelRefusalLead(guest: string, status: 'cancelled' | 'no_show'): string {
  return `${guest === 'This guest' ? 'This' : `${guest}'s`} reservation has a lease drafted with it, and `
    + `${status === 'no_show' ? 'marking the reservation a no-show' : 'canceling the reservation'} ends that lease — but `
}

/** What canceling the stay does to its drafted lease, in a sentence ("Canceling this reservation ends the lease …"). */
function cancelEndsLeaseWords(status: 'cancelled' | 'no_show', inForce: boolean, amount: number): string {
  const act = status === 'no_show' ? 'Marking this reservation a no-show' : 'Canceling this reservation'
  return `${act} ends the lease drafted with it${inForce ? ', which is already in force' : ''}`
    + (amount > 0 ? `${inForce ? ',' : ''} and zeroes its unpaid ${centsWords(Math.round(amount * 100))} move-in bill` : '')
}

/** The 403 when the person may cancel stays but not end leases (Terminate leases). */
function cancelNeedsTerminateWords(status: 'cancelled' | 'no_show', inForce: boolean, amount: number): string {
  return `${cancelEndsLeaseWords(status, inForce, amount)}. `
    + `That needs the "${SUB_PERMISSION_LABEL['leases.terminate']}" permission, so nothing was changed. `
    + `Ask the account owner to turn on "${SUB_PERMISSION_LABEL['leases.terminate']}" for you on the Team page.`
}

/**
 * Final fix (fix pass 1, decisions #53: "never runs blind"): a cancel that
 * would zero a bill or end a lease in force, sent without the total its
 * confirm showed, is refused with nothing changed. The step that exists:
 * Cancel reservation on the Schedule, which shows what is zeroed and what
 * stays owed before anything changes.
 */
/**
 * Fix pass 2 (review): the leases drafted with the stay are not the ones the
 * Schedule's confirm showed (one was drafted, or ended, since it read).
 */
export const CANCEL_LEASES_CHANGED_WORDS = 'The leases drafted with this reservation changed since you opened this, so nothing was changed. '
  + 'The window now shows what canceling it does — check it and confirm again.'

/** Fix pass 3 (review): Cancel reservation on a stay already marked a no-show. */
export const NO_SHOW_ALREADY_WORDS = 'This reservation is already marked a no-show, so its site is already free. Nothing else to do.'

export const CANCEL_NEEDS_CONFIRM_TAIL = 'Nothing was changed. Use Cancel reservation on the Schedule — it shows, by name, '
  + 'what is zeroed and what stays owed before you confirm.'

// S655: a reservation's status, and the words the schedule shows for it —
// BOOKING_STATUSES (every status unit_bookings_status_check allows) and
// BOOKING_STATUS_LABEL, from packages/shared. The PATCH refuses anything else
// in words instead of letting the database's own error text out as a 500.
const isBookingStatus = (s: unknown): s is BookingStatus =>
  typeof s === 'string' && (BOOKING_STATUSES as readonly string[]).includes(s)
const bookingStatusLabel = (s: string) => (isBookingStatus(s) ? BOOKING_STATUS_LABEL[s] : s)
// "Tentative, Confirmed, … Canceled or No-show" — the statuses a refusal names, from the shared list.
const BOOKING_STATUS_CHOICES = (() => {
  const words = BOOKING_STATUSES.map(st => BOOKING_STATUS_LABEL[st])
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
})()

// S655 (Step 6 fix round): everybody who puts a stay on a site waits for
// everybody else doing the same, so a site's free-check and the write that
// takes the nights happen with nobody else in between. Two keys exist today
// and both are taken: the register's (services/registerStay createStayBooking)
// and the booking page's (services/propertyBooking bookStay). Sites in a fixed
// order, so two saves moving stays between the same two sites cannot each
// hold one site while waiting for the other.
//
// Lock order: a caller locks the booking ROWS it changes first and the sites
// second — the register's sale does the same (it locks the unpaid holds it
// moves, then the site), so the two can never wait on each other in a circle.
// The one exception is a paid reservation made on the schedule (the booking
// POST): it takes its site first and then waits on nothing (see
// HOLD_CLEARING_LOCK_WAIT).
//
// 10/3 (review, fix pass 2): before all of that, a save that will WRITE a stay
// onto a site takes that site's own row (FOR KEY SHARE) — the booking POST, a
// move on the schedule (the booking PATCH), putting back a reservation moved
// for an extension that did not happen (putRelocatedBack) and the register's
// sale alike. A pay
// link being sent for a site holds the row and then waits for the site, so
// the row has to come first or the two end each other with a deadlock.
async function lockSitesForStays(client: PoolClient, unitIds: string[]): Promise<void> {
  for (const id of [...new Set(unitIds)].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`unit-booking:${id}`])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`unit_booking:${id}`])
  }
}

// S655: the statuses in which a guest still holds their site. Moving a
// checked-out stay back to one of these is undoing the check-out.
const SITE_HOLDING_STATUSES = ['tentative', 'confirmed', 'checked_in']

// ── 10/5 (Nic): PREPAID STAYS ON THE SCHEDULE ────────────────────────────────
//
//   "At the point of sale, same thing, except it's the front counter person
//    that's clicking lease or no lease. And either way, it goes to me."
//
// The rules live in services/stayTerms. The schedule asks stayNeeds() whenever
// it makes a stay or changes a stay's dates or site, and does what it says:
//   - R2: 30+ continuous nights with no answer yet → the save is refused with
//     code 'stay_terms_needed'; the screen asks staff lease or no lease, then
//     sends the same save again with `stayTerms`. Lease drafts one for the
//     landlord (draftLeaseFromStay); a stay is held only through what is paid.
//   - R1/R8: 22+ → the stay is marked as one whose check-in waits on a
//     background check. The schedule takes no money itself, so the check's fee
//     rides on the deposit link or the register ticket it hands the stay to.
//   - R3: nothing here ever drafts a lease on its own.

/** The counter's version of the question the guest is asked online (R2). */
export function stayTermsQuestion(nights: number): string {
  return `This guest is staying ${nights} nights in a row, so they get a lease or a stay. `
    + 'A lease holds the site for as long as they stay. A stay holds it only through the time they\'ve paid for. '
    + 'Choose one and the change is saved.'
}

/** The refusal a 30+ night save gets until staff answer lease or no lease. */
const stayTermsNeededBody = (needs: StayNeeds) => ({
  success: false as const,
  code: 'stay_terms_needed' as const,
  error: stayTermsQuestion(needs.nights),
  nights: needs.nights,
})

/** R7: a stay this long has to reach the guest — the check is sent to them and matched by their email. */
const LONG_STAY_NEEDS_EMAIL =
  'A stay of more than three weeks needs the guest\'s email, so their background check can be sent to them. '
  + 'Add their email, then save again.'

/**
 * 10/5 (Nic, A2): "it must go out as a pay link or a register ticket." A stay
 * that needs the background check's fee (22+ continuous nights, nothing on
 * file) cannot be confirmed straight onto the schedule: the schedule takes no
 * money, and the fee has to ride on the stay's payment. The save is refused
 * with code 'screening_fee_route_needed', and the screen offers the two ways
 * that carry the fee — a deposit link emailed to the guest, or the register.
 */
function screeningFeeRouteBody(needs: StayNeeds, hasEmail: boolean) {
  const fee = needs.screeningFee?.amount ?? 0
  return {
    // 10/6 (Nic): the third choice — "Returning guest — they've stayed with us
    // before" — for a desk allowed to use it. Unavailable (the property's
    // allowance is used up) it says so in words, never the count.
    returning: needs.returningOffer,
    success: false as const,
    code: 'screening_fee_route_needed' as const,
    error: `This guest is staying ${needs.nights} nights in a row, so they need a background check before check-in, `
      + `and none is on file. Its ${fmtMoney(fee)} fee is paid with the stay, so this reservation can't be confirmed `
      + 'straight onto the schedule. '
      + (hasEmail
          ? 'Email the guest a pay link, or send the stay to the register to be paid there.'
          : 'Send the stay to the register to be paid there, or add the guest\'s email to send them a pay link.'),
    nights: needs.nights,
    screeningFee: fee,
    canSendLink: hasEmail,
  }
}
const fmtMoney = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`

/**
 * Is the background check's fee already on its way for this continuous stay —
 * on an open register ticket or an unpaid pay link of any stay in it (R7), or
 * already paid? Then a longer stay is not sent a second fee (M3): one fee per
 * stay, never two.
 */
async function screeningFeeAlreadyCarried(bookingIds: string[]): Promise<boolean> {
  if (!bookingIds.length) return false
  const carried = await queryOne<{ x: number }>(
    `SELECT 1 AS x FROM pos_open_tickets t
      WHERE t.booking_id = ANY($1::uuid[]) AND t.status = 'open'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]'::jsonb END) i
                     WHERE i->>'${SCREENING_FEE_LINE_FLAG}' = 'true')
     UNION ALL
     SELECT 1 AS x FROM pos_pay_links l
      WHERE l.status = 'open'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(l.items) = 'array' THEN l.items ELSE '[]'::jsonb END) i
                     WHERE i->>'${SCREENING_FEE_LINE_FLAG}' = 'true'
                       -- a deposit link names the stay on the link; a link for
                       -- the check alone (createScreeningFeeLink) names it on its line.
                       AND (l.booking_id = ANY($1::uuid[])
                            OR (l.booking_id IS NULL AND i->>'bookingId' = ANY($1::text[]))))
     UNION ALL
     -- already paid for this continuous stay: nothing more to carry.
     SELECT 1 AS x FROM screening_prepayments sp
      WHERE sp.booking_id = ANY($1::uuid[]) AND sp.status <> 'void'
     LIMIT 1`, [bookingIds])
  return !!carried
}

/** The answer to the R2 question in a request body, or null. A value that is not one is refused in words. */
function stayTermsIn(raw: unknown): StayTerms | null {
  if (raw == null || raw === '') return null
  if (!(STAY_TERMS as readonly unknown[]).includes(raw)) {
    throw new AppError(400, 'Choose Lease or Stay (no lease) for this reservation, then save again.')
  }
  return raw as StayTerms
}

/**
 * 10/5 (Nic, R8): the line a register ticket carries for a stay's background
 * check when nothing is on file — a fixed price (stayNeeds().screeningFee, the
 * server's own figure), marked so the register knows it for what it is: GAM's
 * screening money, never the stay's price, and not removable — named as the
 * register names its own (SCREENING_LINE_NAME), with the same mark a pay
 * link's screening line carries (routes/posPayLinks isScreeningLine). When
 * the register settles the ticket it records the prepaid screening
 * (services/stayTerms recordScreeningPrepayment, source 'schedule').
 */
export const SCREENING_FEE_LINE_FLAG = 'screening'
export function screeningFeeTicketLine(amount: number): Record<string, unknown> {
  return { id: null, name: SCREENING_LINE_NAME, qty: 1, price: amount, tax: 0, [SCREENING_FEE_LINE_FLAG]: true }
}

/** The lease drafted from this stay that still runs (pending or active), if any. */
async function stayLeaseOf(bookingId: string): Promise<{ id: string; status: string; openEnded: boolean } | null> {
  const l = await queryOne<{ id: string; status: string; open_ended: boolean }>(
    `SELECT id, status, (end_date IS NULL) AS open_ended FROM leases
      WHERE source_booking_id = $1 AND status IN ('pending', 'active')
      ORDER BY created_at DESC LIMIT 1`, [bookingId])
  return l ? { id: l.id, status: l.status, openEnded: l.open_ended } : null
}

/**
 * After a stay is saved (made, re-dated, moved or given another month): what
 * stayNeeds() said, carried out. Best-effort after the commit — the stay is
 * real either way, and a failure is logged, never thrown at the desk.
 *   - 22+ nights: check-in waits on a background check (R1, R9).
 *   - The counter's lease-or-stay answer, when one was asked for: lease drafts
 *     it (R4) and tells the landlord; stay bills the site's utilities (R11)
 *     and tells the landlord (R2: "either way, it goes to me"). A stay that
 *     continues one already answered "stay" carries the same answer.
 *   - Otherwise the stay's utility agreement (if any) follows its new dates.
 */
async function afterStaySaved(bookingId: string, needs: StayNeeds | null, given: StayTerms | null,
                              byUserId: string): Promise<{ terms: StayTerms | null; leaseId: string | null }> {
  const out: { terms: StayTerms | null; leaseId: string | null } = { terms: null, leaseId: null }
  try {
    // 10/6: a returning guest (attested now or on an earlier leg) never waits.
    if (needs && needs.nights >= STAY_SCREENING_NIGHTS && needs.screening !== 'returning') await markScreeningRequired(null, bookingId)
    const answer: StayTerms | null = !needs ? null
      : given && needs.leaseChoice === given ? given
      : !given && needs.leaseChoice === 'stay' ? 'stay'
      : null
    if (answer) {
      const r = await chooseStayTerms(bookingId, answer, { byUserId })
      out.terms = answer
      out.leaseId = r.leaseId ?? null
    } else {
      await syncStayUtilityAgreement(bookingId, { byUserId })
    }
  } catch (err) {
    logger.error({ err, bookingId }, '[booking] stay terms follow-through failed')
  }
  return out
}

/**
 * 10/6 (Nic): the returning-guest choice and a work trade, as a reservation
 * save sends them — refused in words for a desk without the permission each
 * needs (owner / a manager allowed to invite tenants; "Create / update
 * work-trade agreements"), before anything is written.
 */
function returningGuestIn(req: any): boolean {
  const on = req.body?.returningGuest === true
  if (on && !canAttestReturningGuest(req.user)) throw new AppError(403, RETURNING_GUEST_NOT_ALLOWED)
  return on
}
function workTradeIn(req: any): StayWorkTradeTerms | null | undefined {
  const t = stayWorkTradeIn(req.body?.workTrade)
  if (t !== undefined && !userHasPerm(req.user, 'work_trade.manage')) {
    throw new AppError(403, 'A work trade needs the "Create / update work-trade agreements" permission. Ask the account owner to turn it on for you on the Team page. Nothing was saved.')
  }
  return t
}
/** A work trade is made for the guest's own account: refused before anything is written when it can't be. */
async function assertWorkTradeGuest(b: { tenant_id: string | null; guest_email: string | null; landlord_id: string }): Promise<void> {
  const plan = await planStayGuestAccount(b)
  if (!plan.ok) throw new AppError(400, stayWorkTradeSkippedWords(plan.reason))
}

/**
 * 10/6 (review): what marking a guest as returning did to a background-check
 * fee that had already gone out (services/stayTerms attestReturningGuest), in
 * the desk's words — or null when nothing carried one.
 */
function returningFeeWords(d: import('../services/stayTerms').ScreeningFeeDropped): string | null {
  const parts: string[] = []
  if (d.linksChanged) parts.push(d.linksChanged === 1
    ? 'The pay link already sent no longer asks for the background check — the same link now asks the rest.'
    : `The ${d.linksChanged} pay links already sent no longer ask for the background check — the same links now ask the rest.`)
  if (d.linksClosed) parts.push(d.linksClosed === 1
    ? 'The pay link sent for the background check was closed — nothing is left on it to pay.'
    : `${d.linksClosed} pay links sent for the background check were closed — nothing is left on them to pay.`)
  if (d.ticketsChanged) parts.push('The background check came off the stay\'s register ticket.')
  if (d.ticketsVoided) parts.push('The stay\'s register ticket was closed — nothing is left on it to pay.')
  return parts.length ? `Returning guest: no background check. ${parts.join(' ')}` : null
}

/** The 409 a check-in waiting on screening gets (R9). No override — owners included. */
const screeningPendingBody = (block: CheckInBlock) => ({
  success: false as const, code: block.code, waitingOn: block.waitingOn,
  error: block.message, checkId: block.checkId ?? null,
})

// 10/3 (review, fix pass 2): what a booking PATCH from somebody WITHOUT "Edit /
// move / cancel reservations" may do — check a guest in, check one out, or
// correct the day a checked-out guest left, and nothing else (see the PATCH's
// "CHECKING A GUEST IN OR OUT NEEDS ONLY ITS OWN PERMISSION"). Returns the
// refusal in plain words, or null when the save is only that. Whether they hold
// "Check guests in" / "Check guests out" for the act itself is checked before.
// The edit permission's name is read from the permissions catalog, so the
// words match the toggle on the Team page.
const EDIT_RESERVATION_LABEL = PERMISSION_CATALOG
  .flatMap(g => g.sections.flatMap(s => s.items))
  .find(i => i.key === 'schedule.edit_reservation')?.label ?? 'Edit / move / cancel reservations'

function deskOnlyRefusal(
  booking: {
    status: string; notes: string | null; guest_name: string | null; guest_email: string | null
    guest_phone: string | null; required_site_layout: string | null; required_amp_service: string | null
    locked_to_unit: boolean | null; avoided_unit_ids: string[] | null
  },
  sent: {
    status: unknown; notes: unknown; guestName: unknown; guestEmail: unknown; guestPhone: unknown
    requiredSiteLayout: unknown; requiredAmpService: unknown; lockedToUnit: unknown; avoidedIn: string[] | null
    checkInChanged: boolean; checkOutChanged: boolean; unitChanged: boolean; toCheckOut: boolean
  },
): string | null {
  // A field counts only when it is sent AND differs from what is stored: the
  // schedule sends some of them back unchanged.
  const differs = (v: unknown, stored: unknown) => v != null && String(v) !== String(stored ?? '')
  const parts: string[] = []
  if (sent.checkInChanged) parts.push('arrival day')
  // On a check-out the day typed in is the day they left, which is the check-out itself.
  if (sent.checkOutChanged && !sent.toCheckOut) parts.push('check-out day')
  if (sent.unitChanged) parts.push('site')
  if (differs(sent.guestName, booking.guest_name) || differs(sent.guestEmail, booking.guest_email)
      || differs(sent.guestPhone, booking.guest_phone)) parts.push("guest's details")
  // (Blank notes leave the notes as they are.)
  if (sent.notes && differs(sent.notes, booking.notes)) parts.push('notes')
  if (differs(sent.requiredSiteLayout, booking.required_site_layout)
      || differs(sent.requiredAmpService, booking.required_amp_service)) parts.push('site needs')
  if (typeof sent.lockedToUnit === 'boolean' && sent.lockedToUnit !== (booking.locked_to_unit === true)) {
    parts.push('lock to the site')
  }
  if (sent.avoidedIn) {
    const now = new Set(booking.avoided_unit_ids ?? [])
    const asked = new Set(sent.avoidedIn)
    if (now.size !== asked.size || [...asked].some(id => !now.has(id))) parts.push('sites to avoid')
  }
  const turnOn = `Ask the account owner to turn on "${EDIT_RESERVATION_LABEL}" for you on the Team page.`
  if (parts.length) {
    const what = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    return `Changing the ${what} needs the "${EDIT_RESERVATION_LABEL}" permission, and nothing was changed. ${turnOn}`
  }
  const to = typeof sent.status === 'string' && sent.status !== '' ? sent.status : null
  if (to === null || to === booking.status) return null
  const checkIn = to === 'checked_in' && (booking.status === 'tentative' || booking.status === 'confirmed')
  const checkOut = to === 'checked_out' && booking.status === 'checked_in'
  if (checkIn || checkOut) return null
  return `Changing a reservation from ${bookingStatusLabel(booking.status)} to ${bookingStatusLabel(to)} `
    + `needs the "${EDIT_RESERVATION_LABEL}" permission, and nothing was changed. ${turnOn}`
}

// S655 (Step 6 fix round 6): a transaction the database ended to break a
// deadlock (two saves each waiting on a lock the other holds) did nothing, so
// it is safe to run again from the top. A save that keeps meeting one is
// answered in plain words instead of the database's own text in a 500.
const DEADLOCKED = '40P01'
const isDeadlock = (e: unknown) => (e as { code?: string } | null)?.code === DEADLOCKED
const SAVED_AT_THE_SAME_MOMENT =
  'Another reservation was being saved for the same sites at the same moment, so this one was not saved. Try again.'

// 10/3 (review, fix round 3): A PAID RESERVATION NEVER WAITS ON ANYBODY ONCE IT
// HAS ITS SITE.
//
// Moving an unpaid hold out of the way takes locks on OTHER things: the hold
// itself, the site it moves to (and that site's row), its ticket and its pay
// link. The register's sale takes some of the same things in its own order
// (pos.ts: the holds on its site, then the site a hold moves to, then its own
// site), and no single order for this save works against it. Waiting for its
// own site after the hold's new one ended a sale moving a hold the other way
// (probe PE). Waiting for the hold's new site after its own ended a sale on the
// same site moving its hold to that same new site. The database ends whichever
// of the two it checks first, and the register's sale has no second try.
//
// So once this save has its site, every lock it asks for while moving holds is
// given up after HOLD_CLEARING_LOCK_WAIT, far under the database's one-second
// deadlock check. The save then lets go of everything (ROLLBACK, so its site
// goes too), pauses and starts again from the top. Whoever it was in the way of
// finishes, and this save then sees what they stored. After BOOKING_SAVE_TRIES
// tries it is answered in plain words (SAVED_AT_THE_SAME_MOMENT).
const LOCK_BUSY = '55P03'
const isLockBusy = (e: unknown) => (e as { code?: string } | null)?.code === LOCK_BUSY
const HOLD_CLEARING_LOCK_WAIT = '50ms'
const BOOKING_SAVE_TRIES = 6
// 50ms, 100ms, 200ms, 400ms, 800ms, plus up to 50ms at random so two saves that
// let go together do not come back together. About two seconds in all, longer
// than a card being taken at the register keeps a site.
const pauseBeforeTry = (retry: number) => new Promise<void>(r =>
  setTimeout(r, Math.min(800, 50 * 2 ** (retry - 1)) + Math.floor(Math.random() * 50)))

async function withShortLockWaits<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  const prior = (await client.query<{ v: string }>(`SELECT current_setting('lock_timeout') AS v`)).rows[0].v
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, [HOLD_CLEARING_LOCK_WAIT])
  const out = await work()
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, [prior])
  return out
}

// S655 (Step 6 fix round): the stay's row, locked, compared with the row a
// save decided everything from. True when somebody changed its status, site
// or dates in between (or it is gone). The caller holds the lock until its
// transaction ends.
async function stayChangedSince(
  client: PoolClient,
  b: { id: string; status: string; unit_id: string; check_in_day: string; check_out_day: string },
): Promise<boolean> {
  const fresh = (await client.query<{ status: string; unit_id: string; ci: string; co: string }>(
    `SELECT status, unit_id, to_char(check_in, 'YYYY-MM-DD') AS ci, to_char(check_out, 'YYYY-MM-DD') AS co
       FROM unit_bookings WHERE id = $1 FOR UPDATE`, [b.id])).rows[0]
  return !fresh || fresh.status !== b.status || fresh.unit_id !== b.unit_id
    || fresh.ci !== b.check_in_day || fresh.co !== b.check_out_day
}

// S655 (Step 6 fix round 6): a reservation the extension rule (W-20,
// services/scheduleCompression relocateBlockingBookings) moved off the
// extending guest's site to make room. That move is written on its own, ahead
// of the extension's save — scheduleCompression takes no transaction — so when
// the save is then refused, the move is undone here instead of being left
// behind for an extension that never happened.
type RelocatedStay = { bookingId: string; fromUnitId: string; toUnitId: string }

async function stillRelocated(bookingIds: string[], fromUnitId: string): Promise<RelocatedStay[]> {
  if (!bookingIds.length) return []
  const rows = await query<{ id: string; unit_id: string }>(
    `SELECT id, unit_id FROM unit_bookings WHERE id = ANY($1::uuid[]) AND unit_id <> $2`,
    [bookingIds, fromUnitId])
  return rows.map(r => ({ bookingId: r.id, fromUnitId, toUnitId: r.unit_id }))
}

// Each one goes back only while it is still where the move put it, still
// holds a site, and its nights on the site it came from are still free —
// checked with that site locked against everybody who books it. Lock order is
// lockSitesForStays' (the same as a move on the schedule): the site's own row
// (FOR KEY SHARE) first, then the stay's row, then the site. Otherwise it stays
// where it is: it has a site either way, never a shared one. Best-effort; a
// failure is logged.
async function putRelocatedBack(moves: RelocatedStay[]): Promise<void> {
  for (const m of moves) {
    let c: PoolClient
    try { c = await getClient() } catch (err) {
      logger.error({ err, bookingId: m.bookingId }, '[extend] could not put a moved reservation back on its site')
      continue
    }
    try {
      await c.query('BEGIN')
      // 10/3 (review, fix pass): the site's own row first. Writing the stay
      // back onto the site needs that row (the foreign-key check of the
      // UPDATE below), and a pay link being sent for the site holds the row
      // while it waits for the site. Reaching the row last, after the site, let
      // the two end each other with a deadlock (the link answered with a 500 at
      // the counter). Taken first, this waits for the link holding nothing.
      await c.query(`SELECT 1 FROM units WHERE id = $1 FOR KEY SHARE`, [m.fromUnitId])
      const r = (await c.query<{ unit_id: string; status: string; ci: string; co: string }>(
        `SELECT b.unit_id, b.status, to_char(b.check_in, 'YYYY-MM-DD') AS ci, to_char(b.check_out, 'YYYY-MM-DD') AS co
           FROM unit_bookings b WHERE b.id = $1
            FOR UPDATE`, [m.bookingId])).rows[0]
      if (!r || r.unit_id !== m.toUnitId || !SITE_HOLDING_STATUSES.includes(r.status)) {
        await c.query('ROLLBACK')
        continue
      }
      await lockSitesForStays(c, [m.fromUnitId])
      const conflict = await findStayConflict(m.fromUnitId, {
        checkIn: r.ci, checkOut: r.co, excludeBookingId: m.bookingId,
      })
      if (conflict) {
        await c.query('ROLLBACK')
        logger.info({ bookingId: m.bookingId, conflict }, '[extend] moved reservation stays on its new site: its old nights were taken')
        continue
      }
      await c.query(`UPDATE unit_bookings SET unit_id = $2, updated_at = NOW() WHERE id = $1`, [m.bookingId, m.fromUnitId])
      await c.query('COMMIT')
      logger.info({ bookingId: m.bookingId }, '[extend] a reservation moved for an extension that did not happen on that site is back on it')
      // 10/6 (review): its work trade and utilities go back with it.
      await syncStayUtilityAgreement(m.bookingId).catch(err =>
        logger.error({ err, bookingId: m.bookingId }, '[extend] the stay put back could not bring its work trade or utilities with it'))
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {})
      logger.error({ err, bookingId: m.bookingId }, '[extend] could not put a moved reservation back on its site')
    } finally {
      c.release()
    }
  }
}

// S655: bookedDayBeforeEarlyCheckOut — the check-out day an EARLY CHECK-OUT
// replaced, read from the schedule's own history — lives in
// services/earlyCheckOut (10/4) so the schedule's Check out window and this
// PATCH read it the same way. Other readers of the length a stay was sold for
// read unit_bookings.booked_check_out (services/registerStay soldCheckOutSql).

// S655 (Step 6 fix round 5): the first night from `from` up to (not
// including) `to` that ANOTHER reservation holds on the site — the same
// reservations the site check (findStayConflict) counts — or null when none
// does. Lets a refusal say whether an Edit can still give nights back, or
// whether the other reservation sits right on the day they left.
async function firstNightHeldByAnother(
  unitId: string, from: string, to: string, bookingId: string,
): Promise<string | null> {
  const r = await queryOne<{ d: string }>(
    `SELECT to_char(GREATEST(check_in, $2::date), 'YYYY-MM-DD') AS d
       FROM unit_bookings
      WHERE unit_id = $1 AND status NOT IN ('cancelled') AND id <> $4
        AND check_in < $3::date AND check_out > $2::date
      ORDER BY check_in
      LIMIT 1`, [unitId, from, to, bookingId])
  return r?.d ?? null
}

// What holds a site, in words, for "… for some of the nights between …".
const SITE_HELD_BY: Record<Exclude<StayConflict, null>, string> = {
  booking:        'Another reservation now holds this site',
  lease:          'Another lease now covers this site',
  out_of_order:   'This site is marked out of order',
  owner_use:      "This site is in the owner's own use",
  pending_tenant: 'This site is held for a tenant completing onboarding',
}

// S655 (Step 6 fix round 5): after an early check-out, the steps that end the
// stay's lease on the day the guest left — the landlord's deliberate date edit
// (S548) — that work NOW. The first step puts the stay back, and that needs
// the nights the check-out freed (the day they left up to the booked day) to
// be free. If somebody has been booked onto them since, or the site is held
// some other way, the steps start with freeing them. Naming only the three
// steps sent staff into a refusal, then to an Edit save of the day they left,
// which changes nothing (see "AFTER AN EARLY CHECK-OUT" in the booking PATCH).
async function endLeaseOnDayLeftSteps(
  o: { bookingId: string; unitId: string; leftDay: string; booked: string },
): Promise<string> {
  const steps = `put the stay back to Checked in, change its check-out to ${longDay(o.leftDay)}`
  const conflict = await findStayConflict(o.unitId, {
    checkIn: o.leftDay, checkOut: o.booked, excludeBookingId: o.bookingId,
  })
  if (!conflict) return `To end the lease on the day they left instead, ${steps}, then check them out again.`
  return `${SITE_HELD_BY[conflict]} for some of the nights between ${longDay(o.leftDay)} and ${longDay(o.booked)}. `
    + 'To end the lease on the day they left instead, '
    + (conflict === 'booking' ? 'move that reservation first' : 'free those nights on the site first')
    + `; then ${steps}, and check them out again.`
}

/**
 * 10/6 (Nic): the question asked before a person moves a stay onto a site the
 * guest asked not to have — "She asked not to be on RV 14. Move her there
 * anyway?" The schedule does not know who is "she", so it says their name.
 */
export function avoidedSiteWords(guestName: string | null | undefined, unitNumber: string): string {
  const who = guestName && guestName.trim() ? guestName.trim() : 'This guest'
  return `${who} asked not to be on ${unitNumber}. Move them there anyway?`
}

// S653: the avoid list is body-supplied ids. Keep only units that exist at the
// property the stay is at — a stray id from another park (or another landlord)
// is dropped, never stored.
async function scopedAvoidedUnits(ids: string[], propertyId: string): Promise<string[]> {
  const clean = Array.from(new Set(ids.filter(x => /^[0-9a-f-]{36}$/i.test(x))))
  if (clean.length === 0) return []
  const rows = await query<{ id: string }>(
    `SELECT id FROM units WHERE id = ANY($1::uuid[]) AND property_id = $2`, [clean, propertyId])
  return rows.map(r => r.id)
}

// GET /api/units/available — W-19/W-48 (S529): the ONE availability surface.
// Free-for-window units (no overlapping non-cancelled booking / active lease
// via services/unitAvailability) with optional RV-requirement filtering, so
// pickers offer only units the server would actually accept. Registered
// BEFORE /:id so the literal path wins the match.
unitsRouter.get('/available', async (req, res, next) => {
  try {
    const q = z.object({
      checkIn:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      checkOut:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      excludeBookingId:   z.string().uuid().nullish(),
      requiredSiteLayout: z.enum(RV_SITE_LAYOUTS as unknown as [string, ...string[]]).nullish(),
      requiredAmpService: z.enum(RV_AMP_SERVICES as unknown as [string, ...string[]]).nullish(),
      propertyId:         z.string().uuid().nullish(),
    }).parse(req.query)
    // S633: the account's companies, not one. Availability spans the portfolio.
    const callerLandlordIds = landlordScopeIds(req.user!)
    if (!callerLandlordIds.length) throw new AppError(403, 'Forbidden')
    const scopedIds = await getScopedPropertyIds(req.user)
    // S654: "today" is the park's day, not UTC's — after 5 pm in Phoenix UTC is
    // already tomorrow, and tonight's open sites would drop out of the picker.
    // One park (or an account whose parks share a zone) uses that zone; a
    // portfolio spread across zones falls back to GAM's home zone.
    let checkIn = q.checkIn
    if (!checkIn) {
      const zones = await query<{ timezone: string }>(
        `SELECT DISTINCT timezone FROM properties
          WHERE landlord_id = ANY($1::uuid[])
            AND ($2::uuid IS NULL OR id = $2)
            AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
        [callerLandlordIds, q.propertyId ?? null, scopedIds])
      checkIn = todayIn(zones.length === 1 ? zones[0].timezone : null)
    }
    const rows = await findAvailableUnits({
      landlordIds: callerLandlordIds,
      window: {
        checkIn,
        checkOut: q.checkOut ?? null,
        excludeBookingId: q.excludeBookingId ?? null,
      },
      propertyId: q.propertyId ?? null,
      scopedPropertyIds: scopedIds,
    })
    const data = rows.filter(u =>
      !isSiteLayoutMismatch(q.requiredSiteLayout, u.rv_site_layout) &&
      !isAmpServiceMismatch(q.requiredAmpService, u.rv_amp_service))
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

// GET /api/units/:id
unitsRouter.get('/:id', async (req, res, next) => {
  try {
    const unit = await queryOne<any>(`
      SELECT u.*, p.name AS property_name, p.type AS property_type,
        p.street1, p.city, p.state, p.zip,
        ul.first_name AS landlord_first, ul.last_name AS landlord_last,
        -- S655 (Nic, 10/2): no SSI/SSDI flag. "That's our check for the flex
        -- products" — GAM's eligibility check, kept GAM-side; this unit page
        -- is the landlord's and staff's.
        te.on_time_pay_enrolled, te.ach_verified,
        vuo.primary_first_name AS tenant_first,
        vuo.primary_last_name AS tenant_last,
        vuo.primary_email AS tenant_email,
        vuo.primary_phone AS tenant_phone,
        vuo.primary_tenant_id AS tenant_id,
        vuo.tenant_count,
        -- S573: unit settings lock while a lease is active/pending (rent is
        -- committed to the signed doc). Free to edit only between leases.
        EXISTS (SELECT 1 FROM leases le WHERE le.unit_id = u.id
                  AND le.status IN ('active','pending')) AS has_active_lease,
        -- S613: the unit's subtype, so the page can SHOW what class this space
        -- is. subtype_id has been stored since S527 and displayed nowhere.
        st.name AS subtype_name,
        -- S630: a unit carries SEVERAL now — "pull through" AND "50 amp" AND
        -- "facing west". subtype_name above is the first of these, kept for
        -- readers not yet moved over.
        COALESCE((
          SELECT json_agg(json_build_object('id', s2.id, 'name', s2.name) ORDER BY s2.name)
            FROM unit_subtype_links l JOIN property_unit_subtypes s2 ON s2.id = l.subtype_id
           WHERE l.unit_id = u.id
        ), '[]'::json) AS subtypes,
        -- S613: which utilities THIS unit's active lease actually makes the
        -- tenant responsible for. Nothing bills without it and it fails
        -- SILENTLY — the run just reports unitsSkipped — so the unit page has to
        -- be able to say "you configured this and it will still bill nobody".
        -- Written at e-sign from the lease's own tags; there is no other writer,
        -- because the lease is what a tenant agreed to pay.
        (SELECT COALESCE(array_agg(lur.utility_type), '{}')
           FROM lease_utility_responsibilities lur
           JOIN leases lz ON lz.id = lur.lease_id
          WHERE lz.unit_id = u.id AND lz.status = 'active'
            AND lur.tenant_responsible) AS tenant_billed_utilities,
        -- S629 (Nic): "when I click on unit 24 to see the unit details, it
        -- doesn't show me anybody who's pending an invite. If I don't have my
        -- list in front of me of who I invited to that unit, I wouldn't know."
        --
        -- Who was invited, whether they finished setting up their account, and
        -- whether they have accepted — the three states that explain why a unit
        -- with invites out still shows no tenant.
        (SELECT COALESCE(json_agg(json_build_object(
                  'name', TRIM(COALESCE(iu.first_name,'') || ' ' || COALESCE(iu.last_name,'')),
                  'email', iu.email,
                  'invitedAt', pti.created_at,
                  'acceptedAt', pti.accepted_at,
                  'accountActivated', iu.password_hash <> '$2b$10$placeholder_invite_pending',
                  'drafted', pti.draft_document_id IS NOT NULL
                ) ORDER BY pti.created_at), '[]'::json)
           FROM pending_tenant_intents pti
           JOIN tenants it ON it.id = pti.tenant_id
           JOIN users iu ON iu.id = it.user_id
          WHERE pti.unit_id = u.id
            AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL) AS pending_invites
      FROM units u
      LEFT JOIN property_unit_subtypes st ON st.id = u.subtype_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = u.landlord_id
      JOIN users ul ON ul.id = l.user_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      LEFT JOIN tenants te ON te.id = vuo.primary_tenant_id
      WHERE u.id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // S655: the same property limit as the list above. This page carries the
    // resident's name, email and phone, so a staff member assigned to
    // particular properties opens units at those properties only.
    const scopedPropertyIds = await getScopedPropertyIds(req.user)
    if (scopedPropertyIds !== null && !scopedPropertyIds.includes(unit.property_id)) {
      throw new AppError(403, "This unit is at a property you're not assigned to. Ask the owner if you need it.")
    }
    res.json({ success: true, data: unit })
  } catch (e) { next(e) }
})

// POST /api/units
unitsRouter.post('/', requirePerm('properties.add_unit'), async (req, res, next) => {
  try {
    // S526: units are created WITH their type + attributes (RV layout/amp,
    // bedrooms). S527: subtypeId prefills type/facts/pricing from the owner's
    // named subtype (body fields override), and quantity creates a numbered
    // batch — this replaces the removed POST /properties/:id/units/bulk, so
    // there is ONE door for creating units.
    const body = z.object({
      propertyId:      z.string().uuid(),
      unitNumber:      z.string(),
      // S641 (Nic): "apartment 101 or 201, duplicated at the property when
      // assigned a separate building. That's one tier that we didn't come up
      // with yet." NULL for the properties that have no buildings — most parks.
      building:        z.string().trim().min(1).max(40).nullable().optional(),
      subtypeId:       z.string().uuid().nullable().optional(),
      // S630: several, each toggled on its own. subtypeId stays for callers
      // that send one; both funnel into the same list below.
      subtypeIds:      z.array(z.string().uuid()).max(20).optional(),
      quantity:        z.number().int().min(1).max(200).default(1),
      // S604 (Nic): real parks have signage the software must match, not the
      // other way round. Oak Park runs RV 1-3, apartments 4-5, motel 6-12,
      // apartments 13-19, then RV 20-36 — the second RV block cannot be created
      // by "continue after the highest", which would produce RV 04. startAt lets
      // the landlord name a block to match the ground.
      startAt:         z.number().int().min(1).max(100000).optional(),
      // S605: IGNORED — padding is fixed at 2 platform-wide. Kept in the schema
      // only so an older client sending it doesn't get a validation error.
      padWidth:        z.number().int().min(1).max(6).optional(),
      unitType:        z.enum(UNIT_TYPES as unknown as [string, ...string[]]).optional(),
      bedrooms:        z.number().int().min(0).optional(),
      bathrooms:       z.number().min(0).optional(),
      sqft:            z.number().int().nullable().optional(),
      rentAmount:      z.number().positive().optional(),
      securityDeposit: z.number().min(0).optional(),
      rvSiteLayout:    z.enum(RV_SITE_LAYOUTS as unknown as [string, ...string[]]).optional(),
      rvAmpService:    z.enum(RV_AMP_SERVICES as unknown as [string, ...string[]]).optional(),
      // S550: who owns the dwelling — drives the inspection checklist
      // (site-only for tenant-owned MH/RV vs full interior). Only meaningful
      // for rv_spot / mobile_home; defaulted below.
      dwellingOwnership: z.enum(DWELLING_OWNERSHIP_VALUES as unknown as [string, ...string[]]).optional(),
      // S573: multi-level dwelling — adds the stairs & handrails inspection area.
      // Only meaningful for interior residential types; ignored otherwise.
      isMultiLevel:    z.boolean().optional(),
      // S573: ADA-accessible unit — adds the accessibility inspection area.
      isAdaAccessible: z.boolean().optional(),
      // S573: floor placement for tenant search filtering (ground/upper/etc).
      floorLevel:      z.enum(FLOOR_LEVELS as unknown as [string, ...string[]]).nullable().optional(),
      // S573: living-area count + feature map (what the unit has → inspection).
      livingAreas:     z.number().int().min(1).max(MAX_INSPECTION_LIVING_AREAS).optional(),
      features:        z.record(z.boolean()).optional(),
      storageSize:     z.string().max(40).optional(),
      nightlyRate:     z.number().min(0).nullable().optional(),
      weeklyRate:      z.number().min(0).nullable().optional(),
      monthlyRate:     z.number().min(0).nullable().optional(),
      // S568: monthly lot rent the operator pays an EXTERNAL park for this home's
      // lot (homes-only properties; investor-operator model). 0 when land-owned.
      lotRentAmount:   z.number().min(0).optional(),
      // S527 fix: the Add Unit modal always sent status but the schema
      // stripped it — the "Initial Status" picker was a silent no-op and
      // every unit was born vacant. Suspended stays excluded (eviction-mode
      // coupling, S524). direct_pay retired W-15/S531.
      // S609 (Nic): OWNER-OCCUPIED is settable at creation. It was only
      // available by creating the unit and then changing it in the units list,
      // which is why Nic was marking his own occupied spots VACANT: "I'm marking
      // them all vacant on setup because there's no way to mark them owner
      // occupied." A vacant-marked owner unit is not cosmetic — it takes no
      // share of a RUBS split, so the owner's own utility usage lands on the
      // paying tenants.
      status:          z.enum(['vacant', 'active', 'owner_use']).default('vacant'),
      // How many people live in an owner-occupied unit. Read only when
      // status='owner_use' — such a unit has no lease, so there are no tenants
      // to count for a headcount-based utility split.
      ownerHouseholdSize: z.number().int().min(1).max(30).optional(),
      // S616 (Nic): the operator opting a home-shaped unit into short stays at
      // creation. Absent means "follow the type" — open for an RV spot or a
      // campsite, closed for an apartment or a mobile home.
      isBookable: z.boolean().optional(),
    }).parse(req.body)

    // Verify the calling user can manage units on this property's landlord.
    const prop = await queryOne<any>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`,
      [body.propertyId]
    )
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(req.user, prop.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // Owner subtype (S527): the unit's defaults. Must belong to this property.
    // S630: several subtypes, each an independent tag. `sub` is the first and
    // supplies the creation prefill (unit type, and any facts it carries); the
    // rest are classification. All of them get linked.
    const wantedSubtypes = body.subtypeIds ?? (body.subtypeId ? [body.subtypeId] : [])
    let subs: any[] = []
    if (wantedSubtypes.length) {
      subs = await query<any>(
        `SELECT * FROM property_unit_subtypes WHERE id = ANY($1::uuid[]) AND property_id = $2
         ORDER BY name`,
        [wantedSubtypes, body.propertyId])
      if (subs.length !== new Set(wantedSubtypes).size) {
        throw new AppError(404, 'Subtype not found on this property')
      }
      const types = new Set(subs.map((x) => x.unit_type))
      if (types.size > 1) {
        throw new AppError(400,
          `Those subtypes are for different kinds of unit (${[...types].map((t) => String(t).replace(/_/g, ' ')).join(', ')}). ` +
          `Pick ones that belong to the same kind.`)
      }
    }
    const sub: any = subs[0] ?? null

    // S537 (Nic): a subtype LOCKS the unit type — "Back-in 30 amp" can
    // only ever mint an rv_spot. A conflicting explicit unitType in the
    // body is a client bug, not a preference; refuse rather than pick.
    if (sub && body.unitType && body.unitType !== sub.unit_type) {
      throw new AppError(400,
        `Subtype "${sub.name}" is a ${String(sub.unit_type).replace(/_/g, ' ')} subtype — it cannot create a ${String(body.unitType).replace(/_/g, ' ')} unit. Pick a matching subtype or clear the unit type.`)
    }
    const unitType = sub?.unit_type ?? body.unitType ?? 'apartment'
    // S537 gate: no units of an UNDECIDED late-fee class. The landlord
    // must hold an explicit (property, unit_type) decision — fee terms or
    // "no late fee" — before this class can exist at the property.
    await assertLateFeeDecision(body.propertyId, unitType)
    const num = (v: any) => v == null ? null : Number(v)
    // S630 DIRECTIVE (Nic): A SUBTYPE NEVER PRICES A UNIT.
    //
    // "Subtypes should not price the unit. People can bulk set a price when they
    //  are adding new units, and it would look on the surface like the subtype is
    //  pricing the unit... but it needs to not be linked to that subtype feature.
    //  That way they can be independently adjusted. Maybe one spot's bigger and
    //  worth more, maybe one spot's tiny or inconvenient so they get a deal — it
    //  doesn't change the fact that it's a pull through or a fifty amp spot."
    //
    // A bulk create sets one price across the batch, which LOOKS like the subtype
    // priced them; it did not. The price is the unit's from the moment it exists,
    // and moving one spot's rent must never move another's or drag the class with
    // it. So the price comes from the request and nowhere else.
    const rentAmount = body.rentAmount ?? null
    if (rentAmount == null || rentAmount <= 0) {
      throw new AppError(400, 'A rent amount is required for each unit.')
    }
    const securityDeposit = body.securityDeposit ?? 0
    const bedrooms  = body.bedrooms ?? (sub?.bedrooms ?? 1)
    const bathrooms = body.bathrooms ?? num(sub?.bathrooms) ?? 1
    // RV sub-type fields only apply to rv_spot units; storage size to storage.
    const rvLayout = unitType === 'rv_spot' ? (body.rvSiteLayout ?? sub?.rv_site_layout ?? 'none') : 'none'
    const rvAmp    = unitType === 'rv_spot' ? (body.rvAmpService ?? sub?.rv_amp_service ?? 'none') : 'none'
    const storageSize = unitType === 'storage' ? (body.storageSize?.trim() || sub?.storage_size || null) : null
    // Same rule for short-stay rates — the subtype describes the space, it does
    // not set what the space costs.
    const nightlyRate = body.nightlyRate ?? null
    const weeklyRate  = body.weeklyRate  ?? null
    const monthlyRate = body.monthlyRate ?? null
    // S526 (Nic): every RV site is short- AND long-term capable by default —
    // bookable, all stay lengths allowed. Landlord can narrow later.
    const isRv = unitType === 'rv_spot'
    // S550 default (Nic): parks mostly do NOT own the dwellings — rv_spot
    // AND mobile_home default TENANT-owned (space rent only); the subtype's
    // ownership wins when set; park-owned rentals are the explicit exception.
    const dwellingOwnership = body.dwellingOwnership
      ?? sub?.dwelling_ownership
      ?? ((isRv || unitType === 'mobile_home') ? 'tenant' : 'landlord')
    // S573: stairs & accessibility areas only exist on interior residential
    // types. These flags on an RV pad / storage unit are meaningless — force
    // false there so a mis-set flag never adds an irrelevant area.
    const INTERIOR_RESIDENTIAL_TYPES = ['apartment', 'single_family', 'mobile_home']
    const isInteriorResidential = INTERIOR_RESIDENTIAL_TYPES.includes(unitType)
    const isMultiLevel = isInteriorResidential ? (body.isMultiLevel ?? false) : false
    const isAdaAccessible = isInteriorResidential ? (body.isAdaAccessible ?? false) : false
    // S573: floor placement — meaningful for building units only (not RV/storage).
    const FLOOR_LEVEL_TYPES = ['apartment', 'single_family', 'mobile_home', 'hotel_room', 'commercial']
    const floorLevel = FLOOR_LEVEL_TYPES.includes(unitType) ? (body.floorLevel ?? null) : null
    // S573: living-area count + feature map (sanitized to keys offered for the type).
    const livingAreas = isInteriorResidential ? (body.livingAreas ?? 1) : 1
    const offeredKeys = new Set(UNIT_FEATURE_CATALOG.filter(f => f.types.includes(unitType)).map(f => f.key))
    const features: Record<string, boolean> = {}
    if (body.features) for (const [k, v] of Object.entries(body.features)) if (offeredKeys.has(k)) features[k] = !!v

    // S605 (Nic): the field means ONE thing everywhere — the unit NUMBER. The
    // prefix comes from the unit type, and for a batch the number is the
    // STARTING point that the counter runs on from.
    const unitNumbers: string[] = []
    if (body.quantity > 1) {
      // The prefix is the unit TYPE's, platform-wide — never what was typed.
      // "I don't want it to be mobile home site one spelled out on one property
      // and MH one on a different property."
      const pfx = (UNIT_TYPE_PREFIX as any)[unitType] ?? formatUnitNumber(body.unitNumber)
      const existing = await query<{ unit_number: string }>(
        `SELECT unit_number FROM units WHERE property_id=$1 AND LOWER(unit_number) LIKE LOWER($2)`,
        [body.propertyId, `${pfx} %`]
      )
      const nums = existing.map(r => { const m = r.unit_number.match(/\s(\d+)$/); return m ? parseInt(m[1]) : 0 })
      // When the prefix moved to the unit type, nothing took over reading the
      // typed value — so a landlord entering "1" as their starting number had it
      // silently discarded and got numbering continued from somewhere else.
      // The typed number wins; startAt stays as the explicit override; otherwise
      // continue after the highest existing number with this prefix.
      const typedStart = /^\d+$/.test(String(body.unitNumber ?? '').trim())
        ? parseInt(String(body.unitNumber).trim(), 10)
        : null
      const start = typedStart ?? body.startAt ?? (nums.length ? Math.max(...nums) + 1 : 1)
      // S605 (Nic, DIRECTIVE): "I want consistency platform wide. Remove those
      // number padding options." Padding is FIXED at two digits — a per-batch
      // choice meant one property could render "RV 8" while another rendered
      // "RV 08", which is the same drift the standard prefixes just ended.
      // padWidth is still accepted so older clients don't 400; it is ignored.
      const pad = 2
      for (let i = 0; i < body.quantity; i++) {
        unitNumbers.push(`${pfx} ${String(start + i).padStart(pad, '0')}`)
      }
    } else {
      // Canonical form: standard prefix + identifier, single digits zero-padded.
      // Accepts "7", "RV 7" or "Space 7" and stores "RV 07" for all three.
      unitNumbers.push(canonicalUnitNumber(unitType as any, body.unitNumber))
    }

    // S605: no bare-number guard is needed here any more — canonicalUnitNumber
    // supplies the unit type's standard prefix, so "37" becomes "RV 37" and a
    // prefix-less name can no longer be constructed. Enforced by construction
    // rather than by rejection.

    // S613 (Nic): a subtype is OPTIONAL. With one, the unit takes the class's
    // price and every unit in that class matches. Without one, the unit carries
    // its own price — which is why a landlord adding a single unit never has to
    // learn what a subtype is.
    const created: any[] = []
    for (const unitNumber of unitNumbers) {
      // W-16: the units_property_unit_number_uniq index rejects duplicate
      // numbers at a property — surface it as a friendly 409, not a 500.
      try {
      // S616 (Nic): ONE source of truth, shared with PATCH /:id/type below.
      // This used to read "nightly/weekly unless short-stay-locked", and only
      // STORAGE is locked — so every mobile home, apartment, house and
      // commercial space was created bookable by the night. All eight of Oak
      // Park's mobile home spaces came out that way and nobody asked for it.
      //
      // A home-shaped unit is long-term until an operator turns short stays on:
      // "Short term stays is not gonna be the bulk of the people using this
      // software. So they have to manually select that."
      const leaseTypesAllowed = leaseTypesForUnitType(unitType, !!body.isBookable)
      const [unit] = await query<any>(`
        INSERT INTO units (property_id, landlord_id, unit_number, building, unit_type, bedrooms, bathrooms, sqft,
                           rent_amount, security_deposit, rv_site_layout, rv_amp_service,
                           nightly_rate, weekly_rate, monthly_rate, storage_size, subtype_id, status,
                           is_bookable, lease_types_allowed, dwelling_ownership, lot_rent_amount, is_multi_level, is_ada_accessible, floor_level, living_areas, features, owner_household_size, occupancy_mode)
        VALUES ($1,$2,$3,$28,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                $18, $19::text[], $20, $21, $22, $23, $24, $25, $26::jsonb, $27,
                -- S558: new unit inherits the property's default occupancy mode
                -- (a seed, not a governing setting — the unit owns it after).
                (SELECT default_occupancy_mode FROM properties WHERE id=$1))
        RETURNING *`,
        [body.propertyId, prop.landlord_id, unitNumber, unitType, bedrooms,
         bathrooms, body.sqft ?? null, rentAmount, securityDeposit, rvLayout, rvAmp,
         nightlyRate, weeklyRate, monthlyRate, storageSize, sub?.id ?? null, body.status,
         // S616: bookable by DEFAULT only for the types that are short-stay by
         // nature. A house or a mobile home starts closed and the operator opens
         // it; an RV spot or campsite is open the day it is created.
         body.isBookable ?? isShortStayByNature(unitType), leaseTypesAllowed, dwellingOwnership, body.lotRentAmount ?? 0, isMultiLevel, isAdaAccessible, floorLevel, livingAreas, JSON.stringify(features),
         body.ownerHouseholdSize ?? 1,
         // $28 — the building. Trimmed to NULL so blank and absent are the
         // same thing; the unique index treats them as one.
         (body.building ?? null) ? String(body.building).trim() || null : null]
      )
      // S630: link EVERY selected subtype. units.subtype_id above holds the
      // first one for readers not yet moved over; unit_subtype_links is the
      // source of truth for what a space actually is.
      if (subs.length) {
        await query(
          `INSERT INTO unit_subtype_links (unit_id, subtype_id)
           SELECT $1, s FROM unnest($2::uuid[]) s ON CONFLICT DO NOTHING`,
          [unit.id, subs.map((x: any) => x.id)])
      }
      created.push(unit)
      } catch (err: any) {
        // Two guards can fire: the pre-existing exact-case
        // units_property_id_unit_number_key, or the S529 case-insensitive
        // units_property_unit_number_uniq ("apt 204" vs "Apt 204").
        if (err?.code === '23505' && /unit_number/.test(err?.constraint || '')) {
          throw new AppError(409, `Unit "${unitNumber}" already exists at this property`)
        }
        throw err
      }
    }

    // Keep the property's unit_types chips accurate (the removed bulk route
    // did this; the single-unit path never had — fix-it-right).
    await query(
      `UPDATE properties
          SET unit_types = (SELECT array_agg(DISTINCT t) FROM unnest(COALESCE(unit_types,'{}') || $1::text) AS t)
        WHERE id = $2`,
      [unitType, body.propertyId]
    )

    res.status(201).json({ success: true, data: created.length === 1 ? created[0] : { created: created.length, units: created } })
  } catch (e) { next(e) }
})

// ─── S604 (Nic): RENAME + DELETE ────────────────────────────────────────────
// Neither existed. A unit's number was permanent from creation and there was no
// way to remove one created by mistake — "accidental creation just means I have
// to, what, delete a whole thing... that's not a good look."
//
// Renaming is safe at the data layer: invoices, leases, payments and meters all
// reference unit_id, never the number. The only constraint is the unique index
// on (property_id, lower(trim(unit_number))).

/** S604: does this unit carry history that must stay attached to it?
 *  Used by BOTH rename and delete. Nic's rule: a unit is freely editable during
 *  onboarding, and permanent the moment anything real touches it — a lease of
 *  ANY status (including ended), a booking, a payment, a deposit, a meter link
 *  or a maintenance request. */
async function unitHistoryBlocker(unitId: string): Promise<string | null> {
  const probes: Array<{ label: string; sql: string }> = [
    { label: 'a lease',               sql: 'SELECT 1 FROM leases WHERE unit_id=$1 LIMIT 1' },
    { label: 'a payment',             sql: 'SELECT 1 FROM payments WHERE unit_id=$1 LIMIT 1' },
    { label: 'a booking',             sql: 'SELECT 1 FROM unit_bookings WHERE unit_id=$1 LIMIT 1' },
    { label: 'a security deposit',    sql: 'SELECT 1 FROM security_deposits WHERE unit_id=$1 LIMIT 1' },
    // S605 (Nic): a meter LINK is not history — it is setup. Bulk-adding RV
    // sites with electric submetering attached a meter to every unit, which
    // then froze the numbers: "I cannot renumber the units even though no bills
    // have gone out, no anything." Renumbering during onboarding is normal —
    // gaps, and blocks like 14/14A, only become obvious once the list is on
    // screen.
    //
    // A meter blocks only once it carries something real: a READING or a BILL.
    // Until then the unit is still being set up, which is exactly the rule this
    // function was written to express.
    // S630: this asked whether the METER had readings, not whether the UNIT did.
    // A space on a shared RUBS master became undeletable the moment anyone read
    // that master for any neighbor — history belonging to other units, blocking
    // a unit that has none of its own. Nic hit it retiring RV 21, which slipped
    // through only because Oak Park's water masters had not been read yet; the
    // first master reading would have walled off every unit on the meter.
    //
    // What is genuinely this unit's history: a bill raised against it, or a
    // reading on a meter that serves ONLY it (a dedicated submeter, where the
    // meter's readings are the unit's readings).
    { label: 'a utility meter with readings',
      sql: `SELECT 1 FROM utility_meter_units mu
             WHERE mu.unit_id = $1
               AND (
                 EXISTS (SELECT 1 FROM utility_bills b WHERE b.unit_id = $1)
                 OR (
                   EXISTS (SELECT 1 FROM utility_meter_readings r
                            WHERE r.meter_id = mu.meter_id)
                   AND (SELECT COUNT(*) FROM utility_meter_units mu2
                         WHERE mu2.meter_id = mu.meter_id) = 1
                 )
               )
             LIMIT 1` },
    { label: 'a maintenance request', sql: 'SELECT 1 FROM maintenance_requests WHERE unit_id=$1 LIMIT 1' },
  ]
  for (const p of probes) {
    if (await queryOne<any>(p.sql, [unitId])) return p.label
  }
  return null
}

/**
 * GET /api/units/:id/number-history — what this space has been called.
 *
 * Nic: "show a timeline of: this was classified as unit one up until this date,
 * and it's been since changed to unit number two."
 *
 * Newest first, with the live period's `effectiveTo` null.
 */
unitsRouter.get('/:id/number-history', requirePerm('units.view'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT id, landlord_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(
      `SELECT h.unit_number, h.building, h.effective_from, h.effective_to, h.reason,
              u.first_name || ' ' || u.last_name AS changed_by
         FROM unit_number_history h
         LEFT JOIN users u ON u.id = h.changed_by_user_id
        WHERE h.unit_id = $1
        ORDER BY h.effective_from DESC`, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/number — renumber a unit.
unitsRouter.patch('/:id/number', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const { unitNumber } = z.object({ unitNumber: z.string().min(1).max(40) }).parse(req.body)
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const next_ = canonicalUnitNumber(unit.unit_type, unitNumber)
    if (next_.toLowerCase() === String(unit.unit_number).toLowerCase()) {
      return res.json({ success: true, data: unit })   // no-op
    }

    // S641 (Nic): renaming is ALLOWED again, because the reason it was blocked
    // has been fixed rather than worked around.
    //
    //   "I don't know why we're retiring units and replacing… would we just say
    //    that we're changing the unit number in the system — show a timeline of:
    //    this was classified as unit one up until this date, and it's been since
    //    changed to unit number two."
    //
    // S604 blocked it because nothing snapshotted unit_number: every invoice
    // rendered the CURRENT value, so a rename rewrote years of paperwork while
    // the signed PDF kept the original. True then. `unit_number_history` now
    // records each period a space carried a number, maintained by a database
    // trigger so an importer or a script cannot skip it, and `unit_number_on()`
    // answers what it was called on any given date. The history survives the
    // rename, so the rename is safe.
    //
    // Retire-and-replace keeps its own job: a space that genuinely BECOMES a
    // different space — a double lot split in two, two apartments combined.
    // That is not renumbering, and the two were conflated.
    // Surface the collision as a friendly 409 rather than a 500 from the index.
    const clash = await queryOne<{ id: string }>(
      `SELECT id FROM units
        WHERE property_id = $1 AND lower(btrim(unit_number)) = lower(btrim($2)) AND id <> $3`,
      [unit.property_id, next_, req.params.id])
    if (clash) {
      throw new AppError(409, `"${next_}" is already used by another unit on this property. Unit numbers are unique per property regardless of unit type — use a prefix (e.g. "RV 01" vs "MH 01") if two types share a number.`)
    }
    const [updated] = await query<any>(
      `UPDATE units SET unit_number=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [next_, req.params.id])

    // S605: meter labels are generated as "<unit number> <utility>" when a unit
    // is created, so a renumber leaves them pointing at the OLD number — the
    // reading run would then send someone to "RV 03 electric" for a spot now
    // called RV 14. Only labels still matching the generated pattern are
    // rewritten; anything the landlord renamed by hand is theirs and is left
    // alone.
    const relabeled = await query<{ id: string }>(
      `UPDATE utility_meters m
          SET label = $3 || substring(m.label from char_length($2) + 1), updated_at = NOW()
        FROM utility_meter_units mu
       WHERE mu.meter_id = m.id
         AND mu.unit_id = $1
         AND lower(m.label) LIKE lower($2) || ' %'
       RETURNING m.id`,
      [req.params.id, unit.unit_number, next_])

    res.json({ success: true, data: updated, metersRelabeled: relabeled.length })
  } catch (e) { next(e) }
})

// DELETE /api/units/:id — remove a unit created by mistake.
//
// GAM never erases data (retention rule), so this is deliberately NOT a general
// delete: it is refused the moment a unit has ANY history. A unit with a lease,
// payment, booking, deposit or meter link carries records that must survive, and
// those are handled by taking the unit out of service, not by deleting it.
unitsRouter.delete('/:id', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const blocker = await unitHistoryBlocker(req.params.id)
    if (blocker) {
      throw new AppError(409,
        `This unit has ${blocker} on record, so it can't be deleted — GAM keeps that history. ` +
        `Take it out of service instead (set it vacant, or owner-use if you occupy it).`)
    }
    await query('DELETE FROM units WHERE id=$1', [req.params.id])
    res.json({ success: true, data: { deleted: true } })
  } catch (e) { next(e) }
})

// ── S605: RETIRE & REPLACE (Nic's design, decided S604) ───────────────────
//
// A unit that carries data can't be renumbered (nothing snapshots unit_number,
// so a rename rewrites how years of records display). Instead the one physical
// space becomes two records: retire the old, create the replacement under the
// new number, link them both ways. History stays exactly where it was written.
//
// The replacement inherits every physical/pricing attribute. That list is
// explicit rather than `SELECT *` because a handful of columns MUST NOT carry
// over — and `unitCloneColumns.test.ts` fails if a new `units` column is added
// without being classified here, so the list can't silently go stale.

/** Columns copied verbatim onto the replacement unit. */
export const UNIT_CLONE_COPIED = [
  'property_id', 'landlord_id', 'bedrooms', 'bathrooms', 'sqft',
  'rent_amount', 'security_deposit', 'listed_vacant', 'available_date',
  'listing_description', 'unit_type', 'nightly_rate', 'weekly_rate',
  'monthly_rate', 'is_bookable', 'lease_types_allowed', 'check_in_time',
  'check_out_time', 'amenities', 'unit_description', 'min_stay_nights',
  'max_stay_nights', 'import_extra_data', 'rv_site_layout', 'rv_amp_service',
  'storage_size', 'subtype_id', 'dwelling_ownership', 'occupancy_mode',
  'lot_rent_amount', 'is_multi_level', 'is_ada_accessible', 'floor_level',
  'features', 'living_areas',
  // S641: the building COPIES. Retire-and-replace is the same physical space
  // under a new number, and a space does not move between buildings when it is
  // renumbered. The drift guard caught this one too.
  'building',
  // S609: added by the S608 utility work and never classified — the drift guard
  // caught it. It COPIES: how many water fixtures a space has is a fact about
  // the physical space, and retire-and-replace is the same space under a new
  // number. Left uncopied it would silently reset to nothing, and a unit on a
  // fixture-count water split would then contribute zero — under-billing that
  // unit and over-billing every neighbor on the same meter.
  'water_fixture_count',
  // S609: same reasoning. Retire-and-replace is a RENUMBERING of one physical
  // space, not a turnover — the same household is still in it. Resetting this to
  // 1 would silently shrink an owner-occupied unit's share of a utility split
  // the next time it is marked owner-occupied, pushing the difference onto the
  // tenants. (Status itself still resets to vacant; this is a fact about the
  // household preserved, not an occupancy state carried over.)
  'owner_household_size',
  'owner_occupant_name', 'owner_occupant_phone', 'owner_occupant_email',
  // S613: the propane tank is bolted to the space, and retire-and-replace is
  // that same space under a new number. Left uncopied, the replacement would
  // drop off the Record Delivery form and the next fill would have nowhere to
  // go — the renumbering would silently un-plumb the site.
  'has_propane_tank',
] as const

/**
 * Columns deliberately NOT copied, with the reason each is reset.
 * Keyed so the drift test can assert every units column is accounted for.
 */
export const UNIT_CLONE_RESET: Record<string, string> = {
  id:                      'new identity',
  unit_number:             'the whole point — the replacement takes the new number',
  // S652: the park's own word for the space does NOT carry. Retire-and-replace
  // is a RENUMBERING, and the sign on the space usually changed with it — so a
  // copied label would print "Lot 7" on a lease for the space the system now
  // calls MH 12. Blank degrades to the canonical name, which is always true;
  // stale prints a wrong number on a signed document. The landlord re-enters it
  // if the sign really did stay the same.
  display_label:           'the printed name follows the sign, and a renumbered space usually gets a new one',
  created_at:              'the replacement is created now',
  updated_at:              'the replacement is created now',
  status:                  "starts 'vacant' — a fresh unit holds no lease",
  retired_at:              'the replacement is live',
  superseded_by_unit_id:   'nothing supersedes the replacement yet',
  replaces_unit_id:        'set to the retired unit',
  payment_block:           'eviction state belongs to the old tenancy, never carried',
  payment_block_set_at:    'eviction state belongs to the old tenancy, never carried',
  payment_block_set_by:    'eviction state belongs to the old tenancy, never carried',
  status_before_block:     'eviction state belongs to the old tenancy, never carried',
  scheduled_activation_at: 'a pending activation refers to the old record',
  scheduled_activation_by: 'a pending activation refers to the old record',
  on_time_pay_active:      'an enrollment belongs to the old unit/tenancy',
}

// POST /api/units/:id/retire — retire this unit; optionally create its replacement.
//
// S629 (Nic): "RV 21 actually needs to be deleted — that is not an actual site
// anymore, it's been removed. So it skips from 20 to 22."
//
// Retiring REQUIRED a replacement number, which covers a renumbering but not a
// space that is simply gone. A removed site could then be neither retired (no
// replacement exists) nor deleted (DELETE refuses the moment there is history),
// leaving a phantom space listed as vacant and bookable forever. Omit
// `unitNumber` and the unit retires on its own: retired_at is what makes "never
// billed" structural, so a decommissioned site stops being billable either way.
// S649 (Nic): "we need a way to mark RV sites out of order." A window during
// which the site can't take a stay; the schedule, the booking site and staff
// bookings all route around it (services/outOfOrder).
unitsRouter.get('/:id/out-of-order', async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT landlord_id, property_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, unit.property_id)
    const rows = await query<any>(
      `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
              reason, created_at
         FROM unit_out_of_order WHERE unit_id = $1 AND cleared_at IS NULL
          AND (ends_on IS NULL OR ends_on > CURRENT_DATE)
        ORDER BY starts_on`, [req.params.id])
    // S652: ?history=1 adds the outages that are over. The plain list stays
    // what it was — open windows only — because that is what the agent and the
    // "back in service" button act on.
    if (req.query.history === '1') {
      const { outOfOrderHistoryForUnit } = await import('../services/outOfOrder')
      return res.json({ success: true, data: { open: rows, history: await outOfOrderHistoryForUnit(req.params.id) } })
    }
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

unitsRouter.post('/:id/out-of-order', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      endsOn:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      reason:   z.string().trim().max(500).nullish(),
    }).parse(req.body)
    const unit = await queryOne<any>('SELECT landlord_id, property_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, unit.property_id)
    if (body.startsOn && body.endsOn && body.endsOn <= body.startsOn) {
      throw new AppError(400, 'The back-in-service date has to be after the start date')
    }
    const { markOutOfOrder } = await import('../services/outOfOrder')
    const row = await markOutOfOrder({
      unitId: req.params.id, landlordId: unit.landlord_id, userId: req.user!.userId,
      startsOn: body.startsOn, endsOn: body.endsOn, reason: body.reason,
    })
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

unitsRouter.post('/:id/out-of-order/:oooId/clear', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT landlord_id, property_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, unit.property_id)
    const { clearOutOfOrder } = await import('../services/outOfOrder')
    res.json({ success: true, data: await clearOutOfOrder({
      id: req.params.oooId, landlordId: unit.landlord_id, userId: req.user!.userId }) })
  } catch (e) { next(e) }
})

unitsRouter.post('/:id/retire', requirePerm('units.edit'), async (req, res, next) => {
  try {
    const { unitNumber, reason } = z.object({
      // Omitted → the space is gone, not renumbered. No replacement is made.
      unitNumber: z.string().min(1).max(40).optional(),
      reason:     z.string().trim().max(500).optional(),
    }).parse(req.body)

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    if (unit.retired_at) throw new AppError(409, 'This unit is already retired.')

    const newNumber = unitNumber ? formatUnitNumber(unitNumber) : null
    if (newNumber) {
      if (newNumber.toLowerCase() === String(unit.unit_number).toLowerCase()) {
        throw new AppError(400, 'The replacement needs a different number — retiring a unit to the same number would leave two records claiming it.')
      }
      const clash = await queryOne<{ id: string }>(
        `SELECT id FROM units WHERE property_id = $1 AND lower(btrim(unit_number)) = lower(btrim($2))`,
        [unit.property_id, newNumber])
      if (clash) throw new AppError(409, `"${newNumber}" is already used by another unit on this property.`)
    }

    // The unit must be FREE before it retires. This is what makes "a retired
    // unit is never billed" structural rather than a filter we have to remember:
    // platform-fee billing counts units with an ACTIVE LEASE plus short-stay
    // booking nights, and the DB triggers block any NEW lease or booking once
    // retired_at is set. End or transfer the tenancy first.
    const liveLease = await queryOne<{ id: string }>(
      `SELECT id FROM leases WHERE unit_id=$1 AND status IN ('active','pending') LIMIT 1`, [req.params.id])
    if (liveLease) {
      throw new AppError(409,
        'This unit still has an active or pending lease. End or transfer the tenancy before retiring it, ' +
        'so the replacement starts clean and nothing keeps billing against the old record.')
    }
    const futureBooking = await queryOne<{ id: string }>(
      `SELECT id FROM unit_bookings
        WHERE unit_id=$1 AND status NOT IN ('cancelled','no_show') AND check_out > now() LIMIT 1`,
      [req.params.id])
    if (futureBooking) {
      throw new AppError(409,
        'This unit has an upcoming booking. Move or cancel it before retiring the unit — a retired unit can’t be checked into.')
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const cols = UNIT_CLONE_COPIED.join(', ')
      let replacement: any = null
      if (newNumber) {
        ;[replacement] = await client.query<any>(
          `INSERT INTO units (unit_number, status, replaces_unit_id, ${cols})
           SELECT $2, 'vacant', $1, ${cols} FROM units WHERE id = $1
           RETURNING *`,
          [req.params.id, newNumber]
        ).then((r: any) => r.rows)
      }

      const [retired] = await client.query<any>(
        `UPDATE units
            SET retired_at = now(), superseded_by_unit_id = $2,
                listed_vacant = FALSE, is_bookable = FALSE, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [req.params.id, replacement?.id ?? null]
      ).then((r: any) => r.rows)

      // A space that is gone must stop appearing on the meters it shared, or it
      // keeps showing on reading runs and rosters as a site somebody has to go
      // and read. Only safe because a meter LINK is setup, not history — the
      // readings and bills themselves reference the meter, not this link.
      if (!newNumber) {
        await client.query(`DELETE FROM utility_meter_units WHERE unit_id = $1`, [req.params.id])
      }

      await client.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_value, new_value)
         VALUES ($1, 'unit_retired', 'unit', $2, $3::jsonb, $4::jsonb)`,
        [req.user!.userId, req.params.id,
         JSON.stringify({ unit_number: unit.unit_number }),
         JSON.stringify({ replacement_unit_id: replacement?.id ?? null,
                          unit_number: newNumber, decommissioned: !newNumber,
                          reason: reason ?? null })]
      ).catch(() => {})

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { retired, replacement } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/status — set unit status
unitsRouter.patch('/:id/status', requirePerm('units.set_status'), async (req, res, next) => {
  try {
    const { status } = z.object({
      status: z.enum([...UNIT_STATUSES] as [string, ...string[]])
    }).parse(req.body)

    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // 'suspended' is coupled 1:1 to eviction mode (see POST /:id/eviction-mode).
    // It can't be set directly, and a unit that IS suspended can't be moved off
    // 'suspended' here — both directions go through the eviction-mode toggle so
    // status and payment_block never desync.
    if (status === 'suspended') {
      throw new AppError(400, "Use eviction mode to suspend a unit — 'suspended' can't be set directly")
    }
    if (unit.status === 'suspended') {
      throw new AppError(400, 'This unit is in eviction mode. Turn eviction mode off to change its status')
    }
    // S604: 'owner_use' means the OWNER occupies it — no lease, no rent. A unit
    // with a live lease has a tenant in it, so the two states are mutually
    // exclusive. Enforced rather than documented: without this a landlord could
    // flip an occupied, rent-paying unit to owner_use and keep the tenancy
    // while dropping out of every revenue-shaped aggregate.
    if (status === 'owner_use') {
      const live = await queryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM leases
          WHERE unit_id = $1 AND status IN ('active','pending')`,
        [req.params.id],
      )
      if (Number(live?.n ?? 0) > 0) {
        throw new AppError(400, 'This unit has an active or pending lease. End the lease before marking it owner-occupied.')
      }
    }
    // Setting owner_use also takes the unit off the market: it is neither
    // listed to renters nor bookable for short stays. Leaving those flags set
    // would keep an owner-occupied unit accepting reservations.
    const [updated] = await query<any>(
      `UPDATE units
          SET status = $1,
              listed_vacant = CASE WHEN $1 = 'owner_use' THEN FALSE ELSE listed_vacant END,
              is_bookable   = CASE WHEN $1 = 'owner_use' THEN FALSE ELSE is_bookable   END,
              updated_at = NOW()
        WHERE id = $2 RETURNING *`, [status, req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/eviction-mode — Eviction mode — HARD BLOCK all tenant ACH
// Hard-blocks tenant ACH while eviction is active. Landlord is responsible for knowing their local eviction rules.
unitsRouter.post('/:id/eviction-mode', requirePerm('units.eviction_mode'), async (req, res, next) => {
  try {
    const { enable, confirm } = z.object({
      enable:  z.boolean(),
      confirm: z.boolean().refine(v => v === true, 'Must confirm eviction mode')
    }).parse(req.body)

    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    // Eviction mode is high-stakes and legally fraught — landlord/admin only.
    if (!canManageLandlordResource(req.user, unit.landlord_id, [])) {
      throw new AppError(403, 'Forbidden')
    }

    // S400 fix: cast $2 to uuid. Postgres can't infer the type of a
    // parameter that only appears inside a CASE expression assigned to a
    // typed column, so pre-fix this UPDATE returned 42804 "column
    // payment_block_set_by is of type uuid but expression is of type
    // text" → 500 on every call. The eviction-mode toggle was effectively
    // non-functional before this cast.
    // Eviction mode is coupled 1:1 to the 'suspended' unit status. Turning it
    // ON suspends the unit (saving the prior status so we can restore it);
    // turning it OFF restores that prior status. A unit is 'suspended' iff
    // eviction mode is on — 'suspended' is never set any other way. All SET
    // RHS expressions read the OLD row, so `status` / `status_before_block`
    // below reference the pre-update values.
    const [updated] = await query<any>(`
      UPDATE units
      SET payment_block = $1,
          payment_block_set_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
          payment_block_set_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
          status = CASE
                     WHEN $1 AND status <> 'suspended' THEN 'suspended'
                     WHEN NOT $1 AND status = 'suspended' THEN COALESCE(status_before_block, 'active')
                     ELSE status
                   END,
          status_before_block = CASE
                     WHEN $1 AND status <> 'suspended' THEN status
                     WHEN NOT $1 AND status = 'suspended' THEN NULL
                     ELSE status_before_block
                   END
      WHERE id = $3
      RETURNING *`,
      [enable, req.user!.userId, req.params.id]
    )
    res.json({
      success: true,
      data: updated,
      message: enable
        ? '⚠️ EVICTION MODE ACTIVE — All tenant ACH hard blocked. Check your local laws before accepting any payment.'
        : 'Eviction mode deactivated — ACH collections resumed'
    })
  } catch (e) { next(e) }
})

// GET /api/units/:id/economics
unitsRouter.get('/:id/economics', async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id = $1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    // Per-unit P&L view is financial — landlord/admin only.
    if (!canViewLandlordFinances(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM units WHERE landlord_id = $1 AND status = $2', [unit.landlord_id, 'active'])
    const { rate } = getReservePhase(count)
    const econ = calcNetPerUnit(unit.rent_amount, rate)
    // Launch fee model (walkthrough #34): flat $2 per OCCUPIED unit, vacant
    // $0 — retires the old $15/$5 OTP/direct tiers. The $10/property minimum
    // is a per-property accrual floor, not attributable to a single unit, so
    // the per-unit lifetime fee is just $2 × occupied months. Occupied =
    // active + delinquent + suspended (rent-obligation principle): the real
    // accrual in services/platformFee.ts counts by active LEASE, which those
    // statuses all still carry — pre-W-15 this preview showed $0 for
    // delinquent/suspended units while the accrual charged them.
    const fee = ['active', 'delinquent', 'suspended'].includes(unit.status)
      ? LAUNCH_PLATFORM_FEE.PER_OCCUPIED_UNIT : 0
    const feeNum = Number(fee)
    const ps = await queryOne("SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) as total_collected, COALESCE(SUM(amount) FILTER (WHERE status = 'settled' AND due_date >= date_trunc('month', NOW())), 0) as this_month, COALESCE(SUM(amount) FILTER (WHERE status = 'settled' AND due_date >= date_trunc('year', NOW())), 0) as this_year, COUNT(*) FILTER (WHERE status = 'settled') as settled_count, COUNT(*) FILTER (WHERE status = 'failed') as failed_count, MIN(due_date) as first_payment FROM payments WHERE unit_id = $1", [req.params.id])
    const ms = await queryOne("SELECT COALESCE(SUM(actual_cost), 0) as total_cost, COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) as this_month_cost, COUNT(*) as total_requests FROM maintenance_requests WHERE unit_id = $1", [req.params.id])
    const fp = ps && ps.first_payment ? new Date(ps.first_payment) : null
    const months = fp ? Math.floor((Date.now() - fp.getTime()) / (1000*60*60*24*30)) : 0
    const lc = parseFloat(ps && ps.total_collected || 0)
    const lm = parseFloat(ms && ms.total_cost || 0)
    // S603: `econ` (calcNetPerUnit) is GAM's OWN margin math — gross platform
    // fee, GAM's Stripe cost, GAM's reserve rate and net kept. That is GAM's
    // markup, and it must never reach a landlord (same rule the agents run
    // under). The landlord portal renders none of it; it was only ever leaking
    // over the wire. Admin keeps the full view.
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    const gamInternals = isAdmin ? { ...econ, reserveRate: rate } : {}
    res.json({ success: true, data: { ...gamInternals, platformFee: fee, occupiedPortfolio: count, netRentMonthly: unit.rent_amount - feeNum, netRentYearly: (unit.rent_amount - feeNum) * 12, netThisMonth: parseFloat(ps && ps.this_month || 0) - feeNum - parseFloat(ms && ms.this_month_cost || 0), netThisYear: parseFloat(ps && ps.this_year || 0) - (feeNum*12) - lm, tenantMonths: months, lifetimeCollected: lc, lifetimeMaintCost: lm, lifetimeNet: lc - (feeNum*months) - lm, lifetimePlatformFees: feeNum*months, settledCount: parseInt(ps && ps.settled_count || 0), failedCount: parseInt(ps && ps.failed_count || 0), totalRequests: parseInt(ms && ms.total_requests || 0) } })
  } catch (e) { next(e) }
})

// ── UNIT TYPE + SHORT-TERM CONFIG ─────────────────────────────

// S616: LEASE_TYPE_MATRIX lived here and disagreed with the create path above.
// Both now call leaseTypesForUnitType from @gam/shared. The old matrix was also
// keyed on 'residential' and 'short_term_cabin' — neither of which is a
// unit_type the database accepts, so those entries were only ever reachable as
// a fallback.

// PATCH /api/units/:id/type — set unit type and rates
unitsRouter.patch('/:id/type', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const { unitType, nightlyRate, weeklyRate, monthlyRate, minStayNights, maxStayNights,
            checkInTime, checkOutTime, amenities, unitDescription, isBookable, rvSiteLayout, rvAmpService,
            dwellingOwnership, occupancyMode, lotRentAmount, isMultiLevel, isAdaAccessible } = req.body

    if (rvSiteLayout != null && !RV_SITE_LAYOUTS.includes(rvSiteLayout)) {
      throw new AppError(400, `Invalid rvSiteLayout '${rvSiteLayout}'`)
    }
    // S558: occupancy mode — whole_unit (one lease) vs by_room (stacked leases).
    if (occupancyMode != null && !(OCCUPANCY_MODES as readonly string[]).includes(occupancyMode)) {
      throw new AppError(400, `Invalid occupancyMode '${occupancyMode}'`)
    }
    if (dwellingOwnership != null && !(DWELLING_OWNERSHIP_VALUES as readonly string[]).includes(dwellingOwnership)) {
      throw new AppError(400, `Invalid dwellingOwnership '${dwellingOwnership}'`)
    }
    if (rvAmpService != null && !RV_AMP_SERVICES.includes(rvAmpService)) {
      throw new AppError(400, `Invalid rvAmpService '${rvAmpService}'`)
    }

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // S538 (Nic): storage can never be publicly bookable (the public flow
    // auto-tiers nightly/weekly pricing — is_bookable IS the short-stay gate).
    if ((SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unitType || 'residential') && isBookable) {
      throw new AppError(400, 'Storage units cannot be made bookable for short-term stays')
    }

    // S616: the operator's short-stay toggle IS is_bookable (S538), so the
    // allow-list has to follow it — otherwise a landlord could open their house
    // to short stays and the booking search would still never return it,
    // because lease_types_allowed lacked nightly.
    const leaseTypesAllowed = leaseTypesForUnitType(unitType, !!isBookable)

    const updated = await queryOne<any>(`UPDATE units SET
      unit_type=$1, lease_types_allowed=$2, nightly_rate=$3, weekly_rate=$4, monthly_rate=$5,
      min_stay_nights=$6, max_stay_nights=$7, check_in_time=$8, check_out_time=$9,
      amenities=$10, unit_description=$11, is_bookable=$12,
      rv_site_layout=COALESCE($14,rv_site_layout),
      rv_amp_service=COALESCE($15,rv_amp_service),
      dwelling_ownership=COALESCE($16,dwelling_ownership),
      occupancy_mode=COALESCE($17,occupancy_mode),
      lot_rent_amount=COALESCE($18,lot_rent_amount),
      is_multi_level=COALESCE($19,is_multi_level),
      is_ada_accessible=COALESCE($20,is_ada_accessible), updated_at=NOW()
      WHERE id=$13 RETURNING *`,
      [unitType||'residential', leaseTypesAllowed, nightlyRate||null, weeklyRate||null,
       monthlyRate||null, minStayNights||1, maxStayNights||null,
       checkInTime||'15:00', checkOutTime||'11:00',
       amenities||[], unitDescription||null, isBookable??false, unit.id, rvSiteLayout ?? null, rvAmpService ?? null,
       dwellingOwnership ?? null, occupancyMode ?? null,
       lotRentAmount == null ? null : Number(lotRentAmount),
       typeof isMultiLevel === 'boolean' ? isMultiLevel : null,
       typeof isAdaAccessible === 'boolean' ? isAdaAccessible : null])

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/occupancy-mode (S558) — flip a single unit between
// whole_unit and by_room. Dedicated route (not /type) so it never clobbers the
// unit's other config. Guard: can't switch to whole_unit while >1 active lease
// exists (that mode allows only one).
unitsRouter.patch('/:id/occupancy-mode', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const { occupancyMode } = req.body
    if (!(OCCUPANCY_MODES as readonly string[]).includes(occupancyMode)) {
      throw new AppError(400, `Invalid occupancyMode '${occupancyMode}'`)
    }
    const unit = await queryOne<any>('SELECT id, landlord_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    if (occupancyMode === 'whole_unit') {
      const n = await queryOne<any>(`SELECT COUNT(*)::int AS c FROM leases WHERE unit_id=$1 AND status IN ('active','pending')`, [req.params.id])
      if ((n?.c ?? 0) > 1) throw new AppError(409, 'This unit has multiple active leases — end all but one before switching to whole-unit mode.')
    }
    const updated = await queryOne<any>(`UPDATE units SET occupancy_mode=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [occupancyMode, req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/inspection-attributes (S573) — flip a single unit's
// inspection-template filter flags (is_multi_level, is_ada_accessible).
// Dedicated route (not /type) so a standalone toggle never clobbers the unit's
// unit_type/rates. Each field is optional; COALESCE leaves the others untouched.
unitsRouter.patch('/:id/inspection-attributes', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const { isMultiLevel, isAdaAccessible } = req.body
    if (isMultiLevel != null && typeof isMultiLevel !== 'boolean') throw new AppError(400, 'isMultiLevel must be a boolean')
    if (isAdaAccessible != null && typeof isAdaAccessible !== 'boolean') throw new AppError(400, 'isAdaAccessible must be a boolean')
    if (isMultiLevel == null && isAdaAccessible == null) throw new AppError(400, 'Nothing to update')
    const unit = await queryOne<any>('SELECT id, landlord_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    const updated = await queryOne<any>(
      `UPDATE units SET
         is_multi_level=COALESCE($1, is_multi_level),
         is_ada_accessible=COALESCE($2, is_ada_accessible),
         updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [typeof isMultiLevel === 'boolean' ? isMultiLevel : null,
       typeof isAdaAccessible === 'boolean' ? isAdaAccessible : null,
       req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/details (S573) — the SINGLE consolidated unit editor.
// Every unit setting is editable here, but ONLY while the unit has no active/
// pending lease. Once a lease is active/pending the settings freeze (rent is
// committed to the signed doc; between-lease is when a landlord raises rent or
// remodels bed/bath). Replaces the scattered listing/type/attribute edits.
unitsRouter.patch('/:id/details', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const body = z.object({
      unitType:        z.enum(UNIT_TYPES as unknown as [string, ...string[]]).optional(),
      bedrooms:        z.number().int().min(0).max(30).optional(),
      bathrooms:       z.number().min(0).max(30).optional(),
      sqft:            z.number().int().min(0).nullable().optional(),
      // S629: every unit owns its price, classed or not — see the note below.
      rentAmount:      z.number().min(0).optional(),
      securityDeposit: z.number().min(0).optional(),
      dwellingOwnership: z.enum(DWELLING_OWNERSHIP_VALUES as unknown as [string, ...string[]]).optional(),
      isMultiLevel:    z.boolean().optional(),
      isAdaAccessible: z.boolean().optional(),
      floorLevel:      z.enum(FLOOR_LEVELS as unknown as [string, ...string[]]).nullable().optional(),
      livingAreas:     z.number().int().min(1).max(MAX_INSPECTION_LIVING_AREAS).optional(),
      features:        z.record(z.boolean()).optional(),
      occupancyMode:   z.enum(OCCUPANCY_MODES as unknown as [string, ...string[]]).optional(),
      rvSiteLayout:    z.enum(RV_SITE_LAYOUTS as unknown as [string, ...string[]]).optional(),
      rvAmpService:    z.enum(RV_AMP_SERVICES as unknown as [string, ...string[]]).optional(),
      storageSize:     z.string().max(40).nullable().optional(),
      lotRentAmount:   z.number().min(0).optional(),
      // S609: household size for an OWNER-OCCUPIED unit — see the migration.
      ownerHouseholdSize: z.number().int().min(1).max(30).optional(),
      // S653 (Nic): who is in an owner-use space, and how to reach them. Contact
      // only — no lease, no portal, nothing billed to this person.
      ownerOccupantName:  z.string().max(120).nullable().optional(),
      ownerOccupantPhone: z.string().max(40).nullable().optional(),
      ownerOccupantEmail: z.string().max(200).nullable().optional(),
      // S613 (Nic): does this space have a propane tank to fill. Set in the same
      // place as its submeters and flat charges — "all those things should be
      // selectable in the same spot even though it's not always a meter."
      hasPropaneTank:  z.boolean().optional(),
      nightlyRate:     z.number().min(0).nullable().optional(),
      weeklyRate:      z.number().min(0).nullable().optional(),
      monthlyRate:     z.number().min(0).nullable().optional(),
      isBookable:      z.boolean().optional(),
    }).parse(req.body)

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    // S629 (Nic, DIRECTIVE — supersedes S613): "pricing should not necessarily
    // be linked to subtypes, as things that have different subtypes may be
    // differently priced. The subtype is more just for classification,
    // reporting type things — how many people wanted 30 amp versus 50 amp
    // spots, back-in versus pull-through. It's more of a reporting metric and
    // portfolio statistic gauge than a pricing gauge. Pricing should be per
    // individual unit."
    //
    // S613 read the class as owning the price, and refused a price on any unit
    // inside one. That is now the wrong model: a class is a LABEL, and two
    // units wearing the same label can be worth different money. The subtype's
    // price survives as a DEFAULT at creation — bulk-adding twenty spots at one
    // price is still one action — but it stops being a live link, so changing a
    // class never silently reprices units that were already sold at a figure.
    //
    // Every unit owns its price now, classed or not. The lease-lock below is
    // what protects a price that is actually in force.

    // Lease-lock — the whole point of this workflow (Nic): no edits while a
    // lease is active/pending; everything is editable only between leases.
    const leased = await queryOne<any>(
      `SELECT 1 FROM leases WHERE unit_id=$1 AND status IN ('active','pending') LIMIT 1`, [req.params.id])
    if (leased) {
      throw new AppError(409,
        'This unit has an active lease — its settings are locked until the lease ends. ' +
        'Rent and terms are committed to the signed lease; edit unit settings between leases.')
    }

    const unitType = body.unitType ?? unit.unit_type ?? 'apartment'
    // Same late-fee-decision gate as unit creation — no unit of an undecided
    // class, so a type switch can't sneak past it.
    if (body.unitType && body.unitType !== unit.unit_type) {
      await assertLateFeeDecision(unit.property_id, unitType)
    }

    let isBookable = body.isBookable ?? unit.is_bookable
    if ((SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unitType) && isBookable) {
      throw new AppError(400, 'Storage units cannot be made bookable for short-term stays')
    }

    const isRv = unitType === 'rv_spot'
    const INTERIOR_RESIDENTIAL_TYPES = ['apartment', 'single_family', 'mobile_home']
    const isInteriorResidential = INTERIOR_RESIDENTIAL_TYPES.includes(unitType)
    // Normalize type-specific fields so a type switch never leaves stale attrs.
    const rvLayout    = isRv ? (body.rvSiteLayout ?? unit.rv_site_layout ?? 'none') : 'none'
    const rvAmp       = isRv ? (body.rvAmpService ?? unit.rv_amp_service ?? 'none') : 'none'
    const storageSize = unitType === 'storage' ? ((body.storageSize ?? unit.storage_size) || null) : null
    const isMultiLevel    = isInteriorResidential ? (body.isMultiLevel ?? unit.is_multi_level ?? false) : false
    const isAdaAccessible = isInteriorResidential ? (body.isAdaAccessible ?? unit.is_ada_accessible ?? false) : false
    const dwellingOwnership = (isRv || unitType === 'mobile_home')
      ? (body.dwellingOwnership ?? unit.dwelling_ownership ?? 'tenant')
      : 'landlord'
    // Floor placement — building units only; cleared on RV/storage/parking.
    const FLOOR_LEVEL_TYPES = ['apartment', 'single_family', 'mobile_home', 'hotel_room', 'commercial']
    const floorLevel = FLOOR_LEVEL_TYPES.includes(unitType)
      ? (body.floorLevel === undefined ? unit.floor_level : body.floorLevel)
      : null
    const leaseTypesAllowed = leaseTypesForUnitType(unitType)

    const bedrooms   = body.bedrooms ?? unit.bedrooms
    const bathrooms  = body.bathrooms ?? unit.bathrooms
    const sqft       = body.sqft === undefined ? unit.sqft : body.sqft
    // S629 (Nic): every unit owns its own price, classed or not. The subtype is
    // a label for reporting — 30 amp versus 50 amp, back-in versus
    // pull-through — not a price list.
    const rentAmount = body.rentAmount ?? Number(unit.rent_amount)
    const securityDeposit = body.securityDeposit ?? Number(unit.security_deposit)
    const nightlyRate = body.nightlyRate === undefined ? unit.nightly_rate : body.nightlyRate
    const weeklyRate  = body.weeklyRate  === undefined ? unit.weekly_rate  : body.weeklyRate
    const monthlyRate = body.monthlyRate === undefined ? unit.monthly_rate : body.monthlyRate
    const lotRentAmount = body.lotRentAmount ?? Number(unit.lot_rent_amount ?? 0)
    const occupancyMode = body.occupancyMode ?? unit.occupancy_mode
    // S573: living-area count (bedroom types only) + feature map (only keys the
    // catalog offers for this type; drops stale keys on a type switch).
    const livingAreas = INTERIOR_RESIDENTIAL_TYPES.includes(unitType)
      ? (body.livingAreas ?? unit.living_areas ?? 1) : 1
    let features = (unit.features ?? {}) as Record<string, boolean>
    if (body.features) {
      const offered = new Set(UNIT_FEATURE_CATALOG.filter(f => f.types.includes(unitType)).map(f => f.key))
      const clean: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(body.features)) if (offered.has(k)) clean[k] = !!v
      features = clean
    }

    const updated = await queryOne<any>(`
      UPDATE units SET
        unit_type=$1, bedrooms=$2, bathrooms=$3, sqft=$4,
        rent_amount=$5, security_deposit=$6, dwelling_ownership=$7,
        is_multi_level=$8, is_ada_accessible=$9, occupancy_mode=$10,
        rv_site_layout=$11, rv_amp_service=$12, storage_size=$13,
        lot_rent_amount=$14, nightly_rate=$15, weekly_rate=$16, monthly_rate=$17,
        is_bookable=$18, lease_types_allowed=$19::text[], floor_level=$21,
        living_areas=$22, features=$23::jsonb,
        owner_household_size=COALESCE($24, owner_household_size),
        has_propane_tank=COALESCE($25, has_propane_tank),
        owner_occupant_name  = CASE WHEN $26::boolean THEN $27 ELSE owner_occupant_name END,
        owner_occupant_phone = CASE WHEN $28::boolean THEN $29 ELSE owner_occupant_phone END,
        owner_occupant_email = CASE WHEN $30::boolean THEN $31 ELSE owner_occupant_email END,
        updated_at=NOW()
      WHERE id=$20 RETURNING *`,
      [unitType, bedrooms, bathrooms, sqft, rentAmount, securityDeposit, dwellingOwnership,
       isMultiLevel, isAdaAccessible, occupancyMode, rvLayout, rvAmp, storageSize,
       lotRentAmount, nightlyRate, weeklyRate, monthlyRate, isBookable, leaseTypesAllowed,
       req.params.id, floorLevel, livingAreas, JSON.stringify(features),
       body.ownerHouseholdSize ?? null, body.hasPropaneTank ?? null,
       body.ownerOccupantName !== undefined, body.ownerOccupantName?.trim() || null,
       body.ownerOccupantPhone !== undefined, body.ownerOccupantPhone?.trim() || null,
       body.ownerOccupantEmail !== undefined, body.ownerOccupantEmail?.trim() || null])

    // S636 (Nic, DIRECTIVE): THE OTHER DIRECTION OF THE SAME RULE.
    //
    // "If I edit the rent in this field, the rent box in the lease template
    // should be changed to match that." A document already out for signature
    // carries the OLD figure, so the landlord corrects the unit and the tenant
    // still signs the stale number — and the signed lease then governs, because
    // the lease is law. That is the wrong way round for a mistake caught before
    // anybody signed.
    //
    // Only documents nobody has signed yet. Once a signature is on it the
    // amount is part of an executed instrument and is changed by a new document,
    // never by editing a unit.
    if (rentAmount != null && Number(rentAmount) > 0
        && Number(rentAmount) !== Number(unit.rent_amount)) {
      await query(`
        UPDATE lease_document_fields f
           SET value = $2
          FROM lease_documents d
         WHERE d.id = f.document_id
           AND d.unit_id = $1
           AND d.status IN ('pending','sent')
           AND f.lease_column = 'rent_amount'
           AND NOT EXISTS (SELECT 1 FROM lease_document_signers s
                            WHERE s.document_id = d.id AND s.signed_at IS NOT NULL)`,
        [req.params.id, Number(rentAmount).toFixed(2)])
    }
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/subtype — S613 (Nic): "I wanna figure out how to link
// subtypes to different units because there's nowhere that I can see that
// links those."
//
// Deliberately NOT part of PATCH /:id/details, which is locked whole while a
// lease is active. Moving a space between classes stays available on an
// occupied unit — otherwise a full park could never classify a single space,
// and it is safe because the unit's price is the ASKING price: a tenant is
// billed from leases.rent_amount and the lease is law (S613).
unitsRouter.patch('/:id/subtype', requirePerm('schedule.configure_unit'), async (req, res, next) => {
  try {
    const body = z.object({
      // null = no class. The unit then owns its price again, keeping whatever
      // it currently has — leaving a class is not a reason to reprice a unit.
      subtypeId:    z.string().uuid().nullable(),
      applyDetails: z.boolean().optional(),
    }).parse(req.body)

    const unit = await queryOne<any>(`
      SELECT u.id, u.unit_number, u.unit_type, u.property_id, u.landlord_id, u.retired_at,
             EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.id
                       AND l.status IN ('active','pending')) AS leased
        FROM units u WHERE u.id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    if (unit.retired_at) throw new AppError(409, 'A retired unit keeps the details it was retired with.')

    try {
      const out = await linkUnitToSubtype(unit, body.subtypeId, { applyDetails: !!body.applyDetails })
      res.json({ success: true, data: {
        subtypeId: out.subtype?.id ?? null,
        subtypeName: out.subtype?.name ?? null,
      } })
    } catch (e: any) {
      throw new AppError(400, e?.message || 'Could not set that subtype')
    }
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/utility-responsibility — S613 (Nic, DIRECTIVE).
//
// "Trash or other stuff may be an ADDENDUM when billed back separately, as
//  things change. There needs to be able to be other charges that are not on the
//  lease. The accuracy we're going for is that the things that are IN the lease
//  cannot be ALTERED on the charge, not that no other charges happen."
//
// Until now this row had exactly one writer — e-sign, parsing the lease's own
// tags — which made a utility the lease never mentioned unbillable forever. A
// landlord who added trash service in year two configured everything correctly
// and the run reported unitsSkipped, silently, every month.
//
// What this does NOT open: rent, deposits, or any amount the lease fixes. Those
// come off the lease row and still have no editor. This says only WHETHER a
// utility is billed back, which is what an addendum ordinarily says on paper —
// and it records who asserted it and when, because GAM cannot see the paper.
unitsRouter.patch('/:id/utility-responsibility', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      utilityType:       z.enum(UTILITY_TYPES as unknown as [string, ...string[]]),
      tenantResponsible: z.boolean(),
      note:              z.string().trim().max(300).optional(),
    }).parse(req.body)

    const unit = await queryOne<any>(
      `SELECT id, landlord_id, unit_number FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const lease = await queryOne<any>(
      `SELECT id FROM leases WHERE unit_id = $1 AND status = 'active' LIMIT 1`, [req.params.id])
    if (!lease) {
      throw new AppError(409,
        `Unit ${unit.unit_number} has no active lease, so there is nobody to bill it back to. ` +
        `The next lease decides this on its own terms.`)
    }

    // S652 (Nic, Billy Miranda — two spaces, one trash can): a utility the lease
    // bills can be turned OFF for this lease too. It is the landlord's call, it
    // is recorded as an addendum with who and when, and it lasts exactly as long
    // as this lease: "back on when another person assumes the spot" — the next
    // lease decides on its own terms. Before this, the route refused, and the
    // only way to honor the ask was a row written by hand.

    const row = await queryOne<any>(
      `INSERT INTO lease_utility_responsibilities
         (lease_id, utility_type, tenant_responsible, source, set_by_user_id, set_at, note)
       VALUES ($1, $2, $3, 'addendum', $4, NOW(), $5)
       ON CONFLICT (lease_id, utility_type) DO UPDATE
         SET tenant_responsible = EXCLUDED.tenant_responsible,
             source = 'addendum', set_by_user_id = EXCLUDED.set_by_user_id,
             set_at = NOW(), note = EXCLUDED.note
       RETURNING *`,
      [lease.id, body.utilityType, body.tenantResponsible, req.user!.userId, body.note ?? null])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/units/:id/availability — get booked dates
unitsRouter.get('/:id/availability', async (req, res, next) => {
  try {
    const unit = await queryOne<any>(
      `SELECT u.landlord_id, p.timezone
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // S654: the default window starts on the park's today, not UTC's.
    const { from, to } = req.query
    const today = todayIn(unit.timezone)
    const fromDate = from || today
    const toDate = to || addDaysTo(today, 90)

    const bookings = await query<any>(`
      SELECT id, check_in, check_out, status, lease_type, guest_name
      FROM unit_bookings
      WHERE unit_id=$1 AND status NOT IN ('cancelled') AND check_out >= $2 AND check_in <= $3
      ORDER BY check_in`, [req.params.id, fromDate, toDate])

    res.json({ success: true, data: bookings })
  } catch (e) { next(e) }
})

// POST /api/units/:id/bookings — create booking
//
// S354: added zod validation. Pre-S354 missing required fields
// (leaseType / checkIn / checkOut) produced 500 from the DB NOT NULL
// or CHECK violation instead of clean 400. checkOut <= checkIn was
// also silently accepted, producing 0 or negative nights via the
// Math.ceil calc. Both now caught at the zod / pre-INSERT layer.
unitsRouter.post('/:id/bookings', requirePerm('schedule.create_reservation'), async (req, res, next) => {
  try {
    const body = z.object({
      guestName:   z.string().nullish(),
      guestEmail:  z.string().email().nullish(),
      guestPhone:  z.string().nullish(),
      leaseType:   z.enum(['nightly', 'weekly', 'month_to_month', 'long_term', 'lease_hold']),
      checkIn:     z.string(),
      checkOut:    z.string(),
      tenantId:    z.string().uuid().nullish(),
      nightlyRate: z.number().min(0).nullish(),
      weeklyRate:  z.number().min(0).nullish(),
      totalAmount: z.number().min(0).nullish(),
      notes:       z.string().nullish(),
      source:      z.string().nullish(),
      requiredSiteLayout: z.enum(RV_SITE_LAYOUTS as unknown as [string, ...string[]]).nullish(),
      requiredAmpService: z.enum(RV_AMP_SERVICES as unknown as [string, ...string[]]).nullish(),
      // S652 (Nic): pin this stay to this exact site, or let the nightly
      // compression move it to an equivalent one. Movable is the default — the
      // lock is for when the counter promised somebody that particular space.
      lockedToUnit: z.boolean().nullish(),
      // S653 (Nic): sites this guest asked NOT to have ("they didn't like the
      // spot they were in last year"). Ids, never numbers — numbers repeat
      // across parks. Must be at this unit's property (checked below).
      avoidedUnitIds: z.array(z.string().uuid()).max(50).nullish(),
      // S652: email the guest a deposit link and hold the site for them until
      // they pay. See the deposit block below for what "hold" means here.
      sendDepositLink: z.boolean().nullish(),
      // S652 (Nic): the walk-in. "If we find a spot for them in the system, it
      // needs to generate either a pay link from the scheduling flow or send it
      // to the point of sale for payment there in person." The site is held the
      // moment it is chosen; the money happens three feet away.
      payAtRegister: z.boolean().nullish(),
      /** Which register item this stay is sold as — the button, not the price. */
      stayItemId: z.string().uuid().nullish(),
      // 10/6 (Nic): "Returning guest — they've stayed with us before" (no
      // background check), and a work trade for the stay. Read below.
      returningGuest: z.boolean().nullish(),
      workTrade: z.any().optional(),
    }).parse(req.body)
    const returningGuest = returningGuestIn(req)
    const workTrade = workTradeIn(req) ?? null
    // 10/6 (Nic): a work trade that covers rent makes the site charge $0.
    const rentTraded = coversRent(workTrade)

    const checkInD  = new Date(body.checkIn)
    const checkOutD = new Date(body.checkOut)
    if (isNaN(checkInD.getTime())) throw new AppError(400, 'Invalid checkIn date')
    if (isNaN(checkOutD.getTime())) throw new AppError(400, 'Invalid checkOut date')
    if (checkOutD.getTime() <= checkInD.getTime()) {
      throw new AppError(400, 'checkOut must be after checkIn')
    }

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // Property-locked workers may only create reservations at their properties.
    await assertPropertyInScope(req.user, unit.property_id)

    // S538 (Nic): storage is HARD-locked out of short-term rental — the
    // block holds even when the allow-list is empty/unrestricted.
    if ((SHORT_STAY_LOCKED_UNIT_TYPES as readonly string[]).includes(unit.unit_type)
        && (body.leaseType === 'nightly' || body.leaseType === 'weekly')) {
      throw new AppError(400, `${unit.unit_type} units cannot be booked short-term`)
    }
    // Check allowed lease types. An EMPTY list means unrestricted (a manual
    // staff reservation can book any unit) — only enforce when the unit has an
    // explicit allow-list configured.
    if (unit.lease_types_allowed?.length && !unit.lease_types_allowed.includes(body.leaseType)) {
      throw new AppError(400, `Lease type '${body.leaseType}' not allowed for ${unit.unit_type} units`)
    }

    // S652 — AN UNPAID RESERVATION HOLDS ITS SITE, WITH NO CLOCK ON IT.
    //
    // Nic, asked how long the counter's hold should last: "there's no timer for
    // deposit link but if it's not paid and someone else pays it boots them as
    // unconfirmed when there's no other spaces."
    //
    // So: no `hold_expires_at`. Nobody's reservation quietly evaporates because
    // they read their email on Monday instead of Friday. What an unpaid hold
    // does NOT do is outrank somebody who actually paid — if the park fills and
    // there is nowhere else to put them, the unpaid one yields. That rule lives
    // in services/holdDisplacement so the counter, the booking site and the
    // register all apply the same one.
    const wantsDeposit = body.sendDepositLink === true && !!body.guestEmail
    // Held, unpaid, waiting at the till. Same state as a deposit-link hold —
    // no timer, displaceable by anybody who actually pays — because it is the
    // same thing: a site committed on the calendar before the money moved.
    const wantsRegister = body.payAtRegister === true

    // Conflicts (bookings + active leases): the shared predicate in
    // services/unitAvailability — same rule GET /units/available filters by.
    //
    // S652: a reservation being PAID for right now may take a site that an
    // unpaid hold is sitting on, and the hold gets moved or told below. One
    // that is itself only a hold may not — two unpaid holds on one site is just
    // a double booking with extra steps.
    const takingMoney = !wantsDeposit && !wantsRegister
    // S653: the avoided list is a body-supplied set of ids — kept to this
    // property, and the site being booked cannot be one of them.
    const avoided = await scopedAvoidedUnits(body.avoidedUnitIds ?? [], unit.property_id)
    if (avoided.includes(unit.id)) {
      throw new AppError(409, `${unit.unit_number} is on this guest's avoid list — pick another site`)
    }
    const conflict = await findStayConflict(unit.id, {
      checkIn: body.checkIn, checkOut: body.checkOut, ignoreUnpaidHolds: takingMoney,
    })
    if (conflict) throw new AppError(409, STAY_CONFLICT_MESSAGE[conflict])

    // ── 10/5 (Nic): LEASE OR STAY, AND THE BACKGROUND CHECK (services/stayTerms)
    //
    // Asked before anything is written. A stay that reaches 30 continuous
    // nights (back-to-back stays of the same guest at this park add up, R7)
    // needs the counter's answer — lease or no lease — and is refused with
    // 'stay_terms_needed' until it has one. One that reaches 22 needs a way to
    // reach the guest: their check is emailed to them and matched by email.
    const stayTermsGiven = stayTermsIn(req.body?.stayTerms)
    const needs = await stayNeeds({
      landlordId: unit.landlord_id, propertyId: unit.property_id,
      tenantId: body.tenantId ?? null, email: body.guestEmail ?? null,
      checkIn: body.checkIn, checkOut: body.checkOut, stayTerms: stayTermsGiven,
      returning: returningGuest, offerReturning: canAttestReturningGuest(req.user),
    })
    if (needs.nights >= STAY_SCREENING_NIGHTS && !needs.chain.email && !needs.chain.tenantId) {
      throw new AppError(400, LONG_STAY_NEEDS_EMAIL)
    }
    if (needs.leaseChoice === 'needed') return void res.status(409).json(stayTermsNeededBody(needs))
    if (workTrade) {
      await assertWorkTradeGuest({ tenant_id: body.tenantId ?? null, guest_email: body.guestEmail ?? null, landlord_id: unit.landlord_id })
    }
    // A2: the check's fee rides on a deposit link or a register ticket — never
    // a stay confirmed straight onto the schedule (screeningFeeRouteBody).
    // One fee per continuous stay (M3): a back-to-back leg whose ticket or link
    // already carries it (or that already paid it) is not charged it again.
    const feeDue = needs.screening === 'fee_due' && (needs.screeningFee?.amount ?? 0) > 0
      && !(needs.chain.bookingIds.length && await screeningFeeAlreadyCarried(needs.chain.bookingIds).catch(() => false))
    if (feeDue && !wantsDeposit && !wantsRegister) {
      return void res.status(409).json(screeningFeeRouteBody(needs, !!body.guestEmail))
    }

    const nights = dayDiff(body.checkIn, body.checkOut)
    // Price authoritatively from the UNIT's stay rates, falling back to the
    // PROPERTY default per rate when the unit hasn't been configured separately
    // (Nic: rates are uniform by default — RV spots/storage share a price — but
    // a landlord can override a specific unit, e.g. pull-through vs back-in RV
    // sites). 10/6 (Nic): the schedule's ONE pricing function
    // (registerStay scheduleStayPrice → shared priceStay): the cheapest whole
    // months, weeks and nights that cover the stay, short-term tax under 30
    // nights — the figure the form showed, the booking site and the register
    // charge. Falls back to a client-supplied total only when no rate is set.
    const prop = await queryOne<any>(
      'SELECT nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate FROM properties WHERE id=$1',
      [unit.property_id])
    const price = scheduleStayPrice(
      { nightly: unit.nightly_rate ?? prop?.nightly_rate,
        weekly:  unit.weekly_rate  ?? prop?.weekly_rate,
        monthly: unit.monthly_rate ?? prop?.monthly_rate },
      prop?.short_term_tax_rate ?? 0, body.checkIn, body.checkOut)
    // 10/6 (Nic): a work trade that covers rent — the site costs the guest nothing.
    const total = rentTraded ? 0 : price.total > 0 ? price.total : (body.totalAmount || 0)
    // S526 (Nic): reservations carry ZERO platform fee — GAM's income is the
    // $2/occupied-unit monthly fee (services/platformFee.ts), not a booking cut.
    const platformFee = 0

    // 10/6 (Nic): nothing to pay for the site (its rent is traded) and no check
    // fee to collect — no deposit link or register ticket: confirmed directly.
    const routedToPay = (wantsDeposit || wantsRegister) && !(rentTraded && !feeDue)
    const bookingStatus = routedToPay ? 'tentative' : 'confirmed'

    // S652: clearing the site and taking it are one act. Either this guest has
    // the site and the holder has been moved or told, or neither happened —
    // a half-applied version leaves a site with two claims on it.
    //
    // 10/3 (review, fix round 3): the ORDER, for everybody else booking these
    // sites at the same moment (see HOLD_CLEARING_LOCK_WAIT):
    //   1. The site's own row. This save's write needs it at the end, and a pay
    //      link being sent for the site (posPayLinks) takes the row first and
    //      the site second; a save that took the site first and the row last
    //      ended the link with a deadlock.
    //   2. The site itself (lockSitesForStays): wait for anybody else putting a
    //      stay on it. Nothing a sale or a link waits for is held yet.
    //   3. Only a reservation being paid for: the unpaid holds on these nights
    //      are moved or told (services/holdDisplacement) — after the site, so a
    //      hold that landed while this save waited (a new one, or one another
    //      payer's sale moved here, review V8) is cleared too, and nobody can
    //      put one back before the write. Every lock this asks for is given up
    //      quickly (withShortLockWaits) rather than waited for, and the save
    //      starts again from the top.
    let booking: any
    let displaced: import('../services/holdDisplacement').DisplacementOutcome[] = []
    // 10/6 (review): a placeholder account's set-up link, made with the work trade.
    let wtInvite: StayWorkTradeInvite | null = null
    // 10/6 (review): closes the card pages of links whose check fee came off (returning guest).
    let returningAfterCommit: (() => Promise<void>) | null = null
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) await pauseBeforeTry(attempt - 1)
      displaced = []
      const bookingClient = await getClient()
      try {
        await bookingClient.query('BEGIN')
        await bookingClient.query(`SELECT 1 FROM units WHERE id = $1 FOR KEY SHARE`, [unit.id])
        await lockSitesForStays(bookingClient, [unit.id])
        if (takingMoney) {
          const { clearUnpaidHolds } = await import('../services/holdDisplacement')
          displaced = await withShortLockWaits(bookingClient,
            () => clearUnpaidHolds(bookingClient, unit.id, body.checkIn, body.checkOut))
        }
        // Then the nights are checked again: one booked between the check above
        // and this write is seen now, not after both are stored. The check
        // reads what is committed (not this transaction's own moves), so the
        // holds just moved still look as if they were here: the ones that step
        // aside for money are ignored — every one of them has been moved or
        // told above, under the site's lock. Anything else on the nights (a
        // hold already moved once, a guest paying online right now) refuses
        // this save rather than share a night with it.
        const takenSince = await findStayConflict(unit.id, {
          checkIn: body.checkIn, checkOut: body.checkOut, ignoreUnpaidHolds: takingMoney,
        })
        if (takenSince) throw new AppError(409, STAY_CONFLICT_MESSAGE[takenSince])
        // 10/3 (decisions #33): booked_check_out is the length the stay is sold
        // for; an early check-out later moves check_out only.
        booking = (await bookingClient.query<any>(`INSERT INTO unit_bookings
          (unit_id, landlord_id, tenant_id, guest_name, guest_email, guest_phone,
           lease_type, check_in, check_out, nights, nightly_rate, weekly_rate,
           total_amount, platform_fee, notes, source, required_site_layout, required_amp_service,
           locked_to_unit, status, hold_expires_at, avoided_unit_ids, booked_check_out)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NULL,$21::uuid[],$9) RETURNING *`,
          [unit.id, unit.landlord_id, body.tenantId ?? null, body.guestName ?? null, body.guestEmail ?? null,
           body.guestPhone ?? null, body.leaseType, body.checkIn, body.checkOut, nights,
           body.nightlyRate ?? unit.nightly_rate ?? null, body.weeklyRate ?? unit.weekly_rate ?? null,
           total, platformFee, body.notes ?? null, body.source ?? 'direct', body.requiredSiteLayout ?? 'none', body.requiredAmpService ?? 'none',
           body.lockedToUnit === true, bookingStatus, avoided])).rows[0]
        // 10/6 (Nic): the landlord's "Returning guest" (who and when), counted
        // against the property's allowance under its lock — and the stay's work
        // trade — with the stay, or not at all.
        returningAfterCommit = null
        if (needs.returningAttestNow) {
          const r = await attestReturningGuest(bookingClient, { bookingId: booking.id, propertyId: unit.property_id, byUserId: req.user!.userId, chainBookingIds: needs.chain.bookingIds })
          returningAfterCommit = r.afterCommit
        }
        wtInvite = null
        if (workTrade) {
          const wt = await syncStayWorkTrade(booking.id, { terms: workTrade, byUserId: req.user!.userId, client: bookingClient })
          if (wt.action === 'skipped') throw new AppError(400, stayWorkTradeSkippedWords(wt.reason))
          if (wt.action === 'created') wtInvite = wt.invite
        }
        await bookingClient.query('COMMIT')
        break
      } catch (e) {
        await bookingClient.query('ROLLBACK').catch(() => {})
        // S655 (Step 6 fix round 6): a deadlock, or a lock given up above,
        // changed nothing — so the save runs again from the top and sees what
        // the other one stored.
        if (!isDeadlock(e) && !isLockBusy(e)) throw e
        if (attempt >= BOOKING_SAVE_TRIES) throw new AppError(409, SAVED_AT_THE_SAME_MOMENT)
        logger.warn({ unitId: unit.id, checkIn: body.checkIn, checkOut: body.checkOut, attempt, code: (e as { code?: string }).code },
          isLockBusy(e)
            ? '[booking] something the save needed to move an unpaid hold was busy; saving again'
            : '[booking] deadlocked with another reservation on the same sites; saving again')
      } finally { bookingClient.release() }
    }

    // Somebody lost the site they were holding. A moved guest may never need to
    // know; a displaced one is a phone call, and neither belongs only in a log.
    if (displaced.length) {
      import('../services/holdDisplacement')
        .then((m) => m.notifyDisplacedHolds(unit.landlord_id, unit.property_id, displaced))
        .catch((err: unknown) => logger.error({ err, bookingId: booking.id }, '[booking] displacement notice failed'))
    }

    // S517: change-history (Master Schedule). Best-effort — never fail the booking.
    recordBookingEvent({
      bookingId: booking.id, unitId: unit.id, landlordId: unit.landlord_id,
      eventType: 'created', actorUserId: req.user!.userId,
      summary: `Reservation created for ${booking.guest_name || 'Guest'} (${body.checkIn}→${body.checkOut})`,
      detail: { check_in: body.checkIn, check_out: body.checkOut, lease_type: body.leaseType, source: body.source ?? 'direct' },
    }).catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] event record failed'))

    // 10/5 (Nic, R3): no lease is drafted on its own any more (S526's 30-night
    // auto-draft is gone). The counter's answer is carried out here: a lease
    // chosen drafts one for the landlord, a stay bills its site's utilities, and
    // the landlord is told either way. 22+ nights: check-in waits on screening.
    if (returningAfterCommit) await returningAfterCommit()
    const stayDone = await afterStaySaved(booking.id, needs, stayTermsGiven, req.user!.userId)
    // 10/6 (review): the guest's way into their account, for the work trade.
    await sendStayWorkTradeInvite(booking.id, wtInvite)
    // R8: nothing on file → the check's fee rides on the payment this stay is
    // handed to below (the schedule takes no money itself).
    const screeningFee = feeDue && needs.screeningFee ? needs.screeningFee.amount : null

    // Booking guests with no GAM account get a stay-assistant link by email
    // (a host can also issue a QR from the booking). Best-effort — a missing
    // or failed token must never fail the booking itself.
    if (booking.guest_email) {
      sendBookingGuestAccessEmail({
        bookingId: booking.id,
        landlordId: unit.landlord_id,
        createdByUserId: req.user!.userId,
      }).catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] guest access email failed'))
    }

    // S652: the deposit link, sent to the guest who is not standing here. The
    // deposit is the one the booking site would have quoted for these nights on
    // this site — a guest who phones and a guest who books online are buying
    // the same thing and are told the same number.
    let depositLink: { id: string; url: string } | null = null
    if (wantsDeposit && routedToPay) {
      try {
        const { quoteStayDeposit } = await import('../services/propertyBooking')
        // 10/6: a work trade covering rent leaves only the check's fee to send.
        const depositAmount = rentTraded ? 0 : await quoteStayDeposit(unit.id, body.checkIn, body.checkOut)
        const { createBookingDepositLink } = await import('./posPayLinks')
        // 10/5 (R8, A2): the background check's fee goes on the link as its own
        // fixed line (`screeningFee`, the server's figure) — a $0 deposit still
        // makes a link for the fee alone; the link records the prepaid
        // screening when it is paid (routes/posPayLinks).
        depositLink = await createBookingDepositLink({
          bookingId: booking.id, landlordId: unit.landlord_id, propertyId: unit.property_id,
          amount: depositAmount, guestName: booking.guest_name, guestEmail: booking.guest_email,
          ...(screeningFee ? { screeningFee } : {}),
        })
      } catch (err) {
        // The reservation is real and on the board; only the link failed. Say
        // so on the response rather than rolling back a site the counter has
        // already told somebody they have.
        logger.error({ err, bookingId: booking.id }, '[booking] deposit link failed')
      }
    }

    // S652: hand it to the till. The ticket carries the booking, so settling it
    // confirms THAT reservation — the register cannot invent a second booking
    // for a site the schedule has already committed.
    let registerTicketId: string | null = null
    if (wantsRegister && routedToPay) {
      try {
        const item = body.stayItemId
          ? await queryOne<any>(
              `SELECT id, name, stay_unit FROM pos_items
                WHERE id = $1 AND landlord_id = $2 AND stay_unit IS NOT NULL AND is_active = TRUE`,
              [body.stayItemId, unit.landlord_id])
          : await queryOne<any>(
              // No item named: take the property's own stay button for this
              // length. A park with none has not set its register up, and the
              // reservation still stands — it just cannot be rung yet.
              `SELECT id, name, stay_unit FROM pos_items
                WHERE property_id = $1 AND landlord_id = $2 AND is_active = TRUE
                  AND stay_unit = $3 LIMIT 1`,
              [unit.property_id, unit.landlord_id,
               body.leaseType === 'nightly' ? 'night' : body.leaseType === 'weekly' ? 'week' : 'month'])
        if (!item) {
          throw new AppError(409,
            'This property has no register button for that length of stay, so it cannot be rung up. '
            + 'Add one under Register items, or email a deposit link instead.')
        }
        const qty = item.stay_unit === 'night' ? nights
          : item.stay_unit === 'week' ? Math.max(1, Math.round(nights / 7))
          : Math.max(1, Math.round(nights / 30))
        // 10/5 (R8): the background check rides on the ticket as a fixed line
        // when nothing is on file (screeningFeeTicketLine).
        const lines: Record<string, unknown>[] = [{ id: item.id, name: item.name, qty, price: 0, tax: 0 }]
        if (screeningFee) lines.push(screeningFeeTicketLine(screeningFee))
        const ticket = await queryOne<any>(
          `INSERT INTO pos_open_tickets
             (landlord_id, property_id, created_by, tenant_id, pos_customer_id, items, note, booking_id)
           VALUES ($1,$2,$3,$4,NULL,$5::jsonb,$6,$7) RETURNING id`,
          [unit.landlord_id, unit.property_id, req.user!.userId, body.tenantId ?? null,
           JSON.stringify(lines),
           `${booking.guest_name || 'Guest'} · site ${unit.unit_number} · ${body.checkIn} → ${body.checkOut}`,
           booking.id])
        registerTicketId = ticket.id
      } catch (err) {
        // The reservation is real and the site is held. Only the till handoff
        // failed, and saying so beats rolling back a site somebody was just told
        // they have.
        if (err instanceof AppError && err.statusCode === 409) throw err
        logger.error({ err, bookingId: booking.id }, '[booking] register handoff failed')
      }
    }

    // 10/5: what the stay needs, for the screen to say — the server's figures.
    // A 30+ night stay with no lease is held only through its check-out (R13).
    const stay = {
      nights: needs.nights,
      terms: stayDone.terms ?? (needs.leaseChoice === 'lease' || needs.leaseChoice === 'stay' ? needs.leaseChoice : null),
      leaseId: stayDone.leaseId,
      screening: needs.screening,
      screeningFee,
      // Fee due but no link or ticket to carry it: nothing collected it yet.
      screeningFeeUncollected: !!screeningFee && !depositLink && !registerTicketId,
      heldThrough: needs.leaseChoice === 'stay' ? stayHeldWords(needs.chain.checkOut) : null,
      // 10/6: what the details will say.
      returningGuest: needs.screening === 'returning',
      workTrade: workTrade ? { coveredCharges: workTrade.coveredCharges, trusted: workTrade.trusted, rentTraded } : null,
    }
    res.status(201).json({ success: true, data: { ...booking, depositLink, registerTicketId, stay } })
  } catch (e) { next(e) }
})

// GET /api/units/:id/returning-guest?email=&checkIn=&checkOut=&bookingId= —
// 10/6 (Nic): what the reservation form shows beside the background check for
// a stay on this site: does it need one (22+ continuous nights, nothing on
// file), and may "Returning guest — they've stayed with us before" be used —
// available, or greyed with the allowance words (never the count). Nothing is
// written. A desk without the permission is told it is not offered.
unitsRouter.get('/:id/returning-guest', requirePerm('schedule.create_reservation', 'schedule.edit_reservation'), async (req, res, next) => {
  try {
    const unit = await queryOne<{ landlord_id: string; property_id: string }>(
      'SELECT landlord_id, property_id FROM units WHERE id = $1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, unit.property_id)
    const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
    const checkIn = day(req.query.checkIn)
    const checkOut = day(req.query.checkOut)
    if (!checkIn || !checkOut || checkOut <= checkIn) throw new AppError(400, 'Pick the arrival and leaving days first.')
    const email = typeof req.query.email === 'string' && req.query.email.trim() ? req.query.email.trim() : null
    const bookingId = typeof req.query.bookingId === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.bookingId) ? req.query.bookingId : null
    const offered = canAttestReturningGuest(req.user)
    const needs = await stayNeeds({
      landlordId: unit.landlord_id, propertyId: unit.property_id, bookingId, email, checkIn, checkOut,
      offerReturning: offered,
    })
    res.json({ success: true, data: {
      nights: needs.nights,
      screening: needs.screening,
      screeningFee: needs.screening === 'fee_due' ? needs.screeningFee?.amount ?? null : null,
      offered,
      returning: needs.returningOffer,
    } })
  } catch (e) { next(e) }
})

// POST /api/units/:id/bookings/:bookingId/guest-access — issue (or re-issue)
// the guest's stay-assistant token and return the link + a QR for the host to
// show/print on-site. Optionally also emails the link to the guest. This is
// the QR/email delivery surface for the booking-guest agent.
unitsRouter.post('/:id/bookings/:bookingId/guest-access', requirePerm('guest_access'), async (req, res, next) => {
  try {
    const body = z.object({
      delivery: z.enum(['email', 'qr']).optional(),
      sendEmail: z.boolean().optional(),
    }).parse(req.body ?? {})

    const booking = await queryOne<any>(
      `SELECT b.id, b.landlord_id, b.guest_email
         FROM unit_bookings b WHERE b.id = $1 AND b.unit_id = $2`,
      [req.params.bookingId, req.params.id])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) throw new AppError(403, 'Forbidden')

    const issued = await issueBookingGuestToken({
      bookingId: booking.id,
      landlordId: booking.landlord_id,
      delivery: body.delivery ?? 'qr',
      createdByUserId: req.user!.userId,
    })
    const qrDataUrl = await bookingGuestQrDataUrl(issued.token)

    let emailed = false
    if (body.sendEmail && booking.guest_email) {
      const { emailBookingGuestAccess } = await import('../services/email')
      const ctx = await queryOne<any>(
        `SELECT b.guest_name, b.check_in, b.check_out, p.name AS property_name, u.unit_number, u.property_id
           FROM unit_bookings b
           LEFT JOIN units u ON u.id = b.unit_id
           LEFT JOIN properties p ON p.id = u.property_id
          WHERE b.id = $1`, [booking.id])
      await emailBookingGuestAccess({
        to: booking.guest_email,
        guestName: ctx?.guest_name ?? null,
        propertyName: ctx?.property_name ?? null,
        unitNumber: ctx?.unit_number ?? null,
        checkIn: ctx?.check_in,
        checkOut: ctx?.check_out,
        stayUrl: issued.url,
        expiresAt: issued.expiresAt,
        // 10/5: replies reach the people who run this property (services/replyRouting).
        ctx: { landlordId: booking.landlord_id, bookingId: booking.id, replyTo: replyToProperty(ctx?.property_id) },
      })
      emailed = true
    }

    res.json({
      success: true,
      data: { url: issued.url, qrDataUrl, expiresAt: issued.expiresAt, emailed },
    })
  } catch (e) { next(e) }
})

// DELETE /api/units/:id/bookings/:bookingId/guest-access — revoke the guest's
// stay-assistant access. Kills EVERY outstanding link for the booking (each
// issue mints a fresh token without retiring the last), so this is the host's
// single kill switch. Same auth as issue. Idempotent: re-revoking returns 0.
unitsRouter.delete('/:id/bookings/:bookingId/guest-access', requirePerm('guest_access'), async (req, res, next) => {
  try {
    const booking = await queryOne<any>(
      `SELECT b.id, b.landlord_id
         FROM unit_bookings b WHERE b.id = $1 AND b.unit_id = $2`,
      [req.params.bookingId, req.params.id])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) throw new AppError(403, 'Forbidden')

    const { revoked } = await revokeBookingGuestTokens({
      bookingId: booking.id,
      landlordId: booking.landlord_id,
    })

    res.json({ success: true, data: { revoked } })
  } catch (e) { next(e) }
})

// GET /api/units/:id/bookings — list bookings for a unit.
// Catalog keys first (what the permissions page grants), legacy keys kept
// for existing scope rows. Property-locked workers may only read units at
// their assigned properties.
unitsRouter.get('/:id/bookings', requirePerm(
  'schedule.tab.timeline', 'schedule.tab.list', 'schedule.tab.units', 'bookings.view',
  'guests.check_in', 'guests.check_out', 'units.view_status', 'units.edit',
), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT landlord_id, property_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    await assertPropertyInScope(req.user, unit.property_id)
    // S313: JOIN properties to surface requires_booking_acknowledgment
    // per booking row. SchedulePage's "ack needed" badge (S200) reads
    // this flag from each booking; pre-S313 the column was undefined
    // on the response so the badge never rendered. Mirrors the same
    // JOIN already in bookings.ts § GET /bookings.
    const bookings = await query<any>(`
      SELECT b.*,
             u.unit_number,
             u.unit_type,
             p.requires_booking_acknowledgment,
             -- 10/6: the stay's work trade, as the master schedule shows it.
             (SELECT jsonb_build_object('id', w.id, 'covered_charges', w.covered_charges, 'trusted', w.trusted,
                                        'tracks_hours', w.tracks_hours, 'monthly_hours_target', w.monthly_hours_target,
                                        'duties', w.duties, 'status', w.status)
                FROM work_trade_agreements w WHERE w.booking_id = b.id AND w.status <> 'ended' LIMIT 1) AS work_trade
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE b.unit_id=$1
      ORDER BY b.check_in DESC`, [req.params.id])
    res.json({ success: true, data: bookings })
  } catch (e) { next(e) }
})

// ── GET /api/units/:id/bookings/:bookingId/cancel-check — the Cancel
// reservation confirm (final fix, fix pass 1, decisions #53) ───────────────
//
// "Never runs blind: Cancel reservation on the Schedule opens the same
// confirm, showing fresh figures and names, before anything is zeroed." Read
// fresh when the button is pressed (and again after any refusal): each lease
// drafted with the stay, the people on it by name, the move-in bill lines the
// cancel zeroes, the lines that stay owed, the reservation — or the words the
// cancel would be refused in (the same functions the PATCH below refuses
// with), so the window never offers a press the server turns down. The press
// sends `total` back as expectedNeverMovedInTotal. `?status=no_show` reads a
// no-show the same way (no Schedule button sends one today).
unitsRouter.get('/:id/bookings/:bookingId/cancel-check', requirePerm('schedule.edit_reservation'), async (req, res, next) => {
  try {
    const status: 'cancelled' | 'no_show' = req.query.status === 'no_show' ? 'no_show' : 'cancelled'
    const booking = await queryOne<any>(
      `SELECT id, unit_id, landlord_id, guest_name, status,
              to_char(check_in, 'YYYY-MM-DD') AS check_in, to_char(check_out, 'YYYY-MM-DD') AS check_out
         FROM unit_bookings WHERE id = $1`, [req.params.bookingId])
    if (!booking) throw new AppError(404, 'This reservation is no longer on the schedule.')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) throw new AppError(403, 'This reservation isn’t on your account.')
    const unit = await queryOne<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [booking.unit_id])
    await assertPropertyInScope(req.user, unit?.property_id)
    const guest = booking.guest_name || 'This guest'
    const { assessNeverMovedIn, leaseHouseholdNames, reservationCanceledWords } = await import('../lib/unwindIssuedLease')
    const q = async (sql: string, params?: any[]) => ({ rows: await query<any>(sql, params) })
    const reader = {
      canMarkLeaving: userHasPerm(req.user, 'leases.edit', 'front_desk.mark_leaving'),
      canMoveOut: userHasPerm(req.user, 'leases.deposit_return'),
    }
    let words: string | null = null
    if (booking.status === status) {
      words = status === 'cancelled' ? 'This reservation is already canceled. Nothing else to do.' : 'This reservation is already marked a no-show. Nothing else to do.'
    } else if (booking.status === 'no_show' && status === 'cancelled') {
      // Fix pass 3 (review): the no-show already freed the site (and ran the
      // never-moved-in close on a lease drafted with it) — canceling it too
      // changes nothing, and "the site is free for those nights" would only
      // repeat what already happened.
      words = NO_SHOW_ALREADY_WORDS
    } else if (booking.status === 'checked_out') {
      words = stayHappenedRefusal(guest, status)
    } else if (booking.status === 'checked_in') {
      words = stayUnderWayRefusal(guest, status)
    }
    const drafted = words ? [] : await query<{ id: string; status: string }>(
      `SELECT id, status FROM leases
        WHERE source_booking_id = $1 AND status IN ('pending', 'draft', 'active')
        ORDER BY created_at, id`, [booking.id])
    const leases: any[] = []
    let amountCents = 0
    let keptCents = 0
    for (const l of drafted) {
      const a = await assessNeverMovedIn(q, l.id, { attested: true, lock: false, reader, cancelingBooking: booking.id })
      if (!a.applies && !words) {
        const w = a.words ?? 'This lease can’t be closed as never moved in.'
        words = `${cancelRefusalLead(guest, status)}${w.charAt(0).toLowerCase()}${w.slice(1)}`
      }
      amountCents += Math.round(a.total * 100)
      keptCents += Math.round(a.keptTotal * 100)
      leases.push({
        lease_id: l.id,
        status: l.status,
        applies: a.applies,
        words: a.words,
        start_date: a.startDate,
        lines: a.lines.map((x) => ({ payment_id: x.paymentId, label: x.label, amount: x.amount, due_date: x.dueDate, utility: x.utility })),
        total: a.total,
        kept: a.kept.map((k) => ({ payment_id: k.paymentId, label: k.label, amount: k.amount, why: k.why, due_date: k.dueDate,
                                   period_start: k.periodStart ?? null, period_end: k.periodEnd ?? null })),
        kept_total: a.keptTotal,
        kept_words: a.keptWords,
        reservation_words: a.applies && a.reservation ? reservationCanceledWords(a.reservation) : null,
        // Fix pass 3 (review): the wire shape the Leases page's confirm
        // sends (snake_case), from the one names helper both use.
        household: await (async () => {
          const h = await leaseHouseholdNames(q, l.id)
          return { tenant_names: h.tenantNames, unit_number: h.unitNumber, property_name: h.propertyName }
        })(),
      })
    }
    const inForce = drafted.some((l) => l.status === 'active')
    const amount = amountCents / 100
    // The same permission the PATCH asks for, said before the press.
    if (!words && leases.length > 0 && (amount > 0 || inForce) && !userHasPerm(req.user, 'leases.terminate')) {
      words = cancelNeedsTerminateWords(status, inForce, amount)
    }
    res.json({ success: true, data: {
      booking: { id: booking.id, unit_id: booking.unit_id, guest_name: booking.guest_name, status: booking.status,
                 check_in: booking.check_in, check_out: booking.check_out },
      applies: words === null,
      words,
      leases: words === null ? leases : leases.map((l) => ({ ...l, lines: [], total: 0 })),
      total: words === null ? amount : 0,
      kept_total: keptCents / 100,
      // The confirm must send its total with the press (the PATCH refuses a blind one).
      needs_total: leases.length > 0 && (amount > 0 || inForce),
    } })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/bookings/:bookingId — update booking (status, move dates, swap unit)
//
// 10/3 (review, fix pass 2): "Check guests in" or "Check guests out" alone
// also gets in — a desk person who may only check guests in (or out) does it
// here. What such a save may change is held to exactly that inside (see
// "CHECKING A GUEST IN OR OUT NEEDS ONLY ITS OWN PERMISSION" below).
unitsRouter.patch('/:id/bookings/:bookingId', requirePerm('schedule.edit_reservation', 'guests.check_in', 'guests.check_out'), async (req, res, next) => {
  // S655 (Step 6 fix round 6): reservations an extension moved off this site
  // to make room (W-20) and that the save has not yet made final. A refusal
  // anywhere after the move puts them back (catch, below); the commit empties it.
  let relocated: RelocatedStay[] = []
  try {
    const { status, notes, checkIn, checkOut, unitId, guestName, guestEmail, guestPhone, requiredSiteLayout, requiredAmpService, lockedToUnit } = req.body
    // S653: an avoid list on an edit replaces the whole list (null/absent = unchanged).
    const avoidedIn: string[] | null = Array.isArray(req.body.avoidedUnitIds)
      ? req.body.avoidedUnitIds.filter((x: any) => typeof x === 'string').slice(0, 50) : null
    if (requiredSiteLayout != null && !RV_SITE_LAYOUTS.includes(requiredSiteLayout)) {
      throw new AppError(400, `Invalid requiredSiteLayout '${requiredSiteLayout}'`)
    }
    if (requiredAmpService != null && !RV_AMP_SERVICES.includes(requiredAmpService)) {
      throw new AppError(400, `Invalid requiredAmpService '${requiredAmpService}'`)
    }
    // S655 (Step 6 fix round): a status the schedule does not have is refused
    // in words, with nothing written. It used to reach the database and come
    // back as a 500 carrying the constraint's own text. (Absent or blank still
    // means "leave the status as it is", as before.)
    if (status != null && status !== '' && !isBookingStatus(status)) {
      throw new AppError(400,
        `That is not a reservation status. Use ${BOOKING_STATUS_CHOICES}.`)
    }
    // S655: the stored days as plain 'YYYY-MM-DD' text, so they compare with the
    // request's dates and the property's "today" without any clock or zone.
    const booking = await queryOne<any>(
      `SELECT *, to_char(check_in,  'YYYY-MM-DD') AS check_in_day,
                 to_char(check_out, 'YYYY-MM-DD') AS check_out_day
         FROM unit_bookings WHERE id=$1`, [req.params.bookingId])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // Property-locked workers may only edit reservations at their properties.
    // The property's time zone decides what "today" is for an early check-out.
    const bookingUnit = await queryOne<any>(
      `SELECT u.property_id, p.timezone
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id=$1`, [booking.unit_id])
    await assertPropertyInScope(req.user, bookingUnit?.property_id)

    // S655: a date that is not a date is refused in words, not stored as nights
    // of NaN or turned into a database error.
    const checkInDay  = checkIn  ? calendarDay(checkIn)  : null
    const checkOutDay = checkOut ? calendarDay(checkOut) : null
    if (checkIn && !checkInDay) throw new AppError(400, 'Check-in is not a date. Pick the day from the calendar and try again.')
    if (checkOut && !checkOutDay) throw new AppError(400, 'Check-out is not a date. Pick the day from the calendar and try again.')

    // S655: what CHANGED, not what was sent. The edit form sends check-in,
    // check-out and the site back on every save, so "it was in the request" read
    // a phone-number edit as a date change: the stay was repriced at whatever
    // the rates are today and the lease sync ran. After an early check-out
    // (below) that same save would have cut the total to the shortened stay and
    // pulled the lease's end in — exactly what an early check-out must not do.
    const checkInChanged  = !!checkInDay  && checkInDay  !== booking.check_in_day
    let   checkOutChanged = !!checkOutDay && checkOutDay !== booking.check_out_day
    const unitChanged     = !!unitId && unitId !== booking.unit_id
    const guest = booking.guest_name || 'This guest'

    // ── 10/3: CHECKING A GUEST IN OR OUT IS ITS OWN PERMISSION
    //
    // "Edit / move / cancel reservations" (schedule.edit_reservation, the
    // permission every other change on this route needs) says on its face:
    // "Checking a guest in is not part of this." So putting a guest into
    // Checked in needs "Check guests in" (guests.check_in), and checking one
    // out — or correcting the day a checked-out guest left — needs "Check
    // guests out" (guests.check_out).
    // Owners always may. Refused before anything is written.
    const toCheckIn = status === 'checked_in' && booking.status !== 'checked_in'
    const toCheckOut = status === 'checked_out'
      && (booking.status !== 'checked_out' || (!!checkOutDay && checkOutDay !== booking.check_out_day))
    for (const [wants, perm, act] of [
      [toCheckIn, 'guests.check_in', 'Checking a guest in'],
      [toCheckOut, 'guests.check_out', 'Checking a guest out'],
    ] as const) {
      if (wants && !userHasPerm(req.user, perm)) {
        throw new AppError(403,
          `${act} needs the "${SUB_PERMISSION_LABEL[perm]}" permission, and nothing was changed. `
          + `Ask the account owner to turn on "${SUB_PERMISSION_LABEL[perm]}" for you on the Team page.`)
      }
    }

    // ── 10/3 (review, fix pass 2): CHECKING A GUEST IN OR OUT NEEDS ONLY ITS
    // OWN PERMISSION
    //
    // A desk person with "Check guests in" but not "Edit / move / cancel
    // reservations" pressed Check in on the schedule and was always told
    // "Insufficient permissions". The Team page says "Check guests in" marks a guest
    // as arrived, and decisions #38 says "Check guests out" alone is enough to
    // check a guest out. So this route lets either one in (above), and without
    // the edit permission a save may do exactly one of these and nothing else:
    //   - check in a guest whose reservation is Tentative or Confirmed (what the
    //     schedule's Check in button offers), or
    //   - check out a guest who is Checked in, or correct the day a checked-out
    //     guest left. The day they left is the one date such a save may carry.
    // Everything else stays with the edit permission, as before: the dates, the
    // site, the guest's details, notes, site needs, the lock, the sites to
    // avoid, and any other status — canceling, a no-show, undoing a check-out,
    // or bringing back a no-show or canceled reservation. The fields the
    // schedule sends back unchanged do not count. Refused before anything is
    // written.
    if (!userHasPerm(req.user, 'schedule.edit_reservation')) {
      const refusal = deskOnlyRefusal(booking, {
        status, notes, guestName, guestEmail, guestPhone, requiredSiteLayout, requiredAmpService, lockedToUnit,
        avoidedIn, checkInChanged, checkOutChanged, unitChanged, toCheckOut,
      })
      if (refusal) throw new AppError(403, refusal)
    }

    // ── S655 (Step 6 fix round 3): A CHECK-OUT NEEDS A STAY, AND A STAY THAT
    // HAPPENED IS NOT A NO-SHOW OR A CANCELLATION
    //
    // Checking out a cancelled reservation cleared its cancellation and gave it
    // nights GAM bills for; a no-show has no stay to end either. The other way
    // round, a checked-out stay moved to No-show or Cancelled lost the day the
    // guest had booked — the undo below reads it back only from Checked out, so
    // Checked out → No-show → Checked in left the guest checked in on the
    // shortened stay. Each is refused in plain words with the step that gets
    // there, and nothing is written.
    // Step 9 final fix (fix pass 1 of the #53 close, review LOW): a canceled
    // or no-show stay whose drafted lease the never-moved-in close ended (its
    // move-in bill zeroed, its paperwork voided) can't be brought back — not
    // to Tentative, Confirmed or Checked in, nor checked out. The lease stays
    // ended and its bill stays zeroed, so the guest would be back on the site
    // with no lease and nothing billing them. The step that exists: a new
    // reservation. Refused before anything is written.
    //
    // Fix pass 2 (review MEDIUM): only a lease the close ended as an ISSUED
    // lease (something zeroed, or signed) — closedLeaseOfStay. An unsigned
    // draft the cancel ended with nothing zeroed comes back with its stay, as
    // S639 allowed, and the reservation money stays on the stay. Checked again
    // inside the save, with the stay's row locked (below).
    const bringsBackClosedStay = (booking.status === 'cancelled' || booking.status === 'no_show') && typeof status === 'string'
        && status !== booking.status && [...SITE_HOLDING_STATUSES, 'checked_out'].includes(status)
    if (bringsBackClosedStay) {
      const closedLease = await closedLeaseOfStay(booking.id)
      if (closedLease) throw new AppError(409, closedStayRefusal(guest, booking.status as 'cancelled' | 'no_show', closedLease.billZeroed))
    }
    if (status === 'checked_out' && booking.status === 'cancelled') {
      throw new AppError(409,
        `${guest === 'This guest' ? 'This' : `${guest}'s`} reservation was canceled, so there is no stay to check out. `
        + 'To bring it back, set it to Confirmed first.')
    }
    if (status === 'checked_out' && booking.status === 'no_show') {
      throw new AppError(409,
        `${guest} was marked a no-show, so there is no stay to check out. `
        + 'If they did come, set the reservation to Checked in first.')
    }
    // Final fix (fix pass 1, decisions #53): these never tell staff to set the
    // stay back to Confirmed — that step does not exist on the Schedule, and
    // undoing a stay that happened is exactly how rent for nights stayed got
    // zeroed. A stay that happened stays on the schedule as its record.
    if (booking.status === 'checked_out' && (status === 'cancelled' || status === 'no_show')) {
      throw new AppError(409, stayHappenedRefusal(guest, status))
    }
    // Fix pass 2 (review): nor a stay under way — the guest is on the site.
    if (booking.status === 'checked_in' && (status === 'cancelled' || status === 'no_show')) {
      throw new AppError(409, stayUnderWayRefusal(guest, status))
    }

    // "Today" is the PROPERTY's calendar day, never the server's (S654).
    const today = todayIn(bookingUnit?.timezone)

    // ── S655 (Step 6 fix round): NOBODY CHECKS OUT BEFORE THEY ARRIVE
    //
    // A stay that starts after today has no guest to check out, whatever day
    // is typed in. This was refused only when no day was given: Oct 5 to Oct 8
    // sent {status:'checked_out', checkOut:'2026-10-07'} on Oct 2 was stored
    // as checked out before arrival and repriced from three nights to two as
    // a date edit. The arrival the save would leave is the one that counts
    // (one typed in with the check-out, or the stored one). A plain save of a
    // stay that is already checked out (a phone number, a note) is left alone.
    const arrival: string = checkInChanged ? checkInDay! : booking.check_in_day
    if (status === 'checked_out' && today < arrival
        && (booking.status !== 'checked_out' || checkInChanged || checkOutChanged)) {
      throw new AppError(409,
        `${guest} has not arrived yet — check-in is ${longDay(arrival)}. `
        + 'To take the reservation off the schedule, cancel it instead.')
    }

    // ── S655 (Step 6 fix round 6): A CHECK-OUT IS SAVED ON ITS OWN
    //
    // A check-out — the status moving to Checked out, or the day a checked-out
    // guest left being corrected — that also changes the arrival day or the
    // site used to skip the check-out rules below and take the date-edit path:
    // the stay was repriced, the booking-lease sync ran (ending the lease on
    // whatever check-out the save left), and a check-out with no day typed in
    // was stored as Checked out with the site still held to the booked day.
    // Two different acts in one save, so one at a time, with nothing written.
    // (An arrival-day correction on a stay that is already checked out — no
    // new day they left — is still the plain edit it was.)
    const checkOutShaped = status === 'checked_out' && (booking.status !== 'checked_out' || checkOutChanged)
    if (checkOutShaped && (checkInChanged || unitChanged)) {
      throw new AppError(409,
        `${guest === 'This guest' ? "This guest's" : `${guest}'s`} check-out can't be saved together with a new `
        + `${checkInChanged && unitChanged ? 'arrival day and site' : checkInChanged ? 'arrival day' : 'site'}. `
        + `Make that change with Edit first, then ${booking.status === 'checked_out'
          ? 'set the day they left' : 'check them out'}.`)
    }

    // ── S655 (Step 6 fix round): NIGHTS THIS SAVE GIVES THE STAY ARE CHECKED
    // AGAIN AT THE MOMENT OF THE WRITE
    //
    // Every save that gives the stay nights on a site — an undo, a correction
    // that says they left later, a cancelled or no-show reservation brought
    // back, a date edit or a site move — checks those nights here first, so a
    // refusal comes before anything is decided. Each check is kept (the nights,
    // and the words if somebody else has them) and run AGAIN inside the write's
    // transaction, after the site is locked against everybody else who books
    // it (lockSitesForStays). The first check alone left a gap: a reservation
    // made on the freed nights between it and the write was not seen, and an
    // undo put the guest back onto nights a new guest now held (Oct 3 to Oct 5
    // held by two stays on one site).
    type SiteClaim = {
      unitId: string; checkIn: string; checkOut: string
      refusal: (c: Exclude<StayConflict, null>) => string | Promise<string>
    }
    const siteClaims: SiteClaim[] = []
    const claimNights = async (claim: SiteClaim) => {
      const conflict = await findStayConflict(claim.unitId, {
        checkIn: claim.checkIn, checkOut: claim.checkOut, excludeBookingId: booking.id,
      })
      if (conflict) throw new AppError(409, await claim.refusal(conflict))
      siteClaims.push(claim)
    }

    // S655 (Step 6 fix round 2): while the stored check-out is still an early
    // check-out's, the booked day it replaced is known here once — for a
    // correction of the day they left and the undo below, and for every other
    // edit of the stay (see "AFTER AN EARLY CHECK-OUT" below).
    const early = await bookedDayBeforeEarlyCheckOut(booking)

    // ── S655 (money plan Step 6): AN EARLY CHECK-OUT MOVES THE DATE, NOT THE MONEY
    //
    // Nic (10/2): "early checkout moves the check-out date." A guest who leaves
    // before their booked day is gone from the site that day: the schedule
    // frees it, the closing meter read is due that day, and GAM's per-night
    // count (services/billableUnits, read off check_out) stops there.
    //
    // The money does not move. The total is NOT repriced and the booking-lease
    // sync does NOT run — the lease is law. A landlord who means to shorten a
    // monthly stay (and bank what was paid past the new end) edits the dates
    // deliberately; that is the S548 path below.
    //
    // What counts as a check-out: the status moves to checked_out from any
    // other status, check-in and the site stay as they are, and either no
    // check-out day is given (they left today) or the day given is on or before
    // today (they left that day — "Pat left yesterday"). The landlord agent's
    // natural call for "Pat left today" is {status:'checked_out',
    // checkOut:<today>}, so the day they left can be typed; it is still the day
    // they left, not a new length of stay. A day typed AFTER today is refused
    // (fix rounds 5 and 6, below): nobody has left on a day that has not come.
    //
    // "Today" is the PROPERTY's calendar day, never the server's (S654).
    //   - Leaving on or after the booked check-out day: nothing moves (a late
    //     departure is not an extension), whether or not the day was typed in
    //     (fix round 2: "Pat left today" on a stay booked to end yesterday used
    //     to reprice the whole stay at today's rates, run the lease sync and,
    //     on a busy site, relocate the next guest). Billing the extra nights
    //     is a deliberate date edit.
    //   - Before check-in: they cannot have left a stay they never started —
    //     refused, with the next step.
    //   - On the arrival day itself: one night stays. A stay that started is a
    //     stay (S652), and no booking is ever zero nights — so the stored
    //     check-out is the day AFTER they left. Known consequence (documented,
    //     routed to the meter-read owner): the closing-read rule in
    //     services/utilityReadingRuns clears a departure only with a read dated
    //     on or after check_out, so a read taken on the arrival day itself does
    //     not clear it and a second read is due the next day. The day they
    //     actually left is kept in the history event (detail.left_on).
    //
    // Fix round 3: CORRECTING THE DAY A CHECKED-OUT GUEST LEFT. "Pat left
    // today", then "actually it was yesterday", reaches a stay that is already
    // checked out as {status:'checked_out', checkOut:<that day>}. It is the
    // same request as the first check-out and means the same thing — the day
    // they left — so it follows the same rules, measured against the day the
    // guest had BOOKED (an early check-out's booked day, from its history
    // event; otherwise the stored check-out): before it, the check-out moves to
    // the corrected day; on or after it, the booked day comes back (a late
    // departure is not an extension). It used to take the date-edit path: the
    // stay was repriced on the shortened length, the lease was ended on that
    // day, the next month's rent deleted and the rest banked. A bare
    // {checkOut} (the Edit form, or the agent without a status) is still the
    // landlord's deliberate date edit (S548).
    let checkOutMoved: { from: string; to: string } | null = null
    let checkOutRestored: { from: string; to: string } | null = null
    let leftOn: string | null = null
    // The booked day an early check-out (or a correction of one) records.
    let bookedForEvent: string | null = null
    // Set when a request corrected the day a checked-out guest left.
    let leftOnCorrected = false
    // (A check-out that also changed the arrival day or the site was refused
    // above, so every check-out-shaped request is a check-out here.)
    const checkOutRequest = checkOutShaped
    if (checkOutRequest) {
      // (A guest who has not arrived yet was refused above, before any of this.)
      const typed = checkOutChanged ? checkOutDay! : null
      if (typed === null || typed <= today) {
        const leaving = typed ?? today
        const booked = early?.booked ?? booking.check_out_day
        if (leaving < booked) {
          // Fix round 4: a day typed in BEFORE the arrival is a wrong day (the
          // wrong month or year), not a departure. It used to be read as "left
          // on the arrival day": a Sep 1 to Dec 1 stay typed out on Aug 15
          // dropped to one night, cutting the nights GAM bills for, and the
          // history recorded a departure that never happened. Refused, with
          // nothing written.
          if (leaving < booking.check_in_day) {
            throw new AppError(400,
              `${guest} arrived ${longDay(booking.check_in_day)}, so they can't have left `
              + `${longDay(leaving)}. Check the day and try again.`)
          }
          leftOn = leaving > booking.check_in_day ? leaving : booking.check_in_day
          const newOut = leaving > booking.check_in_day ? leaving : addDaysTo(booking.check_in_day, 1)
          if (newOut !== booking.check_out_day) {
            checkOutMoved = { from: booking.check_out_day, to: newOut }
            bookedForEvent = booked
          }
        } else if (booking.check_out_day !== booked) {
          // They stayed to (or past) the day they had booked: that day comes
          // back. Only a correction gets here — a first check-out's stored
          // check-out IS the booked day.
          leftOn = leaving
          checkOutRestored = { from: booking.check_out_day, to: booked }
        }
        // A correction that gives the guest back nights the check-out had
        // freed needs those nights to still be free.
        const later = checkOutRestored?.to
          ?? (checkOutMoved && checkOutMoved.to > booking.check_out_day ? checkOutMoved.to : null)
        if (later) {
          await claimNights({
            unitId: booking.unit_id, checkIn: booking.check_out_day, checkOut: later,
            refusal: (conflict) => conflict === 'booking'
              ? 'Another reservation now holds this site for some of the nights between '
                + `${longDay(booking.check_out_day)} and ${longDay(later)}, `
                + `so ${guest}'s check-out can't be moved to ${longDay(later)}. Move that reservation first.`
              : `${STAY_CONFLICT_MESSAGE[conflict]}, so ${guest}'s check-out can't be moved to ${longDay(later)}. `
                + 'Free those nights on the site first, then try again.',
          })
        }
        leftOnCorrected = booking.status === 'checked_out'
        // The typed day was the day they left, not a new length of stay.
        checkOutChanged = false
      } else {
        // A day after today is not a day anybody left on. Refused, with
        // nothing written:
        //  - Fix round 5: on a stay that is already checked out, this used to
        //    fall through to the date edit: a lease stay checked out Oct 2 and
        //    sent {status:'checked_out', checkOut:'2026-10-03'} was repriced to
        //    $1,596.77, its lease ended Oct 3, November's rent deleted and
        //    $1,403.23 banked; a nightly stay given back its (still future)
        //    booked day was repriced and held the site again for a guest who
        //    had gone.
        //  - Fix round 6: on a guest who is still here, too. {status:
        //    'checked_out', checkOut:'2026-10-05'} sent on Oct 2 for a Sep 28 to
        //    Oct 10 stay at $600 stored the stay as Checked out three days
        //    before the guest leaves, repriced it to $392 and ran the lease
        //    sync. Staff on the schedule are the only sender of a check-out
        //    (the landlord agent is refused in portalActions
        //    refuseAgentCheckOut), and "Pat leaves Monday, check her out"
        //    shortened the stay and its lease by accident.
        // The bare {checkOut} edit (the Edit form, or the agent without a
        // status) is still the landlord's deliberate date edit (S548).
        const hasLease = await queryOne(
          `SELECT 1 FROM leases WHERE source_booking_id = $1 AND status IN ('active', 'pending') LIMIT 1`,
          [booking.id])
        const howLong = `how long the stay${hasLease ? ' and its lease run' : ' runs'}`
        throw new AppError(409, booking.status === 'checked_out'
          ? `${guest} has already checked out, so the day they left can't be after today. `
            + `To change ${howLong}, change the check-out with Edit.`
          : `${guest} hasn't left yet. To change ${howLong}, change the check-out with Edit; `
            + 'check them out on the day they leave.')
      }
    }

    // 10/4 (decisions #38 Q11): the day a checked-out guest left can't be
    // corrected once a refund went out for it (or the stay was charged only the
    // nights stayed) — that money was decided on that day.
    if (leftOnCorrected && (checkOutMoved || checkOutRestored)) {
      const refusal = await checkOutChangeRefusal(booking.id, 'correct', guest)
      if (refusal) throw new AppError(409, refusal)
    }

    // ── S655 (Step 6 fix round): UNDOING A CHECK-OUT PUTS THE BOOKED DAY BACK
    //
    // A check-out recorded by mistake has a one-step back-out: move the status
    // back (checked in, confirmed) and, when that check-out had moved the
    // check-out day, the booked day comes back with it — the site is held for
    // the guest again, GAM's per-night count resumes, and no closing read is
    // due. Like the check-out itself it moves no money: no reprice, no lease
    // sync. The booked day comes from the check-out's own history event, and
    // only while nothing has changed the check-out since. A request that names
    // a different check-out day is a date edit instead; one that sends the
    // stored (early) check-out back unchanged, or the booked day itself, is
    // still the undo. If somebody has been booked into the freed nights since,
    // it is refused with the next step. (No-show and Cancelled cannot be
    // reached from Checked out — refused above — so the booked day is never
    // stranded behind them.)
    const undoing = !!early && booking.status === 'checked_out' && SITE_HOLDING_STATUSES.includes(status)
      && (!checkOutChanged || checkOutDay === early.booked)
    if (undoing && (checkInChanged || unitChanged)) {
      // Undoing the check-out AND moving the stay in one save would decide
      // the money twice over (which site's price, which nights). One at a time.
      throw new AppError(409,
        `${guest} checked out early, so put the check-out back first: set the status to `
        + `${bookingStatusLabel(status)} on its own. Then change the site or the arrival day.`)
    }
    // 10/4 (decisions #38 Q11): once a refund has gone out for an early
    // check-out, the check-out cannot be undone. Refused before anything is
    // written. (An undo after "Charge only the nights stayed" puts the booked
    // price back with the booked day — services/earlyCheckOut onCheckOutUndone.)
    if (undoing) {
      const refusal = await checkOutChangeRefusal(booking.id, 'undo', guest)
      if (refusal) throw new AppError(409, refusal)
    }
    if (undoing) {
      const booked = early!.booked
      await claimNights({
        unitId: booking.unit_id, checkIn: booking.check_out_day, checkOut: booked,
        refusal: async (conflict) => {
          // Fix round 5: name only a next step that works. "Or set a new
          // check-out with Edit" sent staff to save the day they left — which
          // is already the stored check-out, so the save changed nothing (no
          // message, the lease still running). An Edit can give nights back
          // only up to the night the other reservation starts; when it starts
          // on the day they left there is nothing to give, so moving it is the
          // one step. A site held some other way (owner's use, out of order, a
          // lease, onboarding) has to be freed first.
          //
          // Fix round 6: the Edit is named only when it would go through and
          // only when it is what staff mean by "put them back".
          //  - It runs the full site check over the stay's whole window (the
          //    arrival day to the new check-out), not just other reservations:
          //    a site out of order, in the owner's use or held some other way
          //    before the other reservation's first night made that Edit fail
          //    too ("That site is out of order for those dates"). Checked the
          //    same way here; if it would fail, only the move is named.
          //  - On a stay with a lease, that Edit is the landlord's deliberate
          //    shortening (S548): it ends the lease on that day, drops the
          //    rent after it and banks what was paid past it — a probe stay of
          //    $4,500 to Dec 1 went to $1,935.48 with the lease ending Oct 10,
          //    November's rent deleted and $1,064.52 banked, while the stay
          //    still read Checked out. Staff putting a guest back are never
          //    sent into that, so a lease stay names only the move.
          //
          // 10/3 (review): the Edit is named with the whole path back. Saving
          // it is the landlord's deliberate date change, so the stay is then
          // sold — and priced — for the shorter dates (decisions #33: its
          // booked check-out becomes that day), and it is still Checked out;
          // a second save sets the status back. And when the freed nights are
          // held by a reservation AND some other way (out of order, the
          // owner's use, a lease, onboarding), moving the reservation alone
          // would only be refused again, so both steps are named.
          let next = 'Free those nights on the site first, then try again.'
          if (conflict === 'booking') {
            const alsoHeld = await findStayConflict(booking.unit_id, {
              checkIn: booking.check_out_day, checkOut: booked, excludeBookingId: booking.id, ignoreBookings: true,
            })
            const first = alsoHeld
              ? 'Move that reservation and free those nights on the site first'
              : 'Move that reservation first'
            next = `${first}.`
            const heldFrom = await firstNightHeldByAnother(booking.unit_id, booking.check_out_day, booked, booking.id)
            if (heldFrom && heldFrom > booking.check_out_day) {
              const hasLease = await queryOne(
                `SELECT 1 FROM leases WHERE source_booking_id = $1 AND status IN ('active', 'pending') LIMIT 1`,
                [booking.id])
              const editWouldWork = !hasLease && (await findStayConflict(booking.unit_id, {
                checkIn: booking.check_in_day, checkOut: heldFrom, excludeBookingId: booking.id,
              })) === null
              if (editWouldWork) {
                next = `${first}, or use Edit to set a check-out no later than ${longDay(heldFrom)} `
                  + `(the stay is priced on the shorter dates), then set it back to ${bookingStatusLabel(status)}.`
              }
            }
          }
          return conflict === 'booking'
            ? 'Another reservation now holds this site for some of the nights between '
              + `${longDay(booking.check_out_day)} and ${longDay(booked)}, `
              + `so ${guest}'s stay can't be put back to ${longDay(booked)}. ${next}`
            : `${STAY_CONFLICT_MESSAGE[conflict]}, so ${guest}'s stay can't be put back to ${longDay(booked)}. ${next}`
        },
      })
      checkOutRestored = { from: booking.check_out_day, to: booked }
      // The booked day typed back in is the undo, not a date edit.
      checkOutChanged = false
    }

    const datesOrUnitChanged = checkInChanged || checkOutChanged || unitChanged

    // 10/4 (decisions #38): a deliberate new check-out on a stay that is
    // already checked out is a new length of stay — the money question its
    // early check-out asked goes with it (the price follows the dates). After a
    // refund it is refused, like an undo (Q11).
    const redatesCheckedOut = booking.status === 'checked_out' && checkOutChanged
    if (redatesCheckedOut) {
      const refusal = await checkOutChangeRefusal(booking.id, 'redate', guest)
      if (refusal) throw new AppError(409, refusal)
    }

    // ── S655 (Step 6 fix round 4): BRINGING BACK A CANCELLED OR NO-SHOW
    // RESERVATION NEEDS ITS NIGHTS TO STILL BE FREE
    //
    // A cancelled or no-show reservation lets go of its site, and somebody may
    // have been booked onto those nights since. Setting it back to Tentative,
    // Confirmed or Checked in (the step the check-out refusals above name) is a
    // status change only, and the site check below runs only when the dates or
    // the site change — so both reservations ended up holding the same site.
    // When the dates or site change too, that check covers it; otherwise the
    // stay's own nights are checked here. Refused in plain words with the next
    // step, and nothing is written.
    if ((booking.status === 'cancelled' || booking.status === 'no_show')
        && SITE_HOLDING_STATUSES.includes(status) && !datesOrUnitChanged) {
      const whose = guest === 'This guest' ? "this guest's" : `${guest}'s`
      const whom = guest === 'This guest' ? 'them' : guest
      await claimNights({
        unitId: booking.unit_id, checkIn: booking.check_in_day, checkOut: booking.check_out_day,
        refusal: (conflict) => conflict === 'booking'
          ? `Another reservation now holds this site for some of ${whose} nights. `
            + `Move that reservation first, or give ${whom} new dates with Edit.`
          : `${STAY_CONFLICT_MESSAGE[conflict]}, so ${whose} reservation can't be brought back on this site. `
            + `Give ${whom} new dates or another site with Edit.`,
      })
    }

    // ── S655 (Step 6 fix round 2): AFTER AN EARLY CHECK-OUT, ONLY A CHECK-OUT
    // EDIT MOVES MONEY
    //
    // While the stored check-out is still the day an early check-out put there,
    // it is the day the guest LEFT — not the length of the stay that was sold.
    // A later edit that leaves the check-out alone (a site move by drag or by
    // Edit, an arrival-day correction, the agent's edit) must not price the
    // stay on the shortened length or sync the lease to the day they left:
    // that would move the money the check-out deliberately did not (a $4,500
    // three-month stay repriced to $1,548.39, the lease ended Oct 2, November's
    // rent deleted and the rest banked). So: the total stays what it was (a
    // stay with no price yet is priced on the nights it was booked for), and
    // the lease sync does not run. The landlord's deliberate check-out edit is
    // still the one way to shorten the stay and its lease (S548).
    const keepsEarlyCheckOut = !!early && !checkOutChanged && !checkOutMoved && !checkOutRestored

    let newUnitId = unitId || booking.unit_id
    // Every date in this handler is plain 'YYYY-MM-DD' text — the request's day
    // or the stored day read as text above. pg hands DATE columns back as JS
    // Dates, and the stay pricing slices its dates: a
    // one-date edit of a monthly stay ("two more nights") crashed with a 500.
    const newCheckIn: string = checkInChanged ? checkInDay! : booking.check_in_day
    const newCheckOut: string = checkOutMoved?.to ?? checkOutRestored?.to
      ?? (checkOutChanged ? checkOutDay! : booking.check_out_day)
    // Every stay keeps at least one night — the same rule booking creation holds.
    if ((checkInChanged || checkOutChanged) && dayDiff(newCheckIn, newCheckOut) < 1) {
      throw new AppError(400, 'Check-out has to be at least one day after check-in.')
    }

    // 10/5 (Nic, R2/R6): what a longer stay needs is asked below, once the
    // new nights are known to be free (stayAsk).
    const stayTermsGiven = stayTermsIn(req.body?.stayTerms)
    let stayAsk: StayNeeds | null = null

    // ── 10/6 (Nic): RETURNING GUEST AND WORK TRADE ON A RESERVATION EDIT ──────
    //
    // "Returning guest — they've stayed with us before" may be chosen on an
    // edit too: for a stay that needs a background check and has none on file
    // (22+ continuous nights), it is recorded with the save and the stay no
    // longer waits on screening. A work trade can be ticked, changed or taken
    // off; it follows the stay's new dates and site. Both are refused, before
    // anything is written, for a desk without the permission each needs.
    const returningGuest = returningGuestIn(req)
    const workTrade = workTradeIn(req)
    const tradeBefore = await stayWorkTradeOf(booking.id)
    const rentTradedBefore = !!tradeBefore && tradeBefore.status !== 'ended' && tradeBefore.covered_charges.includes('rent')
    const rentTraded = workTrade === undefined ? rentTradedBefore : coversRent(workTrade)
    const tookMoney = !!booking.pos_transaction_id || !!booking.deposit_paid_at || !!booking.balance_paid_at
    if (rentTraded && !rentTradedBefore && tookMoney && Number(booking.total_amount) > 0) {
      throw new AppError(409,
        `${guest === 'This guest' ? 'This stay' : `${guest}'s stay`} already has money paid toward it, so its rent can't be traded now. `
        + 'Leave Rent unticked in the work trade, or settle what was paid first. Nothing was saved.')
    }
    if (workTrade) {
      await assertWorkTradeGuest({
        tenant_id: booking.tenant_id ?? null,
        guest_email: (typeof guestEmail === 'string' && guestEmail.trim()) || booking.guest_email || null,
        landlord_id: booking.landlord_id,
      })
    }

    // W-20: set when the extension fallback moved the EXTENDING guest to a
    // different site — surfaced in the response so staff can tell them.
    let extendedGuestMovedTo: { unitId: string; unitNumber: string } | null = null

    // S655 (Step 6 fix round): fresh at the moment of action. Everything above
    // was decided from the row as it was read at the start; if somebody else
    // changed the stay's status, site or dates since, this save is refused
    // rather than written over theirs — with code 'reservation_changed' and the
    // stay as it is now in `data`, so the screen can put the latest in front of
    // staff without another call. Checked inside the write (below) and, when
    // an extension is about to move the next reservation, before that move.
    //
    // 10/3: staff screens put the latest in place (the schedule loads `data`
    // into the open stay), so the words say what happened and what to do —
    // never "open it again".
    const reservationChanged =
      `${guest === 'This guest' ? 'This reservation' : `${guest}'s reservation`} was just changed by someone else, `
      + 'so your change was not saved. The latest is shown now; make your change again if it is still needed.'
    const answerChanged = async () => {
      const latest = await queryOne<any>('SELECT * FROM unit_bookings WHERE id = $1', [booking.id])
      return res.status(409).json({ success: false, code: 'reservation_changed', error: reservationChanged, data: latest })
    }
    // The check on its own, for before the extension's move: waits for
    // anybody mid-save on the stay, then lets go of it at once — nothing is
    // held while the move runs on its own connection.
    const stayChangedNow = async (): Promise<boolean> => {
      const c = await getClient()
      try {
        await c.query('BEGIN')
        const changed = await stayChangedSince(c, booking)
        await c.query('COMMIT')
        return changed
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally { c.release() }
    }

    // If dates or unit changed, verify target unit exists, belongs to the
    // same landlord, and check for conflicts. Repricing below reads its rates.
    let targetUnit: any = null
    if (datesOrUnitChanged) {
      targetUnit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [newUnitId, booking.landlord_id])
      if (!targetUnit) throw new AppError(404, 'Target unit not found')
      // Moving to another unit: the destination property must also be in scope.
      if (unitId && unitId !== booking.unit_id) {
        await assertPropertyInScope(req.user, targetUnit.property_id)
        // S653: never onto a site they asked not to have — by the system.
        // 10/6 (Nic): "we need it to actually do something in the schedule."
        // Every move the system makes skips an avoided site (compression, the
        // extension relocations, an unpaid hold moved for a payer). A person
        // dragging the stay there by hand is asked first, in plain words, and
        // the move goes through only when they confirm (overrideAvoided).
        const avoidNow = avoidedIn ?? (booking.avoided_unit_ids ?? [])
        if (avoidNow.includes(unitId) && req.body?.overrideAvoided !== true) {
          return void res.status(409).json({
            success: false,
            code: 'avoided_site',
            error: avoidedSiteWords(booking.guest_name, targetUnit.unit_number),
            unitNumber: targetUnit.unit_number,
          })
        }
      }

      // Shared predicate (services/unitAvailability): bookings + active
      // leases, excluding this booking and any lease drafted from it.
      let conflict = await findStayConflict(newUnitId, {
        checkIn: newCheckIn, checkOut: newCheckOut, excludeBookingId: booking.id,
      })

      // ── 10/5 (Nic, R2/R6): A LONGER STAY ASKS WHAT IT NEEDS
      //
      // A date change that makes the stay longer (an Edit, a drag of the bar's
      // edge, the landlord agent) and leaves the guest's continuous stay at 30+
      // nights with no lease or stay answer yet is refused with
      // 'stay_terms_needed', and the screen asks staff. Asked once the nights
      // are known to be free (a site that can't be had is refused first, as it
      // always was) and before anything is moved — the W-20 relocation below
      // included. A stay a lease was drafted from has its answer. One that
      // newly reaches 22 nights with no lease needs a way to reach the guest
      // (R7); after the save its check-in waits on a background check. A
      // shorter stay, or a site move at the same length, asks nothing — a stay
      // booked before 10/5 is left as it was until it is lengthened (R15).
      const extendsOwnSite = conflict === 'booking' && !unitId && (checkIn || checkOut)
      if (conflict && !extendsOwnSite) throw new AppError(409, STAY_CONFLICT_MESSAGE[conflict])
      let nightsBefore = dayDiff(booking.check_in_day, booking.check_out_day)
      let lengthens = (checkInChanged || checkOutChanged) && dayDiff(newCheckIn, newCheckOut) > nightsBefore
      // A drag that keeps the stay's own length can still make the guest's
      // CONTINUOUS stay longer (R7) — moved to start on their other stay's
      // check-out. Compared by the continuous nights before and after, so it
      // asks what a longer stay needs exactly as a lengthened bar does.
      if ((checkInChanged || checkOutChanged) && !lengthens && SITE_HOLDING_STATUSES.includes(status || booking.status)) {
        const chainOf = (ci: string, co: string) => continuousStayNights({
          propertyId: targetUnit.property_id, bookingId: booking.id, checkIn: ci, checkOut: co,
        })
        const [before, after] = await Promise.all([
          chainOf(booking.check_in_day, booking.check_out_day), chainOf(newCheckIn, newCheckOut)])
        if (after.nights > before.nights) { lengthens = true; nightsBefore = before.nights }
      }
      if (lengthens && SITE_HOLDING_STATUSES.includes(status || booking.status)) {
        const hasLease = !!(await stayLeaseOf(booking.id))
        stayAsk = await stayNeeds({
          landlordId: booking.landlord_id, propertyId: targetUnit.property_id, bookingId: booking.id,
          checkIn: newCheckIn, checkOut: newCheckOut,
          stayTerms: stayTermsGiven ?? (hasLease ? 'lease' : null),
          returning: returningGuest && !hasLease, offerReturning: canAttestReturningGuest(req.user),
        })
        if (stayAsk.leaseChoice === 'needed') return void res.status(409).json(stayTermsNeededBody(stayAsk))
        if (!hasLease && stayAsk.nights >= STAY_SCREENING_NIGHTS && nightsBefore < STAY_SCREENING_NIGHTS
            && !stayAsk.chain.email && !stayAsk.chain.tenantId
            && !(typeof guestEmail === 'string' && guestEmail.trim())) {
          throw new AppError(400, LONG_STAY_NEEDS_EMAIL)
        }
      }

      // W-20 extension protection (Nic): the sitting guest extending on
      // their OWN site takes priority — the incoming reservation gets
      // relocated to a compatible open site (it hasn't been revealed yet,
      // so the incoming guest never sees the move). Only for same-unit
      // date changes; a deliberate unit swap into a conflict still 409s.
      if (extendsOwnSite) {
        const { relocateBlockingBookings, rankUnitsBestFit } =
          await import('../services/scheduleCompression')
        // S655 (Step 6 fix round 6): the move below is written on its own,
        // ahead of this save. So first: is the stay still as this save read
        // it? Anybody mid-save on it is waited for, and a change refuses the
        // save before anything is moved. (A refusal that still comes after
        // the move puts the moved reservations back — putRelocatedBack.)
        if (await stayChangedNow()) return answerChanged()
        const relo = await relocateBlockingBookings(
          newUnitId, { checkIn: newCheckIn, checkOut: newCheckOut }, booking.id)
        relocated = await stillRelocated(relo.moves.map(m => m.bookingId), newUnitId)
        if (relo.ok) {
          conflict = await findStayConflict(newUnitId, {
            checkIn: newCheckIn, checkOut: newCheckOut, excludeBookingId: booking.id,
          })
        } else if (booking.locked_to_unit) {
          // S547: a locked (snowbird) reservation never moves — not even by
          // its own extension. The extension simply fails on conflict.
          throw new AppError(409, `Cannot extend: ${relo.reason}, and this reservation is locked to its site`)
        } else {
          // BACKUP (Nic — busy seasons are competitive): the incoming
          // reservation can't move, so try moving the EXTENDING guest
          // instead — any compatible site where the WHOLE extended stay
          // fits. Their site was already revealed, but this move is their
          // own choice: extend-and-relocate beats no-extension.
          const candidates = await query<any>(`
            SELECT id, unit_number, rv_site_layout, rv_amp_service
              FROM units
             WHERE property_id = $1 AND id != $2
               AND is_bookable = TRUE
               AND (lease_types_allowed && ARRAY['nightly','weekly']::text[])
             ORDER BY unit_number`, [targetUnit.property_id, booking.unit_id])
          const compatible = candidates.filter((c: any) =>
            !isSiteLayoutMismatch(booking.required_site_layout, c.rv_site_layout) &&
            !isAmpServiceMismatch(booking.required_amp_service, c.rv_amp_service) &&
            // S653; 10/6 (review): the list this same save stores — a site
            // added to the avoid list in the edit that lengthens the stay is
            // already avoided here.
            !(avoidedIn ?? booking.avoided_unit_ids ?? []).includes(c.id))
          const ranked = await rankUnitsBestFit(
            compatible.map((c: any) => c.id),
            { checkIn: newCheckIn, checkOut: newCheckOut })
          if (!ranked.length) {
            throw new AppError(409,
              `Cannot extend: ${relo.reason}, and no open site fits the extended stay`)
          }
          newUnitId = ranked[0]
          const dest = candidates.find((c: any) => c.id === ranked[0])
          extendedGuestMovedTo = { unitId: ranked[0], unitNumber: dest?.unit_number ?? '' }
          targetUnit = await queryOne<any>(
            'SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [newUnitId, booking.landlord_id])
          logger.info(`[extend] extending guest moves sites: booking=${booking.id} → ${dest?.unit_number}`)
          conflict = null
        }
      }
      if (conflict) throw new AppError(409, STAY_CONFLICT_MESSAGE[conflict])
      // Checked again inside the write (see SiteClaim above): the nights on
      // the site the stay ends up on, after any extension move.
      siteClaims.push({
        unitId: newUnitId, checkIn: newCheckIn, checkOut: newCheckOut,
        refusal: (c) => STAY_CONFLICT_MESSAGE[c],
      })
    }

    // 10/6: "Returning guest" chosen on an edit that does not lengthen the stay —
    // asked of the stay as it will stand (a stay that does not need a check,
    // or already has one on file, records nothing).
    let returningNow: StayNeeds | null = null
    if (returningGuest && !stayAsk && SITE_HOLDING_STATUSES.includes(status || booking.status)) {
      returningNow = await stayNeeds({
        landlordId: booking.landlord_id, propertyId: targetUnit?.property_id ?? bookingUnit!.property_id, bookingId: booking.id,
        checkIn: newCheckIn, checkOut: newCheckOut, returning: true,
      })
    }
    const attestReturning = !!(stayAsk?.returningAttestNow || returningNow?.returningAttestNow)

    // S559: same-day turnover guard — do NOT check a new guest into a spot
    // whose previous occupant's submeter hasn't been read yet, or the two
    // stays' usage smears together. Surface the pending read so the desk can
    // take it inline (blind) and retry; a landlord (properties.edit) may
    // override for a broken/unreadable meter so a paying guest is never
    // stranded. Broken meters are already excluded (they bill from comparables).
    //
    // S655: undoing a check-out on the same site is not a turnover — it is the
    // same guest going back onto their own spot, and their own (mistaken)
    // departure is what makes a closing read look due. Asking for that read
    // would block the back-out and stamp a "closing" read for a guest who never
    // left. On a different site it is a new arrival there, and the guard holds.
    const sameGuestBackOnSite = booking.status === 'checked_out' && newUnitId === booking.unit_id

    // ── 10/5 (Nic, R9): CHECK-IN WAITS ON THE BACKGROUND CHECK
    //
    // A stay of more than three weeks checks in only once its check's results
    // are back AND the landlord has decided — approved or denied (after a
    // denial the landlord may still check them in). No override, owners
    // included, and whatever the permissions: the desk is told plainly what it
    // is waiting on. Asked before the meter-read prompt, so nobody takes a
    // closing read and is then refused; asked again inside the save, after
    // the stay's row is locked (a decision undone in between is honored).
    // Putting back a check-out is not an arrival — the guest was already in.
    const arriving = status === 'checked_in' && booking.status !== 'checked_in' && booking.status !== 'checked_out'
    if (arriving && !attestReturning) {
      const block = await checkInBlock(booking.id)
      if (block) {
        if (relocated.length) {
          const moved = relocated
          relocated = []
          await putRelocatedBack(moved)
        }
        return void res.status(409).json(screeningPendingBody(block))
      }
    }

    if (status === 'checked_in' && booking.status !== 'checked_in' && !sameGuestBackOnSite) {
      const pending = await unitPendingReads(newUnitId)
      const isOwner = ['landlord', 'admin', 'super_admin'].includes(req.user!.role)
      const canOverride = isOwner || (req.user!.permissions as any)?.['properties.edit'] === true
      if (pending.length > 0 && !(req.body.overrideMeterRead && canOverride)) {
        // 10/3 (review, V1): this refusal answers here rather than throwing, so
        // the catch below never sees it. A check-in that also extended the
        // stay may already have moved the next reservation off the site to
        // make room (W-20) — that extension is not happening, so it goes back
        // before the answer.
        if (relocated.length) {
          const moved = relocated
          relocated = []
          await putRelocatedBack(moved)
        }
        return res.status(409).json({
          success: false,
          code: 'meter_read_due',
          error: 'A closing meter read is due on this spot before check-in. Take the read, then check the guest in.',
          meters: pending,
          canOverride,
        })
      }
    }

    // S553: both are 'YYYY-MM-DD' text now (above); dayDiff takes either.
    const nights = dayDiff(newCheckIn, newCheckOut)

    // Reprice when dates or the unit change — the stored total must never drift
    // from the new stay. Same unit-rate-then-property-default rule as create.
    // A pure status/notes/guest edit keeps the existing total.
    //
    // S655 (Step 6 fix round): a reservation with NO price yet — $0, booked
    // before the site had rates — takes the site's price when it is saved from
    // the edit form (which always sends the dates and the site), even with the
    // dates unchanged. The register refuses a $0 reservation ("Set its price on
    // the schedule"), and the schedule has no price box: this save is how staff
    // give it one. A stay that already took money is never repriced here, and
    // neither is a check-out (early, on time or late — the day typed in or
    // not) or its undo (those move no money).
    //
    // Fix round 2: after an early check-out (keepsEarlyCheckOut, above) a
    // priced stay keeps its total through a site move or an arrival-day
    // correction, and a stay with no price yet is priced on the nights it was
    // BOOKED for (arrival to the booked check-out), never on the shortened stay.
    const unpriced = !(Number(booking.total_amount) > 0) && !rentTradedBefore
      && !booking.pos_transaction_id && !booking.deposit_paid_at && !booking.balance_paid_at
    // (A correction of the day a checked-out guest left is a check-out too.)
    const isCheckOut = status === 'checked_out' && (booking.status !== 'checked_out' || leftOnCorrected)
    const priceUnpriced = unpriced && !isCheckOut && !checkOutMoved && !checkOutRestored
      && !!(checkIn || checkOut || unitId)
    // 10/6: rent traded or no longer traded by this save — the stay is priced again.
    // 10/6 (review): a traded stay whose check fee was paid (a $0 + fee link or
    // ticket) has taken money but owes no rent — taking the trade off prices it.
    const tradeFlipped = rentTraded !== rentTradedBefore && (!tookMoney || rentTradedBefore)
    const repriceDue = keepsEarlyCheckOut ? priceUnpriced : (datesOrUnitChanged || priceUnpriced || tradeFlipped)
    const priceThrough = keepsEarlyCheckOut ? early!.booked : newCheckOut
    if (repriceDue && !targetUnit) {
      targetUnit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [newUnitId, booking.landlord_id])
    }
    let newTotal: number | null = null
    if (repriceDue && targetUnit) {
      const prop = await queryOne<any>(
        'SELECT nightly_rate, weekly_rate, monthly_rate, short_term_tax_rate FROM properties WHERE id=$1',
        [targetUnit.property_id])
      // 10/4 (early check-out plan, BUG-D): the schedule's ONE pricing function
      // (services/registerStay scheduleStayPrice — 10/6: the shared priceStay,
      // the cheapest whole months, weeks and nights that cover the stay, plus
      // the lodging tax under 30 nights) — the copy that lived here could drift
      // from what the register, a pay link and the early check-out price.
      const priced = scheduleStayPrice(
        { nightly: targetUnit.nightly_rate ?? prop?.nightly_rate,
          weekly:  targetUnit.weekly_rate  ?? prop?.weekly_rate,
          monthly: targetUnit.monthly_rate ?? prop?.monthly_rate },
        prop?.short_term_tax_rate ?? 0, newCheckIn, priceThrough)
      if (priced.total > 0) newTotal = priced.total
    }
    // 10/6 (Nic): a work trade that covers rent — the site costs the guest nothing.
    // 10/6 (review): even after money was taken — that money was the check's
    // fee (rent cannot be traded onto a stay with money paid toward a real
    // total; refused above), so a re-dated or moved traded stay stays $0.
    if (repriceDue && rentTraded) newTotal = 0

    const avoidedFinal = avoidedIn
      ? await scopedAvoidedUnits(avoidedIn, targetUnit?.property_id ?? bookingUnit!.property_id)
      : null

    // S655 (Step 6 fix round): the write, and — for a check-out that moved the
    // day or its undo — the history event that records the booked day, land
    // together or not at all: the undo reads that event, so a check-out without
    // it could never be backed out cleanly.
    //
    // Fresh at the moment of action (see answerChanged above): the stay is
    // locked and compared with the row everything above was decided from.
    //
    // Then the nights this save gives the stay (siteClaims) are checked again
    // with the site locked against every other way a stay is put on it (see
    // lockSitesForStays for the lock order: the claimed sites' own rows first,
    // then this stay's row, then the sites).
    // 10/4 (decisions #38 Q8): a long stay on a lease is NEVER billed past the
    // day the guest leaves. An early check-out of a stay with a lease makes the
    // day they left the length it is sold for, so the lease follows it (the
    // sync after the save ends the lease that day, drops the rent past it and
    // banks what was paid past it; the existing move-out machinery makes the
    // final bill). The history event still records the booked day, so an undo
    // puts it — and the lease — back.
    const endsLease = !!checkOutMoved && !!(await queryOne(
      `SELECT 1 FROM leases WHERE source_booking_id = $1 AND status IN ('active', 'pending') LIMIT 1`, [booking.id]))
    const restoresLease = !!checkOutRestored && !!(await queryOne(
      `SELECT 1 FROM leases WHERE source_booking_id = $1 AND status IN ('active', 'pending') LIMIT 1`, [booking.id]))

    let updated: any
    // 10/6 (review): a placeholder account's set-up link, made with the work trade.
    let editWtInvite: StayWorkTradeInvite | null = null
    // 10/6 (review): what the returning guest took the check's fee off, and the card pages to close.
    let editReturningAfterCommit: (() => Promise<void>) | null = null
    let editFeeDropped: import('../services/stayTerms').ScreeningFeeDropped | null = null
    // Step 9 final fix (fix pass 1): what canceling the stay closed on the
    // lease drafted with it, and the bank pulls that close stopped (canceled
    // after the commit).
    let leaseClosedOnCancel: { amount: number; leases: number; keptTotal: number; keptWords: string[] } | null = null
    let stopAfterCancel: string[] = []
    // Final fix (fix pass 2, review): a status change into or out of Checked
    // in / Checked out is written to the stay's history inside the save
    // (below), so the after-commit history diff leaves it out.
    let statusRecordedInSave = false
    let changedBySomeoneElse = false
    let screeningBlockedInSave: CheckInBlock | null = null
    let failure: unknown = null
    // 10/3 (review, fix pass 2): a write the database ended to break a
    // deadlock did nothing, so it runs again from the top, like a reservation
    // made on the schedule (the booking POST). One that keeps meeting one is
    // answered in plain words (SAVED_AT_THE_SAME_MOMENT, below), never the
    // database's own text in a 500.
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) await pauseBeforeTry(attempt - 1)
      failure = null
      leaseClosedOnCancel = null
      stopAfterCancel = []
      statusRecordedInSave = false
      screeningBlockedInSave = null
      const tx = await getClient()
      try {
        await tx.query('BEGIN')
        // 10/3 (review, fix pass 2): the claimed sites' own rows first, before
        // this stay's row and the sites. Moving the stay onto a site needs that
        // site's row for the write, and a pay link being sent for the site
        // (posPayLinks) holds the row while it waits for the site. This save
        // used to take the site and then wait on the row, and the database
        // ended one of the two with a deadlock (probe C3: the move failed 3
        // times out of 3). Taken first, this save waits for the link while
        // holding nothing, then goes on. FOR KEY SHARE only keeps the row from
        // going away, so the one thing it waits for is a lock like the link's.
        // The booking POST and the register take the same first step.
        const claimedSites = [...new Set(siteClaims.map(c => c.unitId))].sort()
        if (claimedSites.length) {
          await tx.query(`SELECT 1 FROM units WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE`, [claimedSites])
        }
        if (await stayChangedSince(tx, booking)) {
          changedBySomeoneElse = true
          throw new AppError(409, reservationChanged)
        }
        // 10/5 (R9): the screening gate again, with the stay's row locked.
        if (arriving && !attestReturning) {
          const blockNow = await checkInBlock(booking.id)
          if (blockNow) {
            screeningBlockedInSave = blockNow
            throw new AppError(409, blockNow.message)
          }
        }
        // Step 9 final fix (fix pass 2, review LOW): the closed-lease check
        // again, now that the stay's row is locked. "They never moved in" on
        // the Leases page, run on this stay's already-ended lease while this
        // save was on its way, changes nothing on the stay row (it is already
        // canceled), so stayChangedSince cannot see it; it takes this same row
        // first (assessNeverMovedIn), so by now it has committed or waits.
        if (bringsBackClosedStay) {
          const closedNow = await closedLeaseOfStay(booking.id, tx)
          if (closedNow) throw new AppError(409, closedStayRefusal(guest, booking.status as 'cancelled' | 'no_show', closedNow.billZeroed))
        }
        if (siteClaims.length) {
          await lockSitesForStays(tx, claimedSites)
          for (const claim of siteClaims) {
            const conflict = await findStayConflict(claim.unitId, {
              checkIn: claim.checkIn, checkOut: claim.checkOut, excludeBookingId: booking.id,
            })
            if (conflict) throw new AppError(409, await claim.refusal(conflict))
          }
        }
        // 10/4 (decisions #38): a check-out put back — or the day they left
        // corrected, or a new length set — takes its money question with it (a
        // stay charged only the nights stayed goes back to its booked price,
        // before any reprice below). A new check-out asks again.
        //
        // Fix pass (review r3, #38 Q11): the refusals above read before this
        // transaction; a refund decided in between (another person deciding
        // the money on a stay already checked out — it changes neither the
        // status, the site nor the dates, so stayChangedSince cannot see it) is
        // caught here, with the stay's row and its decision locked: the same
        // words, and nothing is saved.
        if (checkOutRestored || (checkOutMoved && leftOnCorrected) || redatesCheckedOut) {
          await onCheckOutUndone(tx, booking.id, {
            guest,
            change: leftOnCorrected && (checkOutMoved || checkOutRestored) ? 'correct' : undoing ? 'undo' : 'redate',
          })
        }
        // ── Step 9 final fix (fix pass 1, decisions #46.4): CANCELING A STAY
        // CLOSES THE LEASE DRAFTED WITH IT — IN THIS SAVE ────────────────────
        //
        // A stay of 30 nights or more drafts a lease alongside it (S526). S639
        // made canceling the stay end that lease while it is still paperwork
        // ('pending' / 'draft') — but with a bare UPDATE after the save, so a
        // lease the tenant had signed and the landlord had issued kept its
        // move-in bill owed for a tenancy that never happened, and "They never
        // moved in" then answered "This lease has already ended. Nothing else
        // to do." There is no no-show button on the Schedule: canceling the
        // stay IS staff saying the guest is not coming. So the cancel runs the
        // same close as "They never moved in — end the lease"
        // (lib/unwindIssuedLease.endLeaseNeverMovedIn, attested), here, in this
        // transaction: the unpaid move-in bill zeroed, the lease ended, the
        // household taken off it. When the close does not apply — money was
        // paid on the lease, a payment is on its way, the stay was checked in —
        // the cancel is refused in the close's own words, naming the real next
        // step, and nothing changes.
        //
        // Fix pass 3 (review, HIGH): an ACTIVE drafted lease too. Once the
        // landlord has signed, the scheduler makes the drafted lease 'active'
        // on its start date — the check-in day — and a no-show is noticed on
        // or after that day. The cancel used to answer 200 and leave that lease
        // active: rent billing every month, the move-in bill owed, the space
        // occupied. The S639 "an active lease is never touched here" rule
        // predates the attested close; a landlord-signed 'pending' lease is
        // just as signed, and the close refuses every lease anyone lived under
        // (checked in, a finalized walkthrough, money paid or on its way, a
        // renewal) with the move-out step. So the cancel never succeeds
        // silently while a lease drafted with the stay keeps billing.
        //
        // A No-show (status 'no_show' — the API and the landlord assistant can
        // send it; the Schedule has no such button) is the same fact as
        // canceling the stay, so it runs the same close.
        const closesDraftedLease = (status === 'cancelled' || status === 'no_show') && booking.status !== status
        if (closesDraftedLease) {
          const drafted = (await tx.query<{ id: string; unit_id: string; status: string }>(
            `SELECT id, unit_id, status FROM leases
              WHERE source_booking_id = $1 AND status IN ('pending', 'draft', 'active')
              ORDER BY created_at, id`, [booking.id])).rows
          if (drafted.length > 0) {
            const { endLeaseNeverMovedIn } = await import('../lib/unwindIssuedLease')
            const reader = {
              canMarkLeaving: userHasPerm(req.user, 'leases.edit', 'front_desk.mark_leaving'),
              canMoveOut: userHasPerm(req.user, 'leases.deposit_return'),
            }
            let amount = 0
            let keptCents = 0
            const keptWords: string[] = []
            for (const l of drafted) {
              const closed = await endLeaseNeverMovedIn(tx, l, {
                reader, cancelingBooking: booking.id, actorUserId: req.user!.userId,
                refusalLead: cancelRefusalLead(guest, status),
              })
              stopAfterCancel.push(...closed.cancelAfterCommit)
              amount += closed.closedAmount
              keptCents += Math.round(closed.assessment.keptTotal * 100)
              if (closed.assessment.keptWords) keptWords.push(closed.assessment.keptWords)
            }
            amount = Math.round(amount * 100) / 100
            // Step 9 final fix (fix pass 2, review): zeroing a move-in bill
            // writes money off — the same close through "They never moved in"
            // (and Discard) needs "Terminate leases". "Edit / move / cancel
            // reservations" alone used to be enough to forgive a bill of any
            // size by canceling the stay. Checked on what the close would
            // zero NOW (fresh, under its locks); refused before the commit, so
            // nothing changes. A drafted lease with nothing to zero (unsigned
            // paperwork) still ends with the stay, as S639 made it.
            //
            // Fix pass 3: ending a lease already in force is ending a tenancy
            // — "Terminate leases" too, even with nothing to zero.
            const inForce = drafted.some(l => l.status === 'active')
            if ((amount > 0 || inForce) && !userHasPerm(req.user, 'leases.terminate')) {
              throw new AppError(403, cancelNeedsTerminateWords(status, inForce, amount))
            }
            // Fresh at the moment of action: a Schedule confirm that showed
            // what would be zeroed sends its total; a different figure now
            // (a bill changed in between) is refused with nothing changed.
            //
            // Final fix (fix pass 1, decisions #53 — "never runs blind"): the
            // total is REQUIRED when the cancel would zero a bill or end a
            // lease in force. A bare {status:'cancelled'} (an old screen, the
            // API) used to zero it with nobody shown the lines.
            const expectedRaw = req.body?.expectedNeverMovedInTotal
            if ((amount > 0 || inForce) && (expectedRaw === undefined || expectedRaw === null)) {
              throw new AppError(409, `${cancelEndsLeaseWords(status, inForce, amount)}. ${CANCEL_NEEDS_CONFIRM_TAIL}`)
            }
            // Fix pass 2 (review): the Schedule's confirm also sends how many
            // drafted leases it showed. A lease drafted after it read (with
            // nothing to zero, so the totals would agree) is not ended unseen.
            const expectedLeasesRaw = req.body?.expectedNeverMovedInLeases
            // Fix pass 3 (review): the count is REQUIRED whenever the cancel
            // would zero a bill or end a lease in force, or a total was sent.
            // A total alone (an older screen, the API) read before a lease was
            // drafted said $0 — and a drafted lease that became active since,
            // with nothing to zero, agreed with it and was ended unseen.
            const totalSent = expectedRaw !== undefined && expectedRaw !== null
            if ((amount > 0 || inForce || totalSent) && typeof expectedLeasesRaw !== 'number') {
              throw new AppError(409, `${cancelEndsLeaseWords(status, inForce, amount)}. ${CANCEL_NEEDS_CONFIRM_TAIL}`)
            }
            if (typeof expectedLeasesRaw === 'number' && expectedLeasesRaw !== drafted.length) {
              throw new AppError(409, CANCEL_LEASES_CHANGED_WORDS)
            }
            if (expectedRaw !== undefined && expectedRaw !== null) {
              const expected = Number(expectedRaw)
              if (!Number.isFinite(expected) || Math.round(expected * 100) !== Math.round(amount * 100)) {
                const { NEVER_MOVED_IN_CHANGED_WORDS } = await import('../lib/unwindIssuedLease')
                throw new AppError(409, NEVER_MOVED_IN_CHANGED_WORDS)
              }
            }
            leaseClosedOnCancel = { amount, leases: drafted.length, keptTotal: keptCents / 100, keptWords }
          }
        }
        updated = (await tx.query<any>(`
          UPDATE unit_bookings
          SET status=COALESCE($1,status), notes=COALESCE($2,notes),
              unit_id=$3, check_in=$4, check_out=$5, nights=$6,
              guest_name=COALESCE($8,guest_name),
              guest_email=COALESCE($9,guest_email),
              guest_phone=COALESCE($10,guest_phone),
              total_amount=COALESCE($11,total_amount),
              platform_fee=COALESCE($12,platform_fee),
              required_site_layout=COALESCE($13,required_site_layout),
              required_amp_service=COALESCE($14,required_amp_service),
              locked_to_unit=COALESCE($15,locked_to_unit),
              avoided_unit_ids=COALESCE($16::uuid[],avoided_unit_ids),
              -- 10/3 (decisions #33): the length the stay is sold for. A
              -- deliberate change of the check-out ($17) is a new length. An
              -- early check-out, a correction of the day they left and an undo
              -- ($18, the booked day) keep the length as it read BEFORE this save
              -- (soldCheckOutSql: the later of the column and the stored
              -- check-out — these SET expressions see the old values), and never
              -- less than the booked day: a path that lengthened the stay without
              -- writing the column (the guest agent's extra night) would
              -- otherwise leave the shorter day standing across the check-out.
              booked_check_out = CASE
                WHEN $17::date IS NOT NULL THEN $17::date
                WHEN $18::date IS NOT NULL THEN GREATEST(booked_check_out, check_out, $18::date)
                ELSE booked_check_out END,
              -- S652: stamp WHEN it was cancelled, once. Nights are exempt from
              -- GAM's fee only when this lands before arrival, so the moment has to
              -- be recorded at the moment — updated_at moves for every later edit
              -- and could not answer the question afterwards.
              cancelled_at = CASE
                WHEN $1 = 'cancelled' AND cancelled_at IS NULL THEN NOW()
                WHEN $1 IS NOT NULL AND $1 <> 'cancelled' THEN NULL
                ELSE cancelled_at END,
              updated_at=NOW()
          WHERE id=$7 RETURNING *`,
          [status||null, notes||null, newUnitId, newCheckIn, newCheckOut, nights, booking.id,
           guestName ?? null, guestEmail ?? null, guestPhone ?? null,
           // Reprice zeroes the fee too (S526: reservations carry no platform fee).
           newTotal, newTotal != null ? 0 : null, requiredSiteLayout ?? null, requiredAmpService ?? null,
           typeof lockedToUnit === 'boolean' ? lockedToUnit : null,
           avoidedFinal,
           checkOutChanged || endsLease ? newCheckOut : null,
           checkOutMoved ? (bookedForEvent ?? booking.check_out_day) : checkOutRestored ? checkOutRestored.to : null,
          ])).rows[0]

        if (checkOutMoved || checkOutRestored) {
          const from = { check_in: booking.check_in_day, check_out: booking.check_out_day }
          const to   = { check_in: newCheckIn, check_out: newCheckOut }
          const n = Math.abs(dayDiff(booking.check_out_day, newCheckOut))
          const days = `${n} day${n === 1 ? '' : 's'}`
          const who = booking.guest_name || 'Guest'
          const base = {
            client: tx, bookingId: booking.id, unitId: booking.unit_id,
            landlordId: booking.landlord_id, actorUserId: req.user!.userId,
          }
          // Fix round 3: a correction of the day a checked-out guest left says
          // so, and — while the check-out is still before the booked day — keeps
          // the early check-out's mark and the booked day, so an undo still puts
          // the booked day back.
          const later = newCheckOut > booking.check_out_day
          const moveFrom = longDay(from.check_out)
          const moveTo = longDay(to.check_out)
          let summary: string
          if (checkOutMoved && !leftOnCorrected) {
            summary = `${who} checked out early — check-out moved from ${moveFrom} to ${moveTo} (${days} removed)`
          } else if (checkOutMoved) {
            summary = later
              ? `${who} left later than recorded — check-out moved from ${moveFrom} to ${moveTo} (${days} added back)`
              : `${who} left earlier than recorded — check-out moved from ${moveFrom} to ${moveTo} (${days} removed)`
          } else if (leftOnCorrected) {
            summary = `${who} stayed to the day they had booked — check-out back to ${moveTo} (${days} added back)`
          } else {
            summary = `${who}'s check-out undone — check-out back to ${moveTo} (${days} added back)`
          }
          await recordBookingEvent({
            ...base, eventType: 'dates_changed',
            summary,
            detail: checkOutMoved
              ? { from, to, delta: `${days} ${later ? 'added' : 'removed'}`, early_check_out: true,
                  booked_check_out: bookedForEvent ?? from.check_out, left_on: leftOn,
                  ...(leftOnCorrected ? { left_on_corrected: true } : {}) }
              : { from, to, delta: `${days} added`, check_out_restored: true,
                  ...(leftOnCorrected ? { left_on: leftOn, left_on_corrected: true } : {}) },
          })
          if (updated.status !== booking.status) {
            await recordBookingEvent({
              ...base, eventType: 'status_changed',
              summary: `${who} status: ${bookingStatusLabel(booking.status)} → ${bookingStatusLabel(updated.status)}`,
              detail: { from_status: booking.status, to_status: updated.status },
            })
          }
        }

        // Fix round 2: an arrival-day correction after an early check-out keeps
        // the check-out the guest left on, so its history event carries the
        // early check-out's mark and the booked day forward — the next edit (or
        // an undo) still knows the stored check-out is the day they left. Written
        // with the save, like the check-out's own event, so the two never part.
        if (keepsEarlyCheckOut && checkInChanged) {
          const who = booking.guest_name || 'Guest'
          await recordBookingEvent({
            client: tx, bookingId: booking.id, unitId: newUnitId,
            landlordId: booking.landlord_id, actorUserId: req.user!.userId,
            eventType: 'dates_changed',
            summary: `${who}'s check-in moved from ${longDay(booking.check_in_day)} to ${longDay(newCheckIn)}. `
              + 'They had already checked out early, so the check-out, the price and any lease stay as they were',
            detail: {
              from: { check_in: booking.check_in_day, check_out: booking.check_out_day },
              to:   { check_in: newCheckIn, check_out: newCheckOut },
              delta: '', early_check_out: true, booked_check_out: early!.booked, left_on: early!.leftOn,
              check_in_corrected: true,
            },
          })
        }
        // ── Final fix (fix pass 2, review): A GUEST'S ARRIVAL IS HISTORY THE
        // SAVE ITSELF WRITES
        //
        // Decisions #53: the never-moved-in close (Cancel reservation, "They
        // never moved in") is refused for a stay that was EVER checked in, and
        // it reads that from the stay's history. That history used to be
        // written after the commit, best-effort and not awaited — a failed
        // insert, or a cancel landing first, left a stay checked in and set
        // back to Confirmed with no trace of the check-in, and the close then
        // zeroed rent for nights a guest was on the site. So a status change
        // into or out of Checked in / Checked out is written here, with the
        // save: both land, or neither does. (A check-out that moved the day,
        // or its undo, wrote its own above.)
        const ARRIVED = ['checked_in', 'checked_out']
        if (updated.status !== booking.status && !checkOutMoved && !checkOutRestored
            && (ARRIVED.includes(booking.status) || ARRIVED.includes(updated.status))) {
          const who = booking.guest_name || 'Guest'
          await recordBookingEvent({
            client: tx, bookingId: booking.id, unitId: updated.unit_id,
            landlordId: booking.landlord_id, actorUserId: req.user!.userId,
            eventType: 'status_changed',
            summary: `${who} status: ${bookingStatusLabel(booking.status)} → ${bookingStatusLabel(updated.status)}`,
            detail: { from_status: booking.status, to_status: updated.status },
          })
          statusRecordedInSave = true
        }
        // 10/6 (Nic): the returning guest (who and when, counted against the
        // property's allowance under its lock) and the work trade, with the save.
        editReturningAfterCommit = null
        editFeeDropped = null
        if (attestReturning) {
          const r = await attestReturningGuest(tx, {
            bookingId: booking.id, propertyId: targetUnit?.property_id ?? bookingUnit!.property_id, byUserId: req.user!.userId,
            chainBookingIds: (stayAsk ?? returningNow)?.chain.bookingIds ?? [],
          })
          editReturningAfterCommit = r.afterCommit
          editFeeDropped = r.feeDropped
        }
        editWtInvite = null
        if (workTrade !== undefined) {
          const wt = await syncStayWorkTrade(booking.id, { terms: workTrade, byUserId: req.user!.userId, client: tx })
          if (wt.action === 'skipped') throw new AppError(400, stayWorkTradeSkippedWords(wt.reason))
          if (wt.action === 'created') editWtInvite = wt.invite
        }
        await tx.query('COMMIT')
      } catch (e) {
        await tx.query('ROLLBACK').catch(() => {})
        failure = e
      } finally {
        tx.release()
      }
      if (!isDeadlock(failure) || attempt >= BOOKING_SAVE_TRIES) break
      logger.warn({ bookingId: booking.id, attempt },
        '[booking] a schedule change deadlocked with another save on the same sites; saving again')
    }
    if (failure && changedBySomeoneElse) {
      // Fix round 6: a reservation the extension moved for this save goes back.
      if (relocated.length) {
        const moved = relocated
        relocated = []
        await putRelocatedBack(moved)
      }
      return answerChanged()
    }
    if (failure && screeningBlockedInSave) {
      if (relocated.length) {
        const moved = relocated
        relocated = []
        await putRelocatedBack(moved)
      }
      return void res.status(409).json(screeningPendingBody(screeningBlockedInSave))
    }
    // Still deadlocked after every try: nothing was written. (The catch below
    // puts back a reservation an extension moved for this save.)
    if (isDeadlock(failure)) throw new AppError(409, SAVED_AT_THE_SAME_MOMENT)
    if (failure) throw failure

    // The save is final, so a reservation the extension moved for it stays
    // moved — unless the extending guest went to another site after all (the
    // W-20 fallback, after the next reservations could not all be moved): the
    // ones moved before that gave up made room for nobody, and go back.
    const movedForNobody = extendedGuestMovedTo ? relocated : []
    relocated = []
    if (movedForNobody.length) await putRelocatedBack(movedForNobody)

    // 10/4 (decisions #38 Q8, Q5): an early check-out saved here ends a long
    // stay's lease on the day they left, and any money question (the guest still
    // owes, or paid more than the nights stayed are worth) WAITS on the stay as
    // a pending decision with an owner to-do — nothing about the money is
    // decided on this route. A check-out put back brings the lease back with
    // the booked day.
    let moneyDecisionNeeded: string | null = null
    if (checkOutMoved && updated.status === 'checked_out') {
      moneyDecisionNeeded = await afterPatchEarlyCheckOut(booking.id, req.user!.userId).catch((err) => {
        logger.error({ err, bookingId: booking.id }, '[booking] early check-out money question could not be recorded')
        return null
      })
    } else if (restoresLease) {
      await syncLeaseWithBookingDates(booking.id)
        .catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] lease could not follow the put-back check-out'))
    }

    // 10/5 (Nic, R3): an edit never drafts a lease on its own any more (the
    // S526 re-check on every save — a check-in click included — is gone). What
    // the new dates need was asked above; carried out here: the counter's
    // lease-or-stay answer, check-in waiting on screening at 22+ nights, and
    // the stay's utility agreement kept in step with its dates, its site and
    // its status (ended at check-out, cancellation or no-show — R11).
    if (editReturningAfterCommit) await editReturningAfterCommit()
    const stayDone = await afterStaySaved(booking.id, stayAsk, stayTermsGiven, req.user!.userId)
    // 10/6 (review): the guest's way into their account, for the work trade.
    await sendStayWorkTradeInvite(booking.id, editWtInvite)

    // 10/5 (Nic, A2/M3): "A schedule edit/drag that makes an existing stay need
    // the fee creates and emails a pay link for the fee automatically (check-in
    // waits anyway)." Only when the longer stay needs the fee, the stay still
    // holds its site, and no open ticket or unpaid link of this continuous stay
    // already carries it — one fee, never two. A fee-only link
    // (routes/posPayLinks createScreeningFeeLink) records the prepaid screening
    // when it is paid. No email to send it to: the screen is told it was not
    // collected.
    let screeningFeeLink: { id: string; url: string } | null = null
    let screeningFeeUncollected = false
    const feeNow = stayAsk && stayAsk.screening === 'fee_due' ? stayAsk.screeningFee?.amount ?? 0 : 0
    if (stayAsk && feeNow > 0 && SITE_HOLDING_STATUSES.includes(updated.status)
        && !(await screeningFeeAlreadyCarried(stayAsk.chain.bookingIds.length ? stayAsk.chain.bookingIds : [booking.id])
          .catch(() => false))) {
      const to = (typeof updated.guest_email === 'string' && updated.guest_email.trim()) || stayAsk.chain.email
      if (!to) {
        screeningFeeUncollected = true
      } else {
        try {
          const { createScreeningFeeLink } = await import('./posPayLinks')
          screeningFeeLink = await createScreeningFeeLink({
            bookingId: booking.id, landlordId: booking.landlord_id,
            propertyId: targetUnit?.property_id ?? updated.property_id,
            amount: feeNow, guestName: updated.guest_name ?? null, guestEmail: to,
          })
          if (!screeningFeeLink) screeningFeeUncollected = true
        } catch (err) {
          screeningFeeUncollected = true
          logger.error({ err, bookingId: booking.id }, '[booking] background-check fee link failed')
        }
      }
    }

    // 10/5 (Nic): a stay canceled or marked a no-show keeps the background
    // check its payment carried — "a paid screening fee is not refunded on
    // denial or no-show", and the paid check keeps waiting for the guest. Only
    // a payment taken back voids it (services/heldPayouts, chargebacks).

    // S548 (Nic): the Master Schedule is the source of truth for what a
    // long-stay guest owes. A date change flows into the lease: pending
    // drafts follow the dates; an active lease's end moves, no-longer-owed
    // pending rent is dropped, and rent paid past the new end is banked as
    // a prepaid credit that nets against the final bill. Best-effort.
    //
    // S655 (fix round 2): not after an early check-out the edit left in place
    // (keepsEarlyCheckOut) — the sync reads the stored check-out as the lease's
    // end, and that day is the day the guest left, not a deliberate shortening.
    //
    // 10/5 (Nic, R4): not for a lease chosen for a stay. That lease is
    // month-to-month with no end date — it holds the site for as long as the
    // guest stays — so the stay's check-out never becomes its end. While it is
    // still a draft, its start follows the arrival day.
    const openLease = datesOrUnitChanged && !keepsEarlyCheckOut ? await stayLeaseOf(booking.id) : null
    if (openLease?.openEnded) {
      if (openLease.status === 'pending' && checkInChanged) {
        await query(`UPDATE leases SET start_date = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
          [openLease.id, newCheckIn])
          .catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] stay lease start did not follow the arrival'))
      }
    } else if (datesOrUnitChanged && !keepsEarlyCheckOut) {
      syncLeaseWithBookingDates(booking.id)
        .catch((err) => logger.error({ err, bookingId: booking.id }, '[booking] lease-billing sync failed'))
    }

    // S517: append the change-history events (moved / dates_changed / cancelled
    // / status_changed) by diffing old → new. Best-effort. (A check-out that
    // moved the day, or its undo, wrote its own events with the write above;
    // so did an arrival-day correction after an early check-out, whose dates
    // are therefore not diffed again here — a second, unmarked 'dates_changed'
    // event would drop the early check-out's mark.)
    if (!checkOutMoved && !checkOutRestored) {
      const datesBefore = keepsEarlyCheckOut && checkInChanged
        ? { ...booking, check_in: updated.check_in, check_out: updated.check_out }
        : booking
      // A status change the save already wrote (above) is not diffed again.
      const before = statusRecordedInSave ? { ...datesBefore, status: updated.status } : datesBefore
      recordBookingChange(before, updated, req.user!.userId).catch(err =>
        logger.error({ err, bookingId: booking.id }, '[booking] change event record failed'))
    }

    // S517: a cancellation frees the dates — promote the next waitlister
    // (best-effort; mints a 1-hour claim link + emails them).
    if (status === 'cancelled' && booking.status !== 'cancelled') {
      promoteNextWaitlister(booking.unit_id).catch(err =>
        logger.error({ err, unit_id: booking.unit_id }, '[booking] waitlist promote on cancel failed'))
    }
    if (stopAfterCancel.length > 0) {
      // ── S639 (Nic): A CANCELLED RESERVATION TAKES ITS LEASE WITH IT ──────
      //
      // "When I click to delete it from the calendar, I clicked cancel. But it
      // needs to delete itself everywhere when that happens. So in the leases
      // page, it's still showing me pending for a thing that's not actually
      // there."
      //
      // Step 9 final fix (fix pass 1): the lease drafted with the stay ended
      // inside the save above, through the never-moved-in close (its unpaid
      // move-in bill zeroed). Here only the bank pulls that close stopped are
      // canceled with the processor, after the commit (a No-show's close too —
      // fix pass 3).
      const { cancelSupersededIntents } = await import('../services/creditUse')
      await cancelSupersededIntents(stopAfterCancel)
    }

    // S655 (Step 6 fix round 3): an early check-out moves the date, never the
    // lease (§6.19). Whoever checked the guest out is told so in plain words,
    // with the one way to end the lease on the day they left — the landlord's
    // deliberate date edit (S548). Today the check-out is made through the
    // landlord agent, and the agent's dispatch (services/agents/portalDispatch)
    // hands it ONLY the response's `data` — so the sentence travels inside
    // `data` (below) as well as beside it. Beside it alone, the agent never
    // saw it, and nobody was told the lease (and its autopay) still runs.
    //
    // Fix round 5: the steps named are the ones that work NOW
    // (endLeaseOnDayLeftSteps): if the nights the check-out freed are held
    // again, the steps start with freeing them. And a later save that sends
    // the early check-out's day back as the check-out (the Edit form, or the
    // agent typing the day they left) is told the same thing: that day is
    // already the stored check-out, so the save leaves the lease running. It
    // used to answer with a bare success, and staff who had been told the
    // lease could be ended believed they had ended it.
    let leaseNote: string | null = null
    const dayLeftSavedAgain = keepsEarlyCheckOut && checkOutDay === booking.check_out_day
    if (checkOutMoved || dayLeftSavedAgain) {
      const lease = await queryOne<{ end_day: string | null }>(
        `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_day
           FROM leases
          WHERE source_booking_id = $1 AND status IN ('active', 'pending')
            AND (end_date IS NULL OR end_date > $2::date)
          ORDER BY created_at DESC LIMIT 1`, [booking.id, newCheckOut])
      if (lease) {
        const whose = guest === 'This guest' ? 'The' : `${guest}'s`
        const steps = await endLeaseOnDayLeftSteps({
          bookingId: booking.id, unitId: updated.unit_id, leftDay: newCheckOut,
          booked: checkOutMoved ? (bookedForEvent ?? booking.check_out_day) : early!.booked,
        })
        leaseNote = `${whose} lease still runs${lease.end_day ? ` to ${longDay(lease.end_day)}` : ''}, `
          + 'and its rent stays as it is — '
          + (checkOutMoved
            ? 'a check-out does not end a lease. '
            : `the check-out already reads ${longDay(newCheckOut)} from the early check-out, `
              + 'and saving that day again does not end a lease. ')
          + steps
      }
    }

    // Fix round 4: what the save did to the dates, and what that means for the
    // lease, ride inside `data` too — the landlord agent reads only `data`
    // (services/agents/portalDispatch), and today the agent is the one way a
    // stay is checked out. Only the ones that are set, so a plain edit's row
    // reads exactly as before.
    const notices = {
      ...(extendedGuestMovedTo ? { extendedGuestMovedTo } : {}),
      ...(checkOutMoved ? { checkOutMoved } : {}),
      ...(checkOutRestored ? { checkOutRestored } : {}),
      ...(leaseNote ? { leaseNote } : {}),
      ...(moneyDecisionNeeded ? { moneyDecisionNeeded } : {}),
      ...(leaseClosedOnCancel ? { leaseClosed: leaseClosedWords(guest, leaseClosedOnCancel) } : {}),
      // 10/6 (review): a returning guest's check fee that had already gone out came off.
      ...(editFeeDropped && returningFeeWords(editFeeDropped) ? { returningFeeNote: returningFeeWords(editFeeDropped) } : {}),
      // 10/5: what the new dates need — the server's figures, for the screen to say.
      ...(stayAsk ? { stay: {
        nights: stayAsk.nights,
        terms: stayDone.terms ?? (stayAsk.leaseChoice === 'lease' || stayAsk.leaseChoice === 'stay' ? stayAsk.leaseChoice : null),
        leaseId: stayDone.leaseId,
        screening: stayAsk.screening,
        screeningFee: stayAsk.screening === 'fee_due' ? stayAsk.screeningFee?.amount ?? null : null,
        // M3: the fee-only pay link emailed for the check, or that nothing collected it.
        screeningFeeLink,
        screeningFeeUncollected,
        emailedTo: screeningFeeLink ? ((typeof updated.guest_email === 'string' && updated.guest_email.trim()) || stayAsk.chain.email) : null,
      } } : {}),
    }
    res.json({
      success: true,
      data: { ...updated, ...notices },
      // W-20: non-null when the extension moved the EXTENDING guest to a
      // new site — the UI tells staff so they can coordinate the physical
      // move with the guest.
      extendedGuestMovedTo,
      // S655: non-null when an early check-out (or a correction of the day a
      // checked-out guest left) moved the check-out day — the check-out it
      // replaced and the new one — so staff can be told.
      checkOutMoved,
      // S655 (Step 6 fix round): non-null when moving a checked-out stay back
      // (checked in, confirmed) put the booked check-out day back — or when a
      // correction said the guest stayed to the day they had booked.
      checkOutRestored,
      // S655 (fix round 3): non-null when the stay has a lease that still runs
      // past the new check-out — what that means, and how to end it instead.
      leaseNote,
      // 10/4 (decisions #38): non-null when an early check-out left a money
      // question waiting on the stay — what it is, and where to decide it.
      moneyDecisionNeeded,
    })
  } catch (e) {
    // S655 (Step 6 fix round 6): refused after an extension had already moved
    // the next reservation off the site — put it back before answering.
    if (relocated.length) {
      const moved = relocated
      relocated = []
      await putRelocatedBack(moved)
    }
    next(e)
  }
})

// ── 10/5 (Nic, R6): ADD A MONTH ──────────────────────────────────────────────
//
// "Add a month" EXTENDS the guest's current stay — the same reservation, never
// a second one stacked behind it: its check-out, and the length it is sold
// for, move forward one calendar month, and the added month is priced at the
// monthly rate ON ITS OWN (no reprice of the whole stay, no proration — R5).
// The register's own quote and write do it (services/registerStay
// stayExtensionQuote / extendStayByMonth), so the schedule, the counter and a
// pay link add the same month at the same price under the same rules: a stay
// under way and paid up so far, no lease, nobody else on any night of the
// month (an unpaid month never moves a guest who paid — the W-20 extension
// rule is for the schedule's own date edits).
//
// The schedule takes no money: the month goes to the register on the stay's
// ticket, with the background check's fee when the longer stay now needs one
// and nothing is on file (R8). The longer stay asks what stayNeeds() asks:
// 30+ continuous nights with no answer yet → lease or no lease first (R2), and
// a lease chosen there drafts the lease INSTEAD of adding the month (the lease
// bills the months from then on).
interface AddMonthPlan {
  booking: any
  ext: StayExtension
  needs: StayNeeds
}

async function planAddMonth(req: any, given: StayTerms | null, returning = false): Promise<AddMonthPlan> {
  const booking = await queryOne<any>(
    `SELECT b.id, b.unit_id, b.landlord_id, b.guest_name, b.tenant_id, u.property_id
       FROM unit_bookings b JOIN units u ON u.id = b.unit_id
      WHERE b.id = $1 AND b.unit_id = $2`, [req.params.bookingId, req.params.id])
  if (!booking) throw new AppError(404, 'Booking not found')
  if (!canManageLandlordResource(req.user, booking.landlord_id)) throw new AppError(403, 'Forbidden')
  await assertPropertyInScope(req.user, booking.property_id)
  // The register's own rules for a month added to a stay (services/registerStay
  // stayExtensionQuote): a stay that is under way and paid up, with no lease,
  // on a site with a monthly rate — the same quote the counter and a pay link give.
  const ext = await stayExtensionQuote(db, {
    landlordId: booking.landlord_id, propertyId: booking.property_id, bookingId: booking.id,
  })
  const needs = await stayNeeds({
    landlordId: booking.landlord_id, propertyId: booking.property_id, bookingId: booking.id,
    checkIn: ext.checkIn, checkOut: ext.checkOut, stayTerms: given,
    // 10/6 (Nic): the returning-guest choice beside the check's fee.
    returning, offerReturning: canAttestReturningGuest(req.user),
  })
  return { booking, ext, needs }
}

/** What the confirm window shows — every figure the server's. */
const addMonthQuote = ({ ext, needs }: AddMonthPlan) => ({
  fromCheckOut: ext.fromCheckOut,
  newCheckOut: ext.checkOut,
  addedNights: ext.addedNights,
  monthPrice: ext.price,
  nights: needs.nights,
  leaseChoice: needs.leaseChoice,
  question: needs.leaseChoice === 'needed' ? stayTermsQuestion(needs.nights) : null,
  screening: needs.screening,
  screeningFee: needs.screening === 'fee_due' ? needs.screeningFee?.amount ?? null : null,
  // 10/6: "Returning guest — they've stayed with us before", when the desk may use it.
  returning: needs.returningOffer,
  heldThrough: needs.leaseChoice === 'stay' || needs.leaseChoice === 'needed'
    ? stayHeldWords(needs.chain.checkOut > ext.checkOut ? needs.chain.checkOut : ext.checkOut)
    : null,
})

// GET /api/units/:id/bookings/:bookingId/add-month — the quote (nothing written).
unitsRouter.get('/:id/bookings/:bookingId/add-month', requirePerm('schedule.edit_reservation'), async (req, res, next) => {
  try {
    const plan = await planAddMonth(req, null)
    res.json({ success: true, data: addMonthQuote(plan) })
  } catch (e) { next(e) }
})

// POST /api/units/:id/bookings/:bookingId/add-month — { stayTerms? }
unitsRouter.post('/:id/bookings/:bookingId/add-month', requirePerm('schedule.edit_reservation'), async (req, res, next) => {
  try {
    const given = stayTermsIn(req.body?.stayTerms)
    const plan = await planAddMonth(req, given, returningGuestIn(req))
    const { booking, ext, needs } = plan
    if (needs.leaseChoice === 'needed') return void res.status(409).json(stayTermsNeededBody(needs))
    if (needs.nights >= STAY_SCREENING_NIGHTS && !needs.chain.email && !needs.chain.tenantId) {
      throw new AppError(400, LONG_STAY_NEEDS_EMAIL)
    }

    // R2/R4: the counter chose a lease — it is drafted for the landlord and
    // holds the site from here, so no month is added on top of it.
    if (given === 'lease' && needs.leaseChoice === 'lease') {
      const done = await afterStaySaved(booking.id, needs, given, req.user!.userId)
      return void res.json({ success: true, data: { extended: false, leaseId: done.leaseId } })
    }
    // A stay of this continuous stay already answered lease (R2): no month is
    // sold on top of the lease — the same refusal the register and a pay link give.
    if (needs.leaseChoice === 'lease') {
      throw new AppError(409, 'They chose a lease, so no month is added here — the lease holds their site and bills the months from now on. '
        + 'Their lease is on the Leases page. Nothing was changed.')
    }

    // The register button the month is rung up on. Checked before anything is
    // written: a park that has not set one up cannot take the month here.
    const item = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM pos_items
        WHERE property_id = $1 AND landlord_id = $2 AND is_active = TRUE AND stay_unit = 'month'
        ORDER BY created_at LIMIT 1`, [ext.propertyId, booking.landlord_id])
    // 10/6 (Nic): a work trade covering the stay's rent — the month costs
    // nothing, so it goes on no ticket (unless the check's fee rides on one).
    const monthFree = !(ext.price > 0)
    if (!item && !monthFree) {
      throw new AppError(409,
        'This property has no register button for a month\'s stay, so the month can\'t be rung up. '
        + 'Add one under Register items, then try again.')
    }

    // One fee per continuous stay (M3): not when an open ticket or unpaid link
    // of the stay already carries it, or it is already paid.
    const screeningFee = needs.screening === 'fee_due' && needs.screeningFee
      && !(await screeningFeeAlreadyCarried(needs.chain.bookingIds.length ? needs.chain.bookingIds : [booking.id]).catch(() => false))
      ? needs.screeningFee.amount : null
    let ticketId: string | null = null
    // 10/6 (review): closes the card pages of links whose check fee came off (returning guest).
    let returningAfterCommit: (() => Promise<void>) | null = null
    if (monthFree && screeningFee && !item) {
      throw new AppError(409,
        'This property has no register button for a month\'s stay, so the background check\'s fee can\'t be rung up with the month. '
        + 'Add one under Register items, then try again.')
    }
    const tx = await getClient()
    try {
      await tx.query('BEGIN')
      // The register's own write (services/registerStay extendStayByMonth):
      // the same booking lengthened, the month added to its price, what was
      // paid before kept as paid — under the schedule's lock order, refused if
      // anybody else holds a night of the month.
      const done = await extendStayByMonth(tx, {
        landlordId: booking.landlord_id, propertyId: ext.propertyId, bookingId: booking.id,
      })
      await recordBookingEvent({
        client: tx, bookingId: booking.id, unitId: done.unitId, landlordId: booking.landlord_id,
        actorUserId: req.user!.userId, eventType: 'dates_changed',
        summary: `${booking.guest_name || 'Guest'}: a month added — check-out moved from `
          + `${longDay(done.fromCheckOut)} to ${longDay(done.checkOut)} (${done.addedNights} days added)`,
        detail: {
          from: { check_in: done.checkIn, check_out: done.fromCheckOut },
          to: { check_in: done.checkIn, check_out: done.checkOut },
          delta: `${done.addedNights} days added`, added_month: true, month_price: done.price,
        },
      })
      // To the till: the stay's open ticket when it has one (the register
      // charges what the reservation owes, the month included); otherwise a
      // new one for the month. The check's fee rides on it, once.
      // 10/6 (review): the returning guest first — a check fee already sent
      // for this stay comes off its ticket or link (attestReturningGuest), and
      // the ticket below is read as it stands after that.
      if (needs.returningAttestNow) {
        const r = await attestReturningGuest(tx, { bookingId: booking.id, propertyId: ext.propertyId, byUserId: req.user!.userId, chainBookingIds: needs.chain.bookingIds })
        returningAfterCommit = r.afterCommit
      }
      const open = (await tx.query<{ id: string; items: any }>(
        `SELECT id, items FROM pos_open_tickets
          WHERE booking_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [booking.id])).rows[0]
      if (monthFree && !screeningFee) {
        // Nothing to ring up.
      } else if (open) {
        ticketId = open.id
        const items: any[] = Array.isArray(open.items) ? open.items : []
        if (screeningFee && !items.some((i: any) => i?.[SCREENING_FEE_LINE_FLAG])) {
          await tx.query(`UPDATE pos_open_tickets SET items = $2::jsonb, updated_at = NOW() WHERE id = $1`,
            [open.id, JSON.stringify([...items, screeningFeeTicketLine(screeningFee)])])
        }
      } else {
        const lines: Record<string, unknown>[] = [{ id: item!.id, name: item!.name, qty: 1, price: 0, tax: 0 }]
        if (screeningFee) lines.push(screeningFeeTicketLine(screeningFee))
        ticketId = (await tx.query<{ id: string }>(
          `INSERT INTO pos_open_tickets
             (landlord_id, property_id, created_by, tenant_id, pos_customer_id, items, note, booking_id)
           VALUES ($1,$2,$3,$4,NULL,$5::jsonb,$6,$7) RETURNING id`,
          [booking.landlord_id, ext.propertyId, req.user!.userId, booking.tenant_id ?? null,
           JSON.stringify(lines),
           `${booking.guest_name || 'Guest'} · site ${done.unitNumber} · a month added · ${done.fromCheckOut} → ${done.checkOut}`,
           booking.id])).rows[0].id
      }
      await tx.query('COMMIT')
    } catch (e) {
      await tx.query('ROLLBACK').catch(() => {})
      if (isDeadlock(e) || isLockBusy(e)) throw new AppError(409, SAVED_AT_THE_SAME_MOMENT)
      throw e
    } finally { tx.release() }
    if (returningAfterCommit) await returningAfterCommit()

    // What the longer stay needs: 22+ → check-in waits on screening; the
    // counter's "stay" answer (or one the stay already had) → its utilities
    // follow the new check-out and the landlord is told; otherwise the stay's
    // utility agreement, if any, moves with it.
    const done = await afterStaySaved(booking.id, needs, given, req.user!.userId)
    const updated = await queryOne<any>('SELECT * FROM unit_bookings WHERE id = $1', [booking.id])
    res.json({
      success: true,
      data: {
        extended: true,
        booking: updated,
        addedMonth: {
          ...addMonthQuote(plan),
          terms: done.terms ?? (needs.leaseChoice === 'stay' ? 'stay' : null),
          registerTicketId: ticketId,
        },
      },
    })
  } catch (e) { next(e) }
})

// ── 10/5 (Nic, R2/R4): OFFER A LEASE ─────────────────────────────────────────
//
// A stay with no lease can be given one later — the same draft a lease chosen
// at booking makes (draftLeaseFromStay): month-to-month, no end date, billed
// per the property's rent-due setting, with what was paid on the stay coming
// off its first bill. The landlord is told; the draft waits on the Leases
// page for the tenant to be attached and the lease sent for signature.
unitsRouter.post('/:id/bookings/:bookingId/offer-lease', requirePerm('schedule.edit_reservation'), async (req, res, next) => {
  try {
    const booking = await queryOne<any>(
      `SELECT b.id, b.status, b.landlord_id, b.guest_name, u.property_id
         FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE b.id = $1 AND b.unit_id = $2`, [req.params.bookingId, req.params.id])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, booking.property_id)
    if (!SITE_HOLDING_STATUSES.includes(booking.status)) {
      throw new AppError(409, `This reservation is ${bookingStatusLabel(booking.status)}, so there is no stay to offer a lease for.`)
    }
    const existing = await stayLeaseOf(booking.id)
    if (existing) return void res.json({ success: true, data: { leaseId: existing.id, drafted: false } })
    const r = await draftLeaseFromStay(booking.id, { byUserId: req.user!.userId })
    if (!r.leaseId) throw new AppError(409, 'The lease could not be drafted for this stay. Open the stay again and retry.')
    res.status(201).json({ success: true, data: { leaseId: r.leaseId, drafted: r.drafted } })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/bookings/:bookingId/acknowledge — S179 / B3.
// Stamps acknowledgment_signed_at = NOW() once landlord/staff confirms the
// guest signed the property rules. The toggle on properties
// (requires_booking_acknowledgment) governs whether the booking should be
// gated on this; today the column is informational and surface UI badging
// is a follow-on session.
unitsRouter.patch('/:id/bookings/:bookingId/acknowledge', requirePerm('bookings.acknowledge'), async (req, res, next) => {
  try {
    const booking = await queryOne<any>('SELECT * FROM unit_bookings WHERE id=$1', [req.params.bookingId])
    if (!booking) throw new AppError(404, 'Booking not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (booking.acknowledgment_signed_at) {
      // Idempotent: re-acknowledging is a no-op rather than an error so a
      // double-click on the staff UI doesn't bounce.
      return res.json({ success: true, data: booking })
    }
    const updated = await queryOne<any>(`
      UPDATE unit_bookings
         SET acknowledgment_signed_at = NOW(),
             updated_at               = NOW()
       WHERE id = $1
       RETURNING *`,
      [booking.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/units/schedule — master schedule across all units for a landlord.
// Perm keys: the catalog schedule.tab.* / bookings.view keys (what the
// permissions page actually grants — the Front Desk preset holds these) plus
// the legacy pre-catalog keys so existing scope rows keep working.
// Property-scoped: a property-locked worker only sees units/bookings/leases
// at their assigned properties.
// 10/4: "Check guests out" opens the schedule too — the Check out button lives
// on it (decisions #38: that permission alone is enough to check a guest out).
unitsRouter.get('/schedule/master', requirePerm(
  'schedule.tab.timeline', 'schedule.tab.list', 'schedule.tab.units', 'schedule.tab.history',
  'bookings.view',
  'guests.check_in', 'guests.check_out', 'units.view_status', 'units.edit',
), async (req, res, next) => {
  try {
    const { from, to, unitType } = req.query
    // S639 (Nic): "Master schedule needs to be scoped to a property, not having
    // all the different properties on one schedule." Unit numbers repeat across
    // parks, so a merged timeline shows several rows labeled the same spot —
    // unreadable, and a way to book the wrong one. Filtered here rather than in
    // the browser so a fifteen-park account is not shipped every unit it owns.
    const oneProperty = typeof req.query.propertyId === 'string' && req.query.propertyId
      ? z.string().uuid().parse(req.query.propertyId) : null

    // S400 fix: same class as GET / above. For team-role callers (PM /
    // maintenance_worker / onsite_manager) req.user.profileId is the user_id,
    // not the landlord_id, so the WHERE landlord_id=$1 filter returned an
    // empty schedule. Resolve to landlordId for team members.
    // S633: the account's companies, not one.
    const callerLandlordIds = landlordScopeIds(req.user!)
    const scopedIds = await getScopedPropertyIds(req.user)

    const units = await query<any>(`
      SELECT u.id, u.unit_number, u.unit_type, u.status, u.rent_amount,
        u.nightly_rate, u.weekly_rate, u.monthly_rate, u.is_bookable, u.lease_types_allowed,
        u.rv_site_layout, u.rv_amp_service,
        u.check_in_time, u.check_out_time, u.amenities, u.unit_description,
        p.id as property_id, p.name as property_name,
        p.nightly_rate as property_nightly_rate, p.weekly_rate as property_weekly_rate,
        p.monthly_rate as property_monthly_rate, p.short_term_tax_rate as property_tax_rate,
        p.timezone as property_timezone,
        vuo.primary_first_name as tenant_first,
        vuo.primary_last_name as tenant_last
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE u.landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR u.property_id = $3)
        ${unitType ? "AND u.unit_type=$4" : ""}
      -- S650 (Nic): RV spots at the top — they turn over the most — and mobile
      -- homes at the bottom; everything else between. Numbers sort as numbers
      -- (RV 2 before RV 10), not as text.
      ORDER BY CASE u.unit_type WHEN 'rv_spot' THEN 0 WHEN 'mobile_home' THEN 2 ELSE 1 END,
               u.unit_type, p.name,
               substring(u.unit_number from '^\\D*'),
               NULLIF(substring(u.unit_number from '\\d+'), '')::numeric NULLS LAST,
               u.unit_number`,
      unitType ? [callerLandlordIds, scopedIds, oneProperty, unitType]
               : [callerLandlordIds, scopedIds, oneProperty])

    // S654: the default window opens on the park's today, not UTC's (after 5 pm
    // in Phoenix UTC is already tomorrow, and tonight would fall off the left
    // edge). The schedule is one park, so its zone is the units' zone; an
    // unscoped view across zones falls back to GAM's home zone.
    const zones = new Set(units.map((u: any) => u.property_timezone))
    const today = todayIn(zones.size === 1 ? [...zones][0] : null)
    const fromDate = from || today
    const toDate = to || addDaysTo(today, 30)

    // Get all bookings in range. S200: include the property's
    // requires_booking_acknowledgment flag so the schedule tile can
    // render an ack-needed badge (companion to S191's BookingsPage
    // surface).
    // 10/4 (decisions #38 Q5): money_decision_pending — an early check-out's
    // money question still waiting on the stay (the schedule shows "Decide the
    // money"); refund_needs_retry — a decided one whose card or bank refund did
    // not go out (the schedule shows Try again). A long stay whose lease did
    // not end on the day they left is ended now (#38 Q8, healLeaseEnds).
    await healLeaseEnds(callerLandlordIds, req.user!.userId)
      .catch((err) => logger.error({ err }, '[schedule] lease end retry failed'))
    const bookings = await query<any>(`
      SELECT b.*, u.unit_number, u.unit_type, p.name as property_name,
             p.requires_booking_acknowledgment,
             EXISTS (SELECT 1 FROM stay_checkout_decisions d
                      WHERE d.booking_id = b.id AND d.status = 'pending') AS money_decision_pending,
             ${refundNeedsRetrySql('b')} AS refund_needs_retry,
             -- 10/5: the lease drafted from the stay (a lease chosen, or offered
             -- later), so the window shows it instead of "Offer a lease".
             (SELECT l.id FROM leases l WHERE l.source_booking_id = b.id AND l.status IN ('pending', 'active')
               ORDER BY l.created_at DESC LIMIT 1) AS stay_lease_id,
             -- 10/6 (Nic): a work trade made for the stay — what it covers and
             -- whether the person is trusted — for the reservation's details.
             (SELECT jsonb_build_object('id', w.id, 'covered_charges', w.covered_charges, 'trusted', w.trusted,
                                        'tracks_hours', w.tracks_hours, 'monthly_hours_target', w.monthly_hours_target,
                                        'duties', w.duties, 'status', w.status)
                FROM work_trade_agreements w WHERE w.booking_id = b.id AND w.status <> 'ended' LIMIT 1) AS work_trade
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE b.landlord_id = ANY($1::uuid[]) AND b.status NOT IN ('cancelled')
        AND b.check_out >= $2 AND b.check_in <= $3
        AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
        AND ($5::uuid IS NULL OR u.property_id = $5)
      ORDER BY b.check_in`, [callerLandlordIds, fromDate, toDate, scopedIds, oneProperty])

    // 10/5 (Nic, R9): a stay not yet checked in whose check-in waits on its
    // background check says so on the schedule — what it is waiting on, in the
    // same words the Check in button would be refused with (checkInBlock).
    for (const b of bookings) {
      b.screening_block = null
      if (!['tentative', 'confirmed'].includes(b.status)) continue
      if (!b.screening_required && dayDiff(b.check_in, b.check_out) < STAY_SCREENING_NIGHTS) continue
      b.screening_block = await checkInBlock(b.id).catch((err) => {
        logger.error({ err, bookingId: b.id }, '[schedule] screening state could not be read')
        return null
      })
    }

    // Get active leases in range
    //
    // S652 (Nic, DIRECTIVE): "make sure the master schedule splits that stay…
    // when we move somebody's sites, it only moves the stay going forward at
    // that day. We have an exact log of the day they change spots."
    //
    // This drew one bar per lease on the lease's CURRENT space, from the day
    // the lease began. Move Dakota Lane from RV 18 to RV 44 and the schedule
    // would have said he had been on 44 all along — over the top of whoever
    // really was — and that 18 had been empty for a year. The move history
    // (lease_unit_history) is the log of who was where: one bar per stretch,
    // on the space it happened in, ending the day they left it.
    const leases = await query<any>(`
      SELECT l.*, u.unit_number, u.unit_type, p.name as property_name,
        vlat.first_name, vlat.last_name, vlat.email, vlat.phone,
        h.unit_id AS unit_id,
        GREATEST(l.start_date, h.effective_from) AS start_date,
        -- the stretch on a space they LEFT ends the day before the move, so
        -- the move day shows once, on the space they moved into
        COALESCE((h.effective_to - 1), l.end_date) AS end_date,
        h.id AS segment_id,
        (h.effective_to IS NOT NULL) AS moved_out,
        (SELECT u2.unit_number FROM units u2 WHERE u2.id = l.unit_id) AS current_unit_number
      FROM leases l
      JOIN lease_unit_history h ON h.lease_id = l.id
      JOIN units u ON u.id = h.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN LATERAL (
        -- S527 W-55: email/phone too — the schedule detail popup shows the
        -- same contact fields for leases as for reservations.
        SELECT first_name, last_name, email, phone
        FROM v_lease_active_tenants
        WHERE lease_id = l.id AND role = 'primary'
        LIMIT 1
      ) vlat ON TRUE
      WHERE u.landlord_id = ANY($1::uuid[]) AND l.status='active'
        -- S527 fix: NULL end_date = open-ended (month-to-month) lease. The
        -- old "end_date >= $2" dropped those rows, so occupied units looked
        -- EMPTY on the schedule (while the booking guard rightly blocked
        -- them — "conflict on an empty spot" reports).
        AND (COALESCE(h.effective_to, l.end_date) IS NULL OR COALESCE(h.effective_to, l.end_date) >= $2)
        AND GREATEST(l.start_date, h.effective_from) <= $3
        AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
        AND ($5::uuid IS NULL OR u.property_id = $5)
      ORDER BY GREATEST(l.start_date, h.effective_from)`, [callerLandlordIds, fromDate, toDate, scopedIds, oneProperty])

    // S649: out-of-order windows, drawn on the schedule as blocked time.
    const outOfOrder = await query<any>(`
      SELECT o.id, o.unit_id, to_char(o.starts_on, 'YYYY-MM-DD') AS starts_on,
             to_char(o.ends_on, 'YYYY-MM-DD') AS ends_on, o.reason
        FROM unit_out_of_order o
        JOIN units u ON u.id = o.unit_id
       WHERE u.landlord_id = ANY($1::uuid[]) AND o.cleared_at IS NULL
         AND (o.ends_on IS NULL OR o.ends_on > $2) AND o.starts_on <= $3
         AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
         AND ($5::uuid IS NULL OR u.property_id = $5)`,
      [callerLandlordIds, fromDate, toDate, scopedIds, oneProperty])

    // S652 (Nic): "when you mark it back in service, have it still show that."
    // The outages that were put back in service, drawn as what they were: time
    // the site was down. ended_on is the day it came back (exclusive, like
    // ends_on), and a site down and back the same day still shows that day.
    // These block nothing — only the open windows above do.
    const { OOO_EFFECTIVE_END_SQL } = await import('../services/outOfOrder')
    const outOfOrderHistory = await query<any>(`
      SELECT o.id, o.unit_id, to_char(o.starts_on, 'YYYY-MM-DD') AS starts_on,
             to_char(GREATEST(${OOO_EFFECTIVE_END_SQL}, o.starts_on + 1), 'YYYY-MM-DD') AS ended_on,
             (${OOO_EFFECTIVE_END_SQL} - o.starts_on) AS days_out, o.reason
        FROM unit_out_of_order o
        JOIN units u ON u.id = o.unit_id
        JOIN properties p ON p.id = u.property_id
       WHERE u.landlord_id = ANY($1::uuid[]) AND o.cleared_at IS NOT NULL
         AND ${OOO_EFFECTIVE_END_SQL} >= o.starts_on
         AND GREATEST(${OOO_EFFECTIVE_END_SQL}, o.starts_on + 1) > $2 AND o.starts_on <= $3
         AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
         AND ($5::uuid IS NULL OR u.property_id = $5)`,
      [callerLandlordIds, fromDate, toDate, scopedIds, oneProperty])

    res.json({ success: true, data: { units, bookings, leases, outOfOrder, outOfOrderHistory, range: { from: fromDate, to: toDate } } })
  } catch (e) { next(e) }
})

// GET /api/units/schedule/history — S517 / #10. Master-schedule change log:
// every reservation create / move / date-change / cancel, newest first.
unitsRouter.get('/schedule/history', requirePerm(
  'schedule.tab.history',
  'guests.check_in', 'guests.check_out', 'units.view_status', 'units.edit',
), async (req, res, next) => {
  try {
    // S633: the account's companies, not one.
    const callerLandlordIds = landlordScopeIds(req.user!)
    const scopedIds = await getScopedPropertyIds(req.user)
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '100')) || 100))
    const events = await query<any>(`
      SELECT e.id, e.event_type, e.summary, e.detail, e.created_at,
             u.unit_number, p.name AS property_name,
             a.first_name AS actor_first, a.last_name AS actor_last
        FROM unit_booking_events e
        JOIN units u ON u.id = e.unit_id
        JOIN properties p ON p.id = u.property_id
        LEFT JOIN users a ON a.id = e.actor_user_id
       WHERE e.landlord_id = ANY($1::uuid[])
         AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
       ORDER BY e.created_at DESC
       LIMIT $2`, [callerLandlordIds, limit, scopedIds])
    res.json({ success: true, data: events })
  } catch (e) { next(e) }
})


// ─── UNIT ACTIVATION / AVAILABILITY (landlord-controlled) ──────

// POST /api/units/:id/mark-available — vacant → available (listed, no billing yet)
unitsRouter.post('/:id/mark-available', requirePerm('units.manage_lifecycle'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (unit.status !== 'vacant') throw new AppError(400, `Cannot mark available from status '${unit.status}'. Only vacant units can be marked available.`)
    const updated = await queryOne<any>(`UPDATE units SET status='available', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/mark-vacant — available → vacant (withdraw from listing)
unitsRouter.post('/:id/mark-vacant', requirePerm('units.manage_lifecycle'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (unit.status !== 'available') throw new AppError(400, `Cannot mark vacant from status '${unit.status}'. Only available units can be marked vacant.`)
    const updated = await queryOne<any>(`UPDATE units SET status='vacant', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/activate — gate: lease + tenant + rent. Optional scheduledFor ISO datetime (UTC).
// S128: opened to property_manager with units.edit. Activation kicks off
// billing but is fundamentally a unit-state change — same operational
// surface as PATCH /:id/status, which is already units.edit.
unitsRouter.post('/:id/activate', requirePerm('units.manage_lifecycle'), async (req, res, next) => {
  try {
    const body = z.object({ scheduledFor: z.string().datetime().optional() }).parse(req.body)
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    if (unit.status === 'active') throw new AppError(400, 'Unit is already active')
    if (!unit.rent_amount || unit.rent_amount <= 0) throw new AppError(400, 'Cannot activate without a rent amount')

    const activeLease = await queryOne<any>(`SELECT id FROM leases WHERE unit_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`, [req.params.id])
    if (!activeLease) throw new AppError(400, 'Cannot activate without an active lease')

    if (body.scheduledFor) {
      const when = new Date(body.scheduledFor)
      if (isNaN(when.getTime())) throw new AppError(400, 'Invalid scheduledFor datetime')
      if (when.getTime() <= Date.now()) throw new AppError(400, 'scheduledFor must be in the future')
      const updated = await queryOne<any>(`UPDATE units SET scheduled_activation_at=$1, scheduled_activation_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [when, req.user!.userId, req.params.id])
      return res.json({ success: true, data: updated, scheduled: true })
    }

    // Immediate activation
    const updated = await queryOne<any>(`UPDATE units SET status='active', scheduled_activation_at=NULL, scheduled_activation_by=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated, scheduled: false })
  } catch (e) { next(e) }
})

// POST /api/units/:id/cancel-scheduled-activation
// S128: opened to property_manager with units.edit (same surface as activate).
unitsRouter.post('/:id/cancel-scheduled-activation', requirePerm('units.manage_lifecycle'), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    if (!unit.scheduled_activation_at) throw new AppError(400, 'No scheduled activation to cancel')
    const updated = await queryOne<any>(`UPDATE units SET scheduled_activation_at=NULL, scheduled_activation_by=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/subtype — set (or clear) the subtype on units, in bulk.
//
// S630 (Nic): "Setting that subtype on the bulk creation does not actually link
// it... my subtypes are showing zero units in each, and there needs to be some
// sort of link there because otherwise what the hell is it even on the creation
// page for?"
//
// The creation bug is fixed separately, but that does nothing for units already
// on the platform — 53 RV spaces at Mountain View were created unlinked, and
// properties are permanent, so re-making them is not an option. This is how they
// get classified without touching anything else about them.
//
// A subtype LOCKS the unit type (S537), so a subtype may only be applied to units
// of its own type; mismatches are refused by name rather than skipped, because
// silently classifying 40 of 53 is worse than classifying none.
// S630: either gate. Classifying a unit is a "configure unit" action — that is
// what PATCH /:id/subtype has always required, and it is what the unit page's
// subtype toggles check before rendering. Requiring only units.edit here would
// have shown an on-site manager toggles that 403 on click.
unitsRouter.post('/subtype', requirePerm('units.edit', 'schedule.configure_unit'), async (req, res, next) => {
  try {
    // S630: a unit carries SEVERAL subtypes, each toggled on its own — "pull
    // through" AND "50 amp" AND "facing west", not one pre-bundled row per
    // combination. subtypeIds REPLACES the whole set on each unit, so unchecking
    // is expressed by leaving it out; an empty array clears them.
    const parsed = z.object({
      unitIds:    z.array(z.string().uuid()).min(1).max(500),
      subtypeIds: z.array(z.string().uuid()).max(20).optional(),
      // Accepted so older callers keep working; folded into the array below.
      subtypeId:  z.string().uuid().nullable().optional(),
    }).parse(req.body)
    const { unitIds } = parsed
    const subtypeIds = parsed.subtypeIds
      ?? (parsed.subtypeId ? [parsed.subtypeId] : [])

    const units = await query<any>(
      `SELECT u.id, u.unit_number, u.unit_type, u.landlord_id, u.property_id
         FROM units u WHERE u.id = ANY($1::uuid[])`, [unitIds])
    if (units.length !== unitIds.length) throw new AppError(404, 'One or more units were not found.')
    for (const u of units) {
      if (!canManageLandlordResource(req.user, u.landlord_id)) throw new AppError(403, 'Forbidden')
    }
    const properties = new Set(units.map((u) => u.property_id))
    if (properties.size > 1) {
      throw new AppError(400, 'Those units are on different properties — a subtype belongs to one property.')
    }

    let subs: any[] = []
    if (subtypeIds.length) {
      subs = await query<any>(
        `SELECT * FROM property_unit_subtypes WHERE id = ANY($1::uuid[]) AND property_id = $2`,
        [subtypeIds, units[0].property_id])
      if (subs.length !== new Set(subtypeIds).size) {
        throw new AppError(404, 'One or more of those subtypes does not belong to this property.')
      }
      // A subtype locks the unit type (S537). Refused BY NAME rather than applied
      // to the units that happen to fit — classifying 40 of 53 quietly is worse
      // than classifying none, because nobody would know which missed.
      for (const sub of subs) {
        const wrong = units.filter((u) => u.unit_type !== sub.unit_type)
        if (wrong.length) {
          throw new AppError(400,
            `“${sub.name}” is a ${String(sub.unit_type).replace(/_/g, ' ')} subtype, but ` +
            `${wrong.map((u) => u.unit_number).join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not. ` +
            `Nothing was changed.`)
        }
      }
    }

    // S630 (Nic): amp tags stack — 30 AND 50 is a real pedestal. Layout tags do
    // not: a site is back-in or pull-through. Refused here so the landlord reads
    // a sentence instead of a database error; the trigger in
    // 20260830233000_one_site_layout_per_unit is the backstop for every other
    // writer. Only DECLARED layouts collide — a tag set to "Not specified" makes
    // no claim about the site and never conflicts with one.
    const layouts = [...new Set(subs
      .map((x: any) => x.rv_site_layout)
      .filter((v: any) => v && v !== 'none'))]
    if (layouts.length > 1) {
      const named = subs
        .filter((x: any) => x.rv_site_layout && x.rv_site_layout !== 'none')
        .map((x: any) => `“${x.name}”`).join(' and ')
      throw new AppError(400,
        `A site is back-in or pull-through, not both — ${named} can't both be true of the same space. ` +
        `Untick one. Nothing was changed.`)
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM unit_subtype_links WHERE unit_id = ANY($1::uuid[])`, [unitIds])
      if (subs.length) {
        await client.query(
          `INSERT INTO unit_subtype_links (unit_id, subtype_id)
           SELECT u, s FROM unnest($1::uuid[]) u CROSS JOIN unnest($2::uuid[]) s
           ON CONFLICT DO NOTHING`,
          [unitIds, subs.map((x) => x.id)])
      }
      // Kept in step for readers still on the single column (booking quote,
      // the retire-and-replace column list). unit_subtype_links is the truth.
      await client.query(
        `UPDATE units SET subtype_id = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
        [subs[0]?.id ?? null, unitIds])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }

    res.json({ success: true, data: {
      updated: unitIds.length,
      subtypes: subs.map((x) => x.name),
    } })
  } catch (e) { next(e) }
})
