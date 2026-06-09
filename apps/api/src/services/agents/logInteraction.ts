/**
 * Agent interaction logging (Step 6).
 *
 * Writes ONE row to agent_interaction_logs per completed runAgentSession
 * turn. Best-effort: a logging failure is caught and swallowed so it can
 * NEVER break the customer-facing reply (modeled on lib/adminAudit.ts and
 * services/csvImportAttempts.ts).
 *
 * Property attribution is RESOLVED here and snapshotted onto the row:
 * a tenant's interaction is tagged with their active unit's property; a
 * landlord's is portfolio-wide (property_id NULL, landlord_id = the
 * landlord). A later lease change never re-attributes old rows.
 */

import { randomUUID } from 'crypto'
import { query } from '../../db'
import { logger } from '../../lib/logger'
import type { AgentSessionInput, AgentSessionResult } from './agentSession'
import type { AgentActor } from './tools/types'
import type { AgentOutcome } from './types'

export interface LogInteractionContext {
  startedAt: number
  /** correlation id grouping a multi-turn thread; generated if absent */
  conversationId?: string
  /** machine id of the profile that produced the final reply (or the
   *  senior that escalated to a human) */
  finalProfileId: string
  /** the handling profile's agentType (e.g. 'customer_service', 'sales') */
  agentType?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  grounded?: boolean
  knowledgeChunkIds?: string[]
  /** populated only when the orchestration threw */
  outcomeError?: string
}

/** Resolve the property + landlord this interaction attributes to. */
export async function resolveInteractionProperty(
  actor: AgentActor
): Promise<{ propertyId: string | null; landlordId: string | null }> {
  if (actor.role === 'landlord') {
    // Portfolio-wide: no single property; the landlord IS the subject.
    return { propertyId: null, landlordId: actor.profileId }
  }
  if (actor.role !== 'tenant') {
    return { propertyId: null, landlordId: null }
  }
  // Tenant: reuse the active-lease join the tools use.
  const rows = await query<{ property_id: string; landlord_id: string }>(
    `SELECT DISTINCT u.property_id, p.landlord_id
       FROM v_lease_active_tenants vlat
       JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE vlat.tenant_id = $1`,
    [actor.profileId]
  )
  if (rows.length === 1) {
    return { propertyId: rows[0].property_id, landlordId: rows[0].landlord_id }
  }
  // Zero (applicant/between leases) or multiple (ambiguous) → no single
  // property. If multiple units share ONE landlord, still stamp it.
  const landlordIds = new Set(rows.map((r) => r.landlord_id))
  return { propertyId: null, landlordId: landlordIds.size === 1 ? rows[0].landlord_id : null }
}

/**
 * Derive the HEADLINE outcome from the session result. Precedence:
 * error > human > escalation-tier > action > entry. This is one axis (how
 * the turn ended at the top level); "was an action taken" is NOT lost when
 * a senior handled it — it lives independently in tool_invocation_count /
 * tool_names. Escalation control-calls are excluded from toolInvocations
 * upstream (agentRunner), so action_taken only fires on real data/action
 * tools.
 */
export function deriveOutcome(result: AgentSessionResult, outcomeError?: string): AgentOutcome {
  if (outcomeError) return 'error'
  if (result.humanHandoff != null || result.handledBy.tier === 'human') return 'escalated_to_human'
  if (result.handledBy.tier === 'escalation') return 'answered_escalation'
  if (result.toolInvocations.length > 0) return 'action_taken'
  return 'answered_entry'
}

export async function logInteraction(
  input: AgentSessionInput,
  result: AgentSessionResult,
  ctx: LogInteractionContext
): Promise<string | null> {
  try {
    const { actor } = input
    const { propertyId, landlordId } = await resolveInteractionProperty(actor)
    const outcome = deriveOutcome(result, ctx.outcomeError)
    const escalatedToHuman = result.humanHandoff != null || result.handledBy.tier === 'human'

    const rows = await query<{ id: string }>(
      `INSERT INTO agent_interaction_logs (
         conversation_id, turn_index,
         agent_type, audience, profile_id, agent_name, handled_by_tier, outcome,
         property_id, landlord_id,
         actor_user_id, actor_role, actor_subject_id,
         escalation_count, escalated_to_human, escalations,
         tool_invocation_count, tool_names, tool_invocations,
         latency_ms, prompt_tokens, completion_tokens, model, grounded, knowledge_chunk_ids,
         user_message, agent_reply, human_handoff, error_detail, metadata
       ) VALUES (
         $1, $2,
         $3, $4, $5, $6, $7, $8,
         $9, $10,
         $11, $12, $13,
         $14, $15, $16::jsonb,
         $17, $18, $19::jsonb,
         $20, $21, $22, $23, $24, $25,
         $26, $27, $28::jsonb, $29, $30::jsonb
       ) RETURNING id`,
      [
        ctx.conversationId ?? randomUUID(),
        input.history?.length ?? 0,
        ctx.agentType ?? 'customer_service',
        input.audience,
        ctx.finalProfileId,
        result.handledBy.name,
        result.handledBy.tier,
        outcome,
        propertyId,
        landlordId,
        // Prospects are anonymous (no GAM user) — actor_user_id FK must be NULL.
        input.audience === 'prospect' ? null : actor.userId,
        actor.role,
        actor.profileId,
        result.escalations.length,
        escalatedToHuman,
        JSON.stringify(result.escalations),
        result.toolInvocations.length,
        result.toolInvocations.map((t) => t.name),
        JSON.stringify(result.toolInvocations),
        Date.now() - ctx.startedAt,
        ctx.promptTokens ?? null,
        ctx.completionTokens ?? null,
        ctx.model ?? null,
        ctx.grounded ?? null,
        ctx.knowledgeChunkIds ?? [],
        input.message,
        result.reply,
        result.humanHandoff ? JSON.stringify(result.humanHandoff) : null,
        ctx.outcomeError ?? null,
        JSON.stringify({}),
      ]
    )
    return rows[0]?.id ?? null
  } catch (err) {
    // Never let a logging failure break the customer reply.
    logger.error({ err, audience: input.audience }, 'agent interaction logging failed')
    return null
  }
}
