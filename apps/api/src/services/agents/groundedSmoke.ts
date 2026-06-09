/**
 * Live grounded-answer smoke (Step 3.5).
 *
 * Exercises the full path: embed+store knowledge -> ask a real profile
 * via groundedAnswer -> the chat model answers FROM the retrieved facts.
 * Then asks a question NO chunk covers, to show the agent refuses to
 * invent. Needs both servers up (chat :8080, embeddings :8081) + DB.
 * Cleans up its rows.
 *
 *   DB_HOST=localhost DB_PORT=5432 DB_NAME=gam DB_USER=postgres DB_PASSWORD=gam_dev_password \
 *   node -r ts-node/register src/services/agents/groundedSmoke.ts
 */

import { groundedAnswer } from './groundedAgent'
import { indexChunk } from './knowledge'
import { requireProfile } from './profiles'
import { query } from '../../db'

process.env.LLM_ENDPOINT ||= 'http://localhost:8080/v1'
process.env.LLM_MODEL ||= 'mlx-community/Hermes-4-14B-4bit'
process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

const SMOKE_SOURCE = '__grounded_smoke__'

async function ask(label: string, message: string) {
  const profile = requireProfile('tenant_entry')
  const res = await groundedAnswer({ profile, message })
  console.log(`\n[gsmoke] ${label}`)
  console.log(`[gsmoke] user    > ${message}`)
  console.log(`[gsmoke] grounded? ${res.grounded} (${res.retrieved.length} chunk(s))`)
  if (res.retrieved.length) {
    console.log(`[gsmoke] used    > ${res.retrieved.map((c) => c.title).join(', ')}`)
  }
  console.log(`[gsmoke] agent   > ${res.reply}`)
}

async function main() {
  await indexChunk({
    scope: 'tenant',
    title: 'Rent due date',
    source: SMOKE_SOURCE,
    content:
      'Rent is due on the 3rd of each month for tenants at Maple Court. There is a 5-day grace period before a late fee applies.',
  })
  await indexChunk({
    scope: 'tenant',
    title: 'Late fee amount',
    source: SMOKE_SOURCE,
    content: 'The late fee at Maple Court is $50, charged after the grace period ends.',
  })

  // 1) Answerable from knowledge — should cite the 3rd + grace period, not invent.
  await ask('IN-KNOWLEDGE', 'What day is my rent due and is there a grace period?')

  // 2) A property issue — GAM is the platform, not the landlord, so the
  //    agent should route to a maintenance request (-> landlord), NOT
  //    escalate to GAM support and NOT promise the fix.
  await ask('PROPERTY-ISSUE', 'Can you change the locks on my apartment today?')

  const del = await query(`DELETE FROM agent_knowledge_chunks WHERE source = $1 RETURNING id`, [
    SMOKE_SOURCE,
  ])
  console.log(`\n[gsmoke] cleaned up ${del.length} smoke rows`)
}

main().catch((err) => {
  console.error('[gsmoke] FAILED:', err.message)
  process.exit(1)
})
