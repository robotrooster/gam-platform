/**
 * Tool: get_my_entry_requests (tenant). Reads requests by the landlord to
 * enter the tenant's OWN unit. Hard-scoped to actor.profileId
 * (unit_entry_requests.tenant_id). A real tenant transparency concern.
 */

import { query } from '../../../db'
import { stateLawWarningsEnabled } from '../../stateLaw'
import type { AgentTool, AgentActor } from './types'

interface Row {
  reason: string | null
  reason_category: string | null
  status: string
  notice_given_at: string | null
  notice_window_hours: number | null
  proposed_entry_window_start: string | null
  proposed_entry_window_end: string | null
  entry_actual_at: string | null
}

// The landlord's own entry-notice setting is a FACT about this tenancy and is
// always returned. The line telling the tenant that the required notice varies
// by state and to go read their local law is a state-law caution, so it waits
// for the switch (services/stateLaw STATE_LAW_WARNINGS_FEATURE) — 10/20 (Nic):
// "There should be no state law warnings anywhere in the system. At least not
// right now. Just hide all that stuff." With it off the tenant simply sees what
// their landlord's standard notice is, which is what they asked for.
const NOTICE_DISCLAIMER =
  'Required advance notice for entry varies by state and locality — check your local laws for what applies to you.'

export const getMyEntryRequests: AgentTool = {
  name: 'get_my_entry_requests',
  description:
    'List requests by the landlord to enter the tenant’s unit — reason, status, the proposed entry ' +
    'window, and how much advance notice was given — plus the landlord’s standard entry-notice ' +
    'policy. Use for “is someone scheduled to come into my place?”, “when is my landlord entering?”, ' +
    'or “how much notice do I get before entry?”. Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many to return (default 10, max 25).' } } },
  audiences: ['tenant'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 25) : 10
    const rows = await query<Row>(
      `SELECT reason, reason_category, status, notice_given_at, notice_window_hours,
              proposed_entry_window_start, proposed_entry_window_end, entry_actual_at
         FROM unit_entry_requests WHERE tenant_id = $1
        ORDER BY COALESCE(proposed_entry_window_start, created_at) DESC LIMIT $2`,
      [actor.profileId, limit]
    )

    // The landlord's configured standard notice (hours) for this tenant's
    // active lease — landlord-set, NOT a legal figure.
    const policy = await query<{ default_entry_notice_hours: number }>(
      `SELECT ld.default_entry_notice_hours
         FROM v_lease_active_tenants vlat
         JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
         JOIN landlords ld ON ld.id = l.landlord_id
        WHERE vlat.tenant_id = $1
        LIMIT 1`,
      [actor.profileId]
    ).catch(() => [] as { default_entry_notice_hours: number }[])
    const policyHours = policy[0]?.default_entry_notice_hours ?? null

    return {
      ok: true,
      count: rows.length,
      landlordNoticePolicyHours: policyHours, // landlord-configured standard, NOT a legal requirement
      ...((await stateLawWarningsEnabled()) ? { noticeDisclaimer: NOTICE_DISCLAIMER } : {}),
      note: rows.length === 0 ? 'No entry requests on record for this unit.' : undefined,
      entryRequests: rows.map((r) => ({
        reason: r.reason, category: r.reason_category, status: r.status,
        noticeGivenAt: r.notice_given_at,
        noticeHours: r.notice_window_hours,
        proposedWindowStart: r.proposed_entry_window_start, proposedWindowEnd: r.proposed_entry_window_end,
        enteredAt: r.entry_actual_at,
      })),
    }
  },
}
