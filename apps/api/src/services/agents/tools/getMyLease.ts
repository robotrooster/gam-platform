/**
 * Tool: get_my_lease (tenant).
 *
 * Reads the logged-in tenant's OWN active lease(s): rent, due day, term,
 * late-fee grace, and which property/unit. Hard-scoped to actor.profileId
 * via v_lease_active_tenants — the model cannot read another tenant's lease.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface LeaseRow {
  id: string
  status: string
  rent_amount: string
  rent_due_day: number | null
  start_date: string
  end_date: string | null
  late_fee_grace_days: number | null
  unit_number: string | null
  property_name: string | null
}

export const getMyLease: AgentTool = {
  name: 'get_my_lease',
  description:
    'Look up the tenant’s own active lease details: monthly rent, the day rent is due, ' +
    'the lease start/end dates, the late-fee grace period, and the property/unit. Use this ' +
    'to answer questions about the tenant’s lease or rent terms.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const rows = await query<LeaseRow>(
      `SELECT l.id, l.status, l.rent_amount, l.rent_due_day, l.start_date, l.end_date,
              l.late_fee_grace_days, u.unit_number, p.name AS property_name
         FROM v_lease_active_tenants vlat
         JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE vlat.tenant_id = $1`,
      [actor.profileId]
    )

    if (rows.length === 0) return { ok: true, leases: [], note: 'No active lease on file for this tenant.' }

    return {
      ok: true,
      leases: rows.map((r) => ({
        property: r.property_name,
        unit: r.unit_number,
        status: r.status,
        monthlyRent: Number(r.rent_amount),
        rentDueDay: r.rent_due_day,
        lateFeeGraceDays: r.late_fee_grace_days,
        startDate: r.start_date,
        endDate: r.end_date,
      })),
    }
  },
}
