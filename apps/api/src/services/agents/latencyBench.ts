/**
 * S650 latency bench — real turns through runAgentSession, timed.
 *
 *   DB_NAME=gam_demo npx tsx src/services/agents/latencyBench.ts landlord
 *
 * Landlord = james@demo.dev (all demo data). Tenant = alice. Prints wall time,
 * prompt tokens, tools fired and the reply for each message, then a summary.
 * Each message is its own new conversation unless BENCH_THREAD=1.
 */
import { runAgentSession } from './agentSession'

const who = (process.argv[2] || 'landlord') as 'landlord' | 'tenant'
const LANDLORD = { userId: '82f40380-4779-48fa-a001-7c3f79ff56fe', landlordId: '806d37f3-846c-4054-9e03-ea4e21befe5a' }
const MESSAGES: Record<string, string[]> = {
  landlord: [
    'Are you there?',
    'Tell me more about background checks',
    'It says get paid what do i do?',
    'who is behind on rent?',
    'how many units are vacant?',
  ],
  tenant: [
    'Do i have a balance',
    'Where can I find my lease',
    'I want to cancel my deposit payment plan',
  ],
}

async function main() {
  const msgs = process.env.BENCH_MESSAGES ? process.env.BENCH_MESSAGES.split('|') : MESSAGES[who]
  const actor: any = who === 'landlord'
    ? { userId: LANDLORD.userId, role: 'landlord', profileId: '', landlordIds: [LANDLORD.landlordId],
        auth: { userId: LANDLORD.userId, role: 'landlord', landlordIds: [LANDLORD.landlordId] } }
    : { userId: process.env.BENCH_TENANT_USER!, role: 'tenant', profileId: process.env.BENCH_TENANT_PROFILE!,
        auth: { userId: process.env.BENCH_TENANT_USER!, role: 'tenant' } }
  const rows: any[] = []
  let history: any[] = []
  for (const message of msgs) {
    const t0 = Date.now()
    const res: any = await runAgentSession({ audience: who, actor, message,
      history: process.env.BENCH_THREAD === '1' ? history : undefined })
    const ms = Date.now() - t0
    const row = { message, s: +(ms / 1000).toFixed(1), promptTokens: res.usage?.promptTokens,
      tools: (res.toolInvocations || []).map((t: any) => t.name).join(','), reply: String(res.reply).slice(0, 220) }
    rows.push(row)
    console.log(JSON.stringify(row))
    history = [...history, { role: 'user', content: message }, { role: 'assistant', content: res.reply }]
  }
  const total = rows.reduce((a, r) => a + r.s, 0)
  console.log(`SUMMARY ${who}: ${rows.length} turns, mean ${(total / rows.length).toFixed(1)} s, max ${Math.max(...rows.map((r) => r.s))} s`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
