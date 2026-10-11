/**
 * 10/4 (decisions #37.B, #38) — EVERY PAYMENT TOWARD A STAY, ONE ROW EACH.
 *
 * What a reservation had been paid used to be read from flags on the booking
 * (balance_paid_at, deposit_amount). Neither says HOW the money came in, and a
 * register sale's share for the stay was stored nowhere. An early check-out
 * gives money back ONLY the way it was paid (a card to that same card, cash at
 * the desk, a charge account back onto the account), most recent payment
 * first, with the card fee the guest paid on the refunded part (#38 Q3, Q4,
 * Q10) — so every door that takes money for a stay writes its row here, in the
 * same transaction as the payment:
 *
 *   - the booking site's deposit      → recordSiteDeposit (propertyBooking.confirmBookingDeposit)
 *   - a pay link, online or at the desk → recordSaleTowardStay (posPayLinks.settleLinkBooking)
 *   - the counter's reservation ticket → recordSaleTowardStay (routes/pos)
 *   - a stay rung straight at the counter → recordSaleTowardStay (routes/pos)
 *
 * Money GAM holds aside (pos_held_payments) is never a payment toward the stay.
 * Readers: services/earlyCheckOut (what was paid, and where it goes back).
 */
import type { PoolClient } from 'pg'
import { STAY_PAYMENT_METHODS, type StayPaymentMethod } from '@gam/shared'
import { logger } from '../lib/logger'

type Q = Pick<PoolClient, 'query'>

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The card fee on a sale's share for a stay. A card sale charged on GAM's
 * account (card or card on file, with a PaymentIntent) carries GAM's card fee:
 * the part the customer paid ON TOP is the sale's surcharge; the part the
 * landlord covered is the rest of the sale's platform fee (taken from their
 * payout). Each is split by the share: `toward` out of what the sale charged
 * before the fee on top. Cash, a check and a charge account carry no card fee.
 */
export function saleShareFees(
  sale: { payment_method: string; stripe_payment_intent_id: string | null; total: number | string; surcharge: number | string | null; platform_fee: number | string | null },
  toward: number,
): { cardFee: number; landlordCardFee: number } {
  const card = (sale.payment_method === 'card' || sale.payment_method === 'card_on_file') && !!sale.stripe_payment_intent_id
  if (!card || !(toward > 0)) return { cardFee: 0, landlordCardFee: 0 }
  const onTop = Math.max(0, Number(sale.surcharge) || 0)
  const gamFee = Math.max(0, Number(sale.platform_fee) || 0)
  const base = Number(sale.total) - onTop
  if (!(base > 0)) return { cardFee: 0, landlordCardFee: 0 }
  const share = Math.min(1, toward / base)
  return {
    cardFee: round2(onTop * share),
    landlordCardFee: round2(Math.max(0, gamFee - onTop) * share),
  }
}

/**
 * A register sale paid `toward` toward a stay: its row, read from the sale
 * itself (how it was paid, its intent, its card fee). Run inside the sale's
 * transaction, after the sale is written. Once per sale and stay (a link paid
 * at the counter settles through both the counter and the link).
 */
export async function recordSaleTowardStay(q: Q, o: { bookingId: string | null | undefined; saleId: string; toward: number }): Promise<void> {
  const toward = round2(Number(o.toward) || 0)
  if (!o.bookingId || !(toward > 0)) return
  const sale = (await q.query<{
    landlord_id: string; payment_method: string; stripe_payment_intent_id: string | null
    total: string; surcharge: string | null; platform_fee: string | null; created_at: Date
  }>(
    `SELECT landlord_id, payment_method, stripe_payment_intent_id, total::text, surcharge::text,
            platform_fee::text, created_at
       FROM pos_transactions WHERE id = $1`, [o.saleId])).rows[0]
  if (!sale) return
  if (!(STAY_PAYMENT_METHODS as readonly string[]).includes(sale.payment_method)) {
    // A way of paying a stay this ledger does not know is said loudly: the
    // stay's money would otherwise be missing from what an early check-out can give back.
    logger.error({ bookingId: o.bookingId, saleId: o.saleId, method: sale.payment_method },
      '[stay-payments] a payment toward a stay was made a way the stay ledger does not know — not itemized')
    return
  }
  const fees = saleShareFees(sale, toward)
  await q.query(
    `INSERT INTO stay_payments
       (booking_id, landlord_id, kind, pos_transaction_id, stripe_payment_intent_id, method,
        toward_stay, card_fee, landlord_card_fee, paid_at)
     VALUES ($1, $2, 'pos_sale', $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING`,
    [o.bookingId, sale.landlord_id, o.saleId, sale.stripe_payment_intent_id,
     sale.payment_method as StayPaymentMethod, toward.toFixed(2), fees.cardFee.toFixed(2),
     fees.landlordCardFee.toFixed(2), sale.created_at])
}

/**
 * The booking site's deposit landed: `deposit` toward the stay, paid by card
 * on GAM's account. `charged` is what the card was charged — the deposit plus
 * GAM's card fee when the guest paid it on top, or the deposit alone when the
 * property covers the fee (then `gamFee` came out of the landlord's payout).
 */
export async function recordSiteDeposit(q: Q, o: {
  bookingId: string; landlordId: string; paymentIntentId: string; deposit: number; charged: number; gamFee: number
}): Promise<void> {
  const deposit = round2(o.deposit)
  if (!(deposit > 0) || !o.paymentIntentId) return
  const onTop = round2(Math.max(0, o.charged - deposit))
  const covered = onTop > 0 ? 0 : round2(Math.max(0, o.gamFee))
  await q.query(
    `INSERT INTO stay_payments
       (booking_id, landlord_id, kind, stripe_payment_intent_id, method, toward_stay, card_fee, landlord_card_fee)
     VALUES ($1, $2, 'site_deposit', $3, 'card', $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [o.bookingId, o.landlordId, o.paymentIntentId, deposit.toFixed(2), onTop.toFixed(2), covered.toFixed(2)])
}
