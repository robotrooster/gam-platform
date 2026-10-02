// S624 — settling a rent charge that was paid outside the platform.
//
// This is the money half of `POST /payments/:id/record-manual`, lifted out of
// the route so the BANK-DEPOSIT path can settle a payment the same way the
// landlord's manual entry does.
//
// It is lifted rather than reimplemented on purpose. The rules here are small,
// unobvious and hard-won — the whole-balance sweep, the credit draw-down, the
// change-or-credit choice — and each was a separate correction from Nic. A
// second copy would start identical and drift, and the drift would be silent
// because both paths would still "work".
//
// S654 (Nic): "There's no fee. Paying cash or check is free." Nothing here
// raises a fee row, a ledger line or a landlord charge, on any payment.
//
// The one thing this adds over the route version is `settledAt`. The route
// settles at NOW() because a landlord recording a payment is recording it as
// they enter it. A bank deposit is different: it happened in the past, and the
// whole value of matching it is that the payment lands on the date the money
// actually moved — see services/depositBackdate.ts for which date that is and
// why a corroborated tenant declaration beats the bank's own posting.

import type { PoolClient } from 'pg'
import { activateBillingForSettledRent } from './billingActivation'
import { prepaidDrawAvailable, drawPrepaidCredit } from './prepaidRelease'
import { recordHeldItem } from './heldPayouts'
import { AppError } from '../middleware/errorHandler'
import { emitPaymentSettledEvent } from './creditLedgerEmitters'
import type { ManualPaymentMethod } from '@gam/shared'

export interface ManualSettleInput {
  /** The rent `payments` row being satisfied. Caller has already locked it. */
  payment: {
    id: string; landlord_id: string; tenant_id: string | null; unit_id: string
    lease_id: string | null; due_date: string
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
   * narrow behavior keeps every existing caller as it was.
   */
  settleWholeBalance?: boolean
  /** S652 (Nic): one person, several leases, ONE balance — settle every open charge of theirs with this company. */
  settleHousehold?: boolean
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
   * Omitted keeps the old behavior exactly — the bank-deposit match path never
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
  /** S637: the rows this settled — what the receipt itemizes. */
  settledPaymentIds: string[]
  /** S637: what this settled, and what became of any surplus. */
  amountSettled: number
  /** S638: how much of the bill a credit covered, so the receipt can say so. */
  creditUsed: number
  surplus: number
  creditId: string | null
}

export async function settleManualRentPayment(
  client: PoolClient, input: ManualSettleInput,
): Promise<ManualSettleResult> {
  const { payment, method } = input

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
               AND (CASE WHEN $3::boolean
                         THEN tenant_id = (SELECT tenant_id FROM payments WHERE id = $1)
                          AND landlord_id = (SELECT landlord_id FROM payments WHERE id = $1)
                         WHEN (SELECT lease_id FROM payments WHERE id = $1) IS NOT NULL
                         THEN lease_id = (SELECT lease_id FROM payments WHERE id = $1)
                         ELSE tenant_id = (SELECT tenant_id FROM payments WHERE id = $1) END))
            ELSE id = $1 END`,
    [payment.id, input.settleWholeBalance === true, input.settleHousehold === true])
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
        AND (lease_id = $2 OR (lease_id IS NULL AND landlord_id = $3) OR ($4::boolean AND landlord_id = $3))`,
    [payment.tenant_id, payment.lease_id, payment.landlord_id, input.settleHousehold === true])
  const landlordCreditAvailable = Math.round(Number(creditRow.rows[0]?.credit ?? 0) * 100) / 100
  // S653 (Nic): paid-ahead credit counts at the desk too — capped by the
  // resident's monthly draw, so "she still pays a little out of pocket each
  // month" holds whether she pays online or at the counter. Measured against
  // the month of the bill being settled.
  const payMonth = `${String(payment.due_date).slice(0, 7)}-01`
  const prepaidAvailable = payment.lease_id ? (await prepaidDrawAvailable(client, payment.lease_id, payMonth)).available : 0
  const creditAvailable = Math.round((landlordCreditAvailable + prepaidAvailable) * 100) / 100
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
    // fallback the balance quote uses, so the quote and the settle cannot drift.
    //
    // Work-trade suspended rows are excluded: they are not owed now. They settle
    // at month close against hours worked, and sweeping them into a cash payment
    // would collect rent somebody's labor already covered.
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
               AND (CASE WHEN $6::boolean
                         THEN tenant_id = (SELECT tenant_id FROM payments WHERE id = $1)
                          AND landlord_id = (SELECT landlord_id FROM payments WHERE id = $1)
                         WHEN (SELECT lease_id FROM payments WHERE id = $1) IS NOT NULL
                         THEN lease_id = (SELECT lease_id FROM payments WHERE id = $1)
                         ELSE tenant_id = (SELECT tenant_id FROM payments WHERE id = $1) END))
            ELSE id = $1 END
    RETURNING id, tenant_id, lease_id, type, amount, due_date::text AS due_date, settled_at,
              (SELECT pr.timezone FROM units u JOIN properties pr ON pr.id = u.property_id
                WHERE u.id = payments.unit_id) AS property_tz`,
    [payment.id, method,
     `Recorded as manual ${method} payment${refNote}${provenance}`,
     input.settledAt, input.settleWholeBalance === true, input.settleHousehold === true])

  // S652 (Nic): the credit ledger only heard about Stripe settlements, so a
  // resident who paid cash three weeks late was never recorded as late — and
  // the "late payments" count, which now derives from the ledger, would have
  // missed every desk payment. Same event, same tiering, landlord-attested
  // with the check or money-order number as the evidence.
  for (const row of settledRows.rows as any[]) {
    if (!row.tenant_id || (row.type !== 'rent' && row.type !== 'utility') || !row.due_date) continue
    const grace = row.lease_id
      ? (await client.query<{ late_fee_grace_days: number }>(
          `SELECT late_fee_grace_days FROM leases WHERE id = $1`, [row.lease_id])).rows[0]?.late_fee_grace_days ?? null
      : null
    await emitPaymentSettledEvent(client, {
      tenantId: row.tenant_id, paymentId: row.id, paymentType: row.type,
      // S654: the due day as 'YYYY-MM-DD' and the property's zone, as the
      // webhook does, so the tier is read on the property's calendar.
      amount: row.amount, dueDate: row.due_date, settledAt: new Date(row.settled_at),
      graceDays: grace, stripePaymentIntentId: null, propertyTz: row.property_tz ?? null,
      attestationSource: 'landlord_self_reported_with_evidence',
      attestationEvidence: { manual_method: method, reference: input.reference ?? null },
    })
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
  // S653: the paid-ahead money goes first (it is the resident's own cash GAM
  // is holding), the landlord's credits cover the rest.
  let prepaidDrawn = 0
  if (creditUsed > 0 && prepaidAvailable > 0 && payment.lease_id) {
    prepaidDrawn = await drawPrepaidCredit(client, {
      leaseId: payment.lease_id, amount: Math.min(prepaidAvailable, creditUsed), billingMonth: payMonth, paymentId: payment.id,
    })
    // That share of the bill is the landlord's, and GAM is holding it — it
    // rides out on the weekly payout like a register card sale does.
    await recordHeldItem({
      landlordId: payment.landlord_id, sourceType: 'prepaid_draw', sourceId: payment.id,
      amount: prepaidDrawn, description: 'Paid-ahead credit applied at the desk',
    }, client)
  }
  if (creditUsed - prepaidDrawn > 0.005) {
    let left = Math.round((creditUsed - prepaidDrawn) * 100) / 100
    const open = await client.query<{ id: string; amount_remaining: string }>(
      `SELECT id, amount_remaining::text FROM tenant_credits
        WHERE tenant_id = $1 AND status = 'active' AND amount_remaining > 0
          AND (lease_id = $2 OR (lease_id IS NULL AND landlord_id = $3) OR ($4::boolean AND landlord_id = $3))
        ORDER BY (lease_id IS NULL), created_at`, [payment.tenant_id, payment.lease_id, payment.landlord_id, input.settleHousehold === true])
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
    settledPaymentIds: settledRows.rows.map(r => r.id),
    amountSettled,
    creditUsed,
    surplus,
    creditId,
  }
}
