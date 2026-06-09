/**
 * Tool: get_my_deposit (tenant). Reads the tenant's OWN security deposit
 * (amount, how much collected, held/returned status) and, if the lease has
 * ended, their deposit-return summary. Hard-scoped to actor.profileId
 * (tenant_id). Deliberately selects ONLY basic fields — never the
 * FlexDeposit / interest / advance columns (legally sensitive).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface DepositRow {
  total_amount: string | null
  collected_amount: string | null
  status: string
  damage_claimed: boolean | null
  disbursed_to_landlord: boolean | null
  held_by: string | null
}
interface ReturnRow {
  refund_amount: string | null
  total_deductions: string | null
  return_status: string
  finalized_at: string | null
}

export const getMyDeposit: AgentTool = {
  name: 'get_my_deposit',
  description:
    'Look up the tenant’s own security deposit — the amount, how much has been collected, whether ' +
    'it’s being held or has been returned, and (at move-out) the return/deductions summary. Use ' +
    'for “how much is my deposit?” or “when do I get my deposit back?”. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],
  async execute(_args, actor: AgentActor) {
    const deposits = await query<DepositRow>(
      `SELECT total_amount, collected_amount, status, damage_claimed, disbursed_to_landlord, held_by
         FROM security_deposits WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [actor.profileId]
    )
    if (deposits.length === 0) {
      return { ok: true, hasDeposit: false, note: 'No security deposit is on record for this tenant.' }
    }
    const d = deposits[0]
    const ret = await query<ReturnRow>(
      `SELECT refund_amount, total_deductions, status AS return_status, finalized_at
         FROM deposit_returns WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [actor.profileId]
    )
    return {
      ok: true,
      hasDeposit: true,
      deposit: {
        totalAmount: d.total_amount != null ? Number(d.total_amount) : null,
        collectedAmount: d.collected_amount != null ? Number(d.collected_amount) : null,
        status: d.status,
        damageClaimed: d.damage_claimed,
        disbursedToLandlord: d.disbursed_to_landlord,
        heldBy: d.held_by,
      },
      depositReturn: ret[0]
        ? {
            status: ret[0].return_status,
            refundAmount: ret[0].refund_amount != null ? Number(ret[0].refund_amount) : null,
            totalDeductions: ret[0].total_deductions != null ? Number(ret[0].total_deductions) : null,
            finalizedAt: ret[0].finalized_at,
          }
        : undefined,
    }
  },
}
