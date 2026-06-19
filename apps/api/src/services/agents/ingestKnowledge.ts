/**
 * Knowledge base ingest runner.
 *
 * Walks the content directory (markdown articles with simple frontmatter)
 * and ingests every article into the agent knowledge store. Idempotent —
 * safe to re-run after editing content (chunks are replaced by source).
 *
 * Article format (frontmatter delimited by --- lines):
 *   ---
 *   scope: tenant            # tenant | landlord | shared
 *   title: Paying your rent
 *   ---
 *   <markdown body...>
 *
 * Run:
 *   EMBEDDINGS_ENDPOINT=http://localhost:8081/v1 EMBEDDINGS_MODEL=bge-large-en-v1.5 \
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=gam DB_USER=postgres DB_PASSWORD=gam_dev_password \
 *   node -r ts-node/register src/services/agents/ingestKnowledge.ts
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { ingestArticle } from './knowledgeIngest'
import { KNOWLEDGE_SCOPES, type KnowledgeScope } from './types'
import { query } from '../../db'

process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

const CONTENT_ROOT = join(__dirname, 'knowledge-content')

interface ParsedArticle {
  scope: KnowledgeScope
  title: string
  body: string
}

/** Parse a tiny `--- key: value --- body` frontmatter article. */
export function parseArticle(raw: string): ParsedArticle {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!m) throw new Error('missing frontmatter (--- scope/title ---)')
  const front: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (kv) front[kv[1]] = kv[2].trim()
  }
  const scope = front.scope as KnowledgeScope
  if (!KNOWLEDGE_SCOPES.includes(scope)) throw new Error(`invalid scope: ${front.scope}`)
  if (!front.title) throw new Error('missing title')
  return { scope, title: front.title, body: m[2].trim() }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}

async function main() {
  const files = walk(CONTENT_ROOT)
  console.log(`[ingest] ${files.length} article(s) under ${CONTENT_ROOT}\n`)
  let totalChunks = 0
  // Every on-disk source seen this run. Anything in the store NOT in this set
  // is an article that was deleted from the content dir — prune its chunks so
  // a removed article stops being retrieved (the per-source replace alone
  // can't do this; it only touches sources it re-ingests).
  const seen: string[] = []
  for (const file of files) {
    const source = relative(CONTENT_ROOT, file)
    seen.push(source)
    try {
      const { scope, title, body } = parseArticle(readFileSync(file, 'utf8'))
      const res = await ingestArticle({ scope, source, title, body })
      totalChunks += res.inserted
      console.log(`  [${scope.padEnd(8)}] ${title}  (${res.inserted} chunks${res.deleted ? `, replaced ${res.deleted}` : ''})`)
    } catch (e) {
      console.error(`  ! ${source}: ${(e as Error).message}`)
      process.exitCode = 1
    }
  }

  // Prune orphaned chunks whose source file no longer exists on disk. Sources
  // are kept in `seen` from before parse, so a file that failed to parse this
  // run still counts as present and keeps its last-good chunks.
  const pruned = await query<{ source: string }>(
    `DELETE FROM agent_knowledge_chunks
      WHERE source IS NOT NULL AND source <> ALL($1::text[])
      RETURNING source`,
    [seen]
  )
  if (pruned.length) {
    const sources = [...new Set(pruned.map((r) => r.source))]
    console.log(`\n[ingest] pruned ${pruned.length} orphaned chunk(s) from ${sources.length} removed article(s): ${sources.join(', ')}`)
  }

  console.log(`\n[ingest] done — ${totalChunks} chunks across ${files.length} articles`)
}

// Only run when invoked directly (not when imported, e.g. by tests).
if (require.main === module) {
  main().catch((err) => {
    console.error('[ingest] FAILED:', err.message)
    process.exit(1)
  })
}
