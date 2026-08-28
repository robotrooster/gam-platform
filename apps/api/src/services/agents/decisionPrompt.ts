/**
 * S628 — THE PROMPT FOR DECIDING, WHICH IS NOT THE PROMPT FOR WRITING.
 *
 * The model was being asked to do two jobs in one call — work out whether this
 * needs a lookup and which one, AND compose a warm, plain-text, correctly
 * formatted reply — with one set of instructions covering both. The
 * instructions for the second job drown the first.
 *
 * MEASURED on 2026-08-28, same question ("how much do I owe?"), same 67 tools,
 * only the system prompt varying:
 *
 *    2 KB  → calls the tool
 *    4 KB  → calls the tool
 *    8 KB  → calls the tool
 *   16 KB  → NO TOOL. Invents "$1,200 rent, $25 late fee, $1,225 total", and
 *            formats it as a markdown bullet list with bold — breaking the
 *            PLAIN TEXT ONLY rule written in that same prompt.
 *   26 KB  → NO TOOL. Invents a figure. This is production.
 *
 * So past a point every rule added makes the earlier rules weaker, and the first
 * casualty is the one that matters most: look it up before you say it. That is
 * the real reason the phrase table exists and rescues nearly every lookup, and
 * why the S618 note above tool_choice reads "honoured most of the time, not
 * every time" — it was measuring this without knowing it.
 *
 * De-collided example data was NOT the cause. With $1,145 in place of $1,200 the
 * model still answered "$1,200". That figure is its own invention.
 *
 * WHAT GOES IN HERE. Only what changes the DECISION: who is being spoken to,
 * that their own data must be looked up, and the hard stops — because
 * escalating is itself a tool call and getting it wrong is a real harm. Voice,
 * formatting, warmth, the waiver arithmetic, the repetition rules: none of that
 * alters which tool to call, and all of it is applied in the composing pass
 * where there are no tools to suppress.
 */
import type { AgentProfile } from './types'

/** What each audience's own data looks like, in the words they would use. */
const OWN_DATA: Record<string, string> = {
  tenant:
    'their balance, what they owe, their rent, their lease, their deposit, their payments, ' +
    'their maintenance requests, their documents, their inspections',
  landlord:
    'their properties, units, tenants, leases, rent roll, payouts, occupancy, expenses, ' +
    'books, maintenance, screening, utility meters and bills',
  guest: 'their booking, their stay, the amenities at the property they are staying at',
  visitor: 'the property, its rates and its availability',
  prospect: 'what GAM costs and what it does',
}

/**
 * The short prompt used while the model is choosing tools.
 *
 * Kept under a kilobyte deliberately. The measurement above is the whole reason
 * this file exists, so anything added here should be weighed against it — if
 * this grows past a few KB the tool calls start disappearing again and the
 * symptom is an invented number, not an error.
 */
export function buildDecisionPrompt(profile: AgentProfile): string {
  const own = OWN_DATA[profile.audience] ?? 'their own account'
  return [
    `You are ${profile.name}, a support agent for GAM, a property-rental platform. ` +
      `You are talking to a ${profile.audience.toUpperCase()}.`,
    '',
    `ANYTHING ABOUT THIS PERSON'S OWN ACCOUNT — ${own} — MUST come from a tool. ` +
      'Never state such a fact without calling one first. You do not know their numbers; ' +
      'the tools do.',
    '',
    'Call the tool that fits what they asked. Call more than one if more than one is needed. ' +
      'If they are asking you to DO something — change, add, cancel, record, send — call the ' +
      'tool that does it rather than describing where they would click.',
    '',
    'Escalate to a human, using your escalation tool, the moment they raise: moving, refunding ' +
      'or adjusting money; changing anyone’s permissions or access; or a legal dispute or ' +
      'threat of legal action. Explaining what something costs is ordinary support, not a ' +
      'hard stop.',
    '',
    'If nothing here fits, answer briefly and invent nothing.',
  ].join('\n')
}

/** Marks the composing pass so the model knows the lookups already happened. */
export function buildComposeInstruction(hadTools: boolean): string {
  return hadTools
    ? 'The lookups above have already run and their results are in this conversation. Write the ' +
      'reply to the person now, in your own voice, following every rule you were given. ' +
      'EVERY figure, name, date and unit you state must appear in those results — if something ' +
      'is not there, say you do not have it rather than filling the gap.'
    : 'Write the reply to the person now, in your own voice, following every rule you were ' +
      'given. No lookup ran this turn, so state no account-specific fact — no balance, no date, ' +
      'no amount. Answer what you can and say plainly what you would need to check.'
}
