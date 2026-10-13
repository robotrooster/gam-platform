/**
 * 10/12 (Nic, G10): a refund of a CARD sale gives the customer the card fee
 * back too, and the landlord eats that fee — it shows as the landlord's cost:
 * the P&L's "Card fees refunded" expense line, in the expense total and the
 * net. A cash sale carries no card fee, so its refund has none.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { computeLandlordPL, landlordPLExpenses, landlordPLExpensesByProperty } from './landlordPL'
import { cardFeesRefundedByProperty } from './incomeBasis'

beforeEach(cleanupAllSchema)

async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    return { userId, landlordId, propertyId }
  } finally { c.release() }
}

/** A register sale: $100 of goods, and on a card the guest's $4.05 card fee on top. */
async function sale(f: { userId: string; landlordId: string; propertyId: string }, method: 'card' | 'cash', at: string): Promise<string> {
  const surcharge = method === 'card' ? 4.05 : 0
  return (await db.query<{ id: string }>(
    `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total, status, created_at)
     VALUES ($1, $2, $3, $4, 100, 0, $5, $6, 'completed', $7::timestamptz) RETURNING id`,
    [f.landlordId, f.propertyId, f.userId, method, surcharge, 100 + surcharge, at])).rows[0].id
}

/** A refund. Only a refund sent back to the card can be reversed (Stripe sent it back). */
async function refund(f: { landlordId: string }, saleId: string, amount: number, cardFee: number, at: string,
                      method: 'card' | 'cash' = 'cash', reversedAt?: string) {
  await db.query(
    `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, stripe_refund_id, card_fee_refunded, tax_refunded, created_at, reversed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7::timestamptz, $8::timestamptz)`,
    [saleId, f.landlordId, amount, method, method === 'card' ? `re_${saleId.slice(0, 8)}` : null, cardFee, at, reversedAt ?? null])
}

describe('Card fees refunded — the landlord\'s cost', () => {
  it('a card sale refunded in full: the $4.05 card fee given back is an expense, in the total and the net', async () => {
    const f = await seed()
    const card = await sale(f, 'card', '2026-09-03T18:00:00Z')
    await refund(f, card, 104.05, 4.05, '2026-09-10T18:00:00Z', 'card')
    // A cash sale refunded: no card fee, nothing.
    const cash = await sale(f, 'cash', '2026-09-04T18:00:00Z')
    await refund(f, cash, 100, 0, '2026-09-11T18:00:00Z')

    const e = await landlordPLExpenses(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(e.cardFeesRefunded).toBe(4.05)
    expect(e.total).toBe(Math.round((e.platformFee + e.maintenance + e.lotRent + e.enteredExpenses + e.processingFees + 4.05) * 100) / 100)

    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.expenses.cardFeesRefunded).toBe(4.05)
    expect(pl.net).toBe(Math.round((pl.gross.total - pl.expenses.total) * 100) / 100)
    // Shown once: as the expense line, not beside the income as well.
    expect(pl.besideItems.find(b => b.key === 'refundCardFees')).toBeUndefined()

    const byProp = await landlordPLExpensesByProperty(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(byProp.get(f.propertyId)?.cardFeesRefunded).toBe(4.05)
  })

  it('counts on the refund day, and comes off on the day a card refund was sent back', async () => {
    const f = await seed()
    const card = await sale(f, 'card', '2026-09-03T18:00:00Z')
    await refund(f, card, 52.03, 2.03, '2026-09-28T18:00:00Z', 'card', '2026-10-05T18:00:00Z')
    expect((await cardFeesRefundedByProperty([f.landlordId], '2026-09-01', '2026-09-30')).get(f.propertyId)).toBe(2.03)
    expect((await cardFeesRefundedByProperty([f.landlordId], '2026-10-01', '2026-10-31')).get(f.propertyId)).toBe(-2.03)
    expect((await cardFeesRefundedByProperty([f.landlordId], '2026-08-01', '2026-08-31')).size).toBe(0)
  })
})
