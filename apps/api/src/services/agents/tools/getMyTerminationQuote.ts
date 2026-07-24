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
    'Get the tenant’s early-termination quote for their active lease — the fee they would pay to end the lease ' +
    'early, plus the status of any termination request already in flight. READ ONLY: you cannot terminate a ' +
    'lease; if they want to proceed, tell them the Lease section of their portal has the confirmation flow and ' +
    'that the fee is charged when they confirm there.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const leases = await query<{ id: string }>(
      `SELECT l.id
         FROM v_lease_active_tenants vlat
         JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        WHERE vlat.tenant_id = $1`,
      [actor.profileId]
    )
    if (leases.length === 0) {
      return { ok: true, quote: null, note: 'No active lease on file — nothing to quote.' }
    }
    const leaseId = leases[0].id
    const quote = await quoteFee(leaseId)
    const existing = await getActiveOrLatestRequest(leaseId)
    return {
      ok: true,
      leaseId,
      quote,
      existingRequest: existing ?? null,
      note:
        'Read-only quote. To actually end the lease early, the tenant confirms in the Lease section of their ' +
        'portal — the fee is charged at confirmation. The landlord can also waive the fee on their side.',
    }
  },
}
