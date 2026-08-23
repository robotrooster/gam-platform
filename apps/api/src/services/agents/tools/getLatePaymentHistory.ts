/**
 * Tool: get_late_payment_history (landlord).
 *
 * S617 (Nic): "money questions can be answered by the agent — late fees at this
 * property are this much, here's a history of how many people have paid late on
 * your property each month and the average, that sort of thing. Real money
 * MOVEMENT needs a real person."
 *
 * That distinction is the whole point of this tool. Asking how often tenants pay
 * late is a QUESTION about money and the agent should answer it; moving money is
 * a hard stop that goes to a human. Before this the agent had no way to answer
 * it and would either decline or, worse, estimate — which on a "how many paid
 * late" question means inventing a number a landlord might act on.
 *
 * "Late" means settled (or still unsettled) AFTER the grace period the lease
 * itself sets, not after the due date. A 5-day grace is a term of the lease, so
 * rent arriving on the 4th is on time, and counting it as late would overstate
 * the problem on every property that grants one.
 *
 * Measured on settled_at — when the money actually landed — not on when a
 * payment was initiated. A tenant who starts an ACH on the 1st and has it clear
 * on the 6th paid on time; the lateness of the RAIL is not the tenant's.
 */
import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface MonthRow {
  month: string
  due_count: string
  late_count: string
  avg_days_late: string | null
}

export const getLatePaymentHistory: AgentTool = {
  name: 'get_late_payment_history',
  description:
    'How often this landlord’s tenants pay rent late, by month: how many rent charges were due, ' +
    'how many were paid (or remain unpaid) after the lease’s grace period, the percentage, and ' +
    'the average days late. Use for “how many people pay late?”, “what’s my late rate”, ' +
    '“are tenants paying on time”, “late payment history”. Read-only, this landlord only. ' +
    'This is a QUESTION about money and you should answer it — moving or refunding money is not.',
  parameters: {
    type: 'object',
    properties: {
      months: { type: 'integer', description: 'How many months back (default 6, max 24).' },
    },
  },
  audiences: ['landlord'],

  async execute(args: Record<string, unknown>, actor: AgentActor) {
    const raw = Number(args.months)
    const months = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 24) : 6

    const rows = await query<MonthRow>(
      `SELECT to_char(date_trunc('month', p.due_date), 'YYYY-MM') AS month,
              COUNT(*)::text AS due_count,
              COUNT(*) FILTER (
                WHERE COALESCE(p.settled_at, NOW())
                      > p.due_date + (COALESCE(l.late_fee_grace_days, 0) || ' days')::interval
              )::text AS late_count,
              ROUND(AVG(
                EXTRACT(EPOCH FROM (
                  COALESCE(p.settled_at, NOW())
                  - (p.due_date + (COALESCE(l.late_fee_grace_days, 0) || ' days')::interval)
                )) / 86400
              ) FILTER (
                WHERE COALESCE(p.settled_at, NOW())
                      > p.due_date + (COALESCE(l.late_fee_grace_days, 0) || ' days')::interval
              ), 1)::text AS avg_days_late
         FROM payments p
         JOIN leases l ON l.id = p.lease_id
        WHERE p.landlord_id = $1
          AND p.type = 'rent'
          AND p.due_date >= date_trunc('month', CURRENT_DATE) - ($2 || ' months')::interval
          AND p.due_date <= CURRENT_DATE
        GROUP BY 1
        ORDER BY 1 DESC`,
      [actor.profileId, months]
    )

    if (rows.length === 0) {
      return { ok: true, months: [], note: 'No rent charges due in that period yet, so there is no late-payment history to report.' }
    }

    const totalDue = rows.reduce((n, r) => n + Number(r.due_count), 0)
    const totalLate = rows.reduce((n, r) => n + Number(r.late_count), 0)

    return {
      ok: true,
      graceNote: 'Late means after the grace period on that tenant’s own lease, not after the due date.',
      // S617: asked "what's my late payment rate", the model took these monthly
      // figures and invented a distribution out of them — "<10 days late: 12%
      // (1 out of 8 tenants)", buckets and a tenant count that appear nowhere
      // here. A landlord could act on that. Saying plainly what this does NOT
      // contain is cheaper than trying to catch every shape of embellishment
      // afterwards.
      whatThisDoesNotContain:
        'No day-range buckets, no per-tenant breakdown, no tenant counts, no trend or forecast. ' +
        'Report the months and the overall figures as given. If asked for a breakdown by tenant, ' +
        'say it is not in this data and offer the delinquent-tenants list instead.',
      months: rows.map((r) => ({
        month: r.month,
        rentChargesDue: Number(r.due_count),
        paidLate: Number(r.late_count),
        pctLate: Number(r.due_count) > 0
          ? Math.round((Number(r.late_count) / Number(r.due_count)) * 100) : 0,
        avgDaysLate: r.avg_days_late == null ? null : Number(r.avg_days_late),
      })),
      overall: {
        rentChargesDue: totalDue,
        paidLate: totalLate,
        pctLate: totalDue > 0 ? Math.round((totalLate / totalDue) * 100) : 0,
      },
    }
  },
}
