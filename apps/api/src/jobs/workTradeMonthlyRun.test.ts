/**
 * S654 (Nic) — the MONTHLY run, not just the move-in bill.
 *
 *   "Work trade people are on work trade. There's no bills going out to those
 *    people."
 *
 *   "If the base space rent for the property is $450 everywhere, John
 *    Sheptock's $200 trailer payment would make it $650."
 *
 * October 1, 2026: nine work-trade residents were billed their full rent by
 * the monthly run (only the move-in bill suspended covered lines), and every
 * rent-to-own household at Country Acres got an invoice without its home
 * payment (billed standalone at 4:20, invisible to the 5:00 invoice).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant,
  seedLeaseTenant, seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { generateInvoices } from './invoiceGeneration'
import { billDueHomeSaleInstallments } from '../services/homeSale'

const RUN_AT = new Date('2026-03-05T14:00:00Z')
const DUE = '2026-03-01'

beforeEach(async () => { await cleanupAllSchema() })

async function stack(opts: {
  rent?: number
  /** undefined = agreement covers everything (table default); array = exactly these. */
  covered?: string[]
  waterBill?: number
  withTrade?: boolean
} = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone='America/Phoenix' WHERE id=$1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, {
      unitId, landlordId: ll.landlordId, status: 'active',
      rentAmount: opts.rent ?? 460, startDate: '2026-01-01',
    })
    await c.query(`UPDATE leases SET rent_due_day=1 WHERE id=$1`, [leaseId])
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })

    let agreementId: string | null = null
    if (opts.withTrade !== false) {
      const a = opts.covered
        ? await c.query<{ id: string }>(
            `INSERT INTO work_trade_agreements
               (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, covered_charges)
             VALUES ($1,$2,$3,'2026-01-01','active',80,$4) RETURNING id`,
            [unitId, tenantId, ll.landlordId, opts.covered])
        : await c.query<{ id: string }>(
            `INSERT INTO work_trade_agreements
               (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target)
             VALUES ($1,$2,$3,'2026-01-01','active',80) RETURNING id`,
            [unitId, tenantId, ll.landlordId])
      agreementId = a.rows[0].id
    }
    if (opts.waterBill) {
      const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'water' })
      await seedUtilityBill(c, {
        meterId, unitId, tenantId, leaseId, landlordId: ll.landlordId,
        chargeAmount: opts.waterBill, billingCycleMonth: DUE, status: 'unbilled', utilityType: 'water',
      })
    }
    await c.query('COMMIT')
    return { ...ll, propertyId, unitId, leaseId, tenantId, agreementId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function invoiceFor(leaseId: string) {
  const { rows } = await db.query<any>(
    `SELECT id, subtotal_rent::float AS subtotal_rent, subtotal_utilities::float AS subtotal_utilities,
            subtotal_home_payments::float AS subtotal_home_payments, total_amount::float AS total,
            late_fee_exempt, work_trade_agreement_id
       FROM invoices WHERE lease_id=$1 AND due_date=$2::date`, [leaseId, DUE])
  expect(rows).toHaveLength(1)
  return rows[0]
}

async function rowsOf(invoiceId: string) {
  const { rows } = await db.query<any>(
    `SELECT type, amount::float AS amount, status, work_trade_suspended_at IS NOT NULL AS suspended, notes
       FROM payments WHERE invoice_id=$1 ORDER BY type, created_at`, [invoiceId])
  return rows
}

describe('S654 the monthly run suspends what the trade covers', () => {
  it('rent-only trade: the rent is written and suspended, the water is owed', async () => {
    const s = await stack({ covered: ['rent'], waterBill: 40 })
    await generateInvoices(RUN_AT)

    const inv = await invoiceFor(s.leaseId)
    expect(inv.subtotal_rent).toBe(460)          // what the month is worth
    expect(inv.subtotal_utilities).toBe(40)
    expect(inv.total).toBe(40)                   // what is owed today
    expect(inv.late_fee_exempt).toBe(true)
    expect(inv.work_trade_agreement_id).toBe(s.agreementId)

    const rows = await rowsOf(inv.id)
    const rent = rows.find((r: any) => r.type === 'rent')
    const water = rows.find((r: any) => r.type === 'utility')
    expect(rent.amount).toBe(460)
    expect(rent.suspended).toBe(true)
    expect(rent.notes).toMatch(/suspended/i)
    expect(water.amount).toBe(40)
    expect(water.suspended).toBe(false)

    // The period month close settles is open, on THIS invoice, priced at the
    // covered basis only.
    const { rows: per } = await db.query<any>(
      `SELECT invoice_id, basis_amount::float AS basis, status FROM work_trade_settlements WHERE agreement_id=$1`,
      [s.agreementId])
    expect(per).toHaveLength(1)
    expect(per[0].invoice_id).toBe(inv.id)
    expect(per[0].basis).toBe(460)
    expect(per[0].status).toBe('open')
  })

  it('all-inclusive trade: every line is suspended and nothing is owed', async () => {
    const s = await stack({ waterBill: 40 })
    await generateInvoices(RUN_AT)

    const inv = await invoiceFor(s.leaseId)
    expect(inv.subtotal_rent).toBe(460)
    expect(inv.subtotal_utilities).toBe(40)
    expect(inv.total).toBe(0)
    const rows = await rowsOf(inv.id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r: any) => r.suspended)).toBe(true)
    expect(rows.every((r: any) => r.status === 'pending')).toBe(true)
  })

  it('no trade: nothing is suspended and the whole bill is owed', async () => {
    const s = await stack({ withTrade: false, waterBill: 40 })
    await generateInvoices(RUN_AT)
    const inv = await invoiceFor(s.leaseId)
    expect(inv.total).toBe(500)
    const rows = await rowsOf(inv.id)
    expect(rows.some((r: any) => r.suspended)).toBe(false)
  })
})

async function financedHome(s: { unitId: string; tenantId: string; landlordId: string }, firstMonth = DUE) {
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO home_sale_contracts
       (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount, annual_interest_rate,
        term_months, monthly_payment, start_month, status, installments_total, plan_type)
     VALUES ($1,$2,$3,12000,0,12000,0,60,200,$4::date,'active',60,'flat') RETURNING id`,
    [s.unitId, s.tenantId, s.landlordId, firstMonth])
  await db.query(
    `INSERT INTO home_sale_installments
       (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
     VALUES ($1, 1, $2::date, 200, 200, 0, 11800),
            ($1, 2, ($2::date + INTERVAL '1 month')::date, 200, 200, 0, 11600)`,
    [c.id, firstMonth])
  return c.id
}

/**
 * 10/25 (Nic): THE HOME PAYMENT DOES NOT RIDE THE RENT INVOICE.
 *
 *   "Should trailer payments get their own invoice separately payable from lot
 *    rent? Yeah, let's do that."
 *
 * S654 put the installment on the rent bill so every surface could see it. The
 * cost was that it could not be paid on its own — and Lisa Scheeler, on work
 * trade, gets no rent bill at all for it to ride. It is its own bill now.
 */
/**
 * 10/25 (Nic): "Leave current properties set up as is. Let landlords choose how
 * it gets bundled." A property can put the installment back on the rent bill.
 */
describe('a property that bundles the trailer payment onto the rent bill', () => {
  const bundle = (unitId: string) => db.query(
    `UPDATE properties SET home_payments_own_bill = FALSE
      WHERE id = (SELECT property_id FROM units WHERE id = $1)`, [unitId])

  it('rides the rent bill for the month that has one', async () => {
    const s = await stack({ withTrade: false })
    const contractId = await financedHome(s)
    await bundle(s.unitId)
    await generateInvoices(RUN_AT)

    // The generator attaches it once the bill is committed.
    const inv = await invoiceFor(s.leaseId)
    expect(inv.subtotal_home_payments).toBe(200)
    expect(inv.total).toBe(660)                  // $460 rent + $200 home payment
    const home = (await rowsOf(inv.id)).find((r: any) => r.type === 'home_payment')
    expect(home).toMatchObject({ amount: 200, status: 'pending', notes: 'Home payment 1 of 60' })

    // The daily run adds nothing on top of that bill.
    expect(await billDueHomeSaleInstallments(DUE)).toBe(0)
    expect((await invoiceFor(s.leaseId)).total).toBe(660)

    // The SECOND installment's month is long past and never had a rent bill of
    // its own, so it is billed on its own bill rather than left unbilled —
    // bundling is a preference, never a reason a payment goes uncharged.
    const own = await db.query<any>(
      `SELECT i.due_date::text AS due_date, i.total_amount::float AS total, p.notes
         FROM invoices i JOIN payments p ON p.invoice_id = i.id
        WHERE i.home_sale_contract_id = $1 ORDER BY i.due_date`, [contractId])
    expect(own.rows).toEqual([
      { due_date: '2026-04-01', total: 200, notes: 'Home payment 2 of 60' },
    ])
  })

  it('waits for the rent bill rather than beating it to its own bill', async () => {
    // The daily run is at 04:20 and the bills are written at 07:00 local, so a
    // fallback here would take a bill of its own every month and the setting
    // would never hold.
    const s = await stack({ withTrade: false })
    const contractId = await financedHome(s)
    await bundle(s.unitId)

    expect(await billDueHomeSaleInstallments(DUE)).toBe(0)
    expect((await db.query(`SELECT 1 FROM payments WHERE type='home_payment'`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM invoices WHERE home_sale_contract_id=$1`, [contractId])).rows).toHaveLength(0)

    // The bill arrives; now it has somewhere to go.
    await generateInvoices(RUN_AT)
    expect((await invoiceFor(s.leaseId)).total).toBe(660)
  })

  it('still gets its own bill when the month passed with no rent bill to ride', async () => {
    // A work-trade month, a lease that ended — nothing to bundle into. The
    // installment is billed anyway rather than left unbilled for good.
    const s = await stack({ withTrade: false })
    const contractId = await financedHome(s)
    await bundle(s.unitId)
    // Asked for from the following month: the month is over, so the fallback applies.
    const nextMonth = (await db.query<{ m: string }>(
      `SELECT ($1::date + INTERVAL '1 month')::date::text AS m`, [DUE])).rows[0].m
    expect(await billDueHomeSaleInstallments(nextMonth)).toBeGreaterThanOrEqual(1)
    const own = await db.query<any>(
      `SELECT i.due_date::text AS due_date, i.total_amount::float AS total
         FROM invoices i WHERE i.home_sale_contract_id = $1 ORDER BY i.due_date`, [contractId])
    expect(own.rows[0]).toMatchObject({ due_date: DUE, total: 200 })
  })
})

describe('the home payment is its own bill, never the rent invoice', () => {
  /** The contract's own bill(s) and their lines. */
  const ownBills = (contractId: string) => db.query<any>(
    `SELECT i.due_date::text AS due_date, i.total_amount::float AS total,
            i.subtotal_home_payments::float AS home, i.lease_id, i.late_fee_exempt,
            p.amount::float AS amount, p.status, p.notes
       FROM invoices i
       JOIN payments p ON p.invoice_id = i.id
      WHERE i.home_sale_contract_id = $1
      ORDER BY i.due_date`, [contractId]).then(r => r.rows)

  it('is on no rent invoice, and in none of its totals', async () => {
    const s = await stack({ withTrade: false })
    const contractId = await financedHome(s)
    await generateInvoices(RUN_AT)

    const inv = await invoiceFor(s.leaseId)
    expect(inv.subtotal_home_payments).toBe(0)
    expect(inv.total).toBe(460)                  // the rent alone
    const rows = await rowsOf(inv.id)
    expect(rows.some((r: any) => r.type === 'home_payment')).toBe(false)

    // The 4:20 job is what bills it, onto the contract's own bill.
    expect(await billDueHomeSaleInstallments(DUE)).toBe(1)
    expect(await ownBills(contractId)).toEqual([
      { due_date: DUE, total: 200, home: 200, lease_id: null, late_fee_exempt: true,
        amount: 200, status: 'pending', notes: 'Home payment 1 of 60' },
    ])

    // Installment 1 is stamped with its payment; installment 2 waits its turn.
    const { rows: inst } = await db.query<any>(
      `SELECT installment_number AS n, payment_id FROM home_sale_installments WHERE contract_id=$1 ORDER BY 1`, [contractId])
    expect(inst[0].payment_id).not.toBeNull()
    expect(inst[1].payment_id).toBeNull()
    const { rows: [contract] } = await db.query<any>(
      `SELECT installments_billed FROM home_sale_contracts WHERE id=$1`, [contractId])
    expect(contract.installments_billed).toBe(1)

    // Run again: billed once, one bill, no second line.
    expect(await billDueHomeSaleInstallments(DUE)).toBe(0)
    expect(await ownBills(contractId)).toHaveLength(1)
  })

  it('bills a leased buyer and a buyer with no lease exactly the same way', async () => {
    const leased = await stack({ withTrade: false })
    const leasedContract = await financedHome(leased)

    // A buyer with no lease on the space: the investor's case.
    const c = await db.connect()
    let noLease: { unitId: string; tenantId: string; landlordId: string }
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      await c.query('COMMIT')
      noLease = { unitId, tenantId, landlordId: ll.landlordId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const noLeaseContract = await financedHome(noLease!)

    // 10/25: BOTH. This used to bill only the buyer with no lease, leaving the
    // leased one to the rent bill — and a buyer who was on the lease but not
    // its primary was skipped by both sides and never billed at all.
    expect(await billDueHomeSaleInstallments(DUE)).toBe(2)
    const { rows } = await db.query<any>(
      `SELECT p.tenant_id, i.home_sale_contract_id IS NOT NULL AS own_bill
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.type='home_payment' ORDER BY p.tenant_id`)
    expect(rows).toHaveLength(2)
    expect(rows.every((r: any) => r.own_bill)).toBe(true)
    expect(rows.map((r: any) => r.tenant_id).sort())
      .toEqual([leased.tenantId, noLease!.tenantId].sort())

    // ...and the rent invoice carries the rent alone.
    await generateInvoices(RUN_AT)
    const inv = await invoiceFor(leased.leaseId)
    expect(inv.total).toBe(460)
    expect(await ownBills(leasedContract)).toHaveLength(1)
    expect(await ownBills(noLeaseContract)).toHaveLength(1)
  })

  it('a work-trade resident buying their home still owes the home payment', async () => {
    // Lisa Scheeler's case. The trade covers what it can of living there; the
    // home is not a cost of living there, and hours worked do not buy a
    // trailer — so the home payment is owed in full, on a bill of its own.
    const s = await stack({ waterBill: 40 })
    const contractId = await financedHome(s)
    await generateInvoices(RUN_AT)
    const inv = await invoiceFor(s.leaseId)
    expect(inv.total).toBe(0)                    // rent + water suspended, nothing else on it
    expect(await rowsOf(inv.id).then(r => r.some((x: any) => x.type === 'home_payment'))).toBe(false)

    expect(await billDueHomeSaleInstallments(DUE)).toBe(1)
    const own = await ownBills(contractId)
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({ total: 200, amount: 200, status: 'pending' })
    // The trade never reaches it: not suspended, owed at face value.
    const { rows: [line] } = await db.query<any>(
      `SELECT work_trade_suspended_at FROM payments WHERE type='home_payment'`)
    expect(line.work_trade_suspended_at).toBeNull()
  })
})
