/**
 * S613 — "how much utility did we not get back?"
 *
 * Nic: "Unbilled utility tracking would just be the difference between an owner
 * importing their total charges coming into the property and subtracting the
 * outgoing charges... over a whole year when there's fifty thousand dollars in
 * utilities and there's twelve thousand maybe not billed back to people, we
 * wanna see that."
 *
 * No new ledger: spent = the property's utility expenses, recovered = the bills
 * it sent, gap = the answer. The owner-occupied slice is named because it is
 * recorded as it happens; the rest of the gap stays unattributed rather than
 * being guessed at.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_recovery'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId, unitId, tenantId, leaseId,
      token: jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('GET /api/utility/recovery (S613)', () => {
  it('spent minus billed back is the gap, per utility and in total', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, utility_type, amount, expense_date)
       VALUES ($1,$2,'utilities','water',1000,'2026-03-10'),
              ($1,$2,'utilities','electric',500,'2026-03-11')`,
      [f.landlordId, f.propertyId])
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rubs_allocation_method)
       VALUES ($1,'water','W','rubs',0,'occupant_count') RETURNING id`, [f.propertyId])
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-03-01','equal',0,0,700,0,0,'water')`,
      [meter.id, f.unitId, f.tenantId, f.leaseId, f.landlordId])

    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const water = res.body.data.lines.find((l: any) => l.utilityType === 'water')
    expect(water.spent).toBe(1000)
    expect(water.recovered).toBe(700)
    expect(water.notRecovered).toBe(300)

    // Electric was paid for and never billed back to anyone — the whole $500.
    const elec = res.body.data.lines.find((l: any) => l.utilityType === 'electric')
    expect(elec.spent).toBe(500)
    expect(elec.recovered).toBe(0)
    expect(elec.notRecovered).toBe(500)

    expect(res.body.data.totals.spent).toBe(1500)
    expect(res.body.data.totals.recovered).toBe(700)
    expect(res.body.data.totals.notRecovered).toBe(800)
  })

  it('names the owner-occupied slice of the gap', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, utility_type, amount, expense_date)
       VALUES ($1,$2,'utilities','trash',300,'2026-03-10')`, [f.landlordId, f.propertyId])
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee)
       VALUES ($1,'trash','T','flat_rate',0) RETURNING id`, [f.propertyId])
    await db.query(
      `INSERT INTO utility_owner_use_absorptions (meter_id, unit_id, landlord_id, utility_type,
              billing_cycle_month, allocation_method, charge_amount, base_fee_share)
       VALUES ($1,$2,$3,'trash','2026-03-01','flat_rate',25,25)`,
      [meter.id, f.unitId, f.landlordId])

    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)
    const trash = res.body.data.lines.find((l: any) => l.utilityType === 'trash')
    expect(trash.spent).toBe(300)
    expect(trash.ownerOccupied).toBe(25)
    expect(trash.notRecovered).toBe(300)
  })

  // A landlord who never records the provider's bill has nothing to subtract
  // from. Reporting the whole recovery as a shortfall would be a lie.
  it('no expense recorded → the gap is null, not the whole amount', async () => {
    const f = await seed()
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rubs_allocation_method)
       VALUES ($1,'water','W','rubs',0,'occupant_count') RETURNING id`, [f.propertyId])
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-03-01','equal',0,0,700,0,0,'water')`,
      [meter.id, f.unitId, f.tenantId, f.leaseId, f.landlordId])
    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)
    const water = res.body.data.lines.find((l: any) => l.utilityType === 'water')
    expect(water.recovered).toBe(700)
    expect(water.notRecovered).toBeNull()
    // S652 (Nic): with nothing recorded as spent, the TOTAL gap is a dash too —
    // it used to subtract from zero and print the whole billing as a shortfall.
    expect(res.body.data.totals.notRecovered).toBeNull()
  })

  // S652 (Nic): "spent zero, billed back $1,588.65, and not recovered
  // $1,588.65… most people at Mountain View have paid their bill."
  it('a voided bill is not billed back, and paid is told apart from still owed', async () => {
    const f = await seed()
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rubs_allocation_method)
       VALUES ($1,'electric','E','rubs',0,'occupant_count') RETURNING id`, [f.propertyId])
    const bill = (month: string, amount: number, status: string) => db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,'equal',0,0,$7,0,0,'electric',$8)`,
      [meter.id, f.unitId, f.tenantId, f.leaseId, f.landlordId, month, amount, status])
    await bill('2026-03-01', 100, 'paid')
    await bill('2026-04-01', 60, 'billed')
    await bill('2026-05-01', 50.40, 'void')
    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)
    const e = res.body.data.lines.find((l: any) => l.utilityType === 'electric')
    expect(e.recovered).toBe(160)      // the void 50.40 is not counted
    expect(e.collected).toBe(100)
    expect(e.stillOwed).toBe(60)
    expect(res.body.data.totals).toMatchObject({ recovered: 160, collected: 100, stillOwed: 60, notRecovered: null })
  })

  it('cross-landlord property → 403', async () => {
    const a = await seed()
    const b = await seed()
    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${b.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(403)
  })

  // S652 (Nic): "tenants do not still owe $744.45." A bill paid by cash or
  // check stayed "billed" because only the online path marked it paid. The
  // rule is on the table now: a utility bill follows its payment.
  it('a utility bill is paid when its payment settles — by any route — and owed again if that payment is reversed', async () => {
    const f = await seed()
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rubs_allocation_method)
       VALUES ($1,'electric','E','rubs',0,'occupant_count') RETURNING id`, [f.propertyId])
    const { rows: [pay] } = await db.query<any>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',264.39,'pending','2026-09-01','UTILITY') RETURNING id`,
      [f.landlordId, f.tenantId, f.unitId, f.leaseId])
    const { rows: [bill] } = await db.query<any>(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type, status, payment_id)
       VALUES ($1,$2,$3,$4,$5,'2026-08-01','equal',0,0,264.39,0,0,'electric','billed',$6) RETURNING id`,
      [meter.id, f.unitId, f.tenantId, f.leaseId, f.landlordId, pay.id])
    const status = async () => (await db.query<any>(`SELECT status, paid_at FROM utility_bills WHERE id=$1`, [bill.id])).rows[0]

    // a check taken at the counter: nothing but the payment row changes
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW(), manual_method='check' WHERE id=$1`, [pay.id])
    expect((await status()).status).toBe('paid')
    expect((await status()).paid_at).not.toBeNull()
    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.body.data.totals).toMatchObject({ recovered: 264.39, collected: 264.39, stillOwed: 0 })

    // the check bounces
    await db.query(`UPDATE payments SET status='returned' WHERE id=$1`, [pay.id])
    expect((await status()).status).toBe('billed')
    expect((await status()).paid_at).toBeNull()
  })

  // S652 (Nic): "It needs to count the 387 kilowatts for $81.27 as still
  // outstanding. It's billed back and not paid." Andres Razo had no lease — his
  // meter was billed on a pay link.
  it('electric billed on a pay link is billed back: owed while the link is open, paid once it is rung up', async () => {
    const f = await seed()
    const items = [
      { id: null, cat: 'Stays', name: 'RV site — monthly', qty: 1, price: 589, tax: 0 },
      { id: null, cat: 'Utilities', name: 'Electric (per kWh)', qty: 387, price: 0.21, tax: 0 },
      { id: null, cat: 'Utilities', name: 'Propane', qty: 10, price: 3.30, tax: 0 },   // pump sale, not a bill-back
    ]
    const { rows: [link] } = await db.query<any>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items,
                                  subtotal, total, customer_name, customer_email, created_at)
       VALUES ('tok-recovery-1', $1, $2, $3, 'one_time', '3 items', $4::jsonb, 703.27, 703.27,
               'Andres Razo', 'razo@example.com', '2026-09-18') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId, JSON.stringify(items)])
    const get = async () => (await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)).body.data

    let d = await get()
    expect(d.lines.map((l: any) => l.utilityType)).toEqual(['electric'])
    expect(d.totals).toMatchObject({ recovered: 81.27, collected: 0, workTrade: 0, stillOwed: 81.27 })

    // he pays the link: the link closes and the sale is on the register — once
    const { rows: [tx] } = await db.query<any>(
      `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, total, status, pay_link_id, created_at)
       VALUES ($1, $2, $3, 'card', 703.27, 703.27, 'completed', $4, '2026-09-30') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId, link.id])
    await db.query(
      `INSERT INTO pos_transaction_items (transaction_id, item_name, item_category, qty, unit_price, subtotal)
       VALUES ($1,'RV site — monthly','Stays',1,589,589),
              ($1,'Electric (per kWh)','Utilities',387,0.21,81.27),
              ($1,'Propane','Utilities',10,3.30,33.00)`, [tx.id])
    await db.query(`UPDATE pos_pay_links SET status='paid', paid_at=NOW(), pos_transaction_id=$1 WHERE id=$2`, [tx.id, link.id])
    d = await get()
    expect(d.totals).toMatchObject({ recovered: 81.27, collected: 81.27, stillOwed: 0 })
  })

  // S652 (Nic): "He is on a work trade. It's unpaid because of a work trade."
  // Matthew Conklin's August electric was reported as money a tenant owed.
  it('a charge the work trade covers is worked off — never "still owed", never "paid"', async () => {
    const f = await seed()
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rubs_allocation_method)
       VALUES ($1,'electric','E','rubs',0,'occupant_count') RETURNING id`, [f.propertyId])
    const charge = async (month: string, amount: number, suspended: boolean) => {
      const { rows: [pay] } = await db.query<any>(
        `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
         VALUES ($1,$2,$3,$4,'utility',$5,'pending','2026-09-01','UTILITY',$6) RETURNING id`,
        [f.landlordId, f.tenantId, f.unitId, f.leaseId, amount, suspended ? new Date().toISOString() : null])
      await db.query(
        `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                    billing_cycle_month, allocation_method, rate_per_unit,
                                    base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type, status, payment_id)
         VALUES ($1,$2,$3,$4,$5,$6,'equal',0,0,$7,0,0,'electric','billed',$8)`,
        [meter.id, f.unitId, f.tenantId, f.leaseId, f.landlordId, month, amount, pay.id])
      return pay.id as string
    }
    const covered = await charge('2026-08-01', 187.11, true)
    await charge('2026-07-01', 40, false)
    const get = async () => (await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)).body.data.totals

    expect(await get()).toMatchObject({ recovered: 227.11, collected: 0, workTrade: 187.11, stillOwed: 40 })

    // month close: the hours were worked, the charge is closed by the credit
    await db.query(
      `UPDATE payments SET amount = 0, status = 'settled', settled_at = NOW(), work_trade_suspended_at = NULL,
              notes = 'Covered by work-trade credit' WHERE id = $1`, [covered])
    expect(await get()).toMatchObject({ recovered: 227.11, collected: 0, workTrade: 187.11, stillOwed: 40 })
  })
})

