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

import { query } from '../db'
import { firePayoutForConnectAccount, getAvailableUsdBalance } from '../services/connectPayouts'
import { createAdminNotification } from '../services/adminNotifications'
import { reconcilePlatformHeldPayments, recoverPendingPlatformTransfers } from '../services/landlordPassthrough'
import { collectOwedInstantMargins } from '../services/instantWithdrawalMargin'
import { logger } from '../lib/logger'

// US federal holidays 2026-2027. Refresh annually before each calendar year.
// "Observed" dates used when the actual holiday falls on a weekend.
export const US_FEDERAL_HOLIDAYS = new Set<string>([
  // 2026
  '2026-01-01', // New Year's Day (Thu)
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth (Fri)
  '2026-07-03', // Independence Day observed (Jul 4 = Sat)
  '2026-09-07', // Labor Day
  '2026-10-12', // Columbus Day
  '2026-11-11', // Veterans Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas (Fri)
  // 2027
  '2027-01-01', // New Year's Day (Fri)
  '2027-01-18', // MLK Day
  '2027-02-15', // Presidents Day
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth observed (Jun 19 = Sat)
  '2027-07-05', // Independence Day observed (Jul 4 = Sun)
  '2027-09-06', // Labor Day
  '2027-10-11', // Columbus Day
  '2027-11-11', // Veterans Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas observed (Dec 25 = Sat)
])

const TZ = 'America/Phoenix'

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
const PAYOUT_TARGET_DOW = 2  // Tuesday (0=Sun … 6=Sat)

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

export function shouldRunToday(now: Date = new Date(), tz: string = TZ): boolean {
  const dow = localDayOfWeek(now, tz)
  if (dow < 1 || dow > 5) return false
  if (US_FEDERAL_HOLIDAYS.has(localDateString(now, tz))) return false
  return localDateString(now, tz) === localDateString(thisWeeksAutoPayoutDate(now, tz), tz)
}

// ============================================================================
// Engine
// ============================================================================

export interface PayoutResult {
  candidatesScanned: number
  payoutsFired: number
  skippedZeroBalance: number
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
    skippedAlreadyPaidThisWeek: 0,
    payoutsFailed: 0,
    errors: [],
  }

  if (!shouldRunToday(now, TZ)) {
    return result
  }

  const today = localDateString(now, TZ)

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
  const candidates: Candidate[] = [
    ...userRows.map((r): UserCandidate => ({ kind: 'user', ...r })),
    ...pmRows.map((r): PmCandidate => ({ kind: 'pm_company', ...r })),
    ...bizRows.map((r): BusinessCandidate => ({ kind: 'business', ...r })),
  ]
  result.candidatesScanned = candidates.length

  for (const cand of candidates) {
    try {
      const fired = await processOneCandidate(cand, today)
      if (fired === 'fired')                      result.payoutsFired++
      else if (fired === 'zero_balance')          result.skippedZeroBalance++
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

type OneCandidateOutcome = 'fired' | 'zero_balance' | 'already_paid_this_week' | 'failed'

async function processOneCandidate(cand: Candidate, today: string): Promise<OneCandidateOutcome> {
  // 1. Pre-skip: did this candidate already get an auto_friday payout
  //    inside the last 6 days? Stripe's idempotency_key is the authoritative
  //    guard, but pre-skipping avoids a wasted balance.retrieve round-trip.
  //    We only audit user-side payouts in `disbursements`, so the pre-skip
  //    only applies there. PM payouts skip this check and always rely on
  //    Stripe-side idempotency_key.
  if (cand.kind === 'user') {
    const recent = await query(
      `SELECT 1 FROM disbursements
        WHERE user_id = $1
          AND trigger_type = 'auto_friday'
          AND created_at > NOW() - INTERVAL '6 days'
        LIMIT 1`,
      [cand.entity_id]
    )
    if (recent.length > 0) return 'already_paid_this_week'
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
        gam_trigger:    'auto_friday',
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
