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
 *   escalate_to_human — senior agent hands to a human GAM specialist.
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
    'acknowledge the issue in words — when it is beyond routine help: complex or multi-step, you ' +
    'cannot ground your answer in facts, the customer is frustrated or has asked repeatedly, or it ' +
    'is a hard stop (a refund or any money movement, account access/security, or a legal question). ' +
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
    'Hand this conversation to a human GAM support specialist. Use for the hard stops you cannot ' +
    'resolve: moving/refunding/adjusting money, account security or access/permission changes, a ' +
    'legal question or formal dispute, or anything you cannot ground or resolve. Provide the reason ' +
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
