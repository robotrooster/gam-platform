import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'
import { daysInMonth, formatInvoiceNumber } from '@gam/shared'
import { getClient, queryOne } from '../db'
import { logger } from '../lib/logger'

// ============================================================
// S26a: Move-in invoice generator (replaces S25 moveInBundle)
// Called at lease finalize — NOT by daily cron.
// Creates one invoice dated lease.start_date containing:
//   - Rent (prorated if start_date.day > 1, full rent if day=1)
//   - All move_in fees from lease_fees, INCLUDING security_deposit
//     (S196: security_deposit is now a lease_fees row, not a column)
// Security deposit specifically flows into a payments row with
// type='deposit' (not 'fee') for historical audit clarity; all
// other move_in lease_fees create type='fee' rows.
// Idempotent via ux_invoices_lease_due_date.
// ============================================================

interface MoveInInputs {
  lease_id: string
  unit_id: string
  tenant_id: string | null
  landlord_id: string
  rent_amount: number
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

/**
 * Map a lease_fees.fee_type to the NACHA-shaped payments.entry_description
 * enum (CHECK on payments.entry_description). Deposit-shape fee_types map
 * to 'DEPOSIT'; last_month_rent maps to 'RENT' (it IS prepaid rent);
 * everything else to 'SUBSCRIP'.
 */
function entryDescriptionForFeeType(feeType: string): 'DEPOSIT' | 'RENT' | 'SUBSCRIP' {
  if (feeType === 'pet_deposit' || feeType === 'key_deposit' || feeType === 'cleaning_deposit') return 'DEPOSIT'
  if (feeType === 'last_month_rent') return 'RENT'
  return 'SUBSCRIP'
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

    // S196: security_deposit is now a lease_fees row inside `fees`.
    // Pull it out for the dedicated type='deposit' payment row, and
    // exclude it from the fee-loop total so it doesn't double-count.
    const depositFee = fees.find(f => f.fee_type === 'security_deposit')
    const fullDepositAmount = depositFee ? Number(depositFee.amount) : 0
    const nonDepositFees = fees.filter(f => f.fee_type !== 'security_deposit')
    const feesTotal = nonDepositFees.reduce((s, f) => s + Number(f.amount), 0)

    // S246: FlexDeposit branch. When the tenant has enrolled BEFORE
    // move-in, the deposit line is excluded from the landlord-facing
    // invoice entirely — landlord sees only rent + non-deposit fees;
    // their "Security Deposits" page shows "funded" via the GAM
    // gap-front Transfer. Tenant pays installment 1 alongside rent +
    // fees in the combined move-in PI; remaining N-1 installments
    // are scheduled via flex_deposit_installments rows (created at
    // enroll time before this generator runs).
    let depositAmountForInvoice = fullDepositAmount
    let firstInstallmentAmount = 0
    let flexDepositActive = false
    let flexDepositSecurityDepositId: string | null = null
    if (depositFee && inputs.tenant_id) {
      const fdRow = await client.query<{ id: string; flex_deposit_enabled: boolean; first_amount: string | null }>(
        `SELECT sd.id, sd.flex_deposit_enabled,
                (SELECT amount::text FROM flex_deposit_installments
                  WHERE security_deposit_id = sd.id AND installment_number = 1) AS first_amount
           FROM security_deposits sd
          WHERE sd.tenant_id = $1 AND sd.lease_id = $2
          LIMIT 1`,
        [inputs.tenant_id, inputs.lease_id],
      )
      if (fdRow.rows[0]?.flex_deposit_enabled && fdRow.rows[0]?.first_amount) {
        flexDepositActive = true
        flexDepositSecurityDepositId = fdRow.rows[0].id
        firstInstallmentAmount = Number(fdRow.rows[0].first_amount)
        // Invoice deposit line disappears; landlord doesn't see
        // anything deposit-related on this invoice.
        depositAmountForInvoice = 0
      }
    }
    const totalAmount = rentForMoveIn + feesTotal + depositAmountForInvoice + firstInstallmentAmount

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
        depositAmountForInvoice.toFixed(2),
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
       ) VALUES ($1, $2, $3, $4, $5, 'rent', $6, 'pending', $7, 'RENT')`,
      [
        invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
        rentForMoveIn.toFixed(2), inputs.start_date,
      ]
    )

    let moveInFeesInserted = 0
    for (const fee of nonDepositFees) {
      await client.query(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description, lease_fee_id
         ) VALUES ($1, $2, $3, $4, $5, 'fee', $6, 'pending', $7, $8, $9)`,
        [
          invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          fee.amount, inputs.start_date,
          entryDescriptionForFeeType(fee.fee_type),
          fee.id,
        ]
      )
      moveInFeesInserted++
    }

    let depositInserted = false
    if (depositAmountForInvoice > 0) {
      await client.query(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description
         ) VALUES ($1, $2, $3, $4, $5, 'deposit', $6, 'pending', $7, 'DEPOSIT')`,
        [
          invoiceId, inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          depositAmountForInvoice.toFixed(2), inputs.start_date,
        ]
      )
      depositInserted = true
    }

    // S246: FlexDeposit installment 1 payment row. Tagged
    // entry_description='DEPOSIT' so allocation + audit treats it
    // consistently with the regular deposit. The payments row carries
    // the installment-1 amount (full deposit minus GAM-fronted gap);
    // landlord doesn't see this row tied to their dashboard because
    // it's NOT linked to the invoice (invoice_id=NULL) — its
    // visibility is tenant-side only.
    let flexDepositInstallment1PaymentId: string | null = null
    if (flexDepositActive && firstInstallmentAmount > 0) {
      const inst1 = await client.query<{ id: string }>(
        `INSERT INTO payments (
           unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description, notes
         ) VALUES ($1, $2, $3, $4, 'deposit', $5, 'pending', $6, 'DEPOSIT', $7)
         RETURNING id`,
        [
          inputs.unit_id, inputs.lease_id, inputs.tenant_id, inputs.landlord_id,
          firstInstallmentAmount.toFixed(2), inputs.start_date,
          `FlexDeposit installment 1 (deposit ${flexDepositSecurityDepositId})`,
        ]
      )
      flexDepositInstallment1PaymentId = inst1.rows[0].id
    }

    if (ownsTx) await client.query('COMMIT')

    // S246: post-commit FlexDeposit settlement. Flips installment 1
    // to settled + fires the GAM-gap Connect Transfer to landlord
    // (outside the DB tx — network round-trip). Best-effort: if the
    // Transfer fails, an admin notification + transfer_error row is
    // recorded; the deposit row is still marked partial-funded and
    // a retry path runs in the cron.
    if (flexDepositActive && flexDepositSecurityDepositId && flexDepositInstallment1PaymentId && inputs.tenant_id) {
      try {
        const { settleFlexDepositMoveIn } = await import('../services/flexDeposit')
        await settleFlexDepositMoveIn({
          tenantId:           inputs.tenant_id,
          securityDepositId:  flexDepositSecurityDepositId,
          movInPaymentId:     flexDepositInstallment1PaymentId,
        })
      } catch (e) {
        logger.error({ err: e, security_deposit_id: flexDepositSecurityDepositId }, '[moveIn][flex-deposit-settle]')
        // Don't throw — invoice is created, tenant payment will
        // succeed separately. S260: no Connect Transfer at move-in
        // (all FlexDeposit deposits gam_escrow); the only inside-tx
        // work here is flipping installment 1 status + deposit
        // counters, no money movement.
      }
    }

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
