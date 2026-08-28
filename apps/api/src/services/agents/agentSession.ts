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

import { scrubScopeLeaks, scrubOffAudienceTopics, isOffAudienceQuestion, offAudienceReply } from './scopeGuard'
import { RetryableEndpointError } from './endpointPool'
import { needsARealPerson, stripPromiseOfAPerson, mentionsLegalAction, LEGAL_CONTACT_LINE } from './escalationPolicy'
import { collapseRepetition } from './collapseRepetition'
import { runAgentWithTools, type ToolInvocation, type RunWithToolsResult } from './agentRunner'
import { getEntryProfile, getEscalationProfile } from './profiles'
import { logInteraction } from './logInteraction'
import { getTurnGate } from './turnGate'
import { answerCache, answerCacheEnabled, normalizeQuestion } from './cache'
import { checkTurnBudget, BUDGET_CAPPED_REPLY } from './turnBudget'
import { matchCuratedFaq } from './curatedFaq'
import type { AgentActor } from './tools/types'
import type { HandoffSignal } from './tools/escalation'
import { logger } from '../../lib/logger'
import type { AgentAudience, AgentProfile, AgentTier, ChatMessage } from './types'
import { withConcurrencySlot } from './concurrencyGate'
import { loadConversationToolCalls } from './conversationHistory'

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
  /** true when the turn was refused by the per-user daily budget (S553) */
  rateLimited?: boolean
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

// No live human agents staff the chat. When something reaches the human tier we
// commit to an ASYNC follow-up: a senior agent reviews it and emails the customer
// within 24 hours. The reply must NOT imply a real-time transfer / someone waiting.
const HUMAN_HANDOFF_REPLY =
  `I've escalated this to a senior agent on our support team. They'll personally review ` +
  `everything we've covered and email you a response within 24 hours — so you won't have to ` +
  `repeat yourself. Is there anything else I can help you with in the meantime?`

// Distinct from the human-handoff copy on purpose: a capacity shed must NOT
// imply a specialist will follow up (no false promise).
const HIGH_VOLUME_REPLY =
  `Thanks for reaching out! We're seeing unusually high volume right now and ` +
  `couldn't get to your message this moment. Please try again in a few minutes — ` +
  `we'll be right with you.`

/**
 * S628 — every conversation goes through the concurrency gate.
 *
 * Nic: "too many people trying to have conversations at the same time would
 * just slow them all down, not crash the computer. It should queue things up."
 * It did not. Each conversation allocates a KV cache on the GPU, and when the
 * allocation fails mlx_lm aborts the whole server out of a C++ destructor —
 * taking every conversation in flight with it. Four times in an hour on
 * 2026-08-28.
 *
 * Wrapped HERE rather than at the three call sites in routes/agent.ts, so the
 * limit cannot be bypassed by a route added later — including the eval and
 * conversation harnesses, which are exactly the workloads that found the crash.
 *
 * The slot is held for the whole session rather than for each generation. That
 * is coarser than strictly necessary — a session also does database work — but
 * a session IS the unit a person is waiting through, and the generation
 * dominates it.
 */
export async function runAgentSession(input: AgentSessionInput): Promise<AgentSessionResult> {
  return withConcurrencySlot(() => runAgentSessionInner(input))
}

async function runAgentSessionInner(input: AgentSessionInput): Promise<AgentSessionResult> {
  const { audience, actor, message } = input
  const baseHistory = input.history ?? []
  const startedAt = Date.now()

  // Defense in depth: the tool allowlist + audience gate key off
  // `audience`, while every tool's data scope binds to `actor`. They must
  // agree, or a misconfigured caller could surface one audience's tools
  // against the other's identity. Fail fast on a mismatch.
  if (
    (actor.role === 'tenant' || actor.role === 'landlord' || actor.role === 'guest' || actor.role === 'visitor') &&
    actor.role !== audience
  ) {
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
  // The 'visitor' (property agent) audience is NEVER answer-cached: its replies
  // are property-specific, and a key of audience+question alone would risk
  // serving one property's answer on a different property's site. (Its answers
  // are tool-backed anyway, so the store guard already skips them — this makes
  // the isolation explicit rather than incidental.)
  const answerKey = answerCacheEnabled && audience !== 'visitor' && baseHistory.length === 0 ? `${audience}|${normalizeQuestion(message)}` : null

  // Single tail: fire-and-forget the log (best-effort) and return the reply
  // immediately — never make the tenant wait on the interaction-log write.
  const finalize = async (result: AgentSessionResult, finalProfileId: string): Promise<AgentSessionResult> => {
    // S617: strip the two give-aways before ANYTHING else sees this reply —
    // before it is logged, before it is cached, before it is sent. The cache
    // matters most: a leaked answer stored there is served to other people.
    // See scopeGuard.ts for why this is deterministic and not just prompted.
    if (result.reply) {
      // S618 (Nic): "any sort of bringing an outside person into the
      // conversation should only be done if it's real money... other than that,
      // no promises of talking to a real person."
      //
      // Here rather than in the runner because EVERY reply passes through
      // finalize — the runner returns from a dozen places, and a promise that
      // slips out of any one of them is a customer waiting on a callback that
      // was never booked. The rest of the answer is kept; only the promise goes.
      // A handoff that was actually RECORDED is not a false promise — a real
      // package exists and a person receives it, so that reply stays intact.
      // What gets removed is the promise nothing backs.
      if (!needsARealPerson(input.message) && !result.humanHandoff && result.reply) {
        const kept = stripPromiseOfAPerson(result.reply)
        if (kept !== result.reply) {
          logger.warn({ profile: finalProfileId },
            '[agent] promise of a person removed — not a money problem')
          result = { ...result, reply: kept }
        }
      }
      // S624 — A MODEL STUCK IN A LOOP MUST NOT REACH THE CUSTOMER.
      //
      // Asked to confirm a lead, Lucy repeated "I'll send over the call
      // details. I'll also send over a personalized call invitation with the
      // time and link." roughly fifty times until she hit the token ceiling,
      // and the whole wall of it went out — on the PUBLIC marketing chat, to a
      // prospect who had just given their name and email.
      //
      // Nothing anywhere caught it. Sampler settings reduce the odds of Hermes
      // degenerating (the defaults carry a comment saying so) but cannot remove
      // them, and a generation failure should never be something a customer
      // reads. Runs FIRST, so every later guard works on a sane reply.
      if (result.reply) {
        const collapsed = collapseRepetition(result.reply)
        if (collapsed.removed > 0) {
          logger.warn({
            profile: finalProfileId, removed: collapsed.removed,
            degenerate: collapsed.degenerate, message: input.message,
          }, '[agent] repeated itself — collapsed')
          result = { ...result, reply: collapsed.reply }
        }
      }

      // S618 (Nic): legal action gets an ADDRESS, not a promise. The customer
      // reaches out to us — "anybody that's just blowing smoke isn't gonna
      // bother reaching out. Anybody that is a little more serious will make
      // the reach out, and it kind of prefilters some people for us."
      // Added after the promise-stripping above, so the reply carries the one
      // commitment GAM can actually keep: an address that works.
      if (mentionsLegalAction(input.message) && result.reply
          && !result.reply.includes('support@goldassetmanagement.com')) {
        result = { ...result, reply: `${result.reply.trim()}\n\n${LEGAL_CONTACT_LINE}` }
      }
      // S620: another audience's product, removed before the general scrub.
      // A booking-site visitor was walked through resetting a GAM password —
      // fluent, confident, and about an account they do not have. None of the
      // fact guards catch it because it asserts no figure or date. Only the
      // two no-account audiences are touched; see scopeGuard.ts.
      const offAudience = scrubOffAudienceTopics(result.reply, audience)
      if (offAudience.removed.length) {
        logger.warn({ profile: finalProfileId, audience, removed: offAudience.removed },
          '[agent] another audience\'s topic removed from reply')
        result = { ...result, reply: offAudience.reply }
      }
      const scrubbed = scrubScopeLeaks(result.reply)
      // ALWAYS take the scrubbed text, not only when a leak sentence was cut.
      // scrubScopeLeaks also strips markdown the chat window cannot render, and
      // gating on removed.length threw that away on every reply that was merely
      // formatted wrong — which is most of them.
      if (scrubbed.reply !== result.reply) result = { ...result, reply: scrubbed.reply }
      if (scrubbed.removed.length) {
        logger.warn({ profile: finalProfileId, removed: scrubbed.removed },
          '[agent] scope leak scrubbed from reply')
      }
    }

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
  //
  // DISABLED by default: the canned copy broke the "real person" feel (e.g.
  // deflecting "see my lease details" to "it's in Documents" instead of calling
  // get_my_lease). Every message now goes through the agent + tools. Re-enable
  // with AGENT_CURATED_FAQ=1 if a vetted instant-answer path is wanted again.
  if (process.env.AGENT_CURATED_FAQ === '1' && baseHistory.length === 0) {
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

  // S553: per-user daily turn budget (abuse guard) — checked AFTER the
  // cache fast-paths on purpose: cached answers cost nothing, so a capped
  // user keeps getting FAQ answers all day. Over budget → canned reply,
  // zero model calls, logged as outcome 'rate_limited'.
  const budget = await checkTurnBudget(audience, actor.userId, actor.profileId).catch(() => ({ allowed: true as const }))
  if (!budget.allowed) {
    logger.warn({ audience, reason: (budget as any).reason }, 'agent session: turn refused by daily budget')
    return finalize(
      { reply: BUDGET_CAPPED_REPLY, handledBy: { name: profile.name, tier: 'entry' }, escalations: [], toolInvocations: [], rateLimited: true },
      profile.id
    )
  }

  // S620: a question that was never this agent's to answer. Answered BEFORE the
  // model runs, because the model's honest attempt is either a leak (a booking
  // visitor walked through resetting a GAM password) or, once the guards stop
  // that, the suppression fallback — "I don't want to quote you a figure I
  // haven't actually checked" to somebody who asked about a password. Safe,
  // and baffling. Guest and visitor only, and narrower than the reply-side
  // scrub: a guest asking about a late-checkout fee is asking a real question
  // about their own stay. See scopeGuard.ts.
  if (isOffAudienceQuestion(message, audience)) {
    logger.info({ audience, profile: profile.id }, '[agent] off-audience question answered with a redirect')
    return finalize(
      { reply: offAudienceReply(audience), handledBy: { name: profile.name, tier: 'entry' }, escalations: [], toolInvocations: [] },
      profile.id
    )
  }

  // CROSS-SESSION MEMORY REMOVED (S618, Nic): "I don't think we should have
  // cross session memory unless there was ever an issue where a tenant was
  // waiting for a follow-up from the agent that would be resolved at a later
  // date, but I don't really see that happening. So we should just get rid of
  // cross session memory."
  //
  // It also measurably HURT. The same five questions, memory on: 1/5 correct.
  // Memory off: 2/5. Telling the model "this person recently asked about their
  // balance" made it LESS likely to look the balance up — it behaved as though
  // it had already answered. The whole point of the feature was to feel like a
  // rep who remembers you; what it produced was a rep who assumes they already
  // told you.
  //
  // Nothing replaces it: `history` still carries the CURRENT conversation, so a
  // customer never repeats themselves within a chat. What is gone is dragging
  // last week's questions into this one.
  const priorContext: { role: 'system'; content: string }[] = []

  // Admit the turn through the concurrency gate. Under overload it sheds
  // rather than piling onto the model fleet and collapsing it.
  const release = await getTurnGate().acquire()
  if (!release) {
    // S553: shed turns log too (outcome 'shed' via deriveOutcome) — shed
    // volume is the capacity alarm on the admin Agent Analytics page.
    return finalize(
      { reply: HIGH_VOLUME_REPLY, handledBy: { name: 'GAM Support', tier: 'entry' }, escalations: [], toolInvocations: [], shed: true },
      profile.id
    )
  }

  try {
    // At most two hops: entry -> senior -> human.
    for (let hop = 0; hop < 2; hop++) {
      const history = [
        ...priorContext,
        ...baseHistory,
        ...(handoffNote ? [{ role: 'system' as const, content: handoffNote }] : []),
      ]
      // S628: what this conversation has already DONE, so an identical action
      // is refused rather than carried out twice. Loaded from the interaction
      // log, which already records every call with its arguments — the run
      // caught the agent filing a second maintenance request for one sink while
      // telling the tenant, correctly, that it was already logged.
      const priorToolCalls = input.conversationId
        ? await loadConversationToolCalls(input.conversationId, actor.userId).catch(() => [])
        : []
      const res = await runAgentWithTools({ profile, actor, message, history, priorToolCalls })
      accumulate(res)
      toolInvocations.push(...res.toolInvocations)

      if (!res.handoff) {
        return await finalize(
          { reply: res.reply, handledBy: { name: profile.name, tier: profile.tier }, escalations, toolInvocations },
          profile.id
        )
      }

      // Routing rule (locked, Nic): ALL escalation runs through the senior agent,
      // and ONLY the senior (tier 'escalation') can escalate to the real-person /
      // email tier. An entry agent can never reach a human directly — downgrade any
      // 'human' signal it produces to a hand-up to the senior.
      const handoffKind: typeof res.handoff.kind =
        res.handoff.kind === 'human' && profile.tier !== 'escalation' ? 'tier' : res.handoff.kind

      if (handoffKind === 'human') {
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

    // S618: the model being down is not something to hand the customer raw.
    //
    // Every other error still throws — a bug should be loud. But when the
    // model or the embeddings server is unreachable the old path rethrew, the
    // route called next(e), and errorHandler answered the tenant's chat with
    // HTTP 500 and the literal string "LLM endpoint unreachable at
    // http://localhost:8080/v1" — an internal address, shown to a renter who
    // asked what they owe.
    //
    // This is not hypothetical and it is not rare: the model is a single
    // process on a Mac, it has died four times that we know of (88 logged
    // failures in one hour on 2026-08-23 alone), and §0 of the S618 handoff
    // exists because that machine is on a grid with brownouts. Whatever else
    // is true when it happens, the person typing deserves a sentence rather
    // than a stack trace.
    //
    // Deliberately says nothing about AI, servers or scope — scopeGuard bans
    // reciting limits, and "our system is down" is machine-talk. It also does
    // NOT claim an escalation, because nothing was escalated. It is logged as
    // outcome='error' either way, so Sentry and the uptime monitors still see
    // the truth even though the customer does not.
    if (err instanceof RetryableEndpointError) {
      logger.error({ audience, err }, 'agent session: endpoint down — returning a graceful reply instead of a 500')
      return {
        reply: "Sorry — I'm having trouble pulling that up right this second. Give it a minute and ask me again, and it should come through.",
        handledBy: { name: profile.name, tier: profile.tier },
        escalations,
        toolInvocations,
      }
    }
    throw err
  } finally {
    release() // free the turn slot for the next waiter (idempotent)
  }
}
