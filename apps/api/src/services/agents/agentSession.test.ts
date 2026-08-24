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
// Daily budget allows by default; overridden to cap in one test.
const { checkTurnBudgetMock } = vi.hoisted(() => ({ checkTurnBudgetMock: vi.fn().mockResolvedValue({ allowed: true }) }))
vi.mock('./turnBudget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./turnBudget')>()),
  checkTurnBudget: checkTurnBudgetMock,
}))

import { runAgentWithTools } from './agentRunner'
import { logInteraction } from './logInteraction'
import { runAgentSession } from './agentSession'
import { RetryableEndpointError } from './endpointPool'
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
    expect(res.reply).toMatch(/senior agent/i)
    expect(res.humanHandoff).toMatchObject({ reason: 'money movement: refund' })
    expect(res.humanHandoff!.transcript.at(-1)).toEqual({ role: 'user', content: 'I want my money back' })
  })

  it('serves a curated FAQ answer instantly — no model, no gate (when enabled)', async () => {
    // Curated FAQ is flag-gated (default OFF since S498); enable it for this path.
    process.env.AGENT_CURATED_FAQ = '1'
    try {
      matchCuratedFaqMock.mockResolvedValueOnce('Your rent due date is in your lease.')
      const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'when is rent due?' })

      expect(res.curated).toBe(true)
      expect(res.reply).toBe('Your rent due date is in your lease.')
      expect(mockRun).not.toHaveBeenCalled() // never touched the model
      expect(getTurnGateMock).not.toHaveBeenCalled() // never took a gate slot
    } finally {
      delete process.env.AGENT_CURATED_FAQ
    }
  })

  // S618 (Nic): "we should just get rid of cross session memory." It also
  // measured worse — the same five questions scored 1/5 with it and 2/5
  // without, because telling the model "this person recently asked about their
  // balance" made it less likely to actually look the balance up.
  it('does NOT drag prior conversations into a fresh one', async () => {
    loadUserContextMock.mockResolvedValueOnce('RETURNING CUSTOMER — recent: asked about deposit')
    mockRun.mockResolvedValueOnce(answer('Hello.'))
    await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'hi again' })

    expect(loadUserContextMock).not.toHaveBeenCalled()
    const history = mockRun.mock.calls[0][0].history
    expect(history.some((m: any) => /RETURNING CUSTOMER/.test(String(m.content)))).toBe(false)
  })

  // The CURRENT conversation still carries — nobody repeats themselves inside
  // one chat. Only last week's questions are gone.
  it('still carries the current conversation', async () => {
    mockRun.mockResolvedValueOnce(answer('Sure.'))
    const history = [{ role: 'user' as const, content: 'my sink leaks' }]
    await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'any update?', history })
    expect(mockRun.mock.calls[0][0].history.some((m: any) => /sink leaks/.test(String(m.content)))).toBe(true)
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

  it('sheds gracefully under load without running the turn — and LOGS the shed', async () => {
    getTurnGateMock.mockReturnValueOnce({ acquire: vi.fn().mockResolvedValue(null) }) // gate sheds
    const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'hi' })

    expect(res.shed).toBe(true)
    expect(res.reply).toMatch(/high volume/i)
    expect(res.reply).not.toMatch(/(specialist|strategist)/i) // not the human-handoff copy
    expect(mockRun).not.toHaveBeenCalled() // never touched the model
    // S553: shed turns ARE logged (outcome 'shed' via deriveOutcome) — shed
    // volume drives the capacity alarm on the admin Agent Analytics page.
    expect(mockLog).toHaveBeenCalledTimes(1)
    const [, loggedResult] = mockLog.mock.calls[0]
    expect(loggedResult.shed).toBe(true)
  })

  it('refuses a budget-capped turn with the canned reply, no model call — and LOGS it', async () => {
    checkTurnBudgetMock.mockResolvedValueOnce({ allowed: false, reason: 'daily_unproductive' })
    const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'what is ten plus ten?' })

    expect(res.rateLimited).toBe(true)
    expect(res.reply).toMatch(/limit for our conversations today/i)
    expect(mockRun).not.toHaveBeenCalled() // zero model calls — the whole point
    expect(mockLog).toHaveBeenCalledTimes(1)
    const [, loggedResult] = mockLog.mock.calls[0]
    expect(loggedResult.rateLimited).toBe(true)
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

  // ── S618: the model going down must not reach the customer ─────────────
  //
  // It used to. The error rethrew, the route called next(e), and a tenant who
  // asked what they owed got HTTP 500 carrying "LLM endpoint unreachable at
  // http://localhost:8080/v1". 88 of those were logged in a single hour on
  // 2026-08-23, and the machine it runs on is the reason §0 of the S618
  // handoff exists.
  describe('when the model is unreachable', () => {
    it('answers in plain language instead of throwing the internal error', async () => {
      mockRun.mockRejectedValueOnce(
        new RetryableEndpointError('LLM endpoint unreachable at http://localhost:8080/v1')
      )

      const res = await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'how much do I owe?' })

      expect(res.reply).toBeTruthy()
      // Nothing internal reaches the person typing.
      expect(res.reply).not.toMatch(/localhost|endpoint|unreachable|LLM|8080|error/i)
      // And it must not claim a handoff that never happened.
      expect(res.reply).not.toMatch(/escalat|someone will|24 hours/i)
      expect(res.escalations).toEqual([])
    })

    it('still records it as an error so monitoring sees the truth', async () => {
      mockRun.mockRejectedValueOnce(
        new RetryableEndpointError('LLM endpoint unreachable at http://localhost:8080/v1')
      )

      await runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'how much do I owe?' })

      expect(mockLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ outcomeError: expect.stringContaining('unreachable') })
      )
    })

    it('still throws for any OTHER failure — a real bug stays loud', async () => {
      mockRun.mockRejectedValueOnce(new Error('column "foo" does not exist'))

      await expect(
        runAgentSession({ audience: 'tenant', actor: ACTOR, message: 'how much do I owe?' })
      ).rejects.toThrow(/column "foo"/)
    })
  })
})
