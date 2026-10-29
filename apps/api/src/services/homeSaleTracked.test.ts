/**
 * 10/25 (Nic), on Dominic Gonzalez's contract:
 *
 *   "For now, with Dominic, we are going to send reminders about that contract
 *    payment being due. But it is not going to go billed through the property.
 *    It's not going to get invoiced through the property. It's just going to be
 *    a ledger that keeps track and when that payment comes in, we will mark
 *    that it was paid, but it stays off the books."
 *
 * His installment is the TRUST's money, not the park's. So a contract can be
 * TRACKED instead of billed: no invoice, no charge, no money through GAM — a
 * schedule, a reminder when a payment comes due, and a mark when it arrives.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import {
  createHomeSaleContract, billDueHomeSaleInstallments,
  remindTrackedHomePayments, markTrackedInstallmentPaid,
} from './homeSale'

const MONTH = '2026-03-01'

beforeEach(async () => {
  await cleanupAllSchema()
})

/**
 * The reminder's record. Whether Resend is handed it is services/notifications'
 * job and has its own tests; what this feature promises is the notice, its
 * wording, and that it is written once per installment.
 */
const notices = () => query<any>(
  `SELECT type, title, body FROM notifications WHERE type = 'home_payment_due' ORDER BY created_at`)

async function trackedSale(opts: { tracked?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 450 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(`UPDATE properties SET first_billing_cycle = $2 WHERE id = $1`, [propertyId, MONTH])
    const k = await createHomeSaleContract(c, {
      unitId, leaseId, tenantId, landlordId: ll.landlordId,
      salePrice: 3744.08, downPayment: 0, annualInterestRate: 0,
      termMonths: 12, startMonth: MONTH, planType: 'flat',
    })
    if (opts.tracked !== false) {
      await c.query(`UPDATE home_sale_contracts SET tracked_not_billed = TRUE WHERE id = $1`, [k.id])
    }
    await c.query('COMMIT')
    return { ...ll, propertyId, unitId, tenantId, leaseId, contractId: k.id as string }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const charges = () => query<any>(`SELECT 1 FROM payments WHERE type = 'home_payment'`)
const bills = (contractId: string) => query<any>(
  `SELECT 1 FROM invoices WHERE home_sale_contract_id = $1`, [contractId])
const schedule = (contractId: string) => query<any>(
  `SELECT installment_number AS n, settled_off_platform_at IS NOT NULL AS settled,
          reminded_at IS NOT NULL AS reminded, payment_id
     FROM home_sale_installments WHERE contract_id = $1 ORDER BY installment_number`, [contractId])

describe('a contract GAM tracks but does not bill', () => {
  it('bills nothing: no invoice, no charge, no money through GAM', async () => {
    const s = await trackedSale()
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(0)
    expect(await charges()).toHaveLength(0)
    expect(await bills(s.contractId)).toHaveLength(0)
    // And nothing of it is on the buyer's rent bill either.
    expect(await query<any>(
      `SELECT 1 FROM invoices WHERE lease_id = $1 AND subtotal_home_payments > 0`, [s.leaseId])).toHaveLength(0)
  })

  it('reminds the buyer once per payment, saying there is nothing to pay here', async () => {
    const s = await trackedSale()
    expect(await remindTrackedHomePayments(MONTH)).toBe(1)
    const all = await notices()
    expect(all).toHaveLength(1)
    const notice = all[0]
    expect(notice.title).toContain('$312.01')
    // The point of the wording: there is no bill and no Pay Now behind this.
    expect(notice.body).toContain('collects this one directly')
    expect(notice.body).toContain('nothing to pay here')

    // Once, not once a night.
    expect(await remindTrackedHomePayments(MONTH)).toBe(0)
    expect(await notices()).toHaveLength(1)
    expect((await schedule(s.contractId))[0]).toMatchObject({ n: 1, reminded: true, settled: false })
  })

  it('never reminds about a month that has not come due', async () => {
    const s = await trackedSale()
    // Asked for the month BEFORE the first installment.
    expect(await remindTrackedHomePayments('2026-02-01')).toBe(0)
    expect(await notices()).toHaveLength(0)
    expect((await schedule(s.contractId)).every((r: any) => !r.reminded)).toBe(true)
  })

  it('records the payment when it arrives, and keeps it off the books', async () => {
    const s = await trackedSale()
    await markTrackedInstallmentPaid(s.contractId, 1, true)

    const rows = await schedule(s.contractId)
    expect(rows[0]).toMatchObject({ n: 1, settled: true, payment_id: null })
    // Counted as paid for payoff, with no charge and no invoice anywhere.
    // reconcileHomeSaleContract has always counted a settled-off-platform
    // installment as "billed" too — it means dealt with, and that is what makes
    // payoff and handing the home over work without GAM ever billing it.
    expect(await queryOne<any>(
      `SELECT installments_paid, installments_billed FROM home_sale_contracts WHERE id = $1`, [s.contractId]))
      .toMatchObject({ installments_paid: 1, installments_billed: 1 })
    expect(await charges()).toHaveLength(0)
    expect(await bills(s.contractId)).toHaveLength(0)

    // And it can be taken back if it was marked in error.
    await markTrackedInstallmentPaid(s.contractId, 1, false)
    expect((await schedule(s.contractId))[0]).toMatchObject({ n: 1, settled: false })
  })

  it('refuses to mark a payment on a contract GAM does bill', async () => {
    const s = await trackedSale({ tracked: false })
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    await expect(markTrackedInstallmentPaid(s.contractId, 1, true))
      .rejects.toThrow(/not one this contract tracks off the books/)
  })

  it('a contract GAM does bill is never reminded — its bill is the notice', async () => {
    const s = await trackedSale({ tracked: false })
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    expect(await remindTrackedHomePayments(MONTH)).toBe(0)
    expect(await notices()).toHaveLength(0)
  })
})

/**
 * 10/25 (Nic): "Is that going to appear on the front desk person's list as
 * like, hey, collect this money?" → yes — "collect-only, can't be rung up."
 *
 * Dominic pays at the counter, so a desk that is never told cannot collect. But
 * the money is the trust's, so nothing of it may become a GAM payment. Both
 * halves are tested here: the line is on the list, AND there is nothing behind
 * it for the register, the reader or Record payment to act on.
 */
describe('a tracked payment on the front desk list', () => {
  const deskList = async (landlordId: string) => {
    const { listOpenTenantBalances } = await import('./openBalances')
    return listOpenTenantBalances({ landlordIds: [landlordId] })
  }

  it('is nowhere in the money GAM is owed — no charge, no invoice, no balance', async () => {
    const s = await trackedSale()
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(0)
    // The ordinary owed-money list is built from charge rows; there are none.
    expect(await deskList(s.landlordId)).toHaveLength(0)
    expect(await charges()).toHaveLength(0)
    expect(await bills(s.contractId)).toHaveLength(0)
  })

  it('cannot be rung up: no bank-payable, desk-payable or card-payable row exists', async () => {
    const s = await trackedSale()
    const { bankPayableRowSql, deskPayableRowSql, payableRowSql } = await import('./moneyPredicates')
    for (const [name, sql] of [
      ['bank deposit match', bankPayableRowSql('p')],
      ['front desk', deskPayableRowSql('p')],
      ['anything payable', payableRowSql('p')],
    ] as const) {
      const rows = await query<any>(
        `SELECT p.id FROM payments p
           JOIN home_sale_installments i ON i.id = p.home_sale_installment_id
           JOIN home_sale_contracts c ON c.id = i.contract_id
          WHERE c.id = $1 AND ${sql}`, [s.contractId])
      expect(rows, name).toHaveLength(0)
    }
  })

  it('the reminder and the ledger are the only record, and marking it moves no money', async () => {
    const s = await trackedSale()
    expect(await remindTrackedHomePayments(MONTH)).toBe(1)
    await markTrackedInstallmentPaid(s.contractId, 1, true)
    // Marked, and still not a payment anywhere.
    expect(await charges()).toHaveLength(0)
    expect(await query<any>(`SELECT 1 FROM tenant_remittances`)).toHaveLength(0)
    expect(await deskList(s.landlordId)).toHaveLength(0)
  })
})
