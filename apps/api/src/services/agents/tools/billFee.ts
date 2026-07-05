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
import { createLeaseFeePayment } from '../../leaseFees'
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
    "Bill a fee authorized by the tenant's signed lease. Only fees that exist in the lease's own terms " +
    '(its landlord-billable fee list) can be billed — the amount comes from the lease, never from you or the ' +
    'landlord. The fee is added as a PENDING charge the tenant pays normally. Identify the tenant by name and/or ' +
    "unit/property; if more than one lease matches, ask which. If the lease authorizes multiple billable fees, " +
    'pass fee_type to pick one; the tool lists the options when ambiguous.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Optional note shown to the tenant (e.g. "Per § 7 — early termination").' },
      fee_type: { type: 'string', description: "Which of the lease's billable fees to bill (e.g. 'early_termination_fee'). Omit if the lease has exactly one." },
      tenant_name: { type: 'string', description: 'Tenant name to match.' },
      unit: { type: 'string', description: 'Unit number to match.' },
      property: { type: 'string', description: 'Property name to match.' },
    },
    required: [],
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {

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

    // W-30 (lease-is-law): only fees the SIGNED LEASE authorizes for
    // landlord-initiated billing (due_timing='other') can be billed, at the
    // lease's own amount — the agent never invents a fee or an amount.
    const billable = await query<{ id: string; fee_type: string; amount: string }>(
      `SELECT id, fee_type, amount FROM lease_fees
        WHERE lease_id = $1 AND due_timing = 'other'
        ORDER BY fee_type`,
      [lease.lease_id],
    )
    if (billable.length === 0) {
      return {
        ok: false,
        error: 'not_authorized_by_lease',
        note: `This tenant's lease has no landlord-billable fees in its terms — nothing can be billed that isn't in the signed lease.`,
      }
    }
    const wanted = norm(args.fee_type)
    const matched = wanted ? billable.filter((f) => f.fee_type.toLowerCase().includes(wanted)) : billable
    if (matched.length !== 1) {
      return {
        ok: false,
        error: 'ambiguous_fee',
        note: 'This lease authorizes more than one billable fee — ask which one.',
        options: billable.map((f) => ({ fee_type: f.fee_type, amount: Number(f.amount) })),
      }
    }
    const fee = matched[0]
    const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : undefined
    const res = await createLeaseFeePayment({
      landlordId: lease.landlord_id,
      tenantId: lease.tenant_id,
      leaseId: lease.lease_id,
      unitId: lease.unit_id,
      feeType: fee.fee_type,
      amount: Number(fee.amount),
      description,
      source: 'agent',
    })
    return {
      ok: true,
      paymentId: res.paymentId,
      tenant: lease.tenant_name,
      unit: lease.unit_number,
      property: lease.property_name,
      amount: Number(fee.amount),
      feeType: fee.fee_type,
      description: res.description,
      dueDate: res.dueDate,
      note: `Billed $${Number(fee.amount)} (${res.description}) to ${lease.tenant_name} — the amount comes from their lease terms. It's now a pending charge on their account.`,
    }
  },
}
