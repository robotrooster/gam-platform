/**
 * Tool: get_my_bookings (tenant). Reads the tenant's OWN stay bookings
 * (RV / short-term / nightly units). Hard-scoped to actor.profileId
 * (unit_bookings.tenant_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  check_in: string | null
  check_out: string | null
  nights: number | null
  total_amount: string | null
  status: string
  lease_type: string | null
}

export const getMyBookings: AgentTool = {
  name: 'get_my_bookings',
  description:
    'List the tenant’s own stay bookings (for nightly/weekly/RV-style units) — check-in and ' +
    'check-out dates, nights, total, and status. Use for “when’s my check-out?”, “when does my ' +
    'stay end?”, or “what did my booking cost?”. Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many bookings (default 10, max 25).' } } },
  audiences: ['tenant'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 25) : 10
    const rows = await query<Row>(
      `SELECT check_in, check_out, nights, total_amount, status, lease_type
         FROM unit_bookings WHERE tenant_id = $1
        ORDER BY COALESCE(check_in, created_at) DESC LIMIT $2`,
      [actor.profileId, limit]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No bookings on record for this tenant.' : undefined,
      bookings: rows.map((r) => ({
        checkIn: r.check_in, checkOut: r.check_out, nights: r.nights,
        total: r.total_amount != null ? Number(r.total_amount) : null, status: r.status, type: r.lease_type,
      })),
    }
  },
}
