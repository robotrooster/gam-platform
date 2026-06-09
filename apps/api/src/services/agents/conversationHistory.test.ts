/**
 * loadConversationHistory — ownership-scoped, oldest-first reconstruction.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../../db', () => ({ query: vi.fn() }))

import { query } from '../../db'
import { loadConversationHistory } from './conversationHistory'

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
