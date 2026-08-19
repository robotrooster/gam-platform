/**
 * S605: the Scaling Readiness p95 tracker swung 25ms↔465ms and flipped the
 * panel to "Move" (migrate Postgres) on noise. These lock in the two fixes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordLatency, latencyP95, sampleSize, isExcludedFromLatency,
  MIN_SAMPLES, __resetLatencyForTests,
} from './apiMetrics'

beforeEach(() => __resetLatencyForTests())

describe('minimum sample size', () => {
  it('reports nothing until there is enough signal to judge', () => {
    for (let i = 0; i < MIN_SAMPLES - 1; i++) recordLatency(20, '/api/units')
    expect(latencyP95()).toBeNull()
    expect(sampleSize()).toBe(MIN_SAMPLES - 1)
  })

  it('starts reporting once the window is populated', () => {
    for (let i = 0; i < MIN_SAMPLES; i++) recordLatency(20, '/api/units')
    expect(latencyP95()).toBe(20)
  })

  it('one slow request can no longer define the verdict', () => {
    // The old bug: with a handful of samples, p95 === the slowest request, so a
    // single 3s call read as "the API is at 3000ms, migrate the database".
    recordLatency(3000, '/api/units')
    for (let i = 0; i < 5; i++) recordLatency(20, '/api/units')
    expect(latencyP95()).toBeNull()          // not enough data — no verdict

    for (let i = 0; i < MIN_SAMPLES; i++) recordLatency(20, '/api/units')
    // Now properly diluted: one outlier in 200+ fast requests is not the p95.
    expect(latencyP95()).toBe(20)
  })
})

describe('externally-bound route exclusion', () => {
  it('excludes routes whose latency belongs to a third party', () => {
    for (const p of [
      '/api/admin/platform-health',   // fans out to 4 vendor APIs
      '/api/agent/chat',              // self-hosted LLM inference
      '/api/sales/demo/slots',
      '/api/guest/chat',
      '/api/background/check',        // Checkr
      '/webhooks/stripe',
    ]) {
      expect(isExcludedFromLatency(p), p).toBe(true)
    }
  })

  it('still measures ordinary app routes', () => {
    for (const p of ['/api/units', '/api/leases', '/api/admin/overview', '/api/payments']) {
      expect(isExcludedFromLatency(p), p).toBe(false)
    }
  })

  it('a slow vendor call does not enter the window at all', () => {
    for (let i = 0; i < MIN_SAMPLES; i++) recordLatency(20, '/api/units')
    const before = sampleSize()
    recordLatency(6000, '/api/admin/platform-health')
    expect(sampleSize()).toBe(before)   // not recorded
    expect(latencyP95()).toBe(20)       // and it did not move the number
  })
})
