/**
 * Tool: get_my_payment_methods (tenant). Reads whether the tenant has a
 * bank account / payment method set up. Hard-scoped to actor.userId
 * (user_bank_accounts.user_id). Returns ONLY the last 4 digits + status —
 * never the full/encrypted account number.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  nickname: string | null
  account_type: string | null
  account_number_last4: string | null
  status: string
}

export const getMyPaymentMethods: AgentTool = {
  name: 'get_my_payment_methods',
  description:
    'Check whether the tenant has a bank account / payment method connected (and its status). Use ' +
    'for “is my bank set up?” or “why can’t I pay?”. Returns only the last 4 digits, never full ' +
    'account numbers. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],
  async execute(_args, actor: AgentActor) {
    const rows = await query<Row>(
      // never select account_number_encrypted / routing_number — last4 only.
      `SELECT nickname, account_type, account_number_last4, status
         FROM user_bank_accounts WHERE user_id = $1
        ORDER BY created_at DESC`,
      [actor.userId]
    )
    return {
      ok: true,
      hasPaymentMethod: rows.length > 0,
      note: rows.length === 0 ? 'No bank account or payment method is connected yet.' : undefined,
      methods: rows.map((r) => ({ nickname: r.nickname, type: r.account_type, last4: r.account_number_last4, status: r.status })),
    }
  },
}
