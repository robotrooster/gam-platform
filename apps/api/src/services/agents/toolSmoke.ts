/**
 * Live tool-loop smoke (Step 4).
 *
 * Proves the real model<->tool<->model round trip end to end: the tenant
 * agent decides to call file_maintenance_request, the tool executes
 * against the REAL DB hard-scoped to the actor, the real result is fed
 * back, and the model produces a final answer from it.
 *
 * Uses the demo tenant `alice@tenant.dev`. NOTE: the dev DB currently
 * has no active leases, so the tool truthfully returns "no active lease"
 * — which is itself a real tool execution + result-feedback (the happy
 * "request filed" path is covered by the mocked unit tests). Pass a real
 * active-lease tenant's ids via env to see a row actually created.
 *
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=gam DB_USER=postgres DB_PASSWORD=gam_dev_password \
 *   node -r ts-node/register src/services/agents/toolSmoke.ts
 */

import { runAgentWithTools } from './agentRunner'
import { requireProfile } from './profiles'
import type { AgentActor } from './tools/types'

process.env.LLM_ENDPOINT ||= 'http://localhost:8080/v1'
process.env.LLM_MODEL ||= 'mlx-community/Hermes-4-14B-4bit'
process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

const actor: AgentActor = {
  userId: process.env.SMOKE_USER_ID || 'f8097f3b-53eb-47f5-b109-5cc7ebfa01ff', // alice user
  role: 'tenant',
  profileId: process.env.SMOKE_TENANT_ID || '744663aa-7efd-4012-9c5b-f0018eca6a28', // alice tenant
}

async function main() {
  const message =
    process.argv.slice(2).join(' ') ||
    'My kitchen sink has been leaking all morning and water is pooling under the cabinet. Can you put in a maintenance request for me?'

  console.log(`[tsmoke] actor   = tenant ${actor.profileId.slice(0, 8)}`)
  console.log(`[tsmoke] user    > ${message}\n`)

  const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor, message })

  for (const inv of res.toolInvocations) {
    console.log(`[tsmoke] TOOL CALL  ${inv.name}(${JSON.stringify(inv.args)})`)
    console.log(`[tsmoke] TOOL RESULT ${JSON.stringify(inv.result)}`)
  }
  console.log(`\n[tsmoke] agent   > ${res.reply}`)
  console.log(`[tsmoke] (${res.toolInvocations.length} tool call(s), grounded=${res.grounded})`)
}

main().catch((err) => {
  console.error('[tsmoke] FAILED:', err.message)
  process.exit(1)
})
