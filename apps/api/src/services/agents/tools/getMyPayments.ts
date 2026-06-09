/**
 * Tool: get_my_payment_status (tenant).
 *
 * Reads the logged-in tenant's OWN recent payments and computes their
 * outstanding balance (anything not yet settled). Hard-scoped to
 * actor.profileId (payments.tenant_id) — no other tenant's records.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface PaymentRow {
  type: string
  amount: string
  status: string
  due_date: string | null
  processed_at: string | null
}

// Not-yet-settled statuses count toward what the tenant still owes.
const OUTSTANDING_STATUSES = ['pending', 'processing', 'failed', 'returned']

export const getMyPayments: AgentTool = {
  name: 'get_my_payment_status',
  description:
    'Look up the tenant’s own recent payments and current outstanding balance (rent, fees, ' +
    'utilities). Use this for questions like “did my rent go through?”, “what do I owe?”, or ' +
    '“when was my last payment?”. Read-only — it cannot move money or take a payment.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many recent payments to return (default 8, max 20).' },
    },
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20) : 8

    const rows = await query<PaymentRow>(
      `SELECT type, amount, status, due_date, processed_at
         FROM payments
        WHERE tenant_id = $1
        ORDER BY COALESCE(due_date, created_at) DESC
        LIMIT $2`,
      [actor.profileId, limit]
    )

    const owed = await query<{ outstanding: string | null; count: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS outstanding, COUNT(*) AS count
         FROM payments
        WHERE tenant_id = $1 AND status = ANY($2)`,
      [actor.profileId, OUTSTANDING_STATUSES]
    )

    return {
      ok: true,
      outstandingBalance: Number(owed[0]?.outstanding ?? 0),
      outstandingItemCount: Number(owed[0]?.count ?? 0),
      // Explicit empty signal so the model states the truth ("no payments
      // on record yet") instead of inventing that a past payment cleared.
      note: rows.length === 0 ? 'No payments are on record for this tenant yet.' : undefined,
      recentPayments: rows.map((r) => ({
        type: r.type,
        amount: Number(r.amount),
        status: r.status,
        dueDate: r.due_date,
        processedAt: r.processed_at,
      })),
    }
  },
}
