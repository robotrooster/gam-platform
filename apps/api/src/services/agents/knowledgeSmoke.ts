/**
 * Live RAG smoke for the knowledge layer (Step 3).
 *
 * Indexes a handful of chunks (tenant / landlord / shared), then runs a
 * tenant-scoped retrieval to prove: (1) the embed->store->search loop
 * works end-to-end against the real model + pgvector, and (2) scope
 * isolation holds — a tenant query does NOT surface landlord-only
 * chunks. Cleans up the rows it created.
 *
 *   EMBEDDINGS_ENDPOINT=http://localhost:8081/v1 EMBEDDINGS_MODEL=bge-large-en-v1.5 \
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=gam DB_USER=postgres DB_PASSWORD=gam_dev_password \
 *   node -r ts-node/register src/services/agents/knowledgeSmoke.ts
 */

import { indexChunk, retrieve } from './knowledge'
import { query } from '../../db'

process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

const SMOKE_SOURCE = '__smoke__'

const CHUNKS = [
  { scope: 'tenant' as const, title: 'Rent due date', content: 'Rent is due on the date set in your individual lease agreement. Check your lease in the portal under Documents to see your exact due date and any grace period.' },
  { scope: 'tenant' as const, title: 'How to pay rent', content: 'Pay rent from the Payments page by linking a bank account (ACH) or card. ACH has a lower fee than card.' },
  { scope: 'landlord' as const, title: 'Payout schedule', content: 'Landlord payouts are sent to your connected bank account on a rolling schedule once tenant funds clear.' },
  { scope: 'shared' as const, title: 'Resetting your password', content: 'Use the Forgot Password link on the sign-in page. A reset link is emailed to the address on your account.' },
]

async function main() {
  console.log('[ksmoke] indexing 4 chunks (tenant/landlord/shared)...')
  for (const c of CHUNKS) {
    const id = await indexChunk({ ...c, source: SMOKE_SOURCE })
    console.log(`  + ${c.scope.padEnd(8)} ${c.title}  (${id.slice(0, 8)})`)
  }

  const q = 'What day do I have to pay my rent?'
  console.log(`\n[ksmoke] tenant-scoped retrieval for: "${q}"`)
  const hits = await retrieve(['tenant', 'shared'], q, 3)
  for (const h of hits) {
    console.log(`  ${h.similarity.toFixed(3)}  [${h.scope}] ${h.title}`)
  }

  const topIsRentDue = hits[0]?.title === 'Rent due date'
  const noLandlordLeak = hits.every((h) => h.scope !== 'landlord')
  console.log(`\n[ksmoke] top hit is the rent-due chunk: ${topIsRentDue ? 'YES' : 'NO'}`)
  console.log(`[ksmoke] no landlord chunk leaked into tenant scope: ${noLandlordLeak ? 'YES' : 'NO'}`)

  // cleanup
  const del = await query<{ id: string }>(
    `DELETE FROM agent_knowledge_chunks WHERE source = $1 RETURNING id`,
    [SMOKE_SOURCE]
  )
  console.log(`[ksmoke] cleaned up ${del.length} smoke rows`)

  if (!topIsRentDue || !noLandlordLeak) process.exit(1)
}

main().catch((err) => {
  console.error('[ksmoke] FAILED:', err.message)
  process.exit(1)
})
