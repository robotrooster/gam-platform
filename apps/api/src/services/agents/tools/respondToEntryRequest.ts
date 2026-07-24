/**
 * Tool: respond_to_entry_request (tenant ACTION, confirm-first).
 *
 * S552: the agent could already LIST a tenant's entry requests
 * (get_my_entry_requests) but not answer them — this closes the loop.
 * Grants or denies one of the tenant's OWN pending entry requests via the
 * SAME shared core the portal route uses (services/entryRequestRespond.ts):
 * transactional response + status flip + credit-ledger events + responsible-
 * party notification. Hard-scoped: request.tenant_id must equal
 * actor.profileId, status must be 'pending'.
 *
 * The agent must confirm the decision with the tenant BEFORE calling
 * (granting entry to their home is not something to infer).
 */

import { queryOne } from '../../../db'
import { applyEntryRequestResponse, type EntryRequestRow } from '../../entryRequestRespond'
import type { AgentTool, AgentActor } from './types'

export const respondToEntryRequest: AgentTool = {
  name: 'respond_to_entry_request',
  description:
    'Grant or deny one of the tenant’s own PENDING entry requests (a landlord asking to enter their unit). ' +
    'Get the requestId from get_my_entry_requests first, and CONFIRM the tenant’s decision explicitly before ' +
    'calling — never assume. decision must be "granted" or "denied"; an optional reason (their words) is stored ' +
    'and shown to the property team.',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string', description: 'The entry request id (from get_my_entry_requests).' },
      decision: { type: 'string', description: '"granted" to allow entry, "denied" to refuse.' },
      reason: { type: 'string', description: 'Optional reason in the tenant’s words (e.g. "please come after 2pm").' },
    },
    required: ['requestId', 'decision'],
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const requestId = String(args.requestId ?? '').trim()
    const decisionRaw = String(args.decision ?? '').trim().toLowerCase()
    const decision = decisionRaw === 'granted' || decisionRaw === 'grant' || decisionRaw === 'yes'
      ? 'granted' as const
      : decisionRaw === 'denied' || decisionRaw === 'deny' || decisionRaw === 'no'
        ? 'denied' as const
        : null
    if (!requestId) return { ok: false, error: 'A requestId is required (get it from get_my_entry_requests).' }
    if (!decision) return { ok: false, error: 'The decision must be "granted" or "denied" — confirm with the tenant which they want.' }
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null

    const r = await queryOne<EntryRequestRow>(
      `SELECT id, tenant_id, unit_id, landlord_id, status, proposed_entry_window_start
         FROM unit_entry_requests
        WHERE id = $1 AND tenant_id = $2`,
      [requestId, actor.profileId]
    )
    if (!r) return { ok: false, error: 'No such entry request on this tenant’s account.' }
    if (r.status !== 'pending') {
      return { ok: false, error: `That request is already ${r.status} — nothing to respond to.` }
    }

    await applyEntryRequestResponse(r, actor.userId, decision, reason)

    return {
      ok: true,
      requestId,
      decision,
      message: decision === 'granted'
        ? 'Entry granted — the property team has been notified.'
        : 'Entry denied — the property team has been notified' + (reason ? ' along with the reason.' : '.'),
    }
  },
}
