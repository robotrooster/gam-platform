/**
 * Tool: get_unreconciled_cash (landlord). Both halves of "where does my cash
 * stand?" in one answer.
 *
 * A landlord taking cash and checks has two open questions and they are the same
 * question from opposite ends: money that ARRIVED in the bank that nothing has
 * been attributed to, and money marked COLLECTED IN PERSON that never reached
 * the bank. Answering only one of them invites the wrong conclusion — an
 * unmatched deposit looks alarming until you see the collection it pairs with.
 *
 * The second half is a control, not a convenience (Nic S624): staff collect cash
 * and mark each tenant paid, the deposit posts days later, and nothing ever
 * checked the two against each other. Collect $3,000, bank $2,750, and that is a
 * $250 gap with names attached.
 *
 * IT REPORTS AND NEVER ACCUSES. Cash legitimately sits in a drawer over a
 * weekend and a deposit legitimately spans two days of collection, so the tool
 * returns figures and ages and leaves the judgement to a person. Hard-scoped to
 * the landlord's own records.
 */

import { query } from '../../../db'
import { cashBankingPosition } from '../../cashBankingControl'
import { unmatchedDepositsWithCandidates } from '../../bankDepositCandidates'
import type { AgentTool, AgentActor } from './types'

export const getUnreconciledCash: AgentTool = {
  name: 'get_unreconciled_cash',
  description:
    'Where the landlord\'s cash stands: bank deposits that have not been matched to any tenant\'s ' +
    'rent yet (with who they might belong to), and rent marked collected in person that no bank ' +
    'deposit has accounted for. Use for "is there money in my account I have not accounted for?", ' +
    '"did the office bank what it collected?", "what deposits still need matching?". Read-only.',
  parameters: {
    type: 'object',
    properties: {
      graceDays: {
        type: 'integer',
        description: 'How many days a collection may sit before it counts as outstanding (default 3).',
      },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const connected = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM bank_connections
        WHERE landlord_id = $1 AND status = 'active'`, [actor.profileId])
    if (parseInt(connected[0]?.n ?? '0', 10) === 0) {
      return {
        ok: true,
        bankConnected: false,
        // Say what is missing and why, rather than reporting an empty result
        // that reads like "nothing outstanding".
        note: 'No bank is linked, so GAM cannot see deposits at all. Linking the operating bank is what lets cash deposits be matched to rent automatically.',
      }
    }

    const raw = Number(args.graceDays)
    const graceDays = Number.isFinite(raw) ? Math.min(30, Math.max(0, Math.trunc(raw))) : 3
    const [position, deposits] = await Promise.all([
      cashBankingPosition(actor.profileId, { graceDays }),
      unmatchedDepositsWithCandidates(actor.profileId, 25),
    ])

    return {
      ok: true,
      bankConnected: true,
      depositsAwaitingMatch: deposits.deposits.length,
      depositsNotListed: deposits.remaining,
      deposits: deposits.deposits.slice(0, 10).map(d => ({
        amount: d.amount,
        postedDate: d.postedDate,
        // The top candidates only — a shortlist is for a screen, not a sentence.
        likelyFrom: d.candidates.slice(0, 3).map(c => ({
          tenant: c.tenantName, unit: c.unitNumber, why: c.reason,
        })),
        needsAPersonToChoose: d.candidates.length > 1,
      })),
      collectedNotBanked: {
        count: position.unbanked.length,
        total: position.unbankedTotal,
        oldestDays: position.oldestDays,
        items: position.unbanked.slice(0, 10).map(u => ({
          tenant: u.tenantName, unit: u.unitNumber, amount: u.amount,
          collectedOn: u.collectedOn, daysOutstanding: u.daysOutstanding,
        })),
      },
      // Stated so the agent frames it as a prompt to check rather than a finding.
      caveat: 'Cash can legitimately sit uncollected over a weekend, and one deposit can cover several days of collection. These figures are a prompt to check, not a discrepancy on their own.',
    }
  },
}
