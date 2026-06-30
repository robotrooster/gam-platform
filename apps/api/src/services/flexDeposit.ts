import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { isFeatureEnabled } from './systemFeatures'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import { computeTenantGamOutstandingTotal } from './supersedence'
import {
  getFlexDepositMaxInstallments,
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
export const FLEX_DEPOSIT_MIN_TENURE_DAYS = 30
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
    | 'insufficient_platform_tenure'
    | 'insufficient_on_time_payment_history'
  >
  max_installments: number | null
  risk_level:       FlexDepositRiskLevel | null
  deposit_amount:   number | null
}

export async function isFlexDepositVisible(): Promise<boolean> {
  return isFeatureEnabled('flexdeposit_rollout_visible')
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
export async function getFlexDepositEligibility(tenantId: string): Promise<FlexDepositEligibility> {
  const t = await queryOne<{
    ach_verified: boolean
    ssi_ssdi: boolean
    bg_status: string | null
    tenure_days: number
  }>(
    `SELECT ach_verified, ssi_ssdi, background_check_status AS bg_status,
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 AS tenure_days
       FROM tenants WHERE id = $1`,
    [tenantId],
  )
  if (!t) {
    return {
      eligible: false, blockers: ['tenant_not_found'],
      max_installments: null, risk_level: null, deposit_amount: null,
    }
  }

  const blockers: FlexDepositEligibility['blockers'] = []

  // ToS § 9.1.1: FlexDeposit is limited to SSDI/SSI recipients. The flag is
  // set + income-verified at tenant onboarding; this is a service-tier
  // qualification, not a credit decision, and uses no consumer report.
  if (!t.ssi_ssdi) blockers.push('not_ssi_ssdi')

  if (!t.ach_verified) blockers.push('ach_unverified')
  if (t.bg_status !== 'approved') blockers.push(t.bg_status ? 'bg_not_approved' : 'no_bg_result')

  // S330: platform-tenure gate. New-just-signed-up accounts can't
  // immediately get FlexDeposit — standard fraud defense. Per the
  // Privacy Policy § 2.1 promise of "tenancy record" being part of
  // the eligibility-check.
  if (t.tenure_days < FLEX_DEPOSIT_MIN_TENURE_DAYS) {
    blockers.push('insufficient_platform_tenure')
  }

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

  return {
    eligible: blockers.length === 0,
    blockers,
    max_installments: maxInstallments,
    risk_level: riskLevel,
    deposit_amount: depositAmount,
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
}

function computeFlexDepositSchedule(args: {
  depositTotal:      number
  installmentCount:  number
  startDate:         string
  rentDueDay:        number
}): FlexDepositSchedule {
  const total = args.depositTotal
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
  }
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
  if (!Number.isInteger(args.installmentCount) || args.installmentCount < 2 || args.installmentCount > 6) {
    return { ok: false, reason: 'installmentCount must be between 2 and 6' }
  }
  const dep = await fetchUnfundedDeposit(args.tenantId)
  if (!dep) return { ok: false, reason: 'No unfunded deposit on file' }
  const schedule = computeFlexDepositSchedule({
    depositTotal:     Number(dep.total_amount),
    installmentCount: args.installmentCount,
    startDate:        dep.start_date.slice(0, 10),
    rentDueDay:       dep.rent_due_day,
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

  if (!Number.isInteger(args.installmentCount) || args.installmentCount < 2 || args.installmentCount > 6) {
    return { ok: false, reason: 'installmentCount must be between 2 and 6' }
  }
  if (elig.max_installments === null || args.installmentCount > elig.max_installments) {
    return { ok: false, reason: `Max allowed installments for this deposit and risk profile: ${elig.max_installments}` }
  }

  // Fetch the unfunded deposit row + lease start date + rent_due_day.
  // rent_due_day powers the S260 pull schedule (primary at rent_due−5,
  // retry at rent_due−1) for installments 2..N.
  const dep = await fetchUnfundedDeposit(args.tenantId)
  if (!dep) return { ok: false, reason: 'No unfunded deposit on file' }

  const schedule = computeFlexDepositSchedule({
    depositTotal:     Number(dep.total_amount),
    installmentCount: args.installmentCount,
    startDate:        dep.start_date.slice(0, 10),
    rentDueDay:       dep.rent_due_day,
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
              updated_at               = NOW()
        WHERE id = $4`,
      [
        args.installmentCount,
        schedule.installmentAmount.toFixed(2),
        addMonths(schedule.startDate, 1),
        dep.id,
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

  const today = now.toISOString().slice(0, 10)
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
  }>(
    `SELECT i.id AS installment_id, i.security_deposit_id, i.tenant_id,
            i.amount::text, i.attempt_count,
            l.landlord_id, l.id AS lease_id, l.unit_id,
            t.stripe_customer_id,
            CASE WHEN i.attempt_count = 0 THEN 'primary' ELSE 'retry' END AS pull_kind
       FROM flex_deposit_installments i
       JOIN security_deposits sd ON sd.id = i.security_deposit_id
       JOIN leases l ON l.id = sd.lease_id
       JOIN tenants t ON t.id = i.tenant_id
      WHERE i.status = 'pending'
        AND i.installment_number > 1
        AND sd.flex_deposit_plan_status = 'active'
        AND (
          (i.attempt_count = 0 AND i.primary_pull_date IS NOT NULL AND i.primary_pull_date <= $1)
          OR
          (i.attempt_count = 1 AND i.retry_pull_date   IS NOT NULL AND i.retry_pull_date   <= $1)
        )`,
    [today],
  )
  out.candidates_scanned = rows.length

  const stripe = getStripe()
  for (const r of rows) {
    try {
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
      const amount = Math.round((baseAmount + boost) * 100) / 100
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
          `FlexDeposit installment ${r.pull_kind} pull (deposit ${r.security_deposit_id})`,
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
  const cycle = firstOfMonth(now)
  const out: CustodyChargeResult = {
    cycle_month: cycle, candidates_scanned: 0, charges_created: 0,
    charges_skipped_existing: 0, errors: 0,
  }
  if (!await isFlexDepositVisible()) return out

  const rows = await query<{
    tenant_id:          string
    stripe_customer_id: string | null
    landlord_id:        string
    lease_id:           string
    unit_id:            string
  }>(
    `SELECT DISTINCT t.id AS tenant_id, t.stripe_customer_id,
            l.landlord_id, l.id AS lease_id, l.unit_id
       FROM tenants t
       JOIN security_deposits sd ON sd.tenant_id = t.id
       JOIN leases l            ON l.id = sd.lease_id
      WHERE sd.flex_deposit_enabled = TRUE
        AND sd.flex_deposit_plan_status IN ('active', 'completed')
        AND sd.custody_fee_active = TRUE
        AND l.status IN ('active', 'pending')`,
  )
  out.candidates_scanned = rows.length

  const stripe = getStripe()
  for (const r of rows) {
    try {
      const insert = await queryOne<{ id: string }>(
        `INSERT INTO flex_deposit_custody_charges
           (tenant_id, cycle_month, amount, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (cycle_month, tenant_id) DO NOTHING
         RETURNING id`,
        [r.tenant_id, cycle, FLEX_DEPOSIT_CUSTODY_FEE],
      )
      if (!insert) {
        out.charges_skipped_existing += 1
        continue
      }
      if (!r.stripe_customer_id) {
        out.errors += 1
        continue
      }

      let paymentMethodId: string | null = null
      try {
        const cust = await stripe.customers.retrieve(r.stripe_customer_id)
        if (cust && !(cust as any).deleted) {
          const c = cust as any
          paymentMethodId = c.invoice_settings?.default_payment_method ?? c.default_source ?? null
        }
      } catch {}
      if (!paymentMethodId) { out.errors += 1; continue }

      // S261: supersedence boost on custody pull. The just-inserted
      // custody row is status='pending', so it's not in the FIFO list.
      const boost = await computeTenantGamOutstandingTotal(r.tenant_id)
      const pullAmount = Math.round((FLEX_DEPOSIT_CUSTODY_FEE + boost) * 100) / 100

      const intent = await createRentPlatformCharge({
        amount:              pullAmount,
        stripeCustomerId:    r.stripe_customer_id,
        paymentMethodId,
        paymentMethodTypes:  ['us_bank_account'],
        entryDescription:    'SUBSCRIP',
        metadata: {
          gam_purpose:    'flexdeposit_custody_fee',
          gam_charge_id:  insert.id,
          gam_tenant_id:  r.tenant_id,
          gam_cycle:      cycle,
        },
      })

      const pay = await queryOne<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description,
           due_date, stripe_payment_intent_id, notes,
           gam_supersedence_amount
         ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'SUBSCRIP',
                   $6, $7, $8, $9)
         RETURNING id`,
        [
          r.landlord_id, r.tenant_id, r.lease_id, r.unit_id,
          pullAmount.toFixed(2), cycle, intent.id,
          `FlexDeposit custody fee ${cycle}`,
          boost.toFixed(2),
        ],
      )
      await query(
        `UPDATE flex_deposit_custody_charges
            SET payment_id = $1, updated_at = NOW()
          WHERE id = $2`,
        [pay!.id, insert.id],
      )
      out.charges_created += 1
    } catch (e: any) {
      logger.error({ err: e, ctx: r.tenant_id }, '[flexdeposit][custody]')
      out.errors += 1
    }
  }
  return out
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
    stripe_customer_id: string | null;
  }>(
    `SELECT sd.id, sd.lease_id, l.landlord_id, sd.unit_id,
            t.stripe_customer_id
       FROM security_deposits sd
       JOIN leases   l ON l.id = sd.lease_id
       JOIN tenants  t ON t.id = sd.tenant_id
      WHERE sd.tenant_id = $1
        AND sd.flex_deposit_enabled = TRUE
        AND sd.flex_deposit_plan_status = 'active'
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

    const today = new Date().toISOString().slice(0, 10)
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

// ── Cross-property top-up (S516) ─────────────────────────────────

/**
 * S516: generate top-up installments for a carried-forward FlexDeposit whose
 * new property requires a LARGER deposit. The difference is spread into
 * monthly installments (tiered on the top-up amount) that the existing
 * installment cron collects — "option 1": the custody fee keeps running. The
 * tenant may instead fund the whole remainder at once via payAheadFlexDeposit
 * — "option 2": the custody fee stops. The option is expressed by tenant
 * behavior; no upfront choice is required.
 *
 * Must run inside the caller's transaction (the forward execute). New rows are
 * numbered AFTER the deposit's existing (now-settled) installments so the
 * unique (deposit, number) constraint holds; each carries installment_count =
 * the new grand total.
 */
export async function scheduleFlexDepositTopUp(
  client: PoolClient,
  args: { depositId: string; topUpAmount: number },
): Promise<{ count: number }> {
  if (args.topUpAmount <= 0) return { count: 0 }

  const info = await client.query<{
    tenant_id: string; rent_due_day: number;
    risk_level: FlexDepositRiskLevel | null; max_num: number;
  }>(
    `SELECT sd.tenant_id, l.rent_due_day, bc.risk_level,
            COALESCE((SELECT MAX(installment_number)
                        FROM flex_deposit_installments
                       WHERE security_deposit_id = sd.id), 0) AS max_num
       FROM security_deposits sd
       JOIN leases l ON l.id = sd.lease_id
       LEFT JOIN tenants t ON t.id = sd.tenant_id
       LEFT JOIN background_checks bc ON bc.id = t.background_check_id
      WHERE sd.id = $1`,
    [args.depositId],
  ).then(r => r.rows[0])
  if (!info) return { count: 0 }

  const count = getFlexDepositMaxInstallments(args.topUpAmount, info.risk_level) ?? 2
  // Anchor to next month so the first top-up pull is upcoming, not overdue.
  const startDate = addMonths(firstOfMonth(new Date()), 1)
  const schedule = computeFlexDepositSchedule({
    depositTotal:     args.topUpAmount,
    installmentCount: count,
    startDate,
    rentDueDay:       info.rent_due_day,
  })
  const maxNum = Number(info.max_num)
  const grandTotal = maxNum + count

  for (let i = 1; i <= count; i++) {
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
      ],
    )
  }

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
      count, schedule.installments[0].dueDate,
    ],
  )
  return { count }
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

function firstOfMonth(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10)
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
