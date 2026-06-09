import type { PoolClient } from 'pg'
import { appendEvent } from './creditLedger'
import type { CreditEventType } from '@gam/shared'

// ============================================================
// Credit-ledger emitters: thin wrappers that compute the right
// event_type + dimension_tags + visibility for each workflow
// trigger and call appendEvent.
//
// Each emitter accepts an existing PoolClient so the ledger write
// is part of the same transaction as the workflow that triggered
// it (payment settlement, lease materialization, etc.).
// ============================================================

const DEFAULT_GRACE_DAYS = 5

/**
 * Classify a settled rent/utility payment into one of the five
 * payment-event tiers. Comparison basis: end-of-day Phoenix-local
 * for due_date (we treat due_date as a calendar day, not a moment).
 *
 * Tier boundaries:
 *   on_time:    settled <= due_date end-of-day
 *   late_grace: due_date < settled <= due_date + grace_days
 *   late_minor: 0 < (settled - grace_end) <= 72h
 *   late_major: 72h < (settled - grace_end) <= 15d
 *   late_severe: > 15d past grace_end
 */
export function classifyPaymentTier(args: {
  dueDate: Date
  settledAt: Date
  graceDays: number
}): CreditEventType {
  const dueEnd = endOfUtcDay(args.dueDate)
  if (args.settledAt.getTime() <= dueEnd.getTime()) {
    return 'payment_received_on_time'
  }
  const graceEnd = endOfUtcDay(addDays(args.dueDate, args.graceDays))
  if (args.settledAt.getTime() <= graceEnd.getTime()) {
    return 'payment_received_late_grace'
  }
  const hoursPastGrace = (args.settledAt.getTime() - graceEnd.getTime()) / 3_600_000
  if (hoursPastGrace <= 72) return 'payment_received_late_minor'
  const daysPastGrace = hoursPastGrace / 24
  if (daysPastGrace <= 15) return 'payment_received_late_major'
  return 'payment_received_late_severe'
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + days)
  return out
}

function endOfUtcDay(d: Date): Date {
  const out = new Date(d)
  out.setUTCHours(23, 59, 59, 999)
  return out
}

/**
 * Emit a payment event from the payment_intent.succeeded webhook.
 * Tags the payment_reliability dimension. Visibility:
 *   - on_time / late_grace → visible_to_current_landlord (positive routine)
 *   - late_* / partial / nsf / skipped → visible_to_gam_network (adverse)
 */
export async function emitPaymentSettledEvent(
  client: PoolClient,
  args: {
    tenantId: string
    paymentId: string
    paymentType: 'rent' | 'utility'
    amount: string | number
    dueDate: Date
    settledAt: Date
    graceDays: number | null
    stripePaymentIntentId: string | null
  },
): Promise<void> {
  const eventType = classifyPaymentTier({
    dueDate: args.dueDate,
    settledAt: args.settledAt,
    graceDays: args.graceDays ?? DEFAULT_GRACE_DAYS,
  })

  const visibility =
    eventType === 'payment_received_on_time' || eventType === 'payment_received_late_grace'
      ? 'visible_to_current_landlord'
      : 'visible_to_gam_network'

  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType,
      eventData: {
        payment_id: args.paymentId,
        payment_type: args.paymentType,
        amount: typeof args.amount === 'string' ? args.amount : String(args.amount),
        due_date: args.dueDate.toISOString(),
        paid_at: args.settledAt.toISOString(),
        grace_days: args.graceDays ?? DEFAULT_GRACE_DAYS,
      },
      occurredAt: args.settledAt,
      attestationSource: 'stripe_attested',
      attestationEvidence: args.stripePaymentIntentId
        ? { stripe_payment_intent_id: args.stripePaymentIntentId }
        : {},
      dimensionTags: ['payment_reliability'],
      networkVisibility: visibility,
    },
    client,
  )
}

/**
 * Emit a payment_failed_nsf event when a Stripe ACH payment fails.
 * Distinguished from `payment_skipped` (which fires when a tenant
 * never initiates a payment for a due lease_fee — that's emitted
 * by the late-payment scheduler, not the webhook).
 */
export async function emitPaymentFailedEvent(
  client: PoolClient,
  args: {
    tenantId: string
    paymentId: string
    paymentType: 'rent' | 'utility'
    amount: string | number
    dueDate: Date
    failedAt: Date
    stripePaymentIntentId: string | null
    failureCode: string | null
    failureMessage: string | null
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'payment_failed_nsf',
      eventData: {
        payment_id: args.paymentId,
        payment_type: args.paymentType,
        amount: typeof args.amount === 'string' ? args.amount : String(args.amount),
        due_date: args.dueDate.toISOString(),
        failed_at: args.failedAt.toISOString(),
        failure_code: args.failureCode,
        failure_message: args.failureMessage,
      },
      occurredAt: args.failedAt,
      attestationSource: 'stripe_attested',
      attestationEvidence: args.stripePaymentIntentId
        ? { stripe_payment_intent_id: args.stripePaymentIntentId }
        : {},
      dimensionTags: ['payment_reliability'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Emit a lease_signed event for one tenant subject. Each tenant signer
 * gets their own event; the landlord event is emitted separately
 * (once per lease, not once per tenant) via emitLeaseSignedLandlord.
 */
export async function emitLeaseSignedTenant(
  client: PoolClient,
  args: {
    tenantId: string
    leaseId: string
    documentId: string
    signedAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'lease_signed',
      eventData: {
        lease_id: args.leaseId,
        document_id: args.documentId,
        signed_at: args.signedAt.toISOString(),
      },
      occurredAt: args.signedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { lease_document_id: args.documentId },
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit a single lease_signed event on the landlord subject — one per
 * lease, regardless of how many tenants signed it.
 */
export async function emitLeaseSignedLandlord(
  client: PoolClient,
  args: {
    landlordId: string
    leaseId: string
    documentId: string
    signedAt: Date
    tenantCount: number
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'lease_signed',
      eventData: {
        lease_id: args.leaseId,
        document_id: args.documentId,
        signed_at: args.signedAt.toISOString(),
        tenant_count: args.tenantCount,
      },
      occurredAt: args.signedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { lease_document_id: args.documentId },
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit inspection-finalized events. Called from the inspection-finalize
 * route once both tenant and landlord have signed off.
 *
 * Move-in finalize emits:
 *   - move_in_inspection_completed (tenant subject)
 *   - unit_ready_on_move_in_date (landlord subject) when conducted
 *     within 1 day of the lease start_date
 *   - move_in_photos_submitted (tenant subject) if any photos attached
 *
 * Move-out finalize emits:
 *   - move_out_inspection_completed (tenant subject)
 *   - one of move_out_condition_matches_move_in OR
 *     move_out_condition_damage_documented (tenant subject) per the
 *     comparison-inspection result
 *   - move_out_photos_submitted (tenant subject) if any photos attached
 */
export async function emitInspectionFinalizedEvents(
  client: PoolClient,
  args: {
    inspectionType: 'move_in' | 'move_out' | 'periodic'
    tenantId: string | null
    landlordId: string
    inspectionId: string
    finalizedAt: Date
    photoCount: number
    leaseStartDate?: Date | null
    matchesMoveIn?: boolean
    damageDocumented?: boolean
  },
): Promise<void> {
  if (args.inspectionType === 'periodic') return
  const evidence = { inspection_id: args.inspectionId }

  if (args.inspectionType === 'move_in' && args.tenantId) {
    await appendEvent(
      {
        subjectType: 'tenant',
        subjectRefId: args.tenantId,
        eventType: 'move_in_inspection_completed',
        eventData: {
          inspection_id: args.inspectionId,
          finalized_at: args.finalizedAt.toISOString(),
        },
        occurredAt: args.finalizedAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: evidence,
        dimensionTags: ['property_care', 'tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      },
      client,
    )

    if (args.photoCount > 0) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'move_in_photos_submitted',
          eventData: { inspection_id: args.inspectionId, photo_count: args.photoCount },
          occurredAt: args.finalizedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: evidence,
          dimensionTags: ['property_care'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    }

    // Landlord-side: unit_ready_on_move_in_date when finalized close to
    // the lease start. We treat "close" as ±1 calendar day; the tenant
    // attesting via signature is what makes this a landlord-positive
    // event.
    if (args.leaseStartDate) {
      const dayMs = 24 * 3_600_000
      const delta = Math.abs(args.finalizedAt.getTime() - args.leaseStartDate.getTime())
      if (delta <= dayMs) {
        await appendEvent(
          {
            subjectType: 'landlord',
            subjectRefId: args.landlordId,
            eventType: 'unit_ready_on_move_in_date',
            eventData: {
              inspection_id: args.inspectionId,
              finalized_at: args.finalizedAt.toISOString(),
              lease_start_date: args.leaseStartDate.toISOString(),
            },
            occurredAt: args.finalizedAt,
            attestationSource: 'gam_workflow_auto',
            attestationEvidence: evidence,
            dimensionTags: ['property_care', 'cooperation'],
            networkVisibility: 'visible_to_current_landlord',
          },
          client,
        )
      }
    }
  }

  if (args.inspectionType === 'move_out' && args.tenantId) {
    await appendEvent(
      {
        subjectType: 'tenant',
        subjectRefId: args.tenantId,
        eventType: 'move_out_inspection_completed',
        eventData: {
          inspection_id: args.inspectionId,
          finalized_at: args.finalizedAt.toISOString(),
        },
        occurredAt: args.finalizedAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: evidence,
        dimensionTags: ['property_care', 'tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      },
      client,
    )

    if (args.photoCount > 0) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'move_out_photos_submitted',
          eventData: { inspection_id: args.inspectionId, photo_count: args.photoCount },
          occurredAt: args.finalizedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: evidence,
          dimensionTags: ['property_care'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    }

    if (args.matchesMoveIn) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'move_out_condition_matches_move_in',
          eventData: { inspection_id: args.inspectionId },
          occurredAt: args.finalizedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: evidence,
          dimensionTags: ['property_care'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    } else if (args.damageDocumented) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'move_out_condition_damage_documented',
          eventData: { inspection_id: args.inspectionId },
          occurredAt: args.finalizedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: evidence,
          dimensionTags: ['property_care'],
          networkVisibility: 'visible_to_gam_network',
        },
        client,
      )
    }
  }
}

/**
 * Emit tenancy_ended_with_balance for the tenant subject. Fired by a
 * post-termination detector when the tenant has unsettled invoices
 * for the terminated lease.
 */
export async function emitTenancyEndedWithBalanceEvent(
  client: PoolClient,
  args: {
    tenantId: string
    leaseId: string
    expectedTotal: number
    receivedTotal: number
    delta: number
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'tenancy_ended_with_balance',
      eventData: {
        lease_id: args.leaseId,
        expected_total: args.expectedTotal,
        received_total: args.receivedTotal,
        delta: args.delta,
        settlement_status: 'unpaid',
      },
      occurredAt: args.occurredAt,
      attestationSource: 'system_derived',
      attestationEvidence: { lease_id: args.leaseId },
      dimensionTags: ['payment_reliability', 'tenancy_stability'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Emit balance_paid_post_move for the tenant subject. Fired when a
 * previously-flagged outstanding balance returns to zero post-termination.
 */
export async function emitBalancePaidPostMoveEvent(
  client: PoolClient,
  args: {
    tenantId: string
    leaseId: string
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'balance_paid_post_move',
      eventData: { lease_id: args.leaseId },
      occurredAt: args.occurredAt,
      attestationSource: 'system_derived',
      attestationEvidence: { lease_id: args.leaseId },
      dimensionTags: ['payment_reliability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit lease_terminated_natural events for every active tenant on the
 * lease + a single landlord event. Fires from processLeaseEnds when
 * a lease ends without auto-renew (natural expiry).
 */
export async function emitLeaseTerminatedNaturalEvents(
  client: PoolClient,
  args: {
    leaseId: string
    landlordId: string
    tenantIds: string[]
    terminatedAt: Date
  },
): Promise<void> {
  const evidence = { lease_id: args.leaseId }
  for (const tid of args.tenantIds) {
    await appendEvent(
      {
        subjectType: 'tenant',
        subjectRefId: tid,
        eventType: 'lease_terminated_natural',
        eventData: { lease_id: args.leaseId, terminated_at: args.terminatedAt.toISOString() },
        occurredAt: args.terminatedAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: evidence,
        dimensionTags: ['tenancy_stability'],
        networkVisibility: 'visible_to_gam_network',
      },
      client,
    )
  }
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'lease_terminated_natural',
      eventData: { lease_id: args.leaseId, terminated_at: args.terminatedAt.toISOString() },
      occurredAt: args.terminatedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: evidence,
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit lease_renewed events when auto-renewal fires (extend_same_term
 * branch of processLeaseEnds). Per-tenant + single landlord event.
 */
export async function emitLeaseRenewedEvents(
  client: PoolClient,
  args: {
    leaseId: string
    landlordId: string
    tenantIds: string[]
    renewedAt: Date
  },
): Promise<void> {
  const evidence = { lease_id: args.leaseId }
  for (const tid of args.tenantIds) {
    await appendEvent(
      {
        subjectType: 'tenant',
        subjectRefId: tid,
        eventType: 'lease_renewed',
        eventData: { lease_id: args.leaseId, renewed_at: args.renewedAt.toISOString() },
        occurredAt: args.renewedAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: evidence,
        dimensionTags: ['tenancy_stability'],
        networkVisibility: 'visible_to_current_landlord',
      },
      client,
    )
  }
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'lease_renewed',
      eventData: { lease_id: args.leaseId, renewed_at: args.renewedAt.toISOString() },
      occurredAt: args.renewedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: evidence,
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit lease_anniversary events on a tenant subject. Fired by an annual
 * detector cron — once per (lease_id, anniversary_year). Caller ensures
 * idempotency by checking the chain for an existing event with matching
 * event_data.anniversary_year.
 */
export async function emitLeaseAnniversaryEvent(
  client: PoolClient,
  args: {
    tenantId: string
    leaseId: string
    anniversaryYear: number
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'lease_anniversary',
      eventData: {
        lease_id: args.leaseId,
        anniversary_year: args.anniversaryYear,
      },
      occurredAt: args.occurredAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { lease_id: args.leaseId },
      dimensionTags: ['tenancy_stability'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit entry-request events when the tenant grants or denies access.
 * Both pieces are simultaneously visible:
 *   - tenant scores entry_request_granted_within_window when the
 *     decision is granted AND the response landed before the proposed
 *     window started (tenant cooperated in time)
 *   - tenant emits entry_request_denied (no score; denial is a right)
 */
export async function emitEntryRequestResponseEvents(
  client: PoolClient,
  args: {
    tenantId: string
    requestId: string
    decision: 'granted' | 'denied'
    respondedAt: Date
    proposedWindowStart: Date
  },
): Promise<void> {
  if (args.decision === 'granted') {
    const respondedInTime = args.respondedAt.getTime() < args.proposedWindowStart.getTime()
    if (respondedInTime) {
      await appendEvent(
        {
          subjectType: 'tenant',
          subjectRefId: args.tenantId,
          eventType: 'entry_request_granted_within_window',
          eventData: {
            entry_request_id: args.requestId,
            responded_at: args.respondedAt.toISOString(),
          },
          occurredAt: args.respondedAt,
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: { entry_request_id: args.requestId },
          dimensionTags: ['cooperation'],
          networkVisibility: 'visible_to_current_landlord',
        },
        client,
      )
    }
    return
  }
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'entry_request_denied',
      eventData: {
        entry_request_id: args.requestId,
        responded_at: args.respondedAt.toISOString(),
      },
      occurredAt: args.respondedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { entry_request_id: args.requestId },
      dimensionTags: ['cooperation'],
      networkVisibility: 'visible_to_current_landlord',
    },
    client,
  )
}

/**
 * Emit landlord-side entry-record events. Called when the landlord
 * posts the actual entry moment. Logic:
 *   - within proposed window AND request status was 'granted'
 *     → proper_entry_notice_given (+25, full trust)
 *   - outside proposed window OR no grant
 *     → entry_compliance_breach (-10%, network visible)
 */
export async function emitEntryRecordedEvents(
  client: PoolClient,
  args: {
    landlordId: string
    requestId: string
    enteredAt: Date
    proposedWindowStart: Date
    proposedWindowEnd: Date
    grantedDecision: 'granted' | 'denied' | null
  },
): Promise<{ outcome: 'compliant' | 'breach' }> {
  const within =
    args.enteredAt.getTime() >= args.proposedWindowStart.getTime() &&
    args.enteredAt.getTime() <= args.proposedWindowEnd.getTime()
  const compliant = within && args.grantedDecision === 'granted'

  if (compliant) {
    await appendEvent(
      {
        subjectType: 'landlord',
        subjectRefId: args.landlordId,
        eventType: 'proper_entry_notice_given',
        eventData: {
          entry_request_id: args.requestId,
          entered_at: args.enteredAt.toISOString(),
        },
        occurredAt: args.enteredAt,
        attestationSource: 'gam_workflow_auto',
        attestationEvidence: { entry_request_id: args.requestId },
        dimensionTags: ['cooperation'],
        networkVisibility: 'visible_to_current_landlord',
      },
      client,
    )
    return { outcome: 'compliant' }
  }

  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'entry_compliance_breach',
      eventData: {
        entry_request_id: args.requestId,
        entered_at: args.enteredAt.toISOString(),
        within_window: within,
        granted_decision: args.grantedDecision,
      },
      occurredAt: args.enteredAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { entry_request_id: args.requestId },
      dimensionTags: ['cooperation'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
  return { outcome: 'breach' }
}

/**
 * Emit recurring_repair_same_issue against the landlord subject.
 * Caller (the daily detector cron) determines the duplicate set;
 * this just persists the event with the prior+current request ids.
 */
export async function emitRecurringRepairEvent(
  client: PoolClient,
  args: {
    landlordId: string
    priorRequestId: string
    currentRequestId: string
    category: string
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'recurring_repair_same_issue',
      eventData: {
        prior_request_id: args.priorRequestId,
        current_request_id: args.currentRequestId,
        category: args.category,
      },
      occurredAt: args.occurredAt,
      attestationSource: 'system_derived',
      attestationEvidence: {
        prior_request_id: args.priorRequestId,
        current_request_id: args.currentRequestId,
      },
      dimensionTags: ['property_care'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Emit habitability_complaint_unresolved_30d. Idempotency is handled
 * by the caller (the detector cron checks if a previous emission exists
 * for the same request_id before firing).
 */
export async function emitHabitabilityUnresolvedEvent(
  client: PoolClient,
  args: {
    landlordId: string
    requestId: string
    category: string
    daysOpen: number
    detectedAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType: 'habitability_complaint_unresolved_30d',
      eventData: {
        maintenance_request_id: args.requestId,
        category: args.category,
        days_open: args.daysOpen,
      },
      occurredAt: args.detectedAt,
      attestationSource: 'system_derived',
      attestationEvidence: { maintenance_request_id: args.requestId },
      dimensionTags: ['property_care'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Emit multi_landlord_history_clean against the tenant subject. One-time
 * (lifetime) event per tenant — the detector keeps it idempotent.
 */
export async function emitMultiLandlordHistoryCleanEvent(
  client: PoolClient,
  args: {
    tenantId: string
    landlordCount: number
    cleanLeaseCount: number
    occurredAt: Date
  },
): Promise<void> {
  await appendEvent(
    {
      subjectType: 'tenant',
      subjectRefId: args.tenantId,
      eventType: 'multi_landlord_history_clean',
      eventData: {
        distinct_landlord_count: args.landlordCount,
        clean_lease_count: args.cleanLeaseCount,
      },
      occurredAt: args.occurredAt,
      attestationSource: 'system_derived',
      attestationEvidence: {
        distinct_landlord_count: args.landlordCount,
        clean_lease_count: args.cleanLeaseCount,
      },
      dimensionTags: ['tenancy_stability', 'community_fit'],
      networkVisibility: 'visible_to_gam_network',
    },
    client,
  )
}

/**
 * Classify maintenance resolution speed into a tier. Default SLA
 * window is 7 days end-to-end; future per-landlord SLA configuration
 * can be threaded through the slaHours arg.
 */
export function classifyMaintenanceTier(args: {
  createdAt: Date
  resolvedAt: Date
  slaHours?: number
}): 'within_24h' | 'within_72h' | 'within_sla' | 'breach_sla' {
  const sla = args.slaHours ?? 24 * 7
  const elapsedHours =
    (args.resolvedAt.getTime() - args.createdAt.getTime()) / 3_600_000
  if (elapsedHours <= 24) return 'within_24h'
  if (elapsedHours <= 72) return 'within_72h'
  if (elapsedHours <= sla) return 'within_sla'
  return 'breach_sla'
}

/**
 * Emit maintenance events at status transition. Submission and
 * acknowledgment are NOT emitted (informational only per the locked
 * "score outcomes, not unilateral actions" rule).
 *
 * Resolution emits:
 *   - landlord-side: maintenance_response_within_sla / 24h / 72h /
 *     breach_sla based on time-to-first-response (caller passes
 *     the tier classification — this service stays free of the
 *     SLA-config lookup).
 *   - tenant-side resolution_confirmed fires LATER, when the tenant
 *     confirms the fix held (separate flow).
 */
export async function emitMaintenanceResolvedEvents(
  client: PoolClient,
  args: {
    landlordId: string
    requestId: string
    resolvedAt: Date
    responseTier: 'within_24h' | 'within_72h' | 'within_sla' | 'breach_sla'
  },
): Promise<void> {
  const tierMap: Record<typeof args.responseTier, CreditEventType> = {
    within_24h: 'maintenance_response_24h',
    within_72h: 'maintenance_response_72h',
    within_sla: 'maintenance_response_within_sla',
    breach_sla: 'maintenance_response_breach_sla',
  }
  const eventType = tierMap[args.responseTier]
  const visibility =
    args.responseTier === 'breach_sla'
      ? 'visible_to_gam_network'
      : 'visible_to_current_landlord'

  await appendEvent(
    {
      subjectType: 'landlord',
      subjectRefId: args.landlordId,
      eventType,
      eventData: {
        maintenance_request_id: args.requestId,
        resolved_at: args.resolvedAt.toISOString(),
        response_tier: args.responseTier,
      },
      occurredAt: args.resolvedAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { maintenance_request_id: args.requestId },
      dimensionTags: ['cooperation', 'property_care'],
      networkVisibility: visibility,
    },
    client,
  )
}
