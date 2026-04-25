import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'
import { daysInMonth, formatInvoiceNumber } from '@gam/shared'
import { getClient } from '../db'

// ============================================================
// S26a: Move-in invoice generator (replaces S25 moveInBundle)
// Called at lease finalize — NOT by daily cron.
// Creates one invoice dated lease.start_date containing:
//   - Rent (prorated if start_date.day > 1, full rent if day=1)
//   - All move_in fees from lease_fees
//   - Security deposit from leases.security_deposit (if > 0)
// Idempotent via ux_invoices_lease_due_date.
// ============================================================

interface MoveInInputs {
  lease_id: string
  unit_id: string
  tenant_id: string | null
  landlord_id: string
  rent_amount: number
  security_deposit: number    // from leases.security_deposit
  start_date: string          // YYYY-MM-DD
}

export interface MoveInBundleResult {
  invoiceCreated: boolean
  invoiceId: string | null
  invoiceNumber: string | null
  rentAmount: number
  moveInFeesInserted: number
  depositInserted: boolean
}

/** Banker's rounding (half-even) to cents. */
export function roundHalfEvenCents(value: number): number {
  const cents = value * 100
  const floor = Math.floor(cents)
  const diff = cents - floor
  if (diff < 0.5) return floor / 100
  if (diff > 0.5) return (floor + 1) / 100
  return (floor % 2 === 0 ? floor : floor + 1) / 100
}

/** Rent for the move-in invoice. Prorated if start_date.day > 1, full rent if day == 1. */
export function moveInRentAmount(rentAmount: number, startDate: string): number {
  const dt = DateTime.fromISO(startDate, { zone: 'utc' })
  if (dt.day === 1) return roundHalfEvenCents(rentAmount)
  const dim = daysInMonth(dt.year, dt.month)
  const daysRemaining = dim - dt.day + 1
  return roundHalfEvenCents(rentAmount * daysRemaining / dim)
}

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
  return formatInvoiceNumber(year, nextAfter - 1)
}

export async function generateMoveInInvoice(
  inputs: MoveInInputs,
  externalClient?: PoolClient
): Promise<MoveInBundleResult> {
  const rentForMoveIn = moveInRentAmount(inputs.rent_amount, inputs.start_date)

  // S28: optional caller-owned transaction. When externalClient is provided,
  // skip BEGIN/COMMIT/ROLLBACK/release — caller owns the tx lifecycle.
  // Standalone call path (no externalClient) preserved for catch-up backfill
  // and any other one-shot invoice generation.
  const ownsTx = !externalClient
  const client: PoolClient = externalClient || await getClient()

  // Query fees on the same connection as the writes. When caller owns the
  // transaction, lease_fees rows they just inserted are invisible from a
  // separate pool connection at READ COMMITTED. Reading via `client` ensures
  // we see the in-flight inserts.
  const feesRes = await client.query(
    `SELECT id, fee_type, amount, description
     FROM lease_fees
     WHERE lease_id = $1 AND due_timing = 'move_in'`,
    [inputs.lease_id]
  )
  const fees = feesRes.rows as Array<{
    id: string; fee_type: string; amount: string; description: string | null
  }>

  try {
    if (ownsTx) await client.query('BEGIN')

    const year = DateTime.fromISO(inputs.start_date).year
    const invoiceNumber = await allocateInvoiceNumber(client, inputs.landlord_id, year)

    const feesTotal = fees.reduce((s, f) => s + Number(f.amount), 0)
    const depositAmount = Number(inputs.security_deposit) || 0
    const totalAmount = rentForMoveIn + feesTotal + depositAmount

    const invoiceRes = await client.query(
      `INSERT INTO invoices (
         landlord_id, tenant_id, lease_id, unit_id,
         invoice_number, due_date,
         subtotal_rent, subtotal_fees, subtotal_deposits, total_amount
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (lease_id, due_date) DO NOTHING
       RETURNING id`,
      [
        inputs.landlord_id, inputs.tenant_id, inputs.lease_id, inputs.unit_id,
        invoiceNumber, inputs.start_date,
        rentForMoveIn.toFixed(2),
        feesTotal.toFixed(2),
        depositAmount.toFixed(2),
        totalAmount.toFixed(2),
      ]
    )

    if (invoiceRes.rows.length === 0) {
      // Idempotent skip — invoice already exists for (lease_id, due_date).
      // Owns-tx case: roll back the BEGIN we issued (nothing else dirty).
      // Caller-owns case: do nothing — caller decides commit vs rollback.
      if (ownsTx) await client.query('ROLLBACK')
      return {
        invoiceCreated: false,
        invoiceId: null,
        invoiceNumber: null,
        rentAmount: rentForMoveIn,
        moveInFeesInserted: 0,
        depositInserted: false,
      }
    }

    const invoiceId = invoiceRes.rows[0].id as string

    await client.query(
      `INSERT INTO payments (
         invoice_id, unit_id, lease_id, tenant_id, landlord_id,
         type, amount, status, due_date, entry_description
       ) VALUES ($1, $2, $3, $4, $5, 'rent', $6, 'pending', $7, $8)`,
      [
        invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
        rentForMoveIn.toFixed(2), inputs.start_date,
        `Move-in rent ${inputs.start_date}`,
      ]
    )

    let moveInFeesInserted = 0
    for (const fee of fees) {
      await client.query(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description, lease_fee_id
         ) VALUES ($1, $2, $3, $4, $5, 'fee', $6, 'pending', $7, $8, $9)`,
        [
          invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          fee.amount, inputs.start_date,
          `${fee.fee_type}${fee.description ? ' — ' + fee.description : ''} ${inputs.start_date}`,
          fee.id,
        ]
      )
      moveInFeesInserted++
    }

    let depositInserted = false
    if (depositAmount > 0) {
      await client.query(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description
         ) VALUES ($1, $2, $3, $4, $5, 'deposit', $6, 'pending', $7, $8)`,
        [
          invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          depositAmount.toFixed(2), inputs.start_date,
          `Security deposit ${inputs.start_date}`,
        ]
      )
      depositInserted = true
    }

    if (ownsTx) await client.query('COMMIT')

    return {
      invoiceCreated: true,
      invoiceId,
      invoiceNumber,
      rentAmount: rentForMoveIn,
      moveInFeesInserted,
      depositInserted,
    }
  } catch (e) {
    if (ownsTx) await client.query('ROLLBACK')
    throw e
  } finally {
    if (ownsTx) client.release()
  }
}
