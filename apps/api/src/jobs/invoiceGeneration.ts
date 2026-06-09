import { DateTime } from 'luxon'
import { formatInvoiceNumber } from '@gam/shared'
import { getClient, query, queryOne } from '../db'
import type { PoolClient } from 'pg'
import { logger } from '../lib/logger'

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
        `SELECT id, charge_amount
           FROM utility_bills
          WHERE lease_id = $1
            AND payment_id IS NULL
            AND status IN ('unbilled','billed')
            AND billing_cycle_month <= date_trunc('month', $2::date)::date
          ORDER BY billing_cycle_month ASC, id ASC`,
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
        utilitiesInserted += utilityBills.length
        continue
      }

      const client = await getClient()
      try {
        await client.query('BEGIN')

        const year = DateTime.fromISO(dueDate).year
        const invoiceNumber = await allocateInvoiceNumber(client, lease.landlord_id, year)

        // Compute totals before insert
        const rentAmountNum = Number(effectiveRentAmount)
        const feesTotalNum = fees.reduce((s, f) => s + Number(f.amount), 0)
        const utilitiesTotalNum = utilityBills.reduce((s, b) => s + Number(b.charge_amount), 0)
        const totalAmountNum = rentAmountNum + feesTotalNum + utilitiesTotalNum
        const subtotalFeesStr      = feesTotalNum.toFixed(2)
        const subtotalUtilitiesStr = utilitiesTotalNum.toFixed(2)
        const totalAmountStr       = totalAmountNum.toFixed(2)

        // Insert invoice — ON CONFLICT short-circuits whole cycle if already exists
        const invoiceRes = await client.query(
          `INSERT INTO invoices (
             landlord_id, tenant_id, lease_id, unit_id,
             invoice_number, due_date,
             subtotal_rent, subtotal_fees, subtotal_utilities, total_amount
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (lease_id, due_date) DO NOTHING
           RETURNING id`,
          [
            lease.landlord_id, effectiveTenantId, lease.id, lease.unit_id,
            invoiceNumber, dueDate,
            effectiveRentAmount, subtotalFeesStr, subtotalUtilitiesStr, totalAmountStr,
          ]
        )

        if (invoiceRes.rows.length === 0) {
          // Invoice already exists for this cycle — roll back to release reserved number
          await client.query('ROLLBACK')
          continue
        }

        const invoiceId = invoiceRes.rows[0].id as string

        // Rent child row. entry_description is the NACHA-shaped categorical
        // enum (CHECK on payments.entry_description); not a free-text label.
        await client.query(
          `INSERT INTO payments (
             invoice_id, unit_id, lease_id, tenant_id, landlord_id,
             type, amount, status, due_date, entry_description
           ) VALUES ($1, $2, $3, $4, $5, 'rent', $6, 'pending', $7, 'RENT')`,
          [
            invoiceId, lease.unit_id, lease.id, effectiveTenantId, lease.landlord_id,
            effectiveRentAmount, dueDate,
          ]
        )
        rentsInserted++

        // Monthly fee child rows. monthly_ongoing scope only — no
        // deposit-shape fee_types live under monthly_ongoing in the
        // CHECK enum, so SUBSCRIP is the right NACHA category here.
        // S247: fees route to sublessee when sublease is active (the
        // occupant is the one responsible for unit-period charges).
        for (const fee of fees) {
          await client.query(
            `INSERT INTO payments (
               invoice_id, unit_id, lease_id, tenant_id, landlord_id,
               type, amount, status, due_date, entry_description, lease_fee_id
             ) VALUES ($1, $2, $3, $4, $5, 'fee', $6, 'pending', $7, 'SUBSCRIP', $8)`,
            [
              invoiceId, lease.unit_id, lease.id, effectiveTenantId, lease.landlord_id,
              fee.amount, dueDate, fee.id,
            ]
          )
          feesInserted++
        }

        // S178: Utility child rows. Each utility_bill becomes a
        // payments.type='utility' row linked to the invoice, mirroring
        // the fee model. utility_bills.payment_id is stamped + status
        // flipped to 'billed' so subsequent invoice runs don't double-
        // bill. Pre-S178 these were standalone payments rows with no
        // invoice_id; the /api/utility/bills/:id/pay route created them
        // ad-hoc on tenant pay attempt, which broke the "utilities are
        // line items on the rent invoice" architecture from S90.
        for (const ub of utilityBills) {
          const utilityPayment = await client.query<{ id: string }>(
            `INSERT INTO payments (
               invoice_id, unit_id, lease_id, tenant_id, landlord_id,
               type, amount, status, due_date, entry_description
             ) VALUES ($1, $2, $3, $4, $5, 'utility', $6, 'pending', $7, 'UTILITY')
             RETURNING id`,
            [
              invoiceId, lease.unit_id, lease.id, effectiveTenantId, lease.landlord_id,
              ub.charge_amount, dueDate,
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
