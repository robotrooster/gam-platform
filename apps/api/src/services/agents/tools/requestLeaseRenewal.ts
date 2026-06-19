/**
 * Tool: request_lease_renewal (tenant).
 *
 * Captures a tenant's intent to renew and routes it to the landlord — the agent
 * does NOT renew or change the lease itself (the landlord sets the terms). Gated
 * by the per-property `lease_renewal` agent capability: if the landlord hasn't
 * enabled it for the property, the agent can't submit a renewal here.
 */
import { query } from '../../../db'
import { isAgentCapabilityEnabled } from '../../agentPermissions'
import { createNotification } from '../../notifications'
import type { AgentTool, AgentActor } from './types'

type ActiveLease = {
  lease_id: string
  landlord_id: string
  property_id: string
  unit_number: string | null
  property_name: string
  landlord_user_id: string
}

async function activeLeaseForTenant(tenantId: string): Promise<ActiveLease | null> {
  const rows = await query<ActiveLease>(
    `SELECT l.id AS lease_id, l.landlord_id, u.property_id, u.unit_number,
            p.name AS property_name, lo.user_id AS landlord_user_id
       FROM v_lease_active_tenants vlat
       JOIN leases l   ON l.id = vlat.lease_id AND l.status = 'active'
       JOIN units u    ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN landlords lo ON lo.id = l.landlord_id
      WHERE vlat.tenant_id = $1
      LIMIT 1`,
    [tenantId]
  )
  return rows[0] ?? null
}

export const requestLeaseRenewal: AgentTool = {
  name: 'request_lease_renewal',
  description:
    'Submit the tenant’s request to RENEW their lease. The request is recorded and sent to the landlord, who ' +
    'decides the renewal terms — you are NOT renewing or changing the lease yourself, only passing along that the ' +
    'tenant wants to renew. Call this when a tenant says they want to renew, stay, or extend. If they mention a ' +
    'preferred length (e.g. "12 months" or "month-to-month"), capture it.',
  parameters: {
    type: 'object',
    properties: {
      preferred_term: { type: 'string', description: 'Optional: the term the tenant prefers, e.g. "12 months" or "month-to-month".' },
      notes: { type: 'string', description: 'Optional: any extra detail from the tenant.' },
    },
  },
  audiences: ['tenant'],
  async execute(args, actor: AgentActor) {
    const lease = await activeLeaseForTenant(actor.profileId)
    if (!lease) {
      return { ok: false, error: 'No active lease found for this tenant, so a renewal request cannot be filed.' }
    }
    const allowed = await isAgentCapabilityEnabled(lease.property_id, 'lease_renewal')
    if (!allowed) {
      return {
        ok: false,
        error: 'not_enabled',
        note: `Renewals for ${lease.property_name} are handled by the landlord directly — you can't submit a renewal here. Let the tenant know the landlord handles renewals, and offer the landlord's contact if they want it.`,
      }
    }
    const existing = await query<{ id: string }>(
      `SELECT id FROM lease_renewal_requests WHERE lease_id = $1 AND status = 'requested' LIMIT 1`,
      [lease.lease_id]
    )
    if (existing[0]) {
      return { ok: true, alreadyRequested: true, note: 'A renewal request is already on file for this lease and is pending the landlord.' }
    }
    const preferredTerm = typeof args.preferred_term === 'string' ? args.preferred_term : null
    const ins = await query<{ id: string }>(
      `INSERT INTO lease_renewal_requests (lease_id, tenant_id, landlord_id, requested_by_user_id, preferred_term, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [lease.lease_id, actor.profileId, lease.landlord_id, actor.userId, preferredTerm, typeof args.notes === 'string' ? args.notes : null]
    )
    await createNotification({
      userId: lease.landlord_user_id,
      landlordId: lease.landlord_id,
      type: 'lease_renewal_request',
      title: 'Tenant requested a lease renewal',
      body: `A tenant in ${lease.property_name}${lease.unit_number ? ` (unit ${lease.unit_number})` : ''} asked to renew their lease${preferredTerm ? ` — preferred term: ${preferredTerm}` : ''}.`,
      data: { leaseId: lease.lease_id, renewalRequestId: ins[0]?.id },
    }).catch(() => { /* best-effort */ })
    return {
      ok: true,
      requestId: ins[0]?.id,
      property: lease.property_name,
      unit: lease.unit_number,
      preferredTerm,
      note: 'Renewal request submitted to the landlord. They set the terms and will follow up.',
    }
  },
}
