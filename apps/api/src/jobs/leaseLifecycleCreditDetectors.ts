import { query, getClient } from '../db'
import {
  emitLeaseAnniversaryEvent,
  emitMultiLandlordHistoryCleanEvent,
} from '../services/creditLedgerEmitters'
import { logger } from '../lib/logger'

// ============================================================
// Daily lease-lifecycle credit detectors. Two passes:
//
//   1. lease_anniversary:
//        For every active lease whose start_date anniversary is
//        TODAY (UTC) AND the lease has been active ≥ 12 months,
//        emit lease_anniversary tagged with anniversary_year.
//        Idempotent: skip if a previous event with the same
//        (lease_id, anniversary_year) exists.
//
//   2. multi_landlord_history_clean:
//        For tenant subjects who have at least 2 distinct landlords
//        across lease_terminated_natural events AND zero adverse
//        events (any negatives-keyed event_type) on their chain
//        AND no prior multi_landlord_history_clean event — emit
//        the +500 one-time event. Lifetime cap.
//
// Both detectors fail-isolate per row.
// ============================================================

// Negatives keyset must be kept in sync with the v1.0.0 formula's
// negatives map. Hardcoding here to avoid pulling the formula on
// every detection run; a future change publishes a new formula and
// updates this list.
const ADVERSE_EVENT_TYPES = new Set([
  'payment_received_late_minor',
  'payment_received_late_major',
  'payment_received_late_severe',
  'payment_partial',
  'payment_failed_nsf',
  'payment_skipped',
  'noise_complaint_logged',
  'lease_violation_notice_issued',
  'property_damage_event_documented',
  'nuisance_event_documented',
  'entry_compliance_breach',
  'maintenance_response_breach_sla',
  'recurring_repair_same_issue',
  'recurring_lease_violation',
  'eviction_notice_filed',
  'eviction_settled',
  'eviction_hearing_judgment_issued',
  'lease_terminated_early_by_tenant',
  'lease_abandoned',
  'tenancy_ended_with_balance',
  'balance_sent_to_collections',
  'utility_balance_unpaid_at_move_out',
  'move_out_condition_damage_documented',
  'deposit_returned_partial',
  'deposit_returned_zero',
  'deposit_returned_late',
  'deposit_dispute_resolved_for_tenant',
  'habitability_complaint_unresolved_30d',
  'rent_increase_without_proper_notice',
  'utility_payment_late',
  'utility_disconnect_for_nonpayment',
  'telecom_payment_missed',
  'telecom_disconnect_for_nonpayment',
  'auto_loan_payment_late',
  'auto_loan_payment_missed',
  'auto_loan_default',
  'insurance_lapsed_nonpayment',
  'child_support_missed',
  'child_support_arrears',
  'medical_collections_event',
  'subscription_canceled_nonpayment',
])

export interface LeaseLifecycleResult {
  anniversaries_emitted: number
  multi_landlord_emitted: number
  errors: number
}

export async function processLeaseLifecycleCreditDetectors(): Promise<LeaseLifecycleResult> {
  let anniversariesEmitted = 0
  let multiLandlordEmitted = 0
  let errors = 0

  // 1. lease_anniversary
  // Pulls active/pending leases where ANY lease-year anniversary fell in
  // the last 7 days. Idempotency check below ensures already-emitted
  // anniversaries are skipped, so a 7-day backfill window safely re-runs
  // even if today's cron is the only one in a week.
  const today = new Date()

  const candidates = await query<{
    lease_id: string
    start_date: string
    tenant_id: string
  }>(
    `SELECT l.id AS lease_id, l.start_date, lt.tenant_id
       FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
      WHERE l.status IN ('active','pending')
        AND l.start_date IS NOT NULL
        AND l.start_date <= NOW() - INTERVAL '12 months'
        AND (
          -- anniversary's MM-DD landed within the last 7 days, allowing
          -- for year boundary by checking the date-portion of NOW() - i*1day
          EXISTS (
            SELECT 1 FROM generate_series(0, 6) AS i
             WHERE (EXTRACT(MONTH FROM l.start_date) = EXTRACT(MONTH FROM NOW() - (i || ' day')::interval))
               AND (EXTRACT(DAY   FROM l.start_date) = EXTRACT(DAY   FROM NOW() - (i || ' day')::interval))
          )
        )`,
  )

  for (const c of candidates) {
    try {
      const startDate = new Date(c.start_date)
      // Anniversary year = full years between start_date's MM-DD and today.
      // For a Feb-anniversary fired in Jan after a year-boundary, both
      // year diffs may apply. We just take the most recent qualifying
      // anniversary (years between start and today).
      const anniversaryYear =
        today.getUTCFullYear() - startDate.getUTCFullYear()
      if (anniversaryYear < 1) continue

      const dup = await query(
        `SELECT 1
           FROM credit_events e
           JOIN credit_subjects s ON s.id = e.subject_id
          WHERE s.subject_type = 'tenant'
            AND s.subject_ref_id = $1
            AND e.event_type = 'lease_anniversary'
            AND e.event_data ->> 'lease_id' = $2
            AND (e.event_data ->> 'anniversary_year')::int = $3
          LIMIT 1`,
        [c.tenant_id, c.lease_id, anniversaryYear],
      )
      if (dup.length > 0) continue

      const client = await getClient()
      try {
        await client.query('BEGIN')
        await emitLeaseAnniversaryEvent(client, {
          tenantId: c.tenant_id,
          leaseId: c.lease_id,
          anniversaryYear,
          occurredAt: new Date(),
        })
        await client.query('COMMIT')
        anniversariesEmitted += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      logger.error({ err: e, lease_id: c.lease_id, tenant_id: c.tenant_id }, '[lease-lifecycle][anniversary]')
      errors += 1
    }
  }

  // 2. multi_landlord_history_clean
  // Walk tenant subjects whose chain shows ≥2 distinct landlords with
  // a lease_terminated_natural event AND zero adverse events AND no
  // prior multi_landlord_history_clean.
  const candidateTenants = await query<{ subject_id: string; subject_ref_id: string }>(
    `SELECT s.id AS subject_id, s.subject_ref_id
       FROM credit_subjects s
      WHERE s.subject_type = 'tenant'
        AND NOT EXISTS (
          SELECT 1 FROM credit_events ce
           WHERE ce.subject_id = s.id
             AND ce.event_type = 'multi_landlord_history_clean'
        )
        AND EXISTS (
          SELECT 1 FROM credit_events ce
           WHERE ce.subject_id = s.id
             AND ce.event_type = 'lease_terminated_natural'
        )`,
  )

  for (const t of candidateTenants) {
    try {
      // Adverse-event check
      const adverseCount = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM credit_events
          WHERE subject_id = $1
            AND superseded_by IS NULL
            AND event_type = ANY($2::text[])`,
        [t.subject_id, Array.from(ADVERSE_EVENT_TYPES)],
      )
      if (parseInt(adverseCount[0].n, 10) > 0) continue

      // Distinct landlord count: walk lease_terminated_natural events,
      // resolve each lease's landlord_id via the leases table.
      const naturalLeases = await query<{ lease_id: string }>(
        `SELECT (event_data ->> 'lease_id') AS lease_id
           FROM credit_events
          WHERE subject_id = $1
            AND event_type = 'lease_terminated_natural'
            AND superseded_by IS NULL`,
        [t.subject_id],
      )
      if (naturalLeases.length === 0) continue

      const leaseIds = naturalLeases.map((r) => r.lease_id).filter(Boolean) as string[]
      if (leaseIds.length === 0) continue

      const landlordCountRow = await query<{
        n: string
      }>(
        `SELECT COUNT(DISTINCT landlord_id)::text AS n
           FROM leases
          WHERE id = ANY($1::uuid[])`,
        [leaseIds],
      )
      const distinctLandlords = parseInt(landlordCountRow[0].n, 10)
      if (distinctLandlords < 2) continue

      const client = await getClient()
      try {
        await client.query('BEGIN')
        await emitMultiLandlordHistoryCleanEvent(client, {
          tenantId: t.subject_ref_id,
          landlordCount: distinctLandlords,
          cleanLeaseCount: leaseIds.length,
          occurredAt: new Date(),
        })
        await client.query('COMMIT')
        multiLandlordEmitted += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      logger.error({ err: e, subject_id: t.subject_id }, '[lease-lifecycle][multi-landlord]')
      errors += 1
    }
  }

  return {
    anniversaries_emitted: anniversariesEmitted,
    multi_landlord_emitted: multiLandlordEmitted,
    errors,
  }
}
