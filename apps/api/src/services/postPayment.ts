/**
 * S652 — POST A PAYMENT: money that arrived before there was a bill.
 *
 * Nic: "I've got somebody that already wrote a check and paid ahead of time
 * for October ... I don't want to issue it as a credit because it's not going
 * to come out right in the bookkeeping. I want to apply a payment ahead of
 * time, and there's no way to do that."
 *
 * The receipt is written as a receipt (tenant_remittances: method, check
 * number, date, who took it, gross_amount NULL — no Stripe involved). It
 * settles what the household owes this company, oldest first and whole, by
 * the same desk rules (services/manualPaymentSettle): the current bill in
 * full, then the old (carried-forward) balance. Whatever is left is banked on
 * the newest active lease as money PAID AHEAD the landlord holds
 * (funded_by 'landlord', received_at = the day it was received), which pays a
 * later bill when that bill comes.
 *
 * S655: it never spends credit — this is new money, not a use of old money —
 * and the credit on file is never asked about here. Pay in full holds: an
 * amount below what is owed now is refused.
 */
import type { PoolClient } from 'pg'
import type { ManualPaymentMethod } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import { lockHousehold } from './moneyPredicates'
import { createPaidAhead, runWholeBillCheckAfterCommit } from './creditUse'
import { settleManualRentPayment, deskQuote } from './manualPaymentSettle'
import { activateBillingForMoneyMoved } from './billingActivation'

export interface PostPaymentInput {
  tenantId: string
  landlordIds: string[]
  method: ManualPaymentMethod
  amount: number
  reference?: string | null
  notes?: string | null
  receivedAt?: Date | null
  postedBy: string
}

export interface PostPaymentResult {
  remittanceId: string
  /** Money that paid open charges (the current bill and the old balance). */
  applied: number
  /** Money banked as paid ahead. */
  paidAhead: number
  settledPaymentIds: string[]
  leaseId: string
  creditId: string | null
  /** Call once after COMMIT: the receipt email, and the whole-bill check for the money paid ahead. Never throws. */
  afterCommit: () => Promise<void>
}

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100

export async function postTenantPayment(client: PoolClient, input: PostPaymentInput): Promise<PostPaymentResult> {
  const amount = toCents(input.amount)
  if (!(amount > 0)) throw new AppError(400, 'The amount has to be more than zero.')

  // Where the money sits: the tenant's newest active lease with one of this account's companies.
  const lease = (await client.query<{ id: string; landlord_id: string; payment_block: boolean }>(
    `SELECT l.id, l.landlord_id, COALESCE(u.payment_block, FALSE) AS payment_block
       FROM leases l JOIN lease_tenants lt ON lt.lease_id = l.id
       LEFT JOIN units u ON u.id = l.unit_id
      WHERE lt.tenant_id = $1 AND lt.status = 'active' AND l.status IN ('active', 'pending')
        AND l.landlord_id = ANY($2::uuid[])
      ORDER BY l.status = 'active' DESC, l.start_date DESC, l.id LIMIT 1`,
    [input.tenantId, input.landlordIds])).rows[0]
  if (!lease) throw new AppError(409, 'This tenant has no active lease with you to hold a payment on.')
  // Accepting landlord-bound money during an eviction can reset its timeline.
  if (lease.payment_block) {
    throw new AppError(409, 'This space is in eviction mode — recording a payment is paused. Contact the landlord.')
  }

  await lockHousehold(client, input.tenantId, lease.landlord_id)
  const q = await deskQuote(client, { tenantId: input.tenantId, landlordId: lease.landlord_id, lock: true })
  const anchor = q.rows[0] ?? q.carried[0] ?? null

  if (anchor) {
    const owed = q.rows.reduce((s, r) => s + toCents(r.amount) - toCents(r.appliedCredit), 0)
    const carried = q.carried.reduce((s, r) => s + toCents(r.amount) - toCents(r.appliedCredit), 0)
    const r = await settleManualRentPayment(client, {
      payment: {
        id: anchor.id, landlord_id: lease.landlord_id, tenant_id: input.tenantId,
        unit_id: anchor.unitId, lease_id: anchor.leaseId, due_date: anchor.dueDate,
      },
      method: input.method,
      settledAt: input.receivedAt ?? null,
      reference: input.reference ?? null,
      provenance: 'posted from the tenant\'s page',
      settleHousehold: true,
      amountTendered: toDollars(amount),
      neverUseCredit: true,
      // The portal's order: the current bill, then the old balance, then
      // paid ahead. The post is deliberate, so nothing more is asked.
      towardOldBalance: toDollars(Math.max(0, Math.min(amount - owed, carried))),
      surplusHandling: 'credit',
      confirmWrittenAmount: true,
      takenBy: input.postedBy,
      notes: input.notes ?? null,
      creditLeaseId: lease.id,
    })
    return {
      remittanceId: r.receiptId!,
      applied: r.amountSettled,
      paidAhead: r.creditId ? r.surplus : 0,
      settledPaymentIds: r.settledPaymentIds,
      leaseId: lease.id,
      creditId: r.creditId,
      afterCommit: async () => {
        await r.afterCommit()
        if (r.creditId) await runWholeBillCheckAfterCommit({ tenantId: input.tenantId, landlordId: lease.landlord_id })
      },
    }
  }

  // Nothing is owed: the whole receipt is paid ahead.
  const rem = await client.query<{ id: string }>(
    `INSERT INTO tenant_remittances
       (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
        payment_method, gross_amount, processing_fee_amount, settled_at, reference, notes, received_by)
     VALUES ($1, $2, $3, $4, 0, $4, 'settled', $5, NULL, 0, COALESCE($6::timestamptz, NOW()), $7, $8, $9)
     RETURNING id`,
    [input.tenantId, lease.id, lease.landlord_id, toDollars(amount).toFixed(2),
     input.method, input.receivedAt ?? null, input.reference || null, input.notes || null, input.postedBy])
  const remittanceId = rem.rows[0].id
  // 10/5 (Nic): "money movement is the end of onboarding" — money posted
  // ahead with nothing owed yet still moved through GAM.
  await activateBillingForMoneyMoved(client, [lease.landlord_id])
  const creditId = await createPaidAhead(client, {
    leaseId: lease.id, tenantId: input.tenantId, amount: toDollars(amount), fundedBy: 'landlord',
    receivedAt: input.receivedAt ?? new Date(), sourceRemittanceId: remittanceId,
    note: `Paid ahead — posted ${input.method === 'money_order' ? 'money order' : input.method}${input.reference ? ` (ref ${input.reference})` : ''}`,
  })
  return {
    remittanceId, applied: 0, paidAhead: toDollars(amount), settledPaymentIds: [], leaseId: lease.id, creditId,
    afterCommit: async () => {
      await runWholeBillCheckAfterCommit({ tenantId: input.tenantId, landlordId: lease.landlord_id })
    },
  }
}
