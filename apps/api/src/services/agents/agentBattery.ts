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
 *
 * RUN IT ALONE. Nothing else may touch the model while it runs — not the vitest
 * suite, not a second battery, not a one-off script. The 36B server is a single
 * process on a machine that also holds Postgres and the API; put two loads on it
 * and it dies and gets respawned by launchd. It happened three times in S617,
 * and the failure does not look like a crash: the run keeps going and every
 * remaining question fails with "LLM endpoint unreachable", which scores as 88
 * wrong answers and a meaningless 18/108. If a run shows a cliff of ERROR
 * flags, the model died — check `launchctl list | grep gam.model` before
 * believing a single number of it.
 *
 * The daily per-user turn budget is raised for the run. Left at its default of
 * 60, a full pass exhausts the test tenant and the agent starts replying "I've
 * hit my limit for our conversations today" — which then scores as a failure
 * when it is nothing of the kind. The landlord allowance derives from this one.
 */
import { randomUUID } from 'crypto'
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
  if (intent.expectTool && !tools.includes(intent.expectTool)) {
    flags.push(`WRONGTOOL(wanted ${intent.expectTool})`)
  }
  if (intent.expectToolAny?.length && !intent.expectToolAny.some((t) => tools.includes(t))) {
    flags.push(`WRONGTOOL(wanted any of ${intent.expectToolAny.join(' / ')})`)
  }
  if (PLACEHOLDER.test(text)) flags.push('PLACEHOLDER')
  if (MARKDOWN.test(text)) flags.push('MARKDOWN')
  if (repetitionRatio(text) > 0.4) flags.push('REPEATS')
  if (intent.expect && !text.toLowerCase().includes(intent.expect.toLowerCase())) {
    flags.push(`MISSING("${intent.expect}")`)
  }
  if (intent.expectAny?.length && !intent.expectAny.some((e) => text.toLowerCase().includes(e.toLowerCase()))) {
    flags.push(`MISSING(any of ${intent.expectAny.join(' / ')})`)
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

  // S620: the three audiences the battery never covered. Each actor is built
  // EXACTLY as its door in routes/agent.ts builds it — a prospect and a visitor
  // have no GAM user at all (the conversation id stands in for identity), and a
  // guest is bound entirely to one booking id. Constructing them any other way
  // would test a path that does not exist in production.
  // PINNED, not "whichever comes back first". The first draft took the latest
  // booking and the alphabetically-first site, and both moved under the
  // expectations in agentBatteryCases.ts — 11 cases scored MISSING against
  // facts belonging to a different guest at a different property. A fixture
  // the harness chooses for itself makes a correct agent look broken.
  //
  // Sunset Palms is the richer fixture and the reason it is named here: two
  // site types with nightly/weekly/MONTHLY rates and a lodging tax. Oak Park
  // has one type, no monthly rate and 0% tax, so the monthly and tax cases
  // cannot be written against it at all.
  const [booking] = await query<any>(
    `SELECT b.id
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.status = 'checked_in' AND p.booking_slug = 'sunset-palms'
      ORDER BY b.check_in DESC LIMIT 1`)
  const [site] = await query<any>(
    `SELECT id FROM properties
      WHERE booking_slug = 'sunset-palms' AND public_booking_enabled = true
      LIMIT 1`)

  const actorFor = (a: string): any => {
    switch (a) {
      case 'tenant':
        return { userId: tenant.user_id, role: 'tenant', profileId: tenant.tenant_id }
      case 'landlord':
        return { userId: lord.user_id, role: 'landlord', profileId: lord.landlord_id }
      case 'prospect': {
        // Anonymous — the sales profile has no account-data tools, so there is
        // nothing to scope and the session id IS the identity.
        const id = randomUUID()
        return { userId: id, role: 'prospect', profileId: id }
      }
      case 'guest':
        // Bound to the token's booking; userId carries the token id, not a user.
        return { userId: randomUUID(), role: 'guest', profileId: booking.id, bookingId: booking.id }
      case 'visitor': {
        // Hard-scoped to one property: profileId AND propertyId are its id.
        const id = randomUUID()
        return { userId: id, role: 'visitor', profileId: site.id, propertyId: site.id }
      }
      default:
        throw new Error(`battery: no actor for audience '${a}'`)
    }
  }

  const intents = ALL_INTENTS.filter((i) =>
    !filter || i.audience === filter || i.id.includes(filter))

  // Fail loudly and EARLY when the data an audience needs is absent, rather
  // than scoring 0/N and reading like the agent broke. Checked against the
  // FILTERED set so `battery tenant` never demands a booking site.
  if (intents.some((i) => i.audience === 'guest') && !booking) {
    throw new Error("battery: no checked-in booking at sunset-palms — the guest cases have nothing to run against")
  }
  if (intents.some((i) => i.audience === 'visitor') && !site) {
    throw new Error("battery: sunset-palms booking site not published — the visitor cases have nothing to run against")
  }

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
