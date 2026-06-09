/**
 * Bounded in-process caches for the agent engine (Step: scale P4).
 *
 * A simple LRU+TTL map, plus two purpose caches built on it:
 *   - embeddingCache: normalized question -> 1024-dim vector. Safe and
 *     high-value: a query embedding is a pure function of (text, model) and
 *     the embedding model is LOCKED (config EMBEDDING_DIM), so a long TTL is
 *     valid. On the 1st-of-month crest tens of thousands of tenants ask
 *     near-identical questions; this serves the vector without a round-trip.
 *   - answerCache: (audience, normalized question) -> reply, for the
 *     CACHEABLE class ONLY (no tools, no escalation, grounded, no history).
 *     DEFAULT OFF — cached customer-facing answers are a quality/staleness
 *     call; enable via AGENT_ANSWER_CACHE_TTL_MS.
 *
 * Both sit behind a plain interface so a Redis tier can slot in later for
 * cross-replica hits without touching callers.
 */

interface Entry<V> {
  value: V
  expires: number
}

export class LruCache<V> {
  private readonly map = new Map<string, Entry<V>>()

  constructor(private readonly max: number, private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.expires <= Date.now()) {
      this.map.delete(key)
      return undefined
    }
    // recency: re-insert to move to the end
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expires: Date.now() + this.ttlMs })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }
}

/** Normalize a question so trivially-different phrasings share a cache key. */
export function normalizeQuestion(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

// ── Embedding cache (on by default) ───────────────────────────────────
const EMBED_CACHE_MAX = Number(process.env.AGENT_EMBED_CACHE_MAX) || 5000
const EMBED_CACHE_TTL_MS = Number(process.env.AGENT_EMBED_CACHE_TTL_MS) || 24 * 60 * 60 * 1000
export const embeddingCache = new LruCache<number[]>(EMBED_CACHE_MAX, EMBED_CACHE_TTL_MS)

// ── Answer cache (off by default; TTL of 0 disables) ──────────────────
const ANSWER_CACHE_TTL_MS = Number(process.env.AGENT_ANSWER_CACHE_TTL_MS) || 0
const ANSWER_CACHE_MAX = Number(process.env.AGENT_ANSWER_CACHE_MAX) || 2000
export const answerCacheEnabled = ANSWER_CACHE_TTL_MS > 0
export const answerCache = answerCacheEnabled
  ? new LruCache<string>(ANSWER_CACHE_MAX, ANSWER_CACHE_TTL_MS)
  : null
