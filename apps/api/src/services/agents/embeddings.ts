/**
 * Agent engine — embeddings client (Step 3).
 *
 * Turns text into vectors via the self-hosted, OpenAI-compatible
 * embeddings endpoint (bge-large-en-v1.5 on llama.cpp in dev). Used
 * both to embed knowledge chunks at ingest time and to embed a user's
 * question at retrieval time — the same model must do both so the
 * vectors are comparable.
 *
 * Plain fetch, localhost only — no SDK, no external network.
 */

import { getEmbeddingsConfig, EMBEDDING_DIM } from './config'
import { getPool, RetryableEndpointError, isRetryableStatus } from './endpointPool'
import { logger } from '../../lib/logger'

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
}

/** Embed one string. Returns a 1024-dim vector. */
export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text])
  return vector
}

/**
 * Embed many strings in one request. Returns vectors in the SAME order
 * as the input (the endpoint may return them out of order; we re-sort
 * by `index`).
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const { endpoints, model, timeoutMs } = getEmbeddingsConfig()

  // Spread across the embedding-worker fleet; fail over on transient errors.
  const json = await getPool(endpoints).run(async (endpoint) => {
    let res: Response
    try {
      res = await fetch(`${endpoint}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      logger.error({ err, endpoint }, 'agent embeddings: endpoint unreachable')
      throw new RetryableEndpointError(`Embeddings endpoint unreachable at ${endpoint}`, err)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.error({ status: res.status, body, endpoint }, 'agent embeddings: endpoint returned an error')
      if (isRetryableStatus(res.status)) throw new RetryableEndpointError(`Embeddings endpoint ${endpoint} returned ${res.status}`)
      throw new Error(`Embeddings endpoint returned ${res.status}`)
    }
    return (await res.json()) as EmbeddingsResponse
  })
  const data = json.data
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(
      `Embeddings endpoint returned ${data?.length ?? 0} vectors for ${texts.length} inputs`
    )
  }

  // Re-sort by index to guarantee input-order alignment.
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

  return ordered.map((d, i) => {
    const v = d.embedding
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
      // A wrong-dimension vector means the served model is not the one
      // the schema is locked to — fail loudly rather than store garbage.
      throw new Error(
        `Embeddings endpoint returned a ${v?.length ?? 0}-dim vector at index ${i}; ` +
          `expected ${EMBEDDING_DIM} (is EMBEDDINGS_MODEL the right model?)`
      )
    }
    return v
  })
}

/** Format a JS number[] as a pgvector literal, e.g. '[1,2,3]'. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}
