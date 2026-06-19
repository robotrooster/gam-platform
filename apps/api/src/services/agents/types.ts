/**
 * Agent engine — core types.
 *
 * An AgentProfile parameterizes the ONE engine. There are not four
 * hardcoded agents; there is one engine that runs a profile. Step 1
 * carries only what the engine needs to produce a reply: identity,
 * system prompt, and optional sampler overrides. Later steps extend
 * THIS SAME shape with the fields the handoff specifies — knowledge
 * scope (RAG retrieval slice), tool allowlist (scoped GAM API calls),
 * and escalation rules (when it hands up a tier). Keeping them on one
 * type is what makes "add a booking agent later" a config addition,
 * not a refactor.
 */

import type { SamplerSettings } from './config'

/**
 * Profile axes — the three independent dimensions that classify every
 * agent. Kept as single-source value arrays (CLAUDE.md enum rule) with
 * derived types, so the engine, the registry, and later the
 * per-property toggle + logging all reference one definition.
 *
 * These axes are the future-proofing the handoff requires: adding a
 * landlord "booking" agent later is appending 'booking' to AGENT_TYPES
 * (and 'guest' to AGENT_AUDIENCES if it serves prospects) plus one
 * profile object in profiles.ts — NO engine rebuild.
 *
 * When a second consumer appears (the per-property toggle schema, or
 * the landlord performance dashboard frontend), promote these arrays
 * to packages/shared so the DB CHECK and the UI import the same source.
 */

/** What kind of work the agent does. */
export const AGENT_TYPES = ['customer_service', 'sales', 'booking'] as const
// 'booking' = the no-account booking-guest agent (RV/STR/storage); like
// 'sales' it carries its own prompt, NOT the CS guardrails.
export type AgentType = (typeof AGENT_TYPES)[number]

/** Who the agent talks to. 'prospect' is an unauthenticated marketing-site
 *  visitor (no GAM account) the sales agent talks to. */
export const AGENT_AUDIENCES = ['tenant', 'landlord', 'prospect', 'guest'] as const
// 'guest' = a no-account booking guest (RV/STR/extended-stay) talking to the
// booking agent, identified by a per-booking access token rather than a JWT.
export type AgentAudience = (typeof AGENT_AUDIENCES)[number]

/** Where the agent sits in the escalation ladder. 'human' is the
 *  terminal target above 'escalation' but is NOT an agent profile. */
export const AGENT_TIERS = ['entry', 'escalation'] as const
export type AgentTier = (typeof AGENT_TIERS)[number]

/** Knowledge slices a profile's retrieval may pull from. Single source
 *  for the `scope` CHECK in the agent_knowledge_store migration — keep
 *  the two in sync. 'shared' is content both audiences see. */
export const KNOWLEDGE_SCOPES = ['tenant', 'landlord', 'shared', 'sales'] as const
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number]

/**
 * How an interaction ended — the headline reporting dimension for the
 * agent_interaction_logs table (Step 6). Single source for that table's
 * `outcome` CHECK; keep the two in sync. 'escalated_to_senior' and
 * 'abandoned' are reserved/forward-compatible — the synchronous engine
 * does not emit them in v1 (a senior always produces a reply or escalates
 * to a human; there is no timeout/no-reply path yet).
 */
export const AGENT_OUTCOMES = [
  'answered_entry',
  'answered_escalation',
  'action_taken',
  'escalated_to_senior',
  'escalated_to_human',
  'abandoned',
  'error',
] as const
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number]

export interface AgentProfile {
  /** stable machine id, e.g. 'tenant_entry'. Also the logging key. */
  id: string
  /** generic agent type — NOT hardcoded to the four CS roles */
  agentType: AgentType
  /** who this agent serves */
  audience: AgentAudience
  /** entry vs escalation tier */
  tier: AgentTier
  /** the agent's persona name the customer sees, e.g. 'Ava' */
  name: string
  /** human-readable label for logs/UI, e.g. 'Tenant — Entry' */
  label: string
  /** persona + rules; becomes the system message of every request */
  systemPrompt: string
  /** which knowledge slices this profile's retrieval pulls from (step 3) */
  knowledgeScopes: KnowledgeScope[]
  /** names of tools this profile may call (allowlist; see tools/index.ts).
   *  Empty/absent = no tools. */
  toolNames?: string[]
  /** optional per-profile overrides layered onto HERMES_SAMPLER_DEFAULTS */
  sampler?: Partial<SamplerSettings>

  // Reserved for later build steps — intentionally not implemented yet,
  // listed here so the shape is visible:
  //   escalation      — machine-readable hand-up conditions (step 5)
  // Per-property enablement (handoff future-proofing #2) is NOT a field
  // here: a profile is a reusable template; which profiles are switched
  // on for a given property is per-instance state that belongs in a
  // future `property_agents` mapping table, not on the template.
}

/** A tool call the model emitted (OpenAI shape). */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One turn in a conversation, OpenAI chat-message shape. Supports the
 *  tool-calling roles: an assistant turn may carry tool_calls, and a
 *  tool turn carries the result of one, keyed by tool_call_id. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface RunAgentInput {
  profile: AgentProfile
  /** the user's latest message */
  message: string
  /** prior turns, oldest first; omit on a fresh conversation. Do NOT
   *  include a system message here — the engine prepends the profile's. */
  history?: ChatMessage[]
  /** retrieved-knowledge / grounding block. When present it is inserted
   *  as an extra system message after the profile prompt, so the model
   *  answers from these facts rather than inventing. Built by
   *  groundedAnswer(); callers usually go through that, not here. */
  contextBlock?: string
}

export interface RunAgentResult {
  /** the assistant's reply text, trimmed */
  reply: string
  /** the model id that produced it (echoed from config for logging) */
  model: string
  /** token usage when the endpoint reports it */
  usage?: {
    promptTokens?: number
    completionTokens?: number
  }
}
