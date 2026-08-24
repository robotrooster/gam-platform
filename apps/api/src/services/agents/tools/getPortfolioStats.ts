/**
 * Tool: get_portfolio_stats (landlord). The statistics a landlord would
 * otherwise have to work out by hand, scoped to THEIR portfolio only.
 *
 * S618 (Nic): "it should be able to look up any statistics — stuff that we're
 * tracking on the admin side, not platform wide, but anything scoped to their
 * portfolio... I might wanna know what's the average age of my renters, or how
 * many people are on fixed income, or just at a glance where I would have to go
 * through and manually figure that out. We're already tracking all that
 * information."
 *
 * That is the point of this tool: the platform already records every payment,
 * lease, repair and tenant. Nobody was turning that into the two-second answer
 * — "17% of my rent comes in late", "my average repair takes eleven days" —
 * that no other software gives a landlord without a spreadsheet.
 *
 * HARD-SCOPED to actor.profileId. Every family filters on the landlord's own
 * id; the admin equivalents of these numbers are platform-wide and must never
 * leak here. A landlord sees their portfolio and nothing else.
 *
 * NO REQUIRED ARGUMENTS, deliberately. The phrase table can run this directly
 * when the model declines to, which it frequently does (see toolRouting.ts).
 * `topic` narrows it when the question is specific; the default is everything,
 * because "how am I doing" is a real question.
 *
 * COUNTS AND AVERAGES ONLY — never rows. A landlord asking about late payment
 * does not need 27 payment records in the model's context, and prompt size is
 * the one factor repeatedly measured degrading this model's tool-calling.
 *
 * `null` means NOT RECORDED, and the note says so in words. The demo portfolio
 * has no birthdates, so `averageAgeYears` comes back null — the agent must say
 * it is not on file rather than produce a plausible number. S617 measured the
 * failure this prevents: handed monthly late-payment figures, the model
 * invented day-range buckets and a tenant count that existed nowhere.
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

/** Occupied = a unit someone lives in. Same set the portfolio and KPI use. */
const OCCUPIED = `('active','delinquent','suspended')`

/**
 * Late = past the grace period on that tenant's OWN lease. Identical to
 * get_late_payment_history — two definitions of "late" in one product is how
 * the billing bug happened, where three parts of the system each had their own
 * idea of "occupied".
 */
const LATE = `COALESCE(p.settled_at, NOW()) > p.due_date + (COALESCE(l.late_fee_grace_days, 0) || ' days')::interval`

const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

type Topic =
  | 'occupancy' | 'tenants' | 'rent' | 'payments' | 'leases' | 'maintenance'
  | 'money' | 'deposits' | 'applications' | 'bookings' | 'inspections'
const ALL: Topic[] = [
  'occupancy', 'tenants', 'rent', 'payments', 'leases', 'maintenance',
  'money', 'deposits', 'applications', 'bookings', 'inspections',
]

export const getPortfolioStats: AgentTool = {
  name: 'get_portfolio_stats',
  description:
    'Statistics about the landlord’s OWN portfolio, computed from their real records — occupancy ' +
    'rate; how many tenants and their average age and how many are on fixed income; monthly rent ' +
    'roll and average rent; what share of rent arrives late and how many days late on average; how ' +
    'many leases end early and average lease length; open repairs and average days to complete one; ' +
    'rent collected against recorded expenses and other income; what deposits cost at move-out; how ' +
    'applications convert; short-stay nights and revenue; and inspections. Use for any "how many / ' +
    'what percentage / what’s my average / how am I doing / what does my portfolio look like" ' +
    'question — the things a landlord would otherwise work out by hand. Optionally narrow with ' +
    'topic (occupancy, tenants, rent, payments, leases, maintenance, money, deposits, applications, ' +
    'bookings, inspections). Read-only.',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        enum: ALL,
        description: 'Narrow to one area. Omit for everything.',
      },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const asked = String(args.topic ?? '').toLowerCase() as Topic
    const want = ALL.includes(asked) ? [asked] : ALL
    // A topic that was named and is not one of ours = a statistic the platform
    // does not keep. Recorded as a product signal (S618). No topic at all is
    // just "everything", not a gap.
    if (asked && !ALL.includes(asked)) {
      void query(
        `INSERT INTO analytics_data_gaps (landlord_id, audience, tool, requested)
         VALUES ($1, 'landlord', 'get_portfolio_stats', $2)`,
        [actor.profileId, asked],
      ).catch(() => {})
    }
    const id = actor.profileId
    const out: Record<string, unknown> = { ok: true }
    const missing: string[] = []

    if (want.includes('occupancy')) {
      const [r] = await query<any>(
        `SELECT COUNT(*)::int AS units,
                COUNT(*) FILTER (WHERE u.status IN ${OCCUPIED})::int AS occupied,
                COUNT(*) FILTER (WHERE u.status IN ('vacant','available'))::int AS vacant,
                COUNT(DISTINCT u.property_id)::int AS properties
           FROM units u
          WHERE u.landlord_id = $1 AND u.retired_at IS NULL`, [id])
      out.occupancy = {
        properties: r.properties, units: r.units,
        occupied: r.occupied, vacant: r.vacant,
        occupancyRatePct: pct(r.occupied, r.units),
      }
    }

    if (want.includes('tenants')) {
      const [r] = await query<any>(
        `SELECT COUNT(DISTINCT lt.tenant_id)::int AS tenants,
                ROUND(AVG(EXTRACT(YEAR FROM age(t.date_of_birth)))::numeric, 1) AS avg_age,
                COUNT(DISTINCT lt.tenant_id) FILTER (WHERE t.date_of_birth IS NOT NULL)::int AS with_dob,
                COUNT(DISTINCT lt.tenant_id) FILTER (WHERE t.ssi_ssdi)::int AS fixed_income
           FROM leases l
           JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
           JOIN tenants t        ON t.id = lt.tenant_id
          WHERE l.landlord_id = $1 AND l.status = 'active'`, [id])
      const avgAge = numOrNull(r.avg_age)
      if (avgAge === null) missing.push('date of birth is not recorded for any current tenant, so there is no average age')
      out.tenants = {
        currentTenants: r.tenants,
        averageAgeYears: avgAge,
        tenantsWithAgeOnFile: r.with_dob,
        onFixedIncome: r.fixed_income,
        onFixedIncomePct: pct(r.fixed_income, r.tenants),
      }
    }

    if (want.includes('rent')) {
      const [r] = await query<any>(
        `SELECT SUM(l.rent_amount) AS roll,
                ROUND(AVG(l.rent_amount)::numeric, 2) AS avg_rent,
                MIN(l.rent_amount) AS min_rent, MAX(l.rent_amount) AS max_rent
           FROM leases l WHERE l.landlord_id = $1 AND l.status = 'active'`, [id])
      out.rent = {
        monthlyRentRoll: numOrNull(r.roll),
        averageRent: numOrNull(r.avg_rent),
        lowestRent: numOrNull(r.min_rent),
        highestRent: numOrNull(r.max_rent),
      }
    }

    if (want.includes('payments')) {
      const [r] = await query<any>(
        `SELECT COUNT(*)::int AS due,
                COUNT(*) FILTER (WHERE ${LATE})::int AS late,
                ROUND(AVG(EXTRACT(EPOCH FROM (
                  COALESCE(p.settled_at, NOW())
                  - (p.due_date + (COALESCE(l.late_fee_grace_days, 0) || ' days')::interval)
                )) / 86400) FILTER (WHERE ${LATE})::numeric, 1) AS avg_days_late,
                COUNT(*) FILTER (WHERE p.status IN ('pending','failed'))::int AS unpaid,
                SUM(p.amount) FILTER (WHERE p.status IN ('pending','failed')) AS unpaid_amount
           FROM payments p
           JOIN leases l ON l.id = p.lease_id
          WHERE p.landlord_id = $1 AND p.type = 'rent' AND p.due_date <= CURRENT_DATE`, [id])
      out.payments = {
        rentChargesToDate: r.due,
        paidLate: r.late,
        // The headline Nic asked for: "17% of people pay late".
        lateRatePct: pct(r.late, r.due),
        averageDaysLate: numOrNull(r.avg_days_late),
        stillUnpaid: r.unpaid,
        stillUnpaidAmount: numOrNull(r.unpaid_amount),
        lateMeans: 'past the grace period on that tenant’s own lease, not the due date',
      }
    }

    if (want.includes('leases')) {
      const [r] = await query<any>(
        `SELECT COUNT(*) FILTER (WHERE l.status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE l.status IN ('expired','terminated'))::int AS ended,
                COUNT(*) FILTER (
                  WHERE l.terminated_at IS NOT NULL AND l.end_date IS NOT NULL
                    AND l.terminated_at::date < l.end_date)::int AS ended_early,
                COUNT(*) FILTER (
                  WHERE l.status = 'active' AND l.end_date IS NOT NULL
                    AND l.end_date <= CURRENT_DATE + INTERVAL '90 days')::int AS ending_90d,
                ROUND(AVG(l.end_date - l.start_date) FILTER (WHERE l.end_date IS NOT NULL)::numeric, 0) AS avg_len_days
           FROM leases l WHERE l.landlord_id = $1`, [id])
      const avgLen = numOrNull(r.avg_len_days)
      out.leases = {
        active: r.active,
        endedEver: r.ended,
        endedEarly: r.ended_early,
        // Nic's example: "you're averaging 3% of people break their lease early".
        endedEarlyPct: pct(r.ended_early, r.ended),
        endingWithin90Days: r.ending_90d,
        averageLeaseLengthMonths: avgLen === null ? null : Math.round((avgLen / 30.44) * 10) / 10,
      }
    }

    if (want.includes('maintenance')) {
      const [r] = await query<any>(
        `SELECT COUNT(*) FILTER (WHERE m.status NOT IN ('completed','cancelled','rejected'))::int AS open,
                COUNT(*) FILTER (WHERE m.completed_at >= CURRENT_DATE - INTERVAL '12 months')::int AS done_12m,
                ROUND(AVG(EXTRACT(EPOCH FROM (m.completed_at - m.created_at)) / 86400)
                      FILTER (WHERE m.completed_at IS NOT NULL)::numeric, 1) AS avg_days,
                ROUND(AVG(m.actual_cost) FILTER (WHERE m.actual_cost IS NOT NULL)::numeric, 2) AS avg_cost
           FROM maintenance_requests m WHERE m.landlord_id = $1`, [id])
      out.maintenance = {
        openNow: r.open,
        completedLast12Months: r.done_12m,
        averageDaysToComplete: numOrNull(r.avg_days),
        averageCost: numOrNull(r.avg_cost),
      }
    }

    // S618 (Nic): "I want the agent to be able to basically read any data points
    // from the landlord's portfolio and kind of put together a customized
    // report." These are the rest of what the platform actually records about a
    // landlord's own book — money in and out, what deposits cost at move-out,
    // how applications convert, what short stays bring in, and inspections.
    if (want.includes('money')) {
      const [r] = await query<any>(
        `SELECT
           (SELECT COALESCE(SUM(amount),0) FROM landlord_expenses
             WHERE landlord_id=$1 AND voided_at IS NULL
               AND expense_date >= CURRENT_DATE - INTERVAL '12 months') AS expenses,
           (SELECT COALESCE(SUM(amount),0) FROM landlord_other_income
             WHERE landlord_id=$1 AND voided_at IS NULL
               AND income_date >= CURRENT_DATE - INTERVAL '12 months') AS other_income,
           (SELECT COALESCE(SUM(amount),0) FROM payments
             WHERE landlord_id=$1 AND type='rent' AND status='settled'
               AND settled_at >= CURRENT_DATE - INTERVAL '12 months') AS rent_collected`,
        [id])
      const rent = Number(r.rent_collected), exp = Number(r.expenses), other = Number(r.other_income)
      if (exp === 0) missing.push('no expenses have been recorded, so there is no cost side to this')
      out.money = {
        windowMonths: 12,
        rentCollected: rent,
        otherIncome: other,
        expensesRecorded: exp,
        net: Math.round((rent + other - exp) * 100) / 100,
        netNote: exp === 0
          ? 'Net equals income because no expenses are on file — it is NOT a profit figure.'
          : 'Income minus the expenses recorded on the platform. Off-platform costs are not included.',
      }
    }

    if (want.includes('deposits')) {
      const [r] = await query<any>(
        `SELECT COUNT(*) FILTER (WHERE finalized_at IS NOT NULL)::int AS settled,
                ROUND(AVG(total_deductions) FILTER (WHERE finalized_at IS NOT NULL)::numeric, 2) AS avg_deduction,
                ROUND(AVG(refund_amount)   FILTER (WHERE finalized_at IS NOT NULL)::numeric, 2) AS avg_refund,
                COUNT(*) FILTER (WHERE finalized_at IS NOT NULL AND total_deductions = 0)::int AS fully_refunded
           FROM deposit_returns WHERE landlord_id = $1`, [id])
      if (r.settled === 0) missing.push('no deposit has been settled at move-out yet, so there is no deduction history')
      out.deposits = {
        settledAtMoveOut: r.settled,
        averageDeduction: numOrNull(r.avg_deduction),
        averageRefunded: numOrNull(r.avg_refund),
        fullyRefunded: r.fully_refunded,
        fullyRefundedPct: pct(r.fully_refunded, r.settled),
      }
    }

    if (want.includes('applications')) {
      const [r] = await query<any>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
                COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
                ROUND(AVG(monthly_income)::numeric, 2) AS avg_income
           FROM unit_applications WHERE landlord_id = $1`, [id])
      if (r.total === 0) missing.push('no applications have come through the platform yet')
      out.applications = {
        received: r.total, approved: r.approved, rejected: r.rejected,
        approvalRatePct: pct(r.approved, r.total),
        averageApplicantMonthlyIncome: numOrNull(r.avg_income),
      }
    }

    if (want.includes('bookings')) {
      const [r] = await query<any>(
        `SELECT COALESCE(SUM(nights),0)::int AS nights,
                COALESCE(SUM(total_amount),0)::numeric AS revenue,
                COUNT(*)::int AS bookings,
                ROUND(AVG(nightly_rate)::numeric, 2) AS avg_nightly
           FROM unit_bookings
          WHERE landlord_id = $1 AND status NOT IN ('cancelled','no_show')`, [id])
      out.bookings = {
        bookings: r.bookings,
        nightsBooked: r.nights,
        shortStayRevenue: numOrNull(r.revenue),
        averageNightlyRate: numOrNull(r.avg_nightly),
      }
    }

    if (want.includes('inspections')) {
      const [r] = await query<any>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE finalized_at IS NOT NULL)::int AS finalized,
                COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND finalized_at IS NULL)::int AS outstanding
           FROM unit_inspections WHERE landlord_id = $1`, [id])
      out.inspections = {
        total: r.total, finalized: r.finalized, outstanding: r.outstanding,
      }
    }

    // S617's lesson, restated for this tool. Handed a set of aggregates, this
    // model will helpfully invent the breakdown it thinks should accompany them
    // — day-range buckets, per-tenant splits, a trend line. A landlord can act
    // on any of it. Saying plainly what is NOT here is cheaper than catching
    // every shape of embellishment afterwards.
    out.whatThisDoesNotContain =
      'No per-tenant or per-property breakdown, no day-range buckets, no month-by-month trend, no ' +
      'forecast, and no comparison to other landlords. Report only the figures above. For the ' +
      'month-by-month late history use get_late_payment_history; for named tenants use ' +
      'get_delinquent_tenants or lookup_tenant_payment_status.'
    if (missing.length) {
      out.notRecorded = missing
      out.notRecordedNote =
        'A null value means the platform has no data for it — say it is not on file. Never estimate it.'
    }
    return out
  },
}
