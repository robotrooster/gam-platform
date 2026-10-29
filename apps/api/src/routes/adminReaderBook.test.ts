/**
 * 10/13 (Nic) — a card reader in GAM's own book, as the admin money card reads it.
 *
 * "record each reader as a GAM expense (loss if cost > charge); allow dated
 * cost corrections." And (afternoon) FULL PURCHASE: "Book the $331.73 as an
 * expense the day we buy it, and each $87.50 payment as paying it back
 * (lowers 'earned all time' until repaid)." GAM's book (platform_revenue_ledger)
 * holds the purchase as an expense, each correction on its own date, and each
 * piece as the cost it repays and then the markup — and the bridge from GAM's
 * book to the Stripe balance still ends with $0.00 left over, every line
 * named: GAM paid Stripe's shop for the reader, not from the balance, so the
 * purchase is added back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { recordReaderOrderCost } from '../services/readerOrders'

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM stripe_processing_costs`)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_admin_bul'
})

/** A paid-off reader: 4 × $87.50 netted from the landlord's payouts, so $350 of GAM's on the balance. */
async function paidOffReader() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const order = (await c.query<{ id: string }>(
      `INSERT INTO pos_reader_orders (landlord_id, property_id, status, model, price, installments, installment_amount,
                                      installments_raised, ship_name, ship_line1, ship_city, ship_state, ship_zip,
                                      created_at, ordered_at, shipped_at)
       VALUES ($1, $2, 'registered', 'stripe_reader_s710', 350, 4, 87.5, 4, 'Lisa S', '1 Road', 'Amado', 'AZ', '85645',
               '2026-05-10T17:00:00Z', '2026-05-11T17:00:00Z', '2026-05-20T17:00:00Z') RETURNING id`,
      [ll.landlordId, propertyId])).rows[0].id
    for (const n of [1, 2, 3, 4]) {
      await c.query(
        `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, collected_amount, source_type,
                                           reader_order_id, installment_number, created_at)
         VALUES ($1, $2, 'device_installment', 87.50, 87.50, 'reader_order_installment', $3, $4,
                 make_timestamptz(2026, $5, 1, 15, 0, 0, 'UTC'))`, [ll.landlordId, propertyId, order, n, 5 + n])
    }
    const superId = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'super_admin', 'Nic', 'R', TRUE) RETURNING id`, [`super-${randomUUID()}@test.dev`])).rows[0].id
    await c.query('COMMIT')
    const token = jwt.sign({ userId: superId, role: 'super_admin', email: 'x@test.dev', profileId: superId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { order, userId: ll.userId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Stripe holding exactly the $350 the reader's pieces kept back from payouts. */
const fakeStripe = {
  balance: { retrieve: async () => ({ available: [{ amount: 35000, currency: 'usd' }], pending: [{ amount: 0, currency: 'usd' }] }) },
  paymentIntents: { retrieve: async () => { throw new Error('not read') } },
  payouts: { list: async () => ({ data: [], has_more: false }) },
  balanceTransactions: { list: async () => ({ data: [], has_more: false }) },
}

async function balance(token: string) {
  vi.resetModules()
  vi.doMock('../lib/stripe', () => ({ getStripe: () => fakeStripe, stripeSecretKeyOrNull: () => undefined }))
  try {
    const { adminRouter } = await import('./admin')
    const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter); app.use(errorHandler)
    return (await request(app).get('/api/admin/platform-balance').set('Authorization', `Bearer ${token}`)).body.data
  } finally { vi.doUnmock('../lib/stripe') }
}

describe("a reader in GAM's own book still ties the money card to the Stripe balance", () => {
  it('a reader that cost GAM more than it charges: GAM’s book holds the $11.20 loss, every payment is cost repaid, and the bridge ends at $0.00 with no other line', async () => {
    const f = await paidOffReader()
    await recordReaderOrderCost(f.order, { basePrice: 330, tax: 24, shipping: 7.2 }, f.userId)   // $361.20
    const d = await balance(f.token)
    expect(d.revenue_all_time).toBe(-11.2)
    expect(d.readers_in_earned).toEqual({ bought: -361.2, cost_repaid: 350, markup: 0 })
    expect(d.reconciliation.gap).toBe(0)
    expect(d.reconciliation.bridge).toMatchObject({
      earned: -11.2, reader_bought: 361.2, reader_billed_not_collected: 0, reader_payments_collected: 350,
      reader_cost_repaid_collected: 350, reader_markup_collected: 0, leftover: 0,
    })
    expect(d.reconciliation.bridge.timing).toEqual([])
  })

  it('a reader that earns its markup: GAM’s book comes to $18.27 — bought, repaid, marked up — and no other line', async () => {
    const f = await paidOffReader()
    await recordReaderOrderCost(f.order, { basePrice: 299, taxAndShipping: 32.73 }, f.userId)
    const d = await balance(f.token)
    expect(d.revenue_all_time).toBe(18.27)
    expect(d.readers_in_earned).toEqual({ bought: -331.73, cost_repaid: 331.73, markup: 18.27 })
    expect(d.reconciliation.bridge).toMatchObject({
      earned: 18.27, reader_bought: 331.73, reader_payments_collected: 350, reader_cost_repaid_collected: 331.73,
      reader_markup_collected: 18.27, reader_billed_not_collected: 0, leftover: 0,
    })
    expect(d.reconciliation.bridge.timing).toEqual([])
  })

  // 10/13 evening (Nic): "Redo the split" — piece 4 is split again under the corrected cost on the
  // correction's date, so the slices say markup = what is beyond the cost.
  it('a dated correction after the markup is booked: the $5.00 more is GAM’s expense on its date, piece 4 moves $5.00 from markup to cost repaid on that date, the booked rows stay, and the bridge ends at $0.00 with no other line', async () => {
    const f = await paidOffReader()
    await recordReaderOrderCost(f.order, { basePrice: 299, taxAndShipping: 32.73 }, f.userId)
    await recordReaderOrderCost(f.order, { basePrice: 299, taxAndShipping: 37.73, effectiveOn: '2026-10-01' }, f.userId)
    const d = await balance(f.token)
    expect(d.revenue_all_time).toBe(13.27)
    expect(d.readers_in_earned).toEqual({ bought: -336.73, cost_repaid: 336.73, markup: 13.27 })
    expect(d.reconciliation.gap).toBe(0)
    expect(d.reconciliation.bridge).toMatchObject({
      earned: 13.27, reader_bought: 336.73, reader_payments_collected: 350, reader_cost_repaid_collected: 336.73,
      reader_markup_collected: 13.27, reader_billed_not_collected: 0, leftover: 0,
    })
    expect(d.reconciliation.bridge.timing).toEqual([])
  })

  it('a reader row the ledger lost is named on the bridge until the next run writes it back', async () => {
    const f = await paidOffReader()
    await recordReaderOrderCost(f.order, { basePrice: 299, taxAndShipping: 32.73 }, f.userId)
    await db.query(`DELETE FROM platform_revenue_ledger WHERE type = 'device_markup'`)
    let d = await balance(f.token)
    expect(d.revenue_all_time).toBe(0)
    expect(d.reconciliation.bridge.timing.map((t: any) => [t.key, t.amount])).toEqual([['readers', 18.27]])
    expect(d.reconciliation.bridge.leftover).toBe(0)
    const { chaseReaderOrders } = await import('../services/readerOrders')
    await chaseReaderOrders()
    d = await balance(f.token)
    expect(d.revenue_all_time).toBe(18.27)
    expect(d.reconciliation.bridge.timing).toEqual([])
  })
})
