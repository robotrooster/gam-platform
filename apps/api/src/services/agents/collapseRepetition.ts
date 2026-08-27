/**
 * S624 — catch a model that has started repeating itself.
 *
 * Asked to confirm a lead ("Sam Rivera, sam@example.com — that's correct, go
 * ahead"), Lucy produced this, roughly fifty times over, until she hit the
 * token ceiling:
 *
 *   "I'll send over the call details. I'll also send over a personalized call
 *    invitation with the time and link."
 *
 * Nothing caught it. There was no repetition guard anywhere in the runner, so
 * the whole wall of text went to the customer — on the PUBLIC marketing chat,
 * to a prospect who had just handed over their name and email.
 *
 * Hermes is known to do this; the sampler defaults carry a comment saying they
 * were chosen to avoid it. Sampling settings reduce the odds, they do not
 * remove them, and a generation failure should never be something the customer
 * sees. This is the floor under that.
 *
 * DELIBERATELY CONSERVATIVE. It only collapses ADJACENT duplicates, and only
 * when a sentence is repeated. Legitimate replies repeat short phrases ("yes,
 * that's right — yes.") and legitimate lists repeat structure; neither is
 * touched, because neither produces the same sentence twice in a row.
 */

/** Normalised for comparison only — the ORIGINAL text is what survives. */
function key(sentence: string): string {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export interface CollapseResult {
  reply: string
  /** How many repeated sentences were removed. 0 means nothing was wrong. */
  removed: number
  /** True when the reply was mostly repetition — worth logging as a failure. */
  degenerate: boolean
}

export function collapseRepetition(reply: string): CollapseResult {
  if (!reply || reply.length < 80) return { reply, removed: 0, degenerate: false }

  // Sentences WITH their trailing whitespace, so rejoining restores the shape.
  const parts = reply.match(/[^.!?\n]+[.!?]*\s*/g)
  // Three, not four: a reply that says the same sentence twice and then adds one
  // more is still a reply that said it twice. Below three there is nothing a
  // duplicate could even mean.
  if (!parts || parts.length < 3) return { reply, removed: 0, degenerate: false }

  // A SLIDING WINDOW, not an adjacency check. The real Lucy loop alternated —
  // "A. B. A. B. A. B." — so no two IDENTICAL sentences were ever neighbours and
  // a naive lastKey comparison caught nothing. What identifies a loop is a
  // sentence reappearing SOON, not immediately.
  //
  // Six is chosen to be shorter than any honest paragraph that might legitimately
  // circle back to a point, and longer than every repeating cycle observed.
  const WINDOW = 6
  const kept: string[] = []
  const recent: string[] = []
  let removed = 0

  for (const part of parts) {
    const k = key(part)
    // Short fragments ("yes.", "ok.") repeat innocently — leave them alone.
    if (k.length < 12) { kept.push(part); continue }

    if (recent.includes(k)) { removed++; continue }

    kept.push(part)
    recent.push(k)
    if (recent.length > WINDOW) recent.shift()
  }

  if (removed === 0) return { reply, removed: 0, degenerate: false }

  const out = kept.join('').replace(/[ \t]{2,}/g, ' ').trim()
  return {
    reply: out || reply,
    removed,
    // More removed than kept means the reply was mostly repetition — that is a
    // generation failure, not a stylistic tic, and the caller should log it.
    degenerate: removed > kept.length,
  }
}
