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

// S620: one scope per probe, because that is now what a profile carries.
// The last five are the questions the shared pool used to answer WRONGLY —
// each is asked in the audience that used to get someone else's article.
const PROBES: { scopes: KnowledgeScope[]; q: string }[] = [
  { scopes: ['tenant'], q: 'How do I pay my rent and what does it cost?' },
  { scopes: ['tenant'], q: 'My kitchen sink is leaking, what should I do?' },
  { scopes: ['tenant'], q: 'I forgot my password' },
  { scopes: ['landlord'], q: 'When do I get paid and how do payouts work?' },
  { scopes: ['landlord'], q: 'What does GAM charge me per unit?' },
  // A guest has no account and no landlord — these used to return password
  // resets and "your landlord sets your rent".
  { scopes: ['guest'], q: 'Can I get a late checkout?' },
  { scopes: ['guest'], q: 'How much does it cost?' },
  // On a booking site "what does it cost" is THIS property's nightly rate.
  { scopes: ['visitor'], q: 'How much is it per night?' },
  { scopes: ['visitor'], q: 'How do I book?' },
  // A prospect IS the landlord — the shared article told them they were not.
  { scopes: ['sales'], q: 'What is GAM?' },
]

async function main() {
  for (const p of PROBES) {
    const hits = await retrieve(p.scopes, p.q, 3)
    console.log(`\n[probe] (${p.scopes.join('+')}) "${p.q}"`)
    for (const h of hits) {
      console.log(`   ${h.similarity.toFixed(3)}  [${h.scope}] ${h.title}`)
    }
  }
  // Scope isolation: every scope must return ONLY its own chunks, whatever is
  // asked. Each question below is deliberately aimed at ANOTHER audience's
  // content — a tenant asking about payouts, a guest asking GAM's rate card.
  const crossChecks: { scope: KnowledgeScope; q: string }[] = [
    { scope: 'tenant', q: 'how do payouts to my bank work?' },
    { scope: 'tenant', q: 'what is the platform fee per occupied unit?' },
    { scope: 'guest', q: 'how do I reset my password and set up two-factor?' },
    { scope: 'visitor', q: 'what does GAM charge landlords per unit?' },
    { scope: 'sales', q: 'when is my rent due and what is my late fee?' },
    { scope: 'landlord', q: 'how do I pay my rent?' },
  ]
  let leaks = 0
  for (const c of crossChecks) {
    const hits = await retrieve([c.scope], c.q, 5)
    const foreign = hits.filter((h) => h.scope !== c.scope)
    if (foreign.length) {
      leaks += foreign.length
      console.log(`  ✗ [${c.scope}] "${c.q}" leaked ${foreign.map((f) => f.scope).join(', ')}`)
    }
  }
  console.log(`\n[probe] scope isolation across ${crossChecks.length} cross-audience questions: ${leaks === 0 ? 'NO LEAKS ✓' : `${leaks} LEAKED`}`)
}

main().catch((e) => {
  console.error('[probe] FAILED:', e.message)
  process.exit(1)
})
