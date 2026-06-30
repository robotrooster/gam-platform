/**
 * S195: lease_fees sync helpers for the leases.security_deposit
 * deprecation. Phase 1 — every writer of leases.security_deposit also
 * upserts a corresponding lease_fees row with fee_type='security_deposit',
 * due_timing='move_in'. Phase 2 (next session) switches readers to
 * lease_fees and drops the column.
 *
 * Pattern is delete-then-insert because lease_fees lacks a UNIQUE
 * constraint on (lease_id, fee_type, due_timing) — multiple move_in
 * rows of different fee_types are intentional, and ON CONFLICT
 * doesn't have a target. The DELETE-INSERT round-trip is acceptable
 * for lease creation / patch flows (low volume; not hot path).
 *
 * S515: this helper is ALSO the canonical creation point for the
 * `security_deposits` row. Before S515 that table was read by FlexDeposit
 * custody, deposit portability, OTP deposits, interest accrual, and
 * deposit-return — but written nowhere in production (only tests). Now
 * every lease that gets a deposit amount also gets a `security_deposits`
 * row (status='pending', held_by from the property's deposit_handling_mode)
 * so the whole subsystem actually functions. See syncSecurityDepositRow.
 */

import type { PoolClient } from 'pg'
import { query, queryOne } from '../db'

/**
 * Upsert the security_deposit lease_fees row for a lease. When amount
 * is 0 or null, removes any existing row (landlord set deposit to
 * none).
 *
 * Caller can pass a transaction client; if omitted, runs outside any
 * transaction (best-effort).
 */
export async function syncSecurityDepositLeaseFee(
  leaseId: string,
  amount: number,
  client?: PoolClient,
): Promise<void> {
  const exec = async (sql: string, params: any[]): Promise<void> => {
    if (client) {
      await client.query(sql, params)
    } else {
      await query(sql, params)
    }
  }

  // Always remove any existing security_deposit move_in row first —
  // simpler than trying to UPDATE in place, and there's no UNIQUE
  // constraint to upsert against.
  await exec(
    `DELETE FROM lease_fees
      WHERE lease_id = $1
        AND fee_type = 'security_deposit'
        AND due_timing = 'move_in'`,
    [leaseId],
  )

  if (!amount || amount <= 0) {
    // Amount cleared → also drop the security_deposits row if it's still
    // untouched (no FlexDeposit plan, nothing collected).
    await syncSecurityDepositRow(leaseId, 0, client)
    return
  }

  // S360 fix: lease_fees.is_refundable is NOT NULL. Pre-S360 the INSERT
  // omitted it, crashing every CSV-tenant commit that had a
  // security_deposit > 0 with "null value in column 'is_refundable'
  // violates not-null constraint" — the entire commit transaction
  // rolled back, so any tenant import with a deposit failed end-to-end.
  // Security deposits are refundable by definition; hardcode TRUE.
  await exec(
    `INSERT INTO lease_fees (lease_id, fee_type, due_timing, amount, description, is_refundable)
     VALUES ($1, 'security_deposit', 'move_in', $2, 'Security deposit', TRUE)`,
    [leaseId, amount],
  )

  // S515: maintain the parallel security_deposits row (FlexDeposit /
  // portability / interest / deposit-return all read it).
  await syncSecurityDepositRow(leaseId, amount, client)
}

/**
 * S515: create / maintain the `security_deposits` row for a lease from
 * the live deposit amount. This is the production creation path the table
 * never had (pre-S515 only tests inserted rows).
 *
 * held_by is derived from the property's deposit_handling_mode
 * ('landlord_held' → 'landlord', 'gam_escrow' → 'gam_escrow'). The row
 * starts status='pending'; the move-in / settle path bumps
 * collected_amount + status (see reconcileSettledDepositPayment) and
 * FlexDeposit enrollment overlays its own columns.
 *
 * Idempotency landmine: this is an UPSERT, NOT delete-then-insert (unlike
 * the lease_fees side). Re-syncing a deposit amount must never wipe an
 * existing row's FlexDeposit plan, portability state, collected funds, or
 * accrued interest. So a row that is already FlexDeposit-enrolled or has
 * collected funds is left untouched (amount changes mid-plan are a
 * separate, deliberate flow — not a silent fee-edit side effect).
 */
export async function syncSecurityDepositRow(
  leaseId: string,
  amount: number,
  client?: PoolClient,
): Promise<void> {
  const exec = async (sql: string, params: any[]): Promise<void> => {
    if (client) { await client.query(sql, params) } else { await query(sql, params) }
  }
  const one = async <T extends Record<string, any>>(sql: string, params: any[]): Promise<T | null> => {
    if (client) return (await client.query<T>(sql, params)).rows[0] ?? null
    return queryOne<T>(sql, params)
  }

  const existing = await one<{
    id: string; flex_deposit_enabled: boolean; collected_amount: string; status: string
  }>(
    `SELECT id, flex_deposit_enabled, collected_amount::text, status
       FROM security_deposits
      WHERE lease_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [leaseId],
  )
  const touched = !!existing && (existing.flex_deposit_enabled || Number(existing.collected_amount) > 0)

  if (!amount || amount <= 0) {
    // Remove only an untouched row; never delete a funded / enrolled deposit.
    if (existing && !touched) {
      await exec(`DELETE FROM security_deposits WHERE id = $1`, [existing.id])
    }
    return
  }

  // Resolve unit + primary tenant + property holding mode.
  const ctx = await one<{ unit_id: string; tenant_id: string | null; held_by: string }>(
    `SELECT l.unit_id,
            (SELECT vlat.tenant_id
               FROM v_lease_active_tenants vlat
              WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
              LIMIT 1) AS tenant_id,
            CASE WHEN p.deposit_handling_mode = 'landlord_held'
                 THEN 'landlord' ELSE 'gam_escrow' END AS held_by
       FROM leases l
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1`,
    [leaseId],
  )
  if (!ctx) return  // lease/unit/property missing — nothing to anchor to

  if (existing) {
    // Don't clobber an enrolled / funded deposit; only adjust the amount
    // and holding mode while the row is still untouched.
    if (touched) return
    await exec(
      `UPDATE security_deposits
          SET total_amount = $2, held_by = $3, unit_id = $4,
              tenant_id = COALESCE($5, tenant_id), updated_at = NOW()
        WHERE id = $1`,
      [existing.id, amount, ctx.held_by, ctx.unit_id, ctx.tenant_id],
    )
    return
  }

  // No row yet. Need a primary tenant to satisfy the NOT NULL tenant_id;
  // if none is attached yet, skip — a later sync (or move-in) creates it.
  if (!ctx.tenant_id) return
  await exec(
    `INSERT INTO security_deposits
       (unit_id, lease_id, tenant_id, total_amount, status, held_by)
     VALUES ($1, $2, $3, $4, 'pending', $5)`,
    [ctx.unit_id, leaseId, ctx.tenant_id, amount, ctx.held_by],
  )
}

/**
 * S515: on a settled regular (non-FlexDeposit) deposit payment, advance
 * the security_deposits row: bump collected_amount and flip status to
 * 'funded' (or 'partial'). FlexDeposit deposits do their own collected
 * accounting via the installment / pay-ahead reconcilers, so this skips
 * any FlexDeposit-enrolled row. Idempotent at the webhook layer (the
 * settle transition fires reconcile hooks exactly once).
 */
export async function reconcileSettledDepositPayment(
  paymentId: string,
  client?: PoolClient,
): Promise<void> {
  const exec = async (sql: string, params: any[]): Promise<void> => {
    if (client) { await client.query(sql, params) } else { await query(sql, params) }
  }
  const one = async <T extends Record<string, any>>(sql: string, params: any[]): Promise<T | null> => {
    if (client) return (await client.query<T>(sql, params)).rows[0] ?? null
    return queryOne<T>(sql, params)
  }

  const p = await one<{ lease_id: string | null; type: string; amount: string }>(
    `SELECT lease_id, type, amount::text FROM payments WHERE id = $1`,
    [paymentId],
  )
  if (!p || p.type !== 'deposit' || !p.lease_id) return

  const dep = await one<{ id: string; flex_deposit_enabled: boolean; status: string }>(
    `SELECT id, flex_deposit_enabled, status
       FROM security_deposits
      WHERE lease_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [p.lease_id],
  )
  if (!dep || dep.flex_deposit_enabled || dep.status === 'funded') return

  await exec(
    `UPDATE security_deposits
        SET collected_amount = LEAST(collected_amount + $2::numeric, total_amount),
            status = CASE WHEN collected_amount + $2::numeric >= total_amount
                          THEN 'funded' ELSE 'partial' END,
            updated_at = NOW()
      WHERE id = $1`,
    [dep.id, Number(p.amount).toFixed(2)],
  )
}
