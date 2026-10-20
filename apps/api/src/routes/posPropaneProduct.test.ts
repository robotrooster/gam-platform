/**
 * 10/20 (Nic) — DISPENSED PROPANE IS A PRODUCT, AND MOVING IT OUT OF
 * "UTILITIES" MUST NOT COST THE 6.60% TAX.
 *
 *   "Propane needs to not be in the utilities category. It needs to be as a
 *    product... That's not a bill back thing. That's a, we charge it at the time
 *    of dispensing... We charge sales tax on it. It's two separate things."
 *
 * The shapes here are Mountain View's, read out of production: a category named
 * "Utilities" holding BOTH "Electric (per kWh)" at $0.21 and "Propane" at
 * $3.30/gal, and a named tax — "Transaction privilege tax", 6.60%, scoped by
 * item_ids to the Propane item alone. Fourteen propane sales, $328.05, $21.54 of
 * tax collected at 0.0660.
 *
 * The whole point of the first test: a category move that silently drops a tax
 * assignment is a tax UNDER-COLLECTION, which is worse than the misfiling it was
 * meant to fix. It also pins the one shape where a move WOULD cost the tax — a
 * rate scoped by category NAME (applies_to) rather than by item — because that
 * is the warning that has to travel with the data change.
 *
 * Run (migrations 20261022090000 / 20261022090100 are not on production yet):
 *   DB_NAME=gam_pl_test TEST_DB_NAME=gam_pl_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/routes/posPropaneProduct.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { calculateCartTax } from '../services/posTax'
import { insertPosSale } from '../services/posSale'
import { registerBillBackOf } from '../services/rentRoll'
import { propaneModeOfLine, lineRecoversUtility, PROPANE_MODE_LABEL } from '../services/propaneMode'
import { posRouter } from './pos'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'

const app = express()
app.use(express.json())
app.use('/api/pos', posRouter)
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(err.statusCode || err.status || 500).json({ success: false, error: err.message }))

const token = (userId: string, landlordId: string) =>
  jwt.sign({ userId, role: 'landlord', profileId: landlordId, permissions: ['pos.manage_inventory', 'pos.ring_sale'] },
    JWT_SECRET, { expiresIn: '1h' })

type Park = {
  userId: string; landlordId: string; propertyId: string
  utilitiesCatId: string; fuelCatId: string
  propaneItemId: string; electricItemId: string
  tptRateId: string
  auth: string
}

/** Mountain View's catalog as production holds it, minus the stays. */
async function park(): Promise<Park> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId, state: 'AZ' })

    const cat = async (name: string, sort: number) => (await client.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, property_ids, is_active)
       VALUES ($1,$2,$3,ARRAY[$4::uuid],TRUE) RETURNING id`,
      [landlordId, name, sort, propertyId])).rows[0].id
    const utilitiesCatId = await cat('Utilities', 2)
    const fuelCatId      = await cat('Fuel', 1)

    const item = async (name: string, price: number, catId: string) => (await client.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price,
                              tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,$3,$4,$5,0,0,999,999,999) RETURNING id`,
      [landlordId, propertyId, name, catId, price])).rows[0].id
    // Both of them in "Utilities" — exactly where production has them.
    const propaneItemId  = await item('Propane', 3.30, utilitiesCatId)
    const electricItemId = await item('Electric (per kWh)', 0.21, utilitiesCatId)

    // The real tax: named, 6.60%, scoped BY ITEM to propane alone.
    const tptRateId = (await client.query<{ id: string }>(
      `INSERT INTO pos_tax_rates (landlord_id, property_id, name, rate, tax_type, applies_to, item_ids, on_stays)
       VALUES ($1,$2,'Transaction privilege tax',0.0660,'sales',ARRAY[]::text[],ARRAY[$3::uuid],FALSE)
       RETURNING id`, [landlordId, propertyId, propaneItemId])).rows[0].id

    return { userId, landlordId, propertyId, utilitiesCatId, fuelCatId,
             propaneItemId, electricItemId, tptRateId, auth: token(userId, landlordId) }
  } finally { client.release() }
}

/** 14 gallons of propane at the counter: what the cart charges. */
const propaneCart = (p: Park) => calculateCartTax(p.landlordId, [
  { itemId: p.propaneItemId, qty: 14, unitPrice: 3.30 },
])

beforeEach(cleanupAllSchema)

describe('the 6.60% transaction privilege tax survives propane leaving "Utilities"', () => {
  it('charges 6.60% before the move, and the same cents after it — the tax is scoped to the ITEM, not the category', async () => {
    const p = await park()

    const before = await propaneCart(p)
    expect(before.subtotal).toBe(46.2)
    expect(before.taxAmount).toBe(3.05)   // 46.20 x 0.0660 = 3.0492
    expect(before.lines[0].categoryName).toBe('Utilities')
    expect(before.lines[0].appliedRates.map(r => [r.name, r.rate])).toEqual([
      ['Transaction privilege tax', 0.066],
    ])

    // THE MOVE — through the route a landlord actually uses.
    const moved = await request(app)
      .patch(`/api/pos/items/${p.propaneItemId}`)
      .set('Authorization', `Bearer ${p.auth}`)
      .send({ categoryId: p.fuelCatId })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body.data.category_id).toBe(p.fuelCatId)

    const after = await propaneCart(p)
    expect(after.lines[0].categoryName).toBe('Fuel')
    expect(after.taxAmount).toBe(before.taxAmount)
    expect(after.lines[0].appliedRates.map(r => [r.name, r.rate, r.amount])).toEqual([
      ['Transaction privilege tax', 0.066, 3.05],
    ])

    // And the assignment itself is untouched — nothing re-pointed item_ids.
    const rate = (await db.query<{ item_ids: string[] }>(
      `SELECT item_ids::text[] AS item_ids FROM pos_tax_rates WHERE id = $1`, [p.tptRateId])).rows[0]
    expect(rate.item_ids).toEqual([p.propaneItemId])
  })

  it('a rate scoped by category NAME instead does lose the tax on the move — the warning that travels with the data change', async () => {
    const p = await park()
    // Same 6.60%, named the same, but hung on the word "Utilities".
    await db.query(`UPDATE pos_tax_rates SET item_ids = ARRAY[]::uuid[], applies_to = ARRAY['Utilities'] WHERE id = $1`,
      [p.tptRateId])

    expect((await propaneCart(p)).taxAmount).toBe(3.05)

    await db.query(`UPDATE pos_items SET category_id = $1 WHERE id = $2`, [p.fuelCatId, p.propaneItemId])

    const after = await propaneCart(p)
    expect(after.taxAmount).toBe(0)
    expect(after.lines[0].appliedRates).toEqual([])
  })
})

describe('what a button IS is explicit on the item, not guessed from two strings', () => {
  it('a new item is a product by default, and refuses a utility it does not recognize', async () => {
    const p = await park()
    const made = await request(app)
      .post('/api/pos/items')
      .set('Authorization', `Bearer ${p.auth}`)
      .send({ name: 'Propane 20lb', categoryId: p.fuelCatId, sellPrice: 24.99, propertyId: p.propertyId })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.data.recovers_utility).toBeNull()

    const bad = await request(app)
      .post('/api/pos/items')
      .set('Authorization', `Bearer ${p.auth}`)
      .send({ name: 'Nonsense', categoryId: p.fuelCatId, sellPrice: 1, propertyId: p.propertyId,
              recoversUtility: 'electricity' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/recoversUtility must be one of/)
  })

  it('the electric button says it is electric; the propane button says it is a product; clearing it says product again', async () => {
    const p = await park()
    const patch = (id: string, body: any) => request(app)
      .patch(`/api/pos/items/${id}`).set('Authorization', `Bearer ${p.auth}`).send(body)

    expect((await patch(p.electricItemId, { recoversUtility: 'electric' })).body.data.recovers_utility).toBe('electric')
    // Untouched by an unrelated edit — undefined preserves.
    expect((await patch(p.electricItemId, { sellPrice: 0.22 })).body.data.recovers_utility).toBe('electric')
    expect((await patch(p.electricItemId, { recoversUtility: null })).body.data.recovers_utility).toBeNull()

    expect((await patch(p.propaneItemId, { recoversUtility: '' })).body.data.recovers_utility).toBeNull()
  })

  it('"Propane gas" in a category called "Utilities" is still a product — the string rule would have called it gas', async () => {
    const p = await park()
    await db.query(`UPDATE pos_items SET name = 'Propane gas' WHERE id = $1`, [p.propaneItemId])

    // What the old rule says about that exact row, today, with no column read:
    expect(registerBillBackOf('Utilities', 'Propane gas')).toBe('gas')
    // What the item itself says:
    const row = (await db.query<{ recovers_utility: string | null }>(
      `SELECT recovers_utility FROM pos_items WHERE id = $1`, [p.propaneItemId])).rows[0]
    expect(row.recovers_utility).toBeNull()
    expect(registerBillBackOf('Utilities', 'Propane gas', row.recovers_utility)).toBeNull()
    expect(propaneModeOfLine({ recoversUtility: row.recovers_utility })).toBe('dispensed')
    expect(PROPANE_MODE_LABEL.dispensed).toBe('Dispensed at the counter')
  })
})

describe('a sale keeps what the line WAS, taken from the item and never from the request', () => {
  const sell = async (p: Park, items: any[]) => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { tx } = await insertPosSale(client, {
        landlordId: p.landlordId, propertyId: p.propertyId, cashierId: p.userId,
        paymentMethod: 'cash', subtotal: 46.2, taxAmount: 3.05, surcharge: 0, total: 49.25,
        items,
      })
      await client.query('COMMIT')
      return tx.id
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }

  it('propane sold at the counter recovers nothing, even when the register posts cat "Utilities"', async () => {
    const p = await park()
    const txId = await sell(p, [
      { id: p.propaneItemId, name: 'Propane', cat: 'Utilities', qty: 14, price: 3.30, tax_rate: 0.066 },
    ])
    const line = (await db.query<{ item_category: string; recovers_utility: string | null }>(
      `SELECT item_category, recovers_utility FROM pos_transaction_items WHERE transaction_id = $1`,
      [txId])).rows[0]
    expect(line.recovers_utility).toBeNull()
    expect(lineRecoversUtility({ recoversUtility: line.recovers_utility })).toBeNull()
    // The category came off the item's own category, not the body.
    expect(line.item_category).toBe('Utilities')
  })

  it('a register that lies about the category cannot change what the line is', async () => {
    const p = await park()
    await db.query(`UPDATE pos_items SET category_id = $1 WHERE id = $2`, [p.fuelCatId, p.propaneItemId])
    const txId = await sell(p, [
      // The request insists on "Utilities"; the item is in "Fuel".
      { id: p.propaneItemId, name: 'Propane', cat: 'Utilities', qty: 14, price: 3.30 },
    ])
    const line = (await db.query<{ item_category: string; recovers_utility: string | null }>(
      `SELECT item_category, recovers_utility FROM pos_transaction_items WHERE transaction_id = $1`,
      [txId])).rows[0]
    expect(line.item_category).toBe('Fuel')
    expect(line.recovers_utility).toBeNull()
  })

  it('an electric bill-back line keeps its utility, so a final bill on a pay link can still count as recovery', async () => {
    const p = await park()
    await db.query(`UPDATE pos_items SET recovers_utility = 'electric' WHERE id = $1`, [p.electricItemId])
    const txId = await sell(p, [
      { id: p.electricItemId, name: 'Electric (per kWh) — September, RV 27', cat: 'Utilities', qty: 390, price: 0.21 },
    ])
    const line = (await db.query<{ recovers_utility: string | null }>(
      `SELECT recovers_utility FROM pos_transaction_items WHERE transaction_id = $1`, [txId])).rows[0]
    expect(line.recovers_utility).toBe('electric')
    expect(registerBillBackOf('Fuel', 'Who knows', line.recovers_utility)).toBe('electric')
  })

  it('an ad-hoc line with no item behind it recovers nothing — typed words never invent recovery', async () => {
    const p = await park()
    const txId = await sell(p, [
      { id: null, name: 'Electric — final read', cat: 'Utilities', qty: 1, price: 81.9 },
    ])
    const line = (await db.query<{ item_category: string; recovers_utility: string | null }>(
      `SELECT item_category, recovers_utility FROM pos_transaction_items WHERE transaction_id = $1`,
      [txId])).rows[0]
    expect(line.recovers_utility).toBeNull()
    expect(line.item_category).toBe('Utilities')   // the sender's words are kept
  })
})

describe('the migrations are expand-only and re-runnable', () => {
  it('applies twice with no error and leaves the same shape', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const dir = path.join(__dirname, '..', 'db', 'migrations')
    const mine = fs.readdirSync(dir).filter(f => f.slice(0, 14) > '20261021220000').sort()
    expect(mine.length).toBeGreaterThanOrEqual(2)
    for (const f of mine) {
      await db.query(fs.readFileSync(path.join(dir, f), 'utf8'))
      await db.query(fs.readFileSync(path.join(dir, f), 'utf8'))
    }
    const cols = (await db.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE (table_name = 'pos_items' AND column_name = 'recovers_utility')
           OR (table_name = 'pos_transaction_items' AND column_name = 'recovers_utility')
           OR (table_name = 'propane_fills' AND column_name IN ('lease_id','tenant_id','booking_id','service_agreement_id'))
        ORDER BY table_name, column_name`)).rows
    expect(cols.map(c => [c.table_name, c.column_name, c.is_nullable])).toEqual([
      ['pos_items', 'recovers_utility', 'YES'],
      ['pos_transaction_items', 'recovers_utility', 'YES'],
      ['propane_fills', 'booking_id', 'YES'],
      ['propane_fills', 'lease_id', 'YES'],
      ['propane_fills', 'service_agreement_id', 'YES'],
      ['propane_fills', 'tenant_id', 'YES'],
    ])
  })

  it('the backfill writes today\'s answer: the electric item becomes electric, propane stays a product', async () => {
    const p = await park()
    // Pretend the column was never set, the way production will be when the
    // migration runs.
    await db.query(`UPDATE pos_items SET recovers_utility = NULL WHERE landlord_id = $1`, [p.landlordId])
    const fs = await import('fs')
    const path = await import('path')
    await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations',
      '20261022090000_dispensed_propane_is_a_product_not_a_utility.sql'), 'utf8'))

    const rows = (await db.query<{ name: string; recovers_utility: string | null }>(
      `SELECT name, recovers_utility FROM pos_items WHERE landlord_id = $1 ORDER BY name`,
      [p.landlordId])).rows
    expect(rows.map(r => [r.name, r.recovers_utility])).toEqual([
      ['Electric (per kWh)', 'electric'],
      ['Propane', null],
    ])
  })

  it('refuses a utility type the shared list does not have', async () => {
    const p = await park()
    await expect(db.query(
      `UPDATE pos_items SET recovers_utility = 'electricity' WHERE id = $1`, [p.propaneItemId]),
    ).rejects.toThrow(/pos_items_recovers_utility_check/)
  })
})

describe('a delivered fill can name a stay or a serviced agreement, not only a lease', () => {
  it('records a fill against a booking with no lease and no tenant, and refuses one that names nobody', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId: userId, managedByUserId: userId })
      // An RV site, because that is where this breaks first.
      const unitId = (await client.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, unit_type, has_propane_tank)
         VALUES ($1,$2,'RV 27',589,'rv_spot',TRUE) RETURNING id`, [propertyId, landlordId])).rows[0].id
      const bookingId = (await client.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, lease_type)
         VALUES ($1,$2,'Andres Razo','razo@test.dev','2026-08-01','2026-09-01','nightly') RETURNING id`,
        [unitId, landlordId])).rows[0].id

      const fill = await client.query<{ id: string; lease_id: string | null; tenant_id: string | null }>(
        `INSERT INTO propane_fills
           (property_id, landlord_id, unit_id, booking_id, gallons, price_per_gallon, total_amount, installment_count)
         VALUES ($1,$2,$3,$4,48,3.30,158.40,1) RETURNING id, lease_id, tenant_id`,
        [propertyId, landlordId, unitId, bookingId])
      expect(fill.rows[0].lease_id).toBeNull()
      expect(fill.rows[0].tenant_id).toBeNull()

      await expect(client.query(
        `INSERT INTO propane_fills
           (property_id, landlord_id, unit_id, gallons, price_per_gallon, total_amount, installment_count)
         VALUES ($1,$2,$3,48,3.30,158.40,1)`, [propertyId, landlordId, unitId]),
      ).rejects.toThrow(/propane_fills_names_an_occupancy/)
    } finally { client.release() }
  })

  it('the landlord\'s fill list still shows it, named by the guest', async () => {
    const client = await getClient()
    let propertyId = '', unitId = '', landlordId = '', userId = ''
    try {
      const l = await seedLandlord(client); userId = l.userId; landlordId = l.landlordId
      propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
      unitId = (await client.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, unit_type, has_propane_tank)
         VALUES ($1,$2,'RV 27',589,'rv_spot',TRUE) RETURNING id`, [propertyId, landlordId])).rows[0].id
      const bookingId = (await client.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, lease_type)
         VALUES ($1,$2,'Andres Razo','2026-08-01','2026-09-01','nightly') RETURNING id`,
        [unitId, landlordId])).rows[0].id
      await client.query(
        `INSERT INTO propane_fills
           (property_id, landlord_id, unit_id, booking_id, gallons, price_per_gallon, total_amount, installment_count)
         VALUES ($1,$2,$3,$4,48,3.30,158.40,1)`, [propertyId, landlordId, unitId, bookingId])
    } finally { client.release() }

    const propaneApp = express()
    propaneApp.use(express.json())
    const { propaneRouter } = await import('./propane')
    propaneApp.use('/api/propane', propaneRouter)
    propaneApp.use((err: any, _req: any, res: any, _next: any) =>
      res.status(err.statusCode || err.status || 500).json({ success: false, error: err.message }))

    const auth = jwt.sign(
      { userId, role: 'landlord', profileId: landlordId, permissions: ['properties.edit', 'units.edit'] },
      JWT_SECRET, { expiresIn: '1h' })
    const res = await request(propaneApp)
      .get(`/api/propane/fills?propertyId=${propertyId}`)
      .set('Authorization', `Bearer ${auth}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].tenant_name).toBe('Andres Razo')
    expect(Number(res.body.data[0].balance_remaining)).toBe(0)
    expect(randomUUID()).toBeTruthy()
  })
})
