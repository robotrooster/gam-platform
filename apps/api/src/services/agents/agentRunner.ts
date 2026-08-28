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
import { DateTime } from 'luxon'
import { buildContextBlock } from './groundedAgent'
import { getTool, getToolsForProfile, toToolSchema } from './tools'
import { selectToolsForTurn } from './toolSelection'
import { buildDecisionPrompt, buildComposeInstruction } from './decisionPrompt'
import { alreadyDone } from './repeatedAction'
import { HANDOFF_MARKER, type HandoffSignal } from './tools/escalation'
import type { AgentActor } from './tools/types'
import { routePlan } from './toolRouting'
import { needsARealPerson, stripPromiseOfAPerson, LEGAL_ACTION_INTENT } from './escalationPolicy'
export { needsARealPerson, stripPromiseOfAPerson } from './escalationPolicy'
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
/**
 * An OFFER to escalate is not an escalation.
 *
 * S617. The net above exists for a model that NARRATES a completed handoff
 * ("I'll connect you with a senior agent — please hold") and then stops,
 * stranding the customer. It was also firing on ordinary good service:
 *
 *   "You currently owe $2,330. This includes several pending payments and a
 *    failed rent payment from June. If you need help with the failed payment,
 *    I can connect you with a human support agent. Would you like me to do
 *    that?"
 *
 * That answer is correct and complete — the balance matches the database to the
 * dollar. The net saw "connect you with ... human", manufactured a real
 * escalation, and THREW THE ANSWER AWAY, replacing it with "I've escalated this,
 * someone will email you within 24 hours." The tenant asked what they owed and
 * was told to wait a day.
 *
 * So the sentence carrying the handoff decides. A statement of intent is a
 * handoff. A conditional or a question — "if you'd like", "would you like me
 * to", "let me know if" — is an offer, and the customer's answer decides, not
 * ours.
 */
const HANDOFF_IS_ONLY_AN_OFFER =
  /\b(if\s+(?:you|that|this|something|it|there|anything|nothing)|would\s+you\s+like|do\s+you\s+want|shall\s+i|want\s+me\s+to|let\s+me\s+know|happy\s+to|i\s+can\s+(?:also\s+)?(?:connect|transfer|bring|loop|pass|hand))\b/i

/** The sentence a phrase appears in — offers are judged in context, not globally. */
function sentenceContaining(content: string, re: RegExp): string {
  for (const s of content.split(/(?<=[.!?])\s+/)) if (re.test(s)) return s
  return content
}

export function promisesHandoff(content: string): boolean {
  if (!content) return false

  const explicit = /\bescalat\w+/i.test(content)
  const narrated = HANDOFF_VERB.test(content) && SUPPORT_TARGET.test(content)
  if (!explicit && !narrated) return false

  // Judge the sentence that actually carries it. "I've escalated this" is a
  // handoff; "I can escalate this if you'd like" is a question.
  const carrier = sentenceContaining(content, explicit ? /\bescalat\w+/i : HANDOFF_VERB)
  if (HANDOFF_IS_ONLY_AN_OFFER.test(carrier) || carrier.trim().endsWith('?')) return false

  return true
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
/**
 * Counts in the reply that the tools never returned.
 *
 * S618, and this one outlived the bug that exposed it. Every no-lookup guard
 * keys off `toolInvocations.length === 0`, so the moment ANY tool runs the
 * reply is treated as grounded — but "a tool ran" and "the answer came from the
 * tool" are not the same claim. A landlord asking their occupancy was told
 * "26 units across 4 properties, with 22 occupied and 4 vacant" with
 * get_landlord_portfolio in the invocation list and 21 units across 3
 * properties in its result. Not one of those four numbers existed anywhere,
 * and every guard passed it.
 *
 * DELIBERATELY NARROW, like namesNotInToolResults above. Only an integer
 * DIRECTLY attached to a portfolio noun is checked — "26 units", "4
 * properties", "22 occupied". Money is left alone because a total the model
 * adds up correctly ($750 + $15 + $50) is right and appears nowhere in the
 * rows; percentages likewise. Comparison strips separators so "2,330" matches
 * 2330 in the JSON.
 */
export function countsNotInToolResults(reply: string, toolResults: unknown[]): string[] {
  if (!reply) return []
  const haystack = JSON.stringify(toolResults).replace(/[",\s]/g, '')
  const bad: string[] = []
  const re = /\b(\d{1,4})\s+(units?|properties|propertys?|tenants?|leases?|vacant|occupied|empty)\b/gi
  for (const m of reply.matchAll(re)) {
    const n = m[1]
    // 0 and 1 are ordinary English ("1 unit", "no units") and are not worth a
    // retry; anything the tools genuinely returned is present in the JSON.
    if (n === '0' || n === '1') continue
    if (!new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(haystack)) bad.push(`${n} ${m[2]}`)
  }
  return [...new Set(bad)]
}

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
  // S626: ANCHORED TO THE START, and that anchor is the whole point.
  //
  // Unanchored, this matched "what amenities can I reserve at my property?" —
  // and exempted it. So the eval's t-amenities case never demanded a lookup,
  // the phrase table was never consulted, and adding a route for
  // get_my_amenities changed nothing at all: demandsAToolCall had already said
  // no before routing was ever reached. The tool looked unreachable when what
  // was actually broken sat one layer above it.
  //
  // "can I pay with a card?" is a procedure and belongs here. "WHAT can I
  // reserve at MY property" is a list of their own amenities and never did.
  // The difference is whether the sentence opens with the "can I", so that is
  // what is tested — with a little slack for the way people actually start
  // sentences.
  /^\W*(?:so|ok|okay|hey|hi|and|but|also)?[\s,]*(can|could)\s+(i|we)\s+(pay|add|set up|create|file|report|upload|invite|book|reserve|cancel|renew)\b/i,
  // "How does X work" for a PLATFORM MECHANIC. Nic's test: what would a GAM
  // customer service rep know off the top of their head, versus what would they
  // have to look up? A rep explains e-signing, invites or autopay setup from
  // memory — the process is the same for everyone. They would NOT recite a late
  // fee or a deposit rule from memory, because those are set per property and
  // per state, which is why those words are deliberately absent from this list.
  /\bhow (?:do(?:es)?|can|would)\b[^?]*\b(e-?sign\w*|signing|invit\w+|the portal|autopay|auto-?pay|screening|background check|work ?trade|booking|reservation|maintenance request|point of sale|pos)\b/i,
  // Platform-wide pricing and rules — identical for every landlord and tenant.
  /\bplatform fee\b|\bwhat does gam (cost|charge)\b|\bhow much do you charge\b|\bper occupied unit\b/i,
  // S618: "what am I paying for this" is GAM's own rate — platform-wide and
  // identical for every landlord, so memory may answer it. It was demanding a
  // lookup, and the model reached for the portfolio tool and answered without
  // the fee at all. Anchored to this/you/GAM on purpose: "what am I paying for
  // PARKING" is a lease fee, varies per tenant, and must stay a lookup.
  /\bwhat (?:am i|do i) pay(?:ing)?\s+(?:for\s+)?(?:this|you|gam)\b/i,
  /\bwhat(?:'s| is) (?:this|gam) costing me\b/i,
  /\bpartial payment|\bpay in full\b|\bsplit (the |my )?rent\b|\bpay (part|some|half) of\b|\bpay a (partial|portion)\b/i,
  /\bwhat (is|are) (a |an |the )?[a-z ]{0,24}(flexpay|flexvault|flexdeposit|flexcredit|work trade|rubs)\b/i,
  // Cost of a service, not of this person's account — "how much does a
  // background check cost" is a price list, not their data. (Same pattern as
  // PRICING_QUESTION below, kept here so this array does not depend on
  // declaration order.)
  /\b(how much|what)\s+(?:does|do|is|are|would)\b[^?]*\b(cost|charge[ds]?|price[ds]?|run me)\b|\bpricing\b|\bprice of\b/i,
]

/**
 * Things that are not a request at all — a greeting, a thanks, an "ok".
 * Nothing is being asked, so nothing needs looking up.
 */
/**
 * An email address or a phone number — a prospect handing over how to reach them.
 * S624: the signal that a lead must be captured before the turn ends.
 */
const CONTACT_DETAILS =
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/i

const NOT_A_REQUEST =
  /^\s*(hi|hey|hello|yo|thanks|thank you|ty|ok|okay|k|got it|sure|yep|yes|no|nope|nvm|never ?mind|bye|goodbye|cool|great|nice|awesome|perfect|sounds good|will do|understood|makes sense)\b[\s!.,?]*$/i

/**
 * "Are you a real person?" and its relatives.
 *
 * S624. Asked this, Skye replied: "I don't want to give you a number I haven't
 * actually checked. Which booking do you mean — the dates, the total, or the
 * site you're on?" She had answered honestly; the account-data net classified
 * the question as being about their booking, demanded a tool, got none, and
 * SUPPRESSED her real reply in favour of a canned deflection — to someone who
 * had asked whether she was human.
 *
 * This is why the bot-probe scenarios kept failing for tenant, landlord and
 * guest while passing for the prospect agent: a prospect is already exempt from
 * lookups, so the net never fired for Lucy. The disclosure rule was working the
 * whole time. The guard was eating it.
 *
 * No tool answers this, and the honest reply is a platform constant — which is
 * precisely the category the lookup rule is meant to exclude.
 */
// The noun must be a PREDICATE OF "YOU" — "are you a real person" — not merely
// somewhere after it. A first cut allowed twenty characters of slack and
// swallowed "are you charging me a REAL late fee?", which is the customer's own
// fee and very much needs its lookup.
const ABOUT_THE_AGENT = new RegExp([
  // are you (really|actually|even)? (a|an)? (real|actual|live)? person/human/bot/AI
  /\b(?:are|r)\s+(?:you|u)\s+(?:really\s+|actually\s+|even\s+|just\s+)?(?:an?\s+)?(?:real\s+|actual\s+|live\s+)?(?:person|human|humans|bot|robot|ai|a\.i\.|machine|computer|chatbot|automated)\b/,
  // am I talking to a real person / who am I speaking with
  /\b(?:am\s+i|are\s+we)\s+(?:talking|chatting|speaking|dealing)\s+(?:to|with)\b/,
  /\bwho\s+am\s+i\s+(?:talking|chatting|speaking|dealing)\s+(?:to|with)\b/,
  // is this a bot / is this a real person
  /\bis\s+th(?:is|at)\s+(?:an?\s+)?(?:real\s+)?(?:bot|robot|human|person|ai|a\.i\.|automated)\b/,
  // you're a bot, aren't you
  /\byou'?re\s+(?:an?\s+)?(?:bot|robot|ai|a\.i\.|machine|computer)\b/,
].map((r) => r.source).join('|'), 'i')

/**
 * Must this turn be answered from a LOOKUP rather than from memory?
 *
 * S618 (Nic), and this is the rule the rest of the file was only approximating:
 *
 *   "A tool should always be called for things that have to be searched for
 *    because they're gonna be different per my next door neighbor versus me —
 *    two different leases, two different late fees, two different whatevers.
 *    The only time a tool doesn't get called is for the platform side of things
 *    that never change... the platform foundational always happens the same way
 *    type of things."
 *
 * So the default is INVERTED. It used to require one of a list of question
 * verbs before a lookup was demanded at all, and that precondition was a hole
 * wide enough to drive the whole failure through. Measured against the real
 * list: "my balance looks off", "i need my lease end date", "i think my late
 * fee was wrong", "my rent seems too high" — none carried a listed verb, so
 * none demanded a tool, AND every anti-fabrication guard keys off this same
 * flag, so none of them was protected either. Seven of eight per-user
 * statements were free to be answered out of the model's head.
 *
 * Now: everything is a lookup EXCEPT two things —
 *   1. a platform constant, which is identical for every user on the platform
 *      (the list below), and
 *   2. a message that asks nothing at all.
 *
 * That is deliberately the strict direction. A needless lookup costs a query
 * and returns the truth; a skipped one is how a tenant hears a number that was
 * never in the database.
 */
export function demandsAToolCall(message: string, audience?: string): boolean {
  if (!message || !message.trim()) return false
  if (NOT_A_REQUEST.test(message)) return false
  // S624: a question ABOUT THE AGENT is not a question about the customer's
  // account, and no tool can answer it.
  if (ABOUT_THE_AGENT.test(message)) return false

  // S618: the PROSPECT (sales) agent is the exception, and missing it was a
  // regression I introduced with the inversion itself.
  //
  // The rule's premise is that per-user data varies and must be looked up. A
  // prospect HAS no account, no lease and no property — every honest answer
  // they can get is a platform constant, and the sales profile holds no data
  // lookups at all (capture_lead, get_available_call_times, book_sales_call).
  // Demanding a tool there means demanding one that does not exist.
  //
  // Measured before the fix: "what's the price per unit" demanded a lookup, the
  // agent answered correctly from the knowledge base — "$2 per occupied unit
  // per month" — and assertsStoredFacts saw a dollar figure with no tool behind
  // it and replaced the answer with "Which part were you after — your balance,
  // your rent, your lease dates, or your deposit?" to someone who has none of
  // those. The commercial front door, answering a pricing question with
  // nonsense.
  //
  // S620: but "no data lookups" is not "no tools", and a blanket exemption
  // measured 0/4 on the one thing Lucy is actually for. Asked "can I talk to
  // someone?" and "I want to schedule a demo" she called nothing on every
  // phrasing and replied "Want me to grab you a time?" — an offer to book
  // against a calendar she never opened. Two of those four then had the
  // promise stripped out by finalize, leaving a prospect who asked for a call
  // holding nothing at all.
  //
  // So a prospect is exempt from LOOKUPS and not from ACTIONS. The phrase
  // table is the arbiter, which keeps the two in one place: if it routes this
  // wording to a tool (today, only scheduling), that tool is required; if it
  // routes nothing, the question is a platform constant and the knowledge base
  // answers it, exactly as above.
  if (audience === 'prospect') return routePlan(message, 'prospect').tools.length > 0

  // S618: for a GUEST or a site VISITOR, "how much does it cost" is not GAM's
  // rate card — it is the nightly price of the spot they are looking at, which
  // is per-property and set by that landlord. The platform-pricing exemptions
  // below were written for a landlord asking what GAM charges THEM, and letting
  // them through here would let the agent quote a nightly rate from memory on a
  // booking site. Those two audiences look everything up.
  if (audience === 'guest' || audience === 'visitor') return true

  // The ONLY other exemption: platform-wide facts that are the same for everyone.
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
/**
 * Is this someone asking for a late fee to be taken off?
 *
 * S626. profiles.ts has carried Nic's instruction for this since S624 — do the
 * arithmetic out loud, count from the END of the grace period, "only two days
 * late" after a five-day grace is seven days past due — and the agent recited
 * policy instead every single time. The bullet is correct and it is one of
 * fifteen; salience alone was not making it happen.
 *
 * The arithmetic is the only thing that actually answers the argument they
 * made, so it is worth making deterministic rather than hoping for it.
 */
const WAIVER_REQUEST = new RegExp([
  /\b(waive|waived|waiver|wave)\b/,
  /\b(take|knock|write|let)\s+(it|that|this|the fee)?\s*(off|down)\b/,
  /\b(remove|drop|cancel|reverse|refund|forgive|excuse)\b[^?]{0,25}\b(fee|charge|late)\b/,
  /\b(get|got)\s+(out of|rid of)\b[^?]{0,15}\bfee\b/,
  /\bany chance\b[^?]{0,30}\b(off|waive|remove)\b/,
  // The other word order — "get that fee removed", "the charge dropped".
  /\b(fee|charge)s?\b[^?]{0,25}\b(removed|waived|dropped|cancell?ed|reversed|refunded|taken off)\b/,
].map((r) => r.source).join('|'), 'i')

/** The grace period from whatever the lookups returned, or null. */
function graceDaysFromResults(results: readonly unknown[]): number | null {
  for (const r of results) {
    const found = findNumeric(r, /grace/i)
    if (found != null) return found
  }
  return null
}

function findNumeric(node: unknown, key: RegExp, depth = 0): number | null {
  if (!node || typeof node !== 'object' || depth > 5) return null
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (key.test(k)) {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
      if (Number.isFinite(n)) return n
    }
    const nested = findNumeric(v, key, depth + 1)
    if (nested != null) return nested
  }
  return null
}

/** The number of days they CLAIMED, so the reply can answer their own figure. */
function claimedDaysLate(message: string): number | null {
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  }
  const m = message.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+(late|past|over|overdue)\b/i)
    ?? message.match(/\b(?:only|just)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\b/i)
  if (!m) return null
  const raw = m[1].toLowerCase()
  const n = words[raw] ?? Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * WHAT DAY IS IT?
 *
 * S626, and nothing in this system had ever told an agent. Not the system
 * prompt, not the context block, not a tool result — so every agent reasoned
 * about dates from its training prior, and Hermes' prior is 2024.
 *
 * It surfaced on the booking site, where it was worst. A visitor asked about
 * "the 15th to the 20th"; profiles.ts correctly says to ask which month rather
 * than declare the dates past; the agent asked — and then proposed "September
 * 2024". Told September, it tried 2025. Both are in the past, so
 * check_availability rejected both, and the customer was asked which month
 * twice in a row while the agent cycled through years it had guessed. Handing
 * it the exact ISO date to use did not help, because a model that does not know
 * the year cannot tell that the string it was given is the right one.
 *
 * It is not a booking bug. A date-blind agent cannot judge whether a lease ends
 * "soon", whether a payment is late, or what "next month" means — it had simply
 * never been measured anywhere else.
 *
 * Deliberately three short lines. Prompt length costs tool selection, and this
 * sits in every turn for every audience.
 */
export function buildTemporalBlock(now: DateTime): string {
  return [
    `TODAY IS ${now.toFormat('cccc, d LLLL yyyy')} (${now.zoneName}). The current year is ${now.year}.`,
    `Every date you state or pass to a tool must agree with that. Never write a year you have not been given.`,
    `A bare day number means the soonest that day is still ahead — this month if it has not passed, otherwise next month. Never a past date.`,
  ].join('\n')
}

/**
 * Did a sales reply put a TIME in front of a prospect without opening the calendar?
 *
 * S626. Asked "can I talk to someone?", Lucy answered: "I've got a few times
 * open today and tomorrow. How about tomorrow at 1:00 PM MST? I can send over a
 * calendar invite once we confirm." She had called nothing. Told "Tuesday
 * afternoon would work for me", she replied "I'll send over the calendar invite
 * for tomorrow at 1:00 PM" — ignoring the day they picked, and promising an
 * invite that no tool was ever going to send.
 *
 * S620 fixed the version of this that CLAIMED a booking. This is the version
 * that PROMISES one, and claimsAnActionItNeverTook is past-tense only, so
 * nothing caught it. A prospect who believes a call is booked stops looking for
 * a platform, and nobody finds out until the call does not happen.
 *
 * The sales calendar is real — listAvailableSlots reads live windows from
 * sales_call_availability, excludes booked slots and honours the notice period.
 * There is no reason to guess at it.
 */
const OFFERS_A_MEETING_TIME = new RegExp([
  // a clock time: "1:00 PM", "1pm", "at 2 PM MST"
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/,
  // a named day being proposed or confirmed
  /\b(?:how about|what about|does|would|shall we say|let's say|pencil(?:ling)? (?:you )?in|set (?:you )?up for)\b[^.?!]{0,40}\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)\b/,
  // promising the artefact of a booking
  /\b(?:calendar invite|meeting invite|invite|invitation)\b/,
  /\b(?:i'?ll|i will|i can)\s+(?:send|shoot|fire|get)\b[^.?!]{0,30}\b(?:invite|link|calendar|confirmation)\b/,
].map((r) => r.source).join('|'), 'i')

/** The scheduling tools. Any one of them means the calendar was actually opened. */
const SCHEDULING_TOOLS = new Set(['get_available_call_times', 'book_sales_call'])

/** Exposed for waiverMath.test.ts — these are guard internals, not API. */
/**
 * S628 — the sentence written FOR the model when it will not write it itself.
 *
 * Four attempts at instructing it failed (S624 in profiles.ts, two rewrites in
 * S626's net, and the S628 run). The arithmetic is not a judgement — it is a
 * grace period from a real lease plus the number the person themselves said —
 * so it is computed and placed in front of the reply rather than asked for a
 * fifth time.
 */
export function waiverArithmeticLine(grace: number, claimed: number): string {
  return (
    `The fee only starts after your ${grace}-day grace period, so by the time it applied ` +
    `you were ${grace + claimed} days past due rather than ${claimed}. That is what your lease ` +
    `says, and it is your landlord's call whether to waive it — not mine.`
  )
}

export const __waiverInternals = { WAIVER_REQUEST, claimedDaysLate, graceDaysFromResults, waiverArithmeticLine }
/** Exposed for salesTimeGuard.test.ts — guard internals, not API. */
export const __salesInternals = { OFFERS_A_MEETING_TIME }

/**
 * Did this reply just re-answer the PREVIOUS turn?
 *
 * S626, and it was under four of the six tenant conversations and five of the
 * nineteen in Nic's review. A tenant who said "no thanks, I'll sort it out
 * myself later" had the entire $2,330 breakdown read at them a second time,
 * word for word. One who asked the agent to double-check the lease got the same
 * sentence about a $75 pet deposit back, unchanged, as though they had not
 * spoken.
 *
 * Nothing in the guard chain looked ACROSS turns. collapseRepetition dedupes
 * lines within a single reply and has no idea what was said a moment ago, and
 * every other net reasons about the current message in isolation. So the model
 * could answer the previous question perfectly and no layer would notice it had
 * answered the wrong one.
 *
 * Measured as a shared PREFIX rather than equality, because the repeats are not
 * byte-identical — they trail off differently or append a clause. A long
 * identical opening is the signal; two different questions do not start their
 * answers with the same sixty characters by chance.
 *
 * Compared only against the LAST assistant turn. Legitimately restating a
 * figure from three turns ago ("as I mentioned, it's $2,330") is normal
 * conversation; immediately reissuing the reply just given is not.
 */
export function repeatsPreviousReply(
  history: ReadonlyArray<{ role: string; content?: string | null }>,
  text: string,
): boolean {
  if (!text?.trim()) return false
  const prior = [...history].reverse().find((m) => m.role === 'assistant' && m.content?.trim())
  if (!prior) return false
  const a = String(prior.content).replace(/\s+/g, ' ').trim()
  const b = text.replace(/\s+/g, ' ').trim()
  if (!a || !b) return false
  if (a === b) return true
  let i = 0
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
  // Same bar the two-turn harness asserts at, so anything it would flag gets
  // one correction attempt before it reaches a person.
  if (i >= 60 || i >= Math.min(a.length, b.length) * 0.5) return true

  // S628: A SHARED OPENING IS NOT THE ONLY WAY TO REPEAT YOURSELF.
  //
  // The prefix test above compares from character zero, so it scores nothing
  // when a reply recycles the MIDDLE of the last one. Caught in the S628 run,
  // on a tenant asking for a late fee to be waived:
  //
  //   turn 1  "Your lease at Oak Street … charges a $15 flat late fee. This fee
  //            is charged once when rent goes late — it is not per day and does
  //            not accrue. You have a grace period of 5 days."
  //   turn 2  "The $15 late fee is charged once when rent goes late — it is not
  //            per day and does not accrue. You have a grace period of 5 days."
  //
  // Common prefix: zero characters, because one starts "Your" and the other
  // "The". Reused content: almost all of it. The guard passed and the tenant
  // got the mechanics of their late fee read at them a second time instead of
  // an answer to the question they actually asked.
  //
  // Measured as PHRASE OVERLAP rather than whole sentences, because the reuse
  // is rarely a clean copy. In the case above the recycled sentence had been
  // re-opened — "This fee is charged once…" became "The $15 late fee is charged
  // once…" — so sentence equality scores it a miss while a reader plainly sees
  // the same sentence twice. Eight-word windows survive that kind of edit.
  const shingles = (t: string): Set<string> => {
    const w = t.toLowerCase().replace(/[^\p{L}\p{N}$%. ]/gu, ' ').split(/\s+/).filter(Boolean)
    const out = new Set<string>()
    for (let k = 0; k + 8 <= w.length; k++) out.add(w.slice(k, k + 8).join(' '))
    return out
  }
  const priorPhrases = shingles(a)
  const mine = [...shingles(b)]
  // Too short to judge. Two brief replies sharing a phrase is a coincidence,
  // not a repeat, and firing there costs a generation on ordinary conversation.
  if (priorPhrases.size === 0 || mine.length < 4) return false
  const overlap = mine.filter((x) => priorPhrases.has(x)).length / mine.length
  // Half of what they are about to read, they have already read.
  return overlap >= 0.5
}

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
    // S620: also catches a placeholder written as WORDS with spaces. A site
    // visitor was sent "I'm Skye, the booking assistant for [property name]."
    // — the tool that knows the name was never called, and the bracket form
    // below required a single lowercase token, so "property name" slipped
    // through and a template hole reached a customer. Two-to-four lowercase
    // words in brackets is a placeholder, never prose.
    /\[[a-z][a-z0-9_]*(?:\.[A-Za-z_]+)?\]|\{\{[^}]+\}\}|\[[a-z]+(?: [a-z]+){1,3}\]/.test(text)  // unresolved placeholder
    // S617: a tool call WRITTEN OUT as text. Asked "what is the late fee", the
    // agent replied "I'll look up your lease..." and then printed
    // <call name="get_my_lease"></call> into the chat. It had not called
    // anything; it typed the shape of a call. The customer sees markup.
    || /<\s*(call|tool_call|function_call|invoke)\b[^>]*>/i.test(text)
    || /^\s*\|.*\|/m.test(text)                                  // a table of records
    || /\b\d+\s+(vacant|occupied|open|pending|active|overdue|delinquent|expiring)\b/i.test(text)
    || /\b(you|they|he|she)\s+(have|has)\s+\d+\b/i.test(text)     // "you have 2 ..."
    || /\$[\d,]+(\.\d\d)?/.test(text)                            // a money figure
    || /\b\d{4}-\d{2}-\d{2}\b/.test(text)                        // an ISO date
    // "End Date: October 15" — a specific calendar date in prose.
    || /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i.test(text)
    // S617: statistics. "15% of rent charges (12 out of 80)" carried no dollar
    // sign, no date and no bullet, so every check above missed it — and it was
    // entirely invented. A rate or a ratio is a stored fact like any other.
    || /\d+\s*%/.test(text)
    || /\b\d+\s+out of\s+\d+\b/i.test(text)
    // ── S626: TWELVE OF FOURTEEN INVENTED FACTS WALKED THROUGH THIS ──────
    //
    // Probed with the things an agent actually fabricates, this function caught
    // exactly two: a dollar figure and an ISO date. Everything below was
    // MISSED — each one a per-tenant, per-lease or per-property fact that the
    // model is perfectly happy to invent, stated to somebody who will act on
    // it. This is the guard whose entire job is "do not send a number nobody
    // looked up", and it was checking for punctuation.
    //
    // Only reached when the question DEMANDED a lookup and no tool ran, so a
    // reply here has no source for any of it. Being strict is correct: the
    // alternative reply asks which thing they meant, which is recoverable.
    // A wrong due date is not.
    //
    // "Your rent is due on the 1st" — the one that started this. Ordinals were
    // invisible, so the commonest lease fact of all was unguarded.
    || /\b\d{1,2}(?:st|nd|rd|th)\b/i.test(text)
    // A bare month. The check above this one needs month AND day, so "your
    // lease ends in January" was fine by it.
    || /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(text)
    // A weekday being used as a date — "due every Monday", "payout lands
    // Tuesday". Anchored to a temporal preposition so ordinary prose that
    // happens to name a day (office hours from the knowledge base) is left be.
    || /\b(?:on|by|every|next|this|last|before|after|lands?|due)\s+(?:coming\s+)?(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(text)
    // COUNTS SPELLED OUT. "you have 2" was caught; "you have two open
    // maintenance requests" was not, and it is the same claim.
    || /\b(?:you|they|he|she|there)\s+(?:have|has|are|is)\s+(?:no|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(text)
    // A duration in words — "your grace period is five days", "thirty days
    // notice". These are lease terms and vary per lease.
    || /\b(one|two|three|four|five|six|seven|eight|nine|ten|fourteen|fifteen|twenty|thirty|sixty|ninety)[\s-]+(day|days|week|weeks|month|months|year|years)\b/i.test(text)
    // Money spelled out — "seventy-five dollars" evades the dollar sign.
    || /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)[\w\s-]{0,24}\bdollars?\b/i.test(text)
    // A UNIT OR SITE DESIGNATOR. "Your unit is Apt 101" names a specific row.
    || /\b(apt|apartment|unit|lot|site|space|suite|spot)\s*#?\s*\d+\b/i.test(text)
    // CONTACT DETAILS. Inventing a phone number or an email address sends
    // somebody to a stranger, and neither carried a dollar sign or a date.
    || /\b\(?\d{3}\)?[-. ]\s?\d{3}[-. ]\d{4}\b/.test(text)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)
    // S617: a street address. Asked to narrow "spot number one" to the RV
    // resort, the model answered "the one at 123 Main Street, and the one at
    // 456 Oak Avenue" — with no lookup behind it and neither address existing
    // anywhere in the portfolio. An address is as much a stored fact as a
    // balance, and a landlord being told about a property they do not own is
    // worse than being told nothing.
    || /\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Trail|Highway|Hwy)\b/.test(text)
  )
}

/**
 * A reply that PROMISES a lookup it never performed.
 *
 * S618. Both gates below suppress a tool-less reply only when it ASSERTS
 * something — a figure, a date, a list. That is the right test for a made-up
 * answer, and it is blind to the other way this fails. Measured on the real
 * path, a landlord asking "what's bob chen's balance" got back, in full:
 *
 *   "I'll look up Bob Chen's balance for you."
 *
 * No tool ran. Nothing followed. It states no fact, so assertsStoredFacts says
 * it is safe — and it is safe, in the sense that nothing in it is wrong. It is
 * also a dead end that reads like a promise, which is worse than an honest "I
 * can't see that": the landlord now waits for an answer that is never coming,
 * and the same question asked four other ways was answered correctly. One
 * wording in five falling through is exactly the shape this battery exists to
 * catch.
 *
 * DELIBERATELY NARROW, like the leak patterns in scopeGuard. It needs BOTH a
 * first-person promise AND a lookup verb IN THE SAME SENTENCE, so ordinary
 * closings survive: "Let me know if you want me to check that" carries the
 * verb but no promise (the "let me know" exclusion), and "I'll need to know
 * which unit" carries the promise but no lookup.
 *
 * A promised HANDOFF is excluded outright — "I'll check with the team and have
 * someone get back to you" is a real commitment that synthesizeHandoff turns
 * into a real escalation, and must not be rewritten here.
 */
/**
 * The agent said it would go and LOOK — so a lookup has to have happened.
 *
 * S618 (Nic), and this is the general rule the enumeration below was groping
 * at: "when the agent responds with the word look, or look for, or search, or
 * search for, or find out, or any other kind of questing type phrases, that
 * should require a tool to be called no matter what. Because that means it's
 * something that is not in the constant knowledge database — it's in the per
 * property or per user side of the platform where things change user to user."
 *
 * That is a better test than listing the ways a model can promise something.
 * Chasing phrasings, I wrote "look up" and "look into" and missed "look AT" —
 * which is exactly the reply that then shipped ("Let me look at your late
 * payment history."). The questing WORD is the signal, whatever grammar wraps
 * it: if the agent reached for the vocabulary of going and checking, it was
 * about to read per-user data, and per-user data only comes from a tool.
 */
const QUESTING_VERB =
  /\b(look(?:ing|ed)?(?:\s+(?:up|at|into|for|through|over))?|search(?:ing|ed)?|find(?:ing)?\s+out|check(?:ing|ed)?|pull(?:ing|ed)?(?:\s+(?:up|that|this|it|those|them))?|fetch\w*|retriev\w+|review(?:ing)?|verif\w+|confirm(?:ing)?|dig(?:ging)?\s+(?:in|into)|go(?:ing)?\s+through|take\s+a\s+look)\b/i

/**
 * Did the agent SAY it would go and check, without anything having been
 * checked?
 *
 * Only counts the agent talking about ITSELF doing the checking. "You can look
 * that up under Payments" is directing the person to the portal, which is a
 * fine answer to a how-to and must survive. A promised HANDOFF is excluded for
 * the same reason as before: synthesizeHandoff turns that into a real
 * escalation and rewriting it here would break it.
 */
const FIRST_PERSON =
  /\b(?:i'?ll|i\s+will|i'?m|i\s+am|let\s+me(?!\s+know)|we'?ll|we\s+will|lemme|one\s+moment|just\s+a\s+(?:moment|sec(?:ond)?)|hang\s+on|give\s+me\s+a\s+(?:sec(?:ond)?|moment))\b/i

/**
 * The agent promising to DO something, when nothing ran.
 *
 * S626. QUESTING_VERB covers going and LOOKING — look up, check, pull, verify.
 * It has never covered ACTING, so "I'll file a maintenance request for the
 * leaking kitchen sink. How urgent is this issue?" passed every guard in the
 * file: it is not a past-tense claim, so claimsAnActionItNeverTook missed it,
 * and it promises no lookup, so saysItWillCheck missed it too.
 *
 * Nothing was filed. The tenant in the two-turn suite happens to reply, and the
 * request gets filed on turn two — which is why this never showed up as a
 * failure. A tenant who reads "I'll file a maintenance request" and closes the
 * tab has reported a leak to nobody, and the first anyone hears of it is the
 * damage.
 *
 * profiles.ts has said so since S552, in its own words: "Phrases like 'I'll
 * file that' do NOTHING on their own and strand the customer." It was never
 * enforced.
 *
 * Promises of a PERSON are deliberately excluded — an escalation has its own
 * net (synthesizeHandoff) and its own rules about when it is allowed.
 */
const ACTION_VERB =
  /\b(file|filing|submit(?:ting)?|open(?:ing)?|log(?:ging)?|report(?:ing)?|put(?:ting)?\s+(?:that|this|it|in)|send(?:ing)?|schedul\w+|book(?:ing)?|cancell?(?:ing|ed|s)?|creat\w+|rais(?:e|ing)|start(?:ing)?|set(?:ting)?\s+(?:that|this|it)?\s*up|arrang\w+|add(?:ing)?|remov\w+|updat\w+)\b/i

export function promisesAnAction(text: string): boolean {
  if (!text) return false
  if (promisesHandoff(text)) return false
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? [text])
    .some((sentence) => FIRST_PERSON.test(sentence) && ACTION_VERB.test(sentence))
}

/**
 * The agent claiming it ALREADY DID something, when nothing ran.
 *
 * S618, and this is the worst thing measured all session. A tenant said "tell
 * my neighbor to turn their music down" and got back:
 *
 *   "I've logged your complaint about the noise from your neighbor. Your
 *    landlord has been notified and will follow up."
 *
 * Nothing was logged. No tool ran. The table had zero rows. Three of four
 * complaint phrasings produced a claim like that.
 *
 * This is a category worse than the promise saysItWillCheck catches. "I'll look
 * into that" leaves the customer waiting; "I've filed it" makes them STOP —
 * they believe it is handled, so they do not call, do not follow up, and the
 * landlord never hears about it. The agent has quietly closed the ticket by
 * lying about it.
 *
 * So: a completed-action claim with no action behind it does not go out. This
 * checks for the CLAIM, not the topic — "your landlord can see your complaints
 * in their portal" is information and survives; "I've logged it" does not.
 */
const CLAIMS_DONE =
  /\b(?:i'?ve|i have|i)\s+(?:already\s+)?(?:logged|filed|recorded|submitted|reported|created|opened|sent|passed (?:it |this )?(?:on|along)|notified|flagged|scheduled|booked|cancelled|canceled|updated|added|removed|saved)\b/i
const CLAIMS_DONE_PASSIVE =
  /\b(?:has|have|been)\s+(?:been\s+)?(?:logged|filed|recorded|submitted|reported|notified|created|sent|passed on|flagged|scheduled|booked|cancelled|canceled|updated)\b/i

export function claimsAnActionItNeverTook(text: string): boolean {
  if (!text) return false
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? [text])
    .some((sentence) => CLAIMS_DONE.test(sentence) || CLAIMS_DONE_PASSIVE.test(sentence))
}

export function saysItWillCheck(text: string): boolean {
  if (!text) return false
  if (promisesHandoff(text)) return false
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? [text])
    .some((sentence) => FIRST_PERSON.test(sentence) && QUESTING_VERB.test(sentence))
}


/**
 * What to say instead of a number nobody looked up.
 *
 * S617 (Nic): "if the agent is unsure about a response, then it should ask a
 * follow-up question to narrow down the scope... it just needs to adjust itself
 * to the correct scope."
 *
 * This used to be a wall — "I'm not able to pull that up right now... let me get
 * someone on the team to look." It asked nothing, so the conversation stopped
 * dead, and it half-promised a handoff for something that is not an escalation.
 *
 * A person who could not find something would ask which one you meant. So it
 * asks, and it asks the question that side of the platform can actually answer:
 * a tenant has one lease and needs only to say WHICH FACT; a landlord has many
 * properties and tenants and needs to say WHICH ONE.
 */
function cannotSee(audience: string): string {
  if (audience === 'landlord' || audience === 'pm_company') {
    return "I don't want to give you a figure I haven't actually checked. Which property or which tenant do you mean, and I'll pull it straight up?"
  }
  // S618: a guest has a booking, not a lease, and a visitor on a property site
  // has neither. Offering "your balance, your rent, your lease dates" to
  // someone who has none of those is worse than saying nothing — it implies an
  // account they do not have.
  if (audience === 'guest') {
    return "I don't want to give you a number I haven't actually checked. Which booking do you mean — the dates, the total, or the site you're on?"
  }
  if (audience === 'visitor' || audience === 'prospect') {
    return "I don't want to quote you a figure I haven't actually checked. What exactly were you after and I'll find it?"
  }
  return "I don't want to give you a number I haven't actually checked. Which part were you after — your balance, your rent, your lease dates, or your deposit?"
}

/**
 * What to say when the agent claimed to do something and nothing was done.
 *
 * Not cannotSee's wording: that asks which FACT they wanted, which is nonsense
 * in reply to "tell my neighbor to turn their music down". This admits the
 * action did not happen and asks for the detail needed to take it — the
 * opposite of quietly closing the ticket with a lie.
 */
function couldNotDoIt(): string {
  return "I haven't got that written down yet — tell me a bit more about what's happening and who it involves, and I'll pass it to your landlord."
}

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

/**
 * S624: a handoff the model would not call, built anyway.
 *
 * Same routing as synthesizeHandoff — a senior hands to a human, everyone else
 * hands up to the senior — but with no requirement that the model said anything
 * about a person. Reserved for a real money dispute that has already had its one
 * nudge and still ended without an escalation.
 */
export function forceHandoff(profile: AgentProfile, content: string): HandoffSignal | undefined {
  const allow = profile.toolNames ?? []
  if (!allow.includes('escalate') && !allow.includes('escalate_to_human')) return undefined
  return {
    kind: profile.tier === 'escalation' ? 'human' : 'tier',
    reason: 'Money dispute — the agent would not escalate after being told to, so the handoff was forced.',
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
  /** IANA zone the agent should consider "today" in. Defaults to the platform's
   *  America/Phoenix — see buildTemporalBlock. */
  timezone?: string
  /** S628: actions this conversation has already carried out, so an identical
   *  one is refused rather than done twice. See repeatedAction.ts. */
  priorToolCalls?: readonly { name: string; args: unknown }[]
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


  // The platform's own timezone. GAM is Arizona-based and every other piece of
  // business logic defaults here; what matters for an agent is the DATE, which
  // only differs across US zones for a few hours around midnight.
  const now = DateTime.now().setZone(input.timezone || 'America/Phoenix')

  /**
   * S628 — TWO PASSES, BECAUSE THEY ARE TWO DIFFERENT JOBS.
   *
   * Choosing a tool and writing a warm reply were being done in one call under
   * one 26 KB set of instructions, and the writing instructions were drowning
   * the choosing. Measured, same question and same 67 tools, only the system
   * prompt varying: 2/4/8 KB all call the tool; 16 KB and 26 KB call nothing
   * and invent a figure. Production is 26 KB.
   *
   * So the deciding pass gets a 1 KB prompt and the tools, and the composing
   * pass gets the full prompt and NO tools — nothing left to suppress. Proven
   * end to end before this was written: phase one called the right tool, phase
   * two answered "You owe $2,330" from the real result, in plain text, where
   * the single-pass version had invented "$1,200".
   *
   * Behind a flag, default OFF. This file carries a decade of accumulated
   * guards, several of which only the GPU eval exercises and the GPU eval
   * cannot currently run — so this gets proven on real conversations before it
   * becomes the default, not after.
   */
  const twoPass = process.env.AGENT_TWO_PASS === '1'
  const composingPrompt = profile.systemPrompt
  const decidingPrompt = twoPass ? buildDecisionPrompt(profile) : profile.systemPrompt

  // S628: the knowledge base is for COMPOSING, not for deciding. Retrieved
  // articles explain how late fees work and what a deposit is for — none of
  // which changes which tool answers "how much do I owe?". Carrying them into
  // the deciding pass added 3.5 KB of prose to a 1 KB prompt, and that prose
  // contains illustrative figures, which is one more place a number can be
  // lifted from and served as fact. It joins the conversation for the composing
  // pass, where it is exactly what is needed.
  const messages: ChatMessage[] = [
    { role: 'system', content: decidingPrompt },
    { role: 'system', content: buildTemporalBlock(now) },
    ...(twoPass ? [] : [{ role: 'system' as const, content: buildContextBlock(retrieved) }]),
    ...history,
    { role: 'user', content: message },
  ]

  const toolInvocations: ToolInvocation[] = []
  /**
   * S628: what this conversation has already done — see repeatedAction.ts.
   *
   * MUTABLE, and appended to as this turn's calls land. The stored log only
   * covers PREVIOUS turns, so without that the model could still call the same
   * action twice inside one turn — which is the likelier shape when a nudge
   * forces a rewrite and the model re-issues its whole plan rather than the
   * part that was missing.
   */
  const priorToolCalls: { name: string; args: unknown }[] = [...(input.priorToolCalls ?? [])]
  /** S628: the composing pass runs once, not once per guard-driven rewrite. */
  let composed = false
  let nudgedForAccountData = false
  let nudgedForPadding = false
  let nudgedForRepeat = false
  let nudgedForWaiverMath = false
  let nudgedForSalesTime = false
  let nudgedForPromisedAction = false
  let refusedOneEscalation = false
  let forceToolThisTurn = false
  let nudgedForDispute = false
  let nudgedForLead = false
  let nudgedForHardStop = false
  /** The phrase table's lookup is run at most once per turn. */
  let ranRoutedToolDirectly = false
  let model = ''
  const usage = { promptTokens: 0, completionTokens: 0 }
  const grounded = retrieved.length > 0
  const addUsage = (u?: { promptTokens?: number; completionTokens?: number }) => {
    usage.promptTokens += u?.promptTokens ?? 0
    usage.completionTokens += u?.completionTokens ?? 0
  }

  // Which lookup does this phrasing call for? Undefined when the table does not
  // recognise it, in which case a forced turn falls back to plain 'required'.
  // Consulted ONLY on a forced turn — it never overrides a tool the model chose
  // for itself, and never fires on an ordinary turn.
  // S626: hand the table the previous user turn so an anaphoric follow-up can
  // resolve its subject ("...after that?"). Fallback only — see routePlan.
  const lastUserMessage = [...history].reverse()
    .find((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.trim())
  const plan = routePlan(
    message, profile.audience, profile.toolNames ?? [],
    lastUserMessage ? String((lastUserMessage as any).content) : undefined,
  )
  const routedTools = plan.tools
  const routedTool = routedTools[0]

  // 2) Assemble the tool schemas for THIS TURN.
  //
  // S628: this used to be every tool the profile holds, sent on every turn.
  // After the action work that is 239 definitions for a landlord — 223 KB, some
  // 57,000 tokens — before the system prompt or a word of conversation, and it
  // took the KV cache from 5.5 GB per conversation to 18 GB. On this box that
  // is two concurrent conversations before Metal refuses to allocate and the
  // model server aborts; it did so four times in an hour.
  //
  // Every READ stays. Only actions are selected, because a missing lookup makes
  // the agent invent a number and a missing action makes it say "let me check" —
  // and those are not the same kind of wrong.
  //
  // The phrase table's own routing is pinned, so the deterministic layer is
  // never overruled by the lexical one.
  const selection = selectToolsForTurn(profile, getToolsForProfile(profile), message, {
    alwaysInclude: routedTools,
  })
  const tools = selection.tools
  const toolSchemas = tools.map(toToolSchema)
  if (selection.droppedActions > 0) {
    logger.debug({ profile: profile.id, offered: tools.length, dropped: selection.droppedActions },
      'agent runner: tool payload narrowed to this turn')
  }

  for (let step = 0; step < maxSteps; step++) {
    // S617: on the forced turn, take the escalation tools OFF the table. With
    // tool_choice 'required' the model must call SOMETHING, and given the
    // choice it called `escalate` — which is deliberately not counted as a
    // lookup, so the turn still ended with no data and the reply was
    // suppressed. The point of forcing is to make it look the answer up; an
    // escalation is the one option that does not.
    const turnTools = forceToolThisTurn
      ? toolSchemas.filter((t: any) => !/^escalate(_to_human)?$/.test(t?.function?.name))
      : toolSchemas

    const out = await chatCompletion(messages, {
      tools: turnTools.length > 0 ? turnTools : undefined,
      sampler: profile.sampler,
      // S617: on the turn RIGHT AFTER an account-data nudge, require a tool.
      // The nudge asks; roughly one phrasing in five the model declines and
      // answers from memory anyway, and that answer is invented — "$1,200" to a
      // tenant who owed $2,330. Asking again is a request. This is not.
      // Only the retry turn is forced, so every ordinary turn keeps the option
      // of a plain reply (and a knowledge-base answer stays one call).
      // S618: plain 'required', NOT the named form.
      //
      // Naming the routed tool looked like the obvious improvement and measured
      // worse. Under the real profile — ~30 tools, long system prompt — pinning
      // tool_choice to one function made the model LESS likely to call anything
      // than simply requiring a call: "is bob behind on rent?" and its four
      // neighbours went from answering correctly to no tool at all. (Both forms
      // are obeyed perfectly by a three-tool prompt, which is what made the
      // isolated test misleading.)
      //
      // Nothing is lost by dropping it. Where the phrase table knows the lookup
      // AND it needs no arguments, the runner executes it directly and never
      // asks the model at all. Where the lookup needs an argument only the model
      // can supply — WHICH tenant, WHICH unit — 'required' is the better prompt.
      toolChoice: forceToolThisTurn && turnTools.length > 0 ? 'required' : undefined,
    })
    // NOT cleared here. S617: tool_choice 'required' is honoured most of the
    // time, not every time — the same question that answered "$2,330" on one
    // run came back empty on the next. Clearing the flag after a single attempt
    // meant one non-compliant turn dropped straight through to a suppressed
    // reply. It now stays set until a lookup ACTUALLY runs (see below), so the
    // model gets every remaining step to comply rather than one.
    model = out.model
    addUsage(out.usage)

    // S628 — THE COMPOSING PASS.
    //
    // The deciding pass has stopped asking for tools, so whatever it wrote was
    // written under a 1 KB prompt that says nothing about voice, formatting,
    // warmth, repetition or any of the rules that make a reply fit to send.
    // Throw it away and write the reply properly: full instructions, every tool
    // result in the conversation, and NO tools attached — there is nothing left
    // to decide, and nothing left for a long prompt to suppress.
    //
    // Placed HERE, before every guard below, on purpose. The nudges all inspect
    // out.content — repetition, padding, the waiver arithmetic, promised
    // actions — and they must judge the reply the person would actually receive,
    // not the draft from the deciding pass.
    if (twoPass && out.toolCalls.length === 0 && !composed) {
      composed = true
      messages[0] = { role: 'system', content: composingPrompt }
      // The knowledge base arrives now, for the pass that actually writes prose.
      messages.push({ role: 'system', content: buildContextBlock(retrieved) })
      messages.push({
        role: 'system',
        content: buildComposeInstruction(toolInvocations.length > 0),
      })
      const written = await chatCompletion(messages, { sampler: profile.sampler })
      addUsage(written.usage)
      model = written.model
      if (written.content?.trim()) out.content = written.content
      logger.debug({ profile: profile.id, tools: toolInvocations.length },
        'agent runner: composed the reply under the full prompt')
    }

    if (out.toolCalls.length === 0) {
      // S618: a handoff is only ever real for a money problem.
      //
      // S624 — AND THE SECOND TIME OF ASKING IS THE LAST. synthesizeHandoff only
      // fires when the model PROMISED a person in prose. Asked "my last payout
      // never arrived in my bank account, where is my money?", the model instead
      // answered about payouts, promised nothing, and escalated nothing — so the
      // nudge below fired, the model declined it, and the prose-promise synthesis
      // had nothing to latch onto. A landlord asking where their money went was
      // handled entirely by a bot.
      //
      // The nudge is a REQUEST and a request can be refused; that is exactly why
      // tool_choice 'required' is documented above as honoured "most of the time,
      // not every time". So once the money nudge has already been spent on this
      // turn, stop asking and synthesize it. The escalation is the floor for a
      // money dispute, not a preference.
      const disputeUnhandled = needsARealPerson(message) && nudgedForDispute
      const synth = needsARealPerson(message)
        ? (synthesizeHandoff(profile, out.content) ?? (disputeUnhandled
            ? forceHandoff(profile, out.content)
            : undefined))
        : undefined
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
      // S624 — A PROSPECT WHO HANDS OVER THEIR DETAILS MUST BE RECORDED.
      //
      // Given "Sam Rivera, sam@example.com — that's correct, go ahead", Lucy
      // called nothing and replied "I'll send over the call details" — a promise
      // to follow up on a lead that was never saved. Then she repeated it fifty
      // times until the token ceiling. A prospect who volunteered their name and
      // email on the public marketing chat simply vanished.
      //
      // The phrase table cannot cover this: capture_lead needs arguments only
      // the model can read out of the conversation, so the direct-run path
      // (which is for argument-free lookups) does not apply. And the wording that
      // triggers it — a bare name and email — carries no keyword at all.
      //
      // An email or phone number in a prospect turn, with nothing recorded, is
      // unambiguous. Ask once, firmly.
      if (!nudgedForLead && profile.audience === 'prospect'
          && toolInvocations.length === 0 && CONTACT_DETAILS.test(message)) {
        nudgedForLead = true
        logger.warn({ profile: profile.id },
          'agent runner: prospect gave contact details and nothing was captured — forcing one retry (safety net)')
        messages.push({ role: 'assistant', content: out.content })
        messages.push({
          role: 'system',
          content:
            'STOP — this prospect has just given you their contact details. CALL capture_lead now, ' +
            'in this reply, with their name and email or phone plus everything you have learned about ' +
            'their portfolio. Do not promise to send anything or to have someone reach out until the ' +
            'lead is saved — a promise with no lead behind it is a lost customer.',
        })
        continue
      }
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
      // S618 (Nic): money only. A legal threat no longer forces a handoff —
      // the agent answers what it can and promises nobody. Account takeover
      // stays: someone else inside the account is money at risk.
      if (!nudgedForHardStop && ACCOUNT_SECURITY_INTENT.test(message)) {
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
      // ── S618: run the lookup ourselves rather than asking again ────────
      //
      // Measured, on the real path, with the phrase table live and the debug
      // confirming the route resolved and the tool WAS offered on the forced
      // turn: three of four phrasings of "how often do my tenants pay late"
      // still came back with no tool call. tool_choice 'required' and the
      // NAMED form both work in isolation — a three-tool prompt obeys either
      // every time — and both stop being reliable under the real profile,
      // which carries ~30 tools and a long system prompt. Forcing has a
      // ceiling, and asking a fourth time does not move it.
      //
      // But by this point we are not guessing. demandsAToolCall says the
      // question needs data, the model has already declined once, and the
      // phrase table has named the lookup that answers it. The only thing
      // still missing is somebody actually calling it — so we call it.
      //
      // ONLY for a lookup that takes no arguments from the model. Where the
      // model must supply a value — which tenant, which unit — it is the only
      // thing that knows what was meant, and guessing the argument would be
      // the invention this whole layer exists to prevent. Those keep the
      // forced-retry path, and measure fine on it (4/4 and 5/5).
      //
      // The result is fed back as an ordinary tool result, so the model still
      // writes the reply out of real data and stays free to call something
      // else if this was not what the person meant.
      if (
        routedTool &&
        toolInvocations.length === 0 &&
        demandsAToolCall(message, profile.audience) &&
        !ranRoutedToolDirectly
      ) {
        // Every lookup this wording calls for that needs no argument from the
        // model. "Is my landlord gonna renew?" runs BOTH the lease and the
        // renewal tendency, because neither answers it alone.
        // Runnable = the profile holds it, AND every argument it requires is
        // either unnecessary or supplied by the wording itself.
        const runnable = routedTools.filter((name) => {
          const t = getTool(name)
          if (!t || !getToolsForProfile(profile).some((pt) => pt.name === name)) return false
          const req = ((t.parameters as any)?.required ?? []) as string[]
          if (req.length === 0) return true
          return req.every((k) => plan.args && plan.args[k] != null && plan.args[k] !== '')
        })
        if (runnable.length) {
          ranRoutedToolDirectly = true
          const calls: ToolCall[] = runnable.map((name) => {
            const t = getTool(name)
            const req = ((t?.parameters as any)?.required ?? []) as string[]
            const args = req.length && plan.args
              ? Object.fromEntries(req.map((k) => [k, plan.args![k]]))
              : {}
            return {
              id: `routed_${name}`,
              type: 'function' as const,
              function: { name, arguments: JSON.stringify(args) },
            }
          })
          logger.warn({ profile: profile.id, tools: runnable, message },
            'agent runner: model would not call the lookup — ran it directly from the phrase table')
          // content: null, DELIBERATELY.
          //
          // S618, and this was a real regression caught by the battery. This
          // used to carry `out.content` — the model's own tool-less reply — into
          // the conversation ahead of the real result. That reply is precisely
          // the ungrounded guess we are stepping in to correct: "You have 6
          // vacant units" when there are 13, "26 units across 4 properties"
          // against 21 across 3. Handed its own claim and then the true rows,
          // the model restated the claim and the tools became decoration.
          //
          // The assistant turn is the CALL and nothing else, which is also the
          // ordinary shape of a tool-calling turn. The nudge path below still
          // keeps the text on purpose — there the model is being shown what it
          // said in order to correct it — but here the text is not evidence of
          // anything except the error.
          messages.push({ role: 'assistant', content: null, tool_calls: calls })
          for (const call of calls) {
            const args = parseArgs(call.function.arguments)
            // S628: refuse an action this conversation has ALREADY carried out with
      // exactly these arguments. See repeatedAction.ts — the run caught the
      // agent filing a second maintenance request for one leaking sink while
      // correctly telling the tenant it was already logged.
      const repeat = alreadyDone(call.function.name, args, priorToolCalls)
      const result = repeat
        ? (logger.warn({ profile: profile.id, tool: call.function.name },
            'agent runner: refused a repeat of an action already taken this conversation'),
           { ok: true, alreadyDone: true, tellThem: repeat.tellThem })
        : await executeToolCall(call, profile, actor, args)
      if (!repeat) priorToolCalls.push({ name: call.function.name, args })
            toolInvocations.push({ name: call.function.name, args, result })
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: JSON.stringify(result),
            })
          }
          forceToolThisTurn = false
          continue
        }
      }
      // S626: ...and the reply must actually DO the thing this net exists to
      // correct. The STOP text below opens "your last answer stated
      // account-specific facts without fetching them" — and nobody checked that
      // it had. demandsAToolCall defaults to TRUE for a tenant or a landlord, so
      // ANY follow-up that was not a bare "ok" satisfied it, including a
      // decline. Measured: a tenant answered their balance said "no thanks,
      // I'll sort it out myself later", the model replied appropriately and
      // tool-lessly, this net fired on a reply containing no figures at all,
      // forced get_my_payment_status, and the model — told to "answer from its
      // result" — reissued the $2,330 breakdown verbatim. The guard against
      // invented numbers was manufacturing the repeat.
      //
      // A reply that states no fact, makes no promise and claims no action has
      // nothing in it to invent. This is the same three-way test the step
      // ceiling has always used before suppressing; the nudge simply never
      // shared it.
      //
      // SCOPED TO FOLLOW-UP TURNS. On turn one the net stays exactly as
      // aggressive as it was: "when is rent due?" answered "the 1st" with no
      // lookup is a per-lease fact stated from memory, assertsStoredFacts does
      // NOT catch a bare ordinal, and that answer must still be forced through
      // a tool. The repeat only exists where there is something to repeat, so
      // the relaxation is confined to turns that carry history — which is also
      // the only place the old behaviour was doing harm.
      if (
        !nudgedForAccountData &&
        toolInvocations.length === 0 &&
        demandsAToolCall(message, profile.audience) &&
        (history.length === 0
          || assertsStoredFacts(out.content) || saysItWillCheck(out.content)
          || claimsAnActionItNeverTook(out.content))
      ) {
        nudgedForAccountData = true
        forceToolThisTurn = true
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
        (assertsStoredFacts(out.content) || saysItWillCheck(out.content)
         || claimsAnActionItNeverTook(out.content))
      ) {
        const lied = claimsAnActionItNeverTook(out.content)
        logger.error({ profile: profile.id, message, claimedAnAction: lied },
          'agent runner: no tool call after a retry — reply stated, promised or CLAIMED something it never did; suppressed')
        return {
          reply: lied ? couldNotDoIt() : cannotSee(String((actor as any).role ?? '')),
          model, retrieved, grounded, toolInvocations, usage,
        }
      }
      // S617: the tools DID run, and the model added rows they never returned.
      // Suppress rather than hand a landlord a list with invented properties in
      // it — acting on a fake expiring lease is a real-world mistake.
      if (toolInvocations.length > 0) {
        const results = toolInvocations.map((t) => t.result)
        const invented = [
          ...namesNotInToolResults(out.content, results),
          ...countsNotInToolResults(out.content, results),
        ]
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
          return { reply: cannotSee(String((actor as any).role ?? '')), model, retrieved, grounded, toolInvocations, usage }
        }
      }
      // S626: the turn promised to DO something and did nothing. See
      // promisesAnAction. Only when NO tool ran at all — if something ran, the
      // promise has an action behind it and the padding/invention nets own the
      // rest.
      if (
        !nudgedForPromisedAction &&
        toolInvocations.length === 0 &&
        promisesAnAction(out.content)
      ) {
        nudgedForPromisedAction = true
        logger.warn({ profile: profile.id, message },
          'agent runner: reply promised an action and called nothing — forcing one retry')
        messages.push({ role: 'assistant', content: out.content })
        messages.push({
          role: 'system',
          content:
            'STOP — you just told them you would do something, and you called no tool, so nothing ' +
            'happened. If they stop replying now, the thing you promised does not exist and they ' +
            'will not know.\n' +
            'Do it NOW: call the tool that performs it, in this reply, and then tell them it is done ' +
            'and what happens next.\n' +
            // S626: this is the specific stall that produced the bug. The
            // maintenance tool requires only a title and a description; the
            // model held the whole filing hostage to a priority it did not need.
            'Do not wait on optional details first. If the tool only requires what you already have, ' +
            'call it with that and use a sensible default for the rest — you can ask about urgency, ' +
            'category or extras AFTER it is filed, and then update it. Filing late is recoverable; ' +
            'not filing is not.\n' +
            'If no tool you hold can actually do it, say so plainly and tell them who can — do not ' +
            'promise it in the hope it resolves itself.',
        })
        continue
      }
      // S626: a sales turn that offered or confirmed a TIME without ever opening
      // the calendar. See OFFERS_A_MEETING_TIME. Prospect only — no other
      // audience books anything on this calendar.
      if (
        !nudgedForSalesTime && profile.audience === 'prospect' &&
        !toolInvocations.some((t) => SCHEDULING_TOOLS.has(t.name)) &&
        OFFERS_A_MEETING_TIME.test(out.content)
      ) {
        nudgedForSalesTime = true
        // S626: ASKING DOES NOT WORK HERE, AND NEITHER DOES INSISTING.
        //
        // First attempt pushed the correction and left the tools optional. The
        // model agreed with it and answered "Let me check the available times.
        // I'll send over the calendar invite once we confirm" — still calling
        // nothing, now promising twice. Second attempt set tool_choice
        // 'required', which S617 relies on elsewhere; instrumented, the turn
        // came back with content and an EMPTY tool_calls array anyway. Whatever
        // the local server does with tool_choice on this profile, it is not
        // guaranteeing a call.
        //
        // So take the same route the phrase table takes when the model will not
        // call a lookup: RUN IT, and hand back the result. Real slots in the
        // context beat any instruction about fetching them, and
        // get_available_call_times takes no arguments, so nothing is being
        // guessed on the model's behalf — which is the line that path draws.
        logger.warn({ profile: profile.id, message },
          'agent runner: sales reply offered a meeting time with no calendar lookup — running it directly')
        const slotsTool = getTool('get_available_call_times')
        const slotsCall: ToolCall = {
          id: 'routed_get_available_call_times',
          type: 'function' as const,
          function: { name: 'get_available_call_times', arguments: '{}' },
        }
        if (slotsTool && getToolsForProfile(profile).some((t) => t.name === 'get_available_call_times')) {
          const slotsResult = await executeToolCall(slotsCall, profile, actor, {})
          toolInvocations.push({ name: 'get_available_call_times', args: {}, result: slotsResult })
          // content: null — the invented time is not evidence of anything, and
          // handing the model its own claim back is how S618 got it restated.
          messages.push({ role: 'assistant', content: null, tool_calls: [slotsCall] })
          messages.push({
            role: 'tool', tool_call_id: slotsCall.id,
            name: 'get_available_call_times', content: JSON.stringify(slotsResult),
          })
        } else {
          messages.push({ role: 'assistant', content: out.content })
        }
        messages.push({
          role: 'system',
          content:
            'STOP — your last reply put a meeting time in front of a prospect, or promised them an ' +
            'invite, and you had not opened the calendar. Those times were invented and nothing you ' +
            'said would have sent anything.\n' +
            'The real openings are in the tool result above. Offer two or three of THOSE, ' +
            'conversationally — never the whole list.\n' +
            'If they have already named a day or a rough time, honour it: offer what is free then, ' +
            'and if nothing is, say so plainly and offer the nearest alternative. Do not quietly ' +
            'move them to a different day.\n' +
            'ASK FOR THEIR NAME AND EMAIL IN THIS SAME REPLY. book_sales_call cannot run without ' +
            'both, so a slot offered without them goes nowhere — offer the time and ask for the two ' +
            'details together, in one short line: "Tuesday at 1 works — what name and email should I ' +
            'put on it?" Offering a time and waiting is the failure; it leaves the prospect thinking ' +
            'something is being held when nothing is.\n' +
            'Nothing is scheduled until book_sales_call has run: do not say an invite is coming, do ' +
            'not say you will send anything, and do not say "once we confirm" as though the booking ' +
            'is already in motion.',
        })
        continue
      }
      // S626: a waiver request answered without the arithmetic. Nic's note on
      // this exact conversation: "do the math out loud — the grace period
      // already gave them 5 days, so they're not 2 days late, they're 7." The
      // instruction has been in profiles.ts since S624 and was followed on none
      // of the runs; the agent recited the fee policy back instead, which
      // answers a question they did not ask.
      //
      // Only fires when the numbers are actually known — a grace period from a
      // real lookup and a figure the person themselves put forward. Where the
      // lease has no grace period there is no arithmetic to do and this stays
      // out of the way.
      if (WAIVER_REQUEST.test(message) && toolInvocations.length > 0) {
        const grace = graceDaysFromResults(toolInvocations.map((t) => t.result))
        const claimed = claimedDaysLate(message)
        const total = grace != null && claimed != null ? grace + claimed : null
        // S628: the guard used to sit on the OUTER condition, so once the nudge
        // had fired this whole block was skipped and there was no second look.
        // The deterministic fallback below needs that second look — it is the
        // one that runs when the rewrite came back without the number again.
        const missingArithmetic =
          total != null && grace != null && grace > 0 && !new RegExp(`\\b${total}\\b`).test(out.content)
        if (missingArithmetic && !nudgedForWaiverMath) {
          nudgedForWaiverMath = true
          logger.warn({ profile: profile.id, grace, claimed, total },
            'agent runner: waiver answered without the grace-period arithmetic — forcing one rewrite')
          messages.push({ role: 'assistant', content: out.content })
          messages.push({
            role: 'system',
            content:
              // S626: this instruction did not work as a polite briefing. The
              // model read it and recited the fee policy again anyway. Every
              // net in this file that actually changes behaviour opens by
              // REJECTING the draft — "STOP —" — rather than describing a
              // better one, so this now does the same.
              'STOP — you answered a request to remove a fee by reading the fee policy back to ' +
              'them. They did not ask how late fees work. They made an argument, and you have not ' +
              'answered it.\n' +
              // S626: the first two versions of this told the model the ANSWER
              // and it declined to say it, twice, regenerating a policy recital
              // instead. It was not being stubborn — it had no reason to
              // contradict the customer's own count. So give it the reasoning
              // rather than the conclusion: the fee EXISTS, therefore the grace
              // period was already spent. That is what makes the number
              // sayable, and it is also what makes it true.
              `Reason it through before you answer. Their lease has a ${grace}-day grace period, ` +
              `so a late fee cannot be charged at all until day ${grace + 1}. They HAVE been ` +
              `charged one. So their "${claimed} days" cannot be counted from the due date — ` +
              `it is ${claimed} days past the end of the grace period, which is ${total} days past ` +
              `the due date. ${total}, not ${claimed}. That is the answer to the argument they made, ` +
              'and it is the only part of this they do not already know.\n' +
              `Write the reply again, and it MUST contain the number ${total}. Open with the ` +
              'arithmetic in your own words — something equivalent to: "the fee only kicks in after ' +
              `the ${grace}-day grace period, so by the time it applied you were ${total} days past ` +
              `due, not ${claimed}." Say it once, kindly, and do not lecture.\n` +
              'Then close on the frame rather than the rule: you are not arguing with them, that is ' +
              'what their lease says, and the platform runs on the lease.\n' +
              'Do NOT restate the fee amount, the due date or the grace period as a policy summary — ' +
              'they read all of that in your last message. Do NOT offer to waive it and do NOT ' +
              "suggest their landlord might; that is the landlord's call, not yours to float.",
          })
          continue
        }
        // S628: AND IF IT STILL WILL NOT SAY IT, SAY IT FOR IT.
        //
        // This instruction has now been rewritten four times — S624 put it in
        // profiles.ts, S626 rewrote it twice inside this net — and the S628 run
        // shows it failing again with everything detected correctly: grace 5,
        // claimed 2, the nudge fired, and the regenerated reply was another
        // recital of the fee policy. Then collapseRepetition truncated it
        // mid-word and the tenant got half a sentence about accrual.
        //
        // Four attempts is enough to conclude the model will not contradict a
        // customer's own count of their days, however the instruction is
        // phrased. The rest of this file already knows what to do about that:
        // when the phrase table needs a lookup the model will not make, it runs
        // the lookup itself rather than asking again. Same principle. The
        // arithmetic is not a judgement call — it is grace + claimed, from a
        // real lease and their own words — so compute the sentence and put it
        // in front of the reply.
        //
        // Placed FIRST because it is the one thing in the message they do not
        // already know, and appended-to rather than replacing the reply so
        // whatever else the model got right still reaches them.
        if (missingArithmetic && nudgedForWaiverMath) {
          logger.warn({ profile: profile.id, grace, claimed, total },
            'agent runner: waiver arithmetic refused twice — prepending it deterministically')
          out.content = `${waiverArithmeticLine(grace, claimed!)}\n\n${out.content}`
        }
      }
      // S626: the reply is fine on its own terms — but is it an answer to the
      // question that was just asked, or to the one before it? See
      // repeatsPreviousReply. Last gate before this reaches a person, and it
      // costs nothing on a turn that does not repeat.
      if (!nudgedForRepeat && repeatsPreviousReply(history, out.content)) {
        nudgedForRepeat = true
        logger.warn({ profile: profile.id, message },
          'agent runner: reply repeated the previous turn — forcing one rewrite')
        messages.push({ role: 'assistant', content: out.content })
        messages.push({
          role: 'system',
          content:
            // S626: where a lookup DID run this turn, hand the rows back with
            // the correction. The verification case is the one that defeated a
            // pure instruction: asked "that doesn't sound right — check my
            // actual lease", the model called get_my_full_lease, found the same
            // $75, and reissued its one-line answer unchanged, because being
            // told not to repeat left it with nothing it believed it was
            // allowed to say. It is not short of material — the full lease came
            // back — so restating that material is what unblocks it. Same
            // technique the padding net uses.
            (toolInvocations.length
              ? 'You DID look this up. Here is exactly what came back:\n' +
                JSON.stringify(toolInvocations.map((t) => ({ tool: t.name, result: t.result }))) +
                '\nUse it — say what you checked and what it actually says.\n'
              : '') +
            'STOP — that is the same answer you just gave, almost word for word. ' +
            'They have already read it; sending it again tells them you were not listening. ' +
            `They have now said: "${message}" — respond to THAT, and only to that.\n` +
            // S626: the first version of this said flatly "do not restate the
            // figures", and that is wrong for the commonest case of all. Asked
            // "that doesn't sound right — can you check what my lease says?"
            // the figure IS the answer, so the model was told not to give it,
            // had nothing else to give, and reissued the identical sentence.
            // The instruction has to name the shape of the follow-up, not ban
            // a category of content.
            'Pick whichever of these fits what they just said:\n' +
            '- They QUESTIONED a figure or asked you to double-check it: they are not asking to ' +
            'hear the same sentence again — they are asking whether you actually looked. ' +
            'Name the document you opened, give what it says, and state plainly whether that ' +
            'confirms or corrects what you told them. If it confirms it, say so directly — ' +
            '"I pulled your signed lease and it does say X" — and add the surrounding detail ' +
            'they have not seen yet, so the check is visible. Never re-send the original sentence.\n' +
            '- They DECLINED, said no thanks, or closed the subject: accept it in one line and stop. ' +
            'Do not re-sell, do not re-explain, do not repeat what they owe.\n' +
            '- They CONFIRMED something you already did: acknowledge it and add the next useful ' +
            'fact — what happens now, and roughly when. Do not do it a second time.\n' +
            '- They asked something NEW: answer that. Everything in your previous reply still ' +
            'stands, so do not repeat it — say only what they do not know yet.\n' +
            'Keep it short. A brief reply that moves the conversation forward beats a complete ' +
            'one that hands them back what they just read.',
        })
        continue
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
      // S628: refuse an action this conversation has ALREADY carried out with
      // exactly these arguments. See repeatedAction.ts — the run caught the
      // agent filing a second maintenance request for one leaking sink while
      // correctly telling the tenant it was already logged.
      const repeat = alreadyDone(call.function.name, args, priorToolCalls)
      const result = repeat
        ? (logger.warn({ profile: profile.id, tool: call.function.name },
            'agent runner: refused a repeat of an action already taken this conversation'),
           { ok: true, alreadyDone: true, tellThem: repeat.tellThem })
        : await executeToolCall(call, profile, actor, args)
      if (!repeat) priorToolCalls.push({ name: call.function.name, args })
      turnCache.set(cacheKey, result)

      // An escalation tool is a CONTROL signal, not a data/action tool —
      // detect it BEFORE recording, so it never pollutes the tool ledger
      // (tool_invocation_count / tool_names / tool_invocations) and hands
      // control back to the session orchestrator.
      const handoff = asHandoff(result)

      // S617: refuse ONE self-chosen escalation on a question a tool could have
      // answered. Measured on the real path, the agent escalated "how much do I
      // owe?" and "how do late fees work?" to a human — a balance it could read
      // and a lease term it could look up. Two rewrites of the escalate tool's
      // description did not stop it, so this is deterministic.
      //
      // Deliberately narrow: it only fires when the question demands a lookup,
      // NO tool has run yet, and this has not already been refused once. The
      // genuine hard stops — a refund, a legal dispute, an account-security
      // incident — do not demand a lookup, and the nets above force THEIR
      // escalation before this point, so none of them are caught here.
      // S618: ...unless it is a real money problem, which is the one thing
      // that SHOULD reach a person. Inverting the default in demandsAToolCall
      // made it true for nearly every message, including "refund please" — so
      // this guard began intercepting genuine escalations and answering them
      // with a lookup. A refund is not answerable by any query.
      if (
        handoff && !refusedOneEscalation &&
        toolInvocations.length === 0 &&
        demandsAToolCall(message, profile.audience) &&
        !needsARealPerson(message)
      ) {
        refusedOneEscalation = true
        logger.warn({ profile: profile.id, message },
          'agent runner: escalation on an answerable question — looking it up instead')
        messages.push({ role: 'assistant', content: out.content || null, tool_calls: out.toolCalls })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({
            ok: false,
            error:
              'Not escalated — this is answerable. You have not looked anything up yet. ' +
              `Call the tool that answers it (you have: ${(profile.toolNames ?? []).join(', ')}) ` +
              'and reply from the result. Escalate only if the lookup itself cannot tell you.',
          }),
        })
        continue
      }

      if (handoff) {
        return { reply: '', model, retrieved, grounded, toolInvocations, usage, handoff }
      }

      toolInvocations.push({ name: call.function.name, args, result })
      forceToolThisTurn = false   // a lookup happened; stop forcing
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
  let reply = final.content || STEP_CEILING_FALLBACK

  // S617: the guards live in the loop, and this path is OUTSIDE it — so an
  // answer that reached here had none of them applied. Measured: asked "what's
  // my late payment rate", the model declined the tool through every step, fell
  // out here, and produced "<10 days late: 15% of rent charges (12 out of 80)"
  // — buckets and a tenant count that exist nowhere in the data. A landlord
  // could act on that.
  //
  // The ceiling means the model would not look it up. That is precisely when it
  // must not be trusted to state figures.
  if (
    toolInvocations.length === 0 && demandsAToolCall(message, profile.audience) &&
    (assertsStoredFacts(reply) || saysItWillCheck(reply) || claimsAnActionItNeverTook(reply))
  ) {
    const lied = claimsAnActionItNeverTook(reply)
    logger.error({ profile: profile.id, message, claimedAnAction: lied },
      'agent runner: step ceiling produced figures, a promise, or a claim with nothing behind it — suppressed')
    reply = lied ? couldNotDoIt() : cannotSee(String((actor as any).role ?? ''))
  }

  // S618: and the same at the ceiling. Where it is NOT a money problem, any
  // promise of a person is removed from the reply rather than made true.
  if (!needsARealPerson(message)) reply = stripPromiseOfAPerson(reply)
  const ceilingHandoff = needsARealPerson(message) ? synthesizeHandoff(profile, reply) : undefined
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
