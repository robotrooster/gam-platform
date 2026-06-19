/**
 * logInteraction (Step 6) — outcome derivation, property resolution, and
 * the best-effort INSERT. DB mocked; no model.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../../db', () => ({ query: vi.fn() }))

import { query } from '../../db'
import { logInteraction, deriveOutcome, resolveInteractionProperty } from './logInteraction'
import type { AgentSessionInput, AgentSessionResult } from './agentSession'
import type { AgentActor } from './tools/types'

const mockQuery = query as unknown as ReturnType<typeof vi.fn>
const TENANT: AgentActor = { userId: 'u1', role: 'tenant', profileId: 't1' }
const LANDLORD: AgentActor = { userId: 'u2', role: 'landlord', profileId: 'L1' }

const result = (over: Partial<AgentSessionResult> = {}): AgentSessionResult => ({
  reply: 'ok',
  handledBy: { name: 'Ava', tier: 'entry' },
  escalations: [],
  toolInvocations: [],
  ...over,
})

describe('deriveOutcome', () => {
  it('error wins over everything', () => {
    expect(deriveOutcome(result({ handledBy: { name: 'GAM Support', tier: 'human' } }), 'boom')).toBe('error')
  })
  it('human handoff', () => {
    expect(deriveOutcome(result({ humanHandoff: { reason: 'r', summary: 's', transcript: [] } }))).toBe('escalated_to_human')
  })
  it('senior answered', () => {
    expect(deriveOutcome(result({ handledBy: { name: 'Samantha', tier: 'escalation' } }))).toBe('answered_escalation')
  })
  it('action taken when a tool ran', () => {
    expect(deriveOutcome(result({ toolInvocations: [{ name: 'file_maintenance_request', args: {}, result: {} }] }))).toBe('action_taken')
  })
  it('plain entry answer', () => {
    expect(deriveOutcome(result())).toBe('answered_entry')
  })
})

describe('resolveInteractionProperty', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('landlord → portfolio-wide (no property, landlord = self)', async () => {
    expect(await resolveInteractionProperty(LANDLORD)).toEqual({ propertyId: null, landlordId: 'L1' })
    expect(query).not.toHaveBeenCalled() // no DB needed for landlords
  })

  it('tenant on one unit → that property + landlord', async () => {
    mockQuery.mockResolvedValueOnce([{ property_id: 'p1', landlord_id: 'L9' }])
    expect(await resolveInteractionProperty(TENANT)).toEqual({ propertyId: 'p1', landlordId: 'L9' })
    expect(mockQuery.mock.calls[0][1]).toEqual(['t1'])
  })

  it('tenant with no active lease → nulls', async () => {
    mockQuery.mockResolvedValueOnce([])
    expect(await resolveInteractionProperty(TENANT)).toEqual({ propertyId: null, landlordId: null })
  })

  it('tenant on multiple units of one landlord → no property, but landlord stamped', async () => {
    mockQuery.mockResolvedValueOnce([
      { property_id: 'p1', landlord_id: 'L9' },
      { property_id: 'p2', landlord_id: 'L9' },
    ])
    expect(await resolveInteractionProperty(TENANT)).toEqual({ propertyId: null, landlordId: 'L9' })
  })
})

describe('logInteraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('inserts one row and returns its id', async () => {
    mockQuery
      .mockResolvedValueOnce([{ property_id: 'p1', landlord_id: 'L9' }]) // property resolve
      .mockResolvedValueOnce([{ n: 0 }]) // turn_index = MAX(turn_index)+1
      .mockResolvedValueOnce([{ id: 'log-1' }]) // insert
    const input: AgentSessionInput = { audience: 'tenant', actor: TENANT, message: 'hi' }
    const id = await logInteraction(input, result({ toolInvocations: [{ name: 'get_my_lease', args: {}, result: {} }] }), {
      startedAt: Date.now() - 100,
      finalProfileId: 'tenant_entry',
      model: 'hermes',
      promptTokens: 42,
      completionTokens: 7,
      grounded: true,
      knowledgeChunkIds: ['c1'],
    })

    expect(id).toBe('log-1')
    const params = mockQuery.mock.calls[2][1] // [0] property, [1] turn_index, [2] insert
    // spot-check the shaped row
    expect(params).toContain('tenant_entry') // profile_id
    expect(params).toContain('action_taken') // derived outcome (tool ran)
    expect(params).toContain('hi') // user_message
    expect(params).toContain('p1') // resolved property
  })

  it('never throws — a DB failure returns null', async () => {
    mockQuery.mockRejectedValue(new Error('db down'))
    const input: AgentSessionInput = { audience: 'tenant', actor: TENANT, message: 'hi' }
    await expect(logInteraction(input, result(), { startedAt: Date.now(), finalProfileId: 'tenant_entry' })).resolves.toBeNull()
  })
})
