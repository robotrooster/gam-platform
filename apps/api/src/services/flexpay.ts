import { query, queryOne, getClient } from '../db'
import { isFeatureEnabled } from './systemFeatures'
import { getStripe } from '../lib/stripe'
import { createRentPlatformCharge } from './stripeConnect'
import { computeTenantGamOutstandingTotal } from './supersedence'
import {
  FLEXPAY_TEMPLATE_VERSION,
  renderFlexPayAcceptanceText,
  recordAcceptance,
  fireFlexsuiteAcceptanceEmail,
} from './flexsuiteAcceptance'
import { logger } from '../lib/logger'

// ============================================================
// FlexPay — tenant-paid payment-scheduling product.
//
// The tenant picks a rent pull day (1-28) and pays a $5 + day fee
// each cycle ($6 to $33). In exchange, GAM fronts the rent to the
// landlord on the lease's grace-period-end day so the landlord
// receives funds without waiting on the tenant's chosen pull day.
//
// FlexPay is a PAYMENT-SCHEDULING SERVICE. Not a loan. Not credit
// insurance. Not a credit advance. Identifiers and copy in this
// file reflect that framing — see "front" not "loan/advance" in
// tenant-facing UI strings; "advance" is acceptable internally as
// it matches the otp_advances schema vocabulary.
//
// Day-28 cap covers all U.S. social security payout windows
// (SSDI / SS retirement latest is the 4th Wednesday of the month,
// which can fall as late as the 28th).
//
// ── Money-flow per cycle ──────────────────────────────────────
//   Day grace_end (lease.late_fee_grace_days, default 5):
//     GAM fronts rent to landlord via Stripe Connect Transfer.
//     SUPPRESSED when OTP already advanced this cycle — landlord
//     can't be double-paid for the same rent.
//   Day tenant.pull_day:
//     GAM initiates a single ACH pull from tenant for rent+fee
//     total. Gross goes to platform balance (GAM already covered
//     the landlord). Reimbursement of the advance + the fee
//     revenue.
//   Reconciliation:
//     payment_intent.succeeded → flexpay_advances → 'reconciled'.
//     payment_intent.payment_failed → first failure triggers a
//     NACHA retry via the standard achRetry path; second failure
//     → 'defaulted' + 90-day tenant suspension (Consumer ToS lockout).
//     UI copy at the enroll modal states this.
//
// ── OTP coexistence ───────────────────────────────────────────
// Both flags can be on for the same tenant simultaneously. OTP is
// landlord-paid; FlexPay is tenant-paid. They are independent fee
// streams. The only dedup is on the landlord-front: OTP fires EOM
// (earlier), so when both are on, OTP wins the front and FlexPay's
// grace-period-end leg is suppressed. The tenant fee still bills
// regardless — the tenant signed up for scheduling, not for OTP
// awareness.
// ============================================================

export const FLEXPAY_FEE_BASE = 5            // dollars
export const FLEXPAY_MAX_PULL_DAY = 28       // SSDI 4th-Wednesday cap
export const FLEXPAY_NSF_COOLDOWN_DAYS = 90  // matches Consumer ToS § (re-enroll lockout after a FlexPay failure)
// Stripe ACH-return fee passed through to the tenant at cost on a retry pull
// (Consumer ToS § 4.2 / 9.2). Constant approximates Stripe's published ACH
// failure fee; reconcile to the live fee schedule once Stripe keys are live.
export const FLEXPAY_ACH_RETURN_FEE = 4
export const FLEXPAY_DEFAULT_GRACE_DAYS = 5  // when lease.late_fee_grace_days is NULL

/**
 * Fee for a given pull day. $5 base + day-of-month. day 1 = $6, day
 * 28 = $33. The formula is linear and the cap is 28 so the result is
 * always 6 ≤ fee ≤ 33.
 */
export function calculateFlexPayFee(pullDay: number): number {
  if (!Number.isInteger(pullDay) || pullDay < 1 || pullDay > FLEXPAY_MAX_PULL_DAY) {
    throw new Error(`pullDay must be an integer 1..${FLEXPAY_MAX_PULL_DAY}`)
  }
  return FLEXPAY_FEE_BASE + pullDay
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

// ── Eligibility ─────────────────────────────────────────────────

export interface FlexPayEligibility {
  eligible: boolean
  blockers: Array<
    | 'ach_unverified'
    | 'tenant_suspended_nsf'
    | 'no_active_lease'
    | 'tenant_not_found'
    | 'flex_deposit_active'
    | 'not_ssi_ssdi'
  >
  suspended_until: string | null
}

/**
 * Eligibility check for enrolling a tenant in FlexPay. Per the S512
 * product spec: SSDI/SSI recipients only, ACH verified, active lease,
 * not in the post-failure re-enroll cooldown, and — when the tenant is
 * funding their deposit via FlexDeposit — that plan must be FUNDED first.
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
    ssi_ssdi: boolean
    flexpay_disqualified_until: string | null
  }>(
    `SELECT ach_verified, ssi_ssdi, flexpay_disqualified_until
       FROM tenants
      WHERE id = $1`,
    [tenantId],
  )
  if (!row) return { eligible: false, blockers: ['tenant_not_found'], suspended_until: null }

  const blockers: FlexPayEligibility['blockers'] = []
  let suspendedUntil: string | null = null

  if (!row.ach_verified) blockers.push('ach_unverified')
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

  const lease = await queryOne(
    `SELECT 1
       FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id
      WHERE lt.tenant_id = $1
        AND lt.status = 'active'
        AND l.status IN ('active', 'pending')
      LIMIT 1`,
    [tenantId],
  )
  if (!lease) blockers.push('no_active_lease')

  return { eligible: blockers.length === 0, blockers, suspended_until: suspendedUntil }
}

// ── Enrollment ──────────────────────────────────────────────────

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

  if (!Number.isInteger(args.pullDay) || args.pullDay < 1 || args.pullDay > FLEXPAY_MAX_PULL_DAY) {
    return { ok: false, reason: `Pull day must be an integer 1 through ${FLEXPAY_MAX_PULL_DAY}` }
  }

  const elig = await getFlexPayEligibility(args.tenantId)
  if (!elig.eligible) {
    return { ok: false, reason: `Not eligible: ${elig.blockers.join(', ')}` }
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

    await client.query(
      `UPDATE tenants
          SET flexpay_enrolled     = TRUE,
              flexpay_pull_day     = $1,
              flexpay_monthly_fee  = $2,
              flexpay_enrolled_at  = NOW(),
              updated_at           = NOW()
        WHERE id = $3`,
      [args.pullDay, fee, args.tenantId],
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
 * 2026-06-27): the current cycle's advance already snapshotted its pull_day +
 * fee at grace-end, so this never disturbs or lets a tenant dodge an in-flight
 * pull — it only changes which day (and therefore the fee = $5 + day) the NEXT
 * grace-end advance uses. No outstanding-balance block is needed for that
 * reason. `flexpay_monthly_fee` is the display value, recomputed here; the
 * authoritative per-cycle fee is computed from pull_day at grace-end.
 */
export async function changeFlexPayPullDay(tenantId: string, newPullDay: number): Promise<ChangePullDayResult> {
  if (!await isFlexPayVisible()) return { ok: false, reason: 'FlexPay is not enabled on this platform' }
  // Validates the 1..28 integer range (throws otherwise) and gives the new fee.
  let fee: number
  try { fee = calculateFlexPayFee(newPullDay) }
  catch (e: any) { return { ok: false, reason: e?.message ?? 'Invalid pull day' } }

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

// ── Grace-period-end advance (GAM → landlord) ───────────────────

interface AdvanceCandidate {
  tenant_id:          string
  landlord_id:        string
  unit_id:            string
  lease_id:           string
  rent_amount:        string
  rent_due_day:       number
  late_fee_grace_days: number | null
  pull_day:           number
  connect_account_id: string | null
}

export interface GraceAdvanceResult {
  cycle_month:                string
  candidates_scanned:         number
  advances_created:           number
  advances_skipped_existing:  number
  advances_fronted:           number
  advances_suppressed_by_otp: number
  advances_transfer_failed:   number
  errors:                     number
}

/**
 * Daily cron: walks every FlexPay-enrolled tenant whose lease grace
 * period ends today (rent_due_day + late_fee_grace_days = today),
 * creates a flexpay_advances row for the current cycle, and fires
 * the Stripe Connect Transfer to fund the landlord — unless OTP
 * already covered this cycle, in which case the row is created with
 * `grace_advance_suppressed = TRUE` (no Transfer).
 *
 * Idempotent via UNIQUE (cycle_month, tenant_id) — re-running the
 * cron same-day skips existing rows.
 */
export async function processGracePeriodAdvance(now: Date = new Date()): Promise<GraceAdvanceResult> {
  const cycle = cycleMonthForDate(now)
  const out: GraceAdvanceResult = {
    cycle_month:                cycle,
    candidates_scanned:         0,
    advances_created:           0,
    advances_skipped_existing:  0,
    advances_fronted:           0,
    advances_suppressed_by_otp: 0,
    advances_transfer_failed:   0,
    errors:                     0,
  }

  const visible = await isFlexPayVisible()
  if (!visible) return out

  const dayOfMonth = now.getUTCDate()
  const candidates = await query<AdvanceCandidate>(
    `SELECT lt.tenant_id, l.landlord_id, l.unit_id, l.id AS lease_id,
            l.rent_amount, l.rent_due_day,
            COALESCE(l.late_fee_grace_days, $1) AS late_fee_grace_days,
            t.flexpay_pull_day AS pull_day,
            u.stripe_connect_account_id AS connect_account_id
       FROM tenants t
       JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
       JOIN leases l         ON l.id = lt.lease_id AND l.status IN ('active', 'pending')
       JOIN landlords la     ON la.id = l.landlord_id
       JOIN users u          ON u.id = la.user_id
      WHERE t.flexpay_enrolled = TRUE
        AND t.flexpay_pull_day IS NOT NULL
        AND (l.rent_due_day + COALESCE(l.late_fee_grace_days, $1)) = $2`,
    [FLEXPAY_DEFAULT_GRACE_DAYS, dayOfMonth],
  )
  out.candidates_scanned = candidates.length

  for (const c of candidates) {
    try {
      const rent = Number(c.rent_amount)
      const fee  = calculateFlexPayFee(c.pull_day)

      // Detect OTP coverage for this cycle (the dedup signal):
      // an otp_advances row with stripe_transfer_id set means OTP
      // already fronted to landlord; suppress our front.
      const otp = await queryOne<{ stripe_transfer_id: string | null }>(
        `SELECT stripe_transfer_id
           FROM otp_advances
          WHERE tenant_id = $1 AND cycle_month = $2`,
        [c.tenant_id, cycle],
      )
      const otpAlreadyFronted = !!otp?.stripe_transfer_id
      const suppressed = otpAlreadyFronted

      const client = await getClient()
      let advanceRowId: string | null = null
      try {
        await client.query('BEGIN')
        const ins = await client.query<{ id: string }>(
          `INSERT INTO flexpay_advances (
             cycle_month, tenant_id, landlord_id, unit_id, lease_id,
             rent_amount, tenant_fee_amount, pull_day,
             grace_advance_suppressed, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (cycle_month, tenant_id) DO NOTHING
           RETURNING id`,
          [
            cycle, c.tenant_id, c.landlord_id, c.unit_id, c.lease_id,
            rent, fee, c.pull_day,
            suppressed,
            suppressed ? 'fronted' : 'pending',
          ],
        )
        if (ins.rows.length === 0) {
          await client.query('ROLLBACK')
          out.advances_skipped_existing += 1
          continue
        }
        advanceRowId = ins.rows[0].id

        if (suppressed) {
          // Suppressed-by-OTP: the row's status is already 'fronted'
          // (per the INSERT above) since OTP covered the landlord.
          // Record the audit timestamp.
          await client.query(
            `UPDATE flexpay_advances
                SET fronted_at = NOW(), updated_at = NOW()
              WHERE id = $1`,
            [advanceRowId],
          )
        }
        await client.query('COMMIT')
        out.advances_created += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }

      if (suppressed) {
        out.advances_suppressed_by_otp += 1
        continue
      }

      // ── Fire the Stripe Transfer outside the DB transaction ──
      if (!c.connect_account_id) {
        const msg = 'Landlord has no Stripe Connect account at grace-end time'
        await query(
          `UPDATE flexpay_advances
              SET transfer_attempted_at = NOW(),
                  transfer_error        = $1,
                  updated_at            = NOW()
            WHERE id = $2`,
          [msg, advanceRowId],
        )
        await alertFlexPayTransferFailed({
          advanceId: advanceRowId!, landlordId: c.landlord_id, tenantId: c.tenant_id,
          cycle, amount: rent, error: msg,
        })
        out.advances_transfer_failed += 1
        continue
      }

      try {
        await fireFlexPayAdvanceTransfer({
          advanceId:       advanceRowId!,
          landlordConnect: c.connect_account_id,
          amount:          rent,
          cycle,
          tenantId:        c.tenant_id,
          landlordId:      c.landlord_id,
        })
        out.advances_fronted += 1
      } catch (e: any) {
        out.advances_transfer_failed += 1
        logger.error({ err: e, ctx: advanceRowId }, '[flexpay][transfer]')
      }
    } catch (e) {
      logger.error('[flexpay][advance]', c.tenant_id, c.landlord_id, e)
      out.errors += 1
    }
  }

  return out
}

/**
 * Fire the landlord-front Stripe Connect Transfer. Mirrors
 * fireOtpAdvanceTransfer from services/otp.ts — same idempotency-key
 * pattern, same admin-alert + transfer_error recording on failure.
 */
export async function fireFlexPayAdvanceTransfer(opts: {
  advanceId:       string
  landlordConnect: string
  amount:          number
  cycle:           string
  tenantId:        string
  landlordId:      string
}): Promise<{ stripeTransferId: string }> {
  const stripe = getStripe()
  try {
    const transfer = await stripe.transfers.create(
      {
        amount:      Math.round(opts.amount * 100),
        currency:    'usd',
        destination: opts.landlordConnect,
        description: `FlexPay rent front ${opts.cycle}`,
        metadata: {
          gam_purpose:     'flexpay_advance',
          gam_advance_id:  opts.advanceId,
          gam_tenant_id:   opts.tenantId,
          gam_landlord_id: opts.landlordId,
          gam_cycle_month: opts.cycle,
        },
      },
      { idempotencyKey: `flexpay_advance_${opts.advanceId}` },
    )
    await query(
      `UPDATE flexpay_advances
          SET status                = 'fronted',
              stripe_transfer_id    = $1,
              fronted_at            = COALESCE(fronted_at, NOW()),
              transfer_attempted_at = NOW(),
              transfer_error        = NULL,
              updated_at            = NOW()
        WHERE id = $2`,
      [transfer.id, opts.advanceId],
    )
    return { stripeTransferId: transfer.id }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    await query(
      `UPDATE flexpay_advances
          SET transfer_attempted_at = NOW(),
              transfer_error        = $1,
              updated_at            = NOW()
        WHERE id = $2`,
      [msg, opts.advanceId],
    )
    await alertFlexPayTransferFailed({
      advanceId: opts.advanceId, landlordId: opts.landlordId, tenantId: opts.tenantId,
      cycle: opts.cycle, amount: opts.amount, error: msg,
    })
    throw e
  }
}

// ── Pull-day tenant ACH pull (rent + fee combined) ──────────────

export interface PullDayResult {
  cycle_month:           string
  candidates_scanned:    number
  pulls_initiated:       number
  pulls_skipped_existing: number
  errors:                number
}

/**
 * Daily cron: walks every flexpay_advances row in 'fronted' status
 * for the current cycle whose pull_day matches today. Initiates a
 * single ACH pull from the tenant for rent + fee combined. Gross
 * lands on platform balance (GAM already covered the landlord —
 * this is GAM's reimbursement plus the fee revenue).
 *
 * One payments row stamped type='rent', amount = rent + fee,
 * notes = breakdown. The rent_payment_id field references it; the
 * fee_payment_id field stays NULL (intentional — a combined PI
 * avoids a per-cycle duplicated Stripe ACH fee).
 */
export async function processFlexPayPullDay(now: Date = new Date()): Promise<PullDayResult> {
  const cycle = cycleMonthForDate(now)
  const out: PullDayResult = {
    cycle_month:           cycle,
    candidates_scanned:    0,
    pulls_initiated:       0,
    pulls_skipped_existing: 0,
    errors:                0,
  }

  const visible = await isFlexPayVisible()
  if (!visible) return out

  const dayOfMonth = now.getUTCDate()
  const candidates = await query<{
    advance_id:      string
    tenant_id:       string
    landlord_id:     string
    lease_id:        string
    unit_id:         string
    rent_amount:     string
    tenant_fee_amount: string
    pull_day:        number
    stripe_customer_id: string | null
  }>(
    `SELECT a.id AS advance_id, a.tenant_id, a.landlord_id, a.lease_id, a.unit_id,
            a.rent_amount, a.tenant_fee_amount, a.pull_day,
            t.stripe_customer_id
       FROM flexpay_advances a
       JOIN tenants t ON t.id = a.tenant_id
      WHERE a.cycle_month = $1
        AND a.pull_day    = $2
        AND a.status      = 'fronted'
        AND a.rent_payment_id IS NULL`,
    [cycle, dayOfMonth],
  )
  out.candidates_scanned = candidates.length

  const stripe = getStripe()

  for (const c of candidates) {
    try {
      const rent = Number(c.rent_amount)
      const fee  = Number(c.tenant_fee_amount)
      const total = rent + fee

      if (!c.stripe_customer_id) {
        await query(
          `UPDATE flexpay_advances
              SET status = 'defaulted', defaulted_at = NOW(),
                  default_reason = 'tenant_no_stripe_customer',
                  updated_at = NOW()
            WHERE id = $1`,
          [c.advance_id],
        )
        out.errors += 1
        continue
      }

      // Resolve tenant's default payment method from Stripe Customer
      // (invoice_settings.default_payment_method or legacy default_source).
      // Mirrors the leaseTermination.ts pattern.
      let paymentMethodId: string | null = null
      try {
        const customer = await stripe.customers.retrieve(c.stripe_customer_id)
        if (customer && !(customer as any).deleted) {
          const cust = customer as any
          paymentMethodId = cust.invoice_settings?.default_payment_method ?? cust.default_source ?? null
        }
      } catch (e) {
        logger.error({ err: e, ctx: c.advance_id }, '[flexpay][customer-lookup]')
      }
      if (!paymentMethodId) {
        await query(
          `UPDATE flexpay_advances
              SET status = 'defaulted', defaulted_at = NOW(),
                  default_reason = 'tenant_no_default_payment_method',
                  updated_at = NOW()
            WHERE id = $1`,
          [c.advance_id],
        )
        out.errors += 1
        continue
      }

      // Single combined ACH pull. Gross to platform balance — GAM
      // is reimbursing its own front + collecting the fee, not
      // routing to landlord (landlord already paid via the
      // grace-end Transfer, or by OTP).
      //
      // S261: supersedence boost. This advance is in 'fronted' status,
      // not 'defaulted', so it's not in the FIFO list — no
      // self-subtract needed.
      const boost = await computeTenantGamOutstandingTotal(c.tenant_id)
      const pullAmount = Math.round((total + boost) * 100) / 100

      const intent = await createRentPlatformCharge({
        amount:              pullAmount,
        stripeCustomerId:    c.stripe_customer_id,
        paymentMethodId:     paymentMethodId,
        paymentMethodTypes:  ['us_bank_account'],
        entryDescription:    'FLEXPAY',
        metadata: {
          gam_purpose:    'flexpay_pull',
          gam_advance_id: c.advance_id,
          gam_tenant_id:  c.tenant_id,
          gam_rent:       String(rent),
          gam_fee:        String(fee),
        },
      })

      const payment = await queryOne<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description,
           due_date, stripe_payment_intent_id, notes,
           gam_supersedence_amount
         ) VALUES ($1, $2, $3, $4, 'rent', $5, 'pending', 'FLEXPAY',
                   $6, $7, $8, $9)
         RETURNING id`,
        [
          c.landlord_id, c.tenant_id, c.lease_id, c.unit_id,
          pullAmount,
          cycle,
          intent.id,
          `FlexPay pull cycle ${cycle} — rent $${rent.toFixed(2)} + fee $${fee.toFixed(2)}`,
          boost.toFixed(2),
        ],
      )

      await query(
        `UPDATE flexpay_advances
            SET status          = 'pulled',
                rent_payment_id = $1,
                pulled_at       = NOW(),
                updated_at      = NOW()
          WHERE id = $2`,
        [payment!.id, c.advance_id],
      )
      out.pulls_initiated += 1
    } catch (e: any) {
      logger.error({ err: e, ctx: c.advance_id }, '[flexpay][pull]')
      out.errors += 1
    }
  }

  return out
}

/**
 * Re-price a FlexPay cycle's pull right before an ACH RETRY fires (Consumer
 * ToS § 4.1 + § 4.2): the monthly fee recalculates under the formula at the
 * RETRY day (e.g. a pull that bounced on the 11th and retries on the 15th
 * recomputes $16 → $20), and the bounced attempt's Stripe ACH-return fee
 * passes through at cost. The original pull is all-or-nothing ACH, so the
 * failed attempt collected nothing — the recomputed fee REPLACES the prior
 * one (no double charge).
 *
 * Mutates the EXISTING PaymentIntent's amount (+ the advance fee + payment
 * row) so the generic achRetry confirm re-pulls the corrected total. Called
 * by processAchRetries for entry_description='FLEXPAY' payments before confirm.
 * Throws on failure so the caller skips the (stale-amount) confirm.
 */
export async function repriceFlexPayRetryPayment(paymentId: string): Promise<void> {
  const pay = await queryOne<{ stripe_payment_intent_id: string | null; tenant_id: string }>(
    `SELECT stripe_payment_intent_id, tenant_id
       FROM payments WHERE id = $1 AND entry_description = 'FLEXPAY'`,
    [paymentId],
  )
  if (!pay || !pay.stripe_payment_intent_id) return  // not a FlexPay PI — nothing to reprice

  const adv = await queryOne<{ id: string; rent_amount: string }>(
    `SELECT id, rent_amount FROM flexpay_advances WHERE rent_payment_id = $1`,
    [paymentId],
  )
  if (!adv) return  // no linked advance (shouldn't happen) — leave the confirm to run as-is

  const rent = Number(adv.rent_amount)
  // Retry day = today's calendar day, clamped to the 1..28 formula range.
  const retryDay = Math.min(Math.max(new Date().getUTCDate(), 1), FLEXPAY_MAX_PULL_DAY)
  const newFee = calculateFlexPayFee(retryDay)
  const boost = await computeTenantGamOutstandingTotal(pay.tenant_id)
  const newAmount = Math.round((rent + newFee + FLEXPAY_ACH_RETURN_FEE + boost) * 100) / 100

  const stripe = getStripe()
  await stripe.paymentIntents.update(pay.stripe_payment_intent_id, {
    amount: Math.round(newAmount * 100),
    metadata: {
      gam_purpose:            'flexpay_pull',
      gam_advance_id:         adv.id,
      gam_tenant_id:          pay.tenant_id,
      gam_rent:               String(rent),
      gam_fee:                String(newFee),
      gam_ach_return_fee:     String(FLEXPAY_ACH_RETURN_FEE),
      gam_repriced_retry_day: String(retryDay),
    },
  })

  await query(
    `UPDATE flexpay_advances SET tenant_fee_amount = $1, updated_at = NOW() WHERE id = $2`,
    [newFee, adv.id],
  )
  await query(
    `UPDATE payments
        SET amount = $1, gam_supersedence_amount = $2, notes = $3
      WHERE id = $4`,
    [
      newAmount, boost.toFixed(2),
      `FlexPay retry (day ${retryDay}) — rent $${rent.toFixed(2)} + fee $${newFee.toFixed(2)} + ACH-return $${FLEXPAY_ACH_RETURN_FEE.toFixed(2)}`,
      paymentId,
    ],
  )
}

// ── Webhook reconciliation hooks ────────────────────────────────

/**
 * Called from webhooks when a `payment_intent.succeeded` lands for a
 * FlexPay-tagged rent payment. Flips both the payments row and the
 * linked flexpay_advances row to settled/reconciled. Idempotent.
 */
export async function reconcileSettledFlexPayPayment(paymentId: string): Promise<void> {
  const payment = await queryOne<{
    tenant_id: string
    due_date: string
    entry_description: string | null
  }>(
    `SELECT tenant_id, due_date, entry_description
       FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!payment || payment.entry_description !== 'FLEXPAY') return

  const cycle = cycleMonthForDate(new Date(payment.due_date))
  await query(
    `UPDATE flexpay_advances
        SET status         = 'reconciled',
            reconciled_at  = NOW(),
            updated_at     = NOW()
      WHERE tenant_id      = $1
        AND cycle_month    = $2
        AND rent_payment_id = $3
        AND status         = 'pulled'`,
    [payment.tenant_id, cycle, paymentId],
  )
}

/**
 * Called from webhooks when a `payment_intent.payment_failed` lands
 * for a FlexPay-tagged rent payment.
 *
 * NACHA semantics: ACH may retry on insufficient/uncollected funds
 * codes; the existing achRetry pipeline schedules + fires retries.
 * FlexPay's 2-strike rule (original attempt + 1 retry, both failed
 * → 90-day suspension) is enforced by checking retry_count on the
 * payments row: if retry_count >= 1 and we're here on a payment_
 * failed event, the retry just failed, so we're at the suspension
 * trigger.
 *
 * Pre-retry first-failure events do not suspend — they get the
 * normal ACH retry schedule.
 */
export async function handleFlexPayPaymentNsf(paymentId: string): Promise<void> {
  const payment = await queryOne<{
    tenant_id: string
    due_date: string
    entry_description: string | null
    retry_count: number | null
  }>(
    `SELECT tenant_id, due_date, entry_description, retry_count
       FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!payment || payment.entry_description !== 'FLEXPAY') return

  // First failure: ACH retry pipeline handles it. We only act on
  // the second failure (retry_count >= 1 means a retry has already
  // fired and just failed).
  if ((payment.retry_count ?? 0) < 1) return

  const cycle = cycleMonthForDate(new Date(payment.due_date))
  const adv = await queryOne<{ id: string }>(
    `SELECT id FROM flexpay_advances
      WHERE tenant_id = $1 AND cycle_month = $2 AND rent_payment_id = $3
        AND status IN ('pulled', 'nsf')`,
    [payment.tenant_id, cycle, paymentId],
  )
  if (!adv) return

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE flexpay_advances
          SET status         = 'defaulted',
              defaulted_at   = NOW(),
              default_reason = 'tenant_nsf_second_failure',
              updated_at     = NOW()
        WHERE id = $1`,
      [adv.id],
    )
    await client.query(
      `UPDATE tenants
          SET flexpay_enrolled            = FALSE,
              flexpay_pull_day            = NULL,
              flexpay_monthly_fee         = NULL,
              flexpay_disqualified_until  = NOW() + INTERVAL '${FLEXPAY_NSF_COOLDOWN_DAYS} days',
              flexpay_disqualified_reason = 'nsf_second_failure'
        WHERE id = $1`,
      [payment.tenant_id],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'flexpay_advance_defaulted',
      title:    `FlexPay defaulted (2nd NSF) — ${cycle}`,
      body:     `Tenant ${payment.tenant_id} NSF'd twice on FlexPay cycle ${cycle}; advance ${adv.id} written off. Tenant suspended ${FLEXPAY_NSF_COOLDOWN_DAYS} days.`,
      context: { advance_id: adv.id, payment_id: paymentId, cycle, tenant_id: payment.tenant_id },
    })
  } catch (e) {
    logger.error({ err: e }, '[flexpay][nsf-alert]')
  }
}

/**
 * Auto-disenroll when a tenant unlinks/unverifies their bank
 * account — GAM can't pull funds, so FlexPay can't operate. No
 * cooldown — tenant can re-enroll after re-verifying.
 */
export async function autoDisenrollFlexPayOnAchUnverified(tenantId: string): Promise<void> {
  await query(
    `UPDATE tenants
        SET flexpay_enrolled    = FALSE,
            flexpay_pull_day    = NULL,
            flexpay_monthly_fee = NULL
      WHERE id = $1
        AND flexpay_enrolled = TRUE`,
    [tenantId],
  )
}

// ── helpers ─────────────────────────────────────────────────────

async function alertFlexPayTransferFailed(opts: {
  advanceId:  string
  landlordId: string
  tenantId:   string
  cycle:      string
  amount:     number
  error:      string
}) {
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'flexpay_advance_transfer_failed',
      title:    `FlexPay landlord-front Transfer failed — ${opts.cycle}`,
      body:     `Advance ${opts.advanceId} for tenant ${opts.tenantId} (landlord ${opts.landlordId}, $${opts.amount.toFixed(2)}) failed to fund: ${opts.error}. Row left in 'pending'.`,
      context: {
        advance_id:  opts.advanceId,
        landlord_id: opts.landlordId,
        tenant_id:   opts.tenantId,
        cycle:       opts.cycle,
        amount:      opts.amount,
        error:       opts.error,
      },
    })
  } catch (e) {
    logger.error({ err: e }, '[flexpay][alert]')
  }
}

/** First-of-the-month for the cycle this date belongs to (UTC). */
export function cycleMonthForDate(d: Date): string {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  return first.toISOString().slice(0, 10)
}
