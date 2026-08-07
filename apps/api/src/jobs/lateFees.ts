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
  type LateFeeAccrualFrom,
} from '@gam/shared'
import { registerEngine } from './timezoneCronManager'
import { logger } from '../lib/logger'

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
  late_fee_accrual_from: LateFeeAccrualFrom
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
 * The qualifying-invoice SELECT, shared by the nightly per-timezone cron and
 * the on-demand single-invoice path (post-settlement reversal reopen). The
 * caller supplies the row filter ($1): the cron filters by property timezone,
 * the reopen path by invoice id. Everything after the filter is identical so
 * both qualify invoices the same way — grace crossed, lease late-fee
 * configured, an unpaid non-late-fee base charge exists, none in-flight.
 */
function qualifyingInvoicesSql(rowFilter: string): string {
  return `
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
        COALESCE(l.late_fee_accrual_from, 'grace_end') AS late_fee_accrual_from,
        l.late_fee_cap_type,
        l.late_fee_cap_amount::text AS late_fee_cap_amount
      FROM invoices i
      JOIN leases l ON l.id = i.lease_id
      JOIN units u ON u.id = COALESCE(i.unit_id, l.unit_id)
      JOIN properties p ON p.id = u.property_id
      WHERE ${rowFilter}
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
        --     which is the correct outcome for a bounced payment (and for a
        --     post-settlement reversal, which flips 'settled' → 'returned').
        AND NOT EXISTS (
          SELECT 1 FROM payments pf
           WHERE pf.invoice_id = i.id AND pf.type != 'late_fee'
             AND pf.status = 'processing'
        )
  `
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
    const { rows: invoices } = await client.query<QualifyingInvoice>(
      qualifyingInvoicesSql('p.timezone = $1'), [tz]
    )

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
 * S561: on-demand late-fee (re)generation for a SINGLE invoice. Called when a
 * post-settlement payment reversal reopens an invoice
 * (services/paymentReversal.ts) — runs the identical qualifying logic +
 * processInvoice as the nightly cron, so the reopened invoice immediately
 * back-fills every late-fee tick retroactively to the original due date ("as
 * if the payment never happened") instead of waiting for the next nightly run.
 * No-op if the invoice doesn't qualify (grace not crossed, no late-fee config,
 * nothing unpaid, an in-flight retry, etc.).
 */
export async function generateLateFeesForInvoice(invoiceId: string): Promise<LateFeeResult> {
  const result: LateFeeResult = { invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] }
  const client = await getClient()
  try {
    const { rows: invoices } = await client.query<QualifyingInvoice>(
      qualifyingInvoicesSql('i.id = $1'), [invoiceId]
    )
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
        logger.error({ err: e, invoice_id: inv.invoice_id }, '[LateFees] on-demand invoice error')
      }
    }
  } finally {
    client.release()
  }
  return result
}

// S558 (Nic): the S537 policy-ceiling helper (policyScheduleTotal) was removed
// with the ceiling itself — billing is now pure lease-stamp. The (property,
// unit_type) policy stays authoritative at DRAFT + the onboarding gate; it no
// longer bounds billing of an already-signed lease.

async function processInvoice(
  client: PoolClient,
  inv: QualifyingInvoice,
  result: LateFeeResult
): Promise<void> {
  const today = inv.today_local

  // Percent-of-rent late fees base on the FULL month's rent (Nic, S581 — "% of
  // the whole rent"). SUM the live rent rows rather than grabbing one: a rent
  // row split by a partial credit becomes a reduced original + a remainder row
  // that together equal the full rent, and a reversal reopen adds a fresh rent
  // row alongside the old one. Restricting to pending/processing/settled counts
  // the current obligation exactly once — it excludes the 'returned' half of a
  // reopen (double-count) and 'failed'/'paid_via_deposit' artifacts. The old
  // `LIMIT 1` picked ONE piece arbitrarily (even the already-paid slice),
  // under-basing the fee whenever the rent had been split.
  const { rows: rentRows } = await client.query<{ total: string }>(`
    SELECT COALESCE(SUM(amount), 0)::text AS total
    FROM payments
    WHERE invoice_id = $1 AND type = 'rent'
      AND status IN ('pending', 'processing', 'settled')
  `, [inv.invoice_id])
  const rentAmount = Number(rentRows[0].total)

  // S558 (Nic): billing = PURE lease-stamp. Every parameter comes from the
  // SIGNED lease (inv.late_fee_*) — the current property policy has NO effect on
  // an existing lease's charges. The document is the charge: it keeps FlexPay
  // savings math and every downstream calc consistent, and a mid-lease policy
  // change (even tenant-favorable) has to go through a superseding lease, not a
  // silent settings tweak. The class policy is used only at DRAFT/gate time.
  // (Removed the S537 tenant-favorable policy ceiling per Nic.)

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

  // Cap = the lease's OWN stamped cap (late_fee_cap_*), part of the signed doc.
  const capKind = inv.late_fee_cap_type
  const capAmt = inv.late_fee_cap_amount !== null ? Number(inv.late_fee_cap_amount) : null
  let remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)

  if (capKind !== null && remaining <= 0) {
    return
  }

  const graceDays = inv.late_fee_grace_days
  const initialDate = lateFeeStartDate(inv.due_date, graceDays)

  // S577: retroactive modes (due_date / due_date_inclusive) charge ONLY the
  // daily/period accrual, counted back to the due date — no separate flat
  // "initial" fee. Guard applies only when an accrual is actually configured;
  // a flat-fee-only policy still charges its flat fee regardless of anchor.
  const accrualFrom = inv.late_fee_accrual_from || 'grace_end'
  const hasAccrual =
    inv.late_fee_accrual_type !== null &&
    inv.late_fee_accrual_amount !== null &&
    inv.late_fee_accrual_period !== null
  const retroactiveNoInitial = accrualFrom !== 'grace_end' && hasAccrual

  if (!retroactiveNoInitial && !existingDates.has(initialDate)) {
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
    if (initialAmt > 0) {
      await insertLateFeeRow(client, inv, initialDate, initialAmt)
      result.rowsWritten += 1
      existingSum += initialAmt
      existingDates.add(initialDate)
      remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)
      if (capHitOnInitial) {
        result.capsHit += 1
        return
      }
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
    const tickDate = nextAccrualDate(inv.due_date, graceDays, period, occ, accrualFrom)
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
    if (tickAmt <= 0) break

    await insertLateFeeRow(client, inv, tickDate, tickAmt)
    result.rowsWritten += 1
    existingSum += tickAmt
    existingDates.add(tickDate)
    remaining = capRemaining(capKind, capAmt, rentAmount, existingSum)

    if (capHit) {
      result.capsHit += 1
      break
    }
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
