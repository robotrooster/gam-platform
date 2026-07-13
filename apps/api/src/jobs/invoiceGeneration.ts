import { DateTime } from 'luxon'
import { formatInvoiceNumber } from '@gam/shared'
import { getClient, query, queryOne } from '../db'
import type { PoolClient } from 'pg'
import { logger } from '../lib/logger'
import {
  loadWorkTradeCreditContext, workTradeFraction, distributeWorkTradeCredit, round2,
} from '../services/workTradeCredit'
import { ensureBillsForUnit } from '../services/utilityBilling'

// ============================================================
// S26a: Invoice generator (replaces S25 rentGeneration)
// Daily cron. Generates an invoice on each lease's due date
// containing rent + monthly_ongoing fee children.
// Idempotent via ux_invoices_lease_due_date.
// Catch-up: backfills missed cycles up to 30 days back.
// ============================================================

interface ActiveLease {
  id: string
  unit_id: string
  landlord_id: string
  rent_amount: string       // numeric -> string from pg
  rent_due_day: number
  start_date: string        // YYYY-MM-DD
  end_date: string | null
  tenant_id: string | null
  property_tz: string
}

interface MonthlyFee {
  id: string
  lease_id: string
  fee_type: string
  amount: string
  description: string | null
}

interface InvoiceGenResult {
  invoicesInserted: number
  rentsInserted: number
  feesInserted: number
  utilitiesInserted: number
  leasesProcessed: number
}

interface RunOpts {
  // When set, overrides the default "today − CATCHUP_DAYS → today" window
  // with a caller-provided range. The from/to strings are interpreted in
  // each lease's property timezone before clamping to lease bounds.
  explicitWindow?: { from: string; to: string }
  // When true, counts what *would* be inserted but writes nothing. Existing
  // invoices for a (lease_id, due_date) collision are skipped, mirroring
  // the live ON CONFLICT DO NOTHING behavior.
  dryRun?: boolean
}

const CATCHUP_DAYS = 30

/**
 * Compute every rent_due_day date in [fromDate, toDate] inclusive, given a rent_due_day.
 * Clamps to last-of-month when rent_due_day exceeds month length (e.g. day=31 in Feb).
 * Returns ISO date strings ordered ascending.
 */
export function dueDatesInRange(
  fromDate: DateTime,
  toDate: DateTime,
  rentDueDay: number
): string[] {
  const result: string[] = []
  let cursor = fromDate.startOf('month')
  const end = toDate.startOf('month').plus({ months: 1 })
  while (cursor < end) {
    const cappedDay = Math.min(rentDueDay, cursor.daysInMonth!)
    const candidate = cursor.set({ day: cappedDay })
    if (candidate >= fromDate && candidate <= toDate) {
      result.push(candidate.toISODate()!)
    }
    cursor = cursor.plus({ months: 1 })
  }
  return result
}

/**
 * Allocate next invoice number for a landlord in a given year.
 * Uses INSERT ... ON CONFLICT UPDATE to atomically reserve a number.
 * MUST be called inside a transaction on the provided client.
 */
async function allocateInvoiceNumber(
  client: PoolClient,
  landlordId: string,
  year: number
): Promise<string> {
  const r = await client.query(
    `INSERT INTO invoice_sequences (landlord_id, year, next_number)
     VALUES ($1, $2, 2)
     ON CONFLICT (landlord_id, year)
     DO UPDATE SET next_number = invoice_sequences.next_number + 1
     RETURNING next_number`,
    [landlordId, year]
  )
  const nextAfter = r.rows[0].next_number as number
  const sequenceUsed = nextAfter - 1
  return formatInvoiceNumber(year, sequenceUsed)
}

/**
 * Generate (or catch up) invoices for all active leases.
 * Called daily by cron.
 */
export async function generateInvoices(
  nowUtc: Date = new Date()
): Promise<InvoiceGenResult> {
  const leases = await query<ActiveLease>(`
    SELECT l.id, l.unit_id, l.landlord_id, l.rent_amount, l.rent_due_day,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,   'YYYY-MM-DD') AS end_date,
           (SELECT vlat.tenant_id
              FROM v_lease_active_tenants vlat
              WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
              LIMIT 1) AS tenant_id,
           COALESCE(p.timezone, 'America/Phoenix') AS property_tz
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE l.status = 'active'
      AND (l.needs_review IS NULL OR l.needs_review = false)
  `)

  return runGeneration(leases, nowUtc)
}

/**
 * Per-lease loop that does the actual work. Shared between the legacy
 * global generateInvoices() and the per-tz generateInvoicesForTimezone().
 */
async function runGeneration(
  leases: ActiveLease[],
  nowUtc: Date,
  opts: RunOpts = {}
): Promise<InvoiceGenResult> {

  let invoicesInserted = 0
  let rentsInserted = 0
  let feesInserted = 0
  let utilitiesInserted = 0

  for (const lease of leases) {
    const leaseStart = DateTime.fromISO(lease.start_date, { zone: lease.property_tz })
    const leaseEnd = lease.end_date
      ? DateTime.fromISO(lease.end_date, { zone: lease.property_tz })
      : null

    let windowStart: DateTime
    let windowEnd: DateTime
    if (opts.explicitWindow) {
      const fromInTz = DateTime.fromISO(opts.explicitWindow.from, { zone: lease.property_tz }).startOf('day')
      const toInTz = DateTime.fromISO(opts.explicitWindow.to, { zone: lease.property_tz }).startOf('day')
      windowStart = fromInTz > leaseStart ? fromInTz : leaseStart
      windowEnd = leaseEnd && leaseEnd < toInTz ? leaseEnd : toInTz
    } else {
      const todayInTz = DateTime.fromJSDate(nowUtc, { zone: lease.property_tz }).startOf('day')
      const catchupStart = todayInTz.minus({ days: CATCHUP_DAYS })
      windowStart = catchupStart > leaseStart ? catchupStart : leaseStart
      windowEnd = leaseEnd && leaseEnd < todayInTz ? leaseEnd : todayInTz
    }

    if (windowEnd < windowStart) continue

    const candidateDueDates = dueDatesInRange(windowStart, windowEnd, lease.rent_due_day)
    if (candidateDueDates.length === 0) continue

    // Move-in invoice (dated lease.start_date) is written by moveInBundle at finalize.
    // Skip any candidate due date equal to lease.start_date to avoid competing with it.
    const dueDates = candidateDueDates.filter(d => d !== lease.start_date)
    if (dueDates.length === 0) continue

    // Load monthly fees once per lease
    const fees = await query<MonthlyFee>(
      `SELECT id, lease_id, fee_type, amount, description
       FROM lease_fees
       WHERE lease_id = $1 AND due_timing = 'monthly_ongoing'`,
      [lease.id]
    )

    for (const dueDate of dueDates) {
      // S534 (Nic): two things hold a unit's invoice — and they hold the
      // WHOLE invoice (rent included), never a partial send:
      //   1. a missing ORIGINAL read on a tenant-responsible submeter
      //      serving this unit (a due, not-yet-completed run cycle where
      //      that meter was never read). Releases when the read lands or
      //      the landlord force-completes the run.
      //   2. an UNRESOLVED FLAG on such a meter's reading (needs_review —
      //      probable typo / rollover-vs-swap). Releases when the
      //      verification re-read or the landlord's review resolves it;
      //      force-completing the run does NOT clear a flag.
      // The daily cron retries, so the invoice generates dated its
      // original due date the moment the hold clears. Other units are
      // untouched, and a clean unit's unfinished VERIFICATION never
      // blocks — ensureBillsForUnit below bills from original reads.
      // RUBS masters never block (separate system — their bills ride
      // the next invoice whenever the master gets read).
      const readHold = await queryOne<{ meter_id: string }>(
        `SELECT m.id AS meter_id
           FROM utility_reading_runs r
           JOIN utility_meters m ON m.property_id = r.property_id
                                AND m.billing_method = 'submeter'
           JOIN utility_meter_units mu ON mu.meter_id = m.id AND mu.unit_id = $2
           JOIN lease_utility_responsibilities lur
             ON lur.lease_id = $1
            AND lur.utility_type = m.utility_type
            AND lur.tenant_responsible
          WHERE r.status <> 'completed'
            AND r.billing_cycle_month <= date_trunc('month', $3::date)::date
            AND NOT EXISTS (
              SELECT 1 FROM utility_meter_readings rd
               WHERE rd.meter_id = m.id
                 AND rd.billing_cycle_month = r.billing_cycle_month)
          LIMIT 1`,
        [lease.id, lease.unit_id, dueDate]
      )
      const flagHold = readHold ? null : await queryOne<{ meter_id: string }>(
        `SELECT m.id AS meter_id
           FROM utility_meters m
           JOIN utility_meter_units mu ON mu.meter_id = m.id AND mu.unit_id = $2
           JOIN lease_utility_responsibilities lur
             ON lur.lease_id = $1
            AND lur.utility_type = m.utility_type
            AND lur.tenant_responsible
           JOIN utility_meter_readings rd ON rd.meter_id = m.id
          WHERE m.billing_method = 'submeter'
            AND rd.needs_review
            AND rd.billing_cycle_month <= date_trunc('month', $3::date)::date
          LIMIT 1`,
        [lease.id, lease.unit_id, dueDate]
      )
      if (readHold || flagHold) continue

      // S534: per-unit billing readiness — generate any bills this
      // unit's readings support before pulling them below. Write-path
      // only; the dry run just counts bills that already exist.
      if (!opts.dryRun) {
        await ensureBillsForUnit(lease.unit_id, dueDate)
      }

      // S247: sublease-active branch. When a sublease covers this
      // (unit, due_date), the invoice is generated for the sublessee
      // at sub_monthly_amount instead of the primary master tenant
      // at lease.rent_amount. Sublessor sees their profit accrue via
      // sublessor_credit_balances when the sublessee's payment lands
      // (see services/subleaseAllocation.ts).
      const sublease = await queryOne<{
        sublessee_tenant_id: string
        sub_monthly_amount:  string
      }>(
        `SELECT s.sublessee_tenant_id, s.sub_monthly_amount::text
           FROM subleases s
          WHERE s.master_lease_id = $1
            AND s.status = 'active'
            AND s.sublessee_tenant_id IS NOT NULL
            AND s.start_date <= $2::date
            AND (s.end_date IS NULL OR s.end_date >= $2::date)
          LIMIT 1`,
        [lease.id, dueDate],
      )
      const effectiveTenantId = sublease?.sublessee_tenant_id ?? lease.tenant_id
      const effectiveRentAmount = sublease ? Number(sublease.sub_monthly_amount).toFixed(2) : lease.rent_amount

      // S178: pull any utility_bills for this lease that haven't been
      // attached to an invoice yet (payment_id IS NULL) and whose cycle
      // is on/before this invoice's due-date cycle. Catches current-cycle
      // bills + any prior-cycle stragglers (late meter readings). Bills
      // for future cycles wait their turn. Read outside the transaction
      // so the dry-run path can use the same query.
      const utilityBills = await query<{
        id: string
        charge_amount: string
      }>(
        `SELECT ub.id, (ub.charge_amount + ub.tax_amount) AS charge_amount,
                ub.utility_type, ub.usage_amount, ub.reading_start, ub.reading_end,
                m.digits
           FROM utility_bills ub
           JOIN utility_meters m ON m.id = ub.meter_id
          WHERE ub.lease_id = $1
            AND ub.payment_id IS NULL
            AND ub.status IN ('unbilled','billed')
            AND ub.billing_cycle_month <= date_trunc('month', $2::date)::date
          ORDER BY ub.billing_cycle_month ASC, ub.id ASC`,
        [lease.id, dueDate]
      )

      // S533: propane fill installments not yet billed whose cycle has
      // arrived. #1 billed immediately at the fill (payment_id set), so
      // this only picks up the split remainder. Same straggler semantics
      // as utility bills. Fixed contractual amounts — deliberately NOT
      // run through the work-trade credit distribution.
      const propaneInstallments = await query<{
        id: string
        amount: string
        installment_number: number
        installment_count: number
        gallons: string
      }>(
        `SELECT i.id, i.amount, i.installment_number, f.installment_count, f.gallons
           FROM propane_fill_installments i
           JOIN propane_fills f ON f.id = i.fill_id
          WHERE f.lease_id = $1
            AND i.payment_id IS NULL
            AND i.billing_cycle_month <= date_trunc('month', $2::date)::date
          ORDER BY i.billing_cycle_month ASC, i.installment_number ASC`,
        [lease.id, dueDate]
      )

      if (opts.dryRun) {
        // Skip writes entirely; only count what *would* land. Mirrors the
        // ON CONFLICT (lease_id, due_date) DO NOTHING short-circuit below.
        const existing = await query<{ id: string }>(
          `SELECT id FROM invoices WHERE lease_id=$1 AND due_date=$2 LIMIT 1`,
          [lease.id, dueDate]
        )
        if (existing.length > 0) continue
        invoicesInserted++
        rentsInserted++
        feesInserted += fees.length
        utilitiesInserted += utilityBills.length + propaneInstallments.length
        continue
      }

      const client = await getClient()
      try {
        await client.query('BEGIN')

        const year = DateTime.fromISO(dueDate).year
        const invoiceNumber = await allocateInvoiceNumber(client, lease.landlord_id, year)

        // Compute GROSS totals (the invoice subtotals stay gross for the record).
        const rentAmountNum = Number(effectiveRentAmount)
        const feesTotalNum = fees.reduce((s, f) => s + Number(f.amount), 0)
        const utilitiesTotalNum = utilityBills.reduce((s, b) => s + Number(b.charge_amount), 0)
        // Propane installments ride the invoice at face value (fixed
        // contractual split amounts — exempt from work-trade credit and
        // late fees) but count into the utilities subtotal + total.
        const propaneTotalNum = propaneInstallments.reduce((s, p) => s + Number(p.amount), 0)
        const billableTotalNum = round2(rentAmountNum + feesTotalNum + utilitiesTotalNum)
        const subtotalFeesStr      = feesTotalNum.toFixed(2)
        const subtotalUtilitiesStr = round2(utilitiesTotalNum + propaneTotalNum).toFixed(2)

        // S517 — work-trade credit (Landlord #29). When the master tenant on
        // this unit has an active work-trade agreement, verified hours from
        // the prior calendar month buy a percent of THIS invoice's total
        // (rent+utilities+fees), per the property's hours target. The credit
        // reduces what the tenant is actually charged; subtotals stay gross.
        // Skipped under an active sublease (the sublessee, not the work-
        // trader, is the payer for that cycle).
        const wt = (!sublease && lease.tenant_id)
          ? await loadWorkTradeCreditContext(client, { unitId: lease.unit_id, tenantId: lease.tenant_id, dueDate })
          : null
        const wtFraction = wt ? workTradeFraction(wt.verifiedHours, wt.target) : 0
        const wtCreditTarget = round2(wtFraction * billableTotalNum)
        const dist = distributeWorkTradeCredit(
          rentAmountNum,
          utilityBills.map(b => Number(b.charge_amount)),
          fees.map(f => Number(f.amount)),
          wtCreditTarget,
        )
        const netTotalNum = round2(
          dist.rentNet
          + dist.utilityNets.reduce((s, u) => s + u, 0)
          + dist.feeNets.reduce((s, f) => s + f, 0)
          + propaneTotalNum
        )
        // A row fully covered by the trade is charged $0 and recorded as
        // already-settled (covered by labor, not cash) only when work-trade
        // actually applied — otherwise a legitimately $0 line keeps its prior
        // 'pending' behavior.
        const wtActive = !!wt && dist.creditApplied > 0
        const WT_NOTE = 'Covered by work-trade credit'
        const rowStatus = (net: number) => (wtActive && net === 0 ? 'settled' : 'pending')
        const rowNote   = (net: number) => (wtActive && net === 0 ? WT_NOTE : null)

        // Insert invoice — ON CONFLICT short-circuits whole cycle if already exists.
        // total_amount is NET of the work-trade credit; the credit + driving
        // agreement are stamped for audit + tenant/landlord display.
        const invoiceRes = await client.query(
          `INSERT INTO invoices (
             landlord_id, tenant_id, lease_id, unit_id,
             invoice_number, due_date,
             subtotal_rent, subtotal_fees, subtotal_utilities, total_amount,
             work_trade_credit_amount, work_trade_credit_hours, work_trade_agreement_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (lease_id, due_date) DO NOTHING
           RETURNING id`,
          [
            lease.landlord_id, effectiveTenantId, lease.id, lease.unit_id,
            invoiceNumber, dueDate,
            effectiveRentAmount, subtotalFeesStr, subtotalUtilitiesStr, netTotalNum.toFixed(2),
            dist.creditApplied.toFixed(2), (wt ? wt.verifiedHours : 0).toFixed(2), wt ? wt.agreementId : null,
          ]
        )

        if (invoiceRes.rows.length === 0) {
          // Invoice already exists for this cycle — roll back to release reserved number
          await client.query('ROLLBACK')
          continue
        }

        const invoiceId = invoiceRes.rows[0].id as string

        // Rent child row at the work-trade-NET amount. entry_description is the
        // NACHA-shaped categorical enum (CHECK on payments.entry_description).
        await client.query(
          `INSERT INTO payments (
             invoice_id, unit_id, lease_id, tenant_id, landlord_id,
             type, amount, status, due_date, entry_description, notes,
             settled_at
           ) VALUES ($1, $2, $3, $4, $5, 'rent', $6, $8, $7, 'RENT', $9,
             CASE WHEN $8 = 'settled' THEN NOW() ELSE NULL END)`,
          [
            invoiceId, lease.unit_id, lease.id, effectiveTenantId, lease.landlord_id,
            dist.rentNet.toFixed(2), dueDate, rowStatus(dist.rentNet), rowNote(dist.rentNet),
          ]
        )
        rentsInserted++

        // Monthly fee child rows at NET. monthly_ongoing scope only — no
        // deposit-shape fee_types live under monthly_ongoing in the
        // CHECK enum, so SUBSCRIP is the right NACHA category here.
        // S247: fees route to sublessee when sublease is active (the
        // occupant is the one responsible for unit-period charges).
        for (let i = 0; i < fees.length; i++) {
          const fee = fees[i]
          const net = dist.feeNets[i]
          await client.query(
            `INSERT INTO payments (
               invoice_id, unit_id, lease_id, tenant_id, landlord_id,
               type, amount, status, due_date, entry_description, lease_fee_id, notes,
               settled_at
             ) VALUES ($1, $2, $3, $4, $5, 'fee', $6, $9, $7, 'SUBSCRIP', $8, $10,
               CASE WHEN $9 = 'settled' THEN NOW() ELSE NULL END)`,
            [
              invoiceId, lease.unit_id, lease.id, effectiveTenantId, lease.landlord_id,
              net.toFixed(2), dueDate, fee.id, rowStatus(net), rowNote(net),
            ]
          )
          feesInserted++
        }

        // S178: Utility child rows at NET. Each utility_bill becomes a
        // payments.type='utility' row linked to the invoice, mirroring
        // the fee model. utility_bills.payment_id is stamped + status
        // flipped to 'billed' so subsequent invoice runs don't double-
        // bill — this link is made even when the trade fully covers the
        // bill (the $0 settled row still owns the bill).
        for (let i = 0; i < utilityBills.length; i++) {
          const ub = utilityBills[i]
          const net = dist.utilityNets[i]
          // S533: the invoice line carries begin/end reads + usage — the
          // tenant sees exactly what produced the charge (the blind rule
          // only ever applied to the READER's entry flow).
          const UNIT_LABEL: Record<string, string> = { electric: 'kWh', water: 'gal', sewer: 'gal', gas: 'therms' }
          const pad = (v: any) => v == null ? null : String(Math.trunc(Number(v))).padStart(Number((ub as any).digits) || 6, '0')
          const readNote = (ub as any).reading_start != null && (ub as any).reading_end != null
            ? `${((ub as any).utility_type || 'utility')[0].toUpperCase() + ((ub as any).utility_type || 'utility').slice(1)} meter ${pad((ub as any).reading_start)} → ${pad((ub as any).reading_end)} · ${Number((ub as any).usage_amount || 0).toLocaleString()} ${UNIT_LABEL[(ub as any).utility_type] || 'units'}`
            : null
          const combinedNote = [readNote, rowNote(net)].filter(Boolean).join(' — ') || null
          const utilityPayment = await client.query<{ id: string }>(
            `INSERT INTO payments (
               invoice_id, unit_id, lease_id, tenant_id, landlord_id,
               type, amount, status, due_date, entry_description, notes,
               settled_at
             ) VALUES ($1, $2, $3, $4, $5, 'utility', $6, $8, $7, 'UTILITY', $9,
               CASE WHEN $8 = 'settled' THEN NOW() ELSE NULL END)
             RETURNING id`,
            [
              invoiceId, lease.unit_id, lease.id, effectiveTenantId, lease.landlord_id,
              net.toFixed(2), dueDate, rowStatus(net), combinedNote,
            ]
          )
          await client.query(
            `UPDATE utility_bills
                SET payment_id = $1,
                    status     = 'billed',
                    billed_at  = COALESCE(billed_at, NOW()),
                    updated_at = NOW()
              WHERE id = $2`,
            [utilityPayment.rows[0].id, ub.id]
          )
          utilitiesInserted++
        }

        // S533: propane installment children at face value (fixed split
        // amounts). Once on the invoice they ride its NORMAL late-fee
        // rules (Nic). payment_id stamped so the next run doesn't re-bill.
        for (const pi of propaneInstallments) {
          const propanePayment = await client.query<{ id: string }>(
            `INSERT INTO payments (
               invoice_id, unit_id, lease_id, tenant_id, landlord_id,
               type, amount, status, due_date, entry_description, notes
             ) VALUES ($1, $2, $3, $4, $5, 'utility', $6, 'pending', $7, 'PROPANE', $8)
             RETURNING id`,
            [
              invoiceId, lease.unit_id, lease.id, effectiveTenantId, lease.landlord_id,
              Number(pi.amount).toFixed(2), dueDate,
              `Propane fill ${pi.gallons} gal — payment ${pi.installment_number} of ${pi.installment_count}`,
            ]
          )
          await client.query(
            `UPDATE propane_fill_installments SET payment_id = $1 WHERE id = $2`,
            [propanePayment.rows[0].id, pi.id]
          )
          utilitiesInserted++
        }

        // S537 (Nic): consume prepaid credit (pay-ahead remainder from a
        // FIFO remittance) against this invoice's fresh charge rows,
        // oldest credit first. Rows fully covered settle out-of-band (no
        // Stripe money moves — it already moved when the tenant paid
        // ahead); a partially covered row splits per the standard
        // remainder pattern so late-fee mechanics stay truthful.
        {
          const credits = await client.query<{ id: string; amount_remaining: string }>(
            `SELECT id, amount_remaining::text FROM lease_prepaid_credits
              WHERE lease_id = $1 AND amount_remaining > 0
              ORDER BY created_at ASC
              FOR UPDATE`,
            [lease.id])
          let available = credits.rows.reduce((sum, c) => sum + Number(c.amount_remaining), 0)
          if (available > 0) {
            const fresh = await client.query<{ id: string; amount: string; type: string }>(
              `SELECT id, amount::text, type FROM payments
                WHERE invoice_id = $1 AND status = 'pending'
                ORDER BY due_date ASC, created_at ASC`,
              [invoiceId])
            let consumed = 0
            for (const row of fresh.rows) {
              if (available <= 0.005) break
              const rowAmt = Number(row.amount)
              const apply = Math.min(rowAmt, available)
              if (apply >= rowAmt - 0.005) {
                await client.query(
                  `UPDATE payments SET status='settled', settled_at=NOW(),
                          notes = COALESCE(notes || ' — ', '') || 'covered by prepaid credit (paid ahead)'
                    WHERE id = $1`, [row.id])
              } else {
                const remainder = Math.round((rowAmt - apply) * 100) / 100
                await client.query(
                  `UPDATE payments SET amount = $2::numeric, status='settled', settled_at=NOW(),
                          notes = COALESCE(notes || ' — ', '') || 'partially covered by prepaid credit'
                    WHERE id = $1`, [row.id, apply.toFixed(2)])
                await client.query(
                  `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                                         type, amount, status, due_date, entry_description, notes, is_remainder)
                   SELECT invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                          type, $2::numeric, 'pending', due_date, entry_description,
                          'Remainder after prepaid credit application', TRUE
                     FROM payments WHERE id = $1`,
                  [row.id, remainder.toFixed(2)])
              }
              available -= apply
              consumed += apply
            }
            // Draw down the credits oldest-first by what was consumed.
            let toDraw = consumed
            for (const c of credits.rows) {
              if (toDraw <= 0.005) break
              const draw = Math.min(Number(c.amount_remaining), toDraw)
              await client.query(
                `UPDATE lease_prepaid_credits
                    SET amount_remaining = amount_remaining - $2::numeric, updated_at = NOW()
                  WHERE id = $1`, [c.id, draw.toFixed(2)])
              toDraw -= draw
            }
          }
        }

        await client.query('COMMIT')
        invoicesInserted++
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    }
  }

  return {
    invoicesInserted,
    rentsInserted,
    feesInserted,
    utilitiesInserted,
    leasesProcessed: leases.length,
  }
}

// ----- S26b-tz: per-timezone scoped variant + manager registration -----

import { registerEngine } from './timezoneCronManager'

/**
 * Run invoice generation scoped to leases whose property is in the given
 * timezone. Called by per-tz cron at 7am local on each property's due date
 * (with 5 follow-up ticks at :10/:20/:30/:40/:50 to catch the boundary).
 *
 * The per-lease loop (in generateInvoices above) computes everything in the
 * property's local timezone via Luxon, so we just need to scope the lease
 * query by p.timezone here. The cron firing window is the gate that ensures
 * 7am-local timing per locked product decision.
 */
export async function generateInvoicesForTimezone(
  tz: string,
  nowUtc: Date = new Date()
): Promise<InvoiceGenResult> {
  const leases = await query<ActiveLease>(`
    SELECT l.id, l.unit_id, l.landlord_id, l.rent_amount, l.rent_due_day,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,   'YYYY-MM-DD') AS end_date,
           (SELECT vlat.tenant_id
              FROM v_lease_active_tenants vlat
              WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
              LIMIT 1) AS tenant_id,
           p.timezone AS property_tz
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE l.status = 'active'
      AND (l.needs_review IS NULL OR l.needs_review = false)
      AND p.timezone = $1
  `, [tz])

  return runGeneration(leases, nowUtc)
}

// ----- S100 admin backfill: explicit-window invoice catch-up -----

export interface BackfillOpts {
  from: string         // ISO date YYYY-MM-DD (interpreted in each lease's property tz)
  to: string           // ISO date YYYY-MM-DD (inclusive)
  landlordId?: string  // scope to one landlord
  leaseId?: string     // scope to one lease (overrides landlordId)
  dryRun?: boolean
}

/**
 * Admin-triggered catch-up that lets ops rerun invoice generation across an
 * arbitrary date range, optionally scoped to one landlord or lease, with an
 * optional dry-run that returns the would-insert counts without writing.
 *
 * Idempotent against existing invoices via the same (lease_id, due_date)
 * uniqueness the daily cron relies on, so re-running is safe.
 */
export async function backfillInvoices(opts: BackfillOpts): Promise<InvoiceGenResult> {
  const from = DateTime.fromISO(opts.from)
  const to = DateTime.fromISO(opts.to)
  if (!from.isValid) throw new Error(`Invalid from date: ${opts.from}`)
  if (!to.isValid) throw new Error(`Invalid to date: ${opts.to}`)
  if (from > to) throw new Error('from must be on or before to')

  const where: string[] = [
    `l.status = 'active'`,
    `(l.needs_review IS NULL OR l.needs_review = false)`,
  ]
  const params: any[] = []
  if (opts.leaseId) {
    params.push(opts.leaseId)
    where.push(`l.id = $${params.length}`)
  } else if (opts.landlordId) {
    params.push(opts.landlordId)
    where.push(`l.landlord_id = $${params.length}`)
  }

  const leases = await query<ActiveLease>(`
    SELECT l.id, l.unit_id, l.landlord_id, l.rent_amount, l.rent_due_day,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,   'YYYY-MM-DD') AS end_date,
           (SELECT vlat.tenant_id
              FROM v_lease_active_tenants vlat
              WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
              LIMIT 1) AS tenant_id,
           COALESCE(p.timezone, 'America/Phoenix') AS property_tz
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE ${where.join(' AND ')}
  `, params)

  return runGeneration(leases, new Date(), {
    explicitWindow: { from: opts.from, to: opts.to },
    dryRun: opts.dryRun ?? false,
  })
}

/**
 * Register the invoice-generation engine with the timezone cron manager.
 * Cron expression: minutes 0,10,20,30,40,50 of hour 7 in property timezone.
 * (6 firings per timezone per day, all within 07:00-07:59 local.)
 */
export function registerInvoiceEngine(): void {
  registerEngine('invoices', {
    cronExpr: '0,10,20,30,40,50 7 * * *',
    handler: async (tz: string) => {
      try {
        const r = await generateInvoicesForTimezone(tz)
        if (r.invoicesInserted > 0 || r.rentsInserted > 0 || r.feesInserted > 0) {
          logger.info({ tz, invoices: r.invoicesInserted, rents: r.rentsInserted, fees: r.feesInserted }, '[InvoiceGen] invoices generated')
        }
      } catch (e) {
        logger.error({ err: e, tz }, '[InvoiceGen] error')
      }
    },
    label: 'Invoice generation',
  })
}
