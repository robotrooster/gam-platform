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
import { recordPlatformRevenueOnceCommitted, type CommittedBookingOutcome } from './platformRevenue'
import { query } from '../db'
import { logger } from '../lib/logger'

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
  // S653: the customer paid this on an emailed link, not at the counter.
  paidOnline?: boolean
  items: Array<{ id?: string | null; name: string; cat?: string; category?: string; qty: number; price: number; tax?: number; tax_rate?: number }>
  /** S650: the taxes charged, by name — "Lodging tax $3.11", not one "Tax" line. */
  taxBreakdown?: { name: string; rate: number; amount: number }[] | null
}

/**
 * What GAM owes the landlord for a sale. Only a card sale charged on GAM's
 * account (it carries a PaymentIntent) puts money in GAM's hands; the card fee
 * on top is GAM's cut, the rest is the landlord's. Cash is already in the
 * drawer and a store charge hasn't been paid yet.
 *
 * 10/4 (early check-out plan, BUG-A): a card ON FILE is charged on GAM's
 * account too (services/posCardOnFile — the saved card lives on GAM's platform
 * customer), so its sale is owed to the landlord the same way. It used to
 * return 0 for 'card_on_file': the money landed on GAM's balance and the
 * landlord was never paid for it (and a refund of such a sale would have
 * netted against a payout that was never credited).
 */
export function cardPayoutOwed(s: Pick<PosSaleInput, 'paymentMethod' | 'stripePaymentIntentId' | 'total' | 'surcharge' | 'payoutOwed'>): number {
  if ((s.paymentMethod !== 'card' && s.paymentMethod !== 'card_on_file') || !s.stripePaymentIntentId) return 0
  const owed = s.payoutOwed ?? (Number(s.total) - Number(s.surcharge || 0))
  return Math.max(0, Math.round(owed * 100) / 100)
}

/**
 * 10/3: GAM's card fee on a card sale that landed on GAM's account (it carries
 * a PaymentIntent): the counter's card or card on file, or a pay link. It is
 * the sale's platform fee — GAM's fee is always taken, whether the customer
 * paid it on top or the landlord covered it — never a cash or store-account
 * sale's.
 */
export function cardSaleGamFee(s: Pick<PosSaleInput, 'paymentMethod' | 'stripePaymentIntentId' | 'platformFee' | 'surcharge'>): number {
  if ((s.paymentMethod !== 'card' && s.paymentMethod !== 'card_on_file') || !s.stripePaymentIntentId) return 0
  const fee = Number(s.platformFee ?? s.surcharge ?? 0)
  return fee > 0 ? Math.round(fee * 100) / 100 : 0
}

/**
 * Inserts the sale, its lines, and the stock movement. Returns the transaction
 * row and the catalog items that fell to their reorder point (the caller drafts
 * purchase orders after commit, best-effort). Throws the raw unique-violation
 * when this PaymentIntent was already recorded, so callers can treat a retry as
 * a no-op.
 */
export async function insertPosSale(client: PoolClient, s: PosSaleInput): Promise<{
  tx: any; needsPO: any[]
  /** GAM's card fee on the sale, booked once the sale commits (resolves then; nothing to wait on for callers). */
  cardFeeBooked: Promise<CommittedBookingOutcome | 'no_fee'>
}> {
  const txRes = await client.query(`INSERT INTO pos_transactions
    (landlord_id,tenant_id,pos_customer_id,cashier_id,payment_method,subtotal,tax_amount,surcharge,total,change_given,platform_fee,stripe_payment_intent_id,property_id,discount_amount,discount_reason,tax_breakdown,paid_online)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17) RETURNING *`,
    [s.landlordId, s.tenantId || null, s.posCustomerId || null, s.cashierId,
     s.paymentMethod, s.subtotal, s.taxAmount, s.surcharge, s.total, s.changeGiven || 0, s.platformFee || 0,
     s.stripePaymentIntentId || null, s.propertyId || null, s.discountAmount || 0, s.discountReason || null,
     s.taxBreakdown && s.taxBreakdown.length ? JSON.stringify(s.taxBreakdown) : null,
     s.paidOnline === true])
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
  // 10/3 (Nic's admin cards): GAM's card fee on a card sale charged on GAM's
  // account is GAM's earnings. Never booked before: the register and pay-link
  // fees sat on GAM's balance as money nobody had written down, while Stripe's
  // cost of those charges was already counted in the day's card costs. Booked
  // like a card rent payment's spread (the whole fee; the month's true-up
  // subtracts what Stripe actually took), once per sale.
  // 10/3 (review): booked once the sale COMMITS, never inside its transaction —
  // the counter captures the card after this and before COMMIT, and the
  // ledger's lock held through that Stripe call stalled every other writer of
  // GAM's earnings. A sale that rolls back books nothing; one whose booking is
  // missed (a restart) is booked by the nightly true-up.
  const gamCardFee = cardSaleGamFee(s)
  let cardFeeBooked: Promise<CommittedBookingOutcome | 'no_fee'> = Promise.resolve('no_fee')
  if (gamCardFee > 0) {
    const { rows: [x] } = await client.query<{ xid: string }>(`SELECT pg_current_xact_id()::text AS xid`)
    cardFeeBooked = recordPlatformRevenueOnceCommitted({
      type: 'banking_spread',
      amount: gamCardFee,
      customerFeeCharged: gamCardFee,
      referenceId: tx.id,
      referenceType: 'pos_transaction',
      propertyId: s.propertyId ?? null,
      notes: s.paidOnline ? 'Card fee on a pay link payment' : 'Card fee on a register card sale',
    }, x.xid, {
      stillThere: async () => (await query(`SELECT 1 FROM pos_transactions WHERE id = $1`, [tx.id])).length > 0,
    })
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
    // S652: stock is numeric(12,3) — propane sells by the gallon, so 4.6 is a
    // real quantity. It was integer, the insert below refused "-4.6", and the
    // whole sale rolled back with the register none the wiser.
    const stockQty = dbItem ? Number(dbItem.stock_qty) : null
    if (dbItem && stockQty != null && stockQty < 999) {
      const newQty = Math.max(0, stockQty - item.qty)
      await client.query('UPDATE pos_items SET stock_qty=$1, updated_at=NOW() WHERE id=$2', [newQty, dbItem.id])
      await client.query(`INSERT INTO pos_inventory_log (item_id,landlord_id,change_qty,reason,reference_id,stock_before,stock_after)
        VALUES ($1,$2,$3,'sale',$4,$5,$6)`,
        [dbItem.id, s.landlordId, -item.qty, tx.id, stockQty, newQty])
      // Pre-decrement snapshot, matching the original semantics
      // (reorderQty = stock_max - stock_qty).
      if (newQty <= dbItem.stock_min && dbItem.vendor_id) needsPO.push(dbItem)
    }
  }
  // S652 (Nic): "a full history of exactly what happened" — every recorded
  // sale leaves one line of its own, independent of the HTTP summary.
  logger.info({ transactionId: tx.id, propertyId: s.propertyId ?? null, landlordId: s.landlordId, cashierId: s.cashierId ?? null,
                method: s.paymentMethod, total: tx.total, items: s.items.length }, '[pos] sale recorded')
  return { tx, needsPO, cardFeeBooked }
}
