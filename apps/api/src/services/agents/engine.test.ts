/**
 * runAgent — agent engine skeleton (Step 1).
 *
 * Pure unit test: global `fetch` is mocked, so no real model and no
 * network are needed. Asserts the engine builds the right request
 * (system prompt from the profile, history, then the user message;
 * sampler defaults with per-profile overrides) and correctly parses
 * / errors on the OpenAI-compatible response.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runAgent } from './engine'
import type { AgentProfile } from './types'

const PROFILE: AgentProfile = {
  id: 'test_profile',
  agentType: 'customer_service',
  audience: 'tenant',
  tier: 'entry',
  knowledgeScopes: ['tenant', 'shared'],
  name: 'TestBot',
  label: 'Test Profile',
  systemPrompt: 'You are a test agent.',
}

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true
  const status = init.status ?? 200
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('runAgent', () => {
  beforeEach(() => {
    process.env.LLM_ENDPOINT = 'http://localhost:8080/v1'
    process.env.LLM_MODEL = 'test-model'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts to the configured endpoint and returns the reply', async () => {
    const fetchMock = mockFetchOnce({
      choices: [{ message: { content: '  Hello there.  ' } }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    })

    const result = await runAgent({ profile: PROFILE, message: 'Hi' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8080/v1/chat/completions')

    const sent = JSON.parse((opts as RequestInit).body as string)
    expect(sent.model).toBe('test-model')
    // system prompt first, user message last
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You are a test agent.' })
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'Hi' })
    // Hermes sampler defaults applied
    expect(sent.temperature).toBe(0.6)
    expect(sent.top_p).toBe(0.95)
    expect(sent.top_k).toBe(20)
    expect(sent.stop).toEqual(['<|im_end|>'])

    // reply is trimmed; usage mapped to camelCase
    expect(result.reply).toBe('Hello there.')
    expect(result.model).toBe('test-model')
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 3 })
  })

  it('includes prior history between system and the new user message', async () => {
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: 'ok' } }] })

    await runAgent({
      profile: PROFILE,
      message: 'and now?',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
    })

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.messages.map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ])
    expect(sent.messages.at(-1).content).toBe('and now?')
  })

  it('injects a context block as a second system message before history', async () => {
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: 'ok' } }] })

    await runAgent({
      profile: PROFILE,
      message: 'Hi',
      contextBlock: 'GAM KNOWLEDGE — facts here',
      history: [{ role: 'user', content: 'earlier' }],
    })

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You are a test agent.' })
    expect(sent.messages[1]).toEqual({ role: 'system', content: 'GAM KNOWLEDGE — facts here' })
    expect(sent.messages[2]).toEqual({ role: 'user', content: 'earlier' })
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'Hi' })
  })

  it('omits the context system message when no block is given', async () => {
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: 'ok' } }] })
    await runAgent({ profile: PROFILE, message: 'Hi' })
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.messages.filter((m: { role: string }) => m.role === 'system')).toHaveLength(1)
  })

  it('lets a profile override sampler settings', async () => {
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: 'ok' } }] })

    await runAgent({
      profile: { ...PROFILE, sampler: { temperature: 0.2 } },
      message: 'Hi',
    })

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.temperature).toBe(0.2) // overridden
    expect(sent.top_p).toBe(0.95) // default preserved
  })

  it('throws when the endpoint returns a non-2xx', async () => {
    mockFetchOnce({ error: 'boom' }, { ok: false, status: 500 })
    await expect(runAgent({ profile: PROFILE, message: 'Hi' })).rejects.toThrow(/returned 500/)
  })

  it('throws a clear error when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(runAgent({ profile: PROFILE, message: 'Hi' })).rejects.toThrow(
      'LLM endpoint unreachable'
    )
  })

  it('throws when no LLM endpoint is configured', async () => {
    delete process.env.LLM_ENDPOINT
    delete process.env.LLM_ENDPOINTS
    await expect(runAgent({ profile: PROFILE, message: 'Hi' })).rejects.toThrow(/LLM_ENDPOINTS.*not set/)
  })
})
