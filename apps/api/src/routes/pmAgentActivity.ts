/**
 * S484 — PM-company-facing agent_interaction_logs reporting.
 *
 * Mirrors `/api/landlord/agent-activity` (S480) but scopes to the
 * landlords whose properties are assigned to the calling PM company.
 * Same metadata-only `v_landlord_agent_interactions` VIEW; same
 * privacy posture (no verbatim conversation content).
 *
 *   GET /api/pm/:pmCompanyId/agent-activity         — 30-day summary KPIs
 *   GET /api/pm/:pmCompanyId/agent-activity/recent  — last N rows
 *
 * Gate: caller must be an active pm_staff member of the PM company
 * in any of {owner, manager, staff}. Suspended companies are locked
 * out by the assertPmStaffRole helper.
 *
 * Scoping: WHERE landlord_id IN (SELECT DISTINCT landlord_id FROM
 * properties WHERE pm_company_id = :pmCompanyId). Landlord-audience
 * conversations have property_id=NULL but landlord_id is denormalized
 * on every row, so scoping by landlord catches both tenant and
 * landlord conversations under the PM company's managed portfolio.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import { assertPmStaffRole } from './pm'

export const pmAgentActivityRouter = Router({ mergeParams: true })
pmAgentActivityRouter.use(requireAuth)

// ════════════════════════════════════════════════════════════════
//  GET / — 30-day rollup summary
// ════════════════════════════════════════════════════════════════

const summarySchema = z.object({
  days: z.coerce.number().int().positive().max(365).optional(),
})

pmAgentActivityRouter.get('/', async (req, res, next) => {
  try {
    const pmCompanyId = (req.params as any).pmCompanyId as string
    await assertPmStaffRole(req.user!.userId, pmCompanyId, ['owner', 'manager', 'staff'])
    const { days = 30 } = summarySchema.parse(req.query)

    const since = `CURRENT_DATE - ($1::int || ' days')::interval`
    // landlord_id IN (PM company's landlords) — denormalized on every
    // row, catches landlord-audience conversations (property_id NULL)
    // alongside tenant-audience.
    const scopedWhere = `landlord_id IN (
      SELECT DISTINCT landlord_id FROM properties WHERE pm_company_id = $2
    )`

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
       WHERE created_at >= ${since}
         AND ${scopedWhere}`,
      [days, pmCompanyId],
    )

    const byOutcome = await query<{ outcome: string; count: number }>(
      `SELECT outcome, COUNT(*)::int AS count
         FROM v_landlord_agent_interactions
        WHERE created_at >= ${since}
          AND ${scopedWhere}
        GROUP BY outcome
        ORDER BY COUNT(*) DESC`,
      [days, pmCompanyId],
    )

    const byAgent = await query<{ agent_name: string; count: number }>(
      `SELECT agent_name, COUNT(*)::int AS count
         FROM v_landlord_agent_interactions
        WHERE created_at >= ${since}
          AND ${scopedWhere}
        GROUP BY agent_name
        ORDER BY COUNT(*) DESC`,
      [days, pmCompanyId],
    )

    const byTool = await query<{ tool: string; count: number }>(
      `SELECT tool, COUNT(*)::int AS count
         FROM v_landlord_agent_interactions, UNNEST(tool_names) AS tool
        WHERE created_at >= ${since}
          AND ${scopedWhere}
        GROUP BY tool
        ORDER BY COUNT(*) DESC
        LIMIT 10`,
      [days, pmCompanyId],
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
  limit:   z.coerce.number().int().positive().max(200).optional(),
  outcome: z.string().min(1).optional(),
})

pmAgentActivityRouter.get('/recent', async (req, res, next) => {
  try {
    const pmCompanyId = (req.params as any).pmCompanyId as string
    await assertPmStaffRole(req.user!.userId, pmCompanyId, ['owner', 'manager', 'staff'])
    const { limit = 50, outcome } = recentSchema.parse(req.query)

    const params: any[] = [pmCompanyId]
    let where = `landlord_id IN (
      SELECT DISTINCT landlord_id FROM properties WHERE pm_company_id = $1
    )`
    if (outcome) {
      params.push(outcome)
      where += ` AND outcome = $${params.length}`
    }
    params.push(limit)

    const rows = await query<any>(
      `SELECT id, conversation_id, turn_index, agent_name, audience,
              handled_by_tier, outcome, property_id, landlord_id, actor_role,
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
