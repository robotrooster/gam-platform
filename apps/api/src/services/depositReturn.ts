import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { appendEvent } from './creditLedger'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'

// ============================================================
// Deposit-return service.
//
// Calculation model:
//   total_deposit         from security_deposits.total_amount
//   cleaning_fee_amount   sum of lease_fees with due_timing='move_out'
//                         (almost always just the cleaning_fee row;
//                         pulls all of them in case landlord has more)
//   damage_lines          landlord-added at finalize time
//   other_deductions      catch-all (utilities, last-month-rent, etc.)
//   total_deductions      = cleaning_fee + sum(damage_lines.amount) + sum(other_deductions.amount)
//   refund_amount         = MAX(0, total_deposit - total_deductions)
//   gap_amount            = MAX(0, total_deductions - total_deposit)
//
// Finalize flow:
//   1. Stamp finalized_at + status (sent_refund / sent_gap / sent_zero)
//   2. If refund_amount > 0: create a 'fee'-type payments row that
//      represents the landlord-to-tenant refund. The actual money
//      movement to the tenant is handled by the existing landlord
//      withdrawal/disbursement path; we just record the obligation.
//   3. If gap_amount > 0: create a 'fee'-type payments row for the
//      gap (status='pending'); attempt auto-charge against tenant's
//      on-file payment method via the existing Stripe Customer.
//      On charge success: payment row remains (will flip to 'settled'
//      via the standard webhook). On charge failure: gap_charge_failed
//      stays true; landlord sees the failure on the deposit_returns
//      row + admin notification fires.
//   4. Emit credit-ledger events:
//        - deposit_returned_full (refund_amount == total_deposit)
//        - deposit_returned_partial (refund_amount > 0 and < total_deposit)
//        - deposit_returned_zero (refund_amount == 0 and gap_amount == 0)
//        - tenancy_ended_with_balance (gap_amount > 0)
// ============================================================

export interface DamageLine {
  description: string
  amount: number
}

export interface DepositReturnDraftInput {
  leaseId: string
  damageLines?: DamageLine[]
  otherDeductions?: DamageLine[]
  notes?: string
}

export interface DepositReturnRow {
  id: string
  lease_id: string
  tenant_id: string
  landlord_id: string
  security_deposit_id: string | null
  total_deposit: string
  cleaning_fee_amount: string
  unpaid_balance_amount: string  // S180: snapshot of auto-swept unpaid payments
  damage_lines: DamageLine[]
  other_deductions: DamageLine[]
  total_deductions: string
  refund_amount: string
  gap_amount: string
  status: string
  refund_payment_id: string | null
  gap_payment_id: string | null
  gap_charge_failed: boolean
  gap_charge_failure_reason: string | null
  finalized_at: string | null
  finalized_by_user_id: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

const round2 = (n: number) => Math.round(n * 100) / 100
const sumLines = (lines: DamageLine[]) =>
  round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0))

// S180 / A1: shape of a single unpaid-balance line surfaced by the
// auto-sweep. Each row is a payments-table row (rent / utility /
// late_fee / fee with status pending or failed) that the deposit
// covers at finalize time. Returned alongside the existing
// damage_lines + other_deductions buckets so the UI can render a
// distinct "auto-pulled" section.
export interface UnpaidBalanceLine {
  payment_id:        string
  type:              string  // 'rent' | 'utility' | 'late_fee' | 'fee'
  amount:            number
  due_date:          string  // ISO date
  entry_description: string
  status:            'pending' | 'failed'
}

// S180 / A1 (S182 frontend): live re-pull of the auto-sweep lines.
// The deposit_returns row stores only the dollar total
// (unpaid_balance_amount); the line array isn't snapshotted because
// payment statuses can change between draft create and finalize.
// Always read fresh from the payments table — same posture as
// applyDeductionsToDraft. Excludes entry_description='DEPOSIT' so
// a prior gap-pending row from a different draft can't recursively
// roll back into a new deposit return.
export async function fetchUnpaidBalanceLines(leaseId: string): Promise<UnpaidBalanceLine[]> {
  const rows = await query<{
    id: string
    type: string
    amount: string
    due_date: string
    entry_description: string
    status: 'pending' | 'failed'
  }>(
    `SELECT id, type, amount::text, due_date::text, entry_description, status
       FROM payments
      WHERE lease_id = $1
        AND status IN ('pending', 'failed')
        AND entry_description != 'DEPOSIT'
        AND amount > 0
      ORDER BY due_date ASC, created_at ASC`,
    [leaseId],
  )
  return rows.map((r) => ({
    payment_id:        r.id,
    type:              r.type,
    amount:            Number(r.amount),
    due_date:          r.due_date,
    entry_description: r.entry_description,
    status:            r.status,
  }))
}

/**
 * Calculate the deposit-return preview without persisting. Returns
 * the suggested deductions + refund/gap split. Caller can pass
 * additional damage lines to see the running total.
 *
 * S180 / A1: also auto-pulls outstanding tenant balance items via
 * the unpaid-payments query. Rent + utility + late_fee + fee rows
 * with status pending/failed get summed into total_deductions.
 * Landlord can review/forgive at finalize time by removing the line
 * (TODO — that surface is the follow-on UI session).
 */
export async function calculateDepositReturn(
  leaseId: string,
  damageLines: DamageLine[] = [],
  otherDeductions: DamageLine[] = [],
): Promise<{
  total_deposit: number
  interest_accrued: number  // S188: statutory interest tenant is owed on top of deposit
  cleaning_fee_amount: number
  damage_lines_total: number
  other_deductions_total: number
  unpaid_balance_lines: UnpaidBalanceLine[]
  unpaid_balance_total: number
  total_deductions: number
  refund_amount: number
  gap_amount: number
  lease: { tenant_id: string; landlord_id: string }
  security_deposit_id: string | null
} | null> {
  const lease = await queryOne<{
    tenant_id: string
    landlord_id: string
  }>(
    `SELECT lt.tenant_id, l.landlord_id
       FROM leases l
       LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary'
      WHERE l.id = $1`,
    [leaseId],
  )
  if (!lease) return null

  const sd = await queryOne<{
    id: string; total_amount: string; collected_amount: string; interest_accrued: string;
  }>(
    `SELECT id, total_amount, collected_amount, interest_accrued
       FROM security_deposits WHERE lease_id = $1 LIMIT 1`,
    [leaseId],
  )

  // S196: deposit amount now comes from lease_fees (fee_type='security_deposit',
  // due_timing='move_in') when no security_deposits row exists. Pre-S196
  // the fallback was leases.security_deposit (column dropped).
  const leaseFeeDeposit = await queryOne<{ amount: string }>(
    `SELECT amount FROM lease_fees
      WHERE lease_id = $1
        AND fee_type = 'security_deposit'
        AND due_timing = 'move_in'
      LIMIT 1`,
    [leaseId],
  )
  // S262: deposit pool is `collected_amount` (what GAM actually holds in
  // gam_escrow), NOT `total_amount` (what was promised). Under S260,
  // FlexDeposit deposits live in gam_escrow throughout, so the pool at
  // lease-end equals collected_amount. Supersedence (S261) drives
  // collected_amount up over the lease by routing rent into unpaid
  // installments, so by lease-end the workflow normally has
  // collected_amount ≈ total_amount. When it doesn't (genuine default
  // through to the end), the landlord disbursement reflects reality —
  // they get what's actually in escrow, not what was promised.
  const totalDeposit = Number(sd?.collected_amount ?? sd?.total_amount ?? leaseFeeDeposit?.amount ?? 0)
  // S188: statutory interest accrued (state-hardcoded rates per S177
  // carve-out). Added to the available pool for refund — tenant gets
  // their deposit + interest minus deductions. Reduces gap_amount
  // when deductions exceed the principal.
  //
  // S241 policy lock: this field is non-zero ONLY when state law
  // mandates tenant interest. For states without statutory requirement,
  // depositInterest.ts skips accrual entirely and interest_accrued
  // stays 0 here — GAM keeps whatever yield it earned on the held
  // principal. No GAM-side ledger entry needed; the yield is implicit
  // in GAM's bank/platform-balance income.
  const interestAccrued = round2(Number(sd?.interest_accrued ?? 0))

  // S113-PhaseB: include BOTH move_out and other due_timings. Per Nic's
  // spec, every configured lease_fee not on a per-month or move_in path
  // should deduct from the deposit at lease end. Move_out covers
  // cleaning_fee; other covers early_termination_fee + other_fee. Damage
  // lines stay separate (landlord-entered judgment calls).
  const cleaningFees = await query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM lease_fees
      WHERE lease_id = $1 AND due_timing IN ('move_out', 'other')`,
    [leaseId],
  )
  const cleaningFeeAmount = Number(cleaningFees[0]?.total ?? 0)

  // S180 / A1: auto-sweep outstanding tenant balance items. Pulls
  // every unpaid payment row tied to this lease so the deposit
  // deduction covers them. Excludes entry_description='DEPOSIT' so a
  // prior deposit-return gap-pending row doesn't recursively roll back
  // into a new deposit return. Excludes status='processing' (in flight
  // — let it settle naturally) and 'settled'/'returned'/'paid_via_deposit'
  // (already accounted for).
  const unpaidRows = await query<{
    id: string
    type: string
    amount: string
    due_date: string
    entry_description: string
    status: 'pending' | 'failed'
  }>(
    `SELECT id, type, amount::text, due_date::text, entry_description, status
       FROM payments
      WHERE lease_id = $1
        AND status IN ('pending', 'failed')
        AND entry_description != 'DEPOSIT'
        AND amount > 0
      ORDER BY due_date ASC, created_at ASC`,
    [leaseId],
  )
  const unpaidBalanceLines: UnpaidBalanceLine[] = unpaidRows.map((r) => ({
    payment_id:        r.id,
    type:              r.type,
    amount:            Number(r.amount),
    due_date:          r.due_date,
    entry_description: r.entry_description,
    status:            r.status,
  }))
  const unpaidBalanceTotal = round2(unpaidBalanceLines.reduce((s, l) => s + l.amount, 0))

  const damageTotal = sumLines(damageLines)
  const otherTotal = sumLines(otherDeductions)
  const totalDeductions = round2(
    cleaningFeeAmount + damageTotal + otherTotal + unpaidBalanceTotal
  )

  // S188: tenant pool = principal + statutory interest. Refund draws
  // against this pool; gap fires only when deductions exceed it.
  const tenantPool = round2(totalDeposit + interestAccrued)
  const refund = round2(Math.max(0, tenantPool - totalDeductions))
  const gap = round2(Math.max(0, totalDeductions - tenantPool))

  return {
    total_deposit: totalDeposit,
    interest_accrued: interestAccrued,
    cleaning_fee_amount: cleaningFeeAmount,
    damage_lines_total: damageTotal,
    other_deductions_total: otherTotal,
    unpaid_balance_lines: unpaidBalanceLines,
    unpaid_balance_total: unpaidBalanceTotal,
    total_deductions: totalDeductions,
    refund_amount: refund,
    gap_amount: gap,
    lease,
    security_deposit_id: sd?.id ?? null,
  }
}

/**
 * Create-or-fetch the draft deposit-return for a lease. Idempotent —
 * if one exists, returns it (caller PATCHes to update). If none exists,
 * creates a draft with the auto-calculated cleaning_fee deduction.
 */
export async function createOrFetchDraft(
  leaseId: string,
): Promise<DepositReturnRow> {
  const existing = await queryOne<DepositReturnRow>(
    `SELECT * FROM deposit_returns WHERE lease_id = $1`,
    [leaseId],
  )
  if (existing) return existing

  const calc = await calculateDepositReturn(leaseId)
  if (!calc) throw new Error(`Lease ${leaseId} not found`)
  if (!calc.lease.tenant_id) throw new Error(`Lease ${leaseId} has no primary tenant`)

  const row = await queryOne<DepositReturnRow>(
    `INSERT INTO deposit_returns (
       lease_id, tenant_id, landlord_id, security_deposit_id,
       total_deposit, cleaning_fee_amount, unpaid_balance_amount,
       damage_lines, other_deductions,
       total_deductions, refund_amount, gap_amount
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       '[]'::jsonb, '[]'::jsonb,
       $8, $9, $10
     ) RETURNING *`,
    [
      leaseId,
      calc.lease.tenant_id,
      calc.lease.landlord_id,
      calc.security_deposit_id,
      calc.total_deposit,
      calc.cleaning_fee_amount,
      calc.unpaid_balance_total,
      calc.total_deductions,
      calc.refund_amount,
      calc.gap_amount,
    ],
  )
  return row!
}

/**
 * Update damage lines / other deductions / notes on a draft. Recalculates
 * totals. No-op if status is not 'draft'.
 */
export async function applyDeductionsToDraft(
  draftId: string,
  patch: { damageLines?: DamageLine[]; otherDeductions?: DamageLine[]; notes?: string },
): Promise<DepositReturnRow | null> {
  const current = await queryOne<DepositReturnRow>(
    `SELECT * FROM deposit_returns WHERE id = $1`,
    [draftId],
  )
  if (!current) return null
  if (current.status !== 'draft') {
    throw new Error(`Cannot edit deposit return in status ${current.status}`)
  }

  const damageLines = patch.damageLines ?? current.damage_lines
  const otherDeductions = patch.otherDeductions ?? current.other_deductions
  const notes = patch.notes !== undefined ? patch.notes : current.notes

  const damageTotal = sumLines(damageLines)
  const otherTotal = sumLines(otherDeductions)
  const cleaningFee = Number(current.cleaning_fee_amount)
  const totalDeposit = Number(current.total_deposit)

  // S180 / A1: re-pull live unpaid balance on every applyDeductions
  // pass. Between drafts being created and the landlord typing damage
  // lines, new payments could fail or settle. Always read fresh so
  // total_deductions reflects current reality.
  const unpaidRows = await query<{ amount: string }>(
    `SELECT amount::text
       FROM payments
      WHERE lease_id = $1
        AND status IN ('pending', 'failed')
        AND entry_description != 'DEPOSIT'
        AND amount > 0`,
    [current.lease_id],
  )
  const unpaidBalanceTotal = round2(unpaidRows.reduce((s, r) => s + Number(r.amount), 0))

  // S188: re-pull live interest_accrued in case the monthly cron has
  // run between draft creation and the landlord saving deductions.
  const sdRow = await queryOne<{ interest_accrued: string }>(
    `SELECT interest_accrued FROM security_deposits WHERE lease_id = $1 LIMIT 1`,
    [current.lease_id],
  )
  const interestAccrued = round2(Number(sdRow?.interest_accrued ?? 0))

  const totalDeductions = round2(cleaningFee + damageTotal + otherTotal + unpaidBalanceTotal)
  const tenantPool = round2(totalDeposit + interestAccrued)
  const refund = round2(Math.max(0, tenantPool - totalDeductions))
  const gap = round2(Math.max(0, tenantPool < totalDeductions ? totalDeductions - tenantPool : 0))

  const updated = await queryOne<DepositReturnRow>(
    `UPDATE deposit_returns
        SET damage_lines = $1::jsonb,
            other_deductions = $2::jsonb,
            unpaid_balance_amount = $3,
            total_deductions = $4,
            refund_amount = $5,
            gap_amount = $6,
            notes = $7,
            updated_at = NOW()
      WHERE id = $8
      RETURNING *`,
    [
      JSON.stringify(damageLines),
      JSON.stringify(otherDeductions),
      unpaidBalanceTotal,
      totalDeductions,
      refund,
      gap,
      notes,
      draftId,
    ],
  )
  return updated
}

/**
 * Finalize the deposit-return. Single transaction:
 *   1. Lock + verify draft status
 *   2. Compute final status (refund / gap / zero)
 *   3. Create payments row for refund OR gap
 *   4. Emit credit-ledger events
 *   5. Update deposit_returns + status
 *
 * Auto-charge of the gap is attempted post-commit (best-effort);
 * failure marks gap_charge_failed=TRUE and surfaces an admin alert
 * but doesn't roll back the finalize.
 */
export async function finalizeDepositReturn(
  draftId: string,
  finalizedByUserId: string,
): Promise<DepositReturnRow> {
  const client = await getClient()
  let row: DepositReturnRow
  let chargeAttempt: { gapPaymentId: string | null; tenantStripeCustomerId: string | null; gapAmount: number } | null = null
  let portabilityExecuteDepositId: string | null = null
  try {
    await client.query('BEGIN')

    const cur = await client.query<DepositReturnRow>(
      `SELECT * FROM deposit_returns WHERE id = $1 FOR UPDATE`,
      [draftId],
    )
    if (cur.rows.length === 0) throw new Error('Draft not found')
    row = cur.rows[0]
    if (row.status !== 'draft') throw new Error(`Already finalized: ${row.status}`)

    // S180 / A1: re-query live unpaid payments inside the finalize tx
    // and refresh totals. Between draft create / last applyDeductions
    // and now, the unpaid set could have shifted (a payment settled,
    // a new one failed). Always finalize against the current state.
    // FOR UPDATE locks the rows so a concurrent webhook settle can't
    // race the deposit-sweep write.
    const sweptRows = await client.query<{ id: string; amount: string }>(
      `SELECT id, amount::text
         FROM payments
        WHERE lease_id = $1
          AND status IN ('pending', 'failed')
          AND entry_description != 'DEPOSIT'
          AND amount > 0
        FOR UPDATE`,
      [row.lease_id],
    )
    const sweptPaymentIds = sweptRows.rows.map((r) => r.id)
    const liveUnpaidBalance = round2(
      sweptRows.rows.reduce((s, r) => s + Number(r.amount), 0)
    )

    // Refresh row totals using live unpaid balance + the stored
    // landlord-controlled lines (cleaning_fee / damage_lines / other).
    // S188: also re-pull live interest_accrued in case the monthly
    // accrual cron has run since the draft was created.
    const cleaningFeeAmount = Number(row.cleaning_fee_amount)
    const damageTotal       = sumLines(row.damage_lines)
    const otherTotal        = sumLines(row.other_deductions)
    const liveTotalDeductions = round2(
      cleaningFeeAmount + damageTotal + otherTotal + liveUnpaidBalance
    )
    const totalDeposit = Number(row.total_deposit)
    const sdInterest = await client.query<{ interest_accrued: string }>(
      `SELECT interest_accrued FROM security_deposits WHERE lease_id = $1 LIMIT 1`,
      [row.lease_id],
    )
    const liveInterestAccrued = round2(Number(sdInterest.rows[0]?.interest_accrued ?? 0))
    const liveTenantPool = round2(totalDeposit + liveInterestAccrued)
    const liveRefund = round2(Math.max(0, liveTenantPool - liveTotalDeductions))
    const liveGap    = round2(Math.max(0, liveTotalDeductions - liveTenantPool))

    if (sweptPaymentIds.length > 0) {
      await client.query(
        `UPDATE payments
            SET status = 'paid_via_deposit',
                settled_at = NOW(),
                notes = LEFT(
                  COALESCE(notes || E'\\n', '') ||
                  'S180: paid via security deposit on deposit_return ' || $2,
                  2000
                )
          WHERE id = ANY($1::uuid[])`,
        [sweptPaymentIds, draftId],
      )
    }

    // Update local references so the rest of the finalize logic (refund
    // / gap branches, ledger emission) works against the live numbers.
    row = {
      ...row,
      unpaid_balance_amount: String(liveUnpaidBalance),
      total_deductions:      String(liveTotalDeductions),
      refund_amount:         String(liveRefund),
      gap_amount:            String(liveGap),
    }
    const refund = liveRefund
    const gap    = liveGap

    // Pull lease unit + tenant context for credit-event evidence + payments row.
    const ctx = await client.query<{ unit_id: string; stripe_customer_id: string | null }>(
      `SELECT l.unit_id, t.stripe_customer_id
         FROM leases l
         JOIN tenants t ON t.id = $2
        WHERE l.id = $1`,
      [row.lease_id, row.tenant_id],
    )
    const unitId = ctx.rows[0]?.unit_id
    const tenantStripeCustomerId = ctx.rows[0]?.stripe_customer_id ?? null

    let nextStatus: 'sent_refund' | 'sent_gap' | 'sent_zero' | 'sent_carried_forward'
    let refundPaymentId: string | null = null
    let gapPaymentId: string | null = null

    // S255: deposit portability branch. If the security_deposits row
    // has portability_status='authorized', the tenant has signed away
    // their refund to carry the deposit forward to their next GAM
    // lease. Landlord A's unpaid-balance sweep already ran above
    // (priority claim); the remaining refund pool transfers to the
    // target lease instead of being paid out.
    const portabilityRow = await client.query<{ id: string }>(
      `SELECT id FROM security_deposits
        WHERE lease_id = $1 AND portability_status = 'authorized'
        LIMIT 1`,
      [row.lease_id],
    )
    const portabilityAuthorized = portabilityRow.rows.length > 0
    if (portabilityAuthorized) {
      portabilityExecuteDepositId = portabilityRow.rows[0].id
    }

    if (portabilityAuthorized) {
      nextStatus = 'sent_carried_forward'
      // No refund row, no gap row — the post-sweep balance moves to
      // the new lease. The executeDepositPortability call happens
      // outside this transaction (see post-commit block below).
    } else if (refund > 0 && gap === 0) {
      nextStatus = 'sent_refund'
      // Refund payment row — represents an obligation FROM landlord
      // TO tenant. status='pending' until the disbursement path fires
      // (landlord-side withdrawal). Recorded against the lease for
      // audit; entry_description='DEPOSIT' so it appears on the
      // tenant's payments tab as a credit.
      const ins = await client.query<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description, due_date, notes
         ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'DEPOSIT', CURRENT_DATE, $6)
         RETURNING id`,
        [
          row.landlord_id,
          row.tenant_id,
          row.lease_id,
          unitId,
          -refund, // negative = landlord owes tenant
          `Deposit refund for lease ${row.lease_id} — ${(row.damage_lines as any[]).length} damage line(s) + cleaning fee deducted`,
        ],
      )
      refundPaymentId = ins.rows[0].id
    } else if (gap > 0) {
      nextStatus = 'sent_gap'
      // Gap payment row — tenant OWES this. We try to auto-charge
      // post-commit; for now record as pending.
      const ins = await client.query<{ id: string }>(
        `INSERT INTO payments (
           landlord_id, tenant_id, lease_id, unit_id,
           type, amount, status, entry_description, due_date, notes
         ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'DEPOSIT', CURRENT_DATE, $6)
         RETURNING id`,
        [
          row.landlord_id,
          row.tenant_id,
          row.lease_id,
          unitId,
          gap,
          `Move-out balance owed for lease ${row.lease_id} — deposit was insufficient`,
        ],
      )
      gapPaymentId = ins.rows[0].id
      chargeAttempt = { gapPaymentId, tenantStripeCustomerId, gapAmount: gap }
    } else {
      nextStatus = 'sent_zero'
    }

    // S193: deposit_returned_* events use principal-only thresholds.
    // The "full" case is principal fully refunded (refund >= totalDeposit);
    // any interest paid out on top is recorded separately via
    // deposit_interest_paid below. Pre-S193 the threshold accidentally
    // included interest because tenantPool = principal + interest was
    // the comparator.
    //
    // S255: skip the deposit_returned_* + tenancy_ended_with_balance
    // emits entirely on the carry-forward path. The deposit wasn't
    // "returned" to the tenant — it's continuing as the tenant's
    // collateral at the next lease. (Future: a distinct event type
    // like deposit_carried_forward could record this transition for
    // credit-ledger continuity. Out of scope this session.)
    const principalRefunded = round2(Math.min(refund, totalDeposit))
    if (portabilityAuthorized) {
      // Skip return/balance emits.
    } else if (principalRefunded > 0 && principalRefunded === totalDeposit) {
      await emitDepositEvent(client, row, 'deposit_returned_full', liveInterestAccrued)
    } else if (principalRefunded > 0 && principalRefunded < totalDeposit) {
      await emitDepositEvent(client, row, 'deposit_returned_partial', liveInterestAccrued)
    } else if (principalRefunded === 0 && gap === 0) {
      await emitDepositEvent(client, row, 'deposit_returned_zero', liveInterestAccrued)
    }
    if (gap > 0 && !portabilityAuthorized) {
      // Gap fires both deposit_returned_zero AND tenancy_ended_with_balance:
      // the deposit was wiped (zero refunded) AND there's outstanding balance.
      await emitDepositEvent(client, row, 'deposit_returned_zero', liveInterestAccrued)
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: row.tenant_id,
          eventType: 'tenancy_ended_with_balance',
          eventData: {
            lease_id: row.lease_id,
            expected_total: Number(row.total_deductions),
            received_total: totalDeposit,
            delta: gap,
            settlement_status: 'unpaid',
            source: 'deposit_return',
          },
          occurredAt: new Date(),
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: { deposit_return_id: row.id, lease_id: row.lease_id },
          dimensionTags: ['payment_reliability', 'tenancy_stability'],
          networkVisibility: 'visible_to_gam_network',
        },
        client,
      )
    }

    // S193: distinct credit-ledger event for statutory deposit interest
    // settlement at lease end. Fires whenever interest_accrued > 0 so the
    // audit trail captures what happened to the interest portion (paid
    // out vs absorbed by deductions). Separate from deposit_returned_*
    // so reports can distinguish principal-refund flows from
    // statutory-interest-payout flows.
    if (liveInterestAccrued > 0) {
      // interest_paid_to_tenant: how much of the interest the tenant
      // actually received as part of the refund. Refund pool draws from
      // tenant_pool = principal + interest in any order; for accounting
      // clarity, treat interest as paid first up to refund amount.
      const interestPaidToTenant = round2(Math.min(liveInterestAccrued, refund))
      const interestAppliedToDeductions = round2(liveInterestAccrued - interestPaidToTenant)

      // Pull rate context from the most recent accrual row so the event
      // records what rate was in effect at lease end.
      const lastAccrual = await client.query<{
        annual_rate_pct: string
        state_code:      string
        accrual_count:   string
      }>(
        `SELECT annual_rate_pct::text, state_code,
                (SELECT COUNT(*)::text FROM security_deposit_interest_accruals
                  WHERE security_deposit_id = (
                    SELECT id FROM security_deposits WHERE lease_id = $1 LIMIT 1
                  )) AS accrual_count
           FROM security_deposit_interest_accruals
          WHERE security_deposit_id = (
            SELECT id FROM security_deposits WHERE lease_id = $1 LIMIT 1
          )
          ORDER BY accrual_month DESC
          LIMIT 1`,
        [row.lease_id],
      )
      const rateCtx = lastAccrual.rows[0]

      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: row.tenant_id,
          eventType: 'deposit_interest_paid',
          eventData: {
            lease_id:                       row.lease_id,
            deposit_return_id:              row.id,
            interest_accrued_total:         liveInterestAccrued,
            interest_paid_to_tenant:        interestPaidToTenant,
            interest_applied_to_deductions: interestAppliedToDeductions,
            principal_amount:               totalDeposit,
            rate_pct_at_lease_end:          rateCtx ? parseFloat(rateCtx.annual_rate_pct) : null,
            state_code:                     rateCtx?.state_code ?? null,
            accrual_months_count:           rateCtx ? parseInt(rateCtx.accrual_count, 10) : 0,
          },
          occurredAt: new Date(),
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: {
            deposit_return_id: row.id,
            lease_id:          row.lease_id,
            source:            'deposit_return_finalize',
          },
          dimensionTags: ['property_care', 'tenancy_stability'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    }

    const finalized = await client.query<DepositReturnRow>(
      `UPDATE deposit_returns
          SET status = $1,
              refund_payment_id = $2,
              gap_payment_id = $3,
              unpaid_balance_amount = $4,
              total_deductions = $5,
              refund_amount = $6,
              gap_amount = $7,
              finalized_at = NOW(),
              finalized_by_user_id = $8,
              updated_at = NOW()
        WHERE id = $9
        RETURNING *`,
      [
        nextStatus,
        refundPaymentId,
        gapPaymentId,
        liveUnpaidBalance,
        liveTotalDeductions,
        liveRefund,
        liveGap,
        finalizedByUserId,
        draftId,
      ],
    )
    row = finalized.rows[0]

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // Post-commit gap auto-charge (best-effort).
  if (chargeAttempt) {
    try {
      await attemptGapAutoCharge(draftId, chargeAttempt)
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][gap-charge]')
    }
  }

  // S255: post-commit portability execution. The deposit-return
  // transaction above flipped status='sent_carried_forward'; this
  // is where the security_deposits row actually re-points to the
  // new lease + (when held_by='landlord') flags admin for the
  // physical funds transfer. Outside the tx because
  // executeDepositPortability runs its own row-lock.
  if (portabilityExecuteDepositId) {
    try {
      const { executeDepositPortability } = await import('./depositPortability')
      await executeDepositPortability({ depositId: portabilityExecuteDepositId })
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][portability-execute]')
      // Don't throw — the deposit_returns row is already finalized
      // with sent_carried_forward; the portability execution can be
      // retried by an admin tool. Logging is enough for ops surfacing.
    }
  }

  // S262: post-commit landlord disbursement Transfer. Under S260
  // FlexDeposit deposits live in gam_escrow throughout the lease
  // (held_by='gam_escrow'); the landlord never received any deposit
  // funds at move-in. Lease-end finalize is when the landlord's share
  // moves from GAM platform balance to their Connect account.
  // Skipped when held_by='landlord' (legacy / non-FlexDeposit deposits
  // — landlord already has the money), or when portability authorized
  // (deposit re-points to next lease, no disbursement here).
  if (!portabilityExecuteDepositId) {
    try {
      await fireLandlordDisbursementTransfer(row)
    } catch (e) {
      logger.error({ err: e, ctx: draftId }, '[deposit-return][landlord-disbursement]')
    }
  }

  return row
}

/**
 * S262: fire the Connect Transfer for the landlord's deposit-return
 * share. Amount = collected_amount + interest_accrued - refund_amount
 * (the portion of escrowed funds that goes to the landlord rather
 * than back to the tenant). Idempotency-keyed per deposit_return id.
 * No-op when held_by='landlord' (landlord already holds the funds);
 * admin-notified when the landlord lacks a Connect account.
 */
async function fireLandlordDisbursementTransfer(row: DepositReturnRow): Promise<void> {
  const dep = await queryOne<{
    held_by: 'gam_escrow' | 'landlord' | null;
    collected_amount: string;
    interest_accrued: string;
    landlord_user_id: string | null;
    connect_account: string | null;
  }>(
    `SELECT sd.held_by,
            sd.collected_amount::text,
            sd.interest_accrued::text,
            usr.id AS landlord_user_id,
            usr.stripe_connect_account_id AS connect_account
       FROM security_deposits sd
       JOIN leases    l   ON l.id  = sd.lease_id
       JOIN landlords ll  ON ll.id = l.landlord_id
       JOIN users     usr ON usr.id = ll.user_id
      WHERE sd.lease_id = $1
      LIMIT 1`,
    [row.lease_id],
  )
  if (!dep) return
  if (dep.held_by !== 'gam_escrow') return  // legacy path — landlord already has funds.

  const collected = Number(dep.collected_amount)
  const interest  = Number(dep.interest_accrued)
  const refund    = Number(row.refund_amount)
  const disbursement = round2(Math.max(0, collected + interest - refund))
  if (disbursement <= 0) return

  if (!dep.connect_account) {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'deposit_disbursement_pending_no_connect',
      title:    `Deposit disbursement waiting — landlord has no Connect account`,
      body:     `Deposit return ${row.id} finalized for $${disbursement.toFixed(2)} to landlord but no Connect account on file. Funds remain on platform balance.`,
      context:  { deposit_return_id: row.id, lease_id: row.lease_id, amount: disbursement },
    })
    return
  }

  try {
    const stripe = getStripe()
    await stripe.transfers.create(
      {
        amount:      Math.round(disbursement * 100),
        currency:    'usd',
        destination: dep.connect_account,
        description: `Deposit disbursement — lease ${row.lease_id}`,
        metadata: {
          gam_purpose:           'deposit_return_landlord_disbursement',
          gam_deposit_return_id: row.id,
          gam_lease_id:          row.lease_id,
        },
      },
      { idempotencyKey: `deposit_disb_${row.id}` },
    )
  } catch (e: any) {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'deposit_disbursement_transfer_failed',
      title:    `Deposit disbursement Transfer failed — return ${row.id}`,
      body:     `Stripe Transfer for $${disbursement.toFixed(2)} to landlord Connect ${dep.connect_account} failed: ${e?.message ?? e}.`,
      context:  { deposit_return_id: row.id, lease_id: row.lease_id, amount: disbursement, connect_account: dep.connect_account },
    })
  }
}

async function emitDepositEvent(
  client: PoolClient,
  row: DepositReturnRow,
  eventType:
    | 'deposit_returned_full'
    | 'deposit_returned_partial'
    | 'deposit_returned_zero',
  interestAccrued: number = 0,  // S193: includes interest in audit context
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: row.tenant_id,
      eventType,
      eventData: {
        lease_id: row.lease_id,
        deposit_return_id: row.id,
        total_deposit: Number(row.total_deposit),
        interest_accrued: interestAccrued,
        total_deductions: Number(row.total_deductions),
        refund_amount: Number(row.refund_amount),
        gap_amount: Number(row.gap_amount),
      },
      occurredAt: new Date(),
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { deposit_return_id: row.id },
      dimensionTags: ['property_care', 'tenancy_stability'],
      networkVisibility:
        eventType === 'deposit_returned_full'
          ? 'visible_to_current_landlord'
          : 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Attempt to auto-charge the gap via the tenant's on-file Stripe
 * customer. On success: leaves the gap_payment in 'pending' (the
 * Stripe payment_intent.succeeded webhook will flip it to settled).
 * On failure: marks gap_charge_failed=TRUE on the deposit_returns
 * row + creates an admin notification. The pending payment row
 * stays — landlord can pursue collection.
 */
async function attemptGapAutoCharge(
  draftId: string,
  args: {
    gapPaymentId: string | null
    tenantStripeCustomerId: string | null
    gapAmount: number
  },
): Promise<void> {
  if (!args.gapPaymentId) return

  if (!args.tenantStripeCustomerId) {
    await markGapChargeFailed(draftId, 'No Stripe customer id on file')
    return
  }

  // Lazy-import Stripe to avoid loading the SDK in non-charge code paths.
  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' as any })

  // Read the customer's default payment method.
  let paymentMethodId: string | null = null
  try {
    const customer = await stripe.customers.retrieve(args.tenantStripeCustomerId)
    if (customer && !(customer as any).deleted) {
      const c = customer as any
      paymentMethodId =
        c.invoice_settings?.default_payment_method ??
        c.default_source ??
        null
    }
  } catch (e) {
    await markGapChargeFailed(draftId, `Stripe customer lookup failed: ${e instanceof Error ? e.message : String(e)}`)
    return
  }

  if (!paymentMethodId) {
    await markGapChargeFailed(draftId, 'No default payment method on file')
    return
  }

  try {
    await stripe.paymentIntents.create({
      amount: Math.round(args.gapAmount * 100),
      currency: 'usd',
      customer: args.tenantStripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        gam_payment_id: args.gapPaymentId,
        gam_kind: 'deposit_return_gap',
      },
    })
    // Success: PaymentIntent webhook will flip the GAM payment row
    // to 'settled'. We don't need to update anything else here.
  } catch (e) {
    await markGapChargeFailed(
      draftId,
      `Stripe charge failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

async function markGapChargeFailed(draftId: string, reason: string): Promise<void> {
  await query(
    `UPDATE deposit_returns
        SET gap_charge_failed = TRUE,
            gap_charge_failure_reason = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [reason, draftId],
  )
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'deposit_return_gap_charge_failed',
      title: 'Move-out gap auto-charge failed',
      body: `Deposit-return ${draftId} could not auto-charge the tenant's on-file payment method. Reason: ${reason}. Landlord can pursue manually.`,
      context: { deposit_return_id: draftId, reason },
    })
  } catch (e) {
    logger.error({ err: e }, '[deposit-return][gap-fail-alert]')
  }
}
