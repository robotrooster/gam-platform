// S624 — turning a matched bank deposit into a settled rent payment.
//
// This is where the two promises made to a cash-paying tenant are actually kept:
// that their payment gets found, dated and applied without them chasing anyone,
// and that they do not eat a late fee for the days the money sat in transit.
// Everything upstream (services/bankDepositMatch.ts, services/depositBackdate.ts)
// is inference and arithmetic; this is the only part that moves money.
//
// THE DATE IS THE WHOLE POINT. A landlord recording a payment by hand settles it
// at NOW(), because that is when they are doing it. A deposit happened in the
// past, so it settles on the date the money actually moved — the tenant's own
// declared date when a bank row corroborates it, otherwise the bank's posting.
// Late fees that accrued after that date were charged for an absence that was
// not real, and are undone.
//
// WHAT IS NOT ERASED. GAM does not delete money records (standing retention
// rule). A late fee the tenant has ALREADY PAID cannot be un-charged, so it
// comes back as a `late_fee_refund` credit — visible, attributable, reversible.
// Only an unpaid tick is zeroed, and even then the row survives with a note
// saying why. Nobody should ever have to guess where a charge went.

import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { settleManualRentPayment } from './manualPaymentSettle'
import { backdateLateFees, effectivePaidDateFor, type LateFeeTick } from './depositBackdate'
import { createNotification } from './notifications'
import { logger } from '../lib/logger'
import type { ManualPaymentMethod } from '@gam/shared'

export interface ConfirmDepositInput {
  bankTransactionId: string
  /** Rent `payments` rows this deposit settles. */
  chargeIds: string[]
  method: ManualPaymentMethod
  /** Set when a tenant declaration produced this match. */
  declarationId?: string | null
  /** Who confirmed it — null when the system auto-settled on two signals. */
  confirmedByUserId?: string | null
}

export interface ConfirmDepositResult {
  settledChargeIds: string[]
  effectivePaidDate: string
  lateFeesUnbilled: number
  lateFeesRefunded: number
  feeBilledTo: 'none' | 'landlord' | 'tenant'
}

/**
 * Undo the late fees an invoice accrued after the rent was really paid.
 *
 * Returns what was unbilled and what was refunded — two different acts, kept
 * apart deliberately. See depositBackdate.ts.
 */
async function reverseLateFees(
  client: PoolClient, invoiceId: string, effectivePaidDate: string,
  tenantId: string | null, landlordId: string, leaseId: string | null,
): Promise<{ unbilled: number; refunded: number }> {
  const { rows } = await client.query(
    `SELECT p.id, to_char(p.due_date,'YYYY-MM-DD') AS tick_date,
            p.amount::float AS amount, p.status
       FROM payments p
      WHERE p.invoice_id = $1 AND p.type = 'late_fee'
        AND p.status <> 'failed'`,
    [invoiceId])
  if (rows.length === 0) return { unbilled: 0, refunded: 0 }

  const ticks: LateFeeTick[] = rows.map((r: any) => ({
    paymentId: r.id, tickDate: r.tick_date, amount: Number(r.amount),
    settled: r.status === 'settled' || r.status === 'paid_via_deposit',
  }))
  const out = backdateLateFees(ticks, effectivePaidDate)

  for (const t of out.reversedTicks) {
    if (t.settled) continue   // already paid — refunded as a credit below
    // Zeroed, not deleted. The row and its history stay, with the reason on it.
    await client.query(
      `UPDATE payments
          SET amount = 0, status = 'settled', settled_at = NOW(),
              notes = COALESCE(notes || ' — ', '') ||
                      'Reversed: rent was paid ' || $2::text || ', before this fee accrued'
        WHERE id = $1`,
      [t.paymentId, effectivePaidDate])
  }

  if (out.refundAmount > 0 && tenantId) {
    await client.query(
      `INSERT INTO tenant_credits
         (landlord_id, tenant_id, lease_id, amount_original, amount_remaining,
          category, reason)
       VALUES ($1,$2,$3,$4,$4,'late_fee_refund',$5)`,
      [landlordId, tenantId, leaseId,
       out.refundAmount.toFixed(2),
       `Late fees refunded — the bank shows rent was paid on ${effectivePaidDate}`])
  }

  return { unbilled: out.unbillAmount, refunded: out.refundAmount }
}

/**
 * Confirm a deposit against the charges it paid.
 *
 * Runs in ONE transaction across every charge: a deposit that settles rent but
 * fails to reverse the late fee it made unnecessary would leave the tenant worse
 * off than before anyone helped them.
 */
export async function confirmDepositMatch(
  input: ConfirmDepositInput,
): Promise<ConfirmDepositResult> {
  if (input.chargeIds.length === 0) {
    throw new AppError(400, 'A deposit needs at least one charge to settle')
  }
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const txn = (await client.query(
      `SELECT id, landlord_id, amount::float AS amount,
              to_char(posted_date,'YYYY-MM-DD') AS posted_date, status
         FROM bank_transactions WHERE id = $1 FOR UPDATE`,
      [input.bankTransactionId])).rows[0]
    if (!txn) throw new AppError(404, 'Bank transaction not found')
    // One deposit settles one set of charges, once. Without this a retried
    // confirm would settle the same rent twice off one deposit.
    if (txn.status === 'matched') {
      throw new AppError(409, 'This deposit has already been matched')
    }
    if (!(txn.amount > 0)) {
      throw new AppError(400, 'Only a deposit can settle a charge')
    }

    let declaredDate: string | null = null
    if (input.declarationId) {
      const d = (await client.query(
        `SELECT to_char(declared_date,'YYYY-MM-DD') AS declared_date, status
           FROM tenant_declared_deposits WHERE id = $1 FOR UPDATE`,
        [input.declarationId])).rows[0]
      if (!d) throw new AppError(404, 'Declaration not found')
      if (d.status !== 'pending') {
        throw new AppError(409, `That report is already ${d.status}`)
      }
      declaredDate = d.declared_date
    }

    const effectivePaidDate = effectivePaidDateFor(declaredDate, txn.posted_date)

    const charges = (await client.query(
      `SELECT p.id, p.type, p.status, p.landlord_id, p.tenant_id, p.unit_id,
              p.lease_id, p.invoice_id, to_char(p.due_date,'YYYY-MM-DD') AS due_date,
              COALESCE(par.manual_fee_payer, 'tenant') AS manual_fee_payer,
              t.background_check_status,
              u.payment_block
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         LEFT JOIN tenants t ON t.id = p.tenant_id
         LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
        WHERE p.id = ANY($1::uuid[])
        FOR UPDATE OF p`,
      [input.chargeIds])).rows

    if (charges.length !== input.chargeIds.length) {
      throw new AppError(404, 'One of those charges no longer exists')
    }
    for (const c of charges) {
      if (c.landlord_id !== txn.landlord_id) {
        throw new AppError(403, 'That deposit belongs to a different landlord')
      }
      // Matches the manual-entry route: accepting landlord-bound money during an
      // eviction hold can reset the timeline.
      if (c.payment_block) {
        throw new AppError(409, 'This unit is in eviction mode — recording a payment is paused.')
      }
      if (c.status !== 'pending' && c.status !== 'failed') {
        throw new AppError(409, 'One of those charges is no longer open')
      }
    }

    const settledAt = new Date(`${effectivePaidDate}T12:00:00Z`)
    let feeBilledTo: ConfirmDepositResult['feeBilledTo'] = 'none'
    let unbilled = 0
    let refunded = 0
    const invoicesTouched = new Set<string>()

    for (const c of charges) {
      if (c.type === 'rent') {
        // Only a rent charge carries the manual-payment fee — the fee is per
        // manual RENT payment, not per row the deposit happened to cover.
        const r = await settleManualRentPayment(client, {
          payment: c,
          method: input.method,
          settledAt,
          provenance: `matched to a bank deposit posted ${txn.posted_date}`,
        })
        if (r.feeBilledTo !== 'none') feeBilledTo = r.feeBilledTo
      } else {
        await client.query(
          `UPDATE payments
              SET status='settled', settled_at=$2, platform_held=FALSE,
                  manual_method=$3,
                  notes = COALESCE(notes || ' — ', '') ||
                          'Settled by a bank deposit posted ' || $4::text
            WHERE id=$1`,
          [c.id, settledAt, input.method, txn.posted_date])
      }
      if (c.invoice_id) invoicesTouched.add(c.invoice_id)
    }

    for (const invoiceId of invoicesTouched) {
      const head = charges.find((c: any) => c.invoice_id === invoiceId)
      const r = await reverseLateFees(client, invoiceId, effectivePaidDate,
        head.tenant_id, head.landlord_id, head.lease_id)
      unbilled += r.unbilled
      refunded += r.refunded
    }

    // S624: record EVERY charge this deposit settled, not just the first.
    // matched_payment_id stays populated with the head charge because the
    // disbursement auto-match still reads it; the allocation rows are the
    // complete record, and the basis for the on-site cash control (a rent marked
    // collected in person with NO allocation row is money not yet banked).
    for (const c of charges) {
      await client.query(
        `INSERT INTO bank_deposit_allocations
           (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
         SELECT $1, $2, $3, p.amount, $4::date FROM payments p WHERE p.id = $2
         ON CONFLICT (bank_transaction_id, payment_id) DO NOTHING`,
        [txn.id, c.id, txn.landlord_id, effectivePaidDate])
    }

    await client.query(
      `UPDATE bank_transactions
          SET status='matched', matched_payment_id=$2, updated_at=NOW()
        WHERE id=$1`,
      [txn.id, charges[0].id])

    if (input.declarationId) {
      await client.query(
        `UPDATE tenant_declared_deposits
            SET status='confirmed', bank_transaction_id=$2, confirmed_at=NOW(),
                updated_at=NOW()
          WHERE id=$1`,
        [input.declarationId, txn.id])
    }

    await client.query('COMMIT')

    // Notifications are deliberately OUTSIDE the transaction and never fatal.
    // A failed email must not roll back a settled rent payment.
    void notifyBothSides({
      charges, effectivePaidDate, unbilled, refunded, amount: txn.amount,
    }).catch(e => logger.error({ err: e }, '[deposit-confirm] notify failed'))

    return {
      settledChargeIds: charges.map((c: any) => c.id),
      effectivePaidDate,
      lateFeesUnbilled: unbilled,
      lateFeesRefunded: refunded,
      feeBilledTo,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Tell both parties, with the REASON (Nic, S624).
 *
 * A money figure must never change silently on either side. The tenant needs to
 * know their late fee went away and why; the landlord needs to see the reversal
 * on their own ledger rather than discovering a number moved.
 */
async function notifyBothSides(o: {
  charges: any[]; effectivePaidDate: string
  unbilled: number; refunded: number; amount: number
}): Promise<void> {
  const head = o.charges[0]
  const reversed = o.unbilled + o.refunded

  const tenantUser = head.tenant_id ? (await (await import('../db')).queryOne<{ user_id: string }>(
    `SELECT user_id FROM tenants WHERE id=$1`, [head.tenant_id]))?.user_id : null
  if (tenantUser) {
    const lateLine = reversed > 0
      ? ` Your late ${reversed === o.refunded ? 'fee has been refunded' : 'fees have been removed'} — $${reversed.toFixed(2)} — because your deposit shows you paid on ${o.effectivePaidDate}.`
      : ''
    await createNotification({
      userId: tenantUser,
      type: 'payment_recorded',
      title: 'Your bank deposit has been applied',
      body: `We matched your $${o.amount.toFixed(2)} deposit and applied it to your rent, dated ${o.effectivePaidDate}.${lateLine}`,
      actionUrl: '/payments',
    })
  }

  const landlordUser = (await (await import('../db')).queryOne<{ owner_user_id: string }>(
    `SELECT user_id AS owner_user_id FROM landlords WHERE id=$1`, [head.landlord_id]))?.owner_user_id
  if (landlordUser) {
    const lateLine = reversed > 0
      ? ` $${reversed.toFixed(2)} in late fees was reversed — the deposit is dated ${o.effectivePaidDate}.`
      : ''
    await createNotification({
      userId: landlordUser,
      landlordId: head.landlord_id,
      // Reuses the existing landlord type so this lands in the same place as
      // every other "your rent arrived" notice, and honours the same preference.
      type: 'rent_collected',
      title: 'A bank deposit was applied to rent',
      body: `A $${o.amount.toFixed(2)} deposit was matched to rent and recorded as paid ${o.effectivePaidDate}.${lateLine}`,
      actionUrl: '/payments',
    })
  }
}
