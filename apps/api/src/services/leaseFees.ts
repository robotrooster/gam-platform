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

// W-30: any lease_fees fee_type can be billed when its row carries
// due_timing='other' — the row (already DB-CHECK-validated) is the source of
// truth, so the param is a plain string. The old narrow alias stays for the
// agent tool's arg surface.
export type LeaseFeeType = string

export async function createLeaseFeePayment(p: {
  landlordId: string
  tenantId: string | null
  leaseId: string
  unitId: string
  feeType: string
  amount: number
  description?: string
  dueDate?: string
  source?: string // who initiated, for the internal notes trail
}): Promise<{ paymentId: string; dueDate: string; description: string }> {
  const dueDate = p.dueDate ?? new Date().toISOString().slice(0, 10)
  const description =
    p.description ?? p.feeType.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
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
