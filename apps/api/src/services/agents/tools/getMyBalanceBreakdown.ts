/**
 * Tool: get_my_balance_breakdown (tenant READ).
 *
 * S552: answers "where did my payment go?" and "what exactly do I owe?"
 * with the FIFO application detail — open charges oldest-first (the order
 * payments apply, S537) plus the tenant's recent remittances with their
 * per-line application (which charge each dollar landed on, and any
 * pay-ahead credit). Mirrors GET /payments/balance-context and
 * GET /payments/remittances, read-only.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

export const getMyBalanceBreakdown: AgentTool = {
  name: 'get_my_balance_breakdown',
  description:
    'The tenant’s open charges OLDEST-FIRST (the order payments are applied — oldest balances are always paid ' +
    'first) and their recent payments with a per-dollar breakdown of which charge each payment covered, ' +
    'including any pay-ahead credit. Use for “where did my payment go?”, “why am I still marked late?”, or a ' +
    'detailed “what do I owe?”. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const openCharges = await query<any>(
      `SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type,
              p.entry_description, p.status
         FROM payments p
        -- S626: 'returned' was MISSING, and it is a live status —
        -- paymentReversal.ts sets it with the bank's return code when an ACH
        -- comes back. A tenant whose payment bounced had it drop out of their
        -- own balance as though it were paid: they are told they owe LESS than
        -- they do, believe they are square, and find out when the late fee
        -- lands. 'processing' stays OUT on purpose — the money has left their
        -- account, so from the tenant's side it is paid (S620).
        WHERE p.tenant_id = $1 AND p.status IN ('pending', 'failed', 'returned')
        ORDER BY p.due_date ASC, p.created_at ASC
        LIMIT 40`,
      [actor.profileId]
    )
    const remits = await query<any>(
      `SELECT id, amount::float AS amount,
              applied_amount::float AS applied_amount,
              unapplied_amount::float AS unapplied_amount,
              status, payment_method, created_at
         FROM tenant_remittances
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 5`,
      [actor.profileId]
    )
    let lines: any[] = []
    if (remits.length > 0) {
      lines = await query<any>(
        `SELECT ra.remittance_id, ra.amount_applied::float AS amount_applied,
                p.type, p.due_date::text AS due_date, p.entry_description
           FROM remittance_applications ra
           JOIN payments p ON p.id = ra.payment_id
          WHERE ra.remittance_id = ANY($1)
          ORDER BY p.due_date ASC`,
        [remits.map((r) => r.id)]
      ).catch(() => [])
    }
    const totalOwed = Math.round(openCharges.reduce((s, c) => s + c.amount, 0) * 100) / 100
    return {
      ok: true,
      totalOwed,
      openChargesOldestFirst: openCharges,
      recentPayments: remits.map((r) => ({
        ...r,
        appliedTo: lines.filter((l) => l.remittance_id === r.id),
      })),
      note:
        'Payments always apply to the OLDEST open charge first (never chosen per charge), so a payment can ' +
        'settle an old balance while a newer charge stays open. Unapplied remainder is pay-ahead credit toward ' +
        'the next charge.',
    }
  },
}
