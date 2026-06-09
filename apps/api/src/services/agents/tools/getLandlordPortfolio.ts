/**
 * Tool: get_landlord_portfolio (landlord).
 *
 * Reads the logged-in landlord's OWN portfolio: occupancy across their
 * properties/units and their recent payouts. Hard-scoped to
 * actor.profileId (landlord_id) — no other landlord's data.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface OccupancyRow {
  property_count: number
  total_units: number
  occupied_units: number
  vacant_units: number
}

interface PayoutRow {
  amount: string
  status: string
  unit_count: number | null
  target_date: string | null
  settled_at: string | null
}

export const getLandlordPortfolio: AgentTool = {
  name: 'get_landlord_portfolio',
  description:
    'Look up the landlord’s own portfolio: how many properties and units they have, how many ' +
    'are occupied vs vacant, and their most recent payouts. Use this for questions about ' +
    'occupancy, vacancy, or “when/what was my last payout?”. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      payoutLimit: { type: 'integer', description: 'How many recent payouts to return (default 5, max 12).' },
    },
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.payoutLimit)
    const payoutLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 12) : 5

    const occ = await query<OccupancyRow>(
      // units.status has six values; occupied = a live tenancy in any of
      // its forms, vacant = no tenant. (active/direct_pay/delinquent/
      // suspended are occupied; vacant/available are not.)
      `SELECT COUNT(DISTINCT p.id)::int AS property_count,
              COUNT(u.id)::int AS total_units,
              COUNT(u.id) FILTER (WHERE u.status IN ('active','direct_pay','delinquent','suspended'))::int AS occupied_units,
              COUNT(u.id) FILTER (WHERE u.status IN ('vacant','available'))::int AS vacant_units
         FROM properties p
         LEFT JOIN units u ON u.property_id = p.id
        WHERE p.landlord_id = $1`,
      [actor.profileId]
    )

    const payouts = await query<PayoutRow>(
      `SELECT amount, status, unit_count, target_date, settled_at
         FROM disbursements
        WHERE landlord_id = $1
        ORDER BY COALESCE(settled_at, target_date, created_at) DESC
        LIMIT $2`,
      [actor.profileId, payoutLimit]
    )

    const o = occ[0]
    return {
      ok: true,
      portfolio: {
        properties: o?.property_count ?? 0,
        totalUnits: o?.total_units ?? 0,
        occupiedUnits: o?.occupied_units ?? 0,
        vacantUnits: o?.vacant_units ?? 0,
      },
      recentPayouts: payouts.map((p) => ({
        amount: Number(p.amount),
        status: p.status,
        unitCount: p.unit_count,
        targetDate: p.target_date,
        settledAt: p.settled_at,
      })),
    }
  },
}
