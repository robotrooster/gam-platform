/**
 * runAgentWithTools — the tool-calling loop (Step 4).
 *
 * chatCompletion, retrieve, and the tool registry are mocked: this
 * asserts the orchestration (execute tool -> feed result back -> final
 * answer), the safety re-check, and the step ceiling. No model/DB.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./engine', () => ({ chatCompletion: vi.fn() }))
vi.mock('./knowledge', () => ({ retrieve: vi.fn().mockResolvedValue([]) }))

import { chatCompletion } from './engine'
import { runAgentWithTools } from './agentRunner'
import { requireProfile } from './profiles'
import * as tools from './tools'
import type { AgentActor } from './tools/types'

const ACTOR: AgentActor = { userId: 'u1', role: 'tenant', profileId: 't1' }

const toolCallTurn = (name: string, args: object) => ({
  content: '',
  toolCalls: [{ id: 'call-1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
  finishReason: 'tool_calls',
  model: 'm',
})
const textTurn = (content: string) => ({ content, toolCalls: [], finishReason: 'stop', model: 'm' })

describe('runAgentWithTools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('executes a tool call, feeds the result back, and returns the final answer', async () => {
    const execSpy = vi.fn().mockResolvedValue({ ok: true, requestId: 'req-1' })
    vi.spyOn(tools, 'getToolsForProfile').mockReturnValue([
      { name: 'file_maintenance_request', description: 'd', parameters: {}, audiences: ['tenant'], execute: execSpy },
    ])
    vi.spyOn(tools, 'getTool').mockReturnValue({
      name: 'file_maintenance_request', description: 'd', parameters: {}, audiences: ['tenant'], execute: execSpy,
    } as any)

    ;(chatCompletion as any)
      .mockResolvedValueOnce(toolCallTurn('file_maintenance_request', { title: 'Leak', description: 'sink leak' }))
      .mockResolvedValueOnce(textTurn('Done — I filed your request.'))

    const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor: ACTOR, message: 'sink is leaking' })

    expect(execSpy).toHaveBeenCalledWith({ title: 'Leak', description: 'sink leak' }, ACTOR)
    expect(res.toolInvocations).toHaveLength(1)
    expect(res.toolInvocations[0]).toMatchObject({ name: 'file_maintenance_request', result: { ok: true, requestId: 'req-1' } })
    expect(res.reply).toBe('Done — I filed your request.')

    // second call must include the assistant tool_call turn + the tool result
    const secondMessages = (chatCompletion as any).mock.calls[1][0]
    expect(secondMessages.some((m: any) => m.role === 'assistant' && m.tool_calls)).toBe(true)
    expect(secondMessages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call-1')).toBe(true)
  })

  it('does NOT record an escalation control-call in the tool ledger', async () => {
    // A tool whose result is a handoff marker is a CONTROL signal, not a
    // data/action tool — it must surface as handoff, not as a toolInvocation.
    const escResult = { __handoff: { kind: 'tier', reason: 'r', summary: 's' } }
    const escTool = { name: 'escalate', description: 'd', parameters: {}, audiences: ['tenant'], execute: vi.fn().mockResolvedValue(escResult) }
    vi.spyOn(tools, 'getToolsForProfile').mockReturnValue([escTool as any])
    vi.spyOn(tools, 'getTool').mockReturnValue(escTool as any)
    ;(chatCompletion as any).mockResolvedValueOnce(toolCallTurn('escalate', { reason: 'r', summary: 's' }))

    const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor: ACTOR, message: 'refund please' })

    expect(res.handoff).toEqual({ kind: 'tier', reason: 'r', summary: 's' })
    expect(res.toolInvocations).toHaveLength(0) // escalate is not a recorded action
  })

  it('returns immediately when the model answers a CAPABILITY question without a tool', async () => {
    // S617: the message here used to be "when is rent due?", which now demands a
    // tool — that is an account fact and answering it from memory is how the
    // agent came to tell a tenant they owed $1,200 when they owed $2,330. A
    // question the knowledge base owns still returns in one turn.
    vi.spyOn(tools, 'getToolsForProfile').mockReturnValue([])
    ;(chatCompletion as any).mockResolvedValueOnce(textTurn('Rent is paid in full, oldest charges first.'))

    // S617: 'how do late fees work' moved to the lookup side — late fees vary
    // by property, state and landlord, so there is no universal answer. A
    // how-to is still universal: the procedure is the same for everyone.
    const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor: ACTOR, message: 'how do I report a repair' })
    expect(res.reply).toBe('Rent is paid in full, oldest charges first.')
    expect(res.toolInvocations).toHaveLength(0)
    expect(chatCompletion).toHaveBeenCalledTimes(1)
  })

  it('does NOT return a tool-less answer to an account question — it retries once', async () => {
    vi.spyOn(tools, 'getToolsForProfile').mockReturnValue([])
    ;(chatCompletion as any)
      .mockResolvedValueOnce(textTurn('Your rent is due on the 1st.'))
      .mockResolvedValueOnce(textTurn('I cannot see your lease from here.'))

    const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor: ACTOR, message: 'when is rent due?' })
    expect(chatCompletion).toHaveBeenCalledTimes(2)
    // The nudge names the tools this profile actually holds — it used to name
    // tenant tools at every audience, so a landlord agent could not comply.
    const nudge = (chatCompletion as any).mock.calls[1][0].at(-1)
    expect(nudge.role).toBe('system')
    expect(nudge.content).toContain('get_my_lease')
    expect(res.reply).toBe('I cannot see your lease from here.')
  })

  it('suppresses an invented answer when the retry is declined', async () => {
    vi.spyOn(tools, 'getToolsForProfile').mockReturnValue([])
    ;(chatCompletion as any)
      .mockResolvedValueOnce(textTurn('You currently owe $1,200.'))
      .mockResolvedValueOnce(textTurn('You currently owe $1,200.'))

    const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor: ACTOR, message: 'how much do I owe right now?' })
    expect(res.toolInvocations).toHaveLength(0)
    // The invented figure must not reach the customer...
    expect(res.reply).not.toContain('$1,200')
    // ...and S617: what replaces it must ASK rather than dead-end. Nic: "if the
    // agent is unsure, it should ask a follow-up question to narrow down the
    // scope." The old text ("I'm not able to pull that up... let me get someone
    // on the team to look") stopped the conversation and half-promised a
    // handoff for something that is not an escalation.
    expect(res.reply).toContain('?')
    expect(res.reply).toMatch(/haven't actually checked/i)
    expect(res.reply).not.toMatch(/get someone on the team/i)
  })

  it('refuses to run a tool the profile is not allowed', async () => {
    // allowlist is empty, but the model hallucinates a tool call
    vi.spyOn(tools, 'getToolsForProfile').mockReturnValue([])
    ;(chatCompletion as any)
      .mockResolvedValueOnce(toolCallTurn('file_maintenance_request', { title: 'x', description: 'y' }))
      .mockResolvedValueOnce(textTurn('Sorry, I cannot do that.'))

    const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor: ACTOR, message: 'hi' })
    expect(res.toolInvocations[0].result).toMatchObject({ ok: false })
    const toolMsg = (chatCompletion as any).mock.calls[1][0].find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toMatch(/not available/i)
  })

  it('stops at the step ceiling instead of looping forever', async () => {
    const execSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.spyOn(tools, 'getToolsForProfile').mockReturnValue([
      { name: 'file_maintenance_request', description: 'd', parameters: {}, audiences: ['tenant'], execute: execSpy },
    ])
    vi.spyOn(tools, 'getTool').mockReturnValue({
      name: 'file_maintenance_request', description: 'd', parameters: {}, audiences: ['tenant'], execute: execSpy,
    } as any)
    // model keeps calling the tool forever; final no-tools call returns text
    ;(chatCompletion as any).mockResolvedValue(toolCallTurn('file_maintenance_request', { title: 'x', description: 'y' }))

    const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor: ACTOR, message: 'hi', maxSteps: 2 })
    // 2 loop steps + 1 final forced-text call = 3 chatCompletion calls
    expect((chatCompletion as any).mock.calls.length).toBe(3)
    expect(res.toolInvocations.length).toBe(2)
  })
})
