/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: A PAYMENT GAM SET ASIDE
 * (gam-ledger-design-2026-10-12 §6 F5)
 *
 * Source 'pos_held' = one pos_held_payments row: a pay-link payment GAM set
 * aside instead of recording it as a sale (paid twice, the wrong amount, more
 * than was owed, a deposit part). While it is set aside it is not the
 * landlord's money, so it posts nothing. When the owner refunds it, Stripe
 * keeps its processing fee — the landlord's cost, never GAM's (decisions #22):
 * GAM takes it from their next payout (a negative 'refund' payout line, which
 * posts nothing of its own, design G4). This posts that cost on the refund's
 * day (the held payment's property calendar):
 *
 *   Dr Processing fees (5115)   stripe_fee_kept
 *   Cr Due from GAM (1050)
 */
import type { PoolClient } from 'pg'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { cr, dr, toCents, localDaySql, propertyTzSql } from './registerBookingPayoutKit'

export const registerHeldProjector: LedgerProjector = {
  sourceType: 'pos_held',
  ruleVersion: 1,

  async project(client: PoolClient, heldId: string): Promise<DesiredPosting[]> {
    const h = (await client.query<{ landlord_id: string; property_id: string | null; status: string; fee: string | null; day: string | null }>(
      `SELECT h.landlord_id, h.property_id, h.status, h.stripe_fee_kept::text AS fee,
              CASE WHEN h.refunded_at IS NULL THEN NULL
                   ELSE ${localDaySql('h.refunded_at', propertyTzSql('h.property_id', 'h.landlord_id'))} END AS day
         FROM pos_held_payments h WHERE h.id::text = $1`, [heldId])).rows[0]
    if (!h || h.status !== 'refunded' || !h.day) return []
    const fee = toCents(h.fee)
    if (fee <= 0) return []
    const at = { propertyId: h.property_id }
    return [{
      owner: { landlordId: h.landlord_id },
      intendedDate: h.day,
      memo: 'Card processing fee kept on a payment given back',
      lines: [
        ...dr('processing_fees', fee, { ...at, memo: 'Stripe kept its fee on a refunded payment' }),
        ...cr('due_from_gam', fee, { ...at, memo: 'Taken from your next payout' }),
      ],
    }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT h.id::text AS id,
              CASE WHEN h.refunded_at IS NULL THEN NULL
                   ELSE ${localDaySql('h.refunded_at', propertyTzSql('h.property_id', 'h.landlord_id'))} END AS day
         FROM pos_held_payments h
        WHERE h.landlord_id = $1 AND ($2::date IS NULL OR COALESCE(h.refunded_at, h.created_at) >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}
