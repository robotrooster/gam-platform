/**
 * Escalation tools (Step 5).
 *
 * These don't read or write data — they signal a HANDOFF. When the model
 * calls one, the tool returns a `__handoff` marker; the tool loop
 * (runAgentWithTools) detects it, stops, and hands control to the
 * session orchestrator (agentSession), which switches to the next agent
 * (entry → senior, or senior → human) carrying the full context.
 *
 *   escalate          — entry agent (Ava/David) hands up to the senior
 *                       agent (Samantha/Sonny).
 *   escalate_to_human — senior agent hands to a human GAM Strategist.
 *
 * Each takes a `reason` and a `summary` of what the customer needs and
 * what's been tried, so the next handler never makes them repeat.
 */

import type { AgentTool } from './types'

export const HANDOFF_MARKER = '__handoff' as const

export interface HandoffSignal {
  kind: 'tier' | 'human'
  reason: string
  summary: string
}

const handoffParams = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'Why this needs to be handed up (one line).' },
    summary: {
      type: 'string',
      description: 'What the customer needs and what you have already tried/confirmed, so the next agent does not make them repeat themselves.',
    },
  },
  required: ['reason', 'summary'],
} as const

export const escalate: AgentTool = {
  name: 'escalate',
  description:
    'Hand this conversation up to a senior support agent. CALL THIS RIGHT AWAY — do not just ' +
    'acknowledge the issue in words — when it is beyond routine help: complex or multi-step, the ' +
    'customer is frustrated or has asked repeatedly, or it is a hard stop (a refund or any money ' +
    'movement, account access/security, or a legal question). ' +
    // S617: this used to say "you cannot ground your answer in facts", and the
    // model read that as covering anything it did not know offhand. Measured
    // across 106 real questions, it escalated "how do late fees work?", "what
    // is the platform fee?" and "what do I owe right now" — three ordinary
    // support questions, one of which it had already looked up.
    'NOT for a question you simply have not answered YET. If you do not know something, look it ' +
    'up with your tools or read your knowledge base first — a fee, a price, a policy, a date, a ' +
    'balance, anything a tool or an article covers is ROUTINE, however unfamiliar it feels. And if ' +
    'nothing can tell you, say plainly what you cannot see. Escalating a question you could have ' +
    'answered wastes the customer a day and a person an hour. ' +
    'Do NOT use it for a property/maintenance issue — those you handle by filing a maintenance request.',
  parameters: handoffParams,
  audiences: ['tenant', 'landlord'],
  async execute(args) {
    return {
      [HANDOFF_MARKER]: {
        kind: 'tier',
        reason: String(args.reason ?? ''),
        summary: String(args.summary ?? ''),
      } satisfies HandoffSignal,
    }
  },
}

export const escalateToHuman: AgentTool = {
  name: 'escalate_to_human',
  description:
    'Hand this conversation to a human GAM Strategist. Use for the hard stops you cannot ' +
    'resolve: moving/refunding/adjusting money, account security or access/permission changes, a ' +
    'legal question or formal dispute, or a situation genuinely stuck after you have tried. ' +
    'S617: NOT for an ordinary question you have not looked up yet — use your tools first. ' +
    'Provide the reason ' +
    'and a clear summary of the situation and what has been confirmed.',
  parameters: handoffParams,
  audiences: ['tenant', 'landlord'],
  async execute(args) {
    return {
      [HANDOFF_MARKER]: {
        kind: 'human',
        reason: String(args.reason ?? ''),
        summary: String(args.summary ?? ''),
      } satisfies HandoffSignal,
    }
  },
}
