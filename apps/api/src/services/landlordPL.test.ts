/**
 * computeLandlordPL — the period's LAST DAY counts in full (S654).
 *
 * Callers pass the end as a bare date ('2026-09-30', the Books P&L and the
 * agent's P&L tool) or as monthRange's '2026-09-30T23:59:59-07:00'. A bare
 * date compared to a timestamp is midnight at the START of that day, so
 * `settled_at <= '2026-09-30'` dropped every payment settled on the 30th.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { computeLandlordPL, landlordIncomeSql, landlordDepositSql } from './landlordPL'

beforeEach(cleanupAllSchema)

async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const tenantId = await seedTenant(c)
    return { landlordId, unitId, tenantId }
  } finally { c.release() }
}

// One rent row per unit per due date, so each settle gets its own due date.
async function settledRent(f: { landlordId: string; unitId: string; tenantId: string }, amount: number, settledAt: string, dueDate = '2026-09-01') {
  await db.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
     VALUES ($1, $2, $3, 'rent', $4, 'settled', 'RENT', $5::date, $6::timestamptz)`,
    [f.unitId, f.tenantId, f.landlordId, amount, dueDate, settledAt])
}

async function completedRepair(f: { landlordId: string; unitId: string }, cost: number, completedAt: string) {
  await db.query(
    `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
     VALUES ($1, $2, 'Fix', 'Fix it', 'completed', $3, $4::timestamptz)`,
    [f.unitId, f.landlordId, cost, completedAt])
}

describe('computeLandlordPL — the last day of the period counts (S654)', () => {
  it('a bare-date end includes a payment settled at 3 pm on the last day', async () => {
    const f = await seed()
    await settledRent(f, 1000, '2026-09-30T15:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(1000)
  })

  it('a bare-date end includes a repair completed on the last day', async () => {
    const f = await seed()
    await completedRepair(f, 250, '2026-09-30T15:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.expenses.maintenance).toBe(250)
  })

  it("monthRange's end-of-day timestamp includes the last day too", async () => {
    const f = await seed()
    await settledRent(f, 1000, '2026-09-30T15:00:00-07:00')
    await completedRepair(f, 250, '2026-09-30T23:59:59.5-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01T00:00:00-07:00', '2026-09-30T23:59:59-07:00', ['2026-09-01'])
    expect(pl.gross.rent).toBe(1000)
    expect(pl.expenses.maintenance).toBe(250)
  })

  it('the next day and the day before the start stay out', async () => {
    const f = await seed()
    await settledRent(f, 1000, '2026-10-01T00:00:00-07:00')   // first moment of Oct 1
    await settledRent(f, 500, '2026-08-31T23:59:59-07:00', '2026-08-01') // last moment of Aug 31
    await completedRepair(f, 250, '2026-10-01T00:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(0)
    expect(pl.expenses.maintenance).toBe(0)
  })
})

/**
 * S654: every dollar counted once. Income is the landlord's own money only —
 * a GAM fee carrying this landlord_id, and paid-ahead money GAM holds, are not.
 */
describe('computeLandlordPL — only the landlord\'s own money is income (S654)', () => {
  async function settled(f: { landlordId: string; unitId: string; tenantId: string },
    type: string, amount: number, owner: 'landlord' | 'gam' | 'held', settledAt: string) {
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, revenue_owner)
       VALUES ($1, $2, $3, $4, $5, 'settled', $8, '2026-09-01', $6::timestamptz, $7)`,
      [f.unitId, f.tenantId, f.landlordId, type, amount, settledAt, owner,
       ({ rent: 'RENT', deposit: 'DEPOSIT', late_fee: 'LATEFEE', home_payment: 'HOMEPMT', carried_balance: 'BALANCE' } as Record<string, string>)[type] ?? 'OTHERFEE'])
  }

  it('$700 rent, a $6 GAM fee and a $500 held deposit → rent 700, fees 0, deposits held 500', async () => {
    const f = await seed()
    await settled(f, 'rent', 700, 'landlord', '2026-09-03T10:00:00-07:00')
    await settled(f, 'fee', 6, 'gam', '2026-09-05T10:00:00-07:00')
    await settled(f, 'deposit', 500, 'held', '2026-09-02T10:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(700)
    expect(pl.gross.fees).toBe(0)
    expect(pl.gross.total).toBe(700)
    expect(pl.depositsHeld).toBe(500)
  })

  it('S654: $700 rent + $400 home-sale + $50 carried balance = 1,150; a GAM fee and a deposit are not income', async () => {
    const f = await seed()
    await settled(f, 'rent', 700, 'landlord', '2026-09-03T10:00:00-07:00')
    await settled(f, 'home_payment', 400, 'landlord', '2026-09-04T10:00:00-07:00')
    await settled(f, 'carried_balance', 50, 'landlord', '2026-09-06T10:00:00-07:00')
    await settled(f, 'fee', 6, 'gam', '2026-09-05T10:00:00-07:00')
    await settled(f, 'deposit', 500, 'landlord', '2026-09-02T10:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross).toMatchObject({ rent: 700, fees: 0, homeSale: 400, balances: 50, other: 450, total: 1150 })
    expect(pl.depositsHeld).toBe(500)
  })

  it('S654: a FlexPay pull (GAM reimbursing its own front) is not the landlord\'s rent', async () => {
    const f = await seed()
    await settled(f, 'rent', 700, 'landlord', '2026-09-06T10:00:00-07:00')
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1, $2, $3, 'rent', 725, 'settled', 'FLEXPAY', '2026-09-15', '2026-09-12T10:00:00-07:00')`,
      [f.unitId, f.tenantId, f.landlordId])
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(700)
    expect(pl.gross.total).toBe(700)
  })

  it('S654: landlordIncomeSql reads the same rows with or without a table alias', async () => {
    const f = await seed()
    await settled(f, 'rent', 700, 'landlord', '2026-09-03T10:00:00-07:00')
    await settled(f, 'carried_balance', 50, 'landlord', '2026-09-06T10:00:00-07:00')
    await settled(f, 'fee', 6, 'gam', '2026-09-05T10:00:00-07:00')
    await settled(f, 'fee', 700, 'held', '2026-09-07T10:00:00-07:00')
    await settled(f, 'deposit', 500, 'landlord', '2026-09-02T10:00:00-07:00')
    const bare = await db.query(`SELECT COALESCE(SUM(amount),0)::float AS t FROM payments WHERE ${landlordIncomeSql()}`)
    const aliased = await db.query(`SELECT COALESCE(SUM(p.amount),0)::float AS t FROM payments p WHERE ${landlordIncomeSql('p')}`)
    const deposits = await db.query(`SELECT COALESCE(SUM(amount),0)::float AS t FROM payments WHERE ${landlordDepositSql()}`)
    expect(bare.rows[0].t).toBe(750)
    expect(aliased.rows[0].t).toBe(750)
    expect(deposits.rows[0].t).toBe(500)
  })

  it('a landlord fee counts; a held paid-ahead fee does not', async () => {
    const f = await seed()
    await settled(f, 'late_fee', 25, 'landlord', '2026-09-10T10:00:00-07:00')
    await settled(f, 'fee', 700, 'held', '2026-09-11T10:00:00-07:00')
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.fees).toBe(25)
    expect(pl.depositsHeld).toBe(0)
  })
})

/**
 * S655 (money plan, Step 3): the P&L follows the "Money received" / "Money
 * billed" switch, and a move-out row is never the landlord's income.
 */
describe('computeLandlordPL — S655 bases', () => {
  it('landlordIncomeSql leaves out a move-out row but keeps a non-refundable deposit fee', async () => {
    const f = await seed()
    const lease = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1,$2,1000,'fixed_term','active','2026-01-01') RETURNING id`, [f.unitId, f.landlordId])
    const fee = await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing)
       VALUES ($1,'pet_deposit',300,false,'move_in') RETURNING id`, [lease.rows[0].id])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, lease_fee_id)
       VALUES ($1,$2,$3,$4,'fee',300,'settled','DEPOSIT','2026-09-01','2026-09-02T10:00:00-07:00',$5),
              ($1,$2,$3,$4,'fee',-120,'settled','DEPOSIT','2026-09-20','2026-09-21T10:00:00-07:00',NULL),
              ($1,$2,$3,$4,'fee',80,'pending','DEPOSIT','2026-09-20',NULL,NULL)`,
      [f.unitId, lease.rows[0].id, f.tenantId, f.landlordId, fee.rows[0].id])
    const t = await db.query(`SELECT COALESCE(SUM(p.amount),0)::float AS t FROM payments p WHERE ${landlordIncomeSql('p')}`)
    expect(t.rows[0].t).toBe(300)
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.fees).toBe(300)
    expect(pl.gross.total).toBe(300)
  })

  it('Money billed counts a bill in the month it was due, paid or not; Money received when the money arrived', async () => {
    const f = await seed()
    // August's rent paid Sept 2; September's still open.
    await settledRent(f, 700, '2026-09-02T10:00:00-07:00', '2026-08-01')
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,'rent',700,'pending','RENT','2026-09-01')`, [f.unitId, f.tenantId, f.landlordId])
    const received = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'], 'received')
    const billed = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'], 'billed')
    expect(received.gross.rent).toBe(700)
    expect(received.basis.basis).toBe('received')
    expect(received.basis.label).toBe('Money received')
    expect(billed.gross.rent).toBe(700)
    expect(billed.beside.stillOwed).toBe(700)
    expect(billed.beside.collectedSoFar).toBe(0)
    const aug = await computeLandlordPL(f.landlordId, '2026-08-01', '2026-08-31', ['2026-08-01'], 'billed')
    expect(aug.gross.rent).toBe(700)
    expect(aug.beside.collectedSoFar).toBe(700)
    expect((await computeLandlordPL(f.landlordId, '2026-08-01', '2026-08-31', ['2026-08-01'], 'received')).gross.total).toBe(0)
  })

  it('a credit the landlord gave comes off income; register sales and other income are their own lines', async () => {
    const f = await seed()
    const lease = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1,$2,1000,'fixed_term','active','2026-01-01') RETURNING id`, [f.unitId, f.landlordId])
    const rent = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',1000,'pending','RENT','2026-09-01') RETURNING id`,
      [f.unitId, lease.rows[0].id, f.tenantId, f.landlordId])
    const credit = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,200,200,'goodwill') RETURNING id`, [f.landlordId, f.tenantId, lease.rows[0].id])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,200,'2026-09-01','desk','applied','2026-09-05T10:00:00-07:00')`,
      [credit.rows[0].id, rent.rows[0].id, lease.rows[0].id])
    await db.query(`UPDATE payments SET status='settled', settled_at='2026-09-05T10:00:00-07:00', manual_method='cash' WHERE id=$1`, [rent.rows[0].id])
    const { rows: [u] } = await db.query<{ user_id: string; property_id: string }>(
      `SELECT l.user_id, un.property_id FROM landlords l JOIN units un ON un.landlord_id = l.id WHERE l.id = $1`, [f.landlordId])
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, property_id, created_at)
       VALUES ($1,$2,'cash',40,3,43,$3,'2026-09-06T10:00:00-07:00')`, [f.landlordId, u.user_id, u.property_id])
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, category, amount, income_date) VALUES ($1,'laundry',25,'2026-09-07')`,
      [f.landlordId])
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(800)
    expect(pl.lines.registerAndStays).toBe(40)
    expect(pl.gross.otherIncome).toBe(25)
    expect(pl.gross.total).toBe(865)
    expect(pl.gross.rent + pl.gross.other).toBe(pl.gross.total)
    expect(pl.beside.creditsYouGave).toBe(200)
    expect(pl.lineItems.map(l => l.line)).toEqual(['rent', 'registerAndStays', 'otherIncome'])
  })

  it('a P&L scoped to some properties carries only their income and the expenses booked to them', async () => {
    const f = await seed()
    const c = await db.connect()
    let park2: string, unit2: string
    try {
      const { rows: [l] } = await c.query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [f.landlordId])
      park2 = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: l.user_id, managedByUserId: l.user_id })
      unit2 = await seedUnit(c, { propertyId: park2, landlordId: f.landlordId, rentAmount: 500 })
    } finally { c.release() }
    // Park 1: $1,000 of rent, a $250 repair, a $90 expense booked to it, a $40 company-wide expense.
    await settledRent(f, 1000, '2026-09-03T10:00:00-07:00')
    await completedRepair(f, 250, '2026-09-10T10:00:00-07:00')
    const { rows: [p1] } = await db.query<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [f.unitId])
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, description)
       VALUES ($1,$2,'repairs',90,'2026-09-12','Park 1 fence'), ($1,NULL,'insurance',40,'2026-09-12','Company policy')`,
      [f.landlordId, p1.property_id])
    // Park 2: $500 of rent and a $60 repair.
    await settledRent({ ...f, unitId: unit2! }, 500, '2026-09-04T10:00:00-07:00')
    await completedRepair({ ...f, unitId: unit2! }, 60, '2026-09-11T10:00:00-07:00')

    const all = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(all.gross.total).toBe(1500)
    expect(all.expenses.maintenance).toBe(310)
    expect(all.expenses.enteredExpenses).toBe(130)
    const park2Only = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'], 'received', [park2!])
    expect(park2Only.gross.total).toBe(500)
    expect(park2Only.expenses.maintenance).toBe(60)
    expect(park2Only.expenses.enteredExpenses).toBe(0)     // neither park 1's nor the company's
    expect(park2Only.expenses.platformFee).toBeLessThanOrEqual(all.expenses.platformFee)
  })
})
