/**
 * S628 — AN ID THE AGENT MADE UP MUST NOT REACH A MUTATING ENDPOINT.
 *
 * Every invention net in this system reads the REPLY. None of them reads the
 * tool ARGUMENTS, and that is where the worst version of the failure lives:
 * the reply can be entirely honest while the call underneath it carries a
 * fabricated identifier.
 *
 * Measured on a landlord starting an eviction:
 *
 *   ▸ I'm starting an eviction on spot 7
 *     "I need the unit ID to enable eviction mode..."
 *   ▸ yes, turn it on
 *     → set_eviction_mode({ unitId: 'unit_12345' })   ← invented, twice
 *
 * It got a 500 and the landlord got a confusing error, which is the LUCKY
 * outcome. The same fabrication against an id that happens to exist turns
 * eviction mode on for somebody else's tenant — a real notice, a real clock,
 * the wrong home. Nothing in the stack would have questioned it: the
 * dispatcher checks that a path param is PRESENT, never that it is REAL.
 *
 * The rule: an identifier is only usable if the agent SAW it. Either a tool
 * returned it earlier in this conversation, or the person typed it. Anything
 * else is the model filling in a blank, and a blank in an id field is not
 * something to guess at.
 *
 * Reads are deliberately exempt — looking something up with a wrong id returns
 * nothing and costs nobody anything, and lookups are HOW ids get discovered in
 * the first place. This only guards the calls that change something.
 */

/** `id`, `unitId`, `unit_id`, `leaseId` — the argument names that carry a reference. */
const ID_ARG = /(^|[a-z])(id|ids)$/i

/**
 * Values that are not really references and must not be treated as such:
 * booleans, numbers a person would type ("7"), and the empty string. A landlord
 * saying "spot 7" is naming a unit, not quoting a key.
 */
function looksLikeAReference(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s.length < 6) return false
  return /[a-f0-9]{6,}|[-_]/i.test(s)
}

/**
 * Every id-shaped argument whose value the agent never saw.
 *
 * `haystacks` is everything the agent legitimately has: the JSON of prior tool
 * results, and the person's own messages. Substring matching is deliberate —
 * an id nested three levels inside a result object is still an id the agent
 * saw, and reconstructing the shape of every tool's payload here would be a
 * second source of truth that goes stale.
 */
export function untraceableIdArgs(
  args: Record<string, unknown>,
  haystacks: ReadonlyArray<string>,
): string[] {
  const hay = haystacks.filter(Boolean).join('\n')
  if (!hay) {
    // Nothing to check against — the FIRST action of a conversation with no
    // lookup behind it. An id cannot have been seen, so it cannot be used.
    return Object.entries(args)
      .filter(([k, v]) => ID_ARG.test(k) && looksLikeAReference(v))
      .map(([k]) => k)
  }
  const out: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (!ID_ARG.test(k) || !looksLikeAReference(v)) continue
    if (!hay.includes(v.trim())) out.push(k)
  }
  return out
}

/** What the model is told when it guesses. Names the fix, not just the fault. */
export function lookItUpFirst(argNames: ReadonlyArray<string>): string {
  const which = argNames.join(', ')
  return (
    `Refused: ${which} was not something any lookup returned and not something they typed — ` +
    'it was made up, and it points at a real record belonging to somebody. ' +
    'Do NOT retry with another guess. Look the record up first using what they actually said ' +
    '(the unit name, the property, the person), then call this again with the id that lookup ' +
    'returned. If the lookup cannot find it, ask them which one they mean.'
  )
}
