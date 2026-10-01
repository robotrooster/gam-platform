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

describe('S654 the home payment rides the rent invoice', () => {
  it('this month\'s installment is a line on the invoice, counted in the total', async () => {
    const s = await stack({ withTrade: false })
    const contractId = await financedHome(s)
    await generateInvoices(RUN_AT)

    const inv = await invoiceFor(s.leaseId)
    expect(inv.subtotal_home_payments).toBe(200)
    expect(inv.total).toBe(660)                  // $460 rent + $200 home payment

    const rows = await rowsOf(inv.id)
    const home = rows.find((r: any) => r.type === 'home_payment')
    expect(home.amount).toBe(200)
    expect(home.status).toBe('pending')
    expect(home.notes).toBe('Home payment 1 of 60')

    // Installment 1 is stamped with its payment; installment 2 waits its turn.
    const { rows: inst } = await db.query<any>(
      `SELECT installment_number AS n, payment_id FROM home_sale_installments WHERE contract_id=$1 ORDER BY 1`, [contractId])
    expect(inst[0].payment_id).not.toBeNull()
    expect(inst[1].payment_id).toBeNull()
    const { rows: [contract] } = await db.query<any>(
      `SELECT installments_billed FROM home_sale_contracts WHERE id=$1`, [contractId])
    expect(contract.installments_billed).toBe(1)

    // The 4:20 job has nothing left to bill for this buyer — and would not
    // have billed it standalone even if it had run first.
    expect(await billDueHomeSaleInstallments(DUE)).toBe(0)
    const { rows: standalone } = await db.query(
      `SELECT 1 FROM payments WHERE type='home_payment' AND invoice_id IS NULL AND tenant_id=$1`, [s.tenantId])
    expect(standalone).toHaveLength(0)
  })

  it('the 4:20 job leaves a leased buyer to the invoice, and still bills a buyer with no lease', async () => {
    const leased = await stack({ withTrade: false })
    await financedHome(leased)

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
    await financedHome(noLease!)

    expect(await billDueHomeSaleInstallments(DUE)).toBe(1)
    const { rows } = await db.query<any>(
      `SELECT tenant_id, invoice_id FROM payments WHERE type='home_payment'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].tenant_id).toBe(noLease!.tenantId)
    expect(rows[0].invoice_id).toBeNull()

    // ...and the leased buyer's installment arrives on the invoice as before.
    await generateInvoices(RUN_AT)
    const inv = await invoiceFor(leased.leaseId)
    expect(inv.total).toBe(660)
  })

  it('a work-trade resident buying their home still owes the home payment', async () => {
    const s = await stack({ waterBill: 40 })   // trade covers everything it can
    await financedHome(s)
    await generateInvoices(RUN_AT)
    const inv = await invoiceFor(s.leaseId)
    expect(inv.total).toBe(200)                  // rent + water suspended; the home is not a cost of living there
    const rows = await rowsOf(inv.id)
    const home = rows.find((r: any) => r.type === 'home_payment')
    expect(home.suspended).toBe(false)
  })
})
