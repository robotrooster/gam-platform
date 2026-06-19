/**
 * Lease fee billing — the single money-creating path for a landlord-billed
 * one-off fee. Used by BOTH the REST route (POST /api/leases/:id/bill-fee) and
 * the landlord agent's bill_fee tool, so the two never drift. Creates a
 * type='fee', status='pending' payments row the tenant pays via the normal Pay
 * Now flow (or it rolls into the deposit-return sweep at move-out).
 *
 * Auth + (for the agent) the per-property bill_fee capability gate are the
 * CALLER's responsibility — this function only writes the row.
 */
import { queryOne } from '../db'

export type LeaseFeeType = 'early_termination_fee' | 'other_fee'

export async function createLeaseFeePayment(p: {
  landlordId: string
  tenantId: string | null
  leaseId: string
  unitId: string
  feeType: LeaseFeeType
  amount: number
  description?: string
  dueDate?: string
  source?: string // who initiated, for the internal notes trail
}): Promise<{ paymentId: string; dueDate: string; description: string }> {
  const dueDate = p.dueDate ?? new Date().toISOString().slice(0, 10)
  const description =
    p.description ?? (p.feeType === 'early_termination_fee' ? 'Early termination fee' : 'Landlord-billed fee')
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO payments (
       landlord_id, tenant_id, lease_id, unit_id,
       type, amount, status, entry_description, due_date, notes
     ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'SUBSCRIP', $6, $7)
     RETURNING id`,
    [
      p.landlordId,
      p.tenantId,
      p.leaseId,
      p.unitId,
      p.amount,
      dueDate,
      `${p.source ?? 'admin'}-billed: ${p.feeType} — ${description}`,
    ]
  )
  return { paymentId: inserted!.id, dueDate, description }
}
