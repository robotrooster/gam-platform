// apps/api/src/jobs/lateFees.ts
// S26b: Late fee detection engine.
//
// Cron firing model (S26b-tz): registered per-property-timezone via
// timezoneCronManager. Each timezone fires 6 times during 00:00-00:59 local
// (at minutes :00, :10, :20, :30, :40, :50). Outside that window, no cron
// fires for that timezone — saves compute, no global polling.
//
// Engine reads invoices for properties in the firing timezone only,
// generates initial + accrual late_fee child rows attached via invoice_id.
// Cap is total-inclusive; cap-edge writes a partial row of exactly the
// remaining amount, then stops accruing (locked decision: cap-edge partial).
// Idempotent via ux_payments_late_fee_idempotent partial unique index —
// the 6 firings per timezone per night are safe; first writes, rest no-op.

import type { PoolClient } from 'pg'
import { getClient } from '../db'
import {
  lateFeeStartDate,
  nextAccrualDate,
  computeLateFeeAmount,
  capRemaining,
  type LateFeeKind,
  type LateFeeAccrualPeriod,
} from '@gam/shared'
import { registerEngine } from './timezoneCronManager'
import { logger } from '../lib/logger'
import { resolveLateFeePolicyForUnit, type ResolvedLateFeePolicy } from '../services/lateFeePolicy'

interface QualifyingInvoice {
  invoice_id: number
  lease_id: number
  landlord_id: string
  unit_id: string | null
  resolved_unit_id: string
  tenant_id: string | null
  due_date: string
  today_local: string
  late_fee_grace_days: number
  late_fee_initial_type: LateFeeKind
  late_fee_initial_amount: string
  late_fee_accrual_type: LateFeeKind | null
  late_fee_accrual_amount: string | null
  late_fee_accrual_period: LateFeeAccrualPeriod | null
  late_fee_cap_type: LateFeeKind | null
  late_fee_cap_amount: string | null
}

export interface LateFeeResult {
  invoicesScanned: number
  rowsWritten: number
  capsHit: number
  errors: { invoice_id: number; error: string }[]
}

/**
 * Run the late fee engine for invoices on properties in the given timezone.
 * Called by per-tz cron at midnight local (and the 5 follow-up :10/:20/:30/
 * :40/:50 ticks). SQL scopes to properties.timezone = $1.
 */
export async function generateLateFeesForTimezone(
  tz: string
): Promise<LateFeeResult> {
  const result: LateFeeResult = {
    invoicesScanned: 0,
    rowsWritten: 0,
    capsHit: 0,
    errors: [],
  }

  const client = await getClient()
  try {
    // Filter:
    //   - invoice in pending/partial (settled/void excluded)
    //   - lease has late_fee_enabled and initial_amount configured
    //   - property is in the specified timezone
    //   - property-local today has crossed (due_date + grace_days)
    const { rows: invoices } = await client.query<QualifyingInvoice>(`
      SELECT
        i.id AS invoice_id,
        i.lease_id,
        i.landlord_id,
        i.unit_id,
        u.id AS resolved_unit_id,
        i.tenant_id,
        i.due_date::text AS due_date,
        (NOW() AT TIME ZONE p.timezone)::date::text AS today_local,
        COALESCE(l.late_fee_grace_days, 5) AS late_fee_grace_days,
        l.late_fee_initial_type,
        l.late_fee_initial_amount::text AS late_fee_initial_amount,
        l.late_fee_accrual_type,
        l.late_fee_accrual_amount::text AS late_fee_accrual_amount,
        l.late_fee_accrual_period,
        l.late_fee_cap_type,
        l.late_fee_cap_amount::text AS late_fee_cap_amount
      FROM invoices i
      JOIN leases l ON l.id = i.lease_id
      JOIN units u ON u.id = COALESCE(i.unit_id, l.unit_id)
      JOIN properties p ON p.id = u.property_id
      WHERE p.timezone = $1
        AND i.status IN ('pending', 'partial')
        AND l.late_fee_enabled = true
        AND l.late_fee_initial_amount IS NOT NULL
        AND (NOW() AT TIME ZONE p.timezone)::date
            >= (i.due_date + (COALESCE(l.late_fee_grace_days, 5) || ' days')::interval)::date
        -- S537 (Nic): late fees track UNPAID BASE CHARGES, never themselves.
        -- (a) Stop accruing once every non-late-fee child is settled — a
        --     partial invoice whose only open child is the late fee itself
        --     must not snowball daily forever.
        AND EXISTS (
          SELECT 1 FROM payments pb
           WHERE pb.invoice_id = i.id AND pb.type != 'late_fee'
             AND pb.status NOT IN ('settled')
        )
        -- (b) Postmark rule: an in-flight payment (ACH 'processing' takes
        --     2-4 business days) counts as paid on its initiation date. No
        --     fee while it clears; if it FAILS the child flips to a
        --     non-settled status and the next nightly run back-fills every
        --     missed tick since the due date — fees land retroactively,
        --     which is the correct outcome for a bounced payment.
        AND NOT EXISTS (
          SELECT 1 FROM payments pf
           WHERE pf.invoice_id = i.id AND pf.type != 'late_fee'
             AND pf.status = 'processing'
        )
    `, [tz])

    result.invoicesScanned = invoices.length

    for (const inv of invoices) {
      try {
        await client.query('BEGIN')
        await processInvoice(client, inv, result)
        await client.query('COMMIT')
      } catch (e: unknown) {
        await client.query('ROLLBACK').catch(() => {})
        const msg = e instanceof Error ? e.message : String(e)
        result.errors.push({ invoice_id: inv.invoice_id, error: msg })
        logger.error({ err: e, tz, invoice_id: inv.invoice_id }, '[LateFees] invoice error')
      }
    }
  } finally {
    client.release()
  }

  return result
}

/**
 * S537 (Nic): uniformity enforcement. The signed lease is the billing
 * source (lease-is-law) but the CURRENT (property, unit_type) policy is a
 * hard ceiling: total late fees billed on an invoice never exceed what the
 * class policy itself would have produced by today. Cumulative comparison
 * (not per-field) so mismatched types/periods/grace between an imported
 * lease and the policy always resolve tenant-favorably:
 *   billed_total <= min(lease_schedule(today), policy_schedule(today)).
 * No policy (explicit no-fee decision, undecided class, or master toggle
 * off) => budget 0 => nothing bills, regardless of what the lease says.
 */
function policyScheduleTotal(
  policy: ResolvedLateFeePolicy,
  rentAmount: number,
  dueDate: string,
  today: string,
): number {
  const graceDays = policy.late_fee_grace_days ?? 5
  const initialDate = lateFeeStartDate(dueDate, graceDays)
  if (today < initialDate) return 0
  let total = computeLateFeeAmount(
    policy.late_fee_initial_type, Number(policy.late_fee_initial_amount), rentAmount)
  if (policy.late_fee_accrual_type !== null &&
      policy.late_fee_accrual_amount !== null &&
      policy.late_fee_accrual_period !== null) {
    const MAX_OCCURRENCES = 5000
    for (let occ = 1; occ <= MAX_OCCURRENCES; occ++) {
      const tickDate = nextAccrualDate(dueDate, graceDays, policy.late_fee_accrual_period, occ)
      if (tickDate > today) break
      total += computeLateFeeAmount(
        policy.late_fee_accrual_type, Number(policy.late_fee_accrual_amount), rentAmount)
    }
  }
  if (policy.late_fee_cap_amount !== null) {
    const capTotal = computeLateFeeAmount(
      policy.late_fee_cap_type ?? 'flat', Number(policy.late_fee_cap_amount), rentAmount)
    total = Math.min(total, capTotal)
  }
  return total
}

async function processInvoice(
  client: PoolClient,
  inv: QualifyingInvoice,
  result: LateFeeResult
): Promise<void> {
  const today = inv.today_local

  const { rows: rentRows } = await client.query<{ amount: string }>(`
    SELECT amount::text AS amount
    FROM payments
    WHERE invoice_id = $1 AND type = 'rent'
    LIMIT 1
  `, [inv.invoice_id])
  const rentAmount = rentRows.length > 0 ? Number(rentRows[0].amount) : 0

  // S537 policy ceiling — resolve the class policy and compute its budget.
  const policy = await resolveLateFeePolicyForUnit(inv.resolved_unit_id, client)
  const policyBudget = policy ? policyScheduleTotal(policy, rentAmount, inv.due_date, today) : 0
  if (policyBudget <= 0) return

  const { rows: existingFees } = await client.query<{ amount: string; due_date: string }>(`
    SELECT amount::text AS amount, due_date::text AS due_date
    FROM payments
    WHERE invoice_id = $1
      AND type = 'late_fee'
      AND status IN ('pending', 'processing', 'settled')
    ORDER BY due_date ASC
  `, [inv.invoice_id])
  let existingSum = existingFees.reduce((s, r) => s + Number(r.amount), 0)
  const existingDates = new Set(existingFees.map(r => r.due_date))

  const capKind = inv.late_fee_cap_type
  const capAmt = inv.late_fee_cap_amount !== null ? Number(inv.late_fee_cap_amount) : null
  let remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)
  let remainingPolicy = policyBudget - existingSum

  if (capKind !== null && remaining <= 0) {
    return
  }
  if (remainingPolicy <= 0) return

  const graceDays = inv.late_fee_grace_days
  const initialDate = lateFeeStartDate(inv.due_date, graceDays)

  if (!existingDates.has(initialDate)) {
    const rawInitial = computeLateFeeAmount(
      inv.late_fee_initial_type,
      Number(inv.late_fee_initial_amount),
      rentAmount
    )
    let initialAmt = rawInitial
    let capHitOnInitial = false
    if (capKind !== null && initialAmt > remaining) {
      initialAmt = remaining
      capHitOnInitial = true
    }
    if (initialAmt > remainingPolicy) initialAmt = remainingPolicy // S537 ceiling
    if (initialAmt > 0) {
      await insertLateFeeRow(client, inv, initialDate, initialAmt)
      result.rowsWritten += 1
      existingSum += initialAmt
      existingDates.add(initialDate)
      remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)
      remainingPolicy = policyBudget - existingSum
      if (capHitOnInitial) {
        result.capsHit += 1
        return
      }
      if (remainingPolicy <= 0) return
    }
  }

  if (
    inv.late_fee_accrual_type === null ||
    inv.late_fee_accrual_amount === null ||
    inv.late_fee_accrual_period === null
  ) {
    return
  }

  const accrualKind: LateFeeKind = inv.late_fee_accrual_type
  const accrualAmt = Number(inv.late_fee_accrual_amount)
  const period: LateFeeAccrualPeriod = inv.late_fee_accrual_period

  const MAX_OCCURRENCES = 5000
  for (let occ = 1; occ <= MAX_OCCURRENCES; occ++) {
    const tickDate = nextAccrualDate(inv.due_date, graceDays, period, occ)
    if (tickDate > today) break
    if (existingDates.has(tickDate)) continue

    const rawTick = computeLateFeeAmount(accrualKind, accrualAmt, rentAmount)
    if (rawTick <= 0) break

    let tickAmt = rawTick
    let capHit = false
    if (capKind !== null && tickAmt > remaining) {
      tickAmt = remaining
      capHit = true
    }
    if (tickAmt > remainingPolicy) tickAmt = remainingPolicy // S537 ceiling
    if (tickAmt <= 0) break

    await insertLateFeeRow(client, inv, tickDate, tickAmt)
    result.rowsWritten += 1
    existingSum += tickAmt
    existingDates.add(tickDate)
    remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)
    remainingPolicy = policyBudget - existingSum

    if (capHit) {
      result.capsHit += 1
      break
    }
    if (remainingPolicy <= 0) break
  }
}

async function insertLateFeeRow(
  client: PoolClient,
  inv: QualifyingInvoice,
  dueDate: string,
  amount: number
): Promise<void> {
  const res = await client.query(`
    INSERT INTO payments (
      landlord_id, unit_id, lease_id, tenant_id,
      type, amount, status, entry_description,
      due_date, invoice_id
    ) VALUES (
      $1, $2, $3, $4,
      'late_fee', $5, 'pending', 'LATEFEE',
      $6, $7
    )
    ON CONFLICT (invoice_id, due_date)
      WHERE type = 'late_fee'
        AND status IN ('pending', 'processing', 'settled')
    DO NOTHING
    RETURNING id
  `, [
    inv.landlord_id,
    inv.unit_id,
    inv.lease_id,
    inv.tenant_id,
    amount,
    dueDate,
    inv.invoice_id,
  ])

  // S542: a fresh late fee is a fixed-income-timing indicator — ask
  // the tenant privately whether FlexPay would prevent the next one.
  // Own pool connection + never throws; fee generation must not care.
  if ((res.rowCount ?? 0) > 0 && inv.tenant_id) {
    const { maybeCreateQuestionnaire } = await import('../services/tenantQuestionnaires')
    await maybeCreateQuestionnaire(inv.tenant_id, 'late_fee_fixed_income')
  }
}

/**
 * Register the late-fee engine with the timezone cron manager.
 * Cron expression: minutes 0,10,20,30,40,50 of hour 0 in property timezone.
 * (6 firings per timezone per night, all within 00:00-00:59 local.)
 */
export function registerLateFeeEngine(): void {
  registerEngine('lateFees', {
    cronExpr: '0,10,20,30,40,50 0 * * *',
    handler: async (tz: string) => {
      const r = await generateLateFeesForTimezone(tz)
      if (r.invoicesScanned > 0 || r.errors.length > 0) {
        logger.info({ tz, scanned: r.invoicesScanned, wrote: r.rowsWritten, caps_hit: r.capsHit, errors: r.errors.length }, '[LateFees] scan complete')
      }
    },
    label: 'Late fees',
  })
}
