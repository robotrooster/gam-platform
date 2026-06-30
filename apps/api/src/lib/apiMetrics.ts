// Lightweight in-memory request-latency tracker. Powers the super-admin
// "Scaling Readiness" panel's p95 API-latency tracker — no external deps, just a
// ring buffer of the most recent request durations.

const WINDOW = 1000
const durations: number[] = []
let writeIdx = 0
let totalSeen = 0

export function recordLatency(ms: number): void {
  durations[writeIdx % WINDOW] = ms
  writeIdx++
  totalSeen++
}

export function latencyP95(): number | null {
  if (durations.length === 0) return null
  const sorted = [...durations].sort((a, b) => a - b)
  const i = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)
  return sorted[i]
}

// How many requests are in the current window (for "over the last N requests").
export function sampleSize(): number {
  return Math.min(totalSeen, WINDOW)
}
