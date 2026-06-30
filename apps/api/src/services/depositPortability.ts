/**
 * S255: FlexDeposit portability — carries a security deposit from
 * one GAM lease to the tenant's next GAM lease instead of triggering
 * the standard return-or-disburse engine at lease end.
 *
 * Product spec (Nic-confirmed S255):
 *  - Auto-detect eligible portability: tenant has another lease on
 *    GAM in 'pending' or 'active' status at the time their current
 *    lease moves into termination.
 *  - Explicit tenant authorization required at termination flow
 *    (signature + audit fields).
 *  - Strongly prefer GAM-escrow holding: gam_escrow deposits port
 *    with zero money movement; landlord-held deposits flag for
 *    admin-mediated transfer (and convert to gam_escrow at port time).
 *  - Custody fee continues uninterrupted across the boundary.
 *  - Unpaid-balance sweep against landlord A still runs before the
 *    carry-forward (landlord A's claim has priority — same as the
 *    standard return path).
 *
 * State machine (security_deposits.portability_status):
 *   none → pending_auth → authorized → carried_forward (gam_escrow)
 *                                  → pending_transfer (landlord-held;
 *                                                       admin moves
 *                                                       funds → flips
 *                                                       to carried_
 *                                                       forward)
 *   none → declined (tenant opted out; standard return flow)
 *
 * See routes/depositPortability.ts for the tenant-facing
 * authorization endpoints + deposit-return integration.
 */

import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

export interface PortabilityEligibility {
  eligible:            boolean
  reason:              string | null
  current_lease_id:    string
  target_lease_id:     string | null
  target_property_name: string | null
  target_landlord_id:  string | null
  deposit_id:          string | null
  deposit_amount:      number | null
  held_by:             'gam_escrow' | 'landlord' | null
}

/**
 * Auto-detection: given a lease ID that's entering termination,
 * does the tenant have another GAM lease in pending/active status
 * that this deposit could carry forward to?
 *
 * If multiple candidates exist (rare), returns the most recently
 * created lease — the assumption being that the most recent move
 * is the destination.
 */
export async function detectPortabilityEligible(args: {
  leaseId:   string
  tenantId?: string  // optional override; defaults to lease's primary tenant
}): Promise<PortabilityEligibility> {
  const lease = await queryOne<{
    id:          string
    primary_tenant_id: string | null
  }>(
    `SELECT l.id,
            (SELECT vlat.tenant_id
               FROM v_lease_active_tenants vlat
              WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
              LIMIT 1) AS primary_tenant_id
       FROM leases l WHERE l.id = $1`,
    [args.leaseId],
  )
  if (!lease) {
    return zero('Lease not found', args.leaseId)
  }
  const tenantId = args.tenantId ?? lease.primary_tenant_id
  if (!tenantId) {
    return zero('No primary tenant on lease', args.leaseId)
  }

  // Pull the current deposit
  const dep = await queryOne<{
    id: string; total_amount: string; held_by: string;
  }>(
    `SELECT id, total_amount::text, held_by
       FROM security_deposits
      WHERE lease_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [args.leaseId],
  )

  // Find target — another GAM lease in pending/active where the
  // same tenant is on the lease. Most recently created wins.
  const target = await queryOne<{
    lease_id: string; property_name: string; landlord_id: string;
  }>(
    `SELECT l.id AS lease_id,
            p.name AS property_name,
            l.landlord_id
       FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
       JOIN units u           ON u.id = l.unit_id
       JOIN properties p      ON p.id = u.property_id
      WHERE lt.tenant_id = $1
        AND lt.status = 'active'
        AND l.id <> $2
        AND l.status IN ('pending', 'active')
      ORDER BY l.created_at DESC
      LIMIT 1`,
    [tenantId, args.leaseId],
  )

  if (!target) {
    return {
      eligible: false,
      reason:   'Tenant has no other pending/active lease on GAM',
      current_lease_id:    args.leaseId,
      target_lease_id:     null,
      target_property_name: null,
      target_landlord_id:  null,
      deposit_id:          dep?.id ?? null,
      deposit_amount:      dep ? Number(dep.total_amount) : null,
      held_by:             (dep?.held_by as any) ?? null,
    }
  }
  if (!dep) {
    return {
      eligible: false,
      reason:   'No security deposit on the current lease',
      current_lease_id:    args.leaseId,
      target_lease_id:     target.lease_id,
      target_property_name: target.property_name,
      target_landlord_id:  target.landlord_id,
      deposit_id:          null,
      deposit_amount:      null,
      held_by:             null,
    }
  }

  return {
    eligible: true,
    reason:   null,
    current_lease_id:    args.leaseId,
    target_lease_id:     target.lease_id,
    target_property_name: target.property_name,
    target_landlord_id:  target.landlord_id,
    deposit_id:          dep.id,
    deposit_amount:      Number(dep.total_amount),
    held_by:             dep.held_by as any,
  }
}

function zero(reason: string, leaseId: string): PortabilityEligibility {
  return {
    eligible: false, reason, current_lease_id: leaseId,
    target_lease_id: null, target_property_name: null,
    target_landlord_id: null, deposit_id: null,
    deposit_amount: null, held_by: null,
  }
}

/**
 * Tenant authorizes the deposit to carry forward to a target lease.
 * Captures signature text + IP for audit. Flips deposit status to
 * 'authorized' so the deposit-return engine routes around the
 * disburse/refund path when finalize runs.
 *
 * Idempotent: re-authorizing the same deposit/target combo no-ops.
 * Authorizing with a DIFFERENT target_lease_id throws — tenant must
 * decline the prior authorization first.
 */
export async function authorizeDepositPortability(args: {
  tenantId:      string
  depositId:     string
  targetLeaseId: string
  signature:     string
  ip?:           string | null
}): Promise<{ ok: true; status: 'authorized' }> {
  if (!args.signature || args.signature.trim().length < 2) {
    throw new AppError(400, 'Signature required')
  }

  const dep = await queryOne<{
    id: string; tenant_id: string; lease_id: string;
    portability_status: string; portability_target_lease_id: string | null;
  }>(
    `SELECT id, tenant_id, lease_id, portability_status, portability_target_lease_id
       FROM security_deposits WHERE id = $1`,
    [args.depositId],
  )
  if (!dep) throw new AppError(404, 'Deposit not found')
  if (dep.tenant_id !== args.tenantId) {
    throw new AppError(403, 'Not your deposit')
  }
  if (dep.portability_status === 'carried_forward') {
    throw new AppError(409, 'Deposit already carried forward')
  }
  if (
    dep.portability_status === 'authorized' &&
    dep.portability_target_lease_id &&
    dep.portability_target_lease_id !== args.targetLeaseId
  ) {
    throw new AppError(409, 'Already authorized for a different target lease — decline first')
  }

  // Confirm target lease still valid + tenant on it
  const onTarget = await queryOne<{ id: string }>(
    `SELECT lt.id
       FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id
      WHERE lt.lease_id = $1
        AND lt.tenant_id = $2
        AND lt.status = 'active'
        AND l.status IN ('pending', 'active')`,
    [args.targetLeaseId, args.tenantId],
  )
  if (!onTarget) {
    throw new AppError(400, 'Target lease is no longer eligible (tenant not on it, or lease not in pending/active state)')
  }

  await query(
    `UPDATE security_deposits
        SET portability_status              = 'authorized',
            portability_target_lease_id     = $1,
            portability_authorized_at       = NOW(),
            portability_authorized_signature = $2,
            portability_authorized_ip       = $3,
            updated_at                      = NOW()
      WHERE id = $4`,
    [args.targetLeaseId, args.signature.trim().slice(0, 500), args.ip ?? null, args.depositId],
  )

  return { ok: true, status: 'authorized' }
}

/**
 * Tenant declines (or revokes a prior authorization). Deposit-return
 * engine will run the normal disburse/refund path.
 */
export async function declineDepositPortability(args: {
  tenantId:  string
  depositId: string
}): Promise<void> {
  const upd = await queryOne<{ id: string }>(
    `UPDATE security_deposits
        SET portability_status            = 'declined',
            portability_target_lease_id   = NULL,
            portability_authorized_at     = NULL,
            portability_authorized_signature = NULL,
            portability_authorized_ip     = NULL,
            updated_at                    = NOW()
      WHERE id = $1
        AND tenant_id = $2
        AND portability_status IN ('pending_auth', 'authorized')
      RETURNING id`,
    [args.depositId, args.tenantId],
  )
  if (!upd) throw new AppError(404, 'No active portability authorization to decline')
}

/**
 * Executes the carry-forward at lease-end time. Called from the
 * deposit-return engine when a deposit is in 'authorized' status.
 * AFTER the unpaid-balance sweep deducts landlord A's claims (done
 * inside finalizeDepositReturn), this function:
 *
 *   1. Confirms target lease is still valid
 *   2. Branch on held_by:
 *      - gam_escrow → no money movement; re-point unit_id/lease_id
 *        to target lease, flip portability_status='carried_forward',
 *        stamp carried_from_deposit_id on the (now-repointed) row.
 *      - landlord → can't move money in S255 (admin tool follow-up);
 *        flip portability_status='pending_transfer' + admin alert.
 *        Lease-end engine still skips the refund-to-tenant path
 *        because the tenant has signed away their right to a refund.
 *   3. Records the chain for audit.
 *
 * Idempotent: re-running on a 'carried_forward' deposit no-ops.
 */
export async function executeDepositPortability(args: {
  depositId: string
}): Promise<{ status: 'carried_forward' | 'pending_transfer'; new_lease_id: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const dep = await client.query<{
      id: string; tenant_id: string; lease_id: string; unit_id: string;
      portability_status: string; portability_target_lease_id: string | null;
      held_by: string; total_amount: string; collected_amount: string;
      flex_deposit_enabled: boolean;
    }>(
      `SELECT id, tenant_id, lease_id, unit_id,
              portability_status, portability_target_lease_id,
              held_by, total_amount::text, collected_amount::text,
              flex_deposit_enabled
         FROM security_deposits
        WHERE id = $1
        FOR UPDATE`,
      [args.depositId],
    ).then(r => r.rows[0])
    if (!dep) throw new AppError(404, 'Deposit not found')
    if (dep.portability_status === 'carried_forward') {
      await client.query('ROLLBACK')
      return { status: 'carried_forward', new_lease_id: dep.lease_id }
    }
    if (dep.portability_status !== 'authorized') {
      throw new AppError(409, `Deposit is in ${dep.portability_status} state — not ready to execute`)
    }
    if (!dep.portability_target_lease_id) {
      throw new AppError(500, 'Authorized but no target lease set')
    }

    // Confirm target lease is still valid + read its own (S515-created)
    // deposit row so we can merge into it rather than leave a duplicate.
    const target = await client.query<{
      id: string; unit_id: string;
      target_dep_id: string | null; required: string | null; target_touched: boolean;
    }>(
      `SELECT l.id, l.unit_id,
              td.id AS target_dep_id,
              td.total_amount::text AS required,
              COALESCE(td.flex_deposit_enabled OR td.collected_amount > 0, false) AS target_touched
         FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id
         LEFT JOIN LATERAL (
           SELECT id, total_amount, flex_deposit_enabled, collected_amount
             FROM security_deposits
            WHERE lease_id = l.id
            ORDER BY created_at DESC LIMIT 1
         ) td ON TRUE
        WHERE l.id = $1
          AND lt.tenant_id = $2
          AND lt.status = 'active'
          AND l.status IN ('pending', 'active')`,
      [dep.portability_target_lease_id, dep.tenant_id],
    ).then(r => r.rows[0])
    if (!target) {
      throw new AppError(409, 'Target lease no longer eligible (tenant not on it or lease closed)')
    }

    // Branch on holding model. Per Nic: push for GAM escrow.
    // landlord-held → flag for admin-mediated transfer, but still
    // re-point pointers + flip held_by='gam_escrow' (the row's
    // logical home is now GAM escrow; the physical money sweep
    // is what admin handles).
    const willConvertToEscrow = dep.held_by === 'landlord'
    const nextStatus = willConvertToEscrow ? 'pending_transfer' : 'carried_forward'

    // Required deposit at the target = its own row's amount (S515), falling
    // back to the carried amount (no increase) when the target has no row.
    const requiredAmount = target.required != null
      ? Number(target.required)
      : Number(dep.total_amount)

    // Remove the target lease's own untouched deposit row so the carried
    // (funded) row becomes the canonical deposit for the target lease — no
    // duplicate, no double-charge. Never delete a touched target row.
    if (target.target_dep_id && target.target_dep_id !== dep.id && !target.target_touched) {
      await client.query(`DELETE FROM security_deposits WHERE id = $1`, [target.target_dep_id])
    }

    // Re-point the carried row onto the target lease, set its required amount.
    await client.query(
      `UPDATE security_deposits
          SET lease_id            = $1,
              unit_id             = $2,
              held_by             = 'gam_escrow',
              portability_status  = $3,
              total_amount        = $4,
              updated_at          = NOW()
        WHERE id = $5`,
      [target.id, target.unit_id, nextStatus, requiredAmount.toFixed(2), args.depositId],
    )

    // Custody-fee + funding state — only for gam_escrow (FlexDeposit custody)
    // deposits. (Landlord-held funds are still pending an admin sweep.)
    let topUpOwed = 0
    if (!willConvertToEscrow) {
      const collected = Number(dep.collected_amount)
      const difference = Math.round((requiredAmount - collected) * 100) / 100
      if (difference <= 0) {
        // Fully funded by the carry-forward → ToS § 9.1.6: custody fee dissolves.
        await client.query(
          `UPDATE security_deposits
              SET status = 'funded',
                  flex_deposit_plan_status = CASE WHEN flex_deposit_enabled
                                                  THEN 'completed' ELSE flex_deposit_plan_status END,
                  installments_remaining = 0,
                  next_installment_date  = NULL,
                  custody_fee_active     = FALSE,
                  updated_at             = NOW()
            WHERE id = $1`,
          [args.depositId],
        )
      } else {
        // Larger deposit at the new property → a top-up is owed. The deposit
        // stays under-funded; custody fee continues. For a FlexDeposit, spread
        // the difference into installments the cron auto-collects (option 1,
        // fee stays); the tenant may pay it off via pay-ahead (option 2, fee
        // stops). For a non-FlexDeposit gam_escrow deposit, just flag it.
        topUpOwed = difference
        if (dep.flex_deposit_enabled) {
          await client.query(
            `UPDATE security_deposits
                SET status = 'partial', flex_deposit_plan_status = 'active',
                    custody_fee_active = TRUE, updated_at = NOW()
              WHERE id = $1`,
            [args.depositId],
          )
          const { scheduleFlexDepositTopUp } = await import('./flexDeposit')
          await scheduleFlexDepositTopUp(client, { depositId: args.depositId, topUpAmount: difference })
        } else {
          await client.query(
            `UPDATE security_deposits
                SET status = 'partial', custody_fee_active = TRUE, updated_at = NOW()
              WHERE id = $1`,
            [args.depositId],
          )
        }
      }
    }

    await client.query('COMMIT')

    if (topUpOwed > 0) {
      try {
        const { createAdminNotification } = await import('./adminNotifications')
        await createAdminNotification({
          severity: 'info',
          category: 'deposit_portability_topup_owed',
          title:    `FlexDeposit forward — top-up of $${topUpOwed.toFixed(2)} scheduled — tenant ${dep.tenant_id}`,
          body:     `Deposit ${args.depositId} carried forward to lease ${target.id}; the new property's required deposit is $${topUpOwed.toFixed(2)} more than the carried balance. ${dep.flex_deposit_enabled ? 'Top-up installments scheduled (auto-collected monthly); the tenant may pay it off early via pay-ahead, which stops the custody fee.' : 'Custody fee continues until funded.'}`,
          context:  { deposit_id: args.depositId, tenant_id: dep.tenant_id, new_lease_id: target.id, top_up_owed: topUpOwed },
        })
      } catch (e) {
        logger.error({ err: e }, '[deposit-portability][topup-alert]')
      }
    }

    // Admin alert outside tx for the landlord-held case
    if (willConvertToEscrow) {
      try {
        const { createAdminNotification } = await import('./adminNotifications')
        await createAdminNotification({
          severity: 'warn',
          category: 'deposit_portability_pending_transfer',
          title:    `Deposit portability pending transfer — deposit ${args.depositId}`,
          body:     `Tenant authorized carry-forward of a landlord-held deposit of $${Number(dep.total_amount).toFixed(2)} from lease ${dep.lease_id} to lease ${target.id}. The security_deposits row is now logically GAM-escrow and pointed at the new lease, but the physical funds are still in the previous landlord's Connect balance. Admin tool needed to move funds — Stripe reverse-Transfer or similar.`,
          context: {
            deposit_id:        args.depositId,
            previous_lease_id: dep.lease_id,
            new_lease_id:      target.id,
            tenant_id:         dep.tenant_id,
            amount:            Number(dep.total_amount),
          },
        })
      } catch (e) {
        logger.error({ err: e }, '[deposit-portability][alert]')
      }
    }

    return { status: nextStatus as any, new_lease_id: target.id }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
