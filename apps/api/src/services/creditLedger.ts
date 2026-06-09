import { createHash } from 'crypto'
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import type {
  CreditSubjectType,
  CreditEventType,
  CreditAttestationSource,
  CreditScoreDimension,
  CreditNetworkVisibility,
  CreditSupersedeReason,
} from '@gam/shared'

// ============================================================
// Credit Ledger service — v1 foundation.
//
// Core invariant: events form a per-subject hash chain. Every event
// references prev_hash (the prior event's this_hash for the same
// subject). The first event for a subject has prev_hash = NULL.
//
// this_hash = sha256(
//   prev_hash_or_zeros (32 bytes) ||
//   canonical_json(event_data) ||
//   occurred_at_iso ||
//   attestation_source ||
//   canonical_json(attestation_evidence)
// )
//
// Replay determinism: chain validation walks a subject's events in
// recorded_at order, recomputes hashes against persisted prev_hash
// values, and compares to the persisted this_hash. Mismatch = tamper.
//
// Append concurrency: appendEvent() acquires a per-subject advisory
// lock for the duration of the insert so two simultaneous appends
// can't both read the same prev_hash and write divergent siblings.
//
// Caller may pass an existing PoolClient (transactional caller, e.g.
// the payment_intent.succeeded webhook handler) or omit it (we acquire
// our own connection). When the caller owns the transaction, the
// advisory lock is xact-scoped to their transaction, not ours.
// ============================================================

const ZERO_HASH = Buffer.alloc(32, 0)

export interface AppendEventInput {
  subjectType: CreditSubjectType
  subjectRefId: string
  eventType: CreditEventType
  eventData?: Record<string, unknown>
  occurredAt: Date
  attestationSource: CreditAttestationSource
  attestationEvidence?: Record<string, unknown>
  dimensionTags?: CreditScoreDimension[]
  networkVisibility: CreditNetworkVisibility
}

export interface AppendEventResult {
  eventId: string
  subjectId: string
  thisHash: Buffer
  prevHash: Buffer | null
}

/**
 * Canonical JSON: stable key ordering + no whitespace, so the same
 * logical payload always hashes to the same bytes. Recursively sorts
 * object keys; arrays preserve order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/**
 * Compute the hash for a single event given its prev_hash and payload.
 * Pure function — no DB access. Same inputs always produce same output.
 */
export function computeEventHash(args: {
  prevHash: Buffer | null
  eventData: Record<string, unknown>
  occurredAt: Date
  attestationSource: string
  attestationEvidence: Record<string, unknown>
}): Buffer {
  const h = createHash('sha256')
  h.update(args.prevHash ?? ZERO_HASH)
  h.update(canonicalJson(args.eventData))
  h.update(args.occurredAt.toISOString())
  h.update(args.attestationSource)
  h.update(canonicalJson(args.attestationEvidence))
  return h.digest()
}

/**
 * Lazily materialize a credit_subject for (type, ref_id). Idempotent —
 * the unique constraint guarantees one row per pair.
 *
 * Returns the subject id. Uses ON CONFLICT to avoid races when two
 * appendEvent calls land for the same subject simultaneously.
 */
export async function getOrCreateSubject(
  client: PoolClient,
  subjectType: CreditSubjectType,
  subjectRefId: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM credit_subjects WHERE subject_type=$1 AND subject_ref_id=$2`,
    [subjectType, subjectRefId],
  )
  if (existing.rows[0]) return existing.rows[0].id

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO credit_subjects (subject_type, subject_ref_id)
     VALUES ($1, $2)
     ON CONFLICT (subject_type, subject_ref_id)
     DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [subjectType, subjectRefId],
  )
  return inserted.rows[0].id
}

/**
 * Append a new event to a subject's chain. Atomic. Caller may supply
 * an existing client (the webhook/route's transaction) or pass null
 * to acquire our own.
 *
 * Workflow:
 *   1. Acquire a per-subject advisory lock (key 'credit_subject:<id>')
 *      so concurrent appends can't read the same prev_hash.
 *   2. Look up the most recent event for the subject; its this_hash
 *      becomes our prev_hash.
 *   3. Compute this_hash from canonical payload.
 *   4. Insert.
 */
export async function appendEvent(
  input: AppendEventInput,
  existingClient: PoolClient | null = null,
): Promise<AppendEventResult> {
  const client = existingClient ?? (await getClient())
  const ownTransaction = !existingClient

  try {
    if (ownTransaction) await client.query('BEGIN')

    const subjectId = await getOrCreateSubject(client, input.subjectType, input.subjectRefId)

    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `credit_subject:${subjectId}`,
    ])

    const tip = await client.query<{ this_hash: Buffer }>(
      `SELECT this_hash
         FROM credit_events
        WHERE subject_id = $1
        ORDER BY recorded_at DESC, id DESC
        LIMIT 1`,
      [subjectId],
    )
    const prevHash: Buffer | null = tip.rows[0]?.this_hash ?? null

    const eventData = input.eventData ?? {}
    const evidence = input.attestationEvidence ?? {}

    const thisHash = computeEventHash({
      prevHash,
      eventData,
      occurredAt: input.occurredAt,
      attestationSource: input.attestationSource,
      attestationEvidence: evidence,
    })

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO credit_events (
         subject_id, event_type, event_data, occurred_at,
         attestation_source, attestation_evidence,
         dimension_tags, network_visibility,
         prev_hash, this_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        subjectId,
        input.eventType,
        JSON.stringify(eventData),
        input.occurredAt,
        input.attestationSource,
        JSON.stringify(evidence),
        input.dimensionTags ?? [],
        input.networkVisibility,
        prevHash,
        thisHash,
      ],
    )

    if (ownTransaction) await client.query('COMMIT')

    return {
      eventId: inserted.rows[0].id,
      subjectId,
      thisHash,
      prevHash,
    }
  } catch (e) {
    if (ownTransaction) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (ownTransaction) client.release()
  }
}

export interface ChainEventRow {
  id: string
  event_type: string
  event_data: Record<string, unknown>
  occurred_at: Date
  recorded_at: Date
  attestation_source: string
  attestation_evidence: Record<string, unknown>
  dimension_tags: string[]
  network_visibility: string
  prev_hash: Buffer | null
  this_hash: Buffer
  superseded_by: string | null
}

/**
 * Return all events for a subject in chain order (recorded_at ASC).
 * Includes superseded events — callers that want the active chain only
 * filter by superseded_by IS NULL.
 */
export async function getSubjectChain(subjectId: string): Promise<ChainEventRow[]> {
  return query<ChainEventRow>(
    `SELECT id, event_type, event_data, occurred_at, recorded_at,
            attestation_source, attestation_evidence, dimension_tags,
            network_visibility, prev_hash, this_hash, superseded_by
       FROM credit_events
      WHERE subject_id = $1
      ORDER BY recorded_at ASC, id ASC`,
    [subjectId],
  )
}

export interface VerifyChainResult {
  ok: boolean
  eventCount: number
  firstBadEventId?: string
  reason?: string
}

/**
 * Walk a subject's chain in recorded_at order, recomputing each hash
 * from its persisted prev_hash + payload, and comparing to the
 * persisted this_hash. Returns ok=true only if every event verifies
 * AND the chain is unbroken (event N's prev_hash equals event N-1's
 * this_hash).
 */
export async function verifyChain(subjectId: string): Promise<VerifyChainResult> {
  const events = await getSubjectChain(subjectId)
  if (events.length === 0) return { ok: true, eventCount: 0 }

  let expectedPrev: Buffer | null = null
  for (const ev of events) {
    if (expectedPrev === null && ev.prev_hash !== null) {
      return {
        ok: false,
        eventCount: events.length,
        firstBadEventId: ev.id,
        reason: 'first event has non-null prev_hash',
      }
    }
    if (expectedPrev !== null) {
      if (ev.prev_hash === null || !ev.prev_hash.equals(expectedPrev)) {
        return {
          ok: false,
          eventCount: events.length,
          firstBadEventId: ev.id,
          reason: 'prev_hash does not match prior event this_hash',
        }
      }
    }

    const recomputed = computeEventHash({
      prevHash: ev.prev_hash,
      eventData: ev.event_data,
      occurredAt: new Date(ev.occurred_at),
      attestationSource: ev.attestation_source,
      attestationEvidence: ev.attestation_evidence,
    })
    if (!recomputed.equals(ev.this_hash)) {
      return {
        ok: false,
        eventCount: events.length,
        firstBadEventId: ev.id,
        reason: 'this_hash does not match recomputed digest',
      }
    }

    expectedPrev = ev.this_hash
  }

  return { ok: true, eventCount: events.length }
}

export interface MerkleRootResult {
  root: Buffer
  eventCount: number
  earliestEventId: string | null
  latestEventId: string | null
}

/**
 * Compute a Merkle root over all (non-superseded) events globally.
 * Used by the weekly anchor cron. Tree is built from each event's
 * this_hash as a leaf, in (recorded_at, id) order. Odd nodes at any
 * level duplicate themselves (standard Merkle convention).
 *
 * Returns a zero-root + null event ids when the ledger is empty —
 * the cron writes that anchor to record the empty-state checkpoint
 * for the period.
 */
export async function computeMerkleRoot(): Promise<MerkleRootResult> {
  const rows = await query<{ id: string; this_hash: Buffer }>(
    `SELECT id, this_hash
       FROM credit_events
      WHERE superseded_by IS NULL
      ORDER BY recorded_at ASC, id ASC`,
  )
  if (rows.length === 0) {
    return { root: ZERO_HASH, eventCount: 0, earliestEventId: null, latestEventId: null }
  }

  let level: Buffer[] = rows.map((r) => r.this_hash)
  while (level.length > 1) {
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = i + 1 < level.length ? level[i + 1] : level[i]
      const h = createHash('sha256')
      h.update(left)
      h.update(right)
      next.push(h.digest())
    }
    level = next
  }

  return {
    root: level[0],
    eventCount: rows.length,
    earliestEventId: rows[0].id,
    latestEventId: rows[rows.length - 1].id,
  }
}

/**
 * Mark an event as superseded by a newer corrected event. Used by the
 * dispute lifecycle when a dispute resolves with 'resolved_corrected'.
 * The original event stays in the chain (append-only) but score
 * computation will skip it via superseded_by IS NOT NULL.
 *
 * The chain hash invariant is preserved — superseded_by is metadata,
 * not part of the hashed payload.
 */
export async function supersedeEvent(
  client: PoolClient,
  originalEventId: string,
  correctedEventId: string,
  reason: CreditSupersedeReason,
): Promise<void> {
  await client.query(
    `UPDATE credit_events
        SET superseded_by = $2,
            superseded_reason = $3
      WHERE id = $1`,
    [originalEventId, correctedEventId, reason],
  )
}

/**
 * Convenience for callers that need a subject id without appending.
 * Returns null if not yet materialized.
 */
export async function findSubjectId(
  subjectType: CreditSubjectType,
  subjectRefId: string,
): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM credit_subjects WHERE subject_type=$1 AND subject_ref_id=$2`,
    [subjectType, subjectRefId],
  )
  return row?.id ?? null
}
