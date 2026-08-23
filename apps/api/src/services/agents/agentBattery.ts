/**
 * Agent battery — drives the REAL production path and scores the result.
 *
 * S617 (Nic): "Why are you not testing on the same flow that production goes
 * through? That's the only thing we need to be testing." So this calls
 * runAgentSession with a real signed-in actor, exactly as routes/agent.ts does —
 * real tools, real retrieval, real profile.
 *
 * It exists to make "did that change make it better or worse" answerable with a
 * number instead of a vibe. Every case asks for data GAM actually stores, so a
 * reply containing figures with no tool call is a fabrication by construction.
 *
 *   DB_NAME=gam npx ts-node src/services/agents/agentBattery.ts
 *
 * Not part of the vitest suite: it needs the live model and embeddings servers.
 *
 * The daily per-user turn budget is raised for the run. Left at its default of
 * 60, running the battery a few times in one day exhausts the test tenant and
 * the agent starts replying "I've hit my limit for our conversations today" —
 * which then scores as a fabrication failure when it is nothing of the kind.
 * Measuring the agent means not tripping a rate limit meant for real people.
 */
// The landlord allowance derives from this one (landlordPerUnit defaults to
// tenantDaily / 8), so raising it covers both audiences.
process.env.AGENT_TENANT_DAILY_TURNS ||= '100000'
process.env.AGENT_TENANT_DAILY_OFFTOPIC ||= '100000'
process.env.AGENT_LANDLORD_DAILY_OFFTOPIC ||= '100000'
import { runAgentSession } from './agentSession'
import { query } from '../../db'

process.env.LLM_ENDPOINT ||= 'http://localhost:8080/v1'
process.env.LLM_MODEL ||= '/Users/nicholasrhoades/models/Hermes-4.3-36B-6bit-mlx'
process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

interface Case {
  audience: 'tenant' | 'landlord'
  message: string
  /** true when the answer must come from a tool, not the knowledge base. */
  needsTool: boolean
  /** substring that must appear (a fact verified against SQL). */
  expect?: string
}

const CASES: Case[] = [
  // ── tenant: only their own lease, portal and landlord ──
  { audience: 'tenant', message: 'when does my lease end?',                needsTool: true,  expect: '2027' },
  { audience: 'tenant', message: 'whats my rent amount',                   needsTool: true,  expect: '750' },
  { audience: 'tenant', message: 'how much do I owe right now?',           needsTool: true,  expect: '2,330' },
  { audience: 'tenant', message: 'how much was my security deposit?',      needsTool: true,  expect: '750' },
  { audience: 'tenant', message: 'do I have any open maintenance requests',needsTool: true  },
  { audience: 'tenant', message: 'what card do I have on file',            needsTool: true  },
  { audience: 'tenant', message: 'did my last payment go through',         needsTool: true  },
  { audience: 'tenant', message: 'how do late fees work',                  needsTool: false },
  { audience: 'tenant', message: 'what is FlexVault?',                     needsTool: false },
  // ── landlord: platform capability, or a portfolio fact. Nothing between ──
  { audience: 'landlord', message: 'how many units do I have vacant',      needsTool: true,  expect: '15' },
  { audience: 'landlord', message: 'whats my occupancy',                   needsTool: true,  expect: '15' },
  { audience: 'landlord', message: 'any leases expiring soon',             needsTool: true,  expect: 'Apt 204' },
  { audience: 'landlord', message: 'is bob behind on rent?',               needsTool: true,  expect: '2,330' },
  { audience: 'landlord', message: 'how much does apt 101 owe',            needsTool: true,  expect: '2,330' },
  { audience: 'landlord', message: 'is anyone behind on rent?',            needsTool: true,  expect: 'Frank' },
  { audience: 'landlord', message: 'any maintenance waiting on me',        needsTool: true  },
  { audience: 'landlord', message: 'how do payouts work?',                 needsTool: false },
  { audience: 'landlord', message: 'what is the platform fee?',            needsTool: false, expect: '$2' },
]

const NUMBERISH = /\$[\d,]+|\b\d{4}-\d{2}-\d{2}\b|\byou have \d+\b|\b\d+\s+(vacant|occupied|open|pending|overdue|delinquent)\b/i
const PLACEHOLDER = /\[[a-z_]+\.[A-Za-z_]+\]|\{\{[^}]+\}\}/
const MARKDOWN = /\*\*|^#{1,6}\s/m

/** A reply that says the same sentence again and again. */
function repetitionRatio(text: string): number {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 15)
  if (lines.length < 3) return 0
  return 1 - new Set(lines).size / lines.length
}

async function main() {
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
    ? { userId: tenant.user_id, role: 'tenant',   profileId: tenant.tenant_id }
    : { userId: lord.user_id,   role: 'landlord', profileId: lord.landlord_id }

  let pass = 0, fabricated = 0, missingFact = 0, placeholders = 0, markdown = 0, repetitive = 0, toolCalls = 0
  for (const c of CASES) {
    const r: any = await runAgentSession({
      audience: c.audience, actor: actorFor(c.audience), message: c.message,
    } as any)
    const text = String(r.reply ?? '')
    const tools = (r.toolInvocations ?? []).map((t: any) => t.name)
    toolCalls += tools.length

    const isFabrication = c.needsTool && tools.length === 0 && NUMBERISH.test(text)
    const hasPlaceholder = PLACEHOLDER.test(text)
    const hasMarkdown = MARKDOWN.test(text)
    const rep = repetitionRatio(text)
    const factMissing = !!c.expect && !text.includes(c.expect)

    if (isFabrication) fabricated++
    if (hasPlaceholder) placeholders++
    if (hasMarkdown) markdown++
    if (rep > 0.4) repetitive++
    if (factMissing) missingFact++
    const ok = !isFabrication && !hasPlaceholder && !hasMarkdown && rep <= 0.4 && !factMissing
    if (ok) pass++

    const flags = [
      isFabrication && 'FABRICATED', hasPlaceholder && 'PLACEHOLDER',
      hasMarkdown && 'MARKDOWN', rep > 0.4 && `REPEATS(${rep.toFixed(2)})`,
      factMissing && `MISSING("${c.expect}")`,
    ].filter(Boolean)
    console.log(`${ok ? ' ok ' : 'FAIL'} [${c.audience}] ${c.message}`)
    console.log(`       tools=${tools.length} [${[...new Set(tools)].join(', ') || 'none'}] ${flags.join(' ')}`)
    if (!ok) console.log(`       > ${text.replace(/\n+/g, ' | ').slice(0, 220)}`)
  }

  console.log(`\n══ SCORE ${pass}/${CASES.length} ══`)
  console.log(`   fabricated=${fabricated} placeholders=${placeholders} markdown=${markdown} repetitive=${repetitive} missingFact=${missingFact} totalToolCalls=${toolCalls}`)
  process.exit(pass === CASES.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
