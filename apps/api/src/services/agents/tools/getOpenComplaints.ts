/**
 * Tool: get_open_complaints (landlord). The complaints tenants have raised that
 * still need the landlord's attention.
 *
 * S618 (Nic): "if tenants are gonna complain to the agent, the complaint
 * generally needs to go to the landlord. That needs to kind of create a task
 * list for them, things to address — maybe not in the maintenance portal
 * because it's not a maintenance deal, but it's kind of up there with important
 * things to take care of."
 *
 * This is the read side of that list. The landlord is notified when each one is
 * filed (notifyTenantComplaint); this is how they ask "what's outstanding" and
 * get it back in one place.
 *
 * Quotes the tenant VERBATIM. A complaint summarised is a complaint softened —
 * "my neighbour plays music until 2am every night" carries information that
 * "noise complaint" does not, and the landlord is the one who has to judge it.
 *
 * Hard-scoped to actor.profileId. Read-only — resolving a complaint is a
 * deliberate action in the portal, not something an agent does mid-sentence.
 */

import { COMPLAINT_CATEGORY_LABEL, type ComplaintCategory } from '@gam/shared'
import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  id: string
  category: string
  body: string
  about_unit: string | null
  about_text: string | null
  tenant_name: string
  unit_number: string | null
  property_name: string | null
  created_at: string
  status: string
}

export const getOpenComplaints: AgentTool = {
  name: 'get_open_complaints',
  description:
    'List complaints the landlord’s tenants have raised that are still open — noise, neighbors, ' +
    'parking, pets, smells, trash, safety, property condition. These are NOT repair requests ' +
    '(those are get_pending_maintenance); they are things the landlord needs to deal with ' +
    'personally. Use for "any complaints?", "what do I need to deal with", "is anyone unhappy". ' +
    'Read-only.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many (default 20, max 50).' },
      include_resolved: { type: 'boolean', description: 'Include ones already handled (default false).' },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 20
    const includeResolved = args.include_resolved === true

    const rows = await query<Row>(
      `SELECT c.id, c.category, c.body, c.about_text, c.status, c.created_at,
              au.unit_number AS about_unit,
              tu.first_name || ' ' || tu.last_name AS tenant_name,
              u.unit_number, p.name AS property_name
         FROM tenant_complaints c
         JOIN tenants t     ON t.id = c.tenant_id
         JOIN users tu      ON tu.id = t.user_id
         LEFT JOIN units u  ON u.id = c.unit_id
         LEFT JOIN properties p ON p.id = c.property_id
         LEFT JOIN units au ON au.id = c.about_unit_id
        WHERE c.landlord_id = $1
          ${includeResolved ? '' : "AND c.status IN ('open','reviewed')"}
        ORDER BY c.created_at DESC
        LIMIT $2`,
      [actor.profileId, limit],
    )

    if (rows.length === 0) {
      return {
        ok: true,
        count: 0,
        complaints: [],
        note: includeResolved
          ? 'No complaints have been raised at all.'
          : 'Nothing outstanding — no open complaints right now.',
      }
    }

    return {
      ok: true,
      count: rows.length,
      complaints: rows.map((r) => ({
        kind: COMPLAINT_CATEGORY_LABEL[r.category as ComplaintCategory] ?? r.category,
        from: r.tenant_name,
        theirUnit: r.unit_number,
        property: r.property_name,
        about: r.about_unit ?? r.about_text ?? null,
        // Their words, not a summary.
        said: r.body,
        raised: String(r.created_at).slice(0, 10),
        status: r.status,
      })),
      note:
        'These need the landlord’s attention — they are not repairs and no work order exists for ' +
        'them. Report what each tenant actually said. Do not judge whether a complaint is ' +
        'reasonable, and do not suggest what to do about a neighbour dispute.',
    }
  },
}
