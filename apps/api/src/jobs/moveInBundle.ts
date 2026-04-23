import { DateTime } from 'luxon'
import { daysInMonth } from '@gam/shared'
import { query } from '../db'

// ============================================================
// S25: Move-in bundle generator (dormant until S29 wires into buildLeaseFromDocument)
// Triggered at lease finalize — not on daily cron.
// Generates: prorated first-month rent (if start_date.day > 1) + all move_in fees.
// Proration: actual-days-in-month, rent * days_remaining / days_in_month, round half-even to cent.
// Move-in day is occupied and paid for: days_remaining = daysInMonth - startDay + 1.
// ============================================================

interface MoveInInputs {
  lease_id: string
  unit_id: string
  tenant_id: string | null
  landlord_id: string
  rent_amount: number
  start_date: string  // YYYY-MM-DD
}

export interface MoveInBundleResult {
  proratedRentInserted: boolean
  moveInFeesInserted: number
}

/** Banker's rounding (half-even) to cents. */
export function roundHalfEvenCents(value: number): number {
  const cents = value * 100
  const floor = Math.floor(cents)
  const diff = cents - floor
  if (diff < 0.5) return floor / 100
  if (diff > 0.5) return (floor + 1) / 100
  // exactly .5 -> round to even
  return (floor % 2 === 0 ? floor : floor + 1) / 100
}

/** Prorated rent for a mid-month move-in. Returns 0 if start_date is the 1st. */
export function proratedFirstMonthRent(rentAmount: number, startDate: string): number {
  const dt = DateTime.fromISO(startDate, { zone: 'utc' })
  if (dt.day === 1) return 0
  const dim = daysInMonth(dt.year, dt.month)
  const daysRemaining = dim - dt.day + 1
  return roundHalfEvenCents(rentAmount * daysRemaining / dim)
}

export async function generateMoveInBundle(inputs: MoveInInputs): Promise<MoveInBundleResult> {
  let proratedRentInserted = false
  let moveInFeesInserted = 0

  // Prorated rent (or full rent if start_date is 1st — but generator cron handles day-1 rent, so skip here)
  const prorated = proratedFirstMonthRent(inputs.rent_amount, inputs.start_date)
  if (prorated > 0) {
    const r = await query(`
      INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
      VALUES ($1, $2, $3, $4, 'rent', $5, 'pending', $6, $7)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id, prorated, inputs.start_date,
        `Prorated rent ${inputs.start_date}`])
    proratedRentInserted = r.length > 0
  }

  // All move_in fees on this lease
  const fees = await query<{ id: string; fee_type: string; amount: string; description: string | null }>(`
    SELECT id, fee_type, amount, description
    FROM lease_fees
    WHERE lease_id = $1 AND due_timing = 'move_in'
  `, [inputs.lease_id])

  for (const fee of fees) {
    const r = await query(`
      INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, lease_fee_id)
      VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', $6, $7, $8)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id, fee.amount, inputs.start_date,
        `${fee.fee_type}${fee.description ? ' — ' + fee.description : ''} ${inputs.start_date}`, fee.id])
    if (r.length > 0) moveInFeesInserted++
  }

  return { proratedRentInserted, moveInFeesInserted }
}
