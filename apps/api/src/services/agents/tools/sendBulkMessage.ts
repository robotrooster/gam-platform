/**
 * Tool: send_bulk_message (landlord ACTION).
 *
 * Sends a message to ALL of the landlord's active tenants (optionally
 * scoped to one property), delivered as an in-app notification to each
 * tenant. Hard-scoped: recipients are resolved ONLY from leases owned by
 * actor.profileId, so a landlord can only ever message their own tenants.
 *
 * Two-step by design: called WITHOUT confirmed=true it returns the reach
 * count and sends nothing, so the agent can tell the landlord "this will
 * go to N tenants — confirm?". Called with confirmed=true it sends. (No
 * mass email — in-app notification only.)
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

const TYPE = 'landlord_message'
const TITLE = 'Message from your landlord'

/** Build the recipient subquery (active tenants of this landlord, optional
 *  property filter). Returns [sql, params] with the landlord id as $1. */
function recipientSource(landlordId: string, propertyName?: string): { from: string; params: any[] } {
  const params: any[] = [landlordId]
  let from =
    `FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id AND l.landlord_id = $1 AND l.status = 'active'
       JOIN tenants t ON t.id = lt.tenant_id`
  if (propertyName && propertyName.trim()) {
    params.push(`%${propertyName.trim()}%`)
    from +=
      `\n       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id AND p.name ILIKE $${params.length}`
  }
  return { from, params }
}

export const sendBulkMessage: AgentTool = {
  name: 'send_bulk_message',
  description:
    'Send a message to ALL of the landlord’s active tenants (optionally limited to one property). ' +
    'ALWAYS call it first WITHOUT confirmed to get the recipient count, tell the landlord how many ' +
    'tenants it will reach and show them the wording, and only call again with confirmed=true after ' +
    'they say yes. Goes to each tenant’s in-app notifications. Only reaches the landlord’s own tenants.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message body to send to tenants.' },
      propertyName: { type: 'string', description: 'Optional — limit to tenants at this property (by name). Omit to message all tenants.' },
      confirmed: { type: 'boolean', description: 'Set true only after the landlord has confirmed the wording and recipients.' },
    },
    required: ['message'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const message = String(args.message ?? '').trim()
    if (message.length < 2) return { ok: false, error: 'A message is required.' }
    const propertyName = typeof args.propertyName === 'string' ? args.propertyName : undefined
    const scope = propertyName ? `tenants at "${propertyName}"` : 'all your active tenants'

    const src = recipientSource(actor.profileId, propertyName)

    // Preview step: count recipients, send nothing.
    if (args.confirmed !== true) {
      const rows = await query<{ n: string }>(`SELECT COUNT(DISTINCT t.user_id) AS n ${src.from}`, src.params)
      const recipientCount = Number(rows[0]?.n ?? 0)
      if (recipientCount === 0) return { ok: false, error: `No active tenants found for ${scope}.` }
      return {
        ok: false,
        needsConfirmation: true,
        recipientCount,
        scope,
        message: `This will be sent to ${recipientCount} tenant${recipientCount === 1 ? '' : 's'} (${scope}). Confirm the wording with the landlord, then call again with confirmed=true.`,
      }
    }

    // Send: one in-app notification per unique recipient (no mass email).
    const inserted = await query<{ id: string }>(
      `INSERT INTO notifications (user_id, landlord_id, type, title, body)
       SELECT DISTINCT t.user_id, $1, '${TYPE}', $${src.params.length + 1}, $${src.params.length + 2}
       ${src.from}
       RETURNING id`,
      [...src.params, TITLE, message]
    )
    return { ok: true, sent: inserted.length, scope, message: `Your message was sent to ${inserted.length} tenant${inserted.length === 1 ? '' : 's'}.` }
  },
}
