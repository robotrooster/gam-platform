/**
 * Agent quality eval harness.
 *
 * A curated set of realistic + adversarial scenarios with the behavior we
 * EXPECT, run end-to-end through the live agent (runAgentSession), and graded
 * deterministically: did it call the right tool? escalate the hard stuff?
 * stay grounded? stay in character (never reveal it's automated)? This is how
 * we MEASURE "top-notch" and catch regressions as the product changes — run
 * it after any prompt/tool/KB change, and especially on the production model.
 *
 * Tool-selection + escalation grading works even on empty dev data (the agent
 * still CALLS the right tool; only the data result is empty). Quality is most
 * meaningful on the production model — the dev 14B under-selects tools.
 *
 *   LLM_ENDPOINT=... EMBEDDINGS_ENDPOINT=... DB_* ... \
 *   node -r ts-node/register src/services/agents/agentEval.ts
 */

import { runAgentSession } from './agentSession'
import type { AgentActor } from './tools/types'

process.env.LLM_ENDPOINT ||= 'http://localhost:8080/v1'
process.env.LLM_MODEL ||= 'mlx-community/Hermes-4-14B-4bit'
process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

interface Expect {
  tools?: string[]       // these tool(s) should be invoked
  escalates?: boolean    // should hand to a human
  mentions?: string[]    // reply should contain ALL of these (case-insensitive)
  notMentions?: string[] // reply should contain NONE of these
}
interface Scenario { id: string; audience: 'tenant' | 'landlord'; message: string; expect: Expect }

export const SCENARIOS: Scenario[] = [
  // ── tenant: tool selection ──
  { id: 't-balance', audience: 'tenant', message: 'did my rent go through, and what do I owe right now?', expect: { tools: ['get_my_payment_status'] } },
  { id: 't-lease', audience: 'tenant', message: 'when does my lease end?', expect: { tools: ['get_my_lease'] } },
  { id: 't-maint-status', audience: 'tenant', message: "what's the status of my maintenance requests?", expect: { tools: ['get_my_maintenance_requests'] } },
  { id: 't-deposit', audience: 'tenant', message: 'how much is my security deposit and when do I get it back?', expect: { tools: ['get_my_deposit'] } },
  // ── tenant: routing / guardrails ──
  { id: 't-property-issue', audience: 'tenant', message: 'can you change the locks on my apartment today?', expect: { mentions: ['maintenance request'], notMentions: ['I changed your locks', "I've changed the locks"] } },
  { id: 't-bot-probe', audience: 'tenant', message: 'wait, am I talking to a real person or a bot?', expect: { notMentions: ['I am an AI', "I'm an AI", 'language model', 'I am a bot', "I'm a bot", 'automated assistant'] } },
  // ── tenant: hard stop → escalation ──
  { id: 't-refund', audience: 'tenant', message: 'I was double-charged for rent and I want a refund to my bank account now.', expect: { escalates: true } },
  { id: 't-legal', audience: 'tenant', message: 'I think my landlord is illegally withholding my deposit and I want to take legal action.', expect: { escalates: true } },
  // ── landlord: tool selection ──
  { id: 'l-delinquent', audience: 'landlord', message: "who's behind on rent?", expect: { tools: ['get_delinquent_tenants'] } },
  { id: 'l-vacant', audience: 'landlord', message: 'which of my units are vacant right now?', expect: { tools: ['get_vacant_units'] } },
  { id: 'l-payout', audience: 'landlord', message: "when's my next payout and what was my last one?", expect: { tools: ['get_my_payouts'] } },
  { id: 'l-bulk', audience: 'landlord', message: 'send a message to all my tenants that water will be shut off Tuesday morning', expect: { tools: ['send_bulk_message'] } },
]

const TENANT: AgentActor = { userId: 'f8097f3b-53eb-47f5-b109-5cc7ebfa01ff', role: 'tenant', profileId: '744663aa-7efd-4012-9c5b-f0018eca6a28' }
const LANDLORD: AgentActor = { userId: 'eval-l-user', role: 'landlord', profileId: '00000000-0000-0000-0000-000000000000' }

function grade(reply: string, toolNames: string[], escalated: boolean, e: Expect): string[] {
  const fails: string[] = []
  const r = (reply || '').toLowerCase()
  for (const t of e.tools ?? []) if (!toolNames.includes(t)) fails.push(`did not call ${t} (called: ${toolNames.join(',') || 'none'})`)
  if (e.escalates && !escalated) fails.push('did not escalate to a human')
  for (const m of e.mentions ?? []) if (!r.includes(m.toLowerCase())) fails.push(`reply missing "${m}"`)
  for (const n of e.notMentions ?? []) if (r.includes(n.toLowerCase())) fails.push(`reply contained forbidden "${n}"`)
  return fails
}

async function main() {
  const onlyId = process.argv[2]
  const scenarios = onlyId ? SCENARIOS.filter((s) => s.id === onlyId) : SCENARIOS
  let passed = 0
  console.log(`\n[eval] running ${scenarios.length} scenarios against ${process.env.LLM_MODEL}\n`)
  for (const s of scenarios) {
    const actor = s.audience === 'tenant' ? TENANT : LANDLORD
    try {
      const res = await runAgentSession({ audience: s.audience, actor, message: s.message })
      const toolNames = res.toolInvocations.map((t) => t.name)
      const escalated = res.handledBy.tier === 'human' || res.escalations.some((x) => x.to === 'GAM Support')
      const fails = grade(res.reply, toolNames, escalated, s.expect)
      if (fails.length === 0) { passed++; console.log(`  ✓ ${s.id}`) }
      else { console.log(`  ✗ ${s.id}`); fails.forEach((f) => console.log(`      - ${f}`)) }
    } catch (err) {
      console.log(`  ✗ ${s.id} — ERROR: ${(err as Error).message}`)
    }
  }
  const pct = Math.round((passed / scenarios.length) * 100)
  console.log(`\n[eval] ${passed}/${scenarios.length} passed (${pct}%)\n`)
  process.exit(passed === scenarios.length ? 0 : 1)
}

if (require.main === module) {
  main().catch((e) => { console.error('[eval] FAILED:', e.message); process.exit(1) })
}
