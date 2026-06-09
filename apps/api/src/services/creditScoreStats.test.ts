/**
 * S429 services-audit slice 6: creditScore.ts + creditStats.ts (pure
 * functions).
 *
 * `computeScore` and `computeStats` are deterministic replays of a
 * subject's event chain. v1.0.0 formula is the locked production
 * formula per CLAUDE.md; pinning the pure functions now means a
 * future v1.1.0 lands cleanly.
 *
 * Covered (pure-function surface):
 *   - computeScore: positives, negatives, attestation_weight,
 *     spam_caps (year/month/lifetime), floor, dimension tags,
 *     superseded events skipped, deterministic sort
 *   - computeStats: payment buckets, time-window slices
 *     (lifetime/12mo/90d), on-time streaks, tenancy roll-up,
 *     dimension roll-up, superseded events skipped
 *
 * Deferred (DB-backed wrappers): recomputeAndSnapshot,
 * recomputeAllSubjects, getLatestScore (creditScore); refreshSubjectStats,
 * refreshAllSubjectStats, getLatestStats (creditStats).
 */

import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import { computeScore } from './creditScore'
import { computeStats } from './creditStats'

// ─── helpers ─────────────────────────────────────────────────

let _idCounter = 0
function nextId(): string {
  // Monotonic ULID-like ids so sort-by-id behavior is deterministic in tests.
  _idCounter++
  return `01HZZ${String(_idCounter).padStart(7, '0')}` + randomUUID().slice(0, 8)
}

function mkEvent(opts: {
  event_type: string
  recorded_at?: Date
  occurred_at?: Date
  attestation_source?: string
  dimension_tags?: string[]
  superseded_by?: string | null
  id?: string
}): any {
  return {
    id:                 opts.id ?? nextId(),
    event_type:         opts.event_type,
    event_data:         {},
    occurred_at:        opts.occurred_at ?? opts.recorded_at ?? new Date('2026-01-01'),
    recorded_at:        opts.recorded_at ?? new Date('2026-01-01'),
    attestation_source: opts.attestation_source ?? 'gam_system_witnessed',
    dimension_tags:     opts.dimension_tags ?? ['payment_reliability'],
    superseded_by:      opts.superseded_by ?? null,
  }
}

// Minimal definition mirroring the v1.0.0 shape — small subset of
// event types kept inline so the tests are self-contained.
const def = {
  model: 'unbounded_multiplicative_v1',
  starting_score: 0,
  floor: 0,
  positives: {
    payment_received_on_time: 100,
    payment_received_late_grace: 30,
    lease_signed: 50,
  },
  negatives: {
    payment_failed_nsf: 0.5,           // 50% of current score
    lease_terminated_early_by_tenant: 0.25,
  },
  attestation_weight: {
    gam_system_witnessed:                 1.0,
    landlord_documented:                  0.7,
    tenant_self_reported_with_doc_verified: 0.5,
    tenant_self_reported:                 0.0,
  },
  spam_caps: {
    payment_received_on_time: { per: 'month' as const, limit: 1 },
    lease_signed:             { per: 'year'  as const, limit: 2 },
  },
}

// ─── computeScore ───────────────────────────────────────────

describe('computeScore', () => {
  it('empty chain → starting_score (0), eventCount 0', () => {
    const r = computeScore({ events: [], definition: def, formulaVersion: 'v1.0.0' })
    expect(r.composite).toBe(0)
    expect(r.eventCount).toBe(0)
    expect(r.formulaVersion).toBe('v1.0.0')
  })

  it('single positive event → score += points × weight', () => {
    const r = computeScore({
      events: [mkEvent({ event_type: 'lease_signed' })],
      definition: def, formulaVersion: 'v1.0.0',
    })
    // 50 points × 1.0 weight = 50
    expect(r.composite).toBe(50)
    expect(r.eventCount).toBe(1)
  })

  it('attestation_weight scales positives (0.7 weight → 70% of points)', () => {
    const r = computeScore({
      events: [mkEvent({
        event_type: 'lease_signed', attestation_source: 'landlord_documented',
      })],
      definition: def, formulaVersion: 'v1.0.0',
    })
    expect(r.composite).toBe(35)  // 50 × 0.7
  })

  it('zero attestation_weight (tenant_self_reported) → event skipped', () => {
    const r = computeScore({
      events: [mkEvent({
        event_type: 'lease_signed', attestation_source: 'tenant_self_reported',
      })],
      definition: def, formulaVersion: 'v1.0.0',
    })
    expect(r.composite).toBe(0)
    expect(r.eventCount).toBe(1)  // still counted in eventCount
  })

  it('negative event applies as percentage of current score', () => {
    const events = [
      mkEvent({ event_type: 'lease_signed', recorded_at: new Date('2026-01-01') }),
      // Score = 50 after lease_signed.
      mkEvent({ event_type: 'payment_failed_nsf', recorded_at: new Date('2026-01-02') }),
      // payment_failed_nsf = 50% × weight 1.0 = 25 drop → score = 25.
    ]
    const r = computeScore({ events, definition: def, formulaVersion: 'v1.0.0' })
    expect(r.composite).toBe(25)
  })

  it('floor caps score from going below 0', () => {
    const events = [
      mkEvent({ event_type: 'lease_signed', recorded_at: new Date('2026-01-01') }),
      // Two consecutive 50% drops on score=50 → 25 → 12.5
      mkEvent({ event_type: 'payment_failed_nsf', recorded_at: new Date('2026-01-02') }),
      mkEvent({ event_type: 'payment_failed_nsf', recorded_at: new Date('2026-01-03') }),
      // Force a deep drop scenario by stacking negatives; score should
      // still floor at 0, not go negative.
    ]
    const r = computeScore({ events, definition: def, formulaVersion: 'v1.0.0' })
    expect(r.composite).toBeGreaterThanOrEqual(0)
  })

  it('superseded event is skipped (not in score, not in eventCount)', () => {
    const supersedingId = nextId()
    const events = [
      mkEvent({
        event_type: 'lease_signed',
        recorded_at: new Date('2026-01-01'),
        superseded_by: supersedingId,
      }),
      mkEvent({
        id: supersedingId,
        event_type: 'lease_signed',
        recorded_at: new Date('2026-01-02'),
      }),
    ]
    const r = computeScore({ events, definition: def, formulaVersion: 'v1.0.0' })
    expect(r.composite).toBe(50)        // only the superseding event counts
    expect(r.eventCount).toBe(1)
  })

  it('spam_caps: monthly cap limits repeated positives within same month', () => {
    const events = [
      mkEvent({ event_type: 'payment_received_on_time',
                recorded_at: new Date('2026-03-01') }),
      mkEvent({ event_type: 'payment_received_on_time',
                recorded_at: new Date('2026-03-15') }),
      mkEvent({ event_type: 'payment_received_on_time',
                recorded_at: new Date('2026-03-30') }),
    ]
    const r = computeScore({ events, definition: def, formulaVersion: 'v1.0.0' })
    // Cap = 1/month, so only the FIRST event scores. 100 × 1.0 = 100.
    expect(r.composite).toBe(100)
    // eventCount counts all non-superseded events, regardless of cap.
    expect(r.eventCount).toBe(3)
  })

  it('spam_caps: year cap on lease_signed (limit 2)', () => {
    const events = [
      mkEvent({ event_type: 'lease_signed', recorded_at: new Date('2026-01-01') }),
      mkEvent({ event_type: 'lease_signed', recorded_at: new Date('2026-06-01') }),
      mkEvent({ event_type: 'lease_signed', recorded_at: new Date('2026-12-01') }),
    ]
    const r = computeScore({ events, definition: def, formulaVersion: 'v1.0.0' })
    expect(r.composite).toBe(100)  // 2 × 50, third capped
  })

  it('spam_caps reset across windows (Jan + Feb each get 1 of payment_on_time)', () => {
    const events = [
      mkEvent({ event_type: 'payment_received_on_time',
                recorded_at: new Date('2026-01-15') }),
      mkEvent({ event_type: 'payment_received_on_time',
                recorded_at: new Date('2026-02-15') }),
    ]
    const r = computeScore({ events, definition: def, formulaVersion: 'v1.0.0' })
    expect(r.composite).toBe(200)  // both fire — different months
  })

  it('dimension tags accumulate per-dimension scores', () => {
    const events = [
      mkEvent({
        event_type: 'lease_signed',
        dimension_tags: ['tenancy_stability', 'cooperation'],
      }),
    ]
    const r = computeScore({ events, definition: def, formulaVersion: 'v1.0.0' })
    // 50 points spread to BOTH dimensions (per-tag accumulation).
    expect(r.dimensionScores.tenancy_stability).toBe(50)
    expect(r.dimensionScores.cooperation).toBe(50)
  })

  it('deterministic: events out of recorded_at order are sorted before replay', () => {
    const events = [
      // Out-of-order on input.
      mkEvent({
        event_type: 'payment_failed_nsf', recorded_at: new Date('2026-02-01'),
      }),
      mkEvent({
        event_type: 'lease_signed', recorded_at: new Date('2026-01-01'),
      }),
    ]
    // Expected: lease_signed first (50), then NSF (-25) → 25.
    const r = computeScore({ events, definition: def, formulaVersion: 'v1.0.0' })
    expect(r.composite).toBe(25)
  })
})

// ─── computeStats ───────────────────────────────────────────

describe('computeStats', () => {
  it('empty chain → all-zeros stats', () => {
    const r = computeStats([])
    expect(r.event_count).toBe(0)
    expect((r.payment_stats as any).lifetime.total_events).toBe(0)
    expect((r.payment_stats as any).rolling_12mo.total_events).toBe(0)
  })

  it('payment events bucketed by tier in lifetime slice', () => {
    const events = [
      mkEvent({ event_type: 'payment_received_on_time',     occurred_at: new Date('2026-01-01') }),
      mkEvent({ event_type: 'payment_received_on_time',     occurred_at: new Date('2026-02-01') }),
      mkEvent({ event_type: 'payment_received_late_grace',  occurred_at: new Date('2026-03-01') }),
      mkEvent({ event_type: 'payment_failed_nsf',           occurred_at: new Date('2026-04-01') }),
    ]
    const r = computeStats(events) as any
    expect(r.payment_stats.lifetime.total_events).toBe(4)
    expect(r.payment_stats.lifetime.on_time_count).toBe(2)
    expect(r.payment_stats.lifetime.within_grace_count).toBe(3)  // on_time + grace
    expect(r.payment_stats.lifetime.nsf_count).toBe(1)
    expect(r.payment_stats.lifetime.on_time_pct).toBe(50)
    expect(r.payment_stats.lifetime.within_grace_pct).toBe(75)
  })

  it('rolling_90d window excludes events older than 90 days', () => {
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
    const events = [
      mkEvent({ event_type: 'payment_received_on_time', occurred_at: recent }),
      mkEvent({ event_type: 'payment_received_on_time', occurred_at: old }),
    ]
    const r = computeStats(events) as any
    expect(r.payment_stats.lifetime.total_events).toBe(2)
    expect(r.payment_stats.rolling_90d.total_events).toBe(1)
  })

  it('on-time streak: counts consecutive on_time + grace, resets on miss', () => {
    const events = [
      mkEvent({ event_type: 'payment_received_on_time',     occurred_at: new Date('2026-01-01') }),
      mkEvent({ event_type: 'payment_received_on_time',     occurred_at: new Date('2026-02-01') }),
      mkEvent({ event_type: 'payment_received_late_grace',  occurred_at: new Date('2026-03-01') }),
      mkEvent({ event_type: 'payment_failed_nsf',           occurred_at: new Date('2026-04-01') }),
      mkEvent({ event_type: 'payment_received_on_time',     occurred_at: new Date('2026-05-01') }),
    ]
    const r = computeStats(events) as any
    expect(r.payment_stats.longest_on_time_streak_count).toBe(3)
    expect(r.payment_stats.current_on_time_streak_count).toBe(1)
  })

  it('tenancy events rolled up by type', () => {
    const events = [
      mkEvent({ event_type: 'lease_signed', occurred_at: new Date('2026-01-01') }),
      mkEvent({ event_type: 'lease_renewed', occurred_at: new Date('2027-01-01') }),
      mkEvent({ event_type: 'lease_terminated_natural', occurred_at: new Date('2028-01-01') }),
    ]
    const r = computeStats(events) as any
    expect(r.tenancy_stats.lease_signed).toBe(1)
    expect(r.tenancy_stats.lease_renewed).toBe(1)
    expect(r.tenancy_stats.lease_terminated_natural).toBe(1)
  })

  it('dimension rollup counts by event_type within dimension tag', () => {
    const events = [
      mkEvent({
        event_type: 'inspection_passed',
        dimension_tags: ['property_care'],
      }),
      mkEvent({
        event_type: 'inspection_passed',
        dimension_tags: ['property_care'],
      }),
      mkEvent({
        event_type: 'inspection_minor_issues',
        dimension_tags: ['property_care'],
      }),
      // Not tagged property_care → not counted in the rollup.
      mkEvent({
        event_type: 'inspection_passed',
        dimension_tags: ['cooperation'],
      }),
    ]
    const r = computeStats(events) as any
    expect(r.property_stats.total_events).toBe(3)
    expect(r.property_stats.event_counts.inspection_passed).toBe(2)
    expect(r.property_stats.event_counts.inspection_minor_issues).toBe(1)
  })

  it('superseded events excluded from all slices and counts', () => {
    const supersedingId = nextId()
    const events = [
      mkEvent({
        event_type: 'payment_received_on_time',
        occurred_at: new Date('2026-01-01'),
        superseded_by: supersedingId,
      }),
      mkEvent({
        id: supersedingId,
        event_type: 'payment_failed_nsf',
        occurred_at: new Date('2026-01-02'),
      }),
    ]
    const r = computeStats(events) as any
    expect(r.event_count).toBe(1)
    expect(r.payment_stats.lifetime.on_time_count).toBe(0)
    expect(r.payment_stats.lifetime.nsf_count).toBe(1)
  })

  it('pct computation handles zero denominator (no payments → 0)', () => {
    const r = computeStats([
      mkEvent({ event_type: 'lease_signed' }),  // not in PAYMENT_TIERS
    ]) as any
    expect(r.payment_stats.lifetime.total_events).toBe(0)
    // No on_time_pct key when total_events is 0 (returns `{total_events: 0}` only).
    expect(r.payment_stats.lifetime.on_time_pct).toBeUndefined()
  })
})
