/**
 * S447 services-audit slice 23 (multi-session arc 1/2-3) —
 * creditLedgerEmitters.ts WORKFLOW emitters.
 *
 * The file holds 21 emitters total. This first slice covers the
 * 12 that fire from workflow triggers (payments, lease, inspection,
 * entry-request, maintenance) — small, deterministic wrappers
 * around appendEvent. Caller-detector emitters (system_derived
 * attestation: tenancy_ended_with_balance, balance_paid_post_move,
 * lease_anniversary, recurring_repair, habitability_unresolved_30d,
 * multi_landlord_history_clean) defer to S448 along with their
 * cron-detector context.
 *
 * Strategy: appendEvent runs LIVE against the real chain — no
 * mocks. For each emitter, we pin event_type, dimension_tags,
 * network_visibility, attestation_source, attestation_evidence
 * presence, and the structurally-important event_data fields.
 *
 * Coverage:
 *   - classifyPaymentTier (pure tier-classifier)
 *   - emitPaymentSettledEvent — 5 tier branches + visibility split
 *   - emitPaymentFailedEvent  — single event shape
 *   - emitLeaseSignedTenant  / emitLeaseSignedLandlord — per-tenant
 *     fanout, single landlord event, shared dimension tags
 *   - emitInspectionFinalizedEvents — move-in (3 sub-events) /
 *     move-out (3 sub-events) / periodic early return
 *   - emitLeaseTerminatedNaturalEvents — per-tenant fanout +
 *     landlord (visibility differs across subjects)
 *   - emitLeaseRenewedEvents — per-tenant + landlord
 *   - emitEntryRequestResponseEvents — granted-in-time / granted-late
 *     (no event) / denied
 *   - emitEntryRecordedEvents — compliant (within window + granted) /
 *     breach (outside window OR not granted)
 *   - classifyMaintenanceTier (pure)
 *   - emitMaintenanceResolvedEvents — 4 response-tier branches
 *     with visibility flip on breach
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  classifyPaymentTier,
  classifyMaintenanceTier,
  emitPaymentSettledEvent,
  emitPaymentFailedEvent,
  emitLeaseSignedTenant,
  emitLeaseSignedLandlord,
  emitInspectionFinalizedEvents,
  emitLeaseTerminatedNaturalEvents,
  emitLeaseRenewedEvents,
  emitEntryRequestResponseEvents,
  emitEntryRecordedEvents,
  emitMaintenanceResolvedEvents,
  emitTenancyEndedWithBalanceEvent,
  emitBalancePaidPostMoveEvent,
  emitLeaseAnniversaryEvent,
  emitRecurringRepairEvent,
  emitHabitabilityUnresolvedEvent,
  emitMultiLandlordHistoryCleanEvent,
} from './creditLedgerEmitters'
import { cleanupAllSchema } from '../test/dbHelpers'

beforeEach(async () => {
  await cleanupAllSchema()
})

/**
 * Run a function inside a transaction, passing the PoolClient through.
 * Emitters require a PoolClient (the workflow's transaction); in tests
 * we own the BEGIN/COMMIT and just hand the client through.
 */
async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

/** Read the (single) event for a given subject. Asserts uniqueness. */
async function readSoleEvent(
  subjectType: 'tenant' | 'landlord',
  subjectRefId: string,
): Promise<any> {
  const { rows } = await db.query<any>(
    `SELECT e.*
       FROM credit_events e
       JOIN credit_subjects s ON s.id = e.subject_id
      WHERE s.subject_type = $1 AND s.subject_ref_id = $2`,
    [subjectType, subjectRefId])
  expect(rows).toHaveLength(1)
  return rows[0]
}

/** Read all events for a subject, ordered by recorded_at then id. */
async function readAllEvents(
  subjectType: 'tenant' | 'landlord',
  subjectRefId: string,
): Promise<any[]> {
  const { rows } = await db.query<any>(
    `SELECT e.*
       FROM credit_events e
       JOIN credit_subjects s ON s.id = e.subject_id
      WHERE s.subject_type = $1 AND s.subject_ref_id = $2
      ORDER BY e.recorded_at ASC, e.id ASC`,
    [subjectType, subjectRefId])
  return rows
}

// ─── classifyPaymentTier (pure) ────────────────────────────────

describe('classifyPaymentTier', () => {
  const due = new Date('2026-06-01T00:00:00Z')
  it('settled before due-EOD → on_time', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-01T20:00:00Z'),
      graceDays: 5,
    })).toBe('payment_received_on_time')
  })
  it('settled after due-EOD but within grace → late_grace', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-04T12:00:00Z'),
      graceDays: 5,
    })).toBe('payment_received_late_grace')
  })
  it('≤72h past grace-end → late_minor', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-08T00:00:00Z'),  // 0.000... h past grace-end
      graceDays: 5,
    })).toBe('payment_received_late_minor')
  })
  it('72h–15d past grace-end → late_major', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-12T00:00:00Z'),  // ~4d past grace-end
      graceDays: 5,
    })).toBe('payment_received_late_major')
  })
  it('>15d past grace-end → late_severe', () => {
    expect(classifyPaymentTier({
      dueDate: due,
      settledAt: new Date('2026-06-25T00:00:00Z'),  // ~17d past grace-end
      graceDays: 5,
    })).toBe('payment_received_late_severe')
  })
})

// ─── emitPaymentSettledEvent ───────────────────────────────────

describe('emitPaymentSettledEvent', () => {
  const tenantId = randomUUID()
  const paymentId = randomUUID()
  const due = new Date('2026-06-01T00:00:00Z')

  it('on_time → visible_to_current_landlord (positive)', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: '1000.00',
      dueDate: due,
      settledAt: new Date('2026-06-01T18:00:00Z'),
      graceDays: 5,
      stripePaymentIntentId: 'pi_test_on_time',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_on_time')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.dimension_tags).toEqual(['payment_reliability'])
    expect(e.attestation_source).toBe('stripe_attested')
    expect(e.attestation_evidence).toEqual({ stripe_payment_intent_id: 'pi_test_on_time' })
    expect(e.event_data.payment_id).toBe(paymentId)
    expect(e.event_data.amount).toBe('1000.00')
    expect(e.event_data.grace_days).toBe(5)
  })

  it('late_grace → still visible_to_current_landlord (within grace = positive)', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: 950,
      dueDate: due,
      settledAt: new Date('2026-06-04T12:00:00Z'),
      graceDays: 5,
      stripePaymentIntentId: 'pi_late_grace',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_late_grace')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.event_data.amount).toBe('950')         // number → String(950)
  })

  it('late_minor → visible_to_gam_network (adverse)', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: '1000',
      dueDate: due,
      settledAt: new Date('2026-06-08T00:00:00Z'),
      graceDays: 5,
      stripePaymentIntentId: 'pi_late_minor',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_late_minor')
    expect(e.network_visibility).toBe('visible_to_gam_network')
  })

  it('null stripePaymentIntentId → attestation_evidence is empty object', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'utility',
      amount: '85.50',
      dueDate: due,
      settledAt: new Date('2026-06-01T08:00:00Z'),
      graceDays: 5,
      stripePaymentIntentId: null,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.attestation_evidence).toEqual({})
    expect(e.event_data.payment_type).toBe('utility')
  })

  it('graceDays NULL → defaults to 5 in event_data', async () => {
    await withTx(c => emitPaymentSettledEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: '1000',
      dueDate: due,
      settledAt: new Date('2026-06-04T12:00:00Z'),
      graceDays: null,
      stripePaymentIntentId: 'pi_default_grace',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_received_late_grace') // grace=5 used
    expect(e.event_data.grace_days).toBe(5)
  })
})

// ─── emitPaymentFailedEvent ────────────────────────────────────

describe('emitPaymentFailedEvent', () => {
  it('records payment_failed_nsf with full evidence + visibility', async () => {
    const tenantId = randomUUID()
    const paymentId = randomUUID()
    const due = new Date('2026-06-01T00:00:00Z')
    const failedAt = new Date('2026-06-03T15:30:00Z')

    await withTx(c => emitPaymentFailedEvent(c, {
      tenantId, paymentId, paymentType: 'rent',
      amount: '1200.50',
      dueDate: due,
      failedAt,
      stripePaymentIntentId: 'pi_failed_1',
      failureCode: 'R01',
      failureMessage: 'Insufficient funds',
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('payment_failed_nsf')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags).toEqual(['payment_reliability'])
    expect(e.attestation_source).toBe('stripe_attested')
    expect(e.attestation_evidence).toEqual({ stripe_payment_intent_id: 'pi_failed_1' })
    expect(e.event_data.failure_code).toBe('R01')
    expect(e.event_data.failure_message).toBe('Insufficient funds')
    expect(new Date(e.event_data.failed_at).getTime()).toBe(failedAt.getTime())
  })

  it('null stripe id → empty evidence object (still records event)', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitPaymentFailedEvent(c, {
      tenantId, paymentId: randomUUID(), paymentType: 'rent',
      amount: 800,
      dueDate: new Date('2026-06-01T00:00:00Z'),
      failedAt: new Date('2026-06-04T00:00:00Z'),
      stripePaymentIntentId: null,
      failureCode: null,
      failureMessage: null,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.attestation_evidence).toEqual({})
    expect(e.event_data.amount).toBe('800')
  })
})

// ─── emitLeaseSignedTenant / Landlord ──────────────────────────

describe('emitLeaseSigned (tenant + landlord)', () => {
  it('tenant signing → lease_signed on tenant subject, tenancy_stability tag, current-landlord visibility', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    const documentId = randomUUID()
    const signedAt = new Date('2026-05-15T10:00:00Z')

    await withTx(c => emitLeaseSignedTenant(c, { tenantId, leaseId, documentId, signedAt }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('lease_signed')
    expect(e.dimension_tags).toEqual(['tenancy_stability'])
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.attestation_source).toBe('gam_workflow_auto')
    expect(e.attestation_evidence).toEqual({ lease_document_id: documentId })
    expect(e.event_data.lease_id).toBe(leaseId)
  })

  it('landlord signing → single landlord event with tenant_count in event_data', async () => {
    const landlordId = randomUUID()
    const leaseId = randomUUID()
    const documentId = randomUUID()
    await withTx(c => emitLeaseSignedLandlord(c, {
      landlordId, leaseId, documentId,
      signedAt: new Date('2026-05-15T10:05:00Z'),
      tenantCount: 2,
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('lease_signed')
    expect(e.event_data.tenant_count).toBe(2)
    expect(e.event_data.lease_id).toBe(leaseId)
  })

  it('multi-tenant lease → each tenant emits separately; both events visible per-subject', async () => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()
    const leaseId = randomUUID()
    const documentId = randomUUID()
    const signedAt = new Date('2026-05-15T10:00:00Z')

    await withTx(async c => {
      await emitLeaseSignedTenant(c, { tenantId: tenantA, leaseId, documentId, signedAt })
      await emitLeaseSignedTenant(c, { tenantId: tenantB, leaseId, documentId, signedAt })
    })
    expect((await readAllEvents('tenant', tenantA))).toHaveLength(1)
    expect((await readAllEvents('tenant', tenantB))).toHaveLength(1)
  })
})

// ─── emitInspectionFinalizedEvents ─────────────────────────────

describe('emitInspectionFinalizedEvents', () => {
  it('periodic inspection → no-op, no events', async () => {
    const tenantId = randomUUID()
    const landlordId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'periodic',
      tenantId, landlordId,
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-06-01T12:00:00Z'),
      photoCount: 5,
    }))
    expect(await readAllEvents('tenant', tenantId)).toHaveLength(0)
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(0)
  })

  it('move-in within ±1d of lease start + photos → 3 events (tenant inspection + photos + landlord unit-ready)', async () => {
    const tenantId = randomUUID()
    const landlordId = randomUUID()
    const inspectionId = randomUUID()
    const leaseStart = new Date('2026-06-01T00:00:00Z')
    const finalizedAt = new Date('2026-06-01T15:00:00Z') // within ±1d

    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_in',
      tenantId, landlordId,
      inspectionId,
      finalizedAt,
      photoCount: 8,
      leaseStartDate: leaseStart,
    }))

    const tenantEvts = await readAllEvents('tenant', tenantId)
    expect(tenantEvts.map(e => e.event_type).sort())
      .toEqual(['move_in_inspection_completed', 'move_in_photos_submitted'])
    for (const e of tenantEvts) {
      expect(e.attestation_source).toBe('gam_workflow_auto')
      expect(e.attestation_evidence).toEqual({ inspection_id: inspectionId })
    }
    const completed = tenantEvts.find(e => e.event_type === 'move_in_inspection_completed')!
    expect(completed.dimension_tags.sort()).toEqual(['property_care', 'tenancy_stability'])
    const photos = tenantEvts.find(e => e.event_type === 'move_in_photos_submitted')!
    expect(photos.event_data.photo_count).toBe(8)

    const llEvts = await readAllEvents('landlord', landlordId)
    expect(llEvts).toHaveLength(1)
    expect(llEvts[0].event_type).toBe('unit_ready_on_move_in_date')
    expect(llEvts[0].dimension_tags.sort()).toEqual(['cooperation', 'property_care'])
  })

  it('move-in OUTSIDE ±1d window → tenant event only, NO landlord unit-ready', async () => {
    const tenantId = randomUUID()
    const landlordId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_in',
      tenantId, landlordId,
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-06-04T00:00:00Z'),  // 3 days after start
      photoCount: 0,
      leaseStartDate: new Date('2026-06-01T00:00:00Z'),
    }))
    expect(await readAllEvents('tenant', tenantId)).toHaveLength(1)  // inspection_completed only (no photos)
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(0)
  })

  it('move-in with leaseStartDate=null → no landlord unit-ready event', async () => {
    const tenantId = randomUUID()
    const landlordId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_in',
      tenantId, landlordId,
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-06-01T12:00:00Z'),
      photoCount: 0,
      leaseStartDate: null,
    }))
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(0)
  })

  it('move-out matches move-in → matches event (positive, current-landlord visibility)', async () => {
    const tenantId = randomUUID()
    const inspectionId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_out',
      tenantId, landlordId: randomUUID(),
      inspectionId,
      finalizedAt: new Date('2026-09-01T15:00:00Z'),
      photoCount: 3,
      matchesMoveIn: true,
    }))
    const evts = await readAllEvents('tenant', tenantId)
    const types = evts.map(e => e.event_type).sort()
    expect(types).toEqual([
      'move_out_condition_matches_move_in',
      'move_out_inspection_completed',
      'move_out_photos_submitted',
    ])
    const matches = evts.find(e => e.event_type === 'move_out_condition_matches_move_in')!
    expect(matches.network_visibility).toBe('visible_to_current_landlord')
  })

  it('move-out damage documented → adverse event with gam_network visibility', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_out',
      tenantId, landlordId: randomUUID(),
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-09-01T15:00:00Z'),
      photoCount: 0,
      matchesMoveIn: false,
      damageDocumented: true,
    }))
    const evts = await readAllEvents('tenant', tenantId)
    const damage = evts.find(e => e.event_type === 'move_out_condition_damage_documented')!
    expect(damage).toBeDefined()
    expect(damage.network_visibility).toBe('visible_to_gam_network')
  })

  it('move-out without tenantId → no events (early return guard)', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitInspectionFinalizedEvents(c, {
      inspectionType: 'move_out',
      tenantId: null, landlordId,
      inspectionId: randomUUID(),
      finalizedAt: new Date('2026-09-01T15:00:00Z'),
      photoCount: 5,
      matchesMoveIn: true,
    }))
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(0)
  })
})

// ─── emitLeaseTerminatedNaturalEvents ──────────────────────────

describe('emitLeaseTerminatedNaturalEvents', () => {
  it('per-tenant fanout + single landlord event; tenant visibility=gam_network, landlord=current', async () => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()
    const landlordId = randomUUID()
    const leaseId = randomUUID()
    const terminatedAt = new Date('2026-08-31T23:59:00Z')

    await withTx(c => emitLeaseTerminatedNaturalEvents(c, {
      leaseId, landlordId, tenantIds: [tenantA, tenantB], terminatedAt,
    }))

    const eA = await readSoleEvent('tenant', tenantA)
    const eB = await readSoleEvent('tenant', tenantB)
    expect(eA.event_type).toBe('lease_terminated_natural')
    expect(eA.network_visibility).toBe('visible_to_gam_network')
    expect(eA.attestation_source).toBe('gam_workflow_auto')
    expect(eA.dimension_tags).toEqual(['tenancy_stability'])
    expect(eB.network_visibility).toBe('visible_to_gam_network')

    const ll = await readSoleEvent('landlord', landlordId)
    expect(ll.event_type).toBe('lease_terminated_natural')
    expect(ll.network_visibility).toBe('visible_to_current_landlord')
  })

  it('empty tenantIds → only landlord event written', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitLeaseTerminatedNaturalEvents(c, {
      leaseId: randomUUID(), landlordId, tenantIds: [],
      terminatedAt: new Date('2026-08-31T00:00:00Z'),
    }))
    const { rows } = await db.query<any>(`SELECT COUNT(*)::int AS n FROM credit_events`)
    expect(rows[0].n).toBe(1)
    expect(await readAllEvents('landlord', landlordId)).toHaveLength(1)
  })
})

// ─── emitLeaseRenewedEvents ────────────────────────────────────

describe('emitLeaseRenewedEvents', () => {
  it('per-tenant + landlord; ALL events have current-landlord visibility (renewal is positive)', async () => {
    const tenantA = randomUUID()
    const landlordId = randomUUID()
    const leaseId = randomUUID()
    await withTx(c => emitLeaseRenewedEvents(c, {
      leaseId, landlordId, tenantIds: [tenantA],
      renewedAt: new Date('2026-09-01T00:00:00Z'),
    }))
    const t = await readSoleEvent('tenant', tenantA)
    expect(t.event_type).toBe('lease_renewed')
    expect(t.network_visibility).toBe('visible_to_current_landlord')
    expect(t.dimension_tags).toEqual(['tenancy_stability'])
    const ll = await readSoleEvent('landlord', landlordId)
    expect(ll.event_type).toBe('lease_renewed')
    expect(ll.network_visibility).toBe('visible_to_current_landlord')
  })
})

// ─── emitEntryRequestResponseEvents ────────────────────────────

describe('emitEntryRequestResponseEvents', () => {
  const proposedWindowStart = new Date('2026-06-10T14:00:00Z')

  it('granted IN TIME (responded before window start) → entry_request_granted_within_window', async () => {
    const tenantId = randomUUID()
    const requestId = randomUUID()
    await withTx(c => emitEntryRequestResponseEvents(c, {
      tenantId, requestId,
      decision: 'granted',
      respondedAt: new Date('2026-06-09T20:00:00Z'),  // before window
      proposedWindowStart,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('entry_request_granted_within_window')
    expect(e.dimension_tags).toEqual(['cooperation'])
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.attestation_evidence).toEqual({ entry_request_id: requestId })
  })

  it('granted LATE (responded after window start) → NO event written', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitEntryRequestResponseEvents(c, {
      tenantId, requestId: randomUUID(),
      decision: 'granted',
      respondedAt: new Date('2026-06-10T14:30:00Z'),  // 30min into window
      proposedWindowStart,
    }))
    expect(await readAllEvents('tenant', tenantId)).toHaveLength(0)
  })

  it('denied → entry_request_denied (denial is a right, no score impact but logged)', async () => {
    const tenantId = randomUUID()
    const requestId = randomUUID()
    await withTx(c => emitEntryRequestResponseEvents(c, {
      tenantId, requestId,
      decision: 'denied',
      respondedAt: new Date('2026-06-09T20:00:00Z'),
      proposedWindowStart,
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('entry_request_denied')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
  })
})

// ─── emitEntryRecordedEvents ───────────────────────────────────

describe('emitEntryRecordedEvents', () => {
  const windowStart = new Date('2026-06-10T14:00:00Z')
  const windowEnd   = new Date('2026-06-10T16:00:00Z')

  it('compliant: within window AND granted → proper_entry_notice_given, returns compliant', async () => {
    const landlordId = randomUUID()
    const requestId = randomUUID()
    const result = await withTx(c => emitEntryRecordedEvents(c, {
      landlordId, requestId,
      enteredAt: new Date('2026-06-10T15:00:00Z'),
      proposedWindowStart: windowStart,
      proposedWindowEnd:   windowEnd,
      grantedDecision: 'granted',
    }))
    expect(result.outcome).toBe('compliant')
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('proper_entry_notice_given')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
  })

  it('breach: outside window → entry_compliance_breach, gam_network visibility', async () => {
    const landlordId = randomUUID()
    const result = await withTx(c => emitEntryRecordedEvents(c, {
      landlordId, requestId: randomUUID(),
      enteredAt: new Date('2026-06-10T18:00:00Z'),    // 2h past window
      proposedWindowStart: windowStart,
      proposedWindowEnd:   windowEnd,
      grantedDecision: 'granted',
    }))
    expect(result.outcome).toBe('breach')
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('entry_compliance_breach')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.event_data.within_window).toBe(false)
    expect(e.event_data.granted_decision).toBe('granted')
  })

  it('breach: within window but NOT granted (or null) → still breach', async () => {
    const landlordId = randomUUID()
    const result = await withTx(c => emitEntryRecordedEvents(c, {
      landlordId, requestId: randomUUID(),
      enteredAt: new Date('2026-06-10T15:00:00Z'),
      proposedWindowStart: windowStart,
      proposedWindowEnd:   windowEnd,
      grantedDecision: null,
    }))
    expect(result.outcome).toBe('breach')
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('entry_compliance_breach')
    expect(e.event_data.within_window).toBe(true)
    expect(e.event_data.granted_decision).toBeNull()
  })
})

// ─── classifyMaintenanceTier (pure) ────────────────────────────

describe('classifyMaintenanceTier', () => {
  const created = new Date('2026-06-01T12:00:00Z')

  it('≤24h → within_24h', () => {
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-02T11:00:00Z'),
    })).toBe('within_24h')
  })
  it('24h<x≤72h → within_72h', () => {
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-04T00:00:00Z'),
    })).toBe('within_72h')
  })
  it('72h<x≤SLA (default 7d) → within_sla', () => {
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-07T12:00:00Z'),
    })).toBe('within_sla')
  })
  it('past SLA → breach_sla', () => {
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-12T12:00:00Z'),
    })).toBe('breach_sla')
  })
  it('custom slaHours respected — 96h elapsed with 80h SLA → breach', () => {
    // The 24h / 72h tier checks short-circuit before slaHours is used,
    // so the custom SLA only changes the within_sla vs breach_sla cutoff.
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-05T12:00:00Z'),    // +96h
      slaHours: 80,                                      // custom shorter SLA
    })).toBe('breach_sla')
    // Same elapsed under DEFAULT SLA (7d=168h) → within_sla.
    expect(classifyMaintenanceTier({
      createdAt: created,
      resolvedAt: new Date('2026-06-05T12:00:00Z'),
    })).toBe('within_sla')
  })
})

// ─── emitMaintenanceResolvedEvents ─────────────────────────────

describe('emitMaintenanceResolvedEvents', () => {
  const requestId = randomUUID()
  const resolvedAt = new Date('2026-06-05T12:00:00Z')

  it('within_24h → maintenance_response_24h, current-landlord visibility', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitMaintenanceResolvedEvents(c, {
      landlordId, requestId, resolvedAt, responseTier: 'within_24h',
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('maintenance_response_24h')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.dimension_tags.sort()).toEqual(['cooperation', 'property_care'])
  })

  it('within_72h → maintenance_response_72h', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitMaintenanceResolvedEvents(c, {
      landlordId, requestId, resolvedAt, responseTier: 'within_72h',
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('maintenance_response_72h')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
  })

  it('within_sla → maintenance_response_within_sla', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitMaintenanceResolvedEvents(c, {
      landlordId, requestId, resolvedAt, responseTier: 'within_sla',
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('maintenance_response_within_sla')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
  })

  it('breach_sla → maintenance_response_breach_sla + visibility flips to gam_network', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitMaintenanceResolvedEvents(c, {
      landlordId, requestId, resolvedAt, responseTier: 'breach_sla',
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('maintenance_response_breach_sla')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.event_data.response_tier).toBe('breach_sla')
  })
})

// ═══════════════════════════════════════════════════════════════
//  S448 ─ DETECTOR EMITTERS (attestation_source='system_derived')
// ═══════════════════════════════════════════════════════════════
//
// These emitters fire from background cron detectors rather than
// inline workflow triggers. Idempotency is owned by the detector
// itself (each detector queries the chain for a prior emission
// before firing); the emitters just persist what they're handed.
// So coverage focuses on the contract — event_type,
// dimension_tags, network_visibility, attestation persistence —
// not idempotency, which lives in the caller's seam.

// ─── emitTenancyEndedWithBalanceEvent ──────────────────────────

describe('emitTenancyEndedWithBalanceEvent', () => {
  it('records tenancy_ended_with_balance with full reconciliation payload', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    const occurredAt = new Date('2026-09-15T12:00:00Z')

    await withTx(c => emitTenancyEndedWithBalanceEvent(c, {
      tenantId, leaseId,
      expectedTotal: 12000,
      receivedTotal: 11250,
      delta: 750,
      occurredAt,
    }))

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('tenancy_ended_with_balance')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags.sort()).toEqual(['payment_reliability', 'tenancy_stability'])
    expect(e.attestation_source).toBe('system_derived')
    expect(e.attestation_evidence).toEqual({ lease_id: leaseId })
    expect(e.event_data.lease_id).toBe(leaseId)
    expect(e.event_data.expected_total).toBe(12000)
    expect(e.event_data.received_total).toBe(11250)
    expect(e.event_data.delta).toBe(750)
    expect(e.event_data.settlement_status).toBe('unpaid')
    expect(new Date(e.occurred_at).getTime()).toBe(occurredAt.getTime())
  })

  it('zero delta still records the event (caller decides when to fire)', async () => {
    // Detector-owned idempotency: if the caller decides to fire with
    // delta=0 (edge case where rounding lands exactly on zero), the
    // emitter doesn't second-guess. It persists what it's handed.
    const tenantId = randomUUID()
    await withTx(c => emitTenancyEndedWithBalanceEvent(c, {
      tenantId, leaseId: randomUUID(),
      expectedTotal: 0, receivedTotal: 0, delta: 0,
      occurredAt: new Date('2026-09-15T12:00:00Z'),
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_data.delta).toBe(0)
    expect(e.event_data.settlement_status).toBe('unpaid')
  })
})

// ─── emitBalancePaidPostMoveEvent ──────────────────────────────

describe('emitBalancePaidPostMoveEvent', () => {
  it('records balance_paid_post_move with current-landlord visibility (positive recovery)', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    const occurredAt = new Date('2026-11-10T15:00:00Z')

    await withTx(c => emitBalancePaidPostMoveEvent(c, {
      tenantId, leaseId, occurredAt,
    }))

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('balance_paid_post_move')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.dimension_tags).toEqual(['payment_reliability'])
    expect(e.attestation_source).toBe('system_derived')
    expect(e.attestation_evidence).toEqual({ lease_id: leaseId })
    expect(e.event_data.lease_id).toBe(leaseId)
  })

  it('multiple post-move payoffs across leases → distinct events per lease (caller-owned idempotency)', async () => {
    const tenantId = randomUUID()
    const leaseA = randomUUID()
    const leaseB = randomUUID()
    await withTx(async c => {
      await emitBalancePaidPostMoveEvent(c, {
        tenantId, leaseId: leaseA,
        occurredAt: new Date('2026-11-10T15:00:00Z'),
      })
      await emitBalancePaidPostMoveEvent(c, {
        tenantId, leaseId: leaseB,
        occurredAt: new Date('2027-02-01T15:00:00Z'),
      })
    })
    const evts = await readAllEvents('tenant', tenantId)
    expect(evts).toHaveLength(2)
    expect(evts.map(e => e.event_data.lease_id).sort()).toEqual([leaseA, leaseB].sort())
  })
})

// ─── emitLeaseAnniversaryEvent ─────────────────────────────────

describe('emitLeaseAnniversaryEvent', () => {
  it('records lease_anniversary with anniversary_year payload + current-landlord visibility', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    const occurredAt = new Date('2027-06-01T00:00:00Z')

    await withTx(c => emitLeaseAnniversaryEvent(c, {
      tenantId, leaseId,
      anniversaryYear: 1,
      occurredAt,
    }))

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('lease_anniversary')
    expect(e.network_visibility).toBe('visible_to_current_landlord')
    expect(e.dimension_tags).toEqual(['tenancy_stability'])
    expect(e.attestation_source).toBe('gam_workflow_auto')  // distinct from system_derived (S448 batch — note exception)
    expect(e.attestation_evidence).toEqual({ lease_id: leaseId })
    expect(e.event_data.lease_id).toBe(leaseId)
    expect(e.event_data.anniversary_year).toBe(1)
  })

  it('multi-year anniversaries: same tenant + lease, different years → separate events', async () => {
    const tenantId = randomUUID()
    const leaseId = randomUUID()
    await withTx(async c => {
      await emitLeaseAnniversaryEvent(c, {
        tenantId, leaseId, anniversaryYear: 1,
        occurredAt: new Date('2027-06-01T00:00:00Z'),
      })
      await emitLeaseAnniversaryEvent(c, {
        tenantId, leaseId, anniversaryYear: 2,
        occurredAt: new Date('2028-06-01T00:00:00Z'),
      })
    })
    const evts = await readAllEvents('tenant', tenantId)
    expect(evts).toHaveLength(2)
    expect(evts.map(e => e.event_data.anniversary_year).sort()).toEqual([1, 2])
  })
})

// ─── emitRecurringRepairEvent ──────────────────────────────────

describe('emitRecurringRepairEvent', () => {
  it('records recurring_repair_same_issue with both request ids in evidence + gam_network visibility', async () => {
    const landlordId = randomUUID()
    const priorRequestId = randomUUID()
    const currentRequestId = randomUUID()
    const occurredAt = new Date('2026-07-20T12:00:00Z')

    await withTx(c => emitRecurringRepairEvent(c, {
      landlordId, priorRequestId, currentRequestId,
      category: 'plumbing_leak',
      occurredAt,
    }))

    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('recurring_repair_same_issue')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags).toEqual(['property_care'])
    expect(e.attestation_source).toBe('system_derived')
    // Evidence carries BOTH request ids so a future audit can replay
    // the duplicate detection (the prior + current pair is what made
    // this a "same issue" rather than a fresh report).
    expect(e.attestation_evidence).toEqual({
      prior_request_id: priorRequestId,
      current_request_id: currentRequestId,
    })
    expect(e.event_data.prior_request_id).toBe(priorRequestId)
    expect(e.event_data.current_request_id).toBe(currentRequestId)
    expect(e.event_data.category).toBe('plumbing_leak')
  })
})

// ─── emitHabitabilityUnresolvedEvent ───────────────────────────

describe('emitHabitabilityUnresolvedEvent', () => {
  it('records habitability_complaint_unresolved_30d with days_open + category', async () => {
    const landlordId = randomUUID()
    const requestId = randomUUID()
    const detectedAt = new Date('2026-08-01T00:00:00Z')

    await withTx(c => emitHabitabilityUnresolvedEvent(c, {
      landlordId, requestId,
      category: 'no_heat',
      daysOpen: 31,
      detectedAt,
    }))

    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_type).toBe('habitability_complaint_unresolved_30d')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags).toEqual(['property_care'])
    expect(e.attestation_source).toBe('system_derived')
    expect(e.attestation_evidence).toEqual({ maintenance_request_id: requestId })
    expect(e.event_data.maintenance_request_id).toBe(requestId)
    expect(e.event_data.category).toBe('no_heat')
    expect(e.event_data.days_open).toBe(31)
    expect(new Date(e.occurred_at).getTime()).toBe(detectedAt.getTime())
  })

  it('higher days_open value passes through unchanged (detector decides when to fire)', async () => {
    const landlordId = randomUUID()
    await withTx(c => emitHabitabilityUnresolvedEvent(c, {
      landlordId, requestId: randomUUID(),
      category: 'no_water', daysOpen: 90,
      detectedAt: new Date('2026-08-01T00:00:00Z'),
    }))
    const e = await readSoleEvent('landlord', landlordId)
    expect(e.event_data.days_open).toBe(90)
  })
})

// ─── emitMultiLandlordHistoryCleanEvent ────────────────────────

describe('emitMultiLandlordHistoryCleanEvent', () => {
  it('records multi_landlord_history_clean with full counts on tenant subject', async () => {
    const tenantId = randomUUID()
    const occurredAt = new Date('2027-01-15T12:00:00Z')

    await withTx(c => emitMultiLandlordHistoryCleanEvent(c, {
      tenantId,
      landlordCount: 3,
      cleanLeaseCount: 4,
      occurredAt,
    }))

    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_type).toBe('multi_landlord_history_clean')
    expect(e.network_visibility).toBe('visible_to_gam_network')
    expect(e.dimension_tags.sort()).toEqual(['community_fit', 'tenancy_stability'])
    expect(e.attestation_source).toBe('system_derived')
    expect(e.attestation_evidence).toEqual({
      distinct_landlord_count: 3,
      clean_lease_count: 4,
    })
    expect(e.event_data.distinct_landlord_count).toBe(3)
    expect(e.event_data.clean_lease_count).toBe(4)
  })

  it('different (landlordCount, cleanLeaseCount) values pass through', async () => {
    const tenantId = randomUUID()
    await withTx(c => emitMultiLandlordHistoryCleanEvent(c, {
      tenantId, landlordCount: 5, cleanLeaseCount: 7,
      occurredAt: new Date('2027-01-15T12:00:00Z'),
    }))
    const e = await readSoleEvent('tenant', tenantId)
    expect(e.event_data.distinct_landlord_count).toBe(5)
    expect(e.event_data.clean_lease_count).toBe(7)
  })
})
