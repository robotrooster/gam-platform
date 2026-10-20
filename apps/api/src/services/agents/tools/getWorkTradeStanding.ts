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
 * tenant can only ever see their own agreement. Returns HOURS and no landlord-
 * side detail: what the landlord's leniency setting is, what the agreement earns
 * them, or anything about other tenants.
 *
 * S643 (Nic, DIRECTIVE) — AND NO DOLLAR FIGURE. "Leave the hours for tracking.
 * Don't show the tenant any sort of hourly rate — that's when they decide it's
 * not worth it. They're bad at calculation, some people think they're getting
 * three dollars an hour in rent but they forget all the conveniences they get
 * along the way."
 *
 * This tool used to take the default (landlord) view, so it handed Ava both the
 * hour count and what those hours were worth — the one place that number would
 * have been SPOKEN rather than merely displayed. Hours and dollars in the same
 * answer is an hourly rate whether or not anyone calls it one.
 */

import { query } from '../../../db'
import { loadWorkTradeStanding } from '../../workTradeStanding'
import type { AgentTool, AgentActor } from './types'

export const getWorkTradeStanding: AgentTool = {
  name: 'get_work_trade_standing',
  description:
    'Where the tenant stands on their work-trade agreement: hours their current month asks for, ' +
    'hours carried over from earlier months, the total that would get them completely straight, ' +
    'and hours they have banked by working ahead; and any extra hours beyond the trade (banked, or ' +
    'paid separately by the landlord). ' +
    'Answer in hours — never quote a dollar value or a per-hour rate for work-trade labor. The one ' +
    'exception is PAID extra hours, whose rate and amount the tenant may be told. ' +
    'Also says whether the agreement is PAUSED and whether its hours are still counting — and, '
    + 'when it is paused, that a bill dated during the pause is not covered by the trade. ' +
    'Use for "how many hours do I still owe?", "what happens if I only work 60 of my 80 hours?", ' +
    '"am I behind on my work trade?", "is my work trade paused?", "do my hours still count while ' +
    'I am away for the season?". Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],
  async execute(_args, actor: AgentActor) {
    // 10/19 (Nic, "Show it while paused") — A PAUSED TRADE IS STILL THEIRS.
    //
    // This asked for the ACTIVE agreement, so Ava told a snowbird whose trade
    // was paused for the season that they had no work-trade agreement at all —
    // while their hours may well have been counting the whole time. Paused is
    // not ended: the month close itself works on both (CLOSE_STATUSES), and
    // Nic's answer was to show it while paused and say which situation they are
    // in. ENDED stays out; its hours were billed when it ended.
    //
    // 10/19 (review): and leaving 'ended' out is not the whole gate, because a
    // MOVE-OUT produces 'paused', not 'ended' (jobs/scheduler pauses the trade
    // when a lease ends with no successor, and nothing ever ends it). So the
    // tenancy is checked, not just the word.
    //
    // The same widening as the tenant portal's own route
    // (routes/tenants /work-trade), and the same preference: a tenant with a
    // paused seasonal trade and a running one is asked about the running one.
    //
    // 10/19 (review): and a PAUSED one only while the tenancy is still there.
    // The lease-end processor pauses a work trade on move-out and nothing ever
    // ends it, so without liveTenancySql Ava answers "your hours keep counting"
    // to somebody who moved out a month ago. Same gate as the tenant portal's
    // own route, from the same helper, so the tab and the assistant can never
    // disagree about whether a trade is theirs to read.
    const { liveTenancySql } = await import('../../workTradeStanding')
    const rows = await query<{ id: string; monthly_hours_target: number; status: string }>(
      `SELECT wta.id, wta.monthly_hours_target, wta.status
         FROM work_trade_agreements wta
        WHERE wta.tenant_id = $1 AND wta.status IN ('active','paused')
          AND ${liveTenancySql()}
        ORDER BY (wta.status = 'active') DESC, wta.start_date DESC LIMIT 1`,
      [actor.profileId])
    if (rows.length === 0) {
      return { ok: true, hasAgreement: false, note: 'This tenant has no work-trade agreement.' }
    }
    const paused = rows[0].status === 'paused'

    const standing = await loadWorkTradeStanding(rows[0].id, undefined, 'tenant')
    if (!standing) {
      return {
        ok: true, hasAgreement: true, paused,
        monthlyHoursTarget: Number(rows[0].monthly_hours_target),
        note: paused
          ? 'The agreement is paused and this month has not been billed yet, so there is nothing to work off.'
          : 'The agreement is active but this month has not been billed yet, so there is nothing to work off.',
      }
    }

    return {
      ok: true,
      hasAgreement: true,
      // 10/19: said as plain facts rather than a status word, because the one
      // thing the tenant needs is which situation they are in. `summary` below
      // is the sentence for it, and it is the same sentence the landlord's
      // screen and the month close agree with (services/workTradeStanding).
      paused: standing.paused,
      hoursBeingCounted: standing.hoursCounted,
      // 10/19: NO TARGET WHILE NOBODY IS COUNTING. A paused trade on an empty
      // space, or one the landlord never clocks, asks for no hours — so quoting
      // the agreement's 80 would hand somebody six states away a number they
      // are failing at a job nobody asked them to do. Everything else below is
      // already zero for the same reason.
      monthlyHoursTarget: standing.hoursCounted ? Number(rows[0].monthly_hours_target) : 0,
      hoursThisMonth: standing.currentMonthHours,
      hoursCarriedOver: standing.carriedHours,
      hoursToBeStraight: standing.catchUpHours,
      hoursBanked: standing.bankedHours,
      summary: standing.summary,
      // 10/19: the paused rule, in the agent's own hands. Both halves matter:
      // never invent a bill for a month nobody counted, and never let a paused
      // trade sound like a holiday from hours that are in fact still counting.
      ...(standing.paused ? {
        pausedNote: standing.hoursCounted
          ? 'This work trade is paused, and hours are STILL counting on the months already '
            + 'billed under it: each of those months asks for its hours as usual and the part '
            + 'nobody works stays owed on that month\'s own bill. Say so plainly. While it stays '
            + 'paused that shortfall is never turned into a separate charge of its own and the '
            + 'agreement is never ended over it.'
          : 'This work trade is paused and no hours are being counted, so there is no target to '
            + 'meet and nothing is falling behind. The months already billed under it are covered '
            + 'at the next month close. Never quote an hours target or suggest they are behind.',
        // 10/19 (review): the one thing a pause does NOT do, and the agent must
        // not imply otherwise in either branch. The billing run only covers a
        // RUNNING agreement (services/workTradeCredit
        // loadWorkTradeCreditContext), so a month billed during the pause has no
        // settlement period, nothing is suspended, and that bill is owed in cash
        // — no hour worked that month can credit it either. Ava telling somebody
        // their rent is not billed while paused and then a full invoice arriving
        // is the worst version of this.
        pausedBillingNote:
          'While it stays paused, a new month\'s bill is NOT covered by the trade: it goes out at '
          + 'its full amount and is owed like any other bill. Never tell them a bill dated during '
          + 'the pause is covered, waived or settled by their hours. If they ask what to do about '
          + 'it, tell them to talk to their landlord about starting the agreement again.',
      } : {}),
      // Said explicitly so the agent never implies a late fee on a shortfall —
      // work trade invoices are late-fee exempt, and a billed remainder joins
      // the carried-balance track, which is payable in part.
      shortfallNeverTakesLateFees: true,
      shortfallPayableInPart: true,
      // S643: said to the model, not just enforced in the payload. Asked "so
      // what's an hour worth?" the agent has nothing to divide and is told not
      // to work it out.
      doNotQuoteAnHourlyRate:
        'Work trade is measured in hours, not wages. Do not state or estimate a ' +
        'dollar value per hour, and do not compute one from the bill. If asked, ' +
        'say the hours cover the month\'s charges and point them to their invoice.',
      // 10/12 (Nic): hours worked BEYOND the trade. Banked ones are hours only.
      // Paid ones carry the rate and amount the landlord pays for extra hours —
      // Nic: the tenant may see those — and nothing else here does.
      extraHours: (standing.extraHours?.recent ?? []).map(e => ({
        month: e.periodMonth,
        hours: e.hours,
        ...(e.how === 'paid'
          ? { paidSeparatelyByLandlord: true, extraHoursRate: e.rate, amount: e.amount,
              paid: e.status === 'paid' }
          : { banked: true }),
      })),
      extraHoursSummary: standing.extraHours?.summary ?? null,
      extraHoursNote:
        'Extra hours are hours worked beyond what the work trade needed. Banked extra hours are ' +
        'hours only. Paid extra hours are paid separately by the landlord at the rate shown — you may ' +
        'state that rate and amount for EXTRA hours only. It is not what a work-trade hour is worth; ' +
        'never apply it to the trade hours.',
    }
  },
}
