import { createHash } from 'crypto'
import type { PoolClient } from 'pg'
import { db, query, queryOne, getClient } from '../db'
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
//
// Restarts (10/13, Nic — the 12 chains a pre-10/12 bug forked: "restart
// the chain from today, with a recorded note explaining the break", old
// entries untouched): restartChain() appends a 'chain_restarted' event
// with NO prev_hash — the first event of a new chain — whose hashed
// payload carries the note and seals the old chain (its event count, the
// hashes of its ends, the event where it broke, and EVERY point it split:
// production's forks split up to seven ways, one at two points). Later
// events link from it. verifyChain() reads a restarted chain as whole when
// the new chain is whole and every restart matches — and explains all of —
// the chain it sealed, and reports each restart with the break it explains.
// ============================================================

const ZERO_HASH = Buffer.alloc(32, 0)

type Q = Pick<PoolClient, 'query'>

/** The event a chain restart is recorded as (10/13): the first event of the new chain. */
export const CHAIN_RESTART_EVENT: CreditEventType = 'chain_restarted'

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

    // 10/12 (Nic: "one mark per invoice" — corrections must keep the chain
    // whole): the tip is the chain's END — the newest event no other event of
    // the subject follows. recorded_at used to default to now(), the
    // TRANSACTION's start, so every event one transaction appended for a
    // subject (a settle's rent and utility marks, a correction's new mark and
    // its withdrawal) shared one recorded_at, and "newest" fell to the random
    // id: a third append could link to the first instead of the second (a
    // fork), and verifyChain, walking by (recorded_at, id), read correct
    // chains as tampered. Production carried both on 10/12 (27 of 114
    // subjects failed verifyChain, 12 had a fork). New events now get a
    // recorded_at strictly after the subject's newest (below); a tail of
    // equal times written before is resolved by the links.
    const tip = await client.query<{ this_hash: Buffer }>(
      `SELECT e.this_hash
         FROM credit_events e
        WHERE e.subject_id = $1
          AND e.recorded_at = (SELECT MAX(m.recorded_at) FROM credit_events m WHERE m.subject_id = $1)
        ORDER BY (NOT EXISTS (SELECT 1 FROM credit_events n
                               WHERE n.subject_id = $1 AND n.prev_hash = e.this_hash)) DESC,
                 e.id DESC
        LIMIT 1`,
      [subjectId],
    )
    const prevHash: Buffer | null = tip.rows[0]?.this_hash ?? null

    const written = await insertEvent(client, subjectId, prevHash, input)

    if (ownTransaction) await client.query('COMMIT')

    return written
  } catch (e) {
    if (ownTransaction) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (ownTransaction) client.release()
  }
}

/**
 * Hash and insert one event after prevHash (null: the first event of a chain).
 * The caller holds the subject's advisory lock.
 */
async function insertEvent(
  client: PoolClient,
  subjectId: string,
  prevHash: Buffer | null,
  input: Omit<AppendEventInput, 'subjectType' | 'subjectRefId'>,
): Promise<AppendEventResult> {
  const eventData = input.eventData ?? {}
  const evidence = input.attestationEvidence ?? {}

  const thisHash = computeEventHash({
    prevHash,
    eventData,
    occurredAt: input.occurredAt,
    attestationSource: input.attestationSource,
    attestationEvidence: evidence,
  })

  // recorded_at: the clock now, and always after the subject's newest event
  // (10/12, appendEvent) — append order IS (recorded_at, id) order, for
  // verifyChain, the score replay and the Merkle anchor alike. Not hashed.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO credit_events (
       subject_id, event_type, event_data, occurred_at,
       attestation_source, attestation_evidence,
       dimension_tags, network_visibility,
       prev_hash, this_hash, recorded_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               GREATEST(clock_timestamp(),
                        COALESCE((SELECT MAX(m.recorded_at) FROM credit_events m WHERE m.subject_id = $1)
                                 + interval '1 microsecond', clock_timestamp())))
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

  return {
    eventId: inserted.rows[0].id,
    subjectId,
    thisHash,
    prevHash,
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

const CHAIN_COLUMNS = `id, event_type, event_data, occurred_at, recorded_at,
            attestation_source, attestation_evidence, dimension_tags,
            network_visibility, prev_hash, this_hash, superseded_by`

/**
 * A subject's credit history in chain order (recorded_at ASC, id ASC): every
 * event but the chain restarts. Includes superseded events — callers that
 * want the active history only filter by superseded_by IS NULL.
 *
 * 10/13: a restart (restartChain) is the ledger's own record, not a mark or
 * anything the subject did, so it is left out here — the credit screens, the
 * score and the stats never see it. verifyChain reads it (readChain).
 */
export async function getSubjectChain(subjectId: string): Promise<ChainEventRow[]> {
  return query<ChainEventRow>(
    `SELECT ${CHAIN_COLUMNS}
       FROM credit_events
      WHERE subject_id = $1 AND event_type <> $2
      ORDER BY recorded_at ASC, id ASC`,
    [subjectId, CHAIN_RESTART_EVENT],
  )
}

/** Every event of a subject's chain, restarts included, in append order (recorded_at ASC, id ASC). */
export async function readChain(q: Q, subjectId: string): Promise<ChainEventRow[]> {
  const { rows } = await q.query<ChainEventRow>(
    `SELECT ${CHAIN_COLUMNS}
       FROM credit_events
      WHERE subject_id = $1
      ORDER BY recorded_at ASC, id ASC`,
    [subjectId],
  )
  return rows
}

/** How a chain is broken (verifyChain's `break`). */
export const CHAIN_BREAKS = [
  'tampered',          // an event's stored hash is not the hash of its contents and link
  'no_first_event',    // no event starts the chain
  'two_first_events',  // more than one event starts it
  'fork',              // two events follow the same event
  'loop',
  'unlinked',          // an event follows no event of the chain
  'restart_mismatch',  // 10/13: a restart does not match the chain it sealed
] as const
export type ChainBreak = typeof CHAIN_BREAKS[number]

/** A point where a chain split (10/13): an entry more than one entry attaches to. */
export interface ChainSplit {
  /** The entry the branches attach to. */
  eventId: string
  /** The entries attached to it, in append order: one per branch. */
  followedBy: string[]
}

/** One restart of a chain (10/13), with the break it explains. */
export interface ChainRestart {
  /** The restart event: the first event of the chain after it. */
  eventId: string
  restartedAt: Date
  /** Who may read the note: the restart event's own tier. */
  visibility: CreditNetworkVisibility
  /**
   * The note recorded with it, explaining the break — only for a reader whose
   * tiers include `visibility` (verifyChain). The rest is the integrity proof,
   * which the integrity route shows anyone who may verify the chain.
   */
  note?: string
  /** The chain it sealed — its events, kept exactly as they were — and where that chain broke. */
  sealedEventCount: number
  brokenEventId: string | null
  brokenReason: string | null
  /** Every point the sealed chain split, in append order (brokenEventId is on the first the walk meets). */
  splits: ChainSplit[]
}

export interface VerifyChainResult {
  ok: boolean
  eventCount: number
  firstBadEventId?: string
  reason?: string
  /** What is broken (when not ok). */
  break?: ChainBreak
  /**
   * 10/13: the restarts the chain went through, oldest first — only on a
   * restarted chain. ok with restarts: whole since its last restart, every
   * earlier break explained by the restart that sealed it.
   */
  restarts?: ChainRestart[]
}

/** The hashed payload (event_data) of a restart. */
interface RestartData {
  note: string
  sealed_event_count: number
  /** The ends of the sealed chain: the events nothing follows (one per branch of a fork), hex, sorted. */
  sealed_end_hashes: string[]
  broken_event_id: string | null
  broken_reason: string | null
  /** Every point the sealed chain split (ChainSplit), in append order. */
  splits: Array<{ event_id: string; followed_by: string[] }>
}

const splitData = (splits: readonly ChainSplit[]): RestartData['splits'] =>
  splits.map((s) => ({ event_id: s.eventId, followed_by: [...s.followedBy] }))

/** The event's stored hash is the hash of its contents and its link. */
function hashHolds(e: ChainEventRow): boolean {
  return computeEventHash({
    prevHash: e.prev_hash,
    eventData: e.event_data,
    occurredAt: new Date(e.occurred_at),
    attestationSource: e.attestation_source,
    attestationEvidence: e.attestation_evidence,
  }).equals(e.this_hash)
}

/** A restart starts a chain: a 'chain_restarted' event with no prev_hash. */
const isRestart = (e: ChainEventRow): boolean => e.event_type === CHAIN_RESTART_EVENT && e.prev_hash === null

/**
 * The chain cut at its restarts: the events before the first restart, then
 * each restart with the events after it (append order, as readChain gives).
 */
function chainSegments(events: readonly ChainEventRow[]): ChainEventRow[][] {
  const segments: ChainEventRow[][] = [[]]
  for (const e of events) {
    if (isRestart(e)) segments.push([])
    segments[segments.length - 1].push(e)
  }
  return segments
}

/** The ends of a chain — the events no other event of it follows — as sorted hex hashes. */
function chainEnds(events: readonly ChainEventRow[]): string[] {
  const followed = new Set(events.flatMap((e) => (e.prev_hash ? [e.prev_hash.toString('hex')] : [])))
  return [...new Set(events.map((e) => e.this_hash.toString('hex')).filter((h) => !followed.has(h)))].sort()
}

/** The events that attach to each event (their prev_hash is its this_hash), keyed by hex hash, in append order. */
function followers(events: readonly ChainEventRow[]): Map<string, ChainEventRow[]> {
  const after = new Map<string, ChainEventRow[]>()
  for (const e of events) {
    if (!e.prev_hash) continue
    const k = e.prev_hash.toString('hex')
    after.set(k, [...(after.get(k) ?? []), e])
  }
  return after
}

/**
 * A chain's whole shape (events in append order) — pure. walkChain stops at
 * the first break; a restart has to explain all of it (10/13: production's
 * forked chains split up to seven ways, and one at two points). From the one
 * first event, every branch is followed: `splits` is every entry more than one
 * entry attaches to, in append order; `unreached` is every event no branch
 * reaches (it attaches to no entry of the chain, or sits in a loop). With no
 * first event, or more than one, nothing is reached.
 */
function traceChain(events: readonly ChainEventRow[]): { splits: ChainSplit[]; unreached: ChainEventRow[] } {
  const roots = events.filter((e) => e.prev_hash === null)
  const after = followers(events)
  const seen = new Set<string>()
  const queue = roots.length === 1 ? [roots[0]] : []
  while (queue.length) {
    const cur = queue.shift()!
    if (seen.has(cur.id)) continue
    seen.add(cur.id)
    queue.push(...(after.get(cur.this_hash.toString('hex')) ?? []))
  }
  const splits = events.flatMap((e) => {
    const next = seen.has(e.id) ? after.get(e.this_hash.toString('hex')) ?? [] : []
    return next.length > 1 ? [{ eventId: e.id, followedBy: next.map((n) => n.id) }] : []
  })
  return { splits, unreached: events.filter((e) => !seen.has(e.id)) }
}

/**
 * One chain walked in append order (by its links, 10/12), recomputing each
 * hash from its persisted prev_hash + payload, and comparing to the persisted
 * this_hash. ok only if every event verifies AND the chain is unbroken: one
 * first event, each later event's prev_hash equal to the this_hash of the
 * event before it, no event left off the path, no fork.
 */
function walkChain(events: readonly ChainEventRow[]): VerifyChainResult {
  if (events.length === 0) return { ok: true, eventCount: 0 }
  const bad = (id: string, reason: string, kind: ChainBreak): VerifyChainResult =>
    ({ ok: false, eventCount: events.length, firstBadEventId: id, reason, break: kind })

  // 10/12: walked by the LINKS (each event's prev_hash names the one before
  // it), from the one event with no predecessor. Events one transaction
  // appended before 10/12 share a recorded_at, so (recorded_at, id) order is
  // not append order for them (appendEvent); the links are. Every event must
  // be on the one path: an event no path reaches has a prev_hash that matches
  // no event before it; two events after the same one are a fork.
  const roots = events.filter((e) => e.prev_hash === null)
  if (roots.length === 0) return bad(events[0].id, 'first event has non-null prev_hash', 'no_first_event')
  if (roots.length > 1) return bad(roots[1].id, 'prev_hash does not match prior event this_hash', 'two_first_events')
  const after = followers(events)
  const seen = new Set<string>()
  let cur: ChainEventRow | undefined = roots[0]
  while (cur) {
    if (!hashHolds(cur)) return bad(cur.id, 'this_hash does not match recomputed digest', 'tampered')
    seen.add(cur.id)
    const next: ChainEventRow[] = after.get(cur.this_hash.toString('hex')) ?? []
    if (next.length > 1) return bad(next[1].id, 'prev_hash does not match prior event this_hash (two events follow the same event: a fork)', 'fork')
    cur = next[0]
    if (cur && seen.has(cur.id)) return bad(cur.id, 'prev_hash does not match prior event this_hash (a loop)', 'loop')
  }
  const stray = events.find((e) => !seen.has(e.id))
  if (stray) return bad(stray.id, 'prev_hash does not match prior event this_hash', 'unlinked')
  return { ok: true, eventCount: events.length }
}

/**
 * Verify a chain from its events, in append order (readChain) — pure.
 *
 * Never restarted: walked by its links (walkChain). Restarted (10/13): the
 * chain since the last restart must be whole, walked from that restart; every
 * event before it must still hash to its stored hash (a restart explains a
 * broken link, never altered contents); the chain each restart sealed must be
 * broken by forks only, every event of it reached from its first through the
 * splits (a restart explains a fork, nothing else); and each restart must match
 * the chain it sealed — the same number of events, the same ends, the same
 * first broken event, every split. Each restart is reported with the break it
 * explains, so the old break stays visible as history.
 */
export function verifyEvents(events: readonly ChainEventRow[]): VerifyChainResult {
  if (events.length === 0) return { ok: true, eventCount: 0 }
  const bad = (id: string, reason: string, kind: ChainBreak): VerifyChainResult =>
    ({ ok: false, eventCount: events.length, firstBadEventId: id, reason, break: kind })
  const segments = chainSegments(events)
  const restarts: ChainRestart[] = []
  for (let k = 1; k < segments.length; k++) {
    const restart = segments[k][0]
    const sealed = segments[k - 1]
    const altered = sealed.find((e) => !hashHolds(e))
    if (altered) return bad(altered.id, 'this_hash does not match recomputed digest', 'tampered')
    const was = walkChain(sealed)
    const unexplained = '; the restart after it explains only a fork'
    if (!was.ok && was.break !== 'fork') return bad(was.firstBadEventId!, `${was.reason}${unexplained}`, was.break!)
    const shape = traceChain(sealed)
    const stray = shape.unreached[0]
    if (stray) return bad(stray.id, `prev_hash does not match prior event this_hash${unexplained}`, 'unlinked')
    const d = restart.event_data as Partial<RestartData>
    if (d.sealed_event_count !== sealed.length
        || canonicalJson(d.sealed_end_hashes ?? null) !== canonicalJson(chainEnds(sealed))
        || (d.broken_event_id ?? null) !== (was.firstBadEventId ?? null)
        || canonicalJson(d.splits ?? null) !== canonicalJson(splitData(shape.splits))) {
      return bad(restart.id, 'the restart does not match the chain it sealed', 'restart_mismatch')
    }
    restarts.push({
      eventId: restart.id,
      restartedAt: new Date(restart.recorded_at),
      visibility: restart.network_visibility as CreditNetworkVisibility,
      note: String(d.note ?? ''),
      sealedEventCount: sealed.length,
      brokenEventId: was.firstBadEventId ?? null,
      brokenReason: was.reason ?? null,
      splits: shape.splits,
    })
  }
  const live = walkChain(segments[segments.length - 1])
  const withRestarts = restarts.length ? { restarts } : {}
  if (!live.ok) return { ...live, eventCount: events.length, ...withRestarts }
  return { ok: true, eventCount: events.length, ...withRestarts }
}

/**
 * Verify a subject's chain (verifyEvents over readChain). ok=true only if
 * every event verifies and the chain is unbroken — since its last restart,
 * when it was restarted (10/13; `restarts` then lists each restart and the
 * break it explains).
 *
 * 10/13 (review): a restart's note is the words of a 'private_to_subject'
 * event, so it is returned only to a reader whose tiers (`visibleTo`, the
 * route's canViewSubject) include the restart's. The default is no tiers: no
 * note. The rest of a restart — its id, what it sealed, where the chain broke
 * and split — is the integrity proof, shown to anyone who may verify the chain.
 */
export async function verifyChain(
  subjectId: string,
  opts: { visibleTo?: readonly CreditNetworkVisibility[] } = {},
): Promise<VerifyChainResult> {
  const v = verifyEvents(await readChain(db, subjectId))
  if (!v.restarts) return v
  const may = new Set(opts.visibleTo ?? [])
  return { ...v, restarts: v.restarts.map(({ note, ...r }) => (may.has(r.visibility) ? { ...r, note } : r)) }
}

export interface ChainsReport {
  subjects: number
  /** Whole, never restarted. */
  ok: number
  /** Whole since a restart, every earlier break explained (10/13). */
  okAfterRestart: number
  bad: Array<{ subjectId: string; firstBadEventId: string; reason: string; break: ChainBreak | null }>
  /** Every restarted chain (whole or not) with its restarts. */
  restarted: Array<{ subjectId: string; restarts: ChainRestart[] }>
}

/** Every subject's chain verified (verifyChain), read through q — a READ ONLY transaction is enough. */
export async function verifyAllChains(q: Q = db): Promise<ChainsReport> {
  const { rows } = await q.query<{ subject_id: string }>(`SELECT DISTINCT subject_id FROM credit_events ORDER BY 1`)
  const out: ChainsReport = { subjects: rows.length, ok: 0, okAfterRestart: 0, bad: [], restarted: [] }
  for (const r of rows) {
    const v = verifyEvents(await readChain(q, r.subject_id))
    if (v.restarts) out.restarted.push({ subjectId: r.subject_id, restarts: v.restarts })
    if (!v.ok) out.bad.push({ subjectId: r.subject_id, firstBadEventId: v.firstBadEventId!, reason: v.reason!, break: v.break ?? null })
    else if (v.restarts) out.okAfterRestart++
    else out.ok++
  }
  return out
}

/** Whether a chain may be restarted now (restartChain), and the break it would explain. */
export interface RestartCheck {
  ok: boolean
  /** Why not, in words (when not ok). */
  why?: string
  /** Events since the last restart (what a restart seals). */
  liveEventCount: number
  brokenEventId?: string
  brokenReason?: string
  break?: ChainBreak
  /** Every point the chain splits, in append order (when ok): what the restart seals and its note explains. */
  splits?: ChainSplit[]
}

/**
 * Whether a chain (its events, in append order) may be restarted — pure. Only
 * a FORK is restarted (Nic answered about the forked chains, 10/13): never a
 * whole chain, never a chain holding an event whose contents no longer match
 * its hash (a restart would hide it), never one broken any other way as well
 * (an entry no branch reaches: the restart would explain only the fork), never
 * one broken anywhere but expectBrokenEventId when that is named.
 */
export function checkRestart(events: readonly ChainEventRow[], expectBrokenEventId?: string): RestartCheck {
  const segments = chainSegments(events)
  const live = segments[segments.length - 1]
  const v = walkChain(live)
  const base = { liveEventCount: live.length, brokenEventId: v.firstBadEventId, brokenReason: v.reason, break: v.break }
  if (v.ok) return { ...base, ok: false, why: 'the chain is whole: nothing to restart' }
  if (v.break !== 'fork') return { ...base, ok: false, why: `broken by ${v.break} (${v.reason}), not a fork: only a fork is restarted` }
  const altered = live.find((e) => !hashHolds(e))
  if (altered) return { ...base, ok: false, why: `event ${altered.id} no longer matches its hash: a restart would hide it` }
  const shape = traceChain(live)
  if (shape.unreached.length) {
    return { ...base, ok: false, why: `event ${shape.unreached[0].id} attaches to no entry of the chain, not a fork: only a fork is restarted` }
  }
  if (expectBrokenEventId && v.firstBadEventId !== expectBrokenEventId) {
    return { ...base, ok: false, why: `it breaks at ${v.firstBadEventId}, not ${expectBrokenEventId}` }
  }
  return { ...base, ok: true, splits: shape.splits }
}

export interface RestartChainInput {
  subjectId: string
  /** Why the chain is restarted, in words — recorded on the restart and hashed with it. */
  note: string
  /** Refused unless the chain's first broken event is this one. */
  expectBrokenEventId?: string
  /** Refused unless the chain splits exactly here — the splits a note was written from (10/13 review). */
  expectSplits?: readonly ChainSplit[]
  /** The restart's day (default now: "from today"). */
  occurredAt?: Date
  attestationEvidence?: Record<string, unknown>
}

export interface RestartChainResult extends AppendEventResult {
  sealedEventCount: number
  brokenEventId: string
  brokenReason: string
  /** Every point the sealed chain split, as sealed. */
  splits: ChainSplit[]
}

/**
 * Restart a forked chain from today (10/13, Nic: "restart the chain from today
 * for each, with a recorded note explaining the break (old entries
 * untouched)"). Appends one 'chain_restarted' event with no prev_hash — the
 * first event of the new chain; every later append links from it
 * (appendEvent's tip is the newest event) — whose hashed payload is the note
 * and the seal of the old chain: its event count, the hashes of its ends, the
 * event where it broke and why, and every point it split (the note, written
 * from the same splits, has to say all of them: hashed, it can never be
 * corrected). Nothing before it is edited, superseded or
 * deleted. Private to the subject, no score dimension, attested by GAM's own
 * records ('system_derived'), and never part of a credit history
 * (getSubjectChain).
 *
 * Under the subject's advisory lock (appendEvent's), in the caller's
 * transaction or our own. Throws when checkRestart refuses.
 */
export async function restartChain(
  input: RestartChainInput,
  existingClient: PoolClient | null = null,
): Promise<RestartChainResult> {
  const note = input.note.trim()
  if (!note) throw new Error('a chain restart needs a note explaining the break')
  const client = existingClient ?? (await getClient())
  const ownTransaction = !existingClient
  try {
    if (ownTransaction) await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `credit_subject:${input.subjectId}`,
    ])
    const events = await readChain(client, input.subjectId)
    const check = checkRestart(events, input.expectBrokenEventId)
    if (!check.ok) throw new Error(`credit chain ${input.subjectId} not restarted: ${check.why}`)
    if (input.expectSplits && canonicalJson(splitData(input.expectSplits)) !== canonicalJson(splitData(check.splits!))) {
      throw new Error(`credit chain ${input.subjectId} not restarted: it does not split where expected (the note would not match)`)
    }
    const segments = chainSegments(events)
    const data: RestartData = {
      note,
      sealed_event_count: check.liveEventCount,
      sealed_end_hashes: chainEnds(segments[segments.length - 1]),
      broken_event_id: check.brokenEventId!,
      broken_reason: check.brokenReason!,
      splits: splitData(check.splits!),
    }
    const written = await insertEvent(client, input.subjectId, null, {
      eventType: CHAIN_RESTART_EVENT,
      eventData: { ...data },
      occurredAt: input.occurredAt ?? new Date(),
      attestationSource: 'system_derived',
      attestationEvidence: input.attestationEvidence ?? {},
      dimensionTags: [],
      networkVisibility: 'private_to_subject',
    })
    if (ownTransaction) await client.query('COMMIT')
    return {
      ...written,
      sealedEventCount: check.liveEventCount,
      brokenEventId: check.brokenEventId!,
      brokenReason: check.brokenReason!,
      splits: check.splits!,
    }
  } catch (e) {
    if (ownTransaction) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (ownTransaction) client.release()
  }
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
 *
 * 10/12 (review): only a LIVE event is superseded. An event already
 * superseded keeps the link it has — overwriting it rewrote which mark
 * replaced it (a dispute resolved after the bill was re-judged turned a
 * 'bill_status_changed' link into a dispute correction and left the bill with
 * two live marks). Returns whether the event was superseded now; false: it
 * was not live (or does not exist) and nothing changed — the caller decides
 * whether that is an error.
 */
export async function supersedeEvent(
  client: PoolClient,
  originalEventId: string,
  correctedEventId: string,
  reason: CreditSupersedeReason,
): Promise<boolean> {
  const r = await client.query(
    `UPDATE credit_events
        SET superseded_by = $2,
            superseded_reason = $3
      WHERE id = $1 AND superseded_by IS NULL`,
    [originalEventId, correctedEventId, reason],
  )
  return (r.rowCount ?? 0) > 0
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
