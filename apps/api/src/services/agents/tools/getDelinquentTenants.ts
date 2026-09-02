/**
 * Tool: get_delinquent_tenants (landlord). Lists the landlord's OWN tenants
 * with past-due unpaid rent/fees. Hard-scoped to actor.profileId
 * (payments.landlord_id) — only this landlord's receivables.
 */

import { query } from '../../../db'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

interface Row {
  first_name: string | null
  last_name: string | null
  email: string | null
  overdue: string
  items: string
  oldest_due: string | null
  kind: 'returned' | 'never_attempted'
  return_reasons: string | null
  last_attempt: string | null
}

interface FlightRow { in_flight: string | null; payers: string }

/**
 * Unpaid + past due = behind.
 *
 * S620 (Nic): "when the tenant pays and the agent on the tenant side says that
 * they owe no money, at that same time that balance needs to show as pending
 * for the landlord... our back end settling period doesn't matter to the
 * landlord."
 *
 * 'processing' USED TO BE IN THIS LIST and it was the only place on the
 * platform that counted a tenant who had paid as still owing. A bank payment
 * sits in 'processing' for days AFTER the tenant's account was debited, so a
 * landlord asking "who owes me money?" was handed people who had already paid
 * — and the agent read it out to them. Nic found his own $2 on that list.
 *
 * Everywhere else already agrees that sending it counts: the payout engine
 * (payoutTriggers.rollProgressForLandlordUser counts settled + processing +
 * paid_via_deposit), the late-fee engine's postmark rule, the tenant's own
 * balance, portfolio stats, and the portfolio query. This line was the outlier.
 *
 * 'returned' and 'failed' STAY. Those are payments that came back or never
 * went through — that money really is still owed.
 */
const UNPAID = ['pending', 'failed', 'returned']

export const getDelinquentTenants: AgentTool = {
  name: 'get_delinquent_tenants',
  description:
    'Who is behind on rent, SPLIT BY WHY. Returns two groups: tenants who have not attempted a ' +
    'payment at all, and tenants whose payment was RETURNED or failed (with the bank’s reason and ' +
    'when they tried). Also reports how much is separately IN FLIGHT — already paid and still ' +
    'clearing — so nobody mid-transfer is described as behind. Use for “who’s behind on rent?”, ' +
    '“who owes me money?”, “who hasn’t paid?”. Read-only; scoped to this landlord’s own tenants.\n' +
    'REPORT THE TWO GROUPS DIFFERENTLY — they are different problems and need different actions. ' +
    'Someone who has not attempted anything needs a nudge. Someone whose ACH came back has already ' +
    'tried to pay you, so say so plainly — "Frank tried an ACH on the 3rd and it was returned" — ' +
    'and give the reason if the bank supplied one. Never lump them together as "behind".\n' +
    'If anything is in flight, say so in the same breath, with the figure. A landlord who hears ' +
    'only the overdue number thinks they are short money that is already on its way.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many tenants (default 25, max 100).' } } },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 25
    const rows = await query<Row>(
      `SELECT us.first_name, us.last_name, us.email,
              CASE WHEN p.status IN ('failed','returned') THEN 'returned' ELSE 'never_attempted' END AS kind,
              SUM(p.amount) AS overdue, COUNT(*) AS items, MIN(p.due_date) AS oldest_due,
              -- The bank's own words, where it gave any. A landlord chasing a
              -- returned payment needs to know whether it was insufficient
              -- funds or a closed account; those are different conversations.
              NULLIF(STRING_AGG(DISTINCT COALESCE(p.return_reason, p.return_code), '; '), '') AS return_reasons,
              MAX(COALESCE(p.processed_at, p.last_retry_at)) AS last_attempt
         FROM payments p
         JOIN tenants t ON t.id = p.tenant_id
         JOIN users us ON us.id = t.user_id
        WHERE p.landlord_id = ANY($1::uuid[]) AND p.status = ANY($2) AND p.due_date < now()
        GROUP BY us.first_name, us.last_name, us.email,
                 CASE WHEN p.status IN ('failed','returned') THEN 'returned' ELSE 'never_attempted' END
        ORDER BY overdue DESC
        LIMIT $3`,
      [actorLandlordIds(actor), UNPAID, limit]
    )

    // S626 (Nic): "The $8 ACH was not stuck. It was paid. Money was already out
    // of my bank account, and the agent still told the landlord that person
    // hadn't paid yet."
    //
    // Read in the same call, deliberately. The landlord asked one question and
    // the honest answer needs both halves — S620 took 'processing' OUT of the
    // overdue list, which stopped the false accusation, but left the money
    // invisible unless somebody thought to ask a second question. Nobody asks a
    // second question. So the overdue figure now always arrives with the
    // in-flight figure beside it.
    const flight = await query<FlightRow>(
      `SELECT SUM(p.amount) AS in_flight, COUNT(DISTINCT p.tenant_id) AS payers
         FROM payments p
        WHERE p.landlord_id = ANY($1::uuid[]) AND p.status = 'processing'`,
      [actorLandlordIds(actor)]
    )
    const inFlight = Number(flight[0]?.in_flight ?? 0)
    const payers = Number(flight[0]?.payers ?? 0)

    const shape = (r: Row) => ({
      name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
      email: r.email,
      amountOverdue: Number(r.overdue),
      pastDueItems: Number(r.items),
      oldestDueDate: r.oldest_due,
    })
    const returned = rows.filter((r) => r.kind === 'returned').map((r) => ({
      ...shape(r),
      theyDidTryToPay: true,
      lastAttempt: r.last_attempt,
      bankReason: r.return_reasons,
    }))
    // NOT `=== 'never_attempted'`. Anything that is not explicitly a returned
    // payment lands here, so a row that fails to classify is still REPORTED.
    // Matching both groups positively meant an unclassified row belonged to
    // neither and vanished from the answer entirely — a delinquent tenant
    // silently dropped from "who owes me money?" is the worst outcome this tool
    // has, and it would never have shown up as an error.
    const neverAttempted = rows.filter((r) => r.kind !== 'returned').map(shape)

    return {
      ok: true,
      count: returned.length + neverAttempted.length,
      // Two groups, never one list. See the tool description.
      paymentReturned: returned,
      noPaymentAttempted: neverAttempted,
      moneyInFlight: { amount: inFlight, tenants: payers },
      note:
        returned.length + neverAttempted.length === 0
          ? (inFlight > 0
              ? `Nobody is past due. $${inFlight.toFixed(2)} from ${payers} tenant(s) is still clearing the bank.`
              : 'No tenants are currently past due.')
          : inFlight > 0
            ? `Mention this too: $${inFlight.toFixed(2)} from ${payers} tenant(s) has already been paid and is still clearing — it is NOT overdue and those tenants are not behind.`
            : undefined,
    }
  },
}
