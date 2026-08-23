/**
 * Agent engine — tool-using runner (Step 4).
 *
 * The full answer path for a profile that has tools: retrieve scoped
 * knowledge (grounding), then drive the chat endpoint in a loop —
 * whenever the model asks to call a tool, execute it (hard-scoped to the
 * logged-in actor), feed the REAL result back, and continue until the
 * model produces a final text answer.
 *
 * Safety properties:
 *   - tools are limited to the profile's allowlist ∩ audience
 *   - every tool runs against `actor`; the model never supplies identity
 *   - the model's text emitted alongside a tool call is discarded — only
 *     the actual tool result reaches the next turn (no hallucinated
 *     "done!" before the work happened)
 *   - the loop is bounded (maxSteps) so a misbehaving model can't spin
 */

import { chatCompletion } from './engine'
import { retrieve, type RetrievedChunk } from './knowledge'
import { buildContextBlock } from './groundedAgent'
import { getTool, getToolsForProfile, toToolSchema } from './tools'
import { HANDOFF_MARKER, type HandoffSignal } from './tools/escalation'
import type { AgentActor } from './tools/types'
import { logger } from '../../lib/logger'
import type { AgentProfile, ChatMessage, ToolCall } from './types'

function asHandoff(result: unknown): HandoffSignal | undefined {
  if (result && typeof result === 'object' && HANDOFF_MARKER in result) {
    return (result as Record<string, unknown>)[HANDOFF_MARKER] as HandoffSignal
  }
  return undefined
}

/**
 * Safety net for control-tool unreliability. This model class will sometimes
 * NARRATE an escalation in plain prose ("I'll connect you with a senior agent —
 * please hold") instead of CALLING the escalate tool, which silently strands the
 * customer on a hard stop. When the agent's OWN reply promises a handoff but no
 * escalation tool fired, we make the handoff real. This keys off the AGENT's
 * stated intent — NOT the user's words — a deliberate, non-brittle choice.
 */
const HANDOFF_VERB =
  /\b(transfer(?:ring)?\s+you|connect(?:ing)?\s+you\s+with|put\s+you\s+through|hand(?:ing)?\s+(?:this|you|it)\s+(?:off|up|over)|pass(?:ing)?\s+(?:this|you|it)\s+(?:on|up|along)|bring(?:ing)?\s+in|loop(?:ing)?\s+(?:you\s+)?in|hold\s+(?:on\s+)?(?:tight\s+)?while\s+i)\b/i
const SUPPORT_TARGET =
  /\b(senior|supervisor|specialist|strategist|a\s+human|(?:real|live)\s+person|gam\s+support|support\s+(?:team|specialist|strategist|agent|representative)|(?:right|appropriate)\s+(?:team|department|person)|someone\s+(?:who|that)\s+can)\b/i

/**
 * True when the agent's prose promises an escalation to a higher SUPPORT tier.
 * Requires a handoff verb AND a support-tier target (or an explicit "escalate"),
 * so routing the tenant to their LANDLORD ("I'll connect you with your landlord")
 * is NOT mistaken for a support escalation.
 */
function promisesHandoff(content: string): boolean {
  if (!content) return false
  if (/\bescalat\w+/i.test(content)) return true
  return HANDOFF_VERB.test(content) && SUPPORT_TARGET.test(content)
}

// S552: user messages that name THEIR OWN account data — "my lease", "my
// deposit", "what do I owe", "my next payout"… A tool-less final answer to
// one of these gets one forced retry (see the safety net in the loop).
// Deliberately narrow: generic product questions ("how do late fees work")
// must NOT match, or every FAQ turn would pay a second model call.
/**
 * Names in a reply must have come from a tool result.
 *
 * S617. Asked which leases were expiring, the landlord agent CALLED the tool,
 * got back one real row (Apt 204, Oak Street Apartments, Oct 4) — and reported
 * three, padding with "Unit 202 at Maple Court" and "Unit 303 at Pine Estates".
 * Neither property exists anywhere in the database, for any landlord. A prompt
 * rule spelling this out, with that exact example, did not stop it.
 *
 * So the check is mechanical: every Title Case name in the reply must appear in
 * what the tools actually returned. It only runs when the reply reads like a
 * LIST OF RECORDS (bullets or a table) — that is where padding happens, and it
 * keeps ordinary prose from being second-guessed for mentioning a place in
 * passing.
 */
const NAME_ALLOWLIST = new Set([
  'Want Me', 'Let Me', 'Here Is', 'Here Are', 'Oak Street', 'GAM Team',
])
export function namesNotInToolResults(reply: string, toolResults: unknown[]): string[] {
  if (!/^\s*(?:[-•*]|\|)/m.test(reply)) return []           // not a record list
  // Compare with spaces, underscores and case removed. A model writing a
  // breakdown labels the fields in prose — "Total Units: 21", "Vacant Units:
  // 15" — while the tool returns them as totalUnits / vacant_units. A literal
  // match calls those labels invented properties and suppresses a perfectly
  // good answer, which is exactly what happened to "whats my occupancy".
  const flatten = (t: string) => t.toLowerCase().replace(/[\s_-]+/g, '')
  const haystack = flatten(JSON.stringify(toolResults))
  const found = reply.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? []
  const bad: string[] = []
  for (const name of new Set(found)) {
    if (NAME_ALLOWLIST.has(name)) continue
    // A month or weekday ANYWHERE in the phrase — "Due October", "End Date
    // October" — is a date, not a record name. This checked only the FIRST
    // word and flagged "Due October" as an invented property.
    if (/\b(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/.test(name)) continue
    if (!haystack.includes(flatten(name))) bad.push(name)
  }
  return bad
}

/**
 * Does this question have to be answered by a TOOL rather than from memory?
 *
 * S617 (Nic), and this is HIS rule, which is simpler and better than the one it
 * replaced: "memory should only be the things that don't change. Everything
 * else should be a lookup, instead of making stuff up."
 *
 * The old version listed the wordings that deserved a lookup, so anything
 * phrased a way nobody anticipated fell through to memory and got invented —
 * "what do I owe?" was handled, "how much do I pay each month" answered $1,200
 * against a real rent of $750. Listing the safe cases and defaulting everything
 * else to invention is backwards.
 *
 * So it is inverted. Asking for a fact means a LOOKUP, unless the fact is one
 * of the few that is identical for every user on the platform:
 *
 *   memory  — the $2 per occupied unit and the $10 per-property minimum; that
 *             rent is paid in full and never in part; what a feature is; and
 *             how to DO something (how do I add a unit, report a repair, pay).
 *   lookup  — everything else. Nic: late fees are "per property and per state
 *             and landlord", so even the general-sounding "how do late fees
 *             work" has to come from THIS lease. Same for the lease dates, the
 *             balance, the rent, the deposit, occupancy, who is behind.
 *
 * When in doubt this returns TRUE, because the cost is asymmetric: a needless
 * lookup is a wasted second, and a made-up balance is a tenant told they owe
 * $1,200 when they owe $2,330.
 */

/** Is the person asking for a fact at all (vs. chatting, or giving an instruction)? */
export const SEEKS_A_FACT =
  /\b(how many|how much|how long|how often|what'?s?|when'?s?|where'?s?|which|who'?s?|why|is|are|am|do|does|did|can|could|will|would|should|show|list|tell me|pull up|look ?up|check|any)\b/i

/**
 * The short list that memory may answer: platform-wide constants and how-to.
 *
 * A how-to is a procedure, the same for everyone — "how do I report a repair"
 * has one answer whoever asks. The moment a question wants a NUMBER or a DATE
 * that could differ between two users, it leaves this list.
 */
export const ANSWERABLE_FROM_MEMORY = [
  // "how do I ...", "where do I ...", "can I ..." — procedure, not data.
  /\b(how|where)\s+(do|can|would)\s+(i|we|you)\b/i,
  /\b(can|could)\s+(i|we)\s+(pay|add|set up|create|file|report|upload|invite|book|reserve|cancel|renew)\b/i,
  // Platform-wide pricing and rules — identical for every landlord and tenant.
  /\bplatform fee\b|\bwhat does gam (cost|charge)\b|\bhow much do you charge\b|\bper occupied unit\b/i,
  /\bpartial payment|\bpay in full\b|\bsplit (the |my )?rent\b|\bpay (part|some|half) of\b|\bpay a (partial|portion)\b/i,
  /\bwhat (is|are) (a |an |the )?[a-z ]{0,24}(flexpay|flexvault|flexdeposit|flexcredit|work trade|rubs)\b/i,
  // Cost of a service, not of this person's account — "how much does a
  // background check cost" is a price list, not their data. (Same pattern as
  // PRICING_QUESTION below, kept here so this array does not depend on
  // declaration order.)
  /\b(how much|what)\s+(?:does|do|is|are|would)\b[^?]*\b(cost|charge[ds]?|price[ds]?|run me)\b|\bpricing\b|\bprice of\b/i,
]

export function demandsAToolCall(message: string): boolean {
  if (!SEEKS_A_FACT.test(message)) return false
  if (ANSWERABLE_FROM_MEMORY.some((re) => re.test(message))) return false
  return true
}

/**
 * Does a reply ASSERT specific stored facts?
 *
 * S617. The retry above is one attempt; if the model refuses it, the old code
 * shipped whatever it had. Verified against the database, that meant sending a
 * landlord "you have 2 vacant units" when there were 15, listing two named
 * maintenance requests for a tenant with none, and rendering a table of expiring
 * leases containing a "Jane Doe" whose lease ended in 2023.
 *
 * A wrong number is worse than no number here — this is what a landlord serves
 * a notice on. So when no tool ran and the reply still reads like a record,
 * the record is not sent.
 */
export function assertsStoredFacts(text: string): boolean {
  if (!text) return false
  // A LIST OF RECORDS. Two or more bulleted or numbered lines is a report, and
  // a report with no lookup behind it is fiction. S617: this was the gap that
  // let "leases ending within the next 60 days" through — a tidy list of units,
  // tenant names and dates, none of which existed, carrying no dollar sign and
  // no ISO date for the cruder checks below to catch.
  const listLines = (text.match(/^\s*(?:[-•*]|\d+[.)])\s+\S/gm) ?? []).length
  if (listLines >= 2) return true

  return (
    // S617: also catches a BARE tool name in brackets. The model wrote
    // "I'll get that now. [get_my_lease]" — no dot, so the dotted form below
    // missed it and a tool token went to the customer as prose.
    /\[[a-z][a-z0-9_]*(?:\.[A-Za-z_]+)?\]|\{\{[^}]+\}\}/.test(text)  // unresolved placeholder
    || /^\s*\|.*\|/m.test(text)                                  // a table of records
    || /\b\d+\s+(vacant|occupied|open|pending|active|overdue|delinquent|expiring)\b/i.test(text)
    || /\b(you|they|he|she)\s+(have|has)\s+\d+\b/i.test(text)     // "you have 2 ..."
    || /\$[\d,]+(\.\d\d)?/.test(text)                            // a money figure
    || /\b\d{4}-\d{2}-\d{2}\b/.test(text)                        // an ISO date
    // "End Date: October 15" — a specific calendar date in prose.
    || /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i.test(text)
  )
}

/** What to say instead of a number nobody looked up. */
const CANNOT_SEE =
  "I'm not able to pull that up right now, and I don't want to give you a number I haven't checked. Let me get someone on the team to look — or ask me something else in the meantime."

/** Distinct tool executions allowed inside ONE model turn. See the loop below. */
const MAX_TOOL_CALLS_PER_TURN = 6

export const ACCOUNT_DATA_INTENT =
  /\b(my|our)\s+(?:\w+\s+)?(lease|deposit|balance|rent|payments?|payout|invoice|maintenance requests?|documents?|payment methods?|property manager|entry requests?|inspections?)\b|what do (i|we) owe|when('| i)?s my (next |last )?(payment|payout|rent)|\bon file\b|what documents|documents? do (i|we) have|requested entry|entry request/i

// S617: the net above is built entirely around the word "my", and it showed.
// Running the REAL production path (runAgentSession, real actor, real tools)
// rather than the bare engine, two questions slipped it and the model answered
// from imagination in both:
//
//   tenant   "how much do I owe right now?"  -> "You currently owe $1,200. Your
//            rent is due on the 3rd." The lease is $750, due on the 1st. No tool
//            was called. Both numbers invented.
//   landlord "is bob behind on rent?"        -> "Bob is current on his rent."
//            No lookup happened at all.
//
// "what do I owe?" was caught; "how much do I owe right now?" was not, because
// the alternation pinned an exact phrase. And nothing covered a landlord asking
// about a NAMED tenant or unit — Nic: "unless it's the landlord talking about a
// specific person and then should be able to find that by name in occupied
// units." A fabricated delinquency answer is worse than a tenant-side one: it is
// what an eviction decision gets made on.
// S617, second pass. Chasing phrasings is whack-a-mole: after widening the net
// for "how much do I owe right now", a battery through the production path found
// SIX more tool-less answers, every one invented — "you have 2 vacant units"
// (15), "12 occupied, 3 vacant" (6 and 15, and it contradicted its own previous
// answer), two named maintenance requests for a tenant who has none, and a
// markdown table of expiring leases featuring a "Jane Doe" with a 2023 date.
//
// Nic's framing is the shape of the fix: "landlord questions should scope to
// platform capability or portfolio realities, things should become narrow
// quickly. tenant side should be easy as they can only know about their
// lease/portal and their landlord." There is no third category where the model
// gets to estimate. So this matches DATA NOUNS rather than sentence shapes —
// if the question is about a thing GAM stores, a tool answers it.
export const PORTFOLIO_DATA_NOUN =
  /\b(lease|leases|rent|rents|deposit|balance|owe[sd]?|payment|payments|payout|payouts|invoice|invoices|statement|unit|units|vacan\w*|occupanc\w*|occupied|tenant|tenants|resident|applicant|application|screening|background check|maintenance|repair|work order|inspection|expiring|expiration|renewal|move[- ]?out|move[- ]?in|delinquen\w*|late fee|utility|utilities|meter|reading|booking|reservation|work trade|notice|pay|paying|paid|owe|due|charge[sd]?|bill|balance|grace period|grace|full|empty|portfolio|properties|property)\b/i

// Only a QUESTION or an instruction to look — "how do late fees work?" is a
// capability question and belongs to the knowledge base, not a tool.
/**
 * Cost/pricing questions are CAPABILITY questions, answered from the knowledge
 * base — "how much does a background check cost" is not a request for this
 * landlord's data, and nudging it would force a tool that does not exist and
 * then suppress a perfectly good answer. Caught by a test, not in production.
 */
export const PRICING_QUESTION =
  /\b(how much|what)\s+(?:does|do|is|are|would)\b[^?]*\b(cost|charge[ds]?|price[ds]?|run me)\b|\bpricing\b|\bprice of\b|\bhow much is (a|an|the)\b/i

export const ASKS_FOR_A_FACT =
  // S617: measured against 106 real phrasings. "what day is rent due" and "how
  // much do I pay each month" both fell through and the model answered from
  // imagination — the 3rd instead of the 1st, $1,200 instead of $750.
  /\b(how many|how much|how long|what'?s|what is|what are|what day|what date|which day|when('| i)?s|when is|when does|when do|when will|who('s| is| are)|which|do i have|do we have|does .* have|did i|am i|is my|is the|are my|is there|are there|any\b|show me|list|pull up|look ?up|check|tell me (about )?(my|our|the)|status of)\b/i

export const ACCOUNT_DATA_LOOSE =
  /how much (do|does|did) (i|we|he|she|they|[\w#'-]+(?:\s+[\w#'-]+)?) (still )?owe|what'?s (my|the|his|her|their) balance|(am|are|is) (i|we|he|she|they|[\w#'-]+(?:\s+[\w#'-]+)?) (behind|current|late|caught up|past due)|behind on (rent|payments?)|late on (rent|payments?)|\bdelinquen\w*|\bpast due\b|who('s| is| has)? (not )?(paid|behind|late)|any(one|body) (behind|late|not paid)|(has|did) [a-z]+ paid|paid (yet|this month|their rent)|\bowes?\b.*\b(rent|balance|anything)\b|\b(rent|balance) .*\bowed\b/i

// S553: two more hard-stop nets, same philosophy as MONEY_DISPUTE_INTENT
// (the prompt rule holds most runs; quantized variance drops it some runs —
// the deterministic net doesn't). Both must END in the escalation tool:
// - legal ACTION/dispute signals (suing, lawyer, "take legal action") — NOT
//   what-does-the-law-say questions, which landlord agents answer with the
//   law tools by design.
// - account-security incidents (hacked, someone logged in, compromised).
const LEGAL_ACTION_INTENT =
  /take legal action|legal action against|(talk|speak|spoke) to (a |my )?(lawyer|attorney)|(my|a|an|the) (lawyer|attorney)\b|\bsue\b|\bsuing\b|small claims|press charges/i
const ACCOUNT_SECURITY_INTENT =
  /\bhacked\b|hacker|someone (else )?(logged|signed|got) in(to)?|unauthori[sz]ed (access|login)|account (was |got |is )?(compromised|stolen|taken over)|login (alert|attempt).{0,25}(don'?t|did ?n'?t|do not) recognize/i

// S552: a demand to move money — refund, double-charge, dispute — is a hard
// stop that must END in the escalation tool. The model follows the prompt
// rule most runs but not all (quantized-model variance); when a matching
// turn finishes with no handoff, force one corrective retry.
// S553: missing-money phrasings added ("my payout never arrived", "where is
// my money") — a landlord whose payout is lost is a money dispute exactly
// like a tenant refund demand. Patterns stay TIGHT on the dispute framing so
// ordinary balance questions ("where did my payment get applied?") never trip
// the escalation net.
const MONEY_DISPUTE_INTENT =
  /\brefund\b|double.?charged|charged (me )?twice|overcharged|charge.?back|didn.?t authori[sz]e|(payout|transfer|my money).{0,30}(never|didn'?t|hasn'?t|not) (arrived?|show(ed|n)? up|hit|come)|where('?s| is) my money\b|disput(e|ing|ed).{0,30}(charge|payment|transaction|bank)|(want|get|getting) my money back/i

function synthesizeHandoff(profile: AgentProfile, content: string): HandoffSignal | undefined {
  if (!promisesHandoff(content)) return undefined
  const allow = profile.toolNames ?? []
  if (!allow.includes('escalate') && !allow.includes('escalate_to_human')) return undefined
  // Routing rule (locked): ALL escalation runs through the senior agent, and ONLY
  // the senior (tier 'escalation') reaches the real-person/email tier. So a senior
  // hands to 'human'; every other tier hands UP to the senior ('tier').
  const kind: HandoffSignal['kind'] = profile.tier === 'escalation' ? 'human' : 'tier'
  return {
    kind,
    reason: 'Agent indicated a handoff was needed but did not call the escalation tool.',
    summary: content.replace(/\s+/g, ' ').trim().slice(0, 400),
  }
}

export interface RunWithToolsInput {
  profile: AgentProfile
  actor: AgentActor
  message: string
  history?: ChatMessage[]
  k?: number
  minSimilarity?: number
  /** max model<->tool round trips before giving up. Default 4. */
  maxSteps?: number
}

export interface ToolInvocation {
  name: string
  args: Record<string, unknown>
  result: unknown
}

export interface RunWithToolsResult {
  reply: string
  model: string
  retrieved: RetrievedChunk[]
  grounded: boolean
  /** tools actually executed this turn, in order */
  toolInvocations: ToolInvocation[]
  /** summed token usage across every model call in this run */
  usage: { promptTokens: number; completionTokens: number }
  /** set when the agent invoked an escalation tool — the session
   *  orchestrator hands off instead of using `reply`. */
  handoff?: HandoffSignal
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export async function runAgentWithTools(input: RunWithToolsInput): Promise<RunWithToolsResult> {
  const { profile, actor, message, history = [], k = 5, minSimilarity = 0.3, maxSteps = 4 } = input

  // 1) Ground on scoped knowledge.
  const all = await retrieve(profile.knowledgeScopes, message, k)
  const retrieved = all.filter((c) => c.similarity >= minSimilarity)

  // 2) Assemble the tool schemas this profile may use.
  const tools = getToolsForProfile(profile)
  const toolSchemas = tools.map(toToolSchema)

  const messages: ChatMessage[] = [
    { role: 'system', content: profile.systemPrompt },
    { role: 'system', content: buildContextBlock(retrieved) },
    ...history,
    { role: 'user', content: message },
  ]

  const toolInvocations: ToolInvocation[] = []
  let nudgedForAccountData = false
  let nudgedForPadding = false
  let nudgedForDispute = false
  let nudgedForHardStop = false
  let model = ''
  const usage = { promptTokens: 0, completionTokens: 0 }
  const grounded = retrieved.length > 0
  const addUsage = (u?: { promptTokens?: number; completionTokens?: number }) => {
    usage.promptTokens += u?.promptTokens ?? 0
    usage.completionTokens += u?.completionTokens ?? 0
  }

  for (let step = 0; step < maxSteps; step++) {
    const out = await chatCompletion(messages, {
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      sampler: profile.sampler,
    })
    model = out.model
    addUsage(out.usage)

    if (out.toolCalls.length === 0) {
      const synth = synthesizeHandoff(profile, out.content)
      if (synth) {
        logger.warn({ profile: profile.id }, 'agent runner: model promised a handoff in prose without calling escalate — synthesizing the escalation (safety net)')
        return { reply: out.content, model, retrieved, grounded, toolInvocations, usage, handoff: synth }
      }
      // S552 safety net (same philosophy as synthesizeHandoff): the model
      // sometimes answers an obviously ACCOUNT-SPECIFIC question from
      // general knowledge without calling any tool — observed fabricating
      // lease dates ("ends September 15th" for a Nov 4 lease) and emitting
      // literal placeholders ("[date]"). When the user's message names
      // their own account data and NO tool ran this turn, force one
      // corrective retry before accepting a tool-less answer.
      // Money-dispute turns must end in the escalation tool, tool-less or
      // not — a refund demand where the model only investigated (or only
      // explained) still strands the customer without a human.
      if (!nudgedForDispute && MONEY_DISPUTE_INTENT.test(message)) {
        nudgedForDispute = true
        logger.warn({ profile: profile.id }, 'agent runner: money-dispute turn ended without escalation — forcing one retry (safety net)')
        messages.push({ role: 'assistant', content: out.content })
        messages.push({
          role: 'system',
          content:
            'STOP — this customer is disputing a charge or demanding a refund. That is a hard stop: ' +
            'you must CALL your escalation tool now so a human handles the money movement. ' +
            'Do not investigate further and do not promise any outcome — escalate in this reply.',
        })
        continue
      }
      if (!nudgedForHardStop && (LEGAL_ACTION_INTENT.test(message) || ACCOUNT_SECURITY_INTENT.test(message))) {
        nudgedForHardStop = true
        const kind = LEGAL_ACTION_INTENT.test(message) ? 'a legal dispute' : 'an account-security incident'
        logger.warn({ profile: profile.id, kind }, 'agent runner: hard-stop turn ended without escalation — forcing one retry (safety net)')
        messages.push({ role: 'assistant', content: out.content })
        messages.push({
          role: 'system',
          content:
            `STOP — this customer is raising ${kind}. That is a hard stop: you must CALL your ` +
            'escalation tool now so a human GAM Strategist takes over. Do not give advice, do not ' +
            'investigate further, and do not promise any outcome — escalate in this reply.',
        })
        continue
      }
      if (
        !nudgedForAccountData &&
        toolInvocations.length === 0 &&
        demandsAToolCall(message)
      ) {
        nudgedForAccountData = true
        logger.warn({ profile: profile.id }, 'agent runner: tool-less answer to an account-data question — forcing one tool retry (safety net)')
        messages.push({ role: 'assistant', content: out.content })
        messages.push({
          role: 'system',
          content:
            'STOP — your last answer stated account-specific facts without fetching them. ' +
            'You have NOT looked up this data; any name, date, count or amount you stated was invented. ' +
            // S617: this used to name tenant tools only — get_my_lease, get_my_deposit,
            // get_my_contacts — so a LANDLORD agent was being told to call tools it does
            // not have. It could not comply, so it either answered tool-less again (and
            // got suppressed) or floundered. The list is now built from the profile's own
            // toolNames, which cannot drift from what the agent actually holds.
            `Call the matching tool NOW. Tools available to you: ${(profile.toolNames ?? []).join(", ")}. ` +
            'Pick the one that answers this question and answer from its result. ' +
            'If none of them covers it, say plainly that you cannot see that information — ' +
            'do not answer from memory.',
        })
        continue
      }
      // S617: last gate before this reaches a person. The nudge above already
      // fired and was declined — no tool ran, yet the answer still states
      // figures, dates or a list of records. Those cannot have come from
      // anywhere but the model. Do not send them.
      if (
        toolInvocations.length === 0 &&
        nudgedForAccountData &&
        assertsStoredFacts(out.content)
      ) {
        logger.error({ profile: profile.id, message },
          'agent runner: model asserted stored facts with no tool call after a retry — reply suppressed')
        return { reply: CANNOT_SEE, model, retrieved, grounded, toolInvocations, usage }
      }
      // S617: the tools DID run, and the model added rows they never returned.
      // Suppress rather than hand a landlord a list with invented properties in
      // it — acting on a fake expiring lease is a real-world mistake.
      if (toolInvocations.length > 0) {
        const invented = namesNotInToolResults(out.content, toolInvocations.map((t) => t.result))
        if (invented.length) {
          // Ask once for the answer again, with the tool output restated. The
          // real rows ARE there — the model padded a short list rather than
          // fetched nothing — so suppressing outright throws away a correct
          // answer along with the invented ones. Only give up if it pads twice.
          if (!nudgedForPadding) {
            nudgedForPadding = true
            logger.warn({ profile: profile.id, invented },
              'agent runner: reply named records the tools never returned — forcing one retry')
            messages.push({ role: 'assistant', content: out.content })
            messages.push({
              role: 'system',
              content:
                `STOP — you named ${invented.map((n) => `"${n}"`).join(', ')}, which the lookup did not return. ` +
                'You invented those. Answer AGAIN using only what the tool gave you, listed here in full:\n' +
                JSON.stringify(toolInvocations.map((t) => ({ tool: t.name, result: t.result }))) +
                '\nReport exactly those rows — no more. If it returned one row, give one. ' +
                'If it returned none, say none. A short answer is the correct answer.',
            })
            continue
          }
          logger.error({ profile: profile.id, message, invented },
            'agent runner: reply named invented records twice — reply suppressed')
          return { reply: CANNOT_SEE, model, retrieved, grounded, toolInvocations, usage }
        }
      }
      return { reply: out.content, model, retrieved, grounded, toolInvocations, usage }
    }

    // Record the assistant's tool-call turn, then execute each call.
    messages.push({ role: 'assistant', content: out.content || null, tool_calls: out.toolCalls })

    // S617: one turn asking "did my last payment go through" came back with
    // FORTY-SIX identical get_my_payment_status calls, every one executed and
    // round-tripped. maxSteps bounds the number of TURNS, not the number of
    // calls inside a turn, so a model that repeats itself is unbounded — that
    // is 46 database round trips and 46 tool messages of context for one
    // question.
    //
    // Identical calls are answered from the first result. The protocol still
    // needs a reply per tool_call_id, so every call is answered; it just is not
    // re-executed. And the ledger records the tool ONCE, so a repeat does not
    // inflate tool_invocation_count or make the turn look busier than it was.
    const turnCache = new Map<string, unknown>()
    let executedThisTurn = 0
    for (const call of out.toolCalls) {
      const args = parseArgs(call.function.arguments)
      const cacheKey = `${call.function.name}:${JSON.stringify(args)}`
      if (turnCache.has(cacheKey)) {
        messages.push({
          role: 'tool', tool_call_id: call.id, name: call.function.name,
          content: JSON.stringify(turnCache.get(cacheKey)),
        })
        continue
      }
      if (executedThisTurn >= MAX_TOOL_CALLS_PER_TURN) {
        logger.warn({ profile: profile.id, tool: call.function.name },
          'agent runner: per-turn tool-call cap hit — remaining calls answered without executing')
        messages.push({
          role: 'tool', tool_call_id: call.id, name: call.function.name,
          content: JSON.stringify({ ok: false, error: 'Too many lookups in one turn. Answer from what you already have.' }),
        })
        continue
      }
      executedThisTurn++
      const result = await executeToolCall(call, profile, actor, args)
      turnCache.set(cacheKey, result)

      // An escalation tool is a CONTROL signal, not a data/action tool —
      // detect it BEFORE recording, so it never pollutes the tool ledger
      // (tool_invocation_count / tool_names / tool_invocations) and hands
      // control back to the session orchestrator.
      const handoff = asHandoff(result)
      if (handoff) {
        return { reply: '', model, retrieved, grounded, toolInvocations, usage, handoff }
      }

      toolInvocations.push({ name: call.function.name, args, result })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result),
      })
    }
  }

  // Hit the step ceiling — ask once more for a plain answer, no tools.
  logger.warn({ profile: profile.id, maxSteps }, 'agent runner: tool-step ceiling reached')
  const final = await chatCompletion(messages, { sampler: profile.sampler })
  addUsage(final.usage)
  // The no-tools call can still come back empty (model emits a stray
  // tool_call -> content forced to ''). Never return an empty reply.
  const reply = final.content || STEP_CEILING_FALLBACK
  const ceilingHandoff = synthesizeHandoff(profile, reply)
  if (ceilingHandoff) {
    return { reply, model: model || final.model, retrieved, grounded, toolInvocations, usage, handoff: ceilingHandoff }
  }
  return { reply, model: model || final.model, retrieved, grounded, toolInvocations, usage }
}

const STEP_CEILING_FALLBACK =
  "I'm sorry — I wasn't able to finish that just now. Please try rephrasing, or ask to be connected with a person."

async function executeToolCall(
  call: ToolCall,
  profile: AgentProfile,
  actor: AgentActor,
  args: Record<string, unknown>
): Promise<unknown> {
  const name = call.function.name
  // Re-check the allowlist at execution time — never run a tool the
  // profile isn't permitted, even if the model invents the name.
  const permitted = getToolsForProfile(profile).some((t) => t.name === name)
  const tool = getTool(name)
  if (!permitted || !tool) {
    return { ok: false, error: `Tool "${name}" is not available.` }
  }
  try {
    return await tool.execute(args, actor)
  } catch (e) {
    logger.error({ err: e, tool: name, profile: profile.id }, 'agent runner: tool execution failed')
    return { ok: false, error: 'The tool failed to run. Tell the user you could not complete it.' }
  }
}
