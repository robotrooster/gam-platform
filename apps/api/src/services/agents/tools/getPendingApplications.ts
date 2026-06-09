/**
 * Tool: get_pending_applications (landlord). Reads rental applications to
 * the landlord's OWN units. Hard-scoped to actor.profileId
 * (unit_applications.landlord_id). Returns applicant contact + basics —
 * this table holds NO SSN/PII (background-check PII lives elsewhere and is
 * intentionally NOT exposed to the agent).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  move_in_date: string | null
  occupants: number | null
  has_pets: boolean | null
  status: string
  created_at: string
  unit_number: string | null
  property_name: string | null
}

export const getPendingApplications: AgentTool = {
  name: 'get_pending_applications',
  description:
    'List recent rental applications to the landlord’s units, with the applicant’s name/contact, ' +
    'desired move-in date, occupants, pets, and the application status. Use for “any new ' +
    'applications?” or “who applied for unit 4?”. Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many recent applications (default 20, max 50).' } } },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 20
    const rows = await query<Row>(
      `SELECT a.first_name, a.last_name, a.email, a.phone, a.move_in_date, a.occupants, a.has_pets,
              a.status, a.created_at, u.unit_number, p.name AS property_name
         FROM unit_applications a
         JOIN units u ON u.id = a.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE a.landlord_id = $1
        ORDER BY a.created_at DESC LIMIT $2`,
      [actor.profileId, limit]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No applications on record.' : undefined,
      applications: rows.map((r) => ({
        applicant: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
        email: r.email, phone: r.phone, status: r.status,
        desiredMoveIn: r.move_in_date, occupants: r.occupants, hasPets: r.has_pets,
        property: r.property_name, unit: r.unit_number, appliedAt: r.created_at,
      })),
    }
  },
}
