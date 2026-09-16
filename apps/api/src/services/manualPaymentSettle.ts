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
import { activateBillingForSettledRent } from './billingActivation'
import { MANUAL_PAYMENT_FEE } from '@gam/shared'
import { chargeLandlord } from './landlordGamAccount'
import { AppError } from '../middleware/errorHandler'
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
  /**
   * S637 (Nic): what the resident actually handed over, when it is known.
   *
   * "If somebody were to come in with five hundred dollars for four hundred and
   * sixty dollar rent, they would probably expect forty dollar change. But if
   * they wanted to leave it as credit for the future, that should also be a
   * 'hey, I'm clicking that I didn't give them change, add forty dollar credit
   * to their account' sort of thing."
   *
   * The desk already computed change on screen and threw the number away, so a
   * cash overpayment could never become a credit the way a card one does.
   *
   * Omitted keeps the old behaviour exactly — the bank-deposit match path never
   * knows a tendered amount, and check/money order are written for the amount.
   */
  amountTendered?: number | null
  /**
   * What to do with anything over the balance. REQUIRED once there is a
   * surplus — see the check below for why there is no default.
   */
  surplusHandling?: 'change' | 'credit'
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
  /** S637: the rows this settled — what the receipt itemises. */
  settledPaymentIds: string[]
  /** S637: what this settled, and what became of any surplus. */
  amountSettled: number
  /** S638: how much of the bill a credit covered, so the receipt can say so. */
  creditUsed: number
  surplus: number
  creditId: string | null
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

  // ── S637 (Nic, DIRECTIVE): CASH IS GOING LIVE, TOO ──────────────────
  //
  // "You need to count manual logged transactions as well. It's not only money
  // flowing through the system. It's money logged in the system."
  //
  // activateBillingForSettledRent was called from ONE place — the Stripe
  // webhook. A landlord collecting cash never triggered it, so their
  // onboarding grace never ended and the platform fee was never billed. Oak
  // Park is the live example: three signed leases and Russ Fuller's rent
  // settled in cash, with billing_starts_at still NULL.
  //
  // Same call the card path makes, in the same transaction that settles.
  // The route refuses anything that is not rent before reaching here
  // ("Only rent charges can be recorded as a manual payment"), and the helper
  // re-checks type itself, so passing the id is enough.
  await activateBillingForSettledRent(client, [payment.id])

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
  // ── S637: WHAT IS ACTUALLY OWED, measured BEFORE the settle ────────────
  //
  // The surplus is derived here, from the same predicate the UPDATE below uses,
  // rather than trusted from the caller. The desk types what was handed over;
  // what it is owed against is the ledger's business, and after the UPDATE
  // every one of these rows reads 'settled' so the figure is gone.
  const owedRow = await client.query<{ owed: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS owed
       FROM payments
      WHERE CASE WHEN $2::boolean THEN
              (status IN ('pending', 'failed')
               AND work_trade_suspended_at IS NULL
               AND (CASE WHEN (SELECT lease_id FROM payments WHERE id = $1) IS NOT NULL
                         THEN lease_id = (SELECT lease_id FROM payments WHERE id = $1)
                         ELSE tenant_id = (SELECT tenant_id FROM payments WHERE id = $1) END))
            ELSE id = $1 END`,
    [payment.id, input.settleWholeBalance === true])
  const chargesOpen = Math.round(Number(owedRow.rows[0]?.owed ?? 0) * 100) / 100

  // ── S638 (Nic): THE CREDIT COMES OFF BEFORE THE DESK ASKS FOR MONEY ──────
  //
  //   "On the payments page it's still showing the $935.45. It's not showing
  //    the credit. When I go to record payment, it still thinks she owes the
  //    full amount, and the payments page does not take partial payments."
  //
  // Kim Harland stood at the desk holding a $450 credit while this route
  // demanded the gross bill and refused $485.45 as short. A credit is money the
  // landlord already owes back — it reduces the ask, exactly as it does in the
  // tenant's own pay flow (services/rentCharge.ts) and on the landlord's
  // outstanding list (routes/balances.ts). This was the one place that had not
  // been taught.
  const creditRow = await client.query<{ credit: string }>(
    `SELECT COALESCE(SUM(amount_remaining), 0)::text AS credit
       FROM tenant_credits
      WHERE tenant_id = $1 AND status = 'active' AND amount_remaining > 0
        -- S648: a general credit is only the issuing landlord's to give
        AND (lease_id = $2 OR (lease_id IS NULL AND landlord_id = $3))`,
    [payment.tenant_id, payment.lease_id, payment.landlord_id])
  const creditAvailable = Math.round(Number(creditRow.rows[0]?.credit ?? 0) * 100) / 100
  const creditUsed = Math.min(creditAvailable, chargesOpen)
  const amountSettled = Math.round((chargesOpen - creditUsed) * 100) / 100

  // Rent is pay-in-full platform-wide — a partial can reset a landlord's
  // eviction clock (standing directive). The desk blocks a short cash entry in
  // the UI; this is the same rule on the server, and it only applies when a
  // tendered amount was supplied at all.
  const tendered = input.amountTendered == null
    ? null : Math.round(Number(input.amountTendered) * 100) / 100
  if (tendered != null && tendered < amountSettled - 0.005) {
    throw new AppError(422,
      `That is $${(amountSettled - tendered).toFixed(2)} short — $${tendered.toFixed(2)} against ` +
      `$${amountSettled.toFixed(2)} owed. Rent is paid in full.`)
  }
  const surplus = tendered == null
    ? 0 : Math.round(Math.max(0, tendered - amountSettled) * 100) / 100

  // S637 (Nic, DIRECTIVE): THE CHOICE IS MADE, NEVER ASSUMED.
  //
  //   "They either have to pick handed back change or keep his credit. Leaving
  //    it vaguely defaulted on one side when the person was like, hey, you were
  //    supposed to add credit — it needs to be manually clicked by the person
  //    taking the cash. That way no mistakes could happen."
  //
  // A default is a silent answer to a question only the person holding the
  // money can answer, and both wrong answers are expensive: defaulting to
  // change loses a resident's money, defaulting to credit says a landlord kept
  // cash they handed back. Refuse instead of guessing.
  // S648 (Nic, DIRECTIVE): ONLY CASH GETS CHANGE.
  //
  //   "If somebody gives me a check that's too much, it needs to only be for
  //    credit. They can't get change back. They can't write a check for a
  //    hundred dollars over the rent and use it like an ATM and just get cash
  //    out of the drawer... it looks like we brought in more money than we did."
  //
  // A check or money order over the balance is money on the account, full
  // stop. Refused, not quietly converted: whoever is at the desk must not
  // believe they recorded handing cash back.
  if (surplus > 0 && input.method !== 'cash' && input.surplusHandling === 'change') {
    throw new AppError(422,
      `No change can be given on a ${input.method === 'money_order' ? 'money order' : 'check'}. ` +
      `The $${surplus.toFixed(2)} over the balance stays on their account as credit.`)
  }
  if (surplus > 0 && input.surplusHandling !== 'change' && input.surplusHandling !== 'credit') {
    throw new AppError(422,
      `That is $${surplus.toFixed(2)} over the $${amountSettled.toFixed(2)} owed. ` +
      'Say whether the change was handed back or kept as credit.')
  }

  const settledRows = await client.query<{ id: string }>(
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
            ELSE id = $1 END
    RETURNING id`,
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

  // ── S637: BANK THE SURPLUS, when the landlord says they kept it ────────
  //
  // Same row the card path writes (routes/webhooks.ts banks an over-remittance
  // identically), so everything downstream is already built: rentCharge.ts nets
  // both credit tables off the balance BEFORE the pay-in-full gate, which is
  // what lets the resident pay the reduced amount next month without it reading
  // as a partial.
  //
  // 'change' is a real answer, not a no-op — the money left with the resident,
  // so there is nothing to record. Defaulting to it means a landlord who never
  // touches the choice cannot accidentally credit cash they handed back.
  // Spend the credit that just covered part of this bill. Drawn oldest first,
  // and only by what was actually used — never by settling a line item, which
  // is what chopped Kim's $450 into a water row, a trash row and five late fees.
  if (creditUsed > 0) {
    let left = creditUsed
    const open = await client.query<{ id: string; amount_remaining: string }>(
      `SELECT id, amount_remaining::text FROM tenant_credits
        WHERE tenant_id = $1 AND status = 'active' AND amount_remaining > 0
          AND (lease_id = $2 OR (lease_id IS NULL AND landlord_id = $3))
        ORDER BY (lease_id IS NULL), created_at`, [payment.tenant_id, payment.lease_id, payment.landlord_id])
    for (const c of open.rows) {
      if (left <= 0) break
      const take = Math.min(left, Number(c.amount_remaining))
      await client.query(
        // Status stays 'active' at zero — the only other value is 'void', which
        // means the credit was cancelled, not used up. A spent credit is a real
        // record of money that was given and applied; amount_remaining = 0 says
        // that plainly and the queries already filter on it.
        `UPDATE tenant_credits
            SET amount_remaining = amount_remaining - $2::numeric, updated_at = NOW()
          WHERE id = $1`, [c.id, take.toFixed(2)])
      left = Math.round((left - take) * 100) / 100
    }
  }

  let creditId: string | null = null
  if (surplus > 0 && input.surplusHandling === 'credit') {
    if (!payment.lease_id || !payment.tenant_id) {
      throw new AppError(409,
        'This charge has no lease attached, so a credit has nowhere to sit. Hand the difference back as change.')
    }
    const credit = await client.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits
         (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [payment.lease_id, payment.tenant_id, surplus.toFixed(2)])
    creditId = credit.rows[0].id
  }

  return {
    firstPayment,
    feeWaived,
    feeAmount: feeWaived ? 0 : MANUAL_PAYMENT_FEE,
    feeBilledTo: feeWaived ? 'none' : (landlordCovers ? 'landlord' : 'tenant'),
    feePaymentId,
    settledPaymentIds: settledRows.rows.map(r => r.id),
    amountSettled,
    creditUsed,
    surplus,
    creditId,
  }
}
