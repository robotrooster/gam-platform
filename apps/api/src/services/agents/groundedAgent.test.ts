/**
 * groundedAnswer (Step 3.5).
 *
 * Mocks the knowledge layer + engine so no model/DB is needed. Asserts
 * the orchestration: scope-correct retrieval, relevance-floor filtering,
 * the context block handed to the engine, and the grounded flag.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { groundedAnswer, buildContextBlock } from './groundedAgent'
import { requireProfile } from './profiles'
import * as knowledge from './knowledge'
import * as engine from './engine'
import type { RetrievedChunk } from './knowledge'

const chunk = (over: Partial<RetrievedChunk>): RetrievedChunk => ({
  id: 'x',
  scope: 'tenant',
  title: 'T',
  content: 'C',
  source: null,
  similarity: 0.9,
  ...over,
})

describe('buildContextBlock', () => {
  it('formats retrieved chunks as numbered facts', () => {
    const block = buildContextBlock([
      chunk({ title: 'Rent', content: 'Due on the 1st.' }),
      chunk({ title: 'Pay', content: 'Use ACH.' }),
    ])
    expect(block).toContain('ONLY the facts below')
    expect(block).toContain('[1] (Rent) Due on the 1st.')
    expect(block).toContain('[2] (Pay) Use ACH.')
  })

  it('tells the model NOT to invent when nothing was retrieved', () => {
    const block = buildContextBlock([])
    expect(block).toMatch(/no relevant knowledge/i)
    expect(block).toMatch(/Do NOT invent/i)
  })
})

describe('groundedAnswer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('retrieves within the profile scopes and grounds the engine call', async () => {
    const retrieveSpy = vi
      .spyOn(knowledge, 'retrieve')
      .mockResolvedValue([chunk({ title: 'Rent due', content: 'Due on the 1st.', similarity: 0.8 })])
    const runSpy = vi
      .spyOn(engine, 'runAgent')
      .mockResolvedValue({ reply: 'Your rent is due on the 1st.', model: 'm' })

    const profile = requireProfile('tenant_entry')
    const res = await groundedAnswer({ profile, message: 'when is rent due?' })

    // retrieved with the tenant profile's scopes
    expect(retrieveSpy).toHaveBeenCalledWith(['tenant', 'shared'], 'when is rent due?', 5)
    // engine got the context block built from the chunk
    const runArg = runSpy.mock.calls[0][0]
    expect(runArg.contextBlock).toContain('Due on the 1st.')
    expect(res.grounded).toBe(true)
    expect(res.retrieved).toHaveLength(1)
    expect(res.reply).toBe('Your rent is due on the 1st.')
  })

  it('drops chunks below the relevance floor', async () => {
    vi.spyOn(knowledge, 'retrieve').mockResolvedValue([
      chunk({ similarity: 0.7 }),
      chunk({ similarity: 0.1 }), // below default 0.3 floor
    ])
    const runSpy = vi
      .spyOn(engine, 'runAgent')
      .mockResolvedValue({ reply: 'ok', model: 'm' })

    const res = await groundedAnswer({ profile: requireProfile('tenant_entry'), message: 'q' })
    expect(res.retrieved).toHaveLength(1)
    expect(runSpy.mock.calls[0][0].contextBlock).not.toMatch(/no relevant knowledge/i)
  })

  it('marks grounded=false and tells the model not to invent when nothing clears the floor', async () => {
    vi.spyOn(knowledge, 'retrieve').mockResolvedValue([chunk({ similarity: 0.05 })])
    const runSpy = vi.spyOn(engine, 'runAgent').mockResolvedValue({ reply: 'ok', model: 'm' })

    const res = await groundedAnswer({ profile: requireProfile('landlord_entry'), message: 'q' })
    expect(res.grounded).toBe(false)
    expect(res.retrieved).toHaveLength(0)
    expect(runSpy.mock.calls[0][0].contextBlock).toMatch(/Do NOT invent/i)
  })
})
