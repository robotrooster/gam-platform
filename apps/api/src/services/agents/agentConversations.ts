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

interface Result { conv: Conversation; flags: string[]; turn1: string; turn2: string; tools2: string[] }

async function runConversation(conv: Conversation, actor: any): Promise<Result> {
  const first: any = await runAgentSession({
    audience: conv.audience, actor, message: conv.opener,
  } as any)
  const turn1 = String(first.reply ?? '')

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

  return { conv, flags, turn1, turn2, tools2 }
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
  const filter = (process.argv[2] ?? '').toLowerCase()
  const { actorFor, bookingId } = await buildTestActors()
  const convs = ALL_CONVERSATIONS.filter(
    (c) => !filter || c.audience === filter || c.id.includes(filter))
  const snap = convs.some((c) => c.audience === 'guest') ? await snapshotBooking(bookingId) : null

  console.log(`\n${convs.length} two-turn conversation(s)\n${'═'.repeat(60)}`)
  const results: Result[] = []
  try {
  for (const conv of convs) {
    const r = await runConversation(conv, actorFor(conv.audience))
    results.push(r)
    const mark = r.flags.length ? `${R}✗${O}` : `${G}✓${O}`
    console.log(`\n${mark} [${conv.audience}] ${conv.id}`)
    console.log(`${D}   ${conv.behaviour}${O}`)
    console.log(`${Y}   ▸ ${conv.opener}${O}`)
    console.log(wrap(r.turn1, '     '))
    console.log(`${Y}   ▸ ${conv.followUp}${O}`)
    console.log(wrap(r.turn2, '     '))
    console.log(`${D}     tools(turn 2): ${r.tools2.length ? r.tools2.join(', ') : 'none'}${O}`)
    if (r.flags.length) console.log(`${R}     ${r.flags.join('  ')}${O}`)
  }
  } finally {
    // Restore even on a crash — a half-run that extended the booking and threw
    // would leave the battery asserting against moved dates.
    await restoreBooking(bookingId, snap)
  }

  const passed = results.filter((r) => !r.flags.length).length
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`SCORE ${passed}/${results.length} conversations`)
  const failed = results.filter((r) => r.flags.length)
  if (failed.length) {
    console.log('\nFAILING:')
    for (const f of failed) console.log(`  ${f.conv.audience}/${f.conv.id}  ${f.flags.join(' ')}`)
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
}
