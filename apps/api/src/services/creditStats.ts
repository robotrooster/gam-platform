import type { PoolClient } from 'pg'
import { query, getClient } from '../db'
import { getSubjectChain } from './creditLedger'

// ============================================================
// Credit stats service — Session B.
//
// Derives the disclosable stats panel from the event chain. Per-subject
// rollup with lifetime / rolling-12mo / rolling-90d slices.
//
// v1 generates the panel; the API endpoint serves it visibility-gated.
// v2+ enables tenant-controlled external disclosure of the panel
// (without exposing the score itself).
//
// Pure-derived: stats are recomputable from events at any time. The
// credit_stats row is just a cache. Refreshing is idempotent.
// ============================================================

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

const PAYMENT_TIERS = new Set([
  'payment_received_on_time',
  'payment_received_late_grace',
  'payment_received_late_minor',
  'payment_received_late_major',
  'payment_received_late_severe',
  'payment_partial',
  'payment_failed_nsf',
  'payment_skipped',
])

export interface SubjectStats {
  payment_stats: Record<string, unknown>
  property_stats: Record<string, unknown>
  tenancy_stats: Record<string, unknown>
  community_stats: Record<string, unknown>
  cooperation_stats: Record<string, unknown>
  event_count: number
}

export function computeStats(events: ChainEvent[]): SubjectStats {
  const active = events.filter((e) => !e.superseded_by)
  const now = Date.now()
  const day = 24 * 3600 * 1000
  const cutoff12mo = now - 365 * day
  const cutoff90d = now - 90 * day

  const inPaymentSet = active.filter((e) => PAYMENT_TIERS.has(e.event_type))

  return {
    payment_stats: paymentStats(inPaymentSet, cutoff12mo, cutoff90d),
    property_stats: dimensionRollup(active, 'property_care'),
    tenancy_stats: tenancyStats(active),
    community_stats: dimensionRollup(active, 'community_fit'),
    cooperation_stats: dimensionRollup(active, 'cooperation'),
    event_count: active.length,
  }
}

function paymentStats(
  payments: ChainEvent[],
  cutoff12mo: number,
  cutoff90d: number,
): Record<string, unknown> {
  const slice = (cutoffMs: number) =>
    payments.filter((e) => new Date(e.occurred_at).getTime() >= cutoffMs)

  const all = payments
  const r12 = slice(cutoff12mo)
  const r90 = slice(cutoff90d)

  const buildSlice = (rows: ChainEvent[]) => {
    if (rows.length === 0) return { total_events: 0 }
    const counts: Record<string, number> = {}
    for (const r of rows) {
      counts[r.event_type] = (counts[r.event_type] ?? 0) + 1
    }
    const total = rows.length
    const onTime = counts['payment_received_on_time'] ?? 0
    const grace = counts['payment_received_late_grace'] ?? 0
    return {
      total_events: total,
      on_time_count: onTime,
      on_time_pct: pct(onTime, total),
      within_grace_count: onTime + grace,
      within_grace_pct: pct(onTime + grace, total),
      late_minor_count: counts['payment_received_late_minor'] ?? 0,
      late_major_count: counts['payment_received_late_major'] ?? 0,
      late_severe_count: counts['payment_received_late_severe'] ?? 0,
      partial_count: counts['payment_partial'] ?? 0,
      nsf_count: counts['payment_failed_nsf'] ?? 0,
      skipped_count: counts['payment_skipped'] ?? 0,
    }
  }

  const streak = computeOnTimeStreak(payments)

  return {
    lifetime: buildSlice(all),
    rolling_12mo: buildSlice(r12),
    rolling_90d: buildSlice(r90),
    longest_on_time_streak_count: streak.longest,
    current_on_time_streak_count: streak.current,
  }
}

function computeOnTimeStreak(payments: ChainEvent[]): {
  longest: number
  current: number
} {
  const sorted = [...payments].sort(
    (a, b) =>
      new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
  )
  let longest = 0
  let current = 0
  let runningCurrent = 0
  for (const p of sorted) {
    if (
      p.event_type === 'payment_received_on_time' ||
      p.event_type === 'payment_received_late_grace'
    ) {
      runningCurrent += 1
      if (runningCurrent > longest) longest = runningCurrent
      current = runningCurrent
    } else {
      runningCurrent = 0
      current = 0
    }
  }
  return { longest, current }
}

function tenancyStats(active: ChainEvent[]): Record<string, unknown> {
  const counts: Record<string, number> = {}
  for (const e of active) {
    if (
      e.event_type === 'lease_signed' ||
      e.event_type === 'lease_renewed' ||
      e.event_type === 'lease_terminated_natural' ||
      e.event_type === 'lease_terminated_early_by_tenant' ||
      e.event_type === 'lease_terminated_early_by_landlord' ||
      e.event_type === 'lease_abandoned' ||
      e.event_type === 'lease_anniversary'
    ) {
      counts[e.event_type] = (counts[e.event_type] ?? 0) + 1
    }
  }
  return counts
}

function dimensionRollup(
  active: ChainEvent[],
  dimension: string,
): Record<string, unknown> {
  const tagged = active.filter((e) => e.dimension_tags.includes(dimension))
  const counts: Record<string, number> = {}
  for (const e of tagged) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1
  }
  return { total_events: tagged.length, event_counts: counts }
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 10000) / 100
}

/**
 * Recompute stats for one subject and upsert credit_stats row.
 */
export async function refreshSubjectStats(
  subjectId: string,
  client?: PoolClient,
): Promise<SubjectStats> {
  const events = (await getSubjectChain(subjectId)) as unknown as ChainEvent[]
  const stats = computeStats(events)

  const ownClient = !client
  const c = client ?? (await getClient())
  try {
    await c.query(
      `INSERT INTO credit_stats (
         subject_id, payment_stats, property_stats, tenancy_stats,
         community_stats, cooperation_stats, computed_at,
         ledger_event_count_at_computation
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       ON CONFLICT (subject_id) DO UPDATE
         SET payment_stats     = EXCLUDED.payment_stats,
             property_stats    = EXCLUDED.property_stats,
             tenancy_stats     = EXCLUDED.tenancy_stats,
             community_stats   = EXCLUDED.community_stats,
             cooperation_stats = EXCLUDED.cooperation_stats,
             computed_at       = NOW(),
             ledger_event_count_at_computation = EXCLUDED.ledger_event_count_at_computation`,
      [
        subjectId,
        JSON.stringify(stats.payment_stats),
        JSON.stringify(stats.property_stats),
        JSON.stringify(stats.tenancy_stats),
        JSON.stringify(stats.community_stats),
        JSON.stringify(stats.cooperation_stats),
        stats.event_count,
      ],
    )
  } finally {
    if (ownClient) c.release()
  }

  return stats
}

export async function refreshAllSubjectStats(): Promise<{
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
      await refreshSubjectStats(row.id)
    } catch (e) {
      errors.push({
        subjectId: row.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return { processed: subjects.length, errors }
}

export async function getLatestStats(subjectId: string): Promise<SubjectStats | null> {
  const row = await query<{
    payment_stats: Record<string, unknown>
    property_stats: Record<string, unknown>
    tenancy_stats: Record<string, unknown>
    community_stats: Record<string, unknown>
    cooperation_stats: Record<string, unknown>
    ledger_event_count_at_computation: string
  }>(
    `SELECT payment_stats, property_stats, tenancy_stats,
            community_stats, cooperation_stats,
            ledger_event_count_at_computation
       FROM credit_stats
      WHERE subject_id = $1`,
    [subjectId],
  )
  if (row.length === 0) return null
  const r = row[0]
  return {
    payment_stats: r.payment_stats,
    property_stats: r.property_stats,
    tenancy_stats: r.tenancy_stats,
    community_stats: r.community_stats,
    cooperation_stats: r.cooperation_stats,
    event_count: parseInt(r.ledger_event_count_at_computation, 10),
  }
}
