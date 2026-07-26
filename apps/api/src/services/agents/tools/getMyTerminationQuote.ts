/**
 * Tool: get_my_termination_quote (tenant READ).
 *
 * S552: answers "what would it cost me to leave early?" with the tenant's
 * real early-termination quote for their active lease — same service the
 * portal's quote button calls (services/leaseTermination.quoteFee). READ
 * ONLY: actually terminating is a portal action the agent never performs
 * (lease lifecycle = hard-stop territory); the tool's note says where to
 * do it and that the fee auto-charges on confirmation.
 */

import { query } from '../../../db'
import { quoteFee, getActiveOrLatestRequest } from '../../leaseTermination'
import type { AgentTool, AgentActor } from './types'

export const getMyTerminationQuote: AgentTool = {
  name: 'get_my_termination_quote',
  description:
    'Get the tenant’s early-termination quote for their active lease(s) — the fee they would pay to end the ' +
    'lease early, plus the status of any termination request already in flight. If the tenant holds more than ' +
    'one active lease (e.g. two units), a quote is returned for EACH. READ ONLY: you cannot terminate a ' +
    'lease; if they want to proceed, tell them the Lease section of their portal has the confirmation flow and ' +
    'that the fee is charged when they confirm there.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    // S554 (Oak Park): a tenant can hold >1 active lease (e.g. space rent on
    // two mobile homes). Quote EVERY active lease rather than silently picking
    // the first — the prior leases[0] hid the other lease's fee entirely.
    const leases = await query<{ id: string; unit_number: string | null; property_name: string | null }>(
      `SELECT l.id, u.unit_number, p.name AS property_name
         FROM v_lease_active_tenants vlat
         JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE vlat.tenant_id = $1
        ORDER BY l.created_at`,
      [actor.profileId]
    )
    if (leases.length === 0) {
      return { ok: true, quote: null, note: 'No active lease on file — nothing to quote.' }
    }

    const quotes = []
    for (const l of leases) {
      const quote = await quoteFee(l.id)
      const existing = await getActiveOrLatestRequest(l.id)
      quotes.push({
        leaseId: l.id,
        unit: `${l.property_name ?? 'Property'}${l.unit_number ? ` — Unit ${l.unit_number}` : ''}`,
        quote,
        existingRequest: existing ?? null,
      })
    }

    const note =
      'Read-only quote. To actually end a lease early, the tenant confirms in the Lease section of their ' +
      'portal — the fee is charged at confirmation. The landlord can also waive the fee on their side.'

    // Single lease: keep the flat shape (back-compat with existing callers/evals).
    if (quotes.length === 1) {
      return { ok: true, leaseId: quotes[0].leaseId, quote: quotes[0].quote, existingRequest: quotes[0].existingRequest, note }
    }
    return {
      ok: true,
      multipleLeases: true,
      quotes,
      note: `This tenant has ${quotes.length} active leases; a quote is shown for each. ${note}`,
    }
  },
}
