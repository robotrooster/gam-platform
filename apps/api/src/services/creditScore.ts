import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { computeMerkleRoot, getSubjectChain } from './creditLedger'
import type { CreditScoreDimension } from '@gam/shared'

// ============================================================
// Credit score service — Session B.
//
// Replays a subject's event chain against a versioned formula and
// produces the unbounded multiplicative score per the locked design:
//   - starts at 0, floor at 0, no ceiling
//   - positives = flat point additions (× attestation_weight)
//   - negatives = percentage-of-current-score (× attestation_weight)
//   - no decay; events apply in chronological (recorded_at) order
//   - superseded events are skipped
//   - spam_caps cap how many of a given event type score per
//     window (year / month / lifetime)
//
// Replay is deterministic: same chain + same formula → same score.
// That property is what makes dispute correction tractable —
// supersede an event, recompute, snapshot the new score.
//
// computeScore() is a pure function over (events, formula).
// recomputeAndSnapshot() persists a credit_scores row tied to the
// current Merkle root.
// ============================================================

interface FormulaSpamCap {
  per: 'year' | 'month' | 'lifetime'
  limit: number
}

interface FormulaDefinition {
  model: string
  starting_score: number
  floor: number
  positives: Record<string, number>
  negatives: Record<string, number>
  attestation_weight: Record<string, number>
  spam_caps: Record<string, FormulaSpamCap>
}

export interface ComputedScore {
  composite: number
  dimensionScores: Record<CreditScoreDimension, number>
  eventCount: number
  formulaVersion: string
}

interface ChainEvent {
  id: string
  event_type: string
  event_data: Record<string, unknown>
  occurred_at: Date
  recorded_at: Date
  attestation_source: string
  dimension_tags: string[]
  superseded_by: string | null
}

/**
 * Load the formula definition for a version. Throws if not found.
 */
export async function loadFormula(version: string): Promise<{
  version: string
  definition: FormulaDefinition
}> {
  const row = await queryOne<{ version: string; definition: FormulaDefinition }>(
    `SELECT version, definition FROM credit_score_formulas WHERE version = $1`,
    [version],
  )
  if (!row) throw new Error(`Credit formula version ${version} not found`)
  return row
}

/**
 * Find the currently-effective formula. Picks the row whose
 * effective_from <= NOW() and (effective_to IS NULL OR effective_to > NOW()),
 * preferring most recent effective_from when multiple match.
 *
 * v1 has only v1.0.0 published; this is forward-looking for when v1.1
 * etc. arrive.
 */
export async function loadCurrentFormula(): Promise<{
  version: string
  definition: FormulaDefinition
}> {
  const row = await queryOne<{ version: string; definition: FormulaDefinition }>(
    `SELECT version, definition
       FROM credit_score_formulas
      WHERE effective_from <= NOW()
        AND (effective_to IS NULL OR effective_to > NOW())
      ORDER BY effective_from DESC
      LIMIT 1`,
  )
  if (!row) throw new Error('No effective credit formula')
  return row
}

/**
 * Pure replay: walk events in chain order, applying positives and
 * negatives. Skips superseded events. Applies attestation_weight as a
 * scalar against both positive points and the percentage of negatives
 * (so a 0.5-weight tenant_self_reported_with_doc_verified event hits
 * half as hard in either direction; a 0× tenant_self_reported event
 * has no effect).
 *
 * Spam caps are enforced by counting occurrences of capped event types
 * within the per-window, in chain order — the first N hit; any beyond
 * the cap are no-ops.
 */
export function computeScore(args: {
  events: ChainEvent[]
  definition: FormulaDefinition
  formulaVersion: string
}): ComputedScore {
  const { events, definition, formulaVersion } = args

  // Sort events deterministically by recorded_at, then id (ULID-like
  // ordering for ties). Caller usually passes them already sorted but
  // we don't trust that here.
  const sorted = [...events].sort((a, b) => {
    const t = a.recorded_at.getTime() - b.recorded_at.getTime()
    if (t !== 0) return t
    return a.id.localeCompare(b.id)
  })

  let score = definition.starting_score
  const dimSums: Record<string, number> = {}

  // Spam-cap counters per (event_type, window-key).
  const spamCounts: Map<string, number> = new Map()

  for (const ev of sorted) {
    if (ev.superseded_by) continue
    const weight = definition.attestation_weight[ev.attestation_source] ?? 0
    if (weight === 0) continue

    const cap = definition.spam_caps[ev.event_type]
    if (cap) {
      const windowKey = spamWindowKey(cap, ev.recorded_at)
      const key = `${ev.event_type}:${windowKey}`
      const used = spamCounts.get(key) ?? 0
      if (used >= cap.limit) continue
      spamCounts.set(key, used + 1)
    }

    const positivePoints = definition.positives[ev.event_type] ?? 0
    if (positivePoints !== 0) {
      const delta = positivePoints * weight
      score += delta
      for (const tag of ev.dimension_tags) {
        dimSums[tag] = (dimSums[tag] ?? 0) + delta
      }
    }

    const negativePct = definition.negatives[ev.event_type] ?? 0
    if (negativePct !== 0) {
      const effectivePct = negativePct * weight
      const dropAmount = score * effectivePct
      score -= dropAmount
      for (const tag of ev.dimension_tags) {
        dimSums[tag] = (dimSums[tag] ?? 0) - dropAmount
      }
    }

    if (score < definition.floor) score = definition.floor
  }

  return {
    composite: round2(score),
    dimensionScores: roundDims(dimSums),
    eventCount: sorted.filter((e) => !e.superseded_by).length,
    formulaVersion,
  }
}

function spamWindowKey(cap: FormulaSpamCap, when: Date): string {
  if (cap.per === 'lifetime') return 'lifetime'
  if (cap.per === 'year') return `${when.getUTCFullYear()}`
  if (cap.per === 'month') return `${when.getUTCFullYear()}-${when.getUTCMonth() + 1}`
  return 'lifetime'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function roundDims(d: Record<string, number>): Record<CreditScoreDimension, number> {
  const out: Record<string, number> = {}
  for (const k of Object.keys(d)) out[k] = round2(d[k])
  return out as Record<CreditScoreDimension, number>
}

/**
 * Recompute a subject's score from its full event chain and persist
 * a credit_scores row tied to the current Merkle root. Returns the
 * computed score. Does NOT update prior rows — append-only history.
 */
export async function recomputeAndSnapshot(
  subjectId: string,
  client?: PoolClient,
): Promise<ComputedScore & { snapshotId: string }> {
  const formula = await loadCurrentFormula()
  const events = (await getSubjectChain(subjectId)) as unknown as ChainEvent[]
  const computed = computeScore({
    events,
    definition: formula.definition,
    formulaVersion: formula.version,
  })

  const merkle = await computeMerkleRoot()

  const ownClient = !client
  const c = client ?? (await getClient())
  try {
    const dimensionScoresJson: Record<string, number> = {}
    for (const dim of [
      'payment_reliability',
      'property_care',
      'tenancy_stability',
      'community_fit',
      'cooperation',
    ] as CreditScoreDimension[]) {
      dimensionScoresJson[dim] = computed.dimensionScores[dim] ?? 0
    }

    const inserted = await c.query<{ id: string }>(
      `INSERT INTO credit_scores (
         subject_id, composite_score, confidence_low, confidence_high,
         dimension_scores, event_count, formula_version,
         disclosure_scope, ledger_merkle_root
       ) VALUES ($1, $2, $2, $2, $3, $4, $5, 'gam_internal_only', $6)
       RETURNING id`,
      [
        subjectId,
        computed.composite,
        JSON.stringify(dimensionScoresJson),
        computed.eventCount,
        computed.formulaVersion,
        merkle.root,
      ],
    )
    return { ...computed, snapshotId: inserted.rows[0].id }
  } finally {
    if (ownClient) c.release()
  }
}

/**
 * Recompute scores for every subject that has any non-superseded
 * events. Used by the nightly cron. Failure-isolates per subject.
 */
export async function recomputeAllSubjects(): Promise<{
  processed: number
  errors: { subjectId: string; error: string }[]
}> {
  const subjects = await query<{ id: string }>(
    `SELECT DISTINCT s.id
       FROM credit_subjects s
       JOIN credit_events e ON e.subject_id = s.id
      WHERE e.superseded_by IS NULL`,
  )

  const errors: { subjectId: string; error: string }[] = []
  for (const row of subjects) {
    try {
      await recomputeAndSnapshot(row.id)
    } catch (e) {
      errors.push({
        subjectId: row.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return { processed: subjects.length, errors }
}

/**
 * Latest persisted score for a subject. Returns null if never computed.
 */
export async function getLatestScore(subjectId: string): Promise<{
  composite: number
  dimensionScores: Record<string, number>
  eventCount: number
  formulaVersion: string
  computedAt: Date
} | null> {
  const row = await queryOne<{
    composite_score: string
    dimension_scores: Record<string, number>
    event_count: number
    formula_version: string
    computed_at: Date
  }>(
    `SELECT composite_score, dimension_scores, event_count, formula_version, computed_at
       FROM credit_scores
      WHERE subject_id = $1
      ORDER BY computed_at DESC
      LIMIT 1`,
    [subjectId],
  )
  if (!row) return null
  return {
    composite: parseFloat(row.composite_score),
    dimensionScores: row.dimension_scores,
    eventCount: row.event_count,
    formulaVersion: row.formula_version,
    computedAt: new Date(row.computed_at),
  }
}
