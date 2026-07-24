// S552: shared core for a TENANT responding to a unit entry request.
// Extracted from routes/entryRequests.ts POST /:id/respond so the agent tool
// (respond_to_entry_request) and the route execute IDENTICAL logic —
// transactional response upsert + status flip + credit-ledger events, then
// best-effort notification to the property's responsible party. Any future
// change to response semantics lives here, once.

import { getClient, query, queryOne } from '../db'
import { emitEntryRequestResponseEvents } from './creditLedgerEmitters'
import { notifyEntryRequestResponded } from './notifications'
import { logger } from '../lib/logger'

export interface EntryRequestRow {
  id: string
  tenant_id: string
  unit_id: string
  landlord_id: string
  status: string
  proposed_entry_window_start: string
}

export type EntryDecision = 'granted' | 'denied'

/**
 * Apply the tenant's decision. Caller must have ALREADY verified the actor
 * is the tenant on the request and that status === 'pending'. Throws on DB
 * failure; notification failures are swallowed (logged) like the route did.
 */
export async function applyEntryRequestResponse(
  r: EntryRequestRow,
  responderUserId: string,
  decision: EntryDecision,
  reason: string | null
): Promise<void> {
  const respondedAt = new Date()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO unit_entry_request_responses (
         request_id, responder_user_id, decision, reason
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (request_id) DO UPDATE
         SET decision = EXCLUDED.decision,
             responded_at = NOW(),
             reason = EXCLUDED.reason`,
      [r.id, responderUserId, decision, reason]
    )
    const newStatus = decision === 'granted' ? 'granted' : 'denied'
    await client.query(
      `UPDATE unit_entry_requests SET status=$1, updated_at=NOW() WHERE id=$2`,
      [newStatus, r.id]
    )
    await emitEntryRequestResponseEvents(client, {
      tenantId: r.tenant_id,
      requestId: r.id,
      decision,
      respondedAt,
      proposedWindowStart: new Date(r.proposed_entry_window_start),
    })
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  // Notify the responsible party of the tenant's response (best-effort).
  try {
    const ctx = await queryOne<{
      property_id: string
      first_name: string | null
      last_name: string | null
      unit_number: string | null
    }>(
      `SELECT un.property_id,
              tu.first_name,
              tu.last_name,
              un.unit_number
         FROM units    un
         JOIN tenants  t  ON t.id = $1
         JOIN users    tu ON tu.id = t.user_id
        WHERE un.id = $2`,
      [r.tenant_id, r.unit_id]
    )
    if (ctx) {
      const { getPropertyResponsibleParty } = await import('./responsibleParty')
      const targets = await getPropertyResponsibleParty(ctx.property_id)
      if (targets) {
        for (const recipient of targets.primaries) {
          await notifyEntryRequestResponded({
            landlordUserId: recipient.user_id,
            landlordId:     r.landlord_id,
            landlordEmail:  recipient.email,
            requestId:      r.id,
            decision,
            tenantName:     ctx.first_name || ctx.last_name
              ? `${ctx.first_name ?? ''} ${ctx.last_name ?? ''}`.trim()
              : undefined,
            unitNumber:     ctx.unit_number ?? undefined,
          })
        }
      }
    }
  } catch (e) {
    logger.error({ err: e }, '[NOTIFY] entry-request respond:')
  }
}
