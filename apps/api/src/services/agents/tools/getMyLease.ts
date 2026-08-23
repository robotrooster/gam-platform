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
  late_fee_initial_amount: string | null
  late_fee_initial_type: string | null
  late_fee_enabled: boolean | null
  unit_number: string | null
  property_name: string | null
}

export const getMyLease: AgentTool = {
  name: 'get_my_lease',
  description:
    'Look up the tenant’s own active lease details: monthly rent, the day rent is due, ' +
    'the lease start/end dates, the late-fee grace period AND THE LATE FEE ITSELF, and the ' +
    'property/unit. Use this to answer questions about the tenant’s lease or rent terms — ' +
    'including general-sounding ones like "how do late fees work", which mean THEIR lease: ' +
    'these terms are set per property and vary with state and local law.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const rows = await query<LeaseRow>(
      `SELECT l.id, l.status, l.rent_amount, l.rent_due_day, l.start_date, l.end_date,
              l.late_fee_grace_days, l.late_fee_initial_amount, l.late_fee_initial_type,
              l.late_fee_enabled, u.unit_number, p.name AS property_name
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
        // S617: the AMOUNT, not just the grace period. Asked "how do late fees
        // work?", the agent could only say "check your lease for the exact
        // amount" — because the tool never returned it. That is not a prompt
        // problem; the number was not there to give. This lease: $15 flat after
        // 5 days. Percentage leases report the percent and what it applies to.
        lateFeeEnabled: r.late_fee_enabled !== false,
        lateFee: r.late_fee_initial_amount == null ? null : {
          amount: Number(r.late_fee_initial_amount),
          type: r.late_fee_initial_type,        // 'flat' | 'percent'
          // S617: spelled out because the model got it wrong. Given
          // "a flat charge, applied once", it told a tenant "$15 flat late fee
          // PER DAY" — a real misstatement about money, on a lease that charges
          // it once. Ambiguity in a tool result becomes invention downstream.
          chargedOncePerLateRent: true,
          isDaily: false,
          describes: r.late_fee_initial_type === 'percent'
            ? `${Number(r.late_fee_initial_amount)}% of the monthly rent, charged ONE TIME when rent goes late — it is NOT charged per day and does not accrue`
            : `$${Number(r.late_fee_initial_amount)} charged ONE TIME when rent goes late — it is NOT per day and does not accrue`,
        },
        startDate: r.start_date,
        endDate: r.end_date,
      })),
    }
  },
}
