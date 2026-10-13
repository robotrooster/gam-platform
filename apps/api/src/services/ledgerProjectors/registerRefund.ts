/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: A REGISTER REFUND POSTS ITSELF
 * (gam-ledger-design-2026-10-12 §6 F3; Nic's 10/12 answer G10)
 *
 * Source 'pos_refund' = one pos_refunds row the register's own Refund wrote
 * (POST /pos/transactions/:id/refund): money handed back in cash or by check,
 * on the refund's day (the sale's property calendar). One posting:
 *
 *   Dr Sales returns (4520)      the goods' share, before tax       } Received
 *   Dr Stay income (4400)        a stay's share, before tax         } goes down
 *   Dr Sales / lodging tax       the tax given back (tax_refunded,  } that day
 *        payable (2040 / 2042)   split like the sale's own taxes)   } ('refunds')
 *   Dr Card fees refunded (5117) the card fee the customer paid on top of a card
 *                                sale, given back with it (card_fee_refunded) —
 *                                Nic G10: "the customer gets the card fee back
 *                                too; the landlord eats that fee"
 *   Cr Undeposited funds (1040)  cash out of the drawer
 *   Cr Outstanding checks (2015) a check written (the bank line that clears it
 *                                matches it later)
 *
 * The before-tax part is split between goods and the stays the sale paid in
 * the sale's own proportions. A stay refunded here comes off stay income on the
 * refund's day, like an early check-out's refund part (design D4): what the
 * guest paid is earned on the booking's schedule (bookingStay) and every refund
 * is its own event on its own day.
 *
 * Not here:
 *   - a refund written for an early check-out part (stay_refund_part_id): the
 *     part is the source that posts it (design D4, refund_part);
 *   - a store charge-account refund ('charge'): charge accounts are not enabled
 *     (design F7); it waits;
 *   - a card refund outside an early check-out: no such path exists; it waits.
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import {
  cr, dr, toCents, splitCents, taxLines, scaleTaxParts, loadSale, saleMakeUp, missingFact, waitsOnRule,
  localDaySql, propertyTzSql,
} from './registerBookingPayoutKit'

export const registerRefundProjector: LedgerProjector = {
  sourceType: 'pos_refund',
  ruleVersion: 1,

  async project(client: PoolClient, refundId: string): Promise<DesiredPosting[]> {
    const r = (await client.query<{
      id: string; transaction_id: string; landlord_id: string; amount: string; refund_method: string
      card_fee_refunded: string; tax_refunded: string | null; stay_refund_part_id: string | null; day: string
    }>(
      `SELECT r.id, r.transaction_id, r.landlord_id, r.amount::text, r.refund_method, r.card_fee_refunded::text,
              r.tax_refunded::text, r.stay_refund_part_id,
              ${localDaySql('r.created_at', propertyTzSql('t.property_id', 't.landlord_id'))} AS day
         FROM pos_refunds r JOIN pos_transactions t ON t.id = r.transaction_id
        WHERE r.id::text = $1`, [refundId])).rows[0]
    if (!r) return []
    // An early check-out's refund part posts its own money (design D4).
    if (r.stay_refund_part_id) return []
    if (r.refund_method === 'charge') {
      throw waitsOnRule('A store charge-account refund posts once charge accounts are enabled (design F7); nothing is posted for it yet.')
    }
    if (r.refund_method !== 'cash' && r.refund_method !== 'check') {
      throw waitsOnRule(`A register refund paid back by ${r.refund_method} outside an early check-out has no posting rule.`)
    }
    if (r.tax_refunded == null) throw missingFact('The refund does not say how much tax it gave back (pos_refunds.tax_refunded).')
    const sale = await loadSale(client, r.transaction_id)
    if (!sale) throw missingFact('The refund\'s sale is gone.')
    const mk = await saleMakeUp(client, sale)

    const amount = toCents(r.amount)
    const tax = toCents(r.tax_refunded)
    const feeBack = toCents(r.card_fee_refunded)
    const beforeTax = amount - tax - feeBack
    const at = { propertyId: sale.property_id, tenantId: sale.tenant_id }
    const back = { cashEffect: 'in' as const, reportCategory: 'refunds' as const }

    // Goods and stays, in the sale's own proportions.
    const parts = splitCents(beforeTax, [Math.max(0, mk.goodsPreTaxCents), ...mk.stays.map(s => Math.max(0, s.preTaxCents))])
    const lines: DesiredLine[] = []
    lines.push(...dr('sales_returns', parts[0] ?? 0, { ...at, ...back, memo: 'Register refund' }))
    mk.stays.forEach((s, i) => {
      lines.push(...dr('stay_income', parts[i + 1] ?? 0, {
        propertyId: s.propertyId ?? sale.property_id, unitId: s.unitId, tenantId: s.tenantId ?? sale.tenant_id,
        ...back, memo: 'Stay money refunded at the register',
      }))
    })
    lines.push(...taxLines(scaleTaxParts(mk.taxParts, tax), 'dr', { ...at, cashEffect: 'in', reportCategory: 'tax_collected' }))
    lines.push(...dr('card_fees_refunded', feeBack, { ...at, memo: 'Card fee given back with a refund' }))
    lines.push(...cr(r.refund_method === 'cash' ? 'undeposited_funds' : 'outstanding_checks', amount, {
      ...at, memo: r.refund_method === 'cash' ? 'Refund paid from the drawer' : 'Refund paid by check',
    }))

    return [{ owner: { landlordId: r.landlord_id }, intendedDate: r.day, memo: 'Register refund', lines }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const rows = await client.query<{ id: string; day: string }>(
      `SELECT r.id::text AS id, ${localDaySql('r.created_at', propertyTzSql('t.property_id', 't.landlord_id'))} AS day
         FROM pos_refunds r JOIN pos_transactions t ON t.id = r.transaction_id
        WHERE r.landlord_id = $1 AND ($2::date IS NULL OR r.created_at >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return rows.rows
  },
}
