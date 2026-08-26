/**
 * Tool: get_work_trade_status (landlord). Every active work-trade agreement,
 * with who is on track and who is not.
 *
 * The landlord-side counterpart to the tenant's get_work_trade_standing, reading
 * the same ledger so the two audiences can never be told different numbers about
 * the same agreement.
 *
 * Nic's reason for the whole subsystem (S624): "I have people that do work trade
 * now that, some don't seem to do as much as others, and keeping track of it all
 * on paper is outdated." So the useful answer is comparative — not just hours
 * logged, but who is behind, by how much, and whether it can still be caught up.
 *
 * `catchUpPlausible` is the one a landlord acts on: at some point a tenant is far
 * enough behind that no realistic month of work clears it, and that is a decision
 * to make rather than a number to watch drift.
 */

import { query } from '../../../db'
import { loadWorkTradeStanding } from '../../workTradeStanding'
import type { AgentTool, AgentActor } from './types'

export const getWorkTradeStatus: AgentTool = {
  name: 'get_work_trade_status',
  description:
    'All active work-trade agreements for this landlord: each tenant\'s hours target, hours worked ' +
    'this month, hours carried over from earlier months, what they would owe in cash if the hours ' +
    'are never worked, and whether catching up is still realistic. Use for "who is behind on their ' +
    'work trade?", "how is everyone doing on hours?", "is anyone never going to catch up?". Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],
  async execute(_args, actor: AgentActor) {
    const rows = await query<any>(
      `SELECT wta.id, wta.monthly_hours_target, wta.carry_forward_months,
              wta.banked_hours::float AS banked_hours,
              u.unit_number,
              TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')) AS tenant_name
         FROM work_trade_agreements wta
         JOIN units u ON u.id = wta.unit_id
         JOIN tenants t ON t.id = wta.tenant_id
         JOIN users usr ON usr.id = t.user_id
        WHERE wta.landlord_id = $1 AND wta.status = 'active'
        ORDER BY u.unit_number`,
      [actor.profileId])

    if (rows.length === 0) {
      return { ok: true, count: 0, note: 'No active work-trade agreements.' }
    }

    const agreements = await Promise.all(rows.map(async (r: any) => {
      const s = await loadWorkTradeStanding(r.id)
      return {
        tenant: r.tenant_name || 'Tenant',
        unit: r.unit_number,
        monthlyHoursTarget: Number(r.monthly_hours_target),
        graceMonths: Number(r.carry_forward_months),
        hoursThisMonth: s?.currentMonthHours ?? null,
        hoursCarriedOver: s?.carriedHours ?? 0,
        hoursToBeStraight: s?.catchUpHours ?? null,
        hoursBanked: s?.bankedHours ?? Number(r.banked_hours),
        valueIfNotWorked: s?.carriedValue ?? 0,
        // The figure worth acting on.
        catchUpStillRealistic: s?.catchUpPlausible ?? true,
        nextBillingMonth: s?.nextBillingMonth ?? null,
      }
    }))

    const behind = agreements.filter(a => a.hoursCarriedOver > 0)
    return {
      ok: true,
      count: agreements.length,
      behindCount: behind.length,
      cannotRealisticallyCatchUp: agreements.filter(a => !a.catchUpStillRealistic).length,
      agreements,
    }
  },
}
