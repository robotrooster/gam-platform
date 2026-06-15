/**
 * S480 — landlord-facing agent_interaction_logs reporting.
 *
 * Two endpoints exposing the v_landlord_agent_interactions VIEW
 * scoped to the calling landlord (or PM staff with landlord access).
 * The VIEW is the single column-allowlist definition (omits all
 * verbatim conversation content); this router adds row-level scoping
 * via landlord_id = actor.profileId.
 *
 *   GET /api/landlord/agent-activity            — 30-day summary KPIs
 *   GET /api/landlord/agent-activity/recent     — last N rows
 *
 * Owner roles (landlord) pass through; non-owner workers (property
 * manager etc.) currently get 403 — extend the gate when the
 * permission-framework matrix calls it out specifically.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const landlordAgentActivityRouter = Router()
landlordAgentActivityRouter.use(requireAuth)

function requireLandlordProfileId(req: any): string {
  if (req.user?.role !== 'landlord') {
    throw new AppError(403, 'Only landlord owners can view agent activity')
  }
  if (!req.user.profileId) {
    throw new AppError(403, 'Landlord profile not resolved')
  }
  return req.user.profileId
}

// ════════════════════════════════════════════════════════════════
//  GET / — 30-day rollup summary
// ════════════════════════════════════════════════════════════════

const summarySchema = z.object({
  days: z.coerce.number().int().positive().max(365).optional(),
})

landlordAgentActivityRouter.get('/', async (req, res, next) => {
  try {
    const landlordId = requireLandlordProfileId(req)
    const { days = 30 } = summarySchema.parse(req.query)

    const since = `CURRENT_DATE - ($1::int || ' days')::interval`
    const [totals] = await query<{
      total: number
      tenant_count: number
      landlord_count: number
      escalated_count: number
      grounded_count: number
      avg_latency_ms: number | null
    }>(
      `SELECT
         COUNT(*)::int                                                AS total,
         COUNT(*) FILTER (WHERE audience = 'tenant')::int             AS tenant_count,
         COUNT(*) FILTER (WHERE audience = 'landlord')::int           AS landlord_count,
         COUNT(*) FILTER (WHERE escalated_to_human = TRUE)::int       AS escalated_count,
         COUNT(*) FILTER (WHERE grounded = TRUE)::int                 AS grounded_count,
         AVG(latency_ms)::int                                         AS avg_latency_ms
       FROM v_landlord_agent_interactions
       WHERE landlord_id = $2
         AND created_at >= ${since}`,
      [days, landlordId],
    )

    const byOutcome = await query<{ outcome: string; count: number }>(
      `SELECT outcome, COUNT(*)::int AS count
         FROM v_landlord_agent_interactions
        WHERE landlord_id = $2
          AND created_at >= ${since}
        GROUP BY outcome
        ORDER BY COUNT(*) DESC`,
      [days, landlordId],
    )

    const byAgent = await query<{ agent_name: string; count: number }>(
      `SELECT agent_name, COUNT(*)::int AS count
         FROM v_landlord_agent_interactions
        WHERE landlord_id = $2
          AND created_at >= ${since}
        GROUP BY agent_name
        ORDER BY COUNT(*) DESC`,
      [days, landlordId],
    )

    // Top tools used in the landlord's scope (across BOTH audiences).
    // Useful signal — "tenants asked for documents 18 times this month."
    const byTool = await query<{ tool: string; count: number }>(
      `SELECT tool, COUNT(*)::int AS count
         FROM v_landlord_agent_interactions, UNNEST(tool_names) AS tool
        WHERE landlord_id = $2
          AND created_at >= ${since}
        GROUP BY tool
        ORDER BY COUNT(*) DESC
        LIMIT 10`,
      [days, landlordId],
    )

    res.json({
      success: true,
      data: {
        days,
        totals: totals ?? {
          total: 0, tenant_count: 0, landlord_count: 0,
          escalated_count: 0, grounded_count: 0, avg_latency_ms: null,
        },
        by_outcome: byOutcome,
        by_agent:   byAgent,
        by_tool:    byTool,
      },
    })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════════════════════════════
//  GET /recent — last N metadata rows
// ════════════════════════════════════════════════════════════════

const recentSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  // Optional outcome filter — useful for "show me the escalations."
  outcome: z.string().min(1).optional(),
})

landlordAgentActivityRouter.get('/recent', async (req, res, next) => {
  try {
    const landlordId = requireLandlordProfileId(req)
    const { limit = 50, outcome } = recentSchema.parse(req.query)

    const params: any[] = [landlordId]
    let where = 'landlord_id = $1'
    if (outcome) {
      params.push(outcome)
      where += ` AND outcome = $${params.length}`
    }
    params.push(limit)

    const rows = await query<any>(
      `SELECT id, conversation_id, turn_index, agent_name, audience,
              handled_by_tier, outcome, property_id, actor_role,
              escalation_count, escalated_to_human, tool_names,
              tool_invocation_count, latency_ms, grounded, created_at
         FROM v_landlord_agent_interactions
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    )

    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
