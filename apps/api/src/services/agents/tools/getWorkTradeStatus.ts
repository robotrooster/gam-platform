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
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

export const getWorkTradeStatus: AgentTool = {
  name: 'get_work_trade_status',
  description:
    'Every live work-trade agreement for this landlord, running or paused: each tenant\'s hours ' +
    'target, hours worked this month, hours carried over from earlier months, what they would owe ' +
    'in cash if the hours are never worked, and whether catching up is still realistic. A paused ' +
    'row says whether its hours are still counting — a paused trade whose space is still being ' +
    'used keeps counting, and one whose space is empty asks for nothing. Use for "who is behind on ' +
    'their work trade?", "how is everyone doing on hours?", "is anyone never going to catch up?". ' +
    'Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],
  async execute(_args, actor: AgentActor) {
    const { liveTenancySql } = await import('../../workTradeStanding')
    const rows = await query<any>(
      `SELECT wta.id, wta.monthly_hours_target, wta.carry_forward_months,
              wta.banked_hours::float AS banked_hours,
              wta.status,
              u.unit_number,
              TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,'')) AS tenant_name
         FROM work_trade_agreements wta
         JOIN units u ON u.id = wta.unit_id
         JOIN tenants t ON t.id = wta.tenant_id
         JOIN users usr ON usr.id = t.user_id
        WHERE wta.landlord_id = ANY($1::uuid[]) AND wta.status IN ('active','paused')
          -- 10/19 (review): a PAUSED row only while the tenancy is still there.
          -- A lease ending with no successor pauses the trade and nothing ever
          -- ends it, so without this the landlord's assistant reads out a space
          -- nobody lives on as a live agreement with hours counting. Same gate
          -- as the tenant's side (liveTenancySql) — the two sides of a trade
          -- reading different rosters is what this subsystem exists to prevent.
          AND ${liveTenancySql()}
        ORDER BY u.unit_number`,
      [actorLandlordIds(actor)])

    if (rows.length === 0) {
      return { ok: true, count: 0, note: 'No live work-trade agreements.' }
    }

    const agreements = await Promise.all(rows.map(async (r: any) => {
      const s = await loadWorkTradeStanding(r.id)
      return {
        tenant: r.tenant_name || 'Tenant',
        unit: r.unit_number,
        // 10/19 (Nic, "Show it while paused"): the tenant's own tool and portal
        // now show a paused agreement, so this one shows it too — a landlord
        // and their tenant reading different stories about the same space is
        // the argument this subsystem exists to prevent. The target follows the
        // same rule as the tenant's: none while nobody is counting.
        paused: s?.paused ?? (r.status === 'paused'),
        hoursBeingCounted: s?.hoursCounted ?? true,
        monthlyHoursTarget: s && !s.hoursCounted ? 0 : Number(r.monthly_hours_target),
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
