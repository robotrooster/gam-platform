/**
 * S648 — THE one way a register sale is written.
 *
 * The counter (POST /pos/transactions) and an emailed pay link that a customer
 * pays later (routes/posPayLinks.ts) both record a sale; two copies of these
 * writes would drift the way the two register UIs once did (S570). Extracted
 * verbatim from the transactions route. Runs on the caller's open transaction.
 */
import type { PoolClient } from 'pg'
import { recordHeldItem } from './heldPayouts'

export interface PosSaleInput {
  landlordId: string
  propertyId: string | null
  cashierId: string
  paymentMethod: string
  tenantId?: string | null
  posCustomerId?: string | null
  subtotal: number
  taxAmount: number
  surcharge: number
  total: number
  changeGiven?: number
  platformFee?: number
  stripePaymentIntentId?: string | null
  discountAmount?: number
  discountReason?: string | null
  // S648: set when a card sale landed on GAM's platform account — what GAM owes
  // the landlord for it (total less the card fee), paid in the weekly batch.
  payoutOwed?: number
  items: Array<{ id?: string | null; name: string; cat?: string; category?: string; qty: number; price: number; tax?: number; tax_rate?: number }>
  /** S650: the taxes charged, by name — "Lodging tax $3.11", not one "Tax" line. */
  taxBreakdown?: { name: string; rate: number; amount: number }[] | null
}

/**
 * What GAM owes the landlord for a sale. Only a card sale charged on GAM's
 * account (it carries a PaymentIntent) puts money in GAM's hands; the card fee
 * on top is GAM's cut, the rest is the landlord's. Cash is already in the
 * drawer and a store charge hasn't been paid yet.
 */
export function cardPayoutOwed(s: Pick<PosSaleInput, 'paymentMethod' | 'stripePaymentIntentId' | 'total' | 'surcharge' | 'payoutOwed'>): number {
  if (s.paymentMethod !== 'card' || !s.stripePaymentIntentId) return 0
  const owed = s.payoutOwed ?? (Number(s.total) - Number(s.surcharge || 0))
  return Math.max(0, Math.round(owed * 100) / 100)
}

/**
 * Inserts the sale, its lines, and the stock movement. Returns the transaction
 * row and the catalog items that fell to their reorder point (the caller drafts
 * purchase orders after commit, best-effort). Throws the raw unique-violation
 * when this PaymentIntent was already recorded, so callers can treat a retry as
 * a no-op.
 */
export async function insertPosSale(client: PoolClient, s: PosSaleInput): Promise<{ tx: any; needsPO: any[] }> {
  const txRes = await client.query(`INSERT INTO pos_transactions
    (landlord_id,tenant_id,pos_customer_id,cashier_id,payment_method,subtotal,tax_amount,surcharge,total,change_given,platform_fee,stripe_payment_intent_id,property_id,discount_amount,discount_reason,tax_breakdown)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) RETURNING *`,
    [s.landlordId, s.tenantId || null, s.posCustomerId || null, s.cashierId,
     s.paymentMethod, s.subtotal, s.taxAmount, s.surcharge, s.total, s.changeGiven || 0, s.platformFee || 0,
     s.stripePaymentIntentId || null, s.propertyId || null, s.discountAmount || 0, s.discountReason || null,
     s.taxBreakdown && s.taxBreakdown.length ? JSON.stringify(s.taxBreakdown) : null])
  const tx = txRes.rows[0]
  const needsPO: any[] = []
  // S648: a card sale's money is GAM's to hold until the weekly payout.
  const owed = cardPayoutOwed(s)
  if (owed > 0) {
    await recordHeldItem({
      landlordId: s.landlordId, sourceType: 'pos_sale', sourceId: tx.id,
      amount: owed, description: 'Register card sale',
    }, client)
  }

  // Insert line items and decrement stock.
  // S70: scope the item lookup to the calling landlord — pre-S70 a
  // landlord could submit a transaction referencing another landlord's
  // pos_items UUID and decrement their stock.
  for (const item of s.items) {
    const dbItem = item.id
      ? await client.query<any>(
          'SELECT * FROM pos_items WHERE id=$1 AND landlord_id=$2',
          [item.id, s.landlordId],
        ).then(r => r.rows[0] ?? null)
      : null

    await client.query(`INSERT INTO pos_transaction_items
      (transaction_id,item_id,item_name,item_category,qty,unit_price,cost_price,tax_rate,subtotal)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tx.id, item.id || null, item.name, item.cat || item.category || 'misc',
       item.qty, item.price, dbItem?.cost_price || 0, item.tax || item.tax_rate || 0,
       item.price * item.qty])

    // Decrement stock if tracked (not 999)
    if (dbItem && dbItem.stock_qty < 999) {
      const newQty = Math.max(0, dbItem.stock_qty - item.qty)
      await client.query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, dbItem.id])
      await client.query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,reference_id,stock_before,stock_after)
        VALUES ($1,$2,$3,'sale',$4,$5,$6)`,
        [dbItem.id, s.landlordId, -item.qty, tx.id, dbItem.stock_qty, newQty])
      // Pre-decrement snapshot, matching the original semantics
      // (reorderQty = stock_max - stock_qty).
      if (newQty <= dbItem.stock_min && dbItem.vendor_id) needsPO.push(dbItem)
    }
  }
  return { tx, needsPO }
}
