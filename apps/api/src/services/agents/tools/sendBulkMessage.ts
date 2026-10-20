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
import { createNotification } from '../../notifications'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

/**
 * 10/20 — THREE THINGS WERE WRONG WITH THE WRITE BELOW, AND THEY ALL CAME
 * FROM IT BEING A RAW INSERT THAT HELD ITS TYPE IN A CONSTANT.
 *
 *  1. IT STORED THE WRONG TYPE. `landlord_message` is the ONE-TO-ONE notice
 *     ("A message from your landlord", also used by messageTenant). A blast is
 *     `bulk_message` ("Messages from your landlord"), which is what the
 *     landlord portal's own bulk route stores (services/notifications
 *     sendBulkNotification). A resident who switched off the announcement row
 *     kept getting the assistant's blasts, because their answer was recorded
 *     against a different type than the one being written.
 *
 *  2. IT IGNORED in_app_enabled. The pooled path and every other notification
 *     honor it; this one wrote the row whatever the resident had answered.
 *
 *  3. THE COMPLETENESS SCANNER COULD NOT SEE IT. The type lived in a `const`
 *     and was interpolated into the SQL string, so the literal never appeared
 *     in the file and notificationCatalog.test.ts was blind to this sender —
 *     the same blindness that let twenty-two types reach a landlord with no
 *     switch anywhere.
 *
 * All three are fixed by going through `createNotification`, which takes a
 * `NotificationType` the compiler checks, reads the resident's answer, and
 * leaves the literal in the source where the scanner finds it. One query per
 * recipient instead of one set-based insert; a landlord's resident count is in
 * the hundreds at most, and correctness here is worth the round trips.
 */
const TITLE = 'Messages from your landlord'

/** Build the recipient subquery (active tenants of this landlord, optional
 *  property filter). Returns [sql, params] with the landlord id as $1. */
// S634: a blast reaches the tenants of every company the ACCOUNT owns unless a
// property narrows it — which is what "message everyone" means to somebody who
// owns two parks.
function recipientSource(landlordIds: string[], propertyName?: string): { from: string; params: any[] } {
  const params: any[] = [landlordIds]
  let from =
    `FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id AND l.landlord_id = ANY($1::uuid[]) AND l.status = 'active'
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

    const src = recipientSource(actorLandlordIds(actor), propertyName)

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
    //
    // The landlord_id comes from the LEASE, not from the $1 array — the old
    // insert put `$1` (a uuid[] of every company on the account) straight into
    // the uuid landlord_id column, which Postgres cannot do at all, so a
    // confirmed blast threw rather than sending.
    const recipients = await query<{ user_id: string; landlord_id: string }>(
      `SELECT DISTINCT t.user_id, l.landlord_id ${src.from}`, src.params)
    // One notice per PERSON, which is what the preview counted. A resident who
    // holds leases at two companies on the same account appears twice here, and
    // a blast that reached them twice would read as a bug.
    const once = new Map<string, string>()
    for (const r of recipients) if (r.user_id && !once.has(r.user_id)) once.set(r.user_id, r.landlord_id)
    let sent = 0
    for (const [userId, landlordId] of once) {
      await createNotification({
        userId,
        landlordId,
        type: 'bulk_message',
        title: TITLE,
        body: message,
        actionUrl: '/notifications',
      })
      sent++
    }
    return { ok: true, sent, scope, message: `Your message was sent to ${sent} tenant${sent === 1 ? '' : 's'}.` }
  },
}
