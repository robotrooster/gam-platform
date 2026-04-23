import { DateTime } from 'luxon'
import { query } from '../db'

// ============================================================
// S25: Rent + recurring-fee ledger row generator
// Daily cron. Idempotent via partial unique indexes on payments.
// One month horizon: on/after the 1st of month M, generates rows for month M+1.
// ============================================================

interface ActiveLease {
  id: string
  unit_id: string
  landlord_id: string
  rent_amount: string       // numeric -> string from pg
  rent_due_day: number
  tenant_id: string | null  // from v_lease_active_tenants (primary)
  property_tz: string
}

interface MonthlyFee {
  id: string
  lease_id: string
  fee_type: string
  amount: string
  description: string | null
}

/**
 * Compute the next billing-cycle due_date for a lease, relative to "today" in property tz.
 * Rule: if today's day-of-month >= rent_due_day, next due is rent_due_day of next month;
 *       else next due is rent_due_day of current month.
 * Caps day to last-of-month (e.g. rent_due_day=31 in Feb -> Feb 28/29).
 */
export function nextRentDueDate(todayInTz: DateTime, rentDueDay: number): string {
  let target: DateTime
  if (todayInTz.day >= rentDueDay) {
    target = todayInTz.plus({ months: 1 }).startOf('month')
  } else {
    target = todayInTz.startOf('month')
  }
  const cappedDay = Math.min(rentDueDay, target.daysInMonth!)
  target = target.set({ day: cappedDay })
  return target.toISODate()!
}

export async function generateRentAndFees(nowUtc: Date = new Date()): Promise<{ rentsInserted: number; feesInserted: number; leasesProcessed: number }> {
  const leases = await query<ActiveLease>(`
    SELECT l.id, l.unit_id, l.landlord_id, l.rent_amount, l.rent_due_day,
           vlat.primary_tenant_id AS tenant_id,
           COALESCE(p.timezone, 'America/Phoenix') AS property_tz
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id
    WHERE l.status = 'active'
  `)

  let rentsInserted = 0
  let feesInserted = 0

  for (const lease of leases) {
    const todayInTz = DateTime.fromJSDate(nowUtc, { zone: lease.property_tz })
    const dueDate = nextRentDueDate(todayInTz, lease.rent_due_day)

    // Respect lease end_date — don't generate rows past lease end
    const lease_end = await query<{ end_date: string | null }>(
      `SELECT end_date FROM leases WHERE id = $1`, [lease.id]
    )
    if (lease_end[0]?.end_date && dueDate > lease_end[0].end_date) {
      continue
    }

    // Insert rent row (idempotent via ux_payments_rent_idempotent)
    const rentResult = await query(`
      INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
      VALUES ($1, $2, $3, $4, 'rent', $5, 'pending', $6, $7)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [lease.unit_id, lease.id, lease.tenant_id, lease.landlord_id, lease.rent_amount, dueDate, `Rent ${dueDate}`])
    if (rentResult.length > 0) rentsInserted++

    // Monthly-ongoing fees for this lease
    const fees = await query<MonthlyFee>(`
      SELECT id, lease_id, fee_type, amount, description
      FROM lease_fees
      WHERE lease_id = $1 AND due_timing = 'monthly_ongoing'
    `, [lease.id])

    for (const fee of fees) {
      const feeResult = await query(`
        INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, lease_fee_id)
        VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', $6, $7, $8)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [lease.unit_id, lease.id, lease.tenant_id, lease.landlord_id, fee.amount, dueDate,
          `${fee.fee_type}${fee.description ? ' — ' + fee.description : ''} ${dueDate}`, fee.id])
      if (feeResult.length > 0) feesInserted++
    }
  }

  return { rentsInserted, feesInserted, leasesProcessed: leases.length }
}
