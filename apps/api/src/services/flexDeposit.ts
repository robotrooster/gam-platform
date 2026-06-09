import { query, queryOne, getClient } from '../db'
import { isFeatureEnabled } from './systemFeatures'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import { computeTenantGamOutstandingTotal } from './supersedence'
import {
  getFlexDepositMaxInstallments,
  FLEX_DEPOSIT_CUSTODY_FEE,
  FLEX_DEPOSIT_NSF_COOLDOWN_DAYS,
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
// FlexDeposit — tenant-paid deposit-installment product (S246).
//
// Tenant picks 2-4 installments based on deposit amount × Checkr BG
// risk_level. Installment 1 paid at move-in alongside rent + utilities
// in a single combined ACH pull. GAM fronts the remaining (N-1) ×
// installment_amount to landlord at move-in via Connect Transfer so
// landlord sees the deposit funded in full from day 1. Tenant pays
// installments 2..N to GAM over the next N-1 months. $3/mo custody
// fee billed continuously while tenant is on the GAM platform.
//
// Landlord NEVER sees FlexDeposit. Their move-in invoice excludes
// the deposit line (covered by the GAM front); custody fees and
// installment receipts are tenant↔GAM ledger entries only.
//
// Risk model: GAM eats the loss on default. Same posture as OTP /
// FlexPay. Larger deposits get fewer allowed installments to cap
// outstanding exposure (per S246 product spec).
//
// Missed-installment legal remedy: TODO. S246 placeholder is
// standard late_fee + admin alert + plan status='in_default'.
// Stricter remedy (deposit-due-in-full, eviction-eligible, etc.)
// pending Nic's legal review — surfaced as admin alert with the
// hook at handleInstallmentNsf.
// ============================================================

// S330: signal thresholds for the eligibility-check workflow promised
// in Consumer Privacy Policy § 2.1. All rule-based — no scoring or
// underwriting (preserves the SLA-not-loan structural defense).
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
    | 'tenant_suspended_nsf'
    | 'already_funded'
    | 'tenant_not_found'
    | 'insufficient_platform_tenure'
    | 'insufficient_on_time_payment_history'
    | 'prior_flexdeposit_default'
  >
  max_installments: number | null
  risk_level:       FlexDepositRiskLevel | null
  deposit_amount:   number | null
  suspended_until:  string | null
}

export async function isFlexDepositVisible(): Promise<boolean> {
  return isFeatureEnabled('flexdeposit_rollout_visible')
}

/**
 * Compute the tenant's FlexDeposit eligibility based on:
 *  - ach_verified
 *  - background_checks.status = 'approved' AND risk_level set
 *  - security_deposits exists for an upcoming/active lease
 *  - not in NSF cooldown
 * Returns max_installments (2-4) when eligible, null otherwise.
 */
export async function getFlexDepositEligibility(tenantId: string): Promise<FlexDepositEligibility> {
  const t = await queryOne<{
    ach_verified: boolean
    bg_status: string | null
    flex_deposit_disqualified_until: string | null
    tenure_days: number
  }>(
    `SELECT ach_verified, background_check_status AS bg_status,
            flex_deposit_disqualified_until,
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 AS tenure_days
       FROM tenants WHERE id = $1`,
    [tenantId],
  )
  if (!t) {
    return {
      eligible: false, blockers: ['tenant_not_found'],
      max_installments: null, risk_level: null, deposit_amount: null, suspended_until: null,
    }
  }

  const blockers: FlexDepositEligibility['blockers'] = []
  let suspendedUntil: string | null = null

  if (!t.ach_verified) blockers.push('ach_unverified')
  if (t.bg_status !== 'approved') blockers.push(t.bg_status ? 'bg_not_approved' : 'no_bg_result')
  if (t.flex_deposit_disqualified_until) {
    const until = new Date(t.flex_deposit_disqualified_until)
    if (until.getTime() > Date.now()) {
      blockers.push('tenant_suspended_nsf')
      suspendedUntil = t.flex_deposit_disqualified_until
    }
  }

  // S330: platform-tenure gate. New-just-signed-up accounts can't
  // immediately get FlexDeposit — standard fraud defense. Per the
  // Privacy Policy § 2.1 promise of "tenancy record" being part of
  // the eligibility-check.
  if (t.tenure_days < FLEX_DEPOSIT_MIN_TENURE_DAYS) {
    blockers.push('insufficient_platform_tenure')
  }

  // S330: prior-default permanent block. Distinct from
  // tenant_suspended_nsf (which is a temporary cooldown). Any prior
  // FlexDeposit plan that landed in_default permanently disqualifies
  // — re-enrollment after a default would undermine the SLA-not-loan
  // service-tier consequences framing.
  const priorDefault = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM security_deposits
        WHERE tenant_id = $1
          AND flex_deposit_plan_status = 'in_default'
     ) AS exists`,
    [tenantId],
  )
  if (priorDefault?.exists) blockers.push('prior_flexdeposit_default')

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
    suspended_until: suspendedUntil,
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
  gamAdvanceAmount:       number
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
  const gamAdvanceAmount = roundHalfEvenCents(total - firstAmount)

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
    installments, installmentAmount, firstAmount, gamAdvanceAmount,
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
  if (!Number.isInteger(args.installmentCount) || args.installmentCount < 2 || args.installmentCount > 4) {
    return { ok: false, reason: 'installmentCount must be 2, 3, or 4' }
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

  if (!Number.isInteger(args.installmentCount) || args.installmentCount < 2 || args.installmentCount > 4) {
    return { ok: false, reason: 'installmentCount must be 2, 3, or 4' }
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
    gamAdvanceAmount:       schedule.gamAdvanceAmount,
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

    // Flip the deposit row's FlexDeposit columns. S260: force
    // held_by='gam_escrow' regardless of property default — GAM holds
    // FlexDeposit funds throughout the lease (no move-in Connect
    // Transfer; settle to landlord at lease-end with whatever was
    // collected, GAM eats any gap).
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
              gam_advance_amount       = $4,
              updated_at               = NOW()
        WHERE id = $5`,
      [
        args.installmentCount,
        schedule.installmentAmount.toFixed(2),
        addMonths(schedule.startDate, 1),
        schedule.gamAdvanceAmount.toFixed(2),
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
        deposit_id:         dep.id,
        installment_count:  args.installmentCount,
        installment_amount: schedule.installmentAmount,
        first_amount:       schedule.firstAmount,
        gam_advance:        schedule.gamAdvanceAmount,
        first_due:          schedule.startDate,
        next_due:           addMonths(schedule.startDate, 1),
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
              gam_advance_amount         = 0,
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
 * S260 model change: NO landlord Connect Transfer at move-in. All
 * FlexDeposit deposits are held in gam_escrow throughout the lease
 * (forced at enrollment time). GAM holds the partial-collected funds,
 * marks the deposit 'funded' on the landlord-visible dashboard once
 * the total is collected, and settles to landlord at lease-end with
 * whatever's collected (GAM eats any gap then).
 *
 * Pre-S260 behavior: when `held_by='landlord'`, fired a Connect Transfer
 * for the (N-1)-installment gap to the landlord's Connect account so
 * the landlord saw deposit funded in full from day 1. Under S260 that
 * gap stays with GAM until lease-end; no transfer fires.
 *
 * Signature preserved (still accepts landlordConnectAccountId) for
 * backward call-site compat. Returns null stripeTransferId always.
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
 * S260 model: each installment has TWO pull attempts:
 *   - primary at rent_due_day − 5 (fires when attempt_count = 0)
 *   - retry   at rent_due_day − 1 (fires when attempt_count = 1
 *                                  AND primary failed; if primary
 *                                  succeeded, status flipped to
 *                                  'settled' and retry is skipped)
 *
 * On retry failure (attempt_count would become 2 after second pull
 * fires), the webhook NSF handler defaults the installment and
 * checks for 2 consecutive defaulted installments → fires plan
 * acceleration. See handleFlexDepositPaymentNsf.
 *
 * One PaymentIntent per pull (platform charge, gross to GAM platform
 * balance — landlord deposit lives entirely in gam_escrow under S260,
 * no Connect Transfer happens until lease-end settlement).
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
        await markInstallmentDefaulted(r.installment_id, r.security_deposit_id, r.tenant_id, 'no_stripe_customer')
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
        await markInstallmentDefaulted(r.installment_id, r.security_deposit_id, r.tenant_id, 'no_default_payment_method')
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

async function markInstallmentDefaulted(
  installmentId: string,
  depositId: string,
  tenantId: string,
  reason: string,
) {
  await query(
    `UPDATE flex_deposit_installments
        SET status = 'defaulted', defaulted_at = NOW(),
            default_reason = $1, updated_at = NOW()
      WHERE id = $2`,
    [reason, installmentId],
  )
  await query(
    `UPDATE security_deposits
        SET flex_deposit_plan_status = 'in_default', updated_at = NOW()
      WHERE id = $1`,
    [depositId],
  )
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'flexdeposit_installment_defaulted',
      title:    `FlexDeposit installment defaulted`,
      body:     `Installment ${installmentId} for tenant ${tenantId} flipped to defaulted: ${reason}. Plan flagged for legal-remedy review. TODO: legal remedy implementation pending Nic spec.`,
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

  // S260: acceleration-pull settlement. Routed by PI metadata stamp,
  // not installment-row presence (no installment row exists for an
  // acceleration pull — it's a single full-balance charge against
  // remaining unpaid installments). Flips plan → 'completed' and
  // mass-settles all unpaid installments.
  if (piMetadata?.gam_purpose === 'flexdeposit_acceleration' && piMetadata.gam_deposit_id) {
    await settleFlexDepositAcceleration(piMetadata.gam_deposit_id)
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
 * NSF handler (S260 rewrite).
 *
 * The S260 pull-schedule model has each installment fire TWO attempts:
 *   - primary (attempt_count goes 0→1)
 *   - retry   (attempt_count goes 1→2)
 *
 * Webhook payment_intent.payment_failed routes through here for any
 * payment with metadata.gam_purpose='flexdeposit_installment'.
 *
 * Behavior:
 *   - Primary attempt failed (installment.attempt_count = 1):
 *     installment stays 'pending'; the daily cron picks up the retry
 *     on retry_pull_date. No plan-level state change.
 *   - Retry attempt failed (installment.attempt_count = 2):
 *     installment flips to 'defaulted'. Then we count consecutive
 *     defaulted installments ending with this one. On 2 consecutive
 *     defaulted installments → fire plan acceleration.
 *
 * The S260 model does NOT use achRetry for FlexDeposit — retry timing
 * is locked to retry_pull_date. The webhook layer must NULL out
 * next_retry_at for FlexDeposit installment failures so achRetry
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

  // Primary attempt failed (count=1 after pull fired). Don't default
  // yet — retry will fire on retry_pull_date.
  if (inst.attempt_count <= 1) {
    return
  }

  // Retry attempt failed (count=2). Default this installment, then
  // check for 2-strike acceleration.
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_deposit_installments
          SET status         = 'defaulted',
              defaulted_at   = NOW(),
              default_reason = 'tenant_nsf_both_attempts_failed',
              updated_at     = NOW()
        WHERE id = $1`,
      [inst.id],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // Strike check: 2 consecutive defaulted installments ending at the
  // most recent → acceleration. "Consecutive" walks back from the
  // highest installment_number with a settled-or-defaulted outcome,
  // not skipping pending installments (which wouldn't exist between
  // a defaulted one and another later one anyway under the
  // chronological monthly schedule).
  const consecutive = await queryOne<{ count: number }>(
    `WITH recent AS (
       SELECT status, installment_number
         FROM flex_deposit_installments
        WHERE security_deposit_id = $1
          AND status IN ('settled', 'defaulted')
        ORDER BY installment_number DESC
        LIMIT 2
     )
     SELECT COUNT(*)::int AS count
       FROM recent
      WHERE status = 'defaulted'`,
    [inst.security_deposit_id],
  )
  const consecCount = consecutive?.count ?? 0

  if (consecCount >= 2) {
    await accelerateFlexDepositPlan({
      depositId: inst.security_deposit_id,
      tenantId:  p.tenant_id,
      reason:    'second_consecutive_installment_default',
    })
    return
  }

  // Single-strike state: don't accelerate yet. Log for visibility.
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'info',
      category: 'flexdeposit_installment_defaulted',
      title:    `FlexDeposit installment defaulted (strike 1 of 2) — tenant ${p.tenant_id}`,
      body:     `Installment ${inst.id} (deposit ${inst.security_deposit_id}) defaulted after both primary and retry pulls failed. One more consecutive default triggers plan acceleration.`,
      context:  { installment_id: inst.id, deposit_id: inst.security_deposit_id, tenant_id: p.tenant_id, installment_number: inst.installment_number },
    })
  } catch (e) { logger.error({ err: e }, '[flexdeposit][nsf-alert]') }
}

/**
 * S260: plan acceleration. Triggered by 2 consecutive defaulted
 * installments OR via the webhook handler for the accelerated pull
 * itself when it fails.
 *
 * Steps:
 *   1. Compute remaining balance = sum of (pending + defaulted)
 *      installment amounts.
 *   2. Stamp security_deposits.balance_due_full_at + balance_due_total;
 *      flip flex_deposit_plan_status to 'accelerated'.
 *   3. Fire a single ACH pull at the full remaining balance. Metadata
 *      stamps this as a flexdeposit_acceleration_pull (separate from
 *      installment pulls).
 *   4. On webhook success: plan flips to 'completed', all unpaid
 *      installments flip to 'settled' (paid by acceleration).
 *   5. On webhook failure: plan flips to 'in_default' terminal. GAM
 *      eats the unpaid portion at lease-end settlement; tenant gets
 *      a 60-day cooldown on FlexDeposit re-enrollment.
 */
export async function accelerateFlexDepositPlan(args: {
  depositId: string
  tenantId:  string
  reason:    string
}): Promise<{ accelerated: boolean; balance_due: number; payment_id: string | null }> {
  const dep = await queryOne<{
    id: string; lease_id: string; landlord_id: string; unit_id: string;
    stripe_customer_id: string | null;
  }>(
    `SELECT sd.id, sd.lease_id, l.landlord_id, sd.unit_id,
            t.stripe_customer_id
       FROM security_deposits sd
       JOIN leases   l ON l.id = sd.lease_id
       JOIN tenants  t ON t.id = sd.tenant_id
      WHERE sd.id = $1`,
    [args.depositId],
  )
  if (!dep) {
    return { accelerated: false, balance_due: 0, payment_id: null }
  }

  // Sum unpaid (pending + defaulted) installment amounts.
  const balanceRow = await queryOne<{ remaining: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS remaining
       FROM flex_deposit_installments
      WHERE security_deposit_id = $1
        AND status IN ('pending', 'defaulted')`,
    [args.depositId],
  )
  const remaining = Number(balanceRow?.remaining ?? 0)
  if (remaining <= 0) {
    return { accelerated: false, balance_due: 0, payment_id: null }
  }

  // Stamp acceleration onto the deposit.
  await query(
    `UPDATE security_deposits
        SET flex_deposit_plan_status = 'accelerated',
            balance_due_full_at      = NOW(),
            balance_due_total        = $1,
            updated_at               = NOW()
      WHERE id = $2`,
    [remaining.toFixed(2), args.depositId],
  )

  // Notify admin (the only operator-visible signal — landlord never
  // sees FlexDeposit state per F4).
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'flexdeposit_plan_accelerated',
      title:    `FlexDeposit plan accelerated — tenant ${args.tenantId}`,
      body:     `2 consecutive installment defaults triggered acceleration on deposit ${args.depositId}. Full remaining balance of $${remaining.toFixed(2)} pulled in a single ACH attempt. Reason: ${args.reason}.`,
      context:  { deposit_id: args.depositId, tenant_id: args.tenantId, balance_due_total: remaining, reason: args.reason },
    })
  } catch (e) { logger.error({ err: e }, '[flexdeposit][accelerate-alert]') }

  // Fire the single full-balance ACH pull.
  let paymentId: string | null = null
  try {
    if (!dep.stripe_customer_id) {
      await markPlanInDefault(args.depositId, args.tenantId, 'no_stripe_customer')
      return { accelerated: true, balance_due: remaining, payment_id: null }
    }

    const stripe = getStripe()
    let paymentMethodId: string | null = null
    try {
      const cust = await stripe.customers.retrieve(dep.stripe_customer_id)
      if (cust && !(cust as any).deleted) {
        const c = cust as any
        paymentMethodId = c.invoice_settings?.default_payment_method ?? c.default_source ?? null
      }
    } catch {}
    if (!paymentMethodId) {
      await markPlanInDefault(args.depositId, args.tenantId, 'no_default_payment_method')
      return { accelerated: true, balance_due: remaining, payment_id: null }
    }

    // S261: supersedence boost on the acceleration pull. The
    // accelerated balance for THIS deposit is excluded from the
    // outstanding query for the duration of this transaction by the
    // computeTenantGamOutstanding filter (it scans plan_status
    // ='accelerated' only after balance_due_total is stamped — at this
    // point in accelerateFlexDepositPlan the stamp has already
    // happened, so we must subtract our own deposit row). Cheaper:
    // compute total, subtract `remaining` for this deposit.
    const rawBoost = await computeTenantGamOutstandingTotal(args.tenantId)
    const boost = Math.max(0, Math.round((rawBoost - remaining) * 100) / 100)
    const pullAmount = Math.round((remaining + boost) * 100) / 100

    const intent = await createRentPlatformCharge({
      amount:              pullAmount,
      stripeCustomerId:    dep.stripe_customer_id,
      paymentMethodId,
      paymentMethodTypes:  ['us_bank_account'],
      entryDescription:    'DEPOSIT',
      metadata: {
        gam_purpose:    'flexdeposit_acceleration',
        gam_deposit_id: args.depositId,
        gam_tenant_id:  args.tenantId,
      },
    })

    const today = new Date().toISOString().slice(0, 10)
    const pay = await queryOne<{ id: string }>(
      `INSERT INTO payments (
         landlord_id, tenant_id, lease_id, unit_id,
         type, amount, status, entry_description,
         due_date, stripe_payment_intent_id, notes,
         gam_supersedence_amount
       ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', 'DEPOSIT', $6, $7, $8, $9)
       RETURNING id`,
      [
        dep.landlord_id, args.tenantId, dep.lease_id, dep.unit_id,
        pullAmount.toFixed(2), today, intent.id,
        `FlexDeposit acceleration — full balance due (deposit ${args.depositId})`,
        boost.toFixed(2),
      ],
    )
    paymentId = pay?.id ?? null
  } catch (e) {
    logger.error({ err: e, ctx: args.depositId }, '[flexdeposit][accelerate-pull]')
    await markPlanInDefault(args.depositId, args.tenantId, 'acceleration_pull_create_failed')
  }

  return { accelerated: true, balance_due: remaining, payment_id: paymentId }
}

/**
 * S262: tenant-initiated manual retry of an acceleration pull. Reaches
 * here only from the tenant LeasePage "Pay full balance now" button
 * when their plan is 'in_default' (the prior acceleration pull failed).
 *
 * Flips plan_status back to 'accelerated', re-stamps balance_due_full_at,
 * and fires a fresh ACH pull at balance_due_total + supersedence boost.
 * Webhook routes settlement back through settleFlexDepositAcceleration
 * (success) or failFlexDepositAcceleration (back to 'in_default').
 *
 * The supersedence FIFO logic naturally excludes this deposit by the
 * existing self-subtract pattern (rawBoost - balance_due_total).
 */
export async function retryFlexDepositAcceleration(args: {
  tenantId: string
}): Promise<{ ok: boolean; reason?: string; balance_due?: number; payment_id?: string | null }> {
  const dep = await queryOne<{
    id: string; lease_id: string; landlord_id: string; unit_id: string;
    balance_due_total: string | null;
    stripe_customer_id: string | null;
  }>(
    `SELECT sd.id, sd.lease_id, l.landlord_id, sd.unit_id,
            sd.balance_due_total::text AS balance_due_total,
            t.stripe_customer_id
       FROM security_deposits sd
       JOIN leases   l ON l.id = sd.lease_id
       JOIN tenants  t ON t.id = sd.tenant_id
      WHERE sd.tenant_id = $1
        AND sd.flex_deposit_plan_status = 'in_default'
      LIMIT 1`,
    [args.tenantId],
  )
  if (!dep) return { ok: false, reason: 'No in_default FlexDeposit plan found for tenant' }

  const remaining = Number(dep.balance_due_total ?? 0)
  if (remaining <= 0) return { ok: false, reason: 'No outstanding balance on this plan' }
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

  // Flip plan back to 'accelerated' and re-stamp the deadline.
  await query(
    `UPDATE security_deposits
        SET flex_deposit_plan_status = 'accelerated',
            balance_due_full_at      = NOW(),
            updated_at               = NOW()
      WHERE id = $1
        AND flex_deposit_plan_status = 'in_default'`,
    [dep.id],
  )

  // Supersedence boost — same self-subtract pattern as
  // accelerateFlexDepositPlan. With plan_status now 'accelerated',
  // the FIFO query would include this deposit's balance_due_total;
  // subtract it to avoid double-counting.
  const rawBoost = await computeTenantGamOutstandingTotal(args.tenantId)
  const boost = Math.max(0, Math.round((rawBoost - remaining) * 100) / 100)
  const pullAmount = Math.round((remaining + boost) * 100) / 100

  let paymentId: string | null = null
  try {
    const intent = await createRentPlatformCharge({
      amount:              pullAmount,
      stripeCustomerId:    dep.stripe_customer_id,
      paymentMethodId,
      paymentMethodTypes:  ['us_bank_account'],
      entryDescription:    'DEPOSIT',
      metadata: {
        gam_purpose:    'flexdeposit_acceleration',
        gam_deposit_id: dep.id,
        gam_tenant_id:  args.tenantId,
        gam_retry:      'true',
      },
    })

    const today = new Date().toISOString().slice(0, 10)
    const pay = await queryOne<{ id: string }>(
      `INSERT INTO payments (
         landlord_id, tenant_id, lease_id, unit_id,
         type, amount, status, entry_description,
         due_date, stripe_payment_intent_id, notes,
         gam_supersedence_amount
       ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', 'DEPOSIT', $6, $7, $8, $9)
       RETURNING id`,
      [
        dep.landlord_id, args.tenantId, dep.lease_id, dep.unit_id,
        pullAmount.toFixed(2), today, intent.id,
        `FlexDeposit acceleration manual retry (deposit ${dep.id})`,
        boost.toFixed(2),
      ],
    )
    paymentId = pay?.id ?? null
  } catch (e) {
    logger.error({ err: e, ctx: dep.id }, '[flexdeposit][retry-acceleration]')
    await markPlanInDefault(dep.id, args.tenantId, 'retry_acceleration_pull_create_failed')
    return { ok: false, reason: 'Pull creation failed; plan returned to in_default' }
  }

  return { ok: true, balance_due: remaining, payment_id: paymentId }
}

/**
 * S260: acceleration-pull success handler. Called when the
 * accelerated full-balance ACH pull settles. Flips plan to 'completed'
 * and mass-settles all remaining unpaid (pending + defaulted)
 * installments — they're considered paid by the acceleration charge.
 */
async function settleFlexDepositAcceleration(depositId: string): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flex_deposit_installments
          SET status = 'settled', settled_at = NOW(), updated_at = NOW()
        WHERE security_deposit_id = $1
          AND status IN ('pending', 'defaulted')`,
      [depositId],
    )
    await client.query(
      `UPDATE security_deposits
          SET flex_deposit_plan_status = 'completed',
              installments_remaining   = 0,
              installments_paid        = installment_count,
              collected_amount         = total_amount,
              status                   = 'funded',
              next_installment_date    = NULL,
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

/**
 * S260: acceleration-pull failure handler. Called by the webhook
 * when the acceleration full-balance ACH pull fails. Terminal state:
 * plan flips to 'in_default'; tenant disqualified for the NSF
 * cooldown. GAM eats the unpaid portion at lease-end settlement.
 */
export async function failFlexDepositAcceleration(
  depositId: string,
  tenantId: string | null,
  reason: string,
): Promise<void> {
  let resolvedTenantId = tenantId
  if (!resolvedTenantId) {
    const row = await queryOne<{ tenant_id: string }>(
      'SELECT tenant_id FROM security_deposits WHERE id = $1',
      [depositId],
    )
    if (!row) return
    resolvedTenantId = row.tenant_id
  }
  await markPlanInDefault(depositId, resolvedTenantId, `acceleration_pull_failed:${reason.slice(0, 80)}`)
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'flexdeposit_acceleration_failed',
      title:    `FlexDeposit acceleration pull failed (terminal) — tenant ${resolvedTenantId}`,
      body:     `Acceleration ACH pull for deposit ${depositId} failed. Plan in_default; tenant cooldown engaged. GAM eats the unpaid portion at lease-end settlement. Reason: ${reason}.`,
      context:  { deposit_id: depositId, tenant_id: resolvedTenantId, reason },
    })
  } catch (e) { logger.error({ err: e }, '[flexdeposit][accelerate-fail-alert]') }
}

async function markPlanInDefault(
  depositId: string,
  tenantId: string,
  reason: string,
): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE security_deposits
          SET flex_deposit_plan_status = 'in_default', updated_at = NOW()
        WHERE id = $1`,
      [depositId],
    )
    await client.query(
      `UPDATE tenants
          SET flex_deposit_disqualified_until  = NOW() + INTERVAL '${FLEX_DEPOSIT_NSF_COOLDOWN_DAYS} days',
              flex_deposit_disqualified_reason = $2
        WHERE id = $1`,
      [tenantId, reason],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
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
