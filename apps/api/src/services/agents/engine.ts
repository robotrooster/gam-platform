/**
 * Agent engine — chat primitive + single-shot runAgent.
 *
 * `chatCompletion` is the one place that talks to the self-hosted
 * OpenAI-compatible endpoint (plain fetch, localhost only — no SDK, no
 * external network). It takes a fully-built message array and optional
 * tool schemas, and returns the assistant's content and/or tool calls.
 *
 * `runAgent` is the simple single-turn path: build messages from a
 * profile (+ optional retrieved-knowledge block) and return the reply.
 * Tool-using conversations go through runAgentWithTools (./agentRunner),
 * which drives chatCompletion in a loop.
 *
 * What this does NOT do (later steps): escalation/handoffs (step 5),
 * interaction logging (step 6).
 */

import { getLlmConfig, HERMES_SAMPLER_DEFAULTS, type SamplerSettings } from './config'
import { getPool, RetryableEndpointError, isRetryableStatus } from './endpointPool'
import { logger } from '../../lib/logger'
import type { ChatMessage, RunAgentInput, RunAgentResult, ToolCall } from './types'

/** Tool schema as sent to the endpoint (OpenAI function-tool shape). */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatCompletionOptions {
  tools?: ToolSchema[]
  sampler?: Partial<SamplerSettings>
  /** 'required' forces the model to call one of `tools` — see the note below. */
  /**
   * 'required' forces SOME tool. S618 adds the named form —
   * { type:'function', function:{ name } } — which forces ONE specific tool,
   * so the phrase table in toolRouting.ts can say WHICH lookup answers a
   * question instead of leaving the model to pick. Verified honoured by the
   * local mlx server in both forms.
   */
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
}

export interface ChatCompletionOutput {
  /** assistant text; '' when the turn is purely tool calls */
  content: string
  /** tool calls the model requested, if any */
  toolCalls: ToolCall[]
  finishReason: string | null
  model: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

interface RawChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ToolCall[] }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Low-level call to the chat endpoint. Sends a built message array. */
/**
 * A tool call the model TYPED instead of making.
 *
 * S617 (Nic): "I don't think there's any reason an agent should ever write a
 * tool call to you. Should we block that at the source?" He is right on both
 * counts — it is never a valid reply, and chasing wrappers is the wrong fix.
 *
 * The first version matched <call name="..."> and <tool_call>. Within one test
 * a third shape appeared:
 *     <10> {"name": "get_late_payment_history", "arguments": {}} </10>
 * There is always another wrapper. So this does not parse wrappers at all: it
 * looks for the NAME OF A TOOL THE MODEL WAS ACTUALLY OFFERED sitting next to
 * something argument-shaped. The allowlist is the offered tools themselves, so
 * it cannot conjure a call the model could not already have made properly, and
 * it does not care what envelope the model invented this time.
 *
 * Arguments are used only if they parse as JSON; anything else becomes {} and
 * the tool's own validation handles it. Guessing arguments would be worse than
 * having none.
 */
function recoverTypedToolCalls(content: string, offered: ToolSchema[]): ToolCall[] {
  if (!content || offered.length === 0) return []
  // A reply only qualifies if it looks like machinery rather than prose: a JSON
  // object with a "name", or an XML-ish tag. Ordinary sentences mentioning a
  // tool name in passing are left alone.
  const looksMechanical = /\{[^}]*"name"\s*:/.test(content) || /<[^>]+>/.test(content)
  if (!looksMechanical) return []

  const out: ToolCall[] = []
  for (const t of offered) {
    const name = t?.function?.name
    if (!name || !new RegExp(`\\b${name}\\b`).test(content)) continue
    // Arguments: the first JSON object after the name that parses.
    let args = '{}'
    const after = content.slice(content.indexOf(name) + name.length)
    const m = after.match(/\{[\s\S]{0,600}?\}/)
    if (m) {
      try {
        const parsed = JSON.parse(m[0])
        const inner = parsed && typeof parsed === 'object' && 'arguments' in parsed ? parsed.arguments : parsed
        if (inner && typeof inner === 'object') args = JSON.stringify(inner)
      } catch { /* not JSON — send none rather than a guess */ }
    }
    out.push({
      id: `recovered_${name}_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name, arguments: args },
    } as ToolCall)
    break   // one recovery per turn; the loop re-runs if more are needed
  }
  if (out.length) {
    logger.warn({ recovered: out[0].function.name },
      'agent engine: model typed a tool call instead of making one — recovered, not shown to the customer')
  }
  return out
}

export async function chatCompletion(
  messages: ChatMessage[],
  opts: ChatCompletionOptions = {}
): Promise<ChatCompletionOutput> {
  const { endpoints, model, timeoutMs, maxTokens } = getLlmConfig()
  const sampler: SamplerSettings = { ...HERMES_SAMPLER_DEFAULTS, ...opts.sampler }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: sampler.temperature,
    top_p: sampler.top_p,
    top_k: sampler.top_k,
    stop: sampler.stop,
    max_tokens: maxTokens,
    stream: false,
  }
  // S624 — A FIXED SEED FOR EVALUATION ONLY.
  //
  // The agent eval scored 42/45 and then 36/45 on a BYTE-IDENTICAL prompt file,
  // with only one failing case in common. At temperature 0.6 the run-to-run
  // spread is larger than any regression worth catching, so the number cannot
  // gate anything — and it cost real work: a prompt batch was reverted on the
  // strength of a 4-point "regression" that was almost certainly noise.
  //
  // Turning the temperature down is NOT the fix here: the Hermes sampler
  // defaults above are deliberately non-greedy because Hermes degenerates into
  // looping when sampled greedily. A seed keeps the sampling behaviour exactly
  // as it is in production and only makes it repeatable.
  //
  // Unset in production, where variety between two tenants asking the same
  // question is a feature, not a flaw.
  const seed = process.env.AGENT_SAMPLER_SEED
  if (seed !== undefined && seed !== '') body.seed = Number(seed)
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools
  // S617: force a lookup when the caller insists. The account-data safety net
  // asks the model to call a tool; on roughly one phrasing in five it declines
  // and answers from memory anyway, and the answer is invented. Asking again is
  // a request; tool_choice 'required' is not. Verified supported by the local
  // mlx server. Only set when explicitly requested, so ordinary turns keep the
  // option of a plain reply.
  if (opts.toolChoice) body.tool_choice = opts.toolChoice

  // Spread across the worker fleet; fail over on transient errors.
  const data = await getPool(endpoints).run(async (endpoint) => {
    let res: Response
    try {
      res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Network error / timeout — fail over to another worker.
      logger.error({ err, endpoint }, 'agent engine: LLM endpoint unreachable')
      throw new RetryableEndpointError(`LLM endpoint unreachable at ${endpoint}`, err)
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      logger.error({ status: res.status, body: errBody, endpoint }, 'agent engine: LLM endpoint returned an error')
      if (isRetryableStatus(res.status)) throw new RetryableEndpointError(`LLM endpoint ${endpoint} returned ${res.status}`)
      throw new Error(`LLM endpoint returned ${res.status}`)
    }
    return (await res.json()) as RawChatResponse
  })
  const choice = data.choices?.[0]
  const toolCalls = choice?.message?.tool_calls?.length
    ? choice.message.tool_calls
    // S617: recover a tool call the model TYPED instead of making. Asked "what
    // is the late fee", it replied "I'll look up your lease." and then wrote
    // <call name="get_my_lease"></call> into the message body. It had chosen
    // the right tool and failed only at the syntax — and the customer would
    // have seen the markup.
    //
    // Recovering it turns a wasted turn into the correct answer. Bounded by the
    // same allowlist every real call goes through (executeToolCall refuses a
    // tool the profile does not have), so this cannot reach anything the model
    // could not already call properly.
    : recoverTypedToolCalls(choice?.message?.content ?? '', opts.tools ?? [])
  // When the model calls tools it may ALSO emit hallucinated content —
  // discard it; the real answer comes after the tool result is fed back.
  const content = toolCalls.length > 0 ? '' : (choice?.message?.content ?? '').trim()

  return {
    content,
    toolCalls,
    finishReason: choice?.finish_reason ?? null,
    model,
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
      : undefined,
  }
}

/** Single-turn answer from a profile. No tools. */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { profile, message, history = [], contextBlock } = input

  const messages: ChatMessage[] = [
    { role: 'system', content: profile.systemPrompt },
    // Retrieved knowledge, if any, rides as a second system message so
    // the model treats it as authoritative ground truth, not user input.
    ...(contextBlock ? [{ role: 'system' as const, content: contextBlock }] : []),
    ...history,
    { role: 'user', content: message },
  ]

  const out = await chatCompletion(messages, { sampler: profile.sampler })
  if (!out.content) {
    logger.warn({ profile: profile.id, model: out.model }, 'agent engine: empty completion')
  }
  return { reply: out.content, model: out.model, usage: out.usage }
}
