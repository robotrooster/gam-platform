/**
 * Turn-admission gate — bounded concurrency + queue + graceful shedding
 * (Step: scale P2).
 *
 * Today there is NO global limit: every inbound chat turn immediately fires
 * model calls, so a 1st-of-month spike floods the worker fleet past its
 * batch and every conversation times out at once — a thundering-herd
 * collapse that also starves the shared pg pool. This gate admits whole
 * TURNS (one turn fires up to ~9 sequential model calls, so admitting raw
 * calls would mid-turn-starve): up to `maxConcurrency` run at once; beyond
 * that, up to `queueMax` wait briefly; anything past that is SHED, so the
 * crest degrades to queue-then-shed instead of a total outage.
 *
 * Sizing is env-driven so the dev team tunes it to the fleet they
 * provisioned with no redeploy. A Redis-backed counter can replace the
 * in-process count later (for a global limit across API replicas) behind
 * this same acquire()/release() seam.
 */

export interface TurnGateConfig {
  maxConcurrency: number
  queueMax: number
  queueWaitMs: number
}

function envInt(name: string, def: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def
}

export function getTurnGateConfig(): TurnGateConfig {
  return {
    // Default high enough to be transparent in dev; infra lowers/raises to
    // (worker count × safe concurrent streams per worker).
    maxConcurrency: envInt('AGENT_MAX_CONCURRENCY', 16),
    queueMax: envInt('AGENT_QUEUE_MAX', 200),
    queueWaitMs: envInt('AGENT_QUEUE_WAIT_MS', 10_000),
  }
}

/** A release function returned on admission; null means the turn was shed. */
export type TurnSlot = (() => void) | null

interface Waiter {
  resolve: (slot: TurnSlot) => void
  timer: ReturnType<typeof setTimeout>
}

export class TurnGate {
  private inFlight = 0
  private readonly queue: Waiter[] = []

  constructor(private readonly cfg: TurnGateConfig) {}

  stats() {
    return { inFlight: this.inFlight, queued: this.queue.length, ...this.cfg }
  }

  /** Acquire a turn slot. Resolves a release fn on admission, or null if the
   *  queue is full / the wait budget elapses (the caller should SHED). */
  acquire(): Promise<TurnSlot> {
    if (this.inFlight < this.cfg.maxConcurrency) {
      this.inFlight++
      return Promise.resolve(this.makeRelease())
    }
    if (this.queue.length >= this.cfg.queueMax) {
      return Promise.resolve(null) // shed: queue full
    }
    return new Promise<TurnSlot>((resolve) => {
      const timer = setTimeout(() => {
        const i = this.queue.findIndex((w) => w.timer === timer)
        if (i >= 0) this.queue.splice(i, 1)
        resolve(null) // shed: waited too long
      }, this.cfg.queueWaitMs)
      this.queue.push({ resolve, timer })
    })
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return // idempotent
      released = true
      const next = this.queue.shift()
      if (next) {
        clearTimeout(next.timer)
        // hand the slot straight to the next waiter (inFlight stays counted)
        next.resolve(this.makeRelease())
      } else {
        this.inFlight = Math.max(0, this.inFlight - 1)
      }
    }
  }
}

let singleton: TurnGate | undefined
export function getTurnGate(): TurnGate {
  if (!singleton) singleton = new TurnGate(getTurnGateConfig())
  return singleton
}

/** Test helper — rebuild the singleton from current env. */
export function __resetTurnGateForTest(): void {
  singleton = undefined
}
