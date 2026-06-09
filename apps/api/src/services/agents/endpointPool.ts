/**
 * Endpoint pool — spreads agent model calls across a fleet of self-hosted
 * worker URLs, with least-in-flight routing, per-worker circuit-breaking,
 * and failover (Step: scale P1).
 *
 * The dev team stands up N vLLM/embedding workers and lists their URLs in
 * LLM_ENDPOINTS / EMBEDDINGS_ENDPOINTS; this pool distributes load across
 * them with zero redeploy. Routing is LEAST-IN-FLIGHT (not round-robin)
 * because agent turns vary 5–12s and stack multiple calls — least-in-flight
 * sends the next call to the least-loaded worker and smooths the batching
 * queues. On a retryable failure (network/timeout/429/5xx) the worker is
 * briefly cooled down and the call re-dispatched to the next-best healthy
 * worker; deterministic 4xx errors never fail over.
 */

/** Marker for failures the pool should fail over on (vs deterministic 4xx). */
export class RetryableEndpointError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'RetryableEndpointError'
  }
}

/** HTTP statuses worth failing over to another worker (vs deterministic 4xx). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

const COOLDOWN_MS = 5_000

export class EndpointPool {
  private readonly endpoints: string[]
  private readonly inflight: Map<string, number> = new Map()
  private readonly cooldownUntil: Map<string, number> = new Map()

  constructor(endpoints: string[]) {
    if (endpoints.length === 0) throw new Error('EndpointPool requires at least one endpoint')
    this.endpoints = [...endpoints]
    for (const e of this.endpoints) this.inflight.set(e, 0)
  }

  get size(): number {
    return this.endpoints.length
  }

  /** Snapshot of in-flight counts, for instrumentation. */
  stats(): Record<string, number> {
    return Object.fromEntries(this.inflight)
  }

  /** Pick the least-in-flight healthy endpoint not already tried this run.
   *  Falls back to the least-in-flight cooled-down one if all are cooling. */
  private pick(exclude: Set<string>, now: number): string | undefined {
    const candidates = this.endpoints.filter((e) => !exclude.has(e))
    if (candidates.length === 0) return undefined
    const healthy = candidates.filter((e) => (this.cooldownUntil.get(e) ?? 0) <= now)
    const pool = healthy.length > 0 ? healthy : candidates // last resort: use cooling ones
    return pool.reduce((best, e) => ((this.inflight.get(e) ?? 0) < (this.inflight.get(best) ?? 0) ? e : best))
  }

  /**
   * Run `fn(endpoint)` against the least-loaded healthy worker, failing over
   * to other workers on RetryableEndpointError up to `maxAttempts` distinct
   * workers. Non-retryable errors propagate immediately. In-flight counts are
   * always decremented (finally), so a throw/timeout never leaks load.
   */
  async run<T>(fn: (endpoint: string) => Promise<T>, maxAttempts = 3): Promise<T> {
    const tried = new Set<string>()
    const attempts = Math.min(maxAttempts, this.endpoints.length)
    let lastErr: unknown

    for (let i = 0; i < attempts; i++) {
      const ep = this.pick(tried, Date.now())
      if (!ep) break
      tried.add(ep)
      this.inflight.set(ep, (this.inflight.get(ep) ?? 0) + 1)
      try {
        return await fn(ep)
      } catch (err) {
        lastErr = err
        if (!(err instanceof RetryableEndpointError)) throw err
        this.cooldownUntil.set(ep, Date.now() + COOLDOWN_MS) // brief circuit break
      } finally {
        this.inflight.set(ep, Math.max(0, (this.inflight.get(ep) ?? 1) - 1))
      }
    }
    throw lastErr ?? new Error('EndpointPool: no healthy endpoint available')
  }
}

// Memoized pools keyed by the endpoint list, so in-flight state persists for
// the life of the process while a config change (different URLs) yields a
// fresh pool.
const registry = new Map<string, EndpointPool>()

export function getPool(endpoints: string[]): EndpointPool {
  const key = endpoints.join(',')
  let pool = registry.get(key)
  if (!pool) {
    pool = new EndpointPool(endpoints)
    registry.set(key, pool)
  }
  return pool
}

/** Test helper — drop memoized pools so env changes take effect. */
export function __resetPoolsForTest(): void {
  registry.clear()
}
