import { query, queryOne, getClient } from '../db'
import { isFeatureEnabled } from './systemFeatures'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'

// ============================================================
// OTP (On-Time Pay) — landlord rent-advance product.
//
// GAM advances rent to the landlord on the last business day of
// the month so funds clear by the 1st. Tenant pays normally at
// their regular pull date later in the month. Revenue is the 1%
// spread (landlord receives 99% of rent on advance day; GAM keeps
// 1% when collected from tenant).
//
// Visibility model:
//   - system_features.otp_rollout_visible (global) MUST be TRUE
//   - landlords.otp_rollout_enabled (per-landlord beta) MUST be TRUE
//   - Both → landlord sees OTP. Either FALSE → invisible.
//
// Qualification gate (all must hold for tenant to be eligible):
//   1. Tenant ach_verified = TRUE
//   2. Security deposit fully funded (collected_amount >= total_amount,
//      AND not in active FlexDeposit installment plan)
//   3. Background check passed (tenant_bg_status = 'approved')
//   4. otp_disqualified_until is NULL or in the past (no active
//      6-month NSF cooldown)
//
// Risk model (S155 design call):
//   - First NSF: GAM eats the loss (regulatory boundary — no pursuit)
//   - Tenant disqualified for 6 months
//   - Bank unlinked (ach_verified flips FALSE) → auto-disenroll
//   - Reenrollment after cooldown: TBD policy (flagged for future)
// ============================================================

export const OTP_FEE_PCT = 0.01 // 1% spread
export const OTP_NSF_COOLDOWN_DAYS = 180 // 6 months

export async function isOtpVisibleForLandlord(landlordId: string): Promise<boolean> {
  const platform = await isFeatureEnabled('otp_rollout_visible')
  if (!platform) return false
  const row = await queryOne<{ otp_rollout_enabled: boolean }>(
    `SELECT otp_rollout_enabled FROM landlords WHERE id = $1`,
    [landlordId],
  )
  return row?.otp_rollout_enabled === true
}

export interface QualificationStatus {
  eligible: boolean
  blockers: Array<
    | 'ach_unverified'
    | 'deposit_not_funded'
    | 'flex_deposit_active'
    | 'bg_check_not_approved'
    | 'nsf_cooldown'
    | 'tenant_not_found'
  >
  cooldown_until: string | null
}

export async function getQualificationStatus(tenantId: string): Promise<QualificationStatus> {
  const row = await queryOne<{
    ach_verified: boolean
    bg_status: string | null
    otp_disqualified_until: string | null
    deposit_total: string | null
    deposit_collected: string | null
    flex_deposit_enabled: boolean | null
    flex_installments_remaining: number | null
  }>(
    `SELECT t.ach_verified,
            t.background_check_status AS bg_status,
            t.otp_disqualified_until,
            sd.total_amount         AS deposit_total,
            sd.collected_amount     AS deposit_collected,
            sd.flex_deposit_enabled AS flex_deposit_enabled,
            sd.installments_remaining AS flex_installments_remaining
       FROM tenants t
       LEFT JOIN security_deposits sd ON sd.tenant_id = t.id
      WHERE t.id = $1
      LIMIT 1`,
    [tenantId],
  )
  if (!row) {
    return { eligible: false, blockers: ['tenant_not_found'], cooldown_until: null }
  }

  const blockers: QualificationStatus['blockers'] = []

  if (!row.ach_verified) blockers.push('ach_unverified')

  // bg check status — accept 'approved' as the qualifying state
  if (row.bg_status !== 'approved') blockers.push('bg_check_not_approved')

  // deposit funded check — match the existing logic in the deprecated tenant endpoint
  const depositFullyFunded =
    row.deposit_total != null &&
    row.deposit_collected != null &&
    Number(row.deposit_collected) >= Number(row.deposit_total) &&
    !(row.flex_deposit_enabled === true && (row.flex_installments_remaining ?? 0) > 0)
  if (!depositFullyFunded) {
    if (row.flex_deposit_enabled === true && (row.flex_installments_remaining ?? 0) > 0) {
      blockers.push('flex_deposit_active')
    } else {
      blockers.push('deposit_not_funded')
    }
  }

  let cooldownUntil: string | null = null
  if (row.otp_disqualified_until) {
    const until = new Date(row.otp_disqualified_until)
    if (until.getTime() > Date.now()) {
      blockers.push('nsf_cooldown')
      cooldownUntil = row.otp_disqualified_until
    }
  }

  return { eligible: blockers.length === 0, blockers, cooldown_until: cooldownUntil }
}

export async function enableOtpForTenant(args: {
  tenantId: string
  landlordId: string
  enabledByUserId: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const visible = await isOtpVisibleForLandlord(args.landlordId)
  if (!visible) return { ok: false, reason: 'OTP not enabled for this landlord' }

  // S244: landlord must have a Stripe Connect account before any tenant
  // can be enrolled — the advance day fires a Connect Transfer to that
  // account. Without it, the cron would explode with no destination.
  // Check up-front so the landlord sees a clear "complete Connect
  // onboarding first" message instead of a silent enroll-then-fail loop.
  const acct = await queryOne<{ connect_id: string | null }>(
    `SELECT u.stripe_connect_account_id AS connect_id
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`,
    [args.landlordId],
  )
  if (!acct?.connect_id) {
    return { ok: false, reason: 'Landlord has no Stripe Connect account — complete onboarding at /banking before enrolling tenants in OTP' }
  }

  const status = await getQualificationStatus(args.tenantId)
  if (!status.eligible) return { ok: false, reason: `Tenant not qualified: ${status.blockers.join(', ')}` }

  // Confirm the landlord owns the tenant relationship
  const rel = await queryOne(
    `SELECT 1
       FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id
      WHERE lt.tenant_id = $1
        AND l.landlord_id = $2
        AND lt.status = 'active'
        AND l.status IN ('active', 'pending')
      LIMIT 1`,
    [args.tenantId, args.landlordId],
  )
  if (!rel) return { ok: false, reason: 'Tenant not on an active lease with this landlord' }

  await query(
    `UPDATE tenants
        SET on_time_pay_enrolled = TRUE,
            float_fee_active = TRUE
      WHERE id = $1`,
    [args.tenantId],
  )
  return { ok: true }
}

export async function disableOtpForTenant(args: {
  tenantId: string
  landlordId: string
  reason: string
}): Promise<void> {
  await query(
    `UPDATE tenants
        SET on_time_pay_enrolled = FALSE,
            float_fee_active = FALSE
      WHERE id = $1`,
    [args.tenantId],
  )
}

/**
 * Disqualify a tenant from OTP for 6 months following an NSF on a
 * rent payment that had an active OTP advance. Auto-disenrolls.
 */
export async function disqualifyTenantForNsf(tenantId: string): Promise<void> {
  await query(
    `UPDATE tenants
        SET on_time_pay_enrolled = FALSE,
            float_fee_active = FALSE,
            otp_disqualified_until = NOW() + INTERVAL '${OTP_NSF_COOLDOWN_DAYS} days',
            otp_disqualified_reason = 'nsf_on_advanced_month'
      WHERE id = $1`,
    [tenantId],
  )
}

/**
 * When a tenant unlinks / unverifies their bank account, OTP must
 * auto-disenroll because GAM can't pull the funds. No cooldown — they
 * can re-enroll once they re-verify ACH (and pass other gates).
 */
export async function autoDisenrollOnAchUnverified(tenantId: string): Promise<void> {
  await query(
    `UPDATE tenants
        SET on_time_pay_enrolled = FALSE,
            float_fee_active = FALSE
      WHERE id = $1
        AND on_time_pay_enrolled = TRUE`,
    [tenantId],
  )
}

/**
 * Last-business-day-of-month advance run.
 *
 * For every (landlord, tenant) where:
 *   - landlord.otp_rollout_enabled = TRUE
 *   - system_features.otp_rollout_visible = TRUE
 *   - tenant.on_time_pay_enrolled = TRUE
 *   - tenant has an active lease with this landlord
 *   - no advance row exists for this cycle_month yet
 * Create an advance row + emit a payout payment to the landlord
 * for 99% of rent. Idempotent via UNIQUE (cycle_month, tenant_id).
 *
 * S244: fires a Stripe Connect Transfer from the platform balance to
 * the landlord's Connect account immediately after the rows commit.
 * On success, advance row flips to 'advanced' with `stripe_transfer_id`
 * stamped; payments row flips to 'settled'. On failure, both rows stay
 * 'pending' with `transfer_error` recorded — admin sees the failure in
 * the alert feed and can retry via the admin route.
 *
 * Funding source = GAM platform balance. Internally we refer to this as
 * "the OTP reserve pool" but it's not a separate Stripe balance; the
 * reserve is an accounting construct that backs the float-lending risk
 * (when a tenant NSFs, GAM eats the loss from the same pool).
 */
export interface AdvanceRunResult {
  cycle_month: string
  enrolled_tenants: number
  advances_created: number
  advances_skipped_already_exist: number
  advances_funded: number       // S244: rows where Stripe Transfer fired OK
  advances_transfer_failed: number  // S244: row created, Transfer errored
  errors: number
}

export async function processMonthlyAdvance(now: Date = new Date()): Promise<AdvanceRunResult> {
  const platform = await isFeatureEnabled('otp_rollout_visible')
  if (!platform) {
    return {
      cycle_month: cycleMonthFor(now),
      enrolled_tenants: 0,
      advances_created: 0,
      advances_skipped_already_exist: 0,
      advances_funded: 0,
      advances_transfer_failed: 0,
      errors: 0,
    }
  }

  const cycle = cycleMonthFor(now)
  // S244: pull stripe_connect_account_id alongside so the cron can
  // skip-with-error landlords whose Connect vanished between enroll
  // and advance day (rare but possible — Connect reject, manual
  // dashboard disconnect, etc.) without exploding the loop.
  const candidates = await query<{
    tenant_id: string
    landlord_id: string
    unit_id: string
    lease_id: string
    rent_amount: string
    connect_account_id: string | null
  }>(
    `SELECT lt.tenant_id, l.landlord_id, l.unit_id, l.id AS lease_id, l.rent_amount,
            u.stripe_connect_account_id AS connect_account_id
       FROM tenants t
       JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status = 'active'
       JOIN leases l ON l.id = lt.lease_id AND l.status IN ('active', 'pending')
       JOIN landlords la ON la.id = l.landlord_id AND la.otp_rollout_enabled = TRUE
       JOIN users u ON u.id = la.user_id
      WHERE t.on_time_pay_enrolled = TRUE`,
  )

  let created = 0
  let skipped = 0
  let funded = 0
  let transferFailed = 0
  let errors = 0

  for (const c of candidates) {
    try {
      const rent = Number(c.rent_amount)
      const fee = round2(rent * OTP_FEE_PCT)
      const advance = round2(rent - fee)

      let advanceRowId: string | null = null
      const client = await getClient()
      try {
        await client.query('BEGIN')

        // Insert advance row; ON CONFLICT skips if already exists this cycle.
        const ins = await client.query<{ id: string }>(
          `INSERT INTO otp_advances (
             cycle_month, tenant_id, landlord_id, unit_id, lease_id,
             rent_amount, fee_amount, advance_amount, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
           ON CONFLICT (cycle_month, tenant_id) DO NOTHING
           RETURNING id`,
          [cycle, c.tenant_id, c.landlord_id, c.unit_id, c.lease_id, rent, fee, advance],
        )
        if (ins.rows.length === 0) {
          // Already existed this cycle
          await client.query('ROLLBACK')
          skipped += 1
          continue
        }
        advanceRowId = ins.rows[0].id

        // Create the payments row representing GAM's payout to landlord.
        // type='fee' (payments_type_check doesn't carry an 'advance'
        // value; 'fee' + entry_description='ONTIMEPAY' is the audit
        // marker). Status stays 'pending' until the Stripe Transfer
        // fires after commit; on success we flip both rows together.
        const pay = await client.query<{ id: string }>(
          `INSERT INTO payments (
             landlord_id, tenant_id, lease_id, unit_id,
             type, amount, status, entry_description, due_date, notes
           ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'ONTIMEPAY', $6, $7)
           RETURNING id`,
          [
            c.landlord_id, c.tenant_id, c.lease_id, c.unit_id,
            advance,
            cycle,
            `OTP advance for ${cycle} — rent $${rent.toFixed(2)}, fee $${fee.toFixed(2)}`,
          ],
        )
        await client.query(
          `UPDATE otp_advances
              SET advance_payment_id = $1, updated_at = NOW()
            WHERE id = $2`,
          [pay.rows[0].id, advanceRowId],
        )

        await client.query('COMMIT')
        created += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }

      // ── Fire the Stripe Transfer outside the DB transaction ──
      // The DB row exists in 'pending' status; the Transfer call may
      // take seconds and we don't want to hold a tx open across it.
      // Skip-with-error landlords whose Connect account vanished.
      if (!c.connect_account_id) {
        const msg = 'Landlord has no Stripe Connect account at advance time'
        await query(
          `UPDATE otp_advances
              SET transfer_attempted_at = NOW(),
                  transfer_error = $1,
                  updated_at = NOW()
            WHERE id = $2`,
          [msg, advanceRowId],
        )
        await alertAdvanceTransferFailed({
          advanceId: advanceRowId!,
          landlordId: c.landlord_id,
          tenantId: c.tenant_id,
          cycle,
          amount: advance,
          error: msg,
        })
        transferFailed += 1
        continue
      }

      try {
        await fireOtpAdvanceTransfer({
          advanceId:        advanceRowId!,
          landlordConnect:  c.connect_account_id,
          amount:           advance,
          cycle,
          tenantId:         c.tenant_id,
          landlordId:       c.landlord_id,
        })
        funded += 1
      } catch (e: any) {
        transferFailed += 1
        // fireOtpAdvanceTransfer already recorded the error + alerted.
        logger.error({ err: e, ctx: advanceRowId }, '[otp][transfer]')
      }
    } catch (e) {
      logger.error('[otp][advance]', c.tenant_id, c.landlord_id, e)
      errors += 1
    }
  }

  return {
    cycle_month: cycle,
    enrolled_tenants: candidates.length,
    advances_created: created,
    advances_skipped_already_exist: skipped,
    advances_funded: funded,
    advances_transfer_failed: transferFailed,
    errors,
  }
}

/**
 * S244: fire a Stripe Connect Transfer to fund an OTP advance.
 *
 * Idempotent via `Idempotency-Key: otp_advance_<advanceId>` — re-firing
 * the same advance returns the original Transfer rather than
 * double-paying. Caller is responsible for ensuring the advance row
 * is in 'pending' status; this helper doesn't gate on that (admin
 * retry needs to fire even if the row was previously marked failed).
 *
 * On success: advance row → status='advanced', stripe_transfer_id set,
 *             advanced_at + transfer_attempted_at = NOW, transfer_error
 *             cleared. Linked payments row → status='settled'.
 * On failure: advance row → transfer_attempted_at + transfer_error set,
 *             status stays current. Admin alerted. Throws for caller
 *             visibility (cron logs the failure but keeps going;
 *             admin-retry route surfaces the error to the operator).
 */
export async function fireOtpAdvanceTransfer(opts: {
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
        description: `OTP advance ${opts.cycle}`,
        metadata: {
          gam_purpose:     'otp_advance',
          gam_advance_id:  opts.advanceId,
          gam_tenant_id:   opts.tenantId,
          gam_landlord_id: opts.landlordId,
          gam_cycle_month: opts.cycle,
        },
      },
      { idempotencyKey: `otp_advance_${opts.advanceId}` },
    )

    // Flip the advance row + linked payment row to their settled
    // states. Single round trip via a CTE so the payments update
    // can't race the advance update on partial failure.
    await query(
      `WITH adv AS (
         UPDATE otp_advances
            SET status                = 'advanced',
                stripe_transfer_id    = $1,
                advanced_at           = COALESCE(advanced_at, NOW()),
                transfer_attempted_at = NOW(),
                transfer_error        = NULL,
                updated_at            = NOW()
          WHERE id = $2
          RETURNING advance_payment_id
       )
       UPDATE payments
          SET status = 'settled'
        WHERE id = (SELECT advance_payment_id FROM adv)
          AND id IS NOT NULL`,
      [transfer.id, opts.advanceId],
    )

    return { stripeTransferId: transfer.id }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    await query(
      `UPDATE otp_advances
          SET transfer_attempted_at = NOW(),
              transfer_error        = $1,
              updated_at            = NOW()
        WHERE id = $2`,
      [msg, opts.advanceId],
    )
    await alertAdvanceTransferFailed({
      advanceId:  opts.advanceId,
      landlordId: opts.landlordId,
      tenantId:   opts.tenantId,
      cycle:      opts.cycle,
      amount:     opts.amount,
      error:      msg,
    })
    throw e
  }
}

async function alertAdvanceTransferFailed(opts: {
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
      category: 'otp_advance_transfer_failed',
      title:    `OTP advance Transfer failed — ${opts.cycle}`,
      body:     `Advance ${opts.advanceId} for tenant ${opts.tenantId} (landlord ${opts.landlordId}, $${opts.amount.toFixed(2)}) failed to fund: ${opts.error}. Row left in 'pending'; retry via POST /api/admin/otp/advances/${opts.advanceId}/retry-transfer.`,
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
    logger.error({ err: e }, '[otp][alert]')
  }
}

/**
 * Webhook hook: on payment_intent.succeeded for a settled rent payment,
 * close out any matching OTP advance. The advance is identified by
 * (tenant_id, cycle_month) where cycle_month is derived from the
 * payment's due_date. Idempotent.
 */
export async function reconcileSettledRentPayment(paymentId: string): Promise<void> {
  const payment = await queryOne<{ tenant_id: string; due_date: string; type: string }>(
    `SELECT tenant_id, due_date, type FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!payment || payment.type !== 'rent') return

  const cycle = cycleMonthForRentDue(new Date(payment.due_date))
  await query(
    `UPDATE otp_advances
        SET status = 'reconciled',
            reconciled_with_payment_id = $1,
            reconciled_at = NOW(),
            updated_at = NOW()
      WHERE tenant_id = $2
        AND cycle_month = $3
        AND status = 'advanced'`,
    [paymentId, payment.tenant_id, cycle],
  )
}

/**
 * Webhook hook: on terminal payment_intent.payment_failed for a rent
 * payment, if there's an outstanding OTP advance, mark it defaulted +
 * disqualify the tenant for 6 months + disenroll. GAM eats the loss.
 */
export async function handleRentPaymentNsf(paymentId: string): Promise<void> {
  const payment = await queryOne<{ tenant_id: string; due_date: string; type: string }>(
    `SELECT tenant_id, due_date, type FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!payment || payment.type !== 'rent') return

  const cycle = cycleMonthForRentDue(new Date(payment.due_date))
  const advance = await queryOne<{ id: string }>(
    `SELECT id FROM otp_advances
      WHERE tenant_id = $1 AND cycle_month = $2 AND status = 'advanced'`,
    [payment.tenant_id, cycle],
  )
  if (!advance) return

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE otp_advances
          SET status = 'defaulted',
              defaulted_at = NOW(),
              default_reason = 'tenant_nsf',
              updated_at = NOW()
        WHERE id = $1`,
      [advance.id],
    )
    await client.query(
      `UPDATE tenants
          SET on_time_pay_enrolled = FALSE,
              float_fee_active = FALSE,
              otp_disqualified_until = NOW() + INTERVAL '${OTP_NSF_COOLDOWN_DAYS} days',
              otp_disqualified_reason = 'nsf_on_advanced_month'
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

  // Admin alert for the loss event
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'otp_advance_defaulted',
      title: `OTP advance defaulted (NSF) — ${cycle}`,
      body: `Tenant ${payment.tenant_id} NSF'd on rent for cycle ${cycle}; OTP advance ${advance.id} flagged as loss. Tenant disqualified for ${OTP_NSF_COOLDOWN_DAYS} days.`,
      context: { advance_id: advance.id, payment_id: paymentId, cycle, tenant_id: payment.tenant_id },
    })
  } catch (e) {
    logger.error({ err: e }, '[otp][nsf-alert]')
  }
}

// ─── helpers ────────────────────────────────────────────────────

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/**
 * cycle_month for the advance run: the FOLLOWING month's 1st.
 * If the cron fires on the last business day of October, the cycle
 * is November ('2026-11-01').
 */
export function cycleMonthFor(now: Date): string {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1 // 0-indexed → next month's number after +1
  const cycleY = m === 11 + 1 ? y + 1 : (m === 12 ? y + 1 : y)
  const cycleM = (m === 12 ? 1 : (m === 11 ? 12 : m + 1)) - 1
  // Above logic is finicky; simpler: take the first of next month.
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return next.toISOString().slice(0, 10)
}

/**
 * Map a rent payment's due_date to its cycle_month bucket. Rent due
 * on '2026-11-05' belongs to cycle_month '2026-11-01'.
 */
export function cycleMonthForRentDue(due: Date): string {
  const first = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), 1))
  return first.toISOString().slice(0, 10)
}

/**
 * Returns TRUE when `now` is the last business day of its month
 * (Mon-Fri). Used by the daily scheduler tick to decide whether
 * to run processMonthlyAdvance.
 */
export function isLastBusinessDayOfMonth(now: Date = new Date()): boolean {
  const dow = now.getUTCDay() // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  if (dow === 0 || dow === 6) return false // weekend can never be last business day

  // Walk forward day-by-day; if any later day in this month is also
  // a weekday, today is not the last business day.
  const month = now.getUTCMonth()
  const year = now.getUTCFullYear()
  for (let d = now.getUTCDate() + 1; d <= 31; d++) {
    const candidate = new Date(Date.UTC(year, month, d))
    if (candidate.getUTCMonth() !== month) break
    const cdow = candidate.getUTCDay()
    if (cdow !== 0 && cdow !== 6) return false
  }
  return true
}
