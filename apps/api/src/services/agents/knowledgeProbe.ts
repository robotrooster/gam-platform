/**
 * Knowledge retrieval probe — sanity-check what the ingested KB returns
 * for realistic questions, and confirm scope isolation. Read-only; does
 * not modify the store.
 *
 *   EMBEDDINGS_ENDPOINT=... EMBEDDINGS_MODEL=... DB_* ... \
 *   node -r ts-node/register src/services/agents/knowledgeProbe.ts
 */

import { retrieve } from './knowledge'
import type { KnowledgeScope } from './types'

process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

const PROBES: { scopes: KnowledgeScope[]; q: string }[] = [
  { scopes: ['tenant', 'shared'], q: 'How do I pay my rent and what does it cost?' },
  { scopes: ['tenant', 'shared'], q: 'My kitchen sink is leaking, what should I do?' },
  { scopes: ['tenant', 'shared'], q: 'I forgot my password' },
  { scopes: ['landlord', 'shared'], q: 'When do I get paid and how do payouts work?' },
  { scopes: ['landlord', 'shared'], q: 'What does GAM charge me per unit?' },
]

async function main() {
  for (const p of PROBES) {
    const hits = await retrieve(p.scopes, p.q, 3)
    console.log(`\n[probe] (${p.scopes.join('+')}) "${p.q}"`)
    for (const h of hits) {
      console.log(`   ${h.similarity.toFixed(3)}  [${h.scope}] ${h.title}`)
    }
  }
  // Scope isolation: a tenant query must NOT surface landlord-only chunks.
  const tenant = await retrieve(['tenant', 'shared'], 'how do payouts to my bank work?', 5)
  const leaked = tenant.filter((h) => h.scope === 'landlord')
  console.log(`\n[probe] scope isolation — landlord chunks in tenant query: ${leaked.length === 0 ? 'NONE ✓' : leaked.length}`)
}

main().catch((e) => {
  console.error('[probe] FAILED:', e.message)
  process.exit(1)
})
