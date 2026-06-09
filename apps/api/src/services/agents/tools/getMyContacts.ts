/**
 * Tool: get_my_contacts (tenant read).
 *
 * Surfaces who the tenant should contact about their rental — the landlord
 * (or their business) on the tenant's OWN active lease. Hard-scoped to
 * actor.profileId via v_lease_active_tenants, so a tenant only ever sees the
 * contact for a lease they're actually on. Per Nic (S442): the lease
 * relationship carries the landlord / representative contact, so we surface
 * it here rather than asking the tenant to dig for it.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface ContactRow {
  property_name: string | null
  unit_number: string | null
  business_name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  pm_company_id: string | null
}

export const getMyContacts: AgentTool = {
  name: 'get_my_contacts',
  description:
    'Look up who the tenant should contact about their rental — the landlord (or their business) ' +
    'on the tenant’s own lease, with email and phone. Use for “who’s my landlord?”, “how do I reach ' +
    'my property manager?”, or “who do I contact about my unit?”. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const rows = await query<ContactRow>(
      `SELECT DISTINCT p.name AS property_name, u.unit_number,
              ld.business_name, lu.first_name, lu.last_name, lu.email, lu.phone,
              p.pm_company_id
         FROM v_lease_active_tenants vlat
         JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
         JOIN landlords ld ON ld.id = l.landlord_id
         JOIN users lu ON lu.id = ld.user_id
        WHERE vlat.tenant_id = $1`,
      [actor.profileId]
    )

    if (rows.length === 0) {
      return { ok: true, contacts: [], note: 'No active lease on file, so there’s no contact to look up. Reach GAM support if you need help.' }
    }

    return {
      ok: true,
      contacts: rows.map((r) => ({
        property: r.property_name,
        unit: r.unit_number,
        contactName: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
        businessName: r.business_name || null,
        email: r.email || null,
        phone: r.phone || null,
        // A managed property has a third-party PM company representing the
        // landlord; flag it so the tenant knows day-to-day contact may route
        // through the management company.
        managedByCompany: !!r.pm_company_id,
      })),
    }
  },
}
