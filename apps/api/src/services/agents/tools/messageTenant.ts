/**
 * Tool: message_tenant (landlord ACTION).
 *
 * Sends a message to one of the landlord's OWN tenants. GAM has no 1:1
 * messaging surface, so the message is delivered as a notification in the
 * tenant's account (the real channel). Hard-scoped: the tenant must be on a
 * lease owned by actor.profileId — a landlord can only message their own
 * tenants. Disambiguates multiple matches.
 */

import { query } from '../../../db'
import { createNotification } from '../../notifications'
import type { AgentTool, AgentActor } from './types'

interface TenantMatch { user_id: string; first_name: string | null; last_name: string | null; email: string | null }

export const messageTenant: AgentTool = {
  name: 'message_tenant',
  description:
    'Send a message to one of the landlord’s own tenants (by name or email). The tenant receives it ' +
    'as a notification in their account. Use for “let my tenant in unit 4 know the plumber is coming ' +
    'Tuesday”. Confirm the recipient and wording with the landlord before sending. Only the ' +
    'landlord’s own tenants can be messaged.',
  parameters: {
    type: 'object',
    properties: {
      tenant: { type: 'string', description: 'The tenant’s name or email.' },
      message: { type: 'string', description: 'The message to send to the tenant.' },
    },
    required: ['tenant', 'message'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const needle = String(args.tenant ?? '').trim()
    const message = String(args.message ?? '').trim()
    if (needle.length < 2) return { ok: false, error: 'Provide at least part of the tenant’s name or email.' }
    if (message.length < 2) return { ok: false, error: 'A message is required.' }

    // Tenants on THIS landlord's leases matching the name/email.
    const matches = await query<TenantMatch>(
      `SELECT DISTINCT t.user_id, us.first_name, us.last_name, us.email
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
        matches: matches.map((m) => ({ name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(), email: m.email })),
      }
    }

    const m = matches[0]
    await createNotification({
      userId: m.user_id,
      landlordId: actor.profileId,
      type: 'landlord_message',
      title: 'Message from your landlord',
      body: message,
    })
    return { ok: true, sentTo: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(), message: 'Your message was delivered to the tenant.' }
  },
}
