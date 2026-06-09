/**
 * Knowledge ingestion — turn help/policy ARTICLES into retrievable chunks.
 *
 * An article (a full markdown/text doc) is split into chunks sized for the
 * embedding model (bge-large caps at 512 tokens; we target well under that),
 * then each chunk is embedded + stored. Re-ingesting the same `source` is
 * idempotent: existing chunks for that source are deleted first, so editing
 * an article and re-running never duplicates.
 *
 * Each chunk's stored/embedded text is prefixed with the article title so a
 * mid-article chunk still carries topic context for retrieval and for the
 * model reading it.
 */

import { indexChunk, deleteChunksBySource } from './knowledge'
import type { KnowledgeScope } from './types'

/** Rough chars-per-chunk target. ~900 chars ≈ ~220 tokens — safely under
 *  bge-large's 512-token cap while keeping chunks topically coherent. */
const TARGET_CHARS = 900
/** Never emit a chunk longer than this (hard cap before the token limit). */
const MAX_CHARS = 1400

/**
 * Split article body into chunks on paragraph (blank-line) boundaries,
 * packing paragraphs together up to TARGET_CHARS. A single paragraph longer
 * than MAX_CHARS is hard-split on sentence boundaries. Returns trimmed,
 * non-empty chunk strings in document order.
 */
export function chunkText(body: string, targetChars = TARGET_CHARS): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ''

  const flush = () => {
    const t = current.trim()
    if (t) chunks.push(t)
    current = ''
  }

  for (const para of paragraphs) {
    if (para.length > MAX_CHARS) {
      // Hard-split an oversized paragraph on sentence boundaries.
      flush()
      const sentences = para.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [para]
      let buf = ''
      for (const s of sentences) {
        if (buf.length + s.length > targetChars && buf) {
          chunks.push(buf.trim())
          buf = ''
        }
        buf += s
      }
      if (buf.trim()) chunks.push(buf.trim())
      continue
    }
    if (current.length + para.length + 2 > targetChars && current) flush()
    current += (current ? '\n\n' : '') + para
  }
  flush()
  return chunks
}

export interface IngestArticleInput {
  scope: KnowledgeScope
  /** stable id for the article (e.g. its file path) — the idempotency key */
  source: string
  title: string
  /** the article body (markdown/plaintext) */
  body: string
  metadata?: Record<string, unknown>
}

export interface IngestArticleResult {
  source: string
  deleted: number
  inserted: number
}

/**
 * Ingest one article: delete any prior chunks for its source, then chunk,
 * embed, and store. Each chunk is prefixed with the title for context.
 */
export async function ingestArticle(input: IngestArticleInput): Promise<IngestArticleResult> {
  const { scope, source, title, body, metadata } = input
  const deleted = await deleteChunksBySource(source)

  const pieces = chunkText(body)
  let inserted = 0
  for (let i = 0; i < pieces.length; i++) {
    await indexChunk({
      scope,
      source,
      title,
      content: `${title}\n\n${pieces[i]}`,
      metadata: { ...metadata, chunkIndex: i, chunkCount: pieces.length },
    })
    inserted++
  }
  return { source, deleted, inserted }
}
