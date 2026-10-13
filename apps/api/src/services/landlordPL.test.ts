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
import { computeLandlordPL, landlordIncomeSql, landlordDepositSql, landlordPLExpenses, landlordPLExpensesByProperty, NO_PROPERTY_KEY } from './landlordPL'

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

    // 10/12 review: every property's expenses in one pass (the monthly report)
    // are exactly the one-property P&L's, and with the company's own costs
    // they add up to the whole company's.
    const months = ['2026-09-01']
    const byProp = await landlordPLExpensesByProperty(f.landlordId, '2026-09-01', '2026-09-30', months)
    expect(byProp.get(p1.property_id)).toEqual(await landlordPLExpenses(f.landlordId, '2026-09-01', '2026-09-30', months, [p1.property_id]))
    expect(byProp.get(park2!)).toEqual(await landlordPLExpenses(f.landlordId, '2026-09-01', '2026-09-30', months, [park2!]))
    expect(byProp.get(NO_PROPERTY_KEY)).toMatchObject({ enteredExpenses: 40, maintenance: 0 })
    const whole = await landlordPLExpenses(f.landlordId, '2026-09-01', '2026-09-30', months)
    const sum = [...byProp.values()].reduce((t, e) => t + e.total, 0)
    expect(Math.round(sum * 100) / 100).toBe(whole.total)
    // Narrowed to one property: that property only, no company bucket.
    const one = await landlordPLExpensesByProperty(f.landlordId, '2026-09-01', '2026-09-30', months, [park2!])
    expect([...one.keys()]).toEqual([park2!])
    expect(one.get(park2!)).toEqual(byProp.get(park2!))
  })
})

/**
 * 10/11 (Nic): "Payment processing fees". A property that covers its tenants'
 * card or bank fee has it taken out of the landlord's share when the payment
 * settles (allocation), while income counts the whole rent — so the fee is an
 * expense, read from what allocation booked (customer_fee_charged on its
 * banking_spread rows), counted only when the tenant's payment carried no fee
 * on top (tenant_remittances), and never the platform fee a property passes to
 * its tenants (that is the platform fee line's).
 */
describe('computeLandlordPL — payment processing fees the landlord covers (10/11)', () => {
  async function propertyOf(unitId: string): Promise<string> {
    const { rows: [u] } = await db.query<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [unitId])
    return u.property_id
  }

  /**
   * A rent row paid through Stripe on `pi`, settled at `settledAt`, its
   * remittance carrying `onTop` dollars of fee on top of the rent, and the
   * banking spread allocation booked with the fee it charged (`fee`).
   */
  async function stripePaid(f: { landlordId: string; unitId: string; tenantId: string }, o: {
    amount: number; settledAt: string; pi: string; onTop: number; fee: number; method?: 'ach' | 'card'; due?: string
  }): Promise<{ paymentId: string; remittanceId: string }> {
    const propertyId = await propertyOf(f.unitId)
    const { rows: [p] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at,
                             stripe_payment_intent_id, platform_held)
       VALUES ($1,$2,$3,'rent',$4,'settled','RENT',$5::date,$6::timestamptz,$7,TRUE) RETURNING id`,
      [f.unitId, f.tenantId, f.landlordId, o.amount, o.due ?? '2026-09-01', o.settledAt, o.pi])
    const { rows: [r] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       stripe_payment_intent_id, gross_amount, processing_fee_amount, settled_at)
       VALUES ($1,$2,$3,$3,'settled',$4,$5,$6,$7,$8::timestamptz) RETURNING id`,
      [f.tenantId, f.landlordId, o.amount, o.method ?? 'ach', o.pi, o.amount + o.onTop, o.onTop, o.settledAt])
    await db.query(
      `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`,
      [r.id, p.id, o.amount])
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, property_id,
                                            customer_fee_charged, created_at, notes)
       VALUES ('banking_spread', $1, $1, $2, 'payment', $3, $4, $5::timestamptz, 'test spread')`,
      [Math.round((o.fee - 1) * 100) / 100, p.id, propertyId, o.fee, o.settledAt])
    return { paymentId: p.id, remittanceId: r.id }
  }

  it('the $6 bank fee a landlord covers is an expense; a fee the tenant paid on top is not', async () => {
    const f = await seed()
    await stripePaid(f, { amount: 1000, settledAt: '2026-09-03T10:00:00-07:00', pi: 'pi_landlord_covers', onTop: 0, fee: 6 })
    await stripePaid(f, { amount: 500, settledAt: '2026-09-04T10:00:00-07:00', pi: 'pi_tenant_pays', onTop: 18.05, fee: 18.05,
                          method: 'card', due: '2026-09-02' })
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.rent).toBe(1500)
    expect(pl.expenses.processingFees).toBe(6)
    expect(pl.expenses.total).toBe(Math.round((pl.expenses.platformFee + 6) * 100) / 100)
    expect(pl.net).toBe(Math.round((1500 - pl.expenses.total) * 100) / 100)
  })

  it('a platform fee the property passed to its tenants rides in the payment but is not a processing fee', async () => {
    const f = await seed()
    const propertyId = await propertyOf(f.unitId)
    const { remittanceId } = await stripePaid(f, { amount: 1000, settledAt: '2026-09-03T10:00:00-07:00', pi: 'pi_with_platform_fee', onTop: 24, fee: 6 })
    // The tenant's $24 platform fee charge, paid by the same remittance.
    const { rows: [pf] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, revenue_owner)
       VALUES ($1,$2,$3,'platform_fee',24,'settled','SUBSCRIP','2026-09-01','2026-09-03T10:00:00-07:00','gam') RETURNING id`,
      [f.unitId, f.tenantId, f.landlordId])
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,24)`, [remittanceId, pf.id])
    await db.query(
      `INSERT INTO platform_fee_accruals (landlord_id, property_id, accrual_month, rate_per_unit, min_per_connect_account,
                                          total_amount, payer, tenant_charge_id, updated_at)
       VALUES ($1,$2,'2026-09-01',2,10,24,'tenant',$3, now() + interval '1 minute')`,
      [f.landlordId, propertyId, pf.id])
    const pl = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    // The $24 on top was the platform fee, not a processing fee: the $6 is still the landlord's.
    expect(pl.expenses.processingFees).toBe(6)
  })

  it('counts on the day the payment settled at the property, and a property-scoped P&L carries only its own', async () => {
    const f = await seed()
    const c = await db.connect()
    let unit2: string
    try {
      const { rows: [l] } = await c.query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [f.landlordId])
      const park2 = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: l.user_id, managedByUserId: l.user_id })
      unit2 = await seedUnit(c, { propertyId: park2, landlordId: f.landlordId, rentAmount: 500 })
    } finally { c.release() }
    await stripePaid(f, { amount: 1000, settledAt: '2026-09-30T23:30:00-07:00', pi: 'pi_last_day', onTop: 0, fee: 6 })
    await stripePaid(f, { amount: 1000, settledAt: '2026-10-01T00:30:00-07:00', pi: 'pi_next_month', onTop: 0, fee: 6, due: '2026-10-01' })
    await stripePaid({ ...f, unitId: unit2! }, { amount: 500, settledAt: '2026-09-10T10:00:00-07:00', pi: 'pi_park2', onTop: 0, fee: 6 })

    const sept = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(sept.expenses.processingFees).toBe(12)
    const park1Only = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'], 'received',
      [await propertyOf(f.unitId)])
    expect(park1Only.expenses.processingFees).toBe(6)
    const oct = await computeLandlordPL(f.landlordId, '2026-10-01', '2026-10-31', ['2026-10-01'])
    expect(oct.expenses.processingFees).toBe(6)
    // The same under Money billed: an expense is dated by when it was taken.
    const septBilled = await computeLandlordPL(f.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'], 'billed')
    expect(septBilled.expenses.processingFees).toBe(12)
  })
})
