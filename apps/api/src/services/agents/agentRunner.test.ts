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

  it('returns immediately when the model answers without a tool', async () => {
    vi.spyOn(tools, 'getToolsForProfile').mockReturnValue([])
    ;(chatCompletion as any).mockResolvedValueOnce(textTurn('Your rent is due on the 1st.'))

    const res = await runAgentWithTools({ profile: requireProfile('tenant_entry'), actor: ACTOR, message: 'when is rent due?' })
    expect(res.reply).toBe('Your rent is due on the 1st.')
    expect(res.toolInvocations).toHaveLength(0)
    expect(chatCompletion).toHaveBeenCalledTimes(1)
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
