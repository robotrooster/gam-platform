import { getClient } from '../db'
import { appendEvent, supersedeEvent, CHAIN_RESTART_EVENT } from './creditLedger'
import { recomputeAndSnapshot } from './creditScore'
import type {
  CreditDisputeReason,
  CreditDisputeStatus,
  CreditSupersedeReason,
} from '@gam/shared'
import { logger } from '../lib/logger'
import { AppError } from '../middleware/errorHandler'

// ============================================================
// Credit dispute service — Session B.
//
// Disputes are first-class lifecycle objects. Every transition emits
// a corresponding ledger event tagged to the disputing subject.
//
//   open()                  → dispute_opened
//   submitEvidence()        → dispute_evidence_submitted
//   resolve(upheld)         → dispute_resolved_upheld         (no chain change)
//   resolve(corrected)      → dispute_resolved_corrected      (sets superseded_by; recomputes score)
//   resolve(no_change)      → dispute_resolved_no_change      (no chain change)
//
// Score recomputation fires automatically on resolved_corrected.
// Other resolutions don't change the chain; the surrounding nightly
// score cron picks up any natural drift, but no on-demand recompute
// is needed.
// ============================================================

export async function openDispute(args: {
  disputingSubjectId: string
  disputingSubjectType: 'tenant' | 'landlord' | 'manager' | 'property'
  disputingSubjectRefId: string
  disputedEventId: string
  reason: CreditDisputeReason
  notes?: string
}): Promise<{ disputeId: string; openEventId: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // S392 fix: verify the disputed event actually belongs to the
    // disputing subject. Pre-fix, the route at credit.ts:561 passed
    // `disputedEventId` from request body straight through with no
    // ownership check — a tenant could open a dispute against ANY
    // event in the system (including events on other tenants, landlords,
    // or properties). Admin resolution then writes a "corrected" event
    // on the stranger's chain via supersede — cross-subject credit
    // manipulation. Now: 403 if the event's subject_id !=
    // disputingSubjectId.
    const ownership = await client.query<{ subject_id: string; event_type: string }>(
      `SELECT subject_id, event_type FROM credit_events WHERE id = $1`,
      [args.disputedEventId],
    )
    if (ownership.rows.length === 0) {
      throw new Error(`disputed event ${args.disputedEventId} not found`)
    }
    if (ownership.rows[0].subject_id !== args.disputingSubjectId) {
      throw new Error('disputed event does not belong to disputing subject')
    }
    // 10/13 (Nic): "Restart note: ADMIN ONLY." A chain restart is the ledger's
    // own record, not a mark — nothing in the credit history to dispute — and
    // a dispute would hand its note back to the subject (/disputes/mine
    // returns the disputed entry's contents). The integrity proof names the
    // restart's id to anyone who may verify the chain, so it is refused here.
    if (ownership.rows[0].event_type === CHAIN_RESTART_EVENT) {
      throw new AppError(400, 'That entry is not part of the credit history, so it cannot be disputed.')
    }

    const evidence = {
      disputed_event_id: args.disputedEventId,
      reason: args.reason,
      notes: args.notes ?? null,
    }

    const openEvent = await appendEvent(
      {
        subjectType: args.disputingSubjectType,
        subjectRefId: args.disputingSubjectRefId,
        eventType: 'dispute_opened',
        eventData: evidence,
        occurredAt: new Date(),
        attestationSource: 'system_derived',
        attestationEvidence: evidence,
        dimensionTags: [],
        networkVisibility: 'private_to_subject',
      },
      client,
    )

    const dispute = await client.query<{ id: string }>(
      `INSERT INTO credit_disputes (
         disputed_event_id, disputing_subject_id, dispute_open_event_id,
         status, reason, notes
       ) VALUES ($1, $2, $3, 'open', $4, $5)
       RETURNING id`,
      [
        args.disputedEventId,
        args.disputingSubjectId,
        openEvent.eventId,
        args.reason,
        args.notes ?? null,
      ],
    )

    await client.query('COMMIT')
    return { disputeId: dispute.rows[0].id, openEventId: openEvent.eventId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function submitDisputeEvidence(args: {
  disputeId: string
  disputingSubjectType: 'tenant' | 'landlord' | 'manager' | 'property'
  disputingSubjectRefId: string
  evidence: Record<string, unknown>
}): Promise<{ eventId: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // S392 fix: verify caller owns the dispute. Pre-fix, the SELECT
    // only checked id, with no ownership predicate — any tenant could
    // submit evidence on another tenant's dispute by passing the
    // foreign disputeId. The injected evidence influences admin
    // resolution and gets stamped with the foreign subject's id via
    // the appendEvent call below. The JOIN to credit_subjects
    // resolves the dispute's owner to a (subject_type, subject_ref_id)
    // pair so we can compare against the caller's identity.
    const dispute = await client.query<{
      id: string
      status: CreditDisputeStatus
      subject_type: string
      subject_ref_id: string
    }>(
      `SELECT d.id, d.status, s.subject_type, s.subject_ref_id
         FROM credit_disputes d
         JOIN credit_subjects s ON s.id = d.disputing_subject_id
        WHERE d.id = $1 FOR UPDATE`,
      [args.disputeId],
    )
    if (dispute.rows.length === 0) throw new Error(`dispute ${args.disputeId} not found`)
    const current = dispute.rows[0]
    if (
      current.subject_type !== args.disputingSubjectType ||
      current.subject_ref_id !== args.disputingSubjectRefId
    ) {
      throw new Error('caller does not own this dispute')
    }
    if (current.status !== 'open' && current.status !== 'evidence_pending') {
      throw new Error(
        `cannot submit evidence on dispute ${args.disputeId} in status ${current.status}`,
      )
    }

    const evEvent = await appendEvent(
      {
        subjectType: args.disputingSubjectType,
        subjectRefId: args.disputingSubjectRefId,
        eventType: 'dispute_evidence_submitted',
        eventData: { dispute_id: args.disputeId, ...args.evidence },
        occurredAt: new Date(),
        attestationSource: 'system_derived',
        attestationEvidence: args.evidence,
        dimensionTags: [],
        networkVisibility: 'private_to_subject',
      },
      client,
    )

    if (current.status === 'open') {
      await client.query(
        `UPDATE credit_disputes SET status = 'evidence_pending' WHERE id = $1`,
        [args.disputeId],
      )
    }

    await client.query('COMMIT')
    return { eventId: evEvent.eventId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export type ResolveOutcome = 'upheld' | 'corrected' | 'no_change'

export async function resolveDispute(args: {
  disputeId: string
  outcome: ResolveOutcome
  resolverNotes?: string
  /** Admin user id who resolved the dispute. Captured in the resolve
   * event's event_data for audit-grade attribution. Optional for
   * backwards compat — service callers without an actor leave this
   * unset. */
  resolvedByUserId?: string
  /** Required when outcome === 'corrected'. New event payload that
   * supersedes the original disputed event. */
  correctedEvent?: {
    subjectType: 'tenant' | 'landlord' | 'manager' | 'property'
    subjectRefId: string
    eventType: import('@gam/shared').CreditEventType
    eventData: Record<string, unknown>
    occurredAt: Date
    attestationSource: import('@gam/shared').CreditAttestationSource
    attestationEvidence: Record<string, unknown>
    dimensionTags: import('@gam/shared').CreditScoreDimension[]
    networkVisibility: import('@gam/shared').CreditNetworkVisibility
  }
  supersedeReason?: CreditSupersedeReason
}): Promise<{ resolveEventId: string; correctedEventId?: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const dispute = await client.query<{
      id: string
      status: CreditDisputeStatus
      disputed_event_id: string
      disputing_subject_id: string
    }>(
      `SELECT id, status, disputed_event_id, disputing_subject_id
         FROM credit_disputes
        WHERE id = $1
        FOR UPDATE`,
      [args.disputeId],
    )
    if (dispute.rows.length === 0) throw new Error(`dispute ${args.disputeId} not found`)
    const d = dispute.rows[0]
    if (d.status === 'resolved_upheld' || d.status === 'resolved_corrected' || d.status === 'resolved_no_change') {
      throw new Error(`dispute ${args.disputeId} already resolved`)
    }

    // Look up disputing subject's (type, ref) so we can write resolution
    // event onto their chain.
    const subj = await client.query<{
      subject_type: 'tenant' | 'landlord' | 'manager' | 'property'
      subject_ref_id: string
    }>(
      `SELECT subject_type, subject_ref_id FROM credit_subjects WHERE id = $1`,
      [d.disputing_subject_id],
    )
    if (subj.rows.length === 0) throw new Error('disputing subject vanished')
    const subjectType = subj.rows[0].subject_type
    const subjectRefId = subj.rows[0].subject_ref_id

    let correctedEventId: string | undefined

    if (args.outcome === 'corrected') {
      if (!args.correctedEvent) {
        throw new Error('correctedEvent is required for outcome=corrected')
      }
      // 10/12 (review): only a mark still live can be corrected. A mark the
      // ledger has replaced since the dispute was opened (a later payment
      // re-judged its bill — creditBillMarks — or it was withdrawn) already
      // points at what replaced it; correcting it anyway overwrote that link
      // and left two live marks. The admin resolves this one as upheld or no
      // change and corrects the live mark if it is wrong.
      // The mark's subject is locked first, the lock every mark writer takes
      // (appendEvent, creditBillMarks.syncBillMarks), so nothing replaces the
      // mark between this check and the correction.
      const target = (await client.query<{ subject_id: string }>(
        `SELECT subject_id FROM credit_events WHERE id = $1`, [d.disputed_event_id])).rows[0]
      if (!target) throw new AppError(404, 'The disputed mark no longer exists')
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`credit_subject:${target.subject_id}`])
      const live = (await client.query<{ superseded_by: string | null }>(
        `SELECT superseded_by FROM credit_events WHERE id = $1`, [d.disputed_event_id])).rows[0]
      if (live?.superseded_by) {
        throw new AppError(409,
          'This mark was already replaced on the ledger after the dispute was opened (a later payment or correction). ' +
          'Resolve this dispute as upheld or no change; if the mark that replaced it is wrong, correct that one.')
      }
      const corrected = await appendEvent(args.correctedEvent, client)
      correctedEventId = corrected.eventId
      const superseded = await supersedeEvent(
        client,
        d.disputed_event_id,
        correctedEventId,
        args.supersedeReason ?? 'correction_after_dispute',
      )
      if (!superseded) {
        throw new AppError(409, 'The disputed mark was replaced while this was being resolved. Reload and try again.')
      }
    }

    const resolveEventType = (
      args.outcome === 'upheld'
        ? 'dispute_resolved_upheld'
        : args.outcome === 'corrected'
          ? 'dispute_resolved_corrected'
          : 'dispute_resolved_no_change'
    ) as import('@gam/shared').CreditEventType

    const resolveEvent = await appendEvent(
      {
        subjectType,
        subjectRefId,
        eventType: resolveEventType,
        eventData: {
          dispute_id: args.disputeId,
          outcome: args.outcome,
          resolver_notes: args.resolverNotes ?? null,
          corrected_event_id: correctedEventId ?? null,
          resolved_by_user_id: args.resolvedByUserId ?? null,
        },
        occurredAt: new Date(),
        attestationSource: 'system_derived',
        attestationEvidence: { dispute_id: args.disputeId },
        dimensionTags: [],
        networkVisibility: 'private_to_subject',
      },
      client,
    )

    const newStatus =
      args.outcome === 'upheld'
        ? 'resolved_upheld'
        : args.outcome === 'corrected'
          ? 'resolved_corrected'
          : 'resolved_no_change'

    await client.query(
      `UPDATE credit_disputes
          SET status = $1,
              resolution_event_id = $2,
              resolved_at = NOW()
        WHERE id = $3`,
      [newStatus, resolveEvent.eventId, args.disputeId],
    )

    await client.query('COMMIT')

    // Recompute and snapshot the disputing subject's score AFTER commit
    // when the chain actually changed (corrected). For upheld / no_change
    // the chain is unchanged so the next nightly cron is enough.
    if (args.outcome === 'corrected') {
      try {
        await recomputeAndSnapshot(d.disputing_subject_id)
      } catch (e) {
        logger.error({ err: e }, '[credit-dispute] post-resolve recompute failed:')
      }
    }

    return { resolveEventId: resolveEvent.eventId, correctedEventId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
