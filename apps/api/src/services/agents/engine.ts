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
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools

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
  const toolCalls = choice?.message?.tool_calls ?? []
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
