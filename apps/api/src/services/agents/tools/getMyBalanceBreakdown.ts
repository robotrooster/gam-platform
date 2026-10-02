/**
 * Tool: get_my_balance_breakdown (tenant READ).
 *
 * S552: answers "where did my payment go?" and "what exactly do I owe?"
 * with the FIFO application detail — open charges oldest-first (the order
 * payments apply, S537) plus the tenant's recent remittances with their
 * per-line application (which charge each dollar landed on, and any
 * pay-ahead credit). Mirrors GET /payments/balance-context and
 * GET /payments/remittances, read-only.
 */

import { query } from '../../../db'
import { netTenantLeaseBalances, type TenantLeaseGroup } from '../../openBalances'
import type { AgentTool, AgentActor } from './types'

export const getMyBalanceBreakdown: AgentTool = {
  name: 'get_my_balance_breakdown',
  description:
    'The tenant’s open charges OLDEST-FIRST (the order payments are applied — oldest balances are always paid ' +
    'first) and their recent payments with a per-dollar breakdown of which charge each payment covered, ' +
    'including any pay-ahead credit. Use for “where did my payment go?”, “why am I still marked late?”, or a ' +
    'detailed “what do I owe?”. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    // S654: the SAME open charges the tenant's portal sums (GET
    // /payments/balance-context), netted the same way — paid-ahead first, then
    // the landlord's credit — so the agent never quotes MH 25's gross $460 while
    // the portal and the bill email say $450. A 'returned' row is not listed: a
    // bounced payment reopens as a fresh pending row (paymentReversal's
    // two-row model), and counting both owed the same dollars twice. A
    // work-trade suspended line is paid in hours, never asked of the tenant.
    const open = await query<any>(
      `SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type,
              p.entry_description, p.status, p.lease_id, p.landlord_id, p.invoice_id,
              inv.service_agreement_id
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         JOIN properties pr ON pr.id = u.property_id
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
        WHERE p.tenant_id = $1
          AND p.work_trade_suspended_at IS NULL
          AND ((p.status = 'pending' AND p.stripe_payment_intent_id IS NULL)
               OR p.status = 'failed')
        ORDER BY p.due_date ASC, p.created_at ASC`,
      [actor.profileId]
    )
    const groups = new Map<string | null, TenantLeaseGroup>()
    let serviceOwed = 0
    for (const r of open) {
      if (r.service_agreement_id != null) { serviceOwed += r.amount; continue }
      let g = groups.get(r.lease_id)
      if (!g) { g = { leaseId: r.lease_id, landlordId: r.landlord_id, outstanding: 0, rows: [] }; groups.set(r.lease_id, g) }
      g.outstanding = Math.round((g.outstanding + r.amount) * 100) / 100
      g.rows.push(r)
    }
    const net = await netTenantLeaseBalances(actor.profileId, [...groups.values()])
    const sum = (f: (n: { prepaidApplied: number; creditApplied: number; outstanding: number }) => number) =>
      Math.round([...net.values()].reduce((s, n) => s + f(n), 0) * 100) / 100
    const openCharges = open.slice(0, 40).map((r: any) => ({
      id: r.id, amount: r.amount, due_date: r.due_date, type: r.type,
      entry_description: r.entry_description, status: r.status,
    }))
    // S626: a payment the bank sent back is still owed — the tenant must not be
    // told otherwise. Its 'returned' row is listed here so the agent can say why
    // the bill reopened; the dollars themselves are owed on the fresh pending
    // row the reversal wrote, already in totalOwed, so they are not added twice.
    const bounced = await query<any>(
      `SELECT p.amount::float AS amount, p.due_date::text AS due_date, p.type
         FROM payments p
        WHERE p.tenant_id = $1 AND p.status = 'returned'
        ORDER BY p.due_date DESC
        LIMIT 5`,
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
    const totalBeforeCredits = Math.round(open.reduce((s: number, c: any) => s + c.amount, 0) * 100) / 100
    return {
      ok: true,
      // What the tenant owes now — the figure their portal shows.
      totalOwed: Math.round((sum(n => n.outstanding) + serviceOwed) * 100) / 100,
      totalBeforeCredits,
      paidAheadApplied: sum(n => n.prepaidApplied),
      accountCreditApplied: sum(n => n.creditApplied),
      openChargesOldestFirst: openCharges,
      bouncedPaymentsOwedAgain: bounced,
      recentPayments: remits.map((r) => ({
        ...r,
        appliedTo: lines.filter((l) => l.remittance_id === r.id),
      })),
      note:
        'Payments always apply to the OLDEST open charge first (never chosen per charge), so a payment can ' +
        'settle an old balance while a newer charge stays open. Unapplied remainder is pay-ahead credit toward ' +
        'the next charge. totalOwed is after money paid ahead and any account credit come off — quote that ' +
        'figure, not the sum of the charges. A bounced payment is owed again and is already inside totalOwed.',
    }
  },
}
