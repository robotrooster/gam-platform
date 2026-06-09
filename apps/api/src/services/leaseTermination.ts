import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { appendEvent } from './creditLedger'
import { logger } from '../lib/logger'

// ============================================================
// Early-termination service.
//
// Quote model (priority order):
//   1. lease_fees row with fee_type='early_termination_fee' →
//      fee_basis='lease_specific', amount = that row's amount
//   2. landlord.default_early_termination_months_rent (if non-null)
//      × lease.rent_amount → fee_basis='landlord_default'
//   3. neither set → fee_basis='no_policy', amount = 0
//
// Flow (per S153 Q2 C + Q4 A):
//   1. Tenant calls quoteFee() to preview
//   2. Tenant calls requestEarlyTermination() with confirmation
//   3. Service creates a lease_termination_requests row in 'requested'
//      status, attempts auto-charge against tenant's Stripe customer
//   4. On success: status='fee_paid', terminated_at=NOW(), lease
//      status flips to 'terminated', credit-ledger event emitted,
//      lease_tenants flipped to removed, unit vacated
//   5. On failure: status='failed', tenant can retry or cancel
//   6. Landlord can call waiveFeeAndTerminate() at any time while
//      status is 'requested' or 'failed' — bypasses the charge,
//      flips lease to terminated.
// ============================================================

export interface FeeQuote {
  fee_amount: number
  fee_basis: 'lease_specific' | 'landlord_default' | 'no_policy'
  rent_amount: number
  months_rent_multiplier: number | null
}

export async function quoteFee(leaseId: string): Promise<FeeQuote> {
  const lease = await queryOne<{ rent_amount: string; landlord_id: string }>(
    `SELECT rent_amount, landlord_id FROM leases WHERE id = $1`,
    [leaseId],
  )
  if (!lease) throw new Error(`Lease ${leaseId} not found`)
  const rent = Number(lease.rent_amount)

  // Priority 1: lease-specific fee
  const leaseFee = await queryOne<{ amount: string }>(
    `SELECT amount FROM lease_fees
      WHERE lease_id = $1 AND fee_type = 'early_termination_fee'
      LIMIT 1`,
    [leaseId],
  )
  if (leaseFee) {
    return {
      fee_amount: Number(leaseFee.amount),
      fee_basis: 'lease_specific',
      rent_amount: rent,
      months_rent_multiplier: null,
    }
  }

  // Priority 2: landlord default policy
  const landlord = await queryOne<{ default_early_termination_months_rent: string | null }>(
    `SELECT default_early_termination_months_rent FROM landlords WHERE id = $1`,
    [lease.landlord_id],
  )
  const months = landlord?.default_early_termination_months_rent
    ? Number(landlord.default_early_termination_months_rent)
    : null
  if (months !== null && months > 0) {
    return {
      fee_amount: round2(rent * months),
      fee_basis: 'landlord_default',
      rent_amount: rent,
      months_rent_multiplier: months,
    }
  }

  // Priority 3: no policy
  return {
    fee_amount: 0,
    fee_basis: 'no_policy',
    rent_amount: rent,
    months_rent_multiplier: null,
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export interface TerminationRequestRow {
  id: string
  lease_id: string
  tenant_id: string
  landlord_id: string
  requested_at: string
  requested_by_user_id: string
  reason: string | null
  fee_amount: string
  fee_basis: 'lease_specific' | 'landlord_default' | 'no_policy'
  fee_payment_id: string | null
  fee_paid_at: string | null
  fee_charge_failed: boolean
  fee_charge_failure_reason: string | null
  fee_waived_at: string | null
  fee_waived_by_user_id: string | null
  fee_waiver_reason: string | null
  terminated_at: string | null
  status: 'requested' | 'fee_paid' | 'fee_waived' | 'terminated' | 'cancelled' | 'failed'
  notes: string | null
  created_at: string
  updated_at: string
}

export async function getActiveOrLatestRequest(leaseId: string): Promise<TerminationRequestRow | null> {
  const row = await queryOne<TerminationRequestRow>(
    `SELECT * FROM lease_termination_requests
      WHERE lease_id = $1
      ORDER BY (status = 'requested') DESC, created_at DESC
      LIMIT 1`,
    [leaseId],
  )
  return row
}

/**
 * Tenant-initiated early-termination request. If fee > 0, attempts
 * an immediate auto-charge against the tenant's on-file payment
 * method. On success: lease.status flips to 'terminated' in the same
 * transaction. On failure: returns the failure for the UI to surface;
 * tenant can retry or cancel.
 *
 * If fee_amount is 0 (no_policy), the request goes through directly
 * without a charge — lease terminates with `fee_waived_at` set to
 * NOW() and reason 'no_policy' (so the audit trail captures it).
 */
export async function requestEarlyTermination(args: {
  leaseId: string
  tenantId: string
  requestedByUserId: string
  reason?: string
}): Promise<{ request: TerminationRequestRow; chargeStatus: 'paid' | 'failed' | 'no_charge_needed' }> {
  const quote = await quoteFee(args.leaseId)

  const lease = await queryOne<{ status: string; landlord_id: string }>(
    `SELECT status, landlord_id FROM leases WHERE id = $1`,
    [args.leaseId],
  )
  if (!lease) throw new Error(`Lease ${args.leaseId} not found`)
  if (lease.status !== 'active' && lease.status !== 'pending') {
    throw new Error(`Cannot terminate lease in status ${lease.status}`)
  }

  // Reject duplicate active requests
  const existing = await queryOne(
    `SELECT 1 FROM lease_termination_requests WHERE lease_id = $1 AND status = 'requested'`,
    [args.leaseId],
  )
  if (existing) {
    throw new Error('A termination request is already in progress for this lease')
  }

  // Stripe customer + default payment method (lazy-loaded; only needed
  // when fee > 0)
  let stripeCustomerId: string | null = null
  if (quote.fee_amount > 0) {
    const t = await queryOne<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [args.tenantId],
    )
    stripeCustomerId = t?.stripe_customer_id ?? null
  }

  const client = await getClient()
  let request: TerminationRequestRow
  let chargeStatus: 'paid' | 'failed' | 'no_charge_needed' = 'no_charge_needed'

  try {
    await client.query('BEGIN')

    // Create the request row
    const ins = await client.query<TerminationRequestRow>(
      `INSERT INTO lease_termination_requests (
         lease_id, tenant_id, landlord_id,
         requested_by_user_id, reason,
         fee_amount, fee_basis,
         status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested')
       RETURNING *`,
      [
        args.leaseId,
        args.tenantId,
        lease.landlord_id,
        args.requestedByUserId,
        args.reason ?? null,
        quote.fee_amount,
        quote.fee_basis,
      ],
    )
    request = ins.rows[0]

    // No-policy path: skip charge, flip to fee_waived (no fee was
    // owed so it's effectively waived), terminate immediately.
    if (quote.fee_amount === 0) {
      await client.query(
        `UPDATE lease_termination_requests
            SET status = 'fee_waived',
                fee_waived_at = NOW(),
                fee_waiver_reason = 'no_policy_on_file',
                updated_at = NOW()
          WHERE id = $1`,
        [request.id],
      )
      await terminateInTx(client, request.id, request.lease_id, request.landlord_id, request.tenant_id, 'no_policy')
      const final = await client.query<TerminationRequestRow>(
        `SELECT * FROM lease_termination_requests WHERE id = $1`,
        [request.id],
      )
      request = final.rows[0]
    }

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // Charge path (post-commit; failure marks the row but doesn't roll
  // back the request creation — tenant can retry).
  if (quote.fee_amount > 0) {
    const result = await chargeAndTerminate(request.id, stripeCustomerId)
    chargeStatus = result.charged ? 'paid' : 'failed'
    const refreshed = await queryOne<TerminationRequestRow>(
      `SELECT * FROM lease_termination_requests WHERE id = $1`,
      [request.id],
    )
    if (refreshed) request = refreshed
  }

  return { request, chargeStatus }
}

async function chargeAndTerminate(
  requestId: string,
  stripeCustomerId: string | null,
): Promise<{ charged: boolean; reason?: string }> {
  if (!stripeCustomerId) {
    await markChargeFailed(requestId, 'No Stripe customer id on file')
    return { charged: false, reason: 'No Stripe customer id on file' }
  }

  const req = await queryOne<TerminationRequestRow>(
    `SELECT * FROM lease_termination_requests WHERE id = $1`,
    [requestId],
  )
  if (!req) return { charged: false, reason: 'Request not found' }

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' as any })

  let paymentMethodId: string | null = null
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId)
    if (customer && !(customer as any).deleted) {
      const c = customer as any
      paymentMethodId =
        c.invoice_settings?.default_payment_method ??
        c.default_source ??
        null
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markChargeFailed(requestId, `Stripe customer lookup failed: ${msg}`)
    return { charged: false, reason: msg }
  }

  if (!paymentMethodId) {
    await markChargeFailed(requestId, 'No default payment method on file')
    return { charged: false, reason: 'No default payment method on file' }
  }

  // Create the GAM payments row first so we have an id to pass into
  // Stripe metadata + can mark fee_payment_id on the request.
  const lease = await queryOne<{ unit_id: string }>(
    `SELECT unit_id FROM leases WHERE id = $1`,
    [req.lease_id],
  )
  const payment = await queryOne<{ id: string }>(
    `INSERT INTO payments (
       landlord_id, tenant_id, lease_id, unit_id,
       type, amount, status, entry_description, due_date, notes
     ) VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'LATEFEE', CURRENT_DATE, $6)
     RETURNING id`,
    [
      req.landlord_id,
      req.tenant_id,
      req.lease_id,
      lease?.unit_id,
      Number(req.fee_amount),
      `Early-termination fee for lease ${req.lease_id}`,
    ],
  )
  await query(
    `UPDATE lease_termination_requests SET fee_payment_id = $1 WHERE id = $2`,
    [payment!.id, requestId],
  )

  try {
    await stripe.paymentIntents.create({
      amount: Math.round(Number(req.fee_amount) * 100),
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        gam_payment_id: payment!.id,
        gam_kind: 'early_termination_fee',
        lease_termination_request_id: requestId,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markChargeFailed(requestId, `Stripe charge failed: ${msg}`)
    return { charged: false, reason: msg }
  }

  // Stripe charge succeeded. Now flip request to fee_paid + terminate
  // the lease in a single transaction.
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE lease_termination_requests
          SET status = 'fee_paid',
              fee_paid_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [requestId],
    )
    await terminateInTx(client, requestId, req.lease_id, req.landlord_id, req.tenant_id, 'lease_terminated_early_by_tenant')
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  return { charged: true }
}

async function markChargeFailed(requestId: string, reason: string) {
  await query(
    `UPDATE lease_termination_requests
        SET fee_charge_failed = TRUE,
            fee_charge_failure_reason = $1,
            status = 'failed',
            updated_at = NOW()
      WHERE id = $2`,
    [reason, requestId],
  )
  try {
    const { createAdminNotification } = await import('./adminNotifications')
    await createAdminNotification({
      severity: 'warn',
      category: 'early_termination_charge_failed',
      title: 'Early-termination charge failed',
      body: `Termination request ${requestId} could not auto-charge the tenant. Reason: ${reason}.`,
      context: { request_id: requestId, reason },
    })
  } catch (e) {
    logger.error({ err: e }, '[termination][charge-fail-alert]')
  }
}

/**
 * Landlord-initiated waiver. Bypasses the charge, terminates the lease.
 * Status must be 'requested' or 'failed' (i.e. not yet finalized).
 */
export async function waiveFeeAndTerminate(args: {
  requestId: string
  waivedByUserId: string
  reason?: string
}): Promise<TerminationRequestRow> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const cur = await client.query<TerminationRequestRow>(
      `SELECT * FROM lease_termination_requests WHERE id = $1 FOR UPDATE`,
      [args.requestId],
    )
    if (cur.rows.length === 0) throw new Error('Request not found')
    const req = cur.rows[0]
    if (req.status !== 'requested' && req.status !== 'failed') {
      throw new Error(`Cannot waive request in status ${req.status}`)
    }

    await client.query(
      `UPDATE lease_termination_requests
          SET status = 'fee_waived',
              fee_waived_at = NOW(),
              fee_waived_by_user_id = $1,
              fee_waiver_reason = $2,
              fee_charge_failed = FALSE,
              updated_at = NOW()
        WHERE id = $3`,
      [args.waivedByUserId, args.reason ?? null, args.requestId],
    )
    await terminateInTx(client, req.id, req.lease_id, req.landlord_id, req.tenant_id, 'lease_terminated_early_by_landlord')

    const final = await client.query<TerminationRequestRow>(
      `SELECT * FROM lease_termination_requests WHERE id = $1`,
      [args.requestId],
    )
    await client.query('COMMIT')
    return final.rows[0]
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Tenant cancels a pending request before it terminates. Allowed only
 * while status is 'requested' or 'failed'.
 */
export async function cancelRequest(requestId: string): Promise<TerminationRequestRow | null> {
  const cur = await queryOne<TerminationRequestRow>(
    `SELECT status FROM lease_termination_requests WHERE id = $1`,
    [requestId],
  )
  if (!cur) return null
  if (cur.status !== 'requested' && cur.status !== 'failed') {
    throw new Error(`Cannot cancel request in status ${cur.status}`)
  }
  return queryOne<TerminationRequestRow>(
    `UPDATE lease_termination_requests
        SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [requestId],
  )
}

/**
 * Internal: flip lease to terminated, cascade lease_tenants + units,
 * stamp the request's terminated_at, emit credit-ledger event.
 * Caller owns the transaction client.
 */
async function terminateInTx(
  client: PoolClient,
  requestId: string,
  leaseId: string,
  landlordId: string,
  tenantId: string,
  eventType: 'lease_terminated_early_by_tenant' | 'lease_terminated_early_by_landlord' | 'no_policy',
): Promise<void> {
  const lease = await client.query<{ unit_id: string }>(
    `UPDATE leases SET status = 'terminated', terminated_at = NOW()
      WHERE id = $1
      RETURNING unit_id`,
    [leaseId],
  )
  await client.query(
    `UPDATE lease_tenants
        SET status = 'removed', removed_at = NOW(), removed_reason = 'lease_ended', updated_at = NOW()
      WHERE lease_id = $1 AND status IN ('active','pending_add','pending_remove')`,
    [leaseId],
  )
  if (lease.rows[0]) {
    await client.query(
      `UPDATE units SET status = 'vacant', updated_at = NOW() WHERE id = $1`,
      [lease.rows[0].unit_id],
    )
  }
  await client.query(
    `UPDATE lease_termination_requests
        SET terminated_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [requestId],
  )

  // Credit-ledger event. 'no_policy' path emits a generic
  // lease_terminated_early_by_tenant since that's the closest match;
  // event_data carries the no_policy flag for future analysis.
  const ledgerEventType = eventType === 'no_policy' ? 'lease_terminated_early_by_tenant' : eventType
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: tenantId,
      eventType: ledgerEventType,
      eventData: {
        lease_id: leaseId,
        termination_request_id: requestId,
        no_policy: eventType === 'no_policy',
      },
      occurredAt: new Date(),
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { lease_termination_request_id: requestId },
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
  // Landlord-side mirror event
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: landlordId,
      eventType: ledgerEventType,
      eventData: {
        lease_id: leaseId,
        termination_request_id: requestId,
        no_policy: eventType === 'no_policy',
      },
      occurredAt: new Date(),
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { lease_termination_request_id: requestId },
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}
