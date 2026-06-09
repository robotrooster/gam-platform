/**
 * Agent session orchestrator (Step 5) — the entry → senior → human chain.
 *
 * A customer always starts with the entry agent for their audience
 * (Ava for tenants, David for landlords). If that agent escalates, the
 * session switches to the senior agent (Samantha / Sonny), carrying the
 * full transcript plus a structured summary of what's been tried so the
 * customer never repeats themselves. If the senior agent escalates to a
 * human, the session returns a structured handoff package for a GAM
 * specialist and tells the customer a human is taking over.
 *
 * Escalation is driven by the model via the escalate / escalate_to_human
 * tools (see tools/escalation.ts); this orchestrator reacts to the
 * handoff signal runAgentWithTools surfaces.
 */

import { runAgentWithTools, type ToolInvocation, type RunWithToolsResult } from './agentRunner'
import { getEntryProfile, getEscalationProfile } from './profiles'
import { logInteraction } from './logInteraction'
import { getTurnGate } from './turnGate'
import { answerCache, answerCacheEnabled, normalizeQuestion } from './cache'
import { matchCuratedFaq } from './curatedFaq'
import { loadUserContext } from './conversationHistory'
import type { AgentActor } from './tools/types'
import type { HandoffSignal } from './tools/escalation'
import { logger } from '../../lib/logger'
import type { AgentAudience, AgentProfile, AgentTier, ChatMessage } from './types'

export interface AgentSessionInput {
  audience: AgentAudience
  actor: AgentActor
  message: string
  /** PRIOR turns of this conversation, oldest first — must NOT include
   *  the current `message` (the engine appends it). Its length is logged
   *  as turn_index, so passing the full transcript would skew analytics. */
  history?: ChatMessage[]
  /** correlation id to group turns of one chat thread (for logging).
   *  Generated per-turn if a caller doesn't supply it. */
  conversationId?: string
}

export interface EscalationStep {
  from: string
  to: string
  reason: string
}

export interface HumanHandoffPackage {
  reason: string
  summary: string
  /** the conversation so far, for the human specialist */
  transcript: ChatMessage[]
}

export interface AgentSessionResult {
  reply: string
  /** who produced the final reply: an agent, or the human queue */
  handledBy: { name: string; tier: AgentTier | 'human' }
  /** the chain of handoffs that happened, in order */
  escalations: EscalationStep[]
  /** every tool executed across all tiers this turn */
  toolInvocations: ToolInvocation[]
  /** present only when handed to a human */
  humanHandoff?: HumanHandoffPackage
  /** true when the turn was SHED under load (not actually processed) */
  shed?: boolean
  /** true when the reply was served from the FAQ answer cache (no model call) */
  cached?: boolean
  /** true when the reply was an approved curated FAQ answer (no model call) */
  curated?: boolean
}

/** System note injected for the senior agent so they pick up seamlessly. */
function buildHandoffNote(from: AgentProfile, to: AgentProfile, h: HandoffSignal): string {
  return (
    `HANDOFF: You (${to.name}) are taking over from ${from.name}, who could not fully resolve this. ` +
    `Reason: ${h.reason}. ` +
    `What ${from.name} gathered and tried: ${h.summary} ` +
    `The conversation so far is above — acknowledge briefly that you've caught up and continue; ` +
    `do not make the customer start over.`
  )
}

const HUMAN_HANDOFF_REPLY =
  `I'm bringing in a GAM support specialist to take this from here. ` +
  `I've passed along everything we discussed, so you won't need to repeat yourself — ` +
  `someone will follow up with you.`

// Distinct from the human-handoff copy on purpose: a capacity shed must NOT
// imply a specialist will follow up (no false promise).
const HIGH_VOLUME_REPLY =
  `Thanks for reaching out! We're seeing unusually high volume right now and ` +
  `couldn't get to your message this moment. Please try again in a few minutes — ` +
  `we'll be right with you.`

export async function runAgentSession(input: AgentSessionInput): Promise<AgentSessionResult> {
  const { audience, actor, message } = input
  const baseHistory = input.history ?? []
  const startedAt = Date.now()

  // Defense in depth: the tool allowlist + audience gate key off
  // `audience`, while every tool's data scope binds to `actor`. They must
  // agree, or a misconfigured caller could surface one audience's tools
  // against the other's identity. Fail fast on a mismatch.
  if ((actor.role === 'tenant' || actor.role === 'landlord') && actor.role !== audience) {
    throw new Error(`agent session: audience '${audience}' does not match actor.role '${actor.role}'`)
  }

  let profile = getEntryProfile(audience)
  if (!profile) throw new Error(`No entry profile for audience: ${audience}`)
  const agentType = profile.agentType // consistent across this audience's tiers

  const escalations: EscalationStep[] = []
  const toolInvocations: ToolInvocation[] = []
  let handoffNote: string | undefined

  // Engine/RAG metrics accumulated across every tier hop, for logging.
  const metrics = { model: undefined as string | undefined, promptTokens: 0, completionTokens: 0, grounded: false, knowledgeChunkIds: [] as string[] }
  const accumulate = (res: RunWithToolsResult) => {
    if (res.model) metrics.model = res.model
    metrics.promptTokens += res.usage.promptTokens
    metrics.completionTokens += res.usage.completionTokens
    metrics.grounded = metrics.grounded || res.grounded
    metrics.knowledgeChunkIds.push(...res.retrieved.map((c) => c.id))
  }

  // FAQ answer cache: only for a first-turn (no history) question we can
  // cache. The cache KEY is built up front; the store happens after a turn
  // that qualifies as cacheable (no tools/escalation, grounded answer).
  const answerKey = answerCacheEnabled && baseHistory.length === 0 ? `${audience}|${normalizeQuestion(message)}` : null

  // Single tail: fire-and-forget the log (best-effort) and return the reply
  // immediately — never make the tenant wait on the interaction-log write.
  const finalize = async (result: AgentSessionResult, finalProfileId: string): Promise<AgentSessionResult> => {
    void logInteraction(input, result, {
      startedAt,
      conversationId: input.conversationId,
      finalProfileId,
      agentType,
      model: metrics.model,
      promptTokens: metrics.promptTokens,
      completionTokens: metrics.completionTokens,
      grounded: metrics.grounded,
      knowledgeChunkIds: Array.from(new Set(metrics.knowledgeChunkIds)),
    }).catch(() => {})

    // Store ONLY genuinely cacheable answers: a grounded, entry/senior reply
    // with NO tools and NO escalation/handoff. Never cache a personalized,
    // tool-backed, escalated, or shed result (that would leak one user's data
    // to another). metrics.grounded is false on a cache HIT (no retrieval ran),
    // so a hit never re-stores.
    if (
      answerKey && answerCache && metrics.grounded &&
      result.toolInvocations.length === 0 && result.escalations.length === 0 &&
      !result.humanHandoff && !result.shed && result.reply
    ) {
      answerCache.set(answerKey, result.reply)
    }
    return result
  }

  const humanHandoffResult = (reason: string, summary: string): AgentSessionResult => ({
    reply: HUMAN_HANDOFF_REPLY,
    handledBy: { name: 'GAM Support', tier: 'human' },
    escalations,
    toolInvocations,
    humanHandoff: { reason, summary, transcript: [...baseHistory, { role: 'user', content: message }] },
  })

  // Curated FAQ fast-path: an approved answer to a top general question,
  // served instantly — no gate, no model. First-turn only (a follow-up
  // depends on conversation context, so a canned answer wouldn't fit).
  if (baseHistory.length === 0) {
    const faq = await matchCuratedFaq(audience, message).catch(() => null)
    if (faq) {
      return await finalize(
        { reply: faq, handledBy: { name: profile.name, tier: 'entry' }, escalations: [], toolInvocations: [], curated: true },
        profile.id
      )
    }
  }

  // FAQ answer-cache hit: serve immediately — no gate, no model call.
  if (answerKey && answerCache) {
    const hit = answerCache.get(answerKey)
    if (hit) {
      return await finalize(
        { reply: hit, handledBy: { name: profile.name, tier: 'entry' }, escalations: [], toolInvocations: [], cached: true },
        profile.id
      )
    }
  }

  // Cross-session memory: on a fresh conversation (and only on the model
  // path — fast-path hits above skip this), recall what this user recently
  // contacted support about so the agent feels like a rep who remembers them.
  const userContext =
    baseHistory.length === 0 ? await loadUserContext(actor.userId, input.conversationId).catch(() => null) : null
  const priorContext = userContext ? [{ role: 'system' as const, content: userContext }] : []

  // Admit the turn through the concurrency gate. Under overload it sheds
  // rather than piling onto the model fleet and collapsing it.
  const release = await getTurnGate().acquire()
  if (!release) {
    return { reply: HIGH_VOLUME_REPLY, handledBy: { name: 'GAM Support', tier: 'entry' }, escalations: [], toolInvocations: [], shed: true }
  }

  try {
    // At most two hops: entry -> senior -> human.
    for (let hop = 0; hop < 2; hop++) {
      const history = [
        ...priorContext,
        ...baseHistory,
        ...(handoffNote ? [{ role: 'system' as const, content: handoffNote }] : []),
      ]
      const res = await runAgentWithTools({ profile, actor, message, history })
      accumulate(res)
      toolInvocations.push(...res.toolInvocations)

      if (!res.handoff) {
        return await finalize(
          { reply: res.reply, handledBy: { name: profile.name, tier: profile.tier }, escalations, toolInvocations },
          profile.id
        )
      }

      if (res.handoff.kind === 'human') {
        escalations.push({ from: profile.name, to: 'GAM Support', reason: res.handoff.reason })
        return await finalize(humanHandoffResult(res.handoff.reason, res.handoff.summary), profile.id)
      }

      // kind === 'tier': entry -> senior.
      const senior = getEscalationProfile(audience)
      if (!senior) throw new Error(`No escalation profile for audience: ${audience}`)
      // If we're already AT the senior tier (it re-escalated up), there is
      // no higher agent — route straight to a human instead of recording a
      // self-referential 'Samantha -> Samantha' step.
      if (senior.id === profile.id) {
        escalations.push({ from: profile.name, to: 'GAM Support', reason: res.handoff.reason })
        return await finalize(humanHandoffResult(res.handoff.reason, res.handoff.summary), profile.id)
      }
      escalations.push({ from: profile.name, to: senior.name, reason: res.handoff.reason })
      handoffNote = buildHandoffNote(profile, senior, res.handoff)
      profile = senior
    }

    // Senior agent also tried to escalate to a tier (no higher agent tier
    // exists) — treat as needing a human rather than looping.
    logger.warn({ audience }, 'agent session: senior agent re-escalated; routing to human')
    return await finalize(
      humanHandoffResult('Senior agent could not resolve and re-escalated.', 'See transcript.'),
      profile.id
    )
  } catch (err) {
    // Log the failed interaction (outcome='error'), then rethrow so the
    // caller still sees the failure.
    const errResult: AgentSessionResult = {
      reply: '',
      handledBy: { name: profile.name, tier: profile.tier },
      escalations,
      toolInvocations,
    }
    void logInteraction(input, errResult, {
      startedAt,
      conversationId: input.conversationId,
      finalProfileId: profile.id,
      agentType,
      model: metrics.model,
      promptTokens: metrics.promptTokens,
      completionTokens: metrics.completionTokens,
      grounded: metrics.grounded,
      knowledgeChunkIds: Array.from(new Set(metrics.knowledgeChunkIds)),
      outcomeError: err instanceof Error ? err.message : String(err),
    }).catch(() => {})
    throw err
  } finally {
    release() // free the turn slot for the next waiter (idempotent)
  }
}
