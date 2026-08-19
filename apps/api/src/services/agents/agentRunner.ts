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
const ACCOUNT_DATA_INTENT =
  /\b(my|our)\s+(?:\w+\s+)?(lease|deposit|balance|rent|payments?|payout|invoice|maintenance requests?|documents?|payment methods?|property manager|entry requests?|inspections?)\b|what do (i|we) owe|when('| i)?s my (next |last )?(payment|payout|rent)|\bon file\b|what documents|documents? do (i|we) have|requested entry|entry request/i

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
        ACCOUNT_DATA_INTENT.test(message)
      ) {
        nudgedForAccountData = true
        logger.warn({ profile: profile.id }, 'agent runner: tool-less answer to an account-data question — forcing one tool retry (safety net)')
        messages.push({ role: 'assistant', content: out.content })
        messages.push({
          role: 'system',
          content:
            'STOP — your last answer stated account-specific facts without fetching them. ' +
            'You have NOT looked up this customer\'s data; any date or amount you stated was invented. ' +
            'Call the matching tool NOW (their lease → get_my_lease, deposit → get_my_deposit, ' +
            'balance/payments → the payment tools, payouts → get_my_payouts, documents → get_my_documents, ' +
            'payment methods on file → get_my_payment_methods, entry requests → get_my_entry_requests, ' +
            'property manager / contacts → get_my_contacts) and answer from its result. ' +
            'If no tool covers it, say plainly that you cannot see that information.',
        })
        continue
      }
      return { reply: out.content, model, retrieved, grounded, toolInvocations, usage }
    }

    // Record the assistant's tool-call turn, then execute each call.
    messages.push({ role: 'assistant', content: out.content || null, tool_calls: out.toolCalls })
    for (const call of out.toolCalls) {
      const args = parseArgs(call.function.arguments)
      const result = await executeToolCall(call, profile, actor, args)

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
