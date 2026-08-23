/**
 * Agent battery — drives the REAL production path and scores the result.
 *
 * S617 (Nic): "Why are you not testing on the same flow that production goes
 * through? That's the only thing we need to be testing." So this calls
 * runAgentSession with a real signed-in actor, exactly as routes/agent.ts does —
 * real tools, real retrieval, real profile.
 *
 * Cases are grouped by INTENT with several phrasings each (see
 * agentBatteryCases.ts). Nic: "tenants will basically ask the same thing in a
 * variety of ways." A group scoring 5/6 is the interesting result — it means one
 * wording falls through, which is how a tenant who owed $2,330 was told $1,200:
 * "what do I owe?" was handled and "how much do I owe right now?" was not.
 *
 *   DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts
 *   DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts tenant   # one side
 *   DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts balance  # one intent
 *
 * Not part of the vitest suite: it needs the live model and embeddings servers.
 * DO NOT run it alongside the vitest suite — together they starve the 36B model
 * server, which crashes and respawns, and this dies on a socket error that looks
 * like a code fault.
 *
 * The daily per-user turn budget is raised for the run. Left at its default of
 * 60, a full pass exhausts the test tenant and the agent starts replying "I've
 * hit my limit for our conversations today" — which then scores as a failure
 * when it is nothing of the kind. The landlord allowance derives from this one.
 */
import { runAgentSession } from './agentSession'
import { query } from '../../db'
import { ALL_INTENTS, type Intent } from './agentBatteryCases'

process.env.AGENT_TENANT_DAILY_TURNS ||= '100000'
process.env.AGENT_TENANT_DAILY_OFFTOPIC ||= '100000'
process.env.AGENT_LANDLORD_DAILY_OFFTOPIC ||= '100000'
process.env.LLM_ENDPOINT ||= 'http://localhost:8080/v1'
process.env.LLM_MODEL ||= '/Users/nicholasrhoades/models/Hermes-4.3-36B-6bit-mlx'
process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

/** Figures an agent cannot know without looking them up. */
const NUMBERISH = /\$[\d,]+|\b\d{4}-\d{2}-\d{2}\b|\byou have \d+\b|\b\d+\s+(vacant|occupied|open|pending|overdue|delinquent)\b/i
const PLACEHOLDER = /\[[a-z_]+\.[A-Za-z_]+\]|\{\{[^}]+\}\}/
const MARKDOWN = /\*\*|^#{1,6}\s/m

function repetitionRatio(text: string): number {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 15)
  if (lines.length < 3) return 0
  return 1 - new Set(lines).size / lines.length
}

interface Outcome { ok: boolean; flags: string[]; tools: string[]; text: string }

async function runOne(intent: Intent, phrasing: string, actor: any): Promise<Outcome> {
  const r: any = await runAgentSession({ audience: intent.audience, actor, message: phrasing } as any)
  const text = String(r.reply ?? '')
  const tools = (r.toolInvocations ?? []).map((t: any) => t.name)

  const flags: string[] = []
  if (intent.needsTool && tools.length === 0 && NUMBERISH.test(text)) flags.push('FABRICATED')
  if (PLACEHOLDER.test(text)) flags.push('PLACEHOLDER')
  if (MARKDOWN.test(text)) flags.push('MARKDOWN')
  if (repetitionRatio(text) > 0.4) flags.push('REPEATS')
  if (intent.expect && !text.toLowerCase().includes(intent.expect.toLowerCase())) {
    flags.push(`MISSING("${intent.expect}")`)
  }
  const leaked = (intent.mustNotContain ?? []).filter((n) => text.toLowerCase().includes(n.toLowerCase()))
  if (leaked.length) flags.push(`LEAKED(${leaked.join(', ')})`)

  return { ok: flags.length === 0, flags, tools, text }
}

async function main() {
  const filter = (process.argv[2] ?? '').toLowerCase()

  const [tenant] = await query<any>(
    `SELECT u.id AS user_id, t.id AS tenant_id
       FROM users u JOIN tenants t ON t.user_id = u.id
       JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status='active'
       JOIN leases l ON l.id = lt.lease_id AND l.status='active'
      WHERE u.email = 'bob@tenant.dev' LIMIT 1`)
  const [lord] = await query<any>(
    `SELECT u.id AS user_id, ll.id AS landlord_id
       FROM users u JOIN landlords ll ON ll.user_id = u.id
      WHERE u.email = 'james@demo.dev' LIMIT 1`)
  if (!tenant || !lord) throw new Error('battery actors missing — seed the demo data first')

  const actorFor = (a: string) => a === 'tenant'
    ? { userId: tenant.user_id, role: 'tenant', profileId: tenant.tenant_id }
    : { userId: lord.user_id, role: 'landlord', profileId: lord.landlord_id }

  const intents = ALL_INTENTS.filter((i) =>
    !filter || i.audience === filter || i.id.includes(filter))

  let total = 0, passed = 0
  const weak: string[] = []
  const tally: Record<string, number> = {}

  for (const intent of intents) {
    const results: Outcome[] = []
    for (const phrasing of intent.phrasings) {
      let out: Outcome
      try {
        out = await runOne(intent, phrasing, actorFor(intent.audience))
      } catch (e: any) {
        out = { ok: false, flags: [`ERROR(${e.message})`], tools: [], text: '' }
      }
      results.push(out)
      total++
      if (out.ok) passed++
      for (const f of out.flags) tally[f.replace(/\(.*/, '')] = (tally[f.replace(/\(.*/, '')] ?? 0) + 1
    }

    const n = results.filter((r) => r.ok).length
    const mark = n === results.length ? '✓' : '✗'
    console.log(`\n${mark} [${intent.audience}] ${intent.id}  ${n}/${results.length}`)
    if (n < results.length) weak.push(`${intent.audience}/${intent.id} ${n}/${results.length}`)
    results.forEach((r, i) => {
      if (r.ok) { console.log(`     ok   "${intent.phrasings[i]}"`); return }
      console.log(`     FAIL "${intent.phrasings[i]}"  ${r.flags.join(' ')}  tools=[${r.tools.join(', ') || 'none'}]`)
      console.log(`          > ${r.text.replace(/\n+/g, ' | ').slice(0, 200)}`)
    })
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`SCORE ${passed}/${total} phrasings across ${intents.length} intents`)
  console.log(`flags: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`)
  if (weak.length) {
    console.log(`\nINTENTS WITH A WORDING THAT FALLS THROUGH:`)
    weak.forEach((w) => console.log(`  ${w}`))
  }
  process.exit(passed === total ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
