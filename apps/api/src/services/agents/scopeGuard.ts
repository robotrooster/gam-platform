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

/**
 * Markdown the chat window cannot render.
 *
 * S617: the bubbles use whiteSpace: pre-wrap with no markdown parser, so what
 * the model types is what the customer sees. The prompt says plain text; a live
 * run listing delinquent tenants came back with "**Frank Williams**: $4,840"
 * anyway. Asterisks around a name are not emphasis to the reader, they are
 * asterisks — so they are removed here rather than argued about.
 *
 * Bullets are normalised rather than deleted: a real list stays a list, it just
 * stops carrying a markdown marker.
 */
export function stripChatMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')      // **bold**
    .replace(/(?<!\w)__([^_\n]+)__(?!\w)/g, '$1') // __bold__
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1') // *italic*
    .replace(/`([^`\n]+)`/g, '$1')             // `code`
    .replace(/^#{1,6}\s+/gm, '')                // # heading
    .replace(/^\s*[-*]\s+/gm, '• ')             // - bullet -> plain bullet
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // [text](url)
}

/**
 * Collapse a reply that has started repeating itself.
 *
 * S617: a tenant asking "did my last payment go through" got the same three
 * sentences back over and over — "Want me to pull up your full payment history?
 * Want me to help you try again? You also have some pending charges..." — for a
 * dozen cycles. A quantized model that loops is not a rare event, and the reply
 * is unusable either way, so the duplicates are dropped rather than sent.
 *
 * Order is preserved and the FIRST occurrence of each line is kept, so a reply
 * that merely repeats a short phrase reads normally once collapsed. Only lines
 * with real content are considered — blank lines separate bubbles and must
 * survive.
 */
export function collapseRepetition(text: string): string {
  const lines = text.split('\n')
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const key = line.trim().toLowerCase().replace(/\s+/g, ' ')
    // Blank lines separate bubbles and must all survive.
    if (!key) { out.push(line); continue }
    // S617: this used to keep any line under 12 characters, on the theory that
    // short lines are list markers rather than repetition. Then a tenant asked
    // "do I owe anything?" and got back "What's due?" twelve times — eleven
    // characters, so every copy was kept. An exact repeat is a repeat at any
    // length; distinct short lines (bullet items) are all still unique and all
    // still kept.
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

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
  reply = collapseRepetition(stripChatMarkdown(reply))
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
