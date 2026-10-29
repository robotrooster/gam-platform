import type { PoolClient } from 'pg'
import { query, getClient } from '../db'
import { getSubjectChain, CHAIN_RESTART_EVENT } from './creditLedger'

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

/**
 * 10/12 (Nic): "the payment history should be a health percentage. one mark
 * per invoice." The payment history is the BILL marks (services/creditBillMarks:
 * event_data.mark_basis 'invoice', one per household bill, rated by the
 * payment-health rule). A per-line mark written before 10/12 that the rebuild
 * has not replaced yet (scripts/oct12_rerate_late_marks) is not part of it:
 * it is only counted, as line_marks_not_replaced.
 */
const BILL_MARK_BASIS = 'invoice'
function isBillMark(e: ChainEvent): boolean {
  return PAYMENT_TIERS.has(e.event_type) && (e.event_data as { mark_basis?: unknown } | null)?.mark_basis === BILL_MARK_BASIS
}

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

  const bills = active.filter(isBillMark)
  const lineMarks = active.filter((e) => PAYMENT_TIERS.has(e.event_type) && !isBillMark(e))

  return {
    payment_stats: { ...paymentStats(bills, cutoff12mo, cutoff90d), line_marks_not_replaced: lineMarks.length },
    property_stats: dimensionRollup(active, 'property_care'),
    tenancy_stats: tenancyStats(active),
    community_stats: dimensionRollup(active, 'community_fit'),
    cooperation_stats: dimensionRollup(active, 'cooperation'),
    event_count: active.length,
  }
}

/** A bill mark's bill day (its due date), else when it happened: the windows and the streak run by bill. */
function billTime(e: ChainEvent): number {
  const due = (e.event_data as { due_date?: unknown } | null)?.due_date
  const t = typeof due === 'string' ? Date.parse(`${due.slice(0, 10)}T12:00:00Z`) : NaN
  return Number.isFinite(t) ? t : new Date(e.occurred_at).getTime()
}

/**
 * The payment-health figure from the bill marks (10/12, Nic): bills paid on
 * time ÷ bills judged, as a whole percent — every bill since the tenant's first
 * on GAM. The same rule and rounding as the Rent Roll's payment health
 * (services/householdMonths paymentHealth), counted per bill.
 */
export function billHealth(bills: readonly ChainEvent[]): {
  percent: number | null; on_time: number; counted: number; paid_late: number; partial: number
  outstanding: number; label: string
} {
  const counted = bills.length
  const onTime = bills.filter((e) => e.event_type === 'payment_received_on_time' || e.event_type === 'payment_received_late_grace').length
  const percent = counted ? Math.round((onTime / counted) * 100) : null
  return {
    percent,
    on_time: onTime,
    counted,
    paid_late: bills.filter((e) => e.event_type.startsWith('payment_received_late_') && e.event_type !== 'payment_received_late_grace').length,
    partial: bills.filter((e) => e.event_type === 'payment_partial').length,
    outstanding: bills.filter((e) => e.event_type === 'payment_skipped').length,
    label: percent === null ? 'No bills to judge yet'
      : `${percent}%, ${onTime} of ${counted} bill${counted === 1 ? '' : 's'} on time`,
  }
}

function paymentStats(
  bills: ChainEvent[],
  cutoff12mo: number,
  cutoff90d: number,
): Record<string, unknown> {
  const slice = (cutoffMs: number) => bills.filter((e) => billTime(e) >= cutoffMs)

  const buildSlice = (rows: ChainEvent[]) => {
    if (rows.length === 0) return { total_events: 0 }
    const counts: Record<string, number> = {}
    for (const r of rows) {
      counts[r.event_type] = (counts[r.event_type] ?? 0) + 1
    }
    const total = rows.length
    // A bill paid by its last grace day is on time (one rule: no "within
    // grace" tier on a bill); a per-line "within grace" mark never reaches here.
    const onTime = (counts['payment_received_on_time'] ?? 0) + (counts['payment_received_late_grace'] ?? 0)
    return {
      total_events: total,
      on_time_count: onTime,
      on_time_pct: pct(onTime, total),
      within_grace_count: onTime,
      within_grace_pct: pct(onTime, total),
      late_minor_count: counts['payment_received_late_minor'] ?? 0,
      late_major_count: counts['payment_received_late_major'] ?? 0,
      late_severe_count: counts['payment_received_late_severe'] ?? 0,
      partial_count: counts['payment_partial'] ?? 0,
      nsf_count: counts['payment_failed_nsf'] ?? 0,
      skipped_count: counts['payment_skipped'] ?? 0,
    }
  }

  const streak = computeOnTimeStreak(bills)

  return {
    basis: 'bill',
    health: billHealth(bills),
    lifetime: buildSlice(bills),
    rolling_12mo: buildSlice(slice(cutoff12mo)),
    rolling_90d: buildSlice(slice(cutoff90d)),
    longest_on_time_streak_count: streak.longest,
    current_on_time_streak_count: streak.current,
  }
}

/** Bills paid on time in a row, oldest bill first: the longest run, and the run up to the newest bill. */
function computeOnTimeStreak(bills: ChainEvent[]): {
  longest: number
  current: number
} {
  const sorted = [...bills].sort((a, b) => billTime(a) - billTime(b) || a.id.localeCompare(b.id))
  let longest = 0
  let current = 0
  for (const p of sorted) {
    if (p.event_type === 'payment_received_on_time' || p.event_type === 'payment_received_late_grace') {
      current += 1
      if (current > longest) longest = current
    } else {
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
  // 10/13: a chain restart is not history (getSubjectChain leaves it out):
  // a subject whose only live event is a restart has nothing to count.
  const subjects = await query<{ id: string }>(
    `SELECT DISTINCT s.id
       FROM credit_subjects s
       JOIN credit_events e ON e.subject_id = s.id
      WHERE e.superseded_by IS NULL
        AND e.event_type <> $1`,
    [CHAIN_RESTART_EVENT],
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
