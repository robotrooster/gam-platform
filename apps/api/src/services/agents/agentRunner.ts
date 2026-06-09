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
