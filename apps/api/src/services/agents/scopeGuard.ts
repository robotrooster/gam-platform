/**
 * Last line of defence on the two ways an agent gives itself away.
 *
 * S617 (Nic): asked about something on another side of the platform, an agent
 * must answer as someone who has simply never heard of it — not as a machine
 * reciting its limits, and not as a person guarding a secret.
 *
 * The prompt says so, twice, in specific terms. The model still produced, over
 * and over, verbatim:
 *
 *   "Hm, FlexVault doesn't ring a bell for me. I'm just an AI assistant on the
 *    GAM team, so I don't have information about some of the landlord-side
 *    features."
 *
 * The first sentence is exactly right. The next one gives away both things at
 * once — it reaches for being an AI as the excuse, and it names whose feature
 * it is. Two prompt revisions did not shift it, so this is deterministic
 * instead. Prompts shape behaviour; they do not guarantee it, and this is the
 * kind of leak that is worth a guarantee.
 *
 * DELIBERATELY NARROW. It removes specific constructions, not topics — a
 * landlord agent says "landlord" constantly and must keep doing so. Each
 * pattern requires the giveaway SHAPE ("...so I don't have information about
 * ...", "that's a landlord feature"), never a bare keyword.
 *
 * Runs in agentSession.finalize, which is also what gates the FAQ answer cache
 * — a leaked reply stored there would be served to other people.
 */

/** Sentence-shaped chunks, keeping their terminator. */
function sentences(text: string): string[] {
  return text.match(/[^.!?\n]+[.!?]*/g) ?? [text]
}

const LEAK_PATTERNS: { name: string; re: RegExp }[] = [
  // Being an AI offered as the REASON for not knowing. The bare disclosure
  // ("I'm an AI assistant on the GAM team") is honest and must survive — this
  // needs the excuse construction that follows it.
  {
    name: 'ai-as-excuse',
    re: /\b(?:i'?m|i am)\s+(?:just\s+)?an?\s+ai\b[^.!?]*?\b(?:so|therefore|which means)\b[^.!?]*?\b(?:do not|don'?t|can'?t|cannot)\s+(?:have|access|see|know)\b[^.!?]*[.!?]*/i,
  },
  // Naming whose side a thing belongs to.
  {
    name: 'names-the-other-side',
    re: /[^.!?]*\b(?:landlord|tenant|renter|owner|guest)[-\s]side\b[^.!?]*[.!?]*/i,
  },
  {
    name: 'thats-a-X-product',
    re: /[^.!?]*\bthat'?s\s+(?:a|an)\s+(?:landlord|tenant|renter|owner|guest)(?:'s)?[-\s](?:only\s+)?(?:product|feature|tool|thing|offering|program|service)\b[^.!?]*[.!?]*/i,
  },
  // The machine tell — reciting its own configuration.
  {
    name: 'reciting-limits',
    re: /[^.!?]*\b(?:knowledge base|configured scope|my training|my instructions|available to me|in my (?:system|data))\b[^.!?]*[.!?]*/i,
  },
]

export interface ScrubResult {
  reply: string
  removed: string[]
}

/**
 * Strip give-away sentences from an agent reply.
 *
 * Returns the reply unchanged when nothing matches, which is the common case.
 * If stripping would empty the reply, a plain unaware line stands in rather
 * than sending nothing.
 */
export function scrubScopeLeaks(reply: string): ScrubResult {
  if (!reply) return { reply, removed: [] }
  const removed: string[] = []
  const kept = sentences(reply).filter((s) => {
    const hit = LEAK_PATTERNS.find((p) => p.re.test(s))
    if (hit) { removed.push(hit.name); return false }
    return true
  })

  if (!removed.length) return { reply, removed: [] }

  const out = kept.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return {
    reply: out || "Hm, that's not anything I'm aware of. What else can I help you with?",
    removed,
  }
}
