/**
 * Tool: get_lease_expirations (landlord). Lists the landlord's OWN active
 * leases ending within a window. Hard-scoped to actor.profileId
 * (leases.landlord_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  end_date: string
  auto_renew: boolean
  unit_number: string | null
  property_name: string | null
  tenants: string | null
}

export const getLeaseExpirations: AgentTool = {
  name: 'get_lease_expirations',
  description:
    'List the landlord’s active leases ending soon (within the next N days, default 60), with the ' +
    'unit, tenant(s), end date, and whether it auto-renews. Use for “which leases are expiring?” or ' +
    '“who’s up for renewal?”. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      daysAhead: { type: 'integer', description: 'Look-ahead window in days (default 60, max 365).' },
      limit: { type: 'integer', description: 'How many (default 50, max 200).' },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawDays = Number(args.daysAhead)
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.trunc(rawDays), 1), 365) : 60
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50

    const rows = await query<Row>(
      `SELECT l.end_date, l.auto_renew, u.unit_number, p.name AS property_name,
              (SELECT string_agg(vlat.first_name || ' ' || vlat.last_name, ', ')
                 FROM v_lease_active_tenants vlat WHERE vlat.lease_id = l.id) AS tenants
         FROM leases l
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE l.landlord_id = $1 AND l.status = 'active' AND l.end_date IS NOT NULL
          AND l.end_date <= (now() + make_interval(days => $2::int))::date
        ORDER BY l.end_date
        LIMIT $3`,
      [actor.profileId, days, limit]
    )
    return {
      ok: true,
      count: rows.length,
      windowDays: days,
      note: rows.length === 0 ? `No leases expiring in the next ${days} days.` : undefined,
      expiring: rows.map((r) => ({
        property: r.property_name, unit: r.unit_number, tenants: r.tenants,
        endDate: r.end_date, autoRenews: r.auto_renew,
      })),
    }
  },
}
