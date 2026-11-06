/**
 * 11/1 — ENDING A TENANCY TAKES BACK WHAT WAS BILLED PAST IT.
 *
 * The case this is built from, exactly as it happened. Mountain View RV 20's
 * resident had been gone about a month and the front desk never checked him
 * out. At 7am on the 1st the bill run saw an active lease with no end date and
 * billed him the month: $589 rent and $18.48 of electric. The owner ended the
 * tenancy from the register at 09:40 and the bill stayed standing at $607.48.
 *
 * Nic: "Have it pull the bill when it's if we forgot to check somebody out."
 *
 * The line these tests hold, and it is the one that matters more than the
 * pull-back itself: a row due BEFORE the day they left is still owed. This
 * never forgives arrears. A resident who leaves on the 20th owes that month.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { pullBackChargesPastLeaseEnd } from './leaseEndPullBack'

/**
 * The pull-back takes the household lock, which only holds inside a
 * transaction — the function refuses to run without one, deliberately. So the
 * fixtures are committed (the assertions read through the pool) and only the
 * call itself is wrapped.
 */
async function runPullBack(c: PoolClient, leaseId: string) {
  await c.query('BEGIN')
  try {
    const out = await pullBackChargesPastLeaseEnd(c, { leaseId })
    await c.query('COMMIT')
    return out
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
}

/** A tenancy with a bill on it, and the day they actually left. */
async function tenancy(c: PoolClient, opts: {
  endsOn: string | null
  /** due date -> what is on that bill */
  bills: Array<{ due: string; rent?: number; fee?: number; utility?: number; homePayment?: number; settled?: boolean }>
}) {
  const { userId, landlordId } = await seedLandlord(c)
  const tenantId = await seedTenant(c)
  const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
  const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 589 })
  const leaseId = await seedLease(c, {
    unitId, landlordId, rentAmount: 589, leaseType: 'month_to_month',
    status: 'active', startDate: '2026-09-07',
  })
  await seedLeaseTenant(c, { leaseId, tenantId })
  if (opts.endsOn) {
    // terminated_at is stamped ON the leaving day, not today: the service reads
    // the EARLIER of the end date and the day the tenancy was actually killed,
    // which is right (terminate early and the termination wins) and makes a
    // fixture that ends on the 20th but was killed on the 1st mean "the 1st".
    await c.query(
      `UPDATE leases SET end_date = $2::date, status = 'expired',
              terminated_at = ($2::date + TIME '12:00') AT TIME ZONE 'America/Phoenix'
        WHERE id = $1`,
      [leaseId, opts.endsOn])
  }
  const made: Array<{ invoiceId: string; due: string }> = []
  for (const b of opts.bills) {
    const invoiceId = (await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
         subtotal_rent, subtotal_fees, subtotal_utilities, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'pending') RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, `INV-T-${b.due}-${Math.random().toString(36).slice(2, 8)}`,
       b.due, (b.rent ?? 0).toFixed(2), (b.fee ?? 0).toFixed(2), (b.utility ?? 0).toFixed(2),
       ((b.rent ?? 0) + (b.fee ?? 0) + (b.utility ?? 0)).toFixed(2)])).rows[0].id
    const line = async (type: string, amount: number, desc: string) =>
      c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
           due_date, invoice_id, entry_description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10)`,
        [unitId, leaseId, tenantId, landlordId, type, amount.toFixed(2),
         b.settled ? 'settled' : 'pending', b.due, invoiceId, desc])
    if (b.rent) await line('rent', b.rent, 'RENT')
    if (b.fee) await line('fee', b.fee, 'SUBSCRIP')
    if (b.utility) await line('utility', b.utility, 'UTILITY')
    if (b.homePayment) await line('home_payment', b.homePayment, 'HOMEPMT')
    made.push({ invoiceId, due: b.due })
  }
  return { leaseId, tenantId, landlordId, unitId, bills: made }
}

const bill = async (id: string) =>
  (await db.query(`SELECT status, total_amount::text AS total, lease_id, voided_from_lease_id
                     FROM invoices WHERE id = $1`, [id])).rows[0]
const lines = async (invoiceId: string) =>
  (await db.query(`SELECT type, amount::text AS amount, status, void_reason
                     FROM payments WHERE invoice_id = $1 ORDER BY type`, [invoiceId])).rows

describe('ending a tenancy takes back what was billed for after it', () => {
  let c: PoolClient
  beforeEach(async () => {
    await cleanupAllSchema()
    if (!c) c = await getClient()
  })

  it('Tyler: gone before the month started, so the rent comes off and the bill goes void at $0', async () => {
    const t = await tenancy(c, {
      endsOn: '2026-11-01',
      bills: [{ due: '2026-11-01', rent: 589 }],
    })
    const back = await runPullBack(c, t.leaseId)
    expect(back.charges).toBe(1)
    expect(back.bills).toBe(1)
    expect(back.kept).toBe(0)
    expect(back.endsOn).toBe('2026-11-01')

    const b = await bill(t.bills[0].invoiceId)
    expect(b.status).toBe('void')
    expect(Number(b.total)).toBe(0)
    // It hands the due date back, so the space can be billed again if somebody
    // else takes it.
    expect(b.lease_id).toBeNull()
    expect(b.voided_from_lease_id).toBe(t.leaseId)
    const l = await lines(t.bills[0].invoiceId)
    expect(l[0].status).toBe('voided')
    expect(l[0].void_reason).toMatch(/after the tenancy ended/i)
  })

  it('NEVER forgives arrears: a bill due before they left is left completely alone', async () => {
    const t = await tenancy(c, {
      endsOn: '2026-11-20',
      bills: [
        { due: '2026-11-01', rent: 589 },   // theirs — they lived most of the month
        { due: '2026-12-01', rent: 589 },   // after they left — not owed
      ],
    })
    const back = await runPullBack(c, t.leaseId)
    expect(back.charges).toBe(1)

    const november = await bill(t.bills[0].invoiceId)
    expect(november.status).toBe('pending')
    expect(Number(november.total)).toBe(589)
    expect((await lines(t.bills[0].invoiceId))[0].status).toBe('pending')

    const december = await bill(t.bills[1].invoiceId)
    expect(december.status).toBe('void')
    expect(Number(december.total)).toBe(0)
  })

  it('leaves utilities alone — they bill in arrears, so a later bill can hold earlier usage', async () => {
    const t = await tenancy(c, {
      endsOn: '2026-11-01',
      bills: [{ due: '2026-11-01', rent: 589, utility: 18.48 }],
    })
    const back = await runPullBack(c, t.leaseId)
    expect(back.charges).toBe(1)          // the rent only
    expect(back.bills).toBe(0)            // something real is still on it
    expect(back.retotaled).toBe(1)

    const b = await bill(t.bills[0].invoiceId)
    expect(b.status).toBe('pending')
    // Re-totalled around the electric that is genuinely owed.
    expect(Number(b.total)).toBe(18.48)
    const l = await lines(t.bills[0].invoiceId)
    expect(l.find((x: any) => x.type === 'rent').status).toBe('voided')
    expect(l.find((x: any) => x.type === 'utility').status).toBe('pending')
  })

  it('never touches money that moved', async () => {
    const t = await tenancy(c, {
      endsOn: '2026-11-01',
      bills: [{ due: '2026-11-01', rent: 589, settled: true }],
    })
    const back = await runPullBack(c, t.leaseId)
    expect(back.charges).toBe(0)
    const b = await bill(t.bills[0].invoiceId)
    // The bill rolls up to settled because its only line is paid — the point is
    // that the pull-back did not touch it, not what the rollup calls it.
    expect(b.status).toBe('settled')
    expect(b.lease_id).toBe(t.leaseId)
    expect((await lines(t.bills[0].invoiceId))[0].status).toBe('settled')
  })

  it('a tenancy still running has nothing past it', async () => {
    const t = await tenancy(c, { endsOn: null, bills: [{ due: '2026-11-01', rent: 589 }] })
    const back = await runPullBack(c, t.leaseId)
    expect(back).toMatchObject({ charges: 0, bills: 0, endsOn: null })
    expect((await bill(t.bills[0].invoiceId)).status).toBe('pending')
  })

  it('takes a late fee raised on a charge that was never owed off with it', async () => {
    const t = await tenancy(c, { endsOn: '2026-11-01', bills: [{ due: '2026-11-01', rent: 589 }] })
    await c.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
         due_date, invoice_id, entry_description)
       VALUES ($1,$2,$3,$4,'late_fee',5,'pending','2026-11-06',$5,'LATEFEE')`,
      [t.unitId, t.leaseId, t.tenantId, t.landlordId, t.bills[0].invoiceId])
    const back = await runPullBack(c, t.leaseId)
    expect(back.charges).toBe(2)
    expect((await bill(t.bills[0].invoiceId)).status).toBe('void')
  })

  it('runs twice without doing anything the second time', async () => {
    const t = await tenancy(c, { endsOn: '2026-11-01', bills: [{ due: '2026-11-01', rent: 589 }] })
    const first = await runPullBack(c, t.leaseId)
    const second = await runPullBack(c, t.leaseId)
    expect(first.charges).toBe(1)
    expect(second).toMatchObject({ charges: 0, bills: 0, retotaled: 0, kept: 0 })
  })

  /**
   * 11/1 (Nic, DIRECTIVE): A PERSON WHO HAS LEFT ACCRUES NOTHING FURTHER.
   *
   *   "When they're not living there, they're not going to pay anything else
   *    to the park. So we need to sever their ability to accrue any other
   *    charges."
   *
   * Country Acres MH 18 is the case: the resident left on 10/31, this took her
   * November rent off, and her $100 trailer installment stayed — home_payment
   * was not in the list — so November stood against somebody who had gone and
   * December's run would have written another. Taking the charge alone is not
   * enough either: the agreement behind it has to stop, or the charge returns
   * every month until a human notices.
   */
  it('a trailer payment due after they left comes off, AND the agreement stops so next month writes nothing', async () => {
    const t = await tenancy(c, {
      endsOn: '2026-10-31',
      bills: [{ due: '2026-11-01', rent: 450, homePayment: 100, utility: 19.8 }],
    })
    const contractId = (await c.query<{ id: string }>(
      `INSERT INTO home_sale_contracts (unit_id, lease_id, tenant_id, landlord_id, sale_price,
         financed_amount, term_months, monthly_payment, start_month, installments_total, status)
       VALUES ($1,$2,$3,$4, 12000, 12000, 120, 100, '2026-01-01', 120, 'active') RETURNING id`,
      [t.unitId, t.leaseId, t.tenantId, t.landlordId])).rows[0].id

    const back = await runPullBack(c, t.leaseId)

    // Rent and the trailer payment both go; the water does NOT — it bills in
    // arrears, so November's line is October's usage and she genuinely owes it.
    expect(back.charges).toBe(2)
    expect(back.contractsStopped).toBe(1)
    const rows = await lines(t.bills[0].invoiceId)
    expect(rows.find(r => r.type === 'rent')!.status).toBe('voided')
    expect(rows.find(r => r.type === 'home_payment')!.status).toBe('voided')
    expect(rows.find(r => r.type === 'utility')!.status).toBe('pending')

    // The agreement is stopped, so the monthly run has nothing to write.
    const contract = (await db.query<{ status: string }>(
      `SELECT status FROM home_sale_contracts WHERE id = $1`, [contractId])).rows[0]
    expect(contract.status).toBe('cancelled')

    // Idempotent: running it again finds nothing left and stops nothing twice.
    const again = await runPullBack(c, t.leaseId)
    expect(again.charges).toBe(0)
    expect(again.contractsStopped).toBe(0)
  })

  it("stops only the leaver's own agreement, never the next resident's on the same space", async () => {
    const t = await tenancy(c, {
      endsOn: '2026-10-31',
      bills: [{ due: '2026-11-01', rent: 450 }],
    })
    const newcomer = await seedTenant(c)
    const theirs = (await c.query<{ id: string }>(
      `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price,
         financed_amount, term_months, monthly_payment, start_month, installments_total, status)
       VALUES ($1,$2,$3, 9000, 9000, 90, 100, '2026-11-01', 90, 'active') RETURNING id`,
      [t.unitId, newcomer, t.landlordId])).rows[0].id

    const back = await runPullBack(c, t.leaseId)
    expect(back.contractsStopped).toBe(0)
    const still = (await db.query<{ status: string }>(
      `SELECT status FROM home_sale_contracts WHERE id = $1`, [theirs])).rows[0]
    expect(still.status).toBe('active')
  })

})
