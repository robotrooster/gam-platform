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

/** The whole report for a year, the way the landlord's page asks for it. */
const get = async (f: any) => (await request(buildApp())
  .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
  .set('Authorization', `Bearer ${f.token}`)).body.data

/**
 * MOUNTAIN VIEW'S REAL CATALOG, and the reason this report stopped reading
 * names. Both buttons sit in a category the landlord typed the word "Utilities"
 * into; only the electric one is marked as giving back utility spend. The
 * propane one is a PRODUCT — recovers_utility NULL, which is an ANSWER and not
 * a missing value — so nothing that sweeps utilities may ever pick it up.
 *
 * `propaneName` is there so a test can put the worst name a front desk might
 * type on the propane button and prove it changes nothing.
 */
async function seedCatalog(f: any, opts: { propaneName?: string } = {}) {
  const { rows: [cat] } = await db.query<any>(
    `INSERT INTO pos_categories (landlord_id, name, property_id) VALUES ($1,'Utilities',$2) RETURNING id`,
    [f.landlordId, f.propertyId])
  const item = async (name: string, price: number, recovers: string | null) => (await db.query<any>(
    `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, recovers_utility)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [f.landlordId, f.propertyId, cat.id, name, price, recovers])).rows[0].id as string
  return {
    categoryId: cat.id as string,
    electric: await item('Electric (per kWh)', 0.21, 'electric'),
    propane: await item(opts.propaneName ?? 'Propane', 3.30, null),
  }
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
  //
  // 10/20 (Nic) — AND THE CATALOG BUTTON IS WHAT SAYS SO, NOT ITS NAME.
  // Mountain View's real catalog is reproduced here exactly as it is: both the
  // Electric item and the Propane item sit in a category literally named
  // "Utilities", and only the Electric one is marked as giving back utility
  // spend (pos_items.recovers_utility). Dispensed propane is a PRODUCT — it is
  // charged at the pump with sales tax on it — and it must not appear anywhere
  // in this report, however it is named or filed.
  it('electric billed on a pay link is billed back: owed while the link is open, paid once it is rung up', async () => {
    const f = await seed()
    const { electric, propane } = await seedCatalog(f)
    const items = [
      { id: null, cat: 'Stays', name: 'RV site — monthly', qty: 1, price: 589, tax: 0 },
      { id: electric, cat: 'Utilities', name: 'Electric (per kWh)', qty: 387, price: 0.21, tax: 0 },
      { id: propane, cat: 'Utilities', name: 'Propane', qty: 10, price: 3.30, tax: 0 },   // pump sale, not a bill-back
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
    // A sale is its own source, told apart from a bill on an invoice.
    expect(d.totals).toMatchObject({ fromSales: 81.27, fromBills: 0, inTheRate: 0 })

    // he pays the link: the link closes and the sale is on the register — once
    const { rows: [tx] } = await db.query<any>(
      `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, total, status, pay_link_id, created_at)
       VALUES ($1, $2, $3, 'card', 703.27, 703.27, 'completed', $4, '2026-09-30') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId, link.id])
    await db.query(
      `INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, item_category, qty, unit_price, subtotal, recovers_utility)
       VALUES ($1,NULL,'RV site — monthly','Stays',1,589,589,NULL),
              ($1,$2,'Electric (per kWh)','Utilities',387,0.21,81.27,'electric'),
              ($1,$3,'Propane','Utilities',10,3.30,33.00,NULL)`, [tx.id, electric, propane])
    await db.query(`UPDATE pos_pay_links SET status='paid', paid_at=NOW(), pos_transaction_id=$1 WHERE id=$2`, [tx.id, link.id])
    d = await get()
    expect(d.totals).toMatchObject({ recovered: 81.27, collected: 81.27, stillOwed: 0 })
    // Counted ONCE: the link closed and the sale opened in the same breath, and
    // $81.27 is still $81.27 — not $162.54.
    expect(d.lines.map((l: any) => l.utilityType)).toEqual(['electric'])
  })

  // 10/20 (Nic): "Propane needs to not be in the utilities category. It needs to
  // be as a product... That's not a bill back thing. That's a, we charge it at
  // the time of dispensing. So that needs to not kind of be lumped in with
  // electric in any way, shape, or form."
  //
  // THE ONE-KEYSTROKE MONEY ERROR THIS CLOSES. The old rule read two free-text
  // strings: a category name starting "utilit" and an item name containing
  // electric / water / sewer / trash / gas. Mountain View's propane button was
  // safe only because the word "Propane" matches none of them — rename it
  // "Propane gas", which a front-desk person might type any day, and $328 of
  // TPT-taxed fuel revenue read as gas bill-back recovery. So this asks the
  // question with the worst possible name on the button.
  it('dispensed propane is a product and is in NONE of the three buckets — even named "Propane gas" in a category called Utilities', async () => {
    const f = await seed()
    const { propane } = await seedCatalog(f, { propaneName: 'Propane gas' })
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, utility_type, amount, expense_date)
       VALUES ($1,$2,'utilities','gas',400,'2026-03-10')`, [f.landlordId, f.propertyId])
    const { rows: [tx] } = await db.query<any>(
      `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total, status, created_at)
       VALUES ($1,$2,$3,'card',328.05,21.54,349.59,'completed','2026-03-14') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId])
    await db.query(
      `INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, item_category, qty, unit_price, subtotal, tax_rate, recovers_utility)
       VALUES ($1,$2,'Propane gas','Utilities',99.41,3.30,328.05,0.0660,NULL)`, [tx.id, propane])

    const d = await get(f)
    const gas = d.lines.find((l: any) => l.utilityType === 'gas')
    // The gas spend is real and entirely unrecovered. The propane revenue is
    // nowhere near it: not recovery, not the property's own use, not the gap.
    expect(gas).toMatchObject({ spent: 400, recovered: 0, fromSales: 0, propertyUsed: 0, somebodysUsage: 0 })
    expect(gas.notRecovered).toBe(400)
    expect(d.lines.map((l: any) => l.utilityType)).toEqual(['gas'])
    expect(d.totals).toMatchObject({ recovered: 0, fromSales: 0, fromBills: 0, inTheRate: 0 })
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

/**
 * 10/20 (Nic) — CALL IT A WASH, and show me whether it evens out.
 *
 *   "I would like to keep track of money that wasn't refunded versus electric
 *    that should have been billed that wasn't charged to see how close we
 *    actually get to evening out. You know, because people leave at various
 *    times and we try to be generous with it, but I want to make sure that it's
 *    somewhat fair."
 *
 * The absorbed power used to disappear into the unattributed gap along with the
 * common areas and the vacant spaces. It has a name now, and the money kept
 * sits beside it.
 */
describe('GET /api/utility/recovery — early departures (10/20)', () => {
  /**
   * A departure called a wash, written straight into the two tables the report
   * reads, and deliberately NOT through recordMoneyKeptOnDeparture.
   *
   * This suite asks whether the REPORT adds up, so the amounts have to be
   * chosen rather than derived — and a change to how the service decides what a
   * person kept must not start failing a test about arithmetic. The service has
   * its own suite for the deciding.
   */
  async function seedWash(f: any, opts: {
    utilityType: string
    absorbed: number
    tax?: number
    amountKept: number
    leaseId?: string
    departedOn?: string
    paidThrough?: string
    cycleMonth?: string
    withClosingRead?: boolean
  }) {
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee)
       VALUES ($1,$2,'M','submeter',0) RETURNING id`, [f.propertyId, opts.utilityType])
    const { rows: [wash] } = await db.query<any>(
      `INSERT INTO early_departure_washes
         (landlord_id, property_id, unit_id, tenant_id, lease_id,
          departed_on, paid_through, amount_kept)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [f.landlordId, f.propertyId, f.unitId, f.tenantId, opts.leaseId ?? f.leaseId,
       opts.departedOn ?? '2026-03-18', opts.paidThrough ?? '2026-04-04', opts.amountKept])
    if (opts.withClosingRead !== false) {
      await db.query(
        `INSERT INTO utility_absorbed_charges
           (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
            allocation_method, charge_amount, tax_amount, reason, wash_id, lease_id, departed_on)
         VALUES ($1,$2,$3,$4,$5,'submeter',$6,$7,'early_departure_wash',$8,$9,$10)`,
        [meter.id, f.unitId, f.landlordId, opts.utilityType, opts.cycleMonth ?? '2026-03-01',
         opts.absorbed, opts.tax ?? 0, wash.id, opts.leaseId ?? f.leaseId,
         opts.departedOn ?? '2026-03-18'])
    }
    return { meterId: meter.id as string, washId: wash.id as string }
  }

  /**
   * THE ONE THAT MATTERS. Nic's standing rule is that every dollar is counted
   * exactly once. If the absorbed power showed both as its own slice AND inside
   * the gap, the report would be adding the same dollar twice and the number he
   * wants to trust would be wrong in his favour.
   *
   * So the identity is asserted, not assumed:
   *     notRecovered = ownerOccupied + earlyDepartureWash + unattributed
   */
  it('names the power a departing guest was never billed, and never counts it twice', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, utility_type, amount, expense_date)
       VALUES ($1,$2,'utilities','water',1000,'2026-03-10')`, [f.landlordId, f.propertyId])
    const { rows: [billMeter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee)
       VALUES ($1,'water','W','submeter',0) RETURNING id`, [f.propertyId])
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-02-01','submeter',0,0,300,0,0,'water')`,
      [billMeter.id, f.unitId, f.tenantId, f.leaseId, f.landlordId])
    // the owner's own space took a share of the pool, recorded as it happened
    await db.query(
      `INSERT INTO utility_owner_use_absorptions (meter_id, unit_id, landlord_id, utility_type,
              billing_cycle_month, allocation_method, charge_amount, base_fee_share)
       VALUES ($1,$2,$3,'water','2026-03-01','submeter',100,0)`,
      [billMeter.id, f.unitId, f.landlordId])
    // and somebody left early keeping $51, so their final $150 stub billed nobody
    await seedWash(f, { utilityType: 'water', absorbed: 120, tax: 30, amountKept: 51 })

    const d = await get(f)
    const water = d.lines.find((l: any) => l.utilityType === 'water')
    expect(water.spent).toBe(1000)
    expect(water.recovered).toBe(300)
    expect(water.notRecovered).toBe(700)
    expect(water.ownerOccupied).toBe(100)
    expect(water.earlyDepartureWash).toBe(150)      // tax counted, as on the billed side
    expect(water.unattributed).toBe(450)

    // THE DOUBLE-COUNT. The named slices live inside the gap; they do not add to it.
    expect(water.ownerOccupied + water.earlyDepartureWash + water.unattributed)
      .toBe(water.notRecovered)
    expect(water.notRecovered).toBe(water.spent - water.recovered)

    const t = d.totals
    expect(t).toMatchObject({ notRecovered: 700, ownerOccupied: 100, earlyDepartureWash: 150, unattributed: 450 })
    expect(t.ownerOccupied + t.earlyDepartureWash + t.unattributed).toBe(t.notRecovered)
  })

  it('reports the money kept and how many people left early', async () => {
    const f = await seed()
    const second = await (async () => {
      const c = await db.connect()
      try { return await seedLease(c, { unitId: f.unitId, landlordId: f.landlordId, status: 'expired' }) }
      finally { c.release() }
    })()
    await seedWash(f, { utilityType: 'electric', absorbed: 18.40, amountKept: 51 })
    await seedWash(f, { utilityType: 'electric', absorbed: 9.60, amountKept: 24, leaseId: second,
      departedOn: '2026-05-20', paidThrough: '2026-06-01', cycleMonth: '2026-05-01' })

    const t = (await get(f)).totals
    expect(t.earlyDepartures.departures).toBe(2)
    expect(t.earlyDepartures.moneyKept).toBe(75)
    expect(t.earlyDepartures.utilityAbsorbed).toBe(28)
    expect(t.earlyDepartureWash).toBe(28)           // the per-utility slice agrees
  })

  // "I want to make sure that it's somewhat fair." Which way it leans, both ways,
  // and signed — a figure that only ever read as a win would not answer that.
  it('the comparison leans toward the landlord when the kept money covered the power', async () => {
    const f = await seed()
    await seedWash(f, { utilityType: 'electric', absorbed: 18.40, amountKept: 51 })
    const t = (await get(f)).totals
    expect(t.earlyDepartures).toMatchObject({ moneyKept: 51, utilityAbsorbed: 18.40, evenedOutBy: 32.60 })
  })

  it('and leans the other way when the power cost more than was kept', async () => {
    const f = await seed()
    await seedWash(f, { utilityType: 'electric', absorbed: 75, amountKept: 20 })
    const t = (await get(f)).totals
    expect(t.earlyDepartures).toMatchObject({ moneyKept: 20, utilityAbsorbed: 75, evenedOutBy: -55 })
  })

  // A departure whose closing read has not landed has money on one side and
  // nothing on the other. Counted and SAID, so a half-measured window cannot
  // read as a park that came out ahead.
  it('a departure still waiting on its closing read is counted and named', async () => {
    const f = await seed()
    await seedWash(f, { utilityType: 'electric', absorbed: 0, amountKept: 51, withClosingRead: false })
    const t = (await get(f)).totals
    expect(t.earlyDepartures).toMatchObject({
      departures: 1, moneyKept: 51, utilityAbsorbed: 0, awaitingClosingRead: 1,
    })
  })

  // The same discipline the gap has always had. A landlord who never recorded
  // the provider's bill has nothing to divide up, and printing a shortfall
  // nobody measured would be a lie in his own report.
  it('no expense recorded → the gap and the unattributed part are both null, and the wash still shows', async () => {
    const f = await seed()
    await seedWash(f, { utilityType: 'electric', absorbed: 150, amountKept: 51 })
    const d = await get(f)
    const e = d.lines.find((l: any) => l.utilityType === 'electric')
    expect(e.earlyDepartureWash).toBe(150)
    expect(e.notRecovered).toBeNull()
    expect(e.unattributed).toBeNull()
    expect(d.totals.notRecovered).toBeNull()
    expect(d.totals.unattributed).toBeNull()
    expect(d.totals.earlyDepartureWash).toBe(150)
  })

  it("another landlord's early departures never reach this one's report", async () => {
    const a = await seed()
    const b = await seed()
    await seedWash(a, { utilityType: 'electric', absorbed: 18.40, amountKept: 51 })
    await seedWash(b, { utilityType: 'electric', absorbed: 900, amountKept: 4000 })

    const t = (await get(a)).totals
    expect(t.earlyDepartureWash).toBe(18.40)
    expect(t.earlyDepartures).toMatchObject({ departures: 1, moneyKept: 51, utilityAbsorbed: 18.40 })
  })
})


/**
 * 10/20 (Nic) — THE GAP SPLITS THREE WAYS.
 *
 *   "I know we already have a utilities not build back, but it needs to be
 *    separated between stuff that the property just generally uses, the
 *    property's own consumption, versus what somebody used that didn't get
 *    billed back. There's a distinction there that I want to make, and that
 *    distinction needs to be applied against money that could have been
 *    prorated back that wasn't."
 *
 * THE PROPERTY USED IT — the office, the shop, irrigation, a vacant site's base
 *   charge, an owner-occupied space's power ("owner-occupied power would be
 *   considering the property to have used it"). A cost of doing business.
 * RECOVERED — three sources, where this report counted one: a bill, a register
 *   or pay-link sale, and power that was inside a nightly or weekly rate.
 * SOMEBODY'S USAGE, NEVER RECOVERED — the gap number, and the only one the
 *   money kept on an early departure is set against.
 */
describe('GET /api/utility/recovery — the three-way split (10/20)', () => {
  /** A meter of the given kind at the property. */
  const meter = async (f: any, utilityType: string, method = 'submeter') => (await db.query<any>(
    `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee)
     VALUES ($1,$2,'M',$3,0) RETURNING id`, [f.propertyId, utilityType, method])).rows[0].id as string

  /** A row on the one book for utility billed to nobody, with its reason. */
  const absorbed = async (f: any, o: {
    meterId: string; utilityType: string; reason: string; amount: number; tax?: number
    cycleMonth?: string; washId?: string
  }) => db.query(
    `INSERT INTO utility_absorbed_charges
       (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
        allocation_method, charge_amount, tax_amount, reason, wash_id)
     VALUES ($1,$2,$3,$4,$5,'submeter',$6,$7,$8,$9)`,
    [o.meterId, f.unitId, f.landlordId, o.utilityType, o.cycleMonth ?? '2026-03-01',
     o.amount, o.tax ?? 0, o.reason, o.washId ?? null])

  const spend = (f: any, utilityType: string, amount: number) => db.query(
    `INSERT INTO landlord_expenses (landlord_id, property_id, category, utility_type, amount, expense_date)
     VALUES ($1,$2,'utilities',$3,$4,'2026-03-10')`, [f.landlordId, f.propertyId, utilityType, amount])

  /**
   * ALL THREE AT ONCE, which is the only way to see that they do not overlap.
   * $1,000 of power: $300 billed to a tenant, $80 inside a nightly guest's
   * rate, $100 on the owner's own space, $25 of base charge on an empty one,
   * $150 eaten on a departure. The rest is the park's own lights, and nothing
   * on file says so, so it stays its own figure.
   */
  it('names the property\'s own use, the three recovery sources, and somebody\'s usage — and they reconcile', async () => {
    const f = await seed()
    await spend(f, 'electric', 1000)
    const m = await meter(f, 'electric')
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type, status)
       VALUES ($1,$2,$3,$4,$5,'2026-02-01','submeter',0,0,300,0,0,'electric','paid')`,
      [m, f.unitId, f.tenantId, f.leaseId, f.landlordId])
    await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'short_stay_in_rate', amount: 80 })
    await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'owner_use', amount: 100 })
    await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'vacant', amount: 25 })
    const { rows: [wash] } = await db.query<any>(
      `INSERT INTO early_departure_washes
         (landlord_id, property_id, unit_id, lease_id, departed_on, paid_through, amount_kept)
       VALUES ($1,$2,$3,$4,'2026-03-18','2026-04-04',51) RETURNING id`,
      [f.landlordId, f.propertyId, f.unitId, f.leaseId])
    await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'early_departure_wash',
      amount: 120, tax: 30, washId: wash.id })

    const d = await get(f)
    const e = d.lines.find((l: any) => l.utilityType === 'electric')

    // RECOVERED, three sources told apart. The rate money came in with the
    // stay, so it is recovery and not a shortfall.
    expect(e).toMatchObject({ recovered: 380, fromBills: 300, fromSales: 0, inTheRate: 80 })
    expect(e.collected).toBe(380)
    expect(e.stillOwed).toBe(0)

    // THE PROPERTY USED IT. A cost of doing business, never the gap number.
    expect(e).toMatchObject({ propertyUsed: 125, ownerOccupied: 100, vacantSpaces: 25 })

    // SOMEBODY'S USAGE, NEVER RECOVERED. The wash, with its tax, because the
    // billed side counts tax too.
    expect(e.somebodysUsage).toBe(150)
    expect(e.earlyDepartureWash).toBe(150)

    // AND THEY RECONCILE EXACTLY — every dollar counted once.
    expect(e.notRecovered).toBe(620)                   // 1000 spent - 380 recovered
    expect(e.unattributed).toBe(345)                   // the park's own lights
    expect(e.propertyUsed + e.somebodysUsage + e.unattributed).toBe(e.notRecovered)

    const t = d.totals
    expect(t).toMatchObject({
      recovered: 380, fromBills: 300, fromSales: 0, inTheRate: 80,
      propertyUsed: 125, ownerOccupied: 100, vacantSpaces: 25,
      somebodysUsage: 150, notRecovered: 620, unattributed: 345,
    })
    expect(t.propertyUsed + t.somebodysUsage + t.unattributed).toBe(t.notRecovered)
  })

  /**
   * THE MOST IMPORTANT TEST IN THIS BUILD. Nic's standing rule is that every
   * dollar is counted exactly once, and a pay link is the newest door money
   * comes through — "a paylink's utility line settles the bill and counts as
   * recovery."
   *
   * $163.17 of Andres Razo's power, collected in full on a link. It must be in
   * `recovered` and it must be NOWHERE in the gap: not in `notRecovered`, not
   * in `unattributed`, not in `somebodysUsage`. Before this lane his money was
   * collected and the report had no idea it had been recovered.
   */
  it('a utility recovered on a pay link is NOT also sitting in the unattributed gap', async () => {
    const f = await seed()
    await spend(f, 'electric', 163.17)
    const { electric } = await seedCatalog(f)
    const { rows: [tx] } = await db.query<any>(
      `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, total, status, created_at)
       VALUES ($1,$2,$3,'card',163.17,163.17,'completed','2026-03-14') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId])
    await db.query(
      `INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, item_category, qty, unit_price, subtotal, recovers_utility)
       VALUES ($1,$2,'Electric (per kWh)','Utilities',387,0.21,81.27,'electric'),
              ($1,$2,'Electric (per kWh) — September, RV 27','Utilities',390,0.21,81.90,'electric')`,
      [tx.id, electric])

    const d = await get(f)
    const e = d.lines.find((l: any) => l.utilityType === 'electric')
    expect(e).toMatchObject({ spent: 163.17, recovered: 163.17, fromSales: 163.17, collected: 163.17 })
    // Recovered in full, so there is no gap at all — and therefore nothing to
    // divide into buckets. The same dollar cannot be both.
    expect(e.notRecovered).toBe(0)
    expect(e.unattributed).toBe(0)
    expect(e.somebodysUsage).toBe(0)
    expect(e.propertyUsed).toBe(0)
    expect(d.totals).toMatchObject({ notRecovered: 0, unattributed: 0, somebodysUsage: 0 })
  })

  /**
   * THE OTHER HALF OF THE DOUBLE-COUNT, and the one with teeth. A final
   * electric bill SENT AS A PAY LINK exists twice in the data on purpose: once
   * as the utility_bills row it was raised from, and once as a line on the
   * link. Counting both would report $44.94 of power as $89.88 recovered.
   *
   * It cannot happen, and not because of a flag somebody maintains: a
   * bill-raised line is written by the server with NO catalog item on it
   * (services/utilityPayLink writes id null and names the bill instead), so it
   * joins no item, has no recovers_utility, and this report never sees it. The
   * BILL is the one figure — owed while the link is open, collected once it is
   * paid — and the settlement row only ever says HOW it was collected.
   */
  it('a bill sent as a pay link is counted ONCE — the bill, never the bill and the link', async () => {
    const f = await seed()
    await spend(f, 'electric', 100)
    const m = await meter(f, 'electric')
    const { rows: [pay] } = await db.query<any>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',44.94,'pending','2026-04-01','UTILITY') RETURNING id`,
      [f.landlordId, f.tenantId, f.unitId, f.leaseId])
    const { rows: [bill] } = await db.query<any>(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount,
                                  utility_type, status, payment_id)
       VALUES ($1,$2,$3,$4,$5,'2026-03-01','submeter',0,0,44.94,0,0,'electric','billed',$6) RETURNING id`,
      [m, f.unitId, f.tenantId, f.leaseId, f.landlordId, pay.id])

    // The link raised FROM that bill: no catalog item, the bill named instead.
    const billLine = [{ id: null, name: 'Electric — March 2026', qty: 1, price: 44.94, tax: 0,
                        utilityBillId: bill.id }]
    const { rows: [link] } = await db.query<any>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items,
                                  subtotal, total, customer_name, customer_email, created_at)
       VALUES ('tok-final-bill', $1, $2, $3, 'one_time', 'Final electric', $4::jsonb, 44.94, 44.94,
               'Andres Razo', 'razo@example.com', '2026-03-20') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId, JSON.stringify(billLine)])

    // While the link is OUT: the bill says it is owed, and that is the only
    // figure. $44.94, not $89.88.
    let d = await get(f)
    let e = d.lines.find((l: any) => l.utilityType === 'electric')
    expect(e).toMatchObject({ recovered: 44.94, fromBills: 44.94, fromSales: 0, collected: 0 })
    expect(e.stillOwed).toBe(44.94)
    expect(e.notRecovered).toBe(55.06)

    // He pays it. The bill follows its payment to 'paid'; the sale carries a
    // line with no item, which this report cannot see and must not.
    const { rows: [tx] } = await db.query<any>(
      `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, total, status, pay_link_id, created_at)
       VALUES ($1,$2,$3,'card',44.94,44.94,'completed',$4,'2026-03-22') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId, link.id])
    await db.query(
      `INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, item_category, qty, unit_price, subtotal, recovers_utility)
       VALUES ($1,NULL,'Electric — March 2026',NULL,1,44.94,44.94,NULL)`, [tx.id])
    await db.query(`UPDATE pos_pay_links SET status='paid', paid_at=NOW(), pos_transaction_id=$1 WHERE id=$2`, [tx.id, link.id])
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [pay.id])

    d = await get(f)
    e = d.lines.find((l: any) => l.utilityType === 'electric')
    // STILL $44.94. Collected now, and not a cent of it doubled.
    expect(e).toMatchObject({ recovered: 44.94, fromBills: 44.94, fromSales: 0, collected: 44.94 })
    expect(e.stillOwed).toBe(0)
    expect(e.notRecovered).toBe(55.06)
    expect(e.unattributed).toBe(55.06)
    expect(d.totals).toMatchObject({ recovered: 44.94, collected: 44.94, fromSales: 0 })
  })

  // 10/20 (Nic): "On delivery to the site, that is a utility." A tank the
  // company comes and fills bills back in installments on the resident's
  // invoice, and utility_bills cannot hold propane at all — its CHECK has five
  // types and propane is not one. So the fill IS propane's bill, and without
  // this the first park with a propane expense would read 100% unrecovered.
  it('a delivered propane fill is propane\'s bill — counted as recovery, installment by installment', async () => {
    const f = await seed()
    await spend(f, 'propane', 500)
    const { rows: [fill] } = await db.query<any>(
      `INSERT INTO propane_fills (property_id, landlord_id, unit_id, lease_id, tenant_id,
                                  fill_date, gallons, price_per_gallon, total_amount,
                                  installment_count, tax_rate_pct, tax_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-03-02',96,3.30,337.70,2,6.60,20.90) RETURNING id`,
      [f.propertyId, f.landlordId, f.unitId, f.leaseId, f.tenantId])
    const { rows: [paid] } = await db.query<any>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, settled_at, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',168.85,'settled',NOW(),'2026-04-01','PROPANE') RETURNING id`,
      [f.landlordId, f.tenantId, f.unitId, f.leaseId])
    await db.query(
      `INSERT INTO propane_fill_installments (fill_id, installment_number, amount, gallons, billing_cycle_month, payment_id)
       VALUES ($1,1,168.85,48,'2026-04-01',$2),
              ($1,2,168.85,48,'2026-05-01',NULL)`, [fill.id, paid.id])

    const d = await get(f)
    const lpg = d.lines.find((l: any) => l.utilityType === 'propane')
    // total_amount already carries the fill's propane tax and delivery share,
    // so the installments sum to it and nothing is added on top.
    expect(lpg).toMatchObject({ spent: 500, recovered: 337.70, fromBills: 337.70, fromSales: 0 })
    expect(lpg.collected).toBe(168.85)
    expect(lpg.stillOwed).toBe(168.85)
    expect(lpg.notRecovered).toBe(162.30)
  })

  /**
   * "that distinction needs to be applied against money that could have been
   * prorated back that wasn't."
   *
   * The money kept on a departure is set against SOMEBODY'S USAGE and nothing
   * else. Setting it against the whole gap would charge the departing guests
   * for the office lights, and would read as the park coming out miles behind
   * on a comparison that was never about the park's own power.
   */
  it('the property\'s own use never faces the money-kept figure', async () => {
    const f = await seed()
    await spend(f, 'electric', 1000)
    const m = await meter(f, 'electric')
    await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'owner_use', amount: 400 })
    await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'vacant', amount: 200 })
    const { rows: [wash] } = await db.query<any>(
      `INSERT INTO early_departure_washes
         (landlord_id, property_id, unit_id, lease_id, departed_on, paid_through, amount_kept)
       VALUES ($1,$2,$3,$4,'2026-03-18','2026-04-04',51) RETURNING id`,
      [f.landlordId, f.propertyId, f.unitId, f.leaseId])
    await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'early_departure_wash',
      amount: 18.40, washId: wash.id })

    const t = (await get(f)).totals
    expect(t).toMatchObject({ propertyUsed: 600, somebodysUsage: 18.40 })
    // The comparison sees the departure's $18.40 and not a cent of the $600.
    expect(t.earlyDepartures).toMatchObject({
      departures: 1, moneyKept: 51, utilityAbsorbed: 18.40, evenedOutBy: 32.60,
    })
    // And the $600 is still inside the gap, not added beside it.
    expect(t.notRecovered).toBe(1000)
    expect(t.propertyUsed + t.somebodysUsage + t.unattributed).toBe(t.notRecovered)
  })

  // The same discipline the gap has always had, applied to the new slices: a
  // landlord who never recorded the provider's bill has nothing to divide up.
  // The recovery sources and the property's own use are still real figures —
  // they were recorded as they happened — so only the gap goes to a dash.
  it('no expense recorded → the gap and the unattributed part are null, but the buckets still read', async () => {
    const f = await seed()
    const m = await meter(f, 'water')
    await absorbed(f, { meterId: m, utilityType: 'water', reason: 'owner_use', amount: 60 })
    await absorbed(f, { meterId: m, utilityType: 'water', reason: 'short_stay_in_rate', amount: 15 })

    const d = await get(f)
    const w = d.lines.find((l: any) => l.utilityType === 'water')
    expect(w).toMatchObject({ spent: 0, recovered: 15, inTheRate: 15, propertyUsed: 60, ownerOccupied: 60 })
    expect(w.notRecovered).toBeNull()
    expect(w.unattributed).toBeNull()
    expect(d.totals.notRecovered).toBeNull()
    expect(d.totals.unattributed).toBeNull()
    expect(d.totals.propertyUsed).toBe(60)
  })

  it('another landlord\'s absorbed power never reaches this one\'s buckets', async () => {
    const a = await seed()
    const b = await seed()
    for (const f of [a, b]) {
      const m = await meter(f, 'electric')
      await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'owner_use',
        amount: f === a ? 10 : 9000 })
      await absorbed(f, { meterId: m, utilityType: 'electric', reason: 'short_stay_in_rate',
        amount: f === a ? 5 : 7000 })
    }
    const t = (await get(a)).totals
    expect(t).toMatchObject({ propertyUsed: 10, ownerOccupied: 10, inTheRate: 5, recovered: 5 })
  })
})
