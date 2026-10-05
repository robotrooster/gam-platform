/**
 * Tool: get_my_balance_breakdown (tenant READ).
 *
 * S552: answers "where did my payment go?" and "what exactly do I owe?"
 * with the FIFO application detail — open charges oldest-first (the order
 * payments apply, S537) plus the tenant's recent remittances with their
 * per-line application (which charge each dollar landed on, and any
 * pay-ahead credit). Mirrors GET /payments/balance-context and
 * GET /payments/remittances, read-only.
 *
 * S655 (money plan, Step 11): "what is owed" is the one rule every screen
 * reads (services/openBalances.openBalanceSql). A payment still clearing is
 * not owed; a bounce is owed once, on the row the reversal reopened (never the
 * 'returned' original as well); a work-trade line and GAM's FlexPay pull are
 * never owed. Each line is named for what it is ("Water", "Electric"). The
 * total is the FULL balance — every open charge, however many are listed —
 * with the credit that could pay it beside it.
 *
 * One household balance (S652): the open charges are the household's — billed
 * to the tenant, or on a lease they are on now, whoever it is billed to
 * (openBalances.householdRowSql). Lease charges carry the primary resident's
 * id, so a co-tenant read by payments.tenant_id alone was told they owed
 * nothing while Pay Now quoted the lease's bill. The receipts are the tenant's
 * own, as on the portal's receipts (GET /payments/remittances): a receipt
 * belongs to the person who paid, and each one lists every charge it paid,
 * a co-tenant's included.
 */

import { query } from '../../../db'
import { openBalanceSql, openAmountSql, householdRowSql, creditBeside, tenantCompanies } from '../../openBalances'
import { chargeLabel, chargeDetail, chargeLabelColumnsSql } from '../../invoiceNotice'
import type { AgentTool, AgentActor } from './types'

/** How many open charges are listed, oldest first (the total counts them all). */
export const LISTED_CHARGES = 40

export const getMyBalanceBreakdown: AgentTool = {
  name: 'get_my_balance_breakdown',
  description:
    'The tenant’s open charges OLDEST-FIRST (the order payments are applied — oldest balances are always paid ' +
    'first) and their recent payments with a per-dollar breakdown of which charge each payment covered, ' +
    'including any pay-ahead credit. Use for “where did my payment go?”, “why am I still marked late?”, or a ' +
    'detailed “what do I owe?”. Read-only.\n' +
    'totalOwed is the FULL balance. creditAvailable is credit they can choose to use when they pay — it is NOT ' +
    'taken off totalOwed; say both.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    // The oldest 40 are LISTED (the model reads them out); the total is summed
    // over every open charge, so it always equals the Outstanding page and
    // get_my_payment_status however many charges are open.
    const openCharges = await query<any>(
      `SELECT p.id, ${openAmountSql('p')}::float AS amount, p.due_date::text AS due_date, p.type,
              p.entry_description, p.status, p.notes, ${chargeLabelColumnsSql('p')}
         FROM payments p
        WHERE ${householdRowSql('p', '$1')}
          AND ${openBalanceSql('p')}
          AND ${openAmountSql('p')} > 0
        ORDER BY p.due_date ASC, p.created_at ASC, p.id
        LIMIT ${LISTED_CHARGES}`,
      [actor.profileId]
    )
    const owed = await query<{ total: string; count: string }>(
      `SELECT COALESCE(SUM(${openAmountSql('p')}), 0)::text AS total, COUNT(*)::text AS count
         FROM payments p
        WHERE ${householdRowSql('p', '$1')}
          AND ${openBalanceSql('p')}
          AND ${openAmountSql('p')} > 0`,
      [actor.profileId]
    )
    const remits = await query<any>(
      `SELECT id, amount::float AS amount,
              applied_amount::float AS applied_amount,
              unapplied_amount::float AS unapplied_amount,
              status, payment_method, created_at
         FROM tenant_remittances
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 5`,
      [actor.profileId]
    )
    let lines: any[] = []
    if (remits.length > 0) {
      lines = await query<any>(
        `SELECT ra.remittance_id, ra.amount_applied::float AS amount_applied,
                p.type, p.due_date::text AS due_date, p.entry_description
           FROM remittance_applications ra
           JOIN payments p ON p.id = ra.payment_id
          WHERE ra.remittance_id = ANY($1)
          ORDER BY p.due_date ASC`,
        [remits.map((r) => r.id)]
      ).catch(() => [])
    }
    const totalOwed = Math.round(Number(owed[0]?.total ?? 0) * 100) / 100
    const openChargeCount = Number(owed[0]?.count ?? 0)
    const credit = await creditBeside({ tenantId: actor.profileId, landlordIds: await tenantCompanies(actor.profileId) })
    return {
      ok: true,
      totalOwed,
      openChargeCount,
      // More open charges than are listed: totalOwed still counts every one.
      ...(openChargeCount > openCharges.length ? { moreChargesNotListed: openChargeCount - openCharges.length } : {}),
      creditAvailable: credit.usable,
      creditOnAccount: credit.onFile,
      openChargesOldestFirst: openCharges.map((c) => ({
        id: c.id, amount: Number(c.amount), due_date: c.due_date, type: c.type,
        entry_description: c.entry_description, status: c.status,
        label: chargeLabel(c), detail: chargeDetail(c),
      })),
      recentPayments: remits.map((r) => ({
        ...r,
        appliedTo: lines.filter((l) => l.remittance_id === r.id),
      })),
      note:
        'Payments always apply to the OLDEST open charge first (never chosen per charge), so a payment can ' +
        'settle an old balance while a newer charge stays open. totalOwed is the full balance. Credit is used ' +
        'by itself only when it covers a whole bill; otherwise the tenant chooses "Use all" or "Save it for ' +
        'later" when they pay, so creditAvailable is beside the balance, not taken off it.',
    }
  },
}
