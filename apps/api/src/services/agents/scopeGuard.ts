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
    // S620: a LIST THAT LOST ITS LINE BREAKS. Measured on a landlord asking
    // "what's vacant right now": the model returned every vacant unit as one
    // run-on string — "right now:Copper Canyon Homes- House 02- House 03Oak
    // Street Apartments- Apt 202..." — thirteen correct units rendered as an
    // unreadable wall, because the bubble prints exactly what it is given.
    //
    // A dash that (a) follows a non-space, (b) is followed by whitespace, and
    // (c) precedes a capital or digit is a bullet that lost its newline. The
    // required space AFTER the dash is what keeps dates and hyphenated words
    // out of it: "2026-08-24" and "pull-through" have no space there, and
    // prose that uses " - " as punctuation has a space BEFORE the dash, which
    // the lookbehind rejects.
    .replace(/(?<=\S)-[ \t]+(?=[A-Z0-9])/g, '\n• ')
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

/**
 * Machinery must never reach a customer.
 *
 * S617 (Nic): "I don't think there's any reason an agent should ever write a
 * tool call to you. Should we block that at the source?" There is none, so this
 * is the floor: whatever the engine did or did not recover, a reply that still
 * carries the shape of a tool call does not go out with it.
 *
 * Format-agnostic on purpose — three different wrappers turned up in one
 * afternoon (<call name=...>, <tool_call>, and <10>{"name":...}</10>). This
 * removes the SHAPE: an XML-ish tag wrapping a JSON object with a "name", a
 * bare {"name":...,"arguments":...} blob, or a lone tag whose body is empty.
 * Ordinary prose is untouched, including a sentence that happens to mention a
 * tool by name.
 */
export function stripToolMachinery(text: string): string {
  if (!text) return text
  return text
    // <anything> {"name": ..., "arguments": ...} </anything>
    .replace(/<[^>\n]{1,40}>\s*\{[\s\S]{0,600}?"name"\s*:[\s\S]{0,600}?\}\s*<\/[^>\n]{1,40}>/gi, '')
    // a naked call object on its own
    .replace(/\{\s*"name"\s*:\s*"[a-z0-9_]+"\s*(?:,\s*"arguments"\s*:[\s\S]{0,400}?)?\}/gi, '')
    // <call .../> and <tool_call></tool_call> style tags, with or without a body
    .replace(/<\s*\/?\s*(call|invoke|tool_call|function_call)\b[^>]*>/gi, '')
    // leftover numeric tags the model invented as a wrapper
    .replace(/<\/?\s*\d{1,3}\s*>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Numeric citation markers — machinery wearing the shape of a footnote.
 *
 * S619 measured exactly one battery failure across 145 phrasings, and it was
 * this: asked "what am I paying for this", the model replied with
 *
 *   [1], [2], [3], [4], [5]
 *
 * and nothing else. Not a wrong answer — no answer, in a syntax the chat window
 * renders literally. The same intent had passed 4/4 the same morning, so it is
 * a degenerate GENERATION rather than a logic bug, and no amount of prompting
 * removes the tail of a quantized model's distribution.
 *
 * assertsStoredFacts already caught bracketed WORDS ([get_my_lease.endsAt]) and
 * missed bracketed NUMBERS, because its pattern requires a leading lowercase
 * letter. It also only runs when no tool ran — but a reply can be citation spam
 * whether or not a lookup succeeded, so this belongs on every reply instead.
 *
 * Markers are STRIPPED, not judged: the retrieval layer has no citation UI, so
 * "[2]" is never meaningful to a customer. When real prose surrounds them the
 * prose survives and only the markers go. When nothing is left, the caller
 * substitutes a plain line — see scrubScopeLeaks.
 *
 * Narrow on purpose: only bracket groups whose ENTIRE contents are digits and
 * separators. "[due on the 3rd]" and "[Apt 101]" are untouched.
 */
export function stripCitationMarkers(text: string): string {
  if (!text) return text
  return text
    // [1] · [12] · [1,2] · [1, 2, 3] · [1-3] — and runs of them
    .replace(/\[\s*\d+(?:\s*[,;&–—-]\s*\d+)*\s*\]/g, '')
    // [^1] footnote-reference form
    .replace(/\[\s*\^\s*\d+\s*\]/g, '')
    // the separators left stranded between removed markers: ", , ," / " · · "
    .replace(/(?:^|\n)[\s,;·•]+(?=\n|$)/g, '')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([,;])\s*(?=[,;])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Does a reply still say anything once the machinery is out?
 *
 *  ONE real word is the floor, deliberately. An earlier draft required three
 *  and swallowed "Checking." — a one-word reply is a poor answer but it is a
 *  reply, and a different guard (saysItWillCheck) is the one that owns it.
 *  This function answers only "is there anything here at all". */
function hasWords(text: string): boolean {
  return /[A-Za-z]{2,}/.test(text)
}

/** Was there machinery in this text to begin with? Gates the substitution
 *  below so it can only ever fire on a reply that CONTAINED machinery — never
 *  on a terse but legitimate one ("Yes.", "$340."). */
function containedMachinery(text: string): boolean {
  return /\[\s*\^?\s*\d/.test(text) || stripToolMachinery(text) !== text
}

export interface ScrubResult {
  reply: string
  removed: string[]
}

/**
 * Topics that belong to ANOTHER audience entirely — the booking-side leak.
 *
 * S620 (Nic): "the tenant agent keeps telling people stuff about the landlord
 * or the booking side that has nothing to do with being a tenant."
 *
 * Separating the knowledge bases fixed what the agent RETRIEVES. It cannot fix
 * what the model already knows. Measured on the first visitor battery, on a
 * public booking site, in one reply:
 *
 *   "I'm Skye, the booking assistant for [property name]. I can help you with
 *    questions about this property and booking a stay. To reset your password,
 *    you'll need to go to the login page and click on..."
 *
 * There is no password on a booking site. The visitor has no account, no lease
 * and no landlord — and none of the fact guards caught it, because it asserts
 * no figure, no date and no list. It is confident, fluent, and about somebody
 * else's product.
 *
 * ONLY the two no-account audiences. A tenant discussing their lease and a
 * landlord discussing their platform fee are doing their jobs; a guest or a
 * site visitor has no business with either. Each pattern needs the EXPLANATORY
 * shape, not a bare keyword, so "your stay ends on the 10th" survives.
 */
const OFF_AUDIENCE_PATTERNS: { name: string; re: RegExp }[] = [
  // Account mechanics for people who have no account.
  { name: 'password-mechanics', re: /[^.!?]*\b(reset|resetting|change|changing|forgot|recover)\b[^.!?]{0,40}\bpassword\b[^.!?]*[.!?]*/i },
  { name: 'two-factor', re: /[^.!?]*\b(two[- ]factor|2fa|authenticator app|recovery codes?)\b[^.!?]*[.!?]*/i },
  { name: 'sign-in-portal', re: /[^.!?]*\b(sign|log)\s?in\b[^.!?]{0,40}\b(portal|account|dashboard)\b[^.!?]*[.!?]*/i },
  // Tenancy mechanics. A guest has a booking, not a tenancy.
  { name: 'lease-mechanics', re: /[^.!?]*\byour lease\b[^.!?]*[.!?]*/i },
  { name: 'rent-mechanics', re: /[^.!?]*\b(your rent|rent is due|rent due date|late fee|grace period)\b[^.!?]*[.!?]*/i },
  { name: 'landlord-relationship', re: /[^.!?]*\byour landlord\b[^.!?]*[.!?]*/i },
  // GAM's rate card is what GAM charges a LANDLORD for software. Quoting it to
  // someone booking a campsite is answering a different company's question.
  { name: 'platform-fee', re: /[^.!?]*\b(platform fee|per occupied unit|\$2 per unit)\b[^.!?]*[.!?]*/i },
]

/** What a booking-side agent says instead. Warm, and honest that it is not
 *  ducking the question — it genuinely is not their department. */
const OFF_AUDIENCE_FALLBACK: Record<string, string> = {
  guest: "That one's not mine to answer, I'm afraid — I'm just here for your stay. Your host can point you the right way.",
  visitor: "That's not something I'd know — I only handle this property and booking a stay here. Anything about the place itself, though, ask away.",
}

/**
 * Remove sentences belonging to another audience's product. No-op for every
 * audience except 'guest' and 'visitor', and a no-op for them too unless the
 * reply actually strayed.
 */
export function scrubOffAudienceTopics(
  reply: string,
  audience?: string
): ScrubResult {
  if (!reply || (audience !== 'guest' && audience !== 'visitor')) return { reply, removed: [] }
  const removed: string[] = []
  const kept = sentences(reply).filter((sentence) => {
    const hit = OFF_AUDIENCE_PATTERNS.find((p) => p.re.test(sentence))
    if (hit) { removed.push(hit.name); return false }
    return true
  })
  if (!removed.length) return { reply, removed: [] }

  const out = kept.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  // If the stray topic WAS the reply, say the honest thing rather than sending
  // a stub. If real content survived, keep it — a guest who asked two things
  // still gets an answer to the one that was theirs.
  return { reply: hasWords(out) ? out : OFF_AUDIENCE_FALLBACK[audience], removed }
}

const MACHINERY_ONLY_FALLBACK =
  "Sorry — that came out garbled on my end. Ask me once more and I'll get it right."

/**
 * Strip give-away sentences from an agent reply.
 *
 * Returns the reply unchanged when nothing matches, which is the common case.
 * If stripping would empty the reply, a plain unaware line stands in rather
 * than sending nothing.
 */
export function scrubScopeLeaks(reply: string): ScrubResult {
  if (!reply) return { reply, removed: [] }
  const before = reply
  reply = collapseRepetition(stripChatMarkdown(stripToolMachinery(stripCitationMarkers(reply))))

  // S619: the cleaners above take out machinery, not answers — so a reply that
  // CONTAINED machinery and has no words left once it is gone WAS the
  // machinery. That covers the citation-spam case ("[1], [2], [3]" and nothing
  // else) and any future wrapper arriving as a whole message rather than
  // embedded in one. Sending the empty string strands the customer with a blank
  // bubble; sending the markers is worse. Ask them to say it again.
  if (containedMachinery(before) && !hasWords(reply)) {
    return { reply: MACHINERY_ONLY_FALLBACK, removed: ['machinery-only-reply'] }
  }

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
