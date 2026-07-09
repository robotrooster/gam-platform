/**
 * Accelerated-propane payment redistribution (Nic, S533).
 *
 * Priority order for tenant funds: GAM balance → accelerated propane →
 * rent. The ACH flow is NEVER interrupted — the tenant's rent charge
 * pulls in full onto the platform rails (the landlord's Connect
 * BALANCE, not their bank; the landlord is only ever paid by the
 * Friday batch payout sweep, jobs/autoPayouts.ts). This function is
 * pure LEDGER application at settle time — zero money movement:
 * unpaid accelerated propane rows are satisfied first (whole rows,
 * oldest first), and the rent row splits into a settled portion and a
 * new pending remainder for what the redirected funds no longer cover.
 * The tenant is told exactly what happened ("$270.00 was applied to
 * your outstanding propane balance first").
 *
 * GAM-first needs nothing here: supersedence skims GAM's outstanding
 * from every payment at its own layer regardless.
 *
 * Runs inside the webhook settle transaction, immediately after the
 * status flip (which is idempotency-guarded: status != 'settled'), so
 * this executes at most once per payment.
 */

import type { PoolClient } from 'pg'

export interface RedistributionResult {
  applied: number            // dollars redirected to propane
  rentRemainder: number      // new pending rent amount
  propanePaymentIds: string[]
}

export async function applyAcceleratedPropane(
  client: PoolClient,
  rentPayment: { id: string; tenant_id: string | null; amount: string; due_date: string },
): Promise<RedistributionResult | null> {
  if (!rentPayment.tenant_id) return null

  // Unpaid accelerated propane rows, oldest first. Locked so a
  // concurrent settle can't satisfy the same row twice.
  const rows = (await client.query<any>(
    `SELECT p.id, p.amount
       FROM payments p
       JOIN propane_fill_installments i ON i.payment_id = p.id
      WHERE p.tenant_id = $1
        AND i.accelerated
        AND p.status IN ('pending', 'failed', 'returned')
      ORDER BY p.due_date ASC, p.created_at ASC
      FOR UPDATE OF p`,
    [rentPayment.tenant_id])).rows
  if (rows.length === 0) return null

  // Satisfy WHOLE rows while the rent funds cover them (no partial-row
  // settlement mechanism exists; a leftover sliver stays on rent).
  let available = Number(rentPayment.amount)
  const satisfied: { id: string; amount: number }[] = []
  for (const r of rows) {
    const amt = Number(r.amount)
    if (amt <= available) {
      satisfied.push({ id: r.id, amount: amt })
      available -= amt
    }
  }
  if (satisfied.length === 0) return null
  const applied = Math.round(satisfied.reduce((s, r) => s + r.amount, 0) * 100) / 100

  for (const r of satisfied) {
    await client.query(
      `UPDATE payments
          SET status = 'settled', settled_at = NOW(),
              notes = COALESCE(notes || ' — ', '') || 'Paid from rent payment (propane priority applies funds here first)'
        WHERE id = $1`, [r.id])
  }

  // Split the rent row: the settled portion shrinks by what propane
  // took; a new pending rent row carries the remainder (same invoice,
  // same due date) so the lease ledger and late-fee mechanics stay
  // truthful about unpaid rent.
  const rentRemainder = applied
  await client.query(
    `UPDATE payments
        SET amount = amount - $2::numeric,
            notes = COALESCE(notes || ' — ', '') || '$' || $3 || ' of this payment was applied to outstanding propane balance first'
      WHERE id = $1`, [rentPayment.id, applied.toFixed(2), applied.toFixed(2)])
  await client.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id,
                           type, amount, status, due_date, entry_description, notes,
                           is_remainder)
     SELECT unit_id, lease_id, tenant_id, landlord_id, invoice_id,
            'rent', $2::numeric, 'pending', due_date, 'RENT',
            'Rent remainder — $' || $3 || ' of the original payment was applied to outstanding propane balance',
            TRUE
       FROM payments WHERE id = $1`,
    [rentPayment.id, rentRemainder.toFixed(2), rentRemainder.toFixed(2)])

  return { applied, rentRemainder, propanePaymentIds: satisfied.map(r => r.id) }
}
