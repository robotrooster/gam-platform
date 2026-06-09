/**
 * Tool: get_tenant_contact (landlord read).
 *
 * Looks up how to reach one of the landlord's OWN tenants — phone, email,
 * and the unit(s) they're on — by name or email. Scoped to actor.profileId:
 * the tenant must be on a lease owned by this landlord, so a landlord can
 * never pull contact details for someone who isn't their tenant. Mirrors
 * the name-resolution + disambiguation of lookup_tenant_payment_status, but
 * answers "how do I reach them?" rather than "what do they owe?".
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface TenantMatch {
  tenant_id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
}

function fullName(m: { first_name: string | null; last_name: string | null }): string {
  return `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || 'Unnamed tenant'
}

export const getTenantContact: AgentTool = {
  name: 'get_tenant_contact',
  description:
    'Look up contact details (phone, email) and the unit(s) for one of the landlord’s OWN tenants, ' +
    'by name or email. Use for “what’s Jane Doe’s phone number?” or “how do I reach the tenant in ' +
    'unit 4?”. Only returns tenants on this landlord’s leases. Read-only.',
  parameters: {
    type: 'object',
    properties: { tenant: { type: 'string', description: 'The tenant’s name or email to look up.' } },
    required: ['tenant'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const needle = String(args.tenant ?? '').trim()
    if (needle.length < 2) return { ok: false, error: 'Provide at least part of the tenant’s name or email.' }

    // Distinct tenants on THIS landlord's leases matching the name/email.
    const matches = await query<TenantMatch>(
      `SELECT DISTINCT t.id AS tenant_id, us.first_name, us.last_name, us.email, us.phone
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.landlord_id = $1
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users us ON us.id = t.user_id
        WHERE us.email ILIKE $2 OR (COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,'')) ILIKE $2`,
      [actor.profileId, `%${needle}%`]
    )

    if (matches.length === 0) return { ok: false, error: `No tenant on your leases matches “${needle}”.` }
    if (matches.length > 1) {
      return {
        ok: false,
        needsDisambiguation: true,
        message: 'More than one of your tenants matches. Ask which one (by full name or email).',
        matches: matches.map((m) => ({ name: fullName(m), email: m.email })),
      }
    }

    const m = matches[0]
    // The unit(s) this tenant is on under this landlord, active first.
    const units = await query<{ unit_number: string | null; property_name: string | null; lease_status: string }>(
      `SELECT DISTINCT u.unit_number, p.name AS property_name, l.status AS lease_status
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.landlord_id = $1
         LEFT JOIN units u ON u.id = l.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
        WHERE lt.tenant_id = $2
        ORDER BY (l.status = 'active') DESC`,
      [actor.profileId, m.tenant_id]
    )

    return {
      ok: true,
      tenant: {
        name: fullName(m),
        email: m.email,
        phone: m.phone || null,
        units: units.map((u) => ({ unit: u.unit_number, property: u.property_name, leaseStatus: u.lease_status })),
      },
    }
  },
}
