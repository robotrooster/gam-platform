/**
 * S517 / Walkthrough Landlord #29 — work-trade percent-of-invoice credit.
 *
 * Pure math (workTradeFraction + distributeWorkTradeCredit) plus the
 * integration through generateInvoices: verified prior-month hours buy a
 * percent of the monthly invoice total against the property's hours target,
 * applied rent-first, with the invoice keeping gross subtotals.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant, seedLeaseFee,
} from '../test/dbHelpers'
import { generateInvoices } from '../jobs/invoiceGeneration'
import { workTradeFraction, distributeWorkTradeCredit } from './workTradeCredit'

beforeEach(async () => {
  await cleanupAllSchema()
})

// ── PURE MATH ────────────────────────────────────────────────

describe('workTradeFraction', () => {
  it('proportional below target', () => {
    expect(workTradeFraction(40, 80)).toBe(0.5)
    expect(workTradeFraction(20, 80)).toBe(0.25)
  })
  it('caps at 1.0 (a trade, not paid labor)', () => {
    expect(workTradeFraction(80, 80)).toBe(1)
    expect(workTradeFraction(160, 80)).toBe(1)
  })
  it('zero hours or bad target → 0', () => {
    expect(workTradeFraction(0, 80)).toBe(0)
    expect(workTradeFraction(40, 0)).toBe(0)
  })
})

describe('distributeWorkTradeCredit', () => {
  it('rent-only: credit comes off rent', () => {
    const d = distributeWorkTradeCredit(1000, [], [], 500)
    expect(d.rentNet).toBe(500)
    expect(d.creditApplied).toBe(500)
  })
  it('credit ≤ rent leaves utilities + fees untouched (rent-first priority)', () => {
    const d = distributeWorkTradeCredit(1000, [200], [100], 650)
    expect(d.rentNet).toBe(350)
    expect(d.utilityNets).toEqual([200])
    expect(d.feeNets).toEqual([100])
    expect(d.creditApplied).toBe(650)
  })
  it('credit > rent spills into utilities then fees', () => {
    const d = distributeWorkTradeCredit(1000, [200], [100], 1100)
    expect(d.rentNet).toBe(0)
    expect(d.utilityNets).toEqual([100])
    expect(d.feeNets).toEqual([100])
    expect(d.creditApplied).toBe(1100)
  })
  it('100% credit zeroes everything', () => {
    const d = distributeWorkTradeCredit(1000, [200], [100], 1300)
    expect(d.rentNet).toBe(0)
    expect(d.utilityNets).toEqual([0])
    expect(d.feeNets).toEqual([0])
    expect(d.creditApplied).toBe(1300)
  })
})

// ── INTEGRATION through generateInvoices ─────────────────────

// Builds an active lease whose property + work-trade agreement are set up so
// that running generateInvoices for 2026-05-05 produces the 2026-05-01
// invoice, crediting APPROVED hours logged in April 2026 (the prior month).
async function seedWorkTradeStack(opts: {
  rentAmount?: number
  target?: number
  approvedHours?: number
  pendingHours?: number
  hoursMonth?: string          // 'YYYY-MM', defaults to prior month 2026-04
  agreement?: boolean          // false → no agreement at all
  monthlyFees?: Array<{ type: string; amount: number }>
}): Promise<{ landlordId: string; tenantId: string; unitId: string; leaseId: string; agreementId: string | null }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    if (opts.target !== undefined) {
      await client.query('UPDATE properties SET work_trade_hours_target=$1 WHERE id=$2', [opts.target, propertyId])
    }
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: opts.rentAmount ?? 1000 })
    const leaseId = await seedLease(client, {
      unitId, landlordId, rentAmount: opts.rentAmount ?? 1000, status: 'active', startDate: '2026-04-01',
    })
    await client.query('UPDATE leases SET rent_due_day=1 WHERE id=$1', [leaseId])
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    for (const f of opts.monthlyFees ?? []) {
      await seedLeaseFee(client, { leaseId, feeType: f.type, amount: f.amount, dueTiming: 'monthly_ongoing' })
    }

    let agreementId: string | null = null
    if (opts.agreement !== false) {
      const a = await client.query<{ id: string }>(
        `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date)
         VALUES ($1,$2,$3,'2026-01-01') RETURNING id`,
        [unitId, tenantId, landlordId])
      agreementId = a.rows[0].id
      const month = opts.hoursMonth ?? '2026-04'
      if (opts.approvedHours) {
        await client.query(
          `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
           VALUES ($1,$2,$3,$4,$5,'grounds','approved')`,
          [agreementId, tenantId, userId, `${month}-10`, opts.approvedHours])
      }
      if (opts.pendingHours) {
        await client.query(
          `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
           VALUES ($1,$2,$3,$4,$5,'grounds','pending')`,
          [agreementId, tenantId, userId, `${month}-12`, opts.pendingHours])
      }
    }
    await client.query('COMMIT')
    return { landlordId, tenantId, unitId, leaseId, agreementId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const NOW = new Date('2026-05-05T12:00:00Z')

async function invoiceFor(leaseId: string) {
  const inv = await db.query<any>('SELECT * FROM invoices WHERE lease_id=$1', [leaseId])
  expect(inv.rows).toHaveLength(1)
  const pays = await db.query<any>('SELECT type, amount, status, notes FROM payments WHERE invoice_id=$1', [inv.rows[0].id])
  return { invoice: inv.rows[0], payments: pays.rows }
}

// S624 — THE CREDIT MOVED OUT OF INVOICE GENERATION.
//
// It used to be applied here, from the PREVIOUS month's approved hours. Nic
// (S623): "when you're working, those hours should be covering the month that
// you're gonna be staying... people aren't gonna pay the first month and then
// work." Rent is paid forward, so a month is paid for by work done DURING it —
// which cannot be known on the 1st. Generation now issues the invoice GROSS and
// OPENS a settlement period; jobs/workTradeSettlement.ts credits it at month
// close. These tests were rewritten rather than deleted: the old expectations
// describe behaviour that was wrong for the reason above, and the new ones pin
// what replaced it.
describe('generateInvoices — opens a work-trade period, credits nothing', () => {
  const periodOf = async (agreementId: string | null) => (await db.query<any>(
    `SELECT target_hours::float AS target, hour_rate::float AS rate,
            basis_amount::float AS basis, hours_applied::float AS applied, status
       FROM work_trade_settlements WHERE agreement_id=$1`, [agreementId])).rows

  it('issues the invoice GROSS even when the tenant worked last month', async () => {
    const s = await seedWorkTradeStack({ rentAmount: 1000, approvedHours: 40 })
    await generateInvoices(NOW)
    const { invoice, payments } = await invoiceFor(s.leaseId)
    expect(invoice.subtotal_rent).toBe('1000.00')
    // Last month's hours buy nothing here any more — they belonged to last month.
    expect(invoice.work_trade_credit_amount).toBe('0.00')
    expect(invoice.total_amount).toBe('1000.00')
    // Still stamped with the agreement, which is what makes it late-fee exempt
    // while the tenant works the month off (S623).
    expect(invoice.work_trade_agreement_id).toBe(s.agreementId)
    expect(invoice.late_fee_exempt).toBe(true)
    const rent = payments.find(p => p.type === 'rent')
    expect(rent.amount).toBe('1000.00')
    expect(rent.status).toBe('pending')
  })

  it('opens one period priced from the covered basis', async () => {
    const s = await seedWorkTradeStack({ rentAmount: 1000, approvedHours: 40 })
    await generateInvoices(NOW)
    const [period] = await periodOf(s.agreementId)
    expect(period).toBeTruthy()
    expect(period.target).toBe(80)
    expect(period.basis).toBe(1000)
    expect(period.rate).toBe(12.5)      // $1000 ÷ 80 hours
    expect(period.applied).toBe(0)
    expect(period.status).toBe('open')
  })

  it('prices the hour off the WHOLE covered bill, not the rent alone', async () => {
    // Nic (S624): work trade "detects all charges according to the lease... it
    // gives a percentage of the utilities as well as whatever the rent is."
    const s = await seedWorkTradeStack({
      rentAmount: 1000, approvedHours: 40, monthlyFees: [{ type: 'pet_rent', amount: 200 }],
    })
    await generateInvoices(NOW)
    const { invoice, payments } = await invoiceFor(s.leaseId)
    expect(invoice.total_amount).toBe('1200.00')          // gross, nothing credited
    expect(payments.find(p => p.type === 'rent').amount).toBe('1000.00')
    expect(payments.find(p => p.type === 'fee').amount).toBe('200.00')
    const [period] = await periodOf(s.agreementId)
    expect(period.basis).toBe(1200)                        // rent + the fee
    expect(period.rate).toBe(15)                           // $1200 ÷ 80
  })

  it('only APPROVED hours count — pending hours give no credit', async () => {
    const s = await seedWorkTradeStack({ rentAmount: 1000, pendingHours: 60 })
    await generateInvoices(NOW)
    const { invoice } = await invoiceFor(s.leaseId)
    expect(invoice.work_trade_credit_amount).toBe('0.00')
    expect(invoice.total_amount).toBe('1000.00')
  })

  it('hours logged in the invoice’s OWN month still credit nothing here', async () => {
    // Under the old model this was the "wrong month". Under the new one it is
    // the RIGHT month — and it still credits nothing at generation, because the
    // month is not over. It settles at close, which is the whole point.
    const s = await seedWorkTradeStack({ rentAmount: 1000, approvedHours: 80, hoursMonth: '2026-05' })
    await generateInvoices(NOW)
    const { invoice } = await invoiceFor(s.leaseId)
    expect(invoice.work_trade_credit_amount).toBe('0.00')
    expect(invoice.total_amount).toBe('1000.00')
  })

  it('no agreement → no period opened, and no late-fee exemption', async () => {
    const s = await seedWorkTradeStack({ rentAmount: 1000, agreement: false })
    await generateInvoices(NOW)
    const { invoice } = await invoiceFor(s.leaseId)
    expect(invoice.work_trade_credit_amount).toBe('0.00')
    expect(invoice.work_trade_agreement_id).toBeNull()
    expect(invoice.total_amount).toBe('1000.00')
    expect(invoice.late_fee_exempt).toBe(false)
    const periods = await db.query(`SELECT 1 FROM work_trade_settlements`)
    expect(periods.rowCount).toBe(0)
  })
})

/**
 * S609 (Nic): PROPANE IS WORK-TRADE CREDITABLE.
 *
 * "We need to find a way to include propane in there too, because at a different
 * property I own we do dispense propane, and we give our seasonal help free
 * propane in the winter. We don't actually invoice them anything. I just need a
 * way to track it — what's being given out, the total value of what's been
 * given, for what work has been done."
 *
 * It was excluded as a "fixed contractual split amount", so a full trade month
 * still left a propane bill. Running it through the credit records the value
 * given AND the work done on the same invoice, instead of the arrangement living
 * in someone's head.
 */
describe('S609 propane in the work-trade credit', () => {
  it('a full month covers propane along with everything else', () => {
    // $500 rent + $80 utilities + $20 fee + $300 propane = $900 owed.
    const credit = workTradeFraction(80, 80) * 900   // full target month
    const d = distributeWorkTradeCredit(500, [80], [20], credit, [300])
    expect(d.rentNet).toBe(0)
    expect(d.utilityNets).toEqual([0])
    expect(d.feeNets).toEqual([0])
    expect(d.propaneNets).toEqual([0])
    expect(d.creditApplied).toBeCloseTo(900, 2)
  })

  it('propane is taken LAST — a half month covers living costs first', () => {
    // Half of $900 is $450: rent takes it all, nothing reaches propane.
    const credit = workTradeFraction(40, 80) * 900
    const d = distributeWorkTradeCredit(500, [80], [20], credit, [300])
    expect(d.rentNet).toBeCloseTo(50, 2)     // 500 − 450
    expect(d.utilityNets).toEqual([80])
    expect(d.propaneNets).toEqual([300])     // untouched
  })

  it('the credit spills into propane once everything else is covered', () => {
    // $700 of credit clears rent+utilities+fees ($600) with $100 left.
    const d = distributeWorkTradeCredit(500, [80], [20], 700, [300])
    expect(d.rentNet).toBe(0)
    expect(d.utilityNets).toEqual([0])
    expect(d.feeNets).toEqual([0])
    expect(d.propaneNets).toEqual([200])     // 300 − 100
    expect(d.creditApplied).toBeCloseTo(700, 2)
  })

  it('several fills are covered in order', () => {
    const d = distributeWorkTradeCredit(0, [], [], 250, [100, 100, 100])
    expect(d.propaneNets).toEqual([0, 0, 50])
  })

  it('no propane behaves exactly as before', () => {
    const d = distributeWorkTradeCredit(500, [80], [20], 600)
    expect(d.propaneNets).toEqual([])
    expect(d.rentNet).toBe(0)
    expect(d.creditApplied).toBeCloseTo(600, 2)
  })

  it('credit never exceeds what is owed', () => {
    const d = distributeWorkTradeCredit(100, [], [], 999, [50])
    expect(d.creditApplied).toBeCloseTo(150, 2)
    expect(d.rentNet).toBe(0)
    expect(d.propaneNets).toEqual([0])
  })
})

// S613 (Nic): an agreement covers only what it says it covers.
//
//   "It would be like they did fifty percent of the work for the rent and the
//    electric, and it bills them fifty percent of the electric, but propane is
//    excluded — so they get a hundred percent of the propane bill."
describe('covered charges (S613)', () => {
  it('an excluded row is billed in FULL and takes no credit', () => {
    // 50% of a $1,000 rent + $200 electric basis = $600 of credit.
    const dist = distributeWorkTradeCredit(
      1000, [200], [], 600, [300],
      { rent: true, utilities: [true], fees: [], propane: false },
    )
    expect(dist.rentNet).toBe(400)        // $600 credit lands on rent first
    expect(dist.utilityNets[0]).toBe(200) // nothing left over for electric here
    expect(dist.propaneNets[0]).toBe(300) // propane untouched — the whole bill
    expect(dist.creditApplied).toBe(600)
  })

  it('credit spills into a covered utility but never into an excluded one', () => {
    // A near-full month: $1,150 of credit against rent $1,000 + electric $200.
    const dist = distributeWorkTradeCredit(
      1000, [200, 150], [], 1150, [300],
      // electric covered, water NOT
      { rent: true, utilities: [true, false], fees: [], propane: false },
    )
    expect(dist.rentNet).toBe(0)
    expect(dist.utilityNets[0]).toBe(50)   // electric took the remaining $150
    expect(dist.utilityNets[1]).toBe(150)  // water untouched
    expect(dist.propaneNets[0]).toBe(300)  // propane untouched
  })

  it('omitting the map covers everything — the pre-S613 deal is unchanged', () => {
    const withMap = distributeWorkTradeCredit(1000, [200], [50], 1250, [100],
      { rent: true, utilities: [true], fees: [true], propane: true })
    const without = distributeWorkTradeCredit(1000, [200], [50], 1250, [100])
    expect(without).toEqual(withMap)
    expect(without.rentNet).toBe(0)
    expect(without.utilityNets[0]).toBe(0)
    expect(without.feeNets[0]).toBe(0)
    expect(without.propaneNets[0]).toBe(100)  // credit ran out before propane
  })

  it('a fully-excluded agreement credits nothing at all', () => {
    const dist = distributeWorkTradeCredit(
      1000, [200], [], 0, [300],
      { rent: false, utilities: [false], fees: [], propane: false },
    )
    expect(dist.rentNet).toBe(1000)
    expect(dist.utilityNets[0]).toBe(200)
    expect(dist.propaneNets[0]).toBe(300)
    expect(dist.creditApplied).toBe(0)
  })
})
