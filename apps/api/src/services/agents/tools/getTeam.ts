/**
 * Tool: get_team (landlord read).
 *
 * Lists the landlord's full team across every role — property managers,
 * on-site managers, maintenance workers, bookkeepers — plus any pending
 * invitations. Hard-scoped to landlord_id = actor.profileId on every scope
 * table. Broader than get_maintenance_team (which returns only assignable
 * maintenance workers); this answers "who's on my team / who has access?".
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface MemberRow {
  role: string
  first_name: string | null
  last_name: string | null
  all_properties: boolean | null
  prop_count: number | null
}

const ROLE_LABEL: Record<string, string> = {
  property_manager: 'Property Manager',
  onsite_manager: 'On-site Manager',
  maintenance: 'Maintenance',
  bookkeeper: 'Bookkeeper',
}

export const getTeam: AgentTool = {
  name: 'get_team',
  description:
    'List the landlord’s whole team and each member’s role and coverage — property managers, ' +
    'on-site managers, maintenance workers, and bookkeepers — plus any pending invitations. Use for ' +
    '“who’s on my team?”, “who has access to my account?”, or “did my invite go out?”. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],

  async execute(_args, actor: AgentActor) {
    // One row per (member, role), scoped to this landlord on every table.
    const members = await query<MemberRow>(
      `SELECT s.role, u.first_name, u.last_name, s.all_properties, s.prop_count
         FROM (
           SELECT 'property_manager' AS role, user_id, landlord_id, all_properties,
                  COALESCE(array_length(property_ids, 1), 0) AS prop_count
             FROM property_manager_scopes
           UNION ALL
           SELECT 'onsite_manager', user_id, landlord_id, all_properties,
                  COALESCE(array_length(property_ids, 1), 0)
             FROM onsite_manager_scopes
           UNION ALL
           SELECT 'maintenance', user_id, landlord_id, all_properties,
                  COALESCE(array_length(property_ids, 1), 0)
             FROM maintenance_worker_scopes
           UNION ALL
           SELECT 'bookkeeper', user_id, landlord_id, NULL::boolean, NULL::integer
             FROM bookkeeper_scopes
         ) s
         JOIN users u ON u.id = s.user_id
        WHERE s.landlord_id = $1
        ORDER BY s.role, u.first_name, u.last_name`,
      [actor.profileId]
    )

    const invites = await query<{ email: string; role: string }>(
      `SELECT email, role FROM invitations WHERE landlord_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
      [actor.profileId]
    )

    const coverage = (m: MemberRow): string => {
      if (m.role === 'bookkeeper') return 'books access'
      if (m.all_properties) return 'all properties'
      const n = m.prop_count ?? 0
      return `${n} propert${n === 1 ? 'y' : 'ies'}`
    }

    return {
      ok: true,
      memberCount: members.length,
      note: members.length === 0 && invites.length === 0 ? 'No team members or pending invitations yet.' : undefined,
      members: members.map((m) => ({
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Unnamed',
        role: ROLE_LABEL[m.role] ?? m.role,
        coverage: coverage(m),
      })),
      pendingInvites: invites.map((i) => ({ email: i.email, role: ROLE_LABEL[i.role] ?? i.role })),
    }
  },
}
