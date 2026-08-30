/**
 * Two-turn conversation harness.
 *
 * Runs the REAL production path twice: runAgentSession for the opener, then
 * again with the first exchange as history — the same `history` field
 * routes/agent.ts passes. Nothing is stubbed, so turn two inherits whatever
 * context handling turn one produced, which is the point.
 *
 * Assertions are on TURN TWO. Turn one is already covered by agentBattery.ts
 * (207/207 across 54 intents) and re-asserting it here would just be noise.
 *
 * Both replies are printed for every case, passing or failing. Nic: "our test
 * is only gonna be as good as the landlord or tenant's responses to the first
 * responses" — so a human has to be able to read the exchange and judge
 * whether the follow-up was a fair thing for a person to say. A score with no
 * transcript cannot be audited that way.
 *
 *   DB_NAME=gam npx ts-node src/services/agents/agentConversations.ts
 *   DB_NAME=gam npx ts-node src/services/agents/agentConversations.ts guest
 *
 * RUN IT ALONE — two loads on the 36B kills it and produces meaningless scores.
 */
// S620: RAISE THE ABUSE CAP FOR THE HARNESS, before anything imports the
// budget config. The daily turn budget is 60 productive turns for a tenant and
// max(60, 7.5 x occupied units) for a landlord — sized for one human, and this
// suite plus the battery burn hundreds through the same two demo accounts.
//
// The first full run scored 9/19 and EIGHT of those failures were this: every
// tenant and landlord turn came back "I've hit my limit for our conversations
// today". Nothing to do with the agents.
//
// Why it hit here and not the battery: the budget is checked AFTER the answer
// cache on purpose ("cached answers cost nothing"), and the battery sends no
// history so it is cache-eligible. Turn two ALWAYS carries history, so it can
// never be served from cache and always reaches the budget check.
//
// Raised, not bypassed — the real check still runs, so a genuine budget
// regression would still surface.
process.env.AGENT_TENANT_DAILY_TURNS ||= '100000'
process.env.AGENT_LANDLORD_TURNS_PER_UNIT ||= '100000'
process.env.AGENT_TENANT_DAILY_OFFTOPIC ||= '100000'
process.env.AGENT_LANDLORD_DAILY_OFFTOPIC ||= '100000'

// S626: SEED IT, like agentEval.ts does. Agents sample at temperature 0.6, so
// an unseeded run of this harness is ONE DRAW and two runs of a byte-identical
// file disagree. S624 reverted a batch of good work over a 4-point swing that
// was noise. If the transcripts are going to be compared before and after an
// edit — which is the entire point of an overnight loop — the sampling has to
// be the constant. Same seed as the eval, for the same reason.
process.env.AGENT_SAMPLER_SEED ||= '424242'

// S626: PACE IT. This is a GPU-safety change, not a performance one.
//
// The Mac Studio kernel-panicked TWICE on 2026-08-26 with
// `completeMemory() prepare count underflow` @IOGPUMemory.cpp:550 — a macOS
// GPU memory refcount bug that continuous Metal allocation from the 36B model
// walks straight into. The second panic took Postgres down with it for eleven
// minutes, and that machine also serves production.
//
// agentEval.ts already pauses between cases (AGENT_EVAL_PAUSE_MS, default
// 3000). THIS harness did not, and it is strictly heavier: every conversation
// is TWO full generations, and turn two always carries history so it can never
// be served from the answer cache. It was the un-paced job on the box.
//
// The problem is CADENCE, not concurrency — the suite is already sequential.
process.env.AGENT_EVAL_PAUSE_MS ||= '5000'


import { ALL_TOOLS } from './tools'
import { runAgentSession } from './agentSession'
import { query, queryOne } from '../../db'
import { buildTestActors } from './agentActors'
import { ALL_CONVERSATIONS, type Conversation } from './agentConversationCases'

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', O = '\x1b[0m'

/** Does a reply end on a question without ever giving a figure? That is the
 *  "asked me twice" failure — Nic: one clarifying question, then an answer. */
function asksAgain(text: string): boolean {
  const t = text.trim()
  if (!t.endsWith('?')) return false
  // A question is fine if the answer came WITH it ("that's $2,330 — different
  // Chen?"). It is only a failure when nothing was answered at all.
  return !/\$[\d,]+|\b\d{2,}\b/.test(t)
}

/**
 * Did turn two just re-read turn one?
 *
 * S620, and the biggest thing this suite found. 5 of 19 conversations came
 * back with the second reply repeating the first almost word for word — a
 * tenant who said "no thanks, I'll sort it out myself later" got the entire
 * balance breakdown read at them again, and one who said "yes please, go
 * ahead" was told "I've filed a maintenance request for you" a second time
 * (having also filed a second request).
 *
 * THREE OF THOSE FIVE PASSED every other assertion. Tools fired, no forbidden
 * phrase appeared — and the reply was still useless, because it answered the
 * previous question. Nothing in the guard chain looks across turns:
 * collapseRepetition dedupes lines WITHIN one reply and has no idea what was
 * said a moment ago.
 *
 * Measured as a shared prefix rather than equality: the repeats are not
 * byte-identical, they trail off differently or append a clause ("...until the
 * entire balance is settled"). A long identical OPENING is the signal.
 */
function repeatsTurnOne(turn1: string, turn2: string): boolean {
  const a = turn1.replace(/\s+/g, ' ').trim()
  const b = turn2.replace(/\s+/g, ' ').trim()
  if (!a || !b) return false
  if (a === b) return true
  let i = 0
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
  // 60 chars of identical opening, or half of the shorter reply — whichever is
  // the weaker bar — is well past coincidence for two different questions.
  return i >= 60 || i >= Math.min(a.length, b.length) * 0.5
}

interface Result {
  conv: Conversation; flags: string[]; turn1: string; turn2: string
  tools1: string[]; tools2: string[]; leaks1: string[]; leaks2: string[]
}

/**
 * S630 — WHAT THE AGENT REVEALS.
 *
 * Nothing checked whether a reply exposed the machinery behind it. Nic asked
 * for this after reading a transcript that appeared to end by naming a tool:
 * that instance turned out to be a log-parsing fault, not the agent, but the
 * question it raised had no answer in the run — if a reply HAD leaked a tool
 * name, an internal id, or a column name, every assertion here would still have
 * passed it.
 *
 * A person on the other end of this should never see the plumbing. Tool names,
 * uuids, snake_case column names, JSON fragments and stack noise are all things
 * only the system knows, and any of them in a reply is a failure whatever else
 * the reply got right.
 */
const TOOL_NAMES = ALL_TOOLS.map((t) => t.name)
function leaksInternals(reply: string): string[] {
  const found: string[] = []
  if (!reply) return found
  for (const name of TOOL_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(reply)) found.push(`tool:${name}`)
  }
  const uuid = reply.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)
  if (uuid) found.push(`uuid:${uuid[0].slice(0, 8)}…`)
  // Internal identifiers the product never says out loud. Deliberately a named
  // list, not a snake_case regex — "check-in" and "move-in" are English.
  for (const col of ['unit_id', 'lease_id', 'tenant_id', 'landlord_id', 'property_id',
                     'payment_method_id', 'charge_id', 'booking_id', 'user_id',
                     'stripe_customer_id', 'profileId', 'unitId', 'leaseId', 'tenantId']) {
    if (new RegExp(`\\b${col}\\b`).test(reply)) found.push(`field:${col}`)
  }
  // S630 (Nic): the SPOKEN form is the one that actually reached a landlord —
  // "the system encountered an issue with the lease ID provided. Could you
  // confirm the lease ID?" An internal key does not stop being internal because
  // it was written with a space and a capital.
  const spoken = reply.match(/\b(unit|lease|tenant|landlord|property|booking|charge|payment method|customer)\s+ID\b/i)
  if (spoken) found.push(`spoken-id:${spoken[0]}`)
  if (/\{\s*"|"\s*:\s*"|\[\s*"/.test(reply)) found.push('json-fragment')
  if (/\b(null|undefined|NaN)\b/.test(reply)) found.push('null-ish')
  return found
}

async function runConversation(conv: Conversation, actor: any): Promise<Result> {
  const first: any = await runAgentSession({
    audience: conv.audience, actor, message: conv.opener,
  } as any)
  const turn1 = String(first.reply ?? '')
  const tools1 = (first.toolInvocations ?? []).map((t: any) => t.name)

  const second: any = await runAgentSession({
    audience: conv.audience, actor, message: conv.followUp,
    history: [
      { role: 'user', content: conv.opener },
      { role: 'assistant', content: turn1 },
    ],
  } as any)
  const turn2 = String(second.reply ?? '')
  const tools2 = (second.toolInvocations ?? []).map((t: any) => t.name)

  const flags: string[] = []
  if (conv.expectTool && !tools2.includes(conv.expectTool)) {
    flags.push(`WRONGTOOL(wanted ${conv.expectTool})`)
  }
  if (conv.expectToolAny?.length && !conv.expectToolAny.some((t) => tools2.includes(t))) {
    flags.push(`WRONGTOOL(wanted any of ${conv.expectToolAny.join(' / ')})`)
  }
  if (conv.expectNoTool && tools2.length) flags.push(`UNWANTEDTOOL(${tools2.join(', ')})`)
  const banned = (conv.mustNotTool ?? []).filter((t) => tools2.includes(t))
  if (banned.length) flags.push(`RANTWICE(${banned.join(', ')})`)
  if (conv.expect && !turn2.toLowerCase().includes(conv.expect.toLowerCase())) {
    flags.push(`MISSING("${conv.expect}")`)
  }
  if (conv.expectAny?.length && !conv.expectAny.some((e) => turn2.toLowerCase().includes(e.toLowerCase()))) {
    flags.push(`MISSING(any of ${conv.expectAny.join(' / ')})`)
  }
  const said = (conv.mustNotContain ?? []).filter((n) => turn2.toLowerCase().includes(n.toLowerCase()))
  if (said.length) flags.push(`SAID(${said.join(', ')})`)
  if (conv.mustNotAskAgain && asksAgain(turn2)) flags.push('ASKED_AGAIN')
  if (!turn2.trim()) flags.push('EMPTY')
  // Applies to EVERY conversation — no case has to opt in. Answering the
  // previous question is a failure whatever else the reply got right.
  if (repeatsTurnOne(turn1, turn2)) flags.push('REPEATS_TURN_1')

  // S630: applies to BOTH turns and to every conversation. Turn one was
  // previously unaudited entirely — its tools were never recorded and its reply
  // was judged only by what it said.
  const leaks1 = leaksInternals(turn1)
  const leaks2 = leaksInternals(turn2)
  if (leaks1.length) flags.push(`LEAKED_TURN_1(${leaks1.join(', ')})`)
  if (leaks2.length) flags.push(`LEAKED(${leaks2.join(', ')})`)

  return { conv, flags, turn1, turn2, tools1, tools2, leaks1, leaks2 }
}

const wrap = (s: string, indent: string) =>
  s.split('\n').filter(Boolean).map((l) => indent + l).join('\n')

/**
 * THIS SUITE MUTATES ITS OWN FIXTURE, so it puts it back.
 *
 * Unlike the single-turn battery, turn two is where actions actually fire —
 * that is the whole reason the suite exists. `extra_night` genuinely extends
 * the booking, and the battery asserts that same booking's dates ("July 10",
 * "5 nights", "$364"). Left alone, running conversations would silently break
 * three battery cases and each re-run would push the checkout out another day.
 *
 * A harness that measures actions has to undo them.
 */
async function snapshotBooking(bookingId: string | null) {
  if (!bookingId) return null
  return queryOne<any>(
    `SELECT check_in, check_out, nights, status, total_amount FROM unit_bookings WHERE id=$1`,
    [bookingId])
}

async function restoreBooking(bookingId: string | null, snap: any) {
  if (!bookingId || !snap) return
  const after = await queryOne<any>(`SELECT check_out, nights FROM unit_bookings WHERE id=$1`, [bookingId])
  const changed = String(after?.check_out) !== String(snap.check_out) || after?.nights !== snap.nights
  await query(
    `UPDATE unit_bookings
        SET check_in=$1, check_out=$2, nights=$3, status=$4, total_amount=$5, updated_at=NOW()
      WHERE id=$6`,
    [snap.check_in, snap.check_out, snap.nights, snap.status, snap.total_amount, bookingId])
  // Change requests the run filed against this booking are test rows too.
  await query(`DELETE FROM booking_change_requests WHERE booking_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [bookingId]).catch(() => {})
  if (changed) console.log(`${D}\n[fixture] booking restored (the run had moved it)${O}`)
}

async function main() {
  const pauseMs = Number(process.env.AGENT_EVAL_PAUSE_MS ?? 5000)
  const filter = (process.argv[2] ?? '').toLowerCase()
  const { actorFor, bookingId } = await buildTestActors()
  const convs = ALL_CONVERSATIONS.filter(
    (c) => !filter || c.audience === filter || c.id.includes(filter))
  const snap = convs.some((c) => c.audience === 'guest') ? await snapshotBooking(bookingId) : null

  console.log(`\n${convs.length} two-turn conversation(s)  ${D}seed=${process.env.AGENT_SAMPLER_SEED} pause=${pauseMs}ms${O}\n${'═'.repeat(60)}`)
  const results: Result[] = []
  try {
  let first = true
  for (const conv of convs) {
    // Let the GPU's memory settle between conversations. See the pacing note
    // at the top of this file — this is what keeps the box alive overnight.
    if (!first && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs))
    first = false
    const r = await runConversation(conv, actorFor(conv.audience))
    results.push(r)
    const mark = r.flags.length ? `${R}✗${O}` : `${G}✓${O}`
    console.log(`\n${mark} [${conv.audience}] ${conv.id}`)
    console.log(`${D}   ${conv.behaviour}${O}`)
    console.log(`${Y}   ▸ ${conv.opener}${O}`)
    console.log(wrap(r.turn1, '     '))
    console.log(`${Y}   ▸ ${conv.followUp}${O}`)
    console.log(wrap(r.turn2, '     '))
    console.log(`${D}     tools(turn 1): ${r.tools1.length ? r.tools1.join(', ') : 'none'}${O}`)
    console.log(`${D}     tools(turn 2): ${r.tools2.length ? r.tools2.join(', ') : 'none'}${O}`)
    if (r.flags.length) console.log(`${R}     ${r.flags.join('  ')}${O}`)
  }
  } finally {
    // Restore even on a crash — a half-run that extended the booking and threw
    // would leave the battery asserting against moved dates.
    await restoreBooking(bookingId, snap)
  }

  // S630: the transcript is DATA, not console output. It was being recovered by
  // scraping this log, and the scrape twice pulled neighbouring debug lines into
  // a reply — once making it look as though the agent had named a tool out loud.
  // Anything that needs the transcripts reads this file instead.
  const jsonPath = process.env.AGENT_CONV_JSON
  if (jsonPath) {
    const fs = await import('fs')
    fs.writeFileSync(jsonPath, JSON.stringify({
      seed: process.env.AGENT_SAMPLER_SEED ?? null,
      db: process.env.DB_NAME ?? null,
      model: process.env.LLM_MODEL ?? null,
      total: results.length,
      passed: results.filter((r) => !r.flags.length).length,
      conversations: results.map((r) => ({
        id: r.conv.id, audience: r.conv.audience, behaviour: r.conv.behaviour,
        pass: r.flags.length === 0, flags: r.flags,
        turns: [
          { user: r.conv.opener,   agent: r.turn1, tools: r.tools1, leaks: r.leaks1 },
          { user: r.conv.followUp, agent: r.turn2, tools: r.tools2, leaks: r.leaks2 },
        ],
      })),
    }, null, 2))
    console.log(`\n${D}transcripts written to ${jsonPath}${O}`)
  }

  const passed = results.filter((r) => !r.flags.length).length
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`SCORE ${passed}/${results.length} conversations`)
  const leaked = results.filter((r) => r.leaks1.length || r.leaks2.length)
  if (leaked.length) {
    console.log(`\nREVEALED INTERNALS in ${leaked.length} conversation(s):`)
    for (const r of leaked) {
      console.log(`  ${r.conv.audience}/${r.conv.id}  ${[...r.leaks1, ...r.leaks2].join(', ')}`)
    }
  } else {
    console.log('no conversation revealed a tool name, id, or field name')
  }
  const failed = results.filter((r) => r.flags.length)
  if (failed.length) {
    console.log('\nFAILING:')
    for (const f of failed) console.log(`  ${f.conv.audience}/${f.conv.id}  ${f.flags.join(' ')}`)
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
}
