/**
 * Per-property agent revenue permissions (the gate behind revenue-affecting
 * agent actions). A capability is enabled for a property ONLY when the landlord
 * has explicitly turned it on — absence of a row, or enabled=false, means OFF.
 *
 * Capability set is the single-source `AGENT_REVENUE_CAPABILITIES` in
 * packages/shared (mirrored by the property_agent_permissions CHECK).
 */
import { query } from '../db'
import { AGENT_REVENUE_CAPABILITIES, type AgentRevenueCapability } from '@gam/shared'

/** True ONLY when the landlord has explicitly enabled `capability` for `propertyId`. Default off. */
export async function isAgentCapabilityEnabled(
  propertyId: string | null | undefined,
  capability: AgentRevenueCapability
): Promise<boolean> {
  if (!propertyId) return false
  const rows = await query<{ enabled: boolean }>(
    `SELECT enabled FROM property_agent_permissions WHERE property_id = $1 AND capability = $2`,
    [propertyId, capability]
  )
  return rows[0]?.enabled === true
}

/** Upsert a capability toggle for a property. Returns the resulting state. */
export async function setAgentCapability(
  propertyId: string,
  capability: AgentRevenueCapability,
  enabled: boolean,
  updatedBy?: string | null
): Promise<boolean> {
  const rows = await query<{ enabled: boolean }>(
    `INSERT INTO property_agent_permissions (property_id, capability, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (property_id, capability)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING enabled`,
    [propertyId, capability, enabled, updatedBy ?? null]
  )
  return rows[0]?.enabled === true
}

/** Full capability map for a property — every capability, defaulting to false. */
export async function listAgentPermissions(
  propertyId: string
): Promise<Record<AgentRevenueCapability, boolean>> {
  const rows = await query<{ capability: AgentRevenueCapability; enabled: boolean }>(
    `SELECT capability, enabled FROM property_agent_permissions WHERE property_id = $1`,
    [propertyId]
  )
  const map = Object.fromEntries(
    AGENT_REVENUE_CAPABILITIES.map((c) => [c, false])
  ) as Record<AgentRevenueCapability, boolean>
  for (const r of rows) if (r.capability in map) map[r.capability] = r.enabled === true
  return map
}
