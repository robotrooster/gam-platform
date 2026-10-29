/**
 * Tool: get_team (landlord read).
 *
 * Lists the landlord's full team across every role — property managers,
 * on-site managers, maintenance workers, bookkeepers — plus any pending
 * invitations. Hard-scoped to landlord_id = actor.profileId on every scope
 * table. Broader than get_maintenance_team (which returns only assignable
 * maintenance workers); this answers "who's on my team / who has access?".
 */

import { LANDLORD_ASSIGNABLE_ROLE_LABEL } from '@gam/shared'
import { query } from '../../../db'
import { keptIdsSql, coversAllSql, companyWideSql, formerSql } from '../../../lib/bookkeeperScope'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

interface MemberRow {
  role: string
  first_name: string | null
  last_name: string | null
  all_properties: boolean | null
  prop_count: number | null
  /** 10/12: bookkeepers only — the company-wide box, the lease-dates box, former properties. */
  company_wide: boolean | null
  lease_dates: boolean | null
  former_count: number | null
  /** 10/12 (Nic): bookkeepers only — the ledger, whole-company reports and monthly report boxes. */
  company_ledger: boolean | null
  whole_reports: boolean | null
  monthly_report: boolean | null
}

// 10/25: this was a second copy of LANDLORD_ASSIGNABLE_ROLE_LABEL, and it had
// already drifted — "On-site Manager" here against "On-Site Manager" in shared.
// So renaming the role for Nic would have fixed every screen and left the
// assistant still calling his front desk person a manager. One map now.
const ROLE_LABEL: Record<string, string> = LANDLORD_ASSIGNABLE_ROLE_LABEL

export const getTeam: AgentTool = {
  name: 'get_team',
  description:
    'List the landlord’s whole team and each member’s role and coverage — property managers, ' +
    'on-site managers, maintenance workers, and bookkeepers — plus any pending invitations. Use for ' +
    '“who’s on my team?”, “who has access to my account?”, or “did my invite go out?”. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],

  async execute(_args, actor: AgentActor) {
    // One row per (member, role), scoped to this landlord on every table.
    const members = await query<MemberRow>(
      `SELECT s.role, u.first_name, u.last_name, s.all_properties, s.prop_count,
              s.company_wide, s.lease_dates, s.former_count, s.company_ledger, s.whole_reports, s.monthly_report
         FROM (
           SELECT 'property_manager' AS role, user_id, landlord_id, all_properties,
                  COALESCE(array_length(property_ids, 1), 0) AS prop_count,
                  NULL::boolean AS company_wide, NULL::boolean AS lease_dates, NULL::int AS former_count,
                  NULL::boolean AS company_ledger, NULL::boolean AS whole_reports, NULL::boolean AS monthly_report
             FROM property_manager_scopes
           UNION ALL
           SELECT 'onsite_manager', user_id, landlord_id, all_properties,
                  COALESCE(array_length(property_ids, 1), 0), NULL, NULL, NULL, NULL, NULL, NULL
             FROM onsite_manager_scopes
           UNION ALL
           SELECT 'maintenance', user_id, landlord_id, all_properties,
                  COALESCE(array_length(property_ids, 1), 0), NULL, NULL, NULL, NULL, NULL, NULL
             FROM maintenance_worker_scopes
           UNION ALL
           -- 10/11: a bookkeeper keeps the properties ticked for them; "all"
           -- only while every property the company owns today is ticked
           -- (lib/bookkeeperScope). 10/12: the company-wide box (bank account,
           -- payouts, payroll) is its own; lease dates are the owner's box; a
           -- sold property stays readable up to the day it left.
           SELECT 'bookkeeper', bs.user_id, bs.landlord_id, ${coversAllSql('bs')},
                  cardinality(${keptIdsSql('bs')}), ${companyWideSql('bs')}, bs.show_lease_dates,
                  jsonb_array_length(${formerSql('bs')}),
                  -- 10/12 (Nic): the ledger, whole-company reports and monthly report boxes.
                  -- 10/12 review: the ledger and whole-company reports boxes end
                  -- with the last property they kept (lib/bookkeeperScope).
                  (bs.company_ledger AND cardinality(${keptIdsSql('bs')}) > 0),
                  (bs.whole_company_reports AND (${companyWideSql('bs')} OR cardinality(${keptIdsSql('bs')}) > 0)),
                  bs.sees_monthly_report
             FROM bookkeeper_scopes bs
         ) s
         JOIN users u ON u.id = s.user_id
        WHERE s.landlord_id = ANY($1::uuid[])
        ORDER BY s.role, u.first_name, u.last_name`,
      [actorLandlordIds(actor)]
    )

    const invites = await query<{ email: string; role: string }>(
      `SELECT email, role FROM invitations WHERE landlord_id = ANY($1::uuid[]) AND status = 'pending' ORDER BY created_at DESC`,
      [actorLandlordIds(actor)]
    )

    const coverage = (m: MemberRow): string => {
      const n = m.prop_count ?? 0
      const props = m.all_properties ? 'all properties' : `${n} propert${n === 1 ? 'y' : 'ies'}`
      if (m.role !== 'bookkeeper') return props
      // 10/12 (Nic): the company-wide box, and nothing about payroll or the
      // bank when it is not ticked.
      const parts = [
        n > 0 || !m.company_wide ? props : null,
        m.company_wide ? 'company-wide books (bank account, payouts, payroll)' : null,
        m.company_ledger && !m.company_wide ? 'the whole-company Books ledger (no bank account or payouts)' : null,
        m.whole_reports ? "company reports showing the whole company" : null,
        m.monthly_report ? 'the monthly property report on screen' : null,
        m.lease_dates ? 'lease start and end dates' : null,
        m.former_count ? `history of ${m.former_count} sold propert${m.former_count === 1 ? 'y' : 'ies'} up to the sale` : null,
      ].filter(Boolean)
      return parts.join('; ')
    }

    return {
      ok: true,
      memberCount: members.length,
      note: members.length === 0 && invites.length === 0 ? 'No team members or pending invitations yet.' : undefined,
      members: members.map((m) => ({
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Unnamed',
        role: ROLE_LABEL[m.role] ?? m.role,
        coverage: coverage(m),
      })),
      pendingInvites: invites.map((i) => ({ email: i.email, role: ROLE_LABEL[i.role] ?? i.role })),
    }
  },
}
