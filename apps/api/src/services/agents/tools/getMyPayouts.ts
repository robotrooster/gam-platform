/**
 * Tool: get_my_payouts (landlord). Reads the landlord's OWN payout history.
 * Hard-scoped to actor.profileId (disbursements.landlord_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  amount: string
  status: string
  unit_count: number | null
  target_date: string | null
  settled_at: string | null
  trigger_type: string | null
}

export const getMyPayouts: AgentTool = {
  name: 'get_my_payouts',
  description:
    'List the landlord’s recent payouts — amount, status (pending/settled), date, and how many ' +
    'units it covered. Use for “when’s my next payout?”, “what was my last payout?”, or “did my ' +
    'payout go through?”. Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many recent payouts (default 10, max 30).' } } },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 30) : 10
    const rows = await query<Row>(
      `SELECT amount, status, unit_count, target_date, settled_at, trigger_type
         FROM disbursements WHERE landlord_id = $1
        ORDER BY COALESCE(settled_at, target_date, created_at) DESC LIMIT $2`,
      [actor.profileId, limit]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No payouts on record yet.' : undefined,
      payouts: rows.map((r) => ({
        amount: Number(r.amount), status: r.status, unitCount: r.unit_count,
        targetDate: r.target_date, settledAt: r.settled_at, trigger: r.trigger_type,
      })),
    }
  },
}
