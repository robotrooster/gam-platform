/**
 * Tool: get_my_landlord_renewal_tendency (tenant read).
 *
 * Transparency for tenants (Nic 2026-06-15): how their own landlord tends to
 * handle renewals — the typical rent-increase % applied at renewal and how often
 * they renew vs. let a lease end. AGGREGATE only, from captured lease-renewal
 * history (the supersede chain); never names or exposes another tenant, and only
 * shows a figure when enough renewals back it (min-count gate in the service).
 * Companion to get_my_landlord_patterns (which covers entry behavior). Read-only.
 */
import { queryOne } from '../../../db'
import { getLandlordRenewalTendency } from '../../landlordRenewalTendency'
import type { AgentTool, AgentActor } from './types'

export const getMyLandlordRenewalTendency: AgentTool = {
  name: 'get_my_landlord_renewal_tendency',
  description:
    'Show the tenant how their own landlord tends to handle lease RENEWALS — the typical rent-increase ' +
    'percentage at renewal and how often they renew vs. let a lease end. Use for questions like “will my ' +
    'rent go up when I renew?”, “does my landlord usually renew?”, “how much do they raise rent?”. ' +
    'Returns aggregate history about the tenant’s landlord (never another tenant’s details). Present it as ' +
    'a pattern from past behavior, not a promise — their own renewal may differ, and they should confirm ' +
    'terms with the landlord. Read-only.',
  parameters: { type: 'object', properties: {}, required: [] },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const r = await queryOne<{ landlord_id: string | null }>(
      `SELECT l.landlord_id
         FROM v_lease_active_tenants vlat
         JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        WHERE vlat.tenant_id = $1
        LIMIT 1`,
      [actor.profileId]
    )
    const landlordId = r?.landlord_id ? String(r.landlord_id) : ''
    if (!landlordId) {
      return { ok: false, error: 'I couldn’t find your active lease, so I can’t look up your landlord’s renewal history.' }
    }

    const t = await getLandlordRenewalTendency(landlordId)
    if (!t || (t.median_increase_pct == null && t.non_renewal_rate_pct == null)) {
      return {
        ok: true,
        renewal_tendency: null,
        note: 'Your landlord doesn’t have enough renewal history on the platform yet to show a reliable pattern. As more leases renew or end, this will fill in.',
      }
    }

    return {
      ok: true,
      renewal_tendency: {
        typical_increase_pct: t.median_increase_pct, // median % rent goes up at renewal (null if too few)
        avg_increase_pct: t.avg_increase_pct,
        based_on_renewals: t.renewal_count,
        non_renewal_rate_pct: t.non_renewal_rate_pct, // share of ended leases NOT renewed (null if too few)
        based_on_ended_leases: t.ended_count,
      },
      note: 'Aggregate pattern from your landlord’s past renewals on the platform — it doesn’t identify any other tenant, and it’s history, not a promise about your renewal. Confirm your actual terms with your landlord.',
    }
  },
}
