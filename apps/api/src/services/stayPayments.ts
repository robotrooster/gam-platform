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
import { STAY_PAYMENT_METHODS, priceStayBetween, type StayPaymentMethod } from '@gam/shared'
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
  // 10/12 (Nic, ledger P1): the lodging tax inside the deposit, stored with it.
  const lodgingTax = await siteDepositLodgingTax(q, o.bookingId, deposit)
  await q.query(
    `INSERT INTO stay_payments
       (booking_id, landlord_id, kind, stripe_payment_intent_id, method, toward_stay, card_fee, landlord_card_fee,
        lodging_tax_amount)
     VALUES ($1, $2, 'site_deposit', $3, 'card', $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [o.bookingId, o.landlordId, o.paymentIntentId, deposit.toFixed(2), onTop.toFixed(2), covered.toFixed(2),
     lodgingTax.toFixed(2)])
}

/**
 * 10/12 (Nic, ledger P1) — the lodging tax inside a booking-site deposit, as
 * priced the day it is paid. The booking site quotes a stay with the
 * property's short-stay tax already in it (shared priceStay — the one price
 * every door charges) and the deposit is a share of that taxed total, so its
 * tax is the deposit less its pre-tax share: deposit − ROUND(deposit ÷ (1 +
 * rate), 2) — the split the reports make, but from the rate THE STAY WAS
 * PRICED AT (10/17, unit_bookings.stay_tax_rate) and stored, never re-derived
 * later from whatever the rate has become
 * (stay_payments.lodging_tax_amount). Priced over the nights SOLD
 * (registerStay soldCheckOutSql): an untaxed stay (30+ nights, or exactly
 * whole calendar months) has none. Also the backfill's rule for deposits
 * recorded before 10/12.
 *
 * 10/12 (ledger P1 review): nor does the first month of a 30+ night stay
 * booked on the booking site (registerStay untaxedMonthStaySql — the stay
 * asked for is 30+ nights, so propertyBookingQuote.firstStayMonth charged it
 * no tax, even when the month booked is a 28-night February). Repricing its
 * sold dates alone found a nightly or weekly price with tax in it. The
 * reports' rule (incomeBasis.stayTaxPctSql) leaves it out the same way.
 */
export async function siteDepositLodgingTax(q: Q, bookingId: string, deposit: number): Promise<number> {
  if (!(deposit > 0)) return 0
  const { soldCheckOutSql, untaxedMonthStaySql } = await import('./registerStay')
  const b = (await q.query<{
    check_in: string; check_out: string; short_term_tax_rate: string | null
    nightly: string | null; weekly: string | null; monthly: string | null; month_stay: boolean
  }>(
    `SELECT to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(${soldCheckOutSql('b')}, 'YYYY-MM-DD') AS check_out,
            ${untaxedMonthStaySql('b')} AS month_stay,
            -- 10/17 (Nic, "never reprice history"): the rate THIS stay was
            -- priced at (stamped on the booking), not the property's rate at
            -- the moment the webhook lands. The booking row exists before the
            -- deposit does, and a rate change in between is now instant and
            -- company-wide, so reading today's figure stored a tax the card
            -- was never charged. The property's rate stands in only for a stay
            -- priced before stamping began.
            COALESCE(b.stay_tax_rate * 100, p.short_term_tax_rate)::text AS short_term_tax_rate,
            COALESCE(u.nightly_rate, p.nightly_rate)::text AS nightly,
            COALESCE(u.weekly_rate, p.weekly_rate)::text AS weekly,
            COALESCE(u.monthly_rate, p.monthly_rate)::text AS monthly
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`, [bookingId])).rows[0]
  if (!b || b.month_stay) return 0
  const price = priceStayBetween({ nightly: b.nightly, weekly: b.weekly, monthly: b.monthly },
    b.short_term_tax_rate, b.check_in, b.check_out)
  if (!(price.taxRate > 0)) return 0
  return round2(deposit - round2(deposit / (1 + price.taxRate)))
}
