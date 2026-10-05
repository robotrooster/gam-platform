/**
 * 10/3 (Nic's admin cards): GAM's card fee on a register or pay-link card sale
 * is GAM's earnings, booked with the sale. Before this, the four card sales on
 * GAM's balance ($2.83 of fees) were written down nowhere while Stripe's cost
 * of them was counted — the Processing Margin card read low by exactly that.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { insertPosSale, cardSaleGamFee, type PosSaleInput } from './posSale'
import { recordPlatformRevenue, trueUpProcessingMargin } from './platformRevenue'

let landlordId = ''
let cashierId = ''

beforeEach(async () => {
  await cleanupAllSchema()
  const c = await db.connect()
  try { ({ landlordId, userId: cashierId } = await seedLandlord(c)) } finally { c.release() }
})

const sale = (over: Partial<PosSaleInput>): PosSaleInput => ({
  landlordId, propertyId: null, cashierId, paymentMethod: 'card',
  subtotal: 0.33, taxAmount: 0.02, surcharge: 0.56, total: 0.91, platformFee: 0.56,
  stripePaymentIntentId: 'pi_reader_1', payoutOwed: 0.35,
  items: [{ name: 'Ice', qty: 1, price: 0.33 }],
  ...over,
})

/** Rings a sale and waits for its card fee's booking to finish (it happens after COMMIT). */
async function ring(s: PosSaleInput, outcome: 'COMMIT' | 'ROLLBACK' = 'COMMIT') {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { tx, cardFeeBooked } = await insertPosSale(c, s)
    await c.query(outcome)
    await cardFeeBooked
    return tx.id as string
  } finally { c.release() }
}

const booked = async () => (await db.query<{ amount: string; fee: string; reference_type: string; reference_id: string }>(
  `SELECT amount::text AS amount, customer_fee_charged::text AS fee, reference_type, reference_id
     FROM platform_revenue_ledger WHERE type = 'banking_spread' ORDER BY created_at`)).rows

describe('the card fee on a register or pay-link sale is GAM\'s earnings', () => {
  it('a card sale at the counter books its card fee once, against the sale', async () => {
    const id = await ring(sale({}))
    expect(await booked()).toEqual([{ amount: '0.56', fee: '0.56', reference_type: 'pos_transaction', reference_id: id }])
  })

  it('a card on file books its card fee too', async () => {
    await ring(sale({ paymentMethod: 'card_on_file', stripePaymentIntentId: 'pi_saved_card' }))
    expect((await booked()).map(r => r.amount)).toEqual(['0.56'])
  })

  it('a pay link whose landlord covers the fee still books GAM\'s fee', async () => {
    await ring(sale({ surcharge: 0, total: 15.11, platformFee: 1.04, payoutOwed: 14.07, paidOnline: true, stripePaymentIntentId: 'pi_link' }))
    expect((await booked()).map(r => r.amount)).toEqual(['1.04'])
  })

  it('cash is free and a store-account sale is not paid yet: neither books a card fee', async () => {
    await ring(sale({ paymentMethod: 'cash', surcharge: 0, platformFee: 0, total: 0.35, stripePaymentIntentId: null, payoutOwed: undefined }))
    await ring(sale({ paymentMethod: 'charge', surcharge: 0.01, platformFee: 0.01, stripePaymentIntentId: null, payoutOwed: undefined }))
    expect(await booked()).toEqual([])
  })

  it('a sale that rolls back books nothing', async () => {
    await ring(sale({ stripePaymentIntentId: 'pi_rolled_back' }), 'ROLLBACK')
    expect(await booked()).toEqual([])
  })

  it('reads the fee only off a card sale on GAM\'s account', () => {
    expect(cardSaleGamFee({ paymentMethod: 'card', stripePaymentIntentId: 'pi', platformFee: 0.67, surcharge: 0.67 })).toBe(0.67)
    expect(cardSaleGamFee({ paymentMethod: 'card', stripePaymentIntentId: null, platformFee: 0.67, surcharge: 0.67 })).toBe(0)
    expect(cardSaleGamFee({ paymentMethod: 'cash', stripePaymentIntentId: 'pi', platformFee: 0, surcharge: 0 })).toBe(0)
  })
})

// 10/3 (review): the counter captures the card AFTER the sale is written and
// BEFORE it commits. Booking the fee inside the sale held the ledger's one
// lock through that Stripe call, and every other writer of GAM's earnings
// waited on the slowest card reader.
describe('a register sale never holds the earnings ledger while the card is captured', () => {
  it('a sale whose capture is slow does not block another earnings write; its fee is booked once it commits', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { tx, cardFeeBooked } = await insertPosSale(c, sale({ stripePaymentIntentId: 'pi_slow_capture' }))
      // The capture is still out: the sale's transaction is open. The ledger is free.
      const other = await db.connect()
      try {
        await other.query('BEGIN')
        const free = await other.query<{ got: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtextextended('platform_revenue', 0)) AS got`)
        expect(free.rows[0].got).toBe(true)
        await other.query('ROLLBACK')
      } finally { other.release() }
      const t0 = Date.now()
      await recordPlatformRevenue({ type: 'screening_margin', amount: 5, referenceId: '33333333-3333-3333-3333-333333333333', referenceType: 'background_check' })
      expect(Date.now() - t0).toBeLessThan(2000)
      expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE type = 'screening_margin'`)).rows).toHaveLength(1)
      // Nothing booked for the sale while it is open.
      expect(await booked()).toEqual([])
      await c.query('COMMIT')
      expect(await cardFeeBooked).toBe('booked')
      expect(await booked()).toEqual([{ amount: '0.56', fee: '0.56', reference_type: 'pos_transaction', reference_id: tx.id }])
    } finally { c.release() }
  })

  it('says how a rolled-back sale ended: nothing to book', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { cardFeeBooked } = await insertPosSale(c, sale({ stripePaymentIntentId: 'pi_declined' }))
      await c.query('ROLLBACK')
      expect(await cardFeeBooked).toBe('rolled_back')
    } finally { c.release() }
    expect(await booked()).toEqual([])
  })

  it('a fee whose booking was missed is booked by the month\'s true-up, once, on the sale\'s day', async () => {
    const { rows: [pt] } = await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total,
                                     platform_fee, stripe_payment_intent_id, created_at)
       VALUES ($1, $2, 'card', 3.30, 0.22, 0.67, 4.19, 0.67, 'pi_missed', '2026-08-02T01:27:00Z') RETURNING id`,
      [landlordId, cashierId])
    await trueUpProcessingMargin('2026-08-01', { dryRun: true })
    expect(await booked()).toEqual([])                               // a dry run books nothing
    await trueUpProcessingMargin('2026-08-01')
    await trueUpProcessingMargin('2026-08-01')
    expect(await booked()).toEqual([{ amount: '0.67', fee: '0.67', reference_type: 'pos_transaction', reference_id: pt.id }])
    const [row] = (await db.query<{ d: string }>(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS d FROM platform_revenue_ledger WHERE type = 'banking_spread'`)).rows
    expect(row.d).toBe('2026-08-01')                                 // the sale's own (Phoenix) day
  })

})
