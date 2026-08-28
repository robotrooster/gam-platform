/**
 * S626 — WHICH REAL QUESTIONS RETRIEVE NOTHING?
 *
 * When retrieval comes back empty the agent is handed "no relevant knowledge
 * article was found" and told not to invent. That is the honest fallback, but it
 * is also the moment a customer gets nothing useful — and it is the pressure
 * that makes a model reach for its own memory. Every question below is one a
 * real person asks; any that grounds on nothing is a hole in what the agents
 * know about the platform.
 *
 * Uses the EMBEDDINGS service only (bge-large-en-v1.5, 335M, encoder-only on
 * :8081). It never touches the 36B — no generation, one forward pass per query.
 *
 *   DB_NAME=gam npx ts-node src/services/agents/retrievalGaps.ts
 */
import { retrieve } from './knowledge'
import type { KnowledgeScope } from './types'

process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

/** The runner's own floor. Below this a chunk is dropped and does not ground. */
const MIN_SIMILARITY = 0.3

const Q: Record<KnowledgeScope, string[]> = {
  tenant: [
    'how do I pay my rent', 'can I pay half now and half later', 'what is my late fee',
    'my ACH payment was returned, what happens now', 'did my payment go through',
    'why am I still marked late when I paid', 'can I pay with a credit card',
    'what does it cost to pay by bank', 'my kitchen sink is leaking',
    'my neighbour is being loud at night', 'when does my lease end',
    'what happens if I want to stay after my lease ends', 'can I break my lease early',
    'how much is my deposit and when do I get it back', 'is my deposit earning interest',
    'can I have a pet', 'someone wants to enter my apartment', 'what is a move-out inspection',
    'how do I get a copy of my lease', 'can I add a roommate',
    'what is work trade', 'how do I log my work trade hours',
    'can I pay ahead for next month', 'what happens if I pay more than I owe',
    'I lost my job and cannot pay rent', 'is there a pool', 'how do I reserve the clubhouse',
    'who is my property manager', 'how do I contact my landlord',
    'what happens if I pay late', 'can I set up autopay', 'how do I change my bank account',
  ],
  landlord: [
    'when do I get paid', 'how do payouts work', 'what does GAM charge me',
    'who is behind on rent', 'a tenant paid but it has not landed yet',
    'how do I record a cash payment', 'what is the manual payment fee',
    'how do I add a property', 'how do I invite a tenant', 'how do I set a late fee',
    'how do I run a background check', 'what happens when an application comes in',
    'how do I end a lease', 'how do I return a deposit', 'what is the deposit interest rule',
    'how do I handle a maintenance request', 'how do I add my team',
    'how do I connect my bank', 'what is the bank feed', 'how do I record an expense',
    'why does my P and L show no expenses', 'what is RUBS', 'how do I bill utilities',
    'how do I set up a booking site', 'what is FlexVault', 'how does screening work',
    'can I waive a late fee', 'what happens if a tenant ACH is returned',
    'how do I see what is still clearing', 'what is my platform fee minimum',
  ],
  guest: [
    'can I get a late checkout', 'is there a pool', 'how do I extend my stay',
    'what time is check in', 'is there laundry', 'can I bring a dog',
    'what is the wifi password', 'how do I contact the host',
  ],
  visitor: [
    'how much per night', 'do you have weekly rates', 'what is the monthly rate',
    'do you take reservations', 'what size rigs fit', 'is there full hookup',
    'how do I book a site', 'what deposit do you take',
  ],
  sales: [
    'how much does GAM cost', 'do you charge for vacant units', 'can I talk to someone',
    'do you work with RV parks', 'how long does onboarding take',
    'what happens to my current tenants', 'do you do background checks',
    'is there a contract', 'how do you handle rent collection',
  ],
} as any

async function main() {
  const scopes = Object.keys(Q) as KnowledgeScope[]
  const gaps: { scope: string; q: string; best: number }[] = []
  let total = 0
  for (const scope of scopes) {
    for (const q of Q[scope]) {
      total++
      const chunks = await retrieve([scope], q, 3)
      const best = chunks[0]?.similarity ?? 0
      if (best < MIN_SIMILARITY) gaps.push({ scope, q, best })
      if (process.env.SHOW_TOP === '1') {
        console.log(`[${scope.padEnd(8)}] ${best.toFixed(3)}  ${(chunks[0]?.title ?? '—').slice(0,46).padEnd(46)}  <- ${q}`)
      }
      // Pace lightly. The encoder is ~100x smaller than the 36B and does one
      // forward pass, but there is no reason to hammer the box either.
      await new Promise((r) => setTimeout(r, 120))
    }
  }
  console.log(`\n${total} real questions probed against the knowledge base`)
  console.log(`floor: similarity >= ${MIN_SIMILARITY} (below this the chunk is dropped and grounds nothing)\n`)
  if (!gaps.length) { console.log('No gaps — every question grounded on something.'); return }
  console.log(`${gaps.length} QUESTION(S) GROUND ON NOTHING:\n`)
  for (const g of gaps.sort((a, b) => a.best - b.best)) {
    console.log(`  [${g.scope.padEnd(8)}] ${g.best.toFixed(3)}  "${g.q}"`)
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
