import { DateTime } from 'luxon'
import { formatInvoiceNumber } from '@gam/shared'
import { getClient, query } from '../db'
import type { PoolClient } from 'pg'

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
  leasesProcessed: number
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
           l.start_date, l.end_date,
           vlat.primary_tenant_id AS tenant_id,
           COALESCE(p.timezone, 'America/Phoenix') AS property_tz
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id
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
  nowUtc: Date
): Promise<InvoiceGenResult> {

  let invoicesInserted = 0
  let rentsInserted = 0
  let feesInserted = 0

  for (const lease of leases) {
    const todayInTz = DateTime.fromJSDate(nowUtc, { zone: lease.property_tz }).startOf('day')
    const catchupStart = todayInTz.minus({ days: CATCHUP_DAYS })
    const leaseStart = DateTime.fromISO(lease.start_date, { zone: lease.property_tz })
    const leaseEnd = lease.end_date
      ? DateTime.fromISO(lease.end_date, { zone: lease.property_tz })
      : null

    const windowStart = catchupStart > leaseStart ? catchupStart : leaseStart
    const windowEnd = leaseEnd && leaseEnd < todayInTz ? leaseEnd : todayInTz

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
      const client = await getClient()
      try {
        await client.query('BEGIN')

        const year = DateTime.fromISO(dueDate).year
        const invoiceNumber = await allocateInvoiceNumber(client, lease.landlord_id, year)

        // Compute total before insert
        const rentAmountNum = Number(lease.rent_amount)
        const feesTotalNum = fees.reduce((s, f) => s + Number(f.amount), 0)
        const totalAmountNum = rentAmountNum + feesTotalNum
        const subtotalFeesStr = feesTotalNum.toFixed(2)
        const totalAmountStr = totalAmountNum.toFixed(2)

        // Insert invoice — ON CONFLICT short-circuits whole cycle if already exists
        const invoiceRes = await client.query(
          `INSERT INTO invoices (
             landlord_id, tenant_id, lease_id, unit_id,
             invoice_number, due_date,
             subtotal_rent, subtotal_fees, total_amount
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (lease_id, due_date) DO NOTHING
           RETURNING id`,
          [
            lease.landlord_id, lease.tenant_id, lease.id, lease.unit_id,
            invoiceNumber, dueDate,
            lease.rent_amount, subtotalFeesStr, totalAmountStr,
          ]
        )

        if (invoiceRes.rows.length === 0) {
          // Invoice already exists for this cycle — roll back to release reserved number
          await client.query('ROLLBACK')
          continue
        }

        const invoiceId = invoiceRes.rows[0].id as string

        // Rent child row
        await client.query(
          `INSERT INTO payments (
             invoice_id, unit_id, lease_id, tenant_id, landlord_id,
             type, amount, status, due_date, entry_description
           ) VALUES ($1, $2, $3, $4, $5, 'rent', $6, 'pending', $7, $8)`,
          [
            invoiceId, lease.unit_id, lease.id, lease.tenant_id, lease.landlord_id,
            lease.rent_amount, dueDate, `Rent ${dueDate}`,
          ]
        )
        rentsInserted++

        // Monthly fee child rows
        for (const fee of fees) {
          await client.query(
            `INSERT INTO payments (
               invoice_id, unit_id, lease_id, tenant_id, landlord_id,
               type, amount, status, due_date, entry_description, lease_fee_id
             ) VALUES ($1, $2, $3, $4, $5, 'fee', $6, 'pending', $7, $8, $9)`,
            [
              invoiceId, lease.unit_id, lease.id, lease.tenant_id, lease.landlord_id,
              fee.amount, dueDate,
              `${fee.fee_type}${fee.description ? ' — ' + fee.description : ''} ${dueDate}`,
              fee.id,
            ]
          )
          feesInserted++
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
           l.start_date, l.end_date,
           vlat.primary_tenant_id AS tenant_id,
           p.timezone AS property_tz
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id
    WHERE l.status = 'active'
      AND (l.needs_review IS NULL OR l.needs_review = false)
      AND p.timezone = $1
  `, [tz])

  return runGeneration(leases, nowUtc)
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
          console.log(
            `[InvoiceGen][${tz}] invoices=${r.invoicesInserted} ` +
            `rents=${r.rentsInserted} fees=${r.feesInserted}`
          )
        }
      } catch (e) {
        console.error(`[InvoiceGen][${tz}] error:`, e)
      }
    },
    label: 'Invoice generation',
  })
}
