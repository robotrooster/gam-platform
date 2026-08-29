/**
 * loadConversationHistory — ownership-scoped, oldest-first reconstruction.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../../db', () => ({ query: vi.fn() }))

import { query } from '../../db'
import { loadConversationHistory, loadConversationToolCalls } from './conversationHistory'
import { untraceableIdArgs } from './idTraceability'

const mockQuery = query as unknown as ReturnType<typeof vi.fn>

describe('loadConversationHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scopes the query to conversationId AND actorUserId (ownership)', async () => {
    mockQuery.mockResolvedValue([])
    await loadConversationHistory('c1', 'u1')
    const params = mockQuery.mock.calls[0][1]
    expect(params[0]).toBe('c1')
    expect(params[1]).toBe('u1') // ownership guard
  })

  it('reconstructs oldest-first user/assistant turns', async () => {
    // rows come back newest-first (ORDER BY turn_index DESC)
    mockQuery.mockResolvedValue([
      { user_message: 'second q', agent_reply: 'second a' },
      { user_message: 'first q', agent_reply: 'first a' },
    ])
    const history = await loadConversationHistory('c1', 'u1')
    expect(history).toEqual([
      { role: 'user', content: 'first q' },
      { role: 'assistant', content: 'first a' },
      { role: 'user', content: 'second q' },
      { role: 'assistant', content: 'second a' },
    ])
  })

  it('returns [] for an unknown/not-owned conversation', async () => {
    mockQuery.mockResolvedValue([])
    expect(await loadConversationHistory('nope', 'u1')).toEqual([])
  })
})

/**
 * S628 — the loader must carry tool RESULTS, not just the calls.
 *
 * idTraceability refuses an action whose id the agent never saw. The ordinary
 * flow is to look a unit up in one turn and act on it in the next, so if
 * prior-turn results are dropped, that id has nothing to trace to and the
 * guard refuses the exact flow it exists to protect. The column has always
 * held the result; only this mapping discarded it.
 */
describe('loadConversationToolCalls — results survive the round trip', () => {
  it('carries result through, so a cross-turn id stays usable', async () => {
    const unitId = 'a3f9c2e1-77b4-4d2a-9f10-5c8e6b1d0a44'
    mockQuery.mockResolvedValueOnce([
      { tool_invocations: [{ name: 'list_units', args: {}, result: { units: [{ id: unitId }] } }] },
    ])

    const prior = await loadConversationToolCalls('conv-1', 'user-1')
    expect(prior).toHaveLength(1)
    expect(prior[0].name).toBe('list_units')
    expect(JSON.stringify(prior[0].result)).toContain(unitId)

    // The point of carrying it: the guard now finds the id instead of
    // refusing the ordinary look-it-up-in-one-turn, act-in-the-next flow.
    expect(untraceableIdArgs({ unitId }, [JSON.stringify(prior[0].result)])).toEqual([])
  })

  it('still works when an old row has no result stored', async () => {
    mockQuery.mockResolvedValueOnce([{ tool_invocations: [{ name: 'list_units', args: {} }] }])
    const prior = await loadConversationToolCalls('conv-1', 'user-1')
    expect(prior).toHaveLength(1)
    expect(prior[0].result).toBeUndefined()
  })
})
