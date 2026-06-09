/**
 * Tool: get_my_documents (tenant).
 *
 * Lists the tenant's OWN documents (lease, addenda, etc.) and whether each
 * is signed. Hard-scoped to actor.profileId (documents.tenant_id). Does NOT
 * return file URLs — the agent tells the tenant WHAT they have and points
 * them to the Documents page to open it.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface DocRow {
  name: string
  type: string
  signed_by_tenant: boolean
  signed_by_landlord: boolean
  created_at: string
}

export const getMyDocuments: AgentTool = {
  name: 'get_my_documents',
  description:
    'List the tenant’s own documents (lease, addenda, notices) with their type and signature ' +
    'status. Use for “what documents do I have?” or “is my lease signed?”. Tell the tenant they ' +
    'can open these in the Documents section of their portal. Read-only; returns no file links.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many recent documents to return (default 15, max 40).' },
    },
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 40) : 15

    const rows = await query<DocRow>(
      // NOTE: never add the `url` column or use SELECT * here — the agent
      // must not hand out file links (see the no-url test in tools.test.ts).
      `SELECT name, type, signed_by_tenant, signed_by_landlord, created_at
         FROM documents
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [actor.profileId, limit]
    )

    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No documents on record for this tenant.' : undefined,
      documents: rows.map((r) => ({
        name: r.name,
        type: r.type,
        signedByTenant: r.signed_by_tenant,
        signedByLandlord: r.signed_by_landlord,
        added: r.created_at,
      })),
    }
  },
}
