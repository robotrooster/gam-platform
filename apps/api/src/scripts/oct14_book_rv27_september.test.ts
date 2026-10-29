/**
 * 10/14 (Nic) — Andres Razo's month at RV 27, booked for when he was there:
 * the dry run reads and writes nothing; --apply books the stay on the money
 * already paid (no new charge), marks the sale for GAM Books, and the Rent Roll
 * shows the month in its own month; run again, nothing left to do. On fixtures
 * shaped like production (his $779.05 pay link: a month of site rent and two
 * electric lines, card online, $26.88 card fee on top).
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { addMonths, currentBillMonth } from '../services/householdMonths'
import { rentRollStays } from '../services/rentRoll'
import { planRv27September, applyRv27September, RV27_NOTE, type Rv27Target } from './oct14_book_rv27_september'

beforeEach(cleanupAllSchema)

async function tx<T>(fn: (c: PoolClient) => Promise<T>, commit: boolean): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query(commit ? 'COMMIT' : 'ROLLBACK')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const SEPT = addMonths(currentBillMonth(), -1)
const PAID_DAY = `${currentBillMonth()}-01`

async function world(): Promise<{ t: Rv27Target; unitId: string; saleId: string; tenantId: string; userId: string }> {
  const c = await db.connect()
  try {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: 589 })
    await c.query(`UPDATE units SET unit_number = 'RV 27' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c, { email: 'razoandres60@t.dev' })
    const cat = (await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stays',1,TRUE) RETURNING id`, [ll.landlordId])).rows[0].id
    const monthly = (await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — monthly',$3,589,0,0,999,0,999,'month') RETURNING id`, [ll.landlordId, propertyId, cat])).rows[0].id
    const at = `${PAID_DAY} 10:50:38-07`
    const link = (await c.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email,
                                  customer_name, status, paid_at)
       VALUES ($1,$2,$3,$4,'one_time','3 items','[]'::jsonb,752.17,752.17,'RazoAndres60@t.dev','Andres Razo','paid',$5::timestamptz) RETURNING id`,
      [randomUUID(), ll.landlordId, propertyId, ll.userId, at])).rows[0].id
    const saleId = (await c.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, surcharge, total, platform_fee, property_id,
                                     pay_link_id, stripe_payment_intent_id, status, created_at, paid_online)
       VALUES ($1,$2,'card',752.17,26.88,779.05,26.88,$3,$4,$5,'completed',$6::timestamptz,TRUE) RETURNING id`,
      [ll.landlordId, ll.userId, propertyId, link, `pi_${randomUUID()}`, at])).rows[0].id
    await c.query(`UPDATE pos_pay_links SET pos_transaction_id = $2 WHERE id = $1`, [link, saleId])
    await c.query(
      `INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, item_category, qty, unit_price, subtotal) VALUES
         ($1,$2,'RV site — monthly','Stays',1,589,589),
         ($1,NULL,'Electric (per kWh)','Utilities',387,0.21,81.27),
         ($1,NULL,'Electric (per kWh) — September, RV 27','Utilities',390,0.21,81.90)`, [saleId, monthly])
    return {
      t: { landlordId: ll.landlordId, propertyId, unitNumber: 'RV 27', payer: 'Andres Razo', checkIn: `${SEPT}-01` },
      unitId, saleId, tenantId, userId: ll.userId,
    }
  } finally { c.release() }
}

describe('oct14_book_rv27_september', () => {
  it('the dry run says what it would book and writes nothing; --apply books it on the money already paid; again, nothing to do', async () => {
    const w = await world()
    const dry = await tx(c => planRv27September(c, w.t), false)
    expect(dry.refused).toBeNull()
    expect(dry.booking).toMatchObject({
      unitId: w.unitId, guestName: 'Andres Razo', guestEmail: 'RazoAndres60@t.dev', tenantId: w.tenantId,
      checkIn: `${SEPT}-01`, checkOut: `${addMonths(SEPT, 1)}-01`, total: 589,
    })
    // The card fee's share of the $589 (of $752.17 charged before the fee on top).
    expect(dry.stayPayment).toEqual({ toward: 589, cardFee: 21.05, landlordCardFee: 0 })
    expect(dry.platformFee).toMatchObject({ alreadyCounted: false, wouldAdd: 2, billed: null })
    expect((await db.query(`SELECT 1 FROM unit_bookings WHERE unit_id = $1`, [w.unitId])).rows).toHaveLength(0)

    const bookingId = await tx(async c => applyRv27September(c, await planRv27September(c, w.t), w.t), true)
    const b = (await db.query<any>(
      `SELECT status, lease_type, stay_terms, to_char(check_in, 'YYYY-MM-DD') AS ci, to_char(check_out, 'YYYY-MM-DD') AS co,
              to_char(booked_check_out, 'YYYY-MM-DD') AS bco, total_amount::float AS total, deposit_amount::float AS dep,
              deposit_paid_at IS NOT NULL AS dep_paid, balance_paid_at IS NOT NULL AS paid, pos_transaction_id, tenant_id, notes,
              screening_required
         FROM unit_bookings WHERE id = $1`, [bookingId])).rows[0]
    expect(b).toMatchObject({
      status: 'checked_out', lease_type: 'month_to_month', stay_terms: 'stay', ci: `${SEPT}-01`, co: `${addMonths(SEPT, 1)}-01`,
      bco: `${addMonths(SEPT, 1)}-01`, total: 589, dep: 589, dep_paid: true, paid: true, pos_transaction_id: w.saleId,
      tenant_id: w.tenantId, notes: RV27_NOTE, screening_required: false,
    })
    const sp = (await db.query<any>(
      `SELECT kind, method, toward_stay::float AS toward, card_fee::float AS fee, pos_transaction_id FROM stay_payments WHERE booking_id = $1`,
      [bookingId])).rows
    expect(sp).toEqual([{ kind: 'pos_sale', method: 'card', toward: 589, fee: 21.05, pos_transaction_id: w.saleId }])
    // No new charge: the sale is what it was; nothing billed.
    expect((await db.query<any>(`SELECT total::float AS total, status FROM pos_transactions WHERE id = $1`, [w.saleId])).rows[0])
      .toEqual({ total: 779.05, status: 'completed' })
    expect((await db.query(`SELECT 1 FROM payments WHERE landlord_id = $1`, [w.t.landlordId])).rows).toHaveLength(0)
    // GAM Books: the sale is marked to post again.
    expect((await db.query(`SELECT 1 FROM ledger_outbox WHERE source_type = 'pos_sale' AND source_id = $1`, [w.saleId])).rows.length)
      .toBeGreaterThan(0)
    // Nothing waits on arrival, and nothing is owed.
    const { reservationDue } = await import('../services/registerStay')
    expect(await reservationDue(db, bookingId)).toMatchObject({ owed: 0, paidInFull: true })
    // The Rent Roll: the month is September's, when he was there — not October's, when he paid.
    const stays = (m: string) => rentRollStays({ landlordIds: [w.t.landlordId], property: { id: w.t.propertyId, timezone: 'America/Phoenix' }, from: m, to: m, withMoney: true })
    expect((await stays(SEPT)).map(l => [l.label, l.paid, l.sites.map(s => s.label)])).toEqual([['1 month paid for via POS', 589, ['1 month in RV 27']]])
    expect(await stays(addMonths(SEPT, 1))).toEqual([])

    const again = await tx(c => planRv27September(c, w.t), false)
    expect(again.done).toEqual({ bookingId })
  })

  it('refuses, changing nothing, when RV 27 is not free for those dates', async () => {
    const w = await world()
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, status, lease_type)
       VALUES ($1,$2,'Someone Else',$3::date,$3::date + 3,'checked_out','nightly')`, [w.unitId, w.t.landlordId, `${SEPT}-10`])
    const plan = await tx(c => planRv27September(c, w.t), false)
    expect(plan.refused).toMatch(/RV 27 is not free/)
    await expect(tx(c => applyRv27September(c, plan, w.t), false)).rejects.toThrow('Nothing to apply')
  })
})
