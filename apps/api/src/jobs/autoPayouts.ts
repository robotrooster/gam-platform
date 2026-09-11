/**
 * S113-Phase4: Auto-Friday payout cron — Stripe Payouts edition.
 *
 * Cron: Mon-Fri 9am Phoenix. Engine self-gates via shouldRunToday — only
 * runs on the auto-payout day for each work week. That is normally TUESDAY
 * (lands the landlord's bank by Friday at standard T+1–T+2), shifting forward
 * to the next non-holiday weekday when Tuesday is a US federal holiday.
 *
 * Architecture (S561 — platform-holds, supersedes S113 destination charges;
 * see memory gam-money-flow-platform-holds + MONEY_FLOW_REBUILD_SPEC.md):
 *   Tenant rent now lands on GAM's PLATFORM balance and stays there
 *   (payments.platform_held=true), NOT on the landlord's Connect. So this
 *   cron, for each landlord user, FIRST moves the owed owner-share
 *   platform → landlord Connect (reconcilePlatformHeldPayments), THEN sweeps
 *   the Connect balance to the bank — both in the same weekly run.
 *
 *   PM cuts and manager fees are still post-commit Stripe Transfers at
 *   allocation time (sourced from the platform charge). PM-company + business
 *   money already lands on their own Connect balance. (Phase 4 will move
 *   PM/manager cuts onto this weekly batch too.)
 *
 *   This cron iterates every Connect-enabled user + pm_company + business,
 *   (reconciles landlord platform-held funds first,) reads the live
 *   `available USD` balance from Stripe, and fires `stripe.payouts.create`
 *   against that account if > 0. Stripe routes the funds to the attached
 *   external bank (T+1–T+2 for standard ACH).
 *
 * Replaces the pre-Phase4 model:
 *   - GAM-book ledger sweep against `user_balance_ledger` per (user, bank)
 *   - `disbursements` queue with stub-rail fire
 *   - `withdrawal_auto` ledger debit pattern
 *
 * Audit layer:
 *   - `disbursements` table: Phase 4 still writes one row per fired payout
 *     for user-Connect payouts (UI continuity — landlord DashboardPage and
 *     DisbursementsPage read from there). Status flips on webhook
 *     payout.paid / .failed → recordPayoutEvent propagates the status back
 *     onto the disbursements row by stripe_payout_id match.
 *   - `connect_payouts` table: webhook-fed (S117). PM company payouts use
 *     ONLY this audit path — disbursements rows would need a pm_company_id
 *     column we haven't added; PM-portal will read from connect_payouts.
 */

import { isUsFederalHoliday } from '@gam/shared'
import { query } from '../db'
import { firePayoutForConnectAccount, getAvailableUsdBalance } from '../services/connectPayouts'
import { createAdminNotification } from '../services/adminNotifications'
import { reconcilePlatformHeldPayments, recoverPendingPlatformTransfers } from '../services/landlordPassthrough'
import { collectOwedInstantMargins } from '../services/instantWithdrawalMargin'
import {
  dueTriggers, markTriggerFired,
} from '../services/payoutTriggers'
import { logger } from '../lib/logger'

// US federal holidays. Computed, not listed.
//
// S617: this was a hand-maintained set for 2026-2027 headed "Refresh annually
// before each calendar year" — a chore nobody would remember, whose reward for
// being forgotten is payouts firing on a day the banks are shut. The shared
// helper derives them from the rules (including the Sat->Fri / Sun->Mon
// observed shift) for any year, and payoutTriggers now schedules against the
// same source, so the day the scheduler thinks is a business day and the day
// this engine agrees to run on cannot drift apart.
//
// Verified identical to the list it replaced for 2026 and 2027 before the swap.
export const US_FEDERAL_HOLIDAYS = {
  has: (iso: string): boolean => isUsFederalHoliday(iso),
}

// S617 (Nic): "I think we should do that an hour after the money becomes
// available. The sooner it can get to the landlords, the more they're gonna
// appreciate it."
//
// This engine used to think in Phoenix dates and run at 9am Phoenix — sixteen
// hours after Stripe releases the money, because available_on is a hard
// 00:00:00 UTC boundary (verified on both a live card and a live ACH in the
// account: Thu 2026-08-13 00:00:00 and Tue 2026-08-25 00:00:00, and a payout
// created at 00:18:00 UTC on the availability date went through).
//
// It now runs at 01:00 UTC and counts in UTC. ONE frame, and it is Stripe's
// own: a trigger's scheduled_for is an available_on date, so comparing it to a
// Phoenix date would have missed it by a day, and running two frames into the
// same Stripe idempotency key (auto_payout_<account>_<today>) is how a landlord
// gets paid twice. The weekly stream's "Tuesday" is now Tuesday UTC, which
// initiates Monday evening Phoenix and lands at the bank on the same schedule.
const TZ = 'UTC'

// ============================================================================
// Date helpers (timezone-aware via Intl)
// ============================================================================

function localDateString(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

function localDayOfWeek(date: Date, tz: string): number {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[short]
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + n)
  return d
}

// D1 (Nic, S561): the batch INITIATES on the weekday whose standard-payout
// arrival lands the money in the landlord's bank BY FRIDAY. Standard payouts
// settle T+1–T+2 business days, so we target TUESDAY: T+2 → Thursday, a full
// business-day buffer before Friday. Wednesday would be razor-thin at T+2
// (Wed+2 = Fri, no margin) and only safe if the account reliably settles T+1.
// PINNED PENDING C4 (live-account payout speed): if the live account is
// confirmed reliably T+1, move to Wednesday to reclaim a float day.
// ── S640 (Nic): THURSDAY ────────────────────────────────────────────────────
//
//   "Let's do the disbursement Thursdays... it'll either land Friday or Monday
//    like you said."
//
// A standard Stripe payout lands one to two business days out, so Thursday
// reaches the landlord's bank Friday at best and Monday at worst — money in
// hand for the weekend when it moves fast, and waiting at the start of the week
// when it does not. Tuesday was marginally quicker to usable funds; Nic weighed
// that against landing on a Friday and chose Friday. Change this constant and
// the holiday shift, the weekly gate and the run instant all follow.
const PAYOUT_TARGET_DOW = 4  // Thursday (0=Sun … 6=Sat)

// The target payout day for the work-week containing `now`, computed from any
// day of that week. Sun is treated as day 7 (end of a Mon..Sun week) so the
// offset is stable; weekend inputs map back to that week's target day, which
// is harmless because shouldRunToday never fires on a weekend or holiday.
function thisWeeksTargetDay(now: Date, tz: string, targetDow: number): Date {
  const dow = localDayOfWeek(now, tz)
  const d = dow === 0 ? 7 : dow
  return addDays(now, targetDow - d)
}

function nextWeekday(date: Date, tz: string): Date {
  let d = addDays(date, 1)
  while (true) {
    const dow = localDayOfWeek(d, tz)
    if (dow >= 1 && dow <= 5) return d
    d = addDays(d, 1)
  }
}

function thisWeeksAutoPayoutDate(now: Date, tz: string): Date {
  // If the target day is a federal holiday, shift FORWARD to the next weekday
  // (D1: no backward compensation — holiday weeks simply land the following
  // Mon and everyone expects that).
  let d = thisWeeksTargetDay(now, tz, PAYOUT_TARGET_DOW)
  while (US_FEDERAL_HOLIDAYS.has(localDateString(d, tz))) {
    d = nextWeekday(d, tz)
  }
  return d
}

/**
 * S616: the ONE guaranteed sweep a month. Reuses the Tuesday machinery — and
 * its holiday and business-day handling — rather than inventing a second
 * calendar, but fires only on the late-month occurrence (day 20-26). That is
 * far enough past the rent surge to collect stragglers who paid after the 90%
 * firing, and it is the backstop for a month where neither threshold tripped.
 */
export function isMonthlySweepDay(now: Date = new Date(), tz: string = TZ): boolean {
  if (!shouldRunToday(now, tz)) return false
  const dom = Number(localDateString(now, tz).slice(8, 10))
  return dom >= 20 && dom <= 26
}

// ── S641 (Nic): THE MONTH-END SWEEP ────────────────────────────────────────
//
//   "A lot of landlords like to sweep cash before the end of the month, so we
//    should have one additional push timed so that the balance is swept and
//    HITS THE BANK ACCOUNT by the last business day of the month. If the last
//    business day is a Friday and we need to push it on a Tuesday or Wednesday
//    for it to actually hit by that Friday, that's important to some landlords
//    for bookkeeping. You don't want stuff rolling over — you want all the
//    months separated accurately."
//
// The target is ARRIVAL, not firing. So this works backwards: find the last
// business day of the month, then step back far enough that a standard payout
// has landed by then.
//
// Two business days back. A Stripe standard payout arrives one to two business
// days after it is created, so firing two ahead lands on the last business day
// in the slow case and the day before in the fast one — early is fine for
// bookkeeping, late is the whole thing this exists to prevent.

/** Monday to Friday, and not a US federal holiday. */
function isBusinessDayUtc(iso: string): boolean {
  const dow = new Date(iso + 'T12:00:00Z').getUTCDay()
  if (dow === 0 || dow === 6) return false
  return !US_FEDERAL_HOLIDAYS.has(iso)
}

function isoUtc(y: number, m0: number, day: number): string {
  return new Date(Date.UTC(y, m0, day, 12, 0, 0)).toISOString().slice(0, 10)
}

/** The last day of the month a bank is open. */
export function lastBusinessDayOfMonthUtc(year: number, month0: number): string {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0, 12, 0, 0)).getUTCDate()
  for (let d = lastDay; d >= 1; d--) {
    const iso = isoUtc(year, month0, d)
    if (isBusinessDayUtc(iso)) return iso
  }
  return isoUtc(year, month0, lastDay)
}

/** How many business days ahead of arrival the sweep has to fire. */
const SWEEP_LEAD_BUSINESS_DAYS = 2

/** The day the month-end sweep fires, so the money has ARRIVED by month end. */
export function monthEndSweepDateUtc(year: number, month0: number): string {
  let cursor = new Date(lastBusinessDayOfMonthUtc(year, month0) + 'T12:00:00Z')
  for (let stepped = 0; stepped < SWEEP_LEAD_BUSINESS_DAYS; ) {
    cursor = new Date(cursor.getTime() - 86400000)
    if (isBusinessDayUtc(cursor.toISOString().slice(0, 10))) stepped++
  }
  return cursor.toISOString().slice(0, 10)
}

/**
 * Is this instant the month-end sweep?
 *
 * Measured in UTC, like the weekly gate: the cron fires at 01:00 UTC and Stripe
 * books the payout on that UTC day, which is the day a landlord's statement
 * shows and the day the arrival maths is done in.
 */
export function isMonthEndSweepDay(now: Date = new Date()): boolean {
  const iso = now.toISOString().slice(0, 10)
  const d = new Date(iso + 'T12:00:00Z')
  return iso === monthEndSweepDateUtc(d.getUTCFullYear(), d.getUTCMonth())
}

/**
 * S640 — the next date a payout will actually be created, for the landlord's
 * dashboard.
 *
 * WHY THIS LIVES HERE: the card computed its own date and has now been wrong
 * three times — it said Friday while the engine ran Tuesday, then Tuesday while
 * the engine moved to Thursday. A landlord planning around a date we print is
 * owed the date the engine will actually fire, so the card reads it from the
 * engine instead of re-deriving the schedule beside it.
 *
 * Returns a UTC date string (YYYY-MM-DD), because that is the day STRIPE books
 * the payout — the cron fires at 01:00 UTC, which is the evening before in
 * Phoenix, and the landlord will see Stripe's day on their statement.
 */
export function nextPayoutDateUtc(from: Date = new Date()): string {
  for (let i = 0; i < 14; i++) {
    // The real firing instant for each candidate day: 01:00 UTC.
    const probe = new Date(Date.UTC(
      from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i, 1, 0, 0))
    if (probe <= from) continue
    // S641: the month-end sweep is a payout day too, and is often the next one.
    if (shouldRunToday(probe) || isMonthEndSweepDay(probe)) return probe.toISOString().slice(0, 10)
  }
  return ''
}

export function shouldRunToday(now: Date = new Date(), tz: string = TZ): boolean {
  const dow = localDayOfWeek(now, tz)
  if (dow < 1 || dow > 5) return false
  if (US_FEDERAL_HOLIDAYS.has(localDateString(now, tz))) return false
  return localDateString(now, tz) === localDateString(thisWeeksAutoPayoutDate(now, tz), tz)
}

// ============================================================================
// Engine
// ============================================================================

// ── S640 payout economics (Nic) ─────────────────────────────────────────────
// Stripe bills 0.17% of the amount moved plus $0.25 per payout. The percentage
// is unavoidable — it lands on the volume however it is batched — so these two
// numbers are the whole of what cadence can control.
/** Don't move less than this unless it has waited (see below). */
const MIN_PAYOUT_AMOUNT = 100
/** ...and after this many days, move it whatever it is. Nothing strands. */
const MAX_DAYS_BELOW_MINIMUM = 30
/** Never pay the same account twice inside this window. */
const MIN_DAYS_BETWEEN_PAYOUTS = 5

export interface PayoutResult {
  candidatesScanned: number
  payoutsFired: number
  skippedZeroBalance: number
  /** S640: held back under the $100 floor — money delayed, never kept. */
  skippedBelowMinimum: number
  /** S640: retired — payouts are weekly and nothing defers. Always 0. */
  triggersDeferred: number
  skippedAlreadyPaidThisWeek: number
  payoutsFailed: number
  errors: { entity: string; entity_id: string; account: string; error: string }[]
}

interface UserCandidate {
  kind: 'user'
  entity_id: string
  stripe_connect_account_id: string
}
interface PmCandidate {
  kind: 'pm_company'
  entity_id: string
  stripe_connect_account_id: string
}
interface BusinessCandidate {
  kind: 'business'
  entity_id: string
  stripe_connect_account_id: string
}
type Candidate = UserCandidate | PmCandidate | BusinessCandidate

export async function processAutoPayouts(now: Date = new Date()): Promise<PayoutResult> {
  const result: PayoutResult = {
    candidatesScanned: 0,
    payoutsFired: 0,
    skippedZeroBalance: 0,
    skippedBelowMinimum: 0,
    triggersDeferred: 0,
    skippedAlreadyPaidThisWeek: 0,
    payoutsFailed: 0,
    errors: [],
  }

  const today = localDateString(now, TZ)
  const cycleMonth = `${today.slice(0, 7)}-01`

  // S640 (Nic): back to a weekly calendar, deliberately. S616 replaced it with
  // rent-roll thresholds to pay landlords sooner; measured against real money
  // they paid them LATER — a threshold schedules four business days out, which
  // is behind the next Tuesday for most of a week — and they made one
  // landlord's payday depend on whether their other residents had paid.
  // The cadence is the only thing Stripe's fee structure lets us choose, and it
  // is worth about 33 cents a month. Speed is worth more. See the candidate
  // list below.
  const weeklyDay = shouldRunToday(now, TZ)
  // ── S641 (Nic): ONE EXTRA PUSH SO THE MONTH CLOSES CLEAN ────────────────
  //
  // "You don't want stuff rolling over — you want all the months separated
  // accurately." This fires early enough that the money has ARRIVED by the last
  // business day, and it ignores the floor and the interval below: the purpose
  // of a sweep is to leave nothing behind, so a $40 residual and a landlord
  // paid three days ago both still go.
  const sweepDay = isMonthEndSweepDay(now)
  const isPayoutDay = weeklyDay || sweepDay

  // S580: retry any platform→Connect passthrough intent stuck in `pending` (its
  // RESERVE committed but the Transfer never confirmed — e.g. Stripe was down).
  // The idempotency key dedupes, so this never double-pays; it just lands the
  // owed owner-share on the landlord's Connect BEFORE the per-candidate balance
  // sweep below picks it up. Best-effort — a failure here never blocks payouts.
  try {
    const rec = await recoverPendingPlatformTransfers()
    if (rec.recovered > 0 || rec.stillPending > 0) {
      await createAdminNotification({
        severity: rec.stillPending > 0 ? 'warn' : 'info',
        category: 'platform_held_transfer_recovery',
        title:    `Passthrough recovery: ${rec.recovered} recovered, ${rec.stillPending} still pending`,
        body:     `Scanned ${rec.scanned} pending platform→Connect transfer intents on ${today}.`,
        context:  rec,
      }).catch(() => {})
    }
  } catch (e) {
    logger.error({ err: e }, '[auto_payouts] passthrough recovery failed')
  }

  // Build the candidate list: every Connect-ready landlord/user + pm_company.
  // Cached readiness flags (S159+) are webhook-fed; gating here matches
  // the same gate used at withdrawal time so a manual withdrawal and an
  // auto-Friday payout never disagree on eligibility.
  //
  // S554 re-anchor Stage 2: resolve each founding user's payout account as
  // COALESCE(landlord ENTITY account, founding-user account) so an
  // entity-anchored landlord (users.stripe_connect_account_id NULL, account on
  // landlords) is actually swept — the pre-Stage-2 query scanned only `users`
  // and silently stranded entity-anchored balances. entity_id stays the
  // founding USER id: reconcilePlatformHeldPayments (which independently
  // re-resolves the same COALESCE account), the disbursements audit row, and
  // the 6-day pre-skip all key off it, so all downstream 'user' handling is
  // unchanged. Readiness is gated on the SAME anchor that owns the account
  // (CASE), never a mix of entity account + user readiness.
  const userRows = await query<{ entity_id: string; stripe_connect_account_id: string }>(
    `SELECT entity_id, stripe_connect_account_id FROM (
       SELECT u.id AS entity_id,
              COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS stripe_connect_account_id,
              CASE WHEN l.stripe_connect_account_id IS NOT NULL
                   THEN COALESCE(l.connect_payouts_enabled, FALSE) AND COALESCE(l.connect_details_submitted, FALSE)
                   ELSE COALESCE(u.connect_payouts_enabled, FALSE) AND COALESCE(u.connect_details_submitted, FALSE)
              END AS ready
         FROM users u
         LEFT JOIN landlords l ON l.user_id = u.id
     ) x
     WHERE x.stripe_connect_account_id IS NOT NULL AND x.ready = TRUE`
  )
  const pmRows = await query<{ entity_id: string; stripe_connect_account_id: string }>(
    `SELECT id AS entity_id, stripe_connect_account_id
       FROM pm_companies
      WHERE stripe_connect_account_id IS NOT NULL
        AND connect_payouts_enabled    = TRUE
        AND connect_details_submitted  = TRUE`
  )
  // S536 (Nic): business owners batch Friday the same way landlords do —
  // all money flows through GAM (POS + invoice destination charges land
  // on the business's Connect balance; this sweep moves it to their bank).
  const bizRows = await query<{ entity_id: string; stripe_connect_account_id: string }>(
    `SELECT id AS entity_id, stripe_connect_account_id
       FROM businesses
      WHERE stripe_connect_account_id IS NOT NULL
        AND connect_payouts_enabled    = TRUE
        AND connect_details_submitted  = TRUE
        AND status = 'active'`
  )
  // ── S616: decide who is actually due today ───────────────────────────────
  //
  // Landlords earn a payout by how much of their rent roll has come in, so
  // every weekday each one is measured and may CLAIM a trigger — scheduled four
  // ── S640: THE THRESHOLDS ARE RETIRED ──────────────────────────────────
  //
  // Everybody is weekly now, so a rent-roll threshold has nothing left to
  // decide. Claiming them anyway would grow a table of rows that schedule a
  // payout nobody reads and are never retired — cruft that the next person to
  // open payout_triggers would have to work out from scratch.
  //
  // The service and the table stay (GAM keeps everything, and the roll
  // measurement is worth having again if the cadence is ever revisited); this
  // is simply no longer the thing that pays anybody. Any trigger already
  // scheduled is closed out below.
  const stale = await dueTriggers(today, { includeFuture: true })
  for (const t of stale) {
    await markTriggerFired(t.id, 'superseded_by_weekly')
  }
  if (stale.length) {
    logger.info({ retired: stale.length },
      '[auto_payouts] retired rent-roll triggers — payouts are weekly now')
  }

  const candidates: Candidate[] = [
    // ── S640 (Nic, DIRECTIVE): WEEKLY, FOR EVERYBODY ───────────────────────
    //
    //   "The weekly transfer is a lot simpler than trying to have the three per
    //    cycle... if for some reason everybody's fairly late one month, or we
    //    don't hit the fifty percent threshold, and one person waits a whole
    //    week just to make it cross that, that's a problem. The numbers line up
    //    where let's just do it freaking weekly."
    //
    // The thresholds existed to pay a landlord FASTER than a weekly calendar.
    // They do not: they schedule four business days out, which is slower than
    // the next Tuesday for most of the week, and they made payment depend on
    // the collective behaviour of a landlord's other residents — Mountain View
    // reached 50% on Sep 9 and its money was booked for Sep 16 while sitting
    // available the whole time.
    //
    // And the money says the complexity buys nothing. Stripe's outbound fee is
    // 0.17% of VOLUME plus $0.25 per payout. The percentage is charged on the
    // amount moved however it is batched, so cadence only moves the quarters:
    // weekly against three-per-cycle is 33 cents a month at Mountain View.
    // Paying a week sooner is worth more than that to a landlord.
    //
    // Every Connect-ready landlord, every weekly run. The trigger machinery
    // below still measures the roll — that reporting is worth keeping — but it
    // no longer decides who gets paid.
    ...(isPayoutDay ? userRows.map((r): UserCandidate => ({ kind: 'user', ...r })) : []),
    ...(weeklyDay ? pmRows.map((r): PmCandidate => ({ kind: 'pm_company', ...r })) : []),
    ...(weeklyDay ? bizRows.map((r): BusinessCandidate => ({ kind: 'business', ...r })) : []),
  ]
  result.candidatesScanned = candidates.length

  for (const cand of candidates) {
    try {
      const fired = await processOneCandidate(cand, today, sweepDay)
      if (fired === 'fired')                      result.payoutsFired++
      else if (fired === 'zero_balance')          result.skippedZeroBalance++
      else if (fired === 'below_minimum')         result.skippedBelowMinimum++
      else if (fired === 'already_paid_this_week')result.skippedAlreadyPaidThisWeek++
      else if (fired === 'failed')                result.payoutsFailed++

    } catch (e: any) {
      result.payoutsFailed++
      result.errors.push({
        entity:    cand.kind,
        entity_id: cand.entity_id,
        account:   cand.stripe_connect_account_id,
        error:     e?.message ?? String(e),
      })
    }
  }

  return result
}

type OneCandidateOutcome =
  'fired' | 'zero_balance' | 'already_paid_this_week' | 'below_minimum' | 'failed'

async function processOneCandidate(
  cand: Candidate, today: string, monthEndSweep = false,
): Promise<OneCandidateOutcome> {
  // 1. Pre-skip: already paid TODAY? Stripe's idempotency_key is the
  //    authoritative guard; this avoids a wasted balance.retrieve round-trip.
  //
  //    S616: this was a SIX-DAY window, which is correct for a weekly batch and
  //    wrong for this one. The 50% and 90% firings are days apart by design —
  //    that is the entire point of measuring the rent roll instead of the
  //    calendar — and a six-day pre-skip would have silently swallowed the
  //    second one, leaving the landlord waiting on the very money the change
  //    exists to release. Narrowed to the same day, which is what the Stripe
  //    idempotency key already dedupes on.
  // ── S640 (Nic): A MINIMUM INTERVAL, NOT A CALENDAR RULE ────────────────
  //
  //   "I like your idea of the deduplication minimum interval instead of a
  //    calendar rule."
  //
  // The old guard asked whether a payout had been created TODAY. That answers
  // the wrong question: it permitted two payouts on consecutive days and it
  // matched only the one trigger_type it knew about. Asking how long it has
  // been since this account was last paid covers every ordering there is, and
  // it is one rule instead of a list of pairings.
  let daysSinceLastPayout: number | null = null
  if (cand.kind === 'user') {
    const last = await query<{ days: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 86400 AS days
         FROM disbursements WHERE user_id = $1`,
      [cand.entity_id]
    )
    daysSinceLastPayout = last[0]?.days == null ? null : Number(last[0].days)
    // S641: the month-end sweep is exempt. Its whole job is that nothing rolls
    // into next month, and a landlord paid on the weekly run two days earlier
    // is exactly the case where a residual would be left behind.
    if (!monthEndSweep
        && daysSinceLastPayout !== null
        && daysSinceLastPayout < MIN_DAYS_BETWEEN_PAYOUTS) {
      return 'already_paid_this_week'
    }
  }

  // 1b. Platform-holds reconcile (S561). Landlord rent sits on the PLATFORM
  //     balance, not this user's Connect. Move the owed owner-share
  //     platform → their Connect BEFORE reading the balance, so the payout
  //     below sweeps it to the bank in the same run. Self-gating: no-ops for
  //     non-landlord users (opt-in managers) and when nothing is owed. Only
  //     user candidates can be landlords; PM-company + business money already
  //     lands on their own Connect at allocation/charge time.
  if (cand.kind === 'user') {
    await reconcilePlatformHeldPayments(cand.entity_id)
  }

  // 1c. S580: collect any owed instant-withdrawal margin Connect→platform BEFORE
  //     the bank sweep — i.e. net GAM's instant-fee margin against this
  //     disbursement (never pre-pulled at withdrawal time). Idempotent; an
  //     uncollectable margin (balance withdrawn) stays owed for a future influx.
  //     Best-effort — never blocks the payout.
  try {
    await collectOwedInstantMargins(cand.stripe_connect_account_id)
  } catch (e) {
    logger.error({ err: e, account: cand.stripe_connect_account_id }, '[auto_payouts] instant-margin collection failed (will retry next batch)')
  }

  // 2. Read live Stripe available USD balance.
  const available = await getAvailableUsdBalance(cand.stripe_connect_account_id)
  if (available <= 0) return 'zero_balance'

  // ── S640 (Nic): A FLOOR, WITH AN AGE OVERRIDE SO NOTHING STRANDS ───────
  //
  //   "Let's just make it a hundred dollar minimum if money is ever just
  //    sitting there... if somebody stays one night in an RV, that's gonna just
  //    sit there until the next billing cycle. So it's not a big deal.
  //    Landlords operating on that scale aren't crying for the forty bucks
  //    right away."
  //
  // Stripe's outbound fee is 0.17% of volume plus $0.25 a payout. The quarter
  // is 0.6% of a $40 payout and 0.03% of an $800 one, so a floor is the only
  // part of the cost that cadence can actually change.
  //
  // The override is what keeps this from being a trap: a residual that never
  // reaches $100 is paid anyway once it has waited a month, which is the same
  // billing cycle Nic measured it against. Money is delayed here; it is never
  // kept.
  // S641: and the floor is waived at month end for the same reason — a $40
  // residual sitting on the balance is precisely the thing that makes a month's
  // books not tie out.
  if (!monthEndSweep
      && available < MIN_PAYOUT_AMOUNT
      && daysSinceLastPayout !== null
      && daysSinceLastPayout < MAX_DAYS_BELOW_MINIMUM) {
    return 'below_minimum'
  }

  // 3. Fire the payout. Idempotency key: deterministic per (account, day) so
  //    accidental same-day re-runs deduplicate at Stripe.
  const idempotencyKey = `auto_friday_${cand.stripe_connect_account_id}_${today}`
  let stripePayoutId: string
  try {
    const payout = await firePayoutForConnectAccount({
      connectAccountId: cand.stripe_connect_account_id,
      amount: available,
      method: 'standard',
      idempotencyKey,
      metadata: {
        gam_trigger:    monthEndSweep ? 'month_end_sweep' : 'auto_friday',
        gam_entity:     cand.kind,
        gam_entity_id:  cand.entity_id,
        gam_run_date:   today,
      },
      description: 'GAM weekly payout',
    })
    stripePayoutId = payout.id
  } catch (e: any) {
    await createAdminNotification({
      severity: 'critical',
      category: 'auto_friday_payout_failed',
      title:    `Auto-Friday payout failed for ${cand.kind} ${cand.entity_id}`,
      body:     e instanceof Error ? e.message : String(e),
      context:  {
        entity:    cand.kind,
        entity_id: cand.entity_id,
        account:   cand.stripe_connect_account_id,
        amount:    available,
      },
    })
    throw e
  }

  // 4. Audit row. Only for user-side payouts — PM payouts audit via the
  //    webhook-fed connect_payouts table (no pm_company_id on disbursements).
  if (cand.kind === 'user') {
    await query(
      `INSERT INTO disbursements
         (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
       VALUES ($1, 'auto_friday', $2, 'processing', $3, NOW(), 0)`,
      [cand.entity_id, available, stripePayoutId]
    )
  }

  return 'fired'
}
