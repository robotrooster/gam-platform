// Lightweight in-memory request-latency tracker. Powers the super-admin
// "Scaling Readiness" panel's p95 API-latency tracker — no external deps, just a
// ring buffer of the most recent request durations.
//
// ── S605: why this got stricter ───────────────────────────────────────────
// Nic watched the tracker swing between 25 ms and 465 ms, flipping the verdict
// between OK and "Move" (migrate Postgres) on noise. Three causes, none of them
// the API actually being slow:
//
//   1. NO MINIMUM SAMPLE. p95 of 17 samples is `sorted[16]` — literally the
//      slowest request. One slow call pinned the tracker red. The buffer is
//      in-memory and empties on every API restart, so after a deploy the metric
//      is decided by a handful of requests.
//   2. EXTERNALLY-BOUND ROUTES WERE COUNTED. The tracker exists to answer "is
//      the Mac struggling — is it time to move Postgres". A route that spends
//      2s waiting on Stripe or a self-hosted LLM says nothing about that, but
//      it dominates p95.
//   3. Worst offender was self-inflicted: /api/admin/platform-health fans out
//      to FOUR vendor APIs with 6s timeouts and is polled by the admin page.
//      The health panel was pushing the latency panel into the red beside it.
//
// So: measure only what this metric is FOR — our own app + database latency.

const WINDOW = 1000

/**
 * Below this many samples the p95 is one outlier wearing a trenchcoat.
 * Report "warming up" rather than a verdict — a red "Move" that means
 * "we restarted 20 requests ago" trains you to ignore the panel.
 */
export const MIN_SAMPLES = 200

/**
 * Routes whose duration is dominated by a third party we do not control.
 * Including them measures Stripe/Resend/Cloudflare/our LLM, not the Mac.
 */
const EXCLUDED_PREFIXES = [
  '/api/admin/platform-health', // fans out to 4 vendor APIs (6s timeouts each)
  '/api/agent',                 // self-hosted LLM inference — seconds by design
  '/api/sales',                 // ditto (Lucy) + booking calls out to Jitsi
  '/api/guest',                 // ditto (guest agent)
  '/api/background',            // Checkr round-trips
  '/webhooks',                  // inbound provider traffic, not user-facing latency
]

const durations: number[] = []
let writeIdx = 0
let totalSeen = 0

export function isExcludedFromLatency(path: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => path.startsWith(p))
}

export function recordLatency(ms: number, path?: string): void {
  if (path && isExcludedFromLatency(path)) return
  durations[writeIdx % WINDOW] = ms
  writeIdx++
  totalSeen++
}

/** p95 of the window, or null when there isn't enough signal to judge. */
export function latencyP95(): number | null {
  if (durations.length < MIN_SAMPLES) return null
  const sorted = [...durations].sort((a, b) => a - b)
  const i = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)
  return sorted[i]
}

// How many requests are in the current window (for "over the last N requests").
export function sampleSize(): number {
  return Math.min(totalSeen, WINDOW)
}

/** Exposed for tests. */
export function __resetLatencyForTests(): void {
  durations.length = 0
  writeIdx = 0
  totalSeen = 0
}
