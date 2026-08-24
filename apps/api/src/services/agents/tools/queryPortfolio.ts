/**
 * Tool: query_portfolio (landlord). Ranked answers to "who / which is the
 * most or least X" over the landlord's OWN records.
 *
 * S618 (Nic): "if I wanted to know who the longest running tenancy is, or if I
 * wanna see the most problematic tenants in terms of neediness — how many
 * maintenance requests are put in... I want the agent to be able to come up
 * with answers to questions where any data is captured on the property."
 *
 * get_portfolio_stats answers "what is my rate of X" — one number for the whole
 * portfolio. This answers "WHO is the X" — a ranked list of named tenants,
 * units or properties. Between them they cover the shape of nearly every
 * question a landlord asks about their own book.
 *
 * A CLOSED VOCABULARY, NOT FREE SQL. The agent picks a subject and a measure
 * from enums; the SQL is written here. That is deliberate:
 *   - no model-authored SQL, so no injection and no invented column
 *   - the landlord filter is applied by THIS file on every branch and cannot be
 *     omitted by anything the model says
 *   - an unknown measure returns the catalog instead of guessing
 *
 * NO REQUIRED ARGUMENTS. Called with nothing it returns the catalog of what it
 * can rank, which is also how the agent discovers what is answerable — and it
 * means the phrase table can run it directly when the model will not (see
 * toolRouting.ts).
 *
 * COMPLAINTS ARE NOW CAPTURED. When this was first written nothing on the
 * platform recorded a complaint, so "who complains about their neighbour most"
 * had no answer. Nic: "the table is gonna be created in the agent chat — that's
 * the point of contact where tenants are gonna complain about the neighbor."
 * So tenant_complaints exists and log_complaint (tenant side) writes to it, and
 * the two rankings that matter are here:
 *
 *   tenants.complaints_filed  -> who is always unhappy
 *   units.complaints_about    -> the neighbour who is the actual problem
 *
 * Counts start from the day that shipped; a quiet older tenancy means "not
 * recorded", not "never complained", and the result says so.
 *
 * Still NOT categorisable: lease_notices is free text with no type column, so
 * notices can be counted per tenant and not broken down by reason. Never infer
 * a complaint from a maintenance category — those are hvac/plumbing/electrical/
 * appliance and say nothing about neighbours.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

type Subject = 'tenants' | 'units' | 'properties'

interface Measure {
  /** what the number means, in the words a landlord would use */
  means: string
  /** SELECT label, value FROM ... WHERE landlord scope — $1 is landlord id */
  sql: string
  unit: string
}

/**
 * Every ranking the platform can honestly produce. Adding one means adding SQL
 * here — there is no path by which the model invents a measure.
 */
const MEASURES: Record<Subject, Record<string, Measure>> = {
  tenants: {
    tenancy_length: {
      means: 'how long they have been a tenant, longest first',
      unit: 'days',
      sql: `SELECT u.first_name || ' ' || u.last_name AS label,
                   (CURRENT_DATE - MIN(l.start_date))::int AS value,
                   MAX(un.unit_number) AS detail
              FROM leases l
              JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
              JOIN tenants t        ON t.id = lt.tenant_id
              JOIN users u          ON u.id = t.user_id
              JOIN units un         ON un.id = l.unit_id
             WHERE l.landlord_id = $1 AND l.status = 'active'
             GROUP BY t.id, u.first_name, u.last_name`,
    },
    maintenance_requests: {
      means: 'how many repairs they have reported — the "neediness" measure',
      unit: 'requests',
      sql: `SELECT u.first_name || ' ' || u.last_name AS label,
                   COUNT(m.id)::int AS value,
                   MAX(un.unit_number) AS detail
              FROM maintenance_requests m
              JOIN tenants t  ON t.id = m.tenant_id
              JOIN users u    ON u.id = t.user_id
              LEFT JOIN units un ON un.id = m.unit_id
             WHERE m.landlord_id = $1
             GROUP BY t.id, u.first_name, u.last_name`,
    },
    maintenance_cost: {
      means: 'what their repairs have actually cost — needy for a REAL reason, or not',
      unit: 'dollars',
      sql: `SELECT u.first_name || ' ' || u.last_name AS label,
                   COALESCE(SUM(m.actual_cost), 0)::numeric AS value,
                   COUNT(m.id)::text || ' requests' AS detail
              FROM maintenance_requests m
              JOIN tenants t  ON t.id = m.tenant_id
              JOIN users u    ON u.id = t.user_id
             WHERE m.landlord_id = $1
             GROUP BY t.id, u.first_name, u.last_name`,
    },
    late_payments: {
      means: 'how many times their rent arrived after their own grace period',
      unit: 'late payments',
      sql: `SELECT u.first_name || ' ' || u.last_name AS label,
                   COUNT(*) FILTER (
                     WHERE COALESCE(p.settled_at, NOW())
                           > p.due_date + (COALESCE(l.late_fee_grace_days, 0) || ' days')::interval
                   )::int AS value,
                   COUNT(*)::text || ' charges' AS detail
              FROM payments p
              JOIN leases l  ON l.id = p.lease_id
              JOIN tenants t ON t.id = p.tenant_id
              JOIN users u   ON u.id = t.user_id
             WHERE p.landlord_id = $1 AND p.type = 'rent' AND p.due_date <= CURRENT_DATE
             GROUP BY t.id, u.first_name, u.last_name`,
    },
    balance_owed: {
      means: 'what they currently owe',
      unit: 'dollars',
      sql: `SELECT u.first_name || ' ' || u.last_name AS label,
                   COALESCE(SUM(p.amount), 0)::numeric AS value,
                   COUNT(*)::text || ' unpaid charges' AS detail
              FROM payments p
              JOIN tenants t ON t.id = p.tenant_id
              JOIN users u   ON u.id = t.user_id
             WHERE p.landlord_id = $1 AND p.status IN ('pending','failed')
             GROUP BY t.id, u.first_name, u.last_name`,
    },
    complaints_filed: {
      means: 'how many complaints they have raised — the tenant who is always unhappy',
      unit: 'complaints',
      sql: `SELECT u.first_name || ' ' || u.last_name AS label,
                   COUNT(c.id)::int AS value,
                   MAX(un.unit_number) AS detail
              FROM tenant_complaints c
              JOIN tenants t ON t.id = c.tenant_id
              JOIN users u   ON u.id = t.user_id
              LEFT JOIN units un ON un.id = c.unit_id
             WHERE c.landlord_id = $1
             GROUP BY t.id, u.first_name, u.last_name`,
    },
    notices_received: {
      means: 'how many notices the landlord has served them (free text — not categorised)',
      unit: 'notices',
      sql: `SELECT u.first_name || ' ' || u.last_name AS label,
                   COUNT(n.id)::int AS value, NULL::text AS detail
              FROM lease_notices n
              JOIN leases l  ON l.id = n.lease_id
              JOIN tenants t ON t.id = n.tenant_id
              JOIN users u   ON u.id = t.user_id
             WHERE l.landlord_id = $1
             GROUP BY t.id, u.first_name, u.last_name`,
    },
  },
  units: {
    maintenance_requests: {
      means: 'which units break most often',
      unit: 'requests',
      sql: `SELECT un.unit_number AS label, COUNT(m.id)::int AS value,
                   MAX(p.name) AS detail
              FROM maintenance_requests m
              JOIN units un     ON un.id = m.unit_id
              JOIN properties p ON p.id = un.property_id
             WHERE m.landlord_id = $1
             GROUP BY un.id, un.unit_number`,
    },
    maintenance_cost: {
      means: 'which units cost the most to keep',
      unit: 'dollars',
      sql: `SELECT un.unit_number AS label, COALESCE(SUM(m.actual_cost),0)::numeric AS value,
                   MAX(p.name) AS detail
              FROM maintenance_requests m
              JOIN units un     ON un.id = m.unit_id
              JOIN properties p ON p.id = un.property_id
             WHERE m.landlord_id = $1
             GROUP BY un.id, un.unit_number`,
    },
    complaints_about: {
      means: 'how many complaints have been raised ABOUT this unit — the neighbour who is the actual problem',
      unit: 'complaints',
      sql: `SELECT un.unit_number AS label, COUNT(c.id)::int AS value,
                   MAX(p.name) AS detail
              FROM tenant_complaints c
              JOIN units un     ON un.id = c.about_unit_id
              JOIN properties p ON p.id = un.property_id
             WHERE c.landlord_id = $1
             GROUP BY un.id, un.unit_number`,
    },
    turnover: {
      means: 'which units change tenants most often',
      unit: 'leases ended',
      sql: `SELECT un.unit_number AS label,
                   COUNT(*) FILTER (WHERE l.status IN ('expired','terminated'))::int AS value,
                   MAX(p.name) AS detail
              FROM leases l
              JOIN units un     ON un.id = l.unit_id
              JOIN properties p ON p.id = un.property_id
             WHERE l.landlord_id = $1
             GROUP BY un.id, un.unit_number`,
    },
    rent: {
      means: 'what each occupied unit brings in',
      unit: 'dollars per month',
      sql: `SELECT un.unit_number AS label, l.rent_amount::numeric AS value,
                   p.name AS detail
              FROM leases l
              JOIN units un     ON un.id = l.unit_id
              JOIN properties p ON p.id = un.property_id
             WHERE l.landlord_id = $1 AND l.status = 'active'`,
    },
  },
  properties: {
    occupancy_rate: {
      means: 'how full each property is',
      unit: 'percent occupied',
      sql: `SELECT p.name AS label,
                   ROUND(100.0 * COUNT(*) FILTER (WHERE un.status IN ('active','delinquent','suspended'))
                         / NULLIF(COUNT(*), 0), 1) AS value,
                   COUNT(*)::text || ' units' AS detail
              FROM units un
              JOIN properties p ON p.id = un.property_id
             WHERE un.landlord_id = $1 AND un.retired_at IS NULL
             GROUP BY p.id, p.name`,
    },
    rent_roll: {
      means: 'what each property brings in monthly',
      unit: 'dollars per month',
      sql: `SELECT p.name AS label, COALESCE(SUM(l.rent_amount),0)::numeric AS value,
                   COUNT(*)::text || ' leases' AS detail
              FROM leases l
              JOIN units un     ON un.id = l.unit_id
              JOIN properties p ON p.id = un.property_id
             WHERE l.landlord_id = $1 AND l.status = 'active'
             GROUP BY p.id, p.name`,
    },
    maintenance_cost: {
      means: 'what each property costs to maintain',
      unit: 'dollars',
      sql: `SELECT p.name AS label, COALESCE(SUM(m.actual_cost),0)::numeric AS value,
                   COUNT(m.id)::text || ' requests' AS detail
              FROM maintenance_requests m
              JOIN units un     ON un.id = m.unit_id
              JOIN properties p ON p.id = un.property_id
             WHERE m.landlord_id = $1
             GROUP BY p.id, p.name`,
    },
  },
}

/** Questions the platform genuinely cannot answer, and why. */
const NOT_CAPTURED: Record<string, string> = {
  complaint_history_before_today:
    'Complaints are recorded from the agent chat onward (S618). Nothing was captured before that, so ' +
    'a low count on an older tenancy means "not recorded", not "never complained".',
  notice_reasons:
    'Notices are stored as free text with no type, so they can be counted per tenant but not broken ' +
    'down by reason.',
  tenant_age:
    'Date of birth is optional and often not on file; where it is missing there is no age to report.',
}

function catalog() {
  return {
    ok: true,
    needsChoice: true,
    note:
      'Tell me which of these to rank and I will pull it. Pick a subject and a measure, ' +
      'or ask the landlord which they meant.',
    available: Object.fromEntries(
      (Object.keys(MEASURES) as Subject[]).map((s) => [
        s, Object.fromEntries(Object.entries(MEASURES[s]).map(([k, m]) => [k, m.means])),
      ]),
    ),
    notCaptured: NOT_CAPTURED,
  }
}

export const queryPortfolio: AgentTool = {
  name: 'query_portfolio',
  description:
    'Rank the landlord’s OWN tenants, units or properties by a measure — who has been a tenant ' +
    'longest, who files the most repair requests and what those repairs actually cost, who pays ' +
    'late most often, who owes the most, which units break or turn over most, which property is ' +
    'fullest or costs most to maintain. Use for any "who is the most/least…", "which unit…", ' +
    '"rank my…", "my worst/best…" question. Call with no arguments to see everything it can rank. ' +
    'Read-only.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', enum: ['tenants', 'units', 'properties'], description: 'What to rank.' },
      measure: { type: 'string', description: 'Which measure — call with no arguments to list them.' },
      direction: { type: 'string', enum: ['top', 'bottom'], description: 'Highest first (default) or lowest first.' },
      limit: { type: 'integer', description: 'How many rows (default 5, max 25).' },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const subject = String(args.subject ?? '').toLowerCase() as Subject
    const measureKey = String(args.measure ?? '').toLowerCase()
    if (!MEASURES[subject] || !MEASURES[subject][measureKey]) {
      // S618 (Nic): "if that response ever comes up [we don't track that], it
      // should be set up where we start tracking that data platform wide."
      //
      // A measure that was NAMED and does not exist is somebody asking for
      // something the platform cannot answer. Recorded so it becomes a backlog
      // instead of a shrug repeated to forty landlords. An empty measure is the
      // agent browsing the catalog, not a gap — not logged.
      if (measureKey) {
        void query(
          `INSERT INTO analytics_data_gaps (landlord_id, audience, tool, requested)
           VALUES ($1, 'landlord', 'query_portfolio', $2)`,
          [actor.profileId, `${subject || 'unknown'}.${measureKey}`],
        ).catch(() => {})
      }
      return catalog()
    }

    const m = MEASURES[subject][measureKey]
    const desc = String(args.direction ?? 'top').toLowerCase() !== 'bottom'
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 25) : 5

    // The landlord filter lives inside every branch's SQL above ($1). Ordering
    // and limit are applied here from validated values — nothing the model
    // supplies is interpolated into SQL.
    const rows = await query<any>(
      `SELECT label, value, detail FROM (${m.sql}) q
        WHERE value IS NOT NULL
        ORDER BY value ${desc ? 'DESC' : 'ASC'} NULLS LAST
        LIMIT ${limit}`,
      [actor.profileId],
    )

    if (rows.length === 0) {
      return {
        ok: true, subject, measure: measureKey, results: [],
        note: `Nothing to rank — there are no ${subject} with a value for ${measureKey} yet.`,
      }
    }

    return {
      ok: true,
      subject,
      measure: measureKey,
      means: m.means,
      unit: m.unit,
      ranking: desc ? 'highest first' : 'lowest first',
      results: rows.map((r, i) => ({
        rank: i + 1,
        name: r.label,
        value: r.value === null ? null : Number(r.value),
        detail: r.detail ?? undefined,
      })),
      whatThisDoesNotContain:
        'Only the rows above, in this order, for this one measure. No trend, no cause, no comparison ' +
        'to other landlords, and no judgement about whether a tenant is reasonable — report the ' +
        'numbers and let the landlord draw the conclusion.',
    }
  },
}
