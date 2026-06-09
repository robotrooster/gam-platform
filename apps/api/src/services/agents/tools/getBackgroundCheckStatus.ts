/**
 * Tool: get_background_check_status (landlord). Reads the status of
 * background checks the landlord ordered. Hard-scoped to actor.profileId
 * (background_checks.landlord_id). Returns ONLY the applicant name, status,
 * and the in-portal report link — NEVER ssn/dob/income/employer/address
 * fields (raw report data stays behind the portal, not in chat).
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  first_name: string | null
  last_name: string | null
  status: string
  result_url: string | null
  created_at: string
}

export const getBackgroundCheckStatus: AgentTool = {
  name: 'get_background_check_status',
  description:
    'Check the status of background/screening checks the landlord has ordered (pending, processing, ' +
    'complete, approved, denied, etc.), with the applicant name and a link to the full report in ' +
    'their portal. Use for “did the background check on my applicant come back?”. Read-only; the ' +
    'detailed report itself stays in the portal, not in chat.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many recent checks (default 20, max 50).' } } },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 20
    const rows = await query<Row>(
      // PII columns (ssn_*, date_of_birth, income, employer, address) are
      // intentionally NOT selected — only status + name + the report link.
      `SELECT first_name, last_name, status, result_url, created_at
         FROM background_checks WHERE landlord_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [actor.profileId, limit]
    )
    return {
      ok: true,
      count: rows.length,
      note: rows.length === 0 ? 'No background checks on record.' : undefined,
      checks: rows.map((r) => ({
        applicant: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
        status: r.status,
        reportLink: r.result_url, // opens in the portal (gated by their auth)
        orderedAt: r.created_at,
      })),
    }
  },
}
