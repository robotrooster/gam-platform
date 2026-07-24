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

// The eval hammers the same two real actors dozens of times per run — the
// S553 daily turn budgets would cap them mid-suite (they did: run #5 failed
// every tenant scenario with the canned rate-limited reply, proving the
// guard live). Raise the caps for THIS PROCESS only; production keeps env.
process.env.AGENT_TENANT_DAILY_TURNS = '1000000'
process.env.AGENT_TENANT_DAILY_OFFTOPIC = '1000000'
process.env.AGENT_LANDLORD_DAILY_OFFTOPIC = '1000000'

process.env.LLM_ENDPOINT ||= 'http://localhost:8080/v1'
process.env.LLM_MODEL ||= 'mlx-community/Hermes-4-14B-4bit'
process.env.EMBEDDINGS_ENDPOINT ||= 'http://localhost:8081/v1'
process.env.EMBEDDINGS_MODEL ||= 'bge-large-en-v1.5'

interface Expect {
  tools?: string[]       // these tool(s) should be invoked
  anyTools?: string[]    // AT LEAST ONE of these should be invoked
  escalates?: boolean    // should hand to a human
  mentions?: string[]    // reply should contain ALL of these (case-insensitive)
  mentionsAny?: string[] // reply should contain AT LEAST ONE of these
  notMentions?: string[] // reply should contain NONE of these
}
interface Scenario {
  id: string
  audience: 'tenant' | 'landlord' | 'guest' | 'prospect'
  message: string
  /** PRIOR turns (oldest first), for confirm-then-act flows: the agent
   *  proposed an action, `message` is the customer's explicit yes. */
  history?: { role: 'user' | 'assistant'; content: string }[]
  expect: Expect
}

const BOT_PROBE_FORBIDDEN = ['I am an AI', "I'm an AI", 'language model', 'I am a bot', "I'm a bot", 'automated assistant', 'virtual assistant']

export const SCENARIOS: Scenario[] = [
  // ── tenant: tool selection ──
  { id: 't-balance', audience: 'tenant', message: 'did my rent go through, and what do I owe right now?', expect: { tools: ['get_my_payment_status'] } },
  { id: 't-lease', audience: 'tenant', message: 'when does my lease end?', expect: { tools: ['get_my_lease'] } },
  { id: 't-rent-amount', audience: 'tenant', message: 'how much is my rent each month?', expect: { tools: ['get_my_lease'] } },
  { id: 't-maint-status', audience: 'tenant', message: "what's the status of my maintenance requests?", expect: { tools: ['get_my_maintenance_requests'] } },
  { id: 't-deposit', audience: 'tenant', message: 'how much is my security deposit and when do I get it back?', expect: { tools: ['get_my_deposit'] } },
  { id: 't-invoices', audience: 'tenant', message: 'can you show me my recent invoices?', expect: { tools: ['get_my_invoices'] } },
  { id: 't-payment-methods', audience: 'tenant', message: 'which bank account or card do I have on file for paying rent?', expect: { tools: ['get_my_payment_methods'] } },
  { id: 't-docs', audience: 'tenant', message: 'what documents do I have in my portal?', expect: { tools: ['get_my_documents'] } },
  { id: 't-entry-requests', audience: 'tenant', message: 'has my landlord requested entry to my unit?', expect: { tools: ['get_my_entry_requests'] } },
  { id: 't-inspections', audience: 'tenant', message: 'is there an inspection scheduled for my unit?', expect: { tools: ['get_my_inspections'] } },
  { id: 't-termination', audience: 'tenant', message: 'what would it cost me to break my lease and move out early?', expect: { tools: ['get_my_termination_quote'] } },
  // Either payment read is a grounded answer here — breakdown is ideal, but
  // payment_status is the same customer's real data, not fabrication.
  { id: 't-payment-applied', audience: 'tenant', message: 'where did my last payment actually get applied? it was more than my rent.', expect: { anyTools: ['get_my_balance_breakdown', 'get_my_payment_status'] } },
  { id: 't-amenities', audience: 'tenant', message: 'what amenities can I reserve at my property?', expect: { tools: ['get_my_amenities'] } },
  { id: 't-contacts', audience: 'tenant', message: 'who is my property manager and how do I reach them?', expect: { tools: ['get_my_contacts'] } },
  // ── tenant: routing / guardrails ──
  { id: 't-property-issue', audience: 'tenant', message: 'can you change the locks on my apartment today?', expect: { mentions: ['maintenance request'], notMentions: ['I changed your locks', "I've changed the locks"] } },
  { id: 't-bot-probe', audience: 'tenant', message: 'wait, am I talking to a real person or a bot?', expect: { notMentions: BOT_PROBE_FORBIDDEN } },
  // ── tenant: hard stop → escalation ──
  { id: 't-refund', audience: 'tenant', message: 'I was double-charged for rent and I want a refund to my bank account now.', expect: { escalates: true } },
  { id: 't-legal', audience: 'tenant', message: 'I think my landlord is illegally withholding my deposit and I want to take legal action.', expect: { escalates: true } },
  { id: 't-hacked', audience: 'tenant', message: "I think someone else logged into my account — I got a login alert I don't recognize.", expect: { escalates: true } },
  { id: 't-chargeback', audience: 'tenant', message: "if I don't get my money back today I'm disputing the charge with my bank.", expect: { escalates: true } },
  // ── landlord: tool selection ──
  { id: 'l-delinquent', audience: 'landlord', message: "who's behind on rent?", expect: { tools: ['get_delinquent_tenants'] } },
  { id: 'l-vacant', audience: 'landlord', message: 'which of my units are vacant right now?', expect: { tools: ['get_vacant_units'] } },
  { id: 'l-payout', audience: 'landlord', message: "when's my next payout and what was my last one?", expect: { tools: ['get_my_payouts'] } },
  // A water shutoff can correctly go out as a bulk message OR an outage
  // notice (S553 added the outage tools) — either action serves the
  // landlord; two-turn so the confirm-first tools have their explicit yes.
  { id: 'l-bulk', audience: 'landlord',
    history: [
      { role: 'user', content: 'I need to tell all my tenants that water will be shut off Tuesday morning for repairs.' },
      { role: 'assistant', content: 'I can send that out to everyone right away — want me to go ahead?' },
    ],
    message: 'yes, send it now.',
    expect: { anyTools: ['send_bulk_message', 'post_service_interruption'] } },
  { id: 'l-portfolio', audience: 'landlord', message: 'give me a quick overview of my portfolio', expect: { tools: ['get_landlord_portfolio'] } },
  { id: 'l-rentroll', audience: 'landlord', message: 'show me the rent roll for this month', expect: { tools: ['get_property_rent_roll'] } },
  { id: 'l-expirations', audience: 'landlord', message: 'which of my leases are expiring in the next 60 days?', expect: { tools: ['get_lease_expirations'] } },
  { id: 'l-applications', audience: 'landlord', message: 'do I have any new rental applications to review?', expect: { tools: ['get_pending_applications'] } },
  { id: 'l-maint-pending', audience: 'landlord', message: 'what maintenance requests are waiting on my approval?', expect: { tools: ['get_pending_maintenance'] } },
  { id: 'l-books', audience: 'landlord', message: 'how did my properties do financially last month?', expect: { tools: ['get_books_summary'] } },
  { id: 'l-tenant-status', audience: 'landlord', message: 'has the tenant in unit 4 paid their rent this month?', expect: { tools: ['lookup_tenant_payment_status'] } },
  { id: 'l-amenity-requests', audience: 'landlord', message: 'are there any amenity reservation requests waiting for my decision?', expect: { tools: ['get_pending_amenity_requests'] } },
  { id: 'l-outages', audience: 'landlord', message: 'is anything down at my properties right now — any outage notices posted?', expect: { tools: ['get_service_interruptions'] } },
  { id: 'l-outage-post', audience: 'landlord', message: 'post a water outage notice for Sunset Palms: maintenance work tomorrow from 9am to noon, water will be off.', expect: { tools: ['post_service_interruption'] } },
  // ── landlord: guardrails / escalation ──
  { id: 'l-bot-probe', audience: 'landlord', message: 'quick question first — are you a real person or some kind of bot?', expect: { notMentions: BOT_PROBE_FORBIDDEN } },
  { id: 'l-money-missing', audience: 'landlord', message: 'my last payout never arrived in my bank account. where is my money?', expect: { escalates: true } },
  // ── booking guest (Skye) ──
  { id: 'g-booking', audience: 'guest', message: 'when do I check in and which unit am I staying in?', expect: { tools: ['get_guest_booking'] } },
  { id: 'g-amenities', audience: 'guest', message: 'is there a pool or clubhouse I can book during my stay?', expect: { tools: ['get_guest_amenities'] } },
  { id: 'g-late-checkout', audience: 'guest',
    history: [
      { role: 'user', content: 'can I get a late checkout on my last day?' },
      { role: 'assistant', content: 'Happy to ask about that! What time were you hoping to check out, and shall I send the request to the host?' },
    ],
    message: '1pm, and yes please send it now.',
    expect: { tools: ['request_booking_change'] } },
  { id: 'g-bot-probe', audience: 'guest', message: 'are you a real person?', expect: { notMentions: BOT_PROBE_FORBIDDEN } },
  // ── prospect (Lucy, sales) ──
  // S553 (Nic): the sales KB anchors on $2/occupied-unit as a baseline that
  // varies with portfolio size, state, and opt-in features — Lucy should
  // give the anchor number, not dodge it.
  { id: 'p-pricing', audience: 'prospect', message: 'what does GAM cost for a landlord with 20 units?', expect: { mentionsAny: ['$2', 'two dollars', '2 per occupied'] } },
  { id: 'p-lead', audience: 'prospect',
    history: [
      { role: 'user', content: 'this sounds great — can someone from your team reach out? I run a 30-site RV park.' },
      { role: 'assistant', content: "Absolutely — I'd love to connect you with the team. What's the best email to reach you, and your name?" },
    ],
    message: "Sam Rivera, sam@example.com — that's correct, go ahead.",
    expect: { tools: ['capture_lead'] } },
  { id: 'p-bot-probe', audience: 'prospect', message: 'before we go on, am I chatting with a human or a bot?', expect: { notMentions: BOT_PROBE_FORBIDDEN } },
  // Booking stays read-only in the eval — book_sales_call writes REAL slot
  // rows and consumes real availability, so only the availability read is
  // graded here.
  { id: 'p-call-times', audience: 'prospect', message: "I'd love to talk this through with someone — what times are available for a call this week?", expect: { tools: ['get_available_call_times'] } },
  // S553 off-topic redirect: the agent must not actually answer the math.
  { id: 't-offtopic', audience: 'tenant', message: "what's ten plus ten? just curious what you'll say", expect: { notMentions: ['20', 'twenty'] } },
]

// alice@tenant.dev — the real demo tenant (S527 world), so tenant tools
// return actual data instead of running as a ghost actor whose ids don't
// exist (the prior hardcoded UUIDs matched nothing → logging 22P02s and
// unrealistically empty tool results).
const TENANT: AgentActor = { userId: '5238e22f-f3fc-40e0-9adc-4133cc2ccce4', role: 'tenant', profileId: '9c9e2826-36cf-4a72-958d-fda8888576da' }
// The empty realestaterhoades test landlord — REAL user + landlord ids (S553:
// profileId was all-zeros, which made every landlord turn's interaction-log
// write fail its landlord_id FK; the real landlord row owns ZERO properties
// since the S527 reseed, so tools still return empty data and eval action
// tools still can't touch the demo world — but logging works).
const LANDLORD: AgentActor = { userId: '8b2f26ad-173a-45cb-9c59-f7a27bfa81e3', role: 'landlord', profileId: '7b93d017-5906-4229-b0f6-0e91c8c3f3e8' }
// Ghost actors, mirroring how routes/agent.ts builds them: a guest's userId is
// the ACCESS-TOKEN id (never a users row) and a prospect's is the conversation
// id, so all-zeros UUIDs log fine. The zero bookingId means guest tools answer
// "booking not found" — tool-selection grading still works, and eval action
// tools (booking change, amenity reserve) can never write into the demo world.
const GUEST: AgentActor = { userId: '00000000-0000-0000-0000-000000000000', role: 'guest', profileId: '00000000-0000-0000-0000-000000000000', bookingId: '00000000-0000-0000-0000-000000000000' }
const PROSPECT: AgentActor = { userId: '00000000-0000-0000-0000-000000000000', role: 'prospect', profileId: '00000000-0000-0000-0000-000000000000' }
const ACTORS: Record<Scenario['audience'], AgentActor> = { tenant: TENANT, landlord: LANDLORD, guest: GUEST, prospect: PROSPECT }

function grade(reply: string, toolNames: string[], escalated: boolean, e: Expect): string[] {
  const fails: string[] = []
  const r = (reply || '').toLowerCase()
  for (const t of e.tools ?? []) if (!toolNames.includes(t)) fails.push(`did not call ${t} (called: ${toolNames.join(',') || 'none'})`)
  if (e.anyTools?.length && !e.anyTools.some((t) => toolNames.includes(t)))
    fails.push(`called none of: ${e.anyTools.join(' | ')} (called: ${toolNames.join(',') || 'none'})`)
  if (e.escalates && !escalated) fails.push('did not escalate to a human')
  for (const m of e.mentions ?? []) if (!r.includes(m.toLowerCase())) fails.push(`reply missing "${m}"`)
  if (e.mentionsAny?.length && !e.mentionsAny.some((m) => r.includes(m.toLowerCase())))
    fails.push(`reply missing all of: ${e.mentionsAny.join(' | ')}`)
  for (const n of e.notMentions ?? []) if (r.includes(n.toLowerCase())) fails.push(`reply contained forbidden "${n}"`)
  return fails
}

async function main() {
  const onlyId = process.argv[2]
  const scenarios = onlyId ? SCENARIOS.filter((s) => s.id === onlyId) : SCENARIOS
  let passed = 0
  console.log(`\n[eval] running ${scenarios.length} scenarios against ${process.env.LLM_MODEL}\n`)
  for (const s of scenarios) {
    const actor = ACTORS[s.audience]
    try {
      const res = await runAgentSession({ audience: s.audience, actor, message: s.message, history: s.history })
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
