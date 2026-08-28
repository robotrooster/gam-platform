/**
 * S628 — SEND THE TOOLS THIS TURN NEEDS, NOT EVERY TOOL THE AGENT HAS.
 *
 * Nic: "the agent should be able to handle everything a landlord or tenant
 * would handle... it should know from context of what was said, what tool to
 * pull." Those are one requirement, not two, and I implemented them as two.
 * Giving the landlord agent 228 endpoints meant putting 239 tool definitions in
 * front of it on every single turn — 223 KB, roughly 57,000 tokens, before the
 * system prompt or a word of conversation.
 *
 * WHAT THAT COST, measured on 2026-08-28:
 *
 *   KV cache per conversation went 5.5 GB -> 18 GB. On a 96 GB box with a
 *   27.7 GB model and a ~72 GB GPU wired limit that is TWO concurrent
 *   conversations before Metal refuses to allocate and the server aborts. It
 *   crashed four times in an hour.
 *
 * A person who can do 239 things is not holding 239 in their head while you
 * talk. They hear "waive Bob's late fee" and reach for one drawer. Capability
 * does not require presence — that is the mistake this file corrects.
 *
 * WHY LEXICAL AND NOT EMBEDDINGS. The embeddings service is right there and
 * GPU-safe, and it may still be the answer later. But the descriptions written
 * in portalActions.ts are deliberately phrased in the PERSON'S words — "waive
 * Bob's late fee", "add 12 RV spots to Sunset Palms", "the roofer sent a $4,200
 * invoice" — so the words a landlord types are largely the words already in the
 * text. Scoring on that needs no model, no network call, no warm-up, and is
 * deterministic enough to unit-test, which an embedding ranking is not. It also
 * cannot itself fail at the moment the GPU is under pressure, which is exactly
 * when this code matters most.
 *
 * NOTHING IS EVER LOST. The floor is the deciding property: every read tool,
 * every escalation, and anything the phrase table routes to is always present.
 * Selection only decides which ACTIONS ride along, and a missed action is a
 * "let me check" rather than a wrong answer — where a missed lookup would be a
 * fabrication. That asymmetry is why the cut falls where it does.
 */
import type { AgentProfile } from './types'
import type { AgentTool } from './tools/types'

/** Words that carry no signal about which drawer to open. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'that', 'this',
  'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'they', 'them', 'their',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'want', 'need',
  'have', 'has', 'had', 'get', 'got', 'please', 'thanks', 'hi', 'hello', 'ok', 'okay',
  'what', 'when', 'where', 'who', 'how', 'why', 'not', 'no', 'yes', 'so', 'just',
  'about', 'any', 'all', 'some', 'one', 'up', 'out', 'now', 'then', 'there', 'here',
])

function tokens(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

/** Crude stem so "charges"/"charging"/"charge" and "units"/"unit" all meet. */
function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '') || w
}

/** A tool's searchable text: its name, split, plus its description. */
function haystack(t: AgentTool): Set<string> {
  const name = t.name.replace(/_/g, ' ')
  return new Set([...tokens(name), ...tokens(String(t.description ?? ''))].map(stem))
}

const HAY = new WeakMap<AgentTool, Set<string>>()
function hayFor(t: AgentTool): Set<string> {
  let h = HAY.get(t)
  if (!h) { h = haystack(t); HAY.set(t, h) }
  return h
}

/**
 * A READ tool answers a question; an ACTION changes something.
 *
 * Only actions are ever dropped. Getting a lookup wrong makes the agent invent
 * a number, which is the failure this whole system is built against; getting an
 * action wrong makes it say "I'll need to check on that", which is a worse
 * answer and not a false one.
 */
export function isActionTool(name: string): boolean {
  return !/^(get|list|search|check|lookup|query)_/.test(name) && name !== 'escalate'
    && name !== 'escalate_to_human'
}

/** Below this many tools the payload is not the problem and nothing is cut. */
export const SELECTION_THRESHOLD = 90

export interface Selection {
  tools: AgentTool[]
  /** For logging: how much was left behind, so the saving is visible. */
  droppedActions: number
}

/**
 * The tools for one turn: every read, plus the actions this wording reaches for.
 *
 * `alwaysInclude` carries anything the phrase table already routed to, so the
 * deterministic layer is never undercut by the statistical one.
 */
export function selectToolsForTurn(
  profile: AgentProfile,
  all: readonly AgentTool[],
  message: string,
  opts: {
    maxActions?: number
    alwaysInclude?: readonly string[]
    /**
     * What the person said on the turn BEFORE this one.
     *
     * S628: a follow-up is often all pronouns. Sweeping every action against
     * the phrasing in its own description, 149 of 150 were reachable and the
     * miss was finalize_utility_bill on "send that one out" — which names
     * nothing, and after "run the water bills for March" plainly means the
     * bill. Nic: "it should know from context of what was said." Scored at half
     * weight, so it colours an ambiguous turn without letting the previous
     * subject override a clear change of topic.
     */
    previousMessage?: string
  } = {},
): Selection {
  const maxActions = opts.maxActions ?? 24
  const pinned = new Set(opts.alwaysInclude ?? [])

  // A SMALL PROFILE IS LEFT ENTIRELY ALONE.
  //
  // The tenant agent carries 67 tools — 49 KB, about 13k tokens — and was never
  // what broke. Selecting there would add a second thing that can go wrong in
  // exchange for nothing, so the cut applies only where the payload is actually
  // the problem. The landlord agent at 239 is; anything of this size is not.
  if (all.length <= SELECTION_THRESHOLD) return { tools: [...all], droppedActions: 0 }

  const reads = all.filter((t) => !isActionTool(t.name))
  const actions = all.filter((t) => isActionTool(t.name))
  if (actions.length <= maxActions) return { tools: [...all], droppedActions: 0 }

  const want = new Set(tokens(message).map(stem))
  // Carried context, at half weight — see previousMessage above.
  const carried = new Set(
    tokens(opts.previousMessage ?? '').map(stem).filter((w) => !want.has(w)))
  const scored = actions.map((t) => {
    if (pinned.has(t.name)) return { t, score: Number.POSITIVE_INFINITY }
    const hay = hayFor(t)
    let score = 0
    for (const w of want) if (hay.has(w)) score += 1
    for (const w of carried) if (hay.has(w)) score += 0.5
    // A word in the NAME is worth more than one buried in prose: "renumber" in
    // renumber_unit is what the tool is, where the same word inside another
    // tool's description is likely a cross-reference to this one.
    const nameWords = new Set(tokens(t.name.replace(/_/g, ' ')).map(stem))
    for (const w of want) if (nameWords.has(w)) score += 2
    return { t, score }
  })

  const chosen = scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxActions)
    .map((x) => x.t)

  return {
    tools: [...reads, ...chosen],
    droppedActions: actions.length - chosen.length,
  }
}
