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
  /\b(can|could)\s+(i|we)\s+(pay|add|set up|create|file|report|upload|invite|book|reserve|cancel|renew)\b/i,
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
const NOT_A_REQUEST =
  /^\s*(hi|hey|hello|yo|thanks|thank you|ty|ok|okay|k|got it|sure|yep|yes|no|nope|nvm|never ?mind|bye|goodbye|cool|great|nice|awesome|perfect|sounds good|will do|understood|makes sense)\b[\s!.,?]*$/i

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
  if (audience === 'prospect') return false

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
  let refusedOneEscalation = false
  let forceToolThisTurn = false
  let nudgedForDispute = false
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
  const plan = routePlan(message, profile.audience, profile.toolNames ?? [])
  const routedTools = plan.tools
  const routedTool = routedTools[0]

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

    if (out.toolCalls.length === 0) {
      // S618: a handoff is only ever real for a money problem.
      const synth = needsARealPerson(message) ? synthesizeHandoff(profile, out.content) : undefined
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
            const result = await executeToolCall(call, profile, actor, args)
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
      if (
        !nudgedForAccountData &&
        toolInvocations.length === 0 &&
        demandsAToolCall(message, profile.audience)
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
