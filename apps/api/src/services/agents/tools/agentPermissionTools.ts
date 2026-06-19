/**
 * Landlord-facing tools to view and toggle the per-property agent revenue
 * permissions. Scoped to the landlord's OWN properties (landlord_id = actor
 * profileId). The agent never accepts a notice-to-vacate or changes lease terms,
 * so those are not capabilities here — only take_payment / lease_renewal / bill_fee.
 */
import { query } from '../../../db'
import { setAgentCapability, listAgentPermissions } from '../../agentPermissions'
import {
  AGENT_REVENUE_CAPABILITIES,
  AGENT_REVENUE_CAPABILITY_LABEL,
  type AgentRevenueCapability,
} from '@gam/shared'
import type { AgentTool, AgentActor } from './types'

type PropRow = { id: string; name: string }

/** The landlord's properties, optionally filtered by a name match. */
async function landlordProperties(landlordId: string, nameFilter?: string): Promise<PropRow[]> {
  const filtered = nameFilter && nameFilter.trim() && nameFilter.trim().toLowerCase() !== 'all'
  return query<PropRow>(
    `SELECT id, name FROM properties
      WHERE landlord_id = $1 ${filtered ? 'AND name ILIKE $2' : ''}
      ORDER BY name`,
    filtered ? [landlordId, `%${nameFilter!.trim()}%`] : [landlordId]
  )
}

export const setAgentPermission: AgentTool = {
  name: 'set_agent_permission',
  description:
    'Turn a revenue-affecting agent capability ON or OFF for one of the landlord’s properties (or all). ' +
    'Capabilities: take_payment (agent may take or retry a tenant payment / set up autopay), lease_renewal ' +
    '(agent may process a lease renewal), bill_fee (agent may bill a fee). All are OFF by default. Call this ' +
    'when the landlord asks to let the agent handle — or stop handling — payments, renewals, or fees at a ' +
    'property. The agent NEVER accepts a notice to vacate or changes lease terms; those are not capabilities.',
  parameters: {
    type: 'object',
    properties: {
      capability: { type: 'string', enum: [...AGENT_REVENUE_CAPABILITIES], description: 'Which capability to toggle.' },
      enabled: { type: 'boolean', description: 'true to enable, false to disable.' },
      property: { type: 'string', description: 'Property name to match, or "all" for every property. Omit = all.' },
    },
    required: ['capability', 'enabled'],
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const capability = String(args.capability ?? '') as AgentRevenueCapability
    if (!(AGENT_REVENUE_CAPABILITIES as readonly string[]).includes(capability)) {
      return { ok: false, error: `Unknown capability. Valid options: ${AGENT_REVENUE_CAPABILITIES.join(', ')}.` }
    }
    const enabled = args.enabled === true
    const props = await landlordProperties(actor.profileId, typeof args.property === 'string' ? args.property : undefined)
    if (props.length === 0) {
      return { ok: false, error: 'No matching property found on your account.' }
    }
    for (const p of props) await setAgentCapability(p.id, capability, enabled, actor.userId)
    return {
      ok: true,
      capability,
      label: AGENT_REVENUE_CAPABILITY_LABEL[capability],
      enabled,
      properties: props.map((p) => p.name),
      note: `${AGENT_REVENUE_CAPABILITY_LABEL[capability]} is now ${enabled ? 'ON' : 'OFF'} for ${props.length} ${props.length === 1 ? 'property' : 'properties'}.`,
    }
  },
}

export const getAgentPermissions: AgentTool = {
  name: 'get_agent_permissions',
  description:
    'Show which revenue-affecting agent capabilities (take_payment, lease_renewal, bill_fee) are currently ON ' +
    'or OFF for the landlord’s properties. Use when the landlord asks what the agent is allowed to do, or to ' +
    'confirm a change.',
  parameters: {
    type: 'object',
    properties: { property: { type: 'string', description: 'Optional property name to filter; omit for all.' } },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const props = await landlordProperties(actor.profileId, typeof args.property === 'string' ? args.property : undefined)
    if (props.length === 0) {
      return { ok: false, error: 'No matching property found on your account.' }
    }
    const out = []
    for (const p of props) out.push({ property: p.name, permissions: await listAgentPermissions(p.id) })
    return { ok: true, properties: out }
  },
}
