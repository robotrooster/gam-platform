import type { PoolClient } from 'pg'
import {
  FLEXPAY_FORBIDDEN_PULL_DAYS,
  FLEXPAY_RETURNED_PULL_FEE,
  FLEXPAY_REJOIN_WAIT_DAYS,
  FLEXPAY_PULL_RETRY_DAYS,
  FLEXPAY_PULL_MAX_RETRIES,
  PAYMENT_ENTRY_DESCRIPTION_LABELS,
  PLATFORM_FEES,
  UTILITY_TYPE_LABEL,
  type PaymentEntryDescription,
  type UtilityType,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { isFeatureEnabled } from './systemFeatures'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import {
  computeTenantGamOutstandingTotal,
  applyTenantSupersedence,
  type ApplySupersedenceResult,
} from './supersedence'
import {
  FLEXPAY_TEMPLATE_VERSION,
  renderFlexPayAcceptanceText,
  recordAcceptance,
  fireFlexsuiteAcceptanceEmail,
} from './flexsuiteAcceptance'
import {
  lockHousehold, lockPaymentRowsById, payableRowSql, allocationOrderSql, depositOrMoveOutRowSql,
} from './moneyPredicates'
import { ALLOCATABLE_PAYMENT_TYPES, executeRentAllocation } from './allocation'
import { afterRowsSettled } from './settleHooks'
import { supersedeScheduledRetry, cancelSupersededIntents } from './creditUse'
import { readStripeMethodFacts } from './tenantBankMethods'
import { recordPlatformRevenue } from './platformRevenue'
import { extractReturnCode, decideRetry, bankRefusedDebit } from './achRetry'
import { logger } from '../lib/logger'
import { dateIn, monthStartOf } from '../lib/timezone'

// ============================================================
// FlexPay — tenant-paid payment-scheduling subscription.
//
// FlexPay is a SUBSCRIPTION, never a loan (CLAUDE.md Flex Suite, S304). The
// tenant picks a pull day and pays a FLAT $25 a month (S562). Enrollment is
// demand-test gated (S541) and stays closed until Nic opens it.
//
// ── Money flow per cycle (S655, Nic 10/2: "covers the whole monthly bill") ──
//   Cover — the LAST DAY OF GRACE (invoice due + grace − 1), 3 am, before the
//     late-fee engine's midnight run:
//       FlexPay pays the cycle invoice's open landlord lines — rent, utilities
//       and fees on that month's bill (never late fees already charged, never
//       balances carried from earlier months, never a security deposit: that
//       is held in trust, and S512 has it paid before FlexPay; never a home
//       payment — a payment toward owning a home is a real-property interest
//       GAM will not hold a claim in (decisions #35 point 7(e)) — never a line
//       reopened after the tenant disputed its payment, and never
//       a line credit already paid part of: GAM pulls only what it paid).
//       Whatever the cover leaves open is named to the tenant at what is
//       still open on each line, by email as well as in the app.
//       A line waiting on its own scheduled bank retry is paid too, and that
//       retry is called off (creditUse.supersedeScheduledRetry), so the bill
//       is never late and never pulled twice. The lines settle
//       with GAM's float: platform_held = TRUE, flexpay_advance_id set, owner
//       share booked with no processing fee (allocation feeAlreadyCollected),
//       and the landlord is paid on the normal Tuesday batch. Nothing in the
//       landlord's view says FlexPay ("Paid on time"). Saved credit is NOT
//       spent; FlexPay pays the bill and the credit stays saved.
//     A month the tenant already paid still makes an advance, for $0 covered:
//     GAM takes only the $25 on the pull day (Nic 10/2).
//     A run that missed the last grace day is caught up by the next runs, for
//     FLEXPAY_COVER_CATCHUP_DAYS days, and an admin is told it was late.
//     A second bill in the same month (the first bill of a landlord-signed new
//     lease that starts mid-month) is paid under the same advance while its
//     pull has not been written yet: its lines join the amount collected on the
//     pull day. Once the pull exists, the tenant is told by name (in the app
//     and by email) that FlexPay did not pay that bill and it is theirs to
//     pay, and an admin is told.
//   Pull — on flexpay_advances.pull_date (the tenant's pull day on or after the
//     cover; never the 1st-5th):
//       ONE GAM row (type 'fee', revenue_owner 'gam', entry 'FLEXPAY') is
//       written FIRST, then Stripe is asked. A row with no intent is "create
//       pending". Before a later run creates anything it searches Stripe by
//       metadata gam_payment_id and adopts what it finds; a create carries the
//       idempotency key flexpay_pull_<paymentId>, and the intent id is stored
//       in its own statement the moment Stripe answers. pull_attempts counts
//       runs. A pull GAM cannot make because of the TENANT's bank (no bank on
//       file, bank payments stopped, no verified bank) is the last try failing
//       at once: the advance is written off as the tenant's (Step 10, decisions
//       #37.D). A create Stripe refuses for GAM's own reasons is never written
//       off: every daily run tries again and an admin is told on the 3rd. The
//       bank pulled is the tenant's verified bank (their default when it is
//       one), never a card. A missed pull day is caught up the next run.
//       The pull row is GAM's own money. It is never part of a tenant balance
//       (moneyPredicates.payableRowSql) and never landlord income.
//   Settle — payment_intent.succeeded → reconcileSettledFlexPayPayment: the
//     advance is reconciled and the $25 is booked as 'flexpay_subscription'.
//     Lock order: every path here takes the tenant row before the pull row
//     and the advance; the cover and the settle of an adopted pull take the
//     household lock before that (as the success webhook must). An intent
//     whose id never reached its row (the process stopped between Stripe's
//     answer and the store) is recorded on the row its metadata names
//     (adoptFlexPayPullIntent, for the webhook; the next pull run adopts it
//     the same way) — never tenant credit.
//   Failure — a retryable bounce is retried FLEXPAY_PULL_RETRY_DAYS later, up
//     to FLEXPAY_PULL_MAX_RETRIES times (the shared ACH retry pipeline); each
//     retry re-prices to the covered amount + $25 + the returned-pull fee for
//     every bounce so far (repriceFlexPayRetryPayment), and the tenant's retry
//     notice states that same figure (notifyTenantPullRetry; FlexPay notices
//     only — the landlord was paid by the cover and never hears of a bounce).
//     A TERMINAL failure at the tenant's bank — the last retry, or a closed
//     account that is never retried — defaults the advance
//     (handleFlexPayPaymentNsf): FlexPay ends, 90 days before rejoining, for
//     good on a second time. Every returned-pull fee Stripe charged joins what
//     is written off (tenant_fee_amount), so GAM never keeps a fee. A
//     defaulted advance is recovered only by GAM-first routing on the tenant's
//     next payment (services/supersedence).
//     A debit the tenant's bank refused or returned is the bank's answer
//     whether or not GAM can read its reason (achRetry.bankRefusedDebit): a
//     reason no R-code maps (a frozen or restricted account) is the last try
//     failing, never retried (terms §4.1 retries only a shortage of funds).
//     A failure on GAM's side (GAM canceled the pull, could not re-price or
//     send a retry, or Stripe refused GAM's own request) is NEVER the
//     tenant's (Step 10, decisions #37.D, terms §4.3): FlexPay stays on, no
//     wait starts, and the collection is made again by the next pull run
//     (requeueGamSidePull); an admin is told to fix the cause. The bank
//     returns so far stay counted on the collection made again, so the bank
//     is never presented with it more than the first try and the terms' two
//     retries in all, and each try collects the returned-pull fee for every
//     return so far (terms §4.1(c)); after FLEXPAY_MAX_GAM_SIDE_REQUEUES
//     problems on GAM's side the collection is held for a person instead of
//     made again. A GAM-side delay that kept the cover from paying on time
//     has GAM pay the late fee it caused (payLateFeesGamCaused); a bill the
//     cover never paid in its catch-up window is told to an admin the day the
//     window closes (alertMissedCovers). FlexPayFailureSide is the one rule.
//   Taken back — a pull that settled and is later taken back (an ACH
//     "unauthorized" return, which Stripe sends as a dispute, up to 60 days
//     on) → handleFlexPayPullReversed: the advance is written off again as the
//     tenant's, the $25 booked for it is reversed, Stripe's fees join what is
//     written off, and FlexPay ends exactly as for a terminal failure. Once
//     per pull: the row is stamped FLEXPAY_PULL_TAKEN_BACK_REASON.
//   Recovered — GAM-first routing on a later payment flips a written-off
//     advance to 'reconciled' and books its $25 (services/supersedence).
//   Bank payments stopped (tenants.ach_suspended_at), or no verified bank —
//     no pull may cross the block, so the cover pays nothing and FlexPay ends
//     with the 90-day rejoin wait (Step 10, terms §4.3); the tenant is told,
//     by name, every line still theirs to pay on the bill.
//   Every ending tells the tenant (notifyTenantFlexPayEnded): why, what is
//     still open with GAM, when they can join again, and that autopay — which
//     joining turned off — is off. GAM never turns autopay back on itself.
//     Joining again waits until no written-off advance is open
//     (getFlexPayEligibility), so GAM never fronts a tenant twice before
//     collecting once.
//
// OTP coexistence: OTP is shelved (landlord-only), but its tables remain. If an
// OTP advance already fronted the landlord this cycle, the cover pays nothing
// (a $25-only month) so the landlord can never be paid twice for one bill.
// ============================================================

/**
 * S562 (Nic): FlexPay is a FLAT $25/month subscription. The pull day is the
 * tenant's choice for SCHEDULING only and never changes the price. One source:
 * PLATFORM_FEES.FLOAT_FEE_MO, the figure the FlexPay terms quote.
 */
export const FLEXPAY_MONTHLY_FEE = PLATFORM_FEES.FLOAT_FEE_MO
export const FLEXPAY_MAX_PULL_DAY = 28       // SSDI 4th-Wednesday cap
/** Rejoin wait after a terminal failure. One source: the FlexPay terms. */
export const FLEXPAY_NSF_COOLDOWN_DAYS = FLEXPAY_REJOIN_WAIT_DAYS
// S578: a returner (one prior default) sheds the queue demotion only after this
// many CONSECUTIVE on-time, first-attempt (zero-retry) pulls in the current
// tenancy. Any retry — even one that then clears — resets the count to 0.
export const FLEXPAY_REHAB_CLEAN_PULLS = 12
/**
 * The fee GAM is charged when a bank sends a FlexPay pull back, passed to the
 * tenant at cost with no markup (FlexPay terms § 4.2). One source: the terms.
 */
export const FLEXPAY_ACH_RETURN_FEE = FLEXPAY_RETURNED_PULL_FEE
export const FLEXPAY_DEFAULT_GRACE_DAYS = 5  // when lease.late_fee_grace_days is NULL (same as lateFees.ts)
/** Runs that may fail to create the pull intent before the advance is defaulted. */
export const FLEXPAY_MAX_PULL_CREATE_ATTEMPTS = 3
/**
 * A cover the 3 am run did not make on the bill's last grace day (the server
 * was down, the run failed for that tenant) is made by the next runs, up to
 * this many days after that day. Past it, paying the bill is no longer
 * "on time" in any sense, and an admin has long been told.
 */
export const FLEXPAY_COVER_CATCHUP_DAYS = 3

/**
 * Why an advance was written off (flexpay_advances.default_reason). Plain
 * strings, read only by admins; all are written by this file.
 */
export const FLEXPAY_DEFAULT_REASONS = {
  /** The pull's last try failed: the last retry, or a closed account (never retried). */
  pullNotCollected: 'pull_not_collected',
  /**
   * Step 10 (decisions #37.D, terms §4.3 "Bank payments stopped"): the pull
   * could not be made because of the TENANT's bank — bank payments stopped
   * after a returned payment, or no verified bank account on file. Treated as
   * the last try failing: the tenant's mark (rejoin wait; a second ends
   * FlexPay for good).
   */
  bankUnavailable: 'bank_unavailable',
  /** History only (before Step 10): GAM could not even ask the bank. Never written now. */
  pullNotCreated: 'pull_not_created',
  /** History only (before Step 10): GAM itself ended the pull. Never written now. */
  pullCanceledByGam: 'pull_canceled_by_gam',
} as const

/**
 * Step 10 — THE ONE RULE for whose a FlexPay collection failure is (decisions
 * #36.D / #37.D, FlexPay terms v2.1 §4.3), so it is easy to read and to change:
 *   - 'tenant': the tenant's bank said no on the last try (a returned debit, a
 *     closed account, a debit taken back), bank payments are stopped on the
 *     tenant after a returned payment, or there is no verified bank on file.
 *     FlexPay ends; the 90-day rejoin wait applies; joining again also needs
 *     what FlexPay paid + that month's fee collected (getFlexPayEligibility);
 *     a second time ends FlexPay for good.
 *   - 'gam': anything GAM caused — GAM canceled the pull, could not re-price or
 *     send a retry, Stripe refused GAM's request, or the bank's reason could
 *     not be read. NOTHING is held against the tenant: FlexPay does not end,
 *     no wait starts, and GAM makes the collection again once the problem is
 *     fixed (the advance goes back to waiting on its pull, which the daily
 *     pull run makes); an admin is told to fix it. A GAM-side problem that
 *     kept FlexPay from paying a covered line on time has GAM pay the late fee
 *     it caused (coverOneCycle).
 */
export type FlexPayFailureSide = 'tenant' | 'gam'

/** The stamp on a pull row made again after a GAM-side failure (payments.return_reason). */
export const FLEXPAY_PULL_REQUEUED_REASON = 'FlexPay collection made again after a problem on GAM\'s side'

/**
 * Times one advance's collection is made again after a problem on GAM's side
 * (requeueGamSidePull) before it is held for a person instead: a problem that
 * keeps coming back is GAM's to fix, never a daily pull.
 */
export const FLEXPAY_MAX_GAM_SIDE_REQUEUES = 3
/** The advance note each time its collection is made again (requeueGamSidePull counts them). */
export const FLEXPAY_REQUEUE_NOTE_MARK = 'Collection to be made again'
/** The advance note when a person released a held collection (releaseHeldFlexPayCollection). */
const FLEXPAY_RELEASED_NOTE_MARK = 'Held collection released by a person'
/** The advance note when its collection is held for a person (requeueGamSidePull). */
export const FLEXPAY_HELD_NOTE = 'Collection held for a person: it failed on GAM\'s side too many times; fix the cause, then make it again.'

/** Write-offs GAM caused: never the tenant's mark (no ban, no returner, no rejoin wait). */
const GAM_SIDE_DEFAULT_REASONS: readonly string[] = [
  FLEXPAY_DEFAULT_REASONS.pullNotCreated, FLEXPAY_DEFAULT_REASONS.pullCanceledByGam,
]

/**
 * A write-off that counts against the tenant (S578: the first makes them a
 * returner, the second ends FlexPay for good): any advance written off, for
 * life — recovered later by GAM-first routing or not (recovery flips the
 * status to 'reconciled' but the write-off happened) — EXCEPT one GAM caused:
 * a pull GAM could not even create ('pull_not_created': no Stripe customer,
 * no verified bank, Stripe refusing the request) or one GAM itself ended
 * ('pull_canceled_by_gam'). Those are never the tenant's mark. A write-off
 * from before reasons were recorded (NULL) counts. `a` is a table alias
 * written in this codebase.
 */
export function flexPayCountedDefaultSql(a = 'fa'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`flexPayCountedDefaultSql: "${a}" is not a table alias`)
  const gamSide = GAM_SIDE_DEFAULT_REASONS.map(r => `'${r}'`).join(', ')
  return `((${a}.status = 'defaulted' OR ${a}.defaulted_at IS NOT NULL)
           AND (${a}.default_reason IS NULL OR ${a}.default_reason NOT IN (${gamSide})))`
}

/**
 * THE ONE RULE for "a second time ends FlexPay for good" (FlexPay terms v2.1
 * §4.3 "Waiting period": after FlexPay ends under any paragraph of §4.3 — the
 * last try failing, a collection taken back, or bank payments stopped / no
 * verified bank — "if it happens a second time, FlexPay ends for good"), on a
 * tenants alias, read BEFORE the ending at hand is written (in an UPDATE's
 * SET it reads the row as it was). True when FlexPay already ended for the
 * tenant before:
 *   - a counted write-off (flexPayCountedDefaultSql) other than the one at
 *     hand (`writeOffsAtHand`: 1 when the ending is a write-off already
 *     flipped, else 0) — S578's count, kept as it was;
 *   - or an EARLIER enrollment ended under §4.3 without a write-off (bank
 *     payments stopped, no verified bank): every such ending writes a rejoin
 *     wait (flexpay_disqualified_until), nothing clears it, and joining again
 *     needs it passed — so a wait that had ended by the time the tenant
 *     joined (until <= flexpay_enrolled_at) is an ending of an earlier
 *     enrollment. An ending inside the same enrollment (bank payments stopped,
 *     then that month's collection written off) sets a wait later than the
 *     joining day, so it is the same ending, never a second;
 *   - or the tenant is already banned.
 * A GAM-side failure never writes a wait or a counted write-off, so it never
 * counts (decisions #37.D).
 */
export function earlierFlexPayEndingSql(t: string, writeOffsAtHand: 0 | 1): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(t)) throw new Error(`earlierFlexPayEndingSql: "${t}" is not a table alias`)
  return `(${t}.flexpay_permanently_banned
           OR (${t}.flexpay_enrolled_at IS NOT NULL AND ${t}.flexpay_disqualified_until IS NOT NULL
               AND ${t}.flexpay_disqualified_until <= ${t}.flexpay_enrolled_at)
           OR (SELECT COUNT(*) FROM flexpay_advances fa_e
                WHERE fa_e.tenant_id = ${t}.id AND ${flexPayCountedDefaultSql('fa_e')}) > ${writeOffsAtHand})`
}

/** What a FlexPay-paid bill line says in the landlord's view: never "FlexPay". */
const COVER_NOTE_ON_TIME = 'Paid on time'
/** The same for a cover made after the last grace day (a missed run caught up). */
const COVER_NOTE_LATE = 'Paid'

const FORBIDDEN_DAY_REASON =
  'Pick a pull day from the 6th through the 28th. The 1st through the 5th are not offered.'

/**
 * FlexPay monthly subscription fee — FLAT $25 regardless of pull day (S562).
 * `pullDay` is still validated (1..28, a real scheduling choice), but the
 * price never depends on it.
 */
export function calculateFlexPayFee(pullDay: number): number {
  if (!Number.isInteger(pullDay) || pullDay < 1 || pullDay > FLEXPAY_MAX_PULL_DAY) {
    throw new Error(`pullDay must be an integer 1..${FLEXPAY_MAX_PULL_DAY}`)
  }
  return FLEXPAY_MONTHLY_FEE
}

/**
 * Nic (10/2): no FlexPay pull on the 1st through the 5th. A day a tenant may
 * choose: an integer 6..28.
 */
export function isAllowedFlexPayPullDay(pullDay: number): boolean {
  return Number.isInteger(pullDay)
    && pullDay >= 1 && pullDay <= FLEXPAY_MAX_PULL_DAY
    && !(FLEXPAY_FORBIDDEN_PULL_DAYS as readonly number[]).includes(pullDay)
}

/**
 * The pull date for a cycle: the first date ON OR AFTER the cover day whose
 * day of month is the tenant's pull day. Dates are plain calendar days
 * ('YYYY-MM-DD', the property's calendar). A pull day stored before the 1st-5th
 * rule existed is moved to the 6th, so no pull ever lands on a forbidden day.
 */
export function flexPayPullDateFor(coverDay: string, pullDay: number): string {
  const day = (FLEXPAY_FORBIDDEN_PULL_DAYS as readonly number[]).includes(pullDay)
    ? Math.max(...FLEXPAY_FORBIDDEN_PULL_DAYS) + 1
    : Math.min(Math.max(Math.trunc(pullDay), 1), FLEXPAY_MAX_PULL_DAY)
  const [y, m, d] = coverDay.slice(0, 10).split('-').map(Number)
  const sameMonth = new Date(Date.UTC(y, m - 1, day))
  const date = day >= d ? sameMonth : new Date(Date.UTC(y, m, day))
  return date.toISOString().slice(0, 10)
}

/**
 * Platform-level + tenant-level visibility check. Mirrors the OTP
 * shape so admin tooling can flip the rollout flag consistently.
 * Returns false when the flag is off — callers should treat that
 * as "feature hidden / closed".
 */
export async function isFlexPayVisible(): Promise<boolean> {
  return isFeatureEnabled('flexpay_rollout_visible')
}

// S544 (Nic): pre-launch SURVEY MODE. Visible but not launched —
// the tenant portal shows "coming soon" + an interest survey, no
// enrollment promises. Enrollment stays closed regardless of
// approval status until this flips ON at launch.
export async function isFlexPayEnrollmentOpen(): Promise<boolean> {
  return isFeatureEnabled('flexpay_enrollment_open')
}

// ── The single-lease rule ────────────────────────────────────────

/**
 * S581 (Nic): FlexPay is a SINGLE-LEASE product — one pull day, one fee, one
 * advance per (cycle, tenant). This is the set of leases that count: the
 * tenant's active lease_tenants rows on active or pending leases, EXCEPT a new
 * lease of their own home waiting to take over (S655, 10/2: a landlord-signed
 * successor whose supersedes_lease_id is another live lease of the same
 * tenant). That is the same tenancy, not a second lease, so it never pauses
 * FlexPay. The same rule as routes/tenants.ts flexpay_paused_multi_lease.
 *
 * `tenantRef` is a placeholder or a column written in this file, never input.
 */
function flexPayCountedLeasesSql(tenantRef: '$1' | 't.id'): string {
  return `
    SELECT l2.id
      FROM lease_tenants lt2
      JOIN leases l2 ON l2.id = lt2.lease_id
     WHERE lt2.tenant_id = ${tenantRef}
       AND lt2.status = 'active'
       AND l2.status IN ('active', 'pending')
       AND NOT EXISTS (
         SELECT 1 FROM lease_tenants lt3 JOIN leases l3 ON l3.id = lt3.lease_id
          WHERE l3.id = l2.supersedes_lease_id AND lt3.tenant_id = ${tenantRef}
            AND lt3.status = 'active' AND l3.status IN ('active', 'pending'))`
}

// ── Eligibility ─────────────────────────────────────────────────

export const FLEXPAY_BLOCKERS = [
  'ach_unverified',
  'bank_payments_stopped',
  'write_off_not_recovered',
  'tenant_suspended_nsf',
  'no_active_lease',
  'multiple_leases',
  'tenant_not_found',
  'flex_deposit_active',
  'not_ssi_ssdi',
  'permanently_banned',
] as const
export type FlexPayBlocker = typeof FLEXPAY_BLOCKERS[number]

export interface FlexPayEligibility {
  eligible: boolean
  blockers: FlexPayBlocker[]
  suspended_until: string | null
}

/**
 * Why a tenant cannot join FlexPay, in plain words (never an enum). The rejoin
 * wait names its day (flexPayBlockerReasons). No "owe", "repay" or "loan"
 * (S304): money still open with GAM "is taken from your next payment through
 * GAM" (GAM-first routing).
 */
export const FLEXPAY_BLOCKER_LABEL: Record<FlexPayBlocker, string> = {
  ach_unverified:          'FlexPay needs a verified bank account. Verify your bank account on the Payments page first.',
  bank_payments_stopped:   'Bank payments are stopped on your account after a bank payment was returned, so FlexPay cannot collect from your bank. Contact GAM support.',
  write_off_not_recovered: 'A FlexPay payment from an earlier month is still open with GAM. It is taken from the next payment you make through GAM, and you can join FlexPay again after that.',
  tenant_suspended_nsf:    'GAM could not collect a FlexPay payment from your bank, so you cannot join FlexPay again yet.',
  no_active_lease:         'FlexPay needs a current lease on your account.',
  multiple_leases:         'FlexPay covers a single lease. Because you currently hold more than one lease, FlexPay isn’t available on your account.',
  tenant_not_found:        'We could not find your account. Contact GAM support.',
  flex_deposit_active:     'FlexPay opens once your FlexDeposit plan is complete.',
  not_ssi_ssdi:            'FlexPay is available only to SSI or SSDI recipients with verified income.',
  permanently_banned:      'FlexPay is no longer available on your account: GAM could not collect a FlexPay payment twice.',
}

/** The sentences for an ineligible tenant, in blocker order; the rejoin wait names its day. */
export function flexPayBlockerReasons(elig: Pick<FlexPayEligibility, 'blockers' | 'suspended_until'>): string[] {
  return elig.blockers.map(b =>
    b === 'tenant_suspended_nsf' && elig.suspended_until
      ? `GAM could not collect a FlexPay payment from your bank, so you can join FlexPay again on ${sayInstant(elig.suspended_until)}.`
      : FLEXPAY_BLOCKER_LABEL[b])
}

/**
 * Eligibility check for enrolling a tenant in FlexPay. Per the S512 product
 * spec: SSDI/SSI recipients only, ACH verified, one lease, not in the
 * post-failure rejoin wait, and — when the tenant is funding their deposit via
 * FlexDeposit — that plan must be FUNDED first.
 *
 * Two more, so GAM's float is never fronted again before it can be collected:
 * bank payments stopped on the tenant (tenants.ach_suspended_at, the NACHA
 * block, which no pull may cross), and a FlexPay advance written off and not
 * recovered yet (status 'defaulted', whichever side caused it). Without them a
 * tenant whose pull could not be made rejoined at once and was fronted again.
 *
 * The deposit gate is SPECIFIC to FlexDeposit (an in-flight installment
 * plan, below). FlexPay does NOT gate on generic security_deposits funded
 * status: landlords onboarding to GAM bring tenants with deposits already
 * paid off-platform, whose imported rows can read "unfunded" — those must
 * not block FlexPay (Nic 2026-06-27).
 *
 * S310/S514: the FlexDeposit-active blocker = Consumer ToS § 9.1.4(i)
 * cross-product lever; clears once the plan completes (custody model
 * plan_status is 'active' | 'completed').
 */
export async function getFlexPayEligibility(tenantId: string): Promise<FlexPayEligibility> {
  const row = await queryOne<{
    ach_verified: boolean
    ach_suspended_at: string | null
    ssi_ssdi: boolean
    flexpay_disqualified_until: string | null
    flexpay_permanently_banned: boolean
    write_off_open: boolean
  }>(
    `SELECT t.ach_verified, t.ach_suspended_at, t.ssi_ssdi, t.flexpay_disqualified_until, t.flexpay_permanently_banned,
            EXISTS (SELECT 1 FROM flexpay_advances fa
                     WHERE fa.tenant_id = t.id AND fa.status = 'defaulted') AS write_off_open
       FROM tenants t
      WHERE t.id = $1`,
    [tenantId],
  )
  if (!row) return { eligible: false, blockers: ['tenant_not_found'], suspended_until: null }

  const blockers: FlexPayEligibility['blockers'] = []
  let suspendedUntil: string | null = null

  // S578: 2nd lifetime default is terminal — no cooldown clears it.
  if (row.flexpay_permanently_banned) blockers.push('permanently_banned')
  if (!row.ach_verified) blockers.push('ach_unverified')
  // M7: ach_verified now means only "has a verified bank"; the NACHA block
  // lives in its own column, and pullOne refuses to pull across it.
  if (row.ach_suspended_at) blockers.push('bank_payments_stopped')
  // Money GAM fronted and has not collected yet: never fronted again first.
  if (row.write_off_open) blockers.push('write_off_not_recovered')
  // S512: FlexPay is an SSDI/SSI service tier (income verified at onboarding,
  // not a credit decision). Same field/gate FlexDeposit uses (tenants.ssi_ssdi).
  if (!row.ssi_ssdi) blockers.push('not_ssi_ssdi')
  if (row.flexpay_disqualified_until) {
    const until = new Date(row.flexpay_disqualified_until)
    if (until.getTime() > Date.now()) {
      blockers.push('tenant_suspended_nsf')
      suspendedUntil = row.flexpay_disqualified_until
    }
  }

  // S310: FlexDeposit-active gate. A tenant funding their deposit over an
  // in-flight FlexDeposit installment plan can't also enroll in FlexPay until
  // it completes. (S514 custody model: plan_status is 'active' | 'completed'.)
  const activeDepositPlan = await queryOne<{ id: string }>(
    `SELECT id
       FROM security_deposits
      WHERE tenant_id = $1
        AND flex_deposit_enabled = TRUE
        AND flex_deposit_plan_status = 'active'
      LIMIT 1`,
    [tenantId],
  )
  if (activeDepositPlan) blockers.push('flex_deposit_active')

  // S581 (Nic): single-lease only — see flexPayCountedLeasesSql. Gated here so
  // the enrollment path and the eligibility/inquiry UI both refuse, and the
  // cover (coverFlexPayCycle) applies the identical count, so a tenant who
  // takes a second lease is paused, and resumes on dropping back to one.
  const leaseCount = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (${flexPayCountedLeasesSql('$1')}) counted`,
    [tenantId],
  )
  const activeLeases = Number(leaseCount?.n ?? 0)
  if (activeLeases === 0) blockers.push('no_active_lease')
  else if (activeLeases > 1) blockers.push('multiple_leases')

  return { eligible: blockers.length === 0, blockers, suspended_until: suspendedUntil }
}

// ── Enrollment ──────────────────────────────────────────────────

/** What a tenant's autopay card says once FlexPay switched it off. */
export const FLEXPAY_AUTOPAY_OFF_REASON =
  'You joined FlexPay, which pays your monthly bill, so autopay was turned off.'

export async function enrollFlexPay(args: {
  tenantId:       string
  userId:         string
  pullDay:        number
  acceptedTerms:  boolean
  ip:             string | null
  userAgent:      string | null
}): Promise<{ ok: true; fee: number; acceptanceId: string } | { ok: false; reason: string }> {
  const visible = await isFlexPayVisible()
  if (!visible) return { ok: false, reason: 'FlexPay is not enabled on this platform' }

  // S314: acceptance gate. The tenant must affirmatively accept the
  // populated FlexPay Subscription Terms before this enrolls them.
  // The audit row stores the snapshot of what they saw.
  if (args.acceptedTerms !== true) {
    return { ok: false, reason: 'FlexPay Subscription Terms acceptance required' }
  }

  // S544 (Nic): survey mode — until launch, nobody enrolls, no
  // matter their approval status. The survey/inquiry data still
  // collects; this is the launch switch.
  if (!(await isFlexPayEnrollmentOpen())) {
    return { ok: false, reason: 'FlexPay hasn’t launched yet — your interest is recorded and we’ll announce availability' }
  }

  // S541 (Nic): demand-test gate — checked BEFORE eligibility so a
  // pending tenant sees "under review", not an eligibility blocker
  // (their ssi_ssdi flag is set by the approval itself). Every
  // enrollment is GAM float (the cover pays the bill each cycle), so
  // initial rollout is approval-gated: the tenant inquires, GAM
  // reviews the lease + verifies SSI/SSDI income, and only an
  // APPROVED inquiry unlocks enrollment. Enforced here — the tenant
  // UI is not the gate.
  const inquiry = await queryOne<{ status: string }>(
    `SELECT status FROM flexpay_inquiries WHERE tenant_id = $1`,
    [args.tenantId],
  )
  if (!inquiry || inquiry.status !== 'approved') {
    return {
      ok: false,
      reason: inquiry?.status === 'pending'
        ? 'Your FlexPay request is still under review — we’ll reach out soon'
        : 'FlexPay enrollment requires an approved request — tap "I’m interested" first',
    }
  }

  // Nic (10/2): a day from the 6th through the 28th, never the 1st-5th
  // (FLEXPAY_FORBIDDEN_PULL_DAYS). Checked after the launch switch and the
  // approval, so a tenant who cannot enroll yet is told that first, and the
  // day is the one thing an approved tenant can fix at once.
  if (!isAllowedFlexPayPullDay(args.pullDay)) {
    return { ok: false, reason: FORBIDDEN_DAY_REASON }
  }

  const elig = await getFlexPayEligibility(args.tenantId)
  if (!elig.eligible) {
    // Every reason in plain words, never a raw enum (the tenant app shows
    // this text as it is).
    return { ok: false, reason: flexPayBlockerReasons(elig).join(' ') }
  }

  const fee = calculateFlexPayFee(args.pullDay)

  // Render the populated Subscription Terms BEFORE opening the tx so
  // any data-lookup failure aborts early without holding row locks.
  const { renderedText, populatedContent } = await renderFlexPayAcceptanceText({
    tenantId:  args.tenantId,
    userId:    args.userId,
    pullDay:   args.pullDay,
    fee,
    ip:        args.ip,
    userAgent: args.userAgent,
  })

  const client = await getClient()
  try {
    await client.query('BEGIN')

    const acceptanceId = await recordAcceptance({
      client,
      tenantId:         args.tenantId,
      userId:           args.userId,
      productType:      'flexpay',
      templateVersion:  FLEXPAY_TEMPLATE_VERSION,
      populatedContent,
      renderedText,
      ip:               args.ip,
      userAgent:        args.userAgent,
    })

    // Step 10: the eligibility read above happened before this transaction, so
    // the enrollment itself re-checks, in the one statement that enrolls, what
    // could have changed since (a bank removed, bank payments stopped, a pull
    // written off, the rejoin wait, a second enrollment in another tab):
    // decisions #36.D — joining again needs (a) the wait over AND (b) nothing
    // FlexPay paid still open with GAM. Nothing enrolls unless all still hold.
    const enrolled = await client.query(
      `UPDATE tenants
          SET flexpay_enrolled     = TRUE,
              flexpay_pull_day     = $1,
              flexpay_monthly_fee  = $2,
              flexpay_enrolled_at  = NOW(),
              -- S578: a new tenancy starts the rehab clock over. A returner
              -- (prior default) must earn all 12 clean pulls fresh; their
              -- flexpay_returner_cleared flag persists from any prior clearance.
              flexpay_clean_streak = 0,
              updated_at           = NOW()
        WHERE id = $3
          AND flexpay_enrolled = FALSE
          AND ach_verified = TRUE
          AND ach_suspended_at IS NULL
          AND flexpay_permanently_banned = FALSE
          AND (flexpay_disqualified_until IS NULL OR flexpay_disqualified_until <= NOW())
          AND NOT EXISTS (SELECT 1 FROM flexpay_advances fa
                           WHERE fa.tenant_id = tenants.id AND fa.status = 'defaulted')`,
      [args.pullDay, fee, args.tenantId],
    )
    if ((enrolled.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK')
      const already = await queryOne<{ e: boolean }>(`SELECT flexpay_enrolled AS e FROM tenants WHERE id = $1`, [args.tenantId])
      if (already?.e) return { ok: false, reason: 'You are already on FlexPay.' }
      const now = await getFlexPayEligibility(args.tenantId)
      return { ok: false, reason: now.eligible
        ? 'Something on your account changed while you were joining. Please try again.'
        : flexPayBlockerReasons(now).join(' ') }
    }

    // S655 (FlexPay terms "Autopay is turned off"): FlexPay pays the bill on
    // the last grace day and GAM collects on the pull day, so an autopay pull
    // as well would take the same bill twice. Every autopay schedule the
    // tenant has is switched off, saying why, in the same transaction.
    await client.query(
      `UPDATE tenant_autopay
          SET enabled = FALSE, disarmed_at = NOW(), disarmed_reason = $2, updated_at = NOW()
        WHERE tenant_id = $1 AND enabled = TRUE`,
      [args.tenantId, FLEXPAY_AUTOPAY_OFF_REASON],
    )

    await client.query('COMMIT')

    // S322: post-commit, best-effort enrollment-confirmation email with
    // attached populated Subscription Terms PDF. Errors log but never
    // throw — the enrollment has already succeeded; email is durability
    // bonus, not load-bearing.
    fireFlexsuiteAcceptanceEmail({
      tenantId:        args.tenantId,
      product:         'flexpay',
      acceptanceId,
      templateVersion: FLEXPAY_TEMPLATE_VERSION,
      renderedText,
    }).catch(err => logger.error({ err, ctx: acceptanceId }, '[flexpay] enrollment email failed'))

    return { ok: true, fee, acceptanceId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function cancelFlexPay(tenantId: string): Promise<void> {
  await query(
    `UPDATE tenants
        SET flexpay_enrolled    = FALSE,
            flexpay_pull_day    = NULL,
            flexpay_monthly_fee = NULL,
            updated_at          = NOW()
      WHERE id = $1`,
    [tenantId],
  )
}

export interface ChangePullDayResult {
  ok: boolean
  reason?: string
  pullDay?: number
  fee?: number
  effective?: 'next_cycle'
}

/**
 * Change an enrolled tenant's FlexPay pull day. Takes effect NEXT cycle (Nic
 * 2026-06-27): a cycle that was already covered keeps the pull date it was
 * given (flexpay_advances.pull_date), so this never disturbs or lets a tenant
 * dodge an in-flight pull — it only changes the date the NEXT cover sets. The
 * fee is a FLAT $25 regardless of day (S562), so changing the day never
 * changes the price. The 1st-5th are refused (Nic 10/2).
 */
export async function changeFlexPayPullDay(tenantId: string, newPullDay: number): Promise<ChangePullDayResult> {
  if (!await isFlexPayVisible()) return { ok: false, reason: 'FlexPay is not enabled on this platform' }
  // Validates the 1..28 integer range (throws otherwise) and gives the new fee.
  let fee: number
  try { fee = calculateFlexPayFee(newPullDay) }
  catch (e: any) { return { ok: false, reason: e?.message ?? 'Invalid pull day' } }
  if (!isAllowedFlexPayPullDay(newPullDay)) return { ok: false, reason: FORBIDDEN_DAY_REASON }

  const updated = await query<{ id: string }>(
    `UPDATE tenants
        SET flexpay_pull_day    = $2,
            flexpay_monthly_fee = $3,
            updated_at          = NOW()
      WHERE id = $1 AND flexpay_enrolled = TRUE
      RETURNING id`,
    [tenantId, newPullDay, fee],
  )
  if (updated.length === 0) return { ok: false, reason: 'Not enrolled in FlexPay' }
  return { ok: true, pullDay: newPullDay, fee, effective: 'next_cycle' }
}

// ── The cover: FlexPay pays the monthly bill on the last grace day ──

export interface CoverResult {
  /** GAM's month (Phoenix) for the run summary; each advance takes its own property's. */
  cycle_month:               string
  /** Enrolled tenants whose bill reaches its last grace day today, or passed it uncovered (catch-up). */
  candidates_scanned:        number
  /** Advances that paid open bill lines. */
  bills_covered:             number
  /** Advances for a month already paid: $0 covered, the $25 still taken. */
  paid_already:              number
  advances_skipped_existing: number
  /**
   * FlexPay ended instead of paying: bank payments are stopped on the tenant
   * (the NACHA block), so GAM could never collect what it paid.
   */
  ended_bank_stopped:        number
  /**
   * Bills whose catch-up window closed today with FlexPay never having paid
   * them (a problem on GAM's side): each told to an admin (alertMissedCovers).
   */
  missed_covers:             number
  /** Dollars of bill lines FlexPay paid this run. */
  amount_covered:            number
  errors:                    number
}

interface CoverCandidate {
  tenant_id:      string
  pull_day:       number
  invoice_id:     string
  due_date:       string
  lease_id:       string
  landlord_id:    string
  unit_id:        string
  timezone:       string
  today_local:    string
  /** due + grace − 1: the day the cover belongs to. Before today_local = a catch-up. */
  last_grace_day: string
}

/**
 * Daily, 3 am Phoenix: for every FlexPay tenant whose cycle invoice reaches its
 * LAST GRACE DAY today (due + grace − 1, the property's calendar, before the
 * late-fee engine's midnight run), pay that bill (see the header). One advance
 * per (cycle, tenant): UNIQUE(cycle_month, tenant_id) plus the household lock
 * make a re-run a no-op. A second bill in the month is paid under that advance
 * while its pull is not written yet; after that an admin is told.
 *
 * Catch-up: a bill whose last grace day passed in the last
 * FLEXPAY_COVER_CATCHUP_DAYS days with no advance made for its cycle — the run
 * that day never happened or failed for this tenant — is covered now, for a
 * tenant who was already enrolled before that day began (one who joined later
 * was never promised that bill). The cover is the same; only its words change
 * (it was not on time) and an admin is told, with any late fee charged
 * meanwhile.
 *
 * A paused tenant (more than one lease, flexPayCountedLeasesSql) gets nothing:
 * no cover and no $25.
 */
export async function coverFlexPayCycle(now: Date = new Date()): Promise<CoverResult> {
  const out: CoverResult = {
    cycle_month:               monthStartOf(dateIn(null, now)),
    candidates_scanned:        0,
    bills_covered:             0,
    paid_already:              0,
    advances_skipped_existing: 0,
    ended_bank_stopped:        0,
    missed_covers:             0,
    amount_covered:            0,
    errors:                    0,
  }
  if (!(await isFlexPayVisible())) return out

  // Grace is the late-fee engine's own: COALESCE(lease grace, 5). The opening
  // balance invoice of a landlord's old system is not a monthly bill.
  const rows = await query<CoverCandidate>(
    `SELECT t.id AS tenant_id, t.flexpay_pull_day AS pull_day,
            i.id AS invoice_id, i.due_date::text AS due_date,
            l.id AS lease_id, l.landlord_id, l.unit_id,
            COALESCE(p.timezone, 'America/Phoenix') AS timezone,
            day.today_local::text AS today_local,
            day.last_grace_day::text AS last_grace_day
       FROM tenants t
       JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
       JOIN leases l         ON l.id = lt.lease_id AND l.status IN ('active', 'pending')
       JOIN invoices i       ON i.lease_id = l.id AND i.status <> 'void' AND i.is_opening_balance = FALSE
       JOIN units u          ON u.id = l.unit_id
       JOIN properties p     ON p.id = u.property_id
       CROSS JOIN LATERAL (
         SELECT ($2::timestamptz AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date AS today_local,
                (i.due_date + COALESCE(l.late_fee_grace_days, $1) - 1)::date AS last_grace_day
       ) day
      WHERE t.flexpay_enrolled = TRUE
        AND t.flexpay_pull_day IS NOT NULL
        AND day.last_grace_day BETWEEN day.today_local - $3::int AND day.today_local
        AND (day.last_grace_day = day.today_local
             OR (-- A catch-up: enrolled before that day began, and nothing made
                 -- for this bill yet — no advance for the cycle, or (a second
                 -- bill that month) an advance still waiting on its pull that
                 -- never touched this invoice.
                 ${promisedAndUncoveredSql('t', 'i', 'p', 'day.last_grace_day')}))
        AND (SELECT COUNT(*) FROM (${flexPayCountedLeasesSql('t.id')}) counted) = 1
      ORDER BY t.id, i.due_date, i.id`,
    [FLEXPAY_DEFAULT_GRACE_DAYS, now, FLEXPAY_COVER_CATCHUP_DAYS],
  )

  // One advance per (tenant, cycle): a tenant whose current and new lease both
  // bill on the same day has both invoices covered under it.
  const groups = new Map<string, CoverCandidate[]>()
  for (const r of rows) {
    const key = `${r.tenant_id}:${monthStartOf(r.due_date)}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  out.candidates_scanned = groups.size

  for (const group of groups.values()) {
    try {
      const r = await coverOneCycle(group)
      if (r.outcome === 'existing') out.advances_skipped_existing += 1
      else if (r.outcome === 'covered') { out.bills_covered += 1; out.amount_covered = round2(out.amount_covered + r.covered) }
      else if (r.outcome === 'paid_already') out.paid_already += 1
      else if (r.outcome === 'bank_stopped') out.ended_bank_stopped += 1
    } catch (e) {
      out.errors += 1
      const head = group[0]
      logger.error({ err: e, tenant_id: head.tenant_id, invoice_id: head.invoice_id }, '[flexpay][cover]')
      // Nothing was paid (the transaction rolled back). The next runs try
      // again, but the late fee lands at midnight after the last grace day, so
      // someone must know today.
      await alertAdmin('critical', 'flexpay_cover_failed',
        `FlexPay could not pay a bill (tenant ${head.tenant_id}, due ${head.due_date})`,
        `FlexPay tried to pay the bill due ${head.due_date} (invoice ${head.invoice_id}) and failed: ` +
        `${e instanceof Error ? e.message : String(e)}. Nothing was paid and nothing was charged. ` +
        `The daily run tries again for ${FLEXPAY_COVER_CATCHUP_DAYS} days after the last grace day ` +
        `(${head.last_grace_day}), but the landlord's late fee is charged at midnight after that day. Fix the cause today.`,
        { tenant_id: head.tenant_id, invoice_id: head.invoice_id, last_grace_day: head.last_grace_day })
    }
  }
  out.missed_covers = await alertMissedCovers(now)
  return out
}

/**
 * The catch-up test, on aliases (tenant, invoice, property) and the bill's
 * last grace day: the tenant was enrolled before that day began (one who
 * joined later was never promised the bill), and nothing was made for this
 * bill yet — no advance for its cycle, or (a second bill that month) an
 * advance still waiting on its pull that never touched this invoice.
 */
function promisedAndUncoveredSql(t: string, i: string, p: string, lastGraceDay: string): string {
  return `(${t}.flexpay_enrolled_at IS NULL
           OR ${t}.flexpay_enrolled_at < (${lastGraceDay}::timestamp AT TIME ZONE COALESCE(${p}.timezone, 'America/Phoenix')))
          AND NOT EXISTS (
            SELECT 1 FROM flexpay_advances fa
             WHERE fa.tenant_id = ${t}.id
               AND fa.cycle_month = date_trunc('month', ${i}.due_date)::date
               AND NOT (fa.status = 'fronted'
                        AND fa.rent_payment_id IS NULL
                        AND fa.invoice_id IS DISTINCT FROM ${i}.id
                        AND NOT EXISTS (SELECT 1 FROM payments fp
                                         WHERE fp.flexpay_advance_id = fa.id
                                           AND (fp.entry_description = 'FLEXPAY' OR fp.invoice_id = ${i}.id))))`
}

/**
 * Step 10 (decisions #37.D): the day a bill's catch-up window closes
 * (FLEXPAY_COVER_CATCHUP_DAYS after its last grace day) with the bill still
 * not paid by FlexPay — for a tenant still enrolled, promised it (the catch-up
 * test) and not paused, with lines open that the cover pays — the cover
 * failed on GAM's side every day it could run. That is never silent: an
 * admin is told, once (only that day matches), with what is still open and
 * the late fees charged on the bill since its last grace day, which a
 * GAM-side problem caused and GAM pays for the tenant under #37.D. How the
 * bill itself is paid now, and the paying of those late fees (there is no
 * FlexPay advance or card or bank charge to settle them through), wait on a
 * person: nothing is paid or charged here. Returns how many bills it named.
 * Never throws.
 */
async function alertMissedCovers(now: Date): Promise<number> {
  try {
    const missed = await query<{
      tenant_id: string; invoice_id: string; due_date: string; last_grace_day: string; open_lines: string; late_fees: string
    }>(
      `SELECT t.id AS tenant_id, i.id AS invoice_id, i.due_date::text AS due_date,
              day.last_grace_day::text AS last_grace_day,
              (SELECT COALESCE(SUM(cp.amount - ${appliedCreditOnRowSql('cp')}), 0)
                 FROM payments cp WHERE cp.invoice_id = i.id AND ${coverLineSql('cp')})::text AS open_lines,
              (SELECT COALESCE(SUM(lf.amount), 0) FROM payments lf
                WHERE lf.invoice_id = i.id AND lf.type = 'late_fee' AND lf.revenue_owner = 'landlord'
                  AND ${payableRowSql('lf')}
                  AND lf.created_at >= (((day.last_grace_day + 1)::timestamp) AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))
              )::text AS late_fees
         FROM tenants t
         JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
         JOIN leases l         ON l.id = lt.lease_id AND l.status IN ('active', 'pending')
         JOIN invoices i       ON i.lease_id = l.id AND i.status <> 'void' AND i.is_opening_balance = FALSE
         JOIN units u          ON u.id = l.unit_id
         JOIN properties p     ON p.id = u.property_id
         CROSS JOIN LATERAL (
           SELECT ($2::timestamptz AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date AS today_local,
                  (i.due_date + COALESCE(l.late_fee_grace_days, $1) - 1)::date AS last_grace_day
         ) day
        WHERE t.flexpay_enrolled = TRUE
          AND t.flexpay_pull_day IS NOT NULL
          AND day.last_grace_day = day.today_local - ($3::int + 1)
          AND ${promisedAndUncoveredSql('t', 'i', 'p', 'day.last_grace_day')}
          AND (SELECT COUNT(*) FROM (${flexPayCountedLeasesSql('t.id')}) counted) = 1
          AND EXISTS (SELECT 1 FROM payments cp WHERE cp.invoice_id = i.id AND ${coverLineSql('cp')})
        ORDER BY t.id, i.due_date, i.id`,
      [FLEXPAY_DEFAULT_GRACE_DAYS, now, FLEXPAY_COVER_CATCHUP_DAYS])
    for (const m of missed) {
      const open = round2(Number(m.open_lines))
      const lateFees = round2(Number(m.late_fees))
      await alertAdmin('critical', 'flexpay_cover_missed',
        `FlexPay never paid a bill: its catch-up window closed (tenant ${m.tenant_id}, due ${m.due_date})`,
        `FlexPay did not pay the bill due ${m.due_date} (invoice ${m.invoice_id}) by its last grace day (${m.last_grace_day}) or in the ` +
        `${FLEXPAY_COVER_CATCHUP_DAYS} days of catch-up after it, so the problem was on GAM's side. $${open.toFixed(2)} of its lines that FlexPay pays are still open, ` +
        'and the tenant has not been told anything new. ' +
        (lateFees > 0
          ? `$${lateFees.toFixed(2)} of late fees were charged on the bill since the last grace day: a late fee a problem on GAM's side caused is GAM's to pay for the tenant (decisions #37.D), so pay it for them. `
          : 'No late fee has been charged on it. ') +
        'Decide how this bill is paid now. Nothing was paid or charged by this notice.',
        { tenant_id: m.tenant_id, invoice_id: m.invoice_id, last_grace_day: m.last_grace_day, open_lines: open, late_fees: lateFees })
    }
    return missed.length
  } catch (e) {
    logger.error({ err: e }, '[flexpay][cover] missed-cover check failed')
    return 0
  }
}

type CoverOutcome =
  | { outcome: 'covered'; covered: number; advanceId: string }
  | { outcome: 'paid_already'; covered: 0; advanceId: string }
  | { outcome: 'existing' | 'not_enrolled' | 'bank_stopped'; covered: 0; advanceId: null }

/** A line a tenant notice names: what it is, and how much. */
interface DueLine { id: string; label: string; amount: number }

/**
 * Credit already spent on a row (credit_uses 'applied'), on a payments alias:
 * that part of the row is paid, so what is still open on it is amount − this
 * (householdQuote's appliedOnRow, the figure every other payer subtracts).
 */
function appliedCreditOnRowSql(p: string): string {
  return `COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu
                     WHERE cu.payment_id = ${p}.id AND cu.status = 'applied'), 0)`
}

/**
 * The facts a bill line is NAMED by (billLineLabel), on the alias `p`: its
 * notes, entry code and utility type — for a line reopened after a dispute or
 * a bank return (reversal_id), the ORIGINAL row's notes and utility bill (its
 * own note is the reopen marker, never a name). Columns: notes,
 * entry_description, utility_type. Exported so every notice names a line the
 * same way (the webhook's Rent Collected notice, decisions #17).
 */
export const BILL_LINE_NAME_FACTS_SQL = `COALESCE((SELECT o.notes FROM payment_reversals pr JOIN payments o ON o.id = pr.payment_id
                  WHERE pr.id = p.reversal_id), p.notes) AS notes,
       p.entry_description,
       COALESCE((SELECT ub.utility_type FROM utility_bills ub WHERE ub.payment_id = p.id LIMIT 1),
                (SELECT ub.utility_type FROM payment_reversals pr JOIN utility_bills ub ON ub.payment_id = pr.payment_id
                  WHERE pr.id = p.reversal_id LIMIT 1)) AS utility_type`

/**
 * The row facts billLineLabel reads. `amount` is what is still open on the line:
 * its face less credit already spent on it. A line reopened after a dispute or
 * a bank return (reversal_id) is named by the ORIGINAL row its reversal
 * reopened (payment_reversals.payment_id): its utility bill hangs on that row,
 * and its own note is the reopen marker, never a name (Step 10).
 */
const LINE_FACTS_SQL = `p.id, (p.amount - ${appliedCreditOnRowSql('p')})::text AS amount, p.type,
       ${BILL_LINE_NAME_FACTS_SQL}`

type LineFacts = {
  id: string; amount: string; type: string; notes: string | null
  entry_description: string | null; utility_type: string | null
}

const toDueLines = (rows: LineFacts[]): DueLine[] =>
  rows.map(r => ({ id: r.id, label: billLineLabel(r), amount: Number(r.amount) }))

/**
 * The kinds of bill line FlexPay may pay: only those allocation splits into an
 * owner share (ALLOCATABLE_PAYMENT_TYPES), never a late fee — GAM's float must
 * never settle a line the Tuesday batch cannot pay the landlord for (GAM would
 * collect it on the pull day and hold the landlord's money). Being split by
 * allocation is necessary, not enough: coverLineSql also leaves out by name
 * the kinds FlexPay never pays though allocation splits them — a home payment
 * (decisions #35 point 7(e)) and a balance carried from earlier months.
 */
const COVER_LINE_TYPES_SQL = (ALLOCATABLE_PAYMENT_TYPES as readonly string[])
  .filter(t => t !== 'late_fee')
  .map(t => `'${t}'`).join(', ')

/**
 * The bill lines FlexPay pays, on a payments alias: open LANDLORD lines
 * (coverOneCycle explains each exclusion). Never a home payment, whatever
 * allocation splits (decisions #35 point 7(e): a payment toward owning a home
 * is a real-property interest GAM will not hold a claim in). Narrower than
 * what is still the tenant's to pay (tenantOpenLineSql): never use it to tell
 * a tenant a bill has nothing open.
 */
function coverLineSql(p: string): string {
  return `${payableRowSql(p)}
          AND ${p}.revenue_owner = 'landlord'
          AND ${p}.type IN (${COVER_LINE_TYPES_SQL})
          AND ${p}.type NOT IN ('late_fee', 'carried_balance', 'deposit', 'home_payment')
          AND NOT ${depositOrMoveOutRowSql(p)}
          AND ${p}.reversal_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM credit_uses cu
                           WHERE cu.payment_id = ${p}.id AND cu.status IN ('applied', 'reversed'))`
}

/**
 * A bill line still the TENANT's to pay, on a payments alias: unpaid (pending,
 * or failed), money still open on it (> 0 after any credit already spent on
 * it), not covered by work trade, and not FlexPay's own pull. Wider than
 * coverLineSql: a home payment, a security deposit, a line reopened by a
 * dispute, a line credit already paid part of, a late fee and GAM's own fee
 * are all still the tenant's although FlexPay never pays them. A line whose
 * payment is clearing ('processing') is not open. One predicate, so the
 * cover's "Still due on this bill", the second-bill notice and the
 * bank-stopped notice name the same lines.
 */
function tenantOpenLineSql(p: string): string {
  return `${p}.status IN ('pending', 'failed')
          AND ${p}.amount - ${appliedCreditOnRowSql(p)} > 0
          AND ${p}.work_trade_suspended_at IS NULL
          AND ${p}.entry_description IS DISTINCT FROM 'FLEXPAY'`
}

async function coverOneCycle(group: CoverCandidate[]): Promise<CoverOutcome> {
  const head = group[0]
  const cycle = monthStartOf(head.due_date)
  const coverDay = head.today_local
  const invoiceIds = [...new Set(group.map(g => g.invoice_id))]
  // A catch-up (the run on the last grace day did not cover it): the bill is
  // paid all the same, but it was not on time and nobody is told it was.
  const late = group.some(g => g.last_grace_day < g.today_local)
  const lineNote = late ? COVER_NOTE_LATE : COVER_NOTE_ON_TIME

  // Bank payments stopped on the tenant (the NACHA block, tenants.
  // ach_suspended_at), or no verified bank on file (tenants.ach_verified):
  // GAM may never pull them, so paying the bill now would pay with no way to
  // collect. FlexPay terms §4.3 "Bank payments stopped" (decisions #37.D): the
  // tenant's side — FlexPay ends and does not pay this bill, and the 90-day
  // rejoin wait applies (joining again also needs the bank working again,
  // getFlexPayEligibility). One statement, so a second run finds the tenant no
  // longer enrolled. The tenant and an admin are told.
  // A second time ends FlexPay for good (earlierFlexPayEndingSql).
  const stopped = await endFlexPayForStoppedBank(
    (sql, params) => query<any>(sql, params as any[]), head.tenant_id, true)
  if (stopped) {
    const noBank = stopped.noBank
    // The cover's scan includes a bill that is already paid (a paid month
    // still takes the $25), so the tenant is told a bill is theirs to pay only
    // when something on it is still open — every line still the TENANT's to
    // pay (tenantOpenLineSql, the cover's own "Still due" read), not only the
    // lines FlexPay would have paid: a home payment or a disputed line left
    // open is still due, and the late fee can land on it. A line whose
    // payment is clearing is not open.
    const openRows = await query<LineFacts>(
      `SELECT ${LINE_FACTS_SQL}
         FROM payments p
        WHERE p.invoice_id = ANY($1::uuid[])
          AND ${tenantOpenLineSql('p')}
        ORDER BY ${allocationOrderSql('p')}`,
      [invoiceIds])
    const stillDue = toDueLines(openRows)
    const openAmount = round2(stillDue.reduce((s, l) => s + l.amount, 0))
    // The late-fee run charges while a line other than a late fee is unpaid
    // (S537); an open late fee alone takes no further fee.
    const lateFeeCanApply = openRows.some(r => r.type !== 'late_fee')
    const ctx = { tenant_id: head.tenant_id, invoice_ids: invoiceIds, due_date: head.due_date,
                  last_grace_day: head.last_grace_day, open_amount: openAmount,
                  still_due: stillDue.map(l => ({ label: l.label, amount: l.amount })) }
    const why = noBank
      ? `Tenant ${head.tenant_id} has no verified bank account on file, so GAM could not collect anything FlexPay paid. `
      : `Bank payments are stopped on tenant ${head.tenant_id} after a returned bank payment, so GAM could not collect anything FlexPay paid. `
    const rejoin = stopped.permanent
      ? 'FlexPay had already ended for them once before, so this ended it for good: they can never join again.'
      : `They can join again after ${FLEXPAY_NSF_COOLDOWN_DAYS} days, and only once ${noBank ? 'a verified bank is on file' : 'bank payments are working again on their account'}.`
    const ending = stopped.permanent ? 'their FlexPay has ended for good' : `their FlexPay has ended, with the ${FLEXPAY_NSF_COOLDOWN_DAYS}-day rejoin wait`
    if (stillDue.length > 0) {
      await alertAdmin('warn', 'flexpay_ended_bank_stopped',
        `FlexPay did not pay a bill: bank payments are stopped (tenant ${head.tenant_id}, due ${head.due_date})`,
        why +
        `$${openAmount.toFixed(2)} is still open for the tenant to pay on the bill due ${head.due_date} (invoice ${head.invoice_id}): ${sayLines(stillDue)}. ` +
        `FlexPay paid none of it, and ${ending}. ` +
        `The tenant was told what is still due and that it is theirs to pay. ${rejoin}`,
        ctx)
      await notifyTenantFlexPayEnded(head.tenant_id,
        { kind: 'bank_stopped', noBank, bill: { due: head.due_date, pastGrace: late, stillDue, lateFeeCanApply } })
    } else {
      await alertAdmin('warn', 'flexpay_ended_bank_stopped',
        `FlexPay ended: bank payments are stopped (tenant ${head.tenant_id})`,
        why +
        `${ending.charAt(0).toUpperCase()}${ending.slice(1)}. Nothing on the bill due ${head.due_date} (invoice ${head.invoice_id}) is open for the tenant to pay: ` +
        `it is paid, or its payment is still clearing. The tenant was told FlexPay ended. ${rejoin}`,
        ctx)
      await notifyTenantFlexPayEnded(head.tenant_id, { kind: 'bank_stopped', noBank })
    }
    return { outcome: 'bank_stopped', covered: 0, advanceId: null }
  }

  const client = await getClient()
  let advanceId: string | null = null
  let settledIds: string[] = []
  let covered = 0
  /** What the pull collects for the month (the earlier bill's lines included). */
  let collectTotal = 0
  let pullDate = ''
  /** This bill was paid under the month's existing advance (a second bill). */
  let addedToEarlier = false
  let cancelAfterCommit: string[] = []
  /** Open lines left on the bill, and lines a called-off retry carried. */
  let stillDue: DueLine[] = []
  let retryLeftovers: DueLine[] = []
  /** Every non-late-fee line on the bill is settled: the late-fee run has nothing to charge on. */
  let wholeBillSettled = false
  /** Late fees GAM paid for the tenant: charged while a GAM-side delay kept FlexPay from paying on time. */
  let lateFeesPaidByGam: DueLine[] = []
  /** A second bill that came after the month's pull was written: an admin is told. */
  let blocked: { advanceId: string; open: number; reason: string } | null = null
  const allocationMisses: Array<{ id: string; type: string; error: string }> = []
  let after: Awaited<ReturnType<typeof afterRowsSettled>> | null = null
  try {
    await client.query('BEGIN')
    // §3: the household first, then rows by id. A tenant paying the same bill
    // at the same moment waits here, and whichever goes second finds it paid.
    await lockHousehold(client, head.tenant_id, head.landlord_id)

    // Fresh under the lock: the tenant may have left FlexPay since the scan.
    // A block set since the check above: nothing is fronted; the next run ends FlexPay.
    const t = (await client.query<{ flexpay_enrolled: boolean; flexpay_pull_day: number | null; ach_suspended_at: string | null; ach_verified: boolean }>(
      `SELECT flexpay_enrolled, flexpay_pull_day, ach_suspended_at, ach_verified FROM tenants WHERE id = $1 FOR UPDATE`,
      [head.tenant_id])).rows[0]
    if (!t?.flexpay_enrolled || !t.flexpay_pull_day || t.ach_suspended_at || !t.ach_verified) {
      await client.query('ROLLBACK')
      return { outcome: 'not_enrolled', covered: 0, advanceId: null }
    }

    // The whole monthly bill: the cycle invoice's open LANDLORD lines — rent,
    // utilities (a neighbor landlord's on the same invoice included) and fees.
    // Never a late fee already charged or a carried balance (FlexPay terms
    // "covers_the_bill"), never GAM's own rows, and never a row whose money is
    // moving (payableRowSql: a retry already in flight is 'processing'). Never
    // a security deposit or a move-out row either — a renewal's deposit
    // increase, or the deposit on a move-in bill: that money is held in trust
    // for the tenant (it is never the landlord's to be paid and never split by
    // allocation), S512 has the deposit paid before FlexPay, and GAM's float
    // must never sit as a tenant's refundable deposit. A non-refundable pet,
    // key or cleaning "deposit" fee carries its lease fee and is an ordinary
    // fee (depositOrMoveOutRowSql). Never a home payment (decisions #35 point
    // 7(e): a real-property interest GAM will not hold a claim in; coverLineSql
    // leaves it out by name) — and never a
    // line reopened after the tenant disputed its payment (reversal_id): the
    // tenant is disputing that charge, and its re-payment must resolve the
    // reversal, which only the tenant's own payment does (the same rule as
    // credit, moneyPredicates.creditEligibleRowSql). Never a line credit has
    // already paid part of (a credit_uses row 'applied', or 'reversed' when the
    // money behind that credit was disputed): the cover pays a line's whole
    // face, so GAM would pull the credit-paid part from the tenant a second
    // time while allocation pays the landlord only the line's money part, and
    // GAM would keep the difference. All of these stay open, and the tenant's
    // notice names them as still due, at what is still open on each.
    // A failed line waiting on its own scheduled bank retry IS paid: FlexPay
    // pays the bill on time, and the retry is called off below (§3: claiming a
    // failed row supersedes its retry), so the tenant is never pulled for it.
    const pick = async () => (await client.query<{ id: string; amount: string; type: string }>(
      `SELECT p.id, p.amount::text AS amount, p.type
         FROM payments p
        WHERE p.invoice_id = ANY($1::uuid[])
          AND ${coverLineSql('p')}
        ORDER BY ${allocationOrderSql('p')}`,
      [invoiceIds])).rows

    // One advance per (cycle, tenant). A bill that reaches its last grace day
    // after the month's advance was made — the first bill of a landlord-signed
    // new lease that starts mid-month — is paid under that same advance while
    // its pull has not been written (the pull then collects both). Once the
    // pull row exists its amount is fixed, so an admin is told instead of the
    // bill being skipped in silence.
    const existing = (await client.query<{
      id: string; status: string; pull_date: string; has_pull: boolean
    }>(
      `SELECT a.id, a.status,
              COALESCE(a.pull_date, a.cycle_month + (a.pull_day - 1))::text AS pull_date,
              (a.rent_payment_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM payments fp
                           WHERE fp.flexpay_advance_id = a.id AND fp.entry_description = 'FLEXPAY')) AS has_pull
         FROM flexpay_advances a
        WHERE a.cycle_month = $1 AND a.tenant_id = $2
        FOR UPDATE`,
      [cycle, head.tenant_id])).rows[0]
    if (existing && (existing.status !== 'fronted' || existing.has_pull)) {
      const open = await pick()
      await client.query('ROLLBACK')
      if (open.length > 0) {
        blocked = {
          advanceId: existing.id,
          open: round2(open.reduce((s, r) => s + Number(r.amount), 0)),
          reason: existing.has_pull ? 'its pull was already written' : `the advance is already ${existing.status}`,
        }
      }
    } else {
      // OTP coexistence (header): an OTP front this cycle already paid the
      // landlord, so FlexPay pays nothing and only the $25 is taken.
      const otp = await client.query(
        `SELECT 1 FROM otp_advances
          WHERE tenant_id = $1 AND cycle_month = $2 AND stripe_transfer_id IS NOT NULL`,
        [head.tenant_id, cycle])
      const otpFronted = (otp.rowCount ?? 0) > 0

      const seen = otpFronted ? [] : await pick()
      const lockedIds = await lockPaymentRowsById(client, seen.map(r => r.id))
      // Read again now that the rows are held, so what is paid is exactly what is open.
      const lines = lockedIds.length === 0 ? [] : (await pick()).filter(r => lockedIds.includes(r.id))
      covered = round2(lines.reduce((s, r) => s + Number(r.amount), 0))
      const lateNote = late ? ` Made late: the last grace day was ${head.last_grace_day}.` : ''

      if (existing) {
        if (lines.length === 0) {
          // A re-run, or a second bill with nothing open: nothing to do.
          await client.query('ROLLBACK')
          return { outcome: 'existing', covered: 0, advanceId: null }
        }
        advanceId = existing.id
        pullDate = existing.pull_date
        addedToEarlier = true
        const upd = await client.query<{ rent_amount: string }>(
          `UPDATE flexpay_advances
              SET rent_amount = rent_amount + $2,
                  notes = CASE WHEN COALESCE(btrim(notes), '') = '' THEN $3 ELSE notes || ' ' || $3 END,
                  updated_at = NOW()
            WHERE id = $1
            RETURNING rent_amount::text AS rent_amount`,
          [advanceId, covered,
           `Cover ${coverDay}: paid ${lines.length} more bill line(s) from the bill due ${head.due_date}, $${covered.toFixed(2)}.${lateNote}`])
        collectTotal = Number(upd.rows[0].rent_amount)
      } else {
        pullDate = flexPayPullDateFor(coverDay, t.flexpay_pull_day)
        const notes = (otpFronted
          ? `Cover ${coverDay}: OTP already paid the landlord this cycle; only the monthly fee is taken.`
          : lines.length === 0
            ? `Cover ${coverDay}: the bill was already paid; only the monthly fee is taken.`
            : `Cover ${coverDay}: paid ${lines.length} bill line(s), $${covered.toFixed(2)}.`) + lateNote
        const ins = await client.query<{ id: string }>(
          `INSERT INTO flexpay_advances (
             cycle_month, tenant_id, landlord_id, unit_id, lease_id,
             rent_amount, tenant_fee_amount, pull_day, status, fronted_at,
             invoice_id, pull_date, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'fronted', NOW(), $9, $10, $11)
           ON CONFLICT (cycle_month, tenant_id) DO NOTHING
           RETURNING id`,
          [cycle, head.tenant_id, head.landlord_id, head.unit_id, head.lease_id,
           covered, FLEXPAY_MONTHLY_FEE, t.flexpay_pull_day,
           head.invoice_id, pullDate, notes])
        if (ins.rows.length === 0) {
          await client.query('ROLLBACK')
          return { outcome: 'existing', covered: 0, advanceId: null }
        }
        advanceId = ins.rows[0].id
        collectTotal = covered
      }

      if (lines.length > 0) {
        // A line waiting on its own bank retry: the retry is called off before
        // the line is paid — its schedule cleared on every row of that pull, any
        // credit held for it given back (saved credit stays saved), and the old
        // intent canceled after commit — so the tenant is never pulled for a
        // line FlexPay paid.
        cancelAfterCommit = (await supersedeScheduledRetry(client, lines.map(l => l.id))).cancelAfterCommit

        // GAM's float pays these lines: platform_held so the Tuesday batch
        // carries the owner share; "Paid on time" is all the landlord sees.
        // A GAM-first boost stamped on a line by an earlier charge that never
        // arrived (the legacy single-row pay route stamps it when it charges)
        // is cleared: allocation takes the boost out of the landlord's share,
        // and FlexPay paid the line in full, so the landlord is paid in full.
        const settled = await client.query<{ id: string; type: string }>(
          `UPDATE payments p
              SET status = 'settled',
                  settled_at = NOW(),
                  platform_held = TRUE,
                  flexpay_advance_id = $2,
                  gam_supersedence_amount = 0,
                  notes = CASE WHEN COALESCE(btrim(p.notes), '') = '' THEN $3::text
                               ELSE p.notes || ' · ' || $3::text END
            WHERE p.id = ANY($1::uuid[])
              AND ${payableRowSql('p')}
            RETURNING p.id, p.type`,
          [lines.map(l => l.id), advanceId, lineNote])
        if (settled.rows.length !== lines.length) {
          throw new Error(`FlexPay cover stamped ${settled.rows.length} of ${lines.length} bill lines; nothing was paid`)
        }
        settledIds = settled.rows.map(r => r.id).sort()

        // Owner share for each line, with no processing fee (no card or bank
        // was charged). A share that cannot be booked (a property missing its
        // payout setup, or a line kind allocation does not split) must never
        // undo the cover — the tenant would take a late fee for GAM's setup —
        // so it is rolled back alone and an admin is told to book it.
        for (const row of [...settled.rows].sort((a, b) => a.id.localeCompare(b.id))) {
          if (!(ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(row.type)) {
            allocationMisses.push({ id: row.id, type: row.type, error: `allocation does not split '${row.type}' lines` })
            continue
          }
          await client.query('SAVEPOINT flexpay_cover_alloc')
          try {
            await executeRentAllocation(client, row.id, 'ach', { feeAlreadyCollected: true })
            await client.query('RELEASE SAVEPOINT flexpay_cover_alloc')
          } catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT flexpay_cover_alloc')
            allocationMisses.push({ id: row.id, type: row.type, error: e instanceof Error ? e.message : String(e) })
          }
        }

        after = await afterRowsSettled(client, settledIds, {
          attestationSource:   'gam_workflow_auto',
          attestationEvidence: { flexpay_advance_id: advanceId },
          // The tenant hears about it below, in words true to what happened; a
          // "thank you for your payment" receipt would not be.
          receipt: null,
        })

        // A called-off retry carried every row of its bank pull — older months'
        // lines, late fees, GAM's own fees. Those FlexPay did not pay keep
        // standing as failed with no retry, so the tenant is told by name.
        if (cancelAfterCommit.length > 0) {
          retryLeftovers = toDueLines((await client.query<LineFacts>(
            `SELECT ${LINE_FACTS_SQL}
               FROM payments p
              WHERE p.stripe_payment_intent_id = ANY($1::text[])
                AND NOT (p.id = ANY($2::uuid[]))
                AND ${payableRowSql('p')}
              ORDER BY ${allocationOrderSql('p')}`,
            [cancelAfterCommit, settledIds])).rows)
        }
      }

      // What is still open on the bill after the cover (a security deposit, a
      // home payment, a line reopened by a dispute, a late fee, GAM's own fee,
      // a line whose money was moving). The late-fee
      // run charges on any non-late-fee line that is not settled, so the tenant
      // is promised "no late fee" only when there is none.
      const leftoverIds = retryLeftovers.map(r => r.id)
      stillDue = toDueLines((await client.query<LineFacts>(
        `SELECT ${LINE_FACTS_SQL}
           FROM payments p
          WHERE p.invoice_id = ANY($1::uuid[])
            AND ${tenantOpenLineSql('p')}
            AND NOT (p.id = ANY($2::uuid[]))
          ORDER BY ${allocationOrderSql('p')}`,
        [invoiceIds, leftoverIds])).rows)
      wholeBillSettled = (await client.query(
        `SELECT 1 FROM payments p
          WHERE p.invoice_id = ANY($1::uuid[]) AND p.type <> 'late_fee' AND p.status <> 'settled'
          LIMIT 1`,
        [invoiceIds])).rowCount === 0

      // Decisions #37.D / terms §4.3: a problem on GAM's side kept FlexPay
      // from paying on time (the run on the last grace day did not happen),
      // and the landlord's late fee posted meanwhile — GAM pays that late fee
      // for the tenant: the tenant never owes it, the landlord is paid (owner
      // share, Tuesday batch), and it is GAM's cost on GAM's book. Only when
      // the late fee was FlexPay's doing: every other line on the bill is paid
      // and none was paid late by the tenant (a line the tenant paid after the
      // grace period would have drawn the fee anyway, so it stays theirs).
      if (late && wholeBillSettled && advanceId && settledIds.length > 0) {
        lateFeesPaidByGam = await payLateFeesGamCaused(client, {
          invoiceIds, advanceId, lastGraceDay: head.last_grace_day, timezone: head.timezone,
          lineNote, allocationMisses,
        })
        if (lateFeesPaidByGam.length > 0) {
          const paid = new Set(lateFeesPaidByGam.map(l => l.id))
          stillDue = stillDue.filter(l => !paid.has(l.id))
        }
      }

      await client.query('COMMIT')
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  if (blocked) {
    // The tenant expects FlexPay to pay this bill too: tell them by name that
    // it did not and that it is theirs to pay before the late fee. Once per
    // bill, and the admin alert with it.
    const told = await notifyTenantSecondBillNotCovered({
      tenantId: head.tenant_id, invoiceIds, invoiceId: head.invoice_id, dueDate: head.due_date, cycle, late,
    })
    if (told !== 'told_before') {
      await alertAdmin('warn', 'flexpay_second_bill_not_covered',
        `FlexPay did not pay a second bill this month (tenant ${head.tenant_id}, due ${head.due_date})`,
        `The bill due ${head.due_date} (invoice ${head.invoice_id}) reached its last grace day with $${blocked.open.toFixed(2)} of bill lines open, ` +
        `but FlexPay already has an advance for ${cycle} (${blocked.advanceId}) and ${blocked.reason}, so this bill was not paid ` +
        'and its pull amount was not changed. The landlord\'s late fee is charged at midnight after the last grace day. ' +
        (told === 'told'
          ? 'The tenant was told in the app and by email that FlexPay did not pay this bill and that it is theirs to pay. '
          : 'The tenant could not be told: tell them this bill is theirs to pay. ') +
        'Decide with the tenant how this bill is paid.',
        { tenant_id: head.tenant_id, invoice_ids: invoiceIds, advance_id: blocked.advanceId,
          open_amount: blocked.open, last_grace_day: head.last_grace_day, tenant_told: told === 'told' })
    }
  }
  if (!advanceId) return { outcome: 'existing', covered: 0, advanceId: null }

  await after?.afterCommit()
  await cancelSupersededIntents(cancelAfterCommit)
  for (const m of allocationMisses) {
    await alertAdmin('critical', 'flexpay_cover_share_not_booked',
      `FlexPay paid a bill line but the landlord's share was not booked (payment ${m.id})`,
      `The line is settled and held on the platform, so the tenant's bill is paid. The landlord's share of this ${m.type} line could not be booked: ${m.error}. Fix the cause and book the share, or the landlord is not paid for it.`,
      { payment_id: m.id, type: m.type, flexpay_advance_id: advanceId })
  }
  if (late) await alertLateCover(head, invoiceIds, advanceId, covered, pullDate, lateFeesPaidByGam)
  if (settledIds.length > 0) await notifyLandlordsRentCollected(settledIds)
  await notifyTenantOfCover({
    tenantId: head.tenant_id, cycle, covered, collectTotal, pullDate, dueDate: head.due_date, late,
    addedToEarlier, stillDue, retryLeftovers, wholeBillSettled, lateFeesPaidByGam,
  })

  return settledIds.length > 0
    ? { outcome: 'covered', covered, advanceId }
    : { outcome: 'paid_already', covered: 0, advanceId }
}

/**
 * The landlord's "Rent Collected" notice for lines FlexPay paid, worded exactly
 * as for any other payment — nothing landlord-facing names FlexPay. Mirrors the
 * webhook's notice (S642): one notice per tenant + unit with the breakdown,
 * and none when the lines hold no rent.
 */
async function notifyLandlordsRentCollected(rowIds: string[]): Promise<void> {
  try {
    const rows = await query<{
      id: string; amount: string; type: string; notes: string | null; utility_type: string | null
      tenant_id: string; unit_id: string; landlord_id_pk: string; property_id: string
      tenant_name: string; unit_number: string; property_name: string
    }>(
      `SELECT p.id, p.amount::text AS amount, p.type, p.notes,
              (SELECT ub.utility_type FROM utility_bills ub WHERE ub.payment_id = p.id LIMIT 1) AS utility_type,
              p.tenant_id::text AS tenant_id, p.unit_id::text AS unit_id,
              l.id AS landlord_id_pk, pr.id AS property_id,
              tu.first_name || ' ' || tu.last_name AS tenant_name,
              un.unit_number, pr.name AS property_name
         FROM payments p
         JOIN tenants    t  ON t.id = p.tenant_id
         JOIN users      tu ON tu.id = t.user_id
         JOIN landlords  l  ON l.id = p.landlord_id
         JOIN units      un ON un.id = p.unit_id
         JOIN properties pr ON pr.id = un.property_id
        WHERE p.id = ANY($1::uuid[])
        ORDER BY CASE p.type WHEN 'rent' THEN 0 WHEN 'utility' THEN 1
                             WHEN 'fee' THEN 2 ELSE 3 END, p.id`,
      [rowIds])
    const groups = new Map<string, typeof rows>()
    for (const r of rows) {
      const key = `${r.tenant_id}:${r.unit_id}`
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
    const { getPropertyResponsibleParty } = await import('./responsibleParty')
    const { notifyRentCollected } = await import('./notifications')
    for (const group of groups.values()) {
      if (!group.some(r => r.type === 'rent')) continue
      const c = group[0]
      const total = round2(group.reduce((s, r) => s + Number(r.amount), 0))
      const breakdown = group.length > 1
        ? group.map(r => ({ label: billLineLabel(r), amount: Number(r.amount) }))
        : undefined
      const targets = await getPropertyResponsibleParty(c.property_id)
      if (!targets) continue
      for (const recipient of targets.primaries) {
        await notifyRentCollected({
          landlordUserId: recipient.user_id,
          landlordId:     c.landlord_id_pk,
          landlordEmail:  recipient.email,
          landlordPhone:  recipient.phone ?? undefined,
          tenantName:     c.tenant_name,
          unitNumber:     c.unit_number,
          propertyName:   c.property_name,
          amount:         total,
          breakdown,
        })
      }
    }
  } catch (e) {
    logger.error({ err: e, payment_ids: rowIds }, '[flexpay][cover] rent-collected notice failed')
  }
}

/**
 * A bill line's name, for the landlord's notice and the tenant's: the utility
 * by type (decision #17: "Water", never "Utilities"), a known kind by its plain
 * name, a GAM fee by its label, else the line's own description; the "Paid on
 * time" / "Paid" tag is never part of a name, and a raw type never shows.
 */
export function billLineLabel(r: { type: string; notes: string | null; utility_type: string | null; entry_description?: string | null }): string {
  if (r.type === 'rent') return 'Rent'
  if (r.type === 'utility' && r.utility_type && r.utility_type in UTILITY_TYPE_LABEL) {
    return UTILITY_TYPE_LABEL[r.utility_type as UtilityType]
  }
  // A card dispute's pass-through fee is a dispute fee, not a returned bank
  // payment (paymentReversal writes RETURNFEE for both; its note says which).
  if (r.entry_description === 'RETURNFEE' && /^card dispute fee/i.test((r.notes ?? '').trim())) return 'Card dispute fee'
  // GAM's own fees carry internal notes ("Declined card attempt — pi_…"):
  // their plain label instead.
  if (r.entry_description && (GAM_FEE_ENTRIES as readonly string[]).includes(r.entry_description)) {
    return PAYMENT_ENTRY_DESCRIPTION_LABELS[r.entry_description as PaymentEntryDescription] ?? 'Fee'
  }
  const note = (r.notes ?? '').split(' — ')[0]
    .split(` · ${COVER_NOTE_ON_TIME}`)[0].split(` · ${COVER_NOTE_LATE}`)[0].trim()
  // The reopen marker (paymentReversal) is never a line's name.
  if (note && note !== COVER_NOTE_ON_TIME && note !== COVER_NOTE_LATE && !/^reopened after/i.test(note)) return note
  switch (r.type) {
    case 'utility':         return 'Utility'
    case 'deposit':         return 'Security deposit'
    case 'late_fee':        return 'Late fee'
    case 'home_payment':    return 'Home payment'
    case 'carried_balance': return 'Earlier balance'
    default:                return 'Fee'
  }
}

/** Entry codes of GAM's own fee rows, named by PAYMENT_ENTRY_DESCRIPTION_LABELS. */
const GAM_FEE_ENTRIES = ['RETURNFEE', 'DECLINEFEE', 'ONTIMEPAY', 'FLEXPAY'] as const

/**
 * Decisions #37.D / FlexPay terms §4.3: GAM pays the late fee a GAM-side delay
 * caused. The landlord's late fees on the bill charged after its last grace
 * day — still unpaid, no money moving on them — settle as GAM's float paid
 * them (platform_held, flexpay_advance_id, the owner share with no processing
 * fee, so the landlord is paid on the Tuesday batch), are NEVER added to what
 * the pull collects (the tenant never owes them), and each is booked as GAM's
 * cost (a negative 'adjustment', reference 'flexpay_late_fee_paid_by_gam').
 * Skipped when a line on the bill other than FlexPay's own was paid after the
 * grace period (the tenant was late too: the fee is theirs). Runs inside the
 * cover's transaction, under its locks. Returns the fees it paid.
 */
async function payLateFeesGamCaused(
  client: PoolClient,
  a: { invoiceIds: string[]; advanceId: string; lastGraceDay: string; timezone: string; lineNote: string
       allocationMisses: Array<{ id: string; type: string; error: string }> },
): Promise<DueLine[]> {
  const boundary = `((($2::date + 1)::timestamp) AT TIME ZONE $3::text)`
  const tenantAlsoLate = await client.query(
    `SELECT 1 FROM payments p
      WHERE p.invoice_id = ANY($1::uuid[]) AND p.type <> 'late_fee' AND p.status = 'settled'
        AND p.settled_at >= ${boundary} AND p.flexpay_advance_id IS DISTINCT FROM $4::uuid
      LIMIT 1`,
    [a.invoiceIds, a.lastGraceDay, a.timezone, a.advanceId])
  if ((tenantAlsoLate.rowCount ?? 0) > 0) return []
  const fees = (await client.query<LineFacts & { unit_id: string | null }>(
    `SELECT ${LINE_FACTS_SQL}, p.unit_id
       FROM payments p
      WHERE p.invoice_id = ANY($1::uuid[]) AND p.type = 'late_fee' AND p.revenue_owner = 'landlord'
        AND ${payableRowSql('p')}
        AND p.created_at >= ${boundary}
      ORDER BY p.id
      FOR UPDATE OF p`,
    [a.invoiceIds, a.lastGraceDay, a.timezone])).rows
  if (fees.length === 0) return []
  const settled = await client.query<{ id: string; amount: string; unit_id: string | null }>(
    `UPDATE payments p
        SET status = 'settled', settled_at = NOW(), platform_held = TRUE, flexpay_advance_id = $2,
            notes = CASE WHEN COALESCE(btrim(p.notes), '') = '' THEN $3::text ELSE p.notes || ' · ' || $3::text END
      WHERE p.id = ANY($1::uuid[]) AND ${payableRowSql('p')}
      RETURNING p.id, p.amount::text AS amount, p.unit_id`,
    [fees.map(f => f.id), a.advanceId, a.lineNote])
  for (const row of [...settled.rows].sort((x, y) => x.id.localeCompare(y.id))) {
    await client.query('SAVEPOINT flexpay_late_fee_alloc')
    try {
      await executeRentAllocation(client, row.id, 'ach', { feeAlreadyCollected: true })
      await client.query('RELEASE SAVEPOINT flexpay_late_fee_alloc')
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT flexpay_late_fee_alloc')
      a.allocationMisses.push({ id: row.id, type: 'late_fee', error: e instanceof Error ? e.message : String(e) })
    }
    const prop = row.unit_id
      ? (await client.query<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [row.unit_id])).rows[0]?.property_id ?? null
      : null
    await recordPlatformRevenue({
      type: 'adjustment',
      amount: -round2(Number(row.amount)),
      referenceId: row.id,
      referenceType: 'flexpay_late_fee_paid_by_gam',
      propertyId: prop,
      notes: `Late fee GAM paid for a FlexPay tenant: a GAM-side delay kept FlexPay from paying the bill on time (advance ${a.advanceId})`,
    }, client)
  }
  const paid = new Set(settled.rows.map(r => r.id))
  return toDueLines(fees.filter(f => paid.has(f.id)))
}

/**
 * A cover made after the bill's last grace day (a missed run caught up): an
 * admin is told, with any late fee the landlord's late-fee run charged on the
 * bill in between — FlexPay promised the bill would get none, so whether to
 * waive it is a person's call — and that the month's $25 is still taken on the
 * pull day, even when the tenant had paid the bill themselves meanwhile
 * (Nic 10/2: a month already paid still takes the $25). Never throws.
 */
async function alertLateCover(
  head: CoverCandidate, invoiceIds: string[], advanceId: string, covered: number, pullDate: string,
  paidByGam: DueLine[] = [],
): Promise<void> {
  try {
    const fees = await queryOne<{ n: number; total: string }>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::text AS total
         FROM payments
        WHERE invoice_id = ANY($1::uuid[]) AND type = 'late_fee' AND status <> 'returned'`,
      [invoiceIds])
    const gamPaid = round2(paidByGam.reduce((s, l) => s + l.amount, 0))
    const lateFees = round2(Number(fees?.total ?? 0) - gamPaid)
    const what = covered > 0
      ? `FlexPay paid it on ${head.today_local} instead ($${covered.toFixed(2)} of bill lines; advance ${advanceId}). `
      : `By the time FlexPay caught up on ${head.today_local} the bill had been paid another way, so FlexPay paid nothing (advance ${advanceId}). `
    await alertAdmin('warn', 'flexpay_cover_late',
      `FlexPay paid a bill late (tenant ${head.tenant_id}, due ${head.due_date})`,
      `The daily run did not pay this bill on its last grace day (${head.last_grace_day}). ` + what +
      (gamPaid > 0
        ? `A late fee of $${gamPaid.toFixed(2)} was charged on the bill in between because of this GAM-side delay; GAM paid it for the tenant (GAM's cost, the landlord is paid). `
        : '') +
      (lateFees > 0
        ? `A late fee of $${lateFees.toFixed(2)} on the bill stands as the tenant's: another line on it was also late. Review it with the landlord. `
        : gamPaid > 0 ? '' : 'No late fee was charged on it. ') +
      `The tenant will still be charged the ${money(FLEXPAY_MONTHLY_FEE)} monthly fee for this month on ${pullDate}.`,
      { tenant_id: head.tenant_id, invoice_ids: invoiceIds, advance_id: advanceId,
        last_grace_day: head.last_grace_day, covered_on: head.today_local, late_fees: lateFees,
        late_fees_paid_by_gam: gamPaid, monthly_fee: FLEXPAY_MONTHLY_FEE, pull_date: pullDate })
  } catch (e) {
    logger.error({ err: e, tenant_id: head.tenant_id }, '[flexpay][cover] late-cover alert failed')
  }
}

/** "Rent $10.00", "Rent $10.00 and Water $5.00", "A $1.00, B $2.00 and C $3.00". */
function sayLines(lines: DueLine[]): string {
  const parts = lines.map(l => `${l.label} ${money(l.amount)}`)
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * The tenant's notice that the cover ran, in the FlexPay terms' own words:
 * FlexPay pays, GAM collects on the pull day. No "repay" or "owe" (S304). A
 * late cover never says "on time", and "no late fee" is promised only when
 * every line the late-fee run counts is paid. Anything left open on the bill
 * (a security deposit FlexPay never pays, a home payment, a line reopened by a
 * dispute, GAM's own fee) and anything a called-off bank
 * retry also carried is named, with the Payments page to pay it. When anything
 * is still the tenant's to pay the notice is emailed too, since a late fee can
 * follow; a bill FlexPay paid in full is told in the app only. Never throws.
 */
async function notifyTenantOfCover(o: {
  tenantId: string; cycle: string; covered: number; collectTotal: number; pullDate: string; dueDate: string
  late: boolean; addedToEarlier: boolean; stillDue: DueLine[]; retryLeftovers: DueLine[]; wholeBillSettled: boolean
  lateFeesPaidByGam?: DueLine[]
}): Promise<void> {
  try {
    const who = await queryOne<{ user_id: string; email: string | null }>(
      `SELECT t.user_id, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [o.tenantId])
    if (!who) return
    const month = sayMonth(o.dueDate)
    const pull = sayDay(o.pullDate)
    const fee = money(FLEXPAY_MONTHLY_FEE)
    const parts: string[] = []
    if (o.covered > 0) {
      const which = o.addedToEarlier ? `your bill due ${sayDay(o.dueDate)}` : `your ${month} bill`
      parts.push(o.late
        ? `FlexPay paid ${which} of ${money(o.covered)} to your landlord.`
        : `FlexPay paid ${which} of ${money(o.covered)} to your landlord on time${o.wholeBillSettled ? ', so it gets no late fee' : ''}.`)
      parts.push(o.addedToEarlier
        ? `On ${pull}, GAM collects ${money(o.collectTotal)}, everything FlexPay paid this month, plus the ${fee} monthly fee from your bank account.`
        : `On ${pull}, GAM collects ${money(o.covered)} plus the ${fee} monthly fee from your bank account.`)
    } else {
      parts.push(o.stillDue.length > 0
        ? `FlexPay had nothing to pay on your ${month} bill.`
        : `Your ${month} bill was already paid, so FlexPay paid nothing this month.`)
      parts.push(`On ${pull}, GAM collects the ${fee} monthly fee from your bank account.`)
    }
    const gamPaid = round2((o.lateFeesPaidByGam ?? []).reduce((s, l) => s + l.amount, 0))
    if (gamPaid > 0) {
      parts.push(`FlexPay paid it late because of a problem on GAM's side, so GAM paid the ${money(gamPaid)} late fee your landlord charged in the meantime. You do not pay it.`)
    }
    if (o.stillDue.length > 0) parts.push(`Still due on this bill: ${sayLines(o.stillDue)}.`)
    if (o.retryLeftovers.length > 0) {
      const total = round2(o.retryLeftovers.reduce((s, l) => s + l.amount, 0))
      parts.push('The bank payment that was set to be tried again is called off, because FlexPay paid the bill. ' +
        `It also carried ${sayLines(o.retryLeftovers)}${o.retryLeftovers.length > 1 ? ` (${money(total)} in all)` : ''}, ` +
        `which ${o.retryLeftovers.length > 1 ? 'are' : 'is'} still due.`)
    }
    const anythingDue = o.stillDue.length > 0 || o.retryLeftovers.length > 0
    if (anythingDue) {
      parts.push(!o.late && !o.wholeBillSettled
        ? 'Pay what is still due on the Payments page today; your landlord\'s late fee can apply to a bill still open after today.'
        : 'Pay what is still due on the Payments page.')
    }
    const { createNotification } = await import('./notifications')
    await createNotification({
      userId: who.user_id,
      type:   'flexpay_bill_covered',
      title:  o.covered > 0
        ? (o.addedToEarlier ? `FlexPay paid your bill due ${sayDay(o.dueDate)}` : `FlexPay paid your ${month} bill`)
        : o.stillDue.length > 0 ? `FlexPay: nothing to pay on your ${month} bill` : `FlexPay: your ${month} bill was already paid`,
      body:   parts.join(' '),
      data:   {
        cycle: o.cycle, covered: o.covered, collect_total: o.collectTotal, pull_date: o.pullDate,
        still_due: o.stillDue.map(l => ({ label: l.label, amount: l.amount })),
        retry_called_off: o.retryLeftovers.map(l => ({ label: l.label, amount: l.amount })),
      },
      actionUrl: anythingDue ? '/payments' : undefined,
      sendEmail: anythingDue && !!who.email,
      emailTo:   anythingDue ? who.email ?? undefined : undefined,
    })
  } catch (e) {
    logger.error({ err: e, tenant_id: o.tenantId }, '[flexpay][cover] tenant notice failed')
  }
}

/**
 * The tenant's notice that FlexPay did NOT pay a second bill this month: the
 * month's advance already had its pull written (or was past 'fronted'), so its
 * amount is fixed and this bill could not be added. Names the bill by its due
 * day, every line still theirs to pay (tenantOpenLineSql, at what is still
 * open on each), and that it is theirs to pay before the landlord's late fee.
 * In the app and by email. Once per bill: a re-run the same day sends nothing
 * more ('told_before'). Never throws.
 */
async function notifyTenantSecondBillNotCovered(o: {
  tenantId: string; invoiceIds: string[]; invoiceId: string; dueDate: string; cycle: string; late: boolean
}): Promise<'told' | 'told_before' | 'nothing_open' | 'failed'> {
  try {
    const who = await queryOne<{ user_id: string; email: string | null; told: boolean }>(
      `SELECT t.user_id, u.email,
              EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = t.user_id AND n.type = 'flexpay_bill_not_covered'
                         AND n.data->>'invoice_id' = $2) AS told
         FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [o.tenantId, o.invoiceId])
    if (!who) return 'failed'
    if (who.told) return 'told_before'
    const open = await query<LineFacts>(
      `SELECT ${LINE_FACTS_SQL}
         FROM payments p
        WHERE p.invoice_id = ANY($1::uuid[])
          AND ${tenantOpenLineSql('p')}
        ORDER BY ${allocationOrderSql('p')}`,
      [o.invoiceIds])
    const stillDue = toDueLines(open)
    if (stillDue.length === 0) return 'nothing_open'
    const total = round2(stillDue.reduce((s, l) => s + l.amount, 0))
    const lateFeeCanApply = open.some(r => r.type !== 'late_fee')
    const due = sayDay(o.dueDate)
    const body =
      `FlexPay did not pay your bill due ${due}. GAM's FlexPay collection for ${sayMonth(o.cycle)} was already set, ` +
      'so this bill could not be added to it. ' +
      `Still due on it: ${sayLines(stillDue)}${stillDue.length > 1 ? ` (${money(total)} in all)` : ''}. ` +
      'That is yours to pay on the Payments page' +
      (lateFeeCanApply
        ? (o.late ? '; your landlord\'s late fee can apply to it.' : ' today; your landlord\'s late fee can apply to a bill still open after today.')
        : '.')
    const { createNotification } = await import('./notifications')
    await createNotification({
      userId:    who.user_id,
      type:      'flexpay_bill_not_covered',
      title:     `FlexPay did not pay your bill due ${due}`,
      body,
      data:      { invoice_id: o.invoiceId, invoice_ids: o.invoiceIds, due_date: o.dueDate, cycle: o.cycle,
                   still_due: stillDue.map(l => ({ label: l.label, amount: l.amount })), open_amount: total },
      actionUrl: '/payments',
      sendEmail: !!who.email,
      emailTo:   who.email ?? undefined,
    })
    return 'told'
  } catch (e) {
    logger.error({ err: e, tenant_id: o.tenantId }, '[flexpay][cover] second-bill notice failed')
    return 'failed'
  }
}

// ── The pull: GAM collects on the pull day ──────────────────────

export interface PullDayResult {
  cycle_month:            string
  candidates_scanned:     number
  /** Pull intents created this run. */
  pulls_initiated:        number
  /** Intents a lost reply left behind, found by the metadata search and recorded. */
  pulls_adopted:          number
  /** Advances defaulted because three runs could not create the pull. */
  advances_defaulted:     number
  errors:                 number
}

interface PullCandidate {
  advance_id:         string
  tenant_id:          string
  landlord_id:        string
  lease_id:           string
  unit_id:            string
  cycle_month:        string
  rent_amount:        string
  tenant_fee_amount:  string
  pull_date:          string
}

/**
 * Daily, 5 am Phoenix: collect every covered cycle whose pull date has come
 * (the property's calendar). A pull date missed (the server was down, the
 * create failed) is caught up on the next run. See the header for the
 * row-first, search-then-create order.
 *
 * Runs whether or not FlexPay is shown (flexpay_rollout_visible): that flag
 * stops new fronting (coverFlexPayCycle), never collecting money GAM already
 * paid the landlord. Hiding FlexPay with advances fronted must not leave GAM's
 * float uncollected until the flag goes back on.
 */
export async function processFlexPayPullDay(now: Date = new Date()): Promise<PullDayResult> {
  const out: PullDayResult = {
    cycle_month:        monthStartOf(dateIn(null, now)),
    candidates_scanned: 0,
    pulls_initiated:    0,
    pulls_adopted:      0,
    advances_defaulted: 0,
    errors:             0,
  }

  // pull_date is written by the cover. An advance written before S655 has
  // none; its date is its cycle's pull day.
  const candidates = await query<PullCandidate>(
    `SELECT a.id AS advance_id, a.tenant_id, a.landlord_id, a.lease_id, a.unit_id,
            a.cycle_month::text AS cycle_month,
            a.rent_amount::text AS rent_amount, a.tenant_fee_amount::text AS tenant_fee_amount,
            COALESCE(a.pull_date, a.cycle_month + (a.pull_day - 1))::text AS pull_date
       FROM flexpay_advances a
       JOIN units u      ON u.id = a.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE a.status = 'fronted'
        AND COALESCE(a.pull_date, a.cycle_month + (a.pull_day - 1))
              <= ($1::timestamptz AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date
      ORDER BY 9, a.id`,
    [now],
  )
  out.candidates_scanned = candidates.length

  for (const c of candidates) {
    try {
      const r = await pullOne(c)
      if (r === 'created') out.pulls_initiated += 1
      else if (r === 'adopted') out.pulls_adopted += 1
      else if (r === 'defaulted') { out.advances_defaulted += 1; out.errors += 1 }
      else if (r === 'failed') out.errors += 1
    } catch (e) {
      out.errors += 1
      logger.error({ err: e, advance_id: c.advance_id }, '[flexpay][pull]')
    }
  }
  return out
}

type PullOutcome = 'created' | 'adopted' | 'skipped' | 'failed' | 'defaulted'

/**
 * GAM's own check found nothing it may pull. `tenantWords` says why in the
 * tenant's terms, for the notice that FlexPay ended.
 */
class PullCreateRefused extends Error {
  /** Whose problem it is (flexPay failure sides: the tenant's bank, or GAM's). */
  constructor(message: string, readonly tenantWords: string, readonly side: FlexPayFailureSide = 'gam') { super(message) }
}

async function pullOne(scanned: PullCandidate): Promise<PullOutcome> {
  let c = scanned
  // ── 1. The row first, and this run's attempt counted, before any Stripe call.
  const client = await getClient()
  let row: { id: string; amount: string; stripe_payment_intent_id: string | null; return_reason: string | null }
  let attempts: number
  try {
    await client.query('BEGIN')
    // Step 10: the lock order every FlexPay path shares (§1.5, and the cover's):
    // the household, then the tenant row, then the advance — a cover, a
    // webhook settle or a write-off meeting this run on one tenant waits
    // instead of deadlocking.
    await lockHousehold(client, c.tenant_id, c.landlord_id)
    await lockTenantForFlexPay(client, c.tenant_id)
    // The amounts are read again under the lock: a second bill paid under this
    // advance since the scan (coverOneCycle) raised what the pull collects.
    const adv = (await client.query<{ status: string; rent_amount: string; tenant_fee_amount: string }>(
      `SELECT status, rent_amount::text AS rent_amount, tenant_fee_amount::text AS tenant_fee_amount
         FROM flexpay_advances WHERE id = $1 FOR UPDATE`, [c.advance_id])).rows[0]
    if (!adv || adv.status !== 'fronted') { await client.query('ROLLBACK'); return 'skipped' }
    c = { ...c, rent_amount: adv.rent_amount, tenant_fee_amount: adv.tenant_fee_amount }

    let existing = (await client.query<{ id: string; amount: string; stripe_payment_intent_id: string | null; return_reason: string | null }>(
      `SELECT id, amount::text AS amount, stripe_payment_intent_id, return_reason
         FROM payments WHERE flexpay_advance_id = $1 AND entry_description = 'FLEXPAY'`,
      [c.advance_id])).rows[0]
    if (!existing) {
      const covered = Number(c.rent_amount)
      const fee = Number(c.tenant_fee_amount)
      // S261 GAM-first routing: anything else the tenant owes GAM rides the
      // same pull, applied on settle (applyTenantSupersedence).
      const boost = await computeTenantGamOutstandingTotal(c.tenant_id, client)
      const amount = round2(covered + fee + boost)
      existing = (await client.query<{ id: string; amount: string; stripe_payment_intent_id: string | null; return_reason: string | null }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description, revenue_owner,
           due_date, notes, gam_supersedence_amount, flexpay_advance_id
         ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'FLEXPAY', 'gam',
                   $6, $7, $8, $9)
         RETURNING id, amount::text AS amount, stripe_payment_intent_id, return_reason`,
        [c.landlord_id, c.tenant_id, c.lease_id, c.unit_id, amount, c.pull_date,
         pullNotes(c.cycle_month, covered, fee, boost), boost.toFixed(2), c.advance_id])).rows[0]
      await client.query(
        `UPDATE flexpay_advances SET rent_payment_id = $2, updated_at = NOW() WHERE id = $1`,
        [c.advance_id, existing.id])
    }
    row = existing
    if (row.stripe_payment_intent_id) {
      // An earlier run stored the intent and stopped before the advance moved on.
      await client.query(
        `UPDATE flexpay_advances SET status = 'pulled', pulled_at = COALESCE(pulled_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND status = 'fronted'`, [c.advance_id])
      await client.query('COMMIT')
      return 'adopted'
    }
    attempts = (await client.query<{ pull_attempts: number }>(
      `UPDATE flexpay_advances SET pull_attempts = pull_attempts + 1, updated_at = NOW()
        WHERE id = $1 RETURNING pull_attempts`, [c.advance_id])).rows[0].pull_attempts
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // ── 2. Find it, or create it.
  // `searched`: this run KNOWS no intent exists for the row from an earlier
  // run — the first run wrote the row a moment ago, so nothing can exist for it
  // yet; a later run knows only once the metadata search has answered.
  // A row made again after a GAM-side failure (FLEXPAY_PULL_REQUEUED_REASON)
  // has an earlier intent, canceled when it was requeued: never one to adopt.
  const requeued = row.return_reason === FLEXPAY_PULL_REQUEUED_REASON
  let searched = attempts === 1 && !requeued
  let intent: PullIntent | null = null
  let adopted = false
  let deadFound = false
  try {
    const stripe = getStripe()
    if (attempts > 1 || requeued) {
      const found = await stripe.paymentIntents.search({
        query: `metadata['gam_payment_id']:'${row.id}'`, limit: 10,
      })
      searched = true
      // A canceled intent moved no money and never will: it is an earlier
      // collection GAM called off, not one to adopt.
      const live = found.data.find(i => i.status !== 'canceled')
      deadFound = found.data.some(i => i.status === 'canceled')
      if (live) { intent = live as PullIntent; adopted = true }
    }
    if (!intent) {
      // The tenant's bank (decisions #37.D, terms §4.3 "Bank payments
      // stopped"): no bank on file, bank payments stopped, or no verified
      // bank — the collection is treated as the last try failing.
      const tenant = await queryOne<{ stripe_customer_id: string | null; ach_suspended_at: string | null }>(
        `SELECT stripe_customer_id, ach_suspended_at FROM tenants WHERE id = $1`, [c.tenant_id])
      if (!tenant?.stripe_customer_id) {
        throw new PullCreateRefused('The tenant has no Stripe customer, so there is no bank account to collect from',
          'there is no verified bank account on your account to collect from', 'tenant')
      }
      if (tenant.ach_suspended_at) {
        throw new PullCreateRefused('Bank payments are stopped for this tenant (a returned bank payment), so GAM may not pull their bank',
          'bank payments are stopped on your account after a bank payment was returned', 'tenant')
      }
      const paymentMethodId = await tenantPullPaymentMethod(tenant.stripe_customer_id)
      if (!paymentMethodId) {
        throw new PullCreateRefused('The tenant has no verified bank account on file to collect from',
          'there is no verified bank account on your account to collect from', 'tenant')
      }
      intent = await createPullIntent({
        paymentId: row.id, amount: Number(row.amount), advanceId: c.advance_id, tenantId: c.tenant_id,
        stripeCustomerId: tenant.stripe_customer_id, paymentMethodId,
        covered: c.rent_amount, fee: c.tenant_fee_amount,
        // An earlier intent of this row was canceled: a key of its own, so
        // Stripe never hands back the canceled one (same-run retries reuse it).
        idempotencyKey: deadFound || requeued ? `flexpay_pull_${row.id}_${attempts}` : undefined,
      })
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    await query(
      `UPDATE flexpay_advances SET pull_last_error = $2, updated_at = NOW() WHERE id = $1`,
      [c.advance_id, msg.slice(0, 1000)])
    logger.error({ err: e, advance_id: c.advance_id, attempts }, '[flexpay][pull] create failed')
    // The tenant's bank: the collection cannot be made, so it is the last try
    // failing — at once, whatever the run (terms §4.3).
    if (e instanceof PullCreateRefused && e.side === 'tenant') {
      await writeOffForUnavailableBank(c, row.id, msg, e.tenantWords)
      return 'defaulted'
    }
    if (attempts < FLEXPAY_MAX_PULL_CREATE_ATTEMPTS) return 'failed'
    // GAM's side (decisions #37.D): never written off, never held against the
    // tenant. Every daily run tries again (the search adopts anything a lost
    // reply left); an admin is told once to fix the cause.
    if (searched && isPullCreateRefusal(e)) {
      if (attempts === FLEXPAY_MAX_PULL_CREATE_ATTEMPTS) {
        await alertAdmin('critical', 'flexpay_pull_gam_side',
          `FlexPay pull could not be made on GAM's side ${attempts} times — ${c.cycle_month}`,
          `Stripe refused GAM's request to create the FlexPay pull for tenant ${c.tenant_id} (advance ${c.advance_id}, pull row ${row.id}) in ${attempts} runs: ${msg}. ` +
          'This is GAM\'s problem, not the tenant\'s bank: nothing is held against the tenant, their FlexPay stays on, and every daily run tries again. Fix the cause; the next run collects it.',
          { advance_id: c.advance_id, payment_id: row.id, tenant_id: c.tenant_id, attempts })
      }
      return 'failed'
    }
    if (attempts === FLEXPAY_MAX_PULL_CREATE_ATTEMPTS) {
      await alertAdmin('warn', 'flexpay_pull_unconfirmed',
        `FlexPay pull still not confirmed after ${attempts} runs — ${c.cycle_month}`,
        `GAM could not confirm whether the FlexPay pull for tenant ${c.tenant_id} (advance ${c.advance_id}, pull row ${row.id}) ` +
        `exists at Stripe: ${msg}. It is NOT written off, because a pull may exist and still succeed; every daily run ` +
        'searches Stripe for it and creates it only if none exists. Check Stripe if this keeps failing.',
        { advance_id: c.advance_id, payment_id: row.id, tenant_id: c.tenant_id, attempts })
    }
    return 'failed'
  }

  // The intent exists from here on. Recording it is outside the try above, so
  // a database error now can never write off a pull Stripe already holds: the
  // row stays "create pending" and the next run's search adopts the intent.
  await recordPullIntent(row.id, c.advance_id, c.tenant_id, intent)
  return adopted ? 'adopted' : 'created'
}

/**
 * A create that was refused outright, so no intent exists for it: GAM's own
 * check found nothing to pull (PullCreateRefused), or Stripe answered the
 * request and declined it (an invalid request or a refused payment method)
 * with no intent attached. Never a dropped connection, a Stripe outage or
 * rate limit, an auth/permission error (GAM's setup, not the tenant's), a
 * plain error of unknown origin, or a refusal that carries an intent (Stripe
 * made the intent and its confirm failed — the next search adopts it).
 *
 * Never an idempotency error either: it says a request with the same key was
 * already made in the last 24 hours, and that request may have made the
 * intent. Stripe's search is only eventually consistent, so a search that
 * found nothing proves nothing then; the next run's search adopts it.
 */
function isPullCreateRefusal(e: any): boolean {
  if (e instanceof PullCreateRefused) return true
  if (isTransientStripeError(e)) return false
  if (e?.payment_intent?.id || e?.raw?.payment_intent?.id) return false
  const type = String(e?.type ?? '')
  const raw = String(e?.rawType ?? '')
  return type === 'StripeInvalidRequestError' || type === 'StripeCardError'
    || raw === 'invalid_request_error' || raw === 'card_error'
}

function pullNotes(cycle: string, covered: number, fee: number, boost: number): string {
  const parts = [`FlexPay ${sayMonth(cycle)}: bill paid $${covered.toFixed(2)} + monthly fee $${fee.toFixed(2)}`]
  if (boost > 0) parts.push(`other GAM balance $${boost.toFixed(2)}`)
  return parts.join(' + ')
}

/**
 * The bank account to pull: a VERIFIED bank on the customer — the customer's
 * default when the default is one, else the first verified bank Stripe lists.
 * The pull is us_bank_account only, so a card default (or a bank still waiting
 * on its microdeposits) is never chosen: either would fail every create and end
 * FlexPay for a tenant with a good bank on file. The same "verified" as the
 * tenant's saved-methods screen (tenantBankMethods, strict: a lookup that
 * fails throws rather than answering "no bank"). Null when there is none.
 */
async function tenantPullPaymentMethod(stripeCustomerId: string): Promise<string | null> {
  const facts = await readStripeMethodFacts(stripeCustomerId, { strict: true })
  const verified = facts.banks.filter(b => b.verified && b.attached)
  return (verified.find(b => b.id === facts.defaultId) ?? verified[0])?.id ?? null
}

/** Errors worth one more try in the same run, with the same idempotency key. */
function isTransientStripeError(e: any): boolean {
  const type = e?.type ?? e?.rawType ?? ''
  return type === 'StripeConnectionError' || type === 'StripeAPIError' || type === 'StripeRateLimitError'
    || type === 'api_error' || type === 'rate_limit_error'
}

/**
 * What a pull's intent says, as Stripe returns it (the create's answer, or a
 * search hit): its id and status, and why it failed when it did.
 */
type PullIntent = {
  id: string
  status: string
  last_payment_error?: { type?: string; code?: string; message?: string; [k: string]: any } | null
  latest_charge?: unknown
  payment_method_types?: string[]
}

async function createPullIntent(o: {
  paymentId: string; amount: number; advanceId: string; tenantId: string
  stripeCustomerId: string; paymentMethodId: string; covered: string; fee: string
  idempotencyKey?: string
}): Promise<PullIntent> {
  const opts = {
    amount:             o.amount,
    stripeCustomerId:   o.stripeCustomerId,
    paymentMethodId:    o.paymentMethodId,
    paymentMethodTypes: ['us_bank_account'] as ('us_bank_account' | 'card')[],
    entryDescription:   'FLEXPAY',
    metadata: {
      gam_purpose:    'flexpay_pull',
      gam_payment_id: o.paymentId,
      gam_advance_id: o.advanceId,
      gam_tenant_id:  o.tenantId,
      gam_covered:    String(Number(o.covered)),
      gam_fee:        String(Number(o.fee)),
    },
    // Same-run retries reuse the key, so a lost reply never pulls twice.
    idempotencyKey: o.idempotencyKey ?? `flexpay_pull_${o.paymentId}`,
  }
  try {
    return await createRentPlatformCharge(opts) as PullIntent
  } catch (e) {
    if (!isTransientStripeError(e)) throw e
    return await createRentPlatformCharge(opts) as PullIntent
  }
}

/**
 * Store the intent on the pull row the moment Stripe answers (its own
 * statement), then move the advance on. A found intent may have finished while
 * GAM was not looking: a success is settled here as the webhook would have
 * (including what the webhook does after its commit for GAM-first routing); a
 * failure is read for its reason (settleAdoptedPullFailure), since there was
 * no intent on the row for the webhook to find.
 */
async function recordPullIntent(
  paymentId: string, advanceId: string, tenantId: string, intent: PullIntent,
): Promise<void> {
  await query(
    `UPDATE payments SET stripe_payment_intent_id = $2, status = 'processing'
      WHERE id = $1 AND stripe_payment_intent_id IS NULL AND status = 'pending'`,
    [paymentId, intent.id])
  await query(
    `UPDATE flexpay_advances
        SET status = 'pulled', pulled_at = COALESCE(pulled_at, NOW()), pull_last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'fronted'`,
    [advanceId])

  if (intent.status === 'succeeded') {
    let routed: ApplySupersedenceResult | null = null
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // The cover's lock order (§3): the household first, then the tenant row,
      // then the pull row and the advances. The success webhook settling the
      // same pull (a redelivery arriving at this moment) takes the household
      // first too, so the two wait for each other instead of deadlocking.
      // GAM-first routing below may mark an earlier written-off advance
      // recovered, and the reconcile writes this one. The landlord is the pull
      // row's own (never null on a payments row).
      const owner = (await client.query<{ landlord_id: string }>(
        `SELECT landlord_id FROM payments WHERE id = $1`, [paymentId])).rows[0]
      if (owner) await lockHousehold(client, tenantId, owner.landlord_id)
      await lockTenantForFlexPay(client, tenantId)
      const s = await client.query(
        `UPDATE payments SET status = 'settled', settled_at = NOW()
          WHERE id = $1 AND status = 'processing' RETURNING id`, [paymentId])
      if ((s.rowCount ?? 0) > 0) {
        routed = await applyTenantSupersedence(client, paymentId)
        await reconcileSettledFlexPayPayment(paymentId, client)
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    if (routed?.applied) await afterGamFirstRouting(paymentId, tenantId, routed)
  } else if (intent.status === 'canceled' || intent.status === 'requires_payment_method') {
    await settleAdoptedPullFailure(paymentId, tenantId, intent)
  }
}

/**
 * A FlexPay pull intent the webhook finds on NO row: Stripe answered the
 * create but the intent id never reached the pull row (the process stopped in
 * between), so the success or failure arrives for an intent no payments row
 * carries. That money is GAM collecting what FlexPay paid — never the tenant's
 * paid-ahead money, and never an orphan remittance to rebuild. It is recorded
 * on the pull row its metadata names (gam_payment_id), exactly as the pull
 * run's own adoption does (recordPullIntent, household lock first): a success
 * settles the pull, reconciles its advance and books the $25; a failure is read
 * for its reason; one still moving is stored for its next event. The daily
 * pull run would adopt it the same way the next morning; this does it now.
 *
 * For the webhook (money plan Step 10): call it for any intent with metadata
 * gam_purpose 'flexpay_pull' that matched no row by intent id, and do nothing
 * else with that intent. Returns what it did; an intent naming a row that is
 * not a FlexPay pull of that advance, or a row that already carries a
 * different intent, changes nothing and an admin is told.
 */
export async function adoptFlexPayPullIntent(
  intent: PullIntent & { metadata?: Record<string, string> | null },
): Promise<'not_flexpay' | 'recorded' | 'already_recorded' | 'called_off' | 'recovered' | 'mismatch'> {
  const md = intent.metadata ?? {}
  if (md.gam_purpose !== 'flexpay_pull' || !md.gam_payment_id) return 'not_flexpay'
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(md.gam_payment_id)
  const row = !isUuid ? undefined : await queryOne<{
    id: string; tenant_id: string; landlord_id: string; flexpay_advance_id: string | null; stripe_payment_intent_id: string | null
    status: string; return_reason: string | null; advance_status: string | null
  }>(
    `SELECT p.id, p.tenant_id, p.landlord_id, p.flexpay_advance_id, p.stripe_payment_intent_id, p.status, p.return_reason,
            (SELECT a.status FROM flexpay_advances a WHERE a.id = p.flexpay_advance_id) AS advance_status
       FROM payments p
      WHERE p.id = $1::uuid AND p.entry_description = 'FLEXPAY'`,
    [md.gam_payment_id])
  if (row && row.stripe_payment_intent_id === intent.id) return 'already_recorded'
  // A pull GAM called off moved no money and never will: nothing to record.
  // The earlier, failed or canceled pull of a row made again after a GAM-side
  // failure is that row's history, never its pull.
  if (intent.status === 'canceled'
      || (row && row.return_reason === FLEXPAY_PULL_REQUEUED_REASON && intent.status !== 'succeeded' && intent.status !== 'processing')) {
    if (intent.status !== 'canceled') await cancelCalledOffPull(intent.id)
    return 'called_off'
  }
  // A row closed as never created (written off: failed, no intent, its advance
  // defaulted) whose pull existed after all and SUCCEEDED (a create whose reply
  // was lost, past a search that did not see it yet): the money arrived. It is
  // recorded and the advance recovered — reconciled, its $25 booked — so
  // GAM-first routing never collects the same money a second time; an admin
  // is told (the write-off may have marked the tenant). Anything else on such
  // a row is a mismatch for a person to look at.
  if (row && row.status === 'failed' && !row.stripe_payment_intent_id && row.advance_status === 'defaulted'
      && row.flexpay_advance_id && (!md.gam_advance_id || md.gam_advance_id === row.flexpay_advance_id)) {
    if (intent.status === 'succeeded') {
      await recoverWrittenOffPull(row.id, row.flexpay_advance_id, row.tenant_id, row.landlord_id, intent.id)
      await alertAdmin('critical', 'flexpay_pull_intent_unmatched',
        `A FlexPay pull written off as never made had succeeded (${intent.id})`,
        `Pull row ${row.id} (advance ${row.flexpay_advance_id}) was closed as never created, but Stripe intent ${intent.id} for it succeeded. ` +
        'The money is recorded on the pull and the advance is recovered (reconciled, $25 booked), so it is never collected again. ' +
        `The write-off may have ended the tenant's FlexPay or started a rejoin wait (tenant ${row.tenant_id}): review it.`,
        { stripe_payment_intent_id: intent.id, payment_id: row.id, advance_id: row.flexpay_advance_id, tenant_id: row.tenant_id })
      return 'recovered'
    }
    await alertAdmin('critical', 'flexpay_pull_intent_unmatched',
      `A FlexPay pull at Stripe names a pull written off as never made (${intent.id})`,
      `Stripe intent ${intent.id} (status ${intent.status}) names pull row ${row.id}, which was closed as never created and its advance written off. ` +
      'Nothing was recorded for it. Check it in Stripe.',
      { stripe_payment_intent_id: intent.id, intent_status: intent.status, metadata: md })
    return 'mismatch'
  }
  const why = !row ? 'names a FlexPay pull row that does not exist'
    : !row.flexpay_advance_id || (md.gam_advance_id && md.gam_advance_id !== row.flexpay_advance_id)
      ? `names pull row ${row.id}, which belongs to a different FlexPay advance`
      : row.stripe_payment_intent_id
        ? `names pull row ${row.id}, which already carries a different intent (${row.stripe_payment_intent_id}): the tenant's bank may have been pulled twice`
        : null
  if (why) {
    await alertAdmin('critical', 'flexpay_pull_intent_unmatched',
      `A FlexPay pull at Stripe matches no pull row (${intent.id})`,
      `Stripe intent ${intent.id} (status ${intent.status}) ${why}. Nothing was recorded for it. ` +
      'Check it in Stripe: if it succeeded, the money is GAM collecting what FlexPay paid, never the tenant\'s credit.',
      { stripe_payment_intent_id: intent.id, intent_status: intent.status, metadata: md })
    return 'mismatch'
  }
  await recordPullIntent(row!.id, row!.flexpay_advance_id!, row!.tenant_id, intent)
  return 'recorded'
}

/**
 * Record a succeeded intent on a pull row that was written off as never made,
 * and recover its advance (adoptFlexPayPullIntent): the row settles under the
 * intent, GAM-first routing runs for its boost, the advance is reconciled
 * (it keeps defaulted_at: the write-off happened) and its $25 is booked.
 * The household, the tenant row, then the rows: the cover's lock order.
 */
async function recoverWrittenOffPull(
  paymentId: string, advanceId: string, tenantId: string, landlordId: string, intentId: string,
): Promise<void> {
  let routed: ApplySupersedenceResult | null = null
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await lockHousehold(client, tenantId, landlordId)
    await lockTenantForFlexPay(client, tenantId)
    const s = await client.query(
      `UPDATE payments SET stripe_payment_intent_id = $2, status = 'settled', settled_at = NOW(), next_retry_at = NULL
        WHERE id = $1 AND status = 'failed' AND stripe_payment_intent_id IS NULL RETURNING id`,
      [paymentId, intentId])
    if ((s.rowCount ?? 0) > 0) {
      routed = await applyTenantSupersedence(client, paymentId)
      const flipped = await client.query(
        `UPDATE flexpay_advances SET status = 'reconciled', reconciled_at = NOW(), updated_at = NOW(),
                notes = COALESCE(notes || ' ', '') || 'Recovered: its pull had succeeded after all.'
          WHERE id = $1 AND status = 'defaulted' RETURNING id`, [advanceId])
      if ((flipped.rowCount ?? 0) > 0) await bookFlexPayFee(advanceId, client)
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  if (routed?.applied) await afterGamFirstRouting(paymentId, tenantId, routed)
}

/** The pull row's property calendar (Phoenix when it has no unit), for SQL on `payments`. */
const PULL_ROW_TZ_SQL = `COALESCE((SELECT pr.timezone FROM units un JOIN properties pr ON pr.id = un.property_id
                                    WHERE un.id = payments.unit_id), 'America/Phoenix')`

/**
 * A pull intent GAM finds already failed. Its reason decides, as the failure
 * webhook's would (achRetry extractReturnCode / decideRetry / bankRefusedDebit):
 *   - a debit the tenant's bank refused or returned: a retryable return is
 *     tried again on the FlexPay schedule — FLEXPAY_PULL_RETRY_DAYS later on
 *     the property's calendar, up to FLEXPAY_PULL_MAX_RETRIES retries (the
 *     shared retry run re-prices it) — and the tenant is told the day; a final
 *     one, one past the last retry, or one whose reason GAM cannot read (a
 *     frozen or restricted account: never retried, terms §4.1) writes the
 *     advance off as the tenant's.
 *   - anything else — Stripe refusing GAM's own request (an invalid request or
 *     a mandate/setup problem when the intent was made), or an intent
 *     canceled — is GAM's: the tenant's bank never said no, so the collection
 *     is made again ({ gamSide: true }: FlexPay stays on, no wait, never the
 *     tenant's mark).
 */
async function settleAdoptedPullFailure(paymentId: string, tenantId: string, intent: PullIntent): Promise<void> {
  const asIntent = intent as unknown as Parameters<typeof extractReturnCode>[0]
  const returnCode = intent.status === 'requires_payment_method' ? extractReturnCode(asIntent) : null
  const atBank = intent.status === 'requires_payment_method' && (returnCode != null || bankRefusedDebit(asIntent))
  const decision = atBank ? decideRetry(returnCode) : null
  if (decision === 'retry') {
    const retry = await query<{ amount: string; retry_day: string }>(
      `UPDATE payments
          SET status = 'failed', return_code = $2,
              next_retry_at = ((((NOW() AT TIME ZONE ${PULL_ROW_TZ_SQL})::date + $3::int)::timestamp)
                                 AT TIME ZONE ${PULL_ROW_TZ_SQL})
        WHERE id = $1 AND status = 'processing' AND COALESCE(retry_count, 0) < $4
        RETURNING amount::text AS amount,
                  ((NOW() AT TIME ZONE ${PULL_ROW_TZ_SQL})::date + $3::int)::text AS retry_day`,
      [paymentId, returnCode, FLEXPAY_PULL_RETRY_DAYS, FLEXPAY_PULL_MAX_RETRIES])
    if (retry.length > 0) {
      await notifyTenantPullRetry(paymentId, retry[0].retry_day)
      return
    }
  }
  await query(
    `UPDATE payments SET status = 'failed', next_retry_at = NULL, return_code = COALESCE($2, return_code)
      WHERE id = $1 AND status = 'processing'`, [paymentId, returnCode])
  await handleFlexPayPaymentNsf(paymentId, undefined, {
    gamSide: decision === null,
    why: decision === null
      ? (intent.status === 'canceled' ? 'the pull was canceled' : 'Stripe refused GAM\'s own request for the pull')
      : null,
  })
}

/**
 * The tenant's notice that a FlexPay pull bounced and is tried again, in the
 * terms' words ("failed_pull"): what did not go through (the failed try's
 * amount, the pull row's), the retry day, and what that retry collects — the
 * same figure repriceFlexPayRetryPayment sets just before it fires
 * (quoteFlexPayRetry with the bounces so far: this one included), so the
 * returned-pull fee for every bounce is in it. In the app and by email.
 *
 * Called for a failure GAM found itself (settleAdoptedPullFailure). Exported
 * for the failure webhook's FlexPay branch (money plan Step 10), which sends
 * this instead of the generic bank-retry notice: never a landlord copy (the
 * landlord was paid by the cover and never hears of FlexPay). Call it after
 * the row is 'failed' with its retry scheduled and BEFORE the retry run claims
 * it (retry_count = retries fired so far). Never throws.
 */
export async function notifyTenantPullRetry(paymentId: string, retryDay: string): Promise<void> {
  try {
    const row = await queryOne<{ tenant_id: string; amount: string; retry_count: number | null; user_id: string; email: string | null }>(
      `SELECT p.tenant_id, p.amount::text AS amount, p.retry_count, t.user_id, u.email
         FROM payments p JOIN tenants t ON t.id = p.tenant_id JOIN users u ON u.id = t.user_id
        WHERE p.id = $1 AND p.entry_description = 'FLEXPAY'`, [paymentId])
    if (!row) return
    const quote = await quoteFlexPayRetry(paymentId, (row.retry_count ?? 0) + 1)
    if (!quote) return
    const day = sayDay(retryDay)
    const fees = quote.bounces === 1
      ? `${money(quote.returnedPullFees)}, the fee GAM is charged when a bank sends a payment back`
      : `${money(quote.returnedPullFees)}: ${money(FLEXPAY_ACH_RETURN_FEE)} for each of the ${quote.bounces} times your bank sent this payment back, the fee GAM is charged`
    const { createNotification } = await import('./notifications')
    await createNotification({
      userId:  row.user_id,
      type:    'flexpay_pull_retry',
      title:   `FlexPay: GAM tries your bank again on ${day}`,
      body:    `GAM's FlexPay collection of ${money(Number(row.amount))} from your bank account did not go through. ` +
               `GAM tries again on ${day} and collects ${money(quote.amount)}. ` +
               `That includes ${fees}, passed on at cost. Please have the money in the account by then.`,
      data:    { failed_amount: Number(row.amount), retry_amount: quote.amount, returned_pull_fees: quote.returnedPullFees,
                 bounces: quote.bounces, retry_day: retryDay },
      sendEmail: !!row.email,
      emailTo:   row.email ?? undefined,
    })
  } catch (e) {
    logger.error({ err: e, payment_id: paymentId }, '[flexpay][pull] retry notice failed')
  }
}

/** Why FlexPay ended, for the tenant's notice. */
type FlexPayEndedWhy =
  /** The pull's last try failed at the tenant's bank (the last retry, or a closed account). */
  | { kind: 'not_collected'; cycle: string }
  /** A pull that had settled was taken back by the tenant's bank. */
  | { kind: 'taken_back'; cycle: string }
  /**
   * The pull could not be made because of the tenant's bank (no bank on file,
   * bank payments stopped, no verified bank): treated as the last try failing.
   */
  | { kind: 'bank_unavailable'; cycle: string; detail: string }
  /**
   * Bank payments are stopped on the tenant (the NACHA block). `bill`: the
   * cover found lines still the tenant's to pay on the bill it would have
   * paid; they are named, with whether the landlord's late fee can still land.
   */
  | { kind: 'bank_stopped'
      /** No verified bank on file (rather than bank payments stopped after a return). */
      noBank?: boolean
      bill?: { due: string; pastGrace: boolean; stillDue: DueLine[]; lateFeeCanApply: boolean } }

/** What the "FlexPay ended" notice reads about the tenant, as of the moment FlexPay ended. */
interface FlexPayEndedFacts {
  userId: string
  email: string | null
  banned: boolean
  rejoinAt: string | Date | null
  /** FlexPay money GAM fronted and has not collected yet: every written-off advance. */
  open: number
  autopayOn: boolean
  /** FlexPay was on until this ending (false: the tenant had already left it, e.g. canceled). */
  wasEnrolled: boolean
}

/**
 * Read the notice's facts. Inside a transaction pass its `exec`, so a write-off
 * the transaction just made (and the rejoin day it set) is seen.
 */
async function readFlexPayEndedFacts(
  tenantId: string, exec?: (sql: string, params: unknown[]) => Promise<any[]>, wasEnrolled = true,
): Promise<FlexPayEndedFacts | null> {
  const run = exec ?? ((sql: string, params: unknown[]) => query<any>(sql, params as any[]))
  const [r] = await run(
    `SELECT t.user_id, u.email, t.flexpay_permanently_banned AS banned,
            t.flexpay_disqualified_until AS rejoin_at,
            (SELECT COALESCE(SUM(fa.rent_amount + fa.tenant_fee_amount), 0)
               FROM flexpay_advances fa
              WHERE fa.tenant_id = t.id AND fa.status = 'defaulted')::text AS open,
            EXISTS (SELECT 1 FROM tenant_autopay ta WHERE ta.tenant_id = t.id AND ta.enabled = TRUE) AS autopay_on
       FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [tenantId])
  if (!r) return null
  return { userId: r.user_id, email: r.email ?? null, banned: !!r.banned, rejoinAt: r.rejoin_at ?? null,
           open: round2(Number(r.open ?? 0)), autopayOn: !!r.autopay_on, wasEnrolled }
}

/**
 * The tenant's notice that FlexPay ended, in the app and by email: why, in
 * plain words; what FlexPay money is still open with GAM and how it is
 * collected (GAM-first routing on their next payment through GAM — no "owe",
 * "repay" or "loan", S304); when they can join again; that their next bill is
 * theirs to pay; and, when no autopay is on (joining FlexPay turned it off),
 * that autopay is off and where to turn it on. Autopay is never turned back on
 * by GAM. Sent once per ending, by the code that ended it. Never throws.
 */
async function notifyTenantFlexPayEnded(
  tenantId: string, why: FlexPayEndedWhy, facts?: FlexPayEndedFacts | null, wasEnrolled = true,
): Promise<void> {
  try {
    const f = facts ?? await readFlexPayEndedFacts(tenantId, undefined, wasEnrolled)
    if (!f) return
    // A tenant who had already left FlexPay (canceled, with a covered month
    // still collected after) is told what happened, never that it "ended".
    const ended = f.wasEnrolled ? ', so your FlexPay has ended.' : '.'
    const parts: string[] = []
    switch (why.kind) {
      case 'not_collected':
        parts.push(`GAM could not collect your FlexPay payment for your ${sayMonth(why.cycle)} bill on its last try${ended}`)
        break
      case 'taken_back':
        parts.push(`Your bank took back the FlexPay payment GAM collected for your ${sayMonth(why.cycle)} bill${ended}`)
        break
      case 'bank_unavailable':
        parts.push(`GAM could not collect your FlexPay payment for your ${sayMonth(why.cycle)} bill because ${why.detail}${ended}`)
        break
      case 'bank_stopped':
        parts.push(why.noBank
          ? `There is no verified bank account on your account, so FlexPay cannot collect from your bank${f.wasEnrolled ? ', and your FlexPay has ended' : ''}.`
          : `Bank payments are stopped on your account after a bank payment was returned, so FlexPay cannot collect from your bank${f.wasEnrolled ? ', and your FlexPay has ended' : ''}.`)
        if (why.bill) {
          const b = why.bill
          const total = round2(b.stillDue.reduce((s, l) => s + l.amount, 0))
          parts.push(`FlexPay did not pay your bill due ${sayDay(b.due)}. ` +
            `Still due on it: ${sayLines(b.stillDue)}${b.stillDue.length > 1 ? ` (${money(total)} in all)` : ''}. ` +
            'That is yours to pay on the Payments page' +
            (b.lateFeeCanApply ? `; your landlord's late fee can apply to it${b.pastGrace ? '' : ' after today'}.` : '.'))
        }
        break
    }
    if (f.open > 0.005) {
      parts.push(`${money(f.open)} from FlexPay is still open with GAM. It is taken first from the next payment you make through GAM.`)
    }
    const after = f.open > 0.005 ? ', once that amount is collected' : ''
    const rejoinAt = f.rejoinAt && new Date(f.rejoinAt).getTime() > Date.now() ? f.rejoinAt : null
    if (f.banned) parts.push('This is the second time, so FlexPay is no longer available on your account.')
    else if (why.kind === 'bank_stopped') {
      const bankOk = why.noBank ? 'a verified bank account is on your account' : 'bank payments are working again on your account'
      parts.push(rejoinAt
        ? `You can join FlexPay again on ${sayInstant(rejoinAt)}, once ${bankOk}${after}.`
        : `You can join FlexPay again once ${bankOk}${after}.`)
    }
    else if (rejoinAt) parts.push(`You can join FlexPay again on ${sayInstant(rejoinAt)}${after}.`)
    else parts.push(f.open > 0.005 ? 'You can join FlexPay again once that amount is collected.' : 'You can join FlexPay again at any time.')
    if (f.wasEnrolled && !(why.kind === 'bank_stopped' && why.bill)) parts.push('Your next bill is yours to pay.')
    if (f.wasEnrolled && !f.autopayOn) parts.push('Autopay is off. You can turn it on in Payments so your bills are paid on time.')

    const { createNotification } = await import('./notifications')
    await createNotification({
      userId:    f.userId,
      type:      'flexpay_ended',
      title:     f.wasEnrolled ? 'Your FlexPay has ended' : 'FlexPay: a payment to GAM did not go through',
      body:      parts.join(' '),
      data:      { why: why.kind, cycle: 'cycle' in why ? why.cycle : null, still_open: f.open,
                   rejoin_at: rejoinAt ? new Date(rejoinAt).toISOString() : null, rejoin_never: f.banned,
                   still_due: why.kind === 'bank_stopped' && why.bill
                     ? why.bill.stillDue.map(l => ({ label: l.label, amount: l.amount })) : [] },
      actionUrl: '/payments',
      sendEmail: !!f.email,
      emailTo:   f.email ?? undefined,
    })
  } catch (e) {
    logger.error({ err: e, tenant_id: tenantId }, '[flexpay] ended notice failed')
  }
}

/**
 * What the success webhook does after committing a settle that ran GAM-first
 * routing (routes/webhooks.ts, S261), for the one settle this file makes
 * itself — a found pull that had already succeeded. A FlexCharge statement the
 * pull's GAM-first part paid owes its merchant a payout (the routing returns
 * it for after the commit, so no transaction waits on Stripe); money left over
 * after every GAM balance was paid is an admin notice. The transfer carries the
 * webhook's own idempotency key, so the two can never pay a merchant twice.
 * Never throws.
 */
async function afterGamFirstRouting(paymentId: string, tenantId: string, r: ApplySupersedenceResult): Promise<void> {
  for (const t of r.post_commit_transfers) {
    if (t.source !== 'flexcharge_statement') continue
    try {
      if (!t.destination_connect_account) {
        await alertAdmin('warn', 'flexcharge_merchant_transfer_pending',
          `FlexCharge merchant Transfer waiting (supersedence) — statement ${t.ref_id}`,
          `Statement ${t.ref_id} satisfied via supersedence from payment ${paymentId}; merchant share $${t.amount.toFixed(2)} is on platform balance pending landlord Connect onboarding.`,
          { statement_id: t.ref_id, paid_via_payment_id: paymentId, amount: t.amount })
        continue
      }
      await getStripe().transfers.create(
        {
          amount:      Math.round(t.amount * 100),
          currency:    'usd',
          destination: t.destination_connect_account,
          description: `FlexCharge merchant payout (supersedence) — statement ${t.ref_id}`,
          metadata: {
            gam_purpose:             'flexcharge_merchant_payout',
            gam_statement_id:        t.ref_id,
            gam_via_supersedence:    'true',
            gam_paid_via_payment_id: paymentId,
          },
        },
        { idempotencyKey: `flexcharge_payout_super_${t.ref_id}` },
      )
    } catch (e) {
      logger.error({ err: e, statement_id: t.ref_id, paid_via_payment_id: paymentId }, '[flexpay][pull] supersedence merchant transfer failed')
      await alertAdmin('warn', 'flexcharge_merchant_transfer_failed_supersedence',
        `FlexCharge merchant Transfer failed (supersedence) — statement ${t.ref_id}`,
        e instanceof Error ? e.message : String(e),
        { statement_id: t.ref_id, paid_via_payment_id: paymentId, amount: t.amount })
    }
  }
  if (r.amount_residual > 0.005) {
    await alertAdmin('warn', 'supersedence_residual_unallocated',
      `Supersedence residual unallocated — payment ${paymentId}`,
      `Payment ${paymentId} carried $${r.amount_residual.toFixed(2)} of supersedence boost that exceeded the tenant's live GAM-debt total at settle. Funds remain on platform balance.`,
      { payment_id: paymentId, residual: r.amount_residual, tenant_id: tenantId })
  }
}

/**
 * The pull cannot be made because of the TENANT's bank (decisions #37.D, terms
 * §4.3 "Bank payments stopped"): no bank on file, bank payments stopped after
 * a returned payment, or no verified bank. Treated as the last try failing,
 * at once: the advance is written off as the tenant's ('bank_unavailable' —
 * what FlexPay paid + the month's fee become their GAM-side balance), FlexPay
 * ends with the rejoin wait (a second time, for good), and the tenant is told
 * why (`tenantWords`) and when they can join again.
 */
async function writeOffForUnavailableBank(
  c: PullCandidate, paymentId: string, lastError: string, tenantWords: string,
): Promise<void> {
  const client = await getClient()
  let written: number | null = null
  let wasEnrolled = false
  let permanent = false
  let facts: FlexPayEndedFacts | null = null
  try {
    await client.query('BEGIN')
    // The household, then the tenant row, then the advance (lockTenantForFlexPay).
    await lockHousehold(client, c.tenant_id, c.landlord_id)
    wasEnrolled = await lockTenantForFlexPay(client, c.tenant_id)
    const r = await client.query<{ written: string }>(
      `UPDATE flexpay_advances
          SET status = 'defaulted', defaulted_at = NOW(), default_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'fronted'
        RETURNING (rent_amount + tenant_fee_amount)::text AS written`,
      [c.advance_id, FLEXPAY_DEFAULT_REASONS.bankUnavailable])
    if (r.rows[0]) {
      written = Number(r.rows[0].written)
      // The pull row was never sent; it is closed as not collected so nothing
      // reads it as waiting. It was never part of any tenant balance.
      await client.query(
        `UPDATE payments SET status = 'failed', next_retry_at = NULL
          WHERE id = $1 AND status = 'pending' AND stripe_payment_intent_id IS NULL`,
        [paymentId])
      permanent = await markTenantForWriteOff(client, c.tenant_id, FLEXPAY_DEFAULT_REASONS.bankUnavailable)
      facts = await readFlexPayEndedFacts(c.tenant_id, async (sql, p) => (await client.query(sql, p)).rows, wasEnrolled)
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  if (written === null) return
  await alertAdmin('warn', 'flexpay_advance_defaulted',
    permanent
      ? `FlexPay ended for good: the tenant's bank cannot be pulled (second time) — ${c.cycle_month}`
      : `FlexPay pull not possible: the tenant's bank cannot be pulled — ${c.cycle_month}`,
    `GAM could not collect the FlexPay pull for tenant ${c.tenant_id} (advance ${c.advance_id}): ${lastError}. ` +
    `That is the tenant's bank, so it counts as the last try failing: $${written.toFixed(2)} is written off and is recovered only by GAM-first routing on their next payment. ` +
    (permanent
      ? 'This is their second time, so they can never rejoin FlexPay.'
      : `They cannot rejoin FlexPay for ${FLEXPAY_NSF_COOLDOWN_DAYS} days, and only once that amount is collected.`) +
    ' The tenant was told.',
    { advance_id: c.advance_id, payment_id: paymentId, tenant_id: c.tenant_id, cycle: c.cycle_month, written_off: written })
  await notifyTenantFlexPayEnded(c.tenant_id, { kind: 'bank_unavailable', cycle: c.cycle_month, detail: tenantWords }, facts, wasEnrolled)
}

/**
 * A GAM-side failure (decisions #37.D, terms §4.3 "A problem on GAM's side"):
 * nothing is held against the tenant. FlexPay stays on and no wait starts; the
 * collection is made again once the problem is fixed — the advance goes back
 * to waiting on its pull ('fronted'), and the same pull row is set to be made
 * again (no intent, the amount re-figured), so the next daily pull run makes
 * it (a pull date already passed is caught up). The earlier intent is
 * canceled after the commit, so it can never be confirmed and no search
 * adopts it. Runs in the caller's transaction (the tenant row is locked).
 *
 * It is the SAME collection made again (terms §4.1/§4.3), so the bank returns
 * it already had (`bounces` — the row's retry_count) stay counted on the row:
 * the bank is never presented with it more than the first try and the two
 * retries in all (a further return then is the last try failing, the
 * tenant's), and the try collects the returned-pull fee for every return so
 * far (§4.1(c)) — on the amount pulled, exactly as a retry's reprice adds it,
 * never folded into the advance (a write-off adds them once, from the count).
 *
 * Capped: after FLEXPAY_MAX_GAM_SIDE_REQUEUES problems on GAM's side for one
 * advance the collection is HELD instead — not made again, nothing pulled,
 * nothing held against the tenant — and the caller tells an admin to fix the
 * cause and release it (`held`). A problem that keeps coming back is GAM's to
 * fix, never a daily pull.
 */
async function requeueGamSidePull(
  c: PoolClient,
  a: { paymentId: string; advanceId: string; tenantId: string; bounces: number; why: string | null
       /** A person released a held collection (releaseHeldFlexPayCollection): made again past the cap, once. */
       released?: boolean },
): Promise<{ oldIntent: string | null; collect: number; held: boolean; requeues: number }> {
  const prior = (await c.query<{ n: number }>(
    `SELECT ((length(COALESCE(notes, '')) - length(replace(COALESCE(notes, ''), $2::text, ''))) / length($2::text))::int AS n
       FROM flexpay_advances WHERE id = $1`,
    [a.advanceId, FLEXPAY_REQUEUE_NOTE_MARK])).rows[0]?.n ?? 0
  const oldPi = (await c.query<{ pi: string | null }>(
    `SELECT stripe_payment_intent_id AS pi FROM payments WHERE id = $1`, [a.paymentId])).rows[0]?.pi ?? null
  if (prior >= FLEXPAY_MAX_GAM_SIDE_REQUEUES && !a.released) {
    await c.query(
      `UPDATE flexpay_advances
          SET pull_last_error = $2,
              notes = CASE WHEN position($3::text IN COALESCE(notes, '')) > 0 THEN notes
                           ELSE COALESCE(notes || ' ', '') || $3::text END,
              updated_at = NOW()
        WHERE id = $1`,
      [a.advanceId, (a.why ?? 'failed on GAM\'s side').slice(0, 1000), FLEXPAY_HELD_NOTE])
    return { oldIntent: oldPi, collect: 0, held: true, requeues: prior }
  }
  const bounces = Math.max(0, a.bounces)
  const fees = round2(FLEXPAY_ACH_RETURN_FEE * bounces)
  const adv = (await c.query<{ rent_amount: string; tenant_fee_amount: string; cycle_month: string }>(
    `UPDATE flexpay_advances
        SET status = 'fronted', pull_last_error = $2,
            notes = COALESCE(notes || ' ', '') || $3, updated_at = NOW()
      WHERE id = $1
      RETURNING rent_amount::text AS rent_amount, tenant_fee_amount::text AS tenant_fee_amount, cycle_month::text AS cycle_month`,
    [a.advanceId, (a.why ?? 'failed on GAM\'s side').slice(0, 1000),
     (a.released ? `${FLEXPAY_RELEASED_NOTE_MARK} ${new Date().toISOString().slice(0, 10)}. ` : '') +
     `${FLEXPAY_REQUEUE_NOTE_MARK} ${new Date().toISOString().slice(0, 10)}: it failed on GAM's side` +
     (a.why ? ` (${a.why})` : '') +
     (fees > 0 ? `; the try collects $${fees.toFixed(2)} of returned-pull fees (${bounces} × $${FLEXPAY_ACH_RETURN_FEE.toFixed(2)}) at cost.` : '.')])).rows[0]
  const covered = Number(adv.rent_amount)
  const fee = Number(adv.tenant_fee_amount)
  const boost = await computeTenantGamOutstandingTotal(a.tenantId, c)
  const collect = round2(covered + fee + fees + boost)
  const notes = pullNotes(adv.cycle_month, covered, fee, boost) +
    (fees > 0 ? ` + returned-pull fee $${fees.toFixed(2)} (${bounces} × $${FLEXPAY_ACH_RETURN_FEE.toFixed(2)})` : '') +
    ' — collected again after a problem on GAM\'s side'
  await c.query(
    `UPDATE payments
        SET status = 'pending', stripe_payment_intent_id = NULL, next_retry_at = NULL,
            amount = $2, gam_supersedence_amount = $3, return_reason = $4, notes = $5
      WHERE id = $1`,
    [a.paymentId, collect.toFixed(2), boost.toFixed(2), FLEXPAY_PULL_REQUEUED_REASON, notes])
  return { oldIntent: oldPi, collect, held: false, requeues: prior + 1 }
}

/**
 * Release a FlexPay collection held after FLEXPAY_MAX_GAM_SIDE_REQUEUES
 * problems on GAM's side (requeueGamSidePull), once a person fixed the cause:
 * the same collection is made again by requeueGamSidePull's own path — the
 * advance back to waiting on its pull, the pull row back to pending with no
 * intent and its amount re-figured (returned-pull fees for the bank returns it
 * already had) — and the next daily pull run makes it. Nothing is held against
 * the tenant either way. A further problem on GAM's side holds it again at
 * once (the count is kept). For the admin FlexPay page to call (the button is
 * not wired yet: routes/admin.ts is outside this step).
 *
 * Returns 'released' with the amount the next pull collects, or why nothing
 * changed: 'not_found', 'not_held' (the collection is not held: made again
 * already, collected, or written off), 'in_flight' (the pull row has money
 * moving).
 */
export async function releaseHeldFlexPayCollection(advanceId: string): Promise<
  { outcome: 'released'; collect: number; paymentId: string } | { outcome: 'not_found' | 'not_held' | 'in_flight' }
> {
  const head = await queryOne<{ tenant_id: string; landlord_id: string }>(
    `SELECT tenant_id, landlord_id FROM flexpay_advances WHERE id = $1`, [advanceId])
  if (!head) return { outcome: 'not_found' }
  const client = await getClient()
  let oldIntent: string | null = null
  let out: { outcome: 'released'; collect: number; paymentId: string } | { outcome: 'not_held' | 'in_flight' }
  try {
    await client.query('BEGIN')
    // The household, then the tenant row, then the advance (lockTenantForFlexPay).
    await lockHousehold(client, head.tenant_id, head.landlord_id)
    await lockTenantForFlexPay(client, head.tenant_id)
    const adv = (await client.query<{ status: string; defaulted_at: string | null; notes: string | null; rent_payment_id: string | null }>(
      `SELECT status, defaulted_at::text AS defaulted_at, notes, rent_payment_id
         FROM flexpay_advances WHERE id = $1 FOR UPDATE`, [advanceId])).rows[0]
    const pull = adv ? (await client.query<{ id: string; status: string; next_retry_at: string | null; retry_count: number | null }>(
      `SELECT id, status, next_retry_at::text AS next_retry_at, retry_count
         FROM payments
        WHERE entry_description = 'FLEXPAY' AND (flexpay_advance_id = $1 OR id = $2)
        ORDER BY (flexpay_advance_id = $1) DESC, created_at DESC
        LIMIT 1 FOR UPDATE`, [advanceId, adv.rent_payment_id])).rows[0] : undefined
    const held = !!adv && !adv.defaulted_at && ['fronted', 'pulled', 'nsf'].includes(adv.status)
      && (adv.notes ?? '').includes(FLEXPAY_HELD_NOTE)
    if (!held || !pull) {
      await client.query('ROLLBACK')
      return { outcome: 'not_held' }
    }
    if (pull.status !== 'failed' || pull.next_retry_at !== null) {
      await client.query('ROLLBACK')
      return { outcome: pull.status === 'processing' ? 'in_flight' : 'not_held' }
    }
    const rq = await requeueGamSidePull(client, {
      paymentId: pull.id, advanceId, tenantId: head.tenant_id,
      bounces: Math.max(0, pull.retry_count ?? 0), why: 'released by a person after the cause was fixed', released: true,
    })
    oldIntent = rq.oldIntent
    await client.query('COMMIT')
    out = { outcome: 'released', collect: rq.collect, paymentId: pull.id }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  await cancelCalledOffPull(oldIntent)
  return out
}

/** Cancel a pull GAM called off, unless Stripe already shows it canceled. Never throws. */
async function cancelCalledOffPull(intentId: string | null): Promise<void> {
  if (!intentId) return
  try {
    const stripe = getStripe()
    const live = await Promise.resolve().then(() => stripe.paymentIntents.retrieve(intentId)).catch(() => null)
    if (live && (live.status === 'canceled' || live.status === 'succeeded' || live.status === 'processing')) return
    await stripe.paymentIntents.cancel(intentId)
  } catch (e) {
    logger.warn({ err: e, intentId }, '[flexpay] a pull GAM called off could not be canceled')
    await alertAdmin('warn', 'flexpay_pull_cancel_failed',
      `A FlexPay pull GAM called off could not be canceled (${intentId})`,
      `GAM will make this collection again; the earlier pull ${intentId} could not be canceled at Stripe (${e instanceof Error ? e.message : String(e)}). Cancel it in Stripe so it is never confirmed.`,
      { stripe_payment_intent_id: intentId })
  }
}

/**
 * Re-price a FlexPay pull right before an ACH RETRY fires (FlexPay terms
 * "failed_pull"; Consumer ToS § 4.1/4.2). The retry collects the amount the
 * cover paid, the flat $25 (S562: a retry never re-prices the fee), and the
 * returned-pull fee for EVERY bounce so far at cost — retry 1 follows one
 * bounce, retry 2 follows two — plus any GAM-first balance (S261). A pull is
 * all-or-nothing, so the new total REPLACES the old one (no double charge).
 *
 * Mutates the EXISTING PaymentIntent's amount and the pull row so the shared
 * achRetry confirm pulls the corrected total. Called by processAchRetries for
 * entry_description='FLEXPAY' rows after it claimed them (retry_count already
 * counts this retry). Throws on failure so the caller skips the confirm.
 */
export async function repriceFlexPayRetryPayment(paymentId: string): Promise<void> {
  const pay = await queryOne<{ stripe_payment_intent_id: string | null; retry_count: number | null }>(
    `SELECT stripe_payment_intent_id, retry_count
       FROM payments
      WHERE id = $1 AND entry_description = 'FLEXPAY'`,
    [paymentId],
  )
  if (!pay || !pay.stripe_payment_intent_id) return  // not a FlexPay PI — nothing to reprice

  // retry_count already counts this retry: retry 1 follows one bounce.
  const q = await quoteFlexPayRetry(paymentId, Math.max(1, pay.retry_count ?? 0))
  if (!q) return  // no linked advance (shouldn't happen) — leave the confirm to run as-is

  const stripe = getStripe()
  await stripe.paymentIntents.update(pay.stripe_payment_intent_id, {
    amount: Math.round(q.amount * 100),
    metadata: {
      gam_purpose:            'flexpay_pull',
      gam_payment_id:         paymentId,
      gam_advance_id:         q.advanceId,
      gam_tenant_id:          q.tenantId,
      gam_covered:            String(q.covered),
      gam_fee:                String(q.fee),
      gam_returned_pull_fees: String(q.returnedPullFees),
      gam_retry:              String(q.bounces),
    },
  })

  const parts = [
    `FlexPay ${sayMonth(q.cycle)} retry ${q.bounces}: bill paid $${q.covered.toFixed(2)}`,
    `monthly fee $${q.fee.toFixed(2)}`,
    `returned-pull fee $${q.returnedPullFees.toFixed(2)} (${q.bounces} × $${FLEXPAY_ACH_RETURN_FEE.toFixed(2)})`,
  ]
  if (q.boost > 0) parts.push(`other GAM balance $${q.boost.toFixed(2)}`)
  await query(
    `UPDATE payments
        SET amount = $1, gam_supersedence_amount = $2, notes = $3
      WHERE id = $4`,
    [q.amount, q.boost.toFixed(2), parts.join(' + '), paymentId],
  )
}

/** What one FlexPay retry collects, part by part (quoteFlexPayRetry). */
interface FlexPayRetryQuote {
  tenantId: string
  advanceId: string
  cycle: string
  /** What the cover paid (the advance's rent_amount). */
  covered: number
  /** The monthly fee, flat (a retry never re-prices it). */
  fee: number
  /** Bounces passed on by this retry: the first try's and every retry's before it. */
  bounces: number
  returnedPullFees: number
  /** Any other GAM balance, as of now (S261 GAM-first routing). */
  boost: number
  amount: number
}

/**
 * What a FlexPay pull's retry collects: the amount the cover paid, the flat
 * $25, the returned-pull fee for EVERY bounce before it at cost (`bounces`:
 * retry 1 follows one, retry 2 follows two), and any other GAM balance as of
 * now. One figure for the reprice and for the tenant's retry notice, so the
 * notice never states less than the retry pulls. Null when the row has no
 * advance.
 */
async function quoteFlexPayRetry(paymentId: string, bounces: number): Promise<FlexPayRetryQuote | null> {
  const row = await queryOne<{ tenant_id: string; flexpay_advance_id: string | null }>(
    `SELECT tenant_id, flexpay_advance_id FROM payments WHERE id = $1 AND entry_description = 'FLEXPAY'`,
    [paymentId])
  if (!row) return null
  const adv = await queryOne<{ id: string; rent_amount: string; tenant_fee_amount: string; cycle_month: string }>(
    `SELECT id, rent_amount::text AS rent_amount, tenant_fee_amount::text AS tenant_fee_amount,
            cycle_month::text AS cycle_month
       FROM flexpay_advances
      WHERE ($2::uuid IS NOT NULL AND id = $2::uuid)
         OR ($2::uuid IS NULL AND rent_payment_id = $1)`,
    [paymentId, row.flexpay_advance_id],
  )
  if (!adv) return null
  const covered = Number(adv.rent_amount)
  const fee = Number(adv.tenant_fee_amount)
  const n = Math.max(1, bounces)
  const returnedPullFees = round2(FLEXPAY_ACH_RETURN_FEE * n)
  const boost = await computeTenantGamOutstandingTotal(row.tenant_id)
  return { tenantId: row.tenant_id, advanceId: adv.id, cycle: adv.cycle_month, covered, fee, bounces: n,
           returnedPullFees, boost, amount: round2(covered + fee + returnedPullFees + boost) }
}

// ── Webhook reconciliation hooks ────────────────────────────────

/**
 * S578: advance a returner's rehab clock on a settled FlexPay pull. A returner
 * (one prior default) sheds the queue demotion only after
 * FLEXPAY_REHAB_CLEAN_PULLS consecutive on-time, FIRST-attempt pulls. A clean
 * pull (retryCount 0) increments the streak; ANY retry (retryCount >= 1) — even
 * one that ultimately cleared — resets the streak to 0. No-op for first-timers
 * (no prior counted write-off: flexPayCountedDefaultSql — a pull GAM could not
 * even create never makes a returner), the permanently banned, and
 * already-cleared returners.
 */
export async function applyFlexPayRehabProgress(tenantId: string, retryCount: number, client?: PoolClient): Promise<void> {
  const clean = retryCount === 0
  const sql =
    `UPDATE tenants t
        SET flexpay_clean_streak =
              CASE WHEN $2 THEN LEAST(t.flexpay_clean_streak + 1, $3) ELSE 0 END,
            flexpay_returner_cleared =
              CASE WHEN $2 AND t.flexpay_clean_streak + 1 >= $3 THEN TRUE
                   ELSE t.flexpay_returner_cleared END,
            updated_at = NOW()
      WHERE t.id = $1
        AND t.flexpay_permanently_banned = FALSE
        AND t.flexpay_returner_cleared   = FALSE
        AND EXISTS (SELECT 1 FROM flexpay_advances fa
                     WHERE fa.tenant_id = t.id AND ${flexPayCountedDefaultSql('fa')})`
  const params = [tenantId, clean, FLEXPAY_REHAB_CLEAN_PULLS]
  if (client) await client.query(sql, params)
  else await query(sql, params)
}

/**
 * The platform_revenue_ledger reference_type of a reversal of FlexPay's $25
 * (handleFlexPayPullReversed). A second reversal of the same advance (booked
 * again on recovery, then taken back again) gets a numbered suffix. The admin
 * revenue pie nets these inside its FlexPay slice (routes/admin.ts).
 */
export const FLEXPAY_FEE_REVERSAL_REF = 'flexpay_advance_reversal'

/**
 * The stamp handleFlexPayPullReversed puts on a pull row it acted on
 * (payments.return_reason), so one pull is written off as taken back once.
 * Plain words: it is what an admin reads on the row.
 */
export const FLEXPAY_PULL_TAKEN_BACK_REASON = 'FlexPay pull taken back by the bank after it settled'

/** GAM balances GAM-first routing pays, by name (services/supersedence sources), for admin text. */
const GAM_BALANCE_LABEL: Record<string, string> = {
  flexdeposit_installment: 'FlexDeposit installment',
  flexcharge_statement:    'FlexCharge statement',
  flexpay_advance:         'FlexPay advance',
  custody_charge:          'FlexDeposit custody fee',
}

/**
 * What GAM's book holds for one advance's $25 right now: every
 * 'flexpay_subscription' row for it, less every reversal of it.
 */
async function flexPayFeeOnBook(advanceId: string, exec: (sql: string, params: unknown[]) => Promise<any[]>): Promise<{
  net: number; bookings: number; reversals: number
}> {
  const [r] = await exec(
    `SELECT COALESCE(SUM(amount), 0)::text AS net,
            COUNT(*) FILTER (WHERE type = 'flexpay_subscription')::int AS bookings,
            COUNT(*) FILTER (WHERE type = 'adjustment')::int AS reversals
       FROM platform_revenue_ledger
      WHERE reference_id = $1
        AND (type = 'flexpay_subscription'
             OR (type = 'adjustment' AND reference_type LIKE '${FLEXPAY_FEE_REVERSAL_REF}%'))`,
    [advanceId])
  return { net: round2(Number(r?.net ?? 0)), bookings: Number(r?.bookings ?? 0), reversals: Number(r?.reversals ?? 0) }
}

/**
 * Book FlexPay's monthly fee for one advance as GAM earnings
 * ('flexpay_subscription') — once while it stands: a call when the $25 is
 * already on the book does nothing. After a pull was taken back and its $25
 * reversed (handleFlexPayPullReversed), recovering the advance books it again
 * (a numbered reference, so the per-reference guard in recordPlatformRevenue
 * lets exactly one through). Exported so the GAM-first recovery of a
 * defaulted advance (services/supersedence) can book the fee it recovers.
 * Callers hold the advance row (its status flip) so two calls cannot race.
 * Inside a transaction, pass its client (recordPlatformRevenue: without one a
 * caller already holding the ledger lock would wait on itself).
 */
export async function bookFlexPayFee(advanceId: string, client?: PoolClient): Promise<void> {
  const exec = async (sql: string, params: unknown[]) =>
    client ? (await client.query(sql, params)).rows : query<any>(sql, params as any[])
  const [adv] = await exec(
    `SELECT a.tenant_fee_amount::text AS fee, a.cycle_month::text AS cycle, u.property_id
       FROM flexpay_advances a LEFT JOIN units u ON u.id = a.unit_id
      WHERE a.id = $1`, [advanceId]) as Array<{ fee: string; cycle: string; property_id: string | null }>
  if (!adv) return
  const book = await flexPayFeeOnBook(advanceId, exec)
  if (book.net > 0.005) return
  await recordPlatformRevenue({
    type:          'flexpay_subscription',
    // The monthly fee only. A returned-pull or dispute fee is Stripe's cost
    // passed on at cost, never GAM earnings.
    amount:        Math.min(Number(adv.fee), FLEXPAY_MONTHLY_FEE),
    referenceId:   advanceId,
    referenceType: book.bookings === 0 ? 'flexpay_advance' : `flexpay_advance_rebooked_${book.bookings}`,
    propertyId:    adv.property_id,
    notes:         book.bookings === 0
      ? `FlexPay monthly fee — ${sayMonth(adv.cycle)}`
      : `FlexPay monthly fee — ${sayMonth(adv.cycle)} (booked again: recovered after its pull was taken back)`,
  }, client)
}

/**
 * Take an advance's $25 back off GAM's book (a negative 'adjustment' for what
 * is on the book now), when the money that paid it was taken back. Nothing when
 * nothing is booked. Run inside the caller's transaction.
 */
async function reverseFlexPayFee(advanceId: string, client: PoolClient, why: string): Promise<number> {
  const exec = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows
  const book = await flexPayFeeOnBook(advanceId, exec)
  if (book.net <= 0.005) return 0
  const [adv] = await exec(
    `SELECT a.cycle_month::text AS cycle, u.property_id
       FROM flexpay_advances a LEFT JOIN units u ON u.id = a.unit_id WHERE a.id = $1`,
    [advanceId]) as Array<{ cycle: string; property_id: string | null }>
  await recordPlatformRevenue({
    type:          'adjustment',
    amount:        -book.net,
    referenceId:   advanceId,
    referenceType: book.reversals === 0 ? FLEXPAY_FEE_REVERSAL_REF : `${FLEXPAY_FEE_REVERSAL_REF}_${book.reversals + 1}`,
    propertyId:    adv?.property_id ?? null,
    notes:         `FlexPay monthly fee — ${adv ? sayMonth(adv.cycle) : 'month'} reversed: ${why}`,
  }, client)
  return book.net
}

/**
 * The FlexPay pull settled (payment_intent.succeeded): the advance is
 * reconciled, the returner rehab clock moves, and the $25 is booked as
 * 'flexpay_subscription'. Found by payments.flexpay_advance_id (a pull written
 * before S655 by rent_payment_id). Idempotent: a redelivered success finds the
 * advance already reconciled and books nothing again.
 *
 * Pass `client` to run inside the caller's transaction (the webhook settle).
 * Inside a transaction, always pass it: the settle holds the ledger lock, and
 * a write on another connection would wait on it (recordPlatformRevenue).
 */
export async function reconcileSettledFlexPayPayment(paymentId: string, client?: PoolClient): Promise<void> {
  const exec = async <T extends Record<string, any>>(sql: string, params: unknown[]): Promise<T[]> =>
    client ? (await client.query<T>(sql, params)).rows : query<T>(sql, params as any[])

  const [payment] = await exec<{
    tenant_id: string; entry_description: string | null; retry_count: number | null
    flexpay_advance_id: string | null; status: string
  }>(
    `SELECT tenant_id, entry_description, retry_count, flexpay_advance_id, status
       FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!payment || payment.entry_description !== 'FLEXPAY' || payment.status !== 'settled') return

  // Inside a transaction: the tenant row before the advance, the cover's lock
  // order (lockTenantForFlexPay); the rehab step below writes the tenant row.
  if (client) await lockTenantForFlexPay(client, payment.tenant_id)
  const flipped = await exec<{ id: string }>(
    `UPDATE flexpay_advances
        SET status        = 'reconciled',
            reconciled_at = NOW(),
            updated_at    = NOW()
      WHERE rent_payment_id = $1
        AND ($2::uuid IS NULL OR id = $2::uuid)
        AND status IN ('fronted', 'pulled')
      RETURNING id`,
    [paymentId, payment.flexpay_advance_id],
  )
  // S578: rehab progress and the fee run ONLY when this call performed the
  // flip, so repeated success webhooks never double-count or double-book.
  if (flipped.length > 0) {
    await applyFlexPayRehabProgress(payment.tenant_id, payment.retry_count ?? 0, client)
    await bookFlexPayFee(flipped[0].id, client)
  }
}

/**
 * Lock the tenant row and say whether FlexPay is still on for them. Every path
 * here that changes an advance takes the tenant row FIRST and the advance
 * second — the cover's order (household, tenant, advance, bill lines) — so two
 * of them meeting on one tenant wait for each other instead of deadlocking
 * (Postgres would abort one: the cover then alerts, a webhook gets a 500).
 */
async function lockTenantForFlexPay(c: PoolClient, tenantId: string): Promise<boolean> {
  const r = await c.query<{ e: boolean }>(
    `SELECT flexpay_enrolled AS e FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId])
  return !!r.rows[0]?.e
}

/**
 * The tenant's mark for a write-off at their bank (S578, terms §4.3): FlexPay
 * ends with the rejoin wait — or for good when FlexPay already ended for them
 * before (earlierFlexPayEndingSql: another counted write-off, or an earlier
 * enrollment ended because bank payments were stopped). Lifetime: one
 * recovered since by GAM-first routing still counts; one GAM caused never
 * does (flexPayCountedDefaultSql). Call AFTER the advance was flipped, so it
 * is counted. Returns whether this was the ban.
 */
async function markTenantForWriteOff(
  c: PoolClient, tenantId: string, reason: string = FLEXPAY_DEFAULT_REASONS.pullNotCollected,
): Promise<boolean> {
  const r = await c.query<{ permanent: boolean }>(
    `SELECT ${earlierFlexPayEndingSql('t', 1)} AS permanent FROM tenants t WHERE t.id = $1`, [tenantId])
  const permanent = !!r.rows[0]?.permanent
  if (permanent) {
    // The ban flag is the gate; clear disqualified_until so nothing reads
    // it as a wait that "expires".
    await c.query(
      `UPDATE tenants
          SET flexpay_enrolled            = FALSE,
              flexpay_pull_day            = NULL,
              flexpay_monthly_fee         = NULL,
              flexpay_clean_streak        = 0,
              flexpay_permanently_banned  = TRUE,
              flexpay_disqualified_until  = NULL,
              flexpay_disqualified_reason = 'permanent_second_default'
        WHERE id = $1`,
      [tenantId],
    )
  } else {
    // First ending: the rejoin wait (FlexPay terms "rejoining").
    await c.query(
      `UPDATE tenants
          SET flexpay_enrolled            = FALSE,
              flexpay_pull_day            = NULL,
              flexpay_monthly_fee         = NULL,
              flexpay_clean_streak        = 0,
              flexpay_disqualified_until  = NOW() + make_interval(days => $2::int),
              flexpay_disqualified_reason = $3
        WHERE id = $1`,
      [tenantId, FLEXPAY_NSF_COOLDOWN_DAYS, reason],
    )
  }
  return permanent
}

/**
 * FlexPay ends because bank payments are stopped on the tenant or no verified
 * bank is on file (terms §4.3 "Bank payments stopped"), with no write-off:
 * the rejoin wait, or for good when FlexPay already ended for them before
 * (earlierFlexPayEndingSql). One statement, only while still enrolled (and,
 * with `onlyWhenBankUnusable`, only while the bank is still unusable), so a
 * second call changes nothing. Returns null when it ended nothing.
 */
async function endFlexPayForStoppedBank(
  run: (sql: string, params: unknown[]) => Promise<any[]>, tenantId: string, onlyWhenBankUnusable: boolean,
): Promise<{ noBank: boolean; permanent: boolean } | null> {
  const second = earlierFlexPayEndingSql('t', 0)
  const rows = await run(
    `UPDATE tenants t
        SET flexpay_enrolled = FALSE, flexpay_pull_day = NULL, flexpay_monthly_fee = NULL,
            flexpay_clean_streak = 0,
            flexpay_permanently_banned = t.flexpay_permanently_banned OR ${second},
            flexpay_disqualified_until = CASE WHEN ${second} THEN NULL
              ELSE GREATEST(COALESCE(t.flexpay_disqualified_until, NOW()), NOW() + make_interval(days => $2::int)) END,
            flexpay_disqualified_reason = CASE WHEN ${second} THEN 'permanent_second_default' ELSE $3 END,
            updated_at = NOW()
      WHERE t.id = $1 AND t.flexpay_enrolled = TRUE
        AND (NOT $4::boolean OR t.ach_suspended_at IS NOT NULL OR t.ach_verified = FALSE)
      RETURNING (t.ach_suspended_at IS NULL AND NOT COALESCE(t.ach_verified, FALSE)) AS no_bank,
                t.flexpay_permanently_banned AS permanent`,
    [tenantId, FLEXPAY_NSF_COOLDOWN_DAYS, FLEXPAY_DEFAULT_REASONS.bankUnavailable, onlyWhenBankUnusable])
  return rows[0] ? { noBank: !!rows[0].no_bank, permanent: !!rows[0].permanent } : null
}

/**
 * A FlexPay pull FAILED FOR GOOD: the last retry, or a first try the shared
 * retry pipeline would not repeat (a closed account). Called by the webhook on
 * any terminal failure; it checks for itself that the failure is terminal (the
 * row is 'failed' with no retry scheduled), so a call while a retry is still
 * coming changes nothing.
 *
 * The advance is written off and recovered only by GAM-first routing on the
 * tenant's next payment (S542). Every returned-pull fee Stripe charged GAM for
 * this pull joins what is written off (tenant_fee_amount), so GAM-first
 * routing recovers it and GAM never keeps a fee: one per bounce — the first
 * try plus each retry (retry_count + 1). bookFlexPayFee books only the $25 of
 * it as earnings. FlexPay ends: a 90-day wait before rejoining, or for good on
 * a second written-off advance (S578). An admin is alerted.
 *
 * `gamSide`: the pull ended on GAM's side, not at the tenant's bank — GAM
 * canceled it (a retry it could not re-price, send or confirm), or Stripe
 * refused GAM's own request for it (decisions #37.D, terms §4.3 "A problem on
 * GAM's side"). Nothing is written off and nothing is held against the
 * tenant: FlexPay stays on, no rejoin wait starts, it never counts toward a
 * ban, and the same collection is made again by the next daily pull run
 * (requeueGamSidePull) — the bank returns it already had stay counted, so the
 * try collects their returned-pull fees (retry_count: the try GAM ended never
 * reached the bank) and the bank never sees it more than the terms allow.
 * After FLEXPAY_MAX_GAM_SIDE_REQUEUES such problems the collection is held
 * for a person instead (`held`). An admin is told either way, to fix the
 * cause. A debit the tenant's bank refused or returned is NEVER gamSide,
 * readable reason or not (achRetry.bankRefusedDebit).
 *
 * Returns whether it wrote the advance off, and `afterCommit`: the admin alert
 * and the tenant's "FlexPay has ended" notice. Without `client` this function
 * commits its own transaction and has already sent them (afterCommit does
 * nothing). With `client` it runs inside the caller's transaction and sends
 * nothing: the caller runs afterCommit AFTER its COMMIT, never before — a
 * rollback would have told the tenant FlexPay ended when nothing changed, and
 * a redelivery would tell them twice.
 */
export async function handleFlexPayPaymentNsf(
  paymentId: string, client?: PoolClient, opts: { gamSide?: boolean; why?: string | null } = {},
): Promise<{ wroteOff: boolean; requeued?: boolean; held?: boolean; afterCommit: () => Promise<void> }> {
  const own = !client
  const c = client ?? await getClient()
  const nothing = { wroteOff: false, afterCommit: async () => {} }
  const reason = FLEXPAY_DEFAULT_REASONS.pullNotCollected
  let alert: {
    cycle: string; advanceId: string; tenantId: string; permanent: boolean; written: number; fees: number
    facts: FlexPayEndedFacts | null
  } | null = null
  try {
    if (own) await c.query('BEGIN')
    const payment = (await c.query<{
      tenant_id: string; entry_description: string | null; status: string
      next_retry_at: string | null; flexpay_advance_id: string | null; retry_count: number | null
    }>(
      `SELECT tenant_id, entry_description, status, next_retry_at, flexpay_advance_id, retry_count
         FROM payments WHERE id = $1`,
      [paymentId])).rows[0]
    const terminal = !!payment && payment.entry_description === 'FLEXPAY'
      && payment.status === 'failed' && payment.next_retry_at === null
    if (!terminal) {
      if (own) await c.query('ROLLBACK')
      return nothing
    }
    // The lock order the cover uses (tenant, then advance), so a cover of a
    // second bill running at this moment waits here instead of deadlocking.
    // Was FlexPay still on? (A tenant who canceled has a covered month collected after.)
    const wasEnrolled = await lockTenantForFlexPay(c, payment!.tenant_id)
    const adv = (await c.query<{ id: string; cycle_month: string }>(
      `SELECT id, cycle_month::text AS cycle_month
         FROM flexpay_advances
        WHERE (($2::uuid IS NOT NULL AND id = $2::uuid)
               OR ($2::uuid IS NULL AND rent_payment_id = $1))
          AND status IN ('fronted', 'pulled', 'nsf')
        FOR UPDATE`,
      [paymentId, payment!.flexpay_advance_id])).rows[0]
    if (!adv) {
      if (own) await c.query('ROLLBACK')
      return nothing
    }

    const retries = Math.max(0, payment!.retry_count ?? 0)
    // A GAM-side failure (decisions #37.D): never the tenant's mark — FlexPay
    // stays on and GAM makes the collection again (requeueGamSidePull). Only
    // the bank returns that already happened (the retries fired) are passed on.
    if (opts.gamSide) {
      const rq = await requeueGamSidePull(c, {
        paymentId, advanceId: adv.id, tenantId: payment!.tenant_id, bounces: retries, why: opts.why ?? null,
      })
      if (own) await c.query('COMMIT')
      const cycle = adv.cycle_month
      const tenantId = payment!.tenant_id
      let sent = false
      const send = async (): Promise<void> => {
        if (sent) return
        sent = true
        await cancelCalledOffPull(rq.oldIntent)
        if (rq.held) {
          await alertAdmin('critical', 'flexpay_pull_gam_side_held',
            `A FlexPay collection is held: it failed on GAM's side ${rq.requeues} times — ${cycle}`,
            `Tenant ${tenantId}'s FlexPay collection for ${cycle} (advance ${adv.id}, pull row ${paymentId}) failed on GAM's side again` +
            (opts.why ? ` (${opts.why})` : '') + `, after being made again ${rq.requeues} times. It is held: nothing more is pulled until a person releases it. ` +
            'Nothing is held against the tenant: their FlexPay stays on and no wait starts. Fix the cause, then release the held ' +
            `collection for advance ${adv.id}; the next daily pull run makes it.`,
            { advance_id: adv.id, payment_id: paymentId, tenant_id: tenantId, cycle, requeues: rq.requeues, gam_side: true, held: true })
          return
        }
        await alertAdmin('critical', 'flexpay_pull_gam_side',
          `A FlexPay collection failed on GAM's side — ${cycle}`,
          `Tenant ${tenantId}'s FlexPay collection for ${cycle} (advance ${adv.id}, pull row ${paymentId}) failed on GAM's side` +
          (opts.why ? ` (${opts.why})` : '') + '. Nothing is held against the tenant: their FlexPay stays on and no wait starts. ' +
          `The collection ($${rq.collect.toFixed(2)}) is made again by the next daily pull run. Fix the cause before then.`,
          { advance_id: adv.id, payment_id: paymentId, tenant_id: tenantId, cycle, collect: rq.collect, gam_side: true })
      }
      const done = { wroteOff: false, requeued: !rq.held, held: rq.held }
      if (own) { await send(); return { ...done, afterCommit: async () => {} } }
      return { ...done, afterCommit: send }
    }
    const bounces = retries + 1
    const fees = round2(FLEXPAY_ACH_RETURN_FEE * bounces)
    const written = (await c.query<{ written: string }>(
      `UPDATE flexpay_advances
          SET status            = 'defaulted',
              defaulted_at      = NOW(),
              default_reason    = $2,
              tenant_fee_amount = tenant_fee_amount + $3,
              notes = CASE WHEN $3::numeric > 0
                           THEN COALESCE(notes || ' ', '') || $4
                           ELSE notes END,
              updated_at        = NOW()
        WHERE id = $1
        RETURNING (rent_amount + tenant_fee_amount)::text AS written`,
      [adv.id, reason, fees,
       `Written off with ${bounces} returned-pull fee(s), $${fees.toFixed(2)}, passed on at cost.`],
    )).rows[0].written
    const permanent = await markTenantForWriteOff(c, payment!.tenant_id)
    // Read inside the transaction, so the write-off and the rejoin day are seen.
    const facts = await readFlexPayEndedFacts(payment!.tenant_id, async (sql, p) => (await c.query(sql, p)).rows, wasEnrolled)
    if (own) await c.query('COMMIT')
    alert = { cycle: adv.cycle_month, advanceId: adv.id, tenantId: payment!.tenant_id, permanent,
              written: Number(written), fees, facts }
  } catch (e) {
    if (own) await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (own) c.release()
  }
  if (!alert) return nothing
  const done = alert
  let sent = false
  const send = async (): Promise<void> => {
    if (sent) return
    sent = true
    await sendPullNotCollectedNotices(paymentId, done)
  }
  if (own) {
    await send()
    return { wroteOff: true, afterCommit: async () => {} }
  }
  return { wroteOff: true, afterCommit: send }
}

/** handleFlexPayPaymentNsf's admin alert and tenant notice, after the commit. */
async function sendPullNotCollectedNotices(paymentId: string, alert: {
  cycle: string; advanceId: string; tenantId: string; permanent: boolean; written: number; fees: number
  facts: FlexPayEndedFacts | null
}): Promise<void> {
  const amounts = `$${alert.written.toFixed(2)} is written off` +
    (alert.fees > 0 ? `, including $${alert.fees.toFixed(2)} of returned-pull fees passed on at cost` : '')
  await alertAdmin('warn', 'flexpay_advance_defaulted',
    alert.permanent
      ? `FlexPay ended for good (second write-off) — ${alert.cycle}`
      : `FlexPay pull not collected — ${alert.cycle}`,
    alert.permanent
      ? `Tenant ${alert.tenantId}'s FlexPay pull for ${alert.cycle} failed on its last try; advance ${alert.advanceId} is written off and is recovered only by GAM-first routing on their next payment: ${amounts}. This is their second write-off, so they can never rejoin FlexPay.`
      : `Tenant ${alert.tenantId}'s FlexPay pull for ${alert.cycle} failed on its last try; advance ${alert.advanceId} is written off and is recovered only by GAM-first routing on their next payment: ${amounts}. They cannot rejoin FlexPay for ${FLEXPAY_NSF_COOLDOWN_DAYS} days.`,
    { advance_id: alert.advanceId, payment_id: paymentId, cycle: alert.cycle, tenant_id: alert.tenantId,
      written_off: alert.written, returned_pull_fees: alert.fees })
  await notifyTenantFlexPayEnded(alert.tenantId, { kind: 'not_collected', cycle: alert.cycle }, alert.facts)
}

/**
 * The GAM balances a payment's GAM-first part paid (payments.
 * gam_supersedence_breakdown, services/supersedence), opened again because the
 * money that paid them was taken back (a dispute or a bank return): the
 * tenant owes them again, exactly as before that payment. Whole balances only,
 * the last one paid first, up to `upToCents` (+Infinity: all of them); a
 * FlexPay advance goes back to written off and its $25 comes off GAM's book
 * (booked again when GAM-first routing recovers it). Other products' balances
 * (FlexDeposit, FlexCharge — both off) are returned for a person to reopen.
 * `unplacedCents`: GAM-first money lost that no whole balance carried (a
 * balance bigger than what is left to place) — a person bills it. Runs in the
 * caller's transaction, which holds the tenant row (lock order: tenant, then
 * advance).
 */
export async function reopenGamFirstBalances(
  c: PoolClient,
  a: { paymentId: string; upToCents: number; skipAdvanceId?: string | null; why: string },
): Promise<{ reopenedCents: number; alsoReopened: string[]; feeReversed: number
             othersToReopen: Array<{ source: string; ref_id: string; amount: number }>; unplacedCents: number }> {
  const pay = (await c.query<{ breakdown: any }>(
    `SELECT gam_supersedence_breakdown AS breakdown FROM payments WHERE id = $1`, [a.paymentId])).rows[0]
  const items: Array<{ source?: string; ref_id?: string; amount?: number; residual?: boolean }> =
    Array.isArray(pay?.breakdown) ? pay.breakdown : []
  const applied = items.filter(i => !i.residual && i.source && i.ref_id && Number(i.amount ?? 0) > 0)
  const cents = (v: number) => Math.round(v * 100)
  // What of the lost money went to balances at all (a residual sat unapplied).
  const target = Math.min(a.upToCents, applied.reduce((s, i) => s + cents(Number(i.amount)), 0))
  let left = target
  let feeReversed = 0
  const alsoReopened: string[] = []
  const othersToReopen: Array<{ source: string; ref_id: string; amount: number }> = []
  for (const item of [...applied].reverse()) {
    const amt = cents(Number(item.amount))
    if (amt > left) continue
    if (item.source === 'flexpay_advance') {
      if (item.ref_id === a.skipAdvanceId) continue
      const re = await c.query(
        `UPDATE flexpay_advances
            SET status = 'defaulted', reconciled_at = NULL,
                notes = COALESCE(notes || ' ', '') || $2, updated_at = NOW()
          WHERE id = $1 AND status = 'reconciled' AND defaulted_at IS NOT NULL
          RETURNING id`,
        [item.ref_id, `Written off again: ${a.why}.`])
      if ((re.rowCount ?? 0) > 0) {
        alsoReopened.push(item.ref_id!)
        feeReversed = round2(feeReversed + await reverseFlexPayFee(item.ref_id!, c, a.why))
      }
    } else {
      othersToReopen.push({ source: item.source!, ref_id: item.ref_id!, amount: Number(item.amount ?? 0) })
    }
    left -= amt
  }
  return {
    reopenedCents: target - left, alsoReopened, feeReversed, othersToReopen,
    unplacedCents: Number.isFinite(a.upToCents) ? Math.max(0, left) : 0,
  }
}

/**
 * A FlexPay pull that SETTLED and was later taken back — an ACH "unauthorized"
 * return, which can come up to 60 days after the money arrived and which Stripe
 * sends as charge.dispute.created on a us_bank_account charge. The dispute and
 * late-return handler (routes/webhooks.ts) calls this for a row with
 * entry_description 'FLEXPAY' INSTEAD of reopening it: a FlexPay pull is GAM's
 * own money and never a tenant charge (a fresh pending FLEXPAY row would be
 * collected by nothing — payableRowSql leaves FLEXPAY rows out and the pull
 * run takes only 'fronted' advances).
 *
 * In one transaction:
 *   - the pull row goes 'returned' (it may already be);
 *   - its advance (reconciled, or still 'pulled' if the settle never
 *     reconciled it) is written off again as the tenant's
 *     ('pull_not_collected'), with the returned-pull fees the pull carried
 *     (retry_count) and Stripe's fee for the reversal (`reversalFee`, the
 *     dispute's own fee — the caller passes it) added to tenant_fee_amount, so
 *     GAM-first routing recovers every dollar and GAM keeps no fee;
 *   - the $25 booked for it comes back off GAM's book (a negative
 *     'adjustment'); recovering the advance later books it again;
 *   - a written-off FlexPay advance this pull had recovered by GAM-first
 *     routing is written off again too (the money that paid it is gone), its
 *     $25 reversed the same way; any other GAM balance it paid (a FlexDeposit
 *     installment, a FlexCharge statement, a custody charge) is named to an
 *     admin to reopen;
 *   - the tenant takes the mark exactly as for a terminal failure: FlexPay
 *     ends with the rejoin wait, for good on a second counted write-off.
 * An admin is alerted, and the tenant is told FlexPay ended.
 *
 * Acts ONCE per pull, on the pull row's own transition: the row is stamped
 * 'returned' with return_reason FLEXPAY_PULL_TAKEN_BACK_REASON here, and a
 * row already carrying that stamp is never acted on again. So a redelivered
 * dispute, or a dispute and a late return for the same pull, changes nothing
 * the second time — even after GAM-first routing has recovered the advance
 * and it reads 'reconciled' again (the advance's status alone cannot tell a
 * second call from a first). Callers never pre-flip or stamp a FLEXPAY row
 * themselves; a row a caller already set 'returned' without the stamp is
 * still acted on once.
 *
 * The stamp lives in payments.return_reason, which other writers also set (the
 * returned-payment route, paymentReversal). So the advance carries a second
 * guard no other writer can erase: the pull's own advance can hold
 * defaulted_at while it is 'pulled' or 'reconciled' only after it was already
 * written off — by this function, or by a failed pull (whose row never
 * settled) — and later recovered by GAM-first routing on other payments.
 * Such an advance is never written off again from this pull.
 *
 * Returns whether it acted, and `afterCommit`: the admin alert and the
 * tenant's "FlexPay has ended" notice. Without `client` this function commits
 * its own transaction and has already sent them (afterCommit does nothing).
 * With `client` it runs inside the caller's transaction and sends nothing: the
 * caller runs afterCommit AFTER its COMMIT, never before — a rollback would
 * have told the tenant FlexPay ended when nothing changed, and a redelivery
 * would tell them twice.
 */
export async function handleFlexPayPullReversed(
  paymentId: string, client?: PoolClient, opts: { reversalFee?: number } = {},
): Promise<{ reversed: boolean; afterCommit: () => Promise<void> }> {
  const own = !client
  const c = client ?? await getClient()
  const nothing = { reversed: false, afterCommit: async () => {} }
  let alert: {
    cycle: string; advanceId: string; tenantId: string; permanent: boolean; written: number
    fees: number; feeReversed: number; alsoReopened: string[]; othersToReopen: Array<{ source: string; ref_id: string; amount: number }>
    facts: FlexPayEndedFacts | null
  } | null = null
  try {
    if (own) await c.query('BEGIN')
    // The tenant row first, then the pull row and its advance: the cover's
    // lock order (tenant, then advance), so a cover of a second bill running
    // at this moment waits here instead of deadlocking.
    const owner = (await c.query<{ tenant_id: string; entry_description: string | null }>(
      `SELECT tenant_id, entry_description FROM payments WHERE id = $1`, [paymentId])).rows[0]
    if (!owner || owner.entry_description !== 'FLEXPAY') {
      if (own) await c.query('ROLLBACK')
      return nothing
    }
    const wasEnrolled = await lockTenantForFlexPay(c, owner.tenant_id)
    const pay = (await c.query<{
      tenant_id: string; entry_description: string | null; status: string; retry_count: number | null
      flexpay_advance_id: string | null; gam_supersedence_breakdown: any; return_reason: string | null
    }>(
      `SELECT tenant_id, entry_description, status, retry_count, flexpay_advance_id, gam_supersedence_breakdown,
              return_reason
         FROM payments WHERE id = $1 FOR UPDATE`,
      [paymentId])).rows[0]
    const firstTime = !!pay && (pay.status === 'settled'
      || (pay.status === 'returned' && pay.return_reason !== FLEXPAY_PULL_TAKEN_BACK_REASON))
    if (!pay || pay.entry_description !== 'FLEXPAY' || !firstTime) {
      if (own) await c.query('ROLLBACK')
      return nothing
    }
    const adv = (await c.query<{ id: string; cycle_month: string; defaulted_at: string | null }>(
      `SELECT id, cycle_month::text AS cycle_month, defaulted_at::text AS defaulted_at
         FROM flexpay_advances
        WHERE (($2::uuid IS NOT NULL AND id = $2::uuid)
               OR ($2::uuid IS NULL AND rent_payment_id = $1))
          AND status IN ('pulled', 'reconciled')
        FOR UPDATE`,
      [paymentId, pay.flexpay_advance_id])).rows[0]
    if (!adv) {
      if (own) await c.query('ROLLBACK')
      return nothing
    }
    // Already written off once (see above): the row's stamp was overwritten by
    // another writer, or the pull never settled. Never a second write-off.
    if (adv.defaulted_at) {
      if (own) await c.query('ROLLBACK')
      logger.info({ payment_id: paymentId, advance_id: adv.id },
        '[flexpay] taken-back pull: its advance was already written off once; nothing changed')
      return nothing
    }

    // The stamp that makes this happen once per pull (see above).
    await c.query(
      `UPDATE payments SET status = 'returned', return_reason = $2 WHERE id = $1`,
      [paymentId, FLEXPAY_PULL_TAKEN_BACK_REASON])

    const bounceFees = round2(FLEXPAY_ACH_RETURN_FEE * Math.max(0, pay.retry_count ?? 0))
    const reversalFee = round2(Math.max(0, Number(opts.reversalFee ?? 0)))
    const fees = round2(bounceFees + reversalFee)
    const written = (await c.query<{ written: string }>(
      `UPDATE flexpay_advances
          SET status            = 'defaulted',
              defaulted_at      = NOW(),
              default_reason    = $2,
              reconciled_at     = NULL,
              tenant_fee_amount = tenant_fee_amount + $3,
              notes = COALESCE(notes || ' ', '') || $4,
              updated_at        = NOW()
        WHERE id = $1
        RETURNING (rent_amount + tenant_fee_amount)::text AS written`,
      [adv.id, FLEXPAY_DEFAULT_REASONS.pullNotCollected, fees,
       `The pull was taken back by the bank on ${new Date().toISOString().slice(0, 10)}; written off again` +
       (fees > 0 ? ` with $${fees.toFixed(2)} of Stripe fees passed on at cost.` : '.')],
    )).rows[0].written
    let feeReversed = await reverseFlexPayFee(adv.id, c, 'its pull was taken back by the bank')

    // What this pull's GAM-first part paid is unpaid again.
    const re = await reopenGamFirstBalances(c, {
      paymentId, upToCents: Number.POSITIVE_INFINITY, skipAdvanceId: adv.id,
      why: `the FlexPay pull that recovered it (${paymentId}) was taken back`,
    })
    const alsoReopened = re.alsoReopened
    const othersToReopen = re.othersToReopen
    feeReversed = round2(feeReversed + re.feeReversed)

    const permanent = await markTenantForWriteOff(c, pay.tenant_id)
    const facts = await readFlexPayEndedFacts(pay.tenant_id, async (sql, p) => (await c.query(sql, p)).rows, wasEnrolled)
    if (own) await c.query('COMMIT')
    alert = { cycle: adv.cycle_month, advanceId: adv.id, tenantId: pay.tenant_id, permanent,
              written: Number(written), fees, feeReversed, alsoReopened, othersToReopen, facts }
  } catch (e) {
    if (own) await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (own) c.release()
  }
  if (!alert) return nothing
  const done = alert
  let sent = false
  const send = async (): Promise<void> => {
    if (sent) return
    sent = true
    await sendPullReversedNotices(paymentId, done)
  }
  if (own) {
    await send()
    return { reversed: true, afterCommit: async () => {} }
  }
  return { reversed: true, afterCommit: send }
}

/** handleFlexPayPullReversed's admin alert and tenant notice, after the commit. */
async function sendPullReversedNotices(paymentId: string, alert: {
  cycle: string; advanceId: string; tenantId: string; permanent: boolean; written: number
  fees: number; feeReversed: number; alsoReopened: string[]; othersToReopen: Array<{ source: string; ref_id: string; amount: number }>
  facts: FlexPayEndedFacts | null
}): Promise<void> {
  const others = alert.othersToReopen.length > 0
    ? ` The pull had also paid other GAM balances by GAM-first routing that are unpaid again and must be reopened by hand: ` +
      alert.othersToReopen.map(o => `${GAM_BALANCE_LABEL[o.source] ?? 'GAM balance'} ${o.ref_id} ($${o.amount.toFixed(2)})`).join(', ') + '.'
    : ''
  const reopened = alert.alsoReopened.length > 0
    ? ` FlexPay advance(s) it had recovered are written off again: ${alert.alsoReopened.join(', ')}.`
    : ''
  await alertAdmin('critical', 'flexpay_pull_taken_back',
    alert.permanent
      ? `FlexPay pull taken back; FlexPay ended for good — ${alert.cycle}`
      : `FlexPay pull taken back by the bank — ${alert.cycle}`,
    `Tenant ${alert.tenantId}'s FlexPay pull for ${alert.cycle} (payment ${paymentId}) had settled and was taken back by their bank. ` +
    `Advance ${alert.advanceId} is written off again ($${alert.written.toFixed(2)}` +
    (alert.fees > 0 ? `, including $${alert.fees.toFixed(2)} of Stripe fees passed on at cost` : '') +
    `) and is recovered only by GAM-first routing on their next payment. ` +
    (alert.feeReversed > 0 ? `$${alert.feeReversed.toFixed(2)} of FlexPay fees booked as earnings were reversed. ` : '') +
    (alert.permanent
      ? 'This is their second write-off, so they can never rejoin FlexPay.'
      : `They cannot rejoin FlexPay for ${FLEXPAY_NSF_COOLDOWN_DAYS} days.`) +
    reopened + others,
    { advance_id: alert.advanceId, payment_id: paymentId, cycle: alert.cycle, tenant_id: alert.tenantId,
      written_off: alert.written, fees_added: alert.fees, fee_reversed: alert.feeReversed,
      also_written_off: alert.alsoReopened, other_gam_balances_to_reopen: alert.othersToReopen })
  await notifyTenantFlexPayEnded(alert.tenantId, { kind: 'taken_back', cycle: alert.cycle }, alert.facts)
}

/**
 * Auto-disenroll when bank payments are stopped on the tenant (the returned-
 * payment handler's zero-tolerance block) — GAM can't pull funds, so FlexPay
 * can't operate. Decisions #37.D / terms §4.3 "Bank payments stopped": the
 * tenant's side — FlexPay ends and the 90-day rejoin wait applies (joining
 * again also needs bank payments working again and anything FlexPay paid
 * collected, getFlexPayEligibility). A covered month still waiting on its
 * pull is written off as the tenant's when the pull run finds the bank
 * stopped. The tenant is told FlexPay ended (autopay stays off; their next
 * bill is theirs), only when this call ended it.
 */
export async function autoDisenrollFlexPayOnAchUnverified(tenantId: string): Promise<void> {
  // A second time ends FlexPay for good (earlierFlexPayEndingSql).
  const ended = await endFlexPayForStoppedBank((sql, params) => query<any>(sql, params as any[]), tenantId, false)
  if (ended) await notifyTenantFlexPayEnded(tenantId, { kind: 'bank_stopped', noBank: ended.noBank })
}

// ── helpers ─────────────────────────────────────────────────────

async function alertAdmin(
  severity: 'warn' | 'critical',
  category: string,
  title: string,
  body: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({ severity, category, title, body, context })
  } catch (e) {
    logger.error({ err: e, category }, '[flexpay][alert]')
  }
}

/** First-of-the-month for the cycle this date belongs to (UTC). */
export function cycleMonthForDate(d: Date): string {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  return first.toISOString().slice(0, 10)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function money(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

/** 'YYYY-MM-DD' → "October" (a plain calendar date; no zone involved). */
function sayMonth(ymd: string): string {
  const [y, m] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
}

/** 'YYYY-MM-DD' → "October 20". */
function sayDay(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** A moment (a timestamptz) → "January 1, 2027", on GAM's calendar (Phoenix). */
function sayInstant(v: string | Date): string {
  return new Date(v).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' })
}
