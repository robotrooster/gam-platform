/**
 * posTax S554 (button-sweep bug #3): item.tax_rate fallback.
 *
 * When a landlord has configured NO pos_tax_rates rows for an item's
 * property (the launch reality — items carry a tax_rate, the rate table is
 * empty), calculateCartTax must fall back to pos_items.tax_rate. Without
 * this the service returned 0 tax while the POS client computed tax from
 * item.tax_rate and minted the terminal PI at that total → the amount-match
 * guard 400'd every card sale AFTER capture.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { calculateCartTax, aggregateCartTotals } from './posTax'

beforeEach(async () => {
  await cleanupAllSchema()
})

async function seedItem(landlordId: string, propertyId: string, opts: {
  taxRate: number; categoryName?: string; sellPrice?: number
}): Promise<string> {
  const cat = await db.query<{ id: string }>(
    `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, $2) RETURNING id`,
    [landlordId, opts.categoryName ?? 'General'])
  const categoryId = cat.rows[0].id
  const item = await db.query<{ id: string }>(
    `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, tax_rate, stock_qty, stock_min, stock_max)
     VALUES ($1, $2, $3, 'Item', $4, $5, 999, 0, 999) RETURNING id`,
    [landlordId, propertyId, categoryId, opts.sellPrice ?? 10, opts.taxRate])
  return item.rows[0].id
}

describe('calculateCartTax — item.tax_rate fallback (bug #3)', () => {
  it('no pos_tax_rates rows → taxes at pos_items.tax_rate', async () => {
    const c = await db.connect()
    let landlordId = '', propertyId = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c); landlordId = l.landlordId
      propertyId = await seedProperty(c, { landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const itemId = await seedItem(landlordId, propertyId, { taxRate: 0.08, sellPrice: 10 })
    const result = await calculateCartTax(landlordId, [{ itemId, qty: 2, unitPrice: 10 }])
    // subtotal 20, tax = 20 * 0.08 = 1.60
    expect(result.subtotal).toBe(20)
    expect(result.taxAmount).toBe(1.60)
    expect(result.lines[0].appliedRates[0].name).toBe('Item tax rate')
  })

  it('configured pos_tax_rates row WINS over item.tax_rate (no fallback)', async () => {
    const c = await db.connect()
    let landlordId = '', propertyId = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c); landlordId = l.landlordId
      propertyId = await seedProperty(c, { landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const itemId = await seedItem(landlordId, propertyId, { taxRate: 0.08, sellPrice: 10 })
    // Landlord-wide 10% rate applies to all → wins over the 8% item rate.
    await db.query(
      `INSERT INTO pos_tax_rates (landlord_id, property_id, name, rate, tax_type, applies_to)
       VALUES ($1, NULL, 'State', 0.10, 'sales', ARRAY['all'])`,
      [landlordId])
    const result = await calculateCartTax(landlordId, [{ itemId, qty: 1, unitPrice: 10 }])
    expect(result.taxAmount).toBe(1.0)  // 10%, not the 8% item rate
    expect(result.lines[0].appliedRates[0].name).toBe('State')
  })

  it('item.tax_rate = 0 with no rates → zero tax, no phantom rate line', async () => {
    const c = await db.connect()
    let landlordId = '', propertyId = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c); landlordId = l.landlordId
      propertyId = await seedProperty(c, { landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const itemId = await seedItem(landlordId, propertyId, { taxRate: 0, sellPrice: 10 })
    const result = await calculateCartTax(landlordId, [{ itemId, qty: 1, unitPrice: 10 }])
    expect(result.taxAmount).toBe(0)
    expect(result.lines[0].appliedRates).toHaveLength(0)
  })
})

describe('aggregateCartTotals — shared /transactions + /cart-quote math', () => {
  const tax = { subtotal: 25, taxAmount: 2, lines: [{ itemId: 'a', itemName: 'A', categoryName: null, subtotal: 25, appliedRates: [], taxAmount: 2 }] }

  it('catalog subtotal + tax, discount clamped, net total', () => {
    const items = [{ id: 'a', qty: 1, price: 25 }]
    const t = aggregateCartTotals(tax as any, items, { discountAmount: 5, surcharge: 0 })
    expect(t.subtotal).toBe(25)   // gross
    expect(t.taxAmount).toBe(2)
    expect(t.discount).toBe(5)
    expect(t.total).toBe(22)      // 25 - 5 + 2
  })

  it('adds walk-up (non-catalog) item price + its client tax', () => {
    const items = [{ id: 'a', qty: 1, price: 25 }, { qty: 2, price: 5, tax_rate: 0.1 }]
    const t = aggregateCartTotals(tax as any, items, {})
    // walk-up 2*5=10 subtotal, 10*0.1=1 tax → subtotal 35, tax 3
    expect(t.subtotal).toBe(35)
    expect(t.taxAmount).toBe(3)
    expect(t.total).toBe(38)
  })

  it('discount cannot exceed subtotal (no negative total)', () => {
    const t = aggregateCartTotals(tax as any, [{ id: 'a', qty: 1, price: 25 }], { discountAmount: 999 })
    expect(t.discount).toBe(25)
    expect(t.total).toBe(2)  // 25 - 25 + 2
  })
})
