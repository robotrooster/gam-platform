/**
 * Agent interaction-log content retention (Nic-decided policy).
 *
 * The metric columns (who/when/outcome/counts/tokens) are kept long-term
 * for reporting. The VERBATIM tenant content (user_message, agent_reply,
 * tool_invocations, human_handoff) is privacy-sensitive, so it is scrubbed
 * on a schedule:
 *   - TENANT interactions: verbatim content nulled/placeholdered after
 *     1 year (AGENT_TENANT_CONTENT_RETENTION_DAYS, default 365).
 *   - LANDLORD interactions: kept INDEFINITELY (never scrubbed here).
 *
 * Scrubbing replaces (not deletes) the row: counts and metrics survive, so
 * historical reporting is unaffected. Idempotent — already-scrubbed rows
 * are skipped via the sentinel check.
 */

import { query } from '../../db'
import { logger } from '../../lib/logger'

const SCRUB_SENTINEL = '[scrubbed]'

/**
 * Scrub verbatim content from TENANT interaction logs older than the
 * retention window. Returns the number of rows scrubbed. Landlord rows are
 * never touched (kept indefinitely).
 */
export async function scrubExpiredTenantContent(): Promise<number> {
  const days = Number(process.env.AGENT_TENANT_CONTENT_RETENTION_DAYS) || 365
  const rows = await query<{ id: string }>(
    `UPDATE agent_interaction_logs
        SET user_message = $2,
            agent_reply = $2,
            tool_invocations = '[]'::jsonb,
            human_handoff = NULL
      WHERE audience = 'tenant'
        AND created_at < now() - make_interval(days => $1::int)
        AND agent_reply <> $2
      RETURNING id`,
    [days, SCRUB_SENTINEL]
  )
  if (rows.length > 0) {
    logger.info({ scrubbed: rows.length, retentionDays: days }, 'agent interaction-log content scrub')
  }
  return rows.length
}
