/**
 * Tool: get_my_payment_status (tenant).
 *
 * Reads the logged-in tenant's recent payments and what their household owes
 * right now. Scoped to actor.profileId: the charges billed to them, plus every
 * charge on a lease they are on now (openBalances.householdRowSql — one
 * household balance, S652). Lease charges carry the primary resident's id, so
 * a co-tenant read by payments.tenant_id alone was told they owed nothing while
 * Pay Now quoted the lease's bill. Nobody else's charges, and nobody else's
 * FlexPay payment (that is the person's own arrangement with GAM).
 *
 * S655 (money plan, Step 11): "what they owe" is the one rule every screen
 * reads (services/openBalances.openBalanceSql). It used to sum every row in
 * pending, processing, failed or returned, so a payment still clearing was
 * quoted as owed, a bounce counted twice (the 'returned' original AND the row
 * the reversal reopened), and GAM's own FlexPay pull showed up as rent. Money
 * in flight is reported on its own; credit is beside the balance, never taken
 * off it.
 */

import { query } from '../../../db'
import {
  openBalanceSql, openAmountSql, inFlightRowSql, inFlightMoneySql, householdRowSql, creditBeside, tenantCompanies,
} from '../../openBalances'
import type { AgentTool, AgentActor } from './types'

interface PaymentRow {
  type: string
  amount: string
  status: string
  due_date: string | null
  processed_at: string | null
  for_flexpay: boolean
}

export const getMyPayments: AgentTool = {
  name: 'get_my_payment_status',
  description:
    'Look up the tenant’s recent payments and current outstanding balance (rent, fees, ' +
    'utilities). Use this for questions like “did my rent go through?”, “what do I owe?”, or ' +
    '“when was my last payment?”. Read-only — it cannot move money or take a payment.\n' +
    'outstandingBalance is the FULL household balance (the figure Pay Now quotes). inFlight is already paid and still clearing — not owed. ' +
    'creditAvailable is credit they can choose to use when they pay; it is NOT taken off the balance. ' +
    'A recent payment with forFlexPay is their own FlexPay payment to GAM, never part of outstandingBalance.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many recent payments to return (default 8, max 20).' },
    },
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const rawLimit = Number(args.limit)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20) : 8

    // The household's history ("did my rent go through?" — whoever on the
    // lease paid it), and the tenant's own FlexPay payment to GAM (it is
    // theirs: "did my FlexPay payment go through?"). A co-tenant's FlexPay
    // payment is that person's own arrangement and is never listed here. A
    // FlexPay payment is never part of what they owe (openBalanceSql below),
    // and it is marked so it is never read out as a bill.
    const rows = await query<PaymentRow>(
      `SELECT p.type, p.amount, p.status, p.due_date, p.processed_at,
              (p.entry_description IS NOT DISTINCT FROM 'FLEXPAY') AS for_flexpay
         FROM payments p
        WHERE ${householdRowSql('p', '$1')}
          AND (p.entry_description IS DISTINCT FROM 'FLEXPAY' OR p.tenant_id = $1)
        ORDER BY COALESCE(p.due_date, p.created_at::date) DESC, p.created_at DESC, p.id
        LIMIT $2`,
      [actor.profileId, limit]
    )

    // What the household owes: the figure Pay Now quotes (one household balance).
    const owed = await query<{ outstanding: string | null; count: string }>(
      `SELECT COALESCE(SUM(${openAmountSql('p')}), 0) AS outstanding, COUNT(*) AS count
         FROM payments p
        WHERE ${householdRowSql('p', '$1')} AND ${openBalanceSql('p')} AND ${openAmountSql('p')} > 0`,
      [actor.profileId]
    )
    // Already paid, still clearing: a card or bank payment on its way.
    const flight = await query<{ in_flight: string | null }>(
      `SELECT COALESCE(SUM(${inFlightMoneySql('p')}), 0) AS in_flight
         FROM payments p
        WHERE ${householdRowSql('p', '$1')}
          AND ${inFlightRowSql('p')}`,
      [actor.profileId]
    )
    const credit = await creditBeside({ tenantId: actor.profileId, landlordIds: await tenantCompanies(actor.profileId) })

    return {
      ok: true,
      outstandingBalance: Math.round(Number(owed[0]?.outstanding ?? 0) * 100) / 100,
      outstandingItemCount: Number(owed[0]?.count ?? 0),
      inFlight: Math.round(Number(flight[0]?.in_flight ?? 0) * 100) / 100,
      creditAvailable: credit.usable,
      // Explicit empty signal so the model states the truth ("no payments
      // on record yet") instead of inventing that a past payment cleared.
      note: rows.length === 0 ? 'No payments are on record for this tenant yet.' : undefined,
      recentPayments: rows.map((r) => ({
        type: r.type,
        amount: Number(r.amount),
        status: r.status,
        dueDate: r.due_date,
        processedAt: r.processed_at,
        ...(r.for_flexpay ? { forFlexPay: true } : {}),
      })),
    }
  },
}
