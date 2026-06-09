/**
 * Credit dispute lifecycle tests.
 *
 * Covers openDispute → submitDisputeEvidence → resolveDispute for the
 * three outcomes (upheld, no_change, corrected). The corrected path
 * is the S325 regression target — the admin frontend had been sending
 * mixed-casing keys (correctedEvent + supersedeReason at top-level,
 * subject_type/event_type nested) against a backend schema that
 * required fully snake_case. S321/S325 migrated the wire format to
 * fully camelCase end-to-end and S325 caught the latent bug.
 *
 * Tests don't exercise the route layer — they call the service
 * functions directly with the canonical camelCase shape. The
 * corrected-event test specifically asserts that:
 *   1. resolveDispute(outcome='corrected', correctedEvent={...})
 *      appends a new event on the disputing subject's chain
 *   2. The original disputed event gets superseded_by set
 *   3. The dispute row flips to status='resolved_corrected'
 *   4. The resolution_event_id is captured
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  openDispute,
  submitDisputeEvidence,
  resolveDispute,
} from './creditDispute'
import { appendEvent } from './creditLedger'
import { cleanupAllSchema, seedTenant } from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

// Seed a tenant + an initial payment-late event on their credit chain
// + the credit_subjects row. Returns the IDs needed for dispute setup.
async function seedTenantWithLateEvent(): Promise<{
  tenantId:        string
  subjectId:       string
  initialEventId:  string
}> {
  const client = await db.connect()
  let tenantId: string
  try {
    await client.query('BEGIN')
    tenantId = await seedTenant(client)
    await client.query('COMMIT')
  } finally { client.release() }

  // appendEvent (via getClient internally) creates the credit_subject
  // lazily + writes the initial event.
  const initial = await appendEvent({
    subjectType:           'tenant',
    subjectRefId:          tenantId,
    eventType:             'payment_received_late_major' as any,
    eventData:             { amount: 1000, days_late: 12 },
    occurredAt:            new Date('2026-01-15T00:00:00Z'),
    attestationSource:     'gam_workflow_auto',
    attestationEvidence:   { source: 'webhook_reconciler' },
    dimensionTags:         ['payment_history'] as any,
    networkVisibility:     'visible_to_gam_network',
  })

  const subj = await db.query<{ id: string }>(
    `SELECT id FROM credit_subjects
      WHERE subject_type = 'tenant' AND subject_ref_id = $1`,
    [tenantId],
  )
  return {
    tenantId,
    subjectId:       subj.rows[0].id,
    initialEventId:  initial.eventId,
  }
}

describe('openDispute', () => {
  it('creates a dispute row + dispute_opened event on the chain', async () => {
    const { tenantId, subjectId, initialEventId } = await seedTenantWithLateEvent()
    const { disputeId, openEventId } = await openDispute({
      disputingSubjectId:    subjectId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      disputedEventId:       initialEventId,
      reason:                'factual_inaccuracy',
      notes:                 'I paid on time; system error',
    })

    expect(disputeId).toMatch(/^[0-9a-f-]{36}$/)
    expect(openEventId).toMatch(/^[0-9a-f-]{36}$/)

    const row = await db.query<{
      status: string; reason: string; notes: string;
      disputed_event_id: string; disputing_subject_id: string;
      dispute_open_event_id: string;
    }>(
      `SELECT status, reason, notes, disputed_event_id, disputing_subject_id,
              dispute_open_event_id
         FROM credit_disputes WHERE id = $1`,
      [disputeId],
    )
    expect(row.rows[0]).toMatchObject({
      status:                 'open',
      reason:                 'factual_inaccuracy',
      notes:                  'I paid on time; system error',
      disputed_event_id:      initialEventId,
      disputing_subject_id:   subjectId,
      dispute_open_event_id:  openEventId,
    })

    const ev = await db.query<{ event_type: string }>(
      `SELECT event_type FROM credit_events WHERE id = $1`,
      [openEventId],
    )
    expect(ev.rows[0].event_type).toBe('dispute_opened')
  })
})

describe('submitDisputeEvidence', () => {
  it('appends dispute_evidence_submitted + flips status to evidence_pending', async () => {
    const { tenantId, subjectId, initialEventId } = await seedTenantWithLateEvent()
    const { disputeId } = await openDispute({
      disputingSubjectId:    subjectId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      disputedEventId:       initialEventId,
      reason:                'attestation_invalid',
    })
    const { eventId } = await submitDisputeEvidence({
      disputeId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      evidence:              { receipt_url: 'https://example.com/receipt.pdf' },
    })
    const status = await db.query<{ status: string }>(
      `SELECT status FROM credit_disputes WHERE id = $1`, [disputeId],
    )
    expect(status.rows[0].status).toBe('evidence_pending')

    const ev = await db.query<{ event_type: string; event_data: any }>(
      `SELECT event_type, event_data FROM credit_events WHERE id = $1`, [eventId],
    )
    expect(ev.rows[0].event_type).toBe('dispute_evidence_submitted')
    expect(ev.rows[0].event_data.dispute_id).toBe(disputeId)
    expect(ev.rows[0].event_data.receipt_url).toBe('https://example.com/receipt.pdf')
  })

  it('refuses to submit evidence on an already-resolved dispute', async () => {
    const { tenantId, subjectId, initialEventId } = await seedTenantWithLateEvent()
    const { disputeId } = await openDispute({
      disputingSubjectId:    subjectId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      disputedEventId:       initialEventId,
      reason:                'factual_inaccuracy',
    })
    await resolveDispute({ disputeId, outcome: 'no_change' })

    await expect(submitDisputeEvidence({
      disputeId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      evidence:              { late_notes: 'too late' },
    })).rejects.toThrow(/cannot submit evidence/)
  })
})

describe('resolveDispute — upheld', () => {
  it('flips status to resolved_upheld + appends dispute_resolved_upheld; no supersede', async () => {
    const { tenantId, subjectId, initialEventId } = await seedTenantWithLateEvent()
    const { disputeId } = await openDispute({
      disputingSubjectId:    subjectId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      disputedEventId:       initialEventId,
      reason:                'identity_mismatch',
    })
    const { resolveEventId, correctedEventId } = await resolveDispute({
      disputeId,
      outcome:       'upheld',
      resolverNotes: 'reviewed evidence; original stands',
    })
    expect(correctedEventId).toBeUndefined()

    const d = await db.query<{ status: string; resolution_event_id: string }>(
      `SELECT status, resolution_event_id FROM credit_disputes WHERE id = $1`,
      [disputeId],
    )
    expect(d.rows[0].status).toBe('resolved_upheld')
    expect(d.rows[0].resolution_event_id).toBe(resolveEventId)

    // Original event still un-superseded.
    const orig = await db.query<{ superseded_by: string | null }>(
      `SELECT superseded_by FROM credit_events WHERE id = $1`,
      [initialEventId],
    )
    expect(orig.rows[0].superseded_by).toBeNull()
  })
})

describe('resolveDispute — no_change', () => {
  it('flips status to resolved_no_change + appends dispute_resolved_no_change', async () => {
    const { tenantId, subjectId, initialEventId } = await seedTenantWithLateEvent()
    const { disputeId } = await openDispute({
      disputingSubjectId:    subjectId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      disputedEventId:       initialEventId,
      reason:                'other',
    })
    const { correctedEventId } = await resolveDispute({
      disputeId,
      outcome: 'no_change',
    })
    expect(correctedEventId).toBeUndefined()

    const d = await db.query<{ status: string }>(
      `SELECT status FROM credit_disputes WHERE id = $1`,
      [disputeId],
    )
    expect(d.rows[0].status).toBe('resolved_no_change')
  })
})

describe('resolveDispute — corrected (S325 regression target)', () => {
  it('appends corrected event + supersedes original + flips status to resolved_corrected', async () => {
    const { tenantId, subjectId, initialEventId } = await seedTenantWithLateEvent()
    const { disputeId } = await openDispute({
      disputingSubjectId:    subjectId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      disputedEventId:       initialEventId,
      reason:                'factual_inaccuracy',
    })

    const { resolveEventId, correctedEventId } = await resolveDispute({
      disputeId,
      outcome:        'corrected',
      resolverNotes:  'evidence shows payment was on time',
      resolvedByUserId: '00000000-0000-0000-0000-000000000001',
      correctedEvent: {
        subjectType:          'tenant',
        subjectRefId:         tenantId,
        eventType:            'payment_received_on_time' as any,
        eventData:            { amount: 1000, dispute_corrected: true, dispute_id: disputeId },
        occurredAt:           new Date('2026-01-15T00:00:00Z'),
        attestationSource:    'admin_corrected_after_dispute' as any,
        attestationEvidence:  { dispute_id: disputeId },
        dimensionTags:        ['payment_history'] as any,
        networkVisibility:    'visible_to_gam_network',
      },
      supersedeReason: 'correction_after_dispute',
    })

    expect(correctedEventId).toBeDefined()
    expect(correctedEventId).not.toBe(initialEventId)

    const d = await db.query<{ status: string; resolution_event_id: string }>(
      `SELECT status, resolution_event_id FROM credit_disputes WHERE id = $1`,
      [disputeId],
    )
    expect(d.rows[0].status).toBe('resolved_corrected')
    expect(d.rows[0].resolution_event_id).toBe(resolveEventId)

    // Original event is now superseded by the new corrected event.
    const orig = await db.query<{ superseded_by: string; superseded_reason: string }>(
      `SELECT superseded_by, superseded_reason FROM credit_events WHERE id = $1`,
      [initialEventId],
    )
    expect(orig.rows[0].superseded_by).toBe(correctedEventId)
    expect(orig.rows[0].superseded_reason).toBe('correction_after_dispute')

    // The corrected event is on the chain with the right type +
    // attestation_source.
    const corr = await db.query<{
      event_type: string; attestation_source: string; event_data: any
    }>(
      `SELECT event_type, attestation_source, event_data
         FROM credit_events WHERE id = $1`,
      [correctedEventId!],
    )
    expect(corr.rows[0].event_type).toBe('payment_received_on_time')
    expect(corr.rows[0].attestation_source).toBe('admin_corrected_after_dispute')
    expect(corr.rows[0].event_data.dispute_id).toBe(disputeId)
    expect(corr.rows[0].event_data.dispute_corrected).toBe(true)

    // The resolve event itself carries the corrected_event_id for audit
    // attribution.
    const resolveEv = await db.query<{ event_data: any; event_type: string }>(
      `SELECT event_data, event_type FROM credit_events WHERE id = $1`,
      [resolveEventId],
    )
    expect(resolveEv.rows[0].event_type).toBe('dispute_resolved_corrected')
    expect(resolveEv.rows[0].event_data.corrected_event_id).toBe(correctedEventId)
    expect(resolveEv.rows[0].event_data.resolved_by_user_id)
      .toBe('00000000-0000-0000-0000-000000000001')
    expect(resolveEv.rows[0].event_data.outcome).toBe('corrected')
  })

  it('refuses corrected outcome without a correctedEvent payload', async () => {
    const { tenantId, subjectId, initialEventId } = await seedTenantWithLateEvent()
    const { disputeId } = await openDispute({
      disputingSubjectId:    subjectId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      disputedEventId:       initialEventId,
      reason:                'factual_inaccuracy',
    })
    await expect(
      resolveDispute({ disputeId, outcome: 'corrected' })
    ).rejects.toThrow(/correctedEvent is required/)
  })
})

describe('resolveDispute — already-resolved guard', () => {
  it('refuses to re-resolve a dispute that is already resolved', async () => {
    const { tenantId, subjectId, initialEventId } = await seedTenantWithLateEvent()
    const { disputeId } = await openDispute({
      disputingSubjectId:    subjectId,
      disputingSubjectType:  'tenant',
      disputingSubjectRefId: tenantId,
      disputedEventId:       initialEventId,
      reason:                'factual_inaccuracy',
    })
    await resolveDispute({ disputeId, outcome: 'upheld' })
    await expect(
      resolveDispute({ disputeId, outcome: 'no_change' })
    ).rejects.toThrow(/already resolved/)
  })
})
