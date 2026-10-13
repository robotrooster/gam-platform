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
 * 10/12 (Nic): "Payment health = ONE definition everywhere, per HOUSEHOLD per
 * BILL MONTH, never per line." This answers from services/householdMonths,
 * the figure the Rent Roll, the tenant report and the Tenants list show: one
 * judgment per household per month on its whole bill (rent, utilities, fees,
 * the home payment — a late fee is never a bill), late = not paid in full by
 * the last grace day (the lease's grace, else the property's, else 5 — a blank
 * lease grace used to read as 0 days here), days late = days past the grace
 * period, a month work trade covers counts as on time, voided and $0 lines
 * never count, the onboarding month good news only. A month still inside its
 * grace period is not judged yet.
 */
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'
import { householdMonths, currentBillMonth, addMonths } from '../../householdMonths'

export const getLatePaymentHistory: AgentTool = {
  name: 'get_late_payment_history',
  description:
    'How often this landlord’s tenants pay late, by month: how many households were billed, ' +
    'how many did not pay their whole bill by the end of its grace period, the percentage, and ' +
    'the average days past grace. Use for “how many people pay late?”, “what’s my late rate”, ' +
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

    const through = currentBillMonth()
    const judged = (await householdMonths({
      landlordIds: actorLandlordIds(actor), from: addMonths(through, -months), through,
    })).filter(m => m.counted)
    const byMonth = new Map<string, { due: number; late: number; lateDays: number }>()
    for (const m of judged) {
      const e = byMonth.get(m.month) ?? { due: 0, late: 0, lateDays: 0 }
      e.due++
      if (!m.on_time) { e.late++; e.lateDays += m.days_past_grace }
      byMonth.set(m.month, e)
    }
    const rows = [...byMonth.entries()].sort(([a], [z]) => z.localeCompare(a))
      .map(([month, e]) => ({ month, due: e.due, late: e.late, avg: e.late ? Math.round((e.lateDays / e.late) * 10) / 10 : null }))

    if (rows.length === 0) {
      return { ok: true, months: [], note: 'No household’s bill has been judged in that period yet (nothing due, or still inside its grace period), so there is no late-payment history to report.' }
    }

    const totalDue = rows.reduce((n, r) => n + r.due, 0)
    const totalLate = rows.reduce((n, r) => n + r.late, 0)

    return {
      ok: true,
      graceNote: 'Each household’s whole monthly bill, judged after its grace period (the lease’s, else the property’s, else 5 days). Days late are days past the grace period.',
      // S617: asked "what's my late payment rate", the model took these monthly
      // figures and invented a distribution out of them — "<10 days late: 12%
      // (1 out of 8 tenants)", buckets and a tenant count that appear nowhere
      // here. A landlord could act on that. Saying plainly what this does NOT
      // contain is cheaper than trying to catch every shape of embellishment
      // afterwards.
      whatThisDoesNotContain:
        'No day-range buckets, no per-tenant breakdown, no trend or forecast. ' +
        'Report the months and the overall figures as given. If asked for a breakdown by tenant, ' +
        'say it is not in this data and offer the delinquent-tenants list instead.',
      months: rows.map((r) => ({
        month: r.month,
        householdsBilled: r.due,
        paidLate: r.late,
        pctLate: r.due > 0 ? Math.round((r.late / r.due) * 100) : 0,
        avgDaysPastGrace: r.avg,
      })),
      overall: {
        householdsBilled: totalDue,
        paidLate: totalLate,
        pctLate: totalDue > 0 ? Math.round((totalLate / totalDue) * 100) : 0,
      },
    }
  },
}
