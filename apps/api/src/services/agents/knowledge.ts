/**
 * Agent engine — knowledge store (Step 3 / RAG retrieval).
 *
 * Two interfaces over the agent_knowledge_chunks table:
 *   - indexChunk()  ingest: embed a piece of content and store it,
 *                   tagged with a scope. The content-ingestion layer
 *                   (deferred per handoff) drives this; the structure
 *                   is here now.
 *   - retrieve()    query: embed a question and return the most similar
 *                   chunks WITHIN the caller's scopes. This is what
 *                   grounds an agent's answer in real GAM knowledge
 *                   instead of model invention.
 *
 * Similarity is cosine; the HNSW index on the embedding column makes
 * the ORDER BY fast. Scope filtering keeps a tenant agent from reading
 * landlord knowledge and vice-versa.
 */

import { query } from '../../db'
import { embed, toVectorLiteral } from './embeddings'
import { embeddingCache, normalizeQuestion } from './cache'
import type { KnowledgeScope } from './types'

export interface IndexChunkInput {
  scope: KnowledgeScope
  content: string
  title?: string
  source?: string
  metadata?: Record<string, unknown>
}

/** Remove all chunks from a given source (an article id/path). Used to
 *  make re-ingest idempotent — delete then re-insert, no duplicates. */
export async function deleteChunksBySource(source: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM agent_knowledge_chunks WHERE source = $1 RETURNING id`,
    [source]
  )
  return rows.length
}

/** Embed `content` and store it as a retrievable chunk. Returns its id. */
export async function indexChunk(input: IndexChunkInput): Promise<string> {
  const { scope, content, title, source, metadata } = input
  const vector = await embed(content)

  const rows = await query<{ id: string }>(
    `INSERT INTO agent_knowledge_chunks (scope, source, title, content, embedding, metadata)
     VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb)
     RETURNING id`,
    [scope, source ?? null, title ?? null, content, toVectorLiteral(vector), JSON.stringify(metadata ?? {})]
  )
  return rows[0].id
}

export interface RetrievedChunk {
  id: string
  scope: KnowledgeScope
  title: string | null
  content: string
  source: string | null
  /** cosine similarity = 1 - cosine_distance, in [-1,1]; higher is closer.
   *  bge-large embeddings are L2-normalized, so in practice it sits ~[0,1]. */
  similarity: number
}

/**
 * Retrieve the top-k chunks most similar to `queryText`, restricted to
 * `scopes`. Returns [] when scopes is empty (a profile with no
 * knowledge access retrieves nothing rather than everything).
 */
export async function retrieve(
  scopes: KnowledgeScope[],
  queryText: string,
  k = 5
): Promise<RetrievedChunk[]> {
  if (scopes.length === 0) return []

  // Cache the query embedding — on a load crest many tenants ask near-
  // identical questions; serve the vector without an embedding round-trip.
  const cacheKey = normalizeQuestion(queryText)
  let vector = embeddingCache.get(cacheKey)
  if (!vector) {
    vector = await embed(queryText)
    embeddingCache.set(cacheKey, vector)
  }

  return query<RetrievedChunk>(
    `SELECT id, scope, title, content, source,
            1 - (embedding <=> $1::vector) AS similarity
       FROM agent_knowledge_chunks
      WHERE scope = ANY($2)
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(vector), scopes, k]
  )
}
