import { query, getClient } from '../db'
import {
  emitTenancyEndedWithBalanceEvent,
  emitBalancePaidPostMoveEvent,
} from '../services/creditLedgerEmitters'
import { logger } from '../lib/logger'

// ============================================================
// Daily detectors over the lease + invoice + credit_event chain.
// Fires:
//   1. tenancy_ended_with_balance — when a lease terminated in the
//      last 24h has unsettled invoices. Idempotent per lease_id.
//   2. balance_paid_post_move — when a tenant who previously had a
//      tenancy_ended_with_balance event has now paid down to zero
//      outstanding on that lease. One-time per lease_id.
// ============================================================

export interface BalanceDetectorResult {
  tenancy_ended_with_balance_emitted: number
  balance_paid_post_move_emitted: number
  errors: number
}

export async function processBalanceCreditDetectors(): Promise<BalanceDetectorResult> {
  let endedEmitted = 0
  let paidEmitted = 0
  let errors = 0

  // 1. tenancy_ended_with_balance: leases terminated in last 24h with
  // unsettled invoices for the tenant.
  const recentlyEnded = await query<{
    lease_id: string
    tenant_id: string
    terminated_at: string
  }>(
    `SELECT DISTINCT l.id AS lease_id, lt.tenant_id, l.terminated_at
       FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
      WHERE l.terminated_at IS NOT NULL
        AND l.terminated_at >= NOW() - INTERVAL '1 day'
        AND lt.tenant_id IS NOT NULL`,
  )

  for (const row of recentlyEnded) {
    try {
      // Outstanding balance for this lease + tenant
      const bal = await query<{ expected: string; received: string; outstanding: string }>(
        `SELECT
            COALESCE(SUM(total_amount), 0)::text                                         AS expected,
            COALESCE(SUM(CASE WHEN status='settled' THEN total_amount ELSE 0 END), 0)::text AS received,
            COALESCE(SUM(CASE WHEN status IN ('pending','partial') THEN total_amount ELSE 0 END), 0)::text AS outstanding
           FROM invoices
          WHERE lease_id = $1
            AND tenant_id = $2`,
        [row.lease_id, row.tenant_id],
      )
      const outstanding = parseFloat(bal[0].outstanding || '0')
      if (outstanding <= 0) continue

      const dup = await query(
        `SELECT 1
           FROM credit_events e
           JOIN credit_subjects s ON s.id = e.subject_id
          WHERE s.subject_type = 'tenant'
            AND s.subject_ref_id = $1
            AND e.event_type = 'tenancy_ended_with_balance'
            AND e.event_data ->> 'lease_id' = $2
          LIMIT 1`,
        [row.tenant_id, row.lease_id],
      )
      if (dup.length > 0) continue

      const expected = parseFloat(bal[0].expected || '0')
      const received = parseFloat(bal[0].received || '0')

      const client = await getClient()
      try {
        await client.query('BEGIN')
        await emitTenancyEndedWithBalanceEvent(client, {
          tenantId:      row.tenant_id,
          leaseId:       row.lease_id,
          expectedTotal: expected,
          receivedTotal: received,
          delta:         outstanding,
          occurredAt:    new Date(row.terminated_at),
        })
        await client.query('COMMIT')
        endedEmitted += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      logger.error({ err: e, lease_id: row.lease_id }, '[balance-credit-detector][ended_with_balance]')
      errors += 1
    }
  }

  // 2. balance_paid_post_move: tenants with a prior
  // tenancy_ended_with_balance whose outstanding is now zero AND who
  // don't already have a balance_paid_post_move for that lease.
  const candidates = await query<{
    subject_id: string
    subject_ref_id: string
    lease_id: string
  }>(
    `SELECT s.id AS subject_id, s.subject_ref_id, ce.event_data ->> 'lease_id' AS lease_id
       FROM credit_events ce
       JOIN credit_subjects s ON s.id = ce.subject_id
      WHERE ce.event_type = 'tenancy_ended_with_balance'
        AND ce.superseded_by IS NULL
        AND s.subject_type = 'tenant'
        AND NOT EXISTS (
          SELECT 1 FROM credit_events ce2
           WHERE ce2.subject_id = s.id
             AND ce2.event_type = 'balance_paid_post_move'
             AND ce2.event_data ->> 'lease_id' = ce.event_data ->> 'lease_id'
        )`,
  )

  for (const c of candidates) {
    try {
      if (!c.lease_id) continue
      const bal = await query<{ outstanding: string }>(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('pending','partial') THEN total_amount ELSE 0 END), 0)::text AS outstanding
           FROM invoices
          WHERE lease_id = $1 AND tenant_id = $2`,
        [c.lease_id, c.subject_ref_id],
      )
      const outstanding = parseFloat(bal[0].outstanding || '0')
      if (outstanding > 0) continue

      const client = await getClient()
      try {
        await client.query('BEGIN')
        await emitBalancePaidPostMoveEvent(client, {
          tenantId:   c.subject_ref_id,
          leaseId:    c.lease_id,
          occurredAt: new Date(),
        })
        await client.query('COMMIT')
        paidEmitted += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      logger.error({ err: e, subject_id: c.subject_id }, '[balance-credit-detector][paid_post_move]')
      errors += 1
    }
  }

  return {
    tenancy_ended_with_balance_emitted: endedEmitted,
    balance_paid_post_move_emitted: paidEmitted,
    errors,
  }
}
