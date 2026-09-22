/**
 * S652 — POST A PAYMENT: money that arrived before there was a bill.
 *
 * Nic: "I've got somebody that already wrote a check and paid ahead of time
 * for October ... I don't want to issue it as a credit because it's not going
 * to come out right in the bookkeeping. I want to apply a payment ahead of
 * time, and there's no way to do that."
 *
 * The receipt is written as a receipt (tenant_remittances: method, check
 * number, date, who took it). It settles whatever is open, oldest first, by
 * the same rules as recording a payment against a charge — cash is free, the
 * first payment's waiver, pay-in-full. Whatever is left is banked on the lease
 * as money PAID AHEAD (lease_prepaid_credits), which the next invoice draws
 * down before it goes out. No credit is created anywhere: nothing here is
 * money the landlord made up, it is money that arrived.
 */
import type { PoolClient } from 'pg'
import type { ManualPaymentMethod } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import { settleManualRentPayment } from './manualPaymentSettle'

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
  applied: number
  paidAhead: number
  settledPaymentIds: string[]
  leaseId: string
}

export async function postTenantPayment(client: PoolClient, input: PostPaymentInput): Promise<PostPaymentResult> {
  const amount = Math.round(Number(input.amount) * 100) / 100
  if (!(amount > 0)) throw new AppError(400, 'The amount has to be more than zero.')

  // Where the money sits: the tenant's active lease with one of this account's companies.
  const lease = (await client.query<any>(
    `SELECT l.id, l.landlord_id, l.unit_id
       FROM leases l JOIN lease_tenants lt ON lt.lease_id = l.id
      WHERE lt.tenant_id = $1 AND lt.status = 'active' AND l.status IN ('active', 'pending')
        AND l.landlord_id = ANY($2::uuid[])
      ORDER BY l.status = 'active' DESC, l.start_date DESC LIMIT 1`,
    [input.tenantId, input.landlordIds])).rows[0]
  if (!lease) throw new AppError(409, 'This tenant has no active lease with you to hold a payment on.')

  // What is open, oldest first — the receipt settles that before anything is paid ahead.
  const open = (await client.query<any>(
    `SELECT p.id, p.landlord_id, p.tenant_id, p.unit_id, p.lease_id, p.due_date::text AS due_date,
            COALESCE(par.manual_fee_payer, 'tenant') AS manual_fee_payer,
            t.background_check_status
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       LEFT JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
      WHERE p.lease_id = $1 AND p.status IN ('pending', 'failed') AND p.work_trade_suspended_at IS NULL
      ORDER BY p.due_date, p.created_at LIMIT 1 FOR UPDATE OF p`, [lease.id])).rows[0]

  let applied = 0, paidAhead = amount, settledPaymentIds: string[] = [], creditId: string | null = null
  if (open) {
    const r = await settleManualRentPayment(client, {
      payment: open, method: input.method, settledAt: input.receivedAt ?? null,
      reference: input.reference ?? null, provenance: ' — posted from the tenant\'s page',
      settleWholeBalance: true, amountTendered: amount, surplusHandling: 'credit',
    })
    applied = r.amountSettled
    paidAhead = r.surplus
    settledPaymentIds = r.settledPaymentIds
    creditId = r.creditId
  } else {
    const c = await client.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, $3, $3) RETURNING id`, [lease.id, input.tenantId, amount.toFixed(2)])
    creditId = c.rows[0].id
  }

  const rem = await client.query<{ id: string }>(
    `INSERT INTO tenant_remittances
       (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
        payment_method, gross_amount, processing_fee_amount, settled_at, reference, notes, received_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'settled', $7, $4, 0, COALESCE($8::timestamptz, NOW()), $9, $10, $11)
     RETURNING id`,
    [input.tenantId, lease.id, lease.landlord_id, amount.toFixed(2), applied.toFixed(2), paidAhead.toFixed(2),
     input.method, input.receivedAt ?? null, input.reference || null, input.notes || null, input.postedBy])
  const remittanceId = rem.rows[0].id
  if (settledPaymentIds.length) {
    for (const pid of settledPaymentIds) {
      const amt = (await client.query<{ amount: string }>(`SELECT amount::text FROM payments WHERE id = $1`, [pid])).rows[0]?.amount ?? '0'
      await client.query(
        `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`, [remittanceId, pid, amt])
    }
  }
  if (creditId) {
    await client.query(`UPDATE lease_prepaid_credits SET source_remittance_id = $2, updated_at = NOW() WHERE id = $1`, [creditId, remittanceId])
  }
  return { remittanceId, applied, paidAhead, settledPaymentIds, leaseId: lease.id }
}
