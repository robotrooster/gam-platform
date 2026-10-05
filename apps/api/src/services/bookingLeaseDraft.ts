import { query, queryOne } from '../db'
import { todayIn, dateIn } from '../lib/timezone'
import { pooledCheckSql } from './onboardingWindow'

// S547 (Nic): the long-stay ping is a DECISION for the landlord — screen
// first, or send the lease directly if they know the guest. To inform that
// decision we surface the guest's history WITH THIS ACCOUNT: prior completed
// stays with this account, an approved background check run for this account
// (or shared by the guest through the renter pool), and whether they've rented
// from this account continuously since that check (approved check + continuous
// tenancy since = no new check needed). S655: never another company's checks
// or leases.
//
// 10/5 (Nic, prepaid stays): most long-stay guests never sign a lease, so their
// STAYS at this account count toward "continuously since" the same as leases —
// otherwise an approved guest who keeps paying ahead month after month would be
// re-screened (and re-charged) on every new stay. The person is found by their
// tenant account when the caller knows it, else by the guest's email.
const CONTINUITY_GAP_DAYS = 30   // move-between-units grace when chaining leases and stays

export interface GuestScreeningContext {
  priorStays: number
  approvedCheckAt: string | null           // date of latest approved GAM check
  /** That check's row, so a caller can tell the check run for THIS stay from an older one. */
  approvedCheckId: string | null
  approvedCheckCreatedAt: string | null    // ISO instant the check row was made
  continuousTenancySince: boolean          // leases and stays chain from that check to today
}

export async function guestScreeningContext(
  guestEmail: string | null, landlordId: string, tz: string | null, tenantId?: string | null,
): Promise<GuestScreeningContext> {
  const out: GuestScreeningContext = {
    priorStays: 0, approvedCheckAt: null, approvedCheckId: null, approvedCheckCreatedAt: null,
    continuousTenancySince: false,
  }
  const person = tenantId
    ? await queryOne<{ user_id: string; tenant_id: string | null; email: string | null }>(
        `SELECT u.id AS user_id, t.id AS tenant_id, u.email
           FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])
    : guestEmail
    ? await queryOne<{ user_id: string; tenant_id: string | null; email: string | null }>(
        `SELECT u.id AS user_id, t.id AS tenant_id, u.email
           FROM users u LEFT JOIN tenants t ON t.user_id = u.id
          WHERE LOWER(u.email) = LOWER($1) LIMIT 1`, [guestEmail])
    : null
  const email = (guestEmail || person?.email || '').trim().toLowerCase() || null
  const personTenant = person?.tenant_id ?? tenantId ?? null
  if (!email && !personTenant) return out

  // The guest's stays at this account (any of its companies), by their tenant
  // account or the email on the booking.
  const staysSql = `FROM unit_bookings b
      WHERE b.landlord_id IN (SELECT public.account_companies($1))
        AND ((b.tenant_id IS NOT NULL AND b.tenant_id = $2::uuid)
             OR ($3::text IS NOT NULL AND LOWER(b.guest_email) = $3::text))`

  // S654: a stay is "prior" once its check-out is before the park's today —
  // the same calendar the continuity walk below counts from.
  const stays = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n ${staysSql}
        AND b.status IN ('checked_out', 'confirmed', 'checked_in')
        AND b.check_out < $4::date`, [landlordId, personTenant, email, todayIn(tz)])
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
  const check = await queryOne<{ id: string; at: string; created_at: Date }>(
    `SELECT bc.id, COALESCE(bc.decided_at, bc.created_at) AS at, bc.created_at FROM background_checks bc
      WHERE bc.status = 'approved' AND (bc.user_id = $1 OR bc.tenant_id = $2)
        AND (${pooledCheckSql('bc')} OR bc.landlord_id IN (SELECT public.account_companies($3)))
      ORDER BY COALESCE(bc.decided_at, bc.created_at) DESC LIMIT 1`,
    [person.user_id, person.tenant_id, landlordId])
  if (!check?.at) return out
  // pg returns a Date object — normalize to YYYY-MM-DD. S654: the day it was
  // approved on the property's calendar; the UTC day reads as tomorrow for a
  // check decided after 5 pm in Phoenix.
  out.approvedCheckAt = dateIn(tz, new Date(check.at))
  out.approvedCheckId = check.id
  out.approvedCheckCreatedAt = new Date(check.created_at).toISOString()

  // Continuous = their leases with THIS account (any of its companies, via
  // the lease_tenants junction) and — 10/5 — their stays here, merged with a
  // small move-between-spaces grace, cover check-date → today. S655: it walked
  // leases at every GAM landlord, which told this company where else the guest
  // had lived.
  // S654: ::text — pg hands a bare DATE back as a JS Date, and String(Date)
  // .slice(0, 10) is "Fri Jul 10", which made every lease below an Invalid
  // Date: the walk never advanced and continuity was judged off the check
  // date alone.
  const leases = person.tenant_id
    ? await query<{ start_date: string; end_date: string | null }>(
        `SELECT l.start_date::text AS start_date, l.end_date::text AS end_date
           FROM leases l
           JOIN lease_tenants lt ON lt.lease_id = l.id
          WHERE lt.tenant_id = $1 AND l.status NOT IN ('pending', 'cancelled')
            AND l.landlord_id IN (SELECT public.account_companies($2))`, [person.tenant_id, landlordId])
    : []
  const stayRows = await query<{ start_date: string; end_date: string }>(
    `SELECT b.check_in::text AS start_date, b.check_out::text AS end_date ${staysSql}
        AND b.status IN ('confirmed', 'checked_in', 'checked_out')`,
    [landlordId, personTenant, email])
  const spans = [...leases, ...stayRows]
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
  let cover = new Date(out.approvedCheckAt + 'T12:00:00Z')
  // S654: today is the property's calendar day, anchored at noon UTC like
  // the lease dates, so the 30-day grace is counted in whole days and does
  // not flip with the hour.
  const today = new Date(todayIn(tz) + 'T12:00:00Z')
  for (const l of spans) {
    const s = new Date(String(l.start_date).slice(0, 10) + 'T12:00:00Z')
    const e = l.end_date ? new Date(String(l.end_date).slice(0, 10) + 'T12:00:00Z') : today
    if (s.getTime() - cover.getTime() > CONTINUITY_GAP_DAYS * 86400000) break
    if (e > cover) cover = e
  }
  out.continuousTenancySince = today.getTime() - cover.getTime() <= CONTINUITY_GAP_DAYS * 86400000
  return out
}

/**
 * The landlord-facing sentence about what this account already knows of the
 * guest (S547/S655): an approved check and continuity since, prior stays, or
 * nothing on file. Everything here is this account's own record (plus a check
 * the guest shared through the renter pool) — never another company's.
 */
export function screeningHistorySentence(ctx: GuestScreeningContext): string {
  return ctx.approvedCheckAt && ctx.continuousTenancySince
    ? ` They passed a background check on ${ctx.approvedCheckAt} and have stayed with you continuously since — no new check is needed.`
    : ctx.approvedCheckAt
    ? ` They passed a background check on ${ctx.approvedCheckAt}, but haven't stayed with you continuously since.`
    : ctx.priorStays > 0
    ? ` They've stayed with you ${ctx.priorStays} time${ctx.priorStays === 1 ? '' : 's'} before; no background check with you is on file.`
    : ' No background check with you is on file for this guest.'
}

/**
 * 10/3 (decisions #15): what has been paid toward a reservation, as SQL on a
 * unit_bookings row aliased `b` — NULL when nothing has been. The stay paid
 * whole (balance_paid_at) is its whole price; otherwise the deposit paid
 * (deposit_paid_at), or the whole price when that payment carried no separate
 * deposit amount. The ONE definition: the lease drafted from the reservation
 * takes this off its first bill (jobs/moveInBundle) and the landlord's notice
 * here names the same amount.
 *
 * 10/5 (Nic, prepaid stays — M4): a lease chosen AFTER the stay began starts
 * on the day it is drafted (services/stayTerms draftLeaseFromStay), not back on
 * the check-in day. The nights already stayed before it were the stay's and
 * were paid as the stay, so they are not credited to the lease: what comes off
 * its first bill is only what was paid for the nights from the lease's first
 * day on — the stay's price for those nights, by night, out of what was paid.
 * Credited once, on that first bill (dated the lease's start, today).
 */
const PAID_TOWARD_SQL =
  `(CASE WHEN b.balance_paid_at IS NOT NULL THEN b.total_amount
         WHEN b.deposit_paid_at IS NOT NULL THEN COALESCE(b.deposit_amount, b.total_amount)
    END)`
const NIGHTS_STAYED_BEFORE_LEASE_SQL =
  `COALESCE((SELECT ROUND(b.total_amount * (LEAST(sl.start_date, b.check_out) - b.check_in)::numeric
                          / NULLIF(b.check_out - b.check_in, 0), 2)
               FROM leases sl
              WHERE sl.source_booking_id = b.id AND sl.start_date > b.check_in
              ORDER BY sl.created_at DESC LIMIT 1), 0)`
export const RESERVATION_PAID_SQL =
  `(CASE WHEN ${PAID_TOWARD_SQL} IS NOT NULL
         THEN GREATEST(${PAID_TOWARD_SQL} - ${NIGHTS_STAYED_BEFORE_LEASE_SQL}, 0)
    END)`

// S526 drafted a lease automatically once a reservation reached 30 nights (7
// at weekly-lease parks). 10/5 (Nic, R3): "No automatic lease anywhere." A
// lease from a stay is drafted ONLY when lease was chosen — services/stayTerms
// draftLeaseFromStay — and screening rides on the payment (stayTerms
// recordScreeningPrepayment). The old auto-draft is gone.
