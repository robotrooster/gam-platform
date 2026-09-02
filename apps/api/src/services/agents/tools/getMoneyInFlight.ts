/**
 * Tool: get_money_in_flight (landlord). Rent tenants have already PAID that has
 * not landed in the landlord's account yet.
 *
 * WHY THIS EXISTS (Nic, S624). Asked "who owes me money?", the agent read out a
 * tenant whose payment was already on its way. S620 had removed 'processing'
 * from the delinquency list, which stopped the wrong answer — but silence is not
 * the right answer either. A landlord looking at a rent roll with a gap in it
 * wants to know whether that gap is a debt or a bank delay, and those are
 * opposite situations: one needs chasing, the other needs nothing at all.
 *
 * Nic: "the agent should be able to tell the landlord, hey, these are gonna be
 * the payments in this disbursement so far totaling this, which is scheduled on
 * this date."
 *
 * An ACH debit sits in `processing` for days after the tenant's account was
 * debited — 6 and 11 days on the two real ones. For that whole window the money
 * exists, is committed, and is invisible. This makes it visible.
 *
 * Hard-scoped to the landlord's own receivables.
 */

import { query } from '../../../db'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

interface Row {
  first_name: string | null
  last_name: string | null
  unit_number: string | null
  amount: string
  type: string
  due_date: string | null
  initiated_at: string | null
  days_clearing: number
}

export const getMoneyInFlight: AgentTool = {
  name: 'get_money_in_flight',
  description:
    'Rent the landlord’s tenants have already PAID that is still clearing the bank and has not been ' +
    'paid out yet — who paid, how much, when they paid it, and the total. Use for "what is on its ' +
    'way?", "what is in my next payout so far?", "has anyone paid that has not landed yet?", and ' +
    'whenever a tenant appears unpaid but may simply be mid-transfer. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],
  async execute(_args, actor: AgentActor) {
    const rows = await query<Row>(
      // 'processing' is the whole point: the tenant's account is debited and the
      // transfer is in the banking system. 'pending' means nobody has paid, and
      // must never be counted here — that WOULD be the wrong answer in the other
      // direction.
      `SELECT us.first_name, us.last_name, u.unit_number,
              p.amount::text AS amount, p.type,
              to_char(p.due_date,'YYYY-MM-DD') AS due_date,
              -- WHEN THE TENANT ACTUALLY PAID, which is not on the payment row:
              -- the payments table has no updated_at, and its created_at is when
              -- the CHARGE was raised, often weeks earlier. The remittance is the
              -- payment attempt, so its created_at is the real initiation date.
              -- Falling back to the charge's own date would report a tenant as
              -- "clearing for 34 days" the moment they paid a month-old invoice.
              to_char(COALESCE(ra.paid_at, p.created_at),'YYYY-MM-DD') AS initiated_at,
              GREATEST(0, (CURRENT_DATE - COALESCE(ra.paid_at, p.created_at)::date))::int
                AS days_clearing
         FROM payments p
         JOIN tenants t ON t.id = p.tenant_id
         JOIN users us ON us.id = t.user_id
         LEFT JOIN units u ON u.id = p.unit_id
         LEFT JOIN LATERAL (
           SELECT r.created_at AS paid_at
             FROM remittance_applications rapp
             JOIN tenant_remittances r ON r.id = rapp.remittance_id
            WHERE rapp.payment_id = p.id
            ORDER BY r.created_at DESC LIMIT 1
         ) ra ON TRUE
        WHERE p.landlord_id = ANY($1::uuid[]) AND p.status = 'processing'
        ORDER BY COALESCE(ra.paid_at, p.created_at)`,
      [actorLandlordIds(actor)])

    if (rows.length === 0) {
      return {
        ok: true, count: 0, total: 0,
        note: 'Nothing is mid-transfer right now — every payment that has been made has already cleared.',
      }
    }

    const total = Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100
    // The oldest one is what a landlord actually worries about: a bank transfer
    // that has been clearing for a fortnight is worth a look, one from Tuesday
    // is not.
    const oldest = Math.max(...rows.map(r => r.days_clearing))

    return {
      ok: true,
      count: rows.length,
      total,
      oldestDaysClearing: oldest,
      payments: rows.map(r => ({
        tenant: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Tenant',
        unit: r.unit_number ?? undefined,
        amount: Number(r.amount),
        kind: r.type,
        dueDate: r.due_date ?? undefined,
        paidOn: r.initiated_at ?? undefined,
        daysClearing: r.days_clearing,
      })),
      // Said in words so the agent frames it correctly rather than reading a
      // list of numbers at someone.
      note:
        `These tenants have already paid — the money is moving through the bank and will be included in a ` +
        `payout once it clears. It is NOT overdue and these tenants are not behind. Bank transfers ` +
        `typically clear in a few business days; longer is normal on a tenant's first payment from a new account.`,
      payoutNote:
        'Payouts batch on Fridays, so anything that clears before then goes out in that batch. Use get_my_payouts for what has already been sent.',
    }
  },
}
