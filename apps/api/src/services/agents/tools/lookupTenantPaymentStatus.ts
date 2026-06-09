/**
 * Tool: lookup_tenant_payment_status (landlord).
 *
 * Lets a landlord check the payment status of one of THEIR OWN tenants by
 * name or email. Doubly scoped to actor.profileId (the landlord id):
 *   1. the tenant must be on a lease owned by this landlord, AND
 *   2. the payments summed are only those tied to this landlord.
 * A landlord can never see a tenant who isn't theirs, nor another
 * landlord's payments for a shared tenant.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface TenantMatch {
  tenant_id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

const OUTSTANDING_STATUSES = ['pending', 'processing', 'failed', 'returned']

export const lookupTenantPaymentStatus: AgentTool = {
  name: 'lookup_tenant_payment_status',
  description:
    'Look up the payment status (current balance owed + recent payments) of one of the landlord’s ' +
    'OWN tenants, by name or email. Use for “is Jane Doe paid up?” or “what does the tenant in unit ' +
    '4 owe me?”. Only returns tenants on this landlord’s leases. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      tenant: { type: 'string', description: 'The tenant’s name or email to look up.' },
    },
    required: ['tenant'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const needle = String(args.tenant ?? '').trim()
    if (needle.length < 2) return { ok: false, error: 'Provide at least part of the tenant’s name or email.' }

    // Tenants on THIS landlord's leases matching the name/email.
    const matches = await query<TenantMatch>(
      `SELECT DISTINCT t.id AS tenant_id, us.first_name, us.last_name, us.email
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.landlord_id = $1
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users us ON us.id = t.user_id
        WHERE us.email ILIKE $2 OR (COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,'')) ILIKE $2`,
      [actor.profileId, `%${needle}%`]
    )

    if (matches.length === 0) {
      return { ok: false, error: `No tenant on your leases matches “${needle}”.` }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        needsDisambiguation: true,
        message: 'More than one of your tenants matches. Ask which one (by full name or email).',
        matches: matches.map((m) => ({ name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(), email: m.email })),
      }
    }

    const m = matches[0]
    // Payments are scoped to BOTH the tenant AND this landlord.
    const owed = await query<{ outstanding: string | null; count: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS outstanding, COUNT(*) AS count
         FROM payments
        WHERE tenant_id = $1 AND landlord_id = $2 AND status = ANY($3)`,
      [m.tenant_id, actor.profileId, OUTSTANDING_STATUSES]
    )
    const recent = await query<{ type: string; amount: string; status: string; due_date: string | null }>(
      `SELECT type, amount, status, due_date
         FROM payments
        WHERE tenant_id = $1 AND landlord_id = $2
        ORDER BY COALESCE(due_date, created_at) DESC
        LIMIT 5`,
      [m.tenant_id, actor.profileId]
    )

    return {
      ok: true,
      tenant: { name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(), email: m.email },
      outstandingBalance: Number(owed[0]?.outstanding ?? 0),
      outstandingItemCount: Number(owed[0]?.count ?? 0),
      recentPayments: recent.map((r) => ({ type: r.type, amount: Number(r.amount), status: r.status, dueDate: r.due_date })),
    }
  },
}
