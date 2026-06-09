/**
 * runAgentSession — entry → senior → human chain (Step 5).
 *
 * runAgentWithTools is mocked so we drive handoff signals directly and
 * assert the orchestration: who handles, the escalation trail, context
 * carried to the senior agent, and the human-handoff package.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./agentRunner', () => ({ runAgentWithTools: vi.fn() }))
// Logging is exercised in logInteraction.test.ts; mock it here so the
// orchestration tests don't touch the DB.
vi.mock('./logInteraction', () => ({ logInteraction: vi.fn().mockResolvedValue('log-id') }))
// Gate admits by default (returns a no-op release); overridden to shed in one test.
const { getTurnGateMock } = vi.hoisted(() => ({ getTurnGateMock: vi.fn(() => ({ acquire: vi.fn().mockResolvedValue(() => {}) })) }))
vi.mock('./turnGate', () => ({ getTurnGate: getTurnGateMock }))
// Curated FAQ misses by default (no canned match → model path); overridden in one test.
const { matchCuratedFaqMock } = vi.hoisted(() => ({ matchCuratedFaqMock: vi.fn().mockResolvedValue(null) }))
vi.mock('./curatedFaq', () => ({ matchCuratedFaq: matchCuratedFaqMock }))
// Cross-session memory off by default; overridden in one test.
const { loadUserContextMock } = vi.hoisted(() => ({ loadUserContextMock: vi.fn().mockResolvedValue(null) }))
vi.mock('./conversationHistory', () => ({ loadUserContext: loadUserContextMock }))

import { runAgentWithTools } from './agentRunner'
import { logInteraction } from './logInteraction'
import { runAgentSession } from './agentSession'
import type { AgentActor } from './tools/types'

const ACTOR: AgentActor = { userId: 'u1', role: 'tenant', profileId: 't1' }
const mockRun = runAgentWithTools as unknown as ReturnType<typeof vi.fn>
const mockLog = logInteraction as unknown as ReturnType<typeof vi.fn>

const usage = { promptTokens: 10, completionTokens: 5 }
const answer = (reply: string) => ({ reply, model: 'm', retrieved: [], grounded: false, toolInvocations: [], usage })
const tierHandoff = (reason: string, summary: string) => ({
  reply: '', model: 'm', retrieved: [], grounded: false, toolInvocations: [], usage,
  handoff: { kind: 'tier' as const, reason, summary },
})
const humanHandoff = (reason: string, summary: string) => ({
  reply: '', model: 'm', retrieved: [], grounded: false, toolInvocations: [], usage,
  handoff: { kind: 'human' as const, reason, summary },
})

describe('runAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('entry agent (Ava) answers — no escalation', async () => {
    mockRun.mockResolvedValueOnce(answer('Your rent is due on the 3rd.'))
    const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'when is rent due?' })

    expect(res.handledBy).toEqual({ name: 'Ava', tier: 'entry' })
    expect(res.escalations).toHaveLength(0)
    expect(res.reply).toBe('Your rent is due on the 3rd.')
    expect(mockRun).toHaveBeenCalledTimes(1)
  })

  it('Ava escalates to Samantha, who answers — context carried', async () => {
    mockRun
      .mockResolvedValueOnce(tierHandoff('complex billing dispute', 'tenant says double-charged; confirmed two pending rows'))
      .mockResolvedValueOnce(answer('Thanks for your patience — I see the duplicate and I’m on it.'))

    const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'I was double charged' })

    expect(res.handledBy).toEqual({ name: 'Samantha', tier: 'escalation' })
    expect(res.escalations).toEqual([{ from: 'Ava', to: 'Samantha', reason: 'complex billing dispute' }])
    expect(res.reply).toMatch(/duplicate/i)

    // the senior call received a handoff note carrying Ava's summary
    const seniorHistory = mockRun.mock.calls[1][0].history
    const note = seniorHistory.find((m: any) => m.role === 'system' && /HANDOFF/.test(m.content))
    expect(note.content).toContain('Samantha')
    expect(note.content).toContain('two pending rows')
  })

  it('Samantha escalates to a human — returns a handoff package', async () => {
    mockRun
      .mockResolvedValueOnce(tierHandoff('needs a refund', 'duplicate confirmed'))
      .mockResolvedValueOnce(humanHandoff('money movement: refund', 'duplicate rent charge, tenant owed a refund'))

    const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'I want my money back' })

    expect(res.handledBy).toEqual({ name: 'GAM Support', tier: 'human' })
    expect(res.escalations.map((e) => e.to)).toEqual(['Samantha', 'GAM Support'])
    expect(res.reply).toMatch(/specialist/i)
    expect(res.humanHandoff).toMatchObject({ reason: 'money movement: refund' })
    expect(res.humanHandoff!.transcript.at(-1)).toEqual({ role: 'user', content: 'I want my money back' })
  })

  it('serves a curated FAQ answer instantly — no model, no gate', async () => {
    matchCuratedFaqMock.mockResolvedValueOnce('Your rent due date is in your lease.')
    const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'when is rent due?' })

    expect(res.curated).toBe(true)
    expect(res.reply).toBe('Your rent due date is in your lease.')
    expect(mockRun).not.toHaveBeenCalled() // never touched the model
    expect(getTurnGateMock).not.toHaveBeenCalled() // never took a gate slot
  })

  it('injects cross-session memory into the model context on a fresh conversation', async () => {
    loadUserContextMock.mockResolvedValueOnce('RETURNING CUSTOMER — recent: asked about deposit')
    mockRun.mockResolvedValueOnce(answer('Welcome back!'))
    await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'hi again' })

    expect(loadUserContextMock).toHaveBeenCalledWith('u1', undefined)
    const history = mockRun.mock.calls[0][0].history
    expect(history.some((m: any) => m.role === 'system' && /RETURNING CUSTOMER/.test(m.content))).toBe(true)
  })

  it('does NOT use a curated answer mid-conversation (history present)', async () => {
    matchCuratedFaqMock.mockResolvedValue('canned')
    mockRun.mockResolvedValueOnce(answer('real contextual reply'))
    const res = await runAgentSession({
      audience: 'tenant', actor: ACTOR, message: 'and what about that?',
      history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    })
    expect(res.curated).toBeUndefined()
    expect(res.reply).toBe('real contextual reply')
    matchCuratedFaqMock.mockResolvedValue(null) // restore default
  })

  it('sheds gracefully under load without running the turn or logging', async () => {
    getTurnGateMock.mockReturnValueOnce({ acquire: vi.fn().mockResolvedValue(null) }) // gate sheds
    const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'hi' })

    expect(res.shed).toBe(true)
    expect(res.reply).toMatch(/high volume/i)
    expect(res.reply).not.toMatch(/specialist/i) // not the human-handoff copy
    expect(mockRun).not.toHaveBeenCalled() // never touched the model
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('logs the interaction once, with the final handler profile id', async () => {
    mockRun.mockResolvedValueOnce(answer('All set.'))
    await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'hi' })

    expect(mockLog).toHaveBeenCalledTimes(1)
    const [loggedInput, loggedResult, ctx] = mockLog.mock.calls[0]
    expect(loggedInput.message).toBe('hi')
    expect(loggedResult.reply).toBe('All set.')
    expect(ctx.finalProfileId).toBe('tenant_entry')
    expect(ctx.promptTokens).toBe(10) // accumulated from usage
  })

  it('logs an escalated interaction with the senior profile id', async () => {
    mockRun
      .mockResolvedValueOnce(tierHandoff('complex', 'summary'))
      .mockResolvedValueOnce(answer('Handled.'))
    await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'hard one' })

    const ctx = mockLog.mock.calls[0][2]
    expect(ctx.finalProfileId).toBe('tenant_escalation') // Samantha handled it
    expect(ctx.promptTokens).toBe(20) // summed across both hops
  })

  it('senior re-escalation routes to a human without a self-referential step', async () => {
    mockRun
      .mockResolvedValueOnce(tierHandoff('complex', 's1')) // Ava -> Samantha
      .mockResolvedValueOnce(tierHandoff('still stuck', 's2')) // Samantha re-escalates
    const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'hard' })

    expect(res.handledBy).toEqual({ name: 'GAM Support', tier: 'human' })
    expect(res.escalations).toEqual([
      { from: 'Ava', to: 'Samantha', reason: 'complex' },
      { from: 'Samantha', to: 'GAM Support', reason: 'still stuck' },
    ])
    // no 'Samantha -> Samantha' self-loop
    expect(res.escalations.some((e) => e.from === e.to)).toBe(false)
  })

  it('rejects an audience that does not match the actor role', async () => {
    await expect(
      runAgentSession({ audience: 'landlord', actor: ACTOR, message: 'hi' }) // ACTOR.role = 'tenant'
    ).rejects.toThrow(/does not match actor.role/)
  })

  it('routes landlords through David then Sonny', async () => {
    mockRun
      .mockResolvedValueOnce(tierHandoff('complex payout question', 'needs detail David lacks'))
      .mockResolvedValueOnce(answer('Here are your payout details.'))

    const res = await runAgentSession({ audience: 'landlord', actor: { ...ACTOR, role: 'landlord' }, message: 'payout?' })
    expect(res.escalations).toEqual([{ from: 'David', to: 'Sonny', reason: 'complex payout question' }])
    expect(res.handledBy).toEqual({ name: 'Sonny', tier: 'escalation' })
  })
})
