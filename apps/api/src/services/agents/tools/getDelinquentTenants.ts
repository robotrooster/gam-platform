/**
 * Tool: get_delinquent_tenants (landlord). Lists the landlord's OWN tenants
 * with past-due unpaid rent/fees. Hard-scoped to actor.profileId
 * (payments.landlord_id) — only this landlord's receivables.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  first_name: string | null
  last_name: string | null
  email: string | null
  overdue: string
  items: string
  oldest_due: string | null
}

// Unpaid + past due = behind.
const UNPAID = ['pending', 'processing', 'failed', 'returned']

export const getDelinquentTenants: AgentTool = {
  name: 'get_delinquent_tenants',
  description:
    'List the landlord’s tenants who are behind on rent — past-due, unpaid charges — with the ' +
    'amount overdue and how long. Use for “who’s behind on rent?” or “who owes me money?”. ' +
    'Read-only; scoped to this landlord’s own tenants.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many tenants (default 25, max 100).' } } },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 25
    const rows = await query<Row>(
      `SELECT us.first_name, us.last_name, us.email,
              SUM(p.amount) AS overdue, COUNT(*) AS items, MIN(p.due_date) AS oldest_due
         FROM payments p
         JOIN tenants t ON t.id = p.tenant_id
         JOIN users us ON us.id = t.user_id
        WHERE p.landlord_id = $1 AND p.status = ANY($2) AND p.due_date < now()
        GROUP BY us.first_name, us.last_name, us.email
        ORDER BY overdue DESC
        LIMIT $3`,
      [actor.profileId, UNPAID, limit]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No tenants are currently past due. ' : undefined,
      delinquentTenants: rows.map((r) => ({
        name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), email: r.email,
        amountOverdue: Number(r.overdue), pastDueItems: Number(r.items), oldestDueDate: r.oldest_due,
      })),
    }
  },
}
