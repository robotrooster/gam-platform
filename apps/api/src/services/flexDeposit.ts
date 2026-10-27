import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { isFeatureEnabled } from './systemFeatures'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import { computeTenantGamOutstandingTotal } from './supersedence'
// S527: single source for the Stripe ACH-return pass-through (same Stripe
// fee regardless of product; Consumer ToS § 9.1.4 promises it "per retry at
// actual cost, no markup" for FlexDeposit exactly as § 4.2 does for FlexPay).
import { FLEXPAY_ACH_RETURN_FEE as ACH_RETURN_FEE } from './flexpay'
import {
  getFlexDepositMaxInstallments,
  isAllowedFlexDepositPaymentCount,
  FLEX_DEPOSIT_PAYMENT_CHOICES,
  FLEX_DEPOSIT_CUSTODY_FEE,
  type FlexDepositRiskLevel,
} from '@gam/shared'
import {
  FLEXDEPOSIT_TEMPLATE_VERSION,
  renderFlexDepositAcceptanceText,
  recordAcceptance,
  fireFlexsuiteAcceptanceEmail,
  type FlexDepositInstallment,
} from './flexsuiteAcceptance'
import { logger } from '../lib/logger'
import { dateIn, todayIn, monthStartOf } from '../lib/timezone'

// ============================================================
// FlexDeposit — deposit-custody installment product (S246; reworked
// S514 to the S512 custody model, Consumer ToS § 9.1).
//
// CUSTODY MODEL (not an advance, not credit). The tenant funds their
// OWN security deposit into GAM custody over 2–6 monthly installments.
// GAM advances/floats NOTHING: the landlord's books reflect the deposit
// in full at move-in, but the cash is held by GAM in custody
// (held_by='gam_escrow'), never transferred to the landlord at move-in.
// Installment 1 is paid at move-in alongside rent + utilities in a
// single combined ACH pull; installments 2..N are pulled monthly.
// A $3/mo custody fee (FLEX_DEPOSIT_CUSTODY_FEE) applies while GAM
// holds the deposit. At lease-end the deposit-return flow settles
// against collected_amount — i.e. only what the tenant actually funded
// (see services/depositReturn.ts).
//
// Eligibility is limited to SSDI/SSI recipients (income verified) per
// ToS § 9.1.1 — a service-tier qualification, not a credit decision.
//
// Landlord NEVER sees FlexDeposit. Their move-in invoice excludes the
// deposit line (held in custody); custody fees and installment receipts
// are tenant↔GAM ledger entries only.
//
// NO RECOURSE on a missed installment (ToS § 9.1.5). A missed
// installment leaves the deposit "simply under-funded" — GAM does NOT
// accelerate, demand a balance in full, sue, collect, furnish to a CRA,
// or threaten any of the foregoing. The custody balance is funded by
// the scheduled installment pulls plus GAM-First FIFO routing of any
// platform payment (the funding mechanism, NOT debt collection — ToS
// § 9.1.4). Re-enrollment restriction, if any, is "until current" — no
// permanent block, no fixed cooldown.
// ============================================================

// S330: signal thresholds for the eligibility-check workflow promised
// in Consumer Privacy Policy § 2.1. All rule-based — no scoring or
// underwriting (preserves the not-credit structural defense).
/**
 * ── 10/27 (Nic): THE 30 DAYS ARE THE LANDLORD'S, NOT THE RESIDENT'S ─────────
 *
 *   "the 30 day gate was against the landlord profile. landlord has to be
 *    vetted and moving money through the system. not the new tenant"
 *
 * S330 wrote this as a check on the RESIDENT's account age, which was both
 * the wrong party and impossible to satisfy: FlexDeposit is only ever offered
 * at move-in, and somebody moving in has had an account for a day. It never
 * bit because the product was switched off.
 *
 * The party worth vetting is the landlord. GAM holds the deposit in custody
 * while the landlord's books read it as settled, so the exposure is a park
 * that turns out not to be real, or not to be collecting. A resident is new by
 * definition; a landlord is not.
 */
export const FLEX_DEPOSIT_MIN_LANDLORD_DAYS = 30

/**
 * ── 10/27 (Nic): THE WINDOW AFTER SIGNING ───────────────────────────────────
 *
 * A bank is verified only by microdeposits, which take a day or two to land,
 * and FlexDeposit refuses anyone whose bank is not verified. Accepting the
 * invite and signing the lease happen in ONE sitting, so a resident who waits
 * to link their bank is asking the landlord to wait on the deposit:
 *
 *   "They just need to initiate that process like on the day they sign the
 *    lease. If they wait a day or two to like do that, they're not eligible for
 *    flex deposit... The day they accept their invite and link the bank, that's
 *    the same day they sign. It all happens at the same time."
 *
 * So two things, and they are different questions:
 *
 *   STARTED IT ON THE DAY. The bank link must have been begun by the end of
 *   the day they signed (tenants.bank_pending_since keeps the FIRST start, so
 *   a later attempt cannot backdate it).
 *
 *   FINISHED IT IN FIVE DAYS. Microdeposits get the days they need, and then
 *   the deposit is simply owed as billed.
 *
 * Five, in his words, and the reason is the landlord's money rather than the
 * resident's convenience: "we have to account for mid month lease starts or
 * pro rated terms for early move in. those landlords will want the money the
 * quickest."
 *
 * This is a window on the OFFER, never on the billing. The deposit is invoiced
 * at move-in exactly as it always was and the landlord is not made to wait;
 * enrolling inside the window is what converts that charge into installment 1
 * plus the fee.
 */
export const FLEX_DEPOSIT_SIGNING_WINDOW_DAYS = 5
export const FLEX_DEPOSIT_MIN_RECENT_ON_TIME_PAYMENTS = 1
export const FLEX_DEPOSIT_PAYMENT_LOOKBACK_DAYS = 90

export interface FlexDepositEligibility {
  eligible:        boolean
  blockers:        Array<
    | 'ach_unverified'
    | 'no_deposit_row'
    | 'no_bg_result'
    | 'bg_not_approved'
    | 'risk_level_missing'
    | 'not_ssi_ssdi'
    | 'already_funded'
    | 'tenant_not_found'
    // 10/27: the LANDLORD is not established enough to offer FlexDeposit at —
    // too new, not vetted for payouts, or no money moving through GAM.
    | 'landlord_not_established'
    // 10/27: the bank link was not begun on the day they signed.
    | 'bank_link_not_started_on_signing_day'
    // 10/27: more than FLEX_DEPOSIT_SIGNING_WINDOW_DAYS since they signed.
    | 'signing_window_closed'
    | 'insufficient_on_time_payment_history'
    // 10/26: the platform is at its FlexDeposit ceiling. Nothing about this
    // tenant — they qualify, there is simply no room right now.
    | 'at_capacity'
  >
  max_installments: number | null
  risk_level:       FlexDepositRiskLevel | null
  deposit_amount:   number | null
  /**
   * 10/26 (Nic): the two choices and what each one costs, so the resident sees
   * the price of the decision rather than only the installment size. For a
   * deposit under $1,000 that is "$48 on 2 payments" or "$67 on 4".
   *
   * `firstPull` is what the first collection actually takes: installment 1
   * plus the WHOLE fee ("they pay the first payment and their entire fee at
   * once"), which is the number that matters at move-in.
   *
   * Empty when there is no deposit to price, or for a payment count the
   * product does not sell. 10/27: a deposit ABOVE the grid is no longer empty —
   * it is priced at the ceiling, with the remainder in `payUpFront`.
   */
  choices: Array<{
    payments:    number
    fee:         number
    installment: number
    firstPull:   number
    total:       number
    /**
     * 10/27 (Nic): the part of the deposit ABOVE the top of the price grid,
     * collected in full with payment 1 rather than split. 0 for almost
     * everybody — only a deposit at or over $3,000 has any. His words: "they
     * can split the $3,000 into four payments ... and then they pay the
     * difference of that $1,000 gap from $3,000 to $4,000 all at once."
     */
    payUpFront:  number
  }>
}

export async function isFlexDepositVisible(): Promise<boolean> {
  return isFeatureEnabled('flexdeposit_rollout_visible')
}

/**
 * 10/26 (Nic) — IS THERE ROOM FOR ANOTHER FLEXDEPOSIT PLAN?
 *
 *   "We have to be careful about how many people we can onboard on that at a
 *    time. That needs to be scoped to some sort of capacity limit. So we don't
 *    get freaking 500 people sign up tomorrow that we cannot realistically
 *    [serve]."
 *
 * Under the custody model GAM floats no principal, so what is being rationed
 * is not cash — it is the number of UNFUNDED deposits GAM is carrying for
 * landlords at once, each of which is a relationship to manage by hand if the
 * tenant stops paying. Hence a plan count AND the total still uncollected,
 * either of which closes the door.
 *
 * Platform-wide on purpose: the capacity is GAM's, so one busy park cannot
 * consume it. No row, or NULL limits, means unlimited.
 */
export async function flexDepositCapacity(): Promise<{
  room: boolean
  activePlans: number
  uncollected: number
  maxActivePlans: number | null
  maxUncollected: number | null
}> {
  const cap = await queryOne<{ max_active_plans: number | null; max_uncollected: string | null }>(
    `SELECT max_active_plans, max_uncollected::text FROM flexdeposit_capacity WHERE id IS TRUE`)
  const now = await queryOne<{ plans: string; uncollected: string }>(
    `SELECT COUNT(*)::text AS plans,
            COALESCE(SUM(GREATEST(sd.total_amount - COALESCE(sd.collected_amount, 0), 0)), 0)::text
              AS uncollected
       FROM security_deposits sd
      WHERE sd.flex_deposit_enabled = TRUE
        AND sd.flex_deposit_plan_status = 'active'`)
  const activePlans = Number(now?.plans ?? 0)
  const uncollected = Number(now?.uncollected ?? 0)
  const maxActivePlans = cap?.max_active_plans ?? null
  const maxUncollected = cap?.max_uncollected != null ? Number(cap.max_uncollected) : null
  // A plan that is about to be added has to FIT, so the comparison is >= on
  // the count: at exactly the ceiling there is no room for one more.
  const room = (maxActivePlans === null || activePlans < maxActivePlans)
    && (maxUncollected === null || uncollected < maxUncollected)
  return { room, activePlans, uncollected, maxActivePlans, maxUncollected }
}

/**
 * Compute the tenant's FlexDeposit eligibility based on:
 *  - SSDI/SSI recipient (tenants.ssi_ssdi) — ToS § 9.1.1 service-tier
 *    qualification, income verified at onboarding (not a credit decision)
 *  - ach_verified
 *  - background_checks.status = 'approved' AND risk_level set
 *  - security_deposits exists for an upcoming/active lease
 *  - platform tenure + on-time payment history (fraud defense)
 * Returns max_installments (2-6) when eligible, null otherwise.
 *
 * No NSF cooldown / no permanent prior-default block (S514): under the
 * custody model a missed installment is not a default and carries no
 * lasting disqualification — restriction, if any, is "until current."
 */
/**
 * ── 10/27 (Nic): THE NUDGE SHOWN BEFORE THEY SIGN ───────────────────────────
 *
 *   "Before signing, they need to have a pop-up that says, in order to, it
 *    needs to not be blocking. It needs to tell them, hey, in order to do flex
 *    deposit, please link your bank account."
 *
 * Returns the deposit to name in that nudge, or null when there is nothing to
 * say. Shown only where it could matter: this lease has a deposit to split,
 * and their bank is neither verified nor already begun — somebody who has
 * started is already doing the thing we would be asking for.
 *
 * Takes the USER, because that is what a signer row carries. Reading a
 * tenant_id off a signer is what made the first version of this silently do
 * nothing: the column does not exist, and the lookup simply never ran.
 */
export async function flexDepositSignPrompt(
  userId: string,
): Promise<{ depositAmount: number } | null> {
  if (!await isFlexDepositVisible()) return null
  return await queryOne<{ depositAmount: number }>(
    `SELECT sd.total_amount::float8 AS "depositAmount"
       FROM tenants t
       JOIN security_deposits sd ON sd.tenant_id = t.id
      WHERE t.user_id = $1
        AND sd.status IN ('pending', 'partial')
        AND sd.total_amount > 0
        AND t.ach_verified IS NOT TRUE
        AND t.bank_pending_since IS NULL
      ORDER BY sd.created_at DESC
      LIMIT 1`,
    [userId])
}

export async function getFlexDepositEligibility(tenantId: string): Promise<FlexDepositEligibility> {
  const t = await queryOne<{
    ach_verified: boolean
    ssi_ssdi: boolean
    bg_status: string | null
  }>(
    `SELECT ach_verified, ssi_ssdi, background_check_status AS bg_status
       FROM tenants WHERE id = $1`,
    [tenantId],
  )
  if (!t) {
    return {
      eligible: false, blockers: ['tenant_not_found'],
      max_installments: null, risk_level: null, deposit_amount: null, choices: [],
    }
  }

  const blockers: FlexDepositEligibility['blockers'] = []

  // ToS § 9.1.1: FlexDeposit is limited to SSDI/SSI recipients. The flag is
  // set + income-verified at tenant onboarding; this is a service-tier
  // qualification, not a credit decision, and uses no consumer report.
  if (!t.ssi_ssdi) blockers.push('not_ssi_ssdi')

  if (!t.ach_verified) blockers.push('ach_unverified')

  // 10/26: the ceiling. Checked here so a tenant who cannot be taken on is
  // told before they fill anything in, rather than at the first pull.
  if (!(await flexDepositCapacity()).room) blockers.push('at_capacity')
  if (t.bg_status !== 'approved') blockers.push(t.bg_status ? 'bg_not_approved' : 'no_bg_result')

  // S514: no permanent prior-default block. Under the custody model a
  // missed installment is not a default and creates no debt (ToS § 9.1.5),
  // so a prior under-funded plan does not bar a future enrollment.

  // S330: on-time payment history. Per Privacy Policy § 2.1 "payment
  // history on the Platform" signal. Tenants with at least one prior
  // lease must have ≥ MIN_RECENT_ON_TIME_PAYMENTS on-time payments in
  // the trailing LOOKBACK_DAYS window. First-lease-ever tenants are
  // exempt — they have no payment history to check; the BG-approved
  // gate covers the cold-start risk.
  const leaseCount = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id
      WHERE lt.tenant_id = $1
        AND l.status IN ('active', 'expired', 'terminated')`,
    [tenantId],
  )
  const isFirstLease = (leaseCount?.n ?? 0) === 0

  // 10/26: a late-payment count used to be read here to narrow the installment
  // options. It is gone with the narrowing itself — everybody gets 2 or 4 at
  // the same price, which is what keeps this a service price and not a decision
  // made about the applicant. The on-time check below stays: it is an
  // ELIGIBILITY gate, the same for everyone, not a difference in terms.

  // ── 10/27 (Nic): THE LANDLORD IS WHAT GETS VETTED ───────────────────────
  //
  //   "the 30 day gate was against the landlord profile. landlord has to be
  //    vetted and moving money through the system. not the new tenant"
  //
  // Three facts about the company whose deposit this is, none of them a
  // judgement about anybody (so the not-credit structure is untouched):
  //
  //   established    the company has been on GAM at least
  //                  FLEX_DEPOSIT_MIN_LANDLORD_DAYS.
  //   vetted         Stripe Connect payouts are enabled — Stripe has run its
  //                  own KYC on the business and will pay it. That is the
  //                  vetting; GAM does not keep a second opinion of it.
  //   money moving   money has actually settled through GAM for them inside
  //                  the same window. A park that signed up and never
  //                  collected is not a park GAM should be holding deposits
  //                  for, however old the row is.
  //
  // Read off the DEPOSIT's own unit, so it is the company that will be handed
  // this deposit — not whoever else the resident may also rent from.
  const co = await queryOne<{
    established: boolean; payouts_enabled: boolean; money_moving: boolean
  }>(
    `SELECT (NOW() - l.created_at) >= ($2::int || ' days')::interval AS established,
            COALESCE(l.connect_payouts_enabled, FALSE)              AS payouts_enabled,
            EXISTS (SELECT 1 FROM payments p
                     WHERE p.landlord_id = l.id
                       AND p.status = 'settled'
                       AND p.settled_at > NOW() - ($2::int || ' days')::interval) AS money_moving
       FROM security_deposits sd
       JOIN units un      ON un.id = sd.unit_id
       JOIN properties pr  ON pr.id = un.property_id
       JOIN landlords l    ON l.id = pr.landlord_id
      WHERE sd.tenant_id = $1
        AND sd.status IN ('pending', 'partial')
      ORDER BY sd.created_at DESC
      LIMIT 1`,
    [tenantId, FLEX_DEPOSIT_MIN_LANDLORD_DAYS],
  )
  // No row here means there is no deposit to read a landlord off; that is
  // reported as 'no_deposit_row' below, not as a landlord problem.
  if (co && !(co.established && co.payouts_enabled && co.money_moving)) {
    blockers.push('landlord_not_established')
  }

  // ── 10/27 (Nic): STARTED ON THE DAY, FINISHED INSIDE FIVE ─────────────────
  //
  // Measured against the lease they are taking, in the PROPERTY's own day —
  // a signature at 7pm Phoenix is still that day, and UTC would have called it
  // tomorrow and refused somebody who did everything right.
  const sign = await queryOne<{ signed_on: string | null; started_on: string | null; days_since: number | null }>(
    `SELECT (l.signed_at AT TIME ZONE p.timezone)::date::text        AS signed_on,
            (t.bank_pending_since AT TIME ZONE p.timezone)::date::text AS started_on,
            ((NOW() AT TIME ZONE p.timezone)::date
               - (l.signed_at AT TIME ZONE p.timezone)::date)        AS days_since
       FROM security_deposits sd
       JOIN leases l ON l.id = sd.lease_id
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN tenants t ON t.id = sd.tenant_id
      WHERE sd.tenant_id = $1
        AND sd.status IN ('pending', 'partial')
      ORDER BY sd.created_at DESC
      LIMIT 1`,
    [tenantId],
  )
  // Nothing signed yet is not a failure — the offer is open until it is.
  if (sign?.signed_on) {
    if (sign.days_since !== null && Number(sign.days_since) > FLEX_DEPOSIT_SIGNING_WINDOW_DAYS) {
      blockers.push('signing_window_closed')
    }
    // A verified bank is proof enough on its own: they plainly did the work,
    // and holding the start date against somebody already verified would be
    // refusing them for the paperwork rather than the fact.
    if (!t.ach_verified && (!sign.started_on || sign.started_on > sign.signed_on)) {
      blockers.push('bank_link_not_started_on_signing_day')
    }
  }

  if (!isFirstLease) {
    const onTimeRow = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_type = 'tenant'
          AND cs.subject_ref_id = $1
          AND ce.event_type = 'payment_received_on_time'
          AND ce.occurred_at >= NOW() - INTERVAL '${FLEX_DEPOSIT_PAYMENT_LOOKBACK_DAYS} days'
          AND ce.superseded_by IS NULL`,
      [tenantId],
    )
    if ((onTimeRow?.n ?? 0) < FLEX_DEPOSIT_MIN_RECENT_ON_TIME_PAYMENTS) {
      blockers.push('insufficient_on_time_payment_history')
    }
  }

  // Find an unfunded deposit row + its BG risk_level. The eligibility
  // engine targets the most recent deposit row that isn't yet
  // 'funded' status (i.e., the upcoming move-in's deposit).
  const dep = await queryOne<{
    deposit_id:     string
    total_amount:   string
    status:         string
    risk_level:     FlexDepositRiskLevel | null
  }>(
    `SELECT sd.id AS deposit_id, sd.total_amount::text, sd.status,
            bc.risk_level
       FROM security_deposits sd
       LEFT JOIN background_checks bc ON bc.id = (
         SELECT background_check_id FROM tenants WHERE id = $1
       )
      WHERE sd.tenant_id = $1
        AND sd.status IN ('pending', 'partial')
      ORDER BY sd.created_at DESC
      LIMIT 1`,
    [tenantId],
  )
  if (!dep) blockers.push('no_deposit_row')
  else if (dep.status === 'funded') blockers.push('already_funded')

  const riskLevel = dep?.risk_level ?? null
  if (dep && !riskLevel) blockers.push('risk_level_missing')

  const depositAmount = dep ? Number(dep.total_amount) : null
  const maxInstallments = (depositAmount !== null && riskLevel)
    ? getFlexDepositMaxInstallments(depositAmount, riskLevel)
    : null

  // 10/26: price BOTH choices, so the resident chooses with the fee in front
  // of them. Priced from the table, identical for everybody at this deposit
  // size — the uniformity is the point.
  const choices: FlexDepositEligibility['choices'] = []
  if (depositAmount !== null && depositAmount > 0) {
    const asOf = new Date().toISOString().slice(0, 10)
    for (const payments of FLEX_DEPOSIT_PAYMENT_CHOICES) {
      // 10/27: a deposit over the top of the grid is no longer refused — the
      // plan covers the ceiling and the rest is paid up front with payment 1.
      const { quoteFlexDepositFeeCapped } = await import('./flexFees')
      const q = await quoteFlexDepositFeeCapped(depositAmount, payments, asOf)
      if (q === null) continue   // no price for this payment count: no plan
      const { fee } = q
      const { splittable, payUpFront } = q.split
      const installment = roundHalfEvenCents(splittable / payments)
      // Installment 1 carries the rounding residue, as the schedule does.
      const first = roundHalfEvenCents(
        installment + roundHalfEvenCents(splittable - installment * payments))
      choices.push({
        payments,
        fee,
        installment,
        // What the first collection actually takes: payment 1, the whole fee,
        // and the part above the ceiling.
        firstPull: roundHalfEvenCents(first + fee + payUpFront),
        total: roundHalfEvenCents(depositAmount + fee),
        payUpFront,
      })
    }
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    max_installments: maxInstallments,
    risk_level: riskLevel,
    deposit_amount: depositAmount,
    choices,
  }
}

// ── Enrollment ──────────────────────────────────────────────────

/**
 * Enroll the tenant in FlexDeposit at the chosen installment count.
 * This is the BEFORE-MOVE-IN flow: called from the tenant-onboarding
 * surface after BG approval, BEFORE moveInBundle runs. The move-in
 * invoice generator reads `security_deposits.flex_deposit_enabled`
 * and excludes the deposit line from the landlord-facing invoice
 * accordingly.
 *
 * Creates N flex_deposit_installments rows (1 = due move-in date,
 * 2..N = monthly thereafter). All start 'pending'; installment 1
 * gets flipped to 'settled' inside the move-in transaction once the
 * tenant pays.
 *
 * Idempotent — re-enrollment for the same deposit returns the
 * existing plan unchanged.
 */
export interface FlexDepositSchedule {
  installments:           FlexDepositInstallment[]
  installmentAmount:      number
  firstAmount:            number
  // Balance not yet funded into custody at move-in (total − installment 1).
  // This is NOT an advance — GAM floats nothing; it is simply the amount the
  // tenant has yet to pay into their own custody balance.
  uncollectedAtMoveIn:    number
  totalInstallmentAmount: number
  startDate:              string  // YYYY-MM-DD
  rentDueDay:             number
  /**
   * GAM's service fee for this plan, from flexdeposit_fee_schedule — priced by
   * deposit size and the number of installments. Charged IN FULL with
   * installment 1 (10/26, Nic).
   */
  serviceFee:             number
  /**
   * 10/27 (Nic): the part of the deposit ABOVE the top of the price grid. It
   * is NOT split — it is collected in full with payment 1 — so a deposit over
   * $3,000 can still have a plan on the first $3,000. 0 for almost everybody.
   */
  payUpFront:             number
  /**
   * What the first pull actually takes: installment 1, the whole fee, and the
   * part above the ceiling.
   */
  firstPullTotal:         number
}

/**
 * 10/26 (Nic) — THE WHOLE FEE IS PAID WITH THE FIRST INSTALLMENT.
 *
 *   "I would say the entire fee is paid up front along with the first
 *    installment portion. Like if they're doing four payments, it's the first
 *    payment plus GAM's entire fee right away. We get our fee at the first
 *    payment, and that way whether we have to give any shortfall to the
 *    landlord, we've at least collected our fee. And then that's money that
 *    can be deployed sooner into other... requests... the fee being collected
 *    up front gives them the most incentive to finish paying because they've
 *    already paid the fee for it."
 *
 * And on why not spread: "not only could they bail after the first
 * installment, but maybe then we don't even collect the fee either."
 *
 * The fee is GAM's revenue and is NEVER part of the custody balance — the
 * deposit the landlord's claim runs against is only what the tenant funded
 * toward the deposit itself. Keeping them separate is what lets the deposit
 * return settle against collected principal without GAM's fee leaking into it.
 */
function computeFlexDepositSchedule(args: {
  /**
   * The part a plan covers. 10/27: for a deposit above the top of the grid
   * this is the CEILING, not the whole deposit — the rest rides in payUpFront.
   */
  depositTotal:      number
  installmentCount:  number
  startDate:         string
  rentDueDay:        number
  serviceFee:        number
  /** The part collected in full with payment 1 rather than split. Default 0. */
  payUpFront?:       number
}): FlexDepositSchedule {
  const total = args.depositTotal
  const payUpFront = roundHalfEvenCents(args.payUpFront ?? 0)
  const installmentAmount = roundHalfEvenCents(total / args.installmentCount)
  // Rounding residue lives on installment 1 so the sum equals total.
  const residue = roundHalfEvenCents(total - installmentAmount * args.installmentCount)
  const firstAmount = roundHalfEvenCents(installmentAmount + residue)
  const uncollectedAtMoveIn = roundHalfEvenCents(total - firstAmount)

  const installments: FlexDepositInstallment[] = []
  for (let i = 1; i <= args.installmentCount; i++) {
    installments.push({
      number:  i,
      dueDate: addMonths(args.startDate, i - 1),
      amount:  i === 1 ? firstAmount : installmentAmount,
    })
  }
  const totalInstallmentAmount = installments.reduce((s, x) => s + x.amount, 0)

  return {
    installments, installmentAmount, firstAmount, uncollectedAtMoveIn,
    totalInstallmentAmount, startDate: args.startDate, rentDueDay: args.rentDueDay,
    serviceFee: args.serviceFee,
    payUpFront,
    // 10/27: the part above the ceiling goes with the first pull, not into the
    // split — "they pay the first payment of the $3,000, so $750, and then
    // they pay the difference of that $1,000 gap ... all at once."
    firstPullTotal: roundHalfEvenCents(firstAmount + args.serviceFee + payUpFront),
  }
}

/**
 * The service fee for a plan, from the price table. Null means NO PLAN IS
 * OFFERED at that deposit size — there is no bracket at or above $3,000 — and
 * every caller must refuse rather than read it as free.
 */
export async function quoteFlexDepositServiceFee(
  depositTotal: number, installmentCount: number, asOf: string,
): Promise<number | null> {
  const { quoteFlexDepositFee } = await import('./flexFees')
  const q = await quoteFlexDepositFee(depositTotal, installmentCount, asOf)
  return q ? q.fee : null
}

interface FlexDepositDepositRow {
  id: string; total_amount: string; lease_id: string;
  start_date: string; rent_due_day: number;
}

async function fetchUnfundedDeposit(tenantId: string): Promise<FlexDepositDepositRow | null> {
  return queryOne<FlexDepositDepositRow>(
    `SELECT sd.id, sd.total_amount::text, sd.lease_id,
            l.start_date::text, l.rent_due_day
       FROM security_deposits sd
       JOIN leases l ON l.id = sd.lease_id
      WHERE sd.tenant_id = $1
        AND sd.status IN ('pending', 'partial')
      ORDER BY sd.created_at DESC
      LIMIT 1`,
    [tenantId],
  )
}

/**
 * S314: schedule preview for the tenant-portal "Read full Service
 * Agreement" link. Returns the same installment schedule that
 * enrollment would produce, plus the rendered SLA text. Does NOT
 * persist anything — the audit record only writes at actual enroll.
 */
export async function previewFlexDepositSchedule(args: {
  tenantId:         string
  installmentCount: number
}): Promise<
  | { ok: true; schedule: FlexDepositSchedule; depositId: string }
  | { ok: false; reason: string }
> {
  // 10/26: MEMBERSHIP, not a range — 3 sits inside 2..6 and is not sold.
  if (!isAllowedFlexDepositPaymentCount(args.installmentCount)) {
    return { ok: false, reason: 'Choose 2 payments or 4 — those are the two FlexDeposit splits.' }
  }
  const dep = await fetchUnfundedDeposit(args.tenantId)
  if (!dep) return { ok: false, reason: 'No unfunded deposit on file' }
  // 10/26: the plan's price from the table; a payment count the product does
  // not sell has none, and is refused rather than read as free.
  // 10/27 (Nic): a deposit ABOVE the top of the grid is no longer refused — the
  // plan covers the ceiling ($3,000) and the rest is collected in full with
  // payment 1 (quoteFlexDepositFeeCapped).
  const { quoteFlexDepositFeeCapped } = await import('./flexFees')
  const capped = await quoteFlexDepositFeeCapped(
    Number(dep.total_amount), args.installmentCount, todayIn('America/Phoenix'))
  if (capped === null) {
    return { ok: false, reason: 'Choose 2 payments or 4 — those are the two FlexDeposit splits.' }
  }
  const serviceFee = capped.fee
  const schedule = computeFlexDepositSchedule({
    depositTotal:     capped.split.splittable,
    payUpFront:       capped.split.payUpFront,
    installmentCount: args.installmentCount,
    startDate:        dep.start_date.slice(0, 10),
    rentDueDay:       dep.rent_due_day,
    serviceFee,
  })
  return { ok: true, schedule, depositId: dep.id }
}

export async function enrollFlexDeposit(args: {
  tenantId:         string
  userId:           string
  installmentCount: number   // 2..4
  acceptedTerms:    boolean
  ip:               string | null
  userAgent:        string | null
}): Promise<
  | { ok: true; plan: any; acceptanceId: string }
  | { ok: false; reason: string }
> {
  const visible = await isFlexDepositVisible()
  if (!visible) return { ok: false, reason: 'FlexDeposit is not enabled on this platform' }

  // S314: acceptance gate. Replaces the S260 acknowledgedTos flag —
  // tenant must affirmatively accept the populated FlexDeposit SLA
  // before this enrolls them. The audit row stores the snapshot.
  if (args.acceptedTerms !== true) {
    return { ok: false, reason: 'FlexDeposit Service Agreement acceptance required' }
  }

  const elig = await getFlexDepositEligibility(args.tenantId)
  if (!elig.eligible) return { ok: false, reason: `Not eligible: ${elig.blockers.join(', ')}` }

  // 10/26: MEMBERSHIP, not a range — 3 sits inside 2..6 and is not sold.
  if (!isAllowedFlexDepositPaymentCount(args.installmentCount)) {
    return { ok: false, reason: 'Choose 2 payments or 4 — those are the two FlexDeposit splits.' }
  }
  if (elig.max_installments === null || args.installmentCount > elig.max_installments) {
    return { ok: false, reason: `Max allowed installments for this deposit and risk profile: ${elig.max_installments}` }
  }

  // Fetch the unfunded deposit row + lease start date + rent_due_day.
  // rent_due_day powers the S260 pull schedule (primary at rent_due−5,
  // retry at rent_due−1) for installments 2..N.
  const dep = await fetchUnfundedDeposit(args.tenantId)
  if (!dep) return { ok: false, reason: 'No unfunded deposit on file' }

  // 10/26: the plan's price from the table; a payment count the product does
  // not sell has none, and is refused rather than read as free.
  // 10/27 (Nic): a deposit ABOVE the top of the grid is no longer refused — the
  // plan covers the ceiling ($3,000) and the rest is collected in full with
  // payment 1 (quoteFlexDepositFeeCapped).
  const { quoteFlexDepositFeeCapped } = await import('./flexFees')
  const capped = await quoteFlexDepositFeeCapped(
    Number(dep.total_amount), args.installmentCount, todayIn('America/Phoenix'))
  if (capped === null) {
    return { ok: false, reason: 'Choose 2 payments or 4 — those are the two FlexDeposit splits.' }
  }
  const serviceFee = capped.fee
  const schedule = computeFlexDepositSchedule({
    depositTotal:     capped.split.splittable,
    payUpFront:       capped.split.payUpFront,
    installmentCount: args.installmentCount,
    startDate:        dep.start_date.slice(0, 10),
    rentDueDay:       dep.rent_due_day,
    serviceFee,
  })

  // Render the populated SLA BEFORE opening the tx so any data-lookup
  // failure aborts without holding row locks.
  const { renderedText, populatedContent } = await renderFlexDepositAcceptanceText({
    tenantId:               args.tenantId,
    userId:                 args.userId,
    depositId:              dep.id,
    installmentCount:       args.installmentCount,
    installments:           schedule.installments,
    totalInstallmentAmount: schedule.totalInstallmentAmount,
    serviceFee:             schedule.serviceFee,
    moveInDate:             schedule.startDate,
    ip:                     args.ip,
    userAgent:              args.userAgent,
  })

  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Skip re-enrollment when a plan already exists for this deposit.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM flex_deposit_installments
        WHERE security_deposit_id = $1 LIMIT 1`,
      [dep.id],
    )
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'FlexDeposit plan already exists for this deposit' }
    }

    // 10/26: the ceiling again, INSIDE the transaction and behind a lock.
    // getFlexDepositEligibility checked it a moment ago, but two enrollments
    // racing would both have seen room and both been let through — the exact
    // way a limit of 10 becomes 11. The advisory lock serializes the check, so
    // the second one waits and then sees the first one's plan.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('flexdeposit:capacity', 0))`)
    const cap = await client.query<{ full: boolean }>(
      `SELECT (c.max_active_plans IS NOT NULL AND n.plans >= c.max_active_plans)
           OR (c.max_uncollected  IS NOT NULL AND n.uncollected >= c.max_uncollected) AS full
         FROM flexdeposit_capacity c
         CROSS JOIN (
           SELECT COUNT(*) AS plans,
                  COALESCE(SUM(GREATEST(sd.total_amount - COALESCE(sd.collected_amount, 0), 0)), 0)
                    AS uncollected
             FROM security_deposits sd
            WHERE sd.flex_deposit_enabled = TRUE
              AND sd.flex_deposit_plan_status = 'active'
         ) n
        WHERE c.id IS TRUE`)
    if (cap.rows[0]?.full === true) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'FlexDeposit is at capacity right now — nothing was charged.' }
    }

    // Insert N installment rows. Installment 1 paid at move-in (no
    // pull dates needed). Installments 2..N: primary pull at
    // rent_due_day − 5, retry pull at rent_due_day − 1, computed
    // against the cycle month each installment covers.
    for (const inst of schedule.installments) {
      const pullDates = inst.number === 1
        ? null
        : computeInstallmentPullDates(schedule.startDate, inst.number, schedule.rentDueDay)
      await client.query(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count,
            amount, due_date, primary_pull_date, retry_pull_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [
          dep.id, args.tenantId, inst.number, args.installmentCount,
          inst.amount.toFixed(2), inst.dueDate,
          pullDates?.primary ?? null,
          pullDates?.retry ?? null,
        ],
      )
    }

    // Flip the deposit row's FlexDeposit columns. Force held_by='gam_escrow'
    // regardless of property default — GAM holds the deposit in custody
    // throughout the lease (no move-in Connect Transfer; the deposit-return
    // flow settles against collected_amount at lease-end). GAM advances
    // nothing, so gam_advance_amount stays at its DEFAULT 0 (deprecated S514).
    await client.query(
      `UPDATE security_deposits
          SET flex_deposit_enabled    = TRUE,
              flex_deposit_plan_status = 'active',
              held_by                  = 'gam_escrow',
              installment_count        = $1,
              installment_amount       = $2,
              installments_paid        = 0,
              installments_remaining   = $1,
              next_installment_date    = $3,
              -- 10/26: the fee this plan was SOLD at. Read back for
              -- re-acceptance and never re-quoted, so a later re-price of the
              -- schedule cannot restate what this tenant accepted.
              flex_deposit_service_fee = $5,
              updated_at               = NOW()
        WHERE id = $4`,
      [
        args.installmentCount,
        schedule.installmentAmount.toFixed(2),
        addMonths(schedule.startDate, 1),
        dep.id,
        schedule.serviceFee.toFixed(2),
      ],
    )

    // Also flip the tenant flag so OTP and other consumers can
    // recognize FlexDeposit-active status quickly.
    await client.query(
      `UPDATE tenants SET flex_deposit_enrolled = TRUE WHERE id = $1`,
      [args.tenantId],
    )

    // S314: persist the click-accepted SLA snapshot inside the same tx.
    // If anything below fails, the acceptance row rolls back too.
    const acceptanceId = await recordAcceptance({
      client,
      tenantId:         args.tenantId,
      userId:           args.userId,
      productType:      'flexdeposit',
      templateVersion:  FLEXDEPOSIT_TEMPLATE_VERSION,
      populatedContent,
      renderedText,
      ip:               args.ip,
      userAgent:        args.userAgent,
    })

    await client.query('COMMIT')

    // S322: post-commit, best-effort confirmation email with attached
    // populated SLA PDF. Errors log but never throw.
    fireFlexsuiteAcceptanceEmail({
      tenantId:        args.tenantId,
      product:         'flexdeposit',
      acceptanceId,
      templateVersion: FLEXDEPOSIT_TEMPLATE_VERSION,
      renderedText,
    }).catch(err => logger.error({ err, ctx: acceptanceId }, '[flexdeposit] enrollment email failed'))

    return {
      ok: true,
      acceptanceId,
      plan: {
        deposit_id:          dep.id,
        installment_count:   args.installmentCount,
        installment_amount:  schedule.installmentAmount,
        first_amount:        schedule.firstAmount,
        uncollected_at_move_in: schedule.uncollectedAtMoveIn,
        first_due:           schedule.startDate,
        next_due:            addMonths(schedule.startDate, 1),
      },
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Cancel a FlexDeposit plan BEFORE move-in. Wipes the installment
 * rows + clears the deposit flags. After move-in, the plan can't be
 * cancelled — it must run to completion or default.
 */
export async function cancelFlexDeposit(tenantId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const dep = await client.query<{ id: string; installments_paid: number }>(
      `SELECT sd.id, sd.installments_paid
         FROM security_deposits sd
        WHERE sd.tenant_id = $1
          AND sd.flex_deposit_enabled = TRUE
          AND sd.flex_deposit_plan_status = 'active'
          AND sd.status <> 'voided'
        ORDER BY sd.created_at DESC
        LIMIT 1`,
      [tenantId],
    )
    if (dep.rows.length === 0) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'No active FlexDeposit plan' }
    }
    if ((dep.rows[0].installments_paid ?? 0) > 0) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'Cannot cancel — installments already paid; plan must run to completion' }
    }

    await client.query(
      `DELETE FROM flex_deposit_installments WHERE security_deposit_id = $1`,
      [dep.rows[0].id],
    )
    await client.query(
      `UPDATE security_deposits
          SET flex_deposit_enabled       = FALSE,
              flex_deposit_plan_status   = NULL,
              installment_count          = NULL,
              installment_amount         = NULL,
              installments_paid          = 0,
              installments_remaining     = NULL,
              next_installment_date      = NULL,
              updated_at                 = NOW()
        WHERE id = $1`,
      [dep.rows[0].id],
    )
    await client.query(
      `UPDATE tenants SET flex_deposit_enrolled = FALSE WHERE id = $1`,
      [tenantId],
    )
    await client.query('COMMIT')
    return { ok: true }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── Move-in settlement ───────────────────────────────────────────

/**
 * Called from moveInBundle when FlexDeposit is enrolled. Performs:
 *   1. Mark installment 1 as 'settled' (paid as part of the move-in PI)
 *   2. Increment security_deposits.installments_paid + collected_amount
 *
 * Custody model: NO landlord Connect Transfer at move-in. The deposit is
 * held in gam_escrow throughout the lease (forced at enrollment). GAM holds
 * the partial-collected funds, marks the deposit 'funded' on the
 * landlord-visible dashboard once the total is collected, and the
 * deposit-return flow settles against collected_amount at lease-end —
 * GAM advances nothing, so there is no gap for GAM to "eat": the amount
 * available to landlord/tenant is exactly what the tenant funded into
 * custody (ToS § 9.1.3 / § 9.1.5).
 *
 * Returns null stripeTransferId always (no transfer fires under custody).
 */
export async function settleFlexDepositMoveIn(args: {
  tenantId:                 string
  securityDepositId:        string
  movInPaymentId:           string
}): Promise<{ stripeTransferId: string | null }> {
  const installment = await queryOne<{
    id: string; amount: string; installment_count: number;
  }>(
    `SELECT id, amount::text, installment_count
       FROM flex_deposit_installments
      WHERE security_deposit_id = $1 AND installment_number = 1
      LIMIT 1`,
    [args.securityDepositId],
  )
  if (!installment) {
    throw new Error('No installment 1 row for FlexDeposit settlement')
  }

  const firstAmount = Number(installment.amount)

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_deposit_installments
          SET status = 'settled', payment_id = $1, settled_at = NOW(), updated_at = NOW()
        WHERE id = $2`,
      [args.movInPaymentId, installment.id],
    )
    await client.query(
      `UPDATE security_deposits
          SET installments_paid     = installments_paid + 1,
              installments_remaining = GREATEST(installments_remaining - 1, 0),
              collected_amount      = LEAST(collected_amount + $1, total_amount),
              status                = CASE
                                        WHEN collected_amount + $1 >= total_amount THEN 'funded'
                                        ELSE 'partial'
                                      END,
              updated_at            = NOW()
        WHERE id = $2`,
      [firstAmount.toFixed(2), args.securityDepositId],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  return { stripeTransferId: null }
}

// ── Installment cron (installments 2..N) ─────────────────────────

export interface InstallmentDueResult {
  candidates_scanned: number
  pulls_initiated:    number
  errors:             number
}

/**
 * Daily cron — walks pending installment rows ready for an ACH pull.
 *
 * Pull schedule: each installment has TWO pull attempts:
 *   - primary at rent_due_day − 5 (fires when attempt_count = 0)
 *   - retry   at rent_due_day − 1 (fires when attempt_count = 1
 *                                  AND primary failed; if primary
 *                                  succeeded, status flipped to
 *                                  'settled' and retry is skipped)
 *
 * On retry failure (attempt_count = 2) the webhook NSF handler marks the
 * installment 'missed'. There is NO acceleration and no plan-level default
 * (ToS § 9.1.5): the deposit is simply under-funded by that installment,
 * and the custody balance keeps funding from later installments + GAM-First
 * routing. See handleFlexDepositPaymentNsf.
 *
 * One PaymentIntent per pull (platform charge, gross to GAM platform
 * balance — the deposit lives entirely in gam_escrow; no Connect Transfer
 * fires under the custody model).
 */
export async function processFlexDepositInstallmentDue(now: Date = new Date()): Promise<InstallmentDueResult> {
  const out: InstallmentDueResult = { candidates_scanned: 0, pulls_initiated: 0, errors: 0 }
  if (!await isFlexDepositVisible()) return out

  // S654: pull dates sit on the tenant's lease, so "due today" is asked on the
  // property's calendar. UTC turns over at 5 pm in Phoenix, which pulled a day
  // early and stamped the payment with tomorrow's date.
  const rows = await query<{
    installment_id:    string
    security_deposit_id: string
    tenant_id:         string
    amount:            string
    landlord_id:       string
    lease_id:          string
    unit_id:           string
    stripe_customer_id: string | null
    attempt_count:     number
    pull_kind:         'primary' | 'retry'
    timezone:          string
  }>(
    `SELECT i.id AS installment_id, i.security_deposit_id, i.tenant_id,
            i.amount::text, i.attempt_count,
            l.landlord_id, l.id AS lease_id, l.unit_id,
            t.stripe_customer_id,
            CASE WHEN i.attempt_count = 0 THEN 'primary' ELSE 'retry' END AS pull_kind,
            p.timezone
       FROM flex_deposit_installments i
       JOIN security_deposits sd ON sd.id = i.security_deposit_id
       JOIN leases l ON l.id = sd.lease_id
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN tenants t ON t.id = i.tenant_id
      WHERE i.status = 'pending'
        AND i.installment_number > 1
        AND sd.flex_deposit_plan_status = 'active'
        AND (
          (i.attempt_count = 0 AND i.primary_pull_date IS NOT NULL
             AND i.primary_pull_date <= ($1::timestamptz AT TIME ZONE p.timezone)::date)
          OR
          (i.attempt_count = 1 AND i.retry_pull_date   IS NOT NULL
             AND i.retry_pull_date   <= ($1::timestamptz AT TIME ZONE p.timezone)::date)
        )`,
    [now],
  )
  out.candidates_scanned = rows.length

  const stripe = getStripe()
  for (const r of rows) {
    try {
      const today = dateIn(r.timezone, now)
      if (!r.stripe_customer_id) {
        await markInstallmentMissed(r.installment_id, r.security_deposit_id, r.tenant_id, 'no_stripe_customer')
        out.errors += 1
        continue
      }

      // Resolve tenant's default payment method (same as FlexPay).
      let paymentMethodId: string | null = null
      try {
        const cust = await stripe.customers.retrieve(r.stripe_customer_id)
        if (cust && !(cust as any).deleted) {
          const c = cust as any
          paymentMethodId = c.invoice_settings?.default_payment_method ?? c.default_source ?? null
        }
      } catch {}
      if (!paymentMethodId) {
        await markInstallmentMissed(r.installment_id, r.security_deposit_id, r.tenant_id, 'no_default_payment_method')
        out.errors += 1
        continue
      }

      const baseAmount = Number(r.amount)
      // S261: supersedence boost — pull older outstanding GAM debt on
      // top of the installment amount. Distributed FIFO on webhook
      // settle by applyTenantSupersedence. Excludes this installment
      // itself (status='pending', so it's not in the outstanding list).
      const boost = await computeTenantGamOutstandingTotal(r.tenant_id)
      // S527: retry pulls carry the bounced primary attempt's Stripe
      // ACH-return fee, passed through at cost (ToS § 9.1.4). The
      // installment amount itself stays fixed — only the pass-through
      // rides on top. Primary pulls carry nothing extra.
      const returnFee = r.pull_kind === 'retry' ? ACH_RETURN_FEE : 0
      const amount = Math.round((baseAmount + returnFee + boost) * 100) / 100
      const intent = await createRentPlatformCharge({
        amount,
        stripeCustomerId:    r.stripe_customer_id,
        paymentMethodId,
        paymentMethodTypes:  ['us_bank_account'],
        entryDescription:    'DEPOSIT',
        metadata: {
          gam_purpose:        'flexdeposit_installment',
          gam_installment_id: r.installment_id,
          gam_deposit_id:     r.security_deposit_id,
          gam_tenant_id:      r.tenant_id,
          ...(returnFee > 0 ? { gam_ach_return_fee: String(returnFee) } : {}),
        },
      })

      const pay = await queryOne<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description,
           due_date, stripe_payment_intent_id, notes,
           gam_supersedence_amount
         ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', 'DEPOSIT', $6, $7, $8, $9)
         RETURNING id`,
        [
          r.landlord_id, r.tenant_id, r.lease_id, r.unit_id,
          amount.toFixed(2), today, intent.id,
          `FlexDeposit installment ${r.pull_kind} pull (deposit ${r.security_deposit_id})` +
            (returnFee > 0 ? ` + ACH-return $${returnFee.toFixed(2)}` : ''),
          boost.toFixed(2),
        ],
      )
      // Stamp latest payment id + bump attempt_count. attempt_count
      // goes 0→1 on primary fire, 1→2 on retry fire.
      await query(
        `UPDATE flex_deposit_installments
            SET payment_id    = $1,
                attempted_at  = NOW(),
                attempt_count = attempt_count + 1,
                updated_at    = NOW()
          WHERE id = $2`,
        [pay!.id, r.installment_id],
      )
      out.pulls_initiated += 1
    } catch (e: any) {
      logger.error({ err: e, ctx: r.installment_id }, '[flexdeposit][installment-pull]')
      out.errors += 1
    }
  }
  return out
}

// Mark an installment 'missed'. Under the custody model (ToS § 9.1.5) this
// is NOT a default and creates no debt: the plan stays 'active' and the
// deposit is simply under-funded by this installment. No plan-level state
// change, no acceleration, no recourse.
async function markInstallmentMissed(
  installmentId: string,
  depositId: string,
  tenantId: string,
  reason: string,
) {
  await query(
    `UPDATE flex_deposit_installments
        SET status = 'missed', defaulted_at = NOW(),
            default_reason = $1, updated_at = NOW()
      WHERE id = $2`,
    [reason, installmentId],
  )
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'info',
      category: 'flexdeposit_installment_missed',
      title:    `FlexDeposit installment missed`,
      body:     `Installment ${installmentId} for tenant ${tenantId} did not fund: ${reason}. The deposit is under-funded by this installment; no acceleration or recourse (custody model). Funding continues from later installments + GAM-First routing.`,
      context: { installment_id: installmentId, deposit_id: depositId, tenant_id: tenantId, reason },
    })
  } catch (e) { logger.error({ err: e }, '[flexdeposit][alert]') }
}

// ── Custody fee cron ($3/mo while on platform) ───────────────────

export interface CustodyChargeResult {
  cycle_month:      string
  candidates_scanned: number
  charges_created:  number
  charges_skipped_existing: number
  errors:           number
}

/**
 * Monthly cron — runs the 1st of each month. Walks every tenant with
 * an active FlexDeposit plan AND any deposit row on the GAM platform
 * (not just FlexDeposit ones — custody fee covers all deposits being
 * held by GAM escrow or fronted by GAM). Creates the cycle's custody
 * charge + fires the ACH pull.
 *
 * Idempotent via UNIQUE (cycle_month, tenant_id).
 */
export async function processFlexDepositCustodyFee(now: Date = new Date()): Promise<CustodyChargeResult> {
  // ── 10/27: THERE IS NO MONTHLY CUSTODY FEE ANY MORE ───────────────────────
  //
  // On 10/26 the fee became ONE service fee, priced by deposit size and the
  // number of payments, collected in full with the first payment — and both
  // documents the resident accepts were rewritten to say so in terms:
  //
  //   Custody Agreement § 7: "No monthly fee is charged for the period GAM
  //   holds the Deposit, and no further fee arises if Tenant moves to another
  //   property on the Platform and the Deposit is forwarded."
  //   Consumer ToS § 9.1: "There is no monthly fee for the time GAM holds your
  //   deposit."
  //
  // This job was left running. Anybody enrolling would have signed that
  // sentence and then been charged $3 a month from their second cycle — GAM
  // taking money its own agreement says it will not take. It never fired on a
  // real plan only because the product was switched off until 10/26 and there
  // are still zero plans in production.
  //
  // It returns empty rather than being deleted: flex_deposit_custody_charges
  // keeps the rows it already wrote (GAM keeps everything), the webhook and
  // GAM-first routing that settle such a charge stay correct for any row that
  // exists, and if a monthly fee is ever priced again it will be priced from a
  // table like every other fee rather than from a constant resurrected here.
  // The scheduler may keep calling it; it is a no-op.
  return {
    cycle_month: monthStartOf(dateIn(null, now)),
    candidates_scanned: 0, charges_created: 0, charges_skipped_existing: 0, errors: 0,
  }
}

// ── Webhook hooks ────────────────────────────────────────────────

export async function reconcileSettledFlexDepositPayment(
  paymentId: string,
  piMetadata?: Record<string, string> | null,
): Promise<void> {
  const p = await queryOne<{
    tenant_id: string; type: string; entry_description: string | null;
    stripe_payment_intent_id: string | null;
  }>(
    `SELECT tenant_id, type, entry_description, stripe_payment_intent_id
       FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!p) return

  // S514: voluntary pay-ahead settlement. Routed by PI metadata stamp,
  // not installment-row presence (no installment row exists for a
  // pay-ahead pull — it's a single charge for the tenant's remaining
  // unfunded installments, initiated by the tenant). Flips plan →
  // 'completed' and mass-settles all unpaid installments. There is no
  // failure-side terminal state: a failed pay-ahead simply leaves the
  // plan 'active' and the scheduled installment pulls continue.
  if (piMetadata?.gam_purpose === 'flexdeposit_payahead' && piMetadata.gam_deposit_id) {
    await settleFlexDepositPayAhead(piMetadata.gam_deposit_id)
    return
  }

  // Installment reconcile
  if (p.type === 'deposit' && p.entry_description === 'DEPOSIT') {
    const inst = await queryOne<{ id: string; security_deposit_id: string; installment_number: number; installment_count: number; amount: string }>(
      `SELECT id, security_deposit_id, installment_number, installment_count, amount::text
         FROM flex_deposit_installments
        WHERE payment_id = $1 AND status = 'pending'`,
      [paymentId],
    )
    if (inst) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE flex_deposit_installments
              SET status = 'settled', settled_at = NOW(), updated_at = NOW()
            WHERE id = $1`,
          [inst.id],
        )
        await client.query(
          `UPDATE security_deposits
              SET installments_paid      = installments_paid + 1,
                  installments_remaining = GREATEST(installments_remaining - 1, 0),
                  collected_amount       = LEAST(collected_amount + $1, total_amount),
                  next_installment_date  = (
                    SELECT MIN(due_date)
                      FROM flex_deposit_installments
                     WHERE security_deposit_id = $2
                       AND status = 'pending'
                  ),
                  flex_deposit_plan_status = CASE
                    WHEN installments_remaining - 1 <= 0 THEN 'completed'
                    ELSE flex_deposit_plan_status
                  END,
                  status = CASE
                    WHEN collected_amount + $1 >= total_amount THEN 'funded'
                    ELSE status
                  END,
                  updated_at = NOW()
            WHERE id = $2`,
          [Number(inst.amount).toFixed(2), inst.security_deposit_id],
        )
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    }
  }

  // Custody-fee reconcile
  if (p.type === 'fee' && p.entry_description === 'SUBSCRIP') {
    await query(
      `UPDATE flex_deposit_custody_charges
          SET status = 'settled', updated_at = NOW()
        WHERE payment_id = $1`,
      [paymentId],
    )
  }
}

/**
 * NSF handler (S514 custody rework).
 *
 * Each installment fires TWO pull attempts:
 *   - primary (attempt_count goes 0→1)
 *   - retry   (attempt_count goes 1→2)
 *
 * Webhook payment_intent.payment_failed routes through here for any
 * payment with metadata.gam_purpose='flexdeposit_installment'.
 *
 * Behavior:
 *   - Primary attempt failed (attempt_count = 1): installment stays
 *     'pending'; the daily cron picks up the retry on retry_pull_date.
 *     No plan-level state change.
 *   - Retry attempt failed (attempt_count = 2): installment flips to
 *     'missed'. Per ToS § 9.1.5 that is the END of it — no acceleration,
 *     no balance-due-in-full, no plan default, no recourse. The deposit
 *     is simply under-funded by that installment; later installments and
 *     GAM-First routing keep funding the custody balance.
 *
 * Retry timing is locked to retry_pull_date, so the webhook layer must
 * NULL out next_retry_at for FlexDeposit installment failures so achRetry
 * doesn't pick them up.
 */
export async function handleFlexDepositPaymentNsf(paymentId: string): Promise<void> {
  const p = await queryOne<{
    tenant_id: string; type: string; entry_description: string | null;
  }>(
    `SELECT tenant_id, type, entry_description
       FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!p) return
  if (!(p.type === 'deposit' && p.entry_description === 'DEPOSIT')) return

  const inst = await queryOne<{
    id: string; security_deposit_id: string;
    attempt_count: number; installment_number: number;
  }>(
    `SELECT id, security_deposit_id, attempt_count, installment_number
       FROM flex_deposit_installments
      WHERE payment_id = $1`,
    [paymentId],
  )
  if (!inst) return

  // Primary attempt failed (count=1 after pull fired). Don't mark missed
  // yet — the retry will fire on retry_pull_date.
  if (inst.attempt_count <= 1) {
    return
  }

  // Retry attempt failed (count=2). Mark this installment 'missed'. The
  // plan stays 'active'; there is no acceleration or recourse (custody
  // model). markInstallmentMissed emits the (info-level) admin alert.
  await markInstallmentMissed(
    inst.id,
    inst.security_deposit_id,
    p.tenant_id,
    'tenant_nsf_both_attempts_failed',
  )
}

// ── Voluntary pay-ahead (replaces acceleration) ─────────────────

/**
 * S514: tenant-initiated voluntary pay-ahead. Replaces the removed
 * acceleration mechanism. Reached from the tenant LeasePage "Fund
 * remaining deposit now" button when the tenant chooses to top up their
 * custody balance early. This is OPTIONAL and tenant-driven — it is not a
 * demand, an acceleration, or a balance-due-in-full event.
 *
 * Fires a single ACH pull for the sum of the tenant's unfunded (pending +
 * missed) installments. On webhook success the remaining installments are
 * marked 'settled' and the plan flips to 'completed' (see
 * settleFlexDepositPayAhead). On failure, nothing terminal happens: the
 * plan stays 'active' and the scheduled installment pulls keep running.
 */
export async function payAheadFlexDeposit(args: {
  tenantId: string
}): Promise<{ ok: boolean; reason?: string; balance_remaining?: number; payment_id?: string | null }> {
  const dep = await queryOne<{
    id: string; lease_id: string; landlord_id: string; unit_id: string;
    stripe_customer_id: string | null; timezone: string;
  }>(
    `SELECT sd.id, sd.lease_id, l.landlord_id, sd.unit_id,
            t.stripe_customer_id, p.timezone
       FROM security_deposits sd
       JOIN leases   l ON l.id = sd.lease_id
       JOIN units    u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN tenants  t ON t.id = sd.tenant_id
      WHERE sd.tenant_id = $1
        AND sd.flex_deposit_enabled = TRUE
        AND sd.flex_deposit_plan_status = 'active'
        AND sd.status <> 'voided'
      ORDER BY sd.created_at DESC
      LIMIT 1`,
    [args.tenantId],
  )
  if (!dep) return { ok: false, reason: 'No active FlexDeposit plan found for tenant' }

  // Sum unfunded (pending + missed) installments. This is the amount the
  // tenant has yet to fund into their own custody balance — not a debt to GAM.
  const balanceRow = await queryOne<{ remaining: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS remaining
       FROM flex_deposit_installments
      WHERE security_deposit_id = $1
        AND status IN ('pending', 'missed')`,
    [dep.id],
  )
  const remaining = Number(balanceRow?.remaining ?? 0)
  if (remaining <= 0) return { ok: false, reason: 'Deposit is already fully funded' }
  if (!dep.stripe_customer_id) return { ok: false, reason: 'No Stripe customer on tenant' }

  const stripe = getStripe()
  let paymentMethodId: string | null = null
  try {
    const cust = await stripe.customers.retrieve(dep.stripe_customer_id)
    if (cust && !(cust as any).deleted) {
      const c = cust as any
      paymentMethodId = c.invoice_settings?.default_payment_method ?? c.default_source ?? null
    }
  } catch {}
  if (!paymentMethodId) return { ok: false, reason: 'No default payment method on tenant' }

  let paymentId: string | null = null
  try {
    const intent = await createRentPlatformCharge({
      amount:              remaining,
      stripeCustomerId:    dep.stripe_customer_id,
      paymentMethodId,
      paymentMethodTypes:  ['us_bank_account'],
      entryDescription:    'DEPOSIT',
      metadata: {
        gam_purpose:    'flexdeposit_payahead',
        gam_deposit_id: dep.id,
        gam_tenant_id:  args.tenantId,
      },
    })

    // S654: the payment is dated on the property's calendar, not UTC's.
    const today = todayIn(dep.timezone)
    const pay = await queryOne<{ id: string }>(
      `INSERT INTO payments (
         landlord_id, tenant_id, lease_id, unit_id,
         type, amount, status, entry_description,
         due_date, stripe_payment_intent_id, notes
       ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', 'DEPOSIT', $6, $7, $8)
       RETURNING id`,
      [
        dep.landlord_id, args.tenantId, dep.lease_id, dep.unit_id,
        remaining.toFixed(2), today, intent.id,
        `FlexDeposit voluntary pay-ahead (deposit ${dep.id})`,
      ],
    )
    paymentId = pay?.id ?? null
  } catch (e) {
    logger.error({ err: e, ctx: dep.id }, '[flexdeposit][pay-ahead]')
    // Benign failure: no terminal state, plan stays active, crons continue.
    return { ok: false, reason: 'Pull creation failed; no change to plan' }
  }

  return { ok: true, balance_remaining: remaining, payment_id: paymentId }
}

/**
 * S514: pay-ahead settlement handler. Called when the voluntary pay-ahead
 * ACH pull settles. Flips the plan to 'completed' and marks all remaining
 * unfunded (pending + missed) installments 'settled' — they are funded by
 * the pay-ahead charge. Sets collected_amount = total_amount.
 */
async function settleFlexDepositPayAhead(depositId: string): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_deposit_installments
          SET status = 'settled', settled_at = NOW(), updated_at = NOW()
        WHERE security_deposit_id = $1
          AND status IN ('pending', 'missed')`,
      [depositId],
    )
    // Paying the deposit off in full via pay-ahead also stops the custody
    // fee (ToS § 9.1.6 "option 2" rule: lump-fund → fee dissolves).
    await client.query(
      `UPDATE security_deposits
          SET flex_deposit_plan_status = 'completed',
              installments_remaining   = 0,
              installments_paid        = installment_count,
              collected_amount         = total_amount,
              status                   = 'funded',
              next_installment_date    = NULL,
              custody_fee_active       = FALSE,
              updated_at               = NOW()
        WHERE id = $1`,
      [depositId],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── Moving a FlexDeposit to a new unit (S516, re-specified 10/27) ──────────

/**
 * ── 10/27 (Nic): A TOP-UP HAS TWO ROUTES, AND NEITHER IS AUTOMATIC ──────────
 *
 * A resident whose deposit GAM holds moves to a unit with a larger deposit. The
 * difference is a top-up, and Nic set two routes for it:
 *
 *   "i told you two things because there are 2 routes. a route for splitting
 *    the top up into payments and a route where its collected in single
 *    payment."
 *
 *   IN ONE PULL   the whole difference, collected once. One fee, $25, and the
 *                 $5 movement cost is INSIDE it — "The $25 price would already
 *                 have that $5 price included in it."
 *
 *   SPLIT 2 or 4  a plan on the top-up amount, priced from the grid on the
 *                 bracket the TOP-UP falls in ("most people's top up, if
 *                 anything, will fall in that under $1,000 category"), plus the
 *                 $5 movement cost as its own line — "the transfer costs of
 *                 having it go to the new landlord on the split payment
 *                 system."
 *
 * WHAT THE $25 BUYS, in his words, because it is the answer to "what am I
 * paying for" and it is why this is a service price rather than a cut of their
 * money: "what's to stop people on the new deposit from if they need their
 * deposit money to get into the new place, it's the speed of access to it. If
 * they need to wait to get their check mailed from GAM for the deposit refund,
 * just to be able to cash it to give it back to the new landlord, the $25 is
 * buying them the speed and the instantaneousness of having it recorded right
 * there."
 *
 * The cost of COLLECTING is separate either way — "that's not including any
 * banking fees. ACH pull for that collection would still be on there as a
 * separate line item."
 *
 * WHY NOTHING HAPPENS BY ITSELF. Until 10/27 the forward silently scheduled a
 * split, so a resident was put on a payment plan nobody offered them and
 * charged a fee priced as if the top-up were a new deposit. A plan is a thing
 * people accept. So the forward now leaves the deposit simply UNDER-FUNDED —
 * which is the custody model's own normal state, carrying no debt and no
 * acceleration — and a route has to be elected before anything is charged.
 */
/**
 * What the one-pull fee buys, in the resident's words rather than ours. Nic,
 * 10/27, when he worked out why the price is defensible:
 *
 *   "what's to stop people on the new deposit from if they need their deposit
 *    money to get into the new place, it's the speed of access to it. If they
 *    need to wait to get their check mailed from GAM for the deposit refund,
 *    just to be able to cash it to give it back to the new landlord, the $25
 *    is buying them the speed and the instantaneousness of having it recorded
 *    right there."
 *
 * Exported so every surface that offers the choice says the same thing, and so
 * nobody writes a fresh justification for a price that already has one. It
 * names no amount — the amount comes from the price card.
 */
export const FLEX_DEPOSIT_MOVE_IN_FULL_COPY =
  'Your deposit moves across the moment you pay it — no waiting on a refund check to arrive, '
  + 'be cashed, and handed to your new landlord.'

export interface FlexDepositTopUpQuote {
  topUpAmount: number
  /** The whole difference in one pull. */
  payInFull: { fee: number; firstPull: number; total: number }
  /** 2 or 4 payments, priced on the top-up's own bracket plus the movement fee. */
  splits: Array<{
    payments:    number
    /** The grid's price for splitting this amount. */
    fee:         number
    /** The movement cost, charged beside it. */
    movementFee: number
    installment: number
    /** What the first collection takes: payment 1 + both fees + anything above the grid. */
    firstPull:   number
    total:       number
    /** The part above the top of the grid, collected in full. 0 in practice. */
    payUpFront:  number
  }>
}

/**
 * What a top-up would cost each way. Null when there is no top-up owed, or
 * when no price is in effect — a move with no price is refused, never free.
 */
export async function quoteFlexDepositTopUp(
  depositId: string, asOf?: string,
): Promise<FlexDepositTopUpQuote | null> {
  const dep = await queryOne<{ total_amount: string; collected_amount: string; timezone: string }>(
    `SELECT sd.total_amount::text, sd.collected_amount::text, p.timezone
       FROM security_deposits sd
       JOIN leases l ON l.id = sd.lease_id
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE sd.id = $1`,
    [depositId],
  )
  if (!dep) return null
  const topUpAmount = roundHalfEvenCents(
    Number(dep.total_amount) - Number(dep.collected_amount))
  if (topUpAmount <= 0) return null

  const on = asOf ?? todayIn(dep.timezone)
  const { quoteFlexDepositFeeCapped, quoteFlexDepositMoveFees } = await import('./flexFees')
  const move = await quoteFlexDepositMoveFees(on)
  if (move === null) return null

  const splits: FlexDepositTopUpQuote['splits'] = []
  for (const payments of FLEX_DEPOSIT_PAYMENT_CHOICES) {
    const q = await quoteFlexDepositFeeCapped(topUpAmount, payments, on)
    if (q === null) continue
    const { splittable, payUpFront } = q.split
    const installment = roundHalfEvenCents(splittable / payments)
    const first = roundHalfEvenCents(
      installment + roundHalfEvenCents(splittable - installment * payments))
    splits.push({
      payments,
      fee: q.fee,
      movementFee: move.splitMovement,
      installment,
      firstPull: roundHalfEvenCents(first + q.fee + move.splitMovement + payUpFront),
      total: roundHalfEvenCents(topUpAmount + q.fee + move.splitMovement),
      payUpFront,
    })
  }

  return {
    topUpAmount,
    payInFull: {
      fee: move.paidInFull,
      firstPull: roundHalfEvenCents(topUpAmount + move.paidInFull),
      total: roundHalfEvenCents(topUpAmount + move.paidInFull),
    },
    splits,
  }
}

/**
 * Charge a top-up by the route the resident chose.
 *
 * `{ route: 'in_full' }` writes ONE deposit charge for the whole difference
 * plus GAM's single move fee. No installments: nothing is split, so the plan
 * machinery is not involved at all.
 *
 * `{ route: 'split', payments }` writes the installments (numbered after the
 * deposit's existing ones so the unique (deposit, number) constraint holds),
 * the grid's price for splitting, and the movement fee beside it.
 *
 * Must run inside the caller's transaction. The deposit charge is the
 * resident's own custody principal; both fees are GAM's revenue and are kept
 * in their own rows so a deposit return can never hand a fee back.
 */
export async function electFlexDepositTopUp(
  client: PoolClient,
  args: { depositId: string; route: 'in_full' | 'split'; payments?: number },
): Promise<{ ok: true; charged: number; installments: number } | { ok: false; reason: string }> {
  const quote = await quoteFlexDepositTopUp(args.depositId)
  if (!quote) return { ok: false, reason: 'No top-up is owed on this deposit.' }

  const info = await client.query<{
    tenant_id: string; lease_id: string; unit_id: string; landlord_id: string;
    rent_due_day: number; max_num: number; timezone: string;
  }>(
    `SELECT sd.tenant_id, sd.lease_id, u.id AS unit_id, p.landlord_id,
            l.rent_due_day, p.timezone,
            COALESCE((SELECT MAX(installment_number)
                        FROM flex_deposit_installments
                       WHERE security_deposit_id = sd.id), 0) AS max_num
       FROM security_deposits sd
       JOIN leases l ON l.id = sd.lease_id
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE sd.id = $1`,
    [args.depositId],
  ).then(r => r.rows[0])
  if (!info) return { ok: false, reason: 'Deposit not found.' }

  const feeRow = async (amount: number, note: string) => {
    await client.query(
      `INSERT INTO payments (
         unit_id, lease_id, tenant_id, landlord_id,
         type, amount, status, due_date, entry_description, revenue_owner, notes
       ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', CURRENT_DATE, 'FLEXDEP', 'gam', $6)`,
      [info.unit_id, info.lease_id, info.tenant_id, info.landlord_id, amount.toFixed(2), note])
  }

  if (args.route === 'in_full') {
    // The whole difference, once. Its own deposit-type row: custody principal,
    // which comes back at move-out.
    await client.query(
      `INSERT INTO payments (
         unit_id, lease_id, tenant_id, landlord_id,
         type, amount, status, due_date, entry_description, notes
       ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', CURRENT_DATE, 'DEPOSIT', $6)`,
      [
        info.unit_id, info.lease_id, info.tenant_id, info.landlord_id,
        quote.topUpAmount.toFixed(2),
        `FlexDeposit top-up, paid in full (deposit ${args.depositId})`,
      ])
    await feeRow(quote.payInFull.fee,
      `FlexDeposit move — top-up recorded at once (deposit ${args.depositId})`)
    return { ok: true, charged: quote.payInFull.firstPull, installments: 0 }
  }

  const payments = args.payments ?? 0
  const chosen = quote.splits.find(s => s.payments === payments)
  if (!chosen) {
    return { ok: false, reason: 'Choose 2 payments or 4 — those are the two FlexDeposit splits.' }
  }
  // Anchor to next month so the first top-up pull is upcoming, not overdue.
  // S654: "this month" is the property's month; UTC is already next month
  // after 5 pm on the last day in Phoenix, which would skip a month.
  const startDate = addMonths(monthStartOf(todayIn(info.timezone)), 1)
  const schedule = computeFlexDepositSchedule({
    depositTotal:     roundHalfEvenCents(chosen.installment * payments),
    payUpFront:       chosen.payUpFront,
    installmentCount: payments,
    startDate,
    rentDueDay:       info.rent_due_day,
    serviceFee:       chosen.fee,
  })
  const maxNum = Number(info.max_num)
  const grandTotal = maxNum + payments
  for (let i = 1; i <= payments; i++) {
    const inst = schedule.installments[i - 1]
    const pulls = computeInstallmentPullDates(startDate, i, info.rent_due_day)
    await client.query(
      `INSERT INTO flex_deposit_installments
         (security_deposit_id, tenant_id, installment_number, installment_count,
          amount, due_date, primary_pull_date, retry_pull_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [
        args.depositId, info.tenant_id, maxNum + i, grandTotal,
        inst.amount.toFixed(2), inst.dueDate, pulls.primary, pulls.retry,
      ])
  }
  await feeRow(chosen.fee, `FlexDeposit top-up split into ${payments} (deposit ${args.depositId})`)
  await feeRow(chosen.movementFee,
    `FlexDeposit move — transfer to the new landlord (deposit ${args.depositId})`)
  await client.query(
    `UPDATE security_deposits
        SET installment_count      = $2,
            installment_amount     = $3,
            installments_remaining = $4,
            next_installment_date  = $5,
            updated_at             = NOW()
      WHERE id = $1`,
    [
      args.depositId, grandTotal, schedule.installmentAmount.toFixed(2),
      payments, schedule.installments[0].dueDate,
    ])
  return { ok: true, charged: chosen.firstPull, installments: payments }
}

// ── helpers ─────────────────────────────────────────────────────

function roundHalfEvenCents(value: number): number {
  const cents = value * 100
  const floor = Math.floor(cents)
  const diff = cents - floor
  if (diff < 0.5) return floor / 100
  if (diff > 0.5) return (floor + 1) / 100
  return (floor % 2 === 0 ? floor : floor + 1) / 100
}

function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1 + months, d))
  return date.toISOString().slice(0, 10)
}

/**
 * S260: compute the (primary_pull_date, retry_pull_date) for a
 * FlexDeposit installment N >= 2. Each installment covers the rent
 * cycle that lands N-1 months after move-in. Primary pull fires 5 days
 * before that cycle's rent_due_date; retry fires 1 day before. Both
 * clamped to month-length when rent_due_day exceeds the cycle month's
 * days (e.g., rent_due_day=31 in February → 28/29 → primary=23/24).
 */
function computeInstallmentPullDates(
  startDate: string,
  installmentNumber: number,
  rentDueDay: number,
): { primary: string; retry: string } {
  const [sy, sm] = startDate.split('-').map(Number)
  // Installment N covers the cycle (N-1) months after the move-in month.
  const cycleMonth = sm - 1 + (installmentNumber - 1)
  const cycleYear = sy
  // Clamp rent_due_day to the cycle month's actual days.
  const lastDayOfCycle = new Date(Date.UTC(cycleYear, cycleMonth + 1, 0)).getUTCDate()
  const clampedDueDay = Math.min(rentDueDay, lastDayOfCycle)
  const rentDue = new Date(Date.UTC(cycleYear, cycleMonth, clampedDueDay))
  const primary = new Date(rentDue.getTime() - 5 * 86_400_000)
  const retry   = new Date(rentDue.getTime() - 1 * 86_400_000)
  return {
    primary: primary.toISOString().slice(0, 10),
    retry:   retry.toISOString().slice(0, 10),
  }
}
