/**
 * Tool: bill_fee (landlord).
 *
 * Bills a one-off fee to a tenant on one of the landlord's OWN active leases,
 * reusing the same money-creating path as the Leases-page "Bill fee" button
 * (services/leaseFees.createLeaseFeePayment → a pending `fee` payments row the
 * tenant pays normally). Gated by the per-property `bill_fee` agent capability.
 * The landlord is the actor; the tool only bills, never collects.
 */
import { query } from '../../../db'
import { isAgentCapabilityEnabled } from '../../agentPermissions'
import { createLeaseFeePayment, type LeaseFeeType } from '../../leaseFees'
import type { AgentTool, AgentActor } from './types'

type Candidate = {
  lease_id: string
  landlord_id: string
  unit_id: string
  property_id: string
  unit_number: string | null
  property_name: string
  tenant_id: string | null
  tenant_name: string
}

const norm = (s: unknown) => (typeof s === 'string' && s.trim() ? s.trim().toLowerCase() : null)

export const billFee: AgentTool = {
  name: 'bill_fee',
  description:
    "Bill a one-off fee to a tenant on one of the landlord's active leases — e.g. a late fee, cleaning fee, " +
    'lease-violation, or early-termination fee. The fee is added to the tenant’s account as a PENDING charge they ' +
    'pay normally (you are billing it, not collecting it). Identify the tenant by name and/or unit/property; if more ' +
    'than one lease matches, ask which. Always include a clear description and the amount. Use fee_type ' +
    "'early_termination_fee' for an early-termination charge, otherwise 'other_fee'.",
  parameters: {
    type: 'object',
    properties: {
      amount: { type: 'number', description: 'Fee amount in dollars, e.g. 50.' },
      description: { type: 'string', description: 'What the fee is for — shown to the tenant (e.g. "Late fee — June rent", "Carpet cleaning").' },
      fee_type: { type: 'string', enum: ['early_termination_fee', 'other_fee'], description: "Defaults to 'other_fee'." },
      tenant_name: { type: 'string', description: 'Tenant name to match.' },
      unit: { type: 'string', description: 'Unit number to match.' },
      property: { type: 'string', description: 'Property name to match.' },
    },
    required: ['amount'],
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const amount = Number(args.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: 'A positive fee amount is required.' }
    }
    const feeType: LeaseFeeType = args.fee_type === 'early_termination_fee' ? 'early_termination_fee' : 'other_fee'

    const rows = await query<Candidate>(
      `SELECT l.id AS lease_id, l.landlord_id, l.unit_id, u.property_id, u.unit_number,
              p.name AS property_name, vlat.tenant_id,
              us.first_name || ' ' || us.last_name AS tenant_name
         FROM leases l
         JOIN units u       ON u.id = l.unit_id
         JOIN properties p  ON p.id = u.property_id
         JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id AND vlat.role = 'primary'
         JOIN tenants t     ON t.id = vlat.tenant_id
         JOIN users us      ON us.id = t.user_id
        WHERE l.landlord_id = $1 AND l.status = 'active'`,
      [actor.profileId]
    )

    const tn = norm(args.tenant_name), un = norm(args.unit), pn = norm(args.property)
    const cands = rows.filter(
      (r) =>
        (!tn || r.tenant_name.toLowerCase().includes(tn)) &&
        (!un || (r.unit_number ?? '').toLowerCase().includes(un)) &&
        (!pn || r.property_name.toLowerCase().includes(pn))
    )

    if (cands.length === 0) {
      return { ok: false, error: 'No matching active lease found on your account. Ask for the tenant name or unit.' }
    }
    if (cands.length > 1) {
      return {
        ok: false,
        error: 'multiple_matches',
        note: 'More than one active lease matches — ask which tenant or unit before billing.',
        candidates: cands.map((c) => ({ tenant: c.tenant_name, unit: c.unit_number, property: c.property_name })),
      }
    }

    const lease = cands[0]
    const allowed = await isAgentCapabilityEnabled(lease.property_id, 'bill_fee')
    if (!allowed) {
      return {
        ok: false,
        error: 'not_enabled',
        note: `Billing fees through the agent isn't enabled for ${lease.property_name}. You can turn it on for the agent, or bill the fee yourself from the Leases page.`,
      }
    }

    const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : undefined
    const res = await createLeaseFeePayment({
      landlordId: lease.landlord_id,
      tenantId: lease.tenant_id,
      leaseId: lease.lease_id,
      unitId: lease.unit_id,
      feeType,
      amount,
      description,
      source: 'agent',
    })
    return {
      ok: true,
      paymentId: res.paymentId,
      tenant: lease.tenant_name,
      unit: lease.unit_number,
      property: lease.property_name,
      amount,
      feeType,
      description: res.description,
      dueDate: res.dueDate,
      note: `Billed $${amount} (${res.description}) to ${lease.tenant_name}. It's now a pending charge on their account.`,
    }
  },
}
