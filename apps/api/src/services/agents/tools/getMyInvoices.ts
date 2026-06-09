/**
 * Tool: get_my_invoices (tenant). Reads the tenant's OWN invoices. Hard-
 * scoped to actor.profileId (invoices.tenant_id).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  invoice_number: string | null
  due_date: string | null
  total_amount: string | null
  status: string
  sent_at: string | null
}

export const getMyInvoices: AgentTool = {
  name: 'get_my_invoices',
  description:
    'List the tenant’s own invoices — number, due date, total, and status (paid/unpaid/overdue). ' +
    'Use for “what’s my latest bill?”, “what invoices do I have?”, or “what’s due?”. Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many recent invoices (default 10, max 25).' } } },
  audiences: ['tenant'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 25) : 10
    const rows = await query<Row>(
      `SELECT invoice_number, due_date, total_amount, status, sent_at
         FROM invoices WHERE tenant_id = $1
        ORDER BY COALESCE(due_date, created_at) DESC LIMIT $2`,
      [actor.profileId, limit]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No invoices on record for this tenant.' : undefined,
      invoices: rows.map((r) => ({
        invoiceNumber: r.invoice_number, dueDate: r.due_date,
        total: r.total_amount != null ? Number(r.total_amount) : null, status: r.status, sentAt: r.sent_at,
      })),
    }
  },
}
