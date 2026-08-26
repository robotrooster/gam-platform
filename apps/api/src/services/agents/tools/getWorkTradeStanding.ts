/**
 * Tool: get_work_trade_standing (tenant). Where this tenant stands on their
 * work-trade agreement, in HOURS.
 *
 * WHY THIS EXISTS. Asked "I have an 80-hour agreement and only worked 60 this
 * month — what happens?", Ava answered "I've got nothing on that one." The
 * runner correctly classified it as an account-data question and demanded a
 * tool; there was no work-trade tool to call, so it refused rather than guess.
 * The knowledge base could have described the rule generically, but a tenant
 * asking about THEIR hours wants their own numbers — and the customer-rep test
 * says anything tenant-specific is looked up, never recalled.
 *
 * Hard-scoped to actor.profileId through work_trade_agreements.tenant_id, so a
 * tenant can only ever see their own agreement. Returns hours and dollars but no
 * landlord-side detail: what the landlord's leniency setting is, what the
 * agreement earns them, or anything about other tenants.
 */

import { query } from '../../../db'
import { loadWorkTradeStanding } from '../../workTradeStanding'
import type { AgentTool, AgentActor } from './types'

export const getWorkTradeStanding: AgentTool = {
  name: 'get_work_trade_standing',
  description:
    'Where the tenant stands on their work-trade agreement: hours their current month asks for, ' +
    'hours carried over from earlier months, the total that would get them completely straight, ' +
    'hours they have banked by working ahead, and what any unworked hours would cost if billed. ' +
    'Use for "how many hours do I still owe?", "what happens if I only work 60 of my 80 hours?", ' +
    '"am I behind on my work trade?". Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],
  async execute(_args, actor: AgentActor) {
    const rows = await query<{ id: string; monthly_hours_target: number; status: string }>(
      `SELECT id, monthly_hours_target, status
         FROM work_trade_agreements
        WHERE tenant_id = $1 AND status = 'active'
        ORDER BY start_date DESC LIMIT 1`,
      [actor.profileId])
    if (rows.length === 0) {
      return { ok: true, hasAgreement: false, note: 'This tenant has no active work-trade agreement.' }
    }

    const standing = await loadWorkTradeStanding(rows[0].id)
    if (!standing) {
      return {
        ok: true, hasAgreement: true, monthlyHoursTarget: Number(rows[0].monthly_hours_target),
        note: 'The agreement is active but this month has not been billed yet, so there is nothing to work off.',
      }
    }

    return {
      ok: true,
      hasAgreement: true,
      monthlyHoursTarget: Number(rows[0].monthly_hours_target),
      hoursThisMonth: standing.currentMonthHours,
      hoursCarriedOver: standing.carriedHours,
      hoursToBeStraight: standing.catchUpHours,
      hoursBanked: standing.bankedHours,
      valueOfCarriedHours: standing.carriedValue,
      summary: standing.summary,
      // Said explicitly so the agent never implies a late fee on a shortfall —
      // work trade invoices are late-fee exempt, and a billed remainder joins
      // the carried-balance track, which is payable in part.
      shortfallNeverTakesLateFees: true,
      shortfallPayableInPart: true,
    }
  },
}
