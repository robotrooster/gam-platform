// S624 — settling a rent charge that was paid outside the platform.
//
// This is the money half of `POST /payments/:id/record-manual`, lifted out of
// the route so the BANK-DEPOSIT path can settle a payment the same way the
// landlord's manual entry does.
//
// It is lifted rather than reimplemented on purpose. The rules here are small,
// unobvious and hard-won — who the fee lands on, the one free first payment and
// exactly what disqualifies it, the deliberate absence of an invoice_id on the
// fee row — and every one of them was a separate correction from Nic across
// S570/S607/S609/S620. A second copy would start identical and drift, and the
// drift would be silent because both paths would still "work".
//
// The one thing this adds over the route version is `settledAt`. The route
// settles at NOW() because a landlord recording a payment is recording it as
// they enter it. A bank deposit is different: it happened in the past, and the
// whole value of matching it is that the payment lands on the date the money
// actually moved — see services/depositBackdate.ts for which date that is and
// why a corroborated tenant declaration beats the bank's own posting.

import type { PoolClient } from 'pg'
import { MANUAL_PAYMENT_FEE } from '@gam/shared'
import { chargeLandlord } from './landlordGamAccount'
import type { ManualPaymentMethod } from '@gam/shared'

export interface ManualSettleInput {
  /** The rent `payments` row being satisfied. Caller has already locked it. */
  payment: {
    id: string; landlord_id: string; tenant_id: string | null; unit_id: string
    lease_id: string | null; due_date: string
    manual_fee_payer: string | null
    background_check_status: string | null
  }
  method: ManualPaymentMethod
  /** When the money actually moved. NOW() when a landlord is entering it live. */
  settledAt: Date | null
  reference?: string | null
  /** Extra sentence for the payment's notes — e.g. which bank row proved it. */
  provenance?: string | null
  /**
   * S636 (Nic, DIRECTIVE): does this settle the resident's WHOLE BALANCE, or
   * just the row named?
   *
   * `true` for a landlord taking cash — "it needs to be the same as a card
   * payment. It applies to the entire balance... I can't apply cash to one or
   * the other." Money arrives against what somebody owes, and letting the
   * landlord aim it at one line lets them skip the oldest debt.
   *
   * `false` (the default) for BANK DEPOSIT MATCHING, which is the opposite
   * problem: a deposit is matched to the specific charges it proves, and a late
   * fee genuinely earned before that payment must stay owed. Defaulting to the
   * narrow behaviour keeps every existing caller as it was.
   */
  settleWholeBalance?: boolean
}

export interface ManualSettleResult {
  /**
   * Whether this was the tenant's first satisfied rent on the lease. Returned
   * because it is a DIFFERENT thing to tell a tenant than `feeBilledTo` (S607):
   * "your first one is free" and "your landlord covers this" both produce no
   * charge, but only one of them stops being true next month.
   */
  firstPayment: boolean
  feeWaived: boolean
  feeAmount: number
  feeBilledTo: 'none' | 'landlord' | 'tenant'
  feePaymentId: string | null
}

/**
 * Is this the tenant's first satisfied rent on the lease?
 *
 * S607 (Nic): the ONE thing that makes the fee free. "It's only free the first
 * payment and only if they do cash. If they do any old school payments any other
 * months, that's not free."
 */
async function isFirstSatisfiedRent(
  client: PoolClient, payment: ManualSettleInput['payment'],
): Promise<boolean> {
  const scopeCol = payment.lease_id ? 'lease_id' : 'tenant_id'
  const scopeVal = payment.lease_id ?? payment.tenant_id
  const prior = await client.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM payments
      WHERE ${scopeCol} = $1 AND type = 'rent'
        AND status IN ('settled', 'paid_via_deposit')
        AND id <> $2`,
    [scopeVal, payment.id])
  return parseInt(prior.rows[0].n, 10) === 0
}

export async function settleManualRentPayment(
  client: PoolClient, input: ManualSettleInput,
): Promise<ManualSettleResult> {
  const { payment, method } = input

  const landlordCovers = payment.manual_fee_payer === 'landlord'
  const firstPayment = await isFirstSatisfiedRent(client, payment)

  // S620 (Nic): the free first payment exists to help a landlord MIGRATE the
  // tenants they already have, not as a perk for everyone who signs up. The
  // background check is the discriminator — an existing tenant carried over is
  // never screened, and after onboarding the only way onto a lease is through
  // screening, so the status encodes the window and cannot drift out of sync
  // with it. 'not_started'/'waived'/null all mean nobody ran a check.
  const screened = !['not_started', 'waived', null, undefined]
    .includes(payment.background_check_status as any)
  // S630 (Nic): cash is free. With MANUAL_PAYMENT_FEE at 0 nothing may raise a
  // fee row, a ledger line, or a landlord charge — a $0.00 line on a tenant's
  // statement still reads as being charged for handing over cash.
  const feeApplies = MANUAL_PAYMENT_FEE > 0
  const feeWaived = !feeApplies || (firstPayment && !screened)
  const feeToLandlord = feeApplies && !feeWaived && landlordCovers
  const feeToTenant = feeApplies && !feeWaived && !landlordCovers

  const refNote = input.reference ? ` (ref ${input.reference})` : ''
  const provenance = input.provenance ? ` — ${input.provenance}` : ''
  await client.query(
    // S636 (Nic, DIRECTIVE): CASH SETTLES THE WHOLE BALANCE, LIKE A CARD DOES.
    //
    // "When I apply a manual payment, it needs to be the same as a card payment.
    // It applies to the entire balance. Those need to not be separated... I
    // can't apply cash to one or the other."
    //
    // This settled `WHERE id = $1` — ONE row — so a landlord handed cash chose
    // which of nine line items it landed on. Two things wrong with that: money
    // arrives against a BALANCE, not against a line, and steering it lets the
    // landlord skip the oldest debt, which every other payment path settles
    // first. Nic: "a landlord could pick and choose and apply it only to, you
    // know, not the most outstanding thing."
    //
    // Scoped by LEASE when the row carries one, else by TENANT — the same
    // fallback the fee quote uses, so the quote and the charge cannot drift.
    //
    // Work-trade suspended rows are excluded: they are not owed now. They settle
    // at month close against hours worked, and sweeping them into a cash payment
    // would collect rent somebody's labour already covered.
    `UPDATE payments
        SET status = 'settled',
            settled_at = COALESCE($4::timestamptz, NOW()),
            manual_method = $2,
            platform_held = FALSE,
            notes = COALESCE(notes || ' — ', '') || $3
      WHERE CASE WHEN $5::boolean THEN
              -- Whole balance: cash arrives against what a resident OWES.
              (status IN ('pending', 'failed')
               AND work_trade_suspended_at IS NULL
               AND (CASE WHEN (SELECT lease_id FROM payments WHERE id = $1) IS NOT NULL
                         THEN lease_id = (SELECT lease_id FROM payments WHERE id = $1)
                         ELSE tenant_id = (SELECT tenant_id FROM payments WHERE id = $1) END))
            ELSE id = $1 END`,
    [payment.id, method,
     `Recorded as manual ${method} payment${refNote}${provenance}`,
     input.settledAt, input.settleWholeBalance === true])

  let feePaymentId: string | null = null

  if (feeToLandlord) {
    // The landlord's toggle MOVES the fee, it does not erase it (S607). An
    // earlier cut treated "landlord covers" as "nobody pays", which billed GAM's
    // the fee to no one at all.
    const prev = await client.query<{ balance_after: string }>(
      `SELECT balance_after FROM platform_revenue_ledger
        ORDER BY created_at DESC, id DESC LIMIT 1`)
    const prevBal = prev.rowCount ? parseFloat(prev.rows[0].balance_after) : 0
    await client.query(
      `INSERT INTO platform_revenue_ledger
         (type, amount, balance_after, reference_id, reference_type, property_id, notes)
       SELECT 'manual_withdrawal_fee', $1, $2, $3, 'manual_payment_fee', u.property_id, $4
         FROM units u WHERE u.id = $5
       ON CONFLICT (reference_id, reference_type, type) WHERE reference_id IS NOT NULL
       DO NOTHING`,
      [MANUAL_PAYMENT_FEE.toFixed(2),
       (Math.round((prevBal + MANUAL_PAYMENT_FEE) * 100) / 100).toFixed(2),
       payment.id,
       `$${MANUAL_PAYMENT_FEE.toFixed(2)} manual-payment fee absorbed by the landlord — ${method} rent payment due ${payment.due_date}`,
       payment.unit_id])

    // S620: and RECORD THAT THE LANDLORD OWES IT. Cash moves no money through
    // GAM, so there is nothing to net the fee out of and no trace it was owed —
    // without this GAM books income it has no mechanism to collect.
    const prop = await client.query<{ property_id: string }>(
      `SELECT property_id FROM units WHERE id = $1`, [payment.unit_id])
    await chargeLandlord(client, {
      landlordId: payment.landlord_id,
      propertyId: prop.rows[0]?.property_id ?? null,
      kind: 'manual_payment_fee',
      amount: MANUAL_PAYMENT_FEE,
      sourceType: 'manual_payment_fee',
      sourceId: payment.id,
      notes: `${method} rent payment due ${payment.due_date} — fee absorbed by the landlord`,
    })
  }

  if (feeToTenant) {
    // NO invoice_id, DELIBERATELY (S620, Nic): "let's make sure that one little
    // fee doesn't start accruing extra late fees". The late-fee engine works
    // invoice by invoice, so a row belonging to no invoice is invisible to it and
    // CANNOT grow — which matters most on leases whose late fee accrues DAILY
    // against the outstanding balance. DO NOT attach these to an invoice. The
    // protection is the absence.
    feePaymentId = (await client.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, notes, revenue_owner)
       VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'MANUALPAY', CURRENT_DATE, $6, 'gam')
       RETURNING id`,
      [payment.unit_id, payment.lease_id, payment.tenant_id, payment.landlord_id,
       MANUAL_PAYMENT_FEE.toFixed(2),
       `$${MANUAL_PAYMENT_FEE.toFixed(2)} manual-payment fee — ${method} rent payment due ${payment.due_date}`]
    )).rows[0].id
  }

  return {
    firstPayment,
    feeWaived,
    feeAmount: feeWaived ? 0 : MANUAL_PAYMENT_FEE,
    feeBilledTo: feeWaived ? 'none' : (landlordCovers ? 'landlord' : 'tenant'),
    feePaymentId,
  }
}
