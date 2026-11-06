import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { isFeatureEnabled } from './systemFeatures'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import { computeTenantGamOutstandingTotal } from './supersedence'
import { openAmountSql } from './openBalances'
// S527: single source for the Stripe ACH-return pass-through (same Stripe
// fee regardless of product; Consumer ToS § 9.1.4 promises it "per retry at
// actual cost, no markup" for FlexDeposit exactly as § 4.2 does for FlexPay).
import { FLEXPAY_ACH_RETURN_FEE as ACH_RETURN_FEE } from './flexpay'
import {
  getFlexDepositMaxInstallments,
  isAllowedFlexDepositPaymentCount,
  flexDepositPaymentChoicesForLeaseType,
  flexDepositScheduleFitsLease,
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
// There is NO monthly custody fee (10/26, Nic): the whole service fee
// is priced from flexdeposit_fee_schedule and rides the first pull
// alongside installment 1. FLEX_DEPOSIT_CUSTODY_FEE is deprecated and
// processFlexDepositCustodyFee is a documented no-op.
// At lease-end the deposit-return flow settles
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
    // 10/28: a bank that has not been STARTED. Distinct from 'ach_unverified',
    // which other products still use to mean "not verified yet" — FlexDeposit
    // no longer refuses that, it only refuses somebody who has not begun.
    | 'no_bank_started'
    | 'no_deposit_row'
    | 'no_bg_result'
    | 'bg_not_approved'
    | 'risk_level_missing'
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
    // 10/27: the tenancy ends before even the shortest schedule could finish,
    // so the deposit would be short on the day the landlord is owed it. A
    // two-month lease, not a judgement about the resident.
    | 'lease_too_short_for_any_plan'
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
 *
 * ── 10/27: WHY THE RESERVE IS NOT A GATE HERE ──────────────────────────────
 *
 * GAM now covers a landlord for the part of a deposit a resident never funded
 * (services/depositReturn.ts), so it is tempting to refuse a plan the reserve
 * could not cover. That would be wrong, and Nic said why:
 *
 *   "we need no capital until the first leases end. we hold custody so its
 *    pure money now. we start building the seed asap to protect against
 *    defaults."
 *
 * The money is not due at enrollment — it is due the day that tenancy ends,
 * which on a year lease is a year of fee income away. A reserve test would
 * refuse the FIRST plan, whose fee is what starts the reserve, and refuse it
 * for a bill that cannot arrive for months.
 *
 * So the reserve is INFORMATION, not a brake: services/flexDepositExposure.ts
 * reports it beside the cash each upcoming month actually needs, and these two
 * hand-set ceilings stay the brake. Nic raises them himself — "Proposes, you
 * approve" — which is why they live in a table with an `updated_by`, and not
 * in a formula that moves on its own.
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
 *  - a bank link BEGUN (10/29: FlexDeposit is open to anybody — the
 *    fixed-income rule is FlexPay's alone, see the gate below)
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
  const offer = await flexDepositOffer({ userId })
  return offer ? { depositAmount: offer.depositAmount } : null
}

/** What a resident is offered on a deposit they still owe. */
export interface FlexDepositOffer {
  tenantId: string
  /** The whole deposit, which is what they owe today if they do nothing. */
  depositAmount: number
  /** Already funded toward it (a part payment), so the prompt can say so. */
  collected: number
  /** Priced 2- and 4-payment splits, exactly as the enrollment screen shows. */
  choices: FlexDepositEligibility['choices']
  /** The least they could pay today instead of the whole deposit. */
  lowestFirstPull: number
  /**
   * Everything else the resident owes RIGHT NOW besides the deposit — their
   * first month's rent and any move-in fees. The plan changes only the deposit
   * part, so this is what has to sit beside it for "due at move-in" to be the
   * real figure rather than deposit arithmetic.
   */
  otherDueNow: number
  /**
   * They have not begun linking a bank, so the plan cannot be taken yet —
   * installments are bank-only. The offer still stands, because that is the
   * one blocker the resident can clear themselves in a minute, and telling
   * them about the plan is exactly how they learn it is worth doing. Every
   * other blocker is a reason there is NO offer at all.
   */
  needsBank: boolean
}

/**
 * ── 10/29 (Nic): THE OFFER STANDS UNTIL THE DEPOSIT IS SETTLED ──────────────
 *
 *   "We need the prompt to pop up for any tenants when the deposit has not
 *    been paid yet. If they log in to go and pay their bill, that needs to ask
 *    if they want to sign up for flex deposit at that point. It needs to be
 *    there until the deposit is handled one way or another."
 *
 * One signal, read by every surface, so they cannot disagree: the signing
 * prompt, the portal's home and payments screens, and the one-time email.
 *
 * What it replaces was a nudge that fired ONLY for somebody whose bank was
 * "neither verified nor already begun" — which skipped exactly the people most
 * ready to enrol, and fired once, at signing, never again. The resident who
 * signed MH 28 on 10/28 verified her bank at 5:29 the next morning and would
 * have paid a $450 deposit in full on November 1st without ever being shown
 * the $225 or $112.50 she could have paid instead. Nothing in the product
 * would have told her it existed.
 *
 * It goes quiet on the FACT, not on the click: when the deposit is funded or a
 * plan is running, there is no offer. Closing the prompt is "not now".
 *
 * Takes a user id (what a signer row carries) or a tenant id (what the portal
 * has). Returns null whenever there is nothing to offer — product off, deposit
 * settled, already enrolled, or not eligible — so a caller never has to know
 * why, and an error is never a reason to block a resident's screen.
 */
/**
 * ── 10/29 (Nic): WHAT THEY ACTUALLY HAND OVER AT MOVE-IN ────────────────────
 *
 *   "That's only showing the total of payments what they'll pay. It's not
 *    showing what's due at move-in. It needs to generate whatever their first
 *    month is."
 *
 * The plan's own numbers describe the DEPOSIT and nothing else, so a resident
 * reading "$273.00 at move-in" against a $900 bill is reading a figure that
 * was never what they would pay. This is the rest of that bill: every unpaid
 * charge on the same lease except the security deposit the plan replaces.
 *
 * Credit already applied comes off (openAmountSql), so it is what is owed and
 * not what was billed. A lease with nothing else outstanding returns 0, and
 * the screen then shows the deposit figures alone, which is correct.
 */
export async function depositSiblingChargesDue(tenantId: string): Promise<number> {
  const r = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(${openAmountSql('p')}), 0)::text AS total
       FROM payments p
      WHERE p.lease_id = (SELECT sd.lease_id FROM security_deposits sd
                           WHERE sd.tenant_id = $1 AND sd.status IN ('pending', 'partial')
                             AND sd.voided_at IS NULL
                           ORDER BY sd.created_at DESC LIMIT 1)
        AND p.status IN ('pending', 'failed')
        AND p.amount > 0
        -- The security deposit itself is what the plan replaces; a pet or key
        -- deposit (it carries its own lease_fees row) is a separate charge they
        -- still owe in full, so it stays in.
        AND NOT (p.type = 'deposit' AND p.lease_fee_id IS NULL)`,
    [tenantId])
  return Math.round(Number(r?.total ?? 0) * 100) / 100
}

export async function flexDepositOffer(
  who: { userId?: string; tenantId?: string },
): Promise<FlexDepositOffer | null> {
  if (!who.userId && !who.tenantId) return null
  if (!await isFlexDepositVisible()) return null

  // Cheap first: is there a deposit still owed that no plan is covering? This
  // runs on the portal's own /me, so the expensive eligibility pass below is
  // reached only by someone who could actually be offered something.
  const dep = await queryOne<{
    tenant_id: string; total: number; collected: number
  }>(
    `SELECT sd.tenant_id, sd.total_amount::float8 AS total,
            sd.collected_amount::float8 AS collected
       FROM security_deposits sd
       JOIN tenants t ON t.id = sd.tenant_id
      WHERE ${who.tenantId ? 't.id = $1' : 't.user_id = $1'}
        AND sd.status IN ('pending', 'partial')
        AND sd.total_amount > 0
        AND sd.collected_amount < sd.total_amount
        AND sd.flex_deposit_enabled IS NOT TRUE
        AND sd.voided_at IS NULL
      ORDER BY sd.created_at DESC
      LIMIT 1`,
    [who.tenantId ?? who.userId])
  if (!dep) return null

  const elig = await getFlexDepositEligibility(dep.tenant_id)
  // 10/27's original nudge existed precisely to tell somebody with no bank to
  // go and link one, so a missing bank cannot be the reason they are never
  // told. It is the one blocker the resident clears themselves; everything
  // else — the landlord's standing, capacity, the background check, the lease
  // being too short — is a reason there is nothing to offer, and prompting
  // anyway would be offering something they cannot have.
  const blocking = elig.blockers.filter(b => b !== 'no_bank_started')
  if (blocking.length || !elig.choices.length) return null

  return {
    tenantId: dep.tenant_id,
    depositAmount: dep.total,
    collected: dep.collected,
    choices: elig.choices,
    lowestFirstPull: Math.min(...elig.choices.map(c => c.firstPull)),
    otherDueNow: await depositSiblingChargesDue(dep.tenant_id),
    needsBank: elig.blockers.includes('no_bank_started'),
  }
}

export async function getFlexDepositEligibility(tenantId: string): Promise<FlexDepositEligibility> {
  const t = await queryOne<{
    ach_verified: boolean
    bg_status: string | null
    bank_pending: boolean
  }>(
    `SELECT ach_verified, background_check_status AS bg_status,
            bank_pending_since IS NOT NULL AS bank_pending
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

  // ── 10/29 (Nic): FLEXDEPOSIT IS FOR ANYBODY. THE FIXED-INCOME RULE IS
  //    FLEXPAY'S, AND ONLY FLEXPAY'S ─────────────────────────────────────
  //
  //   "FlexPay is for fixed income people. FlexDeposit is for anybody. Two
  //    different requirements for two different products."
  //
  // Until now this refused everyone who was not an SSDI/SSI recipient, which
  // is where the two products had been conflated: FlexPay fronts the
  // landlord's rent and is gated on verified fixed income, while FlexDeposit
  // floats nothing — the resident funds their own deposit in two or four
  // pulls off their own verified bank. There is no exposure to tier for, so
  // there is nothing for an income test to decide.
  //
  // Found live: the resident who signed MH 28 on 10/28 could not have been
  // offered it, on a $450 deposit this product exists for.
  //
  // What still gates it is unchanged and is about the MONEY, not the person:
  // a bank link begun, an approved background check, the landlord
  // established, capacity, and the signing window below.

  // ── 10/28 (Nic): ENROLLMENT LEADS INTO THE BANK FLOW, NOT BLOCKED BY IT ──
  //
  //   "Let's enroll and see the terms with the bank still pending, because they
  //    should be able to be like, hey, I'm interested in signing up. Okay, add
  //    your bank account and go into the bank account flow."
  //
  // Verification is microdeposits only and takes days, so an unverified bank
  // used to mean the resident saw NOTHING — the tile would not even open, let
  // alone show them their schedule, their two-or-four choice and their fee.
  // Nothing in the money path ever read this flag: installments resolve a
  // payment method at pull time and mark the row missed when there is none.
  //
  // Safe only because the recording now follows real money (10/28): the
  // landlord's books take the deposit when the first installment SETTLES, so
  // enrolling on a bank that never verifies records no funded deposit and
  // leaves the deposit simply owed, like any other unpaid one.
  //
  // Somebody who has not STARTED a bank link is still refused — there is
  // nothing in flight to wait for. The signing-day gate further down is
  // untouched: it already reads bank_pending_since and is the thing that keeps
  // this from becoming an open-ended window.
  if (!t.ach_verified && !t.bank_pending) blockers.push('no_bank_started')

  // ── 10/29 (Nic): FLEXDEPOSIT IS NOT GATED BY STATE ──────────────────────
  //
  //   "no we are not blocking by state. let her use flex deposit"
  //
  // Raised and decided the same day. Enrollment force-sets held_by =
  // 'gam_escrow' regardless of the S604 custody rules, and that stands as
  // written: FlexDeposit does not consult state_deposit_custody_rules, and a
  // resident in a state recorded `blocked` enrolls like anyone else. The first
  // real case was MH 28 at Country Acres - Mattoon — Illinois, recorded
  // blocked with reason `vehicle_unconfirmed` (765 ILCS 745/18 wants a
  // federally insured depository and no commingling with the park owner's
  // assets; Illinois qualifies with a segregated account, which is a banking
  // decision, not a code one).
  //
  // This is the standing platform rule applied to GAM's own side: GAM
  // accommodates and does not block ([[gam-never-gate-on-legality]]). A gate
  // was added here earlier today and taken straight back out on his
  // instruction — do NOT re-add one. If the custody vehicle changes, the
  // rules table is where that gets recorded, not an eligibility blocker.
  //
  // What this does NOT touch: leaseFeesSync's gate, which decides who HOLDS an
  // ordinary deposit (landlord vs gam_escrow). That is routing, not a refusal,
  // and no one asked for it to change.

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
  // ── 10/27 (Nic): THE LEASE DECIDES HOW MANY SPLITS ARE ON OFFER ───────────
  //
  //   "month to month possibly being gated to 2 payments only and fixed term
  //    being 2 or 4 payments ... because we can't control what lease types a
  //    landlord offers, and we don't want the landlord to block people from
  //    using our product."
  //
  // So the PRODUCT is never gated on lease type — a month-to-month resident is
  // still offered FlexDeposit — only the number of splits is. Plus the hard
  // one: a schedule that ends after the tenancy does is short on the day the
  // landlord is owed the money, by arithmetic rather than by bad luck. Nothing
  // here looked at the lease's end date until now.
  //
  // Both rules live in @gam/shared so this surface and the enrollment gate
  // below cannot drift apart. Keyed to the LEASE, never to the applicant —
  // see flexDepositPaymentChoicesForLeaseType on why that distinction matters.
  const leaseTerms = dep ? await fetchUnfundedDeposit(tenantId) : null
  const allowedCounts = flexDepositPaymentChoicesForLeaseType(leaseTerms?.lease_type)
  // Kept separate from the pricing loop so an empty offer can say WHICH thing
  // was wrong: a tenancy too short to carry any schedule is a different fact
  // from a price table with a hole in it, and they need different answers.
  const fittingCounts = FLEX_DEPOSIT_PAYMENT_CHOICES.filter((payments) =>
    allowedCounts.includes(payments)
    && (!leaseTerms || flexDepositScheduleFitsLease(
          leaseTerms.start_date.slice(0, 10), payments, leaseTerms.lease_end)))
  if (dep && fittingCounts.length === 0) blockers.push('lease_too_short_for_any_plan')

  const choices: FlexDepositEligibility['choices'] = []
  if (depositAmount !== null && depositAmount > 0) {
    const asOf = todayIn(null)
    for (const payments of fittingCounts) {
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
  lease_type: string | null; lease_end: string | null;
}

async function fetchUnfundedDeposit(tenantId: string): Promise<FlexDepositDepositRow | null> {
  return queryOne<FlexDepositDepositRow>(
    // 10/27: lease_type and end_date come along because they decide how many
    // splits this lease can carry, and whether a schedule would outlive the
    // tenancy. Every caller that builds a schedule needs both.
    `SELECT sd.id, sd.total_amount::text, sd.lease_id,
            l.start_date::text, l.rent_due_day,
            l.lease_type, l.end_date::text AS lease_end
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
  // 10/27: the preview must refuse what enrollment will refuse, or the resident
  // reads and accepts an agreement for a plan they cannot actually have.
  if (!flexDepositPaymentChoicesForLeaseType(dep.lease_type)
        .includes(args.installmentCount as 2 | 4)) {
    return {
      ok: false,
      reason: 'A month-to-month lease splits a deposit across 2 payments. Four is available on a fixed term.',
    }
  }
  if (!flexDepositScheduleFitsLease(
        dep.start_date.slice(0, 10), args.installmentCount, dep.lease_end)) {
    return { ok: false, reason: 'This lease ends before that schedule would finish. Choose fewer payments.' }
  }
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

  // 10/27: the lease's own two limits, enforced HERE and not only on the offer
  // screen. getFlexDepositEligibility hides a split the lease cannot carry, but
  // that is a read — this is the write, and a stale page or a direct POST would
  // otherwise walk straight past it.
  const leaseRow = await fetchUnfundedDeposit(args.tenantId)
  if (leaseRow) {
    const allowed = flexDepositPaymentChoicesForLeaseType(leaseRow.lease_type)
    if (!allowed.includes(args.installmentCount as (typeof allowed)[number])) {
      return {
        ok: false,
        reason: 'A month-to-month lease splits a deposit across 2 payments. Four is available on a fixed term.',
      }
    }
    if (!flexDepositScheduleFitsLease(
          leaseRow.start_date.slice(0, 10), args.installmentCount, leaseRow.lease_end)) {
      return {
        ok: false,
        reason: 'This lease ends before that schedule would finish. Choose fewer payments.',
      }
    }
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
      // 10/30 (Nic): NO PULL DATES. Installments no longer run on their own
      // ACH schedule -- each one rides the next invoice the lease generates
      // (jobs/invoiceGeneration), so there is no date to compute here and
      // nothing correlates with the day the resident happened to sign up.
      await client.query(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count,
            amount, due_date, primary_pull_date, retry_pull_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [
          dep.id, args.tenantId, inst.number, args.installmentCount,
          inst.amount.toFixed(2), inst.dueDate,
          null,
          null,
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

    // ── 10/30 (Nic): ENROLLING AFTER THE BILL WENT OUT ──────────────────
    //
    // The move-in path converts the deposit line into installment 1 only when
    // the plan already exists as the invoice is written (jobs/moveInBundle).
    // Heather Miller was invoiced 10/28 and enrolled 10/29, so her bill kept
    // the FULL deposit price and installment 1 was linked to nothing -- she was
    // asked for $450 against a $112.50 installment, and because the plan looked
    // unfunded the tenant pay-ahead banner then offered to debit the whole $450
    // again. There was no path for "enrolled after invoicing" at all.
    //
    // So: adopt the deposit line that is already billed. Rewrite it to
    // installment 1 and link installment 1 to it, write GAM's service fee as
    // its own row off the invoice, and rebuild the bill from its own lines —
    // exactly as the move-in path would have.
    //
    // Only an UNPAID line with no plan link is touched -- never a deposit that
    // has already settled, and never one some other plan already owns.
    const billed = await client.query<{
      id: string; invoice_id: string | null; unit_id: string | null
      tenant_id: string | null; landlord_id: string; due_date: string
    }>(
      `SELECT id, invoice_id, unit_id, tenant_id, landlord_id, due_date::text AS due_date
         FROM payments
        WHERE lease_id = $1 AND type = 'deposit' AND status = 'pending'
          AND flex_deposit_security_deposit_id IS NULL
        ORDER BY created_at
        LIMIT 1`,
      [dep.lease_id],
    )
    const billedRow = billed.rows[0]
    if (billedRow) {
      // 11/1 — ONE ROW EACH, HERE TOO.
      //
      // This used to rewrite the billed line to firstPullTotal: installment 1
      // AND the whole service fee, in a single row typed 'deposit' and owned by
      // the landlord. The move-in path has never done that, on purpose
      // (jobs/moveInBundle 10/26): installment 1 is the resident's own money and
      // comes back to them at move-out, while the fee is GAM's revenue. Folded
      // together, the fee rides into the custody balance — so at settlement the
      // trust liability counts $67 that is not the resident's deposit, the same
      // $67 is booked again as GAM revenue (recordPlatformRevenue), and the
      // landlord's "Tenant owes GAM" reads $0 because openBills derives it from
      // revenue_owner = 'gam'. Every dollar has to be counted once.
      await client.query(
        `UPDATE payments
            SET amount = $1,
                flex_deposit_security_deposit_id = $2,
                notes = $3
          WHERE id = $4`,
        [
          schedule.firstAmount.toFixed(2),
          dep.id,
          'Security deposit — installment 1 of ' + args.installmentCount
            + '. Deposit line adopted into the plan at enrollment, which came'
            + ' after this invoice was written.',
          billedRow.id,
        ],
      )
      await client.query(
        `UPDATE flex_deposit_installments
            SET payment_id = $1, updated_at = NOW()
          WHERE security_deposit_id = $2 AND installment_number = 1 AND status = 'pending'`,
        [billedRow.id, dep.id],
      )
      // GAM's fee, its own row, off the landlord's invoice — the same shape the
      // move-in bundle writes. ON CONFLICT is not available here (no unique key
      // on this pair), so the guard is the NOT EXISTS: enrolling twice writes
      // one fee, never two.
      if (schedule.serviceFee > 0) {
        await client.query(
          `INSERT INTO payments (
             unit_id, lease_id, tenant_id, landlord_id,
             type, amount, status, due_date, entry_description, revenue_owner, notes,
             flex_deposit_security_deposit_id
           )
           SELECT $1, $2, $3, $4, 'fee', $5, 'pending', $6::date, 'FLEXDEP', 'gam', $7, $8
            WHERE NOT EXISTS (
              SELECT 1 FROM payments
               WHERE flex_deposit_security_deposit_id = $8
                 AND type = 'fee' AND entry_description = 'FLEXDEP'
                 AND status <> 'voided')`,
          [
            billedRow.unit_id, dep.lease_id, billedRow.tenant_id, billedRow.landlord_id,
            schedule.serviceFee.toFixed(2), billedRow.due_date,
            `FlexDeposit service fee (deposit ${dep.id})`, dep.id,
          ],
        )
      }
      if (billedRow.invoice_id) {
        // 11/1: every subtotal, not just the total. This re-totalled
        // total_amount alone and left subtotal_deposits at the full deposit
        // price, so the bill's own line figures stopped adding up to it. The
        // other four re-total sites rebuild all five (leaseEndPullBack,
        // renewalSuccessor, registerFinalUtility, utilityPayLink); this is the
        // same statement.
        // Word for word the statement services/utilityPayLink retotalInvoice
        // runs, because the differences matter and a fifth spelling of them is
        // how they drift:
        //   * a landlord DEPOSIT-tagged box (pet, key, cleaning) is written
        //     type='deposit' WITH lease_fee_id (jobs/moveInBundle), and belongs
        //     in subtotal_FEES — not in deposits;
        //   * only money still standing counts: 'failed' and 'returned' are out;
        //   * the TOTAL skips a work-trade-suspended line (labor pays it) while
        //     the subtotal still shows it — what the month was worth against
        //     what is owed;
        //   * never touch a voided bill, and roll the status after.
        // NOTE: four copies of this now exist (utilityPayLink, leaseEndPullBack,
        // renewalSuccessor, registerFinalUtility) and they are NOT identical —
        // leaseEndPullBack counts 'failed' on purpose. Worth one shared helper
        // with the status set as its argument; not a change to make blind.
        await client.query(
          `WITH lines AS (
             SELECT p.type, p.amount, p.lease_fee_id, p.work_trade_suspended_at
               FROM payments p
              WHERE p.invoice_id = $1
                AND p.status IN ('pending', 'processing', 'settled', 'paid_via_deposit')),
           t AS (
             SELECT COALESCE(SUM(amount) FILTER (WHERE work_trade_suspended_at IS NULL AND type <> 'late_fee'), 0) AS total,
                    COALESCE(SUM(amount) FILTER (WHERE type = 'rent'), 0) AS rent,
                    COALESCE(SUM(amount) FILTER (WHERE type = 'fee'
                                                 OR (type = 'deposit' AND lease_fee_id IS NOT NULL)), 0) AS fees,
                    COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND lease_fee_id IS NULL), 0) AS deposits,
                    COALESCE(SUM(amount) FILTER (WHERE type = 'utility'), 0) AS utilities,
                    COALESCE(SUM(amount) FILTER (WHERE type = 'home_payment'), 0) AS home
               FROM lines)
           UPDATE invoices i
              SET total_amount = t.total, subtotal_rent = t.rent, subtotal_fees = t.fees,
                  subtotal_deposits = t.deposits, subtotal_utilities = t.utilities,
                  subtotal_home_payments = t.home, updated_at = NOW()
             FROM t
            WHERE i.id = $1 AND i.status <> 'void'
              AND (i.total_amount, i.subtotal_rent, i.subtotal_fees, i.subtotal_deposits,
                   i.subtotal_utilities, i.subtotal_home_payments)
                  IS DISTINCT FROM (t.total, t.rent, t.fees, t.deposits, t.utilities, t.home)`,
          [billedRow.invoice_id],
        )
        await client.query(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [billedRow.invoice_id])
      }
      logger.info({ deposit_id: dep.id, payment_id: billedRow.id },
        '[flexdeposit] an already-billed deposit line was adopted into the plan at enrollment')
    }

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
 * deposit-return flow settles against collected_amount at lease-end
 * (ToS § 9.1.3 / § 9.1.5).
 *
 * 10/27 — CORRECTION. This docblock used to end "GAM advances nothing, so
 * there is no gap for GAM to 'eat'". That is not the product. Nic:
 *
 *   "Any deposits we hold are absolutely going to the landlord. That is our
 *    risk to take, and that is why we are making the money on the flex
 *    deposit... The landlord gets what they're owed, full stop."
 *
 * GAM still advances nothing AT MOVE-IN — that part was right, and it is what
 * keeps this custody rather than credit. But at LEASE END, if the landlord's
 * deductions reach into the part the resident never funded, GAM pays the
 * difference in cash and never pursues the resident for it
 * (services/depositReturn.ts, flexDepositShortfall). The resident's own
 * refund absorbs the gap first, because a deposit refund is computed against
 * what is actually held (§ 8(ii)) — so the money GAM finds is only ever what
 * the deductions reach past that.
 *
 * Returns null stripeTransferId always (no transfer fires under custody).
 */
/**
 * LINK installment 1 to the payment that will fund it — and settle nothing.
 *
 * 10/28 (Nic): "We would only record the deposit as paid in full when they make
 * their first installment on it... On our books, they still owe. On the
 * landlord's books, it's paid in full. But they only get that when the first
 * payment happens."
 *
 * This used to be settleFlexDepositMoveIn, and it flipped installment 1 to
 * 'settled', raised collected_amount, moved the deposit to partial/funded and
 * booked GAM's whole service fee — all at LEASE FINALIZE, against a payments
 * row inserted seconds earlier as 'pending' with no PaymentIntent. No cash was
 * involved anywhere in it. With enrollment now allowed while a bank is still
 * verifying, that would have recorded a funded deposit for residents who never
 * paid a cent.
 *
 * So installment 1 is now funded the way 2..N always were: the payment row
 * carries the link, and whatever settles it — the ACH pull, a card, or cash at
 * the front desk — runs reconcileSettledFlexDepositPayment, which settles the
 * installment, raises the counters and books the fee. One path, one set of
 * rules, and the money has to exist.
 */
export async function linkFlexDepositMoveInPayment(args: {
  tenantId:                 string
  securityDepositId:        string
  movInPaymentId:           string
}): Promise<{ linked: boolean }> {
  const linked = await query<{ id: string }>(
    `UPDATE flex_deposit_installments
        SET payment_id = $1, updated_at = NOW()
      WHERE security_deposit_id = $2 AND installment_number = 1
        AND status = 'pending' AND payment_id IS DISTINCT FROM $1
      RETURNING id`,
    [args.movInPaymentId, args.securityDepositId],
  )
  if (!linked.length) {
    // Either already linked to this payment (a re-run) or installment 1 is no
    // longer pending (already funded). Both are fine; neither is a settle.
    const exists = await queryOne<{ id: string }>(
      `SELECT id FROM flex_deposit_installments
        WHERE security_deposit_id = $1 AND installment_number = 1 LIMIT 1`,
      [args.securityDepositId])
    if (!exists) throw new Error('No installment 1 row for FlexDeposit move-in')
  }
  return { linked: linked.length > 0 }
}

// ── Installments 2..N (billed on invoices; see jobs/invoiceGeneration) ────────

export interface InstallmentDueResult {
  candidates_scanned: number
  pulls_initiated:    number
  errors:             number
}

/**
 * ── 10/27 (Nic): A NEW BANK OR CARD RESTARTS A STUCK SCHEDULE ───────────────
 *
 *   "the other way is an automatic payment when payment method is changed at
 *    all. new bank or new debit card. it rides the invoice so the tenant
 *    cannot pay the landlord without paying us. for partial payments we
 *    recoup first."
 *
 * The riding-the-invoice half has worked since S261 (services/supersedence.ts:
 * a missed installment is satisfied GAM-first out of any payment the resident
 * makes, oldest first, and a plan never leaves 'active' except by completing).
 * This is the other half: the usual reason an installment goes 'missed' is that
 * the bank it was pulling from stopped working, and the daily cron never looks
 * at a missed row again — only 'pending' ones with a pull date. So the schedule
 * sits stuck on a dead account even after the resident fixes the account.
 *
 * WHAT THIS DELIBERATELY IS NOT. It does not charge anything. It re-arms the
 * row — back to 'pending', attempt count zero, pull date today — so the next
 * run of the ordinary installment cron pulls it on the method that now works.
 * One charge path, already tested, with its own locks and idempotency; a second
 * one fired straight from a webhook would be a new way to take money and a new
 * way to take it twice.
 *
 * It is also not a new authorisation. The resident authorised this schedule at
 * enrollment and still owes these installments toward their own deposit; what
 * changed is only which account the agreed pull reaches. `defaulted_at` and
 * `default_reason` are LEFT IN PLACE, so the history still says the pull failed
 * and why — re-arming is not the same as pretending it never happened.
 *
 * Returns how many rows were re-armed, for the log.
 */
export async function rearmMissedFlexDepositInstallments(tenantId: string): Promise<number> {
  if (!await isFlexDepositVisible()) return 0
  const rows = await query<{ id: string }>(
    `UPDATE flex_deposit_installments i
        SET status            = 'pending',
            attempt_count     = 0,
            -- 10/30 (Nic): no pull dates. Nothing debits a bank on a schedule
            -- of its own any more -- re-armed back to 'pending' is all it takes,
            -- because the next invoice this lease generates picks up any
            -- installment that is not settled and not already sitting on a live
            -- bill (jobs/invoiceGeneration).
            primary_pull_date = NULL,
            retry_pull_date   = NULL,
            updated_at        = NOW()
       FROM security_deposits sd
       JOIN leases l     ON l.id = sd.lease_id
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE i.security_deposit_id = sd.id
        AND i.tenant_id = $1
        AND i.status = 'missed'
        AND i.installment_number > 1
        AND sd.flex_deposit_plan_status = 'active'
        AND sd.voided_at IS NULL
        AND sd.status <> 'voided'
        -- Nothing to collect on a deposit already fully funded, however it got
        -- there (GAM-first routing may have satisfied this very installment).
        AND COALESCE(sd.collected_amount, 0) < sd.total_amount
      RETURNING i.id`,
    [tenantId],
  )
  if (rows.length > 0) {
    logger.info({ tenant_id: tenantId, rearmed: rows.length },
      '[flexdeposit] a working payment method restarted a stuck installment schedule')
  }
  return rows.length
}

/**
 * @deprecated 10/30 (Nic): DEAD AS A PULL. FlexDeposit installments no longer
 * run on an ACH schedule of their own.
 *
 *   "It needs to ride the next invoice."
 *
 * Installments 2..N are billed as a line on the next invoice the lease
 * generates (jobs/invoiceGeneration) and are collected by whatever pays that
 * bill -- the same path as rent, utilities and propane. Installment 1 rides the
 * move-in invoice.
 *
 * Why it ever pulled on its own: the dates were computed from the ENROLLMENT
 * month, five days ahead of a due date with no relation to the lease or the
 * landlord's billing day. A resident who signed up on the 20th drew a bank pull
 * on the 26th forever, and it debited a month they had already been invoiced
 * for. Heather Miller's plan found it on 10/29 -- an unauthorized $450 debit
 * that had to be cancelled at Stripe before it settled.
 *
 * Kept as a no-op instead of deleted on purpose: a stale scheduler entry, an
 * operator script or an older deploy must not be able to start debiting banks
 * again. It scans nothing and charges nobody.
 */
export async function processFlexDepositInstallmentDue(
  _now: Date = new Date(),
): Promise<InstallmentDueResult> {
  return { candidates_scanned: 0, pulls_initiated: 0, errors: 0 }
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
        // ── 10/28: GAM'S FEE BOOKS WITH THE FIRST INSTALLMENT THAT LANDS ────
        //
        // The whole service fee rides the first pull, so this is the moment the
        // money is actually GAM's. It used to be booked by the move-in settle,
        // at lease finalize, against a payment nobody had made — so a resident
        // who never funded a cent still produced revenue on GAM's book. Now it
        // books here, on real money, with the installment it rode in on.
        //
        // At the figure STAMPED ON THE PLAN, never re-quoted from the schedule:
        // a re-price tomorrow must not restate what this resident was sold
        // today (the trap that silently under-booked FlexPay when its grid
        // moved off the flat $25).
        //
        // In this transaction, on this client: the fee and the installment are
        // one event. recordPlatformRevenue swallows its own write failures by
        // design, so it cannot roll a settled installment back.
        if (inst.installment_number === 1) {
          const feeRow = await client.query<{ fee: string | null; property_id: string | null }>(
            `SELECT sd.flex_deposit_service_fee::text AS fee, u.property_id
               FROM security_deposits sd JOIN units u ON u.id = sd.unit_id
              WHERE sd.id = $1`, [inst.security_deposit_id])
          const fee = Number(feeRow.rows[0]?.fee ?? 0)
          if (fee > 0) {
            const { recordPlatformRevenue } = await import('./platformRevenue')
            await recordPlatformRevenue({
              type:          'flexdeposit_fee',
              amount:        fee,
              referenceId:   inst.security_deposit_id,
              referenceType: 'flexdeposit_plan',
              propertyId:    feeRow.rows[0]?.property_id ?? null,
              notes:         'FlexDeposit service fee — collected with installment 1',
            }, client)
          }
        }
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
  //
  // 11/1 — AN INSTALLMENT ALREADY ASKED FOR IS NOT UNFUNDED.
  //
  // An installment stays 'pending' until its own pull settles, so status alone
  // cannot tell "nobody has asked for this yet" from "it is on a bill the
  // resident has already paid". MH 28 is the case: installment 1 was billed on
  // her move-in invoice and her ACH for it was clearing, yet it still counted
  // here, so her lease page offered to debit the whole $450 — charging that
  // $112.50 a second time. An installment whose payment row is pending,
  // processing or settled has been asked for; only the rest is fundable.
  const balanceRow = await queryOne<{ remaining: string }>(
    `SELECT COALESCE(SUM(i.amount), 0)::text AS remaining
       FROM flex_deposit_installments i
      WHERE i.security_deposit_id = $1
        AND i.status IN ('pending', 'missed')
        AND NOT EXISTS (
          SELECT 1 FROM payments p
           WHERE p.id = i.payment_id
             AND p.status IN ('pending', 'processing', 'settled'))`,
    [dep.id],
  )
  const remaining = Number(balanceRow?.remaining ?? 0)
  if (remaining <= 0) return { ok: false, reason: 'Deposit is already fully funded' }

  // 11/1 — ONE PAY-AHEAD AT A TIME.
  //
  // The route takes an empty body, so a double tap, a retried request or a
  // second tab reached this twice and each pass created its own live ACH debit
  // for the same money. The in-flight row is the lock: while one pull is still
  // out, there is nothing to ask for again.
  const inFlight = await queryOne<{ id: string }>(
    `SELECT id FROM payments
      WHERE flex_deposit_security_deposit_id = $1
        AND notes LIKE 'FlexDeposit voluntary pay-ahead%'
        AND status IN ('pending', 'processing')
      LIMIT 1`,
    [dep.id],
  )
  if (inFlight) return { ok: false, reason: 'A pay-ahead payment is already clearing' }
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
      // 11/1: a lost reply must not pull the bank twice. Keyed on the deposit
      // and the amount asked for, so a retry of the SAME request returns
      // Stripe's existing intent, while a genuinely later pay-ahead for a
      // different remaining balance is its own charge.
      idempotencyKey: `flexdeposit_payahead_${dep.id}_${remaining.toFixed(2)}`,
    })

    // S654: the payment is dated on the property's calendar, not UTC's.
    const today = todayIn(dep.timezone)
    const pay = await queryOne<{ id: string }>(
      `INSERT INTO payments (
         landlord_id, tenant_id, lease_id, unit_id,
         type, amount, status, entry_description,
         due_date, stripe_payment_intent_id, notes,
         flex_deposit_security_deposit_id
       ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', 'DEPOSIT', $6, $7, $8, $9)
       RETURNING id`,
      [
        dep.landlord_id, args.tenantId, dep.lease_id, dep.unit_id,
        remaining.toFixed(2), today, intent.id,
        `FlexDeposit voluntary pay-ahead (deposit ${dep.id})`,
        dep.id,
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
         type, amount, status, due_date, entry_description, revenue_owner, notes,
         flex_deposit_security_deposit_id
       ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', CURRENT_DATE, 'FLEXDEP', 'gam', $6, $7)`,
      [info.unit_id, info.lease_id, info.tenant_id, info.landlord_id, amount.toFixed(2), note,
       args.depositId])
  }

  if (args.route === 'in_full') {
    // The whole difference, once. Its own deposit-type row: custody principal,
    // which comes back at move-out.
    await client.query(
      `INSERT INTO payments (
         unit_id, lease_id, tenant_id, landlord_id,
         type, amount, status, due_date, entry_description, notes,
         flex_deposit_security_deposit_id
       ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', CURRENT_DATE, 'DEPOSIT', $6, $7)`,
      [
        info.unit_id, info.lease_id, info.tenant_id, info.landlord_id,
        quote.topUpAmount.toFixed(2),
        `FlexDeposit top-up, paid in full (deposit ${args.depositId})`,
        args.depositId,
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
    // 10/30 (Nic): no pull dates -- a top-up installment rides an invoice too.
    await client.query(
      `INSERT INTO flex_deposit_installments
         (security_deposit_id, tenant_id, installment_number, installment_count,
          amount, due_date, primary_pull_date, retry_pull_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [
        args.depositId, info.tenant_id, maxNum + i, grandTotal,
        inst.amount.toFixed(2), inst.dueDate, null, null,
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

