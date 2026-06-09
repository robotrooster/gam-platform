/**
 * Tool: get_maintenance_team (landlord read).
 *
 * Lists the landlord's OWN maintenance workers — the team members a work
 * order can be assigned to. Sourced from maintenance_worker_scopes (the
 * dedicated maintenance role), hard-scoped to landlord_id = actor.profileId.
 * Gives the agent the worker names + ids it needs to resolve
 * "assign this to Mike" via assign_maintenance_request.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface WorkerRow {
  user_id: string
  first_name: string | null
  last_name: string | null
  job_categories: string[]
  all_properties: boolean
  property_count: number
}

export const getMaintenanceTeam: AgentTool = {
  name: 'get_maintenance_team',
  description:
    'List the landlord’s maintenance team — the workers a work order can be assigned to, with the ' +
    'job categories and how many properties each covers. Use for “who’s on my maintenance team?” or ' +
    'to find who to assign a repair to before calling assign_maintenance_request. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],

  async execute(_args, actor: AgentActor) {
    // DISTINCT collapses any duplicate scope rows for the same worker.
    const rows = await query<WorkerRow>(
      `SELECT DISTINCT s.user_id, u.first_name, u.last_name,
              s.job_categories, s.all_properties,
              COALESCE(array_length(s.property_ids, 1), 0) AS property_count
         FROM maintenance_worker_scopes s
         JOIN users u ON u.id = s.user_id
        WHERE s.landlord_id = $1
        ORDER BY u.first_name, u.last_name`,
      [actor.profileId]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0
        ? 'No maintenance workers on your team yet. Add one from Team settings, then you can assign work orders to them.'
        : undefined,
      workers: rows.map((r) => ({
        workerId: r.user_id, // pass to assign_maintenance_request
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unnamed worker',
        jobCategories: r.job_categories?.length ? r.job_categories : ['all categories'],
        coverage: r.all_properties ? 'all properties' : `${r.property_count} propert${r.property_count === 1 ? 'y' : 'ies'}`,
      })),
    }
  },
}
