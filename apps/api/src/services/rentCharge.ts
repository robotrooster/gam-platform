/**
 * S609 — the ONE way a lease balance gets charged.
 *
 * This is the body of POST /payments/pay-balance, lifted out of the Express
 * handler so the AUTOPAY RUNNER charges through exactly the same code. Two
 * implementations of "how rent is charged" is how a tenant ends up paying a
 * different fee, or a landlord receiving a different owner share, depending on
 * whether a human pressed the button or a cron did — the same failure mode
 * services/creditApplication.ts exists to prevent for credits.
 *
 * Everything the route did, this does: one lease per charge, eviction hold,
 * FIFO oldest-first application with the standard remainder split, tenant-payer
 * platform-fee passthrough, sublease markup, GAM supersedence, the platform
 * charge (money lands on GAM's balance and batches to the landlord), and the
 * not-Connect-ready admin notification.
 *
 * TWO behaviours changed here versus the route it came from, both S609:
 *
 * 1. PAY-AHEAD IS ALLOWED (Nic, §8). The old guard rejected any amount that
 *    wasn't exactly the balance — over AND under. The comment beside it said
 *    "no pay-ahead — the UI has no amount field", which records a MISSING INPUT
 *    BOX, not a policy; Nic confirmed he never decided against it. Over-payment
 *    now flows into lease_prepaid_credits (webhooks.ts banks the remainder) and
 *    is released to the landlord month by month as it is earned.
 *
 *    UNDER-payment stays blocked and that IS a standing directive: a partial can
 *    reset a landlord's eviction clock. Do not soften the `amount < outstanding`
 *    branch below.
 *
 * 2. THE SURPLUS IS NOT CAPPED (Nic, DIRECTIVE — reversed the lease-term ceiling
 *    the same session it was written):
 *
 *      "It shouldn't be the rest of their lease term specifically because a
 *       tenant that's getting billed utilities and stuff — they never know what
 *       it's gonna be until the meters are read. The last month or so they're
 *       not gonna have enough credit for the utilities, or they're gonna have
 *       paid too much based on utility use and have to get credit back. So let's
 *       just not put any cap on it, to eliminate those pinch points."
 *
 *    He is right, and the ceiling was the wrong instinct. A lease term is
 *    knowable; a lease term's COST is not — utilities land after a meter is
 *    read, which is exactly the charge a tenant paying ahead cannot anticipate.
 *    Any ceiling therefore lands slightly wrong at the end of every lease and
 *    creates the refund churn it was meant to avoid.
 *
 *    Unused credit already comes back to the tenant at move-out through the
 *    deposit-return path, so an over-estimate was never stuck anyway.
 */

import type { PoolClient } from 'pg'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { allocateOldestFirst } from '@gam/shared'
import { getStripe } from '../lib/stripe'
import { computePlatformCut, createRentPlatformCharge } from './stripeConnect'
import { createAdminNotification } from './adminNotifications'
import { computeTenantGamOutstandingTotal } from './supersedence'

export const CHARGE_SOURCES = ['portal', 'autopay'] as const
export type ChargeSource = typeof CHARGE_SOURCES[number]

export interface ChargeLeaseBalanceInput {
  tenantId:          string
  /** The ONE lease this charge settles. Resolve it before calling.
   *  S616: omit it and pass serviceAgreementId instead for a payer who has no
   *  lease — the neighbour buying trash and electric. */
  leaseId?:          string
  /** S616 (Nic): "their trash and electric needs to be on one bill if they have
   *  more than one utility through this subsystem." One agreement is one bill
   *  and one charge, however many utilities are on it. */
  serviceAgreementId?: string
  /** What the tenant chose to pay. >= the outstanding balance; the excess is banked. */
  amount:            number
  paymentMethodId:   string
  paymentMethodType: 'ach' | 'card'
  /** 'portal' = a human pressed Pay. 'autopay' = the scheduled runner. */
  source:            ChargeSource
}

export interface ChargeLeaseBalanceResult {
  remittanceId:        string
  paymentIntentId:     string
  status:              string
  /** Dollars that landed on open charges. */
  appliedTotal:        number
  /** Dollars banked as prepaid credit for future months. */
  payAhead:            number
  platformCutAmount: number
  lines:               { payment_id: string; amount_applied: number }[]
}

/** The rows a lease balance is made of, oldest first, with the context every
 *  charge decision needs. Shared by the charge path and the balance preview so
 *  the number the tenant is shown is the number the server enforces. */
export type BalanceScope =
  | { kind: 'lease'; leaseId: string }
  /** S616 (Nic): a payer with no lease at all — the neighbour buying trash and
   *  electric. "Their trash and electric needs to be on one bill if they have
   *  more than one utility through this subsystem." One agreement is one bill,
   *  however many utilities are on it. */
  | { kind: 'service'; serviceAgreementId: string }

export async function fetchOutstandingRows(tenantId: string, scope: BalanceScope | string) {
  // Back-compat: every existing caller passes a lease id string.
  const sc: BalanceScope = typeof scope === 'string'
    ? { kind: 'lease', leaseId: scope } : scope
  const scopeSql = sc.kind === 'lease'
    ? `(p.lease_id = $2
        OR p.invoice_id IN (SELECT id FROM invoices WHERE lease_id = $2))`
    : `p.invoice_id IN (SELECT id FROM invoices WHERE service_agreement_id = $2)`
  const scopeId = sc.kind === 'lease' ? sc.leaseId : sc.serviceAgreementId
  return query<any>(
    `SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type,
            -- S609: the allocator pays PROPANE last whatever its date, so a fill
            -- can't absorb money ahead of the rent it happens to predate.
            p.entry_description,
            p.lease_id, p.unit_id, p.landlord_id,
            u.property_id, u.payment_block,
            t.stripe_customer_id,
            l.user_id AS landlord_user_id,
            COALESCE(l.stripe_connect_account_id, lu.stripe_connect_account_id) AS stripe_connect_account_id,
            CASE WHEN l.stripe_connect_account_id IS NOT NULL THEN l.connect_charges_enabled   ELSE lu.connect_charges_enabled   END AS connect_charges_enabled,
            CASE WHEN l.stripe_connect_account_id IS NOT NULL THEN l.connect_details_submitted ELSE lu.connect_details_submitted END AS connect_details_submitted,
            par.ach_fee_payer, par.card_fee_payer
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN tenants t ON t.id = p.tenant_id
       JOIN landlords l ON l.id = p.landlord_id
       JOIN users lu ON lu.id = l.user_id
       LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
      WHERE p.tenant_id = $1
        -- S616 (Nic): the balance is what is on the DOCUMENT, not what the
        -- lease says. "When they get their rent bill, they get the utilities
        -- and the rent on the invoice and the whole thing has to be paid at
        -- once, not just pay in full locked to what the lease says."
        --
        -- A converged invoice carries rent owed to this landlord and utilities
        -- owed to the neighbouring landlord. Those utility rows are deliberately
        -- NOT tied to this lease — they are not part of it — so scoping by
        -- lease_id alone made them invisible here: the pay-in-full guard would
        -- not have covered them and FIFO would never have allocated to them,
        -- leaving the tenant paying rent in full and the other landlord unpaid.
        -- That is the two-operator partial Nic ruled out as unallocatable.
        AND ${scopeSql}
        AND ((p.status = 'pending' AND p.stripe_payment_intent_id IS NULL)
             OR p.status = 'failed')
      ORDER BY p.due_date ASC, p.created_at ASC`,
    [tenantId, scopeId])
}

/**
 * A SUGGESTION for the pay screen — roughly what the rest of the lease term's
 * rent comes to. NOT a limit (Nic): nothing here is enforced, and a tenant may
 * pay any amount above their balance.
 *
 * It exists only so the screen can say "about $6,000 covers the rest of your
 * lease" instead of leaving a tenant guessing at a blank box. Deliberately rent
 * and recurring fees only — utilities are unknowable until a meter is read,
 * which is the whole reason there is no cap.
 *
 * A month-to-month lease (no end date) gets a twelve-month horizon, since there
 * is no term to measure.
 */
export async function suggestedPayAheadFor(leaseId: string): Promise<number> {
  const row = await queryOne<{
    rent: string; end_date: string | null; fees: string
  }>(
    `SELECT l.rent_amount::text AS rent,
            l.end_date::text    AS end_date,
            COALESCE((SELECT SUM(lf.amount) FROM lease_fees lf
                       WHERE lf.lease_id = l.id AND lf.due_timing = 'monthly_ongoing'), 0)::text AS fees
       FROM leases l WHERE l.id = $1`,
    [leaseId])
  if (!row) return 0
  const perMonth = Number(row.rent) + Number(row.fees)
  if (!(perMonth > 0)) return 0

  const MONTH_TO_MONTH_HORIZON = 12
  let months = MONTH_TO_MONTH_HORIZON
  if (row.end_date) {
    const now = new Date()
    const end = new Date(`${row.end_date}T00:00:00Z`)
    months = (end.getUTCFullYear() - now.getUTCFullYear()) * 12
          + (end.getUTCMonth() - now.getUTCMonth())
    months = Math.max(0, Math.min(months, MONTH_TO_MONTH_HORIZON))
  }
  return Math.round(perMonth * months * 100) / 100
}

/**
 * Resolve the ONE lease a charge settles when the caller didn't name one.
 * Falls back to the tenant's single outstanding lease (the launch norm) and
 * refuses when they span several — each lease is its own charge and its own
 * receipt (S581), so the client must pick.
 */
export async function resolveTargetLease(
  tenantId: string, explicitLeaseId: string | null,
): Promise<string> {
  const outstanding = await query<{ lease_id: string }>(
    `SELECT DISTINCT p.lease_id
       FROM payments p
      WHERE p.tenant_id = $1
        AND ((p.status = 'pending' AND p.stripe_payment_intent_id IS NULL)
             OR p.status = 'failed')`,
    [tenantId])
  if (outstanding.length === 0) throw new AppError(409, 'Nothing outstanding to pay')
  if (explicitLeaseId) {
    if (!outstanding.some(l => l.lease_id === explicitLeaseId)) {
      throw new AppError(409, 'That lease has nothing outstanding to pay')
    }
    return explicitLeaseId
  }
  if (outstanding.length === 1) return outstanding[0].lease_id
  throw new AppError(400, 'You have balances on more than one lease — pay each one separately.')
}

export const chargeLeaseBalanceSchema = z.object({
  amount:            z.number().positive(),
  paymentMethodId:   z.string().min(1),
  paymentMethodType: z.enum(['ach', 'card']),
  /** S616: a payer with no lease settles their service agreement's bill —
   *  every utility on it, in one charge. */
  serviceAgreementId: z.string().uuid().optional(),
  // S581 (Nic): ONE lease per charge. A tenant with two leases (an overlap
  // while moving to a bigger place, or two different landlords) pays each
  // lease as its OWN ACH/card charge with its OWN receipt. Separate charges
  // mean: (a) a bank shortfall fails only that lease, not both — the other
  // still has a chance to clear; (b) the capped processing fee is charged
  // per lease (one combined charge would let two people sharing a bank
  // account share a single capped fee — a revenue leak AND a scam vector);
  // (c) an eviction hold on one landlord's lease never blocks paying an
  // unrelated landlord's lease. Omitted for the single-lease case (launch
  // norm) — the one outstanding lease is resolved automatically.
  leaseId:           z.string().uuid().optional(),
})

export async function chargeLeaseBalance(
  input: ChargeLeaseBalanceInput,
): Promise<ChargeLeaseBalanceResult> {
  const { tenantId, leaseId, serviceAgreementId, amount, paymentMethodId, paymentMethodType } = input
  if (!leaseId && !serviceAgreementId) {
    throw new AppError(400, 'A balance needs either a lease or a service agreement to settle.')
  }
  const scope: BalanceScope = leaseId
    ? { kind: 'lease', leaseId }
    : { kind: 'service', serviceAgreementId: serviceAgreementId! }
  const client = await getClient()
  try {
    // The tenant's outstanding ledger FOR THIS LEASE, oldest first. Every row
    // shares one lease → one unit → one landlord → one property, so ctx (row 0)
    // is representative of the whole charge (incl. the eviction-hold check).
    const rows = await fetchOutstandingRows(tenantId, scope)
    if (rows.length === 0) throw new AppError(409, 'Nothing outstanding to pay')
    const ctx = rows[0]
    if (ctx.payment_block) {
      throw new AppError(409, 'This unit is in eviction mode — payments to the landlord are paused. Accepting one could reset the eviction timeline. Contact the landlord.')
    }
    if (!ctx.stripe_customer_id) {
      throw new AppError(409, 'Tenant has no Stripe customer — complete ACH setup first')
    }

    const totalOutstanding = Math.round(rows.reduce((sum: number, r: any) => sum + r.amount, 0) * 100) / 100

    // UNDER-PAYMENT IS BLOCKED (Nic, standing directive). Rent is pay-in-full:
    // a partial can reset a landlord's eviction clock. This branch is the
    // server-side guarantee and must not be softened.
    if (amount < totalOutstanding - 0.005) {
      throw new AppError(422,
        `Rent must be paid in full — the outstanding balance is $${totalOutstanding.toFixed(2)}.`)
    }

    // OVER-payment is pay-ahead (S609, Nic). NO CEILING — see the header note.
    // GAM holds the surplus and releases it month by month as it is earned.

    const plan = allocateOldestFirst(
      rows.map((r: any) => ({
        id: r.id, amount: r.amount, due_date: r.due_date,
        type: r.type, entry_description: r.entry_description,
      })),
      amount
    )
    const appliedTotal = Math.round((amount - plan.unapplied) * 100) / 100
    const rowById = new Map(rows.map((r: any) => [r.id, r]))

    const landlordConnectReady =
      !!ctx.stripe_connect_account_id &&
      ctx.connect_charges_enabled === true &&
      ctx.connect_details_submitted === true

    const stripe = getStripe()
    let cardCountry: string | null = null
    if (paymentMethodType === 'card') {
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
      cardCountry = pm.card?.country ?? null
    }

    // The fee is computed on the WHOLE amount the tenant chose to pay,
    // pay-ahead surplus included — Stripe charges us on every dollar it
    // processes and GAM never absorbs a banking fee. allocation.ts reads the
    // same total back off the remittance so its books match this exactly.
    const basePlatformCut = computePlatformCut({
      amount,
      paymentMethod: paymentMethodType,
      cardCountry,
    })

    // Tenant-payer platform fee passthrough — same as /:id/pay.
    const unpaidAccruals = await query<{ id: string; total_amount: string }>(
      `SELECT id, total_amount FROM platform_fee_accruals
        WHERE property_id = $1 AND payer = 'tenant'
          AND tenant_charge_id IS NULL AND total_amount > 0`,
      [ctx.property_id]
    )
    const passthroughAmount = unpaidAccruals.reduce((sum, r) => sum + parseFloat(r.total_amount), 0)

    // Sublease markup — applies per covered RENT month (rare; sublessee pays
    // marked-up rent, the markup goes to the sublessor at settle). S581: the
    // per-month markup is STAMPED on each covered rent row below
    // (sublease_markup_amount) so allocation subtracts it from the landlord's
    // owner_share and the sublessor is credited that same amount.
    let subleaseMarkup = 0
    let subleasePerMonth = 0
    const coveredRentIds: string[] = plan.lines
      .filter(ln => rowById.get(ln.payment_id)?.type === 'rent'
        && Math.abs(ln.amount_applied - rowById.get(ln.payment_id)!.amount) < 0.005)
      .map(ln => ln.payment_id)
    {
      const sub = await queryOne<{ sub: string; master: string }>(
        `SELECT s.sub_monthly_amount::text AS sub, s.master_share_amount::text AS master
           FROM subleases s JOIN leases l ON l.id = s.master_lease_id
          WHERE l.unit_id = $1 AND s.sublessee_tenant_id = $2 AND s.status = 'active'
          LIMIT 1`,
        [ctx.unit_id, tenantId],
      )
      if (sub) {
        subleasePerMonth = Math.max(0, parseFloat(sub.sub) - parseFloat(sub.master))
        subleaseMarkup = subleasePerMonth * coveredRentIds.length
      }
    }

    // GAM supersedence claims only what actually lands on obligations — a
    // pay-ahead surplus is the tenant's money held for future rent, not
    // available cash to sweep.
    const gamSupersedenceAmount = Math.min(appliedTotal, await computeTenantGamOutstandingTotal(tenantId))
    const platformCutAmount = Math.round(
      (basePlatformCut + passthroughAmount + subleaseMarkup + gamSupersedenceAmount) * 100) / 100

    // S562: tenant-borne processing fee rides on top of the lump charge.
    // Fee-payer resolved from the first row's property (ctx) — a single
    // ACH/card transaction means one capped customer-facing fee on the whole
    // lump, matching Stripe's single-transaction cost.
    const feePayer = paymentMethodType === 'ach' ? ctx.ach_fee_payer : ctx.card_fee_payer
    const tenantPaysProcessingFee = feePayer !== 'landlord'
    const tenantBorneOnTop = (tenantPaysProcessingFee ? basePlatformCut : 0) + passthroughAmount
    const chargeAmount = Math.round((amount + tenantBorneOnTop) * 100) / 100

    // Create the remittance BEFORE the Stripe call so the PI metadata can
    // carry its id; stamp the PI after.
    await client.query('BEGIN')
    const rem = await client.query<{ id: string }>(
      // S616: gross_amount and processing_fee_amount are the two figures that
      // let GAM tie out to Stripe. They were computed a few lines above, sent
      // to Stripe, and then thrown away — so nothing on our side could tell a
      // missing payment from a fee difference. chargeAmount IS what Stripe is
      // asked for; tenantBorneOnTop is the part of it that is not the
      // obligation.
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
          payment_method, gross_amount, processing_fee_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [tenantId, ctx.lease_id, ctx.landlord_id, amount.toFixed(2),
       appliedTotal.toFixed(2), plan.unapplied.toFixed(2), paymentMethodType,
       chargeAmount.toFixed(2), tenantBorneOnTop.toFixed(2)])
    const remittanceId = rem.rows[0].id

    // Apply the plan: split the partial row, record every line.
    const fullyCoveredIds: string[] = []
    for (const line of plan.lines) {
      const row = rowById.get(line.payment_id)!
      const isFull = Math.abs(line.amount_applied - row.amount) < 0.005
      const coveredPaymentId = line.payment_id
      if (!isFull) {
        // Split (propaneRedistribution pattern): the applied slice takes
        // the charge; a remainder row stays pending — late fees remain
        // truthful about the unpaid portion ("short is short").
        const remainder = Math.round((row.amount - line.amount_applied) * 100) / 100
        await client.query(
          `UPDATE payments SET amount = $2::numeric,
                  notes = COALESCE(notes || ' — ', '') || 'partially covered by Pay Now (FIFO application); $' || $3 || ' remains on a separate row'
            WHERE id = $1`,
          [row.id, line.amount_applied.toFixed(2), remainder.toFixed(2)])
        await client.query(
          `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                                 type, amount, status, due_date, entry_description, notes, is_remainder)
           SELECT unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                  type, $2::numeric, 'pending', due_date, entry_description,
                  'Remainder after FIFO application of a partial payment', TRUE
             FROM payments WHERE id = $1`,
          [row.id, remainder.toFixed(2)])
      }
      fullyCoveredIds.push(coveredPaymentId)
      await client.query(
        `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied)
         VALUES ($1, $2, $3)`,
        [remittanceId, coveredPaymentId, line.amount_applied.toFixed(2)])
    }

    // S560 money-flow rebuild (Phase 1): ALWAYS platform charge — money held by
    // GAM, batched to the landlord on the weekly run.
    const intent = await createRentPlatformCharge({
      amount: chargeAmount,
      stripeCustomerId: ctx.stripe_customer_id,
      paymentMethodId,
      paymentMethodTypes: paymentMethodType === 'ach' ? ['us_bank_account'] : ['card'],
      entryDescription: 'BALANCE',
      metadata: {
        gam_remittance_id: remittanceId,
        tenant_id: tenantId,
        landlord_id: ctx.landlord_id,
        gam_charge_source: input.source,
      },
    })

    // Stamp the PI on every covered row — the standard webhook settle
    // path (allocation engine, credit ledger, propane, supersedence)
    // picks them ALL up by PI id, unchanged.
    await client.query(
      `UPDATE payments SET status = 'processing', stripe_payment_intent_id = $1,
              platform_held = TRUE
        WHERE id = ANY($2::uuid[])`,
      [intent.id, fullyCoveredIds])
    // S581: stamp the per-month sublease markup on each covered rent row so
    // allocation nets it out of the landlord's owner_share.
    if (subleasePerMonth > 0 && coveredRentIds.length > 0) {
      await client.query(
        `UPDATE payments SET sublease_markup_amount = $1 WHERE id = ANY($2::uuid[])`,
        [subleasePerMonth.toFixed(2), coveredRentIds])
    }
    await client.query(
      `UPDATE tenant_remittances SET stripe_payment_intent_id = $1, updated_at = NOW() WHERE id = $2`,
      [intent.id, remittanceId])
    if (unpaidAccruals.length > 0) {
      // Claim passthrough accruals against the oldest covered row (the
      // reconciliation anchor) — same one-winner semantics as /:id/pay.
      await client.query(
        `UPDATE platform_fee_accruals SET tenant_charge_id = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[]) AND tenant_charge_id IS NULL`,
        [fullyCoveredIds[0], unpaidAccruals.map(r => r.id)])
    }
    await client.query('COMMIT')

    if (!landlordConnectReady) {
      // Held fine; can't batch out until this landlord finishes Connect onboarding.
      await createAdminNotification({
        severity: 'warn',
        category: 'platform_held_rent_charge',
        title: `Held balance payment can't batch out — landlord ${ctx.landlord_user_id} not Connect-ready`,
        body: `Remittance ${remittanceId} for $${amount.toFixed(2)} is held on the GAM platform balance. It batches to the landlord once they finish Connect onboarding.`,
        context: { remittance_id: remittanceId, landlord_id: ctx.landlord_id, amount },
      })
    }

    return {
      remittanceId,
      paymentIntentId: intent.id,
      status: intent.status,
      appliedTotal,
      payAhead: plan.unapplied,
      platformCutAmount,
      lines: plan.lines,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
