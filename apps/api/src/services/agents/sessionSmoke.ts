/**
 * Live escalation-chain smoke (Step 5).
 *
 * A money-movement + frustration scenario — a hard stop — should travel
 * Ava -> Samantha -> human. Prints the escalation trail, the tools each
 * tier fired, the final customer-facing reply, and the human-handoff
 * package. Uses the demo tenant alice. Needs both model servers + DB.
 *
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=gam DB_USER=postgres DB_PASSWORD=gam_dev_password \
 *   node -r ts-node/register src/services/agents/sessionSmoke.ts
 */

import { runAgentSession } from './agentSession'
import type { AgentActor } from './tools/types'

process.env.LLM_ENDPOINT ||= 'http://localhost:8080/v1'
process.env.LLM_MODEL ||= 'mlx-community/Hermes-4-14B-4bit'
process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

const actor: AgentActor = {
  userId: 'f8097f3b-53eb-47f5-b109-5cc7ebfa01ff', // alice user
  role: 'tenant',
  profileId: '744663aa-7efd-4012-9c5b-f0018eca6a28', // alice tenant
}

async function main() {
  const message =
    process.argv.slice(2).join(' ') ||
    'I was double-charged for rent last month and I want a refund to my bank account today. This is the second time and I am really frustrated.'

  console.log(`[ssmoke] user > ${message}\n`)
  const res = await runAgentSession({ audience: 'tenant', actor, message })

  console.log('[ssmoke] escalation trail:')
  if (res.escalations.length === 0) console.log('  (none — handled at first tier)')
  for (const e of res.escalations) console.log(`  ${e.from} -> ${e.to}  (${e.reason})`)

  console.log(`\n[ssmoke] tools fired: ${res.toolInvocations.map((t) => t.name).join(', ') || '(none)'}`)
  console.log(`[ssmoke] handled by: ${res.handledBy.name} (${res.handledBy.tier})`)
  console.log(`\n[ssmoke] reply > ${res.reply}`)

  if (res.humanHandoff) {
    console.log('\n[ssmoke] HUMAN HANDOFF PACKAGE:')
    console.log(`  reason : ${res.humanHandoff.reason}`)
    console.log(`  summary: ${res.humanHandoff.summary}`)
  }
}

main().catch((err) => {
  console.error('[ssmoke] FAILED:', err.message)
  process.exit(1)
})
